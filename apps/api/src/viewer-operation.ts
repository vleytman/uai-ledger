const pick=(row:Record<string,unknown>,keys:string[])=>Object.fromEntries(keys.filter(key=>Object.hasOwn(row,key)).map(key=>[key,row[key]]));
/** Customer inputs, schemas and provider responses are not administrative viewer data. */
export function viewerRequest(row:Record<string,unknown>){
 return pick(row,['id','operation_id','account_id','component','kind','execution_status','settlement_status','attempt_count','created_at','updated_at','deadline_at','next_retry_at','reason','charged_units','max_units','delivery','audit_identity']);
}
export function viewerAttempt(row:Record<string,unknown>){
 const result=pick(row,['id','request_id','attempt_no','cycle','state','status','outcome','provider_request_id','created_at','started_at','finished_at','submitted_at','completed_at','usage_state','cost_units','charged_units','reason']);
 if(row.variant&&typeof row.variant==='object')result.variant=pick(row.variant as Record<string,unknown>,['model','connection_id','catalog_version_id']);
 return result;
}
export function viewerCost(row:Record<string,unknown>){return pick(row,['id','attempt_id','request_id','connection_id','model','currency','state','exact_amount','rounded_units','entry_type','correction_of','provider_completed_at','amount_units','cost_units','total_units','priced_at','precision','source','payer']);}
