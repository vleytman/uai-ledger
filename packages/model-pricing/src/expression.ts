import {DomainError,canonical} from '../../contracts/src/index.js';
import {inputTokens,type Tokenizer,type TokenInputMode} from './tokenization.js';

function fail(message:string):never{throw new DomainError('invalid_calculation',message,422)}
const gcd=(a:bigint,b:bigint):bigint=>b?gcd(b,a%b):a;
/** Bounded exact rational arithmetic. No provider cost or markup passes through binary floats. */
export class Rational {
 readonly n:bigint;readonly d:bigint;
 constructor(n:bigint,d=1n){if(d<=0n)fail('Division by zero or negative denominator');const g=gcd(n<0n?-n:n,d);this.n=n/g;this.d=d/g;if(this.n.toString().length>128||this.d.toString().length>128)fail('Calculation exceeds numeric limits');}
 static from(value:string|number){const s=String(value);if(!/^-?(0|[1-9]\d*)(\.\d{1,18})?$/.test(s)||s.length>96)fail('Invalid decimal operand');const neg=s.startsWith('-'),[w,f='']=s.replace(/^-/,'').split('.');return new Rational(BigInt(w+f)*(neg?-1n:1n),10n**BigInt(f.length));}
 add(b:Rational){return new Rational(this.n*b.d+b.n*this.d,this.d*b.d)}
 sub(b:Rational){return new Rational(this.n*b.d-b.n*this.d,this.d*b.d)}
 mul(b:Rational){return new Rational(this.n*b.n,this.d*b.d)}
 div(b:Rational){if(b.n===0n)fail('Division by zero');return new Rational(this.n*b.d*(b.n<0n?-1n:1n),this.d*(b.n<0n?-b.n:b.n))}
 compare(b:Rational){const n=this.n*b.d-b.n*this.d;return n<0n?-1:n>0n?1:0}
 floor(){return this.n/this.d-(this.n<0n&&this.n%this.d!==0n?1n:0n)}
 ceil(){return this.n/this.d+(this.n>0n&&this.n%this.d!==0n?1n:0n)}
 round(step:Rational,mode:'ceil'|'floor'|'half_up'){if(step.n<=0n)fail('Rounding step must be positive');const q=this.div(step);return new Rational(mode==='ceil'?q.ceil():mode==='floor'?q.floor():q.n<0n?q.sub(Rational.from('0.5')).ceil():q.add(Rational.from('0.5')).floor()).mul(step)}
 integer(){if(this.d!==1n)fail('Expected integer quantity');return this.n}
 decimal(){let d=this.d;let scale=0;while(d%2n===0n){d/=2n;scale++}let fives=0;while(d%5n===0n){d/=5n;fives++}scale=Math.max(scale,fives);if(d!==1n||scale>36)fail('Non-terminating decimal requires explicit rounding');const v=this.n*10n**BigInt(scale)/this.d,neg=v<0n,s=(neg?-v:v).toString().padStart(scale+1,'0');return (neg?'-':'')+(scale?`${s.slice(0,-scale)}.${s.slice(-scale)}`.replace(/\.?0+$/,''):s)}
}
export type Expression=
 |{op:'constant';value:string}
 |{op:'field';path:string}
 |{op:'tokenize';tokenizer:Tokenizer;input_mode:TokenInputMode}
 |{op:'lookup';parameters:string[];rows:Array<{parameters:Record<string,string>;value:string}>;unit:'scalar'|'usd'|'tokens'|'images'|'seconds'|'characters'|'calls'}
 |{op:'add'|'multiply'|'min'|'max';args:Expression[]}
 |{op:'subtract'|'divide';left:Expression;right:Expression}
 |{op:'ceil'|'floor';value:Expression}
 |{op:'round';value:Expression;step:string;mode:'ceil'|'floor'|'half_up'}
 |{op:'if';comparison:'lt'|'lte'|'eq'|'gte'|'gt';left:Expression;right:Expression;then:Expression;else:Expression}
 |{op:'sum_assets';value:Expression};
export interface ExpressionContext {fields:Record<string,string|number>;assets:Record<string,string|number>[];input?:Record<string,unknown>;parameters?:Record<string,unknown>}
export function validateExpression(expr:Expression,fields:Set<string>,assetFields=new Set(['asset.width','asset.height']),inAssets=false,budget={nodes:0},depth=0,parameterValues:Record<string,readonly string[]>={}):void {
 if(!expr||typeof expr!=='object'||Array.isArray(expr)||++budget.nodes>256||depth>16)fail('Invalid or oversized expression');
 const walk=(e:Expression,inside=inAssets)=>validateExpression(e,fields,assetFields,inside,budget,depth+1,parameterValues);
 switch(expr.op){
  case 'constant':if(typeof expr.value!=='string')fail('Decimal constants must be strings');Rational.from(expr.value);break;
  case 'field':if(!fields.has(expr.path)&&!(inAssets&&assetFields.has(expr.path)))fail(`Unknown numeric field ${expr.path}`);break;
  case 'tokenize':if(inAssets||!['o200k_base','cl100k_base','utf8_upper_bound'].includes(expr.tokenizer)||!['prompt','messages_json','embedding_batch'].includes(expr.input_mode))fail('Invalid registered tokenization operation');break;
  case 'lookup':{
   if(!Array.isArray(expr.parameters)||!expr.parameters.length||expr.parameters.length>8||new Set(expr.parameters).size!==expr.parameters.length||expr.parameters.some(k=>!Object.hasOwn(parameterValues,k))||!['scalar','usd','tokens','images','seconds','characters','calls'].includes(expr.unit)||!Array.isArray(expr.rows)||expr.rows.length>10000)fail('Invalid expression table');
   const combinations=expr.parameters.reduce((n,k)=>n*parameterValues[k].length,1);if(combinations>10000)fail('Expression table exceeds combination limit');
   const seen=new Set<string>();
   for(const row of expr.rows){if(!row||!row.parameters||typeof row.parameters!=='object'||Object.keys(row.parameters).length!==expr.parameters.length||expr.parameters.some(k=>!parameterValues[k].includes(row.parameters[k])))fail('Invalid expression table row');const key=canonical(row.parameters);if(seen.has(key))fail('Duplicate expression table row');seen.add(key);if(typeof row.value!=='string')fail('Decimal table values must be strings');Rational.from(row.value);}
   if(seen.size!==combinations)fail('Expression table must cover every allowed combination');break;
  }
  case 'add':case 'multiply':case 'min':case 'max':if(!Array.isArray(expr.args)||!expr.args.length||expr.args.length>32)fail('Invalid operands');expr.args.forEach(e=>walk(e));break;
  case 'subtract':case 'divide':walk(expr.left);walk(expr.right);break;
  case 'ceil':case 'floor':walk(expr.value);break;
  case 'round':if(typeof expr.step!=='string'||Rational.from(expr.step).n<=0n||!['ceil','floor','half_up'].includes(expr.mode))fail('Invalid rounding');walk(expr.value);break;
  case 'if':if(!['lt','lte','eq','gte','gt'].includes(expr.comparison))fail('Invalid comparison');walk(expr.left);walk(expr.right);walk(expr.then);walk(expr.else);break;
  case 'sum_assets':if(inAssets)fail('Nested asset sums are forbidden');walk(expr.value,true);break;
  default:fail('Unsupported expression operation');
 }
}
export function evaluateExpression(expr:Expression,context:ExpressionContext):Rational {
 if(context.assets.length>16)fail('Too many assets');
 // The complete domain is checked at publication; runtime retains the inline table domain.
 const domains:Record<string,string[]>={};
 let collected=0;
 const collect=(e:Expression,depth=0):void=>{
  if(!e||typeof e!=='object'||Array.isArray(e)||++collected>256||depth>16)fail('Invalid or oversized expression');
  if(e.op==='lookup'){
   if(!Array.isArray(e.parameters)||e.parameters.length>8||!Array.isArray(e.rows)||e.rows.length>10000||e.rows.some(r=>!r||typeof r.parameters!=='object'||!r.parameters))fail('Invalid expression table');
   for(const key of e.parameters)domains[key]=[...new Set([...(domains[key]??[]),...e.rows.map(r=>r.parameters[key])])];
  }
  if('args'in e){if(!Array.isArray(e.args)||e.args.length>32)fail('Invalid operands');e.args.forEach(x=>collect(x,depth+1));}
  for(const key of ['left','right','then','else','value'] as const){const v=(e as any)[key];if(v&&typeof v==='object')collect(v,depth+1)}
 };
 collect(expr);validateExpression(expr,new Set(Object.keys(context.fields)),undefined,false,{nodes:0},0,domains);
 let operations=0;
 const tokenCounts=new Map<string,number>();
 const run=(e:Expression,asset?:Record<string,string|number>):Rational=>{
  if(++operations>10000)fail('Calculation operation limit');
  switch(e.op){
   case 'constant':return Rational.from(e.value);
   case 'field':{const v=e.path.startsWith('asset.')?asset?.[e.path.slice(6)]:context.fields[e.path];if(v===undefined)fail(`Missing field ${e.path}`);return Rational.from(v!)}
   case 'tokenize':{if(!context.input)fail('Missing tokenization input');const key=e.tokenizer+':'+e.input_mode;let count=tokenCounts.get(key);if(count===undefined){count=inputTokens(context.input,e.tokenizer,e.input_mode);tokenCounts.set(key,count)}return Rational.from(count);}
   case 'lookup':{const selected=canonical(Object.fromEntries(e.parameters.map(k=>[k,String(context.parameters?.[k])])));const row=e.rows.find(r=>canonical(r.parameters)===selected);if(!row)fail('No expression table value for these parameters');return Rational.from(row.value);}
   case 'add':return e.args.reduce((a,b)=>a.add(run(b,asset)),Rational.from('0'));
   case 'multiply':return e.args.reduce((a,b)=>a.mul(run(b,asset)),Rational.from('1'));
   case 'min':case 'max':return e.args.map(x=>run(x,asset)).reduce((a,b)=>(a.compare(b)*(e.op==='min'?1:-1)<=0)?a:b);
   case 'subtract':return run(e.left,asset).sub(run(e.right,asset));
   case 'divide':return run(e.left,asset).div(run(e.right,asset));
   case 'ceil':return new Rational(run(e.value,asset).ceil());
   case 'floor':return new Rational(run(e.value,asset).floor());
   case 'round':return run(e.value,asset).round(Rational.from(e.step),e.mode);
   case 'if':{const cmp=run(e.left,asset).compare(run(e.right,asset));return run(({lt:cmp<0,lte:cmp<=0,eq:cmp===0,gte:cmp>=0,gt:cmp>0}[e.comparison])?e.then:e.else,asset)}
   case 'sum_assets':return context.assets.reduce((a,b)=>a.add(run(e.value,b)),Rational.from('0'));
  }
 };
 return run(expr);
}

/** Constants and raw numeric inputs are scalar coefficients; prior component results retain their unit. */
export function expressionUnit(expr:Expression,fields:Map<string,string>):string|null {
 const same=(values:Array<string|null>)=>{const units=[...new Set(values.filter((v):v is string=>v!==null))];if(units.length>1)fail('Incompatible expression units');return units[0]??null};
 const run=(e:Expression):string|null=>{
  switch(e.op){
   case 'constant':return null;
   case 'field':return fields.get(e.path)??null;
   case 'tokenize':return 'tokens';
   case 'lookup':return e.unit==='scalar'?null:e.unit;
   case 'add':case 'min':case 'max':return same(e.args.map(run));
   case 'subtract':return same([run(e.left),run(e.right)]);
   case 'multiply':{const units=e.args.map(run).filter((u):u is string=>u!==null);if(units.length>1)fail('Multiplication of two typed quantities needs an explicit conversion');return units[0]??null;}
   case 'divide':{const a=run(e.left),b=run(e.right);if(!b)return a;if(a===b)return null;fail('Incompatible expression division units');}
   case 'ceil':case 'floor':case 'round':case 'sum_assets':return run(e.value);
   case 'if':same([run(e.left),run(e.right)]);return same([run(e.then),run(e.else)]);
  }
 };
 return run(expr);
}
