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
mod trap;
mod vars;
mod zsh_builtins;
mod zsh_cond;
