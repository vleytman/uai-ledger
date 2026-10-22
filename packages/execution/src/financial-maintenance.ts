import type pg from 'pg';
import type {Clock,Scope} from '../../contracts/src/index.js';
import {transaction} from '../../db/src/index.js';
import {tryLockExecutionAccount} from '../../db/src/execution-lock.js';
import {reconcileRevocationHolds} from '../../accounting/src/index.js';
import {closeExpiredOperations} from '../../quoting/src/index.js';
import {closeUnresolved,expireRequests,type Settlement} from './index.js';

/** One account per transaction: a busy wallet cannot retain another account's locks. */
export async function financialMaintenance(pool:pg.Pool,clock:Clock,settle:Settlement,scope?:Scope){
 const candidates=scope?[scope]:(await pool.query(`SELECT organization_id,application_id,account_id,min(due_at) AS oldest_due
  FROM (
   SELECT w.organization_id,w.application_id,w.account_id,r.reconcile_after AS due_at
    FROM grant_revocations r JOIN wallets w ON w.id=r.wallet_id
    WHERE r.status='prepared' AND r.reconcile_after<=$1 AND NOT EXISTS(SELECT 1 FROM revocation_incidents i WHERE i.revocation_id=r.id)
   UNION ALL SELECT organization_id,application_id,account_id,deadline_at FROM operations WHERE admission_status='open' AND deadline_at<=$1
   UNION ALL SELECT organization_id,application_id,account_id,deadline_at FROM execution_requests
    WHERE deadline_at<=$1 AND execution_status NOT IN ('succeeded','failed','canceled','refused')
     AND (cancel_requested_at IS NULL OR execution_status IN ('queued','leased','waiting_retry','waiting_recovery','paused'))
   UNION ALL SELECT organization_id,application_id,account_id,unresolved_at FROM execution_requests
    WHERE unresolved_at<=$1-interval '1 hour' AND financial_closed_at IS NULL
  ) due GROUP BY organization_id,application_id,account_id
  ORDER BY oldest_due,organization_id,application_id,account_id LIMIT 256`,[clock.now()])).rows;
 const totals={revocations:0,operations:0,deadlines:0,closed:0,maintenance_accounts:0,maintenance_busy_accounts:0};
 for(const account of candidates){
  try{
   const result=await transaction(pool,async tx=>{
    if(!await tryLockExecutionAccount(tx,account))return null;
    // Accounting-only commands may hold account/wallet rows without this barrier.
    // Roll back this account and continue instead of waiting for its row locks.
    await tx.query("SET LOCAL lock_timeout='250ms'");
    return {revocations:await reconcileRevocationHolds(tx,clock,account),operations:await closeExpiredOperations(tx,clock,account),
     deadlines:await expireRequests(tx,clock,settle,account),closed:await closeUnresolved(tx,clock,settle,account)};
   });
   if(!result){totals.maintenance_busy_accounts++;continue}
   totals.maintenance_accounts++;
   for(const key of ['revocations','operations','deadlines','closed'] as const)totals[key]+=result[key];
  }catch(error){
   if((error as {code?:string}).code!=='55P03')throw error;
   totals.maintenance_busy_accounts++;
  }
 }
 return totals;
}
