import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@/index.css';
import '@/styles/globals.css';
import i18n from '@/lib/i18n';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FileDeleteConfirmation } from '@/components/file-delete-confirmation';
import { ConnectionDialog } from '@/components/connection-dialog';
import { SettingsModal } from '@/components/settings-modal';
import { LogCommandManager } from '@/components/log-command-manager';
import { TopologyNodeDialog } from '@/components/network/topology-node-dialog';
import { DatabaseConnectionDialogShell, DatabaseConnectionFormGrid, DatabaseConnectionField } from '@/components/toolbox/database-connection-dialog-shell';
import { SyncDialog } from '@/components/sync-dialog';
import { UploadConflictDialog } from '@/components/upload-conflict-dialog';
import { IntegratedFileBrowser } from '@/components/integrated-file-browser';
import { FileBrowserView } from '@/components/file-browser-view';

const params = new URLSearchParams(location.search);
void i18n.changeLanguage(params.get('lang') ?? 'en');
const noop = () => undefined;

function Fixture() {
  const [open, setOpen] = useState(true);
  const [confirmed, setConfirmed] = useState(0);
  const [directory, setDirectory] = useState({ path: '/srv/app', sequence: 1 });
  const kind = params.get('case') ?? 'files';
  const finish = () => { setConfirmed(n => n + 1); setOpen(false); };
  return <>
    <button onClick={() => setOpen(true)}>Open fixture</button><output data-testid="confirmed">{confirmed}</output>
    {kind === 'file-browser' && <>
      <button data-testid="terminal-cd" onClick={() => setDirectory(previous => ({ path: previous.path === '/srv/app' ? '/var/log' : '/srv/app', sequence: previous.sequence + 1 }))}>Terminal cd</button>
      <div className="h-[520px]"><IntegratedFileBrowser connectionId="fixture-files" isConnected terminalWorkingDirectory={directory} host="test-server"
        onClose={noop} onOpenInEditor={noop} /></div>
    </>}
    {kind === 'file-browser-dual' && <>
      <div data-testid="dual-active" className="h-[520px]"><FileBrowserView connectionId="fixture-dual" connectionName="Primary server" isConnected /></div>
      <div hidden><FileBrowserView connectionId="fixture-hidden" connectionName="Hidden server" isConnected isActive={false} /></div>
    </>}
    {kind === 'files' && <FileDeleteConfirmation open={open} targetLabel={'production.example.invalid / ' + '服务器'.repeat(24)}
      remote recursive files={Array.from({ length: 80 }, (_, i) => ({ name: `directory-${i}`, path: `/srv/${'long-path-'.repeat(25)}/${i}/重要目录`, isDirectory: true }))}
      onCancel={() => setOpen(false)} onConfirm={finish} />}
    {kind === 'alert' && <AlertDialog open={open} onOpenChange={setOpen}><AlertDialogContent>
      <AlertDialogHeader><AlertDialogTitle>Delete topology node?</AlertDialogTitle><AlertDialogDescription>This removes the local topology record.</AlertDialogDescription></AlertDialogHeader>
      <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction onClick={finish}>Delete</AlertDialogAction></AlertDialogFooter>
    </AlertDialogContent></AlertDialog>}
    {kind === 'long-alert' && <AlertDialog open={open} onOpenChange={setOpen}><AlertDialogContent>
      <AlertDialogHeader><AlertDialogTitle>Delete local records?</AlertDialogTitle><AlertDialogDescription>{'record/path/'.repeat(500)}</AlertDialogDescription></AlertDialogHeader>
      <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction onClick={finish}>Delete</AlertDialogAction></AlertDialogFooter>
    </AlertDialogContent></AlertDialog>}
    {kind === 'upload-conflicts' && <UploadConflictDialog open={open} label="production.example.invalid"
      rows={Array.from({ length: 30 }, (_, index) => ({ index, sourcePath: `/Users/测试/${'long-name-'.repeat(15)}/${index}.txt`, size: 100,
        modified: '2026-10-14 10:00:00', target: { path: `/srv/${'long-path-'.repeat(20)}/${index}.txt`,
          version: { kind: index % 3 ? 'File' : 'Directory', size: 50, modified: '2026-10-13 10:00:00' } } }))}
      onCancel={() => setOpen(false)} onConfirm={finish} />}
    {kind === 'wide-confirm' && <AlertDialog open={open} onOpenChange={setOpen}><AlertDialogContent className="max-w-[560px]">
      <AlertDialogHeader><AlertDialogTitle>Disconnect with unsaved changes?</AlertDialogTitle><AlertDialogDescription>{'SQL query '.repeat(20)}</AlertDialogDescription></AlertDialogHeader>
      <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction>Save and disconnect</AlertDialogAction><AlertDialogAction>Discard and disconnect</AlertDialogAction></AlertDialogFooter>
    </AlertDialogContent></AlertDialog>}
    {kind === 'form' && <Dialog open={open} onOpenChange={setOpen}><DialogContent className="max-w-xs">
      <DialogHeader><DialogTitle>Rename folder</DialogTitle><DialogDescription>Enter a new name.</DialogDescription></DialogHeader><Input aria-label="Name" />
      <DialogFooter><Button onClick={() => setOpen(false)}>Cancel</Button><Button onClick={finish}>Save</Button></DialogFooter>
    </DialogContent></Dialog>}
    {kind === 'connection' && <ConnectionDialog open={open} onOpenChange={setOpen} onConnect={noop} />}
    {kind === 'settings' && <SettingsModal open={open} onOpenChange={setOpen} />}
    {kind === 'log' && <LogCommandManager open={open} onOpenChange={setOpen} connectionId="fixture" onChanged={noop} />}
    {kind === 'node' && <TopologyNodeDialog open={open} onOpenChange={setOpen} node={{ id: 'fixture', connectionId: 'fixture', groupPath: '', hostname: 'fixture.example.invalid', osName: 'Linux', primaryIp: '192.0.2.1', roleHint: 'unknown', displayName: '', nodeType: 'physical', environment: 'test', notes: '', hidden: false, posX: null, posY: null, lastProbeAt: null, lastProbeStatus: 'never', lastProbeError: null, createdAt: 0, updatedAt: 0 }} onSave={noop} onResetLayout={noop} onDelete={noop} />}
    {kind === 'database' && <DatabaseConnectionDialogShell open={open} onOpenChange={setOpen} testId="database-fixture" title="Database connection"
      sections={[{ id: 'general', label: 'General' }, { id: 'ssh', label: 'SSH' }]} activeSection="general" onActiveSectionChange={noop}
      saveLabel="Save" primaryLabel="Connect" onSave={noop} onPrimary={noop}>
      <DatabaseConnectionFormGrid>{Array.from({ length: 30 }, (_, i) => <DatabaseConnectionField key={i} label={`Field ${i}`} fullWidth={i % 3 === 0}><Input /></DatabaseConnectionField>)}</DatabaseConnectionFormGrid>
    </DatabaseConnectionDialogShell>}
    {kind === 'sync' && <SyncDialog open={open} onOpenChange={setOpen} connectionId="fixture" localPath="/local" remotePath="/remote"
      onLoadLocalDir={async () => []} onLoadRemoteDir={async () => []} onCreateRemoteDir={async () => undefined} onDeleteRemoteItem={async () => undefined} onSyncComplete={noop} />}
  </>;
}

createRoot(document.getElementById('root')!).render(<Fixture />);
