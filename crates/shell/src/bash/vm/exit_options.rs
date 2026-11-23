//! Read-only option restoration for an exit's counterfactual continuation.
//! Scope ownership follows `exec::pop_frame`/`drop_scratch`; option precedence
//! follows `mode::leave_call` and deferred `local -` restoration.

use std::sync::Arc;

use super::{
	Cx, Kernel, builtins, locale, mode,
	proc::{FrameKind, LocaleBindings, ParseSnapshot, ScriptKind, Vproc},
	state,
};
use crate::bash::{
	event::Origin,
	ids::{Dialect, ModeId},
	store::{Key, MiscKey, OptId, Record, StoreError},
	syntax::Features,
	zshopt::{ZshOpt, ZshOpts},
};

#[derive(Clone, Default)]
pub struct WalkOptions {
	pub pipefail:        bool,
	pub localloops:      bool,
	pub continueonerror: bool,
	pub parse:           Option<Arc<ParseSnapshot>>,
	/// The global `LC_ALL`/`LC_CTYPE`/`LANG` bindings at the freeze, a
	/// nameref's target included: what a probe restores ahead of the next
	/// run's environment before it re-reads the charset; `None` when the
	/// store could not be read, which a probe under an environment must
	/// not judge on. In memory only.
	pub locale:          Option<Arc<LocaleBindings>>,
}

/// The parser a frame's unread input still parses under: the grammar of
/// `mode` over the options read and the charset given ([`base_features`]),
/// aliases expanded or not ([`aliases_on`]), and the alias table the store
/// carries.
fn snapshot(
	k: &Kernel,
	cx: &mut Cx<'_>,
	vp: &Vproc,
	opts: &ZshOpts,
	mode: ModeId,
	base: Features,
	aliases_on: bool,
	charset: locale::Charset,
	stdin: bool,
) -> Result<Arc<ParseSnapshot>, StoreError> {
	let features =
		mode::restored_features(mode, base, opts, charset == locale::Charset::Utf8, stdin)?;
	let zsh = mode.dialect() == Dialect::Zsh;
	Ok(Arc::new(ParseSnapshot {
		features: features.bits(),
		aliases:  builtins::Aliases::with_options(k, cx, vp, zsh, aliases_on)?,
	}))
}

/// The grammar's charset and option bits: what a double-byte or stateful
/// encoding needs, POSIX mode, extended globs.
fn base_features(charset: locale::Charset, posix: bool, extglob: bool) -> Features {
	let mut base = Features::NONE;
	if let locale::Charset::Encoding(e) = charset {
		if e == encoding_rs::BIG5 || e == encoding_rs::GBK {
			base = base | Features::DOUBLE_BYTE;
		} else if e == encoding_rs::GB18030 {
			base = base | Features::GB18030;
		} else if e == encoding_rs::SHIFT_JIS {
			base = base | Features::SHIFT_JIS;
		}
	}
	if posix {
		base = base | Features::POSIX;
	}
	if extglob {
		base = base | Features::EXTGLOB;
	}
	base
}

/// Whether the mode expands aliases: zsh by its own option, Bash and the
/// rest when asked, or in POSIX mode.
fn aliases_on(mode: ModeId, opts: &ZshOpts, posix: bool, expand_aliases: bool) -> bool {
	if mode.dialect() == Dialect::Zsh {
		opts.get(ZshOpt::Aliases)
	} else {
		expand_aliases || posix
	}
}

pub(super) fn by_frame(
	k: &mut Kernel,
	vp: &Vproc,
	cx: &mut Cx<'_>,
) -> Result<Vec<WalkOptions>, StoreError> {
	let mut opts = state::zsh_options(&mut k.root, cx.store, vp)?;
	let mut mode = vp.mode;
	let mut posix = state::option(&mut k.root, cx.store, vp, OptId::Posix)?;
	let mut expand_aliases = state::option(&mut k.root, cx.store, vp, OptId::ExpandAliases)?;
	let interactive = matches!(state::record(cx.store, vp, Key::Misc(MiscKey::Interactive))?,
		Some(Record::Misc(v)) if v.as_slice() == b"1");
	let extglob = state::option(&mut k.root, cx.store, vp, OptId::Extglob)?;
	// Read once for every frame, and never fatal: the next run reads the
	// global scope, not the one a frame (or a trap) adds, and a variable
	// the charset itself never needed must not cost the snapshot.
	let locale = locale::ctype_vars_global(&k.root, cx.store, vp)
		.ok()
		.map(Arc::new);
	if vp.frames.is_empty() {
		// The input has ended and its frame is gone — a root run's EXIT
		// trap starts here — so the root entry is the shell's own
		// top-level view, the one the next run parses under: no scope,
		// the mode and options as they stand, the locale as global, and
		// the `stdin` the input's own frame had — its run's origin, since
		// a command string is not standard input, interactive or not.
		let stdin = vp
			.runs
			.front()
			.is_some_and(|run| matches!(run.chain.links[0].origin, Origin::Stdin));
		let charset = locale::charset_upto(&k.root, cx.store, vp, 0)?;
		let parse = Some(snapshot(
			k,
			cx,
			vp,
			&opts,
			mode,
			base_features(charset, posix, extglob),
			aliases_on(mode, &opts, posix, expand_aliases),
			charset,
			stdin,
		)?);
		return Ok(vec![WalkOptions {
			pipefail: opts.get(ZshOpt::Pipefail),
			localloops: opts.get(ZshOpt::Localloops),
			continueonerror: opts.get(ZshOpt::Continueonerror),
			parse,
			locale,
		}]);
	}
	let mut scopes = state::scope_count(&k.root, vp);
	let mut result = Vec::with_capacity(vp.frames.len());
	for (index, frame) in vp.frames.iter().enumerate().rev() {
		let parse = if let FrameKind::Script { stdin, aux, .. } = &frame.kind {
			// The caller frame's charset as of its continuation: the
			// scopes the frames it called created are already discarded
			// in `scopes`, and its own in-flight temporary environment
			// (`LC_ALL=x cmd`, unwound mid-command) dies with that
			// command — while an outer frame's retained `x eval …`
			// prefix stays counted. Derived, not captured at exit.
			let own_scoped = frame
				.scratch
				.as_ref()
				.and_then(|s| s.exec.as_ref())
				.is_some_and(|e| e.scoped);
			let upto = scopes.saturating_sub(own_scoped as usize);
			if let Some(saved) = aux.as_deref().and_then(|a| a.parse.as_ref()) {
				Some(Arc::new(saved.clone()))
			} else {
				let charset = locale::charset_upto(&k.root, cx.store, vp, upto)?;
				Some(snapshot(
					k,
					cx,
					vp,
					&opts,
					mode,
					base_features(charset, posix, extglob),
					aliases_on(mode, &opts, posix, expand_aliases),
					charset,
					*stdin,
				)?)
			}
		} else {
			None
		};
		result.push(WalkOptions {
			pipefail: opts.get(ZshOpt::Pipefail),
			localloops: opts.get(ZshOpt::Localloops),
			continueonerror: opts.get(ZshOpt::Continueonerror),
			parse,
			locale: locale.clone(),
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
					.is_some_and(|u| u.mode.dialect() == Dialect::Zsh);
				mode::restored_call_options(&mut mode, &mut opts, &saved, zsh_body);
				if saved.restore_sticky
					&& saved.mode.dialect() == Dialect::Bash
					&& posix != (saved.mode == ModeId::Sh)
				{
					posix = saved.mode == ModeId::Sh;
					expand_aliases = posix || interactive;
				}
			}
		}
		if let Some(zsh) = &vp.zsh
			&& let Some((_, saved)) = zsh
				.restores
				.iter()
				.rev()
				.find(|(depth, _)| *depth as usize == index + 1)
		{
			mode::restored_call_options(&mut mode, &mut opts, saved, true);
			if saved.restore_sticky
				&& saved.mode.dialect() == Dialect::Bash
				&& posix != (saved.mode == ModeId::Sh)
			{
				posix = saved.mode == ModeId::Sh;
				expand_aliases = posix || interactive;
			}
		}
		if let Some(saved) = bash_saved {
			let has = |name: &[u8]| {
				saved
					.as_scalar()
					.unwrap_or_default()
					.split(|&b| b == b':')
					.any(|n| n == name)
			};
			opts.set(ZshOpt::Pipefail, has(b"pipefail"));
			posix = has(b"posix");
		}
	}
	result.reverse();
	Ok(result)
}
