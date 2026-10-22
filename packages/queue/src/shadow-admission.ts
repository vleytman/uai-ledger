import type {WorkerDependencies} from '../../execution/src/runtime.js';
type Admit=NonNullable<WorkerDependencies['admit']>;
export interface ShadowResult {would_allow:boolean|null;reason?:string}
export interface ShadowObservation {
 event:'quota.shadow';request_id:string;at:string;
 shadow:{decision:'allow'|'deny'|'unknown';reason?:string;ms:number};
 actual:{decision:'allow'|'deny'|'error';reason?:string};
 matches:boolean|null;
}
const safeCode=(value:unknown)=>typeof value==='string'&&/^[a-zA-Z0-9_]{1,100}$/.test(value)?value:'unclassified';
export function quotaShadowEnabled(env:NodeJS.ProcessEnv){
 const value=env.UAI_QUOTA_SHADOW??'false';if(value!=='true'&&value!=='false')throw new Error('invalid_quota_shadow');
 if(value==='true'&&env.UAI_WORKER_BACKEND!=='bullmq')throw new Error('quota_shadow_requires_bullmq');return value==='true';
}
/** Preview cannot authorize work. The original admit runs once, including when preview fails. */
export function shadowAdmission(admit:Admit,preview:(...args:Parameters<Admit>)=>Promise<ShadowResult>,report:(sample:ShadowObservation)=>void|Promise<void>,options:{now?:()=>number;budgetMs?:number}={}):Admit{
 const now=options.now??(()=>performance.now()),budget=options.budgetMs??500;
 if(!Number.isSafeInteger(budget)||budget<1||budget>5000)throw new Error('invalid_shadow_budget');
 let pending:Promise<ShadowResult>|undefined;
 return async(...args)=>{
  const started=now();let prediction:ShadowResult;
  if(pending)prediction={would_allow:null,reason:'preview_busy'};
  else{
   const query=Promise.resolve().then(()=>preview(...args));pending=query;
   void query.then(()=>{if(pending===query)pending=undefined},()=>{if(pending===query)pending=undefined});
   let timer:ReturnType<typeof setTimeout>|undefined;
   try{prediction=await Promise.race([query,new Promise<ShadowResult>(resolve=>{timer=setTimeout(()=>resolve({would_allow:null,reason:'preview_timeout'}),budget);timer.unref()})])}
   catch{prediction={would_allow:null,reason:'preview_failed'}}finally{if(timer)clearTimeout(timer)}
  }
  const shadow:ShadowObservation['shadow']={decision:prediction.would_allow===null?'unknown':prediction.would_allow?'allow':'deny',...(prediction.reason?{reason:safeCode(prediction.reason)}:{}),ms:Math.max(0,now()-started)};
  let actual:ShadowObservation['actual']={decision:'error',reason:'admission_failed'};
  try{
   const result=await admit(...args);actual=result.allowed?{decision:'allow'}:{decision:'deny',reason:safeCode(result.reason)};return result;
  }catch(error){actual={decision:'error',reason:safeCode((error as {code?:unknown})?.code??'admission_failed')};throw error}
  finally{
   const sample:ShadowObservation={event:'quota.shadow',request_id:args[1].id,at:new Date().toISOString(),shadow,actual,matches:shadow.decision==='unknown'||actual.decision==='error'?null:shadow.decision===actual.decision};
   // Operational output is best effort; logging cannot change financial/execution decisions.
   try{void Promise.resolve(report(sample)).catch(()=>{})}catch{}
  }
 };
}
