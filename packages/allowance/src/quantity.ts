import {DomainError} from '../../contracts/src/index.js';
export const SCALE=1_000_000_000n;
export function quantity(value:string):bigint {
 if(typeof value!=='string'||!/^(0|[1-9]\d{0,28})(\.\d{1,9})?$/.test(value))throw new DomainError('invalid_allowance_quantity','Expected nonnegative decimal with at most 9 fractional digits',422);
 const [whole,fraction='']=value.split('.');return BigInt(whole)*SCALE+BigInt(fraction.padEnd(9,'0'));
}
export function decimal(value:bigint):string {
 const sign=value<0n?'-':'';const abs=value<0n?-value:value;
 return sign+(abs/SCALE).toString()+(abs%SCALE?'.'+(abs%SCALE).toString().padStart(9,'0').replace(/0+$/,''):'');
}
export const positive=(v:bigint)=>v>0n?v:0n;
export const min=(a:bigint,b:bigint)=>a<b?a:b;
/** A quantity times USD/unit, rounded upward to existing UAI nano-USD units. */
export function overageUnits(amount:bigint,usdPerUnit:string){const product=amount*quantity(usdPerUnit);return (product+SCALE-1n)/SCALE;}
