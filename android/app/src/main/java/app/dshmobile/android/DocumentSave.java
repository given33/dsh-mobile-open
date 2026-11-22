package app.dshmobile.android;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.webkit.WebView;
import android.util.Base64;
import org.json.JSONObject;
import java.io.OutputStream;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** The system picker grants one destination URI, never a filesystem path. */
final class DocumentSave {
 static final int REQUEST=492, CHUNK=49152, MAX=128*1024*1024;
 static final String BOOT="let blob=null;window.__dmlSave=Object.freeze({start:(b,n)=>{if(blob||b.size>134217728)return false;blob=b;DSHNative.postMessage(JSON.stringify({type:'save',name:n,size:b.size}));return true},clear:()=>{blob=null},read:async(id,o)=>{try{const part=await blob.slice(o,o+49152).arrayBuffer();let s='';const a=new Uint8Array(part);for(let k=0;k<a.length;k+=8192)s+=String.fromCharCode(...a.subarray(k,k+8192));DSHNative.postMessage(JSON.stringify({type:'save-chunk',id,offset:o,data:btoa(s)}))}catch(e){DSHNative.postMessage(JSON.stringify({type:'save-abort',id}))}}});";
 final MainActivity a; final ExecutorService io=Executors.newSingleThreadExecutor(); WebView source;String id="";int size,offset;boolean writing;OutputStream stream;
 DocumentSave(MainActivity a){this.a=a;}
 void offer(WebView w,JSONObject m){if(source!=null)return;int s=m.optInt("size",-1);if(s<0||s>MAX){w.evaluateJavascript("window.__dmlSave.clear()",null);return;}String name=m.optString("name","download").replaceAll("[\\p{Cntrl}/\\\\]","_");if(name.length()>160)name=name.substring(0,160);source=w;id=UUID.randomUUID().toString();size=s;offset=0;try{a.startActivityForResult(new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("application/octet-stream").putExtra(Intent.EXTRA_TITLE,name),REQUEST);}catch(Exception e){end();a.message("无法打开系统保存窗口。");}}
 void selected(int result,Intent data){if(source==null)return;Uri dest=data==null?null:data.getData();if(result!=Activity.RESULT_OK||dest==null||!"content".equals(dest.getScheme())){end();return;}String ticket=id;io.execute(()->{try{OutputStream out=a.getContentResolver().openOutputStream(dest,"wt");if(out==null)throw new java.io.IOException();a.runOnUiThread(()->{if(!ticket.equals(id)){io.execute(()->close(out));return;}stream=out;next();});}catch(Exception e){error(ticket);}});}
 void next(){if(offset==size){end();return;}if(source!=a.web||source.getUrl()==null||!a.local(Uri.parse(source.getUrl()))){end();return;}source.evaluateJavascript("window.__dmlSave.read("+JSONObject.quote(id)+","+offset+")",null);}
 void chunk(WebView w,JSONObject m){if(w!=source||!id.equals(m.optString("id"))||stream==null||writing)return;int remaining=Math.min(CHUNK,size-offset);String data=m.optString("data");if(m.optInt("offset",-1)!=offset||remaining<=0||data.length()!=4*((remaining+2)/3)){end();return;}String ticket=id;OutputStream out=stream;writing=true;io.execute(()->{try{byte[] bytes=Base64.decode(data,Base64.NO_WRAP);if(bytes.length!=remaining)throw new java.io.IOException();out.write(bytes);a.runOnUiThread(()->{if(!ticket.equals(id))return;writing=false;offset+=bytes.length;next();});}catch(Exception e){error(ticket);}});}
 void error(String ticket){a.runOnUiThread(()->{if(!ticket.equals(id))return;end();a.message("保存失败，请重新选择位置。");});}
 static void close(OutputStream out){try{out.close();}catch(Exception ignored){}}
 void end(){OutputStream out=stream;stream=null;writing=false;id="";if(source!=null&&source==a.web)source.evaluateJavascript("window.__dmlSave?.clear()",null);source=null;if(out!=null)io.execute(()->close(out));}
}
