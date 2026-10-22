import {readFile,writeFile,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
interface Entry{id:string;status:'passed'|'partial'|'missing';evidence:string|string[];limitations:string}
const reportDir=resolve('.data/reports'),entries=new Map<string,Array<Entry&{source:string}>>();
for(const file of (await readdir(reportDir)).filter(v=>v.endsWith('-acceptance.json')).sort())for(const row of JSON.parse(await readFile(resolve(reportDir,file),'utf8')) as Entry[]){const values=entries.get(row.id)??[];values.push({...row,source:file});entries.set(row.id,values)}
const clean=(value:string)=>value.replaceAll('|','/').replaceAll('\n',' ');
const statuses={passed:'Подтверждён локально',partial:'Частично',missing:'Не проверен'},counts={passed:0,partial:0,missing:0};
const file=resolve('docs/ACCEPTANCE_RESULTS.md');let content=await readFile(file,'utf8');
content=content.split('\n').map(line=>{
 const match=line.match(/^\| (A\d\d) \|/);if(!match)return line;
 const values=entries.get(match[1])??[],best=values.find(v=>v.status==='passed')??values.find(v=>v.status==='partial')??values[0];
 const state=best?.status??'missing';counts[state]++;const cells=line.split('|');
 cells[5]=` ${statuses[state]} `;cells[6]=' pnpm test; команды в LOCAL_RUN.md ';
 const applicable=best?values.filter(v=>v.status===best.status):[];
 cells[7]=` ${clean(applicable.map(v=>`${Array.isArray(v.evidence)?v.evidence.join('; '):v.evidence}`).join(' / ')||'Нет доказательства')} `;
 cells[8]=` ${clean(applicable.map(v=>v.limitations).filter((v,i,a)=>a.indexOf(v)===i).join(' / ')||'Сценарий ещё не назначен или не проверен')} `;
 return cells.join('|');
}).join('\n');
content=content.replace(/\nТекущий итог:.*\n?/,'\n');content+=`\nТекущий итог: ${counts.passed} подтверждены локально, ${counts.partial} частично, ${counts.missing} не проверены. Результаты и ограничения реальных вызовов перечислены в [проверках провайдеров](REAL_PROVIDER_CHECKS.md); эта таблица не означает завершение цели.\n`;
await writeFile(file,content);console.log(JSON.stringify(counts));
