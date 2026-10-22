// @vitest-environment jsdom
import {createElement} from 'react';
import {afterEach, expect, it} from 'vitest';
import {cleanup, fireEvent, render, screen, within} from '@testing-library/react';
import {DataTable} from '../../../packages/admin-module/src/components/data-table';
afterEach(cleanup);
const data=Array.from({length:31},(_,index)=>({id:`record-${index}`,amount:String(31-index),status:index%2?'failed':'completed',created_at:'2026-09-19T00:00:00Z'}));
const columns=[{title:'ID',key:'id'},{title:'Amount',key:'amount'},{title:'Status',key:'status'}];
it('sorts the whole result before pagination and resets pages when filtering',()=>{
 render(createElement(DataTable,{data,columns}));
 fireEvent.change(screen.getByRole('combobox',{name:'Rows per page'}),{target:{value:'10'}});
 fireEvent.click(screen.getByRole('button',{name:'Amount'}));
 expect(within(screen.getAllByRole('row')[1]).getAllByRole('cell')[1].textContent).toBe('1');
 fireEvent.click(screen.getByRole('button',{name:'Next'}));
 expect(within(screen.getAllByRole('row')[1]).getAllByRole('cell')[1].textContent).toBe('11');
 fireEvent.change(screen.getByRole('combobox',{name:'Filter by status'}),{target:{value:'failed'}});
 expect(screen.getByRole('button',{name:'Previous'}).hasAttribute('disabled')).toBe(true);
 expect(screen.getAllByRole('row')).toHaveLength(11);
 expect(within(screen.getAllByRole('row')[1]).getAllByRole('cell')[1].textContent).toBe('2');
});
it('keeps a visible column and lets date filters recover from empty results',()=>{
 render(createElement(DataTable,{data,columns}));
 fireEvent.click(screen.getByText('Columns'));
 fireEvent.click(screen.getByRole('checkbox',{name:'Amount'}));
 fireEvent.click(screen.getByRole('checkbox',{name:'Status'}));
 expect(screen.getByRole('checkbox',{name:'ID'}).hasAttribute('disabled')).toBe(true);
 fireEvent.change(screen.getByLabelText('Created from'),{target:{value:'2026-09-20'}});
 expect(screen.getByText('No records match these filters.')).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Clear filters'}));
 expect(screen.getAllByRole('row')).toHaveLength(26);
});
it('keeps provider groups together across sorting and pagination, including refreshed providers',()=>{
 const groupBy=(row:any)=>row.status==='completed'?'OpenAI':'Cartesia';
 const result=render(createElement(DataTable,{data,columns,groupBy:()=> 'Unknown provider'}));
 result.rerender(createElement(DataTable,{data,columns,groupBy}));
 fireEvent.change(screen.getByRole('combobox',{name:'Rows per page'}),{target:{value:'10'}});
 fireEvent.click(screen.getByRole('button',{name:'Amount'}));
 expect(screen.getByText('Cartesia')).toBeTruthy();
 expect(screen.queryByText('OpenAI')).toBeNull();
 expect(within(screen.getAllByRole('row')[2]).getAllByRole('cell')[1].textContent).toBe('2');
 fireEvent.click(screen.getByRole('button',{name:'Next'}));
 expect(screen.getByText('Cartesia')).toBeTruthy();
 expect(screen.getByText('OpenAI')).toBeTruthy();
 expect(screen.queryByText('Unknown provider')).toBeNull();
});
