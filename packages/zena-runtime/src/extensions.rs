//! `zena-cli:host/extensions`: loading components as extensions, long-lived
//! instances a program calls through objects, and which call the program
//! through objects the program made for each of them. The design is in
//! docs/design/runtime-components.md.
//!
//! The program decides what an extension gets: `load` takes a binding for
//! every interface the extension may import, served by the host, by an
//! export of the program, or by another extension. The program's own
//! WIT declares its side of each interface in a shape this module pairs
//! with the extension's:
//!
//! - An interface the program serves is exported as a resource whose
//!   methods are the extension's free functions. The object serving an
//!   extension comes from the program's plugin object: the program
//!   exports a resource per plugin kind, named after the plugin's world,
//!   whose methods vend one object per served interface and whose static
//!   `create: static func(token: u32) -> own<kind>` returns the object
//!   the program registered under `token` when it loaded the extension.
//!   The first call from an extension on a served interface makes the
//!   plugin object through `create`, if it is not made yet, and the
//!   interface's object through the vendor; every later call lands on
//!   that object, so the objects are the extension's identity.
//! - An interface the program calls is imported as a resource whose
//!   methods are the extension's exported functions with their results
//!   wrapped in `result<_, string>`, with a static
//!   `attach: static func(extension: u32) -> own<resource>`, which the
//!   host serves. A method call on the attached object is forwarded to that
//!   extension's export.
//!
//! Resources the shared interface declares cross as proxies. A handle
//! is an index into one instance's table, so it cannot be given to
//! another instance as it is. A _proxy_ is this module's construction,
//! in Rust, out of a wasmtime host-defined resource type: the resource
//! the receiving component imports (`txn`, say) is defined in its
//! linker as the host type [`Proxy`], so every handle of it the
//! component holds is a host-defined resource whose representation is
//! an index into that store's [`Proxies`] table, which names the owner
//! and the owner's handle; the resource's methods are host functions
//! that forward. Neither WIT nor Zena sees anything new: the component
//! declares and uses the resource as any imported resource, and the
//! Zena compiler gives it the usual class. A method call on a
//! proxy is forwarded to the owner with the mapped handle as `self`,
//! and dropping a proxy drops the owner's handle. A call's arguments and
//! results are walked by type on both sides: the sender resolves its
//! proxies to the receiver's own handles and marks the handles it owns
//! itself ([`Carried::foreign`]), and the receiver makes proxies for
//! those.
//!
//! Each extension has a store of its own on a thread of its own, with a
//! current-thread tokio runtime, as a `zena:wasm` run has. Calls reach
//! it over a channel, and each runs as a task of the store under
//! wasmtime's `run_concurrent`, so calls in flight at once interleave
//! wherever the extension awaits. An extension's call back to the
//! program goes through the channel of the program's call whose guest
//! task it runs in, found from the async call stack. While the program
//! waits on a call, those calls back are served by tasks spawned in the
//! program's store, so the program is entered as a new task rather than
//! re-entered, which the Component Model forbids. A trap, a time limit
//! or a memory failure poisons the store, so every call in flight fails
//! and the thread drops the instance and makes a new one from the
//! `InstancePre` for the next call.

use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::{Mutex, mpsc, oneshot};
use wasmtime::component::types::{
    ComponentFunc, ComponentInstance as InterfaceType, ComponentItem, Type,
};
use wasmtime::component::{
    Accessor, AccessorTask, Component, Func, GuestTaskId, Instance, InstancePre, Linker,
    Resource, ResourceAny, ResourceType, Val,
};
use wasmtime::{
    AsContextMut, Engine, Result, Store, StoreContextMut, StoreLimitsBuilder, Trap, bail,
    format_err,
};
use wasmtime_wasi::WasiCtxBuilder;
use wit_parser::{ManglingAndAbi, Resolve};

use crate::component::bindings::zena_cli::host::extensions;
use crate::component::{ComponentState, linker, translate};
use crate::engine::{EPOCH_TICK, NO_DEADLINE};

/// Whether an import's instance name is one the host serves itself.
pub(crate) fn is_host_interface(name: &str) -> bool {
    name.starts_with("wasi:") || name.starts_with("zena-cli:host/")
}

/// Where one of an extension's imports comes from.
#[derive(Clone)]
enum Source {
    Host,
    /// The program's export of this name.
    Program(String),
    /// Another extension, by handle.
    Extension(u32),
}

/// What an extension may import: the program's decision.
enum Imports {
    Bound(Vec<(String, Source)>),
    /// Every host interface, and every export of the program by the
    /// same name: for a component the program trusts as itself.
    Trusted,
}

// ============================================================================
// Resources across stores
// ============================================================================

/// The host type behind an attached extension object in the program's
/// store; its representation is the extension's handle.
struct Attached;

/// The host type behind every proxied resource in a store; its
/// representation indexes the store's [`Proxies`].
struct Proxy;

/// The store that owns a proxied resource, and how to reach it.
#[derive(Clone)]
enum Owner {
    Program,
    Extension {
        handle: u32,
        calls: mpsc::UnboundedSender<ToExtension>,
    },
}

impl Owner {
    fn is(&self, other: &Owner) -> bool {
        match (self, other) {
            (Owner::Program, Owner::Program) => true,
            (Owner::Extension { handle: a, .. }, Owner::Extension { handle: b, .. }) => a == b,
            _ => false,
        }
    }

    fn describe(&self) -> String {
        match self {
            Owner::Program => "the program".to_string(),
            Owner::Extension { handle, .. } => format!("extension {handle}"),
        }
    }
}

/// A resource of another store, as this store sees it.
struct ProxyEntry {
    owner: Owner,
    /// The owner's handle.
    remote: ResourceAny,
}

/// This store's proxies to other stores' resources, by representation.
#[derive(Default)]
pub(crate) struct Proxies {
    entries: Vec<Option<ProxyEntry>>,
}

impl Proxies {
    fn add(&mut self, entry: ProxyEntry) -> u32 {
        if let Some(free) = self.entries.iter().position(|e| e.is_none()) {
            self.entries[free] = Some(entry);
            return free as u32;
        }
        self.entries.push(Some(entry));
        (self.entries.len() - 1) as u32
    }

    fn get(&self, rep: u32) -> Option<&ProxyEntry> {
        self.entries.get(rep as usize).and_then(|e| e.as_ref())
    }

    fn remove(&mut self, rep: u32) -> Option<ProxyEntry> {
        self.entries.get_mut(rep as usize).and_then(|e| e.take())
    }
}

/// Values crossing between stores: the handles among them that the
/// sender owns itself are listed by their position in the pre-order
/// walk of every resource value, so the receiver makes proxies for
/// those and keeps the rest, which are its own handles the sender
/// resolved from proxies.
#[derive(Default)]
pub(crate) struct Carried {
    vals: Vec<Val>,
    foreign: Vec<usize>,
}

/// Visits every resource value in `val`, typed `ty`, in pre-order, with
/// whether the type owns it.
fn walk_resources(
    val: &mut Val,
    ty: &Type,
    f: &mut dyn FnMut(&mut ResourceAny, bool) -> Result<()>,
) -> Result<()> {
    match (ty, val) {
        (Type::Own(_), Val::Resource(any)) => f(any, true),
        (Type::Borrow(_), Val::Resource(any)) => f(any, false),
        (Type::List(l), Val::List(items)) => {
            let ty = l.ty();
            items.iter_mut().try_for_each(|v| walk_resources(v, &ty, f))
        }
        (Type::FixedLengthList(l), Val::FixedLengthList(items)) => {
            let ty = l.ty();
            items.iter_mut().try_for_each(|v| walk_resources(v, &ty, f))
        }
        (Type::Map(m), Val::Map(pairs)) => {
            let (k, v) = (m.key(), m.value());
            pairs.iter_mut().try_for_each(|(key, value)| {
                walk_resources(key, &k, f)?;
                walk_resources(value, &v, f)
            })
        }
        (Type::Record(r), Val::Record(fields)) => {
            for (field, (_, value)) in r.fields().zip(fields.iter_mut()) {
                walk_resources(value, &field.ty, f)?;
            }
            Ok(())
        }
        (Type::Tuple(t), Val::Tuple(items)) => {
            for (ty, value) in t.types().zip(items.iter_mut()) {
                walk_resources(value, &ty, f)?;
            }
            Ok(())
        }
        (Type::Variant(v), Val::Variant(case, payload)) => {
            let case_ty = v.cases().find(|c| c.name == case).and_then(|c| c.ty);
            match (case_ty, payload) {
                (Some(ty), Some(value)) => walk_resources(value, &ty, f),
                _ => Ok(()),
            }
        }
        (Type::Option(o), Val::Option(Some(value))) => walk_resources(value, &o.ty(), f),
        (Type::Result(r), Val::Result(Ok(Some(value)))) => match r.ok() {
            Some(ty) => walk_resources(value, &ty, f),
            None => Ok(()),
        },
        (Type::Result(r), Val::Result(Err(Some(value)))) => match r.err() {
            Some(ty) => walk_resources(value, &ty, f),
            None => Ok(()),
        },
        _ => Ok(()),
    }
}

/// Prepares `vals`, typed `types`, to be sent to `target`: proxies of
/// `target`'s resources become `target`'s own handles (an owned one
/// leaves the table, since the handle goes back for good), and this
/// store's own handles are listed as foreign.
fn outgoing(
    store: &mut StoreContextMut<'_, ComponentState>,
    vals: &[Val],
    types: &[Type],
    target: &Owner,
) -> Result<Carried> {
    let mut vals = vals.to_vec();
    let mut foreign = Vec::new();
    let mut index = 0;
    for (val, ty) in vals.iter_mut().zip(types) {
        walk_resources(val, ty, &mut |any, owned| {
            let here = index;
            index += 1;
            if Resource::<Attached>::try_from_resource_any(*any, &mut *store).is_ok() {
                bail!("an attached extension object cannot be passed to an extension");
            }
            match Resource::<Proxy>::try_from_resource_any(*any, &mut *store) {
                Ok(proxy) => {
                    let rep = proxy.rep();
                    let entry = store
                        .data()
                        .proxies
                        .get(rep)
                        .ok_or_else(|| format_err!("a proxied resource is gone"))?;
                    if !entry.owner.is(target) {
                        bail!(
                            "a resource of {} cannot be passed to {}",
                            entry.owner.describe(),
                            target.describe()
                        );
                    }
                    *any = entry.remote;
                    if owned {
                        store.data_mut().proxies.remove(rep);
                    }
                }
                Err(_) => foreign.push(here),
            }
            Ok(())
        })?;
    }
    Ok(Carried { vals, foreign })
}

/// Takes in values sent by `from`: its handles become proxies in this
/// store, and the rest are this store's own handles. Proxies made for
/// borrowed values are listed, to be removed once the call is over.
fn incoming(
    store: &mut StoreContextMut<'_, ComponentState>,
    carried: Carried,
    types: &[Type],
    from: &Owner,
) -> Result<(Vec<Val>, Vec<(u32, ResourceAny)>)> {
    let Carried { mut vals, foreign } = carried;
    let mut borrowed = Vec::new();
    let mut index = 0;
    for (val, ty) in vals.iter_mut().zip(types) {
        walk_resources(val, ty, &mut |any, owned| {
            let here = index;
            index += 1;
            if !foreign.contains(&here) {
                return Ok(());
            }
            let rep = store.data_mut().proxies.add(ProxyEntry {
                owner: from.clone(),
                remote: *any,
            });
            // Owned by the host even for a borrowed value, since lending
            // a borrow into the host's table needs a call in progress,
            // and this runs before the call; the lowering into the guest
            // makes it a borrow there, and `release_borrowed` ends it.
            let proxy = Resource::<Proxy>::new_own(rep).try_into_resource_any(&mut *store)?;
            if !owned {
                borrowed.push((rep, proxy));
            }
            *any = proxy;
            Ok(())
        })?;
    }
    Ok((vals, borrowed))
}

/// Ends the proxies made for a call's borrowed values: their entries go
/// first, so the proxy's destructor has nothing to forward, and then
/// the handles.
fn release_borrowed(store: &mut StoreContextMut<'_, ComponentState>, borrowed: &[(u32, ResourceAny)]) {
    for (rep, any) in borrowed {
        store.data_mut().proxies.remove(*rep);
        let _ = drop_now(store, *any);
    }
}

/// Drops a handle through the async path within one poll, which is
/// enough for a host-defined resource and for a guest destructor,
/// which is synchronous guest code on a fiber wasmtime makes for it.
fn drop_now(store: &mut StoreContextMut<'_, ComponentState>, any: ResourceAny) -> Result<()> {
    let mut future = Box::pin(any.resource_drop_async(&mut *store));
    let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
    match future.as_mut().poll(&mut cx) {
        std::task::Poll::Ready(result) => result,
        std::task::Poll::Pending => bail!("the destructor did not finish"),
    }
}

/// Defines `name` in `li` as a proxied resource: dropping one drops the
/// owner's handle.
fn define_proxy(li: &mut wasmtime::component::LinkerInstance<'_, ComponentState>, name: &str) -> Result<()> {
    li.resource(name, ResourceType::host::<Proxy>(), |mut store, rep| {
        let Some(entry) = store.data_mut().proxies.remove(rep) else {
            return Ok(());
        };
        match entry.owner {
            Owner::Program => {
                if let Some(callbacks) = current_callbacks(&mut store) {
                    let _ = callbacks.send(Callback::Drop(entry.remote));
                }
            }
            Owner::Extension { calls, .. } => {
                let _ = calls.send(ToExtension::Drop(entry.remote));
            }
        }
        Ok(())
    })
}

/// The store, as a forwarder reaches it: through an accessor when the
/// import is `async`, which keeps the store's event loop running while
/// the forwarder waits, or held outright when the import is synchronous
/// and the guest is blocked in it.
enum Ctx<'a> {
    Accessor(&'a Accessor<ComponentState>),
    Direct(StoreContextMut<'a, ComponentState>),
}

impl Ctx<'_> {
    fn with<R>(&mut self, f: impl FnOnce(&mut StoreContextMut<'_, ComponentState>) -> R) -> R {
        match self {
            Ctx::Accessor(accessor) => accessor.with(|mut a| f(&mut a.as_context_mut())),
            Ctx::Direct(store) => f(store),
        }
    }
}

/// Defines `name` in `li` as a forwarder: a concurrent host function
/// when the import is `async`, so the guest's event loop keeps running
/// while it waits, and a blocking one otherwise, since wasmtime refuses
/// a concurrent host function for a synchronous import.
fn define_forwarder<F>(
    li: &mut wasmtime::component::LinkerInstance<'_, ComponentState>,
    name: &str,
    is_async: bool,
    f: F,
) -> Result<()>
where
    F: for<'a> Fn(
            Ctx<'a>,
            ComponentFunc,
            &'a [Val],
            &'a mut [Val],
        ) -> std::pin::Pin<Box<dyn Future<Output = Result<()>> + Send + 'a>>
        + Send
        + Sync
        + Clone
        + 'static,
{
    if is_async {
        li.func_new_concurrent(name, move |accessor, ty, params, results| {
            f(Ctx::Accessor(accessor), ty, params, results)
        })
    } else {
        li.func_new_async(name, move |store, ty, params, results| {
            Box::new(f(Ctx::Direct(store), ty, params, results))
        })
    }
}

// ============================================================================
// Channels
// ============================================================================

/// One call of the program, or of another extension, into an extension.
pub(crate) struct Call {
    interface: String,
    /// The export's name: a function's, or `[method]r.f` with `self`
    /// first in `params`.
    func: String,
    params: Carried,
    reply: oneshot::Sender<std::result::Result<Carried, String>>,
    /// Where the extension's calls back to the program go while this
    /// call runs: the channel of the program's call in flight.
    callbacks: Option<CallbackSender>,
    /// Who calls, for the proxies the extension makes of their handles.
    from: Owner,
}

/// What an extension's thread takes.
pub(crate) enum ToExtension {
    Call(Call),
    /// Drop this handle of the extension's, a proxy of which was dropped.
    Drop(ResourceAny),
}

/// What an extension sends the program.
pub(crate) enum Callback {
    Call {
        extension: u32,
        interface: String,
        /// The function's name, or `[method]r.f` for a method on a
        /// resource the program's interface declares.
        func: String,
        params: Carried,
        reply: oneshot::Sender<Result<Carried>>,
    },
    /// Drop this handle of the program's, a proxy of which was dropped.
    Drop(ResourceAny),
}

pub(crate) type CallbackSender = mpsc::UnboundedSender<Callback>;
/// In an extension's store: the program's channel for each call from
/// the program in flight, by the guest task running it.
pub(crate) type Callbacks = HashMap<GuestTaskId, CallbackSender>;

/// The channel to the program for the call whose guest task the
/// current host call runs in: the root of the async call stack, as
/// the task that started the call registered it. None outside any call
/// from the program, as in a task the extension started itself.
fn current_callbacks(store: &mut StoreContextMut<'_, ComponentState>) -> Option<CallbackSender> {
    let root = store.async_call_stack().ok()?.last()?;
    store.data().callbacks.get(&root).cloned()
}
pub(crate) type ExtensionSender = mpsc::UnboundedSender<ToExtension>;

/// What the program serves to one extension for one of its imports: the
/// program's export, the resource in it, and the object made for this
/// extension once something calls it.
struct Served {
    export: String,
    resource: String,
    object: Mutex<Option<ResourceAny>>,
    /// The plugin kind's method that vends the object, by full export
    /// name.
    vendor: String,
    plugin: Arc<Plugin>,
}

/// The program's object for one extension: the plugin kind it is made
/// through, the token `create` takes, and the object once made.
struct Plugin {
    /// The export the kind resource is in.
    export: String,
    resource: String,
    token: u32,
    object: Mutex<Option<ResourceAny>>,
}

/// A plugin kind and token, as a load names them.
#[derive(Clone)]
pub(crate) struct PluginRef {
    kind: String,
    token: u32,
}

/// A loaded extension, from the program's side.
pub(crate) struct Extension {
    /// The channel its thread takes calls on. Another extension bound
    /// to this one holds a clone, so the channel alone does not say
    /// whether the program still has it; `_alive` does.
    calls: mpsc::UnboundedSender<ToExtension>,
    /// Dropped with the extension, which ends its thread.
    _alive: oneshot::Sender<()>,
    /// Its component, for another extension bound to its exports.
    component: Component,
    /// By the name of the extension's import.
    served: HashMap<String, Arc<Served>>,
    /// The program's object for it, when it is served anything.
    plugin: Option<Arc<Plugin>>,
}

/// Another extension, as a binding target: its component and channel.
#[derive(Clone)]
struct Peer {
    component: Component,
    calls: mpsc::UnboundedSender<ToExtension>,
}

/// Everything the extension's thread needs to load its component.
struct LoadRequest {
    handle: u32,
    path: PathBuf,
    imports: Imports,
    memory_limit: u64,
    call_timeout: Option<Duration>,
    debug: bool,
    /// The program's component, whose exports the extension's bindings
    /// name.
    caller: Component,
    /// The extensions the bindings name, by handle.
    peers: HashMap<u32, Peer>,
    /// The program's object for the extension, when the load names one.
    plugin: Option<PluginRef>,
}

// ============================================================================
// Types
// ============================================================================

/// The functions of an interface type, by name.
fn functions(engine: &Engine, iface: &InterfaceType) -> Vec<(String, ComponentFunc)> {
    iface
        .exports(engine)
        .filter_map(|(name, item)| match item.ty {
            ComponentItem::ComponentFunc(f) => Some((name.to_string(), f)),
            _ => None,
        })
        .collect()
}

/// The resources of an interface type, by name.
fn resources(engine: &Engine, iface: &InterfaceType) -> Vec<(String, ResourceType)> {
    iface
        .exports(engine)
        .filter_map(|(name, item)| match item.ty {
            ComponentItem::Resource(r) => Some((name.to_string(), r)),
            _ => None,
        })
        .collect()
}

/// A function's parameter types.
fn params_of(f: &ComponentFunc) -> Vec<Type> {
    f.params().map(|(_, t)| t).collect()
}

/// Whether `f`'s one result is a `result<_, string>`.
fn is_failure_result(f: &ComponentFunc) -> bool {
    let mut results = f.results();
    match (results.next(), results.next()) {
        (Some(Type::Result(r)), None) => r.err() == Some(Type::String),
        _ => false,
    }
}

/// The payload of a `result<T, string>`, if any.
fn result_payload(f: &ComponentFunc) -> Option<Type> {
    match f.results().next() {
        Some(Type::Result(r)) => r.ok(),
        _ => None,
    }
}

/// Types for an error message: wasmtime's own description of each.
fn describe(types: &[Type]) -> String {
    if types.is_empty() {
        return "nothing".to_string();
    }
    types
        .iter()
        .map(|t| format!("{t:?}"))
        .collect::<Vec<_>>()
        .join(", ")
}

/// Resources of the two sides of an interface that stand for each
/// other, by name: the extension's and the program's, or two
/// extensions'.
type Pairs = Vec<(ResourceType, ResourceType)>;

/// Whether `a` and `b` are the same type, with paired resources taken
/// as the same.
fn same_type(a: &Type, b: &Type, pairs: &Pairs) -> bool {
    let paired = |x: &ResourceType, y: &ResourceType| {
        x == y || pairs.iter().any(|(p, q)| (p == x && q == y) || (p == y && q == x))
    };
    match (a, b) {
        (Type::Own(x), Type::Own(y)) | (Type::Borrow(x), Type::Borrow(y)) => paired(x, y),
        (Type::List(x), Type::List(y)) => same_type(&x.ty(), &y.ty(), pairs),
        (Type::FixedLengthList(x), Type::FixedLengthList(y)) => {
            x.len() == y.len() && same_type(&x.ty(), &y.ty(), pairs)
        }
        (Type::Map(x), Type::Map(y)) => {
            same_type(&x.key(), &y.key(), pairs) && same_type(&x.value(), &y.value(), pairs)
        }
        (Type::Record(x), Type::Record(y)) => {
            x.fields().len() == y.fields().len()
                && x
                    .fields()
                    .zip(y.fields())
                    .all(|(f, g)| f.name == g.name && same_type(&f.ty, &g.ty, pairs))
        }
        (Type::Tuple(x), Type::Tuple(y)) => {
            x.types().len() == y.types().len()
                && x.types().zip(y.types()).all(|(f, g)| same_type(&f, &g, pairs))
        }
        (Type::Variant(x), Type::Variant(y)) => {
            x.cases().len() == y.cases().len()
                && x.cases().zip(y.cases()).all(|(f, g)| {
                    f.name == g.name
                        && match (&f.ty, &g.ty) {
                            (Some(s), Some(t)) => same_type(s, t, pairs),
                            (None, None) => true,
                            _ => false,
                        }
                })
        }
        (Type::Enum(x), Type::Enum(y)) => x.names().eq(y.names()),
        (Type::Flags(x), Type::Flags(y)) => x.names().eq(y.names()),
        (Type::Option(x), Type::Option(y)) => same_type(&x.ty(), &y.ty(), pairs),
        (Type::Result(x), Type::Result(y)) => {
            let same = |p: Option<Type>, q: Option<Type>| match (p, q) {
                (Some(s), Some(t)) => same_type(&s, &t, pairs),
                (None, None) => true,
                _ => false,
            };
            same(x.ok(), y.ok()) && same(x.err(), y.err())
        }
        (Type::Future(_), _) | (Type::Stream(_), _) | (Type::ErrorContext, _) => false,
        _ => a == b,
    }
}

fn same_types(a: &[Type], b: &[Type], pairs: &Pairs) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| same_type(x, y, pairs))
}

/// Refuses the types the forwarder cannot carry: a resource other than
/// one the shared interface declares, a stream, a future or an error
/// context, anywhere in `ty`.
fn check_forwardable(
    interface: &str,
    name: &str,
    ty: &Type,
    own: &[ResourceType],
) -> std::result::Result<(), String> {
    let refused = |what: &str| {
        Err(format!(
            "{interface}#{name} uses a {what}, which cannot cross between a program and an \
             extension"
        ))
    };
    match ty {
        Type::Own(r) | Type::Borrow(r) => {
            if own.contains(r) {
                Ok(())
            } else {
                refused("resource from outside the interface")
            }
        }
        Type::Stream(_) => refused("stream"),
        Type::Future(_) => refused("future"),
        Type::ErrorContext => refused("error context"),
        Type::List(l) => check_forwardable(interface, name, &l.ty(), own),
        Type::FixedLengthList(l) => check_forwardable(interface, name, &l.ty(), own),
        Type::Map(m) => {
            check_forwardable(interface, name, &m.key(), own)?;
            check_forwardable(interface, name, &m.value(), own)
        }
        Type::Record(r) => r
            .fields()
            .try_for_each(|f| check_forwardable(interface, name, &f.ty, own)),
        Type::Tuple(t) => t
            .types()
            .try_for_each(|t| check_forwardable(interface, name, &t, own)),
        Type::Variant(v) => v.cases().try_for_each(|c| match &c.ty {
            Some(t) => check_forwardable(interface, name, t, own),
            None => Ok(()),
        }),
        Type::Option(o) => check_forwardable(interface, name, &o.ty(), own),
        Type::Result(r) => {
            if let Some(t) = r.ok() {
                check_forwardable(interface, name, &t, own)?;
            }
            match r.err() {
                Some(t) => check_forwardable(interface, name, &t, own),
                None => Ok(()),
            }
        }
        _ => Ok(()),
    }
}

/// Checks every parameter and result of `f` is forwardable.
fn check_signature(
    interface: &str,
    name: &str,
    f: &ComponentFunc,
    own: &[ResourceType],
) -> std::result::Result<(), String> {
    for (_, ty) in f.params() {
        check_forwardable(interface, name, &ty, own)?;
    }
    for ty in f.results() {
        check_forwardable(interface, name, &ty, own)?;
    }
    Ok(())
}

/// The resource a method's name belongs to, if it names one.
fn method_resource(name: &str) -> Option<(&str, &str)> {
    let rest = name.strip_prefix("[method]")?;
    rest.split_once('.')
}

/// Whether `name` is a constructor or a static, which have no `self`
/// and so no identity to serve.
fn is_identityless(name: &str) -> bool {
    name.starts_with("[constructor]") || name.starts_with("[static]")
}

/// Why a call into an extension failed, as the program sees it.
fn describe_failure(error: wasmtime::Error) -> String {
    if error.downcast_ref::<Trap>() == Some(&Trap::Interrupt) {
        return "stopped at its time limit".to_string();
    }
    let mut message = format!("{error:?}");
    if let Some(bt) = error.downcast_ref::<wasmtime::WasmBacktrace>() {
        message.push_str(&format!("\nWasm Backtrace:\n{bt}"));
    }
    message
}

// ============================================================================
// The program's side: attached objects, proxies, forwarders and calls back
// ============================================================================

/// The program's imported view of an interface an extension exports:
/// the attached resource, its methods, and the extension's own
/// resources with theirs.
struct CallerView {
    resource: String,
    /// The attached resource's methods, by the extension's function
    /// names.
    methods: Vec<(String, ComponentFunc)>,
    /// The extension's resources the view declares, with their methods
    /// by full export name.
    proxied: Vec<(String, ResourceType, Vec<(String, ComponentFunc)>)>,
}

/// Reads the program's import `name` as the view of an extension
/// interface, or says how it departs from the shape.
fn caller_view(engine: &Engine, name: &str, iface: &InterfaceType) -> Result<CallerView> {
    let resources = resources(engine, iface);
    let fns = functions(engine, iface);
    let attaches: Vec<&(String, ComponentFunc)> = fns
        .iter()
        .filter(|(n, _)| n.starts_with("[static]") && n.ends_with(".attach"))
        .collect();
    let [(attach_name, attach)] = attaches.as_slice() else {
        bail!(
            "extension import {name}: it must declare one resource with \
             attach: static func(extension: u32) -> own<resource>"
        );
    };
    let resource = attach_name
        .strip_prefix("[static]")
        .and_then(|n| n.strip_suffix(".attach"))
        .expect("matched above")
        .to_string();
    let Some((_, resource_ty)) = resources.iter().find(|(n, _)| *n == resource) else {
        bail!("extension import {name}#{attach_name}: {resource} is not a resource of the interface");
    };
    let attach_ok = params_of(attach) == vec![Type::U32]
        && attach.results().collect::<Vec<_>>() == vec![Type::Own(resource_ty.clone())];
    if !attach_ok {
        bail!("extension import {name}#{attach_name}: it must be static func(extension: u32) -> own<{resource}>");
    }
    let resource = &resource;
    let mut methods = Vec::new();
    let mut proxied: Vec<(String, ResourceType, Vec<(String, ComponentFunc)>)> = resources
        .iter()
        .filter(|(n, _)| n != resource)
        .map(|(n, r)| (n.clone(), r.clone(), Vec::new()))
        .collect();
    for (fname, f) in &fns {
        if fname == attach_name {
            continue;
        }
        let Some((owner, method)) = method_resource(fname) else {
            bail!(
                "extension import {name}#{fname}: only `attach` and the resources' methods \
                 belong in an extension interface"
            );
        };
        if !is_failure_result(f) {
            bail!(
                "extension import {name}#{fname}: its result must be result<T, string>, or \
                 result<_, string> for none, so a failed call can be reported"
            );
        }
        if owner == resource {
            methods.push((method.to_string(), f.clone()));
        } else if let Some((_, _, list)) = proxied.iter_mut().find(|(n, _, _)| n == owner) {
            list.push((fname.clone(), f.clone()));
        } else {
            bail!("extension import {name}#{fname}: {owner} is not a resource of the interface");
        }
    }
    Ok(CallerView {
        resource: resource.clone(),
        methods,
        proxied,
    })
}

/// Defines the program's side of every extension interface `component`
/// imports: the attached resource as a host type whose representation
/// is an extension's handle, `attach`, the extension's resources as
/// proxies, and a forwarding host function for every method. Fails when
/// an extension import does not have the shape the convention requires.
pub(crate) fn define_extension_imports(
    linker: &mut Linker<ComponentState>,
    engine: &Engine,
    component: &Component,
) -> Result<()> {
    let ty = component.component_type();
    for (name, import) in ty.imports(engine) {
        if is_host_interface(name) {
            continue;
        }
        let ComponentItem::ComponentInstance(iface) = import.ty else {
            continue;
        };
        let view = caller_view(engine, name, &iface)?;
        let mut li = linker.instance(name)?;
        li.resource(&view.resource, ResourceType::host::<Attached>(), |_, _| Ok(()))?;
        li.func_new(
            &format!("[static]{}.attach", view.resource),
            |mut store: StoreContextMut<'_, ComponentState>, _ty, params, results| {
                let Some(Val::U32(handle)) = params.first() else {
                    bail!("attach: the argument is not an extension handle");
                };
                let attached = Resource::<Attached>::new_own(*handle);
                results[0] = Val::Resource(attached.try_into_resource_any(&mut store)?);
                Ok(())
            },
        )?;
        let mut forwarded: Vec<(String, String)> = view
            .methods
            .iter()
            .map(|(m, _)| (format!("[method]{}.{}", view.resource, m), m.clone()))
            .collect();
        for (resource, _, methods) in &view.proxied {
            define_proxy(&mut li, resource)?;
            for (fname, _) in methods {
                forwarded.push((fname.clone(), fname.clone()));
            }
        }
        let mut forwarded_async: Vec<(String, String, bool)> = Vec::new();
        for (export_name, func) in forwarded {
            let is_async = functions(engine, &iface)
                .iter()
                .find(|(n, _)| *n == export_name)
                .is_some_and(|(_, f)| f.async_());
            forwarded_async.push((export_name, func, is_async));
        }
        for (export_name, func, is_async) in forwarded_async {
            let interface: Arc<str> = Arc::from(name);
            let func: Arc<str> = Arc::from(func.as_str());
            define_forwarder(&mut li, &export_name, is_async, move |ctx, ty, params, results| {
                let interface = interface.clone();
                let func = func.clone();
                Box::pin(async move {
                    forward_call(ctx, &interface, &func, &ty, params, results).await
                })
            })?;
        }
    }
    Ok(())
}

/// Reports a failed call as the result's error arm.
fn fail(results: &mut [Val], message: String) -> Result<()> {
    match results.first_mut() {
        Some(slot) => {
            *slot = Val::Result(Err(Some(Box::new(Val::String(message)))));
            Ok(())
        }
        None => bail!("{message}"),
    }
}

/// The program's method call on an attached object, or on a proxy of an
/// extension's resource, forwarded to the extension's export. Waits on
/// the extension's result and on its calls back at once, serving each
/// of the latter as a spawned task.
async fn forward_call(
    mut ctx: Ctx<'_>,
    interface: &str,
    func: &str,
    ty: &ComponentFunc,
    params: &[Val],
    results: &mut [Val],
) -> Result<()> {
    let Some(Val::Resource(receiver)) = params.first() else {
        bail!("{interface}#{func}: the receiver is not an extension's object");
    };
    // An attached object names the extension; a proxy names it through
    // its entry, and goes along as the method's `self`.
    let (handle, remote) = ctx.with(|store| -> Result<_> {
        if let Ok(attached) = Resource::<Attached>::try_from_resource_any(*receiver, &mut *store) {
            return Ok((attached.rep(), None));
        }
        let proxy = Resource::<Proxy>::try_from_resource_any(*receiver, &mut *store)?;
        let entry = store
            .data()
            .proxies
            .get(proxy.rep())
            .ok_or_else(|| format_err!("{interface}#{func}: the receiver is gone"))?;
        match entry.owner {
            Owner::Extension { handle, .. } => Ok((handle, Some(entry.remote))),
            Owner::Program => bail!("{interface}#{func}: the receiver is the program's own"),
        }
    })?;
    let slot = ctx.with(|store| {
        store
            .data()
            .extensions
            .get(handle.wrapping_sub(1) as usize)
            .map(|e| e.as_ref().map(|e| e.calls.clone()))
    });
    let sender = match slot {
        Some(Some(sender)) => sender,
        Some(None) => return fail(results, format!("extension {handle} is dropped")),
        None => return fail(results, format!("no extension {handle}")),
    };
    let target = Owner::Extension {
        handle,
        calls: sender.clone(),
    };
    // The receiver is already resolved; the rest of the arguments go
    // through the walk. A proxied receiver goes along as the method's
    // `self`, the owner's own handle, ahead of them.
    let param_types: Vec<Type> = params_of(ty).into_iter().skip(1).collect();
    let mut carried = match ctx.with(|store| outgoing(store, &params[1..], &param_types, &target)) {
        Ok(c) => c,
        Err(e) => return fail(results, format!("passing the arguments: {e:#}")),
    };
    if let Some(remote) = remote {
        carried.vals.insert(0, Val::Resource(remote));
        for index in &mut carried.foreign {
            *index += 1;
        }
    }
    let (callbacks, mut callbacks_rx) = mpsc::unbounded_channel();
    let (reply, mut answer) = oneshot::channel();
    if sender
        .send(ToExtension::Call(Call {
            interface: interface.to_string(),
            func: func.to_string(),
            params: carried,
            reply,
            callbacks: Some(callbacks),
            from: Owner::Program,
        }))
        .is_err()
    {
        return fail(results, format!("extension {handle} is dropped"));
    }
    let result_types: Vec<Type> = result_payload(ty).into_iter().collect();
    // Calls back are taken before the answer, and whatever arrived
    // beside the answer is taken after it, so a drop the extension made
    // on its way out is done before the program sees the result.
    let answered = loop {
        tokio::select! {
            biased;
            Some(callback) = callbacks_rx.recv() => {
                serve_callback(&mut ctx, callback)?;
            }
            answered = &mut answer => break answered,
        }
    };
    callbacks_rx.close();
    while let Ok(callback) = callbacks_rx.try_recv() {
        serve_callback(&mut ctx, callback)?;
    }
    match answered {
        Ok(Ok(carried)) => {
            let taken = ctx.with(|store| incoming(store, carried, &result_types, &target));
            match taken {
                Ok((vals, _)) => {
                    let payload = vals.into_iter().next().map(Box::new);
                    if let Some(slot) = results.first_mut() {
                        *slot = Val::Result(Ok(payload));
                    }
                    Ok(())
                }
                Err(e) => fail(results, format!("taking the result: {e:#}")),
            }
        }
        Ok(Err(message)) => fail(results, message),
        Err(_) => fail(results, format!("extension {handle} went away")),
    }
}

/// Serves one message from the extension while the program's call is
/// in flight: a call to the program as a spawned task, or a drop of a
/// handle the program owns, done here and now so that it is finished
/// before the call returns. Neither can run while a synchronous import
/// holds the store.
fn serve_callback(ctx: &mut Ctx<'_>, callback: Callback) -> Result<()> {
    match callback {
        Callback::Call {
            extension,
            interface,
            func,
            params,
            reply,
        } => match ctx {
            Ctx::Accessor(accessor) => {
                accessor.with(|mut a| {
                    a.spawn(ServeCallback {
                        extension,
                        interface,
                        func,
                        params,
                        reply,
                    })
                })?;
            }
            Ctx::Direct(_) => {
                let _ = reply.send(Err(format_err!(
                    "{interface}#{func}: the program's call is synchronous, so it cannot \
                     serve a call back"
                )));
            }
        },
        Callback::Drop(any) => match ctx {
            Ctx::Accessor(accessor) => {
                let dropped = accessor.with(|mut a| {
                    let mut store = a.as_context_mut();
                    drop_now(&mut store, any)
                });
                if let Err(e) = dropped {
                    eprintln!("dropping a resource an extension released: {e:#}");
                }
            }
            Ctx::Direct(_) => {
                eprintln!(
                    "a resource an extension released is kept: the program's call is \
                     synchronous, so its destructor cannot run now"
                );
            }
        },
    }
    Ok(())
}

/// Drops a handle of the program's whose proxy an extension dropped,
/// which runs the program's destructor.
struct DropOwn {
    any: ResourceAny,
}

impl AccessorTask<ComponentState> for DropOwn {
    async fn run(self, accessor: &Accessor<ComponentState>) -> Result<()> {
        // The store is reachable only inside `with`. A failure is
        // reported, not returned: an error from a spawned task ends the
        // program's run.
        let dropped = accessor.with(|mut a| {
            let mut store = a.as_context_mut();
            drop_now(&mut store, self.any)
        });
        if let Err(e) = dropped {
            eprintln!("dropping a resource an extension released: {e:#}");
        }
        Ok(())
    }
}

/// Serves one call from an extension on an interface the program
/// serves: a task of the program's store, started with no parent, so
/// entering the program's instance is a new task rather than a
/// re-entry. A function lands as a method on the object made for the
/// extension, through `create` the first time; a method on a resource
/// the interface declares lands on that resource.
struct ServeCallback {
    extension: u32,
    interface: String,
    func: String,
    params: Carried,
    reply: oneshot::Sender<Result<Carried>>,
}

impl AccessorTask<ComponentState> for ServeCallback {
    async fn run(self, accessor: &Accessor<ComponentState>) -> Result<()> {
        let ServeCallback {
            extension,
            interface,
            func,
            params,
            reply,
        } = self;
        let served = async {
            let (instance, served, from) = accessor.with(|mut a| {
                let state = a.get();
                let instance = state
                    .instance
                    .ok_or_else(|| format_err!("the program is not instantiated"))?;
                let ext = state
                    .extensions
                    .get(extension.wrapping_sub(1) as usize)
                    .and_then(|e| e.as_ref())
                    .ok_or_else(|| format_err!("extension {extension} is dropped"))?;
                let served = ext
                    .served
                    .get(&interface)
                    .cloned()
                    .ok_or_else(|| {
                        format_err!("extension {extension} is not served {interface}")
                    })?;
                let from = Owner::Extension {
                    handle: extension,
                    calls: ext.calls.clone(),
                };
                Ok::<_, wasmtime::Error>((instance, served, from))
            })?;
            let on_resource = method_resource(&func).is_some();
            let mut object = served.object.lock().await;
            if !on_resource && object.is_none() {
                let plugin = served.plugin.clone();
                let mut plugin_object = plugin.object.lock().await;
                if plugin_object.is_none() {
                    let factory = format!("[static]{}.create", plugin.resource);
                    let made = call_export(
                        accessor,
                        &instance,
                        &plugin.export,
                        &factory,
                        &[Val::U32(plugin.token)],
                    )
                    .await?;
                    let Some(Val::Resource(any)) = made.into_iter().next() else {
                        bail!("{}'s {} did not return a resource", plugin.export, factory);
                    };
                    *plugin_object = Some(any);
                }
                let receiver = plugin_object.expect("set above");
                let made = call_export(
                    accessor,
                    &instance,
                    &plugin.export,
                    &served.vendor,
                    &[Val::Resource(receiver)],
                )
                .await?;
                drop(plugin_object);
                let Some(Val::Resource(any)) = made.into_iter().next() else {
                    bail!("{}'s {} did not return a resource", plugin.export, served.vendor);
                };
                *object = Some(any);
            }
            let export_name = if on_resource {
                func.clone()
            } else {
                format!("[method]{}.{}", served.resource, func)
            };
            let (callee, callee_ty) = accessor.with(|mut a| {
                let mut store = a.as_context_mut();
                let f = lookup(&mut store, &instance, &served.export, &export_name)?;
                let ty = f.ty(&store);
                Ok::<_, wasmtime::Error>((f, ty))
            })?;
            let mut param_types = params_of(&callee_ty);
            if !on_resource {
                param_types.remove(0);
            }
            let (mut full, borrowed) = accessor.with(|mut a| {
                let mut store = a.as_context_mut();
                incoming(&mut store, params, &param_types, &from)
            })?;
            if !on_resource {
                full.insert(0, Val::Resource(object.expect("set above")));
            }
            drop(object);
            let result_types: Vec<Type> = callee_ty.results().collect();
            let mut results = vec![Val::Bool(false); result_types.len()];
            let called = callee.call_concurrent(accessor, &full, &mut results).await;
            accessor.with(|mut a| {
                let mut store = a.as_context_mut();
                release_borrowed(&mut store, &borrowed);
                called?;
                outgoing(&mut store, &results, &result_types, &from)
            })
        }
        .await;
        let _ = reply.send(served);
        Ok(())
    }
}

/// Calls the program's export `interface`#`name` with `params`, as a
/// concurrent task, and returns its results.
async fn call_export(
    accessor: &Accessor<ComponentState>,
    instance: &Instance,
    interface: &str,
    name: &str,
    params: &[Val],
) -> Result<Vec<Val>> {
    let (f, count) = accessor.with(|mut a| {
        let mut store = a.as_context_mut();
        let f = lookup(&mut store, instance, interface, name)?;
        let count = f.ty(&store).results().len();
        Ok::<_, wasmtime::Error>((f, count))
    })?;
    let mut results = vec![Val::Bool(false); count];
    f.call_concurrent(accessor, params, &mut results).await?;
    Ok(results)
}

/// Finds `interface`'s function `name` among `instance`'s exports.
fn lookup(
    store: &mut StoreContextMut<'_, ComponentState>,
    instance: &Instance,
    interface: &str,
    name: &str,
) -> Result<Func> {
    let iface = instance
        .get_export_index(&mut *store, None, interface)
        .ok_or_else(|| format_err!("the program exports no {interface}"))?;
    let idx = instance
        .get_export_index(&mut *store, Some(&iface), name)
        .ok_or_else(|| format_err!("the program exports no {interface}#{name}"))?;
    instance
        .get_func(&mut *store, idx)
        .ok_or_else(|| format_err!("{interface}#{name} is not a function"))
}

// ============================================================================
// The extension's side: its thread, its bindings, and its calls out
// ============================================================================

/// An extension's import, forwarded to the program through the channel
/// of the program's call in flight.
async fn forward_callback(
    mut ctx: Ctx<'_>,
    extension: u32,
    interface: &str,
    func: &str,
    ty: &ComponentFunc,
    params: &[Val],
    results: &mut [Val],
) -> Result<()> {
    let sender = ctx.with(|store| current_callbacks(store));
    let Some(sender) = sender else {
        bail!(
            "{interface}#{func}: called outside a call from the program, which is the only \
             time it can be served"
        );
    };
    let param_types = params_of(ty);
    let carried = ctx.with(|store| outgoing(store, params, &param_types, &Owner::Program))?;
    let (reply, answer) = oneshot::channel();
    sender
        .send(Callback::Call {
            extension,
            interface: interface.to_string(),
            func: func.to_string(),
            params: carried,
            reply,
        })
        .map_err(|_| format_err!("{interface}#{func}: the program's call is over"))?;
    let carried = answer
        .await
        .map_err(|_| format_err!("{interface}#{func}: the program dropped the call"))??;
    let result_types: Vec<Type> = ty.results().collect();
    let (vals, _) = ctx.with(|store| incoming(store, carried, &result_types, &Owner::Program))?;
    for (slot, val) in results.iter_mut().zip(vals) {
        *slot = val;
    }
    Ok(())
}

/// An extension's import, forwarded to another extension's export. The
/// program's call-back channel goes along, so the other extension can
/// still reach the program.
async fn forward_peer(
    mut ctx: Ctx<'_>,
    me: u32,
    peer: &Owner,
    interface: &str,
    func: &str,
    ty: &ComponentFunc,
    params: &[Val],
    results: &mut [Val],
) -> Result<()> {
    let Owner::Extension { calls, .. } = peer else {
        bail!("{interface}#{func}: bound to no extension");
    };
    let param_types = params_of(ty);
    let (callbacks, carried, me) = ctx.with(|store| {
        let carried = outgoing(store, params, &param_types, peer)?;
        let my_calls = store.data().my_calls.clone();
        Ok::<_, wasmtime::Error>((
            current_callbacks(store),
            carried,
            my_calls.map(|calls| Owner::Extension { handle: me, calls }),
        ))
    })?;
    let Some(me) = me else {
        bail!("{interface}#{func}: this extension's own channel is not known");
    };
    let (reply, answer) = oneshot::channel();
    calls
        .send(ToExtension::Call(Call {
            interface: interface.to_string(),
            func: func.to_string(),
            params: carried,
            reply,
            callbacks,
            from: me,
        }))
        .map_err(|_| format_err!("{interface}#{func}: the extension it is bound to is dropped"))?;
    let carried = answer
        .await
        .map_err(|_| format_err!("{interface}#{func}: the extension it is bound to went away"))?
        .map_err(|message| format_err!("{interface}#{func}: {message}"))?;
    let result_types: Vec<Type> = ty.results().collect();
    let (vals, _) = ctx.with(|store| incoming(store, carried, &result_types, peer))?;
    for (slot, val) in results.iter_mut().zip(vals) {
        *slot = val;
    }
    Ok(())
}

/// The program's export `export` as the view of the extension's import
/// `import`, which the program serves: every resource the extension's
/// interface declares, paired by name, and one resource of the
/// program's own whose methods are the extension's functions. Returns
/// that resource's name and type; the plugin kind vends it.
fn check_served(
    engine: &Engine,
    program: &Component,
    import: &str,
    import_ty: &InterfaceType,
    export: &str,
) -> std::result::Result<(String, ResourceType), String> {
    let Some(ComponentItem::ComponentInstance(export_ty)) =
        program.component_type().get_export(engine, export).map(|e| e.ty)
    else {
        return Err(format!("{import} is bound to {export}, which this program does not export"));
    };
    let theirs = resources(engine, import_ty);
    let ours = resources(engine, &export_ty);
    let mut pairs: Pairs = Vec::new();
    for (name, r) in &theirs {
        let Some((_, mine)) = ours.iter().find(|(n, _)| n == name) else {
            return Err(format!(
                "imports {import}, whose resource {name} {export} does not declare"
            ));
        };
        pairs.push((r.clone(), mine.clone()));
    }
    let served: Vec<&(String, ResourceType)> = ours
        .iter()
        .filter(|(n, _)| !theirs.iter().any(|(t, _)| t == n))
        .collect();
    let [(resource, resource_ty)] = served.as_slice() else {
        return Err(format!(
            "{import} is bound to {export}, which must declare one resource of its own, \
             whose methods are the extension's functions; it declares {}",
            served.len()
        ));
    };
    let exported = functions(engine, &export_ty);
    let own: Vec<ResourceType> = theirs.iter().map(|(_, r)| r.clone()).collect();
    for (fname, f) in functions(engine, import_ty) {
        if is_identityless(&fname) {
            return Err(format!(
                "imports {import}#{fname}, a constructor or static, which has no object to \
                 serve it"
            ));
        }
        check_signature(import, &fname, &f, &own)?;
        let (method, skip) = match method_resource(&fname) {
            Some(_) => (fname.clone(), 1),
            None => (format!("[method]{resource}.{fname}"), 1),
        };
        let Some((_, m)) = exported.iter().find(|(n, _)| *n == method) else {
            return Err(format!("imports {import}#{fname}, which {export} has no {method} for"));
        };
        let expected: Vec<Type> = params_of(&f)
            .into_iter()
            .skip(if method_resource(&fname).is_some() { 1 } else { 0 })
            .collect();
        let actual: Vec<Type> = params_of(m).into_iter().skip(skip).collect();
        if !same_types(&expected, &actual, &pairs) {
            return Err(format!(
                "imports {import}#{fname} with parameters ({}), where {export}'s {method} \
                 takes ({})",
                describe(&expected),
                describe(&actual)
            ));
        }
        let expected: Vec<Type> = f.results().collect();
        let actual: Vec<Type> = m.results().collect();
        if !same_types(&expected, &actual, &pairs) {
            return Err(format!(
                "imports {import}#{fname} returning {}, where {export}'s {method} returns {}",
                describe(&expected),
                describe(&actual)
            ));
        }
    }
    Ok((resource.clone(), resource_ty.clone()))
}

/// A served view of the extension's import, before the kind is checked.
struct View {
    import: String,
    export: String,
    resource: String,
    resource_ty: ResourceType,
}

/// The program's plugin kind `kind`: an exported resource of that name,
/// with `create: static func(token: u32) -> own<kind>` and, for each
/// served view, a method of no parameters returning that view's own
/// resource. Returns the export the kind is in and the vendor of each
/// view, by the import's name.
fn check_kind(
    engine: &Engine,
    program: &Component,
    kind: &str,
    views: &[View],
) -> std::result::Result<(String, HashMap<String, String>), String> {
    let ty = program.component_type();
    let mut found: Option<(String, InterfaceType, ResourceType)> = None;
    for (name, e) in ty.exports(engine) {
        if is_host_interface(name) {
            continue;
        }
        let ComponentItem::ComponentInstance(iface) = e.ty else {
            continue;
        };
        let Some((_, r)) = resources(engine, &iface)
            .into_iter()
            .find(|(n, _)| n == kind)
        else {
            continue;
        };
        if found.is_some() {
            return Err(format!(
                "this program exports a resource {kind} in two interfaces; a plugin kind's \
                 name must be unique"
            ));
        }
        found = Some((name.to_string(), iface, r));
    }
    let Some((export, iface, kind_ty)) = found else {
        return Err(format!(
            "this program exports no resource {kind}, the plugin kind the load names"
        ));
    };
    let funcs = functions(engine, &iface);
    let factory = format!("[static]{kind}.create");
    let shape = format!("create: static func(token: u32) -> own<{kind}>");
    let Some((_, create)) = funcs.iter().find(|(n, _)| *n == factory) else {
        return Err(format!("{export}'s {kind} must declare {shape}"));
    };
    let create_ok = params_of(create) == vec![Type::U32]
        && create.results().collect::<Vec<_>>() == vec![Type::Own(kind_ty.clone())];
    if !create_ok {
        return Err(format!("{export}'s {kind}.create must be {shape}"));
    }
    let prefix = format!("[method]{kind}.");
    let mut vendors = HashMap::new();
    for view in views {
        let vendor = funcs.iter().find(|(n, f)| {
            n.starts_with(&prefix)
                && params_of(f) == vec![Type::Borrow(kind_ty.clone())]
                && f.results().collect::<Vec<_>>() == vec![Type::Own(view.resource_ty.clone())]
        });
        match vendor {
            Some((n, _)) => {
                vendors.insert(view.import.clone(), n.clone());
            }
            None => {
                return Err(format!(
                    "imports {}, which plugin kind {kind} does not vend: no method of {kind} \
                     returns own<{}> of {}",
                    view.import, view.resource, view.export
                ));
            }
        }
    }
    Ok((export, vendors))
}

/// An extension's import against another extension's export: the same
/// functions, exactly, since nothing the program wrote is in between.
fn check_peer(
    engine: &Engine,
    peer: &Component,
    import: &str,
    import_ty: &InterfaceType,
) -> std::result::Result<(), String> {
    let Some(ComponentItem::ComponentInstance(export_ty)) =
        peer.component_type().get_export(engine, import).map(|e| e.ty)
    else {
        return Err(format!(
            "imports {import}, which the extension it is bound to does not export"
        ));
    };
    let theirs = resources(engine, import_ty);
    let ours = resources(engine, &export_ty);
    let mut pairs: Pairs = Vec::new();
    for (name, r) in &theirs {
        let Some((_, exported)) = ours.iter().find(|(n, _)| n == name) else {
            return Err(format!(
                "imports {import}, whose resource {name} the extension it is bound to does \
                 not export"
            ));
        };
        pairs.push((r.clone(), exported.clone()));
    }
    let own: Vec<ResourceType> = theirs.iter().map(|(_, r)| r.clone()).collect();
    let exported = functions(engine, &export_ty);
    for (fname, f) in functions(engine, import_ty) {
        if is_identityless(&fname) {
            return Err(format!(
                "imports {import}#{fname}, a constructor or static, which cannot cross \
                 between extensions"
            ));
        }
        check_signature(import, &fname, &f, &own)?;
        let Some((_, e)) = exported.iter().find(|(n, _)| *n == fname) else {
            return Err(format!(
                "imports {import}#{fname}, which the extension it is bound to does not export"
            ));
        };
        if !same_types(&params_of(&f), &params_of(e), &pairs)
            || !same_types(
                &f.results().collect::<Vec<_>>(),
                &e.results().collect::<Vec<_>>(),
                &pairs,
            )
        {
            return Err(format!(
                "imports {import}#{fname} as ({}) -> {}, where the extension it is bound to \
                 exports ({}) -> {}",
                describe(&params_of(&f)),
                describe(&f.results().collect::<Vec<_>>()),
                describe(&params_of(e)),
                describe(&e.results().collect::<Vec<_>>())
            ));
        }
    }
    Ok(())
}

/// The program's imported view against the extension's export, for each
/// export the program imports a view of: the methods after `self`
/// match the functions, with the results wrapped.
fn check_calls(
    engine: &Engine,
    program: &Component,
    child: &Component,
) -> std::result::Result<(), String> {
    let program_ty = program.component_type();
    let child_ty = child.component_type();
    for (name, export) in child_ty.exports(engine) {
        let ComponentItem::ComponentInstance(child_iface) = export.ty else {
            continue;
        };
        let Some(ComponentItem::ComponentInstance(view_ty)) =
            program_ty.get_import(engine, name).map(|e| e.ty)
        else {
            continue;
        };
        let Ok(view) = caller_view(engine, name, &view_ty) else {
            // Refused when the program was linked.
            continue;
        };
        let theirs = resources(engine, &child_iface);
        let mut pairs: Pairs = Vec::new();
        for (rname, r) in &theirs {
            let Some((_, _, _)) = view.proxied.iter().find(|(n, _, _)| n == rname) else {
                return Err(format!(
                    "exports {name}, whose resource {rname} this program's view does not \
                     declare"
                ));
            };
            let (_, mine, _) = view.proxied.iter().find(|(n, _, _)| n == rname).unwrap();
            pairs.push((r.clone(), mine.clone()));
        }
        let own: Vec<ResourceType> = theirs.iter().map(|(_, r)| r.clone()).collect();
        let exported = functions(engine, &child_iface);
        let mut views: Vec<(String, String, ComponentFunc)> = view
            .methods
            .iter()
            .map(|(m, f)| (m.clone(), format!("{}.{m}", view.resource), f.clone()))
            .collect();
        for (_, _, methods) in &view.proxied {
            for (fname, f) in methods {
                views.push((fname.clone(), fname.clone(), f.clone()));
            }
        }
        for (fname, f) in &exported {
            if is_identityless(fname) {
                return Err(format!(
                    "exports {name}#{fname}, a constructor or static, which this program \
                     cannot call on an extension"
                ));
            }
            let Some((_, label, m)) = views.iter().find(|(n, _, _)| n == fname) else {
                continue;
            };
            check_signature(name, fname, f, &own)?;
            let expected: Vec<Type> = params_of(m).into_iter().skip(1).collect();
            let actual: Vec<Type> = params_of(f)
                .into_iter()
                .skip(if method_resource(fname).is_some() { 1 } else { 0 })
                .collect();
            if !same_types(&expected, &actual, &pairs) {
                return Err(format!(
                    "exports {name}#{fname} with parameters ({}), where this program's \
                     {label} takes ({})",
                    describe(&actual),
                    describe(&expected)
                ));
            }
            let child_result: Vec<Type> = f.results().collect();
            let payload: Vec<Type> = result_payload(m).into_iter().collect();
            if child_result.len() > 1 || !same_types(&payload, &child_result, &pairs) {
                return Err(format!(
                    "exports {name}#{fname} returning {}, where this program's {label} \
                     returns result<{}, string>",
                    describe(&child_result),
                    describe(&payload)
                ));
            }
        }
    }
    Ok(())
}

/// A live instance of an extension, with its store.
struct Live {
    store: Store<ComponentState>,
    instance: Instance,
}

/// What the thread keeps between calls.
struct Loaded {
    engine: Engine,
    pre: InstancePre<ComponentState>,
    memory_limit: u64,
    /// The epoch ticks each call gets, on the interruptible engine.
    deadline: Option<u64>,
    /// This extension's own channel, for the calls it makes to peers.
    calls: mpsc::UnboundedSender<ToExtension>,
}

impl Loaded {
    async fn instantiate(&self) -> Result<Live> {
        let mut wasi = WasiCtxBuilder::new();
        wasi.inherit_stdout().inherit_stderr();
        let mut state = ComponentState::new(&self.engine, wasi.build(), None);
        state.my_calls = Some(self.calls.clone());
        if self.memory_limit > 0 {
            state.limits = StoreLimitsBuilder::new()
                .memory_size(usize::try_from(self.memory_limit).unwrap_or(usize::MAX))
                .build();
        }
        let mut store = Store::new(&self.engine, state);
        if self.memory_limit > 0 {
            store.limiter(|state| &mut state.limits);
        }
        if self.deadline.is_some() {
            store.set_epoch_deadline(NO_DEADLINE);
            store.epoch_deadline_trap();
        }
        let instance = self.pre.instantiate_async(&mut store).await?;
        Ok(Live { store, instance })
    }
}

/// The calls in flight on one instance, by number: where each answers,
/// and when it started.
#[derive(Default)]
struct InFlight {
    next: u64,
    calls: HashMap<
        u64,
        (
            oneshot::Sender<std::result::Result<Carried, String>>,
            Instant,
        ),
    >,
}

type Shared = Arc<std::sync::Mutex<InFlight>>;

fn in_flight(shared: &Shared) -> std::sync::MutexGuard<'_, InFlight> {
    shared
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Sets the store's epoch deadline for the calls in flight: what the
/// earliest-started call has left of `ticks`, or none when nothing is
/// in flight. One deadline serves the instance, so a call past its
/// limit stops the instance and fails every call on it.
fn arm_deadline(
    store: &mut StoreContextMut<'_, ComponentState>,
    ticks: Option<u64>,
    shared: &Shared,
) {
    let Some(ticks) = ticks else {
        return;
    };
    let longest = in_flight(shared)
        .calls
        .values()
        .map(|(_, started)| started.elapsed())
        .max();
    match longest {
        Some(elapsed) => {
            let spent = (elapsed.as_nanos() / EPOCH_TICK.as_nanos()) as u64;
            store.set_epoch_deadline(ticks.saturating_sub(spent).max(1));
        }
        None => store.set_epoch_deadline(NO_DEADLINE),
    }
}

/// One call into the instance, as a task of its store beside the other
/// calls in flight. Answers the caller, and ends the run when the call
/// failed, since the store may be poisoned.
struct RunCall {
    id: u64,
    call: Call,
    instance: Instance,
    deadline: Option<u64>,
    shared: Shared,
}

impl AccessorTask<ComponentState> for RunCall {
    async fn run(self, accessor: &Accessor<ComponentState>) -> Result<()> {
        let RunCall {
            id,
            call,
            instance,
            deadline,
            shared,
        } = self;
        let outcome = run_call(accessor, &instance, call).await;
        let reply = in_flight(&shared).calls.remove(&id).map(|(reply, _)| reply);
        accessor.with(|mut a| arm_deadline(&mut a.as_context_mut(), deadline, &shared));
        match outcome {
            Ok(carried) => {
                if let Some(reply) = reply {
                    let _ = reply.send(Ok(carried));
                }
                Ok(())
            }
            Err(e) => {
                let message = describe_failure(e);
                if let Some(reply) = reply {
                    let _ = reply.send(Err(message.clone()));
                }
                Err(format_err!("{message}"))
            }
        }
    }
}

/// The call itself: the arguments taken in, the export called as a
/// concurrent task with the caller's channel registered for its guest
/// task, and the results passed back.
async fn run_call(
    accessor: &Accessor<ComponentState>,
    instance: &Instance,
    call: Call,
) -> Result<Carried> {
    let Call {
        interface,
        func,
        params,
        callbacks,
        from,
        ..
    } = call;
    let (f, result_types, params, borrowed) = accessor.with(|mut a| {
        let mut store = a.as_context_mut();
        let f = lookup(&mut store, instance, &interface, &func)?;
        let ty = f.ty(&store);
        let param_types = params_of(&ty);
        let result_types: Vec<Type> = ty.results().collect();
        let (params, borrowed) = incoming(&mut store, params, &param_types, &from)
            .map_err(|e| format_err!("taking in the arguments: {e:#}"))?;
        Ok::<_, wasmtime::Error>((f, result_types, params, borrowed))
    })?;
    let mut results = vec![Val::Bool(false); result_types.len()];
    let started = accessor
        .with(|mut a| f.start_call_concurrent(a.as_context_mut(), &params, &mut results))?;
    let task = started.task();
    if let Some(callbacks) = callbacks {
        accessor.with(|mut a| {
            a.get().callbacks.insert(task, callbacks);
        });
    }
    let called = f.finish_call_concurrent(accessor, started).await;
    accessor.with(|mut a| {
        a.get().callbacks.remove(&task);
        let mut store = a.as_context_mut();
        release_borrowed(&mut store, &borrowed);
        called?;
        outgoing(&mut store, &results, &result_types, &from)
            .map_err(|e| format_err!("passing back the results: {e:#}"))
    })
}

/// Why the thread left an instance's run.
enum Exit {
    /// The program dropped the extension.
    Dropped,
    /// Every sender of the channel is gone.
    Closed,
}

/// Loads the component on the calling thread's behalf and serves calls
/// until the channel closes. Replies to `loaded` once, with the
/// extension or why there is none.
fn serve(
    request: LoadRequest,
    calls: mpsc::UnboundedSender<ToExtension>,
    mut rx: mpsc::UnboundedReceiver<ToExtension>,
    loaded: oneshot::Sender<std::result::Result<Extension, String>>,
) {
    let rt = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            let _ = loaded.send(Err(format!("failed to start a runtime: {e}")));
            return;
        }
    };
    rt.block_on(async {
        let prepared = prepare(&request, calls.clone()).await;
        let (alive, mut dropped) = oneshot::channel::<()>();
        let (state, live, served, plugin, component) = match prepared {
            Ok(Prepared {
                loaded: state,
                live,
                served,
                plugin,
                component,
            }) => (state, live, served, plugin, component),
            Err(message) => {
                let _ = loaded.send(Err(message));
                return;
            }
        };
        let _ = loaded.send(Ok(Extension {
            calls,
            _alive: alive,
            component,
            served,
            plugin,
        }));
        let shared: Shared = Default::default();
        let mut live = Some(live);
        // A call taken while there was no instance, for the run to serve
        // first.
        let mut first: Option<Call> = None;
        loop {
            if live.is_none() {
                let message = tokio::select! {
                    biased;
                    _ = &mut dropped => break,
                    received = rx.recv() => match received {
                        Some(message) => message,
                        None => break,
                    },
                };
                let call = match message {
                    ToExtension::Call(call) => call,
                    // Its handle went with the instance.
                    ToExtension::Drop(_) => continue,
                };
                match state.instantiate().await {
                    Ok(fresh) => {
                        live = Some(fresh);
                        first = Some(call);
                    }
                    Err(e) => {
                        let _ = call
                            .reply
                            .send(Err(format!("could not instantiate again: {e:#}")));
                        continue;
                    }
                }
            }
            let current = live.as_mut().expect("instantiated above");
            let instance = current.instance;
            let mut pending = first.take();
            let outcome = current
                .store
                .run_concurrent(async |accessor: &Accessor<ComponentState>| {
                    loop {
                        let message = match pending.take() {
                            Some(call) => ToExtension::Call(call),
                            None => tokio::select! {
                                biased;
                                _ = &mut dropped => return Ok(Exit::Dropped),
                                received = rx.recv() => match received {
                                    Some(message) => message,
                                    None => return Ok(Exit::Closed),
                                },
                            },
                        };
                        match message {
                            ToExtension::Drop(any) => accessor.with(|mut a| {
                                let _ = drop_now(&mut a.as_context_mut(), any);
                            }),
                            ToExtension::Call(mut call) => {
                                let reply =
                                    std::mem::replace(&mut call.reply, oneshot::channel().0);
                                let id = {
                                    let mut flight = in_flight(&shared);
                                    let id = flight.next;
                                    flight.next += 1;
                                    flight.calls.insert(id, (reply, Instant::now()));
                                    id
                                };
                                accessor.with(|mut a| {
                                    arm_deadline(&mut a.as_context_mut(), state.deadline, &shared);
                                    a.spawn(RunCall {
                                        id,
                                        call,
                                        instance,
                                        deadline: state.deadline,
                                        shared: shared.clone(),
                                    })
                                })?;
                            }
                        }
                    }
                })
                .await;
            match outcome {
                Ok(Ok(Exit::Dropped)) | Ok(Ok(Exit::Closed)) => break,
                Ok(Err(e)) | Err(e) => {
                    // The instance failed: every call still in flight
                    // fails with it, the one that failed it among them,
                    // since the run ends before its task sees the error.
                    // The next call starts a fresh instance.
                    let message = describe_failure(e);
                    let failed: Vec<_> = in_flight(&shared)
                        .calls
                        .drain()
                        .map(|(_, (reply, _))| reply)
                        .collect();
                    for reply in failed {
                        let _ = reply.send(Err(message.clone()));
                    }
                    live = None;
                }
            }
        }
        // Calls another extension sent before it learned of the drop.
        rx.close();
        while let Ok(message) = rx.try_recv() {
            if let ToExtension::Call(call) = message {
                let _ = call
                    .reply
                    .send(Err(format!("extension {} is dropped", request.handle)));
            }
        }
    });
}

struct Prepared {
    loaded: Loaded,
    live: Live,
    served: HashMap<String, Arc<Served>>,
    plugin: Option<Arc<Plugin>>,
    component: Component,
}

/// Reads, checks, links and instantiates the component.
async fn prepare(
    request: &LoadRequest,
    calls: mpsc::UnboundedSender<ToExtension>,
) -> std::result::Result<Prepared, String> {
    let path = &request.path;
    if !path.is_file() {
        return Err(format!("no such file: {}", path.display()));
    }
    if crate::core_module::is_core_module_file(path).unwrap_or(false) {
        return Err(format!(
            "{} is a core module; an extension is a component",
            path.display()
        ));
    }
    let interruptible = request.call_timeout.is_some();
    let engine = if interruptible {
        crate::engine::interruptible_component_engine(request.debug)
    } else {
        crate::engine::shared_component_engine(request.debug)
    }
    .map_err(|e| format!("{e:#}"))?;
    // The program's component was compiled on an engine of its own;
    // its type is what matters here, and types compare across engines.
    let child = crate::cache::load_component_variant(&engine, path, request.debug, interruptible)
        .map_err(|e| format!("{e:#}"))?;
    let at = |message: String| format!("{}: {message}", path.display());
    check_calls(&engine, &request.caller, &child).map_err(at)?;
    // The linker holds every host interface; the bindings are what keep
    // the extension to its list, and that is enough because a
    // component's imports are fixed by its type, so an interface the
    // linker could serve beyond them is out of its reach.
    let mut linker = linker(&engine).map_err(|e| format!("{e:#}"))?;
    let (served, plugin) = bind_imports(&mut linker, &engine, request, &child).map_err(at)?;
    let pre = linker
        .instantiate_pre(&child)
        .map_err(|e| format!("{}: {e:#}", path.display()))?;
    let deadline = request
        .call_timeout
        .map(|limit| limit.as_nanos().div_ceil(EPOCH_TICK.as_nanos()).max(1) as u64);
    let loaded = Loaded {
        engine,
        pre,
        memory_limit: request.memory_limit,
        deadline,
        calls,
    };
    let live = loaded
        .instantiate()
        .await
        .map_err(|e| format!("{}: {e:#}", path.display()))?;
    Ok(Prepared {
        loaded,
        live,
        served,
        plugin,
        component: child,
    })
}

/// Resolves every import of `child` through the request's bindings,
/// checks it, and defines the forwarders and proxies the program-served
/// and extension-served ones need. Returns what the program serves, by
/// the import's name, and the program's object for the extension when
/// it serves anything.
fn bind_imports(
    linker: &mut Linker<ComponentState>,
    engine: &Engine,
    request: &LoadRequest,
    child: &Component,
) -> std::result::Result<(HashMap<String, Arc<Served>>, Option<Arc<Plugin>>), String> {
    let program_exports: Vec<String> = request
        .caller
        .component_type()
        .exports(engine)
        .filter(|(name, e)| {
            !is_host_interface(name) && matches!(e.ty, ComponentItem::ComponentInstance(_))
        })
        .map(|(name, _)| name.to_string())
        .collect();
    let mut views: Vec<View> = Vec::new();
    let ty = child.component_type();
    for (name, import) in ty.imports(engine) {
        let ComponentItem::ComponentInstance(iface) = import.ty else {
            return Err(format!("imports {name}, which is not an interface"));
        };
        let source = match &request.imports {
            Imports::Bound(bindings) => match bindings.iter().find(|(n, _)| n == name) {
                Some((_, source)) => source.clone(),
                None => return Err(format!("imports {name}, which is not on its import list")),
            },
            Imports::Trusted => {
                if is_host_interface(name) {
                    Source::Host
                } else if program_exports.iter().any(|e| e == name) {
                    Source::Program(name.to_string())
                } else {
                    return Err(format!(
                        "imports {name}, which is neither a host interface nor an export of \
                         this program"
                    ));
                }
            }
        };
        match source {
            Source::Host => {
                if !is_host_interface(name) {
                    return Err(format!(
                        "imports {name}, which is bound to the host but is not a host interface"
                    ));
                }
            }
            Source::Program(export) => {
                let (resource, resource_ty) =
                    check_served(engine, &request.caller, name, &iface, &export)?;
                views.push(View {
                    import: name.to_string(),
                    export,
                    resource,
                    resource_ty,
                });
                let mut li = linker.instance(name).map_err(|e| format!("{e:#}"))?;
                for (rname, _) in resources(engine, &iface) {
                    define_proxy(&mut li, &rname).map_err(|e| format!("{e:#}"))?;
                }
                for (fname, f) in functions(engine, &iface) {
                    let interface: Arc<str> = Arc::from(name);
                    let func: Arc<str> = Arc::from(fname.as_str());
                    let handle = request.handle;
                    define_forwarder(&mut li, &fname, f.async_(), move |ctx, ty, params, results| {
                        let interface = interface.clone();
                        let func = func.clone();
                        Box::pin(async move {
                            forward_callback(ctx, handle, &interface, &func, &ty, params, results)
                                .await
                        })
                    })
                    .map_err(|e| format!("{e:#}"))?;
                }
            }
            Source::Extension(handle) => {
                let Some(peer) = request.peers.get(&handle) else {
                    return Err(format!("{name} is bound to extension {handle}, which there is none of"));
                };
                check_peer(engine, &peer.component, name, &iface)?;
                let owner = Owner::Extension {
                    handle,
                    calls: peer.calls.clone(),
                };
                let mut li = linker.instance(name).map_err(|e| format!("{e:#}"))?;
                for (rname, _) in resources(engine, &iface) {
                    define_proxy(&mut li, &rname).map_err(|e| format!("{e:#}"))?;
                }
                for (fname, f) in functions(engine, &iface) {
                    let interface: Arc<str> = Arc::from(name);
                    let func: Arc<str> = Arc::from(fname.as_str());
                    let owner = owner.clone();
                    let me = request.handle;
                    define_forwarder(&mut li, &fname, f.async_(), move |ctx, ty, params, results| {
                        let interface = interface.clone();
                        let func = func.clone();
                        let owner = owner.clone();
                        Box::pin(async move {
                            forward_peer(ctx, me, &owner, &interface, &func, &ty, params, results)
                                .await
                        })
                    })
                    .map_err(|e| format!("{e:#}"))?;
                }
            }
        }
    }
    if views.is_empty() {
        return Ok((HashMap::new(), None));
    }
    let Some(plugin_ref) = &request.plugin else {
        return Err(format!(
            "imports {}, which this program serves, so the load needs a plugin object: the \
             program's object for the extension, of a plugin kind that vends the interface",
            views[0].import
        ));
    };
    let (export, vendors) = check_kind(engine, &request.caller, &plugin_ref.kind, &views)?;
    let plugin = Arc::new(Plugin {
        export,
        resource: plugin_ref.kind.clone(),
        token: plugin_ref.token,
        object: Mutex::new(None),
    });
    let mut served = HashMap::new();
    for view in views {
        let vendor = vendors[&view.import].clone();
        served.insert(
            view.import,
            Arc::new(Served {
                export: view.export,
                resource: view.resource,
                object: Mutex::new(None),
                vendor,
                plugin: plugin.clone(),
            }),
        );
    }
    Ok((served, Some(plugin)))
}

// ============================================================================
// A component against a WIT world
// ============================================================================

/// Checks the component at `path` against `world` of the WIT document
/// at `wit`, as an extension: it must export every interface the world
/// exports, with the world's functions and resources, and import
/// nothing but interfaces the world imports, the same way, and
/// interfaces the host serves. `deps` are WIT files and directories
/// whose packages the document may use. Returns what differs, one line
/// each, or nothing when the component fits.
///
/// The world's side is a stand-in component wit-component builds for
/// the world, with no code behind its exports, compiled on the same
/// engine, so both sides are wasmtime types and the comparison is the
/// one a load makes. Whether a function is `async` is not compared, as
/// a load does not compare it.
pub fn check_world(
    engine: &Engine,
    path: &Path,
    wit: &Path,
    world: &str,
    deps: &[PathBuf],
) -> anyhow::Result<Vec<String>> {
    use anyhow::Context;
    let mut resolve = Resolve::default();
    push_deps(&mut resolve, deps)?;
    let (package, _) = resolve
        .push_path(wit)
        .with_context(|| format!("could not read the WIT at {}", wit.display()))?;
    let world_id = resolve
        .select_world(&[package], Some(world))
        .with_context(|| format!("{} has no world {world}", wit.display()))?;
    let mut module = wit_component::dummy_module(&resolve, world_id, ManglingAndAbi::Standard32);
    wit_component::embed_component_metadata(
        &mut module,
        &resolve,
        world_id,
        wit_component::StringEncoding::UTF8,
    )?;
    let stand_in = wit_component::ComponentEncoder::default()
        .module(&module)?
        .validate(true)
        .encode()
        .with_context(|| format!("could not encode world {world} as a component"))?;
    let stand_in = Component::new(engine, &stand_in)
        .map_err(anyhow::Error::from)
        .with_context(|| format!("could not compile world {world} as a component"))?;
    let tested = crate::cache::compile_component_uncached(engine, path)?;
    Ok(compare_to_world(engine, &stand_in, &tested, world))
}

/// Pushes the packages in `deps` into `resolve`: each file, and each
/// `.wit` file of each directory, is a package. A package may use
/// another from the same list, so the files are pushed in rounds,
/// each round taking the files whose packages are now resolvable,
/// until none is left or none can be pushed. A push that fails leaves
/// its package registered, so each is tried on a copy.
fn push_deps(resolve: &mut Resolve, deps: &[PathBuf]) -> anyhow::Result<()> {
    use anyhow::Context;
    let mut pending = Vec::new();
    for dep in deps {
        if dep.is_dir() {
            let entries = std::fs::read_dir(dep)
                .with_context(|| format!("could not read {}", dep.display()))?;
            let mut files: Vec<PathBuf> = entries
                .filter_map(|e| e.ok().map(|e| e.path()))
                .filter(|p| p.extension().is_some_and(|x| x == "wit"))
                .collect();
            files.sort();
            pending.extend(files);
        } else {
            pending.push(dep.clone());
        }
    }
    while !pending.is_empty() {
        let before = pending.len();
        let mut remaining = Vec::new();
        let mut first_failure = None;
        for path in pending {
            let mut trial = resolve.clone();
            match trial.push_path(&path) {
                Ok(_) => *resolve = trial,
                Err(e) => {
                    if first_failure.is_none() {
                        first_failure = Some((path.clone(), e));
                    }
                    remaining.push(path);
                }
            }
        }
        if remaining.len() == before {
            let (path, e) = first_failure.expect("a round without progress has a failure");
            return Err(e).with_context(|| format!("could not read the WIT at {}", path.display()));
        }
        pending = remaining;
    }
    Ok(())
}

/// Which side of a comparison declares what the other must have.
#[derive(Clone, Copy)]
enum Expected {
    /// The world's export, which the component must export.
    Export,
    /// The component's import, which the world must import.
    Import,
}

/// `tested` against `stand_in`, a component of the world's type, as
/// [`check_world`] says.
fn compare_to_world(
    engine: &Engine,
    stand_in: &Component,
    tested: &Component,
    world: &str,
) -> Vec<String> {
    let want = stand_in.component_type();
    let have = tested.component_type();
    let mut comparison = Comparison {
        engine,
        pairs: Vec::new(),
        world,
        problems: Vec::new(),
    };
    // Resources the two sides declare under one name in one interface
    // stand for each other.
    for (name, item) in want.exports(engine) {
        if let (ComponentItem::ComponentInstance(w), Some(ComponentItem::ComponentInstance(h))) =
            (item.ty, have.get_export(engine, name).map(|e| e.ty))
        {
            comparison.pair_resources(&w, &h);
        }
    }
    for (name, item) in want.imports(engine) {
        if let (ComponentItem::ComponentInstance(w), Some(ComponentItem::ComponentInstance(h))) =
            (item.ty, have.get_import(engine, name).map(|e| e.ty))
        {
            comparison.pair_resources(&w, &h);
        }
    }
    for (name, item) in want.exports(engine) {
        match (item.ty, have.get_export(engine, name).map(|e| e.ty)) {
            (ComponentItem::ComponentInstance(w), Some(ComponentItem::ComponentInstance(h))) => {
                comparison.interface(name, &w, &h, Expected::Export);
            }
            (ComponentItem::ComponentFunc(w), Some(ComponentItem::ComponentFunc(h))) => {
                comparison.function(name, None, &w, &h, Expected::Export);
            }
            (ComponentItem::ComponentInstance(_), _) => comparison.problems.push(format!(
                "does not export {name}, which world {world} exports"
            )),
            (ComponentItem::ComponentFunc(_), _) => comparison.problems.push(format!(
                "does not export the function {name}, which world {world} exports"
            )),
            _ => {}
        }
    }
    for (name, item) in have.imports(engine) {
        match (item.ty, want.get_import(engine, name).map(|e| e.ty)) {
            (ComponentItem::ComponentInstance(h), Some(ComponentItem::ComponentInstance(w))) => {
                comparison.interface(name, &h, &w, Expected::Import);
            }
            (ComponentItem::ComponentFunc(h), Some(ComponentItem::ComponentFunc(w))) => {
                comparison.function(name, None, &h, &w, Expected::Import);
            }
            (_, None) if is_host_interface(name) => {}
            (_, None) => comparison.problems.push(format!(
                "imports {name}, which world {world} does not import and the host does not serve"
            )),
            _ => comparison.problems.push(format!(
                "imports {name} as a different kind of item than world {world} imports"
            )),
        }
    }
    comparison.problems
}

/// A component against a world: the resources paired so far, and what
/// differs.
struct Comparison<'a> {
    engine: &'a Engine,
    pairs: Pairs,
    world: &'a str,
    problems: Vec<String>,
}

impl Comparison<'_> {
    /// Pairs the resources `a` and `b` declare under the same name.
    fn pair_resources(&mut self, a: &InterfaceType, b: &InterfaceType) {
        let theirs = resources(self.engine, b);
        for (name, r) in resources(self.engine, a) {
            if let Some((_, other)) = theirs.iter().find(|(n, _)| *n == name) {
                self.pairs.push((r, other.clone()));
            }
        }
    }

    /// Every function and resource `declared` has, `found` must have,
    /// with the same types.
    fn interface(
        &mut self,
        name: &str,
        declared: &InterfaceType,
        found: &InterfaceType,
        expected: Expected,
    ) {
        let world = self.world;
        let have = resources(self.engine, found);
        for (rname, _) in resources(self.engine, declared) {
            if !have.iter().any(|(n, _)| *n == rname) {
                self.problems.push(match expected {
                    Expected::Export => format!(
                        "{name} does not export the resource {rname}, which world {world}'s does"
                    ),
                    Expected::Import => format!(
                        "imports {name}'s resource {rname}, which world {world}'s does not declare"
                    ),
                });
            }
        }
        let have = functions(self.engine, found);
        for (fname, f) in functions(self.engine, declared) {
            match have.iter().find(|(n, _)| *n == fname) {
                Some((_, g)) => self.function(name, Some(&fname), &f, g, expected),
                None => self.problems.push(match expected {
                    Expected::Export => {
                        format!("{name} does not export {fname}, which world {world}'s does")
                    }
                    Expected::Import => format!(
                        "imports {name}#{fname}, which world {world}'s {name} does not declare"
                    ),
                }),
            }
        }
    }

    /// `declared` and `found` must take and return the same types.
    fn function(
        &mut self,
        name: &str,
        fname: Option<&str>,
        declared: &ComponentFunc,
        found: &ComponentFunc,
        expected: Expected,
    ) {
        let declared_results: Vec<Type> = declared.results().collect();
        let found_results: Vec<Type> = found.results().collect();
        if same_types(&params_of(declared), &params_of(found), &self.pairs)
            && same_types(&declared_results, &found_results, &self.pairs)
        {
            return;
        }
        let world = self.world;
        let label = match fname {
            Some(f) => format!("{name}#{f}"),
            None => name.to_string(),
        };
        self.problems.push(match expected {
            Expected::Export => format!(
                "{label} is ({}) -> {}, where world {world}'s is ({}) -> {}",
                describe(&params_of(found)),
                describe(&found_results),
                describe(&params_of(declared)),
                describe(&declared_results)
            ),
            Expected::Import => format!(
                "imports {label} as ({}) -> {}, where world {world}'s is ({}) -> {}",
                describe(&params_of(declared)),
                describe(&declared_results),
                describe(&params_of(found)),
                describe(&found_results)
            ),
        });
    }
}

// ============================================================================
// The host interface
// ============================================================================

/// A load in progress: the slot reserved for the extension, and where
/// its thread reports.
struct Pending {
    index: usize,
    loaded: oneshot::Receiver<std::result::Result<Extension, String>>,
}

impl ComponentState {
    /// Starts loading `path` as an extension that may import what
    /// `imports` says, on a thread of its own, with a slot reserved for
    /// it so that loads in flight at once get distinct handles. A slot
    /// whose load fails stays empty, as a dropped extension's does.
    fn start_load(
        &mut self,
        path: String,
        imports: Imports,
        options: extensions::LoadOptions,
        plugin: Option<PluginRef>,
    ) -> Result<std::result::Result<Pending, String>> {
        let grant = self.extensions_granted()?;
        let Some(host_path) = translate(&path, &grant.path_map) else {
            return Ok(Err(format!(
                "{path} is outside every directory this program can reach"
            )));
        };
        let Some(caller) = self.component.clone() else {
            return Ok(Err("this program's component is not known to the host".to_string()));
        };
        let mut peers = HashMap::new();
        if let Imports::Bound(bindings) = &imports {
            for (name, source) in bindings {
                if let Source::Extension(handle) = source {
                    match self
                        .extensions
                        .get(handle.wrapping_sub(1) as usize)
                        .and_then(|e| e.as_ref())
                    {
                        Some(e) => {
                            peers.insert(
                                *handle,
                                Peer {
                                    component: e.component.clone(),
                                    calls: e.calls.clone(),
                                },
                            );
                        }
                        None => {
                            return Ok(Err(format!(
                                "{name} is bound to extension {handle}, which is dropped or \
                                 never was"
                            )));
                        }
                    }
                }
            }
        }
        let index = self.extensions.len();
        let request = LoadRequest {
            handle: index as u32 + 1,
            path: host_path,
            imports,
            memory_limit: options.memory_limit,
            call_timeout: if options.call_timeout_nanos > 0 {
                Some(Duration::from_nanos(options.call_timeout_nanos as u64))
            } else {
                None
            },
            debug: options.debug || grant.debug,
            caller,
            peers,
            plugin,
        };
        self.extensions.push(None);
        let (tx, loaded) = oneshot::channel();
        let (calls, calls_rx) = mpsc::unbounded_channel();
        std::thread::spawn(move || serve(request, calls, calls_rx, tx));
        Ok(Ok(Pending { index, loaded }))
    }

    /// Keeps what the thread reported for the load at `index`, and
    /// returns the extension's handle or why there is none.
    fn finish_load(
        &mut self,
        index: usize,
        loaded: std::result::Result<std::result::Result<Extension, String>, oneshot::error::RecvError>,
    ) -> std::result::Result<u32, String> {
        match loaded {
            Ok(Ok(extension)) => {
                self.extensions[index] = Some(extension);
                Ok(index as u32 + 1)
            }
            Ok(Err(message)) => Err(message),
            Err(_) => Err("the extension's thread vanished".to_string()),
        }
    }
}

/// Loads an extension for the program `accessor` reaches: the program's
/// store is held only to start the load and to keep its result, so the
/// program's other tasks run while the thread compiles and instantiates.
async fn load_extension(
    accessor: &Accessor<ComponentState, wasmtime::component::HasSelf<ComponentState>>,
    path: String,
    imports: Imports,
    options: extensions::LoadOptions,
    plugin: Option<extensions::PluginRef>,
) -> Result<std::result::Result<u32, String>> {
    let plugin = plugin.map(|p| PluginRef {
        kind: p.kind,
        token: p.token,
    });
    let pending = accessor.with(|mut a| a.get().start_load(path, imports, options, plugin))?;
    let Pending { index, loaded } = match pending {
        Ok(pending) => pending,
        Err(message) => return Ok(Err(message)),
    };
    let loaded = loaded.await;
    Ok(accessor.with(|mut a| a.get().finish_load(index, loaded)))
}

impl From<extensions::Source> for Source {
    fn from(source: extensions::Source) -> Source {
        match source {
            extensions::Source::Host => Source::Host,
            extensions::Source::Program(export) => Source::Program(export),
            extensions::Source::Extension(handle) => Source::Extension(handle),
        }
    }
}

impl extensions::Host for ComponentState {
    fn check(
        &mut self,
        path: String,
        wit_path: String,
        world_name: String,
        deps: Vec<String>,
    ) -> Result<std::result::Result<(), String>> {
        let grant = self.extensions_granted()?;
        let Some(host_path) = translate(&path, &grant.path_map) else {
            return Ok(Err(format!(
                "{path} is outside every directory this program can reach"
            )));
        };
        let Some(host_wit) = translate(&wit_path, &grant.path_map) else {
            return Ok(Err(format!(
                "{wit_path} is outside every directory this program can reach"
            )));
        };
        let mut host_deps = Vec::new();
        for dep in &deps {
            let Some(host_dep) = translate(dep, &grant.path_map) else {
                return Ok(Err(format!(
                    "{dep} is outside every directory this program can reach"
                )));
            };
            host_deps.push(host_dep);
        }
        let engine = match crate::engine::shared_component_engine(grant.debug) {
            Ok(engine) => engine,
            Err(e) => return Ok(Err(format!("{e:#}"))),
        };
        let checked = check_world(&engine, &host_path, &host_wit, &world_name, &host_deps);
        Ok(match checked {
            Ok(problems) if problems.is_empty() => Ok(()),
            Ok(problems) => Err(problems.join("\n")),
            Err(e) => Err(format!("{e:#}")),
        })
    }
}

impl extensions::HostWithStore<ComponentState> for wasmtime::component::HasSelf<ComponentState> {
    async fn load(
        accessor: &Accessor<ComponentState, Self>,
        path: String,
        bindings: Vec<extensions::Binding>,
        options: extensions::LoadOptions,
        plugin: Option<extensions::PluginRef>,
    ) -> Result<std::result::Result<u32, String>> {
        let bound = bindings
            .into_iter()
            .map(|b| (b.name, b.served_by.into()))
            .collect();
        load_extension(accessor, path, Imports::Bound(bound), options, plugin).await
    }

    async fn load_trusted(
        accessor: &Accessor<ComponentState, Self>,
        path: String,
        options: extensions::LoadOptions,
        plugin: Option<extensions::PluginRef>,
    ) -> Result<std::result::Result<u32, String>> {
        load_extension(accessor, path, Imports::Trusted, options, plugin).await
    }

    /// Drops the extension, and the objects the program made for it
    /// through `create`. Their destructors are guest code, which cannot
    /// run while the program is in this call, so each drop is a task
    /// the program's event loop runs when the program next yields.
    fn drop(
        mut host: wasmtime::component::Access<'_, ComponentState, Self>,
        extension: u32,
    ) -> Result<()> {
        host.get().extensions_granted()?;
        let taken = host
            .get()
            .extensions
            .get_mut(extension.wrapping_sub(1) as usize)
            .and_then(|slot| slot.take());
        let Some(taken) = taken else {
            return Ok(());
        };
        for served in taken.served.values() {
            let object = served.object.try_lock().ok().and_then(|mut o| o.take());
            if let Some(any) = object {
                host.spawn(DropOwn { any })?;
            }
        }
        if let Some(plugin) = &taken.plugin {
            let object = plugin.object.try_lock().ok().and_then(|mut o| o.take());
            if let Some(any) = object {
                host.spawn(DropOwn { any })?;
            }
        }
        Ok(())
    }
}
