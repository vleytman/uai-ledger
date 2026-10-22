import {readFile,writeFile} from 'node:fs/promises';
import {z} from 'zod';
import {fileConfigurationSchema} from '../packages/configuration/src/index.js';
const path=new URL('../configurations/schema.json',import.meta.url);
const content=JSON.stringify(z.toJSONSchema(fileConfigurationSchema),null,2)+'\n';
if(process.argv.includes('--check')){
 if(await readFile(path,'utf8')!==content)throw new Error('Configuration JSON Schema is stale; run pnpm generate:configuration');
 console.log('Configuration JSON Schema matches version 1');
}else await writeFile(path,content);
