import {Rational,type priceModel} from '../../model-pricing/src/index.js';
import type {LimitUsage} from '../../providers/src/contracts.js';

/**
 * A text call's quota demand: the input tokens counted when the call was quoted and the call's output
 * limit, or the calculation's output tokens when no limit is sent. The connection's max_input_tokens
 * stays the fallback when the quote counted nothing. Reported usage later corrects the window either way.
 */
export function textQuotaEstimate(breakdown:ReturnType<typeof priceModel>,maxOutputTokens?:number):LimitUsage|undefined{
 const tokens=(prefix:string)=>breakdown.components.filter(c=>c.result.kind==='quantity'&&c.result.unit==='tokens'&&c.result.dimension.startsWith(prefix));
 const sum=(rows:ReturnType<typeof tokens>)=>rows.reduce((total,c)=>total.add(Rational.from(c.value)),Rational.from('0')).ceil();
 const inputs=tokens('input.'),outputs=tokens('output.');
 if(!inputs.length)return undefined;
 const output=Number.isSafeInteger(maxOutputTokens)&&maxOutputTokens!>0?BigInt(maxOutputTokens!):outputs.length?sum(outputs):undefined;
 if(output===undefined)return undefined;
 const input=sum(inputs);
 if(input<0n||output<0n||input+output>BigInt(Number.MAX_SAFE_INTEGER))return undefined;
 return {requests:1,input_tokens:Number(input),output_tokens:Number(output),tokens:Number(input+output)};
}
