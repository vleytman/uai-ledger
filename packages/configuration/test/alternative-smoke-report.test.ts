import {afterAll,describe,it,expect,vi} from 'vitest';
import {createPool} from '../../db/src/index.js';
import {runAlternativeSmoke,smokeManifest,continuationSmokeManifest,remainingSmokeCalls} from '../../../scripts/lib/alternative-smoke.js';
import {smokeMeasurements} from '../../../scripts/lib/alternative-smoke-report.js';
const pool=process.env.DATABASE_URL?createPool():null;afterAll(async()=>pool?.end());
it('requires a new manifest for a known failure and repeats only the necessary tool pair',()=>{
 const original=smokeManifest();const previous={manifest_sha256:original.sha256,status:'stopped',cost_state:'known',cost_units:'2230700',cleanup:{budgets:[{reserved_units:'0'}]},rows:original.calls.slice(0,7).map((c,i)=>({...c,status:i===6?'failed':'succeeded',settlement:'settled',acknowledged:i!==6,attempts:[{cost_units:'1'}]}))};
 const next=continuationSmokeManifest(previous);expect(next.sha256).not.toBe(original.sha256);expect(next.calls).toHaveLength(28);expect(next.calls.slice(0,2).map(c=>c.scenario)).toEqual(['round_trip_call','round_trip_result']);expect(next.calls.every(c=>c.max_output_tokens===1024)).toBe(true);expect(BigInt(next.max_cost_units)+BigInt(previous.cost_units)).toBeLessThanOrEqual(BigInt(original.max_cost_units));
 expect(()=>continuationSmokeManifest({...previous,cost_state:'incomplete'})).toThrow();expect(()=>continuationSmokeManifest({...previous,cleanup:{budgets:[{reserved_units:'1'}]}})).toThrow();expect(()=>continuationSmokeManifest({...previous,cost_units:original.max_cost_units})).toThrow();
});
it('resumes only an unsubmitted suffix of the same approval and rejects unsafe boundaries',()=>{
 const manifest=smokeManifest(),rows=manifest.calls.slice(0,3).map((c,i)=>({...c,request_id:`request-${i}`,status:i===2?'failed':'succeeded',settlement:'settled',acknowledged:i!==2,attempts:[{cost_units:'0'}]})),previous={mode:'fixture',manifest_sha256:manifest.sha256,status:'stopped',cost_state:'known',cost_units:'0',calls:3,rows,cleanup:{budgets:[{reserved_units:'0'}]}};
 expect(remainingSmokeCalls(manifest,previous)).toEqual(manifest.calls.slice(3));
 for(const invalid of [{...previous,cost_state:'incomplete'},{...previous,manifest_sha256:'other'},{...previous,cleanup:{budgets:[]}},{...previous,rows:[...rows].reverse()},{...previous,cost_units:'1'}])expect(()=>remainingSmokeCalls(manifest,invalid)).toThrow();
});
it('reports exact signed estimation error without making unknown or zero usage a relative percentage',()=>{
 const rows=[{provider:'cerebras',model:'fixture',calculation:{breakdown:{components:[{key:'input',value:'100'},{key:'output',value:'10'}],provider_estimate_units:'500'}},attempts:[{cost_units:'600',usage:{state:'known',breakdown:{input_tokens:'80',output_tokens:'0'}}}]}];
 const live=smokeMeasurements(rows,true);expect(live.samples[0].input_tokens).toMatchObject({delta:'20',relative_error_ppm:'250000'});expect(live.samples[0].output_tokens.relative_error_ppm).toBeNull();expect(live.samples[0].provider_cost_units).toMatchObject({delta:'-100',relative_error_ppm:'-166666'});
 expect(smokeMeasurements([{...rows[0],attempts:[{cost_units:null,usage:{state:'unknown'}}]}],false)).toMatchObject({calibration:'not_calibrated',samples:[{input_tokens:{state:'unknown'},provider_cost_units:{state:'unknown'}}]});
});
(pool?describe:describe.skip)('AMI smoke failure evidence',()=>{
 it('settles a non-billable Google error without retry or open reservations',async()=>{
  const report=await runAlternativeSmoke(pool!,false,{deferProviders:['cerebras','groq'],fixtureFetch:async()=>new Response('{}',{status:429})});
  expect(report.calls).toBe(1);expect(report.rows[0].provider).toBe('google_cloud');expect(report.cost_units).toBe('0');expect(report.cost_state).toBe('known');expect(report.rows[0].settlement).toBe('settled');expect(report.rows[0].attempts[0].http_observations[0].status).toBe(429);expect(report.cleanup.budgets.every((b:any)=>b.reserved_units==='0')).toBe(true);
 });

 it('defers providers without sending their paid requests or declaring complete acceptance',async()=>{
  const report=await runAlternativeSmoke(pool!,false,{deferProviders:['google_cloud']});
  expect(report.status).toBe('deferred');expect(report.calls).toBe(26);expect(report.fixture_sends).toBe(26);expect(report.deferred_calls).toHaveLength(7);
  expect(report.rows.every((row:any)=>row.provider!=='google_cloud'&&row.acknowledged)).toBe(true);
  expect(report.cleanup.budgets.every((b:any)=>b.reserved_units==='0')).toBe(true);
 },90000);
 it('counts refusal cost, retains recovery IDs, stops after one send and disables connections',async()=>{
  const fetch=vi.fn(async()=>new Response(JSON.stringify({choices:[{finish_reason:'content_filter',message:{content:null}}],usage:{prompt_tokens:40,completion_tokens:10}})));
  const report=await runAlternativeSmoke(pool!,false,{fixtureFetch:fetch});
  expect(report.status).toBe('stopped');expect(report.calls).toBe(1);expect(fetch).toHaveBeenCalledTimes(1);expect(report.fixture_sends).toBe(1);expect(report.cost_units).toBe('54500');expect(report.cost_state).toBe('known');
  expect(report.rows[0].request_id).toMatch(/^req_/);expect(report.rows[0].attempts).toHaveLength(1);expect(report.cleanup.connections.every((c:any)=>c.status==='disabled')).toBe(true);expect(report.cleanup.budgets.every((b:any)=>b.reserved_units==='0')).toBe(true);expect(process.env.UAI_ALLOW_REAL_PROVIDERS).toBe('false');
 });
 it.each(['missing_usage','transport_lost'])('retains unresolved exposure after %s, with no second request',async fault=>{
  const fetch=vi.fn(async()=>{if(fault==='transport_lost')throw new Error('fixture connection reset');return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'blue'}}]}));});
  const report=await runAlternativeSmoke(pool!,false,{fixtureFetch:fetch});expect(report.status).toBe('stopped');expect(report.calls).toBe(1);expect(fetch).toHaveBeenCalledTimes(1);expect(report.cost_state).toBe('incomplete');expect(report.rows[0].attempts).toHaveLength(1);expect(report.rows[0].attempts[0].usage.state).toBe('unknown');expect(report.cleanup.connections.every((c:any)=>c.status==='disabled')).toBe(true);expect(report.cleanup.budgets.some((b:any)=>b.kind==='provider'&&BigInt(b.reserved_units)>0n)).toBe(true);
 });
});
