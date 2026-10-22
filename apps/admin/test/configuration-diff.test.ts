import {expect,it} from 'vitest';
import {configurationChanges} from '../../../packages/admin-module/src/components/configuration-diff';
it('matches models by ID and preserves exact monetary strings when reordered',()=>{
 const before={models:[{id:'text',pricing:{markup_percent:'12.3456789'}},{id:'image',pricing:{markup_percent:'0'}}]};
 const after={models:[{id:'image',pricing:{markup_percent:'0'}},{id:'text',pricing:{markup_percent:'20'}}]};
 expect(configurationChanges(before,after)).toEqual([{path:'Configuration / models / text / pricing / markup_percent',before:'12.3456789',after:'20'}]);
});
it('shows added and removed components including their complete values',()=>{
 const component={key:'refs',maximum:'16384',result:{kind:'quantity',unit:'tokens'}};
 expect(configurationChanges({components:[]},{components:[component]})).toEqual([{path:'Configuration / components / refs',before:undefined,after:component}]);
 expect(configurationChanges({components:[component]},{components:[]})).toEqual([{path:'Configuration / components / refs',before:component,after:undefined}]);
});
