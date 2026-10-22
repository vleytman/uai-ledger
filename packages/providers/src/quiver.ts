import {HttpAdapter,classifyFailure} from './index.js';
import {counter,object,unknownUsage} from './usage.js';
import {validateSvgInput,validateSvgAssets} from './svg-input.js';
import type {AdapterCapabilities,AdapterContext,NormalizedUsage,ProviderInput} from './contracts.js';
import {DomainError} from '../../contracts/src/index.js';
export function quiverUsage(raw:unknown):NormalizedUsage{
 const u=object(raw),details=object(u.input_tokens_details),input=counter(u.input_tokens),output=counter(u.output_tokens),total=counter(u.total_tokens),read=counter(details.cached_tokens),write=counter(details.cache_write_tokens),reasoning=counter(object(u.output_tokens_details).reasoning_tokens);
 if(input===null||output===null||total!==input+output||reasoning!==null&&reasoning>output)return unknownUsage('quiver_token_breakdown_missing_or_inconsistent');
 // Quiver often sends no cache split at all. Then every input token is priced at cache write,
 // the highest input rate on the Quiver cards, so the charge never undercounts the provider.
 // A split with only one of the two counters stays unknown: it is not a documented response.
 const split=details.cached_tokens!==undefined||details.cache_write_tokens!==undefined;
 if(split&&(read===null||write===null||read+write>input))return unknownUsage('quiver_token_breakdown_missing_or_inconsistent');
 const [uncached,cacheRead,cacheWrite]=split?[input-read!-write!,read!,write!]:[0n,0n,input];
 const breakdown={...(reasoning!==null?{reasoning_tokens:String(reasoning)}:{}),...(split?{}:{input_cache_split:'absent_priced_as_cache_write'})};
 return {state:'known',items:[{dimension:'input.uncached',unit:'tokens',quantity:String(uncached)},{dimension:'input.cache_read',unit:'tokens',quantity:String(cacheRead)},{dimension:'input.cache_write',unit:'tokens',quantity:String(cacheWrite)},{dimension:'output.text',unit:'tokens',quantity:String(output)}],...(Object.keys(breakdown).length?{breakdown}:{})};
}
export class QuiverAdapter extends HttpAdapter {
 readonly id='quiver';readonly capabilities:AdapterCapabilities={operations:['image.generate','image.vectorize'],streaming:false,native_jobs:false,lookup:false,cancel:false,idempotency:false,usage:true,read_usage:false,read_costs:false,read_balance:false};
 validate(input:ProviderInput){if(this.options.apiKey.startsWith('sk_test_'))throw new DomainError('quiver_sandbox_key','Quiver test keys return synthetic output; configure a production key',422);super.validate(input);validateSvgInput(this.id,input);}
 acceptsAssets(){return true;}
 allowedParameters(input:ProviderInput){return input.capability==='image.vectorize'?['auto_crop','temperature','top_p']:['reasoning_effort','temperature','top_p'];}
 request(input:ProviderInput){const images=(input.assets??[]).map(a=>({base64:Buffer.from(a.bytes).toString('base64')})),vector=input.capability==='image.vectorize';return {url:`https://api.quiver.ai/v1/svgs/${vector?'vectorizations':'generations'}`,headers:{authorization:`Bearer ${this.options.apiKey}`,'content-type':'application/json'},body:{...input.parameters,model:input.model,max_output_tokens:input.max_output_tokens,stream:false,...(vector?{image:images[0]}:{prompt:input.input,n:1,...(images.length?{references:images}:{})})}};}
 async execute(input:ProviderInput,context:AdapterContext){await validateSvgAssets(this.id,input);return super.execute(input,context);}
 override estimateLimitUsage(input:ProviderInput){return {requests:1,images:1,...(this.options.maxInputTokens?{input_tokens:this.options.maxInputTokens,output_tokens:input.max_output_tokens!,tokens:this.options.maxInputTokens+input.max_output_tokens!}:{output_tokens:input.max_output_tokens!})};}
 normalizeUsage=quiverUsage;
 actualLimitUsage(raw:unknown){const u=object(raw),i=counter(u.input_tokens),o=counter(u.output_tokens);return i!==null&&o!==null&&i+o<=BigInt(Number.MAX_SAFE_INTEGER)?{requests:1,images:1,input_tokens:Number(i),output_tokens:Number(o),tokens:Number(i+o)}:undefined;}
 override classifyFailure=(status:number|undefined,raw?:unknown,headers?:Headers)=>{const body=object(raw),failure=classifyFailure(status,{error:body},headers);return status===undefined||status===408||status>=500?{...failure,kind:'unknown' as const,safe_to_retry:false}:failure;};
 extract(body:Record<string,any>){if(!Array.isArray(body.data)||body.data.length!==1||body.data[0]?.mime_type!=='image/svg+xml'||typeof body.data[0]?.svg!=='string'||!body.data[0].svg.length||Buffer.byteLength(body.data[0].svg)>8000000)throw new Error('invalid_svg_output');return {content_type:'image/svg+xml',bytes:Buffer.from(body.data[0].svg)};}
}
