import pg from 'pg';

export interface ListenerClient {query(text:string):Promise<unknown>;on(event:string,listener:(...args:any[])=>void):unknown;release(destroy?:boolean):void}
export interface ListenerSource {connect():Promise<ListenerClient>}

/**
 * LISTEN needs a session of its own: through a pooler in transaction mode its notifications would be lost.
 * DATABASE_DIRECT_URL names the server's own address for it; without it the pool's address is used.
 */
export function listenerAddress(pool:pg.Pool){return process.env.DATABASE_DIRECT_URL||pool.options.connectionString}

/** A real pool gives a dedicated client outside the pool for each LISTEN; anything else is used as it is. */
export function listenerSource(source:pg.Pool|ListenerSource,application:string):ListenerSource{
 if(!(source instanceof pg.Pool))return source;
 return {async connect(){
  const client=new pg.Client({connectionString:listenerAddress(source),application_name:application,connectionTimeoutMillis:source.options.connectionTimeoutMillis});
  // Stays after the owner's own listener: a late connection error must not end the process.
  client.on('error',()=>console.error('postgres_listener_connection_error'));
  await client.connect();
  return Object.assign(client,{release(){void client.end().catch(()=>{})}});
 }};
}
