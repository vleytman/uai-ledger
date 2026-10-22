import {useId,useState} from 'react';
import {Button} from '@uai/ui/components/button';
import {Input} from '@uai/ui/components/input';
export interface DemoReference {id:string;name:string}
export function References({max,value,onChange,onBusyChange}:{max:number;value:DemoReference[];onChange:(v:DemoReference[])=>void;onBusyChange:(busy:boolean)=>void}){
 const id=useId(),[busy,setBusy]=useState(false),[error,setError]=useState('');
 async function add(files:File[]){setBusy(true);onBusyChange(true);setError('');const added:DemoReference[]=[];try{
  if(value.length+files.length>max)throw new Error(`Можно добавить до ${max} референсов.`);
  for(const file of files){if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>10000000)throw new Error('Нужны PNG, JPEG или WebP до 10 МБ.');
   const data=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(new Error('Не удалось прочитать файл.'));reader.readAsDataURL(file)});
   const response=await fetch('/api',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'upload_reference',media_type:file.type,base64:data,key:crypto.randomUUID()})});const result=await response.json();if(!response.ok)throw new Error(result.error??'Не удалось загрузить референс.');added.push({id:result.id,name:file.name});
  }
 }catch(e){setError((e as Error).message)}finally{if(added.length)onChange([...value,...added]);setBusy(false);onBusyChange(false)}}
 return <div className="space-y-2"><label htmlFor={id}>Референсы · {value.length} / {max}</label><Input id={id} type="file" multiple accept="image/png,image/jpeg,image/webp" disabled={busy||value.length>=max} onChange={e=>{const files=Array.from(e.target.files??[]);e.target.value='';void add(files)}}/>{busy&&<p role="status">Загружаем референсы…</p>}{error&&<p role="alert">{error}</p>}<ul>{value.map(file=><li key={file.id} className="flex items-center justify-between gap-2 text-sm"><span className="truncate">{file.name}</span><Button type="button" variant="ghost" size="sm" disabled={busy} onClick={()=>onChange(value.filter(r=>r.id!==file.id))}>Убрать</Button></li>)}</ul></div>;
}
