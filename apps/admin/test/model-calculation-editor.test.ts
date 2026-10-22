// @vitest-environment jsdom
import {createElement,useState} from 'react';
import {afterEach,expect,it,vi} from 'vitest';
import {render,screen,fireEvent,cleanup,within} from '@testing-library/react';
import {StructuredEditor} from '../../../packages/admin-module/src/components/structured-editor';
import {editorSchemas} from '../../../packages/admin-module/src/components/editor-schema';
import {newModelCalculation,newCostComponent} from '../../../packages/admin-module/src/components/model-calculation-editor';
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals()});
function Editor({readOnly=false}:{readOnly?:boolean}){const policy=newModelCalculation();policy.source='Synthetic UI test';policy.parameters={size:{type:'string',values:['1K','2K'],default:'1K'},quality:{type:'string',values:['low','high'],default:'low'}};policy.components=[newCostComponent('tokens',1)];const [value,setValue]=useState(JSON.stringify({models:[{id:'model',provider:'fake',status:'active',capabilities:['image.generate'],allowed_parameters:['size','quality'],rate_card_version_id:'card',calculation:policy}]}));return createElement('form',{},createElement(StructuredEditor,{value,onChange:setValue,schema:editorSchemas.models,readOnly}),createElement('output',{'data-testid':'value'},value));}
const model=()=>JSON.parse(screen.getByTestId('value').textContent!).models[0];
it('edits registered tokenization and complete expression tables without JSON',()=>{
 render(createElement(Editor));
 fireEvent.change(screen.getByLabelText('Calculation type'),{target:{value:'formula'}});
 fireEvent.change(screen.getByLabelText('Operation'),{target:{value:'tokenize'}});
 fireEvent.change(screen.getByLabelText('Tokenizer'),{target:{value:'cl100k_base'}});
 expect(model().calculation.components[0].expression).toEqual({op:'tokenize',tokenizer:'cl100k_base',input_mode:'prompt'});
 fireEvent.change(screen.getByLabelText('Operation'),{target:{value:'lookup'}});
 fireEvent.click(screen.getByLabelText('size',{selector:'input'}));fireEvent.click(screen.getByLabelText('quality',{selector:'input'}));
 fireEvent.click(screen.getByRole('button',{name:'Fill expression table'}));
 fireEvent.change(screen.getByLabelText('Expression table value 2K high'),{target:{value:'0.123456789'}});
 const table=model().calculation.components[0].expression;expect(table.rows).toHaveLength(4);expect(table.rows[3]).toEqual({parameters:{size:'2K',quality:'high'},value:'0.123456789'});
 fireEvent.change(screen.getByLabelText('Operation'),{target:{value:'tokenize'}});
 expect(screen.getByLabelText('Tokenizer')).toHaveProperty('value','cl100k_base');
});
it('retains decimal model factors and type-specific draft values while switching all four types',()=>{
 render(createElement(Editor));fireEvent.change(screen.getByLabelText('Safety factor'),{target:{value:'1.075'}});fireEvent.change(screen.getByLabelText('Markup, %'),{target:{value:'22.125'}});fireEvent.change(screen.getByLabelText('Request overhead, tokens'),{target:{value:'6'}});
 fireEvent.change(screen.getByLabelText('Calculation type'),{target:{value:'per_unit'}});fireEvent.change(screen.getByLabelText('Quantity'),{target:{value:'7'}});
 fireEvent.change(screen.getByLabelText('Calculation type'),{target:{value:'formula'}});fireEvent.change(screen.getByLabelText('Constant'),{target:{value:'1024'}});
 fireEvent.change(screen.getByLabelText('Calculation type'),{target:{value:'lookup'}});expect(screen.queryByLabelText('Operation')).toBeNull();
 fireEvent.change(screen.getByLabelText('Calculation type'),{target:{value:'per_unit'}});expect((screen.getByLabelText('Quantity') as HTMLInputElement).value).toBe('7');
 fireEvent.change(screen.getByLabelText('Calculation type'),{target:{value:'tokens'}});expect((screen.getByLabelText('Request overhead, tokens') as HTMLInputElement).value).toBe('6');
 fireEvent.change(screen.getByLabelText('Calculation type'),{target:{value:'formula'}});expect((screen.getByLabelText('Constant') as HTMLInputElement).value).toBe('1024');
 expect(model().calculation.pricing).toEqual({safety_factor:'1.075',markup_percent:'22.125',rounding_units:'1'});
});
it('fills price combinations from selected parameter enums and preserves entered prices on refill',()=>{
 render(createElement(Editor));fireEvent.change(screen.getByLabelText('Calculation type'),{target:{value:'lookup'}});
 const tableSelection=screen.getByText('Table selection').closest('fieldset')!;
 fireEvent.click(within(tableSelection).getByLabelText('size'));fireEvent.click(within(tableSelection).getByLabelText('quality'));fireEvent.click(screen.getByRole('button',{name:'Fill all parameter combinations'}));
 expect(model().calculation.components[0].rows).toHaveLength(4);fireEvent.change(screen.getByLabelText('Table value 1K low'),{target:{value:'0.0123456789'}});fireEvent.click(screen.getByRole('button',{name:'Fill all parameter combinations'}));
 expect(model().calculation.components[0].rows[0].value).toBe('0.0123456789');expect(screen.queryByLabelText('Operation')).toBeNull();
});
it('previews unsaved per-model factors without saving or sending a provider request',async()=>{
 const fetchMock=vi.fn(async()=>({ok:true,json:async()=>({components:[],provider_estimate_usd:'0.01',price_units:'15000000',pricing:{safety_factor:'1.2',markup_percent:'25'},verification:'approximate'})}));vi.stubGlobal('fetch',fetchMock);
 render(createElement(Editor));fireEvent.change(screen.getByLabelText('Safety factor'),{target:{value:'1.2'}});fireEvent.change(screen.getByLabelText('Markup, %'),{target:{value:'25'}});
 fireEvent.click(screen.getByText('Preview price'));fireEvent.click(screen.getByRole('button',{name:'Calculate price'}));await vi.waitFor(()=>expect(screen.getByText('Final price: 15 credits')).toBeTruthy());
 expect(fetchMock).toHaveBeenCalledTimes(1);const call=fetchMock.mock.calls[0] as unknown as [string,RequestInit];const body=JSON.parse(call[1].body as string);expect(body.action).toBe('model_preview');expect(body.data.calculation.pricing).toEqual({safety_factor:'1.2',markup_percent:'25',rounding_units:'1'});expect(body.data.rate_card_version_id).toBe('card');
});

it('keeps the calculator usable when published model settings are read-only',async()=>{
 const fetchMock=vi.fn(async()=>({ok:true,json:async()=>({components:[],provider_estimate_usd:'0.01',price_units:'10000000',pricing:{safety_factor:'1',markup_percent:'0'},verification:'approximate'})}));vi.stubGlobal('fetch',fetchMock);
 render(createElement(Editor,{readOnly:true}));const before=screen.getByTestId('value').textContent;
 expect((screen.getByLabelText('Safety factor') as HTMLInputElement).matches(':disabled')).toBe(true);
 fireEvent.click(screen.getByText('Preview price'));const button=screen.getByRole('button',{name:'Calculate price'});
 expect(button.matches(':disabled')).toBe(false);expect(screen.queryByRole('button',{name:'Remove cost calculation'})).toBeNull();fireEvent.click(button);
 await vi.waitFor(()=>expect(screen.getByText('Final price: 10 credits')).toBeTruthy());
 expect(screen.getByTestId('value').textContent).toBe(before);expect(fetchMock).toHaveBeenCalledTimes(1);
});
