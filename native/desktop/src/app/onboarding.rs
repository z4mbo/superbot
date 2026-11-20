//! Arriving: an invite link brought from outside the app, the first choice of a new account
//! between making a space and joining one, and the space a returning person left off in.

use gpui_kit::*;
use superbot_client::{remember_space, remembered_space, Client, Error};
use superbot_features::{Features, InvitePreview};

use super::{Desktop, DialogKind, SignInMode, View};
use crate::api::{self, Api, Me, Navigation};

/// Invite tokens are this long at most on the server.
const TOKEN_LONGEST: usize = 200;

#[derive(Default)]
pub struct Onboarding {
    /// A link pasted before signing in, kept through signing in or making an account.
    pub pending: Option<Invite>,
    pub page: Option<Page>,
    remembered: Option<String>,
}

/// An invite link: the server it belongs to and its single-use token.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Invite {
    pub server: String,
    pub token: String,
}

/// A full-window step shown before the workspace.
pub enum Page {
    /// A new account's first screen: make a space or join one, or carry on alone.
    Welcome,
    Join {
        token: String,
        state: Joining,
    },
}

pub enum Joining {
    Checking,
    Ready(InvitePreview),
    Accepting(InvitePreview),
    /// Used, cancelled, expired or unknown.
    Invalid,
    Failed(String),
}

/// Reads an invite link someone pasted or copied, e.g. `https://superbot.example.com/invite/abc`.
pub fn invite_link(text: &str) -> Option<Invite> {
    let url = url::Url::parse(text.trim()).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    let token = url.path().strip_prefix("/invite/")?;
    if !is_token(token) {
        return None;
    }
    let server = Client::new(&url.origin().ascii_serialization()).ok()?.server().to_owned();
    Some(Invite { server, token: token.to_owned() })
}

/// The token from a pasted link, or a bare token, for the server already in use.
fn token_for(text: &str, server: &str) -> Result<String, &'static str> {
    let text = text.trim();
    if is_token(text) {
        return Ok(text.to_owned());
    }
    match invite_link(text) {
        Some(invite) if invite.server == server => Ok(invite.token),
        Some(_) => Err("That invite is for another server. Sign in there to use it."),
        None => Err("Paste the invite link you were sent."),
    }
}

fn is_token(text: &str) -> bool {
    (1..=TOKEN_LONGEST).contains(&text.len())
        && text.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

/// A refusal the person can only answer with another link.
fn invalid(error: &Error) -> bool {
    matches!(error, Error::Server { status, .. } if (400..500).contains(status) && *status != 401)
}

/// The navigation to open with: the space this person last had open here when they still
/// belong to it, otherwise the one the server chose.
pub async fn resumed(api: &Api, me: &Me, navigation: Navigation) -> Result<Navigation, Error> {
    let Some(space) = remembered_space(&api.client, &me.user_id) else { return Ok(navigation) };
    if space == navigation.current.id || !navigation.spaces.iter().any(|known| known.id == space) {
        return Ok(navigation);
    }
    match api.navigation(Some(&space)).await {
        Err(Error::Server { status: 403 | 404, .. }) => Ok(navigation),
        other => other,
    }
}

impl Desktop {
    /// Shows the invite field on the sign-in screen, filled from the clipboard when it holds a link.
    pub fn enter_invite(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let copied = cx.read_from_clipboard().and_then(|item| item.text()).filter(|text| invite_link(text).is_some());
        if let Some(link) = copied {
            self.sign_in.invite.update(cx, |field, cx| field.set_value(link.trim().to_owned(), window, cx));
        }
        self.set_sign_in_mode(SignInMode::Invite, cx);
        self.sign_in.invite.update(cx, |field, cx| field.focus(window, cx));
    }

    /// Keeps the pasted invite for after signing in, on the server it came from.
    pub fn continue_with_invite(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let pasted = self.sign_in.invite.read(cx).value().to_string();
        let Some(invite) = invite_link(&pasted) else {
            self.sign_in.error = Some("Paste the invite link you were sent.".into());
            cx.notify();
            return;
        };
        let server = invite.server.trim_end_matches('/').to_owned();
        self.sign_in.server.update(cx, |field, cx| field.set_value(server, window, cx));
        self.onboarding.pending = Some(invite);
        self.set_sign_in_mode(SignInMode::Password, cx);
        self.sign_in.email.update(cx, |field, cx| field.focus(window, cx));
    }

    pub fn forget_invite(&mut self, cx: &mut Context<Self>) {
        self.onboarding.pending = None;
        cx.notify();
    }

    /// After signing in: the invite brought along, else a new account's first choice.
    pub fn signed_in(&mut self, new_account: bool, window: &mut Window, cx: &mut Context<Self>) {
        self.sign_in.mode = SignInMode::Password;
        self.sign_in.status = None;
        let server = self.api.as_ref().map(|api| api.client.server().to_owned());
        match self.onboarding.pending.take() {
            Some(invite) if Some(&invite.server) == server.as_ref() => self.check_invite(invite.token, window, cx),
            Some(_) => self.notify("That invite was for another server, so it wasn't used.", true, None, cx),
            None if new_account => self.onboarding.page = Some(Page::Welcome),
            None => {}
        }
        cx.notify();
    }

    pub fn leave_onboarding(&mut self, cx: &mut Context<Self>) {
        self.onboarding.page = None;
        cx.notify();
    }

    /// Asks the server where an invite leads before joining.
    fn check_invite(&mut self, token: String, window: &mut Window, cx: &mut Context<Self>) {
        let Some(api) = self.api.clone() else { return };
        self.onboarding.page = Some(Page::Join { token: token.clone(), state: Joining::Checking });
        let asked = token.clone();
        let work = async move { Features::new(api.client).preview_space_invite(&asked).await };
        self.call(window, cx, work, move |this, result, window, cx| {
            if !matches!(&this.onboarding.page, Some(Page::Join { token: open, .. }) if *open == token) {
                return;
            }
            let state = match result {
                Ok(preview) if preview.already_member => {
                    this.onboarding.page = None;
                    this.switch_space(preview.space_id, window, cx);
                    return;
                }
                Ok(preview) => Joining::Ready(preview),
                Err(error) if invalid(&error) => Joining::Invalid,
                Err(error) => Joining::Failed(api::explain(&error)),
            };
            this.onboarding.page = Some(Page::Join { token, state });
        });
    }

    pub fn retry_invite(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(Page::Join { token, .. }) = &self.onboarding.page {
            let token = token.clone();
            self.check_invite(token, window, cx);
        }
    }

    pub fn accept_invite(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(api) = self.api.clone() else { return };
        let Some(Page::Join { token, state }) = self.onboarding.page.take() else { return };
        let Joining::Ready(preview) = state else {
            self.onboarding.page = Some(Page::Join { token, state });
            return;
        };
        let asked = token.clone();
        self.onboarding.page = Some(Page::Join { token: token.clone(), state: Joining::Accepting(preview.clone()) });
        cx.notify();
        let work = async move { Features::new(api.client).accept_space_invite(&asked).await };
        self.call(window, cx, work, move |this, result, window, cx| match result {
            Ok(space_id) => {
                this.onboarding.page = None;
                this.open_people_of(space_id, window, cx);
            }
            Err(error) => {
                let state = match invalid(&error) {
                    true => Joining::Invalid,
                    false => Joining::Failed(api::explain(&error)),
                };
                if matches!(&this.onboarding.page, Some(Page::Join { token: open, .. }) if *open == token) {
                    this.onboarding.page = Some(Page::Join { token, state });
                }
            }
        });
    }

    /// The welcome screen's choices, each opening its own step over the workspace.
    pub fn welcome_choice(&mut self, kind: DialogKind, window: &mut Window, cx: &mut Context<Self>) {
        self.onboarding.page = None;
        self.open_dialog(kind, window, cx);
    }

    /// Fills the join dialog from the clipboard when it holds an invite link for this server.
    pub(crate) fn copied_invite(&self, cx: &App) -> Option<String> {
        let server = self.api.as_ref()?.client.server();
        let copied = cx.read_from_clipboard()?.text()?;
        invite_link(&copied).filter(|invite| invite.server == server).map(|_| copied.trim().to_owned())
    }

    /// The join dialog's Continue: checks the pasted link, then shows where it leads.
    pub(crate) fn submit_invite_dialog(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(server) = self.api.as_ref().map(|api| api.client.server().to_owned()) else { return };
        let Some(dialog) = self.dialog.as_mut() else { return };
        let pasted = dialog.input.read(cx).value().to_string();
        match token_for(&pasted, &server) {
            Ok(token) => {
                self.dialog = None;
                self.check_invite(token, window, cx);
            }
            Err(problem) => dialog.error = Some(problem.into()),
        }
        cx.notify();
    }

    /// A new space opens on its people, where the owner invites others.
    pub(crate) fn open_new_space(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.show(View::Workspace, window, cx);
    }

    /// Opens a space someone just joined on its people, who are now theirs to work with.
    fn open_people_of(&mut self, space_id: String, window: &mut Window, cx: &mut Context<Self>) {
        self.view = View::Workspace;
        self.switch_space(space_id, window, cx);
    }

    /// Remembers the space on screen, so signing in again opens it.
    pub(crate) fn remember_open_space(&mut self) {
        let (Some(api), Some(me), Some(space)) = (self.api.as_ref(), self.me.as_ref(), self.space_id()) else {
            return;
        };
        if self.onboarding.remembered.as_ref() == Some(&space) || me.user_id.is_empty() {
            return;
        }
        if remember_space(&api.client, &me.user_id, &space).is_ok() {
            self.onboarding.remembered = Some(space);
        }
    }

    pub(crate) fn forget_onboarding(&mut self) {
        self.onboarding.page = None;
        self.onboarding.remembered = None;
    }
}

#[cfg(test)]
mod tests {
    use super::{invite_link, token_for, Invite};

    #[test]
    fn an_invite_link_names_its_server_and_token() {
        assert_eq!(
            invite_link(" https://superbot.example.com/invite/abc_DEF-123 "),
            Some(Invite { server: "https://superbot.example.com/".into(), token: "abc_DEF-123".into() })
        );
        assert_eq!(
            invite_link("http://127.0.0.1:5173/invite/t0k3n").map(|invite| invite.server),
            Some("http://127.0.0.1:5173/".into())
        );
        for text in [
            "abc",
            "https://superbot.example.com/join/abc",
            "https://superbot.example.com/invite/",
            "https://superbot.example.com/invite/a/b",
            "https://superbot.example.com/invite/a%20b",
            "ftp://superbot.example.com/invite/abc",
        ] {
            assert_eq!(invite_link(text), None, "{text}");
        }
        assert_eq!(invite_link(&format!("https://x.test/invite/{}", "a".repeat(201))), None);
    }

    #[test]
    fn a_signed_in_person_pastes_a_link_for_this_server_or_its_bare_token() {
        let server = "https://superbot.example.com/";
        assert_eq!(token_for("https://superbot.example.com/invite/abc", server), Ok("abc".into()));
        assert_eq!(token_for(" abc ", server), Ok("abc".into()));
        assert!(token_for("https://other.example.com/invite/abc", server).is_err());
        assert!(token_for("hello there", server).is_err());
    }
}
