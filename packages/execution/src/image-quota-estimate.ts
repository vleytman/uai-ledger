import {Rational, type priceModel} from '../../model-pricing/src/index.js';
import {rateUsage, type RateCard, type RatingContext} from '../../pricing/src/index.js';
import type {LimitUsage} from '../../providers/src/contracts.js';

/** The configured OpenAI image table contains output USD, before safety/markup.
 * Convert that estimate using the accepted output-token rate, then add the
 * already calculated text/reference tokens. This is a quota forecast, not usage.
 * Unknown pricing units must remain unknown rather than bypassing TPM checks. */
export function imageQuotaEstimate(model:string, breakdown:ReturnType<typeof priceModel>, card:RateCard, context:RatingContext):LimitUsage|undefined {
 if(!/^gpt-image-(2(?:-|$)|2\.5-(?:sunburst|flare)(?:-|$))/.test(model))return undefined;
 const inputs=breakdown.components.filter(c=>c.result.kind==='quantity'&&c.result.unit==='tokens'&&c.result.dimension.startsWith('input.'));
 const outputs=breakdown.components.filter(c=>c.result.kind==='usd');
 // Only the existing image calculation shape has an unambiguous USD output.
 if(!inputs.length||outputs.length!==1||outputs[0]!.key!=='image')return undefined;
 const rate=rateUsage({state:'known',items:[{dimension:'output.image',unit:'tokens',quantity:'1',conditions:{modality:'image'}}]},card,context);
 if(rate.state!=='calculated'||Rational.from(rate.exact_amount).compare(Rational.from('0'))<=0)return undefined;
 const input=inputs.reduce((sum,c)=>sum.add(Rational.from(c.value)),Rational.from('0')).ceil();
 const output=Rational.from(outputs[0]!.value).div(Rational.from(rate.exact_amount)).ceil();
 if(input<0n||output<0n||input+output>BigInt(Number.MAX_SAFE_INTEGER))return undefined;
 return {requests:1,images:1,input_tokens:Number(input),output_tokens:Number(output),tokens:Number(input+output)};
}
