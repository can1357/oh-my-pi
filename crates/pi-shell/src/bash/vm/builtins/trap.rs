//! The `trap` special builtin, and zsh's trap scopes.
//!
//! zsh parts are ported from zsh 5.9 `signals.c` and `builtin.c` (MIT-style
//! licence, Copyright (c) 1992-1997 Paul Falstad and the zsh development
//! group). In zsh a `TRAPNAL` function is the trap for `NAL` (zsh
//! `ZSIG_FUNC`): it lives in the function table only, and a `Record::Trap`
//! and that function exclude each other. A zsh function's scope
//! ([`crate::bash::store::ZshScope::traps`]) keeps the traps it replaced: its
//! caller's `EXIT` trap (always, unless `posixtraps`) and, under
//! `localtraps`, every trap it changed; they come back when it returns.

use bstr::{BStr, BString, ByteSlice};

use super::{Ctx, R, done, opts};
use crate::bash::{
	diag::Diag,
	signal::Signal,
	store::{Key, KeyBuf, MiscKey, OptId, Record, StateStore, StoreError, Table, TrapKey},
	vm::{
		Kernel,
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

/// The zsh function that is the trap for `key` (`TRAPINT`, `TRAPZERR`,
/// `TRAPEXIT`, `TRAPDEBUG`); `None` for bash's `RETURN`.
pub fn func_name(key: TrapKey) -> Option<BString> {
	Some(match key {
		TrapKey::Signal(sig) => BString::from(format!("TRAP{sig}")),
		TrapKey::Exit => BString::from("TRAPEXIT"),
		TrapKey::Err => BString::from("TRAPZERR"),
		TrapKey::Debug => BString::from("TRAPDEBUG"),
		TrapKey::Return => return None,
	})
}

/// The trap key a zsh function name makes a trap of (`TRAPINT` → `INT`,
/// `TRAPZERR` → ZERR), if any.
pub fn func_key(name: &[u8], platform: crate::bash::ids::Platform) -> Option<TrapKey> {
	let sig = name.strip_prefix(b"TRAP")?;
	match sig {
		b"EXIT" => Some(TrapKey::Exit),
		b"ZERR" | b"ERR" => Some(TrapKey::Err),
		b"DEBUG" => Some(TrapKey::Debug),
		_ if !sig.is_empty() && sig.iter().all(u8::is_ascii_uppercase) => {
			Signal::parse_spec(sig, platform).map(TrapKey::Signal)
		},
		_ => None,
	}
}

/// zsh's signal number of `key` (`$1` of a `TRAPNAL` function): `EXIT` is
/// 0, `ZERR` and `DEBUG` follow the real signals.
pub fn zsh_number(key: TrapKey, platform: crate::bash::ids::Platform) -> i32 {
	let count = if platform == crate::bash::Platform::MacOs {
		31
	} else {
		64
	};
	match key {
		TrapKey::Signal(sig) => i32::from(sig.number(platform)),
		TrapKey::Exit | TrapKey::Return => 0,
		TrapKey::Err => count + 1,
		TrapKey::Debug => count + 2,
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
	/// A `TRAPEXIT` function (its record, already out of the table).
	Func(Record),
}

/// Whether the `EXIT` trap now set is POSIX-style (global, not scoped to
/// functions): set with `posixtraps` in effect (zsh `exit_trap_posix`;
/// approximated by the mode it was set in and the option now).
fn exit_posix(
	root: &mut state::Root,
	store: &mut dyn StateStore,
	vp: &Vproc,
	rec: Option<&Record>,
) -> Result<bool, StoreError> {
	let mode_posix =
		matches!(rec, Some(Record::Trap { mode, .. }) if *mode != crate::bash::ids::ModeId::Zsh);
	Ok(mode_posix || state::zsh_option(root, store, vp, crate::bash::zshopt::ZshOpt::Posixtraps)?)
}

/// The trap record for `key` now and its `TRAPNAL` function: what a scope
/// saves (`None`: neither).
fn current(
	store: &mut dyn StateStore,
	vp: &Vproc,
	key: TrapKey,
) -> Result<Option<Record>, StoreError> {
	if let Some(rec @ Record::Trap { .. }) = state::record(store, vp, Key::Trap(key))? {
		return Ok(Some(rec.clone()));
	}
	let Some(name) = func_name(key) else {
		return Ok(None);
	};
	Ok(match state::record(store, vp, Key::Func(BStr::new(&name)))? {
		Some(rec @ Record::Func { .. }) => Some(rec.clone()),
		_ => None,
	})
}

/// Remove the trap for `key`: its record and its `TRAPNAL` function.
fn clear(root: &mut state::Root, store: &mut dyn StateStore, vp: &mut Vproc, key: TrapKey) {
	state::store_record(root, store, vp, KeyBuf::Trap(key), None);
	if let Some(name) = func_name(key) {
		state::store_record(root, store, vp, KeyBuf::Func(name), None);
	}
}

/// Put `saved` (a trap record or a `TRAPNAL` function) back as the trap for
/// `key`, or none.
fn put(
	root: &mut state::Root,
	store: &mut dyn StateStore,
	vp: &mut Vproc,
	key: TrapKey,
	saved: Option<Record>,
) {
	clear(root, store, vp, key);
	match saved {
		Some(rec @ Record::Trap { .. }) => {
			state::store_record(root, store, vp, KeyBuf::Trap(key), Some(rec));
		},
		Some(rec @ Record::Func { .. }) => {
			if let Some(name) = func_name(key) {
				state::store_record(root, store, vp, KeyBuf::Func(name), Some(rec));
			}
		},
		_ => {},
	}
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
) -> Result<Vec<(TrapKey, Option<Record>)>, StoreError> {
	if vp.trap_frames != 0 {
		return Ok(Vec::new());
	}
	let Some(rec) = current(store, vp, TrapKey::Exit)? else {
		return Ok(Vec::new());
	};
	if exit_posix(root, store, vp, Some(&rec))? {
		return Ok(Vec::new());
	}
	clear(root, store, vp, TrapKey::Exit);
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
	let Some(rec) = current(cx.store, vp, TrapKey::Exit)? else {
		return Ok(None);
	};
	if exit_posix(&mut k.root, cx.store, vp, Some(&rec))? {
		return Ok(None);
	}
	clear(&mut k.root, cx.store, vp, TrapKey::Exit);
	Ok(match rec {
		Record::Trap { action, .. } if action.is_empty() => None,
		Record::Trap { action, mode } => Some(ScopeExit::Text { action, mode }),
		rec => Some(ScopeExit::Func(rec)),
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
	root: &mut state::Root,
	store: &mut dyn StateStore,
	vp: &mut Vproc,
	traps: Vec<(TrapKey, Option<Record>)>,
) -> Result<(), StoreError> {
	if vp.trap_frames == 0 {
		let rec = current(store, vp, TrapKey::Exit)?;
		if rec.is_some() && !exit_posix(root, store, vp, rec.as_ref())? {
			clear(root, store, vp, TrapKey::Exit);
		}
	}
	for (key, saved) in traps {
		put(root, store, vp, key, saved);
	}
	Ok(())
}

/// Whether the trap of `sig` is still the `''` zsh recorded for a signal
/// ignored when it started ([`MiscKey::ZshEntryIgnored`]).
fn entry_ignored(store: &mut dyn StateStore, vp: &Vproc, sig: Signal) -> Result<bool, StoreError> {
	Ok(matches!(
		state::record(store, vp, Key::Misc(MiscKey::ZshEntryIgnored))?,
		Some(Record::Words(names)) if names.iter().any(|n| n.as_slice() == sig.to_string().as_bytes())
	))
}

/// zsh `removetrap`'s save: the trap for `key` is about to change (`trap`,
/// a `TRAPNAL` function defined or removed). Inside a zsh function with
/// `localtraps` the function's scope keeps the trap as it was, once.
///
/// # Errors
///
/// A store failure reading the option, the scopes or the trap.
pub fn save_local(
	root: &mut state::Root,
	store: &mut dyn StateStore,
	vp: &mut Vproc,
	key: TrapKey,
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
			let mut now = current(store, vp, key)?;
			// zsh `endtrapscope` restores only a trap with text: not the
			// ignored-on-entry `QUIT`.
			if let TrapKey::Signal(sig) = key
				&& matches!(&now, Some(Record::Trap { action, .. }) if action.is_empty())
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

/// A zsh `TRAPNAL` function named `name` is about to be defined or removed
/// (function definition, `unfunction`, `unset -f`): under `localtraps` the
/// enclosing function saves the trap ([`save_local`]); a definition
/// replaces a `trap` action for the same signal and makes the trap known
/// to the DEBUG/ZERR fast path. `None` when `name` names no trap.
///
/// # Errors
///
/// A store failure reading the option, the scopes or the trap.
pub fn func_changing(
	k: &mut Kernel,
	store: &mut dyn StateStore,
	vp: &mut Vproc,
	name: &[u8],
	defining: bool,
) -> Result<Option<TrapKey>, StoreError> {
	let Some(key) = func_key(name, k.engine.config().platform) else {
		return Ok(None);
	};
	save_local(&mut k.root, store, vp, key)?;
	if defining {
		state::store_record(&mut k.root, store, vp, KeyBuf::Trap(key), None);
		k.pseudo_traps.note(key);
	}
	Ok(Some(key))
}

/// zsh's trap key for `spec` (zsh `getsignum`): a number (0 is `EXIT`), a
/// signal name as zsh spells it (upper case, with or without `SIG`),
/// `EXIT`, `ZERR` (or `ERR`), `DEBUG`. Anything else is not a signal (so
/// `trap int INT` takes `int` as the action).
fn zsh_key(spec: &[u8], platform: crate::bash::ids::Platform) -> Option<TrapKey> {
	if spec == b"0" {
		return Some(TrapKey::Exit);
	}
	if !spec.is_empty() && spec.iter().all(u8::is_ascii_digit) {
		return Signal::parse_spec(spec, platform).map(TrapKey::Signal);
	}
	let name = spec.strip_prefix(b"SIG").unwrap_or(spec);
	match name {
		b"EXIT" => Some(TrapKey::Exit),
		b"ZERR" | b"ERR" => Some(TrapKey::Err),
		b"DEBUG" => Some(TrapKey::Debug),
		_ if !name.is_empty()
			&& name
				.iter()
				.all(|&c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == b'+') =>
		{
			Signal::parse_spec(name, platform).map(TrapKey::Signal)
		},
		_ => None,
	}
}

/// zsh's name of a trap in listings (`INT`, `EXIT`, `ZERR`, `DEBUG`).
fn zsh_name(key: TrapKey) -> String {
	match key {
		TrapKey::Signal(sig) => sig.to_string(),
		TrapKey::Exit => "EXIT".into(),
		TrapKey::Err => "ZERR".into(),
		TrapKey::Debug => "DEBUG".into(),
		TrapKey::Return => "RETURN".into(),
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
fn zsh_traps(ctx: &mut Ctx<'_, '_>) -> Result<Vec<(TrapKey, Record)>, super::Need> {
	let platform = ctx.k.engine.config().platform;
	let mut all = Vec::new();
	for (key, rec) in state::listed_traps(&ctx.k.root, ctx.cx.store, ctx.vp)? {
		if let (KeyBuf::Trap(key), rec @ Record::Trap { .. }) = (key, rec)
			&& key != TrapKey::Return
		{
			all.push((key, rec));
		}
	}
	for (key, rec) in state::scan(&ctx.k.root, ctx.cx.store, ctx.vp, Table::Func)? {
		if let (KeyBuf::Func(name), rec @ Record::Func { .. }) = (key, rec)
			&& let Some(key) = func_key(&name, platform)
		{
			all.push((key, rec));
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
	action: Option<BString>,
) -> Result<bool, super::Need> {
	save_local(&mut ctx.k.root, ctx.cx.store, ctx.vp, key)?;
	if let Some(name) = func_name(key) {
		ctx.store_record(KeyBuf::Func(name), None);
	}
	if let TrapKey::Signal(sig) = key
		&& entry_ignored(ctx.cx.store, ctx.vp, sig)?
	{
		ctx.store_record(KeyBuf::Misc(MiscKey::ZshEntryIgnored), None);
	}
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
	let record = effective.map(|action| Record::Trap { mode: mode_of(ctx.vp), action });
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
				Record::Trap { action, .. } => {
					let mut line = b"trap -- ".to_vec();
					line.extend_from_slice(&zsh_quote(&action));
					line.push(b' ');
					line.extend_from_slice(zsh_name(key).as_bytes());
					line.push(b'\n');
					ctx.out(&line);
				},
				Record::Func { source, .. } => {
					let mut text = source.to_vec();
					text.push(b'\n');
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
			let keys: Vec<TrapKey> = zsh_traps(ctx)?.into_iter().map(|(key, _)| key).collect();
			for key in keys {
				zsh_change(ctx, key, None)?;
			}
			return done(0);
		}
		for spec in specs {
			let Some(key) = zsh_key(spec, platform) else {
				ctx.usage(format!("undefined signal: {}", spec.as_bstr()));
				return done(1);
			};
			zsh_change(ctx, key, None)?;
		}
		return done(0);
	}
	let mut status = 0;
	for spec in &args[1..] {
		let Some(key) = zsh_key(spec, platform) else {
			ctx.usage(format!("undefined signal: {}", spec.as_bstr()));
			return done(1);
		};
		if !zsh_change(ctx, key, Some(first.clone()))? {
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
		let record = effective.map(|action| Record::Trap { mode: mode_of(ctx.vp), action });
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
	let names: Vec<BString> = state::scan(&k.root, store, parent, Table::Trap)?
		.into_iter()
		.filter_map(|(key, rec)| match (key, rec) {
			(KeyBuf::Trap(TrapKey::Signal(sig)), Record::Trap { action, .. }) if action.is_empty() => {
				Some(BString::from(sig.to_string()))
			},
			_ => None,
		})
		.collect();
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
