import {expect,it} from 'vitest';
import {unitsToUsd,usdToUnits,updateProperty,durationToUnits} from '../../../packages/admin-module/src/components/form-values';
it('round trips budget units beyond Number precision without rounding',()=>{
 for(const units of ['0','1','1000000000','1200000001','999999999999999999999999999999'])expect(usdToUnits(unitsToUsd(units))).toBe(units);
 expect(usdToUnits('.000000001')).toBe('1');
 for(const invalid of ['','-1','1e9','Infinity','0.0000000001'])expect(()=>usdToUnits(invalid)).toThrow();
});
it('preserves unknown nested data and removes only an explicitly cleared property',()=>{
 const before={organization_id:'org',custom:{keep:['a',1]},project_id:'old'};
 const next=updateProperty(before,'project_id',undefined);
 expect(next).toEqual({organization_id:'org',custom:{keep:['a',1]}});
 expect(before.project_id).toBe('old');
 expect(Object.hasOwn(updateProperty({},'__proto__','safe'),'__proto__')).toBe(true);
});

it('converts fractional durations without binary rounding or silent truncation',()=>{expect(durationToUnits('1.001',1000)).toBe(1001);expect(durationToUnits('0.5',60)).toBe(30);expect(()=>durationToUnits('0.001',1)).toThrow()});
