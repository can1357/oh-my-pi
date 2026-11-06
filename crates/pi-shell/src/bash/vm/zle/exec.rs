//! Widget execution (zsh `zlecore`, `execzlefunc`, `getkeycmd`): the
//! calling convention of native widgets and the task stack that lets them
//! wait for keys and for shell code without re-entering the VM.
//!
//! A native widget is a [`WidgetFn`]: it runs with the editor borrowed
//! ([`Zw`]) and either finishes ([`WResult::Done`]) or asks for something
//! ([`WResult::Await`]) together with a continuation ([`Cont`]) that gets
//! the answer ([`Got`]) once it is there: the next key command or
//! character the user types, or the status of another widget or a shell
//! function (run as a frame of the editing vproc). The task stack runs
//! nested widgets as zsh's C recursion would, one step at a time.

use std::task::Context as TaskContext;

use bstr::{BStr, BString};

use super::{Editor, Zle, keymap::Bind, thingy::Kind, wflags, widgets};
use crate::bash::{
	event::WaitKey,
	host::Deadline,
	store::{Key, Record, StoreError},
	vm::{
		Cx, Kernel,
		exec::push_script,
		expand::Expander,
		proc::{Saved, ScriptKind, Vproc},
		state,
	},
	zshopt::ZshOpt,
};

/// The editor as a native widget sees it: the VM (for parameters,
/// options, history), the vproc's editor state and the line, and the
/// widget's arguments (`zle name args…`).
pub struct Zw<'a, 'c> {
	/// The kernel.
	pub k:    &'a mut Kernel,
	/// Host and store.
	pub cx:   &'a mut Cx<'c>,
	/// The editing vproc ([`Vproc::zle`] is taken out while native code
	/// runs: use [`Self::zle`] and [`Self::ed`]).
	pub vp:   &'a mut Vproc,
	/// The editor state that outlives lines.
	pub zle:  &'a mut Zle,
	/// The line being edited.
	pub ed:   &'a mut Editor,
	/// The widget's arguments (`zle name args…`; empty from a key).
	pub args: &'a [BString],
}

/// A native widget (zsh `ZleIntFunc`): 0 is success; non-zero makes the
/// editor beep (zsh `handlefeep`) when the widget was run from a key.
pub type WidgetFn = fn(&mut Zw<'_, '_>) -> WResult;

/// What a native widget step returns.
pub enum WResult {
	/// Finished with this status.
	Done(i32),
	/// Waiting: `Await` says for what, the continuation gets it.
	Await(Await, Box<dyn Cont>),
}

/// What a native widget waits for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Await {
	/// The next key command through the current keymaps (zsh
	/// `getkeycmd`): [`Got::Key`] with the widget name bound, `None` at
	/// end of input or for an unbound sequence (zsh returns
	/// `undefined-key`'s thingy then; this is that name).
	Key,
	/// The next character, read raw (zsh `getfullchar`): [`Got::Char`],
	/// `None` at end of input.
	Char,
	/// Run widget `name` with `args` (zsh `execzlefunc`, as from `zle
	/// name args…`): [`Got::Status`].
	Widget {
		/// Widget name.
		name: BString,
		/// Its arguments.
		args: Vec<BString>,
	},
	/// Call shell function `name` with `args` in the editing vproc, its
	/// `$?` kept (zsh `callhookfunc`/`doshfunc(…, noreturnval)`):
	/// [`Got::Status`] (1 when no such function exists).
	Function {
		/// Function name.
		name: BString,
		/// Its arguments (`$1`…).
		args: Vec<BString>,
	},
	/// Run command `name args…` (a builtin, function or external, looked
	/// up as any command) in the editing vproc with standard input from
	/// `/dev/null`, `$?` kept, the call itself untraced: [`Got::Status`].
	Command {
		/// Command name.
		name: BString,
		/// Its arguments.
		args: Vec<BString>,
	},
	/// Redisplay now (zsh `zrefresh()` inside a widget) and go on.
	Refresh,
	/// Run a nested core loop until a widget ends it (zsh
	/// `recursiveedit`'s `zlecore()`): [`Got::Status`] 0.
	Recursive,
	/// Run hook widget `name` now, if it is a widget (zsh `zlecallhook`
	/// inside a widget): [`Got::Status`] (0 when there is no such widget).
	Hook {
		/// Hook widget name.
		name: BString,
		/// Its one argument, if any.
		arg:  Option<BString>,
	},
	/// Run `zle-line-pre-redraw` now, if it is a widget (zsh `redrawhook`
	/// inside a widget): [`Got::Status`] (0 when there is none).
	RedrawHook,
	/// Park until `WaitKey` is ready (a host probe the widget started),
	/// then go on: [`Got::Refreshed`].
	Wait(WaitKey),
	/// The native code pushed a frame itself (an expansion's hook call,
	/// [`crate::bash::vm::exec::start_zsh_sub`] with `here`): go on once
	/// it has returned (the vproc is back to `depth` frames), `$?` left as
	/// the frame set it: [`Got::Status`] with it.
	Frame {
		/// The frame count before the push.
		depth: usize,
	},
}

/// The answer to an [`Await`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Got {
	/// [`Await::Key`].
	Key(Option<BString>),
	/// [`Await::Char`].
	Char(Option<char>),
	/// [`Await::Widget`], [`Await::Function`].
	Status(i32),
	/// A [`KeyMode::Byte`] read: `None` at end of input or timeout.
	Byte(Option<u8>),
	/// [`Await::Refresh`].
	Refreshed,
}

/// The rest of a native widget after an [`Await`].
pub trait Cont: Send {
	/// Go on with the answer.
	fn resume(self: Box<Self>, zw: &mut Zw<'_, '_>, got: Got) -> WResult;
}

/// A closure as a [`Cont`].
impl<F> Cont for F
where
	F: FnOnce(&mut Zw<'_, '_>, Got) -> WResult + Send,
{
	fn resume(self: Box<Self>, zw: &mut Zw<'_, '_>, got: Got) -> WResult {
		(*self)(zw, got)
	}
}

/// Wait for `what`, then run `then` with the answer.
pub fn then<F>(what: Await, then: F) -> WResult
where
	F: FnOnce(&mut Zw<'_, '_>, Got) -> WResult + Send + 'static,
{
	WResult::Await(what, Box::new(then))
}

impl Zw<'_, '_> {
	/// zsh `zmult`: the numeric argument (1 without one).
	pub const fn mult(&self) -> i64 {
		self.ed.zmod.mult
	}

	/// A zsh option of the editing vproc (`false` when the store fails).
	pub fn isset(&mut self, opt: ZshOpt) -> bool {
		state::zsh_option(&mut self.k.root, self.cx.store, self.vp, opt).unwrap_or(false)
	}

	/// Run `f` over the zsh parameter code of the editing vproc (an
	/// [`Expander`] that cannot run command substitutions).
	///
	/// # Errors
	/// What `f` returns.
	pub fn params<T>(
		&mut self,
		f: impl FnOnce(&mut Expander<'_, '_>) -> crate::bash::vm::expand::X<T>,
	) -> crate::bash::vm::expand::X<T> {
		let mut log = Vec::new();
		let mut ex = Expander::new(self.k, self.cx, self.vp, &mut log, false, 0);
		f(&mut ex)
	}

	/// zsh `getsparam`: a parameter as a string (`None`: unset, or the
	/// store failed).
	pub fn getsparam(&mut self, name: &[u8]) -> Option<BString> {
		self
			.params(|ex| crate::bash::vm::zsh::params::getsparam(ex, name))
			.ok()
			.flatten()
	}

	/// zsh `getiparam`: a parameter as an integer (0 when unset).
	pub fn getiparam(&mut self, name: &[u8]) -> i64 {
		self
			.getsparam(name)
			.map_or(0, |s| crate::bash::vm::zsh::params::parse_int(&s))
	}

	/// zsh `getaparam`: an array parameter (`None`: unset or not an
	/// array).
	pub fn getaparam(&mut self, name: &[u8]) -> Option<Vec<BString>> {
		self
			.params(|ex| crate::bash::vm::zsh::params::getaparam(ex, name))
			.ok()
			.flatten()
	}

	/// Keep a store failure for the kernel (the shell abandons its
	/// scripts, as everywhere).
	pub fn fail(&mut self, err: StoreError) {
		self.k.fail(err);
	}
}

// ---- the task stack ---------------------------------------------------------

/// One entry of the editor's task stack.
pub struct Slot {
	/// Pushed by a driver ([`drive`]'s caller), identified by the frame
	/// count when it pushed it: the driver's result.
	pub(crate) root: Option<usize>,
	/// The task.
	pub(crate) task: Task,
}

/// A step of the editor that may have to wait.
pub enum Task {
	/// zsh `zleread` around a line: the init hook, the core loop, the
	/// finish hook, the display given up.
	Read(ReadTask),
	/// zsh `zlecore`: keys to widgets until the line is done.
	Core(CoreTask),
	/// zsh `execzlefunc` of one widget.
	Exec(Box<ExecTask>),
	/// A key command or character being read (zsh `getkeycmd`,
	/// `getfullchar`).
	Key(KeyTask),
	/// A shell function running as a frame above the editor's caller.
	Frame(FrameTask),
	/// The hook widgets queued in [`Editor::hooks`], run one by one.
	Hooks,
	/// Native code outside any widget waiting for something (a completion
	/// listing zrefresh started: [`Editor::pending_list`]); the answer the
	/// task below had is kept for it.
	Native(NativeTask),
}

/// A [`Task::Native`].
pub struct NativeTask {
	/// What to wait for first, and the continuation.
	start: Option<(Await, Box<dyn Cont>)>,
	/// The continuation waiting for its answer.
	cont:  Option<Box<dyn Cont>>,
	/// The answer the task below had when this one was pushed.
	saved: Option<Got>,
}

/// A task running native code `f` outside any widget (its first answer
/// is [`Got::Status`] 1, to ignore); it waits as widgets do and leaves
/// the answer slot as it found it.
pub fn native_task<F>(f: F) -> Task
where
	F: FnOnce(&mut Zw<'_, '_>, Got) -> WResult + Send + 'static,
{
	Task::Native(NativeTask { start: None, cont: Some(Box::new(f)), saved: None })
}

/// What a task step leads to.
enum Next {
	/// Keep the task; step again.
	Again(Task),
	/// Keep the task; wait for `WaitKey`.
	Wait(Task, WaitKey),
	/// Keep the task below `child`, which runs first.
	Call(Task, Task),
	/// Keep the task below a [`Task::Frame`] whose frame was just pushed:
	/// the VM runs it before the editor goes on.
	CallFrame(Task, Task),
	/// The task is over with this answer for the one below.
	Finish(Got),
	/// The task is over; the answer slot ([`Editor::got`]) is as the task
	/// left it.
	Vanish,
}

/// How a [`drive`] call ends.
pub enum Drive {
	/// The driver's task finished with this answer.
	Done(Got),
	/// Nothing to do until `WaitKey` is ready: park, then drive again.
	Park(WaitKey),
	/// A shell function frame was pushed: let the VM run it, then drive
	/// again.
	Frame,
}

/// Push `task` as the task of the driver running at frame count `owner`
/// (its result is what [`drive`] returns); the base to drive with.
pub fn push_root(ed: &mut Editor, task: Task, owner: usize) -> usize {
	let base = ed.tasks.len();
	ed.tasks.push(Slot { root: Some(owner), task });
	base
}

/// The base a driver running at frame count `owner` resumes at, when it
/// pushed a task that has not finished (a driver re-run after a frame or a
/// park finds its task again; drivers nest strictly).
pub fn resume_base(ed: &Editor, owner: usize) -> Option<usize> {
	let i = ed.tasks.iter().rposition(|s| s.root.is_some())?;
	(ed.tasks[i].root == Some(owner)).then_some(i)
}

/// Run the editor of `vp` until the task at `base` (pushed by the caller
/// with [`push_root`]) finishes or something must be waited for.
pub fn drive(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc, base: usize) -> Drive {
	loop {
		let Some(mut zle) = vp.zle.take() else {
			return Drive::Done(Got::Status(1));
		};
		let Some(mut ed) = zle.ed.take() else {
			vp.zle = Some(zle);
			return Drive::Done(Got::Status(1));
		};
		let out = if ed.tasks.len() <= base {
			Some(Drive::Done(ed.got.take().unwrap_or(Got::Status(0))))
		} else {
			let slot = ed.tasks.pop().expect("checked");
			let root = slot.root;
			let next = {
				let mut zw = Zw {
					k:    &mut *k,
					cx:   &mut *cx,
					vp:   &mut *vp,
					zle:  &mut zle,
					ed:   &mut ed,
					args: &[],
				};
				step(&mut zw, slot.task)
			};
			match next {
				Next::Again(t) => {
					ed.tasks.push(Slot { root, task: t });
					None
				},
				Next::Wait(t, key) => {
					ed.tasks.push(Slot { root, task: t });
					Some(Drive::Park(key))
				},
				Next::Call(t, child) => {
					ed.tasks.push(Slot { root, task: t });
					ed.tasks.push(Slot { root: None, task: child });
					None
				},
				Next::CallFrame(t, child) => {
					ed.tasks.push(Slot { root, task: t });
					ed.tasks.push(Slot { root: None, task: child });
					Some(Drive::Frame)
				},
				Next::Finish(got) => {
					ed.got = Some(got);
					None
				},
				Next::Vanish => None,
			}
		};
		// A listing zrefresh started that waits runs before anything else
		// (zsh asks its question inside `zrefresh`).
		let out = match ed.pending_list.take() {
			Some(start) => {
				let saved = ed.got.take();
				let native = NativeTask { start: Some(start), cont: None, saved };
				ed.tasks
					.push(Slot { root: None, task: Task::Native(native) });
				match out {
					Some(Drive::Park(_)) => None,
					o => o,
				}
			},
			None => out,
		};
		// Display bytes go out before other code runs. A park is a key read
		// that already flushed (`getbyte`): writing now would replace the
		// terminal's read watch with a write watch (one per file).
		let flushed = match &out {
			Some(Drive::Frame | Drive::Done(_)) => zle.tty.as_mut().and_then(|t| t.flush(k)),
			Some(Drive::Park(_)) | None => None,
		};
		zle.ed = Some(ed);
		vp.zle = Some(zle);
		match (out, flushed) {
			(Some(Drive::Park(_)), Some(key)) => return Drive::Park(key),
			(Some(Drive::Done(got)), Some(_)) => {
				// The bytes stay queued: the next display flushes them.
				return Drive::Done(got);
			},
			(Some(o), _) => return o,
			(None, _) => {},
		}
	}
}

/// One step of `task`.
fn step(zw: &mut Zw<'_, '_>, task: Task) -> Next {
	match task {
		Task::Read(t) => read_step(zw, t),
		Task::Core(t) => core_step(zw, t),
		Task::Exec(t) => exec_step(zw, t),
		Task::Key(t) => key_step(zw, t),
		Task::Frame(t) => frame_step(zw, t),
		Task::Hooks => hooks_step(zw),
		Task::Native(t) => native_step(zw, t),
	}
}

/// A step of a [`Task::Native`]: wait for what it asked, resume it with
/// the answer, until it is done.
fn native_step(zw: &mut Zw<'_, '_>, mut t: NativeTask) -> Next {
	let r = match (t.start.take(), t.cont.take()) {
		(Some((what, cont)), _) => WResult::Await(what, cont),
		(None, Some(cont)) => {
			let got = zw.ed.got.take().unwrap_or(Got::Status(1));
			cont.resume(zw, got)
		},
		(None, None) => WResult::Done(0),
	};
	match r {
		WResult::Done(_) => {
			zw.ed.got = t.saved.take();
			Next::Vanish
		},
		WResult::Await(what, cont) => {
			t.cont = Some(cont);
			match what {
				Await::Key => Next::Call(Task::Native(t), Task::Key(KeyTask::new(KeyMode::Cmd))),
				Await::Char => Next::Call(Task::Native(t), Task::Key(KeyTask::new(KeyMode::Char))),
				Await::Widget { name, args } => {
					let child = ExecTask::from_zle(zw.zle, name, args, false, false);
					Next::Call(Task::Native(t), Task::Exec(Box::new(child)))
				},
				Await::Function { name, args } => {
					if let Some(task) = function_task(zw, &name, &args) {
						Next::CallFrame(Task::Native(t), task)
					} else {
						zw.ed.got = Some(Got::Status(1));
						Next::Again(Task::Native(t))
					}
				},
				Await::Refresh => {
					refresh(zw);
					zw.ed.got = Some(Got::Refreshed);
					Next::Again(Task::Native(t))
				},
				Await::Wait(key) => {
					zw.ed.got = Some(Got::Refreshed);
					Next::Wait(Task::Native(t), key)
				},
				other => {
					// Only completion listings run as native tasks; they never
					// ask for the rest (recursive edits, hooks, commands).
					let mut msg = BString::from("zle: cannot wait for ");
					msg.extend_from_slice(format!("{other:?}").as_bytes());
					msg.extend_from_slice(b" while listing");
					showmsg(zw.ed, &msg);
					zw.ed.got = Some(Got::Status(1));
					Next::Again(Task::Native(t))
				},
			}
		},
	}
}

/// Run the next queued hook widget; finish when none is left.
fn hooks_step(zw: &mut Zw<'_, '_>) -> Next {
	let _ = zw.ed.got.take();
	while !zw.ed.hooks.is_empty() {
		let (name, arg) = zw.ed.hooks.remove(0);
		if let Some(task) = hook_task(zw.zle, &name, arg.as_deref().map(|a| &a[..])) {
			return Next::Call(Task::Hooks, task);
		}
	}
	Next::Finish(Got::Status(0))
}

// ---- shell functions --------------------------------------------------------

/// A shell function frame the editor waits for.
pub struct FrameTask {
	/// The frame count before the hook frame was pushed: it has returned
	/// once the vproc has no more frames than this.
	depth:  usize,
	/// `$?` before the call (zsh `doshfunc(…, noreturnval)` keeps it);
	/// `None`: `$?` stays as the frame left it ([`Await::Frame`]).
	status: Option<i32>,
}

/// Whether a shell function `name` is defined (zsh `getshfunc`).
pub fn has_function(zw: &mut Zw<'_, '_>, name: &[u8]) -> bool {
	function_exists(zw.cx, zw.vp, name)
}

/// Whether a shell function `name` is defined in `vp` (zsh `getshfunc`).
pub fn function_exists(cx: &mut Cx<'_>, vp: &Vproc, name: &[u8]) -> bool {
	matches!(state::record(cx.store, vp, Key::Func(BStr::new(name))), Ok(Some(Record::Func { .. })))
}

/// `word` single-quoted for shell code.
pub fn quote(word: &[u8], out: &mut Vec<u8>) {
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

/// Push a frame calling shell function `name` with `args` (zsh
/// `doshfunc`); `widget`: its standard input is `/dev/null` (zsh's
/// `execzlefunc` closes it for widget functions). The task to wait for it.
pub fn call_function(
	zw: &mut Zw<'_, '_>,
	name: &[u8],
	args: &[BString],
	widget: bool,
) -> FrameTask {
	let (depth, status) = push_call(zw.k, zw.vp, name, args, widget);
	FrameTask { depth, status: Some(status) }
}

/// Push the frame of [`call_function`] in `vp`: the frame count before it
/// and `$?` then (to restore when it has returned).
pub fn push_call(
	k: &mut Kernel,
	vp: &mut Vproc,
	name: &[u8],
	args: &[BString],
	widget: bool,
) -> (usize, i32) {
	let depth = vp.frames.len();
	let status = vp.status;
	let mut src = Vec::with_capacity(name.len() + 8);
	quote(name, &mut src);
	for a in args {
		src.push(b' ');
		quote(a, &mut src);
	}
	src.push(b'\n');
	push_script(vp, &src, 1, ScriptKind::Hook);
	if widget {
		let null = k
			.null_input
			.get_or_insert_with(|| {
				crate::bash::fd::FdRef::mem(crate::bash::mem::MemBuf::new(Vec::new()))
			})
			.clone();
		let prev = vp.fds.get(0).cloned();
		vp.fds.set(0, Some(null));
		if let Some(f) = vp.frames.last_mut() {
			f.redirs.push(vec![Saved { fd: 0, prev }]);
		}
	}
	(depth, status)
}

const fn frame_step(zw: &mut Zw<'_, '_>, t: FrameTask) -> Next {
	if zw.vp.frames.len() > t.depth {
		// Not ours to wait for here: the caller drives only once the frame
		// has returned.
		return Next::Again(Task::Frame(t));
	}
	let status = zw.vp.status;
	if let Some(s) = t.status {
		zw.vp.status = s;
	}
	Next::Finish(Got::Status(status))
}

/// Run shell function `name` for the editor (zsh `callhookfunc`): the
/// task, or `None` when it is not defined.
fn function_task(zw: &mut Zw<'_, '_>, name: &[u8], args: &[BString]) -> Option<Task> {
	if !has_function(zw, name) {
		return None;
	}
	Some(Task::Frame(call_function(zw, name, args, false)))
}

// ---- execzlefunc ------------------------------------------------------------

/// zsh `execzlefunc` of one widget.
pub struct ExecTask {
	/// The widget's name (thingy).
	pub(crate) name: BString,
	/// Its arguments.
	pub(crate) args: Vec<BString>,
	/// Run from a key (zsh's `args == zlenoargs`).
	pub(crate) from_key: bool,
	/// Set `bindk` (`$WIDGET`) while it runs.
	pub(crate) set_bindk: bool,
	/// Keep `lbindk` (`$LASTWIDGET`) as it was.
	pub(crate) set_lbindk: bool,
	saved_bindk: Option<BString>,
	saved_lbindk: Option<BString>,
	state: ExecState,
	/// zsh's `r`: a widget ran (`LASTWIDGET` becomes it).
	ran: bool,
	ret: i32,
	wflags: u32,
	/// `zle name -n N`/`-N`: the modifier to put back afterwards.
	pub(crate) restore_zmod: Option<super::Modifier>,
	/// `zle name -K km`: the keymap to select again afterwards.
	pub(crate) restore_keymap: Option<BString>,
	/// `WidgetsVi`: zsh `execzlefunc`'s `nestedvichg` and `isrepeat`, taken
	/// when the widget starts ([`widgets::vi::exec_begin`]).
	vichg: Option<(bool, bool)>,
	/// `WidgetsVi`: `viinrepeat` to put back afterwards (zsh `redrawhook`).
	keep_viinrepeat: Option<u8>,
}

enum ExecState {
	Start,
	/// Run this native function as the widget (an internal step of the
	/// core, not a widget of the registry: [`ExecTask::native`]).
	Call(WidgetFn),
	/// A native widget waiting with its continuation.
	Native(Box<dyn Cont>),
	/// A user widget's function running; xtrace to restore.
	User {
		xtrace: bool,
	},
	/// The immortal `.name` widget running in place of `name`.
	Immortal,
	/// Hooks owed by native code running.
	Hooks,
	Finish,
	/// Over: report `ret` without touching the editor.
	Done,
}

impl ExecTask {
	/// zsh `execzlefunc(name, args, set_bindk, set_lbindk)`.
	pub const fn new(
		name: BString,
		args: Vec<BString>,
		from_key: bool,
		set_bindk: bool,
		set_lbindk: bool,
	) -> Self {
		Self {
			name,
			args,
			from_key,
			set_bindk,
			set_lbindk,
			saved_bindk: None,
			saved_lbindk: None,
			state: ExecState::Start,
			ran: false,
			ret: 0,
			wflags: 0,
			restore_zmod: None,
			restore_keymap: None,
			vichg: None,
			keep_viinrepeat: None,
		}
	}

	/// A task running native code `f` as zsh's C code calls a function
	/// from inside the core (the `execute-named-cmd` minibuffer of
	/// `getkeycmd`): no widget name, `$WIDGET`/`$LASTWIDGET` and
	/// `lastcmd` untouched.
	pub fn native(f: WidgetFn) -> Self {
		let mut t = Self::new(BString::default(), Vec::new(), false, false, false);
		t.wflags = wflags::NOTCOMMAND;
		t.state = ExecState::Call(f);
		t
	}

	/// A task that only reports `ret` (after hooks it waited for).
	fn finished(ret: i32) -> Self {
		let mut t = Self::new(BString::default(), Vec::new(), false, false, false);
		t.ret = ret;
		t.state = ExecState::Done;
		t
	}

	/// The task for `zle name args…` (zsh `bin_zle_call`'s bindk rules).
	pub fn from_zle(
		zle: &Zle,
		name: BString,
		args: Vec<BString>,
		setbindk: bool,
		setlbindk: bool,
	) -> Self {
		let flags = zle.widgets.get(&name).map(|w| w.flags);
		let setbindk =
			setbindk || flags.is_some_and(|f| f & (wflags::INT | wflags::VIOPER) == wflags::INT);
		let setlbindk = setlbindk || flags.is_some_and(|f| f & wflags::NOLAST == wflags::NOLAST);
		Self::new(name, args, false, setbindk, setlbindk)
	}
}

/// zsh `showmsg`.
pub fn showmsg(ed: &mut Editor, msg: &[u8]) {
	super::utils::showmsg(ed, msg);
}

/// zsh `zlecallhook(name, arg)`: the task running hook widget `name`, if
/// it is a widget.
pub fn hook_task(zle: &Zle, name: &[u8], arg: Option<&[u8]>) -> Option<Task> {
	if !zle.widgets.exists(name) {
		return None;
	}
	let args = arg.map_or_default(|a| vec![BString::from(a)]);
	Some(Task::Exec(Box::new(ExecTask::new(BString::from(name), args, false, true, false))))
}

fn exec_step(zw: &mut Zw<'_, '_>, mut t: Box<ExecTask>) -> Next {
	match std::mem::replace(&mut t.state, ExecState::Finish) {
		ExecState::Start => exec_start(zw, t),
		ExecState::Call(f) => {
			let _ = zw.ed.got.take();
			let r = {
				let mut inner = Zw {
					k:    &mut *zw.k,
					cx:   &mut *zw.cx,
					vp:   &mut *zw.vp,
					zle:  &mut *zw.zle,
					ed:   &mut *zw.ed,
					args: &[],
				};
				f(&mut inner)
			};
			native_result(zw, t, r)
		},
		ExecState::Native(cont) => {
			let got = zw.ed.got.take().unwrap_or(Got::Status(1));
			let args = std::mem::take(&mut t.args);
			let r = {
				let mut inner = Zw {
					k:    &mut *zw.k,
					cx:   &mut *zw.cx,
					vp:   &mut *zw.vp,
					zle:  &mut *zw.zle,
					ed:   &mut *zw.ed,
					args: &args,
				};
				cont.resume(&mut inner, got)
			};
			t.args = args;
			native_result(zw, t, r)
		},
		ExecState::User { xtrace } => {
			let ret = match zw.ed.got.take() {
				Some(Got::Status(s)) => s,
				_ => 1,
			};
			zw.ed.in_widget = zw.ed.in_widget.saturating_sub(1);
			if xtrace {
				let _ = state::set_zsh_option(&mut zw.k.root, zw.cx.store, zw.vp, ZshOpt::Xtrace, true);
			}
			t.ret = ret;
			t.ran = true;
			// zsh: `lastcmd = w->flags`, then a user widget's flags (set by
			// `zle -f`) are cleared.
			if let Some(w) = std::sync::Arc::make_mut(&mut zw.zle.widgets).get_mut(&t.name) {
				zw.ed.lastcmd = w.flags & !(wflags::INUSE | wflags::FREE);
				if matches!(w.kind, Kind::User(_)) {
					w.flags = 0;
				}
			}
			exec_finish(zw, *t)
		},
		ExecState::Immortal => {
			t.ret = match zw.ed.got.take() {
				Some(Got::Status(s)) => s,
				_ => 1,
			};
			exec_finish(zw, *t)
		},
		ExecState::Hooks => {
			let _ = zw.ed.got.take();
			exec_hooks(zw, t)
		},
		ExecState::Finish => exec_finish(zw, *t),
		ExecState::Done => {
			let _ = zw.ed.got.take();
			Next::Finish(Got::Status(t.ret))
		},
	}
}

/// zsh `execimmortal`: run `.name` in place of a widget that cannot run.
fn exec_immortal(zw: &mut Zw<'_, '_>, mut t: Box<ExecTask>) -> Next {
	let mut dotted = BString::from(".");
	dotted.extend_from_slice(&t.name);
	if zw.zle.widgets.exists(&dotted) {
		let child = ExecTask::new(dotted, t.args.clone(), t.from_key, false, false);
		t.state = ExecState::Immortal;
		return Next::Call(Task::Exec(t), Task::Exec(Box::new(child)));
	}
	t.ret = 1;
	exec_finish(zw, *t)
}

fn exec_start(zw: &mut Zw<'_, '_>, mut t: Box<ExecTask>) -> Next {
	t.vichg = Some(widgets::vi::exec_begin(zw.zle));
	if t.set_bindk {
		t.saved_bindk = zw.ed.bindk.replace(t.name.clone());
	}
	if t.set_lbindk {
		t.saved_lbindk.clone_from(&zw.ed.lbindk);
	}
	let Some(w) = zw.zle.widgets.get(&t.name).cloned() else {
		let mut msg = BString::from("No such widget `");
		msg.extend_from_slice(&super::utils::nicedup(&t.name));
		msg.push(b'\'');
		showmsg(zw.ed, &msg);
		return exec_immortal(zw, t);
	};
	match w.kind {
		Kind::Builtin(_) | Kind::Comp { .. } | Kind::Native(_) => {
			t.ran = true;
			t.wflags = w.flags;
			let eofchar = zw.zle.tty.as_ref().and_then(|tt| tt.eofchar);
			if t.from_key
				&& eofchar.is_some_and(|c| zw.ed.keybuf.as_slice() == [c])
				&& zw.ed.line.is_empty()
				&& zw.ed.isfirstln
				&& zw.ed.flags & super::readflags::IGNOREEOF != 0
			{
				let login = zw.isset(ZshOpt::Login);
				let msg: &[u8] = if login {
					b"zsh: use 'logout' to logout."
				} else {
					b"zsh: use 'exit' to exit."
				};
				showmsg(zw.ed, msg);
				zw.ed.use_exit_printed = true;
				zw.ed.eofsent = true;
				t.ret = 1;
				return exec_finish(zw, *t);
			}
			super::utils::pre_widget(zw, w.flags);
			match w.kind {
				Kind::Comp { base, func } => {
					// zsh `execzlefunc` for `WIDGET_NCOMP`: `compwidget = w;
					// ret = completecall(args);`, the history line kept at the
					// current one when it was there.
					let atcurhist = zw.ed.histline == super::hist::curhist(zw.cx.store, zw.vp);
					zw.zle.comp.compwidget = Some(t.name.clone());
					let args = std::mem::take(&mut t.args);
					let r = {
						let mut inner = Zw {
							k:    &mut *zw.k,
							cx:   &mut *zw.cx,
							vp:   &mut *zw.vp,
							zle:  &mut *zw.zle,
							ed:   &mut *zw.ed,
							args: &args,
						};
						// zsh execzlefunc's removesuffix/fixsuffix/invalidatelist.
						super::comp::compresult::suffix::widget_prologue(&mut inner, w.flags, move |zw| {
							super::comp::tricky::completecall(zw, &base, &func)
						})
					};
					t.args = args;
					let r = if atcurhist { at_cur_hist(zw, r) } else { r };
					native_result(zw, t, r)
				},
				Kind::Native(f) => {
					let args = std::mem::take(&mut t.args);
					let r = {
						let mut inner = Zw {
							k:    &mut *zw.k,
							cx:   &mut *zw.cx,
							vp:   &mut *zw.vp,
							zle:  &mut *zw.zle,
							ed:   &mut *zw.ed,
							args: &args,
						};
						super::comp::compresult::suffix::widget_prologue(&mut inner, w.flags, move |zw| {
							f(zw)
						})
					};
					t.args = args;
					native_result(zw, t, r)
				},
				Kind::Builtin(i) => {
					let b = &widgets::BUILTINS[usize::from(i)];
					match b.func {
						Some(f) => {
							let args = std::mem::take(&mut t.args);
							let r = {
								let mut inner = Zw {
									k:    &mut *zw.k,
									cx:   &mut *zw.cx,
									vp:   &mut *zw.vp,
									zle:  &mut *zw.zle,
									ed:   &mut *zw.ed,
									args: &args,
								};
								super::comp::compresult::suffix::widget_prologue(&mut inner, w.flags, f)
							};
							t.args = args;
							native_result(zw, t, r)
						},
						// zsh's widgets without a function (`accept-search`,
						// `execute-named-cmd` outside their minibuffers) beep.
						None
							if matches!(
								b.name,
								"accept-search" | "execute-named-cmd" | "execute-last-named-cmd"
							) =>
						{
							zw.ed.feep = true;
							exec_after_native(zw, t)
						},
						None => {
							let mut msg = BString::from("zle: widget not implemented: ");
							msg.extend_from_slice(b.name.as_bytes());
							showmsg(zw.ed, &msg);
							zw.ed.feep = true;
							t.ret = 1;
							exec_after_native(zw, t)
						},
					}
				},
				Kind::User(_) => unreachable!("matched above"),
			}
		},
		Kind::User(func) => {
			if !has_function(zw, &func) {
				let mut msg = BString::from("No such shell function `");
				msg.extend_from_slice(&super::utils::nicedup(&func));
				msg.push(b'\'');
				showmsg(zw.ed, &msg);
				return exec_immortal(zw, t);
			}
			let xtrace = zw.isset(ZshOpt::Xtrace);
			if xtrace {
				let _ =
					state::set_zsh_option(&mut zw.k.root, zw.cx.store, zw.vp, ZshOpt::Xtrace, false);
			}
			zw.ed.in_widget += 1;
			let frame = call_function(zw, &func, &t.args, true);
			t.state = ExecState::User { xtrace };
			Next::CallFrame(Task::Exec(t), Task::Frame(frame))
		},
	}
}

/// The rest of a completion widget started at the current history line:
/// back there when it is over (zsh's `atcurhist`).
struct AtCurHist(Box<dyn Cont>);

impl Cont for AtCurHist {
	fn resume(self: Box<Self>, zw: &mut Zw<'_, '_>, got: Got) -> WResult {
		let r = self.0.resume(zw, got);
		at_cur_hist(zw, r)
	}
}

/// `r`, with the history line set back to the current one once it is
/// over.
fn at_cur_hist(zw: &mut Zw<'_, '_>, r: WResult) -> WResult {
	match r {
		WResult::Done(s) => {
			zw.ed.histline = super::hist::curhist(zw.cx.store, zw.vp);
			WResult::Done(s)
		},
		WResult::Await(what, cont) => WResult::Await(what, Box::new(AtCurHist(cont))),
	}
}

/// What a native widget step returned.
fn native_result(zw: &mut Zw<'_, '_>, mut t: Box<ExecTask>, r: WResult) -> Next {
	match r {
		WResult::Done(s) => {
			t.ret = s;
			exec_after_native(zw, t)
		},
		WResult::Await(what, cont) => {
			t.state = ExecState::Native(cont);
			match what {
				Await::Key => Next::Call(Task::Exec(t), Task::Key(KeyTask::new(KeyMode::Cmd))),
				Await::Char => Next::Call(Task::Exec(t), Task::Key(KeyTask::new(KeyMode::Char))),
				Await::Widget { name, args } => {
					let child = ExecTask::from_zle(zw.zle, name, args, false, false);
					Next::Call(Task::Exec(t), Task::Exec(Box::new(child)))
				},
				Await::Command { name, args } => {
					Next::CallFrame(Task::Exec(t), Task::Frame(call_function(zw, &name, &args, true)))
				},
				Await::Function { name, args } => {
					if let Some(task) = function_task(zw, &name, &args) {
						Next::CallFrame(Task::Exec(t), task)
					} else {
						zw.ed.got = Some(Got::Status(1));
						Next::Again(Task::Exec(t))
					}
				},
				Await::Refresh => {
					refresh(zw);
					zw.ed.got = Some(Got::Refreshed);
					Next::Again(Task::Exec(t))
				},
				Await::Recursive => Next::Call(Task::Exec(t), Task::Core(CoreTask::new())),
				Await::Hook { name, arg } => {
					if let Some(task) = hook_task(zw.zle, &name, arg.as_deref().map(|a| &a[..])) {
						Next::Call(Task::Exec(t), task)
					} else {
						zw.ed.got = Some(Got::Status(0));
						Next::Again(Task::Exec(t))
					}
				},
				Await::RedrawHook => {
					if let Some(task) = redrawhook(zw) {
						Next::Call(Task::Exec(t), task)
					} else {
						zw.ed.got = Some(Got::Status(0));
						Next::Again(Task::Exec(t))
					}
				},
				Await::Wait(key) => {
					zw.ed.got = Some(Got::Refreshed);
					Next::Wait(Task::Exec(t), key)
				},
				Await::Frame { depth } => {
					Next::CallFrame(Task::Exec(t), Task::Frame(FrameTask { depth, status: None }))
				},
			}
		},
	}
}

/// A native widget is over: its hooks, then `lastcmd`.
fn exec_after_native(zw: &mut Zw<'_, '_>, mut t: Box<ExecTask>) -> Next {
	if t.wflags & wflags::NOTCOMMAND == 0 {
		zw.ed.lastcmd = t.wflags;
	}
	t.state = ExecState::Hooks;
	exec_hooks(zw, t)
}

/// Run the hook widgets native code queued, one by one.
fn exec_hooks(zw: &mut Zw<'_, '_>, mut t: Box<ExecTask>) -> Next {
	while !zw.ed.hooks.is_empty() {
		let (name, arg) = zw.ed.hooks.remove(0);
		if let Some(task) = hook_task(zw.zle, &name, arg.as_deref().map(|a| &a[..])) {
			t.state = ExecState::Hooks;
			return Next::Call(Task::Exec(t), task);
		}
	}
	exec_finish(zw, *t)
}

fn exec_finish(zw: &mut Zw<'_, '_>, mut t: ExecTask) -> Next {
	if t.set_lbindk {
		zw.ed.lbindk = t.saved_lbindk.take();
	} else if t.ran {
		zw.ed.lbindk = Some(t.name.clone());
	}
	if t.set_bindk {
		zw.ed.bindk = t.saved_bindk.take();
	}
	super::utils::ccright(zw.ed);
	// WidgetsVi: a widget that started a vi change ends it (zsh
	// `execzlefunc`), and `redrawhook` keeps `viinrepeat`.
	if let Some((nested, isrepeat)) = t.vichg.take() {
		widgets::vi::exec_end(zw.zle, zw.ed, t.ret, nested, isrepeat);
	}
	if let Some(v) = t.keep_viinrepeat.take() {
		zw.zle.vi.viinrepeat = v;
	}
	if let Some(z) = t.restore_zmod.take() {
		zw.ed.zmod = z;
	}
	if let Some(km) = t.restore_keymap.take() {
		let _ = selectkeymap(&zw.zle.keymaps, zw.ed, &km, false);
		if !zw.ed.hooks.is_empty() {
			let ret = t.ret;
			zw.ed.got = None;
			return Next::Call(Task::Exec(Box::new(ExecTask::finished(ret))), Task::Hooks);
		}
	}
	Next::Finish(Got::Status(t.ret))
}

// ---- key input --------------------------------------------------------------

/// What a [`KeyTask`] reads.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyMode {
	/// A key sequence bound in the keymaps (zsh `getkeycmd`).
	Cmd,
	/// One character (zsh `getfullchar`).
	Char,
	/// One byte (zsh `getbyte` for `ZLE_CMD_GET_KEY`: `read` while the
	/// editor is active), waiting at most this many hundredths of a
	/// second (`read -t`), else for ever: [`Got::Byte`].
	Byte(Option<i64>),
}

/// A key command or character being read.
pub struct KeyTask {
	mode:    KeyMode,
	/// zsh `keybuf`: the sequence so far.
	buf:     Vec<u8>,
	/// The longest bound prefix: its length, binding and `lastchar`.
	last:    Option<(usize, Bind, i32)>,
	/// zsh's `timeout` of `getkeymapcmd`: wait at most `KEYTIMEOUT` for
	/// the next byte.
	timeout: bool,
	/// zsh's `hops`: strings sent by `bindkey -s` bindings so far.
	hops:    u32,
	/// Bytes of a multibyte character still being read: how many more.
	rest:    usize,
	/// The bytes of that character.
	mb:      Vec<u8>,
	/// A `zle -F` handler is running.
	watched: bool,
	/// The `execute-named-cmd` minibuffer is running (zsh `getkeycmd`'s
	/// `executenamedcommand`): its answer is [`Zle::named_result`].
	named:   bool,
}

impl KeyTask {
	/// A fresh read.
	pub const fn new(mode: KeyMode) -> Self {
		Self {
			mode,
			buf: Vec::new(),
			last: None,
			timeout: false,
			hops: 0,
			rest: 0,
			mb: Vec::new(),
			watched: false,
			named: false,
		}
	}

	/// The key read that waits for the `execute-named-cmd` minibuffer.
	fn named() -> (Task, Task) {
		let mut t = Self::new(KeyMode::Cmd);
		t.named = true;
		(Task::Key(t), Task::Exec(Box::new(ExecTask::native(widgets::named::named_for_key))))
	}
}

/// zsh `getkeycmd` after `executenamedcommand` returned (the widget name
/// in [`Zle::named_result`]): read again for `execute-named-cmd`, else
/// the widget (`undefined-key` when abandoned), remembered for
/// `execute-last-named-cmd`.
fn named_done(zw: &mut Zw<'_, '_>) -> Next {
	let _ = zw.ed.got.take();
	match zw.zle.named_result.take() {
		None => Next::Finish(Got::Key(Some(BString::from("undefined-key")))),
		Some(n) if n.as_slice() == b"execute-named-cmd" => {
			let (key, mini) = KeyTask::named();
			Next::Call(key, mini)
		},
		Some(n) if n.as_slice() == b"execute-last-named-cmd" => {
			Next::Finish(Got::Key(Some(zw.zle.lastnamed.clone().unwrap_or(n))))
		},
		Some(n) => {
			zw.zle.lastnamed = Some(n.clone());
			Next::Finish(Got::Key(Some(n)))
		},
	}
}

/// What zsh's `getbyte` got.
enum Byte {
	/// A byte.
	Got(u8),
	/// End of input: the terminal is gone, or an interrupt.
	Eof,
	/// `KEYTIMEOUT` passed.
	Timeout,
	/// Nothing yet.
	Pending(WaitKey),
	/// A `zle -F` fd is ready: its index in `watches`.
	Watch(usize),
	/// A zsh/sched event is due (zsh's `timedfns` while ZLE waits).
	Sched,
}

/// The UTF-8 sequence length a lead byte announces (1 for ASCII and
/// stray bytes).
const fn utf8_len(b: u8) -> usize {
	match b {
		0xc2..=0xdf => 2,
		0xe0..=0xef => 3,
		0xf0..=0xf4 => 4,
		_ => 1,
	}
}

/// zsh `getbyte(do_keytmout)` in steps.
fn getbyte(zw: &mut Zw<'_, '_>, keytimeout: bool) -> Byte {
	if let Some(b) = zw.ed.unget.pop_front() {
		zw.ed.lastchar = i32::from(b);
		widgets::vi::record_byte(zw.zle, b);
		return Byte::Got(b);
	}
	if zw.ed.aborted {
		zw.ed.lastchar = -1;
		return Byte::Eof;
	}
	let Some(tty) = zw.zle.tty.as_mut() else {
		zw.ed.lastchar = -1;
		return Byte::Eof;
	};
	// The display is out before the key is waited for.
	if let Some(key) = tty.flush(zw.k) {
		return Byte::Pending(key);
	}
	match tty.read_byte(zw.k) {
		Ok(Some(b)) => {
			zw.ed.key_timer = None;
			// Undo the exchange of `\n` and `\r` `zsetterm` asked for.
			let b = match b {
				b'\r' => b'\n',
				b'\n' => b'\r',
				b => b,
			};
			zw.ed.lastchar = i32::from(b);
			// WidgetsVi: the bytes of a vi change are recorded as read.
			widgets::vi::record_byte(zw.zle, b);
			Byte::Got(b)
		},
		Err(e) => {
			// zsh `getbyte`: the terminal is gone (end of file) or cannot
			// be read: the shell exits (the reader sees `tty_error`).
			zw.ed.lastchar = -1;
			zw.ed.aborted = true;
			zw.ed.tty_error = Some(e.kind());
			Byte::Eof
		},
		Ok(None) => {
			let mut tcx = TaskContext::from_waker(&zw.k.waker);
			for (i, w) in zw.zle.watches.iter().enumerate() {
				let h = zw.vp.fds.handle(w.fd);
				if h.is_open() && h.poll_read(&mut tcx, &mut []).is_ready() {
					return Byte::Watch(i);
				}
			}
			// zsh `calc_timeout`'s `ZTM_FUNC`: wake for the first sched event.
			let due = crate::bash::vm::builtins::zsh_mod_sched::next_due(zw.cx.store, zw.vp)
				.ok()
				.flatten();
			match due {
				Some(due) => {
					let wall = zw.cx.host.wall().secs;
					if due <= wall {
						zw.ed.sched_timer = None;
						return Byte::Sched;
					}
					if zw.ed.sched_timer.as_ref().is_none_or(|(at, _)| *at != due) {
						let ns = u64::try_from(due - wall)
							.unwrap_or(0)
							.saturating_mul(1_000_000_000);
						let at = Deadline(zw.cx.host.now_ns().saturating_add(ns));
						zw.ed.sched_timer = Some((due, zw.cx.host.timer(at)));
					}
					if let Some((_, timer)) = zw.ed.sched_timer.as_mut()
						&& timer.poll(&mut tcx).is_ready()
					{
						zw.ed.sched_timer = None;
						return Byte::Sched;
					}
				},
				None => zw.ed.sched_timer = None,
			}
			if keytimeout && zw.ed.keytimeout > 0 {
				if zw.ed.key_timer.is_none() {
					let ns = u64::try_from(zw.ed.keytimeout)
						.unwrap_or(0)
						.saturating_mul(10_000_000);
					let at = Deadline(zw.cx.host.now_ns().saturating_add(ns));
					zw.ed.key_timer = Some(zw.cx.host.timer(at));
				}
				if let Some(timer) = zw.ed.key_timer.as_mut()
					&& timer.poll(&mut tcx).is_ready()
				{
					zw.ed.key_timer = None;
					zw.ed.lastchar = -1;
					return Byte::Timeout;
				}
			}
			Byte::Pending(WaitKey::Read { fd: 0 })
		},
	}
}

/// zsh's lookup of `seq` in the local keymap, then the current one
/// (`getkeymapcmd`): the binding (an `undefined-key` binding counts as
/// none) and whether a longer sequence starts with it.
fn lookup(zle: &Zle, ed: &Editor, seq: &[u8]) -> (Option<Bind>, bool) {
	let km = &zle.keymaps;
	let undefined = |b: &Bind| matches!(b, Bind::Widget(w) if w.as_slice() == b"undefined-key");
	let mut found = None;
	let mut ispfx = if let Some(local) = ed.localkeymap.as_deref() {
		found = km.lookup(local, seq).filter(|b| !undefined(b)).cloned();
		km.is_prefix(local, seq)
	} else {
		false
	};
	if found.is_none() && !ispfx {
		found = km
			.lookup(&ed.keymap, seq)
			.filter(|b| !undefined(b))
			.cloned();
	}
	ispfx |= km.is_prefix(&ed.keymap, seq);
	(found, ispfx)
}

fn key_step(zw: &mut Zw<'_, '_>, mut t: KeyTask) -> Next {
	if t.named {
		return named_done(zw);
	}
	if t.watched {
		// A `zle -F` handler returned: the display may need redoing.
		t.watched = false;
		let _ = zw.ed.got.take();
		refresh(zw);
	}
	loop {
		let wait_rest = t.rest > 0;
		let got = if let KeyMode::Byte(limit) = t.mode {
			// The `read -t` limit stands in for `KEYTIMEOUT`.
			let saved = zw.ed.keytimeout;
			zw.ed.keytimeout = limit.unwrap_or(0);
			let got = getbyte(zw, limit.is_some());
			zw.ed.keytimeout = saved;
			got
		} else {
			getbyte(zw, t.timeout || wait_rest)
		};
		let b = match got {
			Byte::Got(b) if matches!(t.mode, KeyMode::Byte(_)) => {
				return Next::Finish(Got::Byte(Some(b)));
			},
			Byte::Eof | Byte::Timeout if matches!(t.mode, KeyMode::Byte(_)) => {
				zw.ed.key_timer = None;
				return Next::Finish(Got::Byte(None));
			},
			Byte::Got(b) => b,
			Byte::Pending(key) => return Next::Wait(Task::Key(t), key),
			Byte::Sched => {
				// zsh `checksched` from ZLE: each due event runs with `$?`
				// kept (the display given up first for `sched -o`); the line
				// is drawn again after it.
				let now = zw.cx.host.wall().secs;
				let ev = crate::bash::vm::builtins::zsh_mod_sched::take_due(
					&mut zw.k.root,
					zw.cx.store,
					zw.vp,
					now,
				)
				.unwrap_or_else(|err| {
					zw.k.fail(err);
					None
				});
				let Some(ev) = ev else {
					continue;
				};
				if ev.trash_zle() {
					trashzle(zw);
				}
				let depth = zw.vp.frames.len();
				let status = zw.vp.status;
				push_script(zw.vp, &ev.cmd, 1, ScriptKind::Eval);
				t.watched = true;
				return Next::CallFrame(
					Task::Key(t),
					Task::Frame(FrameTask { depth, status: Some(status) }),
				);
			},
			Byte::Watch(i) => {
				let w = zw.zle.watches[i].clone();
				let fd = BString::from(w.fd.to_string());
				t.watched = true;
				if w.widget {
					if let Some(task) = hook_task(zw.zle, &w.func, Some(&fd)) {
						return Next::Call(Task::Key(t), task);
					}
					t.watched = false;
					continue;
				}
				return if let Some(task) = function_task(zw, &w.func, &[fd]) {
					Next::CallFrame(Task::Key(t), task)
				} else {
					t.watched = false;
					// A handler that is gone would make every poll fire.
					zw.zle.watches.remove(i);
					continue;
				};
			},
			Byte::Eof => return key_done(zw, t, true),
			Byte::Timeout if wait_rest && t.mode == KeyMode::Char => {
				// zsh `getrestchar`: a valid lead byte whose followers
				// never came reads as `?`.
				zw.ed.lastchar = i32::from(b'?');
				zw.ed.lastchar_wide = Some('?');
				return Next::Finish(Got::Char(Some('?')));
			},
			Byte::Timeout => return key_done(zw, t, false),
		};
		match t.mode {
			KeyMode::Byte(_) => return Next::Finish(Got::Byte(Some(b))),
			KeyMode::Char => {
				if t.rest == 0 {
					t.mb.clear();
					t.mb.push(b);
					t.rest = utf8_len(b) - 1;
					if t.rest > 0 {
						continue;
					}
				} else if (0x80..0xc0).contains(&b) {
					t.mb.push(b);
					t.rest -= 1;
					if t.rest > 0 {
						continue;
					}
				} else {
					// zsh `getrestchar`: an invalid sequence is WEOF.
					t.rest = 0;
					zw.ed.lastchar_wide = None;
					return Next::Finish(Got::Char(None));
				}
				let c = match std::str::from_utf8(&t.mb) {
					Ok(s) => s.chars().next(),
					// A stray byte keeps its private encoding.
					Err(_) if t.mb.len() == 1 => Some(super::invalid_char(t.mb[0])),
					Err(_) => None,
				};
				zw.ed.lastchar_wide = c;
				return Next::Finish(Got::Char(c));
			},
			KeyMode::Cmd => {
				t.buf.push(b);
				if t.rest > 0 {
					// The rest of a self-inserted character (zsh
					// `getrestchar_keybuf`).
					t.rest -= 1;
					if t.rest > 0 {
						continue;
					}
					if let Some(l) = t.last.as_mut() {
						l.0 = t.buf.len();
					}
					let start = t.mb.first().map_or(0, |&s| usize::from(s));
					zw.ed.lastchar_wide = t
						.buf
						.get(start..)
						.and_then(|s| std::str::from_utf8(s).ok())
						.and_then(|s| s.chars().next());
					return key_done(zw, t, false);
				}
				let (f, ispfx) = lookup(zw.zle, zw.ed, &t.buf);
				if let Some(f) = f {
					// zsh: be patient with vi operators waiting for a motion.
					let vioper = matches!(&f, Bind::Widget(w)
						if zw.zle.widgets.get(w).is_some_and(|w| w.flags & wflags::VIOPER != 0));
					t.timeout = !(zw.ed.region_active == 0 && !zw.ed.ls.virangeflag && vioper);
					let selfins = matches!(&f, Bind::Widget(w) if w.as_slice() == b"self-insert" || w.as_slice() == b"self-insert-unmeta");
					t.last = Some((t.buf.len(), f, zw.ed.lastchar));
					if selfins && !ispfx && b >= 0x80 {
						let n = utf8_len(b);
						if n > 1 {
							t.rest = n - 1;
							// Where the character starts in `buf` (keys are
							// short: a byte holds it).
							t.mb.clear();
							t.mb.push(u8::try_from(t.buf.len() - 1).unwrap_or(0));
							continue;
						}
					}
					if selfins {
						zw.ed.lastchar_wide = (b < 0x80).then_some(char::from(b));
					}
				}
				if !ispfx {
					return key_done(zw, t, false);
				}
			},
		}
	}
}

/// The end of zsh's `getkeymapcmd`/`getkeycmd` loop.
fn key_done(zw: &mut Zw<'_, '_>, mut t: KeyTask, eof: bool) -> Next {
	if t.mode == KeyMode::Char {
		zw.ed.lastchar_wide = None;
		return Next::Finish(Got::Char(None));
	}
	let _ = eof;
	let (lastlen, func) = match t.last.take() {
		Some((len, f, lastc)) => {
			zw.ed.lastchar = lastc;
			(len, Some(f))
		},
		None => (t.buf.len(), None),
	};
	if lastlen < t.buf.len() {
		for &b in t.buf[lastlen..].iter().rev() {
			zw.ed.unget.push_front(b);
		}
		widgets::vi::unrecord_bytes(zw.zle, t.buf.len() - lastlen);
		t.buf.truncate(lastlen);
	}
	if t.buf.is_empty() {
		zw.ed.keybuf.clear();
		return Next::Finish(Got::Key(None));
	}
	match func {
		Some(Bind::Str(s)) => {
			t.hops += 1;
			if t.hops == 20 {
				zw.k.diag(zw.cx, zw.vp, 0, crate::bash::diag::Diag::Usage {
					msg: "string inserting another one too many times".into(),
				});
				zw.ed.keybuf = std::mem::take(&mut t.buf);
				return Next::Finish(Got::Key(None));
			}
			for &b in s.iter().rev() {
				zw.ed.unget.push_front(b);
			}
			let hops = t.hops;
			let mut fresh = KeyTask::new(KeyMode::Cmd);
			fresh.hops = hops;
			Next::Again(Task::Key(fresh))
		},
		Some(Bind::Widget(name)) => {
			zw.ed.keybuf = std::mem::take(&mut t.buf);
			if name.as_slice() == b"execute-named-cmd" && zw.ed.statusline.is_none() {
				let (key, mini) = KeyTask::named();
				return Next::Call(key, mini);
			}
			let name = if name.as_slice() == b"execute-last-named-cmd" {
				zw.zle.lastnamed.clone().unwrap_or(name)
			} else {
				name
			};
			Next::Finish(Got::Key(Some(name)))
		},
		None => {
			zw.ed.keybuf = std::mem::take(&mut t.buf);
			Next::Finish(Got::Key(Some(BString::from("undefined-key"))))
		},
	}
}

// ---- zlecore ----------------------------------------------------------------

/// zsh `zlecore`'s loop.
pub struct CoreTask {
	phase: CorePhase,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum CorePhase {
	Top,
	Key,
	Exec,
	Redraw,
}

impl CoreTask {
	/// A fresh loop.
	pub const fn new() -> Self {
		Self { phase: CorePhase::Top }
	}
}

/// zsh `invicmdmode()`: the keymap selected is `vicmd`.
pub fn invicmdmode(km: &super::keymap::Keymaps, ed: &Editor) -> bool {
	km.same(&ed.keymap, b"vicmd")
}

/// zsh `selectkeymap(name, fb)`: `Err` (after the `No such keymap`
/// message) when there is no such keymap and `fb` is off; a changed
/// keymap queues `zle-keymap-select` with the old name.
pub fn selectkeymap(
	km: &super::keymap::Keymaps,
	ed: &mut Editor,
	name: &[u8],
	fb: bool,
) -> Result<(), ()> {
	let mut name = BString::from(name);
	if !km.exists(&name) {
		let mut msg = BString::from("No such keymap `");
		msg.extend_from_slice(&super::utils::nicedup(&name));
		msg.push(b'\'');
		showmsg(ed, &msg);
		if !fb {
			return Err(());
		}
		name = BString::from(".safe");
	}
	if name != ed.keymap {
		let old = std::mem::replace(&mut ed.keymap, name);
		ed.hooks
			.push((BString::from("zle-keymap-select"), Some(old)));
	}
	Ok(())
}

/// zsh `handleprefixes`.
fn handleprefixes(ed: &mut Editor) {
	if ed.prefixflag {
		ed.prefixflag = false;
		if ed.zmod.flags & super::modflags::TMULT != 0 {
			ed.zmod.flags |= super::modflags::MULT;
			ed.zmod.mult = ed.zmod.tmult;
		}
	} else {
		ed.zmod = super::Modifier::default();
	}
}

fn core_step(zw: &mut Zw<'_, '_>, mut t: CoreTask) -> Next {
	match t.phase {
		CorePhase::Top => {
			if zw.ed.done
				|| zw.ed.aborted
				|| zw.ed.eofsent
				|| crate::bash::vm::exec::zsh_exit_pending(zw.vp).is_some()
			{
				return Next::Finish(Got::Status(0));
			}
			zw.ed.statusline = None;
			zw.ed.ls.vilinerange = false;
			let cur = zw.ed.keymap.clone();
			let _ = selectkeymap(&zw.zle.keymaps, zw.ed, &cur, true);
			if !zw.ed.hooks.is_empty() {
				return Next::Call(Task::Core(t), Task::Hooks);
			}
			zw.ed.localkeymap = (invicmdmode(&zw.zle.keymaps, zw.ed)
				&& zw.ed.region_active != 0
				&& zw.zle.keymaps.exists(b"visual"))
			.then(|| BString::from("visual"));
			t.phase = CorePhase::Key;
			Next::Call(Task::Core(t), Task::Key(KeyTask::new(KeyMode::Cmd)))
		},
		CorePhase::Key => {
			zw.ed.localkeymap = None;
			let got = zw.ed.got.take();
			let Some(Got::Key(Some(name))) = got else {
				// zsh: no key command (end of input, an interrupt) is an error.
				zw.ed.aborted = true;
				return Next::Finish(Got::Status(1));
			};
			let eofchar = zw.zle.tty.as_ref().and_then(|tt| tt.eofchar);
			if zw.ed.line.is_empty()
				&& zw.ed.isfirstln
				&& zw.ed.flags & super::readflags::IGNOREEOF == 0
				&& eofchar.is_some_and(|c| zw.ed.lastchar == i32::from(c))
			{
				zw.ed.eofsent = true;
				return Next::Finish(Got::Status(0));
			}
			zw.ed.bindk = Some(name.clone());
			t.phase = CorePhase::Exec;
			Next::Call(
				Task::Core(t),
				Task::Exec(Box::new(ExecTask::new(name, Vec::new(), true, false, false))),
			)
		},
		CorePhase::Exec => {
			let ret = match zw.ed.got.take() {
				Some(Got::Status(s)) => s,
				_ => 0,
			};
			if ret != 0 {
				zw.ed.feep = true;
				if zw.ed.eofsent {
					return Next::Finish(Got::Status(0));
				}
			}
			handleprefixes(zw.ed);
			if invicmdmode(&zw.zle.keymaps, zw.ed) {
				let bol = super::utils::findbol(zw.ed);
				if zw.ed.cs > bol && (zw.ed.cs == zw.ed.line.len() || zw.ed.line[zw.ed.cs] == '\n') {
					super::utils::deccs(zw.ed);
				}
			}
			super::undo::handleundo(zw.ed);
			t.phase = CorePhase::Redraw;
			match redrawhook(zw) {
				Some(task) => Next::Call(Task::Core(t), task),
				None => Next::Again(Task::Core(t)),
			}
		},
		CorePhase::Redraw => {
			let _ = zw.ed.got.take();
			if zw.ed.unget.is_empty() {
				refresh(zw);
			}
			t.phase = CorePhase::Top;
			Next::Again(Task::Core(t))
		},
	}
}

/// zsh `redrawhook`: `zle-line-pre-redraw`, if defined, run without
/// changing `LASTWIDGET` (zsh restores `lbindk`, `bindk` and `lastcmd`).
fn redrawhook(zw: &Zw<'_, '_>) -> Option<Task> {
	if !zw.zle.widgets.exists(b"zle-line-pre-redraw") {
		return None;
	}
	let mut t = ExecTask::new(BString::from("zle-line-pre-redraw"), Vec::new(), false, true, true);
	t.keep_viinrepeat = Some(zw.zle.vi.viinrepeat);
	Some(Task::Exec(Box::new(t)))
}

// ---- zleread ----------------------------------------------------------------

/// zsh `zleread` after its set-up (the editor is made by the caller).
pub struct ReadTask {
	/// The hook widget run when the line starts (`zle-line-init`, or
	/// `vared -i`).
	pub(crate) init:   BString,
	/// The hook widget run when it is accepted.
	pub(crate) finish: BString,
	phase:             ReadPhase,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ReadPhase {
	Start,
	Init,
	InitRedraw,
	Core,
	Finish,
}

impl ReadTask {
	/// A `zleread` with these hooks.
	pub fn new(init: &[u8], finish: &[u8]) -> Self {
		Self { init: BString::from(init), finish: BString::from(finish), phase: ReadPhase::Start }
	}
}

/// zsh's `zle_bracketed_paste` strings, when set to two.
fn bracketed(zw: &mut Zw<'_, '_>) -> Option<(BString, BString)> {
	let a = zw.getaparam(b"zle_bracketed_paste")?;
	match <[BString; 2]>::try_from(a) {
		Ok([on, off]) => Some((on, off)),
		Err(_) => None,
	}
}

fn read_step(zw: &mut Zw<'_, '_>, mut t: ReadTask) -> Next {
	match t.phase {
		ReadPhase::Start => {
			// zsh `zleread`: `fixsuffix()` before the first display.
			super::comp::compresult::suffix::fixsuffix(&mut zw.zle.comp, zw.ed);
			refresh(zw);
			t.phase = ReadPhase::Init;
			// zsh `zlecallhook(init)` keeps the error state of the line:
			// the editor's own flags are untouched by the hook.
			match hook_task(zw.zle, &t.init.clone(), None) {
				Some(task) => Next::Call(Task::Read(t), task),
				None => Next::Again(Task::Read(t)),
			}
		},
		ReadPhase::Init => {
			let _ = zw.ed.got.take();
			t.phase = ReadPhase::InitRedraw;
			if !zw.ed.line.is_empty()
				&& let Some(task) = redrawhook(zw)
			{
				return Next::Call(Task::Read(t), task);
			}
			Next::Again(Task::Read(t))
		},
		ReadPhase::InitRedraw => {
			let _ = zw.ed.got.take();
			if let Some((on, _)) = bracketed(zw)
				&& let Some(tty) = zw.zle.tty.as_mut()
			{
				tty.put(&on);
			}
			refresh(zw);
			t.phase = ReadPhase::Core;
			Next::Call(Task::Read(t), Task::Core(CoreTask::new()))
		},
		ReadPhase::Core => {
			let _ = zw.ed.got.take();
			if zw.ed.aborted {
				let name: &[u8] = if zw.ed.context == super::Context::Vared {
					b"ZLE_VARED_ABORTED"
				} else {
					b"ZLE_LINE_ABORTED"
				};
				let line = super::from_line(&zw.ed.line);
				let _ = zw.params(|ex| crate::bash::vm::zsh::params::assignsparam(ex, name, &line, 0));
			}
			// A message the last widget gave shows before the terminal leaves
			// bracketed paste (zsh printed it from the widget).
			super::display::show_msg(zw);
			if let Some((_, off)) = bracketed(zw)
				&& let Some(tty) = zw.zle.tty.as_mut()
			{
				tty.put(&off);
			}
			t.phase = ReadPhase::Finish;
			if zw.ed.done
				&& !zw.ed.aborted
				&& crate::bash::vm::exec::zsh_exit_pending(zw.vp).is_none()
				&& let Some(task) = hook_task(zw.zle, &t.finish.clone(), None)
			{
				return Next::Call(Task::Read(t), task);
			}
			Next::Again(Task::Read(t))
		},
		ReadPhase::Finish => {
			let _ = zw.ed.got.take();
			zw.ed.statusline = None;
			// zsh `zleread`: `invalidatelist(); trashzle();`.
			super::comp::compresult::suffix::invalidatelist(zw);
			trashzle(zw);
			zw.zle.display.lastlistlen = 0;
			let ok = !(zw.ed.eofsent
				|| zw.ed.aborted
				|| crate::bash::vm::exec::zsh_exit_pending(zw.vp).is_some());
			Next::Finish(Got::Status(i32::from(!ok)))
		},
	}
}

// ---- display ----------------------------------------------------------------

/// zsh `zrefresh()`: bring the terminal up to date with the editor.
pub fn refresh(zw: &mut Zw<'_, '_>) {
	super::display::refresh(zw);
}

/// zsh `trashzle()`: leave the display for other output (cursor below
/// the line, terminal back in its normal modes).
pub fn trashzle(zw: &mut Zw<'_, '_>) {
	super::display::trashzle(zw);
}
