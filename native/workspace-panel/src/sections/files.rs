use std::path::PathBuf;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use gpui_kit::prelude::*;
use gpui_kit::{div, Div, PathPromptOptions, SharedString, Window};
use superbot_features::{
    ArtifactContent, ArtifactListItem, ArtifactQuery, ArtifactVersion, ThreadTarget, UploadArtifact,
};

use crate::format::{date_time, file_size, mime_for, relative};
use crate::icons::{icon, Glyph};
use crate::panel::{placeholder, section_header, Loaded, WorkspacePanel};
use crate::theme::{tokens, Tokens};
use crate::ui::{self, Action, Row, Tone};

/// The conversation a new upload is added to.
#[derive(Clone, PartialEq, Eq)]
enum Destination {
    Bot(String),
    Group(String),
}

impl Destination {
    fn target(&self) -> ThreadTarget<'_> {
        match self {
            Self::Bot(id) => ThreadTarget::Bot(id),
            Self::Group(id) => ThreadTarget::Group(id),
        }
    }
}

struct Versions {
    family_id: String,
    list: Loaded<Vec<ArtifactVersion>>,
}

// Uploads travel as base64 in one request body, so the whole file is held in
// memory; the server enforces its own, smaller attachment limit.
const LARGEST_READ: u64 = 100 * 1024 * 1024;
const PAGE: u32 = 40;

pub(crate) struct FilesView {
    page: Loaded<Vec<ArtifactListItem>>,
    next_cursor: Option<String>,
    loading_more: bool,
    made_by_bots: bool,
    upload_open: bool,
    destination: Option<Destination>,
    uploading: Option<SharedString>,
    problem: Option<SharedString>,
    versions: Option<Versions>,
    downloading: Option<String>,
    confirm_remove: Option<String>,
    removing: Option<String>,
}

impl FilesView {
    pub(crate) fn new() -> Self {
        Self {
            page: Loaded::default(),
            next_cursor: None,
            loading_more: false,
            made_by_bots: false,
            upload_open: false,
            destination: None,
            uploading: None,
            problem: None,
            versions: None,
            downloading: None,
            confirm_remove: None,
            removing: None,
        }
    }

    pub(crate) fn reset(&mut self) {
        *self = Self::new();
    }
}

fn downloads_dir() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(|home| PathBuf::from(home).join("Downloads"))
        .filter(|downloads| downloads.is_dir())
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_default())
}

impl WorkspacePanel {
    pub(crate) fn load_files(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.files.page.loading {
            return;
        }
        self.files.page.begin();
        let made_by_bots = self.files.made_by_bots;
        let remote = self.remote.clone();
        self.request(
            window,
            cx,
            async move {
                let query = ArtifactQuery {
                    made_by_bots: made_by_bots.then_some(true),
                    limit: Some(PAGE),
                    ..Default::default()
                };
                remote.space().list_artifacts(&query).await
            },
            move |panel, page, _, _| {
                if panel.files.made_by_bots != made_by_bots {
                    panel.files.page.loading = false;
                    return;
                }
                panel.files.page.finish(page.map(|page| {
                    panel.files.next_cursor = page.next_cursor;
                    page.items
                }));
            },
        );
    }

    fn load_more_files(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(cursor) = self.files.next_cursor.clone() else {
            return;
        };
        if self.files.loading_more {
            return;
        }
        self.files.loading_more = true;
        let made_by_bots = self.files.made_by_bots;
        let remote = self.remote.clone();
        self.request(
            window,
            cx,
            async move {
                let query = ArtifactQuery {
                    made_by_bots: made_by_bots.then_some(true),
                    cursor: Some(&cursor),
                    limit: Some(PAGE),
                    ..Default::default()
                };
                remote.space().list_artifacts(&query).await
            },
            move |panel, page, _, _| {
                panel.files.loading_more = false;
                if panel.files.made_by_bots != made_by_bots {
                    return;
                }
                match page {
                    Ok(page) => {
                        panel.files.next_cursor = page.next_cursor;
                        if let Some(items) = &mut panel.files.page.value {
                            items.extend(page.items);
                        }
                    }
                    Err(failure) => {
                        panel.files.problem = Some(failure.sentence("load more files").into());
                    }
                }
            },
        );
    }

    fn set_files_filter(
        &mut self,
        made_by_bots: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.files.made_by_bots == made_by_bots {
            return;
        }
        self.files.made_by_bots = made_by_bots;
        self.files.page = Loaded::default();
        self.files.next_cursor = None;
        self.files.versions = None;
        self.load_files(window, cx);
        cx.notify();
    }

    fn choose_upload(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(destination) = self.files.destination.clone() else {
            return;
        };
        let chosen = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: Some("Upload".into()),
        });
        cx.spawn_in(window, async move |panel, cx| {
            let Ok(Ok(Some(paths))) = chosen.await else {
                return;
            };
            let Some(path) = paths.into_iter().next() else {
                return;
            };
            panel
                .update_in(cx, |panel, window, cx| {
                    panel.upload(path, destination, window, cx)
                })
                .ok();
        })
        .detach();
    }

    fn upload(
        &mut self,
        path: PathBuf,
        destination: Destination,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "file".into());
        self.files.uploading = Some(name.clone().into());
        self.files.problem = None;
        // One nonce per chosen file, so a repeated request cannot store it twice.
        let nonce = uuid::Uuid::new_v4().to_string();
        let remote = self.remote.clone();
        self.request(
            window,
            cx,
            async move {
                let bytes = match tokio::fs::metadata(&path).await {
                    Ok(metadata) if metadata.len() > LARGEST_READ => {
                        return Ok(Err("That file is too large to upload from here."));
                    }
                    Ok(metadata) if metadata.len() == 0 => return Ok(Err("That file is empty.")),
                    Ok(_) => match tokio::fs::read(&path).await {
                        Ok(bytes) => bytes,
                        Err(_) => return Ok(Err("Couldn't read that file.")),
                    },
                    Err(_) => return Ok(Err("Couldn't read that file.")),
                };
                let content = BASE64.encode(bytes);
                let fields = UploadArtifact {
                    name: &name,
                    mime_type: mime_for(&name),
                    content_base64: &content,
                    description: None,
                    client_nonce: Some(&nonce),
                };
                remote
                    .space()
                    .upload_artifact(destination.target(), &fields)
                    .await
                    .map(Ok)
            },
            |panel, uploaded, window, cx| {
                panel.files.uploading = None;
                match uploaded {
                    Ok(Ok(file)) => {
                        panel.files.upload_open = false;
                        panel.toast(format!("Uploaded {}.", file.name), None, cx);
                        panel.files.page.loading = false;
                        panel.load_files(window, cx);
                    }
                    Ok(Err(unreadable)) => panel.files.problem = Some(unreadable.into()),
                    Err(failure) => {
                        panel.files.problem = Some(failure.sentence("upload that file").into());
                    }
                }
            },
        );
        cx.notify();
    }

    fn download(&mut self, file: &ArtifactListItem, window: &mut Window, cx: &mut Context<Self>) {
        if self.files.downloading.is_some() {
            return;
        }
        let family_id = file.artifact.id.clone();
        let has_versions = file.version_count > 1;
        self.files.downloading = Some(family_id.clone());
        self.files.problem = None;
        let remote = self.remote.clone();
        self.request(
            window,
            cx,
            async move {
                // A listed file's id names the first version; the newest one is read by its own id.
                let newest = if has_versions {
                    remote
                        .space()
                        .artifact_versions(&family_id)
                        .await?
                        .into_iter()
                        .max_by_key(|version| version.version)
                        .map(|version| version.id)
                } else {
                    None
                };
                let id = newest.unwrap_or(family_id);
                remote.space().artifact_by_id(&id).await
            },
            |panel, content, window, cx| match content {
                Ok(content) => panel.save_download(content, window, cx),
                Err(failure) => {
                    panel.files.downloading = None;
                    panel.files.problem = Some(failure.sentence("download that file").into());
                }
            },
        );
        cx.notify();
    }

    fn download_version(
        &mut self,
        version_id: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.files.downloading.is_some() {
            return;
        }
        self.files.downloading = Some(version_id.clone());
        self.files.problem = None;
        let remote = self.remote.clone();
        self.request(
            window,
            cx,
            async move { remote.space().artifact_by_id(&version_id).await },
            |panel, content, window, cx| match content {
                Ok(content) => panel.save_download(content, window, cx),
                Err(failure) => {
                    panel.files.downloading = None;
                    panel.files.problem = Some(failure.sentence("download that version").into());
                }
            },
        );
        cx.notify();
    }

    fn save_download(
        &mut self,
        content: ArtifactContent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Ok(bytes) = BASE64.decode(content.content_base64.as_bytes()) else {
            self.files.downloading = None;
            self.files.problem =
                Some("The server sent that file in a form this app can't read.".into());
            return;
        };
        let name = content.artifact.name;
        let destination = cx.prompt_for_new_path(&downloads_dir(), Some(&name));
        cx.spawn_in(window, async move |panel, cx| {
            let path = match destination.await {
                Ok(Ok(Some(path))) => path,
                _ => {
                    panel
                        .update(cx, |panel, cx| {
                            panel.files.downloading = None;
                            cx.notify();
                        })
                        .ok();
                    return;
                }
            };
            let written = cx
                .background_executor()
                .spawn(async move { std::fs::write(&path, bytes) })
                .await;
            panel
                .update(cx, |panel, cx| {
                    panel.files.downloading = None;
                    match written {
                        Ok(()) => panel.toast(format!("Saved {name}."), None, cx),
                        Err(_) => {
                            panel.files.problem =
                                Some(format!("Couldn't save {name} there.").into());
                        }
                    }
                    cx.notify();
                })
                .ok();
        })
        .detach();
    }

    fn toggle_versions(&mut self, family_id: String, window: &mut Window, cx: &mut Context<Self>) {
        if self
            .files
            .versions
            .as_ref()
            .is_some_and(|open| open.family_id == family_id)
        {
            self.files.versions = None;
            cx.notify();
            return;
        }
        let mut list = Loaded::default();
        list.begin();
        self.files.versions = Some(Versions {
            family_id: family_id.clone(),
            list,
        });
        let remote = self.remote.clone();
        let asked = family_id.clone();
        self.request(
            window,
            cx,
            async move { remote.space().artifact_versions(&asked).await },
            move |panel, versions, _, _| {
                if let Some(open) = &mut panel.files.versions {
                    if open.family_id == family_id {
                        open.list.finish(versions.map(|mut versions| {
                            versions.sort_by(|a, b| b.version.cmp(&a.version));
                            versions
                        }));
                    }
                }
            },
        );
        cx.notify();
    }

    fn remove_file(&mut self, file_id: String, window: &mut Window, cx: &mut Context<Self>) {
        self.files.confirm_remove = None;
        self.files.removing = Some(file_id.clone());
        self.files.problem = None;
        let remote = self.remote.clone();
        let removed_id = file_id.clone();
        self.request(
            window,
            cx,
            async move { remote.space().remove_artifact(&file_id).await },
            move |panel, removed, _, cx| {
                panel.files.removing = None;
                match removed {
                    Ok(()) => {
                        if let Some(items) = &mut panel.files.page.value {
                            items.retain(|item| item.artifact.id != removed_id);
                        }
                        panel.toast("File removed.", None, cx);
                    }
                    Err(failure) => {
                        panel.files.problem = Some(failure.sentence("remove that file").into());
                    }
                }
            },
        );
        cx.notify();
    }

    pub(crate) fn render_files(&mut self, _: &mut Window, cx: &mut Context<Self>) -> Div {
        let t = tokens(cx);
        let view = &self.files;
        let header = section_header(
            "Files",
            [Action::new("upload-file", "Upload file")
                .tone(Tone::Primary)
                .glyph(Glyph::Upload)
                .on_click(cx.listener(|panel, _, _, cx| {
                    panel.files.upload_open = !panel.files.upload_open;
                    panel.files.problem = None;
                    cx.notify();
                }))],
            &t,
        );
        let filters =
            div()
                .flex()
                .gap_1()
                .pb_3()
                .child(
                    Action::new("files-all", "All")
                        .small()
                        .selected(!view.made_by_bots)
                        .on_click(cx.listener(|panel, _, window, cx| {
                            panel.set_files_filter(false, window, cx)
                        })),
                )
                .child(
                    Action::new("files-by-bots", "Made by bots")
                        .small()
                        .selected(view.made_by_bots)
                        .on_click(cx.listener(|panel, _, window, cx| {
                            panel.set_files_filter(true, window, cx)
                        })),
                );
        let retry = Action::new("retry-files", "Try again")
            .on_click(cx.listener(|panel, _, window, cx| panel.load_files(window, cx)));
        let list = match placeholder(&view.page, "load the files", retry, &t) {
            Some(placeholder) => placeholder,
            None => {
                let items = view.page.value.as_deref().unwrap_or_default();
                if items.is_empty() {
                    ui::notice(
                        if view.made_by_bots {
                            "Bots haven't made any files in this space yet."
                        } else {
                            "No files in this space yet."
                        },
                        None,
                        &t,
                    )
                } else {
                    div()
                        .flex()
                        .flex_col()
                        .children(items.iter().map(|file| self.render_file(file, &t, cx)))
                }
            }
        };
        let more = view.next_cursor.is_some().then(|| {
            div().flex().pt_3().child(
                Action::new("more-files", "Show more")
                    .busy(view.loading_more)
                    .on_click(
                        cx.listener(|panel, _, window, cx| panel.load_more_files(window, cx)),
                    ),
            )
        });

        div()
            .flex()
            .flex_col()
            .child(header)
            .when(view.upload_open, |this| {
                this.child(div().pb_4().child(self.render_upload(&t, cx)))
            })
            .when_some(view.problem.clone(), |this, problem| {
                this.child(div().pb_3().child(ui::problem_line(problem, &t)))
            })
            .child(filters)
            .child(list)
            .children(more)
    }

    fn render_upload(&self, t: &Tokens, cx: &mut Context<Self>) -> Div {
        let view = &self.files;
        let bots = self.bots.value.as_deref().unwrap_or_default();
        let groups = self.groups.value.as_deref().unwrap_or_default();
        if bots.is_empty() && groups.is_empty() {
            return ui::card(t).child(ui::body(
                "Files belong to a bot's or a group's conversation. Create a bot first.",
                t.ink_secondary,
            ));
        }
        let choice = |destination: Destination, name: &str, cx: &mut Context<Self>| {
            let key = match &destination {
                Destination::Bot(id) => format!("upload-to-bot-{id}"),
                Destination::Group(id) => format!("upload-to-group-{id}"),
            };
            Action::new(SharedString::from(key), name.to_owned())
                .small()
                .selected(view.destination.as_ref() == Some(&destination))
                .on_click(cx.listener(move |panel, _, _, cx| {
                    panel.files.destination = Some(destination.clone());
                    cx.notify();
                }))
        };
        let destinations = bots
            .iter()
            .map(|bot| (Destination::Bot(bot.id.clone()), bot.name.as_str()))
            .chain(
                groups
                    .iter()
                    .map(|group| (Destination::Group(group.id.clone()), group.name.as_str())),
            );
        let mut choices = Vec::new();
        for (destination, name) in destinations {
            choices.push(choice(destination, name, cx));
        }
        ui::card(t)
            .child(ui::group_label("Add the file to", t))
            .child(div().flex().flex_wrap().gap_1().children(choices))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_3()
                    .child(
                        Action::new("choose-file", "Choose file…")
                            .glyph(Glyph::File)
                            .disabled(view.destination.is_none())
                            .busy(view.uploading.is_some())
                            .on_click(
                                cx.listener(|panel, _, window, cx| panel.choose_upload(window, cx)),
                            ),
                    )
                    .when_some(view.uploading.clone(), |this, name| {
                        this.child(ui::meta(format!("Uploading {name}…"), t))
                    }),
            )
    }

    fn render_file(&self, file: &ArtifactListItem, t: &Tokens, cx: &mut Context<Self>) -> Div {
        let view = &self.files;
        let artifact = &file.artifact;
        let owner = artifact
            .bot_id
            .as_deref()
            .and_then(|id| self.bot_name(id))
            .or_else(|| {
                artifact
                    .group_id
                    .as_deref()
                    .and_then(|id| self.group_name(id))
            });
        let mut detail = vec![file_size(artifact.size)];
        detail.extend(owner.map(|owner| owner.to_string()));
        detail.push(relative(&artifact.created_at));
        let row = Row::new(
            SharedString::from(format!("file-{}", artifact.id)),
            artifact.name.clone(),
        )
        .leading(
            div()
                .flex()
                .items_center()
                .justify_center()
                .size(gpui_kit::px(40.))
                .child(icon(Glyph::File, 16., t.ink_secondary)),
        )
        .detail(detail.join(" · "));

        let row = if view.confirm_remove.as_deref() == Some(artifact.id.as_str()) {
            let id = artifact.id.clone();
            row.trailing(
                Action::new("confirm-remove-file", "Remove for everyone")
                    .tone(Tone::Danger)
                    .small()
                    .on_click(cx.listener(move |panel, _, window, cx| {
                        panel.remove_file(id.clone(), window, cx)
                    })),
            )
            .trailing(
                Action::new("keep-file", "Keep")
                    .small()
                    .on_click(cx.listener(|panel, _, _, cx| {
                        panel.files.confirm_remove = None;
                        cx.notify();
                    })),
            )
        } else {
            let (versions_id, remove_id) = (artifact.id.clone(), artifact.id.clone());
            let downloading = file.clone();
            row.when(file.version_count > 1, |row| {
                row.trailing(
                    Action::new(
                        SharedString::from(format!("versions-{}", artifact.id)),
                        format!("{} versions", file.version_count),
                    )
                    .tone(Tone::Quiet)
                    .small()
                    .on_click(cx.listener(move |panel, _, window, cx| {
                        panel.toggle_versions(versions_id.clone(), window, cx)
                    })),
                )
            })
            .trailing(
                Action::icon(
                    SharedString::from(format!("download-{}", artifact.id)),
                    Glyph::Download,
                    format!("Download {}", artifact.name),
                )
                .small()
                .busy(view.downloading.as_deref() == Some(artifact.id.as_str()))
                .disabled(view.downloading.is_some())
                .on_click(
                    cx.listener(move |panel, _, window, cx| {
                        panel.download(&downloading, window, cx)
                    }),
                ),
            )
            .trailing(
                Action::icon(
                    SharedString::from(format!("remove-file-{}", artifact.id)),
                    Glyph::Trash,
                    format!("Remove {}", artifact.name),
                )
                .small()
                .busy(view.removing.as_deref() == Some(artifact.id.as_str()))
                .on_click(cx.listener(move |panel, _, _, cx| {
                    panel.files.confirm_remove = Some(remove_id.clone());
                    cx.notify();
                })),
            )
        };

        let versions = view
            .versions
            .as_ref()
            .filter(|open| open.family_id == artifact.id)
            .map(|open| {
                let inner = match (&open.list.value, &open.list.failure) {
                    (Some(versions), _) => {
                        div()
                            .flex()
                            .flex_col()
                            .children(versions.iter().map(|version| {
                                let id = version.id.clone();
                                div()
                                    .flex()
                                    .items_center()
                                    .gap_3()
                                    .min_h(gpui_kit::px(32.))
                                    .child(ui::mono(
                                        format!("v{}", version.version),
                                        t.ink_secondary,
                                        cx,
                                    ))
                                    .child(
                                        div()
                                            .flex_1()
                                            .min_w_0()
                                            .child(ui::meta(date_time(&version.created_at), t)),
                                    )
                                    .child(
                                        Action::icon(
                                            SharedString::from(format!(
                                                "download-version-{}",
                                                version.id
                                            )),
                                            Glyph::Download,
                                            format!("Download version {}", version.version),
                                        )
                                        .small()
                                        .busy(
                                            view.downloading.as_deref()
                                                == Some(version.id.as_str()),
                                        )
                                        .disabled(view.downloading.is_some())
                                        .on_click(
                                            cx.listener(move |panel, _, window, cx| {
                                                panel.download_version(id.clone(), window, cx)
                                            }),
                                        ),
                                    )
                            }))
                    }
                    (None, Some(failure)) => {
                        ui::notice(failure.sentence("load this file's versions"), None, t)
                    }
                    (None, None) => ui::loading_line(t),
                };
                div().pl(gpui_kit::px(58.)).pr_2().pb_2().child(inner)
            });

        div().flex().flex_col().child(row).children(versions)
    }
}
