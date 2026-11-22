// Android WebView cannot inject an arbitrary per-pair trust anchor into WSS.
// Terminate both HTTP and WebSocket at the same capability-protected loopback
// origin. Only the native transport ever sees the peer cookie or pairing token.
package main

import (
 "bytes"; "context"; "crypto/rand"; "crypto/sha256"; "crypto/subtle"; "crypto/tls"; "encoding/base64"; "encoding/json"; "errors"; "io"; "net"; "net/http"; "net/http/httputil"; "net/url"; "regexp"; "strconv"; "strings"; "sync"; "time"
)
type request struct { Op, ID, Pin, Code, Token, Device string; Hosts []string }
type result struct { Error, ID, Token, Origin, Key, Cookie, Host string `json:",omitempty"`; Status int `json:",omitempty"` }
type peer struct { u *url.URL; tr *http.Transport; c *http.Client }
var safeHost=regexp.MustCompile(`^[A-Za-z0-9.:-]+$`)
func newPeer(authority,pin string)(*peer,error){
 h,p,e:=net.SplitHostPort(authority);n,e2:=strconv.Atoi(p);target,e3:=base64.RawURLEncoding.DecodeString(pin)
 if e!=nil||e2!=nil||n<1||n>65535||len(h)>253||!safeHost.MatchString(h)||e3!=nil||len(target)!=32{return nil,errors.New("invalid peer")}
 tc:=&tls.Config{MinVersion:tls.VersionTLS12,InsecureSkipVerify:true, // Replaced by exact out-of-band SPKI, never system DNS trust.
 VerifyConnection:func(s tls.ConnectionState)error{if len(s.PeerCertificates)>0 { cert:=s.PeerCertificates[0];actual:=sha256.Sum256(cert.RawSubjectPublicKeyInfo);now:=time.Now();if subtle.ConstantTimeCompare(actual[:],target)==1&&!now.Before(cert.NotBefore)&&now.Before(cert.NotAfter){return nil} };return errors.New("desktop certificate mismatch")}}
 tr:=&http.Transport{TLSClientConfig:tc,DialContext:(&net.Dialer{Timeout:4*time.Second,KeepAlive:20*time.Second}).DialContext,TLSHandshakeTimeout:5*time.Second,IdleConnTimeout:75*time.Second,MaxIdleConnsPerHost:12,ResponseHeaderTimeout:10*time.Minute}
 return &peer{&url.URL{Scheme:"https",Host:authority},tr,&http.Client{Transport:tr,CheckRedirect:func(*http.Request,[]*http.Request)error{return http.ErrUseLastResponse}}},nil
}
func(p *peer) call(ctx context.Context,path,token string,body any)(*http.Response,error){m:="GET";var b io.Reader;if body!=nil{m="POST";data,_:=json.Marshal(body);b=bytes.NewReader(data)};req,e:=http.NewRequestWithContext(ctx,m,p.u.String()+path,b);if e!=nil{return nil,e};if token!=""{req.Header.Set("Authorization","Bearer "+token)};if b!=nil{req.Header.Set("Content-Type","application/json")};return p.c.Do(req)}
type packet struct{Desktop struct{ID string};Token,Fingerprint string; Protocol int}
func packetOf(r *http.Response)(packet,error){defer r.Body.Close();var x packet;e:=json.NewDecoder(io.LimitReader(r.Body,65536)).Decode(&x);return x,e}
func choose(ctx context.Context,q request)(*peer,error){if len(q.Hosts)==0||len(q.Hosts)>8{return nil,errors.New("invalid addresses")};ctx,stop:=context.WithCancel(ctx);defer stop();out:=make(chan *peer);for i,h:=range q.Hosts{go func(i int,h string){var good *peer;select{case <-ctx.Done():return;case <-time.After(time.Duration(min(i,3))*90*time.Millisecond):};p,e:=newPeer(h,q.Pin);if e==nil{r,e:=p.call(ctx,"/mobile/v1/hello","",nil);if e==nil{x,e:=packetOf(r);if e==nil&&r.StatusCode==200&&x.Desktop.ID==q.ID&&x.Fingerprint==q.Pin{good=p}};if good==nil{p.tr.CloseIdleConnections()}};select{case out<-good:case <-ctx.Done():if good!=nil{good.tr.CloseIdleConnections()}}}(i,h)};for range q.Hosts{select{case <-ctx.Done():return nil,ctx.Err();case p:=<-out:if p!=nil{return p,nil}}};return nil,errors.New("desktop unavailable or key mismatch")}
type bridge struct{mu sync.RWMutex;identity string;p *peer;local,secret,key,cookie string;srv *http.Server;stop context.CancelFunc;ctx context.Context}
var guard sync.Mutex;var active *bridge
func random()string{var b [32]byte;if _,e:=rand.Read(b[:]);e!=nil{panic(e)};return base64.RawURLEncoding.EncodeToString(b[:])}
func(b *bridge)close(){b.stop();b.srv.Close();b.p.tr.CloseIdleConnections()}
func(b *bridge)serve(w http.ResponseWriter,r *http.Request){
 b.mu.RLock();p,sessionCookie,bc:=b.p,b.cookie,b.ctx;b.mu.RUnlock()
 origin:="http://"+b.local; c,e:=r.Cookie(b.key);o:=r.Header.Get("Origin");site:=r.Header.Get("Sec-Fetch-Site");ws:=strings.EqualFold(r.Header.Get("Upgrade"),"websocket")
 if r.Host!=b.local||r.URL.IsAbs()||r.Method=="CONNECT"||e!=nil||subtle.ConstantTimeCompare([]byte(c.Value),[]byte(b.secret))!=1||(o!=""&&o!=origin)||site=="cross-site"||site=="same-site"||((ws||r.Method!="GET"&&r.Method!="HEAD")&&o!=origin){http.Error(w,"Forbidden",403);return}
 if (ws&&r.URL.Path!="/api/remote.mux")||(strings.HasPrefix(r.URL.Path,"/mobile/")&&r.URL.Path!="/mobile/v1/shell.css"&&r.URL.Path!="/mobile/v1/shell.js"&&r.URL.Path!="/mobile/v1/sync"&&r.URL.Path!="/mobile/v1/reader-worker.js"){http.NotFound(w,r);return}
 ctx,cancel:=context.WithCancel(r.Context());unhook:=context.AfterFunc(bc,cancel);defer func(){unhook();cancel()}()
 proxy:=httputil.ReverseProxy{Transport:p.tr,FlushInterval:-1,Rewrite:func(pr *httputil.ProxyRequest){pr.SetURL(p.u);pr.Out.Host=p.u.Host;pr.Out.Header.Del("Authorization");pr.Out.Header.Del("Proxy-Authorization");pr.Out.Header.Set("Cookie",sessionCookie);pr.Out.Header.Del("Referer");if o!=""{pr.Out.Header.Set("Origin",p.u.String())}},ModifyResponse:func(res *http.Response)error{res.Header.Del("Set-Cookie");res.Header.Del("Clear-Site-Data");if loc:=res.Header.Get("Location");loc!=""{u,e:=p.u.Parse(loc);if e!=nil||u.Scheme!="https"||u.Host!=p.u.Host{return errors.New("off-site redirect")};res.Header.Set("Location",u.RequestURI())};return nil},ErrorHandler:func(w http.ResponseWriter,_ *http.Request,_ error){http.Error(w,"Desktop unavailable",502)}};proxy.ServeHTTP(w,r.WithContext(ctx))
}
// Restoring an already paired client needs only one authenticated request.
// TLS verifies the out-of-band SPKI before the request body or token is sent.
// No one-time pairing code is ever raced. Losing attempts are cancelled.
type opened struct { p *peer; cookie string; status int }
func openSaved(ctx context.Context,q request)(opened,error){
 if len(q.Hosts)==0||len(q.Hosts)>8||q.Token=="" {return opened{},errors.New("invalid saved desktop")};ctx,stop:=context.WithCancel(ctx);defer stop();out:=make(chan opened)
 for i,host:=range q.Hosts {go func(i int,host string){select{case <-ctx.Done():return;case <-time.After(time.Duration(min(i,3))*40*time.Millisecond):};p,e:=newPeer(host,q.Pin);r:=opened{};if e==nil {resp,e:=p.call(ctx,"/mobile/v1/web-session",q.Token,struct{}{});if e==nil {x,e:=packetOf(resp);r.status=resp.StatusCode;if e==nil&&resp.StatusCode==200&&x.Desktop.ID==q.ID {for _,c:=range resp.Cookies(){if c.Name=="__Host-dsh-mobile"&&c.Secure&&c.HttpOnly&&c.Path=="/"&&len(c.Value)==43 {r.p=p;r.cookie=c.Name+"="+c.Value;break}}}};if r.p==nil{p.tr.CloseIdleConnections()}};select{case out<-r:case <-ctx.Done():if r.p!=nil {r.p.tr.CloseIdleConnections()}}}(i,host)}
 var status int;for range q.Hosts {select{case <-ctx.Done():return opened{status:status},ctx.Err();case r:=<-out:if r.p!=nil{return r,nil};if r.status==401||status==0{status=r.status}}};return opened{status:status},errors.New("desktop unavailable")
}

func dispatch(q request)result{guard.Lock();defer guard.Unlock();if q.Op=="close"{if active!=nil{active.close();active=nil};return result{}};if q.Op!="pair"&&q.Op!="open"{return result{Error:"invalid operation"}};ctx,done:=context.WithTimeout(context.Background(),10*time.Second);defer done();if q.Op=="pair"{p,e:=choose(ctx,q);if e!=nil{return result{Error:"无法连接或电脑证书不匹配。请确认电脑在线，且地址可达。"}};defer p.tr.CloseIdleConnections();r,e:=p.call(ctx,"/mobile/v1/pair","",map[string]any{"code":q.Code,"device":map[string]string{"id":q.Device,"name":"DSH Mobile · Android"}});if e!=nil{return result{Error:"配对请求失败，请刷新二维码后重试。"}};x,e:=packetOf(r);if r.StatusCode!=200||e!=nil||x.Desktop.ID!=q.ID||x.Token==""{return result{Error:"配对码无效或已过期，请刷新电脑上的二维码。",Status:r.StatusCode}};return result{Token:x.Token,Host:p.u.Host}}
 ready,e:=openSaved(ctx,q);if e!=nil{return result{Status:ready.status,Error:"电脑暂时不可用。"}};p,cookie:=ready.p,ready.cookie;keep:=false;defer func(){if !keep{p.tr.CloseIdleConnections()}}()
 identity:=q.ID+":"+q.Pin
 if b:=active;b!=nil&&b.identity==identity{b.mu.Lock();old,stop:=b.p,b.stop;b.p,b.cookie=p,cookie;b.ctx,b.stop=context.WithCancel(context.Background());b.mu.Unlock();stop();old.tr.CloseIdleConnections();keep=true;return result{Origin:"http://"+b.local,Key:b.key,Cookie:b.secret,Host:p.u.Host}}
 l,e:=net.Listen("tcp4","127.0.0.1:0");if e!=nil{return result{Error:"无法创建本机安全连接。"}};bc,stop:=context.WithCancel(context.Background());b:=&bridge{identity:identity,p:p,local:l.Addr().String(),secret:random(),key:"dshapp_"+random()[:12],cookie:cookie,ctx:bc,stop:stop};b.srv=&http.Server{Handler:http.HandlerFunc(b.serve),ReadHeaderTimeout:8*time.Second,MaxHeaderBytes:64<<10,IdleTimeout:80*time.Second};if active!=nil{active.close()};active=b;go b.srv.Serve(l);keep=true;return result{Origin:"http://"+b.local,Key:b.key,Cookie:b.secret,Host:p.u.Host}
}
func main(){}
