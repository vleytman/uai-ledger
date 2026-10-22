import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {calculateQuantities,validateModelCalculation} from '../src/index.js';
import {imageCalculationExample,textCalculationExample} from '../src/examples.js';
import {imageOutputTokens} from '../../quoting/src/openai-image-presets.js';

const observations=JSON.parse(readFileSync(new URL('./fixtures/image-usage-20260919.json',import.meta.url),'utf8')) as {cases:Array<{case:string;model:string;size:string;quality:string;prompt:string;references:Array<{width:number;height:number;format:string}>;usage:{text_input:number;image_input:number;image_output:number}}>};
describe('central pricing configuration examples',()=>{
 it.each([
  ['gpt-image-2-2026-04-21',['low','medium','high']],
  ['gpt-image-2.5-sunburst-2026-09-08',['low','medium','high','xhigh','max']],
  ['gpt-image-2.5-flare-2026-09-08',['low','medium','high','xhigh','max']],
 ] as const)('publishes a complete size and quality table for %s', (model,qualities)=>{
  // Synthetic rate isolates table generation from mutable provider prices.
  const method=imageCalculationExample(model,[...qualities],'30');
  expect(()=>validateModelCalculation(method)).not.toThrow();
  const output=method.components.find(c=>c.type==='lookup')!;
  if(output.type!=='lookup')throw new Error('Expected output table');
  expect(output.rows).toHaveLength(method.parameters.size.values!.length*qualities.length);
  expect(method.pricing).toEqual({safety_factor:'1',markup_percent:'0',rounding_units:'1'});
  for(const row of output.rows){
   const values=calculateQuantities(method,{input:{prompt:'A cup'},parameters:row.parameters,assets:[]});
   expect(values.find(v=>v.key==='image')!.value).toBe(row.value);
  }
 });
 it('matches recorded output usage and text framing across all fifteen requests',()=>{
  expect(observations.cases).toHaveLength(15);
  for(const observation of observations.cases){
   expect(imageOutputTokens(observation.model,observation.size,observation.quality),observation.case).toBe(observation.usage.image_output);
   const method=imageCalculationExample(observation.model,['medium'],'30');
   // Only text framing is compared here. Reference pixels are deliberately
   // normalized to the example policy; historical image usage is checked below.
   const assets=observation.references.map((_,i)=>({id:String(i),sha256:'test',width:1024,height:1024,format:'png'}));
   const rows=calculateQuantities(method,{input:{prompt:observation.prompt},parameters:{},assets});
   expect(Number(rows.find(r=>r.key==='text')!.value),observation.case).toBe(observation.usage.text_input);
  }
 });
 it('limits the empirical reference claim to prepared 1024-square images',()=>{
  const matching=observations.cases.filter(c=>c.references.length>0&&c.references.every(r=>r.width===1024&&r.height===1024));
  expect(matching.length).toBeGreaterThan(0);
  for(const observation of matching)expect(observation.usage.image_input).toBe(observation.references.length*1024);
  const larger=observations.cases.find(c=>c.references.some(r=>r.width===2048&&r.height===2048))!;
  expect(larger.usage.image_input).not.toBe(larger.references.length*1024);
  const method=imageCalculationExample('gpt-image-2.5-sunburst-2026-09-08',['medium'],'30');
  expect(()=>calculateQuantities(method,{input:{prompt:'Hello'},parameters:{},assets:[{id:'raw',sha256:'test',width:512,height:512,format:'png'}]})).toThrow(/preparation/);
  expect(method.verification).toBe('approximate');
 });
 it('uses a bounded output forecast and rejects references for the text example',()=>{
  const method=textCalculationExample();
  expect(()=>validateModelCalculation(method)).not.toThrow();
  const values=calculateQuantities(method,{input:{messages:[{role:'user',content:'Привет'}]},parameters:{max_output_tokens:32},assets:[]});
  expect(values.find(r=>r.key==='output')!.value).toBe('32');
  expect(()=>calculateQuantities(method,{input:{prompt:'Hi'},parameters:{},assets:[{id:'x',sha256:'test',width:1024,height:1024,format:'png'}]})).toThrow(/Too many references/);
 });
});
