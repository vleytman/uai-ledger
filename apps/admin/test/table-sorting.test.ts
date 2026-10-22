import {describe, expect, it} from 'vitest';
import {compareTableValues} from '../../../packages/admin-module/src/components/table-sorting';
describe('admin table sorting', () => {
  it('orders monetary strings numerically rather than lexically', () => {
    expect(['100', '2', '10', '0'].sort(compareTableValues)).toEqual(['0', '2', '10', '100']);
  });
  it('preserves precision beyond safe integer range', () => {
    expect(compareTableValues('9007199254740993', '9007199254740992')).toBe(1);
    expect(compareTableValues('9007199254740993.000001', '9007199254740993.000002')).toBe(-1);
  });
  it('handles negative corrections and decimal scales', () => {
    expect(['0', '-2.1', '-10', '1.20', '1.02'].sort(compareTableValues)).toEqual(['-10', '-2.1', '0', '1.02', '1.20']);
    expect(compareTableValues('1.20', '1.2')).toBe(0);
  });
  it('orders identifiers naturally and compares timestamp numbers', () => {
    expect(['op_10', 'op_2', 'op_1'].sort(compareTableValues)).toEqual(['op_1', 'op_2', 'op_10']);
    expect(compareTableValues(Date.parse('2026-01-01'), Date.parse('2025-12-31'))).toBe(1);
  });
});
