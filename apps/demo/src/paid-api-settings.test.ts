import {it,expect} from 'vitest';
import {paidApiInput,paidApiScenarios} from './paid-api-settings';
it('keeps demo calls bounded and rejects unregistered operations',()=>{
 expect(paidApiInput('search',' patent ')).toEqual({query:'patent',limit:1,scrape:false});
 expect(paidApiInput('patent_search','quantum')).toEqual({query:'quantum',page_size:1,start:0});
 expect(paidApiInput('patent_document','11234567')).toEqual({number:'11234567',include_full_text:false});
 expect(()=>paidApiInput('crawl','x')).toThrow();expect(()=>paidApiInput('search','  ')).toThrow();
 for(const s of paidApiScenarios)expect(paidApiInput(s.operation,s.example)).toBeTruthy();
});
