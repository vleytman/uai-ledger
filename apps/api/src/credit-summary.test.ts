import {afterAll,describe,expect,test} from 'vitest';
import {createPool,transaction,type Tx} from '../../../packages/db/src/index.js';
import {id,ManualClock,type Scope} from '../../../packages/contracts/src/index.js';
import {issueToken} from '../../../packages/auth/src/index.js';
import * as accounting from '../../../packages/accounting/src/index.js';
import {apiSchemas} from '../../../packages/contracts/api.js';
import {createApi} from './server.js';
if(process.env.REQUIRE_INTEGRATION_TESTS==='1'&&!process.env.DATABASE_URL)throw new Error('DATABASE_URL required');
const integration=process.env.DATABASE_URL?describe:describe.skip;const pool=process.env.DATABASE_URL?createPool():null;const apis:ReturnType<typeof createApi>[]=[];
afterAll(async()=>{await Promise.all(apis.map(api=>api.close()));await pool?.end();});
const scopes=['accounts:write','credits:grant','credits:refund','credits:revoke','wallets:read','operations:admin'];
async function installation(clock:ManualClock){
 const organization_id=id('org'),application_id=id('app');const api=createApi(pool!,clock);apis.push(api);const run=<T>(fn:(tx:Tx)=>Promise<T>)=>transaction(pool!,fn);
 await pool!.query('INSERT INTO applications(id,organization_id,name) VALUES($1,$2,$3)',[application_id,organization_id,'Credit summary']);
 const token=async(account_ids:string[]|null=null,list=scopes)=>(await run(tx=>issueToken(tx,{organization_id,application_id,account_ids,scopes:list,max_grant_units:'100000',expires_at:null}))).token;
 const admin=await token();
 const post=async(url:string,payload:unknown)=>{const r=await api.inject({method:'POST',url,headers:{authorization:`Bearer ${admin}`,'idempotency-key':id('key')},payload:payload as any});expect(r.statusCode,r.body).toBeLessThan(300);return r.json();};
 const get=(url:string,bearer=admin)=>api.inject({method:'GET',url,headers:{authorization:`Bearer ${bearer}`}});
 const account=async()=>{const created=await post('/v1/accounts',{external_account_id:id('external'),create_wallet:{credit_unit_id:'ai-credit-usd-v1'}});return {id:created.id as string,wallet:created.wallet.id as string,scope:{organization_id,application_id,account_id:created.id} as Scope};};
 const grant=async(wallet:string,amount_units:string,source:string,expires_at:string|null)=>(await post(`/v1/wallets/${wallet}/grants`,{amount_units,source,external_reference:id('payment'),terms_version:'v1',expires_at,reason:'Fixture grant'})).grant_id as string;
 return {organization_id,application_id,api,run,token,post,get,account,grant};
}
const capture=(f:{run:Awaited<ReturnType<typeof installation>>['run']},scope:Scope,clock:ManualClock,amount:string)=>f.run(async tx=>{const operation_id=id('op'),request_id=id('req');await accounting.reserve(tx,scope,clock,{operation_id,max_units:amount,idempotency_key:id('reserve')});await accounting.claim(tx,scope,clock,{operation_id,request_id,max_units:amount,idempotency_key:id('claim')});return accounting.settleClaim(tx,scope,clock,{request_id,charged_units:amount,idempotency_key:id('capture')});});

integration('Application-wide credit summary',()=>{
 test('aggregates lots, journal flows and lazy expiry across wallets and agrees with every wallet /lots',async()=>{
  const clock=new ManualClock(new Date('2026-01-01T00:00:00Z'));const f=await installation(clock);
  const a=await f.account(),b=await f.account(),c=await f.account();
  // A foreign application must not leak into the summary.
  const foreign=await installation(clock);const outsider=await foreign.account();await foreign.grant(outsider.wallet,'9999','purchase',null);
  await f.grant(a.wallet,'1000','purchase',null);await f.grant(a.wallet,'500','promotion','2026-01-10T00:00:00Z');
  const subscription=await f.grant(b.wallet,'2000','subscription','2026-01-20T00:00:00Z');
  await f.grant(c.wallet,'700','migration','2026-02-15T00:00:00Z');await f.grant(c.wallet,'50','internal',null);
  clock.advance(86400000);
  // A: partial spend from the earliest-expiring promotion; C: spend and partial refund back into a live lot.
  await capture(f,a.scope,clock,'400');const spent=await capture(f,c.scope,clock,'100');
  await f.post(`/v1/wallets/${c.wallet}/refunds`,{capture_id:spent.capture_id,amount_units:'30',external_reference:id('refund'),reason:'Fixture refund'});
  // B: committed revocation, a revocation still blocked and an open reserve when the subscription expires.
  const revoked=await f.post(`/v1/wallets/${b.wallet}/grant-revocations`,{grant_id:subscription,amount_units:'200',external_reference:id('revoke'),reason:'purchase_refund'});
  await f.post(`/v1/grant-revocations/${revoked.revocation_id}/commit`,{reason:'billing confirmed'});
  const blocked=await f.post(`/v1/wallets/${b.wallet}/grant-revocations`,{grant_id:subscription,amount_units:'100',external_reference:id('revoke'),reason:'purchase_refund'});
  const reserved=id('op');await f.run(tx=>accounting.reserve(tx,b.scope,clock,{operation_id:reserved,max_units:'300',idempotency_key:id('reserve')}));
  clock.advance(23*86400000);// 2026-01-25: promotion and subscription expired, nothing has materialized their expire postings yet.
  const period={period_start:'2026-01-01T00:00:00.000Z',period_end:'2026-02-01T00:00:00.000Z'};
  const summary=async(query:Record<string,string>=period)=>{const r=await f.get(`/v1/admin/credit-summary?${new URLSearchParams(query)}`);expect(r.statusCode,r.body).toBe(200);return apiSchemas.CreditSummaryResponse.parse(r.json());};
  const before=await summary();
  expect(before).toMatchObject({wallet_count:3,issued_units:'4250',issued_by_source:{purchase:'1000',subscription:'2000',promotion:'500',migration:'700',internal:'50'},
   consumed_units:'500',refunded_units:'30',revoked_units:'200',expired_units:'1500',expired_held_units:'400',expired_precision:'partial',
   available_units:'1680',reserved_units:'300',revocation_reserved_units:'100',debt_units:'0',expiring_units:'630',
   filters:{application_id:f.application_id,account_id:null,expiring_before:'2026-02-24T00:00:00.000Z'},as_of:'2026-01-25T00:00:00.000Z'});
  // Reading /lots materializes lazy expiry; the summary must not change, and must equal the per-wallet totals.
  const lots=(await Promise.all([a,b,c].map(async w=>{const r=await f.get(`/v1/wallets/${w.wallet}/lots`);expect(r.statusCode).toBe(200);return r.json().data as any[];}))).flat();
  expect(await summary()).toEqual(before);
  const sum=(rows:any[],pick:(l:any)=>string)=>rows.reduce((total,l)=>total+BigInt(pick(l)),0n).toString();
  const inPeriod=(at:string|null)=>at!==null&&at>=period.period_start&&at<period.period_end;
  const issued=lots.filter(l=>l.source!=='refund'&&inPeriod(l.created_at)),expiredLots=lots.filter(l=>inPeriod(l.expires_at)&&l.expires_at<=before.as_of);
  expect(before.issued_units).toBe(sum(issued,l=>l.original_amount_units));
  for(const source of ['purchase','subscription','promotion','migration','internal'] as const)expect(before.issued_by_source[source]).toBe(sum(issued.filter(l=>l.source===source),l=>l.original_amount_units));
  expect((BigInt(before.consumed_units)-BigInt(before.refunded_units)).toString()).toBe(sum(lots,l=>l.consumed));
  expect(before.expired_units).toBe(sum(expiredLots,l=>l.expired));expect(before.expired_held_units).toBe(sum(expiredLots,l=>(BigInt(l.reserved)+BigInt(l.revocation_reserved)).toString()));
  expect(before.revoked_units).toBe(sum(lots,l=>l.revoked));expect(before.available_units).toBe(sum(lots,l=>l.available));
  expect(before.reserved_units).toBe(sum(lots,l=>l.reserved));expect(before.revocation_reserved_units).toBe(sum(lots,l=>l.revocation_reserved));
  // Held amounts of expired lots settle into expired at release/cancel time but stay attributed to the lot's expiry.
  await f.post(`/v1/grant-revocations/${blocked.revocation_id}/cancel`,{reason:'payment kept'});
  await f.run(tx=>accounting.releaseReservation(tx,b.scope,clock,{operation_id:reserved,idempotency_key:id('release')}));
  clock.advance(10*86400000);
  expect(await summary()).toMatchObject({expired_units:'1900',expired_held_units:'0',expired_precision:'final',revoked_units:'200',reserved_units:'0',revocation_reserved_units:'0',available_units:'1680',expiring_units:'630'});
  expect(await summary({...period,account_id:b.id})).toMatchObject({wallet_count:1,filters:{account_id:b.id},issued_units:'2000',issued_by_source:{subscription:'2000',purchase:'0'},consumed_units:'0',revoked_units:'200',expired_units:'1800',available_units:'0',expiring_units:'0'});
  expect(await summary({account_id:c.id,expiring_before:'2026-02-01T00:00:00.000Z'})).toMatchObject({wallet_count:1,filters:{period_start:null,period_end:null},issued_units:'750',consumed_units:'100',refunded_units:'30',available_units:'680',expiring_units:'0'});
  expect(await summary({period_start:'2026-02-01T00:00:00.000Z',period_end:'2026-03-01T00:00:00.000Z'})).toMatchObject({issued_units:'0',consumed_units:'0',expired_units:'0',revoked_units:'0',available_units:'1680'});
  // Scope and input boundaries.
  expect((await f.get(`/v1/admin/credit-summary?account_id=${outsider.id}`)).statusCode).toBe(404);
  expect((await f.get(`/v1/admin/credit-summary?${new URLSearchParams({period_start:period.period_end,period_end:period.period_start})}`)).statusCode).toBe(422);
  expect((await f.get('/v1/admin/credit-summary?wallet_id=x')).statusCode).toBe(422);
  expect((await f.get('/v1/admin/credit-summary',await f.token([a.id]))).statusCode).toBe(403);
  expect((await f.get('/v1/admin/credit-summary',await f.token(null,['wallets:read']))).statusCode).toBe(403);
 });
});
