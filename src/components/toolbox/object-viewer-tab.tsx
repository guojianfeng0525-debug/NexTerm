import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { Loader2, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { CodeEditor } from "@/components/code-editor";
import type { PostgresObjectReference } from "@/lib/database/postgresql-object-loader";

export interface ObjectViewerTabState {
  readonly id: string;
  readonly type: "object";
  readonly title: string;
  readonly object: PostgresObjectReference;
  readonly connectionId: string;
  readonly dirty?: boolean;
}

interface ObjectPropsResponse {
  readonly props: { readonly key: string; readonly value: string }[];
  readonly ddl: string | null;
  readonly truncated: boolean;
}

/**
 * Read-only object viewer tab (B21 D-B21-2 / D-B21-7): shows object
 * properties plus the server-side DDL for function/sequence/index/
 * constraint/trigger (and column metadata). Pure display — no editing
 * surface (B23 owns the designer).
 */
export function ObjectViewerTab({
  tab,
}: {
  tab: ObjectViewerTabState;
}) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [props, setProps] = useState<ObjectPropsResponse | null>(null);
  const [permissionDenied, setPermissionDenied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setPermissionDenied(false);
      try {
        const response = await invoke<ObjectPropsResponse>(
          "postgres_object_props",
          {
            request: {
              connectionId: tab.connectionId,
              objectType: tab.object.objectKind,
              schema: tab.object.schema,
              name: tab.object.name,
              ...(tab.object.table
                ? { relation: tab.object.table }
                : {}),
              ...(tab.object.signature
                ? { signature: tab.object.signature }
                : {}),
            },
          },
        );
        if (cancelled) return;
        setProps(response);
      } catch (error) {
        if (cancelled) return;
        const message = String(error);
        if (message.includes("insufficient privilege")) {
          setPermissionDenied(true);
        } else {
          toast.error(t("toolbox.postgres.queryFailed"), {
            description: message,
          });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [tab, t]);

  if (loading) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
        <span className="text-[12px]">{t("toolbox.postgres.navigatorLoading")}</span>
      </div>
    );
  }

  const ddl = props?.ddl ?? "";
  const truncated = props?.truncated ?? false;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      {permissionDenied ? (
        <div className="flex flex-col items-center justify-center gap-2 p-8 text-muted-foreground">
          <ShieldAlert className="h-5 w-5" />
          <p className="text-[12px]">
            {t("toolbox.postgres.noDefinitionPermission")}
          </p>
        </div>
      ) : (
        <>
          {props && props.props.length > 0 && (
            <section className="border-b bg-muted/10 px-3 py-2">
              <h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {t("toolbox.postgres.objectProperties")}
              </h3>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-[12px]">
                {props.props.map((prop) => (
                  <div key={prop.key} className="flex gap-2">
                    <dt className="shrink-0 text-muted-foreground">
                      {prop.key}
                    </dt>
                    <dd className="truncate font-mono text-foreground">
                      {prop.value}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          )}
          {ddl ? (
            <section className="min-h-0 flex-1 px-3 py-2">
              <div className="h-full">
                <CodeEditor
                  value={ddl}
                  language="sql"
                  readOnly
                  className="h-full"
                />
              </div>
              {truncated && (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {t("toolbox.postgres.definitionTruncated")}
                </p>
              )}
            </section>
          ) : (
            !permissionDenied && (
              <div className="flex flex-1 items-center justify-center p-8 text-muted-foreground">
                <p className="text-[12px]">{t("toolbox.postgres.noDefinition")}</p>
              </div>
            )
          )}
        </>
      )}
    </div>
  );
}
