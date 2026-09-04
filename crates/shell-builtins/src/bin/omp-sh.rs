//! `omp-sh`: the standalone omp shell binary (`-c command`, script file, or
//! stdin).

use std::{env, io, io::Read as _, mem, process::ExitCode};

use omp_shell::{
	Error, ExecutionExitCode, ProfileLoadBehavior, RcLoadBehavior, Shell, ShellExtensions,
	SourceInfo, builtins,
};
use omp_shell_builtins::{process_builtins, utility_builtins};
use tracing::Instrument as _;

const USAGE: &str = "usage: omp-sh [-c command [name [argument ...]]] [script [argument ...]]";

enum Invocation {
	Command { command: String, name: String, args: Vec<String> },
	Script { path: String, args: Vec<String> },
	Stdin,
}

impl Invocation {
	const fn kind(&self) -> &'static str {
		match self {
			Self::Command { .. } => "command",
			Self::Script { .. } => "script",
			Self::Stdin => "stdin",
		}
	}

	fn parse() -> Result<Self, &'static str> {
		let mut args = env::args().skip(1);
		match args.next() {
			Some(option) if option == "-c" => {
				let Some(command) = args.next() else {
					return Err("omp-sh: -c requires a command string");
				};
				let name = args.next().unwrap_or_else(|| "omp-sh".into());
				Ok(Self::Command { command, name, args: args.collect() })
			},
			Some(option) if option.starts_with('-') => Err("omp-sh: unsupported option"),
			Some(path) => Ok(Self::Script { path, args: args.collect() }),
			None => Ok(Self::Stdin),
		}
	}
}

#[tokio::main]
async fn main() -> ExitCode {
	ExitCode::from(run().await)
}

#[tracing::instrument(
	level = "debug",
	name = "shell_session",
	skip_all,
	fields(invocation = tracing::field::Empty)
)]
async fn run() -> u8 {
	let mut invocation = match Invocation::parse() {
		Ok(invocation) => invocation,
		Err(message) => {
			tracing::warn!("shell invocation rejected");
			eprintln!("{message}\n{USAGE}");
			return 2;
		},
	};
	tracing::Span::current().record("invocation", invocation.kind());

	let reads_stdin = matches!(invocation, Invocation::Stdin);
	let (shell_name, shell_args) = match &mut invocation {
		Invocation::Command { name, args, .. } => (mem::take(name), mem::take(args)),
		Invocation::Script { path, .. } => (path.clone(), Vec::new()),
		Invocation::Stdin => ("omp-sh".into(), Vec::new()),
	};
	let mut shell = match Shell::builder()
		.profile(ProfileLoadBehavior::Skip)
		.rc(RcLoadBehavior::Skip)
		.read_commands_from_stdin(reads_stdin)
		.shell_name(shell_name)
		.shell_args(shell_args)
		.builtins(builtins::default_builtins())
		.builtins(
			utility_builtins()
				.into_iter()
				.map(|(name, reg)| (name.to_owned(), reg)),
		)
		.builtins(
			process_builtins()
				.into_iter()
				.map(|(name, reg)| (name.to_owned(), reg)),
		)
		.build()
		.instrument(tracing::debug_span!("shell_open"))
		.await
	{
		Ok(shell) => shell,
		Err(error) => {
			tracing::error!("shell session initialization failed");
			eprintln!("omp-sh: {error}");
			return u8::from(ExecutionExitCode::from(&error));
		},
	};

	let result = async {
		match invocation {
			Invocation::Command { command, .. } => shell.run_dash_c_command(command).await,
			Invocation::Script { path, args } => shell.run_script(path, args.into_iter()).await,
			Invocation::Stdin => {
				let mut command = String::new();
				if let Err(error) = io::stdin().read_to_string(&mut command) {
					return Err(error.into());
				}
				let params = shell.default_exec_params();
				let result = shell
					.run_string(command, &SourceInfo::from("<stdin>"), &params)
					.await;
				let _ = shell.on_exit().await;
				result
			},
		}
	}
	.instrument(tracing::debug_span!("shell_execute"))
	.await;

	match result {
		Ok(result) => result.exit_code.into(),
		Err(error) => report_error(&shell, error),
	}
}

fn report_error(shell: &Shell<impl ShellExtensions>, error: Error) -> u8 {
	tracing::warn!("shell session operation failed");
	let _ = shell.display_error(&mut io::stderr().lock(), &error);
	error.into_result(shell).exit_code.into()
}
