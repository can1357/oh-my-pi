//! Perl's readline operators and magic ARGV stream (perlop, perlfunc, perlvar, perlrun).

use std::{cell::RefCell, io::Write as _, rc::Rc};

use crate::perl::{
	ast::{Builtin, Call, Expr, ExprKind, Readline}, interp::{Cx, Flow, Interp, PResult, Ret},
	io::{Handle, Io, Layers, OpenTarget, RecordSep, ShellSpec, TwoArgTarget},
	value::{PStr, Value},
};

use super::{READ, WRITE, aliases, args, bool_ret, handles, interruptible, one, path, set_global, set_io_errno, warn_on};

/// Evaluate an angle-bracket input source, preserving the supplied context.
pub(in crate::perl) fn readline(interp: &mut Interp<'_>, src: &Readline, cx: Cx) -> PResult<Ret> {
	match src {
		Readline::Argv(safe) => read_argv(interp, *safe, cx),
		Readline::Handle(name) if is_argv(name) => read_argv(interp, false, cx),
		Readline::Handle(name) => {
			let handle = handles::named(interp, name);
			read_handle(interp, handle, Some(name), cx)
		},
		Readline::Scalar(e) => read_expr(interp, e, cx),
	}
}

pub(super) fn call(interp: &mut Interp<'_>, b: Builtin, call: &Call, cx: Cx) -> PResult<Ret> {
	let es = args(call);
	if b == Builtin::Readline {
		return match es.first() { Some(e) => read_expr(interp, e, cx), None => read_argv(interp, false, cx) };
	}
	if es.is_empty() && call.args.is_some() {
		if let Some(io) = handles::named(interp, "ARGV")
			&& interp.tied_handle(&io).is_some()
			&& let Some(ret) = interp.call_tied_handle(&io, "EOF", aliases([Value::Int(2)]), Cx::Scalar)
		{ return ret; }
		return Ok(bool_ret(!advance_to_data(interp, false)?));
	}
	let io = if let Some(e) = es.first() {
		if matches!(&e.kind, ExprKind::Bareword(n) if is_argv(n)) {
			interp.argv_state().current.clone().or_else(|| handles::named(interp, "ARGV"))
		} else { handles::from_expr(interp, e)? }
	} else { interp.last_read() };
	let Some(io) = io else { return Ok(bool_ret(true)); };
	interp.set_last_read(io.clone());
	if interp.tied_handle(&io).is_some()
		&& let Some(ret) = interp.call_tied_handle(&io, "EOF", aliases([Value::Int(i64::from(!es.is_empty()))]), Cx::Scalar)
	{
		return ret;
	}
	let eof = io.borrow_mut().eof();
	Ok(bool_ret(eof))
}

fn is_argv(name: &str) -> bool { matches!(name, "ARGV" | "main::ARGV") }

fn read_expr(interp: &mut Interp<'_>, expr: &Expr, cx: Cx) -> PResult<Ret> {
	let mut operand = expr;
	while let ExprKind::Group(inner) = &operand.kind { operand = inner; }
	let io = if let ExprKind::Bareword(name) = &operand.kind {
		if is_argv(name) { return read_argv(interp, false, cx); }
		handles::named(interp, name)
	} else {
		let value = interp.eval_scalar(operand)?;
		if let Some(result) = interp.overload_builtin("<>", &value, None, cx)? { return Ok(result); }
		handles::handle_value(interp, &value)
	};
	if let Some(h) = &io
		&& handles::named(interp, "ARGV").is_some_and(|argv| Rc::ptr_eq(h, &argv))
	{
		return read_argv(interp, false, cx);
	}
	read_handle(interp, io, handles::spelling(expr).as_deref(), cx)
}

fn read_handle(interp: &mut Interp<'_>, io: Option<Io>, name: Option<&str>, cx: Cx) -> PResult<Ret> {
	let Some(io) = io else {
		warn_on(interp, "unopened", || format!("readline() on unopened filehandle {}", name.unwrap_or_default()));
		interp.clear_last_read();
		interp.set_errno_code(libc::EBADF);
		return Ok(empty(cx));
	};
	interp.set_last_read(io.clone());
	if let Some(ret) = interp.call_tied_handle(&io, "READLINE", Vec::new(), cx) { return ret; }
	let sep = interp.input_sep();
	if cx != Cx::List { return Ok(one(record(interp, &io, &sep, cx)?.map_or(Value::Undef, Value::Str))); }
	let mut records = Vec::new();
	while let Some(s) = record(interp, &io, &sep, cx)? {
		records.push(Value::Str(s));
	}
	Ok(Ret::Many(records))
}

fn record(interp: &mut Interp<'_>, io: &Io, sep: &RecordSep, cx: Cx) -> PResult<Option<PStr>> {
	if interp.is_cancelled() { return Err(Flow::Cancelled); }
	let r = interruptible(interp, io, |h| h.read_record_with_context(sep, cx == Cx::List))?;
	match r {
		Ok(Some(s)) => {
			// A :utf8 layer passes bytes through unchecked; Perl reports the first bad one.
			if s.utf8 && let Err(e) = std::str::from_utf8(&s.bytes) && let Some(&bad) = s.bytes.get(e.valid_up_to()) {
				warn_on(interp, "utf8", || format!("utf8 \"\\x{bad:02X}\" does not map to Unicode"));
			}
			Ok(Some(s))
		},
		Ok(s) => Ok(s),
		Err(_) if interp.is_cancelled() => Err(Flow::Cancelled),
		Err(err) => {
			if err.to_string() == "Wide character in $/" { return Err(interp.die_msg(err.to_string())); }
			let closed = !io.borrow().is_open();
			if err.raw_os_error() == Some(libc::EBADF) {
				let (_, name) = handles::identity(interp, io);
				if closed {
					warn_on(interp, "closed", || format!("readline() on closed filehandle {name}"));
				} else {
					warn_on(interp, "io", || format!("Filehandle {name} opened only for output"));
				}
			}
			set_io_errno(interp, &err);
			Ok(None)
		},
	}
}

fn empty(cx: Cx) -> Ret { if cx == Cx::List { Ret::Many(Vec::new()) } else { one(Value::Undef) } }

/// Iteration state of an `<>` loop whose `*ARGV` was localized by an inner
/// loop (`local *ARGV; local *ARGVOUT`), as Perl keeps it on the glob.
pub(super) struct Suspended {
	argv: Io,
	inplace: Option<crate::perl::io::InPlace>,
	started: bool,
	select_saved: Option<Io>,
}

/// Switch the `<>` state to whichever ARGV glob is visible now: suspend the
/// outer loop's state when `*ARGV` was localized, resume it when restored.
fn sync_argv(interp: &mut Interp<'_>) -> PResult<()> {
	// The glob's own IO slot: Interp::handle("ARGV") answers with the current
	// `<>` stream, which is exactly what must not decide this.
	let visible = interp.find_glob("main::ARGV").and_then(|gv| gv.io.borrow().clone());
	let is_visible = |io: &Io| visible.as_ref().is_some_and(|v| Rc::ptr_eq(v, io));
	let current = interp.argv_state().current.clone();
	if current.as_ref().is_some_and(&is_visible) { return Ok(()); }
	if let Some(at) = interp.sys.argv_outer.iter().rposition(|s| is_visible(&s.argv)) {
		// Back in the outer scope: publish whatever the inner loop left, then resume.
		finish_current(interp)?;
		let mut stack = std::mem::take(&mut interp.sys.argv_outer);
		let Some(resumed) = stack.drain(at..).next() else { return Ok(()); };
		interp.sys.argv_outer = stack;
		interp.argv_state().current = Some(resumed.argv);
		interp.argv_state().inplace = resumed.inplace;
		interp.sys.argv_started = resumed.started;
		interp.sys.argv_select_saved = resumed.select_saved;
		return Ok(());
	}
	if let Some(argv) = current {
		interp.argv_state().current = None;
		let inplace = interp.argv_state().inplace.take();
		interp.sys.argv_outer.push(Suspended {
			argv, inplace, started: std::mem::take(&mut interp.sys.argv_started), select_saved: interp.sys.argv_select_saved.take(),
		});
	}
	Ok(())
}

fn read_argv(interp: &mut Interp<'_>, safe: bool, cx: Cx) -> PResult<Ret> {
	if let Some(io) = handles::named(interp, "ARGV")
		&& interp.tied_handle(&io).is_some()
	{
		return read_handle(interp, Some(io), Some("ARGV"), cx);
	}
	sync_argv(interp)?;
	let sep = interp.input_sep();
	let mut records = Vec::new();
	loop {
		let current = match interp.argv_state().current.clone() {
			Some(io) => io,
			None => match next_file(interp, safe)? {
				Some(io) => io,
				None => {
					interp.sys.argv_started = false;
					interp.sys.argv_reset_line = true;
					break;
				},
			},
		};
		if !current.borrow().is_open() { finish_current(interp)?; continue; }
		interp.set_last_read(current.clone());
		match record(interp, &current, &sep, cx)? {
			Some(s) if cx != Cx::List => return Ok(one(Value::Str(s))),
			Some(s) => records.push(Value::Str(s)),
			None => finish_current(interp)?,
		}
	}
	if cx == Cx::List { Ok(Ret::Many(records)) } else { Ok(empty(cx)) }
}

fn advance_to_data(interp: &mut Interp<'_>, safe: bool) -> PResult<bool> {
	sync_argv(interp)?;
	loop {
		let current = match interp.argv_state().current.clone() {
			Some(io) => io,
			None => match next_file(interp, safe)? { Some(io) => io, None => return Ok(false) },
		};
		interp.set_last_read(current.clone());
		if !current.borrow_mut().eof() { return Ok(true); }
		// Peeking through eof() does not report or reset the current
		// stream's final EOF. A later readline must still see it once.
		let argv = interp.av("main::ARGV");
		if interp.array_len(&argv)? == 0 { return Ok(false); }
		finish_current(interp)?;
	}
}

fn next_file(interp: &mut Interp<'_>, safe: bool) -> PResult<Option<Io>> {
	let argv = interp.av("main::ARGV");
	if !interp.sys.argv_started && interp.array_len(&argv)? == 0 {
		// An initially empty array means standard input even with <<>>. An explicit '-'
		// in that array is a literal filename when the caller chose <<>>.
		if interp.argv_state().ext.is_some() {
			warn_on(interp, "inplace", || "-i used with no filenames on the command line, reading from STDIN".into());
		}
		return open_stdin(interp);
	}
	interp.sys.argv_started = true;
	loop {
		if interp.is_cancelled() { return Err(Flow::Cancelled); }
		let arg = if let Some(object) = interp.tied_array(&argv) {
			if interp.array_len(&argv)? == 0 { return Ok(None); }
			interp.call_method(object, "SHIFT", Vec::new(), Cx::Scalar)?.scalar()
		} else {
			let arg = {
				let mut elems = argv.elems_mut();
				if elems.is_empty() { return Ok(None); }
				elems.remove(0)
			};
			interp.read_sv(&arg)?
		};
		let name = interp.stringify(&arg)?;
		assign_name(interp, name.clone())?;
		if name.bytes == b"-" && !safe { return open_stdin(interp); }
		let input = handles::layers_with_default(interp, READ, Layers::default());
		let output = handles::layers_with_default(interp, WRITE, Layers::default());
		let opened = if interp.argv_state().ext.is_some() {
			let mut inplace = interp.argv_state().inplace.take().unwrap_or_else(|| {
				crate::perl::io::InPlace::new(interp.argv_state().ext.as_deref().unwrap_or_default())
			});
			let cwd = interp.resolve_path(b".");
			let reuse = interp.find_glob("main::ARGVOUT").and_then(|gv| gv.io.borrow().clone());
			let r = path(interp, &name.bytes).and_then(|p| inplace.advance_resolved(interp.host(), p, &name.bytes, &cwd, input, output, reuse));
			interp.argv_state().inplace = Some(inplace);
			r.map(|(h, out)| (h, Some(out)))
		} else {
			open_argv_path(interp, safe, &name.bytes, input).map(|h| (h, None))
		};
		match opened {
			Ok((h, out)) => {
				if let Some(out) = out {
					let saved = interp.set_selected(out.clone());
					interp.sys.argv_select_saved = Some(saved);
					handles::install_named(interp, "ARGVOUT", out);
				}
				return Ok(Some(install_argv(interp, h)));
			},
			Err(err) => {
				set_io_errno(interp, &err);
				let text = err.to_string();
				let message = format!("Can't open {}: {}", name.to_string_lossy(), text.split(" (os error ").next().unwrap_or(&text));
				if interp.warn_on("io") { interp.warn(message); }
				else { let _ = writeln!(interp.host().stderr, "{message}."); }
			},
		}
	}
}

fn assign_name(interp: &mut Interp<'_>, name: PStr) -> PResult<()> {
	interp.argv_state().name = name.clone();
	set_global(interp, "main::ARGV", Value::Str(name))
}

fn open_stdin(interp: &mut Interp<'_>) -> PResult<Option<Io>> {
	interp.sys.argv_started = true;
	assign_name(interp, PStr::from_bytes(b"-"))?;
	let layers = handles::layers_with_default(interp, READ, Layers::default());
	let h = handles::open_standard(interp, READ, layers, 0);
	Ok(h.ok().map(|h| install_argv(interp, h)))
}

fn open_argv_path(interp: &mut Interp<'_>, safe: bool, name: &[u8], default: Layers) -> std::io::Result<Handle> {
	if safe { return handles::open_path(interp, READ, default, name); }
	let (mode, target, layers) = Handle::parse_two_arg(name).map_err(std::io::Error::other)?;
	let layers = layers.inherit(default);
	match target {
		TwoArgTarget::Path(p) => handles::open_path(interp, mode, layers, &p),
		TwoArgTarget::Std(fd) => handles::open_standard(interp, mode, layers, fd),
		TwoArgTarget::Command(c) => handles::open_child(interp, mode, layers, ShellSpec::Line(&c)),
		TwoArgTarget::Dup { name, same } => {
			let name = String::from_utf8_lossy(&name);
			let io = if let Ok(fd) = name.parse::<i32>() { handles::by_fd(interp, fd) } else { handles::named(interp, &name) };
			let target = match io {
				Some(io) if same => OpenTarget::DupSame(io),
				Some(io) => OpenTarget::Dup(io),
				None => return Err(super::bad_fd()),
			};
			Handle::open(interp.host(), mode, target, layers)
		},
	}
}

fn install_argv(interp: &mut Interp<'_>, mut h: Handle) -> Io {
	let io = handles::named(interp, "ARGV").unwrap_or_else(|| {
		let io = Rc::new(RefCell::new(Handle::closed()));
		handles::install_named(interp, "ARGV", io.clone());
		io
	});
	if !std::mem::take(&mut interp.sys.argv_reset_line) { h.set_line_no(io.borrow().line_no()); }
	handles::replace(interp, &io, h);
	interp.argv_state().current = Some(io.clone());
	io
}

fn finish_current(interp: &mut Interp<'_>) -> PResult<()> {
	if let Some(current) = interp.argv_state().current.take() {
		let line = current.borrow().line_no();
		if current.borrow().is_open() { let _ = handles::close(interp, &current); }
		current.borrow_mut().set_line_no(line);
	}
	if let Some(inplace) = interp.argv_state().inplace.as_mut() {
		if let Err(e) = inplace.finish() {
			set_io_errno(interp, &e);
			return Err(interp.die_msg(format!("Can't rename in-place work file: {e}")));
		}
	}
	if let Some(saved) = interp.sys.argv_select_saved.take()
		&& handles::named(interp, "ARGVOUT").is_some_and(|out| Rc::ptr_eq(&out, &interp.selected()))
	{
		interp.set_selected(saved);
	}
	Ok(())
}

/// Publish pending `-i` edits and restore the normal default output handle.
pub(in crate::perl) fn finish_argv(interp: &mut Interp<'_>) -> PResult<()> { finish_current(interp) }
