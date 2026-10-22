import {describe,it,expect} from 'vitest';
import {withLatestWallet} from './wallet-state';

describe('Demo wallet revisions',()=>{
 it('keeps a released reserve when an older in-flight response arrives after settlement',()=>{
  const current={wallet:{id:'wallet-a',revision:'9007199254740993',available_units:'97',reserved_units:'0'},history:['ready']};
  const late={wallet:{id:'wallet-a',revision:'9007199254740992',available_units:'50',reserved_units:'47'},history:['saved']};
  expect(withLatestWallet(current,late)).toEqual({...late,wallet:current.wallet});
 });
 it('accepts a newer authoritative wallet even when it reduces the available amount',()=>{
  const current={wallet:{id:'wallet-a',revision:2,available_units:'100'}};
  const next={wallet:{id:'wallet-a',revision:3,available_units:'40'}};
  expect(withLatestWallet(current,next)).toBe(next);expect(withLatestWallet(null,next)).toBe(next);
 });
 it('does not retain another wallet based on its larger revision',()=>{
  const current={wallet:{id:'wallet-a',revision:10,available_units:'100'}};
  const next={wallet:{id:'wallet-b',revision:1,available_units:'5'}};
  expect(withLatestWallet(current,next)).toBe(next);
 });
});
