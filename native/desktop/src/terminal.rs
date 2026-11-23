//! An agent computer's terminal: where its socket is, the frames it takes, the bytes each key
//! sends, and the connection that carries them.

use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;
use url::Url;

use crate::runtime::{spawn_owned, Owned};

/// The web server's screen proxy reads a socket's proof from this subprotocol and strips it
/// before the computer sees the request (`SCREEN_SOCKET_PROTOCOL_PREFIX` in `@rakazo/core`).
const PROOF_PROTOCOL: &str = "rakazo-screen.";
/// The protocol the computer's websockify answers with.
const BINARY_PROTOCOL: &str = "binary";

/// `packages/contracts/src/computers/terminal.ts`: `[kind:u8][length:u32be][payload]`.
const INPUT: u8 = 0;
const RESIZE: u8 = 1;

/// The terminal socket on the signed-in server for a terminal address the server issued: the
/// address's capability, served by the same proxy as the computer's screen. Anything else is
/// refused, so a capability is never sent elsewhere.
pub fn socket_address(server: &Url, issued: &str) -> Option<Url> {
    let issued = Url::parse(issued).ok()?;
    if !matches!(issued.scheme(), "http" | "https") {
        return None;
    }
    let segments: Vec<&str> = issued.path_segments()?.collect();
    let ["novnc", "session", "control", grant, ..] = segments.as_slice() else { return None };
    let (expiry, seal) = grant.split_once('.')?;
    let sealed = |text: &str| text.chars().all(|letter| letter.is_ascii_alphanumeric() || matches!(letter, '-' | '_'));
    if expiry.is_empty() || !expiry.chars().all(|digit| digit.is_ascii_digit()) || seal.is_empty() || !sealed(seal) {
        return None;
    }
    let mut socket = server.clone();
    socket.set_scheme(if server.scheme() == "https" { "wss" } else { "ws" }).ok()?;
    socket.set_path(&format!("/novnc/session/control/{grant}/websockify"));
    socket.set_query(None);
    socket.set_fragment(None);
    Some(socket)
}

fn frame(kind: u8, payload: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(5 + payload.len());
    frame.push(kind);
    frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    frame.extend_from_slice(payload);
    frame
}

pub fn input_frame(bytes: &[u8]) -> Vec<u8> {
    frame(INPUT, bytes)
}

pub fn resize_frame(cols: u16, rows: u16) -> Vec<u8> {
    let clamp = |value: u16| value.clamp(1, 1000);
    let mut payload = clamp(cols).to_be_bytes().to_vec();
    payload.extend_from_slice(&clamp(rows).to_be_bytes());
    frame(RESIZE, &payload)
}

/// One key press as a terminal expects it, from the key's name, the text it types, and the
/// modifiers held. None for a key the shell has no use for.
pub fn key_bytes(key: &str, typed: Option<&str>, control: bool, alt: bool) -> Option<Vec<u8>> {
    let named: Option<&[u8]> = match key {
        "enter" => Some(b"\r"),
        "backspace" => Some(b"\x7f"),
        "tab" => Some(b"\t"),
        "escape" => Some(b"\x1b"),
        "up" => Some(b"\x1b[A"),
        "down" => Some(b"\x1b[B"),
        "right" => Some(b"\x1b[C"),
        "left" => Some(b"\x1b[D"),
        "home" => Some(b"\x1b[H"),
        "end" => Some(b"\x1b[F"),
        "delete" => Some(b"\x1b[3~"),
        "pageup" => Some(b"\x1b[5~"),
        "pagedown" => Some(b"\x1b[6~"),
        _ => None,
    };
    let mut bytes = match named {
        Some(bytes) => bytes.to_vec(),
        None if control => {
            let mut letters = key.chars();
            let letter = letters.next().filter(|_| letters.next().is_none())?.to_ascii_lowercase();
            match letter {
                'a'..='z' => vec![letter as u8 - b'a' + 1],
                '[' => vec![0x1b],
                '\\' => vec![0x1c],
                ']' => vec![0x1d],
                ' ' | '@' => vec![0],
                _ => return None,
            }
        }
        None if key == "space" => b" ".to_vec(),
        None => typed.filter(|text| !text.is_empty())?.as_bytes().to_vec(),
    };
    if alt {
        bytes.insert(0, 0x1b);
    }
    Some(bytes)
}

pub enum Event {
    Opened,
    Output(Vec<u8>),
    /// The socket ended; `Some` when it never opened.
    Closed(Option<String>),
}

/// An open terminal socket. Dropping it closes the socket.
pub struct Connection {
    outgoing: UnboundedSender<Vec<u8>>,
    _task: Owned,
}

impl Connection {
    pub fn send(&self, frame: Vec<u8>) {
        let _ = self.outgoing.send(frame);
    }
}

/// Opens the socket with the proof the server issued for it. The proof and the address are
/// capabilities: they go only into this request, never into a log.
pub fn connect(address: Url, origin: String, proof: String) -> (Connection, UnboundedReceiver<Event>) {
    let (events, received) = unbounded_channel();
    let (outgoing, mut queued) = unbounded_channel::<Vec<u8>>();
    let task = spawn_owned(async move {
        let request = (|| {
            let mut request = address.as_str().into_client_request().ok()?;
            let headers = request.headers_mut();
            headers.insert("origin", HeaderValue::from_str(&origin).ok()?);
            let mut protocols = HeaderValue::from_str(&format!("{BINARY_PROTOCOL}, {PROOF_PROTOCOL}{proof}")).ok()?;
            protocols.set_sensitive(true);
            headers.insert("sec-websocket-protocol", protocols);
            Some(request)
        })();
        let Some(request) = request else {
            let _ = events.send(Event::Closed(Some("The terminal's address isn't valid.".into())));
            return;
        };
        let socket = match tokio_tungstenite::connect_async(request).await {
            Ok((socket, _)) => socket,
            Err(_) => {
                let _ = events.send(Event::Closed(Some("Couldn't connect to the terminal. Try again.".into())));
                return;
            }
        };
        let _ = events.send(Event::Opened);
        let (mut sink, mut stream) = socket.split();
        loop {
            tokio::select! {
                frame = queued.recv() => match frame {
                    Some(frame) => {
                        if sink.send(Message::Binary(frame.into())).await.is_err() {
                            break;
                        }
                    }
                    None => {
                        let _ = sink.close().await;
                        break;
                    }
                },
                message = stream.next() => match message {
                    Some(Ok(Message::Binary(bytes))) => {
                        let _ = events.send(Event::Output(bytes.to_vec()));
                    }
                    Some(Ok(Message::Text(text))) => {
                        let _ = events.send(Event::Output(text.as_bytes().to_vec()));
                    }
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    Some(Ok(_)) => {}
                },
            }
        }
        let _ = events.send(Event::Closed(None));
    });
    (Connection { outgoing, _task: task }, received)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_socket_is_on_the_signed_in_server_under_the_issued_capability() {
        let server = Url::parse("https://superbot.example.test").unwrap();
        let issued =
            "https://web.example.test/novnc/session/control/1900000000.AbC-_9/vnc.html?path=websockify%3Ftoken%3Dx";
        assert_eq!(
            socket_address(&server, issued).unwrap().as_str(),
            "wss://superbot.example.test/novnc/session/control/1900000000.AbC-_9/websockify"
        );
        let local = Url::parse("http://127.0.0.1:5173").unwrap();
        assert_eq!(socket_address(&local, issued).unwrap().scheme(), "ws");
    }

    #[test]
    fn only_a_control_capability_becomes_a_socket() {
        let server = Url::parse("https://superbot.example.test").unwrap();
        for issued in [
            "https://web.example.test/novnc/session/view/1900000000.AbC/vnc.html",
            "https://web.example.test/novnc/session/control/notanumber.AbC/vnc.html",
            "https://web.example.test/novnc/session/control/1900000000./vnc.html",
            "https://web.example.test/novnc/session/control/1900000000.a%2Fb/vnc.html",
            "https://web.example.test/elsewhere/control/1900000000.AbC/vnc.html",
            "javascript:alert(1)",
            "file:///novnc/session/control/1900000000.AbC/vnc.html",
        ] {
            assert!(socket_address(&server, issued).is_none(), "{issued}");
        }
    }

    #[test]
    fn frames_carry_their_kind_and_length() {
        assert_eq!(input_frame(b"ls\r"), [0, 0, 0, 0, 3, b'l', b's', b'\r']);
        assert_eq!(resize_frame(120, 40), [1, 0, 0, 0, 4, 0, 120, 0, 40]);
        assert_eq!(resize_frame(0, 5000), [1, 0, 0, 0, 4, 0, 1, 3, 232]);
    }

    #[test]
    fn keys_become_what_a_shell_reads() {
        assert_eq!(key_bytes("enter", None, false, false).unwrap(), b"\r");
        assert_eq!(key_bytes("backspace", None, false, false).unwrap(), b"\x7f");
        assert_eq!(key_bytes("up", None, false, false).unwrap(), b"\x1b[A");
        assert_eq!(key_bytes("c", Some("c"), true, false).unwrap(), [3]);
        assert_eq!(key_bytes("d", Some("d"), true, false).unwrap(), [4]);
        assert_eq!(key_bytes("a", Some("A"), false, false).unwrap(), b"A");
        assert_eq!(key_bytes("space", Some(" "), false, false).unwrap(), b" ");
        assert_eq!(key_bytes("b", Some("b"), false, true).unwrap(), b"\x1bb");
        assert_eq!(key_bytes("f5", None, false, false), None);
        assert_eq!(key_bytes("shift", None, false, false), None);
    }
}
