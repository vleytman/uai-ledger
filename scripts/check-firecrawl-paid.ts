/** Explicit, bounded live acceptance. Default mode prints the proposal and makes no network calls. */
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {FirecrawlAdapter} from '../packages/providers/src/firecrawl.js';
import {parseConfiguration} from '../packages/configuration/src/index.js';
import type {ProviderInput} from '../packages/providers/src/contracts.js';
const scenarios=[
 {operation:'scrape',input:{url:'https://example.com',formats:['markdown']},expected_credits:1},
 {operation:'search',input:{query:'site:uspto.gov patent search',limit:1,scrape:false},expected_credits:2},
 {operation:'patent_search',input:{query:'"quantum computing".ti.',page_size:1,start:0},expected_credits:5},
 {operation:'patent_document',input:{number:'11234567',include_full_text:false},expected_credits:5},
];
const execute=process.argv.includes('--execute'),budgetArg=process.argv.find(v=>v.startsWith('--max-credits=')),budget=Number(budgetArg?.split('=')[1]??20);
if(!Number.isSafeInteger(budget)||budget<13||budget>50)throw new Error('Use a reviewed credit budget between 13 and 50');
if(!execute){console.log(JSON.stringify({mode:'proposal',scenarios,expected_credits:13,max_credits:budget,retries:0,warning:'Expected patent costs came from the provider UI. Verify the account tariff before approval. No external calls made.'},null,2));}
else{
 if(process.env.UAI_FIRECRAWL_PAID_APPROVED!=='yes')throw new Error('Explicit paid-run approval required');
 const apiKey=process.env.FIRECRAWL_API_KEY;if(!apiKey)throw new Error('Set FIRECRAWL_API_KEY securely; do not print the key');
 const adapter=new FirecrawlAdapter({apiKey,models:scenarios.map(s=>`firecrawl.${s.operation}`)});
 const before=await adapter.readCreditUsage();if(Number(before.remaining)<budget)throw new Error('Insufficient included provider credits; do not trigger automatic top-up');
 let spent=0;
 for(const scenario of scenarios){
  if(spent+scenario.expected_credits>budget)throw new Error('Credit budget exhausted; no further calls');
  const document=parseConfiguration(JSON.parse(await readFile(new URL(`../configurations/api/firecrawl/${scenario.operation}.json`,import.meta.url),'utf8'))),model=document.resources.find(r=>r.kind==='catalog')!.payload.models[0];
  const input:ProviderInput={capability:'api.call',model:model.id,api_operation:model.api,input:'',structured:scenario.input};
  const result=await adapter.execute(input,{attempt_id:randomUUID(),onUsage:async()=>{}});
  const credits=result.usage.state==='known'?result.usage.items.find(i=>i.dimension==='credits')?.quantity:undefined;
  console.log(JSON.stringify({operation:scenario.operation,outcome:result.outcome,credits:credits??null,provider_request_id:result.provider_request_id??null}));
  if(result.outcome!=='success'||credits===undefined)throw new Error('Stop after failure or unknown usage. Do not retry automatically.');
  spent+=Number(credits);if(spent>budget)throw new Error('Observed provider charge exceeded the authorized estimate; stop and reconcile');
 }
 const after=await adapter.readCreditUsage();console.log(JSON.stringify({calls:4,observed_call_credits:spent,before_remaining:before.remaining,after_remaining:after.remaining,snapshot_difference_is_not_request_cost:true}));
}
