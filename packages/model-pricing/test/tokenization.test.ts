import {describe,it,expect} from 'vitest';
import {getEncoding} from 'js-tiktoken';
import {countTokens,inputTokens} from '../src/tokenization.js';
const tokenizers=['o200k_base','cl100k_base'] as const;
const reference=Object.fromEntries(tokenizers.map(t=>[t,getEncoding(t)]));
// Fragments cover each pre-tokenizer branch: case runs, contractions, digit groups, punctuation, whitespace, multi-byte letters and emoji.
const fragments=['a','x','Z','th','ing','The',"'s","'LL",' ','  ','\n','\r\n','\t','0','12','3456','-','=','/','.',',','"','{','}','é','ß','Пр','中','文','😀','👍🏽','́','\ud800'];
function corpus(seed:number,count:number){const rnd=()=>{seed=(seed*1103515245+12345)&0x7fffffff;return seed/0x7fffffff};return Array.from({length:count},()=>{const pool=fragments.filter(()=>rnd()<0.4);if(!pool.length)pool.push('x');return Array.from({length:1+Math.floor(rnd()*300)},()=>pool[Math.floor(rnd()*pool.length)]).join('')});}
describe('bounded exact token counting',()=>{
 it('matches js-tiktoken encode on mixed text, long single-case runs and JSON',()=>{
  const samples=[...corpus(7,600),'x'.repeat(1500),'ab'.repeat(700),'中文'.repeat(500),'='.repeat(1500),' '.repeat(1500),'abcdefghij'.repeat(150),JSON.stringify({messages:[{role:'user',content:'Нарисуй синюю чашку 🐕, then reply with "ready".'}],response_schema:{type:'object'}})];
  for(const t of tokenizers)for(const text of samples)expect([t,text,countTokens(text,t)]).toEqual([t,text,reference[t].encode(text).length]);
 });
 it('counts a 24 000-letter run without spaces in well under a second and keeps special-token rejection',()=>{
  // js-tiktoken encode returns 3000 for this input with either encoding after 33-35 s on the measured host.
  const started=performance.now();expect(inputTokens({prompt:'x'.repeat(24000)},'o200k_base','prompt')).toBe(3000);
  expect(countTokens('x'.repeat(24000),'cl100k_base')).toBe(3000);
  expect(performance.now()-started).toBeLessThan(500);
  for(const t of tokenizers)expect(()=>countTokens('a <|endoftext|> b',t)).toThrow(/special token/);
 });
});
