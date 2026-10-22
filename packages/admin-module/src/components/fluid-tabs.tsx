import { useEffect, useRef, type ComponentProps } from 'react';
import { FluidHoverHighlight, useFluidHover } from '@uai/ui/fluid-hover';
import { spring } from '@uai/ui/springs';

export function FluidTabs({children,className,...props}:ComponentProps<'div'>) {
  const ref=useRef<HTMLDivElement>(null);
  const hover=useFluidHover(ref,{axis:'x',gapClick:false});
  useEffect(()=>{
    const items=ref.current?.querySelectorAll<HTMLElement>('[role=tab]')??[];
    items.forEach((item,index)=>hover.registerItem(index,item));
    return ()=>items.forEach((_,index)=>hover.registerItem(index,null));
  },[children,hover.registerItem]);
  return <div ref={ref} className={['admin-tabs',className].filter(Boolean).join(' ')} {...props} {...hover.handlers}>
    <FluidHoverHighlight hover={hover} transition={spring.moderate} className="admin-fluid-tabs-highlight"/>
    {children}
  </div>;
}
