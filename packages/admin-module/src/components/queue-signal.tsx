import type {ReactNode} from 'react';
import {CircleCheck, CircleAlert, CircleHelp, Activity, AudioLines, Image, Type, Wrench, Radar, Settings} from 'lucide-react';
export type SignalTone='positive'|'negative'|'neutral';
export function QueueSignal({tone='neutral',children}:{tone?:SignalTone;children:ReactNode}){
 const Icon=tone==='positive'?CircleCheck:tone==='negative'?CircleAlert:CircleHelp;
 return <span className={`queue-signal queue-tone-${tone}`}><Icon size={14} aria-hidden="true"/>{children}</span>;
}
const icons={text:Type,image:Image,audio:AudioLines,tools:Wrench,observe:Radar,maintenance:Settings};
export function QueueIcon({kind}:{kind:string}){const Icon=icons[kind as keyof typeof icons]??Activity;return <span className="queue-kind-icon"><Icon size={18} aria-hidden="true"/></span>;}
