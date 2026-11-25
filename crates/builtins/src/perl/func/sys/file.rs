//! Filesystem operations and Perl's per-interpreter `_` stat cache (perlfunc, perlop).

use std::{cell::RefCell, io, path::PathBuf, rc::Rc, time::{Duration, UNIX_EPOCH}};

use omp_vfs::{DirOptions, FileTime, Metadata, Permissions};

use crate::perl::{
	ast::{Builtin, Call, Expr, ExprKind, Sigil}, interp::{Cx, Interp, PResult, Ret},
	io::{self as pio, DirHandle, FileTestTarget, Io}, value::{PStr, Ref, Value, new_sv},
};

use super::{args, bad_fd, bool_ret, bool_value, errno, fail, handles, io_name, link_path, list, nul_in_name, one, os_str, path, result, scalar, set_io_errno, topic, warn_on, yes};

#[derive(Clone)]
enum Target { Path(PathBuf), Handle(Io), Dir(Rc<RefCell<DirHandle>>), Descriptor(i32) }

impl Target {
	fn with<T>(&self, f: impl FnOnce(FileTestTarget<'_>) -> io::Result<T>) -> io::Result<T> {
		match self {
			Self::Path(path) => f(FileTestTarget::ResolvedPath(path)),
			Self::Handle(h) => f(FileTestTarget::Handle(h)),
			Self::Dir(dir) => f(FileTestTarget::Dir(&dir.borrow())),
			Self::Descriptor(n) => f(FileTestTarget::Descriptor(*n)),
		}
	}
}

pub(super) struct CachedStat {
	meta: Result<Metadata, (io::ErrorKind, Option<i32>)>,
	followed: bool,
	target: Option<Target>,
}

impl CachedStat {
	fn metadata(&self) -> io::Result<&Metadata> {
		self.meta.as_ref().map_err(|&(kind, code)| code.map_or_else(|| kind.into(), io::Error::from_raw_os_error))
	}
}

/// Populate Perl's special `_` cache for an operation that already obtained metadata.
pub(in crate::perl) fn cache_stat(interp: &mut Interp<'_>, metadata: Metadata, followed: bool) {
	interp.sys.stat = Some(CachedStat { meta: Ok(metadata), followed, target: None });
}

fn remember(interp: &mut Interp<'_>, target: Target, follow: bool) -> io::Result<()> {
	let meta = target.with(|t| pio::stat_metadata(interp.host(), t, follow));
	let outcome = meta.as_ref().map(|_| ()).map_err(|e| e.raw_os_error().map_or_else(|| e.kind().into(), io::Error::from_raw_os_error));
	interp.sys.stat = Some(CachedStat { meta: meta.map_err(|e| (e.kind(), e.raw_os_error())), followed: follow, target: Some(target) });
	outcome
}

fn cached(operand: Option<&Expr>) -> bool {
	matches!(operand.map(|e| &e.kind), Some(ExprKind::Bareword(n) | ExprKind::Variable(Sigil::Glob, n)) if n.as_ref() == "_")
}

fn dir_for(interp: &mut Interp<'_>, handle: &Io) -> Option<Rc<RefCell<DirHandle>>> {
	let key = io_name(handle);
	let (weak, dir) = interp.sys.dirs.get(&key)?;
	if weak.strong_count() != 0 { Some(dir.clone()) } else { interp.sys.dirs.remove(&key); None }
}

fn for_handle(interp: &mut Interp<'_>, handle: Io) -> Target {
	match dir_for(interp, &handle) { Some(dir) => Target::Dir(dir), None => Target::Handle(handle) }
}

enum Operand {
	Target(Target),
	Value(Value),
	/// The special `_` handle: reuse the last stat.
	Cached,
	/// A bareword or glob naming a filehandle that was never opened.
	Unopened(Rc<str>),
}

/// Evaluate a stat/filetest operand; `label` is the op as warnings name it ("-l", "stat()").
fn value(interp: &mut Interp<'_>, operand: Option<&Expr>, label: &str) -> PResult<Operand> {
	if cached(operand) { return Ok(Operand::Cached); }
	// `-f()` tests `$_` like a bare `-f`.
	let operand = operand.filter(|e| !matches!(&e.kind, ExprKind::List(v) if v.is_empty()));
	let val = if let Some(e) = operand {
		if let ExprKind::Bareword(n) = &e.kind {
			if let Some(io) = handles::named(interp, n) { return Ok(Operand::Target(for_handle(interp, io))); }
			// A bareword operand names a filehandle unless it calls a sub.
			if !interp.find_glob(n).is_some_and(|gv| gv.code.borrow().is_some()) {
				return Ok(Operand::Unopened(n.clone()));
			}
			interp.eval_scalar(e)?
		} else { interp.eval_scalar(e)? }
	} else if label == "-t" {
		return Ok(Operand::Target(handles::named(interp, "STDIN").map_or(Target::Descriptor(0), Target::Handle)));
	} else { topic(interp)? };
	if matches!(label, "-t" | "-T" | "-B") && let Value::Ref(r @ Ref::Io(_)) = &val && r.blessed().is_some() {
		// Perl stringifies a blessed IO operand of these tests (through "" overloading) before using it as a handle.
		interp.stringify(&val)?;
	}
	if label == "-l" {
		// -l never uses a handle: it warns and tests the stringified glob as a name.
		let name = match &val { Value::Glob(gv) | Value::Ref(Ref::Glob(gv)) => Some(gv.name.to_string()), Value::Ref(Ref::Io(_)) => Some(String::new()), _ => None };
		if let Some(name) = name {
			warn_on(interp, "io", || if name.is_empty() { "Use of -l on filehandle".into() } else { format!("Use of -l on filehandle {name}") });
			let s = interp.stringify(&val)?;
			return Ok(Operand::Value(Value::Str(s)));
		}
	}
	if let Value::Glob(gv) | Value::Ref(Ref::Glob(gv)) = &val && gv.io.borrow().is_none() {
		if &*gv.name == "_" && &*gv.pkg == "main" { return Ok(Operand::Cached); }
		return Ok(Operand::Unopened(gv.name.clone()));
	}
	Ok(Operand::Value(val))
}

/// Resolve an evaluated operand; `label` names the op in warnings ("-r", "stat()").
fn target(interp: &mut Interp<'_>, operand: Operand, op: u8, label: &str) -> PResult<io::Result<Target>> {
	let val = match operand {
		Operand::Target(t) => {
			let closed = matches!(&t, Target::Handle(h) if !h.borrow().is_open());
			if op != b't' && matches!(t, Target::Handle(_) | Target::Dir(_)) && (label == "-l" || label == "lstat()" || closed) {
				let name = match &t { Target::Handle(h) => handles::identity(interp, h).1, _ => Rc::from("") };
				if label == "-l" {
					warn_on(interp, "io", || format!("Use of -l on filehandle {name}"));
					return Ok(Err(bad_fd()));
				}
				if label == "lstat()" { warn_on(interp, "io", || format!("lstat() on filehandle {name}")); }
				if closed { warn_on(interp, "closed", || format!("{label} on closed filehandle {name}")); }
			}
			return Ok(Ok(t));
		},
		Operand::Cached => return Ok(Err(bad_fd())),
		Operand::Unopened(name) => {
			match label {
				"-t" => {},
				"-l" => warn_on(interp, "io", || format!("Use of -l on filehandle {name}")),
				_ => {
					if label == "lstat()" { warn_on(interp, "io", || format!("lstat() on filehandle {name}")); }
					warn_on(interp, "unopened", || format!("{label} on unopened filehandle {name}"));
				},
			}
			return Ok(Err(bad_fd()));
		},
		Operand::Value(v) => v,
	};
	if !matches!(val, Value::Str(_)) && let Some(h) = handles::handle_value(interp, &val) {
		let handle = for_handle(interp, h);
		return target(interp, Operand::Target(handle), op, label);
	}
	if op == b't' && val.looks_like_number() {
		let fd = val.to_i64() as i32;
		return Ok(Ok(handles::by_fd(interp, fd).map_or(Target::Descriptor(fd), Target::Handle)));
	}
	let value = interp.stringify(&val)?;
	Ok(if op == b'l' { link_path(interp, &value.bytes) } else { path(interp, &value.bytes) }.map(Target::Path))
}

/// Evaluate unary file tests, including stacked suffixes and `_` reuse.
pub(in crate::perl) fn file_test(interp: &mut Interp<'_>, op: u8, operand: Option<&Expr>) -> PResult<Value> {
	let mut tests = vec![op];
	let mut operand = operand;
	while let Some(Expr { kind: ExprKind::FileTest(op, inner), .. }) = operand {
		tests.push(*op);
		operand = inner.as_deref();
	}
	let inner = tests.last().copied().unwrap_or(op);
	let label = format!("-{}", inner as char);
	let value = value(interp, operand, &label)?;
	let evaluated = if matches!(value, Operand::Cached) {
		if inner == b't' {
			// `-t _` names the never-opened filehandle `_`, not the stat cache.
			interp.set_errno_code(libc::EBADF);
			return Ok(Value::Undef);
		}
		None
	} else {
		if let Operand::Value(object @ Value::Ref(r)) = &value
			&& let Some(class) = r.blessed()
			&& let Some(handler) = interp.overload_handler(&class, "-X")
		{
			return overloaded_file_tests(interp, handler, object.clone(), tests);
		}
		match target(interp, value, inner, &label)? {
			Ok(target) => Some(target),
			Err(err) => {
				set_io_errno(interp, &err);
				if inner != b't' {
					interp.sys.stat = Some(CachedStat { meta: Err((err.kind(), err.raw_os_error())), followed: inner != b'l', target: None });
				}
				return Ok(Value::Undef);
			},
		}
	};
	let started = interp.start_time();
	let mut val = Value::Undef;
	for (depth, op) in tests.into_iter().rev().enumerate() {
		if depth == 0 && let Some(t) = &evaluated && op != b't' {
			if op == b'l' && !matches!(t, Target::Path(_)) {
				interp.set_errno_code(libc::EBADF);
				return Ok(Value::Undef);
			}
			if let Err(e) = remember(interp, t.clone(), op != b'l') {
				set_io_errno(interp, &e);
				return Ok(Value::Undef);
			}
		}
		let r = if op == b't' && let Some(t) = &evaluated {
			t.with(|t| pio::file_test(interp.host(), op, t, started))
		} else if matches!(op, b'T' | b'B') {
			let t = evaluated.clone().or_else(|| interp.sys.stat.as_ref()?.target.clone());
			let r = match &t { Some(t) => t.with(|t| pio::file_test(interp.host(), op, t, started)), None => Err(bad_fd()) };
			match &r {
				// A file that cannot be opened for reading keeps its stat buffer
				// ([perl #4253]); a closed or bad handle leaves `_` failed, still naming
				// the same target so a later `-T _` retries it.
				Err(_) if matches!(t, Some(Target::Path(_))) => {},
				Err(e) => interp.sys.stat = Some(CachedStat { meta: Err((e.kind(), e.raw_os_error())), followed: true, target: t }),
				// -T/-B stat the file they read, so `_` no longer holds an lstat.
				Ok(_) => if let Some(c) = interp.sys.stat.as_mut() { c.followed = true; },
			}
			r
		} else {
			let Some(c) = &interp.sys.stat else { return Ok(Value::Undef); };
			if op == b'l' && c.followed { return Err(interp.die_msg("The stat preceding -l _ wasn't an lstat")); }
			match c.metadata() {
				Ok(m) => {
					let m = m.clone();
					pio::file_test(interp.host(), op, FileTestTarget::Cached(&m), started)
				},
				// A failed stat leaves `_` without a file, like an unopened handle.
				Err(_) if evaluated.is_none() => Err(bad_fd()),
				Err(e) => Err(e),
			}
		};
		match r {
			Ok(v) => val = v,
			Err(e) => { set_io_errno(interp, &e); return Ok(Value::Undef); },
		}
		if !val.truthy() { break; }
	}
	Ok(val)
}

fn overloaded_file_tests(interp: &mut Interp<'_>, handler: Value, value: Value, tests: Vec<u8>) -> PResult<Value> {
	let mut result = Value::Undef;
	for op in tests.into_iter().rev() {
		let op = Value::bytes(&[op]);
		result = if let Value::Ref(Ref::Code(cv)) = &handler {
			interp.call_sub(cv, vec![new_sv(value.clone()), new_sv(op), new_sv(bool_value(false))], Cx::Scalar)?
		} else {
			interp.call_method(value.clone(), &handler.to_pstr().to_string_lossy(), vec![op, bool_value(false)], Cx::Scalar)?
		}.scalar();
		if !interp.truthy(&result)? { break; }
	}
	Ok(result)
}

pub(super) fn call(interp: &mut Interp<'_>, b: Builtin, call: &Call, cx: Cx) -> PResult<Ret> {
	use Builtin as B;
	let es = args(call);
	match b {
		B::Stat | B::Lstat => return stat(interp, b == B::Stat, es.first(), cx),
		B::Opendir | B::Readdir | B::Telldir | B::Seekdir | B::Rewinddir | B::Closedir => return directory(interp, b, es, cx),
		_ => {},
	}
	let v = list(interp, call)?;
	let v0 = || v.first().unwrap_or(&Value::Undef);
	Ok(match b {
		B::Chdir => {
			if v.first().is_some_and(is_handle) { return Err(interp.die_msg("The fchdir function is unimplemented")); }
			let s = if v.is_empty() {
				let env = interp.env_pairs();
				let home = env.iter().find(|(key, _)| key == b"HOME").or_else(|| env.iter().find(|(key, _)| key == b"LOGDIR"));
				let Some((_, home)) = home else { return Ok(fail(interp, libc::EINVAL)); };
				PStr::from_bytes(home)
			} else { interp.stringify(v0())? };
			let r = path(interp, &s.bytes).and_then(|p| {
				let m = interp.host().fs().metadata(&p)?;
				if m.is_dir() { Ok(p) } else { Err(io::Error::from_raw_os_error(libc::ENOTDIR)) }
			});
			match r { Ok(p) => { interp.set_cwd(p); yes() }, Err(e) => errno(interp, &e) }
		},
		B::Umask => {
			let old = interp.sys.umask.unwrap_or_else(|| interp.host().umask());
			if let Some(v) = v.first() && !v.is_undef() { interp.sys.umask = Some(v.to_u64() as u32 & 0o777); }
			one(Value::Int(i64::from(old)))
		},
		B::Chroot => fail(interp, libc::EPERM),
		B::Chmod | B::Chown | B::Utime if v.iter().skip(1 + usize::from(b != B::Chmod)).any(is_handle) => {
			let name = match b { B::Chmod => "fchmod", B::Chown => "fchown", _ => "futimes" };
			return Err(interp.die_msg(format!("The {name} function is unimplemented")));
		},
		B::Chmod => {
			let mode = v0().to_u64() as u32;
			per_path(interp, "chmod", v.get(1..).unwrap_or_default(), |host, p| host.fs().set_permissions(p, Permissions::from_mode(mode)))?
		},
		B::Chown => {
			let uid = u32::try_from(v0().to_i64()).ok();
			let gid = v.get(1).and_then(|v| u32::try_from(v.to_i64()).ok());
			per_path(interp, "chown", v.get(2..).unwrap_or_default(), |host, p| host.fs().chown(p, uid, gid, true))?
		},
		B::Utime => {
			let mtime = v.get(1).unwrap_or(&Value::Undef);
			let times = if v0().is_undef() && mtime.is_undef() { Ok((FileTime::Now, FileTime::Now)) }
				else { time(v0()).and_then(|at| time(mtime).map(|mt| (at, mt))) };
			let (at, mt) = match times { Ok(t) => t, Err(e) => return Ok(errno(interp, &e)) };
			per_path(interp, "utime", v.get(2..).unwrap_or_default(), |host, p| host.fs().set_times(p, at, mt, true))?
		},
		B::Unlink => {
			let default;
			let files = if v.is_empty() { default = [topic(interp)?]; &default[..] } else { &v };
			// Perl refuses directories itself (no -U), whatever unlink(2) would do.
			per_path(interp, "unlink", files, |host, p| {
				if host.fs().symlink_metadata(&p).is_ok_and(|m| m.is_dir()) { return Err(io::Error::from_raw_os_error(libc::EISDIR)); }
				host.fs().remove_file(p)
			})?
		},
		B::Mkdir | B::Rmdir | B::Readlink => {
			let value = match v.first() { Some(v) => v.clone(), None => topic(interp)? };
			let name = interp.stringify(&value)?;
			let path = if b == B::Readlink { link_path(interp, &name.bytes) } else { path(interp, &name.bytes) };
			let path = match path { Ok(p) => p, Err(e) => return Ok(errno(interp, &e)) };
			match b {
				B::Mkdir => {
					let mode = v.get(1).map_or(0o777, |v| v.to_u64() as u32);
					let mask = interp.sys.umask.unwrap_or_else(|| interp.host().umask());
					let r = interp.host().fs().create_dir_with(&path, &DirOptions::new().mode(mode & !mask));
					let r = if interp.sys.umask.is_some() { r.and_then(|()| interp.host().fs().set_permissions(&path, Permissions::from_mode(mode & !mask))) } else { r };
					result(interp, r, |()| yes())
				},
				B::Rmdir => { let r = interp.host().fs().remove_dir(path); result(interp, r, |()| yes()) },
				_ => { let r = interp.host().fs().read_link(path); result(interp, r, |p| one(Value::Str(PStr::new(p.into_os_string().into_encoded_bytes(), false)))) },
			}
		},
		B::Rename | B::Link | B::Symlink => {
			let src = interp.stringify(v0())?;
			let dst = interp.stringify(v.get(1).unwrap_or(&Value::Undef))?;
			let dst = match path(interp, &dst.bytes) { Ok(p) => p, Err(e) => return Ok(errno(interp, &e)) };
			let r = if b == B::Symlink {
				if src.bytes.contains(&0) { Err(io::Error::from_raw_os_error(libc::EINVAL)) }
				else { interp.host().fs().symlink(&*os_str(&src.bytes), dst) }
			} else {
				path(interp, &src.bytes).and_then(|src| if b == B::Rename { interp.host().fs().rename(src, dst) } else { interp.host().fs().hard_link(src, dst) })
			};
			result(interp, r, |()| yes())
		},
		_ => one(Value::Undef),
	})
}

fn per_path(interp: &mut Interp<'_>, name: &str, values: &[Value], mut op: impl FnMut(&crate::host::Host, PathBuf) -> io::Result<()>) -> PResult<Ret> {
	let mut count = 0;
	for value in values {
		let s = interp.stringify(value)?;
		if nul_in_name(interp, name, "pathname", &s.bytes) { continue; }
		match path(interp, &s.bytes).and_then(|p| op(interp.host(), p)) {
			Ok(()) => count += 1,
			Err(e) => set_io_errno(interp, &e),
		}
	}
	Ok(one(Value::Int(count)))
}

/// A filehandle operand, which needs the f* variant of a path operation.
fn is_handle(v: &Value) -> bool {
	matches!(v, Value::Glob(_) | Value::Ref(Ref::Glob(_) | Ref::Io(_)))
}

fn time(v: &Value) -> io::Result<FileTime> {
	let value = v.to_f64();
	let invalid = || io::Error::from_raw_os_error(libc::EINVAL);
	let duration = Duration::try_from_secs_f64(value.abs()).map_err(|_| invalid())?;
	let time = if value.is_sign_negative() { UNIX_EPOCH.checked_sub(duration) } else { UNIX_EPOCH.checked_add(duration) };
	time.map(FileTime::At).ok_or_else(invalid)
}

fn stat(interp: &mut Interp<'_>, follow: bool, operand: Option<&Expr>, cx: Cx) -> PResult<Ret> {
	let op = if follow { b'e' } else { b'l' };
	let label = if follow { "stat()" } else { "lstat()" };
	let operand = value(interp, operand, label)?;
	let r = if matches!(operand, Operand::Cached) {
		let Some(c) = &interp.sys.stat else { interp.set_errno_code(libc::EBADF); return Ok(stat_missing(cx)); };
		if !follow && c.followed { return Err(interp.die_msg("The stat preceding lstat() wasn't an lstat")); }
		c.metadata().cloned().map_err(|_| bad_fd())
	} else {
		match target(interp, operand, op, label)? {
			Ok(t) => remember(interp, t, follow).and_then(|()| interp.sys.stat.as_ref().ok_or_else(bad_fd)?.metadata().cloned()),
			Err(e) => {
				interp.sys.stat = Some(CachedStat { meta: Err((e.kind(), e.raw_os_error())), followed: follow, target: None });
				Err(e)
			},
		}
	};
	match r {
		Ok(m) if cx == Cx::List => {
			let vals = pio::stat(interp.host(), FileTestTarget::Cached(&m), follow);
			Ok(result(interp, vals, |vals| Ret::Many(Vec::from(vals))))
		},
		Ok(_) => Ok(yes()),
		Err(e) => { set_io_errno(interp, &e); Ok(stat_missing(cx)) },
	}
}

fn stat_missing(cx: Cx) -> Ret { if cx == Cx::List { Ret::Many(Vec::new()) } else { one(bool_value(false)) } }

fn directory(interp: &mut Interp<'_>, b: Builtin, es: &[Expr], cx: Cx) -> PResult<Ret> {
	use Builtin as B;
	let Some(expr) = es.first() else { return Err(interp.die_msg(format!("Not enough arguments for {}", b.name()))); };
	if b == B::Opendir {
		let slot = handles::slot(interp, expr)?;
		let p = scalar(interp, es.get(1))?;
		let s = interp.stringify(&p)?;
		let r = path(interp, &s.bytes).and_then(|p| DirHandle::open_resolved(interp.host(), p));
		if slot.io.borrow().is_open() { let _ = handles::close(interp, &slot.io); }
		let key = io_name(&slot.io);
		interp.sys.dirs.remove(&key);
		return Ok(match r {
			Ok(dir) => {
				interp.sys.dirs.retain(|_, (io, _)| io.strong_count() != 0);
				interp.sys.dirs.insert(key, (Rc::downgrade(&slot.io), Rc::new(RefCell::new(dir))));
				yes()
			},
			Err(err) => errno(interp, &err),
		});
	}
	let io = handles::from_expr(interp, expr)?;
	let dir = io.as_ref().and_then(|h| dir_for(interp, h));
	let Some(dir) = dir else { interp.set_errno_code(libc::EBADF); return Ok(stat_missing(cx)); };
	Ok(match b {
		B::Closedir => {
			if let Some(io) = io { interp.sys.dirs.remove(&io_name(&io)); }
			result(interp, dir.borrow_mut().close(), |()| yes())
		},
		B::Telldir => result(interp, dir.borrow().tell(), |n| one(Value::Int(n as i64))),
		B::Rewinddir => result(interp, dir.borrow_mut().rewind(), |()| yes()),
		B::Seekdir => {
			let pos = scalar(interp, es.get(1))?.to_u64();
			result(interp, dir.borrow_mut().seek(pos), |()| yes())
		},
		B::Readdir => {
			let mut d = dir.borrow_mut();
			if cx == Cx::List {
				let mut out = Vec::new();
				loop {
					match d.read() {
						Ok(Some(s)) => out.push(Value::Str(s)),
						Ok(None) => break,
						Err(e) => { set_io_errno(interp, &e); break; },
					}
				}
				Ret::Many(out)
			} else { result(interp, d.read(), |s| one(s.map_or(Value::Undef, Value::Str))) }
		},
		_ => bool_ret(false),
	})
}
