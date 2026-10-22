import type {Scope} from '../../contracts/src/index.js';
import type {Tx} from './index.js';

/** Account barrier precedes wallet, request, incident and exposure row locks.
 * Do not upgrade a shared account barrier inside a dispatch transaction.
 */
export async function lockExecutionAccount(tx:Tx,scope:Scope,mode:'shared'|'exclusive'='exclusive'){
 const key=JSON.stringify([scope.organization_id,scope.application_id,scope.account_id]);
 await tx.query(mode==='shared'?'SELECT pg_advisory_xact_lock_shared(hashtextextended($1,8194))':'SELECT pg_advisory_xact_lock(hashtextextended($1,8194))',[key]);
}
/** Maintenance skips busy accounts; a new cycle retries committed pending work. */
export async function tryLockExecutionAccount(tx:Tx,scope:Scope){
 return (await tx.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,8194)) AS locked',[JSON.stringify([scope.organization_id,scope.application_id,scope.account_id])])).rows[0].locked as boolean;
}

/** Compatibility sweeps acquire available accounts in a stable order, never a global exclusive lock. */
export async function forAvailableExecutionAccounts(tx:Tx,scopes:Scope[],run:(scope:Scope)=>Promise<number>){
 const ordered=new Map(scopes.map(scope=>[JSON.stringify([scope.organization_id,scope.application_id,scope.account_id]),scope]));
 let total=0;
 for(const key of [...ordered.keys()].sort()){
  const scope=ordered.get(key)!;
  if(await tryLockExecutionAccount(tx,scope))total+=await run(scope);
 }
 return total;
}

/** Only legacy lease and native-poll capacity share this short admission lock. */
export async function lockLegacyCapacity(tx:Tx){await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('legacy-capacity',8196))")}
