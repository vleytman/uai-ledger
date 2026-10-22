import {it,expect} from 'vitest';
import {apiLimitUsage} from '../src/api-limit-usage.js';
import {validLimitUsage} from '../src/limit-usage.js';
import {quotaDemands} from '../../queue/src/quota-demands.js';
it('reserves conservative API rate counters without conflating native credits with money',()=>{
 const usage=apiLimitUsage({credits:'2.1',pages:'3',files:'2',bytes:'600'});expect(usage).toEqual({requests:1,credits:3,pages:3,files:2,bytes:600});
 expect(validLimitUsage({...usage,output:'private response',apiKey:'secret'})).toEqual(usage);
 expect(quotaDemands([{key:'credits-minute',metric:'credits',capacity:'20',window_ms:60000}],usage)[0].amount).toBe(3);
 expect(()=>apiLimitUsage({credits:'9007199254740992'})).toThrow('quota_metric_out_of_range');
 expect(()=>quotaDemands([{key:'missing',metric:'images',capacity:'20',window_ms:60000}],usage)).toThrow('quota_metric_estimate_missing');
});
it('derives total-token quota demand while respecting explicit totals and integer bounds',()=>{
 expect(apiLimitUsage({input_tokens:'32768'})).toEqual({requests:1,input_tokens:32768,tokens:32768});
 expect(apiLimitUsage({input_tokens:'1.1',output_tokens:'2.1'})).toEqual({requests:1,input_tokens:2,output_tokens:3,tokens:5});
 expect(apiLimitUsage({input_tokens:'10',output_tokens:'20',tokens:'40'}).tokens).toBe(40);
 expect(()=>apiLimitUsage({input_tokens:'9007199254740991',output_tokens:'1'})).toThrow('quota_metric_out_of_range');
});
