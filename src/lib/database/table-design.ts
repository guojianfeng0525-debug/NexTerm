/**
 * B23 Table Designer — shared types + diff function (architecture D-B23-4).
 *
 * diff is a pure front-end computation (no IPC, no side effects).
 * DDL text generation + validation + execution all happen in Rust
 * (postgres_design.rs) — the front end only sends the structured change.
 */

// ── Load result (postgres_table_design_load) ──────────────────────────────

export interface TableDesignColumn {
  readonly name: string;
  readonly dataType: string;
  readonly nullable: boolean;
  readonly default: string | null;
  readonly comment: string | null;
  readonly ordinal: number;
  /** Mirrors Rust PostgresDesignColumn.primaryKey (column is in the PK). */
  readonly primaryKey: boolean;
}

export interface TableDesignPrimaryKey {
  readonly name: string | null;
  readonly columns: readonly string[];
}

export interface TableDesignConstraint {
  readonly name: string;
  readonly type: "p" | "f" | "u" | "c" | "x";
  readonly definition: string;
  readonly columns: readonly string[];
}

/**
 * Index column list. The Rust load command (`postgres_table_design_load`)
 * returns plain column names (`array_agg(a.attname)`); sort direction
 * (desc/nullsFirst) is not yet decoded from pg_index.indoption, so diff
 * round-trips desc:false (known limitation, B23 v1).
 */
export interface TableDesignIndex {
  readonly name: string;
  readonly unique: boolean;
  readonly method: string;
  readonly columns: readonly string[];
  readonly definition: string;
}

export interface TableDesignForeignKey {
  readonly name: string;
  readonly columns: readonly string[];
  readonly references: {
    readonly schema: string;
    readonly table: string;
    readonly columns: readonly string[];
  };
  readonly onDelete: string | null;
  readonly onUpdate: string | null;
}

export interface TableDesign {
  readonly schema: string;
  readonly table: string;
  readonly columns: readonly TableDesignColumn[];
  readonly primaryKey: TableDesignPrimaryKey | null;
  readonly constraints: readonly TableDesignConstraint[];
  readonly indexes: readonly TableDesignIndex[];
  readonly foreignKeys: readonly TableDesignForeignKey[];
  readonly comment: string | null;
  readonly hasData: boolean;
}

// ── Draft (editable copy of TableDesign for the UI) ───────────────────────

export interface ColumnDef {
  name: string;
  dataType: string;
  nullable: boolean;
  default: string | null;
  comment: string | null;
}

export interface ConstraintDef {
  name: string;
  type: "u" | "c" | "x";
  columns: string[];
  definition?: string;
}

export interface IndexDef {
  name: string;
  unique: boolean;
  method: string;
  columns: Array<{ name: string; desc: boolean }>;
}

export interface ForeignKeyDef {
  name: string;
  columns: string[];
  references: { schema: string; table: string; columns: string[] };
  onDelete: string | null;
  onUpdate: string | null;
}

export interface TableDesignDraft {
  columns: ColumnDef[];
  primaryKey: string[]; // column names
  constraints: ConstraintDef[];
  indexes: IndexDef[];
  foreignKeys: ForeignKeyDef[];
  comment: string | null;
}

// ── Change set (output of diff, input to postgres_table_design_apply) ─────
//
// This shape mirrors the Rust `TableDesignChange` contract 1:1 (serde
// camelCase) so the UI diff can be sent to the backend unchanged. The two
// boolean flags (`pkChanged`, `hasCommentChange`) are UI-only helpers — Rust
// serde ignores unknown fields, and the normalized fields below already
// deserialize to no-ops for unchanged parts.

export interface ModifyColumnChange {
  readonly name: string;
  readonly dataType?: string;
  readonly nullable?: boolean;
  /** New DEFAULT expression. `dropDefault` takes precedence when both set. */
  readonly default?: string | null;
  /** true = ALTER COLUMN ... DROP DEFAULT (default removed). */
  readonly dropDefault?: boolean;
  readonly comment?: string | null;
  /** true = COMMENT ON COLUMN ... IS '' (comment removed). */
  readonly dropComment?: boolean;
}

export interface SetPrimaryKeyChange {
  readonly name: string | null;
  readonly columns: string[];
}

export interface TableDesignChange {
  readonly schema: string;
  readonly table: string;
  /** True = CREATE TABLE (new-table designer mode). */
  readonly create: boolean;
  readonly addColumns: ColumnDef[];
  readonly dropColumns: Array<{ name: string }>;
  readonly modifyColumns: ModifyColumnChange[];
  readonly renameColumns: Array<{ from: string; to: string }>;
  /** UI flag — true when the primary key columns differ between baseline and
   *  draft (length or order mismatch). When false, `setPrimaryKey` is empty
   *  (Rust no-op); the apply button stays disabled. */
  readonly pkChanged: boolean;
  /** Empty = PK untouched. One entry with empty columns = DROP PRIMARY KEY.
   *  One entry with columns = replace. Mirrors Rust's Vec<SetPrimaryKey>. */
  readonly setPrimaryKey: SetPrimaryKeyChange[];
  readonly addConstraints: ConstraintDef[];
  readonly dropConstraints: Array<{ name: string }>;
  readonly addIndexes: IndexDef[];
  readonly dropIndexes: Array<{ name: string }>;
  readonly addForeignKeys: ForeignKeyDef[];
  readonly dropForeignKeys: Array<{ name: string }>;
  /** null = comment untouched; "" = clear the comment. */
  readonly setComment: string | null;
  readonly hasCommentChange: boolean;
}

// ── Diff function ────────────────────────────────────────────────────────

/**
 * Computes the structured difference between a baseline (loaded from DB) and
 * a draft (edited by the user in the designer UI).
 *
 * Rules (architecture D-B23-4):
 * - Pair by object identity (column name / constraint name / index name / FK name).
 * - Same name, changed attributes → modify.
 * - Missing in draft → drop.
 * - New in draft → add.
 * - Column reordering does NOT produce reorder DDL (PG has no column-order ALTER).
 * - Comment change is merged into modifyColumns when the column also changed,
 *   or handled via setComment when only the table comment changed.
 * - Empty change set → apply button disabled.
 */
export function diffTableDesign(
  baseline: TableDesign,
  draft: TableDesignDraft,
): TableDesignChange {
  // ── Primary Key (compute first so we can set it in the initial object) ──
  const basePkCols = baseline.primaryKey?.columns ?? [];
  const draftPkCols = draft.primaryKey;
  const pkChanged =
    basePkCols.length !== draftPkCols.length ||
    basePkCols.some((c, i) => c !== draftPkCols[i]);
  const hasCommentChange = (draft.comment ?? null) !== (baseline.comment ?? null);

  const change: TableDesignChange = {
    schema: baseline.schema,
    table: baseline.table,
    create: false,
    addColumns: [],
    dropColumns: [],
    modifyColumns: [],
    renameColumns: [],
    pkChanged,
    setPrimaryKey: pkChanged ? [{ name: null, columns: [...draftPkCols] }] : [],
    addConstraints: [],
    dropConstraints: [],
    addIndexes: [],
    dropIndexes: [],
    addForeignKeys: [],
    dropForeignKeys: [],
    // "" = clear the comment (comment removal); null = untouched.
    setComment: hasCommentChange ? (draft.comment ?? "") : null,
    hasCommentChange,
  };

  // ── Columns ──
  const baselineCols = new Map(baseline.columns.map((c) => [c.name, c]));
  const draftColNames = new Set(draft.columns.map((c) => c.name));

  // Drop columns: in baseline but not in draft
  for (const [name] of baselineCols) {
    if (!draftColNames.has(name)) {
      change.dropColumns.push({ name });
    }
  }

  // Add + modify columns
  for (const draftCol of draft.columns) {
    const baseCol = baselineCols.get(draftCol.name);
    if (!baseCol) {
      change.addColumns.push(draftCol);
    } else {
      const mod: {
        name: string;
        dataType?: string;
        nullable?: boolean;
        default?: string | null;
        dropDefault?: boolean;
        comment?: string | null;
        dropComment?: boolean;
      } = { name: draftCol.name };
      if (baseCol.dataType !== draftCol.dataType) mod.dataType = draftCol.dataType;
      if (baseCol.nullable !== draftCol.nullable) mod.nullable = draftCol.nullable;
      if ((baseCol.default ?? null) !== (draftCol.default ?? null)) {
        if (draftCol.default === null) mod.dropDefault = true;
        else mod.default = draftCol.default;
      }
      if ((baseCol.comment ?? null) !== (draftCol.comment ?? null)) {
        if (draftCol.comment === null) mod.dropComment = true;
        else mod.comment = draftCol.comment;
      }
      if (
        mod.dataType !== undefined ||
        mod.nullable !== undefined ||
        mod.default !== undefined ||
        mod.dropDefault !== undefined ||
        mod.comment !== undefined ||
        mod.dropComment !== undefined
      ) {
        change.modifyColumns.push(mod);
      }
    }
  }

  // ── Constraints (non-PK: u/c/x only, PK handled above) ──
  const baseConstraints = new Map(
    baseline.constraints.filter((c) => c.type !== "p").map((c) => [c.name, c]),
  );
  const draftConstraintNames = new Set(draft.constraints.map((c) => c.name));
  for (const [name] of baseConstraints) {
    if (!draftConstraintNames.has(name)) {
      change.dropConstraints.push({ name });
    }
  }
  for (const draftCon of draft.constraints) {
    if (!baseConstraints.has(draftCon.name)) {
      change.addConstraints.push(draftCon);
    }
  }

  // ── Indexes ──
  const baseIndexes = new Map(baseline.indexes.map((i) => [i.name, i]));
  const draftIndexNames = new Set(draft.indexes.map((i) => i.name));
  for (const [name] of baseIndexes) {
    if (!draftIndexNames.has(name)) {
      change.dropIndexes.push({ name });
    }
  }
  for (const draftIdx of draft.indexes) {
    if (!baseIndexes.has(draftIdx.name)) {
      change.addIndexes.push(draftIdx);
    }
  }

  // ── Foreign Keys ──
  const baseFks = new Map(baseline.foreignKeys.map((f) => [f.name, f]));
  const draftFkNames = new Set(draft.foreignKeys.map((f) => f.name));
  for (const [name] of baseFks) {
    if (!draftFkNames.has(name)) {
      change.dropForeignKeys.push({ name });
    }
  }
  for (const draftFk of draft.foreignKeys) {
    if (!baseFks.has(draftFk.name)) {
      // Normalize null actions to the PG default (Rust requires a whitelisted
      // FK action string; null means "NO ACTION" in the UI).
      change.addForeignKeys.push({
        ...draftFk,
        onDelete: draftFk.onDelete ?? "NO ACTION",
        onUpdate: draftFk.onUpdate ?? "NO ACTION",
      });
    }
  }

  return change;
}

/** Returns true when the change set has no operations (apply should be disabled). */
export function isChangeEmpty(change: TableDesignChange): boolean {
  return (
    change.addColumns.length === 0 &&
    change.dropColumns.length === 0 &&
    change.modifyColumns.length === 0 &&
    change.renameColumns.length === 0 &&
    change.setPrimaryKey.length === 0 &&
    change.addConstraints.length === 0 &&
    change.dropConstraints.length === 0 &&
    change.addIndexes.length === 0 &&
    change.dropIndexes.length === 0 &&
    change.addForeignKeys.length === 0 &&
    change.dropForeignKeys.length === 0 &&
    !change.hasCommentChange
  );
}

/** Converts a loaded TableDesign into an editable TableDesignDraft. */
export function draftFromDesign(design: TableDesign): TableDesignDraft {
  return {
    columns: design.columns.map((c) => ({
      name: c.name,
      dataType: c.dataType,
      nullable: c.nullable,
      default: c.default,
      comment: c.comment,
    })),
    primaryKey: [...(design.primaryKey?.columns ?? [])],
    constraints: design.constraints
      .filter((c) => c.type !== "p" && c.type !== "f")
      .map((c) => ({
        name: c.name,
        type: c.type as "u" | "c" | "x",
        columns: [...c.columns],
        definition: c.definition,
      })),
    indexes: design.indexes.map((i) => ({
      name: i.name,
      unique: i.unique,
      method: i.method,
      // Rust returns plain column names; desc defaults to false (B23 v1).
      columns: i.columns.map((name) => ({ name, desc: false })),
    })),
    foreignKeys: design.foreignKeys.map((f) => ({
      name: f.name,
      columns: [...f.columns],
      references: {
        schema: f.references.schema,
        table: f.references.table,
        columns: [...f.references.columns],
      },
      onDelete: f.onDelete,
      onUpdate: f.onUpdate,
    })),
    comment: design.comment,
  };
}
