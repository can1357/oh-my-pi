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
	#[cfg(all(feature = "builtin.kill", any(unix, windows)))]
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


/// Returns every in-process command-line utility builtin, as
/// `(name, registration)` pairs.
///
/// These are kept out of [`default_builtins`] because they shadow real system
/// binaries: the embedding shell decides whether to install them (and may
/// withhold the destructive ones — `rm`, `mv`, `ln`).
#[allow(clippy::too_many_lines, reason = "one line per utility")]
pub fn utility_builtins<SE: brush_core::ShellExtensions>()
-> Vec<(&'static str, builtins::Registration<SE>)> {
	#[allow(unused_mut, reason = "empty when no utility features are enabled")]
	let mut m = Vec::<(&'static str, builtins::Registration<SE>)>::new();

	#[cfg(feature = "util.b2sum")]
	m.push(("b2sum", b2sum::b2sum_builtin::<SE>()));
	#[cfg(feature = "util.base32")]
	m.push(("base32", base32::base32_builtin::<SE>()));
	#[cfg(feature = "util.base64")]
	m.push(("base64", base64::base64_builtin::<SE>()));
	#[cfg(feature = "util.basename")]
	m.push(("basename", basename::basename_builtin::<SE>()));
	#[cfg(feature = "util.cat")]
	m.push(("cat", cat::cat_builtin::<SE>()));
	#[cfg(feature = "util.cksum")]
	m.push(("cksum", cksum::cksum_builtin::<SE>()));
	#[cfg(feature = "util.cmp")]
	m.push(("cmp", cmp::cmp_builtin::<SE>()));
	#[cfg(feature = "util.comm")]
	m.push(("comm", comm::comm_builtin::<SE>()));
	#[cfg(feature = "util.combine")]
	m.push(("combine", combine::combine_builtin::<SE>()));
	#[cfg(feature = "util.cut")]
	m.push(("cut", cut::cut_builtin::<SE>()));
	#[cfg(feature = "util.date")]
	m.push(("date", date::date_builtin::<SE>()));
	#[cfg(feature = "util.diff")]
	m.push(("diff", diff::diff_builtin::<SE>()));
	#[cfg(feature = "util.dirname")]
	m.push(("dirname", dirname::dirname_builtin::<SE>()));
	#[cfg(all(feature = "util.errno", unix))]
	m.push(("errno", errno::errno_builtin::<SE>()));
	#[cfg(feature = "util.fd")]
	m.push(("fd", fd::fd_builtin::<SE>()));
	#[cfg(feature = "util.find")]
	m.push(("find", find::find_builtin::<SE>()));
	#[cfg(feature = "util.grep")]
	m.push(("grep", grep::grep_builtin::<SE>()));
	#[cfg(feature = "util.rg")]
	m.push(("rg", rg::rg_builtin::<SE>()));
	#[cfg(feature = "util.head")]
	m.push(("head", head::head_builtin::<SE>()));
	#[cfg(feature = "util.hostname")]
	m.push(("hostname", hostname::hostname_builtin::<SE>()));
	#[cfg(feature = "util.ifne")]
	m.push(("ifne", ifne::ifne_builtin::<SE>()));
	#[cfg(feature = "util.isutf8")]
	m.push(("isutf8", isutf8::isutf8_builtin::<SE>()));
	#[cfg(feature = "util.jq")]
	m.push(("jq", jq::jq_builtin::<SE>()));
	#[cfg(feature = "util.ln")]
	m.push(("ln", ln::ln_builtin::<SE>()));
	#[cfg(feature = "util.ls")]
	m.push(("ls", ls::ls_builtin::<SE>()));
	#[cfg(feature = "util.md5sum")]
	m.push(("md5sum", md5sum::md5sum_builtin::<SE>()));
	#[cfg(feature = "util.mkdir")]
	m.push(("mkdir", mkdir::mkdir_builtin::<SE>()));
	#[cfg(feature = "util.mktemp")]
	m.push(("mktemp", mktemp::mktemp_builtin::<SE>()));
	#[cfg(feature = "util.mv")]
	m.push(("mv", mv::mv_builtin::<SE>()));
	#[cfg(feature = "util.nproc")]
	m.push(("nproc", nproc::nproc_builtin::<SE>()));
	#[cfg(feature = "util.paste")]
	m.push(("paste", paste::paste_builtin::<SE>()));
	#[cfg(feature = "util.printenv")]
	m.push(("printenv", printenv::printenv_builtin::<SE>()));
	#[cfg(feature = "util.readlink")]
	m.push(("readlink", readlink::readlink_builtin::<SE>()));
	#[cfg(feature = "util.realpath")]
	m.push(("realpath", realpath::realpath_builtin::<SE>()));
	#[cfg(feature = "util.rm")]
	m.push(("rm", rm::rm_builtin::<SE>()));
	#[cfg(feature = "util.sed")]
	m.push(("sed", sed::sed_builtin::<SE>()));
	#[cfg(feature = "util.seq")]
	m.push(("seq", seq::seq_builtin::<SE>()));
	#[cfg(feature = "util.sha1sum")]
	m.push(("sha1sum", sha1sum::sha1sum_builtin::<SE>()));
	#[cfg(feature = "util.sha224sum")]
	m.push(("sha224sum", sha224sum::sha224sum_builtin::<SE>()));
	#[cfg(feature = "util.sha256sum")]
	m.push(("sha256sum", sha256sum::sha256sum_builtin::<SE>()));
	#[cfg(feature = "util.sha384sum")]
	m.push(("sha384sum", sha384sum::sha384sum_builtin::<SE>()));
	#[cfg(feature = "util.sha512sum")]
	m.push(("sha512sum", sha512sum::sha512sum_builtin::<SE>()));
	#[cfg(feature = "util.sort")]
	m.push(("sort", sort::sort_builtin::<SE>()));
	#[cfg(feature = "util.sponge")]
	m.push(("sponge", sponge::sponge_builtin::<SE>()));
	#[cfg(feature = "util.stat")]
	m.push(("stat", stat::stat_builtin::<SE>()));
	#[cfg(feature = "util.tac")]
	m.push(("tac", tac::tac_builtin::<SE>()));
	#[cfg(feature = "util.tail")]
	m.push(("tail", tail::tail_builtin::<SE>()));
	#[cfg(feature = "util.tee")]
	m.push(("tee", tee::tee_builtin::<SE>()));
	#[cfg(feature = "util.touch")]
	m.push(("touch", touch::touch_builtin::<SE>()));
	#[cfg(feature = "util.tr")]
	m.push(("tr", tr::tr_builtin::<SE>()));
	#[cfg(feature = "util.truncate")]
	m.push(("truncate", truncate::truncate_builtin::<SE>()));
	#[cfg(feature = "util.ts")]
	m.push(("ts", ts::ts_builtin::<SE>()));
	#[cfg(feature = "util.uname")]
	m.push(("uname", uname::uname_builtin::<SE>()));
	#[cfg(feature = "util.uniq")]
	m.push(("uniq", uniq::uniq_builtin::<SE>()));
	#[cfg(feature = "util.wc")]
	m.push(("wc", wc::wc_builtin::<SE>()));
	#[cfg(feature = "util.which")]
	m.push(("which", which::which_builtin::<SE>()));
	#[cfg(feature = "util.whoami")]
	m.push(("whoami", whoami::whoami_builtin::<SE>()));
	#[cfg(feature = "util.xargs")]
	m.push(("xargs", xargs::xargs_builtin::<SE>()));
	#[cfg(feature = "util.yes")]
	m.push(("yes", yes::yes_builtin::<SE>()));

	m
}

/// Returns the process-inspection and process-control builtins:
/// `pgrep`, `pkill`, `pidwait`, `ps`, `top`, `sleep`, `timeout`, and `nohup`.
///
/// Kept separate from [`default_builtins`] because they shadow real system
/// binaries, and separate from [`utility_builtins`] because the embedding shell
/// installs them unconditionally — they exist so a long-lived embedded shell can
/// inspect and control its own children without forking.
pub fn process_builtins<SE: brush_core::ShellExtensions>()
-> Vec<(&'static str, builtins::Registration<SE>)> {
	#[allow(unused_mut, reason = "empty when no process features are enabled")]
	let mut m = Vec::<(&'static str, builtins::Registration<SE>)>::new();

	#[cfg(feature = "util.nohup")]
	// `nohup` detaches its operand into a new session so a backgrounded server
	// survives the shell's kill-on-drop teardown; the wrapper flag keeps the
	// shell from treating it as the job itself.
	m.push((
		"nohup",
		builtin::<nohup::NohupCommand, SE>().transparent_background_wrapper(),
	));
	#[cfg(feature = "util.pgrep")]
	m.push(("pgrep", builtin::<pgrep::PgrepCommand, SE>()));
	#[cfg(feature = "util.pidwait")]
	m.push(("pidwait", builtin::<pidwait::PidwaitCommand, SE>()));
	#[cfg(feature = "util.pkill")]
	m.push(("pkill", builtin::<pkill::PkillCommand, SE>()));
	#[cfg(feature = "util.ps")]
	m.push(("ps", builtin::<ps::PsCommand, SE>()));
	#[cfg(feature = "util.sleep")]
	m.push(("sleep", builtin::<sleep::SleepCommand, SE>()));
	#[cfg(feature = "util.timeout")]
	m.push(("timeout", builtin::<timeout::TimeoutCommand, SE>()));
	#[cfg(feature = "util.top")]
	m.push(("top", builtin::<top::TopCommand, SE>()));

	m
}
