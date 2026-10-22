import {it,expect,vi,expectTypeOf} from 'vitest';
import {UaiClient,jev,serviceJson} from './index.js';
const input={state:'Invoice issue',questions:{team:{type:'choice',instructions:'Choose',criteria:{billing:null,support:null}},urgent:{type:'noul',instructions:'Urgent?'},severity:{type:'score',instructions:'Rate',criteria:['Low','High']}}} as const;
it('preserves question keys, choices, budget and ordinary run acknowledgements',async()=>{
 const client=new UaiClient({baseUrl:'http://localhost',token:'fixture'}),acknowledge=vi.fn();
 const value={model:'jev-1.13.0',answers:{team:{type:'choice',choice:'billing',confidence:0.01,probabilities:{billing:0.51,support:0.49}},urgent:{type:'noul',noul:0.5},severity:{type:'score',score:0.5,confidence:0,probabilities:{'0':0.5,'1':0.5},legend:{'0':'Low','1':'High'}}}};
 const run=vi.spyOn(client.services,'run').mockResolvedValue({result:{content:{type:'structured',value},assets:[]},acknowledge} as any);
 const api=jev(client,{account_id:'account'}),options={key:'stable',budget:{max_units:'3000000'}};
 const result=await api.run(input,options);
 expectTypeOf(result.value!.answers.team.choice).toEqualTypeOf<'billing'|'support'>();
 expectTypeOf(result.value!.answers.severity.score).toEqualTypeOf<number>();
 expectTypeOf(result.value!.answers.urgent).toEqualTypeOf<{type:'noul';noul:number}>();
 expect(run).toHaveBeenCalledWith({account_id:'account',profile:'typesafe.jev-1.13.0',input,budget:options.budget},options);
 expect(result.value).toEqual(value);await result.acknowledge();expect(acknowledge).toHaveBeenCalledOnce();
});
it('rejects unavailable and non-JSON manifests',()=>{expect(()=>serviceJson({result:null} as any)).toThrow();expect(()=>serviceJson({result:{content:{type:'text',text:'{}'}}} as any)).toThrow();});

it('preserves a terminal failure without requiring a JSON manifest',async()=>{
 const client=new UaiClient({baseUrl:'http://localhost',token:'fixture'});
 vi.spyOn(client.services,'run').mockResolvedValue({id:'request',execution_status:'failed',reason:'auth',result:null} as any);
 const result=await jev(client,{account_id:'account'}).run(input,{key:'failure',budget:{max_units:'1'}});
 expect(result).toMatchObject({id:'request',execution_status:'failed',reason:'auth',value:undefined});
});
it('validates before delegated persistence can trigger automatic ACK',async()=>{
 const client=new UaiClient({baseUrl:'http://localhost',token:'fixture'}),persist=vi.fn(async()=>{});
 vi.spyOn(client.services,'run').mockImplementation(async(_body,options)=>{await options.persist!({result:{content:{type:'structured',value:{model:'jev-1.13.0',answers:{}}},assets:[]}} as any);throw Error('unreachable');});
 await expect(jev(client,{account_id:'account'}).run(input,{key:'malformed',budget:{max_units:'1'},persist})).rejects.toThrow('Keys do not match');
 expect(persist).not.toHaveBeenCalled();
});
