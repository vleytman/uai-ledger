import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
const root=process.cwd(); let checked=0;
for(const name of (await readdir(path.join(root,'docs'))).filter(n=>n.endsWith('.md'))) {
 const file=path.join(root,'docs',name), text=await readFile(file,'utf8');
 let fence:string|undefined,kind='',body='';
 for(const line of text.split('\n')) {
  const match=line.match(/^(`{3,}|~{3,})(\w*)/);
  if(match) {
   if(!fence) { fence=match[1]; kind=match[2]??''; body=''; }
   else if(match[1][0]===fence[0] && match[1].length>=fence.length) { if(kind==='json') { JSON.parse(body); checked++; } fence=undefined; }
  } else if(fence) body+=line+'\n';
 }
 if(fence) throw new Error(`Unclosed fence: ${name}`);
 for(const match of text.matchAll(/(?<!!)\[[^\]]*\]\(([^)]+)\)/g)) {
  const target=match[1]!.split('#')[0]!;
  if(!target || /^[a-z]+:/i.test(target)) continue;
  await stat(path.resolve(path.dirname(file),target));
 }
}
console.log(`Documentation fences, local links and ${checked} JSON examples valid. This is not implementation acceptance.`);
