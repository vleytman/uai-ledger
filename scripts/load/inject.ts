import type {Pool} from 'pg';
import type {AdapterContext,ProviderInput,ProviderResult} from '../../packages/providers/src/contracts.js';

/** First attempt only, keyed by durable attempt number across worker processes. */
export async function injectMockFailure(pool:Pool,options:{rateLimitEvery:number;unknownEvery:number},input:ProviderInput,context:AdapterContext):Promise<ProviderResult|undefined>{
 const {rateLimitEvery,unknownEvery}=options;
 if(!rateLimitEvery&&!unknownEvery)return;
 const sequence=Number(/Synthetic load (\d+)/.exec(input.input)?.[1]??NaN);
 if(!Number.isInteger(sequence))return;
 const unknown=unknownEvery>0&&(sequence+1)%unknownEvery===0;
 const limited=rateLimitEvery>0&&(sequence+1)%rateLimitEvery===0;
 if(!unknown&&!limited)return;
 const attempt=(await pool.query('SELECT number FROM execution_attempts WHERE id=$1',[context.attempt_id])).rows[0];
 if(attempt?.number!==1)return;
 if(unknown)return {outcome:'unknown',failure:{kind:'unknown',code:'timeout',sent:true},usage:{state:'unknown',reason:'synthetic_timeout_after_send'}};
 const now=new Date().toISOString();
 await context.onRateLimits?.({sent_at:now,received_at:now,status:429,headers:{'retry-after':'1'}});
 // Explicit measured zero, not an empty usage payload with no cost evidence.
 const items=input.capability==='text.generate'
  ?[{dimension:'input.uncached',quantity:'0',unit:'tokens'},{dimension:'output.text',quantity:'0',unit:'tokens'}]
  :[{dimension:'output.image',quantity:'0',unit:'images'}];
 return {outcome:'failure',failure:{kind:'transient',code:'rate_limit_exceeded',retry_after_ms:1000,safe_to_retry:true,sent:true},usage:{state:'known',items}};
}
