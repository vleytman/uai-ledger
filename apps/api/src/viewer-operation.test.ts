import {expect,test} from 'vitest';
import {viewerRequest,viewerAttempt,viewerCost} from './viewer-operation.js';
test('viewer operation details retain status and money without customer/provider content',()=>{
 const sensitive={input_ref:'input',parameters:{prompt:'private'},response_schema:{description:'private'},native_validation:{parameters:{prompt:'private'}},raw_response:'private',future_private_field:'private'};
 expect(viewerRequest({id:'request',execution_status:'succeeded',charged_units:'1',...sensitive})).toEqual({id:'request',execution_status:'succeeded',charged_units:'1'});
 expect(viewerAttempt({id:'attempt',state:'succeeded',variant:{model:'model',connection_id:'connection',parameters:{prompt:'private'}},...sensitive})).toEqual({id:'attempt',state:'succeeded',variant:{model:'model',connection_id:'connection'}});
 expect(viewerCost({id:'cost',currency:'USD',cost_units:'1',...sensitive})).toEqual({id:'cost',currency:'USD',cost_units:'1'});
});
