/** Exact diagnostic differences, not a claim that synthetic fixtures calibrate a model. */
function difference(estimate:unknown,actual:unknown){
 if(typeof estimate!=='string'||typeof actual!=='string'||!/^\d+$/.test(estimate)||!/^\d+$/.test(actual))return {state:'unknown' as const};
 const expected=BigInt(estimate),observed=BigInt(actual),delta=expected-observed;
 return {state:'known' as const,estimate,actual,delta:delta.toString(),relative_error_ppm:observed===0n?null:(delta*1000000n/observed).toString()};
}
export function smokeMeasurements(rows:any[],real:boolean){
 return {evidence:real?'live_smoke_sample':'synthetic_fixture',calibration:real?'sample_only':'not_calibrated',samples:rows.map(row=>{
  const breakdown=row.calculation?.breakdown,usage=row.attempts?.length===1?row.attempts[0].usage:undefined;
  const component=(key:string)=>breakdown?.components?.find((c:any)=>c.key===key)?.value;
  return {provider:row.provider,model:row.model,scenario:row.scenario,request_id:row.request_id,input_tokens:difference(component('input'),usage?.state==='known'?usage.breakdown?.input_tokens:undefined),output_tokens:difference(component('output'),usage?.state==='known'?usage.breakdown?.output_tokens:undefined),provider_cost_units:difference(breakdown?.provider_estimate_units,row.attempts?.length===1?row.attempts[0].cost_units:undefined)};
 })};
}
