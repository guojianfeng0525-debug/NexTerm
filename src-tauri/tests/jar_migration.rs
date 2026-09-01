//! Reproduces the user's failure: an old DB where jar_classes lacks
//! library_id. Both db::DbState::open and jar_db::open must migrate it so
//! list_classes works.

#[test]
#[ignore]
fn old_db_migrates_for_jar_db() {
    let dir = std::env::temp_dir().join(format!("jar-mig-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let db_path = dir.join("old.db");

    // Create an OLD-schema DB (no library_id) with a row.
    {
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS "jar_projects" (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', jar_path TEXT NOT NULL DEFAULT '', jar_hash TEXT NOT NULL DEFAULT '', size INTEGER NOT NULL DEFAULT 0, class_count INTEGER NOT NULL DEFAULT 0, resource_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS "jar_classes" (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, entry_path TEXT NOT NULL, class_name TEXT NOT NULL DEFAULT '', package_name TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'class', is_inner_class INTEGER NOT NULL DEFAULT 0, original_decompiled TEXT, modified_source TEXT, modified INTEGER NOT NULL DEFAULT 0, compile_status TEXT NOT NULL DEFAULT 'none', compile_output TEXT, compile_timestamp INTEGER, source_hash TEXT);
            INSERT INTO jar_projects VALUES ('p1','old.jar','/tmp/old.jar','h',1,1,0,0,0);
            INSERT INTO jar_classes (id, project_id, entry_path, class_name) VALUES ('p1:A.class','p1','A.class','A');
            "#,
        )
        .unwrap();
    }

    // Open via jar_db::open (same path the Tauri commands use) → must migrate.
    let conn = nexterm_lib::jar_db::open(&db_path).unwrap();
    let rows = nexterm_lib::jar_db::list_classes(&conn, "p1").unwrap();
    assert_eq!(rows.len(), 1, "old row must be listable after migration");
    assert_eq!(rows[0].class_name, "A");
    assert_eq!(rows[0].library_id, "", "library_id default ''");
    println!("OLD-DB MIGRATION PASS");
    std::fs::remove_dir_all(&dir).ok();
}
