import { describe,it,expect } from 'vitest';
import { UaiClient } from './index.js';
const ready={id:'r1',operation_id:'o1',execution_status:'succeeded',settlement_status:'settled',result:{content:'saved text',assets:[]},delivery:{result_version:'v1',manifest_hash:'sha256:abc',status:'available',ready_at:'2026-09-18T00:00:00Z',content_expires_at:'2026-09-18T01:00:00Z'}};
describe('SDK durable handoff and replay',()=>{
 it('reuses identity and exact body after ambiguous transport error',async()=>{
  const attempts:RequestInit[]=[];
  const client=new UaiClient({baseUrl:'http://uai.test',token:'test',fetch:async(_url,options)=>{attempts.push(options!);if(attempts.length===1)throw new Error('connection lost');return Response.json({id:'same'})}});
  await client.accounts.create({external_account_id:'x'},'stable');expect(attempts[0].body).toBe(attempts[1].body);expect(attempts.map(a=>(a.headers as Record<string,string>)['idempotency-key'])).toEqual(['stable','stable']);
 });
 it('persists before acknowledgement',async()=>{
  const order:string[]=[];const client=new UaiClient({baseUrl:'http://uai.test',token:'test',fetch:async(url)=>{if(String(url).endsWith('acknowledge')){order.push('ack');return Response.json({receipt_id:'done'})}return Response.json(ready)}});
  await client.resume('r1',{persist:async()=>{order.push('persist')}});expect(order).toEqual(['persist','ack']);
 });
 it('never acknowledges failed persistence and never creates new request on resume',async()=>{
  const calls:string[]=[];const client=new UaiClient({baseUrl:'http://uai.test',token:'test',fetch:async(url)=>{calls.push(String(url));return Response.json(ready)}});
  await expect(client.resume('r1',{persist:async()=>{throw new Error('disk full')}})).rejects.toThrow('disk full');expect(calls).toEqual(['http://uai.test/v1/requests/r1']);
 });
 it('passes Last-Event-ID and parses split UTF-8 SSE',async()=>{
  let header='';const encoder=new TextEncoder(),data=encoder.encode('id: e2\nevent: wallet.updated\ndata: {"id":"e2","data":{"label":"Кредит"}}\n\n');
  const client=new UaiClient({baseUrl:'http://uai.test',token:'test',fetch:async(_url,opts)=>{header=(opts?.headers as Record<string,string>)['last-event-id'];return new Response(new ReadableStream({start(c){c.enqueue(data.slice(0,25));c.enqueue(data.slice(25,68));c.enqueue(data.slice(68));c.close()}}))}});
  const events=[];for await(const event of client.events({lastEventId:'e1'}))events.push(event);expect(header).toBe('e1');expect(events).toEqual([{id:'e2',data:{label:'Кредит'}}]);
 });
});
