use std::time::Duration;

use futures_util::StreamExt as _;
use superbot_client::Error;
use tokio::sync::mpsc::UnboundedSender;

use crate::remote::Remote;

/// What the board stream tells the view.
pub(crate) enum Live {
    /// The stream (re)opened: anything missed while it was closed is read now.
    Connected,
    /// A ticket changed, here or elsewhere; read the board again.
    Changed { ticket_id: Option<String> },
    /// The server refused the stream; it is not retried.
    Refused(Error),
}

const FIRST_RETRY: Duration = Duration::from_secs(1);
const LONGEST_RETRY: Duration = Duration::from_secs(30);

/// Follows `boards/subscribe` until `signals` is dropped, reconnecting after drops with a
/// growing delay. Heartbeats are not passed on: they carry no change.
pub(crate) async fn follow(remote: Remote, signals: UnboundedSender<Live>) -> Result<(), Error> {
    let mut delay = FIRST_RETRY;
    while !signals.is_closed() {
        match remote.space().subscribe_board().await {
            Ok(mut stream) => {
                delay = FIRST_RETRY;
                if signals.send(Live::Connected).is_err() {
                    break;
                }
                while let Some(event) = stream.next().await {
                    let delivered = match event {
                        Ok(change) if change.is_heartbeat() => !signals.is_closed(),
                        Ok(change) => signals
                            .send(Live::Changed {
                                ticket_id: change.ticket_id,
                            })
                            .is_ok(),
                        Err(_) => break,
                    };
                    if !delivered {
                        return Ok(());
                    }
                }
            }
            Err(error) if !retryable(&error) => {
                let _ = signals.send(Live::Refused(error));
                break;
            }
            Err(_) => {}
        }
        tokio::time::sleep(delay).await;
        delay = (delay * 2).min(LONGEST_RETRY);
    }
    Ok(())
}

fn retryable(error: &Error) -> bool {
    match error {
        Error::Transport(_) | Error::Protocol(_) => true,
        Error::Server { status, .. } => *status == 429 || *status >= 500,
        _ => false,
    }
}
