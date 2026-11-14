//! zsh/curses: the `zcurses` builtin and the `zcurses_*` parameters.
//!
//! zsh drives ncurses; here [`screen`] is the window model and the update
//! that writes the screen with the terminal's terminfo capabilities
//! (`$TERM`, read through [`terminfo_db`]). The state lives in the vproc
//! ([`crate::bash::vm::proc::VprocZsh::curses`]); a subshell starts with
//! a copy, as a zsh fork has its own copy of ncurses' state. Output goes
//! to fd 1 and is written when curses would flush it (a refresh, `end`,
//! before `input` reads); input is read from fd 0 through input probes
//! (the builtin parks while it waits).
//!
//! Mouse reports are ncurses' xterm ones (`kmous`, X10 encoding), keys
//! include the entry's user-defined ones (`kUP5`, …). zsh installs its own
//! `SIGWINCH` handler, so ncurses never reports a resize to it (no
//! `RESIZE` key): neither does this.
//!
//! Ported from zsh 5.9 `Src/Modules/curses.c` (MIT-style licence,
//! Copyright (c) 2007 Clint Adams and the zsh development group).

pub mod screen;

use std::{
	sync::Arc,
	task::{Context, Poll},
};

use bstr::{BString, ByteSlice};

use self::screen::{A_BLINK, A_BOLD, A_DIM, A_REVERSE, A_STANDOUT, A_UNDERLINE, Caps, Curses};
use super::{Control, Ctx, Need, Outcome, R, done, zsh_args::zx};
use crate::bash::{
	FdRef, OsHandle, SetWhen, TermFlag, Termios,
	event::WaitKey,
	vm::{
		expand::Expander,
		proc::{Probe, ProbeResult, Vproc},
		zsh::{
			params::{self, PValue},
			terminfo_db::{self, TermEnv, TermInfo},
		},
	},
};

/// A parameter of zsh/curses.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum CursesParam {
	/// `zcurses_colors`.
	Colors,
	/// `zcurses_attrs`.
	Attrs,
	/// `zcurses_keycodes`.
	Keycodes,
	/// `zcurses_windows`.
	Windows,
	/// `ZCURSES_COLORS`.
	ColorCount,
	/// `ZCURSES_COLOR_PAIRS`.
	PairCount,
}

impl CursesParam {
	/// The parameter named `name`.
	pub const fn lookup(name: &[u8]) -> Option<Self> {
		Some(match name {
			b"zcurses_colors" => Self::Colors,
			b"zcurses_attrs" => Self::Attrs,
			b"zcurses_keycodes" => Self::Keycodes,
			b"zcurses_windows" => Self::Windows,
			b"ZCURSES_COLORS" => Self::ColorCount,
			b"ZCURSES_COLOR_PAIRS" => Self::PairCount,
			_ => return None,
		})
	}

	/// Whether it is an integer (else an array).
	pub const fn integer(self) -> bool {
		matches!(self, Self::ColorCount | Self::PairCount)
	}
}

/// zsh `zcurses_attributes`.
const ATTRS: [(&str, u16); 6] = [
	("blink", A_BLINK),
	("bold", A_BOLD),
	("dim", A_DIM),
	("reverse", A_REVERSE),
	("standout", A_STANDOUT),
	("underline", A_UNDERLINE),
];

/// zsh `zcurses_colors` (`default` with ncurses' `use_default_colors`).
const COLORS: [(&str, i16); 9] = [
	("black", 0),
	("red", 1),
	("green", 2),
	("yellow", 3),
	("blue", 4),
	("magenta", 5),
	("cyan", 6),
	("white", 7),
	("default", -1),
];

/// zsh's `keypad_names` (generated from ncurses' `KEY_*` macros, in their
/// order) and the terminfo capability each key sends, if it has one.
const KEYS: [(&str, Option<&str>); 92] = [
	("BREAK", None),
	("SRESET", None),
	("RESET", None),
	("DOWN", Some("kcud1")),
	("UP", Some("kcuu1")),
	("LEFT", Some("kcub1")),
	("RIGHT", Some("kcuf1")),
	("HOME", Some("khome")),
	("BACKSPACE", Some("kbs")),
	("F0", Some("kf0")),
	("DL", Some("kdl1")),
	("IL", Some("kil1")),
	("DC", Some("kdch1")),
	("IC", Some("kich1")),
	("EIC", Some("krmir")),
	("CLEAR", Some("kclr")),
	("EOS", Some("ked")),
	("EOL", Some("kel")),
	("SF", Some("kind")),
	("SR", Some("kri")),
	("NPAGE", Some("knp")),
	("PPAGE", Some("kpp")),
	("STAB", Some("khts")),
	("CTAB", Some("kctab")),
	("CATAB", Some("ktbc")),
	("ENTER", Some("kent")),
	("PRINT", Some("kprt")),
	("LL", Some("kll")),
	("A1", Some("ka1")),
	("A3", Some("ka3")),
	("B2", Some("kb2")),
	("C1", Some("kc1")),
	("C3", Some("kc3")),
	("BTAB", Some("kcbt")),
	("BEG", Some("kbeg")),
	("CANCEL", Some("kcan")),
	("CLOSE", Some("kclo")),
	("COMMAND", Some("kcmd")),
	("COPY", Some("kcpy")),
	("CREATE", Some("kcrt")),
	("END", Some("kend")),
	("EXIT", Some("kext")),
	("FIND", Some("kfnd")),
	("HELP", Some("khlp")),
	("MARK", Some("kmrk")),
	("MESSAGE", Some("kmsg")),
	("MOVE", Some("kmov")),
	("NEXT", Some("knxt")),
	("OPEN", Some("kopn")),
	("OPTIONS", Some("kopt")),
	("PREVIOUS", Some("kprv")),
	("REDO", Some("krdo")),
	("REFERENCE", Some("kref")),
	("REFRESH", Some("krfr")),
	("REPLACE", Some("krpl")),
	("RESTART", Some("krst")),
	("RESUME", Some("kres")),
	("SAVE", Some("ksav")),
	("SBEG", Some("kBEG")),
	("SCANCEL", Some("kCAN")),
	("SCOMMAND", Some("kCMD")),
	("SCOPY", Some("kCPY")),
	("SCREATE", Some("kCRT")),
	("SDC", Some("kDC")),
	("SDL", Some("kDL")),
	("SELECT", Some("kslt")),
	("SEND", Some("kEND")),
	("SEOL", Some("kEOL")),
	("SEXIT", Some("kEXT")),
	("SFIND", Some("kFND")),
	("SHELP", Some("kHLP")),
	("SHOME", Some("kHOM")),
	("SIC", Some("kIC")),
	("SLEFT", Some("kLFT")),
	("SMESSAGE", Some("kMSG")),
	("SMOVE", Some("kMOV")),
	("SNEXT", Some("kNXT")),
	("SOPTIONS", Some("kOPT")),
	("SPREVIOUS", Some("kPRV")),
	("SPRINT", Some("kPRT")),
	("SREDO", Some("kRDO")),
	("SREPLACE", Some("kRPL")),
	("SRIGHT", Some("kRIT")),
	("SRSUME", Some("kRES")),
	("SSAVE", Some("kSAV")),
	("SSUSPEND", Some("kSPD")),
	("SUNDO", Some("kUND")),
	("SUSPEND", Some("kspd")),
	("UNDO", Some("kund")),
	("MOUSE", Some("kmous")),
	("RESIZE", None),
	("EVENT", None),
];

/// zsh `zcurses_strerror` codes.
#[derive(Clone, Copy)]
enum ZcErr {
	Invalid,
	Defined,
	Undefined,
}

impl ZcErr {
	const fn text(self) -> &'static str {
		match self {
			Self::Invalid => "window name invalid",
			Self::Defined => "window already defined",
			Self::Undefined => "window undefined",
		}
	}
}

/// The value of a zsh/curses parameter.
pub fn param_get(ex: &Expander<'_, '_>, p: CursesParam) -> PValue {
	let names = |list: &[&str]| PValue::Array(list.iter().map(|n| BString::from(*n)).collect());
	let c = ex.vp.zsh.as_deref().and_then(|z| z.curses.as_deref());
	match p {
		CursesParam::Colors => names(&COLORS.map(|c| c.0)),
		CursesParam::Attrs => names(&ATTRS.map(|a| a.0)),
		CursesParam::Keycodes => names(&KEYS.map(|k| k.0)),
		CursesParam::Windows => {
			PValue::Array(c.map_or_else(Vec::new, |c| c.wins.iter().map(|w| w.name.clone()).collect()))
		},
		CursesParam::ColorCount => {
			PValue::Scalar(BString::from(c.map_or(0, |c| c.colors).to_string()))
		},
		CursesParam::PairCount => {
			PValue::Scalar(BString::from(c.map_or(0, |c| c.color_pairs).to_string()))
		},
	}
}

/// The module's state, taken out of the vproc while a subcommand works.
fn take(vp: &mut Vproc) -> Option<Box<Curses>> {
	vp.zsh.as_mut().and_then(|z| z.curses.take())
}

fn put(vp: &mut Vproc, c: Box<Curses>) {
	vp.zsh.get_or_insert_with(Box::default).curses = Some(c);
}

/// C `atoi`.
fn atoi(s: &[u8]) -> i32 {
	let s = s.trim_start();
	let (neg, digits) = match s.first() {
		Some(b'-') => (true, &s[1..]),
		Some(b'+') => (false, &s[1..]),
		_ => (false, s),
	};
	let n = digits
		.iter()
		.take_while(|c| c.is_ascii_digit())
		.fold(0i64, |n, &c| (n * 10 + i64::from(c - b'0')).min(i64::from(i32::MAX) + 1));
	let n = if neg { -n } else { n };
	n.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32
}

/// zsh `zstrtol(s, &end, 10)` requiring the whole text: `None` when
/// anything follows the number.
fn strtol_whole(s: &[u8]) -> Option<i64> {
	let t = s.trim_start();
	let (neg, digits) = match t.first() {
		Some(b'-') => (true, &t[1..]),
		Some(b'+') => (false, &t[1..]),
		_ => (false, t),
	};
	let end = digits.iter().take_while(|c| c.is_ascii_digit()).count();
	if end != digits.len() {
		return None;
	}
	let n = digits[..end]
		.iter()
		.fold(0i64, |n, &c| n.wrapping_mul(10).wrapping_add(i64::from(c - b'0')));
	Some(if neg { -n } else { n })
}

/// The terminal handle curses sets modes on: fd 1's, else fd 0's.
fn tty_handle(ctx: &mut Ctx<'_, '_>) -> Option<OsHandle> {
	for fd in [1, 0] {
		let h = ctx.vp.fds.get(fd).and_then(FdRef::os_handle);
		if let (Some(h), Some(term)) = (h, ctx.cx.host.terminal())
			&& term.is_terminal(h)
		{
			return Some(h);
		}
	}
	None
}

/// zsh `gettyinfo`.
fn get_tty(ctx: &mut Ctx<'_, '_>) -> Option<Termios> {
	let h = tty_handle(ctx)?;
	ctx.cx.host.terminal()?.attrs(h).ok()
}

/// zsh `settyinfo`.
fn set_tty(ctx: &mut Ctx<'_, '_>, t: &Termios) {
	if let Some(h) = tty_handle(ctx)
		&& let Some(term) = ctx.cx.host.terminal()
	{
		let _ = term.set_attrs(h, t, SetWhen::Drain);
	}
}

/// The terminfo entry for `term`, as ncurses finds it.
fn terminfo(ctx: &mut Ctx<'_, '_>, term: &[u8]) -> Result<Option<Arc<TermInfo>>, Need> {
	let terminfo = ctx.scalar(b"TERMINFO")?;
	let dirs = ctx.scalar(b"TERMINFO_DIRS")?;
	let home = ctx.scalar(b"HOME")?;
	let env = TermEnv {
		terminfo:      terminfo.as_ref().map(|v| v.as_slice()),
		terminfo_dirs: dirs.as_ref().map(|v| v.as_slice()),
		home:          home.as_ref().map(|v| v.as_slice()),
	};
	Ok(terminfo_db::load(term, &env))
}

/// Queue curses' buffered output on stdout.
fn flush(ctx: &mut Ctx<'_, '_>, c: &mut Curses) {
	let out = std::mem::take(&mut c.pending);
	ctx.out(&out);
}

/// Write curses' buffered output now (before `input` waits for a key):
/// parks while the terminal does not take it.
fn flush_now(ctx: &Ctx<'_, '_>, c: &mut Curses) -> Result<(), Need> {
	let h = ctx.vp.fds.handle(1);
	let mut tcx = Context::from_waker(&ctx.k.waker);
	while !c.pending.is_empty() {
		match h.poll_write(&mut tcx, &c.pending) {
			Poll::Ready(Ok(n)) if n > 0 => {
				c.pending = c.pending.split_off(n.min(c.pending.len()));
			},
			// A failed write loses the output, as ncurses' does.
			Poll::Ready(_) => c.pending.clear(),
			Poll::Pending => return Err(Need::Park(WaitKey::Write { fd: 1 })),
		}
	}
	Ok(())
}

/// zsh `bin_zcurses`.
pub fn zcurses(ctx: &mut Ctx<'_, '_>, _ops: &super::zsh_args::Ops, args: &[BString]) -> R {
	// (name, min, max): zsh's subcommand table.
	const SUBS: [(&str, usize, Option<usize>); 20] = [
		("init", 0, Some(0)),
		("addwin", 5, Some(6)),
		("delwin", 1, Some(1)),
		("refresh", 0, None),
		("move", 3, Some(3)),
		("clear", 1, Some(2)),
		("position", 2, Some(2)),
		("char", 2, Some(2)),
		("string", 2, Some(2)),
		("border", 1, Some(1)),
		("end", 0, Some(0)),
		("attr", 2, None),
		("bg", 2, None),
		("scroll", 2, Some(2)),
		("input", 1, Some(4)),
		("timeout", 2, Some(2)),
		("mouse", 0, None),
		("querychar", 1, Some(2)),
		("touch", 1, None),
		("resize", 2, Some(3)),
	];
	let Some((sub, rest)) = args.split_first() else {
		return done(1);
	};
	let Some(&(name, min, max)) = SUBS.iter().find(|s| s.0.as_bytes() == sub.as_slice()) else {
		ctx.usage(format!("unknown subcommand: {sub}"));
		return done(1);
	};
	if rest.len() < min {
		ctx.usage(format!("too few arguments for subcommand: {sub}"));
		return done(1);
	}
	if max.is_some_and(|m| rest.len() > m) {
		ctx.usage(format!("too many arguments for subcommand: {sub}"));
		return done(1);
	}
	let Some(mut c) = take(ctx.vp) else {
		return match name {
			"init" => init(ctx),
			"end" => done(0),
			_ => {
				ctx.usage(format!("command `{name}' can't be used before `zcurses init'"));
				done(1)
			},
		};
	};
	let r = run(ctx, &mut c, name, rest);
	put(ctx.vp, c);
	r
}

/// A subcommand once curses is running.
fn run(ctx: &mut Ctx<'_, '_>, c: &mut Curses, name: &str, args: &[BString]) -> R {
	match name {
		"init" => {
			if let Some(t) = c.prog_tty.clone() {
				set_tty(ctx, &t);
			}
			done(0)
		},
		"end" => end(ctx, c),
		"addwin" => addwin(ctx, c, args),
		"delwin" => delwin(ctx, c, args),
		"refresh" => refresh(ctx, c, args),
		"move" => with_win(ctx, c, &args[0], |_, c, w| {
			done(i32::from(!c.wmove(w, atoi(&args[1]), atoi(&args[2]))))
		}),
		"clear" => with_win(ctx, c, &args[0], |ctx, c, w| {
			match args.get(1).map(|a| a.as_slice()) {
				None => c.werase(w),
				Some(b"redraw") => {
					c.werase(w);
					c.wins[w].clearok = true;
				},
				Some(b"eol") => c.clrtoeol(w),
				Some(b"bot") => c.clrtobot(w),
				Some(_) => {
					ctx.usage("`clear' expects `redraw', `eol' or `bot'");
					return done(1);
				},
			}
			done(0)
		}),
		"position" => position(ctx, c, args),
		"char" => with_win(ctx, c, &args[0], |_, c, w| {
			let Some(ch) = args[1].chars().next().filter(|_| !args[1].is_empty()) else {
				return done(1);
			};
			if ch == '\u{fffd}' && !args[1].starts_with("\u{fffd}".as_bytes()) {
				return done(1);
			}
			done(i32::from(!c.addch(w, ch, 0)))
		}),
		"string" => with_win(ctx, c, &args[0], |_, c, w| {
			let s = &args[1];
			let mut text = String::with_capacity(s.len());
			for (start, end, ch) in s.char_indices() {
				// zsh skips what does not decode (`WEOF`).
				if ch == '\u{fffd}' && &s.as_slice()[start..end] != "\u{fffd}".as_bytes() {
					continue;
				}
				text.push(ch);
			}
			done(i32::from(!c.addstr(w, &text)))
		}),
		"border" => with_win(ctx, c, &args[0], |_, c, w| {
			c.border(w);
			done(0)
		}),
		"attr" => attr(ctx, c, args, false),
		"bg" => attr(ctx, c, args, true),
		"scroll" => scroll(ctx, c, args),
		"input" => input(ctx, c, args),
		"timeout" => with_win(ctx, c, &args[0], |ctx, c, w| {
			let Some(to) = strtol_whole(&args[1]) else {
				ctx.usage(format!("timeout requires an integer: {}", args[1]));
				return done(1);
			};
			c.wins[w].timeout = to as i32;
			done(0)
		}),
		"mouse" => mouse_cmd(ctx, c, args),
		"querychar" => querychar(ctx, c, args),
		"touch" => {
			for a in args {
				let Some(w) = window(ctx, c, a) else {
					return done(1);
				};
				c.touchwin(w);
			}
			done(0)
		},
		"resize" => resize(ctx, c, args),
		_ => done(1),
	}
}

/// zsh `zcurses_validate_window(name, ZCURSES_USED)` with its warning.
fn window(ctx: &mut Ctx<'_, '_>, c: &Curses, name: &[u8]) -> Option<usize> {
	let err = if name.is_empty() {
		ZcErr::Invalid
	} else if let Some(w) = c.find(name) {
		return Some(w);
	} else {
		ZcErr::Undefined
	};
	ctx.usage(format!("{}: {}", err.text(), name.as_bstr()));
	None
}

/// Run `f` on the window named `name` (a warning and status 1 when there
/// is none).
fn with_win(
	ctx: &mut Ctx<'_, '_>,
	c: &mut Curses,
	name: &[u8],
	f: impl FnOnce(&mut Ctx<'_, '_>, &mut Curses, usize) -> R,
) -> R {
	match window(ctx, c, name) {
		Some(w) => f(ctx, c, w),
		None => done(1),
	}
}

/// zsh `zccmd_init` on a shell that never ran curses: ncurses `initscr`
/// (an unknown terminal ends the shell, as ncurses does), colors, `cbreak`
/// and `noecho`.
fn init(ctx: &mut Ctx<'_, '_>) -> R {
	let term = ctx
		.scalar(b"TERM")?
		.filter(|t| !t.is_empty())
		.unwrap_or_else(|| "unknown".into());
	let Some(ti) = terminfo(ctx, &term)? else {
		ctx.out_fd(2, format!("Error opening terminal: {term}.\n").as_bytes());
		return Ok(Outcome { status: 1, control: Control::Exit });
	};
	let saved = get_tty(ctx);
	let size = tty_handle(ctx).and_then(|h| ctx.cx.host.terminal()?.size(h).ok());
	let (lines, cols) = match size {
		Some(s) if s.rows > 0 && s.cols > 0 => (i32::from(s.rows), i32::from(s.cols)),
		_ => (ti.num("lines").unwrap_or(24), ti.num("cols").unwrap_or(80)),
	};
	let mut c = Box::new(Curses::new(term, lines, cols));
	// ncurses `start_color`: the terminal has colors and can set them.
	let colors = ti.num("colors").unwrap_or(0);
	if colors > 0 && (ti.str("setaf").is_some() || ti.str("setf").is_some()) {
		c.color = true;
		c.colors = colors.min(32767);
		c.color_pairs = ti.num("pairs").unwrap_or(0).min(32767);
		if c.color_phase == 0 {
			c.color_phase = 1;
		}
		c.pair_names.push((BString::from("default/default"), 0));
	}
	c.start(&Caps::new(&ti));
	// ncurses' program mode (`initscr`: no echo, no CR/NL mapping) with
	// `cbreak`.
	if let Some(t) = &saved {
		let mut prog = t.clone();
		for f in [TermFlag::Echo, TermFlag::Echonl, TermFlag::Icrnl, TermFlag::Inlcr, TermFlag::Igncr]
		{
			prog.set(f, false);
		}
		prog.set(TermFlag::Onlcr, false);
		prog.set(TermFlag::Icanon, false);
		prog.set(TermFlag::Isig, true);
		prog.min = 1;
		prog.time = 0;
		set_tty(ctx, &prog);
		c.prog_tty = get_tty(ctx).or(Some(prog));
	}
	c.saved_tty = saved;
	put(ctx.vp, c);
	done(0)
}

/// The terminfo capabilities of the running curses' terminal.
fn caps_of(ctx: &mut Ctx<'_, '_>, c: &Curses) -> Result<Option<Arc<TermInfo>>, Need> {
	terminfo(ctx, &c.term)
}

/// zsh `zccmd_endwin`: ncurses `endwin`, then the modes from before
/// `init`.
fn end(ctx: &mut Ctx<'_, '_>, c: &mut Curses) -> R {
	if let Some(ti) = caps_of(ctx, c)? {
		c.endwin(&Caps::new(&ti));
	}
	flush(ctx, c);
	if let Some(t) = c.saved_tty.clone() {
		set_tty(ctx, &t);
	}
	done(0)
}

/// ncurses `doupdate`, re-entering curses mode after `end`.
fn update(ctx: &mut Ctx<'_, '_>, c: &mut Curses) -> Result<(), Need> {
	if c.ended
		&& let Some(t) = c.prog_tty.clone()
	{
		set_tty(ctx, &t);
	}
	if let Some(ti) = caps_of(ctx, c)? {
		c.doupdate(&Caps::new(&ti));
	}
	Ok(())
}

/// zsh `zccmd_refresh`.
fn refresh(ctx: &mut Ctx<'_, '_>, c: &mut Curses, args: &[BString]) -> R {
	if args.is_empty() {
		let w = c.find(b"stdscr").unwrap_or(0);
		c.noutrefresh(w);
	} else {
		for a in args {
			let Some(w) = window(ctx, c, a) else {
				return done(1);
			};
			if let Some(p) = c.wins[w].parent.clone().and_then(|p| c.find(&p)) {
				// "This is what the manual says you have to do."
				c.touchwin(p);
			}
			c.noutrefresh(w);
		}
	}
	update(ctx, c)?;
	flush(ctx, c);
	done(0)
}

/// zsh `zccmd_addwin`.
fn addwin(ctx: &mut Ctx<'_, '_>, c: &mut Curses, args: &[BString]) -> R {
	let name = &args[0];
	let err = if name.is_empty() {
		Some(ZcErr::Invalid)
	} else if c.find(name).is_some() {
		Some(ZcErr::Defined)
	} else {
		None
	};
	if let Some(e) = err {
		// zsh `zerrnam`: the rest of the command line is abandoned.
		ctx.usage(format!("{}: {name}", e.text()));
		return Ok(Outcome { status: 1, control: Control::DiscardAll });
	}
	let (nl, nc, by, bx) = (atoi(&args[1]), atoi(&args[2]), atoi(&args[3]), atoi(&args[4]));
	let made = if let Some(parent) = args.get(5) {
		let Some(p) = c.find(parent).filter(|_| !parent.is_empty()) else {
			let e = if parent.is_empty() {
				ZcErr::Invalid
			} else {
				ZcErr::Undefined
			};
			// zsh names the new window here, not the parent.
			ctx.usage(format!("{}: {name}", e.text()));
			return done(1);
		};
		c.subwin(name.clone(), p, nl, nc, by, bx)
	} else {
		c.newwin(name.clone(), nl, nc, by, bx)
	};
	if made.is_none() {
		ctx.usage(format!("failed to create window `{name}'"));
		return done(1);
	}
	done(0)
}

/// zsh `zccmd_delwin`.
fn delwin(ctx: &mut Ctx<'_, '_>, c: &mut Curses, args: &[BString]) -> R {
	let Some(w) = window(ctx, c, &args[0]) else {
		return done(1);
	};
	if c.wins[w].permanent {
		ctx.usage(format!("window `{}' can't be deleted", args[0]));
		return done(1);
	}
	if !c.wins[w].children.is_empty() {
		ctx.usage(format!("window `{}' has subwindows, delete those first", args[0]));
		return done(1);
	}
	c.delwin(w);
	done(0)
}

/// zsh `zccmd_position`.
fn position(ctx: &mut Ctx<'_, '_>, c: &Curses, args: &[BString]) -> R {
	let Some(w) = window(ctx, c, &args[0]) else {
		return done(1);
	};
	let win = &c.wins[w];
	let vals: Vec<BString> = [win.cury, win.curx, win.begy, win.begx, win.rows, win.cols]
		.iter()
		.map(|n| BString::from(n.to_string()))
		.collect();
	let name = args[1].clone();
	match zx(ctx, |ex| params::assignaparam(ex, &name, vals, 0))? {
		Ok(()) => done(0),
		Err(d) => super::zsh_args::zerr(ctx, d),
	}
}

/// zsh `zcurses_colorget`: the pair for `fg/bg`, made (`init_pair`) when
/// new; `None` when it cannot be (warnings for unknown colors).
fn colorget(ctx: &mut Ctx<'_, '_>, c: &mut Curses, spec: &[u8]) -> Option<i16> {
	if !c.color {
		return None;
	}
	let known = c
		.pair_names
		.iter()
		.find(|(n, _)| n.as_slice() == spec)
		.map(|p| p.1);
	if c.color_phase != 1
		&& let Some(p) = known
	{
		return Some(p);
	}
	c.color_phase = 2;
	let slash = spec.find_byte(b'/')?;
	let (fg, bg) = (&spec[..slash], &spec[slash + 1..]);
	let color = |s: &[u8]| -> i32 {
		if s.first().is_some_and(u8::is_ascii_digit) {
			atoi(s)
		} else {
			COLORS
				.iter()
				.find(|(n, _)| n.as_bytes() == s)
				.map_or(-2, |&(_, v)| i32::from(v))
		}
	};
	let (f, b) = (color(fg), color(bg));
	if f == -2 || b == -2 {
		if f == -2 {
			ctx.usage(format!("foreground color `{}' not known", fg.as_bstr()));
		}
		if b == -2 {
			ctx.usage(format!("background color `{}' not known", bg.as_bstr()));
		}
		return None;
	}
	c.next_cp = c.next_cp.saturating_add(1);
	let p = c.next_cp;
	// ncurses `init_pair`: colors in range, `-1` for the defaults.
	let ok = |v: i32| v >= -1 && v < c.colors;
	if i32::from(p) >= c.color_pairs || !ok(f) || !ok(b) {
		return None;
	}
	let at = p as usize;
	if c.pairs.len() <= at {
		c.pairs.resize(at + 1, (-1, -1));
	}
	c.pairs[at] = (f as i16, b as i16);
	match c.pair_names.iter_mut().find(|(n, _)| n.as_slice() == spec) {
		Some(e) => e.1 = p,
		None => c.pair_names.push((BString::from(spec), p)),
	}
	Some(p)
}

/// zsh `zccmd_attr` and `zccmd_bg`.
fn attr(ctx: &mut Ctx<'_, '_>, c: &mut Curses, args: &[BString], bg: bool) -> R {
	let Some(w) = window(ctx, c, &args[0]) else {
		return done(1);
	};
	let mut ret = 0;
	let mut ch: u32 = 0;
	let mut pair: i16 = 0;
	for a in &args[1..] {
		if a.contains(&b'/') {
			match colorget(ctx, c, a) {
				None => ret = 1,
				Some(p) if bg && p >= 256 => {
					ctx.usage(format!("bg color pair {a} has index ({p}) too large (max 255)"));
					ret = 1;
				},
				Some(p) if bg => pair = p,
				Some(p) => c.wins[w].pair = p,
			}
		} else if bg && a.first() == Some(&b'@') {
			ch = u32::from(a.get(1).copied().unwrap_or(0));
		} else {
			let s = a.as_slice();
			let (on, name) = match s.first() {
				Some(b'-') => (false, &s[1..]),
				Some(b'+') => (true, &s[1..]),
				_ => (true, s),
			};
			match ATTRS.iter().find(|(n, _)| n.as_bytes() == name) {
				None => {
					ctx.usage(format!("attribute `{}' not known", name.as_bstr()));
					ret = 1;
				},
				Some(&(_, bit)) => {
					let win = &mut c.wins[w];
					if on {
						win.attrs |= bit;
					} else {
						win.attrs &= !bit;
					}
				},
			}
		}
	}
	if bg && ret == 0 {
		c.bkgd(w, ch, 0, pair);
	}
	done(ret)
}

/// zsh `zccmd_scroll`.
fn scroll(ctx: &mut Ctx<'_, '_>, c: &mut Curses, args: &[BString]) -> R {
	let Some(w) = window(ctx, c, &args[0]) else {
		return done(1);
	};
	match args[1].as_slice() {
		b"on" => {
			c.wins[w].scrollok = true;
			c.wins[w].scroll_flag = true;
			done(0)
		},
		b"off" => {
			c.wins[w].scrollok = false;
			c.wins[w].scroll_flag = false;
			done(0)
		},
		n => {
			let Some(n) = strtol_whole(n) else {
				ctx.usage(format!("scroll requires `on', `off' or integer: {}", args[1]));
				return done(1);
			};
			let flag = c.wins[w].scroll_flag;
			if !flag {
				c.wins[w].scrollok = true;
			}
			let ok = c.wscrl(w, n as i32);
			if !flag {
				c.wins[w].scrollok = false;
			}
			done(i32::from(!ok))
		},
	}
}

/// zsh `zccmd_querychar`: the character at the cursor, its color pair and
/// attributes into `reply` (or the given array).
fn querychar(ctx: &mut Ctx<'_, '_>, c: &Curses, args: &[BString]) -> R {
	let Some(w) = window(ctx, c, &args[0]) else {
		return done(1);
	};
	let (y, x) = (c.wins[w].cury, c.wins[w].curx);
	let mut cell = c.cell(w, y, x);
	if cell.ch == 0 && x > 0 {
		cell = c.cell(w, y, x - 1);
	}
	let mut list = Vec::new();
	let mut buf = [0u8; 4];
	list.push(BString::from(cell.char().unwrap_or(' ').encode_utf8(&mut buf).as_bytes()));
	list.push(match c.pair_names.iter().find(|(_, p)| *p == cell.pair) {
		Some((n, _)) => n.clone(),
		None => BString::from(cell.pair.to_string()),
	});
	for (n, bit) in ATTRS {
		if cell.attrs & bit != 0 {
			list.push(BString::from(n));
		}
	}
	let name = args
		.get(1)
		.cloned()
		.unwrap_or_else(|| BString::from("reply"));
	match zx(ctx, |ex| params::assignaparam(ex, &name, list, 0))? {
		Ok(()) => done(0),
		Err(d) => super::zsh_args::zerr(ctx, d),
	}
}

/// zsh `zccmd_resize` (ncurses `resize_term`).
fn resize(ctx: &mut Ctx<'_, '_>, c: &mut Curses, args: &[BString]) -> R {
	let (y, x) = (atoi(&args[0]), atoi(&args[1]));
	let (mut do_endwin, mut do_save) = (false, true);
	match args.get(2).map(|a| a.as_slice()) {
		None => {},
		Some(b"endwin") => do_endwin = true,
		Some(b"endwin_nosave") => {
			do_endwin = true;
			do_save = false;
		},
		Some(b"nosave") => do_save = false,
		Some(_) => ctx.usage(
			"`resize' expects `endwin', `nosave' or `endwin_nosave' for third argument, if given",
		),
	}
	if y == 0 && x == 0 && args.get(2).is_none() {
		return done(0);
	}
	if y <= 0 || x <= 0 {
		return done(1);
	}
	let ti = caps_of(ctx, c)?;
	if do_endwin && let Some(ti) = &ti {
		c.endwin(&Caps::new(ti));
	}
	c.resize(y, x);
	if do_endwin || do_save {
		let w = c.find(b"stdscr").unwrap_or(0);
		c.noutrefresh(w);
		update(ctx, c)?;
	}
	flush(ctx, c);
	if do_save {
		c.prog_tty = get_tty(ctx);
	}
	done(0)
}

/// What one key read gave: a character's bytes, or a key's name.
enum Got {
	Char(Vec<u8>),
	Key(String),
}

/// The input of one `zcurses input`: bytes read back first (ncurses'
/// `ungetch` FIFO), then fd 0 through input probes numbered in read order
/// (the re-run after a probe asks for the same ones and gets their
/// answers).
struct Reader {
	fifo: Vec<u8>,
	part: u32,
}

impl Reader {
	/// One byte within `timeout_ms` (negative: no limit); `None` when none
	/// came (timeout, end of input).
	fn byte(&mut self, ctx: &Ctx<'_, '_>, timeout_ms: i32) -> Result<Option<u8>, Need> {
		if !self.fifo.is_empty() {
			return Ok(Some(self.fifo.remove(0)));
		}
		let timeout_ns = u64::try_from(timeout_ms)
			.ok()
			.map(|ms| ms.saturating_mul(1_000_000));
		let p = Probe::Input {
			fd: 0,
			delim: None,
			lines: 1,
			nchars: Some(1),
			part: self.part,
			timeout_ns,
		};
		self.part += 1;
		Ok(match ctx.probe(p)? {
			ProbeResult::Input { data, .. } => data.first().copied(),
			_ => None,
		})
	}

	/// Give `bytes` back: they are read next.
	fn unread(&mut self, bytes: &[u8]) {
		let mut back = bytes.to_vec();
		back.extend_from_slice(&self.fifo);
		self.fifo = back;
	}
}

/// The key sequences of the terminal (keypad mode): the standard keys
/// with zsh's names for them, then the user-defined ones of the entry
/// (`kUP5`, `kDC3`, …), which ncurses numbers from `KEY_MAX` by their
/// place among the entry's extended strings (`_nc_init_keytry`) and zsh
/// shows as `F` and that number less `KEY_F0`. A sequence already taken
/// keeps its first key.
fn key_table(ti: &TermInfo) -> Vec<(Vec<u8>, String)> {
	/// ncurses `KEY_MAX` (`0777`) less `KEY_F0` (`0410`).
	const EXT_BASE: usize = 0o777 - 0o410;
	fn add(keys: &mut Vec<(Vec<u8>, String)>, seq: &[u8], name: String) {
		if !seq.is_empty() && !keys.iter().any(|k| k.0 == seq) {
			keys.push((seq.to_vec(), name));
		}
	}
	let mut keys: Vec<(Vec<u8>, String)> = Vec::new();
	for (name, cap) in KEYS {
		if let Some(seq) = cap.and_then(|c| ti.str(c)) {
			add(&mut keys, seq, name.to_string());
		}
	}
	for n in 1..64 {
		if let Some(seq) = ti.str(&format!("kf{n}")) {
			add(&mut keys, seq, format!("F{n}"));
		}
	}
	for (i, name) in ti.ext_str_names().iter().enumerate() {
		if name.first() == Some(&b'k')
			&& let Some(seq) = ti.str(name.as_slice())
		{
			add(&mut keys, seq, format!("F{}", EXT_BASE + i));
		}
	}
	keys
}

/// One key: in keypad mode a key's sequence (waiting `escdelay` between
/// its bytes), else a character (UTF-8; a carriage return reads as a
/// newline, ncurses' `nl` mode); with the bytes it took. `None` when
/// nothing came within `timeout`.
fn read_key(
	ctx: &Ctx<'_, '_>,
	r: &mut Reader,
	keys: Option<&[(Vec<u8>, String)]>,
	timeout: i32,
	escdelay: i32,
) -> Result<Option<(Got, Vec<u8>)>, Need> {
	let Some(b0) = r.byte(ctx, timeout)? else {
		return Ok(None);
	};
	if let Some(keys) = keys
		&& keys.iter().any(|k| k.0[0] == b0)
	{
		let mut seq = vec![b0];
		loop {
			let exact = keys.iter().find(|k| k.0 == seq).map(|k| k.1.clone());
			let longer = keys
				.iter()
				.any(|k| k.0.len() > seq.len() && k.0.starts_with(&seq));
			let next = if longer { r.byte(ctx, escdelay)? } else { None };
			if let Some(b) = next {
				seq.push(b);
			} else {
				if let Some(name) = exact {
					return Ok(Some((Got::Key(name), seq)));
				}
				break;
			}
		}
		// Not a key: the first byte is the character, the rest is read
		// again.
		r.unread(&seq[1..]);
	}
	let need = match b0 {
		0xc2..=0xdf => 2,
		0xe0..=0xef => 3,
		0xf0..=0xf4 => 4,
		_ => 1,
	};
	let mut bytes = vec![b0];
	while bytes.len() < need {
		match r.byte(ctx, timeout)? {
			Some(b) if b & 0xc0 == 0x80 => bytes.push(b),
			Some(b) => {
				r.unread(&[b]);
				break;
			},
			None => break,
		}
	}
	if bytes.len() != need {
		// An incomplete character: its first byte alone.
		r.unread(&bytes[1..]);
		bytes.truncate(1);
	}
	let raw = bytes.clone();
	if bytes == b"\r" {
		bytes[0] = b'\n';
	}
	Ok(Some((Got::Char(bytes), raw)))
}

/// ncurses' mouse event bits (`mmask_t` of a 32-bit build): per button
/// 1–4 its press, release, click, double and triple click, then the
/// modifiers and position reports.
mod mouse {
	/// The bit of `kind` (0 pressed … 4 triple-clicked) of `button`.
	pub const fn bit(button: u32, kind: u32) -> u32 {
		1 << ((button - 1) * 5 + kind)
	}
	pub const PRESSED: u32 = 0;
	pub const RELEASED: u32 = 1;
	pub const CLICKED: u32 = 2;
	pub const DOUBLE: u32 = 3;
	pub const TRIPLE: u32 = 4;
	/// Every button event.
	pub const BUTTONS: u32 = (1 << 20) - 1;
	/// `BUTTON_SHIFT`.
	pub const SHIFT: u32 = 1 << 20;
	/// `BUTTON_CTRL`.
	pub const CTRL: u32 = 1 << 21;
	/// `BUTTON_ALT`.
	pub const ALT: u32 = 1 << 22;
	/// `REPORT_MOUSE_POSITION`.
	pub const POSITION: u32 = 1 << 23;
	/// zsh's event names, in `zcurses_mouse_event_list` order.
	pub const KINDS: [&str; 5] =
		["PRESSED", "RELEASED", "CLICKED", "DOUBLE_CLICKED", "TRIPLE_CLICKED"];
}

/// One mouse event (ncurses `MEVENT`).
#[derive(Clone, Copy)]
struct MouseEvent {
	x:      i32,
	y:      i32,
	bstate: u32,
	valid:  bool,
}

/// ncurses `decode_X10_bstate`: the event of an xterm X10 report
/// (`ESC [ M` and three bytes). `pressed` holds the buttons pressed so far
/// in this run: xterm's release does not say which button it releases.
fn decode_x10(report: [u8; 3], pressed: &mut u32) -> u32 {
	let intro = u32::from(report[0]);
	let mut bstate = 0;
	if intro & 0x60 == 0x60 {
		// A wheel: only its first "button" (4) in a 32-bit mask.
		if intro & 3 == 0 {
			bstate = mouse::bit(4, mouse::PRESSED);
		}
	} else {
		match intro & 3 {
			n @ 0..=2 => {
				bstate = mouse::bit(n + 1, mouse::PRESSED);
				*pressed |= bstate;
			},
			_ => {
				if *pressed == 0 {
					bstate = mouse::POSITION;
				} else {
					for b in 1..=3 {
						if *pressed & mouse::bit(b, mouse::PRESSED) != 0 {
							bstate |= mouse::bit(b, mouse::RELEASED);
						}
					}
					*pressed = 0;
				}
			},
		}
	}
	if intro & 4 != 0 {
		bstate |= mouse::SHIFT;
	}
	if intro & 8 != 0 {
		bstate |= mouse::ALT;
	}
	if intro & 16 != 0 {
		bstate |= mouse::CTRL;
	}
	bstate
}

/// ncurses `_nc_mouse_parse`: a press followed by a release of the same
/// button at the same place is a click (with the release's modifiers);
/// clicks in a row are double and triple clicks.
fn parse_mouse(events: &mut [MouseEvent]) {
	for i in 1..events.len() {
		let (ep, next) = (events[i - 1], events[i]);
		let presses = (1..=4).fold(0, |m, b| m | mouse::bit(b, mouse::PRESSED));
		if !ep.valid
			|| ep.x != next.x
			|| ep.y != next.y
			|| ep.bstate & presses == 0
			|| next.bstate & presses != 0
		{
			continue;
		}
		let mut merged = false;
		for b in 1..=4 {
			if ep.bstate & mouse::bit(b, mouse::PRESSED) != 0 {
				let n = &mut events[i].bstate;
				*n &= !mouse::bit(b, mouse::RELEASED);
				*n |= mouse::bit(b, mouse::CLICKED);
				merged = true;
			}
		}
		if merged {
			events[i - 1].valid = false;
		}
	}
	let mut prev: Option<usize> = None;
	for i in 0..events.len() {
		if !events[i].valid {
			continue;
		}
		if let Some(p) = prev {
			let mut merged = false;
			for b in 1..=4 {
				let click = mouse::bit(b, mouse::CLICKED);
				if events[i].bstate & click == 0 {
					continue;
				}
				let pb = events[p].bstate;
				let up = if pb & click != 0 {
					mouse::bit(b, mouse::DOUBLE)
				} else if pb & mouse::bit(b, mouse::DOUBLE) != 0 {
					mouse::bit(b, mouse::TRIPLE)
				} else {
					continue;
				};
				events[i].bstate = (events[i].bstate & !click) | up;
				merged = true;
			}
			if merged {
				events[p].valid = false;
			}
		}
		prev = Some(i);
	}
}

/// The click interval (ncurses' default `mouseinterval`, 1/6 s; zsh's
/// `zcurses mouse delay` never gets to set another).
const CLICK_MS: i32 = 166;

/// A mouse report after the `kmous` key, and the reports that follow
/// within the click interval (ncurses `wgetch`'s run). A run ended by the
/// interval is parsed into clicks; one ended by a key is not (the key is
/// read next). The most recent valid event, as zsh's `mparam` array
/// (`id x y z events… [SHIFT] [CTRL] [ALT]`), empty when there is none.
fn mouse_run(
	ctx: &Ctx<'_, '_>,
	r: &mut Reader,
	keys: &[(Vec<u8>, String)],
	escdelay: i32,
	moves: bool,
) -> Result<Vec<BString>, Need> {
	let mask = mouse::BUTTONS | if moves { mouse::POSITION } else { 0 };
	let mut pressed = 0;
	let mut events: Vec<MouseEvent> = Vec::new();
	loop {
		let mut report = [0u8; 3];
		let mut complete = true;
		for b in &mut report {
			if let Some(v) = r.byte(ctx, escdelay)? {
				*b = v;
			} else {
				complete = false;
				break;
			}
		}
		if complete {
			let bstate = decode_x10(report, &mut pressed);
			events.push(MouseEvent {
				x: i32::from(report[1]) - 33,
				y: i32::from(report[2]) - 33,
				bstate,
				valid: bstate & mask != 0,
			});
		}
		match read_key(ctx, r, Some(keys), CLICK_MS, escdelay)? {
			Some((Got::Key(k), _)) if k == "MOUSE" => {},
			Some((_, raw)) => {
				r.unread(&raw);
				break;
			},
			None => {
				parse_mouse(&mut events);
				break;
			},
		}
	}
	let Some(ev) = events.iter().rev().find(|e| e.valid) else {
		return Ok(Vec::new());
	};
	let mut out: Vec<BString> =
		["0".to_string(), ev.x.to_string(), ev.y.to_string(), "0".to_string()]
			.into_iter()
			.map(BString::from)
			.collect();
	for b in 1..=4 {
		for (kind, name) in mouse::KINDS.iter().enumerate() {
			if ev.bstate & mouse::bit(b, kind as u32) != 0 {
				out.push(BString::from(format!("{name}{b}")));
			}
		}
	}
	for (bit, name) in [(mouse::SHIFT, "SHIFT"), (mouse::CTRL, "CTRL"), (mouse::ALT, "ALT")] {
		if ev.bstate & bit != 0 {
			out.push(BString::from(name));
		}
	}
	Ok(out)
}

/// zsh `zccmd_mouse`: `motion` (`+`/`-`) changes what the mask reports.
/// `delay` always fails: zsh's check of its number tests the end pointer
/// against `NULL`, which it never is.
fn mouse_cmd(ctx: &mut Ctx<'_, '_>, c: &mut Curses, args: &[BString]) -> R {
	for a in args {
		if a.as_slice() == b"delay" {
			ctx.usage("mouse delay requires an integer argument");
			return done(1);
		}
		let s = a.as_slice();
		let (on, name) = match s.first() {
			Some(b'+') => (true, &s[1..]),
			Some(b'-') => (false, &s[1..]),
			_ => (true, s),
		};
		if name != b"motion" {
			// zsh passes a character where it formats a string (and
			// crashes); the text is what it means to show.
			ctx.usage(format!("unrecognised mouse command: {a}"));
			return done(1);
		}
		if c.mouse_moves != on {
			c.mouse_moves = on;
			c.mouse_dirty = true;
		}
	}
	done(0)
}

/// zsh `zccmd_input` (ncurses `wget_wch` in `cbreak`, `noecho` and `nl`
/// mode): refresh the window if it changed, then read a character or, in
/// keypad mode, a key; with a mouse parameter, mouse reports.
fn input(ctx: &mut Ctx<'_, '_>, c: &mut Curses, args: &[BString]) -> R {
	let Some(w) = window(ctx, c, &args[0]) else {
		return done(1);
	};
	let keypad = args.len() >= 3;
	let want_mouse = args.len() >= 4;
	c.wins[w].keypad = keypad;
	let Some(ti) = caps_of(ctx, c)? else {
		return done(1);
	};
	let caps = Caps::new(&ti);
	// zsh `mousemask`s when the mouse is wanted and not on (or its mask
	// changed), and turns it off when it is not wanted.
	if want_mouse && (!c.mouse_on || c.mouse_dirty) {
		if !c.keypad_xmit {
			if let Some(s) = caps.s("smkx") {
				c.pending.extend_from_slice(&s);
			}
			c.keypad_xmit = true;
		}
		if let Some(s) = caps.mouse(true) {
			c.pending.extend_from_slice(&s);
		}
		c.mouse_on = true;
		c.mouse_dirty = false;
	} else if !want_mouse && c.mouse_on {
		if let Some(s) = caps.mouse(false) {
			c.pending.extend_from_slice(&s);
		}
		c.mouse_on = false;
	}
	// ncurses `wgetch` refreshes a changed window first, and switches the
	// keypad's transmit mode.
	if c.ended || c.needs_refresh(w) {
		c.noutrefresh(w);
		if c.ended
			&& let Some(t) = c.prog_tty.clone()
		{
			set_tty(ctx, &t);
		}
		c.doupdate(&caps);
	}
	if keypad != c.keypad_xmit {
		if let Some(s) = caps.s(if keypad { "smkx" } else { "rmkx" }) {
			c.pending.extend_from_slice(&s);
		}
		c.keypad_xmit = keypad;
	}
	flush_now(ctx, c)?;
	let timeout = c.wins[w].timeout;
	let escdelay = ctx
		.scalar(b"ESCDELAY")?
		.and_then(|v| std::str::from_utf8(&v).ok()?.trim().parse::<i32>().ok())
		.unwrap_or(1000);
	let keys = keypad.then(|| key_table(&ti));
	let mut r = Reader { fifo: c.fifo.clone(), part: 0 };
	let Some((got, _)) = read_key(ctx, &mut r, keys.as_deref(), timeout, escdelay)? else {
		c.fifo = r.fifo;
		return done(1);
	};
	let events = if let (Got::Key(k), Some(keys)) = (&got, &keys)
		&& k == "MOUSE"
		&& want_mouse
		&& c.mouse_on
	{
		Some(mouse_run(ctx, &mut r, keys, escdelay, c.mouse_moves)?)
	} else {
		None
	};
	c.fifo = r.fifo;
	let (text, key) = match got {
		Got::Char(b) => (BString::from(b), BString::default()),
		Got::Key(k) => (BString::default(), BString::from(k)),
	};
	let var = args
		.get(1)
		.cloned()
		.unwrap_or_else(|| BString::from("REPLY"));
	if let Err(d) = zx(ctx, |ex| params::assignsparam(ex, &var, &text, 0))? {
		return super::zsh_args::zerr(ctx, d);
	}
	if let Some(kparam) = args.get(2)
		&& let Err(d) = zx(ctx, |ex| params::assignsparam(ex, kparam, &key, 0))?
	{
		return super::zsh_args::zerr(ctx, d);
	}
	if let Some(mparam) = args.get(3) {
		let vals = events.unwrap_or_default();
		if let Err(d) = zx(ctx, |ex| params::assignaparam(ex, mparam, vals, 0))? {
			return super::zsh_args::zerr(ctx, d);
		}
	}
	done(0)
}

#[cfg(test)]
mod tests {
	use super::{screen::Cell, *};

	/// The events of X10 reports at `(x, y)` (one run), parsed.
	fn run(reports: &[(u8, u8, u8)]) -> Vec<(i32, i32, u32)> {
		let mut pressed = 0;
		let mut events: Vec<MouseEvent> = reports
			.iter()
			.map(|&(b, x, y)| {
				let bstate = decode_x10([b, x, y], &mut pressed);
				MouseEvent {
					x: i32::from(x) - 33,
					y: i32::from(y) - 33,
					bstate,
					valid: bstate & mouse::BUTTONS != 0,
				}
			})
			.collect();
		parse_mouse(&mut events);
		events
			.iter()
			.filter(|e| e.valid)
			.map(|e| (e.x, e.y, e.bstate))
			.collect()
	}

	#[test]
	fn mouse_reports_make_clicks() {
		let b1 = |k| mouse::bit(1, k);
		assert_eq!(run(&[(b' ', b'!', b'!'), (b'#', b'!', b'!')]), [(0, 0, b1(mouse::CLICKED))]);
		let two = [(b' ', b'!', b'!'), (b'#', b'!', b'!'), (b' ', b'!', b'!'), (b'#', b'!', b'!')];
		assert_eq!(run(&two), [(0, 0, b1(mouse::DOUBLE))]);
		let mut three = two.to_vec();
		three.extend_from_slice(&two[..2]);
		assert_eq!(run(&three), [(0, 0, b1(mouse::TRIPLE))]);
		// The click has the release's modifiers.
		assert_eq!(run(&[(b'4', b'(', b'*'), (b'#', b'(', b'*')]), [(7, 9, b1(mouse::CLICKED))]);
		// A drag is a press and a release; a lone release, button 5 are none.
		assert_eq!(run(&[(b' ', b'!', b'!'), (b'#', b'"', b'"')]), [
			(0, 0, b1(mouse::PRESSED)),
			(1, 1, b1(mouse::RELEASED))
		]);
		assert!(run(&[(b'#', b'!', b'!')]).is_empty());
		assert!(run(&[(b'a', b'!', b'!')]).is_empty());
		assert_eq!(run(&[(b'`', b'!', b'!')]), [(0, 0, mouse::bit(4, mouse::PRESSED))]);
		assert_eq!(run(&[(b'$', b'"', b'"')]), [(1, 1, b1(mouse::PRESSED) | mouse::SHIFT)]);
	}

	#[test]
	fn atoi_reads_a_leading_number() {
		assert_eq!(atoi(b" 12abc"), 12);
		assert_eq!(atoi(b"-3"), -3);
		assert_eq!(atoi(b"x"), 0);
		assert_eq!(strtol_whole(b"12"), Some(12));
		assert_eq!(strtol_whole(b"12x"), None);
	}

	#[test]
	fn the_window_model_wraps_scrolls_and_borders() {
		let mut c = Curses::new(BString::from("xterm"), 5, 10);
		c.newwin(BString::from("w"), 3, 4, 1, 1).unwrap();
		let w = c.find(b"w").unwrap();
		assert!(c.addstr(w, "abcde"));
		assert_eq!((c.wins[w].cury, c.wins[w].curx), (1, 1));
		assert_eq!(c.cell(w, 1, 0).ch, u32::from(b'e'));
		// The bottom right without scrolling: written, then an error.
		assert!(c.wmove(w, 2, 3));
		assert!(!c.addstr(w, "xy"));
		assert_eq!(c.cell(w, 2, 3).ch, u32::from(b'x'));
		c.wins[w].scrollok = true;
		assert!(c.wscrl(w, 1));
		assert_eq!(c.cell(w, 0, 0).ch, u32::from(b'e'));
		c.border(w);
		assert_eq!(c.cell(w, 0, 0).ch, u32::from(b'l'));
		assert!(c.cell(w, 1, 0).attrs & screen::A_ALTCHARSET != 0);
		// A subwindow shares its parent's cells.
		c.subwin(BString::from("s"), w, 1, 2, 2, 2).unwrap();
		let s = c.find(b"s").unwrap();
		assert!(c.addstr(s, "Q"));
		assert_eq!(c.cell(w, 1, 1).ch, u32::from(b'Q'));
		assert!(c.subwin(BString::from("t"), w, 5, 5, 0, 0).is_none());
	}

	#[test]
	fn wide_characters_take_two_columns() {
		let mut c = Curses::new(BString::from("xterm"), 3, 4);
		let w = c.find(b"stdscr").unwrap();
		assert!(c.addstr(w, "a漢"));
		assert_eq!(c.wins[w].curx, 3);
		assert_eq!(c.cell(w, 0, 2), Cell { ch: 0, ..c.cell(w, 0, 1) });
		// It does not fit at the last column: the line ends blank.
		assert!(c.addstr(w, "字"));
		assert_eq!((c.wins[w].cury, c.wins[w].curx), (1, 2));
		assert_eq!(c.cell(w, 0, 3).ch, u32::from(b' '));
	}
}
