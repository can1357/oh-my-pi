//! `pkill` process-signalling builtin moved from `pi-shell`.

use clap::Parser;

use crate::{
	host::{ProcContext, Process},
	proc_match,
};

/// Selects processes by name or attributes and sends them a signal.
#[derive(Parser)]
#[command(disable_help_flag = true, disable_version_flag = true)]
pub(crate) struct PkillCommand {
	/// Arguments interpreted by the shared process-matching engine.
	#[arg(num_args = 0.., trailing_var_arg = true, allow_hyphen_values = true)]
	argv: Vec<String>,
}

impl Process for PkillCommand {
	const USES_PATHS: bool = true;

	fn run(&self, context: &ProcContext) -> impl Future<Output = std::io::Result<i32>> + Send {
		proc_match::run(proc_match::ProcMatchMode::Kill, &self.argv, context)
	}
}

#[cfg(test)]
mod tests {
	use super::PkillCommand;
	use crate::host::run_proc;

	const NO_MATCH: &str = "^__pi_pkill_test_no_such_process_6f239a1d__$";

	async fn run(args: &[&str]) -> i32 {
		let argv: Vec<&str> = std::iter::once("pkill").chain(args.iter().copied()).chain([NO_MATCH]).collect();
		run_proc::<PkillCommand>(&argv, None).await.0
	}

	#[tokio::test]
	async fn exits_one_when_no_process_matches() {
		assert_eq!(run(&[]).await, 1);
	}

	#[tokio::test]
	async fn accepts_a_signal_name() {
		assert_eq!(run(&["-TERM"]).await, 1);
	}

	#[tokio::test]
	async fn accepts_a_signal_number() {
		assert_eq!(run(&["-9"]).await, 1);
	}

	#[test]
	fn signal_operands_resolve_to_numbers() {
		use crate::proc_match::signal_number;

		assert_eq!(signal_number("TERM"), Some(15));
		assert_eq!(signal_number("SIGKILL"), Some(9));
		assert_eq!(signal_number("sigint"), Some(2));
		assert_eq!(signal_number("hup"), Some(1));
		assert_eq!(signal_number("0"), Some(0));
		assert_eq!(signal_number("EXIT"), Some(0));
		assert_eq!(signal_number("NOPE"), None);
		assert_eq!(signal_number("-1"), None);
	}
}
