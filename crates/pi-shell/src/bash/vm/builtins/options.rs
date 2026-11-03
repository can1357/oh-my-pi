//! Mode and zsh option builtins: `emulate` (both dialects), `setopt` and
//! `unsetopt` (zsh). Ported from zsh 5.9 `builtin.c` `bin_emulate` and
//! `options.c` `bin_setopt`, `parseopts`, `dosetopt`, `printoptionnode`,
//! `list_emulate_options` (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use bstr::BString;
use strum::IntoEnumIterator;

use super::{Control, Ctx, Need, Outcome, R, done};
use crate::bash::{
	diag::Diag,
	event::EventData,
	ids::{Dialect, ModeId},
	store::{OptId, OptKind, Sticky},
	syntax::zsh::tok::tail,
	vm::{exec::push_script, mode, proc::ScriptKind, state},
	zshopt::{ZshOpt, ZshOpts},
};

/// The emulation `emulate NAME` selects from code in `cur`: zsh's
/// `emulate` reads the first letter (after an `r`) for names it does not
/// know; `bash` is the engine's bash dialect. `None` for csh.
const fn target_mode(cur: ModeId, name: &[u8]) -> Option<ModeId> {
	if let Some(m) = cur.for_emulate(name) {
		return Some(m);
	}
	let c = match name {
		[b'r', c, ..] => *c,
		[c, ..] => *c,
		[] => 0,
	};
	match c {
		b'c' => None,
		b'k' => Some(ModeId::Ksh),
		b's' | b'b' => cur.for_emulate(b"sh"),
		_ => Some(ModeId::Zsh),
	}
}

/// zsh `dosetopt` for a builtin (not the command line), used by `setopt`
/// and zsh's `set`: `false` when the option cannot change (`interactive`,
/// `shinstdin` and `singlecommand` are fixed, `zle` needs a terminal,
/// `restricted` cannot be turned off), which zsh reports as `can't change
/// option`.
pub fn dosetopt(ctx: &mut Ctx<'_, '_>, opt: ZshOpt, on: bool) -> Result<bool, Need> {
	let cur = ctx.zsh_option(opt)?;
	let interactive = opt == ZshOpt::Exec && ctx.zsh_option(ZshOpt::Interactive)?;
	if opt.fixed(cur, on, interactive) {
		return Ok(false);
	}
	ctx.set_zsh_option(opt, on)?;
	Ok(true)
}

/// `setopt`/`unsetopt` without arguments (zsh `printoptionnode` over every
/// option, sorted): under `kshoptionprint` every option with its state,
/// else the options whose state differs from the emulation's default
/// (`setopt`) or equals it (`unsetopt`), `no`-prefixed where off.
fn list_options(ctx: &mut Ctx<'_, '_>, set: bool) -> R {
	let mode = ctx.vp.mode;
	let ksh = ctx.zsh_option(ZshOpt::Kshoptionprint)?;
	let mut out = Vec::new();
	for opt in ZshOpt::iter() {
		let on = ctx.zsh_option(opt)?;
		let def = opt.default_in(mode);
		let name: &'static str = opt.into();
		if ksh {
			let line = if def {
				format!("no{name:<19} {}\n", if on { "off" } else { "on" })
			} else {
				format!("{name:<21} {}\n", if on { "on" } else { "off" })
			};
			out.extend_from_slice(line.as_bytes());
		} else if set == (on != def) {
			if set != on {
				out.extend_from_slice(b"no");
			}
			out.extend_from_slice(name.as_bytes());
			out.push(b'\n');
		}
	}
	ctx.out(&out);
	done(0)
}

/// `setopt [±opts] [name …]` / `unsetopt …` (zsh `bin_setopt`).
pub fn setopt(ctx: &mut Ctx<'_, '_>, args: &[BString], unset: bool) -> R {
	if args.is_empty() {
		return list_options(ctx, !unset);
	}
	let mode = ctx.vp.mode;
	let mut status = 0;
	let mut i = 0;
	let mut matching = false;
	'opts: while let Some(arg) = args.get(i) {
		let Some(&sign @ (b'-' | b'+')) = arg.first() else {
			break;
		};
		let action = (sign == b'-') != unset;
		let arg: &[u8] = if arg.len() == 1 { b"--" } else { arg };
		let mut k = 1;
		while k < arg.len() {
			let c = arg[k];
			match c {
				b'-' => {
					i += 1;
					break 'opts;
				},
				b'o' => {
					let name = if k + 1 < arg.len() {
						BString::from(tail(arg, k + 1))
					} else {
						i += 1;
						let Some(next) = args.get(i) else {
							ctx.err(Diag::Usage { msg: "string expected after -o".into() });
							return done(1);
						};
						next.clone()
					};
					match ZshOpt::lookup(&name) {
						None => {
							ctx.err(Diag::NoSuchOption { name });
							status = 1;
						},
						Some((opt, inv)) => {
							if !dosetopt(ctx, opt, action != inv)? {
								ctx.usage(format!("can't change option: {name}"));
								status = 1;
							}
						},
					}
					break;
				},
				b'm' => matching = true,
				_ => match ZshOpt::letter(c, mode) {
					None => {
						ctx.usage(format!("bad option: -{}", char::from(c)));
						status = 1;
					},
					Some((opt, inv)) => {
						if !dosetopt(ctx, opt, action != inv)? {
							ctx.usage(format!("can't change option: -{}", char::from(c)));
							status = 1;
						}
					},
				},
			}
			k += 1;
		}
		i += 1;
	}
	if matching {
		ctx.diag(Diag::Unsupported { what: "setopt -m before zsh patterns are wired".into() });
		return done(1);
	}
	for name in tail(args, i.min(args.len())) {
		match ZshOpt::lookup(name) {
			None => {
				ctx.err(Diag::NoSuchOption { name: name.clone() });
				status = 1;
			},
			Some((opt, inv)) => {
				if !dosetopt(ctx, opt, unset == inv)? {
					ctx.usage(format!("can't change option: {name}"));
					status = 1;
				}
			},
		}
	}
	done(status)
}

/// `emulate [-lLR] [MODE [±o OPT]… [-c CMD]]` (zsh `bin_emulate`, both
/// dialects): no `MODE` prints the current emulation; `MODE` alone switches
/// to it (`-R` resets every option, `-L` makes options and traps local to
/// the calling function, `-l` only lists what would be set); `-c CMD` runs
/// `CMD` in it with options, mode and sticky emulation restored afterwards,
/// and every function defined meanwhile keeps that sticky emulation.
pub fn emulate(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	let (mut local, mut reset, mut list) = (false, false, false);
	let mut i = 0;
	while let Some(arg) = args.get(i) {
		if arg.first() != Some(&b'-') || arg.len() == 1 {
			break;
		}
		i += 1;
		if arg.as_slice() == b"--" {
			break;
		}
		for &ch in tail(arg, 1) {
			match ch {
				b'L' => local = true,
				b'R' => reset = true,
				b'l' => list = true,
				_ => {
					ctx.usage(format!("bad option: -{}", char::from(ch)));
					return done(1);
				},
			}
		}
	}
	let cur = ctx.vp.mode;
	let Some(name) = args.get(i) else {
		if local || reset {
			ctx.usage("not enough arguments");
			return done(1);
		}
		ctx.out(cur.emulation().as_bytes());
		ctx.out(b"\n");
		return done(0);
	};
	let Some(target) = target_mode(cur, name) else {
		ctx.diag(Diag::Unsupported { what: "csh emulation".into() });
		return done(1);
	};
	let rest = tail(args, i + 1);
	if rest.is_empty() {
		if list {
			if target.dialect() == Dialect::Zsh {
				let now = ctx.zsh_options()?;
				let mut new = mode::emulated_options(&now, target, reset);
				if local {
					for opt in [ZshOpt::Localoptions, ZshOpt::Localtraps, ZshOpt::Localpatterns] {
						new.set(opt, true);
					}
				}
				list_emulation(ctx, &new, reset);
			}
			return done(0);
		}
		ctx.emulate(target, reset)?;
		if local && target.dialect() == Dialect::Zsh {
			for opt in [ZshOpt::Localoptions, ZshOpt::Localtraps, ZshOpt::Localpatterns] {
				ctx.set_zsh_option(opt, true)?;
			}
		}
		return done(0);
	}
	if list {
		ctx.usage("too many arguments for -l");
		return done(1);
	}
	// zsh `parseopts` (not at the top level): `±o NAME`, option letters
	// and `-c CMD`; on and off lists in option order (sticky comparison).
	let mut on: Vec<ZshOpt> = Vec::new();
	let mut off: Vec<ZshOpt> = Vec::new();
	let mut bash_opts: Vec<(OptId, bool)> = Vec::new();
	let mut cmd: Option<BString> = None;
	let mut pos = 0;
	let mut command = false;
	'opts: while let Some(arg) = rest.get(pos) {
		let Some(&sign @ (b'-' | b'+')) = arg.first() else {
			break;
		};
		let value = sign == b'-';
		if arg.len() == 1 || arg.as_slice() == b"--" {
			pos += 1;
			break;
		}
		let mut at = 1;
		while at < arg.len() {
			let ch = arg[at];
			match ch {
				b'c' => command = true,
				b'o' => {
					let name = if at + 1 < arg.len() {
						BString::from(tail(arg, at + 1))
					} else {
						pos += 1;
						let Some(next_arg) = rest.get(pos) else {
							ctx.usage("string expected after -o");
							return done(1);
						};
						next_arg.clone()
					};
					if target.dialect() == Dialect::Bash {
						let Some(opt) = OptId::from_name(&name).filter(|o| o.kind() == OptKind::Set)
						else {
							ctx.err(Diag::NoSuchOption { name });
							return done(1);
						};
						bash_opts.push((opt, value));
					} else {
						let Some((opt, inv)) = ZshOpt::lookup(&name) else {
							ctx.err(Diag::NoSuchOption { name });
							return done(1);
						};
						note(&mut on, &mut off, opt, value != inv);
					}
					break;
				},
				_ if target.dialect() == Dialect::Zsh => {
					let Some((opt, inv)) = ZshOpt::letter(ch, target) else {
						ctx.usage(format!("bad option: -{}", char::from(ch)));
						return done(1);
					};
					note(&mut on, &mut off, opt, value != inv);
				},
				_ => {
					ctx.usage(format!("bad option: -{}", char::from(ch)));
					return done(1);
				},
			}
			at += 1;
		}
		pos += 1;
		if command {
			break 'opts;
		}
	}
	if command {
		let Some(text) = rest.get(pos) else {
			ctx.usage("string expected after -c");
			return done(1);
		};
		cmd = Some(text.clone());
		pos += 1;
	}
	if let Some(extra) = rest.get(pos) {
		ctx.usage(format!("unknown argument {extra}"));
		return done(1);
	}
	let Some(cmd) = cmd else {
		ctx.emulate(target, reset)?;
		apply_listed(ctx, &on, &off, &bash_opts)?;
		if local && target.dialect() == Dialect::Zsh {
			for opt in [ZshOpt::Localoptions, ZshOpt::Localtraps, ZshOpt::Localpatterns] {
				ctx.set_zsh_option(opt, true)?;
			}
		}
		return done(0);
	};
	if local {
		ctx.usage("option -L incompatible with -c");
		return done(1);
	}
	let saved = mode::save_for_emulate(&mut ctx.k.root, ctx.cx.store, ctx.vp)?;
	ctx.emulate(target, reset)?;
	apply_listed(ctx, &on, &off, &bash_opts)?;
	ctx.vp
		.set_sticky(Some(Sticky { mode: target, full: reset, on, off }));
	// The command runs as `eval` text in the new mode (zsh's `eval`:
	// `(eval)` diagnostics, lines from 1).
	ctx.vp.status = 0;
	push_script(ctx.vp, &cmd, 1, ScriptKind::Eval);
	ctx.vp.push_restore(*saved);
	ctx.k.emit_op(ctx.cx, ctx.vp, 0, EventData::EvalEnter);
	Ok(Outcome { status: 0, control: Control::Frame })
}

/// Record `opt` in zsh's sticky on/off lists (zsh `parseopts_insert`:
/// option order, the last setting wins).
fn note(on: &mut Vec<ZshOpt>, off: &mut Vec<ZshOpt>, opt: ZshOpt, value: bool) {
	on.retain(|&o| o != opt);
	off.retain(|&o| o != opt);
	let list = if value { on } else { off };
	let at = list.partition_point(|&o| o < opt);
	list.insert(at, opt);
}

/// Set the options `emulate … ±o` named.
fn apply_listed(
	ctx: &mut Ctx<'_, '_>,
	on: &[ZshOpt],
	off: &[ZshOpt],
	bash: &[(OptId, bool)],
) -> Result<(), Need> {
	for &opt in on {
		ctx.set_zsh_option(opt, true)?;
	}
	for &opt in off {
		ctx.set_zsh_option(opt, false)?;
	}
	for &(opt, value) in bash {
		ctx.set_option(opt, value);
	}
	Ok(())
}

/// `emulate -l`: the emulation-relevant options (every non-special one
/// with `-R`) as they would be, `no`-prefixed where off (zsh
/// `list_emulate_options`).
fn list_emulation(ctx: &mut Ctx<'_, '_>, opts: &ZshOpts, full: bool) {
	let mut out = Vec::new();
	for opt in ZshOpt::iter() {
		if (full && !opt.special()) || opt.emulation_relevant() {
			if !opts.get(opt) {
				out.extend_from_slice(b"no");
			}
			out.extend_from_slice(<&'static str>::from(opt).as_bytes());
			out.push(b'\n');
		}
	}
	ctx.out(&out);
}

impl Ctx<'_, '_> {
	/// Every zsh option as this vproc sees it.
	fn zsh_options(&mut self) -> Result<ZshOpts, Need> {
		Ok(state::zsh_options(&mut self.k.root, self.cx.store, self.vp)?)
	}

	/// Switch to emulation `mode` ([`mode::emulate`]).
	fn emulate(&mut self, mode: ModeId, full: bool) -> Result<(), Need> {
		Ok(mode::emulate(&mut self.k.root, self.cx.store, self.vp, mode, full)?)
	}
}
