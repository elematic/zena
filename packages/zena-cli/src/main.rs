use anyhow::Result;
use clap::Parser;

#[derive(Parser, Debug)]
#[command(version, about, long_about = None)]
struct Args {
    /// The Zena file to run
    #[arg(required = true)]
    file: String,
}

fn main() -> Result<()> {
    let args = Args::parse();
    println!("Zena CLI will run file: {}", args.file);
    // TODO: Setup Wasmtime, compile or load the Zena self-hosted compiler,
    // and provide custom host services (process spawn, stack traces).

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
