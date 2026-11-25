//! Perl filehandle identity and low-level stream builtins (perlfunc, perlopentut).

use std::{cell::RefCell, io, rc::{Rc, Weak}};

use omp_vfs::{OpenOptions, TempOptions};

use crate::{
	openfile::OpenFile,
	perl::{
		ast::{Builtin, Call, Expr, ExprKind, Select, Sigil}, interp::{Cx, Interp, PResult, Ret},
		io::{Handle, Io, Layers, ModeKind, OpenTarget, ShellSpec, TwoArgTarget},
		value::{Gv, HKey, PStr, Ref, Sv, Value, new_gv},
	},
};

use super::{READ, WRITE, aliases, args, bad_fd, default_layers, errno, fail, interruptible, io_name, nul_in_name, one, path, result, scalar, tail, warn_on, yes};

pub(super) struct KnownHandle { io: Weak<RefCell<Handle>>, identity: Identity, display: Rc<str> }
enum Identity {
	Name(PStr, Option<Weak<crate::perl::value::GlobBody>>),
	Glob(Weak<crate::perl::value::GlobBody>),
	Direct,
}

/// Associate an IO slot with its Perl identity without keeping anonymous globs alive.
pub(in crate::perl) fn remember(interp: &mut Interp<'_>, io: &Io, identity: Value, display: Rc<str>) {
	let identity = match identity {
		Value::Str(s) => {
			let named = interp.find_glob(&s.to_string_lossy()).map(|g| Rc::downgrade(&g));
			Identity::Name(s, named)
		},
		Value::Ref(Ref::Glob(gv)) | Value::Glob(gv) => Identity::Glob(Rc::downgrade(&gv)),
		_ => Identity::Direct,
	};
	if interp.sys.handles.len() > 64 && interp.sys.handles.len().is_power_of_two() {
		interp.sys.handles.retain(|_, h| h.io.strong_count() != 0);
	}
	interp.sys.handles.insert(io_name(io), KnownHandle { io: Rc::downgrade(io), identity, display });
}

pub(super) fn named(interp: &mut Interp<'_>, name: &str) -> Option<Io> {
	let qualified = interp.qualify(name);
	let io = interp.handle(&qualified, false)?;
	if !interp.sys.handles.contains_key(&io_name(&io)) {
		let display: Rc<str> = qualified.rsplit("::").next().unwrap_or(name).into();
		let identity = Value::Str(PStr::from_str(&qualified));
		remember(interp, &io, identity, display);
	}
	Some(io)
}

pub(super) fn identity(interp: &mut Interp<'_>, handle: &Io) -> (Value, Rc<str>) {
	for name in ["STDOUT", "STDIN", "STDERR", "ARGV", "ARGVOUT", "DATA"] {
		if named(interp, name).is_some_and(|io| Rc::ptr_eq(&io, handle)) { break; }
	}
	interp.sys.handles.get(&io_name(handle)).filter(|h| h.io.strong_count() != 0)
		.map_or_else(|| (Value::Ref(Ref::Io(handle.clone())), "".into()), |h| {
			let value = match &h.identity {
				Identity::Name(s, owner) => {
					let detached = owner.as_ref().and_then(Weak::upgrade).filter(|original| {
						let name = s.to_string_lossy();
						!interp.find_glob(&name).is_some_and(|current| Rc::ptr_eq(original, &current))
							|| !reachable_by_stash(&*interp, &name, original)
					});
					detached.map_or_else(|| Value::Str(s.clone()), |g| Value::Ref(Ref::Glob(g)))
				},
				Identity::Glob(gv) => gv.upgrade().map_or_else(|| Value::Ref(Ref::Io(handle.clone())), |g| Value::Ref(Ref::Glob(g))),
				Identity::Direct => Value::Ref(Ref::Io(handle.clone())),
			};
			(value, h.display.clone())
		})
}

/// Whether `pkg::name` still reaches `glob` through the package's stash glob (`*pkg::`): a stash
/// replaced by glob assignment (`*foo:: = *bar::`) detaches the globs it held.
fn reachable_by_stash(interp: &Interp<'_>, qualified: &str, glob: &Gv) -> bool {
	let Some((pkg, name)) = qualified.rsplit_once("::") else { return true };
	if pkg.is_empty() || pkg == "main" { return true; }
	let Some(stash_glob) = interp.find_glob(&format!("{pkg}::")) else { return true };
	let stash = stash_glob.hash.borrow().clone();
	let entries = stash.entries();
	entries.get(&HKey::new(&PStr::from_str(name))).is_some_and(|sv| {
		matches!(sv.get(), Value::Glob(g) | Value::Ref(Ref::Glob(g)) if Rc::ptr_eq(&g, glob))
	})
}

/// The name Perl shows for a handle in "<NAME> line N" message suffixes
/// (`STDIN`, `$fh`, `$fh{...}`), when the handle is known to this layer.
pub(in crate::perl) fn display_name(interp: &Interp<'_>, handle: &Io) -> Option<Rc<str>> {
	interp.sys.handles.get(&io_name(handle)).filter(|h| h.io.strong_count() != 0).map(|h| h.display.clone())
}

/// Resolve a Perl-managed native descriptor, including standard streams.
pub(in crate::perl) fn by_fd(interp: &mut Interp<'_>, fd: i32) -> Option<Io> {
	if let Some(name) = match fd { 0 => Some("STDIN"), 1 => Some("STDOUT"), 2 => Some("STDERR"), _ => None } {
		if let Some(io) = named(interp, name).filter(|io| io.borrow().is_open()) { return Some(io); }
	}
	interp.sys.handles.values().filter_map(|h| h.io.upgrade()).find(|io| io.borrow().fileno() == Some(fd))
}

pub(super) fn handle_value(interp: &mut Interp<'_>, v: &Value) -> Option<Io> {
	match v {
		Value::Glob(gv) | Value::Ref(Ref::Glob(gv)) => gv.io.borrow().clone(),
		Value::Ref(Ref::Io(io)) => Some(io.clone()),
		Value::Str(s) => named(interp, &s.to_string_lossy()),
		_ => None,
	}
}

pub(super) fn from_expr(interp: &mut Interp<'_>, e: &Expr) -> PResult<Option<Io>> {
	if let ExprKind::Bareword(n) = &e.kind { return Ok(named(interp, n)); }
	interp.eval_handle(e)
}

fn lvalue(e: &Expr) -> bool {
	matches!(e.kind, ExprKind::Variable(Sigil::Scalar, _) | ExprKind::Deref(Sigil::Scalar, _) |
		ExprKind::Select(..) | ExprKind::Declare(..) | ExprKind::Group(_))
}

pub(super) fn spelling(e: &Expr) -> Option<Rc<str>> {
	match &e.kind {
		ExprKind::Bareword(n) | ExprKind::Variable(Sigil::Glob, n) => Some(n.clone()),
		ExprKind::Variable(Sigil::Scalar, n) => Some(format!("${n}").into()),
		// Autovivified element handles are named like Perl's: `$fh[...]`, `$fh{...}`.
		ExprKind::Select(base, Select::ArrayElement(false), _) => spelling(base).map(|n| format!("{n}[...]").into()),
		ExprKind::Select(base, Select::HashElement(false), _) => spelling(base).map(|n| format!("{n}{{...}}").into()),
		ExprKind::Declare(_, _, e, _) | ExprKind::Group(e) => spelling(e),
		_ => None,
	}
}

pub(super) struct Slot { pub io: Io, pub gv: Option<Gv> }

pub(super) fn slot(interp: &mut Interp<'_>, e: &Expr) -> PResult<Slot> {
	let (gv, anonymous) = if let ExprKind::Bareword(n) = &e.kind {
		let name = interp.qualify(n);
		(interp.glob(&name), false)
	} else {
		let sv = if lvalue(e) { Some(interp.eval_lvalue(e)?) } else { None };
		let val = match &sv { Some(sv) => interp.read_sv(sv)?, None => interp.eval_scalar(e)? };
		match val {
			Value::Ref(Ref::Io(io)) => return Ok(Slot { io, gv: None }),
			Value::Glob(g) => (g, false),
			Value::Ref(Ref::Glob(g)) => {
				let anonymous = g.name.starts_with('$');
				(g, anonymous)
			},
			Value::Undef if sv.is_some() => {
				let g = new_gv(interp.package(), spelling(e).unwrap_or_else(|| "$__ANONIO__".into()));
				if let Some(sv) = sv { interp.write_sv(&sv, Value::Ref(Ref::Glob(g.clone())))?; }
				(g, true)
			},
			Value::Ref(_) | Value::Undef => return Err(interp.die_msg("Not a GLOB reference")),
			val => {
				let name = interp.stringify(&val)?;
				if interp.hints().strict_refs {
					return Err(interp.die_msg(format!("Can't use string (\"{}\") as a symbol ref while \"strict refs\" in use", name.to_string_lossy())));
				}
				let name = interp.qualify(&name.to_string_lossy());
				(interp.glob(&name), false)
			},
		}
	};
	Ok(glob_slot(interp, gv, anonymous))
}

fn glob_slot(interp: &mut Interp<'_>, gv: Gv, anonymous: bool) -> Slot {
	let existing = gv.io.borrow().clone();
	let io = existing.unwrap_or_else(|| {
		let io = Rc::new(RefCell::new(Handle::closed()));
		interp.set_handle(&gv, io.clone());
		io
	});
	let identity = if anonymous { Value::Ref(Ref::Glob(gv.clone())) }
		else { Value::str(&format!("{}::{}", gv.pkg, gv.name)) };
	remember(interp, &io, identity, gv.name.clone());
	Slot { io, gv: Some(gv) }
}

pub(super) fn select_slot(interp: &mut Interp<'_>, expr: &Expr) -> PResult<Io> {
	let mut expr = expr;
	while let ExprKind::Group(inner) = &expr.kind { expr = inner; }
	let gv = if let ExprKind::Bareword(name) = &expr.kind {
		let name = interp.qualify(name);
		interp.glob(&name)
	} else {
		let value = interp.eval_scalar(expr)?;
		match value {
			Value::Ref(Ref::Io(io)) => return Ok(io),
			Value::Glob(gv) | Value::Ref(Ref::Glob(gv)) => gv,
			Value::Str(name) if !name.is_empty() => {
				let qualified = interp.qualify(&name.to_string_lossy());
				interp.glob(&qualified)
			},
			Value::Undef => {
				warn_on(interp, "uninitialized", || "Use of uninitialized value in ref-to-glob cast".into());
				return Err(interp.die_msg("Bad symbol for filehandle"));
			},
			_ => return Err(interp.die_msg("Bad symbol for filehandle")),
		}
	};
	let anonymous = gv.name.starts_with('$');
	Ok(glob_slot(interp, gv, anonymous).io)
}

pub(super) fn install_named(interp: &mut Interp<'_>, name: &str, io: Io) {
	let name = interp.qualify(name);
	let gv = interp.glob(&name);
	interp.set_handle(&gv, io.clone());
	remember(interp, &io, Value::str(&name), gv.name.clone());
}

pub(super) fn close(interp: &mut Interp<'_>, io: &Io) -> io::Result<bool> {
	let mut handle = io.borrow_mut();
	let child = handle.child();
	let closed = handle.close();
	drop(handle);
	if let Some(child) = child { interp.sys.children.remove(&child.id()); }
	match closed {
		Ok(Some(status)) => { interp.set_child_status(status); Ok(status == 0) },
		Ok(None) => Ok(true),
		Err(err) => Err(err),
	}
}

/// Reopen the IO slot, registering a pipe child if the new handle has one.
pub(in crate::perl) fn replace(interp: &mut Interp<'_>, io: &Io, mut handle: Handle) -> Ret {
	for (fd, name) in ["STDIN", "STDOUT", "STDERR"].into_iter().enumerate() {
		if interp.handle(name, false).is_some_and(|std| Rc::ptr_eq(io, &std)) {
			handle.set_standard_number(fd as i32);
			break;
		}
	}
	if io.borrow().is_open() { let _ = close(interp, io); }
	let child = handle.child();
	*io.borrow_mut() = handle;
	match child {
		Some(c) => {
			let id = c.id();
			interp.sys.children.insert(id, c);
			one(Value::Int(i64::from(id)))
		},
		None => yes(),
	}
}

pub(super) fn call(interp: &mut Interp<'_>, b: Builtin, call: &Call, cx: Cx) -> PResult<Ret> {
	use Builtin as B;
	let es = args(call);
	if b == B::Open || b == B::Sysopen { return open(interp, b, es); }
	if b == B::Pipe { return pipe(interp, es); }
	if b == B::Truncate { return truncate(interp, es); }
	let target = es.first();
	let handle = if let Some(e) = target { from_expr(interp, e)? } else {
		match b {
			B::Close => Some(interp.selected()),
			B::Getc => named(interp, "STDIN"),
			B::Tell => interp.last_read(),
			_ => None,
		}
	};
	if matches!(b, B::Read | B::Sysread | B::Syswrite) { return transfer(interp, b, es, handle, cx); }
	let vals = tail(interp, es.get(1..).unwrap_or_default())?;
	let val = |n: usize| vals.get(n).unwrap_or(&Value::Undef);
	let Some(handle) = handle else {
		if b == B::Tell {
			if let Some(e) = target {
				warn_on(interp, "unopened", || format!("tell() on unopened filehandle {}", spelling(e).as_deref().unwrap_or("")));
				// Like perl, `tell NAME` vivifies the glob's (unopened) IO slot.
				if let ExprKind::Bareword(name) = &e.kind {
					let qualified = interp.qualify(name);
					interp.handle(&qualified, true);
				}
			}
			interp.set_errno_code(libc::EBADF);
			return Ok(one(Value::Int(-1)));
		}
		if b != B::Fileno && let Some(e) = target {
			warn_on(interp, "unopened", || format!("{}() on unopened filehandle {}", b.name(), spelling(e).as_deref().unwrap_or("")));
		}
		return Ok(fail(interp, libc::EBADF));
	};
	if b == B::Tell { interp.set_last_read(handle.clone()); }
	if let Some(method) = match b {
		B::Close => Some("CLOSE"), B::Binmode => Some("BINMODE"), B::Fileno => Some("FILENO"),
		B::Getc => Some("GETC"), B::Seek | B::Sysseek => Some("SEEK"), B::Tell => Some("TELL"), _ => None,
	}
		&& interp.tied_handle(&handle).is_some()
	{
		let context = if b == B::Getc { cx } else { Cx::Scalar };
		if let Some(ret) = interp.call_tied_handle(&handle, method, aliases(vals.iter().cloned()), context) { return ret; }
	}
	Ok(match b {
		B::Close => { let closed = close(interp, &handle); result(interp, closed, super::bool_ret) },
		B::Fileno => {
			let fd = handle.borrow().fileno();
			match fd {
				Some(fd) => one(Value::Int(i64::from(fd))),
				// Directory streams have no descriptor here (Config d_dirfd is undef).
				None if interp.sys.dirs.contains_key(&io_name(&handle)) => fail(interp, libc::ENOTSUP),
				None => one(Value::Undef),
			}
		},
		B::Binmode => {
			let layer = interp.stringify(val(0))?;
			if !handle.borrow().is_open() { return Ok(fail(interp, libc::EBADF)); }
			match { let mut h = handle.borrow_mut(); h.binmode(&layer.bytes) } {
				Ok(()) => yes(),
				Err(msg) => layer_failure(interp, msg),
			}
		},
		B::Getc => {
			let r = interruptible(interp, &handle, Handle::getc)?;
			result(interp, r, |s| one(s.map_or(Value::Undef, Value::Str)))
		},
		B::Seek => result(interp, handle.borrow_mut().seek(val(0).to_i64(), val(1).to_i64() as u8), |()| yes()),
		B::Sysseek => result(interp, handle.borrow_mut().sysseek(val(0).to_i64(), val(1).to_i64() as u8), |n| one(zero_true(n as i64))),
		B::Tell => {
			let n = handle.borrow_mut().tell();
			if n < 0 {
				let (_, name) = identity(interp, &handle);
				warn_on(interp, "closed", || format!("tell() on closed filehandle {name}"));
				interp.set_errno_code(libc::EBADF);
			}
			one(Value::Int(n))
		},
		B::Flock => if handle.borrow().is_open() { yes() } else { fail(interp, libc::EBADF) },
		B::Fcntl => fcntl(interp, &handle, val(0).to_i64() as i32, val(1).to_i64() as i32),
		B::Ioctl => fail(interp, if handle.borrow().is_open() { libc::ENOTTY } else { libc::EBADF }),
		_ => one(Value::Undef),
	})
}

/// The part of a 3-arg open mode after its `+<>&=` prefix, where layers start.
fn layer_spec(mode: &[u8]) -> &[u8] {
	let mut rest = mode.trim_ascii();
	rest = rest.strip_prefix(b"+").unwrap_or(rest);
	rest = rest.strip_prefix(b">>").or_else(|| rest.strip_prefix(b"<")).or_else(|| rest.strip_prefix(b">")).unwrap_or(rest);
	rest = rest.strip_prefix(b"&").unwrap_or(rest);
	rest = rest.strip_prefix(b"=").unwrap_or(rest);
	rest.trim_ascii_start()
}

fn zero_true(n: i64) -> Value { if n == 0 { Value::bytes(b"0 but true") } else { Value::Int(n) } }

fn open(interp: &mut Interp<'_>, b: Builtin, es: &[Expr]) -> PResult<Ret> {
	let Some(e) = es.first() else { return Err(interp.die_msg(format!("Not enough arguments for {}", b.name()))); };
	let slot = slot(interp, e)?;
	if b == Builtin::Open && interp.tied_handle(&slot.io).is_some() {
		let mut args = Vec::new();
		for expr in &es[1..] { args.extend(interp.eval_aliases(expr)?); }
		if let Some(ret) = interp.call_tied_handle(&slot.io, "OPEN", args, Cx::Scalar) { return ret; }
	}
	if b == Builtin::Sysopen {
		let v = tail(interp, &es[1..])?;
		return sysopen(interp, &slot.io, &v);
	}
	let mut v: Vec<Value> = Vec::new();
	for (i, expr) in es[1..].iter().enumerate() {
		if i == 1 && v.len() == 1
			&& let ExprKind::Bareword(name) = &expr.kind
			&& matches!(Handle::parse_mode(&v[0].to_pstr().bytes), Ok((_, ModeKind::Dup { .. }, _)))
		{
			v.push(Value::str(name));
		} else { v.extend(interp.eval_list(expr)?); }
	}
	let spec = if let Some(arg) = v.first() { interp.stringify(arg)? }
		else if let Some(g) = &slot.gv {
			let sv = g.scalar.borrow().clone();
			let value = interp.read_sv(&sv)?;
			interp.stringify(&value)?
		}
		else { PStr::default() };
	let opened = if v.len() < 2 {
		let (mode, target, layers) = Handle::parse_two_arg(&spec.bytes).map_err(|e| interp.die_msg(e))?;
		let layers = layers_with_default(interp, mode, layers);
		if !matches!(target, TwoArgTarget::Dup { .. } | TwoArgTarget::Std(_)) && slot.io.borrow().is_open() { let _ = close(interp, &slot.io); }
		match target {
			TwoArgTarget::Path(p) => open_path(interp, mode, layers, &p),
			TwoArgTarget::Std(fd) => open_standard(interp, mode, layers, fd),
			TwoArgTarget::Command(command) => open_child(interp, mode, layers, ShellSpec::Line(&command)),
			TwoArgTarget::Dup { name, same } => match dup_target(interp, &Value::Str(PStr::new(name, false)), same)? {
				Ok(target) => Handle::open(interp.host(), mode, target, layers),
				Err(_) => Err(io::Error::from_raw_os_error(libc::EINVAL)),
			},
		}
	} else {
		let (mode, kind, layers) = match Handle::parse_mode(&spec.bytes) {
			Ok(mode) => mode,
			Err(message) if message.starts_with("Unknown open() mode") => {
				let rest = layer_spec(&spec.bytes);
				if let Some(&c) = rest.first() && !c.is_ascii_alphanumeric() && c != b':' {
					warn_on(interp, "layer", || format!("Invalid separator character '{}' in PerlIO layer specification {}", c as char, String::from_utf8_lossy(rest)));
				}
				return Err(interp.die_msg(message));
			},
			Err(message) => return Ok(layer_failure(interp, message)),
		};
		let layers = layers_with_default(interp, mode, layers);
		if !matches!(kind, ModeKind::Dup { .. }) && slot.io.borrow().is_open() { let _ = close(interp, &slot.io); }
		match kind {
			ModeKind::File => match &v[1] {
				Value::Ref(Ref::Scalar(sv)) => Handle::open(interp.host(), mode, OpenTarget::Scalar(sv.clone()), layers),
				Value::Undef => open_temp(interp, mode, layers),
				v => { let target = interp.stringify(v)?; open_path(interp, mode, layers, &target.bytes) },
			},
			ModeKind::Dup { same } => match dup_target(interp, &v[1], same)? {
				Ok(target) => Handle::open(interp.host(), mode, target, layers),
				Err(name) => return Err(interp.die_msg(format!("Bad filehandle: {}", name.to_string_lossy()))),
			},
			ModeKind::PipeRead | ModeKind::PipeWrite => {
				if v.len() == 2 {
					let cmd = interp.stringify(&v[1])?;
					open_child(interp, mode, layers, ShellSpec::Line(&cmd.bytes))
				} else {
					let mut argv = Vec::with_capacity(v.len() - 1);
					for v in &v[1..] { argv.push(interp.stringify(v)?.bytes); }
					open_child(interp, mode, layers, ShellSpec::Argv(&argv))
				}
			},
		}
	};
	match opened {
		Ok(h) => Ok(replace(interp, &slot.io, h)),
		Err(err) => {
			if slot.io.borrow().is_open() { let _ = close(interp, &slot.io); }
			Ok(errno(interp, &err))
		},
	}
}

fn layer_failure(interp: &mut Interp<'_>, message: String) -> Ret {
	if message.starts_with("Cannot find encoding") {
		interp.warn_category_default("layer", message);
		fail(interp, libc::EINVAL)
	} else {
		interp.warn_category("layer", message);
		fail(interp, libc::ENOENT)
	}
}

/// Directory for anonymous temporary files, from the shell's environment
/// (`%ENV`): TMPDIR on unix, TEMP or TMP on Windows, else a fixed default.
fn temp_dir(interp: &Interp<'_>) -> Vec<u8> {
	let keys: &[&[u8]] = if cfg!(windows) { &[b"TEMP" as &[u8], b"TMP"] } else { &[b"TMPDIR" as &[u8]] };
	let env = interp.env_pairs();
	keys.iter()
		.find_map(|key| env.iter().find(|(k, v)| k == key && !v.is_empty()).map(|(_, v)| v.clone()))
		.unwrap_or_else(|| if cfg!(windows) { b"C:\\Windows\\Temp".to_vec() } else { b"/tmp".to_vec() })
}

fn open_temp(interp: &mut Interp<'_>, mode: crate::perl::io::OpenMode, layers: Layers) -> io::Result<Handle> {
	let cwd = interp.resolve_path(b".");
	let dir = if omp_vfs::is_virtual_path(&cwd) { cwd } else { interp.resolve_path(&temp_dir(interp)) };
	let fs = interp.host().fs();
	let (path, mut file) = fs.create_temp(&dir, &TempOptions::new().prefix(".perl-open.").random_len(16))?;
	if mode.append {
		file.close()?;
		let mut options = OpenOptions::new();
		options.read(mode.read).append(true);
		file = match fs.open_with(&path, &options) {
			Ok(file) => file,
			Err(err) => { let _ = fs.for_cleanup().remove_file(&path); return Err(err); },
		};
	}
	if let Err(err) = fs.for_cleanup().remove_file(&path) {
		let _ = file.close();
		let _ = fs.for_cleanup().remove_file(&path);
		return Err(err);
	}
	Ok(Handle::from_file(file, mode, layers))
}

pub(super) fn open_standard(interp: &mut Interp<'_>, mode: crate::perl::io::OpenMode, layers: Layers, fd: u8) -> io::Result<Handle> {
	let name = match fd { 0 => "STDIN", 1 => "STDOUT", 2 => "STDERR", _ => return Err(bad_fd()) };
	let io = named(interp, name).ok_or_else(bad_fd)?;
	let opened = io.borrow_mut().alias_standard(mode, layers);
	opened
}

pub(super) fn layers_with_default(interp: &Interp<'_>, mode: crate::perl::io::OpenMode, layers: Layers) -> Layers {
	default_layers(interp, mode).and_then(|s| Layers::parse(&s.bytes).ok()).map_or(layers, |default| layers.inherit(default))
}

pub(super) fn open_path(interp: &mut Interp<'_>, mode: crate::perl::io::OpenMode, layers: Layers, bytes: &[u8]) -> io::Result<Handle> {
	if nul_in_name(interp, "open", "pathname", bytes) { return Err(io::Error::from_raw_os_error(libc::ENOENT)); }
	let path = path(interp, bytes)?;
	let mut opts = OpenOptions::new();
	opts.read(mode.read).write(mode.write).append(mode.append).truncate(mode.truncate).create(mode.create);
	let file = if mode.create && let Some(mask) = interp.sys.umask {
		let perms = 0o666 & !mask;
		opts.create_new(true).truncate(false).mode(perms);
		let fs = interp.host().fs();
		match fs.open_with(&path, &opts) {
			Ok(file) => {
				file.set_permissions(omp_vfs::Permissions::from_mode(perms))?;
				file
			},
			Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
				opts.create_new(false).create(false).truncate(mode.truncate);
				fs.open_with(&path, &opts)?
			},
			Err(e) => return Err(e),
		}
	} else {
		interp.host().fs().open_with(path, &opts)?
	};
	Ok(Handle::from_file(file, mode, layers))
}

/// Start a Perl pipe under the interpreter's cwd and `%ENV`.
pub(in crate::perl) fn open_child(interp: &mut Interp<'_>, mode: crate::perl::io::OpenMode, layers: Layers, spec: ShellSpec<'_>) -> io::Result<Handle> {
	interp.flush_outputs();
	let context = super::process::context(interp);
	let id = super::process::child_id(interp);
	Handle::open_pipe_in(interp.host(), mode, spec, layers, Some(&context), id)
}

/// Resolve the source of a `<&`/`>&=` open. `Err(name)` when no filehandle
/// of that name (or glob IO slot) exists, which 3-arg open reports as "Bad filehandle".
fn dup_target(interp: &mut Interp<'_>, v: &Value, same: bool) -> PResult<Result<OpenTarget<'static>, PStr>> {
	let target = match v {
		Value::Ref(Ref::Io(io)) => Some(io.clone()),
		Value::Glob(g) | Value::Ref(Ref::Glob(g)) => match g.io.borrow().clone() {
			Some(io) => Some(io),
			_ => return Ok(Err(PStr::from_str(&g.name))),
		},
		_ => None,
	};
	Ok(Ok(if let Some(io) = target {
		if same { OpenTarget::DupSame(io) } else { OpenTarget::Dup(io) }
	} else {
		let s = interp.stringify(v)?;
		let name = s.to_string_lossy();
		if !name.is_empty() && name.bytes().all(|b| b.is_ascii_digit()) {
			let fd = name.parse::<i32>().unwrap_or(i32::MAX);
			if let Some(io) = by_fd(interp, fd) {
				if same { OpenTarget::DupSame(io) } else { OpenTarget::Dup(io) }
			} else if same { OpenTarget::Descriptor(fd) } else { OpenTarget::DupDescriptor(fd) }
		} else if let Some(io) = named(interp, &name) {
			if same { OpenTarget::DupSame(io) } else { OpenTarget::Dup(io) }
		} else { return Ok(Err(s.clone())); }
	}))
}

fn sysopen(interp: &mut Interp<'_>, io: &Io, v: &[Value]) -> PResult<Ret> {
	#[cfg(unix)]
	{
		let (Some(name), Some(flags)) = (v.first(), v.get(1)) else { return Err(interp.die_msg("Not enough arguments for sysopen")); };
		let name = interp.stringify(name)?;
		let flags = flags.to_i64() as i32;
		let mode = crate::perl::io::OpenMode {
			read: flags & libc::O_ACCMODE != libc::O_WRONLY,
			write: flags & libc::O_ACCMODE != libc::O_RDONLY,
			append: flags & libc::O_APPEND != 0,
			truncate: flags & libc::O_TRUNC != 0,
			create: flags & libc::O_CREAT != 0,
		};
		let mask = interp.sys.umask.unwrap_or(0);
		let perms = v.get(2).map_or(0o666, |v| v.to_u64() as u32) & !mask;
		let exclusive = mode.create && flags & libc::O_EXCL != 0;
		let mut opts = OpenOptions::new();
		if mode.read && !mode.write && (mode.create || mode.truncate) {
			// Rust's open rejects these flag combinations; pass creation as native flags instead.
			opts.read(true).custom_flags(flags & !libc::O_ACCMODE).mode(perms);
		} else {
			opts.read(mode.read).write(mode.write).append(mode.append).truncate(mode.truncate)
				.create(mode.create).create_new(exclusive).mode(perms)
				.custom_flags(flags & !(libc::O_ACCMODE | libc::O_APPEND | libc::O_TRUNC | libc::O_CREAT | libc::O_EXCL));
		}
		if io.borrow().is_open() { let _ = close(interp, io); }
		let opened = path(interp, &name.bytes).and_then(|p| interp.host().fs().open_with(p, &opts));
		Ok(match opened {
			Ok(file) => {
				let layers = layers_with_default(interp, mode, Layers::default());
				replace(interp, io, Handle::from_file(file, mode, layers))
			},
			Err(e) => errno(interp, &e),
		})
	}
	#[cfg(not(unix))]
	{ let _ = (io, v); Ok(fail(interp, libc::ENOSYS)) }
}

fn truncate(interp: &mut Interp<'_>, es: &[Expr]) -> PResult<Ret> {
	let Some(e) = es.first() else { return Err(interp.die_msg("Not enough arguments for truncate")); };
	let v = if let ExprKind::Bareword(n) = &e.kind { Value::str(n) } else { interp.eval_scalar(e)? };
	let handle = handle_value(interp, &v);
	let len = scalar(interp, es.get(1))?.to_i64();
	// A bareword always names a filehandle, never a file.
	if handle.is_none() && matches!(e.kind, ExprKind::Bareword(_)) { return Ok(fail(interp, libc::EBADF)); }
	let Ok(len) = u64::try_from(len) else { return Ok(fail(interp, libc::EINVAL)); };
	let r = if let Some(h) = handle { h.borrow_mut().truncate(len) } else {
		let s = interp.stringify(&v)?;
		let mut opts = OpenOptions::new();
		opts.write(true);
		path(interp, &s.bytes).and_then(|p| interp.host().fs().open_with(p, &opts)?.set_len(len))
	};
	Ok(result(interp, r, |()| yes()))
}

fn transfer(interp: &mut Interp<'_>, b: Builtin, es: &[Expr], handle: Option<Io>, cx: Cx) -> PResult<Ret> {
	use Builtin as B;
	let Some(buf) = es.get(1) else { return Err(interp.die_msg(format!("Not enough arguments for {}", b.name()))); };
	if b == B::Syswrite {
		if let Some(h) = &handle && interp.tied_handle(h).is_some() {
			let mut argv = interp.eval_aliases(buf)?;
			for expr in &es[2..] { argv.extend(interp.eval_aliases(expr)?); }
			if es.len() == 2 {
				let value = if let Some(sv) = argv.first() { interp.read_sv(sv)? } else { Value::Undef };
				let len = interp.stringify(&value)?.bytes.len() as i64;
				argv.extend(aliases([Value::Int(len)]));
			}
			if let Some(ret) = interp.call_tied_handle(h, "WRITE", argv, Cx::Scalar) { return ret; }
		}
		let v = interp.eval_scalar(buf)?;
		let mut s = interp.stringify(&v)?;
		if s.utf8 {
			s.bytes = s.downgraded().ok_or_else(|| interp.die_msg("Wide character in syswrite"))?;
		}
		let len = if let Some(e) = es.get(2) { interp.eval_scalar(e)?.to_i64() } else { s.bytes.len() as i64 };
		if len < 0 { return Err(interp.die_msg("Negative length")); }
		let offset = scalar(interp, es.get(3))?.to_i64();
		let n = s.bytes.len() as i64;
		let at = if offset < 0 { n.saturating_add(offset) } else { offset };
		if !(0..=n).contains(&at) { return Err(interp.die_msg("Offset outside string")); }
		let Some(h) = handle else { return Ok(fail(interp, libc::EBADF)); };
		let r = h.borrow_mut().syswrite(&s.bytes[at as usize..at.saturating_add(len).min(n) as usize]);
		return transfer_result(interp, r, |n| n as i64);
	}
	let sv = interp.eval_lvalue(buf)?;
	if let Some(h) = &handle && interp.tied_handle(h).is_some() {
		let mut argv = vec![sv.clone()];
		for expr in &es[2..] { argv.extend(interp.eval_aliases(expr)?); }
		if let Some(ret) = interp.call_tied_handle(h, "READ", argv, cx) { return ret; }
	}
	let len = scalar(interp, es.get(2))?.to_i64();
	let offset = scalar(interp, es.get(3))?.to_i64();
	if len < 0 { return Err(interp.die_msg("Negative length")); }
	let Some(h) = handle else { return Ok(fail(interp, libc::EBADF)); };
	let old = if offset == 0 { None } else { Some(interp.read_sv(&sv)?.to_pstr()) };
	let offset = if let Some(old) = &old { read_offset(interp, old, offset)? } else { 0 };
	let len = len as usize;
	let r = interruptible(interp, &h, |h| if b == B::Sysread { h.sysread(len) } else { h.read(len) })?;
	match r {
		Ok(s) => {
			let n = s.char_len();
			finish_read(interp, &sv, s, old, offset)?;
			Ok(one(Value::Int(n as i64)))
		},
		Err(err) => transfer_result::<()>(interp, Err(err), |_| 0),
	}
}

/// Copy an input record into the caller's scalar, adjusting it at `offset`.
pub(in crate::perl) fn apply_read(interp: &mut Interp<'_>, dest: &Sv, s: PStr, offset: i64) -> PResult<()> {
	let old = if offset == 0 { None } else { Some(interp.read_sv(dest)?.to_pstr()) };
	let offset = if let Some(old) = &old { read_offset(interp, old, offset)? } else { 0 };
	finish_read(interp, dest, s, old, offset)
}

fn read_offset(interp: &mut Interp<'_>, old: &PStr, offset: i64) -> PResult<usize> {
	let n = old.char_len() as i64;
	let at = if offset < 0 { n.saturating_add(offset) } else { offset };
	if at < 0 { return Err(interp.die_msg("Offset outside string")); }
	usize::try_from(at).map_err(|_| interp.die_msg("Out of memory!"))
}

fn finish_read(interp: &mut Interp<'_>, dest: &Sv, s: PStr, old: Option<PStr>, offset: usize) -> PResult<()> {
	let Some(mut old) = old else { return interp.write_sv(dest, Value::Str(s)); };
	let n = old.char_len();
	if offset <= n { old.bytes.truncate(old.char_to_byte(offset)); }
	else {
		let extra = offset - n;
		let total = old.bytes.len().saturating_add(extra).saturating_add(s.bytes.len());
		crate::perl::limits::check_len(total, "string").map_err(|e| interp.die_msg(e))?;
		old.bytes.try_reserve(extra).map_err(|_| interp.die_msg("Out of memory!"))?;
		old.bytes.resize(old.bytes.len() + extra, 0);
	}
	old.push(&s);
	interp.write_sv(dest, Value::Str(old))
}

fn transfer_result<T>(interp: &mut Interp<'_>, r: io::Result<T>, len: impl FnOnce(T) -> i64) -> PResult<Ret> {
	match r {
		Err(e) if e.kind() == io::ErrorKind::InvalidInput && e.to_string().contains("isn't allowed on :utf8 handles") => Err(interp.die_msg(e.to_string())),
		r => Ok(result(interp, r, |n| one(Value::Int(len(n))))),
	}
}

fn pipe(interp: &mut Interp<'_>, es: &[Expr]) -> PResult<Ret> {
	let [r, w, ..] = es else { return Err(interp.die_msg("Not enough arguments for pipe")); };
	let r = slot(interp, r)?;
	let w = slot(interp, w)?;
	#[cfg(any(unix, windows))]
	{
		let (reader, writer) = match io::pipe() { Ok(ends) => ends, Err(e) => return Ok(errno(interp, &e)) };
		let read = Handle::from_descriptor(interp.host(), OpenFile::from(reader), READ, Layers::default());
		let write = Handle::from_descriptor(interp.host(), OpenFile::from(writer), WRITE, Layers::default());
		replace(interp, &r.io, read);
		Ok(replace(interp, &w.io, write))
	}
	#[cfg(not(any(unix, windows)))]
	{ let _ = (r, w); Ok(fail(interp, libc::ENOSYS)) }
}

/// Query or change the supported native descriptor flags.
pub(in crate::perl) fn fcntl(interp: &mut Interp<'_>, handle: &Io, command: i32, arg: i32) -> Ret {
	#[cfg(unix)]
	{
		use nix::fcntl::{FcntlArg, FdFlag, OFlag, fcntl};
		let command = match command {
			libc::F_GETFD => FcntlArg::F_GETFD,
			libc::F_SETFD => FcntlArg::F_SETFD(FdFlag::from_bits_truncate(arg)),
			libc::F_GETFL => FcntlArg::F_GETFL,
			libc::F_SETFL => FcntlArg::F_SETFL(OFlag::from_bits_truncate(arg)),
			_ => return fail(interp, libc::EINVAL),
		};
		let r = handle.borrow().with_fd(|fd| fcntl(fd, command).map_err(|e| io::Error::from_raw_os_error(e as i32)));
		result(interp, r, |n| one(zero_true(i64::from(n))))
	}
	#[cfg(not(unix))]
	{ let _ = (handle, command, arg); fail(interp, libc::ENOSYS) }
}
