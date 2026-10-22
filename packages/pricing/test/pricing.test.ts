import { describe,it,expect } from 'vitest';
import {Decimal,rateUsage,rateMaximum,validateRateCard,customerRating,type RateCard} from '../src/index.js';
import type { NormalizedUsage } from '../../providers/src/contracts.js';
const card:RateCard={id:'synthetic-fixture',currency:'USD',source:'synthetic test, not provider prices',checked_at:'2026-09-18T00:00:00Z',rates:[{id:'text',dimension:'output.text',unit:'tokens',unit_size:'1000000',amount:'0.00049',effective_from:'2026-01-01T00:00:00Z'}]};
const context={at:'2026-09-18T00:00:00Z'};
const usage=(quantity:string):NormalizedUsage=>({state:'known',items:[{dimension:'output.text',quantity,unit:'tokens'}]});
describe('exact decimal rating',()=>{
  it('rounds once per attempt and preserves item precision',()=>{const result=rateUsage({state:'known',items:[...((usage('1') as any).items),...((usage('1') as any).items)]},card,context);expect(result).toMatchObject({state:'calculated',exact_amount:'0.00000000098',rounded_units:1n,items:[{exact_amount:'0.00000000049'},{exact_amount:'0.00000000049'}]});});
  it('half-up versus maximum ceil',()=>{expect(rateUsage(usage('1'),card,context)).toMatchObject({rounded_units:0n});expect(rateMaximum(usage('1'),card,context)).toMatchObject({rounded_units:1n});expect(Decimal.parse('0.0000000005').units('half-up')).toBe(1n);});
  it('preserves values above Number.MAX_SAFE_INTEGER',()=>expect(Decimal.parse('9007199254740993.000000001').units('half-up')).toBe(9007199254740993000000001n));
  it('unknown usage and empty records never become zero',()=>{expect(rateUsage({state:'unknown',reason:'missing'},card,context)).toEqual({state:'unknown',reason:'missing'});expect(rateUsage({state:'known',items:[]},card,context).state).toBe('unknown');});
  it('confirmed zero still requires a matching published dimension',()=>{expect(rateUsage(usage('0'),card,context)).toMatchObject({state:'calculated',rounded_units:0n});expect(rateUsage({state:'known',items:[{dimension:'unpriced',quantity:'0',unit:'tokens'}]},card,context).state).toBe('unknown');});
  it('refuses ambiguous conditional rates even with differing specificity',()=>expect(()=>validateRateCard({...card,rates:[card.rates[0],{...card.rates[0],id:'second',conditions:{tier:'priority'}}]})).toThrow('ambiguous_rate'));
  it('connection-specific override wins without implicit condition precedence',()=>{const override={...card.rates[0],id:'override',connection_id:'connection',amount:'1'};expect(rateUsage(usage('1'),{...card,rates:[...card.rates,override]},{...context,connection_id:'connection'})).toMatchObject({items:[{rate_id:'override'}]});});
  it('uses half-open effective intervals',()=>{const expired={...card,rates:[{...card.rates[0],effective_to:context.at}]};expect(rateUsage(usage('1'),expired,context).state).toBe('unknown');});
  it('customer receives a lower applicable total while original upper price remains',()=>{const accepted={...card,rates:[{...card.rates[0],amount:'2'}]};const current={...card,id:'new',rates:[{...card.rates[0],amount:'1'}]};expect(customerRating(usage('100'),accepted,current,context)).toMatchObject({rate_card_id:'new',rounded_units:100000n});expect(customerRating(usage('100'),current,accepted,context)).toMatchObject({rate_card_id:'new',rounded_units:100000n});});
  it.each(['NaN','-1','1e3','01','0.'])('rejects malformed decimal %s',v=>expect(()=>Decimal.parse(v)).toThrow());
  it('rejects a denominator with nonterminating decimal expansion',()=>expect(()=>validateRateCard({...card,rates:[{...card.rates[0],unit_size:'3'}]})).toThrow('Rate denominator'));
});
