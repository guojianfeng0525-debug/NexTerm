import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { PasswordInput } from '@/components/ui/password-input';
import {
  hydrateAppLockMeta,
  isAppLockConfigured,
  setupAppLock,
  verifyAppLock,
} from '@/lib/toolbox/app-lock';
import { Terminal, ShieldCheck, Loader2 } from 'lucide-react';

interface AppLockScreenProps {
  /** Called after the password is verified (or set on first run). */
  onUnlock: () => void;
}

/**
 * Full-screen startup gate. Rendered instead of the entire application UI:
 * until the password is verified, no menu bar, directory bar, workspace or
 * status bar is shown.
 */
export function AppLockScreen({ onUnlock }: AppLockScreenProps) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<'setup' | 'unlock' | 'loading'>('loading');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Resolve whether a password is configured (SQLite-backed, async).
  useEffect(() => {
    let cancelled = false;
    void hydrateAppLockMeta().then(() => {
      if (cancelled) return;
      setMode(isAppLockConfigured() ? 'unlock' : 'setup');
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Focus the password field once the screen appears.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      document.getElementById('app-lock-password')?.focus();
    }, 50);
    return () => window.clearTimeout(timer);
  }, []);

  const handleSubmit = useCallback(async () => {
    if (mode === 'loading') return;
    setError(null);
    if (!password) {
      setError(t('appLock.enterPassword'));
      return;
    }
    if (mode === 'setup') {
      if (password.length < 4) {
        setError(t('appLock.passwordTooShort'));
        return;
      }
      if (password !== confirm) {
        setError(t('appLock.passwordMismatch'));
        return;
      }
      setBusy(true);
      try {
        await setupAppLock(password);
        onUnlock();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
      return;
    }
    setBusy(true);
    try {
      const ok = await verifyAppLock(password);
      if (ok) {
        onUnlock();
      } else {
        setError(t('appLock.wrongPassword'));
        setPassword('');
      }
    } finally {
      setBusy(false);
    }
  }, [password, confirm, mode, onUnlock, t]);

  const isSetup = mode === 'setup';
  const isLoading = mode === 'loading';

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background p-6">
      <div className="w-full max-w-sm space-y-6 animate-in fade-in duration-300">
        {/* Brand */}
        <div className="text-center space-y-3">
          <div className="mx-auto w-16 h-16 rounded-2xl bg-primary/10 border border-primary/20 text-primary flex items-center justify-center">
            <Terminal className="h-8 w-8" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-foreground">
              {t('app.title')}
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              {isLoading
                ? t('appLock.loading')
                : isSetup
                  ? t('appLock.setupDesc')
                  : t('appLock.unlockDesc')}
            </p>
          </div>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        ) : (
          <div className="rounded-xl border border-border bg-card p-5 space-y-4 shadow-sm">
            <div className="flex items-center gap-2 justify-center text-xs text-muted-foreground">
              <ShieldCheck className="h-3.5 w-3.5 text-success" />
              {t('appLock.encryptedNote')}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="app-lock-password">
                {isSetup ? t('appLock.newPassword') : t('appLock.password')}
              </Label>
              <PasswordInput
                id="app-lock-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleSubmit();
                }}
                placeholder="••••••••"
                autoComplete="off"
              />
            </div>

            {isSetup && (
              <div className="space-y-1.5">
                <Label htmlFor="app-lock-confirm">{t('appLock.confirmPassword')}</Label>
                <PasswordInput
                  id="app-lock-confirm"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleSubmit();
                  }}
                  placeholder="••••••••"
                  autoComplete="off"
                />
              </div>
            )}

            {error && <p className="text-xs text-destructive">{error}</p>}

            <Button
              data-testid="app-lock-submit"
              className="w-full gap-1.5"
              disabled={busy}
              onClick={() => void handleSubmit()}
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ShieldCheck className="h-4 w-4" />
              )}
              {isSetup ? t('appLock.setup') : t('appLock.unlock')}
            </Button>
          </div>
        )}

        <p className="text-center text-[11px] text-muted-foreground leading-relaxed">
          {t('appLock.securityNote')}
        </p>
      </div>
    </div>
  );
}
