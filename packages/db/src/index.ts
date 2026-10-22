import pg from 'pg';
import { id, type Scope } from '../../contracts/src/index.js';
export interface SqlExecutor { query<R extends pg.QueryResultRow = any>(text: string, values?: any[]): Promise<pg.QueryResult<R>> }
export type Tx = SqlExecutor;
export type DatabaseRole='api'|'worker'|'scheduler'|'tool';
const defaultPoolSizes:Record<DatabaseRole,number>={api:10,worker:8,scheduler:4,tool:10};
function positiveInteger(value:string|undefined,fallback:number,key:string,maximum:number){
 if(value===undefined)return fallback;
 if(!/^[1-9]\d*$/.test(value)||!Number.isSafeInteger(Number(value))||Number(value)>maximum)throw new Error(`Invalid ${key}`);
 return Number(value);
}
/** One pool per process; worker concurrency does not create additional pools. */
export function createPool(connectionString = process.env.DATABASE_URL,role:DatabaseRole='tool') {
 if(!connectionString)throw new Error('DATABASE_URL required');
 if(!Object.hasOwn(defaultPoolSizes,role))throw new Error('Invalid database role');
 const roleKey=`UAI_DB_POOL_MAX_${role.toUpperCase()}`;
 const maximum=positiveInteger(process.env[roleKey]??process.env.UAI_DB_POOL_MAX,defaultPoolSizes[role],roleKey,1000);
 const connectionTimeoutMillis=positiveInteger(process.env.UAI_DB_CONNECT_TIMEOUT_MS,5000,'UAI_DB_CONNECT_TIMEOUT_MS',300000);
 const idleTimeoutMillis=positiveInteger(process.env.UAI_DB_IDLE_TIMEOUT_MS,30000,'UAI_DB_IDLE_TIMEOUT_MS',3600000);
 const pool=new pg.Pool({connectionString,max:maximum,connectionTimeoutMillis,idleTimeoutMillis,application_name:`uai-${role}`});
 // Idle connection failures must not become unhandled EventEmitter errors or leak connection URLs.
 pool.on('error',()=>console.error('postgres_pool_connection_error'));
 return pool;
}
type RollbackObserver=(db:SqlExecutor)=>Promise<void>;
const rollbackObservers=new WeakMap<Tx,RollbackObserver[]>();
/** Diagnostics run only after rollback, without the failed transaction's locks. */
export function afterRollback(tx:Tx,observer:RollbackObserver){
 const observers=rollbackObservers.get(tx);if(!observers)return false;observers.push(observer);return true;
}
export async function transaction<T>(pool: pg.Pool, fn: (tx: Tx)=>Promise<T>): Promise<T> {
  const client = await pool.connect();rollbackObservers.set(client,[]);
  try { await client.query('BEGIN'); const value = await fn(client); await client.query('COMMIT'); return value; }
  catch(error) {
   let rolledBack=false;try{await client.query('ROLLBACK');rolledBack=true}catch{console.error('postgres_rollback_failed')}
   if(rolledBack)for(const observer of rollbackObservers.get(client)??[]){try{await observer(client)}catch{console.error('postgres_rollback_diagnostic_failed')}}
   throw error;
  } finally { rollbackObservers.delete(client);client.release(); }
}
export async function emit(tx: Tx, scope: Scope, type: string, resource: { type: string; id: string }, data: Record<string, unknown> = {}) {
  const eventId=id('evt');
  await tx.query('INSERT INTO outbox_events(id, organization_id, application_id, account_id, type, resource, data) VALUES($1,$2,$3,$4,$5,$6,$7)',[eventId,scope.organization_id,scope.application_id,scope.account_id,type,resource,data]);
  return eventId;
}
