import {it,expect} from 'vitest';
import {JsonFieldParser} from './json-fields.js';
it('streams arbitrary selected strings through every UTF-8 and escape boundary',()=>{
 const json='{"unselected":"private","a/b":{"~key":"Привет \\uD83D\\uDE00\\n\\\"!"},"items":[4,{"text":"tail"}]}';
 const bytes=new TextEncoder().encode(json),expected={'/a~1b/~0key':'Привет 😀\n"!','/items/1/text':'tail'};
 for(let size=1;size<=bytes.length;size++){
  const parser=new JsonFieldParser(Object.keys(expected)),actual:Record<string,string>={};
  for(let i=0;i<bytes.length;i+=size)for(const delta of parser.push(bytes.slice(i,i+size)))actual[delta.field_path]=(actual[delta.field_path]??'')+delta.text;
  expect(actual).toEqual(expected);
 }
});
it('emits a field before its closing quote without special-casing its name',()=>{
 const parser=new JsonFieldParser(['/reply']);expect(parser.push('{"reply":"ear')).toEqual([{field_path:'/reply',text:'ear'}]);expect(parser.push('ly","score":1}')).toEqual([{field_path:'/reply',text:'ly'}]);
});
