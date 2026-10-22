import {readFile,writeFile} from 'node:fs/promises';
import {z} from 'zod';
import {paidApiSchemas,paidApiEndpoints} from '../packages/contracts/paid-api.js';
const ref=(name:string)=>({$ref:`#/components/schemas/${name}`});
const schemas=Object.fromEntries(Object.entries(paidApiSchemas).map(([key,schema])=>{const value=z.toJSONSchema(schema);delete value.$schema;return [key,value]}));
const paths:Record<string,any>={};
for(const endpoint of paidApiEndpoints){
 const parameters:any[]=[...endpoint.path.matchAll(/\{([^}]+)\}/g)].map(m=>({in:'path',name:m[1],required:true,schema:{type:'string'}}));
 if('write'in endpoint)parameters.push({in:'header',name:'Idempotency-Key',required:true,schema:{type:'string'}});
 if('revision'in endpoint)parameters.push({in:'header',name:'If-Match',required:true,schema:{type:'integer',minimum:0}});
 (paths[endpoint.path]??={})[endpoint.method]={'x-uai-status':'implemented-local',operationId:endpoint.method+endpoint.path.replaceAll(/[^a-zA-Z0-9]/g,''),security:[{ServiceToken:[]}],'x-required-scopes':['operations:admin',...('write'in endpoint?['config:write']:[])],parameters,...('body'in endpoint?{requestBody:{required:true,content:{'application/json':{schema:ref(endpoint.body)}}}}:{}),responses:{200:{description:'Результат операции.',content:{'application/json':{schema:ref(endpoint.response)}}},409:{description:'Конфликт либо исчерпание allowance',content:{'application/json':{schema:ref('Conflict')}}}}};
}
const content=JSON.stringify({openapi:'3.1.0',info:{title:'UAI paid API extension',version:'pa-i07',description:'Контракт локальной реализации. Полный рабочий API описан в openapi.json. Реальные интеграции проверяются отдельно.'},paths,components:{securitySchemes:{ServiceToken:{type:'http',scheme:'bearer'}},schemas}},null,2)+'\n';
const path=new URL('../docs/openapi-paid-api.json',import.meta.url);
if(process.argv.includes('--check')){if(await readFile(path,'utf8')!==content)throw new Error('Run pnpm generate:paid-api');}else await writeFile(path,content);
console.log('Paid API contract schemas and OpenAPI are synchronized');
