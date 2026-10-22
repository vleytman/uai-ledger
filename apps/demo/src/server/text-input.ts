import {TextInput} from '../../../../packages/contracts/invocation';
import type {DemoComponent} from '../profile-settings';
import type {TextOptionsValue} from '../text-options';
export function demoTextInput(component:DemoComponent,prompt:string,assetIds:string[],options:TextOptionsValue){
 const features=component.model_settings?.text_features;
 if(!['text','schema','tool'].includes(options.mode)||options.mode==='schema'&&!features?.schema||options.mode==='tool'&&!features?.tools||options.stream&&(options.mode==='schema'&&features?.schema_streaming===false||options.mode==='tool'&&features?.tool_streaming===false))throw new Error('Профиль не поддерживает выбранное сочетание.');
 if(assetIds.length&&(!features?.image_media_types.length||assetIds.length>(features.max_images??0)))throw new Error('Профиль не поддерживает эти изображения.');
 const history=options.history.trim()?JSON.parse(options.history):[];if(!Array.isArray(history)||history.length&&!features?.tool_history)throw new Error('История инструментов недоступна.');
 const definition=options.mode==='text'?undefined:JSON.parse(options.definition);
 return TextInput.parse({messages:[...history,{role:'user',content:[{type:'text',text:prompt},...assetIds.map(asset_id=>({type:'image',asset_id}))]}],...(options.mode==='schema'?{response_schema:definition}:options.mode==='tool'?{tools:Array.isArray(definition)?definition:[{name:'answer',description:'Return the answer',parameters:definition}],tool_choice:{type:'required'}}:{})});
}
