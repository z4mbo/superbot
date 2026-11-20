use gpui_kit::*;

use crate::theme::radius;

/// The service logos the web app serves from `apps/web/public/service-logos`, keyed by the
/// source preset id, so both clients draw the same artwork.
const LOGOS: &[(&str, &[u8])] = &[
    ("atlassian", include_bytes!("../../../../apps/web/public/service-logos/atlassian.svg")),
    ("github", include_bytes!("../../../../apps/web/public/service-logos/github.svg")),
    ("gmail", include_bytes!("../../../../apps/web/public/service-logos/gmail.svg")),
    ("google-calendar", include_bytes!("../../../../apps/web/public/service-logos/google-calendar.svg")),
    ("google-drive", include_bytes!("../../../../apps/web/public/service-logos/google-drive.svg")),
    ("linear", include_bytes!("../../../../apps/web/public/service-logos/linear.svg")),
    ("notion", include_bytes!("../../../../apps/web/public/service-logos/notion.svg")),
    ("slack", include_bytes!("../../../../apps/web/public/service-logos/slack.svg")),
];

const PREFIX: &str = "service-logos/";

/// The logo file an asset path names, for the app's asset source.
pub fn asset(path: &str) -> Option<&'static [u8]> {
    let id = path.strip_prefix(PREFIX)?.strip_suffix(".svg")?;
    LOGOS.iter().find(|(own, _)| *own == id).map(|(_, bytes)| *bytes)
}

/// The service's logo in its own colours on a white tile, or None when the app has no logo for it.
pub fn tile(id: &str, size: Pixels) -> Option<Div> {
    LOGOS.iter().any(|(own, _)| *own == id).then(|| {
        div()
            .size(size)
            .flex_shrink_0()
            .rounded(radius::FIELD)
            .bg(white())
            .flex()
            .items_center()
            .justify_center()
            .child(img(SharedString::from(format!("{PREFIX}{id}.svg"))).size(size * 0.6))
    })
}

#[cfg(test)]
mod tests {
    use super::{asset, LOGOS};

    #[test]
    fn every_logo_is_one_coloured_mark_served_at_its_preset_id() {
        for (id, bytes) in LOGOS {
            let svg = std::str::from_utf8(bytes).unwrap();
            assert!(svg.contains(r#"viewBox="0 0 24 24""#) && svg.contains(r##"<path fill="#"##), "{id}");
            assert_eq!(asset(&format!("service-logos/{id}.svg")), Some(*bytes));
        }
        assert_eq!(asset("service-logos/executor.svg"), None);
        assert_eq!(asset("icons/github.svg"), None);
    }
}
