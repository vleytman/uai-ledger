import {hash,type Scope,type Clock} from '../../contracts/src/index.js';
import type {Tx} from '../../db/src/index.js';
import type {NormalizedUsage,BillableItem} from '../../providers/src/contracts.js';
import {rateUsage,type RateCard,type RatingContext} from '../../pricing/src/index.js';
import {Rational,type InputAsset,type ModelCalculation} from '../../model-pricing/src/index.js';
export interface CacheIdentity {digest:string;ttl_seconds:number;prefix_token_bound:number}
export function cacheIdentity(scope:Scope,connection_id:string,model:string,input:Record<string,unknown>,assets:InputAsset[],preparation:unknown,parameters:Record<string,unknown>={}):CacheIdentity|undefined{
 if(!Array.isArray(input.messages))return;
 const prefix:any[]=[];let boundary=-1,ttl=300;
 for(const message of input.messages){
  const blocks=typeof message.content==='string'?[{type:'text',text:message.content}]:message.content;
  if(!Array.isArray(blocks))return;
  for(const block of blocks){
   const asset=block.type==='image'?assets.find(a=>a.id===block.asset_id):undefined;
   if(block.type==='image'&&!asset)return;
   prefix.push({role:message.role,...block,...(asset?{asset_id:undefined,digest:asset.sha256,width:asset.width,height:asset.height,format:asset.format}:{})});
   if(block.cache?.boundary==='stable_prefix'){boundary=prefix.length;ttl=block.cache.ttl_seconds??300;}
  }
 }
 if(boundary<0)return;
 const {max_output_tokens,expected_output_tokens,...cacheSettings}=parameters;
 const stable={cacheSettings,instructions:input.instructions,tools:input.tools,tool_choice:input.tool_choice,response_schema:input.response_schema,blocks:prefix.slice(0,boundary),preparation};
 return {digest:hash([scope,connection_id,model,stable]),ttl_seconds:Math.min(ttl,3600),prefix_token_bound:Buffer.byteLength(JSON.stringify(stable),'utf8')};
}
export async function observePrefix(tx:Tx,scope:Scope,clock:Clock,connection_id:string,model:string,identity:CacheIdentity,usage:NormalizedUsage){
 if(usage.state!=='known'||!usage.items.some(item=>item.dimension==='input.cache_read'))return;
 const sum=(dimension:string)=>usage.items.filter(item=>item.dimension===dimension).reduce((n,item)=>n+BigInt(item.quantity),0n).toString();
 await tx.query(`INSERT INTO prefix_cache_observations VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(organization_id,application_id,account_id,connection_id,model,digest) DO UPDATE SET observed_at=EXCLUDED.observed_at,expires_at=EXCLUDED.expires_at,read_tokens=EXCLUDED.read_tokens,write_tokens=EXCLUDED.write_tokens WHERE prefix_cache_observations.observed_at<=EXCLUDED.observed_at`,[scope.organization_id,scope.application_id,scope.account_id,connection_id,model,identity.digest,clock.now(),new Date(clock.now().getTime()+identity.ttl_seconds*1000),sum('input.cache_read'),sum('input.cache_write')]);
 await tx.query(`DELETE FROM prefix_cache_observations WHERE organization_id=$1 AND application_id=$2 AND account_id=$3 AND (expires_at<=$4 OR digest IN (SELECT digest FROM prefix_cache_observations WHERE organization_id=$1 AND application_id=$2 AND account_id=$3 ORDER BY observed_at DESC,digest OFFSET 1024))`,[scope.organization_id,scope.application_id,scope.account_id,clock.now()]);
}
export async function cacheForecast(tx:Tx,scope:Scope,clock:Clock,connection_id:string,model:string,identity:CacheIdentity|undefined,items:BillableItem[],card:RateCard,context:RatingContext,pricing:ModelCalculation['pricing'],cold_units:string){
 const cold={confidence:'cold' as const,cold_estimate_units:cold_units,expected_estimate_units:cold_units,expected_items:items};
 if(!identity)return cold;
 const row=(await tx.query('SELECT read_tokens::text FROM prefix_cache_observations WHERE organization_id=$1 AND application_id=$2 AND account_id=$3 AND connection_id=$4 AND model=$5 AND digest=$6 AND expires_at>$7',[scope.organization_id,scope.application_id,scope.account_id,connection_id,model,identity.digest,clock.now()])).rows[0];
 if(!row||BigInt(row.read_tokens)===0n)return cold;
 let remaining=BigInt(row.read_tokens)<BigInt(identity.prefix_token_bound)?BigInt(row.read_tokens):BigInt(identity.prefix_token_bound);
 const expected:BillableItem[]=[];
 for(const item of items){
  if(!['input.uncached','input.cache_write'].includes(item.dimension)||item.unit!=='tokens'){expected.push(item);continue;}
  const quantity=BigInt(item.quantity),read=quantity<remaining?quantity:remaining;remaining-=read;
  expected.push({...item,quantity:(quantity-read).toString()});
  if(read>0n){const {cache_ttl,...conditions}=item.conditions??{};expected.push({...item,dimension:'input.cache_read',quantity:read.toString(),conditions});}
 }
 const rating=rateUsage({state:'known',items:expected},card,context);if(rating.state!=='calculated')return cold;
 const price=Rational.from(rating.exact_amount).mul(Rational.from('1000000000')).mul(Rational.from(pricing.safety_factor)).mul(Rational.from('1').add(Rational.from(pricing.markup_percent).div(Rational.from('100')))).round(Rational.from(pricing.rounding_units),'ceil').integer();
 if(price>=BigInt(cold_units))return cold;
 return {confidence:'observed_partial' as const,cold_estimate_units:cold_units,expected_estimate_units:price.toString(),expected_items:expected};
}
