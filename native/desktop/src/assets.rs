use std::borrow::Cow;

use gpui_kit::assets::AllAssets;
use gpui_kit::{AssetSource, Result, SharedString};

/// The glyphs drawn for this app, kept beside the Lucide set the component library ships.
const OWN: &[(&str, &[u8])] = &[
    ("icons/corner-search.svg", include_bytes!("../assets/icons/corner-search.svg")),
    ("icons/corner-plus.svg", include_bytes!("../assets/icons/corner-plus.svg")),
    ("icons/apps.svg", include_bytes!("../assets/icons/apps.svg")),
    ("icons/composer-plus.svg", include_bytes!("../assets/icons/composer-plus.svg")),
];

pub struct Assets;

impl AssetSource for Assets {
    fn load(&self, path: &str) -> Result<Option<Cow<'static, [u8]>>> {
        match OWN.iter().find(|(own, _)| *own == path) {
            Some((_, bytes)) => Ok(Some(Cow::Borrowed(*bytes))),
            None => AllAssets.load(path),
        }
    }

    fn list(&self, path: &str) -> Result<Vec<SharedString>> {
        let mut names = AllAssets.list(path)?;
        names.extend(OWN.iter().filter(|(own, _)| own.starts_with(path)).map(|(own, _)| SharedString::from(*own)));
        Ok(names)
    }
}
