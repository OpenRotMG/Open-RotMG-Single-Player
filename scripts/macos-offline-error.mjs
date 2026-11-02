export function macOfflineErrorDetails(error) {
  if(error===null||typeof error!=='object')return {value:error};
  return {name:error.name,message:error.message,stack:error.stack,code:error.code,syscall:error.syscall,address:error.address,port:error.port,
    cause:error.cause===undefined?undefined:macOfflineErrorDetails(error.cause),errors:Array.isArray(error.errors)?error.errors.map(macOfflineErrorDetails):undefined};
}
