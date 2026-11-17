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
			for cand in candidates(&search, file, &cwd, ctx.k.engine.config().platform, &[]) {
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
	let restore = source_args(ctx, rest, true)?;
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
		restore,
		None,
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
		} else {
			// zsh's `try_source_file` runs `FILE.zwc` when FILE is missing;
			// the engine runs only source text.
			let dump = {
				let mut ask = |p: Probe| ctx.probe(p);
				super::zsh_zcompile::source_dump::<super::Need>(&mut ask, &cwd, file)?
			};
			if let Some(dump) = dump {
				ctx.diag(super::zsh_zcompile::word_code_only(&dump));
				return done(1);
			}
		}
	} else if path.is_none() {
		let search = ctx.scalar(b"PATH")?.unwrap_or_default();
		let separator = crate::bash::vm::probe::path_separator(ctx.k.engine.config().platform);
		for dir in search.split(|&c| c == separator) {
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
	let restore = source_args(ctx, rest, false)?;
	// zsh `bin_dot`: under FUNCTION_ARGZERO `$0` is the file as given.
	let argzero = ctx
		.zsh_option(crate::bash::zshopt::ZshOpt::Functionargzero)?
		.then(|| file.clone());
	push_script(ctx.vp, &text, 1, ScriptKind::Source);
	crate::bash::vm::callstack::push_source(
		ctx.k,
		ctx.cx.store,
		ctx.vp,
		file.clone(),
		ctx.line,
		rest,
		restore,
		argzero,
	)?;
	ctx.k
		.emit_op(ctx.cx, ctx.vp, 0, EventData::SourceEnter { path: path.as_bstr() });
	Ok(Outcome { status: ctx.vp.status, control: Control::Frame })
}

/// The arguments of `. file args` become the positional parameters while
/// the file runs; what its end puts back. `bash`: outside any function a
/// file that changes them keeps its own (bash `maybe_pop_dollar_vars`);
/// zsh `bin_dot` always restores.
fn source_args(
	ctx: &mut Ctx<'_, '_>,
	rest: &[BString],
	bash: bool,
) -> Result<Option<Box<crate::bash::vm::callstack::SourceSave>>, super::Need> {
	use crate::bash::vm::state;
	if rest.is_empty() {
		return Ok(None);
	}
	let args = state::positional(&ctx.k.root, ctx.cx.store, ctx.vp)?;
	let installed = if bash && state::func_scope(&ctx.k.root, ctx.cx.store, ctx.vp)?.is_none() {
		Some(rest.to_vec())
	} else {
		None
	};
	state::set_positional(&mut ctx.k.root, ctx.cx.store, ctx.vp, rest.to_vec());
	Ok(Some(Box::new(crate::bash::vm::callstack::SourceSave { args, installed })))
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
	// An interactive shell with stopped jobs warns once instead.
	if crate::bash::vm::jobctl::check_before_exit(ctx.k, ctx.cx, ctx.vp) {
		return done(1);
	}
	// zsh `zexit`: an interactive shell saves its history.
	if ctx.vp.mode.dialect() == crate::bash::ids::Dialect::Zsh {
		super::history::zsh::exit_save_in_builtin(ctx)?;
	}
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
pub fn zsh_exit(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	let status = match zsh_arg(ctx, args) {
		Ok(n) => n.map_or(ctx.vp.status, |n| (n & 0xff) as i32),
		Err(outcome) => return Ok(outcome),
	};
	// zsh `zexit`: an interactive shell with jobs left warns
	// (`checkjobs`) and stays; an `exit` right after leaves.
	if crate::bash::vm::jobctl::check_before_exit(ctx.k, ctx.cx, ctx.vp) {
		return Ok(Outcome { status: 0, control: Control::None });
	}
	// An interactive login shell sources its logout files first.
	if let Some(o) = crate::bash::vm::zle::reader::logout_on_exit(ctx, status)? {
		return Ok(o);
	}
	Ok(Outcome { status, control: Control::Exit })
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
				// bash returns at once on a malformed pid.
				ctx.usage(format!("`{}': not a pid or valid job spec", a.as_bstr()));
				if list.is_empty() {
					return done(1);
				}
				status = 1;
				break;
			};
			let child = ctx.vp.vpid_of(pid);
			if is_child(ctx, child) {
				list.push(child);
			} else {
				// zsh `bin_fg`: silent under `posixbuiltins`.
				if !zsh || !ctx.zsh_option(crate::bash::zshopt::ZshOpt::Posixbuiltins)? {
					ctx.usage(format!("pid {pid} is not a child of this shell"));
				}
				status = 127;
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
				},
				Err(bad) => {
					if matches!(bad, super::jobs::Bad::Missing) {
						super::jobs::no_such_job(ctx, a);
					}
					status = 127;
				},
			}
		} else {
			ctx.usage(format!("`{}': not a pid or valid job spec", a.as_bstr()));
			status = 1;
		}
	}
	if list.is_empty() {
		return done(status);
	}
	let wait = Wait { children: list, all: false, any: false, into, force };
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

/// Whether `pid` is a child this shell can wait for: a job of its own, a
/// finished child whose status is kept (bash's `bgpids`), or the running
/// process substitution or coprocess `$!` names.
fn is_child(ctx: &mut Ctx<'_, '_>, pid: Vpid) -> bool {
	if ctx.vp.jobs.by_vpid(pid).is_some_and(|j| !j.inherited) {
		return true;
	}
	// A subshell copies `$!`, not its parent's children.
	if !ctx.k.started(ctx.cx.store, ctx.vp.vpid, pid) {
		return false;
	}
	match ctx.k.proc_state(ctx.cx.store, pid) {
		Some(crate::bash::vm::ProcState::Exited(_)) => true,
		Some(crate::bash::vm::ProcState::Running) => ctx.vp.last_bg.is(pid),
		None => false,
	}
}

/// `wait` without operands: every running job (bash
/// `wait_for_background_pids`); with job control a stopped job is skipped
/// with a warning. A command substitution's copies of its parent's jobs
/// are not its children.
fn wait_all(ctx: &mut Ctx<'_, '_>, force: bool) -> R {
	let control = super::jobs::active(ctx)?;
	let foreign: Vec<u32> = ctx
		.vp
		.jobs
		.iter()
		.filter(|j| j.inherited && j.state == crate::bash::vm::proc::JobState::Running)
		.map(crate::bash::vm::proc::Job::pid)
		.collect();
	for pid in foreign {
		ctx.usage(format!("pid {pid} is not a child of this shell"));
	}
	ctx.vp.jobs.remove_where(|j| j.inherited);
	let mut list = Vec::new();
	let mut stopped = Vec::new();
	for job in ctx.vp.jobs.iter() {
		match job.state {
			crate::bash::vm::proc::JobState::Stopped(_) if control => {
				stopped.push((job.number, job.pid()));
			},
			crate::bash::vm::proc::JobState::Done(_) => {},
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
	let wait = Wait { children: list, all: true, any: false, into: None, force };
	Ok(Outcome { status: 0, control: Control::Wait(wait) })
}

/// `wait -n [id …]`: the first of the jobs (all without operands) to
/// finish (bash `wait_for_any_job`); a finished child that already left the
/// job table answers at once. 127 when there is nothing to wait for.
fn wait_any(ctx: &mut Ctx<'_, '_>, args: &[BString], into: Option<BString>) -> R {
	let mut list = Vec::new();
	if args.is_empty() {
		list.extend(ctx.vp.jobs.iter().filter(|j| !j.inherited).map(|j| j.vpid));
	} else {
		// bash `check_nonjobs`: a pid no longer in the job table whose
		// status is kept.
		let kept = args.iter().find_map(|a| {
			let pid = ctx.vp.vpid_of(u32::try_from(number(a)?).ok()?);
			(ctx.vp.jobs.by_vpid(pid).is_none()
				&& matches!(
					ctx.k.proc_state(ctx.cx.store, pid),
					Some(crate::bash::vm::ProcState::Exited(_))
				)
				&& ctx.k.started(ctx.cx.store, ctx.vp.vpid, pid))
			.then_some(pid)
		});
		if let Some(pid) = kept {
			let wait = Wait { children: vec![pid], all: false, any: true, into, force: true };
			return Ok(Outcome { status: 0, control: Control::Wait(wait) });
		}
		for a in args {
			let pid = number(a)
				.and_then(|n| u32::try_from(n).ok())
				.map(|n| ctx.vp.vpid_of(n));
			let found = match pid {
				Some(p) => ctx
					.vp
					.jobs
					.by_vpid(p)
					.filter(|j| !j.inherited)
					.map(|j| j.vpid)
					.or_else(|| {
						(ctx.vp.last_bg.is(p)
							&& ctx.k.proc_state(ctx.cx.store, p)
								== Some(crate::bash::vm::ProcState::Running)
							&& ctx.k.started(ctx.cx.store, ctx.vp.vpid, p))
						.then_some(p)
					}),
				None => super::jobs::spec(ctx, a)
					.ok()
					.and_then(|n| ctx.vp.jobs.get(n))
					.map(|j| j.vpid),
			};
			match found {
				Some(v) => {
					if !list.contains(&v) {
						list.push(v);
					}
				},
				None if a.starts_with(b"%") => super::jobs::no_such_job(ctx, a),
				None => ctx.usage(format!("`{}': not a pid or valid job spec", a.as_bstr())),
			}
		}
	}
	if list.is_empty() {
		return done(127);
	}
	let wait = Wait { children: list, all: false, any: true, into, force: true };
	Ok(Outcome { status: 0, control: Control::Wait(wait) })
}
