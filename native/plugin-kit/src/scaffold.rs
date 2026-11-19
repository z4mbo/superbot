use std::{
    fs::{self, File},
    io::{self, Write},
    path::{Path, PathBuf},
};

use anyhow::{bail, Context, Result};
use clap::ValueEnum;

use crate::manifest::{check_slug, Manifest};

#[derive(Clone, Copy, ValueEnum)]
pub enum Template {
    Skill,
    McpApp,
}

pub fn write(
    manifest_path: &Path,
    slug: &str,
    name: Option<String>,
    template: Template,
) -> Result<Vec<PathBuf>> {
    check_slug(slug)?;
    let manifest = match template {
        Template::Skill => Manifest::starter_skill(name.unwrap_or_else(|| slug.replace('-', " "))),
        Template::McpApp => Manifest::starter_mcp_app(name)?,
    };
    let manifest_bytes = manifest.to_validated_bytes()?;
    let mut files = vec![(manifest_path.to_owned(), manifest_bytes.as_slice())];
    if matches!(template, Template::McpApp) {
        files.extend([
            (
                manifest_path.with_file_name("server.ts"),
                include_bytes!("../../../examples/plugins/marketplace-unit-converter/server.ts")
                    .as_slice(),
            ),
            (
                manifest_path.with_file_name("README.md"),
                include_bytes!("mcp-app-readme.md").as_slice(),
            ),
        ]);
    }

    for (index, (path, _)) in files.iter().enumerate() {
        if files[..index].iter().any(|(other, _)| other == path) {
            bail!("Multiple template files would use {}", path.display());
        }
        match fs::symlink_metadata(path) {
            Ok(_) => bail!("{} already exists", path.display()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(error).with_context(|| format!("Checking {}", path.display()))
            }
        }
    }
    let mut created = Vec::new();
    for (path, bytes) in files {
        let result = (|| {
            let mut file = File::create_new(&path)?;
            created.push(path.clone());
            file.write_all(bytes)
        })();
        if let Err(error) = result {
            let mut error =
                anyhow::Error::new(error).context(format!("Creating {}", path.display()));
            for path in created.iter().rev() {
                if let Err(cleanup) = fs::remove_file(path) {
                    error =
                        error.context(format!("Could not remove {}: {cleanup}", path.display()));
                }
            }
            return Err(error);
        }
    }
    Ok(created)
}
