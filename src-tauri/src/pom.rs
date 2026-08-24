//! Maven `pom.xml` parsing and dependency jar resolution.
//!
//! Extracts direct `<dependencies>` (groupId/artifactId/version) and resolves
//! them to jars in the local `~/.m2/repository`. No transitive expansion.
//! Uses a lightweight parser (no XML crate) — pom structures are regular
//! enough and this keeps the dependency footprint small.

use std::path::{Path, PathBuf};

/// One parsed dependency.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PomDependency {
    pub group_id: String,
    pub artifact_id: String,
    pub version: String,
    pub scope: String,
    /// Resolved jar path if found in the local repo.
    pub jar_path: Option<String>,
}

/// Result of parsing a pom.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PomInfo {
    pub group_id: String,
    pub artifact_id: String,
    pub version: String,
    pub dependencies: Vec<PomDependency>,
    /// Number of deps that resolved to an existing jar.
    pub resolved_count: usize,
}

/// Locate the local Maven repository root (~/.m2/repository or M2_REPO).
pub fn local_repo_root() -> PathBuf {
    if let Ok(repo) = std::env::var("M2_REPO") {
        if !repo.is_empty() {
            return PathBuf::from(repo);
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        let p = PathBuf::from(&home).join(".m2").join("repository");
        if p.is_dir() {
            return p;
        }
    }
    if let Ok(profile) = std::env::var("USERPROFILE") {
        let p = PathBuf::from(&profile).join(".m2").join("repository");
        if p.is_dir() {
            return p;
        }
    }
    PathBuf::from(".m2/repository")
}

/// Resolve a dependency to its jar in the local repo.
/// Path: <repo>/<group path>/<artifact>/<version>/<artifact>-<version>.jar
pub fn resolve_dependency_jar(
    repo: &Path,
    group_id: &str,
    artifact_id: &str,
    version: &str,
) -> Option<PathBuf> {
    let group_path: PathBuf = group_id.split('.').collect();
    let jar_name = format!("{artifact_id}-{version}.jar");
    let candidate = repo
        .join(&group_path)
        .join(artifact_id)
        .join(version)
        .join(&jar_name);
    if candidate.is_file() {
        Some(candidate)
    } else {
        // Some artifacts publish only a -sources.jar or classifier; also try
        // without version suffix in the filename (rare).
        None
    }
}

/// Read text content between `<tag>` and `</tag>` (first occurrence).
fn extract_tag<'a>(xml: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = xml.find(&open)? + open.len();
    let end = xml[start..].find(&close)? + start;
    Some(xml[start..end].trim())
}

/// Split `<dependencies>...</dependencies>` into per-`<dependency>` blocks.
/// Handles `<dependencyManagement>` by only scanning inside a `<dependencies>`
/// block that is NOT nested in `<dependencyManagement>`.
fn extract_dependency_blocks(xml: &str) -> Vec<String> {
    let mut blocks = Vec::new();
    let mut rest = xml;
    loop {
        // Find the next `<dependencies>` open (not inside dependencyManagement).
        let deps_open = match find_dependencies_open(rest) {
            Some(i) => i,
            None => break,
        };
        let after_open = &rest[deps_open + "<dependencies>".len()..];
        // Find its closing `</dependencies>`.
        let close = after_open.find("</dependencies>");
        let deps_body = match close {
            Some(c) => &after_open[..c],
            None => break,
        };
        // Extract every <dependency> block inside.
        let mut inner = deps_body;
        while let Some(s) = inner.find("<dependency>") {
            let after_d = &inner[s + "<dependency>".len()..];
            let e = match after_d.find("</dependency>") {
                Some(e) => e,
                None => break,
            };
            blocks.push(after_d[..e].to_string());
            inner = &after_d[e + "</dependency>".len()..];
        }
        // Continue after this dependencies block.
        rest = &after_open[close.unwrap() + "</dependencies>".len()..];
    }
    blocks
}

/// Find the next `<dependencies>` that is NOT inside `<dependencyManagement>`.
fn find_dependencies_open(xml: &str) -> Option<usize> {
    let mut search_from = 0;
    loop {
        let open = xml[search_from..].find("<dependencies>")? + search_from;
        // Is this inside a `<dependencyManagement>`? Check the text before it.
        let before = &xml[..open];
        let mgmt_open = before.rfind("<dependencyManagement>");
        let mgmt_close = before.rfind("</dependencyManagement>");
        let inside_mgmt = match (mgmt_open, mgmt_close) {
            (Some(o), Some(c)) => o > c,
            (Some(_), None) => true,
            _ => false,
        };
        if !inside_mgmt {
            return Some(open);
        }
        // Skip past this management block.
        let after = &xml[open..];
        search_from = match after.find("</dependencyManagement>") {
            Some(c) => open + c + "</dependencyManagement>".len(),
            None => return None,
        };
    }
}

/// Parse a pom.xml string into direct dependencies.
pub fn parse_pom(xml: &str) -> PomInfo {
    let group_id = extract_tag(xml, "groupId").unwrap_or("").to_string();
    let artifact_id = extract_tag(xml, "artifactId").unwrap_or("").to_string();
    let version = extract_tag(xml, "version").unwrap_or("").to_string();

    let repo = local_repo_root();
    let mut dependencies = Vec::new();
    let mut resolved = 0usize;

    for block in extract_dependency_blocks(xml) {
        let g = extract_tag(&block, "groupId")
            .unwrap_or("")
            .trim()
            .to_string();
        let a = extract_tag(&block, "artifactId")
            .unwrap_or("")
            .trim()
            .to_string();
        let v = extract_tag(&block, "version")
            .unwrap_or("")
            .trim()
            .to_string();
        let scope = extract_tag(&block, "scope")
            .unwrap_or("compile")
            .trim()
            .to_string();
        if g.is_empty() || a.is_empty() {
            continue;
        }
        // Resolve ${project.version} / ${project.groupId} style variables.
        let resolved_version = if v.starts_with("${project.version}") {
            version.clone()
        } else if v.starts_with("${project.groupId}") {
            group_id.clone()
        } else {
            v.clone()
        };
        if resolved_version.is_empty() {
            dependencies.push(PomDependency {
                group_id: g,
                artifact_id: a,
                version: v,
                scope,
                jar_path: None,
            });
            continue;
        }
        let jar = resolve_dependency_jar(&repo, &g, &a, &resolved_version);
        if jar.is_some() {
            resolved += 1;
        }
        dependencies.push(PomDependency {
            group_id: g,
            artifact_id: a,
            version: resolved_version,
            scope,
            jar_path: jar.map(|p| p.display().to_string()),
        });
    }

    PomInfo {
        group_id,
        artifact_id,
        version,
        dependencies,
        resolved_count: resolved,
    }
}

/// Read a pom file and parse it.
pub fn parse_pom_file(path: &Path) -> Result<PomInfo, String> {
    let xml = std::fs::read_to_string(path).map_err(|e| format!("read pom: {e}"))?;
    Ok(parse_pom(&xml))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_POM: &str = r#"<?xml version="1.0"?>
<project>
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>my-app</artifactId>
  <version>1.0.0</version>
  <dependencies>
    <dependency>
      <groupId>org.postgresql</groupId>
      <artifactId>postgresql</artifactId>
      <version>42.3.4</version>
    </dependency>
    <dependency>
      <groupId>junit</groupId>
      <artifactId>junit</artifactId>
      <version>4.12</version>
      <scope>test</scope>
    </dependency>
    <dependency>
      <groupId>cn.hutool</groupId>
      <artifactId>hutool-all</artifactId>
      <version>${project.version}</version>
    </dependency>
  </dependencies>
</project>"#;

    #[test]
    fn parse_basic_deps() {
        let info = parse_pom(SAMPLE_POM);
        assert_eq!(info.group_id, "com.example");
        assert_eq!(info.artifact_id, "my-app");
        assert_eq!(info.version, "1.0.0");
        assert_eq!(info.dependencies.len(), 3);
        assert_eq!(info.dependencies[0].artifact_id, "postgresql");
        assert_eq!(info.dependencies[1].scope, "test");
        // ${project.version} resolves to 1.0.0 → hutool-all-1.0.0 won't exist.
        assert_eq!(info.dependencies[2].version, "1.0.0");
    }

    #[test]
    fn resolve_from_local_repo() {
        let repo = local_repo_root();
        if !repo.is_dir() {
            eprintln!("skipping: no local maven repo");
            return;
        }
        // postgresql 42.3.4 is known to exist in the dev repo.
        let jar = resolve_dependency_jar(&repo, "org.postgresql", "postgresql", "42.3.4");
        assert!(jar.is_some(), "postgresql jar should resolve");
        if let Some(j) = jar {
            assert!(j.is_file());
        }
    }

    #[test]
    fn ignores_dependency_management() {
        let xml = r#"<project>
  <dependencyManagement>
    <dependencies>
      <dependency>
        <groupId>a</groupId><artifactId>b</artifactId><version>9</version>
      </dependency>
    </dependencies>
  </dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>c</groupId><artifactId>d</artifactId><version>1</version>
    </dependency>
  </dependencies>
</project>"#;
        let info = parse_pom(xml);
        assert_eq!(info.dependencies.len(), 1);
        assert_eq!(info.dependencies[0].artifact_id, "d");
    }
}
