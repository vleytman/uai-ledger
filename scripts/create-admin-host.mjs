import {readFile,writeFile,mkdir,lstat} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const source=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const json=value=>JSON.stringify(value,null,2)+'\n';
/** Creates product-owned composition files, never copies UAI or credentials. */
export async function createAdminHost(destination,{name='Product',sourceRoot=source}={}) {
 if(typeof name!=='string'||!name.trim()||name.length>100)throw new Error('Provide a product name of 1–100 characters');
 const root=resolve(destination);
 const manifest=JSON.parse(await readFile(join(sourceRoot,'apps/admin/package.json'),'utf8'));
 manifest.name='@product/admin';
 manifest.scripts={dev:'vite dev --host 127.0.0.1 --port 4311',build:'vite build',typecheck:'tsc --noEmit'};
 const files=new Map([
  ['package.json',json({name:'product-workspace',private:true,type:'module',packageManager:'pnpm@9.15.0',scripts:{'dev:admin':'pnpm --filter @product/admin dev',build:'pnpm --filter @product/admin build',typecheck:'pnpm --filter @product/admin typecheck'}})],
  ['pnpm-workspace.yaml',"packages:\n  - apps/*\n  - vendor/uai\n  - vendor/uai/packages/*\n"],
  ['.gitignore',"node_modules/\ndist/\n.tanstack/\n.data/\n.env\n.env.*\n!.env.example\n*.log\n"],
  ['apps/admin/package.json',json(manifest)],
  ['apps/admin/src/application.ts',`import type {AdminApplication} from '@uai/admin-module';\n\nexport const application:AdminApplication={\n brand:{name:${JSON.stringify(name.trim())},tagline:'Administration'},\n // Register only product ADMIN modules here. The customer frontend is separate.\n modules:[],\n};\n`],
  ['apps/admin/src/server/external-auth.example.ts',`import type {ExternalAdminAuth} from '@uai/admin-module/server';
// Integration boundary only. Implement using your server-side session provider.
// No Better Auth integration is included. Never read staff roles from request JSON.
// For a signed-in user without staff access, throw SessionError(403, 'Staff access is required.')
// imported from '@uai/admin-module/server'. Return null only for a missing/expired session.
export const externalAuth:ExternalAdminAuth={
 mode:'external', publicOrigin:'https://admin.example.com', loginUrl:'/signin',
 adapter:{
  async authenticate(_request){throw new Error('Implement fresh staff session resolution');},
  async logout(_request){throw new Error('Implement parent session termination and Set-Cookie');},
 },
};
// createAdminBackend({auth:externalAuth,reads:{},commands:{},permissions:{reads:{}}})
`],
  ['apps/admin/src/styles.css','@import "@uai/admin-module/styles.css";\n@source "./";\n'],
  ['apps/admin/src/server/backend.ts',"import {createAdminBackend} from '@uai/admin-module/server';\n\n// Register product settings and payment administration here.\n// Owner access only. Payment webhooks use separate signed endpoints.\nexport const handle=createAdminBackend({reads:{},commands:{}});\n"],
 ]);
 for(const path of ['vite.config.ts','tsconfig.json','src/router.tsx','src/routes/__root.tsx','src/routes/index.tsx','src/routes/api.uai-admin.ts'])files.set('apps/admin/'+path,await readFile(join(sourceRoot,'apps/admin',path),'utf8'));
 for(const filename of ['README.md','openai.svg','anthropic.svg','cartesia.svg','serper.ico']){
  const path='public/providers/'+filename;
  files.set('apps/admin/'+path,await readFile(join(sourceRoot,'apps/admin',path)));
 }
 for(const path of ['.github/dependabot.yml','.github/workflows/admin.yml','README.md'])files.set(path,await readFile(join(sourceRoot,'templates/product-admin',path),'utf8'));
 // Preflight the whole write set. Existing projects must merge the template explicitly.
 for(const file of files.keys()){
  let current=join(root,file);
  while(current!==dirname(root)){
   try{const info=await lstat(current);if(info.isSymbolicLink())throw new Error(`Refusing symlink: ${current}`);if(current===join(root,file))throw new Error(`Refusing to overwrite: ${current}`);}catch(error){if(error.code!=='ENOENT')throw error;}
   current=dirname(current);
  }
 }
 for(const [file,content] of files){await mkdir(dirname(join(root,file)),{recursive:true});await writeFile(join(root,file),content,{flag:'wx'});}
 return [...files.keys()];
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const [destination,name]=process.argv.slice(2);
 if(!destination)throw new Error('Usage: node scripts/create-admin-host.mjs <destination> [product name]');
 const files=await createAdminHost(destination,{name});
 console.log(`Created ${files.length} composition files. Connect UAI at vendor/uai and follow README.md. No repository, submodule, credentials, or deployment was created.`);
}
