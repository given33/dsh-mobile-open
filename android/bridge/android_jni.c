//go:build android

#include <jni.h>
#include <stdlib.h>
#include <string.h>
extern char* exchange(void*, int);
JNIEXPORT jbyteArray JNICALL Java_app_dshmobile_android_NativeLink_exchange(JNIEnv *env,jclass klass,jbyteArray data){
 jsize n=(*env)->GetArrayLength(env,data);if(n<1||n>32768)return NULL;
 void *buf=malloc(n);if(!buf)return NULL;(*env)->GetByteArrayRegion(env,data,0,n,buf);char* res=exchange(buf,n);free(buf);
 jsize k=(jsize)strlen(res);jbyteArray out=(*env)->NewByteArray(env,k);if(out)(*env)->SetByteArrayRegion(env,out,0,k,(jbyte*)res);free(res);return out;
}
