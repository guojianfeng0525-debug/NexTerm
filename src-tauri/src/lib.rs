mod clipboard_files;
mod commands;
mod config_archive;
mod connection_manager;
pub mod db;
/// Desktop (RDP/VNC) protocol layer. Public for live integration tests
/// (`tests/rdp_live.rs`) that exercise the real connection pipeline.
pub mod desktop_protocol;
pub mod desktop_transport;
pub mod documents;
mod ftp_client;
mod jump;
mod ls_parser;
mod mysql;
mod os_detect;
mod postgres;
mod postgres_catalog;
mod postgres_design;
mod proxy;
/// IronRDP-based RDP client. Public for live integration tests.
pub mod rdp_client;
mod sftp_client;
mod sqlite;
pub mod ssh;
mod toolbox;
pub mod vnc_client;
mod websocket_server;

pub mod builder;
pub mod compile;
pub mod decompile;
pub mod jar;
mod jar_commands;
pub mod jar_db;
pub mod pom;

use connection_manager::ConnectionManager;
use std::sync::atomic::AtomicU16;
use std::sync::Arc;
use tauri::{Emitter, Manager};
use websocket_server::WebSocketServer;

// Global atomic to store the WebSocket port (shared between backend and frontend)
pub static WEBSOCKET_PORT: AtomicU16 = AtomicU16::new(0);

/// Build the native macOS menu bar (File / Edit / Tools / Connection / Window).
/// Only compiled on macOS; other platforms keep the web-based MenuBar component.
/// `t` is a lookup function: given a key like "menuBar.file", returns the translated string.
#[cfg(target_os = "macos")]
fn build_app_menu<F: Fn(&str) -> String>(
    app: &tauri::AppHandle,
    t: F,
) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};

    // ── NexTerm (app) menu ────────────────────────────────────────────────────
    let app_menu = Submenu::with_id_and_items(
        app,
        "m_app",
        "NexTerm",
        true,
        &[
            &PredefinedMenuItem::about(app, None, Some(AboutMetadata::default()))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    // ── Servers menu ──────────────────────────────────────────────────────────
    let servers_menu = Submenu::with_id_and_items(
        app,
        "m_servers",
        t("menuBar.servers"),
        true,
        &[
            &MenuItem::with_id(
                app,
                "new_connection",
                t("menuBar.newConnection"),
                true,
                Some("CmdOrCtrl+N"),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(
                app,
                "save_connection",
                t("menuBar.saveConnection"),
                true,
                Some("CmdOrCtrl+S"),
            )?,
            &MenuItem::with_id(
                app,
                "close_connection",
                t("menuBar.closeTab"),
                true,
                Some("CmdOrCtrl+W"),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "settings", t("menuBar.options"), true, None::<&str>)?,
        ],
    )?;

    // ── Terminal menu ─────────────────────────────────────────────────────────
    let terminal_menu = Submenu::with_id_and_items(
        app,
        "m_terminal",
        t("menuBar.terminal"),
        true,
        &[
            &MenuItem::with_id(
                app,
                "new_tab",
                t("menuBar.newTab"),
                true,
                Some("CmdOrCtrl+T"),
            )?,
            &MenuItem::with_id(
                app,
                "clone_tab",
                t("menuBar.duplicateTab"),
                true,
                Some("CmdOrCtrl+D"),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "next_tab", t("menuBar.nextTab"), true, None::<&str>)?,
            &MenuItem::with_id(
                app,
                "prev_tab",
                t("menuBar.previousTab"),
                true,
                None::<&str>,
            )?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "reconnect", t("menuBar.reconnect"), true, Some("F5"))?,
            &MenuItem::with_id(
                app,
                "disconnect",
                t("menuBar.disconnect"),
                true,
                None::<&str>,
            )?,
        ],
    )?;

    // ── Edit menu (mix of predefined + custom) ────────────────────────────────
    let edit_menu = Submenu::with_id_and_items(
        app,
        "m_edit",
        t("menuBar.edit"),
        true,
        &[
            &PredefinedMenuItem::undo(app, Some(&t("menuBar.undo")))?,
            &PredefinedMenuItem::redo(app, Some(&t("menuBar.redo")))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, Some(&t("menuBar.cut")))?,
            &PredefinedMenuItem::copy(app, Some(&t("menuBar.copy")))?,
            &PredefinedMenuItem::paste(app, Some(&t("menuBar.paste")))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::select_all(app, Some(&t("menuBar.selectAll")))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "find", t("menuBar.find"), true, Some("CmdOrCtrl+F"))?,
            &MenuItem::with_id(
                app,
                "clear_screen",
                t("menuBar.clearScreen"),
                true,
                Some("CmdOrCtrl+L"),
            )?,
        ],
    )?;

    // ── Window menu ───────────────────────────────────────────────────────────
    let window_menu = Submenu::with_id_and_items(
        app,
        "m_window",
        t("menuBar.window"),
        true,
        &[
            &PredefinedMenuItem::minimize(app, Some(&t("menuBar.minimize")))?,
            &PredefinedMenuItem::maximize(app, Some(&t("menuBar.zoom")))?,
            &PredefinedMenuItem::fullscreen(app, Some(&t("menuBar.fullscreen")))?,
        ],
    )?;

    Menu::with_items(
        app,
        &[
            &app_menu,
            &servers_menu,
            &terminal_menu,
            &edit_menu,
            &window_menu,
        ],
    )
}

/// English fallback for menu translations when no frontend translations are available.
#[cfg(target_os = "macos")]
fn default_menu_text(key: &str) -> String {
    match key {
        "menuBar.servers" => "Servers",
        "menuBar.terminal" => "Terminal",
        "menuBar.edit" => "Edit",
        "menuBar.window" => "Window",
        "menuBar.newConnection" => "New Connection...",
        "menuBar.saveConnection" => "Save Connection",
        "menuBar.closeTab" => "Close Tab",
        "menuBar.find" => "Find...",
        "menuBar.clearScreen" => "Clear Screen",
        "menuBar.options" => "Options...",
        "menuBar.newTab" => "New Tab",
        "menuBar.duplicateTab" => "Duplicate Tab",
        "menuBar.nextTab" => "Next Tab",
        "menuBar.previousTab" => "Previous Tab",
        "menuBar.reconnect" => "Reconnect",
        "menuBar.disconnect" => "Disconnect",
        "menuBar.undo" => "Undo",
        "menuBar.redo" => "Redo",
        "menuBar.cut" => "Cut",
        "menuBar.copy" => "Copy",
        "menuBar.paste" => "Paste",
        "menuBar.selectAll" => "Select All",
        "menuBar.minimize" => "Minimize",
        "menuBar.zoom" => "Zoom",
        "menuBar.fullscreen" => "Enter Full Screen",
        "toolbox.apps.title" => "Apps",
        "toolbox.apps.open" => "Open Apps",
        "toolbox.vault.title" => "Vault",
        "toolbox.vault.open" => "Open Vault",
        "toolbox.tunnels.title" => "Tunnels",
        "toolbox.tunnels.open" => "Open Tunnels",
        "toolbox.services.title" => "Services",
        "toolbox.services.open" => "Open Services",
        "toolbox.notes.title" => "Notes",
        "toolbox.notes.open" => "Open Notes",
        _ => key,
    }
    .to_string()
}

/// Portable WebView2 runtime setup (decided at startup, not build time).
///
/// The Windows portable build may ship the Fixed Version WebView2 Runtime in a
/// `WebView2/` folder next to the executable. If that folder is present and
/// complete, the WebView2 loader is pointed at it — this is exactly the
/// "configure the WebView2 environment variable" step, done automatically so
/// the user never has to set anything manually. If the folder is absent, the
/// loader falls back to the system WebView2 (Microsoft Edge / system runtime),
/// so machines that already have Edge keep working without the bundled
/// runtime. Logs only paths — never credentials or user data.
#[cfg(windows)]
fn setup_portable_webview2() {
    fn log_runtime(fields: &[(&str, &str)]) {
        for (k, v) in fields {
            println!("[RUNTIME] {}={}", k, v);
        }
    }

    let exe_path = std::env::current_exe().unwrap_or_default();
    let base_dir = exe_path
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_default();
    let runtime_dir = base_dir.join("WebView2");
    let msedge_exe = runtime_dir.join("msedgewebview2.exe");
    let msedge_dll = runtime_dir.join("msedge.dll");

    let runtime_exists = runtime_dir.is_dir();
    let fixed_ok = runtime_exists && msedge_exe.is_file() && msedge_dll.is_file();

    log_runtime(&[
        ("mode", if fixed_ok { "fixed" } else { "system" }),
        ("exe_path", &exe_path.display().to_string()),
        ("base_dir", &base_dir.display().to_string()),
        ("runtime_dir", &runtime_dir.display().to_string()),
        (
            "runtime_exists",
            if runtime_exists { "true" } else { "false" },
        ),
        ("msedge_exists", if fixed_ok { "true" } else { "false" }),
        ("architecture", "x64"),
        ("status", if fixed_ok { "valid" } else { "system-fallback" }),
    ]);

    if fixed_ok {
        // Point the WebView2 loader at the bundled Fixed Runtime. Same
        // mechanism as manually setting WEBVIEW2_BROWSER_EXECUTABLE_FOLDER,
        // done automatically.
        std::env::set_var("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER", &runtime_dir);
    }
    // Otherwise leave the variable unset: the loader uses the system WebView2
    // (Microsoft Edge / system runtime) when available.
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize tracing
    tracing_subscriber::fmt::init();

    // Windows: point the WebView2 loader at a bundled Fixed Runtime when
    // present, otherwise let it use the system WebView2 (Edge).
    #[cfg(windows)]
    setup_portable_webview2();

    // Create connection manager
    let connection_manager = Arc::new(ConnectionManager::new());

    let builder = tauri::Builder::default();
    #[cfg(debug_assertions)]
    let builder = builder.plugin(tauri_plugin_wdio_webdriver::init());

    // Single-instance: a second launch focuses the existing window instead
    // of spawning a whole new WebView2 process group (each instance costs
    // ~7 Chromium processes).
    // Skipped under NEXTERM_DATA_DIR (desktop E2E): WDIO serial runs stop the
    // previous spec's app with SIGTERM→SIGKILL; the dying instance still owns
    // the single-instance socket, so a fast-relaunched test instance connects
    // to it and exits(0) before its WebDriver session is usable — every spec
    // after the first failed with "app neither showed lock screen".
    let e2e_mode = std::env::var_os("NEXTERM_DATA_DIR").is_some();
    let builder: tauri::Builder<tauri::Wry> = if e2e_mode {
        builder
    } else {
        builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
                let _ = window.unminimize();
            }
        }))
    };
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup({
            let connection_manager_clone = connection_manager.clone();
            move |app| {
                // Register native macOS menu and forward item events to the frontend
                #[cfg(target_os = "macos")]
                {
                    match build_app_menu(app.handle(), default_menu_text) {
                        Ok(menu) => {
                            if let Err(e) = app.set_menu(menu) {
                                tracing::warn!("Failed to set native menu: {}", e);
                            }
                        }
                        Err(e) => tracing::warn!("Failed to build native menu: {}", e),
                    }
                }

                // E2E (WDIO) runs with NEXTERM_DATA_DIR set: force the window
                // onto the primary screen. macOS ignores tauri.conf x/y (the
                // system places the window), and a restored off-screen
                // position makes WebDriver isDisplayed() return false for
                // every element — the S1-6 dist-saga root cause.
                if std::env::var_os("NEXTERM_DATA_DIR").is_some() {
                    if let Some(window) = app.get_webview_window("main") {
                        match window.center() {
                            Ok(_) => {
                                let _ = window.set_size(tauri::LogicalSize::new(1600.0, 1000.0));
                                tracing::info!("[e2e] window centered for WDIO");
                            }
                            Err(e) => tracing::warn!("[e2e] window center failed: {e}"),
                        }
                    }
                }

                // Open the SQLite key-value store next to the executable
                // (portable mode — the DB travels with the exe). Falls back to
                // the OS app-data directory when the exe directory cannot be
                // resolved or is not writable.
                // NOTE: we use `std::env::current_exe()` here, NOT
                // `app.path().executable_dir()` — that Tauri resolver returns
                // the *user's* executable dir (~/.local/bin on Linux) and is
                // unsupported on macOS/Windows.
                let mut opened = false;
                // Desktop E2E sets this explicit profile directory so its encrypted
                // SQLite data never shares the developer's portable application DB.
                let e2e_data_dir =
                    std::env::var_os("NEXTERM_DATA_DIR").map(std::path::PathBuf::from);
                let exe_dir = e2e_data_dir.or_else(|| {
                    std::env::current_exe()
                        .ok()
                        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
                });
                if let Some(dir) = exe_dir {
                    if let Err(e) = std::fs::create_dir_all(&dir) {
                        tracing::warn!("Failed to prepare db directory {:?}: {}", dir, e);
                    }
                    let path = dir.join("nexterm.db");
                    // One-time migration: if the exe-adjacent store does not
                    // exist yet but a previous app-data store does, copy it
                    // over so existing data keeps working in portable mode.
                    if !path.exists() {
                        if let Ok(old_dir) = app.path().app_data_dir() {
                            let old_path = old_dir.join("nexterm.db");
                            if old_path.exists() {
                                match std::fs::copy(&old_path, &path) {
                                    Ok(_) => tracing::info!(
                                        "Migrated SQLite store from {:?} to {:?}",
                                        old_path,
                                        path
                                    ),
                                    Err(e) => tracing::warn!(
                                        "Failed to migrate SQLite store from {:?}: {}",
                                        old_path,
                                        e
                                    ),
                                }
                            }
                        }
                    }
                    match db::DbState::open(&path) {
                        Ok(state) => {
                            app.manage(std::sync::Arc::new(state));
                            tracing::info!("SQLite store opened at {:?}", path);
                            opened = true;
                            // Initialize the JAR decompiler state (shares the
                            // same SQLite file via per-command connections).
                            app.manage(jar_commands::JarState {
                                db_path: path.clone(),
                                cancels: std::sync::Arc::new(std::sync::Mutex::new(
                                    Default::default(),
                                )),
                                scratch: app
                                    .path()
                                    .app_data_dir()
                                    .unwrap_or_else(|_| dir.clone())
                                    .join("jar-scratch"),
                                resource_dir: app.path().resource_dir().ok(),
                                indexes: std::sync::Arc::new(std::sync::Mutex::new(
                                    Default::default(),
                                )),
                            });
                        }
                        Err(e) => {
                            tracing::warn!("Failed to open SQLite store at {:?}: {}", path, e)
                        }
                    }
                }
                if !opened {
                    match app.path().app_data_dir() {
                        Ok(dir) => {
                            if let Err(e) = std::fs::create_dir_all(&dir) {
                                tracing::warn!("Failed to create app data dir: {}", e);
                            }
                            match db::DbState::open(&dir.join("nexterm.db")) {
                                Ok(state) => {
                                    app.manage(std::sync::Arc::new(state));
                                    tracing::info!(
                                        "SQLite store opened at {:?} (app-data fallback)",
                                        dir.join("nexterm.db")
                                    );
                                    app.manage(jar_commands::JarState {
                                        db_path: dir.join("nexterm.db"),
                                        cancels: std::sync::Arc::new(std::sync::Mutex::new(
                                            Default::default(),
                                        )),
                                        scratch: dir.join("jar-scratch"),
                                        resource_dir: app.path().resource_dir().ok(),
                                        indexes: std::sync::Arc::new(std::sync::Mutex::new(
                                            Default::default(),
                                        )),
                                    });
                                }
                                Err(e) => tracing::warn!("Failed to open SQLite store: {}", e),
                            }
                        }
                        Err(e) => tracing::warn!("Failed to resolve app data dir: {}", e),
                    }
                }

                // Start WebSocket server for terminal I/O
                // Try ports 9001-9010 to avoid conflicts with other instances
                let ws_server = Arc::new(WebSocketServer::new(connection_manager_clone));
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = ws_server.start().await {
                        tracing::error!("WebSocket server error: {}", e);
                    }
                });
                Ok(())
            }
        })
        .on_menu_event(|app, event| {
            // Forward custom menu item IDs to the frontend so React can handle them
            let _ = app.emit("menu-action", event.id().0.as_str());
        })
        .manage(connection_manager)
        .manage(toolbox::ToolboxState::default())
        .manage(postgres::PostgresState::default())
        .manage(sqlite::SqliteState::default())
        .manage(mysql::MysqlState::default())
        .invoke_handler(tauri::generate_handler![
            commands::ssh_connect,
            commands::ssh_host_key_fingerprint,
            commands::ssh_cancel_connect,
            commands::ssh_disconnect,
            commands::ssh_execute_command,
            commands::ssh_tab_complete,
            commands::get_system_stats,
            commands::probe_server_stats,
            commands::probe_all_server_stats,
            documents::documents_list,
            documents::documents_import,
            documents::documents_export,
            documents::documents_save,
            documents::documents_versions,
            documents::documents_delete,
            commands::list_files,
            commands::list_connections,
            commands::sftp_download_file,
            commands::sftp_upload_file,
            commands::get_processes,
            commands::kill_process,
            commands::tail_log,
            commands::list_log_files,
            commands::discover_log_sources,
            commands::read_log,
            commands::search_log,
            commands::get_network_stats,
            commands::get_active_connections,
            commands::get_network_bandwidth,
            commands::get_network_latency,
            commands::get_disk_usage,
            commands::create_directory,
            commands::delete_file,
            commands::rename_file,
            commands::create_file,
            commands::read_file_content,
            commands::create_file_with_encoding,
            commands::read_file_content_with_encoding,
            commands::read_remote_file_base64,
            commands::copy_file,
            commands::detect_gpu,
            commands::get_gpu_stats,
            commands::get_websocket_port,
            // Standalone SFTP/FTP commands
            commands::sftp_connect,
            commands::sftp_standalone_disconnect,
            commands::ftp_connect,
            commands::ftp_disconnect,
            // Unified file operation commands
            commands::list_remote_files,
            commands::download_remote_file,
            commands::download_remote_file_confined,
            commands::upload_remote_file,
            commands::cancel_file_transfer,
            commands::delete_remote_item,
            commands::create_remote_directory,
            commands::rename_remote_item,
            // Local filesystem commands
            commands::list_local_files,
            commands::get_home_directory,
            commands::delete_local_item,
            commands::rename_local_item,
            commands::create_local_directory,
            commands::create_local_directory_confined,
            commands::open_in_os,
            commands::stat_local_path,
            // Directory synchronization commands
            commands::list_local_files_recursive,
            commands::list_remote_files_recursive,
            // Desktop (RDP/VNC) commands
            commands::desktop_connect,
            commands::desktop_disconnect,
            commands::desktop_send_key,
            commands::desktop_send_pointer,
            commands::desktop_request_frame,
            commands::desktop_set_clipboard,
            commands::desktop_resize,
            commands::update_menu_language,
            commands::get_system_locale,
            // SQLite key-value store
            db::row_upsert,
            db::row_get,
            db::row_list,
            db::row_delete,
            db::row_clear,
            db::database_vacuum,
            db::documents_prune_versions,
            db::export_encrypted_backup,
            db::restore_encrypted_backup,
            db::prune_command_stats,
            db::legacy_db_get,
            db::drop_legacy_tables,
            // Toolbox commands (apps, tunnels, services)
            toolbox::launch_app,
            toolbox::extract_app_icon,
            toolbox::tunnel_start,
            toolbox::tunnel_stop,
            toolbox::tunnel_list,
            toolbox::service_start,
            toolbox::service_stop,
            toolbox::service_list,
            toolbox::service_logs,
            config_archive::write_config_archive,
            config_archive::read_config_archive,
            // API debugger commands
            toolbox::api_request,
            toolbox::api_request_cancel,
            toolbox::api_ws_connect,
            toolbox::api_ws_send,
            toolbox::api_ws_close,
            // PostgreSQL database workspace
            postgres::postgres_connect,
            postgres::postgres_disconnect,
            postgres::postgres_execute,
            postgres::postgres_execute_parameterized,
            postgres::postgres_cancel,
            postgres::postgres_save_table_changes,
            postgres::postgres_explain,
            postgres::postgres_transaction,
            postgres::postgres_table_data,
            postgres::postgres_table_update,
            postgres::postgres_table_insert,
            postgres::postgres_table_delete,
            postgres::postgres_catalog_schemas,
            postgres::postgres_catalog_search,
            postgres::postgres_set_search_path,
            postgres::postgres_ssh_fingerprint,
            // B21 catalog-domain commands (postgres_catalog.rs)
            postgres_catalog::postgres_catalog_objects,
            postgres_catalog::postgres_object_props,
            postgres_catalog::postgres_object_ddl,
            postgres_catalog::postgres_drop_object,
            // B23 design-domain commands (postgres_design.rs)
            postgres_design::postgres_table_design_load,
            postgres_design::postgres_table_design_apply,
            postgres_design::postgres_view_save,
            postgres_design::postgres_pg_types,
            // SQLite database workspace (experimental P0 provider)
            sqlite::sqlite_connect,
            sqlite::sqlite_disconnect,
            sqlite::sqlite_execute,
            sqlite::sqlite_catalog_objects,
            // MySQL database workspace (experimental P0 provider)
            mysql::mysql_connect,
            mysql::mysql_disconnect,
            mysql::mysql_execute,
            mysql::mysql_catalog_objects,
            // JAR decompiler commands
            jar_commands::jar_project_open,
            jar_commands::jar_project_reopen,
            jar_commands::jar_project_list,
            jar_commands::jar_project_delete,
            jar_commands::jar_class_index,
            jar_commands::jar_class_search,
            jar_commands::jar_open_type,
            jar_commands::jar_known_class_names,
            jar_commands::jar_type_hierarchy,
            jar_commands::jar_constant_search,
            jar_commands::jar_decompile,
            jar_commands::jar_decompile_cancel,
            jar_commands::jar_resource_read,
            jar_commands::jar_pom_open,
            jar_commands::jar_libraries,
            jar_commands::jar_library_index,
            jar_commands::jar_navigate,
            jar_commands::jar_method_location,
            jar_commands::jar_resource_bytes,
            jar_commands::jar_export_all,
            jar_commands::jar_class_info,
            jar_commands::jar_maven_sources,
            jar_commands::jar_read_source_file,
            // System clipboard file-list read/write (SFTP panel copy/paste)
            clipboard_files::clipboard_read_files,
            clipboard_files::clipboard_write_files,
            clipboard_files::get_clipboard_cache_dir,
            clipboard_files::clipboard_cleanup_cache,
            // Note: PTY terminal I/O now uses WebSocket instead of IPC
            // WebSocket server runs on a dynamically assigned port (9001-9010)
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Stop every tunnel and service when the app exits.
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<toolbox::ToolboxState>() {
                    state.shutdown_all();
                }
            }
        });
}
