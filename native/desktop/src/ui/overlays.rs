use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::api::Target;
use crate::app::{Desktop, DialogKind, MenuKind, View};
use crate::theme::{radius, ActiveTheme, Theme};
use crate::ui::focus::{self, Ring};
use crate::ui::motion::{self, Colors, Pointer};
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

/// Bring in the floating sheet without fading its click-away layer.
pub(super) fn menu_enter(
    id: &'static str,
    sheet: Stateful<Div>,
    cx: &App,
    translate: impl Fn(Stateful<Div>, f32) -> Stateful<Div> + 'static,
) -> AnyElement {
    match menu_animation(cx.reduce_motion()) {
        Some(animation) => sheet
            .with_animation(id, animation, move |sheet, progress| translate(sheet.opacity(progress), 1. - progress))
            .into_any_element(),
        None => translate(sheet, 0.).into_any_element(),
    }
}

fn menu_animation(reduced_motion: bool) -> Option<Animation> {
    motion::animation(motion::duration(motion::POP, reduced_motion), motion::EMPHASIS)
}

impl Desktop {
    /// The Spaces to switch between, the current one checked, then the way to make another.
    fn space_items(&self) -> Vec<Item> {
        let current = self.space_id();
        let mut items: Vec<Item> = self
            .spaces
            .iter()
            .map(|space| {
                let id = space.id.clone();
                Item::Row {
                    id: "space",
                    glyph: if space.shared { "users" } else { "user" },
                    label: space.name.clone(),
                    chosen: current.as_deref() == Some(space.id.as_str()),
                    danger: false,
                    act: Box::new(move |this, window, cx| this.switch_space(id.clone(), window, cx)),
                }
            })
            .collect();
        items.push(Item::Separator);
        items.push(item("new-space", "plus", "New space…", |this, window, cx| {
            this.open_dialog(DialogKind::NewSpace, window, cx)
        }));
        items.push(item("join-space", "link", "Join with an invite…", |this, window, cx| {
            this.open_dialog(DialogKind::JoinSpace, window, cx)
        }));
        // People are invited from the workspace panel's People section.
        items.push(item("invite-people", "user-plus", "Invite people…", |this, window, cx| {
            this.show(View::Workspace, window, cx)
        }));
        items
    }

    pub fn render_menu(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        let theme = cx.skin().clone();
        let menu = self.menu.as_ref()?;
        let (items, anchor, entry, dy) = match &menu.kind {
            MenuKind::New => return Some(self.render_new_menu(cx)),
            MenuKind::Conversation { agent, thread } => {
                let (agent, thread) = (agent.clone(), thread.clone());
                return Some(self.render_conversation_menu(&agent, &thread, cx));
            }
            MenuKind::Model(bot_id) => {
                let bot_id = bot_id.clone();
                return Some(self.render_model_menu(&bot_id, window, cx));
            }
            MenuKind::Spaces => {
                let mut items = vec![Item::Label("Spaces".into())];
                items.extend(self.space_items());
                (items, Anchor::TopLeft, "spaces-enter", -4.)
            }
            MenuKind::Profile => {
                let email = self.me.as_ref().map(|me| me.email.clone()).unwrap_or_default();
                let spaces = match self.spaces.len() > 1 {
                    true => Vec::new(),
                    false => self.space_items().into_iter().chain([Item::Separator]).collect(),
                };
                let items = [Item::Label(email)].into_iter().chain(spaces).chain([
                    item("inbox", "inbox", self.inbox.menu_label(), |this, _, cx| this.toggle_inbox(cx)),
                    item("manage", "settings", "Manage workspace", |this, window, cx| {
                        this.show(View::Workspace, window, cx)
                    }),
                    item("plugins", "apps", "Store", |this, window, cx| this.show(View::Store, window, cx)),
                    item("web", "app-window", "Open web workspace", |this, _, cx| this.open_web_workspace(cx)),
                    item("web-browser", "external-link", "Open in browser", |this, _, cx| {
                        this.open_web_workspace_in_browser(cx)
                    }),
                    Item::Separator,
                    item("sign-out", "log-out", "Sign out", |this, window, cx| this.sign_out(window, cx)),
                ]);
                (items.collect(), Anchor::BottomLeft, "profile-enter", 4.)
            }
            MenuKind::Agent(agent_id) => {
                let pinned = self.agent(agent_id).is_some_and(|agent| agent.pinned);
                let (rename, pin, archive) = (agent_id.clone(), agent_id.clone(), agent_id.clone());
                let (conversation, details) = (agent_id.clone(), agent_id.clone());
                let items = vec![
                    item("rename", "pencil", "Rename…", move |this, window, cx| {
                        this.open_dialog(DialogKind::RenameAgent(rename.clone()), window, cx)
                    }),
                    item("new-conversation", "plus", "New conversation", move |this, window, cx| {
                        this.open_agent_chat(&conversation, window, cx);
                        this.new_conversation(window, cx);
                    }),
                    item("open-details", "settings", "Open details", move |this, window, cx| {
                        this.open_agent_chat(&details, window, cx);
                        this.open_agent_details(window, cx);
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
                (items, Anchor::TopLeft, "bot-menu-enter", -4.)
            }
        };
        let at = menu.at;

        let sheet = div()
            .id("context-menu-sheet")
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
                        let wrap_name = cfg!(target_os = "macos") && id == "space";
                        let button = div()
                            .id((id, index))
                            .when(wrap_name, |row| row.min_h_8().py_1())
                            .when(!wrap_name, |row| row.h_8())
                            .px_2()
                            .flex()
                            .items_center()
                            .gap_2()
                            .rounded(radius::MENU_ROW)
                            .item()
                            .text_color(ink)
                            .cursor_pointer()
                            .tab_index(0)
                            .focus_visible(move |style| style.bg(hover))
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.close_menu(window, cx);
                                act(this, window, cx);
                                cx.notify();
                            }))
                            .child(icon(glyph, px(16.), if danger { theme.danger } else { theme.ink_secondary }))
                            .child(div().flex_1().min_w_0().when(!wrap_name, |name| name.truncate()).child(label))
                            .when(chosen, |row| row.child(icon("check", px(14.), theme.ink_secondary)));
                        focus::decorate(button)
                            .fill(Pointer::MENU, Colors::ink(&theme, 0., 0.06, 0.08))
                            .into_any_element()
                    }
                }
            }));

        let sheet = menu_enter(entry, sheet, cx, move |sheet, remaining| sheet.relative().top(px(dy * remaining)));
        Some(
            div()
                .id("menu-backdrop")
                .absolute()
                .inset_0()
                .occlude()
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(|this, _, window, cx| {
                        this.close_menu(window, cx);
                        cx.notify();
                    }),
                )
                .on_mouse_down(
                    MouseButton::Right,
                    cx.listener(|this, _, window, cx| {
                        this.close_menu(window, cx);
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

    fn open_agent_chat(&mut self, agent: &str, window: &mut Window, cx: &mut Context<Self>) {
        if self.view != View::Chat || self.chat.as_ref().and_then(|chat| chat.target.agent()) != Some(agent) {
            self.open(Target::Agent(agent.to_owned()), window, cx);
        }
    }

    pub fn render_dialog(&mut self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let theme = cx.skin().clone();
        let dialog = self.dialog.as_ref()?;
        let (title, label, action, working) = match dialog.kind {
            DialogKind::NewSpace => ("New space", "Name", "Create space", "Creating…"),
            DialogKind::JoinSpace => ("Join a workspace", "Invite link", "Continue", "Checking…"),
            DialogKind::RenameAgent(_) => ("Rename agent", "Name", "Save", "Saving…"),
        };
        let enabled = !dialog.busy;
        let cancel = pill_button("dialog-cancel", "Cancel", Tone::Quiet, enabled, &theme).on_click(cx.listener(
            |this, _, window, cx| {
                this.dismiss(window, cx);
            },
        ));
        let submit =
            pill_button("dialog-submit", if dialog.busy { working } else { action }, Tone::Primary, enabled, &theme)
                .on_click(cx.listener(|this, _, window, cx| this.submit_dialog(window, cx)));
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
                .on_click(cx.listener(|this, _, window, cx| {
                    this.dismiss(window, cx);
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
                                .child(super::focus::modal_button(cancel, enabled, &theme))
                                .child(super::focus::modal_button(submit, enabled, &theme)),
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

#[cfg(test)]
mod motion_tests {
    use super::menu_animation;

    #[test]
    fn reduced_motion_omits_menu_entry_animation() {
        assert!(menu_animation(false).is_some());
        assert!(menu_animation(true).is_none());
    }
}

/// The caption buttons, spaced as the reference spaces them: glyph centres 38px apart, the close
/// glyph 30px from the edge. Close still reaches the window's corner, where a maximized window is
/// closed from.
#[cfg(not(target_os = "macos"))]
pub fn caption_buttons(window: &Window, theme: &Theme) -> Div {
    use crate::theme::CAPTION_HEIGHT;
    const PITCH: Pixels = px(38.);
    const INSET: Pixels = px(11.);
    let button = |id: &'static str, glyph: &'static str, area: WindowControlArea, close: bool| {
        let fills = if close {
            Colors::new(theme.danger.opacity(0.), theme.danger, crate::theme::mix(theme.danger, black(), 0.12))
        } else {
            Colors::ink(theme, 0., 0.06, 0.10)
        };
        let glyphs = if close {
            Colors::new(theme.ink, theme.danger_ink, theme.danger_ink)
        } else {
            Colors::new(theme.ink, theme.ink, theme.ink)
        };
        let button = div()
            .id(id)
            .w(if close { PITCH + INSET } else { PITCH })
            .when(close, |button| button.pr(INSET))
            .h_full()
            .flex()
            .items_center()
            .justify_center()
            .window_control_area(area)
            .on_click(move |event, window, _| {
                if matches!(event, ClickEvent::Keyboard(_)) {
                    match area {
                        WindowControlArea::Min => window.minimize_window(),
                        WindowControlArea::Max => window.zoom_window(),
                        WindowControlArea::Close => window.remove_window(),
                        _ => {}
                    }
                }
            });
        focus::control(button, Ring::Inner(px(0.)), theme).tint(Pointer::BUTTON, move |button, levels| {
            button.bg(fills.sample(levels)).child(
                svg()
                    .path(SharedString::from(format!("icons/{glyph}.svg")))
                    .size(px(16.))
                    .text_color(glyphs.sample(levels)),
            )
        })
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
