import {describe,it,expect} from 'vitest';
import {priceModel,validateModelCalculation,validateModelRateCoverage,validateModelPriceSamples,calculateQuantities,type ModelCalculation} from '../src/index.js';
import {Rational,evaluateExpression} from '../src/expression.js';
import type {RateCard} from '../../pricing/src/index.js';
const request={input:{prompt:'A blue cup.'},parameters:{size:'1024x1024',quality:'medium',max_output_tokens:100},assets:[]};
const card:RateCard={id:'test',currency:'USD',source:'synthetic test rates',checked_at:'2026-01-01',rates:[{id:'text',dimension:'input.text',unit:'tokens',unit_size:'1000000',amount:'5',effective_from:'2026-01-01'},{id:'images',dimension:'input.image',unit:'tokens',unit_size:'1000000',amount:'8',effective_from:'2026-01-01'}]};
function policy():ModelCalculation{return {version:1,source:'synthetic test rules',verification:'approximate',verified_at:'2026-01-01',parameters:{size:{type:'string',values:['1024x1024'],default:'1024x1024'},quality:{type:'string',values:['medium'],default:'medium'},max_output_tokens:{type:'number',minimum:1,maximum:200,default:100}},preparation:{max_assets:3,max_edge:512,format:'png'},pricing:{safety_factor:'1.05',markup_percent:'30',rounding_units:'1'},components:[{key:'text',label:'Text',covers:['text_input'],maximum:'1000',result:{kind:'quantity',dimension:'input.text',unit:'tokens'},type:'tokens',direction:'input',tokenizer:'o200k_base',input_mode:'prompt',overhead:6,per_message:0,per_asset:10},{key:'references',label:'References',covers:['image_input'],maximum:'3072',result:{kind:'quantity',dimension:'input.image',unit:'tokens'},type:'formula',expression:{op:'sum_assets',value:{op:'multiply',args:[{op:'ceil',value:{op:'divide',left:{op:'field',path:'asset.width'},right:{op:'constant',value:'16'}}},{op:'ceil',value:{op:'divide',left:{op:'field',path:'asset.height'},right:{op:'constant',value:'16'}}}]}}},{key:'output',label:'Output',covers:['image_output'],maximum:'1',result:{kind:'usd'},type:'lookup',parameters:['size','quality'],rows:[{parameters:{size:'1024x1024',quality:'medium'},value:'0.01317'}]}],samples:[{name:'no references',input:request,expected:{text:'10',references:'0',output:'0.01317'}}]}}
const ctx={at:'2026-01-02'};
describe('central model cost calculation',()=>{
 it('adds table + text + references then applies independent model factors exactly once',()=>{
  const p=policy();const refs=[{id:'asset',sha256:'abc',width:512,height:512,format:'png'}];
  const price=priceModel(p,{...request,assets:refs},card,ctx);
  expect(price.provider_estimate_usd).toBe('0.021462'); // 20 text tokens, 1024 image tokens, output table
  expect(price.price_units).toBe('29295630');
  expect(price.components.map(c=>c.value)).toEqual(['20','1024','0.01317']);
  const changed=policy();changed.pricing={safety_factor:'1',markup_percent:'0',rounding_units:'1000000'};
  expect(priceModel(changed,{...request,assets:refs},card,ctx).price_units).toBe('22000000');
 });
 it('counts Unicode text with the selected tokenizer, rather than assuming chat or image framing',()=>{
  const p=policy();expect(calculateQuantities(p,{...request,input:{prompt:'Нарисуй синюю чашку рядом с апельсином на светлом столе. Мягкий утренний свет, без надписей.'}})[0].value).toBe('40');
 });
 it('combines registered tokenization and a versioned parameter table inside the AST',()=>{
  const p=policy();p.components[0]={...p.components[0],type:'formula',expression:{op:'add',args:[{op:'tokenize',tokenizer:'o200k_base',input_mode:'prompt'},{op:'constant',value:'6'}]}};
  p.components[2]={...p.components[2],type:'formula',expression:{op:'lookup',unit:'usd',parameters:['size','quality'],rows:[{parameters:{size:'1024x1024',quality:'medium'},value:'0.01317'}]}};
  expect(priceModel(p,request,card,ctx).price_units).toBe('18045300');
  p.parameters.quality.values!.push('high');expect(()=>validateModelCalculation(p)).toThrow(/every allowed combination/);
  const expression=(p.components[2] as Extract<typeof p.components[number],{type:'formula'}>).expression as Extract<import('../src/expression.js').Expression,{op:'lookup'}>;
  expression.rows.push({parameters:{size:'1024x1024',quality:'high'},value:'0.1'});
  expect(priceModel(p,{...request,parameters:{...request.parameters,quality:'high'}},card,ctx).provider_estimate_usd).toBe('0.10005');
  expression.unit='tokens';expect(()=>validateModelCalculation(p)).toThrow(/unit/);
 });
 it('keeps expression tokenization bounded and rejects uncounted context',()=>{
  const e={op:'tokenize',tokenizer:'o200k_base',input_mode:'prompt'} as const;
  expect(()=>evaluateExpression(e,{fields:{},assets:[],input:{prompt:'Hi',instructions:'Hidden'}})).toThrow(/full-context/);
  expect(()=>evaluateExpression({...e,tokenizer:'arbitrary-code'} as any,{fields:{},assets:[],input:{prompt:'Hi'}})).toThrow(/registered/);
  expect(()=>evaluateExpression({op:'sum_assets',value:e},{fields:{},assets:[],input:{prompt:'Hi'}})).toThrow(/registered/);
 });
 it('supports simple output token policy without formula and caps a configured forecast',()=>{
  const p=policy();p.components=[{key:'answer',label:'Answer',covers:['text_output'],maximum:'200',result:{kind:'quantity',dimension:'output.text',unit:'tokens'},type:'tokens',direction:'output',policy:'configured_expected',expected:80,limit_parameter:'max_output_tokens'}];p.preparation.max_assets=0;p.samples=[{name:'forecast',input:request,expected:{answer:'80'}}];validateModelCalculation(p);
  expect(calculateQuantities(p,{...request,parameters:{...request.parameters,max_output_tokens:20}})[0].value).toBe('20');
  p.components[0]={...p.components[0],policy:'requested_maximum'} as any;p.samples[0].expected.answer='100';validateModelCalculation(p);
  expect(calculateQuantities(p,request)[0].value).toBe('100');
 });
 it('supports exact per-second rounding and explicit character semantics',()=>{
  const p=policy();p.preparation.max_assets=0;p.parameters.duration={type:'number',minimum:0,maximum:60,default:1.21};p.components=[{key:'duration',label:'Duration',covers:['audio'],maximum:'60',result:{kind:'quantity',dimension:'audio',unit:'seconds'},type:'per_unit',source:'parameter',parameter:'duration',step:'0.1',rounding:'ceil'}];p.samples=[{name:'duration',input:request,expected:{duration:'1.3'}}];validateModelCalculation(p);
  p.components=[{key:'chars',label:'Characters',covers:['audio'],maximum:'100',result:{kind:'quantity',dimension:'audio',unit:'characters'},type:'per_unit',source:'characters',character_mode:'unicode',step:'1',rounding:'ceil'}];
  expect(calculateQuantities(p,{...request,input:{text:'a😀'}})[0].value).toBe('2');(p.components[0] as Extract<typeof p.components[number],{type:'per_unit'}>).character_mode='utf16';expect(calculateQuantities(p,{...request,input:{text:'a😀'}})[0].value).toBe('3');
 });
 it('rejects overlapping coverage, incomplete/duplicate tables and missing reference coverage',()=>{
  const p=policy();p.components[2].covers.push('text_input');expect(()=>validateModelCalculation(p)).toThrow(/coverage/);
  const q=policy();q.parameters.quality.values!.push('high');expect(()=>validateModelCalculation(q)).toThrow(/every allowed/);
  const r=policy();(r.components[2] as any).rows.push((r.components[2] as any).rows[0]);expect(()=>validateModelCalculation(r)).toThrow(/Duplicate/);
  const s=policy();s.components.splice(1,1);expect(()=>validateModelCalculation(s)).toThrow(/coverage/);
 });
 it('rejects negative quantities, unprepared assets and missing rates rather than charging zero',()=>{
  const p=policy();expect(()=>priceModel(p,{...request,assets:[{id:'x',sha256:'abc',width:1024,height:1024,format:'png'}]},card,ctx)).toThrow(/preparation/);
  const q=policy();(q.components[2] as any).rows[0].value='-1';expect(()=>validateModelCalculation(q)).toThrow(/Negative/);
  expect(()=>priceModel(p,request,{...card,rates:[]},ctx)).toThrow();
 });
 it('does not let a prompt-only counter silently omit messages, instructions or schemas',()=>{
  const p=policy();for(const extra of [{messages:[{role:'user',content:'Hidden context'}]},{instructions:'Hidden instruction'},{response_schema:{type:'string'}}])expect(()=>priceModel(p,{...request,input:{...request.input,...extra}},card,ctx)).toThrow(/full-context/);
  (p.components[0] as any).input_mode='messages_json';expect(calculateQuantities(p,{...request,input:{messages:[{role:'user',content:'Hello'}],instructions:'Reply shortly'}})[0].value).not.toBe('6');
 });
 it('requires passing regression samples before publication',()=>{const p=policy();p.samples[0].expected.text='4';expect(()=>validateModelCalculation(p)).toThrow(/does not match/)});
 it('rejects JSON numeric money and factors instead of accepting binary floating-point values',()=>{
  const factor=policy();(factor.pricing as any).markup_percent=0.1;expect(()=>validateModelCalculation(factor)).toThrow(/must be strings/);
  const table=policy();(table.components[2] as any).rows[0].value=0.01317;expect(()=>validateModelCalculation(table)).toThrow(/must be strings/);
  expect(()=>evaluateExpression({op:'constant',value:0.1} as any,{fields:{},assets:[]})).toThrow(/must be strings/);
 });
 it('checks expected costs and final prices with explicit bounded sample tolerances',()=>{
  const p=policy();Object.assign(p.samples[0],{source:'synthetic independent calculation',expected_cost_usd:'0.0132',cost_tolerance_usd:'0.00002',expected_price_units:'18045300',tolerance:{text:'1'}});p.samples[0].expected.text='9';
  expect(()=>validateModelPriceSamples(p,card,ctx)).not.toThrow();
  p.samples[0].expected_cost_usd='0.013199';expect(()=>validateModelPriceSamples(p,card,ctx)).toThrow(/provider cost does not match/);
  p.samples[0].expected_cost_usd='0.01322';p.samples[0].expected_price_units='18045301';expect(()=>validateModelPriceSamples(p,card,ctx)).toThrow(/final price does not match/);
  p.samples[0].expected_price_units='18045300';p.pricing.markup_percent='31';expect(()=>validateModelPriceSamples(p,card,ctx)).toThrow(/final price does not match/);
 });
 it('rejects negative or unknown tolerances and cost tolerance without expected cost',()=>{
  for(const tolerance of [{text:'-1'},{unknown:'1'}] as Record<string,string>[]){const p=policy();p.samples[0].tolerance=tolerance;expect(()=>validateModelCalculation(p)).toThrow(/tolerance/);}
  const p=policy();p.samples[0].cost_tolerance_usd='1';expect(()=>validateModelCalculation(p)).toThrow(/expected sample cost/);
 });
 it.each(['images','calls'] as const)('counts whole %s with per_unit and rejects fractional billing quantities',unit=>{
  const p=policy();p.preparation.max_assets=0;p.components=[{key:'work',label:'Work',covers:['output'],maximum:'3',type:'per_unit',source:'constant',constant:'2',step:'1',rounding:'ceil',result:{kind:'quantity',dimension:'work',unit}}];p.samples=[{name:'two',input:request,expected:{work:'2'}}];
  expect(()=>validateModelCalculation(p)).not.toThrow();expect(calculateQuantities(p,request)[0].value).toBe('2');
  Object.assign(p.components[0],{constant:'1.5',step:'0.5'});expect(()=>calculateQuantities(p,request)).toThrow(/integer/);
 });
 it('multiplies only the output table by result count and supports tables that already include input',()=>{
  const p=policy();p.parameters.count={type:'number',minimum:1,maximum:3,default:1};
  Object.assign(p.components[2],{multiplier_parameter:'count',maximum:'0.03951'});
  const input={...request,parameters:{...request.parameters,count:2},assets:[{id:'a',sha256:'test',width:512,height:512,format:'png'},{id:'b',sha256:'test',width:512,height:512,format:'png'}]};
  const result=priceModel(p,input,card,ctx);expect(result.components.map(c=>c.value)).toEqual(['30','2048','0.02634']);expect(result.provider_estimate_usd).toBe('0.042874');
  const included=policy();included.components=[{...included.components[2],covers:['text_input','image_input','image_output']}];included.samples=[{name:'bundled input',input:request,expected:{output:'0.01317'}}];
  expect(priceModel(included,{...input,parameters:request.parameters},card,ctx).provider_estimate_usd).toBe('0.01317');
 });
 it('rejects unit changes through references and duplicate charges under different coverage names',()=>{
  const p=policy();p.components.push({key:'extra',label:'Extra',covers:['extra'],maximum:'1000',type:'formula',expression:{op:'field',path:'components.text'},result:{kind:'usd'}});
  expect(()=>validateModelCalculation(p)).toThrow(/unit/);
  const q=policy();q.components.push({...q.components[0],key:'again',covers:['renamed_text_input']});
  expect(()=>validateModelCalculation(q)).toThrow(/Duplicate billable quantity/);
 });
 it('checks rates for allowed combinations absent from regression samples',()=>{
  const p=policy();p.parameters.mode={type:'string',values:['standard','fast'],default:'standard'};
  const incomplete={...card,rates:card.rates.map(r=>r.id==='text'?{...r,conditions:{mode:'standard'}}:r)};
  expect(()=>validateModelRateCoverage(p,incomplete,ctx)).toThrow(/rate coverage/);
  const complete={...incomplete,rates:[...incomplete.rates,{...card.rates[0],id:'fast-text',conditions:{mode:'fast'}}]};
  expect(()=>validateModelRateCoverage(p,complete,ctx)).not.toThrow();
 });
 it('rejects a table value that exceeds the maximum even when the sample uses another row',()=>{
  const p=policy();p.parameters.quality.values!.push('high');
  (p.components[2] as Extract<typeof p.components[number],{type:'lookup'}>).rows.push({parameters:{size:'1024x1024',quality:'high'},value:'2'});
  expect(()=>validateModelCalculation(p)).toThrow(/exceeds component maximum/);
 });
});
describe('bounded exact expression language',()=>{
 it('rounds half ties away from zero and rejects oversized computations',()=>{
  for(const [input,expected] of [['2.5','3'],['-2.5','-3'],['-2.4','-2']])expect(Rational.from(input).round(Rational.from('1'),'half_up').decimal()).toBe(expected);
  const expression:any={op:'add',args:Array.from({length:32},()=>({op:'add',args:Array.from({length:32},()=>({op:'constant',value:'1'}))}))};
  expect(()=>evaluateExpression(expression,{fields:{},assets:[]})).toThrow(/oversized/);
 });
 it('retains precision and requires explicit rounding for repeating decimals',()=>{expect(Rational.from('0.1').add(Rational.from('0.2')).decimal()).toBe('0.3');expect(()=>Rational.from('1').div(Rational.from('3')).decimal()).toThrow(/rounding/);expect(Rational.from('1').div(Rational.from('3')).round(Rational.from('0.01'),'ceil').decimal()).toBe('0.34')});
 it('supports conditions and prior component values',()=>{expect(evaluateExpression({op:'if',comparison:'gt',left:{op:'field',path:'components.a'},right:{op:'constant',value:'1'},then:{op:'constant',value:'2'},else:{op:'constant',value:'0'}},{fields:{'components.a':'3'},assets:[]}).decimal()).toBe('2')});
 it('rejects division by zero, unknown fields, unknown operations and cyclic ASTs',()=>{
  const context={fields:{},assets:[]};expect(()=>evaluateExpression({op:'divide',left:{op:'constant',value:'1'},right:{op:'constant',value:'0'}},context)).toThrow(/zero/);
  expect(()=>evaluateExpression({op:'field',path:'process.env'},context)).toThrow(/Unknown/);
  expect(()=>evaluateExpression({op:'eval'} as any,context)).toThrow(/Unsupported/);
  const cycle:any={op:'ceil'};cycle.value=cycle;expect(()=>evaluateExpression(cycle,context)).toThrow(/oversized/);
 });
});
