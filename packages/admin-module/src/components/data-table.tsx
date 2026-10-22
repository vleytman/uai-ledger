import {Fragment,useRef,useEffect, useMemo, useState, type ReactNode} from 'react';
import {flexRender, getCoreRowModel, getSortedRowModel, getPaginationRowModel, useReactTable, type ColumnDef, type CellContext, type SortingState} from '@tanstack/react-table';
import {ArrowDown, ArrowUp, ArrowUpDown, Copy} from 'lucide-react';
import {compareTableValues} from './table-sorting';
import {Input} from '@uai/ui/components/input';
import {Table, TableHeader, TableBody, TableRow, TableHead, TableCell} from '@uai/ui/components/table';

interface Column {title: string; width?:number; key?: string; render?: (row: any) => ReactNode; money?: boolean; sortValue?: (row: any) => unknown}
function renderCell(context: CellContext<any, unknown>) {
  const column = context.column.columnDef.meta as Column;
  return column.render ? column.render(context.row.original) : String(context.getValue() ?? '—');
}
export function DataTable({data, columns, search, onSearch, minWidth, layout, groupBy, label, compact=false, empty = 'Records will appear here when available.'}: {data: any[]; columns: Column[]; label?:string; compact?:boolean; layout?:'content'; groupBy?:(row:any)=>string; minWidth?: number; search?:string; onSearch?:(value:string)=>void; empty?: string}) {
  const groupByRef=useRef(groupBy);groupByRef.current=groupBy;
  const [copyNotice, setCopyNotice] = useState('');
  const [status, setStatus] = useState('');
  const [since, setSince] = useState('');
  const [visibility, setVisibility] = useState({});
  const [pagination, setPagination] = useState({pageIndex: 0, pageSize: 25});
  const statuses = [...new Set(data.map(row => row.status ?? row.execution_status ?? row.state).filter(value => typeof value === 'string'))].sort();
  const hasDates = data.some(row => row.created_at);
  const visibleData = useMemo(() => data.filter(row => (!status || (row.status ?? row.execution_status ?? row.state) === status) && (!since || (row.created_at && new Date(row.created_at).getTime() >= new Date(`${since}T00:00:00`).getTime()))), [data, status, since]);
  useEffect(() => setPagination(current => ({...current, pageIndex: 0})), [data, status, since]);
  const [sorting, setSorting] = useState<SortingState>([]);
  const definitions = useMemo<ColumnDef<any>[]>(() => columns.map((column, index) => ({
    id: String(index),
    header: column.title,
    accessorFn: row => (column.sortValue ? column.sortValue(row) : column.key ? row[column.key] : undefined) ?? undefined,
    enableSorting: !!(column.sortValue || column.key),
    sortingFn: (a, b, id) => compareTableValues(a.getValue(id), b.getValue(id)),
    sortUndefined: 'last',
    sortDescFirst: false,
    cell: renderCell,
    meta: column,
  })), [columns]);
  const table = useReactTable({data: visibleData, columns: definitions, getCoreRowModel: getCoreRowModel(), getSortedRowModel: table => {const sorted=getSortedRowModel<any>()(table);return ()=>{const model=sorted();const groupBy=groupByRef.current;if(!groupBy)return model;const ordered=[...model.rows].sort((a,b)=>groupBy(a.original).localeCompare(groupBy(b.original)));return {...model,rows:ordered,flatRows:ordered};};}, getPaginationRowModel: getPaginationRowModel(), manualPagination:compact, state: {sorting, pagination, columnVisibility: visibility}, onPaginationChange: setPagination, onColumnVisibilityChange: setVisibility, onSortingChange: setSorting, getRowId: (row, index) => String(row.id ?? index), autoResetAll: false});
  return <div className={`admin-data-table${layout==='content'?' admin-table-content':''}`}>{!compact&&<div className="admin-table-tools">
      <div className="admin-table-filters">{onSearch&&<Input aria-label="Search records" placeholder="Search…" value={search??''} onChange={e=>onSearch(e.target.value)}/>}{statuses.length > 1 && <select aria-label="Filter by status" value={status} onChange={event => setStatus(event.target.value)}><option value="">All statuses</option>{statuses.map(value => <option key={value} value={value}>{value.replaceAll('_', ' ').replace(/^./, letter => letter.toUpperCase())}</option>)}</select>}{hasDates && <label>From <input aria-label="Created from" type="date" value={since} onChange={event => setSince(event.target.value)}/></label>}{(status || since) && <button type="button" onClick={() => {setStatus(''); setSince('')}}>Clear filters</button>}</div>
      <details className="admin-column-picker"><summary>Columns</summary><div>{table.getAllLeafColumns().map((column, index) => <label key={column.id}><input type="checkbox" checked={column.getIsVisible()} disabled={column.getIsVisible() && table.getVisibleLeafColumns().length === 1} onChange={column.getToggleVisibilityHandler()}/>{columns[index].title}</label>)}</div></details>
    </div>}<div className="admin-table-region" role="region" aria-label="Data table — use arrow keys to scroll" tabIndex={0}>
    <Table aria-label={label} style={{minWidth: Math.max(minWidth??520, 240 + (table.getVisibleLeafColumns().length - 1) * 140)}}><colgroup>{table.getVisibleLeafColumns().map(column => <col key={column.id} style={{width: columns[Number(column.id)].width ? `${columns[Number(column.id)].width}px` : Number(column.id) === 0 ? undefined : columns[Number(column.id)].title === 'Actions' ? '130px' : '150px'}}/>)}</colgroup><TableHeader>{table.getHeaderGroups().map(group => <TableRow key={group.id}>{group.headers.map(header => <TableHead aria-sort={header.column.getCanSort() ? (header.column.getIsSorted() === 'asc' ? 'ascending' : header.column.getIsSorted() === 'desc' ? 'descending' : 'none') : undefined} key={header.id} className={columns[Number(header.column.id)].money ? 'uai-money' : undefined}>{header.isPlaceholder ? null : header.column.getCanSort() ? <button type="button" className="admin-sort-button" onClick={header.column.getToggleSortingHandler()}>{flexRender(header.column.columnDef.header, header.getContext())}{header.column.getIsSorted() === 'asc' ? <ArrowUp aria-hidden="true"/> : header.column.getIsSorted() === 'desc' ? <ArrowDown aria-hidden="true"/> : <ArrowUpDown aria-hidden="true"/>}</button> : flexRender(header.column.columnDef.header, header.getContext())}</TableHead>)}</TableRow>)}</TableHeader>
      <TableBody>{!visibleData.length && <TableRow><TableCell colSpan={table.getVisibleLeafColumns().length}><div className="admin-empty">{search||status||since?'No records match these filters.':empty}</div></TableCell></TableRow>}{table.getRowModel().rows.map((row,index, pageRows) => <Fragment key={row.id}>{groupBy && (index===0 || groupBy(row.original)!==groupBy(pageRows[index-1].original)) && <TableRow className="admin-provider-group"><TableCell colSpan={table.getVisibleLeafColumns().length}>{groupBy(row.original)}</TableCell></TableRow>}<TableRow fluidIndex={index}>{row.getVisibleCells().map(cell => <TableCell key={cell.id} className={columns[Number(cell.column.id)].money ? 'uai-money' : undefined}><div className={cell.column.id === '0' ? 'admin-primary-cell' : undefined}><div>{flexRender(cell.column.columnDef.cell, cell.getContext())}</div>{cell.column.id === '0' && row.original.id && <button type="button" className="admin-copy-id" aria-label={`Copy ID ${row.original.id}`} title="Copy full ID" onClick={async () => {try {await navigator.clipboard.writeText(String(row.original.id)); setCopyNotice('ID copied');} catch {setCopyNotice('Unable to copy ID. Select the full ID from its tooltip.');}}}><Copy size={13}/></button>}</div></TableCell>)}</TableRow></Fragment>)}</TableBody>
    </Table>
  </div><span className="sr-only" role="status">{copyNotice}</span>{!compact&&<footer className="admin-table-footer"><span>{visibleData.length ? pagination.pageIndex * pagination.pageSize + 1 : 0}–{Math.min((pagination.pageIndex + 1) * pagination.pageSize, visibleData.length)} of {visibleData.length} records</span><div><label>Rows per page <select aria-label="Rows per page" value={pagination.pageSize} onChange={event => table.setPageSize(Number(event.target.value))}>{[10,25,50,100].map(size => <option key={size} value={size}>{size}</option>)}</select></label><span className={table.getPageCount()>1?'admin-pagination':'sr-only'}><button type="button" disabled={!table.getCanPreviousPage()} onClick={() => table.previousPage()}>Previous</button><button type="button" disabled={!table.getCanNextPage()} onClick={() => table.nextPage()}>Next</button></span></div></footer>}</div>;
}
