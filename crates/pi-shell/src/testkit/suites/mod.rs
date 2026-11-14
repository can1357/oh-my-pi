//! Engine behavior suites driven through the testkit host.

use std::path::{Path, PathBuf};

/// The testkit fixture directory `sub` (`events`, `skeleton`): under the
/// crate root for Cargo, the workspace-relative runfile for Bazel, whose
/// tests do not run from the sources the compile-time path names.
fn fixtures(sub: &str) -> PathBuf {
	let manifest = Path::new(env!("CARGO_MANIFEST_DIR"))
		.join("src/testkit/fixtures")
		.join(sub);
	if manifest.is_dir() {
		return manifest;
	}
	Path::new("crates/pi-shell/src/testkit/fixtures").join(sub)
}

mod bang_pid;
mod cancel_latency;
mod cancel_traps;
mod control;
mod coproc_jobs;
mod errexit;
mod events;
mod executor;
mod expand;
mod getopts;
mod host_hooks;
mod interactive_builtins;
mod jobs;
mod kill;
mod lineage;
mod mem_fds;
mod modes;
mod nested_shell;
mod orphan_jobs;
mod procsub;
mod restore_fidelity;
mod skeleton;
mod startup_vars;
mod stdin_script;
mod test_chain_depth;
mod tool_profile;
mod trace;
mod trap;
mod vars;
mod windows_platform;
mod zsh_builtins;
mod zsh_compctl;
mod zsh_cond;
mod zsh_history;
mod zsh_jobs;
mod zsh_mod_attr;
mod zsh_mod_cap;
mod zsh_mod_curses;
mod zsh_mod_datetime;
mod zsh_mod_example;
mod zsh_mod_files;
mod zsh_mod_mapfile;
mod zsh_mod_mathfunc;
mod zsh_mod_net;
mod zsh_mod_p10k;
mod zsh_mod_pcre;
mod zsh_mod_private;
mod zsh_mod_regex;
mod zsh_mod_rlimits;
mod zsh_mod_sched;
mod zsh_mod_stat;
mod zsh_mod_system;
mod zsh_mod_terminfo;
mod zsh_mod_watch;
mod zsh_mod_zftp;
mod zsh_mod_zmodload;
mod zsh_mod_zprof;
mod zsh_mod_zpty;
mod zsh_mod_zselect;
mod zsh_mod_zutil;
mod zsh_parity;
mod zsh_prompt_names;
mod zsh_zcompile;
