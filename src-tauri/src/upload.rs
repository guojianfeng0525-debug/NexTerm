//! Upload authorization and recoverable publication, shared by SSH/SFTP/FTP.
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, OnceLock, Weak};
use tokio::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UploadVersion {
    pub kind: String,
    pub size: u64,
    pub modified: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UploadTarget {
    pub path: String,
    pub version: Option<UploadVersion>,
}

#[derive(Debug, Serialize)]
pub struct UploadResponse {
    pub success: bool,
    pub committed: bool,
    pub bytes_transferred: Option<u64>,
    pub error: Option<String>,
    pub conflict: Option<UploadTarget>,
    pub destination_path: String,
}

impl UploadResponse {
    pub fn conflict(target: UploadTarget) -> Self {
        Self {
            success: false,
            committed: false,
            bytes_transferred: None,
            error: None,
            destination_path: target.path.clone(),
            conflict: Some(target),
        }
    }
}

/// Serializes publication within a connection, including uploads from other views.
pub async fn connection_lock(id: &str) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Weak<Mutex<()>>>>> = OnceLock::new();
    let mut locks = LOCKS.get_or_init(Mutex::default).lock().await;
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(id).and_then(Weak::upgrade) {
        return lock;
    }
    let lock = Arc::new(Mutex::new(()));
    locks.insert(id.to_owned(), Arc::downgrade(&lock));
    lock
}

pub fn parent_and_name(path: &str) -> Result<(&str, &str), String> {
    let (parent, name) = path
        .rsplit_once('/')
        .ok_or("Remote upload path must be absolute")?;
    let parent = if parent.is_empty() { "/" } else { parent };
    crate::file_deletion::validate_remote_delete_target(path, parent)?;
    Ok((parent, name))
}

pub fn may_replace(current: &UploadVersion, approved: Option<&UploadVersion>) -> bool {
    current.kind == "File" && approved == Some(current)
}

pub fn numbered_copy(path: &str, number: u32) -> String {
    let (directory, name) = path.rsplit_once('/').unwrap_or(("", path));
    let (stem, extension) = match name.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() && !extension.is_empty() => {
            (stem, format!(".{extension}"))
        }
        _ => (name, String::new()),
    };
    format!("{directory}/{stem} ({number}){extension}")
}

/// Once publication starts it must finish or restore the original, even if the
/// user cancels. A failed restoration preserves the backup and names it in the error.
pub async fn publish<R, RF, D, DF>(
    stage: &str,
    destination: &str,
    backup: Option<&str>,
    rename: R,
    remove: D,
) -> Result<(), String>
where
    R: Fn(String, String) -> RF,
    RF: Future<Output = Result<(), String>>,
    D: Fn(String) -> DF,
    DF: Future<Output = ()>,
{
    if let Some(backup) = backup {
        rename(destination.to_owned(), backup.to_owned()).await?;
        if let Err(error) = rename(stage.to_owned(), destination.to_owned()).await {
            return match rename(backup.to_owned(), destination.to_owned()).await {
                Ok(()) => Err(format!("Upload publication failed; original restored: {error}")),
                Err(restore) => Err(format!("Upload publication failed: {error}. Original preserved at '{backup}'; restore failed: {restore}")),
            };
        }
        remove(backup.to_owned()).await;
        Ok(())
    } else {
        rename(stage.to_owned(), destination.to_owned()).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    #[test]
    fn replacement_requires_exact_file_approval() {
        let version = UploadVersion {
            kind: "File".into(),
            size: 10,
            modified: Some("a".into()),
        };
        assert!(!may_replace(&version, None));
        assert!(may_replace(&version, Some(&version)));
        assert!(!may_replace(
            &UploadVersion {
                size: 11,
                ..version.clone()
            },
            Some(&version)
        ));
        assert!(!may_replace(
            &UploadVersion {
                kind: "Directory".into(),
                ..version.clone()
            },
            Some(&version)
        ));
        assert!(!may_replace(
            &UploadVersion {
                kind: "Symlink".into(),
                ..version.clone()
            },
            Some(&version)
        ));
    }

    #[test]
    fn copy_names_preserve_extensions_and_dotfiles() {
        assert_eq!(numbered_copy("/srv/report.csv", 2), "/srv/report (2).csv");
        assert_eq!(numbered_copy("/.env", 1), "/.env (1)");
        assert_eq!(numbered_copy("/测试 文件", 1), "/测试 文件 (1)");
        for path in ["/", "relative/file", "/srv/../file", "/srv//file"] {
            assert!(parent_and_name(path).is_err());
        }
    }

    #[tokio::test]
    async fn publication_failure_restores_original() {
        let files = StdMutex::new(HashMap::from([
            ("dest".to_string(), "original"),
            ("stage".to_string(), "new"),
        ]));
        let result = publish(
            "stage",
            "dest",
            Some("backup"),
            |from, to| {
                let result = if from == "stage" {
                    Err("injected failure".into())
                } else {
                    let mut files = files.lock().unwrap();
                    let contents = files.remove(&from).unwrap();
                    files.insert(to, contents);
                    Ok(())
                };
                std::future::ready(result)
            },
            |_| std::future::ready(()),
        )
        .await;
        assert!(result.unwrap_err().contains("original restored"));
        assert_eq!(files.lock().unwrap().get("dest"), Some(&"original"));
    }

    #[tokio::test]
    async fn failed_rollback_retains_backup_and_reports_recovery_path() {
        let files = StdMutex::new(HashMap::from([("dest".to_string(), "original")]));
        let result = publish(
            "stage",
            "dest",
            Some("backup"),
            |from, to| {
                let result = if from == "dest" {
                    let mut files = files.lock().unwrap();
                    let contents = files.remove(&from).unwrap();
                    files.insert(to, contents);
                    Ok(())
                } else {
                    Err("connection lost".into())
                };
                std::future::ready(result)
            },
            |_| std::future::ready(()),
        )
        .await;
        assert!(result.unwrap_err().contains("preserved at 'backup'"));
        assert_eq!(files.lock().unwrap().get("backup"), Some(&"original"));
    }
}
