import {describe,it,expect} from 'vitest';
import {validateCatalog,type ModelDefinition} from '../src/index.js';
import {textCalculationExample,imageCalculationExample} from '../../model-pricing/src/examples.js';
function textModel():ModelDefinition{
 const calculation=textCalculationExample();
 return {id:'example',provider:'openai',capabilities:['text.generate'],status:'active',rate_card_version_id:'rate',allowed_parameters:Object.keys(calculation.parameters),calculation};
}
describe('calculated model publication and adapter compatibility',()=>{
 it('permits implemented provider fields and the enforced text output limit',()=>{
  const model=textModel();expect(()=>validateCatalog({models:[model]})).not.toThrow();
  model.calculation!.parameters.temperature={type:'number',minimum:0,maximum:2,default:1};model.allowed_parameters.push('temperature');
  expect(()=>validateCatalog({models:[model]})).not.toThrow();
 });
 it.each(['tools','tool_choice','web_search','invented_parameter'])('rejects unsupported %s before publication',parameter=>{
  const model=textModel();model.allowed_parameters.push(parameter);
  expect(()=>validateCatalog({models:[model]})).toThrow(/does not support parameter/);
 });
 it('rejects capabilities absent from the registered adapter',()=>{
  const model=textModel();model.provider='serper';expect(()=>validateCatalog({models:[model]})).toThrow(/does not support this capability/);
 });
 it('does not advertise multiple outputs when the image adapter always renders one',()=>{
  const calculation=imageCalculationExample('gpt-image-2-2026-04-21',['low','medium','high'],'30');
  const model:ModelDefinition={id:'example',provider:'openai',capabilities:['image.generate'],status:'active',rate_card_version_id:'rate',allowed_parameters:[...Object.keys(calculation.parameters),'count'],calculation};
  calculation.parameters.count={type:'number',minimum:1,maximum:2,default:1};
  expect(()=>validateCatalog({models:[model]})).toThrow(/does not support parameter count/);
  calculation.parameters.count.maximum=1;expect(()=>validateCatalog({models:[model]})).not.toThrow();
 });
});
