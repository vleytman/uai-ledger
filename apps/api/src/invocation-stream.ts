import {getAttemptUsage,Decimal} from '../../../packages/pricing/src/index.js';
import type {Tx} from '../../../packages/db/src/index.js';
import type {FastifyInstance,FastifyRequest,FastifyReply} from 'fastify';
import type {ServerResponse} from 'node:http';
import type pg from 'pg';
import {apiSchemas} from '../../../packages/contracts/api.js';
import {DomainError,type Clock,type Scope} from '../../../packages/contracts/src/index.js';
import {requireScopes,accountScope} from '../../../packages/auth/src/index.js';
import {getRequest} from '../../../packages/execution/src/index.js';
import {getDelivery,assertContentAllowed} from '../../../packages/storage/src/index.js';
import {invoke} from '../../../packages/quoting/src/index.js';
import {authenticateRequest,requestTransaction} from './request-principal.js';
import type {TransientHub} from './transient-hub.js';
const terminal=new Set(['succeeded','failed','canceled','refused','outcome_unknown']);
export async function requestSnapshot(pool:Tx,scope:Scope,clock:Clock,id:string){
 const request=await getRequest(pool,scope,id),delivery=await getDelivery(pool,scope,clock,id);
 const attempts=(await pool.query(`SELECT a.id,a.number,a.validation_error,a.variant->>'model' model,c.provider,a.charged_units::text,a.cost_units::text,a.submission_intent_at,a.provider_first_delta_at FROM execution_attempts a LEFT JOIN provider_connections c ON c.id=a.variant->>'connection_id' WHERE a.request_id=$1 ORDER BY a.number`,[id])).rows;
 const usage=[];for(const attempt of attempts)usage.push({attempt_id:attempt.id,attempt_number:attempt.number,validation_error:attempt.validation_error,model:attempt.model,provider:attempt.provider,charged_units:attempt.charged_units,provider_cost_units:attempt.cost_units,usage:await getAttemptUsage(pool,scope,attempt.id)});
 const totals=new Map<string,any>();for(const attempt of usage)if(attempt.usage.state==='known')for(const item of attempt.usage.items){const key=JSON.stringify([item.dimension,item.unit,item.conditions??{}]),existing=totals.get(key);totals.set(key,{...item,quantity:Decimal.parse(existing?.quantity??'0').add(Decimal.parse(item.quantity)).toString()});}
 const known=usage.length>0&&usage.every(attempt=>attempt.usage.state==='known');
 const summary={scope:'all_attempts' as const,...(known?{state:'known',items:[...totals.values()]}:{state:'unknown',reason:'incomplete_attempt_usage',partial_items:[...totals.values()]})};
 const timings={received:request.received_at,accepted:request.accepted_at,enqueued:request.enqueued_at,dispatched:attempts[0]?.submission_intent_at??null,provider_first_delta:attempts.find(a=>a.provider_first_delta_at)?.provider_first_delta_at??null,api_first_delta:request.api_first_delta_at};

 return {execution:request.route.execution,billing:request.route.billing,remaining_attempts:terminal.has(request.execution_status)?0:Math.max(0,(request.route.execution?.max_attempts??4)-request.attempt_count),usage:{attempts:usage,summary},timings,id:request.id,operation_id:request.operation_id,execution_status:request.execution_status,settlement_status:request.settlement_status,attempt_count:request.attempt_count,reason:request.reason,deadline_at:request.deadline_at,next_retry_at:request.not_before,result:delivery?.result??null,delivery:delivery?{result_version:delivery.version,manifest_hash:delivery.manifest_hash,status:delivery.status,ready_at:delivery.ready_at,content_expires_at:delivery.content_expires_at}:null};
}
export function registerInvocationStreams(app:FastifyInstance,pool:pg.Pool,clock:Clock,hub:TransientHub,streams:Set<ServerResponse>){
 async function stream(request:FastifyRequest,reply:FastifyReply,reconnect:boolean){
  const receivedAt=clock.now();
  const principal=await authenticateRequest(pool,request,{audit:false});requireScopes(principal,...(reconnect?['ai:read']:['ai:read','ai:quote','ai:execute']));
  const body=reconnect?undefined:apiSchemas.QuoteBody.parse(request.body);
  let requestId=reconnect?apiSchemas.Identifier.parse((request.params as any).id):undefined;
  let accountId=body?.account_id;
  if(requestId){const row=(await pool.query('SELECT account_id FROM execution_requests WHERE id=$1 AND organization_id=$2 AND application_id=$3',[requestId,principal.organization_id,principal.application_id])).rows[0];if(!row)throw new DomainError('not_found','Request not found',404);accountId=row.account_id;}
  const scope=await accountScope(pool,principal,accountId!);
  await hub.start();
  let closed=false,ended=false,opened=false,order=0,sequence=0,generation='0',currentAttempt='';
  let serial=Promise.resolve(),terminalObservedAt:number|undefined;
  const enqueue=(fn:()=>Promise<void>)=>{serial=serial.then(async()=>{if(!closed&&!ended)await fn()}).catch(()=>close());return serial;};
  let timer:ReturnType<typeof setInterval>|undefined,heartbeat:ReturnType<typeof setInterval>|undefined;
  const close=()=>{if(closed)return;closed=true;subscription.close();if(timer)clearInterval(timer);if(heartbeat)clearInterval(heartbeat);streams.delete(reply.raw);if(opened)reply.raw.end();};
  const write=(event:unknown)=>{if(closed||ended)return false;if(!reply.raw.write(`data: ${JSON.stringify(event)}\n\n`)){close();return false;}return true;};
  const authorize=async()=>{const fresh=await authenticateRequest(pool,request,{audit:false});requireScopes(fresh,'ai:read');if(fresh.id!==principal.id)throw new Error('identity_changed');await accountScope(pool,fresh,scope.account_id);};
  const subscription=hub.subscribe(event=>event.organization_id===scope.organization_id&&event.application_id===scope.application_id&&event.account_id===scope.account_id&&(!requestId||event.request_id===requestId),event=>enqueue(async()=>{
   if(event.request_id!==requestId)return;
   const {organization_id,application_id,account_id,...payload}=event;
   await authorize();const current=await getRequest(pool,scope,requestId!);
   if((terminal.has(current.execution_status)&&current.execution_status!=='succeeded')||String(current.fencing_token)!==String(event.generation)||current.cancel_requested_at)return;
   await assertContentAllowed(pool,scope,current);
   const delivery=await getDelivery(pool,scope,clock,requestId!);if(delivery&&delivery.status!=='available')return;
   if(event.attempt_number<order||event.attempt_number===order&&BigInt(event.generation)<BigInt(generation))return;
   if(event.type==='attempt'){
    const value=apiSchemas.AttemptEvent.parse(payload);
    if(value.attempt_number===order&&value.generation===generation)return;
    order=value.attempt_number;generation=value.generation;currentAttempt=value.attempt_id;sequence=0;write(value);return;
   }
   if(event.type!=='delta')return;
   const value=apiSchemas.DeltaEvent.parse(payload);
   if(value.attempt_number>order||value.generation!==generation){order=value.attempt_number;generation=value.generation;currentAttempt=value.attempt_id;sequence=0;write({type:'attempt',request_id:requestId,attempt_id:currentAttempt,attempt_number:order,generation,gap:true});}
   if(value.attempt_id!==currentAttempt||value.sequence<=sequence)return;
   sequence=value.sequence;
   await pool.query('UPDATE execution_requests SET api_first_delta_at=COALESCE(api_first_delta_at,$2) WHERE id=$1',[requestId,clock.now()]);
   write(value);
  }),close,true);
  const snapshot=async(initial=false)=>{
   await authorize();const result=await requestSnapshot(pool,scope,clock,requestId!);
   if(terminal.has(result.execution_status)){
    // NOTIFY consumption can lag the transaction that finishes the request.
    // Drain committed deltas before closing, or reconnect to mark a lost tail.
    if(!reconnect){
     const last=(await pool.query('SELECT id,delta_sequence FROM execution_attempts WHERE request_id=$1 ORDER BY number DESC LIMIT 1',[requestId])).rows[0];
     if(last&&Number(last.delta_sequence)>0&&(last.id!==currentAttempt||Number(last.delta_sequence)>sequence)){
      terminalObservedAt??=Date.now();
      if(Date.now()-terminalObservedAt>=1000)close();
      return;
     }
    }
    write({type:'result',request_id:requestId,result});ended=true;close();return;
   }
   if(initial&&reconnect){
    const attempt=(await pool.query('SELECT a.id,a.number,a.delta_sequence::text,r.fencing_token::text FROM execution_attempts a JOIN execution_requests r ON r.id=a.request_id WHERE r.id=$1 ORDER BY a.number DESC LIMIT 1',[requestId])).rows[0];
    if(attempt){order=attempt.number;generation=attempt.fencing_token;currentAttempt=attempt.id;sequence=Number(attempt.delta_sequence);write({type:'attempt',request_id:requestId,attempt_id:currentAttempt,attempt_number:order,generation,sequence,gap:sequence>0});}
   }
  };
  try{
   let accepted;
   if(body){accepted=await requestTransaction(pool,request,async tx=>{const p=await authenticateRequest(tx,request);requireScopes(p,'ai:quote','ai:execute','ai:read');const scope=await accountScope(tx,p,body.account_id);const accepted=await invoke(tx,scope,clock,{...body,kind:'single_call',capability:body.capability??(body.kind&&!['single_call','recipe','pool'].includes(body.kind)?body.kind as Exclude<typeof body.kind,'single_call'|'recipe'|'pool'>:undefined),idempotency_key:apiSchemas.IdempotencyKey.parse(request.headers['idempotency-key'])});await tx.query('UPDATE execution_requests SET received_at=COALESCE(received_at,$2),accepted_at=COALESCE(accepted_at,$3) WHERE id=$1',[accepted.request_id,receivedAt,clock.now()]);return accepted;});requestId=accepted.request_id;}
   if(closed)return reply.code(503).send({error:{code:'stream_unavailable',message:'Read the request using the same invocation key',retryable:true}});
   reply.hijack();opened=true;streams.add(reply.raw);reply.raw.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});
   reply.raw.on('close',close);
   if(accepted)write({type:'accepted',...accepted});
   if(reconnect)await enqueue(()=>snapshot(true));
   subscription.resume();
   if(!reconnect)await enqueue(()=>snapshot());
   if(!closed){let polling=false;timer=setInterval(()=>{if(polling)return;polling=true;void enqueue(()=>snapshot()).finally(()=>{polling=false})},250);heartbeat=setInterval(()=>{if(!closed&&!reply.raw.write(': heartbeat\n\n'))close()},15000);}
  }catch(error){close();if(!opened)throw error;}
 }
 app.post('/v1/invocations/stream',(request,reply)=>stream(request,reply,false));
 app.get('/v1/requests/:id/stream',(request,reply)=>stream(request,reply,true));
}
