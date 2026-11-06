//! zsh/zpty: `zpty`, commands running on pseudo-terminals.
//!
//! A pty command runs in a subshell of this shell (zsh forks one: the
//! shell's functions and parameters are visible in it) whose fds 0–2 are
//! the slave side of a new pty; the externals it starts lead sessions of
//! their own ([`crate::bash::SpawnSpec::ctty`]) and `/dev/tty` there opens
//! the slave. The
//! master sits in the shell's fd table at 10 or above (`$REPLY`), close on
//! exec, so subshells reach it as zsh's forks do. The command table lives
//! in the vproc ([`crate::bash::vm::proc::VprocZsh::ptys`]) and subshells
//! start with a copy, like zsh's `ptycmds` across a fork.
//!
//! Nothing blocks: a read that would wait parks the builtin on a one-byte
//! input probe; what it read so far stays in the command's entry, so the
//! re-run continues where it stopped. Hosts without terminals (agent
//! shells, the testkit) cannot open a pty: `zpty` fails with zsh's
//! `can't open pseudo terminal` message.
//!
//! Ported from zsh 5.9 `Src/Modules/zpty.c` (MIT-style licence, Copyright
//! (c) 2000 Sven Wischnowsky and the zsh development group).

use std::{
	io,
	task::{Context, Poll},
};

use bstr::BString;
use serde::{Deserialize, Serialize};

use super::{
	Ctx, Need, R, done,
	zsh_args::{Ops, ZPat, pattern_arg, zerr, zx},
	zsh_mod_util::zsh_errmsg,
	zsh_print::charset,
	zsh_quote::quotedzputs,
};
use crate::bash::{
	ControlHandle, FdFlags, FdRef, SetWhen, SigTarget, Signal, TermFlag, TtyInfo, Vpid,
	diag::Diag,
	event::EventData,
	store::Attrs,
	syntax::{NO_ALIASES, ParseError, Parser, Pos},
	vm::{
		ProcState, exec,
		proc::{Ctty, Probe, ProbeResult, Vproc},
		set_subshell_depth, state, subshell_depth,
		zsh::params,
	},
	zshopt::ZshOpt,
};

/// zsh `READ_MAX`: the most a pattern read consumes.
const READ_MAX: usize = 1024 * 1024;

/// zsh's `Meta`-escaped bytes (`imeta`): they take two bytes of the
/// metafied buffer zsh counts against `READ_MAX`.
const fn imeta(c: u8) -> bool {
	matches!(c, 0 | 0x83..=0xa2)
}

/// The pty commands of a vproc (zsh `ptycmds`, newest first) and the
/// subshells of deleted ones whose exit status is still to be collected.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PtyTable {
	/// The commands, newest first.
	pub cmds: Vec<PtyCmd>,
	/// Subshells of deleted commands this vproc started, collected once
	/// they exit.
	pub reap: Vec<Vpid>,
}

impl PtyTable {
	/// Whether it holds nothing.
	pub const fn is_empty(&self) -> bool {
		self.cmds.is_empty() && self.reap.is_empty()
	}
}

/// One pty command (zsh `struct ptycmd`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PtyCmd {
	/// Its name.
	pub name:     BString,
	/// The command words (joined with spaces, they are the command).
	pub args:     Vec<BString>,
	/// The master's fd in the shell's fd table (`$REPLY`).
	pub fd:       i32,
	/// The subshell running the command (zsh `pid`).
	pub vpid:     Vpid,
	/// The vproc that started it: the one that collects its status.
	pub owner:    Vpid,
	/// `-e`: the pty echoes input.
	pub echo:     bool,
	/// `-b`: reads and writes do not wait.
	pub nblock:   bool,
	/// The command finished and its output was drained (zsh `fin`).
	pub fin:      bool,
	/// A byte `checkptycmd` read ahead (zsh `read`).
	pub read:     Option<u8>,
	/// What a pattern read kept when the read would have waited (zsh
	/// `old`).
	pub old:      Vec<u8>,
	/// The one-byte read the builtin parked on, if any.
	pub wait:     Option<Parked>,
	/// The parked read's answer was end of input (a `read` returning 0),
	/// not yet seen by the code that asked.
	pub eof:      bool,
	/// A `zpty -r` that parked: its loop state.
	pub progress: Option<Progress>,
	/// Probe parts handed out (each parked read asks for a new one).
	pub parts:    u32,
	/// This shell's hold on the slave while the command may still have
	/// unread output: a pty whose last slave descriptor closes drops what
	/// is buffered (macOS), and the command's subshell ends as soon as its
	/// last command does, before this shell got to read. Released once the
	/// command ended and its output is drained. Never serialized.
	#[serde(skip)]
	pub hold:     Ctty,
}

/// A read the builtin parked on ([`PtyCmd::wait`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Parked {
	/// The input probe's `part`.
	pub part:    u32,
	/// It is `ptyread`'s own read, not `checkptycmd`'s.
	pub at_read: bool,
}

/// The state of `ptyread`'s loop across a park.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Progress {
	/// The bytes read since the last flush (raw).
	buf:     Vec<u8>,
	/// zsh `used`: the metafied length of `buf`.
	used:    usize,
	/// zsh `blen`.
	blen:    usize,
	/// zsh `seen`.
	seen:    bool,
	/// zsh `ret`: the last read's result (1, 0, -1).
	ret:     i32,
	/// The last failed read failed with `EAGAIN`.
	again:   bool,
	/// Output flushed to stdout so far (no parameter given).
	out:     Vec<u8>,
	/// Successive reads that returned 0 while the command lives.
	zeros:   u32,
	/// The loop ended (the value is zsh `matchok`); only the result is
	/// still to be stored.
	matched: Option<bool>,
}

impl Progress {
	const fn new() -> Self {
		Self {
			buf:     Vec::new(),
			used:    0,
			blen:    256,
			seen:    false,
			ret:     0,
			again:   false,
			out:     Vec::new(),
			zeros:   0,
			matched: None,
		}
	}
}

/// One `read(fd, &c, 1)`.
enum Rd {
	Byte(u8),
	/// It returned 0.
	Eof,
	/// It failed (not `EAGAIN`).
	Err,
	/// It would wait.
	Again,
}

/// The builtin must park until fd input arrives.
struct Park {
	at_read: bool,
}

/// The vproc's command table.
fn table(vp: &Vproc) -> Option<&PtyTable> {
	vp.zsh.as_deref().map(|z| &z.ptys)
}

/// The vproc's command table, created when missing.
fn table_mut(vp: &mut Vproc) -> &mut PtyTable {
	&mut vp.zsh.get_or_insert_with(Box::default).ptys
}

/// Index of command `name` (zsh `getptycmd`).
fn find(vp: &Vproc, name: &[u8]) -> Option<usize> {
	table(vp)?
		.cmds
		.iter()
		.position(|p| p.name.as_slice() == name)
}

/// Whether the subshell `vpid` still runs (zsh `kill(pid, 0)`).
fn alive(ctx: &mut Ctx<'_, '_>, vpid: Vpid) -> bool {
	!matches!(ctx.k.proc_state(ctx.cx.store, vpid), Some(ProcState::Exited(_)))
}

/// One byte from `fd` without waiting.
fn read1(ctx: &Ctx<'_, '_>, fd: i32) -> Rd {
	let h = ctx.vp.fds.handle(fd);
	let mut tcx = Context::from_waker(&ctx.k.waker);
	let mut b = [0u8; 1];
	match h.poll_read(&mut tcx, &mut b) {
		Poll::Ready(Ok(1)) => Rd::Byte(b[0]),
		Poll::Ready(Ok(_)) => Rd::Eof,
		Poll::Ready(Err(e)) if e.kind() == io::ErrorKind::WouldBlock => Rd::Again,
		Poll::Ready(Err(_)) => Rd::Err,
		Poll::Pending => Rd::Again,
	}
}

/// The next byte for `cmd`: a parked read's end of input first.
fn next_byte(ctx: &Ctx<'_, '_>, cmd: &mut PtyCmd) -> Rd {
	if std::mem::take(&mut cmd.eof) {
		return Rd::Eof;
	}
	read1(ctx, cmd.fd)
}

/// Whether input is available on `fd` (zsh's `select` with a zero
/// timeout in `ptyread`).
fn ready(ctx: &Ctx<'_, '_>, fd: i32) -> bool {
	let h = ctx.vp.fds.handle(fd);
	let mut tcx = Context::from_waker(&ctx.k.waker);
	h.is_open() && h.poll_read(&mut tcx, &mut []).is_ready()
}

/// The one-byte probe a parked read waits on.
const fn probe(fd: i32, part: u32) -> Probe {
	Probe::Input { fd, delim: None, lines: 1, nchars: Some(1), part, timeout_ns: None }
}

/// Take the answer of the read `cmd` parked on: the byte becomes
/// `cmd.read`, end of input `cmd.eof`. `Err` while it is not answered;
/// but when the command ended meanwhile (its end wakes this shell), what it
/// wrote is all there is: a byte if one is left, else end of input.
fn settle(ctx: &mut Ctx<'_, '_>, cmd: &mut PtyCmd) -> Result<(), Need> {
	let Some(w) = cmd.wait else {
		return Ok(());
	};
	let answer = match ctx.probe(probe(cmd.fd, w.part)) {
		Ok(a) => a,
		Err(need) => {
			if cmd.hold.0.is_none() || alive(ctx, cmd.vpid) {
				return Err(need);
			}
			cmd.wait = None;
			match read1(ctx, cmd.fd) {
				Rd::Byte(c) => cmd.read = Some(c),
				Rd::Again | Rd::Eof | Rd::Err => {
					cmd.hold = Ctty(None);
					cmd.eof = true;
				},
			}
			return Ok(());
		},
	};
	cmd.wait = None;
	if let ProbeResult::Input { data, .. } = answer {
		match data.first() {
			Some(&c) => cmd.read = Some(c),
			None => cmd.eof = true,
		}
	}
	Ok(())
}

/// Park `cmd` on a one-byte read.
const fn park(cmd: &mut PtyCmd, at_read: bool) -> Need {
	let part = cmd.parts;
	cmd.parts = cmd.parts.wrapping_add(1);
	cmd.wait = Some(Parked { part, at_read });
	Need::Probe(probe(cmd.fd, part))
}

/// The command finished: close the master here (zsh `zclose`) and
/// collect the subshell's status when this vproc started it.
fn finish(ctx: &mut Ctx<'_, '_>, cmd: &mut PtyCmd) {
	cmd.fin = true;
	cmd.hold = Ctty(None);
	ctx.vp.fds.set(cmd.fd, None);
	if cmd.owner == ctx.vp.vpid {
		let _ = ctx.k.proc_collect(ctx.cx.store, cmd.vpid);
	}
}

/// zsh `checkptycmd`: unless a byte is already read ahead, read one; when
/// nothing comes and the command no longer runs, it is finished. A
/// blocking pty waits for the byte (`Err`: park).
fn check(ctx: &mut Ctx<'_, '_>, cmd: &mut PtyCmd) -> Result<(), Park> {
	if cmd.read.is_some() || cmd.fin {
		return Ok(());
	}
	match next_byte(ctx, cmd) {
		Rd::Byte(c) => cmd.read = Some(c),
		Rd::Again if !cmd.nblock && alive(ctx, cmd.vpid) => return Err(Park { at_read: false }),
		Rd::Again | Rd::Eof | Rd::Err => {
			if !alive(ctx, cmd.vpid) {
				finish(ctx, cmd);
			}
		},
	}
	Ok(())
}

/// Collect the statuses of deleted commands' subshells that exited.
fn reap(ctx: &mut Ctx<'_, '_>) {
	let Some(t) = table(ctx.vp) else {
		return;
	};
	if t.reap.is_empty() {
		return;
	}
	let mut pending = t.reap.clone();
	pending.retain(|&v| ctx.k.proc_collect(ctx.cx.store, v).is_none());
	table_mut(ctx.vp).reap = pending;
}

/// zsh `deleteptycmd`: forget command `i`, close its master and send
/// `SIGHUP` to its subshell and everything it started.
fn delete(ctx: &mut Ctx<'_, '_>, i: usize) {
	let cmd = table_mut(ctx.vp).cmds.remove(i);
	if !cmd.fin {
		ctx.vp.fds.set(cmd.fd, None);
	}
	ControlHandle(ctx.k.ctl.clone()).signal(SigTarget::Tree(cmd.vpid), Signal::Hup);
	if cmd.owner == ctx.vp.vpid && !cmd.fin && ctx.k.proc_collect(ctx.cx.store, cmd.vpid).is_none() {
		table_mut(ctx.vp).reap.push(cmd.vpid);
	}
}

/// zsh `deleteallptycmds` (`zpty -d` without names, the module's
/// cleanup).
pub fn delete_all(ctx: &mut Ctx<'_, '_>) {
	while table(ctx.vp).is_some_and(|t| !t.cmds.is_empty()) {
		delete(ctx, 0);
	}
}

/// zsh `bin_zpty`.
pub fn zpty(ctx: &mut Ctx<'_, '_>, ops: &Ops, args: &[BString]) -> R {
	let o = |c| ops.isset(c);
	if (o(b'r') && o(b'w'))
		|| ((o(b'r') || o(b'w')) && (o(b'd') || o(b'e') || o(b'b') || o(b'L')))
		|| (o(b'w') && (o(b't') || o(b'm')))
		|| (o(b'n') && (o(b'b') || o(b'e') || o(b'r') || o(b't') || o(b'd') || o(b'L') || o(b'm')))
		|| (o(b'd') && (o(b'b') || o(b'e') || o(b'L') || o(b't') || o(b'm')))
		|| (o(b'L') && (o(b'b') || o(b'e') || o(b'm')))
	{
		ctx.usage("illegal option combination");
		return done(1);
	}
	reap(ctx);
	if o(b'r') || o(b'w') {
		let Some(name) = args.first() else {
			ctx.usage("missing pty command name");
			return done(1);
		};
		let Some(i) = find(ctx.vp, name) else {
			ctx.usage(format!("no such pty command: {name}"));
			return done(1);
		};
		let mut cmd = table_mut(ctx.vp).cmds[i].clone();
		let r = if cmd.fin {
			done(2)
		} else if o(b'r') {
			ptyread(ctx, &mut cmd, &args[1..], o(b't'), o(b'm'))
		} else {
			// A read parked by an earlier, abandoned command waits no more.
			cmd.wait = None;
			cmd.progress = None;
			ptywrite(ctx, &cmd, &args[1..], o(b'n'))
		};
		store(ctx, i, cmd);
		return r;
	}
	if o(b'd') {
		if args.is_empty() {
			delete_all(ctx);
			return done(0);
		}
		let mut ret = 0;
		for name in args {
			if let Some(i) = find(ctx.vp, name) {
				delete(ctx, i);
			} else {
				ctx.usage(format!("no such pty command: {name}"));
				ret = 1;
			}
		}
		return done(ret);
	}
	if o(b't') {
		let Some(name) = args.first() else {
			ctx.usage("missing pty command name");
			return done(1);
		};
		let Some(i) = find(ctx.vp, name) else {
			ctx.usage(format!("no such pty command: {name}"));
			return done(1);
		};
		let mut cmd = table_mut(ctx.vp).cmds[i].clone();
		let r = settle(ctx, &mut cmd).map(|()| check(ctx, &mut cmd));
		let r = match r {
			Ok(Ok(())) => done(i32::from(cmd.fin)),
			Ok(Err(p)) => Err(park(&mut cmd, p.at_read)),
			Err(need) => Err(need),
		};
		store(ctx, i, cmd);
		return r;
	}
	if let Some((name, rest)) = args.split_first() {
		if rest.is_empty() {
			ctx.usage("missing command");
			return done(1);
		}
		if find(ctx.vp, name).is_some() {
			ctx.usage(format!("pty command name already used: {name}"));
			return done(1);
		}
		return newptycmd(ctx, name, rest, o(b'e'), o(b'b'));
	}
	list(ctx, o(b'L'))
}

/// Put command `i` back after working on a copy.
fn store(ctx: &mut Ctx<'_, '_>, i: usize, cmd: PtyCmd) {
	if let Some(slot) = table_mut(ctx.vp).cmds.get_mut(i) {
		*slot = cmd;
	}
}

/// `zpty` / `zpty -L`: list the commands (each checked first, as zsh does).
fn list(ctx: &mut Ctx<'_, '_>, calls: bool) -> R {
	let cs = charset(ctx)?;
	let rcquotes = ctx.zsh_option(ZshOpt::Rcquotes)?;
	let n = table(ctx.vp).map_or(0, |t| t.cmds.len());
	let mut out = Vec::new();
	for i in 0..n {
		let mut cmd = table_mut(ctx.vp).cmds[i].clone();
		let checked = settle(ctx, &mut cmd).map(|()| check(ctx, &mut cmd));
		match checked {
			Ok(Ok(())) => {},
			Ok(Err(p)) => {
				let need = park(&mut cmd, p.at_read);
				store(ctx, i, cmd);
				return Err(need);
			},
			Err(need) => {
				store(ctx, i, cmd);
				return Err(need);
			},
		}
		if calls {
			out.extend_from_slice(ctx.name.as_bytes());
			out.push(b' ');
			if cmd.echo {
				out.extend_from_slice(b"-e ");
			}
			if cmd.nblock {
				out.extend_from_slice(b"-b ");
			}
			out.extend_from_slice(&cmd.name);
			out.push(b' ');
		} else if cmd.fin {
			out.extend_from_slice(b"(finished) ");
			out.extend_from_slice(&cmd.name);
			out.extend_from_slice(b": ");
		} else {
			out.extend_from_slice(format!("({}) ", cmd.vpid.0).as_bytes());
			out.extend_from_slice(&cmd.name);
			out.extend_from_slice(b": ");
		}
		for (k, a) in cmd.args.iter().enumerate() {
			if k > 0 {
				out.push(b' ');
			}
			out.extend_from_slice(&quotedzputs(a, rcquotes, cs));
		}
		out.push(b'\n');
		store(ctx, i, cmd);
	}
	ctx.out(&out);
	done(0)
}

/// zsh `newptycmd`: parse the command, open a pty and start the command
/// in a subshell on its slave; `$REPLY` names the master's fd.
fn newptycmd(
	ctx: &mut Ctx<'_, '_>,
	name: &BString,
	args: &[BString],
	echo: bool,
	nblock: bool,
) -> R {
	let src = bstr::join(b" ", args);
	// zsh `bin_eval`'s convention: the text numbers its own lines, under
	// the name `(zpty)`, unless `evallineno` is off.
	let evallineno = ctx.zsh_option(ZshOpt::Evallineno)?;
	if let Some(e) = parse_error(ctx, &src)? {
		let msg = BString::from(e.bash_msg());
		if evallineno {
			// `e.line` is the script line (the text parses from the command's
			// line); zsh's line counts from the current site's base.
			let base = ctx.k.zsh_site_base(ctx.cx.store, ctx.vp).1;
			let line = e.line.saturating_sub(base);
			ctx.out_fd(2, format!("(zpty):{line}: {msg}\n").as_bytes());
		} else {
			ctx.diag(Diag::Syntax { msg });
		}
		return done(1);
	}
	let interactive = ctx.zsh_option(ZshOpt::Interactive)?;
	// zsh sets an interactive shell's window size on the pty
	// (`zterm_lines`, `zterm_columns`).
	let size = if interactive {
		let lines = ctx
			.scalar(b"LINES")?
			.and_then(|v| parse_u16(&v))
			.unwrap_or(24);
		let cols = ctx
			.scalar(b"COLUMNS")?
			.and_then(|v| parse_u16(&v))
			.unwrap_or(80);
		Some(TtyInfo { rows: lines, cols })
	} else {
		None
	};
	let opened = match ctx.cx.host.terminal() {
		Some(term) => term.open_pty(size),
		None => Err(io::Error::from(io::ErrorKind::Unsupported)),
	};
	let pty = match opened {
		Ok(pty) => pty,
		Err(e) => {
			ctx.usage(format!("can't open pseudo terminal: {}", zsh_errmsg(&e)));
			return done(1);
		},
	};
	if !echo
		&& let (Some(term), Some(h)) = (ctx.cx.host.terminal(), pty.slave.os_handle())
		&& let Ok(mut modes) = term.attrs(h)
	{
		modes.set(TermFlag::Echo, false);
		let _ = term.set_attrs(h, &modes, SetWhen::Drain);
	}
	let master = FdRef::from_file(pty.master);
	// zsh's `movefd` makes the master an internal fd: externals do not
	// inherit it.
	master.set_flags(FdFlags::CLOEXEC);
	let slave = FdRef::from_file(pty.slave);
	let hold = slave.clone();
	// The subshell: fds 0–2 on the slave, no other command's master.
	let mut fds = ctx.vp.fds.clone();
	if let Some(t) = table(ctx.vp) {
		for p in &t.cmds {
			fds.set(p.fd, None);
		}
	}
	for fd in 0..3 {
		fds.set(fd, Some(slave.clone()));
	}
	// zsh's `lineno` runs on from the `zpty` command's line into the text.
	let mut child = ctx.vp.child_text(ctx.k, ctx.cx.store, &src, ctx.line, fds);
	// zsh's zpty child is not a subshell level of its own.
	set_subshell_depth(&mut child, subshell_depth(ctx.vp));
	{
		let z = child.zsh.get_or_insert_with(Box::default);
		z.ptys = PtyTable::default();
		if evallineno {
			let base = z.site.as_ref().map_or(0, |s| s.1);
			z.site = Some((BString::from("(zpty)"), base));
		}
		z.first_context = Some(BString::from("zpty"));
		z.ctty = Ctty(Some(slave));
	}
	state::store_var(
		&mut ctx.k.root,
		ctx.cx.store,
		&mut child,
		b"TTY",
		Some(state::Var::scalar(pty.name, Attrs::NONE)),
		state::Level::Dynamic,
	);
	state::set_zsh_option(&mut ctx.k.root, ctx.cx.store, &mut child, ZshOpt::Interactive, false)?;
	let vpid = child.vpid;
	ctx.k
		.emit_op(ctx.cx, ctx.vp, 0, EventData::Subshell { child: vpid });
	ctx.k.spawned.push(Box::new(child));
	let fd = ctx.vp.fds.lowest_free(10);
	ctx.vp.fds.set(fd, Some(master));
	let owner = ctx.vp.vpid;
	table_mut(ctx.vp).cmds.insert(0, PtyCmd {
		name: name.clone(),
		args: args.to_vec(),
		fd,
		vpid,
		owner,
		echo,
		nblock,
		fin: false,
		read: None,
		old: Vec::new(),
		wait: None,
		eof: false,
		progress: None,
		parts: 0,
		hold: Ctty(Some(hold)),
	});
	let reply = fd.to_string();
	match zx(ctx, |ex| params::assignsparam(ex, b"REPLY", reply.as_bytes(), 0))? {
		Ok(()) => done(0),
		Err(d) => zerr(ctx, d),
	}
}

/// A decimal `u16` (`$LINES`, `$COLUMNS`).
fn parse_u16(v: &[u8]) -> Option<u16> {
	std::str::from_utf8(v)
		.ok()?
		.trim()
		.parse()
		.ok()
		.filter(|&n| n > 0)
}

/// zsh `parse_string` of the command text: the first syntax error, if
/// any.
fn parse_error(ctx: &mut Ctx<'_, '_>, src: &[u8]) -> Result<Option<ParseError>, Need> {
	let feat = exec::features(ctx.k, ctx.cx.store, ctx.vp)?;
	let aliases = super::alias_table(ctx.k, ctx.cx, ctx.vp)?;
	let pos = Pos { offset: 0, line: ctx.line };
	let mut parser = match &aliases {
		Some(a) => Parser::new(src, feat, a),
		None => Parser::new(src, feat, NO_ALIASES),
	}
	.with_pos(pos);
	while let Some(r) = parser.next_command() {
		if let Err(e) = r {
			return Ok(Some(e));
		}
	}
	Ok(None)
}

/// zsh `ptywrite`: the strings, separated by spaces, with a newline
/// unless `-n`; without strings, standard input to its end. zsh's
/// `ptywritestr` fails on an empty string (it wrote nothing): the write
/// stops there with status 1.
fn ptywrite(ctx: &mut Ctx<'_, '_>, cmd: &PtyCmd, args: &[BString], nonl: bool) -> R {
	if args.is_empty() {
		let input = Probe::Input {
			fd:         0,
			delim:      None,
			lines:      1,
			nchars:     None,
			part:       0,
			timeout_ns: None,
		};
		if let ProbeResult::Input { data, .. } = ctx.probe(input)? {
			ctx.out_fd(cmd.fd, &data);
		}
		return done(0);
	}
	let mut out = Vec::new();
	let mut status = 0;
	for (k, a) in args.iter().enumerate() {
		if a.is_empty() {
			status = i32::from(cmd.fin) + 1;
			break;
		}
		out.extend_from_slice(a);
		if k + 1 < args.len() {
			out.push(b' ');
		}
	}
	if status == 0 && !nonl {
		out.push(b'\n');
	}
	ctx.out_fd(cmd.fd, &out);
	done(status)
}

/// zsh `ptyread`: read the command's output into `args[0]` (a line, or
/// up to a match of the pattern `args[1]`), or to standard output.
fn ptyread(
	ctx: &mut Ctx<'_, '_>,
	cmd: &mut PtyCmd,
	args: &[BString],
	noblock: bool,
	mustmatch: bool,
) -> R {
	let mut prog: Option<ZPat> = None;
	if args.len() >= 2 {
		if args.len() > 2 {
			ctx.usage("too many arguments");
			return done(1);
		}
		match pattern_arg(ctx, &args[1])? {
			Some(p) => prog = Some(p),
			None => return done(1),
		}
	}
	// A loop that parked in its own read resumes there: the answer is that
	// read's result (end of input included), not `checkptycmd`'s.
	let resume_at_read = cmd.progress.is_some() && cmd.wait.is_some_and(|w| w.at_read);
	settle(ctx, cmd)?;
	let mut p = if let Some(p) = cmd.progress.take() {
		p
	} else {
		let mut p = Progress::new();
		if !cmd.old.is_empty() {
			p.buf = std::mem::take(&mut cmd.old);
			p.used = p.buf.iter().map(|&c| if imeta(c) { 2 } else { 1 }).sum();
			p.blen = 256 + p.used;
		}
		if let Some(c) = cmd.read.take() {
			// zsh stores the byte at the end but then counts one byte:
			// what was kept from before is cut to its first byte.
			if p.buf.is_empty() {
				p.buf.push(c);
			} else {
				p.buf.truncate(1);
			}
			p.used = 1;
			p.seen = true;
		}
		p
	};
	let matchok = match p.matched {
		Some(m) => m,
		None => match read_loop(ctx, cmd, &mut p, args, prog.as_ref(), noblock, resume_at_read) {
			Ok(m) => m,
			Err(park_at) => {
				let need = park(cmd, park_at.at_read);
				cmd.progress = Some(p);
				return Err(need);
			},
		},
	};
	if prog.is_some() && p.ret < 0 && p.again {
		cmd.old = std::mem::take(&mut p.buf);
		return done(1);
	}
	let ret = if p.seen && (prog.is_none() || matchok || !mustmatch) {
		0
	} else {
		i32::from(cmd.fin) + 1
	};
	if let Some(param) = args.first() {
		// Kept until stored: a parameter assignment that must run a
		// substitution first re-runs the builtin.
		p.matched = Some(matchok);
		let buf = p.buf.clone();
		cmd.progress = Some(p);
		match zx(ctx, |ex| params::assignsparam(ex, param, &buf, 0))? {
			Ok(()) => {},
			Err(d) => {
				cmd.progress = None;
				return zerr(ctx, d);
			},
		}
		cmd.progress = None;
	} else {
		let mut out = std::mem::take(&mut p.out);
		out.extend_from_slice(&p.buf);
		ctx.out(&out);
	}
	done(ret)
}

/// The read loop of zsh `ptyread`; `Ok` is zsh's `matchok`, `Err` a park.
fn read_loop(
	ctx: &mut Ctx<'_, '_>,
	cmd: &mut PtyCmd,
	p: &mut Progress,
	args: &[BString],
	prog: Option<&ZPat>,
	noblock: bool,
	resume_at_read: bool,
) -> Result<bool, Park> {
	let mut skip_checks = resume_at_read;
	loop {
		if !std::mem::take(&mut skip_checks) {
			if noblock && cmd.read.is_none() && !cmd.eof && !ready(ctx, cmd.fd) && alive(ctx, cmd.vpid)
			{
				return Ok(false);
			}
			if p.ret == 0 {
				check(ctx, cmd)?;
				if cmd.fin {
					return Ok(false);
				}
			}
		}
		let got = match cmd.read.take() {
			Some(c) => Some(c),
			None => match next_byte(ctx, cmd) {
				Rd::Byte(c) => Some(c),
				Rd::Eof => {
					p.ret = 0;
					None
				},
				Rd::Err => {
					p.ret = -1;
					p.again = false;
					None
				},
				// The command ended and its output is drained: end of input.
				Rd::Again if !alive(ctx, cmd.vpid) => {
					cmd.hold = Ctty(None);
					p.ret = 0;
					None
				},
				// A blocking pty waits; so does a non-blocking one read up to a
				// pattern (zsh loops on `EAGAIN`) unless `-t` polls.
				Rd::Again if !cmd.nblock || (prog.is_some() && !noblock) => {
					return Err(Park { at_read: true });
				},
				Rd::Again => {
					p.ret = -1;
					p.again = true;
					None
				},
			},
		};
		if let Some(c) = got {
			p.ret = 1;
			p.zeros = 0;
			p.used += if imeta(c) { 2 } else { 1 };
			p.buf.push(c);
			p.seen = true;
			if p.used >= p.blen - 1 {
				if args.is_empty() {
					p.out.append(&mut p.buf);
					p.used = 0;
				} else {
					p.blen <<= 1;
				}
			}
		}
		if prog.is_none() {
			if p.ret <= 0 || (!args.is_empty() && p.buf.last() == Some(&b'\n')) {
				return Ok(false);
			}
		} else {
			if p.ret < 0 && !p.again {
				return Ok(false);
			}
			if p.ret == 0 {
				// zsh spins on a pty that reads end of input while its
				// command lives; the engine must not.
				p.zeros += 1;
				if p.zeros > 1 {
					return Ok(false);
				}
			}
		}
		if p.used >= READ_MAX {
			return Ok(false);
		}
		if let Some(pat) = prog
			&& p.ret != 0
			&& pat.matches(&p.buf)
		{
			return Ok(true);
		}
	}
}
