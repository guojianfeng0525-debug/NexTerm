/**
 * B23 Table Designer — declarative form + DDL preview + toolbar.
 *
 * Architecture D-B23-4:
 * - Diff is computed locally (table-design.ts diffTableDesign).
 * - DDL generation + validation + execution happen in Rust (postgres_design.rs).
 * - This component sends the structured change via onApply; it never assembles SQL.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Save, Undo2, RefreshCw, Plus, Trash2, AlertTriangle } from "lucide-react";
import {
  diffTableDesign,
  draftFromDesign,
  isChangeEmpty,
  type TableDesign,
  type TableDesignDraft,
  type TableDesignChange,
  type ColumnDef,
} from "@/lib/database/table-design";

// ── Props ──────────────────────────────────────────────────────────────────

export interface TableDesignerTabProps {
  connectionId: string;
  schema: string;
  table: string;
  /** True = new-table mode (CREATE TABLE): no load, table name editable,
   *  change carries create:true. */
  createMode?: boolean;
  onLoad: (
    connectionId: string,
    schema: string,
    table: string,
  ) => Promise<TableDesign>;
  onApply: (
    connectionId: string,
    change: TableDesignChange,
    confirmed: boolean,
  ) => Promise<{ ddl: string; warnings: string[]; applied: boolean }>;
  /** Promotes a successfully-created table to normal designer mode. */
  onCreated?: (table: string) => void;
  onRefresh: () => void;
  readOnly: boolean;
  /** DESIGNER-scope shortcut hook: Ctrl+S → apply (doApply). When absent the
   *  component falls back to its internal save handler. */
  readonly onSaveShortcut?: () => void;
  /** DESIGNER-scope shortcut hook: Escape → reset draft to the loaded design.
   *  When absent the component falls back to its internal revert handler. */
  readonly onRevertShortcut?: () => void;
}

/**
 * DESIGNER-domain shortcuts (feature-design §1.3): Ctrl+S applies the design,
 * Escape reverts the draft. Listens on window keydown. Escape is two-level
 * (P2-14): while typing in an input/textarea/contenteditable, the first press
 * exits the input (blur, cancelling the in-progress edit); the next press —
 * now outside any field — reverts the whole draft.
 */
function useDesignerShortcuts(onSave?: () => void, onRevert?: () => void): void {
  const escapedInputRef = useRef(false);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target;
      const typingInField =
        target instanceof Element &&
        Boolean(target.closest("input, textarea, [contenteditable='true']"));
      if ((event.metaKey || event.ctrlKey) && event.key === "s" && !event.altKey) {
        event.preventDefault();
        onSave?.();
      } else if (event.key === "Escape") {
        if (typingInField) {
          event.preventDefault();
          (target as HTMLElement).blur?.();
          escapedInputRef.current = true;
          return;
        }
        escapedInputRef.current = false;
        onRevert?.();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onSave, onRevert]);
}

// ── Component ───────────────────────────────────────────────────────────────

export function TableDesignerTab(props: TableDesignerTabProps) {
  const { t } = useTranslation();
  const { connectionId, schema, table, createMode = false, onLoad, onApply, onCreated, onRefresh, readOnly, onSaveShortcut, onRevertShortcut } =
    props;

  const [design, setDesign] = useState<TableDesign | null>(null);
  const [draft, setDraft] = useState<TableDesignDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ddlPreview, setDdlPreview] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [applying, setApplying] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [tableName, setTableName] = useState(table);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Load ─────────────────────────────────────────────────────────────────

  const loadDesign = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const targetTable = createMode ? tableName.trim() : table;
      const result = await onLoad(connectionId, schema, targetTable);
      setDesign(result);
      setDraft(draftFromDesign(result));
      setDdlPreview(null);
      setWarnings([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [connectionId, schema, table, tableName, createMode, onLoad]);

  useEffect(() => {
    if (createMode) {
      const empty: TableDesign = {
        schema,
        table: tableName,
        columns: [],
        primaryKey: null,
        constraints: [],
        indexes: [],
        foreignKeys: [],
        comment: null,
        hasData: false,
      };
      setDesign(empty);
      setDraft(draftFromDesign(empty));
      setDdlPreview(null);
      setWarnings([]);
      setLoading(false);
      setError(null);
      return;
    }
    void loadDesign();
    // createMode intentionally seeds once; typing the table name must not
    // reset the draft (columns the user added would be lost).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createMode, schema]);

  // ── Diff (local, pure) ───────────────────────────────────────────────────

  const change = useMemo(() => {
    if (!design || !draft) return null;
    const diff = diffTableDesign(design, draft);
    if (createMode) {
      return { ...diff, create: true, table: tableName.trim() };
    }
    return diff;
  }, [design, draft, createMode, tableName]);

  const hasChanges = change ? !isChangeEmpty(change) : false;

  // ── Debounced DDL preview (dry-run via onApply confirmed=false) ───────────

  useEffect(() => {
    if (!change || !hasChanges) {
      setDdlPreview(null);
      setWarnings([]);
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void (async () => {
        try {
          const result = await onApply(connectionId, change, false);
          setDdlPreview(result.ddl || null);
          setWarnings(result.warnings);
        } catch (e) {
          setDdlPreview(null);
          setWarnings([e instanceof Error ? e.message : String(e)]);
        }
      })();
    }, 600);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [change, hasChanges, connectionId, onApply]);

  // ── Actions ──────────────────────────────────────────────────────────────

  const doApply = useCallback(async () => {
    if (!change || !hasChanges) return;
    setApplying(true);
    try {
      const result = await onApply(connectionId, change, true);
      if (result.applied) {
        toast.success(t("toolbox.postgres.designer.applied"));
        await loadDesign();
        if (createMode) onCreated?.(tableName.trim());
        onRefresh();
      }
    } catch (e) {
      toast.error(t("toolbox.postgres.designer.applyFailed"), {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setApplying(false);
    }
  }, [change, hasChanges, connectionId, onApply, t, loadDesign, createMode, onCreated, tableName, onRefresh]);

  const handleSave = useCallback(() => {
    if (!change || !hasChanges || readOnly) return;
    if (createMode && !tableName.trim()) {
      toast.error(t("toolbox.postgres.newTableNameRequired"));
      return;
    }
    if (warnings.length > 0) {
      setShowConfirm(true);
      return;
    }
    void doApply();
  }, [change, hasChanges, readOnly, warnings, doApply, createMode, tableName, t]);

  const handleRevert = useCallback(() => {
    if (design) {
      setDraft(draftFromDesign(design));
      setDdlPreview(null);
      setWarnings([]);
    }
  }, [design]);

  const handleRefresh = useCallback(async () => {
    await loadDesign();
    onRefresh();
  }, [loadDesign, onRefresh]);

  // ── Shortcuts (DESIGNER scope, feature-design §1.3) ───────────────────────
  // Ctrl+S → apply; Escape → revert. Callers may inject their own handlers via
  // onSaveShortcut / onRevertShortcut; otherwise fall back to the internal
  // save / revert so the shortcuts work standalone.
  const shortcutSave = useCallback(() => {
    if (hasChanges && !readOnly) void handleSave();
  }, [hasChanges, readOnly, handleSave]);
  const shortcutRevert = useCallback(() => {
    if (design) handleRevert();
  }, [design, handleRevert]);
  useDesignerShortcuts(onSaveShortcut ?? shortcutSave, onRevertShortcut ?? shortcutRevert);

  // ── Column operations ─────────────────────────────────────────────────────

  const updateColumn = (index: number, patch: Partial<ColumnDef>) => {
    if (!draft || readOnly) return;
    setDraft({
      ...draft,
      columns: draft.columns.map((c, i) => (i === index ? { ...c, ...patch } : c)),
    });
  };

  const addColumn = () => {
    if (!draft || readOnly) return;
    setDraft({
      ...draft,
      columns: [
        ...draft.columns,
        { name: "", dataType: "text", nullable: true, default: null, comment: null },
      ],
    });
  };

  const removeColumn = (index: number) => {
    if (!draft || readOnly) return;
    const removedName = draft.columns[index]?.name;
    setDraft({
      ...draft,
      columns: draft.columns.filter((_, i) => i !== index),
      primaryKey: removedName
        ? draft.primaryKey.filter((c) => c !== removedName)
        : draft.primaryKey,
    });
  };

  const togglePrimaryKey = (colName: string) => {
    if (!draft || readOnly || !colName) return;
    const isPk = draft.primaryKey.includes(colName);
    setDraft({
      ...draft,
      primaryKey: isPk
        ? draft.primaryKey.filter((c) => c !== colName)
        : [...draft.primaryKey, colName],
    });
  };

  // ── Constraint operations ────────────────────────────────────────────────

  const addConstraint = () => {
    if (!draft || readOnly) return;
    setDraft({
      ...draft,
      constraints: [
        ...draft.constraints,
        { name: "", type: "u" as const, columns: [] },
      ],
    });
  };

  const removeConstraint = (index: number) => {
    if (!draft || readOnly) return;
    setDraft({
      ...draft,
      constraints: draft.constraints.filter((_, i) => i !== index),
    });
  };

  // ── FK operations ─────────────────────────────────────────────────────────

  const addForeignKey = () => {
    if (!draft || readOnly) return;
    setDraft({
      ...draft,
      foreignKeys: [
        ...draft.foreignKeys,
        {
          name: "",
          columns: [],
          references: { schema: "public", table: "", columns: [] },
          onDelete: null,
          onUpdate: null,
        },
      ],
    });
  };

  const removeForeignKey = (index: number) => {
    if (!draft || readOnly) return;
    setDraft({
      ...draft,
      foreignKeys: draft.foreignKeys.filter((_, i) => i !== index),
    });
  };

  // ── Render ────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {t("toolbox.postgres.designer.loading")}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-destructive">
        {t("toolbox.postgres.designer.loadFailed")}: {error}
      </div>
    );
  }

  if (!design || !draft) return null;

  const d = t; // shorthand

  return (
    <div className="h-full" data-testid="table-designer">
      <div className="flex h-full flex-col" data-testid="table-designer-tab">
      {/* Toolbar */}
      <div className="flex h-9 shrink-0 items-center gap-1 border-b bg-muted/10 px-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {schema}.
        </span>
        {createMode ? (
          <Input
            className="h-6 w-44 rounded-sm px-2 font-mono text-[12px]"
            placeholder={t("toolbox.postgres.newTableName")}
            value={tableName}
            onChange={(e) => setTableName(e.target.value)}
            data-testid="designer-table-name"
          />
        ) : (
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {table}
          </span>
        )}
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 rounded-sm px-2 text-[12px]"
          onClick={handleSave}
          disabled={!hasChanges || readOnly || applying}
          data-testid="designer-save"
        >
          <Save className="h-3.5 w-3.5" />
          {d("toolbox.postgres.designer.save")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 rounded-sm px-2 text-[12px]"
          onClick={handleRevert}
          disabled={!hasChanges || readOnly}
          data-testid="designer-revert"
        >
          <Undo2 className="h-3.5 w-3.5" />
          {d("toolbox.postgres.designer.revert")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 rounded-sm px-2 text-[12px]"
          onClick={() => void handleRefresh()}
          data-testid="designer-refresh"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          {d("toolbox.postgres.designer.refresh")}
        </Button>
      </div>

      {/* Content */}
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-3">
          {/* Warnings banner */}
          {warnings.length > 0 && (
            <div className="mb-3 rounded-md border border-yellow-500/30 bg-yellow-500/5 p-2">
              <div className="flex items-center gap-1.5 text-[12px] font-medium text-yellow-600 dark:text-yellow-500">
                <AlertTriangle className="h-3.5 w-3.5" />
                {warnings.length} warning(s)
              </div>
              <ul className="mt-1 space-y-0.5 pl-5 text-[11px] text-muted-foreground">
                {warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Columns */}
          <div className="mb-4">
            <div className="mb-2 flex items-center gap-2">
              <h3 className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
                {d("toolbox.postgres.designer.columns")}
              </h3>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-2 text-[11px]"
                onClick={addColumn}
                disabled={readOnly}
                data-testid="designer-add-column"
              >
                <Plus className="h-3 w-3" />
                {d("toolbox.postgres.designer.addColumn")}
              </Button>
            </div>
            <div className="overflow-hidden rounded-md border">
              <table className="w-full text-[12px]">
                <thead className="bg-muted/30">
                  <tr>
                    <th className="w-8 px-2 py-1.5 text-center font-medium">
                      {d("toolbox.postgres.designer.columnPrimaryKey")}
                    </th>
                    <th className="px-2 py-1.5 text-left font-medium">
                      {d("toolbox.postgres.designer.columnName")}
                    </th>
                    <th className="px-2 py-1.5 text-left font-medium">
                      {d("toolbox.postgres.designer.columnType")}
                    </th>
                    <th className="w-12 px-2 py-1.5 text-center font-medium">
                      {d("toolbox.postgres.designer.columnNullable")}
                    </th>
                    <th className="px-2 py-1.5 text-left font-medium">
                      {d("toolbox.postgres.designer.columnDefault")}
                    </th>
                    <th className="px-2 py-1.5 text-left font-medium">
                      {d("toolbox.postgres.designer.columnComment")}
                    </th>
                    <th className="w-8" />
                  </tr>
                </thead>
                <tbody>
                  {draft.columns.map((col, i) => (
                    <tr key={i} className="border-t hover:bg-muted/5">
                      <td className="px-2 py-1 text-center">
                        <Checkbox
                          checked={draft.primaryKey.includes(col.name)}
                          onCheckedChange={() => togglePrimaryKey(col.name)}
                          disabled={readOnly || !col.name}
                        />
                      </td>
                      <td className="px-2 py-1">
                        <Input
                          value={col.name}
                          onChange={(e) => updateColumn(i, { name: e.target.value })}
                          disabled={readOnly}
                          className="h-7 border-0 bg-transparent px-1 text-[12px] focus-visible:ring-1"
                          data-testid={`designer-column-name-${i}`}
                        />
                      </td>
                      <td className="px-2 py-1">
                        <Input
                          value={col.dataType}
                          onChange={(e) => updateColumn(i, { dataType: e.target.value })}
                          disabled={readOnly}
                          className="h-7 border-0 bg-transparent px-1 text-[12px] focus-visible:ring-1"
                          data-testid={`designer-column-type-${i}`}
                        />
                      </td>
                      <td className="px-2 py-1 text-center">
                        <Checkbox
                          checked={col.nullable}
                          onCheckedChange={(v) => updateColumn(i, { nullable: v === true })}
                          disabled={readOnly}
                        />
                      </td>
                      <td className="px-2 py-1">
                        <Input
                          value={col.default ?? ""}
                          onChange={(e) => updateColumn(i, { default: e.target.value || null })}
                          disabled={readOnly}
                          placeholder="—"
                          className="h-7 border-0 bg-transparent px-1 text-[12px] focus-visible:ring-1"
                        />
                      </td>
                      <td className="px-2 py-1">
                        <Input
                          value={col.comment ?? ""}
                          onChange={(e) => updateColumn(i, { comment: e.target.value || null })}
                          disabled={readOnly}
                          placeholder="—"
                          className="h-7 border-0 bg-transparent px-1 text-[12px] focus-visible:ring-1"
                        />
                      </td>
                      <td className="px-1 py-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 w-6 p-0"
                          onClick={() => removeColumn(i)}
                          disabled={readOnly}
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Table comment */}
          <div className="mb-4">
            <Label className="mb-1 text-[12px] font-medium">
              {d("toolbox.postgres.designer.columnComment")}
            </Label>
            <Input
              value={draft.comment ?? ""}
              onChange={(e) => setDraft({ ...draft, comment: e.target.value || null })}
              disabled={readOnly}
              placeholder="—"
              className="h-7 text-[12px]"
            />
          </div>

          {/* Constraints */}
          <Accordion type="single" collapsible className="mb-2">
            <AccordionItem value="constraints" className="rounded-md border px-2">
              <AccordionTrigger className="py-2 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
                {d("toolbox.postgres.designer.constraints")} ({draft.constraints.length})
              </AccordionTrigger>
              <AccordionContent>
                <div className="pb-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mb-2 h-6 gap-1 px-2 text-[11px]"
                    onClick={addConstraint}
                    disabled={readOnly}
                  >
                    <Plus className="h-3 w-3" />
                    {d("toolbox.postgres.designer.addConstraint")}
                  </Button>
                  {draft.constraints.map((con, i) => (
                    <div key={i} className="mb-1 flex items-center gap-2">
                      <Input
                        value={con.name}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            constraints: draft.constraints.map((c, j) =>
                              j === i ? { ...c, name: e.target.value } : c,
                            ),
                          })
                        }
                        disabled={readOnly}
                        placeholder={d("toolbox.postgres.designer.constraintName")}
                        className="h-7 flex-1 text-[12px]"
                      />
                      <select
                        value={con.type}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            constraints: draft.constraints.map((c, j) =>
                              j === i
                                ? { ...c, type: e.target.value as "u" | "c" | "x" }
                                : c,
                            ),
                          })
                        }
                        disabled={readOnly}
                        className="h-7 rounded-md border bg-transparent px-1 text-[12px]"
                      >
                        <option value="u">UNIQUE</option>
                        <option value="c">CHECK</option>
                        <option value="x">EXCLUSION</option>
                      </select>
                      <Input
                        value={con.columns.join(", ")}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            constraints: draft.constraints.map((c, j) =>
                              j === i
                                ? {
                                    ...c,
                                    columns: e.target.value
                                      .split(",")
                                      .map((s) => s.trim())
                                      .filter(Boolean),
                                  }
                                : c,
                            ),
                          })
                        }
                        disabled={readOnly}
                        placeholder={d("toolbox.postgres.designer.constraintColumns")}
                        className="h-7 flex-1 text-[12px]"
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0"
                        onClick={() => removeConstraint(i)}
                        disabled={readOnly}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  ))}
                </div>
              </AccordionContent>
            </AccordionItem>
          </Accordion>

          {/* Foreign Keys */}
          <Accordion type="single" collapsible className="mb-2">
            <AccordionItem value="foreignKeys" className="rounded-md border px-2">
              <AccordionTrigger className="py-2 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
                {d("toolbox.postgres.designer.foreignKeys")} ({draft.foreignKeys.length})
              </AccordionTrigger>
              <AccordionContent>
                <div className="pb-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mb-2 h-6 gap-1 px-2 text-[11px]"
                    onClick={addForeignKey}
                    disabled={readOnly}
                  >
                    <Plus className="h-3 w-3" />
                    {d("toolbox.postgres.designer.addForeignKey")}
                  </Button>
                  {draft.foreignKeys.map((fk, i) => (
                    <div key={i} className="mb-1 flex items-center gap-2">
                      <Input
                        value={fk.name}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            foreignKeys: draft.foreignKeys.map((f, j) =>
                              j === i ? { ...f, name: e.target.value } : f,
                            ),
                          })
                        }
                        disabled={readOnly}
                        placeholder={d("toolbox.postgres.designer.fkName")}
                        className="h-7 flex-1 text-[12px]"
                      />
                      <Input
                        value={fk.columns.join(", ")}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            foreignKeys: draft.foreignKeys.map((f, j) =>
                              j === i
                                ? {
                                    ...f,
                                    columns: e.target.value
                                      .split(",")
                                      .map((s) => s.trim())
                                      .filter(Boolean),
                                  }
                                : f,
                            ),
                          })
                        }
                        disabled={readOnly}
                        placeholder={d("toolbox.postgres.designer.fkColumns")}
                        className="h-7 w-24 text-[12px]"
                      />
                      <Input
                        value={fk.references.schema}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            foreignKeys: draft.foreignKeys.map((f, j) =>
                              j === i
                                ? {
                                    ...f,
                                    references: {
                                      ...f.references,
                                      schema: e.target.value,
                                    },
                                  }
                                : f,
                            ),
                          })
                        }
                        disabled={readOnly}
                        placeholder={d("toolbox.postgres.designer.fkReferencesSchema")}
                        className="h-7 w-24 text-[12px]"
                      />
                      <Input
                        value={fk.references.table}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            foreignKeys: draft.foreignKeys.map((f, j) =>
                              j === i
                                ? {
                                    ...f,
                                    references: {
                                      ...f.references,
                                      table: e.target.value,
                                    },
                                  }
                                : f,
                            ),
                          })
                        }
                        disabled={readOnly}
                        placeholder={d("toolbox.postgres.designer.fkReferencesTable")}
                        className="h-7 w-24 text-[12px]"
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0"
                        onClick={() => removeForeignKey(i)}
                        disabled={readOnly}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  ))}
                </div>
              </AccordionContent>
            </AccordionItem>
          </Accordion>

          {/* DDL Preview */}
          {ddlPreview && (
            <div className="mt-3">
              <h3 className="mb-1 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
                {d("toolbox.postgres.designer.ddlPreview")}
              </h3>
              <pre className="overflow-x-auto rounded-md border bg-muted/20 p-2 text-[11px] leading-relaxed">
                <code>{ddlPreview}</code>
              </pre>
            </div>
          )}
        </div>
      </ScrollArea>

      {/* Confirmation dialog (when warnings exist) */}
      <AlertDialog open={showConfirm} onOpenChange={setShowConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {d("toolbox.postgres.designer.confirmTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {d("toolbox.postgres.designer.confirmDescription")}
              <ul className="mt-2 list-disc pl-4">
                {warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {d("toolbox.postgres.designer.revert")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setShowConfirm(false);
                void doApply();
              }}
            >
              {d("toolbox.postgres.designer.confirmAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      </div>
    </div>
  );
}
