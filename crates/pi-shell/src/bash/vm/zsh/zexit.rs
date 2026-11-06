//! zsh `zexit`'s hooks (`builtin.c`): after the `EXIT` trap, the `zshexit`
//! hook functions (`callhookfunc("zshexit")`), then the modules' exit hooks
//! (`runhookdef(EXITHOOK)`: zsh/zftp closes its sessions, sending `QUIT`;
//! zsh/zpty ends its commands). zsh runs them when the shell ends through
//! `zexit`: at the end of its script, `-c` string or input, and on `exit`,
//! in a subshell too; not when a subshell just runs out of commands.
//!
//! The hooks run on the vproc's own stack, above a base frame (an empty
//! [`ScriptKind::Hook`] script that also holds the module hooks' probe
//! scratch). Whenever the base frame is on top ([`at_base`]), [`advance`]
//! takes the next step: a hook function call (each starts with `$?` the
//! leaving status, as zsh's `doshfunc` with `noreturnval` puts `lastval`
//! back after each), then the module hooks, re-run after each probe like a
//! builtin; the shell then ends with the status it leaves with (zsh
//! `exit_val`, which an `exit` in a hook changes).
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use bstr::BString;
use serde::{Deserialize, Serialize};

use crate::bash::{
	diag::Diag,
	event::WaitKey,
	vm::{
		Cx, Kernel,
		builtins::{Chunk, Ctx, Need, zsh_module},
		exec::{pop_frame, push_script},
		expand::Expander,
		probe,
		proc::{PendingWrite, ScriptKind, Slot, Vproc},
		state,
		zsh::params,
	},
};

/// A zsh `zexit` under way or done
/// ([`crate::bash::vm::proc::VprocZsh::zexit`]).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ZExit {
	/// `$?` at the start of each hook function (zsh `lastval` when the
	/// hooks start).
	pub status:  i32,
	/// The status the shell leaves with (zsh `exit_val`).
	pub exit:    i32,
	/// The frame count below the hooks' base frame.
	pub depth:   u32,
	/// What runs next.
	pub step:    Step,
	/// An `exit` inside a function started it (zsh `exit_pending`): the
	/// first hook function's return sets `retflag` again, so the bodies of
	/// the later ones do not run.
	pub once:    bool,
	/// Times the module hooks ran a shell function and were run again
	/// after it (a builtin's `ctx.resumed`).
	pub resumed: u32,
}

/// The steps of [`ZExit`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Step {
	/// The `zshexit` function.
	Zshexit,
	/// The `zshexit_functions` list, read after `zshexit` ran.
	List,
	/// The listed functions still to call.
	Calls(Vec<BString>),
	/// The modules' exit hooks.
	Modules,
	/// All ran: the shell ends without running them again.
	Done,
}

/// The modules with an exit hook (zsh `addhookfunc("exit", …)`).
const EXIT_HOOK_MODULES: [&[u8]; 2] = [b"zsh/zftp", b"zsh/zpty"];

/// Start zsh `zexit`'s hooks for `vp`, which leaves with `vp.status`:
/// `true` when the base frame was pushed (the shell ends once the hooks
/// are done), `false` when there is nothing to run or they already ran.
pub fn start(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc) -> bool {
	if vp.zsh.as_deref().is_some_and(|z| z.zexit.is_some()) {
		return false;
	}
	let any = function_exists(cx, vp, b"zshexit")
		|| !hook_list(k, cx, vp).is_empty()
		|| EXIT_HOOK_MODULES
			.iter()
			.any(|m| zsh_module::loaded(cx.store, vp, m).unwrap_or(false));
	if !any {
		return false;
	}
	let depth = u32::try_from(vp.frames.len()).unwrap_or(u32::MAX);
	let status = vp.status;
	let z = vp.zsh.get_or_insert_with(Box::default);
	let once = z.exit_pending.is_some() || z.exit_from_function;
	z.zexit = Some(ZExit { status, exit: status, depth, step: Step::Zshexit, once, resumed: 0 });
	push_script(vp, b"", 1, ScriptKind::Hook);
	true
}

/// `exit` while a hook runs (zsh's `shell_exiting == -1`): the status is
/// the one the shell leaves with, and the hook call ends (the others and
/// the module hooks still run). The frame count to unwind to, `None` when
/// no hooks run.
pub fn exit_in_hooks(vp: &mut Vproc, status: i32) -> Option<usize> {
	let z = vp
		.zsh
		.as_deref_mut()?
		.zexit
		.as_mut()
		.filter(|z| z.step != Step::Done)?;
	z.exit = status;
	Some(z.depth as usize + 1)
}

/// The base frame is on top: the next step runs.
#[inline]
pub fn at_base(vp: &Vproc) -> bool {
	vp.zsh
		.as_deref()
		.and_then(|z| z.zexit.as_ref())
		.is_some_and(|z| z.step != Step::Done && vp.frames.len() == z.depth as usize + 1)
}

/// A new run of the root starts afresh (its end runs the hooks again).
pub fn reset(vp: &mut Vproc) {
	if let Some(z) = vp.zsh.as_deref_mut() {
		z.zexit = None;
		z.exit_from_function = false;
	}
}

/// The next step: push the next hook call, or run the module hooks and
/// end (the base frame popped, the leaving status set). `Some(key)` parks
/// the vproc on a probe in flight.
pub fn advance(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc) -> Option<WaitKey> {
	loop {
		let z = vp
			.zsh
			.as_deref_mut()
			.and_then(|z| z.zexit.as_mut())
			.expect("zexit under way");
		let status = z.status;
		let call = match &mut z.step {
			Step::Zshexit => {
				z.step = Step::List;
				Some(BString::from("zshexit"))
			},
			Step::List => {
				let list = hook_list(k, cx, vp);
				let z = vp
					.zsh
					.as_deref_mut()
					.and_then(|z| z.zexit.as_mut())
					.expect("zexit under way");
				z.step = Step::Calls(list);
				continue;
			},
			Step::Calls(list) if !list.is_empty() => Some(list.remove(0)),
			Step::Calls(_) => {
				z.step = Step::Modules;
				continue;
			},
			Step::Modules | Step::Done => None,
		};
		match call {
			Some(name) => {
				if function_exists(cx, vp, &name) {
					if z_once(vp) {
						let z = vp
							.zsh
							.as_deref_mut()
							.and_then(|z| z.zexit.as_mut())
							.expect("zexit under way");
						z.step = Step::Modules;
					}
					vp.status = status;
					let mut src = Vec::with_capacity(name.len() + 3);
					quote(&name, &mut src);
					src.push(b'\n');
					push_script(vp, &src, 1, ScriptKind::Hook);
					return None;
				}
			},
			None => return modules(k, cx, vp),
		}
	}
}

/// Whether only the first hook function runs ([`ZExit::once`]).
fn z_once(vp: &Vproc) -> bool {
	vp.zsh
		.as_deref()
		.and_then(|z| z.zexit.as_ref())
		.is_some_and(|z| z.once)
}

/// Run the module exit hooks, then pop the base frame and set the leaving
/// status. `Some(key)` parks the vproc on a probe in flight. A hook that
/// calls a shell function pushes its frame and runs again when it returns
/// (the base frame keeps the hooks' scratch and replay log).
fn modules(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc) -> Option<WaitKey> {
	let (base, resumed) = {
		let z = vp
			.zsh
			.as_deref()
			.and_then(|z| z.zexit.as_ref())
			.expect("zexit under way");
		(z.depth as usize, z.resumed)
	};
	loop {
		let mut sc = vp.frames[base].scratch.take().unwrap_or_default();
		let log = std::mem::take(&mut sc.logs[Slot::Builtin as usize]);
		let (res, chunks, log) = {
			let mut ctx = Ctx::new(k, cx, vp, sc.probes(), 0, "zsh");
			ctx.log = log;
			ctx.resumed = resumed;
			let res = module_hooks(&mut ctx);
			(res, std::mem::take(&mut ctx.chunks), std::mem::take(&mut ctx.log))
		};
		sc.logs[Slot::Builtin as usize] = log;
		let keep = |vp: &mut Vproc, sc| vp.frames[base].scratch = Some(sc);
		match res {
			Ok(false) => {
				keep(vp, sc);
				report(k, cx, vp, chunks);
				break;
			},
			Ok(true) => {
				keep(vp, sc);
				report(k, cx, vp, chunks);
				let z = vp
					.zsh
					.as_deref_mut()
					.and_then(|z| z.zexit.as_mut())
					.expect("zexit under way");
				z.resumed += 1;
				return None;
			},
			Err(Need::Probe(p)) => match probe::perform_mut(k, cx, vp, &mut sc, &p) {
				Ok(_) => keep(vp, sc),
				Err(key) => {
					keep(vp, sc);
					return Some(key);
				},
			},
			Err(Need::Park(key)) => {
				keep(vp, sc);
				return Some(key);
			},
			Err(Need::Store(err)) => {
				keep(vp, sc);
				k.fail(err);
				break;
			},
			Err(Need::Sub(_)) => {
				keep(vp, sc);
				let d =
					Diag::Unsupported { what: "a command substitution in a module exit hook".into() };
				k.diag(cx, vp, 0, d);
				break;
			},
		}
	}
	let z = vp
		.zsh
		.as_deref_mut()
		.and_then(|z| z.zexit.as_mut())
		.expect("zexit under way");
	z.step = Step::Done;
	let (exit, depth) = (z.exit, z.depth as usize);
	while vp.frames.len() > depth {
		pop_frame(&mut k.root, cx.store, vp);
	}
	vp.status = exit;
	None
}

/// zsh `runhookdef(EXITHOOK)`: each loaded module's exit hook (zsh/zftp's
/// `zftp_cleanup`, zsh/zpty's `deleteallptycmds`). `true`: a hook pushed
/// a shell function's frame and runs again after it.
fn module_hooks(ctx: &mut Ctx<'_, '_>) -> Result<bool, Need> {
	if zsh_module::loaded(ctx.cx.store, ctx.vp, b"zsh/zftp")? {
		let out = crate::bash::vm::builtins::zsh_mod_zftp::exit_hook(ctx)?;
		if matches!(out.control, crate::bash::vm::builtins::Control::Resume) {
			return Ok(true);
		}
	}
	if zsh_module::loaded(ctx.cx.store, ctx.vp, b"zsh/zpty")? {
		crate::bash::vm::builtins::zsh_mod_zpty::delete_all(ctx);
	}
	Ok(false)
}

/// The `zshexit_functions` array (zsh `getaparam`: only an array counts).
fn hook_list(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc) -> Vec<BString> {
	let mut log = Vec::new();
	let mut ex = Expander::new(k, cx, vp, &mut log, false, 0);
	params::getaparam(&mut ex, b"zshexit_functions")
		.ok()
		.flatten()
		.unwrap_or_default()
}

/// Whether shell function `name` is defined (zsh `getshfunc`).
fn function_exists(cx: &mut Cx<'_>, vp: &Vproc, name: &[u8]) -> bool {
	use crate::bash::store::{Key, Record};
	matches!(
		state::record(cx.store, vp, Key::Func(bstr::BStr::new(name))),
		Ok(Some(Record::Func { .. }))
	)
}

/// `word` single-quoted for shell code.
fn quote(word: &[u8], out: &mut Vec<u8>) {
	out.push(b'\'');
	for &c in word {
		if c == b'\'' {
			out.extend_from_slice(b"'\\''");
		} else {
			out.push(c);
		}
	}
	out.push(b'\'');
}

/// Print what the module hooks queued.
fn report(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc, chunks: Vec<Chunk>) {
	for chunk in chunks {
		match chunk {
			Chunk::Diag(d) => k.diag(cx, vp, 0, d),
			Chunk::Out(fd, bytes) => {
				vp.out
					.push_back(PendingWrite { fd, bytes: bytes.into(), off: 0 });
			},
		}
	}
}
