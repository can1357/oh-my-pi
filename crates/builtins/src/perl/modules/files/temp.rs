//! Atomic temporary file creation and scoped/exit cleanup (File::Temp).

use std::{cell::RefCell, io, path::{Path, PathBuf}, rc::Rc};

use omp_vfs::{File, Metadata, TempOptions};

use super::{cwd, export_tag, failure, isa, one, os, path_value, paths};
use crate::perl::{
	func::sys::remember,
	interp::{Cx, Interp, PResult, Ret},
	io::{FileTestTarget, Handle, Layers, OpenMode, stat_metadata},
	modules::{arg, boolean, constant, define, export, version},
	value::{Av, HKey, PStr, Ref, Sv, Value, new_av, new_gv, new_hv, new_sv},
};

const RW: OpenMode = OpenMode { read: true, write: true, append: false, truncate: false, create: false };
const QUEUE: &str = "File::Temp::_cleanup_queue";
const DEFAULTS: &[&str] = &["tmpnam", "tmpfile", "mktemp", "mkstemp", "mkstemps", "mkdtemp", "SEEK_SET", "SEEK_CUR", "SEEK_END"];
const OPTIONAL: &[&str] = &["tempfile", "tempdir", "tmpnam", "tmpfile", "mktemp", "mkstemp", "mkstemps", "mkdtemp",
	"unlink0", "cleanup", "SEEK_SET", "SEEK_CUR", "SEEK_END"];

/// Install File::Temp's procedural and object interfaces.
pub(super) fn load(interp: &mut Interp<'_>) -> PResult<()> {
	interp.require_module("IO::Handle")?;
	interp.require_module("IO::Seekable")?;
	interp.require_module("File::Path")?;
	version(interp, "File::Temp", "0.2311");
	isa(interp, "File::Temp", &["IO::Handle", "IO::Seekable"]);
	define(interp, "File::Temp", &[
		("tempfile", |i, a, c| temp(i, a, c, Kind::File)), ("tempdir", |i, a, c| temp(i, a, c, Kind::Dir)),
		("mktemp", |i, a, c| temp(i, a, c, Kind::Name)), ("mkstemp", |i, a, c| temp(i, a, c, Kind::Stemp)),
		("mkstemps", |i, a, c| temp(i, a, c, Kind::Stemps)), ("mkdtemp", |i, a, c| temp(i, a, c, Kind::Dtemp)),
		("tmpnam", |i, a, c| temp(i, a, c, Kind::Tmpnam)), ("tmpfile", tmpfile),
		("new", |i, a, c| temp(i, a, c, Kind::Object)), ("newdir", |i, a, c| temp(i, a, c, Kind::DirObject)),
		("filename", filename), ("STRINGIFY", filename), ("unlink_on_destroy", unlink_on_destroy),
		("DESTROY", destroy), ("unlink0", |i, a, _| unlink(i, a, false)), ("unlink1", |i, a, _| unlink(i, a, true)),
		("cleanup", |i, _, _| { cleanup(i, false); one(Value::Undef) }), ("safe_level", safe_level),
	]);
	let rmtree_cv = interp.glob("File::Path::rmtree").code.borrow().clone();
	interp.glob("File::Temp::rmtree").code.replace(rmtree_cv);
	let dir = "File::Temp::Dir";
	version(interp, dir, "0.2311");
	define(interp, dir, &[("dirname", filename), ("STRINGIFY", filename), ("unlink_on_destroy", unlink_on_destroy),
		("rmtree", rmtree), ("DESTROY", destroy)]);
	for module in ["File::Temp", dir] {
		let cv = interp.glob(&format!("{module}::STRINGIFY")).code.borrow().clone();
		if let Some(cv) = cv { interp.set_overload(module, "\"\"", Value::Ref(Ref::Code(cv))); }
		interp.set_overload(module, "fallback", Value::Int(1));
	}
	for (name, n) in [("SEEK_SET", 0), ("SEEK_CUR", 1), ("SEEK_END", 2), ("STANDARD", 0), ("MEDIUM", 1), ("HIGH", 2)] {
		constant(interp, &format!("File::Temp::{name}"), Value::Int(n));
	}
	export(interp, "File::Temp", DEFAULTS, OPTIONAL);
	export_tag(interp, "File::Temp", "seekable", &["SEEK_SET", "SEEK_CUR", "SEEK_END"]);
	export_tag(interp, "File::Temp", "mktemp", &["mktemp", "mkstemp", "mkstemps", "mkdtemp"]);
	export_tag(interp, "File::Temp", "POSIX", &["tmpnam", "tmpfile"]);
	interp.sv("File::Temp::_safe_level").set(Value::Int(0));
	interp.on_exit(Box::new(|interp| cleanup(interp, true)));
	Ok(())
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind { File, Dir, Name, Stemp, Stemps, Dtemp, Tmpnam, Tmpfile, Object, DirObject }

impl Kind {
	fn what(self) -> &'static str {
		match self {
			Self::File => "tempfile()", Self::Dir => "tempdir()", Self::Name => "mktemp",
			Self::Stemp => "mkstemp", Self::Stemps => "mkstemps", Self::Dtemp => "mkdtemp",
			Self::Tmpnam => "tmpnam", Self::Tmpfile => "tmpfile", Self::Object => "new()", Self::DirObject => "newdir()",
		}
	}
	fn is_dir(self) -> bool { matches!(self, Self::Dir | Self::Dtemp | Self::DirObject) }
}

struct Spec {
	template: PStr,
	prefix: Option<PStr>,
	suffix: PStr,
	unlink: bool,
	open: bool,
	exlock: bool,
	mode: Option<u32>,
}

fn temp(interp: &mut Interp<'_>, args: Vec<Sv>, cx: Cx, kind: Kind) -> PResult<Ret> {
	let object = matches!(kind, Kind::Object | Kind::DirObject);
	let class = if kind == Kind::Object { Some(arg(&args, 0).to_pstr().to_string_lossy().into_owned()) }
	else if kind == Kind::DirObject { Some("File::Temp::Dir".to_owned()) } else { None };
	let args = if object { args.get(1..).unwrap_or_default() } else { &args };
	let mut spec = Spec { template: PStr::from_bytes(b"XXXXXXXXXX"), prefix: None, suffix: PStr::default(),
		unlink: object, open: true, exlock: false, mode: None };
	match kind {
		Kind::Name | Kind::Stemp | Kind::Stemps | Kind::Dtemp => {
			spec.template = arg(args, 0).to_pstr();
			if kind == Kind::Stemps { spec.suffix = arg(args, 1).to_pstr(); }
		},
		Kind::Tmpnam | Kind::Tmpfile => spec.prefix = Some(paths::tmpdir(interp)?),
		_ => {
			let mut first = 0;
			let mut explicit = false;
			let mut tmp = false;
			if args.len() % 2 == 1 {
				spec.template = arg(args, 0).to_pstr();
				explicit = true;
				first = 1;
			}
			for pair in args[first..].chunks_exact(2) {
				let key = interp.read_sv(&pair[0])?.to_pstr();
				let value = interp.read_sv(&pair[1])?;
				match key.bytes.to_ascii_uppercase().as_slice() {
					b"TEMPLATE" => { spec.template = value.to_pstr(); explicit = true; },
					b"DIR" => spec.prefix = Some(value.to_pstr()),
					b"TMPDIR" => tmp = value.truthy(),
					b"SUFFIX" if !kind.is_dir() => spec.suffix = value.to_pstr(),
					b"CLEANUP" if kind.is_dir() => spec.unlink = value.truthy(),
					b"UNLINK" if !kind.is_dir() => spec.unlink = value.truthy(),
					b"OPEN" if kind == Kind::File => spec.open = value.truthy(),
					b"EXLOCK" if !kind.is_dir() => spec.exlock = value.truthy(),
					b"PERMS" if !kind.is_dir() => spec.mode = Some(value.to_i64() as u32),
					_ => {},
				}
			}
			if spec.prefix.is_none() && (tmp || (!explicit && (kind.is_dir() || object))) {
				spec.prefix = Some(paths::tmpdir(interp)?);
			}
		},
	}
	let (display, path, file) = create(interp, &spec, kind)?;
	let display = Value::Str(display);
	let mut file = file;
	if matches!(kind, Kind::Name) || (kind == Kind::Tmpnam && cx != Cx::List) || !spec.open {
		if let Some(file) = file.take()
			&& let Err(error) = remove_created_file(interp, &path, &file)
		{
			return Err(create_error(interp, kind, &spec.template, &error.to_string()));
		}
		if !spec.open {
			return if cx == Cx::List { Ok(Ret::Many(vec![Value::Undef, display])) }
			else { Err(interp.die_msg(format!("Error unlinking file {} using unlink0", display.to_pstr().to_string_lossy()))) };
		}
		return one(display);
	}
	let anonymous = kind == Kind::Tmpfile || (matches!(kind, Kind::File | Kind::Stemp | Kind::Stemps) && cx != Cx::List);
	if anonymous && let Some(file) = &file
		&& let Err(error) = remove_created_file(interp, &path, file)
	{
		return Err(create_error(interp, kind, &spec.template, &error.to_string()));
	}
	let state = (!anonymous && (spec.unlink || object)).then(|| {
		let meta = file.as_ref().and_then(|f| f.metadata().ok()).or_else(|| interp.host().fs().symlink_metadata(&path).ok());
		let state = new_av(vec![path_value(&path), display.clone(), Value::Int(i64::from(kind.is_dir())),
			Value::Int(i64::from(spec.unlink)), meta.as_ref().and_then(Metadata::dev).map_or(Value::Undef, Value::UInt),
			meta.as_ref().and_then(Metadata::ino).map_or(Value::Undef, Value::UInt), Value::Int(i64::from(object))]);
		interp.av(QUEUE).elems_mut().push(new_sv(Value::Ref(Ref::Array(state.clone()))));
		state
	});
	if kind.is_dir() {
		if let (Some(class), Some(state)) = (class, state) {
			let attrs = new_hv();
			attrs.entries_mut().insert(HKey::new(&PStr::from_bytes(b"_temp")), new_sv(Value::Ref(Ref::Array(state))));
			let object = Ref::Hash(attrs);
			object.bless(Rc::from(class));
			return one(Value::Ref(object));
		}
		return one(display);
	}
	let Some(file) = file else { return one(Value::Undef); };
	let handle = make_handle(interp, file, class.as_deref(), state);
	if !anonymous && !object && cx == Cx::List { Ok(Ret::Many(vec![handle, display])) }
	else { one(handle) }
}

fn create(interp: &mut Interp<'_>, spec: &Spec, kind: Kind) -> PResult<(PStr, PathBuf, Option<File>)> {
	let name_start = spec.template.bytes.iter().rposition(|b| *b == b'/').map_or(0, |i| i + 1);
	let mut dir = spec.prefix.clone().unwrap_or_else(|| PStr::new(spec.template.bytes[..name_start].to_vec(), spec.template.utf8));
	if kind.is_dir() && spec.prefix.is_some() && matches!(dir.bytes.as_slice(), b"." | b"./") { dir.bytes.clear(); }
	let name = &spec.template.bytes[name_start..];
	let xs = name.iter().rev().take_while(|&&b| b == b'X').count();
	let mut template = dir.clone();
	if !template.is_empty() && !template.bytes.ends_with(b"/") { template.push_bytes(b"/"); }
	template.push(&PStr::new(name.to_vec(), spec.template.utf8));
	template.push(&spec.suffix);
	if xs < 4 { return Err(create_error(interp, kind, &template, "The template must end with at least 4 'X' characters")); }
	if spec.suffix.bytes.contains(&b'/') || template.bytes.contains(&0) || (cfg!(windows) && spec.suffix.bytes.contains(&b'\\')) {
		return Err(create_error(interp, kind, &template, "Invalid argument"));
	}
	let mut opts = TempOptions::new().prefix(os(&name[..name.len() - xs]).into_owned())
		.suffix(os(&spec.suffix.bytes).into_owned()).random_len(xs);
	if let Some(mode) = spec.mode { opts = opts.mode(mode); }
	let parent = interp.resolve_path(if dir.is_empty() { b"." } else { &dir.bytes });
	let safety = interp.sv("File::Temp::_safe_level").get().to_i64();
	let result = {
		let fs = interp.host().fs();
		let checked = (|| {
			if safety < 1 { return Ok(()); }
			let path = fs.canonicalize(&parent)?;
			let mut part = Some(path.as_path());
			while let Some(dir) = part {
				let meta = fs.metadata(dir)?;
				#[cfg(unix)]
				{
					let uid = nix::unistd::geteuid().as_raw();
					if meta.uid().is_some_and(|owner| owner != uid && owner != 0) {
						return Err(io::Error::other("Parent directory is not owned by root or the current user"));
					}
				}
				if meta.mode() & 0o022 != 0 && meta.mode() & 0o1000 == 0 {
					return Err(io::Error::other("Parent directory is writable by group or others but does not have the sticky bit set"));
				}
				part = if safety >= 2 { omp_vfs::parent_path(dir) } else { None };
			}
			Ok(())
		})();
		checked.and_then(|()| if kind.is_dir() {
			fs.create_temp_dir(&parent, &opts).map(|path| (path, None))
		} else {
			let (path, file) = fs.create_temp(&parent, &opts)?;
			if spec.exlock && let Err(err) = exclusive_lock(&file) {
				let _ = fs.remove_file(&path);
				return Err(err);
			}
			Ok((path, Some(file)))
		})
	};
	let (path, file) = result.map_err(|error| {
		interp.set_errno(&error);
		let message = error.to_string();
		create_error(interp, kind, &template, message.split(" (os error ").next().unwrap_or(&message))
	})?;
	let mut display = dir;
	if !display.is_empty() && !display.bytes.ends_with(b"/") { display.push_bytes(b"/"); }
	if let Some(name) = path.file_name() { display.bytes.extend_from_slice(name.as_encoded_bytes()); }
	Ok((display, path, file))
}

fn exclusive_lock(file: &File) -> io::Result<()> {
	#[cfg(any(target_os = "macos", target_os = "freebsd", target_os = "netbsd", target_os = "openbsd", target_os = "dragonfly"))]
	{
		if let Some(native) = file.native() {
			rustix::fs::flock(native, rustix::fs::FlockOperation::NonBlockingLockExclusive)?;
		}
	}
	#[cfg(not(any(target_os = "macos", target_os = "freebsd", target_os = "netbsd", target_os = "openbsd", target_os = "dragonfly")))]
	let _ = file;
	Ok(())
}

fn create_error(interp: &mut Interp<'_>, kind: Kind, template: &PStr, reason: &str) -> crate::perl::interp::Flow {
	let what = kind.what();
	interp.die_msg(format!("Error in {what} using {}: {reason}\n", template.to_string_lossy()))
}

fn make_handle(interp: &mut Interp<'_>, file: File, class: Option<&str>, state: Option<Av>) -> Value {
	let class_name = class.unwrap_or("File::Temp");
	let g = new_gv(Rc::from(class_name), Rc::from("__ANONIO__"));
	if let Some(state) = state { g.scalar.borrow().set(Value::Ref(Ref::Array(state))); }
	let io = Rc::new(RefCell::new(Handle::from_file(file, RW, Layers::default())));
	interp.set_handle(&g, io.clone());
	let display = g.name.clone();
	let reference = Ref::Glob(g);
	if let Some(class) = class { reference.bless(Rc::from(class)); }
	let value = Value::Ref(reference);
	remember(interp, &io, value.clone(), display);
	value
}

fn tmpfile(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	temp(interp, args, Cx::Scalar, Kind::Tmpfile)
}

/// Open an unnamed temporary file, with IO::File methods.
pub(super) fn io_tmpfile(interp: &mut Interp<'_>, class: &str) -> PResult<Ret> {
	let spec = Spec { template: PStr::from_bytes(b"XXXXXXXXXX"), prefix: Some(paths::tmpdir(interp)?),
		suffix: PStr::default(), unlink: true, open: true, exlock: false, mode: None };
	let (_, path, file) = create(interp, &spec, Kind::Tmpfile)?;
	let Some(file) = file else { return one(Value::Undef); };
	if let Err(error) = remove_created_file(interp, &path, &file) { return failure(interp, error); }
	one(make_handle(interp, file, Some(class), None))
}

fn remove_created_file(interp: &mut Interp<'_>, path: &Path, file: &File) -> io::Result<()> {
	let fs = interp.host().fs();
	let original = file.metadata()?;
	let entry = fs.symlink_metadata(path)?;
	if entry.is_symlink() || entry.nlink().is_some_and(|n| n != 1)
		|| (original.file_id().is_some() && !original.same_file(&entry))
	{
		return Err(io::Error::from_raw_os_error(libc::EPERM));
	}
	fs.remove_file(path)
}

fn state(value: Value) -> Option<Av> {
	let value = match value {
		Value::Ref(Ref::Hash(attrs)) => {
			let entries = attrs.entries();
			entries.get(&HKey::new(&PStr::from_bytes(b"_temp")))?.get()
		},
		Value::Ref(Ref::Glob(gv)) => gv.scalar.borrow().get(),
		_ => return None,
	};
	if let Value::Ref(Ref::Array(state)) = value { Some(state) } else { None }
}

fn at(state: &Av, index: usize) -> Value {
	state.elems().get(index).map_or(Value::Undef, |slot| slot.get())
}

fn set_flag(state: &Av, enabled: bool) {
	if let Some(slot) = state.elems().get(3) { slot.set(Value::Int(i64::from(enabled))); }
}

fn filename(_: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	one(state(arg(&args, 0)).map_or(Value::Undef, |state| at(&state, 1)))
}

fn unlink_on_destroy(_: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let Some(state) = state(arg(&args, 0)) else { return one(Value::Undef) };
	if args.len() > 1 { set_flag(&state, arg(&args, 1).truthy()); }
	one(at(&state, 3))
}

fn destroy(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let value = arg(&args, 0);
	if let Some(state) = state(value.clone())
		&& remove(interp, &state, false)
		&& let Some(handle) = super::handles::as_handle(interp, &value)
		&& handle.borrow().is_open()
	{
		let _ = handle.borrow_mut().close();
	}
	one(Value::Undef)
}

fn rmtree(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let removed = state(arg(&args, 0)).is_some_and(|state| remove(interp, &state, true));
	Ok(boolean(removed))
}

fn cleanup(interp: &mut Interp<'_>, include_objects: bool) {
	if interp.sv("File::Temp::KEEP_ALL").get().truthy() { return; }
	let queue = interp.av(QUEUE);
	let mut keep = Vec::new();
	for value in queue.replace_elems(Vec::new()).into_iter().rev() {
		let Value::Ref(Ref::Array(state)) = value.get() else { continue; };
		if !include_objects && at(&state, 6).truthy() { keep.push(value); }
		else { remove(interp, &state, false); }
	}
	if !keep.is_empty() {
		keep.reverse();
		queue.elems_mut().append(&mut keep);
	}
}

fn remove(interp: &mut Interp<'_>, state: &Av, force: bool) -> bool {
	if !force && (!at(state, 3).truthy() || interp.sv("File::Temp::KEEP_ALL").get().truthy()) { return false; }
	let path = at(state, 0).to_pstr();
	let path = Path::new(&*os(&path.bytes)).to_path_buf();
	let dir = at(state, 2).truthy();
	let device = at(state, 4);
	let inode = at(state, 5);
	let cwd = cwd(interp);
	let fs = interp.host().fs();
	let Ok(meta) = fs.symlink_metadata(&path) else { set_flag(state, false); return false; };
	if meta.is_dir() != dir || meta.is_symlink() || (!device.is_undef() && meta.dev() != Some(device.to_u64()))
		|| (!inode.is_undef() && meta.ino() != Some(inode.to_u64())) { return false; }
	if dir && fs.canonicalize(&path).is_ok_and(|path| cwd.starts_with(path)) { return false; }
	let result = if dir { fs.remove_dir_all(&path) } else { fs.remove_file(&path) };
	if result.is_ok() { set_flag(state, false); true } else { false }
}

fn unlink(interp: &mut Interp<'_>, args: Vec<Sv>, close: bool) -> PResult<Ret> {
	if args.len() != 2 {
		let name = if close { "unlink1" } else { "unlink0" };
		return Err(interp.die_msg(format!("Usage: {name}(filehandle, filename)")));
	}
	let value = arg(&args, 0);
	let name = arg(&args, 1).to_pstr();
	let Some(handle) = super::handles::as_handle(interp, &value) else {
		return failure(interp, io::Error::from_raw_os_error(libc::EBADF));
	};
	let path = interp.resolve_path(&name.bytes);
	let result = {
		let host = interp.host();
		let meta = stat_metadata(host, FileTestTarget::Handle(&handle), true);
		meta.and_then(|meta| {
			let target = host.fs().symlink_metadata(&path)?;
			if !meta.same_file(&target) || target.is_symlink() || target.nlink().is_some_and(|n| n != 1) {
				return Err(io::Error::from_raw_os_error(libc::EPERM));
			}
			if close { handle.borrow_mut().close()?; }
			host.fs().remove_file(&path)
		})
	};
	match result { Ok(()) => one(Value::Int(1)), Err(err) => failure(interp, err) }
}

fn safe_level(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let slot = interp.sv("File::Temp::_safe_level");
	if args.len() > 1 {
		let level = arg(&args, 1).to_i64();
		if cfg!(unix) && (0..=2).contains(&level) { interp.write_sv(&slot, Value::Int(level))?; }
	}
	one(interp.read_sv(&slot)?)
}
