import {it,expect} from 'vitest';
import {defaultTextOptions} from './text-options';
import {demoTextInput} from './server/text-input';
import {alternativeFeatures} from '../../../packages/providers/src/alternative-models';
const component:any={model_settings:{text_features:alternativeFeatures('groq','qwen/qwen3.8-27b')}};
it('builds vision and forced-tool inputs and rejects unsupported schema streaming',()=>{
 const i=demoTextInput(component,'blue',['image'],{...defaultTextOptions,mode:'tool'});expect(i.messages[0].content[1]).toEqual({type:'image',asset_id:'image'});expect(i.tool_choice).toEqual({type:'required'});expect(i.tools?.[0].name).toBe('answer');expect(()=>demoTextInput(component,'blue',[],{...defaultTextOptions,mode:'schema',stream:true})).toThrow();
});
it('does not silently attach unsupported images or accept malformed history',()=>{
 expect(()=>demoTextInput({model_settings:{text_features:alternativeFeatures('groq','openai/gpt-oss-20b')}} as any,'blue',['image'],defaultTextOptions)).toThrow();expect(()=>demoTextInput(component,'blue',[],{...defaultTextOptions,history:'{}'})).toThrow();
});
