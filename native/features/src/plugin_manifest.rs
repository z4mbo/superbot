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
pub const MAX_APP_FIELDS: usize = 16;
pub const MAX_APP_FIELD_LABEL: usize = 120;
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
    /// A form people fill in to keep records, which the registry stores per
    /// installation. Uninstalling the plugin deletes those records.
    App {
        id: String,
        fields: Vec<AppField>,
        /// A number field the app totals across the records it shows.
        #[serde(
            rename = "summaryField",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        summary_field: Option<String>,
    },
}

/// One input of an app part's form.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AppField {
    pub id: String,
    pub label: String,
    #[serde(rename = "type")]
    pub kind: AppFieldKind,
    pub required: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AppFieldKind {
    Text,
    Number,
    Date,
}

impl AppFieldKind {
    pub const ALL: [Self; 3] = [Self::Text, Self::Number, Self::Date];

    fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|kind| kind.as_str() == value)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Number => "number",
            Self::Date => "date",
        }
    }
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
            Self::Skill { id, .. } | Self::Mcp { id, .. } | Self::App { id, .. } => id,
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
            format!("Part {place} needs a “kind” of skill, mcp or app."),
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
        "app" => {
            let part = object(
                value,
                &path,
                "A part",
                &["kind", "id", "fields", "summaryField"],
            )?;
            let fields = match part.get("fields") {
                Some(Value::Array(fields)) => fields,
                Some(_) => {
                    return Err(unsupported(
                        format!("{path}.fields"),
                        "“fields” must be a list.",
                    ))
                }
                None => {
                    return Err(unsupported(
                        format!("{path}.fields"),
                        "“fields” is missing.",
                    ))
                }
            };
            if fields.len() > MAX_APP_FIELDS * 4 {
                return Err(unsupported(
                    format!("{path}.fields"),
                    format!("Part {place} has far more fields than an app can have."),
                ));
            }
            let summary_field = match part.get("summaryField") {
                None => None,
                Some(Value::String(field)) => Some(field.clone()),
                Some(_) => {
                    return Err(unsupported(
                        format!("{path}.summaryField"),
                        "“summaryField” must be text.",
                    ))
                }
            };
            Ok(PluginPart::App {
                id: text(part, &path, "id")?,
                fields: fields
                    .iter()
                    .enumerate()
                    .map(|(index, field)| read_field(field, &format!("{path}.fields[{index}]")))
                    .collect::<Result<_, _>>()?,
                summary_field,
            })
        }
        other => Err(unsupported(
            format!("{path}.kind"),
            format!("Part {place} is a “{other}”. Plugins have skills, mcp connectors and apps."),
        )),
    }
}

fn read_field(value: &Value, path: &str) -> Result<AppField, ManifestError> {
    let field = object(
        value,
        path,
        "An app field",
        &["id", "label", "type", "required"],
    )?;
    let kind = text(field, path, "type")?;
    let kind = AppFieldKind::parse(&kind).ok_or_else(|| {
        unsupported(
            format!("{path}.type"),
            format!("“{kind}” isn't a field type. Use text, number or date."),
        )
    })?;
    let required = match field.get("required") {
        Some(Value::Bool(required)) => *required,
        Some(_) => {
            return Err(unsupported(
                format!("{path}.required"),
                "“required” must be true or false.",
            ))
        }
        None => {
            return Err(unsupported(
                format!("{path}.required"),
                "“required” is missing.",
            ))
        }
    };
    Ok(AppField {
        id: text(field, path, "id")?,
        label: text(field, path, "label")?,
        kind,
        required,
    })
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
            return Err(invalid(
                "parts",
                "Add at least one skill, connector or app.",
            ));
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
                PluginPart::App {
                    fields,
                    summary_field,
                    ..
                } => normalized_app(id, fields, summary_field.as_deref(), &path, place)?,
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

fn normalized_app(
    id: &str,
    fields: &[AppField],
    summary_field: Option<&str>,
    path: &str,
    place: usize,
) -> Result<PluginPart, ManifestError> {
    if fields.is_empty() {
        return Err(invalid(
            format!("{path}.fields"),
            format!("Part {place} needs at least one field."),
        ));
    }
    if fields.len() > MAX_APP_FIELDS {
        return Err(invalid(
            format!("{path}.fields"),
            format!("Part {place} can have {MAX_APP_FIELDS} fields."),
        ));
    }
    let mut ids = HashSet::new();
    let mut normalized = Vec::with_capacity(fields.len());
    for (index, field) in fields.iter().enumerate() {
        let at = format!("{path}.fields[{index}]");
        let number = index + 1;
        if !is_plugin_slug(&field.id) {
            return Err(invalid(
                format!("{at}.id"),
                format!("Field {number} of part {place} needs an identifier in lowercase letters, digits and single hyphens."),
            ));
        }
        if !ids.insert(field.id.as_str()) {
            return Err(invalid(
                format!("{at}.id"),
                format!(
                    "Two fields of part {place} are called {}. Give each its own identifier.",
                    field.id
                ),
            ));
        }
        normalized.push(AppField {
            label: app_field_label(&field.label).map_err(|message| {
                invalid(
                    format!("{at}.label"),
                    format!("Field {number} of part {place}: {message}"),
                )
            })?,
            ..field.clone()
        });
    }
    if let Some(summary) = summary_field {
        if !fields
            .iter()
            .any(|field| field.id == summary && field.kind == AppFieldKind::Number)
        {
            return Err(invalid(
                format!("{path}.summaryField"),
                format!("Part {place} totals “{summary}”, which isn't one of its number fields."),
            ));
        }
    }
    Ok(PluginPart::App {
        id: id.to_owned(),
        fields: normalized,
        summary_field: summary_field.map(str::to_owned),
    })
}

/// The label the registry stores. Unlike names, the registry measures a
/// label's length before trimming it.
fn app_field_label(label: &str) -> Result<String, &'static str> {
    if label.encode_utf16().count() > MAX_APP_FIELD_LABEL {
        return Err("a label can be at most 120 characters.");
    }
    let trimmed = registry_trim(label);
    if trimmed.is_empty() {
        return Err("give it a label.");
    }
    if trimmed.chars().any(|ch| ch == '\0' || is_bidi_control(ch)) {
        return Err("remove the hidden control characters from its label.");
    }
    Ok(trimmed.to_owned())
}

/// The Unicode `Bidi_Control` property, which the registry refuses in labels.
fn is_bidi_control(ch: char) -> bool {
    matches!(
        ch,
        '\u{061c}' | '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}'
    )
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

    const KCAL_DIARY: &str = include_str!("../../../examples/plugins/kcal-diary/plugin.json");

    fn diary() -> Value {
        serde_json::from_str(KCAL_DIARY).unwrap()
    }

    #[test]
    fn the_record_app_example_round_trips_byte_for_byte() {
        let manifest = read_manifest(KCAL_DIARY.as_bytes())
            .unwrap()
            .normalized()
            .unwrap();
        assert_eq!(manifest.to_file_bytes(), KCAL_DIARY.as_bytes());
        let PluginPart::App {
            id,
            fields,
            summary_field,
        } = &manifest.parts[0]
        else {
            panic!("the example is an app");
        };
        assert_eq!(id, "meals");
        assert_eq!(summary_field.as_deref(), Some("kcal"));
        assert_eq!(
            fields
                .iter()
                .map(|field| (
                    field.id.as_str(),
                    field.label.as_str(),
                    field.kind,
                    field.required
                ))
                .collect::<Vec<_>>(),
            [
                ("date", "Date", AppFieldKind::Date, true),
                ("meal", "Meal", AppFieldKind::Text, true),
                ("kcal", "Calories (kcal)", AppFieldKind::Number, true),
            ]
        );

        let mut untotalled = diary();
        untotalled["parts"][0]
            .as_object_mut()
            .unwrap()
            .remove("summaryField");
        let written = read(&untotalled)
            .unwrap()
            .normalized()
            .unwrap()
            .to_file_bytes();
        assert!(!String::from_utf8(written).unwrap().contains("summaryField"));
    }

    #[test]
    fn app_shapes_a_plugin_cannot_carry_are_refused() {
        for (pointer, value) in [
            ("/parts/0/fields", json!({})),
            ("/parts/0/fields/0/type", json!("boolean")),
            ("/parts/0/fields/0/required", json!("yes")),
            ("/parts/0/fields/0/label", json!(3)),
            ("/parts/0/summaryField", json!(null)),
            (
                "/parts/0/fields",
                json!(vec![diary()["parts"][0]["fields"][0].clone(); 65]),
            ),
        ] {
            let mut wrong = diary();
            *wrong.pointer_mut(pointer).unwrap() = value;
            assert!(read(&wrong).unwrap_err().unsupported, "{pointer}");
        }
        let mut extra = diary();
        extra["parts"][0]["fields"][0]["default"] = json!("today");
        assert_eq!(read(&extra).unwrap_err().path, "parts[0].fields[0].default");
        let mut missing = diary();
        missing["parts"][0]["fields"][1]
            .as_object_mut()
            .unwrap()
            .remove("required");
        assert!(read(&missing).unwrap_err().unsupported);
    }

    #[test]
    fn app_limits_match_the_registry() {
        let field =
            |id: String| json!({ "id": id, "label": "Value", "type": "number", "required": false });
        for (pointer, value, path) in [
            ("/parts/0/fields", json!([]), "parts[0].fields"),
            (
                "/parts/0/fields",
                json!((0..17).map(|n| field(format!("v{n}"))).collect::<Vec<_>>()),
                "parts[0].fields",
            ),
            (
                "/parts/0/fields/1/id",
                json!("date"),
                "parts[0].fields[1].id",
            ),
            (
                "/parts/0/fields/1/id",
                json!("Meal"),
                "parts[0].fields[1].id",
            ),
            (
                "/parts/0/fields/1/label",
                json!(" \u{3000} "),
                "parts[0].fields[1].label",
            ),
            (
                "/parts/0/fields/1/label",
                json!("x".repeat(121)),
                "parts[0].fields[1].label",
            ),
            (
                "/parts/0/fields/1/label",
                json!("Meal\u{202e}"),
                "parts[0].fields[1].label",
            ),
            (
                "/parts/0/fields/1/label",
                json!("Me\u{0}al"),
                "parts[0].fields[1].label",
            ),
            (
                "/parts/0/summaryField",
                json!("meal"),
                "parts[0].summaryField",
            ),
            (
                "/parts/0/summaryField",
                json!("calories"),
                "parts[0].summaryField",
            ),
        ] {
            let mut wrong = diary();
            *wrong.pointer_mut(pointer).unwrap() = value;
            let error = read(&wrong).unwrap().normalized().unwrap_err();
            assert!(!error.unsupported);
            assert_eq!(error.path, path, "{pointer}");
        }
        let mut sixteen = diary();
        sixteen["parts"][0]["fields"] =
            json!((0..16).map(|n| field(format!("v{n}"))).collect::<Vec<_>>());
        sixteen["parts"][0]["summaryField"] = json!("v15");
        assert!(read(&sixteen).unwrap().normalized().is_ok());

        let mut padded = diary();
        padded["parts"][0]["fields"][1]["label"] = json!(format!(" {} ", "x".repeat(118)));
        let normalized = read(&padded).unwrap().normalized().unwrap();
        let PluginPart::App { fields, .. } = &normalized.parts[0] else {
            unreachable!()
        };
        assert_eq!(fields[1].label, "x".repeat(118));
        padded["parts"][0]["fields"][1]["label"] = json!(format!(" {} ", "x".repeat(119)));
        assert!(
            read(&padded).unwrap().normalized().is_err(),
            "the registry measures labels before trimming"
        );
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
