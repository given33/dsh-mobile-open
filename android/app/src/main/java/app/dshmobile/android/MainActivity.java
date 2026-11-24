package app.dshmobile.android;

import android.app.*;import android.content.*;import android.graphics.Color;import android.graphics.drawable.GradientDrawable;import android.net.*;import android.os.*;import android.view.*;import android.webkit.*;import android.widget.*;import androidx.webkit.*;import com.google.zxing.integration.android.*;import org.json.*;import java.util.*;import java.util.concurrent.*;

public final class MainActivity extends Activity {
 static final ExecutorService IO=Executors.newSingleThreadExecutor(); final Handler ui=new Handler(Looper.getMainLooper());
 Vault vault; JSONObject paired; LinearLayout root,bar,devicePill; FrameLayout body;View statusDot;TextView title,deviceChevron,status; WebView web; String origin="",selection="";boolean cold=true,busy,foreground,revoked,healthy;int generation,failures;boolean documentFailed,routeApplied; androidx.webkit.ScriptHandler boot; ConnectivityManager cm;ConnectivityManager.NetworkCallback net; Network activeNet;
 final DocumentSave saves=new DocumentSave(this); ValueCallback<Uri[]> fileCallback; final Runnable retry=()->{if(foreground&&paired!=null&&!revoked&&!busy)open(false);};final Runnable watchdog=()->{if(!healthy)recover();};
 Button panelHub, panelNew;
 GradientDrawable pillBg(int fill,int stroke){GradientDrawable d=new GradientDrawable();d.setCornerRadius(dp(999));d.setColor(fill);if(stroke!=0)d.setStroke(Math.max(1,Math.round(getResources().getDisplayMetrics().density*0.75f)),stroke);return d;}
 void updateDevicePill(){
   if(devicePill==null||statusDot==null||title==null)return;
   String name=paired==null?"DSH Mobile":paired.optString("name","DSH Mobile");
   title.setText(name);
   int dotColor;
   String stateLabel;
   if(paired==null||revoked){dotColor=0xffef4444;stateLabel="未连接";}
   else if(healthy){dotColor=0xff22c55e;stateLabel="在线";}
   else if(busy||web!=null){dotColor=0xfff59e0b;stateLabel="正在连接";}
   else{dotColor=0xffef4444;stateLabel="已断开";}
   statusDot.setBackground(pillBg(dotColor,0));
   devicePill.setContentDescription(name+"，"+stateLabel+"，点击切换或查看设备状态");
 }
 void scanQr(){new IntentIntegrator(this).setDesiredBarcodeFormats(IntentIntegrator.QR_CODE).setPrompt("扫描 DSH 桌面端的配对二维码").setBeepEnabled(false).setOrientationLocked(false).initiateScan();}
 void showDeviceMenu(View anchor){
   PopupMenu menu=new PopupMenu(this,anchor);
   Menu m=menu.getMenu();
   String name=paired==null?"未配对电脑":paired.optString("name","DSH Mobile");
   String state=paired==null?"请扫码配对":(revoked?"配对已失效":(healthy?"在线":(busy||web!=null?"正在连接…":"已断开")));
   String route=paired!=null&&paired.optJSONArray("Hosts")!=null&&paired.optJSONArray("Hosts").length()>0?(" · "+paired.optJSONArray("Hosts").optString(0,"")):"";
   MenuItem head=m.add(0,1,0,"● "+name+" · "+state+route);
   head.setEnabled(false);
   if(paired!=null){
     m.add(0,2,1,"立即重连");
     m.add(0,3,2,"刷新工作区");
     m.add(0,4,3,"扫描二维码切换电脑");
     m.add(0,5,4,"粘贴配对链接");
     m.add(0,6,5,"连接选项…");
   }else{
     m.add(0,4,1,"扫描电脑上的二维码");
     m.add(0,5,2,"粘贴配对链接");
     m.add(0,6,3,"连接选项…");
   }
   if(deviceChevron!=null)deviceChevron.animate().rotation(180f).setDuration(180).start();
   menu.setOnDismissListener(p->{if(deviceChevron!=null)deviceChevron.animate().rotation(0f).setDuration(160).start();});
   menu.setOnMenuItemClickListener(item->{
     switch(item.getItemId()){
       case 2:open(true);return true;
       case 3:openAfterReset();return true;
       case 4:scanQr();return true;
       case 5:paste();return true;
       case 6:options();return true;
       default:return false;
     }
   });
   menu.show();
 }
 void updatePanelActions(boolean visible, boolean writable, String badge) {
   panelHub.setVisibility(visible ? View.VISIBLE : View.GONE);
   panelNew.setVisibility(visible && writable ? View.VISIBLE : View.GONE);
   panelHub.setContentDescription("移动端工具箱" + (badge.equals("approval") ? "，待确认" : badge.equals("running") ? "，任务运行中" : ""));
 }
 final NativeVoice voice=new NativeVoice(this);
 int dp(float n){return Math.round(n*getResources().getDisplayMetrics().density);} TextView text(String s,int sp){TextView t=new TextView(this);t.setText(s);t.setTextColor(0xff18223b);t.setTextSize(sp);return t;} Button button(String s,Runnable f){Button b=new Button(this);b.setText(s);b.setAllCaps(false);b.setOnClickListener(v->f.run());return b;}
 @Override public void onCreate(Bundle b){super.onCreate(b);vault=new Vault(this);if(b!=null){selection=b.getString("session","");cold=b.getBoolean("cold",true);}root=new LinearLayout(this);root.setOrientation(1);root.setBackgroundColor(Color.WHITE);bar=new LinearLayout(this);bar.setGravity(Gravity.CENTER_VERTICAL);bar.setPadding(dp(4),0,dp(4),0);Button drawer=button("☰",()->js("window.__DSH_MOBILE_BRIDGE__?.toggleSidebar()"));drawer.setContentDescription("工作区侧栏");bar.addView(drawer,dp(48),dp(48));devicePill=new LinearLayout(this);devicePill.setOrientation(LinearLayout.HORIZONTAL);devicePill.setGravity(Gravity.CENTER_VERTICAL);devicePill.setPadding(dp(10),dp(6),dp(10),dp(6));devicePill.setBackground(pillBg(0x0F263148,0x1A000000));statusDot=new View(this);LinearLayout.LayoutParams dotLp=new LinearLayout.LayoutParams(dp(8),dp(8));dotLp.setMarginEnd(dp(6));devicePill.addView(statusDot,dotLp);title=text("DSH Mobile",14);title.setSingleLine();title.setEllipsize(android.text.TextUtils.TruncateAt.END);devicePill.addView(title,new LinearLayout.LayoutParams(-2,-2,1f));deviceChevron=text("▾",12);deviceChevron.setTextColor(0xff61666b);deviceChevron.setPadding(dp(5),0,0,0);devicePill.addView(deviceChevron);devicePill.setOnClickListener(this::showDeviceMenu);FrameLayout pillSlot=new FrameLayout(this);FrameLayout.LayoutParams pillInner=new FrameLayout.LayoutParams(-2,-2,Gravity.START|Gravity.CENTER_VERTICAL);pillInner.setMarginEnd(dp(4));pillSlot.addView(devicePill,pillInner);bar.addView(pillSlot,new LinearLayout.LayoutParams(0,-2,1));panelHub=button("⊞",()->js("window.__DSH_MOBILE_BRIDGE__?.openHub('tasks')"));panelNew=button("＋",()->js("window.__DSH_MOBILE_BRIDGE__?.newSession()"));panelNew.setContentDescription("新建会话");for(Button action:new Button[]{panelHub,panelNew}){action.setBackgroundColor(Color.TRANSPARENT);action.setPadding(0,0,0,0);bar.addView(action,dp(44),dp(48));}updatePanelActions(false,false,"");Button menu=button("⋯",this::options);menu.setContentDescription("连接选项");bar.addView(menu,dp(48),dp(48));root.addView(bar,-1,-2);body=new FrameLayout(this);root.addView(body,new LinearLayout.LayoutParams(-1,0,1));setContentView(root);
  if(Build.VERSION.SDK_INT>=30){getWindow().setDecorFitsSystemWindows(false);getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING);getWindow().setStatusBarColor(Color.TRANSPARENT);getWindow().setNavigationBarColor(Color.TRANSPARENT);root.setOnApplyWindowInsetsListener((v,i)->{android.graphics.Insets a=i.getInsets(WindowInsets.Type.systemBars()|WindowInsets.Type.displayCutout()|WindowInsets.Type.ime());v.setPadding(a.left,a.top,a.right,a.bottom);return WindowInsets.CONSUMED;});getWindow().getInsetsController().setSystemBarsAppearance(WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS|WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS,WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS|WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS);}
  try{paired=vault.load();if(paired!=null&&selection.isEmpty()){selection=paired.optString("LastSession","");if(!selection.isEmpty())cold=false;}}catch(Exception ignored){vault.clear();}updateDevicePill();landing(paired==null?"在电脑 DSH 左下角打开「手机连接」。同一 Wi-Fi 下可直接配对。":"正在连接电脑…");listen();if(!incoming(getIntent())&&paired!=null)open(false);
 }
 @Override protected void onSaveInstanceState(Bundle b){super.onSaveInstanceState(b);b.putString("session",selection);b.putBoolean("cold",cold);}
 @Override protected void onNewIntent(Intent intent){super.onNewIntent(intent);incoming(intent);}
 boolean incoming(Intent intent){if(intent==null||!Intent.ACTION_VIEW.equals(intent.getAction())||intent.getData()==null)return false;confirm(intent.getDataString());return true;}
 void landing(String msg){body.removeAllViews();ScrollView scroll=new ScrollView(this);scroll.setFillViewport(true);FrameLayout center=new FrameLayout(this);scroll.addView(center);LinearLayout panel=new LinearLayout(this);panel.setOrientation(1);panel.setGravity(Gravity.CENTER_VERTICAL);panel.setPadding(dp(22),dp(18),dp(22),dp(18));center.addView(panel,new FrameLayout.LayoutParams(-1,-2,Gravity.CENTER));center.addOnLayoutChangeListener((v,l,t,r,b,ol,ot,or,ob)->{int w=Math.min(r-l,dp(520));if(w>0&&panel.getLayoutParams().width!=w){FrameLayout.LayoutParams p=(FrameLayout.LayoutParams)panel.getLayoutParams();p.width=w;panel.setLayoutParams(p);}});panel.addView(text(paired==null?"连接你的 DSH 工作区":"连接到电脑",24));status=text(msg,15);status.setPadding(0,dp(10),0,dp(16));panel.addView(status);if(paired!=null)panel.addView(button("重新连接",()->open(true)));panel.addView(button("扫描电脑上的二维码",this::scanQr));panel.addView(button("粘贴配对链接",this::paste));body.addView(scroll);}
 void paste(){EditText e=new EditText(this);e.setSingleLine();e.setHint("dshmobile://pair?…");new AlertDialog.Builder(this).setTitle("粘贴电脑提供的配对链接").setView(e).setPositiveButton("下一步",(d,w)->confirm(e.getText().toString())).setNegativeButton("取消",null).show();}
 void confirm(String link){try{JSONObject q=NativeLink.offer(link);new AlertDialog.Builder(this).setTitle("确认配对电脑").setMessage(q.getString("name")+"\n\n请核对电脑上显示的安全码：\n"+NativeLink.safety(q.getString("Pin"))).setNegativeButton("取消",null).setPositiveButton("安全码一致，配对",(d,w)->pair(q)).show();}catch(Exception e){message("配对链接无效或已过期，请在电脑上刷新二维码。");}}
 void message(String s){if(!isFinishing()&&!isDestroyed())new AlertDialog.Builder(this).setMessage(s).setPositiveButton("知道了",null).show();}
 interface Done{void run(JSONObject r)throws Exception;}
 void task(JSONObject q,Done done){int ticket=++generation;busy=true;IO.execute(()->{JSONObject r;try{r=NativeLink.run(q);}catch(Exception e){r=new JSONObject();}final JSONObject v=r;ui.post(()->{if(isDestroyed()||ticket!=generation)return;busy=false;try{done.run(v);}catch(Exception e){message("无法完成操作，请重试。");}});});}
 void pair(JSONObject q){try{q.put("Op","pair").put("Device","android-"+UUID.randomUUID());task(q,r->{if(!r.has("Token")){message(r.optString("Error","配对失败"));return;}q.remove("Code");q.remove("Device");q.put("Token",r.getString("Token"));rememberHost(q,r.optString("Host"));vault.save(q);paired=q;cold=true;selection="";revoked=false;failures=0;destroyWeb();open(true);});}catch(Exception e){message("无法发起配对");}}
 void open(boolean manual){if(paired==null||busy||isDestroyed())return;ui.removeCallbacks(retry);ui.removeCallbacks(watchdog);if(manual){failures=0;revoked=false;}try{JSONObject q=new JSONObject(paired.toString()).put("Op","open");task(q,r->{if(!r.has("Origin")){if(r.optInt("Status")==401){revoked=true;destroyWeb();vault.clear();paired=null;updateDevicePill();landing("电脑已撤销配对，请重新扫码。");return;}if(web==null)landing(r.optString("Error","暂时无法连接电脑。"));updateDevicePill();schedule();return;}if(!r.optString("Host").equals(paired.getJSONArray("Hosts").optString(0))){rememberHost(paired,r.optString("Host"));vault.save(paired);}failures=0;mount(r);});updateDevicePill();}catch(Exception e){schedule();}}
 void schedule(){if(!foreground||paired==null||revoked)return;ui.removeCallbacks(retry);ui.postDelayed(retry,Math.min(12000,300L<<Math.min(6,failures++)));}
 void recover(){if(!foreground||paired==null||revoked||busy)return;healthy=false;updateDevicePill();open(false);}
 void connected(){streamSeen=true;ui.removeCallbacks(streamCheck);streamCheckPending=false;healthy=true;failures=0;ui.removeCallbacks(retry);ui.removeCallbacks(watchdog);updateDevicePill();}
 boolean streamCheckPending,streamSeen;final Runnable streamCheck=()->{streamCheckPending=false;if(!healthy)recover();};
 void armStreamCheck(){if(streamSeen&&!streamCheckPending&&foreground){streamCheckPending=true;ui.postDelayed(streamCheck,1500);}}
 void fastResume(){if(busy||!foreground||paired==null||revoked)return;ui.removeCallbacks(retry);if(web==null){open(false);return;}healthy=false;updateDevicePill();js("window.__DSH_MOBILE_BRIDGE__?.reconnect?.()");ui.removeCallbacks(watchdog);ui.postDelayed(watchdog,1200);}
 void rememberHost(JSONObject q,String host)throws Exception{JSONArray all=q.getJSONArray("Hosts");if(host.isEmpty()||host.equals(all.optString(0)))return;JSONArray ranked=new JSONArray();ranked.put(host);for(int i=0;i<all.length();i++){String h=all.getString(i);if(!h.equals(host))ranked.put(h);}q.put("Hosts",ranked);}
 void mount(JSONObject r)throws Exception{String next=r.getString("Origin");boolean reuse=web!=null&&origin.equals(next);if(!reuse){destroyWeb();origin=next;web=new WebView(this);web.setAlpha(0f);WebSettings s=web.getSettings();s.setJavaScriptEnabled(true);s.setDomStorageEnabled(true);s.setAllowFileAccess(false);s.setAllowContentAccess(false);s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);s.setUseWideViewPort(true);s.setLoadWithOverviewMode(false);s.setTextZoom(100);CookieManager.getInstance().setAcceptThirdPartyCookies(web,false);body.removeAllViews();body.addView(web,new FrameLayout.LayoutParams(-1,-1));web.animate().alpha(1f).setDuration(180).start();WebView w=web;w.setWebViewClient(new WebViewClient(){@Override public boolean shouldOverrideUrlLoading(WebView v,WebResourceRequest req){return !local(req.getUrl());}@Override public WebResourceResponse shouldInterceptRequest(WebView v,WebResourceRequest req){Uri u=req.getUrl();if(local(u)||"blob".equals(u.getScheme())||"data".equals(u.getScheme())||"about".equals(u.getScheme()))return null;return new WebResourceResponse("text/plain","UTF-8",403,"Forbidden",Collections.emptyMap(),new java.io.ByteArrayInputStream(new byte[0]));}@Override public void onReceivedHttpError(WebView v,WebResourceRequest req,WebResourceResponse err){if(v==web&&req.isForMainFrame()&&err.getStatusCode()>=400){documentFailed=true;recover();}}@Override public void onReceivedError(WebView v,WebResourceRequest req,WebResourceError err){if(v==web&&req.isForMainFrame()){documentFailed=true;recover();}}@Override public boolean onRenderProcessGone(WebView v,RenderProcessGoneDetail d){if(v==web){destroyWeb();schedule();}return true;}});
  w.setWebChromeClient(new WebChromeClient(){
  @Override public boolean onShowFileChooser(WebView v,ValueCallback<Uri[]> cb,FileChooserParams params){if(fileCallback!=null)fileCallback.onReceiveValue(null);fileCallback=cb;try{startActivityForResult(params.createIntent(),407);return true;}catch(Exception e){fileCallback=null;return false;}}});
  if(!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)||!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)){destroyWeb();landing("请更新 Android System WebView 或 Chrome 后重新连接。");return;}
  Set<String> origins=Collections.singleton(origin);WebViewCompat.addWebMessageListener(w,"DSHNative",origins,(view,msg,src,main,reply)->{if(view!=web||!main)return;try{JSONObject m=new JSONObject(msg.getData());switch(m.optString("type")){case "save":saves.offer(view,m);break;case "save-chunk":saves.chunk(view,m);break;case "save-abort":if(saves.id.equals(m.optString("id")))saves.end();break;case "ws":if("connected".equals(m.optString("state")))connected();else{healthy=false;updateDevicePill();armStreamCheck();}break;case "auth-expired":open(false);break;case "launch-applied":routeApplied=true;cold=false;rememberSession(m.optString("sessionId",""));installBoot();break;case "secondary-hub":updatePanelActions(m.optBoolean("visible"),m.optBoolean("writable"),m.optString("badge"));break;case "ui":if(routeApplied&&!m.isNull("currentSessionId"))rememberSession(m.optString("currentSessionId",""));break;}}catch(Exception ignored){}});
  w.setOnTouchListener((v,event)->{voice.observeTouch(event);return false;});
  WebViewCompat.addWebMessageListener(w,"DSHVoiceNative",origins,(view,msg,src,main,reply)->{
   if(view!=web||!main||!local(src)||revoked)return;
   try{voice.message(view,new JSONObject(msg.getData()));}catch(JSONException ignored){}
  });
  installBoot();
 }updateDevicePill();WebView view=web;CookieManager.getInstance().setCookie(origin,r.getString("Key")+"="+r.getString("Cookie")+"; Path=/; HttpOnly; SameSite=Strict",ok->{if(view!=web)return;if(!ok){message("本机 WebView 未接受工作区凭证。");return;}if(reuse&&!documentFailed&&view.getUrl()!=null&&local(Uri.parse(view.getUrl()))){js("(()=>{const b=window.__DSH_MOBILE_BRIDGE__;if(b?.credentialsChanged)b.credentialsChanged();else b?.reconnect?.()})()");}else{voice.cancel();documentFailed=false;routeApplied=false;view.loadUrl(origin+"/");}ui.removeCallbacks(watchdog);ui.postDelayed(watchdog,20000);});}
 // Update only future documents. Never reload the current one to change its launch route.
 void installBoot()throws Exception{if(web==null)return;if(boot!=null)boot.remove();JSONObject route=new JSONObject().put("mode",selection.isEmpty()?(cold?"new":"keep"):"resume");if(!selection.isEmpty())route.put("resume",selection);
  String nav="const hide=()=>{const r=document.documentElement;if(!r)return false;r.setAttribute('data-dml-native-nav','');const s=document.createElement('style');s.textContent='[data-sidebar-opener]{display:none!important}';r.appendChild(s);return true};if(!hide()){const o=new MutationObserver(()=>{if(hide())o.disconnect()});o.observe(document,{childList:true})};";
  boot=WebViewCompat.addDocumentStartJavaScript(web,"if(window===window.top){"+nav+DocumentSave.BOOT+"window.__DSH_NATIVE_PANEL_HUB__=1;window.__DSH_NATIVE_VOICE__=1;window.__DSH_MOBILE_LAUNCH__="+route+";window.webkit=window.webkit||{};window.webkit.messageHandlers={dshMobile:{postMessage:m=>(m.type?.startsWith('voice-')?DSHVoiceNative:DSHNative).postMessage(JSON.stringify(m))}};}",Collections.singleton(origin));}
 void rememberSession(String id)throws Exception{if(id.isEmpty()||id.equals(selection)||id.equals("null")||paired==null)return;selection=id;paired.put("LastSession",id);vault.save(paired);installBoot();}
 boolean local(Uri u){String o=origin;return o!=null&&!o.isEmpty()&&"http".equals(u.getScheme())&&o.equals("http://"+u.getEncodedAuthority());}
 void js(String s){if(web!=null)web.evaluateJavascript(s,null);} void destroyWeb(){updatePanelActions(false,false,"");voice.cancel();if(boot!=null){boot.remove();boot=null;}documentFailed=false;routeApplied=false;streamSeen=false;ui.removeCallbacks(streamCheck);streamCheckPending=false;saves.end();if(web!=null){body.removeView(web);web.stopLoading();web.destroy();web=null;}origin="";healthy=false;updateDevicePill();}
 void options(){String[] names=paired==null?new String[]{"扫描或粘贴配对链接"}:new String[]{"立即重连","刷新工作区","断开并忘记此电脑"};new AlertDialog.Builder(this).setTitle("连接选项").setItems(names,(d,i)->{if(paired==null){paste();return;}if(i==0)open(true);else if(i==1)openAfterReset();else new AlertDialog.Builder(this).setMessage("移除此手机上的配对？如需撤销凭证，也可在电脑「手机连接」中移除此设备。").setPositiveButton("移除",(dd,k)->forget()).setNegativeButton("取消",null).show();}).show();}
 void openAfterReset(){destroyWeb();open(true);}void forget(){generation++;busy=false;ui.removeCallbacksAndMessages(null);destroyWeb();paired=null;selection="";cold=true;vault.clear();closeNative();updateDevicePill();landing("已移除配对。");}
 void closeNative(){IO.execute(()->{try{NativeLink.run(new JSONObject().put("Op","close"));}catch(Exception ignored){}});}
 @Override protected void onActivityResult(int req,int code,Intent data){super.onActivityResult(req,code,data);if(req==DocumentSave.REQUEST){saves.selected(code,data);return;}if(req==407){if(fileCallback!=null){fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(code,data));fileCallback=null;}return;}IntentResult s=IntentIntegrator.parseActivityResult(req,code,data);if(s!=null&&s.getContents()!=null)confirm(s.getContents());}
 void listen(){cm=(ConnectivityManager)getSystemService(CONNECTIVITY_SERVICE);net=new ConnectivityManager.NetworkCallback(){@Override public void onAvailable(Network n){ui.post(()->{if(isDestroyed())return;activeNet=n;if(foreground&&paired!=null&&!busy&&!healthy){fastResume();}});}};cm.registerDefaultNetworkCallback(net);}
 @Override protected void onResume(){super.onResume();foreground=true;if(web!=null){web.onResume();if(!healthy)fastResume();}else if(paired!=null&&!busy)fastResume();}
 @Override public void onRequestPermissionsResult(int request,String[] values,int[] grants){super.onRequestPermissionsResult(request,values,grants);if(request==NativeVoice.PERMISSION)voice.permissionResult(grants.length>0&&grants[0]==android.content.pm.PackageManager.PERMISSION_GRANTED);}
 @Override protected void onPause(){foreground=false;voice.cancel();ui.removeCallbacks(streamCheck);streamCheckPending=false;ui.removeCallbacks(retry);ui.removeCallbacks(watchdog);if(web!=null)web.onPause();super.onPause();}
 @Override protected void onDestroy(){generation++;ui.removeCallbacksAndMessages(null);if(net!=null)cm.unregisterNetworkCallback(net);destroyWeb();closeNative();super.onDestroy();}
 @Override public void onBackPressed(){if(web!=null&&web.canGoBack())web.goBack();else super.onBackPressed();}
}
