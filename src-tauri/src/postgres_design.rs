//! PostgreSQL table-designer domain commands (B23).
//!
//! Architecture constraints D-B23-2..D-B23-9 (b23-24-architecture-constraints.md):
//! - This module owns the whole read/write designer domain: structured load,
//!   DDL generation (dry-run) and transactional apply, plus View Builder save.
//! - The frontend computes the *diff* (structured change description) but never
//!   assembles SQL: every ALTER fragment is built here with `quote_identifier`
//!   and validated against the D-B23-6 rejection list before execution.
//! - Rollback semantics = transaction atomicity (D-B23-7): apply runs inside a
//!   single transaction; any failure rolls everything back. No snapshot/reverse
//!   DDL mechanism.
//!
//! Security: identifiers are always quoted; user text (defaults, CHECK
//! expressions, view definitions) is executed through the extended protocol
//! (`Client::execute`), which structurally rejects multi-statement batches.

use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::time::timeout;
use tokio_postgres::Client;

use crate::postgres::{quote_identifier, PostgresState, QUERY_TIMEOUT};

/// PG hard limit for identifiers (NAMEDATALEN - 1).
const MAX_IDENTIFIER_LEN: usize = 63;
/// Max length of a column default expression (user text, executed as DDL).
const MAX_DEFAULT_LEN: usize = 512;
/// Max length of a CHECK / exclusion constraint expression.
const MAX_CHECK_LEN: usize = 2048;
/// Max length of a column/table comment.
const MAX_COMMENT_LEN: usize = 1024;
/// Whitelisted FK referential actions (PG confdeltype/confupdtupdtype names).
const FK_ACTIONS: [&str; 5] = [
    "NO ACTION",
    "RESTRICT",
    "CASCADE",
    "SET NULL",
    "SET DEFAULT",
];
/// Whitelisted index access methods for `CREATE INDEX ... USING <method>`.
const INDEX_METHODS: [&str; 6] = ["btree", "hash", "gist", "spgist", "gin", "brin"];
/// Whitelisted constraint kinds creatable from the designer.
const ADD_CONSTRAINT_KINDS: [&str; 3] = ["u", "c", "x"];

// ── Load contract ────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostgresTableDesignLoadRequest {
    pub connection_id: String,
    pub schema: String,
    pub table: String,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PostgresDesignColumn {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub default: Option<String>,
    pub comment: Option<String>,
    pub ordinal: i32,
    /// `true` when the column participates in the primary key.
    pub primary_key: bool,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PostgresDesignPrimaryKey {
    pub name: String,
    pub columns: Vec<String>,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PostgresDesignConstraint {
    pub name: String,
    /// p | u | c | x (pg_constraint.contype).
    #[serde(rename = "type")]
    pub constraint_type: String,
    /// `pg_get_constraintdef` text.
    pub definition: String,
    pub columns: Vec<String>,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PostgresDesignIndex {
    pub name: String,
    pub unique: bool,
    pub method: String,
    pub columns: Vec<String>,
    /// `pg_get_indexdef` text (display only).
    pub definition: String,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PostgresDesignForeignKey {
    pub name: String,
    pub columns: Vec<String>,
    pub references: PostgresDesignForeignKeyReference,
    pub on_delete: String,
    pub on_update: String,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PostgresDesignForeignKeyReference {
    pub schema: String,
    pub table: String,
    pub columns: Vec<String>,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PostgresTableDesign {
    pub schema: String,
    pub table: String,
    pub columns: Vec<PostgresDesignColumn>,
    pub primary_key: Option<PostgresDesignPrimaryKey>,
    /// Non-PK constraints (unique / check / exclusion).
    pub constraints: Vec<PostgresDesignConstraint>,
    pub indexes: Vec<PostgresDesignIndex>,
    pub foreign_keys: Vec<PostgresDesignForeignKey>,
    pub comment: Option<String>,
    pub has_data: bool,
}

// ── Change contract (mirrors src/lib/database/table-design.ts) ───────────────

#[derive(Debug, Deserialize, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct TableDesignChange {
    pub schema: String,
    pub table: String,
    /// True = CREATE TABLE (new-table designer mode): statements are built
    /// from add_columns / set_primary_key / add_constraints /
    /// add_foreign_keys instead of ALTER.
    #[serde(default)]
    pub create: bool,
    #[serde(default)]
    pub add_columns: Vec<ColumnDef>,
    #[serde(default)]
    pub drop_columns: Vec<DropColumn>,
    #[serde(default)]
    pub modify_columns: Vec<ModifyColumn>,
    #[serde(default)]
    pub rename_columns: Vec<RenameColumn>,
    /// Empty array = drop the primary key. A non-empty array replaces it.
    #[serde(default)]
    pub set_primary_key: Vec<SetPrimaryKey>,
    #[serde(default)]
    pub add_constraints: Vec<AddConstraint>,
    #[serde(default)]
    pub drop_constraints: Vec<DropNamed>,
    #[serde(default)]
    pub add_indexes: Vec<AddIndex>,
    #[serde(default)]
    pub drop_indexes: Vec<DropNamed>,
    #[serde(default)]
    pub add_foreign_keys: Vec<ForeignKeyDef>,
    #[serde(default)]
    pub drop_foreign_keys: Vec<DropNamed>,
    #[serde(default)]
    pub set_comment: Option<String>,
}

#[derive(Debug, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ColumnDef {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    #[serde(default)]
    pub default: Option<String>,
    #[serde(default)]
    pub comment: Option<String>,
}

#[derive(Debug, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DropColumn {
    pub name: String,
}

#[derive(Debug, Deserialize, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ModifyColumn {
    pub name: String,
    #[serde(default)]
    pub data_type: Option<String>,
    #[serde(default)]
    pub nullable: Option<bool>,
    #[serde(default)]
    pub default: Option<String>,
    /// `Some(None)` is not expressible in JSON; DROP DEFAULT is signaled by
    /// `dropDefault: true` instead.
    #[serde(default)]
    pub drop_default: bool,
    /// Same ambiguity for comments: `dropComment: true` clears the comment.
    #[serde(default)]
    pub drop_comment: bool,
    #[serde(default)]
    pub comment: Option<String>,
}

#[derive(Debug, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RenameColumn {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SetPrimaryKey {
    pub name: Option<String>,
    pub columns: Vec<String>,
}

#[derive(Debug, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AddConstraint {
    pub name: String,
    /// u | c | x.
    #[serde(rename = "type")]
    pub constraint_type: String,
    #[serde(default)]
    pub columns: Vec<String>,
    /// CHECK expression / exclusion definition (required for c and x).
    #[serde(default)]
    pub definition: Option<String>,
}

#[derive(Debug, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DropNamed {
    pub name: String,
}

#[derive(Debug, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AddIndex {
    pub name: String,
    pub unique: bool,
    pub method: String,
    pub columns: Vec<IndexColumn>,
}

#[derive(Debug, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IndexColumn {
    pub name: String,
    #[serde(default)]
    pub desc: bool,
}

#[derive(Debug, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKeyDef {
    pub name: String,
    pub columns: Vec<String>,
    pub references: ForeignKeyReferenceDef,
    /// `null` (absent) means the PG default action: NO ACTION.
    #[serde(default = "default_fk_action")]
    pub on_delete: String,
    #[serde(default = "default_fk_action")]
    pub on_update: String,
}

fn default_fk_action() -> String {
    "NO ACTION".to_string()
}

#[derive(Debug, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKeyReferenceDef {
    pub schema: String,
    pub table: String,
    pub columns: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostgresTableDesignApplyRequest {
    pub connection_id: String,
    pub change: TableDesignChange,
    #[serde(default)]
    pub confirmed: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostgresTableDesignApplyResponse {
    /// Full ALTER statement sequence (the DDL preview text).
    pub ddl: String,
    pub warnings: Vec<String>,
    pub applied: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostgresViewSaveRequest {
    pub connection_id: String,
    pub schema: String,
    pub name: String,
    /// User-edited SELECT / WITH text (cannot be parameterized).
    pub definition: String,
    #[serde(default)]
    pub confirmed: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostgresPgTypesRequest {
    pub connection_id: String,
    /// Restrict custom (non-catalog) types to this schema.
    pub schema: String,
}

// ── Validation helpers (pure, unit-tested) ───────────────────────────────────

/// D-B23-6: a designer identifier must be a non-empty, bounded, NUL-free
/// string. Any character is otherwise legal because every use site goes
/// through `quote_identifier` (quotes doubled — no escaping path exists).
fn validate_identifier(label: &str, value: &str) -> Result<(), String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!("{label} name must not be empty"));
    }
    if value.len() > MAX_IDENTIFIER_LEN {
        return Err(format!(
            "{label} name exceeds {MAX_IDENTIFIER_LEN} characters"
        ));
    }
    if value.contains('\0') {
        return Err(format!("{label} name contains an invalid character"));
    }
    Ok(())
}

/// D-B23-6: data type text is whitelisted to a safe charset and bounded
/// length (prevents smuggled SQL through the type position).
fn validate_data_type(value: &str) -> Result<(), String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("Column data type must not be empty".into());
    }
    if value.len() > 64 {
        return Err("Column data type exceeds 64 characters".into());
    }
    if !value.chars().all(|c| {
        c.is_ascii_alphanumeric()
            || matches!(c, ' ' | '_' | '(' | ')' | '[' | ']' | '"' | ',' | '.')
    }) {
        return Err("Column data type contains invalid characters".into());
    }
    Ok(())
}

/// Bounded free-text DDL fragment (defaults, CHECK expressions, comments).
fn validate_ddl_text(label: &str, value: &str, max: usize) -> Result<(), String> {
    if value.len() > max {
        return Err(format!("{label} exceeds {max} characters"));
    }
    if value.contains('\0') {
        return Err(format!("{label} contains an invalid character"));
    }
    Ok(())
}

fn validate_fk_action(label: &str, value: &str) -> Result<(), String> {
    if FK_ACTIONS.contains(&value) {
        Ok(())
    } else {
        Err(format!("{label} must be one of {}", FK_ACTIONS.join(", ")))
    }
}

/// Rejects duplicates within one add/drop list (same list-scoped identity).
fn reject_duplicates(label: &str, names: &[String]) -> Result<(), String> {
    let mut seen = std::collections::HashSet::new();
    for name in names {
        if !seen.insert(name.trim()) {
            return Err(format!("Duplicate {label} name: {}", name));
        }
    }
    Ok(())
}

/// SQL string literal with doubled single quotes (COMMENT ON ... IS '...').
fn quote_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// Structural validation of a change (D-B23-6 rejection list, DB-free part).
fn validate_change(change: &TableDesignChange) -> Result<(), String> {
    validate_identifier("Schema", &change.schema)?;
    validate_identifier("Table", &change.table)?;

    if change.create {
        if change.add_columns.is_empty() {
            return Err("A new table requires at least one column".into());
        }
        if !change.drop_columns.is_empty()
            || !change.modify_columns.is_empty()
            || !change.rename_columns.is_empty()
            || !change.drop_constraints.is_empty()
            || !change.drop_indexes.is_empty()
            || !change.drop_foreign_keys.is_empty()
        {
            return Err("CREATE TABLE cannot include alteration or drop operations".into());
        }
    }

    let add_names: Vec<String> = change.add_columns.iter().map(|c| c.name.clone()).collect();
    reject_duplicates("column", &add_names)?;
    for column in &change.add_columns {
        validate_identifier("Column", &column.name)?;
        validate_data_type(&column.data_type)?;
        if let Some(default) = &column.default {
            validate_ddl_text("Column default", default, MAX_DEFAULT_LEN)?;
        }
        if let Some(comment) = &column.comment {
            validate_ddl_text("Column comment", comment, MAX_COMMENT_LEN)?;
        }
    }

    let drop_names: Vec<String> = change.drop_columns.iter().map(|c| c.name.clone()).collect();
    reject_duplicates("column", &drop_names)?;
    for column in &change.drop_columns {
        validate_identifier("Column", &column.name)?;
    }

    for modify in &change.modify_columns {
        validate_identifier("Column", &modify.name)?;
        if let Some(data_type) = &modify.data_type {
            validate_data_type(data_type)?;
        }
        if let Some(default) = &modify.default {
            validate_ddl_text("Column default", default, MAX_DEFAULT_LEN)?;
        }
        if let Some(comment) = &modify.comment {
            validate_ddl_text("Column comment", comment, MAX_COMMENT_LEN)?;
        }
    }

    for rename in &change.rename_columns {
        validate_identifier("Column", &rename.from)?;
        validate_identifier("Column", &rename.to)?;
    }

    for pk in &change.set_primary_key {
        for column in &pk.columns {
            validate_identifier("Primary key column", column)?;
        }
        if let Some(name) = &pk.name {
            validate_identifier("Primary key constraint", name)?;
        }
    }

    let constraint_names: Vec<String> = change
        .add_constraints
        .iter()
        .map(|c| c.name.clone())
        .collect();
    reject_duplicates("constraint", &constraint_names)?;
    for constraint in &change.add_constraints {
        validate_identifier("Constraint", &constraint.name)?;
        if !ADD_CONSTRAINT_KINDS.contains(&constraint.constraint_type.as_str()) {
            return Err(format!(
                "Constraint kind must be one of {}",
                ADD_CONSTRAINT_KINDS.join("|")
            ));
        }
        for column in &constraint.columns {
            validate_identifier("Constraint column", column)?;
        }
        if constraint.constraint_type == "u" && constraint.columns.is_empty() {
            return Err(format!(
                "UNIQUE constraint {} requires at least one column",
                constraint.name
            ));
        }
        if constraint.constraint_type == "c" {
            let definition = constraint
                .definition
                .as_deref()
                .map(str::trim)
                .unwrap_or("");
            if definition.is_empty() {
                return Err("CHECK constraint expression must not be empty".into());
            }
            validate_ddl_text("CHECK expression", definition, MAX_CHECK_LEN)?;
        }
        if constraint.constraint_type == "x" {
            let definition = constraint
                .definition
                .as_deref()
                .map(str::trim)
                .unwrap_or("");
            if definition.is_empty() {
                return Err("Exclusion constraint requires a definition".into());
            }
            validate_ddl_text("Exclusion expression", definition, MAX_CHECK_LEN)?;
        }
    }
    for constraint in &change.drop_constraints {
        validate_identifier("Constraint", &constraint.name)?;
    }

    let index_names: Vec<String> = change.add_indexes.iter().map(|i| i.name.clone()).collect();
    reject_duplicates("index", &index_names)?;
    for index in &change.add_indexes {
        validate_identifier("Index", &index.name)?;
        if !INDEX_METHODS.contains(&index.method.as_str()) {
            return Err(format!(
                "Index method must be one of {}",
                INDEX_METHODS.join(", ")
            ));
        }
        if index.columns.is_empty() {
            return Err(format!("Index {} requires at least one column", index.name));
        }
        for column in &index.columns {
            validate_identifier("Index column", &column.name)?;
        }
    }
    for index in &change.drop_indexes {
        validate_identifier("Index", &index.name)?;
    }

    let fk_names: Vec<String> = change
        .add_foreign_keys
        .iter()
        .map(|f| f.name.clone())
        .collect();
    reject_duplicates("foreign key", &fk_names)?;
    for fk in &change.add_foreign_keys {
        validate_identifier("Foreign key", &fk.name)?;
        if fk.columns.is_empty() {
            return Err(format!(
                "Foreign key {} requires at least one column",
                fk.name
            ));
        }
        for column in &fk.columns {
            validate_identifier("Foreign key column", column)?;
        }
        validate_identifier("Referenced schema", &fk.references.schema)?;
        validate_identifier("Referenced table", &fk.references.table)?;
        if fk.references.columns.is_empty() {
            return Err(format!(
                "Foreign key {} requires at least one referenced column",
                fk.name
            ));
        }
        for column in &fk.references.columns {
            validate_identifier("Referenced column", column)?;
        }
        if fk.columns.len() != fk.references.columns.len() {
            return Err(format!(
                "Foreign key {} must reference the same number of columns",
                fk.name
            ));
        }
        validate_fk_action("ON DELETE", &fk.on_delete)?;
        validate_fk_action("ON UPDATE", &fk.on_update)?;
    }
    for fk in &change.drop_foreign_keys {
        validate_identifier("Foreign key", &fk.name)?;
    }

    if let Some(comment) = &change.set_comment {
        validate_ddl_text("Table comment", comment, MAX_COMMENT_LEN)?;
    }

    Ok(())
}

// ── DDL statement builder (pure, unit-tested) ────────────────────────────────

/// Builds the CREATE TABLE statement sequence for new-table designer mode.
/// Column order: data type, DEFAULT, NOT NULL; then PRIMARY KEY, UNIQUE/CHECK
/// constraints, FOREIGN KEYs; then indexes and comments.
fn build_create_statements(change: &TableDesignChange) -> Vec<String> {
    let table = format!(
        "{}.{}",
        quote_identifier(&change.schema),
        quote_identifier(&change.table)
    );
    let mut cols: Vec<String> = Vec::new();
    for column in &change.add_columns {
        let mut fragment = format!(
            "{} {}",
            quote_identifier(&column.name),
            column.data_type.trim()
        );
        if let Some(default) = column
            .default
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            fragment.push_str(&format!(" DEFAULT {default}"));
        }
        if !column.nullable {
            fragment.push_str(" NOT NULL");
        }
        cols.push(fragment);
    }
    if let Some(pk) = change
        .set_primary_key
        .iter()
        .find(|p| !p.columns.is_empty())
    {
        cols.push(format!(
            "PRIMARY KEY ({})",
            pk.columns
                .iter()
                .map(|c| quote_identifier(c))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    for constraint in &change.add_constraints {
        match constraint.constraint_type.as_str() {
            "u" => cols.push(format!(
                "CONSTRAINT {} UNIQUE ({})",
                quote_identifier(&constraint.name),
                constraint
                    .columns
                    .iter()
                    .map(|c| quote_identifier(c))
                    .collect::<Vec<_>>()
                    .join(", ")
            )),
            "c" => {
                if let Some(definition) = constraint
                    .definition
                    .as_deref()
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                {
                    cols.push(format!(
                        "CONSTRAINT {} CHECK ({definition})",
                        quote_identifier(&constraint.name)
                    ));
                }
            }
            "x" => {
                // EXCLUDE definitions are emitted after CREATE TABLE below,
                // matching the existing ALTER builder's syntax.
            }
            _ => {}
        }
    }
    for fk in &change.add_foreign_keys {
        cols.push(format!(
            "CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {}.{} ({}) ON DELETE {} ON UPDATE {}",
            quote_identifier(&fk.name),
            fk.columns
                .iter()
                .map(|c| quote_identifier(c))
                .collect::<Vec<_>>()
                .join(", "),
            quote_identifier(&fk.references.schema),
            quote_identifier(&fk.references.table),
            fk.references
                .columns
                .iter()
                .map(|c| quote_identifier(c))
                .collect::<Vec<_>>()
                .join(", "),
            fk.on_delete.trim(),
            fk.on_update.trim(),
        ));
    }
    let mut stmts = vec![format!("CREATE TABLE {table} ({})", cols.join(", "))];
    for constraint in &change.add_constraints {
        if constraint.constraint_type == "x" {
            let definition = constraint
                .definition
                .as_deref()
                .map(str::trim)
                .unwrap_or("");
            stmts.push(format!(
                "ALTER TABLE {table} ADD CONSTRAINT {} EXCLUDE {definition}",
                quote_identifier(&constraint.name)
            ));
        }
    }
    for index in &change.add_indexes {
        let columns = index
            .columns
            .iter()
            .map(|c| {
                if c.desc {
                    format!("{} DESC", quote_identifier(&c.name))
                } else {
                    quote_identifier(&c.name)
                }
            })
            .collect::<Vec<_>>()
            .join(", ");
        let unique = if index.unique { "UNIQUE " } else { "" };
        stmts.push(format!(
            "CREATE {unique}INDEX {}.{} ON {table} USING {} ({columns})",
            quote_identifier(&change.schema),
            quote_identifier(&index.name),
            index.method
        ));
    }
    for column in &change.add_columns {
        if let Some(comment) = column
            .comment
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            stmts.push(format!(
                "COMMENT ON COLUMN {table}.{} IS {}",
                quote_identifier(&column.name),
                quote_literal(comment)
            ));
        }
    }
    if let Some(comment) = change.set_comment.as_deref() {
        stmts.push(format!(
            "COMMENT ON TABLE {table} IS {}",
            quote_literal(comment)
        ));
    }
    stmts
}

/// Builds the ordered ALTER statement sequence for a validated change
/// (AC-S2C-11: drop dependencies first, then columns, then new objects).
fn build_statements(change: &TableDesignChange) -> Vec<String> {
    if change.create {
        return build_create_statements(change);
    }
    let table = format!(
        "{}.{}",
        quote_identifier(&change.schema),
        quote_identifier(&change.table)
    );
    let mut stmts: Vec<String> = Vec::new();

    // 1. Drop outgoing foreign keys first (they may pin local columns).
    for fk in &change.drop_foreign_keys {
        stmts.push(format!(
            "ALTER TABLE {table} DROP CONSTRAINT {}",
            quote_identifier(&fk.name)
        ));
    }
    // 2. Drop constraints / indexes before the columns they cover.
    for constraint in &change.drop_constraints {
        stmts.push(format!(
            "ALTER TABLE {table} DROP CONSTRAINT {}",
            quote_identifier(&constraint.name)
        ));
    }
    for index in &change.drop_indexes {
        stmts.push(format!(
            "DROP INDEX {}.{}",
            quote_identifier(&change.schema),
            quote_identifier(&index.name)
        ));
    }
    // 3. Drop the primary key before dropping/altering its columns. The
    // current PK constraint name is resolved by the caller and passed in via
    // `set_primary_key` (empty columns = drop).
    // 4. Drop columns.
    for column in &change.drop_columns {
        stmts.push(format!(
            "ALTER TABLE {table} DROP COLUMN {}",
            quote_identifier(&column.name)
        ));
    }
    // 5. Add columns.
    for column in &change.add_columns {
        let mut fragment = format!(
            "ALTER TABLE {table} ADD COLUMN {} {}",
            quote_identifier(&column.name),
            column.data_type.trim()
        );
        if let Some(default) = column
            .default
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            fragment.push_str(&format!(" DEFAULT {default}"));
        }
        if !column.nullable {
            fragment.push_str(" NOT NULL");
        }
        stmts.push(fragment);
        if let Some(comment) = column
            .comment
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            stmts.push(format!(
                "COMMENT ON COLUMN {table}.{} IS {}",
                quote_identifier(&column.name),
                quote_literal(comment)
            ));
        }
    }
    // 6. Modify columns.
    for modify in &change.modify_columns {
        let column = quote_identifier(&modify.name);
        if let Some(data_type) = &modify.data_type {
            stmts.push(format!(
                "ALTER TABLE {table} ALTER COLUMN {column} TYPE {}",
                data_type.trim()
            ));
        }
        if let Some(nullable) = modify.nullable {
            if nullable {
                stmts.push(format!(
                    "ALTER TABLE {table} ALTER COLUMN {column} DROP NOT NULL"
                ));
            } else {
                stmts.push(format!(
                    "ALTER TABLE {table} ALTER COLUMN {column} SET NOT NULL"
                ));
            }
        }
        if modify.drop_default {
            stmts.push(format!(
                "ALTER TABLE {table} ALTER COLUMN {column} DROP DEFAULT"
            ));
        } else if let Some(default) = modify
            .default
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            stmts.push(format!(
                "ALTER TABLE {table} ALTER COLUMN {column} SET DEFAULT {default}"
            ));
        }
        if modify.drop_comment {
            stmts.push(format!("COMMENT ON COLUMN {table}.{column} IS ''"));
        } else if let Some(comment) = modify
            .comment
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            stmts.push(format!(
                "COMMENT ON COLUMN {table}.{column} IS {}",
                quote_literal(comment)
            ));
        }
    }
    // 7. Rename columns (after add/modify so the builder output is stable).
    for rename in &change.rename_columns {
        stmts.push(format!(
            "ALTER TABLE {table} RENAME COLUMN {} TO {}",
            quote_identifier(&rename.from),
            quote_identifier(&rename.to)
        ));
    }
    // 8. Add the new primary key (columns exist by now).
    for pk in &change.set_primary_key {
        if !pk.columns.is_empty() {
            let columns = pk
                .columns
                .iter()
                .map(|c| quote_identifier(c))
                .collect::<Vec<_>>()
                .join(", ");
            let name = pk.name.as_deref().map(quote_identifier).unwrap_or_default();
            if name.is_empty() {
                stmts.push(format!("ALTER TABLE {table} ADD PRIMARY KEY ({columns})"));
            } else {
                stmts.push(format!(
                    "ALTER TABLE {table} ADD CONSTRAINT {name} PRIMARY KEY ({columns})"
                ));
            }
        }
    }
    // 9. Add constraints.
    for constraint in &change.add_constraints {
        let name = quote_identifier(&constraint.name);
        match constraint.constraint_type.as_str() {
            "u" => {
                let columns = constraint
                    .columns
                    .iter()
                    .map(|c| quote_identifier(c))
                    .collect::<Vec<_>>()
                    .join(", ");
                stmts.push(format!(
                    "ALTER TABLE {table} ADD CONSTRAINT {name} UNIQUE ({columns})"
                ));
            }
            "c" | "x" => {
                let definition = constraint
                    .definition
                    .as_deref()
                    .map(str::trim)
                    .unwrap_or("");
                if constraint.constraint_type == "c" {
                    stmts.push(format!(
                        "ALTER TABLE {table} ADD CONSTRAINT {name} CHECK ({definition})"
                    ));
                } else {
                    stmts.push(format!(
                        "ALTER TABLE {table} ADD CONSTRAINT {name} EXCLUDE {definition}"
                    ));
                }
            }
            _ => {}
        }
    }
    // 10. Add indexes.
    for index in &change.add_indexes {
        let columns = index
            .columns
            .iter()
            .map(|c| {
                if c.desc {
                    format!("{} DESC", quote_identifier(&c.name))
                } else {
                    quote_identifier(&c.name)
                }
            })
            .collect::<Vec<_>>()
            .join(", ");
        let unique = if index.unique { "UNIQUE " } else { "" };
        stmts.push(format!(
            "CREATE {unique}INDEX {}.{} ON {table} USING {} ({columns})",
            quote_identifier(&change.schema),
            quote_identifier(&index.name),
            index.method
        ));
    }
    // 11. Add foreign keys last (referenced columns must already exist).
    for fk in &change.add_foreign_keys {
        let columns = fk
            .columns
            .iter()
            .map(|c| quote_identifier(c))
            .collect::<Vec<_>>()
            .join(", ");
        let reference = format!(
            "{}.{}",
            quote_identifier(&fk.references.schema),
            quote_identifier(&fk.references.table)
        );
        let ref_columns = fk
            .references
            .columns
            .iter()
            .map(|c| quote_identifier(c))
            .collect::<Vec<_>>()
            .join(", ");
        let mut fragment = format!(
            "ALTER TABLE {table} ADD CONSTRAINT {} FOREIGN KEY ({columns}) REFERENCES {reference} ({ref_columns})",
            quote_identifier(&fk.name)
        );
        if fk.on_delete != "NO ACTION" {
            fragment.push_str(&format!(" ON DELETE {}", fk.on_delete));
        }
        if fk.on_update != "NO ACTION" {
            fragment.push_str(&format!(" ON UPDATE {}", fk.on_update));
        }
        stmts.push(fragment);
    }
    // 12. Table comment. Some("") clears the comment; None = untouched.
    if let Some(comment) = change.set_comment.as_deref() {
        stmts.push(format!(
            "COMMENT ON TABLE {table} IS {}",
            quote_literal(comment)
        ));
    }
    stmts
}

// ── DB-dependent checks ──────────────────────────────────────────────────────

/// Resolves the current PK constraint name (for DROP before column changes).
async fn current_primary_key(
    client: &Client,
    schema: &str,
    table: &str,
) -> Result<Option<(String, Vec<String>)>, String> {
    let rows = timeout(
        QUERY_TIMEOUT,
        client.query(
            "SELECT con.conname, array_agg(a.attname ORDER BY k.ord) FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON true JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum WHERE n.nspname = $1 AND c.relname = $2 AND con.contype = 'p' GROUP BY con.conname",
            &[&schema, &table],
        ),
    )
    .await
    .map_err(|_| "Catalog query timed out")?
    .map_err(|error| format!("Failed to load primary key: {error}"))?;
    Ok(rows.first().map(|row| {
        let name: String = row.try_get(0).unwrap_or_default();
        let columns: Vec<String> = row.try_get(1).unwrap_or_default();
        (name, columns)
    }))
}

/// FK references (inbound and outbound) that pin the given columns. Returns
/// `(constraint name, child table, referenced table)` tuples — child is the
/// table the FK is defined on, referenced is the target. D-B23-6: DROP COLUMN
/// referenced by an FK is rejected, never CASCADEd.
async fn foreign_keys_pinning_columns(
    client: &Client,
    schema: &str,
    table: &str,
    columns: &[String],
) -> Result<Vec<(String, String, String)>, String> {
    if columns.is_empty() {
        return Ok(Vec::new());
    }
    let relation = format!("{}.{}", quote_identifier(schema), quote_identifier(table));
    // Map the target column names to attnums inside the table, then look for
    // FK constraints (either direction) whose key arrays overlap them.
    let name_params: Vec<String> = columns.to_vec();
    let attnum_rows = timeout(
        QUERY_TIMEOUT,
        client.query(
            "SELECT a.attnum FROM pg_attribute a WHERE a.attrelid = $1::regclass AND a.attname = ANY($2)",
            &[&relation, &name_params],
        ),
    )
    .await
    .map_err(|_| "Catalog query timed out")?
    .map_err(|error| format!("Failed to inspect columns: {error}"))?;
    let attnums: Vec<i16> = attnum_rows
        .iter()
        .filter_map(|row| row.try_get::<_, i16>(0).ok())
        .collect();
    if attnums.is_empty() {
        return Ok(Vec::new());
    }
    let rows = timeout(
        QUERY_TIMEOUT,
        client.query(
            "SELECT con.conname, con.conrelid::regclass::text, con.confrelid::regclass::text FROM pg_constraint con WHERE con.contype = 'f' AND (con.conrelid = $1::regclass OR con.confrelid = $1::regclass) AND (con.conkey::int2[] && $2::int2[] OR con.confkey::int2[] && $2::int2[])",
            &[&relation, &attnums],
        ),
    )
    .await
    .map_err(|_| "Catalog query timed out")?
    .map_err(|error| format!("Failed to inspect foreign keys: {error}"))?;
    Ok(rows
        .iter()
        .filter_map(|row| {
            let name: String = row.try_get(0).ok()?;
            let child: String = row.try_get(1).ok()?;
            let parent: String = row.try_get(2).ok()?;
            Some((name, child, parent))
        })
        .collect())
}

/// Whether the table currently contains at least one row (warnings for
/// destructive drops, D-B23-5).
async fn table_has_data(client: &Client, schema: &str, table: &str) -> Result<bool, String> {
    let relation = format!("{}.{}", quote_identifier(schema), quote_identifier(table));
    let rows = timeout(
        QUERY_TIMEOUT,
        client.query(&format!("SELECT EXISTS (SELECT 1 FROM {relation})"), &[]),
    )
    .await
    .map_err(|_| "Catalog query timed out")?
    .map_err(|error| format!("Failed to inspect table data: {error}"))?;
    Ok(rows
        .first()
        .and_then(|row| row.try_get::<_, bool>(0).ok())
        .unwrap_or(false))
}

/// Server-side rejection checks that need the live catalog (D-B23-6).
/// Appends human-facing warnings for destructive-but-allowed operations.
async fn db_level_checks(
    client: &Client,
    change: &TableDesignChange,
    warnings: &mut Vec<String>,
) -> Result<(), String> {
    // DROP COLUMN pinned by any FK (ours or incoming) is rejected — unless the
    // FK itself is dropped in the same change (build order removes FKs first).
    if !change.drop_columns.is_empty() {
        let names: Vec<String> = change.drop_columns.iter().map(|c| c.name.clone()).collect();
        let blockers =
            foreign_keys_pinning_columns(client, &change.schema, &change.table, &names).await?;
        let dropped: Vec<&str> = change
            .drop_foreign_keys
            .iter()
            .map(|fk| fk.name.as_str())
            .collect();
        if let Some((name, child, parent)) = blockers
            .iter()
            .find(|(name, _, _)| !dropped.contains(&name.as_str()))
        {
            return Err(format!(
                "column {} is referenced by foreign key {name} ({child} -> {parent}); drop the foreign key first",
                change.drop_columns[0].name
            ));
        }
    }
    // Primary-key removal with inbound FKs on those columns is rejected.
    if change
        .set_primary_key
        .iter()
        .all(|pk| pk.columns.is_empty())
    {
        let pk = current_primary_key(client, &change.schema, &change.table).await?;
        if let Some((_, pk_columns)) = pk {
            if !pk_columns.is_empty() {
                let blockers = foreign_keys_pinning_columns(
                    client,
                    &change.schema,
                    &change.table,
                    &pk_columns,
                )
                .await?;
                let dropped: Vec<&str> = change
                    .drop_foreign_keys
                    .iter()
                    .map(|fk| fk.name.as_str())
                    .collect();
                if let Some((name, child, parent)) = blockers
                    .iter()
                    .find(|(name, _, _)| !dropped.contains(&name.as_str()))
                {
                    return Err(format!(
                        "primary key is referenced by foreign key {name} ({child} -> {parent}); drop the foreign key first"
                    ));
                }
            }
        }
    }
    // Destructive drops on a table with data produce confirmation warnings.
    if !change.drop_columns.is_empty()
        && table_has_data(client, &change.schema, &change.table).await?
    {
        for column in &change.drop_columns {
            warnings.push(format!(
                "The table contains data; dropping column {} will permanently remove its values",
                column.name
            ));
        }
    }
    Ok(())
}

// ── Commands ─────────────────────────────────────────────────────────────────

/// Loads the full structured table design (columns ordered by attnum, PK,
/// constraints, indexes, FKs, comment, hasData).
#[tauri::command]
pub async fn postgres_table_design_load(
    request: PostgresTableDesignLoadRequest,
    state: State<'_, PostgresState>,
) -> Result<PostgresTableDesign, String> {
    validate_identifier("Schema", &request.schema)?;
    validate_identifier("Table", &request.table)?;
    let client = state.client(&request.connection_id).await?;

    // Gate: the table must exist and be visible (USAGE on its schema).
    let meta = timeout(
        QUERY_TIMEOUT,
        client.query_one(
            "SELECT c.oid::int8, obj_description(c.oid, 'pg_class') FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r','p') AND has_schema_privilege(n.oid, 'USAGE')",
            &[&request.schema, &request.table],
        ),
    )
    .await
    .map_err(|_| "Catalog query timed out")?
    .map_err(|error| format!("Failed to load table metadata: {error}"))?;
    let relation_oid: i64 = meta
        .try_get(0)
        .map_err(|e| format!("Failed to decode table oid: {e}"))?;
    let comment: Option<String> = meta
        .try_get(1)
        .map_err(|e| format!("Failed to decode table comment: {e}"))?;

    // Columns (attnum order) with PK membership resolved in one pass.
    let column_rows = timeout(
        QUERY_TIMEOUT,
        client.query(
            "SELECT a.attname, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull, pg_get_expr(ad.adbin, ad.adrelid), col_description(a.attrelid, a.attnum), a.attnum::int4, EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY (i.indkey)) FROM pg_attribute a LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum WHERE a.attrelid = $1::text::oid AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum LIMIT 10000",
            &[&relation_oid.to_string()],
        ),
    )
    .await
    .map_err(|_| "Catalog query timed out")?
    .map_err(|error| format!("Failed to load columns: {error}"))?;
    let mut columns = Vec::new();
    for row in &column_rows {
        columns.push(PostgresDesignColumn {
            name: row
                .try_get(0)
                .map_err(|e| format!("Failed to decode column: {e}"))?,
            data_type: row
                .try_get(1)
                .map_err(|e| format!("Failed to decode column type: {e}"))?,
            nullable: row
                .try_get(2)
                .map_err(|e| format!("Failed to decode nullability: {e}"))?,
            default: row
                .try_get(3)
                .map_err(|e| format!("Failed to decode default: {e}"))?,
            comment: row
                .try_get(4)
                .map_err(|e| format!("Failed to decode comment: {e}"))?,
            ordinal: row
                .try_get(5)
                .map_err(|e| format!("Failed to decode ordinal: {e}"))?,
            primary_key: row
                .try_get(6)
                .map_err(|e| format!("Failed to decode primary key: {e}"))?,
        });
    }

    let primary_key = current_primary_key(&client, &request.schema, &request.table)
        .await?
        .map(|(name, pk_columns)| PostgresDesignPrimaryKey {
            name,
            columns: pk_columns,
        });

    // Non-PK constraints (unique/check/exclusion) with covered column names.
    let constraint_rows = timeout(
        QUERY_TIMEOUT,
        client.query(
            "SELECT con.conname, con.contype, pg_get_constraintdef(con.oid), (SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum) FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2 AND con.contype IN ('u','c','x') ORDER BY con.conname LIMIT 10000",
            &[&request.schema, &request.table],
        ),
    )
    .await
    .map_err(|_| "Catalog query timed out")?
    .map_err(|error| format!("Failed to load constraints: {error}"))?;
    let mut constraints = Vec::new();
    for row in &constraint_rows {
        constraints.push(PostgresDesignConstraint {
            name: row
                .try_get(0)
                .map_err(|e| format!("Failed to decode constraint: {e}"))?,
            constraint_type: row
                .try_get(1)
                .map_err(|e| format!("Failed to decode constraint type: {e}"))?,
            definition: row
                .try_get(2)
                .map_err(|e| format!("Failed to decode constraint def: {e}"))?,
            columns: row
                .try_get(3)
                .map_err(|e| format!("Failed to decode constraint columns: {e}"))?,
        });
    }

    // Indexes (non-PK backing indexes).
    let index_rows = timeout(
        QUERY_TIMEOUT,
        client.query(
            "SELECT ic.relname, i.indisunique, am.amname, pg_get_indexdef(i.indexrelid), (SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum WHERE k.attnum > 0) FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_class ic ON ic.oid = i.indexrelid JOIN pg_am am ON am.oid = ic.relam JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2 AND NOT i.indisprimary ORDER BY ic.relname LIMIT 10000",
            &[&request.schema, &request.table],
        ),
    )
    .await
    .map_err(|_| "Catalog query timed out")?
    .map_err(|error| format!("Failed to load indexes: {error}"))?;
    let mut indexes = Vec::new();
    for row in &index_rows {
        indexes.push(PostgresDesignIndex {
            name: row
                .try_get(0)
                .map_err(|e| format!("Failed to decode index: {e}"))?,
            unique: row
                .try_get(1)
                .map_err(|e| format!("Failed to decode index uniqueness: {e}"))?,
            method: row
                .try_get(2)
                .map_err(|e| format!("Failed to decode index method: {e}"))?,
            definition: row
                .try_get(3)
                .map_err(|e| format!("Failed to decode index def: {e}"))?,
            columns: row.try_get(4).unwrap_or_default(),
        });
    }

    // Foreign keys with column-level mapping and referential actions.
    let fk_rows = timeout(
        QUERY_TIMEOUT,
        client.query(
            "SELECT con.conname, (SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum), ref_n.nspname, ref_c.relname, (SELECT array_agg(ra.attname ORDER BY rk.ord) FROM unnest(con.confkey) WITH ORDINALITY AS rk(attnum, ord) JOIN pg_attribute ra ON ra.attrelid = con.confrelid AND ra.attnum = rk.attnum), con.confdeltype, con.confupdtype FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_class ref_c ON ref_c.oid = con.confrelid JOIN pg_namespace ref_n ON ref_n.oid = ref_c.relnamespace WHERE n.nspname = $1 AND c.relname = $2 AND con.contype = 'f' ORDER BY con.conname LIMIT 10000",
            &[&request.schema, &request.table],
        ),
    )
    .await
    .map_err(|_| "Catalog query timed out")?
    .map_err(|error| format!("Failed to load foreign keys: {error}"))?;
    let mut foreign_keys = Vec::new();
    for row in &fk_rows {
        let on_delete_code: i8 = row
            .try_get(5)
            .map_err(|e| format!("Failed to decode FK action: {e}"))?;
        let on_update_code: i8 = row
            .try_get(6)
            .map_err(|e| format!("Failed to decode FK action: {e}"))?;
        foreign_keys.push(PostgresDesignForeignKey {
            name: row
                .try_get(0)
                .map_err(|e| format!("Failed to decode foreign key: {e}"))?,
            columns: row.try_get(1).unwrap_or_default(),
            references: PostgresDesignForeignKeyReference {
                schema: row
                    .try_get(2)
                    .map_err(|e| format!("Failed to decode reference: {e}"))?,
                table: row
                    .try_get(3)
                    .map_err(|e| format!("Failed to decode reference: {e}"))?,
                columns: row.try_get(4).unwrap_or_default(),
            },
            on_delete: fk_action_name(on_delete_code).to_string(),
            on_update: fk_action_name(on_update_code).to_string(),
        });
    }

    let has_data = table_has_data(&client, &request.schema, &request.table).await?;

    Ok(PostgresTableDesign {
        schema: request.schema,
        table: request.table,
        columns,
        primary_key,
        constraints,
        indexes,
        foreign_keys,
        comment,
        has_data,
    })
}

fn fk_action_name(code: i8) -> &'static str {
    // PG pg_constraint.confdeltype/confupdtype codes: 'a' 'r' 'c' 'n' 'd'.
    // i8 cannot appear directly as a pattern with `b'x' as i8` cast, so use
    // if/else instead of match (the file keeps alternatives open below).
    if code == b'a' as i8 {
        "NO ACTION"
    } else if code == b'r' as i8 {
        "RESTRICT"
    } else if code == b'c' as i8 {
        "CASCADE"
    } else if code == b'n' as i8 {
        "SET NULL"
    } else if code == b'd' as i8 {
        "SET DEFAULT"
    } else {
        "NO ACTION"
    }
}

/// Dry-run (confirmed=false) validates and returns the ALTER sequence without
/// executing anything; confirmed=true executes it in a single transaction
/// (any failure rolls back — D-B23-5/7).
#[tauri::command]
pub async fn postgres_table_design_apply(
    request: PostgresTableDesignApplyRequest,
    state: State<'_, PostgresState>,
) -> Result<PostgresTableDesignApplyResponse, String> {
    if state.is_read_only(&request.connection_id).await? {
        return Err("This connection is read-only; table design changes are disabled".into());
    }
    validate_change(&request.change)?;
    let client = state.client(&request.connection_id).await?;

    // No change → nothing to preview or apply.
    let is_empty = change_is_empty(&request.change);
    if is_empty {
        return Ok(PostgresTableDesignApplyResponse {
            ddl: String::new(),
            warnings: Vec::new(),
            applied: false,
        });
    }

    let mut warnings: Vec<String> = Vec::new();
    db_level_checks(&client, &request.change, &mut warnings).await?;

    // Resolve the current PK when the change removes or replaces it so the
    // DROP CONSTRAINT statement can be generated server-side.
    let mut change = request.change.clone();
    let pk_touched = !change.set_primary_key.is_empty();
    if pk_touched {
        let pk = current_primary_key(&client, &change.schema, &change.table).await?;
        if let Some((name, _)) = pk {
            // Emit DROP CONSTRAINT first when the PK is being replaced or removed.
            let dropping = change
                .set_primary_key
                .iter()
                .all(|pk| pk.columns.is_empty());
            let replacing = !dropping;
            if dropping || replacing {
                let table = format!(
                    "{}.{}",
                    quote_identifier(&change.schema),
                    quote_identifier(&change.table)
                );
                let drop_stmt = format!(
                    "ALTER TABLE {table} DROP CONSTRAINT {}",
                    quote_identifier(&name)
                );
                // Prepend: PK drop must precede column drops/changes.
                let mut stmts = vec![drop_stmt];
                stmts.extend(build_statements(&change));
                return finish_apply(
                    request.confirmed,
                    client,
                    state,
                    request.connection_id,
                    stmts,
                    warnings,
                )
                .await;
            }
        } else if change
            .set_primary_key
            .iter()
            .all(|pk| pk.columns.is_empty())
        {
            // Dropping a PK that does not exist: nothing to do for the PK part.
            change.set_primary_key.clear();
        }
    }

    let stmts = build_statements(&change);
    finish_apply(
        request.confirmed,
        client,
        state,
        request.connection_id,
        stmts,
        warnings,
    )
    .await
}

fn change_is_empty(change: &TableDesignChange) -> bool {
    change.add_columns.is_empty()
        && change.drop_columns.is_empty()
        && change.modify_columns.is_empty()
        && change.rename_columns.is_empty()
        && change.set_primary_key.is_empty()
        && change.add_constraints.is_empty()
        && change.drop_constraints.is_empty()
        && change.add_indexes.is_empty()
        && change.drop_indexes.is_empty()
        && change.add_foreign_keys.is_empty()
        && change.drop_foreign_keys.is_empty()
        && change.set_comment.is_none()
}

#[allow(clippy::too_many_arguments)]
async fn finish_apply(
    confirmed: bool,
    client: std::sync::Arc<Client>,
    state: State<'_, PostgresState>,
    connection_id: String,
    stmts: Vec<String>,
    warnings: Vec<String>,
) -> Result<PostgresTableDesignApplyResponse, String> {
    let ddl = stmts.join(";\n");
    if !confirmed {
        return Ok(PostgresTableDesignApplyResponse {
            ddl,
            warnings,
            applied: false,
        });
    }
    if stmts.is_empty() {
        return Ok(PostgresTableDesignApplyResponse {
            ddl,
            warnings,
            applied: false,
        });
    }
    // Mutual exclusion with manual transactions and concurrent saves
    // (D-B23-5, mirrors postgres_save_table_changes guards).
    {
        let modes = state
            .txn_modes
            .read()
            .map_err(|_| "Failed to read transaction state".to_string())?;
        if let Some(mode) = modes.get(&connection_id) {
            return Err(format!(
                "A transaction is already in progress on this connection ({mode}); commit or roll it back first"
            ));
        }
    }
    {
        let mut modes = state
            .txn_modes
            .write()
            .map_err(|_| "Failed to lock transaction state".to_string())?;
        modes.insert(connection_id.clone(), "design".into());
    }
    // Single transaction: BEGIN → all statements → COMMIT; any error runs an
    // explicit ROLLBACK (and the marker is always cleared).
    let begin = timeout(QUERY_TIMEOUT, client.batch_execute("BEGIN"))
        .await
        .map_err(|_| "Table design apply timed out while starting the transaction");
    if let Err(error) = begin {
        clear_design_marker(&state, &connection_id);
        return Err(error.to_string());
    }
    for stmt in &stmts {
        // Extended protocol: multi-statement text is structurally rejected.
        let result = timeout(QUERY_TIMEOUT, client.execute(stmt, &[])).await;
        match result {
            Ok(Ok(_)) => {}
            Ok(Err(error)) => {
                clear_design_marker(&state, &connection_id);
                let _ = timeout(QUERY_TIMEOUT, client.batch_execute("ROLLBACK")).await;
                tracing::warn!("table design apply failed, rolled back: {error}");
                return Err(format!("Failed to apply table design: {error}"));
            }
            Err(_) => {
                clear_design_marker(&state, &connection_id);
                let _ = timeout(QUERY_TIMEOUT, client.batch_execute("ROLLBACK")).await;
                return Err("Table design apply timed out; all changes were rolled back".into());
            }
        }
    }
    let commit = timeout(QUERY_TIMEOUT, client.batch_execute("COMMIT"))
        .await
        .map_err(|_| "Table design apply timed out while committing");
    if let Err(error) = commit {
        clear_design_marker(&state, &connection_id);
        let _ = timeout(QUERY_TIMEOUT, client.batch_execute("ROLLBACK")).await;
        return Err(error.to_string());
    }
    clear_design_marker(&state, &connection_id);
    Ok(PostgresTableDesignApplyResponse {
        ddl,
        warnings,
        applied: true,
    })
}

fn clear_design_marker(state: &State<'_, PostgresState>, connection_id: &str) {
    if let Ok(mut modes) = state.txn_modes.write() {
        modes.remove(connection_id);
    }
}

/// Saves a view definition as `CREATE OR REPLACE VIEW` (D-B23-9).
/// The definition is user-edited SQL that cannot be parameterized; guards:
/// single statement, must start with SELECT/WITH, readOnly rejected, explicit
/// confirmation required.
#[tauri::command]
pub async fn postgres_view_save(
    request: PostgresViewSaveRequest,
    state: State<'_, PostgresState>,
) -> Result<(), String> {
    if state.is_read_only(&request.connection_id).await? {
        return Err("This connection is read-only; view changes are disabled".into());
    }
    if !request.confirmed {
        return Err("View save requires confirmation".into());
    }
    validate_identifier("Schema", &request.schema)?;
    validate_identifier("View", &request.name)?;
    let definition = request.definition.trim();
    if definition.is_empty() {
        return Err("View definition must not be empty".into());
    }
    if definition.len() > 512 * 1024 {
        return Err("View definition exceeds the maximum size".into());
    }
    // Exactly one statement (semicolons inside strings/comments/dollar-quotes
    // are tolerated — same lexer as postgres.rs `single_statement`).
    let single = crate::postgres::single_statement(definition)?;
    let head = single.trim_start().to_ascii_uppercase();
    if !head.starts_with("SELECT") && !head.starts_with("WITH") {
        return Err("View definition must be a SELECT or WITH query".into());
    }
    let client = state.client(&request.connection_id).await?;
    {
        let modes = state
            .txn_modes
            .read()
            .map_err(|_| "Failed to read transaction state".to_string())?;
        if let Some(mode) = modes.get(&request.connection_id) {
            return Err(format!(
                "A transaction is already in progress on this connection ({mode})"
            ));
        }
    }
    let statement = format!(
        "CREATE OR REPLACE VIEW {}.{} AS {}",
        quote_identifier(&request.schema),
        quote_identifier(&request.name),
        single
    );
    // Audit without the definition body (may embed sensitive literals).
    tracing::info!("CREATE OR REPLACE VIEW {}.{}", request.schema, request.name);
    timeout(QUERY_TIMEOUT, client.execute(&statement, &[]))
        .await
        .map_err(|_| "View save timed out")?
        .map_err(|error| format!("Failed to save view: {error}"))?;
    Ok(())
}

/// Lists selectable data types for the designer dropdown: pg_catalog base
/// types plus custom enum/domain/composite types visible in `schema`
/// (AC-S2A-3, ≥20 standard types guaranteed by the catalog itself).
#[tauri::command]
pub async fn postgres_pg_types(
    request: PostgresPgTypesRequest,
    state: State<'_, PostgresState>,
) -> Result<Vec<String>, String> {
    validate_identifier("Schema", &request.schema)?;
    let client = state.client(&request.connection_id).await?;
    let rows = timeout(
        QUERY_TIMEOUT,
        client.query(
            "SELECT format_type(t.oid, NULL) FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE ((n.nspname = 'pg_catalog' AND t.typtype = 'b' AND t.typcategory NOT IN ('A','P')) OR (n.nspname = $1 AND t.typtype IN ('e','d','c') AND has_schema_privilege(n.oid, 'USAGE'))) ORDER BY 1 LIMIT 10000",
            &[&request.schema],
        ),
    )
    .await
    .map_err(|_| "Catalog query timed out")?
    .map_err(|error| format!("Failed to load data types: {error}"))?;
    let mut types = Vec::new();
    for row in rows {
        if let Ok(name) = row.try_get::<_, String>(0) {
            types.push(name);
        }
    }
    Ok(types)
}

// ── Unit tests (pure builder/validation, AC-S2C-11) ─────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn change(schema: &str, table: &str) -> TableDesignChange {
        TableDesignChange {
            schema: schema.into(),
            table: table.into(),
            ..Default::default()
        }
    }

    fn column(name: &str, data_type: &str, nullable: bool) -> ColumnDef {
        ColumnDef {
            name: name.into(),
            data_type: data_type.into(),
            nullable,
            default: None,
            comment: None,
        }
    }

    #[test]
    fn add_column_builds_alter_add_column() {
        let mut change = change("public", "orders");
        change.add_columns.push(column("notes", "text", true));
        let stmts = build_statements(&change);
        assert_eq!(
            stmts,
            vec![r#"ALTER TABLE "public"."orders" ADD COLUMN "notes" text"#]
        );
    }

    #[test]
    fn add_column_with_default_and_not_null() {
        let mut change = change("public", "orders");
        change.add_columns.push(ColumnDef {
            name: "qty".into(),
            data_type: "integer".into(),
            nullable: false,
            default: Some("1".into()),
            comment: Some("quantity".into()),
        });
        let stmts = build_statements(&change);
        assert_eq!(
            stmts[0],
            r#"ALTER TABLE "public"."orders" ADD COLUMN "qty" integer DEFAULT 1 NOT NULL"#
        );
        assert_eq!(
            stmts[1],
            r#"COMMENT ON COLUMN "public"."orders"."qty" IS 'quantity'"#
        );
    }

    #[test]
    fn create_table_includes_designer_objects_and_comments() {
        let mut change = change("public", "new_orders");
        change.create = true;
        change.add_columns.push(ColumnDef {
            name: "id".into(),
            data_type: "integer".into(),
            nullable: false,
            default: Some("1".into()),
            comment: Some("identifier".into()),
        });
        change.set_primary_key.push(SetPrimaryKey {
            name: None,
            columns: vec!["id".into()],
        });
        change.add_indexes.push(AddIndex {
            name: "new_orders_id_idx".into(),
            unique: true,
            method: "btree".into(),
            columns: vec![IndexColumn {
                name: "id".into(),
                desc: true,
            }],
        });
        change.set_comment = Some("new order records".into());

        assert_eq!(
            build_statements(&change),
            vec![
                r#"CREATE TABLE "public"."new_orders" ("id" integer DEFAULT 1 NOT NULL, PRIMARY KEY ("id"))"#,
                r#"CREATE UNIQUE INDEX "public"."new_orders_id_idx" ON "public"."new_orders" USING btree ("id" DESC)"#,
                r#"COMMENT ON COLUMN "public"."new_orders"."id" IS 'identifier'"#,
                r#"COMMENT ON TABLE "public"."new_orders" IS 'new order records'"#,
            ]
        );
    }

    #[test]
    fn drop_column_builds_alter_drop_column() {
        let mut change = change("public", "orders");
        change.drop_columns.push(DropColumn {
            name: "score".into(),
        });
        let stmts = build_statements(&change);
        assert_eq!(
            stmts,
            vec![r#"ALTER TABLE "public"."orders" DROP COLUMN "score""#]
        );
    }

    #[test]
    fn modify_column_type_not_null_default() {
        let mut change = change("public", "orders");
        change.modify_columns.push(ModifyColumn {
            name: "score".into(),
            data_type: Some("bigint".into()),
            nullable: Some(false),
            default: None,
            drop_default: false,
            comment: None,
            drop_comment: false,
        });
        let stmts = build_statements(&change);
        assert_eq!(
            stmts,
            vec![
                r#"ALTER TABLE "public"."orders" ALTER COLUMN "score" TYPE bigint"#,
                r#"ALTER TABLE "public"."orders" ALTER COLUMN "score" SET NOT NULL"#,
            ]
        );
    }

    #[test]
    fn modify_column_drop_not_null_and_drop_default() {
        let mut change = change("public", "orders");
        change.modify_columns.push(ModifyColumn {
            name: "score".into(),
            data_type: None,
            nullable: Some(true),
            default: None,
            drop_default: true,
            drop_comment: false,
            comment: None,
        });
        let stmts = build_statements(&change);
        assert_eq!(
            stmts,
            vec![
                r#"ALTER TABLE "public"."orders" ALTER COLUMN "score" DROP NOT NULL"#,
                r#"ALTER TABLE "public"."orders" ALTER COLUMN "score" DROP DEFAULT"#,
            ]
        );
    }

    #[test]
    fn modify_column_drop_comment_clears_comment() {
        let mut change = change("public", "orders");
        change.modify_columns.push(ModifyColumn {
            name: "score".into(),
            data_type: None,
            nullable: None,
            default: None,
            drop_default: false,
            drop_comment: true,
            comment: None,
        });
        let stmts = build_statements(&change);
        assert_eq!(
            stmts,
            vec![r#"COMMENT ON COLUMN "public"."orders"."score" IS ''"#]
        );
    }

    #[test]
    fn table_comment_clear_with_empty_string_and_set_with_text() {
        let mut clear = change("public", "orders");
        clear.set_comment = Some("".into());
        assert_eq!(
            build_statements(&clear),
            vec![r#"COMMENT ON TABLE "public"."orders" IS ''"#]
        );
        let mut set = change("public", "orders");
        set.set_comment = Some("annual report".into());
        assert_eq!(
            build_statements(&set),
            vec![r#"COMMENT ON TABLE "public"."orders" IS 'annual report'"#]
        );
        // None (unchanged) emits nothing.
        let untouched = change("public", "orders");
        assert!(build_statements(&untouched).is_empty());
    }

    #[test]
    fn add_and_drop_index_statements() {
        let mut change = change("public", "orders");
        change.add_indexes.push(AddIndex {
            name: "idx_orders_score".into(),
            unique: false,
            method: "btree".into(),
            columns: vec![IndexColumn {
                name: "score".into(),
                desc: true,
            }],
        });
        change.drop_indexes.push(DropNamed {
            name: "idx_orders_name".into(),
        });
        let stmts = build_statements(&change);
        assert_eq!(stmts[0], r#"DROP INDEX "public"."idx_orders_name""#);
        assert_eq!(
            stmts[1],
            r#"CREATE INDEX "public"."idx_orders_score" ON "public"."orders" USING btree ("score" DESC)"#
        );
    }

    #[test]
    fn add_foreign_key_with_cascade() {
        let mut change = change("public", "orders");
        change.add_foreign_keys.push(ForeignKeyDef {
            name: "fk_orders_customer".into(),
            columns: vec!["customer_id".into()],
            references: ForeignKeyReferenceDef {
                schema: "public".into(),
                table: "customers".into(),
                columns: vec!["id".into()],
            },
            on_delete: "CASCADE".into(),
            on_update: "NO ACTION".into(),
        });
        let stmts = build_statements(&change);
        assert_eq!(
            stmts,
            vec![
                r#"ALTER TABLE "public"."orders" ADD CONSTRAINT "fk_orders_customer" FOREIGN KEY ("customer_id") REFERENCES "public"."customers" ("id") ON DELETE CASCADE"#
            ]
        );
    }

    #[test]
    fn add_check_constraint() {
        let mut change = change("public", "orders");
        change.add_constraints.push(AddConstraint {
            name: "orders_score_check".into(),
            constraint_type: "c".into(),
            columns: vec!["score".into()],
            definition: Some("score > 0".into()),
        });
        let stmts = build_statements(&change);
        assert_eq!(
            stmts,
            vec![
                r#"ALTER TABLE "public"."orders" ADD CONSTRAINT "orders_score_check" CHECK (score > 0)"#
            ]
        );
    }

    #[test]
    fn drop_order_fk_before_columns_before_adds() {
        let mut change = change("public", "orders");
        change.drop_foreign_keys.push(DropNamed {
            name: "fk_a".into(),
        });
        change.drop_columns.push(DropColumn { name: "old".into() });
        change.add_columns.push(column("new", "text", true));
        change.add_foreign_keys.push(ForeignKeyDef {
            name: "fk_b".into(),
            columns: vec!["new".into()],
            references: ForeignKeyReferenceDef {
                schema: "public".into(),
                table: "customers".into(),
                columns: vec!["id".into()],
            },
            on_delete: "NO ACTION".into(),
            on_update: "NO ACTION".into(),
        });
        let stmts = build_statements(&change);
        assert!(stmts[0].contains("DROP CONSTRAINT \"fk_a\""));
        assert!(stmts[1].contains("DROP COLUMN \"old\""));
        assert!(stmts[2].contains("ADD COLUMN \"new\""));
        assert!(stmts[3].contains("ADD CONSTRAINT \"fk_b\""));
    }

    #[test]
    fn identifier_injection_is_escaped() {
        let mut change = change("public", "orders");
        change
            .add_columns
            .push(column("x; DROP TABLE users; --", "text", true));
        let stmts = build_statements(&change);
        assert_eq!(
            stmts,
            vec![r#"ALTER TABLE "public"."orders" ADD COLUMN "x; DROP TABLE users; --" text"#]
        );
        // The whole payload stays a single quoted identifier.
        assert_eq!(stmts[0].matches('"').count(), 6);
    }

    #[test]
    fn schema_with_quote_is_escaped() {
        let mut change = change("od\"d", "orders");
        change.drop_columns.push(DropColumn {
            name: "score".into(),
        });
        let stmts = build_statements(&change);
        assert_eq!(
            stmts[0],
            r#"ALTER TABLE "od""d"."orders" DROP COLUMN "score""#
        );
    }

    #[test]
    fn comment_literal_is_escaped() {
        let mut change = change("public", "orders");
        change.set_comment = Some("it's fine".into());
        let stmts = build_statements(&change);
        assert_eq!(
            stmts,
            vec![r#"COMMENT ON TABLE "public"."orders" IS 'it''s fine'"#]
        );
    }

    #[test]
    fn validate_rejects_empty_names() {
        let mut change = change("public", "orders");
        change.add_columns.push(column("  ", "text", true));
        assert!(validate_change(&change).is_err());
    }

    #[test]
    fn validate_create_requires_columns_and_rejects_alter_operations() {
        let mut empty = change("public", "new_table");
        empty.create = true;
        assert!(validate_change(&empty)
            .unwrap_err()
            .contains("at least one column"));

        let mut invalid = change("public", "new_table");
        invalid.create = true;
        invalid.add_columns.push(column("id", "integer", false));
        invalid.drop_columns.push(DropColumn { name: "old".into() });
        assert!(validate_change(&invalid)
            .unwrap_err()
            .contains("cannot include"));
    }

    #[test]
    fn validate_rejects_duplicate_column_names() {
        let mut change = change("public", "orders");
        change.add_columns.push(column("notes", "text", true));
        change.add_columns.push(column("notes", "text", true));
        let error = validate_change(&change).unwrap_err();
        assert!(error.contains("Duplicate column"), "{error}");
    }

    #[test]
    fn validate_rejects_injected_data_type() {
        let mut change = change("public", "orders");
        change
            .add_columns
            .push(column("notes", "text; DROP TABLE x", true));
        assert!(validate_change(&change).is_err());
    }

    #[test]
    fn validate_rejects_unknown_fk_action() {
        let mut change = change("public", "orders");
        change.add_foreign_keys.push(ForeignKeyDef {
            name: "fk".into(),
            columns: vec!["customer_id".into()],
            references: ForeignKeyReferenceDef {
                schema: "public".into(),
                table: "customers".into(),
                columns: vec!["id".into()],
            },
            on_delete: "TRUNCATE".into(),
            on_update: "NO ACTION".into(),
        });
        assert!(validate_change(&change).is_err());
    }

    #[test]
    fn validate_rejects_empty_check_expression() {
        let mut change = change("public", "orders");
        change.add_constraints.push(AddConstraint {
            name: "chk".into(),
            constraint_type: "c".into(),
            columns: vec!["score".into()],
            definition: Some("   ".into()),
        });
        let error = validate_change(&change).unwrap_err();
        assert!(error.contains("CHECK"), "{error}");
    }

    #[test]
    fn validate_rejects_overlong_identifier() {
        let mut change = change("public", "orders");
        let long = "a".repeat(64);
        change.add_columns.push(column(&long, "text", true));
        assert!(validate_change(&change).is_err());
    }

    #[test]
    fn validate_rejects_unknown_index_method() {
        let mut change = change("public", "orders");
        change.add_indexes.push(AddIndex {
            name: "idx".into(),
            unique: false,
            method: "nope".into(),
            columns: vec![IndexColumn {
                name: "score".into(),
                desc: false,
            }],
        });
        assert!(validate_change(&change).is_err());
    }

    #[test]
    fn change_is_empty_detects_noop() {
        assert!(change_is_empty(&change("public", "orders")));
        let mut with_comment = change("public", "orders");
        with_comment.set_comment = Some("x".into());
        assert!(!change_is_empty(&with_comment));
    }

    // ── View-builder definition guards (D-B23-9) ──────────────────────────

    #[test]
    fn view_definition_must_start_with_select_or_with() {
        // Pure check: definition must begin with SELECT / WITH (case-insensitive,
        // leading whitespace tolerated). We feed exact strings that the body of
        // `postgres_view_save` is expected to accept or reject; if `single_statement`
        // throws (e.g. multi-statement input) we treat the case as "rejected".
        fn accept(definition: &str) -> bool {
            // Mirror the gates inside postgres_view_save; we do not need a real DB.
            let definition = definition.trim();
            if definition.is_empty() {
                return false;
            }
            let single = match crate::postgres::single_statement(definition) {
                Ok(body) => body,
                Err(_) => return false,
            };
            let head = single.trim_start().to_ascii_uppercase();
            head.starts_with("SELECT") || head.starts_with("WITH")
        }

        assert!(accept("SELECT 1"));
        assert!(accept("select id from users"));
        assert!(accept("  WITH t AS (SELECT 1) SELECT * FROM t"));
        assert!(accept("WITH RECURSIVE t AS (SELECT 1) SELECT * FROM t"));
        // Multi-statement (semicolon boundary) is rejected by single_statement.
        assert!(!accept("SELECT 1; DROP TABLE users"));
        // Non-SELECT/WITH prefix is rejected.
        assert!(!accept("INSERT INTO users VALUES (1)"));
        assert!(!accept("UPDATE users SET id = 1"));
        assert!(!accept("DELETE FROM users"));
        // Empty is rejected.
        assert!(!accept(""));
        assert!(!accept("   "));
    }
}
