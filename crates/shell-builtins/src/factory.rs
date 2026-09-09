use std::sync::Arc;

use omp_shell::builtins::{self, builtin};

#[allow(
	clippy::wildcard_imports,
	reason = "this module intentionally registers every sibling builtin"
)]
use super::*;
use crate::host::DynHost;

/// Returns the in-process `dyn` builtin bound to `host`.
///
/// The registration stays fixed while the host's catalog remains live, so
/// discovery never mutates the model-facing tool roster.
pub fn dyn_builtin<SE: omp_shell::ShellExtensions>(
	host: Arc<dyn DynHost>,
) -> builtins::Registration<SE> {
	r#dyn::registration(host)
}

/// Returns every in-process command-line utility builtin as
/// `(name, registration)` pairs.
///
/// These utilities shadow real system binaries, so the embedding shell decides
/// whether to install them and may withhold destructive utilities such as
/// `rm`, `mv`, and `ln`.
#[allow(clippy::too_many_lines, reason = "one line per utility")]
pub fn utility_builtins<SE: omp_shell::ShellExtensions>()
-> Vec<(&'static str, builtins::Registration<SE>)> {
	let mut m = Vec::<(&'static str, builtins::Registration<SE>)>::new();

	m.push(("b2sum", b2sum::b2sum_builtin::<SE>()));
	m.push(("base32", base32::base32_builtin::<SE>()));
	m.push(("base64", base64::base64_builtin::<SE>()));
	m.push(("basename", basename::basename_builtin::<SE>()));
	m.push(("cat", cat::cat_builtin::<SE>()));
	m.push(("cksum", cksum::cksum_builtin::<SE>()));
	m.push(("cmp", cmp::cmp_builtin::<SE>()));
	m.push(("comm", comm::comm_builtin::<SE>()));
	m.push(("combine", combine::combine_builtin::<SE>()));
	m.push(("cut", cut::cut_builtin::<SE>()));
	m.push(("date", date::date_builtin::<SE>()));
	m.push(("diff", diff::diff_builtin::<SE>()));
	m.push(("dirname", dirname::dirname_builtin::<SE>()));
	#[cfg(unix)]
	m.push(("errno", errno::errno_builtin::<SE>()));
	m.push(("fd", fd::fd_builtin::<SE>()));
	m.push(("find", find::find_builtin::<SE>()));
	m.push(("grep", grep::grep_builtin::<SE>()));
	m.push(("rg", rg::rg_builtin::<SE>()));
	m.push(("head", head::head_builtin::<SE>()));
	m.push(("hostname", hostname::hostname_builtin::<SE>()));
	m.push(("ifne", ifne::ifne_builtin::<SE>()));
	m.push(("isutf8", isutf8::isutf8_builtin::<SE>()));
	m.push(("jq", jq::jq_builtin::<SE>()));
	m.push(("ln", ln::ln_builtin::<SE>()));
	m.push(("ls", ls::ls_builtin::<SE>()));
	m.push(("md5sum", md5sum::md5sum_builtin::<SE>()));
	m.push(("mkdir", mkdir::mkdir_builtin::<SE>()));
	m.push(("mktemp", mktemp::mktemp_builtin::<SE>()));
	m.push(("mv", mv::mv_builtin::<SE>()));
	m.push(("nproc", nproc::nproc_builtin::<SE>()));
	m.push(("paste", paste::paste_builtin::<SE>()));
	m.push(("printenv", printenv::printenv_builtin::<SE>()));
	m.push(("readlink", readlink::readlink_builtin::<SE>()));
	m.push(("realpath", realpath::realpath_builtin::<SE>()));
	m.push(("rm", rm::rm_builtin::<SE>()));
	m.push(("sed", sed::sed_builtin::<SE>()));
	m.push(("seq", seq::seq_builtin::<SE>()));
	m.push(("sha1sum", sha1sum::sha1sum_builtin::<SE>()));
	m.push(("sha224sum", sha224sum::sha224sum_builtin::<SE>()));
	m.push(("sha256sum", sha256sum::sha256sum_builtin::<SE>()));
	m.push(("sha384sum", sha384sum::sha384sum_builtin::<SE>()));
	m.push(("sha512sum", sha512sum::sha512sum_builtin::<SE>()));
	m.push(("sort", sort::sort_builtin::<SE>()));
	m.push(("sponge", sponge::sponge_builtin::<SE>()));
	m.push(("stat", stat::stat_builtin::<SE>()));
	m.push(("tac", tac::tac_builtin::<SE>()));
	m.push(("tail", tail::tail_builtin::<SE>()));
	m.push(("tee", tee::tee_builtin::<SE>()));
	m.push(("touch", touch::touch_builtin::<SE>()));
	m.push(("tr", tr::tr_builtin::<SE>()));
	m.push(("truncate", truncate::truncate_builtin::<SE>()));
	m.push(("ts", ts::ts_builtin::<SE>()));
	m.push(("uname", uname::uname_builtin::<SE>()));
	m.push(("uniq", uniq::uniq_builtin::<SE>()));
	m.push(("wc", wc::wc_builtin::<SE>()));
	m.push(("which", which::which_builtin::<SE>()));
	m.push(("whoami", whoami::whoami_builtin::<SE>()));
	m.push(("xargs", xargs::xargs_builtin::<SE>()));
	m.push(("yes", yes::yes_builtin::<SE>()));

	m
}

/// Returns the process-inspection and process-control builtins:
/// `pgrep`, `pkill`, `pidwait`, `ps`, `top`, `sleep`, `timeout`, and `nohup`.
///
/// Kept separate from [`utility_builtins`] because an embedding shell may make
/// an independent registration choice for process-control commands.
pub fn process_builtins<SE: omp_shell::ShellExtensions>()
-> Vec<(&'static str, builtins::Registration<SE>)> {
	let mut m = Vec::<(&'static str, builtins::Registration<SE>)>::new();

	// `nohup` detaches its operand into a new session so a backgrounded server
	// survives the shell's kill-on-drop teardown; the wrapper flag keeps the
	// shell from treating it as the job itself.
	m.push(("nohup", builtin::<nohup::NohupCommand, SE>().transparent_background_wrapper()));
	m.push(("pgrep", builtin::<pgrep::PgrepCommand, SE>()));
	m.push(("pidwait", builtin::<pidwait::PidwaitCommand, SE>()));
	m.push(("pkill", builtin::<pkill::PkillCommand, SE>()));
	m.push(("ps", builtin::<ps::PsCommand, SE>()));
	m.push(("sleep", builtin::<sleep::SleepCommand, SE>()));
	m.push(("timeout", builtin::<timeout::TimeoutCommand, SE>()));
	m.push(("top", builtin::<top::TopCommand, SE>()));

	m
}
