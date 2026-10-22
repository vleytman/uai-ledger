import type pg from 'pg';
import {createHttpsWebhookSender} from '../../notifications/src/index.js';
import {defaultRuntime} from './default-runtime.js';
import type {WorkerDependencies} from './runtime.js';
export function maintenanceRuntime(pool:pg.Pool,base:WorkerDependencies=defaultRuntime(pool)){
 return {...base,webhookSender:process.env.UAI_ENABLE_WEBHOOK_DELIVERY==='true'?createHttpsWebhookSender():undefined,
  secretResolver:async(reference:string)=>{
   if(!/^env:[A-Z][A-Z0-9_]*$/.test(reference))throw new Error('unsupported_secret_reference');
   const secret=process.env[reference.slice(4)];if(!secret)throw new Error('webhook_secret_missing');return secret;
  }};
}
