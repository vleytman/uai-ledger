import {EventEmitter} from 'node:events';
import {it,expect,vi} from 'vitest';
import {TransientHub} from './transient-hub.js';
it('shares one listener and serializes slow access checks per subscriber',async()=>{
 const client=Object.assign(new EventEmitter(),{query:vi.fn(async()=>({})),release:vi.fn()}),pool={connect:vi.fn(async()=>client)};
 const hub=new TransientHub(pool as any);await Promise.all([hub.start(),hub.start(),hub.start()]);expect(pool.connect).toHaveBeenCalledOnce();
 let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),received:number[]=[];
 hub.subscribe(()=>true,async event=>{if(event.n===1)await gate;received.push(event.n)},()=>{});
 hub.publish({n:1});hub.publish({n:2});expect(received).toEqual([]);release();await vi.waitFor(()=>expect(received).toEqual([1,2]));await hub.close();expect(client.release).toHaveBeenCalledOnce();
});
it('bounds paused buffers and disconnects only the slow consumer',async()=>{
 const client=Object.assign(new EventEmitter(),{query:async()=>({}),release:()=>{}}),hub=new TransientHub({connect:async()=>client} as any,1024,2);await hub.start();
 const slow=vi.fn(),fast:number[]=[];hub.subscribe(()=>true,async()=>{},slow,true);hub.subscribe(()=>true,async event=>{fast.push(event.n)},()=>{});
 for(let n=1;n<=3;n++){hub.publish({n});await Promise.resolve();}
 expect(slow).toHaveBeenCalledOnce();expect(fast).toEqual([1,2,3]);await hub.close();
});
