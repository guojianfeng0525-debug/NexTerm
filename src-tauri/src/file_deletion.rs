//! Validation shared by SSH, SFTP and FTP deletion commands.

pub fn validate_remote_delete_target(path: &str, parent: &str) -> Result<(), String> {
    fn canonical_absolute(path: &str) -> bool {
        path.starts_with('/')
            && !path.contains('\0')
            && (path == "/"
                || path[1..]
                    .split('/')
                    .all(|part| !part.is_empty() && part != "." && part != ".."))
    }
    let parent = if parent == "/" {
        "/"
    } else {
        parent.trim_end_matches('/')
    };
    if path == "/" || !canonical_absolute(path) || !canonical_absolute(parent) {
        return Err("Refusing to delete a root, navigation, or non-canonical remote path".into());
    }
    let actual_parent =
        path.rsplit_once('/')
            .map(|(directory, _)| if directory.is_empty() { "/" } else { directory });
    if actual_parent != Some(parent) {
        return Err("Deletion target must be an immediate child of the confirmed directory".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_only_children_of_the_confirmed_directory() {
        for (path, parent) in [
            ("/srv/app/a  b.txt", "/srv/app"),
            ("/srv/app/a'b", "/srv/app/"),
            ("/file", "/"),
        ] {
            assert!(
                validate_remote_delete_target(path, parent).is_ok(),
                "{path}"
            );
        }
        for (path, parent) in [
            ("/", "/"),
            ("/srv/app", "/srv/app/logs"),
            ("/srv/app/logs/..", "/srv/app/logs"),
            ("/srv/../etc/file", "/etc"),
            ("/srv/app//file", "/srv/app"),
            ("relative/file", "relative"),
            ("/srv/app/sub/file", "/srv/app"),
            ("/srv/app/file", "/srv/other"),
            ("/srv/app/file\0", "/srv/app"),
        ] {
            assert!(
                validate_remote_delete_target(path, parent).is_err(),
                "{path}"
            );
        }
    }
}
