import {ExecutionTransport} from '../../src/transport.js';

if(process.env.UAI_CRASH_TEST_ONLY!=='1'||!process.send)throw new Error('test_only');
const publish=ExecutionTransport.prototype.publish;
ExecutionTransport.prototype.publish=async function(...args){
 const result=await publish.apply(this,args);
 if(args[1].purpose==='execute'){
  process.send!({type:'published',request_id:args[1].request_id});
  // Pause after the actual Redis acknowledgement, before relayOne updates PostgreSQL.
  await new Promise(()=>{});
 }
 return result;
};
await import('../../../../apps/scheduler/src/index.js');
