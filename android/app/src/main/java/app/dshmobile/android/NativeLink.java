package app.dshmobile.android;
import android.net.Uri;
import android.util.Base64;
import org.json.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
final class NativeLink {
 static {System.loadLibrary("dshlink");}
 private static native byte[] exchange(byte[] data);
 static JSONObject run(JSONObject q) throws Exception {return new JSONObject(new String(exchange(q.toString().getBytes(StandardCharsets.UTF_8)),StandardCharsets.UTF_8));}
 static JSONObject offer(String raw) throws Exception {
  if(raw==null||raw.length()>8192)throw new Exception();Uri u=Uri.parse(raw.trim()); if(!"dshmobile".equals(u.getScheme())||!"pair".equals(u.getAuthority())||!"1".equals(u.getQueryParameter("v")))throw new Exception();
  String id=field(u,"id","[A-Za-z0-9_-]{8,64}"),pin=field(u,"fp","[A-Za-z0-9_-]{43}"),code=field(u,"c","[A-Za-z0-9_-]{16,128}");String e=u.getQueryParameter("e");if(e!=null&&Long.parseLong(e)<=System.currentTimeMillis()/1000)throw new Exception();
  List<String> hs=u.getQueryParameters("h");if(hs.isEmpty()||hs.size()>8)throw new Exception();for(String h:hs)if(!h.matches("(?:[A-Za-z0-9.-]{1,253}|\\[[a-fA-F0-9:.]+\\]):[0-9]{1,5}"))throw new Exception();String n=u.getQueryParameter("n");if(n==null||n.trim().isEmpty())n="我的电脑";return new JSONObject().put("ID",id).put("Pin",pin).put("Code",code).put("Hosts",new JSONArray(hs)).put("name",n.substring(0,Math.min(64,n.length())).replaceAll("\\p{C}",""));
 }
 private static String field(Uri u,String k,String pattern)throws Exception{List<String> a=u.getQueryParameters(k);if(a.size()!=1||!a.get(0).matches(pattern))throw new Exception();return a.get(0);}
 static String safety(String pin){byte[] d=Base64.decode(pin,Base64.URL_SAFE|Base64.NO_PADDING|Base64.NO_WRAP);StringBuilder s=new StringBuilder();for(int i=0;i<8;i++){if(i>0&&i%2==0)s.append(' ');s.append(String.format(Locale.ROOT,"%02X",d[i]));}return s.toString();}
}
