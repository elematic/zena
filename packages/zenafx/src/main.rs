//! `zenafx` (`zfx`): graphical runtime for Zena WebAssembly components.
//!
//! Hosts the OS window event loop on the main thread via `winit` (required by
//! macOS/AppKit) and executes Wasm components on a Tokio worker thread with
//! full support for WasmGC, exception handling, `wasi:webgpu`, and `wasi-gfx:surface`.

use std::path::Path;
use std::sync::Arc;

use anyhow::Result;
use clap::Parser;
use frame_buffer_wasmtime::{FrameBufferCtx, FrameBufferCtxView};
use surface_wasmtime::{
    SurfaceCtx, SurfaceCtxView, SurfaceFrameBufferCtx, SurfaceFrameBufferCtxView, SurfaceWebgpuCtx,
    SurfaceWebgpuCtxView, winit::WasiWinitEventLoopProxy,
};
use wasi_webgpu_wasmtime::reexports::{wgpu_core, wgpu_types};
use wasi_webgpu_wasmtime::{WasiWebGpuCtx, WasiWebGpuCtxView, WasiWebGpuOptions};
use wasmtime::{
    Config, Engine, Store,
    component::{Component, Linker},
};
use wasmtime_wasi::{ResourceTable, WasiCtx, WasiCtxBuilder, WasiCtxView, WasiView};

#[derive(Parser, Debug)]
#[command(version, about, long_about = None)]
struct Cli {
    /// Turn off Cranelift's inlining, so backtraces name the function that trapped
    #[arg(short = 'g', long = "debug")]
    debug: bool,

    /// The exported function to call (default: "start", then tries "run", "main")
    #[arg(long)]
    invoke: Option<String>,

    /// The .wasm component file to run
    file: String,

    /// Arguments passed to the program
    #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
    args: Vec<String>,
}

struct HostState {
    instance: Arc<wgpu_core::global::Global>,
    webgpu_options: WasiWebGpuOptions,
    main_thread_proxy: Arc<WasiWinitEventLoopProxy>,
}

impl HostState {
    fn new(main_thread_proxy: WasiWinitEventLoopProxy) -> Self {
        Self {
            instance: Arc::new(wgpu_core::global::Global::new(
                "webgpu",
                wgpu_types::InstanceDescriptor {
                    backends: wgpu_types::Backends::all(),
                    flags: wgpu_types::InstanceFlags::from_build_config(),
                    backend_options: Default::default(),
                    memory_budget_thresholds: Default::default(),
                    display: None,
                },
                None,
            )),
            webgpu_options: WasiWebGpuOptions::default(),
            main_thread_proxy: Arc::new(main_thread_proxy),
        }
    }

    fn add_workload(&self, wasi: WasiCtx) -> WorkloadState {
        WorkloadState {
            table: ResourceTable::new(),
            wasi,
            instance: Arc::clone(&self.instance),
            webgpu_options: self.webgpu_options.clone(),
            main_thread_proxy: Arc::clone(&self.main_thread_proxy),
        }
    }
}

struct WorkloadState {
    table: ResourceTable,
    wasi: WasiCtx,
    instance: Arc<wgpu_core::global::Global>,
    webgpu_options: WasiWebGpuOptions,
    main_thread_proxy: Arc<WasiWinitEventLoopProxy>,
}

impl wasmtime::component::HasData for WorkloadState {
    type Data<'a> = &'a mut WorkloadState;
}

impl WasiView for WorkloadState {
    fn ctx(&mut self) -> WasiCtxView<'_> {
        WasiCtxView {
            ctx: &mut self.wasi,
            table: &mut self.table,
        }
    }
}

impl WasiWebGpuCtxView for WorkloadState {
    fn webgpu_ctx(&mut self) -> WasiWebGpuCtx<'_> {
        WasiWebGpuCtx {
            instance: &self.instance,
            table: &mut self.table,
            options: &self.webgpu_options,
        }
    }
}

impl FrameBufferCtxView for WorkloadState {
    fn frame_buffer_ctx<'a>(&'a mut self) -> FrameBufferCtx<'a> {
        FrameBufferCtx {
            table: &mut self.table,
        }
    }
}

impl SurfaceCtxView for WorkloadState {
    type Spawner = WasiWinitEventLoopProxy;
    fn surface_ctx(&mut self) -> SurfaceCtx<'_, WasiWinitEventLoopProxy> {
        SurfaceCtx {
            table: &mut self.table,
            main_thread_spawner: &self.main_thread_proxy,
        }
    }
}

impl SurfaceWebgpuCtxView for WorkloadState {
    type Spawner = WasiWinitEventLoopProxy;
    fn surface_webgpu_ctx(&mut self) -> SurfaceWebgpuCtx<'_, WasiWinitEventLoopProxy> {
        SurfaceWebgpuCtx {
            table: &mut self.table,
            instance: &self.instance,
            main_thread_spawner: &self.main_thread_proxy,
        }
    }
}

impl SurfaceFrameBufferCtxView for WorkloadState {
    type Spawner = WasiWinitEventLoopProxy;
    fn surface_frame_buffer_ctx(&mut self) -> SurfaceFrameBufferCtx<'_, WasiWinitEventLoopProxy> {
        SurfaceFrameBufferCtx {
            table: &mut self.table,
            instance: &self.instance,
            main_thread_spawner: &self.main_thread_proxy,
        }
    }
}

fn configure_engine(debug: bool) -> Result<Engine> {
    // Start with Zena's engine config (GC, exceptions, tail calls, typed fn references)
    let mut config: Config = zena_runtime::engine::config(debug);
    // Enable component model & component model async for wasi-gfx
    config.wasm_component_model(true);
    config.wasm_component_model_async(true);
    Ok(Engine::new(&config)?)
}

fn main() -> Result<()> {
    env_logger::builder()
        .filter_level(log::LevelFilter::Info)
        .init();

    let cli = Cli::parse();
    let path = Path::new(&cli.file);
    if !path.exists() {
        anyhow::bail!("File not found: {}", cli.file);
    }

    let (main_thread_loop, main_thread_proxy) =
        surface_wasmtime::winit::create_wasi_winit_event_loop();
    let host_state = HostState::new(main_thread_proxy);

    let engine = configure_engine(cli.debug)?;
    let mut linker: Linker<WorkloadState> = Linker::new(&engine);

    // Register wasi-gfx host interfaces
    wasi_webgpu_wasmtime::add_to_linker(&mut linker)?;
    frame_buffer_wasmtime::add_to_linker(&mut linker)?;
    surface_wasmtime::add_all_to_linker(&mut linker)?;

    // Register WASI preview 2
    wasmtime_wasi::p2::add_to_linker_async(&mut linker)?;

    // Convenience root/example print helper used by wasi-gfx example apps
    linker
        .root()
        .func_wrap("print", |_caller, (msg,): (String,)| {
            println!("{msg}");
            Ok(())
        })
        .ok();

    let mut wasi_builder = WasiCtxBuilder::new();
    wasi_builder.inherit_stdio().inherit_env();
    let mut guest_args = vec![cli.file.clone()];
    guest_args.extend_from_slice(&cli.args);
    wasi_builder.args(&guest_args);
    let wasi_ctx = wasi_builder.build();

    let workload_state = host_state.add_workload(wasi_ctx);
    let mut store = Store::new(&engine, workload_state);

    let component = Component::from_file(&engine, path)
        .map_err(|e| anyhow::anyhow!("failed to load component from {}: {e}", cli.file))?;

    let invoke_fn = cli.invoke.clone();

    // Spawn a Tokio runtime on a background thread to run the asynchronous Wasm component
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("failed to create Tokio runtime");

        rt.block_on(async move {
            let instance = match linker.instantiate_async(&mut store, &component).await {
                Ok(inst) => inst,
                Err(e) => {
                    eprintln!("Instantiation failed: {e:?}");
                    return;
                }
            };

            // Determine which export to call
            let candidate_names: Vec<&str> = if let Some(ref name) = invoke_fn {
                vec![name.as_str()]
            } else {
                vec!["start", "run", "main"]
            };

            let mut called = false;
            for name in &candidate_names {
                if let Some(func) = instance.get_func(&mut store, name) {
                    if let Ok(typed) = func.typed::<(), ()>(&store) {
                        called = true;
                        if let Err(e) = typed.call_async(&mut store, ()).await {
                            eprintln!("Execution error in `{name}`: {e:?}");
                        }
                        break;
                    }
                }
            }

            if !called {
                eprintln!(
                    "No callable nullary function found among: {candidate_names:?}. \
                     Available exports may be sub-interfaces."
                );
            }
        });
    });

    // Run the main thread window event loop (blocks until window is closed)
    main_thread_loop.run();

    Ok(())
}
