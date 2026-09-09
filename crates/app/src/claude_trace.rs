//! Opt-in maintainer entry point for bounded provider capture and cassette
//! replay.

use std::{
	fs,
	io::{self, Read as _},
	path::{Path, PathBuf},
};

use clap::Parser;
use miette::{Context as _, IntoDiagnostic as _, Result};
use omp_ai::transport::{CaptureSnapshot, cassette::CassetteReplayDriver};

#[derive(Debug, Parser)]
#[command(name = "claude-trace", about = "Maintainer-only provider cassette utility")]
struct Args {
	/// Capture snapshot JSON file, or `-` for standard input.
	input: PathBuf,
}

fn main() -> Result<()> {
	let encoded = read_bytes(&Args::parse().input)?;
	let snapshot: CaptureSnapshot = serde_json::from_slice(&encoded)
		.into_diagnostic()
		.wrap_err("failed to decode provider capture")?;
	let driver = CassetteReplayDriver::from_capture(&snapshot)
		.into_diagnostic()
		.wrap_err("failed to assemble replay cassette")?;
	println!("replay cassette ready: {} exchange(s)", driver.len());
	Ok(())
}

fn read_bytes(path: &Path) -> Result<Vec<u8>> {
	if path == Path::new("-") {
		let mut bytes = Vec::new();
		io::stdin()
			.read_to_end(&mut bytes)
			.into_diagnostic()
			.wrap_err("failed to read capture from stdin")?;
		return Ok(bytes);
	}
	fs::read(path)
		.into_diagnostic()
		.wrap_err_with(|| format!("failed to read capture {}", path.display()))
}
