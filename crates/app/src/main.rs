#![recursion_limit = "256"]

//! OMP command-line entry point.

use std::{env, panic, process::ExitCode};

#[cfg(windows)]
use windows_sys::Win32::System::Console;

fn process_bootstrap() {
	omp_http::install_tls_provider();
	// Safety: this runs as the first statement in `main`, before OMP starts any
	// daemon, worker, or application thread that could concurrently read env.
	unsafe {
		env::remove_var("MallocStackLogging");
		env::remove_var("MallocStackLoggingNoCompact");
	}
	set_process_title();
}

#[cfg(any(target_os = "macos", target_os = "ios", target_os = "freebsd"))]
fn set_process_title() {
	// Safety: `c\"omp\"` is static, NUL terminated, and valid for setprogname.
	unsafe { libc::setprogname(c"omp".as_ptr()) };
}

#[cfg(target_os = "linux")]
fn set_process_title() {
	// Safety: PR_SET_NAME reads at most sixteen bytes from this static C string.
	unsafe {
		libc::prctl(libc::PR_SET_NAME, c"omp".as_ptr());
	}
}

#[cfg(windows)]
fn set_process_title() {
	let title = "omp\0".encode_utf16().collect::<Vec<_>>();
	// Safety: `title` is NUL terminated and remains alive for the call.
	unsafe {
		Console::SetConsoleTitleW(title.as_ptr());
	}
}

#[cfg(not(any(
	target_os = "macos",
	target_os = "ios",
	target_os = "freebsd",
	target_os = "linux",
	windows
)))]
fn set_process_title() {}

fn install_panic_hook() {
	panic::set_hook(Box::new(|info| {
		tracing::error!(target: "omp", panic = %info, "panic");
		eprintln!("\x1b[31momp internal error:\x1b[0m {info}");
	}));
}

#[tokio::main]
async fn main() -> ExitCode {
	process_bootstrap();
	omp_observability::logging::init();
	install_panic_hook();
	if env::args_os()
		.nth(1)
		.is_some_and(|arg| arg == omp_sandbox::HIDDEN_CHILD_ARG)
	{
		return match omp_sandbox::run_child_entry() {
			Ok(()) => ExitCode::SUCCESS,
			Err(error) => {
				eprintln!("omp sandbox child: {error}");
				ExitCode::FAILURE
			},
		};
	}
	if env::args_os()
		.nth(1)
		.is_some_and(|arg| arg == omp_envd::EVAL_CHILD_ARG)
	{
		return match omp_envd::run_eval_child_entry().await {
			Ok(()) => ExitCode::SUCCESS,
			Err(error) => {
				eprintln!("omp eval child: {error}");
				ExitCode::FAILURE
			},
		};
	}
	if env::args_os()
		.nth(1)
		.is_some_and(|arg| arg == omp_envd::shell_child::SHELL_CHILD_ARG)
	{
		return match omp_envd::shell_child::run_shell_child_entry().await {
			Ok(code) => code,
			Err(error) => {
				eprintln!("omp shell child: {error}");
				ExitCode::FAILURE
			},
		};
	}
	if env::args_os()
		.nth(1)
		.is_some_and(|arg| arg == omp_envd::exthost::EXT_HOST_ARG)
	{
		return match omp_envd::exthost::run_ext_host_entry() {
			Ok(()) => ExitCode::SUCCESS,
			Err(error) => {
				eprintln!("omp extension host: {error}");
				ExitCode::FAILURE
			},
		};
	}
	omp_observability::export::init();
	omp_app::startup_notice::start_watchdog();
	let result = omp_app::run().await;
	omp_app::startup_notice::stop_watchdog();
	omp_observability::export::shutdown();
	match result {
		Ok(()) => ExitCode::SUCCESS,
		Err(error) => {
			// A signal already committed its durable exit diagnostic. Preserve
			// the shell status without printing a second, misleading failure.
			// Usage diagnostics are stack-free and carry their explicit status.
			if let Some(signal) = error.downcast_ref::<omp_app::exit_diagnostics::SignalExit>() {
				ExitCode::from(signal.exit_code())
			} else if error
				.downcast_ref::<omp_app::print_mode::PrintFailure>()
				.is_some()
			{
				ExitCode::FAILURE
			} else if let Some(usage) = error.downcast_ref::<omp_app::usage_error::CliUsageError>() {
				if usage.lowercase() {
					eprintln!("error: {usage}");
				} else {
					eprintln!("Error: {usage}");
				}
				ExitCode::from(usage.exit_code())
			} else if let Some(extension) =
				error.downcast_ref::<omp_app::ext_cli::ExtensionCliFailure>()
			{
				eprintln!("{error:?}");
				ExitCode::from(extension.exit_code())
			} else if let Some(interrupt) =
				error.downcast_ref::<omp_app::ext_cli::ExtensionInterrupt>()
			{
				ExitCode::from(interrupt.exit_code())
			} else {
				eprintln!("{error:?}");
				ExitCode::FAILURE
			}
		},
	}
}
