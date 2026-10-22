import type {SqlExecutor} from '../../db/src/index.js';
import {backgroundCapacity} from '../../execution/src/priority.js';
/** Called while the existing quota group lock is held, including multi-group bundles. */
export async function backgroundSlotsFull(db:SqlExecutor,group:{id:string;concurrency_limit:number;interactive_reserve:number},requestId:string,admissionId:string){
 const row=(await db.query(`SELECT r.priority,(SELECT count(*)::int FROM dispatch_admissions a JOIN execution_requests q ON q.id=a.request_id
  WHERE a.group_id=$1 AND a.id<>$3 AND a.slot_released_at IS NULL AND a.slot_expires_at>now() AND q.priority=0) AS background
  FROM execution_requests r WHERE r.id=$2`,[group.id,requestId,admissionId])).rows[0];
 return row?.priority===0&&row.background>=backgroundCapacity(group.concurrency_limit,group.interactive_reserve);
}
