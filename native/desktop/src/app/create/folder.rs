//! Reads an OpenClaw or Hermes agent folder for `bots.importPreview`, choosing the same files the
//! server's `agentImportFolder` (packages/core/src/agent-import) would. Only those files leave the
//! device. Settings files that can hold keys (`openclaw.json`, `config.yaml`, `.env`,
//! `auth.json`) are never read: the server's clients strip their secrets before sending, and this
//! client has no such projection.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fs;
use std::path::Path;

use serde::Serialize;

const MAX_FILES: usize = 500;
const MAX_FILE_LENGTH: u64 = 100_000;
const MAX_TOTAL_LENGTH: u64 = 4_000_000;
const MAX_SKILL_SIBLINGS: usize = 200;
/// How many entries a walk visits before it calls the folder too large.
const MAX_WALK: usize = 20_000;

const WORKSPACE_FILES: &[&str] = &[
    "SOUL.md",
    "AGENTS.md",
    "IDENTITY.md",
    "MEMORY.md",
    "USER.md",
    "TOOLS.md",
    "HEARTBEAT.md",
    "BOOTSTRAP.md",
    "BOOT.md",
    "HERMES.md",
    ".hermes.md",
    "memories/MEMORY.md",
    "memories/USER.md",
];
const CONFIG_FILES: &[&str] =
    &["openclaw.json", ".env", "config.yaml", "auth.json", "cron/jobs.json", "skills/.bundled_manifest"];
/// Config files this client never reads; see the module comment.
const UNREAD_CONFIG_FILES: &[&str] = &["openclaw.json", ".env", "config.yaml", "auth.json"];
const BUNDLED_MANIFEST: &str = "skills/.bundled_manifest";
const SOURCE_FOLDERS: &[&str] = &["skills", "memory", "memories", ".agents"];
const PRIVATE_FOLDERS: &[&str] = &["sessions", "logs", "cron", "credentials"];

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ImportFile {
    pub path: String,
    pub content: String,
}

/// What `bots.importPreview` and `bots.importCreate` take from a folder.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Upload {
    pub files: Vec<ImportFile>,
    pub skill_files: BTreeMap<String, Vec<String>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FolderError {
    NotFound,
    TooLarge,
    Unreadable,
}

impl FolderError {
    pub fn sentence(self) -> &'static str {
        match self {
            FolderError::NotFound => "No OpenClaw, Hermes or agent document found.",
            FolderError::TooLarge => "These files are too large to import.",
            FolderError::Unreadable => "This folder couldn't be read. Choose it again.",
        }
    }
}

fn is_private(path: &str) -> bool {
    PRIVATE_FOLDERS.contains(&path.split('/').next().unwrap_or(""))
}

/// `^(?:\.agents/)?skills/(?:[^/]+/){1,4}SKILL\.md$`
fn is_skill_path(path: &str) -> bool {
    let rest = path.strip_prefix(".agents/").unwrap_or(path);
    let Some(rest) = rest.strip_prefix("skills/") else { return false };
    let segments: Vec<&str> = rest.split('/').collect();
    let folders = segments.len().saturating_sub(1);
    segments.last() == Some(&"SKILL.md") && (1..=4).contains(&folders) && segments.iter().all(|part| !part.is_empty())
}

/// `^memory/[^/]+\.md$`
fn is_daily_memory(path: &str) -> bool {
    path.strip_prefix("memory/").is_some_and(|name| name.len() > 3 && name.ends_with(".md") && !name.contains('/'))
}

fn is_workspace_folder(name: &str) -> bool {
    name == "workspace" || name.strip_prefix("workspace-").is_some_and(|rest| !rest.is_empty())
}

pub fn is_candidate(path: &str) -> bool {
    if CONFIG_FILES.contains(&path) {
        return true;
    }
    !is_private(path) && (WORKSPACE_FILES.contains(&path) || is_daily_memory(path) || is_skill_path(path))
}

fn is_bundled_skill(path: &str, bundled: &HashSet<String>) -> bool {
    if !is_skill_path(path) {
        return false;
    }
    let segments: Vec<&str> = path.split('/').collect();
    let folder = segments.get(segments.len().wrapping_sub(2)).copied().unwrap_or("").to_lowercase();
    bundled.contains(&folder)
}

pub fn bundled_skill_names(manifest: &str) -> HashSet<String> {
    manifest
        .lines()
        .map(|line| line.split(':').next().unwrap_or("").trim().to_lowercase())
        .filter(|name| !name.is_empty())
        .collect()
}

/// Upload paths mapped to their place in the agent's workspace or home.
pub fn agent_folder(paths: &[String], bundled: Option<&HashSet<String>>) -> BTreeMap<String, String> {
    let candidate = |path: &str| is_candidate(path) && !bundled.is_some_and(|names| is_bundled_skill(path, names));
    let first = paths.first().and_then(|path| path.split('/').next()).unwrap_or("");
    let shared = !first.is_empty()
        && !SOURCE_FOLDERS.contains(&first)
        && paths.iter().all(|path| path.starts_with(&format!("{first}/")));
    let relative: Vec<(&str, &str)> = paths
        .iter()
        .map(|path| (path.as_str(), if shared { &path[first.len() + 1..] } else { path.as_str() }))
        .collect();
    let workspaces: BTreeSet<&str> = relative
        .iter()
        .filter_map(|(_, path)| {
            let (folder, rest) = path.split_once('/')?;
            (is_workspace_folder(folder) && is_candidate(rest)).then_some(folder)
        })
        .collect();
    let own_files = relative.iter().any(|(_, path)| WORKSPACE_FILES.contains(path) || path.starts_with("memories/"));
    if own_files || workspaces.is_empty() {
        return relative
            .iter()
            .filter(|(_, path)| candidate(path))
            .map(|(path, home)| (path.to_string(), home.to_string()))
            .collect();
    }
    let workspace = if workspaces.contains("workspace") {
        "workspace"
    } else if workspaces.len() == 1 {
        workspaces.first().copied().unwrap_or_default()
    } else {
        return BTreeMap::new();
    };
    let mut files = BTreeMap::new();
    for (path, in_home) in &relative {
        if let Some(in_workspace) = in_home.strip_prefix(workspace).and_then(|rest| rest.strip_prefix('/')) {
            if candidate(in_workspace) {
                files.insert(path.to_string(), in_workspace.to_string());
            }
        }
    }
    let used: HashSet<String> = files.values().cloned().collect();
    for (path, in_home) in &relative {
        let managed_skill = in_home.starts_with("skills/") && is_skill_path(in_home);
        if (managed_skill || CONFIG_FILES.contains(in_home)) && !used.contains(*in_home) {
            files.insert(path.to_string(), in_home.to_string());
        }
    }
    files
}

/// Names only, never contents, of the other files in each chosen skill's folder.
pub fn skill_siblings(paths: &[String], used: &BTreeMap<String, String>) -> BTreeMap<String, Vec<String>> {
    let mut out = BTreeMap::new();
    for (path, home) in used {
        if !home.ends_with("SKILL.md") || !is_skill_path(home) {
            continue;
        }
        let folder = &path[..path.len() - "SKILL.md".len()];
        let names: Vec<String> = paths
            .iter()
            .filter(|other| *other != path && other.starts_with(folder))
            .map(|other| other[folder.len()..].to_owned())
            .take(MAX_SKILL_SIBLINGS)
            .collect();
        if !names.is_empty() {
            out.insert(home.clone(), names);
        }
    }
    out
}

/// Every file under `root`, as `<folder name>/<relative path>` with forward slashes, the way a
/// browser names a chosen folder's files.
fn walk(root: &Path) -> Result<Vec<(String, u64)>, FolderError> {
    let base = root.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
    let mut out = Vec::new();
    let mut pending = vec![(root.to_path_buf(), base)];
    let mut visited = 0usize;
    while let Some((dir, prefix)) = pending.pop() {
        let entries = fs::read_dir(&dir).map_err(|_| FolderError::Unreadable)?;
        for entry in entries.flatten() {
            visited += 1;
            if visited > MAX_WALK {
                return Err(FolderError::TooLarge);
            }
            let Ok(kind) = entry.file_type() else { continue };
            let name = entry.file_name().to_string_lossy().into_owned();
            let path = if prefix.is_empty() { name } else { format!("{prefix}/{name}") };
            if kind.is_dir() {
                pending.push((entry.path(), path));
            } else if kind.is_file() {
                out.push((path, entry.metadata().map(|meta| meta.len()).unwrap_or(0)));
            }
        }
    }
    out.sort();
    Ok(out)
}

/// Reads the files an import of `root` sends, checking sizes before reading anything.
pub fn read_agent_folder(root: &Path) -> Result<Upload, FolderError> {
    let listed = walk(root)?;
    let paths: Vec<String> = listed.iter().map(|(path, _)| path.clone()).collect();
    let sizes: BTreeMap<&str, u64> = listed.iter().map(|(path, size)| (path.as_str(), *size)).collect();
    let disk = |path: &str| {
        let relative = path.split_once('/').map_or("", |(_, rest)| rest);
        root.join(relative)
    };
    let first = agent_folder(&paths, None);
    let manifest = first.iter().find(|(_, home)| *home == BUNDLED_MANIFEST).map(|(path, _)| path.clone());
    let chosen = match manifest {
        Some(path) => {
            check_sizes([path.as_str()], &sizes)?;
            let text = fs::read(disk(&path)).map_err(|_| FolderError::Unreadable)?;
            agent_folder(&paths, Some(&bundled_skill_names(&String::from_utf8_lossy(&text))))
        }
        None => first,
    };
    let wanted: BTreeMap<String, String> =
        chosen.into_iter().filter(|(_, home)| !UNREAD_CONFIG_FILES.contains(&home.as_str())).collect();
    if wanted.is_empty() {
        return Err(FolderError::NotFound);
    }
    check_sizes(wanted.keys().map(String::as_str), &sizes)?;
    let mut files = Vec::with_capacity(wanted.len());
    for path in wanted.keys() {
        let bytes = fs::read(disk(path)).map_err(|_| FolderError::Unreadable)?;
        files.push(ImportFile { path: path.clone(), content: String::from_utf8_lossy(&bytes).into_owned() });
    }
    Ok(Upload { skill_files: skill_siblings(&paths, &wanted), files })
}

fn check_sizes<'a>(paths: impl IntoIterator<Item = &'a str>, sizes: &BTreeMap<&str, u64>) -> Result<(), FolderError> {
    let mut count = 0usize;
    let mut total = 0u64;
    for path in paths {
        count += 1;
        // A character takes at least one byte, so a byte size bounds the text the server checks.
        let bytes = sizes.get(path).copied().unwrap_or(0);
        if bytes > MAX_FILE_LENGTH * 4 {
            return Err(FolderError::TooLarge);
        }
        total += bytes;
    }
    if count > MAX_FILES || total > MAX_TOTAL_LENGTH * 4 {
        return Err(FolderError::TooLarge);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(list: &[&str]) -> Vec<String> {
        list.iter().map(|path| path.to_string()).collect()
    }

    #[test]
    fn an_openclaw_workspace_sends_only_its_agent_files() {
        let chosen = agent_folder(
            &paths(&[
                "agent/SOUL.md",
                "agent/AGENTS.md",
                "agent/README.md",
                "agent/memory/2026-11-01.md",
                "agent/sessions/one.md",
                "agent/skills/triage/SKILL.md",
                "agent/skills/triage/run.py",
                "agent/notes/private.md",
            ]),
            None,
        );
        let homes: Vec<&str> = chosen.values().map(String::as_str).collect();
        assert_eq!(homes, ["AGENTS.md", "SOUL.md", "memory/2026-11-01.md", "skills/triage/SKILL.md"]);
    }

    #[test]
    fn an_openclaw_home_uses_its_workspace_and_managed_skills() {
        let chosen = agent_folder(
            &paths(&[
                ".openclaw/openclaw.json",
                ".openclaw/workspace/SOUL.md",
                ".openclaw/workspace/skills/a/SKILL.md",
                ".openclaw/skills/a/SKILL.md",
                ".openclaw/skills/b/SKILL.md",
                ".openclaw/cron/jobs.json",
                ".openclaw/logs/today.md",
            ]),
            None,
        );
        let mapped: Vec<(&str, &str)> = chosen.iter().map(|(path, home)| (path.as_str(), home.as_str())).collect();
        assert_eq!(
            mapped,
            [
                (".openclaw/cron/jobs.json", "cron/jobs.json"),
                (".openclaw/openclaw.json", "openclaw.json"),
                (".openclaw/skills/b/SKILL.md", "skills/b/SKILL.md"),
                (".openclaw/workspace/SOUL.md", "SOUL.md"),
                (".openclaw/workspace/skills/a/SKILL.md", "skills/a/SKILL.md"),
            ]
        );
    }

    #[test]
    fn two_named_workspaces_and_no_default_choose_nothing() {
        let chosen = agent_folder(&paths(&["home/workspace-a/SOUL.md", "home/workspace-b/SOUL.md"]), None);
        assert!(chosen.is_empty());
    }

    #[test]
    fn hermes_bundled_skills_stay_on_the_device() {
        let bundled = bundled_skill_names("triage:abc123\n\n Search:def\n");
        let chosen = agent_folder(
            &paths(&["h/HERMES.md", "h/skills/triage/SKILL.md", "h/skills/search/SKILL.md", "h/skills/mine/SKILL.md"]),
            Some(&bundled),
        );
        let homes: Vec<&str> = chosen.values().map(String::as_str).collect();
        assert_eq!(homes, ["HERMES.md", "skills/mine/SKILL.md"]);
    }

    #[test]
    fn skill_paths_follow_the_servers_shape() {
        assert!(is_skill_path("skills/a/SKILL.md"));
        assert!(is_skill_path(".agents/skills/a/b/c/d/SKILL.md"));
        assert!(!is_skill_path("skills/SKILL.md"));
        assert!(!is_skill_path("skills/a/b/c/d/e/SKILL.md"));
        assert!(!is_skill_path("other/a/SKILL.md"));
        assert!(is_daily_memory("memory/today.md"));
        assert!(!is_daily_memory("memory/deep/today.md"));
    }

    #[test]
    fn a_skill_lists_the_names_of_the_files_beside_it() {
        let all = paths(&["a/skills/t/SKILL.md", "a/skills/t/run.py", "a/skills/t/lib/x.py", "a/SOUL.md"]);
        let used = agent_folder(&all, None);
        let siblings = skill_siblings(&all, &used);
        assert_eq!(siblings.get("skills/t/SKILL.md").unwrap(), &vec!["run.py".to_string(), "lib/x.py".to_string()]);
    }

    #[test]
    fn a_folder_on_disk_sends_its_agent_files_and_never_its_key_files() {
        let root = std::env::temp_dir().join(format!("superbot-import-{}", uuid::Uuid::new_v4()));
        let agent = root.join("agent");
        fs::create_dir_all(agent.join("skills/t")).unwrap();
        fs::write(agent.join("SOUL.md"), "Kind.").unwrap();
        fs::write(agent.join("openclaw.json"), "{\"key\":\"secret\"}").unwrap();
        fs::write(agent.join(".env"), "KEY=secret").unwrap();
        fs::write(agent.join("skills/t/SKILL.md"), "---\nname: t\n---\nDo it.").unwrap();
        fs::write(agent.join("skills/t/helper.sh"), "echo").unwrap();
        let upload = read_agent_folder(&agent).unwrap();
        let sent: Vec<&str> = upload.files.iter().map(|file| file.path.as_str()).collect();
        assert_eq!(sent, ["agent/SOUL.md", "agent/skills/t/SKILL.md"]);
        assert_eq!(upload.skill_files.get("skills/t/SKILL.md").unwrap(), &vec!["helper.sh".to_string()]);
        fs::write(agent.join("SOUL.md"), vec![b'a'; 400_001]).unwrap();
        assert_eq!(read_agent_folder(&agent), Err(FolderError::TooLarge));
        fs::remove_dir_all(&root).unwrap();
        let empty = std::env::temp_dir().join(format!("superbot-import-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(empty.join("notes")).unwrap();
        fs::write(empty.join("notes/README.md"), "hi").unwrap();
        assert_eq!(read_agent_folder(&empty), Err(FolderError::NotFound));
        fs::remove_dir_all(&empty).unwrap();
    }
}
