import {parseArgs} from 'node:util';
import {createPool,transaction} from '../packages/db/src/index.js';
import {systemClock,DomainError} from '../packages/contracts/src/index.js';
import {previewBackendTransition,transitionRequestBackend,type ExecutionBackend} from '../packages/queue/src/backend-transition.js';

const {values}=parseArgs({options:{organization:{type:'string'},application:{type:'string'},account:{type:'string'},request:{type:'string'},from:{type:'string'},to:{type:'string'},generation:{type:'string'},actor:{type:'string'},reason:{type:'string'},apply:{type:'boolean',default:false}}});
for(const key of ['organization','application','account','request'] as const)if(!values[key])throw new Error(`--${key} is required`);
if(values.apply&&(!values.from||!values.to||values.generation===undefined||!values.actor||!values.reason?.trim()))throw new Error('--apply requires --from, --to, --generation, --actor and --reason');
if(values.apply&&!/^\d+$/.test(values.generation!))throw new Error('--generation must be a nonnegative integer');
const pool=createPool(),scope={organization_id:values.organization!,application_id:values.application!,account_id:values.account!};
try{
 const result=values.apply?await transaction(pool,tx=>transitionRequestBackend(tx,scope,systemClock,{request_id:values.request!,from:values.from as ExecutionBackend,to:values.to as ExecutionBackend,generation:Number(values.generation)},{actor_id:values.actor!,reason:values.reason!})):await previewBackendTransition(pool,scope,systemClock,values.request!);
 console.log(JSON.stringify({mode:values.apply?'applied':'preview',...result}));
}catch(error){
 // No prompts, connection strings or driver details in operational output.
 console.error(JSON.stringify(error instanceof DomainError?{code:error.code,message:error.message}:{code:'backend_transition_failed'}));process.exitCode=1;
}finally{await pool.end()}
