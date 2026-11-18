//! Read-only option restoration for an exit's counterfactual continuation.
//! Scope ownership follows `exec::pop_frame`/`drop_scratch`; option precedence
//! follows `mode::leave_call` and deferred `local -` restoration.

use super::{
	Cx, Kernel,
	proc::{FrameKind, ScriptKind, Vproc},
	state,
};
use crate::bash::{
	store::{StoreError, ZshScope},
	zshopt::{ZshOpt, ZshOpts},
};

#[derive(Clone, Copy)]
pub(super) struct WalkOptions {
	pub pipefail:        bool,
	pub localloops:      bool,
	pub continueonerror: bool,
}

fn leave_options(opts: &mut ZshOpts, saved: &ZshScope, zsh_body: bool) {
	if saved.restore_sticky || (zsh_body && opts.get(ZshOpt::Localoptions)) {
		*opts = saved.opts;
	} else if zsh_body {
		// Only these automatically restored bits affect further unwinding.
		for opt in [ZshOpt::Localoptions, ZshOpt::Localloops] {
			opts.set(opt, saved.opts.get(opt));
		}
	}
}

pub(super) fn by_frame(
	k: &mut Kernel,
	vp: &Vproc,
	cx: &mut Cx<'_>,
) -> Result<Vec<WalkOptions>, StoreError> {
	let mut opts = state::zsh_options(&mut k.root, cx.store, vp)?;
	let mut scopes = state::scope_count(&k.root, vp);
	let mut result = Vec::with_capacity(vp.frames.len());
	for (index, frame) in vp.frames.iter().enumerate().rev() {
		result.push(WalkOptions {
			pipefail:        opts.get(ZshOpt::Pipefail),
			localloops:      opts.get(ZshOpt::Localloops),
			continueonerror: opts.get(ZshOpt::Continueonerror),
		});
		if frame
			.scratch
			.as_ref()
			.and_then(|s| s.exec.as_ref())
			.is_some_and(|e| e.scoped)
		{
			scopes = scopes.saturating_sub(1);
		}
		let mut bash_saved = None;
		if matches!(
			frame.kind,
			FrameKind::Function { .. }
				| FrameKind::NoFork
				| FrameKind::Script { what: ScriptKind::Trap { .. }, .. }
		) {
			scopes = scopes.saturating_sub(1);
			if matches!(frame.kind, FrameKind::Function { .. }) {
				bash_saved = state::scope_var(cx.store, vp, scopes, b"-")?.flatten();
			}
			if matches!(frame.kind, FrameKind::Function { zsh: true, .. })
				&& let Some(saved) = state::scope_zsh(cx.store, vp, scopes)?
			{
				let zsh_body = frame
					.unit
					.as_ref()
					.is_some_and(|u| u.mode.dialect() == crate::bash::ids::Dialect::Zsh);
				leave_options(&mut opts, &saved, zsh_body);
			}
		}
		if let Some(zsh) = &vp.zsh
			&& let Some((_, saved)) = zsh
				.restores
				.iter()
				.rev()
				.find(|(depth, _)| *depth as usize == index + 1)
		{
			leave_options(&mut opts, saved, true);
		}
		if let Some(saved) = bash_saved {
			let on = saved
				.as_scalar()
				.unwrap_or_default()
				.split(|&b| b == b':')
				.any(|name| name == b"pipefail");
			opts.set(ZshOpt::Pipefail, on);
		}
	}
	result.reverse();
	Ok(result)
}
