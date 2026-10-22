import {useEffect,useRef,type ReactNode} from 'react';
import {FluidHoverHighlight,useFluidHover} from '@uai/ui/fluid-hover';
export {pageKey, registerModules} from './registry';
export type {PageDefinition, ModuleDefinition} from './registry';
export interface AdminBrand { name: string; tagline: string }
export interface NavigationItem { key: string; label: string; icon?: ReactNode }
export interface NavigationGroup { id: string; label?: string; items: readonly NavigationItem[] }
export interface AdminShellProps {
  brand: AdminBrand;
  groups: readonly NavigationGroup[];
  active: string;
  onNavigate: (key: string) => void;
  header: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  overlays?: ReactNode;
}
/** Layout only. Authentication and API authorization remain server responsibilities. */
export function AdminShell({brand,groups,active,onNavigate,header,children,footer,overlays}:AdminShellProps) {
  const home=groups.flatMap(group=>group.items)[0]?.key ?? 'overview';
  const navRef=useRef<HTMLElement>(null);
  const hover=useFluidHover(navRef,{axis:'xy',gapClick:false});
  const navKeys=groups.flatMap(group=>group.items.map(item=>item.key)).join('|');
  useEffect(()=>{
    const items=navRef.current?.querySelectorAll<HTMLElement>('[data-uai-nav-item]')??[];
    items.forEach((item,index)=>hover.registerItem(index,item));
    return ()=>items.forEach((_,index)=>hover.registerItem(index,null));
  },[navKeys,hover.registerItem]);
  return <div className="uai-layout">
    <aside className="uai-sidebar">
      <a className="uai-brand" href={`#${home}`} onClick={event=>{event.preventDefault();onNavigate(home)}}>{brand.name}<span>{brand.tagline}</span></a>
      <nav ref={navRef} className="uai-nav" aria-label="Main navigation" {...hover.handlers}><FluidHoverHighlight hover={hover} className="uai-fluid-nav-highlight"/>{groups.map(group=><div key={group.id} className="admin-nav-group">
        {group.label&&<p className="uai-footnote admin-nav-group-label">{group.label}</p>}
        {group.items.map(item=><a data-uai-nav-item key={item.key} href={`#${item.key}`} aria-current={active===item.key?'page':undefined} onClick={event=>{event.preventDefault();onNavigate(item.key)}}>{item.icon}{item.label}</a>)}
      </div>)}</nav>
      {footer&&<div className="uai-footnote">{footer}</div>}
    </aside>
    <div className="admin-shell">{header}{children}</div>
    {overlays}
  </div>;
}
