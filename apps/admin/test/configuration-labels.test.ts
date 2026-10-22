import {expect,it} from 'vitest';
import {configurationProvider,isTestConfiguration,currentConfigurationVersions} from '../../../packages/admin-module/src/components/configuration-labels';
it('hides fixtures and QA catalogs but keeps real demo models',()=>{
 expect(isTestConfiguration({key:'qa.model-pricing.admin'})).toBe(true);
 expect(isTestConfiguration({payload:{models:[{provider:'fake'}]}})).toBe(true);
 expect(isTestConfiguration({key:'central.model-pricing.examples',payload:{models:[{provider:'openai'}]}})).toBe(false);
 expect(isTestConfiguration({key:'fixture-pricing'})).toBe(true);
});
it('resolves every recipe component and fallback without guessing from names',()=>{
 const connections=[{id:'a',provider:'openai'},{id:'b',provider:'cartesia'}];
 const routes=[{id:'r',payload:{primary:{connection_id:'a'},fallback:{connection_id:'b'}}}];
 expect(configurationProvider(routes[0],'routes',connections,routes)).toBe('Multiple providers · Cartesia / OpenAI');
 expect(configurationProvider({definition:{components:[{route_version_id:'r'}]}},'recipes',connections,routes)).toBe('Multiple providers · Cartesia / OpenAI');
 expect(configurationProvider({definition:{components:[{route_version_id:'missing'}]}},'recipes',connections,routes)).toBe('Unknown provider');
});

it('keeps the active file snapshot visible next to a newer inactive release',()=>{
 const rows=[{key:'file',version:3,status:'published',file_active:false},{key:'file',version:2,status:'published',file_active:true},{key:'file',version:1,status:'published',file_active:false}];
 expect(currentConfigurationVersions(rows).map(r=>r.version)).toEqual([3,2]);
});
