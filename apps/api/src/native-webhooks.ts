import type {FastifyInstance} from 'fastify';
import type pg from 'pg';
import {DomainError,type Scope} from '../../../packages/contracts/src/index.js';
export type NativeWebhookReceiver=(scope:Scope,requestId:string,body:Uint8Array,headers:Record<string,string>)=>Promise<unknown>;
/** The receiver MUST verify provider signatures before applying any observation. */
export function registerNativeWebhooks(app:FastifyInstance,pool:pg.Pool,receive:NativeWebhookReceiver){
 app.register(async ingress=>{
  // Encapsulated parser preserves signed bytes and does not change normal API JSON.
  ingress.removeContentTypeParser('application/json');
  if(ingress.hasContentTypeParser('application/octet-stream'))ingress.removeContentTypeParser('application/octet-stream');
  ingress.addContentTypeParser(['application/json','application/octet-stream'],{parseAs:'buffer'},(_request,body,done)=>done(null,body));
  ingress.post('/v1/provider-webhooks/:requestId',{bodyLimit:1024*1024},async(request,reply)=>{
   reply.header('Cache-Control','no-store');
   const requestId=(request.params as {requestId:string}).requestId;
   if(!/^[A-Za-z0-9_-]{1,200}$/.test(requestId))return reply.code(404).send({accepted:false});
   const row=(await pool.query('SELECT organization_id,application_id,account_id FROM execution_requests WHERE id=$1',[requestId])).rows[0];
   if(!row)return reply.code(404).send({accepted:false});
   // Reject ambiguous duplicate signature headers instead of silently joining them.
   const headers:Record<string,string>=Object.create(null);
   for(let i=0;i<request.raw.rawHeaders.length;i+=2){const key=request.raw.rawHeaders[i]!.toLowerCase();if(Object.hasOwn(headers,key))return reply.code(400).send({accepted:false});headers[key]=request.raw.rawHeaders[i+1]!;}
   if(!Buffer.isBuffer(request.body))return reply.code(415).send({accepted:false});
   try{await receive(row,requestId,request.body,headers);return {accepted:true}}
   catch(error){
    // Provider/context internals and request state must not be exposed publicly.
    const code=error instanceof DomainError?error.code:'';
    if(['native_webhook_unsupported','native_job_not_found','not_found'].includes(code))return reply.code(404).send({accepted:false});
    if(['invalid_webhook_signature','native_webhook_binding_invalid'].includes(code))return reply.code(401).send({accepted:false});
    return reply.code(503).send({accepted:false});
   }
  });
 });
}
