import {describe,it,expect,vi} from 'vitest';
import type {WorkerDependencies} from '../../execution/src/runtime.js';
import {quotaShadowEnabled,shadowAdmission,type ShadowObservation} from '../src/shadow-admission.js';
type Admit=NonNullable<WorkerDependencies['admit']>;
// These callbacks do not inspect provider inputs. Deliberately include a sensitive-looking
// prompt to ensure instrumentation only selects the request ID, never serializes arguments.
const args=[{}, {id:'request-test',input:'private prompt'}, {}, {}, {}] as unknown as Parameters<Admit>;
describe('Shadow admission instrumentation',()=>{
 it('requires an explicit boolean flag on a BullMQ worker',()=>{
  expect(quotaShadowEnabled({})).toBe(false);expect(quotaShadowEnabled({UAI_QUOTA_SHADOW:'true',UAI_WORKER_BACKEND:'bullmq'})).toBe(true);
  expect(()=>quotaShadowEnabled({UAI_QUOTA_SHADOW:'yes',UAI_WORKER_BACKEND:'bullmq'})).toThrow('invalid_quota_shadow');
  expect(()=>quotaShadowEnabled({UAI_QUOTA_SHADOW:'true'})).toThrow('quota_shadow_requires_bullmq');
 });
 it('preserves the real decision and reports disagreement without exposing the input',async()=>{
  const result={allowed:true as const,admission_id:'actual-permit'},admit=vi.fn(async()=>result),report=vi.fn(),preview=vi.fn(async()=>({would_allow:false,reason:'limited'}));
  expect(await shadowAdmission(admit,preview,report)(...args)).toBe(result);
  expect(admit).toHaveBeenCalledTimes(1);expect(preview).toHaveBeenCalledTimes(1);
  expect(report.mock.calls[0]![0]).toMatchObject({event:'quota.shadow',request_id:'request-test',shadow:{decision:'deny',reason:'limited'},actual:{decision:'allow'},matches:false});
  expect(JSON.stringify(report.mock.calls)).not.toContain('private prompt');expect(JSON.stringify(report.mock.calls)).not.toContain('actual-permit');
 });
 it('runs actual admission once after preview failure and does not let reporting break it',async()=>{
  const result={allowed:false as const,reason:'waiting_rate_limit'},admit=vi.fn(async()=>result),samples:ShadowObservation[]=[];
  const observed=shadowAdmission(admit,async()=>{throw new Error('private credential')},sample=>{samples.push(sample);throw new Error('stdout unavailable')});
  expect(await observed(...args)).toBe(result);expect(admit).toHaveBeenCalledTimes(1);
  expect(samples[0]).toMatchObject({shadow:{decision:'unknown',reason:'preview_failed'},actual:{decision:'deny',reason:'waiting_rate_limit'},matches:null});
  expect(JSON.stringify(samples)).not.toContain('private credential');
 });
 it('preserves the exact actual exception and handles asynchronous reporter rejection',async()=>{
  const failure=Object.assign(new Error('private database detail'),{code:'ECONNRESET'}),samples:ShadowObservation[]=[];
  const admit=vi.fn(async()=>{throw failure});
  const wrapped=shadowAdmission(admit,async()=>({would_allow:true}),async sample=>{samples.push(sample);throw new Error('reporting failure')});
  await expect(wrapped(...args)).rejects.toBe(failure);await Promise.resolve();expect(admit).toHaveBeenCalledTimes(1);
  expect(samples[0]).toMatchObject({actual:{decision:'error',reason:'ECONNRESET'},matches:null});expect(JSON.stringify(samples)).not.toContain('private database detail');
 });
 it('bounds preview delay and keeps only one outstanding preview per wrapper',async()=>{
  let release!:(value:{would_allow:true})=>void;
  const gate=new Promise<{would_allow:true}>(resolve=>{release=resolve}),preview=vi.fn(()=>gate),admit=vi.fn(async()=>({allowed:true as const,admission_id:'one'}));
  const samples:ShadowObservation[]=[];
  const wrapped=shadowAdmission(admit,preview,sample=>{samples.push(sample)},{budgetMs:10});
  await wrapped(...args);expect(samples[0]).toMatchObject({shadow:{decision:'unknown',reason:'preview_timeout'},actual:{decision:'allow'}});
  await wrapped(...args);expect(samples[1]).toMatchObject({shadow:{decision:'unknown',reason:'preview_busy'}});expect(preview).toHaveBeenCalledTimes(1);expect(admit).toHaveBeenCalledTimes(2);
  release({would_allow:true});await gate;await Promise.resolve();
  await wrapped(...args);expect(samples[2]).toMatchObject({matches:true});expect(preview).toHaveBeenCalledTimes(2);expect(admit).toHaveBeenCalledTimes(3);
 });

});
