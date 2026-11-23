//! A signed-in session's control of each agent's computer, shared by every view that needs it:
//! the screen, the terminal and an upload.
//!
//! The server answers a second take by the same person with the same lease, so a hand-back from
//! a view that just closed would end control a newer view holds. Views therefore hold control
//! through one registry per Space and agent: a view counts as a holder from the moment it asks,
//! takes and hand-backs for an agent run one at a time in the order they reach its gate, and the
//! lease goes back to the server only when no view holds it.
//!
//! The registry belongs to one signed-in session (`api::Api`), so another account, server or
//! sign-in never shares its holders or leases. A view keeps its own slot and server, so its
//! hand-back still reaches its own session after that session has ended.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex};

use superbot_features::{Error, Features};

use crate::runtime::detach;

/// The two calls control needs from the server.
pub trait ControlServer: Clone + Send + Sync + 'static {
    fn take(&self, agent: String) -> impl Future<Output = Result<String, Error>> + Send + 'static;
    fn release(&self, agent: String, lease: String) -> impl Future<Output = Result<(), Error>> + Send + 'static;
}

/// The signed-in server, for one Space.
#[derive(Clone)]
pub struct Space {
    features: Features,
    id: String,
}

impl ControlServer for Space {
    fn take(&self, agent: String) -> impl Future<Output = Result<String, Error>> + Send + 'static {
        let (features, space) = (self.features.clone(), self.id.clone());
        async move { Ok(features.space(space).take_computer_control(&agent).await?.lease_id) }
    }

    fn release(&self, agent: String, lease: String) -> impl Future<Output = Result<(), Error>> + Send + 'static {
        let (features, space) = (self.features.clone(), self.id.clone());
        async move { features.space(space).release_computer_control(&agent, &lease).await }
    }
}

#[derive(Default)]
struct Held {
    holders: usize,
    lease: Option<String>,
}

#[derive(Default)]
struct Slot {
    held: Mutex<Held>,
    gate: tokio::sync::Mutex<()>,
}

impl Slot {
    fn held(&self) -> std::sync::MutexGuard<'_, Held> {
        self.held.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// One signed-in session's registry. Its clones share it; a new session starts its own.
pub struct Controls<S = Space> {
    slots: Arc<Mutex<HashMap<(String, String), Arc<Slot>>>>,
    _server: std::marker::PhantomData<fn() -> S>,
}

impl<S: ControlServer> Default for Controls<S> {
    fn default() -> Self {
        Self { slots: Arc::default(), _server: std::marker::PhantomData }
    }
}

impl<S> Clone for Controls<S> {
    fn clone(&self) -> Self {
        Self { slots: self.slots.clone(), _server: std::marker::PhantomData }
    }
}

impl<S: ControlServer> Controls<S> {
    fn slot(&self, space: &str, agent: &str) -> Arc<Slot> {
        let mut slots = self.slots.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        slots.entry((space.to_owned(), agent.to_owned())).or_default().clone()
    }

    /// Takes control for one more view. The view counts as a holder from this call, before the
    /// returned future runs, so a hand-back already on its way leaves the lease in place for it.
    /// The take itself runs to the end even when the caller stops waiting; the lease then goes
    /// back unless another view holds it.
    pub fn acquire(
        &self,
        server: S,
        space: &str,
        agent: &str,
    ) -> impl Future<Output = Result<Control<S>, Error>> + Send + 'static {
        let slot = self.slot(space, agent);
        slot.held().holders += 1;
        let pending = Control { slot: Some(slot.clone()), server: server.clone(), agent: agent.to_owned() };
        let agent = agent.to_owned();
        async move {
            let take = tokio::spawn(async move {
                let _turn = slot.gate.lock().await;
                let lease = server.take(agent).await?;
                slot.held().lease = Some(lease);
                Ok(())
            });
            match take.await {
                Ok(Ok(())) => Ok(pending),
                Ok(Err(error)) => Err(error),
                Err(_) => Err(Error::Protocol("the control request stopped")),
            }
        }
    }
}

/// One view's hold on an agent's computer. Dropping it hands control back once no other view
/// holds it; `release` does the same and waits for the server.
pub struct Control<S: ControlServer> {
    slot: Option<Arc<Slot>>,
    server: S,
    agent: String,
}

impl<S: ControlServer> Control<S> {
    pub async fn release(mut self) -> Result<(), Error> {
        let Some(slot) = self.slot.take() else { return Ok(()) };
        hand_back(slot, self.server.clone(), self.agent.clone()).await
    }
}

impl<S: ControlServer> Drop for Control<S> {
    fn drop(&mut self) {
        if let Some(slot) = self.slot.take() {
            detach(hand_back(slot, self.server.clone(), self.agent.clone()));
        }
    }
}

/// Counts one holder out at once, then hands the lease back in the agent's turn if nobody holds
/// it by then.
fn hand_back<S: ControlServer>(
    slot: Arc<Slot>,
    server: S,
    agent: String,
) -> impl Future<Output = Result<(), Error>> + Send + 'static {
    {
        let mut held = slot.held();
        held.holders = held.holders.saturating_sub(1);
    }
    async move {
        let _turn = slot.gate.lock().await;
        let lease = {
            let mut held = slot.held();
            if held.holders > 0 {
                return Ok(());
            }
            held.lease.take()
        };
        match lease {
            Some(lease) => server.release(agent, lease).await,
            None => Ok(()),
        }
    }
}

/// A view's control of the signed-in server's computers.
pub type ControlLease = Control<Space>;

impl ControlLease {
    /// Takes control through the registry of the session `controls` belongs to.
    pub fn acquire(
        controls: &Controls,
        owner: (Features, String),
        agent: String,
    ) -> impl Future<Output = Result<Self, Error>> + Send + 'static {
        let (features, id) = owner;
        let space = id.clone();
        controls.acquire(Space { features, id }, &space, &agent)
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::future::Future;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use superbot_features::Error;
    use tokio::sync::{mpsc, oneshot};

    use super::{ControlServer, Controls};

    /// Answers as the server does: the person holding control gets the same lease back.
    #[derive(Clone, Default)]
    struct FakeServer {
        state: Arc<Mutex<FakeState>>,
    }

    #[derive(Default)]
    struct FakeState {
        held: Option<String>,
        issued: u32,
        calls: Vec<String>,
        /// Each holds the next call of that kind until the test lets it go.
        take_gates: VecDeque<oneshot::Receiver<()>>,
        release_gates: VecDeque<oneshot::Receiver<()>>,
        started: Option<mpsc::UnboundedSender<String>>,
        failing_takes: u32,
    }

    impl FakeServer {
        fn state(&self) -> std::sync::MutexGuard<'_, FakeState> {
            self.state.lock().unwrap()
        }

        fn hold_next_take(&self) -> oneshot::Sender<()> {
            let (open, gate) = oneshot::channel();
            self.state().take_gates.push_back(gate);
            open
        }

        fn hold_next_release(&self) -> oneshot::Sender<()> {
            let (open, gate) = oneshot::channel();
            self.state().release_gates.push_back(gate);
            open
        }

        fn watch(&self) -> mpsc::UnboundedReceiver<String> {
            let (started, watched) = mpsc::unbounded_channel();
            self.state().started = Some(started);
            watched
        }

        fn calls(&self) -> Vec<String> {
            self.state().calls.clone()
        }

        fn held(&self) -> Option<String> {
            self.state().held.clone()
        }
    }

    impl ControlServer for FakeServer {
        fn take(&self, _agent: String) -> impl Future<Output = Result<String, Error>> + Send + 'static {
            let state = self.state.clone();
            async move {
                let gate = {
                    let mut state = state.lock().unwrap();
                    state.calls.push("take".into());
                    if let Some(started) = &state.started {
                        let _ = started.send("take".into());
                    }
                    state.take_gates.pop_front()
                };
                if let Some(gate) = gate {
                    let _ = gate.await;
                }
                let mut state = state.lock().unwrap();
                if state.failing_takes > 0 {
                    state.failing_takes -= 1;
                    return Err(Error::Protocol("take refused"));
                }
                if state.held.is_none() {
                    state.issued += 1;
                    state.held = Some(format!("lease-{}", state.issued));
                }
                Ok(state.held.clone().unwrap())
            }
        }

        fn release(&self, _agent: String, lease: String) -> impl Future<Output = Result<(), Error>> + Send + 'static {
            let state = self.state.clone();
            async move {
                let gate = {
                    let mut state = state.lock().unwrap();
                    state.calls.push(format!("release {lease}"));
                    if let Some(started) = &state.started {
                        let _ = started.send(format!("release {lease}"));
                    }
                    state.release_gates.pop_front()
                };
                if let Some(gate) = gate {
                    let _ = gate.await;
                }
                let mut state = state.lock().unwrap();
                if state.held.as_deref() == Some(lease.as_str()) {
                    state.held = None;
                }
                Ok(())
            }
        }
    }

    /// Waits for every hand-back already queued for the agent to finish.
    async fn settled(controls: &Controls<FakeServer>) {
        drop(controls.slot("space", "bot").gate.lock().await);
    }

    async fn within<T>(work: impl Future<Output = T>) -> T {
        tokio::time::timeout(Duration::from_secs(5), work).await.expect("the step finished")
    }

    #[tokio::test]
    async fn a_view_opened_while_the_last_hand_back_waits_keeps_control() {
        let (controls, server) = (Controls::default(), FakeServer::default());
        let first = within(controls.acquire(server.clone(), "space", "bot")).await.unwrap();
        assert_eq!(server.held().as_deref(), Some("lease-1"));

        let slot = controls.slot("space", "bot");
        let turn = slot.gate.lock().await;
        drop(first);
        let second = controls.acquire(server.clone(), "space", "bot");
        drop(turn);
        let second = within(second).await.unwrap();
        settled(&controls).await;

        assert_eq!(server.calls(), ["take", "take"]);
        assert_eq!(server.held().as_deref(), Some("lease-1"));
        let mut started = server.watch();
        drop(second);
        assert_eq!(within(started.recv()).await.as_deref(), Some("release lease-1"));
        settled(&controls).await;
        assert_eq!(server.held(), None);
    }

    #[tokio::test]
    async fn a_hand_back_already_at_the_server_finishes_before_the_next_take() {
        let (controls, server) = (Controls::default(), FakeServer::default());
        let mut started = server.watch();
        let first = within(controls.acquire(server.clone(), "space", "bot")).await.unwrap();
        assert_eq!(within(started.recv()).await.as_deref(), Some("take"));

        let release = server.hold_next_release();
        drop(first);
        assert_eq!(within(started.recv()).await.as_deref(), Some("release lease-1"));
        let second = controls.acquire(server.clone(), "space", "bot");
        release.send(()).unwrap();
        let second = within(second).await.unwrap();

        assert_eq!(server.calls(), ["take", "release lease-1", "take"]);
        assert_eq!(server.held().as_deref(), Some("lease-2"));
        within(second.release()).await.unwrap();
        assert_eq!(server.held(), None);
    }

    #[tokio::test]
    async fn a_take_nobody_waits_for_any_more_is_handed_back() {
        let (controls, server) = (Controls::default(), FakeServer::default());
        let mut started = server.watch();
        let take = server.hold_next_take();
        let abandoned = tokio::spawn(controls.acquire(server.clone(), "space", "bot"));
        assert_eq!(within(started.recv()).await.as_deref(), Some("take"));
        abandoned.abort();
        assert!(matches!(abandoned.await, Err(error) if error.is_cancelled()));

        take.send(()).unwrap();
        assert_eq!(within(started.recv()).await.as_deref(), Some("release lease-1"));
        settled(&controls).await;
        assert_eq!(server.held(), None);
    }

    #[tokio::test]
    async fn handing_back_one_view_leaves_control_with_the_other() {
        let (controls, server) = (Controls::default(), FakeServer::default());
        let screen = within(controls.acquire(server.clone(), "space", "bot")).await.unwrap();
        let upload = within(controls.acquire(server.clone(), "space", "bot")).await.unwrap();
        within(screen.release()).await.unwrap();
        assert_eq!(server.held().as_deref(), Some("lease-1"));
        within(upload.release()).await.unwrap();
        assert_eq!(server.calls(), ["take", "take", "release lease-1"]);
        assert_eq!(server.held(), None);
    }

    #[tokio::test]
    async fn a_refused_take_leaves_nothing_held() {
        let (controls, server) = (Controls::default(), FakeServer::default());
        server.state().failing_takes = 1;
        assert!(within(controls.acquire(server.clone(), "space", "bot")).await.is_err());
        settled(&controls).await;
        assert_eq!(controls.slot("space", "bot").held().holders, 0);
        let retried = within(controls.acquire(server.clone(), "space", "bot")).await.unwrap();
        assert_eq!(server.held().as_deref(), Some("lease-1"));
        within(retried.release()).await.unwrap();
        assert_eq!(server.calls(), ["take", "take", "release lease-1"]);
    }

    /// Two signed-in sessions, each with its own server, both showing Space `space` and agent `bot`.
    #[tokio::test]
    async fn a_late_hand_back_reaches_only_its_own_session() {
        let (first, first_server) = (Controls::default(), FakeServer::default());
        let (second, second_server) = (Controls::default(), FakeServer::default());
        let mut started = first_server.watch();
        let held = within(first.acquire(first_server.clone(), "space", "bot")).await.unwrap();
        assert_eq!(within(started.recv()).await.as_deref(), Some("take"));

        let release = first_server.hold_next_release();
        drop(held);
        assert_eq!(within(started.recv()).await.as_deref(), Some("release lease-1"));
        // The first session's hand-back is still at its server; the second session's take does
        // not wait for it, and is not counted against it.
        let other = within(second.acquire(second_server.clone(), "space", "bot")).await.unwrap();
        assert_eq!(second_server.held().as_deref(), Some("lease-1"));
        assert_eq!(first.slot("space", "bot").held().holders, 0);
        assert_eq!(second.slot("space", "bot").held().holders, 1);

        release.send(()).unwrap();
        settled(&first).await;
        assert_eq!(first_server.calls(), ["take", "release lease-1"]);
        assert_eq!(first_server.held(), None);
        assert_eq!(second_server.calls(), ["take"]);
        assert_eq!(second_server.held().as_deref(), Some("lease-1"));
        within(other.release()).await.unwrap();
        assert_eq!(second_server.held(), None);
    }

    #[tokio::test]
    async fn a_view_outliving_its_session_hands_back_to_that_session() {
        let (ended_server, next_server) = (FakeServer::default(), FakeServer::default());
        let ended = Controls::default();
        let view = within(ended.acquire(ended_server.clone(), "space", "bot")).await.unwrap();
        drop(ended);

        let next = Controls::default();
        let current = within(next.acquire(next_server.clone(), "space", "bot")).await.unwrap();
        within(view.release()).await.unwrap();
        assert_eq!(ended_server.calls(), ["take", "release lease-1"]);
        assert_eq!(ended_server.held(), None);
        assert_eq!(next_server.calls(), ["take"]);
        assert_eq!(next_server.held().as_deref(), Some("lease-1"));
        within(current.release()).await.unwrap();
    }
}
