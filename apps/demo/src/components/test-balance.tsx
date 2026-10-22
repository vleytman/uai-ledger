import {useRef,useState} from 'react';
import {Button} from '@uai/ui/components/button';
import {Input} from '@uai/ui/components/input';
import {Equal} from 'lucide-react';

export function TestBalance({wallet,enabled,onUpdated}:{wallet:{revision:number;reserved_units:string};enabled:boolean;onUpdated:()=>Promise<void>}){
 const [amount,setAmount]=useState('0'),[pending,setPending]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState('');
 const attempt=useRef<{action:string;amount_credits:string;expected_revision:number;key:string}|null>(null);
 const reserved=BigInt(wallet.reserved_units)>0n;
 return <form className="demo-credit-form" onSubmit={async event=>{
  event.preventDefault();setPending(true);setError('');setMessage('');
  attempt.current??={action:'set_balance',amount_credits:amount.replace(',','.'),expected_revision:wallet.revision,key:crypto.randomUUID()};
  try{
   const response=await fetch('/api',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(attempt.current)}),result=await response.json();
   if(!response.ok){if(response.status<500)attempt.current=null;throw new Error(result.error??'Не удалось установить остаток.');}
   attempt.current=null;await onUpdated();setMessage(`Доступный остаток установлен: ${amount} кр.`);
  }catch(e){setError((e as Error).message)}finally{setPending(false)}
 }}>
  <div className="demo-credit-input"><Equal aria-hidden="true"/><Input id="test-balance" aria-label="Установить доступный остаток" inputMode="decimal" required pattern="[0-9]+([.,][0-9]{1,6})?" value={amount} disabled={pending||!enabled} onChange={e=>{setAmount(e.target.value);attempt.current=null;setMessage('');setError('')}}/></div>
  <Button size="sm" variant="outline" type="submit" disabled={pending||!enabled||reserved} title={reserved?'Сначала завершите или отмените операции с резервом':undefined}>{pending?'Устанавливаем…':'Установить остаток'}</Button>
  {error&&<p role="alert" className="demo-credit-error text-sm text-destructive">{error}</p>}
  {message&&<p role="status" className="sr-only">{message}</p>}
 </form>;
}
