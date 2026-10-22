import {describe,it,expect} from 'vitest';
import {DEFAULT_EXECUTION,resolveExecutionPolicy,resolveBillingPolicy,nextAttemptAt,TextInput} from './invocation.js';

describe('UI-A01 execution conditions',()=>{
 it('resolves omitted, empty and explicit defaults identically',()=>{
  expect(resolveExecutionPolicy()).toEqual(resolveExecutionPolicy({},{}));
  expect(resolveExecutionPolicy(undefined,DEFAULT_EXECUTION)).toEqual(resolveExecutionPolicy());
 });
 it('merges known nested fields and replaces lists without mutating defaults',()=>{
  const policy=resolveExecutionPolicy({backoff:{base_ms:2000},retry_reasons:['defect']},{backoff:{cap_ms:5000},retry_reasons:['transient']});
  expect(policy.backoff).toEqual({base_ms:2000,multiplier:2,cap_ms:5000,jitter_ratio:0.1});
  expect(policy.retry_reasons).toEqual(['transient']);
  expect(DEFAULT_EXECUTION.backoff.base_ms).toBe(1000);
 });
 it.each([null,{max_attempts:0},{max_attempts:9},{deadline_seconds:-1},{backoff:{base_ms:null}},{unknown:true},{recovery:{delays_seconds:null}},{backoff:{cap_ms:10}}])('rejects invalid override %j',value=>expect(()=>resolveExecutionPolicy(undefined,value)).toThrow());
 it('rejects exceeding operative limits instead of clamping',()=>expect(()=>resolveExecutionPolicy(undefined,{max_attempts:4},{max_attempts:3,max_deadline_seconds:300})).toThrow());
 it('uses platform refusal billing unless explicitly overridden',()=>{
  expect(resolveBillingPolicy()).toEqual({refused:'platform'});
  expect(resolveBillingPolicy(undefined,{refused:'actual_usage'})).toEqual({refused:'actual_usage'});
  expect(()=>resolveBillingPolicy(null)).toThrow();
 });
});
describe('UI-A02/UI-A03 bounded retry decisions',()=>{
 const now=new Date('2026-09-25T00:00:00Z'),deadline=new Date(now.getTime()+300000);
 it('counts all attempts and respects no-retry mode',()=>{
  expect(nextAttemptAt(resolveExecutionPolicy(),4,'transient',now,deadline)).toBeNull();
  expect(nextAttemptAt(resolveExecutionPolicy(undefined,{max_attempts:1}),1,'defect',now,deadline)).toBeNull();
 });
 it('never repeats unknown, refusal or cancellation',()=>{
  for(const reason of ['unknown','refused','canceled'])expect(nextAttemptAt(resolveExecutionPolicy(),1,reason,now,deadline)).toBeNull();
 });
 it('honors Retry-After and disallows sending at deadline',()=>{
  expect(nextAttemptAt(resolveExecutionPolicy(),1,'transient',now,deadline,5000)?.getTime()).toBe(now.getTime()+5000);
  expect(nextAttemptAt(resolveExecutionPolicy(),1,'transient',now,deadline,300000)).toBeNull();
 });
 it('supports bounded recovery in the same attempt budget',()=>{
  const policy=resolveExecutionPolicy(undefined,{recovery:{delays_seconds:[60]}});
  expect(nextAttemptAt(policy,1,'transient',now,deadline)?.getTime()).toBe(now.getTime()+60000);
  expect(nextAttemptAt(policy,4,'transient',now,deadline)).toBeNull();
 });
});
it('preserves multimodal message block order',()=>{
 const input={messages:[{role:'user',content:[{type:'text',text:'Before'},{type:'image',asset_id:'asset_1'},{type:'text',text:'After'}]}]};
 expect(TextInput.parse(input)).toEqual(input);
});
