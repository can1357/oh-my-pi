//! File-to-file/handle transfer, comparison, and object-oriented stat data.

use std::{io::{self, BufRead, BufReader, Read, Write}, path::{Path, PathBuf}, rc::Rc};

use omp_vfs::{File, Metadata, Permissions};

use super::{export_tag, failure, handles::as_handle, one};
use crate::perl::{
	func::sys::cache_stat,
	interp::{Cx, Flow, Interp, PResult, Ret},
	io::{self as pio, FileTestTarget, Handle, Io, Layers, OpenMode, RecordSep},
	modules::{arg, boolean, define, export, version},
	value::{Cv, PStr, Ref, Sv, Value, new_av, new_sv},
};
const FIELDS: &[&str] = &["dev", "ino", "mode", "nlink", "uid", "gid", "rdev", "size", "atime", "mtime", "ctime", "blksize", "blocks"];
const FIELD_EXPORTS: &[&str] = &["$st_dev", "$st_ino", "$st_mode", "$st_nlink", "$st_uid", "$st_gid", "$st_rdev", "$st_size",
	"$st_atime", "$st_mtime", "$st_ctime", "$st_blksize", "$st_blocks"];

/// Install one of the data transfer or metadata packages.
pub(super) fn load(interp: &mut Interp<'_>, module: &str) -> PResult<()> {
	match module {
		"File::Copy" => {
			version(interp, module, "2.35");
			define(interp, module, &[
				("copy", |i, a, _| copy(i, a, false)), ("cp", |i, a, _| copy(i, a, true)),
				("move", move_file), ("mv", move_file),
			]);
			export(interp, module, &["copy", "move"], &["cp", "mv"]);
		},
		"File::Compare" => {
			version(interp, module, "1.1006");
			define(interp, module, &[("compare", |i, a, _| compare(i, a, false)), ("cmp", |i, a, _| compare(i, a, false)),
				("compare_text", |i, a, _| compare(i, a, true))]);
			export(interp, module, &["compare"], &["cmp", "compare_text"]);
		},
		"File::stat" => {
			version(interp, module, "1.09");
			interp.define_native_proto("File::stat::stat", |i, a, _| stat(i, a, true), "[$]");
			interp.define_native_proto("File::stat::lstat", |i, a, _| stat(i, a, false), "[$]");
			define(interp, module, &[("new", new_stat), ("populate", populate), ("cando", cando), ("stat_cando", cando), ("-X", stat_test),
				("dev", |i, a, _| field(i, a, 0)), ("ino", |i, a, _| field(i, a, 1)), ("mode", |i, a, _| field(i, a, 2)),
				("nlink", |i, a, _| field(i, a, 3)), ("uid", |i, a, _| field(i, a, 4)), ("gid", |i, a, _| field(i, a, 5)),
				("rdev", |i, a, _| field(i, a, 6)), ("size", |i, a, _| field(i, a, 7)), ("atime", |i, a, _| field(i, a, 8)),
				("mtime", |i, a, _| field(i, a, 9)), ("ctime", |i, a, _| field(i, a, 10)), ("blksize", |i, a, _| field(i, a, 11)),
				("blocks", |i, a, _| field(i, a, 12))]);
			let exports: Vec<_> = FIELD_EXPORTS.iter().copied().chain(["stat_cando"]).collect();
			export(interp, module, &["stat", "lstat"], &exports);
			let fields: Vec<_> = FIELD_EXPORTS.iter().copied().chain(["stat", "lstat"]).collect();
			export_tag(interp, module, "FIELDS", &fields);
			let filetest = interp.glob("File::stat::-X").code.borrow().clone();
			if let Some(filetest) = filetest { interp.set_overload(module, "-X", Value::Ref(Ref::Code(filetest))); }
		},
		_ => unreachable!(),
	}
	Ok(())
}

enum Item { Path(PathBuf), Handle(Io) }

impl Item {
	fn get(interp: &mut Interp<'_>, value: &Value, handles: bool) -> PResult<Self> {
		if handles && !matches!(value, Value::Str(_)) && let Some(io) = as_handle(interp, value) { return Ok(Self::Handle(io)); }
		let name = interp.stringify(value)?;
		Ok(Self::Path(if name.is_empty() { PathBuf::new() } else { interp.resolve_path(&name.bytes) }))
	}

	fn target(&self) -> FileTestTarget<'_> {
		match self { Self::Path(path) => FileTestTarget::Path(path.as_os_str().as_encoded_bytes()), Self::Handle(io) => FileTestTarget::Handle(io) }
	}

	fn meta(&self, interp: &mut Interp<'_>) -> io::Result<Metadata> {
		pio::stat_metadata(interp.host(), self.target(), true)
	}

	fn reader(self, interp: &mut Interp<'_>) -> io::Result<Reader> {
		match self {
			Self::Handle(io) => Ok(Reader::Handle(io)),
			Self::Path(path) => interp.host().fs().open(path).map(Reader::File),
		}
	}

	fn writer(self, interp: &mut Interp<'_>) -> io::Result<Writer> {
		match self {
			Self::Handle(io) => Ok(Writer::Handle(io)),
			Self::Path(path) => interp.host().fs().create(path).map(Writer::File),
		}
	}
}

enum Reader { File(File), Handle(Io) }
impl Read for Reader {
	fn read(&mut self, dest: &mut [u8]) -> io::Result<usize> {
		match self {
			Self::File(f) => f.read(dest),
			Self::Handle(io) => {
				let data = io.borrow_mut().sysread(dest.len())?;
				let n = data.bytes.len();
				dest[..n].copy_from_slice(&data.bytes);
				Ok(n)
			},
		}
	}
}

enum Writer { File(File), Handle(Io) }
impl Write for Writer {
	fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
		match self {
			Self::File(f) => f.write(bytes),
			Self::Handle(io) => io.borrow_mut().syswrite(bytes),
		}
	}
	fn flush(&mut self) -> io::Result<()> {
		match self { Self::File(f) => f.flush(), Self::Handle(io) => io.borrow_mut().flush() }
	}
}

fn destination(interp: &mut Interp<'_>, from: &Item, mut to: Item) -> Item {
	if let (Item::Path(src), Item::Path(dst)) = (from, &mut to)
		&& let Some(name) = src.file_name() && interp.host().fs().metadata(&dst).is_ok_and(|m| m.is_dir())
	{
		*dst = omp_vfs::join_path(dst, Path::new(name));
	}
	to
}

fn copy(interp: &mut Interp<'_>, args: Vec<Sv>, preserve: bool) -> PResult<Ret> {
	if !(2..=3).contains(&args.len()) { return Err(interp.die_msg("Usage: copy(FROM, TO [, BUFFERSIZE])")); }
	let from_arg = arg(&args, 0);
	let to_arg = arg(&args, 1);
	let from = Item::get(interp, &from_arg, true)?;
	let to = Item::get(interp, &to_arg, true)?;
	let to = destination(interp, &from, to);
	let buffer = arg(&args, 2);
	if !buffer.is_undef() && buffer.to_i64() <= 0 {
		return Err(interp.die_msg(format!("Bad buffer size for copy: {}\n", buffer.to_pstr().to_string_lossy())));
	}
	let source = from.meta(interp).ok();
	let target = to.meta(interp).ok();
	let same = matches!((&source, &target), (Some(source), Some(target)) if source.same_file(target))
		|| matches!((&from, &to), (Item::Path(a), Item::Path(b)) if a == b && source.is_some())
		|| matches!((&from, &to), (Item::Handle(a), Item::Handle(b)) if Rc::ptr_eq(a, b));
	if same {
		interp.warn(format!("'{}' and '{}' are identical (not copied)", from_arg.to_pstr().to_string_lossy(), to_arg.to_pstr().to_string_lossy()));
		return one(Value::Int(0));
	}
	let permissions = if preserve && target.is_none() {
		match (source.as_ref(), &to) { (Some(meta), Item::Path(path)) => Some((path.clone(), meta.mode() & 0o7777)), _ => None }
	} else { None };
	let size = if buffer.is_undef() { None } else { Some((buffer.to_u64() as usize).min(1024 * 1024)) };
	let result = transfer(interp, from, to, size).and_then(|()| {
		if let Some((path, mode)) = permissions { interp.host().fs().set_permissions(path, Permissions::from_mode(mode))?; }
		Ok(())
	});
	match result {
		Ok(()) => one(Value::Int(1)),
		Err(err) => { interp.set_errno(&err); one(Value::Int(0)) },
	}
}

fn transfer(interp: &mut Interp<'_>, from: Item, to: Item, buffer: Option<usize>) -> io::Result<()> {
	let mut from = from.reader(interp)?;
	let mut to = to.writer(interp)?;
	if let Some(buffer) = buffer {
		let mut buf = vec![0u8; buffer];
		loop {
			if interp.is_cancelled() { return Err(io::ErrorKind::Interrupted.into()); }
			let n = from.read(&mut buf)?;
			if n == 0 { break; }
			to.write_all(&buf[..n])?;
		}
	} else {
		io::copy(&mut from, &mut to)?;
	}
	match to { Writer::File(file) => file.close(), Writer::Handle(_) => to.flush() }
}

fn move_file(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	if args.len() != 2 { return Err(interp.die_msg("Usage: move(FROM, TO)")); }
	let from = Item::get(interp, &arg(&args, 0), false)?;
	let to = Item::get(interp, &arg(&args, 1), false)?;
	let to = destination(interp, &from, to);
	let (Item::Path(from), Item::Path(to)) = (from, to) else { return one(Value::Int(0)); };
	let source = interp.host().fs().symlink_metadata(&from);
	let target = interp.host().fs().symlink_metadata(&to);
	if matches!((&source, &target), (Ok(a), Ok(b)) if a.same_file(b)) { return one(Value::Int(1)); }
	let mut result = interp.host().fs().rename(&from, &to);
	if result.as_ref().is_err_and(|err| err.raw_os_error() == Some(libc::EXDEV) || err.kind() == io::ErrorKind::Unsupported)
		&& let Ok(meta) = source
	{
		result = if meta.is_symlink() {
			let fs = interp.host().fs();
			fs.read_link(&from).and_then(|target| fs.symlink(target, &to))
		} else if meta.is_file() {
			transfer(interp, Item::Path(from.clone()), Item::Path(to.clone()), None).and_then(|()| {
				let fs = interp.host().fs();
				fs.set_permissions(&to, Permissions::from_mode(meta.mode() & 0o7777))?;
				if let (Ok(a), Ok(m)) = (meta.accessed(), meta.modified()) {
					fs.set_times(&to, a, m, true)?;
				}
				Ok(())
			})
		} else { result };
		if result.is_ok() { result = interp.host().fs().remove_file(&from); }
	}
	match result {
		Ok(()) => one(Value::Int(1)),
		Err(err) => { interp.set_errno(&err); one(Value::Int(0)) },
	}
}

fn compare(interp: &mut Interp<'_>, args: Vec<Sv>, text: bool) -> PResult<Ret> {
	if !(2..=3).contains(&args.len()) { return Err(interp.die_msg("Usage: compare(FROM, TO [, BUFFERSIZE])")); }
	let from = Item::get(interp, &arg(&args, 0), true)?;
	let to = Item::get(interp, &arg(&args, 1), true)?;
	let control = arg(&args, 2);
	let cb = if let Value::Ref(Ref::Code(cb)) = &control { Some(cb) } else { None };
	if text && !control.is_undef() && cb.is_none() { return Err(interp.die_msg("Usage: compare_text(FROM, TO [, CMP])")); }
	let size = control.to_i64();
	if text || cb.is_some() || size < 0 { return compare_text(interp, from, to, cb); }
	if let (Item::Path(_), Item::Path(_)) = (&from, &to)
		&& let (Ok(a), Ok(b)) = (from.meta(interp), to.meta(interp))
	{
		if a.same_file(&b) { return one(Value::Int(0)); }
		if a.is_file() && b.is_file() && a.len() != b.len() { return one(Value::Int(1)); }
	}
	let open = from.reader(interp).and_then(|from| Ok((from, to.reader(interp)?)));
	let (from, to) = match open { Ok(readers) => readers, Err(err) => return compare_error(interp, err) };
	let cap = if size > 0 { (size as usize).min(1024 * 1024) } else { 8192 };
	let (mut from, mut to) = (BufReader::with_capacity(cap, from), BufReader::with_capacity(cap, to));
	loop {
		if interp.is_cancelled() { return Err(Flow::Cancelled); }
		let sizes = from.fill_buf().and_then(|a| to.fill_buf().map(|b| (a.len(), b.len())));
		let (n, m) = match sizes { Ok(sizes) => sizes, Err(err) => return compare_error(interp, err) };
		if n == 0 || m == 0 { return one(Value::Int(i64::from(n != m))); }
		let len = n.min(m);
		if from.buffer()[..len] != to.buffer()[..len] { return one(Value::Int(1)); }
		from.consume(len);
		to.consume(len);
	}
}

fn compare_error(interp: &mut Interp<'_>, err: io::Error) -> PResult<Ret> {
	interp.set_errno(&err);
	one(Value::Int(-1))
}

enum TextSource {
	File(Handle),
	Handle(Io),
}

impl TextSource {
	fn open(interp: &mut Interp<'_>, item: Item) -> io::Result<Self> {
		const READ: OpenMode = OpenMode { read: true, write: false, create: false, append: false, truncate: false };
		match item {
			Item::Handle(io) => Ok(Self::Handle(io)),
			Item::Path(path) => interp.host().fs().open(path).map(|file| Self::File(Handle::from_file(file, READ, Layers::default()))),
		}
	}

	fn next(&mut self, sep: &RecordSep) -> io::Result<Option<PStr>> {
		match self {
			Self::File(file) => file.read_record(sep),
			Self::Handle(io) => io.borrow_mut().read_record(sep),
		}
	}
}

fn compare_text(interp: &mut Interp<'_>, from: Item, to: Item, callback: Option<&Cv>) -> PResult<Ret> {
	let open = TextSource::open(interp, from).and_then(|from| Ok((from, TextSource::open(interp, to)?)));
	let (mut from, mut to) = match open { Ok(readers) => readers, Err(err) => return compare_error(interp, err) };
	let sep = RecordSep::default();
	loop {
		if interp.is_cancelled() { return Err(Flow::Cancelled); }
		let lines = from.next(&sep).and_then(|from| Ok((from, to.next(&sep)?)));
		let different = match lines {
			Ok((Some(left), Some(right))) => {
				if let Some(callback) = callback {
					let args = vec![new_sv(Value::Str(left)), new_sv(Value::Str(right))];
					let ret = interp.call_sub(callback, args, Cx::Scalar)?.scalar();
					interp.truthy(&ret)?
				} else { left != right }
			},
			Ok((None, None)) => return one(Value::Int(0)),
			Ok(_) => true,
			Err(err) => return compare_error(interp, err),
		};
		if different { return one(Value::Int(1)); }
	}
}

fn stat(interp: &mut Interp<'_>, args: Vec<Sv>, follow: bool) -> PResult<Ret> {
	let value = if let Some(sv) = args.first() {
		interp.read_sv(sv)?
	} else {
		let topic = interp.topic();
		interp.read_sv(&topic)?
	};
	let item = Item::get(interp, &value, follow)?;
	let meta = pio::stat_metadata(interp.host(), item.target(), follow);
	let meta = match meta {
		Ok(meta) => meta,
		Err(err) => {
			let fallback = if follow && matches!(value, Value::Str(_)) { as_handle(interp, &value) } else { None };
			let Some(handle) = fallback else { return failure(interp, err); };
			match pio::stat_metadata(interp.host(), FileTestTarget::Handle(&handle), true) {
				Ok(meta) => meta,
				Err(err) => return failure(interp, err),
			}
		},
	};
	let result = pio::stat(interp.host(), FileTestTarget::Cached(&meta), follow);
	cache_stat(interp, meta, follow);
	match result { Ok(fields) => stat_object(interp, Vec::from(fields), "File::stat", true), Err(err) => failure(interp, err) }
}

fn stat_object(interp: &mut Interp<'_>, values: Vec<Value>, class: &str, globals: bool) -> PResult<Ret> {
	if globals {
		for (name, value) in FIELDS.iter().zip(&values) {
			let slot = interp.sv(&format!("File::stat::st_{name}"));
			interp.write_sv(&slot, value.clone())?;
		}
	}
	let object = Ref::Array(new_av(values));
	object.bless(Rc::from(class));
	one(Value::Ref(object))
}

fn populate(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	if args.is_empty() { return one(Value::Undef); }
	let values = args.iter().map(|sv| interp.read_sv(sv)).collect::<PResult<Vec<_>>>()?;
	stat_object(interp, values, "File::stat", true)
}

fn new_stat(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let class = arg(&args, 0).to_pstr();
	let mut fields = vec![Value::Undef; FIELDS.len()];
	for pair in args.get(1..).unwrap_or_default().chunks(2) {
		let name = arg(pair, 0).to_pstr();
		let Some(index) = FIELDS.iter().position(|&f| f.as_bytes() == name.bytes) else {
			return Err(interp.die_msg(format!("No method '{}' defined for class {}", name.to_string_lossy(), class.to_string_lossy())));
		};
		fields[index] = arg(pair, 1);
	}
	stat_object(interp, fields, &class.to_string_lossy(), false)
}

fn field(interp: &mut Interp<'_>, args: Vec<Sv>, index: usize) -> PResult<Ret> {
	let Value::Ref(Ref::Array(fields)) = arg(&args, 0) else { return Err(interp.die_msg("Not an ARRAY reference")); };
	if let Some(value) = args.get(1) {
		let value = interp.read_sv(value)?;
		let slot = {
			let mut array = fields.elems_mut();
			if array.len() <= index { array.resize_with(index + 1, || new_sv(Value::Undef)); }
			array[index].clone()
		};
		interp.write_sv(&slot, value)?;
		return one(interp.read_sv(&slot)?);
	}
	let slot = fields.elems().get(index).cloned();
	one(slot.map_or(Ok(Value::Undef), |sv| interp.read_sv(&sv))?)
}

fn cando(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let Value::Ref(Ref::Array(fields)) = arg(&args, 0) else { return Err(interp.die_msg("Not an ARRAY reference")); };
	let mode = arg(&args, 1).to_i64() as u32;
	let mode = if mode <= 7 { mode << 6 } else { mode & 0o700 };
	Ok(boolean(cando_mode(&fields.elems(), mode, arg(&args, 2).truthy())))
}

fn cando_mode(fields: &[Sv], mode: u32, effective: bool) -> bool {
	if mode == 0 { return false; }
	let permissions = arg(fields, 2).to_i64() as u32;
	let uid = arg(fields, 4).to_i64() as u32;
	let gid = arg(fields, 5).to_i64() as u32;
	#[cfg(unix)]
	let (user, group, supplementary) = {
		use nix::unistd::{geteuid, getuid, getegid, getgid};
		let (user, group) = if effective { (geteuid(), getegid()) } else { (getuid(), getgid()) };
		(user.as_raw(), group.as_raw(), group.as_raw() != gid && pio::supplementary_groups().contains(&gid))
	};
	#[cfg(not(unix))]
	let (user, group, supplementary) = { let _ = effective; (uid, gid, false) };
	if user == 0 {
		mode & 0o100 == 0 || permissions & 0o111 != 0 || permissions & 0o170000 == 0o040000
	} else {
		let mode = if user == uid { mode } else if group == gid || supplementary { mode >> 3 } else { mode >> 6 };
		permissions & mode == mode
	}
}

fn stat_test(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let Value::Ref(Ref::Array(fields)) = arg(&args, 0) else { return Err(interp.die_msg("Not an ARRAY reference")); };
	let op = arg(&args, 1).to_pstr();
	let op = op.bytes.last().copied().unwrap_or_default();
	let fields = fields.elems();
	let mode = arg(&fields, 2).to_i64() as u32;
	let size = arg(&fields, 7);
	let kind = mode & 0o170000;
	Ok(boolean(match op {
		b'e' => true,
		b'z' => size.to_u64() == 0,
		b's' => return one(size),
		b'f' => kind == 0o100000,
		b'd' => kind == 0o040000,
		b'l' => kind == 0o120000,
		b'p' => kind == 0o010000,
		b'c' => kind == 0o020000,
		b'b' => kind == 0o060000,
		b'S' => kind == 0o140000,
		b'u' => mode & 0o4000 != 0,
		b'g' => mode & 0o2000 != 0,
		b'k' => mode & 0o1000 != 0,
		b'r' | b'R' => cando_mode(&fields, 0o400, op == b'r'),
		b'w' | b'W' => cando_mode(&fields, 0o200, op == b'w'),
		b'x' | b'X' => cando_mode(&fields, 0o100, op == b'x'),
		b'o' | b'O' => {
			#[cfg(unix)]
			let me = if op == b'o' { nix::unistd::geteuid().as_raw() } else { nix::unistd::getuid().as_raw() };
			#[cfg(not(unix))]
			let me = 0u32;
			arg(&fields, 4).to_u64() == u64::from(me)
		},
		b'A' | b'M' | b'C' => {
			let field = match op { b'A' => 8, b'M' => 9, _ => 10 };
			let now = interp.start_time().duration_since(std::time::UNIX_EPOCH).map_or(0., |d| d.as_secs() as f64);
			return one(Value::Num((now - arg(&fields, field).to_f64()) / 86400.));
		},
		_ => return Err(interp.die_msg(format!("-{} is not implemented on a File::stat object", char::from(op)))),
	}))
}
