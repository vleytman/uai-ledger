import {LogOut, RefreshCw} from 'lucide-react';
import {Button} from '@uai/ui/components/button';
export function HeaderBar({loading, onRefresh, onSignOut, workspace='UAI'}: {workspace?: string; loading: boolean; onRefresh: () => void; onSignOut: () => void}) {
  return <header className="admin-header-bar"><div className="admin-header-inner"><p className="uai-eyebrow">Workspace / {workspace}</p><div className="admin-top-actions">
    <Button variant="outline" onClick={onRefresh} disabled={loading} aria-label="Refresh data"><RefreshCw className={loading ? 'animate-spin' : ''}/></Button>
    <Button variant="ghost" onClick={onSignOut}><LogOut/>Sign out</Button>
  </div></div></header>;
}
