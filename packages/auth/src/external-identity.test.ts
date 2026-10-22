import {describe,it,expect,vi} from 'vitest';
import {authenticate,requireScopes,requireServiceScopes,type Principal} from './index.js';
import {parseExternalIdentity,encodeExternalIdentity,decodeExternalIdentity,type ExternalIdentity} from '../../contracts/external-identity.js';
import type {Tx} from '../../db/src/index.js';
vi.mock('../../db/src/identity.js',()=>({setAuditAccount:vi.fn(async()=>{})}));
const user:ExternalIdentity={version:1,kind:'user',user_id:'person',account_id:'team-a'};
const staff=(role:'admin'|'viewer'):ExternalIdentity=>({version:1,kind:'staff',user_id:'person',role});
const principal:Principal={id:'p',organization_id:'org',application_id:'app',account_ids:null,scopes:['identity:assert','ai:read','ai:execute','wallets:read','accounts:write','accounts:spending','credits:grant','credits:refund','config:write','operations:admin'],max_grant_units:null};
function database(row:Principal|null=principal,exists=true){return {query:vi.fn(async(sql:string)=>({rows:sql.includes('service_tokens')?(row?[row]:[]):exists?[{id:'team-a'}]:[]}))} as unknown as Tx;}
describe('external identity validation and authorization',()=>{
 it('roundtrips unicode IDs as ASCII and takes an immutable copy',()=>{
  const source={...user,user_id:'человек 日本語'};const parsed=parseExternalIdentity(source);source.user_id='changed';
  expect(parsed.user_id).toBe('человек 日本語');expect(Object.isFrozen(parsed)).toBe(true);
  const header=encodeExternalIdentity(parsed);expect(header).toMatch(/^[\x21-\x7e]+$/);expect(decodeExternalIdentity(header)).toEqual(parsed);
 });
 it.each([null,[],{}, {...user,version:2},{...user,user_id:''},{...user,user_id:' '},{...user,user_id:'x'.repeat(201)},{...user,user_id:'a\nb'},{...user,role:'admin'},{...user,application_id:'other'},{version:1,kind:'staff',user_id:'p',role:'owner'},{version:1,kind:'user',user_id:'p'}])('rejects invalid schema %j',value=>expect(()=>parseExternalIdentity(value)).toThrow());
 it.each(['','%','not-json','x'.repeat(4097),'\n','日本語'])('rejects malformed wire encoding %j',header=>expect(()=>decodeExternalIdentity(header)).toThrow());
 it('preserves service-only behavior and verifies service first',async()=>{
  expect(await authenticate(database(),'Bearer '+'t'.repeat(32))).toEqual(principal);
  await expect(authenticate(database(),undefined,'broken')).rejects.toMatchObject({status:401});
 });
 it('rejects assertion without scope and duplicate/malformed header',async()=>{
  await expect(authenticate(database({...principal,scopes:['ai:read']}),'Bearer '+'t'.repeat(32),encodeExternalIdentity(user))).rejects.toMatchObject({status:403});
  for(const header of [[encodeExternalIdentity(user)],encodeExternalIdentity(user)+', '+encodeExternalIdentity(user),'']) await expect(authenticate(database(),'Bearer '+'t'.repeat(32),header)).rejects.toMatchObject({status:400});
 });
 it('intersects account restrictions and verifies application ownership',async()=>{
  const tx=database();const result=await authenticate(tx,'Bearer '+'t'.repeat(32),encodeExternalIdentity(user));
  expect(result.account_ids).toEqual(['team-a']);expect(result.scopes).toEqual(principal.scopes);
  expect(tx.query).toHaveBeenCalledWith(expect.stringContaining('organization_id=$2 AND application_id=$3'),['team-a','org','app']);
  await expect(authenticate(database({...principal,account_ids:['team-b']}),'Bearer '+'t'.repeat(32),encodeExternalIdentity(user))).rejects.toMatchObject({status:404});
  await expect(authenticate(database(principal,false),'Bearer '+'t'.repeat(32),encodeExternalIdentity(user))).rejects.toMatchObject({status:404});
 });
 it('checks the service credential separately for explicitly authorized read routes',()=>{
  const viewer={...principal,identity:staff('viewer')};
  requireServiceScopes(viewer,'config:write');
  expect(()=>requireScopes(viewer,'config:write')).toThrow();
  expect(()=>requireServiceScopes({...viewer,scopes:[]},'config:write')).toThrow();
 });
 it('restricts users and viewers while preserving service scope ceilings for staff',()=>{
  for(const scope of ['accounts:write','accounts:spending','credits:grant','credits:refund','config:write','operations:admin']) expect(()=>requireScopes({...principal,identity:user},scope)).toThrow();
  requireScopes({...principal,identity:user},'ai:execute');
  requireScopes({...principal,identity:staff('viewer')},'ai:read','wallets:read','operations:admin');
  for(const scope of ['ai:execute','credits:grant','config:write','future:read']) expect(()=>requireScopes({...principal,scopes:[...principal.scopes,'future:read'],identity:staff('viewer')},scope)).toThrow();
  expect(()=>requireScopes({...principal,scopes:['identity:assert'],identity:staff('admin')},'config:write')).toThrow();
 });
});
