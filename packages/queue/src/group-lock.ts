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
type LockKey={key:string;namespace:8192|8193};
const local=new Map<string,Promise<void>>();
/** Calls of one process wait for a key here, in order, holding no connection; only the first goes to PostgreSQL. */
async function localTurn(name:string){
 const previous=local.get(name)??Promise.resolve();
 let release!:()=>void;const turn=new Promise<void>(resolve=>{release=resolve});
 const tail=previous.then(()=>turn);local.set(name,tail);
 await previous;
 let done=false;
 return ()=>{if(done)return;done=true;release();if(local.get(name)===tail)local.delete(name)};
}
/**
 * Group serialization without an open transaction on the work's connection during Redis I/O.
 * The locks are transaction-level advisory locks held by a separate connection whose transaction stays
 * open until the work ends, so they also work through a pooler in transaction mode. They conflict with
 * the same keys taken by pg_advisory_xact_lock elsewhere, exactly as the former session locks did.
 * The work must not take these keys itself on its own connection: it would wait for its own holder.
 *
 * Waiting never holds a pooled server connection: calls of one process queue in the process; the one at
 * the head tries the first key and, while another process holds it, ends its transaction before trying
 * again. Otherwise waiters filled a transaction-mode pool and the owner's own work could not get a
 * connection. A later key of a bundle is waited for in the transaction: one such waiter per process and key.
 */
export async function withQuotaLocks<T>(pool:pg.Pool,first:LockKey&{wait?:boolean},work:(client:pg.PoolClient,lock:(key:string,namespace:8192|8193)=>Promise<void>)=>Promise<T>){
 const turns:Array<()=>void>=[];
 let holder:pg.PoolClient|undefined,client:pg.PoolClient|undefined,lost=false,open=false;
 // A lost holder has lost its locks: the next call of this process may go on while this one fails.
 const disconnected=()=>{lost=true;for(const release of [...turns].reverse())release()};
 try{
  turns.push(await localTurn(`${first.namespace}:${first.key}`));
  holder=await holderPool(pool).connect();holder.on('error',disconnected);
  // A waiting exclusive request also turns away new shared tries, so it cannot be starved by them.
  if(first.wait){await holder.query('BEGIN');open=true;await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1,$2))',[first.key,first.namespace])}
  else for(let wait=1;;wait=Math.min(wait*2,20)){
   await holder.query('BEGIN');open=true;
   if((await holder.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,$2)) AS locked',[first.key,first.namespace])).rows[0].locked)break;
   await holder.query('ROLLBACK');open=false;
   await new Promise(resolve=>setTimeout(resolve,wait*(0.5+Math.random())));
  }
  client=await pool.connect();client.on('error',disconnected);
  const held=holder;
  const result=await work(client,async(key,namespace)=>{
   if(key===first.key&&namespace===first.namespace)return;
   turns.push(await localTurn(`${namespace}:${key}`));
   await held.query('SELECT pg_advisory_xact_lock(hashtextextended($1,$2))',[key,namespace]);
  });
  if(lost)throw new Error('quota_group_connection_lost');
  return result;
 }finally{
  let broken=lost;
  if(holder){
   if(open&&!lost)try{await holder.query('COMMIT')}catch{broken=true}
   holder.off('error',disconnected);holder.release(broken);
  }
  if(client){client.off('error',disconnected);client.release(lost)}
  for(const release of turns.reverse())release();
 }
}

/**
 * The exclusive group lock, for what must not run beside admissions of the group: rebuilding its Redis state.
 * One waiter per process; the wait is in PostgreSQL's lock queue, so admissions' shared tries make way for it.
 */
export async function withQuotaGroupLock<T>(pool:pg.Pool,groupId:string,work:(client:pg.PoolClient)=>Promise<T>){
 return withQuotaLocks(pool,{key:groupId,namespace:8192,wait:true},client=>work(client));
}

/**
 * Admissions of one group run side by side and hold no group lock. Confirmations count the group's held slots one
 * at a time: the group rows stay locked to the end of the short confirming transaction. Changes of a group's rules
 * or settings lock the same row, so a confirmation sees them; a Redis rebuild closes the Redis gate instead.
 */
export async function lockQuotaGroupRows(tx:Tx,groupIds:string[]):Promise<Map<string,any>>{
 // The lock lasts until commit, so the commit need not wait for its WAL flush: the call is sent only after a later
 // durable transaction (prepareDispatch), whose flush includes this one. Lost in a crash, the admission is an
 // unconfirmed intent, which recovery already counts conservatively.
 await tx.query("SET LOCAL synchronous_commit=off");
 const rows=(await tx.query('SELECT * FROM provider_quota_groups WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE',[groupIds])).rows;
 return new Map(rows.map(row=>[row.id,row]));
}

export async function quotaTransaction<T>(client:pg.PoolClient,work:(tx:Tx)=>Promise<T>){
 try{await client.query('BEGIN');const result=await work(client);await client.query('COMMIT');return result}
 catch(error){await client.query('ROLLBACK');throw error}
}
