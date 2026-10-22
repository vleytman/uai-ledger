import {createHmac,timingSafeEqual} from 'node:crypto';
import {lookup as dnsLookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {request} from 'node:https';
import {DomainError} from '../../contracts/src/index.js';
export function isPublicAddress(address:string):boolean {
 const family=isIP(address);if(family===4){const [a,b]=address.split('.').map(Number);return !(a===0||a===10||a===127||a>=224||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&(b===168||b===0||b===2))||(a===198&&(b===18||b===19||b===51))||(a===203&&b===0)||(a===100&&b>=64&&b<=127));}
 if(family===6){const v=address.toLowerCase();return !v.includes('.')&&!v.startsWith('::')&&!/^(fc|fd|fe|ff)/.test(v)&&!v.startsWith('2001:db8')&&!v.startsWith('2001:0:')&&!v.startsWith('64:ff9b')&&/^[23]/.test(v);}
 return false;
}
export function validateWebhookUrl(value:string):URL {let url:URL;try{url=new URL(value);}catch{throw new DomainError('invalid_webhook_url');}const host=url.hostname.replace(/^\[|\]$/g,'');if(url.protocol!=='https:'||url.username||url.password||url.hash||(url.port&&url.port!=='443')||host==='localhost'||/\.(localhost|local|internal|test|invalid)$/.test(host)||(!isIP(host)&&!host.includes('.'))||(isIP(host)&&!isPublicAddress(host)))throw new DomainError('unsafe_webhook_destination');return url;}
export type Resolver=(hostname:string)=>Promise<{address:string;family:number}[]>;
export async function resolveWebhook(value:string,resolver:Resolver=async hostname=>dnsLookup(hostname,{all:true,verbatim:true})){const url=validateWebhookUrl(value);const host=url.hostname.replace(/^\[|\]$/g,'');const addresses=isIP(host)?[{address:host,family:isIP(host)}]:await resolver(host);if(!addresses.length||addresses.some(a=>!isPublicAddress(a.address)))throw new DomainError('unsafe_webhook_destination');return {url,address:addresses[0].address,family:addresses[0].family};}
export const signWebhook=(secret:string,timestamp:number,eventId:string,body:string)=>`v1=${createHmac('sha256',secret).update(`${timestamp}.${eventId}.${body}`).digest('hex')}`;
export function verifyWebhook(secret:string,timestamp:number,eventId:string,body:string,signature:string,nowSeconds:number,toleranceSeconds=300){if(!Number.isSafeInteger(timestamp)||Math.abs(nowSeconds-timestamp)>toleranceSeconds)return false;const expected=Buffer.from(signWebhook(secret,timestamp,eventId,body));const actual=Buffer.from(signature);return actual.length===expected.length&&timingSafeEqual(actual,expected);}
export interface WebhookRequest {url:string;body:string;headers:Record<string,string>}
export type WebhookSender=(input:WebhookRequest)=>Promise<{status:number}>;
/** Resolves and validates every delivery, then pins the accepted IP while retaining TLS hostname checks. */
export function createHttpsWebhookSender(resolver?:Resolver):WebhookSender{return async input=>{const target=await resolveWebhook(input.url,resolver);return new Promise((resolve,reject)=>{const req=request(target.url,{method:'POST',headers:{...input.headers,'content-length':Buffer.byteLength(input.body)},timeout:10000,lookup:((_hostname:any,_options:any,callback:any)=>{if(_options?.all)callback(null,[{address:target.address,family:target.family}]);else callback(null,target.address,target.family);}) as any},res=>{res.resume();resolve({status:res.statusCode??0});});req.on('error',()=>reject(new Error('webhook_transport_failed')));req.on('timeout',()=>req.destroy(new Error('webhook_timeout')));req.end(input.body);});};}
