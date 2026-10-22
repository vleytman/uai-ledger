import {DomainError} from '../../contracts/src/index.js';
export type InvocationPriority='interactive'|'background';
export function priorityValue(value:unknown):number{
 if(value===undefined||value==='background')return 0;
 if(value==='interactive')return 10;
 throw new DomainError('invalid_priority','Expected interactive or background',422);
}
/** Keep at least one background slot possible, even on a single-slot installation. */
export function backgroundCapacity(total:number,reserve=1){return Math.max(1,total-Math.min(reserve,Math.max(0,total-1)));}
