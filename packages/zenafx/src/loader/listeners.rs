//! A component's listeners, as the streams their events arrive on.
//!
//! `node.listen-pointer` adds a listener and returns a `stream<delivery>`.
//! The component reads the listener's events from the stream, and drops the
//! stream to remove the listener. Here is the host's end of each stream. [`Listeners`] holds a channel per
//! listener, by the id the scene knows the listener by, and
//! [`ListenerStream`] is what wasmtime polls when the component reads.
//!
//! A `down`, `up` or `move` carries a `reply`, the resource a listener
//! answers with. The host learns the answer when the component drops the
//! reply, and that is the moment the event may be offered to the next
//! listener on its path.
//!
//! The component reading its stream again is not taken as an answer. A
//! stream is read ahead: the read for the next event is under way before the
//! handler for this one has run, so it says nothing about the handler.

use std::collections::HashMap;
use std::pin::Pin;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};

use tokio::sync::{mpsc, oneshot};
use wasmtime::StoreContextMut;
use wasmtime::component::{
    ComponentType, Destination, Lift, Lower, Resource, StreamProducer, StreamResult,
};

use super::link::UiHostState;
use crate::ui::events::PointerEvent;
use crate::ui::scene::Scene;

/// What a `reply` handle names. Its representation is a key into
/// [`Replies`].
pub struct HostReply;

/// What a listener answered an event with, by the time it dropped the reply.
#[derive(Copy, Clone, Debug, Default, PartialEq, Eq)]
pub struct Answer {
    /// No listener after this one is offered the event.
    pub stop_propagation: bool,
    /// The pointer is captured for the listener's node until the button
    /// comes up.
    pub capture: bool,
}

/// One event on its way to one listener.
pub struct Offered {
    pub event: PointerEvent,
    /// Where the listener's answer goes. `None` for an event nothing can
    /// stop, which then carries no reply.
    pub answered: Option<oneshot::Sender<Answer>>,
}

/// `delivery` in `zenafx:host/events`: what a listener's stream carries.
#[derive(ComponentType, Lift, Lower)]
#[component(record)]
pub struct DeliveryRecord {
    event: PointerEvent,
    reply: Option<Resource<HostReply>>,
}

/// The replies components hold and have not answered with yet.
///
/// In the store's data, since only a host function or a stream being read
/// touches it and both have the store.
#[derive(Default)]
pub struct Replies {
    waiting: HashMap<u32, Waiting>,
    last: u32,
}

struct Waiting {
    answer: Answer,
    answered: oneshot::Sender<Answer>,
}

impl Replies {
    /// A new reply whose answer goes to `answered`.
    fn open(&mut self, answered: oneshot::Sender<Answer>) -> u32 {
        self.last += 1;
        self.waiting.insert(
            self.last,
            Waiting {
                answer: Answer::default(),
                answered,
            },
        );
        self.last
    }

    /// `reply.stop-propagation`: the answer, once given, is that no later
    /// listener is offered the event.
    pub fn stop_propagation(&mut self, reply: u32) {
        if let Some(waiting) = self.waiting.get_mut(&reply) {
            waiting.answer.stop_propagation = true;
        }
    }

    /// `reply.capture`: the answer, once given, is that the listener keeps
    /// the pointer.
    pub fn capture(&mut self, reply: u32) {
        if let Some(waiting) = self.waiting.get_mut(&reply) {
            waiting.answer.capture = true;
        }
    }

    /// Give the answer, which is what dropping the reply does.
    pub fn answer(&mut self, reply: u32) {
        if let Some(waiting) = self.waiting.remove(&reply) {
            // Nobody may be waiting any more: the delivery ended with the
            // component's thread.
            let _ = waiting.answered.send(waiting.answer);
        }
    }
}

/// The sending end of every listener's stream.
///
/// Shared by the three places that need it. A host function adds a listener
/// and ends the ones whose nodes went away, the component's thread offers
/// events, and a stream removes itself when the component drops it.
#[derive(Clone, Default)]
pub struct Listeners {
    streams: Arc<Mutex<HashMap<u32, mpsc::UnboundedSender<Offered>>>>,
    last: Arc<AtomicU32>,
    /// How many events have been written to a listener's stream.
    offered: Arc<AtomicU32>,
}

impl Listeners {
    /// A new listener: its id, and the stream to hand the component.
    ///
    /// `scene` is where the stream removes the listener from when the
    /// component drops it.
    pub fn open(&self, scene: Arc<Mutex<Scene>>) -> (u32, ListenerStream) {
        let id = self.last.fetch_add(1, Ordering::Relaxed) + 1;
        let (sender, events) = mpsc::unbounded_channel();
        self.streams.lock().unwrap().insert(id, sender);
        let stream = ListenerStream {
            id,
            events,
            scene,
            listeners: self.clone(),
        };
        (id, stream)
    }

    /// End these listeners' streams. The component's read of each returns
    /// "closed", which is how it finds out the node went away.
    pub fn end(&self, ids: &[u32]) {
        let mut streams = self.streams.lock().unwrap();
        for id in ids {
            streams.remove(id);
        }
    }

    /// Write an event to a listener's stream. Returns whether the listener
    /// still had one.
    pub fn offer(&self, listener: u32, offered: Offered) -> bool {
        let sent = match self.streams.lock().unwrap().get(&listener) {
            Some(stream) => stream.send(offered).is_ok(),
            None => false,
        };
        if sent {
            self.offered.fetch_add(1, Ordering::Relaxed);
        }
        sent
    }

    /// How many events have been written to listeners' streams.
    pub fn offered(&self) -> u32 {
        self.offered.load(Ordering::Relaxed)
    }
}

/// The host's end of one listener's stream.
pub struct ListenerStream {
    id: u32,
    events: mpsc::UnboundedReceiver<Offered>,
    scene: Arc<Mutex<Scene>>,
    listeners: Listeners,
}

impl StreamProducer<UiHostState> for ListenerStream {
    type Item = DeliveryRecord;
    type Buffer = Option<DeliveryRecord>;

    fn poll_produce<'a>(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        mut store: StoreContextMut<'a, UiHostState>,
        mut destination: Destination<'a, Self::Item, Self::Buffer>,
        finish: bool,
    ) -> Poll<wasmtime::Result<StreamResult>> {
        match self.events.poll_recv(cx) {
            Poll::Pending if finish => Poll::Ready(Ok(StreamResult::Cancelled)),
            Poll::Pending => Poll::Pending,
            Poll::Ready(Some(offered)) => {
                let reply = offered
                    .answered
                    .map(|answered| store.data_mut().replies.open(answered));
                destination.set_buffer(Some(DeliveryRecord {
                    event: offered.event,
                    reply: reply.map(Resource::new_own),
                }));
                Poll::Ready(Ok(StreamResult::Completed))
            }
            // The node went away and `Listeners::end` dropped the sender.
            Poll::Ready(None) => Poll::Ready(Ok(StreamResult::Dropped)),
        }
    }
}

impl Drop for ListenerStream {
    /// The component dropped the stream, or the store is going away. Either
    /// way nothing reads this listener's events any more.
    fn drop(&mut self) {
        self.scene.lock().unwrap().unlisten(self.id);
        self.listeners.end(&[self.id]);
    }
}
