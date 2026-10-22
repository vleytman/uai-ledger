import {describe,it,expect} from 'vitest';
import {demoModels} from '../src/demo-models';
import {validateModelCalculation,validateModelRateCoverage,validateModelPriceSamples,priceModel} from '../src/index';
import {demoImagePresets,validImageSize} from '../../quoting/src/openai-image-presets';
const context={at:'2026-09-19T12:00:00Z'};
describe('published demo model configuration',()=>{
 it('offers ten ratios at all three tiers within provider dimensions',()=>{
  const presets=demoImagePresets();expect(presets).toHaveLength(30);expect(new Set(presets.map(p=>p.size)).size).toBe(30);
  for(const p of presets){const [w,h]=p.size.split('x').map(Number);expect(validImageSize(w,h)).toBe(true);const [a,b]=p.ratio.split(':').map(Number);expect(Math.abs(w/h-a/b)/(a/b)).toBeLessThan(.025)}
 });
 for(const m of demoModels())it(`${m.id}: complete prices and valid model calculation`,()=>{
  validateModelCalculation(m.method);validateModelRateCoverage(m.method,m.card,context);validateModelPriceSamples(m.method,m.card,context);
  expect(m.method.pricing).toMatchObject({safety_factor:'1.1',markup_percent:'100'});
  if(m.capability==='image.generate'){
   const table=m.method.components.find(c=>c.type==='lookup')!;expect(table.type==='lookup'&&table.rows.length).toBe(m.key==='image2'?90:150);
   for(const size of m.method.parameters.size.values!)for(const quality of m.method.parameters.quality.values!)for(const refs of [0,16]){
    const price=priceModel(m.method,{input:{prompt:'A blue cup.'},parameters:{size,quality},assets:Array.from({length:refs},(_,i)=>({id:String(i),sha256:'a'.repeat(64),width:1024,height:1024,format:'png'}))},m.card,context);expect(price).toBeDefined();
   }
  }else{
   const output=m.method.components.find(c=>c.type==='tokens'&&c.direction==='output');expect(output).toMatchObject({policy:'estimated_parameter',maximum:'131072'});
   for(const expected_output_tokens of m.method.parameters.expected_output_tokens.values!)expect(priceModel(m.method,{input:{messages:[{role:'user',content:'Hello'}]},parameters:{expected_output_tokens},assets:[]},m.card,context)).toBeDefined();
  }
 });
});
