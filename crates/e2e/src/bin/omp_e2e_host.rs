#![recursion_limit = "256"]

//! Extension-host-capable OMP executable used by cross-crate acceptance proofs.

use std::{env, process::ExitCode};

#[tokio::main]
async fn main() -> ExitCode {
	omp_observability::logging::init();
	if env::args_os()
		.nth(1)
		.is_some_and(|arg| arg == omp_envd::exthost::EXT_HOST_ARG)
	{
		return match omp_envd::exthost::run_ext_host_entry() {
			Ok(()) => ExitCode::SUCCESS,
			Err(error) => {
				eprintln!("omp e2e extension host: {error}");
				ExitCode::FAILURE
			},
		};
	}
	omp_observability::export::init();
	let result = omp_app::run().await;
	omp_observability::export::shutdown();
	match result {
		Ok(()) => ExitCode::SUCCESS,
		Err(error) => {
			eprintln!("{error:?}");
			ExitCode::FAILURE
		},
	}
}
