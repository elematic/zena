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
use std::marker::PhantomData;
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
use crate::ui::events::{KeyEvent, PointerEvent};
use crate::ui::scene::Scene;

/// What a `reply` handle names. Its representation is a key into
/// [`Replies`].
pub struct HostReply;

/// What a listener answered an event with, by the time it dropped the reply.
#[derive(Copy, Clone, Debug, Default, PartialEq, Eq)]
pub struct Answer {
    /// No listener after this one is offered the event.
    pub stop_propagation: bool,
    /// The host does not do what it otherwise does with the event.
    pub prevent_default: bool,
    /// The pointer is captured for the listener's node until the button
    /// comes up.
    pub capture: bool,
}

/// What a listener can be offered: something the pointer did, or a key.
pub enum Heard {
    Pointer(PointerEvent),
    Key(KeyEvent),
}

/// One event on its way to one listener.
pub struct Offered {
    pub event: Heard,
    /// Where the listener's answer goes. `None` for an event nothing can
    /// stop, which then carries no reply.
    pub answered: Option<oneshot::Sender<Answer>>,
}

/// What one kind of listener's stream carries: the record the component
/// reads for each event.
pub trait Carried: ComponentType + Lift + Lower + Send + Sync + Sized + 'static {
    /// The record for an event and the reply that goes with it. `None` when
    /// the event is not the kind this stream carries, which a listener is
    /// never offered: the scene keeps pointer and keyboard listeners apart.
    fn carry(event: Heard, reply: Option<Resource<HostReply>>) -> Option<Self>;
}

/// `key-delivery` in `zenafx:host/events`: what a keyboard listener's stream
/// carries. A key always has a reply, since a key always travels a path.
#[derive(ComponentType, Lift, Lower)]
#[component(record)]
pub struct KeyDeliveryRecord {
    event: KeyEvent,
    reply: Resource<HostReply>,
}

impl Carried for KeyDeliveryRecord {
    fn carry(event: Heard, reply: Option<Resource<HostReply>>) -> Option<Self> {
        match (event, reply) {
            (Heard::Key(event), Some(reply)) => Some(Self { event, reply }),
            _ => None,
        }
    }
}

impl Carried for DeliveryRecord {
    fn carry(event: Heard, reply: Option<Resource<HostReply>>) -> Option<Self> {
        match event {
            Heard::Pointer(event) => Some(Self { event, reply }),
            Heard::Key(_) => None,
        }
    }
}

/// `delivery` in `zenafx:host/events`: what a pointer listener's stream
/// carries.
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

    /// `reply.prevent-default`: the answer, once given, is that the host
    /// leaves the event alone when its listeners have all answered.
    pub fn prevent_default(&mut self, reply: u32) {
        if let Some(waiting) = self.waiting.get_mut(&reply) {
            waiting.answer.prevent_default = true;
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
    pub fn open<R: Carried>(&self, scene: Arc<Mutex<Scene>>) -> (u32, ListenerStream<R>) {
        let id = self.last.fetch_add(1, Ordering::Relaxed) + 1;
        let (sender, events) = mpsc::unbounded_channel();
        self.streams.lock().unwrap().insert(id, sender);
        let stream = ListenerStream {
            id,
            events,
            scene,
            listeners: self.clone(),
            carries: PhantomData,
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

/// The host's end of one listener's stream, carrying `R` for each event.
pub struct ListenerStream<R> {
    id: u32,
    events: mpsc::UnboundedReceiver<Offered>,
    scene: Arc<Mutex<Scene>>,
    listeners: Listeners,
    carries: PhantomData<fn() -> R>,
}

#[cfg(test)]
impl<R> ListenerStream<R> {
    /// The next event written to this listener's stream, for a test that
    /// stands in for the component reading it.
    pub async fn next_offered(&mut self) -> Option<Offered> {
        self.events.recv().await
    }
}

impl<R: Carried> StreamProducer<UiHostState> for ListenerStream<R> {
    type Item = R;
    type Buffer = Option<R>;

    fn poll_produce<'a>(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        mut store: StoreContextMut<'a, UiHostState>,
        mut destination: Destination<'a, Self::Item, Self::Buffer>,
        finish: bool,
    ) -> Poll<wasmtime::Result<StreamResult>> {
        loop {
            match self.events.poll_recv(cx) {
                Poll::Pending if finish => return Poll::Ready(Ok(StreamResult::Cancelled)),
                Poll::Pending => return Poll::Pending,
                Poll::Ready(Some(offered)) => {
                    let replies = &mut store.data_mut().replies;
                    let reply = offered.answered.map(|answered| replies.open(answered));
                    match R::carry(offered.event, reply.map(Resource::new_own)) {
                        Some(record) => {
                            destination.set_buffer(Some(record));
                            return Poll::Ready(Ok(StreamResult::Completed));
                        }
                        // Not this stream's kind of event. Nobody will read
                        // it, so whoever waits on its answer is answered now.
                        None => {
                            if let Some(reply) = reply {
                                replies.answer(reply);
                            }
                        }
                    }
                }
                // The node went away and `Listeners::end` dropped the sender.
                Poll::Ready(None) => return Poll::Ready(Ok(StreamResult::Dropped)),
            }
        }
    }
}

impl<R> Drop for ListenerStream<R> {
    /// The component dropped the stream, or the store is going away. Either
    /// way nothing reads this listener's events any more.
    fn drop(&mut self) {
        self.scene.lock().unwrap().unlisten(self.id);
        self.listeners.end(&[self.id]);
    }
}
