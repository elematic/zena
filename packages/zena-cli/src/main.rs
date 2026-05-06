use anyhow::Result;
use clap::{Parser, Subcommand};
use wasmtime::*;
use wasmtime_wasi::WasiCtxBuilder;
use wasmtime_wasi::p1::{self, WasiP1Ctx};

#[derive(Parser, Debug)]
#[command(version, about, long_about = None)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand, Debug)]
enum Commands {
    /// Run a compiled Zena WASM file
    Run {
        /// The optimized .wasm file to run
        file: String,
    },
}

struct MyState {
    wasi: WasiP1Ctx,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Commands::Run { file } => run_wasm(&file),
    }
}

fn run_wasm(file: &str) -> Result<()> {
    let mut config = Config::new();
    config.wasm_gc(true);
    config.wasm_function_references(true);
    config.wasm_exceptions(true);

    let engine = Engine::new(&config)?;
    let module = Module::from_file(&engine, file)?;

    let mut linker: Linker<MyState> = Linker::new(&engine);
    p1::add_to_linker_sync(&mut linker, |state| &mut state.wasi)?;

    let wasi = WasiCtxBuilder::new()
        .inherit_stdio()
        .inherit_env()
        .inherit_args()
        .build_p1();

    let mut store = Store::new(&engine, MyState { wasi });

    let instance = linker.instantiate(&mut store, &module)?;

    // Zena programs usually export "main"
    let main_export = instance
        .get_func(&mut store, "main")
        .expect("failed to find `main` export");
    let results_count = main_export.ty(&store).results().len();
    let mut results = vec![Val::I32(0); results_count];

    main_export.call(&mut store, &[], &mut results)?;

    if let Some(res) = results.first() {
        match res {
            Val::I32(i) => println!("{}", i),
            Val::I64(i) => println!("{}", i),
            Val::F32(f) => println!("{}", f),
            Val::F64(f) => println!("{}", f),
            _ => println!("{:?}", res),
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholder_test() {
        // Assert that true is true to ensure the test harness is running
        assert!(true);
    }
}
