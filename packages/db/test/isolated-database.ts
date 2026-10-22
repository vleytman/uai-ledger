import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createPool} from '../src/index.js';

/** Installation-wide scans need their own database, not just different fixture IDs. */
export function isolatedTestDatabase(sourceUrl:string|undefined){
 const database=`uai_isolated_test_${randomUUID().replaceAll('-','')}`;
 let created=false,admin:ReturnType<typeof createPool>|undefined;
 const state={pool:null as ReturnType<typeof createPool>|null,url:undefined as string|undefined,
  async initialize(){
   if(!sourceUrl)throw new Error('test_database_url_required');
   admin=createPool(sourceUrl);
   await admin.query(`CREATE DATABASE ${database}`);created=true;
   const url=new URL(sourceUrl);url.pathname=`/${database}`;state.url=url.href;
   await promisify(execFile)(process.execPath,['--import','tsx',new URL('../../../scripts/migrate.ts',import.meta.url).pathname],{env:{...process.env,DATABASE_URL:state.url}});
   state.pool=createPool(state.url);
  },
  async close(){
   await state.pool?.end();
   try{if(created)await admin!.query(`DROP DATABASE ${database}`)}finally{await admin?.end()}
  }
 };
 return state;
}
