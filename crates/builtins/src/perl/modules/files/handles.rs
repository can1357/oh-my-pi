//! IO::Handle, IO::File, IO::Seekable, and scoped default output selection.

use std::{cell::RefCell, io, rc::Rc};

use omp_vfs::OpenOptions;

use super::{failure, isa, one, temp};
use crate::perl::{
	ast::{Builtin, BuiltinOrigin, Call, CallTarget},
	func::sys::{apply_read, by_fd, fcntl, open_child, remember, replace},
	interp::{Cx, Interp, PResult, Ret},
	io::{self as pio, FileTestTarget, Handle, Io, Layers, ModeKind, OpenMode, OpenTarget, ShellSpec, TwoArgTarget},
	modules::{arg, boolean, constant, define, export, version},
	sprintf::sprintf,
	value::{PStr, Ref, Sv, Value, new_gv, new_sv},
};

const SEEK: &[&str] = &["SEEK_SET", "SEEK_CUR", "SEEK_END"];
const FILE_EXPORTS: &[&str] = &[
	"SEEK_SET", "SEEK_CUR", "SEEK_END", "O_ACCMODE", "O_ALIAS", "O_APPEND", "O_ASYNC", "O_BINARY", "O_CREAT", "O_DEFER",
	"O_DIRECT", "O_DIRECTORY", "O_DSYNC", "O_EXCL", "O_EXLOCK", "O_LARGEFILE", "O_NDELAY", "O_NOCTTY", "O_NOFOLLOW", "O_NOINHERIT",
	"O_NONBLOCK", "O_RANDOM", "O_RAW", "O_RDONLY", "O_RDWR", "O_RSRC", "O_RSYNC", "O_SEQUENTIAL", "O_SHLOCK", "O_SYNC",
	"O_TEMPORARY", "O_TEXT", "O_TRUNC", "O_WRONLY",
];
const HANDLE_EXPORTS: &[&str] = &[
	"autoflush", "output_field_separator", "output_record_separator", "input_record_separator", "input_line_number",
	"format_page_number", "format_lines_per_page", "format_lines_left", "format_name", "format_top_name",
	"format_line_break_characters", "format_formfeed", "format_write", "print", "printf", "say", "getline", "getlines",
	"printflush", "flush", "SEEK_SET", "SEEK_CUR", "SEEK_END", "_IOFBF", "_IOLBF", "_IONBF",
];

/// Install one of the filehandle or selection classes.
pub(super) fn load(interp: &mut Interp<'_>, module: &str) -> PResult<()> {
	version(interp, module, if module == "SelectSaver" { "1.02" } else { "1.46" });
	match module {
		"IO" => define(interp, module, &[("import", import_io)]),
		"IO::Handle" => {
			interp.require_module("IO")?;
			define(interp, module, &[
				("new", new_handle), ("new_from_fd", new_from_fd), ("fdopen", fdopen), ("close", close),
				("fileno", |i, a, _| io_op(i, a, Op::Fd)), ("opened", |i, a, _| io_op(i, a, Op::Opened)),
				("getc", |i, a, _| io_op(i, a, Op::Getc)), ("eof", |i, a, _| io_op(i, a, Op::Eof)),
				("flush", |i, a, _| io_op(i, a, Op::Flush)), ("sync", |i, a, _| io_op(i, a, Op::Sync)),
				("autoflush", |i, a, _| io_op(i, a, Op::Auto)), ("blocking", |i, a, _| io_op(i, a, Op::Blocking)),
				("input_line_number", |i, a, _| io_op(i, a, Op::Line)), ("truncate", |i, a, _| io_op(i, a, Op::Truncate)),
				("fcntl", |i, a, _| io_op(i, a, Op::Fcntl)), ("stat", stat),
				("getline", |i, a, _| getline(i, a, false)), ("gets", |i, a, _| getline(i, a, false)),
				("getlines", |i, a, c| if c == Cx::List { getline(i, a, true) } else { Err(i.die_msg("Can't call $io->getlines in a scalar context, use $io->getline")) }),
				("print", |i, a, _| output(i, a, Output::Print)), ("printf", |i, a, _| output(i, a, Output::Printf)),
				("say", |i, a, _| output(i, a, Output::Say)), ("printflush", |i, a, _| output(i, a, Output::Flush)),
				("read", |i, a, _| read(i, a, false)), ("sysread", |i, a, _| read(i, a, true)),
				("write", |i, a, _| write(i, a, false)), ("syswrite", |i, a, _| write(i, a, true)),
				("output_field_separator", |i, a, _| special(i, a, ",", "output_field_separator")),
				("output_record_separator", |i, a, _| special(i, a, "\\", "output_record_separator")),
				("input_record_separator", |i, a, _| special(i, a, "/", "input_record_separator")),
				("format_page_number", |i, a, _| format_variable(i, a, "%")),
				("format_lines_per_page", |i, a, _| format_variable(i, a, "=")),
				("format_lines_left", |i, a, _| format_variable(i, a, "-")),
				("format_name", |i, a, _| format_variable(i, a, "~")),
				("format_top_name", |i, a, _| format_variable(i, a, "^")),
				("format_line_break_characters", |i, a, _| special(i, a, ":", "format_line_break_characters")),
				("format_formfeed", |i, a, _| special(i, a, "^L", "format_formfeed")),
				("format_write", format_write),
				("error", |i, a, _| io_op(i, a, Op::Error)), ("clearerr", |i, a, _| io_op(i, a, Op::ClearErr)),
				("setbuf", |i, _, _| no_buffer_control(i, "setbuf")), ("setvbuf", |i, _, _| no_buffer_control(i, "setvbuf")),
				("_open_mode_string", open_mode_string), ("ungetc", ungetc),
				// IO::Handle's DESTROY is empty: the handle itself closes when its glob is freed.
				("DESTROY", |_, _, _| Ok(Ret::empty())),
			]);
			seek_constants(interp, module);
			for (name, value) in [("_IOFBF", 0), ("_IOLBF", 1), ("_IONBF", 2)] {
				constant(interp, &format!("IO::Handle::{name}"), Value::Int(value));
			}
			export(interp, module, &[], HANDLE_EXPORTS);
		},
		"IO::Seekable" => {
			seek_constants(interp, module);
			define(interp, module, &[("seek", |i, a, _| seek(i, a, Seek::Seek)), ("sysseek", |i, a, _| seek(i, a, Seek::Sys)),
				("tell", |i, a, _| seek(i, a, Seek::Tell)), ("getpos", |i, a, _| seek(i, a, Seek::Get)), ("setpos", |i, a, _| seek(i, a, Seek::Set))]);
			export(interp, module, SEEK, &[]);
		},
		"IO::File" => {
			interp.require_module("IO::Handle")?;
			interp.require_module("IO::Seekable")?;
			interp.require_module("Fcntl")?;
			isa(interp, module, &["IO::Handle", "IO::Seekable", "Exporter"]);
			seek_constants(interp, module);
			for name in FILE_EXPORTS.iter().copied().filter(|name| name.starts_with("O_")) {
				let code = interp.glob(&format!("Fcntl::{name}")).code.borrow().clone();
				interp.glob(&format!("IO::File::{name}")).code.replace(code);
			}
			define(interp, module, &[("new", new_file), ("open", open), ("binmode", binmode), ("new_tmpfile", new_tmpfile)]);
			export(interp, module, FILE_EXPORTS, &[]);
		},
		"SelectSaver" => define(interp, module, &[("new", saver), ("DESTROY", restore)]),
		_ => unreachable!(),
	}
	Ok(())
}

/// `use IO qw(Handle File ...)` loads each named `IO::` class; no list means perl's default set.
fn import_io(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let mut names: Vec<PStr> = args.iter().skip(1).map(|sv| sv.get().to_pstr()).collect();
	if names.is_empty() {
		interp.warn_category("deprecated", "Parameterless \"use IO\" deprecated");
		names = ["Handle", "Seekable", "File", "Pipe", "Socket", "Dir"].iter().map(|name| PStr::from_str(name)).collect();
	}
	for name in names {
		let word: String = name.to_string_lossy().chars().skip_while(|c| !(c.is_alphanumeric() || *c == '_'))
			.take_while(|c| c.is_alphanumeric() || *c == '_').collect();
		interp.require_module(&format!("IO::{word}"))?;
	}
	Ok(Ret::empty())
}

fn seek_constants(interp: &mut Interp<'_>, module: &str) {
	for (value, name) in SEEK.iter().enumerate() { constant(interp, &format!("{module}::{name}"), Value::Int(value as i64)); }
}

/// Obtain the IO slot carried by a Perl IO or glob reference, or a named handle.
pub(super) fn as_handle(interp: &mut Interp<'_>, value: &Value) -> Option<Io> {
	match value {
		Value::Glob(gv) | Value::Ref(Ref::Glob(gv)) => gv.io.borrow().clone(),
		Value::Ref(Ref::Io(io)) => Some(io.clone()),
		Value::Str(name) => interp.handle(&name.to_string_lossy(), false),
		_ => None,
	}
}

fn object(interp: &mut Interp<'_>, class: &str, handle: Handle) -> Value {
	let g = new_gv(Rc::from(class), Rc::from("__ANONIO__"));
	let io = Rc::new(RefCell::new(Handle::closed()));
	interp.set_handle(&g, io.clone());
	let _ = replace(interp, &io, handle);
	let display = g.name.clone();
	let reference = Ref::Glob(g);
	reference.bless(Rc::from(class));
	let value = Value::Ref(reference);
	remember(interp, &io, value.clone(), display);
	value
}

fn bad_fd() -> io::Error { io::Error::from_raw_os_error(libc::EBADF) }
fn zero_true() -> Value { Value::bytes(b"0 but true") }

fn result<T>(interp: &mut Interp<'_>, result: io::Result<T>, success: impl FnOnce(T) -> Value) -> PResult<Ret> {
	match result { Ok(value) => one(success(value)), Err(err) => failure(interp, err) }
}

fn new_handle(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let class = arg(&args, 0).to_pstr();
	one(object(interp, &class.to_string_lossy(), Handle::closed()))
}

fn new_file(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let class = arg(&args, 0).to_pstr();
	if args.len() <= 1 { return one(object(interp, &class.to_string_lossy(), Handle::closed())); }
	match open_file(interp, args.get(1..).unwrap_or_default())? {
		Ok(handle) => one(object(interp, &class.to_string_lossy(), handle)),
		Err(err) => failure(interp, err),
	}
}

fn new_tmpfile(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let class = arg(&args, 0).to_pstr();
	temp::io_tmpfile(interp, &class.to_string_lossy())
}

fn close_handle(interp: &mut Interp<'_>, handle: &Io) -> io::Result<bool> {
	let closed = handle.borrow_mut().close();
	match closed {
		Ok(Some(status)) => { interp.set_child_status(status); Ok(status == 0) },
		Ok(None) => Ok(true),
		Err(err) => Err(err),
	}
}

fn open(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let Some(io) = as_handle(interp, &arg(&args, 0)) else { return failure(interp, bad_fd()); };
	let handle = open_file(interp, args.get(1..).unwrap_or_default())?;
	match handle {
		Ok(handle) => Ok(replace(interp, &io, handle)),
		Err(err) => {
			if io.borrow().is_open() { let _ = close_handle(interp, &io); }
			failure(interp, err)
		},
	}
}

fn translate_mode(mode: &[u8]) -> &[u8] {
	match mode { b"r" => b"<", b"r+" => b"+<", b"w" => b">", b"w+" => b"+>", b"a" => b">>", b"a+" => b"+>>", _ => mode }
}

fn open_mode(interp: &mut Interp<'_>, mode: &PStr) -> PResult<(OpenMode, ModeKind, Layers)> {
	Handle::parse_mode(translate_mode(&mode.bytes)).map_err(|_| interp.die_msg(format!("IO::Handle: bad open mode: {}", mode.to_string_lossy())))
}

fn open_file(interp: &mut Interp<'_>, args: &[Sv]) -> PResult<io::Result<Handle>> {
	if args.is_empty() { return Err(interp.die_msg("usage: $io->open(FILENAME [,MODE [,PERMS]])")); }
	let name = arg(args, 0);
	let mode = arg(args, 1);
	if mode.is_undef() {
		let name = interp.stringify(&name)?;
		let (mode, target, layers) = Handle::parse_two_arg(&name.bytes).map_err(|err| interp.die_msg(err))?;
		return Ok(match target {
			TwoArgTarget::Path(name) => open_path(interp, mode, layers, &name),
			TwoArgTarget::Std(fd) => Handle::open(interp.host(), mode, OpenTarget::Std(fd), layers),
			TwoArgTarget::Dup { name, same } => duplicate(interp, mode, layers, &Value::bytes(&name), same),
			TwoArgTarget::Command(cmd) => open_child(interp, mode, layers, ShellSpec::Line(&cmd)),
		});
	}
	if mode.looks_like_number() {
		let name = interp.stringify(&name)?;
		let perms = if args.len() <= 2 { 0o666 } else { arg(args, 2).to_u64() as u32 };
		return Ok(open_flags(interp, &name.bytes, mode.to_i64() as i32, perms));
	}
	let mode = interp.stringify(&mode)?;
	let (mode, kind, layers) = open_mode(interp, &mode)?;
	Ok(match kind {
		ModeKind::File => if let Value::Ref(Ref::Scalar(mem)) = name {
			Handle::open(interp.host(), mode, OpenTarget::Scalar(mem), layers)
		} else {
			let name = interp.stringify(&name)?;
			open_path(interp, mode, layers, &name.bytes)
		},
		ModeKind::Dup { same } => duplicate(interp, mode, layers, &name, same),
		ModeKind::PipeRead | ModeKind::PipeWrite => {
			let name = interp.stringify(&name)?;
			open_child(interp, mode, layers, ShellSpec::Line(&name.bytes))
		},
	})
}

fn open_path(interp: &mut Interp<'_>, mode: OpenMode, layers: Layers, raw: &[u8]) -> io::Result<Handle> {
	if raw.is_empty() { return Err(io::Error::from_raw_os_error(libc::ENOENT)); }
	let path = interp.resolve_path(raw);
	Handle::open(interp.host(), mode, OpenTarget::Path(path.as_os_str().as_encoded_bytes()), layers)
}

fn open_flags(interp: &mut Interp<'_>, name: &[u8], flags: i32, perms: u32) -> io::Result<Handle> {
	if name.is_empty() { return Err(io::Error::from_raw_os_error(libc::ENOENT)); }
	let access = libc::O_RDONLY | libc::O_WRONLY | libc::O_RDWR;
	let mode = OpenMode { read: flags & access != libc::O_WRONLY, write: flags & access != libc::O_RDONLY,
		append: flags & libc::O_APPEND != 0, truncate: flags & libc::O_TRUNC != 0, create: flags & libc::O_CREAT != 0 };
	let mut options = OpenOptions::new();
	if mode.read && !mode.write && (mode.create || mode.truncate) {
		options.read(true).custom_flags(flags & !access).mode(perms);
	} else {
		options.read(mode.read).write(mode.write).append(mode.append).truncate(mode.truncate).create(mode.create)
			.create_new(mode.create && flags & libc::O_EXCL != 0).mode(perms)
			.custom_flags(flags & !(access | libc::O_APPEND | libc::O_TRUNC | libc::O_CREAT | libc::O_EXCL));
	}
	let path = interp.resolve_path(name);
	let file = interp.host().fs().open_with(path, &options)?;
	Ok(Handle::from_file(file, mode, Layers::default()))
}

fn duplicate(interp: &mut Interp<'_>, mut mode: OpenMode, layers: Layers, from: &Value, same: bool) -> io::Result<Handle> {
	mode.create = false; mode.truncate = false;
	let fd = if from.looks_like_number() { Some(from.to_i64() as i32) } else { None };
	let io = as_handle(interp, from).or_else(|| fd.and_then(|fd| by_fd(interp, fd)));
	let target = if let Some(io) = io {
		if same { OpenTarget::DupSame(io) } else { OpenTarget::Dup(io) }
	} else if let Some(fd) = fd {
		if same { OpenTarget::Descriptor(fd) } else { OpenTarget::DupDescriptor(fd) }
	} else { return Err(bad_fd()); };
	Handle::open(interp.host(), mode, target, layers)
}

fn fd_parts(interp: &mut Interp<'_>, args: &[Sv]) -> PResult<io::Result<Handle>> {
	if args.len() != 3 { return Err(interp.die_msg("usage: $io->fdopen(FD, MODE)")); }
	let fd = arg(args, 1);
	let name = arg(args, 2).to_pstr();
	let (mode, kind, layers) = open_mode(interp, &name)?;
	if kind != ModeKind::File { return Err(interp.die_msg(format!("IO::Handle: bad open mode: {}", name.to_string_lossy()))); }
	Ok(duplicate(interp, mode, layers, &fd, true))
}

fn new_from_fd(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let class = arg(&args, 0).to_pstr();
	match fd_parts(interp, &args)? {
		Ok(handle) => one(object(interp, &class.to_string_lossy(), handle)),
		Err(err) => failure(interp, err),
	}
}

fn fdopen(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let Some(io) = as_handle(interp, &arg(&args, 0)) else { return failure(interp, bad_fd()); };
	match fd_parts(interp, &args)? {
		Ok(handle) => Ok(replace(interp, &io, handle)),
		Err(err) => failure(interp, err),
	}
}

fn close(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let Some(io) = as_handle(interp, &arg(&args, 0)) else { return failure(interp, bad_fd()); };
	let closed = close_handle(interp, &io);
	match closed { Ok(ok) => Ok(boolean(ok)), Err(err) => write_error(interp, err) }
}

fn binmode(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let Some(io) = as_handle(interp, &arg(&args, 0)) else { return failure(interp, bad_fd()); };
	let layers = arg(&args, 1).to_pstr();
	match io.borrow_mut().binmode(&layers.bytes) {
		Ok(()) => one(Value::Int(1)),
		Err(message) => {
			if interp.warn_on("layer") { interp.warn(message); }
			failure(interp, io::Error::from_raw_os_error(libc::EINVAL))
		},
	}
}

enum Op { Fd, Opened, Getc, Eof, Flush, Sync, Auto, Blocking, Line, Truncate, Fcntl, Error, ClearErr }

fn io_op(interp: &mut Interp<'_>, args: Vec<Sv>, op: Op) -> PResult<Ret> {
	let Some(io) = as_handle(interp, &arg(&args, 0)) else { return failure(interp, bad_fd()); };
	match op {
		Op::Fd => one(io.borrow().fileno().map_or(Value::Undef, |fd| Value::Int(i64::from(fd)))),
		Op::Opened => Ok(boolean(io.borrow().is_open())),
		Op::Getc => {
			let got = io.borrow_mut().getc();
			result(interp, got, |s| s.map_or(Value::Undef, Value::Str))
		},
		Op::Eof => Ok(boolean(io.borrow_mut().eof())),
		Op::Flush => match io.borrow_mut().flush() {
			Ok(()) => one(zero_true()),
			Err(err) => write_error(interp, err),
		},
		Op::Sync => {
			#[cfg(unix)]
			let got = io.borrow().with_fd(|fd| Ok(rustix::fs::fsync(fd)?));
			#[cfg(not(unix))]
			let got = Err(io::ErrorKind::Unsupported.into());
			result(interp, got, |()| zero_true())
		},
		Op::Auto => {
			let selected = interp.selected();
			let mut handle = io.borrow_mut();
			let previous = handle.autoflush();
			let enabled = args.len() == 1 || arg(&args, 1).truthy();
			handle.set_autoflush(enabled);
			if Rc::ptr_eq(&selected, &io) { interp.sv("main::|").set(Value::Int(i64::from(enabled))); }
			one(Value::Int(i64::from(previous)))
		},
		Op::Blocking => blocking(interp, &io, &args),
		Op::Line => {
			let mut handle = io.borrow_mut();
			let old = handle.line_no();
			if args.len() > 1 { handle.set_line_no(arg(&args, 1).to_u64()); }
			one(Value::UInt(old))
		},
		Op::Truncate => {
			let size = arg(&args, 1).to_i64();
			let got = u64::try_from(size).map_err(|_| io::ErrorKind::InvalidInput.into()).and_then(|size| io.borrow_mut().truncate(size));
			result(interp, got, |()| Value::Int(1))
		},
		Op::Fcntl => Ok(fcntl(interp, &io, arg(&args, 1).to_i64() as i32, arg(&args, 2).to_i64() as i32)),
		// Failed operations report through their own results and `$!`; no sticky error flag outlives them.
		Op::Error => one(Value::Int(if io.borrow().is_open() { 0 } else { -1 })),
		Op::ClearErr => one(Value::Int(0)),
	}
}

/// `IO::Handle::_open_mode_string`: fopen-style modes ("r", "w+", "a") become perl's ("<", "+>", ">>").
fn open_mode_string(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let mode = arg(&args, 0).to_pstr();
	let converted = match mode.bytes.as_slice() {
		b"<" | b">" | b">>" | b"+<" | b"+>" | b"+>>" => return one(Value::Str(mode)),
		[letter, plus @ ..] if plus.is_empty() || plus == b"+" => {
			let base: &[u8] = match letter { b'r' => b"<", b'w' => b">", b'a' => b">>", _ => b"" };
			(!base.is_empty()).then(|| [plus, base].concat())
		},
		_ => None,
	};
	match converted {
		Some(bytes) => one(Value::Str(PStr::from_bytes(&bytes))),
		None => Err(interp.die_msg(format!("IO::Handle: bad open mode: {}", mode.to_string_lossy()))),
	}
}

/// `$io->ungetc(ORD)`: the next read returns the character with that ordinal (UTF-8 encoded above 0xFF).
fn ungetc(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let Some(io) = as_handle(interp, &arg(&args, 0)) else { return failure(interp, bad_fd()); };
	let ord = arg(&args, 1).to_u64();
	let mut bytes = [0u8; 4];
	let pushed: &[u8] = match u8::try_from(ord) {
		Ok(byte) => { bytes[0] = byte; &bytes[..1] },
		Err(_) => match u32::try_from(ord).ok().and_then(char::from_u32) {
			Some(c) => c.encode_utf8(&mut bytes).as_bytes(),
			None => return one(Value::Undef),
		},
	};
	io.borrow_mut().unread(pushed);
	one(Value::Int(ord as i64))
}

fn no_buffer_control(interp: &mut Interp<'_>, name: &str) -> PResult<Ret> {
	Err(interp.die_msg(format!("IO::Handle::{name} not implemented on this architecture")))
}

fn blocking(interp: &mut Interp<'_>, io: &Io, args: &[Sv]) -> PResult<Ret> {
	#[cfg(unix)]
	{
		let flags = fcntl(interp, io, libc::F_GETFL, 0).scalar();
		if flags.is_undef() { return one(Value::Undef); }
		let flags = flags.to_i64() as i32;
		if args.len() > 1 {
			let new = if arg(args, 1).truthy() { flags & !libc::O_NONBLOCK } else { flags | libc::O_NONBLOCK };
			let status = fcntl(interp, io, libc::F_SETFL, new).scalar();
			if status.is_undef() { return one(Value::Undef); }
		}
		one(Value::Int(i64::from(flags & libc::O_NONBLOCK == 0)))
	}
	#[cfg(not(unix))]
	{ let _ = (io, args); failure(interp, io::ErrorKind::Unsupported.into()) }
}

fn stat(interp: &mut Interp<'_>, args: Vec<Sv>, cx: Cx) -> PResult<Ret> {
	let Some(io) = as_handle(interp, &arg(&args, 0)) else { return failure(interp, bad_fd()); };
	match pio::stat(interp.host(), FileTestTarget::Handle(&io), true) {
		Ok(values) if cx == Cx::List => Ok(Ret::Many(Vec::from(values))),
		Ok(_) => Ok(boolean(true)),
		Err(err) => {
			interp.set_errno(&err);
			if cx == Cx::List { Ok(Ret::Many(Vec::new())) } else { Ok(boolean(false)) }
		},
	}
}

fn getline(interp: &mut Interp<'_>, args: Vec<Sv>, all: bool) -> PResult<Ret> {
	let Some(io) = as_handle(interp, &arg(&args, 0)) else { return failure(interp, bad_fd()); };
	let sep = interp.input_sep();
	if !all {
		let data = io.borrow_mut().read_record(&sep);
		interp.set_last_read(io);
		return result(interp, data, |value| value.map_or(Value::Undef, Value::Str));
	}
	let mut lines = Vec::new();
	loop {
		if interp.is_cancelled() { return Err(crate::perl::interp::Flow::Cancelled); }
		match io.borrow_mut().read_record_with_context(&sep, true) {
			Ok(Some(line)) => lines.push(Value::Str(line)),
			Ok(None) => break,
			Err(err) => { interp.set_errno(&err); break; },
		}
	}
	interp.set_last_read(io);
	Ok(Ret::Many(lines))
}

#[derive(Clone, Copy)]
enum Output { Print, Printf, Say, Flush }

fn output(interp: &mut Interp<'_>, args: Vec<Sv>, mode: Output) -> PResult<Ret> {
	let Some(io) = as_handle(interp, &arg(&args, 0)) else { return failure(interp, bad_fd()); };
	let mut wide = false;
	let mut emit = |value: &PStr| -> io::Result<()> {
		wide |= io.borrow_mut().write(value)?;
		Ok(())
	};
	if matches!(mode, Output::Printf) {
		let fmt = interp.stringify(&arg(&args, 1))?;
		let vals = args.iter().skip(2).map(|sv| interp.read_sv(sv)).collect::<PResult<Vec<_>>>()?;
		let formatted = sprintf(&fmt, &vals, &mut interp.conv()).map_err(|err| interp.die_msg(err))?;
		if let Err(err) = emit(&formatted) { return write_error(interp, err); }
	} else {
		let field = interp.output_field_sep();
		let record = interp.output_record_sep();
		for (index, sv) in args.iter().skip(1).enumerate() {
			if index != 0 && let Some(sep) = &field
				&& let Err(err) = emit(sep)
			{ return write_error(interp, err); }
			let value = interp.read_sv(sv)?;
			let value = interp.stringify(&value)?;
			if let Err(err) = emit(&value) { return write_error(interp, err); }
		}
		if matches!(mode, Output::Say) {
			if let Err(err) = emit(&PStr::from_bytes(b"\n")) { return write_error(interp, err); }
		} else if let Some(sep) = &record
			&& let Err(err) = emit(sep)
		{ return write_error(interp, err); }
	}
	if matches!(mode, Output::Flush) && let Err(err) = io.borrow_mut().flush() {
		return write_error(interp, err);
	}
	if wide && interp.warn_on("utf8") { interp.warn("Wide character in print"); }
	one(Value::Int(1))
}

fn read(interp: &mut Interp<'_>, args: Vec<Sv>, raw: bool) -> PResult<Ret> {
	let Some(io) = as_handle(interp, &arg(&args, 0)) else { return failure(interp, bad_fd()); };
	let Some(dest) = args.get(1) else { return Err(interp.die_msg("usage: $io->read(BUF, LEN [, OFFSET])")); };
	let len = arg(&args, 2).to_i64();
	let len = usize::try_from(len).map_err(|_| interp.die_msg("Negative length"))?;
	let got = if raw { io.borrow_mut().sysread(len) } else { io.borrow_mut().read(len) };
	let data = match got {
		Ok(data) => data,
		Err(err) => return stream_error(interp, err),
	};
	let n = data.char_len();
	apply_read(interp, dest, data, arg(&args, 3).to_i64())?;
	one(Value::Int(n as i64))
}

fn write(interp: &mut Interp<'_>, args: Vec<Sv>, raw: bool) -> PResult<Ret> {
	let Some(io) = as_handle(interp, &arg(&args, 0)) else { return failure(interp, bad_fd()); };
	if args.len() < 2 { return Err(interp.die_msg("usage: $io->write(BUF [, LEN [, OFFSET]])")); }
	let mut bytes = interp.stringify(&arg(&args, 1))?;
	if raw && bytes.utf8 {
		bytes = PStr::new(bytes.downgraded().ok_or_else(|| interp.die_msg("Wide character in syswrite"))?, false);
	}
	let count = bytes.char_len() as i64;
	let len = if args.len() > 2 { arg(&args, 2).to_i64() } else { count };
	if len < 0 { return Err(interp.die_msg("Negative length")); }
	let offset = arg(&args, 3).to_i64();
	let offset = if offset < 0 { count.saturating_add(offset) } else { offset };
	if !(0..=count).contains(&offset) { return Err(interp.die_msg("Offset outside string")); }
	let end = bytes.char_to_byte(offset.saturating_add(len).min(count) as usize);
	let start = bytes.char_to_byte(offset as usize);
	if raw {
		match io.borrow_mut().syswrite(&bytes.bytes[start..end]) {
			Ok(n) => one(Value::Int(n as i64)),
			Err(err) => write_error(interp, err),
		}
	} else {
		bytes.bytes.truncate(end);
		bytes.bytes.drain(..start);
		let got = io.borrow_mut().write(&bytes);
		match got {
			Ok(wide) => {
				if wide && interp.warn_on("utf8") { interp.warn("Wide character in print"); }
				one(Value::Int(end.saturating_sub(start) as i64))
			},
			Err(err) => write_error(interp, err),
		}
	}
}

fn stream_error(interp: &mut Interp<'_>, err: io::Error) -> PResult<Ret> {
	let description = err.to_string();
	if description.contains("isn't allowed on :utf8 handles") { return Err(interp.die_msg(description)); }
	failure(interp, err)
}

/// [`stream_error`] for a write: a pipe or socket nobody reads raises
/// `SIGPIPE` first ([`Interp::broken_pipe`]).
fn write_error(interp: &mut Interp<'_>, err: io::Error) -> PResult<Ret> {
	interp.broken_pipe(&err)?;
	stream_error(interp, err)
}

enum Seek { Seek, Sys, Tell, Get, Set }

fn seek(interp: &mut Interp<'_>, args: Vec<Sv>, how: Seek) -> PResult<Ret> {
	let Some(io) = as_handle(interp, &arg(&args, 0)) else { return failure(interp, bad_fd()); };
	let pos = arg(&args, 1);
	let whence = arg(&args, 2).to_i64() as u8;
	match how {
		Seek::Seek => match io.borrow_mut().seek(pos.to_i64(), whence) {
			Ok(()) => Ok(boolean(true)),
			Err(err) => { interp.set_errno(&err); Ok(boolean(false)) },
		},
		Seek::Sys => result(interp, io.borrow_mut().sysseek(pos.to_i64(), whence), |n| if n == 0 { zero_true() } else { Value::UInt(n) }),
		Seek::Tell => one(Value::Int(io.borrow_mut().tell())),
		Seek::Get => {
			let offset = io.borrow_mut().tell();
			if offset < 0 { failure(interp, bad_fd()) } else { one(Value::bytes(&offset.to_ne_bytes())) }
		},
		Seek::Set => {
			let bytes = pos.to_pstr();
			let Ok(raw) = bytes.bytes.try_into() else { return failure(interp, io::Error::from_raw_os_error(libc::EINVAL)); };
			result(interp, io.borrow_mut().seek(i64::from_ne_bytes(raw), 0), |()| zero_true())
		},
	}
}

fn special(interp: &mut Interp<'_>, args: Vec<Sv>, name: &str, method: &str) -> PResult<Ret> {
	let first = arg(&args, 0);
	let how = if matches!(&first, Value::Glob(_) | Value::Ref(Ref::Glob(_) | Ref::Io(_))) {
		interp.warn(format!("{method} is not supported on a per-handle basis"));
		1
	} else { usize::from(first.to_pstr().bytes == b"IO::Handle") };
	let slot = interp.sv(&format!("main::{name}"));
	let old = interp.read_sv(&slot)?;
	if let Some(value) = args.get(how) {
		let value = interp.read_sv(value)?;
		interp.write_sv(&slot, value)?;
	}
	one(old)
}

fn format_variable(interp: &mut Interp<'_>, args: Vec<Sv>, name: &str) -> PResult<Ret> {
	let first = arg(&args, 0);
	let io = as_handle(interp, &first);
	let object_arg = io.is_some() || first.to_pstr().bytes == b"IO::Handle";
	let offset = usize::from(object_arg);
	let old = io.map(|io| interp.set_selected(io));
	let previous = crate::perl::func::sys::format_var(interp, name);
	let changed = if args.len() > offset {
		crate::perl::func::sys::set_format_var(interp, name, arg(&args, offset))
	} else { Ok(()) };
	if let Some(old) = old { interp.set_selected(old); }
	changed?;
	one(previous)
}

fn format_write(interp: &mut Interp<'_>, args: Vec<Sv>, cx: Cx) -> PResult<Ret> {
	let Some(io) = as_handle(interp, &arg(&args, 0)) else { return failure(interp, bad_fd()); };
	let old = interp.set_selected(io);
	let call = Call { target: CallTarget::Builtin(Builtin::Write, BuiltinOrigin::Core), args: None, slot: None, prototype: None };
	let result = crate::perl::func::sys::call(interp, Builtin::Write, &call, cx);
	interp.set_selected(old);
	match result { Some(result) => result, None => Err(interp.die_msg("Undefined format")) }
}

fn saver(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let class = arg(&args, 0).to_pstr();
	let saved = interp.selected();
	if args.len() > 1 {
		let target = arg(&args, 1);
		let io = as_handle(interp, &target).or_else(|| {
			if matches!(target, Value::Ref(_)) { return None; }
			let name = target.to_pstr();
			interp.handle(&name.to_string_lossy(), true)
		});
		let Some(io) = io else { return Err(interp.die_msg("Not a GLOB reference")); };
		interp.set_selected(io);
	}
	let value = Ref::Scalar(new_sv(Value::Ref(Ref::Io(saved))));
	value.bless(Rc::from(class.to_string_lossy().as_ref()));
	one(Value::Ref(value))
}

fn restore(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	if let Value::Ref(Ref::Scalar(cell)) = arg(&args, 0)
		&& let Value::Ref(Ref::Io(io)) = cell.replace(Value::Undef)
	{
		interp.set_selected(io);
	}
	one(Value::Undef)
}
