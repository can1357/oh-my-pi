//! The `zle` builtin (zsh 5.9 `zle_thingy.c` `bin_zle` and friends):
//! defining, listing and deleting widgets, calling them from shell code,
//! and the editor operations shell code may ask for (`-M`, `-U`, `-K`,
//! `-R`, `-I`, `-f`, `-F`, `-T`).

use std::sync::Arc;

use bstr::{BString, ByteSlice};

use super::{
	Watch,
	exec::{self, Drive, ExecTask, Got, Task},
	thingy::{BindError, Kind, Widget},
	wflags, zle_mut,
};
use crate::bash::{
	vm::builtins::{
		Control, Ctx, Need, Outcome, R, done,
		zsh_args::{Ops, isset},
		zsh_print::charset,
		zsh_quote::{niceformat, quotedzputs},
	},
	zshopt::ZshOpt,
};

/// `zle` (zsh `bin_zle`): the operation its option selects.
pub fn zle(ctx: &mut Ctx<'_, '_>, ops: &Ops, args: &[BString]) -> R {
	// zsh's `opns[]`: option, minimum and maximum argument counts.
	const OPNS: [(u8, usize, Option<usize>); 13] = [
		(b'l', 0, None),
		(b'D', 1, None),
		(b'A', 2, Some(2)),
		(b'N', 1, Some(2)),
		(b'C', 3, Some(3)),
		(b'R', 0, None),
		(b'M', 1, Some(1)),
		(b'U', 1, Some(1)),
		(b'K', 1, Some(1)),
		(b'I', 0, Some(0)),
		(b'f', 1, None),
		(b'F', 0, Some(2)),
		(b'T', 0, Some(2)),
	];
	let mut sel = None;
	for (i, &(o, ..)) in OPNS.iter().enumerate() {
		if ops.isset(o) {
			if sel.is_some() {
				ctx.usage("incompatible operation selection options");
				return done(1);
			}
			sel = Some(i);
		}
	}
	let Some(i) = sel else {
		return call(ctx, args);
	};
	let (o, min, max) = OPNS[i];
	if args.len() < min {
		ctx.usage(format!("not enough arguments for -{}", char::from(o)));
		return done(1);
	}
	if max.is_some_and(|m| args.len() > m) {
		ctx.usage(format!("too many arguments for -{}", char::from(o)));
		return done(1);
	}
	match o {
		b'l' => list(ctx, ops, args),
		b'D' => delete(ctx, args),
		b'A' => link(ctx, args),
		b'N' => new(ctx, args),
		b'C' => complete(ctx, args),
		b'R' => refresh(ctx, ops, args),
		b'M' => mesg(ctx, args),
		b'U' => unget(ctx, args),
		b'K' => keymap(ctx, args),
		b'I' => invalidate(ctx),
		b'f' => flags(ctx, args),
		b'F' => fd(ctx, ops, args),
		_ => transform(ctx, ops, args),
	}
}

/// zsh `zleactive`: a line is being edited in this vproc.
fn active(ctx: &Ctx<'_, '_>) -> bool {
	super::active(ctx.vp)
}

/// `name` for a message (zsh `%s` of `zwarnnam`: `nicezputs`).
fn nice(ctx: &mut Ctx<'_, '_>, s: &[u8]) -> Result<String, Need> {
	let cs = charset(ctx)?;
	Ok(String::from_utf8_lossy(&niceformat(s, false, cs)).into_owned())
}

/// zsh `bin_zle_list`.
fn list(ctx: &mut Ctx<'_, '_>, ops: &Ops, args: &[BString]) -> R {
	let cs = charset(ctx)?;
	let rc = isset(ctx, ZshOpt::Rcquotes)?;
	let all = ops.isset(b'a');
	let as_cmd = ops.isset(b'L');
	let zle = zle_mut(ctx.k, ctx.cx, ctx.vp);
	let widgets = Arc::clone(&zle.widgets);
	let mut out = Vec::new();
	let show = |out: &mut Vec<u8>, name: &[u8], w: &Widget, mode: i32| {
		if mode < 0 {
			out.extend_from_slice(name);
			out.push(b'\n');
			return;
		}
		if w.flags & wflags::INT != 0 {
			return;
		}
		if mode > 0 {
			out.extend_from_slice(if matches!(w.kind, Kind::Comp { .. }) {
				b"zle -C "
			} else {
				b"zle -N "
			});
			if name.first() == Some(&b'-') {
				out.extend_from_slice(b"-- ");
			}
			out.extend_from_slice(&quotedzputs(name, rc, cs));
			match &w.kind {
				Kind::Comp { base, func } => {
					out.push(b' ');
					out.extend_from_slice(&quotedzputs(base, rc, cs));
					out.push(b' ');
					out.extend_from_slice(&quotedzputs(func, rc, cs));
				},
				Kind::User(f) if f.as_slice() != name => {
					out.push(b' ');
					out.extend_from_slice(&quotedzputs(f, rc, cs));
				},
				_ => {},
			}
		} else {
			out.extend_from_slice(&niceformat(name, false, cs));
			match &w.kind {
				Kind::Comp { base, func } => {
					out.extend_from_slice(b" -C ");
					out.extend_from_slice(&niceformat(base, false, cs));
					out.push(b' ');
					out.extend_from_slice(&niceformat(func, false, cs));
				},
				Kind::User(f) if f.as_slice() != name => {
					out.extend_from_slice(b" (");
					out.extend_from_slice(&niceformat(f, false, cs));
					out.push(b')');
				},
				_ => {},
			}
		}
		out.push(b'\n');
	};
	if args.is_empty() {
		let mode = if all { -1 } else { i32::from(as_cmd) };
		for (name, w) in widgets.iter() {
			show(&mut out, name, w, mode);
		}
		ctx.out(&out);
		return done(0);
	}
	let mut ret = 0;
	for a in args {
		match widgets.get(a) {
			Some(w) if all || w.flags & wflags::INT == 0 => {
				if as_cmd {
					show(&mut out, a, w, 1);
				}
			},
			_ => {
				ret = 1;
				break;
			},
		}
	}
	ctx.out(&out);
	done(ret)
}

/// zsh `bin_zle_del`.
fn delete(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	let mut ret = 0;
	for a in args {
		let r = Arc::make_mut(&mut zle_mut(ctx.k, ctx.cx, ctx.vp).widgets).delete(a);
		match r {
			Ok(()) => {},
			Err(BindError::NoSuch) => {
				let n = nice(ctx, a)?;
				ctx.usage(format!("no such widget `{n}'"));
				ret = 1;
			},
			Err(BindError::Protected) => {
				let n = nice(ctx, a)?;
				ctx.usage(format!("widget name `{n}' is protected"));
				ret = 1;
			},
		}
	}
	done(ret)
}

/// zsh `bin_zle_link`.
fn link(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	let r = Arc::make_mut(&mut zle_mut(ctx.k, ctx.cx, ctx.vp).widgets).link(&args[0], &args[1]);
	match r {
		Ok(()) => done(0),
		Err(BindError::NoSuch) => {
			let n = nice(ctx, &args[0])?;
			ctx.usage(format!("no such widget `{n}'"));
			done(1)
		},
		Err(BindError::Protected) => {
			let n = nice(ctx, &args[1])?;
			ctx.usage(format!("widget name `{n}' is protected"));
			done(1)
		},
	}
}

/// zsh `bin_zle_new`.
fn new(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	let func = args.get(1).unwrap_or(&args[0]).clone();
	let w = Widget { flags: 0, kind: Kind::User(func) };
	let r = Arc::make_mut(&mut zle_mut(ctx.k, ctx.cx, ctx.vp).widgets).define(&args[0], w);
	if r.is_err() {
		let n = nice(ctx, &args[0])?;
		ctx.usage(format!("widget name `{n}' is protected"));
		return done(1);
	}
	done(0)
}

/// zsh `bin_zle_complete`: a completion widget behaving like the builtin
/// completion widget `args[1]`, running function `args[2]`.
fn complete(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	// zsh `require_module("zsh/complete", …)`.
	if let Err(e) =
		crate::bash::vm::builtins::zsh_module::ensure_loaded(ctx.k, ctx.cx, ctx.vp, b"zsh/complete")
	{
		return Err(Need::Store(e));
	}
	let zle = zle_mut(ctx.k, ctx.cx, ctx.vp);
	let mut base = BString::default();
	if args[1].first() != Some(&b'.') {
		base.push(b'.');
	}
	base.extend_from_slice(&args[1]);
	let iscomp = zle
		.widgets
		.get(&base)
		.is_some_and(|w| w.flags & wflags::ISCOMP != 0);
	if !iscomp {
		let n = nice(ctx, &args[1])?;
		ctx.usage(format!("invalid widget `{n}'"));
		return done(1);
	}
	let w = Widget {
		flags: wflags::NCOMP | wflags::MENUCMP | wflags::KEEPSUFFIX,
		kind:  Kind::Comp { base: args[1].clone(), func: args[2].clone() },
	};
	let r = Arc::make_mut(&mut zle_mut(ctx.k, ctx.cx, ctx.vp).widgets).define(&args[0], w);
	if r.is_err() {
		let n = nice(ctx, &args[0])?;
		ctx.usage(format!("widget name `{n}' is protected"));
		return done(1);
	}
	done(0)
}

/// zsh `bin_zle_refresh`: show `args[0]` in the status line (and the rest
/// as a list) and redisplay.
fn refresh(ctx: &mut Ctx<'_, '_>, ops: &Ops, args: &[BString]) -> R {
	if !active(ctx) {
		return done(1);
	}
	if args.len() > 1 {
		let status = args[0].clone();
		let items = args[1..].to_vec();
		return drive_task(ctx, |_| exec::native_task(move |zw, _| refresh_list(zw, status, items)));
	}
	super::display::zle_refresh(
		ctx.k,
		ctx.cx,
		ctx.vp,
		args.first().map(|a| &a[..]),
		ops.isset(b'c'),
	);
	done(0)
}

/// `zle -R status item…` (zsh `bin_zle_refresh` with a list): the items
/// listed below the line (zsh `listlist`, which may ask whether to show
/// a long list), the status line shown, redisplay.
fn refresh_list(zw: &mut exec::Zw<'_, '_>, status: BString, items: Vec<BString>) -> exec::WResult {
	let saved = zw.ed.statusline.take();
	let ocl = zw.zle.display.clearlist;
	if !status.is_empty() {
		zw.ed.statusline = Some(status);
	}
	let zmultsav = zw.ed.zmod.mult;
	zw.ed.zmod.mult = 1;
	super::widgets::named::listlist(
		zw,
		items,
		Box::new(move |zw, _| {
			if zw.ed.statusline.is_some() {
				zw.zle.display.lastlistlen += 1;
			}
			zw.zle.display.showinglist = 0;
			zw.zle.display.clearlist = false;
			zw.ed.zmod.mult = zmultsav;
			super::display::refresh(zw);
			zw.zle.display.clearlist = ocl;
			zw.ed.statusline = saved;
			exec::WResult::Done(0)
		}),
	)
}

/// zsh `bin_zle_mesg`.
fn mesg(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	if !active(ctx) {
		ctx.usage("can only be called from widget function");
		return done(1);
	}
	let in_widget = super::editor(ctx.vp).is_some_and(|ed| ed.in_widget > 0);
	if let Some(ed) = super::editor_mut(ctx.vp) {
		exec::showmsg(ed, &args[0]);
	}
	if !in_widget {
		super::display::zle_refresh(ctx.k, ctx.cx, ctx.vp, None, false);
	}
	done(0)
}

/// zsh `bin_zle_unget`: the bytes are read before the terminal's.
fn unget(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	let Some(ed) = super::editor_mut(ctx.vp) else {
		ctx.usage("can only be called from widget function");
		return done(1);
	};
	for &b in args[0].iter().rev() {
		ed.unget.push_front(b);
	}
	done(0)
}

/// What [`read_bytes`] got.
pub enum ReadBytes {
	/// The bytes read and whether input ended (end of file or `-t` timeout)
	/// before `enough` was satisfied.
	Got(Vec<u8>, bool),
	/// The caller is to return this outcome (a frame to run first: it is
	/// run again afterwards and goes on where it was).
	Outcome(Outcome),
}

/// `read` while the editor is active (zsh `bin_read`'s `izle`): bytes
/// come through the editor's `getbyte` (`ZLE_CMD_GET_KEY`: pushed-back
/// bytes first, `zle -F` handlers served, no `KEYTIMEOUT`) until
/// `enough` says the bytes so far are all, each waited for at most
/// `timeout_cs` hundredths of a second. Bytes read before a park or a
/// frame are kept on the editor; the builtin, run again, goes on.
///
/// # Errors
/// [`Need::Park`] while no byte is there.
pub fn read_bytes(
	ctx: &mut Ctx<'_, '_>,
	timeout_cs: Option<i64>,
	enough: impl Fn(&[u8]) -> bool,
) -> Result<ReadBytes, Need> {
	let owner = ctx.vp.frames.len();
	loop {
		let Some(ed) = super::editor_mut(ctx.vp) else {
			return Ok(ReadBytes::Got(Vec::new(), true));
		};
		let base = if let Some(b) = exec::resume_base(ed, owner) {
			b
		} else {
			let acc = ed.read_acc.get_or_insert_with(Vec::new);
			if enough(acc) {
				let acc = ed.read_acc.take().unwrap_or_default();
				return Ok(ReadBytes::Got(acc, false));
			}
			exec::push_root(ed, Task::Key(exec::KeyTask::new(exec::KeyMode::Byte(timeout_cs))), owner)
		};
		match exec::drive(ctx.k, ctx.cx, ctx.vp, base) {
			Drive::Done(Got::Byte(Some(b))) => {
				if let Some(ed) = super::editor_mut(ctx.vp) {
					ed.read_acc.get_or_insert_with(Vec::new).push(b);
				}
			},
			Drive::Done(_) => {
				let acc = super::editor_mut(ctx.vp)
					.and_then(|ed| ed.read_acc.take())
					.unwrap_or_default();
				return Ok(ReadBytes::Got(acc, true));
			},
			Drive::Park(key) => return Err(Need::Park(key)),
			Drive::Frame => {
				return Ok(ReadBytes::Outcome(Outcome { status: 0, control: Control::Resume }));
			},
		}
	}
}

/// Whether a `read` builtin of `vp` is part way through taking bytes from
/// the editor (run again after waiting: its prompt is out already).
pub fn reading_bytes(vp: &crate::bash::vm::proc::Vproc) -> bool {
	super::editor(vp).is_some_and(|ed| ed.read_acc.is_some())
}

/// Drive a task this builtin pushed (or pushed before it parked or ran a
/// frame) to its end: the builtin's outcome.
fn drive_task(ctx: &mut Ctx<'_, '_>, task: impl FnOnce(&super::Zle) -> Task) -> R {
	let owner = ctx.vp.frames.len();
	let Some(z) = ctx.vp.zle.as_deref_mut() else {
		return done(1);
	};
	let base = if let Some(b) = z.ed.as_deref().and_then(|ed| exec::resume_base(ed, owner)) {
		b
	} else {
		let t = task(z);
		let Some(ed) = z.ed.as_deref_mut() else {
			return done(1);
		};
		exec::push_root(ed, t, owner)
	};
	match exec::drive(ctx.k, ctx.cx, ctx.vp, base) {
		Drive::Done(Got::Status(s)) => done(s),
		Drive::Done(_) => done(0),
		Drive::Park(key) => Err(Need::Park(key)),
		Drive::Frame => Ok(Outcome { status: 0, control: Control::Resume }),
	}
}

/// zsh `bin_zle_keymap` (`zle -K`).
fn keymap(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	if !active(ctx) {
		ctx.usage("can only be called from widget function");
		return done(1);
	}
	let owner = ctx.vp.frames.len();
	let resuming = super::editor(ctx.vp)
		.and_then(|ed| exec::resume_base(ed, owner))
		.is_some();
	if !resuming {
		let Some(z) = ctx.vp.zle.as_deref_mut() else {
			return done(1);
		};
		let Some(ed) = z.ed.as_deref_mut() else {
			return done(1);
		};
		if exec::selectkeymap(&z.keymaps, ed, &args[0], false).is_err() {
			return done(1);
		}
		if ed.hooks.is_empty() {
			return done(0);
		}
	}
	drive_task(ctx, |_| Task::Hooks)
}

/// zsh `bin_zle_invalidate`.
fn invalidate(ctx: &mut Ctx<'_, '_>) -> R {
	if !active(ctx) {
		return done(1);
	}
	super::display::invalidate(ctx.k, ctx.cx, ctx.vp);
	done(0)
}

/// zsh `bin_zle_flags` (`zle -f`).
fn flags(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	let usable = super::editor(ctx.vp).is_some_and(|ed| ed.in_widget > 0);
	if !usable {
		ctx.usage("can only set flags from a widget");
		return done(1);
	}
	let mut ret = 0;
	let bindk = super::editor(ctx.vp).and_then(|ed| ed.bindk.clone());
	let Some(bindk) = bindk else {
		return done(0);
	};
	for f in args {
		let add = match f.as_slice() {
			b"yank" => Some(wflags::YANKAFTER),
			b"yankbefore" => Some(wflags::YANKBEFORE),
			b"kill" => Some(wflags::KILL),
			b"vichange" => None,
			_ => {
				let n = nice(ctx, f)?;
				ctx.usage(format!("invalid flag `{n}' given to zle -f"));
				ret = 1;
				continue;
			},
		};
		let Some(z) = ctx.vp.zle.as_deref_mut() else {
			break;
		};
		match add {
			Some(bit) => {
				if let Some(w) = Arc::make_mut(&mut z.widgets).get_mut(&bindk) {
					w.flags |= bit;
				}
			},
			None => {
				// zsh `startvichange(-1)` in vi command mode: the widget is a
				// vi change `vi-repeat-change` repeats ($NUMERIC follows
				// `zmod`, which a repeat replaces).
				if let Some(ed) = z.ed.as_deref_mut()
					&& super::utils::invicmdmode(ed)
				{
					super::widgets::vi::startvichange(&mut z.vi, ed, -1);
				}
			},
		}
	}
	done(ret)
}

/// zsh `bin_zle_fd` (`zle -F`).
fn fd(ctx: &mut Ctx<'_, '_>, ops: &Ops, args: &[BString]) -> R {
	let mut fd = 0;
	if let Some(a) = args.first() {
		if let Some(n) = a
			.to_str()
			.ok()
			.and_then(|s| s.parse::<i32>().ok())
			.filter(|&n| n >= 0)
		{
			fd = n;
		} else {
			let n = nice(ctx, a)?;
			ctx.usage(format!("Bad file descriptor number for -F: {n}"));
			return done(1);
		}
	}
	if ops.isset(b'L') || args.is_empty() {
		if args.len() > 1 {
			ctx.usage("too many arguments for -FL");
			return done(1);
		}
		let zle = zle_mut(ctx.k, ctx.cx, ctx.vp);
		let mut out = Vec::new();
		let mut found = false;
		for w in &zle.watches {
			if !args.is_empty() && w.fd != fd {
				continue;
			}
			found = true;
			out.extend_from_slice(b"zle -F ");
			if w.widget {
				out.extend_from_slice(b"-w ");
			}
			out.extend_from_slice(w.fd.to_string().as_bytes());
			out.push(b' ');
			out.extend_from_slice(&w.func);
			out.push(b'\n');
		}
		ctx.out(&out);
		return done(i32::from(!args.is_empty() && !found));
	}
	let widget = ops.isset(b'w');
	let zle = zle_mut(ctx.k, ctx.cx, ctx.vp);
	if let Some(func) = args.get(1) {
		match zle.watches.iter_mut().find(|w| w.fd == fd) {
			Some(w) => {
				w.func = func.clone();
				w.widget = widget;
			},
			None => zle.watches.push(Watch { fd, func: func.clone(), widget }),
		}
		return done(0);
	}
	if let Some(i) = zle.watches.iter().position(|w| w.fd == fd) {
		zle.watches.remove(i);
		done(0)
	} else {
		ctx.usage(format!("No handler installed for fd {fd}"));
		done(1)
	}
}

/// zsh `bin_zle_transform` (`zle -T`): only listing and removing work;
/// installing a `tc` transformation (a shell function called for every
/// terminal capability ZLE outputs) is not supported.
fn transform(ctx: &mut Ctx<'_, '_>, ops: &Ops, args: &[BString]) -> R {
	let bad = if ops.isset(b'L') {
		match args {
			[] => 0,
			[a] if a.as_slice() == b"tc" => 0,
			[_] => 2,
			_ => 1,
		}
	} else if ops.isset(b'r') {
		match args.len() {
			0 => -1,
			1 => 0,
			_ => 1,
		}
	} else if args.len() < 2 {
		-1
	} else if args[0].as_slice() == b"tc" {
		ctx.diag(crate::bash::diag::Diag::Unsupported { what: "`zle -T tc' transformations".into() });
		return done(1);
	} else {
		2
	};
	match bad {
		0 => done(0),
		2 => {
			let n = nice(ctx, &args[0])?;
			ctx.usage(format!("-T: no such transformation '{n}'"));
			done(1)
		},
		b => {
			let way = if b > 0 { "many" } else { "few" };
			ctx.usage(format!("too {way} arguments for option -T"));
			done(1)
		},
	}
}

/// zsh `bin_zle_call`: `zle` alone (status of ZLE), or `zle widget
/// [-n N] [-N] [-K keymap] [-w] [-f nolast] [--] args…`.
fn call(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	// zsh `zle_usable`: not inside a completion function (a call resumed
	// after a completion widget's function ran is past that check).
	let owner = ctx.vp.frames.len();
	let resumed = super::editor(ctx.vp)
		.and_then(|ed| exec::resume_base(ed, owner))
		.is_some();
	let usable = active(ctx)
		&& (resumed
			|| super::comp::comp(ctx.vp).is_none_or(|c| c.incompfunc == 0 && !c.incompctlfunc));
	let Some(wname) = args.first() else {
		return done(i32::from(!usable));
	};
	if !usable {
		ctx.usage("widgets can only be called when ZLE is active");
		return done(1);
	}
	if resumed {
		return drive_task(ctx, |_| Task::Hooks);
	}
	let mut rest = &args[1..];
	let mut setbindk = false;
	let mut setlbindk = false;
	let mut mult: Option<Option<i64>> = None;
	let mut keymap: Option<BString> = None;
	while let Some(a) = rest.first() {
		if a.first() != Some(&b'-') {
			break;
		}
		if a.len() == 1 || a[1] == b'-' {
			rest = &rest[1..];
			break;
		}
		let mut j = 1;
		let mut consumed_next = false;
		while j < a.len() {
			let c = a[j];
			let tail = &a[j + 1..];
			let take = |consumed: &mut bool| -> Option<BString> {
				if tail.is_empty() {
					*consumed = true;
					rest.get(1).cloned()
				} else {
					Some(BString::from(tail))
				}
			};
			match c {
				b'f' => {
					let flag = take(&mut consumed_next);
					if flag.as_deref().map(|f| &f[..]) != Some(b"nolast") {
						ctx.usage("'nolast' expected after -f");
						return done(1);
					}
					setlbindk = true;
					break;
				},
				b'n' => {
					let Some(num) = take(&mut consumed_next) else {
						ctx.usage("number expected after -n");
						return done(1);
					};
					mult = Some(Some(atoi(&num)));
					break;
				},
				b'N' => mult = Some(None),
				b'K' => {
					let Some(km) = take(&mut consumed_next) else {
						ctx.usage("keymap expected after -K");
						return done(1);
					};
					keymap = Some(km);
					break;
				},
				b'w' => setbindk = true,
				_ => {
					let n = nice(ctx, a)?;
					ctx.usage(format!("unknown option: {n}"));
					return done(1);
				},
			}
			j += 1;
		}
		rest = &rest[if consumed_next { 2.min(rest.len()) } else { 1 }..];
	}
	let wname = wname.clone();
	let rest = rest.to_vec();
	let Some(z) = ctx.vp.zle.as_deref_mut() else {
		return done(1);
	};
	let Some(ed) = z.ed.as_deref_mut() else {
		return done(1);
	};
	let saved_zmod = mult.map(|m| {
		let saved = ed.zmod;
		if let Some(n) = m {
			ed.zmod.mult = n;
			ed.zmod.flags |= super::modflags::MULT;
		} else {
			ed.zmod.mult = 1;
			ed.zmod.flags &= !super::modflags::MULT;
		}
		saved
	});
	let restore_keymap = if let Some(km) = keymap {
		let old = ed.keymap.clone();
		if exec::selectkeymap(&z.keymaps, ed, &km, false).is_err() {
			if let Some(saved) = saved_zmod {
				ed.zmod = saved;
			}
			return done(1);
		}
		Some(old)
	} else {
		None
	};
	let mut t = ExecTask::from_zle(z, wname, rest, setbindk, setlbindk);
	t.restore_zmod = saved_zmod;
	t.restore_keymap = restore_keymap;
	drive_task(ctx, |_| Task::Exec(Box::new(t)))
}

/// C `atoi`: leading blanks, a sign, digits; 0 when there are none.
fn atoi(s: &[u8]) -> i64 {
	let s = s.trim_start();
	let (neg, digits) = match s.first() {
		Some(b'-') => (true, &s[1..]),
		Some(b'+') => (false, &s[1..]),
		_ => (false, s),
	};
	let mut n: i64 = 0;
	for &c in digits.iter().take_while(|c| c.is_ascii_digit()) {
		n = n.saturating_mul(10).saturating_add(i64::from(c - b'0'));
	}
	if neg { -n } else { n }
}
