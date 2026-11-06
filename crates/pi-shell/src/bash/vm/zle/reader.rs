//! The interactive reader (zsh 5.9 `init.c` `loop()`, `utils.c`
//! `preprompt()`, `input.c` `inputline()`): what an interactive shell does
//! around reading each line of its standard input.
//!
//! It runs where the stdin script frame needs more input
//! (`exec::next_command`): before a first line, the pre-prompt work
//! (`PROMPT_SP`, job notices, `precmd`, `periodic`, mail); then the prompt
//! (`PS1`/`RPS1`, or `PS2`/`RPS2` with the `%_` context of a command left
//! open) and the line, read by ZLE when it can be, else plainly; after a
//! complete command is parsed, `preexec` ([`before_run`]); at end of input,
//! `ignoreeof`, the job check and the logout files. Hooks are
//! shell functions run as frames of the root vproc: the reader returns to
//! the VM and goes on when they have returned.

use std::collections::VecDeque;

use bstr::{BString, ByteSlice};

use super::{
	Context, Editor,
	exec::{self, Drive, Got, ReadTask, Task, push_call},
	from_line, readflags,
	tty::Tty,
	utils, zle_mut,
};
use crate::bash::{
	event::WaitKey,
	host::{Deadline, Timer},
	ids::Dialect,
	store::{Key, MiscKey, Record},
	syntax::zsh::tok,
	vm::{
		Cx, Kernel,
		exec::{Flow, Sub, settle_sub, start_sub, start_zsh_sub},
		expand::{Expander, Stop},
		jobctl, probe,
		proc::{FrameKind, PendingWrite, Probe, ProbeResult, Scratch, ScriptKind, Slot, Vproc},
		state,
		zsh::params,
	},
	zshopt::ZshOpt,
};

/// The reader's state between its steps ([`super::Zle::reader`]).
#[derive(Default)]
pub struct Reader {
	phase:            Phase,
	/// The terminal was resized (`SIGWINCH`).
	pub winch:        bool,
	/// `SIGINT` while reading a line without ZLE: the line is abandoned.
	pub interrupted:  bool,
	/// Expansion replay and command substitutions of the prompts.
	sc:               Box<Scratch>,
	/// Hook calls still to make, in order.
	queue:            VecDeque<(BString, Vec<BString>)>,
	/// The hook frame running: frame count before it, `$?` to restore.
	running:          Option<(usize, i32)>,
	/// A hook of the current batch existed (zsh `callhookfunc`'s
	/// `stat == 0`).
	hooked:           bool,
	/// zsh `lastperiodic` (seconds).
	lastperiodic:     i64,
	/// zsh `lastmailcheck` (seconds).
	lastmailcheck:    i64,
	/// `$?` when the prompt is shown (zsh `lastval` at `preprompt`).
	status:           i32,
	/// The prompts of the line (raw and expanded).
	prompts:          Option<Prompts>,
	/// The event position whose `preexec` has run (the command parsed
	/// there runs now).
	gate:             Option<u32>,
	/// zsh `noexitct`: EOFs ignored under `ignoreeof`.
	noexitct:         u32,
	/// zsh `use_exit_printed` of the last line.
	use_exit_printed: bool,
	/// The line read is a continuation (`PS2`).
	cont:             bool,
	/// `%_` of the continuation prompt.
	cmdstack:         Vec<&'static str>,
	/// `TMOUT`'s timer while a line is read.
	tmout:            Option<Box<dyn Timer>>,
	/// zsh `hist_skip_flags & HIST_FOREIGN`, kept across lines.
	localhistory:     bool,
	/// History's progress for the line (`before_line`, `expand`).
	hsc:              Box<Scratch>,
	/// History's `before_line` ran for this line.
	began:            bool,
	/// A line read, waiting for its history expansion.
	pending:          Option<(BString, bool)>,
	/// The event position whose `zshaddhistory` hooks ran, and their
	/// status.
	added:            Option<u32>,
	/// The first non-zero `zshaddhistory` status of the batch running.
	addret:           i32,
	/// The logout files were sourced (zsh does it once).
	logged_out:       bool,
}

/// The expanded prompts of a line.
struct Prompts {
	raw_lp: BString,
	raw_rp: BString,
	lp:     zsh_prompt_expansion::Expansion,
	rp:     zsh_prompt_expansion::Expansion,
}

/// The prompt expansion type.
mod zsh_prompt_expansion {
	pub use crate::bash::vm::builtins::zsh_prompt::Expansion;
}

#[derive(Default, Clone, Copy, PartialEq, Eq, Debug)]
enum Phase {
	/// Before a line: nothing done yet.
	#[default]
	Idle,
	/// Running `precmd` hooks.
	Precmd,
	/// Running `periodic` hooks.
	Periodic,
	/// Checking mail.
	Mail,
	/// Expanding the prompts.
	Prompt,
	/// ZLE reads the line.
	Edit,
	/// The prompt is printed and the line read without ZLE.
	Plain,
	/// Running `preexec` hooks for the event at this position.
	Preexec(u32),
	/// End of input: sourcing the logout files (index of the next one).
	Logout(u8),
	/// The line read goes through history expansion.
	Expand,
	/// zsh/sched events due, and zsh/watch's login check.
	Sched,
	/// Running `zshaddhistory` hooks for the event at this position.
	AddHist(u32),
}

impl Reader {
	/// Whether a line is being read (a `SIGINT` abandons it).
	pub const fn reading(&self) -> bool {
		matches!(self.phase, Phase::Edit | Phase::Plain)
	}
}

/// What reading a line gave.
enum Line {
	/// The line, with its newline.
	Text(BString),
	/// End of input.
	Eof,
	/// The line was abandoned (`SIGINT`, `send-break`).
	Abort,
	/// The terminal cannot be read any more (zsh `getbyte`'s `zexit(1)`).
	Lost,
}

/// Whether the interactive reader reads `vp`'s standard input: the root
/// vproc of an interactive shell running the script it reads from stdin.
pub fn applies(cx: &mut Cx<'_>, vp: &Vproc) -> bool {
	vp.frames
		.len()
		.checked_sub(1)
		.is_some_and(|i| input_frame(cx, vp, i))
}

/// Whether frame `i` of `vp` is the interactive shell's own input (the
/// frame the reader serves): after an error there the shell goes on with
/// its next command (zsh `loop`, bash `reader_loop`).
pub fn input_frame(cx: &mut Cx<'_>, vp: &Vproc, i: usize) -> bool {
	vp.parent.is_none()
		&& matches!(
			vp.frames.get(i).map(|f| &f.kind),
			Some(FrameKind::Script { what: ScriptKind::Run, stdin: true, .. })
		)
		&& matches!(
			state::record(cx.store, vp, Key::Misc(MiscKey::Interactive)),
			Ok(Some(Record::Misc(v))) if v.as_slice() == b"1"
		)
}

/// The event position whose `preexec` already ran (see [`before_run`]).
pub fn gate(vp: &Vproc) -> Option<u32> {
	vp.zle.as_ref()?.reader.as_ref()?.gate
}

/// Run `f` with the reader taken out of `vp` (created on first use).
fn with_reader<T>(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &mut Vproc,
	f: impl FnOnce(&mut Reader, &mut Kernel, &mut Cx<'_>, &mut Vproc) -> T,
) -> T {
	let z = zle_mut(k, cx, vp);
	let mut r = z.reader.take().unwrap_or_default();
	if z.tty.is_none() {
		z.tty = Tty::open(k);
	}
	let out = f(&mut r, k, cx, vp);
	if let Some(z) = vp.zle.as_deref_mut() {
		z.reader = Some(r);
	}
	out
}

/// Read the next line of an interactive shell's input into the stdin
/// frame (`cont`: the command so far is incomplete, `cmdstack` its open
/// constructs for `%_`). `Some` parks; `None` goes on: the line was read,
/// or a hook or widget frame was pushed (the reader goes on when the VM
/// comes back to the stdin frame).
pub fn read_line(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	cont: bool,
	cmdstack: Vec<&'static str>,
) -> Option<WaitKey> {
	with_reader(k, cx, vp, |r, k, cx, vp| r.step(k, cx, vp, cont, cmdstack))
}

/// Before the command parsed at `pos` of the stdin frame runs: zsh's
/// `preexec` hooks with the history line, a one-line text and the full
/// text of the event. `None` with the gate open runs it (the caller checks
/// [`gate`] first); otherwise `None` means a hook frame was pushed.
pub fn before_run(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	pos: u32,
	args: [BString; 3],
) -> Option<WaitKey> {
	with_reader(k, cx, vp, |r, k, cx, vp| {
		if r.phase != Phase::Preexec(pos) {
			r.phase = Phase::Preexec(pos);
			r.queue.clear();
			r.running = None;
			if vp.mode.dialect() == Dialect::Zsh {
				let [hist, short, full] = args;
				let list = vec![hist, short, full];
				hook_batch(r, k, cx, vp, b"preexec", &list);
			} else {
				// bash `PS0`: expanded and printed after the line is read.
				if let Some(ps0) = scalar(k, cx, vp, b"PS0")
					&& let Ok(Some(text)) = r.expand(k, cx, vp, |ex| ex.prompt(&ps0))
				{
					let text: Vec<u8> = text.iter().copied().filter(|&c| c != 1 && c != 2).collect();
					vp.out
						.push_back(PendingWrite { fd: 2, bytes: BString::from(text), off: 0 });
				}
			}
		}
		if r.run_queue(k, cx, vp) {
			return None;
		}
		r.phase = Phase::Idle;
		r.gate = Some(pos);
		// bash `\#`: the next command number.
		if vp.mode.dialect() != Dialect::Zsh {
			let n = match state::record(cx.store, vp, Key::Misc(MiscKey::BashCommandNumber)) {
				Ok(Some(Record::Misc(v))) => v
					.to_str()
					.ok()
					.and_then(|s| s.parse::<u64>().ok())
					.unwrap_or(1),
				_ => 1,
			};
			k.root
				.set_misc(cx.store, MiscKey::BashCommandNumber, (n + 1).to_string());
		}
		None
	})
}

/// zsh `hend`'s `zshaddhistory` hooks for the event parsed at `pos` of the
/// stdin frame, with the event's history text: `Ok` with the first
/// non-zero status (0 when none, or no text), `Err` while a hook runs
/// (`None`: its frame was pushed) — call again when the VM comes back.
pub fn addhistory(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	pos: u32,
) -> Result<i32, Option<WaitKey>> {
	with_reader(k, cx, vp, |r, k, cx, vp| {
		if r.added == Some(pos) {
			return Ok(r.addret);
		}
		if r.phase != Phase::AddHist(pos) {
			r.phase = Phase::AddHist(pos);
			r.queue.clear();
			r.running = None;
			r.addret = 0;
			let text = crate::bash::vm::builtins::history::zsh::hook_text(cx.store, vp)
				.ok()
				.flatten();
			if let Some(text) = text {
				hook_batch(r, k, cx, vp, b"zshaddhistory", &[text]);
			}
		}
		if let Some((_, status)) = r.running.take() {
			if r.addret == 0 {
				r.addret = vp.status;
			}
			vp.status = status;
		}
		if let Some((name, args)) = r.queue.pop_front() {
			r.running = Some(push_call(k, vp, &name, &args, false));
			return Err(None);
		}
		r.phase = Phase::Idle;
		r.added = Some(pos);
		Ok(r.addret)
	})
}

/// Queue the calls of hook `name` (zsh `callhookfunc(name, args, 1)`):
/// the function `name`, then each function `name_functions` lists, all
/// with `args` after their name.
fn hook_batch(
	r: &mut Reader,
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &mut Vproc,
	name: &[u8],
	args: &[BString],
) {
	r.hooked = false;
	if exec::function_exists(cx, vp, name) {
		r.queue.push_back((BString::from(name), args.to_vec()));
		r.hooked = true;
	}
	let mut arr = BString::from(name);
	arr.extend_from_slice(b"_functions");
	// The list as it is now (zsh copies it before calling any; zsh
	// `getaparam`: only an array counts).
	let listed: Vec<BString> = {
		let mut log = Vec::new();
		let mut ex = Expander::new(k, cx, vp, &mut log, false, 0);
		params::getaparam(&mut ex, &arr)
			.ok()
			.flatten()
			.unwrap_or_default()
	};
	for f in listed {
		if exec::function_exists(cx, vp, &f) {
			r.queue.push_back((f, args.to_vec()));
			r.hooked = true;
		}
	}
}

/// The value of scalar parameter `name` (zsh `getsparam`).
fn scalar(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc, name: &[u8]) -> Option<BString> {
	let mut log = Vec::new();
	let mut ex = Expander::new(k, cx, vp, &mut log, false, 0);
	params::getsparam(&mut ex, name).ok().flatten()
}

/// A zsh option of `vp` (`false` when the store fails).
fn isset(k: &mut Kernel, cx: &mut Cx<'_>, vp: &Vproc, o: ZshOpt) -> bool {
	state::zsh_option(&mut k.root, cx.store, vp, o).unwrap_or(false)
}

/// zsh history records the shell's input lines (History's `recording`).
fn zhist(k: &mut Kernel, cx: &mut Cx<'_>, vp: &Vproc) -> bool {
	vp.mode.dialect() == Dialect::Zsh
		&& crate::bash::vm::builtins::history::recording(&mut k.root, cx.store, vp).unwrap_or(false)
}

/// Wall-clock seconds.
fn now_secs(cx: &Cx<'_>) -> i64 {
	cx.host.wall().secs
}

/// What an expansion that may run a command substitution needs next.
enum Pause {
	/// Wait for this.
	Park(WaitKey),
	/// A frame was pushed (a no-fork substitution).
	Frame,
}

impl From<Flow> for Pause {
	fn from(f: Flow) -> Self {
		match f {
			Flow::Block(key) => Self::Park(key),
			_ => Self::Frame,
		}
	}
}

impl Reader {
	/// Run `f` as an expansion whose command substitutions run first
	/// (in child vprocs, replayed from the log): `Ok(None)` when it
	/// failed (its diagnostic is out), `Err` while a substitution runs.
	fn expand<T>(
		&mut self,
		k: &mut Kernel,
		cx: &mut Cx<'_>,
		vp: &mut Vproc,
		f: impl FnOnce(&mut Expander<'_, '_>) -> crate::bash::vm::expand::X<T>,
	) -> Result<Option<T>, Pause> {
		if let Some(flow) = settle_sub(k, vp, cx, &mut self.sc, Slot::Builtin) {
			return Err(flow.into());
		}
		let mut log = std::mem::take(&mut self.sc.logs[Slot::Builtin as usize]);
		let r = {
			let mut ex = Expander::new(k, cx, vp, &mut log, true, 0);
			crate::bash::vm::zsh::subst::begin_pass(&mut ex).and_then(|()| f(&mut ex))
		};
		self.sc.logs[Slot::Builtin as usize] = log;
		match r {
			Ok(v) => {
				self.sc.recycle();
				Ok(Some(v))
			},
			Err(Stop::ZshSub { text, here }) => {
				Err(start_zsh_sub(k, vp, cx, &mut self.sc, &text, here, 0).into())
			},
			// A math function (`functions -M`) called from a prompt: its
			// frame runs above, the expansion replays with its value.
			Err(Stop::MathCall(call)) => Err(
				crate::bash::vm::command::start_math_call(
					k,
					vp,
					cx,
					&mut self.sc,
					Slot::Builtin,
					&call,
					0,
				)
				.into(),
			),
			Err(Stop::Sub { unit, entry, form, text }) => {
				Err(start_sub(k, vp, cx, &mut self.sc, Sub { unit, entry, form, text, line: 0 }).into())
			},
			Err(Stop::Fail(d) | Stop::Fatal(d)) => {
				self.sc.recycle();
				k.diag(cx, vp, 0, d);
				Ok(None)
			},
			Err(Stop::Store(e)) => {
				self.sc.recycle();
				k.fail(e);
				Ok(None)
			},
			Err(Stop::Wait(key)) => Err(Pause::Park(key)),
			Err(_) => {
				self.sc.recycle();
				Ok(None)
			},
		}
	}

	/// Make the queued hook calls one at a time: `true` after pushing a
	/// frame (come back when it has returned), `false` when the queue is
	/// done.
	fn run_queue(&mut self, k: &mut Kernel, _cx: &mut Cx<'_>, vp: &mut Vproc) -> bool {
		if let Some((_, status)) = self.running.take() {
			vp.status = status;
		}
		let Some((name, args)) = self.queue.pop_front() else {
			return false;
		};
		self.running = Some(push_call(k, vp, &name, &args, false));
		true
	}

	/// One go of the reader (see [`read_line`]).
	fn step(
		&mut self,
		k: &mut Kernel,
		cx: &mut Cx<'_>,
		vp: &mut Vproc,
		cont: bool,
		cmdstack: Vec<&'static str>,
	) -> Option<WaitKey> {
		loop {
			match self.phase {
				Phase::Idle => {
					// zsh history: the event begins (`hbegin`, so `%h` is the
					// new line's number) before the prompt.
					if !self.began && zhist(k, cx, vp) {
						match crate::bash::vm::builtins::history::zsh::before_line(
							k,
							cx,
							vp,
							&mut self.hsc,
						) {
							Err(key) => return Some(key),
							Ok(Some(out)) => {
								let failed = out.failed;
								let mut run = true;
								crate::bash::vm::exec::hend_output(k, cx, vp, out, &mut run);
								// zsh `loop`: a line that did not parse sets `$?`.
								if failed && vp.status == 0 {
									vp.status = 1;
								}
							},
							Ok(None) => {},
						}
						self.hsc.recycle();
					}
					self.began = true;
					self.cont = cont;
					self.cmdstack.clone_from(&cmdstack);
					self.status = vp.status;
					self.queue.clear();
					self.running = None;
					self.gate = None;
					self.added = None;
					if cont {
						self.phase = Phase::Prompt;
						continue;
					}
					if let Some(key) = self.preprompt(k, cx, vp) {
						return Some(key);
					}
					if vp.mode.dialect() == Dialect::Zsh {
						hook_batch(self, k, cx, vp, b"precmd", &[]);
					} else {
						self.prompt_command(k, cx, vp);
					}
					self.phase = Phase::Precmd;
					if self.running.is_some() {
						// `PROMPT_COMMAND` runs first.
						return None;
					}
				},
				Phase::Precmd => {
					if self.run_queue(k, cx, vp) {
						return None;
					}
					self.phase = Phase::Periodic;
					if vp.mode.dialect() == Dialect::Zsh {
						let period = scalar(k, cx, vp, b"PERIOD").map_or(0, |v| params::parse_int(&v));
						let now = now_secs(cx);
						if period != 0 && now > self.lastperiodic.saturating_add(period) {
							hook_batch(self, k, cx, vp, b"periodic", &[]);
							if self.hooked {
								self.lastperiodic = now;
							}
						}
					}
				},
				Phase::Periodic => {
					if self.run_queue(k, cx, vp) {
						return None;
					}
					self.phase = Phase::Mail;
				},
				Phase::Mail => {
					if let Some(key) = self.mailcheck(k, cx, vp) {
						return Some(key);
					}
					self.phase = Phase::Sched;
					if vp.mode.dialect() == Dialect::Zsh {
						let mut log = Vec::new();
						let mut ex = Expander::new(k, cx, vp, &mut log, false, 0);
						if let Ok(out) = crate::bash::vm::builtins::zsh_mod_watch::check(&mut ex)
							&& !out.is_empty()
						{
							vp.out.push_back(PendingWrite {
								fd:    1,
								bytes: BString::from(out),
								off:   0,
							});
						}
					}
				},
				Phase::Sched => {
					// zsh `checksched`: each due event runs (as `eval` text)
					// before the next is taken.
					if let Some((_, status)) = self.running.take() {
						vp.status = status;
					}
					let now = now_secs(cx);
					let due = if vp.mode.dialect() == Dialect::Zsh {
						crate::bash::vm::builtins::zsh_mod_sched::take_due(&mut k.root, cx.store, vp, now)
							.unwrap_or_else(|err| {
								k.fail(err);
								None
							})
					} else {
						None
					};
					match due {
						Some(ev) => {
							let depth = vp.frames.len();
							let status = vp.status;
							crate::bash::vm::exec::push_script(vp, &ev.cmd, 1, ScriptKind::Eval);
							self.running = Some((depth, status));
							return None;
						},
						None => self.phase = Phase::Prompt,
					}
				},
				Phase::Prompt => {
					match self.prompts(k, cx, vp) {
						Ok(()) => {},
						Err(Pause::Park(key)) => return Some(key),
						Err(Pause::Frame) => return None,
					}
					if self.start_zle(k, cx, vp) {
						self.phase = Phase::Edit;
					} else {
						self.phase = Phase::Plain;
						self.print_plain_prompt(vp);
						// The prompt is out before the line is waited for.
						if let Some(fd) = crate::bash::vm::exec::flush_out(k, vp) {
							return Some(WaitKey::Write { fd });
						}
					}
				},
				Phase::Edit => {
					let line = match self.drive_zle(k, cx, vp) {
						Ok(line) => line,
						Err(Pause::Park(key)) => return self.park_tmout(k, cx, vp, key),
						Err(Pause::Frame) => return None,
					};
					return self.got_line(k, cx, vp, line);
				},
				Phase::Plain => {
					let line = match self.read_plain(k, cx, vp) {
						Ok(line) => line,
						Err(key) => return self.park_tmout(k, cx, vp, key),
					};
					return self.got_line(k, cx, vp, line);
				},
				Phase::Preexec(_) | Phase::AddHist(_) => {
					// A `preexec` batch interrupted by an abandoned command:
					// start over.
					self.phase = Phase::Idle;
				},
				Phase::Logout(i) => return self.logout(k, cx, vp, i),
				Phase::Expand => {
					let Some((text, eof)) = self.pending.take() else {
						self.phase = Phase::Idle;
						continue;
					};
					return self.expand_line(k, cx, vp, text, eof);
				},
			}
		}
	}

	/// zsh `preprompt`'s display part: `SIGWINCH` handling, `PROMPT_SP`,
	/// job notices.
	fn preprompt(&mut self, k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc) -> Option<WaitKey> {
		// A background job just started prints `[n] pid` first (zsh prints
		// it right after the fork).
		if let Some(job) = jobctl::announce_wait(k) {
			return Some(WaitKey::Proc(job));
		}
		adjust_winsize(k, cx, vp, std::mem::take(&mut self.winch) || !Self::size_known(vp));
		// Job lines first: zsh prints `[n] pid` at the fork, before the
		// next prompt's `PROMPT_SP`.
		jobctl::notices_before_prompt(k, cx, vp);
		if let Some(fd) = crate::bash::vm::exec::flush_out(k, vp) {
			return Some(WaitKey::Write { fd });
		}
		let zsh = vp.mode.dialect() == Dialect::Zsh;
		if zsh
			&& isset(k, cx, vp, ZshOpt::Promptsp)
			&& isset(k, cx, vp, ZshOpt::Promptcr)
			&& !self.use_exit_printed
		{
			self.prompt_sp(k, cx, vp);
		}
		None
	}

	/// Whether the terminal size was read once.
	fn size_known(vp: &Vproc) -> bool {
		vp.zle
			.as_ref()
			.and_then(|z| z.tty.as_ref())
			.is_some_and(|t| t.caps.is_some())
	}

	/// zsh's `PROMPT_SP` heuristic: `PROMPT_EOL_MARK` (default
	/// `%B%S%#%s%b`), padding to the last column, then back to column 0.
	fn prompt_sp(&self, k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc) {
		let mark =
			scalar(k, cx, vp, b"PROMPT_EOL_MARK").unwrap_or_else(|| BString::from("%B%S%#%s%b"));
		let mut log = Vec::new();
		let mut ex = Expander::new(k, cx, vp, &mut log, false, 0);
		let Ok(columns) =
			params::getsparam(&mut ex, b"COLUMNS").map(|c| c.map_or(80, |c| params::parse_int(&c)))
		else {
			return;
		};
		let site = ex.k.zsh_site(ex.cx, ex.vp, 0);
		let Ok(mut env) =
			crate::bash::vm::builtins::zsh_print::prompt_env_ex(&mut ex, site, true, false)
		else {
			return;
		};
		env.lastval = self.status;
		let e = crate::bash::vm::builtins::zsh_prompt::promptexpand_ns(&mark, &env);
		let (w, _) = crate::bash::vm::builtins::zsh_prompt::countprompt(&e.text, 0, -1);
		let hasxn = env.term.hasxn;
		let mut out = crate::bash::vm::builtins::zsh_prompt::strip_markers(&e.text);
		let w = i64::try_from(w).unwrap_or(0);
		let pad = (columns - w - i64::from(!hasxn)).max(0);
		out.extend(std::iter::repeat_n(b' ', usize::try_from(pad).unwrap_or(0)));
		out.push(b'\r');
		out.extend(std::iter::repeat_n(b' ', usize::try_from(w).unwrap_or(0)));
		out.push(b'\r');
		put_tty(k, vp, &out);
	}

	/// bash `PROMPT_COMMAND`: each element (or the scalar) run as a
	/// command before the prompt.
	fn prompt_command(&mut self, k: &Kernel, cx: &mut Cx<'_>, vp: &mut Vproc) {
		let cmds: Vec<BString> = state::lookup(&k.root, cx.store, vp, b"PROMPT_COMMAND")
			.ok()
			.flatten()
			.map_or_default(state::Var::values);
		let mut src = Vec::new();
		for c in cmds.into_iter().filter(|c| !c.is_empty()) {
			src.extend_from_slice(&c);
			src.push(b'\n');
		}
		if !src.is_empty() {
			let depth = vp.frames.len();
			crate::bash::vm::exec::push_script(vp, &src, 1, ScriptKind::Hook);
			// Its status is kept: bash's `$?` after PROMPT_COMMAND is the
			// last command's, before it ran.
			self.running = Some((depth, vp.status));
		}
	}

	/// zsh's mail check (`preprompt`): every `MAILCHECK` seconds, each
	/// `MAILPATH` entry (`file?message`), else `MAIL`, that grew since it
	/// was last read and since the last check reports new mail. `Some`
	/// while a file's status is being read.
	fn mailcheck(&mut self, k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc) -> Option<WaitKey> {
		if vp.mode.dialect() != Dialect::Zsh {
			return None;
		}
		let mailcheck = scalar(k, cx, vp, b"MAILCHECK").map_or(0, |v| params::parse_int(&v));
		let now = now_secs(cx);
		if mailcheck == 0 || now - self.lastmailcheck <= mailcheck {
			return None;
		}
		let mut log = Vec::new();
		let paths = {
			let mut ex = Expander::new(k, cx, vp, &mut log, false, 0);
			match params::getaparam(&mut ex, b"mailpath").ok().flatten() {
				Some(p) if p.first().is_some_and(|f| !f.is_empty()) => p,
				_ => params::getsparam(&mut ex, b"MAIL")
					.ok()
					.flatten()
					.filter(|m| !m.is_empty())
					.map_or_default(|m| vec![m]),
			}
		};
		let mut out = Vec::new();
		for entry in &paths {
			let (file, msg) = match entry.find_byte(b'?') {
				Some(i) => (&entry[..i], Some(&entry[i + 1..])),
				None => (&entry[..], None),
			};
			if file.is_empty() {
				let mut m = BString::from("empty MAILPATH component: ");
				m.extend_from_slice(entry);
				k.diag(cx, vp, 0, crate::bash::diag::Diag::Usage { msg: m.to_string().into() });
				continue;
			}
			let probe = Probe::Stat { path: BString::from(file), follow: true };
			let st = match probe::perform(k, cx, vp, &mut self.sc, &probe) {
				Ok(ProbeResult::Stat(st)) => st,
				Ok(_) => None,
				Err(key) => return Some(key),
			};
			self.sc.recycle();
			let Some(st) = st else {
				continue;
			};
			let mtime = st.mtime_ns.div_euclid(1_000_000_000);
			let atime = st.atime_ns.div_euclid(1_000_000_000);
			if st.size > 0 && atime <= mtime && mtime >= self.lastmailcheck {
				match msg {
					None => out.extend_from_slice(b"You have new mail.\n"),
					Some(m) => {
						let mut ex = Expander::new(k, cx, vp, &mut log, false, 0);
						let text = crate::bash::vm::builtins::zsh_print::prompt_subst(&mut ex, m)
							.unwrap_or_else(|_| m.to_vec());
						out.extend_from_slice(&text);
						out.push(b'\n');
					},
				}
			}
			if isset(k, cx, vp, ZshOpt::Mailwarning)
				&& atime > mtime
				&& atime > self.lastmailcheck
				&& st.size > 0
			{
				out.extend_from_slice(b"The mail in ");
				out.extend_from_slice(file);
				out.extend_from_slice(b" has been read.\n");
			}
		}
		self.lastmailcheck = now;
		put_tty(k, vp, &out);
		None
	}

	/// Expand the prompts of this line.
	fn prompts(&mut self, k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc) -> Result<(), Pause> {
		let zsh = vp.mode.dialect() == Dialect::Zsh;
		let (lname, rname): (&[u8], &[u8]) = if self.cont {
			(b"PS2", b"RPS2")
		} else {
			(b"PS1", b"RPS1")
		};
		let raw_lp = scalar(k, cx, vp, lname).unwrap_or_default();
		let raw_rp = if zsh {
			scalar(k, cx, vp, rname).unwrap_or_default()
		} else {
			BString::default()
		};
		let status = self.status;
		let stack = self.cmdstack.clone();
		let (lp, rp) = if zsh {
			// Both prompts share one replay transaction. If the right
			// prompt parks, the left prompt must replay its own atoms too,
			// rather than consuming the right prompt's substitution result.
			self
				.expand(k, cx, vp, |ex| {
					let mut prompt =
						|raw: &[u8]| match super::display::expand_prompt(ex, raw, status, &stack) {
							Ok(p) => Ok(p),
							Err(
								e @ (Stop::ZshSub { .. }
								| Stop::MathCall(_)
								| Stop::Sub { .. }
								| Stop::Wait(_)),
							) => Err(e),
							Err(Stop::Fail(d) | Stop::Fatal(d)) => {
								ex.k.diag(ex.cx, ex.vp, 0, d);
								Ok(Default::default())
							},
							Err(Stop::Store(e)) => {
								ex.k.fail(e);
								Ok(Default::default())
							},
							Err(_) => Ok(Default::default()),
						};
					Ok((prompt(&raw_lp)?, prompt(&raw_rp)?))
				})?
				.unwrap_or_default()
		} else {
			let lp = self
				.expand(k, cx, vp, |ex| ex.prompt(&raw_lp))?
				.unwrap_or_default();
			(bash_marked(&lp), zsh_prompt_expansion::Expansion::default())
		};
		self.prompts = Some(Prompts { raw_lp, raw_rp, lp, rp });
		Ok(())
	}

	/// The prompt for a line read without ZLE, on standard error (zsh
	/// `inputline`'s `promptexpand(…, 0)`).
	fn print_plain_prompt(&self, vp: &mut Vproc) {
		let Some(p) = self.prompts.as_ref() else {
			return;
		};
		let text = crate::bash::vm::builtins::zsh_prompt::strip_markers(&p.lp.text);
		if !text.is_empty() {
			vp.out
				.push_back(PendingWrite { fd: 2, bytes: BString::from(text), off: 0 });
		}
	}

	/// Start ZLE on this line (zsh `zleread`'s set-up), if it can run:
	/// the `zle` option is on and the shell has its terminal.
	fn start_zle(&mut self, k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc) -> bool {
		// A program's shell has no line editor ([`crate::bash::Profile::Tool`]).
		let usable = (isset(k, cx, vp, ZshOpt::Zle) || vp.mode.dialect() != Dialect::Zsh)
			&& !crate::bash::vm::is_tool(cx.store, vp).unwrap_or(true);
		let term = scalar(k, cx, vp, b"TERM").unwrap_or_default();
		if !usable || term.as_slice() == b"emacs" || vp.zle.as_ref().is_none_or(|z| z.tty.is_none()) {
			return false;
		}
		// zsh `KEYTIMEOUT` is 40 unless set.
		let keytimeout = scalar(k, cx, vp, b"KEYTIMEOUT").map_or(40, |v| params::parse_int(&v));
		let overstrike = isset(k, cx, vp, ZshOpt::Overstrike);
		let ignoreeof = isset(k, cx, vp, ZshOpt::Ignoreeof);
		let promptcr = isset(k, cx, vp, ZshOpt::Promptcr);
		let curhist = super::hist::curhist(cx.store, vp);
		let hline = self.hline(vp);
		// zsh `inputline`: the editor gets the prompt parameters (`raw_lp`,
		// `raw_rp`); the right one only when it is set now.
		let (lname, rname): (&'static [u8], &'static [u8]) = if self.cont {
			(b"PS2", b"RPS2")
		} else {
			(b"PS1", b"RPS1")
		};
		let rp_set = scalar(k, cx, vp, rname).is_some();
		let Some(p) = self.prompts.take() else {
			return false;
		};
		let owner = vp.frames.len();
		let localhistory = self.localhistory;
		let status = self.status;
		let ctx = if self.cont {
			Context::LineCont
		} else {
			Context::LineStart
		};
		let Some(z) = vp.zle.as_deref_mut() else {
			return false;
		};
		let mut ed =
			Editor::new(ctx, readflags::HISTORY | if ignoreeof { readflags::IGNOREEOF } else { 0 });
		ed.unget = std::mem::take(&mut z.kunget);
		// zsh `zleread`: `fetchttyinfo = 0`.
		if let Some(t) = z.tty.as_mut() {
			t.fetch = false;
		}
		ed.pre_zle_status = status;
		ed.keytimeout = keytimeout;
		ed.insmode = !overstrike;
		ed.raw_lp = p.raw_lp;
		ed.raw_rp = p.raw_rp;
		if vp.mode.dialect() == Dialect::Zsh {
			ed.prompt_params = Some((lname, rp_set.then_some(rname)));
		}
		ed.lprompt = p.lp.text;
		ed.lprompt_attr = p.lp.txtattr;
		ed.rprompt = p.rp.text;
		ed.rprompt_attr = p.rp.txtattr;
		ed.histline = curhist;
		ed.hline = hline;
		ed.ls.localhistory = localhistory;
		let _ = exec::selectkeymap(&z.keymaps, &mut ed, b"main", true);
		ed.hooks.clear();
		ed.undo = super::undo::Undo::new(&ed.line, ed.cs);
		// zsh: a line stacked by `push-line`, `print -z`, … is the start.
		if let Some(s) = z.bufstack.pop() {
			utils::setline(&mut ed, &s, utils::ZSL_TOEND);
			if let Some(cs) = z.stack_cs.take() {
				ed.cs = cs.min(ed.line.len());
				utils::ccleft(&mut ed);
			}
			if let Some(h) = z.stack_hist.take() {
				ed.histline = h;
			}
			super::undo::handleundo(&mut ed);
		}
		// WidgetsVi: zsh `zleread`'s vi set-up (`viinsert_init`).
		super::widgets::vi::line_init(z, &mut ed);
		z.display.resetneeded = true;
		z.display.trashedzle = false;
		if promptcr && let Some(t) = z.tty.as_mut() {
			t.put(b"\r");
		}
		let read = Task::Read(ReadTask::new(b"zle-line-init", b"zle-line-finish"));
		exec::push_root(&mut ed, read, owner);
		z.ed = Some(Box::new(ed));
		if let Ok(tmout) =
			u64::try_from(scalar(k, cx, vp, b"TMOUT").map_or(0, |v| params::parse_int(&v)))
			&& tmout > 0
		{
			let at = Deadline(
				cx.host
					.now_ns()
					.saturating_add(tmout.saturating_mul(1_000_000_000)),
			);
			self.tmout = Some(cx.host.timer(at));
		}
		true
	}

	/// zsh `hgetline()`: the earlier lines of the command being continued.
	fn hline(&self, vp: &Vproc) -> Option<BString> {
		if !self.cont {
			return None;
		}
		let Some(FrameKind::Script { src, pos, .. }) = vp.frames.last().map(|f| &f.kind) else {
			return None;
		};
		let from = (pos.0 as usize).min(src.len());
		Some(BString::from(&src[from..])).filter(|s| !s.is_empty())
	}

	/// Drive ZLE until the line is read.
	fn drive_zle(&mut self, k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc) -> Result<Line, Pause> {
		if std::mem::take(&mut self.winch) {
			adjust_winsize(k, cx, vp, true);
			if let Some(z) = vp.zle.as_deref_mut()
				&& let Some(ed) = z.ed.as_deref_mut()
			{
				ed.winch = false;
				z.display.winchanged = true;
				z.display.resetneeded = true;
			}
			// zsh `adjustwinsize`: a line being edited is drawn again at once.
			super::display::zle_refresh(k, cx, vp, None, false);
		}
		let owner = vp.frames.len();
		let Some(base) = super::editor(vp).and_then(|ed| exec::resume_base(ed, owner)) else {
			return Ok(Line::Abort);
		};
		let got = match exec::drive(k, cx, vp, base) {
			Drive::Done(got) => got,
			Drive::Park(key) => return Err(Pause::Park(key)),
			Drive::Frame => return Err(Pause::Frame),
		};
		self.tmout = None;
		let Some(z) = vp.zle.as_deref_mut() else {
			return Ok(Line::Abort);
		};
		let Some(mut ed) = z.ed.take() else {
			return Ok(Line::Abort);
		};
		// zsh's `kungetbuf` outlives the line: bytes read past its end
		// (a key sequence cut short by `KEYTIMEOUT`) start the next one,
		// unless the line was interrupted (`trashzle`: `errflag` → `kungetct =
		// 0`).
		if !ed.interrupted {
			z.kunget = std::mem::take(&mut ed.unget);
		}
		self.localhistory = ed.ls.localhistory;
		self.use_exit_printed = ed.use_exit_printed;
		if ed.interrupted {
			vp.status = 130;
		} else if ed.aborted && !ed.eofsent && vp.status == 0 {
			// zsh `loop()`: an abandoned line (`send-break`) is a parse
			// error: `$?` becomes 1 unless it was already non-zero.
			vp.status = 1;
		}
		if let Some(kind) = ed.tty_error {
			if let Some(t) = z.tty.as_mut() {
				let _ = t.flush(k);
			}
			if kind != std::io::ErrorKind::UnexpectedEof {
				let e = std::io::Error::from(kind);
				let msg = format!("error on TTY read: {}", crate::bash::diag::strerror(&e));
				k.diag(cx, vp, 0, crate::bash::diag::Diag::Usage { msg: msg.into() });
			}
			return Ok(Line::Lost);
		}
		if let Some(t) = z.tty.as_mut() {
			let _ = t.flush(k);
		}
		Ok(match got {
			Got::Status(0) if !ed.eofsent && !ed.aborted => {
				let mut line = from_line(&ed.line);
				line.push(b'\n');
				Line::Text(line)
			},
			_ if ed.eofsent => Line::Eof,
			_ => Line::Abort,
		})
	}

	/// Read a line without ZLE.
	fn read_plain(&mut self, k: &Kernel, cx: &mut Cx<'_>, vp: &mut Vproc) -> Result<Line, WaitKey> {
		if std::mem::take(&mut self.interrupted) {
			self.sc.recycle();
			vp.status = 130;
			put_tty(k, vp, b"\n");
			return Ok(Line::Abort);
		}
		let input = Probe::Input {
			fd:         0,
			delim:      Some(b'\n'),
			lines:      1,
			nchars:     None,
			part:       0,
			timeout_ns: None,
		};
		let answer = probe::perform(k, cx, vp, &mut self.sc, &input)?;
		self.sc.recycle();
		self.tmout = None;
		Ok(match answer {
			ProbeResult::Input { data, .. } if !data.is_empty() => Line::Text(data),
			_ => Line::Eof,
		})
	}

	/// Park on `key`, unless `TMOUT` ran out (zsh's `SIGALRM` handler:
	/// `TRAPALRM`, else `zsh: timeout` and exit).
	fn park_tmout(
		&mut self,
		k: &mut Kernel,
		cx: &mut Cx<'_>,
		vp: &mut Vproc,
		key: WaitKey,
	) -> Option<WaitKey> {
		let fired = self.tmout.as_mut().is_some_and(|t| {
			let mut tcx = std::task::Context::from_waker(&k.waker);
			t.poll(&mut tcx).is_ready()
		});
		if !fired {
			return Some(key);
		}
		self.tmout = None;
		let trapped = matches!(
			state::record(
				cx.store,
				vp,
				Key::Trap(crate::bash::store::TrapKey::Signal(crate::bash::signal::Signal::Alrm))
			),
			Ok(Some(Record::Trap { .. }))
		) || exec::function_exists(cx, vp, b"TRAPALRM");
		if trapped {
			vp.pending_traps = vp.pending_traps.with(crate::bash::signal::Signal::Alrm);
			let tmout = scalar(k, cx, vp, b"TMOUT").map_or(0, |v| params::parse_int(&v));
			if let Ok(t) = u64::try_from(tmout)
				&& t > 0
			{
				let at = Deadline(
					cx.host
						.now_ns()
						.saturating_add(t.saturating_mul(1_000_000_000)),
				);
				self.tmout = Some(cx.host.timer(at));
			}
			return None;
		}
		Self::abandon_editor(k, cx, vp);
		k.diag(cx, vp, 0, crate::bash::diag::Diag::Usage { msg: "timeout".into() });
		vp.status = 128 + 14;
		end_input(vp);
		None
	}

	/// Drop the line being edited (the display given up first).
	fn abandon_editor(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc) {
		let Some(mut z) = vp.zle.take() else {
			return;
		};
		if let Some(mut ed) = z.ed.take() {
			{
				let mut zw = exec::Zw {
					k:    &mut *k,
					cx:   &mut *cx,
					vp:   &mut *vp,
					zle:  &mut z,
					ed:   &mut ed,
					args: &[],
				};
				exec::trashzle(&mut zw);
			}
			if let Some(t) = z.tty.as_mut() {
				let _ = t.flush(k);
			}
		}
		vp.zle = Some(z);
	}

	/// What to do with the line read.
	fn got_line(
		&mut self,
		k: &mut Kernel,
		cx: &mut Cx<'_>,
		vp: &mut Vproc,
		line: Line,
	) -> Option<WaitKey> {
		self.phase = Phase::Idle;
		self.began = false;
		match line {
			Line::Text(text) => {
				self.noexitct = 0;
				self.expand_line(k, cx, vp, text, false)
			},
			Line::Abort => {
				// The command being continued goes with the line (zsh's
				// `errflag` ends the event).
				if let Some(FrameKind::Script { src, pos, aux, .. }) =
					vp.frames.last_mut().map(|f| &mut f.kind)
				{
					src.truncate(pos.0 as usize);
					if let Some(a) = aux {
						a.pending = None;
					}
				}
				None
			},
			Line::Eof => self.eof(k, cx, vp),
			Line::Lost => {
				vp.status = 1;
				if vp.mode.dialect() == Dialect::Zsh {
					self.phase = Phase::Logout(0);
					return self.step(k, cx, vp, false, Vec::new());
				}
				end_input(vp);
				None
			},
		}
	}

	/// The line read, through zsh's history expansion, joins the input.
	fn expand_line(
		&mut self,
		k: &mut Kernel,
		cx: &mut Cx<'_>,
		vp: &mut Vproc,
		text: BString,
		eof: bool,
	) -> Option<WaitKey> {
		use crate::bash::vm::builtins::history::zsh as hz;
		let mut text = text;
		if zhist(k, cx, vp) {
			match hz::expand(k, cx, vp, &mut self.hsc, &text) {
				Err(key) => {
					self.pending = Some((text, eof));
					self.phase = Phase::Expand;
					return Some(key);
				},
				Ok(hz::Expanded::Line(t)) => text = t,
				Ok(hz::Expanded::Failed(d)) => {
					if let Some(d) = d {
						k.diag(cx, vp, 0, d);
					}
					text = BString::default();
					// The event's earlier lines go with it.
					if let Some(FrameKind::Script { src, pos, aux, .. }) =
						vp.frames.last_mut().map(|f| &mut f.kind)
					{
						let lines = src[(pos.0 as usize).min(src.len())..]
							.split(|&c| c == b'\n')
							.count();
						*pos = (src.len() as u32, pos.1 + lines as u32);
						if let Some(a) = aux {
							a.pending = None;
						}
					}
				},
			}
			self.hsc.recycle();
		} else if vp.mode.dialect() != Dialect::Zsh
			&& crate::bash::vm::builtins::history::bash::histexpand_active(k, cx.store, vp)
		{
			// bash `pre_process_line`: the line as history expansion leaves it
			// (printed when it changed; empty: dropped after an error).
			text = crate::bash::vm::builtins::history::bash::reader_line(k, cx, vp, text);
		}
		self.phase = Phase::Idle;
		if let Some(FrameKind::Script { src, stdin, .. }) = vp.frames.last_mut().map(|f| &mut f.kind)
		{
			src.extend_from_slice(&text);
			if eof {
				*stdin = false;
			}
		}
		None
	}

	/// End of input at the prompt (zsh's top level after `loop()`).
	fn eof(&mut self, k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc) -> Option<WaitKey> {
		let zsh = vp.mode.dialect() == Dialect::Zsh;
		let ignoreeof = if zsh {
			isset(k, cx, vp, ZshOpt::Ignoreeof)
		} else {
			state::option(&mut k.root, cx.store, vp, crate::bash::store::OptId::Ignoreeof)
				.unwrap_or(false)
		};
		if ignoreeof {
			let limit = if zsh {
				10
			} else {
				// bash `IGNOREEOF`: that many EOFs (10 when not a number).
				scalar(k, cx, vp, b"IGNOREEOF")
					.and_then(|v| v.to_str().ok().and_then(|s| s.trim().parse::<u32>().ok()))
					.unwrap_or(10)
			};
			self.noexitct += 1;
			if self.noexitct < limit {
				if !self.use_exit_printed {
					let login = isset(k, cx, vp, ZshOpt::Login);
					let msg = if zsh {
						if login {
							"use 'logout' to logout."
						} else {
							"use 'exit' to exit."
						}
					} else if login {
						"Use \"logout\" to leave the shell."
					} else {
						"Use \"exit\" to leave the shell."
					};
					if zsh {
						k.diag(cx, vp, 0, crate::bash::diag::Diag::Usage { msg: msg.into() });
					} else {
						let mut m = BString::from(msg);
						m.push(b'\n');
						vp.out.push_back(PendingWrite { fd: 2, bytes: m, off: 0 });
					}
				}
				return None;
			}
		}
		if jobctl::check_before_exit(k, cx, vp) {
			return None;
		}
		// zsh `zexit`: `.zlogout` here; `zshexit` runs where the shell's
		// input ends, after the `EXIT` trap (`vm/zsh/zexit.rs`).
		if zsh {
			self.phase = Phase::Logout(0);
			return self.step(k, cx, vp, false, Vec::new());
		}
		end_input(vp);
		None
	}

	/// zsh `zexit`'s logout files for a login shell with `RCS`:
	/// `$ZDOTDIR/.zlogout` (else `~/.zlogout`), then `/etc/zlogout` with
	/// `GLOBAL_RCS`; then input ends.
	fn logout(&mut self, k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc, i: u8) -> Option<WaitKey> {
		if let Some((_, status)) = self.running.take() {
			vp.status = status;
		}
		self.logged_out = true;
		let login = isset(k, cx, vp, ZshOpt::Login) && isset(k, cx, vp, ZshOpt::Rcs);
		let file: Option<BString> = match i {
			0 if login => {
				let base = scalar(k, cx, vp, b"ZDOTDIR").or_else(|| scalar(k, cx, vp, b"HOME"));
				base.map(|mut b| {
					b.extend_from_slice(b"/.zlogout");
					b
				})
			},
			1 if login && isset(k, cx, vp, ZshOpt::Globalrcs) => Some(BString::from("/etc/zlogout")),
			0 | 1 => None,
			_ => {
				end_input(vp);
				return None;
			},
		};
		if let Some(path) = file {
			let probe = Probe::Read { path };
			match probe::perform(k, cx, vp, &mut self.sc, &probe) {
				Err(key) => return Some(key),
				Ok(ProbeResult::Bytes(Ok(text))) => {
					self.sc.recycle();
					self.phase = Phase::Logout(i + 1);
					let depth = vp.frames.len();
					crate::bash::vm::exec::push_script(vp, &text, 1, ScriptKind::Source);
					self.running = Some((depth, vp.status));
					return None;
				},
				Ok(_) => self.sc.recycle(),
			}
		}
		self.phase = Phase::Logout(i + 1);
		self.logout(k, cx, vp, i + 1)
	}
}

/// zsh `zexit`'s logout files for `exit` in an interactive login shell
/// with `RCS`: `$ZDOTDIR/.zlogout` (else `~/.zlogout`) and, with
/// `GLOBAL_RCS`, `/etc/zlogout`, sourced once before the shell exits with
/// `status` (`builtin exit` runs after them). `None` when there are none to
/// source (the caller exits as usual).
///
/// # Errors
/// A [`Need`] while a file is read.
pub fn logout_on_exit(
	ctx: &mut crate::bash::vm::builtins::Ctx<'_, '_>,
	status: i32,
) -> Result<Option<crate::bash::vm::builtins::Outcome>, crate::bash::vm::builtins::Need> {
	use crate::bash::vm::builtins::{Control, Outcome};
	let done = ctx
		.vp
		.zle
		.as_ref()
		.and_then(|z| z.reader.as_ref())
		.is_none_or(|r| r.logged_out);
	let in_function = ctx
		.vp
		.frames
		.iter()
		.any(|f| matches!(f.kind, FrameKind::Function { .. }));
	if done
		|| in_function
		|| ctx.vp.parent.is_some()
		|| !ctx.zsh_option(ZshOpt::Interactive)?
		|| !ctx.zsh_option(ZshOpt::Login)?
		|| !ctx.zsh_option(ZshOpt::Rcs)?
	{
		return Ok(None);
	}
	let mut files = Vec::new();
	if let Some(mut base) = match ctx.scalar(b"ZDOTDIR")? {
		Some(d) => Some(d),
		None => ctx.scalar(b"HOME")?,
	} {
		base.extend_from_slice(b"/.zlogout");
		files.push(base);
	}
	if ctx.zsh_option(ZshOpt::Globalrcs)? {
		files.push(BString::from("/etc/zlogout"));
	}
	let mut texts = Vec::new();
	for path in files {
		if let ProbeResult::Bytes(Ok(text)) = ctx.probe(Probe::Read { path })? {
			texts.push(text);
		}
	}
	if let Some(r) = ctx
		.vp
		.zle
		.as_deref_mut()
		.and_then(|z| z.reader.as_deref_mut())
	{
		r.logged_out = true;
	}
	if texts.is_empty() {
		return Ok(None);
	}
	ctx.vp.status = status;
	let line = ctx.line;
	crate::bash::vm::exec::push_script(
		ctx.vp,
		format!("builtin exit {status}\n").as_bytes(),
		line,
		ScriptKind::Eval,
	);
	for text in texts.iter().rev() {
		crate::bash::vm::exec::push_script(ctx.vp, text, 1, ScriptKind::Source);
	}
	Ok(Some(Outcome { status, control: Control::Frame }))
}

/// The stdin frame reads no more: the shell's script ends.
fn end_input(vp: &mut Vproc) {
	if let Some(FrameKind::Script { stdin, src, pos, .. }) =
		vp.frames.last_mut().map(|f| &mut f.kind)
	{
		*stdin = false;
		src.truncate(pos.0 as usize);
	}
}

/// Write display bytes to the editing terminal (zsh `shout`), standard
/// error without one. Behind output the shell still has queued, they wait
/// their turn there (`exec::flush_out`): zsh's writes block, so nothing
/// reaches the terminal out of order.
fn put_tty(k: &Kernel, vp: &mut Vproc, bytes: &[u8]) {
	if bytes.is_empty() {
		return;
	}
	if !vp.out.is_empty() {
		vp.out.push_back(PendingWrite {
			fd:    super::tty::FD,
			bytes: BString::from(bytes),
			off:   0,
		});
		return;
	}
	if let Some(t) = vp.zle.as_deref_mut().and_then(|z| z.tty.as_mut()) {
		t.put(bytes);
		let _ = t.flush(k);
		return;
	}
	vp.out
		.push_back(PendingWrite { fd: 2, bytes: BString::from(bytes), off: 0 });
}

/// A bash prompt (readline's `\x01`…`\x02` invisible regions) as zsh's
/// marked prompt buffer for the display.
fn bash_marked(p: &[u8]) -> zsh_prompt_expansion::Expansion {
	let mut text = Vec::with_capacity(p.len() + 4);
	for &c in p {
		match c {
			1 => text.push(tok::INPAR),
			2 => text.push(tok::OUTPAR),
			c => text.extend_from_slice(&tok::metafy(&[c])),
		}
	}
	zsh_prompt_expansion::Expansion { text, txtattr: 0 }
}

/// zsh `adjustwinsize`: read the terminal's size; when it changed (or
/// `force`), `COLUMNS` and `LINES` follow it.
pub fn adjust_winsize(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc, force: bool) {
	// zsh keeps the terminal's numbers when the kernel reports no size.
	let Some(size) = vp
		.zle
		.as_ref()
		.and_then(|z| z.tty.as_ref())
		.and_then(|t| t.read_size(cx))
		.filter(|s| s.0 > 0 && s.1 > 0)
	else {
		return;
	};
	let changed = vp
		.zle
		.as_deref_mut()
		.and_then(|z| z.tty.as_mut())
		.is_some_and(|t| {
			let changed = t.size != size;
			t.size = size;
			changed
		});
	if !(changed || force) || size.0 == 0 {
		return;
	}
	let mut log = Vec::new();
	let mut ex = Expander::new(k, cx, vp, &mut log, false, 0);
	let _ = params::assignsparam(&mut ex, b"COLUMNS", size.0.to_string().as_bytes(), 0);
	if size.1 > 0 {
		let _ = params::assignsparam(&mut ex, b"LINES", size.1.to_string().as_bytes(), 0);
	}
}
