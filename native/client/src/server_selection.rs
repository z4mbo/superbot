use std::env;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use crate::{server_origin, Client, DEFAULT_SERVER};

pub fn selected_server(explicit: Option<&str>) -> String {
    select(explicit, server_file().as_deref())
}

pub fn remember_server(client: &Client) -> io::Result<()> {
    remember_sign_in_server(client, None)
}

/// Keeps a launch-specific server private to that invocation. An address chosen in the form becomes the device default.
pub fn remember_sign_in_server(client: &Client, launch_server: Option<&str>) -> io::Result<()> {
    save_choice(client, launch_server, server_file().as_deref())
}

fn save_choice(
    client: &Client,
    launch_server: Option<&str>,
    path: Option<&Path>,
) -> io::Result<()> {
    if launch_server
        .and_then(|server| server_origin(server.trim()).ok())
        .is_some_and(|(origin, _)| origin.as_str() == client.server())
    {
        return Ok(());
    }
    let path = path.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotFound,
            "Superbot settings directory is unavailable",
        )
    })?;
    save(path, client)
}

fn select(explicit: Option<&str>, path: Option<&Path>) -> String {
    if let Some(explicit) = explicit.map(str::trim).filter(|value| !value.is_empty()) {
        return explicit.to_owned();
    }
    path.and_then(|path| fs::read_to_string(path).ok())
        .and_then(|saved| server_origin(saved.trim()).ok())
        .map_or_else(
            || DEFAULT_SERVER.to_owned(),
            |(origin, _)| origin.to_string(),
        )
}

fn save(path: &Path, client: &Client) -> io::Result<()> {
    let directory = path.parent().expect("server file has a settings directory");
    fs::create_dir_all(directory)?;
    let mut pending = tempfile::NamedTempFile::new_in(directory)?;
    writeln!(pending, "{}", client.server())?;
    pending.persist(path)?;
    Ok(())
}

fn server_file() -> Option<PathBuf> {
    let directory = env_directory("SUPERBOT_CONFIG_DIR").or_else(default_directory)?;
    Some(directory.join("server.txt"))
}

fn env_directory(name: &str) -> Option<PathBuf> {
    env::var_os(name)
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
}

#[cfg(target_os = "windows")]
fn default_directory() -> Option<PathBuf> {
    Some(env_directory("LOCALAPPDATA")?.join("Superbot"))
}

#[cfg(target_os = "macos")]
fn default_directory() -> Option<PathBuf> {
    Some(env_directory("HOME")?.join("Library/Application Support/Superbot"))
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn default_directory() -> Option<PathBuf> {
    let config = env_directory("XDG_CONFIG_HOME")
        .or_else(|| Some(env_directory("HOME")?.join(".config")))?;
    Some(config.join("superbot"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_launch_override_preserves_the_default_until_the_user_chooses_another_origin() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("server.txt");
        let saved = Client::new("https://shared.example.test").unwrap();
        let explicit = "http://127.0.0.1:54871";
        let preview = Client::new(explicit).unwrap();
        save_choice(&saved, None, Some(&path)).unwrap();
        save_choice(&preview, Some(explicit), Some(&path)).unwrap();
        assert_eq!(select(None, Some(&path)), saved.server());
        let replacement = Client::new("https://second.example.test").unwrap();
        save_choice(&replacement, Some(explicit), Some(&path)).unwrap();
        assert_eq!(select(None, Some(&path)), replacement.server());
    }

    #[test]
    fn an_explicit_server_takes_precedence_over_a_saved_server() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("server.txt");
        let saved = Client::new("https://saved.example.test").unwrap();
        save(&path, &saved).unwrap();
        assert_eq!(
            select(Some(" https://other.example.test "), Some(&path)),
            "https://other.example.test"
        );
        assert_eq!(select(Some("invalid"), Some(&path)), "invalid");
        assert_eq!(select(None, Some(&path)), saved.server());
        assert_eq!(select(Some(" "), Some(&path)), saved.server());
    }

    #[test]
    fn only_the_origin_is_saved_and_the_selection_can_be_replaced() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings/server.txt");
        assert_eq!(select(None, Some(&path)), DEFAULT_SERVER);
        let first = Client::new("https://first.example.test")
            .unwrap()
            .with_token("test.token")
            .unwrap();
        save(&path, &first).unwrap();
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "https://first.example.test/\n"
        );
        let next = Client::new("https://next.example.test").unwrap();
        save(&path, &next).unwrap();
        assert_eq!(select(None, Some(&path)), next.server());
        fs::write(&path, "https://example.test/?token=invalid").unwrap();
        assert_eq!(select(None, Some(&path)), DEFAULT_SERVER);
    }
}
