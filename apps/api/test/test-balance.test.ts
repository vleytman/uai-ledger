import {afterAll,expect,it} from 'vitest';
import {createPool,transaction} from '../../../packages/db/src/index.js';
import {id,ManualClock} from '../../../packages/contracts/src/index.js';
import {issueToken} from '../../../packages/auth/src/index.js';
import {grant,getWallet,reserve,releaseReservation} from '../../../packages/accounting/src/index.js';
import {createApi} from '../src/server.js';

if(process.env.REQUIRE_INTEGRATION_TESTS==='1'&&!process.env.DATABASE_URL)throw new Error('DATABASE_URL required');
const pool=process.env.DATABASE_URL?createPool():null;
afterAll(async()=>pool?.end());
it.skipIf(!pool)('sets exact test balance atomically, preserves journal, checks scope, revision and reserves, and replays safely',async()=>{
 const scope={organization_id:id('org'),application_id:id('app'),account_id:id('account')},clock=new ManualClock(new Date('2026-09-19T00:00:00Z')),previous=process.env.UAI_ENV;
 process.env.UAI_ENV='test';const app=createApi(pool!,clock);
 try{
  const tokens=await transaction(pool!,async tx=>{
   await tx.query('INSERT INTO applications(id,organization_id,name) VALUES($1,$2,$3)',[scope.application_id,scope.organization_id,'Balance test']);
   await tx.query('INSERT INTO accounts(id,organization_id,application_id,external_account_id) VALUES($1,$2,$3,$4)',[scope.account_id,scope.organization_id,scope.application_id,id('external')]);
   for(const amount of ['1000000','2000000'])await grant(tx,scope,clock,{amount_units:amount,source:'internal',terms_version:'test',expires_at:null,external_reference:amount,idempotency_key:amount,reason:'Fixture'});
   const base={organization_id:scope.organization_id,application_id:scope.application_id,account_ids:[scope.account_id],max_grant_units:'10000000',expires_at:null};
   return {test:await issueToken(tx,{...base,scopes:['credits:test-balance']}),grant:await issueToken(tx,{...base,scopes:['credits:grant']})};
  });
  const wallet=()=>transaction(pool!,tx=>getWallet(tx,scope,clock));const initial=await wallet();
  const call=(amount:string,revision:number,key:string,token=tokens.test.token,walletId=initial.id)=>app.inject({method:'POST',url:`/v1/wallets/${walletId}/test-balance`,headers:{authorization:`Bearer ${token}`,'idempotency-key':key},payload:{available_units:amount,expected_revision:revision}});
  expect((await call('0',initial.revision,'denied',tokens.grant.token)).statusCode).toBe(403);
  expect((await call('0',initial.revision,'foreign',tokens.test.token,'other-wallet')).statusCode).toBe(404);
  expect((await call('10000001',initial.revision,'limit')).statusCode).toBe(403);
  for(const amount of ['-1','1.2','1e2'])expect((await call(amount,initial.revision,`invalid-${amount}`)).statusCode).toBe(422);
  expect((await call('0',initial.revision-1,'stale')).statusCode).toBe(409);
  // Decrease spans both lots, then replay after a subsequent increase must not reset it again.
  expect((await call('0',initial.revision,'zero')).json().wallet.available_units).toBe('0');
  const empty=await wallet();expect(empty.reserved_units).toBe('0');
  expect((await call('500001',empty.revision,'increase')).json().wallet.available_units).toBe('500001');
  expect((await call('0',initial.revision,'zero')).json().wallet.available_units).toBe('500001');
  expect((await call('1',initial.revision,'zero')).statusCode).toBe(409);
  const before=await wallet();
  const concurrent=await Promise.all([call('1',before.revision,'race-a'),call('2',before.revision,'race-b')]);
  expect(concurrent.map(r=>r.statusCode).sort()).toEqual([200,409]);
  const after=await wallet(),reservedOperation=id('operation');
  await transaction(pool!,tx=>reserve(tx,scope,clock,{operation_id:reservedOperation,max_units:'1',idempotency_key:'reserve'}));
  const held=await wallet();expect((await call('0',held.revision,'reserved')).statusCode).toBe(409);expect(await wallet()).toEqual(held);
  await transaction(pool!,tx=>releaseReservation(tx,scope,clock,{operation_id:reservedOperation,idempotency_key:'release'}));
  const free=await wallet();expect(free.available_units).toBe(after.available_units);
  expect((await call(free.available_units,free.revision,'no-op')).json().wallet.revision).toBe(free.revision);
  process.env.UAI_ENV='production';expect((await call('0',free.revision,'production')).statusCode).toBe(404);expect(await wallet()).toEqual(free);
  const sums=await pool!.query('SELECT sum(amount_units)::text total FROM journal_postings WHERE wallet_id=$1 GROUP BY transaction_id',[initial.id]);expect(sums.rows.every(r=>r.total==='0')).toBe(true);
  expect((await pool!.query("SELECT count(*)::int n FROM grant_revocations WHERE wallet_id=$1 AND status='prepared'",[initial.id])).rows[0].n).toBe(0);
 }finally{await app.close();if(previous===undefined)delete process.env.UAI_ENV;else process.env.UAI_ENV=previous;}
});
