import {it,expect} from 'vitest';
import {checkSchema,providerSchema,validateStructured} from './schema.js';
const original={type:'object',properties:{required:{type:'string'},optional:{type:'string'},nullable:{type:['string','null']},both:{type:['string','null']},nested:{type:'array',items:{$ref:'#/$defs/item'},minItems:1,maxItems:2}},required:['required','nullable','nested'],additionalProperties:false,$defs:{item:{type:'object',properties:{kind:{const:'ok'},note:{type:'string',minLength:2,maxLength:8,pattern:'^[a-z]+$'}},required:['kind'],additionalProperties:false}}};
const wire={required:'yes',optional:{present:false},nullable:null,both:{present:true,value:null},nested:[{kind:'ok',note:{present:true,value:'fine'}}]};
it('LF-A04 preserves absence versus explicit null in optional nullable fields and nested references',()=>{
 const compiled=providerSchema(original);const result=compiled.restore(wire);
 expect(result).toEqual({required:'yes',nullable:null,both:null,nested:[{kind:'ok',note:'fine'}]});
 expect(Object.hasOwn(result as object,'optional')).toBe(false);
 expect(compiled.restore({...wire,both:{present:false}})).not.toHaveProperty('both');
 expect(()=>compiled.restore({...wire,optional:{present:true,value:null}})).toThrow();
 expect(()=>compiled.restore({...wire,nullable:undefined})).toThrow();
});
it('LF-A05 enforces enum, const, exact oneOf, anyOf, numeric, string and array constraints',()=>{
 const cases:[any,any,any][]=[
  [{type:'string',enum:['a','b']},'a','c'],[{type:'integer',minimum:1,maximum:3},2,4],
  [{oneOf:[{type:'integer'},{type:'number'}]},.5,1],
  [{anyOf:[{type:'string',const:'x'},{type:'null'}]},null,'y'],
  [{type:'array',items:{type:'string',minLength:2},minItems:1,maxItems:2},['ok'],['x']],
 ];
 for(const [schema,good,bad] of cases){expect(()=>validateStructured(good,schema)).not.toThrow();expect(()=>validateStructured(bad,schema)).toThrow();}
});
it('LF-A06 reports a JSON pointer and reason, without the private value',()=>{
 try{providerSchema(original).restore({...wire,nested:[{kind:'ok',note:{present:true,value:'PRIVATE123'}}]});throw Error('expected failure')}catch(error:any){expect(error.code).toBe('result_defect');expect(error.details).toEqual({path:'/nested/0/note',reason:'maxLength'});expect(error.message).not.toContain('PRIVATE123');}
});
it.each([
 {$ref:'https://example.com/schema'},{$ref:'#/$defs/no'},{$defs:{loop:{$ref:'#/$defs/loop'}},$ref:'#/$defs/loop'},
 {type:'string',format:'email'},{type:'string',pattern:'(a+)+'},{type:'string',description:'x'.repeat(65536)},
 {type:'object',properties:Object.fromEntries(Array.from({length:257},(_,i)=>[String(i),{type:'string'}]))},
])('LF-A05 rejects unsupported schemas without external resolution: %j',schema=>expect(()=>checkSchema(schema)).toThrow());
it('LF-A05 caps expanded reference complexity and depth',()=>{
 let schema:any={type:'string'};for(let i=0;i<18;i++)schema={type:'array',items:schema};expect(()=>checkSchema(schema)).toThrow();
});
it('LF-A04 LF-A06 restores the valid branch after lossy constraint lowering and keeps its field path',()=>{
 const s={type:'object',properties:{result:{anyOf:[{type:'string',pattern:'^a+$'},{type:'string',pattern:'^b+$'}]}},required:['result'],additionalProperties:false};
 expect(providerSchema(s).restore({result:'bbb'})).toEqual({result:'bbb'});
 try{providerSchema(s).restore({result:'ccc'});throw Error('expected')}catch(error:any){expect(error.details).toEqual({path:'/result',reason:'anyOf'})}
 expect(providerSchema({enum:['yes',null]}).restore({value:null})).toBeNull();
});
