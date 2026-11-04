//! Engine-native builtins.
//!
//! A builtin runs against a [`Ctx`]: it reads shell state, asks for file
//! probes and fd input through [`Ctx::probe`], and queues its output and
//! diagnostics in order. A builtin that needs a probe returns
//! [`Need::Probe`] *before* changing any state; the `Exec` performs the
//! probe through the pollable `Fs` (parking while it is pending), caches the
//! answer and runs the builtin again. So a builtin never blocks and re-runs
//! are invisible. A command substitution in text a builtin expands itself
//! ([`Ctx::expand_subscript`]) works the same way: [`Need::Sub`] starts it,
//! its output joins the builtin's replay log, and the re-run replays it.

mod caller;
mod dir;
pub mod dirstack;
mod doc_table;
pub mod flow;
mod getopts;
mod help;
pub mod history;
mod io;
mod jobs;
mod kill;
mod mapfile;
pub mod misc;
mod names;
mod options;
mod printf;
mod strftime;
mod test;
pub mod trap;
mod vars;
pub mod zsh_args;
mod zsh_dir;
pub mod zsh_names;
pub mod zsh_print;
pub mod zsh_prompt;
pub mod zsh_quote;
pub mod zsh_typeset;
mod zsh_vars;

use bstr::{BStr, BString};

pub use self::{
	io::select_next,
	names::{Aliases, alias_table, flush_hash, legal_alias_name},
	test::cond_test,
	trap::hard_ignore,
	vars::{
		Lhs, assign, assign_loop_var, assign_special_prefix, declare_line, define_function,
		prefix_value, set_value,
	},
	zsh_vars::assign_zsh_loop_var,
};
use super::{
	Cx, Kernel,
	proc::{Probe, ProbeResult, Vproc},
	state::{self, Level, Var},
};
use crate::bash::{
	diag::Diag,
	ids::{IntrinsicId, Vpid},
	store::{Key, KeyBuf, OptId, Record, StoreError},
};

/// One piece of a builtin's output, in the order it was produced.
pub enum Chunk {
	/// Bytes for an fd.
	Out(i32, Vec<u8>),
	/// A diagnostic for stderr (rendered when the builtin completes).
	Diag(Diag),
}

/// Why a builtin could not complete yet (or at all).
pub enum Need {
	/// Answer this probe, then run the builtin again.
	Probe(Probe),
	/// The state store failed.
	Store(StoreError),
	/// Run this command substitution ([`super::expand::Stop::Sub`]), then
	/// run the builtin again.
	Sub(super::expand::Stop),
}

impl From<StoreError> for Need {
	fn from(e: StoreError) -> Self {
		Self::Store(e)
	}
}

/// What the builtin asks the `Exec` to do after it.
pub enum Control {
	/// Nothing: the command is done.
	None,
	/// `return` (status in [`Outcome::status`]).
	Return,
	/// `break n` / `continue n`.
	Break {
		/// Levels.
		n:    u32,
		/// `continue`.
		cont: bool,
	},
	/// `exit`.
	Exit,
	/// An error that abandons the rest of the line (bash's
	/// `jump_to_top_level (DISCARD)` after `top_level_cleanup`: a bad array
	/// subscript), status in [`Outcome::status`]: a `-c` string is abandoned
	/// whole, a script file goes on with its next command.
	DiscardAll,
	/// A frame was pushed (`eval`, `source`): wait for it to return.
	Frame,
	/// A frame was pushed (`mapfile`'s callback): wait for it to return,
	/// then run the builtin again, [`Ctx::resumed`] one more.
	Resume,
	/// `wait`: wait for these children.
	Wait(Wait),
}

/// What `wait` waits for.
pub struct Wait {
	/// The children, in order.
	pub children: Vec<Vpid>,
	/// `wait` without operands: the status stays 0 rather than the last
	/// child's.
	pub all:      bool,
	/// `wait -n`: the first of them to finish; its status.
	pub any:      bool,
	/// `wait -p var`: the variable that gets the waited child's pid.
	pub into:     Option<BString>,
	/// `wait -f`: a stopped job does not end the wait.
	pub force:    bool,
}

/// `name` and the subscript of a `name[subscript]` variable reference.
pub fn split_subscript(name: &[u8]) -> (&[u8], Option<&[u8]>) {
	match name.iter().position(|&c| c == b'[') {
		Some(i) if name.ends_with(b"]") => (&name[..i], Some(&name[i + 1..name.len() - 1])),
		_ => (name, None),
	}
}

/// A completed builtin.
pub struct Outcome {
	/// Exit status.
	pub status:  i32,
	/// Follow-up.
	pub control: Control,
}

/// Result of a builtin run.
pub type R = Result<Outcome, Need>;

/// A plain completion with `status`.
#[expect(
	clippy::unnecessary_wraps,
	reason = "builtins return R; done(...) is the common tail expression"
)]
pub const fn done(status: i32) -> R {
	Ok(Outcome { status, control: Control::None })
}

/// What a builtin runs against.
pub struct Ctx<'a, 'c> {
	pub k:           &'a mut Kernel,
	pub cx:          &'a mut Cx<'c>,
	pub vp:          &'a mut Vproc,
	probes:          &'a [(Probe, ProbeResult)],
	/// Output and diagnostics in order.
	pub chunks:      Vec<Chunk>,
	/// Script line (diagnostics, `$LINENO`).
	pub line:        u32,
	/// The builtin's name (diagnostic prefix).
	pub name:        &'static str,
	/// argv indexes of words written as compound assignments
	/// (`declare a=(…)`).
	pub compound:    Vec<u32>,
	/// The builtin failed in a way fatal to a posix shell when it is a
	/// special builtin not run through `command`: bash's `EX_USAGE` (a bad
	/// option, a non-numeric argument, an invalid name) or a `.` file that
	/// cannot be read.
	pub usage_error: bool,
	/// Replay log of the substitutions the builtin ran
	/// ([`Slot::Builtin`](super::proc::Slot)).
	pub log:         Vec<super::proc::Atom>,
	/// Replay position in `log` (0 at each run).
	pub log_cursor:  usize,
	/// argv indexes (counting argv\[0\]) of fields from words written as
	/// array references, `d[$k]` (bash's `W_ARRAYREF`): `unset` takes their
	/// key as is.
	pub arrayref:    Vec<u32>,
	/// Times the builtin ran again after a frame it pushed returned
	/// ([`Control::Resume`]).
	pub resumed:     u32,
}

impl<'a, 'c> Ctx<'a, 'c> {
	pub const fn new(
		k: &'a mut Kernel,
		cx: &'a mut Cx<'c>,
		vp: &'a mut Vproc,
		probes: &'a [(Probe, ProbeResult)],
		line: u32,
		name: &'static str,
	) -> Self {
		Self {
			k,
			cx,
			vp,
			probes,
			chunks: Vec::new(),
			line,
			name,
			compound: Vec::new(),
			usage_error: false,
			log: Vec::new(),
			log_cursor: 0,
			arrayref: Vec::new(),
			resumed: 0,
		}
	}

	/// The answer to `p`, or a request for it.
	pub fn probe(&self, p: Probe) -> Result<ProbeResult, Need> {
		// Each probe is answered once; a builtin that reads in parts asks
		// for its latest ones again.
		self
			.probes
			.iter()
			.rev()
			.find(|(q, _)| *q == p)
			.map(|(_, r)| r.clone())
			.ok_or(Need::Probe(p))
	}

	/// Expand the array subscript text a builtin was given (bash's
	/// `expand_subscript_string`), running its command substitutions:
	/// [`Need::Sub`] parks the builtin until one is done. `Err` inside is
	/// the expansion error to report.
	pub fn expand_subscript(&mut self, text: &[u8]) -> Result<Result<BString, Diag>, Need> {
		self.subscript(text, true)
	}

	/// [`Self::expand_subscript`] for an indexed array: the text is expanded
	/// as arithmetic text (bash's `array_expand_index`), for `arith_value`.
	pub fn expand_index_subscript(&mut self, text: &[u8]) -> Result<Result<BString, Diag>, Need> {
		self.subscript(text, false)
	}

	fn subscript(&mut self, text: &[u8], assoc: bool) -> Result<Result<BString, Diag>, Need> {
		match super::expand::expand_subscript(
			self.k,
			self.cx,
			self.vp,
			self.line,
			&mut self.log,
			&mut self.log_cursor,
			text,
			assoc,
		) {
			Ok(v) => Ok(Ok(v)),
			Err(super::expand::Stop::Fail(d) | super::expand::Stop::Fatal(d)) => Ok(Err(d)),
			Err(super::expand::Stop::Store(e)) => Err(Need::Store(e)),
			// A substitution or probe to run first.
			Err(sub) => Err(Need::Sub(sub)),
		}
	}

	/// Queue bytes for stdout.
	pub fn out(&mut self, bytes: &[u8]) {
		self.out_fd(1, bytes);
	}

	/// bash `builtin_usage`: `NAME: usage: SYNOPSIS` on stderr (no script
	/// or line prefix), the synopsis from bash's builtin table.
	pub fn builtin_usage(&mut self) {
		self.usage_error = true;
		if let Some(e) = doc_table::TABLE
			.iter()
			.find(|e| e.command && e.name == self.name)
		{
			let line = format!("{}: usage: {}\n", self.name, e.short);
			self.out_fd(2, line.as_bytes());
		}
	}

	/// Queue bytes for `fd`.
	pub fn out_fd(&mut self, fd: i32, bytes: &[u8]) {
		if bytes.is_empty() {
			return;
		}
		if let Some(Chunk::Out(f, buf)) = self.chunks.last_mut()
			&& *f == fd
		{
			buf.extend_from_slice(bytes);
			return;
		}
		self.chunks.push(Chunk::Out(fd, bytes.to_vec()));
	}

	/// Queue `NAME: <diag>` for stderr.
	pub fn err(&mut self, d: Diag) {
		self.chunks.push(Chunk::Diag(d.by(self.name)));
	}

	/// Queue `NAME: msg` for stderr.
	pub fn usage(&mut self, msg: impl Into<std::borrow::Cow<'static, str>>) {
		self.err(Diag::Usage { msg: msg.into() });
	}

	/// Queue a diagnostic without the builtin prefix.
	pub fn diag(&mut self, d: Diag) {
		self.chunks.push(Chunk::Diag(d));
	}

	/// A variable as this vproc sees it.
	pub fn var(&mut self, name: &[u8]) -> Result<Option<Var>, Need> {
		Ok(state::lookup(&self.k.root, self.cx.store, self.vp, name)?.cloned())
	}

	/// A variable's scalar value.
	pub fn scalar(&mut self, name: &[u8]) -> Result<Option<BString>, Need> {
		Ok(state::lookup(&self.k.root, self.cx.store, self.vp, name)?
			.and_then(|v| v.as_scalar().map(BString::from)))
	}

	/// Store (or unset) a variable.
	pub fn set_var(&mut self, name: &[u8], var: Option<Var>, level: Level) {
		state::store_var(&mut self.k.root, self.cx.store, self.vp, name, var, level);
	}

	/// An option.
	pub fn option(&mut self, opt: OptId) -> Result<bool, Need> {
		Ok(state::option(&mut self.k.root, self.cx.store, self.vp, opt)?)
	}

	/// Set an option.
	pub fn set_option(&mut self, opt: OptId, on: bool) {
		state::store_record(
			&mut self.k.root,
			self.cx.store,
			self.vp,
			KeyBuf::Opt(opt),
			Some(Record::Opt(on)),
		);
	}

	/// A zsh option (env options read their bash twin).
	pub fn zsh_option(&mut self, opt: crate::bash::zshopt::ZshOpt) -> Result<bool, Need> {
		Ok(state::zsh_option(&mut self.k.root, self.cx.store, self.vp, opt)?)
	}

	/// Set a zsh option.
	pub fn set_zsh_option(
		&mut self,
		opt: crate::bash::zshopt::ZshOpt,
		on: bool,
	) -> Result<(), Need> {
		Ok(state::set_zsh_option(&mut self.k.root, self.cx.store, self.vp, opt, on)?)
	}

	/// A non-variable record.
	pub fn record(&mut self, key: Key<'_>) -> Result<Option<Record>, Need> {
		Ok(state::record(self.cx.store, self.vp, key)?.cloned())
	}

	/// Write (or remove) a non-variable record.
	pub fn store_record(&mut self, key: KeyBuf, rec: Option<Record>) {
		state::store_record(&mut self.k.root, self.cx.store, self.vp, key, rec);
	}

	/// The function named `name`, if defined.
	pub fn function(&mut self, name: &[u8]) -> Result<Option<Record>, Need> {
		self.record(Key::Func(BStr::new(name)))
	}

	/// Positional parameters.
	pub fn positional(&mut self) -> Result<Vec<BString>, Need> {
		Ok(state::positional(&self.k.root, self.cx.store, self.vp)?)
	}
}

/// Run builtin `id` with `argv` (`argv[0]` is its name).
pub fn run(id: IntrinsicId, ctx: &mut Ctx<'_, '_>, argv: &[BString]) -> R {
	use IntrinsicId as I;
	if ctx.vp.mode.dialect() == crate::bash::ids::Dialect::Zsh
		&& let Some(r) = zsh_args::run(id, ctx, argv)
	{
		return r;
	}
	let args = &argv[1..];
	// bash `CHECK_HELPOPT`: every builtin but these prints its help.
	if args.first().is_some_and(|a| a.as_slice() == b"--help")
		&& !matches!(id, I::Colon | I::True | I::False | I::Echo | I::Test | I::Bracket)
	{
		return help::builtin_help(ctx);
	}
	match id {
		I::Colon | I::True => done(0),
		I::False => done(1),
		I::Echo => io::echo(ctx, args),
		I::Printf => printf::printf(ctx, args),
		I::Read => io::read(ctx, args),
		I::Declare | I::Typeset => vars::declare(ctx, args, vars::DeclareKind::Declare),
		I::Local => vars::declare(ctx, args, vars::DeclareKind::Local),
		I::Export => vars::declare(ctx, args, vars::DeclareKind::Export),
		I::Readonly => vars::declare(ctx, args, vars::DeclareKind::Readonly),
		I::Unset => vars::unset(ctx, args),
		I::Shift => vars::shift(ctx, args),
		I::Set => vars::set(ctx, args),
		I::Shopt => vars::shopt(ctx, args),
		I::Let => vars::let_(ctx, args),
		I::Alias => names::alias(ctx, args),
		I::Unalias => names::unalias(ctx, args),
		I::Type => names::type_(ctx, args),
		I::Command => names::command_v(ctx, args),
		I::Compgen => names::compgen(ctx, args),
		I::Complete => names::complete(ctx, args),
		I::Compopt => names::compopt(ctx, args),
		I::Bind => misc::bind(ctx, args),
		I::Fc => history::fc(ctx, args),
		I::Hash => names::hash(ctx, args),
		I::Eval => flow::eval(ctx, args),
		I::Source | I::Dot => flow::source(ctx, args),
		I::Return => flow::return_(ctx, args),
		I::Exit => flow::exit(ctx, args),
		I::Logout => flow::logout(ctx, args),
		I::Break => flow::break_(ctx, args, false),
		I::Continue => flow::break_(ctx, args, true),
		I::Wait => flow::wait(ctx, args),
		I::Kill => kill::kill(ctx, args),
		I::Trap => trap::trap(ctx, args),
		I::Test => test::test(ctx, args, false),
		I::Bracket => test::test(ctx, args, true),
		I::Cd => dir::cd(ctx, args),
		I::Pwd => dir::pwd(ctx, args),
		I::Umask => dir::umask(ctx, args),
		I::Getopts => getopts::getopts(ctx, args),
		I::Jobs => jobs::jobs(ctx, args),
		I::Fg | I::Bg => jobs::fg_bg(ctx, argv),
		I::Suspend => jobs::suspend(ctx, args),
		I::Disown => jobs::disown(ctx, args),
		I::Mapfile | I::Readarray => mapfile::mapfile(ctx, args),
		I::Dirs => dirstack::dirs(ctx, args),
		I::Pushd => dirstack::pushd(ctx, args),
		I::Popd => dirstack::popd(ctx, args),
		I::Enable => misc::enable(ctx, args),
		I::Help => help::help(ctx, args),
		I::History => history::history(ctx, args),
		I::Times => misc::times(ctx, args),
		I::Ulimit => misc::ulimit(ctx, args),
		I::Strmatch => misc::strmatch(ctx, args),
		// `builtin NAME …` is resolved by command lookup; alone it does
		// nothing.
		I::Builtin => done(0),
		I::Caller => caller::caller(ctx, args),
		I::Emulate => options::emulate(ctx, args),
		I::Setopt => options::setopt(ctx, args, false),
		I::Unsetopt => options::setopt(ctx, args, true),
		I::Exec | I::Getln => {
			ctx.diag(Diag::Unsupported { what: format!("the `{}' builtin", ctx.name).into() });
			done(2)
		},
		// zsh-only builtins: `zsh_args::run` handles each of them in a zsh
		// unit, and no other dialect resolves them.
		I::Print
		| I::Pushln
		| I::Integer
		| I::Float
		| I::Functions
		| I::Unfunction
		| I::Autoload
		| I::Whence
		| I::Which
		| I::Where
		| I::Zmodload
		| I::Unhash
		| I::Rehash
		| I::Disable
		| I::Chdir
		| I::Bindkey
		| I::Vared
		| I::Zle
		| I::Compctl
		| I::Compcall
		| I::Compadd
		| I::Compset
		| I::Comparguments
		| I::Compdescribe
		| I::Compfiles
		| I::Compgroups
		| I::Compquote
		| I::Comptags
		| I::Comptry
		| I::Compvalues => done(2),
	}
}

/// Parse a decimal integer argument the way bash's `legal_number` does
/// (surrounding blanks allowed, optional sign).
pub fn number(arg: &[u8]) -> Option<i64> {
	let t = arg.trim_ascii();
	let (neg, digits) = match t.first() {
		Some(b'-') => (true, &t[1..]),
		Some(b'+') => (false, &t[1..]),
		_ => (false, t),
	};
	if digits.is_empty() || !digits.iter().all(u8::is_ascii_digit) {
		return None;
	}
	let mut v: i64 = 0;
	for &c in digits {
		v = v.wrapping_mul(10).wrapping_add(i64::from(c - b'0'));
	}
	Some(if neg { v.wrapping_neg() } else { v })
}

/// Leading option words of a builtin's arguments.
pub struct Opts<'a> {
	/// `(letter, on, argument)` in order; `on` is false for `+x`.
	pub flags: Vec<(u8, bool, Option<BString>)>,
	/// The operands.
	pub rest:  &'a [BString],
}

impl Opts<'_> {
	/// Whether `-c` was given.
	pub fn has(&self, c: u8) -> bool {
		self.flags.iter().any(|&(f, on, _)| f == c && on)
	}

	/// The argument of the last `-c`.
	pub fn arg(&self, c: u8) -> Option<&BString> {
		self
			.flags
			.iter()
			.rev()
			.find(|(f, ..)| *f == c)
			.and_then(|(_, _, a)| a.as_ref())
	}
}

/// Split leading `-xyz` option words off `args` (stopping at `--`, `-` or
/// the first operand). `allowed` lists the flag letters, `with_arg` the
/// letters that take an argument (attached, `-d:`, or the next word);
/// `plus` accepts `+x`. An unknown letter queues bash's `invalid option`
/// message and yields `Err(2)`.
pub fn opts<'a>(
	ctx: &mut Ctx<'_, '_>,
	args: &'a [BString],
	allowed: &[u8],
	with_arg: &[u8],
	plus: bool,
) -> Result<Opts<'a>, i32> {
	let mut flags = Vec::new();
	let mut i = 0;
	while let Some(a) = args.get(i) {
		if a.as_slice() == b"--" {
			i += 1;
			break;
		}
		let on = match a.first() {
			Some(b'-') => true,
			Some(b'+') if plus => false,
			_ => break,
		};
		if a.len() < 2 {
			break;
		}
		i += 1;
		let mut j = 1;
		while j < a.len() {
			let c = a[j];
			if with_arg.contains(&c) {
				let arg = if j + 1 < a.len() {
					BString::from(&a[j + 1..])
				} else if let Some(v) = args.get(i) {
					i += 1;
					v.clone()
				} else {
					ctx.err(Diag::Usage {
						msg: format!("-{}: option requires an argument", c as char).into(),
					});
					ctx.builtin_usage();
					return Err(2);
				};
				flags.push((c, on, Some(arg)));
				break;
			}
			if !allowed.contains(&c) {
				let sign = if on { '-' } else { '+' };
				ctx.err(Diag::Usage { msg: format!("{sign}{}: invalid option", c as char).into() });
				ctx.builtin_usage();
				return Err(2);
			}
			flags.push((c, on, None));
			j += 1;
		}
	}
	Ok(Opts { flags, rest: &args[i..] })
}
