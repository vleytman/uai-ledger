import {lockExecutionAccount,forAvailableExecutionAccounts} from '../../db/src/execution-lock.js';
import { CREDIT_UNIT, DomainError, hash, id, units, type Clock, type Scope, type WalletSnapshot } from '../../contracts/src/index.js';
import { emit, type Tx } from '../../db/src/index.js';

type Bucket = 'available'|'reserved'|'revocation_reserved'|'consumed'|'expired'|'revoked';
type Posting = { lot_id: string|null; bucket: Bucket|'issuance'|'debt'|'debt_consumed'; amount: bigint };
type Command = { idempotency_key: string; actor_id?: string; reason?: string };
type Lot = { id: string; available: string; reserved: string; expires_at: Date|null; terms: { refund_days: number }; [key:string]: any };
const fail = (code:string, message=code, status=409):never => { throw new DomainError(code,message,status); };
const positive = (value:string) => { const n=units(value); if(n===0n) fail('invalid_input','Amount must be positive',422); return n; };
const validateDate = (value:string|null):Date|null => { if(value===null) return null; const date=new Date(value); if(!Number.isFinite(date.getTime())) fail('invalid_input','Invalid timestamp',422); return date; };
const expired = (lot:Lot,clock:Clock) => lot.expires_at!==null && new Date(lot.expires_at).getTime()<=clock.now().getTime();

/** Lock order is always account, wallet. Call only inside a database transaction. */
export async function ensureWallet(tx:Tx,scope:Scope):Promise<string> {
 const account=await tx.query('SELECT id FROM accounts WHERE organization_id=$1 AND application_id=$2 AND id=$3 FOR UPDATE',[scope.organization_id,scope.application_id,scope.account_id]);
 if(!account.rowCount) fail('not_found','Account not found',404);
 await tx.query('INSERT INTO wallets(id,organization_id,application_id,account_id) VALUES($1,$2,$3,$4) ON CONFLICT(organization_id,application_id,account_id,credit_unit_id) DO NOTHING',[id('wallet'),scope.organization_id,scope.application_id,scope.account_id]);
 const {rows}=await tx.query('SELECT id FROM wallets WHERE organization_id=$1 AND application_id=$2 AND account_id=$3 FOR UPDATE',[scope.organization_id,scope.application_id,scope.account_id]);
 return rows[0].id;
}
async function assertSpending(tx:Tx,scope:Scope) {
 const {rows}=await tx.query('SELECT spending_suspended FROM accounts WHERE id=$1 AND organization_id=$2 AND application_id=$3',[scope.account_id,scope.organization_id,scope.application_id]);
 if(rows[0]?.spending_suspended) fail('account_denied','Spending is suspended',403);
}
async function snapshot(tx:Tx,walletId:string):Promise<WalletSnapshot> {
 const {rows}=await tx.query(`SELECT w.id,w.revision,(COALESCE(sum(b.available),0)-(SELECT COALESCE(sum(unpaid_units),0) FROM capture_debts WHERE wallet_id=w.id))::text available_units,
 COALESCE(sum(b.reserved+b.revocation_reserved),0)::text reserved_units
 FROM wallets w LEFT JOIN credit_lots l ON l.wallet_id=w.id LEFT JOIN lot_balances b ON b.lot_id=l.id WHERE w.id=$1 GROUP BY w.id`,[walletId]);
 const row=rows[0]; return {...row,balance_units:(BigInt(row.available_units)+BigInt(row.reserved_units)).toString()};
}
async function journal(tx:Tx,scope:Scope,clock:Clock,walletId:string,type:string,identity:string,postings:Posting[],input:{actor_id?:string;reason?:string},refs:Record<string,unknown>={}):Promise<string> {
 if(postings.length<2 || postings.reduce((s,p)=>s+p.amount,0n)!==0n) throw new Error('Unbalanced posting plan');
 const txid=id(type);
 await tx.query('INSERT INTO journal_transactions(id,wallet_id,type,identity,actor_id,reason,references_json,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[txid,walletId,type,identity,input.actor_id??'system',input.reason??type,refs,clock.now()]);
 for(const p of postings) {
  if(p.amount===0n) continue;
  if(p.lot_id) await tx.query(`UPDATE lot_balances SET ${p.bucket}=${p.bucket}+$2::bigint WHERE lot_id=$1`,[p.lot_id,p.amount.toString()]);
  await tx.query('INSERT INTO journal_postings(transaction_id,wallet_id,lot_id,bucket,amount_units) VALUES($1,$2,$3,$4,$5)',[txid,walletId,p.lot_id,p.bucket,p.amount.toString()]);
 }
 await tx.query('UPDATE wallets SET revision=revision+1 WHERE id=$1',[walletId]);
 await emit(tx,scope,'wallet.updated',{type:'wallet',id:walletId},{...await snapshot(tx,walletId)});
 return txid;
}
function transfer(lot:string,from:Bucket,to:Bucket,amount:bigint):Posting[] {return [{lot_id:lot,bucket:from,amount:-amount},{lot_id:lot,bucket:to,amount}];}
async function lots(tx:Tx,walletId:string):Promise<Lot[]> {
 return (await tx.query(`SELECT l.*,b.available::text,b.reserved::text,b.revocation_reserved::text,b.consumed::text,b.expired::text,b.revoked::text FROM credit_lots l JOIN lot_balances b ON b.lot_id=l.id WHERE l.wallet_id=$1 ORDER BY l.expires_at ASC NULLS LAST,l.created_at,l.id`,[walletId])).rows;
}
async function expireLots(tx:Tx,scope:Scope,clock:Clock,walletId:string) {
 for(const lot of await lots(tx,walletId)) if(expired(lot,clock)&&BigInt(lot.available)>0n) {
  await journal(tx,scope,clock,walletId,'expire',`expire:${lot.id}`,transfer(lot.id,'available','expired',BigInt(lot.available)),{reason:'lot_expired'},{lot_id:lot.id});
 }
}
/** Repay oldest debt from available, unexpired lots and retain refundable funding allocations. */
async function repayDebt(tx:Tx,scope:Scope,clock:Clock,wallet:string) {
 const debts=(await tx.query('SELECT d.* FROM capture_debts d JOIN journal_transactions t ON t.id=d.capture_id WHERE d.wallet_id=$1 AND d.unpaid_units>0 ORDER BY t.created_at,d.capture_id',[wallet])).rows;
 if(!debts.length)return;
 const available=(await lots(tx,wallet)).filter(l=>!expired(l,clock)&&BigInt(l.available)>0n);
 const postings:Posting[]=[];
 for(const debt of debts){let owed=BigInt(debt.unpaid_units);
  for(const lot of available){const take=BigInt(lot.available)<owed?BigInt(lot.available):owed;if(!take)continue;
   postings.push(...transfer(lot.id,'available','consumed',take),{lot_id:null,bucket:'debt',amount:take},{lot_id:null,bucket:'debt_consumed',amount:-take});
   await tx.query('INSERT INTO capture_allocations(capture_id,lot_id,amount_units) VALUES($1,$2,$3) ON CONFLICT(capture_id,lot_id) DO UPDATE SET amount_units=capture_allocations.amount_units+EXCLUDED.amount_units',[debt.capture_id,lot.id,take.toString()]);
   owed-=take;lot.available=(BigInt(lot.available)-take).toString();if(!owed)break;
  }
  await tx.query('UPDATE capture_debts SET unpaid_units=$2 WHERE capture_id=$1',[debt.capture_id,owed.toString()]);
 }
 if(postings.length)await journal(tx,scope,clock,wallet,'debt_repayment',id('repayment'),postings,{reason:'Repay actual-usage debt'});
}
export async function getWallet(tx:Tx,scope:Scope,clock:Clock):Promise<WalletSnapshot> {
 const wallet=await ensureWallet(tx,scope); await expireLots(tx,scope,clock,wallet); await repayDebt(tx,scope,clock,wallet); return snapshot(tx,wallet);
}
async function command<T>(tx:Tx,scope:Scope,clock:Clock,name:string,input:Command&Record<string,unknown>,fn:(wallet:string)=>Promise<T>):Promise<T> {
 if(!input.idempotency_key?.trim()) fail('invalid_input','Idempotency key required',422);
 const wallet=await ensureWallet(tx,scope);
 const {rows}=await tx.query('SELECT payload_hash,result FROM accounting_commands WHERE wallet_id=$1 AND command=$2 AND key=$3',[wallet,name,input.idempotency_key]);
 const {actor_id:_actor,...identityInput}=input; const digest=hash(identityInput);
 if(rows.length) { if(rows[0].payload_hash!==digest) fail('idempotency_conflict'); return rows[0].result; }
 await expireLots(tx,scope,clock,wallet);
 const result=await fn(wallet);
 await tx.query('INSERT INTO accounting_commands(wallet_id,command,key,payload_hash,result) VALUES($1,$2,$3,$4,$5)',[wallet,name,input.idempotency_key,digest,result]);
 return result;
}
export type GrantInput=Command&{amount_units:string;source:'purchase'|'subscription'|'promotion'|'migration'|'internal';external_reference:string;terms_version:string;expires_at:string|null;credit_unit_id?:string;refund_days?:number;issuer?:string};
export async function grant(tx:Tx,scope:Scope,clock:Clock,input:GrantInput) {
 const issuer=input.issuer??`application:${scope.application_id}`;
 if(!issuer.trim()||issuer.length>200||!input.external_reference?.trim())fail('invalid_input','Stable issuer and reference required',422);
 await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`grant-source:${hash([scope.organization_id,scope.application_id,issuer,input.external_reference])}`]);
 return command(tx,scope,clock,'grant',input,async wallet=>{
  const amount=positive(input.amount_units);
  if(!Object.hasOwn(input,'expires_at')) fail('invalid_input','expires_at must be explicit',422);
  if(input.credit_unit_id && input.credit_unit_id!==CREDIT_UNIT) fail('invalid_input','Unsupported credit unit',422);
  if(!input.external_reference?.trim()||!input.terms_version?.trim()) fail('invalid_input','Reference and terms required',422);
  if(['promotion','migration','internal'].includes(input.source)&&!input.reason?.trim()) fail('invalid_input','Administrative grant needs reason',422);
  const expires=validateDate(input.expires_at); const refundDays=input.refund_days??30;
  if(!Number.isSafeInteger(refundDays)||refundDays<=0) fail('invalid_input','Invalid refund policy',422);
  const terms={expires_at:expires?.toISOString()??null,refund_days:refundDays};
  const existing=(await tx.query('SELECT l.* FROM grant_source_identities s JOIN credit_lots l ON l.id=s.lot_id WHERE s.organization_id=$1 AND s.application_id=$2 AND s.issuer=$3 AND s.external_reference=$4',[scope.organization_id,scope.application_id,issuer,input.external_reference])).rows[0];
  if(existing) {
   if(existing.wallet_id!==wallet||existing.original_amount_units!==amount.toString()||existing.source!==input.source||existing.terms_version!==input.terms_version||hash(existing.terms)!==hash(terms)) fail('idempotency_conflict');
   return {grant_id:existing.id,lot_id:existing.id,wallet:await snapshot(tx,wallet)};
  }
  const lot=id('lot');
  await tx.query('INSERT INTO credit_lots(id,wallet_id,original_amount_units,source,external_reference,terms_version,terms,actor_id,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[lot,wallet,amount.toString(),input.source,input.external_reference,input.terms_version,terms,input.actor_id??'system',expires,clock.now()]);
  await tx.query('INSERT INTO lot_balances(lot_id) VALUES($1)',[lot]);
  await tx.query('INSERT INTO grant_source_identities(organization_id,application_id,issuer,external_reference,wallet_id,lot_id) VALUES($1,$2,$3,$4,$5,$6)',[scope.organization_id,scope.application_id,issuer,input.external_reference,wallet,lot]);
  await journal(tx,scope,clock,wallet,'grant',`grant:${lot}`,[{lot_id:null,bucket:'issuance',amount:-amount},{lot_id:lot,bucket:'available',amount}],input,{lot_id:lot});
  await expireLots(tx,scope,clock,wallet);
  await repayDebt(tx,scope,clock,wallet);
  return {grant_id:lot,lot_id:lot,wallet:await snapshot(tx,wallet)};
 });
}
async function reservation(tx:Tx,wallet:string,operation:string) {
 const row=(await tx.query('SELECT * FROM reservations WHERE wallet_id=$1 AND operation_id=$2',[wallet,operation])).rows[0];
 if(!row) fail('not_found','Reservation not found',404); return row;
}
async function allocate(tx:Tx,scope:Scope,clock:Clock,wallet:string,operation:string,amount:bigint,identity:string,input:Command) {
 await expireLots(tx,scope,clock,wallet);
 await repayDebt(tx,scope,clock,wallet);
 if(BigInt((await snapshot(tx,wallet)).available_units)<0n)fail('insufficient_credits','Repay the negative balance before starting new work',402);
 const eligible=(await lots(tx,wallet)).filter(lot=>!expired(lot,clock));
 const available=eligible.reduce((total,lot)=>total+BigInt(lot.available),0n);
 if(available<amount) throw new DomainError('insufficient_credits','Insufficient available credits',402,{required_units:amount.toString(),available_units:available.toString()});
 let remaining=amount; const postings:Posting[]=[];
 for(const lot of eligible) {
  if(remaining===0n) break; const take=BigInt(lot.available)<remaining?BigInt(lot.available):remaining; if(take===0n) continue;
  postings.push(...transfer(lot.id,'available','reserved',take));
  await tx.query('INSERT INTO reservation_allocations(operation_id,lot_id,reserved_units) VALUES($1,$2,$3) ON CONFLICT(operation_id,lot_id) DO UPDATE SET reserved_units=reservation_allocations.reserved_units+EXCLUDED.reserved_units',[operation,lot.id,take.toString()]);
  remaining-=take;
 }
 if(amount>0n) await journal(tx,scope,clock,wallet,'reserve',identity,postings,input,{operation_id:operation});
}
export async function reserve(tx:Tx,scope:Scope,clock:Clock,input:Command&{operation_id:string;max_units:string}) {
 return command(tx,scope,clock,'reserve',input,async wallet=>{
  await assertSpending(tx,scope); const max=units(input.max_units);
  const existing=(await tx.query('SELECT * FROM reservations WHERE operation_id=$1',[input.operation_id])).rows[0];
  if(existing) fail('budget_conflict','Operation reservation already exists');
  await tx.query('INSERT INTO reservations(operation_id,wallet_id,max_units) VALUES($1,$2,$3)',[input.operation_id,wallet,max.toString()]);
  await allocate(tx,scope,clock,wallet,input.operation_id,max,`reserve:${input.operation_id}`,input);
  return {operation_id:input.operation_id,max_units:max.toString(),wallet:await snapshot(tx,wallet)};
 });
}
export async function amendReservation(tx:Tx,scope:Scope,clock:Clock,input:Command&{operation_id:string;additional_units:string}) {
 return command(tx,scope,clock,'amend',input,async wallet=>{
  await assertSpending(tx,scope); const row=await reservation(tx,wallet,input.operation_id); if(row.status!=='open') fail('budget_conflict');
  const more=positive(input.additional_units); const max=units((BigInt(row.max_units)+more).toString());
  await allocate(tx,scope,clock,wallet,input.operation_id,more,`amend:${input.operation_id}:${input.idempotency_key}`,input);
  await tx.query('UPDATE reservations SET max_units=$2 WHERE operation_id=$1',[input.operation_id,max.toString()]);
  return {operation_id:input.operation_id,max_units:max.toString(),wallet:await snapshot(tx,wallet)};
 });
}
export async function claim(tx:Tx,scope:Scope,clock:Clock,input:Command&{operation_id:string;request_id:string;max_units:string}) {
 return command(tx,scope,clock,'claim',input,async wallet=>{
  await assertSpending(tx,scope); const row=await reservation(tx,wallet,input.operation_id); if(row.status!=='open') fail('budget_conflict');
  const amount=units(input.max_units);
  const previous=(await tx.query('SELECT request_id FROM request_budget_claims WHERE request_id=$1',[input.request_id])).rows[0]; if(previous) fail('budget_conflict','Request already claimed');
  const open=(await tx.query("SELECT COALESCE(sum(max_units),0)::text amount FROM request_budget_claims WHERE operation_id=$1 AND status='open'",[input.operation_id])).rows[0];
  if(BigInt(row.captured_units)+BigInt(row.released_units)+BigInt(open.amount)+amount>BigInt(row.max_units)) fail('budget_conflict','Open claims exceed reservation');
  await tx.query('INSERT INTO request_budget_claims(request_id,operation_id,max_units) VALUES($1,$2,$3)',[input.request_id,input.operation_id,amount.toString()]);
  return {request_id:input.request_id,operation_id:input.operation_id,max_units:amount.toString()};
 });
}
export async function settleClaim(tx:Tx,scope:Scope,clock:Clock,input:Command&{request_id:string;charged_units:string;allow_overdraft?:boolean}) {
 return command(tx,scope,clock,'settle',input,async wallet=>{
  const row=(await tx.query('SELECT c.*,r.wallet_id FROM request_budget_claims c JOIN reservations r USING(operation_id) WHERE request_id=$1 AND r.wallet_id=$2',[input.request_id,wallet])).rows[0];
  if(!row) fail('not_found','Claim not found',404); if(row.status!=='open') fail('budget_conflict','Claim financially closed');
  const amount=units(input.charged_units);
  if(amount>BigInt(row.max_units)) {
   if(!input.allow_overdraft)fail('budget_conflict','Charge exceeds request claim');
   // A shared reservation (a reserve pool) covers the overrun from its unclaimed part first.
   const shared=(await tx.query("SELECT (r.max_units-r.captured_units-r.released_units-(SELECT COALESCE(sum(max_units),0) FROM request_budget_claims WHERE operation_id=r.operation_id AND status='open'))::text unclaimed FROM reservations r WHERE operation_id=$1",[row.operation_id])).rows[0];
   const overrun=amount-BigInt(row.max_units),unclaimed=BigInt(shared.unclaimed)>0n?BigInt(shared.unclaimed):0n;
   const extra=overrun>unclaimed?overrun-unclaimed:0n;
   // Authorised actual usage can consume free credits after the initial estimate, then create debt.
   const available=(await lots(tx,wallet)).filter(l=>!expired(l,clock));let left=extra;const funding:Posting[]=[];
   for(const lot of available){if(!left)break;const take=BigInt(lot.available)<left?BigInt(lot.available):left;if(!take)continue;left-=take;funding.push(...transfer(lot.id,'available','reserved',take));await tx.query('INSERT INTO reservation_allocations(operation_id,lot_id,reserved_units) VALUES($1,$2,$3) ON CONFLICT(operation_id,lot_id) DO UPDATE SET reserved_units=reservation_allocations.reserved_units+EXCLUDED.reserved_units',[row.operation_id,lot.id,take.toString()]);}
   if(funding.length)await journal(tx,scope,clock,wallet,'reserve',`usage-extra:${input.request_id}`,funding,input);
   if(extra)await tx.query('UPDATE reservations SET max_units=max_units+$2::bigint WHERE operation_id=$1',[row.operation_id,extra.toString()]);
   await tx.query('UPDATE request_budget_claims SET max_units=$2 WHERE request_id=$1',[input.request_id,amount.toString()]);
  }
  const allocations=(await tx.query('SELECT a.*,l.expires_at,l.created_at FROM reservation_allocations a JOIN credit_lots l ON l.id=a.lot_id WHERE operation_id=$1 ORDER BY l.expires_at ASC NULLS LAST,l.created_at,l.id',[row.operation_id])).rows;
  let remaining=amount; const postings:Posting[]=[]; const parts:{lot_id:string;amount:bigint}[]=[];
  for(const allocation of allocations) {
   const available=BigInt(allocation.reserved_units)-BigInt(allocation.captured_units)-BigInt(allocation.released_units); const take=available<remaining?available:remaining;
   if(take===0n) continue; remaining-=take; postings.push(...transfer(allocation.lot_id,'reserved','consumed',take)); parts.push({lot_id:allocation.lot_id,amount:take});
   await tx.query('UPDATE reservation_allocations SET captured_units=captured_units+$3::bigint WHERE operation_id=$1 AND lot_id=$2',[row.operation_id,allocation.lot_id,take.toString()]);
  }
  if(remaining!==0n&&!input.allow_overdraft)throw new Error('Reservation allocation invariant violated');
  const debt=remaining;if(debt>0n)postings.push({lot_id:null,bucket:'debt',amount:-debt},{lot_id:null,bucket:'debt_consumed',amount:debt});
  let capture:string|null=null;
  if(amount>0n) {
   capture=await journal(tx,scope,clock,wallet,'capture',`capture:${input.request_id}`,postings,input,{request_id:input.request_id,operation_id:row.operation_id});
   if(debt>0n)await tx.query('INSERT INTO capture_debts(capture_id,wallet_id,original_units,unpaid_units) VALUES($1,$2,$3,$3)',[capture,wallet,debt.toString()]);
   for(const part of parts) await tx.query('INSERT INTO capture_allocations(capture_id,lot_id,amount_units) VALUES($1,$2,$3)',[capture,part.lot_id,part.amount.toString()]);
  }
  await tx.query("UPDATE request_budget_claims SET status='closed',charged_units=$2,capture_id=$3 WHERE request_id=$1",[input.request_id,amount.toString(),capture]);
  await tx.query('UPDATE reservations SET captured_units=captured_units+$2::bigint WHERE operation_id=$1',[row.operation_id,amount.toString()]);
  return {request_id:input.request_id,capture_id:capture,charged_units:amount.toString(),wallet:await snapshot(tx,wallet)};
 });
}
export async function releaseReservation(tx:Tx,scope:Scope,clock:Clock,input:Command&{operation_id:string}) {
 return command(tx,scope,clock,'release',input,async wallet=>{
  const row=await reservation(tx,wallet,input.operation_id); if(row.status!=='open') fail('budget_conflict','Reservation is closed');
  if((await tx.query("SELECT 1 FROM request_budget_claims WHERE operation_id=$1 AND status='open' LIMIT 1",[input.operation_id])).rowCount) fail('budget_conflict','Open claims remain');
  const allocations=(await tx.query('SELECT a.*,l.expires_at FROM reservation_allocations a JOIN credit_lots l ON l.id=a.lot_id WHERE operation_id=$1',[input.operation_id])).rows;
  const postings:Posting[]=[]; let released=0n, expiredAmount=0n;
  for(const part of allocations) {
   const amount=BigInt(part.reserved_units)-BigInt(part.captured_units)-BigInt(part.released_units); if(amount===0n) continue;
   const destination=expired(part,clock)?'expired':'available'; if(destination==='expired') expiredAmount+=amount;
   postings.push(...transfer(part.lot_id,'reserved',destination,amount)); released+=amount;
   await tx.query('UPDATE reservation_allocations SET released_units=released_units+$3::bigint WHERE operation_id=$1 AND lot_id=$2',[input.operation_id,part.lot_id,amount.toString()]);
  }
  if(released>0n) await journal(tx,scope,clock,wallet,'release',`release:${input.operation_id}`,postings,input,{operation_id:input.operation_id});
  await tx.query("UPDATE reservations SET status='closed',released_units=released_units+$2::bigint WHERE operation_id=$1",[input.operation_id,released.toString()]);
  await repayDebt(tx,scope,clock,wallet);
  return {operation_id:input.operation_id,released_units:released.toString(),expired_units:expiredAmount.toString(),wallet:await snapshot(tx,wallet)};
 });
}
export async function refund(tx:Tx,scope:Scope,clock:Clock,input:Command&{capture_id:string;amount_units:string;external_reference:string}) {
 return command(tx,scope,clock,'refund',input,async wallet=>{
  const amount=positive(input.amount_units); if(!input.reason?.trim()||!input.external_reference?.trim()) fail('invalid_input','Refund requires reason and reference',422);
  const identity=`refund:${input.external_reference}`;
  const previous=(await tx.query("SELECT id,references_json FROM journal_transactions WHERE wallet_id=$1 AND identity=$2",[wallet,identity])).rows[0];
  if(previous) {
   if(previous.references_json.capture_id!==input.capture_id||previous.references_json.amount_units!==amount.toString()) fail('idempotency_conflict');
   return {transaction_id:previous.id,allocations:previous.references_json.allocations,wallet:await snapshot(tx,wallet)};
  }
  const capture=(await tx.query("SELECT id FROM journal_transactions WHERE id=$1 AND wallet_id=$2 AND type='capture'",[input.capture_id,wallet])).rows[0];
  if(!capture) fail('not_found','Capture not found',404);
  const parts=(await tx.query('SELECT a.*,l.expires_at,l.terms,l.terms_version FROM capture_allocations a JOIN credit_lots l ON l.id=a.lot_id WHERE capture_id=$1 ORDER BY l.expires_at ASC NULLS LAST,l.created_at,l.id',[input.capture_id])).rows;
  const debt=(await tx.query('SELECT * FROM capture_debts WHERE capture_id=$1',[input.capture_id])).rows[0];
  const refundable=BigInt(debt?.unpaid_units??0)+parts.reduce((sum:bigint,p:any)=>sum+BigInt(p.amount_units)-BigInt(p.refunded_units),0n);
  if(amount>refundable) fail('budget_conflict','Refund exceeds remaining captured amount');
  let remaining=amount; const postings:Posting[]=[]; const allocations:{lot_id:string;amount_units:string;expires_at:string|null}[]=[];
  if(debt&&BigInt(debt.unpaid_units)>0n){const take=BigInt(debt.unpaid_units)<remaining?BigInt(debt.unpaid_units):remaining;remaining-=take;postings.push({lot_id:null,bucket:'debt',amount:take},{lot_id:null,bucket:'debt_consumed',amount:-take});await tx.query('UPDATE capture_debts SET unpaid_units=unpaid_units-$2::bigint,refunded_units=refunded_units+$2::bigint WHERE capture_id=$1',[input.capture_id,take.toString()]);}
  for(const part of parts) {
   const available=BigInt(part.amount_units)-BigInt(part.refunded_units); const take=available<remaining?available:remaining; if(take===0n) continue; remaining-=take;
   let destination=part.lot_id; let expiry:Date|null=part.expires_at;
   if(expired(part,clock)) {
    destination=id('lot'); expiry=new Date(clock.now().getTime()+part.terms.refund_days*86400000);
    const terms={expires_at:expiry.toISOString(),refund_days:part.terms.refund_days,original_lot_id:part.lot_id,capture_id:input.capture_id};
    await tx.query("INSERT INTO credit_lots(id,wallet_id,original_amount_units,source,external_reference,terms_version,terms,actor_id,expires_at,created_at) VALUES($1,$2,$3,'refund',$4,$5,$6,$7,$8,$9)",[destination,wallet,take.toString(),`refund:${input.external_reference}:${part.lot_id}`,part.terms_version,terms,input.actor_id??'system',expiry,clock.now()]);
    await tx.query('INSERT INTO lot_balances(lot_id) VALUES($1)',[destination]);
   }
   postings.push({lot_id:part.lot_id,bucket:'consumed',amount:-take},{lot_id:destination,bucket:'available',amount:take});
   allocations.push({lot_id:destination,amount_units:take.toString(),expires_at:expiry?.toISOString()??null});
   await tx.query('UPDATE capture_allocations SET refunded_units=refunded_units+$3::bigint WHERE capture_id=$1 AND lot_id=$2',[input.capture_id,part.lot_id,take.toString()]);
  }
  const transaction=await journal(tx,scope,clock,wallet,'refund',identity,postings,input,{capture_id:input.capture_id,amount_units:amount.toString(),allocations});
  await repayDebt(tx,scope,clock,wallet);
  return {transaction_id:transaction,allocations,wallet:await snapshot(tx,wallet)};
 });
}
export async function prepareRevocation(tx:Tx,scope:Scope,clock:Clock,input:Command&{grant_id:string;amount_units:string;external_reference:string;reconcile_after?:string}) {
 return command(tx,scope,clock,'prepare_revocation',input,async wallet=>{
  const amount=positive(input.amount_units); if(!input.reason?.trim()||!input.external_reference?.trim()) fail('invalid_input','Revocation requires reason and reference',422);
  const digest=hash({grant_id:input.grant_id,amount_units:input.amount_units,reason:input.reason});
  const previous=(await tx.query('SELECT * FROM grant_revocations WHERE wallet_id=$1 AND external_reference=$2',[wallet,input.external_reference])).rows[0];
  if(previous) { if(previous.payload_hash!==digest) fail('idempotency_conflict'); return {revocation_id:previous.id,status:previous.status,reconcile_after:new Date(previous.reconcile_after).toISOString(),wallet:await snapshot(tx,wallet)}; }
  const lot=(await lots(tx,wallet)).find(l=>l.id===input.grant_id); if(!lot) throw new DomainError('not_found','Grant not found',404);
  if(BigInt(lot.available)<amount) throw new DomainError('revocation_unavailable','Grant has insufficient available credits',409,{available_units:lot.available});
  const revocation=id('revocation'); const reconcile=input.reconcile_after?validateDate(input.reconcile_after)!:new Date(clock.now().getTime()+3600000);
  await tx.query('INSERT INTO grant_revocations(id,wallet_id,lot_id,amount_units,external_reference,payload_hash,reconcile_after) VALUES($1,$2,$3,$4,$5,$6,$7)',[revocation,wallet,lot.id,amount.toString(),input.external_reference,digest,reconcile]);
  await journal(tx,scope,clock,wallet,'prepare_revocation',`prepare_revocation:${revocation}`,transfer(lot.id,'available','revocation_reserved',amount),input,{revocation_id:revocation});
  return {revocation_id:revocation,status:'prepared',reconcile_after:reconcile.toISOString(),wallet:await snapshot(tx,wallet)};
 });
}
async function finishRevocation(tx:Tx,scope:Scope,clock:Clock,input:Command&{revocation_id:string},commit:boolean) {
 const action=commit?'commit_revocation':'cancel_revocation';
 return command(tx,scope,clock,action,input,async wallet=>{
  const row=(await tx.query('SELECT r.*,l.expires_at FROM grant_revocations r JOIN credit_lots l ON l.id=r.lot_id WHERE r.id=$1 AND r.wallet_id=$2',[input.revocation_id,wallet])).rows[0];
  if(!row) fail('not_found','Revocation not found',404);
  const target=commit?'committed':'canceled';
  if(row.status!==target) {
   if(row.status!=='prepared') fail('budget_conflict','Revocation already finalized');
   await journal(tx,scope,clock,wallet,action,`${action}:${row.id}`,transfer(row.lot_id,'revocation_reserved',commit?'revoked':expired(row,clock)?'expired':'available',BigInt(row.amount_units)),input,{revocation_id:row.id});
   await tx.query('UPDATE grant_revocations SET status=$2 WHERE id=$1',[row.id,target]);
   const incidents=(await tx.query("UPDATE revocation_incidents SET status='resolved',resolution=$2,resolved_at=$3 WHERE revocation_id=$1 AND status='open' RETURNING id",[row.id,target,clock.now()])).rows;
   for(const incident of incidents)await emit(tx,scope,'revocation.reconciled',{type:'revocation_incident',id:incident.id},{revocation_id:row.id,status:'resolved',resolution:target});
  }
  return {revocation_id:row.id,status:target,wallet:await snapshot(tx,wallet)};
 });
}
export const commitRevocation=(tx:Tx,scope:Scope,clock:Clock,input:Command&{revocation_id:string})=>finishRevocation(tx,scope,clock,input,true);
export const cancelRevocation=(tx:Tx,scope:Scope,clock:Clock,input:Command&{revocation_id:string})=>finishRevocation(tx,scope,clock,input,false);
/** Test-only API composes ordinary journal entries; never overwrite ledger balances. */
export async function setTestAvailableBalance(tx:Tx,scope:Scope,clock:Clock,input:Command&{available_units:string;expected_revision:number}) {
 return command(tx,scope,clock,'test_available_balance',input,async wallet=>{
  const current=await snapshot(tx,wallet),target=units(input.available_units);
  if(current.revision!==input.expected_revision)throw new DomainError('revision_conflict','Баланс изменился. Обновите страницу и повторите.',409);
  if(BigInt(current.reserved_units)>0n)throw new DomainError('balance_reserved','Дождитесь завершения текущих операций или отмените их.',409);
  const delta=target-BigInt(current.available_units),reason=input.reason??'Установка остатка в demo';
  if(delta>0n)await grant(tx,scope,clock,{amount_units:delta.toString(),source:'internal',external_reference:`demo-balance:${input.idempotency_key}`,terms_version:'demo-test-v1',expires_at:null,reason,actor_id:input.actor_id,idempotency_key:`${input.idempotency_key}:grant`});
  let remaining=-delta;
  for(const lot of delta<0n?await lots(tx,wallet):[]){
   const available=BigInt(lot.available),take=available<remaining?available:remaining;
   if(take<=0n)continue;
   const base=`${input.idempotency_key}:${lot.id}`;
   const prepared=await prepareRevocation(tx,scope,clock,{grant_id:lot.id,amount_units:take.toString(),external_reference:`demo-balance:${base}`,reason,actor_id:input.actor_id,idempotency_key:`${base}:prepare`});
   await commitRevocation(tx,scope,clock,{revocation_id:prepared.revocation_id,reason,actor_id:input.actor_id,idempotency_key:`${base}:commit`});
   remaining-=take;if(remaining===0n)break;
  }
  return {wallet:await snapshot(tx,wallet)};
 });
}
/** Queue cancellation is composed by execution in the same transaction. */
export async function setSpendingSuspended(tx:Tx,scope:Scope,clock:Clock,input:Command&{suspended:boolean}) {
 return command(tx,scope,clock,input.suspended?'spending_suspend':'spending_resume',input,async wallet=>{
  if(!input.reason?.trim()) fail('invalid_input','Suspension/resume requires reason',422);
  await tx.query('UPDATE accounts SET spending_suspended=$2 WHERE id=$1',[scope.account_id,input.suspended]);
  await tx.query('INSERT INTO audit_events(id,organization_id,application_id,actor_id,action,resource_id,reason,metadata,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id('audit'),scope.organization_id,scope.application_id,input.actor_id??'system',input.suspended?'spending.suspend':'spending.resume',scope.account_id,input.reason,{},clock.now()]);
  await emit(tx,scope,input.suspended?'account.spending_suspended':'account.spending_resumed',{type:'account',id:scope.account_id});
  return {spending_suspended:input.suspended,wallet:await snapshot(tx,wallet)};
 });
}
export async function getLots(tx:Tx,scope:Scope,clock:Clock) { const wallet=await ensureWallet(tx,scope); await expireLots(tx,scope,clock,wallet); return lots(tx,wallet); }
const CREDIT_SOURCES=['purchase','subscription','promotion','migration','internal'] as const;
/**
 * Read-only application-wide credit summary. Expired amounts are attributed to lot.expires_at and include
 * available credits whose expire posting has not been materialized yet, so the result does not depend on lazy expiry.
 */
export async function getCreditSummary(tx:Tx,scope:{organization_id:string;application_id:string},clock:Clock,filters:{account_id?:string;period_start?:string;period_end?:string;expiring_before?:string}) {
 const now=clock.now(),expiringBefore=filters.expiring_before?new Date(filters.expiring_before):new Date(now.getTime()+30*86400000);
 const row=(await tx.query(`
 WITH scoped AS MATERIALIZED (SELECT id FROM wallets WHERE organization_id=$1 AND application_id=$2 AND ($3::text IS NULL OR account_id=$3)),
 lot_rows AS MATERIALIZED (SELECT l.source,l.original_amount_units,l.created_at,l.expires_at,b.available,b.reserved,b.revocation_reserved,b.expired FROM credit_lots l JOIN scoped w ON w.id=l.wallet_id JOIN lot_balances b ON b.lot_id=l.id),
 flows AS MATERIALIZED (SELECT p.bucket,p.amount_units FROM journal_transactions t JOIN scoped w ON w.id=t.wallet_id JOIN journal_postings p ON p.transaction_id=t.id
  WHERE p.bucket IN ('consumed','revoked') AND ($4::timestamptz IS NULL OR t.created_at>=$4) AND ($5::timestamptz IS NULL OR t.created_at<$5)),
 issued AS (SELECT * FROM lot_rows WHERE source<>'refund' AND ($4::timestamptz IS NULL OR created_at>=$4) AND ($5::timestamptz IS NULL OR created_at<$5)),
 expired_lots AS (SELECT * FROM lot_rows WHERE expires_at<=$6 AND ($4::timestamptz IS NULL OR expires_at>=$4) AND ($5::timestamptz IS NULL OR expires_at<$5))
 SELECT (SELECT count(*)::int FROM scoped) wallet_count,
  (SELECT COALESCE(sum(original_amount_units),0)::text FROM issued) issued_units,
  (SELECT jsonb_object_agg(s,(SELECT COALESCE(sum(original_amount_units),0)::text FROM issued WHERE source=s)) FROM unnest($8::text[]) s) issued_by_source,
  (SELECT COALESCE(sum(amount_units) FILTER(WHERE bucket='consumed' AND amount_units>0),0)::text FROM flows) consumed_units,
  (SELECT COALESCE(-sum(amount_units) FILTER(WHERE bucket='consumed' AND amount_units<0),0)::text FROM flows) refunded_units,
  (SELECT COALESCE(sum(amount_units) FILTER(WHERE bucket='revoked'),0)::text FROM flows) revoked_units,
  (SELECT COALESCE(sum(expired+available),0)::text FROM expired_lots) expired_units,
  (SELECT COALESCE(sum(reserved+revocation_reserved),0)::text FROM expired_lots) expired_held_units,
  (SELECT COALESCE(sum(available) FILTER(WHERE expires_at IS NULL OR expires_at>$6),0)::text FROM lot_rows) available_units,
  (SELECT COALESCE(sum(reserved),0)::text FROM lot_rows) reserved_units,
  (SELECT COALESCE(sum(revocation_reserved),0)::text FROM lot_rows) revocation_reserved_units,
  (SELECT COALESCE(sum(d.unpaid_units),0)::text FROM capture_debts d JOIN scoped w ON w.id=d.wallet_id WHERE d.unpaid_units>0) debt_units,
  (SELECT COALESCE(sum(available) FILTER(WHERE expires_at>$6 AND expires_at<$7),0)::text FROM lot_rows) expiring_units
 `,[scope.organization_id,scope.application_id,filters.account_id??null,filters.period_start??null,filters.period_end??null,now,expiringBefore,[...CREDIT_SOURCES]])).rows[0];
 return {filters:{application_id:scope.application_id,account_id:filters.account_id??null,period_start:filters.period_start??null,period_end:filters.period_end??null,expiring_before:expiringBefore.toISOString()},as_of:now.toISOString(),...row,
  issued_basis:'lot_created_at' as const,flow_basis:'journal_created_at' as const,expired_basis:'lot_expires_at' as const,expired_precision:row.expired_held_units==='0'?'final' as const:'partial' as const};
}
export async function getJournal(tx:Tx,scope:Scope,options:{limit?:number;before?:string}={}) {
 const wallet=await ensureWallet(tx,scope); const limit=Math.min(200,Math.max(1,options.limit??50));
 let beforeTime:string|null=null,beforeId:string|null=null;
 if(options.before){
  try{const parsed=JSON.parse(Buffer.from(options.before,'base64url').toString('utf8'));if(!Array.isArray(parsed)||parsed.length!==2||typeof parsed[0]!=='string'||typeof parsed[1]!=='string'||!Number.isFinite(Date.parse(parsed[0])))throw new Error('cursor');[beforeTime,beforeId]=parsed;}
  catch{throw new DomainError('invalid_input','Invalid journal cursor',422);}
 }
 const rows=(await tx.query(`SELECT j.id,j.wallet_id,j.type,j.actor_id,j.reason,j.references_json,j.created_at,j.audit_identity,COALESCE(jsonb_agg(jsonb_build_object('lot_id',p.lot_id,'bucket',p.bucket,'amount_units',p.amount_units::text)) FILTER(WHERE p.id IS NOT NULL),'[]') postings FROM journal_transactions j LEFT JOIN journal_postings p ON p.transaction_id=j.id WHERE j.wallet_id=$1 AND ($2::timestamptz IS NULL OR (j.created_at,j.id)<($2::timestamptz,$3::text)) GROUP BY j.id ORDER BY j.created_at DESC,j.id DESC LIMIT $4`,[wallet,beforeTime,beforeId,limit])).rows;
 return rows.map(row=>({...row,cursor:Buffer.from(JSON.stringify([new Date(row.created_at).toISOString(),row.id])).toString('base64url')}));
}
export async function getReservation(tx:Tx,scope:Scope,operationId:string) {
 const wallet=await ensureWallet(tx,scope); const row=await reservation(tx,wallet,operationId);
 const claims=(await tx.query('SELECT * FROM request_budget_claims WHERE operation_id=$1 ORDER BY request_id',[operationId])).rows;
 return {...row,claims};
}
/** Reduce an open authorization without releasing funds needed by active claims. */
export async function reduceReservation(tx:Tx,scope:Scope,clock:Clock,input:Command&{operation_id:string;new_max_units:string}) {
 return command(tx,scope,clock,'reduce_reservation',input,async wallet=>{
  const row=await reservation(tx,wallet,input.operation_id);if(row.status!=='open')fail('budget_conflict');
  const max=units(input.new_max_units);if(max>BigInt(row.max_units))fail('budget_conflict','Use amend for increases');
  const open=(await tx.query("SELECT COALESCE(sum(max_units),0)::text amount FROM request_budget_claims WHERE operation_id=$1 AND status='open'",[input.operation_id])).rows[0];
  if(max<BigInt(row.captured_units)+BigInt(open.amount))fail('budget_conflict','Maximum below captures and active claims');
  let remaining=BigInt(row.max_units)-max;const released=remaining;const postings:Posting[]=[];
  const allocations=(await tx.query('SELECT a.*,l.expires_at FROM reservation_allocations a JOIN credit_lots l ON l.id=a.lot_id WHERE operation_id=$1 ORDER BY l.expires_at DESC NULLS FIRST,l.created_at DESC,l.id DESC',[input.operation_id])).rows;
  for(const part of allocations){const available=BigInt(part.reserved_units)-BigInt(part.captured_units)-BigInt(part.released_units);const take=available<remaining?available:remaining;if(take===0n)continue;remaining-=take;postings.push(...transfer(part.lot_id,'reserved',expired(part,clock)?'expired':'available',take));await tx.query('UPDATE reservation_allocations SET reserved_units=reserved_units-$3::bigint WHERE operation_id=$1 AND lot_id=$2',[input.operation_id,part.lot_id,take.toString()]);}
  if(remaining!==0n)throw new Error('Reservation reduction allocation invariant');
  if(released>0n)await journal(tx,scope,clock,wallet,'release',`reduce:${input.operation_id}:${input.idempotency_key}`,postings,input,{operation_id:input.operation_id,new_max_units:max.toString()});
  await tx.query('UPDATE reservations SET max_units=$2 WHERE operation_id=$1',[input.operation_id,max.toString()]);
  return {operation_id:input.operation_id,max_units:max.toString(),released_units:released.toString(),wallet:await snapshot(tx,wallet)};
 });
}

/** Expired reconciliation deadlines require operator action; this never releases held funds. */
export async function reconcileRevocationHolds(tx:Tx,clock:Clock,scope?:Scope):Promise<number> {
 if(!scope){const accounts=(await tx.query("SELECT DISTINCT w.organization_id,w.application_id,w.account_id FROM grant_revocations r JOIN wallets w ON w.id=r.wallet_id WHERE r.status='prepared' AND r.reconcile_after<=$1",[clock.now()])).rows;return forAvailableExecutionAccounts(tx,accounts,s=>reconcileRevocationHolds(tx,clock,s));}await lockExecutionAccount(tx,scope);
 const candidates=(await tx.query("SELECT r.id,w.organization_id,w.application_id,w.account_id FROM grant_revocations r JOIN wallets w ON w.id=r.wallet_id WHERE r.status='prepared' AND r.reconcile_after<=$1 AND ($2::text IS NULL OR (w.organization_id=$2 AND w.application_id=$3 AND w.account_id=$4)) ORDER BY w.account_id,r.id",[clock.now(),scope?.organization_id??null,scope?.application_id??null,scope?.account_id??null])).rows;
 let opened=0;
 for(const candidate of candidates){
  const scoped:Scope={organization_id:candidate.organization_id,application_id:candidate.application_id,account_id:candidate.account_id};await ensureWallet(tx,scoped);
  const row=(await tx.query("SELECT * FROM grant_revocations WHERE id=$1 AND status='prepared' AND reconcile_after<=$2 FOR UPDATE",[candidate.id,clock.now()])).rows[0];if(!row)continue;
  const inserted=(await tx.query("INSERT INTO revocation_incidents(id,organization_id,application_id,account_id,wallet_id,revocation_id,amount_units,reconcile_after,opened_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(revocation_id) DO NOTHING RETURNING *",[id('revocation_incident'),scoped.organization_id,scoped.application_id,scoped.account_id,row.wallet_id,row.id,row.amount_units,row.reconcile_after,clock.now()])).rows[0];
  if(inserted){opened++;await emit(tx,scoped,'revocation.reconciliation_required',{type:'revocation_incident',id:inserted.id},{revocation_id:row.id,wallet_id:row.wallet_id,amount_units:row.amount_units,reconcile_after:new Date(row.reconcile_after).toISOString(),status:'open'});}
 }
 return opened;
}
export async function listRevocationIncidents(tx:Tx,scope:Pick<Scope,'organization_id'|'application_id'>&{account_id?:string}) {
 return (await tx.query('SELECT * FROM revocation_incidents WHERE organization_id=$1 AND application_id=$2 AND ($3::text IS NULL OR account_id=$3) ORDER BY opened_at DESC,id LIMIT 100',[scope.organization_id,scope.application_id,scope.account_id??null])).rows;
}
