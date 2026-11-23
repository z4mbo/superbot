use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write as _};
use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::{Receipt, T3Error};

pub(crate) fn digest(value: &serde_json::Value) -> String {
    let text = serde_json::to_string(value).expect("JSON values serialize");
    Sha256::digest(text.as_bytes()).iter().map(|byte| format!("{byte:02x}")).collect()
}

/// What the operator confirmed: this brief, in this project.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Intent {
    pub project_id: String,
    pub request: String,
}

/// The T3 endpoint and grant a start went out on, so a retry never crosses grants.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Connection {
    pub url: String,
    pub grant: String,
}

/// The first attempt to start a request. Its operation ID is T3's `clientRequestId` and the
/// receipt's Superbot operation ID, so every retry reuses both.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub intent: Intent,
    pub connection: Connection,
    pub operation_id: String,
}

/// Plans and receipts kept on this computer, one pair per request. Files are written once and
/// never replaced, so concurrent or repeated starts agree on the first one. The file layout
/// matches the T3 Code inbox companion's state directory.
pub struct Ledger {
    directory: PathBuf,
}

impl Ledger {
    pub fn new(directory: impl Into<PathBuf>) -> Self {
        Self { directory: directory.into() }
    }

    pub fn key(server: &str, space: &str, installation: &str, record: &str) -> String {
        digest(&json!([server, space, installation, record]))
    }

    pub fn plan(&self, key: &str) -> Result<Option<Plan>, T3Error> {
        self.read(&format!("{key}.dispatch.json"))
    }

    pub fn receipt(&self, key: &str) -> Result<Option<Receipt>, T3Error> {
        self.read(&format!("{key}.receipt.json"))
    }

    pub fn keep_plan(&self, key: &str, plan: &Plan) -> Result<Plan, T3Error> {
        self.save_once(&format!("{key}.dispatch.json"), plan)
    }

    pub fn keep_receipt(&self, key: &str, receipt: &Receipt) -> Result<Receipt, T3Error> {
        self.save_once(&format!("{key}.receipt.json"), receipt)
    }

    fn read<T: DeserializeOwned>(&self, file: &str) -> Result<Option<T>, T3Error> {
        match fs::read(self.directory.join(file)) {
            Ok(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(T3Error::storage),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
            Err(error) => Err(T3Error::storage(error)),
        }
    }

    fn save_once<T: Serialize + DeserializeOwned>(&self, file: &str, value: &T) -> Result<T, T3Error> {
        private_directory(&self.directory)?;
        let path = self.directory.join(file);
        let temp = self.directory.join(format!("{}.tmp", crate::random_hex()?));
        let mut text = serde_json::to_vec(value).map_err(T3Error::storage)?;
        text.push(b'\n');
        write_new(&temp, &text)?;
        let linked = fs::hard_link(&temp, &path);
        let _ = fs::remove_file(&temp);
        match linked {
            Ok(()) => Ok(serde_json::from_slice(&text).map_err(T3Error::storage)?),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                self.read(file)?.ok_or_else(|| T3Error::storage("a saved file disappeared"))
            }
            Err(error) => Err(T3Error::storage(error)),
        }
    }
}

fn write_new(path: &Path, bytes: &[u8]) -> Result<(), T3Error> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(T3Error::storage)?;
    file.write_all(bytes).and_then(|()| file.sync_all()).map_err(T3Error::storage)
}

fn private_directory(directory: &Path) -> Result<(), T3Error> {
    fs::create_dir_all(directory).map_err(T3Error::storage)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700)).map_err(T3Error::storage)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{digest, Connection, Intent, Ledger, Plan};

    #[test]
    fn keys_hash_the_same_json_the_companion_hashes() {
        let key =
            Ledger::key("https://superbot.example.com", "space-1", "install-1", "6f1c1a52-6a43-4d1e-9e43-9a1f3f0b2c11");
        assert_eq!(key, "1cf98956a26094d335a6003ce96bc552b43552b705ec7ce24e903f68474ea681");
        assert_eq!(
            digest(&json!(["Fix ü\n", "brief \u{2028} \"q\""])),
            "f24d68785f52ccaa6ac73ee13cf299dfbf2b88e24747331c59276530058a4e20"
        );
    }

    #[test]
    fn the_first_saved_plan_wins() {
        let directory = tempfile::tempdir().unwrap();
        let ledger = Ledger::new(directory.path().join("state"));
        let plan = |operation: &str| Plan {
            intent: Intent { project_id: "p".into(), request: "r".into() },
            connection: Connection { url: "u".into(), grant: "g".into() },
            operation_id: operation.into(),
        };
        assert_eq!(ledger.plan("k").unwrap(), None);
        assert_eq!(ledger.keep_plan("k", &plan("first")).unwrap().operation_id, "first");
        assert_eq!(ledger.keep_plan("k", &plan("second")).unwrap().operation_id, "first");
        assert_eq!(ledger.plan("k").unwrap().unwrap().operation_id, "first");
        let saved = std::fs::read_to_string(directory.path().join("state/k.dispatch.json")).unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&saved).unwrap(),
            json!({ "intent": { "projectId": "p", "request": "r" }, "connection": { "url": "u", "grant": "g" }, "operationId": "first" })
        );
        let leftovers = std::fs::read_dir(directory.path().join("state")).unwrap().count();
        assert_eq!(leftovers, 1);
    }
}
