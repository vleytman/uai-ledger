import {createApi} from '../../../apps/api/src/server.js';
import {issueToken} from '../../auth/src/index.js';
import {UaiClient} from '../../sdk/src/index.js';
import {afterAll,it,expect} from 'vitest';
import {createPool,transaction} from '../../db/src/index.js';
import {ManualClock,id,type Scope} from '../../contracts/src/index.js';
import {forecastCalls} from '../src/forecast.js';
const pool=process.env.DATABASE_URL?createPool():null;
afterAll(async()=>{await pool?.end()});
it.skipIf(!pool)('LF-A10 LF-A11 forecasts versioned calls in a PostgreSQL read-only transaction',async()=>{
 const scope:Scope={organization_id:id('org'),application_id:id('app'),account_id:id('account')};
 const rate=id('rate'),catalog=id('catalog'),route=id('route'),profile=id('profile'),clock=new ManualClock(new Date('2026-09-25T00:00:00Z'));
 const card={id:rate,currency:'USD',source:'Synthetic fixture only',checked_at:clock.now().toISOString(),rates:[{id:'input',dimension:'input.uncached',unit:'tokens',unit_size:'1',amount:'0.000000001',effective_from:'2026-01-01'},{id:'output',dimension:'output.text',unit:'tokens',unit_size:'1',amount:'0.000000002',effective_from:'2026-01-01'}]};
 const maximum_items=[{dimension:'input.uncached',unit:'tokens',quantity:'1000'},{dimension:'output.text',unit:'tokens',quantity:'1000'}];
 for(const [key,kind,payload] of [[rate,'rate_card',card],[catalog,'catalog',{models:[{id:'fixture',provider:'fake',status:'active',capabilities:['text.generate'],allowed_parameters:[]}]}],[route,'route',{capability:'text.generate',primary:{catalog_version_id:catalog,model:'fixture',connection_id:'fixture',max_cost_units:'100000'},platform_risk_budget_units:'100000'}]] as const)await pool!.query("INSERT INTO configuration_versions(id,organization_id,application_id,kind,key,version,status,payload,author,comment,created_at,published_at) VALUES($1,$2,$3,$4,$1,1,'published',$5,'fixture','Synthetic fixture',now(),now())",[key,scope.organization_id,scope.application_id,kind,JSON.stringify(payload)]);
 await pool!.query('INSERT INTO recipe_versions(id,organization_id,application_id,key,version,definition,created_at,actor_id) VALUES($1,$2,$3,$1,1,$4,now(),$5)' ,[profile,scope.organization_id,scope.application_id,JSON.stringify({components:[{key:'call',capability:'text.generate',count:{constant:1},route_version_id:route,rate_card_version_id:rate,maximum_items,limits:{}}]}),"fixture"]);
 await pool!.query('INSERT INTO applications(id,organization_id,name) VALUES($1,$2,$3)',[scope.application_id,scope.organization_id,'Forecast fixture']);
 await pool!.query('INSERT INTO accounts(id,organization_id,application_id,external_account_id) VALUES($1,$2,$3,$4)',[scope.account_id,scope.organization_id,scope.application_id,id('external')]);
 const body={account_id:scope.account_id,calls:[{profile,count:3,volumes:[{dimension:'input.uncached',unit:'tokens',quantity:'100'},{dimension:'output.text',unit:'tokens',quantity:'50'}]}]};
 const read=()=>transaction(pool!,async tx=>{await tx.query('SET TRANSACTION READ ONLY');return forecastCalls(tx,scope,clock,body)});
 const result=await read();expect(result).toMatchObject({provider_cost:{expected_units:'600',low_units:'300',high_units:'1200'},customer_charge:{expected_units:'600'},range_is_charge_cap:false,confidence:{category:'low',reasons:['caller_supplied_volumes','heuristic_token_range']}});
 expect(await read()).toEqual(result);expect(result.calls[0].versions).toEqual({profile_id:profile,route_id:route,catalog_id:catalog,rate_card_id:rate});
 for(const calls of [[],[{...body.calls[0],volumes:[]}],[{...body.calls[0],volumes:[{dimension:'output.text',unit:'tokens',quantity:'1'}]}],[{...body.calls[0],profile:'missing'}]])await expect(forecastCalls(pool!,scope,clock,{...body,calls})).rejects.toThrow();
 const token=await transaction(pool!,tx=>issueToken(tx,{...scope,scopes:['ai:quote'],account_ids:[scope.account_id],max_grant_units:null,expires_at:null}));
 const app=createApi(pool!,clock);const sdk=new UaiClient({baseUrl:'http://fixture',token:token.token,fetch:async(url,options)=>{const response=await app.inject({method:options!.method as any,url:new URL(String(url)).pathname,headers:options!.headers as any,payload:options!.body as string});return new Response(response.body,{status:response.statusCode,headers:{'content-type':'application/json'}})}});
 try{expect(await sdk.ai.forecast(body)).toEqual(result);await expect(sdk.ai.forecast({...body,account_id:id('other')})).rejects.toMatchObject({status:404});
 for(const table of ['quotes','operations','wallets','execution_requests'])expect((await pool!.query(`SELECT count(*)::int n FROM ${table} WHERE organization_id=$1`,[scope.organization_id])).rows[0].n).toBe(0);
 }finally{await app.close()}

});
