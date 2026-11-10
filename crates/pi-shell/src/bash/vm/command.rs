//! The staged simple command (`Exec`): expand the words and
//! assignment values, apply the redirections, resolve the name, dispatch,
//! await, write the output, finish. Every stage keeps its results in the
//! op's scratch, so a park, a wake or a restore resumes the same stage and
//! nothing earlier re-runs.

use std::{
	borrow::Cow,
	collections::VecDeque,
	sync::Arc,
	task::{Context, Poll},
};

use bstr::{BStr, BString};

use super::{
	CallOutcome, Cx, Kernel, ToolCall, assign_scope,
	builtins::{self, Chunk, Control, Ctx, Lhs, Need},
	exec::{self, Flow, expanding, line_of},
	expand::{CompoundElem, Expander, Stop, compound_text},
	probe::{self, Search, absolute, candidates},
	proc::{
		AssignValue, Awaited, BangStage, DeferPhase, ExecAs, ExecState, Frame, FrameKind, JobState,
		Live, PathSearch, PendingWrite, Probe, ProbeResult, Scratch, ScriptKind, Slot, Stage, Target,
		Transfer, Vproc,
	},
	state::{self, Level, Scope, Var, VarMap},
	xtrace,
};
use crate::bash::{
	diag::Diag,
	event::{EventData, NodeKind, RedirKind, ResolvedKind, WaitKey, assign_preview},
	fd::{FdOrigin, FdRef},
	fs::StatKind,
	host::{
		ChildRedirs, EnvView, ExitStatus, Invocation, ProcEvent, ResolveCtx, Resolved, SpawnSpec,
		StdioSpec, Via,
	},
	ids::{CallId, CmdTag, IntrinsicId, RunId},
	ir::{self, AssignVal, Op, Part, Unit},
	signal::SigSet,
	snapshot::Lost,
	store::{Attrs, Key, KeyBuf, MiscKey, Record, StateStore, StoreError, VarValue},
	zshopt::ZshOpt,
};

impl ExecState {
	/// A command that has not started.
	pub const fn new(tag: CmdTag, t0: u64) -> Self {
		Self {
			stage: Stage::Expand,
			tag,
			t0,
			argv: Vec::new(),
			expanded: false,
			compound: Vec::new(),
			globs: Vec::new(),
			assigns: Vec::new(),
			values: Vec::new(),
			keywords: Vec::new(),
			arrayref: Vec::new(),
			target: None,
			waiting: None,
			scoped: false,
			control: None,
			checkpoint: None,
			writes: VecDeque::new(),
			status: 0,
			sub_status: None,
			wait_for: Vec::new(),
			exec_as: None,
			wait_into: None,
			via_command: false,
			resume: false,
			resumed: 0,
		}
	}

	/// Start over as a new command, keeping the allocations.
	fn reset(&mut self, tag: CmdTag, t0: u64) {
		let Self {
			stage,
			tag: old_tag,
			t0: old_t0,
			argv,
			expanded,
			compound,
			globs,
			assigns,
			values,
			keywords,
			arrayref,
			target,
			waiting,
			scoped,
			control,
			checkpoint,
			writes,
			status,
			sub_status,
			wait_for,
			exec_as,
			wait_into,
			via_command,
			resume,
			resumed,
		} = self;
		*stage = Stage::Expand;
		*old_tag = tag;
		*old_t0 = t0;
		argv.clear();
		*expanded = false;
		compound.clear();
		globs.clear();
		assigns.clear();
		values.clear();
		keywords.clear();
		arrayref.clear();
		*target = None;
		*waiting = None;
		*scoped = false;
		*control = None;
		*checkpoint = None;
		writes.clear();
		*status = 0;
		*sub_status = None;
		wait_for.clear();
		*exec_as = None;
		*wait_into = None;
		*via_command = false;
		*resume = false;
		*resumed = 0;
	}
}

fn scratch(vp: &mut Vproc) -> &mut Scratch {
	exec::scratch(vp)
}

fn st(vp: &mut Vproc) -> &mut ExecState {
	scratch(vp)
		.exec
		.as_deref_mut()
		.expect("Exec state is created first")
}

/// Most word buffers [`Scratch::spare_words`] keeps.
const WORD_POOL: usize = 32;
/// Largest word buffer (capacity, bytes) kept for reuse: a huge field must
/// not stay pinned.
const WORD_POOL_BYTES: usize = 256;

/// Move `words`' buffers into `pool` (cleared; small ones, up to
/// [`WORD_POOL`]), leaving `words` empty: the next expansion fills its
/// fields into them instead of allocating (xeon profile: `mi_free` +
/// `mi_malloc` ~5 % on loop/func).
fn pool_words(pool: &mut Vec<BString>, words: &mut Vec<BString>) {
	for mut w in words.drain(..) {
		if pool.len() >= WORD_POOL {
			break;
		}
		if w.capacity() <= WORD_POOL_BYTES {
			w.clear();
			pool.push(w);
		}
	}
}

/// The current command's expanded words, borrowed shared: lookups that also
/// read `vp` use it instead of copying a word out of [`st`].
fn current_argv(vp: &Vproc) -> &[BString] {
	current_exec(vp).map_or(&[], |e| &e.argv)
}

/// The current command's state, borrowed shared (event payloads borrow
/// from it while the kernel emits).
fn current_exec(vp: &Vproc) -> Option<&ExecState> {
	vp.frames
		.last()
		.and_then(|f| f.scratch.as_ref())
		.and_then(|s| s.exec.as_deref())
}

/// Run (or resume) the simple command `op.a` of `unit`.
pub fn exec(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	unit: &Arc<Unit>,
	op: Op,
	line: u32,
) -> Flow {
	// A resumed command (after a block or a called frame) leaves the clock
	// alone: a block ended the slice (`run_slice` starts stale), and a called
	// frame's ops kept it current, so a `FuncExit` shares the reading of the
	// function's last `CmdEnd`.
	if vp
		.frames
		.last()
		.and_then(|f| f.scratch.as_ref())
		.is_none_or(|s| s.exec.is_none())
		&& let Some(flow) = assignment_statement(k, vp, cx, unit, op, line)
			.or_else(|| plain_statement(k, vp, cx, unit, op, line))
	{
		return flow;
	}
	if scratch(vp).exec.is_none() {
		let on = k.mask.any_op(op.ev);
		// The clock only with events on: `CmdStart` shares the previous
		// `CmdEnd`'s reading when only control flow ran since
		// (`Kernel::stamp`), and its reading starts the `CmdEnd` duration.
		let t0 = if on { k.stamp(cx) } else { 0 };
		let tag = CmdTag {
			run:  vp.runs.front().map_or(RunId(0), |r| r.id),
			vpid: vp.vpid,
			seq:  k.next_cmd,
		};
		k.next_cmd += 1;
		let sc = scratch(vp);
		let state = match sc.spare_exec.take() {
			Some(mut e) => {
				pool_words(&mut sc.spare_words, &mut e.argv);
				e.reset(tag, t0);
				e
			},
			None => Box::new(ExecState::new(tag, t0)),
		};
		sc.exec = Some(state);
		if on {
			let data = EventData::CmdStart { node_kind: NodeKind::Simple };
			k.emit_op_at(cx, vp, op.node, data, t0);
		}
	}
	if k.mask.bits() != 0 {
		let tag = st(vp).tag;
		vp.fds.set_command_tag(Some(tag));
	}
	let cmd = &unit.cmds[op.a as usize];
	loop {
		let stage = st(vp).stage;
		match stage {
			Stage::Expand => {
				if let Some(flow) = expand(k, vp, cx, unit, op, line) {
					return flow;
				}
			},
			Stage::Redirect
				if unit.mode.dialect() == crate::bash::ids::Dialect::Zsh
					&& state::option(&mut k.root, cx.store, vp, crate::bash::store::OptId::Noexec)
						.unwrap_or(false) =>
			{
				// zsh `execcmd_exec` under `noexec` (set while running): the
				// words were expanded, reporting errors (assignments and
				// filename generation do nothing); nothing runs, status 0.
				let s = st(vp);
				s.status = 0;
				s.stage = Stage::Finish;
			},
			Stage::Redirect => {
				if let Some(list) = cmd.redirs {
					// Opens: `CmdExpanded` reads the clock after them.
					k.clock_stale();
					// Redirections do not see the command's temporary
					// environment (bash `expanding_redir`).
					let at = state::scope_count(&k.root, vp).saturating_sub(1);
					let hidden = if st(vp).scoped && !cmd.assigns.is_empty() {
						state::pop_scope(&mut k.root, cx.store, vp)
					} else {
						None
					};
					let res = super::redir::apply(k, vp, cx, unit, list, line);
					if let Some(scope) = hidden {
						state::insert_scope(&mut k.root, cx.store, vp, at, scope);
					}
					match res {
						Ok(()) => {},
						Err(super::redir::Halt::Flow(f)) => return f,
						Err(super::redir::Halt::Failed) => {
							// A special builtin's redirection error ends a posix
							// shell (`exec 9<missing`).
							// zsh: under `posixbuiltins`, in a non-interactive
							// shell (`execcmd_exec`'s `fatal`).
							let special = !st(vp).argv.is_empty()
								&& IntrinsicId::from_name(&st(vp).argv[0]).is_some_and(is_special);
							let fatal = special
								&& if unit.mode.dialect() == crate::bash::ids::Dialect::Zsh {
									let mut on = |o| state::zsh_option(&mut k.root, cx.store, vp, o);
									on(ZshOpt::Posixbuiltins).unwrap_or(false)
										&& !on(ZshOpt::Interactive).unwrap_or(false)
								} else {
									state::option(
										&mut k.root,
										cx.store,
										vp,
										crate::bash::store::OptId::Posix,
									)
									.unwrap_or(false)
								};
							let s = st(vp);
							s.status = 1;
							s.stage = Stage::Finish;
							if fatal {
								s.control = Some(Transfer::Exit(1));
							}
							// The message goes to stderr as the redirections so far
							// left it (`2>&1 >&bad`), before they are undone.
							if let Some(fd) = exec::flush_out(k, vp) {
								return Flow::Block(WaitKey::Write { fd });
							}
							continue;
						},
					}
				}
				if (op.flags & ir::Op::CAT != 0
					|| (unit.mode.dialect() == crate::bash::ids::Dialect::Zsh
						&& cmd.assigns.is_empty()
						&& cmd
							.redirs
							.is_some_and(|list| zsh_read_subst(vp, unit, list))))
					&& st(vp).argv.is_empty()
				{
					// `$(< file)`: the file is the substitution's output.
					if let Some(flow) = cat_stdin(k, vp, cx, line) {
						return flow;
					}
					continue;
				}
				if st(vp).argv.is_empty()
					&& cmd.assigns.is_empty()
					&& unit.mode.dialect() == crate::bash::ids::Dialect::Zsh
					&& let Some(list) = cmd.redirs
					&& let Some(flow) = null_command(k, vp, cx, unit, list, line)
				{
					return flow;
				}
				// The rest of a deferred list ran (or was collected) after the
				// name resolved: the command dispatches.
				let resolved = k
					.deferrals
					.iter()
					.any(|d| d.vproc == vp.vpid && d.phase != DeferPhase::Lookup);
				let s = st(vp);
				s.stage = if s.argv.is_empty() {
					Stage::Finish
				} else if resolved {
					Stage::Dispatch
				} else {
					Stage::Lookup
				};
			},
			Stage::Lookup => {
				if let Some(flow) = lookup(k, vp, cx, op, cmd.typeset) {
					return flow;
				}
			},
			Stage::Dispatch
				if k
					.deferrals
					.iter()
					.any(|d| d.vproc == vp.vpid && d.phase == DeferPhase::Lookup) =>
			{
				deferred_resolved(k, vp);
			},
			Stage::Dispatch => {
				// A builtin, task or external runs: what follows reads the
				// clock again (a function's `FuncEnter` shares the call's).
				if k.clock.is_some() && !matches!(st(vp).target, Some(Target::Function(_))) {
					k.clock_stale();
				}
				if let Some(flow) = dispatch(k, vp, cx, op, line) {
					return flow;
				}
			},
			Stage::Await => {
				if let Some(flow) = await_(k, vp, cx, op, line) {
					return flow;
				}
			},
			Stage::Output => {
				if let Some(fd) = exec::flush_out(k, vp) {
					return Flow::Block(WaitKey::Write { fd });
				}
				if let Some(flow) = output(k, vp, cx, line) {
					return flow;
				}
				st(vp).stage = Stage::Finish;
			},
			Stage::Finish => {
				k.forget_deferral(vp.vpid);
				return finish(k, vp, cx, op);
			},
		}
	}
}

/// An assignment statement of plain scalar values (`i=$((i+1))`,
/// `x=$1`, `s+=x`) run in one step: each value expanded and assigned in
/// turn, as the staged command does for a command without words. `None`
/// when the statement needs the stages: anything that can park (a command
/// substitution, `$!`), a tilde-prefix (it may look up a user), a
/// subscript, an array value, a redirection, zsh, `set -x`, or events
/// that report the command.
fn assignment_statement(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	unit: &Arc<Unit>,
	op: Op,
	line: u32,
) -> Option<Flow> {
	use crate::bash::event::EventKind;
	let cmd = &unit.cmds[op.a as usize];
	if cmd.assigns.is_empty()
		|| cmd.redirs.is_some()
		|| !unit.lists[cmd.words as usize].is_empty()
		|| op.flags & ir::Op::CAT != 0
		|| unit.mode.dialect() != crate::bash::ids::Dialect::Bash
		|| k.mask.any_op(op.ev)
		|| k.mask.contains(EventKind::Assign)
		|| k.mask.contains(EventKind::CmdExpanded)
		|| k.mask.contains(EventKind::CmdEnd)
	{
		return None;
	}
	for a in &cmd.assigns {
		let AssignVal::Scalar(w) = a.value else {
			return None;
		};
		let word = &unit.words[w as usize];
		if a.index.is_some()
			|| word.parks
			|| word.parts.iter().any(|p| match p {
				Part::Lit(b) => b.contains(&b'~'),
				Part::Zsh(_) => true,
				_ => false,
			}) {
			return None;
		}
	}
	if xtrace::on(k, cx, vp) {
		return None;
	}
	k.next_cmd += 1;
	for a in &cmd.assigns {
		let AssignVal::Scalar(w) = a.value else {
			unreachable!("checked above");
		};
		// Nothing in the value can park, so it needs no replay log.
		let mut log = Vec::new();
		let value =
			Expander::new(k, cx, vp, &mut log, false, line).scalar(unit, &unit.words[w as usize]);
		let value = match value {
			Ok(v) => v,
			Err(stop) => return Some(exec::stop_flow(k, vp, cx, line, stop)),
		};
		if let Err(d) = assign_now(k, vp, cx, &a.name, None, a.append, AssignValue::Scalar(value)) {
			k.diag(cx, vp, line, d);
			// bash abandons the rest of the command line after a failed
			// assignment statement; a posix shell exits.
			if state::option(&mut k.root, cx.store, vp, crate::bash::store::OptId::Posix)
				.unwrap_or(false)
			{
				return Some(Flow::Exit(1));
			}
			return Some(Flow::Discard(1));
		}
	}
	vp.status = 0;
	vp.pipestatus.clear();
	vp.pipestatus.push(0);
	Some(Flow::Next)
}

/// A simple command of plain words (`[ "$i" -lt 9 ]`, `f "$x"`,
/// `printf '%s\n' "$a"`): its words expanded in one step (none can park
/// or glob, so no replay log), then a builtin run here and its output
/// written. Whatever the stages would do from there continues in them
/// with the words already expanded: a function or external from the name
/// lookup on, a builtin that needs input or pushes a frame, output that
/// would block. `None` (nothing done) for every other command: one with
/// assignments or redirections, a name that is not literal, words that
/// can park or glob, zsh, `set -x`, posix mode, or events that report it.
fn plain_statement(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	unit: &Arc<Unit>,
	op: Op,
	line: u32,
) -> Option<Flow> {
	let cmd = &unit.cmds[op.a as usize];
	let words = &unit.lists[cmd.words as usize];
	let first = &unit.words[*words.first()? as usize];
	if !cmd.assigns.is_empty()
		|| cmd.redirs.is_some()
		|| op.flags & ir::Op::CAT != 0
		|| unit.mode.dialect() != crate::bash::ids::Dialect::Bash
		|| k.mask.bits() != 0
		|| !first.fixed
		|| !first.noglob
		|| first.braces.is_some()
	{
		return None;
	}
	for &w in words {
		let word = &unit.words[w as usize];
		if word.parks
			|| word.parts.iter().any(|p| match p {
				Part::Lit(b) => b.contains(&b'~'),
				Part::Zsh(_) | Part::Compound(_) => true,
				_ => false,
			}) {
			return None;
		}
	}
	let mut name = BString::default();
	for p in &first.parts {
		match p {
			Part::Lit(b) | Part::Quoted(b) => name.extend_from_slice(b),
			_ => return None,
		}
	}
	if name.contains(&b'/')
		|| xtrace::on(k, cx, vp)
		|| state::option(&mut k.root, cx.store, vp, crate::bash::store::OptId::Posix).unwrap_or(true)
		|| state::option(&mut k.root, cx.store, vp, crate::bash::store::OptId::Keyword)
			.unwrap_or(true)
	{
		return None;
	}
	// A builtin to run here; anything else (a function, an external,
	// `command`/`builtin`/`exec`) resolves in the stages.
	let id = match state::record(cx.store, vp, Key::Func(BStr::new(&name))) {
		Ok(None) => {
			let rctx = ResolveCtx { has_slash: false, via: Via::Plain };
			match resolve(k, cx, vp, &name, exec::mode_of(vp), rctx) {
				Ok(Resolved::Intrinsic(id))
					if !matches!(
						id,
						IntrinsicId::Command | IntrinsicId::Builtin | IntrinsicId::Exec
					) =>
				{
					Some(id)
				},
				_ => None,
			}
		},
		_ => None,
	};
	k.next_cmd += 1;
	let mut argv = Vec::with_capacity(words.len());
	let mut arrayref = Vec::new();
	let mut globs = Vec::new();
	let expanded = {
		// Nothing in the words can park, so they need no replay log.
		let mut log = Vec::new();
		let mut ex = Expander::new(k, cx, vp, &mut log, false, line);
		words.iter().try_for_each(|&w| {
			let word = &unit.words[w as usize];
			let before = argv.len();
			ex.fields_glob(unit, word, &mut argv, &mut globs)?;
			if argv.len() == before + 1 && is_arrayref(word) {
				arrayref.push(before as u32);
			}
			Ok(())
		})
	};
	if let Err(stop) = expanded {
		return Some(exec::stop_flow(k, vp, cx, line, stop));
	}
	// Fields to pathname-expand (directory walks, which may wait), a
	// function or an external: the stages go on from the expanded words.
	let id = match id {
		Some(id) if globs.is_empty() => id,
		_ => {
			let mut sc = exec::take_scratch(vp);
			let mut e = seeded_exec(k, vp, &mut sc, argv, arrayref);
			e.stage = if globs.is_empty() {
				Stage::Lookup
			} else {
				Stage::Expand
			};
			e.globs = globs;
			sc.exec = Some(e);
			vp.frames.last_mut().expect("frame").scratch = Some(sc);
			return Some(exec(k, vp, cx, unit, op, line));
		},
	};
	// The temporary scope the staged command gives a builtin.
	let scope =
		Scope { vars: VarMap::default(), positional: None, func: None, zsh: None };
	state::push_scope(&mut k.root, cx.store, vp, scope);
	let (res, chunks) = {
		let mut ctx = Ctx::new(k, cx, vp, &[], line, id.into());
		ctx.arrayref.clone_from(&arrayref);
		let r = builtins::run(id, &mut ctx, &argv);
		(r, std::mem::take(&mut ctx.chunks))
	};
	let written = match &res {
		Ok(outcome) if matches!(outcome.control, Control::None) => write_now(k, vp, &chunks),
		_ => Err((0, 0)),
	};
	if let (Ok(outcome), Ok(())) = (&res, written) {
		state::drop_scope(&mut k.root, cx.store, vp);
		vp.status = outcome.status;
		vp.pipestatus.clear();
		vp.pipestatus.push(outcome.status);
		return Some(Flow::Next);
	}
	// The stages take over from the expanded words: a builtin that needs
	// input runs again with its answers (as it does after each answer); one
	// that finished leaves its state as the stages would, less the output
	// already written.
	let mut sc = exec::take_scratch(vp);
	let mut e = seeded_exec(k, vp, &mut sc, argv, arrayref);
	e.scoped = true;
	e.target = Some(Target::Intrinsic(id));
	e.stage = Stage::Dispatch;
	sc.exec = Some(e);
	match res {
		Ok(outcome) => {
			if let Some(flow) = settle_builtin(k, vp, cx, line, id, sc, outcome, chunks, false) {
				return Some(flow);
			}
			if let Err((done, off)) = written {
				let writes = &mut st(vp).writes;
				writes.drain(..done);
				if let Some(w) = writes.front_mut() {
					w.off = off;
				}
			}
		},
		Err(_) => vp.frames.last_mut().expect("frame").scratch = Some(sc),
	}
	Some(exec(k, vp, cx, unit, op, line))
}

/// The exec state of a command whose words a fast path expanded
/// ([`plain_statement`]), for the stages to go on from.
fn seeded_exec(
	k: &Kernel,
	vp: &Vproc,
	sc: &mut Scratch,
	argv: Vec<BString>,
	arrayref: Vec<u32>,
) -> Box<ExecState> {
	let tag = CmdTag {
		run:  vp.runs.front().map_or(RunId(0), |r| r.id),
		vpid: vp.vpid,
		seq:  k.next_cmd - 1,
	};
	let mut e = sc
		.spare_exec
		.take()
		.unwrap_or_else(|| Box::new(ExecState::new(tag, 0)));
	e.reset(tag, 0);
	e.argv = argv;
	e.arrayref = arrayref;
	e.expanded = true;
	e
}

/// Write a fast-path builtin's output now. `Err((n, off))`: the first `n`
/// chunks and `off` bytes of the next went out, the rest is for the
/// staged output, which also takes all of it (`Err((0, 0))`) when it has a
/// diagnostic to render or the shell has output queued before it.
fn write_now(k: &Kernel, vp: &Vproc, chunks: &[Chunk]) -> Result<(), (usize, usize)> {
	if !vp.out.is_empty() || chunks.iter().any(|c| !matches!(c, Chunk::Out(..))) {
		return Err((0, 0));
	}
	let mut tcx = Context::from_waker(&k.waker);
	for (i, c) in chunks.iter().enumerate() {
		let Chunk::Out(fd, bytes) = c else {
			unreachable!("checked above");
		};
		let handle = vp.fds.handle(*fd);
		let mut off = 0;
		while off < bytes.len() {
			match handle.poll_write(&mut tcx, &bytes[off..]) {
				Poll::Ready(Ok(n)) if n > 0 => off += n,
				// Blocked, failed or refused: the staged output waits or
				// reports it.
				_ => return Err((i, off)),
			}
		}
	}
	Ok(())
}

/// The name of a command whose redirections stopped at an open that would
/// wait resolved ([`super::proc::Deferral`]): an external gets the rest of
/// them to apply itself ([`DeferPhase::Collect`]); anything else keeps the
/// job's virtual pid and opens them here ([`DeferPhase::Resume`]). The
/// redirection stage resumes either way.
#[cold]
#[inline(never)]
fn deferred_resolved(k: &mut Kernel, vp: &mut Vproc) {
	let external = matches!(st(vp).target, Some(Target::External(_)));
	if !external {
		k.settle_bang(vp.vpid, None);
	}
	if let Some(d) = k.deferral(vp.vpid) {
		d.phase = if external {
			DeferPhase::Collect
		} else {
			DeferPhase::Resume
		};
	}
	st(vp).stage = Stage::Redirect;
}

/// Expand words, then assignment values. Assignment-only commands assign
/// each value as it is expanded (later values see earlier ones).
fn expand(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	unit: &Arc<Unit>,
	op: Op,
	line: u32,
) -> Option<Flow> {
	let cmd = &unit.cmds[op.a as usize];
	if !st(vp).expanded && unit.lists[cmd.words as usize].is_empty() {
		st(vp).expanded = true;
	}
	if !st(vp).expanded {
		let words = &unit.lists[cmd.words as usize];
		let record = words.iter().any(|&w| unit.words[w as usize].parks);
		// Expand into the state's (recycled) vectors; a replay starts over.
		let s = st(vp);
		let mut argv = std::mem::take(&mut s.argv);
		let mut compound = std::mem::take(&mut s.compound);
		let mut globs = std::mem::take(&mut s.globs);
		// The fields reuse the buffers of earlier words (no allocation per
		// word in steady state).
		let mut pool = std::mem::take(&mut scratch(vp).spare_words);
		pool_words(&mut pool, &mut argv);
		// One slot per word (a recycled vector has them already): a first
		// push would reserve four, 72 bytes of slack in every parked
		// one-word command (idle vproc ≤ 2 KiB). Splitting grows it.
		argv.reserve_exact(words.len());
		compound.clear();
		globs.clear();
		let mut decls: Vec<DeclArg> = Vec::new();
		// `set -k`: assignment-like words anywhere on the line are
		// assignments, expanded after the prefix ones.
		let keyword = state::option(&mut k.root, cx.store, vp, crate::bash::store::OptId::Keyword)
			.unwrap_or(false);
		let mut keywords = std::mem::take(&mut st(vp).keywords);
		keywords.clear();
		let mut arrayref = std::mem::take(&mut st(vp).arrayref);
		arrayref.clear();
		let zsh = unit.mode.dialect() == crate::bash::ids::Dialect::Zsh;
		let res = expanding(k, vp, cx, Slot::Words, record, line, |ex| {
			keywords.clear();
			arrayref.clear();
			ex.pool = std::mem::take(&mut pool);
			// zsh `KSH_TYPESET`, read at the first argument that needs it.
			let mut ksh_typeset = None;
			for &w in words {
				let word = &unit.words[w as usize];
				if zsh && zsh_magic_word(ex, unit, word, &mut argv, &mut globs, &mut ksh_typeset)? {
					continue;
				}
				if keyword && word.kind == ir::WordKind::AssignArg {
					keywords.push(w);
					continue;
				}
				let mut prefix = Vec::new();
				let mut elems = Vec::new();
				let mut elem_globs = Vec::new();
				if ex.decl_compound(unit, word, &argv, &mut prefix, &mut elems, &mut elem_globs)? {
					let at = argv.len() as u32;
					argv.push(BString::default());
					compound.push(at);
					decls.push(DeclArg { at, prefix, elems, globs: elem_globs });
					continue;
				}
				let before = argv.len();
				ex.fields_glob(unit, word, &mut argv, &mut globs)?;
				if argv.len() == before + 1 && is_arrayref(word) {
					arrayref.push(before as u32);
				}
				if !argv.is_empty() && word.parts.iter().any(|p| matches!(p, Part::Compound(_))) {
					compound.push(argv.len() as u32 - 1);
				}
			}
			pool = std::mem::take(&mut ex.pool);
			Ok(())
		});
		if let Err(flow) = res {
			// A `${ ;}` may have pushed its frame: the state is not on top.
			return Some(flow);
		}
		for DeclArg { at, prefix, mut elems, globs: elem_globs } in decls {
			if !elem_globs.is_empty() {
				// Directory walks: `CmdExpanded` reads the clock after them.
				k.clock_stale();
			}
			// A park re-runs the expansion (replayed) and the walks (their
			// answers are cached in the scratch).
			if !elem_globs.is_empty()
				&& let Err(flow) = if unit.mode.dialect() == crate::bash::ids::Dialect::Zsh {
					super::zsh::zglob::expand_compound_globs(k, vp, cx, &mut elems, &elem_globs, line)
				} else {
					super::glob::expand_compound_globs(k, vp, cx, &mut elems, &elem_globs, line)
				} {
				return Some(flow);
			}
			let mut text = BString::from(prefix);
			text.extend_from_slice(&compound_text(&elems));
			argv[at as usize] = text;
		}
		scratch(vp).spare_words = pool;
		let s = st(vp);
		s.argv = argv;
		s.compound = compound;
		s.globs = globs;
		s.keywords = keywords;
		s.arrayref = arrayref;
		s.expanded = true;
	}
	if !st(vp).globs.is_empty() {
		// Directory walks: `CmdExpanded` reads the clock after them.
		k.clock_stale();
		let globs = std::mem::take(&mut st(vp).globs);
		let mut argv = std::mem::take(&mut st(vp).argv);
		let res = if unit.mode.dialect() != crate::bash::ids::Dialect::Zsh {
			super::glob::expand_globs(k, vp, cx, &mut argv, &globs, line)
		} else if zsh_noglob(&argv) {
			Ok(())
		} else {
			// `exec`'s options and `-a NAME` are taken before filename
			// generation.
			let taken = zsh_exec_words(&argv) as u32;
			if taken == 0 {
				super::zsh::zglob::expand_globs(k, vp, cx, &mut argv, &globs, line)
			} else {
				let globs: Vec<_> = globs.iter().filter(|(i, _)| *i >= taken).cloned().collect();
				super::zsh::zglob::expand_globs(k, vp, cx, &mut argv, &globs, line)
			}
		};
		let s = st(vp);
		s.argv = argv;
		if let Err(flow) = res {
			s.globs = globs;
			return Some(flow);
		}
	}
	if unit.mode.dialect() == crate::bash::ids::Dialect::Zsh {
		zsh_last_arg(k, vp, cx);
	}
	let assign_only = st(vp).argv.is_empty();
	if !assign_only && !cmd.assigns.is_empty() && !st(vp).scoped {
		// The command's temporary scope: each prefix assignment enters it
		// as it is expanded, so later ones see earlier ones (and a `PATH=`
		// prefix steers the lookup).
		st(vp).scoped = true;
		let scope = Scope {
			vars:       VarMap::default(),
			positional: None,
			func:       None,
			zsh:        None,
		};
		state::push_scope(&mut k.root, cx.store, vp, scope);
	}
	while st(vp).values.len() < cmd.assigns.len() + st(vp).keywords.len() {
		let i = st(vp).values.len();
		if assign_only
			&& unit.mode.dialect() == crate::bash::ids::Dialect::Zsh
			&& let Some(a) = cmd.assigns.get(i)
		{
			if let Some(flow) = zsh_assign(k, vp, cx, unit, a, line) {
				return Some(flow);
			}
			continue;
		}
		let (name, append, node, index, value) = if let Some(a) = cmd.assigns.get(i) {
			if !assign_only && a.index.is_some() {
				// `var[0]=X cmd`: bash reports the word as written, sets
				// nothing (expands nothing) and runs the command.
				let src = unit
					.nodes
					.get(a.node as usize)
					.and_then(|n| unit.source.get(n.lo as usize..n.hi as usize))
					.unwrap_or_default();
				let close = src
					.iter()
					.position(|&c| c == b']')
					.map_or(src.len(), |p| p + 1);
				k.diag(cx, vp, line, Diag::InvalidIdent { name: BString::from(&src[..close]) });
				let s = st(vp);
				s.assigns.push((a.name.clone(), BString::default()));
				s.values
					.push((Some(BString::default()), AssignValue::Scalar(BString::default())));
				continue;
			}
			// `b[]=x`: a subscript written empty is a bad one (an expanded
			// empty one, `b[$e]`, is element 0); bash reports the element
			// and abandons the line as for any failed assignment.
			if let Some(w) = a.index
				&& unit.words[w as usize].parts.is_empty()
			{
				let mut shown = a.name.clone();
				shown.extend_from_slice(b"[]");
				k.diag(cx, vp, line, Diag::BadSubscript { shown });
				if state::option(&mut k.root, cx.store, vp, crate::bash::store::OptId::Posix)
					.unwrap_or(false)
				{
					return Some(Flow::Exit(1));
				}
				return Some(Flow::Discard(1));
			}
			let record = assign_parks(unit, a);
			let res = expanding(k, vp, cx, Slot::Assigns, record, line, |ex| {
				let index = match a.index {
					Some(w) => Some(ex.scalar(unit, &unit.words[w as usize])?),
					None => None,
				};
				let value = match &a.value {
					AssignVal::Scalar(w) => Ok(ex.scalar(unit, &unit.words[*w as usize])?),
					AssignVal::Array(elems) => {
						let mut out = Vec::with_capacity(elems.len());
						let mut globs = Vec::new();
						ex.assign_compound(unit, &a.name, elems, &mut out, Some(&mut globs))?;
						Err((out, globs))
					},
				};
				Ok((index, value))
			});
			let (index, value) = match res {
				Ok(v) => v,
				Err(flow) => return Some(flow),
			};
			let value = match value {
				Ok(scalar) => AssignValue::Scalar(scalar),
				Err((mut elems, globs)) => {
					// `a=(*)`: pathname expansion of the unkeyed words; a park
					// replays the expansion (its log is kept until here).
					if !globs.is_empty()
						&& let Err(flow) =
							super::glob::expand_compound_globs(k, vp, cx, &mut elems, &globs, line)
					{
						return Some(flow);
					}
					AssignValue::Array(
						elems
							.into_iter()
							.map(|e| (e.key, e.append, e.value))
							.collect(),
					)
				},
			};
			(a.name.clone(), a.append, a.node, index, value)
		} else {
			// A `set -k` word: `name=value` (or `name+=value`), expanded as
			// the word it is.
			let word = &unit.words[st(vp).keywords[i - cmd.assigns.len()] as usize];
			let res =
				expanding(k, vp, cx, Slot::Assigns, word.parks, line, |ex| ex.scalar(unit, word));
			let text = match res {
				Ok(v) => v,
				Err(flow) => return Some(flow),
			};
			let eq = text.iter().position(|&c| c == b'=').unwrap_or(text.len());
			let (name, append) = match text[..eq].strip_suffix(b"+") {
				Some(n) => (BString::from(n), true),
				None => (BString::from(&text[..eq]), false),
			};
			let value = BString::from(text.get(eq + 1..).unwrap_or_default());
			(name, append, word.node, None, AssignValue::Scalar(value))
		};
		scratch(vp).logs[Slot::Assigns as usize].clear();
		// A prefix assignment through a name reference binds the target in
		// the temporary scope (bash `assign_in_env`, as ksh93 does); `+=`
		// appends to the target's value.
		let name = if !assign_only && index.is_none() {
			match state::deref(&k.root, cx.store, vp, &name) {
				Ok(state::Deref::To { name: target, index: None }) => target,
				Ok(_) => name,
				Err(err) => {
					k.fail(err);
					return Some(Flow::Discard(1));
				},
			}
		} else {
			name
		};
		if !assign_only {
			let readonly = match state::lookup_declared(&k.root, cx.store, vp, &name) {
				Ok(v) => v.is_some_and(|v| v.attrs.contains(Attrs::READONLY)),
				Err(err) => {
					k.fail(err);
					return Some(Flow::Discard(1));
				},
			};
			if readonly {
				// bash reports it and runs the command without the
				// assignment; in posix mode the command does not run, and a
				// special builtin's assignment error ends the shell.
				k.diag(cx, vp, line, Diag::Readonly { name: name.clone() });
				// zsh: an error (`errflag`); the command does not run.
				if unit.mode.dialect() == crate::bash::ids::Dialect::Zsh {
					return Some(Flow::Discard(1));
				}
				if state::option(&mut k.root, cx.store, vp, crate::bash::store::OptId::Posix)
					.unwrap_or(false)
				{
					if IntrinsicId::from_name(&st(vp).argv[0]).is_some_and(is_special) {
						return Some(Flow::Exit(1));
					}
					let s = st(vp);
					s.status = 1;
					s.stage = Stage::Finish;
					return None;
				}
				// A skipped slot: an indexed entry, which neither the
				// environment nor a function scope takes.
				let s = st(vp);
				s.assigns.push((name.clone(), BString::default()));
				s.values
					.push((Some(BString::default()), AssignValue::Scalar(BString::default())));
				continue;
			}
		}
		// A prefix assignment's value takes the visible variable's attributes
		// (`-i`, case conversion) and `+=`.
		let value = match (assign_only, &index, value) {
			(false, None, AssignValue::Scalar(raw)) => {
				match builtins::prefix_value(k, cx, vp, &name, &raw, append) {
					Ok(converted) => AssignValue::Scalar(converted),
					Err(diag) => {
						k.diag(cx, vp, line, diag);
						// bash does not run the command.
						let state = st(vp);
						state.status = 1;
						state.stage = Stage::Finish;
						return None;
					},
				}
			},
			(_, _, value) => value,
		};
		// The value as the `CmdExpanded` and `Assign` events show it, built
		// only when one of them is on.
		let shown = if k.mask.contains(crate::bash::event::EventKind::CmdExpanded)
			|| k.mask.contains(crate::bash::event::EventKind::Assign)
		{
			match &value {
				AssignValue::Scalar(s) => s.clone(),
				AssignValue::Array(items) => {
					BString::from(bstr::join(b" ", items.iter().map(|(_, _, v)| v.as_slice())))
				},
			}
		} else {
			BString::default()
		};
		let value = if assign_only {
			// The statement's value goes to the variable. Only `set -x`
			// reads it back from the command's values (a scalar; a compound
			// value is traced from the IR), so it is copied only then.
			let kept = match &value {
				AssignValue::Scalar(s) if xtrace::on(k, cx, vp) => AssignValue::Scalar(s.clone()),
				AssignValue::Scalar(_) => AssignValue::Scalar(BString::default()),
				AssignValue::Array(_) => AssignValue::Array(Vec::new()),
			};
			if let Err(d) =
				assign_now(k, vp, cx, &name, index.as_ref().map(|i| i.as_slice()), append, value)
			{
				k.diag(cx, vp, line, d);
				// bash abandons the rest of the command line after a failed
				// assignment statement; a posix shell exits.
				if state::option(&mut k.root, cx.store, vp, crate::bash::store::OptId::Posix)
					.unwrap_or(false)
				{
					return Some(Flow::Exit(1));
				}
				return Some(Flow::Discard(1));
			}
			if k.mask.contains(crate::bash::event::EventKind::Assign)
				&& matches!(name.as_slice(), b"BASH_ALIASES" | b"BASH_CMDS" | b"DIRSTACK" | b"RANDOM")
			{
				let scope = assign_scope(vp);
				k.emit_op(cx, vp, node, EventData::Assign {
					name: BStr::new(&name),
					value: BStr::new(assign_preview(&shown)),
					full_len: shown.len(),
					scope,
				});
			}
			kept
		} else {
			value
		};
		if !assign_only
			&& index.is_none()
			&& let Some(top) = state::scope_count(&k.root, vp).checked_sub(1)
		{
			let var = prefix_var(&value);
			for &other in prompt_siblings(vp.mode.dialect() == crate::bash::ids::Dialect::Zsh, &name) {
				state::scope_set(&mut k.root, cx.store, vp, top, other, Some(var.clone()));
			}
			state::scope_set(&mut k.root, cx.store, vp, top, &name, Some(var));
			builtins::emit_assignment_at(k, cx, vp, &name, Level::Dynamic, node);
		}
		// bash's `sv_path` runs for a temporary `PATH` too.
		if !assign_only
			&& (name.as_slice() == b"PATH"
				|| (k.engine.config().platform == crate::bash::ids::Platform::Windows
					&& name.as_slice() == b"PATHEXT"))
			&& let Err(err) = builtins::flush_hash(&mut k.root, cx.store, vp)
		{
			k.fail(err);
			return Some(Flow::Discard(1));
		}
		let s = st(vp);
		s.assigns.push((name, shown));
		s.values.push((index, value));
	}
	let s = st(vp);
	if assign_only {
		// `$?` of `x=$(cmd)` is the status of the last substitution.
		s.status = s.sub_status.unwrap_or(0);
	}
	s.stage = Stage::Redirect;
	if assign_only
		&& k.mask.contains(crate::bash::event::EventKind::CmdExpanded)
		&& let Some(e) = current_exec(vp)
	{
		// Stamped with the command's start when only in-engine expansion
		// ran since (`Kernel::stamp`).
		let t_ns = k.stamp(cx);
		k.emit_op_at(
			cx,
			vp,
			op.node,
			EventData::CmdExpanded {
				argv:     &[],
				assigns:  &e.assigns,
				redirs:   &[],
				resolved: ResolvedKind::None,
			},
			t_ns,
		);
	}
	if xtrace::on(k, cx, vp) {
		if unit.mode.dialect() == crate::bash::ids::Dialect::Zsh {
			trace_zsh(k, vp, cx, unit, &cmd.assigns, line);
		} else {
			trace(k, vp, cx, unit, &cmd.assigns, line);
		}
		// Out before the command's redirections move stderr.
		if let Some(fd) = exec::flush_out(k, vp) {
			return Some(Flow::Block(WaitKey::Write { fd }));
		}
	}
	None
}

/// `$(< file)`: read fd 0 (the redirected file) to its end and queue it
/// as the command's output.
fn cat_stdin(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>, line: u32) -> Option<Flow> {
	let req = Probe::Read { path: BString::from("/dev/stdin") };
	let mut sc = exec::take_scratch(vp);
	let answer = match probe::cached(&sc, &req) {
		Some(r) => Ok(r.clone()),
		None => probe::perform(k, cx, vp, &mut sc, &req),
	};
	vp.frames.last_mut().expect("frame").scratch = Some(sc);
	let text = match answer {
		Err(key) => return Some(Flow::Block(key)),
		Ok(ProbeResult::Bytes(Ok(text))) => text,
		Ok(ProbeResult::Bytes(Err(msg))) => {
			k.diag(cx, vp, line, Diag::Usage { msg: format!("{msg}").into() });
			let s = st(vp);
			s.status = 1;
			s.stage = Stage::Finish;
			return None;
		},
		Ok(_) => BString::default(),
	};
	let s = st(vp);
	s.writes
		.push_back(PendingWrite { fd: 1, bytes: text, off: 0 });
	s.stage = Stage::Output;
	None
}

/// zsh `getoutput`'s `$(< word)` (`simple_redir_name`): the whole body of
/// the zsh command substitution `vp` runs is one simple command made of a
/// lone `<` on fd 0 (redirection list `list` of `unit`). Its output is the
/// file, read without running `$READNULLCMD`.
#[inline(never)]
fn zsh_read_subst(vp: &Vproc, unit: &Unit, list: u32) -> bool {
	let [Frame { kind: FrameKind::Script { src, what: ScriptKind::Eval, aux, .. }, .. }] =
		vp.frames.as_slice()
	else {
		return false;
	};
	if aux.as_ref().is_some_and(|a| a.pending.is_some()) {
		return false;
	}
	// The list markers (`Nop`s) aside.
	let mut ops = unit.ops.iter().filter(|op| op.code != ir::Opcode::Nop);
	let lone_exec = matches!((ops.next(), ops.next(), ops.next()), (Some(exec), Some(end), None)
		if exec.code == ir::Opcode::Exec && end.code == ir::Opcode::End);
	vp.parent.is_some()
		&& lone_exec
		&& unit.redirs.get(list as usize).is_some_and(
			|rs| matches!(rs.as_slice(), [r] if r.op == RedirKind::In && r.fd == ir::RedirFdIr::Default),
		)
		&& src.trim_ascii() == unit.source.trim_ascii()
}

/// zsh `execcmd` for redirections without a command: without `$NULLCMD`
/// or under `cshnullcmd` it is the error `redirection with no command`;
/// else `:` under `shnullcmd`, `$READNULLCMD` for a lone `<`, `$NULLCMD`
/// otherwise, runs with them. `Some` is that error's flow.
#[inline(never)]
fn null_command(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	unit: &Unit,
	list: u32,
	line: u32,
) -> Option<Flow> {
	let option = |k: &mut Kernel, cx: &mut Cx<'_>, vp: &Vproc, opt| {
		state::zsh_option(&mut k.root, cx.store, vp, opt).unwrap_or(false)
	};
	let value = |k: &Kernel, cx: &mut Cx<'_>, vp: &Vproc, name: &[u8]| {
		state::lookup(&k.root, cx.store, vp, name)
			.ok()
			.flatten()
			.and_then(|v| v.as_scalar().map(BString::from))
			.filter(|v| !v.is_empty())
	};
	let lone_read = unit
		.redirs
		.get(list as usize)
		.is_some_and(|rs| matches!(rs.as_slice(), [r] if r.op == RedirKind::In));
	let nullcmd = value(k, cx, vp, b"NULLCMD");
	let word = if nullcmd.is_none() || option(k, cx, vp, ZshOpt::Cshnullcmd) {
		None
	} else if option(k, cx, vp, ZshOpt::Shnullcmd) {
		Some(BString::from(":"))
	} else {
		lone_read
			.then(|| value(k, cx, vp, b"READNULLCMD"))
			.flatten()
			.or(nullcmd)
	};
	if let Some(word) = word {
		st(vp).argv.push(word);
		return None;
	}
	k.diag(cx, vp, line, Diag::Usage { msg: "redirection with no command".into() });
	Some(Flow::Discard(1))
}

/// zsh `magic_assign`: under `KSH_TYPESET` a `name=value` argument of a
/// `BINF_MAGICEQUALS` builtin through the builtin interface (`typeset
/// name=$(…)` with `typeset` disabled as a reserved word) expands like an
/// assignment, unsplit, into `argv`; `false` when `word` is no such
/// argument. `kshtypeset` caches the option for the command. Out of line:
/// zsh units only.
#[inline(never)]
fn zsh_magic_word(
	ex: &mut super::expand::Expander<'_, '_>,
	unit: &Arc<Unit>,
	word: &ir::Word,
	argv: &mut Vec<BString>,
	globs: &mut Vec<(u32, BString)>,
	kshtypeset: &mut Option<bool>,
) -> super::expand::X<bool> {
	let (Some(name), [Part::Zsh(t), ..]) = (argv.first(), &word.parts[..]) else {
		return Ok(false);
	};
	if word.kind != ir::WordKind::Plain {
		return Ok(false);
	}
	let kt = if let Some(kt) = *kshtypeset {
		kt
	} else {
		let kt = state::zsh_option(
			&mut ex.k.root,
			ex.cx.store,
			ex.vp,
			crate::bash::zshopt::ZshOpt::Kshtypeset,
		)?;
		*kshtypeset = Some(kt);
		kt
	};
	if !super::builtins::zsh_args::magic_assign_arg(name, kt, t) {
		return Ok(false);
	}
	let magic = ir::Word { kind: ir::WordKind::DeclArg, ..word.clone() };
	ex.fields_glob(unit, &magic, argv, globs)?;
	Ok(true)
}

/// A zsh assignment statement `name=word`, `name[sub]=word`, `name=(…)`
/// (zsh `addvars`): the value expanded and assigned by zsh's parameter
/// code, array elements through filename generation first. Records an
/// empty slot in the command's values (the loop's progress). `Some` ends
/// the op for now (a park, or a failed assignment abandoning the line).
#[inline(never)]
fn zsh_assign(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	unit: &Arc<Unit>,
	a: &ir::AssignOp,
	line: u32,
) -> Option<Flow> {
	use super::zsh::subst;
	let record = assign_parks(unit, a);
	// `set -x` shows the value assigned (zsh `addvars`).
	let tracing = xtrace::on(k, cx, vp);
	let mut shown = BString::default();
	let res = expanding(k, vp, cx, Slot::Assigns, record, line, |ex| match a.value {
		AssignVal::Scalar(_) => {
			let out = subst::assign_scalar(ex, unit, a, tracing.then_some(&mut shown))?;
			Ok(out.map(|(out, globs)| (out, globs, false)))
		},
		AssignVal::Array(_) => {
			let mut out = Vec::new();
			let mut globs = Vec::new();
			let kv = subst::assign_elems(ex, unit, a, &mut out, &mut globs)?;
			Ok(Some((out, globs, kv)))
		},
	});
	let mut value = AssignValue::Scalar(shown);
	match res {
		Err(flow) => return Some(flow),
		Ok(None) => {},
		Ok(Some((mut elems, globs, kv))) => {
			if !globs.is_empty() {
				k.clock_stale();
				if let Err(flow) = super::zsh::zglob::expand_globs(k, vp, cx, &mut elems, &globs, line)
				{
					return Some(flow);
				}
			}
			if tracing {
				value = match a.value {
					AssignVal::Scalar(_) if elems.len() <= 1 => {
						AssignValue::Scalar(elems.first().cloned().unwrap_or_default())
					},
					_ => AssignValue::Array(elems.iter().map(|e| (None, false, e.clone())).collect()),
				};
			}
			// The assignment itself logs apart from the elements (whose
			// expansion replays when it parks: zsh/mapfile probes the file
			// system); an assignment statement runs no builtin, so that
			// slot is free.
			if let Err(flow) = expanding(k, vp, cx, Slot::Builtin, false, line, |ex| match a.value {
				AssignVal::Scalar(_) => subst::assign_globbed(ex, unit, a, elems),
				AssignVal::Array(_) => subst::assign_array(ex, unit, a, elems, kv),
			}) {
				return Some(flow);
			}
			scratch(vp).logs[Slot::Builtin as usize].clear();
		},
	}
	scratch(vp).logs[Slot::Assigns as usize].clear();
	let s = st(vp);
	s.assigns.push((a.name.clone(), BString::default()));
	s.values.push((None, value));
	None
}

/// zsh `execcmd`: `$_` is the line's last word once it is expanded (empty
/// without one).
#[inline(never)]
fn zsh_last_arg(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>) {
	let last = st(vp).argv.last().filter(|w| !w.is_empty()).cloned();
	state::store_record(
		&mut k.root,
		cx.store,
		vp,
		KeyBuf::Misc(MiscKey::LastArg),
		last.map(Record::Misc),
	);
}

/// zsh's `noglob` precommand modifier among the leading precommand words
/// (`BINF_NOGLOB`): the command's words skip filename generation.
fn zsh_noglob(argv: &[BString]) -> bool {
	for w in argv {
		match w.as_slice() {
			b"noglob" => return true,
			b"-" | b"nocorrect" | b"builtin" | b"command" | b"exec" => {},
			_ => return false,
		}
	}
	false
}

/// zsh `execcmd_exec`'s precommand loop: how many leading words are
/// `exec` (after `-`, `nocorrect` or `noglob`) and its options, `-a NAME`
/// included; they are not subject to filename generation. 0 for any
/// other command.
fn zsh_exec_words(argv: &[BString]) -> usize {
	let Some(mut i) = argv
		.iter()
		.position(|w| !matches!(w.as_slice(), b"-" | b"nocorrect" | b"noglob"))
		.filter(|&i| argv[i].as_slice() == b"exec")
	else {
		return 0;
	};
	i += 1;
	while let Some(w) = argv.get(i) {
		if w.as_slice() == b"--" {
			return i + 1;
		}
		if w.len() < 2 || w[0] != b'-' {
			break;
		}
		// `-a NAME` or `-aNAME`: the name ends the cluster.
		if let Some(p) = w.iter().skip(1).position(|&c| c == b'a')
			&& p + 2 == w.len()
		{
			i += 1;
		}
		i += 1;
	}
	i
}

/// zsh `execute` under `pathdirs`: a command name with a slash that is not
/// absolute and not `./…` or `../…` is also looked for in each `PATH`
/// directory when it does not run as it stands.
#[inline(never)]
fn zsh_path_dirs(k: &mut Kernel, cx: &mut Cx<'_>, vp: &Vproc, name: &[u8]) -> bool {
	!name.starts_with(b"/")
		&& !name.starts_with(b"./")
		&& !name.starts_with(b"../")
		&& state::zsh_option(&mut k.root, cx.store, vp, ZshOpt::Pathdirs).unwrap_or(false)
}

/// zsh's precommand modifiers before the command name (`execcmd`'s
/// `BINF_PREFIX` loop): `-` runs the command with `-` before its `argv[0]`
/// (`BINF_DASH`); `noglob` and `nocorrect` drop out (`noglob` acted on the
/// glob stage already). `builtin`, `command` and `exec` resolve as builtins.
#[inline(never)]
fn zsh_precommands(vp: &mut Vproc) {
	let s = st(vp);
	while s.argv.len() > 1 {
		match s.argv[0].as_slice() {
			b"-" => s.exec_as.get_or_insert_with(Box::default).login = true,
			b"noglob" | b"nocorrect" => {},
			_ => break,
		}
		s.argv.remove(0);
		shift_arrayref(&mut s.arrayref);
	}
}

/// zsh `execcmd`'s `AUTO_RESUME`: a command of one word that starts the
/// text of a job runs `fg WORD`.
fn zsh_autoresume(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc) {
	if current_argv(vp).len() != 1
		|| !state::zsh_option(&mut k.root, cx.store, vp, ZshOpt::Autoresume).unwrap_or(false)
		|| super::builtins::zsh_jobs::findjobnam(vp, &current_argv(vp)[0]).is_none()
	{
		return;
	}
	let s = st(vp);
	s.argv.insert(0, BString::from("fg"));
	for i in &mut s.arrayref {
		*i += 1;
	}
}

/// Whether zsh's `disable -f` turned function `name` off.
#[inline(never)]
fn zsh_disabled(store: &mut dyn StateStore, vp: &Vproc, name: &[u8]) -> bool {
	matches!(
		state::record(store, vp, Key::Misc(MiscKey::ZshDisabledFuncs)),
		Ok(Some(Record::Words(names))) if names.iter().any(|n| n.as_slice() == name)
	)
}

/// `command`/`builtin` dropped `argv[0]`: the array-reference indexes
/// move down with the words.
fn shift_arrayref(arrayref: &mut Vec<u32>) {
	arrayref.retain_mut(|i| {
		let keep = *i > 0;
		*i = i.saturating_sub(1);
		keep
	});
}

/// bash's `W_ARRAYREF` (`fix_arrayref_words`): the word is written as an
/// array reference, `name[` in its leading unquoted text and `]` ending
/// its trailing unquoted text (`d[$k]`, `d["$k"]`, not `"d[$k]"`).
fn is_arrayref(word: &ir::Word) -> bool {
	let (Some(Part::Lit(first)), Some(Part::Lit(last))) = (word.parts.first(), word.parts.last())
	else {
		return false;
	};
	let name = first
		.iter()
		.take_while(|&&c| c == b'_' || c.is_ascii_alphanumeric())
		.count();
	name > 0 && !first[0].is_ascii_digit() && first.get(name) == Some(&b'[') && last.ends_with(b"]")
}

/// `set -x`: one line per assignment, then the words.
fn trace(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	unit: &Unit,
	assigns: &[ir::AssignOp],
	line: u32,
) {
	let utf8 = xtrace::utf8(k, cx, vp);
	let mut lines = Vec::new();
	let s = st(vp);
	// The prefix assignments, then the `set -k` words.
	for (i, ((name, _), (index, value))) in s.assigns.iter().zip(&s.values).enumerate() {
		// A skipped (readonly) prefix assignment.
		if index.as_ref().is_some_and(|i| i.is_empty()) {
			continue;
		}
		let mut body = Vec::new();
		let append = assigns.get(i).is_some_and(|a| a.append);
		// bash traces a compound value as the parser kept it: the
		// elements as written, `$'…'` already single-quoted
		// (`metas=(\| ' ' '<TAB>')`, `n=($@)`).
		if let Some(AssignVal::Array(elems)) = assigns.get(i).map(|a| &a.value) {
			body.extend_from_slice(name);
			body.extend_from_slice(if append { b"+=(" } else { b"=(" });
			for (j, e) in elems.iter().enumerate() {
				if j > 0 {
					body.push(b' ');
				}
				if let Some(key) = e.key {
					body.push(b'[');
					body.extend_from_slice(&parsed_source(exec::word_source(unit, key)));
					body.extend_from_slice(if e.append { b"]+=" } else { b"]=" });
				}
				body.extend_from_slice(&parsed_source(exec::word_source(unit, e.value)));
			}
			body.push(b')');
			lines.push(body);
			continue;
		}
		let index = index.as_ref().map(|i| i.as_slice());
		xtrace::push_assign(&mut body, name, index, append, value, utf8);
		lines.push(body);
	}
	if !s.argv.is_empty() {
		let mut body = Vec::new();
		xtrace::push_words(&mut body, &s.argv, utf8);
		lines.push(body);
	}
	for body in lines {
		xtrace::emit(k, cx, vp, line, &body);
	}
}

/// zsh's `set -x` of a simple command (`addvars`, then `execbuiltin`,
/// `execshfunc` or `makecline`): `PS4`, the assignments as `name=value `
/// (an array as `name=( a b ) `); then the words, after another `PS4` for
/// a builtin or a function (which trace themselves), on the same line for
/// an external command. Words through `quotedzputs`, the precommand
/// modifiers left out; a typeset-family builtin shows its assignment
/// arguments as `name=value` and `name=( a b )`.
fn trace_zsh(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	unit: &Unit,
	assigns: &[ir::AssignOp],
	line: u32,
) {
	let q = xtrace::ZshQuote::of(k, cx, vp);
	let mut out = xtrace::ps4(k, cx, vp, line);
	let s = st(vp);
	for (i, (index, value)) in s.values.iter().enumerate() {
		// A skipped (readonly) prefix assignment, `set -k` words.
		let Some(a) = assigns.get(i) else {
			break;
		};
		if index.as_ref().is_some_and(|i| i.is_empty()) {
			continue;
		}
		out.extend_from_slice(&a.name);
		if let Some(w) = a.index {
			out.push(b'[');
			out.extend_from_slice(exec::word_source(unit, w));
			out.push(b']');
		}
		out.extend_from_slice(if a.append { b"+=" } else { b"=" });
		match value {
			AssignValue::Scalar(v) => q.push(&mut out, v),
			AssignValue::Array(items) => {
				out.extend_from_slice(b"( ");
				for (_, _, v) in items {
					q.push(&mut out, v);
					out.push(b' ');
				}
				out.push(b')');
			},
		}
		out.push(b' ');
	}
	let argv = s.argv.clone();
	let compound = s.compound.clone();
	let prefixed = !s.values.is_empty();
	if argv.is_empty() {
		out.push(b'\n');
		xtrace::write(k, cx, vp, out);
		return;
	}
	// zsh `execcmd`'s precommand modifiers are not shown.
	let mut first = 0;
	while let Some(w) = argv.get(first) {
		let next_is_option = argv.get(first + 1).is_some_and(|n| n.starts_with(b"-"));
		match w.as_slice() {
			b"-" | b"noglob" | b"nocorrect" | b"builtin" => first += 1,
			b"command" | b"exec" if !next_is_option => first += 1,
			_ => break,
		}
	}
	let words = &argv[first..];
	let Some(name) = words.first() else {
		out.push(b'\n');
		xtrace::write(k, cx, vp, out);
		return;
	};
	// Assignment arguments only when the typeset word was the command
	// itself (a reserved word, not after `builtin`).
	let decl = first == 0
		&& matches!(
			name.as_slice(),
			b"typeset"
				| b"declare"
				| b"local"
				| b"export"
				| b"readonly"
				| b"integer"
				| b"float"
				| b"private"
		);
	let callable = prefixed && {
		IntrinsicId::from_name(name).is_some()
			|| state::record(cx.store, vp, Key::Func(BStr::new(name))).is_ok_and(|r| r.is_some())
	};
	if callable {
		out.extend_from_slice(&xtrace::ps4(k, cx, vp, line));
	}
	for (i, w) in words.iter().enumerate() {
		if i > 0 {
			out.push(b' ');
		}
		let eq = w.iter().position(|&c| c == b'=');
		match eq {
			Some(eq) if decl && i > 0 && eq > 0 && decl_name(&w[..eq]) => {
				out.extend_from_slice(&w[..=eq]);
				let v = &w[eq + 1..];
				if compound.contains(&(i as u32)) && v.starts_with(b"(") && v.ends_with(b")") {
					out.push(b'(');
					let elems = builtins::parse_compound(&v[1..v.len() - 1]);
					let kv = elems.iter().any(|(k, ..)| k.is_some());
					for (key, _, v) in elems {
						if let Some(key) = key.filter(|_| kv) {
							out.push(b'[');
							q.push(&mut out, &key);
							out.extend_from_slice(b"]=");
						} else {
							out.push(b' ');
						}
						q.push(&mut out, &v);
					}
					out.extend_from_slice(b" )");
				} else {
					q.push(&mut out, v);
				}
			},
			_ => q.push(&mut out, w),
		}
	}
	out.push(b'\n');
	xtrace::write(k, cx, vp, out);
}

/// A typeset assignment argument's name: an identifier, with a subscript
/// (`a[1]=x`).
fn decl_name(name: &[u8]) -> bool {
	let id = name
		.iter()
		.take_while(|&&c| c == b'_' || c.is_ascii_alphanumeric())
		.count();
	id > 0 && (id == name.len() || (name[id] == b'[' && name.ends_with(b"]")))
}

/// A compound element's source text as bash's parser keeps it: each
/// unquoted `$'…'` decoded and single-quoted (`$'\t'` → `'<TAB>'`); the
/// rest as written.
fn parsed_source(src: &[u8]) -> Vec<u8> {
	let mut out = Vec::with_capacity(src.len());
	let mut i = 0;
	while i < src.len() {
		match src[i] {
			b'\\' => {
				let end = (i + 2).min(src.len());
				out.extend_from_slice(&src[i..end]);
				i = end;
			},
			b'\'' => {
				let end = src[i + 1..]
					.iter()
					.position(|&c| c == b'\'')
					.map_or(src.len(), |p| i + p + 2);
				out.extend_from_slice(&src[i..end]);
				i = end;
			},
			b'"' => {
				let mut j = i + 1;
				while j < src.len() && src[j] != b'"' {
					j += if src[j] == b'\\' { 2 } else { 1 };
				}
				let end = (j + 1).min(src.len());
				out.extend_from_slice(&src[i..end]);
				i = end;
			},
			b'$' if src.get(i + 1) == Some(&b'\'') => {
				let mut j = i + 2;
				while j < src.len() && src[j] != b'\'' {
					j += if src[j] == b'\\' { 2 } else { 1 };
				}
				let body = &src[i + 2..j.min(src.len())];
				out.extend_from_slice(&super::quote::sh_single_quote(&ir::ansi_c(body)));
				i = (j + 1).min(src.len());
			},
			c => {
				out.push(c);
				i += 1;
			},
		}
	}
	out
}

/// A declaration argument with a compound value (`local -a f=(*)`) before
/// pathname expansion of its elements: its argv index, the text before
/// `(`, the elements and their patterns.
struct DeclArg {
	at:     u32,
	prefix: Vec<u8>,
	elems:  Vec<CompoundElem>,
	globs:  Vec<(u32, BString)>,
}

fn assign_parks(unit: &Unit, a: &ir::AssignOp) -> bool {
	let word = |w: u32| unit.words[w as usize].parks;
	a.index.is_some_and(word)
		|| match &a.value {
			AssignVal::Scalar(w) => word(*w),
			AssignVal::Array(elems) => elems
				.iter()
				.any(|e| e.key.is_some_and(word) || word(e.value)),
		}
}

/// A shell assignment (`NAME=value` without a command), including the
/// `BASH_ALIASES[name]=value` alias form.
fn assign_now(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	name: &[u8],
	index: Option<&[u8]>,
	append: bool,
	value: AssignValue,
) -> Result<(), Diag> {
	if name == b"BASH_ALIASES"
		&& let (Some(alias), AssignValue::Scalar(text)) = (index, &value)
	{
		if !builtins::legal_alias_name(alias) {
			return Err(Diag::InvalidAlias { name: alias.into() });
		}
		state::store_record(
			&mut k.root,
			cx.store,
			vp,
			KeyBuf::Alias(alias.into()),
			Some(Record::Alias(text.clone())),
		);
		return Ok(());
	}
	builtins::set_value(k, cx, vp, Lhs { name, index, append }, value, Level::Dynamic)
}

/// The host's resolution of `name` with this shell's builtin table applied:
/// a builtin `enable -n` disabled is not found, a loaded one (`enable -f`)
/// is a builtin.
fn resolve(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &Vproc,
	name: &[u8],
	mode: crate::bash::ids::ModeId,
	rctx: ResolveCtx,
) -> Result<Resolved, StoreError> {
	let resolved = cx.host.resolve(BStr::new(name), mode, rctx);
	let host = match resolved {
		Resolved::Intrinsic(id) => Some(id),
		_ => None,
	};
	Ok(match builtins::misc::usable(k, cx.store, vp, name, host)? {
		Some(id) => Resolved::Intrinsic(id),
		None if host.is_some() => Resolved::NotFound,
		None => resolved,
	})
}

/// Resolve the command name: `command`/`builtin` prefixes, functions,
/// the host's table, then a PATH search through the pollable `Fs`.
fn lookup(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>, op: Op, typeset: bool) -> Option<Flow> {
	// `command -p`: the search uses the standard utilities' path and not the
	// hash table (decided while the name resolves; the search starts in the
	// same turn).
	let mut std_path = false;
	if st(vp).target.is_none() {
		let zsh = vp.mode.dialect() == crate::bash::ids::Dialect::Zsh;
		if zsh {
			zsh_precommands(vp);
			zsh_autoresume(k, cx, vp);
		}
		// zsh `command NAME` runs an external (zsh `BINF_COMMAND`) unless
		// `posixbuiltins`.
		let mut external_only = false;
		let mode = exec::mode_of(vp);
		let posix = state::option(&mut k.root, cx.store, vp, crate::bash::store::OptId::Posix)
			.unwrap_or(false);
		let mut via = Via::Plain;
		let target = loop {
			// Borrowed (the resolution only reads `vp`): no copy of the
			// name per command.
			let name = &current_argv(vp)[0];
			let has_slash = name.contains(&b'/')
				|| (k.engine.config().platform == crate::bash::ids::Platform::Windows
					&& name.contains(&b'\\'));
			// zsh's reserved `typeset`, `local`, …: their builtin even when
			// disabled, before any function of the name (`execcmd_exec`
			// with `WC_TYPESET`).
			if zsh && typeset && via == Via::Plain {
				let rctx = ResolveCtx { has_slash, via };
				if let Resolved::Intrinsic(id) = cx.host.resolve(BStr::new(name), mode, rctx) {
					break Resolved::Intrinsic(id).into();
				}
			}
			if external_only {
				break if has_slash {
					Target::External(absolute(&vp.cwd, name))
				} else {
					Target::Search
				};
			}
			// POSIX: special builtins are found before functions.
			let special = if posix && !has_slash {
				let rctx = ResolveCtx { has_slash, via };
				match resolve(k, cx, vp, name, mode, rctx) {
					Ok(resolved) => matches!(resolved, Resolved::Intrinsic(id) if is_special(id)),
					Err(err) => {
						k.fail(err);
						return Some(Flow::Discard(1));
					},
				}
			} else {
				false
			};
			// Outside posix mode a function name may contain a slash.
			if via == Via::Plain && (!has_slash || !posix) && !special {
				let found = match state::record(cx.store, vp, Key::Func(BStr::new(name))) {
					Ok(Some(Record::Func { .. })) => true,
					Ok(_) => false,
					Err(err) => {
						k.fail(err);
						return Some(Flow::Discard(1));
					},
				};
				if found && (!zsh || !zsh_disabled(cx.store, vp, name)) {
					break Target::Function(name.clone());
				}
			}
			let rctx = ResolveCtx { has_slash, via };
			let resolved = match resolve(k, cx, vp, name, mode, rctx) {
				Ok(resolved) => resolved,
				Err(err) => {
					k.fail(err);
					return Some(Flow::Discard(1));
				},
			};
			let ExecState { argv, arrayref, .. } = st(vp);
			match resolved {
				Resolved::Intrinsic(IntrinsicId::Command)
					if argv.len() > 1
						&& argv[1..]
							.iter()
							.find(|a| !matches!(a.as_slice(), b"-p" | b"--"))
							.is_some_and(|a| !a.starts_with(b"-")) =>
				{
					argv.remove(0);
					shift_arrayref(arrayref);
					while argv.len() > 1 && matches!(argv[0].as_slice(), b"-p" | b"--") {
						std_path |= argv[0].as_slice() == b"-p";
						argv.remove(0);
						shift_arrayref(arrayref);
					}
					external_only = zsh
						&& !state::zsh_option(&mut k.root, cx.store, vp, ZshOpt::Posixbuiltins)
							.unwrap_or(false);
					via = if std_path {
						Via::CommandP
					} else {
						Via::Command
					};
				},
				Resolved::Intrinsic(IntrinsicId::Builtin) if argv.len() > 1 => {
					argv.remove(0);
					shift_arrayref(arrayref);
					if argv[0].as_slice() == b"--" && argv.len() > 1 {
						argv.remove(0);
						shift_arrayref(arrayref);
					} else if argv[0].len() > 1 && argv[0][0] == b'-' && argv[0].as_slice() != b"--" {
						// `builtin` takes no options.
						let msg = format!("-{}: invalid option", argv[0][1] as char).into();
						let line = line_of(vp, op.node);
						k.diag(cx, vp, line, Diag::Usage { msg }.by("builtin"));
						vp.out.push_back(PendingWrite {
							fd:    2,
							bytes: BString::from("builtin: usage: builtin [shell-builtin [arg ...]]\n"),
							off:   0,
						});
						let s = st(vp);
						s.status = 2;
						s.stage = Stage::Finish;
						return None;
					}
					via = Via::Builtin;
				},
				_ if via == Via::Builtin && !matches!(resolved, Resolved::Intrinsic(_)) => {
					let name = argv[0].clone();
					let line = line_of(vp, op.node);
					k.diag(cx, vp, line, Diag::NotABuiltin { name }.by("builtin"));
					let s = st(vp);
					s.status = 1;
					s.stage = Stage::Finish;
					return None;
				},
				Resolved::NotFound if has_slash => {
					let name = argv[0].clone();
					if zsh && zsh_path_dirs(k, cx, vp, &name) {
						break Target::Search;
					}
					break Target::External(absolute(&vp.cwd, &name));
				},
				Resolved::NotFound => break Target::Search,
				other => break other.into(),
			}
		};
		let s = st(vp);
		s.target = Some(target);
		s.via_command = matches!(via, Via::Command | Via::CommandP);
	}
	if st(vp).target == Some(Target::Search) {
		// File-system probes: `CmdExpanded` reads the clock after them.
		k.clock_stale();
		// bash's `search_for_command`: a `PATH` in the command's temporary
		// environment bypasses the hash table (lookup and insertion); on
		// Windows `PATHEXT` changes the same answer.
		let windows = k.engine.config().platform == crate::bash::ids::Platform::Windows;
		let temp_path = st(vp)
			.assigns
			.iter()
			.any(|(n, _)| n.as_slice() == b"PATH" || (windows && n.as_slice() == b"PATHEXT"));
		let mut sc = exec::take_scratch(vp);
		let name = sc.exec.as_ref().map_or_default(|e| e.argv[0].clone());
		if sc.io.as_ref().is_none_or(|io| io.search.is_none()) {
			let hashed = if std_path || temp_path {
				None
			} else {
				match state::record(cx.store, vp, Key::CmdHash(BStr::new(&name))) {
					Ok(Some(Record::CmdHash { path, hits })) => Some((path.clone(), *hits)),
					_ => None,
				}
			};
			let checkhash =
				state::option(&mut k.root, cx.store, vp, crate::bash::store::OptId::Checkhash)
					.unwrap_or(false);
			match hashed {
				// bash runs a hashed name without searching PATH.
				Some((path, hits)) if !checkhash => {
					let rec = Record::CmdHash { path: path.clone(), hits: hits.saturating_add(1) };
					let key = KeyBuf::CmdHash(name.clone());
					state::store_record(&mut k.root, cx.store, vp, key, Some(rec));
					// `hash` keeps bash's display path (`./e` for an empty
					// PATH entry): a file relative to the shell's cwd.
					let target = absolute(&vp.cwd, &path);
					sc.exec.as_mut().expect("exec").target = Some(Target::External(target));
				},
				hashed => {
					let path = if std_path {
						BString::from(probe::standard_path(k.engine.config().platform))
					} else {
						state::lookup(&k.root, cx.store, vp, b"PATH")
							.ok()
							.flatten()
							.and_then(|v| v.as_scalar().map(BString::from))
							.unwrap_or_default()
					};
					// `checkhash`: the hashed path first, if it is still an
					// executable file.
					// zsh `pathdirs` (a name with a slash searched): the name
					// itself first.
					let mut cands: Vec<BString> = hashed
						.map(|(p, _)| absolute(&vp.cwd, &p))
						.into_iter()
						.chain(
							(vp.mode.dialect() == crate::bash::ids::Dialect::Zsh && name.contains(&b'/'))
								.then(|| absolute(&vp.cwd, &name)),
						)
						.collect();
					let extensions = probe::executable_extensions(k, cx, vp);
					cands.extend(candidates(
						&path,
						&name,
						&vp.cwd,
						k.engine.config().platform,
						&extensions,
					));
					sc.io().search =
						Some(PathSearch { cands, idx: 0, checking_exec: false, nonexec: None });
				},
			}
		}
		// A hashed name ran without a search (its target is set).
		let found = if sc.io.as_ref().is_some_and(|io| io.search.is_some()) {
			let mut tcx = Context::from_waker(&k.waker);
			Some(probe::path_search(&mut tcx, cx, &mut sc))
		} else {
			None
		};
		let flow = match found {
			None => None,
			Some(Search::Found(path)) => {
				sc.io().search = None;
				// bash hashes every command it finds in PATH (not with a
				// temporary PATH).
				// zsh `pathdirs` names (with a slash) are not hashed.
				if !temp_path
					&& (vp.mode.dialect() != crate::bash::ids::Dialect::Zsh || !name.contains(&b'/'))
					&& state::option(&mut k.root, cx.store, vp, crate::bash::store::OptId::Hashall)
						.unwrap_or(true)
				{
					let hits = match state::record(cx.store, vp, Key::CmdHash(BStr::new(&name))) {
						Ok(Some(Record::CmdHash { path: old, hits })) if *old == path => {
							hits.saturating_add(1)
						},
						_ => 1,
					};
					let rec = Record::CmdHash { path: path.clone(), hits };
					state::store_record(&mut k.root, cx.store, vp, KeyBuf::CmdHash(name), Some(rec));
				}
				sc.exec.as_mut().expect("exec").target = Some(Target::External(path));
				None
			},
			Some(Search::NotFound) => {
				sc.io().search = None;
				// The host's stand-in for a missing tool, unless a not-found
				// hook handles it; `exec` keeps its not-found handling (a
				// process image cannot be a native).
				let exec = sc.exec.as_ref().expect("exec");
				let target = if exec.exec_as.is_none()
					&& !has_not_found_hook(cx, vp)
					&& let Some(native) = cx.host.fallback(BStr::new(&name))
				{
					Target::Native(native)
				} else {
					Target::NotFound
				};
				sc.exec.as_mut().expect("exec").target = Some(target);
				None
			},
			Some(Search::Pending(key)) => Some(Flow::Block(key)),
		};
		vp.frames.last_mut().expect("frame").scratch = Some(sc);
		if flow.is_some() {
			return flow;
		}
	}
	st(vp).stage = Stage::Dispatch;
	if k.mask.contains(crate::bash::event::EventKind::CmdExpanded)
		&& let Some(e) = current_exec(vp)
	{
		// Borrowed from the command's state, stamped with its start when
		// only in-engine expansion ran since (`Kernel::stamp`).
		let t_ns = k.stamp(cx);
		let resolved = e
			.target
			.as_ref()
			.map_or(ResolvedKind::NotFound, Target::kind);
		let data =
			EventData::CmdExpanded { argv: &e.argv, assigns: &e.assigns, redirs: &[], resolved };
		k.emit_op_at(cx, vp, op.node, data, t_ns);
	}
	None
}

/// Prefix assignments as variables of a temporary or function scope; in
/// zsh a prompt name's other names (`PS1`/`PROMPT`, `RPS1`/`RPROMPT`, …)
/// take the value too, as they share one variable there.
fn scope_vars(
	zsh: bool,
	values: &[(Option<BString>, AssignValue)],
	names: &[(BString, BString)],
) -> VarMap {
	let mut vars = VarMap::default();
	for ((index, value), (name, _)) in values.iter().zip(names) {
		if index.is_some() {
			continue;
		}
		// A call's prefix assignment, not a local (posix special builtins
		// in the function assign through it).
		let mut var = prefix_var(value);
		var.attrs = var.attrs.with(Attrs::TEMP);
		for &other in prompt_siblings(zsh, name) {
			if !names.iter().any(|(n, _)| n.as_slice() == other) {
				vars.insert(BString::from(other), Some(var.clone()));
			}
		}
		vars.insert(name.clone(), Some(var));
	}
	vars
}

/// The other names of the zsh prompt special `name` ([`PROMPT_GROUPS`]);
/// none in bash or for any other name.
///
/// [`PROMPT_GROUPS`]: super::zsh::specials::PROMPT_GROUPS
fn prompt_siblings(
	zsh: bool,
	name: &[u8],
) -> impl Iterator<Item = &'static &'static [u8]> + use<'_> {
	let group: &'static [&'static [u8]] = if zsh {
		super::zsh::specials::prompt_group(name)
	} else {
		&[]
	};
	group.iter().filter(move |&&n| n != name)
}

/// A prefix assignment's value as a variable of a temporary or function
/// scope.
fn prefix_var(value: &AssignValue) -> Var {
	match value {
		AssignValue::Scalar(v) => Var::scalar(v.clone(), Attrs::EXPORT),
		AssignValue::Array(items) => Var {
			attrs: Attrs::NONE,
			value: VarValue::Indexed(
				items
					.iter()
					.enumerate()
					.map(|(i, (_, _, v))| (i as i64, v.clone()))
					.collect(),
			),
		},
	}
}

/// Start the resolved command.
fn dispatch(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>, op: Op, line: u32) -> Option<Flow> {
	let target = st(vp).target.clone().unwrap_or(Target::NotFound);
	// The command name, for diagnostics only.
	let argv0 = |vp: &mut Vproc| st(vp).argv[0].clone();
	let jobspec = st(vp).exec_as.is_none() && st(vp).argv[0].starts_with(b"%");
	if !k.bangs.is_empty() {
		let exec = st(vp).exec_as.is_some();
		bang_dispatch(k, vp.vpid, &target, exec);
	}
	if vp.mode.dialect() == crate::bash::ids::Dialect::Zsh
		&& !matches!(target, Target::Function(_) | Target::Intrinsic(_))
		&& zsh_restricted_external(k, vp, cx, line)
	{
		return None;
	}
	// zsh `addvars` sets a prefix `UID=…` through the special: an id the
	// shell cannot take fails a builtin or function in the shell (the
	// list is abandoned) and an external command in its child (status 1).
	if vp.mode.dialect() == crate::bash::ids::Dialect::Zsh
		&& let Some(d) = zsh_prefix_ids(k, vp, cx, line)
	{
		k.diag(cx, vp, line, d);
		if matches!(target, Target::Function(_) | Target::Intrinsic(_)) {
			return Some(Flow::Discard(1));
		}
		let s = st(vp);
		s.status = 1;
		s.stage = Stage::Output;
		return None;
	}
	match target {
		Target::Function(fname) => call_function(k, vp, cx, op, line, fname),
		Target::Intrinsic(id) => run_builtin(k, vp, cx, line, id),
		Target::NotFound | Target::Search if jobspec => {
			// A jobspec as a command is `fg jobspec` (bash).
			run_builtin(k, vp, cx, line, IntrinsicId::Fg)
		},
		Target::NotFound | Target::Search if st(vp).exec_as.is_some() => {
			// bash's `exec`: a name not found that is a directory "cannot
			// execute" (126).
			let name = argv0(vp);
			let path = absolute(&vp.cwd, &name);
			let dir = match command_probe(k, cx, vp, &Probe::Stat { path, follow: true }) {
				Err(key) => return Some(Flow::Block(key)),
				Ok(ProbeResult::Stat(Some(st))) => st.kind == StatKind::Dir,
				Ok(_) => false,
			};
			let (msg, status) = if dir {
				(format!("{name}: cannot execute: Is a directory"), 126)
			} else {
				(format!("{name}: not found"), 127)
			};
			k.diag(cx, vp, line, Diag::Usage { msg: msg.into() }.by("exec"));
			let s = st(vp);
			s.status = status;
			s.stage = Stage::Output;
			exec_failed(k, cx, vp);
			None
		},
		Target::NotFound | Target::Search => {
			if let Some(flow) = not_found_hook(k, vp, cx, line) {
				return Some(flow);
			}
			let name = argv0(vp);
			k.diag(cx, vp, line, Diag::CommandNotFound { name });
			let s = st(vp);
			s.status = 127;
			// The message goes to the command's own (redirected) stderr:
			// `nosuch 2>/dev/null` prints nothing.
			s.stage = Stage::Output;
			None
		},
		Target::SelfShell => match build_env(k, cx, vp) {
			Ok(env) => super::nested::start(k, vp, cx, line, &env),
			Err(err) => {
				k.fail(err);
				Some(Flow::Discard(1))
			},
		},
		Target::Refused { path, code } => refused(k, vp, cx, line, &path, code),
		Target::Tool(tool) => {
			let (env, umask) =
				match build_env(k, cx, vp).and_then(|env| Ok((env, state::umask(cx.store, vp)?))) {
					Ok(v) => v,
					Err(err) => {
						k.fail(err);
						return Some(Flow::Discard(1));
					},
				};
			let id = CallId(k.next_call);
			k.next_call += 1;
			let (argv, tag) = {
				let s = st(vp);
				(s.argv.clone(), s.tag)
			};
			let call = ToolCall {
				tool,
				argv,
				vpid: vp.vpid,
				tag,
				cwd: vp.cwd.clone(),
				stdio: [vp.fds.handle(0), vp.fds.handle(1), vp.fds.handle(2)],
				extra_fds: extra_fds(vp),
				env,
				umask,
			};
			k.emit_op(cx, vp, op.node, EventData::Call { id, argv: &call.argv });
			k.calls_out.push_back((id, call));
			let s = st(vp);
			s.waiting = Some(Awaited::Call(id));
			s.stage = Stage::Await;
			Some(Flow::Block(WaitKey::Call(id)))
		},
		Target::Native(native) | Target::Device(native) => {
			let (env, umask) =
				match build_env(k, cx, vp).and_then(|env| Ok((env, state::umask(cx.store, vp)?))) {
					Ok(v) => v,
					Err(err) => {
						k.fail(err);
						return Some(Flow::Discard(1));
					},
				};
			let extra = extra_fds(vp);
			let argv = st(vp).argv.clone();
			let tag = st(vp).tag;
			let inv = Invocation {
				argv: &argv,
				env: &env,
				cwd: BStr::new(&vp.cwd),
				stdio: [vp.fds.handle(0), vp.fds.handle(1), vp.fds.handle(2)],
				extra_fds: &extra,
				tag,
				vpid: vp.vpid,
				umask,
			};
			match cx.host.start(&native, inv) {
				Ok(task) => {
					scratch(vp).live = Live::Task(task);
					let s = st(vp);
					s.waiting = Some(Awaited::Task(native));
					s.stage = Stage::Await;
					k.emit_op(cx, vp, op.node, EventData::TaskStart { native, argv: &argv });
				},
				Err(err) => {
					let name = argv0(vp);
					k.diag(cx, vp, line, Diag::StartFailed { name, err });
					let s = st(vp);
					s.status = 126;
					s.stage = Stage::Output;
					exec_failed(k, cx, vp);
				},
			}
			None
		},
		Target::External(path) | Target::Interp(path) => {
			// zsh: the interpreter run for a refused script fails as it is.
			let interp = matches!(st(vp).target, Some(Target::Interp(_)));
			// A spawn the host has not finished (`Live::Spawn`) is polled again
			// as it is: its redirections and job id were handed over with the
			// first call.
			if let Live::Spawn(pending) = &mut scratch(vp).live {
				let mut tcx = Context::from_waker(&k.waker);
				return match pending.as_mut().poll(&mut tcx) {
					Poll::Pending => Some(Flow::Block(WaitKey::Spawn { path })),
					Poll::Ready(spawned) => {
						scratch(vp).live = Live::None;
						let s = st(vp);
						let argv = spawn_argv(&s.argv, s.exec_as.as_deref());
						let child_redirs = k
							.deferral(vp.vpid)
							.is_some_and(|d| d.phase == DeferPhase::Collect);
						spawned_external(k, vp, cx, op, line, spawned, Spawned {
							path,
							interp,
							child_redirs,
							argv: &argv,
						})
					},
				};
			}
			let exec_as = st(vp).exec_as.clone();
			let env = if exec_as.as_ref().is_some_and(|e| e.clear_env) {
				EnvView::new(Vec::new())
			} else {
				match build_env(k, cx, vp) {
					Ok(env) => env,
					Err(err) => {
						k.fail(err);
						return Some(Flow::Discard(1));
					},
				}
			};
			let umask = match state::umask(cx.store, vp) {
				Ok(umask) => umask,
				Err(err) => {
					k.fail(err);
					return Some(Flow::Discard(1));
				},
			};
			let traps = match state::scan(&k.root, cx.store, vp, crate::bash::store::Table::Trap) {
				Ok(traps) => traps,
				Err(err) => {
					k.fail(err);
					return Some(Flow::Discard(1));
				},
			};
			let mut sigmask_ign = SigSet::EMPTY;
			for (key, record) in traps {
				if let (
					crate::bash::store::KeyBuf::Trap(crate::bash::store::TrapKey::Signal(sig)),
					Record::Trap { action, .. },
				) = (key, record)
					&& action.is_empty()
				{
					sigmask_ign = sigmask_ign.with(sig);
				}
			}
			let job = k.job_id(cx.store);
			let pgroup = super::jobctl::pgroup(k, cx, vp, job);
			let argv = spawn_argv(&st(vp).argv, exec_as.as_deref());
			let (argv, env) = if vp.mode.dialect() == crate::bash::ids::Dialect::Zsh {
				zsh_argv0(k, cx, vp, argv, env)
			} else {
				(argv, env)
			};
			let tag = st(vp).tag;
			// The redirections left to the process (`deferred_resolved`). Copied,
			// not taken: a spawn dropped before it finished (a suspend) is asked
			// for again with the same list.
			let redirs = match k.deferral(vp.vpid) {
				Some(d) if d.phase == DeferPhase::Collect => Some(d.list.clone()),
				_ => None,
			};
			let redirs = redirs.map(|list| {
				let name = argv0(vp);
				ChildRedirs { list, exec_diag: super::redir::diag_prefix(k, cx, vp, line, &name) }
			});
			let child_redirs = redirs.is_some();
			let spec = SpawnSpec {
				path: BStr::new(&path),
				argv: &argv,
				env: &env,
				cwd: BStr::new(&vp.cwd),
				stdio: [
					stdio_spec(&vp.fds.handle(0), false),
					stdio_spec(&vp.fds.handle(1), true),
					stdio_spec(&vp.fds.handle(2), true),
				],
				extra_fds: extra_fds(vp)
					.iter()
					.map(|(fd, h)| (*fd, stdio_spec(h, false)))
					.collect(),
				pgroup,
				tag,
				vpid: vp.vpid,
				umask,
				sigmask_ign,
				rlimits: &vp.rlimits,
				lineage: vp.lineage,
				redirs,
				ctty: vp
					.zsh
					.as_deref()
					.and_then(|z| z.ctty.0.as_ref())
					.and_then(crate::bash::fd::FdRef::os_handle),
			};
			let mut pending = cx.host.spawn(spec);
			let mut tcx = Context::from_waker(&k.waker);
			match pending.as_mut().poll(&mut tcx) {
				Poll::Ready(spawned) => spawned_external(k, vp, cx, op, line, spawned, Spawned {
					path,
					interp,
					child_redirs,
					argv: &argv,
				}),
				Poll::Pending => {
					scratch(vp).live = Live::Spawn(pending);
					Some(Flow::Block(WaitKey::Spawn { path }))
				},
			}
		},
		Target::Script(path) => run_script_file(k, vp, cx, line, path),
	}
}

/// zsh `execute`: an `ARGV0` in an external command's environment is its
/// `argv[0]` and leaves the environment (not under `restricted`).
#[inline(never)]
fn zsh_argv0(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &Vproc,
	mut argv: Vec<BString>,
	env: EnvView,
) -> (Vec<BString>, EnvView) {
	if state::zsh_option(&mut k.root, cx.store, vp, ZshOpt::Restricted).unwrap_or(false) {
		return (argv, env);
	}
	let Some(name) = env.get(b"ARGV0").map(BString::from) else {
		return (argv, env);
	};
	if let Some(a0) = argv.first_mut() {
		*a0 = name;
	}
	let pairs = env
		.iter()
		.filter(|(n, _)| &n[..] != b"ARGV0")
		.map(|(n, v)| (BString::from(n), BString::from(v)))
		.collect();
	(argv, EnvView::new(pairs))
}

/// `argv` as an external gets it: `exec -a name` and `exec -l` apply.
fn spawn_argv(argv: &[BString], exec_as: Option<&ExecAs>) -> Vec<BString> {
	let mut argv = argv.to_vec();
	if let Some(how) = exec_as {
		if let Some(name) = &how.argv0 {
			argv[0].clone_from(name);
		}
		if how.login {
			argv[0].insert(0, b'-');
		}
	}
	argv
}

/// What [`spawned_external`] needs of the dispatch that asked the host.
struct Spawned<'a> {
	/// The program, as resolved.
	path:         BString,
	/// The program is the interpreter of a refused script (zsh).
	interp:       bool,
	/// The process applies the command's redirections itself.
	child_redirs: bool,
	/// The argument vector the process was given.
	argv:         &'a [BString],
}

/// Apply the host's answer to [`Host::spawn`](crate::bash::Host::spawn):
/// the command awaits the process, or the refusal is retried or reported.
fn spawned_external(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	op: Op,
	line: u32,
	spawned: std::io::Result<Box<dyn crate::bash::ExtProc>>,
	how: Spawned<'_>,
) -> Option<Flow> {
	let Spawned { path, interp, child_redirs, argv } = how;
	// A refused spawn (retried as a script, or reported) never makes the
	// job a program: its `$!` readers need not wait for the rest.
	if spawned.is_err() && !k.bangs.is_empty() {
		k.settle_bang(vp.vpid, None);
	}
	match spawned {
		Err(_) if child_redirs => {
			// The redirections are applied here after all, then the spawn
			// is tried again (and fails as it would have).
			if let Some(d) = k.deferral(vp.vpid) {
				d.phase = DeferPhase::Resume;
				d.list.clear();
				let from = d.from;
				scratch(vp).io().redir.done = from;
			}
			st(vp).stage = Stage::Redirect;
		},
		Ok(child) => {
			k.forget_deferral(vp.vpid);
			super::jobctl::spawned(k, vp, child.as_ref());
			let pid = child.pid();
			// The job this vproc may still settle is known by its program
			// (`bang_dispatch` let only its lone or `exec`'d external
			// through).
			if !k.bangs.is_empty() {
				k.settle_bang(vp.vpid, Some(pid));
			}
			scratch(vp).live = Live::Ext(child);
			let s = st(vp);
			s.waiting = Some(Awaited::Ext { pid });
			s.stage = Stage::Await;
			k.emit_op(cx, vp, op.node, EventData::Spawn { pid, argv });
		},
		Err(err)
			if vp.mode.dialect() == crate::bash::ids::Dialect::Zsh
				&& !interp
				&& (is_enoexec(&err) || err.kind() == std::io::ErrorKind::NotFound)
				&& err.raw_os_error().is_some() =>
		{
			// zsh `zexecve` looks at the file (`#!` line): retried as
			// `Target::Refused` (stage stays `Dispatch`).
			let code = err.raw_os_error().unwrap_or_default();
			st(vp).target = Some(Target::Refused { path, code });
		},
		Err(err) if is_enoexec(&err) && !interp => {
			// Retried as `Target::Script` (stage stays `Dispatch`).
			st(vp).target = Some(Target::Script(path));
		},
		Err(err) if vp.mode.dialect() == crate::bash::ids::Dialect::Zsh => {
			// zsh `execute`: `%e: NAME` with the name as written;
			// 126 for `EACCES` and `ENOEXEC`, else 127.
			let name = st(vp).argv[0].clone();
			let msg = format!("{}: {name}", super::redir::zsh_errno(&err)).into();
			k.diag(cx, vp, line, Diag::Usage { msg });
			let s = st(vp);
			s.status = if err.kind() == std::io::ErrorKind::PermissionDenied || is_enoexec(&err) {
				126
			} else {
				127
			};
			s.stage = Stage::Output;
			exec_failed(k, cx, vp);
		},
		Err(err) if err.raw_os_error().is_some() => {
			// bash's `shell_execve` looks at the file to explain the
			// refusal: retried as `Target::Refused` (stage stays
			// `Dispatch`), which probes it.
			let code = err.raw_os_error().unwrap_or_default();
			st(vp).target = Some(Target::Refused { path, code });
		},
		Err(err) => {
			// bash names the file it tried: the PATH (or hash table)
			// result, a name with `/` as written.
			let name = st(vp).argv[0].clone();
			let name = if name.contains(&b'/') { name } else { path };
			let (diag, status) = spawn_error(name, err);
			k.diag(cx, vp, line, diag);
			let s = st(vp);
			s.status = status;
			// Written while the command's redirections are in place
			// (`exec ./file 2>/dev/null` prints nothing).
			s.stage = Stage::Output;
			exec_failed(k, cx, vp);
		},
	}
	None
}

/// The failure of a prefix assignment to `UID`, `EUID`, `GID` or `EGID`
/// ([`super::zsh::specials::check_id_prefix`]). Out of line: zsh only.
#[inline(never)]
fn zsh_prefix_ids(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>, line: u32) -> Option<Diag> {
	let s = st(vp);
	let ids: Vec<(BString, BString)> = s
		.assigns
		.iter()
		.zip(&s.values)
		.filter_map(|((n, _), (index, v))| match v {
			AssignValue::Scalar(text)
				if index.is_none() && matches!(n.as_slice(), b"UID" | b"EUID" | b"GID" | b"EGID") =>
			{
				Some((n.clone(), text.clone()))
			},
			_ => None,
		})
		.collect();
	if ids.is_empty() {
		return None;
	}
	let mut log = Vec::new();
	let ex = super::expand::Expander::new(k, cx, vp, &mut log, false, line);
	for (name, value) in ids {
		if let Err(super::expand::Stop::Fail(d) | super::expand::Stop::Fatal(d)) =
			super::zsh::specials::check_id_prefix(&ex, &name, &value)
		{
			return Some(d);
		}
	}
	None
}

/// zsh `addvars` (`ADDVAR_RESTRICT`) and `execute`: under `restricted` an
/// external command neither gets a restricted parameter in its environment
/// nor runs when named by a path. `true`: refused (reported, status 1).
/// Out of line: zsh only, off the bash dispatch path.
#[inline(never)]
fn zsh_restricted_external(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>, line: u32) -> bool {
	if !state::zsh_option(&mut k.root, cx.store, vp, ZshOpt::Restricted).unwrap_or(false) {
		return false;
	}
	let s = st(vp);
	let what = s
		.assigns
		.iter()
		.map(|(n, _)| n)
		.find(|n| super::zsh::params::is_restricted(n))
		.or_else(|| Some(&s.argv[0]).filter(|a| a.contains(&b'/')))
		.cloned();
	let Some(what) = what else {
		return false;
	};
	let msg = format!("{what}: restricted").into();
	k.diag(cx, vp, line, Diag::Usage { msg });
	let s = st(vp);
	s.status = 1;
	s.stage = Stage::Output;
	true
}

/// Push a function frame with its scope (positional parameters, prefix
/// assignments as locals).
fn call_function(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	op: Op,
	line: u32,
	name: BString,
) -> Option<Flow> {
	let depth = vp
		.frames
		.iter()
		.filter(|f| matches!(f.kind, FrameKind::Function { .. }))
		.count() as u32;
	if vp.mode.dialect() == crate::bash::ids::Dialect::Zsh
		&& let Some(flow) = zsh_funcnest(k, vp, cx, line, &name, depth)
	{
		return Some(flow);
	}
	// `FUNCNEST` > 0 lowers the engine's limit; exceeding it abandons the
	// whole command, as bash's `jump_to_top_level (DISCARD)`.
	let funcnest = match state::lookup(&k.root, cx.store, vp, b"FUNCNEST") {
		Ok(v) => v
			.and_then(|v| v.as_scalar())
			.and_then(builtins::number)
			.filter(|&n| n > 0),
		Err(err) => {
			k.fail(err);
			return Some(Flow::Discard(1));
		},
	};
	let limit = k.engine.config().max_call_depth;
	let max = funcnest.map_or(limit, |n| u32::try_from(n).unwrap_or(u32::MAX).min(limit));
	if depth >= max {
		let max = funcnest.map_or(max, |n| u32::try_from(n).unwrap_or(u32::MAX));
		k.diag(cx, vp, line, Diag::FuncNest { name, max });
		return Some(Flow::Discard(1));
	}
	let (unit_id, mode, sticky, file, attrs) =
		match state::record(cx.store, vp, Key::Func(BStr::new(&name))) {
			Ok(Some(Record::Func { unit, mode, sticky, file, attrs, .. })) => {
				(*unit, *mode, sticky.clone(), file.clone(), *attrs)
			},
			Ok(_) => {
				k.diag(cx, vp, line, Diag::CommandNotFound { name });
				let s = st(vp);
				s.status = 127;
				s.stage = Stage::Output;
				return None;
			},
			Err(err) => {
				k.fail(err);
				return Some(Flow::Discard(1));
			},
		};
	// zsh `autoload` stub: load the definition from `$fpath` first.
	if attrs.contains(Attrs::ZSH_UNDEFINED) {
		return autoload(k, vp, cx, op, line, name, mode, attrs, file, sticky);
	}
	let traced = attrs.contains(Attrs::TRACE);
	let warn_nested = attrs.contains(Attrs::ZSH_WARN_NESTED);
	let body = match load_body(k, vp, cx, &name, unit_id, mode) {
		Ok(Some(u)) => u,
		Ok(None) => {
			k.diag(cx, vp, line, Diag::Lost { name });
			let s = st(vp);
			s.status = 1;
			s.stage = Stage::Finish;
			return None;
		},
		Err(err) => {
			k.fail(err);
			return Some(Flow::Discard(1));
		},
	};
	let zsh = vp.mode.dialect() == crate::bash::ids::Dialect::Zsh;
	let s = st(vp);
	let args = s.argv[1..].to_vec();
	let vars = scope_vars(zsh, &s.values, &s.assigns);
	s.waiting = Some(Awaited::Frame);
	s.stage = Stage::Await;
	let trace_once = attrs.contains(Attrs::ZSH_TRACE_ONCE);
	let callee = Callee { name, body, mode, sticky, file, traced, trace_once, warn_nested };
	let call = Call { args, vars, line, node: op.node, depth, argzero: None };
	Some(push_call(k, vp, cx, callee, call))
}

/// zsh `doshfunc`'s nesting check before a call of `name` with `depth`
/// functions running: `FUNCNEST` (zsh's default 700 while unset) not
/// negative and reached is `maximum nested function level reached;
/// increase FUNCNEST?`, reported under the function's name at the calling
/// line, and the command list is abandoned (status 1). Out of line, off
/// the bash call path.
#[inline(never)]
fn zsh_funcnest(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	line: u32,
	name: &[u8],
	depth: u32,
) -> Option<Flow> {
	let funcnest = match state::lookup(&k.root, cx.store, vp, b"FUNCNEST") {
		Ok(v) => v
			.and_then(|v| v.as_scalar())
			.map_or(Some(700), |s| builtins::number(s.trim_ascii())),
		Err(err) => {
			k.fail(err);
			return Some(Flow::Discard(1));
		},
	};
	let limit = funcnest.unwrap_or(0);
	if limit < 0 || i64::from(depth) < limit {
		return None;
	}
	let (_, zline) = k.zsh_site(cx, vp, line);
	let msg = "maximum nested function level reached; increase FUNCNEST?";
	let diag = Diag::Usage { msg: msg.into() };
	let bytes = crate::bash::diag::render_zsh(&diag, crate::bash::diag::ZshSite {
		prefix: name,
		line:   zline,
		utf8:   false,
	});
	vp.out
		.push_back(super::proc::PendingWrite { fd: 2, bytes: bytes.into(), off: 0 });
	vp.status = 1;
	Some(Flow::Discard(1))
}

/// zsh `execautofn`/`loadautofn` for a call of the autoload stub `name`
/// (defined in `mode` with `attrs`, loaded from directory `dir` when not
/// empty, with sticky emulation `sticky`): find its definition
/// ([`find_autoload`]); zsh style (the default) the file is the body,
/// which replaces the stub and is called; ksh style (`autoload -k`,
/// `kshautoload` without `-z`) the file runs, defining the function, which
/// is then called. Not found: `NAME: function definition file not found`
/// (status 1).
#[expect(clippy::too_many_arguments, reason = "the call's whole context")]
#[inline(never)]
fn autoload(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	op: Op,
	line: u32,
	name: BString,
	mode: crate::bash::ids::ModeId,
	attrs: Attrs,
	dir: BString,
	sticky: Option<Box<crate::bash::store::Sticky>>,
) -> Option<Flow> {
	let fpath = state::lookup(&k.root, cx.store, vp, b"FPATH")
		.ok()
		.flatten();
	let fpath = fpath_dirs(fpath.as_ref().and_then(|v| v.as_scalar()), k.engine.config().platform);
	let cwd = vp.cwd.clone();
	let found = {
		let mut ask = |p: Probe| command_probe(k, cx, vp, &p);
		match find_autoload::<WaitKey>(&mut ask, &cwd, &name, attrs, &dir, &fpath, false) {
			Ok(FpFound::File { dir, text }) => {
				load_dir::<WaitKey>(&mut ask, &cwd, &dir).map(|d| FpFound::File { dir: d, text })
			},
			other => other,
		}
	};
	let (dir, text) = match found {
		Ok(FpFound::File { dir, text }) => (dir, text),
		Ok(missing) => {
			let d = match missing {
				FpFound::Dump(dump) => super::builtins::zsh_zcompile::word_code_only(&dump),
				_ => Diag::Usage { msg: format!("{name}: function definition file not found").into() },
			};
			k.diag(cx, vp, line, d);
			let s = st(vp);
			s.status = 1;
			s.stage = Stage::Output;
			return None;
		},
		Err(key) => return Some(Flow::Block(key)),
	};
	let ksh = attrs.contains(Attrs::ZSH_KSHSTORED)
		|| (!attrs.contains(Attrs::ZSH_ZSHSTORED)
			&& state::zsh_option(&mut k.root, cx.store, vp, ZshOpt::Kshautoload).unwrap_or(false));
	let def = Autoloaded { name: &name, text: &text, dir: &dir, mode, attrs, sticky };
	if ksh {
		return ksh_autoload(k, vp, cx, op, line, def);
	}
	if !define_autoloaded(k, vp, cx, def) {
		let s = st(vp);
		s.status = 1;
		s.stage = Stage::Output;
		return None;
	}
	let flow = call_function(k, vp, cx, op, line, name);
	mark_autoload_call(vp, matches!(flow, Some(Flow::Call)));
	flow
}

/// The call just pushed (`pushed`) runs a body its autoload loaded (zsh
/// `execautofn_basic`'s `execode(…, "loadautofunc")`).
fn mark_autoload_call(vp: &mut Vproc, pushed: bool) {
	if pushed
		&& let Some(FrameKind::Function { autoload, .. }) = vp.frames.last_mut().map(|f| &mut f.kind)
	{
		*autoload = true;
	}
}

/// zsh `loadautofn` of a ksh-style definition file (`autoload -k`,
/// `kshautoload`) for a call of stub `def.name`: the stub's call runs the
/// file, which defines the function, then calls it with the call's
/// arguments (the file sees them too). Out of line, rarely taken.
#[inline(never)]
fn ksh_autoload(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	op: Op,
	line: u32,
	def: Autoloaded<'_>,
) -> Option<Flow> {
	let Autoloaded { name, text, dir, mode, attrs, sticky } = def;
	let feat = match autoload_features(k, vp, cx, mode, sticky.as_deref()) {
		Ok(f) => f,
		Err(err) => {
			k.fail(err);
			return Some(Flow::Discard(1));
		},
	};
	let fail = |vp: &mut Vproc| {
		let s = st(vp);
		s.status = 1;
		s.stage = Stage::Output;
		None
	};
	if parse_autoload(vp, name, text, feat).is_err() {
		return fail(vp);
	}
	let quoted = super::quote::sh_single_quote(name);
	let mut src = BString::from(quoted.as_slice());
	src.extend_from_slice(b" () {\n");
	src.extend_from_slice(text);
	src.push(b'\n');
	src.extend_from_slice(&quoted);
	src.extend_from_slice(b" \"$@\"\n}\n");
	// The body runs at once: lower what the definition deferred.
	let lowered = ir::function_from_source_at(&src, mode, feat, 0).and_then(|f| {
		if f.body.deferred.is_some() {
			ir::materialize(&f.body, k.mask.contains(crate::bash::event::EventKind::UnitCompiled))
		} else {
			Some(Arc::unwrap_or_clone(f.body))
		}
	});
	let Some(body) = lowered else {
		let what =
			format!("ksh-style autoloaded definition of {} that cannot be lowered", BStr::new(name));
		k.diag(cx, vp, line, Diag::Unsupported { what: what.into() });
		return fail(vp);
	};
	// The file's definition replaces the stub (a file that defines nothing
	// leaves the function unknown).
	state::store_record(&mut k.root, cx.store, vp, KeyBuf::Func(BString::from(name)), None);
	let body = k.engine.intern(body);
	exec::announce(k, cx, vp.vpid, vp.runs.front(), &body, body.line);
	let depth = call_depth(vp);
	let mut file = BString::from(dir);
	file.push(b'/');
	file.extend_from_slice(name);
	let zsh = vp.mode.dialect() == crate::bash::ids::Dialect::Zsh;
	let s = st(vp);
	let args = s.argv[1..].to_vec();
	let vars = scope_vars(zsh, &s.values, &s.assigns);
	s.waiting = Some(Awaited::Frame);
	s.stage = Stage::Await;
	let callee = Callee {
		name: BString::from(name),
		body,
		mode,
		sticky,
		file,
		traced: attrs.contains(Attrs::TRACE),
		trace_once: attrs.contains(Attrs::ZSH_TRACE_ONCE),
		warn_nested: attrs.contains(Attrs::ZSH_WARN_NESTED),
	};
	let call = Call { args, vars, line, node: op.node, depth, argzero: None };
	let flow = push_call(k, vp, cx, callee, call);
	mark_autoload_call(vp, matches!(flow, Flow::Call));
	Some(flow)
}

/// The features an autoloaded file of a function defined in `mode` parses
/// with: the options of its sticky emulation `sticky` (zsh loads it
/// after the call switched to it), else the current ones; `#` starts a
/// comment whatever `interactivecomments` says (zsh `getfpfunc` parses it
/// as a string).
fn autoload_features(
	k: &mut Kernel,
	vp: &Vproc,
	cx: &mut Cx<'_>,
	mode: crate::bash::ids::ModeId,
	sticky: Option<&crate::bash::store::Sticky>,
) -> Result<crate::bash::syntax::Features, StoreError> {
	let feat = match sticky {
		Some(s) => super::mode::sticky_features(&mut k.root, cx.store, vp, s)?,
		None => {
			super::mode::features(&mut k.root, cx.store, vp, crate::bash::syntax::Features::NONE)?
		},
	};
	Ok(if mode.dialect() == crate::bash::ids::Dialect::Zsh {
		feat | crate::bash::syntax::Features::ZSH_INTERACTIVE_COMMENTS
	} else {
		feat
	})
}

/// Validate autoloaded file `text` (zsh `parse_string` in `getfpfunc`),
/// retaining its command when there is exactly one. Syntax errors are
/// reported under the function's name, as with zsh's `scriptname`.
fn parse_autoload(
	vp: &mut Vproc,
	name: &[u8],
	text: &[u8],
	feat: crate::bash::syntax::Features,
) -> Result<Option<crate::bash::syntax::CompleteCommand>, ()> {
	let mut parser = crate::bash::syntax::Parser::new(text, feat, crate::bash::syntax::NO_ALIASES);
	let mut first = None;
	let mut count = 0;
	while let Some(cmd) = parser.next_command() {
		match cmd {
			Ok(cc) => {
				count += 1;
				first = (count == 1).then_some(cc);
			},
			Err(e) => {
				let mut bytes = Vec::new();
				for (line, msg) in e
					.detail()
					.into_iter()
					.map(|w| (w.line, w.bash_msg))
					.chain([(e.line, e.bash_msg())])
				{
					let diag = Diag::Syntax { msg: msg.into() };
					let site = crate::bash::diag::ZshSite { prefix: name, line, utf8: false };
					bytes.extend_from_slice(&crate::bash::diag::render_zsh(&diag, site));
				}
				vp.out
					.push_back(PendingWrite { fd: 2, bytes: bytes.into(), off: 0 });
				return Err(());
			},
		}
	}
	Ok(first)
}

/// The directories of `$fpath` (its `FPATH` text, joined with `platform`'s
/// separator, as the tie keeps it): none when empty; an empty element is
/// the working directory.
pub fn fpath_dirs(fpath: Option<&[u8]>, platform: crate::bash::ids::Platform) -> Vec<BString> {
	let sep = probe::path_separator(platform);
	match fpath {
		None | Some([]) => Vec::new(),
		Some(f) => f.split(|&c| c == sep).map(BString::from).collect(),
	}
}

/// What zsh `getfpfunc` found for a function.
pub enum FpFound {
	/// Its definition file's text, and the directory it is in as searched
	/// (empty: the working directory).
	File {
		/// The directory as searched.
		dir:  BString,
		/// The file's text.
		text: BString,
	},
	/// Only a word code file holds it (the engine runs source text only).
	Dump(BString),
	/// Nowhere.
	None,
}

/// zsh `getfpfunc`: the first regular file `name` in `dirs` (relative to
/// `cwd`), answered through `ask`; its text when `read` (zsh's
/// `test_only` when not: `autoload -r` needs only where it is). The
/// search's `stat`s are asked in stretches ([`Probe::StatAll`], each up to
/// the first file it finds), not one probe per path, each of which would
/// restart the asking builtin.
///
/// # Errors
/// What `ask` fails with (a probe in flight).
pub fn getfpfunc<E>(
	ask: &mut super::builtins::zsh_zcompile::Ask<'_, E>,
	cwd: &[u8],
	name: &[u8],
	dirs: &[BString],
	read: bool,
) -> Result<FpFound, E> {
	use super::builtins::zsh_zcompile::{fpath_dump, fpath_stat_paths};
	// Each directory's paths: `dir/name`, then the word code files.
	let mut paths: Vec<BString> = Vec::with_capacity(dirs.len() * 3);
	let mut spans = Vec::with_capacity(dirs.len());
	for d in dirs {
		let start = paths.len();
		paths.extend(fpath_stat_paths(cwd, d, name));
		spans.push(start..paths.len());
	}
	// A definition file ends the search; a word code file it passes does
	// not (its directory may hold the function after all).
	let ends: Vec<u32> = spans
		.iter()
		.filter_map(|s| u32::try_from(s.start).ok())
		.collect();
	let mut search =
		StatSearch { paths: &paths, ends: &ends, known: hashbrown::HashMap::new(), asked: 0 };
	for (dir, span) in dirs.iter().zip(spans) {
		let path = &paths[span.start];
		let regular = matches!(
			search.stat(ask, Probe::Stat { path: path.clone(), follow: true })?,
			ProbeResult::Stat(Some(st)) if st.kind != StatKind::Dir
		);
		if !regular {
			// zsh loads a definition from word code alone (`DIR.zwc`,
			// `DIR/NAME.zwc`, a digest in `$fpath`): none when the search
			// found no such file here.
			if paths[span.start + 1..span.end]
				.iter()
				.all(|p| matches!(search.known.get(p), Some(None)))
			{
				continue;
			}
			let mut ask = |p: Probe| search.stat(ask, p);
			if let Some(dump) = fpath_dump::<E>(&mut ask, cwd, dir, name)? {
				return Ok(FpFound::Dump(dump));
			}
			continue;
		}
		if !read {
			return Ok(FpFound::File { dir: dir.clone(), text: BString::default() });
		}
		if let ProbeResult::Bytes(Ok(text)) = ask(Probe::Read { path: path.clone() })? {
			return Ok(FpFound::File { dir: dir.clone(), text });
		}
	}
	Ok(FpFound::None)
}

/// The `stat`s of a [`getfpfunc`] search, asked in stretches.
struct StatSearch<'p> {
	paths: &'p [BString],
	/// Indices of the paths a file at ends a stretch, ascending.
	ends:  &'p [u32],
	known: hashbrown::HashMap<BString, Option<crate::bash::fs::Stat>>,
	/// `paths[..asked]` are in `known`.
	asked: usize,
}

impl StatSearch<'_> {
	/// `p` answered: a `stat` of the search from the stretches (one past
	/// them asks for the next stretch), anything else by `ask`.
	fn stat<E>(
		&mut self,
		ask: &mut super::builtins::zsh_zcompile::Ask<'_, E>,
		p: Probe,
	) -> Result<ProbeResult, E> {
		let Probe::Stat { path, follow: true } = &p else {
			return ask(p);
		};
		if !self.known.contains_key(path)
			&& self.paths[self.asked..].contains(path)
			&& let ProbeResult::Stats(stats) = ask(Probe::StatAll {
				paths: self.paths[self.asked..].to_vec(),
				ends:  self
					.ends
					.iter()
					.filter_map(|&e| e.checked_sub(u32::try_from(self.asked).unwrap_or(u32::MAX)))
					.collect(),
			})? {
			for (q, st) in self.paths[self.asked..].iter().zip(&stats) {
				self.known.insert(q.clone(), *st);
			}
			self.asked += stats.len().max(1);
		}
		match self.known.get(path) {
			Some(st) => Ok(ProbeResult::Stat(*st)),
			None => ask(p),
		}
	}
}

/// zsh `loadautofn`'s search for the definition of stub `name` with
/// `attrs`: its load directory `dir` (absolute) when it has one, then
/// `$fpath` (`fpath`) if not found there and `current_fpath` (`-d`) or
/// the stub's `autoload -d`; else `$fpath`.
///
/// # Errors
/// What `ask` fails with (a probe in flight).
pub fn find_autoload<E>(
	ask: &mut super::builtins::zsh_zcompile::Ask<'_, E>,
	cwd: &[u8],
	name: &[u8],
	attrs: Attrs,
	dir: &[u8],
	fpath: &[BString],
	current_fpath: bool,
) -> Result<FpFound, E> {
	if dir.first() == Some(&b'/') {
		let found = getfpfunc(ask, cwd, name, &[BString::from(dir)], true)?;
		if !matches!(found, FpFound::None) || !(current_fpath || attrs.contains(Attrs::ZSH_CUR_FPATH))
		{
			return Ok(found);
		}
	}
	getfpfunc(ask, cwd, name, fpath, true)
}

/// zsh `dircache_set`'s directory: `dir` if absolute, else the working
/// directory `cwd` and it with the symbolic links resolved (zsh
/// `xsymlink`).
///
/// # Errors
/// What `ask` fails with (a probe in flight).
pub fn load_dir<E>(
	ask: &mut super::builtins::zsh_zcompile::Ask<'_, E>,
	cwd: &[u8],
	dir: &[u8],
) -> Result<BString, E> {
	if dir.first() == Some(&b'/') {
		return Ok(BString::from(dir));
	}
	let mut path = BString::from(cwd);
	if !path.ends_with(b"/") {
		path.push(b'/');
	}
	path.extend_from_slice(dir);
	let mut cut = path.len();
	loop {
		if cut > 0
			&& let ProbeResult::Path(Some(mut real)) =
				ask(Probe::RealPath { path: BString::from(&path[..cut]) })?
		{
			real.extend_from_slice(&path[cut..]);
			return Ok(real);
		}
		if cut == 0 {
			return Ok(path);
		}
		cut = path[..cut].iter().rposition(|&c| c == b'/').unwrap_or(0);
	}
}

/// An autoloaded definition to install ([`define_autoloaded`]).
pub struct Autoloaded<'a> {
	/// The function.
	pub name:   &'a [u8],
	/// Its file's text.
	pub text:   &'a [u8],
	/// The directory it was loaded from (absolute).
	pub dir:    &'a [u8],
	/// The mode the stub was defined in.
	pub mode:   crate::bash::ids::ModeId,
	/// The stub's attributes.
	pub attrs:  Attrs,
	/// The stub's sticky emulation: the file parses under its options.
	pub sticky: Option<Box<crate::bash::store::Sticky>>,
}

/// Define function `def.name` from its autoloaded file (zsh `loadautofn`,
/// zsh style: the text is the body; zsh `stripkshdef`: a file that is
/// exactly one definition of the function gives that definition's body),
/// keeping the stub's attributes but the autoload ones; its file is
/// `DIR/NAME` and its lines are the file's. `false` when the text does not
/// parse: the error is reported under the function's name (zsh parses the
/// file with `scriptname` set to it).
pub fn define_autoloaded(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	def: Autoloaded<'_>,
) -> bool {
	let Autoloaded { name, text, dir, mode, attrs, sticky } = def;
	let feat = match autoload_features(k, vp, cx, mode, sticky.as_deref()) {
		Ok(f) => f,
		Err(err) => {
			k.fail(err);
			return false;
		},
	};
	let Ok(command) = parse_autoload(vp, name, text, feat) else {
		return false;
	};
	let lone = command
		.as_ref()
		.and_then(|cc| ir::function_from_parsed(cc, text, mode, feat))
		.filter(|f| f.name.as_slice() == name);
	let f = lone.or_else(|| {
		// Line 0 holds the wrapper: the body's lines are the file's.
		let mut src = BString::from(name);
		src.extend_from_slice(b" () {\n");
		src.extend_from_slice(text);
		src.extend_from_slice(b"\n}\n");
		ir::function_from_source_at(&src, mode, feat, 0)
	});
	let Some(f) = f else {
		let what = format!("autoloaded definition of {} that cannot be lowered", BStr::new(name));
		let line = exec::current_line(vp);
		k.diag(cx, vp, line, Diag::Unsupported { what: what.into() });
		return false;
	};
	// A deferred body (no ops yet) is only persisted: `load_unit` lowers it
	// at the first call, so it must not sit in the executable-unit cache.
	let compiled = f
		.body
		.deferred
		.is_none()
		.then(|| k.engine.intern((*f.body).clone()));
	let unit = compiled.as_deref().unwrap_or(&f.body);
	k.persist_unit(cx.store, unit);
	if compiled.is_some() {
		exec::announce(k, cx, vp.vpid, vp.runs.front(), unit, unit.line);
	}
	let unit_id = unit.id;
	let attrs = attrs
		.without(Attrs::ZSH_UNDEFINED)
		.without(Attrs::ZSH_KSHSTORED)
		.without(Attrs::ZSH_ZSHSTORED)
		.without(Attrs::ZSH_UNALIASED);
	let mut file = BString::from(dir);
	file.push(b'/');
	file.extend_from_slice(name);
	let rec =
		Record::Func { mode, sticky, source: ir::FuncText::of(&f), unit: unit_id, attrs, file };
	state::store_record(&mut k.root, cx.store, vp, KeyBuf::Func(BString::from(name)), Some(rec));
	true
}

/// The compiled body of function `name` (unit `unit_id`, defined in
/// `mode`): from the engine or the store, else recompiled from its
/// canonical text; `None` when neither works.
fn load_body(
	k: &mut Kernel,
	vp: &Vproc,
	cx: &mut Cx<'_>,
	name: &[u8],
	unit_id: crate::bash::ids::UnitId,
	mode: crate::bash::ids::ModeId,
) -> Result<Option<Arc<Unit>>, StoreError> {
	if let Some(unit) = k.engine.cached(&unit_id) {
		exec::announce(k, cx, vp.vpid, vp.runs.front(), &unit, unit.line);
		return Ok(Some(unit));
	}
	k.clock_stale();
	match super::frames::load_unit(
		&k.engine,
		cx.store,
		unit_id,
		k.mask.contains(crate::bash::event::EventKind::UnitCompiled),
	) {
		Ok(u) => {
			exec::announce(k, cx, vp.vpid, vp.runs.front(), &u, u.line);
			return Ok(Some(u));
		},
		Err(crate::bash::RestoreError::Store(err)) => return Err(err),
		// Missing or unusable blob: fall back to the canonical text.
		Err(_) => {},
	}
	// Neither compiled in this engine nor in the store (an imported
	// function): recompile the canonical text (`FuncEnter` reads the clock
	// after it).
	k.clock_stale();
	let source = match state::record(cx.store, vp, Key::Func(BStr::new(name)))? {
		Some(Record::Func { source, .. }) => (**source).clone(),
		_ => BString::default(),
	};
	let feat = if mode.dialect() == crate::bash::ids::Dialect::Zsh {
		crate::bash::syntax::Features::ZSH
	} else {
		crate::bash::syntax::Features::NONE
	};
	let Some(f) = ir::function_from_source(&source, mode, feat) else {
		return Ok(None);
	};
	let unit = k.engine.intern(Arc::unwrap_or_clone(f.body));
	exec::announce(k, cx, vp.vpid, vp.runs.front(), &unit, unit.line);
	Ok(Some(unit))
}

/// The function a call runs.
struct Callee {
	name:        BString,
	body:        Arc<Unit>,
	/// The mode it was defined in.
	mode:        crate::bash::ids::ModeId,
	sticky:      Option<Box<crate::bash::store::Sticky>>,
	/// The file it was defined in.
	file:        BString,
	/// `declare -ft` (zsh `functions -t`, `PM_TAGGED`).
	traced:      bool,
	/// zsh `functions -T` / `function -T` (`PM_TAGGED_LOCAL`).
	trace_once:  bool,
	/// zsh `functions -W`.
	warn_nested: bool,
}

/// How a function is called.
struct Call {
	args:    Vec<BString>,
	/// Prefix assignments, locals of its scope.
	vars:    VarMap,
	/// The calling line.
	line:    u32,
	/// The calling command's node (`FuncEnter`).
	node:    u32,
	/// Function frames already running.
	depth:   u32,
	/// Its `$0` when not the function's name (a zsh math function's
	/// name, zsh `callmathfunc`).
	argzero: Option<BString>,
}

/// Push a function frame with its scope (positional parameters, prefix
/// assignments as locals) and run its entry (bash `execute_function`, zsh
/// `doshfunc`: options, sticky emulation, trap scope).
fn push_call(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>, callee: Callee, call: Call) -> Flow {
	let Callee { name, body, mode, sticky, file, traced, trace_once, warn_nested } = callee;
	let Call { args, vars, line, node, depth, argzero } = call;
	let zsh_body = body.mode.dialect() == crate::bash::ids::Dialect::Zsh;
	let entry_line = super::callstack::body_line(&body);
	let mut frame = Frame::new(Some(body), 0, FrameKind::Function {
		name:     name.clone(),
		zsh:      false,
		autoload: false,
	});
	// bash saves the getopts state on entry (restored on return when the
	// function made `OPTIND` local); zsh saves `OPTIND` and starts afresh
	// (restored on return without `POSIX_BUILTINS`).
	if zsh_body {
		match builtins::zsh_vars::optind_enter(&mut k.root, cx.store, vp) {
			Ok(saved) => frame.getopts = saved,
			Err(err) => {
				k.fail(err);
				return Flow::Discard(1);
			},
		}
	} else if vp.getopts != super::proc::GetoptsState::default() {
		frame.getopts = Some(Box::new(vp.getopts.clone()));
	}
	// A function with the trace attribute (`declare -ft`) inherits the
	// DEBUG and RETURN traps.
	frame.debug_trap_local = traced;
	frame.return_trap_local = traced;
	// A zsh body or a mode switch (sticky emulation, another dialect):
	// what the return restores goes with the scope; before `FuncEnter`,
	// which reports the callee's mode. A bash function called from bash
	// code without a sticky emulation switches nothing.
	let zsh = if mode.dialect() == crate::bash::ids::Dialect::Bash
		&& vp.mode.dialect() == crate::bash::ids::Dialect::Bash
		&& sticky.is_none()
	{
		None
	} else {
		let trace = (traced, trace_once);
		match zsh_enter_call(k, vp, cx, &name, mode, sticky.as_deref(), zsh_body, warn_nested, trace)
		{
			Ok((zsh, local)) => {
				frame.trace_local = local;
				zsh
			},
			Err(err) => {
				k.fail(err);
				return Flow::Discard(1);
			},
		}
	};
	if zsh.is_some()
		&& let FrameKind::Function { zsh: call, .. } = &mut frame.kind
	{
		*call = true;
	}
	// The name and arguments borrowed before they move into the scope: no
	// copy per call. At the calling command's node, so before the body's
	// frame is on top (`op.node` is a node of the caller's unit).
	if k.mask.contains(crate::bash::event::EventKind::FuncEnter) {
		// Only the call's bookkeeping ran since its `CmdExpanded`: the same
		// reading (`Kernel::stamp`).
		let t_ns = k.stamp(cx);
		let data = EventData::FuncEnter { name: BStr::new(&name), args: &args, depth: depth + 1 };
		k.emit_op_at(cx, vp, node, data, t_ns);
	}
	vp.frames.push(frame);
	// zsh's function wrappers (zsh/zprof, zsh/example): nothing unless their
	// module is loaded.
	if zsh_body {
		builtins::zsh_mod_zprof::enter(k, vp, cx, &name, line);
		// zsh/complete's `comp_wrapper` (inside completion functions only).
		super::zle::comp::complete::wrap_enter(vp);
		builtins::zsh_mod_example::enter(k, vp, cx, &name);
	}
	// The call-stack level, before the scope: `BASH_ARGV`'s base is the
	// caller's positional parameters.
	if let Err(err) =
		super::callstack::push_function(k, cx.store, vp, name.clone(), file, line, &args)
	{
		k.fail(err);
	}
	let scope = Scope { vars, positional: Some(args), func: Some(argzero.unwrap_or(name)), zsh };
	state::push_scope(&mut k.root, cx.store, vp, scope);
	// `$?` at the function's entry is the caller's (bash's
	// `execute_function` leaves `last_command_exit_value` alone).
	// bash runs the DEBUG trap at the function's entry, on its body's line;
	// under `extdebug` a failing one skips the body. zsh runs it before
	// commands only.
	let fi = vp.frames.len() - 1;
	if !zsh_body && exec::start_trap(k, vp, cx, crate::bash::store::TrapKey::Debug) {
		exec::set_trap_line(vp, entry_line);
		vp.frames[fi].debug_pc = Some(exec::ENTRY_DEBUG);
	}
	Flow::Call
}

/// The entry of a call of `name` (defined in `mode` with sticky emulation
/// `sticky`) that may switch modes (zsh `doshfunc`): the switch
/// ([`super::mode::enter_call`]); for a zsh body that saved state, the
/// caller's `EXIT` trap waits in the scope (`starttrapscope`) and `functions
/// -W` turns `WARN_NESTED_VAR` on for the call, a call from such a
/// function turns it off, except in an anonymous function, which inherits
/// it (before the scope: the innermost function is still the caller). What
/// the return restores, if anything. `functions -t`/`-T` (`trace`: the
/// callee's `PM_TAGGED`, `PM_TAGGED_LOCAL`) turn `xtrace` on for the call;
/// a named function called from a `-T` call runs with it off, an
/// anonymous one inherits the `-T` (the second value: the call's
/// `PM_TAGGED_LOCAL`, [`Frame::trace_local`]). Out of line, off the bash
/// call path.
#[inline(never)]
fn zsh_enter_call(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	name: &[u8],
	mode: crate::bash::ids::ModeId,
	sticky: Option<&crate::bash::store::Sticky>,
	zsh_body: bool,
	warn_nested: bool,
	(tagged, tagged_local): (bool, bool),
) -> Result<(Option<Box<crate::bash::store::ZshScope>>, bool), StoreError> {
	let mut zsh = super::mode::enter_call(&mut k.root, cx.store, vp, mode, sticky)?;
	if !zsh_body {
		return Ok((zsh, false));
	}
	let mut local = tagged_local;
	if zsh.is_some() {
		let caller_local = vp
			.frames
			.iter()
			.rev()
			.find(|f| matches!(f.kind, FrameKind::Function { .. }))
			.is_some_and(|f| f.trace_local);
		let xtrace = if tagged || tagged_local {
			Some(true)
		} else if caller_local {
			if name == ir::ANON.as_bytes() {
				local = true;
				None
			} else {
				Some(false)
			}
		} else {
			None
		};
		if let Some(on) = xtrace {
			state::set_zsh_option(&mut k.root, cx.store, vp, ZshOpt::Xtrace, on)?;
		}
	}
	if let Some(z) = zsh.as_mut() {
		z.traps = builtins::trap::start_scope(&mut k.root, cx.store, vp)?;
		let set = if warn_nested {
			Some(true)
		} else if name == ir::ANON.as_bytes() {
			None
		} else {
			caller_warns_nested(k, cx, vp)?.then_some(false)
		};
		if let Some(on) = set {
			state::set_zsh_option(&mut k.root, cx.store, vp, ZshOpt::Warnnestedvar, on)?;
		}
	}
	Ok((zsh, local))
}

/// Whether the innermost running function (past anonymous ones, which
/// inherit it) has zsh's `functions -W` attribute (zsh `doshfunc`'s
/// `oflags & PM_WARNNESTED`).
fn caller_warns_nested(k: &Kernel, cx: &mut Cx<'_>, vp: &Vproc) -> Result<bool, StoreError> {
	let Some(top) = state::func_scope(&k.root, cx.store, vp)? else {
		return Ok(false);
	};
	for i in (0..=top).rev() {
		let Some(f) = state::scope_func(cx.store, vp, i)? else {
			continue;
		};
		if f.is_empty() || f.as_slice() == b"(anon)" {
			continue;
		}
		return Ok(matches!(
			state::record(cx.store, vp, Key::Func(BStr::new(&f)))?,
			Some(Record::Func { attrs, .. }) if attrs.contains(Attrs::ZSH_WARN_NESTED)
		));
	}
	Ok(false)
}

/// Function frames running in `vp` (the call depth).
fn call_depth(vp: &Vproc) -> u32 {
	vp.frames
		.iter()
		.filter(|f| matches!(f.kind, FrameKind::Function { .. }))
		.count() as u32
}

/// `CallAnon`: a zsh anonymous function (zsh `execfuncdef` with
/// `ANONYMOUS_FUNCTION_NAME`): expand the arguments, then call body
/// `op.a` as function `(anon)` with them as its positional parameters; its
/// status is the command's. Out of line, off the bash dispatch path.
#[inline(never)]
pub fn call_anon(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	unit: &Arc<Unit>,
	op: Op,
	line: u32,
) -> Flow {
	// Back from the body.
	if current_exec(vp).is_some_and(|e| e.waiting == Some(Awaited::Frame)) {
		let status = vp.status;
		// zsh/zprof's wrapper after the call (nothing unless it is loaded).
		builtins::zsh_mod_zprof::leave(k, vp, cx);
		super::zle::comp::complete::wrap_leave(vp);
		exec::clear_scratch(&mut k.root, cx.store, vp);
		vp.status = status;
		if let Some(pending) = exec::zsh_exit_pending(vp) {
			return Flow::Exit(pending);
		}
		if status != 0 {
			print_exit_value(k, vp, cx, status);
		}
		return Flow::Next;
	}
	let words = &unit.lists[op.b as usize];
	let record = words.iter().any(|&w| unit.words[w as usize].parks);
	let res = expanding(k, vp, cx, Slot::Words, record, line, |ex| {
		let mut out = Vec::new();
		let mut globs = Vec::new();
		for &w in words {
			ex.fields_glob(unit, &unit.words[w as usize], &mut out, &mut globs)?;
		}
		Ok((out, globs))
	});
	let (mut args, globs) = match res {
		Ok(v) => v,
		Err(flow) => return flow,
	};
	if !globs.is_empty()
		&& let Err(flow) = super::zsh::zglob::expand_globs(k, vp, cx, &mut args, &globs, line)
	{
		return flow;
	}
	// zsh `execfuncdef`: `$_` is the last argument (empty without one);
	// the call brings it back when it returns.
	state::store_record(
		&mut k.root,
		cx.store,
		vp,
		KeyBuf::Misc(MiscKey::LastArg),
		args
			.last()
			.filter(|w| !w.is_empty())
			.cloned()
			.map(Record::Misc),
	);
	// zsh `execshfunc`: the call traced as its name and arguments.
	if xtrace::on(k, cx, vp) {
		let q = xtrace::ZshQuote::of(k, cx, vp);
		let mut out = xtrace::ps4(k, cx, vp, line);
		q.push(&mut out, ir::ANON.as_bytes());
		for a in &args {
			out.push(b' ');
			q.push(&mut out, a);
		}
		out.push(b'\n');
		xtrace::write(k, cx, vp, out);
	}
	let f = &unit.funcs[op.a as usize];
	// A lazily lowered body (`Unit::deferred`, no ops yet) is lowered at
	// its call, as `frames::load_unit` does for named functions.
	let body = if let Some(u) = k.engine.cached(&f.body.id) {
		u
	} else if f.body.deferred.is_some() {
		let Some(b) =
			ir::materialize(&f.body, k.mask.contains(crate::bash::event::EventKind::UnitCompiled))
		else {
			let what = "an anonymous function body that cannot be lowered";
			k.diag(cx, vp, line, crate::bash::diag::Diag::Unsupported { what: what.into() });
			return Flow::Discard(1);
		};
		k.engine.intern(b)
	} else {
		k.engine.intern((*f.body).clone())
	};
	exec::announce(k, cx, vp.vpid, vp.runs.front(), &body, body.line);
	let tag =
		CmdTag { run: vp.runs.front().map_or(RunId(0), |r| r.id), vpid: vp.vpid, seq: k.next_cmd };
	k.next_cmd += 1;
	let mut state = Box::new(ExecState::new(tag, 0));
	state.waiting = Some(Awaited::Frame);
	state.stage = Stage::Await;
	scratch(vp).exec = Some(state);
	let callee = Callee {
		name: BString::from(ir::ANON),
		body,
		mode: unit.mode,
		sticky: None,
		file: BString::default(),
		traced: false,
		trace_once: op.flags & Op::TRACED != 0,
		warn_nested: false,
	};
	let depth = call_depth(vp);
	let call = Call { args, vars: VarMap::default(), line, node: op.node, depth, argzero: None };
	push_call(k, vp, cx, callee, call)
}

/// zsh `callmathfunc`'s `doshfunc` for [`Stop::MathCall`]: call the shell
/// function `call.func` (defined) in the current shell with `$0`
/// `call.argzero` and `call.args`, above the op that parked
/// ([`super::proc::PendingSub::Math`] in its scratch `sc`: the op replays
/// with the function's value and status logged in its replay log `slot`).
pub fn start_math_call(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	sc: &mut Scratch,
	slot: Slot,
	call: &super::expand::MathCall,
	line: u32,
) -> Flow {
	let name = call.func.clone();
	let (unit_id, mode, sticky, file, attrs) =
		match state::record(cx.store, vp, Key::Func(BStr::new(&name))) {
			Ok(Some(Record::Func { unit, mode, sticky, file, attrs, .. }))
				if !attrs.contains(Attrs::ZSH_UNDEFINED) =>
			{
				(*unit, *mode, sticky.clone(), file.clone(), *attrs)
			},
			Ok(_) => {
				let msg = format!("no such function: {name}");
				k.diag(cx, vp, line, Diag::BadMathExpr { msg: msg.into() });
				return Flow::Discard(1);
			},
			Err(err) => {
				k.fail(err);
				return Flow::Discard(1);
			},
		};
	let depth = call_depth(vp);
	if let Some(flow) = zsh_funcnest(k, vp, cx, line, &name, depth) {
		return flow;
	}
	let body = match load_body(k, vp, cx, &name, unit_id, mode) {
		Ok(Some(u)) => u,
		Ok(None) => {
			k.diag(cx, vp, line, Diag::Lost { name });
			return Flow::Discard(1);
		},
		Err(err) => {
			k.fail(err);
			return Flow::Discard(1);
		},
	};
	sc.sub = Some(super::proc::PendingSub::Math { status: vp.status, slot });
	let callee = Callee {
		name,
		body,
		mode,
		sticky,
		file,
		traced: attrs.contains(Attrs::TRACE),
		trace_once: attrs.contains(Attrs::ZSH_TRACE_ONCE),
		warn_nested: attrs.contains(Attrs::ZSH_WARN_NESTED),
	};
	let call = Call {
		args: call.args.clone(),
		vars: VarMap::default(),
		line,
		node: 0,
		depth,
		argzero: Some(call.argzero.clone()),
	};
	push_call(k, vp, cx, callee, call)
}

/// Call the function `rec` (a [`Record::Func`]) as `name` with `args`
/// outside any command: a zsh function trap (`TRAPZERR`, `TRAPEXIT`, …,
/// zsh `dotrapargs`) on top of its trap frame. `false` when its body is
/// lost or the call could not start.
pub fn call_record(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	name: BString,
	rec: &Record,
	args: Vec<BString>,
	line: u32,
) -> bool {
	let Record::Func { unit, mode, sticky, file, attrs, .. } = rec else {
		return false;
	};
	let body = if attrs.contains(Attrs::ZSH_UNDEFINED) {
		// An autoload stub's body is zsh's `builtin autoload -X`: it loads
		// the definition from `$fpath` and runs it with the stub's arguments.
		let mut src = name.to_vec();
		src.extend_from_slice(b" () {\n\tbuiltin autoload -X\n}\n");
		let Some(f) = ir::function_from_source(&src, *mode, crate::bash::syntax::Features::ZSH)
		else {
			return false;
		};
		let unit = k.engine.intern(Arc::unwrap_or_clone(f.body));
		exec::announce(k, cx, vp.vpid, vp.runs.front(), &unit, unit.line);
		unit
	} else {
		match load_body(k, vp, cx, &name, *unit, *mode) {
			Ok(Some(u)) => u,
			Ok(None) => return false,
			Err(err) => {
				k.fail(err);
				return false;
			},
		}
	};
	let callee = Callee {
		name,
		body,
		mode: *mode,
		sticky: sticky.clone(),
		file: file.clone(),
		traced: attrs.contains(Attrs::TRACE),
		trace_once: attrs.contains(Attrs::ZSH_TRACE_ONCE),
		warn_nested: attrs.contains(Attrs::ZSH_WARN_NESTED),
	};
	let depth = call_depth(vp);
	let call = Call { args, vars: VarMap::default(), line, node: 0, depth, argzero: None };
	matches!(push_call(k, vp, cx, callee, call), Flow::Call)
}

/// Run a builtin, answering its probes; queue its output.
fn run_builtin(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	line: u32,
	id: IntrinsicId,
) -> Option<Flow> {
	if !st(vp).scoped {
		st(vp).scoped = true;
		let scope = Scope {
			vars:       VarMap::default(),
			positional: None,
			func:       None,
			zsh:        None,
		};
		state::push_scope(&mut k.root, cx.store, vp, scope);
	}
	// In posix mode the prefix assignments of a special builtin are shell
	// assignments (they persist): move them out of the temporary scope
	// (once; a re-run finds none left). zsh: under `posixbuiltins`, for its
	// `BINF_PSPECIAL`/`BINF_ASSIGN` builtins not run through `command`
	// (`execcmd_exec`'s `do_save`), and for `exec` with only redirections
	// (`nullexec`, which skips `save_params`).
	if !st(vp).values.is_empty()
		&& if vp.mode.dialect() == crate::bash::ids::Dialect::Zsh {
			(zsh_pspecial(id) || id == IntrinsicId::Exec)
				&& !st(vp).via_command
				&& state::zsh_option(&mut k.root, cx.store, vp, ZshOpt::Posixbuiltins).unwrap_or(false)
		} else {
			is_special(id)
				&& state::option(&mut k.root, cx.store, vp, crate::bash::store::OptId::Posix)
					.unwrap_or(false)
		} {
		if let Some(top) = state::scope_count(&k.root, vp).checked_sub(1) {
			state::scope_clear(&mut k.root, cx.store, vp, top);
		}
		let s = st(vp);
		let values = std::mem::take(&mut s.values);
		let names: Vec<BString> = s.assigns.iter().map(|(n, _)| n.clone()).collect();
		for ((index, value), name) in values.into_iter().zip(&names) {
			let lhs = Lhs { name, index: index.as_ref().map(|i| i.as_slice()), append: false };
			if let Err(d) = builtins::assign_special_prefix(k, cx, vp, lhs, value) {
				k.diag(cx, vp, line, d);
			}
		}
	}
	let name: &'static str = id.into();
	if id == IntrinsicId::Exec {
		return exec_builtin(k, vp, cx, line);
	}
	loop {
		let mut sc = exec::take_scratch(vp);
		// A substitution the builtin started is done: its output joins the
		// builtin's replay log.
		if let Some(flow) = exec::settle_sub(k, vp, cx, &mut sc, Slot::Builtin) {
			vp.frames.last_mut().expect("frame").scratch = Some(sc);
			return Some(flow);
		}
		let log = std::mem::take(&mut sc.logs[Slot::Builtin as usize]);
		let (res, log) = {
			let e = sc.exec.as_ref().expect("exec");
			let mut ctx = Ctx::new(k, cx, vp, sc.probes(), line, name);
			ctx.log = log;
			ctx.compound.clone_from(&e.compound);
			ctx.arrayref.clone_from(&e.arrayref);
			ctx.resumed = e.resumed;
			let r = builtins::run(id, &mut ctx, &e.argv);
			// Not through `command`.
			let fatal = ctx.usage_error && !e.via_command;
			let log = std::mem::take(&mut ctx.log);
			(r.map(|o| (o, ctx.chunks, fatal)), log)
		};
		// The slot still holds the empty `Vec` `take` left there (the
		// builtin has only `sc.probes()`): no drop of that placeholder.
		let placeholder = std::mem::replace(&mut sc.logs[Slot::Builtin as usize], log);
		debug_assert_eq!(placeholder.capacity(), 0, "builtin log placeholder");
		std::mem::forget(placeholder);
		match res {
			Ok((outcome, chunks, fatal)) => {
				sc.logs[Slot::Builtin as usize].clear();
				return settle_builtin(k, vp, cx, line, id, sc, outcome, chunks, fatal);
			},
			Err(Need::Probe(p)) => {
				let r = probe::perform_mut(k, cx, vp, &mut sc, &p);
				vp.frames.last_mut().expect("frame").scratch = Some(sc);
				if let Err(key) = r {
					return Some(Flow::Block(key));
				}
			},
			Err(Need::Store(err)) => {
				vp.frames.last_mut().expect("frame").scratch = Some(sc);
				k.fail(err);
				return Some(Flow::Discard(1));
			},
			Err(Need::Park(key)) => {
				vp.frames.last_mut().expect("frame").scratch = Some(sc);
				return Some(Flow::Block(key));
			},
			Err(Need::Sub(stop @ (Stop::ZshSub { .. } | Stop::MathCall(_) | Stop::Probe(_)))) => {
				if let Some(flow) = builtin_zsh_stop(k, vp, cx, sc, line, stop) {
					return Some(flow);
				}
			},
			Err(Need::Sub(Stop::Sub { unit, entry, form, text })) => {
				// A no-fork substitution pushes its frame above this op's.
				let fi = vp.frames.len() - 1;
				let sub = exec::Sub { unit, entry, form, text, line };
				let flow = exec::start_sub(k, vp, cx, &mut sc, sub);
				vp.frames[fi].scratch = Some(sc);
				return Some(flow);
			},
			Err(Need::Sub(stop)) => {
				vp.frames.last_mut().expect("frame").scratch = Some(sc);
				return Some(exec::stop_flow(k, vp, cx, line, stop));
			},
		}
	}
}

/// The state a builtin that ran to its end leaves: its output queued, its
/// status and control transfer (`return`, `exit`, a pushed frame, a wait)
/// on the command's exec state, the scratch placed on the frame it belongs
/// to. `fatal`: its usage error ends a posix shell.
#[expect(clippy::too_many_arguments, reason = "the parts of one finished builtin run")]
fn settle_builtin(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	line: u32,
	id: IntrinsicId,
	mut sc: Box<Scratch>,
	mut outcome: builtins::Outcome,
	chunks: Vec<Chunk>,
	fatal: bool,
) -> Option<Flow> {
	// A special builtin's usage error ends a posix shell.
	if fatal
		&& outcome.status != 0
		&& is_special(id)
		&& matches!(outcome.control, Control::None | Control::Return)
		&& state::option(&mut k.root, cx.store, vp, crate::bash::store::OptId::Posix).unwrap_or(false)
	{
		outcome.control = Control::Exit;
	}
	// zsh `execcmd`'s `fatal:`: under `posixbuiltins` an error
	// (`errflag`) of a `BINF_PSPECIAL` builtin exits a
	// non-interactive shell with status 1; through `command` the
	// error is cleared, the status stays.
	if matches!(outcome.control, Control::DiscardAll)
		&& vp.mode.dialect() == crate::bash::ids::Dialect::Zsh
		&& zsh_pspecial(id)
		&& state::zsh_option(&mut k.root, cx.store, vp, ZshOpt::Posixbuiltins).unwrap_or(false)
	{
		if sc.exec.as_ref().is_some_and(|e| e.via_command) {
			outcome.control = Control::None;
		} else if !state::zsh_option(&mut k.root, cx.store, vp, ZshOpt::Interactive).unwrap_or(false)
		{
			outcome.status = 1;
			outcome.control = Control::Exit;
		}
	}
	for c in chunks {
		let (fd, bytes) = match c {
			Chunk::Out(fd, b) => (fd, b),
			Chunk::Diag(d) => {
				super::zle::display::trash_for_message(k, cx, vp);
				(2, k.render_diag(cx, vp, line, &d))
			},
		};
		sc.exec
			.as_mut()
			.expect("exec")
			.writes
			.push_back(PendingWrite { fd, bytes: bytes.into(), off: 0 });
	}
	let e = sc.exec.as_mut().expect("exec");
	e.status = outcome.status;
	let flow = match outcome.control {
		Control::None => {
			e.stage = Stage::Output;
			None
		},
		Control::Frame => {
			e.waiting = Some(Awaited::Frame);
			e.stage = Stage::Await;
			Some(Flow::Call)
		},
		Control::Resume => {
			e.waiting = Some(Awaited::Frame);
			e.resume = true;
			e.stage = Stage::Await;
			Some(Flow::Call)
		},
		Control::Wait(w) => {
			e.wait_for = w.children;
			e.wait_into = w.into.map(Box::new);
			e.waiting = Some(if w.any {
				Awaited::AnyJob
			} else if w.all {
				Awaited::AllJobs
			} else {
				Awaited::Jobs { force: w.force }
			});
			e.stage = Stage::Await;
			None
		},
		Control::Return => {
			e.control = Some(Transfer::Return(outcome.status));
			e.stage = Stage::Output;
			None
		},
		Control::Break { n, cont } => {
			e.control = Some(Transfer::Break { n, cont });
			e.stage = Stage::Output;
			None
		},
		Control::DiscardAll => {
			e.control = Some(Transfer::DiscardAll(outcome.status));
			e.stage = Stage::Output;
			None
		},
		Control::Exit => {
			e.control = Some(Transfer::Exit(outcome.status));
			e.stage = Stage::Output;
			None
		},
	};
	// A pushed frame sits above; the scratch belongs to the frame below
	// it.
	let at = if matches!(flow, Some(Flow::Call)) {
		vp.frames.len() - 2
	} else {
		vp.frames.len() - 1
	};
	vp.frames[at].scratch = Some(sc);
	flow
}

/// A builtin's expansion (zsh code) needs a zsh command substitution or an
/// expansion probe (`=cmd`) first: start it, or answer the probe and log it
/// for the builtin's replay (`None`: it runs again). The scratch goes back
/// to the builtin's frame. Out of line, off the bash builtin path.
#[inline(never)]
fn builtin_zsh_stop(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	mut sc: Box<Scratch>,
	line: u32,
	stop: Stop,
) -> Option<Flow> {
	let flow = match stop {
		Stop::ZshSub { text, here } => {
			// A call run here pushes its frame above the builtin's.
			let fi = vp.frames.len() - 1;
			let flow = exec::start_zsh_sub(k, vp, cx, &mut sc, &text, here, line);
			vp.frames[fi].scratch = Some(sc);
			return Some(flow);
		},
		Stop::MathCall(call) => {
			// The function's frame goes above the builtin's.
			let fi = vp.frames.len() - 1;
			let flow = start_math_call(k, vp, cx, &mut sc, Slot::Builtin, &call, line);
			vp.frames[fi].scratch = Some(sc);
			return Some(flow);
		},
		Stop::Probe(p) => exec::settle_probe(k, cx, vp, &mut sc, Slot::Builtin, &p)
			.err()
			.map(Flow::Block),
		stop => Some(exec::stop_flow(k, vp, cx, line, stop)),
	};
	vp.frames.last_mut().expect("frame").scratch = Some(sc);
	flow
}

/// `exec [-cl] [-a name] [command [arg …]]`: without a command its
/// redirections stay in effect; with one, the command (an external, found
/// on `PATH`) replaces the shell, which exits with its status.
fn exec_builtin(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>, line: u32) -> Option<Flow> {
	const USAGE: &[u8] =
		b"exec: usage: exec [-cl] [-a name] [command [argument ...]] [redirection ...]\n";
	let argv = std::mem::take(&mut st(vp).argv);
	let mut how = ExecAs::default();
	let mut i = 1;
	let mut bad = None;
	'words: while let Some(a) = argv.get(i) {
		if a.as_slice() == b"--" {
			i += 1;
			break;
		}
		if a.len() < 2 || a[0] != b'-' {
			break;
		}
		i += 1;
		for (j, &c) in a.iter().enumerate().skip(1) {
			match c {
				b'c' => how.clear_env = true,
				b'l' => how.login = true,
				b'a' => {
					let name = if j + 1 < a.len() {
						Some(BString::from(&a[j + 1..]))
					} else {
						let next = argv.get(i).cloned();
						i += 1;
						next
					};
					if name.is_none() {
						bad = Some("-a: option requires an argument".to_owned());
						break 'words;
					}
					how.argv0 = name;
					continue 'words;
				},
				_ => {
					bad = Some(format!("-{}: invalid option", char::from(c)));
					break 'words;
				},
			}
		}
	}
	if let Some(msg) = bad {
		let text = k.render_diag(cx, vp, line, &Diag::Usage { msg: msg.into() }.by("exec"));
		let s = st(vp);
		s.argv = argv;
		s.writes
			.push_back(PendingWrite { fd: 2, bytes: text.into(), off: 0 });
		s.writes
			.push_back(PendingWrite { fd: 2, bytes: USAGE.into(), off: 0 });
		s.status = 2;
		s.stage = Stage::Output;
		return None;
	}
	let Some(name) = argv.get(i).cloned() else {
		// No command: the redirections stay in effect.
		if let Some(io) = scratch(vp).io.as_mut() {
			io.saved.clear();
		}
		let s = st(vp);
		s.argv = argv;
		s.status = 0;
		s.stage = Stage::Output;
		return None;
	};
	let zsh = vp.mode.dialect() == crate::bash::ids::Dialect::Zsh;
	if zsh && state::zsh_option(&mut k.root, cx.store, vp, ZshOpt::Restricted).unwrap_or(false) {
		let msg = format!("{name}: restricted").into();
		k.diag(cx, vp, line, Diag::Usage { msg }.by("exec"));
		let s = st(vp);
		s.argv = argv;
		s.status = 1;
		s.stage = Stage::Output;
		return None;
	}
	let target = if zsh
		&& !state::zsh_option(&mut k.root, cx.store, vp, ZshOpt::Posixbuiltins).unwrap_or(false)
	{
		// zsh `exec` is a precommand modifier: a function or builtin runs
		// (then the shell exits); only `posixbuiltins` limits it to
		// externals.
		None
	} else if name.contains(&b'/') {
		Some(Target::External(absolute(&vp.cwd, &name)))
	} else {
		Some(Target::Search)
	};
	let s = st(vp);
	s.argv = argv[i..].to_vec();
	s.target = target;
	s.exec_as = Some(Box::new(how));
	s.control = Some(Transfer::Exec);
	s.stage = Stage::Lookup;
	None
}

/// This vproc may settle a background job's pid ([`super::proc::Bang`]):
/// what the command about to run (`target`; `exec` when `exec` runs it)
/// decides. Its
/// lone external, or one it `exec`s, settles at the spawn (the job is known
/// by the program's OS pid); `exec` without a command and a function
/// called as the lone command leave the decision to what follows (a
/// function's `exec`); a host callout as the lone command may hand the job
/// to its subshell ([`crate::bash::ShellApi::exec_subshell_in`]); anything else
/// keeps the virtual pid.
#[cold]
#[inline(never)]
fn bang_dispatch(k: &mut Kernel, vpid: crate::bash::ids::Vpid, target: &Target, exec: bool) {
	let Some(bang) = k.bangs.iter_mut().find(|b| b.vproc == vpid) else {
		return;
	};
	match (target, bang.stage) {
		// A refused spawn is retried (`Refused`, `Script`): that decides.
		(Target::Intrinsic(IntrinsicId::Exec) | Target::Refused { .. }, _)
		| (Target::External(_) | Target::Interp(_), BangStage::Lone) => {},
		(Target::External(_) | Target::Interp(_), _) if exec => {},
		(Target::Function(_), BangStage::Lone | BangStage::Exec) => bang.stage = BangStage::Exec,
		(Target::Tool(_), BangStage::Lone) if !exec => bang.stage = BangStage::Callout,
		_ => k.settle_bang(vpid, None),
	}
}

/// zsh's `BINF_PSPECIAL` and `BINF_ASSIGN` builtins: under `posixbuiltins`
/// their prefix assignments persist (unless run through `command`).
const fn zsh_pspecial(id: IntrinsicId) -> bool {
	matches!(
		id,
		IntrinsicId::Dot
			| IntrinsicId::Colon
			| IntrinsicId::Break
			| IntrinsicId::Continue
			| IntrinsicId::Declare
			| IntrinsicId::Eval
			| IntrinsicId::Exit
			| IntrinsicId::Export
			| IntrinsicId::Float
			| IntrinsicId::Integer
			| IntrinsicId::Local
			| IntrinsicId::Readonly
			| IntrinsicId::Return
			| IntrinsicId::Set
			| IntrinsicId::Shift
			| IntrinsicId::Source
			| IntrinsicId::Times
			| IntrinsicId::Trap
			| IntrinsicId::Typeset
			| IntrinsicId::Unset
	)
}

/// POSIX special builtins (in posix mode their prefix assignments persist,
/// they are found before functions and no function may take their name).
pub const fn is_special(id: IntrinsicId) -> bool {
	matches!(
		id,
		IntrinsicId::Break
			| IntrinsicId::Colon
			| IntrinsicId::Dot
			| IntrinsicId::Continue
			| IntrinsicId::Eval
			| IntrinsicId::Exec
			| IntrinsicId::Exit
			| IntrinsicId::Export
			| IntrinsicId::Readonly
			| IntrinsicId::Return
			| IntrinsicId::Set
			| IntrinsicId::Shift
			| IntrinsicId::Source
			| IntrinsicId::Times
			| IntrinsicId::Trap
			| IntrinsicId::Unset
	)
}

/// `. file args…` set the positional parameters in the builtin's scope:
/// when the file changed them (`set --`, `shift`), the change outlives the
/// file, as in bash; unchanged ones are dropped with the scope.
fn keep_sourced_positional(k: &mut Kernel, store: &mut dyn StateStore, vp: &mut Vproc) {
	let Some(e) = vp
		.frames
		.last()
		.and_then(|f| f.scratch.as_ref())
		.and_then(|s| s.exec.as_ref())
	else {
		return;
	};
	let operands = match e.argv.get(1..).unwrap_or_default() {
		[p, _, _, rest @ ..] if p.as_slice() == b"-p" => rest,
		[dd, _, rest @ ..] if dd.as_slice() == b"--" => rest,
		[_, rest @ ..] => rest,
		[] => &[],
	};
	if operands.is_empty() {
		return;
	}
	let Some(top) = state::scope_count(&k.root, vp).checked_sub(1) else {
		return;
	};
	let positional = match state::scope_positional(store, vp, top) {
		Ok(p) => p,
		Err(err) => {
			k.fail(err);
			return;
		},
	};
	if positional.as_deref() == Some(operands) {
		return;
	}
	// The parameters go one level down; the top scope keeps none.
	if let Some(params) = positional {
		state::set_scope_positional(&mut k.root, store, vp, top, None);
		state::set_positional(&mut k.root, store, vp, params);
	}
}

/// Wait for what the command started.
fn await_(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>, op: Op, line: u32) -> Option<Flow> {
	let platform = k.engine.config().platform;
	let waiting = st(vp).waiting;
	// An external this vproc ran finished (a `SIGCHLD` trap owes a run).
	let mut reaped = false;
	let status = match waiting {
		// Back from a frame the builtin pushed: it runs again
		// (`Control::Resume`).
		Some(Awaited::Frame) if st(vp).resume => {
			let s = st(vp);
			s.resume = false;
			s.resumed += 1;
			s.waiting = None;
			s.stage = Stage::Dispatch;
			return None;
		},
		Some(Awaited::Frame) => {
			let status = vp.status;
			if matches!(st(vp).target, Some(Target::Intrinsic(IntrinsicId::Source | IntrinsicId::Dot)))
			{
				keep_sourced_positional(k, cx.store, vp);
			}
			// The name borrowed, not copied, per return; only the frame's end
			// ran since its last `CmdEnd`: the same reading (`Kernel::stamp`).
			if k.mask.contains(crate::bash::event::EventKind::FuncExit)
				&& let Some(Target::Function(name)) = current_exec(vp).and_then(|e| e.target.as_ref())
			{
				let t_ns = k.stamp(cx);
				let data = EventData::FuncExit { name: BStr::new(name), status };
				k.emit_op_at(cx, vp, op.node, data, t_ns);
			}
			// zsh's function wrappers (zsh/zprof, zsh/example) after the call.
			if vp.mode.dialect() == crate::bash::ids::Dialect::Zsh
				&& matches!(st(vp).target, Some(Target::Function(_)))
			{
				builtins::zsh_mod_zprof::leave(k, vp, cx);
				builtins::zsh_mod_example::leave(k, vp, cx);
				super::zle::comp::complete::wrap_leave(vp);
			}
			// zsh `exit` inside the call: its caller leaves in turn.
			if vp.zsh.is_some()
				&& let Some(pending) = exec::zsh_exit_pending(vp)
			{
				st(vp).control = Some(Transfer::Exit(pending));
			}
			status
		},
		Some(Awaited::Jobs { force }) => {
			let mut last = st(vp).status;
			let mut waited = None;
			while let Some(&v) = st(vp).wait_for.first() {
				// `wait -p` names the child by the pid the user knows (its
				// program's OS pid), read before the job is forgotten.
				let shown = vp.shown_pid(v);
				if let Some(s) = k.proc_collect(cx.store, v) {
					last = s;
					forget_job(vp, v);
					exec::reap_coproc(k, vp, cx, v);
				} else if let (false, Some(JobState::Stopped(sig))) =
					(force, vp.jobs.by_vpid(v).map(|j| j.state))
				{
					// bash with job control: a stop ends the wait for that job.
					last = sig.exit_status(platform);
				} else {
					return Some(Flow::Block(WaitKey::Proc(v)));
				}
				waited = Some(shown);
				st(vp).wait_for.remove(0);
			}
			if let Some(pid) = waited {
				waited_into(k, vp, cx, line, pid);
			}
			last
		},
		Some(Awaited::AllJobs) => {
			while let Some(&v) = st(vp).wait_for.first() {
				if k.proc_collect(cx.store, v).is_some() {
					exec::reap_coproc(k, vp, cx, v);
				} else if !matches!(vp.jobs.by_vpid(v).map(|j| j.state), Some(JobState::Stopped(_))) {
					// A job stopped meanwhile is skipped (job control).
					return Some(Flow::Block(WaitKey::Proc(v)));
				}
				st(vp).wait_for.remove(0);
			}
			// bash: `wait` forgets every finished job, except the one `$!`
			// names when it finished before the wait (POSIX keeps the last
			// async status until it is waited for or reported). A job this
			// shell just killed is still being reaped when bash's `wait`
			// looks, so that wait collects it (jobs.tests).
			let last = vp.last_bg;
			let done: Vec<crate::bash::ids::Vpid> = vp
				.jobs
				.iter()
				.filter(|j| match j.state {
					JobState::Done(status) => {
						!last.is(j.vpid)
							|| status > 128
							|| !matches!(k.proc_state(cx.store, j.vpid), Some(super::ProcState::Exited(_)))
					},
					_ => false,
				})
				.map(|j| j.vpid)
				.collect();
			for v in done {
				k.proc_collect(cx.store, v);
				forget_job(vp, v);
			}
			st(vp).status
		},
		Some(Awaited::AnyJob) => {
			let finished = st(vp).wait_for.iter().find_map(|v| {
				k.proc_state(cx.store, *v)
					.and_then(super::ProcState::exited)
					.map(|s| (*v, s))
			});
			let Some((v, status)) = finished else {
				if let Some(&v) = st(vp).wait_for.first() {
					return Some(Flow::Block(WaitKey::Proc(v)));
				}
				let s = st(vp);
				s.waiting = None;
				s.status = 127;
				s.stage = Stage::Output;
				return None;
			};
			let shown = vp.shown_pid(v);
			k.proc_collect(cx.store, v);
			forget_job(vp, v);
			st(vp).wait_for.clear();
			exec::reap_coproc(k, vp, cx, v);
			waited_into(k, vp, cx, line, shown);
			status
		},
		Some(Awaited::Call(id)) => match k.results.remove(&id) {
			Some(CallOutcome::Exit(n)) => n,
			Some(CallOutcome::Signaled(sig)) => sig.exit_status(platform),
			Some(CallOutcome::Error(msg)) => {
				let tool = st(vp).argv[0].clone();
				k.diag(cx, vp, line, Diag::Tool { tool, msg });
				1
			},
			None => return Some(Flow::Block(WaitKey::Call(id))),
		},
		Some(Awaited::Task(native)) => {
			let mut tcx = Context::from_waker(&k.waker);
			match &mut scratch(vp).live {
				Live::Task(task) => match task.poll(&mut tcx) {
					Poll::Ready(status) => status,
					Poll::Pending => return Some(Flow::Block(WaitKey::Task(native))),
				},
				_ => lost(k, vp, cx, op, line, Lost::Task { vpid: vp.vpid, native }),
			}
		},
		Some(Awaited::Ext { pid }) => {
			let replacing = matches!(st(vp).control, Some(Transfer::Exec));
			let run = vp.runs.front().map(|run| run.id);
			// Owned: a stop event below needs the kernel mutably.
			let waker = k.waker.clone();
			let mut tcx = Context::from_waker(&waker);
			// Stops and continues come first (job control, zsh's
			// `WUNTRACED`): the shell's own foreground job stopping is
			// suspended; anything else waits on.
			let exit = loop {
				let event = match &mut scratch(vp).live {
					Live::Ext(child) => child.poll_event(&mut tcx),
					_ => break None,
				};
				match event {
					Poll::Ready(ProcEvent::Exited(status)) => break Some(status),
					Poll::Ready(change) => {
						if let Some(flow) = super::jobctl::ext_event(k, cx, vp, change) {
							return Some(flow);
						}
					},
					Poll::Pending => return Some(Flow::Block(WaitKey::Ext { pid })),
				}
			};
			let killed = match exit {
				Some(ExitStatus::Signaled(sig)) => Some(sig),
				_ => None,
			};
			let status = match exit {
				Some(ExitStatus::Exited(code)) => {
					reaped = true;
					code
				},
				Some(ExitStatus::Signaled(sig)) => {
					reaped = true;
					if replacing && let Some(run) = run {
						k.exec_signals.insert(run, i32::from(sig.number(platform)));
					}
					sig.exit_status(platform)
				},
				Some(ExitStatus::SignaledRaw(signal)) => {
					reaped = true;
					if replacing && let Some(run) = run {
						k.exec_signals.insert(run, signal);
					}
					128 + signal
				},
				None => lost(k, vp, cx, op, line, Lost::Ext { vpid: vp.vpid, pid }),
			};
			if reaped && vp.parent.is_none() && k.jobctl.has_pgrp() {
				let text = vp
					.frames
					.last()
					.and_then(|f| f.unit.as_ref())
					.and_then(|u| {
						let n = u.nodes.get(op.node as usize)?;
						u.source
							.get(n.lo as usize..n.hi as usize)
							.map(<[u8]>::to_vec)
					})
					.unwrap_or_default();
				super::jobctl::fg_done(k, cx, vp, killed, &text);
			}
			status
		},
		None => st(vp).status,
	};
	if reaped {
		super::owe_chld(k, cx, vp, false);
	}
	// Tested first: a function call's wait holds none, and the assignment
	// would call the drop glue anyway.
	let live = &mut scratch(vp).live;
	if !matches!(live, Live::None) {
		*live = Live::None;
	}
	let s = st(vp);
	s.waiting = None;
	s.status = status;
	s.stage = Stage::Output;
	None
}

/// Drop the job led by `v` from the table once it was waited for (bash
/// `wait_for_job` marks it notified; `cleanup_dead_jobs` deletes it).
fn forget_job(vp: &mut Vproc, v: crate::bash::ids::Vpid) {
	if let Some(number) = vp.jobs.by_vpid(v).map(|j| j.number) {
		vp.jobs.remove(number);
	}
}

/// `wait -p var`: assign the waited child's pid (as `$!` showed it).
fn waited_into(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>, line: u32, pid: u32) {
	let Some(name) = st(vp).wait_into.take() else {
		return;
	};
	let (base, index) = builtins::split_subscript(&name);
	let lhs = Lhs { name: base, index, append: false };
	let value = AssignValue::Scalar(BString::from(pid.to_string()));
	if let Err(d) = builtins::set_value(k, cx, vp, lhs, value, Level::Dynamic) {
		k.diag(cx, vp, line, d);
	}
}

/// Write the command's own output in order (pollable).
fn output(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>, line: u32) -> Option<Flow> {
	// Most commands queued nothing: no waker (two atomic ops) for them.
	st(vp).writes.front()?;
	let waker = k.waker.clone();
	let mut tcx = Context::from_waker(&waker);
	loop {
		let state = st(vp);
		let pending = state.writes.front()?;
		if pending.off >= pending.bytes.len() {
			state.writes.pop_front();
			continue;
		}
		let fd = pending.fd;
		let handle = vp.fds.handle(fd);
		let state = st(vp);
		let pending = state.writes.front_mut().expect("checked");
		match handle.poll_write(&mut tcx, &pending.bytes[pending.off..]) {
			Poll::Ready(Ok(written)) if written > 0 => {
				pending.off += written;
				if pending.off >= pending.bytes.len() {
					state.writes.pop_front();
				}
			},
			Poll::Ready(res) => {
				state.writes.retain(|queued| queued.fd != fd);
				if fd != 2 {
					let err = res
						.err()
						.unwrap_or_else(|| std::io::ErrorKind::WriteZero.into());
					if err.kind() == std::io::ErrorKind::BrokenPipe && !sigpipe_ignored(cx.store, vp) {
						// The virtual SIGPIPE ends this shell silently, as it ends
						// a bash pipeline child.
						let platform = k.engine.config().platform;
						return Some(Flow::Exit(crate::bash::signal::Signal::Pipe.exit_status(platform)));
					}
					if vp.mode.dialect() == crate::bash::ids::Dialect::Zsh {
						zsh_write_error(k, vp, cx, line, fd, &err);
						continue;
					}
					let state = st(vp);
					// bash's `help` does not check its writes.
					if state.target == Some(Target::Intrinsic(IntrinsicId::Help)) {
						continue;
					}
					let cmd = Cow::Owned(String::from_utf8_lossy(&state.argv[0]).into_owned());
					state.status = 1;
					// Through the command's own fd 2 (`2>&1 >&4`), while its
					// redirections are in place.
					let bytes = k.render_diag(cx, vp, line, &Diag::WriteError { cmd, err });
					st(vp)
						.writes
						.push_back(PendingWrite { fd: 2, bytes: bytes.into(), off: 0 });
				}
			},
			Poll::Pending => return Some(Flow::Block(WaitKey::Write { fd })),
		}
	}
}

/// A failed write of a zsh builtin's output to `fd`: `bin_print`'s
/// `CLOSE_CLEANLY` (`print`/`echo`/`printf` fail with `NAME: write
/// error`, but for `EBADF` on standard output), then `execcmd`'s check of
/// `stdout` when the command did not redirect fd 1 (`write error`, the
/// status kept).
fn zsh_write_error(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	line: u32,
	fd: i32,
	err: &std::io::Error,
) {
	let mut text = crate::bash::diag::strerror(err).into_owned();
	let ebadf = text == "Bad file descriptor";
	if let Some(c) = text.get_mut(..1) {
		c.make_ascii_lowercase();
	}
	let msg = format!("write error: {text}");
	let redirected = scratch(vp)
		.io
		.as_ref()
		.is_some_and(|io| io.saved.iter().any(|s| s.fd == 1));
	let state = st(vp);
	let print = matches!(
		state.target,
		Some(Target::Intrinsic(IntrinsicId::Print | IntrinsicId::Echo | IntrinsicId::Printf))
	);
	let mut diags = Vec::new();
	if print && (fd != 1 || !ebadf) {
		state.status = 1;
		let cmd = Cow::Owned(String::from_utf8_lossy(&state.argv[0]).into_owned());
		diags.push(Diag::Prefixed { cmd, diag: Box::new(Diag::Usage { msg: msg.clone().into() }) });
	}
	if fd == 1 && !redirected {
		diags.push(Diag::Usage { msg: msg.into() });
	}
	for d in diags {
		let bytes = k.render_diag(cx, vp, line, &d);
		st(vp)
			.writes
			.push_back(PendingWrite { fd: 2, bytes: bytes.into(), off: 0 });
	}
}

/// Whether `SIGPIPE` is ignored (`trap '' PIPE`), so a write to a pipe
/// without readers reports `Broken pipe` instead of ending the shell.
fn sigpipe_ignored(store: &mut dyn StateStore, vp: &Vproc) -> bool {
	let key = Key::Trap(crate::bash::store::TrapKey::Signal(crate::bash::signal::Signal::Pipe));
	matches!(
		state::record(store, vp, key),
		Ok(Some(Record::Trap { action, .. })) if action.is_empty()
	)
}

/// Report the command and leave the op (or transfer control).
fn finish(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>, op: Op) -> Flow {
	let e = st(vp);
	let (status, t0, control) = (e.status, e.t0, e.control);
	let in_shell = matches!(e.target, Some(Target::Function(_) | Target::Intrinsic(_)));
	vp.status = status;
	vp.pipestatus.clear();
	vp.pipestatus.push(status);
	if k.mask.contains(crate::bash::event::EventKind::CmdEnd) {
		// One fresh reading for the duration and the event's stamp; the
		// next command's `CmdStart` may share it.
		let end = k.read_clock(cx);
		let dur_ns = if t0 > 0 { end.saturating_sub(t0) } else { 0 };
		let data = EventData::CmdEnd { status, dur_ns, pipestatus: &[] };
		k.emit_op_at(cx, vp, op.node, data, end);
	}
	let sc = vp
		.frames
		.last_mut()
		.and_then(|f| f.scratch.take())
		.expect("exec scratch");
	exec::drop_scratch(&mut k.root, cx.store, vp, sc);
	if k.mask.bits() != 0 {
		vp.fds.set_command_tag(None);
	}
	if status != 0 && in_shell && vp.mode.dialect() == crate::bash::ids::Dialect::Zsh {
		print_exit_value(k, vp, cx, status);
	}
	match control {
		None => Flow::Next,
		Some(Transfer::Return(n)) => Flow::Return(n),
		Some(Transfer::Break { n, cont }) => Flow::Break { n, cont },
		Some(Transfer::Exit(n)) => Flow::Exit(n),
		Some(Transfer::DiscardAll(n)) => {
			let command = matches!(
				state::record(cx.store, vp, Key::Misc(MiscKey::RunOrigin)),
				Ok(Some(Record::Misc(origin))) if origin.as_slice() == b"c"
			);
			let in_run = vp
				.frames
				.iter()
				.rev()
				.find(|f| matches!(f.kind, FrameKind::Script { .. }))
				.is_some_and(|f| matches!(f.kind, FrameKind::Script { what: ScriptKind::Run, .. }));
			// zsh: a builtin's `zerr` (`errflag`) unwinds through `zsh_discard`
			// (always-lists run, the builtin's status stays); `Abort` is the
			// parse-error path.
			if command && in_run && vp.mode.dialect() != crate::bash::ids::Dialect::Zsh {
				Flow::Abort(n)
			} else {
				Flow::Discard(n)
			}
		},
		Some(Transfer::Exec) => Flow::Exit(status),
	}
}

/// zsh `execcmd`/`execshfunc` under `printexitvalue` with `shinstdin`: a
/// builtin or function run in this shell (not a subshell) that failed
/// reports `zsh: exit N` on stderr.
#[inline(never)]
fn print_exit_value(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>, status: i32) {
	let on = |k: &mut Kernel, cx: &mut Cx<'_>, vp: &Vproc, o| {
		state::zsh_option(&mut k.root, cx.store, vp, o).unwrap_or(false)
	};
	if super::subshell_depth(vp) == 0
		&& on(k, cx, vp, ZshOpt::Printexitvalue)
		&& on(k, cx, vp, ZshOpt::Shinstdin)
	{
		let bytes = BString::from(format!("zsh: exit {status}\n"));
		vp.out.push_back(PendingWrite { fd: 2, bytes, off: 0 });
	}
}

/// A task or external that did not survive a restore: status 137.
fn lost(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>, op: Op, line: u32, what: Lost) -> i32 {
	k.emit_op(cx, vp, op.node, EventData::Lost { lost: &what });
	let name = st(vp).argv[0].clone();
	k.diag(cx, vp, line, Diag::Lost { name });
	137
}

/// The OS refused to execute a file without `#!` (`ENOEXEC`; Windows
/// `ERROR_BAD_EXE_FORMAT`).
fn is_enoexec(err: &std::io::Error) -> bool {
	let code = if cfg!(windows) { 193 } else { 8 };
	err.raw_os_error() == Some(code)
}

/// bash `check_binary_file`: a NUL before the first newline in the first
/// 80 bytes.
fn looks_binary(text: &[u8]) -> bool {
	let head = &text[..text.len().min(80)];
	let line = head
		.iter()
		.position(|&c| c == b'\n')
		.map_or(head, |i| &head[..i]);
	line.contains(&0)
}

/// Run a text file the OS would not execute as a script, as bash does: a
/// new shell started from the command's environment
/// ([`super::nested::start_script`]); wait for it.
fn run_script_file(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	line: u32,
	path: BString,
) -> Option<Flow> {
	let probe_req = Probe::Read { path: path.clone() };
	let mut sc = exec::take_scratch(vp);
	let answer = match probe::cached(&sc, &probe_req) {
		Some(r) => Ok(r.clone()),
		None => probe::perform(k, cx, vp, &mut sc, &probe_req),
	};
	vp.frames.last_mut().expect("frame").scratch = Some(sc);
	let text = match answer {
		Err(key) => return Some(Flow::Block(key)),
		Ok(ProbeResult::Bytes(Ok(text))) => text,
		Ok(ProbeResult::Bytes(Err(msg))) => {
			let name = st(vp).argv[0].clone();
			k.diag(cx, vp, line, Diag::Usage { msg: format!("{name}: {msg}").into() });
			let s = st(vp);
			s.status = 126;
			s.stage = Stage::Finish;
			exec_failed(k, cx, vp);
			return None;
		},
		Ok(_) => BString::default(),
	};
	if looks_binary(&text) {
		let name = st(vp).argv[0].clone();
		k.diag(cx, vp, line, Diag::BinaryFile { name });
		let s = st(vp);
		s.status = 126;
		s.stage = Stage::Finish;
		exec_failed(k, cx, vp);
		return None;
	}
	// The environment the program would have been given (`exec -c`: none).
	let env = if st(vp).exec_as.as_ref().is_some_and(|e| e.clear_env) {
		EnvView::new(Vec::new())
	} else {
		match build_env(k, cx, vp) {
			Ok(env) => env,
			Err(err) => {
				k.fail(err);
				return Some(Flow::Discard(1));
			},
		}
	};
	// `$0` is the file bash tried: a name with `/` as written, else the
	// PATH (or hash table) result.
	let name = st(vp).argv[0].clone();
	let file = if name.contains(&b'/') { name } else { path };
	super::nested::start_script(k, vp, cx, &env, &file, &text)
}

/// The answer to `probe` for the command running in `vp` (cached in its
/// scratch, so a re-run after a wake asks once); `Err` is the wait key.
pub fn command_probe(
	k: &Kernel,
	cx: &mut Cx<'_>,
	vp: &mut Vproc,
	probe: &Probe,
) -> Result<ProbeResult, WaitKey> {
	let mut sc = exec::take_scratch(vp);
	let answer = match probe::cached(&sc, probe) {
		Some(r) => Ok(r.clone()),
		None => probe::perform(k, cx, vp, &mut sc, probe),
	};
	vp.frames.last_mut().expect("frame").scratch = Some(sc);
	answer
}

/// After a failed `exec command`: the shell exits with the failure status
/// (`Transfer::Exec`), unless it is not a subshell and `execfail` is set or
/// it is interactive (bash's `no_exit_on_failed_exec`). Then it goes on, and
/// the command's redirections are undone.
fn exec_failed(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc) {
	if st(vp).exec_as.is_none() || super::nested::in_subshell(cx.store, vp) {
		return;
	}
	let execfail = state::option(&mut k.root, cx.store, vp, crate::bash::store::OptId::Execfail)
		.unwrap_or(false);
	let interactive = matches!(
		state::record(cx.store, vp, Key::Misc(MiscKey::Interactive)),
		Ok(Some(Record::Misc(v))) if v.as_slice() == b"1"
	);
	if execfail || interactive {
		st(vp).control = None;
	}
}

/// The not-found hook function of `vp`'s dialect: bash's
/// `command_not_found_handle`, zsh's `command_not_found_handler`.
fn not_found_hook_name(vp: &Vproc) -> &'static [u8] {
	if vp.mode.dialect() == crate::bash::ids::Dialect::Zsh {
		b"command_not_found_handler"
	} else {
		b"command_not_found_handle"
	}
}

/// Whether `hook` is the function running (it does not handle itself).
fn in_not_found_hook(vp: &Vproc, hook: &[u8]) -> bool {
	vp.frames
		.iter()
		.any(|f| matches!(&f.kind, FrameKind::Function { name, .. } if name.as_slice() == hook))
}

/// Whether a not-found hook would handle a missing command (it is defined
/// and not the one running): it wins over [`crate::bash::Host::fallback`],
/// as on a system whose tools are missing.
fn has_not_found_hook(cx: &mut Cx<'_>, vp: &Vproc) -> bool {
	let hook = not_found_hook_name(vp);
	!in_not_found_hook(vp, hook)
		&& matches!(
			state::record(cx.store, vp, Key::Func(BStr::new(hook))),
			Ok(Some(Record::Func { .. }))
		)
}

/// bash's `command_not_found_handle` (zsh's `command_not_found_handler`,
/// zsh `commandnotfound` in the forked child): when that function exists
/// (and is not the one running), it runs in a subshell with the command's
/// words as its arguments, and its status is the command's. `None`: no
/// handler, else the flow that waits for it.
fn not_found_hook(k: &mut Kernel, vp: &mut Vproc, cx: &mut Cx<'_>, line: u32) -> Option<Flow> {
	let hook = not_found_hook_name(vp);
	if in_not_found_hook(vp, hook) {
		return None;
	}
	match state::record(cx.store, vp, Key::Func(BStr::new(hook))) {
		Ok(Some(Record::Func { .. })) => {},
		Ok(_) => return None,
		Err(err) => {
			k.fail(err);
			return Some(Flow::Discard(1));
		},
	}
	let mut text = BString::from(hook);
	for word in &st(vp).argv {
		text.extend_from_slice(b" '");
		for &c in word.iter() {
			if c == b'\'' {
				text.extend_from_slice(b"'\\''");
			} else {
				text.push(c);
			}
		}
		text.push(b'\'');
	}
	text.push(b'\n');
	let child = vp.child_text(k, cx.store, &text, line, vp.fds.clone());
	let vpid = child.vpid;
	k.emit_op(cx, vp, 0, EventData::Subshell { child: vpid });
	k.spawned.push(Box::new(child));
	let s = st(vp);
	s.wait_for = vec![vpid];
	s.waiting = Some(Awaited::Jobs { force: true });
	s.stage = Stage::Await;
	Some(Flow::Block(WaitKey::Proc(vpid)))
}

/// The `#!` interpreter of `text` as bash's `getinterp` reads it (a
/// trailing CR shown as `^M`).
fn interpreter(text: &[u8]) -> BString {
	let line = text
		.get(2..)
		.unwrap_or_default()
		.split(|&c| c == b'\n')
		.next()
		.unwrap_or_default();
	let start = line
		.iter()
		.position(|c| !matches!(c, b' ' | b'\t'))
		.unwrap_or(line.len());
	let rest = &line[start..];
	let end = rest
		.iter()
		.position(|c| matches!(c, b' ' | b'\t'))
		.unwrap_or(rest.len());
	let mut interp = BString::from(&rest[..end]);
	if interp.last() == Some(&b'\r') {
		interp.pop();
		interp.extend_from_slice(b"^M");
	}
	interp
}

/// bash's `shell_execve` after the OS refused to run `path` with `code`
/// (not `ENOEXEC`): a directory is `Is a directory`; a missing or
/// non-executable file, `E2BIG` and `ENOMEM` report the error; an
/// executable whose `#!` interpreter cannot run is a `bad interpreter`
/// (126); else `ENOENT` is `required file not found`. Status 127 for
/// `ENOENT`, else 126.
fn refused(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	line: u32,
	path: &BString,
	code: i32,
) -> Option<Flow> {
	use std::io::ErrorKind;
	if vp.mode.dialect() == crate::bash::ids::Dialect::Zsh {
		return zsh_refused(k, vp, cx, line, path, code);
	}
	let err = std::io::Error::from_raw_os_error(code);
	// bash names the file it tried: the PATH (or hash table) result, a name
	// with `/` as written.
	let name = {
		let n = st(vp).argv[0].clone();
		if n.contains(&b'/') { n } else { path.clone() }
	};
	let enoent = err.kind() == ErrorKind::NotFound;
	let mut status = if enoent { 127 } else { 126 };
	let stat = match command_probe(k, cx, vp, &Probe::Stat { path: path.clone(), follow: true }) {
		Err(key) => return Some(Flow::Block(key)),
		Ok(ProbeResult::Stat(stat)) => stat,
		Ok(_) => None,
	};
	let diag = if stat.as_ref().is_some_and(|s| s.kind == StatKind::Dir) {
		Diag::IsADirectory { name }
	} else {
		// bash's `executable_file`: it exists and may be executed.
		let executable = stat.is_some()
			&& match command_probe(k, cx, vp, &Probe::Access { path: path.clone(), mode: 4 }) {
				Err(key) => return Some(Flow::Block(key)),
				Ok(ProbeResult::Ok(ok)) => ok,
				Ok(_) => false,
			};
		if !executable
			|| matches!(err.kind(), ErrorKind::ArgumentListTooLong | ErrorKind::OutOfMemory)
		{
			Diag::Refused { name, err }
		} else {
			let text = match command_probe(k, cx, vp, &Probe::Read { path: path.clone() }) {
				Err(key) => return Some(Flow::Block(key)),
				Ok(ProbeResult::Bytes(Ok(text))) => text,
				Ok(_) => BString::default(),
			};
			if text.starts_with(b"#!") {
				status = 126;
				Diag::BadInterpreter { name, interp: interpreter(&text), err }
			} else if enoent {
				Diag::RequiredFileMissing { name }
			} else {
				Diag::Refused { name, err }
			}
		}
	};
	k.diag(cx, vp, line, diag);
	let s = st(vp);
	s.status = status;
	s.stage = Stage::Output;
	exec_failed(k, cx, vp);
	None
}

/// zsh `zexecve` after `ENOENT` or `ENOEXEC` for `path`. A `#!` line: with
/// `ENOEXEC` its interpreter runs as written; with `ENOENT` one that is not
/// absolute is searched in `$PATH`; it runs with the line's argument (if
/// any), the script and the arguments. A `#!` line without a newline, or an
/// interpreter not found: `PATH: bad interpreter: INTERP: ERROR` (the
/// only message: zsh's error flag is set). `ENOEXEC` without `#!`: the
/// file runs as a script. Otherwise zsh `execute`'s report: `%e: NAME` for
/// a name with a slash, else `command not found`.
#[inline(never)]
fn zsh_refused(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	line: u32,
	path: &BString,
	code: i32,
) -> Option<Flow> {
	let err = std::io::Error::from_raw_os_error(code);
	let enoexec = is_enoexec(&err);
	let status = if enoexec { 126 } else { 127 };
	let name = st(vp).argv[0].clone();
	let pth = if name.contains(&b'/') {
		name.clone()
	} else {
		path.clone()
	};
	let text = match command_probe(k, cx, vp, &Probe::Read { path: path.clone() }) {
		Err(key) => return Some(Flow::Block(key)),
		Ok(ProbeResult::Bytes(Ok(text))) => text,
		Ok(_) => BString::default(),
	};
	let msg = if let Some(rest) = text.strip_prefix(b"#!") {
		let interp = if let Some(nl) = rest.iter().position(|&c| c == b'\n') {
			let first = rest[..nl].trim_ascii_end();
			let first = &first[first.iter().take_while(|&&c| c == b' ').count()..];
			let end = first.iter().position(|&c| c == b' ').unwrap_or(first.len());
			let (prog, arg) = (&first[..end], first.get(end + 1..));
			let run = if enoexec {
				Some(absolute(&vp.cwd, prog))
			} else if prog.starts_with(b"/") {
				None
			} else {
				let search = state::lookup(&k.root, cx.store, vp, b"PATH")
					.ok()
					.flatten()
					.and_then(|v| v.as_scalar().map(BString::from))
					.unwrap_or_default();
				let probe = Probe::Path { name: BString::from(prog), path: search };
				match command_probe(k, cx, vp, &probe) {
					Err(key) => return Some(Flow::Block(key)),
					Ok(ProbeResult::Path(found)) => found.map(|f| absolute(&vp.cwd, &f)),
					Ok(_) => None,
				}
			};
			if let Some(run) = run {
				let s = st(vp);
				let mut argv = Vec::with_capacity(s.argv.len() + 2);
				argv.push(BString::from(prog));
				argv.extend(arg.map(BString::from));
				argv.push(pth);
				argv.extend(s.argv.drain(1..));
				s.argv = argv;
				s.target = Some(Target::Interp(run));
				return None;
			}
			BString::from(prog)
		} else {
			BString::from(rest)
		};
		format!("{pth}: bad interpreter: {interp}: {}", super::redir::zsh_errno(&err))
	} else if enoexec {
		st(vp).target = Some(Target::Script(path.clone()));
		return None;
	} else if name.contains(&b'/') {
		format!("{}: {name}", super::redir::zsh_errno(&err))
	} else {
		format!("command not found: {name}")
	};
	k.diag(cx, vp, line, Diag::Usage { msg: msg.into() });
	let s = st(vp);
	s.status = status;
	s.stage = Stage::Output;
	exec_failed(k, cx, vp);
	None
}

fn spawn_error(name: BString, err: std::io::Error) -> (Diag, i32) {
	match err.kind() {
		std::io::ErrorKind::NotFound => (Diag::NoSuchFile { name }, 127),
		std::io::ErrorKind::PermissionDenied => (Diag::PermissionDenied { name }, 126),
		std::io::ErrorKind::IsADirectory => (Diag::IsADirectory { name }, 126),
		_ => (Diag::CannotExecute { name, err }, 126),
	}
}

/// How an external gets fd object `h`, as its input or its `output`: a
/// slot the script closed stays closed (bash's child inherits it so); an
/// object a restore lost reads as the null device.
fn stdio_spec(h: &FdRef, output: bool) -> StdioSpec {
	let os = if output {
		h.os_output_handle()
	} else {
		h.os_handle()
	};
	if h.origin() == FdOrigin::Closed {
		StdioSpec::Closed
	} else if !h.is_open() {
		StdioSpec::Null
	} else if let Some(os) = os {
		StdioSpec::Inherit(os)
	} else {
		StdioSpec::Pipe(h.clone())
	}
}

fn extra_fds(vp: &Vproc) -> Vec<(i32, FdRef)> {
	// A close-on-exec fd (`sysopen -o cloexec`, a `zsystem flock` lock) is
	// not inherited, nor is one the script closed.
	vp.fds
		.iter()
		.filter(|(fd, h)| {
			*fd > 2
				&& h.origin() != FdOrigin::Closed
				&& !h.flags().contains(crate::bash::FdFlags::CLOEXEC)
		})
		.map(|(fd, h)| (fd, h.clone()))
		.collect()
}

/// The environment of a command: exported variables as the vproc sees them
/// (prefix assignments are in its innermost scope), plus exported
/// functions as `BASH_FUNC_name%%`. Built per external (and nested shell
/// or tool call): only the exported entries are read and copied.
fn build_env(k: &Kernel, cx: &mut Cx<'_>, vp: &Vproc) -> Result<EnvView, StoreError> {
	let mut pairs: Vec<(BString, BString)> = Vec::new();
	state::exported(&k.root, cx.store, vp, &mut pairs)?;
	// Imported strings with non-identifier names pass through unchanged.
	if let Some(Record::Words(foreign)) =
		state::record(cx.store, vp, Key::Misc(MiscKey::ForeignEnv))?
	{
		for entry in foreign {
			let eq = entry.iter().position(|&c| c == b'=').unwrap_or(entry.len());
			pairs.push((
				BString::from(&entry[..eq]),
				BString::from(entry.get(eq + 1..).unwrap_or_default()),
			));
		}
	}
	let vars = pairs.len();
	state::exported_funcs(cx.store, vp, &mut pairs)?;
	for (name, source) in &mut pairs[vars..] {
		let body = source
			.strip_prefix(name.as_slice())
			.and_then(|s| s.strip_prefix(b" () \n"))
			.unwrap_or(source.as_slice());
		let mut value = BString::from("() ");
		value.extend_from_slice(body);
		let mut key = BString::from("BASH_FUNC_");
		key.extend_from_slice(name.as_slice());
		key.extend_from_slice(b"%%");
		*name = key;
		*source = value;
	}
	// Prefix assignments of the current command shadow everything else.
	if let Some(e) = vp
		.frames
		.last()
		.and_then(|f| f.scratch.as_ref())
		.and_then(|s| s.exec.as_ref())
	{
		for ((index, value), (name, _)) in e.values.iter().zip(&e.assigns) {
			if let (None, AssignValue::Scalar(v)) = (index, value) {
				pairs.retain(|(n, _)| n != name);
				pairs.push((name.clone(), v.clone()));
			}
		}
	}
	Ok(EnvView::new(pairs))
}

#[cfg(test)]
mod tests {
	use super::{fpath_dirs, looks_binary};
	use crate::bash::ids::Platform;

	/// `$fpath` joins Windows directories with `;`; the autoload search
	/// split `FPATH` on `:` and looked in `C` and `/fn`, never finding the
	/// function.
	#[test]
	fn fpath_dirs_split_on_the_platform_separator() {
		assert_eq!(fpath_dirs(Some(b"C:/a/fn;D:/b"), Platform::Windows), ["C:/a/fn", "D:/b"]);
		assert_eq!(fpath_dirs(Some(b"/a:/b"), Platform::Linux), ["/a", "/b"]);
	}

	// bash `check_binary_file`: only a NUL on the first line (within 80
	// bytes) makes a file binary.
	#[test]
	fn binary_check_looks_at_the_first_line_only() {
		assert!(!looks_binary(b"(echo \"$1\")\n"));
		assert!(looks_binary(b"\x7fELF\x02\x01\x01\0\0"));
		assert!(!looks_binary(b"echo hi\n\0binary after the first line"));
		assert!(!looks_binary(b""));
	}
}
