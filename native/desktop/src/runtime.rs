use std::future::Future;
use std::sync::OnceLock;
use std::time::Duration;

use futures_util::{Stream, StreamExt};
use superbot_client::{Client, Error, SpaceNotification, ThreadEvent};
use tokio::runtime::Runtime;
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver};
use tokio::task::AbortHandle;

use crate::api::Target;

fn runtime() -> &'static Runtime {
    static RUNTIME: OnceLock<Runtime> = OnceLock::new();
    RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("the network runtime starts")
    })
}

/// Runs client work on the Tokio runtime its HTTP stack requires. The returned future can be
/// awaited from the interface's own executor.
pub async fn network<T: Send + 'static>(
    work: impl Future<Output = Result<T, Error>> + Send + 'static,
) -> Result<T, Error> {
    let task = runtime().spawn(work);
    let _cancel = CancelOnDrop(task.abort_handle());
    match task.await {
        Ok(result) => result,
        Err(_) => Err(Error::Protocol("the network task stopped")),
    }
}

pub enum Live<T = ThreadEvent> {
    Event(T),
    /// The stream dropped and is being reopened from the last event seen.
    Reconnecting,
    Connected,
    /// The session was rejected; nothing more arrives.
    Unauthorized,
}

/// A thread's live events. Dropping it closes the stream.
pub struct LiveStream<T> {
    pub updates: UnboundedReceiver<Live<T>>,
    _cancel: CancelOnDrop,
}

struct CancelOnDrop(AbortHandle);

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

pub fn follow(
    client: Client,
    space_id: String,
    target: Target,
    cursor: i64,
) -> LiveStream<ThreadEvent> {
    reconnect(
        cursor,
        move |cursor| {
            let (client, space_id, target) = (client.clone(), space_id.clone(), target.clone());
            async move {
                client
                    .subscribe_thread(&space_id, target.wire(), cursor)
                    .await
            }
        },
        |event| (event.kind != "heartbeat").then_some(event.seq),
    )
}

pub fn follow_space(client: Client, space_id: String) -> LiveStream<SpaceNotification> {
    reconnect(
        0,
        move |_| {
            let (client, space_id) = (client.clone(), space_id.clone());
            async move { client.subscribe_notifications(&space_id).await }
        },
        |_| None,
    )
}

fn reconnect<T, S, F>(
    mut cursor: i64,
    mut subscribe: impl FnMut(i64) -> F + Send + 'static,
    sequence: impl Fn(&T) -> Option<i64> + Send + 'static,
) -> LiveStream<T>
where
    T: Send + 'static,
    S: Stream<Item = Result<T, Error>> + Unpin + Send + 'static,
    F: Future<Output = Result<S, Error>> + Send,
{
    let (sender, updates) = unbounded_channel();
    let task = runtime().spawn(async move {
        let mut delay = Duration::from_secs(1);
        loop {
            match subscribe(cursor).await {
                Ok(mut events) => {
                    delay = Duration::from_secs(1);
                    if sender.send(Live::Connected).is_err() {
                        return;
                    }
                    while let Some(event) = events.next().await {
                        match event {
                            Ok(event) => {
                                if let Some(seq) = sequence(&event) {
                                    if seq <= cursor {
                                        continue;
                                    }
                                    cursor = seq;
                                }
                                if sender.send(Live::Event(event)).is_err() {
                                    return;
                                }
                            }
                            Err(error) if error.is_unauthorized() => {
                                let _ = sender.send(Live::Unauthorized);
                                return;
                            }
                            Err(_) => break,
                        }
                    }
                }
                Err(error) if error.is_unauthorized() => {
                    let _ = sender.send(Live::Unauthorized);
                    return;
                }
                Err(_) => {}
            }
            if sender.send(Live::Reconnecting).is_err() {
                return;
            }
            tokio::time::sleep(delay).await;
            delay = (delay * 2).min(Duration::from_secs(15));
        }
    });
    LiveStream {
        updates,
        _cancel: CancelOnDrop(task.abort_handle()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::stream;

    #[tokio::test]
    async fn reconnect_ignores_old_sequences_and_stops_when_the_session_ends() {
        let mut first = true;
        let mut live = reconnect(
            4,
            move |cursor| {
                let next = if std::mem::take(&mut first) {
                    assert_eq!(cursor, 4);
                    Ok(stream::iter([Ok(3), Ok(4), Ok(5), Ok(5)]))
                } else {
                    assert_eq!(cursor, 5);
                    Err(Error::MissingSession)
                };
                std::future::ready(next)
            },
            |seq| Some(*seq),
        );
        assert!(matches!(live.updates.recv().await, Some(Live::Connected)));
        assert!(matches!(live.updates.recv().await, Some(Live::Event(5))));
        assert!(matches!(
            live.updates.recv().await,
            Some(Live::Reconnecting)
        ));
        assert!(matches!(
            live.updates.recv().await,
            Some(Live::Unauthorized)
        ));
        assert!(live.updates.recv().await.is_none());
    }
}
