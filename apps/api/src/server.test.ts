import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, transaction } from '../../../packages/db/src/index.js';
import { id } from '../../../packages/contracts/src/index.js';
import { issueToken } from '../../../packages/auth/src/index.js';
import { createApi } from './server.js';
if(process.env.REQUIRE_INTEGRATION_TESTS==='1'&&!process.env.DATABASE_URL)throw new Error('DATABASE_URL required');
const suite=process.env.DATABASE_URL?describe:describe.skip;
suite('API scopes and financial replay',()=>{
 const pool=createPool(process.env.DATABASE_URL??'postgresql://unused');const api=createApi(pool);
 const org=id('org'),application=id('app');let admin='',reader='',wallet='',otherWallet='';
 beforeAll(async()=>{
  await pool.query('INSERT INTO applications(id,organization_id,name) VALUES($1,$2,$3)',[application,org,'API test']);
  admin=(await transaction(pool,tx=>issueToken(tx,{organization_id:org,application_id:application,account_ids:null,scopes:['accounts:write','credits:grant','wallets:read','ai:read'],max_grant_units:'1000000000',expires_at:null}))).token;
  const create=async(ext:string)=>(await api.inject({method:'POST',url:'/v1/accounts',headers:{authorization:`Bearer ${admin}`,'idempotency-key':ext},payload:{external_account_id:ext,create_wallet:{credit_unit_id:'ai-credit-usd-v1'}}})).json();
  const first=await create('first');wallet=first.wallet.id;otherWallet=(await create('second')).wallet.id;
  reader=(await transaction(pool,tx=>issueToken(tx,{organization_id:org,application_id:application,account_ids:[first.id],scopes:['wallets:read'],max_grant_units:null,expires_at:null}))).token;
 });
 afterAll(async()=>{await api.close();await pool.end()});
 const grant={amount_units:'10000000',source:'internal',external_reference:'test-grant',terms_version:'test-v1',expires_at:null,reason:'API integration test'};
 it('rejects missing authentication',async()=>{expect((await api.inject(`/v1/wallets/${wallet}`)).statusCode).toBe(401)});
 it('denies grants for ordinary app token',async()=>{expect((await api.inject({method:'POST',url:`/v1/wallets/${wallet}/grants`,headers:{authorization:`Bearer ${reader}`,'idempotency-key':'denied'},payload:grant})).statusCode).toBe(403)});
 it('returns one grant for concurrent same commands',async()=>{
  const run=()=>api.inject({method:'POST',url:`/v1/wallets/${wallet}/grants`,headers:{authorization:`Bearer ${admin}`,'idempotency-key':'same'},payload:grant});
  const responses=await Promise.all([run(),run(),run()]);expect(responses.map(r=>r.statusCode)).toEqual([200,200,200]);expect(new Set(responses.map(r=>r.json().grant_id)).size).toBe(1);
  const balance=await api.inject({url:`/v1/wallets/${wallet}`,headers:{authorization:`Bearer ${reader}`}});expect(balance.json().available_units).toBe('10000000');
 });
 it('rejects changed body on replay',async()=>{expect((await api.inject({method:'POST',url:`/v1/wallets/${wallet}/grants`,headers:{authorization:`Bearer ${admin}`,'idempotency-key':'same'},payload:{...grant,amount_units:'20000000'}})).statusCode).toBe(409)});
 it('does not reveal other account wallets',async()=>{expect((await api.inject({url:`/v1/wallets/${otherWallet}`,headers:{authorization:`Bearer ${reader}`}})).statusCode).toBe(404)});
 it('enforces token grant ceiling before ledger',async()=>{expect((await api.inject({method:'POST',url:`/v1/wallets/${wallet}/grants`,headers:{authorization:`Bearer ${admin}`,'idempotency-key':'large'},payload:{...grant,amount_units:'1000000001'}})).statusCode).toBe(403)});
 it('requires explicit expiry and reason',async()=>{const{expires_at,...missing}=grant;expect((await api.inject({method:'POST',url:`/v1/wallets/${wallet}/grants`,headers:{authorization:`Bearer ${admin}`,'idempotency-key':'missing'},payload:missing})).statusCode).toBe(422)});
});
