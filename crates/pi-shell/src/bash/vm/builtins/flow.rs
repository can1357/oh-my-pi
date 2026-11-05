//! Control-flow builtins: `eval`, `source`, `return`, `exit`, `break`,
//! `continue`, `wait`.

use bstr::{BString, ByteSlice};

use super::{Control, Ctx, Outcome, R, Wait, done, number, opts};
use crate::bash::{
	diag::Diag,
	event::EventData,
	fs::StatKind,
	ids::Vpid,
	store::{Key, KeyBuf, MiscKey, OptId, Record},
	vm::{
		exec::push_script,
		locale,
		probe::{absolute, candidates},
		proc::{Probe, ProbeResult, ScriptKind},
		quote,
	},
};

/// `eval arg …`: run the joined arguments as a script in this shell.
pub fn eval(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	// bash's `no_options`: `--` is skipped, any option is invalid.
	let args = match opts(ctx, args, b"", b"", false) {
		Ok(o) => o.rest,
		Err(st) => return done(st),
	};
	if args.is_empty() {
		return done(0);
	}
	let src = bstr::join(b" ", args);
	// zsh numbers eval'd text from 1 under `evallineno` (its `(eval):N:`
	// diagnostics and `$LINENO`).
	let line = if ctx.vp.mode.dialect() == crate::bash::ids::Dialect::Zsh
		&& ctx.zsh_option(crate::bash::zshopt::ZshOpt::Evallineno)?
	{
		1
	} else {
		ctx.line
	};
	// `$?` stays the caller's until the text runs its first command; text
	// without one ends with status 0 (the script frame's end).
	push_script(ctx.vp, &src, line, ScriptKind::Eval);
	ctx.k.emit_op(ctx.cx, ctx.vp, 0, EventData::EvalEnter);
	Ok(Outcome { status: 0, control: Control::Frame })
}

/// `source [-p path] file [args]` / `. …`: run `file` in this shell. A
/// name without `/` is looked up in `-p`'s path (only there) or, with
/// `sourcepath`, in `$PATH` and then the current directory (not in posix
/// mode). In posix mode a failure ends the shell (a special builtin, not
/// through `command`).
pub fn source(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	let (search_arg, args) = match args {
		[p, path, rest @ ..] if p.as_slice() == b"-p" => (Some(path), rest),
		[dd, rest @ ..] if dd.as_slice() == b"--" => (None, rest),
		[opt, ..] if opt.len() > 1 && opt[0] == b'-' => {
			ctx.err(Diag::Usage { msg: format!("-{}: invalid option", opt[1] as char).into() });
			ctx.builtin_usage();
			return done(2);
		},
		_ => (None, args),
	};
	let Some((file, rest)) = args.split_first() else {
		ctx.usage("filename argument required");
		ctx.builtin_usage();
		return done(2);
	};
	let posix = ctx.option(OptId::Posix)?;
	let mut path = None;
	if !file.contains(&b'/') {
		let search = match search_arg {
			Some(p) if p.is_empty() => Some(BString::from(".")),
			Some(p) => Some(p.clone()),
			None if ctx.option(OptId::Sourcepath)? => Some(ctx.scalar(b"PATH")?.unwrap_or_default()),
			None => None,
		};
		if let Some(search) = search {
			let cwd = ctx.vp.cwd.clone();
			for cand in candidates(&search, file, &cwd) {
				if let ProbeResult::Stat(Some(st)) =
					ctx.probe(Probe::Stat { path: cand.clone(), follow: true })?
					&& st.kind == StatKind::File
				{
					path = Some(cand);
					break;
				}
			}
			if path.is_none() && (search_arg.is_some() || posix) {
				let utf8 = locale::is_utf8(ctx.k, ctx.cx.store, ctx.vp);
				let name = quote::printable_filename(file, utf8, false);
				ctx.err(Diag::Usage { msg: format!("{}: file not found", name.as_bstr()).into() });
				ctx.usage_error = true;
				return done(1);
			}
		}
	}
	// bash's `_evalfile` names the file it found.
	let shown = path.clone().unwrap_or_else(|| file.clone());
	let path = path.unwrap_or_else(|| absolute(&ctx.vp.cwd, file));
	let text = match ctx.probe(Probe::Read { path: path.clone() })? {
		ProbeResult::Bytes(Ok(text)) => text,
		ProbeResult::Bytes(Err(msg)) if msg.as_slice() == b"Is a directory" => {
			ctx.err(Diag::Usage { msg: format!("{}: is a directory", shown.as_bstr()).into() });
			return done(1);
		},
		ProbeResult::Bytes(Err(msg)) => {
			ctx.diag(Diag::Usage { msg: format!("{}: {}", file.as_bstr(), msg.as_bstr()).into() });
			ctx.usage_error = true;
			return done(1);
		},
		_ => {
			ctx.diag(Diag::NoSuchFile { name: file.clone() });
			ctx.usage_error = true;
			return done(1);
		},
	};
	// bash drops NUL bytes from a sourced file; more than 256 make it a
	// binary file (`EX_BINARY_FILE`).
	let nuls = text.find_iter(b"\0").count();
	if nuls > 256 {
		ctx.err(Diag::Usage {
			msg: format!("{}: cannot execute binary file", shown.as_bstr()).into(),
		});
		return done(126);
	}
	let text = if nuls == 0 {
		text
	} else {
		text.iter().copied().filter(|&c| c != 0).collect()
	};
	if !rest.is_empty()
		&& let Some(top) = crate::bash::vm::state::scope_count(&ctx.k.root, ctx.vp).checked_sub(1)
	{
		crate::bash::vm::state::set_scope_positional(
			&mut ctx.k.root,
			ctx.cx.store,
			ctx.vp,
			top,
			Some(rest.to_vec()),
		);
	}
	// As for `eval`: the file sees the caller's `$?`.
	push_script(ctx.vp, &text, 1, ScriptKind::Source);
	// `BASH_SOURCE` shows the name as given.
	crate::bash::vm::callstack::push_source(
		ctx.k,
		ctx.cx.store,
		ctx.vp,
		file.clone(),
		ctx.line,
		rest,
	)?;
	ctx.k
		.emit_op(ctx.cx, ctx.vp, 0, EventData::SourceEnter { path: path.as_bstr() });
	Ok(Outcome { status: 0, control: Control::Frame })
}

/// zsh `. file [args]` / `source file [args]` (`bin_dot`): `source` tries
/// the current directory first; a name with a `/` is used as is; else the
/// file is looked up in `$PATH` (an empty or `.` entry is the current
/// directory). Not found: `no such file or directory` (an error under
/// `posixbuiltins`) and status 127; a syntax error in the file makes it
/// 126; else the file's last status.
pub fn zsh_source(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	let Some((file, rest)) = args.split_first() else {
		return done(0);
	};
	let cwd = ctx.vp.cwd.clone();
	let regular =
		|r: ProbeResult| matches!(r, ProbeResult::Stat(Some(st)) if st.kind != StatKind::Dir);
	let mut path = None;
	if ctx.name == "source" {
		let here = absolute(&cwd, file);
		if regular(ctx.probe(Probe::Stat { path: here.clone(), follow: true })?) {
			path = Some(here);
		}
	}
	if path.is_none() && file.contains(&b'/') {
		let here = absolute(&cwd, file);
		if regular(ctx.probe(Probe::Stat { path: here.clone(), follow: true })?) {
			path = Some(here);
		}
	} else if path.is_none() {
		let search = ctx.scalar(b"PATH")?.unwrap_or_default();
		for dir in search.split(|&c| c == b':') {
			let cand = if dir.is_empty() || dir == b"." {
				absolute(&cwd, file)
			} else {
				let mut p = BString::from(dir);
				p.push(b'/');
				p.extend_from_slice(file);
				absolute(&cwd, &p)
			};
			if regular(ctx.probe(Probe::Stat { path: cand.clone(), follow: true })?) {
				path = Some(cand);
				break;
			}
		}
	}
	let Some(path) = path else {
		ctx.err(Diag::NoSuchFile { name: file.clone() });
		if ctx.zsh_option(crate::bash::zshopt::ZshOpt::Posixbuiltins)? {
			return Ok(Outcome { status: 127, control: Control::DiscardAll });
		}
		return done(127);
	};
	let ProbeResult::Bytes(Ok(text)) = ctx.probe(Probe::Read { path: path.clone() })? else {
		ctx.err(Diag::NoSuchFile { name: file.clone() });
		return done(127);
	};
	if !rest.is_empty()
		&& let Some(top) = crate::bash::vm::state::scope_count(&ctx.k.root, ctx.vp).checked_sub(1)
	{
		crate::bash::vm::state::set_scope_positional(
			&mut ctx.k.root,
			ctx.cx.store,
			ctx.vp,
			top,
			Some(rest.to_vec()),
		);
	}
	push_script(ctx.vp, &text, 1, ScriptKind::Source);
	crate::bash::vm::callstack::push_source(
		ctx.k,
		ctx.cx.store,
		ctx.vp,
		file.clone(),
		ctx.line,
		rest,
	)?;
	ctx.k
		.emit_op(ctx.cx, ctx.vp, 0, EventData::SourceEnter { path: path.as_bstr() });
	Ok(Outcome { status: ctx.vp.status, control: Control::Frame })
}

/// zsh `autoload -X` in an autoload stub's body (zsh `bin_autoload` with
/// `-X`, `eval_autoload`): load the running function's definition from
/// `$fpath`, put it in place of the stub and call it with the stub's
/// arguments; its status is the stub's.
pub fn zsh_autoload_x(ctx: &mut Ctx<'_, '_>) -> R {
	let running = ctx.vp.frames.iter().rev().find_map(|f| match &f.kind {
		crate::bash::vm::proc::FrameKind::Function { name, .. } => Some(name.clone()),
		_ => None,
	});
	let Some(name) = running else {
		ctx.usage("-X: not in a function");
		return done(1);
	};
	let fpath = ctx.scalar(b"FPATH")?.unwrap_or_default();
	let cwd = ctx.vp.cwd.clone();
	let mut found = None;
	for dir in fpath.split(|&c| c == b':').filter(|d| !d.is_empty()) {
		let mut path = BString::from(dir);
		path.push(b'/');
		path.extend_from_slice(&name);
		let path = absolute(&cwd, &path);
		let regular = matches!(
			ctx.probe(Probe::Stat { path: path.clone(), follow: true })?,
			ProbeResult::Stat(Some(st)) if st.kind != StatKind::Dir
		);
		if regular
			&& let ProbeResult::Bytes(Ok(text)) = ctx.probe(Probe::Read { path: path.clone() })?
		{
			found = Some((path, text));
			break;
		}
	}
	let Some((path, text)) = found else {
		ctx.diag(Diag::Usage {
			msg: format!("{}: function definition file not found", name.as_bstr()).into(),
		});
		return done(1);
	};
	let attrs = match ctx.function(&name)? {
		Some(Record::Func { attrs, .. }) => attrs,
		_ => crate::bash::store::Attrs::NONE,
	};
	let mode = ctx.vp.mode;
	if !crate::bash::vm::command::define_autoloaded(
		ctx.k, ctx.vp, ctx.cx, &name, &text, path, mode, attrs,
	) {
		return done(1);
	}
	let mut src = name.to_vec();
	src.extend_from_slice(b" \"$@\"\n");
	push_script(ctx.vp, &src, ctx.line, ScriptKind::Eval);
	Ok(Outcome { status: 0, control: Control::Frame })
}

/// A bad argument to `return`, `exit`, `break` or `continue` (reported).
#[derive(Clone, Copy, PartialEq, Eq)]
enum BadArg {
	/// Not a number (bash's `EX_USAGE`).
	NotNumeric,
	/// More than one argument (status 2).
	TooMany,
}

/// The numeric argument of `return`, `exit`, `break`, `continue`, after an
/// optional `--`.
fn numeric_arg(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> Result<Option<i64>, BadArg> {
	let args = match args.first() {
		Some(a) if a.as_slice() == b"--" => &args[1..],
		_ => args,
	};
	let Some(a) = args.first() else {
		return Ok(None);
	};
	let Some(n) = number(a) else {
		ctx.diag(Diag::NumericArg { cmd: ctx.name.into(), arg: a.clone() });
		ctx.usage_error = true;
		return Err(BadArg::NotNumeric);
	};
	if args.len() > 1 {
		ctx.diag(Diag::TooManyArgs { cmd: ctx.name.into() });
		return Err(BadArg::TooMany);
	}
	Ok(Some(n))
}

/// A status argument (`return`, `exit`): the low 8 bits.
fn status_arg(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> Result<Option<i32>, BadArg> {
	Ok(numeric_arg(ctx, args)?.map(|n| (n & 0xff) as i32))
}

/// `return [n]`. Outside a function, `.` file or `${ ;}` (and not in a
/// subshell of a function) it is an error, fatal to a posix shell.
pub fn return_(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	use crate::bash::vm::proc::FrameKind;
	let target = ctx.vp.frames.iter().any(|f| {
		matches!(
			f.kind,
			FrameKind::Function { .. }
				| FrameKind::NoFork
				| FrameKind::Script { what: ScriptKind::Source, .. }
		)
	}) || (ctx.vp.parent.is_some()
		&& crate::bash::vm::state::in_function(&ctx.k.root, ctx.cx.store, ctx.vp)?);
	// The arguments are checked first (`return 1 2` anywhere is "too many
	// arguments").
	let arg = status_arg(ctx, args);
	if !target && !matches!(arg, Err(BadArg::TooMany)) {
		ctx.err(Diag::Usage { msg: "can only `return' from a function or sourced script".into() });
		ctx.usage_error = true;
		return done(2);
	}
	let status = match arg {
		Ok(Some(n)) => n,
		Ok(None) => ctx
			.vp
			.frames
			.iter()
			.rev()
			.find_map(|f| match f.kind {
				FrameKind::Script { what: ScriptKind::Trap { status, .. }, .. } => Some(status),
				FrameKind::Function { .. } | FrameKind::Script { what: ScriptKind::Source, .. } => {
					Some(ctx.vp.status)
				},
				_ => None,
			})
			.unwrap_or(ctx.vp.status),
		// bash returns 2 from the function; extra arguments are only an
		// error.
		Err(BadArg::NotNumeric) => 2,
		Err(BadArg::TooMany) => return done(2),
	};
	Ok(Outcome { status, control: Control::Return })
}

/// `logout [n]`: `exit` in a login shell, else an error.
pub fn logout(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	if ctx.option(OptId::LoginShell)? {
		return exit(ctx, args);
	}
	ctx.err(Diag::Usage { msg: "not login shell: use `exit'".into() });
	done(1)
}

/// `exit [n]`.
pub fn exit(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	// A bad argument (`exit status`, too many) is reported and the shell
	// goes on (status 2), as bash 5.3 does outside posix mode.
	let status = match status_arg(ctx, args) {
		Ok(n) => n.unwrap_or(ctx.vp.status),
		Err(_) => return done(2),
	};
	if let Some(outcome) = bash_logout(ctx, status)? {
		return Ok(outcome);
	}
	Ok(Outcome { status, control: Control::Exit })
}

/// bash's `bash_logout`: `exit`/`logout` in a login shell (not a subshell)
/// first sources `~/.bash_logout`, once; the shell then exits with
/// `status` (`builtin exit N` runs after the file).
fn bash_logout(ctx: &mut Ctx<'_, '_>, status: i32) -> Result<Option<Outcome>, super::Need> {
	if !ctx.option(OptId::LoginShell)?
		|| crate::bash::vm::nested::in_subshell(ctx.cx.store, ctx.vp)
		|| ctx.record(Key::Misc(MiscKey::LoggedOut))?.is_some()
	{
		return Ok(None);
	}
	let Some(home) = ctx.scalar(b"HOME")? else {
		return Ok(None);
	};
	let mut path = home;
	path.extend_from_slice(b"/.bash_logout");
	let ProbeResult::Bytes(Ok(text)) = ctx.probe(Probe::Read { path: path.clone() })? else {
		return Ok(None);
	};
	ctx.store_record(KeyBuf::Misc(MiscKey::LoggedOut), Some(Record::Misc(BString::from("1"))));
	ctx.vp.status = status;
	push_script(ctx.vp, format!("builtin exit {status}\n").as_bytes(), ctx.line, ScriptKind::Eval);
	push_script(ctx.vp, &text, 1, ScriptKind::Source);
	ctx.k
		.emit_op(ctx.cx, ctx.vp, 0, EventData::SourceEnter { path: path.as_bstr() });
	Ok(Some(Outcome { status, control: Control::Frame }))
}

/// `break [n]` / `continue [n]`. A count below 1 is reported and leaves
/// every loop (status 1); a non-numeric one ends the (non-interactive)
/// shell.
pub fn break_(ctx: &mut Ctx<'_, '_>, args: &[BString], cont: bool) -> R {
	let n = match numeric_arg(ctx, args) {
		Ok(None) => 1,
		Ok(Some(n)) if n >= 1 => u32::try_from(n).unwrap_or(u32::MAX),
		Ok(Some(n)) => {
			ctx.err(Diag::Usage { msg: format!("{n}: loop count out of range").into() });
			return Ok(Outcome { status: 1, control: Control::Break { n: u32::MAX, cont: false } });
		},
		Err(BadArg::NotNumeric) => return Ok(Outcome { status: 2, control: Control::Exit }),
		Err(BadArg::TooMany) => return done(2),
	};
	Ok(Outcome { status: 0, control: Control::Break { n, cont } })
}

/// zsh `bin_break`'s numeric argument (evaluated arithmetically, zsh
/// `mathevali`), or `None` without one; `Err` is the outcome of a bad one
/// (reported: an error, which abandons the command line).
fn zsh_arg(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> Result<Option<i64>, Outcome> {
	let args = match args.first() {
		Some(a) if a.as_slice() == b"--" => &args[1..],
		_ => args,
	};
	match args {
		[] => Ok(None),
		[a] => match crate::bash::vm::expand::arith_value(ctx.k, ctx.cx, ctx.vp, a) {
			Ok(n) => Ok(Some(n)),
			Err(d) => {
				ctx.err(d);
				Err(Outcome { status: 1, control: Control::DiscardAll })
			},
		},
		_ => {
			ctx.usage("too many arguments");
			Err(Outcome { status: 1, control: Control::None })
		},
	}
}

/// zsh `break [n]` / `continue [n]` (`bin_break`): a count that is not
/// positive, or no loop to leave, is an error (it abandons the command
/// line); a count beyond the loops running leaves them all. Loops count
/// across function calls (zsh's `loops`).
pub fn zsh_break(ctx: &mut Ctx<'_, '_>, args: &[BString], cont: bool) -> Outcome {
	let num = match zsh_arg(ctx, args) {
		Ok(n) => n,
		Err(outcome) => return outcome,
	};
	if let Some(n) = num
		&& n <= 0
	{
		ctx.usage(format!("argument is not positive: {n}"));
		return Outcome { status: 1, control: Control::DiscardAll };
	}
	let loops = crate::bash::vm::exec::zsh_loop_count(ctx.vp);
	if loops == 0 {
		ctx.usage("not in while, until, select, or repeat loop");
		return Outcome { status: 1, control: Control::DiscardAll };
	}
	let n = num.map_or(1, |n| u32::try_from(n).unwrap_or(u32::MAX).min(loops));
	Outcome { status: 0, control: Control::Break { n, cont } }
}

/// zsh `return [n]` (`bin_break`): `$?` by default; outside a function or
/// `.` file it leaves the shell (the engine's return handling). The status
/// is zsh's `int lastval`, not cut to 8 bits (`return -1` makes `$?` -1).
pub fn zsh_return(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> Outcome {
	let status = match zsh_arg(ctx, args) {
		Ok(n) => n.map_or(ctx.vp.status, |n| n as i32),
		Err(outcome) => return outcome,
	};
	Outcome { status, control: Control::Return }
}

/// zsh `exit [n]` (`bin_break`): `$?` by default; inside a function the
/// functions return first (their `always` lists and `EXIT` traps run).
pub fn zsh_exit(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> Outcome {
	let status = match zsh_arg(ctx, args) {
		Ok(n) => n.map_or(ctx.vp.status, |n| (n & 0xff) as i32),
		Err(outcome) => return outcome,
	};
	Outcome { status, control: Control::Exit }
}

/// `wait [-fn] [-p var] [id …]` (bash `wait.def`): wait for background
/// children of this shell, by pid or job spec, or all of them; `-n` for
/// the first of them to finish; `-p var` gets the waited pid. With job
/// control a job that stops ends the wait unless `-f`.
pub fn wait(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	let o = match opts(ctx, args, b"fn", b"p", false) {
		Ok(o) => o,
		Err(st) => return done(st),
	};
	let any = o.has(b'n');
	let force = o.has(b'f');
	let into = o.arg(b'p').cloned();
	if let Some(name) = &into {
		// bash checks the name, then unsets it (`wait -p v` with nothing to
		// wait for leaves `v` unset).
		let (base, index) = super::split_subscript(name);
		if !crate::bash::vm::is_ident(base) {
			ctx.err(Diag::InvalidIdent { name: name.clone() });
			return done(1);
		}
		if index.is_none() {
			// `readonly WV` without a value is declared but unset: still
			// readonly.
			let readonly =
				crate::bash::vm::state::lookup_declared(&ctx.k.root, ctx.cx.store, ctx.vp, base)?
					.is_some_and(|v| v.attrs.contains(crate::bash::store::Attrs::READONLY));
			if readonly {
				ctx.usage(format!("{}: cannot unset: readonly variable", base.as_bstr()));
				return done(1);
			}
			crate::bash::vm::state::unset_var(&mut ctx.k.root, ctx.cx.store, ctx.vp, base, false);
		}
	}
	let args = o.rest;
	if any {
		return wait_any(ctx, args, into);
	}
	if args.is_empty() {
		return wait_all(ctx, force);
	}
	let mut list = Vec::new();
	let mut status = 0;
	// Trailing operands that named no running child (a kept status, or an
	// error with pid 0): bash returns the last operand's status.
	let mut kept = None;
	let zsh = ctx.vp.mode.dialect() == crate::bash::ids::Dialect::Zsh;
	for a in args {
		if zsh && !a.iter().all(u8::is_ascii_digit) {
			// zsh `bin_fg`: any other word is a job spec; a bad one ends
			// the arguments with status 127.
			if let Some(v) = zsh_wait_job(ctx, a)? {
				list.push(v);
				continue;
			}
			status = 127;
			break;
		}
		if a.first().is_some_and(u8::is_ascii_digit) {
			let Some(pid) = number(a).and_then(|n| u32::try_from(n).ok()) else {
				// bash returns at once on a malformed pid: it waits for no
				// operand it had already read, and its result names no child,
				// so `wait -p` writes no variable.
				ctx.usage(format!("`{}': not a pid or valid job spec", a.as_bstr()));
				return done(1);
			};
			match child(ctx, pid) {
				Child::Waitable(v) => {
					list.push(v);
					kept = None;
				},
				Child::Kept(s) => kept = Some((pid, s)),
				Child::None => {
					ctx.usage(format!("pid {pid} is not a child of this shell"));
					status = 127;
					kept = Some((0, 127));
				},
			}
		} else if a.starts_with(b"%") {
			match super::jobs::spec(ctx, a) {
				Ok(n) => {
					let job = ctx.vp.jobs.get(n).map(|j| (j.vpid, j.state));
					if let Some((_, crate::bash::vm::proc::JobState::Stopped(_))) = job {
						ctx.diag(Diag::Warning {
							msg: format!("warning: wait_for_job: job {n} is stopped").into(),
						});
					}
					list.extend(job.map(|(v, _)| v));
					kept = None;
				},
				Err(bad) => {
					if matches!(bad, super::jobs::Bad::Missing) {
						super::jobs::no_such_job(ctx, a);
					}
					status = 127;
					kept = Some((0, 127));
				},
			}
		} else {
			ctx.usage(format!("`{}': not a pid or valid job spec", a.as_bstr()));
			status = 1;
			kept = Some((0, 1));
		}
	}
	if list.is_empty() && kept.is_none() {
		return done(status);
	}
	let wait = Wait { children: list, all: false, any: false, into, force, foreground: false, kept };
	Ok(Outcome { status, control: Control::Wait(wait) })
}

/// zsh `getjob` and `bin_fg`'s in-use check for `wait SPEC`: the job's
/// vpid, or `None` after zsh's warning (silent under `posixbuiltins`). A
/// finished job is gone from zsh's table (it is deleted when reported),
/// so `%%`, `%+`, `%-` and `%N` naming none are `SPEC: no such job`; a
/// name or `%?text` matching none is `job not found: …`.
fn zsh_wait_job(ctx: &mut Ctx<'_, '_>, word: &[u8]) -> Result<Option<Vpid>, super::Need> {
	let rest = word.strip_prefix(b"%").unwrap_or(word);
	let found = match ctx.vp.jobs.lookup(rest) {
		crate::bash::vm::proc::JobLookup::Job(n) => ctx
			.vp
			.jobs
			.get(n)
			.filter(|j| !matches!(j.state, crate::bash::vm::proc::JobState::Done(_)))
			.map(|j| j.vpid),
		_ => None,
	};
	if found.is_none() && !ctx.zsh_option(crate::bash::zshopt::ZshOpt::Posixbuiltins)? {
		let numbered = word.first() == Some(&b'%')
			&& rest
				.first()
				.is_none_or(|&c| matches!(c, b'%' | b'+' | b'-') || c.is_ascii_digit());
		// With no job at all zsh has no current (previous) job either.
		let empty = ctx.vp.jobs.iter().next().is_none();
		if numbered && empty && matches!(rest, b"" | b"%" | b"+") {
			ctx.usage("no current job");
		} else if numbered && empty && rest == b"-" {
			ctx.usage("no previous job");
		} else if numbered {
			ctx.usage(format!("{}: no such job", word.as_bstr()));
		} else {
			ctx.usage(format!("job not found: {}", rest.as_bstr()));
		}
	}
	Ok(found)
}

/// What a pid operand of `wait` names.
enum Child {
	/// A job of this shell, or the process substitution or coprocess `$!`
	/// names (running or not yet collected): wait for it.
	Waitable(Vpid),
	/// The kept status of a child that left the job table (bash `bgpids`).
	Kept(i32),
	/// Not a child of this shell.
	None,
}

/// Resolve pid operand `pid` of `wait` (bash `wait_for_single_pid`): a job
/// first, then a kept status, then another child of this vproc (a process
/// substitution). A subshell copies `$!` but not its parent's children.
fn child(ctx: &mut Ctx<'_, '_>, pid: u32) -> Child {
	if let Some(job) = ctx.vp.jobs.by_pid(pid).filter(|j| !j.inherited) {
		return Child::Waitable(job.vpid);
	}
	if let Some(status) = ctx.vp.jobs.kept_status(pid) {
		return Child::Kept(status);
	}
	// Any other child of this vproc not yet collected: a process
	// substitution, whether or not `$!` still names it.
	let v = ctx.vp.vpid_of(pid);
	if ctx.vp.jobs.by_vpid(v).is_none() && ctx.k.started(ctx.cx.store, ctx.vp.vpid, v) {
		Child::Waitable(v)
	} else {
		Child::None
	}
}

/// `wait` without operands: every running job (bash
/// `wait_for_background_pids`); with job control a stopped job is skipped
/// with a warning. A command substitution's copies of its parent's jobs
/// are not its children.
fn wait_all(ctx: &mut Ctx<'_, '_>, force: bool) -> R {
	use crate::bash::vm::proc::JobState;
	let control = super::jobs::active(ctx)?;
	let foreign: Vec<u32> = ctx
		.vp
		.jobs
		.iter()
		.filter(|j| j.inherited && j.state == JobState::Running)
		.map(crate::bash::vm::proc::Job::pid)
		.collect();
	for pid in foreign {
		ctx.usage(format!("pid {pid} is not a child of this shell"));
	}
	ctx.vp.jobs.remove_where(|j| j.inherited);
	// bash `mark_dead_jobs_as_notified`: the job `$!` names stays, with its
	// status, when it had finished before the `wait` and nothing reported it
	// yet (`jobs`, `wait` of it). "Before" means the shell had noticed
	// (`JobTable::bang_seen`): a job that ends while the shell runs builtins
	// is still running for bash's `wait`.
	let keep = ctx.vp.last_bg.vpid().filter(|&v| {
		ctx.vp.jobs.by_vpid(v).is_some_and(|job| {
			matches!(job.state, JobState::Done(_)) && !job.notified && ctx.vp.jobs.bang_seen() == v.0
		})
	});
	let mut list = Vec::new();
	let mut stopped = Vec::new();
	for job in ctx.vp.jobs.iter() {
		match job.state {
			JobState::Stopped(_) if control => {
				stopped.push((job.number, job.pid()));
			},
			JobState::Done(_) => {},
			_ => list.push(job.vpid),
		}
	}
	for (number, pid) in stopped {
		ctx.err(Diag::Warning { msg: format!("warning: job {number}[{pid}] stopped").into() });
	}
	// bash also waits for the process substitution `$!` names.
	if let Some(last) = ctx.vp.last_bg.vpid()
		&& ctx.vp.jobs.by_vpid(last).is_none()
		&& ctx.k.proc_state(ctx.cx.store, last) == Some(crate::bash::vm::ProcState::Running)
		&& ctx.k.started(ctx.cx.store, ctx.vp.vpid, last)
	{
		list.push(last);
	}
	let wait = Wait {
		children: list,
		all: true,
		any: false,
		into: None,
		force,
		foreground: false,
		kept: keep.map(|v| (v.0, 0)),
	};
	Ok(Outcome { status: 0, control: Control::Wait(wait) })
}

/// `wait -n [id …]`: the first of the jobs (all without operands) to
/// finish (bash `wait_for_any_job`). A pid that left the job table with a
/// kept status, or a finished process substitution, answers at once (bash
/// 5.3 `check_nonjobs`). The handler takes a job nothing reported first.
/// 127 when there is nothing to wait for.
fn wait_any(ctx: &mut Ctx<'_, '_>, args: &[BString], into: Option<BString>) -> R {
	let mut list: Vec<(u32, Vpid)> = Vec::new();
	let mut subs: Vec<Vpid> = Vec::new();
	if args.is_empty() {
		list.extend(
			ctx.vp
				.jobs
				.iter()
				.filter(|j| !j.inherited)
				.map(|j| (j.number, j.vpid)),
		);
	} else {
		for a in args {
			let Some(pid) = number(a).and_then(|n| u32::try_from(n).ok()) else {
				continue;
			};
			if ctx.vp.jobs.by_pid(pid).is_some() {
				continue;
			}
			let kept = ctx.vp.jobs.kept_status(pid).or_else(|| {
				let v = ctx.vp.vpid_of(pid);
				if !ctx.k.started(ctx.cx.store, ctx.vp.vpid, v) {
					return None;
				}
				// bash `check_nonjobs` adds the status it reports to `bgpids`,
				// as deleting a job does: a later `wait PID` still reads it,
				// though the child's record itself is collected here.
				let status = ctx.k.proc_collect(ctx.cx.store, v)?;
				if ctx.vp.mode.dialect() != crate::bash::ids::Dialect::Zsh {
					ctx.vp.jobs.keep(crate::bash::vm::proc::KeptStatus {
						vpid: v,
						os_pid: (v.0 != pid).then_some(pid),
						status,
					});
				}
				Some(status)
			});
			if let Some(status) = kept {
				let wait = Wait {
					children: Vec::new(),
					all: false,
					any: true,
					into,
					force: true,
					foreground: false,
					kept: Some((pid, status)),
				};
				return Ok(Outcome { status: 0, control: Control::Wait(wait) });
			}
		}
		for a in args {
			let job = match number(a).and_then(|n| u32::try_from(n).ok()) {
				Some(p) => ctx
					.vp
					.jobs
					.by_pid(p)
					.filter(|j| !j.inherited)
					.map(|j| (j.number, j.vpid)),
				None => super::jobs::spec(ctx, a)
					.ok()
					.and_then(|n| ctx.vp.jobs.get(n))
					.filter(|j| !j.inherited)
					.map(|j| (j.number, j.vpid)),
			};
			if let Some(entry) = job {
				if !list.contains(&entry) {
					list.push(entry);
				}
			} else {
				{
					let sub = number(a)
						.and_then(|n| u32::try_from(n).ok())
						.map(|p| ctx.vp.vpid_of(p))
						.filter(|&v| {
							ctx.k.proc_state(ctx.cx.store, v) == Some(crate::bash::vm::ProcState::Running)
								&& ctx.k.started(ctx.cx.store, ctx.vp.vpid, v)
						});
					match sub {
						Some(v) => subs.push(v),
						None if a.starts_with(b"%") => super::jobs::no_such_job(ctx, a),
						None => ctx.usage(format!("`{}': not a pid or valid job spec", a.as_bstr())),
					}
				}
			}
		}
		if list.is_empty() && subs.is_empty() {
			return done(127);
		}
	}
	// bash looks at its job slots in order, then at process substitutions.
	list.sort_unstable_by_key(|&(n, _)| n);
	let mut children: Vec<Vpid> = list.into_iter().map(|(_, v)| v).collect();
	children.extend(subs);
	let wait =
		Wait { children, all: false, any: true, into, force: true, foreground: false, kept: None };
	Ok(Outcome { status: 0, control: Control::Wait(wait) })
}
