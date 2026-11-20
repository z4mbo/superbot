use chrono::{Local, NaiveDate};
use gpui_kit::component::input::{InputEvent, InputState};
use gpui_kit::*;
use superbot_client::Error;
use superbot_features::local_app_records::{
    suggest_app_record, supports_app_assistance, AppContext as RecordContext, AppValues, FieldType, GrantedApp,
};
use superbot_features::Features;

use crate::api;
use crate::app::Desktop;
use crate::runtime::network;

mod view;

const DAY: &str = "%Y-%m-%d";
const WITHDRAWN: &str = "This app is no longer shared with this bot.";

/// Help from the chat's local model with the apps its bot was granted. The model reads one
/// app's recent records on this computer; nothing it reads or suggests reaches the conversation.
#[derive(Default)]
pub struct AppAssist {
    /// The bot the granted apps below were read for.
    bot: Option<String>,
    apps: Option<Result<Apps, String>>,
    reads: u64,
    reading_more: bool,
    panel: Option<Panel>,
}

struct Apps {
    items: Vec<GrantedApp>,
    next_after: Option<String>,
}

struct Panel {
    request: Entity<InputState>,
    _enter: Subscription,
    chosen: Option<Chosen>,
    problem: Option<String>,
    /// Just opened: the only granted app opens with it.
    opening: bool,
}

/// The app being worked with, and the records the model would read.
struct Chosen {
    app: GrantedApp,
    day: Option<NaiveDate>,
    context: Option<Result<RecordContext, String>>,
    reads: u64,
    /// The model run, from the moment the records are re-read for it.
    asking: Option<Task<()>>,
    asked: Option<Asked>,
    problem: Option<String>,
}

struct Asked {
    model: String,
    answer: String,
    addition: Option<Addition>,
}

/// A record the model suggested. It is saved only when the person adds it, and every attempt
/// sends the same operation and values, so a retry never adds it twice.
struct Addition {
    operation_id: String,
    values: AppValues,
    save: Save,
}

#[derive(Clone, PartialEq)]
enum Save {
    Proposed,
    Saving,
    Failed(String),
    Added,
    Skipped,
}

fn today() -> NaiveDate {
    Local::now().date_naive()
}

fn has_dates(app: &GrantedApp) -> bool {
    app.part.fields.iter().any(|field| field.kind == FieldType::Date)
}

/// A refusal meaning the bot no longer holds this app: the grant was revoked, the app was
/// uninstalled or moved to another version, or the bot is no longer this account's.
fn revoked(error: &Error) -> bool {
    matches!(error, Error::Server { status: 403 | 404, .. })
}

/// The `/apps` command, and the request typed after it.
pub fn apps_command(text: &str) -> Option<&str> {
    let text = text.trim();
    let rest = text.get(..5).filter(|head| head.eq_ignore_ascii_case("/apps")).map(|_| &text[5..])?;
    (rest.is_empty() || rest.starts_with(char::is_whitespace)).then(|| rest.trim())
}

impl AppAssist {
    /// Whether the bot holds an app the local model can help with.
    pub fn offered(&self) -> bool {
        matches!(&self.apps, Some(Ok(apps)) if !apps.items.is_empty())
    }

    pub fn is_open(&self) -> bool {
        self.panel.is_some()
    }
}

impl Desktop {
    fn app_assist(&mut self) -> Option<&mut AppAssist> {
        Some(&mut self.chat.as_mut()?.app_assist)
    }

    fn assist_panel(&mut self) -> Option<&mut Panel> {
        self.app_assist()?.panel.as_mut()
    }

    fn chosen_app(&mut self) -> Option<&mut Chosen> {
        self.assist_panel()?.chosen.as_mut()
    }

    /// The bot whose apps the chat's local model may help with: a direct conversation with a
    /// local model that can run without tools. The server decides whether this account owns it.
    fn app_assist_bot(&self) -> Option<String> {
        let chat = self.chat.as_ref()?;
        let bot = chat.target.agent()?;
        let model = self.selected_local_model()?;
        supports_app_assistance(&model).then(|| bot.to_owned())
    }

    fn app_features(&self) -> Option<(Features, String)> {
        Some((Features::new(self.api.as_ref()?.client.clone()), self.space_id()?))
    }

    /// Reads the bot's granted apps once a local model is chosen, and closes the panel when the
    /// chat stops qualifying.
    pub(crate) fn sync_app_assist(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let bot = self.app_assist_bot();
        let Some(assist) = self.app_assist() else { return };
        match bot {
            None => {
                if assist.bot.is_some() {
                    *assist = AppAssist::default();
                }
            }
            Some(bot) if assist.bot.as_deref() != Some(bot.as_str()) => {
                *assist = AppAssist { bot: Some(bot), ..AppAssist::default() };
                self.read_granted_apps(false, window, cx);
            }
            Some(_) => {}
        }
    }

    fn read_granted_apps(&mut self, more: bool, window: &mut Window, cx: &mut Context<Self>) {
        let Some((features, space)) = self.app_features() else { return };
        let Some(assist) = self.app_assist() else { return };
        let Some(bot) = assist.bot.clone() else { return };
        let after = match (&assist.apps, more) {
            (Some(Ok(apps)), true) => match &apps.next_after {
                Some(after) => Some(after.clone()),
                None => return,
            },
            _ => None,
        };
        assist.reads += 1;
        assist.reading_more = more;
        let read = assist.reads;
        let asked_for = bot.clone();
        let work = async move { features.space(space).local_record_apps(&bot, after.as_deref()).await };
        self.call(window, cx, work, move |this, result, window, cx| {
            let Some(assist) = this.app_assist().filter(|assist| assist.reads == read) else { return };
            if assist.bot.as_deref() != Some(asked_for.as_str()) {
                return;
            }
            assist.reading_more = false;
            assist.apps = Some(match (result, assist.apps.take()) {
                (Ok(page), Some(Ok(mut shown))) if more => {
                    shown.items.extend(page.items);
                    shown.next_after = page.next_after;
                    Ok(shown)
                }
                (Ok(page), _) => Ok(Apps { items: page.items, next_after: page.next_after }),
                (Err(error), _) => Err(api::explain(&error)),
            });
            this.settle_chosen_app(window, cx);
        });
        cx.notify();
    }

    /// Keeps the open app only while it is still granted, and opens the only app there is.
    fn settle_chosen_app(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(assist) = self.app_assist() else { return };
        let Some(Ok(apps)) = &assist.apps else { return };
        let complete = apps.next_after.is_none();
        let only = (apps.items.len() == 1 && complete).then(|| apps.items[0].clone());
        let granted: Vec<_> = apps.items.iter().map(|app| app.pin.clone()).collect();
        let Some(panel) = assist.panel.as_mut() else { return };
        let opening = std::mem::take(&mut panel.opening);
        match &panel.chosen {
            Some(chosen) if complete && !granted.contains(&chosen.app.pin) => {
                panel.chosen = None;
                panel.problem = Some(WITHDRAWN.into());
            }
            Some(_) => {}
            None => {
                if let Some(app) = only.filter(|_| opening) {
                    self.choose_app(app, window, cx);
                }
            }
        }
    }

    /// Installed apps, grants or records changed: re-reads what the composer and panel show.
    pub(crate) fn app_grants_changed(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.app_assist().is_some_and(|assist| assist.bot.is_some()) {
            return;
        }
        self.read_granted_apps(false, window, cx);
        if self.chosen_app().is_some_and(|chosen| chosen.asking.is_none()) {
            self.load_app_context(false, window, cx);
        }
    }

    /// Opens the panel from the composer, with what was typed after `/apps` as the request.
    pub(crate) fn open_app_assist(&mut self, request: Option<String>, window: &mut Window, cx: &mut Context<Self>) {
        self.sync_app_assist(window, cx);
        if !self.chat.as_ref().is_some_and(|chat| chat.app_assist.offered()) {
            return;
        }
        self.agent_panel = None;
        self.inbox.open = false;
        let Some(assist) = self.app_assist() else { return };
        let panel = match assist.panel.as_mut() {
            Some(panel) => panel,
            None => {
                let request = cx.new(|cx| InputState::new(window, cx).placeholder("What should it do?"));
                let enter = cx.subscribe_in(&request, window, |this, _, event: &InputEvent, window, cx| {
                    if matches!(event, InputEvent::PressEnter { .. }) {
                        this.ask_app(window, cx);
                    }
                });
                assist.panel.insert(Panel { request, _enter: enter, chosen: None, problem: None, opening: false })
            }
        };
        panel.opening = panel.chosen.is_none();
        panel.problem = None;
        let field = panel.request.clone();
        if let Some(request) = request.filter(|request| !request.is_empty()) {
            field.update(cx, |field, cx| field.set_value(request, window, cx));
        }
        field.update(cx, |field, cx| field.focus(window, cx));
        self.read_granted_apps(false, window, cx);
        cx.notify();
    }

    pub(crate) fn close_app_assist(&mut self, cx: &mut Context<Self>) {
        if let Some(assist) = self.app_assist() {
            assist.panel = None;
        }
        cx.notify();
    }

    /// Takes `/apps` from the composer instead of sending it, when the chat has a local model
    /// that can help with apps.
    pub(crate) fn take_apps_command(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let text = self.composer.read(cx).value().to_string();
        let Some(request) = apps_command(&text).map(str::to_owned) else { return false };
        if self.app_assist_bot().is_none() {
            return false;
        }
        let Some(chat) = self.chat.as_mut() else { return false };
        if !chat.app_assist.offered() {
            chat.error = Some(match &chat.app_assist.apps {
                Some(Err(problem)) => problem.clone(),
                _ => "This bot has no apps to help with.".into(),
            });
            cx.notify();
            return true;
        }
        self.composer.update(cx, |composer, cx| composer.set_value("", window, cx));
        self.open_app_assist(Some(request), window, cx);
        true
    }

    fn choose_app(&mut self, app: GrantedApp, window: &mut Window, cx: &mut Context<Self>) {
        let Some(panel) = self.assist_panel() else { return };
        let day = has_dates(&app).then(today);
        panel.problem = None;
        panel.chosen = Some(Chosen { app, day, context: None, reads: 0, asking: None, asked: None, problem: None });
        self.load_app_context(false, window, cx);
    }

    fn leave_app(&mut self, cx: &mut Context<Self>) {
        if let Some(panel) = self.assist_panel() {
            panel.chosen = None;
            panel.problem = None;
        }
        cx.notify();
    }

    fn show_app_day(&mut self, day: Option<NaiveDate>, window: &mut Window, cx: &mut Context<Self>) {
        let Some(chosen) = self.chosen_app().filter(|chosen| chosen.asking.is_none()) else { return };
        chosen.day = day;
        chosen.context = None;
        chosen.asked = None;
        chosen.problem = None;
        self.load_app_context(false, window, cx);
    }

    /// Reads the records the model would see, checking the bot still holds the app. With
    /// `then_ask`, the request goes to the model with exactly what was read.
    fn load_app_context(&mut self, then_ask: bool, window: &mut Window, cx: &mut Context<Self>) {
        let Some((features, space)) = self.app_features() else { return };
        let Some(bot) = self.app_assist().and_then(|assist| assist.bot.clone()) else { return };
        let Some(chosen) = self.chosen_app() else { return };
        chosen.reads += 1;
        let read = chosen.reads;
        let pin = chosen.app.pin.clone();
        let date = chosen.day.map(|day| day.format(DAY).to_string());
        let asked_pin = pin.clone();
        let work = async move { features.space(space).local_record_context(&bot, &pin, date.as_deref()).await };
        self.call(window, cx, work, move |this, result, window, cx| {
            let Some(chosen) = this.chosen_app().filter(|chosen| chosen.reads == read && chosen.app.pin == asked_pin)
            else {
                return;
            };
            match result {
                Ok(context) => {
                    chosen.context = Some(Ok(context));
                    if then_ask && chosen.asking.is_some() {
                        this.run_local_assist(window, cx);
                    }
                }
                Err(error) if revoked(&error) => this.app_withdrawn(window, cx),
                Err(error) => {
                    chosen.asking = None;
                    chosen.context = Some(Err(api::explain(&error)));
                }
            }
        });
        cx.notify();
    }

    /// The bot lost the open app: says so and reads which apps it still holds.
    fn app_withdrawn(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(panel) = self.assist_panel() else { return };
        panel.chosen = None;
        panel.problem = Some(WITHDRAWN.into());
        self.read_granted_apps(false, window, cx);
    }

    fn ask_app(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(panel) = self.assist_panel() else { return };
        let request = panel.request.read(cx).value().trim().to_owned();
        let Some(chosen) = panel.chosen.as_mut().filter(|chosen| chosen.asking.is_none()) else { return };
        let saving = chosen.asked.as_ref().and_then(|asked| asked.addition.as_ref()).is_some_and(|add| add.save == Save::Saving);
        if request.is_empty() || saving {
            return;
        }
        chosen.asked = None;
        chosen.problem = None;
        chosen.asking = Some(Task::ready(()));
        self.load_app_context(true, window, cx);
    }

    /// Hands the request and the records just read to the local model, with no conversation,
    /// tools or other apps.
    fn run_local_assist(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(cli), Some(model)) = (self.local_cli(), self.selected_local_model()) else { return };
        let Some(panel) = self.assist_panel() else { return };
        let request = panel.request.read(cx).value().trim().to_owned();
        let Some(chosen) = panel.chosen.as_mut() else { return };
        let Some(Ok(context)) = chosen.context.clone() else { return };
        let date = chosen.day.map(|day| day.format(DAY).to_string());
        let pin = chosen.app.pin.clone();
        let label = model.label.clone();
        chosen.asking = Some(cx.spawn_in(window, async move |this, cx| {
            let work = async move { Ok(suggest_app_record(&cli, &model, &context, date.as_deref(), &request).await) };
            let result = network(work).await;
            this.update_in(cx, |this, _, cx| {
                let Some(chosen) = this.chosen_app().filter(|chosen| chosen.app.pin == pin) else { return };
                chosen.asking = None;
                match result {
                    Ok(Ok(suggestion)) => {
                        chosen.asked = Some(Asked {
                            model: label,
                            answer: suggestion.answer,
                            addition: suggestion.addition.map(|values| Addition {
                                operation_id: uuid::Uuid::new_v4().to_string(),
                                values,
                                save: Save::Proposed,
                            }),
                        })
                    }
                    Ok(Err(problem)) => chosen.problem = Some(problem),
                    Err(_) => chosen.problem = Some("The local CLI stopped.".into()),
                }
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    fn stop_local_assist(&mut self, cx: &mut Context<Self>) {
        if let Some(chosen) = self.chosen_app() {
            chosen.asking = None;
        }
        cx.notify();
    }

    /// Saves the suggested record the person approved, resending the same operation and values
    /// after a failure.
    fn add_suggested(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some((features, space)) = self.app_features() else { return };
        let Some(bot) = self.app_assist().and_then(|assist| assist.bot.clone()) else { return };
        let Some(chosen) = self.chosen_app() else { return };
        let pin = chosen.app.pin.clone();
        let Some(addition) = chosen.asked.as_mut().and_then(|asked| asked.addition.as_mut()) else { return };
        if !matches!(addition.save, Save::Proposed | Save::Failed(_)) {
            return;
        }
        addition.save = Save::Saving;
        let (operation_id, values) = (addition.operation_id.clone(), addition.values.clone());
        let saved_operation = operation_id.clone();
        let work = async move { features.space(space).add_local_app_record(&bot, &pin, &operation_id, &values).await };
        self.call(window, cx, work, move |this, result, window, cx| {
            let Some(chosen) = this.chosen_app() else { return };
            let Some(addition) = chosen
                .asked
                .as_mut()
                .and_then(|asked| asked.addition.as_mut())
                .filter(|addition| addition.operation_id == saved_operation)
            else {
                return;
            };
            match result {
                Ok(_) => {
                    addition.save = Save::Added;
                    this.load_app_context(false, window, cx);
                }
                Err(error) if revoked(&error) => {
                    addition.save = Save::Failed(WITHDRAWN.into())
                }
                Err(error) => addition.save = Save::Failed(api::explain(&error)),
            }
        });
        cx.notify();
    }

    fn skip_suggested(&mut self, cx: &mut Context<Self>) {
        let addition = self.chosen_app().and_then(|chosen| chosen.asked.as_mut()?.addition.as_mut());
        if let Some(addition) = addition.filter(|addition| addition.save != Save::Saving) {
            addition.save = Save::Skipped;
        }
        cx.notify();
    }
}

#[cfg(test)]
mod tests {
    use super::apps_command;

    #[test]
    fn the_apps_command_keeps_what_follows_it() {
        assert_eq!(apps_command("/apps"), Some(""));
        assert_eq!(apps_command("  /Apps  log oatmeal 320 kcal "), Some("log oatmeal 320 kcal"));
        assert_eq!(apps_command("/apps\nwhat did I eat"), Some("what did I eat"));
        assert_eq!(apps_command("/appsx"), None);
        assert_eq!(apps_command("show /apps"), None);
        assert_eq!(apps_command("/app"), None);
    }
}
