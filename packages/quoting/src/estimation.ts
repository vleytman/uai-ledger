import {inputAssetIds} from '../../storage/src/index.js';
import {getEncoding} from 'js-tiktoken';
import {DomainError} from '../../contracts/src/index.js';
import type {BillableItem} from '../../providers/src/contracts.js';

export interface EstimateRule {
 dimension:string;unit:'tokens'|'images'|'seconds'|'characters'|'calls';
 source:'input_tokens'|'output_tokens'|'characters'|'fixed'|'duration';
 maximum:number;expected?:number;conditions?:Record<string,string>;
}
export interface EstimationPolicy {version:1;tokenizer?:'o200k_base'|'cl100k_base';rules:EstimateRule[];source:string}
const encoders=new Map<string,ReturnType<typeof getEncoding>>();
export function validateEstimation(policy:EstimationPolicy){
 if(!policy||policy.version!==1||typeof policy.source!=='string'||!policy.source.trim()||!Array.isArray(policy.rules)||!policy.rules.length||policy.rules.length>32||policy.tokenizer&&!['o200k_base','cl100k_base'].includes(policy.tokenizer))throw new DomainError('invalid_estimation','Invalid estimation policy',422);
 for(const r of policy.rules){
  if(!r||typeof r.dimension!=='string'||!r.dimension||!['tokens','images','seconds','characters','calls'].includes(r.unit)||!['input_tokens','output_tokens','characters','fixed','duration'].includes(r.source)||!Number.isFinite(r.maximum)||r.maximum<0||r.maximum>1e9||r.expected!==undefined&&(!Number.isFinite(r.expected)||r.expected<0||r.expected>r.maximum))throw new DomainError('invalid_estimation','Invalid estimation rule',422);
  if(r.unit!=='seconds'&&!Number.isSafeInteger(r.maximum))throw new DomainError('invalid_estimation','Maximum quantity must be an integer',422);
  if((r.source.endsWith('_tokens')&&r.unit!=='tokens')||(r.source==='characters'&&r.unit!=='characters')||(r.source==='duration'&&r.unit!=='seconds'))throw new DomainError('invalid_estimation','Quantity source and unit differ',422);
 }
}
export function estimateItems(policy:EstimationPolicy,payload?:{input:Record<string,unknown>;parameters?:Record<string,unknown>}){
 validateEstimation(policy);
 const input=payload?.input,parameters=payload?.parameters??{};
 // Include instructions, roles, schemas and message framing. Unsupported assets retain configured bounds.
 const serial=input?JSON.stringify(input):'',hasAssets=!!input&&inputAssetIds(input).length>0;
 const framing=128+(Array.isArray(input?.messages)?input.messages.length*16:0);
 const byteBound=Buffer.byteLength(serial,'utf8')+framing;
 let expectedTokens=byteBound;
 if(input&&policy.tokenizer){let encoder=encoders.get(policy.tokenizer);if(!encoder){encoder=getEncoding(policy.tokenizer);encoders.set(policy.tokenizer,encoder)}expectedTokens=encoder.encode(serial).length+16+(Array.isArray(input.messages)?input.messages.length*4:0);}
 const maximum:BillableItem[]=[],expected:BillableItem[]=[];
 for(const rule of policy.rules){
  let max=rule.maximum,forecast=rule.expected??max;
  if(input&&!hasAssets){
   if(rule.source==='input_tokens'){max=byteBound;forecast=Math.min(max,expectedTokens);}
   if(rule.source==='output_tokens'&&typeof parameters.max_output_tokens==='number'){max=parameters.max_output_tokens;forecast=Math.min(max,forecast);}
   if(rule.source==='characters'&&typeof input.text==='string'){max=input.text.length;forecast=max;}
   if(rule.source==='duration'&&typeof parameters.duration_seconds==='number'){max=parameters.duration_seconds;forecast=max;}
  }
  if(!Number.isFinite(max)||max<0||max>rule.maximum)throw new DomainError('request_exceeds_recipe','Quantity exceeds estimation bound',422);
  maximum.push({dimension:rule.dimension,unit:rule.unit,quantity:String(max),conditions:rule.conditions});
  expected.push({dimension:rule.dimension,unit:rule.unit,quantity:String(Math.min(max,forecast)),conditions:rule.conditions});
 }
 return {maximum,expected,method:input?'request':'recipe_bound',source:policy.source};
}
