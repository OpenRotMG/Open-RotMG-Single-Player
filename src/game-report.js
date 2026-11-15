const send=(kind,message)=>navigator.sendBeacon('/singleplayer-report',JSON.stringify({kind,message:String(message)}));
addEventListener('error',event=>send('error',`${event.message} (${event.filename}:${event.lineno})`));
addEventListener('unhandledrejection',event=>send('rejection',event.reason?.stack??event.reason));
