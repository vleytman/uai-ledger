/** Local synthetic acceptance only: never accepts an arbitrary provider/API URL. */
import {writeFile} from 'node:fs/promises';
import {sseData} from '../packages/sdk/src/stream.js';
const samples=Number(process.env.UAI_LATENCY_SAMPLES??30);
if(!Number.isInteger(samples)||samples<5||samples>500)throw new Error('Use 5–500 samples');
const measurements:Record<string,number[]>={},add=(key:string,value:number)=>{if(Number.isFinite(value)&&value>=0)(measurements[key]??=[]).push(value)};
for(let i=0;i<samples;i++){
 const start=performance.now();let first=false,complete=false;
 const response=await fetch('http://127.0.0.1:4348/run',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key:crypto.randomUUID(),input:{messages:[{role:'user',content:[{type:'text',text:'Synthetic latency sample'}]}]},max_attempts:1})});
 if(!response.ok)throw new Error(`Fixture returned ${response.status}`);
 for await(const unknown of sseData(response)){
  const event=unknown as any;
  if(event.type==='delta'&&!first){first=true;add('client_first_content_ms',performance.now()-start)}
  if(event.type==='result'){
   if(event.result.execution_status!=='succeeded')throw new Error('Unsuccessful sample');complete=true;
   const t=event.result.timings??{},elapsed=(a:string,b:string)=>new Date(t[b]).getTime()-new Date(t[a]).getTime();
   add('admission_ms',elapsed('received','accepted'));add('commit_to_dispatch_ms',elapsed('accepted','dispatched'));add('provider_first_delta_ms',elapsed('dispatched','provider_first_delta'));add('provider_to_api_delta_ms',elapsed('provider_first_delta','api_first_delta'));add('client_complete_ms',performance.now()-start);
  }
 }
 if(!first||!complete)throw new Error('Missing sample events');
}
const report={at:new Date().toISOString(),conditions:{provider:'fake',transport:'loopback HTTP SSE',concurrency:1,samples,warmup:0,worker_poll_ms:10,simulated_provider_delay_ms:40,includes_fixture_proxy_and_persist_before_ack:true,live_provider_slo_verified:false},metrics:Object.fromEntries(Object.entries(measurements).map(([key,values])=>{values.sort((a,b)=>a-b);const percentile=(p:number)=>Math.round(values[Math.ceil(p*values.length)-1]*100)/100;return [key,{n:values.length,p50:percentile(.5),p95:percentile(.95),p99:percentile(.99)}]}))};
const output=process.env.UAI_LATENCY_OUTPUT??'/tmp/uai-universal-latency.json';await writeFile(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
