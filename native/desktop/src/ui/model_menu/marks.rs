use std::collections::HashMap;
use std::sync::OnceLock;

use gpui_kit::{rgb, Hsla};

/// The web and mobile pickers' table of model makers' marks (Simple Icons, CC0; OpenAI's from
/// T3 Code, MIT), read as written so the desktop draws the same marks.
const SHARED: &str = include_str!("../../../../../packages/core/src/models/model-marks.ts");

pub struct Mark {
    pub maker: String,
    view_box: String,
    path: String,
    even_odd: bool,
    color: Option<u32>,
}

impl Mark {
    /// The maker's brand colour, or none for a mark drawn in the text colour.
    pub fn color(&self) -> Option<Hsla> {
        self.color.map(|color| rgb(color).into())
    }

    pub fn asset(&self) -> String {
        format!("marks/{}.svg", self.maker)
    }
}

struct Table {
    marks: Vec<Mark>,
    makers: HashMap<String, String>,
}

fn block<'a>(source: &'a str, head: &str) -> &'a str {
    let start = source.find(head).map(|at| at + head.len()).unwrap_or(source.len());
    let rest = &source[start..];
    &rest[..rest.find("\n};").unwrap_or(rest.len())]
}

fn quoted(line: &str, key: &str) -> Option<String> {
    let value = line.strip_prefix(key)?.strip_prefix(": \"")?;
    Some(value[..value.find('"')?].to_owned())
}

fn parse(source: &str) -> Table {
    let mut marks: Vec<Mark> = Vec::new();
    for line in block(source, "const MARKS: Record<string, ModelMark> = {").lines().map(str::trim) {
        if let Some(maker) = line.strip_suffix(": {") {
            marks.push(Mark {
                maker: maker.to_owned(),
                view_box: String::new(),
                path: String::new(),
                even_odd: false,
                color: None,
            });
            continue;
        }
        let Some(mark) = marks.last_mut() else { continue };
        if let Some(view_box) = quoted(line, "viewBox") {
            mark.view_box = view_box;
        } else if let Some(path) = quoted(line, "path") {
            mark.path = path;
        } else if let Some(color) = quoted(line, "color") {
            mark.color = color.strip_prefix('#').and_then(|hex| u32::from_str_radix(hex, 16).ok());
        } else if line.starts_with("evenOdd: true") {
            mark.even_odd = true;
        }
    }
    marks.retain(|mark| !mark.view_box.is_empty() && !mark.path.is_empty());
    let makers = block(source, "const MAKERS: Record<string, string> = {")
        .lines()
        .filter_map(|line| {
            let (name, maker) = line.trim().split_once(": \"")?;
            Some((name.to_owned(), maker.split('"').next()?.to_owned()))
        })
        .collect();
    Table { marks, makers }
}

fn table() -> &'static Table {
    static TABLE: OnceLock<Table> = OnceLock::new();
    TABLE.get_or_init(|| parse(SHARED))
}

fn fold(name: &str) -> String {
    name.chars().filter(char::is_ascii_alphanumeric).map(|c| c.to_ascii_lowercase()).collect()
}

/// The mark of the company that made a model, by the rule the web picker uses: its id's router
/// prefix ("anthropic/…"), then its catalog label's ("Anthropic: …"), then the provider.
pub fn model_mark(provider: Option<&str>, model_id: Option<&str>, label: Option<&str>) -> Option<&'static Mark> {
    let table = table();
    let names = [
        model_id.filter(|id| id.contains('/')).and_then(|id| id.split('/').next()),
        label.and_then(|label| label.split_once(": ").map(|(maker, _)| maker)),
        provider,
    ];
    names.into_iter().flatten().find_map(|name| {
        let maker = table.makers.get(&fold(name))?;
        table.marks.iter().find(|mark| &mark.maker == maker)
    })
}

/// The drawing behind a mark's asset path, filled solid: the app tints it as it draws it.
pub fn svg(asset: &str) -> Option<String> {
    let maker = asset.strip_prefix("marks/")?.strip_suffix(".svg")?;
    let mark = table().marks.iter().find(|mark| mark.maker == maker)?;
    let rule = if mark.even_odd { r#" fill-rule="evenodd" clip-rule="evenodd""# } else { "" };
    Some(format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="{}"><path fill="#000"{rule} d="{}"/></svg>"##,
        mark.view_box, mark.path
    ))
}

#[cfg(test)]
mod tests {
    use super::{model_mark, svg, table};

    #[test]
    fn the_shared_table_reads_whole() {
        let makers: Vec<&str> = table().marks.iter().map(|mark| mark.maker.as_str()).collect();
        assert_eq!(
            makers,
            [
                "anthropic",
                "google",
                "meta",
                "mistral",
                "deepseek",
                "xai",
                "qwen",
                "moonshot",
                "minimax",
                "openrouter",
                "openai"
            ]
        );
        let anthropic = model_mark(Some("anthropic"), None, None).unwrap();
        assert_eq!(anthropic.color, Some(0xD97757));
        assert!(model_mark(Some("openai"), None, None).unwrap().even_odd);
        assert!(svg("marks/openai.svg").unwrap().contains(r#"viewBox="100 100 411 411""#));
    }

    #[test]
    fn a_maker_is_named_as_the_web_picker_names_it() {
        let claude = model_mark(Some("anthropic"), None, None).map(|mark| &mark.maker);
        assert_eq!(model_mark(Some("router"), Some("anthropic/claude-x"), None).map(|mark| &mark.maker), claude);
        assert_eq!(model_mark(Some("router"), None, Some("Anthropic: Claude X")).map(|mark| &mark.maker), claude);
        assert_eq!(model_mark(Some("claude"), None, None).map(|mark| &mark.maker), claude);
        assert_eq!(model_mark(Some("openai-codex"), None, None).unwrap().maker, "openai");
        assert_eq!(model_mark(Some("codex"), None, None).unwrap().maker, "openai");
        assert_eq!(model_mark(Some("grok"), None, None).unwrap().maker, "xai");
        assert!(model_mark(Some("my-server"), Some("local-model"), None).is_none());
    }
}
