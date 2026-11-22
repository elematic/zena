//! `zenafx:host/events`: what the pointer did, and which nodes hear about it.
//!
//! A component cannot hand the host a function, so a listener is data: a kind
//! of event, a scope, a phase, and an id for the stream its events go to. The
//! host keeps listeners on the nodes of [`super::scene::Scene`], which turns
//! each [`PointerInput`] from the window into the [`Delivery`]s to make. The
//! loader then makes them, writing one event to a listener's stream per
//! [`Call`].
//!
//! "Events: input, and what a widget reports" in `docs/design/zenafx-ui.md`.

use wasmtime::component::{ComponentType, Lift, Lower};

#[derive(Copy, Clone, Debug, PartialEq, Eq, ComponentType, Lift, Lower)]
#[component(enum)]
#[repr(u8)]
pub enum PointerKind {
    #[component(name = "down")]
    Down,
    #[component(name = "up")]
    Up,
    #[component(name = "move")]
    Move,
    /// The target is now inside the listener's scope and was not before.
    #[component(name = "enter")]
    Enter,
    /// The target was inside the listener's scope and no longer is.
    #[component(name = "leave")]
    Leave,
}

/// Which targets a listener hears. The target of a pointer event is the node
/// painted last under the pointer.
#[derive(Copy, Clone, Debug, PartialEq, Eq, ComponentType, Lift, Lower)]
#[component(enum)]
#[repr(u8)]
pub enum Scope {
    /// Only when the listening node is the target.
    #[component(name = "node")]
    Node,
    /// When the listening node or any node beneath it is the target.
    #[component(name = "subtree")]
    Subtree,
}

/// When a listener is offered a `down`, `up` or `move`.
#[derive(Copy, Clone, Debug, PartialEq, Eq, ComponentType, Lift, Lower)]
#[component(enum)]
#[repr(u8)]
pub enum Phase {
    /// After the target, walking up to the root.
    #[component(name = "bubble")]
    Bubble,
    /// Before the target, walking down from the root.
    #[component(name = "intercept")]
    Intercept,
}

/// One event as one listener receives it.
#[derive(Copy, Clone, Debug, PartialEq, ComponentType, Lift, Lower)]
#[component(record)]
pub struct PointerEvent {
    pub kind: PointerKind,
    /// Measured from the top left corner of the listening node's box, so a
    /// component does not learn where its nodes sit in the window.
    pub x: f32,
    pub y: f32,
    pub button: u8,
}

/// A registration: what a node hears, and which stream hears it.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub struct Listener {
    pub kind: PointerKind,
    pub scope: Scope,
    pub phase: Phase,
    /// Names the stream this listener's events are written to. The scene
    /// gives it no other meaning.
    pub id: u32,
}

/// What the window saw the pointer do, in window coordinates.
#[derive(Copy, Clone, Debug, PartialEq)]
pub enum PointerInput {
    Moved {
        x: f32,
        y: f32,
    },
    Button {
        x: f32,
        y: f32,
        button: u8,
        down: bool,
    },
    /// The pointer left the window.
    Left,
}

/// One event for one listener.
#[derive(Copy, Clone, Debug, PartialEq)]
pub struct Call {
    pub listener: u32,
    pub event: PointerEvent,
}

/// The calls one input leads to, in the order to make them.
#[derive(Clone, Debug, PartialEq)]
pub struct Delivery {
    pub calls: Vec<Call>,
    /// Whether a listener can stop the delivery, which makes the calls
    /// sequential: each waits for the answer to the one before. True for
    /// `down`, `up` and `move`, which travel a path. False for `enter` and
    /// `leave`, where each call reports a change to that listener's own scope
    /// and another listener's answer says nothing about this one.
    pub stops_when_handled: bool,
}
