use umbra_rust_broker::{BrokerConfig, RuntimeBroker};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = BrokerConfig::from_env()?;
    RuntimeBroker::new(config).serve().await?;
    Ok(())
}
