import {useEffect, useRef, type ReactNode} from 'react';
import {RefreshCw, X} from 'lucide-react';
import {Button} from '@uai/ui/components/button';
import {Alert, AlertTitle, AlertDescription} from '@uai/ui/components/alert';

export function OperationDrawer({open, loading, error, onClose, onRefresh, children}: {
  open: boolean; loading: boolean; error: string; onClose: () => void; onRefresh: () => void; children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open) {
      if (!dialog.open) {trigger.current = document.activeElement as HTMLElement; dialog.showModal();}
      return;
    }
    if (!dialog.open) return;
    const timer = window.setTimeout(() => {
      dialog.close();
      if (trigger.current?.isConnected) trigger.current.focus({preventScroll: true});
    }, window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180);
    return () => window.clearTimeout(timer);
  }, [open]);
  useEffect(() => {if (!open) return; const previous = document.body.style.overflow; document.body.style.overflow = 'hidden'; return () => {document.body.style.overflow = previous;};}, [open]);
  return <dialog ref={ref} className="admin-operation-drawer" data-open={open} aria-labelledby="operation-drawer-title"
    onCancel={event => {event.preventDefault(); onClose();}}
    onClick={event => {if (event.target !== event.currentTarget) return; const box = event.currentTarget.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) onClose();}}>
    <header className="admin-drawer-heading"><h2 id="operation-drawer-title">Operation details</h2><div className="admin-top-actions">
      <Button variant="ghost" onClick={onRefresh} disabled={loading} aria-label="Refresh operation"><RefreshCw className={loading ? 'animate-spin' : ''}/></Button>
      <Button variant="ghost" onClick={onClose} aria-label="Close operation details" autoFocus><X/></Button>
    </div></header>
    <div className="admin-drawer-body">{loading ? <p role="status">Loading operation…</p> : error ? <Alert variant="destructive" role="alert"><AlertTitle>Unable to load operation</AlertTitle><AlertDescription>{error}<Button variant="outline" onClick={onRefresh}>Retry</Button></AlertDescription></Alert> : children}</div>
  </dialog>;
}
