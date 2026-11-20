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

/// Runs client work that must finish even when nothing waits for it, such as handing back a
/// computer's control as its screen closes.
pub fn detach<T: Send + 'static>(work: impl Future<Output = Result<T, Error>> + Send + 'static) {
    drop(runtime().spawn(work));
}

pub enum Live<T = ThreadEvent> {
    Event(T),
    /// The stream dropped and is being reopened from the last event seen.
    Reconnecting,
    Connected,
    /// The session was rejected; nothing more arrives.
    Unauthorized,
}

/// Thread or Space updates. Dropping the subscription closes its network stream.
pub struct LiveStream<T> {
    updates: UnboundedReceiver<Live<T>>,
    _cancel: CancelOnDrop,
}

impl<T> LiveStream<T> {
    pub async fn recv(&mut self) -> Option<Live<T>> {
        self.updates.recv().await
    }
}

struct CancelOnDrop(AbortHandle);

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

pub fn follow(client: Client, space_id: String, target: Target, cursor: i64) -> LiveStream<ThreadEvent> {
    reconnect(
        cursor,
        move |cursor| {
            let (client, space_id, target) = (client.clone(), space_id.clone(), target.clone());
            async move { client.subscribe_thread(&space_id, target.wire(), cursor).await }
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
    LiveStream { updates, _cancel: CancelOnDrop(task.abort_handle()) }
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
        assert!(matches!(live.recv().await, Some(Live::Connected)));
        assert!(matches!(live.recv().await, Some(Live::Event(5))));
        assert!(matches!(live.recv().await, Some(Live::Reconnecting)));
        assert!(matches!(live.recv().await, Some(Live::Unauthorized)));
        assert!(live.recv().await.is_none());
    }

    #[tokio::test]
    async fn a_subscription_moved_into_an_async_consumer_lives_until_the_consumer_drops_it() {
        let (event_tx, event_rx) = tokio::sync::oneshot::channel::<u8>();
        let (closed_tx, closed_rx) = tokio::sync::oneshot::channel::<()>();
        let mut source = Some(Box::pin(stream::once(async move { Ok::<_, Error>(event_rx.await.unwrap()) }).chain(
            stream::once(async move {
                let _keep_until_cancelled = closed_tx;
                std::future::pending::<Result<u8, Error>>().await
            }),
        )));
        let consume = {
            let mut subscription = reconnect(0, move |_| std::future::ready(Ok(source.take().unwrap())), |_| None);
            async move {
                assert!(matches!(subscription.recv().await, Some(Live::Connected)));
                assert!(matches!(subscription.recv().await, Some(Live::Event(42))));
            }
        };
        event_tx.send(42).unwrap();
        tokio::time::timeout(Duration::from_secs(5), consume).await.unwrap();
        assert!(tokio::time::timeout(Duration::from_secs(5), closed_rx).await.unwrap().is_err());
    }
}
