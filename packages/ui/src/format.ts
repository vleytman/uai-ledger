export function credits(value:string|null|undefined,locale:'ru-RU'|'en-US'='ru-RU'):string {
 const english=locale==='en-US';
 if(value==null) return english?'Unknown':'Неизвестно';
 if(!/^-?\d+$/.test(value)) return english?'Unavailable':'Недоступно';
 const n=BigInt(value),abs=n<0n?-n:n;
 const whole=(abs/1000000n).toString().replace(/\B(?=(\d{3})+(?!\d))/g,english?',':'\u202f');
 const fraction=(abs%1000000n).toString().padStart(6,'0').replace(/0+$/,'');
 return `${n<0n?'-':''}${whole}${fraction?(english?'.':',')+fraction:''}`;
}
