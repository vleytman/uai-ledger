import {HttpAdapter} from './index.js';
import {embeddingUsage,validateEmbeddingOutput} from './embeddings.js';
import type {AdapterCapabilities,ProviderInput} from './contracts.js';

export class VoyageAdapter extends HttpAdapter {
 readonly id='voyage';
 readonly capabilities:AdapterCapabilities={operations:['embeddings.generate'],streaming:false,native_jobs:false,lookup:false,cancel:false,idempotency:false,usage:true,read_usage:false,read_costs:false,read_balance:false};
 allowedParameters(){return ['dimensions','input_type'];}
 request(input:ProviderInput){return {url:'https://api.voyageai.com/v1/embeddings',headers:{authorization:`Bearer ${this.options.apiKey}`,'content-type':'application/json'},body:{model:input.model,input:input.texts,output_dtype:'float',truncation:false,...(input.parameters?.dimensions!==undefined?{output_dimension:input.parameters.dimensions}:{}),...(input.parameters?.input_type?{input_type:input.parameters.input_type}:{})}};}
 normalizeUsage(raw:unknown){const usage=raw as {total_tokens?:unknown}|undefined;return embeddingUsage({prompt_tokens:usage?.total_tokens,total_tokens:usage?.total_tokens});}
 actualLimitUsage(raw:unknown){const usage=this.normalizeUsage(raw);return usage.state==='known'?{requests:1,tokens:Number(usage.items[0].quantity),input_tokens:Number(usage.items[0].quantity)}:undefined;}
 extract(body:Record<string,any>,input:ProviderInput){
  // Voyage responses need not repeat the model. Identity is the requested model; no revision is claimed.
  const embeddings=validateEmbeddingOutput({...body,model:body.model??input.model,revision:null},input);
  return {content_type:'application/json',text:JSON.stringify(embeddings),embeddings};
 }
}
