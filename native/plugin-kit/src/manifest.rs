use std::{fs, path::Path};

use anyhow::{anyhow, ensure, Context, Result};
use serde::Serialize;
use superbot_features::plugin_manifest::{
    bounded, is_plugin_slug, read_manifest, ManifestError, PluginManifest, PluginPart,
};

#[derive(Serialize)]
#[serde(transparent)]
pub struct Manifest(PluginManifest);

fn located(error: ManifestError) -> anyhow::Error {
    if error.path.is_empty() {
        anyhow!(error.message)
    } else {
        anyhow!("{}: {}", error.path, error.message)
    }
}

pub fn read(path: &Path) -> Result<Manifest> {
    let parse = || -> Result<Manifest> {
        let manifest = read_manifest(&fs::read(path)?).map_err(located)?;
        Ok(Manifest(manifest.normalized().map_err(located)?))
    };
    parse().with_context(|| format!("Reading registry manifest {}", path.display()))
}

impl Manifest {
    pub fn starter_skill(name: String) -> Self {
        Self(PluginManifest {
            schema_version: 1,
            name,
            description: "Summarize the main points in the supplied text.".into(),
            parts: vec![PluginPart::Skill {
                id: "summary".into(),
                instructions: "Summarize the supplied text in three bullet points.".into(),
            }],
        })
    }

    pub fn starter_mcp_app(name: Option<String>) -> Result<Self> {
        let mut manifest = read_manifest(include_bytes!(
            "../../../examples/plugins/marketplace-unit-converter/manifest.json"
        ))
        .map_err(located)?;
        if let Some(name) = name {
            manifest.name = name;
        }
        Ok(Self(manifest))
    }

    pub fn to_validated_bytes(self) -> Result<Vec<u8>> {
        Ok(self.0.normalized().map_err(located)?.to_file_bytes())
    }
}

pub fn check_slug(value: &str) -> Result<()> {
    ensure!(
        is_plugin_slug(value),
        "Use 1 to 64 lowercase ASCII letters or digits separated by single hyphens"
    );
    Ok(())
}

pub fn trim_text(value: &mut String, field: &str, max: usize) -> Result<()> {
    *value = bounded(value, max).map_err(|_| {
        anyhow!("{field} must contain 1 to {max} UTF-16 code units after trimming")
    })?;
    Ok(())
}
