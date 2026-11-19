use std::collections::HashSet;
use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use url::Url;

/// The `schemaVersion` every registry manifest carries.
pub const MANIFEST_SCHEMA_VERSION: u32 = 1;
pub const MAX_PLUGIN_NAME: usize = 120;
pub const MAX_PLUGIN_DESCRIPTION: usize = 1000;
pub const MAX_PLUGIN_PARTS: usize = 16;
pub const MAX_SKILL_INSTRUCTIONS: usize = 16000;
pub const MAX_ENDPOINT: usize = 2048;
pub const MAX_SLUG: usize = 64;
/// The largest `plugin.json` a client reads; the registry limits keep a real
/// manifest far below it.
pub const MAX_MANIFEST_BYTES: usize = 2 * 1024 * 1024;

/// A registry plugin manifest: the `plugin.json` that `superbot-plugin init`
/// writes and `pluginRegistry/submit` takes. A value from [`read_manifest`]
/// has the right shape; [`PluginManifest::normalized`] checks the registry's
/// limits and returns the copy the registry stores.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    pub schema_version: u32,
    pub name: String,
    pub description: String,
    pub parts: Vec<PluginPart>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum PluginPart {
    Skill {
        id: String,
        instructions: String,
    },
    Mcp {
        id: String,
        transport: McpTransport,
        endpoint: String,
    },
}

/// The only transport a registry MCP part may use.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum McpTransport {
    #[default]
    #[serde(rename = "streamable_http")]
    StreamableHttp,
}

impl PluginPart {
    pub fn id(&self) -> &str {
        match self {
            Self::Skill { id, .. } | Self::Mcp { id, .. } => id,
        }
    }
}

/// Why a manifest cannot be read or submitted.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ManifestError {
    /// Where in the manifest, like `parts[1].endpoint`; empty for the whole file.
    pub path: String,
    pub message: String,
    /// The file holds something no plugin can carry, so it cannot be edited as one.
    pub unsupported: bool,
}

impl fmt::Display for ManifestError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ManifestError {}

fn invalid(path: impl Into<String>, message: impl Into<String>) -> ManifestError {
    ManifestError {
        path: path.into(),
        message: message.into(),
        unsupported: false,
    }
}

fn unsupported(path: impl Into<String>, message: impl Into<String>) -> ManifestError {
    ManifestError {
        path: path.into(),
        message: message.into(),
        unsupported: true,
    }
}

/// Field names that would hand a plugin secrets or let it run something.
const CARRIES_SECRETS_OR_COMMANDS: [&str; 16] = [
    "apikey",
    "args",
    "auth",
    "authorization",
    "command",
    "commands",
    "credentials",
    "env",
    "headers",
    "hooks",
    "package",
    "packages",
    "password",
    "script",
    "secrets",
    "token",
];

fn extra_field(path: &str, key: &str) -> ManifestError {
    let field = if path.is_empty() {
        key.to_owned()
    } else {
        format!("{path}.{key}")
    };
    if CARRIES_SECRETS_OR_COMMANDS.contains(&key.to_ascii_lowercase().as_str()) {
        unsupported(
            field,
            format!("Superbot plugins can't carry secrets or commands. Remove “{key}”."),
        )
    } else {
        unsupported(
            field,
            format!("Superbot plugins have no “{key}” field. Remove it."),
        )
    }
}

fn object<'a>(
    value: &'a Value,
    path: &str,
    what: &str,
    allowed: &[&str],
) -> Result<&'a Map<String, Value>, ManifestError> {
    let object = value
        .as_object()
        .ok_or_else(|| unsupported(path, format!("{what} must be a JSON object.")))?;
    if let Some(key) = object.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(extra_field(path, key));
    }
    Ok(object)
}

fn text(object: &Map<String, Value>, path: &str, key: &str) -> Result<String, ManifestError> {
    let at = || {
        if path.is_empty() {
            key.to_owned()
        } else {
            format!("{path}.{key}")
        }
    };
    match object.get(key) {
        Some(Value::String(value)) => Ok(value.clone()),
        Some(_) => Err(unsupported(at(), format!("“{key}” must be text."))),
        None => Err(unsupported(at(), format!("“{key}” is missing."))),
    }
}

/// Reads a `plugin.json`. Anything a plugin cannot carry (another schema
/// version, an unknown field or part kind, another transport) is refused;
/// values outside the registry's limits are kept for [`PluginManifest::normalized`].
pub fn read_manifest(bytes: &[u8]) -> Result<PluginManifest, ManifestError> {
    if bytes.len() > MAX_MANIFEST_BYTES {
        return Err(unsupported(
            "",
            "This file is too large to be a plugin manifest.",
        ));
    }
    let value: Value = serde_json::from_slice(bytes)
        .map_err(|error| unsupported("", format!("This file isn't valid JSON ({error}).")))?;
    let root = object(
        &value,
        "",
        "The manifest",
        &["schemaVersion", "name", "description", "parts"],
    )?;
    let schema = root
        .get("schemaVersion")
        .ok_or_else(|| unsupported("schemaVersion", "“schemaVersion” is missing."))?;
    if schema.as_f64() != Some(f64::from(MANIFEST_SCHEMA_VERSION)) {
        return Err(unsupported(
            "schemaVersion",
            format!("This file uses schemaVersion {schema}. Superbot reads schemaVersion 1."),
        ));
    }
    let parts = match root.get("parts") {
        Some(Value::Array(parts)) => parts,
        Some(_) => return Err(unsupported("parts", "“parts” must be a list.")),
        None => return Err(unsupported("parts", "“parts” is missing.")),
    };
    if parts.len() > MAX_PLUGIN_PARTS * 4 {
        return Err(unsupported(
            "parts",
            "This file has far more parts than a plugin can have.",
        ));
    }
    let parts = parts
        .iter()
        .enumerate()
        .map(|(index, part)| read_part(part, index))
        .collect::<Result<_, _>>()?;
    Ok(PluginManifest {
        schema_version: MANIFEST_SCHEMA_VERSION,
        name: text(root, "", "name")?,
        description: text(root, "", "description")?,
        parts,
    })
}

fn read_part(value: &Value, index: usize) -> Result<PluginPart, ManifestError> {
    let path = format!("parts[{index}]");
    let place = index + 1;
    let kind = value.get("kind").and_then(Value::as_str).ok_or_else(|| {
        unsupported(
            &path,
            format!("Part {place} needs a “kind” of skill or mcp."),
        )
    })?;
    match kind {
        "skill" => {
            let part = object(value, &path, "A part", &["kind", "id", "instructions"])?;
            Ok(PluginPart::Skill {
                id: text(part, &path, "id")?,
                instructions: text(part, &path, "instructions")?,
            })
        }
        "mcp" => {
            let part = object(
                value,
                &path,
                "A part",
                &["kind", "id", "transport", "endpoint"],
            )?;
            let transport = text(part, &path, "transport")?;
            if transport != "streamable_http" {
                return Err(unsupported(
                    format!("{path}.transport"),
                    format!("Part {place} uses the “{transport}” transport. Plugins connect over streamable_http."),
                ));
            }
            Ok(PluginPart::Mcp {
                id: text(part, &path, "id")?,
                transport: McpTransport::StreamableHttp,
                endpoint: text(part, &path, "endpoint")?,
            })
        }
        other => Err(unsupported(
            format!("{path}.kind"),
            format!("Part {place} is a “{other}”. Plugins have skills and mcp connectors."),
        )),
    }
}

impl PluginManifest {
    /// The manifest the registry would store, or the first thing to fix:
    /// text trimmed as the registry trims it and endpoints normalized as it
    /// parses them, every limit checked.
    pub fn normalized(&self) -> Result<PluginManifest, ManifestError> {
        let name = bounded(&self.name, MAX_PLUGIN_NAME).map_err(|empty| {
            invalid(
                "name",
                if empty {
                    "Give the plugin a name.".to_owned()
                } else {
                    format!("The name can be at most {MAX_PLUGIN_NAME} characters.")
                },
            )
        })?;
        let description = bounded(&self.description, MAX_PLUGIN_DESCRIPTION).map_err(|empty| {
            invalid(
                "description",
                if empty {
                    "Say what the plugin does.".to_owned()
                } else {
                    "The description can be at most 1,000 characters.".to_owned()
                },
            )
        })?;
        if self.parts.is_empty() {
            return Err(invalid("parts", "Add at least one skill or connector."));
        }
        if self.parts.len() > MAX_PLUGIN_PARTS {
            return Err(invalid("parts", "A plugin can have 16 parts."));
        }
        let mut ids = HashSet::new();
        let mut parts = Vec::with_capacity(self.parts.len());
        for (index, part) in self.parts.iter().enumerate() {
            let path = format!("parts[{index}]");
            let place = index + 1;
            let id = part.id();
            if !is_plugin_slug(id) {
                return Err(invalid(
                    format!("{path}.id"),
                    format!("Part {place} needs an identifier in lowercase letters, digits and single hyphens."),
                ));
            }
            if !ids.insert(id) {
                return Err(invalid(
                    format!("{path}.id"),
                    format!("Two parts are called {id}. Give each its own identifier."),
                ));
            }
            parts.push(match part {
                PluginPart::Skill { instructions, .. } => PluginPart::Skill {
                    id: id.to_owned(),
                    instructions: bounded(instructions, MAX_SKILL_INSTRUCTIONS).map_err(|empty| {
                        invalid(
                            format!("{path}.instructions"),
                            if empty {
                                format!("Part {place} needs instructions.")
                            } else {
                                format!("Part {place}'s instructions can be at most 16,000 characters.")
                            },
                        )
                    })?,
                },
                PluginPart::Mcp { endpoint, .. } => PluginPart::Mcp {
                    id: id.to_owned(),
                    transport: McpTransport::StreamableHttp,
                    endpoint: registry_endpoint(endpoint).ok_or_else(|| {
                        invalid(
                            format!("{path}.endpoint"),
                            format!("Part {place}: use a public HTTPS address without keys, tokens or a ?query."),
                        )
                    })?,
                },
            });
        }
        Ok(PluginManifest {
            schema_version: MANIFEST_SCHEMA_VERSION,
            name,
            description,
            parts,
        })
    }

    /// The file's bytes: pretty JSON and a final newline, as the CLI writes it.
    pub fn to_file_bytes(&self) -> Vec<u8> {
        let mut bytes = serde_json::to_vec_pretty(self).expect("a manifest always serializes");
        bytes.push(b'\n');
        bytes
    }
}

/// Lowercase ASCII letters and digits in segments joined by single hyphens,
/// at most 64 characters: plugin slugs and part ids.
pub fn is_plugin_slug(value: &str) -> bool {
    value.len() <= MAX_SLUG
        && value.split('-').all(|segment| {
            !segment.is_empty()
                && segment
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        })
}

/// `value` trimmed and within `1..=max` UTF-16 code units; `Err(true)` when
/// nothing is left, `Err(false)` when it is too long.
pub fn bounded(value: &str, max: usize) -> Result<String, bool> {
    let trimmed = registry_trim(value);
    match trimmed.encode_utf16().count() {
        0 => Err(true),
        count if count > max => Err(false),
        _ => Ok(trimmed.to_owned()),
    }
}

/// The endpoint the registry stores, if it accepts this one.
pub fn registry_endpoint(endpoint: &str) -> Option<String> {
    // Zod 4.6.7 trims URLs and removes ASCII tabs and newlines before refinements.
    let normalized = registry_trim(endpoint).replace(['\t', '\n', '\r'], "");
    let url = Url::parse(&normalized).ok()?;
    let accepted = endpoint.encode_utf16().count() <= MAX_ENDPOINT
        && normalized.starts_with("https://")
        && !normalized.contains('?')
        && !normalized.ends_with('#')
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none_or(str::is_empty);
    accepted.then_some(normalized)
}

/// Trims as the registry does: Zod 4.6.7 uses JavaScript `String.prototype.trim`.
pub fn registry_trim(value: &str) -> &str {
    value.trim_matches(|ch| {
        matches!(ch, '\u{0009}'..='\u{000d}' | ' ' | '\u{00a0}' | '\u{1680}'
            | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
            | '\u{205f}' | '\u{3000}' | '\u{feff}')
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const MCP_APP: &str =
        include_str!("../../../examples/plugins/marketplace-unit-converter/manifest.json");

    fn skill() -> Value {
        json!({
            "schemaVersion": 1,
            "name": "Release notes",
            "description": "Summarize the main points in the supplied text.",
            "parts": [{ "kind": "skill", "id": "summary", "instructions": "Summarize the supplied text in three bullet points." }],
        })
    }

    fn app() -> Value {
        serde_json::from_str(MCP_APP).unwrap()
    }

    fn read(value: &Value) -> Result<PluginManifest, ManifestError> {
        read_manifest(value.to_string().as_bytes())
    }

    #[test]
    fn both_cli_templates_round_trip_byte_for_byte() {
        let skill = read(&skill()).unwrap().normalized().unwrap();
        let written = skill.to_file_bytes();
        assert_eq!(read_manifest(&written).unwrap(), skill);

        let app = read_manifest(MCP_APP.as_bytes())
            .unwrap()
            .normalized()
            .unwrap();
        assert_eq!(
            app.parts[0],
            PluginPart::Mcp {
                id: "temperatures".into(),
                transport: McpTransport::StreamableHttp,
                endpoint: "https://units.example.com/mcp".into(),
            }
        );
        let again = read_manifest(&app.to_file_bytes())
            .unwrap()
            .normalized()
            .unwrap();
        assert_eq!(again.to_file_bytes(), app.to_file_bytes());
        assert!(String::from_utf8(app.to_file_bytes())
            .unwrap()
            .contains("\"transport\": \"streamable_http\""));
    }

    #[test]
    fn what_a_plugin_cannot_carry_is_refused_by_name() {
        let mut headers = app();
        headers["parts"][0]["headers"] = json!({ "Authorization": "x" });
        let error = read(&headers).unwrap_err();
        assert!(error.unsupported);
        assert_eq!(error.path, "parts[0].headers");
        assert!(error
            .message
            .contains("can't carry secrets or commands. Remove “headers”"));

        let mut slug = skill();
        slug["slug"] = json!("release-notes");
        assert!(read(&slug).unwrap_err().message.contains("no “slug” field"));

        for (pointer, value) in [
            ("/schemaVersion", json!(2)),
            ("/parts/0/kind", json!("hook")),
            ("/parts", json!({})),
            ("/name", json!(7)),
        ] {
            let mut wrong = skill();
            *wrong.pointer_mut(pointer).unwrap() = value;
            assert!(read(&wrong).unwrap_err().unsupported, "{pointer}");
        }
        let mut stdio = app();
        stdio["parts"][0]["transport"] = json!("stdio");
        assert!(read(&stdio).unwrap_err().unsupported);
        assert!(read_manifest(b"{ not json").unwrap_err().unsupported);
    }

    #[test]
    fn values_outside_the_limits_are_kept_until_normalized() {
        let mut long = skill();
        long["name"] = json!("😀".repeat(61));
        let kept = read(&long).unwrap();
        assert_eq!(kept.name, "😀".repeat(61));
        let error = kept.normalized().unwrap_err();
        assert!(!error.unsupported);
        assert_eq!(error.path, "name");

        for (pointer, value, path) in [
            ("/description", json!(" "), "description"),
            ("/parts/0/id", json!("double--hyphen"), "parts[0].id"),
            (
                "/parts/0/instructions",
                json!("x".repeat(16001)),
                "parts[0].instructions",
            ),
        ] {
            let mut wrong = skill();
            *wrong.pointer_mut(pointer).unwrap() = value;
            assert_eq!(read(&wrong).unwrap().normalized().unwrap_err().path, path);
        }
        for endpoint in [
            "http://units.example.com/mcp",
            "https://units.example.com/mcp?",
            "https://units.example.com/mcp#",
            "https://user:pass@units.example.com/mcp",
        ] {
            let mut wrong = app();
            wrong["parts"][0]["endpoint"] = json!(endpoint);
            let error = read(&wrong).unwrap().normalized().unwrap_err();
            assert_eq!(error.path, "parts[0].endpoint", "{endpoint}");
        }
        let mut twice = app();
        twice["parts"][1]["id"] = json!("temperatures");
        assert!(read(&twice)
            .unwrap()
            .normalized()
            .unwrap_err()
            .message
            .contains("Two parts"));
    }

    #[test]
    fn text_is_trimmed_and_endpoints_normalized_as_the_registry_does() {
        let manifest = read(&json!({
            "schemaVersion": 1.0, "name": "\u{feff}Release notes ", "description": "Draft notes.",
            "parts": [
                { "kind": "skill", "id": "notes", "instructions": " Summarize the issues. " },
                { "kind": "mcp", "id": "tracker", "transport": "streamable_http", "endpoint": " https://plugin.example.test/mc\np " },
            ]
        }))
        .unwrap()
        .normalized()
        .unwrap();
        assert_eq!(manifest.name, "Release notes");
        assert_eq!(
            manifest.parts[0],
            PluginPart::Skill {
                id: "notes".into(),
                instructions: "Summarize the issues.".into()
            }
        );
        assert_eq!(
            manifest.parts[1],
            PluginPart::Mcp {
                id: "tracker".into(),
                transport: McpTransport::StreamableHttp,
                endpoint: "https://plugin.example.test/mcp".into()
            }
        );
    }
}
