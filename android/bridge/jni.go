//go:build android

package main
/*
#include <stdlib.h>
*/
import "C"
import ("encoding/json";"unsafe")
//export exchange
func exchange(data unsafe.Pointer,n C.int)*C.char{var q request; if n<1||n>32768||json.Unmarshal(C.GoBytes(data,n),&q)!=nil{return C.CString(`{"Error":"Invalid request"}`)};v,_:=json.Marshal(dispatch(q));return C.CString(string(v))}
