use gpui_kit::*;

use super::{conversations, new_agent, Desktop, View};

pub(super) fn shortcuts(window: &Window, cx: &mut Context<Desktop>) -> [Subscription; 2] {
    let owner = window.window_handle().window_id();
    let observe = cx.observe_keystrokes(move |this, event, window, cx| {
        if window.window_handle().window_id() != owner {
            return;
        }
        if event.keystroke.key == "escape" {
            this.dismiss(window, cx);
        } else if this.modal_open() {
            return;
        } else if is_tab(&event.keystroke) && event.action.is_none() {
            // The kit's Root binding needs a mounted focus path.
            step_tab(event.keystroke.modifiers.shift, window, cx);
        } else if new_agent::is_new_agent_shortcut(&event.keystroke) {
            this.new_agent(window, cx);
        } else if conversations::is_new_conversation_shortcut(&event.keystroke) {
            this.new_conversation(window, cx);
        }
    });
    let desktop = cx.entity().downgrade();
    let intercept = cx.intercept_keystrokes(move |event, window, cx| {
        if window.window_handle().window_id() != owner || !is_tab(&event.keystroke) {
            return;
        }
        let _ = desktop.update(cx, |this, cx| {
            if !this.modal_open() {
                return;
            }
            if let Some(scope) = &this.modal_focus {
                scope.tab(event.keystroke.modifiers.shift, window, cx);
            }
            cx.stop_propagation();
        });
    });
    [observe, intercept]
}

fn is_tab(key: &Keystroke) -> bool {
    let m = key.modifiers;
    key.key == "tab" && !m.control && !m.alt && !m.platform && !m.function
}

fn step_tab(backward: bool, window: &mut Window, cx: &mut App) {
    if backward {
        window.focus_prev(cx);
    } else {
        window.focus_next(cx);
    }
}

fn boundary(cx: &App, index: isize) -> FocusHandle {
    cx.focus_handle().tab_stop(true).tab_index(index)
}

pub(super) struct ModalFocus {
    previous: Option<WeakFocusHandle>,
    scope: FocusHandle,
    start: FocusHandle,
    end: FocusHandle,
}

impl ModalFocus {
    fn tab(&self, backward: bool, window: &mut Window, cx: &mut App) {
        let (first, last) = if backward { (&self.end, &self.start) } else { (&self.start, &self.end) };
        if !self.scope.contains(first, window) {
            return;
        }
        if self.scope.contains_focused(window, cx) {
            step_tab(backward, window, cx);
        } else {
            first.focus(window, cx);
            step_tab(backward, window, cx);
        }
        // The boundary is reached before any background control, in either direction.
        if last.is_focused(window) {
            first.focus(window, cx);
            step_tab(backward, window, cx);
        }
        if last.is_focused(window) || !self.scope.contains_focused(window, cx) {
            // A busy or mouse-only overlay may temporarily have no tab stops of its own.
            self.scope.focus(window, cx);
        }
    }

    fn wrap(&self, content: AnyElement) -> Stateful<Div> {
        div()
            .id("modal-focus")
            .absolute()
            .inset_0()
            .track_focus(&self.scope)
            .tab_index(isize::MIN)
            .tab_group()
            .child(div().absolute().size_0().track_focus(&self.start))
            .child(content)
            .child(div().absolute().size_0().track_focus(&self.end))
    }
}

impl Desktop {
    pub(crate) fn modal_open(&self) -> bool {
        self.dialog.is_some()
            || self.create.panel.is_some()
            || self.store.version_switch.is_some()
            || self.store.confirm.is_some()
    }

    /// Capture the underlying focus before a modal autofocuses its first field.
    pub(super) fn begin_modal(&mut self, window: &Window, cx: &App) {
        self.modal_focus.get_or_insert_with(|| ModalFocus {
            previous: window.focused(cx).map(|handle| handle.downgrade()),
            scope: cx.focus_handle(),
            start: boundary(cx, isize::MIN),
            end: boundary(cx, isize::MAX),
        });
    }

    pub(crate) fn modal(
        &mut self,
        content: Option<AnyElement>,
        window: &mut Window,
        cx: &mut App,
    ) -> Option<Stateful<Div>> {
        if let Some(content) = content {
            self.begin_modal(window, cx);
            let scope = self.modal_focus.as_ref()?;
            if window.focused(cx) == scope.previous.as_ref().and_then(WeakFocusHandle::upgrade) {
                scope.scope.focus(window, cx);
            }
            Some(scope.wrap(content))
        } else {
            if let Some(scope) = self.modal_focus.take() {
                if window.focused(cx).is_none() || scope.scope.contains_focused(window, cx) {
                    if let Some(previous) = scope.previous.and_then(|previous| previous.upgrade()) {
                        previous.focus(window, cx);
                    } else {
                        window.blur(cx);
                    }
                }
            }
            None
        }
    }

    pub(crate) fn close_menu(&mut self, window: &mut Window, cx: &mut App) -> bool {
        let Some(menu) = self.menu.take() else { return false };
        self.create.highlight = None;
        if let Some(previous) = menu.return_focus.and_then(|focus| focus.upgrade()) {
            previous.focus(window, cx);
        } else {
            window.blur(cx);
        }
        true
    }

    /// Escape closes the topmost thing that is open.
    pub fn dismiss(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let closed = if self.store.confirm.is_some() {
            self.cancel_store_confirm()
        } else if self.store.version_switch.is_some() {
            self.store.cancel_version_switch()
        } else if self.create.panel.is_some() {
            self.close_create_panel()
        } else if let Some(dialog) = &self.dialog {
            if dialog.busy {
                return false;
            }
            self.dialog = None;
            true
        } else if self.close_menu(window, cx) {
            true
        } else if self.cancel_rename(cx) {
            true
        } else if self.search_open {
            self.search_open = false;
            true
        } else if self.agent_panel_back(cx) {
            true
        } else if self.view == View::Chat && self.chat.as_ref().is_some_and(|chat| chat.app_assist.is_open()) {
            self.close_app_assist(cx);
            true
        } else {
            false
        };
        if closed {
            cx.notify();
        }
        closed
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use crate::app::{DialogKind, MenuKind};
    use crate::fonts::Fonts;
    use crate::theme::{Skin, Theme};

    struct Toolbar;

    impl Render for Toolbar {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            div()
        }
    }

    #[::core::prelude::v1::test]
    fn shortcuts_ignore_other_windows_and_tab_wraps_and_restores_dialog_focus() {
        crate::test_support::headless(|cx| {
            gpui_kit::init(cx);
            Theme::of(Skin::Midnight, &Fonts { sans: "sans-serif".into(), mono: "monospace".into() }).install(cx);
            let main = cx
                .open_window(WindowOptions::default(), |window, cx| {
                    cx.new(|cx| Desktop::initial("http://127.0.0.1:1".into(), window, cx))
                })
                .unwrap();
            let workspace = cx.open_window(WindowOptions::default(), |_, cx| cx.new(|_| Toolbar)).unwrap();
            main.update(cx, |desktop, window, cx| desktop.open_menu(MenuKind::Spaces, Point::default(), window, cx))
                .unwrap();
            AnyWindowHandle::from(workspace)
                .update(cx, |_, window, cx| {
                    window.dispatch_keystroke(Keystroke::parse("escape").unwrap(), cx);
                })
                .unwrap();
            main.update(cx, |desktop, _, _| assert!(desktop.menu.is_some())).unwrap();
            let main_window: AnyWindowHandle = main.into();
            main_window
                .update(cx, |_, window, cx| {
                    window.dispatch_keystroke(Keystroke::parse("escape").unwrap(), cx);
                })
                .unwrap();
            let previous = main
                .update(cx, |desktop, window, cx| {
                    assert!(desktop.menu.is_none());
                    let previous = desktop.sign_in.email.read(cx).focus_handle(cx);
                    previous.focus(window, cx);
                    desktop.open_menu(MenuKind::Agent("fixture".into()), Point::default(), window, cx);
                    cx.focus_handle().focus(window, cx);
                    desktop.close_menu(window, cx);
                    desktop.open_dialog(DialogKind::RenameAgent("fixture".into()), window, cx);
                    // The scope must leave focus on the input until its tab stops are mounted.
                    desktop.modal_focus.as_ref().unwrap().tab(false, window, cx);
                    assert!(desktop.dialog.as_ref().unwrap().input.read(cx).focus_handle(cx).is_focused(window));
                    previous
                })
                .unwrap();
            let input = main
                .update(cx, |desktop, _, cx| desktop.dialog.as_ref().unwrap().input.read(cx).focus_handle(cx))
                .unwrap();
            main_window
                .update(cx, |_, window, cx| {
                    let key = |window: &mut Window, cx: &mut App, key| {
                        window.dispatch_keystroke(Keystroke::parse(key).unwrap(), cx);
                    };
                    window.draw(cx).clear(cx);
                    assert!(input.is_focused(window));
                    key(window, cx, "tab");
                    let cancel = window.focused(cx).unwrap();
                    assert_ne!(cancel, input);
                    key(window, cx, "tab");
                    let save = window.focused(cx).unwrap();
                    assert_ne!(cancel, save);
                    assert_ne!(input, save);
                    key(window, cx, "tab");
                    assert!(input.is_focused(window));
                    key(window, cx, "shift-tab");
                    assert!(save.is_focused(window));
                    key(window, cx, "escape");
                })
                .unwrap();
            main_window
                .update(cx, |_, window, cx| {
                    window.draw(cx).clear(cx);
                    assert!(previous.is_focused(window));
                })
                .unwrap();
        });
    }
}
