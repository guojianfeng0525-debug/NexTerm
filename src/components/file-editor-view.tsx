import { useState, useEffect, useCallback, useRef, lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { Save, RefreshCw, FileWarning, ExternalLink, Image as ImageIcon, FileArchive, Download } from "lucide-react";
import { Button } from "./ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
const CodeEditor = lazy(() => import("./code-editor").then((m) => ({ default: m.CodeEditor })));
import { classifyFileByExtension, type FileViewKind } from "@/lib/editor-config";

interface Base64FileResponse {
  data: string;
  size: number;
  mime_type: string;
}

interface FileEditorViewProps {
  /** SSH connection ID used to read/write the file */
  connectionId: string;
  /** Remote file path */
  filePath: string;
  /** Display name shown in the header */
  fileName: string;
  /** Whether the underlying SSH connection is alive */
  isConnected: boolean;
}

const TEXT_ENCODINGS = [
  { value: "utf-8", label: "UTF-8" },
  { value: "gbk", label: "GBK" },
  { value: "gb18030", label: "GB18030" },
  { value: "big5", label: "Big5" },
  { value: "shift_jis", label: "Shift_JIS" },
  { value: "euc-jp", label: "EUC-JP" },
  { value: "euc-kr", label: "EUC-KR" },
  { value: "windows-1252", label: "Windows-1252" },
  { value: "iso-8859-1", label: "ISO-8859-1" },
];

interface EncodedFileContent {
  content: string;
  hadErrors: boolean;
}

export function FileEditorView({
  connectionId,
  filePath,
  fileName,
  isConnected,
}: FileEditorViewProps) {
  const { t } = useTranslation();
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [encoding, setEncoding] = useState("utf-8");
  const [savedEncoding, setSavedEncoding] = useState("utf-8");
  const [decodeHadErrors, setDecodeHadErrors] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = content !== savedContent || encoding !== savedEncoding;
  const contentRef = useRef(content);
  contentRef.current = content;
  const savedContentRef = useRef(savedContent);
  savedContentRef.current = savedContent;
  const encodingRef = useRef(encoding);
  encodingRef.current = encoding;

  // File-type classification
  const fileKind: FileViewKind = classifyFileByExtension(fileName);

  // Image preview state
  const [imageDataUri, setImageDataUri] = useState<string | null>(null);
  const [imageLoading, setImageLoading] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);

  // Download-to-open state (for binary/image files)
  const [downloading, setDownloading] = useState(false);

  const readTextFile = useCallback(async (encodingToLoad: string) => {
    const response = await invoke<EncodedFileContent>(
      "read_file_content_with_encoding",
      {
        connectionId,
        path: filePath,
        encoding: encodingToLoad,
      },
    );
    return response;
  }, [connectionId, filePath]);

  const loadFile = useCallback(async (encodingOverride?: string) => {
    if (fileKind === "text") {
      const encodingToLoad = encodingOverride ?? encodingRef.current;
      setLoading(true);
      setError(null);
      try {
        const response = await readTextFile(encodingToLoad);
        setContent(response.content);
        setSavedContent(response.content);
        setEncoding(encodingToLoad);
        setSavedEncoding(encodingToLoad);
        setDecodeHadErrors(response.hadErrors);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        toast.error(t('fileEditorView.failedToLoad'), { description: msg });
      } finally {
        setLoading(false);
      }
    } else if (fileKind === "image") {
      setImageLoading(true);
      setImageError(null);
      try {
        const resp = await invoke<Base64FileResponse>("read_remote_file_base64", {
          connectionId,
          path: filePath,
        });
        setImageDataUri(`data:${resp.mime_type};base64,${resp.data}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setImageError(msg);
      } finally {
        setImageLoading(false);
      }
    }
    // For "binary" kind, no remote loading needed
  }, [fileKind, readTextFile]);

  useEffect(() => {
    if (isConnected) {
      void loadFile();
    }
  }, [isConnected, loadFile]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await invoke<boolean>("create_file_with_encoding", {
        connectionId,
        path: filePath,
        content: contentRef.current,
        encoding: encodingRef.current,
      });
      setSavedContent(contentRef.current);
      setSavedEncoding(encodingRef.current);
      setDecodeHadErrors(false);
      toast.success(t('fileEditorView.fileSaved', {
        fileName,
        encoding: encodingRef.current,
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(t('fileEditorView.failedToSave'), { description: msg });
    } finally {
      setSaving(false);
    }
  }, [connectionId, filePath, fileName, t]);

  const handleEncodingChange = useCallback(async (nextEncoding: string) => {
    if (fileKind !== "text" || nextEncoding === encodingRef.current) return;

    // With unsaved edits, changing the selector means "encode the edited text
    // as this format on the next save". With a clean buffer, it reloads and
    // decodes the same remote bytes using the newly selected format.
    if (contentRef.current !== savedContentRef.current) {
      setEncoding(nextEncoding);
      setDecodeHadErrors(false);
      return;
    }

    const previousEncoding = encodingRef.current;
    setEncoding(nextEncoding);
    setLoading(true);
    setError(null);
    try {
      const response = await readTextFile(nextEncoding);
      setContent(response.content);
      setSavedContent(response.content);
      setSavedEncoding(nextEncoding);
      setDecodeHadErrors(response.hadErrors);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setEncoding(previousEncoding);
      setError(msg);
      toast.error(t('fileEditorView.failedToLoad'), { description: msg });
    } finally {
      setLoading(false);
    }
  }, [fileKind, readTextFile, t]);

  // Download to temp directory and open with OS default app
  const handleDownloadAndOpen = useCallback(async () => {
    setDownloading(true);
    try {
      // Use the user's home directory as a base for the temp download
      const homeDir = await invoke<string>("get_home_directory");
      const localPath = `${homeDir}/.nexterm-preview-${fileName}`;
      const result = await invoke<{ success: boolean; error?: string }>(
        "download_remote_file",
        { connectionId, remotePath: filePath, localPath },
      );
      if (!result.success) {
        throw new Error(result.error ?? "Download failed");
      }
      await invoke<void>("open_in_os", { path: localPath });
      toast.success(t('fileEditorView.openedWithOs', { fileName }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(t('fileEditorView.failedToOpenWithOs'), { description: msg });
    } finally {
      setDownloading(false);
    }
  }, [connectionId, filePath, fileName]);

  // Ctrl+S / Cmd+S to save (only for text files)
  useEffect(() => {
    if (fileKind !== "text") return;
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        void handleSave();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleSave, fileKind]);

  // ---------- Shared header toolbar ----------
  const renderToolbar = (showSaveButton: boolean) => (
    <div className="flex items-center gap-2 px-2 py-1 border-b bg-muted/30 text-xs shrink-0">
      <span className="font-mono text-muted-foreground truncate flex-1" title={filePath}>
        {filePath}
      </span>
      {showSaveButton && (
        <Select
          value={encoding}
          onValueChange={(value) => void handleEncodingChange(value)}
        >
          <SelectTrigger
            data-testid="file-editor-encoding"
            className="h-6 w-[132px] text-[11px]"
            aria-label={t('fileEditorView.encodingLabel')}
            title={t('fileEditorView.encodingTooltip')}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-h-64">
            {TEXT_ENCODINGS.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {showSaveButton && dirty && (
        <span className="text-yellow-500 text-[10px] font-medium">{t('fileEditorView.modified')}</span>
      )}
      {showSaveButton && decodeHadErrors && (
        <span
          className="text-orange-500 text-[10px] font-medium"
          title={t('fileEditorView.decodeReplacements')}
        >
          {t('fileEditorView.decodeReplacements')}
        </span>
      )}
      <Button
        variant="ghost"
        size="sm"
        className="h-6 px-2"
        onClick={() => void loadFile()}
        disabled={loading || imageLoading}
        title={t('fileEditorView.reload')}
      >
        <RefreshCw className={`h-3.5 w-3.5 ${(loading || imageLoading) ? "animate-spin" : ""}`} />
      </Button>
      {showSaveButton && (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2"
          onClick={handleSave}
          disabled={saving || !dirty}
          title={t('fileEditorView.saveTooltip')}
        >
          <Save className="h-3.5 w-3.5 mr-1" />
          {t('fileEditorView.save')}
        </Button>
      )}
    </div>
  );

  // ---------- Render: Image preview ----------
  if (fileKind === "image") {
    if (!isConnected) {
      return (
        <div className="h-full flex items-center justify-center text-muted-foreground">
          <FileWarning className="h-8 w-8 mr-3 opacity-50" />
          <span>{t('fileEditorView.connectionLost')}</span>
        </div>
      );
    }
    return (
      <div className="h-full flex flex-col bg-background">
        {renderToolbar(false)}
        <div className="flex-1 min-h-0 flex flex-col items-center justify-center overflow-auto p-4 gap-4">
          {imageLoading && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <RefreshCw className="h-5 w-5 animate-spin" />
              {t('fileEditorView.loading', { fileName })}
            </div>
          )}
          {imageError && (
            <div className="flex flex-col items-center gap-3 text-muted-foreground">
              <ImageIcon className="h-10 w-10 opacity-50" />
              <p className="text-sm">{t('fileEditorView.imagePreviewFailed')}</p>
              <p className="text-xs text-muted-foreground/70 max-w-md text-center">{imageError}</p>
            </div>
          )}
          {!imageLoading && !imageError && imageDataUri && (
            <img
              src={imageDataUri}
              alt={fileName}
              className="max-w-full max-h-[70vh] object-contain rounded shadow-lg"
            />
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={handleDownloadAndOpen}
            disabled={downloading}
            className="gap-2"
          >
            {downloading ? (
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
            {downloading
              ? t('fileEditorView.downloading')
              : t('fileEditorView.downloadAndOpen')}
          </Button>
        </div>
      </div>
    );
  }

  // ---------- Render: Binary / non-text file ----------
  if (fileKind === "binary") {
    return (
      <div className="h-full flex flex-col bg-background">
        {renderToolbar(false)}
        <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-4 p-6">
          <FileArchive className="h-16 w-16 text-muted-foreground/40" />
          <div className="text-center space-y-2">
            <p className="text-sm font-medium">{t('fileEditorView.binaryFileTitle')}</p>
            <p className="text-xs text-muted-foreground max-w-sm">
              {t('fileEditorView.binaryFileDesc', { fileName })}
            </p>
          </div>
          <Button
            variant="default"
            size="sm"
            onClick={handleDownloadAndOpen}
            disabled={downloading}
            className="gap-2"
          >
            {downloading ? (
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ExternalLink className="h-3.5 w-3.5" />
            )}
            {downloading
              ? t('fileEditorView.downloading')
              : t('fileEditorView.downloadAndOpen')}
          </Button>
        </div>
      </div>
    );
  }

  // ---------- Render: Text file (original editor) ----------
  if (!isConnected) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">
        <FileWarning className="h-8 w-8 mr-3 opacity-50" />
        <span>{t('fileEditorView.connectionLost')}</span>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">
        <RefreshCw className="h-5 w-5 animate-spin mr-2" />
        {t('fileEditorView.loading', { fileName })}
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-muted-foreground gap-3">
        <FileWarning className="h-8 w-8 opacity-50" />
        <span>{t('fileEditorView.failedToLoadError', { error })}</span>
          <Button variant="outline" size="sm" onClick={() => void loadFile()}>
          <RefreshCw className="h-4 w-4 mr-1" /> {t('fileEditorView.retry')}
        </Button>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-background">
      {renderToolbar(true)}
      {/* Editor */}
      <div className="flex-1 min-h-0">
        <Suspense fallback={<div className="h-full flex items-center justify-center text-xs text-muted-foreground">{'...'}</div>}>
          <CodeEditor
            value={content}
            onChange={setContent}
            filename={fileName}
          />
        </Suspense>
      </div>
    </div>
  );
}
