export type UpdateProgress={step:string;completed?:number;total?:number;unit?:'bytes'|'files';startedAt:number;updatedAt:number};
export type ProgressSink=(step:string,completed?:number,total?:number,unit?:'bytes'|'files')=>void;
export function progressText(p:UpdateProgress,now=Date.now()){
 const elapsed=Math.max(0,(now-p.startedAt)/1000),age=Math.max(0,Math.floor((now-p.updatedAt)/1000));let detail='';
 if(p.completed!==undefined&&p.total!==undefined){
  const percent=p.total===0?100:Math.floor(p.completed/p.total*100),size=(n:number)=>(n/1024/1024).toFixed(1)+' MB';
  detail=` · ${percent}% (${p.unit==='bytes'?size(p.completed)+' / '+size(p.total):p.completed+' / '+p.total+' files'})`;
  if(p.unit==='bytes'&&elapsed>0)detail+=` · ${size(p.completed/elapsed)}/s`;
 }
 return `${p.step}${detail} · ${Math.floor(elapsed)}s elapsed${age>=3?' · last progress '+age+'s ago':''}`;
}
export class UpdateReporter{
 value?:UpdateProgress;private published=0;private logged=0;private percent=-1;
 constructor(private publish:(value:UpdateProgress)=>void,private log:(message:string)=>void){}
 reset(){this.value=undefined;this.published=0;this.logged=0;this.percent=-1;}
 report:ProgressSink=(step,completed,total,unit)=>{
  const now=Date.now(),changed=this.value?.step!==step,percent=completed===undefined||total===undefined?-1:total===0?100:Math.floor(completed/total*100);
  const value:UpdateProgress={step,completed,total,unit,startedAt:changed?now:this.value!.startedAt,updatedAt:now};this.value=value;
  if(changed||now-this.published>=200||completed===total){this.published=now;this.publish(value);}
  if(changed||now-this.logged>=5000||percent>=this.percent+10||percent===100&&this.percent!==100){this.logged=now;this.percent=percent;this.log(progressText(value,now));}
 };
}
