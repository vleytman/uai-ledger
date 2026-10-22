import {useId, useState} from 'react';
import {createPortal} from 'react-dom';

export function ModelListSummary({models}:{models:string[]}) {
  const id = useId();
  const [position,setPosition] = useState<{left:number;top:number}|null>(null);
  const show = (element:HTMLElement) => {
    const rect = element.getBoundingClientRect();
    setPosition({left:Math.max(8,Math.min(rect.left,window.innerWidth-328)),top:rect.top-8});
  };
  const remaining = models.length-3;
  return <span className="admin-model-summary uai-footnote">
    <span className="admin-model-summary-names" title={models.slice(0,3).join(' · ')}>{models.slice(0,3).join(' · ')||'—'}</span>
    {remaining>0&&<button type="button" className="admin-model-overflow" aria-label={`Show all ${models.length} models`} aria-describedby={position?id:undefined}
      onMouseEnter={e=>show(e.currentTarget)} onMouseLeave={()=>setPosition(null)}
      onFocus={e=>show(e.currentTarget)} onBlur={()=>setPosition(null)}
      onKeyDown={e=>{if(e.key==='Escape')setPosition(null)}}>+{remaining}</button>}
    {position&&createPortal(<span id={id} role="tooltip" className="admin-model-tooltip" style={position}>{models.map((model,index)=><span key={`${model}:${index}`}>{model}</span>)}</span>,document.body)}
  </span>;
}
