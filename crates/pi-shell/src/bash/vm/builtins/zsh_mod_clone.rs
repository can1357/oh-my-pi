//! zsh/clone: `clone TTY`, a copy of the running shell on another
//! terminal.
//!
//! zsh forks the whole shell process: the child leads a new session on
//! `TTY` (fds 0–2, controlling terminal) and continues the script after
//! `clone` with status 0, the parent gets `$!`. The engine's subshells are
//! vprocs inside one process; a copy that keeps running the same script on
//! another terminal, outliving this shell, would be another process, and
//! inside `omp zsh` (Bun) the process cannot fork. So the module loads (its
//! feature table is zsh's) and `clone` checks its terminal as zsh does,
//! then fails loudly.
//!
//! Ported from zsh 5.9 `Src/Modules/clone.c` (MIT-style licence, Copyright
//! (c) 1997 Zoltán Hidvégi and the zsh development group).

use bstr::BString;

use super::{Ctx, R, done, zsh_args::Ops};
use crate::bash::{
	diag::Diag,
	vm::proc::{Probe, ProbeResult},
};

/// zsh `bin_clone`: the terminal must open (`TTY: ERROR` otherwise); the
/// fork itself is not provided.
pub fn clone(ctx: &mut Ctx<'_, '_>, _ops: &Ops, args: &[BString]) -> R {
	let tty = &args[0];
	let exists = ctx.probe(Probe::Stat { path: tty.clone(), follow: true })?;
	if !matches!(exists, ProbeResult::Stat(Some(_))) {
		ctx.usage(format!("{tty}: no such file or directory"));
		return done(1);
	}
	// zsh opens it `O_RDWR`.
	let rw = ctx.probe(Probe::Access { path: tty.clone(), mode: 1 | 2 })?;
	if !matches!(rw, ProbeResult::Ok(true)) {
		ctx.usage(format!("{tty}: permission denied"));
		return done(1);
	}
	ctx.diag(Diag::Unsupported {
		what: "`clone' (forking the running shell onto another terminal)".into(),
	});
	done(1)
}
