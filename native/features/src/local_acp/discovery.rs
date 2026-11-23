use super::{inventory, Disposition, Engine, Error, Provider};
use std::{
    ffi::{OsStr, OsString},
    path::{Path, PathBuf},
};

pub fn discover(id: &str) -> Result<Option<Engine>, Error> {
    Ok(discover_in(id, &path_dirs()))
}

fn path_dirs() -> Vec<PathBuf> {
    std::env::var_os("PATH")
        .map(|path| {
            std::env::split_paths(&path)
                .filter(|dir| dir.is_absolute())
                .collect()
        })
        .unwrap_or_default()
}

fn discover_in(id: &str, dirs: &[PathBuf]) -> Option<Engine> {
    let provider = inventory().iter().find(|row| row.id == id)?;
    if !matches!(provider.disposition, Disposition::Acp | Disposition::PiRpc) {
        return None;
    }
    let name = provider.executable?;
    let native_name = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.into()
    };
    for dir in dirs {
        if let Some(path) = executable(&dir.join(&native_name)) {
            return Some(engine(provider, path, None));
        }
        #[cfg(windows)]
        if let Some((program, script)) = npm_entry(provider, dir, dirs) {
            return Some(engine(provider, program, script));
        }
    }
    if provider.id == "grok" {
        let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })?;
        let path = PathBuf::from(home)
            .join(".grok")
            .join("bin")
            .join(&native_name);
        return executable(&path).map(|path| engine(provider, path, None));
    }
    #[cfg(windows)]
    if provider.id == "cursor" {
        if let Some((node, script)) = cursor_entry() {
            return Some(engine(provider, node, Some(script)));
        }
    }
    None
}

fn engine(provider: &'static Provider, executable: PathBuf, script: Option<PathBuf>) -> Engine {
    Engine {
        provider,
        executable,
        launcher_args: script.into_iter().map(PathBuf::into_os_string).collect(),
        args: provider.args.iter().map(OsString::from).collect(),
    }
}

#[cfg(windows)]
fn npm_entry(
    provider: &Provider,
    dir: &Path,
    dirs: &[PathBuf],
) -> Option<(PathBuf, Option<PathBuf>)> {
    use serde_json::Value;
    use std::io::Read;
    let package = match provider.id {
        "kimi" => "@moonshot-ai/kimi-code",
        "githubCopilot" => "@github/copilot",
        "opencodeGo" => "opencode-ai",
        "cline" => "cline",
        "pi" => "@earendil-works/pi-coding-agent",
        "omp" => "@oh-my-pi/pi-coding-agent",
        "gemini" => "@google/gemini-cli",
        _ => return None,
    };
    let name = provider.executable?;
    if !dir.join(format!("{name}.cmd")).is_file() {
        return None;
    }
    // Resolve the known npm package's JavaScript entrypoint without executing or interpreting a command shim.
    let modules = if dir.file_name() == Some(OsStr::new(".bin")) {
        dir.parent()?.to_owned()
    } else {
        dir.join("node_modules")
    };
    let root = modules.join(package).canonicalize().ok()?;
    let mut metadata = Vec::new();
    std::fs::File::open(root.join("package.json"))
        .ok()?
        .take(262_145)
        .read_to_end(&mut metadata)
        .ok()?;
    if metadata.len() > 262_144 {
        return None;
    }
    let metadata: Value = serde_json::from_slice(&metadata).ok()?;
    if metadata["name"] != package {
        return None;
    }
    if provider.id == "githubCopilot" {
        let arch = match std::env::consts::ARCH {
            "x86_64" => "x64",
            "aarch64" => "arm64",
            _ => return None,
        };
        let platform_package = format!("@github/copilot-win32-{arch}");
        let platform_root = [root.join("node_modules"), modules]
            .into_iter()
            .find_map(|dir| dir.join(&platform_package).canonicalize().ok())?;
        let program = executable(&platform_root.join("copilot.exe"))?;
        return program
            .starts_with(&platform_root)
            .then_some((program, None));
    }
    let entry = metadata["bin"]
        .as_str()
        .or_else(|| metadata["bin"][name].as_str())?;
    let entry = root.join(entry).canonicalize().ok()?;
    if provider.id == "opencodeGo" && entry.starts_with(&root) {
        return executable(&entry).map(|entry| (entry, None));
    }
    if !entry.starts_with(&root)
        || !entry.is_file()
        || !matches!(
            entry.extension().and_then(OsStr::to_str),
            Some("js" | "mjs" | "cjs")
        )
    {
        return None;
    }
    let node = executable(&dir.join("node.exe")).or_else(|| {
        dirs.iter()
            .find_map(|dir| executable(&dir.join("node.exe")))
    })?;
    Some((node, Some(entry)))
}

#[cfg(windows)]
fn cursor_entry() -> Option<(PathBuf, PathBuf)> {
    let root = PathBuf::from(std::env::var_os("LOCALAPPDATA")?).join("cursor-agent");
    if !root.is_absolute() || !root.join("cursor-agent.ps1").is_file() {
        return None;
    }
    let versions = root.join("versions").canonicalize().ok()?;
    let mut candidates: Vec<_> = std::fs::read_dir(&versions)
        .ok()?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name();
            let (date, suffix) = name.to_str()?.split_once('-')?;
            let mut date_parts = date.split('.').map(str::parse::<u32>);
            let date = (
                date_parts.next()?.ok()?,
                date_parts.next()?.ok()?,
                date_parts.next()?.ok()?,
            );
            if date_parts.next().is_some()
                || !suffix.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
            {
                return None;
            }
            Some((date, name, entry.path()))
        })
        .collect();
    candidates.sort_unstable();
    candidates.into_iter().rev().find_map(|(_, _, version)| {
        let version = version.canonicalize().ok()?;
        let script = version.join("index.js").canonicalize().ok()?;
        let node = executable(&version.join("node.exe"))?;
        (version.starts_with(&versions)
            && script.starts_with(&version)
            && node.starts_with(&version))
        .then_some((node, script))
    })
}

pub(super) fn executable(path: &Path) -> Option<PathBuf> {
    if !path.is_absolute() {
        return None;
    }
    let path = path.canonicalize().ok()?;
    if cfg!(windows)
        && !path
            .extension()
            .and_then(OsStr::to_str)
            .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"))
    {
        return None;
    }
    let metadata = path.metadata().ok()?;
    if !metadata.is_file() {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            return None;
        }
    }
    Some(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovery_uses_only_inventory_and_absolute_local_programs() {
        let dir = tempfile::tempdir().unwrap();
        let name = if cfg!(windows) { "grok.exe" } else { "grok" };
        let path = dir.path().join(name);
        std::fs::write(&path, "").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let dirs = [dir.path().to_owned()];
        assert_eq!(
            discover_in("grok", &dirs).unwrap().executable,
            path.canonicalize().unwrap()
        );
        assert!(discover_in(path.to_str().unwrap(), &dirs).is_none());
        for id in [
            "custom-acp",
            "codex",
            "claude",
            "openai",
            "antigravity",
            "museCode",
        ] {
            let provider = inventory().iter().find(|row| row.id == id).unwrap();
            assert!(!matches!(
                provider.disposition,
                Disposition::Acp | Disposition::PiRpc
            ));
            assert!(discover_in(id, &dirs).is_none());
        }
    }
}
