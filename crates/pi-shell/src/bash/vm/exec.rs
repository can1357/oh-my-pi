//! The dispatch loop (the single place for safepoints and op events), the
//! per-op semantics, and frame control (calls, returns, unwinding).

use std::{
	collections::HashMap,
	fmt::NumBuffer,
	sync::Arc,
	task::{Context, Poll},
};

use bstr::{BStr, BString, ByteSlice};

use super::{
	Cx, Kernel, assign_scope, builtins, command,
	expand::{self, Expander, Stop},
	is_ident, probe,
	proc::{
		AssignValue, Atom, Bang, BangStage, Coproc, Depths, Frame, FrameKind, InlineStage, LastBg,
		LoopKind, LoopRec, ParseSnapshot, PendingSub, PendingWrite, Probe, ProbeResult, Run, Saved,
		Scratch, ScriptKind, Slot, TryEnd, Vproc,
	},
	redir,
	state::{self, Level, Root, Scope, Var, VarMap},
};
use crate::bash::{
	diag::Diag,
	event::{CompiledUnit, Construct, EventData, NodeKind, Origin, WaitKey, assign_preview},
	fd::FdRef,
	host::{ResolveCtx, Resolved, Via},
	ids::{Dialect, ModeId, UnitId, Vpid},
	ir::{self, ComsubForm, Op, Opcode, SpawnKind, Unit},
	mem::{self, Capture},
	pattern::PatOpts,
	store::{Attrs, Key, KeyBuf, MiscKey, OptId, Record, StateStore, StoreError, TrapKey},
	syntax::{CompleteCommand, Features, ParseError, ParseErrorKind, Parser, Pos, Resume},
	zshopt::ZshOpt,
};

/// Result of one op.
pub enum Flow {
	Next,
	Jump(u32),
	/// Park the vproc, keep the pc; the op resumes from its scratch.
	Block(WaitKey),
	/// A frame was pushed; the op resumes (from its scratch) when it pops.
	Call,
	/// The current frame's unit ended.
	EndUnit,
	/// A syntax error or unsupported construct: abandon the innermost script.
	Abort(i32),
	/// `return n`.
	Return(i32),
	/// `break n` / `continue n`.
	Break {
		n:    u32,
		cont: bool,
	},
	/// `exit n` (also a fatal expansion error).
	Exit(i32),
	/// An expansion or arithmetic error: abandon the current top-level command.
	Discard(i32),
}

/// Run vproc `vp` for up to `slice` ops; stops early when it parks, a
/// script finishes, a control request arrives or a store fault is pending.
pub fn run_slice(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>, slice: u32, ops: &mut u32) {
	let mut n = 0u32;
	// The running unit, held across ops: consecutive ops of one unit reuse
	// it instead of an `Arc` increment and decrement per op (xeon profile:
	// `run_slice` self 6–15 % on loop/func/dbl_bracket).
	let mut held: Option<Arc<Unit>> = None;
	// Time passed since the last turn (`Kernel::clock`).
	k.clock_stale();
	// A process of the shell's foreground job stopped while it waited for
	// something else: the job is suspended before anything else runs.
	if k.jobctl.has_fg_stop() {
		super::jobctl::pending_suspend(k, cx, vp);
	}
	loop {
		if k.root.has_fault() {
			return;
		}
		if !vp.out.is_empty() {
			let at = k.ctl.wakes();
			match flush_out(k, vp) {
				Some(fd) => return park(k, cx, vp, WaitKey::Write { fd }, at),
				None => unblock(k, cx, vp),
			}
		}
		if vp.pending_traps != crate::bash::signal::SigSet::EMPTY && !vp.waiting_foreground() {
			let pending = vp.pending_traps.iter().find(|sig| {
				!vp.frames.iter().any(|frame| {
					matches!(frame.kind, FrameKind::Script {
						what: ScriptKind::Trap { key: TrapKey::Signal(active), .. },
						..
					} if active == *sig)
				})
			});
			if let Some(sig) = pending {
				vp.pending_traps = vp.pending_traps.without(sig);
				// One run per finished child (bash `run_sigchld_trap`): the next
				// waits until this one is done.
				if sig == crate::bash::signal::Signal::Chld {
					vp.jobs.chld = vp.jobs.chld.saturating_sub(1);
					if vp.jobs.chld > 0 {
						vp.pending_traps = vp.pending_traps.with(sig);
					}
				}
				if start_trap(k, vp, cx, TrapKey::Signal(sig)) {
					continue;
				}
			}
		}
		if !vp.restore_opts.is_empty() {
			for saved in std::mem::take(&mut vp.restore_opts) {
				if let Err(err) = state::restore_set_options(&mut k.root, cx.store, vp, &saved) {
					k.fail(err);
				}
			}
			continue;
		}
		let Some(top) = vp.frames.last() else {
			if !run_boundary(k, vp, cx) {
				return;
			}
			continue;
		};
		if top.unit.is_none() {
			// Reading and parsing the next command take time.
			k.clock_stale();
			let at = k.ctl.wakes();
			// zsh `zexit`: its base frame is on top; the next hook runs.
			if vp.zsh.is_some() && super::zsh::zexit::at_base(vp) {
				match super::zsh::zexit::advance(k, cx, vp) {
					Some(key) => return park(k, cx, vp, key, at),
					None => unblock(k, cx, vp),
				}
				continue;
			}
			match next_command(k, vp, cx) {
				Some(key) => return park(k, cx, vp, key, at),
				None => unblock(k, cx, vp),
			}
			continue;
		}
		// The safepoint: one relaxed load of the control word per op.
		// `no-safepoint-check` (measurement only, off by default)
		// compiles it out for the overhead comparison; `Shell::step` still
		// checks once per slice.
		if (cfg!(not(feature = "no-safepoint-check")) && k.ctl.word() != 0) || n >= slice {
			return;
		}
		n += 1;
		*ops += 1;
		let at = k.ctl.wakes();
		let frame = vp.frames.last().expect("checked above");
		// A suspended job's base frame ends where the shell's pipeline did.
		if let FrameKind::Job { stop_at } = frame.kind
			&& stop_at == frame.pc
		{
			end_unit(k, vp, cx);
			continue;
		}
		let current = frame.unit.as_ref().expect("checked above");
		if !held.as_ref().is_some_and(|u| Arc::ptr_eq(u, current)) {
			announce(k, cx, vp.vpid, vp.runs.front(), current, current.line);
			held = Some(Arc::clone(current));
		}
		let unit = held.as_ref().expect("just set");
		let op = unit.ops[frame.pc as usize];
		let fi = vp.frames.len() - 1;
		// Control flow of a bash unit: it starts no command, cannot fail as
		// one or block, and keeps the clock, so none of the bookkeeping
		// below applies to it.
		if unit.mode.dialect() == Dialect::Bash
			&& vp.frames[fi].scratch.is_none()
			&& let Some(flow) = control_flow(k, cx, vp, unit, op)
		{
			vp.frames[fi].debug_pc = None;
			unblock(k, cx, vp);
			if !vp.procsubs.is_empty() {
				close_procsubs(vp, fi);
			}
			let frame = top_frame(vp);
			frame.pc = match flow {
				Flow::Jump(target) => target,
				_ => frame.pc + 1,
			};
			continue;
		}
		// A zsh list marker: the DEBUG trap point before or after a list.
		if op.code == Opcode::Nop && unit.mode.dialect() == Dialect::Zsh {
			let ran = vp.frames[fi].debug_pc == Some(vp.frames[fi].pc);
			if !ran && zsh_debug_trap(k, vp, cx, unit, op) {
				continue;
			}
			unblock(k, cx, vp);
			let frame = top_frame(vp);
			frame.debug_pc = None;
			frame.pc += 1;
			continue;
		}
		let starts = starts_command(unit, op);
		let fresh = vp.frames[fi].scratch.is_none();
		if fresh && starts {
			note_command(vp, unit, op);
		}
		// bash's DEBUG trap: before a simple command, `[[ ]]`, `(( ))`, each
		// arith-for expression, a `case` or `select` command and each `for`
		// iteration that assigns a word. zsh's runs at its list markers.
		let debug_point = unit.mode.dialect() == Dialect::Bash
			&& (starts
				|| match op.code {
					Opcode::Arith => unit
						.nodes
						.get(op.node as usize)
						.is_some_and(|n| n.kind == NodeKind::ArithFor),
					Opcode::CaseWord => true,
					Opcode::ForIn => op.flags & Op::SELECT != 0,
					Opcode::ForNext => vp.frames[fi].loops.last().is_some_and(
						|r| matches!(&r.kind, LoopKind::For { items, next, .. } if (*next as usize) < items.len()),
					),
					_ => false,
				});
		if debug_point && vp.frames[fi].debug_pc != Some(vp.frames[fi].pc) {
			vp.frames[fi].debug_pc = Some(vp.frames[fi].pc);
			if pseudo_trap_maybe(k, cx, TrapKey::Debug) {
				let line = line_of(vp, op.node);
				if start_trap(k, vp, cx, TrapKey::Debug) {
					set_trap_line(vp, line);
					continue;
				}
			}
		}
		if fresh && starts {
			vp.frames[fi].err_reported = false;
		}
		// A cancel trap is a trap frame: none on the stack, no scan.
		let cancellation = if vp.trap_frames == 0 {
			None
		} else {
			vp.frames.iter().rev().find_map(|f| match f.kind {
				FrameKind::Script { what: ScriptKind::Trap { cancel: Some(status), .. }, .. } => {
					Some(status)
				},
				_ => None,
			})
		};
		if k.clock.is_some() && !keeps_clock(op.code) {
			k.clock_stale();
		}
		// The hottest ops straight to their handlers, past `dispatch`'s
		// frame.
		let bash = unit.mode.dialect() == Dialect::Bash;
		let flow = if bash && op.code == Opcode::Exec {
			command::exec(k, vp, cx, unit, op, line_of(vp, op.node))
		} else if bash
			&& op.code == Opcode::Arith
			&& let Some(flow) = plain_arith(k, vp, cx, unit, op)
		{
			flow
		} else {
			dispatch(k, vp, cx, unit, op)
		};
		// A glob's shell-code qualifier (`(e:…:)`) runs its code above the
		// op once the op has put its state back ([`VprocZsh::glob_hook`]);
		// an op that did not pass the call on drops it.
		if let Some(z) = vp.zsh.as_deref_mut()
			&& let Some((src, hook_line)) = z.glob_hook.take()
			&& matches!(flow, Flow::Call)
		{
			push_script(vp, &src, hook_line, ScriptKind::Hook);
		}
		// Nothing failed and control goes on: no ERR trap, errexit or
		// transfer to decide (every check below starts from a failure or a
		// transfer), only the op's state to drop.
		if vp.status == 0 && matches!(flow, Flow::Next | Flow::Jump(_)) {
			if let Some(frame) = vp.frames.get_mut(fi) {
				frame.debug_pc = None;
			}
			unblock(k, cx, vp);
			end_op(k, cx, vp, fi);
			let frame = top_frame(vp);
			frame.pc = match flow {
				Flow::Jump(target) => target,
				_ => frame.pc + 1,
			};
			continue;
		}
		let ignore_errexit =
			op.flags & Op::COND != 0 || vp.frames.get(fi).is_some_and(|frame| frame.ignore_errexit);
		if matches!(flow, Flow::Call) && ignore_errexit {
			// Frames the op pushed (function, `eval`, `source`, `${ ;}`)
			// run in its context.
			for frame in vp.frames.iter_mut().skip(fi + 1) {
				frame.ignore_errexit = true;
			}
		}
		// An `exit N` in the cancel trap is `exit_shell`'s (the EXIT trap, then
		// status N, as bash).
		let cancel_transfer = cancellation.is_some()
			&& matches!(flow, Flow::Return(_) | Flow::Abort(_) | Flow::Discard(_));
		let failing = !ignore_errexit && vp.status != 0 && matches!(flow, Flow::Next | Flow::Jump(_));
		let failed_command = failing
			&& match op.code {
				Opcode::Spawn => true,
				// zsh: a call whose body already ran the ZERR trap does not
				// run it again (`donetrap`).
				Opcode::Exec => {
					unit.mode.dialect() == Dialect::Bash
						|| !vp.frames.get(fi).is_some_and(|frame| frame.err_reported)
				},
				Opcode::CallAnon => !vp.frames.get(fi).is_some_and(|frame| frame.err_reported),
				Opcode::Redir => matches!(flow, Flow::Jump(_)),
				Opcode::Leave | Opcode::Arith | Opcode::CondTest => {
					!vp.frames.get(fi).is_some_and(|frame| frame.err_reported)
				},
				_ => false,
			};
		// `set -e` exits on a failed simple command, subshell, pipeline,
		// compound redirection, `[[ ]]` or `(( ))`; not on other compound
		// commands, whose status comes from a command already judged.
		let zsh_unit = unit.mode.dialect() == Dialect::Zsh;
		let judged = (failing || (zsh_unit && vp.status != 0))
			&& match op.code {
				Opcode::Exec | Opcode::Spawn | Opcode::CallAnon => true,
				Opcode::Redir => matches!(flow, Flow::Jump(_)),
				Opcode::Leave => unit
					.nodes
					.get(op.node as usize)
					.is_some_and(|n| matches!(n.kind, NodeKind::Cond | NodeKind::Arith)),
				_ => false,
			};
		let errexit_failed = failing && judged;
		// zsh `doshfunc` resets `NOERREXIT_RETURN`: `ERR_RETURN` applies in
		// a function called from a condition (`f || …`), unlike `ERR_EXIT`.
		let errreturn_failed = errexit_failed
			|| (judged
				&& zsh_unit
				&& op.flags & Op::COND == 0
				&& matches!(flow, Flow::Next | Flow::Jump(_))
				&& vp
					.frames
					.get(fi)
					.is_some_and(|f| !f.ignore_errexit || matches!(f.kind, FrameKind::Function { .. })));
		let err_line = if failed_command {
			line_of(vp, op.node)
		} else {
			0
		};
		if !matches!(flow, Flow::Block(_) | Flow::Call)
			&& let Some(frame) = vp.frames.get_mut(fi)
		{
			frame.debug_pc = None;
		}
		if !matches!(flow, Flow::Block(_)) {
			unblock(k, cx, vp);
		}
		// The op is over unless it parks or called a frame: drop its scratch
		// and close its process substitutions.
		if !matches!(flow, Flow::Block(_) | Flow::Call) {
			end_op(k, cx, vp, fi);
		}
		match flow {
			Flow::Next => top_frame(vp).pc += 1,
			Flow::Jump(target) => top_frame(vp).pc = target,
			Flow::Block(key) => return park(k, cx, vp, key, at),
			Flow::Call => {},
			Flow::EndUnit => end_unit(k, vp, cx),
			Flow::Abort(status) => {
				// Abandon the innermost script (the run's, `eval`'s, `source`'s).
				vp.status = status;
				let i = vp
					.frames
					.iter()
					.rposition(|f| matches!(f.kind, FrameKind::Script { .. }))
					.unwrap_or(0);
				// zsh: a parse error is status 1; `.` of a file with one is 126
				// (`bin_dot`'s `SOURCE_ERROR`).
				if unit.mode.dialect() == Dialect::Zsh {
					vp.status = match vp.frames.get(i).map(|f| &f.kind) {
						Some(FrameKind::Script { what: ScriptKind::Source, .. }) => 126,
						_ => 1,
					};
				}
				// An interactive shell's own input goes on: the command is
				// dropped and the next one read (zsh `loop`, bash
				// `reader_loop`).
				unwind(&mut k.root, cx.store, vp, i + 1);
				if super::zle::reader::applies(cx, vp) {
					top_frame(vp).unit = None;
				} else {
					unwind(&mut k.root, cx.store, vp, i);
				}
			},
			Flow::Return(status) if unit.mode.dialect() == Dialect::Zsh => {
				zsh_return_flow(k, vp, cx, op, status, ignore_errexit);
			},
			Flow::Return(status) => {
				vp.status = status;
				// `${ ;}` ends like a function; a subshell of a function
				// (`( return )`, `$( return )`) exits.
				let target = vp.frames.iter().rposition(|f| {
					matches!(
						f.kind,
						FrameKind::Function { .. }
							| FrameKind::NoFork
							| FrameKind::Script { what: ScriptKind::Source, .. }
					)
				});
				if let Some(i) = target {
					if vp.frames[i].kind == FrameKind::NoFork || !return_trap(k, vp, cx, i) {
						unwind(&mut k.root, cx.store, vp, i);
					}
				} else if vp.parent.is_some() && in_function_scope(k, cx, vp) {
					exit_shell(k, vp, cx, status);
				} else {
					let line = line_of(vp, op.node);
					let diag =
						Diag::Usage { msg: "can only `return' from a function or sourced script".into() };
					k.diag(cx, vp, line, diag.by("return"));
					vp.status = 2;
					top_frame(vp).pc += 1;
				}
			},
			Flow::Break { n, cont } if unit.mode.dialect() == Dialect::Zsh => {
				zsh_break(k, vp, cx, n, cont);
			},
			Flow::Break { n, cont } => break_loops(k, vp, cx, n, cont, op),
			Flow::Exit(status) if unit.mode.dialect() == Dialect::Zsh => zsh_exit(k, vp, cx, status),
			Flow::Exit(status) => exit_shell(k, vp, cx, status),
			Flow::Discard(status) if unit.mode.dialect() == Dialect::Zsh => {
				zsh_discard(k, vp, cx, status);
			},
			Flow::Discard(status) => {
				vp.status = status;
				// bash's `parse_and_execute` (the script, `-c`, `eval`, `.`,
				// a trap action) catches the jump: the innermost script goes
				// on with its next command.
				let script = vp
					.frames
					.iter()
					.rposition(|f| matches!(f.kind, FrameKind::Script { .. }));
				if let Some(i) = script {
					unwind(&mut k.root, cx.store, vp, i + 1);
					clear_scratch(&mut k.root, cx.store, vp);
					truncate(vp, Depths::default());
					let f = top_frame(vp);
					f.unit = None;
					f.loops.clear();
				} else {
					unwind(&mut k.root, cx.store, vp, 0);
				}
			},
		}
		if cancel_transfer {
			finish_cancel(&mut k.root, cx.store, vp, cancellation.expect("checked"));
			continue;
		}
		let errexit = errexit_failed
			&& (errexit_on(k, cx, vp)
				|| (unit.mode.dialect() == Dialect::Zsh && zsh_errreturn_exits(k, cx, vp)));
		if failed_command && start_trap(k, vp, cx, TrapKey::Err) {
			set_trap_line(vp, err_line);
			for frame in &mut vp.frames[..fi.saturating_add(1)] {
				frame.err_reported = true;
			}
			if errexit {
				mark_trap_exit(vp);
			}
		} else if errexit {
			let status = vp.status;
			exit_shell(k, vp, cx, status);
		} else if errreturn_failed && unit.mode.dialect() == Dialect::Zsh && zsh_errreturn(k, cx, vp)
		{
			// zsh `ERR_RETURN`: a failed command returns from the function
			// (or `.` file) it runs in.
			let status = vp.status;
			zsh_return(k, vp, cx, status);
		}
	}
}

/// `Flow::Return` of an op of a zsh unit: zsh `bin_break` with `retflag`
/// and `execlist`'s `errexit` handling. Out of line: the bash `run_slice`
/// path does not carry it.
#[inline(never)]
fn zsh_return_flow(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	op: Op,
	status: i32,
	ignore_errexit: bool,
) {
	vp.status = status;
	// `${ ;}` ends like a function.
	let target = vp.frames.iter().rposition(|f| {
		matches!(
			f.kind,
			FrameKind::Function { .. }
				| FrameKind::NoFork
				| FrameKind::Script { what: ScriptKind::Source, .. }
		)
	});
	if status != 0 && !ignore_errexit && errexit_on(k, cx, vp) {
		// zsh `execlist` after `return N` (N ≠ 0) under `errexit`: the ZERR
		// trap runs inside the function, then the shell exits.
		if start_trap(k, vp, cx, TrapKey::Err) {
			set_trap_line(vp, line_of(vp, op.node));
			mark_trap_exit(vp);
		} else {
			exit_shell(k, vp, cx, status);
		}
	} else if run_always(k, vp, cx, target.unwrap_or(0), TryEnd::Return(status)) {
		// The always-list runs first; it resumes the return.
	} else if let Some(i) = target {
		zsh_leave(k, vp, cx, i);
	} else if let Some(i) = vp
		.frames
		.iter()
		.rposition(|f| matches!(f.kind, FrameKind::Script { what: ScriptKind::Run, .. }))
		.filter(|&i| super::zle::reader::input_frame(cx, vp, i))
	{
		// zsh `bin_break`: under `INTERACTIVE` and `SHINSTDIN` it sets
		// `retflag`, which `loop` clears: the rest of the command line (and
		// a list trap that ran it, p10k's `return 130` on ^C) is dropped and
		// the shell reads its next one.
		unwind(&mut k.root, cx.store, vp, i + 1);
		clear_scratch(&mut k.root, cx.store, vp);
		truncate(vp, Depths::default());
		let f = top_frame(vp);
		f.unit = None;
		f.loops.clear();
		vp.status = status;
		// A trap that ran while the line editor waited for a key: zsh's
		// `getbyte` sees `retflag` and ends the line, as on an untrapped ^C.
		if let Some(ed) = vp.zle.as_deref_mut().and_then(|z| z.ed.as_deref_mut()) {
			ed.aborted = true;
			ed.interrupted = true;
		}
	} else {
		// zsh `bin_break`: `return` outside a function or `.` file leaves
		// a non-interactive shell (`zexit`).
		exit_shell(k, vp, cx, status);
	}
}

/// The trap just started exits the shell when it ends (`set -e` after the
/// ERR trap): its frame is the innermost trap frame (a zsh `TRAPZERR`
/// function runs above it).
fn mark_trap_exit(vp: &mut Vproc) {
	let trap = vp.frames.iter_mut().rev().find_map(|f| match &mut f.kind {
		FrameKind::Script { what: ScriptKind::Trap { exit, .. }, .. } => Some(exit),
		_ => None,
	});
	if let Some(exit) = trap {
		*exit = true;
	}
}

/// `$LINENO` in a DEBUG or ERR trap action is the line of the trapped
/// command: start the freshly pushed trap script there.
pub fn set_trap_line(vp: &mut Vproc, line: u32) {
	if let Some(Frame { kind: FrameKind::Script { pos, .. }, .. }) = vp.frames.last_mut() {
		pos.1 = line;
	}
}

/// Record the command `op` starts (a simple command, `[[ ]]` or `(( ))`:
/// the caller checked [`starts_command`]) as `BASH_COMMAND`; not while a
/// trap action runs (bash keeps the trapped command).
fn note_command(vp: &mut Vproc, unit: &Arc<Unit>, op: Op) {
	if vp.trap_frames == 0
		|| !vp
			.frames
			.iter()
			.any(|f| matches!(f.kind, FrameKind::Script { what: ScriptKind::Trap { .. }, .. }))
	{
		if let Some((u, node)) = &mut vp.command
			&& Arc::ptr_eq(u, unit)
		{
			*node = op.node;
		} else {
			vp.command = Some((Arc::clone(unit), op.node));
		}
	}
}

/// Whether `op` starts a command bash reports on its own (`BASH_COMMAND`,
/// the ERR trap): a simple command, `[[ ]]` or `(( ))`.
fn starts_command(unit: &Unit, op: Op) -> bool {
	match op.code {
		Opcode::Exec => true,
		Opcode::Enter => unit
			.nodes
			.get(op.node as usize)
			.is_some_and(|n| matches!(n.kind, NodeKind::Cond | NodeKind::Arith)),
		_ => false,
	}
}

/// Whether `vp` runs in a function scope (a store failure reads as no and
/// is kept).
fn in_function_scope(k: &mut Kernel, cx: &mut Cx<'_>, vp: &Vproc) -> bool {
	state::in_function(&k.root, cx.store, vp).unwrap_or_else(|err| {
		k.fail(err);
		false
	})
}

/// Whether `set -e` is on for `vp`.
fn errexit_on(k: &mut Kernel, cx: &mut Cx<'_>, vp: &Vproc) -> bool {
	match state::option(&mut k.root, cx.store, vp, OptId::Errexit) {
		Ok(on) => on,
		Err(err) => {
			k.fail(err);
			false
		},
	}
}

/// Leave the shell with `status` (`exit`, `set -e`): unwind every frame;
/// a subshell runs its EXIT trap here, the root at the run boundary. An
/// `exit` inside a function runs the root's trap first, above the
/// function's frames: bash's trap sees its `FUNCNAME` and locals.
fn exit_shell(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>, status: i32) {
	// zsh `zexit` while its hooks run: the hook calls end, the status is the
	// new one.
	if vp.zsh.is_some()
		&& let Some(keep) = super::zsh::zexit::exit_in_hooks(vp, status)
	{
		vp.status = status;
		unwind(&mut k.root, cx.store, vp, keep);
		return;
	}
	let in_exit_trap = vp.frames.iter().any(|f| {
		matches!(f.kind, FrameKind::Script { what: ScriptKind::Trap { key: TrapKey::Exit, .. }, .. })
	});
	vp.status = status;
	if vp.parent.is_none()
		&& let Some(run) = vp.runs.front()
	{
		k.exited = Some(run.id);
	}
	if !in_exit_trap
		&& vp
			.frames
			.iter()
			.any(|f| matches!(f.kind, FrameKind::Function { .. }))
		&& match vp.runs.front() {
			Some(r) => r.started && !r.exit_trap_started,
			// A forked subshell has no run: it is its own exit, and its
			// own flag is what keeps the trap from starting twice.
			None => vp.transient && !vp.exit_trap_run,
		}
		&& start_exit_trap_once(k, vp, cx)
	{
		if let Some(run) = vp.runs.front_mut() {
			run.exit_trap_started = true;
		}
		// The trap's end exits with `status` (its saved `$?`).
		if let Some(Frame {
			kind: FrameKind::Script { what: ScriptKind::Trap { exit, .. }, .. },
			..
		}) = vp.frames.last_mut()
		{
			*exit = true;
		}
		return;
	}
	unwind(&mut k.root, cx.store, vp, 0);
	// zsh `exit` in a subshell is its `zexit`: the hooks run after its EXIT
	// trap (pushed below them).
	if vp.parent.is_some() && vp.runs.is_empty() && vp.mode.dialect() == Dialect::Zsh {
		super::zsh::zexit::start(k, cx, vp);
	}
	if !in_exit_trap && vp.transient && vp.runs.is_empty() {
		start_exit_trap_once(k, vp, cx);
	}
}

/// Start this vproc's EXIT trap, at most once for a forked subshell: it has
/// no [`Run`](super::proc::Run) to keep `exit_trap_started` on, and
/// `own_traps`, `trap_frames` and the frame scans all return to their
/// pre-trap values when the trap's frame is popped. A root vproc is
/// unaffected: its guard is its run's own flag, one per shell invocation.
fn start_exit_trap_once(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>) -> bool {
	if vp.transient {
		if vp.exit_trap_run {
			return false;
		}
		vp.exit_trap_run = true;
	}
	start_trap(k, vp, cx, TrapKey::Exit)
}

fn top_frame(vp: &mut Vproc) -> &mut Frame {
	vp.frames.last_mut().expect("ops run in a frame")
}

/// Start the next run or finish the current one; `false` when idle.
fn run_boundary(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>) -> bool {
	let Some(run) = vp.runs.front_mut() else {
		return false;
	};
	if run.started && !run.exit_trap_started {
		run.exit_trap_started = true;
		if start_trap(k, vp, cx, TrapKey::Exit) {
			return true;
		}
	}
	// zsh `zexit` after the EXIT trap: the root's script, `-c` string or
	// input ends.
	if vp.parent.is_none()
		&& vp.mode.dialect() == Dialect::Zsh
		&& vp.runs.front().is_some_and(|r| r.started)
		&& super::zsh::zexit::start(k, cx, vp)
	{
		return true;
	}
	let run = vp.runs.front_mut().expect("present");
	if run.started {
		super::zsh::zexit::reset(vp);
		let run = vp.runs.pop_front().expect("present");
		// A run's explicit mode ends with it.
		if let Some(mode) = run.restore_mode {
			super::mode::set_mode(&mut k.root, cx.store, vp, mode);
		}
		end_run(k, vp, cx, &run);
		return false;
	}
	run.started = true;
	if run.explicit_mode {
		run.restore_mode = Some(vp.mode);
		let mode = run.mode;
		super::mode::set_mode(&mut k.root, cx.store, vp, mode);
	}
	let run = vp.runs.front_mut().expect("present");
	if vp.overlay.is_none() {
		if let Some(args) = run.args.take() {
			k.root.set_positional(cx.store, args);
		}
		if let Some(cwd) = run.cwd.take() {
			k.root.set_misc(cx.store, MiscKey::Cwd, cwd.clone());
			k.root
				.set_var(cx.store, b"PWD", Some(Var::scalar(cwd.clone(), Attrs::EXPORT)));
			vp.cwd = cwd;
		}
		for (name, value) in std::mem::take(&mut run.env) {
			if is_ident(&name) {
				k.root
					.set_var(cx.store, &name, Some(Var::scalar(value, Attrs::EXPORT)));
			}
		}
		// `$-` shows `c` for a `-c` string, `s` for a script on stdin.
		let flag = match run.chain.links[0].origin {
			Origin::Command => "c",
			Origin::Stdin => "s",
			_ => "",
		};
		k.root.set_misc(cx.store, MiscKey::RunOrigin, flag);
	}
	let from_stdin = matches!(run.chain.links[0].origin, Origin::Stdin);
	let mut kind = FrameKind::script(&run.src, Pos::START, ScriptKind::Run);
	if let FrameKind::Script { stdin, .. } = &mut kind {
		*stdin = from_stdin;
	}
	vp.frames.push(Frame::new(None, 0, kind));
	// zsh `parseargs`: commands read from standard input set `shinstdin`.
	if from_stdin
		&& vp.overlay.is_none()
		&& vp.mode.dialect() == Dialect::Zsh
		&& let Err(err) = state::set_zsh_option(&mut k.root, cx.store, vp, ZshOpt::Shinstdin, true)
	{
		k.fail(err);
	}
	let run = vp.runs.front().expect("present");
	let tag = run.tag;
	let origin = &run.chain.links[0].origin;
	k.emit(cx, (vp.vpid, vp.mode), Some(run), EventData::RunStart { tag, origin });
	// The shell's startup files (`BASH_ENV`, a login shell's profiles) run
	// as `.` files before its first script, as bash's `run_startup_files`.
	if vp.parent.is_none() && !k.startup.is_empty() {
		let startup = std::mem::take(&mut k.startup);
		for (path, _) in &startup {
			k.emit(cx, (vp.vpid, vp.mode), vp.runs.front(), EventData::SourceEnter {
				path: path.as_bstr(),
			});
		}
		for (_, text) in startup.iter().rev() {
			push_script(vp, text, 1, ScriptKind::Source);
		}
	}
	true
}

fn end_run(k: &mut Kernel, vp: &Vproc, cx: &mut Cx<'_>, run: &super::proc::Run) {
	let status = vp.status;
	k.emit(cx, (vp.vpid, vp.mode), Some(run), EventData::RunEnd { status });
	k.trace_sources.remove(&vp.vpid);
	k.trace_unit_origins.remove(&vp.vpid);
	k.done.push_back((run.id, status));
}

/// Park `vp` on `key` (emitting `Blocked` when the key changes).
fn park(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc, key: WaitKey, at: u64) {
	if vp.blocked.as_ref().is_none_or(|b| b.key != key) {
		k.emit(cx, (vp.vpid, vp.mode), vp.runs.front(), EventData::Blocked { key: &key });
	}
	vp.blocked = Some(super::proc::Blocked { key, at });
}

/// Clear the park of `vp` (emitting `Unblocked`). After every op: the
/// common case, a vproc that was not parked, is one inlined test.
#[inline]
fn unblock(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc) {
	if vp.blocked.is_some() {
		unpark(k, cx, vp);
	}
}

/// [`unblock`] of a parked vproc.
#[inline(never)]
fn unpark(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc) {
	if let Some(b) = vp.blocked.take() {
		k.emit(cx, (vp.vpid, vp.mode), vp.runs.front(), EventData::Unblocked { key: &b.key });
	}
}

/// Write queued diagnostics; the fd that would block, if any. Write errors
/// on a diagnostic stream are dropped, as bash does.
pub fn flush_out(k: &Kernel, vp: &mut Vproc) -> Option<i32> {
	use super::zle::tty;
	// The editor's display bytes still pending were queued before anything
	// in `vp.out` (later ones wait in it, as `tty::FD` entries): the
	// terminal gets them first, as zsh's blocking writes order them.
	if let Some(t) = vp.zle.as_deref_mut().and_then(|z| z.tty.as_mut())
		&& t.flush(k).is_some()
	{
		return Some(tty::FD);
	}
	let mut cx = Context::from_waker(&k.waker);
	while let Some(w) = vp.out.front_mut() {
		if w.fd == tty::FD {
			if let Some(t) = vp.zle.as_deref_mut().and_then(|z| z.tty.as_mut()) {
				t.put(&w.bytes[w.off..]);
				vp.out.pop_front();
				if t.flush(k).is_some() {
					return Some(tty::FD);
				}
				continue;
			}
			// No editor any more: its fallback, standard error.
			w.fd = 2;
		}
		match vp.fds.handle(w.fd).poll_write(&mut cx, &w.bytes[w.off..]) {
			Poll::Ready(Ok(n)) if n > 0 => {
				w.off += n;
				if w.off >= w.bytes.len() {
					vp.out.pop_front();
				}
			},
			Poll::Ready(_) => {
				vp.out.pop_front();
			},
			Poll::Pending => return Some(w.fd),
		}
	}
	None
}

/// Grammar switches from the current options (also `zpty`'s parse of its
/// command text).
pub(super) fn features(
	k: &mut Kernel,
	store: &mut dyn StateStore,
	vp: &Vproc,
) -> Result<Features, StoreError> {
	let mut f = Features::NONE;
	if state::option(&mut k.root, store, vp, OptId::Extglob)? {
		f = f | Features::EXTGLOB;
	}
	if state::option(&mut k.root, store, vp, OptId::Posix)? {
		f = f | Features::POSIX;
	}
	// Charsets whose trailing bytes can be `\`, `` ` `` or `|`: the lexer
	// reads whole characters.
	if let super::locale::Charset::Encoding(e) = super::locale::charset(k, store, vp) {
		if e == encoding_rs::BIG5 || e == encoding_rs::GBK {
			f = f | Features::DOUBLE_BYTE;
		} else if e == encoding_rs::GB18030 {
			f = f | Features::GB18030;
		} else if e == encoding_rs::SHIFT_JIS {
			f = f | Features::SHIFT_JIS;
		}
	}
	let f = super::mode::features(&mut k.root, store, vp, f)?;
	// zsh `gettok`: without `interactivecomments` an interactive shell
	// reads `#` as a word only in its standard input (`SHINSTDIN`, which
	// `source` turns off; a string, `-c` or `eval`, is not).
	if vp.mode.dialect() == Dialect::Zsh {
		let stdin = vp
			.frames
			.last()
			.is_some_and(|fr| matches!(fr.kind, FrameKind::Script { stdin: true, .. }));
		if !stdin {
			return Ok(f | Features::ZSH_INTERACTIVE_COMMENTS);
		}
	}
	Ok(f)
}

/// Parse and compile the next command of the top script frame; pop the
/// frame at end of input. A script read from stdin first reads lines until
/// the command is complete; `Some` is the wait key while fd 0 has none.
fn next_command(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>) -> Option<WaitKey> {
	let observed = k.mask.contains(crate::bash::event::EventKind::UnitCompiled);
	let depth = vp.frames.len();
	if observed {
		if let Some(origins) = k.trace_sources.get_mut(&vp.vpid) {
			origins.retain(|at, _| *at <= depth);
		}
		if let Some(Frame { kind: FrameKind::Script { src, pos, what: ScriptKind::Eval, .. }, .. }) = vp.frames.last()
			&& pos.0 == 0
			&& let Some(origin) = literal_script_origin(vp, src, false)
		{
			if k.trace_sources.len() < crate::bash::trace::history::HISTORY_EVENTS {
				k.trace_sources.entry(vp.vpid).or_default().insert(depth, origin);
			}
		} else if vp.frames.last().is_some_and(|frame| matches!(&frame.kind, FrameKind::Script { pos, what: ScriptKind::Eval, .. } if pos.0 == 0))
			&& let Some(origins) = k.trace_sources.get_mut(&vp.vpid) { origins.remove(&depth); }
	}
	let source_origin = observed
		.then(|| {
			k.trace_sources
				.get(&vp.vpid)
				.and_then(|origins| origins.get(&depth))
				.copied()
		})
		.flatten();
	// zsh `parse_string`: a string (`eval`, a trap, `-c`) parses whole
	// before it runs; its first command takes the snapshot the rest reuse.
	let (snapped, snapshot) = match vp.frames.last().map(|f| &f.kind) {
		_ if vp.mode.dialect() != Dialect::Zsh => (false, false),
		Some(FrameKind::Script { aux: Some(a), .. }) if a.parse.is_some() => (true, false),
		Some(FrameKind::Script { pos, what, stdin: false, .. }) if pos.0 == 0 => {
			let string = match what {
				ScriptKind::Eval | ScriptKind::Trap { .. } | ScriptKind::Hook | ScriptKind::Code(_) => {
					true
				},
				ScriptKind::Source => false,
				ScriptKind::Run => matches!(
					state::record(cx.store, vp, Key::Misc(MiscKey::RunOrigin)),
					Ok(Some(Record::Misc(origin))) if origin.as_slice() == b"c"
				),
			};
			(false, string)
		},
		_ => (false, false),
	};
	let (feat, mut aliases) = if snapped {
		(Features::NONE, None)
	} else {
		let feat = match features(k, cx.store, vp) {
			Ok(f) => f,
			Err(err) => {
				k.fail(err);
				return None;
			},
		};
		match builtins::alias_table(k, cx, vp) {
			Ok(a) => (feat, a),
			Err(err) => {
				k.fail(err);
				return None;
			},
		}
	};
	let mode = vp.mode;
	// `set -o history` (zsh: interactive on stdin): the shell's input lines
	// (not `eval`, `.` or trap text) join the history as they are read.
	let history = matches!(top_frame(vp).kind, FrameKind::Script { what: ScriptKind::Run, .. })
		&& builtins::history::recording(&mut k.root, cx.store, vp).unwrap_or(false);
	// zsh: each event read goes through `hbegin`, history expansion and
	// `hend` (`builtins::history::zsh`).
	let zhist = history && vp.mode.dialect() == Dialect::Zsh;
	// The zsh root shell, whose history is saved as its input ends.
	let zsh_root = vp.mode.dialect() == Dialect::Zsh && vp.parent.is_none();
	// `set -n`: a non-interactive shell reads its commands (reporting syntax
	// errors) without running them.
	let noexec = state::option(&mut k.root, cx.store, vp, OptId::Noexec).unwrap_or(false)
		&& !matches!(
			state::record(cx.store, vp, Key::Misc(MiscKey::Interactive)),
			Ok(Some(Record::Misc(v))) if v.as_slice() == b"1"
		);
	// An interactive shell's own input: the line editor reads it, and
	// `preexec` runs before each event ([`super::zle::reader`]).
	let reader = super::zle::reader::applies(cx, vp);
	let gate = if reader {
		super::zle::reader::gate(vp)
	} else {
		None
	};
	let frame = top_frame(vp);
	let FrameKind::Script { src, pos, aux, stdin, .. } = &mut frame.kind else {
		// Function and subshell frames never run out of code.
		frame.unit = None;
		vp.frames.pop();
		return None;
	};
	if snapshot {
		aux.get_or_insert_with(Box::default).parse =
			Some(ParseSnapshot { features: feat.bits(), aliases: aliases.take() });
	}
	let (feat, aliases) = match aux.as_deref().and_then(|a| a.parse.as_ref()) {
		Some(p) => (Features::from_bits(p.features), p.aliases.as_ref()),
		None => (feat, aliases.as_ref()),
	};
	let pending = aux.as_deref().and_then(|a| a.pending.as_ref());
	// Text read to its end has no command left: no parser needed (each
	// `eval` would otherwise build one just to see the end).
	let at_end = !*stdin && pending.is_none() && pos.0 as usize >= src.len();
	let resume_from = Resume {
		pos:     Pos { offset: pos.0, line: pos.1 },
		pending: pending.map_or_default(|p| p.0.to_vec()),
		active:  pending.map_or_default(|p| p.1.iter().map(|a| a.to_vec()).collect()),
	};
	let mut parser = (!at_end).then(|| {
		let mut p = match aliases {
			Some(a) => Parser::new(src, feat, a),
			None => Parser::new(src, feat, crate::bash::syntax::NO_ALIASES),
		}
		.with_resume(&resume_from);
		p.recycle(core::mem::take(&mut k.spare_tree));
		p
	});
	let res = parser.as_mut().and_then(Parser::next_command);
	if res.is_none()
		&& let Some(p) = &mut parser
	{
		k.keep_spare_tree(p.take_tree());
	}
	// zsh: the input ran out with a construct open (`a ||`, `a &&` parse as
	// complete commands here; interactive zsh's lexer reads another line).
	if *stdin
		&& let Some(p) = &parser
		&& (needs_more_input(src, res.as_ref(), p.resume().pos)
			|| p.zsh_cmdstack().is_some_and(|s| !s.is_empty()))
	{
		if reader {
			// A command left open continues on a `PS2` line; `%_` shows
			// what is open.
			let cont = res.is_some();
			let cmdstack = if cont {
				p.zsh_cmdstack().unwrap_or_default()
			} else {
				Vec::new()
			};
			drop(parser);
			return super::zle::reader::read_line(k, vp, cx, cont, cmdstack);
		}
		drop(parser);
		// An interactive shell reports changed jobs before it reads its
		// next line (zsh `preprompt`), once per line.
		if super::jobctl::interactive(k) && vp.parent.is_none() && top_frame(vp).scratch.is_none() {
			if let Some(job) = super::jobctl::announce_wait(k) {
				return Some(WaitKey::Proc(job));
			}
			super::jobctl::notices_before_prompt(k, cx, vp);
		}
		return read_script_line(k, vp, cx, zhist);
	}
	let Some(res) = res else {
		let empty_src = src.is_empty();
		// `eval` or `source` text without a command (empty, blanks,
		// comments) ends with status 0, as bash's `parse_and_execute` and
		// zsh's `LOOP_EMPTY` do: no command was ever parsed, so the position
		// never moved. Until a first command runs, `$?` is the caller's.
		let no_command = pos.0 == 0;
		// zsh `zexit`: an interactive shell saves its history as its input
		// ends.
		if zsh_root && matches!(frame.kind, FrameKind::Script { what: ScriptKind::Run, .. }) {
			let mut sc = frame.scratch.take().unwrap_or_default();
			if let Err(key) = builtins::history::zsh::exit_save(k, cx, vp, &mut sc) {
				top_frame(vp).scratch = Some(sc);
				return Some(key);
			}
		}
		let frame = top_frame(vp);
		let (status, source, cancel, return_target, exit) = match frame.kind {
			FrameKind::Script {
				what: ScriptKind::Trap { status, cancel, return_target, exit, .. },
				..
			} => (Some(status), false, cancel, return_target, exit),
			FrameKind::Script { what: ScriptKind::Source, .. } => (None, true, None, None, false),
			_ => (None, false, None, None, false),
		};
		let debug = matches!(frame.kind, FrameKind::Script {
			what: ScriptKind::Trap { key: TrapKey::Debug, .. },
			..
		});
		let eval = matches!(frame.kind, FrameKind::Script { what: ScriptKind::Eval, .. });
		// zsh `execode` of empty code (`zstyle -e`, `zregexparse`) leaves 0.
		let code = matches!(frame.kind, FrameKind::Script { what: ScriptKind::Code(_), .. });
		// A zsh function trap (`TRAPZERR`, …) runs above a trap frame
		// without text.
		let func_trap = status.is_some() && empty_src;
		let trap_status = vp.status;
		let top = vp.frames.len() - 1;
		// The text of a zsh command substitution (`child_text`) ends its
		// child: the child's own EXIT trap runs.
		let sub_end = eval && top == 0 && vp.parent.is_some() && mode.dialect() == Dialect::Zsh;
		if source && return_trap(k, vp, cx, top) {
			return None;
		}
		pop_frame(&mut k.root, cx.store, vp);
		if debug && !vp.frames.is_empty() {
			zsh_debug_done(k, vp, cx);
		}
		if (source || eval || code) && no_command {
			vp.status = 0;
		}
		if sub_end {
			start_exit_trap_once(k, vp, cx);
			return None;
		}
		if let Some(cancel) = cancel {
			finish_cancel(&mut k.root, cx.store, vp, cancel);
		} else if let Some(status) = status
			&& exit
		{
			exit_shell(k, vp, cx, status);
		} else if func_trap && trap_status != 0 && vp.mode.dialect() == Dialect::Zsh {
			// zsh `dotrapargs`: a function trap returning non-zero forces
			// a return from the interrupted code, with the error flag set.
			zsh_discard(k, vp, cx, trap_status);
		} else if let Some(status) = status {
			vp.status = status;
			if let Some(target) = return_target {
				unwind(&mut k.root, cx.store, vp, target);
			} else if debug
				&& trap_status != 0
				&& state::option(&mut k.root, cx.store, vp, OptId::Extdebug).unwrap_or(false)
			{
				// `extdebug`: a failing DEBUG trap skips the command; at a
				// function's entry, the whole body (and its RETURN trap).
				let f = top_frame(vp);
				let skippable = f
					.unit
					.as_ref()
					.and_then(|u| u.ops.get(f.pc as usize))
					.is_some_and(|op| {
						!matches!(op.code, Opcode::ForIn | Opcode::ForNext | Opcode::CaseWord)
					});
				if f.debug_pc == Some(ENTRY_DEBUG) {
					pop_frame(&mut k.root, cx.store, vp);
					vp.status = trap_status;
				} else if f.debug_pc == Some(f.pc) && skippable {
					f.pc += 1;
					f.debug_pc = None;
				}
			}
		}
		return None;
	};
	let from_stdin = *stdin;
	// A command came, so a parser read it.
	let resume = parser.as_ref().expect("a command was parsed").resume();
	let next = resume.pos;
	let read = (history && !zhist).then(|| input_lines(src, pos.0 as usize, next.offset as usize));
	// zsh `hend`: the event joins the history; `:p` and `histverify` keep
	// it from running, an expansion shows the line first.
	let mut run = true;
	if zhist {
		// zsh `hend`'s `zshaddhistory` hooks (the interactive reader runs
		// them as frames): the first non-zero status decides.
		let mut hookret = 0;
		if reader && from_stdin {
			let at = pos.0;
			match super::zle::reader::addhistory(k, vp, cx, at) {
				Ok(r) => hookret = r,
				Err(key) => return key,
			}
		}
		let frame = top_frame(vp);
		let FrameKind::Script { src, .. } = &frame.kind else {
			return None;
		};
		let prog = res
			.as_ref()
			.ok()
			.map(|cc| builtins::history::zsh::prog_info(cc, src));
		let mut sc = frame.scratch.take().unwrap_or_default();
		match builtins::history::zsh::hend(k, cx, vp, &mut sc, prog.as_ref(), hookret) {
			Err(key) => {
				top_frame(vp).scratch = Some(sc);
				return Some(key);
			},
			Ok(out) => hend_output(k, cx, vp, out, &mut run),
		}
	}
	// zsh `loop()`: an event that runs gets `preexec` first, with the
	// history line `hend` stored, the one-line job text and the full text.
	if reader
		&& from_stdin
		&& run
		&& !noexec
		&& let Ok(cc) = &res
	{
		let frame = top_frame(vp);
		let at = match &frame.kind {
			FrameKind::Script { pos, .. } => pos.0,
			_ => 0,
		};
		if gate != Some(at) {
			let hist = if zhist {
				builtins::history::zsh::latest_text(&k.root, cx.store, vp).unwrap_or_default()
			} else {
				match &top_frame(vp).kind {
					FrameKind::Script { src, pos, .. } => src
						.get(pos.0 as usize..next.offset as usize)
						.map_or_default(|t| BString::from(t.strip_suffix(b"\n").unwrap_or(t))),
					_ => BString::default(),
				}
			};
			let list = cc.list();
			let jobtext = BString::from(crate::bash::syntax::zsh::getjobtext(list));
			let permtext = BString::from(crate::bash::syntax::zsh::getpermtext(list, 0));
			return super::zle::reader::before_run(k, vp, cx, at, [hist, jobtext, permtext]);
		}
	}
	let frame = top_frame(vp);
	let FrameKind::Script { src, pos, aux, .. } = &mut frame.kind else {
		return None;
	};
	*pos = (next.offset, next.line);
	if !resume.pending.is_empty() {
		aux.get_or_insert_with(Box::default).pending = Some((
			BString::from(resume.pending),
			resume.active.into_iter().map(BString::from).collect(),
		));
	} else if let Some(a) = aux {
		a.pending = None;
		if a.parse.is_none() {
			*aux = None;
		}
	}
	let (unit, line) = match res {
		Ok(_) if noexec || !run => return None,
		Ok(cc) => {
			let line = cc.line;
			let observed = k.mask.contains(crate::bash::event::EventKind::UnitCompiled);
			let (unit, tree) = k.engine.compile(cc, src, mode, feat, observed);
			if let Some(tree) = tree {
				k.keep_spare_tree(tree);
			}
			(unit, line)
		},
		Err(e) => {
			// bash abandons the rest of a script after a syntax error,
			// except one it recovers from (the parser resumes after it).
			if !e.recovered {
				*pos = (src.len() as u32, next.line);
				if let Some(a) = aux {
					a.pending = None;
				}
			}
			let line = e.line;
			let unit = k.engine.intern(ir::syntax_unit(&e, src, mode, feat));
			(unit, line)
		},
	};
	frame.unit = Some(Arc::clone(&unit));
	frame.pc = 0;
	let top_level = matches!(frame.kind, FrameKind::Script { what: ScriptKind::Run, .. });
	if top_level && vp.parent.is_none() {
		super::jobctl::command_read(k);
	}
	if let Some(lines) = read {
		let now = cx.host.wall().secs;
		builtins::history::remember(k, cx.store, vp, lines, now);
	}
	announce_at(k, cx, vp.vpid, vp.runs.front(), &unit, line, source_origin.as_ref());
	None
}

/// The literal argument that actually entered a native script. IR word ids
/// are canonical parser ids; fixed-word proof rules out expansion/split drift.
pub(super) fn literal_script_origin(
	vp: &Vproc,
	source: &[u8],
	shell: bool,
) -> Option<crate::bash::event::SourceOrigin> {
	let (unit, node) = vp.command.as_ref()?;
	let op = unit
		.ops
		.iter()
		.find(|op| op.code == Opcode::Exec && op.node == *node)?;
	let command = unit.cmds.get(op.a as usize)?;
	let words = unit.lists.get(command.words as usize)?;
	let literal = |index: usize| -> Option<Vec<u8>> {
		let word = unit.words.get(*words.get(index)? as usize)?;
		if !word.fixed || !word.noglob {
			return None;
		}
		let mut text = Vec::new();
		for part in &word.parts {
			match part {
				ir::Part::Lit(bytes) | ir::Part::Quoted(bytes) => text.extend_from_slice(bytes),
				_ => return None,
			}
		}
		Some(text)
	};
	let index = if shell {
		let mut executable = None;
		for i in 0..words.len() {
			let text = literal(i)?;
			let name = text.rsplit(|byte| *byte == b'/').next()?;
			if matches!(name, b"bash" | b"sh" | b"zsh" | b"dash" | b"ksh") {
				executable = Some(i);
				break;
			}
		}
		let mut body = None;
		for i in executable? + 1..words.len() {
			let flag = literal(i)?;
			if flag.starts_with(b"-") && !flag.starts_with(b"--") && flag[1..].contains(&b'c') {
				body = Some(i + 1);
				break;
			}
		}
		body?
	} else {
		if words.len() != 2 || literal(0)?.as_slice() != b"eval" {
			return None;
		}
		1
	};
	if literal(index)?.as_slice() != source {
		return None;
	}
	let word = unit.words.get(*words.get(index)? as usize)?;
	let span = unit.nodes.get(word.node as usize)?;
	Some(crate::bash::event::SourceOrigin {
		vpid: vp.vpid,
		node: word.node,
		span: crate::bash::event::SpanOwned {
			unit: unit.id,
			lo:   span.lo,
			hi:   span.hi,
			line: unit.line + span.line,
			col:  span.col,
		},
	})
}

/// Announce `unit` with `UnitCompiled`, deduplicated within a bounded
/// observer-generation cache (eviction may safely reannounce a unit).
/// (`line`: the script line of its first byte), before events naming it.
/// Parsed commands announce immediately; cached/restored frames announce
/// only when executed. No store scan or parsing ahead is needed.
pub fn announce(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vpid: Vpid,
	run: Option<&Run>,
	unit: &Unit,
	line: u32,
) {
	if !k.mask.contains(crate::bash::event::EventKind::UnitCompiled) {
		return;
	}
	let origin = k
		.trace_unit_origins
		.get(&vpid)
		.and_then(|origins| origins.get(&unit.id))
		.copied();
	announce_at(k, cx, vpid, run, unit, line, origin.as_ref());
}

fn announce_at(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vpid: crate::bash::ids::Vpid,
	run: Option<&Run>,
	unit: &Unit,
	line: u32,
	parent: Option<&crate::bash::event::SourceOrigin>,
) {
	if k.mask.contains(crate::bash::event::EventKind::UnitCompiled) && !unit.nodes.is_empty() {
		let key = (vpid, unit.id, parent.copied());
		if let Some(parent) = parent {
			record_source_origin(k, unit, vpid, *parent);
		} else {
			clear_source_origin(k, unit, vpid);
		}
		// Vpids keep advancing in long-running pipeline/background loops.
		// Reannouncements are safe; an already-known key needs no eviction.
		if k.announced.len() >= 20_000 && !k.announced.contains(&key) {
			k.announced.clear();
		}
		if k.announced.insert(key) {
			if unit.trace_syntax.get().is_none()
				&& let Some(syntax) = crate::bash::trace::syntax::UnitSyntax::restore(unit)
			{
				let _ = unit.trace_syntax.set(Arc::new(syntax));
			}
			k.emit(
				cx,
				(vpid, unit.mode),
				run,
				EventData::UnitCompiled(CompiledUnit { unit, line, parent }),
			);
		}
	}
}

fn clear_source_origin(k: &mut Kernel, unit: &Unit, vpid: crate::bash::ids::Vpid) {
	if let Some(origins) = k.trace_unit_origins.get_mut(&vpid) {
		if origins.contains_key(&unit.id) {
			Arc::make_mut(origins).remove(&unit.id);
		}
		for function in &unit.funcs {
			clear_source_origin(k, &function.body, vpid);
		}
	}
}

fn record_source_origin(
	k: &mut Kernel,
	unit: &Unit,
	vpid: crate::bash::ids::Vpid,
	origin: crate::bash::event::SourceOrigin,
) {
	if k.trace_unit_origins.len() >= crate::bash::trace::history::HISTORY_EVENTS {
		return;
	}
	let origins = k.trace_unit_origins.entry(vpid).or_default();
	if origins.get(&unit.id) == Some(&origin) {
		return;
	}
	Arc::make_mut(origins).insert(unit.id, origin);
	for function in &unit.funcs {
		record_source_origin(k, &function.body, vpid, origin);
	}
}

/// The input lines the parser finished reading while it moved from `from`
/// to `to` in `src` (newlines stripped): each line whose newline lies in
/// between, and an unterminated last line at the end of the input.
fn input_lines(src: &[u8], from: usize, to: usize) -> Vec<BString> {
	let to = to.min(src.len());
	let mut lines = Vec::new();
	let mut start = src[..from.min(to)]
		.iter()
		.rposition(|&c| c == b'\n')
		.map_or(0, |i| i + 1);
	for (i, &c) in src.iter().enumerate().take(to).skip(from) {
		if c == b'\n' {
			lines.push(BString::from(&src[start..i]));
			start = i + 1;
		}
	}
	if to == src.len() && start < to && from < to {
		lines.push(BString::from(&src[start..to]));
	}
	lines
}

/// Whether a script read from stdin must read another line before running
/// what `src` holds from the frame's position: the input ran out (`None`),
/// a syntax error sits at the end of the input (an open quote, compound
/// command or `[[`), or the command ends at the end of the input with a
/// here-document cut short or a trailing `\`-newline. bash reads the same
/// way: line by line, until the parser has a complete command.
fn needs_more_input(
	src: &[u8],
	res: Option<&Result<CompleteCommand, ParseError>>,
	next: Pos,
) -> bool {
	let at_end = next.offset as usize >= src.len();
	match res {
		None => true,
		Some(Err(e)) => {
			matches!(e.kind, ParseErrorKind::UnexpectedEof { .. } | ParseErrorKind::Unmatched(_))
				|| e.span.lo as usize >= src.len()
		},
		Some(Ok(cc)) => {
			let continued = src
				.strip_suffix(b"\n")
				.is_some_and(|line| line.iter().rev().take_while(|&&c| c == b'\\').count() % 2 == 1);
			at_end && (!cc.warnings.is_empty() || continued)
		},
	}
}

/// What zsh's `hend` leaves to the reader: the expanded line shown on the
/// terminal output (standard error here), messages, and whether the event
/// runs (`histverify` puts the line back in the editor instead; without
/// one it is dropped).
pub(crate) fn hend_output(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &mut Vproc,
	out: builtins::history::zsh::Hend,
	run: &mut bool,
) {
	for m in out.msgs {
		k.diag(cx, vp, 0, Diag::Usage { msg: m.to_str_lossy().into_owned().into() });
	}
	if let Some(mut line) = out.print {
		line.push(b'\n');
		vp.out
			.push_back(PendingWrite { fd: 2, bytes: line, off: 0 });
	}
	*run = out.run;
}

/// Append the next line of fd 0 to the top (stdin) script frame's source;
/// at end of file the frame stops reading. `Some` while the line is
/// pending; the partial read waits in the frame's scratch. `zhist`: zsh
/// history is on (an event begins with `hbegin`, each line goes through
/// history expansion; a failed expansion abandons the event, whose `hend`
/// runs before the next line is read).
fn read_script_line(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	zhist: bool,
) -> Option<WaitKey> {
	use builtins::history::zsh as hz;
	let mut sc = top_frame(vp).scratch.take().unwrap_or_default();
	if zhist {
		match hz::before_line(k, cx, vp, &mut sc) {
			Err(key) => {
				top_frame(vp).scratch = Some(sc);
				return Some(key);
			},
			Ok(Some(out)) => {
				let failed = out.failed;
				let mut run = true;
				hend_output(k, cx, vp, out, &mut run);
				// zsh `loop`: a line that did not parse sets `$?` to 1.
				if failed && vp.status == 0 {
					vp.status = 1;
				}
			},
			Ok(None) => {},
		}
	}
	let input = Probe::Input {
		fd:         0,
		delim:      Some(b'\n'),
		lines:      1,
		nchars:     None,
		part:       0,
		timeout_ns: None,
	};
	let answer = match probe::cached(&sc, &input).cloned() {
		Some(answer) => answer,
		None => match probe::perform(k, cx, vp, &mut sc, &input) {
			Ok(answer) => answer,
			Err(key) => {
				top_frame(vp).scratch = Some(sc);
				return Some(key);
			},
		},
	};
	let ProbeResult::Input { data, eof, .. } = answer else {
		return None;
	};
	let mut text = data;
	if zhist && !text.is_empty() {
		match hz::expand(k, cx, vp, &mut sc, &text) {
			Err(key) => {
				top_frame(vp).scratch = Some(sc);
				return Some(key);
			},
			Ok(hz::Expanded::Line(t)) => text = t,
			Ok(hz::Expanded::Failed(d)) => {
				if let Some(d) = d {
					k.diag(cx, vp, 0, d);
				}
				text = BString::default();
				// The event's earlier lines go with it.
				if let FrameKind::Script { src, pos, aux, .. } = &mut top_frame(vp).kind {
					let skipped = src[(pos.0 as usize).min(src.len())..]
						.split(|&c| c == b'\n')
						.count()
						- 1;
					*pos = (src.len() as u32, pos.1 + skipped as u32 + 1);
					if let Some(a) = aux {
						a.pending = None;
					}
				}
			},
		}
	}
	if let FrameKind::Script { src, stdin, .. } = &mut top_frame(vp).kind {
		src.extend_from_slice(&text);
		*stdin = !eof;
	}
	None
}

/// The top frame's unit reached `End`.
fn end_unit(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>) {
	let frame = top_frame(vp);
	match frame.kind {
		FrameKind::Script { .. } => frame.unit = None,
		FrameKind::Function { .. }
			if frame
				.unit
				.as_ref()
				.is_some_and(|u| u.mode.dialect() == Dialect::Zsh) =>
		{
			let target = vp.frames.len() - 1;
			zsh_leave(k, vp, cx, target);
		},
		FrameKind::Function { .. } => {
			let target = vp.frames.len() - 1;
			if !return_trap(k, vp, cx, target) {
				pop_frame(&mut k.root, cx.store, vp);
			}
		},
		FrameKind::NoFork | FrameKind::Stage => pop_frame(&mut k.root, cx.store, vp),
		FrameKind::Subshell | FrameKind::Job { .. } => {
			unwind(&mut k.root, cx.store, vp, 0);
			start_exit_trap_once(k, vp, cx);
		},
	}
}

/// Pop the top frame, restoring the fds its redirections saved and the
/// scope of a function call or `${ ;}`. A store failure is kept on `root`.
pub fn pop_frame(root: &mut Root, store: &mut dyn StateStore, vp: &mut Vproc) {
	let Some(mut f) = vp.frames.pop() else {
		return;
	};
	if matches!(f.kind, FrameKind::Script { what: ScriptKind::Trap { .. }, .. }) {
		vp.trap_frames = vp.trap_frames.saturating_sub(1);
	}
	if let Some(sc) = f.scratch.take() {
		drop_scratch(root, store, vp, sc);
	}
	while let Some(saves) = f.redirs.pop() {
		restore(vp, saves);
	}
	let keep = vp.frames.len();
	close_procsubs(vp, keep);
	super::callstack::truncate(root, store, vp, keep);
	if f.kind == FrameKind::NoFork {
		pass_reply(root, store, vp);
	}
	// A zsh function's caller gets its `OPTIND` back without
	// `POSIX_BUILTINS`, decided before the function's options go (zsh
	// `doshfunc`), restored once its locals have.
	let zsh_body = matches!(f.kind, FrameKind::Function { .. })
		&& f
			.unit
			.as_ref()
			.is_some_and(|u| u.mode.dialect() == crate::bash::ids::Dialect::Zsh);
	let zsh_optind = if zsh_body {
		match state::zsh_option(root, store, vp, crate::bash::zshopt::ZshOpt::Posixbuiltins) {
			Ok(posix) => (!posix).then(|| f.getopts.take()),
			Err(err) => {
				root.fail(err);
				None
			},
		}
	} else {
		None
	};
	// The function's scope, read before it goes.
	let top = state::scope_count(root, vp).checked_sub(1);
	if matches!(f.kind, FrameKind::Function { .. })
		&& let Some(top) = top
		&& state::scope_may_bind(root, vp, top)
	{
		match state::scope_var(store, vp, top, b"-") {
			// `local -`: the function's `set -o` changes end with it.
			Ok(Some(Some(saved))) => {
				vp.restore_opts
					.push(BString::from(saved.as_scalar().unwrap_or_default()));
			},
			Ok(_) => {},
			Err(err) => root.fail(err),
		}
		match state::scope_binds(store, vp, top, b"OPTIND") {
			// A local `OPTIND`: the caller's getopts scan resumes where it
			// was.
			Ok(true) if !zsh_body => vp.getopts = f.getopts.take().map_or_default(|g| *g),
			Ok(_) => {},
			Err(err) => root.fail(err),
		}
	}
	// A zsh-dialect or mode-switching call, or a frame with zsh state to
	// restore: a bash frame of a bash vproc has neither.
	if matches!(f.kind, FrameKind::Function { zsh: true, .. }) || vp.zsh.is_some() {
		zsh_pop(root, store, vp, &f, top, keep);
	}
	if matches!(
		f.kind,
		FrameKind::Function { .. }
			| FrameKind::NoFork
			| FrameKind::Script { what: ScriptKind::Trap { .. }, .. }
	) {
		state::drop_scope(root, store, vp);
	}
	if let Some(saved) = zsh_optind
		&& let Err(err) = super::builtins::zsh_vars::optind_leave(root, store, vp, saved)
	{
		root.fail(err);
	}
}

/// The zsh part of [`pop_frame`] for frame `f` (popped; `keep` frames
/// remain, `top` is the scope it may own): the options, mode and sticky
/// emulation a zsh-dialect or mode-switching call restores (zsh
/// `doshfunc`), then the state the end of `emulate … -c CMD` or of a trap
/// run in another mode restores. Out of line, off the bash path.
#[inline(never)]
fn zsh_pop(
	root: &mut Root,
	store: &mut dyn StateStore,
	vp: &mut Vproc,
	f: &Frame,
	top: Option<usize>,
	keep: usize,
) {
	if matches!(f.kind, FrameKind::Function { zsh: true, .. })
		&& let Some(top) = top
	{
		let zsh_body = f
			.unit
			.as_ref()
			.is_some_and(|u| u.mode.dialect() == crate::bash::ids::Dialect::Zsh);
		let res = state::scope_zsh(store, vp, top).and_then(|saved| match saved {
			Some(mut saved) => {
				let traps = std::mem::take(&mut saved.traps);
				super::mode::leave_call(root, store, vp, *saved, zsh_body)?;
				// zsh `endtrapscope`: the traps the function replaced.
				if zsh_body {
					super::builtins::trap::end_scope(root, store, vp, traps)?;
				}
				Ok(())
			},
			None => Ok(()),
		});
		if let Err(err) = res {
			root.fail(err);
		}
	}
	if vp.zsh.is_some()
		&& let Some(saved) = vp.take_restore(u32::try_from(keep + 1).unwrap_or(u32::MAX))
		&& let Err(err) = super::mode::leave_call(root, store, vp, saved, true)
	{
		root.fail(err);
	}
}

/// A `${| …; }` ends: hand the value of its local `REPLY` to the capture
/// of the op waiting for it (the scope is popped next).
fn pass_reply(root: &mut Root, store: &mut dyn StateStore, vp: &Vproc) {
	let reply = match state::scope_count(root, vp).checked_sub(1) {
		Some(top) => match state::scope_var(store, vp, top, b"REPLY") {
			Ok(var) => var
				.flatten()
				.and_then(|v| v.as_scalar().map(<[u8]>::to_vec))
				.unwrap_or_default(),
			Err(err) => {
				root.fail(err);
				Vec::new()
			},
		},
		None => Vec::new(),
	};
	if let Some(PendingSub::NoFork { capture, value: true }) = vp
		.frames
		.last()
		.and_then(|f| f.scratch.as_ref())
		.and_then(|s| s.sub.as_ref())
	{
		let mut capture = capture.clone();
		let _ = crate::bash::fs::File::poll_write(
			&mut capture,
			&mut Context::from_waker(std::task::Waker::noop()),
			&reply,
		);
	}
}

/// Abandon an op's scratch: pop the temporary scope of a builtin and
/// restore the fds its redirections replaced.
pub fn drop_scratch(
	root: &mut Root,
	store: &mut dyn StateStore,
	vp: &mut Vproc,
	mut sc: Box<Scratch>,
) {
	if sc.exec.as_ref().is_some_and(|e| e.scoped) {
		state::drop_scope(root, store, vp);
	}
	if let Some(io) = sc.io.as_mut() {
		for s in io.saved.drain(..).rev() {
			vp.fds.set(s.fd, s.prev);
		}
	}
	// Keep it cleared for a next op: a function call's op holds its own
	// while the body runs, so one spare per level saves a scratch (and
	// all its buffers) per call.
	if vp.spare.len() < SPARE_SCRATCH {
		sc.recycle();
		vp.spare.push(sc);
	}
}

/// Most cleared scratches a vproc keeps ([`Vproc::spare`]): enough for a
/// few nested calls, small for an idle vproc's memory.
const SPARE_SCRATCH: usize = 4;

/// Drop the top frame's scratch of an op that is over (recycled).
pub fn clear_scratch(root: &mut Root, store: &mut dyn StateStore, vp: &mut Vproc) {
	if let Some(sc) = top_frame(vp).scratch.take() {
		drop_scratch(root, store, vp, sc);
	}
}

/// Take the top frame's scratch, or a cleared one (the vproc's spare).
pub fn take_scratch(vp: &mut Vproc) -> Box<Scratch> {
	let sc = vp.frames.last_mut().and_then(|f| f.scratch.take());
	sc.unwrap_or_else(|| vp.spare.pop().unwrap_or_else(new_scratch))
}

/// Pop frames until `keep` remain.
pub fn unwind(root: &mut Root, store: &mut dyn StateStore, vp: &mut Vproc, keep: usize) {
	while vp.frames.len() > keep {
		pop_frame(root, store, vp);
	}
}

/// Restore saved fds (latest first).
pub fn restore(vp: &mut Vproc, saves: Vec<Saved>) {
	for s in saves.into_iter().rev() {
		vp.fds.set(s.fd, s.prev);
	}
}

/// Current script line of `node` in the top frame.
pub fn line_of(vp: &Vproc, node: u32) -> u32 {
	vp.frames
		.len()
		.checked_sub(1)
		.map_or(0, |fi| line_in(vp, fi, node))
}

/// [`line_of`] in frame `fi`. zsh numbers no lines in a function body
/// that is a lone command without braces (`f() cmd`, `() cmd`): `lineno`
/// stays the caller's.
fn line_in(vp: &Vproc, fi: usize, node: u32) -> u32 {
	let f = &vp.frames[fi];
	let Some(u) = f.unit.as_ref() else {
		return 0;
	};
	if fi > 0 && keeps_caller_line(f) {
		let caller = &vp.frames[fi - 1];
		if let Some(op) = caller
			.unit
			.as_ref()
			.and_then(|cu| cu.ops.get(caller.pc as usize))
		{
			return line_in(vp, fi - 1, op.node);
		}
	}
	(u.line + u.nodes.get(node as usize).map_or(0, |n| n.line)).saturating_sub(f.line_shift)
}

/// Whether `f` is the call of a zsh function whose body is a lone command
/// without braces: its commands are on the caller's line (zsh numbers no
/// lines in it), and diagnostics count from the caller's base.
pub(super) fn keeps_caller_line(f: &Frame) -> bool {
	matches!(f.kind, FrameKind::Function { .. })
		&& f.unit.as_ref().is_some_and(|u| {
			u.mode.dialect() == Dialect::Zsh
				&& u
					.ops
					.first()
					.is_some_and(|op| matches!(op.code, Opcode::Exec | Opcode::Spawn))
		})
}

/// Unit-relative line of the last byte of syntax node `node`.
#[expect(clippy::naive_bytecount, reason = "one node's text; no bytecount dependency")]
pub fn end_line(unit: &Unit, node: u32) -> u32 {
	unit.nodes.get(node as usize).map_or(0, |n| {
		let text = unit
			.source
			.get(n.lo as usize..n.hi as usize)
			.unwrap_or_default();
		n.line + text.iter().filter(|&&c| c == b'\n').count() as u32
	})
}

/// The line bash reports for an error of a compound command (a failed
/// redirection, a rejected function definition): in the base frame of a
/// `( … )` child the subshell's last line, else `line`.
fn compound_line(vp: &Vproc, line: u32) -> u32 {
	vp.frames
		.last()
		.and_then(|f| f.subshell_line)
		.unwrap_or(line)
}

const fn depths(f: &Frame) -> Depths {
	Depths {
		enters: f.enters.len() as u32,
		cases:  f.cases.len() as u32,
		times:  f.times.len() as u32,
		redirs: f.redirs.len() as u32,
	}
}

/// Truncate a frame's stacks to `d`, restoring redirections.
fn truncate(vp: &mut Vproc, d: Depths) {
	let f = top_frame(vp);
	f.enters.truncate(d.enters as usize);
	f.cases.truncate(d.cases as usize);
	f.times.truncate(d.times as usize);
	let mut saves = Vec::new();
	while f.redirs.len() > d.redirs as usize {
		saves.push(f.redirs.pop().expect("checked"));
	}
	for s in saves {
		restore(vp, s);
	}
}

fn break_loops(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>, n: u32, cont: bool, op: Op) {
	let mut remaining = n.max(1);
	loop {
		let f = top_frame(vp);
		if let Some(rec) = f.loops.last().cloned() {
			// More levels than loops: the outermost loop ends.
			if remaining > 1 && f.loops.len() > 1 {
				f.loops.pop();
				truncate(vp, rec.depth);
				remaining -= 1;
				continue;
			}
			truncate(vp, rec.depth);
			// The status is the builtin's: 0, or 1 for `break 0` (which
			// leaves every loop).
			let status = vp.status;
			let f = top_frame(vp);
			// `continue` ends the body with its status too: the loop's
			// status if no other body command runs.
			if let Some(r) = f.loops.last_mut() {
				r.status = status;
			}
			f.pc = if cont { rec.cont } else { rec.exit };
			return;
		}
		let crossable = matches!(
			f.kind,
			FrameKind::Script { what: ScriptKind::Eval, .. } | FrameKind::NoFork | FrameKind::Stage
		);
		if crossable && vp.frames.len() > 1 {
			pop_frame(&mut k.root, cx.store, vp);
			// The caller's op (`eval`) is abandoned with the loop.
			clear_scratch(&mut k.root, cx.store, vp);
			continue;
		}
		break;
	}
	// bash's `check_loop_level` complains only outside posix mode.
	if !state::option(&mut k.root, cx.store, vp, OptId::Posix).unwrap_or(false) {
		let line = line_of(vp, op.node);
		let name = if cont { "continue" } else { "break" };
		let diag = Diag::Usage { msg: "only meaningful in a `for', `while', or `until' loop".into() };
		k.diag(cx, vp, line, diag.by(name));
	}
	vp.status = 0;
	top_frame(vp).pc += 1;
}

/// The top frame's scratch, created from the vproc's spare if absent.
/// Inlined: the staged ops call it for every field access (xeon profile:
/// `exec::scratch` 3 % self on loop/func); building a new one is cold.
#[inline]
pub fn scratch(vp: &mut Vproc) -> &mut Scratch {
	let spare = &mut vp.spare;
	vp.frames
		.last_mut()
		.expect("ops run in a frame")
		.scratch
		.get_or_insert_with(|| spare.pop().unwrap_or_else(new_scratch))
}

/// A fresh scratch, built in place on the heap; once per vproc in steady
/// state (the spare is reused).
#[cold]
#[inline(never)]
fn new_scratch() -> Box<Scratch> {
	Box::default()
}

/// Result of an expansion step of an op: `Ok` with the value, or the flow
/// that ends the op for now.
pub type Expanded<T> = Result<T, Flow>;

/// Run `f` as an expansion of the current op, with its replay log; start a
/// command substitution when one is needed and park until it is done.
pub fn expanding<T>(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	slot: Slot,
	record: bool,
	line: u32,
	f: impl FnOnce(&mut Expander<'_, '_>) -> Result<T, Stop>,
) -> Expanded<T> {
	let fi = vp.frames.len() - 1;
	let mut sc = take_scratch(vp);
	if let Some(flow) = settle_sub(k, vp, cx, &mut sc, slot) {
		top_frame(vp).scratch = Some(sc);
		return Err(flow);
	}
	let mut log = std::mem::take(&mut sc.logs[slot as usize]);
	let res = {
		let mut ex = Expander::new(k, cx, vp, &mut log, record, line);
		let r = super::zsh::subst::begin_pass(&mut ex).and_then(|()| f(&mut ex));
		let st = ex.sub_status;
		r.map(|v| (v, st))
	};
	// The slot still holds the empty `Vec` `take` left there (the scratch is
	// out of its frame meanwhile, nothing else fills it): put the log back
	// without a drop of that placeholder per expansion.
	let placeholder = std::mem::replace(&mut sc.logs[slot as usize], log);
	debug_assert_eq!(placeholder.capacity(), 0, "expansion log placeholder");
	std::mem::forget(placeholder);
	match res {
		Ok((v, sub)) => {
			if let (Some(status), Some(e)) = (sub, sc.exec.as_mut()) {
				e.sub_status = Some(status);
			}
			top_frame(vp).scratch = Some(sc);
			Ok(v)
		},
		Err(Stop::Sub { unit, entry, form, text }) => {
			// A no-fork substitution pushes its frame above this op's.
			let flow = start_sub(k, vp, cx, &mut sc, Sub { unit, entry, form, text, line });
			vp.frames[fi].scratch = Some(sc);
			Err(flow)
		},
		Err(stop) => Err(stopped(k, vp, cx, sc, slot, line, stop)),
	}
}

/// The flow of an [`expanding`] op whose expansion stopped other than for
/// a bash command substitution: a zsh one or an expansion probe (`=cmd`) to
/// run first, else an error ([`stop_flow`]). The scratch goes back to the
/// op's frame, still the top one. Out of line: one copy, not one per
/// [`expanding`] instance.
#[inline(never)]
fn stopped(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	mut sc: Box<Scratch>,
	slot: Slot,
	line: u32,
	stop: Stop,
) -> Flow {
	match stop {
		Stop::ZshSub { text, here } => {
			// A call run here pushes its frame above this op's.
			let fi = vp.frames.len() - 1;
			let flow = start_zsh_sub(k, vp, cx, &mut sc, &text, here, line);
			vp.frames[fi].scratch = Some(sc);
			flow
		},
		Stop::MathCall(call) => {
			// The function's frame goes above this op's.
			let fi = vp.frames.len() - 1;
			let flow = super::command::start_math_call(k, vp, cx, &mut sc, slot, &call, line);
			vp.frames[fi].scratch = Some(sc);
			flow
		},
		Stop::Probe(p) => {
			// Answered: log it and run the op again (it replays).
			let flow = match settle_probe(k, cx, vp, &mut sc, slot, &p) {
				Ok(()) => Flow::Call,
				Err(key) => Flow::Block(key),
			};
			top_frame(vp).scratch = Some(sc);
			flow
		},
		stop => {
			top_frame(vp).scratch = Some(sc);
			stop_flow(k, vp, cx, line, stop)
		},
	}
}

/// Expansion errors end the shell: posix mode, not interactive.
fn posix_exits(k: &mut Kernel, cx: &mut Cx<'_>, vp: &Vproc) -> bool {
	state::option(&mut k.root, cx.store, vp, OptId::Posix).unwrap_or(false)
		&& !matches!(
			state::record(cx.store, vp, Key::Misc(MiscKey::Interactive)),
			Ok(Some(Record::Misc(v))) if v.as_slice() == b"1"
		)
}

/// The status a fatal expansion error leaves when the EXIT trap is the
/// innermost trap action running: bash's EXIT trap keeps the status the
/// shell was exiting with (`last_command_exit_value` is saved across the
/// trap), so the shell leaves with that status and not with the constant
/// below. Only the EXIT trap does this, so a nested trap action of any
/// other kind answers `None` and keeps the constant.
///
/// The saved status is carried as the `i32` the frame holds, exactly as
/// every other reader of it does (`return` with no argument inside a
/// trap, the frame-pop restore); it is already a wait status in `0..=255`
/// on every path that arms a trap, and narrowing it here would be a
/// silent second opinion about a value this function does not own.
fn exit_trap_status(vp: &Vproc) -> Option<i32> {
	vp.frames.iter().rev().find_map(|frame| match frame.kind {
		FrameKind::Script { what: ScriptKind::Trap { key, status, .. }, .. } => {
			Some((key == TrapKey::Exit).then_some(status))
		},
		_ => None,
	})?
}

/// The flow for an expansion error (the diagnostic is printed).
pub fn stop_flow(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>, line: u32, stop: Stop) -> Flow {
	match stop {
		Stop::Sub { .. } | Stop::ZshSub { .. } => unreachable!("handled by the caller"),
		// An expansion that cannot park (a glob qualifier's) met a math
		// function.
		Stop::MathCall(call) => {
			let what = format!("a call of math function {} in this expansion", call.argzero);
			k.diag(cx, vp, line, Diag::Unsupported { what: what.into() });
			Flow::Discard(1)
		},
		// `$!` of a job still deciding on its pid: the op runs again (and
		// replays) once it has.
		Stop::Wait(key) => Flow::Block(key),
		// An expansion that cannot park (a glob qualifier's) met `=cmd`.
		Stop::Probe(_) => {
			k.diag(cx, vp, line, Diag::Unsupported { what: "`=cmd` in this expansion".into() });
			Flow::Discard(1)
		},
		// A non-interactive posix shell exits on an expansion error (bash's
		// `posixly_correct && !interactive_shell`), as on a fatal one.
		Stop::Fail(d) if !posix_exits(k, cx, vp) => {
			k.diag(cx, vp, line, d);
			Flow::Discard(1)
		},
		Stop::Fail(d) | Stop::Fatal(d) => {
			k.diag(cx, vp, line, d);
			// The EXIT trap keeps the status the shell was exiting with.
			// Under `set -e` bash reaches the same rows through its own
			// errexit jump, which this change does not model, so the
			// upstream constant stays whenever errexit is on.
			if vp.mode.dialect() != Dialect::Zsh
				&& let Some(status) = exit_trap_status(vp)
				&& !errexit_on(k, cx, vp)
			{
				return Flow::Exit(status);
			}
			// bash exits 127 from a `-c` string (`run_one_command`), 1 from a
			// script and from a subshell (`execute_in_subshell` keeps the
			// failure status); a nested shell (depth 0) is its own `-c` shell.
			let command = super::subshell_depth(vp) == 0
				&& matches!(
					state::record(cx.store, vp, Key::Misc(MiscKey::RunOrigin)),
					Ok(Some(Record::Misc(origin))) if origin.as_slice() == b"c"
				);
			Flow::Exit(if command { 127 } else { 1 })
		},
		Stop::Store(err) => {
			k.fail(err);
			Flow::Discard(1)
		},
	}
}

/// Answer the expansion probe `p` ([`Stop::Probe`]) of the op whose scratch
/// is `sc` and log the answer in `slot` ([`probe_atom`]) for the replay;
/// `Err` is the wait key while the probe is pending.
pub fn settle_probe(
	k: &Kernel,
	cx: &mut Cx<'_>,
	vp: &Vproc,
	sc: &mut Scratch,
	slot: Slot,
	p: &Probe,
) -> Result<(), WaitKey> {
	let answer = match super::probe::cached(sc, p) {
		Some(r) => r.clone(),
		None => super::probe::perform(k, cx, vp, sc, p)?,
	};
	sc.logs[slot as usize].push(probe_atom(answer));
	Ok(())
}

/// The logged form of an expansion probe's answer: a PATH search's path
/// (`None`: not found); an access check's success as an empty string; a
/// filesystem request's ([`super::fsprobe`]) bytes, names (a list), other
/// success (empty) or failure (`None`).
pub fn probe_atom(answer: ProbeResult) -> Atom {
	use super::fsprobe::FsAns;
	Atom::Str(match answer {
		ProbeResult::Path(p) => p,
		ProbeResult::Ok(ok) => ok.then(BString::default),
		ProbeResult::Fs(Ok(FsAns::Names(names))) => return Atom::List(names),
		// User database entries: name and home directory of each.
		ProbeResult::Fs(Ok(FsAns::Users(users))) => {
			return Atom::List(users.into_iter().flat_map(|u| [u.name, u.dir]).collect());
		},
		ProbeResult::Fs(Ok(FsAns::Bytes(b))) => Some(b),
		ProbeResult::Fs(Ok(_)) => Some(BString::default()),
		_ => None,
	})
}

/// A command substitution to start: its body and the line of the command
/// that runs it.
pub struct Sub {
	/// Unit holding the body.
	pub unit:  Arc<Unit>,
	/// Entry pc of the body.
	pub entry: u32,
	/// Syntax form.
	pub form:  ComsubForm,
	/// `strs` index of the body's source text.
	pub text:  Option<u32>,
	/// Line of the command running it.
	pub line:  u32,
}

/// Start a command substitution for the op whose scratch is `sc`.
pub fn start_sub(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	sc: &mut Scratch,
	sub: Sub,
) -> Flow {
	let Sub { unit, entry, form, text, line } = sub;
	let first = unit
		.ops
		.get(entry as usize)
		.and_then(|op| unit.nodes.get(op.node as usize))
		.map_or(line, |n| unit.line + n.line);
	// `line` is already shifted by this frame, so the difference is the
	// child's whole shift.
	let shift = first.saturating_sub(line);
	let capture = Capture::default();
	let out = FdRef::mem(capture.clone());
	// A command substitution runs without `set -e` unless `inherit_errexit`
	// (on in posix mode) is set.
	let posix = state::option(&mut k.root, cx.store, vp, OptId::Posix).unwrap_or(false);
	let inherit =
		posix || state::option(&mut k.root, cx.store, vp, OptId::InheritErrexit).unwrap_or(false);
	match form {
		ComsubForm::Fork => {
			let mut fds = vp.fds.clone();
			fds.set(1, Some(out));
			// Outside posix mode bash parses `$( )` without aliases and
			// re-parses its text with the aliases in effect when it runs,
			// numbering its lines from the line the shell is at: at top
			// level, where the whole command ends.
			let base = top_level_end_line(vp).unwrap_or(line);
			// `$(< file)` keeps its compiled form ([`ir::Op::CAT`]).
			let cat = unit
				.ops
				.get(entry as usize)
				.is_some_and(|op| op.flags & ir::Op::CAT != 0);
			let reparse = text.and_then(|i| unit.strs.get(i as usize)).filter(|_| {
				!posix
					&& !cat
					&& (base != line || matches!(builtins::alias_table(k, cx, vp), Ok(Some(_))))
			});
			let mut child = if let Some(src) = reparse {
				vp.child_text(k, cx.store, src, base, fds)
			} else {
				let mut child = vp.child(k, cx.store, Arc::clone(&unit), entry, fds);
				if let Some(f) = child.frames.last_mut() {
					f.line_shift = shift;
				}
				// A body without a command (`$()`, `$( )`, only comments)
				// exits 0, as bash's subshell does when it runs nothing; the
				// inherited `$?` matters only to a command that reads it. A
				// re-parsed body gets the same from its script frame's end.
				if unit
					.ops
					.get(entry as usize)
					.is_some_and(|op| op.code == Opcode::SubExit)
				{
					child.status = 0;
				}
				// A re-parsed one counts its `eval`-like frame instead.
				child.trace_base += 1;
				child
			};
			// With `-e` already off in the parent the child sees it off and
			// `SHELLOPTS` is already right: nothing to reset.
			if !inherit && state::option(&mut k.root, cx.store, vp, OptId::Errexit).unwrap_or(true) {
				state::store_record(
					&mut k.root,
					cx.store,
					&mut child,
					KeyBuf::Opt(OptId::Errexit),
					Some(Record::Opt(false)),
				);
				if let Err(err) = state::sync_option_vars(&mut k.root, cx.store, &mut child) {
					k.fail(err);
				}
			}
			// bash keeps job control and the job list in `$( )`: `jobs`
			// lists the parent's jobs, `fg` finds no current job.
			child.jobs = inherited_jobs(vp, vp.jobs.subshell);
			// Its externals stay in the shell's process group.
			super::jobctl::set_leader(k, child.vpid, None);
			let vpid = child.vpid;
			k.emit_op(cx, vp, 0, EventData::Subshell { child: vpid });
			k.spawned.push(Box::new(child));
			sc.sub = Some(PendingSub::Fork { vpid, capture });
			Flow::Block(WaitKey::Proc(vpid))
		},
		ComsubForm::NoFork | ComsubForm::Value => {
			// Its own scope for `local` (marked with an empty function name,
			// which `FUNCNAME` skips); `${| ;}` has a local `REPLY`.
			let mut vars = VarMap::default();
			if form == ComsubForm::Value {
				vars.insert(BString::from("REPLY"), None);
			}
			let scope = Scope { vars, positional: None, func: Some(BString::default()), zsh: None };
			state::push_scope(&mut k.root, cx.store, vp, scope);
			// Outside posix mode bash parses `${ ;}` without aliases and
			// re-parses its re-printed text when it runs, with the aliases
			// then in effect and lines counted from the command's line.
			let reparse = if posix {
				None
			} else {
				text.and_then(|i| {
					let t = unit.strs.get(i as usize)?;
					nofork_unit(k, cx, vp, (unit.id, i), t, line)
				})
			};
			let (unit, entry, shift) = match reparse {
				Some(u) => (u, 0, 0),
				None => (unit, entry, shift),
			};
			let mut frame = Frame::new(Some(unit), entry, FrameKind::NoFork);
			frame.line_shift = shift;
			// It shares the shell's options, so `-e` is ignored instead.
			frame.ignore_errexit = !inherit;
			let prev = vp.fds.get(1).cloned();
			if form == ComsubForm::NoFork {
				vp.fds.set(1, Some(out));
				frame.redirs.push(vec![Saved { fd: 1, prev }]);
			}
			vp.frames.push(frame);
			sc.sub = Some(PendingSub::NoFork { capture, value: form == ComsubForm::Value });
			Flow::Call
		},
	}
}

/// Start a zsh command substitution: `text` (zsh source, the body of
/// `$(…)` or `` `…` ``) parsed in the vproc's mode and run in a forked
/// child vproc whose standard output is captured (zsh `getoutput`).
/// `here` ([`Stop::ZshSub::here`]): a hook function call zsh makes from an
/// expansion (`subst_string_by_func`) runs in the current shell instead,
/// above the op's frame, its output uncaptured; the logged substitution
/// is its status.
pub fn start_zsh_sub(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	sc: &mut Scratch,
	text: &[u8],
	here: bool,
	line: u32,
) -> Flow {
	if here {
		sc.sub = Some(PendingSub::Here { status: vp.status });
		push_script(vp, text, line, ScriptKind::Hook);
		return Flow::Call;
	}
	let capture = Capture::default();
	let mut fds = vp.fds.clone();
	fds.set(1, Some(FdRef::mem(capture.clone())));
	let mut child = vp.child_text(k, cx.store, text, line, fds);
	child.jobs = inherited_jobs(vp, vp.jobs.subshell);
	// Its externals stay in the shell's process group (zsh
	// `ESUB_NOMONITOR`).
	super::jobctl::set_leader(k, child.vpid, None);
	let vpid = child.vpid;
	k.emit_op(cx, vp, 0, EventData::Subshell { child: vpid });
	k.spawned.push(Box::new(child));
	sc.sub = Some(PendingSub::Fork { vpid, capture });
	Flow::Block(WaitKey::Proc(vpid))
}

/// The direction of a zsh process substitution.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ZshProcSub {
	/// `<(…)`: the shell reads what the body writes.
	Input,
	/// `>(…)`: the body reads what the shell writes.
	Output,
}

/// Start a zsh process substitution running `text` (zsh source) in a child
/// vproc; the `/dev/fd/N` path the command gets (as `start_procsub`).
/// `=(…)` is [`super::zsh::subst`]'s `getoutputfile`.
pub fn start_zsh_procsub(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	text: &[u8],
	kind: ZshProcSub,
) -> BString {
	let output = kind == ZshProcSub::Output;
	let (r, w) = mem::pipe();
	let (r, w) = (FdRef::mem(r), FdRef::mem(w));
	let (mine, theirs, their_fd) = if output { (w, r, 0) } else { (r, w, 1) };
	let fd = (3..64)
		.rev()
		.find(|&fd| vp.fds.get(fd).is_none_or(|h| !h.is_open()))
		.unwrap_or_else(|| vp.fds.lowest_free(64));
	// The other substitutions' fds stay open in the child (zsh `getproc`'s
	// `closem` spares `FDT_PROC_SUBST`): its words may name them.
	let mut fds = vp.fds.clone();
	fds.set(their_fd, Some(theirs));
	let line = line_of(vp, 0);
	let child = vp.child_text(k, cx.store, text, line, fds);
	let vpid = child.vpid;
	// Not a job: its externals stay in the shell's group, without the
	// terminal (zsh `ESUB_ASYNC`).
	super::jobctl::set_leader(k, vpid, None);
	k.emit_op(cx, vp, 0, EventData::Subshell { child: vpid });
	k.spawned.push(Box::new(child));
	vp.fds.set(fd, Some(mine));
	vp.procsubs.push((vp.frames.len() as u32, fd));
	vp.last_bg = LastBg::new(vpid);
	// zsh's `procsubstpid` (`$sysparams[procsubstpid]`).
	let rec = Record::Misc(BString::from(vpid.0.to_string()));
	state::store_record(
		&mut k.root,
		cx.store,
		vp,
		KeyBuf::Misc(MiscKey::ZshProcsubstPid),
		Some(rec),
	);
	BString::from(format!("/dev/fd/{fd}"))
}

/// `${ ;}` bodies re-parsed while no alias is defined, by the unit and
/// `strs` index of their text, first line, features and mode: without
/// aliases the same text always re-parses to the same unit, so a loop
/// running one substitution parses and compiles it once. Bounded; not
/// imaged.
pub type NoforkUnits = HashMap<(UnitId, u32, u32, Features, ModeId), Arc<Unit>>;

/// Entries [`NoforkUnits`] holds before it starts over.
const NOFORK_UNITS: usize = 256;

/// `${ ;}` text (`strs` entry `at.1` of unit `at.0`) re-parsed as `{ text }`
/// with the current aliases, its first line numbered `line`; `None` keeps
/// the compiled body.
fn nofork_unit(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &Vproc,
	at: (UnitId, u32),
	text: &[u8],
	line: u32,
) -> Option<Arc<Unit>> {
	let (feat, aliases) =
		match features(k, cx.store, vp).and_then(|f| Ok((f, builtins::alias_table(k, cx, vp)?))) {
			Ok(v) => v,
			Err(err) => {
				k.fail(err);
				return None;
			},
		};
	let key = (at.0, at.1, line, feat, mode_of(vp));
	if aliases.is_none()
		&& let Some(unit) = k.nofork_units.get(&key)
	{
		return Some(Arc::clone(unit));
	}
	let mut src = Vec::with_capacity(text.len() + 2);
	src.push(b'{');
	// `${| ;}` text starts with its `|`.
	match text.split_first() {
		Some((b'|', rest)) => {
			src.push(b' ');
			src.extend_from_slice(rest);
		},
		_ => src.extend_from_slice(text),
	}
	src.push(b'}');
	let resume = Resume { pos: Pos { offset: 0, line }, ..Resume::default() };
	let cc = match &aliases {
		Some(a) => Parser::new(&src, feat, a)
			.with_resume(&resume)
			.next_command(),
		None => Parser::new(&src, feat, crate::bash::syntax::NO_ALIASES)
			.with_resume(&resume)
			.next_command(),
	}?
	.ok()?;
	let observed = k.mask.contains(crate::bash::event::EventKind::UnitCompiled);
	let (unit, _) = k.engine.compile(cc, &src, key.4, feat, observed);
	announce(k, cx, vp.vpid, vp.runs.front(), &unit, line);
	if aliases.is_none() {
		if k.nofork_units.len() >= NOFORK_UNITS {
			k.nofork_units.clear();
		}
		k.nofork_units.insert(key, Arc::clone(&unit));
	}
	Some(unit)
}

/// The last line of the command the top frame runs, when that frame is the
/// shell's script (bash's `line_number` there is where the reader is).
fn top_level_end_line(vp: &Vproc) -> Option<u32> {
	let f = vp.frames.last()?;
	if !matches!(f.kind, FrameKind::Script { what: ScriptKind::Run, .. }) {
		return None;
	}
	let unit = f.unit.as_ref()?;
	// A here-document's body is read after its line: bash's line is not
	// the command's end then.
	let heredoc = unit
		.redirs
		.iter()
		.flatten()
		.any(|r| matches!(r.target, ir::RedirTargetIr::HereDoc { .. }));
	if heredoc {
		return None;
	}
	// Compound commands set the line themselves (`for`, `case`, …).
	let op = unit
		.ops
		.get(f.pc as usize)
		.filter(|op| op.code == Opcode::Exec)?;
	Some((unit.line + end_line(unit, op.node)).saturating_sub(f.line_shift))
}

/// Start the process substitution `<(…)` (`output`: `>(…)`) whose body is
/// at `entry` of `unit`: a child vproc joined to this one by an in-memory
/// pipe on the highest free fd below 64 (bash's `move_to_high_fd`). Returns
/// the word it expands to, `/dev/fd/N`: builtins and redirections reach
/// the pipe through the engine's fd table, externals inherit fd N. The fd
/// closes when the current op's command is over ([`close_procsubs`]).
pub fn start_procsub(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	unit: &Arc<Unit>,
	entry: u32,
	output: bool,
) -> BString {
	let (r, w) = mem::pipe();
	let r = FdRef::mem(r);
	let w = FdRef::mem(w);
	let (mine, theirs, their_fd) = if output { (w, r, 0) } else { (r, w, 1) };
	let fd = (3..64)
		.rev()
		.find(|&fd| vp.fds.get(fd).is_none_or(|h| !h.is_open()))
		.unwrap_or_else(|| vp.fds.lowest_free(64));
	// The child gets the parent's fds before `fd` is set: it must not hold
	// the parent's end (a `>( )` reader would never see end of input).
	let mut fds = vp.fds.clone();
	fds.set(their_fd, Some(theirs));
	// Nor the ends of the substitutions before it (`diff <(a) <(b)`): an
	// external in `b` would get them as extra fds, and the host pumps an
	// in-memory pipe it is handed, so it would drain `a`'s output.
	for &(_, sibling) in &vp.procsubs {
		if sibling != their_fd {
			fds.set(sibling, None);
		}
	}
	let child = vp.child(k, cx.store, Arc::clone(unit), entry, fds);
	let vpid = child.vpid;
	// Not a job: its externals stay in the shell's group, without the
	// terminal.
	super::jobctl::set_leader(k, vpid, None);
	k.emit_op(cx, vp, 0, EventData::Subshell { child: vpid });
	k.spawned.push(Box::new(child));
	vp.fds.set(fd, Some(mine));
	vp.procsubs.push((vp.frames.len() as u32, fd));
	// bash: a process substitution sets `$!` (`wait $!` waits for it).
	vp.last_bg = LastBg::new(vpid);
	BString::from(format!("/dev/fd/{fd}"))
}

/// The op of frame `fi` is over: drop its scratch, close its process
/// substitutions and remove its `=(…)` files.
#[inline]
fn end_op(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc, fi: usize) {
	if let Some(sc) = vp.frames.get_mut(fi).and_then(|f| f.scratch.take()) {
		drop_scratch(&mut k.root, cx.store, vp, sc);
	}
	if !vp.procsubs.is_empty() {
		close_procsubs(vp, fi);
	}
	if vp.zsh.as_ref().is_some_and(|z| !z.tempfiles.is_empty()) {
		remove_tempfiles(cx, vp, fi);
	}
}

/// Remove the files of zsh `=(…)` substitutions made by ops of frames
/// above the first `keep` (their commands are over; zsh `deletefilelist`).
/// The removal is not waited for: a failure is ignored, as zsh's.
fn remove_tempfiles(cx: &mut Cx<'_>, vp: &mut Vproc, keep: usize) {
	let Some(z) = vp.zsh.as_mut() else {
		return;
	};
	let fs = cx.host.fs();
	z.tempfiles.retain(|(depth, path)| {
		let over = *depth as usize > keep;
		if over {
			drop(fs.unlink(BStr::new(path)));
		}
		!over
	});
	vp.trim_zsh();
}

/// Close the process-substitution fds opened by ops of frames above the
/// first `keep` (their commands are over).
pub fn close_procsubs(vp: &mut Vproc, keep: usize) {
	let fds = &mut vp.fds;
	vp.procsubs.retain(|&(depth, fd)| {
		let over = depth as usize > keep;
		if over {
			fds.set(fd, None);
		}
		!over
	});
}

/// If a substitution of this op finished, log its output; `Some` while it
/// is still running.
pub fn settle_sub(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	sc: &mut Scratch,
	slot: Slot,
) -> Option<Flow> {
	let pending = sc.sub.take()?;
	// A math function another expansion of the op called.
	if let PendingSub::Math { slot: theirs, .. } = pending
		&& theirs != slot
	{
		sc.sub = Some(pending);
		return None;
	}
	let (out, status, value) = match pending {
		PendingSub::Fork { vpid, capture } => {
			let Some(status) = k.proc_collect(cx.store, vpid) else {
				sc.sub = Some(PendingSub::Fork { vpid, capture });
				return Some(Flow::Block(WaitKey::Proc(vpid)));
			};
			// zsh's `readoutput` trims the output itself; `=(…)` keeps it.
			(capture.take(), status, vp.mode.dialect() == Dialect::Zsh)
		},
		// `${| ;}` left its `REPLY` in the capture (`pass_reply`).
		PendingSub::NoFork { capture, value } => (capture.take(), vp.status, value),
		// A zsh hook call: its status is logged, the caller's `$?` is back.
		PendingSub::Here { status } => (Vec::new(), std::mem::replace(&mut vp.status, status), true),
		// A math function's value goes with its status.
		PendingSub::Math { status, .. } => {
			let value = vp.zsh.as_ref().and_then(|z| z.last_math);
			let out = super::zsh::arith::encode_last(value);
			(out, std::mem::replace(&mut vp.status, status), true)
		},
	};
	let mut out = out;
	// zsh keeps NUL bytes (metafied in the word).
	if out.contains(&0) && vp.mode.dialect() != Dialect::Zsh {
		out.retain(|&c| c != 0);
		let line = line_of(vp, 0);
		k.diag(cx, vp, line, Diag::Warning {
			msg: "warning: command substitution: ignored null byte in input".into(),
		});
	}
	// `${| ;}` is `REPLY` as is; the output forms lose trailing newlines.
	while !value && out.last() == Some(&b'\n') {
		out.pop();
	}
	sc.logs[slot as usize].push(Atom::Sub { out: BString::from(out), status });
	None
}

/// Whether the last event clock reading stays current across `code`
/// (`Kernel::clock`): control flow, loop bookkeeping and a unit's `End`
/// (popping its frame and scope) take no time worth a reading; `Exec` and a
/// compound's `Enter`/`Leave` read or invalidate it themselves. Every other
/// op (expansions, tests, redirections, spawns) invalidates it.
const fn keeps_clock(code: Opcode) -> bool {
	matches!(
		code,
		Opcode::Nop
			| Opcode::Exec
			| Opcode::Jmp
			| Opcode::BrOk
			| Opcode::BrFail
			| Opcode::Not
			| Opcode::SetStatus
			| Opcode::Enter
			| Opcode::Leave
			| Opcode::LoopEnter
			| Opcode::LoopNote
			| Opcode::LoopBack
			| Opcode::LoopExit
			| Opcode::End
	)
}

/// The flow of an op [`run_slice`] runs without its bookkeeping: a jump,
/// an unreported branch, a loop's entry, iteration note or exit, the
/// entry of a compound command (unless a DEBUG trap may run there) and its
/// successful leave; `None` for any other op, or one whose event is on.
#[inline]
fn control_flow(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &mut Vproc,
	unit: &Arc<Unit>,
	op: Op,
) -> Option<Flow> {
	match op.code {
		Opcode::Nop => Some(Flow::Next),
		Opcode::Jmp => Some(Flow::Jump(op.a)),
		Opcode::BrOk | Opcode::BrFail if !k.mask.any_op(op.ev) => {
			Some(branch(op, (vp.status == 0) == (op.code == Opcode::BrOk)))
		},
		Opcode::LoopNote | Opcode::LoopBack => Some(loop_note(vp, op)),
		Opcode::LoopEnter => Some(loop_enter(vp, op)),
		Opcode::LoopExit if !k.mask.any_op(op.ev) => {
			if let Some(rec) = top_frame(vp).loops.pop() {
				vp.status = rec.status;
			}
			Some(Flow::Next)
		},
		Opcode::Enter if !k.mask.any_op(op.ev) => {
			// `[[ ]]` and `(( ))` start a command: `BASH_COMMAND` and the
			// DEBUG trap point.
			let starts = starts_command(unit, op);
			if starts && pseudo_trap_maybe(k, cx, TrapKey::Debug) {
				return None;
			}
			if starts {
				note_command(vp, unit, op);
			}
			let f = top_frame(vp);
			if starts {
				f.err_reported = false;
			}
			f.enters.push((op.node, 0));
			Some(Flow::Next)
		},
		// A failed one may be an errexit or ERR-trap point.
		Opcode::Leave if !k.mask.any_op(op.ev) && vp.status == 0 => {
			top_frame(vp).enters.pop();
			Some(Flow::Next)
		},
		_ => None,
	}
}

/// `LoopEnter`: a `while`/`until` loop's record.
fn loop_enter(vp: &mut Vproc, op: Op) -> Flow {
	let f = top_frame(vp);
	let depth = depths(f);
	f.loops.push(LoopRec {
		kind: LoopKind::While,
		status: 0,
		iterations: 0,
		exit: op.a,
		cont: op.b,
		depth,
	});
	Flow::Next
}

/// `((…))` (or an arith-`for` expression) of a bash unit with nothing to
/// expand ([`Op::LITERAL`]) or trace, evaluated in place
/// ([`expand::arith_command`]) with the errors mapped as
/// [`Expander::arith_eval`] and [`dispatch`] map them; `None` for any other
/// text, which [`dispatch`] runs through an expander.
fn plain_arith(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	unit: &Unit,
	op: Op,
) -> Option<Flow> {
	if op.b != Op::LITERAL || super::xtrace::on(k, cx, vp) {
		return None;
	}
	let text = &unit.ariths[op.a as usize];
	Some(match expand::arith_command(k, cx, vp, text) {
		Ok(v) => {
			clear_scratch(&mut k.root, cx.store, vp);
			vp.status = i32::from(v == 0);
			Flow::Next
		},
		Err(d @ (Diag::Arith { .. } | Diag::Readonly { .. })) => {
			clear_scratch(&mut k.root, cx.store, vp);
			let d = if matches!(d, Diag::Arith { .. }) {
				d.by("((")
			} else {
				d
			};
			let line = line_of(vp, op.node);
			k.diag(cx, vp, line, d);
			vp.status = 1;
			// `((…))` continues; an arith-for header error leaves the loop
			// (approximated by discarding the command).
			if unit
				.nodes
				.get(op.node as usize)
				.is_some_and(|n| n.kind == NodeKind::ArithFor)
			{
				Flow::Discard(1)
			} else {
				Flow::Next
			}
		},
		Err(d @ Diag::Unbound { .. }) => {
			let line = line_of(vp, op.node);
			stop_flow(k, vp, cx, line, Stop::Fatal(d))
		},
		Err(d) => {
			let line = line_of(vp, op.node);
			stop_flow(k, vp, cx, line, Stop::Fail(d))
		},
	})
}

/// Whether `op` (an `Enter`/`Leave`) brackets a zsh `[[ ]]` traced by
/// `set -x`.
fn zsh_cond_traced(k: &mut Kernel, vp: &Vproc, cx: &mut Cx<'_>, unit: &Unit, op: Op) -> bool {
	unit.mode.dialect() == Dialect::Zsh
		&& unit
			.nodes
			.get(op.node as usize)
			.is_some_and(|n| n.kind == NodeKind::Cond)
		&& super::xtrace::on(k, cx, vp)
}

/// A branch op's flow: to its target when `jump`.
const fn branch(op: Op, jump: bool) -> Flow {
	if jump { Flow::Jump(op.a) } else { Flow::Next }
}

/// `LoopNote`/`LoopBack`: the innermost loop's status and iteration count;
/// `LoopBack` jumps back to the loop's test.
fn loop_note(vp: &mut Vproc, op: Op) -> Flow {
	let status = vp.status;
	if let Some(rec) = top_frame(vp).loops.last_mut() {
		rec.status = status;
		rec.iterations += 1;
	}
	if op.code == Opcode::LoopBack {
		Flow::Jump(op.a)
	} else {
		Flow::Next
	}
}

/// Execute one op.
fn dispatch(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>, unit: &Arc<Unit>, op: Op) -> Flow {
	let line = line_of(vp, op.node);
	match op.code {
		Opcode::Nop => Flow::Next,
		Opcode::Exec => command::exec(k, vp, cx, unit, op, line),
		Opcode::Jmp => Flow::Jump(op.a),
		Opcode::BrOk | Opcode::BrFail => {
			let status = vp.status;
			let jump = (status == 0) == (op.code == Opcode::BrOk);
			if k.mask.any_op(op.ev) {
				let data =
					EventData::Branch { construct: Construct::from_u32(op.b), taken: !jump, status };
				k.emit_op(cx, vp, op.node, data);
			}
			branch(op, jump)
		},
		Opcode::Not => {
			// zsh `evalcond` `COND_NOT`: a `[[ ]]` status 3 (an unknown
			// `-o` option) is not inverted. (Status 2 never gets here: it
			// abandons the command at the primary.)
			vp.status = if vp.status == 3
				&& unit.mode.dialect() == Dialect::Zsh
				&& unit
					.nodes
					.get(op.node as usize)
					.is_some_and(|n| n.kind == NodeKind::Cond)
			{
				3
			} else {
				i32::from(vp.status == 0)
			};
			Flow::Next
		},
		Opcode::SetStatus => {
			vp.status = op.a as i32;
			Flow::Next
		},
		Opcode::Enter => {
			let on = k.mask.any_op(op.ev);
			// The clock only with events on: the `CmdStart` stamp (shared
			// with the previous event when only control flow ran since,
			// `Kernel::stamp`) starts the `CmdEnd` duration.
			let start = if on { k.stamp(cx) } else { 0 };
			top_frame(vp).enters.push((op.node, start));
			if on && let Some(node_kind) = unit.nodes.get(op.node as usize).map(|n| n.kind) {
				k.emit_op_at(cx, vp, op.node, EventData::CmdStart { node_kind }, start);
			}
			// zsh `execcond`: a traced `[[ ]]` is one line, its primaries
			// added as they are evaluated (`zsh::cond`).
			if zsh_cond_traced(k, vp, cx, unit, op) {
				let mut bytes = super::xtrace::ps4(k, cx, vp, line);
				bytes.extend_from_slice(b"[[");
				super::xtrace::write(k, cx, vp, bytes);
			}
			Flow::Next
		},
		Opcode::Leave => {
			if zsh_cond_traced(k, vp, cx, unit, op) {
				super::xtrace::write(k, cx, vp, b" ]]\n".to_vec());
			}
			let t0 = top_frame(vp).enters.pop().map_or(0, |(_, t)| t);
			if k.mask.any_op(op.ev) {
				// One fresh reading for the duration and the event's stamp;
				// what follows may share it.
				let end = k.read_clock(cx);
				let dur_ns = if t0 > 0 { end.saturating_sub(t0) } else { 0 };
				let status = vp.status;
				// Only a pipeline's `CmdEnd` carries `PIPESTATUS` (events golden).
				let pipeline = unit
					.nodes
					.get(op.node as usize)
					.is_some_and(|n| n.kind == NodeKind::Pipeline);
				let pipestatus: &[i32] = if pipeline { &vp.pipestatus } else { &[] };
				let data = EventData::CmdEnd { status, dur_ns, pipestatus };
				k.emit_op_at(cx, vp, op.node, data, end);
			}
			Flow::Next
		},
		Opcode::LoopEnter => loop_enter(vp, op),
		Opcode::ForIn => for_in(k, vp, cx, unit, op, line),
		Opcode::ForNext => for_next(k, vp, cx, op, line),
		Opcode::LoopNote | Opcode::LoopBack => loop_note(vp, op),
		Opcode::LoopExit => {
			if let Some(rec) = top_frame(vp).loops.pop() {
				vp.status = rec.status;
				if k.mask.any_op(op.ev) {
					k.emit_op(cx, vp, op.node, EventData::LoopEnd { iterations: rec.iterations });
				}
			}
			Flow::Next
		},
		Opcode::Redir => match redir::apply(k, vp, cx, unit, op.a, compound_line(vp, line)) {
			Ok(()) => {
				let saves = match top_frame(vp).scratch.take() {
					Some(mut sc) => {
						let saves = sc
							.io
							.as_mut()
							.map_or_default(|io| std::mem::take(&mut io.saved));
						drop_scratch(&mut k.root, cx.store, vp, sc);
						saves
					},
					None => Vec::new(),
				};
				top_frame(vp).redirs.push(saves);
				Flow::Next
			},
			Err(redir::Halt::Flow(f)) => f,
			Err(redir::Halt::Failed) => {
				// The message goes to stderr as the redirections so far left
				// it; what would block is written after the restore.
				let _ = flush_out(k, vp);
				clear_scratch(&mut k.root, cx.store, vp);
				vp.status = 1;
				Flow::Jump(op.b)
			},
		},
		Opcode::PopRedir => {
			if let Some(saves) = top_frame(vp).redirs.pop() {
				restore(vp, saves);
			}
			Flow::Next
		},
		Opcode::Spawn => spawn(k, vp, cx, unit, op),
		Opcode::SubExit => {
			if matches!(top_frame(vp).kind, FrameKind::NoFork | FrameKind::Stage) {
				pop_frame(&mut k.root, cx.store, vp);
			} else {
				// A subshell, pipeline stage or job ends: its EXIT trap runs.
				unwind(&mut k.root, cx.store, vp, 0);
				start_exit_trap_once(k, vp, cx);
			}
			Flow::Call
		},
		Opcode::CaseWord => {
			let w = &unit.words[op.a as usize];
			let subject =
				match expanding(k, vp, cx, Slot::Words, w.parks, line, |ex| ex.scalar(unit, w)) {
					Ok(s) => s,
					Err(flow) => return flow,
				};
			clear_scratch(&mut k.root, cx.store, vp);
			if super::xtrace::on(k, cx, vp) {
				let mut body = b"case ".to_vec();
				body.extend_from_slice(word_source(unit, op.a));
				body.extend_from_slice(b" in");
				super::xtrace::emit(k, cx, vp, line, &body);
			}
			// `$?` stays the previous command's until an arm decides it.
			top_frame(vp).cases.push((subject, false));
			Flow::Next
		},
		Opcode::CaseArm => case_arm(k, vp, cx, unit, op, line),
		Opcode::CaseEnd => {
			top_frame(vp).cases.pop();
			Flow::Next
		},
		Opcode::Arith if unit.mode.dialect() == Dialect::Zsh => zsh_arith(k, vp, cx, unit, op, line),
		Opcode::Arith => {
			let text = &unit.ariths[op.a as usize];
			let arith_for = unit
				.nodes
				.get(op.node as usize)
				.is_some_and(|n| n.kind == NodeKind::ArithFor);
			// One inlined pass (each `<[u8]>::contains` is a call).
			let record = text.iter().any(|&c| c == b'$' || c == b'`');
			let res = expanding(k, vp, cx, Slot::Words, record, line, |ex| {
				// Warnings carry the command's name.
				ex.arith_cmd = Some("((");
				let expanded = ex.expand_text(text)?;
				// bash traces the expanded text before evaluating it (a
				// replay after a parked substitution gets here once).
				if super::xtrace::on(ex.k, ex.cx, ex.vp) {
					trace_arith(ex.k, ex.cx, ex.vp, line, &expanded, arith_for);
				}
				match ex.arith_eval(&expanded) {
					Ok(v) => Ok(Ok(v)),
					// An error in a subscript abandons the line (an expansion
					// failure).
					Err(Stop::Fail(d @ (Diag::Arith { .. } | Diag::Readonly { .. }))) => Ok(Err(d)),
					Err(stop) => Err(stop),
				}
			});
			match res {
				Ok(Ok(v)) => {
					clear_scratch(&mut k.root, cx.store, vp);
					vp.status = i32::from(v == 0);
					Flow::Next
				},
				Ok(Err(d)) => {
					clear_scratch(&mut k.root, cx.store, vp);
					let d = if matches!(d, Diag::Arith { .. }) {
						d.by("((")
					} else {
						d
					};
					k.diag(cx, vp, line, d);
					vp.status = 1;
					// `((…))` continues; an arith-for header error leaves the
					// loop (approximated by discarding the command).
					if unit
						.nodes
						.get(op.node as usize)
						.is_some_and(|n| n.kind == NodeKind::ArithFor)
					{
						Flow::Discard(1)
					} else {
						Flow::Next
					}
				},
				Err(flow) => flow,
			}
		},
		Opcode::CondTest if unit.mode.dialect() == Dialect::Zsh => {
			super::zsh::cond::cond_test(k, vp, cx, unit, op, line)
		},
		Opcode::CondTest => builtins::cond_test(k, vp, cx, unit, op, line),
		Opcode::FuncDef => {
			let f = &unit.funcs[op.a as usize];
			// bash records a definition's line at its end.
			let end = (unit.line + end_line(unit, op.node)).saturating_sub(top_frame(vp).line_shift);
			let line = compound_line(vp, end);
			if op.b != 0 {
				return zsh_funcdef_expanded(k, vp, cx, unit, op, line);
			}
			if special_name(k, vp, cx, &f.name) {
				// POSIX interpretation 383: fatal in a non-interactive shell.
				let msg = format!("`{}': is a special builtin", f.name).into();
				k.diag(cx, vp, line, Diag::Usage { msg });
				return Flow::Exit(2);
			}
			// zsh: defining `TRAPNAL` sets the trap (`localtraps` saves the
			// old one).
			if unit.mode.dialect() == Dialect::Zsh {
				zsh_trap_funcdef(k, cx, vp, &f.name);
				// zsh `execfuncdef`: a definition empties `$_`.
				state::store_record(&mut k.root, cx.store, vp, KeyBuf::Misc(MiscKey::LastArg), None);
			}
			builtins::define_function(k, vp, cx, f, line, op.flags & Op::TRACED != 0)
		},
		Opcode::TimeStart => {
			let mark = time_mark(&*cx.host);
			top_frame(vp).times.push(mark);
			Flow::Next
		},
		Opcode::TimeEnd => {
			let start = top_frame(vp).times.pop().unwrap_or_default();
			time_end(k, vp, cx, unit, op, start, line);
			Flow::Next
		},
		Opcode::Warn => {
			let msg = unit.strs.get(op.a as usize).cloned().unwrap_or_default();
			let diag = if op.flags & Op::SYNTAX != 0 {
				Diag::Syntax { msg }
			} else {
				Diag::Warning { msg }
			};
			let in_eval = matches!(
				vp.frames.last().map(|f| &f.kind),
				Some(FrameKind::Script { what: ScriptKind::Eval, .. })
			);
			let wrap = |d: Diag| {
				if in_eval && op.flags & Op::SYNTAX != 0 {
					Diag::Eval { diag: Box::new(d) }
				} else {
					d
				}
			};
			k.diag(cx, vp, op.b, wrap(diag));
			if op.flags & Op::CONTEXT != 0 {
				// A recovered syntax error: the offending line follows.
				let text = unit
					.strs
					.get(op.a as usize + 1)
					.cloned()
					.unwrap_or_default();
				k.diag(cx, vp, op.b, wrap(Diag::SyntaxContext { text }));
			}
			Flow::Next
		},
		Opcode::Abort => {
			let msg = unit.strs.get(op.a as usize).cloned().unwrap_or_default();
			let diag = if op.flags & Op::SYNTAX != 0 {
				Diag::Syntax { msg }
			} else {
				Diag::Unsupported { what: String::from_utf8_lossy(&msg).into_owned().into() }
			};
			let in_eval = matches!(
				vp.frames.last().map(|f| &f.kind),
				Some(FrameKind::Script { what: ScriptKind::Eval, .. })
			);
			let wrap = |d: Diag| {
				if in_eval {
					Diag::Eval { diag: Box::new(d) }
				} else {
					d
				}
			};
			k.diag(cx, vp, op.node, wrap(diag));
			if op.flags & Op::CONTEXT != 0 {
				let text = unit
					.strs
					.get(op.a as usize + 1)
					.cloned()
					.unwrap_or_default();
				k.diag(cx, vp, op.node, wrap(Diag::SyntaxContext { text }));
			}
			Flow::Abort(op.b as i32)
		},
		Opcode::End => Flow::EndUnit,
		Opcode::Repeat => repeat(k, vp, cx, unit, op, line),
		Opcode::TryEnter => try_enter(vp, op),
		Opcode::AlwaysEnter => always_enter(vp),
		Opcode::AlwaysEnd => always_end(vp),
		Opcode::CallAnon => command::call_anon(k, vp, cx, unit, op, line),
	}
}

/// zsh `execfuncdef` of a definition whose names expand (`function f$$ {
/// … }`, word list `op.b - 1`): the names are expanded (globbed), then
/// each gets the body, its text naming it. An expansion error abandons the
/// definition. Out of line: zsh only.
#[inline(never)]
fn zsh_funcdef_expanded(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	unit: &Arc<Unit>,
	op: Op,
	line: u32,
) -> Flow {
	let words = &unit.lists[op.b as usize - 1];
	let record = words.iter().any(|&w| unit.words[w as usize].parks);
	let res = expanding(k, vp, cx, Slot::Words, record, line, |ex| {
		let mut out = Vec::new();
		let mut globs = Vec::new();
		for &w in words {
			ex.fields_glob(unit, &unit.words[w as usize], &mut out, &mut globs)?;
		}
		Ok((out, globs))
	});
	let (mut names, globs) = match res {
		Ok(v) => v,
		Err(flow) => return flow,
	};
	if !globs.is_empty()
		&& let Err(flow) = super::zsh::zglob::expand_globs(k, vp, cx, &mut names, &globs, line)
	{
		return flow;
	}
	clear_scratch(&mut k.root, cx.store, vp);
	let f = &unit.funcs[op.a as usize];
	vp.status = 0;
	// zsh `execfuncdef`: a definition empties `$_`.
	state::store_record(&mut k.root, cx.store, vp, KeyBuf::Misc(MiscKey::LastArg), None);
	for name in names {
		let one = ir::FuncIr { name, definition: f.definition.clone(), body: f.body.clone() };
		zsh_trap_funcdef(k, cx, vp, &one.name);
		let flow = builtins::define_function(k, vp, cx, &one, line, op.flags & Op::TRACED != 0);
		if !matches!(flow, Flow::Next) {
			return flow;
		}
	}
	Flow::Next
}

/// zsh: defining function `name` (`TRAPNAL`) sets that trap.
#[inline(never)]
fn zsh_trap_funcdef(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc, name: &[u8]) {
	if let Err(err) = builtins::trap::func_changing(k, cx.store, vp, name, true) {
		k.fail(err);
	}
}

/// In posix mode: `name` is a special builtin.
fn special_name(k: &mut Kernel, vp: &Vproc, cx: &mut Cx<'_>, name: &[u8]) -> bool {
	if !state::option(&mut k.root, cx.store, vp, OptId::Posix).unwrap_or(false) {
		return false;
	}
	let rctx = ResolveCtx { has_slash: false, via: Via::Plain };
	matches!(
		cx.host.resolve(BStr::new(name), mode_of(vp), rctx),
		Resolved::Intrinsic(id) if command::is_special(id)
	)
}

/// bash's `time -p` format.
const POSIX_TIMEFORMAT: &[u8] = b"real %2R\nuser %2U\nsys %2S";
/// bash's default `TIMEFORMAT`.
const BASH_TIMEFORMAT: &[u8] = b"\nreal\t%3lR\nuser\t%3lU\nsys\t%3lS";

/// The clock and CPU times now (a host without CPU times counts none).
fn time_mark(host: &dyn crate::bash::host::Host) -> super::proc::TimeMark {
	let cpu = host.cpu_times().unwrap_or_default();
	super::proc::TimeMark {
		real: host.now_ns(),
		user: cpu.user_ns.saturating_add(cpu.child_user_ns),
		sys:  cpu.sys_ns.saturating_add(cpu.child_sys_ns),
	}
}

/// A `time`d pipeline ended (bash's `time_command`): report the times
/// since `start` on stderr in `TIMEFORMAT` (`time -p`: the POSIX format;
/// unset: bash's default; empty: nothing). In posix mode `time` without a
/// pipeline reports the shell's times since it started.
fn time_end(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	unit: &Unit,
	op: Op,
	start: super::proc::TimeMark,
	line: u32,
) {
	let end = time_mark(&*cx.host);
	let pc = vp.frames.last().map_or(0, |f| f.pc as usize);
	let null = time_null(unit, pc, op.node);
	if vp.mode.dialect() == Dialect::Zsh {
		let desc = (!null).then(|| node_text(unit, op.node));
		zsh_time_end(k, vp, cx, desc.as_deref().map(Vec::as_slice), start, end);
		return;
	}
	let posix = null && state::option(&mut k.root, cx.store, vp, OptId::Posix).unwrap_or(false);
	let start = if posix {
		super::proc::TimeMark { real: k.start_ns, user: 0, sys: 0 }
	} else {
		start
	};
	let format = if op.b == 1 {
		BString::from(POSIX_TIMEFORMAT)
	} else {
		match state::lookup(&k.root, cx.store, vp, b"TIMEFORMAT") {
			Ok(Some(v)) => BString::from(v.as_scalar().unwrap_or_default()),
			Ok(None) if posix => BString::from("user\t%2lU\nsys\t%2lS"),
			Ok(None) => BString::from(BASH_TIMEFORMAT),
			Err(err) => {
				k.fail(err);
				return;
			},
		}
	};
	if format.is_empty() {
		return;
	}
	let times = [
		end.real.saturating_sub(start.real),
		end.user.saturating_sub(start.user),
		end.sys.saturating_sub(start.sys),
	];
	match time_report(&format, times) {
		Ok(text) => vp
			.out
			.push_back(PendingWrite { fd: 2, bytes: text.into(), off: 0 }),
		Err(c) => {
			let msg = format!("TIMEFORMAT: `{}': invalid format character", char::from(c));
			k.diag(cx, vp, line, Diag::Usage { msg: msg.into() });
		},
	}
}

/// zsh's `time` report (`dumptime`, `shelltime`): the times of the
/// pipeline written `src` in `$TIMEFMT` (zsh's default when unset) on
/// stderr, `%J` being its text after `time`; `time` alone (`None`)
/// reports the shell's own times since it started (`shell`) and its
/// children's (`children`).
fn zsh_time_end(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	src: Option<&[u8]>,
	start: super::proc::TimeMark,
	end: super::proc::TimeMark,
) {
	let format = match state::lookup(&k.root, cx.store, vp, b"TIMEFMT") {
		Ok(Some(v)) => BString::from(v.as_scalar().unwrap_or_default()),
		Ok(None) => BString::from(ZSH_TIMEFMT),
		Err(err) => {
			k.fail(err);
			return;
		},
	};
	let text = if let Some(src) = src {
		let desc = src.strip_prefix(b"time").unwrap_or(src).trim_ascii_start();
		let times = [
			end.real.saturating_sub(start.real),
			end.user.saturating_sub(start.user),
			end.sys.saturating_sub(start.sys),
		];
		zsh_time_report(&format, desc, times)
	} else {
		let cpu = cx.host.cpu_times().unwrap_or_default();
		let real = end.real.saturating_sub(k.start_ns);
		let mut text = zsh_time_report(&format, b"shell", [real, cpu.user_ns, cpu.sys_ns]);
		let children = [real, cpu.child_user_ns, cpu.child_sys_ns];
		text.extend_from_slice(&zsh_time_report(&format, b"children", children));
		text
	};
	vp.out
		.push_back(PendingWrite { fd: 2, bytes: text.into(), off: 0 });
}

/// zsh's default `TIMEFMT` (`DEFAULT_TIMEFMT`).
const ZSH_TIMEFMT: &[u8] = b"%J  %U user %S system %P cpu %*E total";

/// zsh `printtime`: `format` for job text `desc` and `times` (real, user,
/// system; ns), plus a newline. `%E %U %S` as `0.00s`, `%mE`… in ms,
/// `%uE`… in µs, `%*E`… as `[h:]m:ss.ss` or `s.sss`, `%P` the CPU
/// percentage, `%J` the text, `%%`; resource-usage counts (`%M %F %R %I
/// %O %W %X %D %K %r %s %k %w %c`) are 0 (the host reports none); any
/// other `%c` prints as written.
fn zsh_time_report(format: &[u8], desc: &[u8], times: [u64; 3]) -> Vec<u8> {
	use std::io::Write as _;

	let secs = |ns: u64| ns as f64 / 1e9;
	let (elapsed, user, system) = (secs(times[0]), secs(times[1]), secs(times[2]));
	// zsh's `int percent` (0 for no elapsed time, where C divides by zero).
	let percent = if elapsed > 0.0 {
		(100.0 * (user + system) / elapsed) as i64
	} else {
		0
	};
	let pick = |c: u8| match c {
		b'E' => Some(elapsed),
		b'U' => Some(user),
		b'S' => Some(system),
		_ => None,
	};
	let mut out = Vec::with_capacity(format.len() + 32);
	let mut i = 0;
	while let Some(&c) = format.get(i) {
		i += 1;
		if c != b'%' {
			out.push(c);
			continue;
		}
		let Some(&d) = format.get(i) else {
			break;
		};
		i += 1;
		let w = &mut out;
		let r = match d {
			b'E' | b'U' | b'S' => write!(w, "{:4.2}s", pick(d).unwrap_or_default()),
			b'm' | b'u' | b'*' => match format.get(i).and_then(|&e| pick(e)) {
				Some(t) => {
					i += 1;
					match d {
						b'm' => write!(w, "{:.0}ms", t * 1000.0),
						b'u' => write!(w, "{:.0}us", t * 1_000_000.0),
						_ => print_hhmmss(w, t),
					}
				},
				None => write!(w, "%{}", char::from(d)),
			},
			b'P' => write!(w, "{percent}%"),
			b'W' | b'X' | b'D' | b'K' | b'M' | b'F' | b'R' | b'I' | b'O' | b'r' | b's' | b'k'
			| b'w' | b'c' => write!(w, "0"),
			b'J' => w.write_all(desc),
			b'%' => w.write_all(b"%"),
			_ => {
				w.push(b'%');
				w.push(d);
				Ok(())
			},
		};
		r.expect("writing to a Vec cannot fail");
	}
	out.push(b'\n');
	out
}

/// zsh `printhhmmss`: `h:mm:ss.ss`, `m:ss.ss` or `s.sss`.
fn print_hhmmss(out: &mut Vec<u8>, secs: f64) -> std::io::Result<()> {
	use std::io::Write as _;

	let mins = secs as i64 / 60;
	let hours = mins / 60;
	let secs = secs - (60 * mins) as f64;
	let mins = mins - 60 * hours;
	if hours != 0 {
		write!(out, "{hours}:{mins:02}:{secs:05.2}")
	} else if mins != 0 {
		write!(out, "{mins}:{secs:05.2}")
	} else {
		write!(out, "{secs:.3}")
	}
}

/// Whether the `time` ending at `op` timed no pipeline (`time`, `time !`):
/// only `!` and empty simple commands between its `TimeStart` (same
/// `node`) and `pc`.
fn time_null(unit: &Unit, pc: usize, node: u32) -> bool {
	unit.ops[..pc.min(unit.ops.len())]
		.iter()
		.rev()
		.take_while(|o| !(o.code == Opcode::TimeStart && o.node == node))
		.all(|o| match o.code {
			Opcode::Not => true,
			Opcode::Exec => unit.cmds.get(o.a as usize).is_some_and(|c| {
				c.assigns.is_empty()
					&& c.redirs.is_none()
					&& unit.lists.get(c.words as usize).is_none_or(Vec::is_empty)
			}),
			_ => false,
		})
}

/// bash's `print_formatted_time`: `format` with `%[p][l]R|U|S` (real, user
/// and system time of `times`, ns; `p` digits after the point, default 3;
/// `l` as `MmS.FFs`), `%P` (CPU percentage) and `%%`, plus a newline.
/// `Err` is an invalid format character (nothing is printed).
fn time_report(format: &[u8], times: [u64; 3]) -> Result<Vec<u8>, u8> {
	let mut out = Vec::with_capacity(format.len() + 16);
	let mut i = 0;
	while i < format.len() {
		let c = format[i];
		if c != b'%' || i + 1 == format.len() {
			out.push(c);
			i += 1;
			continue;
		}
		i += 1;
		match format[i] {
			b'%' => out.push(b'%'),
			b'P' => {
				let us = |ns: u64| u128::from(ns / 1000);
				let real = us(times[0]);
				let cpu = ((us(times[1]) + us(times[2])) * 10_000)
					.checked_div(real)
					.unwrap_or(0);
				let cpu = u64::try_from(cpu).unwrap_or(u64::MAX);
				push_time(&mut out, 2, false, cpu / 100, (cpu % 100) * 10_000);
			},
			_ => {
				let mut prec = 3;
				let mut long = false;
				if format[i].is_ascii_digit() {
					prec = usize::from(format[i] - b'0').min(6);
					i += 1;
				}
				if format.get(i) == Some(&b'l') {
					long = true;
					i += 1;
				}
				let ns = match format.get(i) {
					Some(b'R' | b'E') => times[0],
					Some(b'U') => times[1],
					Some(b'S') => times[2],
					Some(&c) => return Err(c),
					None => return Err(0),
				};
				push_time(&mut out, prec, long, ns / 1_000_000_000, (ns % 1_000_000_000) / 1000);
			},
		}
		i += 1;
	}
	out.push(b'\n');
	Ok(out)
}

/// bash's `mkfmt`: `secs` and `micros` with `prec` fraction digits
/// (rounded, without carrying into the seconds, as bash does); `long` as
/// `MmS.FFs`.
fn push_time(out: &mut Vec<u8>, prec: usize, long: bool, mut secs: u64, micros: u64) {
	const PRECS: [u64; 7] = [0, 100_000, 10_000, 1000, 100, 10, 1];
	const MAXVALS: [u64; 7] = [1, 10, 100, 1000, 10_000, 100_000, 1_000_000];
	let mut buf = NumBuffer::new();
	if long {
		out.extend_from_slice((secs / 60).format_into(&mut buf).as_bytes());
		out.push(b'm');
		secs %= 60;
	}
	out.extend_from_slice(secs.format_into(&mut buf).as_bytes());
	if prec > 0 {
		let mut frac = micros;
		if prec < 6 {
			let maxval = MAXVALS[6 - prec];
			let mut f = frac / maxval;
			if frac % maxval >= maxval / 2 {
				f += 1;
			}
			frac = f * (1_000_000 / MAXVALS[prec]);
		}
		out.push(b'.');
		for p in &PRECS[1..=prec] {
			out.push(b'0'.wrapping_add((frac / p) as u8));
			frac %= p;
		}
	}
	if long {
		out.push(b's');
	}
}

fn for_in(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	unit: &Arc<Unit>,
	op: Op,
	line: u32,
) -> Flow {
	let pc = top_frame(vp).pc;
	let exit = unit.ops.get(pc as usize + 1).map_or(pc + 1, |next| next.a);
	let var = unit.names[op.b as usize].clone();
	// The list is evaluated once per loop; it is logged because the op can
	// be re-entered (a comsub, or a glob whose fs answer is pending), so the
	// expansion's side effects run once.
	let record = op.a != Op::POSITIONAL;
	let (mut items, globs, sub) = match expanding(k, vp, cx, Slot::Words, record, line, |ex| {
		let mut globs = Vec::new();
		let items = if op.a == Op::POSITIONAL {
			state::positional(&ex.k.root, ex.cx.store, ex.vp)?
		} else {
			let mut items = Vec::new();
			for &w in &unit.lists[op.a as usize] {
				ex.fields_glob(unit, &unit.words[w as usize], &mut items, &mut globs)?;
			}
			items
		};
		Ok((items, globs, ex.sub_status))
	}) {
		Ok(v) => v,
		Err(flow) => return flow,
	};
	if !globs.is_empty()
		&& let Err(flow) = if unit.mode.dialect() == Dialect::Zsh {
			super::zsh::zglob::expand_globs(k, vp, cx, &mut items, &globs, line)
		} else {
			super::glob::expand_globs(k, vp, cx, &mut items, &globs, line)
		} {
		return flow;
	}
	// zsh `execfor`: the list's substitutions set `$?` for the first pass.
	if let Some(sub) = sub
		&& unit.mode.dialect() == Dialect::Zsh
	{
		vp.status = sub;
	}
	let multi = op.flags & Op::MULTI != 0;
	// zsh `isident`: a positional parameter's number is a name too.
	let zsh = unit.mode.dialect() == Dialect::Zsh;
	// zsh `itype_end(…, IIDENT)`: multibyte letters too, as the parser
	// allowed.
	let wide = zsh && super::zsh::params::wide_idents_in(k, cx.store, vp).unwrap_or(false);
	let name_ok = |n: &[u8]| {
		is_ident(n)
			|| (zsh && !n.is_empty() && n.iter().all(u8::is_ascii_digit))
			|| (wide && super::zsh::params::isident(&crate::bash::syntax::zsh::tok::metafy(n), true))
	};
	let valid = if multi {
		var.split(|&c| c == b'\n').all(name_ok)
	} else {
		name_ok(&var)
	};
	let status = if valid {
		0
	} else {
		// bash checks a `select` name before it sets the line, so the
		// message carries the line in effect: in a function, its body's.
		let select = op.flags & Op::SELECT != 0;
		let shown = match (select, vp.frames.last()) {
			(true, Some(f)) if matches!(f.kind, FrameKind::Function { .. }) => unit
				.ops
				.first()
				.map_or(line, |first| line_of(vp, first.node)),
			_ => line,
		};
		k.diag(cx, vp, shown, Diag::InvalidIdent { name: var.clone() });
		if state::option(&mut k.root, cx.store, vp, OptId::Posix).unwrap_or(false) {
			// Fatal to a posix shell.
			clear_scratch(&mut k.root, cx.store, vp);
			return Flow::Exit(1);
		}
		items.clear();
		1
	};
	clear_scratch(&mut k.root, cx.store, vp);
	// `set -x`: bash shows a `select` header once, a `for` header per word.
	if op.flags & Op::SELECT != 0 && super::xtrace::on(k, cx, vp) {
		let body = loop_header(unit, op);
		super::xtrace::emit(k, cx, vp, line, &body);
	}
	let f = top_frame(vp);
	let depth = depths(f);
	let kind = if op.flags & Op::SELECT != 0 {
		LoopKind::Select { var, items, first: true, more: 0 }
	} else if multi {
		let vars = var.split(|&c| c == b'\n').map(BString::from).collect();
		LoopKind::ForMulti { vars, items, next: 0 }
	} else {
		LoopKind::For { var, items, next: 0 }
	};
	f.loops
		.push(LoopRec { kind, status, iterations: 0, exit, cont: pc + 1, depth });
	Flow::Next
}

fn for_next(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>, op: Op, line: u32) -> Flow {
	let Some(rec) = top_frame(vp).loops.last_mut() else {
		return Flow::Jump(op.a);
	};
	if matches!(rec.kind, LoopKind::Repeat { .. } | LoopKind::ForMulti { .. }) {
		return zsh_next(k, vp, cx, op, line).unwrap_or(Flow::Next);
	}
	let n = rec.iterations + 1;
	let header_pc = rec.cont.checked_sub(1);
	let (var, value) = if matches!(rec.kind, LoopKind::Select { .. }) {
		match builtins::select_next(k, vp, cx, line) {
			Ok(Some(pair)) => pair,
			Ok(None) => return Flow::Jump(op.a),
			Err(flow) => return flow,
		}
	} else {
		match &mut rec.kind {
			LoopKind::For { var, items, next } => {
				let Some(value) = items.get(*next as usize).cloned() else {
					return Flow::Jump(op.a);
				};
				*next += 1;
				(var.clone(), value)
			},
			LoopKind::Select { .. }
			| LoopKind::While
			| LoopKind::Repeat { .. }
			| LoopKind::ForMulti { .. }
			| LoopKind::Try { .. } => return Flow::Next,
		}
	};
	clear_scratch(&mut k.root, cx.store, vp);
	let select = top_frame(vp)
		.loops
		.last()
		.is_some_and(|r| matches!(r.kind, LoopKind::Select { .. }));
	// A `for` variable that is a nameref is retargeted to each word.
	let assigned = if select {
		builtins::assign(k, vp, cx, &var, value.clone(), Level::Dynamic)
	} else if vp.mode.dialect() == crate::bash::ids::Dialect::Zsh {
		builtins::assign_zsh_loop_var(k, vp, cx, &var, &value, line)
	} else {
		builtins::assign_loop_var(k, vp, cx, &var, value.clone())
	};
	if let Err(d) = assigned {
		k.diag(cx, vp, line, d);
		// An assignment error ends a posix shell.
		if state::option(&mut k.root, cx.store, vp, OptId::Posix).unwrap_or(false) {
			return Flow::Exit(1);
		}
		if let Some(rec) = top_frame(vp).loops.last_mut() {
			rec.status = 1;
		}
		return Flow::Jump(op.a);
	}
	if !select && super::xtrace::on(k, cx, vp) {
		let f = top_frame(vp);
		let header = f.unit.as_ref().and_then(|u| {
			let forin = *u.ops.get(header_pc? as usize)?;
			(forin.code == Opcode::ForIn).then(|| loop_header(u, forin))
		});
		if let Some(body) = header {
			super::xtrace::emit(k, cx, vp, line, &body);
		}
	}
	if k.mask.any_op(op.ev) {
		// Bash/select setters emit at their actual commit seam. The zsh
		// parameter setter has separate assignment semantics.
		if !select && vp.mode.dialect() == crate::bash::ids::Dialect::Zsh {
			let scope = assign_scope(vp);
			k.emit_op(cx, vp, op.node, EventData::Assign {
				name: BStr::new(&var),
				value: BStr::new(assign_preview(&value)),
				full_len: value.len(),
				scope,
			});
		}
		k.emit_op(cx, vp, op.node, EventData::IterStart {
			n,
			var: BStr::new(&var),
			value: BStr::new(&value),
		});
	}
	Flow::Next
}

fn case_arm(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	unit: &Arc<Unit>,
	op: Op,
	line: u32,
) -> Flow {
	let pats = &unit.pats[op.a as usize];
	let record = pats.iter().any(|&w| unit.words[w as usize].parks);
	let subject = top_frame(vp).cases.last().map_or_default(|c| c.0.clone());
	let hit = if unit.mode.dialect() == Dialect::Zsh {
		zsh_case_hit(k, vp, cx, unit, pats, &subject, record, line)
	} else {
		bash_case_hit(k, vp, cx, unit, pats, &subject, record, line)
	};
	let hit = match hit {
		Ok(hit) => hit,
		Err(flow) => return flow,
	};
	if k.mask.contains(crate::bash::event::EventKind::Branch) {
		k.emit_op(cx, vp, op.node, EventData::Branch {
			construct: Construct::CaseArm,
			taken:     hit,
			status:    vp.status,
		});
	}
	// bash's `case` is 0 when no arm matches or the matching arm's body is
	// empty (its next op is the arm's terminator jump).
	let next = if hit {
		top_frame(vp).pc as usize + 1
	} else {
		op.b as usize
	};
	let next_code = unit.ops.get(next).map(|o| o.code);
	let f = top_frame(vp);
	let matched = f.cases.last().is_some_and(|c| c.1);
	if hit {
		if let Some(c) = f.cases.last_mut() {
			c.1 = true;
		}
		if next_code == Some(Opcode::Jmp) {
			vp.status = 0;
		}
	} else if !matched && next_code == Some(Opcode::CaseEnd) {
		vp.status = 0;
	}
	if hit { Flow::Next } else { Flow::Jump(op.b) }
}

/// Whether a zsh `case` arm's patterns match `subject` (zsh `execcase`:
/// each pattern substituted and tried in turn, up to the first match).
/// Out of line, off the bash `case` path.
#[inline(never)]
fn zsh_case_hit(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	unit: &Arc<Unit>,
	pats: &[u32],
	subject: &[u8],
	record: bool,
	line: u32,
) -> Result<bool, Flow> {
	let hit = expanding(k, vp, cx, Slot::Words, record, line, |ex| {
		for &w in pats {
			let text = ex.pattern(unit, &unit.words[w as usize])?;
			let prog =
				super::zsh::zpattern::compile(ex, &text, crate::bash::pattern::zsh::PatFlags::NONE)?;
			if super::zsh::zpattern::matches(ex, &prog, subject)? {
				return Ok(true);
			}
		}
		Ok(false)
	})?;
	clear_scratch(&mut k.root, cx.store, vp);
	Ok(hit)
}

/// Whether a bash `case` arm's patterns match `subject`.
fn bash_case_hit(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	unit: &Arc<Unit>,
	pats: &[u32],
	subject: &[u8],
	record: bool,
	line: u32,
) -> Result<bool, Flow> {
	let patterns = expanding(k, vp, cx, Slot::Words, record, line, |ex| {
		let mut out = Vec::with_capacity(pats.len());
		for &w in pats {
			out.push(ex.pattern(unit, &unit.words[w as usize])?);
		}
		Ok(out)
	})?;
	clear_scratch(&mut k.root, cx.store, vp);
	let opts = match (
		state::option(&mut k.root, cx.store, vp, OptId::Extglob),
		state::option(&mut k.root, cx.store, vp, OptId::Nocasematch),
	) {
		(Ok(extglob), Ok(nocase)) => {
			PatOpts::shell(extglob, nocase, super::locale::is_utf8(k, cx.store, vp))
		},
		(Err(e), _) | (_, Err(e)) => {
			k.fail(e);
			return Err(Flow::Discard(1));
		},
	};
	Ok(patterns
		.iter()
		.any(|p| k.engine.patterns().get(p, opts).matches(subject)))
}

/// bash's `subshell_level` step for a pipeline stage or (`background`) an
/// async command starting at `entry`: a `( … )` counts once, at its own
/// `Spawn`; a simple command in a pipeline expands at the parent's level
/// (bash's "not for pipes yet"); anything else is one more.
fn stage_level(unit: &Unit, entry: u32, background: bool) -> u32 {
	let ops = unit.ops.get(entry as usize..).unwrap_or_default();
	let ops = match ops.first() {
		Some(op) if op.code == Opcode::Redir => &ops[1..],
		_ => ops,
	};
	match ops {
		[enter, spawn, ..]
			if enter.code == Opcode::Enter
				&& spawn.code == Opcode::Spawn
				&& unit
					.spawns
					.get(spawn.a as usize)
					.is_some_and(|s| s.kind == SpawnKind::Subshell) =>
		{
			0
		},
		[exec, ..] if exec.code == Opcode::Exec && !background => 0,
		_ => 1,
	}
}

/// Whether the background job whose body starts at `entry` may be known by
/// its program's OS pid ([`Bang`]): its body is one simple command
/// ([`BangStage::Lone`]), or a group that `exec`s one (`{ exec cmd; }`,
/// [`BangStage::Exec`]). Any other compound job keeps its virtual pid at
/// once: its readers never wait.
fn bang_stage(unit: &Unit, entry: u32) -> Option<BangStage> {
	let code = |at: u32| unit.ops.get(at as usize).map(|op| op.code);
	if code(entry) == Some(Opcode::Exec) && code(entry + 1) == Some(Opcode::SubExit) {
		return Some(BangStage::Lone);
	}
	let group = [Opcode::Enter, Opcode::Exec, Opcode::Leave, Opcode::SubExit]
		.iter()
		.zip(entry..)
		.all(|(&want, at)| code(at) == Some(want));
	let exec = unit
		.ops
		.get(entry as usize + 1)
		.and_then(|op| unit.cmds.get(op.a as usize))
		.and_then(|cmd| unit.lists.get(cmd.words as usize))
		.and_then(|words| words.first())
		.and_then(|&w| unit.words.get(w as usize))
		.is_some_and(
			|w| matches!(w.parts.as_slice(), [ir::Part::Lit(name)] if name.as_slice() == b"exec"),
		);
	(group && exec).then_some(BangStage::Exec)
}

/// Source text of stage `i` of pipeline `info`, for a pipe tap: the node of
/// the `SubExit` that ends the stage's code (just before the next stage's
/// entry, or before the pipeline's end).
fn stage_text(unit: &Unit, info: &ir::SpawnIr, i: usize) -> BString {
	let end = info.stages.get(i + 1).map_or(info.end, |next| next.entry);
	end.checked_sub(1)
		.and_then(|pc| unit.ops.get(pc as usize))
		.filter(|op| op.code == Opcode::SubExit)
		.map_or_else(BString::default, |op| node_text(unit, op.node))
}

/// `Spawn`: start children; wait for subshells and pipelines.
fn spawn(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>, unit: &Arc<Unit>, op: Op) -> Flow {
	let info = &unit.spawns[op.a as usize];
	let started = top_frame(vp)
		.scratch
		.as_ref()
		.is_some_and(|s| !s.children.is_empty());
	if !started {
		// A job that forks (a subshell, pipeline, job or coprocess of its
		// own) is not just one program: it keeps its virtual pid.
		if !k.bangs.is_empty() {
			k.settle_bang(vp.vpid, None);
		}
		let mut children = Vec::with_capacity(info.stages.len());
		match info.kind {
			SpawnKind::Subshell | SpawnKind::Background => {
				let mut fds = vp.fds.clone();
				let control = info.kind == SpawnKind::Background && job_control(k, cx, vp);
				// An async command reads `/dev/null` without job control, unless
				// an enclosing compound command redirected stdin (bash
				// `stdin_redir`, `CMD_STDIN_REDIR`)…
				// …or the shell runs as a pipeline element reading a pipe.
				let piped = vp.fds.get(0).is_some_and(|h| {
					h.origin() == crate::bash::fd::FdOrigin::Mem
						&& h.kind() == Some(crate::bash::fs::FileKind::Pipe)
				});
				if info.kind == SpawnKind::Background
					&& !control
					&& !piped
					&& !vp
						.frames
						.iter()
						.any(|f| f.redirs.iter().flatten().any(|s| s.fd == 0))
				{
					let null = k
						.null_input
						.get_or_insert_with(|| FdRef::mem(mem::MemBuf::new(Vec::new())));
					fds.set(0, Some(null.clone()));
				}
				let mut child = vp.child(k, cx.store, Arc::clone(unit), info.stages[0].entry, fds);
				if info.kind == SpawnKind::Background {
					let level = stage_level(unit, info.stages[0].entry, true);
					super::set_subshell_depth(&mut child, super::subshell_depth(vp) + level);
					// A job of its own: its processes get their own group.
					super::jobctl::own_job(k, child.vpid);
				}
				children.push(child.vpid);
				let vpid = child.vpid;
				k.spawned.push(Box::new(child));
				if info.kind == SpawnKind::Background {
					vp.last_bg = LastBg::new(vpid);
					// Known by its program's OS pid if the first command it runs
					// spawns it (bash's subshell `exec`s a lone simple command):
					// readers of the pid wait for that decision.
					if let Some(stage) = bang_stage(unit, info.stages[0].entry) {
						k.bangs.push(Bang { vproc: vpid, job: vpid, stage });
					}
					let job = k.job_id(cx.store);
					// zsh `&|` / `&!`: disowned at once (no job entry).
					if op.flags & Op::DISOWN == 0 {
						let text = job_text(k, cx, vp, unit, op.node);
						let cwd = vp.cwd.clone();
						let number = vp.jobs.add(job, vpid, text, control, cwd);
						if vp.parent.is_none() {
							super::jobctl::started(k, cx, vpid, number);
						}
					}
					k.emit_op(cx, vp, op.node, EventData::Background { job, pid: vpid });
					vp.status = 0;
					return Flow::Jump(info.end);
				}
				k.emit_op(cx, vp, op.node, EventData::Subshell { child: vpid });
			},
			SpawnKind::Coproc { name } => {
				let name = unit.names[name as usize].clone();
				start_coproc(k, vp, cx, unit, op, info.stages[0].entry, name);
				return Flow::Jump(info.end);
			},
			SpawnKind::Pipeline => {
				let n = info.stages.len();
				let tap = cx.host.pipe_tap();
				// `lastpipe` without job control: the last stage runs here. zsh
				// runs it in the current shell but under sh emulation
				// (`execcmd_exec`'s `last1 == 2 && input &&
				// EMULATION(EMULATE_SH)`).
				let lastpipe = if unit.mode.dialect() == Dialect::Zsh {
					vp.mode != ModeId::ZshSh
				} else {
					state::option(&mut k.root, cx.store, vp, OptId::Lastpipe).unwrap_or(false)
						&& !job_control(k, cx, vp)
				};
				let mut stdin = vp.fds.get(0).cloned();
				for (i, stage) in info.stages.iter().enumerate() {
					if lastpipe && i + 1 == n {
						k.emit_op(cx, vp, op.node, EventData::Pipeline { stages: &children });
						let line_shift = top_frame(vp).line_shift;
						let sc = scratch(vp);
						sc.children = children.into_iter().map(|v| (v, None)).collect();
						sc.inline = Some(InlineStage::Running);
						let mut frame = Frame::new(Some(Arc::clone(unit)), stage.entry, FrameKind::Stage);
						frame.line_shift = line_shift;
						let prev = vp.fds.get(0).cloned();
						vp.fds.set(0, stdin.take());
						frame.redirs.push(vec![Saved { fd: 0, prev }]);
						vp.frames.push(frame);
						return Flow::Call;
					}
					let mut fds = vp.fds.clone();
					fds.set(0, stdin.take());
					if i + 1 < n {
						let mirror = tap.as_ref().and_then(|tap| {
							let producer = stage_text(unit, info, i);
							let consumer = stage_text(unit, info, i + 1);
							tap.open(BStr::new(&producer), BStr::new(&consumer))
						});
						let (r, w) = match mirror {
							Some(mirror) => mem::tapped_pipe(mirror),
							None => mem::pipe(),
						};
						let w = FdRef::mem(w);
						fds.set(1, Some(w.clone()));
						if stage.pipe_stderr {
							fds.set(2, Some(w));
						}
						stdin = Some(FdRef::mem(r));
					}
					let mut child = vp.child(k, cx.store, Arc::clone(unit), stage.entry, fds);
					let level = stage_level(unit, stage.entry, false);
					super::set_subshell_depth(&mut child, super::subshell_depth(vp) + level);
					// bash keeps the job list for a `jobs` builtin run as a pipeline
					// stage (`jobs -p | xargs kill`).
					if !vp.jobs.is_empty() && runs_jobs(unit, stage.entry) {
						child.jobs = inherited_jobs(vp, true);
					}
					children.push(child.vpid);
					k.spawned.push(Box::new(child));
				}
				k.emit_op(cx, vp, op.node, EventData::Pipeline { stages: &children });
			},
		}
		scratch(vp).children = children.into_iter().map(|v| (v, None)).collect();
	}
	let status = vp.status;
	let sc = scratch(vp);
	if sc.inline == Some(InlineStage::Running) {
		// Back from the last stage's frame.
		sc.inline = Some(InlineStage::Done(status));
	}
	for (vpid, status) in &mut sc.children {
		if status.is_none() {
			*status = k.proc_collect(cx.store, *vpid);
		}
	}
	if let Some((vpid, _)) = sc.children.iter().find(|(_, s)| s.is_none()) {
		return Flow::Block(WaitKey::Proc(*vpid));
	}
	let mut statuses: Vec<i32> = sc.children.iter().map(|(_, s)| s.unwrap_or(0)).collect();
	if let Some(InlineStage::Done(last)) = sc.inline {
		statuses.push(last);
	}
	clear_scratch(&mut k.root, cx.store, vp);
	if vp.parent.is_none() && k.jobctl.has_pgrp() {
		super::jobctl::fg_done(k, cx, vp, None, b"");
	}
	let pipefail = state::option(&mut k.root, cx.store, vp, OptId::Pipefail).unwrap_or(false);
	vp.status = if pipefail {
		statuses
			.iter()
			.rev()
			.find(|&&s| s != 0)
			.copied()
			.unwrap_or(0)
	} else {
		statuses.last().copied().unwrap_or(0)
	};
	vp.pipestatus = statuses;
	Flow::Jump(info.end)
}

/// Source text of syntax node `node`.
fn node_text(unit: &Unit, node: u32) -> BString {
	unit
		.nodes
		.get(node as usize)
		.and_then(|n| unit.source.get(n.lo as usize..n.hi as usize))
		.map_or_else(BString::default, BString::from)
}

/// The command of a job at `node` as bash prints it (`jobs`, `fg`, `bg`):
/// re-printed by bash's `make_command_string` (`( sleep 2; exit 4 )`, a
/// `while` body indented on its own lines), or as written when the text
/// does not parse alone. A zsh unit's job shows zsh's `getjobtext`
/// (`{ sleep 1; echo; }`, `f () { ... }`).
pub(super) fn job_text(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &Vproc,
	unit: &Unit,
	node: u32,
) -> BString {
	let src = node_text(unit, node);
	let feat = features(k, cx.store, vp).unwrap_or(Features::NONE);
	if unit.mode.dialect() == Dialect::Zsh {
		let feat = feat | Features::ZSH;
		return match crate::bash::syntax::parse_all(&src, feat) {
			Ok(p) if p.commands.len() == 1 => {
				BString::from(crate::bash::syntax::zsh::getjobtext(p.commands[0].list()))
			},
			_ => src,
		};
	}
	match crate::bash::syntax::parse_all(&src, feat) {
		Ok(p) if p.commands.len() == 1 => {
			BString::from(crate::bash::syntax::command_string(p.commands[0].list()))
		},
		_ => src,
	}
}

/// Whether job control is active in `vp` (bash `job_control`): `set -m`,
/// outside forked subshells. Decides job flags, async stdin and `lastpipe`.
pub fn job_control(k: &mut Kernel, cx: &mut Cx<'_>, vp: &Vproc) -> bool {
	!vp.jobs.subshell && state::option(&mut k.root, cx.store, vp, OptId::Monitor).unwrap_or(false)
}

/// The job table a child that lists its parent's jobs starts with (a
/// command substitution, a `jobs` pipeline stage): copies of them, which
/// are not its children; `subshell` turns job control off.
pub(super) fn inherited_jobs(vp: &Vproc, subshell: bool) -> super::proc::JobTable {
	let mut jobs = vp.jobs.clone();
	jobs.chld = 0;
	jobs.subshell = subshell;
	for job in &mut jobs.list {
		job.inherited = true;
	}
	jobs
}

/// Whether the pipeline stage starting at `entry` is a simple command
/// named `jobs` (bash keeps the job list only for that builtin).
fn runs_jobs(unit: &Unit, entry: u32) -> bool {
	let Some(op) = unit.ops.get(entry as usize) else {
		return false;
	};
	let text = node_text(unit, op.node);
	text.strip_prefix(b"jobs").is_some_and(|rest| {
		rest
			.first()
			.is_none_or(|c| matches!(c, b' ' | b'\t' | b'\n' | b';' | b'|'))
	})
}

/// `coproc NAME cmd`: run the body at `entry` as a background child whose
/// stdout the shell reads from `NAME[0]` and whose stdin it writes to
/// `NAME[1]`; `NAME_PID` and `$!` are its pid. As bash's `sh_openpipe`,
/// both pipes take the highest free fds below 64 in turn (the shell keeps
/// the first and the last).
fn start_coproc(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	unit: &Arc<Unit>,
	op: Op,
	entry: u32,
	name: BString,
) {
	let mut taken: Vec<i32> = Vec::with_capacity(4);
	while taken.len() < 4 {
		let fd = (3..64)
			.rev()
			.find(|fd| !taken.contains(fd) && vp.fds.get(*fd).is_none_or(|h| !h.is_open()))
			.unwrap_or_else(|| vp.fds.lowest_free(64) + taken.len() as i32);
		taken.push(fd);
	}
	let (read, write) = (taken[0], taken[3]);
	let (out_r, out_w) = mem::pipe();
	let (in_r, in_w) = mem::pipe();
	// The child gets the shell's fds before its ends are set: it holds
	// neither (`NAME[1]`'s reader would never see end of input).
	let mut fds = vp.fds.clone();
	fds.set(0, Some(FdRef::mem(in_r)));
	fds.set(1, Some(FdRef::mem(out_w)));
	let child = vp.child(k, cx.store, Arc::clone(unit), entry, fds);
	// A job of its own under job control (never in the foreground).
	super::jobctl::own_job(k, child.vpid);
	let vpid = child.vpid;
	k.spawned.push(Box::new(child));
	vp.fds.set(read, Some(FdRef::mem(out_r)));
	vp.fds.set(write, Some(FdRef::mem(in_w)));
	vp.last_bg = LastBg::new(vpid);
	let job = k.job_id(cx.store);
	let text = job_text(k, cx, vp, unit, op.node);
	let control = job_control(k, cx, vp);
	let cwd = vp.cwd.clone();
	vp.jobs.add(job, vpid, text, control, cwd);
	k.emit_op(cx, vp, op.node, EventData::Background { job, pid: vpid });
	let line = line_of(vp, op.node);
	let fds = AssignValue::Array(vec![
		(None, false, BString::from(read.to_string())),
		(None, false, BString::from(write.to_string())),
	]);
	let mut pid_name = name.clone();
	pid_name.extend_from_slice(b"_PID");
	let pid = AssignValue::Scalar(BString::from(vpid.0.to_string()));
	for (var, value) in [(&name, fds), (&pid_name, pid)] {
		let diag = if is_ident(var) {
			let lhs = builtins::Lhs { name: var, index: None, append: false };
			builtins::set_value(k, cx, vp, lhs, value, Level::Dynamic).err()
		} else {
			Some(Diag::InvalidIdent { name: var.clone() })
		};
		if let Some(d) = diag {
			k.diag(cx, vp, line, d);
			// bash's coproc_setvars returns at the first failure: no NAME_PID.
			break;
		}
	}
	vp.coprocs.push(Coproc { vpid, name, read, write });
	vp.status = 0;
}

/// The coprocess `waited` (whose status `wait` just took): unset `NAME`
/// and `NAME_PID` and close the shell's ends, as bash does when it reaps
/// one. (bash reaps at its next child notification; the engine does so
/// when the coprocess is waited for, so its variables stay usable until
/// then.)
pub fn reap_coproc(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>, waited: Vpid) {
	let mut i = 0;
	while i < vp.coprocs.len() {
		if vp.coprocs[i].vpid != waited {
			i += 1;
			continue;
		}
		let co = vp.coprocs.remove(i);
		vp.fds.set(co.read, None);
		vp.fds.set(co.write, None);
		let mut pid_name = co.name.clone();
		pid_name.extend_from_slice(b"_PID");
		// bash's `coproc_unsetvars`: nothing for an invalid name;
		// `NAME_PID` itself goes, readonly or not (`unbind_variable_noref`);
		// `NAME` is unset through a reference, refusing a readonly one.
		if !is_ident(&co.name) {
			continue;
		}
		state::store_var(&mut k.root, cx.store, vp, &pid_name, None, Level::Dynamic);
		let var = match state::deref(&k.root, cx.store, vp, &co.name) {
			Ok(state::Deref::To { name, index: None }) => name,
			_ => co.name,
		};
		let readonly = state::lookup_declared(&k.root, cx.store, vp, &var)
			.ok()
			.flatten()
			.is_some_and(|v| v.attrs.contains(Attrs::READONLY));
		if readonly {
			let line = current_line(vp);
			k.diag(cx, vp, line, Diag::Usage {
				msg: format!("{}: cannot unset: readonly variable", var.as_bstr()).into(),
			});
		} else {
			state::store_var(&mut k.root, cx.store, vp, &var, None, Level::Dynamic);
		}
	}
}

/// A redirection closed or moved away shell fd `fd`: if it was a
/// coprocess's end, `NAME[0]`/`NAME[1]` becomes -1 (bash `coproc_checkfd`).
pub fn coproc_fd_closed(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>, fd: i32) {
	let mut hits = Vec::new();
	for co in &mut vp.coprocs {
		if co.read == fd {
			co.read = -1;
			hits.push((co.name.clone(), b"0"));
		}
		if co.write == fd {
			co.write = -1;
			hits.push((co.name.clone(), b"1"));
		}
	}
	for (name, index) in hits {
		let lhs = builtins::Lhs { name: &name, index: Some(&index[..]), append: false };
		let value = AssignValue::Scalar(BString::from("-1"));
		if let Err(d) = builtins::set_value(k, cx, vp, lhs, value, Level::Dynamic) {
			let line = current_line(vp);
			k.diag(cx, vp, line, d);
		}
	}
}

/// `set -x` for `(( … ))` and an arith-for expression: `(( text ))` of the
/// expanded text (an arith-for one without its leading blanks, `1` when
/// empty).
/// Source text of word `w` of `unit` (bash's `set -x` shows compound
/// command headers and compound assignment values unexpanded; also
/// `command::trace`).
pub fn word_source(unit: &Unit, w: u32) -> &[u8] {
	unit
		.words
		.get(w as usize)
		.and_then(|word| unit.nodes.get(word.node as usize))
		.and_then(|n| unit.source.get(n.lo as usize..n.hi as usize))
		.unwrap_or_default()
}

/// `for NAME in WORDS` / `select NAME in WORDS` of a `ForIn` op, as `set -x`
/// shows it (`"$@"` without a list).
fn loop_header(unit: &Unit, forin: Op) -> Vec<u8> {
	let mut body = Vec::new();
	body.extend_from_slice(if forin.flags & Op::SELECT != 0 {
		b"select "
	} else {
		b"for "
	});
	body.extend_from_slice(
		unit
			.names
			.get(forin.b as usize)
			.map_or_default(|n| n.as_slice()),
	);
	body.extend_from_slice(b" in");
	if forin.a == Op::POSITIONAL {
		body.extend_from_slice(b" \"$@\"");
	} else if let Some(list) = unit.lists.get(forin.a as usize) {
		for &w in list {
			body.push(b' ');
			body.extend_from_slice(word_source(unit, w));
		}
	}
	body
}

fn trace_arith(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &mut Vproc,
	line: u32,
	text: &[u8],
	arith_for: bool,
) {
	let text = if arith_for {
		let t = text.trim_ascii_start();
		if t.is_empty() { b"1".as_slice() } else { t }
	} else {
		text
	};
	let mut body = Vec::with_capacity(text.len() + 6);
	body.extend_from_slice(b"(( ");
	body.extend_from_slice(text);
	body.extend_from_slice(b" ))");
	super::xtrace::emit(k, cx, vp, line, &body);
}

/// Line of the op at the top frame's pc (for diagnostics raised outside an
/// op's own handler).
pub fn current_line(vp: &Vproc) -> u32 {
	vp.frames.last().map_or(0, |f| {
		f.unit
			.as_ref()
			.and_then(|u| u.ops.get(f.pc as usize))
			.map_or(0, |op| line_of(vp, op.node))
	})
}

/// The vproc's current mode: what its code parses and runs in.
pub const fn mode_of(vp: &Vproc) -> ModeId {
	vp.mode
}

/// zsh `execlist`'s DEBUG trap at the list marker `op` (a `Nop`): before
/// the list under `DEBUG_BEFORE_CMD` (the default), after it otherwise;
/// never inside a trap. `ERR_EXIT` is off while it runs (set by the trap,
/// the list is skipped, [`zsh_debug_done`]); before the list
/// `$ZSH_DEBUG_CMD` holds its text. Whether the trap started.
fn zsh_debug_trap(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>, unit: &Unit, op: Op) -> bool {
	if vp.trap_frames != 0 || !pseudo_trap_maybe(k, cx, TrapKey::Debug) {
		return false;
	}
	let opt = |k: &mut Kernel, cx: &mut Cx<'_>, vp: &Vproc, o| {
		state::zsh_option(&mut k.root, cx.store, vp, o).unwrap_or_else(|err| {
			k.fail(err);
			false
		})
	};
	let before = opt(k, cx, vp, ZshOpt::Debugbeforecmd);
	if (op.b == Op::LIST_START) != before {
		return false;
	}
	let errexit = opt(k, cx, vp, ZshOpt::Errexit);
	if errexit
		&& let Err(err) = state::set_zsh_option(&mut k.root, cx.store, vp, ZshOpt::Errexit, false)
	{
		k.fail(err);
	}
	let line = line_of(vp, op.node);
	let frame = top_frame(vp);
	frame.debug_pc = Some(frame.pc);
	frame.debug_errexit = errexit;
	if !start_trap(k, vp, cx, TrapKey::Debug) {
		if errexit
			&& let Err(err) = state::set_zsh_option(&mut k.root, cx.store, vp, ZshOpt::Errexit, true)
		{
			k.fail(err);
		}
		return false;
	}
	set_trap_line(vp, line);
	if before {
		// In the trap's own scope: gone when it ends (zsh unsets it).
		let text = unit
			.nodes
			.get(op.node as usize)
			.and_then(|n| unit.source.get(n.lo as usize..n.hi as usize))
			.and_then(crate::bash::syntax::zsh::list_text)
			.unwrap_or_default();
		if let Some(top) = state::scope_count(&k.root, vp).checked_sub(1) {
			let var = Var::scalar(BString::from(text), Attrs::NONE);
			state::scope_set(&mut k.root, cx.store, vp, top, b"ZSH_DEBUG_CMD", Some(var));
		}
	}
	true
}

/// After a zsh DEBUG trap started at a list marker ([`zsh_debug_trap`]):
/// `ERR_EXIT` comes back; turned on by the trap before a list, the list is
/// skipped.
fn zsh_debug_done(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>) {
	let f = top_frame(vp);
	let Some(op) = f
		.debug_pc
		.filter(|&pc| pc == f.pc)
		.and_then(|pc| f.unit.as_ref()?.ops.get(pc as usize).copied())
		.filter(|op| op.code == Opcode::Nop && op.b != 0)
	else {
		return;
	};
	let saved = f.debug_errexit;
	let now = state::zsh_option(&mut k.root, cx.store, vp, ZshOpt::Errexit).unwrap_or(false);
	if now != saved
		&& let Err(err) = state::set_zsh_option(&mut k.root, cx.store, vp, ZshOpt::Errexit, saved)
	{
		k.fail(err);
	}
	if op.b == Op::LIST_START && now {
		top_frame(vp).pc = op.a;
	}
}

/// Run a configured trap in the interrupted shell, without re-entering it.
pub fn start_trap(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>, key: TrapKey) -> bool {
	// A subshell lists its parent's EXIT trap but runs only its own.
	if key == TrapKey::Exit && vp.parent.is_some() && !vp.own_traps.has(key) {
		return false;
	}
	// The check before every command (DEBUG) and function return (RETURN):
	// no action set anywhere, nothing to decide (xeon profile: `start_trap`
	// ~1 % self on func, plus its store lookups in `state::record`).
	if !pseudo_trap_maybe(k, cx, key) {
		return false;
	}
	// zsh has no `errtrace`/`functrace`: its ZERR and DEBUG traps run in
	// every function (`localtraps` scopes them instead).
	if matches!(key, TrapKey::Debug | TrapKey::Err | TrapKey::Return)
		&& vp.mode.dialect() == Dialect::Bash
	{
		// The innermost function (for DEBUG also `.` file) decides: a trap
		// it set itself runs, an inherited one only under `functrace` /
		// `errtrace` (or the function's trace attribute, set as local).
		let local = vp.frames.iter().rev().find_map(|frame| match frame.kind {
			FrameKind::Function { .. } => Some(match key {
				TrapKey::Debug => frame.debug_trap_local,
				TrapKey::Err => frame.err_trap_local,
				TrapKey::Return => frame.return_trap_local,
				_ => unreachable!(),
			}),
			FrameKind::Script { what: ScriptKind::Source, .. } if key == TrapKey::Debug => {
				Some(frame.debug_trap_local)
			},
			_ => None,
		});
		let child_inherited = vp.parent.is_some() && !vp.own_traps.has(key);
		if (local == Some(false) || child_inherited) && !local.unwrap_or(false) {
			let opt = if key == TrapKey::Err {
				OptId::Errtrace
			} else {
				OptId::Functrace
			};
			match state::option(&mut k.root, cx.store, vp, opt) {
				Ok(true) => {},
				Ok(false) => return false,
				Err(err) => {
					k.fail(err);
					return false;
				},
			}
		}
	}
	// No trap runs inside its own action; a function called from the
	// DEBUG trap loses the RETURN trap (bash's `execute_function`).
	if vp.trap_frames != 0
		&& vp.frames.iter().any(|f| {
			matches!(f.kind,
		FrameKind::Script { what: ScriptKind::Trap { key: active, .. }, .. }
			if active == key || (key == TrapKey::Return && active == TrapKey::Debug))
		}) {
		return false;
	}
	let (action, trap_mode) = match state::record(cx.store, vp, Key::Trap(key)) {
		Ok(Some(Record::Trap { action, mode })) if !action.is_empty() => (action.clone(), *mode),
		// zsh: a `TRAPNAL` function is the trap (zsh `ZSIG_FUNC`).
		Ok(None) if vp.mode.dialect() == Dialect::Zsh => return start_func_trap(k, vp, cx, key),
		Ok(_) => return false,
		Err(err) => {
			k.fail(err);
			return false;
		},
	};
	let started = push_trap(k, vp, cx, key, &action, trap_mode);
	if started && key == TrapKey::Exit && vp.parent.is_none() && !vp.runs.is_empty() {
		// A root run is a shell invocation: consume its EXIT trap when it
		// fires, rather than carrying it into the next invocation.
		state::store_record(&mut k.root, cx.store, vp, KeyBuf::Trap(key), None);
	}
	started
}

/// Push the frame of trap `key` running `action` set in `trap_mode`
/// (empty for a zsh `TRAPNAL` function, whose call goes on top of it):
/// `BASH_TRAPSIG`, the interrupted status, the mode switch. Shared by
/// [`start_trap`] and zsh's function `EXIT` traps.
fn push_trap(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	key: TrapKey,
	action: &[u8],
	trap_mode: ModeId,
) -> bool {
	// A trap runs in the mode of the code that set it; the
	// interrupted code's mode and options come back after it.
	let restore = if trap_mode == vp.mode {
		None
	} else {
		match super::mode::save_for_emulate(&mut k.root, cx.store, vp) {
			Ok(saved) => Some(saved),
			Err(err) => {
				k.fail(err);
				return false;
			},
		}
	};
	let platform = k.engine.config().platform;
	let pseudo_base = if platform == crate::bash::Platform::MacOs {
		32
	} else {
		65
	};
	let number = match key {
		TrapKey::Signal(sig) => sig.number(platform),
		TrapKey::Exit => 0,
		TrapKey::Debug => pseudo_base,
		TrapKey::Err => pseudo_base + 1,
		TrapKey::Return => pseudo_base + 2,
	};
	let attrs = match state::lookup(&k.root, cx.store, vp, b"BASH_TRAPSIG") {
		Ok(var) => var.map_or(Attrs::NONE, |var| var.attrs),
		Err(err) => {
			k.fail(err);
			return false;
		},
	};
	let mut scope = state::Scope::default();
	scope.vars.insert(
		BString::from("BASH_TRAPSIG"),
		Some(Var::scalar(number.format_into(&mut NumBuffer::new()), attrs)),
	);
	state::push_scope(&mut k.root, cx.store, vp, scope);
	let status = vp.status;
	vp.blocked = None;
	push_script(vp, action, 1, ScriptKind::Trap {
		key,
		status,
		cancel: None,
		return_target: None,
		exit: false,
	});
	if let Some(saved) = restore {
		super::mode::set_mode(&mut k.root, cx.store, vp, trap_mode);
		vp.push_restore(*saved);
	}
	k.emit_op(cx, vp, 0, EventData::Trap { trap: key });
	true
}

/// Which of the DEBUG, ERR and RETURN traps may have an action somewhere
/// (the store or a vproc's overlay). [`start_trap`] asks
/// before each command and each function return; with no such trap set
/// (the common case) it answers without frame scans, option reads or
/// store lookups. Bits are only ever set: `trap` sets the key's bit when
/// it installs an action, a restore sets all (restored overlays), and the
/// store's own records are read once per store epoch. A trap reset
/// later keeps its bit; the full check then decides, as before.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PseudoTraps {
	/// `1 << n` per key ([`Self::bit`]).
	bits:  u8,
	/// The store epoch ([`Root::epoch`]) whose records were read; `None`:
	/// not yet.
	epoch: Option<u64>,
}

impl PseudoTraps {
	const fn bit(key: TrapKey) -> u8 {
		match key {
			TrapKey::Debug => 1,
			TrapKey::Err => 2,
			TrapKey::Return => 4,
			TrapKey::Exit | TrapKey::Signal(_) => 0,
		}
	}

	/// `trap` installed an action for `key` (in the root or an overlay).
	pub const fn note(&mut self, key: TrapKey) {
		self.bits |= Self::bit(key);
	}

	/// Any pseudo-trap may be set (restored overlays are not inspected).
	pub const fn note_all(&mut self) {
		self.bits = 7;
	}
}

/// Whether `key` may have an action: always for EXIT and signals; for
/// DEBUG/ERR/RETURN per [`PseudoTraps`]. A store read error answers yes
/// (the full check reports it).
#[inline]
fn pseudo_trap_maybe(k: &mut Kernel, cx: &mut Cx<'_>, key: TrapKey) -> bool {
	let bit = PseudoTraps::bit(key);
	if bit == 0 || k.pseudo_traps.bits & bit != 0 {
		return true;
	}
	if k.pseudo_traps.epoch != Some(k.root.epoch()) {
		note_pseudo_traps(k, cx);
	}
	k.pseudo_traps.bits & bit != 0
}

/// Read which pseudo-traps the store holds into [`PseudoTraps`], at the
/// store's current epoch.
#[inline(never)]
fn note_pseudo_traps(k: &mut Kernel, cx: &mut Cx<'_>) {
	k.pseudo_traps.epoch = Some(k.root.epoch());
	for pseudo in [TrapKey::Debug, TrapKey::Err, TrapKey::Return] {
		let set = match cx.store.get(Key::Trap(pseudo)) {
			Ok(Some(Record::Trap { action, .. })) => !action.is_empty(),
			Ok(_) => false,
			Err(_) => true,
		};
		if set {
			k.pseudo_traps.note(pseudo);
		}
	}
}

/// [`Frame::debug_pc`] of a function frame whose DEBUG trap at entry is
/// running: under `extdebug` a failing trap skips the whole body.
pub const ENTRY_DEBUG: u32 = u32::MAX;

/// Start the RETURN trap of function or `.` frame `target`, the frames
/// above it to unwind when it ends. Its `$LINENO` is the function body's
/// line, or the line of the `.` command, whose level of the call-stack
/// arrays has already ended (bash runs it after `_evalfile`). `false` when
/// no trap runs.
fn return_trap(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>, target: usize) -> bool {
	let body = match &vp.frames[target] {
		Frame { kind: FrameKind::Function { .. }, unit: Some(unit), .. } => {
			Some(super::callstack::body_line(unit))
		},
		_ => None,
	};
	let line = body.or_else(|| {
		let line = super::callstack::source_line(vp, target + 1);
		super::callstack::truncate(&mut k.root, cx.store, vp, target);
		line
	});
	if !start_trap(k, vp, cx, TrapKey::Return) {
		return false;
	}
	if let Some(line) = line {
		set_trap_line(vp, line);
	}
	mark_return(vp, target);
	true
}

fn mark_return(vp: &mut Vproc, target: usize) {
	if let Some(Frame {
		kind: FrameKind::Script { what: ScriptKind::Trap { return_target, .. }, .. },
		..
	}) = vp.frames.last_mut()
	{
		*return_target = Some(target);
	}
}

/// Mark a freshly started trap as the last action of a cancellation.
pub fn mark_cancel(vp: &mut Vproc, status: i32) {
	if let Some(Frame {
		kind: FrameKind::Script { what: ScriptKind::Trap { cancel, .. }, .. },
		..
	}) = vp.frames.last_mut()
	{
		*cancel = Some(status);
	}
}

/// End a cancelled vproc (after its signal trap, or at once when it has
/// none; `Shell::apply_requests`): unwind everything with `status`. The
/// started run still runs its EXIT trap, as bash does when a signal ends
/// the shell; scripts queued behind it end unstarted.
pub fn finish_cancel(root: &mut Root, store: &mut dyn StateStore, vp: &mut Vproc, status: i32) {
	unwind(root, store, vp, 0);
	vp.status = status;
	vp.blocked = None;
	for (i, run) in vp.runs.iter_mut().enumerate() {
		if i > 0 || !run.started {
			run.started = true;
			run.exit_trap_started = true;
		}
	}
}

/// Push a script frame running `src` (`eval`, `source`).
pub fn push_script(vp: &mut Vproc, src: &[u8], line: u32, what: ScriptKind) {
	if matches!(what, ScriptKind::Trap { .. }) {
		vp.trap_frames += 1;
	}
	vp.frames
		.push(Frame::new(None, 0, FrameKind::script(src, Pos { offset: 0, line }, what)));
}

// zsh control flow (zsh-dialect units only). Ported from zsh 5.9 (MIT-style
// licence, Copyright (c) 1992-1997 Paul Falstad and the zsh development
// group): `loop.c` `execrepeat`/`exectry`/`execfor`, `exec.c`
// `doshfunc`'s return and exit handling, `builtin.c` `bin_break`,
// `signals.c` `endtrapscope`/`dotrapargs`.

/// zsh `execrepeat`: expand the count word once and evaluate it
/// arithmetically; `$?` is 0 before the first pass (`repeat 0` resets it).
#[inline(never)]
fn repeat(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	unit: &Arc<Unit>,
	op: Op,
	line: u32,
) -> Flow {
	let pc = top_frame(vp).pc;
	let exit = unit.ops.get(pc as usize + 1).map_or(pc + 1, |next| next.a);
	let w = &unit.words[op.a as usize];
	let count = match expanding(k, vp, cx, Slot::Words, true, line, |ex| {
		let text = ex.scalar(unit, w)?;
		super::zsh::arith::mathevali(ex, &text)
	}) {
		Ok(n) => n,
		Err(flow) => return flow,
	};
	clear_scratch(&mut k.root, cx.store, vp);
	vp.status = 0;
	let f = top_frame(vp);
	let depth = depths(f);
	f.loops.push(LoopRec {
		kind: LoopKind::Repeat { left: count },
		status: 0,
		iterations: 0,
		exit,
		cont: pc + 1,
		depth,
	});
	Flow::Next
}

/// zsh `execarith` (`((…))` and the arithmetic `for` header): the token
/// text substituted, then evaluated by zsh's math; `$?` is 0 for a
/// non-zero value, 1 for zero, 2 after an error (reported, the line goes
/// on: zsh clears `ERRFLAG_ERROR`).
#[inline(never)]
fn zsh_arith(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	unit: &Arc<Unit>,
	op: Op,
	line: u32,
) -> Flow {
	let text = &unit.ariths[op.a as usize];
	let record = crate::bash::syntax::zsh::tok::has_token(text);
	let res = expanding(k, vp, cx, Slot::Words, record, line, |ex| match ex.zsh_arith(text) {
		Ok(v) => Ok(Ok(v)),
		Err(Stop::Fail(d)) => Ok(Err(d)),
		Err(stop) => Err(stop),
	});
	match res {
		Ok(v) => {
			clear_scratch(&mut k.root, cx.store, vp);
			vp.status = match v {
				Ok(super::zsh::math::Number::Int(i)) => i32::from(i == 0),
				Ok(super::zsh::math::Number::Float(f)) => i32::from(f == 0.0),
				Err(d) => {
					k.diag(cx, vp, line, d);
					2
				},
			};
			Flow::Next
		},
		Err(flow) => flow,
	}
}

/// `ForNext` of a zsh `repeat` (count a pass) or a zsh `for a b … in`
/// (zsh `execfor`: each variable takes the next word, missing ones are
/// empty); `None` for the other loops.
#[inline(never)]
fn zsh_next(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>, op: Op, line: u32) -> Option<Flow> {
	let rec = top_frame(vp).loops.last_mut()?;
	match &mut rec.kind {
		LoopKind::Repeat { left } => {
			if *left <= 0 {
				return Some(Flow::Jump(op.a));
			}
			*left -= 1;
			Some(Flow::Next)
		},
		LoopKind::ForMulti { vars, items, next } => {
			let start = *next as usize;
			if start >= items.len() {
				return Some(Flow::Jump(op.a));
			}
			*next = u32::try_from(start + vars.len()).unwrap_or(u32::MAX);
			let pairs: Vec<(BString, BString)> = vars
				.iter()
				.enumerate()
				.map(|(i, v)| (v.clone(), items.get(start + i).cloned().unwrap_or_default()))
				.collect();
			clear_scratch(&mut k.root, cx.store, vp);
			for (var, value) in pairs {
				if let Err(d) = builtins::assign_zsh_loop_var(k, vp, cx, &var, &value, line) {
					k.diag(cx, vp, line, d);
					if let Some(rec) = top_frame(vp).loops.last_mut() {
						rec.status = 1;
					}
					return Some(Flow::Jump(op.a));
				}
			}
			Some(Flow::Next)
		},
		_ => None,
	}
}

/// zsh `exectry` starts the try-list `op` opens: a try record (`op.a` is
/// the pc of the always-list, `op.b` the pc after it).
#[inline(never)]
fn try_enter(vp: &mut Vproc, op: Op) -> Flow {
	let f = top_frame(vp);
	let depth = depths(f);
	f.loops.push(LoopRec {
		kind: LoopKind::Try { always: false, pending: None },
		status: 0,
		iterations: 0,
		exit: op.a,
		cont: op.b,
		depth,
	});
	Flow::Next
}

/// zsh `exectry` reaches the always-list: the try-list's status is kept
/// for after it.
#[inline(never)]
fn always_enter(vp: &mut Vproc) -> Flow {
	let status = vp.status;
	if let Some(rec) = top_frame(vp).loops.last_mut()
		&& let LoopKind::Try { always, .. } = &mut rec.kind
	{
		*always = true;
		rec.status = status;
	}
	Flow::Next
}

/// zsh `exectry` after the always-list: pop the try record, `$?` is the
/// try-list's status, and what ended the try-list early resumes.
#[inline(never)]
fn always_end(vp: &mut Vproc) -> Flow {
	let f = top_frame(vp);
	if !matches!(f.loops.last(), Some(LoopRec { kind: LoopKind::Try { .. }, .. })) {
		return Flow::Next;
	}
	let Some(rec) = f.loops.pop() else {
		return Flow::Next;
	};
	vp.status = rec.status;
	let LoopKind::Try { pending, .. } = rec.kind else {
		return Flow::Next;
	};
	match pending {
		None => Flow::Next,
		Some(TryEnd::Error) => Flow::Discard(if rec.status == 0 { 1 } else { rec.status }),
		Some(TryEnd::Return(n)) => Flow::Return(n),
		Some(TryEnd::Break { n, cont }) => Flow::Break { n, cont },
		Some(TryEnd::Exit(n)) => Flow::Exit(n),
	}
}

/// zsh `exectry`: control is leaving the frames from the top down to
/// frame `floor` (inclusive) because of `end`. The innermost try-list it
/// leaves (a try record whose always-list has not started) runs its
/// always-list first: the frames above are popped, the try record keeps
/// `end` to resume, and its frame jumps to the always-list. An always-list
/// being left is abandoned. `false` when no try-list is in the way.
#[inline(never)]
fn run_always(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>, floor: usize, end: TryEnd) -> bool {
	let found = vp
		.frames
		.iter()
		.enumerate()
		.skip(floor)
		.rev()
		.find_map(|(fi, f)| {
			f.loops
				.iter()
				.rposition(|r| matches!(r.kind, LoopKind::Try { always: false, .. }))
				.map(|ri| (fi, ri))
		});
	let Some((fi, ri)) = found else {
		return false;
	};
	unwind(&mut k.root, cx.store, vp, fi + 1);
	// The op of that frame (a call, the op that ended the list) is over.
	clear_scratch(&mut k.root, cx.store, vp);
	let f = top_frame(vp);
	f.loops.truncate(ri + 1);
	let Some(rec) = f.loops.last_mut() else {
		return false;
	};
	if let LoopKind::Try { pending, .. } = &mut rec.kind {
		*pending = Some(end);
	}
	let (depth, always) = (rec.depth, rec.exit);
	truncate(vp, depth);
	top_frame(vp).pc = always;
	true
}

/// zsh `return N` (`bin_break` with `retflag`): leave the innermost
/// function, `${ ;}` or `.` file, running the always-lists in the way;
/// outside any, leave the shell (`zexit`). Also zsh `ERR_RETURN`.
#[inline(never)]
pub fn zsh_return(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>, status: i32) {
	vp.status = status;
	let target = vp.frames.iter().rposition(|f| {
		matches!(
			f.kind,
			FrameKind::Function { .. }
				| FrameKind::NoFork
				| FrameKind::Script { what: ScriptKind::Source, .. }
		)
	});
	if run_always(k, vp, cx, target.unwrap_or(0), TryEnd::Return(status)) {
		return;
	}
	if let Some(i) = target {
		zsh_leave(k, vp, cx, i);
	} else {
		exit_shell(k, vp, cx, status);
	}
}

/// Leave frame `target` (a function, `${ ;}` or `.` file) and the frames
/// above it. A zsh function's scope ends as zsh `doshfunc` ends it: its
/// options come back, the traps it saved are restored, and the `EXIT`
/// trap it set runs afterwards in its caller (zsh `endtrapscope`).
#[inline(never)]
fn zsh_leave(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>, target: usize) {
	unwind(&mut k.root, cx.store, vp, target + 1);
	let zsh_function = vp.trap_frames == 0
		&& matches!(
			vp.frames.get(target),
			Some(Frame { kind: FrameKind::Function { zsh: true, .. }, .. })
		);
	let exit = if zsh_function {
		match builtins::trap::take_scope_exit(k, cx, vp) {
			Ok(exit) => exit,
			Err(err) => {
				k.fail(err);
				None
			},
		}
	} else {
		None
	};
	if matches!(
		vp.frames.get(target),
		Some(Frame { kind: FrameKind::Function { zsh: true, .. }, .. })
	) {
		restore_local_specials(k, vp, cx);
	}
	pop_frame(&mut k.root, cx.store, vp);
	match exit {
		Some(builtins::trap::ScopeExit::Text { action, mode }) => {
			push_trap(k, vp, cx, TrapKey::Exit, &action, mode);
		},
		Some(builtins::trap::ScopeExit::Func(rec)) => {
			run_func_trap(k, vp, cx, TrapKey::Exit, BString::from("TRAPEXIT"), rec);
		},
		None => {},
	}
}

/// zsh `scanendscope` for a zsh function's scope, before it goes: the
/// computed specials it made local get their values back
/// ([`super::zsh::specials::restore_locals`]).
fn restore_local_specials(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>) {
	let mut log = Vec::new();
	let res = {
		let mut ex = super::expand::Expander::new(k, cx, vp, &mut log, false, 0);
		super::zsh::specials::restore_locals(&mut ex)
	};
	if let Err(super::expand::Stop::Store(err)) = res {
		k.fail(err);
	}
}

/// The loops a zsh `break`/`continue` may leave (zsh's `loops`): every
/// loop running in this vproc, across function calls and `eval`, up to the
/// `.` file, trap action or script that runs them (which start at zero).
pub fn zsh_loop_count(vp: &Vproc) -> u32 {
	let mut n = 0u32;
	for f in vp.frames.iter().rev() {
		let here = f
			.loops
			.iter()
			.filter(|r| !matches!(r.kind, LoopKind::Try { .. }))
			.count();
		n = n.saturating_add(u32::try_from(here).unwrap_or(u32::MAX));
		if !matches!(
			f.kind,
			FrameKind::Function { .. }
				| FrameKind::NoFork
				| FrameKind::Stage
				| FrameKind::Script { what: ScriptKind::Eval, .. }
		) {
			break;
		}
	}
	n
}

/// zsh `break N` / `continue N` (`bin_break`, the loops' `breaks`
/// handling): leave N loops (at most as many as run), across function
/// calls unless `localloops` is set when the function returns; a try-list
/// in the way runs its always-list first.
#[inline(never)]
fn zsh_break(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>, n: u32, cont: bool) {
	let mut remaining = n.min(zsh_loop_count(vp)).max(1);
	loop {
		let f = top_frame(vp);
		if let Some(rec) = f.loops.last().cloned() {
			match rec.kind {
				LoopKind::Try { always: false, .. } => {
					if let Some(LoopRec { kind: LoopKind::Try { pending, .. }, .. }) = f.loops.last_mut()
					{
						*pending = Some(TryEnd::Break { n: remaining, cont });
					}
					truncate(vp, rec.depth);
					top_frame(vp).pc = rec.exit;
					return;
				},
				LoopKind::Try { always: true, .. } => {
					f.loops.pop();
					truncate(vp, rec.depth);
					continue;
				},
				_ if remaining > 1 => {
					f.loops.pop();
					truncate(vp, rec.depth);
					remaining -= 1;
					continue;
				},
				_ => {
					truncate(vp, rec.depth);
					let status = vp.status;
					let f = top_frame(vp);
					// `continue` ends the body with its status too: the loop's
					// status if no other body command runs.
					if let Some(r) = f.loops.last_mut() {
						r.status = status;
					}
					f.pc = if cont { rec.cont } else { rec.exit };
					return;
				},
			}
		}
		let function = matches!(f.kind, FrameKind::Function { .. });
		let crossable = function
			|| matches!(
				f.kind,
				FrameKind::Script { what: ScriptKind::Eval, .. } | FrameKind::NoFork | FrameKind::Stage
			);
		if !crossable || vp.frames.len() < 2 {
			break;
		}
		pop_frame(&mut k.root, cx.store, vp);
		// zsh `doshfunc`: with `localloops` (as restored on return) the
		// break ends with the function; the call completes.
		if function
			&& state::zsh_option(&mut k.root, cx.store, vp, ZshOpt::Localloops).unwrap_or(false)
		{
			let what = if cont { "continue" } else { "break" };
			let msg = format!("`{what}' active at end of function scope").into();
			let line = current_line(vp);
			k.diag(cx, vp, line, Diag::Usage { msg });
			return;
		}
		// The caller's op (the call, `eval`) is abandoned with the loop.
		clear_scratch(&mut k.root, cx.store, vp);
	}
	top_frame(vp).pc += 1;
}

/// zsh `exit N` (`bin_break`): inside a function the functions return one
/// by one (always-lists and their `EXIT` traps run, zsh `exit_pending`),
/// then the shell exits; elsewhere it exits at once (`zexit`).
#[inline(never)]
fn zsh_exit(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>, status: i32) {
	vp.status = status;
	let in_function = vp
		.frames
		.iter()
		.any(|f| matches!(f.kind, FrameKind::Function { .. }));
	if !in_function {
		if let Some(z) = vp.zsh.as_mut()
			&& z.exit_pending.take().is_some()
		{
			z.exit_from_function = true;
		}
		exit_shell(k, vp, cx, status);
		return;
	}
	let level = vp
		.frames
		.iter()
		.filter(|f| matches!(f.kind, FrameKind::Function { .. }))
		.count();
	let level = u32::try_from(level).unwrap_or(u32::MAX);
	vp.zsh.get_or_insert_with(Box::default).exit_pending = Some((status, level));
	if run_always(k, vp, cx, 0, TryEnd::Exit(status)) {
		return;
	}
	let target = vp
		.frames
		.iter()
		.rposition(|f| matches!(f.kind, FrameKind::Function { .. }))
		.unwrap_or(0);
	zsh_leave(k, vp, cx, target);
}

/// The status a pending zsh `exit` (inside functions) leaves with, taken
/// when a call returns to its caller: the caller exits in turn if the
/// `exit` ran at its depth or deeper (zsh `doshfunc`'s `exit_level >=
/// locallevel+1`; a call an `always` list makes meanwhile returns
/// normally).
pub fn zsh_exit_pending(vp: &Vproc) -> Option<i32> {
	let (status, level) = vp.zsh.as_ref()?.exit_pending?;
	let depth = vp
		.frames
		.iter()
		.filter(|f| matches!(f.kind, FrameKind::Function { .. }))
		.count();
	(level as usize > depth).then_some(status)
}

/// zsh `errflag`: an error abandons everything up to the innermost `eval`,
/// `.` file or trap action (which clear it), or the whole script or
/// subshell, running the always-lists in the way (`TRY_BLOCK_ERROR` is 1
/// there).
#[inline(never)]
fn zsh_discard(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>, status: i32) {
	vp.status = status;
	let catcher = vp.frames.iter().rposition(|f| {
		matches!(f.kind, FrameKind::Script {
			what: ScriptKind::Eval
				| ScriptKind::Source
				| ScriptKind::Trap { .. }
				| ScriptKind::Code(_)
				// The line editor's widget or hook call: the editor goes on
				// (zsh `execzlefunc`/`callhookfunc` after `doshfunc`).
				| ScriptKind::Hook,
			..
		})
	});
	if run_always(k, vp, cx, catcher.unwrap_or(0), TryEnd::Error) {
		return;
	}
	// zsh `loop`: under `continueonerror` the script goes on with its next
	// command.
	let run = vp
		.frames
		.iter()
		.rposition(|f| matches!(f.kind, FrameKind::Script { what: ScriptKind::Run, .. }));
	if let Some(i) = catcher {
		// Code a builtin runs (`ScriptKind::Code`): the builtin learns of
		// the error (zsh's `errflag` after `execode`) when it runs again.
		let code = matches!(vp.frames[i].kind, FrameKind::Script { what: ScriptKind::Code(_), .. });
		unwind(&mut k.root, cx.store, vp, i);
		if code {
			state::store_record(
				&mut k.root,
				cx.store,
				vp,
				KeyBuf::Misc(MiscKey::ZshCodeError),
				Some(Record::Misc(BString::from("1"))),
			);
		}
		vp.status = status;
	} else if let Some(i) = run
		&& (state::zsh_option(&mut k.root, cx.store, vp, ZshOpt::Continueonerror).unwrap_or(false)
			|| super::zle::reader::input_frame(cx, vp, i))
	{
		unwind(&mut k.root, cx.store, vp, i + 1);
		clear_scratch(&mut k.root, cx.store, vp);
		truncate(vp, Depths::default());
		let f = top_frame(vp);
		f.unit = None;
		f.loops.clear();
		vp.status = status;
	} else {
		unwind(&mut k.root, cx.store, vp, 0);
		exit_shell(k, vp, cx, status);
	}
}

/// zsh `ERR_RETURN` applies (`execlist`): set, and in a function or `.`
/// file.
#[inline(never)]
fn zsh_errreturn(k: &mut Kernel, cx: &mut Cx<'_>, vp: &Vproc) -> bool {
	state::zsh_option(&mut k.root, cx.store, vp, ZshOpt::Errreturn).unwrap_or(false)
		&& vp.frames.iter().any(|f| {
			matches!(
				f.kind,
				FrameKind::Function { .. } | FrameKind::Script { what: ScriptKind::Source, .. }
			)
		})
}

/// zsh `execlist`'s `errexit = … || (ERRRETURN && !errreturn)`: `ERR_RETURN`
/// outside any function or `.` file of a non-interactive shell exits.
#[inline(never)]
fn zsh_errreturn_exits(k: &mut Kernel, cx: &mut Cx<'_>, vp: &Vproc) -> bool {
	let nested = vp.frames.iter().any(|f| {
		matches!(
			f.kind,
			FrameKind::Function { .. } | FrameKind::Script { what: ScriptKind::Source, .. }
		)
	});
	!nested
		&& state::zsh_option(&mut k.root, cx.store, vp, ZshOpt::Errreturn).unwrap_or(false)
		&& !state::zsh_option(&mut k.root, cx.store, vp, ZshOpt::Interactive).unwrap_or(false)
}

/// zsh `TRY_BLOCK_ERROR`: 1 while an always-list runs after an error in its
/// try-list, 0 in another always-list, -1 outside any. Read by the zsh
/// parameter code.
pub fn try_block_error(vp: &Vproc) -> i64 {
	vp.frames
		.iter()
		.rev()
		.flat_map(|f| f.loops.iter().rev())
		.find_map(|r| match r.kind {
			LoopKind::Try { always: true, pending } => Some(i64::from(pending == Some(TryEnd::Error))),
			_ => None,
		})
		.unwrap_or(-1)
}

/// Assign zsh `TRY_BLOCK_ERROR` in the innermost running always-list: 0
/// forgets the try-list's error (execution goes on after the always-list),
/// non-zero makes it one. `false` outside any always-list (nothing set).
pub fn set_try_block_error(vp: &mut Vproc, value: i64) -> bool {
	let rec = vp
		.frames
		.iter_mut()
		.rev()
		.flat_map(|f| f.loops.iter_mut().rev())
		.find(|r| matches!(r.kind, LoopKind::Try { always: true, .. }));
	let Some(LoopRec { kind: LoopKind::Try { pending, .. }, .. }) = rec else {
		return false;
	};
	if value == 0 {
		if *pending == Some(TryEnd::Error) {
			*pending = None;
		}
	} else if pending.is_none() {
		*pending = Some(TryEnd::Error);
	}
	true
}

/// Start zsh's function trap for `key` (`TRAPINT`, `TRAPZERR`, `TRAPEXIT`,
/// …: zsh `ZSIG_FUNC`), if that function is defined.
#[inline(never)]
fn start_func_trap(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>, key: TrapKey) -> bool {
	let Some(name) = builtins::trap::func_name(key) else {
		return false;
	};
	let rec = match state::record(cx.store, vp, Key::Func(BStr::new(&name))) {
		Ok(Some(rec @ Record::Func { .. })) => rec.clone(),
		Ok(_) => return false,
		Err(err) => {
			k.fail(err);
			return false;
		},
	};
	run_func_trap(k, vp, cx, key, name, rec)
}

/// zsh `dotrapargs` for a function trap: a trap frame without text, and
/// on top of it the call of `rec` (function `name`) with the signal number
/// as `$1`. A non-zero return forces a return from the interrupted code
/// (handled when the trap frame ends).
fn run_func_trap(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	key: TrapKey,
	name: BString,
	rec: Record,
) -> bool {
	let mode = vp.mode;
	if !push_trap(k, vp, cx, key, b"", mode) {
		return false;
	}
	let number = builtins::trap::zsh_number(key, k.engine.config().platform);
	let line = current_line(vp);
	// A lost body leaves the empty trap frame, which ends at once.
	command::call_record(k, vp, cx, name, &rec, vec![BString::from(number.to_string())], line);
	true
}

#[cfg(test)]
mod tests {
	use super::{BASH_TIMEFORMAT, POSIX_TIMEFORMAT, time_report};

	// Golden: bash 5.3.20 `time -p` and the default format.
	#[test]
	fn time_p_is_posix_format() {
		let t = [1_234_000_000, 5_000_000, 0];
		assert_eq!(time_report(POSIX_TIMEFORMAT, t).unwrap(), b"real 1.23\nuser 0.01\nsys 0.00\n");
		let t = [61_500_000_000, 0, 1_000_000];
		assert_eq!(
			time_report(BASH_TIMEFORMAT, t).unwrap(),
			b"\nreal\t1m1.500s\nuser\t0m0.000s\nsys\t0m0.001s\n"
		);
	}

	// bash `print_formatted_time`: precision 0 has no point, `%%` is a
	// percent sign, `%P` the CPU share, an unknown letter is an error.
	#[test]
	fn timeformat_precision_percent_and_errors() {
		let t = [2_000_000_000, 500_000_000, 500_000_000];
		assert_eq!(time_report(b"%0R %%%P %1lU", t).unwrap(), b"2 %50.00 0m0.5s\n");
		assert_eq!(time_report(b"%3x", t), Err(b'x'));
		assert_eq!(time_report(b"", t).unwrap(), b"\n");
	}
}
