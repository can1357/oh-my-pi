//! Real Apple Foundation Models availability and generation smoke path.

use std::{error, io};

use futures::StreamExt;
use omp_ai::local::applefm::{AppleFm, AppleFmEvent, AppleFmOptions};

#[tokio::main]
async fn main() -> Result<(), Box<dyn error::Error>> {
	let evidence = AppleFm::availability_evidence().await?;
	println!("Apple Foundation Models availability: {evidence:?}");
	if !matches!(evidence.state, omp_ai::local::applefm::AppleFmSupportState::Available) {
		println!("Apple Foundation Models unavailable: {evidence:?}");
		return Ok(());
	}
	let model = AppleFm::load().await?;
	let mut stream = model.stream(
		AppleFmOptions::new("Reply with exactly: available")
			.system_prompt("Follow the user's response-format instruction exactly.")
			.max_tokens(8),
	)?;
	let mut finished = false;
	while let Some(event) = stream.next().await {
		match event? {
			AppleFmEvent::Delta(delta) => print!("{delta}"),
			AppleFmEvent::Finished(generation) => {
				finished = true;
				println!(
					"\nusage_estimate prompt={} completion={} context={}",
					generation.prompt_tokens_estimated,
					generation.completion_tokens_estimated,
					generation.context_size_documented,
				);
			},
		}
	}
	if !finished {
		return Err(
			io::Error::new(
				io::ErrorKind::UnexpectedEof,
				"Apple Foundation Models stream ended before Finished",
			)
			.into(),
		);
	}
	Ok(())
}
