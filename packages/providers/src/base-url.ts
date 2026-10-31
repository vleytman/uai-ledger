import {DomainError} from '../../contracts/src/index.js';
// The same values as OPENAI_BASE_URL (with /v1) and ANTHROPIC_BASE_URL (without a version) in the official SDKs.
export const BASE_URL_PROVIDERS=['openai','anthropic'] as const;
const loopback=['localhost','127.0.0.1','[::1]'];
const invalid=(message:string)=>new DomainError('invalid_base_url',message,422);
/** The connection key goes to this address, so it must be validated where it is configured and again before use. */
export function normalizeBaseUrl(provider:string,value:unknown,env:Record<string,string|undefined>=process.env):string{
 if(!(BASE_URL_PROVIDERS as readonly string[]).includes(provider))throw invalid(`Base URL is supported only for ${BASE_URL_PROVIDERS.join(' and ')} connections and models.`);
 if(typeof value!=='string'||!value||value.length>2000||value.trim()!==value)throw invalid('Base URL must be an absolute URL of at most 2000 characters.');
 if(value.includes('?')||value.includes('#'))throw invalid('Base URL must not contain a query or fragment.');
 let url:URL;try{url=new URL(value);}catch{throw invalid('Base URL must be an absolute URL.');}
 if(url.username||url.password)throw invalid('Base URL must not contain a user name or password.');
 const local=url.protocol==='http:'&&loopback.includes(url.hostname)&&env.UAI_ENV==='test';
 if(url.protocol!=='https:'&&!local)throw invalid('Base URL must use https; http is allowed only for localhost when UAI_ENV=test.');
 return url.href.replace(/\/+$/,'');
}
