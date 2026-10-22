import {defaultTextOptions} from '../text-options';
import {demoTextInput} from './text-input';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { UaiClient,UaiError,type OperationResponse } from '@uai/sdk';
import { sessions,SessionError } from '../../../../packages/web-session/src/index.js';
import {paidApiInput} from '../paid-api-settings';
import { DemoStore } from './store';
import {usableRecipes,componentInput,componentParameters,type DemoRecipe} from '../profile-settings';
/** The demo makes single calls and recipes; a reserve pool quote has no recipe. */
function recipeOf(quote:{recipe:{key:string;version:number}|null}){if(!quote.recipe)throw new Error('Reserve pools are not run by the demo');return quote.recipe;}
async function recipeFor(client:UaiClient,accountId:string,key:string,version?:number){
 const response=await client.request<{data:DemoRecipe[]}>('GET',`/v1/recipes?account_id=${encodeURIComponent(accountId)}`);
 const recipe=response.data.filter(row=>row.key===key&&(version===undefined||row.version===version)).sort((a,b)=>b.version-a.version)[0];
 if(!recipe||!usableRecipes([recipe]).length)throw new SessionError(422,'Этот опубликованный профиль не поддерживается в demo.');return recipe;
}
interface Config {jev?:{profile:string;fixture?:boolean};paid_api?:{subscription_id:string;read_token:string;profiles:Array<{operation:string;profile:string}>};api_url:string;account_id:string;wallet_id:string;app_token:string;grant_token:string;session_secret:string;login_password:string;max_grant_units:string}
const config=async():Promise<Config>=>JSON.parse(await readFile(process.env.UAI_DEMO_CONFIG??resolve('.data/demo-config.json'),'utf8'));
export async function handle(request:Request):Promise<Response>{
 try{
  const conf=await config(),auth=sessions('uai_demo',conf.session_secret,conf.login_password),store=new DemoStore(process.env.UAI_DEMO_ROOT??resolve('.data/demo'));
  const client=new UaiClient({baseUrl:conf.api_url,token:conf.app_token});
  auth.csrf(request);
  const body=request.method==='POST'?await request.json():{};
  if(body.action==='login'){const cookie=auth.login(request,String(body.password??''));return Response.json({ok:true},{headers:{'set-cookie':cookie}})}
  auth.verify(request);
  if(request.method==='GET'&&new URL(request.url).searchParams.has('events')){
   const controller=new AbortController();request.signal.addEventListener('abort',()=>controller.abort(),{once:true});const encoder=new TextEncoder();
   const stream=new ReadableStream({async start(output){try{for await(const event of client.events({account_id:conf.account_id,lastEventId:request.headers.get('last-event-id')??undefined,signal:controller.signal})){output.enqueue(encoder.encode(`${event.id?`id: ${event.id}\n`:''}data: ${JSON.stringify(event)}\n\n`));}}catch{if(!controller.signal.aborted)output.enqueue(encoder.encode('event: reconnect\ndata: {}\n\n'));}finally{try{output.close()}catch{}}},cancel(){controller.abort()}});
   return new Response(stream,{headers:{'content-type':'text/event-stream','cache-control':'no-cache','x-accel-buffering':'no'}});
  }
  const assetId=new URL(request.url).searchParams.get('asset');
  if(request.method==='GET'&&assetId){const asset=await store.readAsset(assetId);if(!asset)throw new SessionError(404,'Файл не найден.');return new Response(new Uint8Array(asset.bytes),{headers:{'content-type':asset.media_type,'cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; sandbox"}})}
  if(request.method==='GET'&&new URL(request.url).searchParams.has('transactions_cursor'))return Response.json(await client.wallets.transactions(conf.wallet_id,{cursor:new URL(request.url).searchParams.get('transactions_cursor')??undefined}));
  if(request.method==='GET')return Response.json({wallet:await client.wallets.get(conf.wallet_id),history:await store.read(),profiles:await client.request('GET','/v1/profiles'),recipes:await client.request('GET',`/v1/recipes?account_id=${encodeURIComponent(conf.account_id)}`),transactions:await client.wallets.transactions(conf.wallet_id),test_grant_enabled:process.env.UAI_ENV==='test',max_grant_units:conf.max_grant_units});
  if(body.action==='jev_status')return Response.json({enabled:!!conf.jev,profile:conf.jev?.profile,fixture:conf.jev?.fixture===true});
  if(body.action==='jev_quote'){
   if(!conf.jev)throw new SessionError(422,'Профиль Jev не подключён.');
   return Response.json(await client.services.quote({account_id:conf.account_id,wallet_id:conf.wallet_id,profile:conf.jev.profile,input:body.input},body.key));
  }
  if(body.action==='api_status'){
   if(!conf.paid_api)return Response.json({enabled:false});
   const reader=new UaiClient({baseUrl:conf.api_url,token:conf.paid_api.read_token});
   return Response.json({enabled:true,profiles:conf.paid_api.profiles,allowance:await reader.allowance.get(conf.paid_api.subscription_id)});
  }
  if(body.action==='api_quote'){
   const selected=conf.paid_api?.profiles.find(p=>p.operation===body.operation);
   if(!selected)throw new SessionError(422,'Эта API-операция не подключена к demo.');
   if(typeof body.value!=='string'||!body.value.trim()||body.value.length>2000||typeof body.key!=='string'||!/^[-a-zA-Z0-9]{1,100}$/.test(body.key))throw new SessionError(422,'Введите запрос до 2000 символов.');
   const response=await client.request<{data:Array<{key:string;version:number;definition:{components:Array<{capability:string}>}}>}>('GET',`/v1/recipes?account_id=${encodeURIComponent(conf.account_id)}`);
   const recipe=response.data.filter(r=>r.key===selected.profile).sort((a,b)=>b.version-a.version)[0];
   if(!recipe||recipe.definition.components.length!==1||recipe.definition.components[0].capability!=='api.call')throw new SessionError(422,'Опубликованный API-профиль недоступен.');
   return Response.json(await client.services.quote({recipe:{key:recipe.key,version:recipe.version},account_id:conf.account_id,wallet_id:conf.wallet_id,kind:'single_call',profile:recipe.key,input:paidApiInput(body.operation,body.value)},body.key));
  }
  if(body.action==='grant'){
   if(process.env.UAI_ENV!=='test')throw new SessionError(403,'Тестовые начисления отключены.');
   if(typeof body.amount_credits!=='string'||!/^\d+(\.\d{1,6})?$/.test(body.amount_credits))throw new SessionError(422,'Укажите положительное количество кредитов.');
   const[a,b='']=body.amount_credits.split('.'),amount=BigInt(a)*1000000n+BigInt(b.padEnd(6,'0'));
   if(amount<=0n||amount>BigInt(conf.max_grant_units))throw new SessionError(422,'Сумма превышает тестовый предел.');
   if(typeof body.key!=='string'||!/^[-a-zA-Z0-9]{1,100}$/.test(body.key))throw new SessionError(422,'Нужен идентификатор начисления.');
   // The expiry is tied to the client command identity so a network retry preserves the body.
   const grantClient=new UaiClient({baseUrl:conf.api_url,token:conf.grant_token});
   return Response.json(await grantClient.wallets.grant(conf.wallet_id,{amount_units:amount.toString(),source:'internal',external_reference:`demo:${body.key}`,terms_version:'demo-test-v1',expires_at:null,reason:'Начисление авторизованному тестовому пользователю demo'},body.key));
  }
  if(body.action==='set_balance'){
   if(process.env.UAI_ENV!=='test')throw new SessionError(403,'Установка тестового остатка отключена.');
   if(typeof body.amount_credits!=='string'||!/^\d+(\.\d{1,6})?$/.test(body.amount_credits))throw new SessionError(422,'Укажите остаток от 0, до 6 знаков после точки.');
   const [whole,fraction='']=body.amount_credits.split('.'),amount=BigInt(whole)*1000000n+BigInt(fraction.padEnd(6,'0'));
   if(amount>BigInt(conf.max_grant_units))throw new SessionError(422,'Остаток превышает тестовый предел.');
   if(typeof body.key!=='string'||!/^[-a-zA-Z0-9]{1,100}$/.test(body.key)||!Number.isSafeInteger(body.expected_revision)||body.expected_revision<0)throw new SessionError(422,'Обновите баланс и повторите.');
   const testClient=new UaiClient({baseUrl:conf.api_url,token:conf.grant_token});
   return Response.json(await testClient.request('POST',`/v1/wallets/${conf.wallet_id}/test-balance`,{available_units:amount.toString(),expected_revision:body.expected_revision},{key:body.key}));
  }
  if(body.action==='upload_reference'){
   if(!['image/png','image/jpeg','image/webp'].includes(body.media_type)||typeof body.base64!=='string'||body.base64.length>14000000||!/^[a-zA-Z0-9+/]*={0,2}$/.test(body.base64))throw new SessionError(422,'Нужен PNG, JPEG или WebP до 10 МБ.');
   if(typeof body.key!=='string'||!/^[-a-zA-Z0-9]{1,100}$/.test(body.key))throw new SessionError(422,'Нужен идентификатор загрузки.');
   const bytes=Buffer.from(body.base64,'base64');if(!bytes.length||bytes.length>10000000)throw new SessionError(422,'Неверный размер файла.');
   const asset=await client.assets.upload({account_id:conf.account_id,media_type:body.media_type,size_bytes:bytes.length,content_hash:`sha256:${createHash('sha256').update(bytes).digest('hex')}`},bytes,body.key);
   return Response.json({id:asset.id});
  }
  if(body.action==='quote'){
   if(typeof body.prompt!=='string'||!body.prompt.trim()||body.prompt.length>16000)throw new SessionError(422,'Введите запрос до 16 000 символов.');
   const key=String(body.key??randomUUID()),profile=String(body.profile??'text.standard');
   const recipe=await recipeFor(client,conf.account_id,profile),component=recipe.definition.components[0],composite=recipe.definition.components.length>1;
   const quote=await client.quotes.create({recipe:{key:recipe.key,version:recipe.version},account_id:conf.account_id,wallet_id:conf.wallet_id,kind:composite?'recipe':'single_call',profile,...(composite?{}:{...(body.text_options&&component.capability==='text.generate'?{input:demoTextInput(component,body.prompt,body.asset_ids??[],{...defaultTextOptions,...body.text_options}),delivery:{stream:body.text_options.stream===true}}:{input:componentInput(component,body.prompt,body.asset_ids??[])}),parameters:componentParameters(component,body.parameters??{})})},key);
   return Response.json(quote);
  }
  if(body.action==='invoke'){
   if(typeof body.quote_id!=='string'||typeof body.key!=='string')throw new SessionError(422,'Нужна принятая оценка.');
   const acceptedQuote=await client.quotes.get(body.quote_id);
   if(acceptedQuote.kind==='recipe'){
    const recipe=await recipeFor(client,conf.account_id,recipeOf(acceptedQuote).key,recipeOf(acceptedQuote).version);
    if(recipe.definition.components.length!==2)throw new SessionError(422,'Неподдерживаемая составная операция.');
    const operation=await client.operations.create({quote_id:body.quote_id,client_operation_key:body.key},body.key);
    const opId=String(operation.id);
    await store.update(rows=>{if(!rows.some(r=>r.id===body.key))rows.unshift({id:body.key,title:String(body.prompt??'Составная операция').slice(0,80),created_at:new Date().toISOString(),messages:[{role:'user',text:String(body.prompt??'')}],operation_id:opId,status:'running',profile:recipe.key,quote_id:body.quote_id,components:recipe.definition.components,request_ids:{},results:{},estimate_only:acceptedQuote.estimate_only,settlement:acceptedQuote.settlement,estimated_units:acceptedQuote.estimated_units,max_units:String(operation.accepted_max_units)})});
    return Response.json({operation_id:opId});
   }
   const ids=await client.request<{operation_id:string;request_id:string;accepted_max_units:string}>('POST','/v1/invocations',{account_id:conf.account_id,quote_id:body.quote_id},{key:body.key});
   await store.update(rows=>{if(!rows.some(r=>r.id===body.key))rows.unshift({id:body.key,title:String(body.prompt??'Новая операция').slice(0,80),created_at:new Date().toISOString(),messages:[{role:'user',text:String(body.prompt??'')}],operation_id:ids.operation_id,request_id:ids.request_id,status:'queued',profile:recipeOf(acceptedQuote).key,quote_id:body.quote_id,estimate_only:acceptedQuote.estimate_only,settlement:acceptedQuote.settlement,estimated_units:acceptedQuote.estimated_units,max_units:ids.accepted_max_units})});
   return Response.json(ids);
  }
  if(body.action==='refresh')return await store.withConversation(String(body.id),async()=>{
   const row=(await store.read()).find(r=>r.id===body.id);
   if(row?.request_ids&&row.operation_id){
    if(!row.components&&row.quote_id){const quote=await client.quotes.get(row.quote_id);row.components=(await recipeFor(client,conf.account_id,recipeOf(quote).key,recipeOf(quote).version)).definition.components;}
    return Response.json(await advanceComposite(client,store,row));
   }
   if(!row?.request_id)throw new SessionError(404,'Диалог не найден.');
   const result=await client.requests.get(row.request_id);
   const operation=row.operation_id?await client.operations.get(row.operation_id):undefined;
   const diagnostics=await client.request('GET',`/v1/requests/${encodeURIComponent(row.request_id)}/diagnostics`);
   await store.update(rows=>{const current=rows.find(r=>r.id===row.id);if(current){current.diagnostics=diagnostics;current.operation=operation;}});
   if(result.result){
    const files:string[]=[];
    for(const asset of result.result.assets)files.push(await store.saveAsset(asset,await client.assets.download(asset.id)));
    await store.update(rows=>{const current=rows.find(r=>r.id===row.id);if(current){current.result=result.result;current.files=files;current.status=result.execution_status;}});
    if(result.delivery)await client.requests.acknowledge(row.request_id,{result_version:result.delivery.result_version,manifest_hash:result.delivery.manifest_hash},`ack:${row.request_id}`);
   }else await store.update(rows=>{const current=rows.find(r=>r.id===row.id);if(current)current.status=result.execution_status});
   return Response.json({request:result,wallet:await client.wallets.get(conf.wallet_id),history:await store.read()});
  });
  if(body.action==='cancel'||body.action==='delete')return await store.withConversation(String(body.id),async()=>{
   const row=(await store.read()).find(r=>r.id===body.id);if(!row)throw new SessionError(404,'Диалог не найден.');
   if(body.action==='cancel'&&row.operation_id){
    const operation=await client.operations.cancel(row.operation_id,`cancel:${row.id}`);
    await store.update(rows=>{const current=rows.find(r=>r.id===row.id);if(current){current.operation=operation;current.wallet=operation.wallet;current.status=current.request_ids?compositeStatus(operation,current.results??{}):operation.requests.find(request=>request.id===current.request_id)?.execution_status??current.status}});
    if(row.request_ids)await advanceComposite(client,store,row);
    return Response.json(operation);
   }
   if(row.operation_id)await client.content.delete({account_id:conf.account_id,scope:{operation_id:row.operation_id},reason:'Диалог удалён пользователем demo'},`delete:${row.id}`);
   await store.remove(row.id);return Response.json({deleted:true});
  });
  throw new SessionError(400,'Неизвестное действие.');
 }catch(error){if(error instanceof UaiError)return Response.json({error:error.error.code==='insufficient_credits'?'Недостаточно доступных кредитов. Пополните баланс или уменьшите стоимость запроса.':error.error.code==='allowance_exhausted'?'Недостаточно квоты Firecrawl для резерва этого вызова. Дождитесь освобождения резервов или измените лимит в админке.':error.error.message,code:error.error.code},{status:error.status});if(error instanceof SessionError)return Response.json({error:error.message},{status:error.status});return Response.json({error:'Тестовый backend недоступен. Проверьте локальную конфигурацию.'},{status:503})}
}

function compositeStatus(operation:OperationResponse,results:Record<string,unknown>){
 if(operation.execution_status==='running')return 'running';
 if(operation.execution_status==='canceled')return 'canceled';
 if(results.description&&results.image)return 'succeeded';
 if(operation.admission_status==='closed')return Object.keys(results).length?'partial':'failed';
 return 'running';
}
async function advanceComposite(client:UaiClient,store:DemoStore,row:import('./store').Conversation){
 const operationId=row.operation_id!,ids={...row.request_ids},results={...row.results};
 let operation=await client.operations.get(operationId);
 // Recover a request that UAI accepted before the local history write completed.
 for(const request of operation.requests)if(['description','image'].includes(request.component))ids[request.component]=request.id;
 const persistOperation=async()=>store.update(rows=>{const current=rows.find(r=>r.id===row.id);if(current){current.request_ids={...ids};current.operation=operation;current.wallet=operation.wallet;current.status=compositeStatus(operation,results)}});
 for(const component of ['description','image']){
  if(!ids[component]){
   if(operation.admission_status==='closed')break;
   const description=(results.description as any)?.content?.text??row.messages[0]?.text??'';
   const settings=row.components?.find(c=>c.key===component);if(!settings)throw new SessionError(422,'Не найдены настройки принятого профиля.');
   const request=await client.operations.createRequest(operationId,{component,client_request_key:`${row.id}:${component}`,kind:settings.capability,input:componentInput(settings,component==='description'?row.messages[0]?.text??'':description),parameters:componentParameters(settings)},`${row.id}:${component}`);
   ids[component]=request.id;await store.update(rows=>{const current=rows.find(r=>r.id===row.id);if(current)current.request_ids={...ids}});
  }
  const request=await client.requests.get(ids[component]);
  const diagnostics=await client.request('GET',`/v1/requests/${encodeURIComponent(request.id)}/diagnostics`);operation=await client.operations.get(operationId);
  await store.update(rows=>{const current=rows.find(r=>r.id===row.id);if(current){const previous=current.steps?.[component] as {wallet?:unknown}|undefined;current.steps={...current.steps,[component]:{status:request.execution_status,diagnostics,wallet:results[component]&&previous?.wallet?previous.wallet:operation.wallet}};current.operation=operation}});
  if(request.result&&!results[component]){
   const files:string[]=[];for(const asset of request.result.assets)files.push(await store.saveAsset(asset,await client.assets.download(asset.id)));
   results[component]=request.result;
   await store.update(rows=>{const current=rows.find(r=>r.id===row.id);if(current){current.results={...results};current.files=[...new Set([...(current.files??[]),...files])];current.result={content:{text:(results.description as any)?.content?.text},assets:(results.image as any)?.assets??[]};}});
  }
  if(results[component]){
   // A failed ACK must be retried even when the durable result already exists.
   if(request.delivery)await client.requests.acknowledge(request.id,{result_version:request.delivery.result_version,manifest_hash:request.delivery.manifest_hash},`ack:${request.id}`);
  }else{
   const finished=['failed','canceled'].includes(request.execution_status);
   if(finished&&operation.admission_status==='open')operation=await client.operations.finishPartial(operationId,`partial:${row.id}`);
   await persistOperation();
   if(!finished)await store.update(rows=>{const current=rows.find(r=>r.id===row.id);if(current)current.status=request.execution_status});
   return {request,history:await store.read()};
  }
 }
 if(operation.admission_status==='open'&&results.description&&results.image)operation=await client.operations.complete(operationId,`complete:${row.id}`);
 await persistOperation();
 return {history:await store.read()};
}
