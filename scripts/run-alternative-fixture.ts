/** Browser fixture, isolated test installation. Never resolves provider credentials. */
import {writeFile,mkdir,rm} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createPool,transaction} from '../packages/db/src/index.js';
import {setupAlternativeScope} from './lib/alternative-smoke.js';
import {issueToken} from '../packages/auth/src/index.js';
import {ensureWallet} from '../packages/accounting/src/index.js';
import {createApi} from '../apps/api/src/server.js';
const url=new URL(process.env.DATABASE_URL??'');if(!['localhost','127.0.0.1'].includes(url.hostname)||!url.pathname.startsWith('/uai_ami_test'))throw new Error('Dedicated local AMI test database required');
process.env.UAI_ALLOW_REAL_PROVIDERS='false';process.env.UAI_ENV='test';
const pool=createPool(),{scope}=await setupAlternativeScope(pool),dir='/tmp/uai-ami-ui';await mkdir(dir,{recursive:true});
const data=await transaction(pool,async tx=>({wallet:await ensureWallet(tx,scope),token:(await issueToken(tx,{...scope,account_ids:null,scopes:['operations:admin','config:write','ai:read','ai:quote','ai:invoke','wallets:read','credits:grant','content:write'],max_grant_units:'10000000000',expires_at:null})).token}));
const api=createApi(pool),api_url=await api.listen({host:'127.0.0.1',port:4335});
const config={api_url,admin_token:data.token,app_token:data.token,grant_token:data.token,account_id:scope.account_id,wallet_id:data.wallet,session_secret:randomBytes(32).toString('hex'),login_password:'ami-local-fixture',max_grant_units:'10000000000'};
const file=`${dir}/config.json`;await writeFile(file,JSON.stringify(config),{mode:0o600});
const children=[['@uai/admin','4336'],['@uai/demo','4337']].map(([name,port])=>spawn('pnpm',['--filter',name,'exec','vite','--host','127.0.0.1','--port',port,'--strictPort'],{stdio:'inherit',env:{...process.env,UAI_ADMIN_CONFIG:file,UAI_DEMO_CONFIG:file,UAI_DEMO_ROOT:`${dir}/demo`}}));
console.log('AMI local fixture: admin http://127.0.0.1:4336 · demo http://127.0.0.1:4337 · password ami-local-fixture');
let closing=false;async function close(){if(closing)return;closing=true;for(const child of children)child.kill('SIGTERM');await api.close();await pool.end();await rm(file,{force:true});}
process.on('SIGINT',()=>void close());process.on('SIGTERM',()=>void close());for(const child of children)child.on('exit',()=>void close());
