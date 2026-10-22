import { DomainError } from '../../contracts/src/index.js';
import type { BillableItem, NormalizedUsage, UsageConditions } from '../../providers/src/contracts.js';

/** All arithmetic is integer coefficient + decimal scale, never binary floating point. */
export class Decimal {
  constructor(readonly coefficient: bigint, readonly scale: number) {}
  static parse(value: string): Decimal {
    if (typeof value !== 'string' || !/^(0|[1-9]\d*)(\.\d+)?$/.test(value) || value.length > 256) throw new DomainError('invalid_decimal', 'Expected nonnegative decimal string', 422);
    const [whole, fraction = ''] = value.split('.');
    return new Decimal(BigInt(whole + fraction), fraction.length);
  }
  add(other: Decimal) { const s = Math.max(this.scale, other.scale); return new Decimal(this.coefficient * 10n ** BigInt(s-this.scale) + other.coefficient * 10n ** BigInt(s-other.scale), s); }
  multiply(other: Decimal) { return new Decimal(this.coefficient * other.coefficient, this.scale + other.scale); }
  per(unitSize: string) { if (!/^10*$/.test(unitSize)) throw new DomainError('invalid_rate_unit', 'Rate denominator must be a power of ten', 422); return new Decimal(this.coefficient, this.scale + unitSize.length - 1); }
  toString() { const s = this.coefficient.toString().padStart(this.scale + 1, '0'); return this.scale ? `${s.slice(0,-this.scale)}.${s.slice(-this.scale)}`.replace(/\.?0+$/, '') : s; }
  units(rounding: 'half-up' | 'ceil') { if (this.scale <= 9) return this.coefficient * 10n ** BigInt(9-this.scale); const divisor=10n ** BigInt(this.scale-9); const q=this.coefficient/divisor; const r=this.coefficient%divisor; return q + (rounding==='ceil' ? (r>0n ? 1n:0n) : (r*2n>=divisor ? 1n:0n)); }
}
export interface Rate { id: string; dimension: string; unit: string; unit_size: string; amount: string; conditions?: UsageConditions; connection_id?: string; effective_from: string; effective_to?: string | null }
export interface RateCard { id: string; currency: 'USD'; rates: Rate[]; source: string; checked_at: string }
export interface RatingContext { at: string; accepted_at?: string; connection_id?: string; conditions?: UsageConditions }
export interface RatedItem { item: BillableItem; rate_id: string; exact_amount: string }
export type Rating = { state: 'calculated'; rate_card_id: string; currency: 'USD'; exact_amount: string; rounded_units: bigint; items: RatedItem[] } | { state: 'unknown'; reason: string };
const matches=(conditions: UsageConditions = {}, actual: UsageConditions = {})=>Object.entries(conditions).every(([key,value])=>actual[key]===value);
const overlaps=(a: Rate,b: Rate)=>new Date(a.effective_from).getTime() < (b.effective_to ? new Date(b.effective_to).getTime():Infinity) && new Date(b.effective_from).getTime() < (a.effective_to ? new Date(a.effective_to).getTime():Infinity);
export function validateRateCard(card: RateCard): void {
  if(card.currency!=='USD' || !card.source || !Number.isFinite(Date.parse(card.checked_at)) || !card.rates.length) throw new DomainError('invalid_rate_card');
  const ids=new Set<string>();
  for(const r of card.rates) {
    Decimal.parse(r.amount).per(r.unit_size);
    if(ids.has(r.id) || !r.dimension || !r.unit || !Number.isFinite(Date.parse(r.effective_from)) || (r.effective_to && (!Number.isFinite(Date.parse(r.effective_to)) || Date.parse(r.effective_to)<=Date.parse(r.effective_from)))) throw new DomainError('invalid_rate');
    ids.add(r.id);
  }
  for(let i=0;i<card.rates.length;i++) for(let j=i+1;j<card.rates.length;j++) {
    const a=card.rates[i],b=card.rates[j];
    const conditionsCanOverlap=Object.entries(a.conditions??{}).every(([k,v])=>b.conditions?.[k]===undefined || b.conditions[k]===v);
    // Only connection override outranks a general rate. Condition specificity is not implicit priority.
    if(a.dimension===b.dimension && a.unit===b.unit && a.connection_id===b.connection_id && conditionsCanOverlap && overlaps(a,b)) throw new DomainError('ambiguous_rate');
  }
}
export function rateUsage(usage: NormalizedUsage, card: RateCard, context: RatingContext, rounding: 'half-up' | 'ceil' = 'half-up'): Rating {
  if(usage.state==='unknown') return {state:'unknown',reason:usage.reason};
  if(!usage.items.length) return {state:'unknown',reason:'missing_billable_items'};
  validateRateCard(card);
  if(!Number.isFinite(Date.parse(context.at))) throw new DomainError('invalid_rating_time');
  let amount=Decimal.parse('0'); const items: RatedItem[]=[];
  for(const item of usage.items) {
    const applicable=card.rates.filter(r=>r.dimension===item.dimension && r.unit===item.unit && (!r.connection_id || r.connection_id===context.connection_id) && Date.parse(r.effective_from)<=Date.parse(context.at) && (!r.effective_to || Date.parse(context.at)<Date.parse(r.effective_to)) && matches(r.conditions,{...context.conditions,...item.conditions}));
    const overrides=applicable.filter(r=>r.connection_id!==undefined); const choices=overrides.length ? overrides:applicable;
    if(choices.length!==1) return {state:'unknown',reason:choices.length ? 'ambiguous_rate':`missing_rate:${item.dimension}`};
    const rate=choices[0]; const exact=Decimal.parse(item.quantity).multiply(Decimal.parse(rate.amount)).per(rate.unit_size); amount=amount.add(exact); items.push({item,rate_id:rate.id,exact_amount:exact.toString()});
  }
  return {state:'calculated',rate_card_id:card.id,currency:'USD',exact_amount:amount.toString(),rounded_units:amount.units(rounding),items};
}
export const rateMaximum=(usage: NormalizedUsage,card: RateCard,context: RatingContext)=>rateUsage(usage,card,context,'ceil');
export function customerRating(usage: NormalizedUsage, accepted: RateCard, current: RateCard, context: RatingContext): Rating {
  const ceiling=rateUsage(usage,accepted,{...context,at:context.accepted_at??context.at}); const latest=rateUsage(usage,current,context);
  if(ceiling.state==='unknown') return ceiling;
  if(latest.state==='unknown') return latest;
  return latest.rounded_units < ceiling.rounded_units ? latest:ceiling;
}
export {persistObservation,getAttemptUsage,persistCost,type ObservationInput,type CostEntryInput} from './persistence.js';
