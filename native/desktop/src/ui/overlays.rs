use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::app::{Desktop, DialogKind, MenuKind, View};
use crate::theme::{radius, ActiveTheme, Theme};
use crate::ui::{error_line, field, icon, pill_button, Tone, Type};

enum Item {
    Label(String),
    Separator,
    Row {
        id: &'static str,
        glyph: &'static str,
        label: String,
        chosen: bool,
        danger: bool,
        act: Box<dyn Fn(&mut Desktop, &mut Window, &mut Context<Desktop>) + 'static>,
    },
}

fn item(
    id: &'static str,
    glyph: &'static str,
    label: impl Into<String>,
    act: impl Fn(&mut Desktop, &mut Window, &mut Context<Desktop>) + 'static,
) -> Item {
    Item::Row { id, glyph, label: label.into(), chosen: false, danger: false, act: Box::new(act) }
}

impl Desktop {
    pub fn render_menu(&mut self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let theme = cx.skin().clone();
        let menu = self.menu.as_ref()?;
        let (items, anchor) = match &menu.kind {
            MenuKind::Spaces => {
                let current = self.space_id();
                let mut items = vec![Item::Label("Spaces".into())];
                for space in &self.spaces {
                    let id = space.id.clone();
                    items.push(Item::Row {
                        id: "space",
                        glyph: if space.shared { "users" } else { "user" },
                        label: space.name.clone(),
                        chosen: current.as_deref() == Some(space.id.as_str()),
                        danger: false,
                        act: Box::new(move |this, window, cx| this.switch_space(id.clone(), window, cx)),
                    });
                }
                items.push(Item::Separator);
                items.push(item("new-space", "plus", "New space…", |this, window, cx| {
                    this.open_dialog(DialogKind::NewSpace, window, cx)
                }));
                (items, Anchor::TopLeft)
            }
            MenuKind::Profile => {
                let email = self.me.as_ref().map(|me| me.email.clone()).unwrap_or_default();
                let items = vec![
                    Item::Label(email),
                    item("manage", "settings", "Manage workspace", |this, window, cx| {
                        this.show(View::Workspace, window, cx)
                    }),
                    item("plugins", "apps", "Plugins", |this, window, cx| this.show(View::Store, window, cx)),
                    item("web", "app-window", "Open web workspace", |this, _, cx| this.open_web_workspace(cx)),
                    item("web-browser", "external-link", "Open in browser", |this, _, cx| {
                        this.open_web_workspace_in_browser(cx)
                    }),
                    Item::Separator,
                    item("sign-out", "log-out", "Sign out", |this, window, cx| this.sign_out(window, cx)),
                ];
                (items, Anchor::BottomLeft)
            }
            MenuKind::Agent(agent_id) => {
                let pinned = self.agent(agent_id).is_some_and(|agent| agent.pinned);
                let (rename, pin, archive) = (agent_id.clone(), agent_id.clone(), agent_id.clone());
                let items = vec![
                    item("rename", "pencil", "Rename…", move |this, window, cx| {
                        this.open_dialog(DialogKind::RenameAgent(rename.clone()), window, cx)
                    }),
                    item("pin", "pin", if pinned { "Unpin" } else { "Pin" }, move |this, window, cx| {
                        this.set_pinned(pin.clone(), !pinned, window, cx)
                    }),
                    Item::Separator,
                    Item::Row {
                        id: "archive",
                        glyph: "archive",
                        label: "Archive".into(),
                        chosen: false,
                        danger: true,
                        act: Box::new(move |this, window, cx| this.archive_agent(archive.clone(), window, cx)),
                    },
                ];
                (items, Anchor::TopLeft)
            }
        };
        let at = menu.at;

        let sheet = div()
            .w(px(256.))
            .p_1()
            .flex()
            .flex_col()
            .rounded(radius::CARD)
            .bg(theme.menu)
            .border_1()
            .border_color(theme.ink_at(0.1))
            .shadow(theme.float_shadow())
            .occlude()
            .children(items.into_iter().enumerate().map(|(index, item)| {
                match item {
                    Item::Label(text) => div()
                        .px_2()
                        .pt_1p5()
                        .pb_1()
                        .meta()
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(theme.ink_tertiary)
                        .truncate()
                        .child(text)
                        .into_any_element(),
                    Item::Separator => div().my_1().mx_2().h(px(1.)).bg(theme.hairline.opacity(0.5)).into_any_element(),
                    Item::Row { id, glyph, label, chosen, danger, act } => {
                        let ink = if danger { theme.danger } else { theme.ink };
                        let hover = theme.ink_at(0.06);
                        div()
                            .id((id, index))
                            .h_8()
                            .px_2()
                            .flex()
                            .items_center()
                            .gap_2()
                            .rounded(radius::MENU_ROW)
                            .item()
                            .text_color(ink)
                            .cursor_pointer()
                            .hover(move |style| style.bg(hover))
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.menu = None;
                                act(this, window, cx);
                                cx.notify();
                            }))
                            .child(icon(glyph, px(16.), if danger { theme.danger } else { theme.ink_secondary }))
                            .child(div().flex_1().min_w_0().truncate().child(label))
                            .when(chosen, |row| row.child(icon("check", px(14.), theme.ink_secondary)))
                            .into_any_element()
                    }
                }
            }));

        Some(
            div()
                .id("menu-backdrop")
                .absolute()
                .inset_0()
                .occlude()
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(|this, _, _, cx| {
                        this.menu = None;
                        cx.notify();
                    }),
                )
                .on_mouse_down(
                    MouseButton::Right,
                    cx.listener(|this, _, _, cx| {
                        this.menu = None;
                        cx.notify();
                    }),
                )
                .child(
                    deferred(anchored().position(at).anchor(anchor).snap_to_window_with_margin(px(8.)).child(sheet))
                        .with_priority(1),
                )
                .into_any_element(),
        )
    }

    pub fn render_dialog(&mut self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let theme = cx.skin().clone();
        let dialog = self.dialog.as_ref()?;
        let (title, label, action, working) = match dialog.kind {
            DialogKind::NewAgent => ("New agent", "Name", "Create agent", "Creating…"),
            DialogKind::NewSpace => ("New space", "Name", "Create space", "Creating…"),
            DialogKind::RenameAgent(_) => ("Rename agent", "Name", "Save", "Saving…"),
        };
        Some(
            div()
                .id("dialog-scrim")
                .absolute()
                .inset_0()
                .flex()
                .items_center()
                .justify_center()
                .bg(theme.scrim)
                .occlude()
                .on_click(cx.listener(|this, _, _, cx| {
                    this.dismiss(cx);
                }))
                .child(
                    div()
                        .id("dialog")
                        .w(px(400.))
                        .p_5()
                        .flex()
                        .flex_col()
                        .gap_4()
                        .rounded(radius::DIALOG)
                        .bg(theme.menu)
                        .border_1()
                        .border_color(theme.ink_at(0.1))
                        .shadow(theme.float_shadow())
                        .on_click(|_, _, cx| cx.stop_propagation())
                        .child(div().title().child(title))
                        .children(dialog.error.clone().map(|error| error_line(error, &theme)))
                        .child(field(label, &dialog.input, &theme))
                        .child(
                            div()
                                .flex()
                                .justify_end()
                                .gap_2()
                                .child(
                                    pill_button("dialog-cancel", "Cancel", Tone::Quiet, !dialog.busy, &theme).on_click(
                                        cx.listener(|this, _, _, cx| {
                                            this.dismiss(cx);
                                        }),
                                    ),
                                )
                                .child(
                                    pill_button(
                                        "dialog-submit",
                                        if dialog.busy { working } else { action },
                                        Tone::Primary,
                                        !dialog.busy,
                                        &theme,
                                    )
                                    .on_click(cx.listener(|this, _, window, cx| this.submit_dialog(window, cx))),
                                ),
                        ),
                )
                .into_any_element(),
        )
    }

    pub fn render_notice(&mut self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let theme = cx.skin().clone();
        let notice = self.notice.as_ref()?;
        let hover = theme.raised;
        Some(
            div()
                .absolute()
                .left_4()
                .bottom_4()
                .max_w(px(320.))
                .px_3p5()
                .py_2p5()
                .flex()
                .items_center()
                .gap_3()
                .rounded(radius::CARD)
                .bg(theme.card)
                .border_1()
                .border_color(if notice.error { theme.danger.opacity(0.3) } else { theme.hairline.opacity(0.5) })
                .shadow(theme.float_shadow())
                .body()
                .text_color(if notice.error { theme.danger } else { theme.ink })
                .occlude()
                .child(div().flex_1().min_w_0().child(notice.text.clone()))
                .when(notice.undo.is_some(), |row| {
                    row.child(
                        div()
                            .id("undo")
                            .px_1p5()
                            .py_0p5()
                            .rounded(radius::MENU_ROW)
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(theme.accent_text)
                            .cursor_pointer()
                            .hover(move |style| style.bg(hover))
                            .on_click(cx.listener(|this, _, window, cx| this.undo(window, cx)))
                            .child("Undo"),
                    )
                })
                .into_any_element(),
        )
    }
}

/// The caption buttons, in the shape and size of Windows 11's own.
#[cfg(not(target_os = "macos"))]
pub fn caption_buttons(window: &Window, theme: &Theme) -> Div {
    use crate::theme::{CAPTION_HEIGHT, CAPTION_WIDTH};
    let button = |id: &'static str, glyph: &'static str, area: WindowControlArea, close: bool| {
        let (hover, hover_ink) = if close { (theme.danger, theme.danger_ink) } else { (theme.ink_at(0.06), theme.ink) };
        div()
            .id(id)
            .w(CAPTION_WIDTH / 3.)
            .h_full()
            .flex()
            .items_center()
            .justify_center()
            .text_color(theme.ink)
            .hover(move |style| style.bg(hover).text_color(hover_ink))
            .window_control_area(area)
            .child(svg().path(SharedString::from(format!("icons/{glyph}.svg"))).size(px(16.)).text_color(theme.ink))
    };
    let restore = if window.is_maximized() { "window-restore" } else { "window-maximize" };
    div()
        .absolute()
        .top_0()
        .right_0()
        .h(CAPTION_HEIGHT)
        .flex()
        .child(button("caption-minimize", "window-minimize", WindowControlArea::Min, false))
        .child(button("caption-maximize", restore, WindowControlArea::Max, false))
        .child(button("caption-close", "window-close", WindowControlArea::Close, true))
}
