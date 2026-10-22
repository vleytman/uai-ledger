import {DomainError} from '../../contracts/src/index.js';
import type {TariffTemplate} from '../../contracts/paid-api.js';
type Parts={year:number;month:number;day:number;hour:number;minute:number;second:number};
const formatters=new Map<string,Intl.DateTimeFormat>();
function formatter(zone:string){
 let fmt=formatters.get(zone);if(!fmt){try{fmt=new Intl.DateTimeFormat('en-GB',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});}catch{throw new DomainError('invalid_allowance_timezone',zone,422);}if(formatters.size>256)formatters.clear();formatters.set(zone,fmt);}return fmt;
}
function parts(date:Date,zone:string):Parts{return Object.fromEntries(formatter(zone).formatToParts(date).filter(p=>p.type!=='literal').map(p=>[p.type,Number(p.value)])) as Parts;}
const utc=(p:Parts)=>{const date=new Date(0);date.setUTCFullYear(p.year,p.month-1,p.day);date.setUTCHours(p.hour,p.minute,p.second,0);return date.getTime();};
/** Earlier instant for a repeated local time; shift forward by the gap for a skipped time. */
function instant(p:Parts,zone:string){
 const wall=utc(p),offsets=new Set<number>();for(const hours of [-48,-24,0,24,48]){const probe=wall+hours*3600000;offsets.add(utc(parts(new Date(probe),zone))-probe);}
 const candidates=[...offsets].map(offset=>wall-offset).sort((a,b)=>a-b);
 const exact=candidates.find(value=>utc(parts(new Date(value),zone))===wall);
 if(exact!==undefined)return new Date(exact);
 const next=candidates.filter(value=>utc(parts(new Date(value),zone))>wall).sort((a,b)=>utc(parts(new Date(a),zone))-utc(parts(new Date(b),zone)))[0];
 if(next===undefined)throw new DomainError('invalid_allowance_calendar');return new Date(next);
}
export function periodBoundary(calendar:TariffTemplate['calendar'],monthIndex:number):Date {
 const anchor=parts(new Date(calendar.anchor),calendar.timezone),year=Math.floor(monthIndex/12),month=monthIndex-year*12+1;
 const last=new Date(Date.UTC(year,month,0)).getUTCDate();
 return instant({year,month,day:calendar.kind==='calendar_month'?1:Math.min(anchor.day,last),hour:calendar.kind==='calendar_month'?0:anchor.hour,minute:calendar.kind==='calendar_month'?0:anchor.minute,second:calendar.kind==='calendar_month'?0:anchor.second},calendar.timezone);
}
export function allowancePeriod(calendar:TariffTemplate['calendar'],at:Date){
 if(!Number.isFinite(at.getTime())||!Number.isFinite(Date.parse(calendar.anchor)))throw new DomainError('invalid_allowance_calendar');
 const local=parts(at,calendar.timezone);let index=local.year*12+local.month-1;
 if(periodBoundary(calendar,index)>at)index--;
 return {index,start:periodBoundary(calendar,index),end:periodBoundary(calendar,index+1)};
}
