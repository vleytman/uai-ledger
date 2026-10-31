import type pg from 'pg';
import {cleanObservationDeliveries} from './observation-cleanup.js';
import {relayObservations} from './observation-relay.js';
import {relayMaintenance} from './maintenance.js';
import {relayOne,reconcileDeliveries} from './relay.js';
import type {ExecutionTransport} from './transport.js';

/** Shared by the service entrypoint and the isolated multi-process load runner. */
export async function distributedSchedulerTick(pool:pg.Pool,transport:ExecutionTransport,worker:string){
 // New calls first: a wake-up usually means a dispatch was just inserted.
 let published=0;
 for(;published<100&&await relayOne(pool,transport,worker);published++);
 await relayMaintenance(pool,transport);
 await reconcileDeliveries(pool,transport);
 await cleanObservationDeliveries(pool,transport);
 await relayObservations(pool,transport);
 return {published};
}
