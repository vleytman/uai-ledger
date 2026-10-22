import {Decimal,rateUsage,type RateCard} from '../../pricing/src/index.js';
import { afterAll, describe, expect, test } from 'vitest';
import { createPool, transaction, type Tx } from '../../db/src/index.js';
import { id, ManualClock, type Scope } from '../../contracts/src/index.js';
import * as a from '../src/index.js';
if(process.env.REQUIRE_INTEGRATION_TESTS==='1'&&!process.env.DATABASE_URL) throw new Error('DATABASE_URL required for accounting integration tests');
const integration=process.env.DATABASE_URL?describe:describe.skip;
const pool=process.env.DATABASE_URL?createPool():null;
afterAll(async()=>{await pool?.end();});
async function fixture() {
 const scope:Scope={organization_id:id('org'),application_id:id('app'),account_id:id('acct')};
 await pool!.query('INSERT INTO applications(id,organization_id,name) VALUES($1,$2,$3)',[scope.application_id,scope.organization_id,'Accounting integration']);
 await pool!.query('INSERT INTO accounts(id,organization_id,application_id,external_account_id) VALUES($1,$2,$3,$4)',[scope.account_id,scope.organization_id,scope.application_id,id('external')]);
 const clock=new ManualClock(new Date('2026-01-01T00:00:00Z'));
 const run=<T>(fn:(tx:Tx)=>Promise<T>)=>transaction(pool!,fn);
 const grant=(amount='100',extra:Partial<a.GrantInput>={})=>run(tx=>a.grant(tx,scope,clock,{idempotency_key:id('key'),external_reference:id('grant'),amount_units:amount,source:'purchase',terms_version:'v1',expires_at:null,...extra}));
 return {scope,clock,run,grant};
}
integration('PostgreSQL accounting invariants',()=>{
 test('A12 final rounded units equal lot allocations and every journal stays balanced',async()=>{
  const f=await fixture();const first=await f.grant('1',{expires_at:'2026-02-01T00:00:00Z'});const second=await f.grant('2');
  const card:RateCard={id:'rounding-fixture',currency:'USD',source:'synthetic test',checked_at:f.clock.now().toISOString(),rates:[{id:'text',dimension:'output.text',unit:'tokens',unit_size:'1',amount:'0.00000000149',effective_from:'2025-01-01'}]};
  expect(Decimal.parse('0.000000000499999').units('half-up')).toBe(0n);expect(Decimal.parse('0.000000000500000').units('half-up')).toBe(1n);
  const rating=rateUsage({state:'known',items:[{dimension:'output.text',unit:'tokens',quantity:'1'},{dimension:'output.text',unit:'tokens',quantity:'1'}]},card,{at:f.clock.now().toISOString()});expect(rating).toMatchObject({state:'calculated',exact_amount:'0.00000000298',rounded_units:3n});if(rating.state!=='calculated')throw new Error('Fixture rating missing');
  const op=id('op'),request=id('req');await f.run(async tx=>{await a.reserve(tx,f.scope,f.clock,{operation_id:op,max_units:'3',idempotency_key:'reserve'});await a.claim(tx,f.scope,f.clock,{operation_id:op,request_id:request,max_units:'3',idempotency_key:'claim'});});
  const capture=await f.run(tx=>a.settleClaim(tx,f.scope,f.clock,{request_id:request,charged_units:rating.rounded_units.toString(),idempotency_key:'capture'}));
  const allocations=(await pool!.query('SELECT lot_id,amount_units FROM capture_allocations WHERE capture_id=$1',[capture.capture_id])).rows;expect(allocations.find(p=>p.lot_id===first.lot_id).amount_units).toBe('1');expect(allocations.find(p=>p.lot_id===second.lot_id).amount_units).toBe('2');expect(allocations.reduce((n,p)=>n+BigInt(p.amount_units),0n)).toBe(rating.rounded_units);
  const sums=(await pool!.query('SELECT sum(amount_units)::text total FROM journal_postings WHERE wallet_id=$1 GROUP BY transaction_id',[first.wallet.id])).rows;expect(sums.every(r=>r.total==='0')).toBe(true);
 });
 test('A46 discounted purchase and bonus lots retain identical credit unit cost',async()=>{
  const f=await fixture();const purchase=await f.grant('100',{terms_version:'retail-discount-v1'});const bonus=await f.grant('50',{source:'promotion',reason:'Promotion fixture',terms_version:'bonus-v1',expires_at:'2026-02-01T00:00:00Z'});
  const lots=await f.run(tx=>a.getLots(tx,f.scope,f.clock));expect(lots.every(l=>l.budget_per_credit_units==='1000000')).toBe(true);
  const op=id('op'),request=id('req');await f.run(async tx=>{await a.reserve(tx,f.scope,f.clock,{operation_id:op,max_units:'120',idempotency_key:'reserve'});await a.claim(tx,f.scope,f.clock,{operation_id:op,request_id:request,max_units:'120',idempotency_key:'claim'});await a.settleClaim(tx,f.scope,f.clock,{request_id:request,charged_units:'75',idempotency_key:'capture'});await a.releaseReservation(tx,f.scope,f.clock,{operation_id:op,idempotency_key:'release'});});
  const after=await f.run(tx=>a.getLots(tx,f.scope,f.clock));expect(after.find(l=>l.id===bonus.lot_id)).toMatchObject({consumed:'50',available:'0'});expect(after.find(l=>l.id===purchase.lot_id)).toMatchObject({consumed:'25',available:'75'});expect((await f.run(tx=>a.getWallet(tx,f.scope,f.clock))).balance_units).toBe('75');
 });
 test('A48 a prepared hold reserves its amount while all other lots remain spendable',async()=>{
  const f=await fixture();const purchase=await f.grant('100');const other=await f.grant('50',{source:'promotion',reason:'Promotion fixture'});await f.run(tx=>a.prepareRevocation(tx,f.scope,f.clock,{grant_id:purchase.grant_id,amount_units:'60',external_reference:'refund-sale',reason:'purchase_refund',idempotency_key:'prepare'}));
  expect((await f.run(tx=>a.getWallet(tx,f.scope,f.clock)))).toMatchObject({available_units:'90',reserved_units:'60'});
  await expect(f.run(tx=>a.reserve(tx,f.scope,f.clock,{operation_id:id('op'),max_units:'91',idempotency_key:'too-large'}))).rejects.toMatchObject({code:'insufficient_credits'});
  await f.run(tx=>a.reserve(tx,f.scope,f.clock,{operation_id:id('op'),max_units:'90',idempotency_key:'other-credit'}));
  const lots=await f.run(tx=>a.getLots(tx,f.scope,f.clock));expect(lots.find(l=>l.id===purchase.lot_id)).toMatchObject({revocation_reserved:'60',reserved:'40'});expect(lots.find(l=>l.id===other.lot_id)).toMatchObject({revocation_reserved:'0',reserved:'50'});
 });
 test('A74 overdue prepared hold creates exactly one incident and resolves only on explicit commit/cancel',async()=>{
  for(const action of ['commit','cancel'] as const){const f=await fixture();const grant=await f.grant();const hold=await f.run(tx=>a.prepareRevocation(tx,f.scope,f.clock,{grant_id:grant.grant_id,amount_units:'60',external_reference:'sale-refund',reason:'purchase_refund',reconcile_after:'2026-01-01T00:01:00Z',idempotency_key:'prepare'}));
   expect(await f.run(tx=>a.reconcileRevocationHolds(tx,f.clock,f.scope))).toBe(0);f.clock.advance(60001);
   const runs=await Promise.all([1,2].map(()=>f.run(tx=>a.reconcileRevocationHolds(tx,f.clock,f.scope))));expect(runs.reduce((a,b)=>a+b,0)).toBe(1);
   const incidents=await f.run(tx=>a.listRevocationIncidents(tx,f.scope));expect(incidents).toHaveLength(1);expect(incidents[0]).toMatchObject({status:'open',amount_units:'60',revocation_id:hold.revocation_id,resolved_at:null});
   expect(await f.run(tx=>a.listRevocationIncidents(tx,{...f.scope,application_id:'other-app'}))).toEqual([]);expect((await f.run(tx=>a.getWallet(tx,f.scope,f.clock)))).toMatchObject({available_units:'40',reserved_units:'60'});
   const finish=action==='commit'?a.commitRevocation:a.cancelRevocation;await f.run(tx=>finish(tx,f.scope,f.clock,{revocation_id:hold.revocation_id,idempotency_key:'finish',reason:'Billing confirmed'}));
   expect((await f.run(tx=>a.listRevocationIncidents(tx,f.scope)))[0]).toMatchObject({status:'resolved',resolution:action==='commit'?'committed':'canceled'});expect(await f.run(tx=>a.reconcileRevocationHolds(tx,f.clock,f.scope))).toBe(0);
   const events=(await pool!.query("SELECT type FROM outbox_events WHERE application_id=$1 AND type LIKE 'revocation.%' ORDER BY sequence",[f.scope.application_id])).rows;expect(events.map(e=>e.type)).toEqual(['revocation.reconciliation_required','revocation.reconciled']);
  }
 });
 test('A05 new package amount and terms cannot reprice an existing lot',async()=>{
  const f=await fixture();const first=await f.grant('100',{terms_version:'monthly-v1',refund_days:30,expires_at:'2026-02-01T00:00:00Z'});
  const before=(await f.run(tx=>a.getLots(tx,f.scope,f.clock))).find(l=>l.id===first.lot_id)!;
  await f.grant('250',{terms_version:'monthly-v2',refund_days:7,expires_at:'2026-03-01T00:00:00Z'});
  const lots=await f.run(tx=>a.getLots(tx,f.scope,f.clock));expect(lots.find(l=>l.id===first.lot_id)).toEqual(before);
  expect(lots.find(l=>l.id!==first.lot_id)).toMatchObject({original_amount_units:'250',terms_version:'monthly-v2',terms:{refund_days:7}});
  expect(before).toMatchObject({original_amount_units:'100',budget_per_credit_units:'1000000',terms_version:'monthly-v1',terms:{refund_days:30}});
 });
 test('A06 credit unit cannot be mutated through grant or direct stored wallet change',async()=>{
  const f=await fixture();const granted=await f.grant();
  await expect(f.grant('100',{credit_unit_id:'new-cheaper-credit'})).rejects.toMatchObject({code:'invalid_input'});
  await expect(pool!.query("UPDATE wallets SET credit_unit_id='new-cheaper-credit' WHERE id=$1",[granted.wallet.id])).rejects.toThrow();
  await expect(pool!.query('UPDATE credit_lots SET budget_per_credit_units=500000 WHERE id=$1',[granted.lot_id])).rejects.toThrow();
  expect((await f.run(tx=>a.getWallet(tx,f.scope,f.clock))).balance_units).toBe('100');
 });
 test('A65 delayed scheduler excludes expired monthly remainder and new period never rolls it over',async()=>{
  const f=await fixture();const old=await f.grant('100',{source:'subscription',terms_version:'month-jan',expires_at:'2026-02-01T00:00:00Z'});
  f.clock.advance(31*86400000+1);
  expect((await f.run(tx=>a.getWallet(tx,f.scope,f.clock))).available_units).toBe('0');
  await expect(f.run(tx=>a.reserve(tx,f.scope,f.clock,{operation_id:id('op'),max_units:'1',idempotency_key:'old-expired'}))).rejects.toMatchObject({code:'insufficient_credits'});
  const fresh=await f.grant('100',{source:'subscription',terms_version:'month-feb',expires_at:'2026-03-01T00:00:00Z'});
  const lots=await f.run(tx=>a.getLots(tx,f.scope,f.clock));expect(lots.find(l=>l.id===old.lot_id)).toMatchObject({available:'0',expired:'100'});expect(lots.find(l=>l.id===fresh.lot_id)).toMatchObject({available:'100',expired:'0'});
  expect((await f.run(tx=>a.getWallet(tx,f.scope,f.clock))).balance_units).toBe('100');
  await expect(f.run(tx=>a.reserve(tx,f.scope,f.clock,{operation_id:id('op'),max_units:'101',idempotency_key:'no-rollover'}))).rejects.toMatchObject({code:'insufficient_credits'});
 });
 test('serializes competing reserves without overspending',async()=>{
  const f=await fixture(); await f.grant();
  const results=await Promise.allSettled([1,2].map(()=>f.run(tx=>a.reserve(tx,f.scope,f.clock,{operation_id:id('op'),max_units:'80',idempotency_key:id('key')}))));
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  expect((results.find(r=>r.status==='rejected') as PromiseRejectedResult).reason.code).toBe('insufficient_credits');
  const wallet=await f.run(tx=>a.getWallet(tx,f.scope,f.clock)); expect(wallet).toMatchObject({available_units:'20',reserved_units:'80',balance_units:'100'});
 });
 test('grant replays and source identities never duplicate issuance',async()=>{
  const f=await fixture(); const input:a.GrantInput={idempotency_key:'same',external_reference:'payment',amount_units:'100',source:'purchase',terms_version:'v1',expires_at:null};
  const first=await f.run(tx=>a.grant(tx,f.scope,f.clock,input));
  expect(await f.run(tx=>a.grant(tx,f.scope,f.clock,input))).toEqual(first);
  expect((await f.run(tx=>a.grant(tx,f.scope,f.clock,{...input,idempotency_key:'another'}))).lot_id).toBe(first.lot_id);
  await expect(f.run(tx=>a.grant(tx,f.scope,f.clock,{...input,idempotency_key:'changed',amount_units:'200'}))).rejects.toMatchObject({code:'idempotency_conflict'});
  expect((await f.run(tx=>a.getWallet(tx,f.scope,f.clock))).balance_units).toBe('100');
 });
 test('one issuer source event cannot credit two wallets, even with new HTTP identities',async()=>{
  const f=await fixture();const second={...f.scope,account_id:id('acct')};
  await pool!.query('INSERT INTO accounts(id,organization_id,application_id,external_account_id) VALUES($1,$2,$3,$4)',[second.account_id,second.organization_id,second.application_id,id('external')]);
  const body:a.GrantInput={idempotency_key:'first',external_reference:'same-payment',amount_units:'100',source:'purchase',terms_version:'v1',expires_at:null};
  const attempts=await Promise.allSettled([f.run(tx=>a.grant(tx,f.scope,f.clock,body)),f.run(tx=>a.grant(tx,second,f.clock,{...body,idempotency_key:'second'}))]);
  expect(attempts.filter(v=>v.status==='fulfilled')).toHaveLength(1);
  expect((attempts.find(v=>v.status==='rejected') as PromiseRejectedResult).reason.code).toBe('idempotency_conflict');
  const total=(await pool!.query('SELECT COALESCE(sum(b.available),0)::text amount FROM lot_balances b JOIN credit_lots l ON l.id=b.lot_id JOIN wallets w ON w.id=l.wallet_id WHERE w.application_id=$1',[f.scope.application_id])).rows[0].amount;expect(total).toBe('100');
 });
 test('stable issuer survives token rotation, while separate issuers have separate source namespaces',async()=>{
  const f=await fixture();const body:a.GrantInput={idempotency_key:'first',external_reference:'event-1',issuer:'billing-main',actor_id:'old-token',amount_units:'100',source:'purchase',terms_version:'v1',expires_at:null};
  const first=await f.run(tx=>a.grant(tx,f.scope,f.clock,body));
  expect((await f.run(tx=>a.grant(tx,f.scope,f.clock,{...body,actor_id:'new-token'}))).lot_id).toBe(first.lot_id);
  expect((await f.run(tx=>a.grant(tx,f.scope,f.clock,{...body,idempotency_key:'rotated',actor_id:'new-token'}))).lot_id).toBe(first.lot_id);
  await f.run(tx=>a.grant(tx,f.scope,f.clock,{...body,idempotency_key:'other-issuer',issuer:'billing-other'}));
  expect((await f.run(tx=>a.getWallet(tx,f.scope,f.clock))).balance_units).toBe('200');
 });
 test('orders earliest expiry first and preserves reserved expired credits until settlement',async()=>{
  const f=await fixture(); await f.grant('100'); const early=await f.grant('50',{expires_at:'2026-01-01T00:01:00Z'}); const operation=id('op'),request=id('req');
  await f.run(tx=>a.reserve(tx,f.scope,f.clock,{operation_id:operation,max_units:'70',idempotency_key:'reserve'}));
  let lots=await f.run(tx=>a.getLots(tx,f.scope,f.clock)); expect(lots.find(l=>l.id===early.lot_id)?.reserved).toBe('50');
  await f.run(tx=>a.claim(tx,f.scope,f.clock,{operation_id:operation,request_id:request,max_units:'70',idempotency_key:'claim'}));
  f.clock.advance(120000);
  await f.run(tx=>a.settleClaim(tx,f.scope,f.clock,{request_id:request,charged_units:'30',idempotency_key:'settle'}));
  const release=await f.run(tx=>a.releaseReservation(tx,f.scope,f.clock,{operation_id:operation,idempotency_key:'release'}));
  expect(release).toMatchObject({released_units:'40',expired_units:'20',wallet:{available_units:'100',reserved_units:'0'}});
  lots=await f.run(tx=>a.getLots(tx,f.scope,f.clock)); expect(lots.find(l=>l.id===early.lot_id)).toMatchObject({expired:'20',consumed:'30'});
 });
 test('read materializes expiry even with no scheduler and cannot spend expired lots',async()=>{
  const f=await fixture(); await f.grant('100',{expires_at:'2026-01-01T00:01:00Z'}); f.clock.advance(60001);
  expect((await f.run(tx=>a.getWallet(tx,f.scope,f.clock))).available_units).toBe('0');
  await expect(f.run(tx=>a.reserve(tx,f.scope,f.clock,{operation_id:id('op'),max_units:'1',idempotency_key:'reserve'}))).rejects.toMatchObject({code:'insufficient_credits'});
 });
 test('competing claims share one cap and closed claims cannot be charged later',async()=>{
  const f=await fixture(); await f.grant(); const operation=id('op');
  await f.run(tx=>a.reserve(tx,f.scope,f.clock,{operation_id:operation,max_units:'100',idempotency_key:'reserve'}));
  const requests=[id('req'),id('req')];
  const claims=await Promise.allSettled(requests.map(request_id=>f.run(tx=>a.claim(tx,f.scope,f.clock,{operation_id:operation,request_id,max_units:'70',idempotency_key:request_id}))));
  expect(claims.filter(c=>c.status==='fulfilled')).toHaveLength(1); const request=requests[claims.findIndex(c=>c.status==='fulfilled')]!;
  await expect(f.run(tx=>a.releaseReservation(tx,f.scope,f.clock,{operation_id:operation,idempotency_key:'too-early'}))).rejects.toMatchObject({code:'budget_conflict'});
  await f.run(tx=>a.settleClaim(tx,f.scope,f.clock,{request_id:request,charged_units:'0',idempotency_key:'timeout'}));
  await expect(f.run(tx=>a.settleClaim(tx,f.scope,f.clock,{request_id:request,charged_units:'20',idempotency_key:'late'}))).rejects.toMatchObject({code:'budget_conflict'});
  expect((await f.run(tx=>a.releaseReservation(tx,f.scope,f.clock,{operation_id:operation,idempotency_key:'release'}))).wallet.available_units).toBe('100');
 });
 test('refunds before expiry to original lot and after expiry to immutable compensation lot',async()=>{
  const f=await fixture(); const original=await f.grant('100',{expires_at:'2026-01-01T00:01:00Z'}); const operation=id('op'),request=id('req');
  await f.run(async tx=>{await a.reserve(tx,f.scope,f.clock,{operation_id:operation,max_units:'100',idempotency_key:'reserve'}); await a.claim(tx,f.scope,f.clock,{operation_id:operation,request_id:request,max_units:'100',idempotency_key:'claim'});});
  const capture=await f.run(tx=>a.settleClaim(tx,f.scope,f.clock,{request_id:request,charged_units:'100',idempotency_key:'settle'}));
  await f.run(tx=>a.refund(tx,f.scope,f.clock,{capture_id:capture.capture_id!,amount_units:'20',external_reference:'early',reason:'overcharge',idempotency_key:'early'}));
  expect((await f.run(tx=>a.getLots(tx,f.scope,f.clock)))[0]?.available).toBe('20');
  f.clock.advance(120000);
  const input={capture_id:capture.capture_id!,amount_units:'80',external_reference:'late',reason:'delivery_failure',idempotency_key:'late'};
  const late=await f.run(tx=>a.refund(tx,f.scope,f.clock,input)); expect(await f.run(tx=>a.refund(tx,f.scope,f.clock,input))).toEqual(late);
  const lots=await f.run(tx=>a.getLots(tx,f.scope,f.clock)); expect(lots).toHaveLength(2);
  const compensation=lots.find(l=>l.source==='refund')!; expect(compensation.available).toBe('80'); expect(new Date(compensation.expires_at!).getTime()-f.clock.now().getTime()).toBe(30*86400000);
  expect(lots.find(l=>l.id===original.lot_id)).toMatchObject({available:'0',consumed:'0',expired:'20'});
  await expect(f.run(tx=>a.refund(tx,f.scope,f.clock,{...input,idempotency_key:'excess',external_reference:'excess',amount_units:'1'}))).rejects.toMatchObject({code:'budget_conflict'});
 });
 test('revocation hold persists beyond reconciliation time and cancel after expiry expires the hold',async()=>{
  const f=await fixture(); const grant=await f.grant('100',{expires_at:'2026-01-01T00:01:00Z'});
  const hold=await f.run(tx=>a.prepareRevocation(tx,f.scope,f.clock,{grant_id:grant.grant_id,amount_units:'60',external_reference:'billing-refund',reason:'purchase_refund',idempotency_key:'prepare'}));
  f.clock.advance(7200000); expect((await f.run(tx=>a.getWallet(tx,f.scope,f.clock)))).toMatchObject({available_units:'0',reserved_units:'60'});
  const cancel=await f.run(tx=>a.cancelRevocation(tx,f.scope,f.clock,{revocation_id:hold.revocation_id,idempotency_key:'cancel'})); expect(cancel.wallet.balance_units).toBe('0');
  await expect(f.run(tx=>a.commitRevocation(tx,f.scope,f.clock,{revocation_id:hold.revocation_id,idempotency_key:'commit'}))).rejects.toMatchObject({code:'budget_conflict'});
 });
 test('revocation cannot use consumed or AI-reserved funds and commit is idempotent',async()=>{
  const f=await fixture(); const grant=await f.grant(); await f.run(tx=>a.reserve(tx,f.scope,f.clock,{operation_id:id('op'),max_units:'70',idempotency_key:'reserve'}));
  await expect(f.run(tx=>a.prepareRevocation(tx,f.scope,f.clock,{grant_id:grant.grant_id,amount_units:'50',external_reference:'too-much',reason:'refund',idempotency_key:'bad'}))).rejects.toMatchObject({code:'revocation_unavailable'});
  const hold=await f.run(tx=>a.prepareRevocation(tx,f.scope,f.clock,{grant_id:grant.grant_id,amount_units:'30',external_reference:'ok',reason:'refund',idempotency_key:'prepare'}));
  await f.run(tx=>a.commitRevocation(tx,f.scope,f.clock,{revocation_id:hold.revocation_id,idempotency_key:'commit'}));
  expect((await f.run(tx=>a.commitRevocation(tx,f.scope,f.clock,{revocation_id:hold.revocation_id,idempotency_key:'another'}))).wallet).toMatchObject({balance_units:'70',reserved_units:'70'});
 });
 test('suspension blocks new spending but permits existing settlement and resume',async()=>{
  const f=await fixture(); await f.grant(); const operation=id('op'),request=id('req');
  await f.run(async tx=>{await a.reserve(tx,f.scope,f.clock,{operation_id:operation,max_units:'50',idempotency_key:'reserve'});await a.claim(tx,f.scope,f.clock,{operation_id:operation,request_id:request,max_units:'50',idempotency_key:'claim'});});
  await f.run(tx=>a.setSpendingSuspended(tx,f.scope,f.clock,{suspended:true,reason:'billing',idempotency_key:'suspend'}));
  await expect(f.run(tx=>a.reserve(tx,f.scope,f.clock,{operation_id:id('op'),max_units:'1',idempotency_key:'new'}))).rejects.toMatchObject({code:'account_denied'});
  expect((await f.run(tx=>a.settleClaim(tx,f.scope,f.clock,{request_id:request,charged_units:'30',idempotency_key:'settle'}))).charged_units).toBe('30');
  await f.run(tx=>a.setSpendingSuspended(tx,f.scope,f.clock,{suspended:false,reason:'cleared',idempotency_key:'resume'}));
  await f.run(tx=>a.reserve(tx,f.scope,f.clock,{operation_id:id('op'),max_units:'1',idempotency_key:'after'}));
 });
 test('foreign scope cannot access reservations or captures',async()=>{
  const f=await fixture(),other=await fixture(); await f.grant(); const operation=id('op'); await f.run(tx=>a.reserve(tx,f.scope,f.clock,{operation_id:operation,max_units:'10',idempotency_key:'reserve'}));
  await expect(other.run(tx=>a.getReservation(tx,other.scope,operation))).rejects.toMatchObject({code:'not_found'});
  await expect(other.run(tx=>a.ensureWallet(tx,{...other.scope,account_id:f.scope.account_id}))).rejects.toMatchObject({code:'not_found'});
 });
 test('bigint stays exact and journal/outbox roll back with a failed atomic admission',async()=>{
  const f=await fixture(); await f.grant('9007199254740993');
  const before=await f.run(tx=>a.getWallet(tx,f.scope,f.clock));
  await expect(f.run(async tx=>{await a.reserve(tx,f.scope,f.clock,{operation_id:id('op'),max_units:'9007199254740992',idempotency_key:'atomic'});throw new Error('admission failed');})).rejects.toThrow('admission failed');
  expect(await f.run(tx=>a.getWallet(tx,f.scope,f.clock))).toEqual(before);
  expect((await pool!.query('SELECT count(*)::integer n FROM outbox_events WHERE account_id=$1',[f.scope.account_id])).rows[0].n).toBe(1);
 });
 test('amendment funds only its approved delta and rolls back an unfunded increase',async()=>{
  const f=await fixture(); await f.grant(); const operation=id('op');
  await f.run(tx=>a.reserve(tx,f.scope,f.clock,{operation_id:operation,max_units:'50',idempotency_key:'reserve'}));
  expect((await f.run(tx=>a.amendReservation(tx,f.scope,f.clock,{operation_id:operation,additional_units:'30',idempotency_key:'amend'}))).max_units).toBe('80');
  await expect(f.run(tx=>a.amendReservation(tx,f.scope,f.clock,{operation_id:operation,additional_units:'30',idempotency_key:'unfunded'}))).rejects.toMatchObject({code:'insufficient_credits'});
  expect((await f.run(tx=>a.getReservation(tx,f.scope,operation))).max_units).toBe('80');
  expect((await f.run(tx=>a.getWallet(tx,f.scope,f.clock))).available_units).toBe('20');
 });
 test('concurrent refunds cannot compensate more than one capture',async()=>{
  const f=await fixture(); await f.grant(); const operation=id('op'),request=id('req');
  const capture=await f.run(async tx=>{await a.reserve(tx,f.scope,f.clock,{operation_id:operation,max_units:'100',idempotency_key:'reserve'});await a.claim(tx,f.scope,f.clock,{operation_id:operation,request_id:request,max_units:'100',idempotency_key:'claim'});return a.settleClaim(tx,f.scope,f.clock,{request_id:request,charged_units:'100',idempotency_key:'settle'});});
  const results=await Promise.allSettled([1,2].map(i=>f.run(tx=>a.refund(tx,f.scope,f.clock,{capture_id:capture.capture_id!,amount_units:'70',external_reference:`case-${i}`,reason:'overcharge',idempotency_key:`refund-${i}`}))));
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  expect((await f.run(tx=>a.getWallet(tx,f.scope,f.clock))).available_units).toBe('70');
 });
 test('release cannot reuse allocations and captures cannot exceed claim',async()=>{
  const f=await fixture(); await f.grant(); const operation=id('op'),request=id('req');
  await f.run(async tx=>{await a.reserve(tx,f.scope,f.clock,{operation_id:operation,max_units:'80',idempotency_key:'reserve'});await a.claim(tx,f.scope,f.clock,{operation_id:operation,request_id:request,max_units:'50',idempotency_key:'claim'});});
  await expect(f.run(tx=>a.settleClaim(tx,f.scope,f.clock,{request_id:request,charged_units:'51',idempotency_key:'too-much'}))).rejects.toMatchObject({code:'budget_conflict'});
  await f.run(tx=>a.settleClaim(tx,f.scope,f.clock,{request_id:request,charged_units:'50',idempotency_key:'settle'}));
  const released=await f.run(tx=>a.releaseReservation(tx,f.scope,f.clock,{operation_id:operation,idempotency_key:'release'}));
  expect(released.wallet).toMatchObject({balance_units:'50',reserved_units:'0',available_units:'50'});
  expect(await f.run(tx=>a.releaseReservation(tx,f.scope,f.clock,{operation_id:operation,idempotency_key:'release'}))).toEqual(released);
  await expect(f.run(tx=>a.claim(tx,f.scope,f.clock,{operation_id:operation,request_id:id('req'),max_units:'1',idempotency_key:'late'}))).rejects.toMatchObject({code:'budget_conflict'});
 });
 test('journal cursor does not drop entries sharing one timestamp',async()=>{
  const f=await fixture();await f.grant('10');await f.grant('20');await f.grant('30');
  const seen:string[]=[];let before:string|undefined;
  for(let page=0;page<3;page++){const rows=await f.run(tx=>a.getJournal(tx,f.scope,{limit:1,before}));expect(rows).toHaveLength(1);seen.push(rows[0].id);before=rows[0].cursor;}
  expect(new Set(seen).size).toBe(3);expect(await f.run(tx=>a.getJournal(tx,f.scope,{limit:1,before}))).toHaveLength(0);
 });
 test('database rejects immutable history edits, unbalanced journals and projection corruption',async()=>{
  const f=await fixture(); const grant=await f.grant(); const wallet=grant.wallet.id;
  await expect(pool!.query('UPDATE credit_lots SET expires_at=now() WHERE id=$1',[grant.lot_id])).rejects.toThrow('immutable');
  await expect(f.run(tx=>tx.query('UPDATE lot_balances SET available=999 WHERE lot_id=$1',[grant.lot_id]))).rejects.toThrow('Lot journal mismatch');
  await expect(f.run(tx=>tx.query("INSERT INTO journal_transactions(id,wallet_id,type,identity,actor_id,reason,created_at) VALUES($1,$2,'test',$1,'test','test',now())",[id('bad'),wallet]))).rejects.toThrow('Unbalanced');
  const journal=(await f.run(tx=>a.getJournal(tx,f.scope)))[0];
  await expect(pool!.query("INSERT INTO journal_postings(transaction_id,wallet_id,lot_id,bucket,amount_units) VALUES($1,$2,$3,'available',1)",[journal.id,wallet,grant.lot_id])).rejects.toThrow('Cannot append');
 });
});
integration('actual usage overdraft',()=>{
 test('charges past estimate and wallet, replays once, repays debt and refunds paid and unpaid portions',async()=>{
  const f=await fixture();await f.grant('100');const operation=id('op'),request=id('req');
  await f.run(async tx=>{await a.reserve(tx,f.scope,f.clock,{operation_id:operation,max_units:'40',idempotency_key:'reserve'});await a.claim(tx,f.scope,f.clock,{operation_id:operation,request_id:request,max_units:'40',idempotency_key:'claim'});});
  const input={request_id:request,charged_units:'150',allow_overdraft:true,idempotency_key:'capture'};
  const captured=await f.run(tx=>a.settleClaim(tx,f.scope,f.clock,input));expect(captured.wallet.available_units).toBe('-50');
  expect(await f.run(tx=>a.settleClaim(tx,f.scope,f.clock,input))).toEqual(captured);
  await f.run(tx=>a.releaseReservation(tx,f.scope,f.clock,{operation_id:operation,idempotency_key:'release'}));
  expect((await f.run(tx=>a.getWallet(tx,f.scope,f.clock)))).toMatchObject({available_units:'-50',balance_units:'-50',reserved_units:'0'});
  await expect(f.run(tx=>a.reserve(tx,f.scope,f.clock,{operation_id:id('op'),max_units:'1',idempotency_key:'blocked'}))).rejects.toMatchObject({code:'insufficient_credits'});
  await f.grant('20');expect((await f.run(tx=>a.getWallet(tx,f.scope,f.clock))).available_units).toBe('-30');
  await f.run(tx=>a.refund(tx,f.scope,f.clock,{capture_id:captured.capture_id!,amount_units:'40',external_reference:'refund',reason:'test',idempotency_key:'refund'}));
  expect((await f.run(tx=>a.getWallet(tx,f.scope,f.clock))).available_units).toBe('10');
  await f.run(tx=>a.refund(tx,f.scope,f.clock,{capture_id:captured.capture_id!,amount_units:'110',external_reference:'refund-rest',reason:'test',idempotency_key:'refund-rest'}));
  expect((await f.run(tx=>a.getWallet(tx,f.scope,f.clock))).available_units).toBe('120');
  const sums=(await pool!.query('SELECT sum(amount_units)::text total FROM journal_postings WHERE wallet_id=$1 GROUP BY transaction_id',[captured.wallet.id])).rows;expect(sums.every(r=>r.total==='0')).toBe(true);
 });
 test('repayment is consumed permanently even when the new grant later expires',async()=>{
  const f=await fixture();await f.grant('10');const op=id('op'),req=id('req');
  await f.run(async tx=>{await a.reserve(tx,f.scope,f.clock,{operation_id:op,max_units:'10',idempotency_key:'r'});await a.claim(tx,f.scope,f.clock,{operation_id:op,request_id:req,max_units:'10',idempotency_key:'c'});await a.settleClaim(tx,f.scope,f.clock,{request_id:req,charged_units:'30',allow_overdraft:true,idempotency_key:'s'});await a.releaseReservation(tx,f.scope,f.clock,{operation_id:op,idempotency_key:'end'});});
  await f.grant('30',{expires_at:'2026-01-02T00:00:00Z'});expect((await f.run(tx=>a.getWallet(tx,f.scope,f.clock))).available_units).toBe('10');
  f.clock.advance(86400001);expect((await f.run(tx=>a.getWallet(tx,f.scope,f.clock))).available_units).toBe('0');
 });
});
