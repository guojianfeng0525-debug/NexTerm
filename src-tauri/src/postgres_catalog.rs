//! PostgreSQL catalog-domain commands (B21 navigator object coverage).
//!
//! Per architecture constraint D-B21-4 this module deliberately does NOT
//! extend `postgres_catalog_search` (a completion command with LIMIT + ILIKE
//! semantics). The navigator needs exact-schema, full-group listings, so the
//! commands live here instead and keep the narrow command boundary: kind
//! whitelisting, parameterized catalog queries, `has_schema_privilege`
//! guards and server-side oid resolution (clients never pass oids or raw SQL).
//!
//! Security constraints §1 (catalog queries), §2 (destructive operations) and
//! §3 (DDL preview passthrough) all apply.

use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::time::timeout;
use tokio_postgres::Client;

use crate::postgres::{quote_identifier, PostgresState, QUERY_TIMEOUT};

/// Upper bound for any single catalog group listing. The navigator requests
/// whole groups (architecture D-B21-4), but a runaway schema must not return
/// an unbounded payload, so every query carries a fixed ceiling.
const CATALOG_GROUP_LIMIT: i64 = 10_000;
/// DDL preview truncation ceiling (security constraint §3.1).
const DDL_MAX_LEN: usize = 512 * 1024;

/// Whitelisted object kinds understood by `postgres_catalog_objects`.
const CATALOG_OBJECT_KINDS: [&str; 6] = [
    "functions",
    "sequences",
    "indexes",
    "constraints",
    "triggers",
    "columns",
];

/// Whitelisted object types for DDL preview / properties.
const DDL_OBJECT_TYPES: [&str; 9] = [
    "table",
    "view",
    "materializedView",
    "function",
    "sequence",
    "index",
    "constraint",
    "trigger",
    "column",
];

/// Whitelisted drop kinds for `postgres_drop_object`.
const DROP_OBJECT_KINDS: [&str; 8] = [
    "table",
    "view",
    "materializedView",
    "function",
    "sequence",
    "index",
    "constraint",
    "trigger",
];

// ── Requests / responses ─────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostgresCatalogObjectsRequest {
    pub connection_id: String,
    /// One of: functions | sequences | indexes | constraints | triggers | columns.
    pub kind: String,
    pub schema: String,
    /// Table name; required for indexes/constraints/triggers/columns.
    pub relation: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PostgresCatalogObject {
    pub kind: String,
    pub schema: String,
    pub name: String,
    /// Function identity arguments (overload disambiguation).
    pub signature: Option<String>,
    /// Owning table (indexes/constraints/triggers/columns).
    pub relation: Option<String>,
    /// Constraint type code (p/f/u/c/x) for constraints.
    pub object_type: Option<String>,
    /// Formatted server type (columns).
    pub data_type: Option<String>,
    /// `true` when the column is nullable (columns).
    pub nullable: Option<bool>,
    /// Column default expression, raw text (columns).
    pub default: Option<String>,
    /// Physical column ordinal (columns).
    pub ordinal: Option<i32>,
    /// `true` when the column is part of the table's primary key (columns).
    pub is_primary_key: Option<bool>,
    /// Column comment from `col_description` (columns).
    pub comment: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostgresObjectPropsRequest {
    pub connection_id: String,
    /// One of the DDL object types (function/sequence/index/constraint/trigger/column).
    pub object_type: String,
    pub schema: String,
    pub name: String,
    /// Owning table for index/constraint/trigger/column.
    pub relation: Option<String>,
    /// Function identity arguments for overload disambiguation.
    pub signature: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostgresObjectProp {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostgresObjectProps {
    pub props: Vec<PostgresObjectProp>,
    pub ddl: Option<String>,
    pub truncated: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostgresObjectDdlRequest {
    pub connection_id: String,
    pub object_type: String,
    pub schema: String,
    pub name: String,
    pub relation: Option<String>,
    pub signature: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostgresObjectDdl {
    pub ddl: String,
    pub truncated: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostgresDropObjectRequest {
    pub connection_id: String,
    pub kind: String,
    pub schema: String,
    pub name: String,
    /// Owning table for constraint/trigger.
    pub relation: Option<String>,
    /// Function identity arguments for overload disambiguation.
    pub signature: Option<String>,
    #[serde(default)]
    pub cascade: bool,
    #[serde(default)]
    pub confirmed: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostgresDropObjectResponse {
    pub object_exists: bool,
    pub dependent_count: Option<i64>,
    pub sample_dependents: Vec<String>,
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/// Validates that `schema` exists and the session holds USAGE on it
/// (security constraint §1.1 — gate before any derived query).
async fn require_schema(client: &Client, schema: &str) -> Result<(), String> {
    let rows = timeout(
        QUERY_TIMEOUT,
        client.query(
            "SELECT 1 FROM pg_namespace WHERE nspname = $1 AND has_schema_privilege(oid, 'USAGE')",
            &[&schema],
        ),
    )
    .await
    .map_err(|_| "Catalog query timed out")?
    .map_err(|error| format!("Failed to validate schema: {error}"))?;
    if rows.is_empty() {
        return Err("schema does not exist".to_string());
    }
    Ok(())
}

/// Resolves the object oid through a whitelisted, parameterized lookup.
/// Returns `None` when the object does not exist (or is invisible to the
/// session) — the caller decides whether that is an error or a dry-run.
async fn resolve_object_oid(
    client: &Client,
    kind: &str,
    schema: &str,
    name: &str,
    relation: Option<&str>,
    signature: Option<&str>,
) -> Result<Option<i64>, String> {
    let rows = match kind {
        "table" => client
            .query("SELECT c.oid::int8 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r','p') AND has_schema_privilege(n.oid, 'USAGE')", &[&schema, &name])
            .await,
        "view" => client
            .query("SELECT c.oid::int8 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'v' AND has_schema_privilege(n.oid, 'USAGE')", &[&schema, &name])
            .await,
        "materializedView" => client
            .query("SELECT c.oid::int8 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'm' AND has_schema_privilege(n.oid, 'USAGE')", &[&schema, &name])
            .await,
        "sequence" => client
            .query("SELECT c.oid::int8 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'S' AND has_schema_privilege(n.oid, 'USAGE')", &[&schema, &name])
            .await,
        "index" => client
            .query("SELECT c.oid::int8 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'i' AND has_schema_privilege(n.oid, 'USAGE')", &[&schema, &name])
            .await,
        "function" => {
            let signature = signature.unwrap_or_default();
            client
                .query("SELECT p.oid::int8 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND p.proname = $2 AND pg_get_function_identity_arguments(p.oid) = $3 AND has_schema_privilege(n.oid, 'USAGE')", &[&schema, &name, &signature])
                .await
        }
        "constraint" | "trigger" | "column" => {
            let relation = relation.ok_or_else(|| "Owning table is required".to_string())?;
            let sql = match kind {
                "constraint" => "SELECT con.oid::int8 FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND con.conname = $2 AND c.relname = $3 AND has_schema_privilege(n.oid, 'USAGE')",
                "trigger" => "SELECT t.oid::int8 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND t.tgname = $2 AND c.relname = $3 AND NOT t.tgisinternal AND has_schema_privilege(n.oid, 'USAGE')",
                _ => "SELECT a.attrelid::int8 FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2 AND a.attname = $3 AND a.attnum > 0 AND NOT a.attisdropped AND has_schema_privilege(n.oid, 'USAGE')",
            };
            client.query(sql, &[&schema, &name, &relation]).await
        }
        _ => return Err("Unsupported PostgreSQL object kind".into()),
    }
    .map_err(|error| format!("Failed to resolve object: {error}"))?;
    Ok(rows.first().and_then(|row| row.try_get::<_, i64>(0).ok()))
}

/// Counts objects that depend on the given oid (normal dependencies only),
/// sampling up to 5 names for the confirmation dialog (security §2.2).
async fn dependent_summary(client: &Client, oid: i64) -> Result<(i64, Vec<String>), String> {
    let count_rows = timeout(
        QUERY_TIMEOUT,
        client.query(
            "SELECT count(*) FROM pg_depend d WHERE d.refobjid = $1::text::oid AND d.deptype = 'n' AND d.classid = 'pg_class'::regclass AND d.refclassid = 'pg_class'::regclass",
            &[&oid_param(oid)],
        ),
    )
    .await
    .map_err(|_| "Catalog query timed out")?
    .map_err(|error| format!("Failed to count dependencies: {error}"))?;
    let count: i64 = count_rows
        .first()
        .and_then(|row| row.try_get::<_, i64>(0).ok())
        .unwrap_or(0);
    let sample_rows = timeout(
        QUERY_TIMEOUT,
        client.query(
            "SELECT DISTINCT c.relname FROM pg_depend d JOIN pg_class c ON c.oid = d.objid WHERE d.refobjid = $1::text::oid AND d.deptype = 'n' AND d.classid = 'pg_class'::regclass AND d.refclassid = 'pg_class'::regclass ORDER BY c.relname LIMIT 5",
            &[&oid_param(oid)],
        ),
    )
    .await
    .map_err(|_| "Catalog query timed out")?
    .map_err(|error| format!("Failed to sample dependencies: {error}"))?;
    let mut samples = Vec::new();
    for row in sample_rows {
        if let Ok(name) = row.try_get::<_, String>(0) {
            samples.push(name);
        }
    }
    Ok((count, samples))
}

/// Maps a system-function error for non-owners to a generic message so the
/// underlying error text (which may carry object/line details) is never
/// passed through (security constraint §1.2).
fn map_ddl_privilege_error(kind: &str, schema: &str, name: &str, error_text: &str) -> String {
    let lower = error_text.to_lowercase();
    if lower.contains("insufficient privilege") || lower.contains("permission denied") {
        format!("insufficient privilege to view definition of {kind} {schema}.{name}")
    } else {
        // Log the raw catalog error for diagnostics without exposing it over
        // IPC (security §1.2: never pass underlying error text to the UI).
        tracing::warn!("catalog definition error for {kind} {schema}.{name}: {error_text}");
        "Failed to load definition".to_string()
    }
}
fn truncate_ddl(ddl: String) -> (String, bool) {
    if ddl.len() <= DDL_MAX_LEN {
        (ddl, false)
    } else {
        (ddl[..DDL_MAX_LEN].to_string(), true)
    }
}

/// Binds an object oid as its decimal string; `$1::text::oid` round-trips
/// through the extended protocol without serializing an int8 against an oid
/// column (which tokio_postgres rejects with "error serializing parameter").
fn oid_param(oid: i64) -> String {
    oid.to_string()
}

/// Builds the `CREATE SEQUENCE` definition from catalog rows (no system
/// function exists for sequence DDL — architecture D-B21-8).
async fn sequence_ddl(client: &Client, schema: &str, name: &str) -> Result<String, String> {
    let rows = timeout(
        QUERY_TIMEOUT,
        client.query(
            "SELECT s.seqstart, s.seqincrement, s.seqmax, s.seqmin, s.seqcache, s.seqcycle FROM pg_sequence s JOIN pg_class c ON c.oid = s.seqrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2 AND has_schema_privilege(n.oid, 'USAGE')",
            &[&schema, &name],
        ),
    )
    .await
    .map_err(|_| "Catalog query timed out")?
    .map_err(|error| format!("Failed to load sequence definition: {error}"))?;
    let row = rows
        .first()
        .ok_or_else(|| format!("Sequence {schema}.{name} does not exist"))?;
    let start: i64 = row
        .try_get(0)
        .map_err(|e| format!("Failed to decode sequence: {e}"))?;
    let increment: i64 = row
        .try_get(1)
        .map_err(|e| format!("Failed to decode sequence: {e}"))?;
    let max: i64 = row
        .try_get(2)
        .map_err(|e| format!("Failed to decode sequence: {e}"))?;
    let min: i64 = row
        .try_get(3)
        .map_err(|e| format!("Failed to decode sequence: {e}"))?;
    let cache: i64 = row
        .try_get(4)
        .map_err(|e| format!("Failed to decode sequence: {e}"))?;
    let cycle: bool = row
        .try_get(5)
        .map_err(|e| format!("Failed to decode sequence: {e}"))?;
    let mut ddl = format!(
        "CREATE SEQUENCE {}.{}\n    START WITH {}\n    INCREMENT BY {}\n    MINVALUE {}\n    MAXVALUE {}\n    CACHE {}",
        quote_identifier(schema),
        quote_identifier(name),
        start,
        increment,
        min,
        max,
        cache,
    );
    if cycle {
        ddl.push_str("\n    CYCLE");
    }
    Ok(ddl)
}

/// Builds a `CREATE TABLE` definition by composing column/constraint/index
/// fragments (architecture D-B21-8, AC-21C-3). Column and table comments are
/// appended as `COMMENT ON` statements so the generated DDL round-trips the
/// schema's documentation (DBeaver parity).
async fn table_ddl(client: &Client, schema: &str, name: &str) -> Result<String, String> {
    let columns = timeout(
        QUERY_TIMEOUT,
        client.query(
            "SELECT a.attname, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull, pg_get_expr(ad.adbin, ad.adrelid), pg_catalog.col_description(c.oid, a.attnum) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped AND has_schema_privilege(n.oid, 'USAGE') ORDER BY a.attnum",
            &[&schema, &name],
        ),
    )
    .await
    .map_err(|_| "Catalog query timed out")?
    .map_err(|error| format!("Failed to load table definition: {error}"))?;
    let constraints = timeout(
        QUERY_TIMEOUT,
        client.query(
            "SELECT con.conname, pg_get_constraintdef(con.oid) FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2 AND has_schema_privilege(n.oid, 'USAGE') ORDER BY con.conname",
            &[&schema, &name],
        ),
    )
    .await
    .map_err(|_| "Catalog query timed out")?
    .map_err(|error| format!("Failed to load table constraints: {error}"))?;
    let indexes = timeout(
        QUERY_TIMEOUT,
        client.query(
            "SELECT pg_get_indexdef(i.indexrelid) FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_class ic ON ic.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2 AND i.indisvalid AND has_schema_privilege(n.oid, 'USAGE') ORDER BY ic.relname",
            &[&schema, &name],
        ),
    )
    .await
    .map_err(|_| "Catalog query timed out")?
    .map_err(|error| format!("Failed to load table indexes: {error}"))?;

    let mut body: Vec<String> = Vec::new();
    // Column comments collected while composing the body, emitted as
    // `COMMENT ON COLUMN` statements after the CREATE TABLE (index-order).
    let mut column_comments: Vec<(String, String)> = Vec::new();
    for row in &columns {
        let column_name: String = row
            .try_get(0)
            .map_err(|e| format!("Failed to decode column: {e}"))?;
        let data_type: String = row
            .try_get(1)
            .map_err(|e| format!("Failed to decode column type: {e}"))?;
        let nullable: bool = row
            .try_get(2)
            .map_err(|e| format!("Failed to decode nullability: {e}"))?;
        let default: Option<String> = row
            .try_get(3)
            .map_err(|e| format!("Failed to decode default: {e}"))?;
        let comment: Option<String> = row
            .try_get(4)
            .map_err(|e| format!("Failed to decode column comment: {e}"))?;
        let mut fragment = format!("    {} {}", quote_identifier(&column_name), data_type);
        if let Some(default) = default.filter(|value| !value.is_empty()) {
            fragment.push_str(&format!(" DEFAULT {default}"));
        }
        if !nullable {
            fragment.push_str(" NOT NULL");
        }
        body.push(fragment);
        if let Some(comment) = comment.filter(|value| !value.trim().is_empty()) {
            column_comments.push((column_name, comment));
        }
    }
    for row in &constraints {
        let constraint_name: String = row
            .try_get(0)
            .map_err(|e| format!("Failed to decode constraint: {e}"))?;
        let definition: String = row
            .try_get(1)
            .map_err(|e| format!("Failed to decode constraint def: {e}"))?;
        body.push(format!(
            "    CONSTRAINT {} {}",
            quote_identifier(&constraint_name),
            definition
        ));
    }
    let mut ddl = format!(
        "CREATE TABLE {}.{} (\n{}\n);",
        quote_identifier(schema),
        quote_identifier(name),
        body.join(",\n")
    );
    for row in &indexes {
        let indexdef: String = row
            .try_get(0)
            .map_err(|e| format!("Failed to decode index def: {e}"))?;
        ddl.push('\n');
        ddl.push_str(&indexdef);
        ddl.push(';');
    }
    // Table-level comment first, then column comments, each as a standalone
    // statement — mirroring pg_dump's own emission order.
    let table_comment = timeout(
        QUERY_TIMEOUT,
        client.query_opt(
            "SELECT pg_catalog.obj_description(c.oid, 'pg_class') FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2",
            &[&schema, &name],
        ),
    )
    .await
    .map_err(|_| "Catalog query timed out")?
    .map_err(|error| format!("Failed to load table comment: {error}"))?
    .and_then(|row| {
        row.try_get::<_, Option<String>>(0)
            .ok()
            .flatten()
            .filter(|value| !value.trim().is_empty())
    });
    if let Some(comment) = table_comment {
        ddl.push_str("\n\n");
        ddl.push_str(&format!(
            "COMMENT ON TABLE {}.{} IS {};",
            quote_identifier(schema),
            quote_identifier(name),
            quote_comment_literal(&comment)
        ));
    }
    for (column_name, comment) in column_comments {
        ddl.push('\n');
        ddl.push_str(&format!(
            "COMMENT ON COLUMN {}.{} IS {};",
            quote_identifier(schema),
            quote_identifier(&column_name),
            quote_comment_literal(&comment)
        ));
    }
    Ok(ddl)
}

/// SQL string literal with doubled single quotes for `COMMENT ON ... IS '...'`
/// (same escaping contract as postgres_design.rs's quote_literal).
fn quote_comment_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// Builds the `CREATE OR REPLACE VIEW / MATERIALIZED VIEW` text from
/// `pg_get_viewdef` (architecture D-B21-8).
async fn view_ddl(
    client: &Client,
    object_type: &str,
    schema: &str,
    name: &str,
    oid: i64,
) -> Result<String, String> {
    let def = timeout(
        QUERY_TIMEOUT,
        client.query_one("SELECT pg_get_viewdef($1::text::oid)", &[&oid_param(oid)]),
    )
    .await
    .map_err(|_| "Catalog query timed out")?
    .map_err(|error| map_ddl_privilege_error(object_type, schema, name, &error.to_string()))?;
    let definition: String = def
        .try_get(0)
        .map_err(|error| format!("Failed to decode view definition: {error}"))?;
    let keyword = if object_type == "materializedView" {
        "CREATE MATERIALIZED VIEW"
    } else {
        "CREATE OR REPLACE VIEW"
    };
    Ok(format!(
        "{keyword} {}.{} AS\n{definition}",
        quote_identifier(schema),
        quote_identifier(name)
    ))
}

// ── Commands ─────────────────────────────────────────────────────────────────

/// Lists a whole catalog group for the navigator (six object kinds).
#[tauri::command]
pub async fn postgres_catalog_objects(
    request: PostgresCatalogObjectsRequest,
    state: State<'_, PostgresState>,
) -> Result<Vec<PostgresCatalogObject>, String> {
    if !CATALOG_OBJECT_KINDS.contains(&request.kind.as_str()) {
        return Err("Unsupported PostgreSQL catalog object kind".into());
    }
    let client = state.client(&request.connection_id).await?;
    require_schema(&client, &request.schema).await?;

    let (sql, detail): (&str, PostgresCatalogDetail) = match request.kind.as_str() {
        "functions" => (
            "SELECT n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND p.prokind IN ('f','p') AND has_schema_privilege(n.oid, 'USAGE') ORDER BY p.proname, 2 LIMIT $2",
            PostgresCatalogDetail::Signature,
        ),
        "sequences" => (
            "SELECT n.nspname, c.relname, NULL::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind = 'S' AND has_schema_privilege(n.oid, 'USAGE') ORDER BY c.relname LIMIT $2",
            PostgresCatalogDetail::None,
        ),
        "indexes" => (
            "SELECT n.nspname, ic.relname, NULL::text FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid JOIN pg_class tc ON tc.oid = i.indrelid JOIN pg_namespace n ON n.oid = tc.relnamespace WHERE n.nspname = $1 AND tc.relname = $2 AND has_schema_privilege(n.oid, 'USAGE') ORDER BY ic.relname LIMIT $3",
            PostgresCatalogDetail::None,
        ),
        "constraints" => (
            "SELECT n.nspname, con.conname, con.contype::text FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2 AND has_schema_privilege(n.oid, 'USAGE') ORDER BY con.conname LIMIT $3",
            PostgresCatalogDetail::ConstraintType,
        ),
        "triggers" => (
            "SELECT n.nspname, t.tgname, NULL::text FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2 AND NOT t.tgisinternal AND has_schema_privilege(n.oid, 'USAGE') ORDER BY t.tgname LIMIT $3",
            PostgresCatalogDetail::None,
        ),
        "columns" => (
            "SELECT n.nspname, a.attname, format_type(a.atttypid, a.atttypmod), (NOT a.attnotnull)::text, pg_get_expr(ad.adbin, ad.adrelid), a.attnum::int, EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND EXISTS (SELECT 1 FROM unnest(i.indkey) k(attnum) WHERE k.attnum = a.attnum))::text, pg_catalog.col_description(a.attrelid, a.attnum) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped AND has_schema_privilege(n.oid, 'USAGE') ORDER BY a.attnum LIMIT $3",
            PostgresCatalogDetail::Column,
        ),
        _ => unreachable!("kind whitelist checked above"),
    };

    let limit = CATALOG_GROUP_LIMIT;
    let rows = match request.kind.as_str() {
        "functions" | "sequences" => {
            timeout(QUERY_TIMEOUT, client.query(sql, &[&request.schema, &limit]))
                .await
                .map_err(|_| "Catalog query timed out")?
                .map_err(|error| format!("Failed to list catalog objects: {error}"))?
        }
        _ => {
            let relation = request
                .relation
                .as_deref()
                .ok_or_else(|| "Table name is required for this object kind".to_string())?;
            timeout(
                QUERY_TIMEOUT,
                client.query(sql, &[&request.schema, &relation, &limit]),
            )
            .await
            .map_err(|_| "Catalog query timed out")?
            .map_err(|error| format!("Failed to list catalog objects: {error}"))?
        }
    };

    let object_kind = match request.kind.as_str() {
        "functions" => "function",
        "sequences" => "sequence",
        "indexes" => "index",
        "constraints" => "constraint",
        "triggers" => "trigger",
        "columns" => "column",
        _ => unreachable!(),
    };

    let mut objects = Vec::with_capacity(rows.len());
    for row in rows {
        let schema: String = row
            .try_get(0)
            .map_err(|error| format!("Failed to decode catalog object: {error}"))?;
        let name: String = row
            .try_get(1)
            .map_err(|error| format!("Failed to decode catalog object: {error}"))?;
        let mut object = PostgresCatalogObject {
            kind: object_kind.to_string(),
            schema,
            name,
            signature: None,
            relation: request.relation.clone(),
            object_type: None,
            data_type: None,
            nullable: None,
            default: None,
            ordinal: None,
            is_primary_key: None,
            comment: None,
        };
        match detail {
            PostgresCatalogDetail::Signature => {
                if let Ok(signature) = row.try_get::<_, String>(2) {
                    object.signature = Some(signature);
                }
            }
            PostgresCatalogDetail::ConstraintType => {
                if let Ok(object_type) = row.try_get::<_, String>(2) {
                    object.object_type = Some(object_type);
                }
            }
            PostgresCatalogDetail::Column => {
                if let Ok(data_type) = row.try_get::<_, String>(2) {
                    object.data_type = Some(data_type);
                }
                object.nullable = row.try_get::<_, String>(3).ok().map(|value| value == "t");
                object.default = row.try_get::<_, Option<String>>(4).ok().flatten();
                object.ordinal = row.try_get::<_, i32>(5).ok();
                object.is_primary_key = row.try_get::<_, String>(6).ok().map(|value| value == "t");
                object.comment = row.try_get::<_, Option<String>>(7).ok().flatten();
            }
            PostgresCatalogDetail::None => {}
        }
        objects.push(object);
    }
    Ok(objects)
}

enum PostgresCatalogDetail {
    None,
    Signature,
    ConstraintType,
    Column,
}

/// Loads object properties for the read-only viewer tab (architecture D-B21-7).
#[tauri::command]
pub async fn postgres_object_props(
    request: PostgresObjectPropsRequest,
    state: State<'_, PostgresState>,
) -> Result<PostgresObjectProps, String> {
    if !DDL_OBJECT_TYPES.contains(&request.object_type.as_str()) {
        return Err("Unsupported PostgreSQL object type".into());
    }
    let client = state.client(&request.connection_id).await?;
    require_schema(&client, &request.schema).await?;

    let mut props: Vec<PostgresObjectProp> = Vec::new();
    let mut ddl: Option<String> = None;

    match request.object_type.as_str() {
        "function" => {
            let oid = resolve_object_oid(
                &client,
                "function",
                &request.schema,
                &request.name,
                None,
                request.signature.as_deref(),
            )
            .await?
            .ok_or_else(|| {
                format!(
                    "Function {}.{} does not exist",
                    request.schema, request.name
                )
            })?;
            props.push(PostgresObjectProp {
                key: "signature".into(),
                value: request.signature.unwrap_or_default(),
            });
            let definition = timeout(
                QUERY_TIMEOUT,
                client.query_one(
                    "SELECT pg_get_function_identity_arguments($1::text::oid), pg_get_function_result($1::text::oid), CASE p.provolatile WHEN 'i' THEN 'immutable' WHEN 's' THEN 'stable' ELSE 'volatile' END FROM pg_proc p WHERE p.oid = $1::text::oid",
                    &[&oid_param(oid)],
                ),
            )
            .await
            .map_err(|_| "Catalog query timed out")?
            .map_err(|error| map_ddl_privilege_error("function", &request.schema, &request.name, &error.to_string()))?;
            if let Ok(signature) = definition.try_get::<_, String>(0) {
                props.push(PostgresObjectProp {
                    key: "identityArguments".into(),
                    value: signature,
                });
            }
            if let Ok(result) = definition.try_get::<_, String>(1) {
                props.push(PostgresObjectProp {
                    key: "returns".into(),
                    value: result,
                });
            }
            if let Ok(volatility) = definition.try_get::<_, String>(2) {
                props.push(PostgresObjectProp {
                    key: "volatility".into(),
                    value: volatility,
                });
            }
            let def_rows = timeout(
                QUERY_TIMEOUT,
                client.query_one(
                    "SELECT pg_get_functiondef($1::text::oid)",
                    &[&oid_param(oid)],
                ),
            )
            .await
            .map_err(|_| "Catalog query timed out")?
            .map_err(|error| {
                map_ddl_privilege_error(
                    "function",
                    &request.schema,
                    &request.name,
                    &error.to_string(),
                )
            })?;
            if let Ok(definition) = def_rows.try_get::<_, String>(0) {
                ddl = Some(definition);
            }
        }
        "sequence" => {
            let oid = resolve_object_oid(
                &client,
                "sequence",
                &request.schema,
                &request.name,
                None,
                None,
            )
            .await?
            .ok_or_else(|| {
                format!(
                    "Sequence {}.{} does not exist",
                    request.schema, request.name
                )
            })?;
            let seq = timeout(
                QUERY_TIMEOUT,
                client.query_one(
                    "SELECT format_type(s.seqtypid, NULL), s.seqstart, s.seqincrement, s.seqmin, s.seqmax, s.seqcache, s.seqcycle FROM pg_sequence s JOIN pg_class c ON c.oid = s.seqrelid WHERE c.oid = $1::text::oid",
                    &[&oid_param(oid)],
                ),
            )
            .await
            .map_err(|_| "Catalog query timed out")?
            .map_err(|error| format!("Failed to load sequence properties: {error}"))?;
            for (key, index) in [
                ("type", 0usize),
                ("start", 1),
                ("increment", 2),
                ("min", 3),
                ("max", 4),
                ("cache", 5),
            ] {
                if let Ok(value) = seq.try_get::<_, String>(index) {
                    props.push(PostgresObjectProp {
                        key: key.into(),
                        value,
                    });
                }
            }
            if let Ok(cycle) = seq.try_get::<_, bool>(6) {
                props.push(PostgresObjectProp {
                    key: "cycle".into(),
                    value: cycle.to_string(),
                });
            }
            // Current value comes from the sequence relation itself; the
            // relation name has already been validated through oid resolution,
            // and quote_identifier neutralises any embedded quotes.
            let seq_rows = timeout(
                QUERY_TIMEOUT,
                client.query_one(
                    &format!(
                        "SELECT last_value, is_called FROM {}.{}",
                        quote_identifier(&request.schema),
                        quote_identifier(&request.name)
                    ),
                    &[],
                ),
            )
            .await
            .map_err(|_| "Catalog query timed out")?
            .map_err(|error| format!("Failed to load sequence state: {error}"))?;
            if let Ok(last_value) = seq_rows.try_get::<_, i64>(0) {
                props.push(PostgresObjectProp {
                    key: "lastValue".into(),
                    value: last_value.to_string(),
                });
            }
            if let Ok(is_called) = seq_rows.try_get::<_, bool>(1) {
                props.push(PostgresObjectProp {
                    key: "isCalled".into(),
                    value: is_called.to_string(),
                });
            }
            ddl = Some(sequence_ddl(&client, &request.schema, &request.name).await?);
        }
        "index" => {
            let oid =
                resolve_object_oid(&client, "index", &request.schema, &request.name, None, None)
                    .await?
                    .ok_or_else(|| {
                        format!("Index {}.{} does not exist", request.schema, request.name)
                    })?;
            let indexdef = timeout(
                QUERY_TIMEOUT,
                client.query_one("SELECT pg_get_indexdef($1::text::oid), i.indisunique FROM pg_index i WHERE i.indexrelid = $1::text::oid", &[&oid_param(oid)]),
            )
            .await
            .map_err(|_| "Catalog query timed out")?
            .map_err(|error| map_ddl_privilege_error("index", &request.schema, &request.name, &error.to_string()))?;
            if let Ok(def) = indexdef.try_get::<_, String>(0) {
                ddl = Some(def);
            }
            if let Ok(unique) = indexdef.try_get::<_, bool>(1) {
                props.push(PostgresObjectProp {
                    key: "unique".into(),
                    value: unique.to_string(),
                });
            }
        }
        "constraint" => {
            let oid = resolve_object_oid(
                &client,
                "constraint",
                &request.schema,
                &request.name,
                request.relation.as_deref(),
                None,
            )
            .await?
            .ok_or_else(|| {
                format!(
                    "Constraint {}.{} does not exist",
                    request.schema, request.name
                )
            })?;
            let con = timeout(
                QUERY_TIMEOUT,
                client.query_one(
                    "SELECT con.contype::text, pg_get_constraintdef(con.oid) FROM pg_constraint con WHERE con.oid = $1::text::oid",
                    &[&oid_param(oid)],
                ),
            )
            .await
            .map_err(|_| "Catalog query timed out")?
            .map_err(|error| format!("Failed to load constraint: {error}"))?;
            if let Ok(contype) = con.try_get::<_, String>(0) {
                props.push(PostgresObjectProp {
                    key: "type".into(),
                    value: contype,
                });
            }
            if let Ok(def) = con.try_get::<_, String>(1) {
                ddl = Some(def);
            }
        }
        "trigger" => {
            let oid = resolve_object_oid(
                &client,
                "trigger",
                &request.schema,
                &request.name,
                request.relation.as_deref(),
                None,
            )
            .await?
            .ok_or_else(|| format!("Trigger {}.{} does not exist", request.schema, request.name))?;
            let def = timeout(
                QUERY_TIMEOUT,
                client.query_one(
                    "SELECT pg_get_triggerdef($1::text::oid)",
                    &[&oid_param(oid)],
                ),
            )
            .await
            .map_err(|_| "Catalog query timed out")?
            .map_err(|error| {
                map_ddl_privilege_error(
                    "trigger",
                    &request.schema,
                    &request.name,
                    &error.to_string(),
                )
            })?;
            if let Ok(definition) = def.try_get::<_, String>(0) {
                ddl = Some(definition);
            }
        }
        "column" => {
            let oid = resolve_object_oid(
                &client,
                "column",
                &request.schema,
                &request.name,
                request.relation.as_deref(),
                None,
            )
            .await?
            .ok_or_else(|| {
                format!(
                    "Column {}.{}.{} does not exist",
                    request.schema,
                    request.relation.unwrap_or_default(),
                    request.name
                )
            })?;
            let col = timeout(
                QUERY_TIMEOUT,
                client.query_one(
                    "SELECT a.attnum::int, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull, pg_get_expr(ad.adbin, ad.adrelid), pg_catalog.col_description(a.attrelid, a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum WHERE a.attrelid = $1::text::oid AND a.attname = $2",
                    &[&oid_param(oid), &request.name],
                ),
            )
            .await
            .map_err(|_| "Catalog query timed out")?
            .map_err(|error| format!("Failed to load column: {error}"))?;
            for (key, index, kind) in [
                ("ordinal", 0usize, "i64"),
                ("dataType", 1, "string"),
                ("nullable", 2, "bool"),
                ("default", 3, "option-string"),
                ("comment", 4, "option-string"),
            ] {
                let value = match kind {
                    "i64" => col
                        .try_get::<_, i64>(index)
                        .ok()
                        .map(|value| value.to_string()),
                    "string" => col.try_get::<_, String>(index).ok(),
                    "bool" => col
                        .try_get::<_, bool>(index)
                        .ok()
                        .map(|value| value.to_string()),
                    _ => col.try_get::<_, Option<String>>(index).ok().flatten(),
                };
                if let Some(value) = value {
                    props.push(PostgresObjectProp {
                        key: key.into(),
                        value,
                    });
                }
            }
        }
        "table" | "view" | "materializedView" => {
            return Err("Table/view properties are rendered by the data grid".into());
        }
        _ => unreachable!("object type whitelist checked above"),
    }

    let (ddl, truncated) = match ddl {
        Some(ddl) => {
            let (ddl, truncated) = truncate_ddl(ddl);
            (Some(ddl), truncated)
        }
        None => (None, false),
    };
    Ok(PostgresObjectProps {
        props,
        ddl,
        truncated,
    })
}

/// Generates full DDL text for an object (architecture D-B21-8).
#[tauri::command]
pub async fn postgres_object_ddl(
    request: PostgresObjectDdlRequest,
    state: State<'_, PostgresState>,
) -> Result<PostgresObjectDdl, String> {
    if !DDL_OBJECT_TYPES.contains(&request.object_type.as_str()) {
        return Err("Unsupported PostgreSQL object type".into());
    }
    let client = state.client(&request.connection_id).await?;
    require_schema(&client, &request.schema).await?;

    let ddl = match request.object_type.as_str() {
        "table" => table_ddl(&client, &request.schema, &request.name).await?,
        "view" | "materializedView" => {
            let oid = resolve_object_oid(
                &client,
                request.object_type.as_str(),
                &request.schema,
                &request.name,
                None,
                None,
            )
            .await?
            .ok_or_else(|| {
                format!(
                    "{} {}.{} does not exist",
                    request.object_type, request.schema, request.name
                )
            })?;
            view_ddl(
                &client,
                &request.object_type,
                &request.schema,
                &request.name,
                oid,
            )
            .await?
        }
        "function" => {
            let oid = resolve_object_oid(
                &client,
                "function",
                &request.schema,
                &request.name,
                None,
                request.signature.as_deref(),
            )
            .await?
            .ok_or_else(|| {
                format!(
                    "Function {}.{} does not exist",
                    request.schema, request.name
                )
            })?;
            let def = timeout(
                QUERY_TIMEOUT,
                client.query_one(
                    "SELECT pg_get_functiondef($1::text::oid)",
                    &[&oid_param(oid)],
                ),
            )
            .await
            .map_err(|_| "Catalog query timed out")?
            .map_err(|error| {
                map_ddl_privilege_error(
                    "function",
                    &request.schema,
                    &request.name,
                    &error.to_string(),
                )
            })?;
            def.try_get::<_, String>(0)
                .map_err(|error| format!("Failed to decode function definition: {error}"))?
        }
        "sequence" => sequence_ddl(&client, &request.schema, &request.name).await?,
        "index" => {
            let oid =
                resolve_object_oid(&client, "index", &request.schema, &request.name, None, None)
                    .await?
                    .ok_or_else(|| {
                        format!("Index {}.{} does not exist", request.schema, request.name)
                    })?;
            let def = timeout(
                QUERY_TIMEOUT,
                client.query_one("SELECT pg_get_indexdef($1::text::oid)", &[&oid_param(oid)]),
            )
            .await
            .map_err(|_| "Catalog query timed out")?
            .map_err(|error| {
                map_ddl_privilege_error("index", &request.schema, &request.name, &error.to_string())
            })?;
            def.try_get::<_, String>(0)
                .map_err(|error| format!("Failed to decode index definition: {error}"))?
        }
        "constraint" => {
            let oid = resolve_object_oid(
                &client,
                "constraint",
                &request.schema,
                &request.name,
                request.relation.as_deref(),
                None,
            )
            .await?
            .ok_or_else(|| {
                format!(
                    "Constraint {}.{} does not exist",
                    request.schema, request.name
                )
            })?;
            let def = timeout(
                QUERY_TIMEOUT,
                client.query_one(
                    "SELECT pg_get_constraintdef($1::text::oid)",
                    &[&oid_param(oid)],
                ),
            )
            .await
            .map_err(|_| "Catalog query timed out")?
            .map_err(|error| {
                map_ddl_privilege_error(
                    "constraint",
                    &request.schema,
                    &request.name,
                    &error.to_string(),
                )
            })?;
            def.try_get::<_, String>(0)
                .map_err(|error| format!("Failed to decode constraint definition: {error}"))?
        }
        "trigger" => {
            let oid = resolve_object_oid(
                &client,
                "trigger",
                &request.schema,
                &request.name,
                request.relation.as_deref(),
                None,
            )
            .await?
            .ok_or_else(|| format!("Trigger {}.{} does not exist", request.schema, request.name))?;
            let def = timeout(
                QUERY_TIMEOUT,
                client.query_one(
                    "SELECT pg_get_triggerdef($1::text::oid)",
                    &[&oid_param(oid)],
                ),
            )
            .await
            .map_err(|_| "Catalog query timed out")?
            .map_err(|error| {
                map_ddl_privilege_error(
                    "trigger",
                    &request.schema,
                    &request.name,
                    &error.to_string(),
                )
            })?;
            def.try_get::<_, String>(0)
                .map_err(|error| format!("Failed to decode trigger definition: {error}"))?
        }
        "column" => {
            let relation = request.relation.clone();
            let oid = resolve_object_oid(
                &client,
                "column",
                &request.schema,
                &request.name,
                relation.as_deref(),
                None,
            )
            .await?
            .ok_or_else(|| {
                format!(
                    "Column {}.{}.{} does not exist",
                    request.schema,
                    relation.as_deref().unwrap_or_default(),
                    request.name
                )
            })?;
            let def = timeout(
                QUERY_TIMEOUT,
                client.query_one(
                    "SELECT a.attname, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull, pg_get_expr(ad.adbin, ad.adrelid), a.attnum::int FROM pg_attribute a LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum WHERE a.attrelid = $1::text::oid AND a.attname = $2",
                    &[&oid_param(oid), &request.name],
                ),
            )
            .await
            .map_err(|_| "Catalog query timed out")?
            .map_err(|error| format!("Failed to load column definition: {error}"))?;
            let column_name: String = def
                .try_get(0)
                .map_err(|e| format!("Failed to decode column: {e}"))?;
            let data_type: String = def
                .try_get(1)
                .map_err(|e| format!("Failed to decode column type: {e}"))?;
            let nullable: bool = def
                .try_get(2)
                .map_err(|e| format!("Failed to decode nullability: {e}"))?;
            let default: Option<String> = def
                .try_get(3)
                .map_err(|e| format!("Failed to decode default: {e}"))?;
            let mut fragment = format!(
                "ALTER TABLE {}.{} ADD COLUMN {} {}",
                quote_identifier(&request.schema),
                quote_identifier(relation.as_deref().unwrap_or_default()),
                quote_identifier(&column_name),
                data_type
            );
            if let Some(default) = default.filter(|value| !value.is_empty()) {
                fragment.push_str(&format!(" DEFAULT {default}"));
            }
            if !nullable {
                fragment.push_str(" NOT NULL");
            }
            fragment
        }
        _ => unreachable!("object type whitelist checked above"),
    };

    let (ddl, truncated) = truncate_ddl(ddl);
    Ok(PostgresObjectDdl { ddl, truncated })
}

/// Drops an object through a whitelisted, server-constructed statement.
///
/// `confirmed = false` performs a dry run: it verifies existence, counts
/// dependents and returns them for the confirmation dialog. `confirmed =
/// true` re-validates existence (TOCTOU guard) and executes. read-only
/// connections are always rejected (security constraint §2.3).
#[tauri::command]
pub async fn postgres_drop_object(
    request: PostgresDropObjectRequest,
    state: State<'_, PostgresState>,
) -> Result<PostgresDropObjectResponse, String> {
    if !DROP_OBJECT_KINDS.contains(&request.kind.as_str()) {
        return Err("Unsupported PostgreSQL drop kind".into());
    }
    let client = state.client(&request.connection_id).await?;
    require_schema(&client, &request.schema).await?;

    let oid = resolve_object_oid(
        &client,
        &request.kind,
        &request.schema,
        &request.name,
        request.relation.as_deref(),
        request.signature.as_deref(),
    )
    .await?;

    let Some(oid) = oid else {
        return Ok(PostgresDropObjectResponse {
            object_exists: false,
            dependent_count: None,
            sample_dependents: Vec::new(),
        });
    };

    let (dependent_count, sample_dependents) = dependent_summary(&client, oid).await?;

    if !request.confirmed {
        return Ok(PostgresDropObjectResponse {
            object_exists: true,
            dependent_count: Some(dependent_count),
            sample_dependents,
        });
    }

    // Destructive execution requires a non-read-only connection. The session
    // itself is also read-only server-side (SET default_transaction_read_only),
    // so this is a belt-and-suspenders guard with a clear message.
    if state.is_read_only(&request.connection_id).await? {
        return Err("read-only connection cannot modify schema/data".into());
    }

    // Re-validate existence right before executing (security §2.1 TOCTOU).
    if resolve_object_oid(
        &client,
        &request.kind,
        &request.schema,
        &request.name,
        request.relation.as_deref(),
        request.signature.as_deref(),
    )
    .await?
    .is_none()
    {
        return Err("object does not exist".into());
    }

    let cascade = if request.cascade { " CASCADE" } else { "" };
    let statement = match request.kind.as_str() {
        "table" => format!(
            "DROP TABLE {}.{}{cascade}",
            quote_identifier(&request.schema),
            quote_identifier(&request.name)
        ),
        "view" => format!(
            "DROP VIEW {}.{}{cascade}",
            quote_identifier(&request.schema),
            quote_identifier(&request.name)
        ),
        "materializedView" => format!(
            "DROP MATERIALIZED VIEW {}.{}{cascade}",
            quote_identifier(&request.schema),
            quote_identifier(&request.name)
        ),
        "function" => {
            let signature = request
                .signature
                .clone()
                .unwrap_or_else(|| "()".to_string());
            format!(
                "DROP FUNCTION {}.{}({signature}){cascade}",
                quote_identifier(&request.schema),
                quote_identifier(&request.name)
            )
        }
        "sequence" => format!(
            "DROP SEQUENCE {}.{}{cascade}",
            quote_identifier(&request.schema),
            quote_identifier(&request.name)
        ),
        "index" => format!(
            "DROP INDEX {}.{}{cascade}",
            quote_identifier(&request.schema),
            quote_identifier(&request.name)
        ),
        "constraint" => {
            let relation = request
                .relation
                .as_deref()
                .ok_or_else(|| "Owning table is required".to_string())?;
            format!(
                "ALTER TABLE {}.{} DROP CONSTRAINT {}{cascade}",
                quote_identifier(&request.schema),
                quote_identifier(relation),
                quote_identifier(&request.name)
            )
        }
        "trigger" => {
            let relation = request
                .relation
                .as_deref()
                .ok_or_else(|| "Owning table is required".to_string())?;
            format!(
                "DROP TRIGGER {} ON {}.{}{cascade}",
                quote_identifier(&request.name),
                quote_identifier(&request.schema),
                quote_identifier(relation)
            )
        }
        _ => unreachable!("drop kind whitelist checked above"),
    };

    timeout(QUERY_TIMEOUT, client.execute(statement.as_str(), &[]))
        .await
        .map_err(|_| "Drop statement timed out")?
        .map_err(|error| format!("Failed to drop object: {error}"))?;

    // Audit trail (security §2.5) — never logs credentials or connection params.
    tracing::info!(
        "DROP OBJECT kind={} schema={} name={} cascade={}",
        request.kind,
        request.schema,
        request.name,
        request.cascade
    );

    Ok(PostgresDropObjectResponse {
        object_exists: true,
        dependent_count: Some(dependent_count),
        sample_dependents,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_object_kind_whitelist() {
        assert!(CATALOG_OBJECT_KINDS.contains(&"functions"));
        assert!(CATALOG_OBJECT_KINDS.contains(&"sequences"));
        assert!(CATALOG_OBJECT_KINDS.contains(&"indexes"));
        assert!(CATALOG_OBJECT_KINDS.contains(&"constraints"));
        assert!(CATALOG_OBJECT_KINDS.contains(&"triggers"));
        assert!(CATALOG_OBJECT_KINDS.contains(&"columns"));
        assert!(!CATALOG_OBJECT_KINDS.contains(&"tables"));
        assert!(!CATALOG_OBJECT_KINDS.contains(&""));
        assert!(!CATALOG_OBJECT_KINDS.contains(&"DROP TABLE"));
    }

    #[test]
    fn ddl_object_type_whitelist() {
        assert!(DDL_OBJECT_TYPES.contains(&"table"));
        assert!(DDL_OBJECT_TYPES.contains(&"view"));
        assert!(DDL_OBJECT_TYPES.contains(&"materializedView"));
        assert!(DDL_OBJECT_TYPES.contains(&"function"));
        assert!(DDL_OBJECT_TYPES.contains(&"sequence"));
        assert!(DDL_OBJECT_TYPES.contains(&"index"));
        assert!(DDL_OBJECT_TYPES.contains(&"constraint"));
        assert!(DDL_OBJECT_TYPES.contains(&"trigger"));
        assert!(DDL_OBJECT_TYPES.contains(&"column"));
        assert!(!DDL_OBJECT_TYPES.contains(&"schema"));
        assert!(!DDL_OBJECT_TYPES.contains(&"blob"));
    }

    #[test]
    fn drop_kind_whitelist() {
        assert!(DROP_OBJECT_KINDS.contains(&"table"));
        assert!(DROP_OBJECT_KINDS.contains(&"view"));
        assert!(DROP_OBJECT_KINDS.contains(&"materializedView"));
        assert!(DROP_OBJECT_KINDS.contains(&"function"));
        assert!(DROP_OBJECT_KINDS.contains(&"sequence"));
        assert!(DROP_OBJECT_KINDS.contains(&"index"));
        assert!(DROP_OBJECT_KINDS.contains(&"constraint"));
        assert!(DROP_OBJECT_KINDS.contains(&"trigger"));
        assert!(!DROP_OBJECT_KINDS.contains(&"catalog"));
        assert!(!DROP_OBJECT_KINDS.contains(&"truncate"));
    }

    #[test]
    fn truncate_ddl_bounds() {
        let (short, truncated) = truncate_ddl("CREATE VIEW v AS SELECT 1".to_string());
        assert!(!truncated);
        assert_eq!(short, "CREATE VIEW v AS SELECT 1");
        let long = "x".repeat(DDL_MAX_LEN + 10);
        let (out, truncated) = truncate_ddl(long.clone());
        assert!(truncated);
        assert_eq!(out.len(), DDL_MAX_LEN);
        assert_eq!(&long[..DDL_MAX_LEN], out.as_str());
    }

    #[test]
    fn map_ddl_privilege_error_is_generic() {
        let raw = "insufficient privilege: SELECT pg_get_functiondef(12345)";
        let mapped = map_ddl_privilege_error("function", "public", "f", raw);
        assert_eq!(
            mapped,
            "insufficient privilege to view definition of function public.f"
        );
        assert!(!mapped.contains("12345"));
        // Non-privilege errors stay generic and never echo the raw text.
        let other =
            map_ddl_privilege_error("index", "public", "idx", "syntax error at or near \"DROP\"");
        assert_eq!(other, "Failed to load definition");
        assert!(!other.contains("DROP"));
    }

    #[test]
    fn drop_statement_quotes_identifiers() {
        // The statement builders are exercised through the real request path;
        // here we assert quote_identifier hardening that they rely on.
        assert_eq!(quote_identifier("orders"), "\"orders\"");
        assert_eq!(quote_identifier("Users"), "\"Users\"");
        assert_eq!(
            quote_identifier("weird\"; DROP TABLE x; --"),
            "\"weird\"\"; DROP TABLE x; --\""
        );
    }

    #[test]
    fn dependent_summary_and_resolve_require_client() {
        // No live client in unit tests — assert the public response type stays
        // shaped for the frontend contract.
        let response = PostgresDropObjectResponse {
            object_exists: false,
            dependent_count: None,
            sample_dependents: vec![],
        };
        assert!(!response.object_exists);
        assert_eq!(response.dependent_count, None);
    }
}
