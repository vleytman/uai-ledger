import {test,expect} from 'vitest';
import {mkdtemp,readFile,mkdir,writeFile,rm,symlink,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAdminHost} from '../../../scripts/create-admin-host.mjs';
test('generates composition without copying UAI, frontend, credentials or legacy API',async()=>{
 const root=await mkdtemp(join(tmpdir(),'uai-host-test-'));
 try{
  const files=await createAdminHost(root,{name:'A "quoted" product'});
  expect(files.some(file=>file.startsWith('vendor/')||file.includes('frontend')||file.includes('.data/'))).toBe(false);
  expect(files).not.toContain('apps/admin/src/routes/api.ts');
  expect(await readFile(join(root,'apps/admin/src/application.ts'),'utf8')).toContain('A \\"quoted\\" product');
  expect(await readFile(join(root,'pnpm-workspace.yaml'),'utf8')).toContain('vendor/uai/packages/*');
  expect(JSON.parse(await readFile(join(root,'apps/admin/package.json'),'utf8')).dependencies['@uai/admin-module']).toBe('workspace:*');
  expect(await readFile(join(root,'.github/dependabot.yml'),'utf8')).toContain('gitsubmodule');
  for(const filename of ['README.md','openai.svg','anthropic.svg','cartesia.svg','serper.ico']){
   expect(await readFile(join(root,'apps/admin/public/providers',filename))).toEqual(await readFile(new URL('../../../apps/admin/public/providers/'+filename,import.meta.url)));
  }
 }finally{await rm(root,{recursive:true,force:true})}
});
test('rejects existing files before writing any of the template',async()=>{
 const root=await mkdtemp(join(tmpdir(),'uai-host-test-'));
 try{
  await writeFile(join(root,'package.json'),'original');
  await expect(createAdminHost(root)).rejects.toThrow('overwrite');
  expect(await readdir(root)).toEqual(['package.json']);
  expect(await readFile(join(root,'package.json'),'utf8')).toBe('original');
 }finally{await rm(root,{recursive:true,force:true})}
});
test('rejects symlinked destinations without writing outside the target',async()=>{
 const root=await mkdtemp(join(tmpdir(),'uai-host-test-'));
 try{
  await mkdir(join(root,'outside'));await mkdir(join(root,'target'));
  await symlink(join(root,'outside'),join(root,'target','apps'));
  await expect(createAdminHost(join(root,'target'))).rejects.toThrow('symlink');
  expect(await readdir(join(root,'outside'))).toEqual([]);
 }finally{await rm(root,{recursive:true,force:true})}
});
