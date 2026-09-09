use im::HashMap;

use super::*;
use crate::{
	ShellExtensions,
	builtins::{self, builtin, decl_builtin, raw_arg_builtin, simple_builtin},
};

/// Returns the Bash-compatible builtins installed in a new shell.
#[allow(clippy::too_many_lines, reason = "one registration per builtin")]
pub fn default_builtins<SE: ShellExtensions>() -> HashMap<String, builtins::Registration<SE>> {
	let mut builtins = HashMap::new();

	builtins.insert("break".into(), builtin::<break_::BreakCommand, SE>().special());
	builtins.insert(":".into(), simple_builtin::<colon::ColonCommand, SE>().special());
	builtins.insert("continue".into(), builtin::<continue_::ContinueCommand, SE>().special());
	builtins.insert(".".into(), builtin::<dot::DotCommand, SE>().special());
	builtins.insert("eval".into(), builtin::<eval::EvalCommand, SE>().special());
	#[cfg(unix)]
	builtins.insert("exec".into(), builtin::<exec::ExecCommand, SE>().special());
	builtins.insert("exit".into(), builtin::<exit::ExitCommand, SE>().special());
	builtins.insert("export".into(), decl_builtin::<export::ExportCommand, SE>().special());
	builtins.insert("return".into(), builtin::<return_::ReturnCommand, SE>().special());
	builtins.insert("set".into(), builtin::<set::SetCommand, SE>().special());
	builtins.insert("shift".into(), builtin::<shift::ShiftCommand, SE>().special());
	builtins.insert("trap".into(), builtin::<trap::TrapCommand, SE>().special());
	builtins.insert("unset".into(), builtin::<unset::UnsetCommand, SE>().special());
	builtins.insert("readonly".into(), decl_builtin::<declare::DeclareCommand, SE>().special());
	builtins.insert("times".into(), builtin::<times::TimesCommand, SE>().special());
	builtins.insert("source".into(), builtin::<dot::DotCommand, SE>().special());

	builtins.insert("alias".into(), builtin::<alias::AliasCommand, SE>());
	builtins.insert("bg".into(), builtin::<bg::BgCommand, SE>());
	builtins.insert("bind".into(), builtin::<bind::BindCommand, SE>());
	builtins.insert("cd".into(), builtin::<cd::CdCommand, SE>());
	builtins.insert("command".into(), builtin::<command::CommandCommand, SE>());
	builtins.insert("complete".into(), builtin::<complete::CompleteCommand, SE>());
	builtins.insert("compgen".into(), builtin::<complete::CompGenCommand, SE>());
	builtins.insert("compopt".into(), builtin::<complete::CompOptCommand, SE>());
	builtins.insert("false".into(), simple_builtin::<false_::FalseCommand, SE>());
	builtins.insert("fc".into(), builtin::<fc::FcCommand, SE>());
	builtins.insert("fg".into(), builtin::<fg::FgCommand, SE>());
	builtins.insert("getopts".into(), builtin::<getopts::GetOptsCommand, SE>());
	builtins.insert("hash".into(), builtin::<hash::HashCommand, SE>());
	builtins.insert("help".into(), builtin::<help::HelpCommand, SE>());
	builtins.insert("history".into(), builtin::<history::HistoryCommand, SE>());
	builtins.insert("jobs".into(), builtin::<jobs::JobsCommand, SE>());
	#[cfg(any(unix, windows))]
	builtins.insert("kill".into(), builtin::<kill::KillCommand, SE>());
	builtins.insert("local".into(), decl_builtin::<declare::DeclareCommand, SE>());
	builtins.insert("pwd".into(), builtin::<pwd::PwdCommand, SE>());
	builtins.insert("read".into(), builtin::<read::ReadCommand, SE>());
	builtins.insert("true".into(), simple_builtin::<true_::TrueCommand, SE>());
	builtins.insert("type".into(), builtin::<type_::TypeCommand, SE>());
	#[cfg(unix)]
	builtins.insert("ulimit".into(), builtin::<ulimit::ULimitCommand, SE>());
	#[cfg(unix)]
	builtins.insert("umask".into(), builtin::<umask::UmaskCommand, SE>());
	builtins.insert("unalias".into(), builtin::<unalias::UnaliasCommand, SE>());
	builtins.insert("wait".into(), builtin::<wait::WaitCommand, SE>());
	builtins.insert("builtin".into(), raw_arg_builtin::<builtin_::BuiltinCommand, SE>());
	builtins.insert("declare".into(), decl_builtin::<declare::DeclareCommand, SE>());
	builtins.insert("echo".into(), builtin::<echo::EchoCommand, SE>());
	builtins.insert("enable".into(), builtin::<enable::EnableCommand, SE>());
	builtins.insert("let".into(), builtin::<let_::LetCommand, SE>());
	builtins.insert("mapfile".into(), builtin::<mapfile::MapFileCommand, SE>());
	builtins.insert("readarray".into(), builtin::<mapfile::MapFileCommand, SE>());
	#[cfg(any(unix, windows))]
	builtins.insert("printf".into(), builtin::<printf::PrintfCommand, SE>());
	builtins.insert("shopt".into(), builtin::<shopt::ShoptCommand, SE>());
	#[cfg(unix)]
	builtins.insert("suspend".into(), builtin::<suspend::SuspendCommand, SE>());
	builtins.insert("test".into(), builtin::<test::TestCommand, SE>());
	builtins.insert("[".into(), builtin::<test::TestCommand, SE>());
	builtins.insert("typeset".into(), decl_builtin::<declare::DeclareCommand, SE>());
	builtins.insert("dirs".into(), builtin::<dirs::DirsCommand, SE>());
	builtins.insert("popd".into(), builtin::<popd::PopdCommand, SE>());
	builtins.insert("pushd".into(), builtin::<pushd::PushdCommand, SE>());
	builtins.insert("caller".into(), builtin::<caller::CallerCommand, SE>());
	builtins.insert("disown".into(), builtin::<disown::DisownCommand, SE>());

	builtins
}
#[cfg(test)]
mod tests {
	use super::default_builtins;
	use crate::extensions::DefaultShellExtensions;

	#[test]
	fn registers_job_history_completion_and_input_builtins() {
		let builtins = default_builtins::<DefaultShellExtensions>();
		for name in ["bg", "fg", "bind", "complete", "compgen", "compopt", "fc", "history"] {
			assert!(builtins.contains_key(name), "missing builtin {name}");
		}
		#[cfg(unix)]
		assert!(builtins.contains_key("suspend"));
	}
}
