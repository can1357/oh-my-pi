//! Standalone Git repository inspection command.

use std::{env, path::PathBuf, process::Command};

use clap::Args;
use miette::{IntoDiagnostic as _, miette};

/// Arguments for repository inspection.
#[derive(Args, Clone, Debug)]
pub struct GitArgs {
	/// Inspect one commit (any revision, e.g. HEAD~2 or a sha).
	pub revision: Option<String>,
	/// Run in another directory.
	#[arg(short = 'C', value_name = "DIR")]
	pub dir:      Option<PathBuf>,
}

/// Prints Git's canonical status or one revision summary.
pub async fn run(args: GitArgs) -> miette::Result<()> {
	let cwd = match args.dir {
		Some(path) => path,
		None => env::current_dir().into_diagnostic()?,
	};
	let mut command = Command::new("git");
	command.current_dir(&cwd);
	if let Some(revision) = args.revision {
		command.args(["show", "--stat", "--oneline", "--decorate", &revision]);
	} else {
		command.args(["status", "--short", "--branch"]);
	}
	let output = command.output().into_diagnostic()?;
	if !output.status.success() {
		let stderr = String::from_utf8_lossy(&output.stderr);
		return Err(miette!("git inspection failed: {}", stderr.trim()));
	}
	print!("{}", String::from_utf8_lossy(&output.stdout));
	Ok(())
}
