import React, { useRef, useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { readText as readClipboardText, writeText as writeClipboardText } from '@tauri-apps/plugin-clipboard-manager';
import { toast } from 'sonner';
import { DesktopToolbar } from './desktop-toolbar';
import {
  computeFitScale,
  resolveCapsLockState,
  translateCoordinates,
} from '@/lib/desktop-utils';
import { drawFrameUpdate, parseDesktopFrame } from '@/lib/desktop-frame';
import { Monitor, RefreshCw } from 'lucide-react';
import { Button } from './ui/button';

interface DesktopViewerProps {
  connectionId: string;
  connectionName: string;
  host?: string;
  protocol?: string;
  isConnected: boolean;
  onReconnect?: () => void;
}

export function DesktopViewer({
  connectionId,
  connectionName,
  host,
  protocol = 'RDP',
  isConnected,
  onReconnect,
}: DesktopViewerProps) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const pressedKeysRef = useRef(new Set<number>());

  const [desktopWidth, setDesktopWidth] = useState(1024);
  const [desktopHeight, setDesktopHeight] = useState(768);
  const [scalingMode, setScalingMode] = useState<'fit' | 'native'>('fit');
  const [isFullScreen, setIsFullScreen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [sessionEnded, setSessionEnded] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  // Calculate displayed dimensions
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerSize({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // WebSocket connection for receiving frame updates and clipboard data from remote
  useEffect(() => {
    if (!isConnected) return;

    let ws: WebSocket | null = null;
    let cancelled = false;

    const connect = async () => {
      let wsPort = 9001;
      try {
        wsPort = await invoke<number>('get_websocket_port');
      } catch {
        // fallback to default
      }

      if (cancelled) return;
      setSessionEnded(false);

      ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onopen = () => {
        // Send StartDesktop to initiate the desktop streaming session
        ws?.send(JSON.stringify({
          type: 'StartDesktop',
          connection_id: connectionId,
        }));
      };

      ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          // Binary desktop framebuffer update.
          const frame = parseDesktopFrame(event.data);
          if (!frame || frame.connectionId !== connectionId) return;
          const canvas = canvasRef.current;
          const ctx = canvas?.getContext('2d');
          if (!ctx) return;
          drawFrameUpdate(ctx, frame);
          setIsLoading(false);
          return;
        }

        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'DesktopStarted' && msg.connection_id === connectionId) {
            if (typeof msg.width === 'number' && msg.width > 0) setDesktopWidth(msg.width);
            if (typeof msg.height === 'number' && msg.height > 0) setDesktopHeight(msg.height);
            setIsLoading(false);
            setSessionEnded(false);
          } else if (msg.type === 'ClipboardUpdate' && msg.connection_id === connectionId) {
            // Write incoming remote clipboard text to local clipboard
            writeClipboardText(msg.text).catch(() => {
              // Clipboard write denied — silently ignore
            });
          } else if (msg.type === 'Error') {
            setSessionEnded(true);
            toast.error(t('desktopViewer.sessionEnded'), {
              description: String(msg.message ?? ''),
            });
          }
        } catch {
          // Not JSON and not binary — ignore.
        }
      };

      ws.onclose = () => {
        wsRef.current = null;
        setSessionEnded(true);
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'CloseDesktop',
          connection_id: connectionId,
        }));
      }
      if (
        ws &&
        (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
      ) {
        ws.onmessage = null;
        ws.onclose = null;
        ws.onerror = null;
        ws.close();
      }
      wsRef.current = null;
    };
  }, [connectionId, isConnected]);

  // For RDP sessions: debounce container resize and notify the remote host
  useEffect(() => {
    if (!isConnected || protocol?.toUpperCase() !== 'RDP') return;
    if (scalingMode !== 'fit') return;
    if (containerSize.width === 0 || containerSize.height === 0) return;

    const timer = setTimeout(() => {
      invoke('desktop_resize', {
        connectionId,
        width: Math.round(containerSize.width),
        height: Math.round(containerSize.height),
      }).catch(() => {
        // Server rejected resize — keep current resolution and scale client-side
      });
    }, 500); // 500ms debounce

    return () => clearTimeout(timer);
  }, [connectionId, isConnected, protocol, scalingMode, containerSize.width, containerSize.height]);

  const scale = scalingMode === 'fit'
    ? computeFitScale(desktopWidth, desktopHeight, containerSize.width, containerSize.height)
    : 1;
  const displayedWidth = desktopWidth * scale;
  const displayedHeight = desktopHeight * scale;

  // Handle keyboard events — forward to backend
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!isConnected) return;

    // Intercept Ctrl+V for clipboard paste: read local clipboard and send to remote
    if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
      e.preventDefault();
      readClipboardText().then((text) => {
        if (text) {
          invoke('desktop_set_clipboard', { connectionId, text }).catch(() => {});
        }
      }).catch(() => {
        toast.info(t('desktopViewer.clipboardAccessDenied'), {
          description: t('desktopViewer.clipboardAccessDeniedDesc'),
        });
      });
      return;
    }

    e.preventDefault();
    pressedKeysRef.current.add(e.keyCode);
    invoke('desktop_send_key', {
      connectionId,
      keyCode: e.keyCode,
      down: true,
      // Toggle states let the backend mirror CapsLock/NumLock to the host.
      // Letters carry the authoritative CapsLock result on Windows WebViews,
      // whose lock-state report can lag behind the physical toggle.
      capsLock: resolveCapsLockState(e),
      numLock: e.getModifierState('NumLock'),
    }).catch(() => {/* ignore errors for input events */});
  }, [connectionId, isConnected]);

  const handleKeyUp = useCallback((e: React.KeyboardEvent) => {
    if (!isConnected) return;
    e.preventDefault();
    pressedKeysRef.current.delete(e.keyCode);
    invoke('desktop_send_key', {
      connectionId,
      keyCode: e.keyCode,
      down: false,
      capsLock: resolveCapsLockState(e),
      numLock: e.getModifierState('NumLock'),
    }).catch(() => {});
  }, [connectionId, isConnected]);

  // Release all keys on blur
  const handleBlur = useCallback(() => {
    for (const keyCode of pressedKeysRef.current) {
      invoke('desktop_send_key', {
        connectionId,
        keyCode,
        down: false,
      }).catch(() => {});
    }
    pressedKeysRef.current.clear();
  }, [connectionId]);

  // Handle mouse events
  const getRemoteCoords = useCallback((e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return translateCoordinates(
      e.clientX - rect.left,
      e.clientY - rect.top,
      desktopWidth,
      desktopHeight,
      displayedWidth,
      displayedHeight,
    );
  }, [desktopWidth, desktopHeight, displayedWidth, displayedHeight]);

  const sendPointer = useCallback((e: React.MouseEvent, buttons: number) => {
    if (!isConnected) return;
    const { x, y } = getRemoteCoords(e);
    invoke('desktop_send_pointer', {
      connectionId,
      x,
      y,
      buttonMask: buttons,
    }).catch(() => {});
  }, [connectionId, isConnected, getRemoteCoords]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    sendPointer(e, e.buttons);
  }, [sendPointer]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    sendPointer(e, e.buttons);
  }, [sendPointer]);

  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    sendPointer(e, 0);
  }, [sendPointer]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (!isConnected) return;
    const { x, y } = getRemoteCoords(e);
    // Keep currently-pressed buttons; wheel up = 0x08, wheel down = 0x10.
    const buttonMask = (e.buttons & 0x07) | (e.deltaY < 0 ? 0x08 : 0x10);
    invoke('desktop_send_pointer', {
      connectionId,
      x,
      y,
      buttonMask,
    }).catch(() => {});
  }, [connectionId, isConnected, getRemoteCoords]);

  // Toolbar actions
  const handleToggleScaling = useCallback(() => {
    setScalingMode(prev => prev === 'fit' ? 'native' : 'fit');
  }, []);

  const handleSendCtrlAltDel = useCallback(() => {
    if (!isConnected) return;
    // Send Ctrl down, Alt down, Del down, then release in reverse
    const keys = [
      { keyCode: 17, down: true },  // Ctrl down
      { keyCode: 18, down: true },  // Alt down
      { keyCode: 46, down: true },  // Del down
      { keyCode: 46, down: false }, // Del up
      { keyCode: 18, down: false }, // Alt up
      { keyCode: 17, down: false }, // Ctrl up
    ];
    for (const key of keys) {
      invoke('desktop_send_key', {
        connectionId,
        keyCode: key.keyCode,
        down: key.down,
      }).catch(() => {});
    }
  }, [connectionId, isConnected]);

  const handleToggleFullScreen = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    if (!isFullScreen) {
      container.requestFullscreen?.().catch(() => {
        toast.error(t('desktopViewer.failedToEnterFullScreen'));
      });
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  }, [isFullScreen]);

  useEffect(() => {
    const handleFullScreenChange = () => {
      setIsFullScreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', handleFullScreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullScreenChange);
  }, []);

  const handleDisconnect = useCallback(() => {
    invoke('desktop_disconnect', { connectionId }).catch((err) => {
      toast.error(t('desktopViewer.failedToDisconnect'), {
        description: String(err),
      });
    });
  }, [connectionId]);

  // Disconnected state
  if (!isConnected || sessionEnded) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-muted/30">
        <div className="text-center space-y-4">
          <Monitor className="h-12 w-12 mx-auto text-muted-foreground/50" />
          <div>
            <p className="text-lg font-medium text-muted-foreground">
              {t('desktopViewer.desktopDisconnected')}
            </p>
            <p className="text-sm text-muted-foreground/70">
              {connectionName} ({host})
            </p>
          </div>
          {onReconnect && (
            <Button variant="outline" onClick={onReconnect}>
              <RefreshCw className="h-4 w-4 mr-2" />
              {t('desktopViewer.reconnect')}
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="h-full w-full relative bg-black focus:outline-none"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      onBlur={handleBlur}
    >
      <DesktopToolbar
        protocol={protocol}
        scalingMode={scalingMode}
        isFullScreen={isFullScreen}
        onToggleScalingMode={handleToggleScaling}
        onSendCtrlAltDel={handleSendCtrlAltDel}
        onToggleFullScreen={handleToggleFullScreen}
        onDisconnect={handleDisconnect}
      />

      {/* Loading overlay */}
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/80 z-40">
          <div className="text-center space-y-3">
            <Monitor className="h-10 w-10 mx-auto text-primary animate-pulse" />
            <div>
              <p className="text-sm font-medium">{t('desktopViewer.connectingTo', { name: connectionName })}</p>
              <p className="text-xs text-muted-foreground">{protocol} • {host}</p>
            </div>
          </div>
        </div>
      )}

      {/* Canvas */}
      <div className={`h-full w-full flex items-center justify-center ${
        scalingMode === 'native' ? 'overflow-auto' : 'overflow-hidden'
      }`}>
        <canvas
          ref={canvasRef}
          width={desktopWidth}
          height={desktopHeight}
          className="block"
          style={{
            width: displayedWidth,
            height: displayedHeight,
            imageRendering: scalingMode === 'native' ? 'auto' : 'auto',
          }}
          onMouseMove={handleMouseMove}
          onMouseDown={handleMouseDown}
          onMouseUp={handleMouseUp}
          onWheel={handleWheel}
          onContextMenu={(e) => e.preventDefault()}
        />
      </div>
    </div>
  );
}
