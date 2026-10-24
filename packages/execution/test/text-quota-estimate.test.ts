import {it,expect} from 'vitest';
import {textQuotaEstimate} from '../src/text-quota-estimate.js';

const row=(key:string,dimension:string,value:string)=>({key,value,result:{kind:'quantity',dimension,unit:'tokens'}});
const breakdown=(...components:any[])=>({components} as any);

it('counts the quoted input and the call output limit, and leaves the connection fallback when either is unknown',()=>{
 // A cold-cache input written as cache_write still counts as input; fractional counts round up.
 const quoted=breakdown(row('input','input.cache_write','120.5'),row('cache_read','input.cache_read','0'),row('output','output.text','4096'));
 expect(textQuotaEstimate(quoted)).toEqual({requests:1,input_tokens:121,output_tokens:4096,tokens:4217});
 // The limit actually sent bounds the output, not the calculation's forecast.
 expect(textQuotaEstimate(quoted,32768)).toEqual({requests:1,input_tokens:121,output_tokens:32768,tokens:32889});
 expect(textQuotaEstimate(quoted,0)).toEqual({requests:1,input_tokens:121,output_tokens:4096,tokens:4217});
 expect(textQuotaEstimate(breakdown(row('output','output.text','4096')),100)).toBeUndefined();
 expect(textQuotaEstimate(breakdown(row('input','input.uncached','50')))).toBeUndefined();
 expect(textQuotaEstimate(breakdown(row('input','input.uncached','50'),{key:'image',value:'0.04',result:{kind:'usd'}}),10)).toEqual({requests:1,input_tokens:50,output_tokens:10,tokens:60});
});
