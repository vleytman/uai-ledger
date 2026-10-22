import {it,expect} from 'vitest';
import {cacheIdentity,cacheForecast} from '../src/cache.js';
const scope={organization_id:'org',application_id:'app',account_id:'account'};
const input={instructions:'instructions',messages:[{role:'user',content:[{type:'text',text:'stable private content',cache:{boundary:'stable_prefix',ttl_seconds:300}},{type:'text',text:'dynamic suffix'}]}]};
const identity=(value:any=input,assets:any[]=[],preparation:any={mode:'preserve'},subject=scope,connection='connection',model='model')=>cacheIdentity(subject,connection,model,value,assets,preparation)!;
it('cache identity isolates account, connection, model, schema, tools, preparation and prefix without retaining content',()=>{
 const baseline=identity();expect(JSON.stringify(baseline)).not.toContain('private content');
 expect(identity({...input,messages:[{role:'user',content:[input.messages[0].content[0],{type:'text',text:'new suffix'}]}]})).toEqual(baseline);
 for(const changed of [identity({...input,instructions:'other'}),identity({...input,response_schema:{type:'string'}}),identity({...input,tools:[{name:'other'}]}),identity(input,[],{mode:'transform'}),identity(input,[],undefined,{...scope,account_id:'other'}),identity(input,[],undefined,scope,'other'),identity(input,[],undefined,scope,'connection','other')])expect(changed.digest).not.toBe(baseline.digest);
 expect(identity({messages:[{role:'user',content:'no boundary'}]})).toBeUndefined();
});
it('image content and preparation metadata affect identity; storage IDs alone do not',()=>{
 const value={messages:[{role:'user',content:[{type:'image',asset_id:'asset',cache:{boundary:'stable_prefix'}}]}]},asset={id:'asset',sha256:'bytes',width:64,height:64,format:'png'};
 const base=identity(value,[asset]);
 expect(identity({messages:[{role:'user',content:[{...value.messages[0].content[0],asset_id:'copy'}]}]},[{...asset,id:'copy'}])).toEqual(base);
 for(const changed of [{sha256:'other'},{width:128},{format:'jpeg'}])expect(identity(value,[{...asset,...changed}]).digest).not.toBe(base.digest);
});
it('a missing or expired observation stays cold and retains full-price items',async()=>{
 const now=new Date('2026-09-25T00:00:00Z'),items=[{dimension:'input.uncached',unit:'tokens',quantity:'100'}];let query='',values:any[]=[];
 const tx={query:async(sql:string,args:any[])=>{query=sql;values=args;return {rows:[]}}};
 const result=await cacheForecast(tx as any,scope,{now:()=>now},'connection','model',identity(),items,{} as any,{} as any,{} as any,'100');
 expect(result).toEqual({confidence:'cold',cold_estimate_units:'100',expected_estimate_units:'100',expected_items:items});expect(query).toContain('expires_at>$7');expect(values.at(-1)).toEqual(now);
});

it('cache forecasts do not cross routing keys, retention, service tier or reasoning settings',()=>{
 const digest=(parameters:Record<string,unknown>)=>cacheIdentity(scope,'connection','model',input,[],{},parameters)!.digest;
 const baseline=digest({prompt_cache_key:'one'});
 expect(digest({prompt_cache_key:'one',max_output_tokens:32})).toBe(baseline);
 for(const parameters of [{prompt_cache_key:'two'},{prompt_cache_key:'one',service_tier:'priority'},{prompt_cache_key:'one',prompt_cache_retention:'in_memory'},{prompt_cache_key:'one',reasoning:{effort:'low'}}])expect(digest(parameters)).not.toBe(baseline);
});
