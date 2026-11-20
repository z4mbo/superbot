use std::collections::HashSet;
use std::path::PathBuf;

use sha2::{Digest, Sha256};
use superbot_features::local_acp;
use superbot_features::local_cli::{InstalledModel, LocalCli, Provider, Status};

/// One engine on this computer that can run a local turn, with the models it reports.
#[derive(Clone)]
pub(super) struct LocalGroup {
    pub engine: &'static str,
    pub models: Vec<InstalledModel>,
}

/// Engines the desktop can run a local turn with: signed-in Claude Code and Codex, and ACP
/// engines that are signed in and safe to run. Others are left out rather than offered.
pub(super) async fn probe_local(cli: LocalCli) -> Vec<LocalGroup> {
    let direct = Provider::ALL.map(|provider| {
        let cli = cli.clone();
        async move {
            if cli.status(provider).await != Status::Ready {
                return None;
            }
            let models = cli.catalog(provider).await.ok()?;
            (!models.is_empty()).then_some(LocalGroup { engine: provider.name(), models })
        }
    });
    let acp = local_acp::inventory()
        .iter()
        .filter(|provider| {
            matches!(
                provider.disposition,
                local_acp::Disposition::Acp
                    | local_acp::Disposition::PiRpc
                    | local_acp::Disposition::LocalConfiguration
            )
        })
        .map(|provider| async move {
            let engine = if provider.disposition == local_acp::Disposition::LocalConfiguration {
                local_acp::load_custom(&LocalCli::config_dir()?).ok().flatten()
            } else {
                local_acp::discover(provider.id).ok().flatten()
            }?;
            let probe = engine.probe().await.ok()?;
            if probe.needs_auth || probe.models.is_empty() || !engine.safe_to_run().await.unwrap_or(false) {
                return None;
            }
            let models = probe
                .models
                .into_iter()
                .map(|model| InstalledModel { provider: provider.id.to_owned(), id: model.id, label: model.label })
                .collect();
            Some(LocalGroup { engine: provider.label, models })
        });
    let (direct, acp) =
        futures_util::join!(futures_util::future::join_all(direct), futures_util::future::join_all(acp));
    direct.into_iter().chain(acp).flatten().collect()
}

/// The models starred on this computer for one server account. Model names can be private, so
/// each account keeps its own file.
pub(super) struct Favorites {
    path: Option<PathBuf>,
    pub starred: HashSet<String>,
}

impl Favorites {
    pub fn load(server: &str, account: &str) -> Self {
        let path = LocalCli::config_dir().map(|dir| {
            let mut scope = Sha256::new();
            for value in [server, account] {
                scope.update((value.len() as u64).to_be_bytes());
                scope.update(value);
            }
            dir.join("favorite-models").join(format!("{:x}.json", scope.finalize()))
        });
        let starred = path
            .as_ref()
            .and_then(|path| std::fs::read(path).ok())
            .and_then(|bytes| serde_json::from_slice::<Vec<String>>(&bytes).ok())
            .map(|keys| keys.into_iter().collect())
            .unwrap_or_default();
        Self { path, starred }
    }

    pub fn toggle(&mut self, key: &str) -> Result<(), &'static str> {
        if !self.starred.remove(key) {
            self.starred.insert(key.to_owned());
        }
        let Some(path) = &self.path else { return Ok(()) };
        let problem = "Couldn't save favorite models.";
        std::fs::create_dir_all(path.parent().ok_or(problem)?).map_err(|_| problem)?;
        let mut keys: Vec<&String> = self.starred.iter().collect();
        keys.sort();
        std::fs::write(path, serde_json::to_vec(&keys).map_err(|_| problem)?).map_err(|_| problem)
    }
}
