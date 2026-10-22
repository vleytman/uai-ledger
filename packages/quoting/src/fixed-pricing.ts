import {DomainError,canonical,units} from '../../contracts/src/index.js';
import {validateEstimation,type EstimationPolicy} from './estimation.js';
export interface FixedPrice {parameters:Record<string,string>;units:string;estimation?:EstimationPolicy}
export interface FixedPricing {mode:'fixed';price_parameters:string[];prices:FixedPrice[];source:string}
export function validateFixedPricing(policy:FixedPricing,allowed:Record<string,unknown[]>){
 const fail=(message:string):never=>{throw new DomainError('invalid_fixed_pricing',message,422)};
 if(policy.mode!=='fixed'||!policy.source?.trim()||!Array.isArray(policy.price_parameters)||new Set(policy.price_parameters).size!==policy.price_parameters.length||!Array.isArray(policy.prices)||!policy.prices.length||policy.prices.length>500000)fail('Invalid fixed pricing policy');
 for(const key of policy.price_parameters)if(!allowed[key]?.length)fail(`Price parameter ${key} has no allowed values`);
 const seen=new Set<string>();for(const row of policy.prices){
  if(!row.parameters||Object.keys(row.parameters).length!==policy.price_parameters.length)fail('Price row must specify only the price parameters');
  for(const key of policy.price_parameters)if(!allowed[key].some(value=>String(value)===row.parameters[key]))fail(`Unsupported price parameter ${key}`);
  units(row.units);if(BigInt(row.units)<=0n)fail('Fixed price must be positive');
  const key=canonical(row.parameters);if(seen.has(key))fail('Duplicate price combination');seen.add(key);if(row.estimation)validateEstimation(row.estimation);
 }
 const expected=policy.price_parameters.reduce((n,k)=>n*allowed[k].length,1);if(seen.size!==expected)fail('Every allowed price combination needs a price');
}
export function fixedPrice(policy:FixedPricing,parameters:Record<string,unknown>):FixedPrice {
 const key=canonical(Object.fromEntries(policy.price_parameters.map(k=>[k,String(parameters[k])])));
 const row=policy.prices.find(row=>canonical(row.parameters)===key);if(!row)throw new DomainError('fixed_price_unavailable','No fixed price for these parameters',422);return row;
}
export const parameterBounds=(limits:{image_sizes?:string[];image_qualities?:string[];parameter_values?:Record<string,unknown[]>})=>({...limits.parameter_values,...(limits.image_sizes?{size:limits.image_sizes}:{}),...(limits.image_qualities?{quality:limits.image_qualities}:{})});
