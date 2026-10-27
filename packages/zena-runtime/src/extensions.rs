//! `zena-cli:host/extensions`: loading components as extensions, long-lived
//! instances a program calls through objects, and which call the program
//! through objects the program made for each of them. The design, and
//! the spike that fixed its shape, are in
//! docs/design/runtime-components.md.
//!
//! The program decides what an extension gets: `load` takes a binding for
//! every interface the extension may import, served by the host, by an
//! export of the program, or by another extension. The program's own
//! WIT declares its side of each interface in a shape this module pairs
//! with the extension's:
//!
//! - An interface the program serves is exported as a resource whose
//!   methods are the extension's free functions, plus
//!   `create: func(extension: u32) -> own<resource>`. The first call from
//!   an extension on that interface makes its object through `create`;
//!   every later call lands on the same object, so the object is the
//!   extension's identity, and the program sees the extension's handle in
//!   `create` and nowhere else.
//! - An interface the program calls is imported as a resource whose
//!   methods are the extension's exported functions with their results
//!   wrapped in `result<_, string>`, plus
//!   `attach: func(extension: u32) -> own<resource>`, which the host
//!   serves. A method call on the attached object is forwarded to that
//!   extension's export.
//!
//! Each extension has a store of its own on a thread of its own, with a
//! current-thread tokio runtime, as a `zena:wasm` run has. Calls reach
//! it over a channel, one at a time. While the program waits on a call,
//! the extension's calls back are served by tasks spawned in the
//! program's store, so the program is entered as a new task rather than
//! re-entered, which the Component Model forbids. A trap, a time limit
//! or a memory failure poisons the store, so the thread drops the
//! instance and makes a new one from the `InstancePre` for the next call.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{Mutex, mpsc, oneshot};
use wasmtime::component::types::{ComponentFunc, ComponentInstance as InterfaceType, ComponentItem, Type};
use wasmtime::component::{
    Accessor, AccessorTask, Component, ComponentExportIndex, Func, Instance, InstancePre, Linker,
    Resource, ResourceAny, ResourceType, Val,
};
use wasmtime::{
    AsContextMut, Engine, Result, Store, StoreContextMut, StoreLimitsBuilder, Trap, bail,
    format_err,
};
use wasmtime_wasi::WasiCtxBuilder;

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

/// The host type behind an attached extension object in the program's
/// store; its representation is the extension's handle.
struct Attached;

/// One call of the program, or of another extension, into an extension.
struct Call {
    interface: String,
    func: String,
    params: Vec<Val>,
    reply: oneshot::Sender<std::result::Result<Vec<Val>, String>>,
    /// Where the extension's calls back to the program go while this
    /// call runs: the channel of the program's call in flight.
    callbacks: Option<CallbackSender>,
}

/// One call of an extension into the program.
pub(crate) struct Callback {
    extension: u32,
    interface: String,
    func: String,
    params: Vec<Val>,
    reply: oneshot::Sender<Result<Vec<Val>>>,
}

pub(crate) type CallbackSender = mpsc::UnboundedSender<Callback>;

/// What the program serves to one extension for one of its imports: the
/// program's export, the resource in it, and the object made for this
/// extension once something calls it.
struct Served {
    export: String,
    resource: String,
    object: Mutex<Option<ResourceAny>>,
}

/// A loaded extension, from the program's side.
pub(crate) struct Extension {
    /// The channel its thread takes calls on. Another extension bound
    /// to this one holds a clone, so the channel alone does not say
    /// whether the program still has it; `_alive` does.
    calls: mpsc::UnboundedSender<Call>,
    /// Dropped with the extension, which ends its thread.
    _alive: oneshot::Sender<()>,
    /// Its component, for another extension bound to its exports.
    component: Component,
    /// By the name of the extension's import.
    served: HashMap<String, Arc<Served>>,
}

/// Another extension, as a binding target: its component and channel.
#[derive(Clone)]
struct Peer {
    component: Component,
    calls: mpsc::UnboundedSender<Call>,
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
}

/// Finds `interface`'s function `name` among `instance`'s exports.
fn export_func<T>(
    store: &mut Store<T>,
    instance: &Instance,
    interface: &str,
    name: &str,
) -> Result<Func> {
    let iface: ComponentExportIndex = instance
        .get_export_index(&mut *store, None, interface)
        .ok_or_else(|| format_err!("no export {interface}"))?;
    let idx = instance
        .get_export_index(&mut *store, Some(&iface), name)
        .ok_or_else(|| format_err!("no export {interface}#{name}"))?;
    instance
        .get_func(&mut *store, idx)
        .ok_or_else(|| format_err!("{interface}#{name} is not a function"))
}

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

/// Refuses the types the forwarder cannot carry: resources, streams,
/// futures and error contexts, anywhere in `ty`.
fn check_forwardable(interface: &str, name: &str, ty: &Type) -> std::result::Result<(), String> {
    let refused = |what: &str| {
        Err(format!(
            "{interface}#{name} uses a {what}, which cannot cross between a program and an \
             extension yet"
        ))
    };
    match ty {
        Type::Own(_) | Type::Borrow(_) => refused("resource"),
        Type::Stream(_) => refused("stream"),
        Type::Future(_) => refused("future"),
        Type::ErrorContext => refused("error context"),
        Type::List(l) => check_forwardable(interface, name, &l.ty()),
        Type::FixedLengthList(l) => check_forwardable(interface, name, &l.ty()),
        Type::Map(m) => {
            check_forwardable(interface, name, &m.key())?;
            check_forwardable(interface, name, &m.value())
        }
        Type::Record(r) => r
            .fields()
            .try_for_each(|f| check_forwardable(interface, name, &f.ty)),
        Type::Tuple(t) => t
            .types()
            .try_for_each(|t| check_forwardable(interface, name, &t)),
        Type::Variant(v) => v.cases().try_for_each(|c| match &c.ty {
            Some(t) => check_forwardable(interface, name, t),
            None => Ok(()),
        }),
        Type::Option(o) => check_forwardable(interface, name, &o.ty()),
        Type::Result(r) => {
            if let Some(t) = r.ok() {
                check_forwardable(interface, name, &t)?;
            }
            match r.err() {
                Some(t) => check_forwardable(interface, name, &t),
                None => Ok(()),
            }
        }
        _ => Ok(()),
    }
}

/// Checks every parameter and result of `f` is forwardable.
fn check_signature(interface: &str, name: &str, f: &ComponentFunc) -> std::result::Result<(), String> {
    for (_, ty) in f.params() {
        check_forwardable(interface, name, &ty)?;
    }
    for ty in f.results() {
        check_forwardable(interface, name, &ty)?;
    }
    Ok(())
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
// The program's side: attached objects, forwarders and calls back
// ============================================================================

/// The program's imported view of an interface an extension exports:
/// one resource, `attach`, and the methods.
struct CallerView {
    resource: String,
    methods: Vec<(String, ComponentFunc)>,
}

/// Reads the program's import `name` as the view of an extension
/// interface, or says how it departs from the shape.
fn caller_view(engine: &Engine, name: &str, iface: &InterfaceType) -> Result<CallerView> {
    let resources = resources(engine, iface);
    let [(resource, resource_ty)] = resources.as_slice() else {
        bail!(
            "extension import {name}: it must declare one resource, whose methods are the \
             extension's functions; it declares {}",
            resources.len()
        );
    };
    let prefix = format!("[method]{resource}.");
    let mut methods = Vec::new();
    let mut attach = None;
    for (fname, f) in functions(engine, iface) {
        if fname == "attach" {
            attach = Some(f);
        } else if let Some(method) = fname.strip_prefix(&prefix) {
            if !is_failure_result(&f) {
                bail!(
                    "extension import {name}#{fname}: its result must be result<T, string>, or \
                     result<_, string> for none, so a failed call can be reported"
                );
            }
            methods.push((method.to_string(), f));
        } else {
            bail!(
                "extension import {name}#{fname}: only `attach` and the resource's methods \
                 belong in an extension interface"
            );
        }
    }
    let Some(attach) = attach else {
        bail!("extension import {name}: it must declare attach: func(extension: u32) -> own<{resource}>");
    };
    let attach_ok = params_of(&attach) == vec![Type::U32]
        && attach.results().collect::<Vec<_>>() == vec![Type::Own(resource_ty.clone())];
    if !attach_ok {
        bail!("extension import {name}#attach: it must be func(extension: u32) -> own<{resource}>");
    }
    Ok(CallerView {
        resource: resource.clone(),
        methods,
    })
}

/// Defines the program's side of every extension interface `component`
/// imports: the resource as a host type whose representation is an
/// extension's handle, `attach`, and a forwarding host function for
/// every method. Fails when an extension import does not have the shape
/// the convention requires.
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
            "attach",
            |mut store: StoreContextMut<'_, ComponentState>, _ty, params, results| {
                let Some(Val::U32(handle)) = params.first() else {
                    bail!("attach: the argument is not an extension handle");
                };
                let attached = Resource::<Attached>::new_own(*handle);
                results[0] = Val::Resource(attached.try_into_resource_any(&mut store)?);
                Ok(())
            },
        )?;
        for (method, _) in &view.methods {
            let interface: Arc<str> = Arc::from(name);
            let func: Arc<str> = Arc::from(method.as_str());
            let export_name = format!("[method]{}.{}", view.resource, method);
            li.func_new_concurrent(&export_name, move |accessor, _ty, params, results| {
                let interface = interface.clone();
                let func = func.clone();
                Box::pin(async move {
                    forward_call(accessor, &interface, &func, params, results).await
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

/// The program's method call on an attached object, forwarded to the
/// extension's export. Waits on the extension's result and on its
/// calls back at once, serving each of the latter as a spawned task.
async fn forward_call(
    accessor: &Accessor<ComponentState>,
    interface: &str,
    func: &str,
    params: &[Val],
    results: &mut [Val],
) -> Result<()> {
    let handle = accessor.with(|mut a| -> Result<u32> {
        let Some(Val::Resource(any)) = params.first() else {
            bail!("{interface}#{func}: the receiver is not an attached extension");
        };
        let mut store = a.as_context_mut();
        Ok(Resource::<Attached>::try_from_resource_any(*any, &mut store)?.rep())
    })?;
    let slot = accessor.with(|mut a| {
        a.get()
            .extensions
            .get(handle.wrapping_sub(1) as usize)
            .map(|e| e.as_ref().map(|e| e.calls.clone()))
    });
    let sender = match slot {
        Some(Some(sender)) => sender,
        Some(None) => return fail(results, format!("extension {handle} is dropped")),
        None => return fail(results, format!("no extension {handle}")),
    };
    let (callbacks, mut callbacks_rx) = mpsc::unbounded_channel();
    let (reply, mut answer) = oneshot::channel();
    if sender
        .send(Call {
            interface: interface.to_string(),
            func: func.to_string(),
            params: params[1..].to_vec(),
            reply,
            callbacks: Some(callbacks),
        })
        .is_err()
    {
        return fail(results, format!("extension {handle} is dropped"));
    }
    loop {
        tokio::select! {
            answered = &mut answer => {
                return match answered {
                    Ok(Ok(vals)) => {
                        let payload = vals.into_iter().next().map(Box::new);
                        if let Some(slot) = results.first_mut() {
                            *slot = Val::Result(Ok(payload));
                        }
                        Ok(())
                    }
                    Ok(Err(message)) => fail(results, message),
                    Err(_) => fail(results, format!("extension {handle} went away")),
                };
            }
            Some(callback) = callbacks_rx.recv() => {
                accessor.with(|mut a| a.spawn(ServeCallback { callback }))?;
            }
        }
    }
}

/// Serves one call from an extension on an interface the program
/// serves: a task of the program's store, started with no parent, so
/// entering the program's instance is a new task rather than a
/// re-entry. The extension's object is made through `create` the first
/// time, and the call lands on it as a method.
struct ServeCallback {
    callback: Callback,
}

impl AccessorTask<ComponentState> for ServeCallback {
    async fn run(self, accessor: &Accessor<ComponentState>) -> Result<()> {
        let Callback {
            extension,
            interface,
            func,
            params,
            reply,
        } = self.callback;
        let served = async {
            let (instance, served) = accessor.with(|mut a| {
                let state = a.get();
                let instance = state
                    .instance
                    .ok_or_else(|| format_err!("the program is not instantiated"))?;
                let served = state
                    .extensions
                    .get(extension.wrapping_sub(1) as usize)
                    .and_then(|e| e.as_ref())
                    .and_then(|e| e.served.get(&interface))
                    .cloned()
                    .ok_or_else(|| {
                        format_err!("extension {extension} is not served {interface}")
                    })?;
                Ok::<_, wasmtime::Error>((instance, served))
            })?;
            let mut object = served.object.lock().await;
            if object.is_none() {
                let (create, count) = accessor.with(|mut a| {
                    let mut store = a.as_context_mut();
                    let f = lookup(&mut store, &instance, &served.export, "create")?;
                    let count = f.ty(&store).results().len();
                    Ok::<_, wasmtime::Error>((f, count))
                })?;
                let mut made = vec![Val::Bool(false); count];
                create
                    .call_concurrent(accessor, &[Val::U32(extension)], &mut made)
                    .await?;
                let Some(Val::Resource(any)) = made.into_iter().next() else {
                    bail!("{}#create did not return a resource", served.export);
                };
                *object = Some(any);
            }
            let any = object.expect("set above");
            let method = format!("[method]{}.{}", served.resource, func);
            let (callee, count) = accessor.with(|mut a| {
                let mut store = a.as_context_mut();
                let f = lookup(&mut store, &instance, &served.export, &method)?;
                let count = f.ty(&store).results().len();
                Ok::<_, wasmtime::Error>((f, count))
            })?;
            let mut full = Vec::with_capacity(params.len() + 1);
            full.push(Val::Resource(any));
            full.extend(params);
            let mut results = vec![Val::Bool(false); count];
            callee.call_concurrent(accessor, &full, &mut results).await?;
            Ok(results)
        }
        .await;
        let _ = reply.send(served);
        Ok(())
    }
}

/// [`export_func`] on a store context.
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
    accessor: &Accessor<ComponentState>,
    extension: u32,
    interface: &str,
    func: &str,
    params: &[Val],
    results: &mut [Val],
) -> Result<()> {
    let sender = accessor.with(|mut a| a.get().callbacks.clone());
    let Some(sender) = sender else {
        bail!(
            "{interface}#{func}: called outside a call from the program, which is the only \
             time it can be served"
        );
    };
    let (reply, answer) = oneshot::channel();
    sender
        .send(Callback {
            extension,
            interface: interface.to_string(),
            func: func.to_string(),
            params: params.to_vec(),
            reply,
        })
        .map_err(|_| format_err!("{interface}#{func}: the program's call is over"))?;
    let vals = answer
        .await
        .map_err(|_| format_err!("{interface}#{func}: the program dropped the call"))??;
    for (slot, val) in results.iter_mut().zip(vals) {
        *slot = val;
    }
    Ok(())
}

/// An extension's import, forwarded to another extension's export. The
/// program's call-back channel goes along, so the other extension can
/// still reach the program.
async fn forward_peer(
    accessor: &Accessor<ComponentState>,
    peer: &mpsc::UnboundedSender<Call>,
    interface: &str,
    func: &str,
    params: &[Val],
    results: &mut [Val],
) -> Result<()> {
    let callbacks = accessor.with(|mut a| a.get().callbacks.clone());
    let (reply, answer) = oneshot::channel();
    peer.send(Call {
        interface: interface.to_string(),
        func: func.to_string(),
        params: params.to_vec(),
        reply,
        callbacks,
    })
    .map_err(|_| format_err!("{interface}#{func}: the extension it is bound to is dropped"))?;
    let vals = answer
        .await
        .map_err(|_| format_err!("{interface}#{func}: the extension it is bound to went away"))?
        .map_err(|message| format_err!("{interface}#{func}: {message}"))?;
    for (slot, val) in results.iter_mut().zip(vals) {
        *slot = val;
    }
    Ok(())
}

/// The program's exported view of an interface an extension imports:
/// one resource, `create`, and the methods. Checks the extension's
/// functions against the methods, and returns the resource's name.
fn check_served(
    engine: &Engine,
    program: &Component,
    import: &str,
    import_ty: &InterfaceType,
    export: &str,
) -> std::result::Result<String, String> {
    let Some(ComponentItem::ComponentInstance(export_ty)) =
        program.component_type().get_export(engine, export).map(|e| e.ty)
    else {
        return Err(format!("{import} is bound to {export}, which this program does not export"));
    };
    if !resources(engine, import_ty).is_empty() {
        return Err(format!("imports {import}, which declares a resource"));
    }
    let resources = resources(engine, &export_ty);
    let [(resource, resource_ty)] = resources.as_slice() else {
        return Err(format!(
            "{import} is bound to {export}, which must declare one resource, whose methods \
             are the extension's functions; it declares {}",
            resources.len()
        ));
    };
    let exported = functions(engine, &export_ty);
    let Some((_, create)) = exported.iter().find(|(n, _)| n == "create") else {
        return Err(format!(
            "{import} is bound to {export}, which must declare create: func(extension: u32) \
             -> own<{resource}>"
        ));
    };
    let create_ok = params_of(create) == vec![Type::U32]
        && create.results().collect::<Vec<_>>() == vec![Type::Own(resource_ty.clone())];
    if !create_ok {
        return Err(format!(
            "{export}#create must be func(extension: u32) -> own<{resource}>"
        ));
    }
    for (fname, f) in functions(engine, import_ty) {
        check_signature(import, &fname, &f)?;
        let method = format!("[method]{resource}.{fname}");
        let Some((_, m)) = exported.iter().find(|(n, _)| *n == method) else {
            return Err(format!(
                "imports {import}#{fname}, which {export}'s {resource} has no method for"
            ));
        };
        let expected: Vec<Type> = params_of(&f);
        let actual: Vec<Type> = params_of(m).into_iter().skip(1).collect();
        if expected != actual {
            return Err(format!(
                "imports {import}#{fname} with parameters ({}), where {export}'s {method} \
                 takes ({})",
                describe(&expected),
                describe(&actual)
            ));
        }
        let expected: Vec<Type> = f.results().collect();
        let actual: Vec<Type> = m.results().collect();
        if expected != actual {
            return Err(format!(
                "imports {import}#{fname} returning {}, where {export}'s {method} returns {}",
                describe(&expected),
                describe(&actual)
            ));
        }
    }
    Ok(resource.clone())
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
    if !resources(engine, import_ty).is_empty() {
        return Err(format!("imports {import}, which declares a resource"));
    }
    let exported = functions(engine, &export_ty);
    for (fname, f) in functions(engine, import_ty) {
        check_signature(import, &fname, &f)?;
        let Some((_, e)) = exported.iter().find(|(n, _)| *n == fname) else {
            return Err(format!(
                "imports {import}#{fname}, which the extension it is bound to does not export"
            ));
        };
        if params_of(&f) != params_of(e) || f.results().ne(e.results()) {
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
        let Some(ComponentItem::ComponentInstance(view)) =
            program_ty.get_import(engine, name).map(|e| e.ty)
        else {
            continue;
        };
        let Ok(view) = caller_view(engine, name, &view) else {
            // Refused when the program was linked.
            continue;
        };
        let exported = functions(engine, &child_iface);
        for (method, m) in &view.methods {
            let Some((_, f)) = exported.iter().find(|(n, _)| n == method) else {
                continue;
            };
            check_signature(name, method, f)?;
            let expected: Vec<Type> = params_of(m).into_iter().skip(1).collect();
            let actual = params_of(f);
            if expected != actual {
                return Err(format!(
                    "exports {name}#{method} with parameters ({}), where this program's \
                     {}.{method} takes ({})",
                    describe(&actual),
                    view.resource,
                    describe(&expected)
                ));
            }
            let child_result = f.results().next();
            if f.results().len() > 1 || result_payload(m) != child_result {
                return Err(format!(
                    "exports {name}#{method} returning {}, where this program's {}.{method} \
                     returns result<{}, string>",
                    describe(&child_result.into_iter().collect::<Vec<_>>()),
                    view.resource,
                    describe(&result_payload(m).into_iter().collect::<Vec<_>>())
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
}

impl Loaded {
    async fn instantiate(&self) -> Result<Live> {
        let mut wasi = WasiCtxBuilder::new();
        wasi.inherit_stdout().inherit_stderr();
        let mut state = ComponentState::new(&self.engine, wasi.build(), None);
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

    /// One call: the result values, or why it failed.
    async fn call(&self, live: &mut Live, call: &Call) -> Result<Vec<Val>> {
        let func = export_func(&mut live.store, &live.instance, &call.interface, &call.func)?;
        let count = func.ty(&live.store).results().len();
        let mut results = vec![Val::Bool(false); count];
        if let Some(ticks) = self.deadline {
            live.store.set_epoch_deadline(ticks);
        }
        live.store
            .run_concurrent(async |accessor| {
                func.call_concurrent(accessor, &call.params, &mut results)
                    .await
            })
            .await??;
        Ok(results)
    }
}

/// Loads the component on the calling thread's behalf and serves calls
/// until the channel closes. Replies to `loaded` once, with the
/// extension or why there is none.
fn serve(
    request: LoadRequest,
    loaded: std::sync::mpsc::Sender<std::result::Result<Extension, String>>,
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
        let prepared = prepare(&request).await;
        let (tx, mut rx) = mpsc::unbounded_channel::<Call>();
        let (alive, mut dropped) = oneshot::channel::<()>();
        let (state, mut live, served, component) = match prepared {
            Ok(Prepared {
                loaded: state,
                live,
                served,
                component,
            }) => (state, Some(live), served, component),
            Err(message) => {
                let _ = loaded.send(Err(message));
                return;
            }
        };
        let _ = loaded.send(Ok(Extension {
            calls: tx,
            _alive: alive,
            component,
            served,
        }));
        loop {
            let call = tokio::select! {
                biased;
                _ = &mut dropped => break,
                received = rx.recv() => match received {
                    Some(call) => call,
                    None => break,
                },
            };
            if live.is_none() {
                live = match state.instantiate().await {
                    Ok(l) => Some(l),
                    Err(e) => {
                        let _ = call
                            .reply
                            .send(Err(format!("could not instantiate again: {e:#}")));
                        continue;
                    }
                };
            }
            let current = live.as_mut().unwrap();
            current.store.data_mut().callbacks = call.callbacks.clone();
            let outcome = state.call(current, &call).await;
            current.store.data_mut().callbacks = None;
            let reply = match outcome {
                Ok(vals) => Ok(vals),
                Err(e) => {
                    // The store may be poisoned, so the instance goes;
                    // the next call starts a fresh one.
                    live = None;
                    Err(describe_failure(e))
                }
            };
            let _ = call.reply.send(reply);
        }
        // Calls another extension sent before it learned of the drop.
        rx.close();
        while let Ok(call) = rx.try_recv() {
            let _ = call
                .reply
                .send(Err(format!("extension {} is dropped", request.handle)));
        }
    });
}

struct Prepared {
    loaded: Loaded,
    live: Live,
    served: HashMap<String, Arc<Served>>,
    component: Component,
}

/// Reads, checks, links and instantiates the component.
async fn prepare(request: &LoadRequest) -> std::result::Result<Prepared, String> {
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
    let served = bind_imports(&mut linker, &engine, request, &child).map_err(at)?;
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
    };
    let live = loaded
        .instantiate()
        .await
        .map_err(|e| format!("{}: {e:#}", path.display()))?;
    Ok(Prepared {
        loaded,
        live,
        served,
        component: child,
    })
}

/// Resolves every import of `child` through the request's bindings,
/// checks it, and defines the forwarders the program-served and
/// extension-served ones need. Returns what the program serves, by the
/// import's name.
fn bind_imports(
    linker: &mut Linker<ComponentState>,
    engine: &Engine,
    request: &LoadRequest,
    child: &Component,
) -> std::result::Result<HashMap<String, Arc<Served>>, String> {
    let program_exports: Vec<String> = request
        .caller
        .component_type()
        .exports(engine)
        .filter(|(name, e)| {
            !is_host_interface(name) && matches!(e.ty, ComponentItem::ComponentInstance(_))
        })
        .map(|(name, _)| name.to_string())
        .collect();
    let mut served = HashMap::new();
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
                let resource = check_served(engine, &request.caller, name, &iface, &export)?;
                served.insert(
                    name.to_string(),
                    Arc::new(Served {
                        export,
                        resource,
                        object: Mutex::new(None),
                    }),
                );
                let mut li = linker.instance(name).map_err(|e| format!("{e:#}"))?;
                for (fname, _) in functions(engine, &iface) {
                    let interface: Arc<str> = Arc::from(name);
                    let func: Arc<str> = Arc::from(fname.as_str());
                    let handle = request.handle;
                    li.func_new_concurrent(&fname, move |accessor, _ty, params, results| {
                        let interface = interface.clone();
                        let func = func.clone();
                        Box::pin(async move {
                            forward_callback(accessor, handle, &interface, &func, params, results)
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
                let mut li = linker.instance(name).map_err(|e| format!("{e:#}"))?;
                for (fname, _) in functions(engine, &iface) {
                    let interface: Arc<str> = Arc::from(name);
                    let func: Arc<str> = Arc::from(fname.as_str());
                    let calls = peer.calls.clone();
                    li.func_new_concurrent(&fname, move |accessor, _ty, params, results| {
                        let interface = interface.clone();
                        let func = func.clone();
                        let calls = calls.clone();
                        Box::pin(async move {
                            forward_peer(accessor, &calls, &interface, &func, params, results)
                                .await
                        })
                    })
                    .map_err(|e| format!("{e:#}"))?;
                }
            }
        }
    }
    Ok(served)
}

// ============================================================================
// The host interface
// ============================================================================

impl ComponentState {
    /// Loads `path` as an extension that may import what `imports`
    /// says, on a thread of its own, and returns its handle.
    fn load_extension(
        &mut self,
        path: String,
        imports: Imports,
        options: extensions::LoadOptions,
    ) -> Result<std::result::Result<u32, String>> {
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
        let request = LoadRequest {
            handle: self.extensions.len() as u32 + 1,
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
        };
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || serve(request, tx));
        match rx.recv() {
            Ok(Ok(extension)) => {
                self.extensions.push(Some(extension));
                Ok(Ok(self.extensions.len() as u32))
            }
            Ok(Err(message)) => Ok(Err(message)),
            Err(_) => Ok(Err("the extension's thread vanished".to_string())),
        }
    }
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
    fn load(
        &mut self,
        path: String,
        bindings: Vec<extensions::Binding>,
        options: extensions::LoadOptions,
    ) -> Result<std::result::Result<u32, String>> {
        let bound = bindings
            .into_iter()
            .map(|b| (b.name, b.served_by.into()))
            .collect();
        self.load_extension(path, Imports::Bound(bound), options)
    }

    fn load_trusted(
        &mut self,
        path: String,
        options: extensions::LoadOptions,
    ) -> Result<std::result::Result<u32, String>> {
        self.load_extension(path, Imports::Trusted, options)
    }

    fn drop(&mut self, extension: u32) -> Result<()> {
        self.extensions_granted()?;
        if let Some(slot) = self
            .extensions
            .get_mut(extension.wrapping_sub(1) as usize)
        {
            *slot = None;
        }
        Ok(())
    }
}
