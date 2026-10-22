import {createContext,useContext,type ComponentProps} from 'react';
import {Button} from '@uai/ui/components/button';
export const AdminRoleContext=createContext<'admin'|'viewer'>('admin');
/** Marks a specific mutation control; navigation, filters and copies remain usable. */
export function MutationButton(props:ComponentProps<typeof Button>){const role=useContext(AdminRoleContext);return <Button {...props} disabled={role==='viewer'||props.disabled}/>;}
