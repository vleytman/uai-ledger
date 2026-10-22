import {afterAll,describe,it,expect} from 'vitest';
import {createPool,transaction,emit} from '../../../packages/db/src/index.js';
import {id,type Scope} from '../../../packages/contracts/src/index.js';
import {issueToken} from '../../../packages/auth/src/index.js';
import {UaiClient} from '../../../packages/sdk/src/index.js';
import {createApi} from './server.js';
const pool=process.env.DATABASE_URL?createPool():null;afterAll(async()=>pool?.end());
describe.skipIf(!pool)('Live SSE isolation and reconnection',()=>{
 it('A32 A90 resumes after Last-Event-ID, filters another account, closes on revoked credentials',async()=>{
  const scope:Scope={organization_id:id('org'),application_id:id('app'),account_id:id('account')},other={...scope,account_id:id('account')};
  const auth=await transaction(pool!,async tx=>{await tx.query('INSERT INTO applications(id,organization_id,name) VALUES($1,$2,$3)',[scope.application_id,scope.organization_id,'SSE test']);for(const s of [scope,other])await tx.query('INSERT INTO accounts(id,organization_id,application_id,external_account_id) VALUES($1,$2,$3,$4)',[s.account_id,s.organization_id,s.application_id,s.account_id]);return issueToken(tx,{...scope,account_ids:[scope.account_id],scopes:['ai:read'],max_grant_units:null,expires_at:null})});
  const first=await transaction(pool!,tx=>emit(tx,scope,'wallet.changed',{type:'wallet',id:'wallet-fixture'},{revision:1}));
  const app=createApi(pool!);const base=await app.listen({host:'127.0.0.1',port:0});const client=new UaiClient({baseUrl:base,token:auth.token});let controller=new AbortController();let events=client.events({account_id:scope.account_id,signal:controller.signal});
  try{
   const a=await events.next();expect(a.value?.id).toBe(first);controller.abort();await events.return(undefined);
   const foreign=await transaction(pool!,tx=>emit(tx,other,'wallet.changed',{type:'wallet',id:'other'},{revision:99}));
   const second=await transaction(pool!,tx=>emit(tx,scope,'wallet.changed',{type:'wallet',id:'wallet-fixture'},{revision:2}));
   controller=new AbortController();events=client.events({account_id:scope.account_id,lastEventId:first,signal:controller.signal});const b=await events.next();expect(b.value?.id).toBe(second);expect(b.value?.account_id).toBe(scope.account_id);
   const forbidden=await fetch(`${base}/v1/events`,{headers:{authorization:`Bearer ${auth.token}`,'last-event-id':foreign}});expect(forbidden.status).toBe(409);
   await pool!.query('UPDATE service_tokens SET revoked_at=now() WHERE id=$1',[auth.principal.id]);expect((await events.next()).done).toBe(true);
   expect((await pool!.query('SELECT count(*)::int count FROM execution_requests WHERE application_id=$1',[scope.application_id])).rows[0].count).toBe(0);
  }finally{controller.abort();await events.return(undefined).catch(()=>{});await app.close()}
 });
});
