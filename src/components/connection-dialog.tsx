import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from './ui/dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { PasswordInput } from './ui/password-input';
import { Label } from './ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';

import { Switch } from './ui/switch';
import { Checkbox } from './ui/checkbox';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';

import { Separator } from './ui/separator';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { ConnectionProfileManager, type ConnectionProfile } from '../lib/connection-profiles';
import { ConnectionStorageManager } from '../lib/connection-storage';
import { buildSshConnectRequest } from '../lib/ssh-connect-request';
import { toast } from 'sonner';
import {
  Server,
  Shield,
  Key,
  Network,
  Terminal as TerminalIcon,
  Monitor,
  ServerCog,
} from 'lucide-react';
import { getDefaultPort, getAuthMethods, getHiddenFields, isDesktopProtocol } from '@/lib/protocol-config';

interface ConnectionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnect: (config: ConnectionConfig) => void;
  onSave?: (config: ConnectionConfig) => void | Promise<void>;
  editingConnection?: ConnectionConfig | null;
  initialFolder?: string;
}

export interface ConnectionConfig {
  id?: string;
  name: string;
  protocol: 'SSH' | 'Telnet' | 'Raw' | 'Serial' | 'SFTP' | 'FTP' | 'RDP' | 'VNC';
  host: string;
  port: number;
  username: string;
  description?: string;
  authMethod: 'password' | 'publickey' | 'keyboard-interactive' | 'anonymous';
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;

  // Advanced options
  proxyType?: 'none' | 'http' | 'socks4' | 'socks5';
  proxyHost?: string;
  proxyPort?: number;
  proxyUsername?: string;
  proxyPassword?: string;

  // SSH jump host (bastion / ProxyJump)
  jumpHost?: string;
  jumpPort?: number;
  jumpUsername?: string;
  jumpPassword?: string;
  jumpUseKey?: boolean;
  hostKeyFingerprint?: string;
  jumpHostKeyFingerprint?: string;

  // FTP specific
  ftpsEnabled?: boolean;

  // SSH specific
  defaultDirectory?: string; // initial working directory on connect
  terminalEncoding?: 'utf-8' | 'gbk' | 'gb18030';
  terminalStartupMode?: 'safe' | 'disabled';
  keepAlive?: boolean;
  keepAliveInterval?: number;
  serverAliveCountMax?: number;

  // RDP specific
  domain?: string;
  rdpResolution?: '1024x768' | '1280x720' | '1920x1080' | 'fit';

  // VNC specific
  vncColorDepth?: '24' | '16' | '8';
}

/** Host-key confirmation times out as a cancellation after this long. */
const HOST_KEY_PROMPT_TIMEOUT_MS = 30_000;

/**
 * Merge form overrides on top of defaults, falling back to the default when a
 * field is `undefined`. Historical connections saved before advanced/proxy
 * fields were persisted have no such values — without this fallback their edit
 * dialog would show blank controls instead of the defaults used for new ones.
 */
function mergeWithDefaults(defaults: ConnectionConfig, overrides: ConnectionConfig): ConnectionConfig {
  const merged: ConnectionConfig = { ...defaults, ...overrides };
  const mergedRecord = merged as unknown as Record<string, unknown>;
  for (const key of Object.keys(defaults) as Array<keyof ConnectionConfig>) {
    if (mergedRecord[key] === undefined) {
      mergedRecord[key] = defaults[key];
    }
  }
  return merged;
}

export function ConnectionDialog({
  open,
  onOpenChange,
  onConnect,
  onSave,
  editingConnection,
  initialFolder
}: ConnectionDialogProps) {
  const defaultConfig: ConnectionConfig = {
    name: '',
    protocol: 'SSH',
    host: '',
    port: 22,
    username: '',
    description: '',
    authMethod: 'password',
    password: '',
    privateKeyPath: '',
    passphrase: '',
    proxyType: 'none',
    proxyHost: '',
    proxyPort: 8080,
    proxyUsername: '',
    proxyPassword: '',
    jumpHost: '',
    jumpPort: 22,
    jumpUsername: '',
    jumpPassword: '',
    jumpUseKey: false,
    defaultDirectory: '',
    terminalEncoding: 'utf-8',
    terminalStartupMode: 'safe',
    keepAlive: true,
    keepAliveInterval: 60,
    serverAliveCountMax: 3
  };

  const [config, setConfig] = useState<ConnectionConfig>(defaultConfig);
  const [hostKeyPrompt, setHostKeyPrompt] = useState<string | null>(null);
  const hostKeyPromptResolverRef = useRef<((accepted: boolean) => void) | null>(null);
  const hostKeyPromptTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearHostKeyPromptTimeout = useCallback(() => {
    if (hostKeyPromptTimeoutRef.current) {
      clearTimeout(hostKeyPromptTimeoutRef.current);
      hostKeyPromptTimeoutRef.current = null;
    }
  }, []);

  const confirmHostKey = useCallback((message: string) => new Promise<boolean>((resolve) => {
    hostKeyPromptResolverRef.current = resolve;
    setHostKeyPrompt(message);
    clearHostKeyPromptTimeout();
    hostKeyPromptTimeoutRef.current = setTimeout(() => {
      hostKeyPromptResolverRef.current?.(false);
      hostKeyPromptResolverRef.current = null;
      setHostKeyPrompt(null);
    }, HOST_KEY_PROMPT_TIMEOUT_MS);
  }), [clearHostKeyPromptTimeout]);

  const resolveHostKeyPrompt = useCallback((accepted: boolean) => {
    clearHostKeyPromptTimeout();
    hostKeyPromptResolverRef.current?.(accepted);
    hostKeyPromptResolverRef.current = null;
    setHostKeyPrompt(null);
  }, [clearHostKeyPromptTimeout]);

  // Resolve any in-flight host-key prompt to "cancelled" on unmount so the
  // awaiting connection flow never hangs on a promise that can no longer be
  // answered (e.g. the dialog is closed while the probe is pending).
  useEffect(() => {
    return () => {
      clearHostKeyPromptTimeout();
      hostKeyPromptResolverRef.current?.(false);
      hostKeyPromptResolverRef.current = null;
    };
  }, [clearHostKeyPromptTimeout]);

  // UI-only state for the jump-host section: the switch toggles this, and the
  // form fields are shown while it is on. The actual jump config is derived
  // from jumpHost (non-empty) when saving / connecting.
  const [jumpEnabled, setJumpEnabled] = useState(false);

  // Track number input display values separately from config to allow
  // the field to be empty while editing — React controlled inputs need
  // value="" to render empty, but ConnectionConfig uses strict number types.
  const initialDisplayValues = {
    port: 22 as number | '',
    proxyPort: 8080 as number | '',
    jumpPort: 22 as number | '',
    keepAliveInterval: 60 as number | '',
    serverAliveCountMax: 3 as number | '',
  };
  const [displayValues, setDisplayValues] = useState(initialDisplayValues);

  /** Handle onChange for a controlled number input that must allow empty. */
  const handleNumberInput = (
    field: keyof typeof initialDisplayValues,
    rawValue: string,
    onValid: (n: number) => void,
  ) => {
    if (rawValue === '') {
      setDisplayValues(prev => ({ ...prev, [field]: '' }));
      return;
    }
    const parsed = parseInt(rawValue, 10);
    if (!Number.isNaN(parsed)) {
      setDisplayValues(prev => ({ ...prev, [field]: parsed }));
      onValid(parsed);
    }
  };

  /** Sync display values when the form re-opens with new data. */
  const syncDisplayValues = (config_: typeof initialDisplayValues) => {
    setDisplayValues(config_);
  };

  const [isConnecting, setIsConnecting] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [_savedProfiles, setSavedProfiles] = useState<ConnectionProfile[]>([]);
  const [_showSaveProfile, setShowSaveProfile] = useState(false);
  const [saveAsConnection, setSaveAsConnection] = useState(true);
  const { t } = useTranslation();
  const [connectionFolder, setConnectionFolder] = useState('All Connections');
  const [availableFolders, setAvailableFolders] = useState<string[]>([]);
  const connectionIdRef = useRef<string | null>(null);
  const cancelRequestedRef = useRef(false);

  // Reset connection state and load saved profiles when dialog opens/closes
  useEffect(() => {
    if (open) {
      // Reset connection state when dialog opens
      resetConnectionState();

      setSavedProfiles(ConnectionProfileManager.getProfiles());

      // Load only valid folders from connection manager (excludes orphaned/deleted folders)
      const folders = ConnectionStorageManager.getValidFolders();
      const folderPaths = folders.map(f => f.path).sort();
      setAvailableFolders(folderPaths);

      // New connection: default to the first real (non-root) folder so a
      // folder is visibly pre-selected — "All Connections" is the root, not a
      // folder the user can save into. Fall back to the root when no
      // subfolders exist yet. Opening from a folder context menu pre-selects
      // that folder. Editing keeps the connection's own folder.
      if (!editingConnection) {
        const firstRealFolder =
          folderPaths.find(p => p !== 'All Connections') ?? folderPaths[0] ?? 'All Connections';
        setConnectionFolder(initialFolder ?? firstRealFolder);
      }

      // Load editing connection data into config when dialog opens.
      // mergeWithDefaults falls back to defaultConfig for fields a historical
      // connection never stored (advanced/proxy options), matching the
      // pre-filled values a new connection gets.
      if (editingConnection) {
        setConfig(mergeWithDefaults(defaultConfig, editingConnection));
        setJumpEnabled(!!editingConnection.jumpHost);
        syncDisplayValues({
          port: editingConnection.port ?? 22,
          proxyPort: editingConnection.proxyPort ?? 8080,
          jumpPort: editingConnection.jumpPort ?? 22,
          keepAliveInterval: editingConnection.keepAliveInterval ?? 60,
          serverAliveCountMax: editingConnection.serverAliveCountMax ?? 3,
        });
        // When editing, don't show "save as connection" since it already exists
        setSaveAsConnection(false);
      } else {
        // Reset to defaults for new connection
        setConfig(defaultConfig);
        setJumpEnabled(false);
        setSaveAsConnection(true);
        syncDisplayValues(initialDisplayValues);
      }
    } else {
      // Reset connection state when dialog closes
      resetConnectionState();
    }
  }, [open, editingConnection, initialFolder]);

  const _handleSaveProfile = () => {
    try {
      const profile = ConnectionProfileManager.saveProfile({
        name: config.name,
        host: config.host,
        port: config.port,
        username: config.username,
        authMethod: config.authMethod === 'publickey' ? 'key' : 'password',
        password: config.password,
        privateKey: config.privateKeyPath,
      });
      setSavedProfiles(ConnectionProfileManager.getProfiles());
      toast.success(t('connectionDialog.toast.savedProfile', { name: profile.name }));
      setShowSaveProfile(false);
    } catch (_error) {
      toast.error(t('connectionDialog.toast.failedToSaveProfile'));
    }
  };

  const _handleLoadProfile = (profile: ConnectionProfile) => {
    setConfig({
      ...config,
      name: profile.name,
      host: profile.host,
      port: profile.port,
      username: profile.username,
      authMethod: profile.authMethod === 'key' ? 'publickey' : 'password',
      password: profile.password,
      privateKeyPath: profile.privateKey,
    });
    toast.success(t('connectionDialog.toast.loadedProfile', { name: profile.name }));
  };

  const _handleDeleteProfile = (id: string) => {
    if (ConnectionProfileManager.deleteProfile(id)) {
      setSavedProfiles(ConnectionProfileManager.getProfiles());
      toast.success(t('connectionDialog.toast.profileDeleted'));
    }
  };

  const _handleToggleFavorite = (id: string) => {
    const profile = ConnectionProfileManager.getProfile(id);
    if (profile) {
      ConnectionProfileManager.updateProfile(id, { favorite: !profile.favorite });
      setSavedProfiles(ConnectionProfileManager.getProfiles());
    }
  };

  function resetConnectionState() {
    setIsConnecting(false);
    setIsCancelling(false);
    connectionIdRef.current = null;
    cancelRequestedRef.current = false;
  }

  const handleConnect = async () => {
    if (isConnecting) {
      return;
    }

    setIsConnecting(true);
    setIsCancelling(false);
    cancelRequestedRef.current = false;
    const connectionId = editingConnection?.id || `connection-${Date.now()}`;
    connectionIdRef.current = connectionId;

    // Basic validation — anonymous FTP doesn't require a username
    // VNC also doesn't require a username
    const requiresUsername = config.authMethod !== 'anonymous' && config.protocol !== 'VNC';
    if (!config.name || !config.host || (requiresUsername && !config.username)) {
      toast.error(t('connectionDialog.toast.missingFields'), {
        description: requiresUsername
          ? t('connectionDialog.toast.missingFieldsDesc')
          : t('connectionDialog.toast.missingFieldsNoUsernameDesc'),
      });
      resetConnectionState();
      return;
    }

    // Validate authentication method specific fields
    if (config.authMethod === 'password' && !config.password) {
      toast.error(t('connectionDialog.toast.passwordRequired'), {
        description: t('connectionDialog.toast.passwordRequiredDesc'),
      });
      resetConnectionState();
      return;
    }

    if (config.authMethod === 'publickey' && !config.privateKeyPath) {
      toast.error(t('connectionDialog.toast.privateKeyRequired'), {
        description: t('connectionDialog.toast.privateKeyRequiredDesc'),
      });
      resetConnectionState();
      return;
    }

    let connectionConfig = config;
    if ((config.protocol === 'SSH' || config.protocol === 'SFTP') && !config.hostKeyFingerprint) {
      try {
        const { fingerprint } = await invoke<{ fingerprint: string }>('ssh_host_key_fingerprint', {
          request: { host: config.host, port: config.port || 22 },
        });
        if (!(await confirmHostKey(t('connectionDialog.hostKey.confirm', { host: config.host, port: config.port || 22, fingerprint })))) {
          resetConnectionState();
          return;
        }
        connectionConfig = { ...config, hostKeyFingerprint: fingerprint };
      } catch (error) {
        toast.error(t('connectionDialog.hostKey.probeFailed'), { description: String(error) });
        resetConnectionState();
        return;
      }
    }
    if ((config.protocol === 'SSH' || config.protocol === 'SFTP') && config.jumpHost?.trim() && !connectionConfig.jumpHostKeyFingerprint) {
      try {
        const { fingerprint } = await invoke<{ fingerprint: string }>('ssh_host_key_fingerprint', {
          request: { host: config.jumpHost, port: config.jumpPort || 22 },
        });
        if (!(await confirmHostKey(t('connectionDialog.hostKey.confirmJump', { host: config.jumpHost, port: config.jumpPort || 22, fingerprint })))) {
          resetConnectionState();
          return;
        }
        connectionConfig = { ...connectionConfig, jumpHostKeyFingerprint: fingerprint };
      } catch (error) {
        toast.error(t('connectionDialog.hostKey.probeFailed'), { description: String(error) });
        resetConnectionState();
        return;
      }
    }


    // For SFTP/FTP/RDP/VNC protocols, delegate connection to App.tsx (via onConnect)
    // which calls the appropriate Tauri commands.
    const isSftpOrFtp = config.protocol === 'SFTP' || config.protocol === 'FTP';
    const isDesktop = config.protocol === 'RDP' || config.protocol === 'VNC';

    if (isSftpOrFtp || isDesktop) {
      try {
        // Save connection if requested
        if (editingConnection?.id) {
          ConnectionStorageManager.updateConnection(editingConnection.id, {
            name: config.name,
            host: config.host,
            port: config.port || (config.protocol === 'FTP' ? 21 : config.protocol === 'RDP' ? 3389 : config.protocol === 'VNC' ? 5900 : 22),
            username: config.username,
            description: config.description,
            protocol: config.protocol,
            authMethod: config.authMethod,
            password: config.password,
            privateKeyPath: config.privateKeyPath,
            passphrase: config.passphrase,
            ftpsEnabled: config.ftpsEnabled,
            proxyType: config.proxyType,
            proxyHost: config.proxyHost,
            proxyPort: config.proxyPort,
            proxyUsername: config.proxyUsername,
            proxyPassword: config.proxyPassword,
            jumpHost: jumpEnabled ? config.jumpHost : undefined,
            jumpPort: jumpEnabled ? config.jumpPort : undefined,
            jumpUsername: jumpEnabled ? config.jumpUsername : undefined,
            jumpPassword: jumpEnabled ? config.jumpPassword : undefined,
            jumpUseKey: jumpEnabled ? config.jumpUseKey : undefined,
            defaultDirectory: config.defaultDirectory,
            terminalEncoding: config.terminalEncoding,
            terminalStartupMode: config.terminalStartupMode,
            keepAlive: config.keepAlive,
            keepAliveInterval: config.keepAliveInterval,
            serverAliveCountMax: config.serverAliveCountMax,
            domain: config.domain,
            rdpResolution: config.rdpResolution,
            vncColorDepth: config.vncColorDepth,
            lastConnected: new Date().toISOString(),
          });
        } else if (saveAsConnection) {
          ConnectionStorageManager.saveConnectionWithId(connectionId, {
            name: config.name,
            host: config.host,
            port: config.port || (config.protocol === 'FTP' ? 21 : config.protocol === 'RDP' ? 3389 : config.protocol === 'VNC' ? 5900 : 22),
            username: config.username,
            description: config.description,
            protocol: config.protocol,
            folder: connectionFolder,
            authMethod: config.authMethod,
            password: config.password,
            privateKeyPath: config.privateKeyPath,
            passphrase: config.passphrase,
            ftpsEnabled: config.ftpsEnabled,
            proxyType: config.proxyType,
            proxyHost: config.proxyHost,
            proxyPort: config.proxyPort,
            proxyUsername: config.proxyUsername,
            proxyPassword: config.proxyPassword,
            jumpHost: jumpEnabled ? config.jumpHost : undefined,
            jumpPort: jumpEnabled ? config.jumpPort : undefined,
            jumpUsername: jumpEnabled ? config.jumpUsername : undefined,
            jumpPassword: jumpEnabled ? config.jumpPassword : undefined,
            jumpUseKey: jumpEnabled ? config.jumpUseKey : undefined,
            defaultDirectory: config.defaultDirectory,
            terminalEncoding: config.terminalEncoding,
            terminalStartupMode: config.terminalStartupMode,
            keepAlive: config.keepAlive,
            keepAliveInterval: config.keepAliveInterval,
            serverAliveCountMax: config.serverAliveCountMax,
            domain: config.domain,
            rdpResolution: config.rdpResolution,
            vncColorDepth: config.vncColorDepth,
          });
        }

        if (connectionConfig.hostKeyFingerprint) {
          ConnectionStorageManager.updateConnection(connectionId, {
            hostKeyFingerprint: connectionConfig.hostKeyFingerprint,
            jumpHostKeyFingerprint: connectionConfig.jumpHostKeyFingerprint,
          });
        }

        // Delegate actual connection to App.tsx handler
        onConnect({ ...connectionConfig, id: connectionId });
        onOpenChange(false);

        if (!editingConnection) {
          setConfig(defaultConfig);
        }
      } finally {
        resetConnectionState();
      }
      return;
    }

    // SSH / Telnet / Raw / Serial — connect via ssh_connect
    // Save connection config FIRST (consistent with SFTP/FTP/Desktop),
    // so the config is preserved even if the remote server is temporarily unreachable.
    if (editingConnection?.id) {
      ConnectionStorageManager.updateConnection(editingConnection.id, {
        name: config.name,
        host: config.host,
        port: config.port || 22,
        username: config.username,
        description: config.description,
        protocol: config.protocol,
        authMethod: config.authMethod,
        password: config.password,
        privateKeyPath: config.privateKeyPath,
        passphrase: config.passphrase,
        proxyType: config.proxyType,
        proxyHost: config.proxyHost,
        proxyPort: config.proxyPort,
        proxyUsername: config.proxyUsername,
        proxyPassword: config.proxyPassword,
        jumpHost: jumpEnabled ? config.jumpHost : undefined,
        jumpPort: jumpEnabled ? config.jumpPort : undefined,
        jumpUsername: jumpEnabled ? config.jumpUsername : undefined,
        jumpPassword: jumpEnabled ? config.jumpPassword : undefined,
        jumpUseKey: jumpEnabled ? config.jumpUseKey : undefined,
        defaultDirectory: config.defaultDirectory,
        terminalEncoding: config.terminalEncoding,
        terminalStartupMode: config.terminalStartupMode,
        keepAlive: config.keepAlive,
        keepAliveInterval: config.keepAliveInterval,
        serverAliveCountMax: config.serverAliveCountMax,
        lastConnected: new Date().toISOString(),
      });
    } else if (saveAsConnection) {
      ConnectionStorageManager.saveConnectionWithId(connectionId, {
        name: config.name,
        host: config.host,
        port: config.port || 22,
        username: config.username,
        description: config.description,
        protocol: config.protocol,
        folder: connectionFolder,
        authMethod: config.authMethod,
        password: config.password,
        privateKeyPath: config.privateKeyPath,
        passphrase: config.passphrase,
        proxyType: config.proxyType,
        proxyHost: config.proxyHost,
        proxyPort: config.proxyPort,
        proxyUsername: config.proxyUsername,
        proxyPassword: config.proxyPassword,
        jumpHost: jumpEnabled ? config.jumpHost : undefined,
        jumpPort: jumpEnabled ? config.jumpPort : undefined,
        jumpUsername: jumpEnabled ? config.jumpUsername : undefined,
        jumpPassword: jumpEnabled ? config.jumpPassword : undefined,
        jumpUseKey: jumpEnabled ? config.jumpUseKey : undefined,
        defaultDirectory: config.defaultDirectory,
        terminalEncoding: config.terminalEncoding,
        terminalStartupMode: config.terminalStartupMode,
        keepAlive: config.keepAlive,
        keepAliveInterval: config.keepAliveInterval,
        serverAliveCountMax: config.serverAliveCountMax,
      });
    }

    // Persist the accepted TOFU fingerprints before attempting authentication.
    // A bad password or temporary network failure must not discard a host key
    // the user has explicitly approved.
    if (connectionConfig.hostKeyFingerprint) {
      ConnectionStorageManager.updateConnection(connectionId, {
        hostKeyFingerprint: connectionConfig.hostKeyFingerprint,
        jumpHostKeyFingerprint: connectionConfig.jumpHostKeyFingerprint,
      });
    }

    try {
      const result = await invoke<{ success: boolean; error?: string }>(
        'ssh_connect',
        {
          request: buildSshConnectRequest(connectionId, connectionConfig),
        }
      );

      if (result.success) {
        onConnect({
          ...connectionConfig,
          id: connectionId
        });
        ConnectionStorageManager.updateConnection(connectionId, {
          hostKeyFingerprint: connectionConfig.hostKeyFingerprint,
          jumpHostKeyFingerprint: connectionConfig.jumpHostKeyFingerprint,
        });
        if (!editingConnection) {
          setConfig(defaultConfig);
        }
      } else {
        // Connection failed — config was already saved above, user can retry from sidebar
        console.error('Connection failed:', result.error);
        if (cancelRequestedRef.current && result.error?.toLowerCase().includes('cancelled')) {
          toast.info(t('connectionDialog.toast.connectionCancelled'));
        } else {
          toast.error(t('connectionDialog.toast.connectionFailed'), {
            description: result.error || t('connectionDialog.toast.connectionFailedDesc'),
            duration: 5000,
          });
        }
      }
    } catch (error) {
      console.error('Connection error:', error);
      if (cancelRequestedRef.current) {
        toast.info(t('connectionDialog.toast.connectionCancelled'));
      } else {
        toast.error(t('connectionDialog.toast.connectionError'), {
          description: error instanceof Error ? error.message : t('connectionDialog.toast.connectionErrorDesc'),
          duration: 5000,
        });
      }
    } finally {
      // Close dialog — config was already saved above
      onOpenChange(false);
      if (!editingConnection) {
        setConfig(defaultConfig);
      }
      resetConnectionState();
    }

  }

const handleCancelConnectionAttempt = async () => {
    if (!isConnecting) {
      onOpenChange(false);
      return;
    }

    if (isCancelling) {
      return;
    }

    const connectionId = connectionIdRef.current;
    if (!connectionId) {
      resetConnectionState();
      return;
    }

    cancelRequestedRef.current = true;
    setIsCancelling(true);

    try {
      const response = await invoke<{ success: boolean; error?: string }>('ssh_cancel_connect', {
        connectionId: connectionId
      });
      if (response.success) {
        toast.info(t('connectionDialog.toast.connectionCancelled'));
      }
      // Whether successful or not, we want to reset the state
      // The user clicked cancel, so we should stop the "connecting" state
    } catch (error) {
      console.error('Failed to cancel connection:', error);
      // Don't show error toast - user just wants to stop, we'll reset the state
    } finally {
      // Always reset the state when user requests cancel
      resetConnectionState();
    }
  };

  const handleSave = async () => {
    if (!editingConnection?.id) return;

    // Save updated connection to storage
    ConnectionStorageManager.updateConnection(editingConnection.id, {
      name: config.name,
      host: config.host,
      port: config.port || 22,
      username: config.username,
      description: config.description,
      protocol: config.protocol,
      authMethod: config.authMethod,
      password: config.password,
      privateKeyPath: config.privateKeyPath,
      passphrase: config.passphrase,
      ftpsEnabled: config.ftpsEnabled,
      proxyType: config.proxyType,
      proxyHost: config.proxyHost,
      proxyPort: config.proxyPort,
      proxyUsername: config.proxyUsername,
      proxyPassword: config.proxyPassword,
      jumpHost: jumpEnabled ? config.jumpHost : undefined,
      jumpPort: jumpEnabled ? config.jumpPort : undefined,
      jumpUsername: jumpEnabled ? config.jumpUsername : undefined,
      jumpPassword: jumpEnabled ? config.jumpPassword : undefined,
      jumpUseKey: jumpEnabled ? config.jumpUseKey : undefined,
      keepAlive: config.keepAlive,
      keepAliveInterval: config.keepAliveInterval,
      serverAliveCountMax: config.serverAliveCountMax,
      domain: config.domain,
      rdpResolution: config.rdpResolution,
      vncColorDepth: config.vncColorDepth,
      defaultDirectory: config.defaultDirectory,
      terminalEncoding: config.terminalEncoding,
      terminalStartupMode: config.terminalStartupMode,
    });

    // Notify parent to update tab display info (e.g. tab title)
    // May also trigger a connection attempt if there's no open tab
    await onSave?.({
      ...config,
      id: editingConnection.id,
    });

    onOpenChange(false);
    resetConnectionState();
  };

  const updateConfig = (updates: Partial<ConnectionConfig>) => {
    setConfig(prev => ({ ...prev, ...updates }));
  };

  // Saved SSH/SFTP servers that can serve as a jump host (exclude the
  // connection being edited itself).
  const jumpCandidates = useMemo(
    () =>
      ConnectionStorageManager.getConnections().filter((c) => {
        const proto = (c.protocol || '').toUpperCase();
        if (proto !== 'SSH' && proto !== 'SFTP') return false;
        return c.id !== editingConnection?.id;
      }),
    [editingConnection],
  );

  // When a jump host is picked from the saved-servers list, its connection
  // fields are reused as-is and locked so the user doesn't re-enter them.
  const [jumpServerId, setJumpServerId] = useState<string | null>(null);

  /**
   * Fill the jump fields from a saved server and lock them. Credentials are
   * reused from that server: password-auth servers supply their own password;
   * key-auth servers fall back to the shared private key model.
   */
  const applyJumpFromServer = useCallback(
    (server: { id: string; host: string; port?: number; username?: string; authMethod?: string; password?: string }) => {
      setJumpEnabled(true);
      setJumpServerId(server.id);
      const usePassword = server.authMethod === 'password' && !!server.password;
      updateConfig({
        jumpHost: server.host,
        jumpPort: server.port || 22,
        jumpUsername: server.username || '',
        jumpPassword: usePassword ? server.password : '',
        jumpUseKey: !usePassword,
      });
    },
    [],
  );

  /** Unlock the jump fields for manual editing. */
  const clearJumpServer = useCallback(() => {
    setJumpServerId(null);
  }, []);

  const handleOpenChange = (newOpen: boolean) => {
    // If trying to close while connecting, cancel first then close
    if (!newOpen && isConnecting) {
      // Cancel connection and then close
      handleCancelConnectionAttempt().then(() => {
        resetConnectionState();
        onOpenChange(false);
      });
      return;
    }
    onOpenChange(newOpen);
  };

  return (
    <>
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="top-[50%] left-[50%] -translate-x-1/2 -translate-y-1/2 w-[900px] h-[680px] max-w-[90vw] max-h-[90vh] flex flex-col p-0 gap-0">
        <DialogHeader className="px-6 pt-6 pb-4 border-b">
          <DialogTitle className="flex items-center gap-2">
            <div className="p-2 bg-primary/10 rounded-lg">
              <Server className="h-5 w-5 text-primary" />
            </div>
            <div>
              <div>{editingConnection ? t('connectionDialog.title.edit') : t('connectionDialog.title.new')}</div>
              <DialogDescription className="mt-1">
                {t('connectionDialog.description')}
              </DialogDescription>
            </div>
          </DialogTitle>
        </DialogHeader>

        <Tabs defaultValue="connection" className="flex-1 flex flex-col overflow-hidden">
          <TabsList className="w-full justify-start rounded-none border-b bg-transparent h-auto p-0 px-4 overflow-x-auto">
            <TabsTrigger
              value="connection"
              className="flex items-center gap-1 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none px-2.5 py-2.5 text-sm whitespace-nowrap"
            >
              <Server className="h-3.5 w-3.5" />
              <span>{t('connectionDialog.tab.connection')}</span>
            </TabsTrigger>
            <TabsTrigger
              value="authentication"
              className="flex items-center gap-1 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none px-2.5 py-2.5 text-sm whitespace-nowrap"
            >
              <Shield className="h-3.5 w-3.5" />
              <span>{t('connectionDialog.tab.auth')}</span>
            </TabsTrigger>
            <TabsTrigger
              value="proxy"
              className="flex items-center gap-1 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none px-2.5 py-2.5 text-sm whitespace-nowrap"
            >
              <Network className="h-3.5 w-3.5" />
              <span>{t('connectionDialog.tab.proxy')}</span>
            </TabsTrigger>
            <TabsTrigger
              value="advanced"
              className="flex items-center gap-1 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none px-2.5 py-2.5 text-sm whitespace-nowrap"
            >
              <TerminalIcon className="h-3.5 w-3.5" />
              <span>{t('connectionDialog.tab.advanced')}</span>
            </TabsTrigger>
          </TabsList>

          <TabsContent value="connection" className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-4 mt-0">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Server className="h-4 w-4" />
                  {t('connectionDialog.section.basicSettings')}
                </CardTitle>
                <CardDescription>
                  {t('connectionDialog.section.basicSettingsDesc')}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="connection-name">{t('connectionDialog.label.connectionName')}</Label>
                    <Input
                      id="connection-name"
                      placeholder={t('connectionDialog.placeholder.connectionName')}
                      value={config.name}
                      onChange={(e) => updateConfig({ name: e.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="protocol">{t('connectionDialog.label.protocol')}</Label>
                    <Select
                      value={config.protocol}
                      onValueChange={(value: ConnectionConfig['protocol']) => {
                        const validAuthMethods = getAuthMethods(value);
                        const currentAuthValid = validAuthMethods.includes(config.authMethod);
                        const defaultPort = getDefaultPort(value);
                        updateConfig({
                          protocol: value,
                          port: defaultPort,
                          ...(!currentAuthValid && { authMethod: validAuthMethods[0] }),
                          ...(value !== 'FTP' && { ftpsEnabled: undefined }),
                        });
                        setDisplayValues(prev => ({ ...prev, port: defaultPort }));
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="SSH">SSH</SelectItem>
                        <SelectItem value="SFTP">SFTP</SelectItem>
                        <SelectItem value="FTP">FTP</SelectItem>
                        <SelectItem value="RDP">RDP</SelectItem>
                        <SelectItem value="VNC">VNC</SelectItem>
                        <SelectItem value="Telnet">Telnet</SelectItem>
                        <SelectItem value="Raw">Raw</SelectItem>
                        <SelectItem value="Serial">Serial</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-4">
                  <div className="col-span-2 space-y-2">
                    <Label htmlFor="host">{t('connectionDialog.label.host')}</Label>
                    <Input
                      id="host"
                      placeholder={t('connectionDialog.placeholder.host')}
                      value={config.host}
                      onChange={(e) => updateConfig({ host: e.target.value, hostKeyFingerprint: undefined })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="port">{t('connectionDialog.label.port')}</Label>
                    <Input
                      id="port"
                      type="number"
                      value={displayValues.port}
                      onChange={(e) => handleNumberInput('port', e.target.value, (n) => updateConfig({ port: n, hostKeyFingerprint: undefined }))}
                    />
                  </div>
                </div>

                {/* Username — hidden for VNC (VNC uses password-only auth) */}
                {config.protocol !== 'VNC' && (
                  <div className="space-y-2">
                    <Label htmlFor="username">{t('connectionDialog.label.username')}</Label>
                    <Input
                      id="username"
                      placeholder={t('connectionDialog.placeholder.username')}
                      value={config.username}
                      onChange={(e) => updateConfig({ username: e.target.value })}
                    />
                  </div>
                )}

                <div className="space-y-2 col-span-2">
                  <Label htmlFor="connection-description">{t('connectionDialog.label.description')}</Label>
                  <Input
                    id="connection-description"
                    placeholder={t('connectionDialog.placeholder.description')}
                    value={config.description}
                    onChange={(e) => updateConfig({ description: e.target.value })}
                  />
                </div>

                {/* Default directory — SSH/SFTP open here on connect */}
                {(config.protocol === 'SSH' || config.protocol === 'SFTP') && (
                  <div className="grid grid-cols-3 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="default-directory">{t('connectionDialog.label.defaultDirectory')}</Label>
                    <Input
                      id="default-directory"
                      placeholder={t('connectionDialog.placeholder.defaultDirectory')}
                      value={config.defaultDirectory}
                      onChange={(e) => updateConfig({ defaultDirectory: e.target.value })}
                      className="font-mono text-xs"
                    />
                  </div>
                   <div className="space-y-2">
                     <Label>{t('connectionDialog.label.terminalEncoding')}</Label>
                    <Select value={config.terminalEncoding ?? 'utf-8'} onValueChange={(terminalEncoding) => updateConfig({ terminalEncoding: terminalEncoding as ConnectionConfig['terminalEncoding'] })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="utf-8">UTF-8</SelectItem>
                        <SelectItem value="gbk">GBK</SelectItem>
                        <SelectItem value="gb18030">GB18030</SelectItem>
                      </SelectContent>
                     </Select>
                   </div>
                   <div className="space-y-2">
                     <Label>{t('connectionDialog.label.terminalStartupMode')}</Label>
                     <Select value={config.terminalStartupMode ?? 'safe'} onValueChange={(terminalStartupMode) => updateConfig({ terminalStartupMode: terminalStartupMode as ConnectionConfig['terminalStartupMode'] })}>
                       <SelectTrigger><SelectValue /></SelectTrigger>
                       <SelectContent>
                         <SelectItem value="safe">{t('connectionDialog.label.terminalStartupSafe')}</SelectItem>
                         <SelectItem value="disabled">{t('connectionDialog.label.terminalStartupDisabled')}</SelectItem>
                       </SelectContent>
                     </Select>
                   </div>
                  </div>
                )}

                {/* RDP-specific: domain and resolution */}
                {config.protocol === 'RDP' && (
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="rdp-domain">{t('connectionDialog.label.domain')}</Label>
                      <Input
                        id="rdp-domain"
                        placeholder={t('connectionDialog.placeholder.domain')}
                        value={config.domain || ''}
                        onChange={(e) => updateConfig({ domain: e.target.value })}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>{t('connectionDialog.label.displayResolution')}</Label>
                      <Select
                        value={config.rdpResolution || 'fit'}
                        onValueChange={(value) => updateConfig({ rdpResolution: value as ConnectionConfig['rdpResolution'] })}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="fit">{t('connectionDialog.rdp.fitToWindow')}</SelectItem>
                          <SelectItem value="1024x768">{t('connectionDialog.rdp.h1024x768')}</SelectItem>
                          <SelectItem value="1280x720">{t('connectionDialog.rdp.h1280x720')}</SelectItem>
                          <SelectItem value="1920x1080">{t('connectionDialog.rdp.h1920x1080')}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                )}

                {/* VNC-specific: color depth */}
                {config.protocol === 'VNC' && (
                  <div className="space-y-2">
                    <Label>{t('connectionDialog.label.colorDepth')}</Label>
                    <Select
                      value={config.vncColorDepth || '24'}
                      onValueChange={(value) => updateConfig({ vncColorDepth: value as ConnectionConfig['vncColorDepth'] })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="24">{t('connectionDialog.vnc.trueColor')}</SelectItem>
                        <SelectItem value="16">{t('connectionDialog.vnc.highColor')}</SelectItem>
                        <SelectItem value="8">{t('connectionDialog.vnc.colors256')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                )}

                {/* Desktop protocol info */}
                {isDesktopProtocol(config.protocol) && (
                  <div className="p-4 bg-muted rounded-lg">
                    <div className="flex items-center gap-2 mb-2">
                      <Monitor className="h-4 w-4" />
                      <span className="font-medium">{t('connectionDialog.desktopInfo.title')}</span>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {config.protocol === 'RDP'
                        ? t('connectionDialog.desktopInfo.rdp')
                        : t('connectionDialog.desktopInfo.vnc')}
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="authentication" className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-4 mt-0">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Shield className="h-4 w-4" />
                  {t('connectionDialog.section.authentication')}
                </CardTitle>
                <CardDescription>
                  {t('connectionDialog.section.authenticationDesc')}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>{t('connectionDialog.section.authentication')}</Label>
                  <Select
                    value={config.authMethod}
                    onValueChange={(value: ConnectionConfig['authMethod']) => updateConfig({ authMethod: value })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {getAuthMethods(config.protocol).map((method) => (
                        <SelectItem key={method} value={method}>
                          {method === 'password' ? t('connectionDialog.authMethod.password') :
                           method === 'publickey' ? t('connectionDialog.authMethod.publicKey') :
                           method === 'keyboard-interactive' ? t('connectionDialog.authMethod.keyboardInteractive') :
                           method === 'anonymous' ? t('connectionDialog.authMethod.anonymous') : method}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {config.authMethod === 'password' && (
                  <div className="space-y-2">
                    <Label htmlFor="password">{t('connectionDialog.label.password')}</Label>
                    <PasswordInput
                      id="password"
                      placeholder={t('connectionDialog.placeholder.password')}
                      value={config.password}
                      onChange={(e) => updateConfig({ password: e.target.value })}
                    />
                  </div>
                )}

                {config.authMethod === 'publickey' && (
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="private-key">{t('connectionDialog.label.privateKey')}</Label>
                      <Input
                        id="private-key"
                        placeholder={t('connectionDialog.placeholder.privateKey')}
                        value={config.privateKeyPath}
                        onChange={(e) => updateConfig({ privateKeyPath: e.target.value })}
                      />
                      <p className="text-xs text-muted-foreground">
                        {t('connectionDialog.placeholder.privateKey')}
                      </p>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="passphrase">{t('connectionDialog.label.passphrase')}</Label>
                      <PasswordInput
                        id="passphrase"
                        placeholder={t('connectionDialog.placeholder.passphrase')}
                        value={config.passphrase}
                        onChange={(e) => updateConfig({ passphrase: e.target.value })}
                      />
                    </div>
                  </div>
                )}

                {config.authMethod === 'anonymous' && (
                  <div className="p-4 bg-muted rounded-lg">
                    <p className="text-sm text-muted-foreground">
                      {t('connectionDialog.securityNote.anonymous')}
                    </p>
                  </div>
                )}

                {config.protocol === 'FTP' && (
                  <>
                    <Separator />
                    <div className="flex items-center justify-between">
                      <div className="space-y-0.5">
                        <Label>{t('connectionDialog.ftp.enableFtps')}</Label>
                        <p className="text-sm text-muted-foreground">
                          {t('connectionDialog.ftp.enableFtpsDesc')}
                        </p>
                      </div>
                      <Switch
                        checked={config.ftpsEnabled ?? false}
                        onCheckedChange={(checked) => updateConfig({ ftpsEnabled: checked })}
                      />
                    </div>
                  </>
                )}

                <div className="p-4 bg-muted rounded-lg">
                  <div className="flex items-center gap-2 mb-2">
                    <Key className="h-4 w-4" />
                    <span className="font-medium">{t('connectionDialog.securityNote.title')}</span>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {config.authMethod === 'password' ? (
                      <>{t('connectionDialog.securityNote.password')}</>
                    ) : config.authMethod === 'anonymous' ? (
                      <>{t('connectionDialog.securityNote.anonymous')}</>
                    ) : (
                      <>{t('connectionDialog.securityNote.publicKey')}</>
                    )}
                  </p>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="proxy" className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-4 mt-0">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Network className="h-4 w-4" />
                  {t('connectionDialog.section.proxySettings')}
                </CardTitle>
                <CardDescription>
                  {t('connectionDialog.section.proxySettingsDesc')}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>{t('connectionDialog.label.proxyType')}</Label>
                  <Select
                    value={config.proxyType}
                    onValueChange={(value: string) => updateConfig({ proxyType: value as ConnectionConfig['proxyType'] })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">{t('connectionDialog.proxy.noProxy')}</SelectItem>
                      <SelectItem value="http">{t('connectionDialog.proxy.httpProxy')}</SelectItem>
                      <SelectItem value="socks4">{t('connectionDialog.proxy.socks4')}</SelectItem>
                      <SelectItem value="socks5">{t('connectionDialog.proxy.socks5')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {config.proxyType !== 'none' && (
                  <>
                    <div className="grid grid-cols-3 gap-4">
                      <div className="col-span-2 space-y-2">
                        <Label htmlFor="proxy-host">{t('connectionDialog.label.proxyHost')}</Label>
                        <Input
                          id="proxy-host"
                          placeholder={t('connectionDialog.placeholder.proxyHost')}
                          value={config.proxyHost}
                          onChange={(e) => updateConfig({ proxyHost: e.target.value })}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="proxy-port">{t('connectionDialog.label.proxyPort')}</Label>
                        <Input
                          id="proxy-port"
                          type="number"
                          value={displayValues.proxyPort}
                          onChange={(e) => handleNumberInput('proxyPort', e.target.value, (n) => updateConfig({ proxyPort: n }))}
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="proxy-username">{t('connectionDialog.label.proxyUsername')}</Label>
                        <Input
                          id="proxy-username"
                          placeholder={t('connectionDialog.placeholder.proxyUsername')}
                          value={config.proxyUsername}
                          onChange={(e) => updateConfig({ proxyUsername: e.target.value })}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="proxy-password">{t('connectionDialog.label.proxyPassword')}</Label>
                        <PasswordInput
                          id="proxy-password"
                          placeholder={t('connectionDialog.placeholder.proxyPassword')}
                          value={config.proxyPassword}
                          onChange={(e) => updateConfig({ proxyPassword: e.target.value })}
                        />
                      </div>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>

            {(config.protocol === 'SSH' || config.protocol === 'SFTP') && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Network className="h-4 w-4" />
                    {t('connectionDialog.section.jumpSettings')}
                  </CardTitle>
                  <CardDescription>
                    {t('connectionDialog.section.jumpSettingsDesc')}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center justify-between gap-4">
                    <div className="space-y-1">
                      <Label>{t('connectionDialog.label.jumpEnabled')}</Label>
                      <p className="text-xs text-muted-foreground">
                        {t('connectionDialog.section.jumpEnabledHint')}
                      </p>
                    </div>
                    <Switch
                      checked={jumpEnabled}
                      onCheckedChange={(checked) => {
                        setJumpEnabled(checked);
                        if (!checked) {
                          updateConfig({
                            jumpHost: '',
                            jumpPort: 22,
                            jumpUsername: '',
                            jumpPassword: '',
                            jumpUseKey: false,
                          });
                        }
                      }}
                    />
                  </div>

                  {jumpEnabled && (
                    <>
                      <div className="grid grid-cols-3 gap-4">
                        <div className="col-span-2 space-y-2">
                          <Label htmlFor="jump-host">{t('connectionDialog.label.jumpHost')}</Label>
                          <Input
                            id="jump-host"
                            placeholder={t('connectionDialog.placeholder.jumpHost')}
                            value={config.jumpHost}
                            disabled={!!jumpServerId}
                            onChange={(e) => updateConfig({ jumpHost: e.target.value, jumpHostKeyFingerprint: undefined })}
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="jump-port">{t('connectionDialog.label.jumpPort')}</Label>
                          <Input
                            id="jump-port"
                            type="number"
                            value={displayValues.jumpPort}
                            disabled={!!jumpServerId}
                            onChange={(e) => handleNumberInput('jumpPort', e.target.value, (n) => updateConfig({ jumpPort: n, jumpHostKeyFingerprint: undefined }))}
                          />
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label htmlFor="jump-username">{t('connectionDialog.label.jumpUsername')}</Label>
                          <Input
                            id="jump-username"
                            placeholder={t('connectionDialog.placeholder.jumpUsername')}
                            value={config.jumpUsername}
                            disabled={!!jumpServerId}
                            onChange={(e) => updateConfig({ jumpUsername: e.target.value })}
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="jump-password">{t('connectionDialog.label.jumpPassword')}</Label>
                          <PasswordInput
                            id="jump-password"
                            placeholder={t('connectionDialog.placeholder.jumpPassword')}
                            value={config.jumpPassword}
                            disabled={!!jumpServerId || !!config.jumpUseKey}
                            onChange={(e) => updateConfig({ jumpPassword: e.target.value })}
                          />
                        </div>
                      </div>

                      <div className="flex items-center justify-between pt-1">
                        <div className="flex items-center space-x-2">
                          <Checkbox
                            id="jump-use-key"
                            checked={!!config.jumpUseKey}
                            disabled={!!jumpServerId}
                            onCheckedChange={(checked) => updateConfig({ jumpUseKey: checked === true })}
                          />
                          <Label htmlFor="jump-use-key" className="text-sm font-normal">
                            {t('connectionDialog.label.jumpUseKey')}
                          </Label>
                        </div>
                        <div className="flex items-center gap-1.5">
                          {jumpServerId && (
                            <>
                              <span className="text-[10px] text-muted-foreground">
                                {t('connectionDialog.label.jumpFromServer')}:{' '}
                                {jumpCandidates.find((s) => s.id === jumpServerId)?.name ?? ''}
                              </span>
                              <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={clearJumpServer}>
                                {t('connectionDialog.label.jumpClearServer')}
                              </Button>
                            </>
                          )}
                          <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button size="sm" variant="outline" className="h-7 gap-1 text-xs">
                              <ServerCog className="h-3.5 w-3.5" />
                              {t('connectionDialog.label.jumpPickFromServers')}
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="max-h-64 overflow-y-auto w-64">
                            {jumpCandidates.length === 0 ? (
                              <DropdownMenuItem disabled className="text-xs text-muted-foreground">
                                {t('connectionDialog.noSavedServers')}
                              </DropdownMenuItem>
                            ) : (
                              jumpCandidates.map((s) => (
                                <DropdownMenuItem
                                  key={s.id}
                                  onClick={() => applyJumpFromServer(s)}
                                  className="flex items-start gap-2"
                                >
                                  <Server className="h-3.5 w-3.5 mt-0.5 shrink-0 text-muted-foreground" />
                                  <span className="flex-1 min-w-0">
                                    <span className="block truncate text-xs font-medium">{s.name}</span>
                                    <span className="block truncate text-[10px] font-mono text-muted-foreground">
                                      {s.username ? `${s.username}@` : ''}{s.host}:{s.port}
                                    </span>
                                  </span>
                                </DropdownMenuItem>
                              ))
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>
            )}
          </TabsContent>

          <TabsContent value="advanced" className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-4 mt-0">
            {(() => {
              const hiddenFields = getHiddenFields(config.protocol);
               const isKaHidden = hiddenFields.includes('keepAliveInterval');

               if (isKaHidden) {
                return (
                  <Card>
                    <CardHeader>
                      <CardTitle className="flex items-center gap-2">
                        <TerminalIcon className="h-4 w-4" />
                        {t('connectionDialog.section.advancedOptions')}
                      </CardTitle>
                      <CardDescription>
                        {t('connectionDialog.section.noAdvancedOptions', { protocol: config.protocol })}
                      </CardDescription>
                    </CardHeader>
                  </Card>
                );
              }

              return (
                <Card>
                  <CardHeader>
                      <CardTitle className="flex items-center gap-2">
                        <TerminalIcon className="h-4 w-4" />
                        {t('connectionDialog.section.advancedSsh')}
                      </CardTitle>
                      <CardDescription>
                        {t('connectionDialog.section.advancedSshDesc')}
                      </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="space-y-4">
                      {!isKaHidden && (
                        <>
                          <div className="flex items-center justify-between">
                            <div className="space-y-0.5">
                              <Label>{t('connectionDialog.advanced.keepAlive')}</Label>
                              <p className="text-sm text-muted-foreground">
                                {t('connectionDialog.advanced.keepAliveDesc')}
                              </p>
                            </div>
                            <Switch
                              checked={config.keepAlive}
                              onCheckedChange={(checked) => updateConfig({ keepAlive: checked })}
                            />
                          </div>

                          {config.keepAlive && (
                            <div className="grid grid-cols-2 gap-4 ml-4">
                              <div className="space-y-2">
                                <Label htmlFor="keep-alive-interval">{t('connectionDialog.label.keepAliveInterval')}</Label>
                                <Input
                                  id="keep-alive-interval"
                                  type="number"
                                  value={displayValues.keepAliveInterval}
                                  onChange={(e) => handleNumberInput('keepAliveInterval', e.target.value, (n) => updateConfig({ keepAliveInterval: n }))}
                                />
                              </div>
                              <div className="space-y-2">
                                <Label htmlFor="max-count">{t('connectionDialog.label.maxCount')}</Label>
                                <Input
                                  id="max-count"
                                  type="number"
                                  value={displayValues.serverAliveCountMax}
                                  onChange={(e) => handleNumberInput('serverAliveCountMax', e.target.value, (n) => updateConfig({ serverAliveCountMax: n }))}
                                />
                              </div>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })()}
          </TabsContent>


        </Tabs>

        <DialogFooter className="px-6 py-4 border-t bg-muted/30 flex-col sm:flex-col">
          <div className="flex flex-col gap-3 w-full">
            {/* Save as Connection Option - Only show for new connections */}
            {!editingConnection && (
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Switch
                    id="save-connection"
                    checked={saveAsConnection}
                    onCheckedChange={setSaveAsConnection}
                  />
                  <Label htmlFor="save-connection" className="text-sm cursor-pointer">
                    {t('connectionDialog.saveAsConnection')}
                  </Label>
                </div>
                {saveAsConnection && (
                  <Select value={connectionFolder} onValueChange={setConnectionFolder}>
                      <SelectTrigger className="w-[200px] h-8" data-testid="connection-folder-select">
                        <SelectValue placeholder={t('connectionDialog.selectFolder')} />
                    </SelectTrigger>
                    <SelectContent>
                      {availableFolders.length > 0 ? (
                        availableFolders.map((folder) => (
                          <SelectItem key={folder} value={folder}>
                            {folder}
                          </SelectItem>
                        ))
                      ) : (
                        <SelectItem value="All Connections">{t('connectionDialog.allConnections')}</SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                )}
              </div>
            )}

            {/* Action Buttons */}
            <div className="flex justify-end gap-2">
              <Button
                variant={isConnecting ? "destructive" : "outline"}
                onClick={handleCancelConnectionAttempt}
                disabled={isCancelling}
              >
                {isConnecting ? (isCancelling ? t('connectionDialog.button.cancelling') : t('connectionDialog.button.stop')) : t('connectionDialog.button.cancel')}
              </Button>
              {editingConnection ? (
                <Button onClick={handleSave} className="min-w-[140px]">
                  {t('connectionDialog.button.save')}
                </Button>
              ) : (
                <Button onClick={handleConnect} disabled={isConnecting || isCancelling} className="min-w-[140px]">
                  {isConnecting ? t('connectionDialog.button.connecting') : t('connectionDialog.button.connect')}
                </Button>
              )}
            </div>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={hostKeyPrompt !== null} onOpenChange={(isOpen) => !isOpen && resolveHostKeyPrompt(false)}>
      <DialogContent className="!inset-0 !m-auto !translate-x-0 !translate-y-0 w-[520px] max-w-[90vw] max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Shield className="h-5 w-5 text-amber-500" />{t('common.confirm')}</DialogTitle>
          <DialogDescription className="whitespace-pre-line break-words font-mono text-xs leading-5">{hostKeyPrompt}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => resolveHostKeyPrompt(false)}>{t('common.cancel')}</Button>
          <Button onClick={() => resolveHostKeyPrompt(true)}>{t('common.confirm')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}
