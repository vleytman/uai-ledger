import { createHash, randomUUID } from 'node:crypto';
export type Units = string;
export interface Scope { organization_id: string; application_id: string; account_id: string }
export interface Clock { now(): Date }
export const systemClock: Clock = { now: () => new Date() };
export class ManualClock implements Clock {
  constructor(private value: Date) {}
  now() { return new Date(this.value); }
  advance(ms: number) { this.value = new Date(this.value.getTime() + ms); }
}
export class DomainError extends Error {
  constructor(public code: string, message: string = code, public status = 409, public details: Record<string, unknown> = {}) { super(message); }
}
export const id = (prefix: string) => `${prefix}_${randomUUID()}`;
export function units(value: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new DomainError('invalid_input', 'Expected unsigned integer string', 422);
  const result = BigInt(value);
  if (result > 9223372036854775807n) throw new DomainError('invalid_input', 'Amount exceeds bigint', 422);
  return result;
}
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}
export const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export const CREDIT_UNIT = 'ai-credit-usd-v1';
export const UNITS_PER_CREDIT = 1000000n;
export type ExecutionStatus = 'accepted'|'queued'|'leased'|'submitting'|'running'|'waiting_retry'|'waiting_recovery'|'outcome_unknown'|'succeeded'|'completed'|'partial'|'failed'|'canceled'|'refused'|'paused';
export type SettlementStatus = 'open'|'pending'|'unresolved'|'settled'|'platform_absorbed';
export interface WalletSnapshot { id: string; revision: number; balance_units: Units; available_units: Units; reserved_units: Units }
/** Immutable observation at an admission refusal, not a live provider balance. */
export interface QuotaWaitDetails {
 group_id:string;group_name:string;rule:string;metric:string;window_ms:number|null;
 demand:string;available:string|null;capacity:string;checked_at:string;
}
