use gpui_kit::component::input::{InputEvent, InputState};
use gpui_kit::*;
use serde::Deserialize;
use serde_json::json;

use super::{Desktop, Panel};
use crate::api::{self, Target};

#[derive(Clone, Debug, Deserialize)]
pub struct TemplateSkill {
    pub name: String,
    pub description: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct TemplateRoutine {
    pub name: String,
}

/// One reviewed, ready-made bot the server offers (`bots.templates`).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Template {
    pub id: String,
    pub version: u64,
    pub name: String,
    pub summary: String,
    #[serde(default)]
    pub sample: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub skills: Vec<TemplateSkill>,
    #[serde(default)]
    pub routines: Vec<TemplateRoutine>,
    #[serde(default)]
    pub apps: Vec<String>,
    /// The bot an earlier create made, while it exists.
    #[serde(default)]
    pub bot_id: Option<String>,
    /// `apps` as the connections catalog names them; an app the catalog lacks is not shown.
    #[serde(skip)]
    pub app_names: Vec<String>,
}

/// One entry of `connections.catalog`.
#[derive(Clone, Debug, Deserialize)]
pub struct CatalogApp {
    pub slug: String,
    pub name: String,
    #[serde(default)]
    pub connected: bool,
}

/// The catalog entry for a template's app slug, preferring one that is connected, by slug or
/// name as the server's clients match it.
pub fn catalog_name<'a>(catalog: &'a [CatalogApp], app: &str) -> Option<&'a str> {
    let query = app.trim().to_lowercase();
    let matches = |entry: &&CatalogApp| entry.slug.to_lowercase() == query || entry.name.to_lowercase() == query;
    catalog
        .iter()
        .filter(|entry| entry.connected)
        .find(matches)
        .or_else(|| catalog.iter().find(matches))
        .map(|entry| entry.name.as_str())
}

impl Template {
    fn name_apps(&mut self, catalog: &[CatalogApp]) {
        self.app_names = self.apps.iter().filter_map(|app| catalog_name(catalog, app).map(str::to_owned)).collect();
    }

    pub fn matches(&self, query: &str) -> bool {
        let query = query.trim().to_lowercase();
        query.is_empty()
            || [&self.name, &self.summary, &self.description].iter().any(|text| text.to_lowercase().contains(&query))
    }

    /// The quiet line under a card: the apps it works with and whether a routine comes with it.
    pub fn footnote(&self) -> Option<String> {
        let mut parts = Vec::new();
        if !self.app_names.is_empty() {
            parts.push(format!("Works with {}", self.app_names.join(", ")));
        }
        if !self.routines.is_empty() {
            parts.push("Includes a paused routine".to_owned());
        }
        (!parts.is_empty()).then(|| parts.join(" · "))
    }
}

pub struct Review {
    pub template: Template,
    pub name: Entity<InputState>,
    _submit: Subscription,
}

pub struct Templates {
    pub search: Entity<InputState>,
    /// `None` while the list loads.
    pub listing: Option<Result<Vec<Template>, String>>,
    pub review: Option<Review>,
    pub busy: bool,
    pub error: Option<String>,
    _search: Subscription,
}

#[derive(Deserialize)]
struct Created {
    bot: Made,
}

#[derive(Deserialize)]
struct Made {
    id: String,
}

impl Desktop {
    pub fn open_templates(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let search = cx.new(|cx| InputState::new(window, cx).placeholder("Search templates"));
        let watch = cx.observe(&search, |_, _, cx| cx.notify());
        self.begin_modal(window, cx);
        search.update(cx, |input, cx| input.focus(window, cx));
        self.create.panel = Some(Panel::Templates(Templates {
            search,
            listing: None,
            review: None,
            busy: false,
            error: None,
            _search: watch,
        }));
        self.load_templates(window, cx);
        cx.notify();
    }

    pub fn load_templates(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(api), Some(space_id)) = (self.api.clone(), self.space_id()) else { return };
        if let Some(Panel::Templates(templates)) = self.create.panel.as_mut() {
            templates.listing = None;
        }
        let work = async move {
            let mut listing: Vec<Template> = api.client.rpc("bots/templates", Some(&space_id), json!({})).await?;
            if listing.iter().any(|template| !template.apps.is_empty()) {
                // Without the catalog no app has a name to show, so the list shows none, as on the web.
                let catalog: Vec<CatalogApp> =
                    api.client.rpc("connections/catalog", Some(&space_id), json!({})).await.unwrap_or_default();
                listing.iter_mut().for_each(|template| template.name_apps(&catalog));
            }
            Ok(listing)
        };
        self.call(window, cx, work, |this, result, _, _| {
            if let Some(Panel::Templates(templates)) = this.create.panel.as_mut() {
                templates.listing = Some(result.map_err(|error| api::explain(&error)));
            }
        });
    }

    /// Add on a card: a template already made opens its bot; any other opens its review.
    pub fn pick_template(&mut self, template: Template, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(bot_id) = template.bot_id.clone().filter(|id| self.agent(id).is_some()) {
            self.create.panel = None;
            self.open(Target::Agent(bot_id), window, cx);
            cx.notify();
            return;
        }
        let Some(Panel::Templates(templates)) = self.create.panel.as_mut() else { return };
        if templates.busy {
            return;
        }
        let name = cx.new(|cx| InputState::new(window, cx).default_value(template.name.clone()));
        let submit = cx.subscribe_in(&name, window, |this, _, event: &InputEvent, window, cx| {
            if let InputEvent::PressEnter { .. } = event {
                this.add_template(window, cx);
            }
        });
        name.update(cx, |input, cx| input.focus(window, cx));
        templates.error = None;
        templates.review = Some(Review { template, name, _submit: submit });
        cx.notify();
    }

    pub fn back_to_templates(&mut self, cx: &mut Context<Self>) {
        if let Some(Panel::Templates(templates)) = self.create.panel.as_mut().filter(|panel| !panel.busy()) {
            templates.review = None;
            templates.error = None;
            cx.notify();
        }
    }

    pub fn add_template(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(api), Some(space_id)) = (self.api.clone(), self.space_id()) else { return };
        let Some(Panel::Templates(templates)) = self.create.panel.as_mut() else { return };
        let Some(review) = templates.review.as_ref().filter(|_| !templates.busy) else { return };
        let name = review.name.read(cx).value().trim().to_owned();
        let input = json!({ "templateId": review.template.id, "version": review.template.version, "name": name });
        if name.is_empty() {
            templates.error = Some("Enter a name.".into());
            cx.notify();
            return;
        }
        templates.busy = true;
        templates.error = None;
        let space = space_id.clone();
        let work = async move {
            let created: Created = api.client.rpc("bots/createFromTemplate", Some(&space), input).await?;
            Ok((created.bot.id, api.navigation(Some(&space)).await?))
        };
        self.call(window, cx, work, move |this, result, window, cx| match result {
            Ok((bot_id, navigation)) => {
                this.create.panel = None;
                this.apply_navigation(navigation);
                this.arrived(&space_id, &bot_id);
                this.open(Target::Agent(bot_id), window, cx);
            }
            Err(error) => {
                if let Some(Panel::Templates(templates)) = this.create.panel.as_mut() {
                    templates.busy = false;
                    templates.error = Some(api::explain(&error));
                }
            }
        });
        cx.notify();
    }
}

#[cfg(test)]
mod tests {
    use super::{catalog_name, CatalogApp, Template};

    fn template() -> Template {
        serde_json::from_value(serde_json::json!({
            "id": "inbox-helper", "version": 3, "name": "Inbox helper", "summary": "Sorts mail",
            "sample": "**Today**", "description": "Reads and drafts.", "instructions": "Be brief.",
            "skills": [{ "name": "Triage", "description": "Sorts", "body": "…" }],
            "routines": [{ "name": "Morning", "prompt": "Sort", "crons": ["0 8 * * *"] }],
            "apps": ["mail", "calendar"], "botId": null
        }))
        .unwrap()
    }

    #[test]
    fn a_listing_reads_the_servers_template_shape() {
        let template = template();
        assert_eq!(template.version, 3);
        assert_eq!(template.skills[0].name, "Triage");
        assert!(template.bot_id.is_none());
    }

    #[test]
    fn search_matches_name_summary_and_description() {
        let template = template();
        assert!(template.matches(""));
        assert!(template.matches("INBOX"));
        assert!(template.matches("sorts"));
        assert!(template.matches("drafts"));
        assert!(!template.matches("invoices"));
    }

    #[test]
    fn the_footnote_names_catalog_apps_and_a_paused_routine() {
        let catalog: Vec<CatalogApp> = serde_json::from_value(serde_json::json!([
            { "slug": "MAIL", "name": "Mail", "connected": false },
            { "slug": "other", "name": "Mail", "connected": true }
        ]))
        .unwrap();
        assert_eq!(catalog_name(&catalog, "mail"), Some("Mail"));
        let mut template = template();
        template.name_apps(&catalog);
        assert_eq!(template.app_names, ["Mail"]);
        assert_eq!(template.footnote().as_deref(), Some("Works with Mail · Includes a paused routine"));
        template.routines.clear();
        template.app_names.clear();
        assert_eq!(template.footnote(), None);
    }
}
