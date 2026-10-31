import pg from 'pg';
import type {Tx} from '../../db/src/index.js';

const holders=new WeakMap<pg.Pool,pg.Pool>();
/** Lock holders never wait for the work's own pool, so admissions cannot exhaust it between them. */
function holderPool(pool:pg.Pool){
 let holder=holders.get(pool);
 if(!holder){
  const {connectionString,connectionTimeoutMillis,idleTimeoutMillis,max}=pool.options;
  holder=new pg.Pool({connectionString,connectionTimeoutMillis,idleTimeoutMillis,max,application_name:'uai-quota-lock',allowExitOnIdle:true});
  holder.on('error',()=>console.error('postgres_pool_connection_error'));
  holder.on('connect',client=>client.on('error',()=>console.error('postgres_client_connection_error')));
  holders.set(pool,holder);
  // Ending the pool ends its holders, so no lock connection outlives it.
  const end=pool.end.bind(pool),own=holder;
  pool.end=(async()=>{holders.delete(pool);await own.end().catch(()=>{});return end()}) as typeof pool.end;
 }
 return holder;
}
/**
 * Group serialization without an open transaction on the work's connection during Redis I/O.
 * The locks are transaction-level advisory locks held by a separate connection whose transaction stays
 * open until the work ends, so they also work through a pooler in transaction mode. They conflict with
 * the same keys taken by pg_advisory_xact_lock elsewhere, exactly as the former session locks did.
 * The work must not take these keys itself on its own connection: it would wait for its own holder.
 */
export async function withQuotaLocks<T>(pool:pg.Pool,work:(client:pg.PoolClient,lock:(key:string,namespace:8192|8193)=>Promise<void>)=>Promise<T>){
 const holder=await holderPool(pool).connect();let client:pg.PoolClient|undefined,lost=false,open=false;
 const disconnected=()=>{lost=true};holder.on('error',disconnected);
 try{
  client=await pool.connect();client.on('error',disconnected);
  await holder.query('BEGIN');open=true;
  const result=await work(client,async(key,namespace)=>{await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1,$2))',[key,namespace])});
  if(lost)throw new Error('quota_group_connection_lost');
  return result;
 }finally{
  let broken=lost;
  if(open&&!lost)try{await holder.query('COMMIT')}catch{broken=true}
  holder.off('error',disconnected);holder.release(broken);
  if(client){client.off('error',disconnected);client.release(lost)}
 }
}

export async function withQuotaGroupLock<T>(pool:pg.Pool,groupId:string,work:(client:pg.PoolClient)=>Promise<T>){
 return withQuotaLocks(pool,async(client,lock)=>{await lock(groupId,8192);return work(client)});
}

export async function quotaTransaction<T>(client:pg.PoolClient,work:(tx:Tx)=>Promise<T>){
 try{await client.query('BEGIN');const result=await work(client);await client.query('COMMIT');return result}
 catch(error){await client.query('ROLLBACK');throw error}
}
