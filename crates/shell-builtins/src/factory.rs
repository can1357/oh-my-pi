use std::sync::Arc;

use omp_core::Str;
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

/// Keyword that selects every name [`extra_builtins`] offers in this build.
pub const ALL_EXTRAS: &str = "all";

/// Names [`extra_builtins`] can register in this build, in registration order.
///
/// Every name here is opt-in: it shadows a system command, so it is registered
/// only when the embedding shell lists it (ADR 0054 D2). No name may collide
/// with [`utility_builtins`], [`process_builtins`], or the shell's own
/// builtins; the factory tests enforce that. The set is empty until a port
/// lands, and a build that lacks a port's cargo feature leaves its name out.
pub const OFFERED_EXTRAS: &[&str] = &[];

/// Why a requested extra builtin name is rejected.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum ExtraBuiltinError {
	/// The name is neither [`ALL_EXTRAS`] nor in [`OFFERED_EXTRAS`].
	#[error("`{name}` is not an extra builtin this build offers")]
	Unknown {
		/// The rejected name, as the embedder supplied it.
		name: Str,
	},
}

/// Checks that every requested extra builtin name is [`ALL_EXTRAS`] or one this
/// build offers.
///
/// Embedders call this where the list enters (a convar's validation hook), so
/// [`extra_builtins`] never has to guess what an unknown name meant.
///
/// # Errors
///
/// [`ExtraBuiltinError::Unknown`] names the first rejected entry.
pub fn validate_extra_names(enabled: &[Str]) -> Result<(), ExtraBuiltinError> {
	match enabled
		.iter()
		.find(|name| name.as_str() != ALL_EXTRAS && !OFFERED_EXTRAS.contains(&name.as_str()))
	{
		Some(name) => Err(ExtraBuiltinError::Unknown { name: name.clone() }),
		None => Ok(()),
	}
}

/// Returns the opt-in utility builtins named by `enabled` as
/// `(name, registration)` pairs.
///
/// `enabled` lists names from [`OFFERED_EXTRAS`]; [`ALL_EXTRAS`] selects every
/// one. An empty list yields no registration, and a name this build does not
/// offer is skipped (reject it earlier with [`validate_extra_names`]).
/// [`utility_builtins`] and every existing registration stay untouched.
pub fn extra_builtins<SE: omp_shell::ShellExtensions>(
	enabled: &[Str],
) -> Vec<(&'static str, builtins::Registration<SE>)> {
	let all = enabled.iter().any(|name| name.as_str() == ALL_EXTRAS);
	OFFERED_EXTRAS
		.iter()
		.copied()
		.filter(|name| all || enabled.iter().any(|wanted| wanted.as_str() == *name))
		.filter_map(|name| extra_registration::<SE>(name).map(|registration| (name, registration)))
		.collect()
}

/// Builds the registration for one offered extra name.
///
/// Each port adds its arm and its [`OFFERED_EXTRAS`] entry together.
fn extra_registration<SE: omp_shell::ShellExtensions>(
	_name: &str,
) -> Option<builtins::Registration<SE>> {
	None
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
