//! Spike for #593: a Zena component (the caller) calls an export of a
//! second component (the child) through its own import, and the child
//! calls one of its imports, which the host serves by calling an export
//! of the caller while the caller's call is still in flight.
//!
//! The child runs in a store of its own, on a thread of its own, and the
//! two stores talk over channels. The caller's forwarder is a concurrent
//! host function, so the caller's event loop keeps running while it
//! waits; a call back from the child is served by a task the forwarder
//! spawns in the caller's store, so wasmtime sees a fresh entry into the
//! caller's instance, with no parent task, and lets it in.
//!
//! Run from the repository root:
//!
//! ```text
//! cargo run --release -p zena-runtime --example components_spike -- \
//!     packages/zena-runtime/examples/components-spike/out/caller.wasm \
//!     packages/zena-runtime/examples/components-spike/out/child.wasm
//! ```

use std::sync::Arc;
use tokio::sync::{mpsc, oneshot};
use wasmtime::component::types::ComponentItem;
use wasmtime::component::{
    Accessor, AccessorTask, Component, ComponentExportIndex, Func, Instance, Linker, ResourceTable,
    Val,
};
use wasmtime::{AsContextMut, Engine, Result, Store, bail, format_err};
use wasmtime_wasi::{WasiCtx, WasiCtxBuilder, WasiCtxView, WasiView};

/// One call of the caller into the child: which export, its arguments
/// (the installation stripped), where the result goes, and where the
/// child's calls back go while this call runs.
struct ChildCall {
    func: String,
    params: Vec<Val>,
    reply: oneshot::Sender<Result<Vec<Val>>>,
    callbacks: mpsc::UnboundedSender<Callback>,
}

/// One call of the child into the caller.
struct Callback {
    func: String,
    params: Vec<Val>,
    reply: oneshot::Sender<Result<Vec<Val>>>,
}

struct ChildState {
    /// Where the child's import calls go, set for the duration of a call.
    callbacks: Option<mpsc::UnboundedSender<Callback>>,
}

struct CallerState {
    wasi: WasiCtx,
    table: ResourceTable,
    instance: Option<Instance>,
    child: mpsc::UnboundedSender<ChildCall>,
}

impl WasiView for CallerState {
    fn ctx(&mut self) -> WasiCtxView<'_> {
        WasiCtxView {
            ctx: &mut self.wasi,
            table: &mut self.table,
        }
    }
}

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

/// Starts the child on its own thread and returns the channel its calls
/// arrive on.
fn start_child(engine: Engine, component: Component) -> Result<mpsc::UnboundedSender<ChildCall>> {
    let (tx, mut rx) = mpsc::unbounded_channel::<ChildCall>();
    let mut linker = Linker::<ChildState>::new(&engine);
    // Every import of the child becomes a host function that forwards the
    // call to the caller through the channel of the call in flight.
    let ty = component.component_type();
    for (name, import) in ty.imports(&engine) {
        let ComponentItem::ComponentInstance(iface) = import.ty else {
            continue;
        };
        let mut li = linker.instance(name)?;
        for (fname, item) in iface.exports(&engine) {
            let ComponentItem::ComponentFunc(_) = item.ty else {
                continue;
            };
            let func_name: Arc<str> = Arc::from(fname);
            li.func_new_concurrent(fname, move |accessor, _ty, params, results| {
                let func_name = func_name.clone();
                Box::pin(async move {
                    let sender = accessor
                        .with(|mut a| a.get().callbacks.clone())
                        .ok_or_else(|| format_err!("no call in flight"))?;
                    let (reply, answer) = oneshot::channel();
                    sender
                        .send(Callback {
                            func: func_name.to_string(),
                            params: params.to_vec(),
                            reply,
                        })
                        .map_err(|_| format_err!("the caller went away"))?;
                    let vals = answer
                        .await
                        .map_err(|_| format_err!("the callback was dropped"))??;
                    for (slot, val) in results.iter_mut().zip(vals) {
                        *slot = val;
                    }
                    Ok(())
                })
            })?;
        }
    }
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let outcome: Result<()> = rt.block_on(async {
            let mut store = Store::new(&engine, ChildState { callbacks: None });
            let instance = linker.instantiate_async(&mut store, &component).await?;
            while let Some(call) = rx.recv().await {
                store.data_mut().callbacks = Some(call.callbacks);
                let served = async {
                    let func =
                        export_func(&mut store, &instance, "spike:child/ops@0.1.0", &call.func)?;
                    let count = func.ty(&store).results().len();
                    let mut results = vec![Val::Bool(false); count];
                    store
                        .run_concurrent(async |accessor| {
                            func.call_concurrent(accessor, &call.params, &mut results)
                                .await
                        })
                        .await??;
                    Ok(results)
                }
                .await;
                store.data_mut().callbacks = None;
                let _ = call.reply.send(served);
            }
            Ok(())
        });
        if let Err(e) = outcome {
            eprintln!("child thread: {e:?}");
        }
    });
    Ok(tx)
}

/// Serves one call back from the child: a task of the caller's store,
/// started with no parent, so entering the caller's instance is a new
/// task rather than a re-entry.
struct ServeCallback {
    installation: u32,
    callback: Callback,
}

impl AccessorTask<CallerState> for ServeCallback {
    async fn run(self, accessor: &Accessor<CallerState>) -> Result<()> {
        let Callback {
            func,
            params,
            reply,
        } = self.callback;
        let served = async {
            let callee = accessor.with(|mut a| {
                let instance = a.get().instance.ok_or_else(|| format_err!("no instance"))?;
                let mut store = a.as_context_mut();
                let iface = instance
                    .get_export_index(&mut store, None, "spike:child/callbacks@0.1.0")
                    .ok_or_else(|| format_err!("the caller exports no callbacks"))?;
                let idx = instance
                    .get_export_index(&mut store, Some(&iface), &func)
                    .ok_or_else(|| format_err!("the caller exports no {func}"))?;
                let f = instance
                    .get_func(&mut store, idx)
                    .ok_or_else(|| format_err!("{func} is not a function"))?;
                let count = f.ty(&store).results().len();
                Ok::<_, wasmtime::Error>((f, count))
            })?;
            let (callee, count) = callee;
            let mut full = Vec::with_capacity(params.len() + 1);
            full.push(Val::U32(self.installation));
            full.extend(params);
            let mut results = vec![Val::Bool(false); count];
            callee
                .call_concurrent(accessor, &full, &mut results)
                .await?;
            Ok(results)
        }
        .await;
        let _ = reply.send(served);
        Ok(())
    }
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let [_, caller_path, child_path] = args.as_slice() else {
        bail!("usage: components_spike <caller.wasm> <child.wasm>");
    };
    let engine =
        zena_runtime::engine::shared_component_engine(false).map_err(|e| format_err!("{e:#}"))?;
    let caller = Component::from_file(&engine, caller_path)?;
    let child = Component::from_file(&engine, child_path)?;
    let child_tx = start_child(engine.clone(), child)?;

    let mut linker = Linker::<CallerState>::new(&engine);
    wasmtime_wasi::p3::add_to_linker(&mut linker)?;
    // Every import that is not WASI is an extension interface: each of
    // its functions takes the installation first and forwards the rest.
    let ty = caller.component_type();
    for (name, import) in ty.imports(&engine) {
        if name.starts_with("wasi:") {
            continue;
        }
        let ComponentItem::ComponentInstance(iface) = import.ty else {
            continue;
        };
        let mut li = linker.instance(name)?;
        for (fname, item) in iface.exports(&engine) {
            let ComponentItem::ComponentFunc(_) = item.ty else {
                continue;
            };
            let func_name: Arc<str> = Arc::from(fname);
            li.func_new_concurrent(fname, move |accessor, _ty, params, results| {
                let func_name = func_name.clone();
                Box::pin(async move {
                    let installation = match params.first() {
                        Some(Val::U32(h)) => *h,
                        _ => bail!("the first parameter is not an installation"),
                    };
                    let child = accessor.with(|mut a| a.get().child.clone());
                    let (callbacks_tx, mut callbacks_rx) = mpsc::unbounded_channel();
                    let (reply, mut answer) = oneshot::channel();
                    child
                        .send(ChildCall {
                            func: func_name.to_string(),
                            params: params[1..].to_vec(),
                            reply,
                            callbacks: callbacks_tx,
                        })
                        .map_err(|_| format_err!("the child is gone"))?;
                    loop {
                        tokio::select! {
                            answered = &mut answer => {
                                let vals = answered
                                    .map_err(|_| format_err!("the child dropped the call"))??;
                                for (slot, val) in results.iter_mut().zip(vals) {
                                    *slot = val;
                                }
                                return Ok(());
                            }
                            Some(callback) = callbacks_rx.recv() => {
                                // SPIKE_DIRECT=1 serves the callback from this
                                // task, whose parent chain includes the caller.
                                if std::env::var_os("SPIKE_DIRECT").is_some() {
                                    ServeCallback { installation, callback }.run(accessor).await?;
                                } else {
                                    accessor.with(|mut a| {
                                        a.spawn(ServeCallback { installation, callback })
                                    })?;
                                }
                            }
                        }
                    }
                })
            })?;
        }
    }

    let wasi = WasiCtxBuilder::new().inherit_stdio().build();
    let mut store = Store::new(
        &engine,
        CallerState {
            wasi,
            table: ResourceTable::new(),
            instance: None,
            child: child_tx,
        },
    );
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    rt.block_on(async {
        let instance = linker.instantiate_async(&mut store, &caller).await?;
        store.data_mut().instance = Some(instance);
        let main = instance
            .get_func(&mut store, "main")
            .ok_or_else(|| format_err!("no main"))?;
        store
            .run_concurrent(async |accessor| main.call_concurrent(accessor, &[], &mut []).await)
            .await??;
        Ok::<(), wasmtime::Error>(())
    })?;
    println!("done");
    Ok(())
}
