import {Redis} from 'ioredis';
import {redisConnection,redisClientPrefix} from '../../packages/queue/src/transport.js';

/** Aggregate counts only: CLIENT LIST addresses and other installations never enter reports. */
export class LoadRedisMetrics {
 private readonly client:Redis;
 constructor(url:string,private readonly installation:string){
  this.client=new Redis({...redisConnection(url),lazyConnect:true,maxRetriesPerRequest:1,enableOfflineQueue:false,commandTimeout:2000,connectionName:`${redisClientPrefix(installation)}monitor`});
  // Errors are reported by the awaited connect/sample call, not unhandled stderr.
  this.client.on('error',()=>{});
 }
 async connect(){await this.client.connect()}
 async sample(){
  const text=String(await this.client.client('LIST'));
  const clients=text.trim().split('\n').filter(Boolean).map(line=>Object.fromEntries(line.split(' ').map(part=>{const index=part.indexOf('=');return [part.slice(0,index),part.slice(index+1)]})));
  const prefix=redisClientPrefix(this.installation);
  // BullMQ supplies its own name to blocking duplicates; ordinary clients keep ours.
  const own=clients.filter(c=>c.name?.startsWith(prefix)||c.name?.startsWith(`uai-${this.installation}:`));
  const monitor=own.filter(c=>c.name===`${prefix}monitor`).length;
  return {server_connections:clients.length,installation_connections:own.length-monitor,blocking_connections:own.filter(c=>c.flags?.includes('b')).length,quota_connections:own.filter(c=>c.name?.startsWith(`${prefix}quota:`)).length,monitor_connections:monitor};
 }
 close(){this.client.disconnect()}
}
