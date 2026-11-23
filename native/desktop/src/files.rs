//! Files going into a conversation and coming out of one.

use std::path::{Path, PathBuf};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;

// The server's own defaults, used when `me` states no limit of its own.
pub const DEFAULT_MAX_BYTES: u64 = 10 * 1024 * 1024;
pub const DEFAULT_MAX_COUNT: usize = 4;

/// The largest stored file this app reads into memory to save or open. The artifact RPC
/// returns a file whole, as base64 in one JSON body.
pub const LARGEST_DOWNLOAD: u64 = 64 * 1024 * 1024;

/// The type the server stores a file of this name as, or None for a kind it does not accept as
/// an attachment.
pub fn mime_for(name: &str) -> Option<&'static str> {
    let extension = name.rsplit_once('.').map(|(_, extension)| extension.to_ascii_lowercase())?;
    Some(match extension.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "heic" => "image/heic",
        "heif" => "image/heif",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "m4a" => "audio/mp4",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "3gp" => "video/3gpp",
        "pdf" => "application/pdf",
        "txt" => "text/plain",
        "md" | "markdown" => "text/markdown",
        "csv" => "text/csv",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "html" | "htm" => "text/html",
        "json" => "application/json",
        "zip" => "application/zip",
        "rar" => "application/vnd.rar",
        "7z" => "application/x-7z-compressed",
        _ => return None,
    })
}

pub fn is_image(mime_type: &str) -> bool {
    matches!(base_type(mime_type), "image/jpeg" | "image/png" | "image/webp" | "image/gif")
}

fn base_type(mime_type: &str) -> &str {
    mime_type.split(';').next().unwrap_or(mime_type).trim()
}

/// The extension a stored file is opened under, for the kinds that are safe to hand to the
/// system's own viewer: pictures, PDF, plain text, sound and video. The extension comes from
/// the stored type, never from the file's name, so a file named like a program is not run.
/// Pages, spreadsheets and archives can carry scripts, macros or programs; they are saved, not
/// opened.
pub fn opens_as(mime_type: &str) -> Option<&'static str> {
    Some(match base_type(mime_type) {
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "application/pdf" => "pdf",
        "text/plain" => "txt",
        "text/markdown" => "md",
        "application/json" => "json",
        "audio/mpeg" => "mp3",
        "audio/wav" => "wav",
        "audio/ogg" => "ogg",
        "audio/mp4" => "m4a",
        "video/mp4" => "mp4",
        "video/quicktime" => "mov",
        _ => return None,
    })
}

pub fn size_label(bytes: u64) -> String {
    const KIB: f64 = 1024.;
    let size = bytes as f64;
    if size < KIB {
        format!("{bytes} B")
    } else if size < KIB * KIB {
        format!("{:.0} KB", size / KIB)
    } else {
        format!("{:.1} MB", size / (KIB * KIB))
    }
}

/// Why a chosen file was not attached.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Refused {
    Unsupported(String),
    TooLarge { name: String, limit: u64 },
    Empty(String),
    Unreadable(String),
}

impl Refused {
    pub fn sentence(&self) -> String {
        match self {
            Self::Unsupported(name) => format!("{name} is a kind of file that can't be attached."),
            Self::TooLarge { name, limit } => {
                format!("{name} is larger than the {} this server accepts.", size_label(*limit))
            }
            Self::Empty(name) => format!("{name} is empty."),
            Self::Unreadable(name) => format!("{name} couldn't be read."),
        }
    }
}

/// A file checked and ready to attach. Nothing has been read from it yet.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Picked {
    pub path: PathBuf,
    pub name: String,
    pub mime_type: &'static str,
    pub size: u64,
}

fn name_of(path: &Path) -> String {
    path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into())
}

/// Checks a chosen file's kind and size from its metadata, without reading it.
pub fn inspect(path: &Path, max_bytes: u64) -> Result<Picked, Refused> {
    let name = name_of(path);
    let Some(mime_type) = mime_for(&name) else {
        return Err(Refused::Unsupported(name));
    };
    let size = match std::fs::metadata(path) {
        Ok(metadata) if metadata.is_file() => metadata.len(),
        _ => return Err(Refused::Unreadable(name)),
    };
    if size == 0 {
        Err(Refused::Empty(name))
    } else if size > max_bytes {
        Err(Refused::TooLarge { name, limit: max_bytes })
    } else {
        Ok(Picked { path: path.to_owned(), name, mime_type, size })
    }
}

/// Reads a checked file as the base64 the artifact RPC takes. The size is checked again, since
/// the file can have grown since it was chosen.
pub fn read_base64(path: &Path, max_bytes: u64) -> Result<String, Refused> {
    let name = name_of(path);
    let bytes = std::fs::read(path).map_err(|_| Refused::Unreadable(name.clone()))?;
    if bytes.is_empty() {
        Err(Refused::Empty(name))
    } else if bytes.len() as u64 > max_bytes {
        Err(Refused::TooLarge { name, limit: max_bytes })
    } else {
        Ok(BASE64.encode(bytes))
    }
}

/// The bytes of a stored file, or None when the server's base64 is damaged or over the bound.
pub fn decode(content_base64: &str) -> Option<Vec<u8>> {
    if content_base64.len() as u64 > LARGEST_DOWNLOAD / 3 * 4 + 4 {
        return None;
    }
    BASE64.decode(content_base64.as_bytes()).ok()
}

/// A stored file's name made safe to use as a file name on this computer: no folders, no
/// control characters, none of the characters or device names Windows refuses.
pub fn safe_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|letter| match letter {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            letter if letter.is_control() => '_',
            letter => letter,
        })
        .collect();
    let cleaned = cleaned.trim().trim_end_matches(['.', ' ']).trim_start_matches('.');
    let stem = cleaned.split('.').next().unwrap_or_default().to_ascii_uppercase();
    let device = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.ends_with(|last: char| last.is_ascii_digit()));
    match cleaned {
        "" => "file".into(),
        cleaned if device => format!("_{cleaned}"),
        cleaned => cleaned.chars().take(200).collect(),
    }
}

pub fn downloads_dir() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(|home| PathBuf::from(home).join("Downloads"))
        .filter(|downloads| downloads.is_dir())
        .unwrap_or_else(std::env::temp_dir)
}

/// Where the copy of a stored file is written before the system opens it: a folder of its own
/// under the temporary directory, named for the file's id, with the extension of its type.
pub fn open_copy_path(artifact_id: &str, name: &str, extension: &str) -> PathBuf {
    let folder: String = artifact_id.chars().filter(|letter| letter.is_ascii_alphanumeric()).take(64).collect();
    let safe = safe_name(name);
    let stem = safe.rsplit_once('.').map_or(safe.as_str(), |(stem, _)| stem);
    std::env::temp_dir().join("superbot-files").join(folder).join(format!("{stem}.{extension}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_kinds_the_server_stores_are_attached() {
        assert_eq!(mime_for("Report.PDF"), Some("application/pdf"));
        assert_eq!(mime_for("notes.md"), Some("text/markdown"));
        assert_eq!(mime_for("setup.exe"), None);
        assert_eq!(mime_for("no-extension"), None);
    }

    #[test]
    fn a_file_is_checked_before_it_is_read() {
        let folder = std::env::temp_dir().join(format!("superbot-files-test-{}", std::process::id()));
        std::fs::create_dir_all(&folder).unwrap();
        let (notes, empty, tool) = (folder.join("notes.txt"), folder.join("empty.txt"), folder.join("tool.exe"));
        std::fs::write(&notes, b"twelve bytes").unwrap();
        std::fs::write(&empty, b"").unwrap();
        std::fs::write(&tool, b"MZ").unwrap();

        let picked = inspect(&notes, 100).unwrap();
        assert_eq!((picked.name.as_str(), picked.mime_type, picked.size), ("notes.txt", "text/plain", 12));
        assert_eq!(inspect(&notes, 11), Err(Refused::TooLarge { name: "notes.txt".into(), limit: 11 }));
        assert_eq!(inspect(&empty, 100), Err(Refused::Empty("empty.txt".into())));
        assert_eq!(inspect(&tool, 100), Err(Refused::Unsupported("tool.exe".into())));
        assert_eq!(inspect(&folder.join("gone.txt"), 100), Err(Refused::Unreadable("gone.txt".into())));

        let encoded = read_base64(&notes, 100).unwrap();
        assert_eq!(decode(&encoded).unwrap(), b"twelve bytes");
        assert_eq!(read_base64(&notes, 11), Err(Refused::TooLarge { name: "notes.txt".into(), limit: 11 }));
        std::fs::remove_dir_all(&folder).unwrap();
    }

    #[test]
    fn a_stored_name_cannot_leave_its_folder_or_name_a_device() {
        assert_eq!(safe_name("../../secrets/plan.pdf"), "_.._secrets_plan.pdf");
        assert_eq!(safe_name("C:\\Windows\\run.bat"), "C__Windows_run.bat");
        assert_eq!(safe_name("  report.txt. "), "report.txt");
        assert_eq!(safe_name("con.txt"), "_con.txt");
        assert_eq!(safe_name("LPT1"), "_LPT1");
        assert_eq!(safe_name("\u{0}\u{7}"), "__");
        assert_eq!(safe_name("..."), "file");
    }

    #[test]
    fn only_inert_kinds_are_opened_and_under_their_types_extension() {
        assert_eq!(opens_as("application/pdf"), Some("pdf"));
        assert_eq!(opens_as("image/png; charset=binary"), Some("png"));
        assert_eq!(opens_as("text/html"), None);
        assert_eq!(opens_as("text/csv"), None);
        assert_eq!(opens_as("application/zip"), None);
        assert_eq!(opens_as("application/vnd.ms-excel"), None);
        // A program stored under a picture's type is opened as a picture, not run.
        let copy = open_copy_path("art_1/../x", "invoice.pdf.exe", "png");
        assert_eq!(copy.file_name().unwrap(), "invoice.pdf.png");
        assert_eq!(copy.parent().unwrap().file_name().unwrap(), "art1x");
        assert!(copy.starts_with(std::env::temp_dir().join("superbot-files")));
    }

    #[test]
    fn sizes_read_at_a_glance() {
        assert_eq!(size_label(62), "62 B");
        assert_eq!(size_label(2048), "2 KB");
        assert_eq!(size_label(3 * 1024 * 1024 + 512 * 1024), "3.5 MB");
    }
}
