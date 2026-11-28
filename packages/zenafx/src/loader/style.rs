//! WIT-mapped style engine types for `zenafx:platform/runtime@0.1.0`.
//!
//! Kept in `packages/zenafx` rather than `packages/zenafx-render` so the
//! minimal native core (`zenafx-render`) stays completely unaware of
//! stylesheets, rules, custom properties, inheritance, and watchers.

use std::collections::HashMap;
use std::pin::Pin;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};

use tokio::sync::mpsc;
use wasmtime::StoreContextMut;
use wasmtime::component::{
    ComponentType, Destination, Lift, Lower, StreamProducer, StreamResult,
};
use zenafx_render::types::{Color, Length};

use super::link::UiHostState;
use super::platform::PlatformRuntime;

#[derive(Clone, Copy, Debug, PartialEq, Eq, ComponentType, Lift, Lower)]
#[component(enum)]
#[repr(u8)]
pub enum ValueType {
    #[component(name = "flag")]
    Flag,
    #[component(name = "number")]
    Number,
    #[component(name = "length")]
    Length,
    #[component(name = "color")]
    Color,
    #[component(name = "keyword")]
    Keyword,
    #[component(name = "text")]
    Text,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, ComponentType, Lift, Lower)]
#[component(record)]
pub struct PropertyDef {
    pub kind: ValueType,
    pub inherits: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, ComponentType, Lift, Lower)]
#[component(enum)]
#[repr(u8)]
pub enum FactKind {
    #[component(name = "flag")]
    Flag,
    #[component(name = "number")]
    Number,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, ComponentType, Lift, Lower)]
#[component(enum)]
#[repr(u8)]
pub enum HostFact {
    #[component(name = "text")]
    Text,
    #[component(name = "box")]
    Box,
    #[component(name = "hovered")]
    Hovered,
    #[component(name = "pressed")]
    Pressed,
    #[component(name = "focused")]
    Focused,
    #[component(name = "width")]
    Width,
    #[component(name = "height")]
    Height,
    #[component(name = "scroll-x")]
    ScrollX,
    #[component(name = "scroll-y")]
    ScrollY,
    #[component(name = "scroll-range-x")]
    ScrollRangeX,
    #[component(name = "scroll-range-y")]
    ScrollRangeY,
    #[component(name = "index")]
    Index,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, ComponentType, Lift, Lower)]
#[component(enum)]
#[repr(u8)]
pub enum BuiltinProperty {
    #[component(name = "width")]
    Width,
    #[component(name = "height")]
    Height,
    #[component(name = "grow")]
    Grow,
    #[component(name = "shrink")]
    Shrink,
    #[component(name = "padding-top")]
    PaddingTop,
    #[component(name = "padding-right")]
    PaddingRight,
    #[component(name = "padding-bottom")]
    PaddingBottom,
    #[component(name = "padding-left")]
    PaddingLeft,
    #[component(name = "overflow-x")]
    OverflowX,
    #[component(name = "overflow-y")]
    OverflowY,
    #[component(name = "axis")]
    Axis,
    #[component(name = "justify")]
    Justify,
    #[component(name = "align")]
    Align,
    #[component(name = "gap")]
    Gap,
    #[component(name = "text-align")]
    TextAlign,
    #[component(name = "line-height")]
    LineHeight,
    #[component(name = "background")]
    Background,
    #[component(name = "border-color")]
    BorderColor,
    #[component(name = "border-width")]
    BorderWidth,
    #[component(name = "corner-radius")]
    CornerRadius,
    #[component(name = "opacity")]
    Opacity,
    #[component(name = "text-family")]
    TextFamily,
    #[component(name = "text-size")]
    TextSize,
    #[component(name = "text-weight")]
    TextWeight,
    #[component(name = "text-italic")]
    TextItalic,
    #[component(name = "text-color")]
    TextColor,
    #[component(name = "cursor")]
    Cursor,
    #[component(name = "user-select")]
    UserSelect,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, ComponentType, Lift, Lower)]
#[component(variant)]
pub enum StyleKey {
    #[component(name = "host")]
    Host(HostFact),
    #[component(name = "builtin")]
    Builtin(BuiltinProperty),
    #[component(name = "custom")]
    Custom(u32),
}

#[derive(Clone, Debug, PartialEq, ComponentType, Lift, Lower)]
#[component(variant)]
pub enum StyleValue {
    #[component(name = "flag")]
    Flag(bool),
    #[component(name = "number")]
    Number(f32),
    #[component(name = "length")]
    Length(Length),
    #[component(name = "color")]
    Color(Color),
    #[component(name = "keyword")]
    Keyword(u32),
    #[component(name = "text")]
    Text(String),
    #[component(name = "use-prop")]
    UseProp(StyleKey),
    #[component(name = "use-fact")]
    UseFact(StyleKey),
}

#[derive(Clone, Debug, PartialEq, ComponentType, Lift, Lower)]
#[component(record)]
pub struct Declaration {
    pub property: StyleKey,
    pub value: StyleValue,
    #[component(name = "is-default")]
    pub is_default: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, ComponentType, Lift, Lower)]
#[component(record)]
pub struct RangeTest {
    pub key: StyleKey,
    pub min: Option<f32>,
    #[component(name = "min-inclusive")]
    pub min_inclusive: bool,
    pub max: Option<f32>,
    #[component(name = "max-inclusive")]
    pub max_inclusive: bool,
}

#[derive(Clone, Debug, PartialEq, ComponentType, Lift, Lower)]
#[component(variant)]
pub enum Condition {
    #[component(name = "flag")]
    Flag(StyleKey),
    #[component(name = "range")]
    Range(RangeTest),
    #[component(name = "under")]
    Under(u32),
    #[component(name = "within")]
    Within(u32),
    #[component(name = "all")]
    All(Vec<u32>),
    #[component(name = "any")]
    Any(Vec<u32>),
    #[component(name = "negate")]
    Negate(u32),
}

#[derive(Clone, Debug, PartialEq, ComponentType, Lift, Lower)]
#[component(record)]
pub struct Rule {
    pub when: Option<u32>,
    pub then: Vec<Declaration>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, ComponentType, Lift, Lower)]
#[component(enum)]
#[repr(u8)]
pub enum Reach {
    #[component(name = "node")]
    Node,
    #[component(name = "scope")]
    Scope,
}

#[derive(Clone, Debug, PartialEq, ComponentType, Lift, Lower)]
#[component(record)]
pub struct StylesheetDef {
    pub id: u32,
    pub conditions: Vec<Condition>,
    pub rules: Vec<Rule>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, ComponentType, Lift, Lower)]
#[component(record)]
pub struct ConditionUpdate {
    pub watcher: u32,
    pub holds: bool,
}

#[derive(Clone, Debug, PartialEq, ComponentType, Lift, Lower)]
#[component(record)]
pub struct PropertyUpdate {
    pub watcher: u32,
    pub value: Option<StyleValue>,
}

#[derive(Clone, Debug, PartialEq, ComponentType, Lift, Lower)]
#[component(variant)]
pub enum WatcherUpdate {
    #[component(name = "condition")]
    Condition(ConditionUpdate),
    #[component(name = "property")]
    Property(PropertyUpdate),
    #[component(name = "ended")]
    Ended(u32),
}

/// Host-side registry of active condition and property watcher streams.
#[derive(Clone, Default)]
pub struct Watchers {
    cond_streams: Arc<Mutex<HashMap<u32, mpsc::UnboundedSender<bool>>>>,
    prop_streams: Arc<Mutex<HashMap<u32, mpsc::UnboundedSender<Option<StyleValue>>>>>,
    last: Arc<AtomicU32>,
}

impl Watchers {
    pub fn alloc_id(&self) -> u32 {
        self.last.fetch_add(1, Ordering::Relaxed) + 1
    }

    pub fn open_condition(
        &self,
        id: u32,
        platform: Arc<Mutex<PlatformRuntime>>,
        initial: bool,
    ) -> WatcherStream<bool> {
        let (tx, rx) = mpsc::unbounded_channel();
        let _ = tx.send(initial);
        self.cond_streams.lock().unwrap().insert(id, tx);
        WatcherStream {
            id,
            rx,
            platform,
            watchers: self.clone(),
        }
    }

    pub fn open_property(
        &self,
        id: u32,
        platform: Arc<Mutex<PlatformRuntime>>,
        initial: Option<StyleValue>,
    ) -> WatcherStream<Option<StyleValue>> {
        let (tx, rx) = mpsc::unbounded_channel();
        let _ = tx.send(initial);
        self.prop_streams.lock().unwrap().insert(id, tx);
        WatcherStream {
            id,
            rx,
            platform,
            watchers: self.clone(),
        }
    }

    pub fn flush(&self, updates: Vec<WatcherUpdate>) {
        if updates.is_empty() {
            return;
        }
        let mut conds = self.cond_streams.lock().unwrap();
        let mut props = self.prop_streams.lock().unwrap();
        for u in updates {
            match u {
                WatcherUpdate::Condition(cu) => {
                    if let Some(tx) = conds.get(&cu.watcher) {
                        let _ = tx.send(cu.holds);
                    }
                }
                WatcherUpdate::Property(pu) => {
                    if let Some(tx) = props.get(&pu.watcher) {
                        let _ = tx.send(pu.value);
                    }
                }
                WatcherUpdate::Ended(id) => {
                    conds.remove(&id);
                    props.remove(&id);
                }
            }
        }
    }

    fn remove(&self, id: u32) {
        self.cond_streams.lock().unwrap().remove(&id);
        self.prop_streams.lock().unwrap().remove(&id);
    }
}

pub struct WatcherStream<T> {
    id: u32,
    rx: mpsc::UnboundedReceiver<T>,
    platform: Arc<Mutex<PlatformRuntime>>,
    watchers: Watchers,
}

impl<T: ComponentType + Lift + Lower + Send + Sync + Unpin + 'static> StreamProducer<UiHostState>
    for WatcherStream<T>
{
    type Item = T;
    type Buffer = Option<T>;

    fn poll_produce<'a>(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        _store: StoreContextMut<'a, UiHostState>,
        mut destination: Destination<'a, Self::Item, Self::Buffer>,
        finish: bool,
    ) -> Poll<wasmtime::Result<StreamResult>> {
        match self.rx.poll_recv(cx) {
            Poll::Pending if finish => Poll::Ready(Ok(StreamResult::Cancelled)),
            Poll::Pending => Poll::Pending,
            Poll::Ready(Some(val)) => {
                destination.set_buffer(Some(val));
                Poll::Ready(Ok(StreamResult::Completed))
            }
            Poll::Ready(None) => Poll::Ready(Ok(StreamResult::Dropped)),
        }
    }
}

impl<T> Drop for WatcherStream<T> {
    fn drop(&mut self) {
        if let Ok(mut rt) = self.platform.lock() {
            let _ = rt.unwatch(self.id);
        }
        self.watchers.remove(self.id);
    }
}
