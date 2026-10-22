import type pg from 'pg';
import type {Tx} from '../../db/src/index.js';

/** Session lock preserves group serialization without an open transaction during Redis I/O. */
export async function withQuotaLocks<T>(pool:pg.Pool,work:(client:pg.PoolClient,lock:(key:string,namespace:8192|8193)=>Promise<void>)=>Promise<T>){
 const client=await pool.connect();let lost=false,destroy=false;const locks:Array<[string,number]>=[];
 const disconnected=()=>{lost=true};client.on('error',disconnected);
 try{
  const result=await work(client,async(key,namespace)=>{
   await client.query('SELECT pg_advisory_lock(hashtextextended($1,$2))',[key,namespace]);locks.push([key,namespace]);
  });
  if(lost)throw new Error('quota_group_connection_lost');
  return result;
 }finally{
  if(!lost)for(const lock of locks.reverse())try{await client.query('SELECT pg_advisory_unlock(hashtextextended($1,$2))',lock)}catch{destroy=true;break}
  client.off('error',disconnected);client.release(destroy||lost);
 }
}

export async function withQuotaGroupLock<T>(pool:pg.Pool,groupId:string,work:(client:pg.PoolClient)=>Promise<T>){
 return withQuotaLocks(pool,async(client,lock)=>{await lock(groupId,8192);return work(client)});
}

export async function quotaTransaction<T>(client:pg.PoolClient,work:(tx:Tx)=>Promise<T>){
 try{await client.query('BEGIN');const result=await work(client);await client.query('COMMIT');return result}
 catch(error){await client.query('ROLLBACK');throw error}
}
