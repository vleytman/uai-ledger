import {createServer,createConnection,type Socket} from 'node:net';
import {randomUUID} from 'node:crypto';
import {describe,it,expect,vi} from 'vitest';
import {QuotaStore} from '../src/quota.js';

const url=process.env.REDIS_URL;
describe.skipIf(!url||!url.startsWith('redis://'))('quota command deadline',()=>{
 it('fails closed on lost replies and replays the already consumed permit',async()=>{
  const target=new URL(url!),sockets=new Set<Socket>();let dropReplies=false;
  const upstreamAddress={host:target.hostname,port:Number(target.port||6379)};
  const server=createServer(client=>{
   const upstream=createConnection(upstreamAddress);
   sockets.add(client);sockets.add(upstream);
   client.on('error',()=>{});upstream.on('error',()=>client.destroy());
   client.on('data',data=>upstream.write(data));
   upstream.on('data',data=>{if(!dropReplies)client.write(data)});
   client.on('close',()=>{upstream.destroy();sockets.delete(client)});
   upstream.on('close',()=>{client.destroy();sockets.delete(upstream)});
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();if(!address||typeof address==='string')throw new Error('proxy_not_listening');
  target.hostname='127.0.0.1';target.port=String(address.port);
  vi.stubEnv('UAI_REDIS_COMMAND_TIMEOUT_MS','150');
  const group=randomUUID(),store=new QuotaStore(target.href,'timeout-test',group);
  let recovered:QuotaStore|undefined;
  store.redis.on('error',()=>{});
  try{
   await store.connect();await store.markRestored('epoch');
   dropReplies=true;const start=Date.now();
   const rules=[{key:'requests',capacity:1,amount:1,window_ms:60000}];
   await expect(store.acquire('epoch','lost-reply',rules)).rejects.toThrow(/timed out/i);
   expect(Date.now()-start).toBeLessThan(1500);
   // Timeout says nothing about execution. Reconnect before retrying the same durable ID.
   dropReplies=false;
   store.redis.disconnect();recovered=new QuotaStore(target.href,'timeout-test',group);await recovered.connect();
   expect(await recovered.acquire('epoch','lost-reply',rules)).toMatchObject({allowed:true,replayed:true});
   expect(await recovered.acquire('epoch','second',rules)).toMatchObject({allowed:false,reason:'limited'});
  }finally{
   dropReplies=false;store.redis.disconnect();recovered?.redis.disconnect();
   for(const socket of sockets)socket.destroy();
   await new Promise<void>(resolve=>server.close(()=>resolve()));vi.unstubAllEnvs();
  }
 });
});
