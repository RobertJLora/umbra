use umbra_rust_broker::{BrokerConfig, RuntimeBroker};

// Returning the error from main prints its Debug form, which is what turned
// every carefully written Display impl in broker.rs and runtime.rs into dead
// code: `Error: MissingSharedKey` instead of the sentence naming the two
// variables to set. These lines are the only diagnostics a launchd-started
// broker leaves in its error log, so they print the readable form.
#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("umbra-rust-broker: {error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let config = BrokerConfig::from_env()?;
    RuntimeBroker::new(config).serve().await?;
    Ok(())
}
