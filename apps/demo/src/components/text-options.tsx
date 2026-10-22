import type {TextOptionsValue} from '../text-options';
import type {DemoComponent} from '../profile-settings';
export function TextOptions({component,value,onChange}:{component:DemoComponent;value:TextOptionsValue;onChange:(v:TextOptionsValue)=>void}){
 const features=component.model_settings?.text_features;
 if(!features)return null;
 return <details className="space-y-3"><summary>Структура ответа и инструменты</summary>
 <label className="block">Ответ <select aria-label="Формат ответа" value={value.mode} onChange={e=>onChange({...value,mode:e.target.value as TextOptionsValue['mode'],stream:false})}><option value="text">Текст</option>{features.schema&&<option value="schema">JSON по схеме</option>}{features.tools&&<option value="tool">Вызов инструмента</option>}</select></label>
 {value.mode!=='text'&&<label className="block">{value.mode==='tool'?'Описание инструментов, JSON':'Схема ответа, JSON'}<textarea aria-label="Схема или инструменты" className="min-h-32 w-full rounded-lg border p-3 font-mono text-sm" value={value.definition} onChange={e=>onChange({...value,definition:e.target.value})}/></label>}
 {(value.mode==='schema'?features.schema_streaming: value.mode==='tool'?features.tool_streaming:true)!==false&&<label className="flex gap-2"><input type="checkbox" checked={value.stream} onChange={e=>onChange({...value,stream:e.target.checked})}/>Поток ответа</label>}
 {features.tool_history&&<label className="block">История инструментов, JSON массива сообщений <textarea aria-label="История инструментов" className="min-h-24 w-full rounded-lg border p-3 font-mono text-sm" placeholder="[]" value={value.history} onChange={e=>onChange({...value,history:e.target.value})}/></label>}
 <p className="text-xs text-muted-foreground">Demo показывает вызов инструмента. Для продолжения добавьте вызов и его результат в историю.</p>
 </details>;
}
