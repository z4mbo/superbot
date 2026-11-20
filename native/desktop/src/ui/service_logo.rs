use std::collections::HashMap;
use std::sync::Arc;

use gpui_kit::*;
use superbot_client::Error;

use crate::app::Desktop;
use crate::theme::radius;

/// One logo the web app serves from `apps/web/public/service-logos`, keyed by the source preset id,
/// so both clients draw the same artwork.
struct Logo {
    id: &'static str,
    file: &'static str,
    bytes: &'static [u8],
    /// How much of the tile the artwork fills: a bare mark needs room, a whole icon less.
    fill: f32,
}

macro_rules! logo {
    ($id:literal, $file:literal, $fill:literal) => {
        Logo {
            id: $id,
            file: $file,
            bytes: include_bytes!(concat!("../../../../apps/web/public/service-logos/", $file)),
            fill: $fill,
        }
    };
}

const LOGOS: &[Logo] = &[
    logo!("atlassian", "atlassian.svg", 0.6),
    logo!("executor", "executor.png", 0.8),
    logo!("github", "github.svg", 0.6),
    logo!("gmail", "gmail.svg", 0.6),
    logo!("google-calendar", "google-calendar.svg", 0.6),
    logo!("google-drive", "google-drive.svg", 0.6),
    logo!("linear", "linear.svg", 0.6),
    logo!("notion", "notion.svg", 0.6),
    logo!("slack", "slack.svg", 0.6),
];

const PREFIX: &str = "service-logos/";

/// The logo file an asset path names, for the app's asset source.
pub fn asset(path: &str) -> Option<&'static [u8]> {
    let file = path.strip_prefix(PREFIX)?;
    LOGOS.iter().find(|logo| logo.file == file).map(|logo| logo.bytes)
}

/// The service's logo in its own colours on a white tile, or None when the app has no logo for it.
pub fn tile(id: &str, size: Pixels) -> Option<Div> {
    let logo = LOGOS.iter().find(|logo| logo.id == id)?;
    Some(white_tile(img(SharedString::from(format!("{PREFIX}{}", logo.file))), logo.fill, size))
}

fn white_tile(logo: Img, fill: f32, size: Pixels) -> Div {
    div()
        .size(size)
        .flex_shrink_0()
        .rounded(radius::FIELD)
        .bg(white())
        .flex()
        .items_center()
        .justify_center()
        .child(logo.size(size * fill))
}

/// The largest logo a catalog may name; anything bigger is not a logo.
const LOGO_BYTES: usize = 512 * 1024;

/// Logos catalogs name by address, read once per session. None while reading or when unreadable.
#[derive(Default)]
struct Remote(HashMap<String, Option<Arc<Image>>>);

impl Global for Remote {}

/// The logo a catalog names at `url`, on a white tile. None until it has been read, when it is not
/// an https address, or when what it serves is not an image; the caller draws its own tile then.
pub fn remote_tile(url: Option<&str>, size: Pixels, cx: &mut Context<Desktop>) -> Option<Div> {
    let url = url.filter(|url| url.starts_with("https://"))?;
    if let Some(known) = cx.default_global::<Remote>().0.get(url) {
        return known.clone().map(|image| white_tile(img(ImageSource::Image(image)), 0.8, size));
    }
    cx.default_global::<Remote>().0.insert(url.to_owned(), None);
    let address = url.to_owned();
    cx.spawn(async move |this, cx| {
        let read = crate::runtime::network({
            let address = address.clone();
            async move { read_logo(&address).await }
        })
        .await;
        this.update(cx, |_, cx| {
            if let Ok(image) = read {
                cx.default_global::<Remote>().0.insert(address, Some(Arc::new(image)));
                cx.notify();
            }
        })
        .ok();
    })
    .detach();
    None
}

async fn read_logo(url: &str) -> Result<Image, Error> {
    let unreadable = || Error::Protocol("not a logo");
    let response = reqwest::get(url).await.and_then(reqwest::Response::error_for_status).map_err(Error::Transport)?;
    if response.content_length().is_some_and(|length| length > LOGO_BYTES as u64) {
        return Err(unreadable());
    }
    let bytes = response.bytes().await.map_err(Error::Transport)?;
    if bytes.len() > LOGO_BYTES {
        return Err(unreadable());
    }
    let format = logo_format(&bytes).ok_or_else(unreadable)?;
    Ok(Image::from_bytes(format, bytes.to_vec()))
}

/// What kind of image the bytes are, read from the bytes rather than from the server's word.
fn logo_format(bytes: &[u8]) -> Option<ImageFormat> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some(ImageFormat::Png)
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some(ImageFormat::Jpeg)
    } else if bytes.len() > 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some(ImageFormat::Webp)
    } else if bytes.starts_with(b"GIF8") {
        Some(ImageFormat::Gif)
    } else {
        let head = String::from_utf8_lossy(&bytes[..bytes.len().min(512)]).to_ascii_lowercase();
        (head.trim_start().starts_with('<') && head.contains("<svg")).then_some(ImageFormat::Svg)
    }
}

#[cfg(test)]
mod tests {
    use super::{asset, logo_format, read_logo, LOGOS, LOGO_BYTES};
    use gpui_kit::ImageFormat;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn every_logo_is_served_at_its_file_and_is_an_image() {
        for logo in LOGOS {
            assert_eq!(asset(&format!("service-logos/{}", logo.file)), Some(logo.bytes), "{}", logo.id);
            assert!(logo_format(logo.bytes).is_some(), "{}", logo.id);
        }
        assert_eq!(asset("service-logos/executor.png").map(<[u8]>::len), Some(LOGOS[1].bytes.len()));
        assert_eq!(asset("service-logos/missing.svg"), None);
        assert_eq!(asset("icons/github.svg"), None);
    }

    #[test]
    fn a_logo_is_known_by_its_bytes() {
        assert_eq!(logo_format(b"\x89PNG\r\n\x1a\nrest"), Some(ImageFormat::Png));
        assert_eq!(logo_format(b"RIFF\0\0\0\0WEBPVP8 "), Some(ImageFormat::Webp));
        assert_eq!(logo_format(br#"<?xml version="1.0"?><svg viewBox="0 0 1 1"/>"#), Some(ImageFormat::Svg));
        assert_eq!(logo_format(b"<html><body>Not found</body></html>"), None);
        assert_eq!(logo_format(b"{\"error\":true}"), None);
    }

    /// A synthetic catalog host on loopback answering each path with one canned response.
    async fn catalog_host() -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else { return };
                tokio::spawn(async move {
                    let mut request = vec![0; 2048];
                    let read = stream.read(&mut request).await.unwrap_or(0);
                    let request = String::from_utf8_lossy(&request[..read]).to_string();
                    let path = request.split_whitespace().nth(1).unwrap_or("/").to_owned();
                    let (status, body): (&str, Vec<u8>) = match path.as_str() {
                        "/logo.png" => ("200 OK", LOGOS[1].bytes.to_vec()),
                        "/logo.svg" => ("200 OK", LOGOS[0].bytes.to_vec()),
                        "/page" => ("200 OK", b"<html>sign in</html>".to_vec()),
                        "/huge.png" => ("200 OK", [b"\x89PNG\r\n\x1a\n".as_slice(), &vec![0; LOGO_BYTES]].concat()),
                        _ => ("404 Not Found", Vec::new()),
                    };
                    let head = format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                    let _ = stream.write_all(head.as_bytes()).await;
                    let _ = stream.write_all(&body).await;
                });
            }
        });
        format!("http://{address}")
    }

    #[tokio::test]
    async fn a_catalog_logo_is_read_only_when_it_is_a_small_image() {
        let host = catalog_host().await;
        assert!(read_logo(&format!("{host}/logo.png")).await.is_ok());
        assert!(read_logo(&format!("{host}/logo.svg")).await.is_ok());
        assert!(read_logo(&format!("{host}/page")).await.is_err());
        assert!(read_logo(&format!("{host}/huge.png")).await.is_err());
        assert!(read_logo(&format!("{host}/missing.png")).await.is_err());
    }
}
