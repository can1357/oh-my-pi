//! The `trap` special builtin, and zsh's trap scopes.
//!
//! zsh parts are ported from zsh 5.9 `signals.c` and `builtin.c` (MIT-style
//! licence, Copyright (c) 1992-1997 Paul Falstad and the zsh development
//! group). A `TrapFunction` marker holds zsh's `ZSIG_FUNC` activation;
//! the body lives only in the function table. A copied `TRAPNAL` name
//! alone is not an active trap. A zsh function's scope
//! ([`crate::bash::store::ZshScope::traps`]) keeps the traps it replaced: its
//! caller's `EXIT` trap (always, unless `posixtraps`) and, under
//! `localtraps`, every trap it changed; they come back when it returns.

use bstr::{BStr, BString, ByteSlice};

use super::{Ctx, R, done, opts};
use crate::bash::{
	diag::Diag,
	ids::{Dialect, Platform},
	signal::{Signal, ZSH_SIGCOUNT},
	store::{
		Key, KeyBuf, MiscKey, OptId, Record, StateStore, StoreError, Table, TrapKey, ZshSavedTrap,
	},
	vm::{
		Cx, Kernel,
		exec::mode_of,
		proc::{FrameKind, ScriptKind, Vproc},
		quote, state,
	},
};

fn key(spec: &[u8], platform: crate::bash::ids::Platform) -> Option<TrapKey> {
	match spec.to_ascii_uppercase().as_slice() {
		b"0" | b"EXIT" => Some(TrapKey::Exit),
		b"ERR" => Some(TrapKey::Err),
		b"DEBUG" => Some(TrapKey::Debug),
		b"RETURN" => Some(TrapKey::Return),
		_ => Signal::parse_spec(spec, platform).map(TrapKey::Signal),
	}
}

fn name(key: TrapKey) -> String {
	match key {
		TrapKey::Signal(sig) => format!("SIG{sig}"),
		TrapKey::Exit => "EXIT".into(),
		TrapKey::Err => "ERR".into(),
		TrapKey::Debug => "DEBUG".into(),
		TrapKey::Return => "RETURN".into(),
	}
}

fn print(ctx: &mut Ctx<'_, '_>, key: TrapKey, action: &[u8]) {
	let mut line = b"trap -- ".to_vec();
	line.extend_from_slice(&quote::single(action));
	line.push(b' ');
	line.extend_from_slice(name(key).as_bytes());
	line.push(b'\n');
	ctx.out(&line);
}

/// The canonical zsh function for `key`, from packed static names.
pub fn func_name(key: TrapKey, platform: Platform) -> Option<&'static str> {
	Some(match key {
		TrapKey::Signal(sig) => sig.zsh_function(platform),
		TrapKey::Exit => "TRAPEXIT",
		TrapKey::Err => "TRAPZERR",
		TrapKey::Debug => "TRAPDEBUG",
		TrapKey::Return => return None,
	})
}

const fn func_alias(key: TrapKey, platform: Platform) -> Option<&'static str> {
	match key {
		TrapKey::Signal(sig) => sig.zsh_function_alias(platform),
		TrapKey::Err => Some("TRAPERR"),
		_ => None,
	}
}

fn func_names(key: TrapKey, platform: Platform) -> [Option<&'static str>; 2] {
	[func_name(key, platform), func_alias(key, platform)]
}

/// Select the canonical then alternate key without cloning its body.
/// Scope capture/removal includes disabled nodes; runtime lookup does not.
pub fn function_name(
	store: &mut dyn StateStore,
	vp: &Vproc,
	key: TrapKey,
	platform: Platform,
	include_disabled: bool,
) -> Result<Option<&'static str>, StoreError> {
	for name in func_names(key, platform).into_iter().flatten() {
		if matches!(state::record(store, vp, Key::Func(BStr::new(name)))?, Some(Record::Func { .. }))
			&& (include_disabled || !is_function_disabled(store, vp, name.as_bytes())?)
		{
			return Ok(Some(name));
		}
	}
	Ok(None)
}

/// Take an owned handler only when a scope or an executing call needs it.
pub fn function_record(
	store: &mut dyn StateStore,
	vp: &Vproc,
	key: TrapKey,
	platform: Platform,
	include_disabled: bool,
) -> Result<Option<(&'static str, Record)>, StoreError> {
	for name in func_names(key, platform).into_iter().flatten() {
		if !include_disabled && is_function_disabled(store, vp, name.as_bytes())? {
			continue;
		}
		if let Some(rec @ Record::Func { .. }) = state::record(store, vp, Key::Func(BStr::new(name)))?
		{
			return Ok(Some((name, rec.clone())));
		}
	}
	Ok(None)
}

/// Effective handler on the virtual bus and when restoring OS handlers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Handler {
	/// Neither a list trap nor a zsh function trap.
	Absent,
	/// Explicitly ignored.
	Ignored,
	/// A nonempty list trap.
	Text,
	/// A zsh function, under its actual function-table key.
	Function(&'static str),
	/// Zsh can leave `ZSIG_FUNC` set after enabling an already active
	/// node removes that node. Its next signal clears the flag instead of
	/// terminating the shell.
	MissingFunction,
}

impl Handler {
	/// Whether delivery must queue a trap instead of taking its default.
	pub const fn caught(self) -> bool {
		matches!(self, Self::Text | Self::Function(_) | Self::MissingFunction)
	}

	/// Host protocol: absent, empty-ignore, or nonempty-catch. The host
	/// does not interpret the catch marker as shell source.
	pub fn disposition(self) -> Option<&'static BStr> {
		match self {
			Self::Absent => None,
			Self::Ignored => Some(BStr::new(b"")),
			Self::Text | Self::Function(_) | Self::MissingFunction => Some(BStr::new(b"catch")),
		}
	}
}

/// Classify a handler without copying action text or function source.
pub fn effective(
	store: &mut dyn StateStore,
	vp: &Vproc,
	key: TrapKey,
	platform: Platform,
) -> Result<Handler, StoreError> {
	match state::record(store, vp, Key::Trap(key))? {
		Some(Record::Trap { action, .. }) => {
			return Ok(if action.is_empty() {
				Handler::Ignored
			} else {
				Handler::Text
			});
		},
		Some(Record::TrapFunction) if vp.mode.dialect() == Dialect::Zsh => {},
		_ => return Ok(Handler::Absent),
	}
	if let TrapKey::Signal(sig) = key
		&& entry_ignored(store, vp, sig)?
	{
		return Ok(Handler::Ignored);
	}
	Ok(function_name(store, vp, key, platform, false)?
		.map_or(Handler::MissingFunction, Handler::Function))
}

/// The trap key made by a zsh function name. Numeric names such as
/// `TRAP0` remain ordinary functions; digits within `USR1` remain valid.
pub fn func_key(name: &[u8], platform: Platform) -> Option<TrapKey> {
	match name.strip_prefix(b"TRAP")? {
		b"EXIT" => Some(TrapKey::Exit),
		b"ZERR" | b"ERR" => Some(TrapKey::Err),
		b"DEBUG" => Some(TrapKey::Debug),
		signal_name => {
			let (sig, _) = Signal::parse_zsh_name(signal_name, platform, false)?;
			let key = TrapKey::Signal(sig);
			func_names(key, platform)
				.into_iter()
				.flatten()
				.any(|candidate| candidate.as_bytes() == name)
				.then_some(key)
		},
	}
}

/// zsh's `$1` for a function trap: EXIT is zero; ZERR and DEBUG follow
/// the traditional signal table used by `$signals`.
pub fn zsh_number(key: TrapKey, platform: Platform) -> i32 {
	match key {
		TrapKey::Signal(sig) => i32::from(sig.number(platform)),
		TrapKey::Exit | TrapKey::Return => 0,
		TrapKey::Err => i32::from(ZSH_SIGCOUNT) + 1,
		TrapKey::Debug => i32::from(ZSH_SIGCOUNT) + 2,
	}
}

/// A zsh function's `EXIT` trap, run when the function has returned (zsh
/// `endtrapscope`).
pub enum ScopeExit {
	/// `trap ACTION EXIT`, set in `mode`.
	Text {
		/// The action.
		action: BString,
		/// The mode it was set in.
		mode:   crate::bash::ids::ModeId,
	},
	/// A `TRAPEXIT` function, already out of the table.
	Func {
		/// Its function-table key, moved into its call.
		name:   BString,
		/// Its function record.
		record: Record,
	},
}

/// Whether the `EXIT` trap now set is POSIX-style (global, not scoped to
/// functions): set with `posixtraps` in effect (zsh `exit_trap_posix`;
/// approximated by the mode it was set in and the option now).
fn exit_posix(
	root: &mut state::Root,
	store: &mut dyn StateStore,
	vp: &Vproc,
	rec: Option<&ZshSavedTrap>,
) -> Result<bool, StoreError> {
	let mode_posix = matches!(
		rec,
		Some(ZshSavedTrap::Text(Record::Trap { mode, .. }))
			if *mode != crate::bash::ids::ModeId::Zsh
	);
	Ok(mode_posix || state::zsh_option(root, store, vp, crate::bash::zshopt::ZshOpt::Posixtraps)?)
}

#[derive(Clone, Copy)]
enum FunctionSave<'a> {
	Current,
	Forget,
	Enabling(&'a [u8]),
}

/// A scope saves the exact function key, not a regenerated spelling.
fn current(
	store: &mut dyn StateStore,
	vp: &Vproc,
	key: TrapKey,
	platform: Platform,
	function: FunctionSave<'_>,
) -> Result<Option<ZshSavedTrap>, StoreError> {
	match state::record(store, vp, Key::Trap(key))? {
		Some(rec @ Record::Trap { .. }) => return Ok(Some(ZshSavedTrap::Text(rec.clone()))),
		Some(Record::TrapFunction) if !matches!(function, FunctionSave::Forget) => {},
		_ => return Ok(None),
	}
	Ok(match function_record(store, vp, key, platform, true)? {
		Some((name, record)) => Some(ZshSavedTrap::Function {
			disabled: match function {
				FunctionSave::Enabling(enabled) if enabled == name.as_bytes() => false,
				_ => is_function_disabled(store, vp, name.as_bytes())?,
			},
			name: name.into(),
			record,
		}),
		None => None,
	})
}

/// zsh `removetrap`: remove only the selected active function. Ordinary
/// copied aliases may coexist and must not be deleted with the trap.
fn clear_function(
	root: &mut state::Root,
	store: &mut dyn StateStore,
	vp: &mut Vproc,
	key: TrapKey,
	platform: Platform,
) -> Result<(), StoreError> {
	if matches!(state::record(store, vp, Key::Trap(key))?, Some(Record::TrapFunction))
		&& let Some(name) = function_name(store, vp, key, platform, true)?
	{
		state::store_record(root, store, vp, KeyBuf::Func(name.into()), None);
	}
	Ok(())
}

/// Remove list and function handlers for one numeric trap identity.
fn clear(
	root: &mut state::Root,
	store: &mut dyn StateStore,
	vp: &mut Vproc,
	key: TrapKey,
	platform: Platform,
) -> Result<(), StoreError> {
	clear_function(root, store, vp, key, platform)?;
	state::store_record(root, store, vp, KeyBuf::Trap(key), None);
	Ok(())
}

fn put(
	root: &mut state::Root,
	store: &mut dyn StateStore,
	vp: &mut Vproc,
	key: TrapKey,
	platform: Platform,
	saved: Option<ZshSavedTrap>,
) -> Result<(), StoreError> {
	clear(root, store, vp, key, platform)?;
	match saved {
		Some(ZshSavedTrap::Text(rec @ Record::Trap { .. })) => {
			state::store_record(root, store, vp, KeyBuf::Trap(key), Some(rec));
		},
		Some(ZshSavedTrap::Function { name, record: rec @ Record::Func { .. }, disabled }) => {
			set_function_disabled(root, store, vp, &name, disabled)?;
			state::store_record(root, store, vp, KeyBuf::Func(name), Some(rec));
			state::store_record(root, store, vp, KeyBuf::Trap(key), Some(Record::TrapFunction));
		},
		_ => {},
	}
	Ok(())
}

/// zsh `starttrapscope`, at the entry of a zsh function (not inside a
/// trap): the caller's `EXIT` trap is saved and removed, unless it is a
/// POSIX one. The returned list starts the function's
/// [`crate::bash::store::ZshScope::traps`].
///
/// # Errors
///
/// A store failure reading the trap or an option.
pub fn start_scope(
	root: &mut state::Root,
	store: &mut dyn StateStore,
	vp: &mut Vproc,
	platform: Platform,
) -> Result<Vec<(TrapKey, Option<ZshSavedTrap>)>, StoreError> {
	if vp.trap_frames != 0 {
		return Ok(Vec::new());
	}
	let Some(rec) = current(store, vp, TrapKey::Exit, platform, FunctionSave::Current)? else {
		return Ok(Vec::new());
	};
	if exit_posix(root, store, vp, Some(&rec))? {
		return Ok(Vec::new());
	}
	clear(root, store, vp, TrapKey::Exit, platform)?;
	Ok(vec![(TrapKey::Exit, Some(rec))])
}

/// zsh `endtrapscope`'s first step, when a zsh function returns normally:
/// take the `EXIT` trap it set (not a POSIX one) out of the table, to run
/// once the function's scope is gone ([`end_scope`] then restores what
/// the function saved).
///
/// # Errors
///
/// A store failure reading the trap or an option.
pub fn take_scope_exit(
	k: &mut Kernel,
	cx: &mut crate::bash::vm::Cx<'_>,
	vp: &mut Vproc,
) -> Result<Option<ScopeExit>, StoreError> {
	let platform = k.engine.config().platform;
	let Some(rec) = current(cx.store, vp, TrapKey::Exit, platform, FunctionSave::Current)? else {
		return Ok(None);
	};
	if exit_posix(&mut k.root, cx.store, vp, Some(&rec))? {
		return Ok(None);
	}
	clear(&mut k.root, cx.store, vp, TrapKey::Exit, platform)?;
	Ok(match rec {
		ZshSavedTrap::Text(Record::Trap { action, .. }) if action.is_empty() => None,
		ZshSavedTrap::Text(Record::Trap { action, mode, .. }) => {
			Some(ScopeExit::Text { action, mode })
		},
		ZshSavedTrap::Function { name, record, .. } => Some(ScopeExit::Func { name, record }),
		_ => None,
	})
}

/// zsh `endtrapscope` when a zsh function's scope ends however it ends
/// (`pop_frame`): drop the `EXIT` trap it set (not a POSIX one; a normal
/// return took it out to run it already), then put back every trap it
/// saved (`traps`, from its [`crate::bash::store::ZshScope`]).
///
/// # Errors
///
/// A store failure reading the trap or an option.
pub fn end_scope(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &mut Vproc,
	traps: Vec<(TrapKey, Option<ZshSavedTrap>)>,
) -> Result<bool, StoreError> {
	let platform = k.engine.config().platform;
	if vp.trap_frames == 0 {
		let rec = current(cx.store, vp, TrapKey::Exit, platform, FunctionSave::Current)?;
		if rec.is_some() && !exit_posix(&mut k.root, cx.store, vp, rec.as_ref())? {
			clear(&mut k.root, cx.store, vp, TrapKey::Exit, platform)?;
		}
	}
	let mut ok = true;
	for (key, saved) in traps {
		put(&mut k.root, cx.store, vp, key, platform, saved)?;
		if !sync_signal(k, cx, vp, key)? {
			ok = false;
		}
	}
	Ok(ok)
}

/// Whether the trap of `sig` is still the `''` zsh recorded for a signal
/// ignored when it started ([`MiscKey::ZshEntryIgnored`]).
pub fn entry_ignored(
	store: &mut dyn StateStore,
	vp: &Vproc,
	sig: Signal,
) -> Result<bool, StoreError> {
	Ok(matches!(
		state::record(store, vp, Key::Misc(MiscKey::ZshEntryIgnored))?,
		Some(Record::Words(names)) if names.iter().any(|n| n.as_slice() == <&'static str>::from(sig).as_bytes())
	))
}

fn set_name_flag(
	root: &mut state::Root,
	store: &mut dyn StateStore,
	vp: &mut Vproc,
	key: MiscKey,
	name: &[u8],
	set: bool,
) -> Result<(), StoreError> {
	let old = match state::record(store, vp, Key::Misc(key))? {
		Some(Record::Words(names)) => Some(names),
		_ => None,
	};
	if old.is_some_and(|names| names.iter().any(|n| n.as_slice() == name)) == set {
		return Ok(());
	}
	let mut names = old.cloned().unwrap_or_default();
	if set {
		names.push(name.into());
	} else {
		names.retain(|n| n.as_slice() != name);
	}
	let record = (!names.is_empty()).then_some(Record::Words(names));
	state::store_record(root, store, vp, KeyBuf::Misc(key), record);
	Ok(())
}

fn set_entry_ignored(
	root: &mut state::Root,
	store: &mut dyn StateStore,
	vp: &mut Vproc,
	sig: Signal,
	ignored: bool,
) -> Result<(), StoreError> {
	let name: &'static str = sig.into();
	set_name_flag(root, store, vp, MiscKey::ZshEntryIgnored, name.as_bytes(), ignored)
}

/// Whether a function node is disabled, without copying its source.
pub fn is_function_disabled(
	store: &mut dyn StateStore,
	vp: &Vproc,
	name: &[u8],
) -> Result<bool, StoreError> {
	Ok(matches!(
		state::record(store, vp, Key::Misc(MiscKey::ZshDisabledFuncs))?,
		Some(Record::Words(names)) if names.iter().any(|n| n.as_slice() == name)
	))
}

/// Restore a saved node's flag, or clear a fresh definition's old flag.
pub fn set_function_disabled(
	root: &mut state::Root,
	store: &mut dyn StateStore,
	vp: &mut Vproc,
	name: &[u8],
	disabled: bool,
) -> Result<(), StoreError> {
	set_name_flag(root, store, vp, MiscKey::ZshDisabledFuncs, name, disabled)
}

/// Reinstall the current handler after restoring a local trap. An OS
/// failure is a real signal diagnostic, not a store failure. Callers
/// retain the failure while restoring every remaining saved trap.
pub fn sync_signal(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &mut Vproc,
	key: TrapKey,
) -> Result<bool, StoreError> {
	let TrapKey::Signal(sig) = key else {
		return Ok(true);
	};
	if vp.overlay.is_some() || matches!(sig, Signal::Kill | Signal::Stop | Signal::Chld) {
		return Ok(true);
	}
	let handler = effective(cx.store, vp, key, k.engine.config().platform)?;
	let disposition = crate::bash::vm::jobctl::trap_disposition(k, sig, handler.disposition());
	match cx.host.set_signal_trap(sig, disposition) {
		Ok(true) => Ok(true),
		Ok(false) => {
			record_ignored(k, cx, vp, sig, handler)?;
			Ok(true)
		},
		Err(err) => {
			let line = crate::bash::vm::exec::current_line(vp);
			k.diag(cx, vp, line, Diag::SignalSetup { sig, err });
			Ok(false)
		},
	}
}

/// A host may preserve an inherited ignored disposition. Reflect that
/// in the same list/function ownership model used by virtual delivery.
pub fn record_ignored(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &mut Vproc,
	sig: Signal,
	handler: Handler,
) -> Result<(), StoreError> {
	match handler {
		Handler::Function(_) | Handler::MissingFunction => {
			set_entry_ignored(&mut k.root, cx.store, vp, sig, true)?;
		},
		Handler::Text => {
			let key = TrapKey::Signal(sig);
			let metadata = match state::record(cx.store, vp, Key::Trap(key))? {
				Some(Record::Trap { mode, assumed_name, .. }) => Some((*mode, *assumed_name)),
				_ => None,
			};
			if let Some((mode, assumed_name)) = metadata {
				state::store_record(
					&mut k.root,
					cx.store,
					vp,
					KeyBuf::Trap(key),
					Some(Record::Trap { mode, action: BString::default(), assumed_name }),
				);
			}
		},
		_ => {},
	}
	Ok(())
}

/// zsh `removetrap`'s save: the trap for `key` is about to change (`trap`,
/// a `TRAPNAL` function defined or removed). Inside a zsh function with
/// `localtraps` the function's scope keeps the trap as it was, once.
///
/// # Errors
///
/// A store failure reading the option, the scopes or the trap.
fn save_local(
	root: &mut state::Root,
	store: &mut dyn StateStore,
	vp: &mut Vproc,
	key: TrapKey,
	platform: Platform,
	function: FunctionSave<'_>,
) -> Result<(), StoreError> {
	// `EXIT` is saved under native rules (not `posixtraps`): a function
	// replacing a POSIX `EXIT` trap puts it back when it ends (its caller's
	// native one `start_scope` saved already); other traps under
	// `localtraps`.
	let opt = if key == TrapKey::Exit {
		crate::bash::zshopt::ZshOpt::Posixtraps
	} else {
		crate::bash::zshopt::ZshOpt::Localtraps
	};
	if state::zsh_option(root, store, vp, opt)? == (key == TrapKey::Exit) {
		return Ok(());
	}
	for i in (0..state::scope_count(root, vp)).rev() {
		let Some(mut z) = state::scope_zsh(store, vp, i)? else {
			continue;
		};
		if !z.traps.iter().any(|(k, _)| *k == key) {
			let mut now = current(store, vp, key, platform, function)?;
			// zsh `endtrapscope` restores only a trap with text: not the
			// ignored-on-entry `QUIT`.
			if let TrapKey::Signal(sig) = key
				&& matches!(&now, Some(ZshSavedTrap::Text(Record::Trap { action, .. })) if action.is_empty())
				&& entry_ignored(store, vp, sig)?
			{
				now = None;
			}
			z.traps.push((key, now));
			state::set_scope_zsh(root, store, vp, i, Some(z));
		}
		break;
	}
	Ok(())
}

/// The two zsh definition routes have different removal ordering.
pub enum FunctionDefinition {
	/// `execfuncdef`: install, then remove any remaining alternate node.
	Body,
	/// `autoload`: remove the old trap before adding the new stub.
	Autoload,
}

/// A missing node differs from an already-diagnosed host failure.
pub enum Removal {
	/// No active function node was removed.
	Absent,
	/// The selected node was removed.
	Removed,
	/// Host disposition setup failed without changing the table.
	Failed,
}

fn function_disposition(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &mut Vproc,
	key: TrapKey,
	caught: bool,
) -> Result<bool, StoreError> {
	let TrapKey::Signal(sig) = key else {
		return Ok(true);
	};
	let accepted =
		if vp.overlay.is_none() && !matches!(sig, Signal::Kill | Signal::Stop | Signal::Chld) {
			let action = caught.then(|| BStr::new(b"catch"));
			let disposition = crate::bash::vm::jobctl::trap_disposition(k, sig, action);
			match cx.host.set_signal_trap(sig, disposition) {
				Ok(accepted) => accepted,
				Err(err) => {
					let line = crate::bash::vm::exec::current_line(vp);
					k.diag(cx, vp, line, Diag::SignalSetup { sig, err });
					return Ok(false);
				},
			}
		} else {
			true
		};
	set_entry_ignored(&mut k.root, cx.store, vp, sig, caught && !accepted)?;
	Ok(true)
}

/// Register a validated definition, preserving zsh's separate numeric
/// activation flag. `functions -c` deliberately does not call this.
///
/// # Errors
///
/// A store failure. Host setup failures are diagnosed and return `false`.
pub fn func_defined(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &mut Vproc,
	name: &[u8],
	definition: FunctionDefinition,
) -> Result<bool, StoreError> {
	let platform = k.engine.config().platform;
	let Some(key) = func_key(name, platform) else {
		return Ok(true);
	};
	save_local(&mut k.root, cx.store, vp, key, platform, FunctionSave::Current)?;
	let previous =
		if matches!(state::record(cx.store, vp, Key::Trap(key))?, Some(Record::TrapFunction)) {
			function_name(cx.store, vp, key, platform, true)?
		} else {
			None
		};
	let mut remaining = None;
	if matches!(definition, FunctionDefinition::Body) {
		for candidate in func_names(key, platform).into_iter().flatten() {
			if Some(candidate) != previous
				&& matches!(
					state::record(cx.store, vp, Key::Func(BStr::new(candidate)))?,
					Some(Record::Func { .. })
				) {
				remaining = Some(candidate);
				break;
			}
		}
	}
	// `execfuncdef`'s second `removetrapnode` disables the newly set flag
	// when an ordinary copied node remains. An autoload installs its flag
	// after that removal instead. Match this observable zsh ordering.
	let active = remaining.is_none();
	if !function_disposition(k, cx, vp, key, active)? {
		return Ok(false);
	}
	for old in [previous, remaining].into_iter().flatten() {
		if old.as_bytes() != name {
			state::store_record(&mut k.root, cx.store, vp, KeyBuf::Func(old.into()), None);
		}
	}
	state::store_record(
		&mut k.root,
		cx.store,
		vp,
		KeyBuf::Trap(key),
		active.then_some(Record::TrapFunction),
	);
	vp.own_traps = vp.own_traps.with(key);
	if active {
		k.pseudo_traps.note(key);
	}
	Ok(true)
}

/// zsh's function-table removal hook removes the numeric trap's selected
/// node, even when the requested alternate name itself is absent. A
/// copied ordinary `TRAP` node is not removed without an active flag.
///
/// # Errors
///
/// A store failure. Host failures are diagnosed and return `Failed`.
pub fn remove_function(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &mut Vproc,
	key: TrapKey,
) -> Result<Removal, StoreError> {
	let platform = k.engine.config().platform;
	save_local(&mut k.root, cx.store, vp, key, platform, FunctionSave::Current)?;
	let selected =
		if matches!(state::record(cx.store, vp, Key::Trap(key))?, Some(Record::TrapFunction)) {
			function_name(cx.store, vp, key, platform, true)?
		} else {
			None
		};
	if !function_disposition(k, cx, vp, key, false)? {
		return Ok(Removal::Failed);
	}
	if let Some(name) = selected {
		state::store_record(&mut k.root, cx.store, vp, KeyBuf::Func(name.into()), None);
	}
	state::store_record(&mut k.root, cx.store, vp, KeyBuf::Trap(key), None);
	vp.own_traps = vp.own_traps.with(key);
	Ok(if selected.is_some() {
		Removal::Removed
	} else {
		Removal::Absent
	})
}

/// zsh's enable/disable hooks change activation separately from the
/// function node. Disabling clears `ZSIG_FUNC` before saving a local
/// trap; enabling runs `settrap`, which removes a previously active node.
///
/// # Errors
///
/// A store failure. Host setup failures are diagnosed and return `false`.
pub fn function_enabled(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &mut Vproc,
	name: &[u8],
	enabled: bool,
) -> Result<bool, StoreError> {
	let platform = k.engine.config().platform;
	let Some(key) = func_key(name, platform) else {
		return Ok(true);
	};
	let function = if enabled {
		FunctionSave::Enabling(name)
	} else {
		FunctionSave::Forget
	};
	save_local(&mut k.root, cx.store, vp, key, platform, function)?;
	if !function_disposition(k, cx, vp, key, enabled)? {
		return Ok(false);
	}
	if enabled {
		clear_function(&mut k.root, cx.store, vp, key, platform)?;
	}
	state::store_record(
		&mut k.root,
		cx.store,
		vp,
		KeyBuf::Trap(key),
		enabled.then_some(Record::TrapFunction),
	);
	vp.own_traps = vp.own_traps.with(key);
	if enabled {
		k.pseudo_traps.note(key);
	}
	Ok(true)
}

/// zsh's trap key for `spec` (zsh `getsignum`): a number (0 is `EXIT`), a
/// signal name as zsh spells it (upper case, with or without `SIG`),
/// `EXIT`, `ZERR` (or `ERR`), `DEBUG`. Anything else is not a signal (so
/// `trap int INT` takes `int` as the action).
fn zsh_key(spec: &[u8], platform: Platform) -> Option<(TrapKey, bool)> {
	if !spec.is_empty() && spec.iter().all(u8::is_ascii_digit) {
		let number = std::str::from_utf8(spec).ok()?.parse::<u8>().ok()?;
		let key = match number {
			0 => TrapKey::Exit,
			n if n == ZSH_SIGCOUNT + 1 => TrapKey::Err,
			n if n == ZSH_SIGCOUNT + 2 => TrapKey::Debug,
			n => TrapKey::Signal(Signal::from_number(n, platform)?),
		};
		return Some((key, false));
	}
	let name = spec.strip_prefix(b"SIG").unwrap_or(spec);
	match name {
		b"EXIT" => Some((TrapKey::Exit, false)),
		b"ZERR" => Some((TrapKey::Err, false)),
		b"ERR" => Some((TrapKey::Err, true)),
		b"DEBUG" => Some((TrapKey::Debug, false)),
		name => Signal::parse_zsh_name(name, platform, false)
			.map(|(sig, assumed)| (TrapKey::Signal(sig), assumed)),
	}
}

/// zsh's name of a trap in listings (`INT`, `EXIT`, `ZERR`, `DEBUG`).
fn zsh_name(key: TrapKey, platform: Platform, assumed: bool) -> &'static str {
	match key {
		TrapKey::Signal(sig) => {
			if assumed {
				sig.zsh_alias(platform)
					.unwrap_or_else(|| sig.zsh_name(platform))
			} else {
				sig.zsh_name(platform)
			}
		},
		TrapKey::Exit => "EXIT",
		TrapKey::Err if assumed => "ERR",
		TrapKey::Err => "ZERR",
		TrapKey::Debug => "DEBUG",
		TrapKey::Return => "RETURN",
	}
}

/// zsh `quotedzputs`: the text as is when nothing in it is special to the
/// shell, else single-quoted (`'` as `'\''`).
fn zsh_quote(text: &[u8]) -> Vec<u8> {
	const SPECIAL: &[u8] = b"#$^*()=|{}[]`<>?~;&\n\t \\'\"";
	if !text.is_empty() && !text.iter().any(|c| SPECIAL.contains(c)) {
		return text.to_vec();
	}
	let mut out = Vec::with_capacity(text.len() + 2);
	out.push(b'\'');
	for &c in text {
		if c == b'\'' {
			out.extend_from_slice(b"'\\''");
		} else {
			out.push(c);
		}
	}
	out.push(b'\'');
	out
}

/// Every trap set (records and `TRAPNAL` functions), with zsh's number for
/// ordering.
fn zsh_traps(ctx: &mut Ctx<'_, '_>) -> Result<Vec<(TrapKey, ZshSavedTrap)>, super::Need> {
	let platform = ctx.k.engine.config().platform;
	let mut all = Vec::new();
	for (key, rec) in state::listed_traps(&ctx.k.root, ctx.cx.store, ctx.vp)? {
		let KeyBuf::Trap(key) = key else { continue };
		match rec {
			rec @ Record::Trap { .. } if key != TrapKey::Return => {
				all.push((key, ZshSavedTrap::Text(rec)));
			},
			Record::TrapFunction => {
				if let Some((name, record)) =
					function_record(ctx.cx.store, ctx.vp, key, platform, false)?
				{
					all.push((key, ZshSavedTrap::Function {
						name: name.into(),
						record,
						disabled: false,
					}));
				}
			},
			_ => {},
		}
	}
	all.sort_by_key(|(key, _)| zsh_number(*key, platform));
	Ok(all)
}

/// Set (`Some`) or remove (`None`) the trap for `key` in zsh (`settrap`,
/// `unsettrap`): under `localtraps` the enclosing function saves the old
/// one; a `TRAPNAL` function for it goes; the root shell's signal
/// disposition follows, as for bash's `trap`.
fn zsh_change(
	ctx: &mut Ctx<'_, '_>,
	key: TrapKey,
	assumed_name: bool,
	action: Option<BString>,
) -> Result<bool, super::Need> {
	let platform = ctx.k.engine.config().platform;
	save_local(&mut ctx.k.root, ctx.cx.store, ctx.vp, key, platform, FunctionSave::Current)?;
	let mut effective = action;
	if ctx.vp.overlay.is_none()
		&& let TrapKey::Signal(sig) = key
		&& !matches!(sig, Signal::Kill | Signal::Stop | Signal::Chld)
	{
		let disposition =
			crate::bash::vm::jobctl::trap_disposition(ctx.k, sig, effective.as_ref().map(BStr::new));
		match ctx.cx.host.set_signal_trap(sig, disposition) {
			Ok(true) => {},
			Ok(false) => effective = effective.map(|_| BString::default()),
			Err(err) => {
				ctx.err(Diag::SignalSetup { sig, err });
				return Ok(false);
			},
		}
	}
	clear_function(&mut ctx.k.root, ctx.cx.store, ctx.vp, key, platform)?;
	if let TrapKey::Signal(sig) = key {
		set_entry_ignored(&mut ctx.k.root, ctx.cx.store, ctx.vp, sig, false)?;
	}
	let record =
		effective.map(|action| Record::Trap { mode: mode_of(ctx.vp), action, assumed_name });
	ctx.vp.own_traps = ctx.vp.own_traps.with(key);
	if matches!(&record, Some(Record::Trap { action, .. }) if !action.is_empty()) {
		ctx.k.pseudo_traps.note(key);
	}
	ctx.store_record(KeyBuf::Trap(key), record);
	Ok(true)
}

/// zsh `trap` (`bin_trap`): without arguments list every trap (`trap --
/// ACTION NAME`, or a `TRAPNAL` function's text) in signal order; `trap
/// [-] SIG …` (a first argument that is a signal, or `-`) removes the
/// traps, `trap -` alone all of them; `trap ACTION SIG …` sets them. An
/// unknown signal is `undefined signal: X` (status 1).
pub fn zsh_trap(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	let platform = ctx.k.engine.config().platform;
	let args = match args.first() {
		Some(a) if a.as_slice() == b"--" => &args[1..],
		_ => args,
	};
	let Some(first) = args.first() else {
		for (key, rec) in zsh_traps(ctx)? {
			match rec {
				ZshSavedTrap::Text(Record::Trap { action, assumed_name, .. }) => {
					let mut line = b"trap -- ".to_vec();
					line.extend_from_slice(&zsh_quote(&action));
					line.push(b' ');
					line.extend_from_slice(zsh_name(key, platform, assumed_name).as_bytes());
					line.push(b'\n');
					ctx.out(&line);
				},
				ZshSavedTrap::Function { name, record, .. } => {
					let mut text = Vec::new();
					super::zsh_names::print_func(ctx, &name, &record, 0, 0, &mut text)?;
					ctx.out(&text);
				},
				_ => {},
			}
		}
		return done(0);
	};
	if first.as_slice() == b"-" || zsh_key(first, platform).is_some() {
		let specs = if first.as_slice() == b"-" {
			&args[1..]
		} else {
			args
		};
		if specs.is_empty() {
			let mut keys: Vec<TrapKey> = state::listed_traps(&ctx.k.root, ctx.cx.store, ctx.vp)?
				.into_iter()
				.filter_map(|(key, _)| match key {
					KeyBuf::Trap(key) if key != TrapKey::Return => Some(key),
					_ => None,
				})
				.collect();
			keys.sort_unstable_by_key(|key| zsh_number(*key, platform));
			let mut status = 0;
			for key in keys {
				if !zsh_change(ctx, key, false, None)? {
					status = 1;
				}
			}
			return done(status);
		}
		let mut status = 0;
		for spec in specs {
			let Some((key, assumed)) = zsh_key(spec, platform) else {
				ctx.usage(format!("undefined signal: {}", spec.as_bstr()));
				return done(1);
			};
			if !zsh_change(ctx, key, assumed, None)? {
				status = 1;
			}
		}
		return done(status);
	}
	let mut status = 0;
	for spec in &args[1..] {
		let Some((key, assumed)) = zsh_key(spec, platform) else {
			ctx.usage(format!("undefined signal: {}", spec.as_bstr()));
			return done(1);
		};
		if !zsh_change(ctx, key, assumed, Some(first.clone()))? {
			status = 1;
		}
	}
	done(status)
}

pub(super) fn trap(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	// bash parses `-l`, `-p` and `-P` with `internal_getopt`; anything else
	// is an invalid option with the usage line.
	let o = match opts(ctx, args, b"lpP", b"", false) {
		Ok(o) => o,
		Err(st) => return done(st),
	};
	let (printing, action_only) = (o.has(b'p'), o.has(b'P'));
	let args = o.rest;
	if printing && action_only {
		ctx.usage("cannot specify both -p and -P");
		return done(2);
	}
	if action_only && args.is_empty() {
		ctx.usage("-P requires at least one signal name");
		return done(2);
	}
	if o.has(b'l') {
		// The same table as `kill -l` (bash's `display_signal_list`).
		return super::kill::list(ctx, &[]);
	}
	if args.is_empty() {
		let mut records = state::listed_traps(&ctx.k.root, ctx.cx.store, ctx.vp)?;
		let platform = ctx.k.engine.config().platform;
		records.sort_by_key(|(key, _)| match key {
			KeyBuf::Trap(TrapKey::Exit) => 0,
			KeyBuf::Trap(TrapKey::Signal(sig)) => u16::from(sig.number(platform)),
			KeyBuf::Trap(TrapKey::Debug) => 256,
			KeyBuf::Trap(TrapKey::Err) => 257,
			KeyBuf::Trap(TrapKey::Return) => 258,
			_ => 259,
		});
		for (key, rec) in records {
			if let (KeyBuf::Trap(key), Record::Trap { action, .. }) = (key, rec) {
				print(ctx, key, &action);
			}
		}
		return done(0);
	}
	let platform = ctx.k.engine.config().platform;
	if printing || action_only {
		let listed = state::listed_traps(&ctx.k.root, ctx.cx.store, ctx.vp)?;
		let mut status = 0;
		for spec in args {
			let Some(key) = key(spec, platform) else {
				ctx.diag(Diag::InvalidSignal { cmd: "trap".into(), spec: spec.clone() });
				status = 1;
				continue;
			};
			let found = listed.iter().find(|(k, _)| *k == KeyBuf::Trap(key));
			if let Some((_, Record::Trap { action, .. })) = found {
				if action_only {
					// `-P`: the action alone (bash's `DISP_ACTIONONLY`).
					let mut line = action.to_vec();
					line.push(b'\n');
					ctx.out(&line);
				} else {
					print(ctx, key, action);
				}
			}
		}
		return done(status);
	}
	// bash `trap_builtin`: a lone signal number (or, outside posix mode, a
	// lone signal name) resets it; otherwise the first word is the action
	// (`-` resets), and an action without signals is a usage error.
	let first = &args[0];
	let is_signal = |s: &[u8]| key(s, platform).is_some();
	let lone_name = args.len() == 1
		&& !first.is_empty()
		&& first.as_slice() != b"-"
		&& is_signal(first)
		&& !ctx.option(OptId::Posix)?;
	let (action, specs) =
		if (!first.is_empty() && first.iter().all(u8::is_ascii_digit) && is_signal(first))
			|| lone_name
		{
			(None, args)
		} else {
			let specs = &args[1..];
			if specs.is_empty() {
				ctx.builtin_usage();
				return done(2);
			}
			((first.as_slice() != b"-").then(|| first.clone()), specs)
		};
	let hard_ignored = match ctx.vp.overlay {
		Some(_) => match ctx.record(Key::Misc(MiscKey::HardIgnored))? {
			Some(Record::Words(names)) => names,
			_ => Vec::new(),
		},
		None => Vec::new(),
	};
	// bash `free_trap_strings`: a subshell that changes a trap stops
	// listing the caught-signal traps it inherited.
	if ctx.vp.parent.is_some() {
		let inherited: Vec<KeyBuf> = state::listed_traps(&ctx.k.root, ctx.cx.store, ctx.vp)?
			.into_iter()
			.filter(
				|(key, r)| matches!(key, KeyBuf::Trap(key) if state::inherited_trap(ctx.vp, *key, Some(r))),
			)
			.map(|(key, _)| key)
			.collect();
		for key in inherited {
			ctx.store_record(key, None);
		}
	}
	let mut status = 0;
	for spec in specs {
		let Some(key) = key(spec, platform) else {
			ctx.diag(Diag::InvalidSignal { cmd: "trap".into(), spec: spec.clone() });
			status = 1;
			continue;
		};
		// A signal ignored when this (new) shell started stays ignored.
		if let TrapKey::Signal(sig) = key
			&& hard_ignored
				.iter()
				.any(|n| n.as_slice() == sig.to_string().as_bytes())
		{
			continue;
		}
		let mut effective = action.clone();
		if ctx.vp.overlay.is_none()
			&& let TrapKey::Signal(sig) = key
			// `CHLD` comes from the engine (one per reaped child), not the OS.
			&& !matches!(sig, Signal::Kill | Signal::Stop | Signal::Chld)
		{
			// The root shell's OS disposition follows its traps (signals
			// ignored on entry stay ignored, as in a non-interactive bash).
			let disposition = crate::bash::vm::jobctl::trap_disposition(
				ctx.k,
				sig,
				effective.as_ref().map(BStr::new),
			);
			match ctx.cx.host.set_signal_trap(sig, disposition) {
				Ok(true) => {},
				Ok(false) => effective = Some(BString::default()),
				Err(err) => {
					ctx.err(Diag::SignalSetup { sig, err });
					status = 1;
					continue;
				},
			}
		}
		let record = effective.map(|action| Record::Trap {
			mode: mode_of(ctx.vp),
			action,
			assumed_name: false,
		});
		// The innermost function (for DEBUG also `.` file) and the vproc
		// now run it as their own rather than an inherited trap.
		ctx.vp.own_traps = ctx.vp.own_traps.with(key);
		if let Some(frame) = ctx.vp.frames.iter_mut().rev().find(|f| {
			matches!(f.kind, FrameKind::Function { .. })
				|| (key == TrapKey::Debug
					&& matches!(f.kind, FrameKind::Script { what: ScriptKind::Source, .. }))
		}) {
			match key {
				TrapKey::Debug => frame.debug_trap_local = true,
				TrapKey::Err => frame.err_trap_local = true,
				TrapKey::Return => frame.return_trap_local = true,
				TrapKey::Exit | TrapKey::Signal(_) => {},
			}
		}
		if matches!(&record, Some(Record::Trap { action, .. }) if !action.is_empty()) {
			ctx.k.pseudo_traps.note(key);
		}
		ctx.store_record(KeyBuf::Trap(key), record);
	}
	done(status)
}

/// bash: a new shell (a script run as `ENOEXEC`) cannot trap or reset the
/// signals ignored when it starts. Records in `child` the signals `parent`
/// ignores; the nested shell's `fresh_shell` (also a script run as
/// `ENOEXEC`) calls it on the child it creates.
///
/// # Errors
///
/// A store failure reading the parent's traps.
pub fn hard_ignore(
	k: &mut Kernel,
	store: &mut dyn StateStore,
	parent: &Vproc,
	child: &mut Vproc,
) -> Result<(), StoreError> {
	let mut names = Vec::new();
	for (key, rec) in state::scan(&k.root, store, parent, Table::Trap)? {
		let KeyBuf::Trap(TrapKey::Signal(sig)) = key else {
			continue;
		};
		let ignored = match rec {
			Record::Trap { action, .. } => action.is_empty(),
			Record::TrapFunction => entry_ignored(store, parent, sig)?,
			_ => false,
		};
		if ignored {
			let name: &'static str = sig.into();
			names.push(BString::from(name));
		}
	}
	if !names.is_empty() {
		state::store_record(
			&mut k.root,
			store,
			child,
			KeyBuf::Misc(MiscKey::HardIgnored),
			Some(Record::Words(names)),
		);
	}
	Ok(())
}

#[cfg(test)]
mod tests {
	use super::{func_alias, func_key, func_name, zsh_key, zsh_number};
	use crate::bash::{
		ids::Platform,
		signal::{Signal, ZSH_SIGCOUNT},
		store::TrapKey,
	};

	#[test]
	fn function_names_and_pseudo_signal_numbers_share_one_resolution_policy() {
		for platform in [Platform::Linux, Platform::MacOs, Platform::Windows] {
			for number in 1..=ZSH_SIGCOUNT {
				let key = TrapKey::Signal(Signal::from_number(number, platform).unwrap());
				assert_eq!(func_key(func_name(key, platform).unwrap().as_bytes(), platform), Some(key));
				if let Some(alias) = func_alias(key, platform) {
					assert_eq!(func_key(alias.as_bytes(), platform), Some(key));
				}
			}
			assert_eq!(func_key(b"TRAPERR", platform), Some(TrapKey::Err));
			assert_eq!(func_key(b"TRAP0", platform), None);
			assert_eq!(func_key(b"TRAP6", platform), None);
			assert_eq!(zsh_key(b"32", platform), Some((TrapKey::Err, false)));
			assert_eq!(zsh_key(b"33", platform), Some((TrapKey::Debug, false)));
			assert_eq!(zsh_number(TrapKey::Err, platform), 32);
			assert_eq!(zsh_number(TrapKey::Debug, platform), 33);
		}
		assert_eq!(func_key(b"TRAPABRT", Platform::Linux), None);
		assert_eq!(func_key(b"TRAPIOT", Platform::MacOs), None);
		assert_eq!(zsh_key(b"IO", Platform::Linux), Some((TrapKey::Signal(Signal::Io), true)));
		assert_eq!(zsh_key(b"POLL", Platform::Linux), Some((TrapKey::Signal(Signal::Io), false)));
		assert_eq!(zsh_key(b"ERR", Platform::Linux), Some((TrapKey::Err, true)));
	}
}
