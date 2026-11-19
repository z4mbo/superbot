use std::fs::{self, File};
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};

use gpui_kit::component::input::{InputState, Textarea, TextareaState};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use superbot_features::plugin_manifest::{
    is_plugin_slug, read_manifest, McpTransport, PluginManifest, PluginPart, MANIFEST_SCHEMA_VERSION,
    MAX_MANIFEST_BYTES, MAX_PLUGIN_PARTS,
};

use crate::api::{self, Manifest, PluginVersion};
use crate::app::Desktop;
use crate::theme::{radius, ActiveTheme, Theme};
use crate::ui::store::{back_button, Tab};
use crate::ui::{error_line, field, field_box, icon, pill_button, Tone, Type};

/// The name the CLI gives a manifest, offered when saving.
const MANIFEST_FILE: &str = "plugin.json";

pub enum PartBody {
    Instructions(Entity<TextareaState>),
    Endpoint(Entity<InputState>),
}

pub struct PartDraft {
    pub id: Entity<InputState>,
    pub body: PartBody,
}

/// What happened to the draft's file last, shown beside its path.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Filed {
    Opened,
    Saved,
}

/// A plugin being written: the manifest's fields as the person types them.
pub struct Draft {
    /// The slug of the published plugin this is a new version of, which cannot change.
    pub revises: Option<String>,
    pub slug: Entity<InputState>,
    pub version: Entity<InputState>,
    pub name: Entity<InputState>,
    pub description: Entity<TextareaState>,
    pub parts: Vec<PartDraft>,
    pub busy: bool,
    pub error: Option<String>,
    /// The `plugin.json` this draft was opened from or last saved to.
    file: Option<(PathBuf, Filed)>,
    /// The manifest as it was started, opened or saved, to tell unsaved edits apart.
    baseline: Vec<u8>,
    /// A file that read cleanly, waiting for the person to agree to lose their edits.
    replacing: Option<(PathBuf, PluginManifest)>,
    /// A file dialog or a read or write is under way.
    filing: bool,
}

impl Draft {
    pub fn new(revises: Option<&PluginVersion>, window: &mut Window, cx: &mut Context<Desktop>) -> Self {
        let line = |placeholder: &'static str, value: String, window: &mut Window, cx: &mut Context<Desktop>| {
            cx.new(|cx| InputState::new(window, cx).placeholder(placeholder).default_value(value))
        };
        let manifest = revises.map(|version| plugin_manifest(&version.manifest));
        let start = manifest.clone().unwrap_or_else(|| PluginManifest {
            schema_version: MANIFEST_SCHEMA_VERSION,
            name: String::new(),
            description: String::new(),
            parts: vec![PluginPart::Skill { id: String::new(), instructions: String::new() }],
        });
        Self {
            revises: revises.map(|version| version.slug.clone()),
            slug: line("release-notes", revises.map(|version| version.slug.clone()).unwrap_or_default(), window, cx),
            version: line("1", revises.map_or(1, |version| version.version + 1).to_string(), window, cx),
            name: line("Release notes", start.name.clone(), window, cx),
            description: cx.new(|cx| {
                TextareaState::new(window, cx)
                    .auto_grow(2, 6)
                    .placeholder("Draft release notes from issue summaries.")
                    .default_value(start.description.clone())
            }),
            parts: start.parts.iter().map(|part| PartDraft::from(part, window, cx)).collect(),
            busy: false,
            error: None,
            file: None,
            baseline: fingerprint(&start),
            replacing: None,
            filing: false,
        }
    }

    /// The manifest exactly as typed, whether or not it is ready to submit.
    fn typed(&self, cx: &App) -> PluginManifest {
        let line = |input: &Entity<InputState>| input.read(cx).value().to_string();
        PluginManifest {
            schema_version: MANIFEST_SCHEMA_VERSION,
            name: line(&self.name),
            description: self.description.read(cx).value().to_string(),
            parts: self
                .parts
                .iter()
                .map(|part| match &part.body {
                    PartBody::Instructions(body) => {
                        PluginPart::Skill { id: line(&part.id), instructions: body.read(cx).value().to_string() }
                    }
                    PartBody::Endpoint(body) => PluginPart::Mcp {
                        id: line(&part.id),
                        transport: McpTransport::StreamableHttp,
                        endpoint: line(body),
                    },
                })
                .collect(),
        }
    }

    fn unsaved(&self, cx: &App) -> bool {
        fingerprint(&self.typed(cx)) != self.baseline
    }

    /// The manifest as typed, or what to fix before it can be sent.
    fn manifest(&self, cx: &App) -> Result<(String, i64, Manifest), String> {
        let line = |input: &Entity<InputState>| input.read(cx).value().trim().to_owned();
        let slug = self.revises.clone().unwrap_or_else(|| line(&self.slug));
        if !is_plugin_slug(&slug) {
            return Err("The identifier uses lowercase letters, digits and single hyphens, like release-notes.".into());
        }
        let version: i64 = line(&self.version)
            .parse()
            .ok()
            .filter(|version| (1..=i64::from(i32::MAX)).contains(version))
            .ok_or("The version is a whole number, 1 or higher.")?;
        let manifest = self.typed(cx).normalized().map_err(|problem| problem.message)?;
        Ok((slug, version, wire_manifest(&manifest)))
    }

    /// Fills the form from a manifest. The identifier and version stay, since
    /// a `plugin.json` holds neither.
    fn fill(&mut self, path: PathBuf, manifest: &PluginManifest, window: &mut Window, cx: &mut Context<Desktop>) {
        let (name, description) = (manifest.name.clone(), manifest.description.clone());
        self.name.update(cx, |input, cx| input.set_value(name, window, cx));
        self.description.update(cx, |input, cx| input.set_value(description, window, cx));
        self.parts = manifest.parts.iter().map(|part| PartDraft::from(part, window, cx)).collect();
        self.baseline = fingerprint(manifest);
        self.file = Some((path, Filed::Opened));
        self.replacing = None;
        self.error =
            manifest.normalized().err().map(|problem| format!("Fix this before submitting: {}", problem.message));
    }
}

/// How a manifest compares for unsaved edits: as the registry would store
/// it when it can, else as typed.
fn fingerprint(manifest: &PluginManifest) -> Vec<u8> {
    manifest.normalized().unwrap_or_else(|_| manifest.clone()).to_file_bytes()
}

fn plugin_manifest(wire: &Manifest) -> PluginManifest {
    serde_json::from_value(serde_json::to_value(wire).expect("a manifest serializes"))
        .expect("the registry returns manifests of the shared shape")
}

fn wire_manifest(manifest: &PluginManifest) -> Manifest {
    serde_json::from_value(serde_json::to_value(manifest).expect("a manifest serializes"))
        .expect("the shared manifest has the registry's shape")
}

impl PartDraft {
    fn skill(id: &str, instructions: &str, window: &mut Window, cx: &mut Context<Desktop>) -> Self {
        let (id, instructions) = (id.to_owned(), instructions.to_owned());
        Self {
            id: cx.new(|cx| InputState::new(window, cx).placeholder("notes").default_value(id)),
            body: PartBody::Instructions(cx.new(|cx| {
                TextareaState::new(window, cx)
                    .auto_grow(3, 12)
                    .placeholder("Summarize the provided issue descriptions.")
                    .default_value(instructions)
            })),
        }
    }

    fn connector(id: &str, endpoint: &str, window: &mut Window, cx: &mut Context<Desktop>) -> Self {
        let (id, endpoint) = (id.to_owned(), endpoint.to_owned());
        Self {
            id: cx.new(|cx| InputState::new(window, cx).placeholder("tracker").default_value(id)),
            body: PartBody::Endpoint(cx.new(|cx| {
                InputState::new(window, cx).placeholder("https://tracker.example.com/mcp").default_value(endpoint)
            })),
        }
    }

    fn from(part: &PluginPart, window: &mut Window, cx: &mut Context<Desktop>) -> Self {
        match part {
            PluginPart::Skill { id, instructions } => Self::skill(id, instructions, window, cx),
            PluginPart::Mcp { id, endpoint, .. } => Self::connector(id, endpoint, window, cx),
        }
    }
}

/// Reads a `plugin.json`, or says why it cannot fill the form.
fn read_plugin_file(path: &Path) -> Result<PluginManifest, String> {
    let size = fs::metadata(path).map_err(|error| error.to_string())?.len();
    if size > MAX_MANIFEST_BYTES as u64 {
        return Err("This file is too large to be a plugin manifest.".into());
    }
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    read_manifest(&bytes).map_err(|problem| problem.message)
}

/// Writes `bytes` beside `path` and then moves them over it, so a failed
/// write never leaves a half-written manifest in its place.
fn write_whole(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let directory = path.parent().filter(|parent| !parent.as_os_str().is_empty()).unwrap_or(Path::new("."));
    let name = path.file_name().ok_or_else(|| io::Error::other("Choose a file name."))?;
    let nonce =
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_nanos());
    let temporary = directory.join(format!(".{}.{nonce}.tmp", name.to_string_lossy()));
    let written = (|| {
        let mut file = File::create_new(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)
    })();
    if written.is_err() && temporary.exists() {
        if let Err(cleanup) = fs::remove_file(&temporary) {
            return Err(io::Error::other(format!(
                "{} Also couldn't remove {}: {cleanup}",
                written.unwrap_err(),
                temporary.display()
            )));
        }
    }
    written
}

fn file_label(path: &Path) -> String {
    path.file_name().map_or_else(|| path.display().to_string(), |name| name.to_string_lossy().into_owned())
}

/// Where the save dialog starts: beside the draft's file, else the person's documents.
fn save_folder(file: Option<&Path>) -> PathBuf {
    file.and_then(Path::parent)
        .map(Path::to_owned)
        .or_else(|| std::env::var_os("USERPROFILE").map(|home| PathBuf::from(home).join("Documents")))
        .filter(|folder| folder.is_dir())
        .unwrap_or_default()
}

impl Desktop {
    fn draft_ready_for_files(&mut self) -> Option<&mut Draft> {
        self.store.draft.as_mut().filter(|draft| !draft.busy && !draft.filing)
    }

    fn open_plugin_file(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(draft) = self.draft_ready_for_files() else { return };
        draft.filing = true;
        draft.replacing = None;
        let picked = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: Some("Open".into()),
        });
        cx.spawn_in(window, async move |this, cx| {
            let path = picked.await.ok().and_then(Result::ok).flatten().and_then(|paths| paths.into_iter().next());
            let read = match &path {
                Some(path) => {
                    let path = path.clone();
                    Some(cx.background_executor().spawn(async move { read_plugin_file(&path) }).await)
                }
                None => None,
            };
            this.update_in(cx, |this, window, cx| {
                let Some(draft) = this.store.draft.as_mut() else { return };
                draft.filing = false;
                match (path, read) {
                    (Some(path), Some(Ok(manifest))) => {
                        if draft.unsaved(cx) {
                            draft.error = None;
                            draft.replacing = Some((path, manifest));
                        } else {
                            draft.fill(path, &manifest, window, cx);
                        }
                    }
                    (Some(path), Some(Err(problem))) => {
                        draft.error = Some(format!("{} wasn't opened. {problem}", file_label(&path)));
                    }
                    _ => {}
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    fn replace_from_file(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(draft) = self.store.draft.as_mut() else { return };
        if let Some((path, manifest)) = draft.replacing.take() {
            draft.fill(path, &manifest, window, cx);
            cx.notify();
        }
    }

    fn save_plugin_file(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(draft) = self.draft_ready_for_files() else { return };
        draft.filing = true;
        draft.replacing = None;
        let typed = draft.typed(cx);
        let folder = save_folder(draft.file.as_ref().map(|(path, _)| path.as_path()));
        let suggested = draft.file.as_ref().map_or_else(|| MANIFEST_FILE.to_owned(), |(path, _)| file_label(path));
        // The system dialog asks before replacing a file that exists.
        let picked = cx.prompt_for_new_path(&folder, Some(&suggested));
        cx.spawn_in(window, async move |this, cx| {
            let path = picked.await.ok().and_then(Result::ok).flatten();
            let ready = typed.normalized();
            let bytes = ready.as_ref().map_or_else(|_| typed.to_file_bytes(), PluginManifest::to_file_bytes);
            let written = match &path {
                Some(path) => {
                    let path = path.clone();
                    Some(cx.background_executor().spawn(async move { write_whole(&path, &bytes) }).await)
                }
                None => None,
            };
            this.update_in(cx, |this, _, cx| {
                let Some(draft) = this.store.draft.as_mut() else { return };
                draft.filing = false;
                match (path, written) {
                    (Some(path), Some(Ok(()))) => {
                        draft.baseline = fingerprint(&typed);
                        draft.file = Some((path, Filed::Saved));
                        draft.error = ready.err().map(|problem| {
                            format!("Saved as a draft. Fix this before submitting: {}", problem.message)
                        });
                    }
                    (Some(path), Some(Err(error))) => {
                        draft.error = Some(format!("{} wasn't saved. {error}", file_label(&path)));
                    }
                    _ => {}
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    fn submit_draft(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(api), Some(space_id)) = (self.api.clone(), self.space_id()) else { return };
        let Some(draft) = self.store.draft.as_mut().filter(|draft| !draft.busy && !draft.filing) else { return };
        let (slug, version, manifest) = match draft.manifest(cx) {
            Ok(ready) => ready,
            Err(problem) => {
                draft.error = Some(problem);
                cx.notify();
                return;
            }
        };
        draft.busy = true;
        draft.error = None;
        draft.replacing = None;
        let work = async move {
            api.submit_plugin(&space_id, &slug, version, &manifest).await?;
            api.my_plugins(&space_id).await
        };
        self.call(window, cx, work, |this, result, window, cx| match result {
            Ok(mine) => {
                this.store.mine = mine;
                this.store.draft = None;
                this.store.tab = Tab::Yours;
                this.notify("Sent for review. It appears in Discover once it is approved.", false, None, cx);
                this.load_store(window, cx);
            }
            Err(error) => {
                if let Some(draft) = this.store.draft.as_mut() {
                    draft.busy = false;
                    draft.error = Some(api::explain(&error));
                }
            }
        });
        cx.notify();
    }

    fn render_file_line(&self, draft: &Draft, theme: &Theme, cx: &mut Context<Self>) -> Option<Div> {
        if let Some((path, _)) = &draft.replacing {
            return Some(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap_2()
                    .child(
                        div().body().text_color(theme.ink_secondary).child(format!(
                            "Replace this form with {}? Your edits here aren't saved.",
                            file_label(path)
                        )),
                    )
                    .child(
                        pill_button("replace-from-file", "Replace", Tone::Primary, true, theme)
                            .on_click(cx.listener(|this, _, window, cx| this.replace_from_file(window, cx))),
                    )
                    .child(pill_button("keep-editing", "Keep editing", Tone::Quiet, true, theme).on_click(
                        cx.listener(|this, _, _, cx| {
                            if let Some(draft) = this.store.draft.as_mut() {
                                draft.replacing = None;
                                cx.notify();
                            }
                        }),
                    )),
            );
        }
        let (path, filed) = draft.file.as_ref()?;
        let state = match (filed, draft.unsaved(cx)) {
            (_, true) => "Edited",
            (Filed::Opened, false) => "Opened",
            (Filed::Saved, false) => "Saved",
        };
        Some(
            div()
                .flex()
                .items_center()
                .gap_1p5()
                .meta()
                .text_color(theme.ink_tertiary)
                .child(icon("file-braces", px(12.), theme.ink_tertiary))
                .child(div().min_w_0().truncate().child(path.display().to_string()))
                .child(div().flex_shrink_0().child(format!("· {state}"))),
        )
    }

    pub fn render_creator(&mut self, _: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.skin().clone();
        let Some(draft) = self.store.draft.as_ref() else { return div().into_any_element() };
        let revising = draft.revises.is_some();
        let room = draft.parts.len() < MAX_PLUGIN_PARTS;
        let only_part = draft.parts.len() == 1;
        let idle = !draft.busy && !draft.filing;
        let file_line = self.render_file_line(draft, &theme, cx);

        let parts = draft.parts.iter().enumerate().map(|(index, part)| {
            let (kind, glyph, body_label) = match part.body {
                PartBody::Instructions(_) => ("Skill", "sparkles", "Instructions"),
                PartBody::Endpoint(_) => ("Connector", "plug", "Server address"),
            };
            div()
                .flex()
                .flex_col()
                .gap_3()
                .p_3()
                .rounded(radius::CARD)
                .border_1()
                .border_color(theme.hairline.opacity(0.5))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap_2()
                        .child(icon(glyph, px(14.), theme.ink_secondary))
                        .child(div().name().flex_1().child(kind))
                        .when(!only_part, |row| {
                            row.child(remove_button(index, &theme).on_click(cx.listener(move |this, _, _, cx| {
                                if let Some(draft) = this.store.draft.as_mut() {
                                    draft.parts.remove(index);
                                    cx.notify();
                                }
                            })))
                        }),
                )
                .child(field("Identifier", &part.id, &theme))
                .child(match &part.body {
                    PartBody::Instructions(body) => labelled(body_label, &theme)
                        .child(text_box(&theme).child(Textarea::new(body).appearance(false).bordered(false))),
                    PartBody::Endpoint(body) => field(body_label, body, &theme),
                })
        });

        div()
            .id("creator")
            .size_full()
            .overflow_y_scroll()
            .pb_8()
            .flex()
            .flex_col()
            .gap_5()
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap_2()
                            .child(back_button(&theme).on_click(cx.listener(|this, _, _, cx| {
                                this.store.draft = None;
                                cx.notify();
                            })))
                            .child(div().title().flex_1().min_w_0().truncate().child(if revising {
                                "New version"
                            } else {
                                "Create plugin"
                            }))
                            .child(
                                pill_button("open-plugin-file", "Open file…", Tone::Quiet, idle, &theme)
                                    .on_click(cx.listener(|this, _, window, cx| this.open_plugin_file(window, cx))),
                            )
                            .child(
                                pill_button("save-plugin-file", "Save file…", Tone::Quiet, idle, &theme)
                                    .on_click(cx.listener(|this, _, window, cx| this.save_plugin_file(window, cx))),
                            )
                            .child(
                                pill_button(
                                    "submit-plugin",
                                    if draft.busy { "Sending…" } else { "Submit for review" },
                                    Tone::Primary,
                                    idle,
                                    &theme,
                                )
                                .on_click(cx.listener(|this, _, window, cx| this.submit_draft(window, cx))),
                            ),
                    )
                    .children(file_line),
            )
            .children(draft.error.clone().map(|error| error_line(error, &theme)))
            .child(
                div()
                    .flex()
                    .gap_3()
                    .child(field("Name", &draft.name, &theme).flex_1())
                    .child(match &draft.revises {
                        // A new version belongs to the plugin it revises, so its identifier is shown, not edited.
                        Some(slug) => labelled("Identifier", &theme)
                            .flex_1()
                            .child(field_box(&theme).px_4().item().text_color(theme.ink_secondary).child(slug.clone())),
                        None => field("Identifier", &draft.slug, &theme).flex_1(),
                    })
                    .child(field("Version", &draft.version, &theme).w(px(96.))),
            )
            .child(
                labelled("Description", &theme)
                    .child(text_box(&theme).child(Textarea::new(&draft.description).appearance(false).bordered(false))),
            )
            .child(div().flex().flex_col().gap_3().child(div().section().child("What it adds")).children(parts).when(
                room,
                |section| {
                    section.child(
                        div()
                            .flex()
                            .gap_2()
                            .child(pill_button("add-skill", "Add skill", Tone::Quiet, true, &theme).on_click(
                                cx.listener(|this, _, window, cx| {
                                    let part = PartDraft::skill("", "", window, cx);
                                    if let Some(draft) = this.store.draft.as_mut() {
                                        draft.parts.push(part);
                                        cx.notify();
                                    }
                                }),
                            ))
                            .child(pill_button("add-connector", "Add connector", Tone::Quiet, true, &theme).on_click(
                                cx.listener(|this, _, window, cx| {
                                    let part = PartDraft::connector("", "", window, cx);
                                    if let Some(draft) = this.store.draft.as_mut() {
                                        draft.parts.push(part);
                                        cx.notify();
                                    }
                                }),
                            )),
                    )
                },
            ))
            .into_any_element()
    }
}

fn labelled(label: &'static str, theme: &Theme) -> Div {
    div()
        .flex()
        .flex_col()
        .gap_1p5()
        .child(div().meta().font_weight(FontWeight::MEDIUM).text_color(theme.ink_tertiary).child(label))
}

fn text_box(theme: &Theme) -> Div {
    field_box(theme).items_start().py_1()
}

fn remove_button(index: usize, theme: &Theme) -> Stateful<Div> {
    let hover = theme.raised;
    div()
        .id(("remove-part", index))
        .size_6()
        .rounded_full()
        .flex()
        .items_center()
        .justify_center()
        .cursor_pointer()
        .hover(move |style| style.bg(hover))
        .child(icon("x", px(14.), theme.ink_tertiary))
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use superbot_features::plugin_manifest::{read_manifest, PluginManifest};

    use super::{fingerprint, plugin_manifest, read_plugin_file, wire_manifest, write_whole, MANIFEST_FILE};

    const MCP_APP: &[u8] = include_bytes!("../../../../examples/plugins/marketplace-unit-converter/manifest.json");

    fn scratch(name: &str) -> PathBuf {
        let folder = std::env::temp_dir().join(format!("superbot-creator-{name}-{}", std::process::id()));
        fs::create_dir_all(&folder).unwrap();
        folder
    }

    #[test]
    fn a_saved_manifest_replaces_the_file_whole_and_leaves_nothing_beside_it() {
        let folder = scratch("save");
        let path = folder.join(MANIFEST_FILE);
        fs::write(&path, b"previous").unwrap();
        let manifest = read_manifest(MCP_APP).unwrap().normalized().unwrap();
        write_whole(&path, &manifest.to_file_bytes()).unwrap();
        assert_eq!(read_plugin_file(&path).unwrap(), manifest);
        assert_eq!(fs::read_dir(&folder).unwrap().count(), 1);
        fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn a_file_the_form_cannot_hold_is_refused_with_its_reason() {
        let folder = scratch("open");
        let path = folder.join(MANIFEST_FILE);
        let mut value: serde_json::Value = serde_json::from_slice(MCP_APP).unwrap();
        value["parts"][0]["headers"] = serde_json::json!({ "Authorization": "x" });
        fs::write(&path, value.to_string()).unwrap();
        let problem = read_plugin_file(&path).unwrap_err();
        assert!(problem.contains("Remove “headers”"), "{problem}");
        fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn registry_manifests_cross_into_the_shared_shape_unchanged() {
        let shared = read_manifest(MCP_APP).unwrap();
        assert_eq!(plugin_manifest(&wire_manifest(&shared)), shared);
        let edited = fingerprint(&PluginManifest { name: " Unit converter ".into(), ..shared.clone() });
        assert_eq!(edited, fingerprint(&shared), "spacing the registry trims is not an edit");
    }
}
