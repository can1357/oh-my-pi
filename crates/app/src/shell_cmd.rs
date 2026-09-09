//! Persistent native brush-core shell console.

use std::{
	env,
	io::{self, IsTerminal as _, Write as _},
	time::Duration,
};

use miette::{IntoDiagnostic as _, miette};
use omp_shell::{ProfileLoadBehavior, RcLoadBehavior, Shell, SourceInfo, builtins};
use omp_shell_builtins::{process_builtins, utility_builtins};
use tokio_util::sync::CancellationToken;

use crate::cli::ShellCliArgs;

/// Runs the persistent native shell console on an interactive terminal.
pub(crate) async fn run(args: ShellCliArgs) -> miette::Result<()> {
	let profile = if args.no_snapshot {
		ProfileLoadBehavior::Skip
	} else {
		ProfileLoadBehavior::LoadDefault
	};
	let rc = if args.no_snapshot {
		RcLoadBehavior::Skip
	} else {
		RcLoadBehavior::LoadDefault
	};
	if !io::stdin().is_terminal() {
		return Err(miette!("shell console requires an interactive TTY"));
	}
	if let Some(cwd) = args.cwd {
		env::set_current_dir(cwd).into_diagnostic()?;
	}
	let mut shell = Shell::builder()
		.profile(profile)
		.rc(rc)
		.interactive(true)
		.shell_name("omp-shell".to_owned())
		.builtins(builtins::default_builtins())
		.builtins(
			utility_builtins()
				.into_iter()
				.map(|(name, registration)| (name.to_owned(), registration)),
		)
		.builtins(
			process_builtins()
				.into_iter()
				.map(|(name, registration)| (name.to_owned(), registration)),
		)
		.build()
		.await
		.into_diagnostic()?;
	println!("Type .help for commands.");
	let source = SourceInfo::from("<omp-shell>");
	loop {
		print!("omp shell> ");
		io::stdout().flush().into_diagnostic()?;
		let mut line = String::new();
		if io::stdin().read_line(&mut line).into_diagnostic()? == 0 {
			break;
		}
		let line = line.trim();
		if line.is_empty() {
			continue;
		}
		if matches!(line, ".exit" | "exit" | "quit") {
			break;
		}
		if line == ".help" {
			println!(
				".help  show help\n.exit  exit the console\nCommands execute in one persistent native \
				 shell."
			);
			continue;
		}
		let mut params = shell.default_exec_params();
		let cancellation = CancellationToken::new();
		params.set_cancel_token(cancellation.clone());
		let result = {
			let future = shell.run_string(line.to_owned(), &source, &params);
			tokio::pin!(future);
			if let Some(milliseconds) = args.timeout_ms {
				match tokio::time::timeout(Duration::from_millis(milliseconds), &mut future).await {
					Ok(result) => result,
					Err(_) => {
						cancellation.cancel();
						let _ = tokio::time::timeout(Duration::from_secs(2), &mut future).await;
						eprintln!("command timed out");
						continue;
					},
				}
			} else {
				future.await
			}
		};
		if let Err(error) = result {
			shell
				.display_error(&mut io::stderr().lock(), &error)
				.into_diagnostic()?;
		}
	}
	let _ = shell.on_exit().await;
	Ok(())
}
