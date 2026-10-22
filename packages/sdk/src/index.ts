export {AttemptCursor} from './stream.js';
import {AttemptCursor,sseData} from './stream.js';
import { encodeExternalIdentity, parseExternalIdentity, EXTERNAL_IDENTITY_HEADER, EXTERNAL_IDENTITY_VERSION, type ExternalIdentity } from '../../contracts/external-identity.js';
export { EXTERNAL_IDENTITY_HEADER, EXTERNAL_IDENTITY_VERSION, encodeExternalIdentity, decodeExternalIdentity, parseExternalIdentity, type ExternalIdentity, type StaffRole } from '../../contracts/external-identity.js';
import type * as Api from './generated/types.js';
export type {paths,components,operations} from './generated/api.js';
export type * from './generated/types.js';
export type ApiError = Api.ErrorResponse['error'];
export class UaiError extends Error { constructor(public status:number,public error:ApiError){super(error.message)} }
export function isInsufficientCredits(error:unknown):error is UaiError{return error instanceof UaiError&&error.error.code==='insufficient_credits';}
export type RequestResult = Api.RequestResponse;
export type EventEnvelope = Api.EventEnvelope;
export type InvocationStreamEvent=Api.InvocationStreamEvent&{live_incomplete?:boolean};
export interface RunOptions {key:string;signal?:AbortSignal;persist?:(result:RequestResult)=>Promise<void>;onAccepted?:(ids:Api.InvocationResponse)=>Promise<void>;onAttempt?:(event:Api.AttemptEvent)=>Promise<void>;onDelta?:(event:Api.DeltaEvent&{live_incomplete?:boolean})=>Promise<void>}

export interface ClientOptions {baseUrl:string;token:string;fetch?:typeof fetch;pollIntervalMs?:number;readonly identity?:ExternalIdentity}
const terminal=new Set(['succeeded','failed','canceled','refused']);
export class UaiClient {
 private fetcher:typeof fetch;
 private readonly options:Readonly<ClientOptions>;
 private readonly identityHeader?:string;
 readonly identity?:ExternalIdentity;
 constructor(options:ClientOptions){
  this.identity=options.identity===undefined?undefined:parseExternalIdentity(options.identity);
  this.identityHeader=this.identity===undefined?undefined:encodeExternalIdentity(this.identity);
  this.options=Object.freeze({...options,identity:this.identity});
  this.fetcher=options.fetch??fetch;
 }
 forIdentity(identity:ExternalIdentity):UaiClient {return new UaiClient({...this.options,identity});}
 private headers(extra:Record<string,string>={}):Record<string,string>{
  return {authorization:`Bearer ${this.options.token}`,...(this.identityHeader===undefined?{}:{[EXTERNAL_IDENTITY_HEADER]:this.identityHeader}),...extra};
 }
 /** Call during host startup before enabling external authentication. Unknown versions fail closed. */
 async assertExternalIdentitySupport():Promise<void>{
  const result=await this.request<{capabilities?:{external_identity?:unknown}}>('GET','/health');
  if(result?.capabilities?.external_identity!==EXTERNAL_IDENTITY_VERSION) throw new Error('UAI API does not support external identity version 1');
 }
 async request<T=Record<string,unknown>>(method:string,path:string,body?:unknown,options:{key?:string;signal?:AbortSignal;revision?:number}={}):Promise<T>{
  const key=options.key??(method==='POST'?crypto.randomUUID():undefined);
  const headers=this.headers();if(body!==undefined)headers['content-type']='application/json';if(key)headers['idempotency-key']=key;if(options.revision!==undefined)headers['if-match']=String(options.revision);
  const encoded=body===undefined?undefined:JSON.stringify(body);
  // Reuse exactly the same identity and bytes on transport failure. A new financial command is never invented.
  for(let attempt=0;;attempt++){
   let response:Response;
   try{response=await this.fetcher(this.options.baseUrl.replace(/\/$/,'')+path,{method,headers,body:encoded,signal:options.signal})}
   catch(error){if(options.signal?.aborted||attempt>=1)throw error;continue;}
   const data=await response.json();if(!response.ok)throw new UaiError(response.status,data.error??{code:'invalid_response',message:'API request failed',retryable:false});return data;
  }
 }
 readonly assets={
  renew:(id:string,key:string)=>this.request<Api.AssetResponse>('POST',`/v1/assets/${encodeURIComponent(id)}/renew`,{},{key}),
  get:(id:string)=>this.request<Api.AssetResponse>('GET',`/v1/assets/${encodeURIComponent(id)}`),
  createUpload:(body:Api.UploadBody,key:string)=>this.request<Api.UploadResponse>('POST','/v1/assets/uploads',body,{key}),
  uploadBytes:async(id:string,bytes:Uint8Array):Promise<Api.UploadProgressResponse>=>{
   const response=await this.fetcher(this.options.baseUrl.replace(/\/$/,'')+`/v1/assets/${encodeURIComponent(id)}/upload`,{method:'PUT',headers:this.headers({'content-type':'application/octet-stream'}),body:new Blob([Uint8Array.from(bytes)])});
   const data=await response.json();if(!response.ok)throw new UaiError(response.status,data.error);return data;
  },
  completeUpload:(id:string,key:string)=>this.request<Api.AssetResponse>('POST',`/v1/assets/${encodeURIComponent(id)}/complete`,{},{key}),
  upload:async(body:Api.UploadBody,bytes:Uint8Array,key:string):Promise<Api.AssetResponse>=>{
   const pending=await this.assets.createUpload(body,key);await this.assets.uploadBytes(pending.asset_id,bytes);return this.assets.completeUpload(pending.asset_id,key);
  },
  reupload:async(id:string,accountId:string,key:string):Promise<Api.AssetResponse>=>{
   const asset=await this.assets.get(id);const bytes=await this.assets.download(id);
   return this.assets.upload({account_id:accountId,media_type:asset.media_type as Api.MediaType,size_bytes:bytes.byteLength,content_hash:asset.content_hash},bytes,key);
  },
  download:async(id:string)=>{
  const response=await this.fetcher(this.options.baseUrl.replace(/\/$/,'')+`/v1/assets/${encodeURIComponent(id)}/content`,{headers:this.headers()});
  if(!response.ok)throw new UaiError(response.status,(await response.json()).error);
  return new Uint8Array(await response.arrayBuffer());
 }};
 readonly accounts={
  create:(body:Api.AccountBody,key:string)=>this.request<Api.AccountResponse>('POST','/v1/accounts',body,{key}),
  suspend:(id:string,body:Api.SpendingBody,key:string)=>this.request<Api.SpendingResponse>('POST',`/v1/accounts/${encodeURIComponent(id)}/spending/suspend`,body,{key}),
  resume:(id:string,body:Api.SpendingBody,key:string)=>this.request<Api.SpendingResponse>('POST',`/v1/accounts/${encodeURIComponent(id)}/spending/resume`,body,{key}),
 };
 readonly wallets={
  subscribe:(id:string,options:{signal?:AbortSignal}={})=>this.subscribeWallet(id,options),
  get:(id:string)=>this.request<Api.Wallet>('GET',`/v1/wallets/${encodeURIComponent(id)}`),
  lots:(id:string)=>this.request<Api.LotsResponse>('GET',`/v1/wallets/${encodeURIComponent(id)}/lots`),
  transactions:(id:string,query:{limit?:number;cursor?:string}={})=>{const params=new URLSearchParams();if(query.limit!==undefined)params.set('limit',String(query.limit));if(query.cursor)params.set('cursor',query.cursor);return this.request<Api.JournalResponse>('GET',`/v1/wallets/${encodeURIComponent(id)}/transactions?${params}`)},
  grant:(id:string,body:Api.GrantBody,key:string)=>this.request<Api.GrantResponse>('POST',`/v1/wallets/${encodeURIComponent(id)}/grants`,body,{key}),
  refund:(id:string,body:Api.RefundBody,key:string)=>this.request<Api.RefundResponse>('POST',`/v1/wallets/${encodeURIComponent(id)}/refunds`,body,{key}),
  prepareRevocation:(id:string,body:Api.RevocationBody,key:string)=>this.request<Api.RevocationResponse>('POST',`/v1/wallets/${encodeURIComponent(id)}/grant-revocations`,body,{key}),
 };
 readonly revocations={
  commit:(id:string,body:Api.ReasonBody,key:string)=>this.request<Api.RevocationResponse>('POST',`/v1/grant-revocations/${encodeURIComponent(id)}/commit`,body,{key}),
  cancel:(id:string,body:Api.ReasonBody,key:string)=>this.request<Api.RevocationResponse>('POST',`/v1/grant-revocations/${encodeURIComponent(id)}/cancel`,body,{key}),
 };
 readonly quotes={create:(body:Api.QuoteBody,key:string)=>this.request<Api.QuoteResponse>('POST','/v1/quotes',body,{key}),get:(id:string)=>this.request<Api.QuoteResponse>('GET',`/v1/quotes/${encodeURIComponent(id)}`)};
 readonly operations={
  create:(body:Api.AcceptOperationBody,key:string)=>this.request<Api.OperationResponse>('POST','/v1/operations',body,{key}),
  get:(id:string)=>this.request<Api.OperationResponse>('GET',`/v1/operations/${encodeURIComponent(id)}`),
  amend:(id:string,body:Api.AmendOperationBody,key:string)=>this.request<Api.OperationResponse>('POST',`/v1/operations/${encodeURIComponent(id)}/amend`,body,{key}),
  complete:(id:string,key:string)=>this.request<Api.OperationResponse>('POST',`/v1/operations/${encodeURIComponent(id)}/complete`,{}, {key}),
  cancel:(id:string,key:string)=>this.request<Api.OperationResponse>('POST',`/v1/operations/${encodeURIComponent(id)}/cancel`,{}, {key}),
  finishPartial:(id:string,key:string)=>this.request<Api.OperationResponse>('POST',`/v1/operations/${encodeURIComponent(id)}/finish-partial`,{}, {key}),
  createRequest:(id:string,body:Api.RequestBody,key:string)=>this.request<Api.RequestAcceptedResponse>('POST',`/v1/operations/${encodeURIComponent(id)}/requests`,body,{key}),
 };
 readonly requests={get:(id:string)=>this.request<RequestResult>('GET',`/v1/requests/${encodeURIComponent(id)}`),cancel:(id:string,key:string)=>this.request<Api.CancelRequestResponse>('POST',`/v1/requests/${encodeURIComponent(id)}/cancel`,{}, {key}),acknowledge:(id:string,body:Api.AcknowledgeBody,key:string)=>this.request<Api.AcknowledgeResponse>('POST',`/v1/requests/${encodeURIComponent(id)}/acknowledge`,body,{key})};
 readonly content={delete:(body:Api.DeleteContentBody,key:string)=>this.request<Api.DeletionAcceptedResponse>('POST','/v1/content-deletions',body,{key})};
 readonly services={quote:(body:Api.QuoteBody,key:string)=>this.quotes.create({...body,capability:'api.call'},key),run:(body:Api.QuoteBody,options:Parameters<UaiClient['ai']['run']>[1])=>this.ai.run({...body,capability:'api.call'},options)};
 readonly admin={creditSummary:(query:Api.AdminCreditSummaryQuery={})=>{const params=new URLSearchParams();for(const [key,value] of Object.entries(query))if(value)params.set(key,value);return this.request<Api.CreditSummaryResponse>('GET',`/v1/admin/credit-summary?${params}`)}};
 readonly allowance={get:(subscriptionId:string)=>this.request<Api.AllowanceState>('GET',`/v1/admin/provider-subscriptions/${encodeURIComponent(subscriptionId)}/allowance`),createAccount:(body:Api.ProviderAccountCreate,key:string)=>this.request<Api.AllowanceReceipt>('POST','/v1/admin/provider-accounts',body,{key}),createSubscription:(body:Api.SubscriptionCreate,key:string)=>this.request<Api.AllowanceReceipt>('POST','/v1/admin/provider-subscriptions',body,{key}),bind:(connectionId:string,body:Api.ConnectionBinding,revision:number,key:string)=>this.request<Api.AllowanceReceipt>('PUT',`/v1/admin/connections/${encodeURIComponent(connectionId)}/provider-account`,body,{key,revision}),snapshot:(body:Api.ProviderSnapshot,key:string)=>this.request<Api.AllowanceReceipt>('POST','/v1/admin/allowance-snapshots',body,{key}),adjust:(body:Api.AllowanceAdjustment,key:string)=>this.request<Api.AllowanceReceipt>('POST','/v1/admin/allowance-adjustments',body,{key})};
 readonly ai={forecast:(body:Api.ForecastBody)=>this.request<Api.ForecastResponse>('POST','/v1/forecasts',body),quote:(body:Api.QuoteBody,key:string)=>this.quotes.create(body,key),stream:(body:Api.QuoteBody,options:{key:string;signal?:AbortSignal})=>this.invocationStream(body,options),resumeStream:(requestId:string,options:{signal?:AbortSignal}={})=>this.invocationStream(undefined,{...options,requestId}),run:async(body:Api.QuoteBody,options:RunOptions)=>{
  for await(const event of this.invocationStream(body,options)){
   if(event.type==='accepted')await options.onAccepted?.(event);
   if(event.type==='attempt')await options.onAttempt?.(event);
   if(event.type==='delta')await options.onDelta?.(event);
   if(event.type==='result')return this.finishResult(event.result,options.persist,event.live_incomplete);
  }
  throw new Error('Invocation stream stopped before result; resume using the accepted request ID');
 }};
 private async finishResult(result:RequestResult,persist?:RunOptions['persist'],live_incomplete=false){
  const acknowledge=async()=>{if(!result.delivery||!result.result)throw new Error('No available result to acknowledge');return this.requests.acknowledge(result.id,{result_version:result.delivery.result_version,manifest_hash:result.delivery.manifest_hash},`ack:${result.id}:${result.delivery.result_version}`)};
  if(result.result&&persist){await persist(result);await acknowledge();}
  return {...result,live_incomplete,acknowledge};
 }
 private async *invocationStream(body:Api.QuoteBody|undefined,options:{key?:string;requestId?:string;signal?:AbortSignal}):AsyncGenerator<InvocationStreamEvent>{
  let requestId=options.requestId;const cursor=new AttemptCursor();
  while(!options.signal?.aborted){
   const path=requestId?`/v1/requests/${encodeURIComponent(requestId)}/stream`:'/v1/invocations/stream';
   const headers=this.headers({accept:'text/event-stream',...(!requestId?{'content-type':'application/json','idempotency-key':options.key!}:{})});
   let response:Response;
   try{response=await this.fetcher(this.options.baseUrl.replace(/\/$/,'')+path,{method:requestId?'GET':'POST',headers,...(!requestId?{body:JSON.stringify(body)}:{}),signal:options.signal});}
   catch(error){if(options.signal?.aborted)throw error;cursor.incomplete=true;await new Promise(resolve=>setTimeout(resolve,this.options.pollIntervalMs??250));continue;}
   if(!response.ok){const data=await response.json();throw new UaiError(response.status,data.error);}
   try{
    for await(const raw of sseData(response)){
     const event=raw as Api.InvocationStreamEvent;
     if(event.type==='accepted'){requestId=event.request_id;yield event;continue;}
     if(event.request_id!==requestId)continue;
     if(event.type==='result'){yield {...event,live_incomplete:cursor.incomplete};return;}
     if(event.type==='attempt'||event.type==='delta')for(const accepted of cursor.accept(event))yield {...accepted,live_incomplete:cursor.incomplete};
    }
   }catch(error){if(options.signal?.aborted)throw error;}
   cursor.incomplete=true;
   await new Promise(resolve=>setTimeout(resolve,this.options.pollIntervalMs??250));
  }
 }
 async resume(requestId:string,options:{signal?:AbortSignal;persist?:(result:RequestResult)=>Promise<void>}={}){
  while(true){
   options.signal?.throwIfAborted();
   const result=await this.requests.get(requestId);
   if(terminal.has(result.execution_status)||result.execution_status==='outcome_unknown'){
    return this.finishResult(result,options.persist);
   }
   await new Promise(resolve=>setTimeout(resolve,this.options.pollIntervalMs??500));
  }
 }
 private async *subscribeWallet(walletId:string,options:{signal?:AbortSignal}={}):AsyncGenerator<Api.Wallet>{
  let revision=-1,lastEventId:string|undefined;
  while(!options.signal?.aborted){
   const controller=new AbortController(),signal=options.signal?AbortSignal.any([options.signal,controller.signal]):controller.signal;
   const events=this.events({wallet_id:walletId,lastEventId,signal});
   let next=events.next();void next.catch(()=>{});
   try{
    const snapshot=await this.wallets.get(walletId);if(snapshot.revision>revision){revision=snapshot.revision;yield snapshot;}
    while(!signal.aborted){
     const item=await next;if(item.done)break;lastEventId=item.value.id;
     const value=item.value.data as unknown as Api.Wallet;
     if(item.value.type==='wallet.updated'&&value.id===walletId&&typeof value.revision==='number'&&value.revision>revision){revision=value.revision;yield value;}
     next=events.next();void next.catch(()=>{});
    }
   }catch(error){if(options.signal?.aborted)return;if(error instanceof UaiError&&error.error.code!=='event_cursor_expired')throw error;lastEventId=undefined;}
   finally{controller.abort();await events.return(undefined).catch(()=>{});}
   await new Promise(resolve=>setTimeout(resolve,this.options.pollIntervalMs??250));
  }
 }
 async *events(options:{account_id?:string;operation_id?:string;wallet_id?:string;lastEventId?:string;signal?:AbortSignal}={}):AsyncGenerator<EventEnvelope>{
  const query=new URLSearchParams();for(const key of ['account_id','operation_id','wallet_id'] as const)if(options[key])query.set(key,options[key]!);
  const headers=this.headers({accept:'text/event-stream'});if(options.lastEventId)headers['last-event-id']=options.lastEventId;
  const response=await this.fetcher(this.options.baseUrl.replace(/\/$/,'')+`/v1/events?${query}`,{headers,signal:options.signal});
  if(!response.ok)throw new UaiError(response.status,(await response.json()).error);if(!response.body)throw new Error('Missing SSE stream');
  const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
  try{while(true){const chunk=await reader.read();if(chunk.done)break;buffer+=decoder.decode(chunk.value,{stream:true}).replace(/\r\n/g,'\n');let boundary:number;while((boundary=buffer.indexOf('\n\n'))>=0){const block=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2);const data=block.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');if(data)yield JSON.parse(data);}}}
  catch(error){if(!options.signal?.aborted)throw error;}
  finally{try{await reader.cancel()}catch(error){if(!options.signal?.aborted)throw error}finally{reader.releaseLock()}}
 }
}
export {jev,serviceJson} from './jev.js';
export type {JevInput,JevQuestions,JevQuestion,JevResult,JevAnswer,JevContent,JsonValue} from './jev.js';
