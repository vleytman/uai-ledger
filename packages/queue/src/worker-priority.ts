import {backgroundCapacity} from '../../execution/src/priority.js';
/** Counts local executing handlers, so a worker can actually service a reserved interactive slot. */
export class WorkerPriorityGate {
 private background=0;
 constructor(private concurrency:number,private reserve=1){if(!Number.isSafeInteger(reserve)||reserve<0||reserve>concurrency)throw new Error('invalid_worker_interactive_reserve');}
 async run<T>(priority:number,execute:()=>Promise<T>):Promise<T|{worked:false;reason:'interactive_capacity_reserved'}>{
  if(priority!==0)return execute();
  if(this.background>=backgroundCapacity(this.concurrency,this.reserve))return {worked:false,reason:'interactive_capacity_reserved'};
  this.background++;try{return await execute()}finally{this.background--}
 }
}
