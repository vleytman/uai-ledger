import {it,expect} from 'vitest';
import {AttemptCursor} from './stream.js';
import {UaiClient} from './index.js';
const delta=(attempt:number,sequence:number)=>({type:'delta' as const,request_id:'r',attempt_id:`a${attempt}`,attempt_number:attempt,generation:String(attempt),sequence,field_path:'/reply',text:'value'});
it('detects a missed attempt event, resets sequence, and ignores stale or duplicate output',()=>{
 const cursor=new AttemptCursor();expect(cursor.accept(delta(1,1)).map(e=>e.type)).toEqual(['attempt','delta']);expect(cursor.incomplete).toBe(true);
 expect(cursor.accept(delta(1,1))).toEqual([]);expect(cursor.accept(delta(2,1)).map(e=>e.type)).toEqual(['attempt','delta']);expect(cursor.accept(delta(1,2))).toEqual([]);
 expect(cursor.accept(delta(2,3))).toHaveLength(1);expect(cursor.incomplete).toBe(true);
});
it('reconnects using accepted ID, persists the final replacement before ACK, and never cancels on disconnect',async()=>{
 const urls:string[]=[],order:string[]=[];let streams=0;
 const result={id:'r',operation_id:'o',execution_status:'succeeded',settlement_status:'settled',result:{content:{type:'text',text:'complete'},assets:[]},delivery:{result_version:'v',manifest_hash:'sha256:x'}};
 const client=new UaiClient({baseUrl:'http://fixture',token:'fixture',pollIntervalMs:1,fetch:async(url)=>{
  urls.push(String(url));if(String(url).endsWith('/acknowledge')){order.push('ack');return Response.json({receipt_id:'receipt'})}
  streams++;const events=streams===1?[{type:'accepted',request_id:'r',operation_id:'o'},delta(1,1)]:[{type:'attempt',request_id:'r',attempt_id:'a1',attempt_number:1,generation:'1',sequence:1,gap:true},{type:'result',request_id:'r',result}];
  return new Response(events.map(e=>`data: ${JSON.stringify(e)}\n\n`).join(''));
 }});
 const response=await client.ai.run({account_id:'a',profile:'text',input:{text:'hello'}},{key:'stable',persist:async()=>{order.push('persist')}});
 expect(response.result).toEqual(result.result);expect(response.live_incomplete).toBe(true);expect(order).toEqual(['persist','ack']);
 expect(urls).toEqual(['http://fixture/v1/invocations/stream','http://fixture/v1/requests/r/stream','http://fixture/v1/requests/r/acknowledge']);
});
it('wallet subscription ignores old revisions and restores a missed update from a reconnect snapshot',async()=>{
 const abort=new AbortController();let connections=0,snapshots=0;const revisions:number[]=[];
 const wallet=(revision:number)=>({id:'w',revision,available_units:String(revision),reserved_units:'0'});
 const client=new UaiClient({baseUrl:'http://fixture',token:'fixture',pollIntervalMs:1,fetch:async url=>{
  if(String(url).includes('/events?')){connections++;const events=connections===1?[{type:'wallet.updated',id:'event2',data:wallet(2)},{type:'wallet.updated',id:'event1',data:wallet(1)}]:[];return new Response(events.map(event=>`data: ${JSON.stringify(event)}\n\n`).join(''));}
  snapshots++;return Response.json(wallet(snapshots===1?1:3));
 }});
 for await(const value of client.wallets.subscribe('w',{signal:abort.signal})){revisions.push(value.revision);if(value.revision===3)abort.abort();}
 expect(revisions).toEqual([1,2,3]);expect(connections).toBe(2);
});
