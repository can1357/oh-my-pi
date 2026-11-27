//! A pseudoconsole (Windows `ConPTY`) and a program started on it.
//!
//! The pseudoconsole is that of a `conpty.dll` Windows finds by name (the
//! executable's folder first), else the system's (Windows 10 1809 and later).
//! The program is found on its own environment's `PATH`, not this process's,
//! gets that environment whole and the pseudoconsole as its console, and
//! inherits no handle of this process.

use std::{
	collections::BTreeMap,
	ffi::{OsStr, c_void},
	fs::File,
	io, iter,
	os::windows::{
		ffi::OsStrExt as _,
		io::{AsRawHandle as _, FromRawHandle as _, OwnedHandle},
	},
	path::{Path, PathBuf},
	ptr,
	sync::LazyLock,
};

use windows_sys::{
	Win32::{
		Foundation::{HANDLE, HMODULE, INVALID_HANDLE_VALUE, WAIT_FAILED},
		System::{
			Console::{COORD, HPCON, PSEUDOCONSOLE_INHERIT_CURSOR},
			LibraryLoader::{GetModuleHandleW, GetProcAddress, LoadLibraryW},
			Pipes::CreatePipe,
			Threading::{
				CREATE_UNICODE_ENVIRONMENT, CreateProcessW, DeleteProcThreadAttributeList,
				EXTENDED_STARTUPINFO_PRESENT, GetExitCodeProcess, INFINITE,
				InitializeProcThreadAttributeList, LPPROC_THREAD_ATTRIBUTE_LIST,
				PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, PROCESS_INFORMATION, STARTF_USESTDHANDLES,
				STARTUPINFOEXW, UpdateProcThreadAttribute, WaitForSingleObject,
			},
		},
	},
	core::{HRESULT, s, w},
};

use super::{Spawn, env::Env};

/// How the pseudoconsole runs, as Windows Terminal opens its own: the
/// program starts where the terminal's cursor is (`ConPTY` asks with
/// `CSI 6 n` and waits for the reply), a resize leaves the reflow to the
/// terminal (undocumented `0x2`), and keys may arrive in win32-input-mode
/// (undocumented `0x4`).
const FLAGS: u32 = PSEUDOCONSOLE_INHERIT_CURSOR | 0x2 | 0x4;

/// A pseudoconsole and the pipes it talks through.
pub(super) struct Pty {
	pub console: Console,
	/// What its programs read: keys and replies, as VT sequences.
	pub input:   File,
	/// What they show, as the pseudoconsole renders it: open until the
	/// pseudoconsole closes, after its programs exited too.
	pub output:  File,
}

/// Opens a pseudoconsole of `cols`×`rows` cells.
///
/// # Errors
/// When no pipe or pseudoconsole opens (none before Windows 10 1809).
pub(super) fn open(cols: u16, rows: u16) -> io::Result<Pty> {
	let (console_in, input) = pipe()?;
	let (output, console_out) = pipe()?;
	let console = Console::open(cols, rows, &console_in, &console_out)?;
	// The pseudoconsole holds its own handles to its ends.
	drop((console_in, console_out));
	Ok(Pty { console, input: File::from(input), output: File::from(output) })
}

/// Starts `spawn`'s program on `console`.
///
/// # Errors
/// When an argument, a variable or the working directory holds a NUL, or
/// Windows cannot start the program (one not found included).
pub(super) fn launch(console: &Console, spawn: &Spawn<'_>) -> io::Result<Process> {
	let program = resolve(spawn.program, spawn.env);
	let application = wide(program.as_os_str())?;
	let mut line = command_line(&program, spawn.args)?;
	let env = environment_block(spawn.env)?;
	let dir = directory(spawn.cwd, spawn.env)
		.map(|dir| wide(dir.as_os_str()))
		.transpose()?;
	create_process(console, &application, &mut line, &env, dir.as_deref())
}

/// A pseudoconsole: the `ConPTY` host rendering its programs' console as VT
/// sequences. Dropping it closes it, ending their console; that blocks
/// until its output is drained.
pub(super) struct Console {
	/// The `ConPTY` it came from.
	api:    &'static Api,
	handle: HPCON,
}

impl Console {
	/// Opens one of `cols`×`rows` cells that reads `input` and writes
	/// `output`.
	fn open(cols: u16, rows: u16, input: &OwnedHandle, output: &OwnedHandle) -> io::Result<Self> {
		let api = API.as_ref().ok_or_else(|| {
			io::Error::new(
				io::ErrorKind::Unsupported,
				"this Windows has no pseudoconsoles (Windows 10 1809 and later have)",
			)
		})?;
		let mut handle = 0;
		// SAFETY: two live pipe ends, which the pseudoconsole duplicates,
		// and an out-parameter.
		let result = unsafe {
			(api.create)(
				size(cols, rows),
				input.as_raw_handle(),
				output.as_raw_handle(),
				FLAGS,
				&raw mut handle,
			)
		};
		succeeded(result)?;
		Ok(Self { api, handle })
	}

	/// Resizes it to `cols`×`rows` cells.
	///
	/// # Errors
	/// When the pseudoconsole refuses the size.
	pub(super) fn resize(&self, cols: u16, rows: u16) -> io::Result<()> {
		// SAFETY: a pseudoconsole this value opened and has not closed.
		succeeded(unsafe { (self.api.resize)(self.handle, size(cols, rows)) })
	}
}

impl Drop for Console {
	fn drop(&mut self) {
		// SAFETY: a pseudoconsole this value opened, closed once.
		unsafe { (self.api.close)(self.handle) };
	}
}

/// A program started on a pseudoconsole.
pub(super) struct Process {
	handle: OwnedHandle,
	pid:    u32,
}

impl Process {
	pub(super) const fn pid(&self) -> u32 {
		self.pid
	}

	/// Waits for it to exit; its exit code.
	///
	/// # Errors
	/// When it cannot be waited on.
	pub(super) fn wait(&self) -> io::Result<u32> {
		// SAFETY: a live process handle.
		if unsafe { WaitForSingleObject(self.handle.as_raw_handle(), INFINITE) } == WAIT_FAILED {
			return Err(io::Error::last_os_error());
		}
		let mut code = 0;
		// SAFETY: a live process handle and an out-parameter.
		if unsafe { GetExitCodeProcess(self.handle.as_raw_handle(), &raw mut code) } == 0 {
			return Err(io::Error::last_os_error());
		}
		Ok(code)
	}
}

/// `CreatePseudoConsole` (consoleapi.h).
type Create = unsafe extern "system" fn(COORD, HANDLE, HANDLE, u32, *mut HPCON) -> HRESULT;
/// `ResizePseudoConsole`.
type Resize = unsafe extern "system" fn(HPCON, COORD) -> HRESULT;
/// `ClosePseudoConsole`.
type Close = unsafe extern "system" fn(HPCON);

/// The pseudoconsole calls of the `ConPTY` in use.
struct Api {
	create: Create,
	resize: Resize,
	close:  Close,
}

/// The `ConPTY` in use: that of a `conpty.dll` that loads by name and has
/// every call, else the system's; `None` when the system has none (a
/// `conpty.dll` never stands in for it).
static API: LazyLock<Option<Api>> = LazyLock::new(|| {
	// SAFETY: kernel32 is loaded in every process.
	let system = api(unsafe { GetModuleHandleW(w!("kernel32.dll")) })?;
	// SAFETY: a library load by name, the executable's folder searched
	// first; the module stays loaded for the process (it is never freed).
	let shipped = unsafe { LoadLibraryW(w!("conpty.dll")) };
	Some(api(shipped).unwrap_or(system))
});

/// The pseudoconsole calls `module` exports; `None` when it is not loaded
/// or lacks one.
fn api(module: HMODULE) -> Option<Api> {
	if module.is_null() {
		return None;
	}
	// SAFETY: `module` is loaded and each name a static C string; each
	// export has the signature of its type (consoleapi.h).
	unsafe {
		Some(Api {
			create: std::mem::transmute::<unsafe extern "system" fn() -> isize, Create>(
				GetProcAddress(module, s!("CreatePseudoConsole"))?,
			),
			resize: std::mem::transmute::<unsafe extern "system" fn() -> isize, Resize>(
				GetProcAddress(module, s!("ResizePseudoConsole"))?,
			),
			close:  std::mem::transmute::<unsafe extern "system" fn() -> isize, Close>(
				GetProcAddress(module, s!("ClosePseudoConsole"))?,
			),
		})
	}
}

/// A pseudoconsole size of `cols`×`rows` cells.
fn size(cols: u16, rows: u16) -> COORD {
	COORD { X: i16::try_from(cols).unwrap_or(i16::MAX), Y: i16::try_from(rows).unwrap_or(i16::MAX) }
}

/// `result` as an error when it reports a failure.
fn succeeded(result: HRESULT) -> io::Result<()> {
	if result < 0 {
		return Err(io::Error::from_raw_os_error(result));
	}
	Ok(())
}

/// An anonymous pipe's read and write ends, neither inheritable.
fn pipe() -> io::Result<(OwnedHandle, OwnedHandle)> {
	let (mut read, mut write) = (ptr::null_mut(), ptr::null_mut());
	// SAFETY: two out-parameters; without security attributes no child
	// inherits either end.
	if unsafe { CreatePipe(&raw mut read, &raw mut write, ptr::null(), 0) } == 0 {
		return Err(io::Error::last_os_error());
	}
	// SAFETY: fresh handles nothing else owns.
	Ok(unsafe { (OwnedHandle::from_raw_handle(read), OwnedHandle::from_raw_handle(write)) })
}

/// Starts `application` with command line `line`, environment block `env`
/// and working directory `dir` (each NUL-terminated UTF-16; no `dir` keeps
/// this process's) on `console`.
fn create_process(
	console: &Console,
	application: &[u16],
	line: &mut [u16],
	env: &[u16],
	dir: Option<&[u16]>,
) -> io::Result<Process> {
	let mut attributes = Attributes::new(console)?;
	let mut info = STARTUPINFOEXW::default();
	info.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
	// Invalid standard handles: none set would hand the program this
	// process's, which win over the console's.
	info.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
	info.StartupInfo.hStdInput = INVALID_HANDLE_VALUE;
	info.StartupInfo.hStdOutput = INVALID_HANDLE_VALUE;
	info.StartupInfo.hStdError = INVALID_HANDLE_VALUE;
	info.lpAttributeList = attributes.as_mut_ptr();
	let mut started = PROCESS_INFORMATION::default();
	// SAFETY: NUL-terminated application name, mutable command line,
	// environment block and directory that outlive the call; an extended
	// startup record whose attribute list lives in `attributes`; no handle
	// inherited.
	let ok = unsafe {
		CreateProcessW(
			application.as_ptr(),
			line.as_mut_ptr(),
			ptr::null(),
			ptr::null(),
			0,
			EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
			env.as_ptr().cast(),
			dir.map_or(ptr::null(), <[u16]>::as_ptr),
			(&raw const info).cast(),
			&raw mut started,
		)
	};
	if ok == 0 {
		return Err(io::Error::last_os_error());
	}
	// SAFETY: fresh handles the call gave this process; the thread's is
	// closed at once.
	let (handle, _thread) = unsafe {
		(
			OwnedHandle::from_raw_handle(started.hProcess),
			OwnedHandle::from_raw_handle(started.hThread),
		)
	};
	Ok(Process { handle, pid: started.dwProcessId })
}

/// A process attribute list naming the pseudoconsole a program starts on,
/// in pointer-aligned storage.
struct Attributes(Vec<usize>);

impl Attributes {
	/// The list for `console`.
	fn new(console: &Console) -> io::Result<Self> {
		let mut bytes = 0;
		// SAFETY: asks only for the size one attribute takes; the call fails
		// with ERROR_INSUFFICIENT_BUFFER as it answers.
		unsafe { InitializeProcThreadAttributeList(ptr::null_mut(), 1, 0, &raw mut bytes) };
		let mut storage = vec![0_usize; bytes.div_ceil(size_of::<usize>())];
		// SAFETY: `bytes` bytes of pointer-aligned storage for one attribute.
		if unsafe {
			InitializeProcThreadAttributeList(storage.as_mut_ptr().cast(), 1, 0, &raw mut bytes)
		} == 0
		{
			return Err(io::Error::last_os_error());
		}
		let mut list = Self(storage);
		// SAFETY: an initialized list; the attribute's value is the
		// pseudoconsole handle itself, as `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE`
		// takes it, which outlives the list.
		let ok = unsafe {
			UpdateProcThreadAttribute(
				list.as_mut_ptr(),
				0,
				PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize,
				ptr::without_provenance::<c_void>(console.handle.cast_unsigned()),
				size_of::<HPCON>(),
				ptr::null_mut(),
				ptr::null(),
			)
		};
		if ok == 0 {
			return Err(io::Error::last_os_error());
		}
		Ok(list)
	}

	const fn as_mut_ptr(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
		self.0.as_mut_ptr().cast()
	}
}

impl Drop for Attributes {
	fn drop(&mut self) {
		// SAFETY: a list `new` initialized, deleted once.
		unsafe { DeleteProcThreadAttributeList(self.as_mut_ptr()) };
	}
}

/// `cwd` when it is a directory, else `env`'s `USERPROFILE` when that is,
/// a relative one from this process's directory; `None` keeps this
/// process's.
fn directory(cwd: Option<&Path>, env: &Env) -> Option<PathBuf> {
	let dir = cwd.filter(|dir| dir.is_dir()).or_else(|| {
		env.get("USERPROFILE")
			.map(Path::new)
			.filter(|dir| dir.is_dir())
	})?;
	if dir.is_relative()
		&& let Ok(current) = std::env::current_dir()
	{
		return Some(current.join(dir));
	}
	Some(dir.to_path_buf())
}

/// The file `program` names: in each directory of `env`'s `PATH` in turn,
/// `program` there when it exists, else `program` there with each of
/// `PATHEXT`'s extensions (`.EXE` without one) in place of its own;
/// `program` as given when no directory has it, which Windows then looks
/// for in this process's directory.
fn resolve(program: &str, env: &Env) -> PathBuf {
	let Some(path) = env.get("PATH") else {
		return PathBuf::from(program);
	};
	let extensions = env.get("PATHEXT").unwrap_or_else(|| OsStr::new(".EXE"));
	for dir in std::env::split_paths(path) {
		let file = dir.join(program);
		if file.exists() {
			return file;
		}
		for extension in std::env::split_paths(extensions) {
			// An entry without its leading `.` (an empty one: `;;`, a
			// trailing `;`) or not in UTF-8 names no extension.
			let Some(extension) = extension.to_str().and_then(|ext| ext.strip_prefix('.')) else {
				continue;
			};
			// `Path::with_extension` panics on a path separator.
			if extension.contains(['/', '\\']) {
				continue;
			}
			let file = file.with_extension(extension);
			if file.exists() {
				return file;
			}
		}
	}
	PathBuf::from(program)
}

/// The error for a string Windows cannot take.
fn holds_nul(what: impl std::fmt::Display) -> io::Error {
	io::Error::new(io::ErrorKind::InvalidInput, format!("{what} holds a NUL"))
}

/// `text` in UTF-16 with a terminating NUL.
///
/// # Errors
/// When it holds a NUL itself.
fn wide(text: &OsStr) -> io::Result<Vec<u16>> {
	let mut wide: Vec<u16> = text.encode_wide().collect();
	if wide.contains(&0) {
		return Err(holds_nul(text.display()));
	}
	wide.push(0);
	Ok(wide)
}

/// The NUL-terminated command line of `program` with `args`, each word as
/// the C runtime splits it again ([`push_word`]).
///
/// # Errors
/// When an argument holds a NUL.
fn command_line(program: &Path, args: &[String]) -> io::Result<Vec<u16>> {
	let mut line = Vec::new();
	push_word(&mut line, program.as_os_str());
	for arg in args {
		line.push(u16::from(b' '));
		push_word(&mut line, OsStr::new(arg));
	}
	if line.contains(&0) {
		return Err(holds_nul("an argument"));
	}
	line.push(0);
	Ok(line)
}

/// Appends `word` to a command line as one argument the C runtime
/// (`CommandLineToArgvW`) reads back whole: bare when it holds no blank or
/// quote, else quoted, with each quote escaped and the backslashes before a
/// quote (or before the closing one) doubled.
fn push_word(line: &mut Vec<u16>, word: &OsStr) {
	const QUOTE: u16 = b'"' as u16;
	const BACKSLASH: u16 = b'\\' as u16;
	let bare = !word.is_empty()
		&& !word
			.encode_wide()
			.any(|unit| matches!(unit, 0x20 | 0x09 | 0x0a | 0x0b | QUOTE));
	if bare {
		line.extend(word.encode_wide());
		return;
	}
	line.push(QUOTE);
	let mut backslashes = 0;
	for unit in word.encode_wide() {
		if unit == BACKSLASH {
			backslashes += 1;
		} else {
			if unit == QUOTE {
				line.extend(iter::repeat_n(BACKSLASH, backslashes + 1));
			}
			backslashes = 0;
		}
		line.push(unit);
	}
	line.extend(iter::repeat_n(BACKSLASH, backslashes));
	line.push(QUOTE);
}

/// `env` as `CreateProcessW` takes it: `NAME=value` strings, each
/// NUL-terminated, in the order of their [`fold`](super::env::fold)ed
/// names, then one more NUL.
///
/// # Errors
/// When a name or value holds a NUL.
fn environment_block(env: &Env) -> io::Result<Vec<u16>> {
	let vars: BTreeMap<_, _> = env
		.entries()
		.iter()
		.map(|(name, value)| (super::env::fold(name), (name.as_os_str(), value.as_os_str())))
		.collect();
	let mut block = Vec::new();
	for (name, value) in vars.into_values() {
		let start = block.len();
		block.extend(name.encode_wide());
		block.push(u16::from(b'='));
		block.extend(value.encode_wide());
		if block[start..].contains(&0) {
			return Err(holds_nul(format_args!("the variable {}", name.display())));
		}
		block.push(0);
	}
	// An empty block is two NULs.
	if block.is_empty() {
		block.push(0);
	}
	block.push(0);
	Ok(block)
}
