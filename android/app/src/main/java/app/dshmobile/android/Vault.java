package app.dshmobile.android;
import android.content.*;
import android.security.keystore.*;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.*;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONObject;
final class Vault {
 final SharedPreferences prefs; final String alias="dsh.mobile.pair.v1";
 Vault(Context c){prefs=c.getSharedPreferences("paired_desktop",Context.MODE_PRIVATE);}
 private SecretKey key()throws Exception{KeyStore ks=KeyStore.getInstance("AndroidKeyStore");ks.load(null);if(ks.containsAlias(alias))return (SecretKey)ks.getKey(alias,null);KeyGenerator g=KeyGenerator.getInstance("AES","AndroidKeyStore");g.init(new KeyGenParameterSpec.Builder(alias,KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());return g.generateKey();}
 void save(JSONObject o)throws Exception{Cipher c=Cipher.getInstance("AES/GCM/NoPadding");c.init(Cipher.ENCRYPT_MODE,key());if(!prefs.edit().putString("iv",Base64.encodeToString(c.getIV(),2)).putString("v",Base64.encodeToString(c.doFinal(o.toString().getBytes(StandardCharsets.UTF_8)),2)).commit())throw new Exception("无法保存配对");}
 JSONObject load()throws Exception{String v=prefs.getString("v",null);if(v==null)return null;Cipher c=Cipher.getInstance("AES/GCM/NoPadding");c.init(Cipher.DECRYPT_MODE,key(),new GCMParameterSpec(128,Base64.decode(prefs.getString("iv",""),2)));return new JSONObject(new String(c.doFinal(Base64.decode(v,2)),StandardCharsets.UTF_8));}
 void clear(){prefs.edit().clear().apply();}
}
