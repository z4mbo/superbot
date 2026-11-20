use std::collections::HashSet;
use std::path::PathBuf;

use superbot_features::{computer_file_path, ComputerFile, ComputerFileKind, ControlHolder};

use super::*;
use crate::control::ControlLease;
use crate::files;

/// The most rows one folder draws; a folder with more says how many it leaves out.
const MOST_ROWS: usize = 300;
/// The most characters a preview draws. The server already refuses files over 2 MB.
const MOST_PREVIEW_CHARS: usize = 100_000;

/// The folders and files on the agent's computer, read through the server's file routes.
pub(super) struct ComputerFiles {
    folder: String,
    trail: Vec<String>,
    live: bool,
    listing: Listing,
    preview: Option<Preview>,
    selected: Option<String>,
    fetching: HashSet<String>,
    uploading: bool,
    problem: Option<String>,
    listing_serial: u64,
    preview_serial: u64,
}

enum Listing {
    Loading,
    Ready(Vec<ComputerFile>),
    Failed(String),
}

struct Preview {
    file: ComputerFile,
    text: Option<Result<String, String>>,
}

/// What the person may do to add a file, given who holds the computer now.
#[derive(Clone, PartialEq, Eq, Debug)]
pub(super) enum Upload {
    /// This account holds control, so the upload goes straight through.
    Held,
    /// Nobody is using the computer: control is taken for the upload and handed straight back.
    Borrow,
    Blocked(String),
}

/// Whether the agent's computer has files this panel can browse.
pub(super) fn browsable(status: &ComputerStatus, uses_computer: bool) -> bool {
    uses_computer && status.offered() && !status.runs_on_user_machine
}

pub(super) fn upload_access(status: &ComputerStatus) -> Option<Upload> {
    if status.state != ComputerState::Running {
        return None;
    }
    Some(if status.control_lease_id.is_some() {
        Upload::Held
    } else if status.controlled_by_other {
        Upload::Blocked("Someone else has control right now".into())
    } else if let Some(user) = &status.busy_bot_name {
        Upload::Blocked(format!("{user} is using it right now"))
    } else if status.control_holder == ControlHolder::Bot {
        Upload::Blocked("An agent is using it right now".into())
    } else {
        Upload::Borrow
    })
}

/// Folders first, then files, each by name as a person reads it.
pub(super) fn ordered(mut entries: Vec<ComputerFile>) -> Vec<ComputerFile> {
    entries.retain(|entry| !entry.name().is_empty());
    entries.sort_by_cached_key(|entry| (entry.kind != ComputerFileKind::Dir, entry.name().to_lowercase()));
    entries
}

fn folder_name(folder: &str) -> &str {
    folder.trim_end_matches('/').rsplit('/').next().filter(|name| !name.is_empty()).unwrap_or("Files")
}

fn preview_problem(error: &Error) -> String {
    match error {
        Error::Server { status: 400, .. } => "This file has no preview.".into(),
        Error::Server { status: 404, code, .. } if code.as_deref() == Some("NOT_FOUND") => {
            "This file is gone. Go back to see what is there now.".into()
        }
        error => api::explain(error),
    }
}

fn blocked_sentence(reason: &str) -> String {
    format!("{reason}. Try again once it's free.")
}

fn upload_problem(error: &Error) -> String {
    match error {
        Error::Server { status: 403, .. } => "Take control of its computer to add files.".into(),
        Error::Server { status: 400, message, .. } if message.contains("computer must be running") => {
            "Start its computer to add files.".into()
        }
        error => api::explain(error),
    }
}

impl ComputerFiles {
    fn new(live: bool) -> Self {
        Self {
            folder: String::new(),
            trail: Vec::new(),
            live,
            listing: Listing::Loading,
            preview: None,
            selected: None,
            fetching: HashSet::new(),
            uploading: false,
            problem: None,
            listing_serial: 0,
            preview_serial: 0,
        }
    }

    /// Escape inside the browser: closes an open preview.
    pub(super) fn back(&mut self) -> bool {
        self.preview.take().is_some()
    }
}

impl Desktop {
    fn computer_files_mut(&mut self, agent_id: &str) -> Option<&mut ComputerFiles> {
        let panel = self.agent_panel.as_mut().filter(|panel| panel.agent_id == agent_id)?;
        panel.files.as_mut()
    }

    /// Keeps the browser in step with the computer's status: shown when there are files to
    /// browse, and read again when the computer starts or stops, since the files then come from
    /// another place. Files are read only while the browser is on screen, since reading them
    /// keeps a running computer awake.
    pub(super) fn sync_computer_files(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.sync_computer_providers(window, cx);
        let Some(panel) = self.agent_panel.as_ref() else { return };
        let status = match &panel.computer {
            Some(ComputerView::Ready(status)) => status,
            _ => return,
        };
        let on = self.agent_info.bot(&panel.agent_id).is_some_and(uses_computer);
        if !browsable(status, on) {
            if let Some(panel) = self.agent_panel.as_mut() {
                panel.files = None;
            }
            return;
        }
        let shown = match &panel.page {
            Some(page) => matches!(page, knowledge::Page::Folder),
            None => panel.tab == PanelTab::Computer,
        };
        if !shown {
            return;
        }
        let live = status.state == ComputerState::Running;
        let (folder, trail) = match &panel.files {
            Some(files) if files.live == live => return,
            Some(files) => (files.folder.clone(), files.trail.clone()),
            None => (String::new(), Vec::new()),
        };
        if let Some(panel) = self.agent_panel.as_mut() {
            panel.files.get_or_insert_with(|| ComputerFiles::new(live)).live = live;
        }
        self.open_computer_folder(folder, trail, window, cx);
    }

    fn open_computer_folder(
        &mut self,
        folder: String,
        trail: Vec<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (Some((features, space)), Some(panel)) = (self.features(), self.agent_panel.as_mut()) else { return };
        let Some(files) = panel.files.as_mut() else { return };
        let agent = panel.agent_id.clone();
        files.listing_serial += 1;
        files.folder = folder.clone();
        files.trail = trail;
        files.listing = Listing::Loading;
        files.preview = None;
        files.problem = None;
        let serial = files.listing_serial;
        let read = agent.clone();
        self.call(
            window,
            cx,
            async move { features.space(space).computer_files(&read, &folder).await },
            move |this, result, _, _| {
                let Some(files) = this.computer_files_mut(&agent).filter(|files| files.listing_serial == serial) else {
                    return;
                };
                files.listing = match result {
                    Ok(entries) => Listing::Ready(ordered(entries)),
                    Err(error) => Listing::Failed(api::explain(&error)),
                };
            },
        );
        cx.notify();
    }

    fn enter_computer_folder(&mut self, entry: &ComputerFile, window: &mut Window, cx: &mut Context<Self>) {
        let Some(files) = self.agent_panel.as_ref().and_then(|panel| panel.files.as_ref()) else { return };
        let mut trail = files.trail.clone();
        trail.push(files.folder.clone());
        self.open_computer_folder(entry.path.clone(), trail, window, cx);
    }

    fn leave_computer_folder(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(files) = self.agent_panel.as_ref().and_then(|panel| panel.files.as_ref()) else { return };
        let mut trail = files.trail.clone();
        let left = files.folder.clone();
        let Some(parent) = trail.pop() else { return };
        self.open_computer_folder(parent, trail, window, cx);
        if let Some(files) = self.agent_panel.as_mut().and_then(|panel| panel.files.as_mut()) {
            files.selected = Some(left);
        }
    }

    fn reload_computer_folder(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(files) = self.agent_panel.as_ref().and_then(|panel| panel.files.as_ref()) else { return };
        self.open_computer_folder(files.folder.clone(), files.trail.clone(), window, cx);
    }

    fn preview_computer_file(&mut self, file: ComputerFile, window: &mut Window, cx: &mut Context<Self>) {
        let (Some((features, space)), Some(panel)) = (self.features(), self.agent_panel.as_mut()) else { return };
        let Some(files) = panel.files.as_mut() else { return };
        let agent = panel.agent_id.clone();
        files.preview_serial += 1;
        files.selected = Some(file.path.clone());
        files.problem = None;
        files.preview = Some(Preview { file: file.clone(), text: None });
        let serial = files.preview_serial;
        let (read, path) = (agent.clone(), file.path.clone());
        self.call(
            window,
            cx,
            async move { features.space(space).read_computer_file(&read, &path).await },
            move |this, result, _, _| {
                let Some(preview) = this
                    .computer_files_mut(&agent)
                    .filter(|files| files.preview_serial == serial)
                    .and_then(|files| files.preview.as_mut())
                else {
                    return;
                };
                preview.text = Some(result.map_err(|error| preview_problem(&error)));
            },
        );
        cx.notify();
    }

    fn close_computer_preview(&mut self, cx: &mut Context<Self>) {
        if let Some(files) = self.agent_panel.as_mut().and_then(|panel| panel.files.as_mut()) {
            files.preview_serial += 1;
            files.preview = None;
        }
        cx.notify();
    }

    /// Reads a file off the running computer and asks where to save it.
    fn download_computer_file(&mut self, file: ComputerFile, window: &mut Window, cx: &mut Context<Self>) {
        let (Some((features, space)), Some(panel)) = (self.features(), self.agent_panel.as_mut()) else { return };
        let Some(files) = panel.files.as_mut() else { return };
        if !files.fetching.insert(file.path.clone()) {
            return;
        }
        files.problem = None;
        let agent = panel.agent_id.clone();
        let (read, path) = (agent.clone(), file.path.clone());
        self.call(
            window,
            cx,
            async move { features.space(space).download_computer_file(&read, &path).await },
            move |this, result, window, cx| {
                let bytes = match result.map(|content| files::decode(&content)) {
                    Ok(Some(bytes)) => bytes,
                    Ok(None) => {
                        let problem = format!("{} couldn't be read. Try again.", file.name());
                        return this.computer_file_done(&agent, &file.path, Some(problem));
                    }
                    Err(error) => return this.computer_file_done(&agent, &file.path, Some(api::explain(&error))),
                };
                this.save_computer_file(agent, file, bytes, window, cx);
            },
        );
        cx.notify();
    }

    fn save_computer_file(
        &mut self,
        agent: String,
        file: ComputerFile,
        bytes: Vec<u8>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let name = files::safe_name(file.name());
        let chosen = cx.prompt_for_new_path(&files::downloads_dir(), Some(&name));
        cx.spawn_in(window, async move |this, cx| {
            let saved = match chosen.await {
                Ok(Ok(Some(path))) => {
                    Some(cx.background_executor().spawn(async move { std::fs::write(&path, bytes) }).await)
                }
                _ => None,
            };
            this.update(cx, |this, cx| {
                let problem = match saved {
                    Some(Err(_)) => Some(format!("{name} couldn't be saved there. Choose another place.")),
                    Some(Ok(())) => {
                        this.notify(format!("Saved {name}"), false, None, cx);
                        None
                    }
                    None => None,
                };
                this.computer_file_done(&agent, &file.path, problem);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn computer_file_done(&mut self, agent: &str, path: &str, problem: Option<String>) {
        let Some(files) = self.computer_files_mut(agent) else { return };
        files.fetching.remove(path);
        if problem.is_some() {
            files.problem = problem;
        }
    }

    /// Asks for files on this computer and writes them into the folder on screen.
    fn upload_to_computer(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(panel) = self.agent_panel.as_ref() else { return };
        let Some(Upload::Held | Upload::Borrow) = (match &panel.computer {
            Some(ComputerView::Ready(status)) => upload_access(status),
            _ => None,
        }) else {
            return;
        };
        if panel.files.as_ref().is_none_or(|files| files.uploading) {
            return;
        }
        let limit = self.max_upload_bytes();
        let chosen = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: true,
            prompt: Some("Upload".into()),
        });
        cx.spawn_in(window, async move |this, cx| {
            let Ok(Ok(Some(paths))) = chosen.await else { return };
            let read = cx.background_executor().spawn(async move { read_uploads(paths, limit) }).await;
            this.update_in(cx, |this, window, cx| this.send_uploads(read, window, cx)).ok();
        })
        .detach();
    }

    fn send_uploads(
        &mut self,
        read: Result<Vec<(String, String)>, String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(controls) = self.api.as_ref().map(|api| api.controls.clone()) else { return };
        let (Some((features, space)), Some(panel)) = (self.features(), self.agent_panel.as_mut()) else { return };
        let access = match &panel.computer {
            Some(ComputerView::Ready(status)) => upload_access(status),
            _ => None,
        };
        let Some(files) = panel.files.as_mut() else { return };
        let chosen = match read {
            Ok(chosen) if !chosen.is_empty() => chosen,
            Ok(_) => return,
            Err(problem) => {
                files.problem = Some(problem);
                cx.notify();
                return;
            }
        };
        let borrow = match access {
            Some(Upload::Held) => false,
            Some(Upload::Borrow) => true,
            _ => return,
        };
        files.uploading = true;
        files.problem = None;
        let agent = panel.agent_id.clone();
        let folder = files.folder.clone();
        let target = agent.clone();
        let work = async move {
            let owner = (features.clone(), space.clone());
            let space = features.space(space);
            let lease = match borrow {
                true => match upload_access(&space.computer_status(&target).await?) {
                    Some(Upload::Borrow) => Some(ControlLease::acquire(&controls, owner, target.clone()).await?),
                    Some(Upload::Held) => None,
                    Some(Upload::Blocked(reason)) => return Ok(Err(blocked_sentence(&reason))),
                    None => return Ok(Err("Start its computer to upload files.".to_owned())),
                },
                false => None,
            };
            for (name, content) in &chosen {
                space.upload_computer_file(&target, &computer_file_path(&folder, name), content).await?;
            }
            drop(lease);
            Ok(Ok(chosen.len()))
        };
        self.call(window, cx, work, move |this, result, window, cx| {
            let Some(files) = this.computer_files_mut(&agent) else { return };
            files.uploading = false;
            let count = match result {
                Ok(Ok(count)) => count,
                Ok(Err(problem)) => {
                    files.problem = Some(problem);
                    return;
                }
                Err(error) => {
                    files.problem = Some(upload_problem(&error));
                    return;
                }
            };
            let said = if count == 1 { "Uploaded 1 file".to_owned() } else { format!("Uploaded {count} files") };
            this.notify(said, false, None, cx);
            this.reload_computer_folder(window, cx);
        });
        cx.notify();
    }

    /// The Computer tab's file browser, below the computer's card. `None` while the computer has
    /// no files to browse.
    pub(super) fn render_computer_files(&self, bot: &Bot, theme: &Theme, cx: &mut Context<Self>) -> Option<AnyElement> {
        let panel = self.agent_panel.as_ref()?;
        let files = panel.files.as_ref()?;
        let status = match &panel.computer {
            Some(ComputerView::Ready(status)) if browsable(status, uses_computer(bot)) => status,
            _ => return None,
        };
        let upload = upload_access(status);
        let body = match &files.preview {
            Some(preview) => self.render_computer_preview(files, preview, theme, cx),
            None => self.render_computer_listing(files, upload, theme, cx),
        };
        Some(
            div()
                .flex()
                .flex_col()
                .mt(px(14.))
                .child(card(theme).child(body))
                .children(
                    files.problem.clone().map(|problem| div().mt_2().px(px(14.)).child(error_line(problem, theme))),
                )
                .children((!files.live).then(|| {
                    div()
                        .mt_2()
                        .px(px(14.))
                        .body()
                        .text_color(theme.ink_tertiary)
                        .child("Start its computer to download or upload files.")
                }))
                .into_any_element(),
        )
    }

    fn render_computer_listing(
        &self,
        files: &ComputerFiles,
        upload: Option<Upload>,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let at_top = files.trail.is_empty();
        let back = (!at_top).then(|| {
            small_button("computer-files-up", "arrow-left", "Back", true, theme)
                .on_click(cx.listener(|this, _, window, cx| this.leave_computer_folder(window, cx)))
        });
        let upload_button = upload.map(|access| {
            let (ready, tip) = match (&access, files.uploading) {
                (_, true) => (false, "Uploading…".to_owned()),
                (Upload::Blocked(reason), _) => (false, blocked_sentence(reason)),
                _ => (true, "Upload files here".to_owned()),
            };
            small_button("computer-files-upload", "upload", tip, ready, theme).when(ready, |button| {
                button.on_click(cx.listener(|this, _, window, cx| this.upload_to_computer(window, cx)))
            })
        });
        let toolbar = div()
            .flex()
            .items_center()
            .gap_1p5()
            .min_h(px(44.))
            .pl(px(if at_top { 14. } else { 8. }))
            .pr(px(8.))
            .border_b_1()
            .border_color(theme.ink_at(0.05))
            .children(back)
            .child(icon("folder-open", px(16.), theme.ink_secondary))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .name()
                    .text_color(theme.ink)
                    .truncate()
                    .child(folder_name(&files.folder).to_owned()),
            )
            .when(files.uploading, |bar| bar.child(Spinner::new().with_size(px(14.)).color(theme.ink_tertiary)))
            .children(upload_button);
        let rows = match &files.listing {
            Listing::Loading => div()
                .py(px(22.))
                .flex()
                .justify_center()
                .child(Spinner::new().with_size(px(16.)).color(theme.ink_tertiary))
                .into_any_element(),
            Listing::Failed(problem) => div()
                .p(px(14.))
                .flex()
                .flex_col()
                .items_start()
                .gap_3()
                .child(error_line(problem.clone(), theme))
                .child(
                    crate::ui::pill_button("computer-files-retry", "Try again", crate::ui::Tone::Quiet, true, theme)
                        .on_click(cx.listener(|this, _, window, cx| this.reload_computer_folder(window, cx))),
                )
                .into_any_element(),
            Listing::Ready(entries) if entries.is_empty() => div()
                .px(px(14.))
                .py(px(18.))
                .flex()
                .justify_center()
                .body()
                .text_color(theme.ink_tertiary)
                .child("This folder is empty")
                .into_any_element(),
            Listing::Ready(entries) => {
                let left_out = entries.len().saturating_sub(MOST_ROWS);
                div()
                    .flex()
                    .flex_col()
                    .children(
                        entries
                            .iter()
                            .take(MOST_ROWS)
                            .enumerate()
                            .map(|(index, entry)| self.render_computer_file_row(files, entry, index, theme, cx)),
                    )
                    .when(left_out > 0, |list| {
                        list.child(
                            div()
                                .px(px(14.))
                                .py(px(10.))
                                .border_t_1()
                                .border_color(theme.ink_at(0.05))
                                .meta()
                                .text_color(theme.ink_tertiary)
                                .child(format!("{left_out} more not shown")),
                        )
                    })
                    .into_any_element()
            }
        };
        div().flex().flex_col().child(toolbar).child(rows).into_any_element()
    }

    fn render_computer_file_row(
        &self,
        files: &ComputerFiles,
        entry: &ComputerFile,
        index: usize,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let folder = entry.kind == ComputerFileKind::Dir;
        let fetching = files.fetching.contains(&entry.path);
        let selected = files.selected.as_deref() == Some(entry.path.as_str());
        let hover = theme.ink_at(0.03);
        let open = entry.clone();
        let save = (!folder && files.live && !fetching).then(|| {
            let file = entry.clone();
            small_button(SharedString::from(format!("computer-file-save-{index}")), "download", "Download", true, theme)
                .on_click(cx.listener(move |this, _, window, cx| {
                    cx.stop_propagation();
                    this.download_computer_file(file.clone(), window, cx);
                }))
        });
        div()
            .id(SharedString::from(format!("computer-file-{index}")))
            .flex()
            .items_center()
            .gap(px(10.))
            .min_h(px(44.))
            .pl(px(14.))
            .pr(px(8.))
            .when(index > 0, |row| row.border_t_1().border_color(theme.ink_at(0.05)))
            .when(selected, |row| row.bg(theme.ink_at(0.05)))
            .cursor_pointer()
            .hover(move |style| style.bg(hover))
            .on_click(cx.listener(move |this, _, window, cx| {
                if open.kind == ComputerFileKind::Dir {
                    this.enter_computer_folder(&open, window, cx);
                } else {
                    this.preview_computer_file(open.clone(), window, cx);
                }
            }))
            .child(icon(if folder { "folder" } else { "file" }, px(16.), theme.ink_secondary))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .items_baseline()
                    .gap_2()
                    .child(div().min_w_0().item().text_color(theme.ink).truncate().child(entry.name().to_owned()))
                    .when(!folder, |line| {
                        line.child(
                            div()
                                .flex_shrink_0()
                                .meta()
                                .text_color(theme.ink_tertiary)
                                .child(files::size_label(entry.size)),
                        )
                    }),
            )
            .when(fetching, |row| {
                row.child(
                    div()
                        .size_7()
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(Spinner::new().with_size(px(14.)).color(theme.ink_tertiary)),
                )
            })
            .children(save)
            .when(folder, |row| row.child(div().pr_1p5().child(icon("chevron-right", px(15.), theme.ink_tertiary))))
            .into_any_element()
    }

    fn render_computer_preview(
        &self,
        files: &ComputerFiles,
        preview: &Preview,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let file = preview.file.clone();
        let fetching = files.fetching.contains(&file.path);
        let save = (files.live && !fetching).then(|| {
            let file = file.clone();
            small_button("computer-preview-save", "download", "Download", true, theme)
                .on_click(cx.listener(move |this, _, window, cx| this.download_computer_file(file.clone(), window, cx)))
        });
        let toolbar = div()
            .flex()
            .items_center()
            .gap_1p5()
            .min_h(px(44.))
            .pl(px(8.))
            .pr(px(8.))
            .border_b_1()
            .border_color(theme.ink_at(0.05))
            .child(
                small_button("computer-preview-back", "arrow-left", "Back", true, theme)
                    .on_click(cx.listener(|this, _, _, cx| this.close_computer_preview(cx))),
            )
            .child(icon("file", px(16.), theme.ink_secondary))
            .child(div().flex_1().min_w_0().name().text_color(theme.ink).truncate().child(file.name().to_owned()))
            .child(div().flex_shrink_0().meta().text_color(theme.ink_tertiary).child(files::size_label(file.size)))
            .when(fetching, |bar| {
                bar.child(
                    div()
                        .size_7()
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(Spinner::new().with_size(px(14.)).color(theme.ink_tertiary)),
                )
            })
            .children(save);
        let body = match &preview.text {
            None => div()
                .py(px(22.))
                .flex()
                .justify_center()
                .child(Spinner::new().with_size(px(16.)).color(theme.ink_tertiary))
                .into_any_element(),
            Some(Err(problem)) => div()
                .px(px(14.))
                .py(px(18.))
                .flex()
                .justify_center()
                .body()
                .text_color(theme.ink_tertiary)
                .child(problem.clone())
                .into_any_element(),
            Some(Ok(text)) if text.is_empty() => div()
                .px(px(14.))
                .py(px(18.))
                .flex()
                .justify_center()
                .body()
                .text_color(theme.ink_tertiary)
                .child("This file is empty")
                .into_any_element(),
            Some(Ok(text)) => {
                let shown: String = text.chars().take(MOST_PREVIEW_CHARS).collect();
                let cut = shown.len() < text.len();
                div()
                    .id("computer-preview-text")
                    .max_h(px(380.))
                    .overflow_y_scroll()
                    .px(px(14.))
                    .py(px(12.))
                    .font_family(theme.mono.clone())
                    .meta()
                    .text_color(theme.ink)
                    .child(shown)
                    .when(cut, |body| {
                        body.child(
                            div()
                                .mt_3()
                                .font_family(theme.font.clone())
                                .text_color(theme.ink_tertiary)
                                .child("Download it to see the rest."),
                        )
                    })
                    .into_any_element()
            }
        };
        div().flex().flex_col().child(toolbar).child(body).into_any_element()
    }
}

/// Reads the chosen files as base64 for the upload route, after checking each against the
/// server's limit without reading it.
fn read_uploads(paths: Vec<PathBuf>, limit: u64) -> Result<Vec<(String, String)>, String> {
    paths
        .iter()
        .map(|path| {
            let name = path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
            match std::fs::metadata(path) {
                Ok(metadata) if metadata.is_file() && metadata.len() > limit => {
                    Err(files::Refused::TooLarge { name, limit }.sentence())
                }
                Ok(metadata) if metadata.is_file() => {
                    files::read_base64(path, limit).map(|content| (name, content)).map_err(|refused| refused.sentence())
                }
                _ => Err(files::Refused::Unreadable(name).sentence()),
            }
        })
        .collect()
}

fn small_button(
    id: impl Into<ElementId>,
    glyph: &'static str,
    tip: impl Into<SharedString>,
    ready: bool,
    theme: &Theme,
) -> Stateful<Div> {
    let tip = tip.into();
    let hover = theme.ink_at(0.07);
    div()
        .id(id)
        .size_7()
        .flex_shrink_0()
        .flex()
        .items_center()
        .justify_center()
        .rounded_full()
        .map(|button| tooltip::on(button, tip))
        .map(
            |button| {
                if ready {
                    button.cursor_pointer().hover(move |style| style.bg(hover))
                } else {
                    button.opacity(0.4)
                }
            },
        )
        .child(icon(glyph, px(15.), theme.ink_secondary))
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use superbot_features::{ComputerFile, ComputerFileKind, ComputerStatus};

    use super::{browsable, folder_name, ordered, upload_access, Upload};

    fn status(fields: serde_json::Value) -> ComputerStatus {
        let mut base = json!({
            "botId": "bot-1", "mode": "team", "kind": "fake", "state": "running",
            "controlHolder": "none", "takeoverRequested": false, "screenAvailable": true,
            "busyBotName": null
        });
        base.as_object_mut().unwrap().extend(fields.as_object().unwrap().clone());
        serde_json::from_value(base).unwrap()
    }

    fn entry(path: &str, kind: ComputerFileKind) -> ComputerFile {
        ComputerFile { path: path.into(), kind, size: 1 }
    }

    #[test]
    fn folders_come_first_then_names_in_reading_order() {
        let listed = ordered(vec![
            entry("b.txt", ComputerFileKind::File),
            entry("Zeta", ComputerFileKind::Dir),
            entry("A.txt", ComputerFileKind::File),
            entry("alpha", ComputerFileKind::Dir),
            entry("", ComputerFileKind::Dir),
        ]);
        let names: Vec<&str> = listed.iter().map(ComputerFile::name).collect();
        assert_eq!(names, ["alpha", "Zeta", "A.txt", "b.txt"]);
    }

    #[test]
    fn only_a_remote_computer_in_use_has_files_to_browse() {
        assert!(browsable(&status(json!({})), true));
        assert!(!browsable(&status(json!({})), false));
        assert!(!browsable(&status(json!({ "kind": "none" })), true));
        assert!(!browsable(&status(json!({ "runsOnUserMachine": true })), true));
    }

    #[test]
    fn uploading_follows_who_holds_the_computer() {
        assert_eq!(upload_access(&status(json!({ "state": "stopped" }))), None);
        assert_eq!(upload_access(&status(json!({}))), Some(Upload::Borrow));
        assert_eq!(
            upload_access(&status(json!({ "controlLeaseId": "lease-1", "controlHolder": "user" }))),
            Some(Upload::Held)
        );
        assert!(matches!(upload_access(&status(json!({ "controlledByOther": true }))), Some(Upload::Blocked(_))));
        assert_eq!(
            upload_access(&status(json!({ "busyBotName": "Scout", "controlHolder": "bot" }))),
            Some(Upload::Blocked("Scout is using it right now".into()))
        );
        assert!(matches!(upload_access(&status(json!({ "controlHolder": "bot" }))), Some(Upload::Blocked(_))));
    }

    #[test]
    fn the_top_folder_is_called_files() {
        assert_eq!(folder_name(""), "Files");
        assert_eq!(folder_name("reports/2026/"), "2026");
        assert_eq!(folder_name("shared"), "shared");
    }
}
