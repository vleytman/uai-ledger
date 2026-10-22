import {z} from 'zod';
import {DomainError} from './src/index.js';

const Backoff=z.strictObject({base_ms:z.number().int().min(0).max(60000),multiplier:z.number().min(1).max(10),cap_ms:z.number().int().min(0).max(3600000),jitter_ratio:z.number().min(0).max(1)});
const Recovery=z.strictObject({delays_seconds:z.array(z.number().int().positive().max(86400)).max(7)});
export const ExecutionPolicy=z.strictObject({
 deadline_seconds:z.number().int().positive().max(86400),
 max_attempts:z.number().int().min(1).max(8),
 backoff:Backoff,
 retry_reasons:z.array(z.enum(['transient','defect','auth','quota'])).max(4),
 retry_after_output:z.boolean(),
 recovery:Recovery,
 // Cuts one silent provider call before the request deadline. The cut call's cost stays unknown.
 attempt_timeout_seconds:z.number().int().positive().max(86400).optional(),
 // A cut call may still be billed; retrying without provider idempotency accepts a possible second charge.
 timeout_retry:z.enum(['idempotent_only','accept_duplicate_cost']).optional(),
});
export const ExecutionOverrides=ExecutionPolicy.partial().extend({backoff:Backoff.partial().optional(),recovery:Recovery.partial().optional()});
export type ExecutionPolicy=z.infer<typeof ExecutionPolicy>;
export type ExecutionOverrides=z.infer<typeof ExecutionOverrides>;
export const DEFAULT_EXECUTION:ExecutionPolicy={deadline_seconds:300,max_attempts:4,backoff:{base_ms:1000,multiplier:2,cap_ms:30000,jitter_ratio:0.1},retry_reasons:['transient','defect','auth','quota'],retry_after_output:true,recovery:{delays_seconds:[]}};
export const ExecutionLimits=z.strictObject({max_attempts:z.number().int().min(1).max(8),max_deadline_seconds:z.number().int().min(1).max(86400)});
export type ExecutionLimits=z.infer<typeof ExecutionLimits>;

/** Validate every layer before merging. Explicit arrays replace the inherited list. */
export function resolveExecutionPolicy(profile?:unknown,call?:unknown,limits:ExecutionLimits={max_attempts:8,max_deadline_seconds:86400},defaults:unknown=DEFAULT_EXECUTION):ExecutionPolicy{
 try{
  const ceiling=ExecutionLimits.parse(limits);
  let policy=ExecutionPolicy.parse(defaults);
  for(const layer of [profile,call]){
   if(layer===undefined)continue;
   const value=ExecutionOverrides.parse(layer);
   policy=ExecutionPolicy.parse({...policy,...value,backoff:{...policy.backoff,...value.backoff},recovery:{...policy.recovery,...value.recovery}});
  }
  if(policy.max_attempts>ceiling.max_attempts||policy.deadline_seconds>ceiling.max_deadline_seconds)throw new Error('Execution policy exceeds installation limits');
  if(policy.backoff.cap_ms<policy.backoff.base_ms)throw new Error('Backoff cap must cover base delay');
  if(new Set(policy.retry_reasons).size!==policy.retry_reasons.length)throw new Error('Duplicate retry reason');
  return policy;
 }catch(error){throw new DomainError('invalid_execution_policy',error instanceof Error?error.message:'Invalid execution policy',422);}
}

/** No dispatch at or beyond the accepted deadline. Observation is independent. */
export function nextAttemptAt(policy:ExecutionPolicy,attempts:number,reason:string,now:Date,deadline:Date,retryAfterMs=0,random=0.5):Date|null{
 if(attempts>=policy.max_attempts||attempts>=8||!policy.retry_reasons.includes(reason as ExecutionPolicy['retry_reasons'][number]))return null;
 if(!Number.isFinite(retryAfterMs)||retryAfterMs<0||!Number.isFinite(random)||random<0||random>1)throw new DomainError('invalid_retry_delay');
 const base=Math.min(policy.backoff.cap_ms,policy.backoff.base_ms*policy.backoff.multiplier**Math.max(0,attempts-1));
 const backoff=Math.min(policy.backoff.cap_ms,base*(1+policy.backoff.jitter_ratio*(2*random-1)));
 const recovery=policy.recovery.delays_seconds[Math.max(0,attempts-1)]??0;
 const next=new Date(now.getTime()+Math.ceil(Math.max(retryAfterMs,backoff,recovery*1000)));
 return next<deadline?next:null;
}

export const BillingPolicy=z.strictObject({refused:z.enum(['platform','actual_usage'])});
export const BillingOverrides=BillingPolicy.partial();
export const DEFAULT_BILLING:z.infer<typeof BillingPolicy>={refused:'platform'};
export function resolveBillingPolicy(profile?:unknown,call?:unknown){
 try{return BillingPolicy.parse({...DEFAULT_BILLING,...(profile===undefined?{}:BillingOverrides.parse(profile)),...(call===undefined?{}:BillingOverrides.parse(call))});}
 catch{throw new DomainError('invalid_billing_policy','Invalid refusal billing policy',422);}
}

const Identifier=z.string().min(1).max(256);
const Schema=z.record(z.string(),z.unknown());
const CacheHint=z.strictObject({boundary:z.literal('stable_prefix'),ttl_seconds:z.number().int().positive().max(3600).optional()});
export const Continuation=z.strictObject({provider:Identifier,model:Identifier,thought_signature:z.string().min(1).max(1000000)});
export const ToolCallRecord=z.strictObject({id:Identifier,name:Identifier,arguments:Schema,provider_id:Identifier.optional(),execution_method:z.enum(['native','schema']).optional(),continuation:Continuation.optional()});
export const ContentBlock=z.discriminatedUnion('type',[
 z.strictObject({type:z.literal('text'),text:z.string(),cache:CacheHint.optional()}),
 z.strictObject({type:z.literal('tool_call'),...ToolCallRecord.shape}),
 z.strictObject({type:z.literal('tool_result'),call_id:Identifier,result:z.unknown(),is_error:z.boolean().optional()}),
 z.strictObject({type:z.literal('image'),asset_id:Identifier,detail:z.enum(['auto','low','high']).optional(),cache:CacheHint.optional()}),
]);
export const ToolDefinition=z.strictObject({name:z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),description:z.string().max(16000).optional(),parameters:Schema});
export const ToolChoice=z.discriminatedUnion('type',[
 z.strictObject({type:z.literal('auto')}),z.strictObject({type:z.literal('none')}),z.strictObject({type:z.literal('required')}),z.strictObject({type:z.literal('named'),name:Identifier}),
]);
export const TextFeatures=z.strictObject({tools:z.boolean(),tool_history:z.boolean().optional(),parallel_tools:z.boolean().optional(),schema_streaming:z.boolean().optional(),tool_streaming:z.boolean().optional(),usage_counters:z.array(z.enum(['input','output','reasoning','cache_read'])).optional(),output_limit:z.enum(['required','provider_default']).optional(),max_output_tokens:z.number().int().positive().optional(),max_images:z.number().int().nonnegative().optional(),max_image_bytes:z.number().int().positive().optional(),forced_tool_choice:z.boolean().optional(),schema:z.boolean(),image_media_types:z.array(z.enum(['image/png','image/jpeg','image/webp'])).max(3),image_detail:z.array(z.enum(['auto','low','high'])).max(3),cache:z.enum(['none','automatic','explicit'])});
export const TextInput=z.strictObject({messages:z.array(z.strictObject({role:z.enum(['system','user','assistant']),content:z.array(ContentBlock).min(1).max(128)})).min(1).max(256),instructions:z.string().optional(),tools:z.array(ToolDefinition).min(1).max(64).optional(),tool_choice:ToolChoice.optional(),parallel_tool_calls:z.boolean().optional(),response_schema:Schema.optional()});
export const DeliveryPolicy=z.strictObject({stream:z.boolean().optional(),field_paths:z.array(z.string().regex(/^(?:\/(?:[^~/]|~[01])*)+$/)).max(32).optional()});
export const InvocationResult=z.discriminatedUnion('type',[
 z.strictObject({type:z.literal('text'),text:z.string()}),
 z.strictObject({type:z.literal('structured'),text:z.string(),value:z.unknown()}),
 z.strictObject({type:z.literal('tool_call'),...ToolCallRecord.shape}),
 z.strictObject({type:z.literal('tool_calls'),calls:z.array(ToolCallRecord).min(1).max(64),text:z.string().optional()}),
 z.strictObject({type:z.literal('refused'),reason:z.string()}),
 z.strictObject({type:z.literal('embeddings'),model:z.string(),revision:z.string().nullable(),dimensions:z.number().int().min(1).max(3072),data:z.array(z.strictObject({index:z.number().int().nonnegative(),embedding:z.array(z.number()).min(1).max(3072)})).min(1).max(128)}),
]);
const AttemptEnvelope={request_id:Identifier,attempt_id:Identifier,attempt_number:z.number().int().positive(),generation:z.string().regex(/^\d+$/)};
export const AttemptEvent=z.strictObject({...AttemptEnvelope,type:z.literal('attempt'),sequence:z.number().int().nonnegative().optional(),gap:z.boolean().optional()});
export const DeltaEvent=z.strictObject({...AttemptEnvelope,type:z.literal('delta'),sequence:z.number().int().positive(),field_path:z.string(),text:z.string()});
export const invocationSchemas={ExecutionPolicy,ExecutionOverrides,ExecutionLimits,BillingPolicy,BillingOverrides,Continuation,ToolCallRecord,ContentBlock,ToolDefinition,ToolChoice,TextFeatures,TextInput,DeliveryPolicy,InvocationResult,AttemptEvent,DeltaEvent};
