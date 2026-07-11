use std::collections::HashMap;

#[allow(unused_imports, reason = "not all builtins are used in all configs")]
use brush_core::builtins::{self, builtin, decl_builtin, raw_arg_builtin, simple_builtin};

#[allow(clippy::wildcard_imports)]
use super::*;

/// Identifies well-known sets of builtins.
#[derive(Clone, Copy, Eq, PartialEq)]
pub enum BuiltinSet {
	/// Identifies builtins appropriate for POSIX `sh` compatibility.
	ShMode,
	/// Identifies builtins appropriate for a more full-featured
	/// `bash`-compatible shell.
	BashMode,
}

/// Returns the default set of built-in commands.
///
/// # Arguments
///
/// * `set` - The set of built-ins to return.
#[allow(clippy::too_many_lines)]
pub fn default_builtins<SE: brush_core::ShellExtensions>(
	set: BuiltinSet,
) -> HashMap<String, builtins::Registration<SE>> {
	let mut m = HashMap::<String, builtins::Registration<SE>>::new();

	//
	// POSIX special builtins
	//
	// N.B. There seems to be some inconsistency as to whether 'times'
	// should be a special built-in.
	//

	#[cfg(feature = "builtin.break")]
	m.insert("break".into(), builtin::<break_::BreakCommand, SE>().special());
	#[cfg(feature = "builtin.colon")]
	m.insert(":".into(), simple_builtin::<colon::ColonCommand, SE>().special());
	#[cfg(feature = "builtin.continue")]
	m.insert("continue".into(), builtin::<continue_::ContinueCommand, SE>().special());
	#[cfg(feature = "builtin.dot")]
	m.insert(".".into(), builtin::<dot::DotCommand, SE>().special());
	#[cfg(feature = "builtin.eval")]
	m.insert("eval".into(), builtin::<eval::EvalCommand, SE>().special());
	#[cfg(all(feature = "builtin.exec", unix))]
	m.insert("exec".into(), builtin::<exec::ExecCommand, SE>().special());
	#[cfg(feature = "builtin.exit")]
	m.insert("exit".into(), builtin::<exit::ExitCommand, SE>().special());
	#[cfg(feature = "builtin.export")]
	m.insert("export".into(), decl_builtin::<export::ExportCommand, SE>().special());
	#[cfg(feature = "builtin.return")]
	m.insert("return".into(), builtin::<return_::ReturnCommand, SE>().special());
	#[cfg(feature = "builtin.set")]
	m.insert("set".into(), builtin::<set::SetCommand, SE>().special());
	#[cfg(feature = "builtin.shift")]
	m.insert("shift".into(), builtin::<shift::ShiftCommand, SE>().special());
	#[cfg(feature = "builtin.trap")]
	m.insert("trap".into(), builtin::<trap::TrapCommand, SE>().special());
	#[cfg(feature = "builtin.unset")]
	m.insert("unset".into(), builtin::<unset::UnsetCommand, SE>().special());

	#[cfg(feature = "builtin.declare")]
	m.insert("readonly".into(), decl_builtin::<declare::DeclareCommand, SE>().special());
	#[cfg(feature = "builtin.times")]
	m.insert("times".into(), builtin::<times::TimesCommand, SE>().special());

	//
	// Non-special builtins
	//

	#[cfg(feature = "builtin.alias")]
	m.insert("alias".into(), builtin::<alias::AliasCommand, SE>()); // TODO(alias): should be exec_declaration_builtin
	#[cfg(feature = "builtin.bg")]
	m.insert("bg".into(), builtin::<bg::BgCommand, SE>());
	#[cfg(feature = "builtin.cd")]
	m.insert("cd".into(), builtin::<cd::CdCommand, SE>());
	#[cfg(feature = "builtin.command")]
	m.insert("command".into(), builtin::<command::CommandCommand, SE>());
	#[cfg(feature = "builtin.false")]
	m.insert("false".into(), simple_builtin::<false_::FalseCommand, SE>());
	#[cfg(feature = "builtin.fg")]
	m.insert("fg".into(), builtin::<fg::FgCommand, SE>());
	#[cfg(feature = "builtin.getopts")]
	m.insert("getopts".into(), builtin::<getopts::GetOptsCommand, SE>());
	#[cfg(feature = "builtin.hash")]
	m.insert("hash".into(), builtin::<hash::HashCommand, SE>());
	#[cfg(feature = "builtin.help")]
	m.insert("help".into(), builtin::<help::HelpCommand, SE>());
	#[cfg(feature = "builtin.jobs")]
	m.insert("jobs".into(), builtin::<jobs::JobsCommand, SE>());
	#[cfg(all(feature = "builtin.kill", unix))]
	m.insert("kill".into(), builtin::<kill::KillCommand, SE>());
	#[cfg(feature = "builtin.declare")]
	m.insert("local".into(), decl_builtin::<declare::DeclareCommand, SE>());
	#[cfg(feature = "builtin.pwd")]
	m.insert("pwd".into(), builtin::<pwd::PwdCommand, SE>());
	#[cfg(feature = "builtin.read")]
	m.insert("read".into(), builtin::<read::ReadCommand, SE>());
	#[cfg(feature = "builtin.true")]
	m.insert("true".into(), simple_builtin::<true_::TrueCommand, SE>());
	#[cfg(feature = "builtin.type")]
	m.insert("type".into(), builtin::<type_::TypeCommand, SE>());
	#[cfg(all(feature = "builtin.ulimit", unix))]
	m.insert("ulimit".into(), builtin::<ulimit::ULimitCommand, SE>());
	#[cfg(all(feature = "builtin.umask", unix))]
	m.insert("umask".into(), builtin::<umask::UmaskCommand, SE>());
	#[cfg(feature = "builtin.unalias")]
	m.insert("unalias".into(), builtin::<unalias::UnaliasCommand, SE>());
	#[cfg(feature = "builtin.wait")]
	m.insert("wait".into(), builtin::<wait::WaitCommand, SE>());

	#[cfg(feature = "builtin.fc")]
	m.insert("fc".into(), builtin::<fc::FcCommand, SE>());

	if matches!(set, BuiltinSet::BashMode) {
		#[cfg(feature = "builtin.builtin")]
		m.insert("builtin".into(), raw_arg_builtin::<builtin_::BuiltinCommand, SE>());
		#[cfg(feature = "builtin.declare")]
		m.insert("declare".into(), decl_builtin::<declare::DeclareCommand, SE>());
		#[cfg(feature = "builtin.echo")]
		m.insert("echo".into(), builtin::<echo::EchoCommand, SE>());
		#[cfg(feature = "builtin.enable")]
		m.insert("enable".into(), builtin::<enable::EnableCommand, SE>());
		#[cfg(feature = "builtin.let")]
		m.insert("let".into(), builtin::<let_::LetCommand, SE>());
		#[cfg(feature = "builtin.mapfile")]
		m.insert("mapfile".into(), builtin::<mapfile::MapFileCommand, SE>());
		#[cfg(feature = "builtin.mapfile")]
		m.insert("readarray".into(), builtin::<mapfile::MapFileCommand, SE>());
		#[cfg(all(feature = "builtin.printf", any(unix, windows)))]
		m.insert("printf".into(), builtin::<printf::PrintfCommand, SE>());
		#[cfg(feature = "builtin.shopt")]
		m.insert("shopt".into(), builtin::<shopt::ShoptCommand, SE>());
		#[cfg(feature = "builtin.dot")]
		m.insert("source".into(), builtin::<dot::DotCommand, SE>().special());
		#[cfg(all(feature = "builtin.suspend", unix))]
		m.insert("suspend".into(), builtin::<suspend::SuspendCommand, SE>());
		#[cfg(feature = "builtin.test")]
		m.insert("test".into(), builtin::<test::TestCommand, SE>());
		#[cfg(feature = "builtin.test")]
		m.insert("[".into(), builtin::<test::TestCommand, SE>());
		#[cfg(feature = "builtin.declare")]
		m.insert("typeset".into(), decl_builtin::<declare::DeclareCommand, SE>());

		// Completion builtins
		#[cfg(feature = "builtin.complete")]
		m.insert("complete".into(), builtin::<complete::CompleteCommand, SE>());
		#[cfg(feature = "builtin.compgen")]
		m.insert("compgen".into(), builtin::<complete::CompGenCommand, SE>());
		#[cfg(feature = "builtin.compopt")]
		m.insert("compopt".into(), builtin::<complete::CompOptCommand, SE>());

		// Dir stack builtins
		#[cfg(feature = "builtin.dirs")]
		m.insert("dirs".into(), builtin::<dirs::DirsCommand, SE>());
		#[cfg(feature = "builtin.popd")]
		m.insert("popd".into(), builtin::<popd::PopdCommand, SE>());
		#[cfg(feature = "builtin.pushd")]
		m.insert("pushd".into(), builtin::<pushd::PushdCommand, SE>());

		// Input configuration builtins
		#[cfg(feature = "builtin.bind")]
		m.insert("bind".into(), builtin::<bind::BindCommand, SE>());

		// History
		#[cfg(feature = "builtin.history")]
		m.insert("history".into(), builtin::<history::HistoryCommand, SE>());

		#[cfg(feature = "builtin.caller")]
		m.insert("caller".into(), builtin::<caller::CallerCommand, SE>());

		// TODO(disown): implement disown builtin
		m.insert("disown".into(), builtin::<unimp::UnimplementedCommand, SE>());

		// TODO(logout): implement logout builtin
		m.insert("logout".into(), builtin::<unimp::UnimplementedCommand, SE>());
	}

	m
}
