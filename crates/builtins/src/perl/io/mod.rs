//! Perl filehandles, PerlIO layers, directory streams, file tests, and child
//! I/O (`perlfunc`, `perlvar`, `perlopentut`, `perlipc`, `perlrun`). Keep the
//! `Io` stored in a Perl glob or ref across calls so buffering and `$.` survive.
//!
//! For `open`, parse syntax first, resolve `TwoArgTarget::Dup`/`ModeKind::Dup`
//! in the interpreter's symbol/descriptor table, then pass an `OpenTarget`.
//! `DirHandle` is separate because its offsets are directory cookies, not byte
//! offsets. The interpreter keeps the last `Metadata` for the special `_`
//! filehandle; use that as `FileTestTarget::Cached`. `-T` and `-B` still
//! need the original path or handle in order to inspect its bytes.
//!
//! Before `system`, `exec`, backticks, or a pipe open, the interpreter must
//! flush every open output handle, as Perl does before starting a child. The
//! host flushes its own diagnostics on command launch. Keep STDOUT and STDERR
//! on Host `StreamWriter`s to preserve their write order when they converge.

mod codepage;
mod command;
mod device;
mod filetest;
mod inplace;
mod input;
mod mode;

use std::{
	borrow::Cow,
	cell::RefCell,
	ffi::OsStr,
	fmt,
	io::{self, Read, Seek, SeekFrom, Write},
	path::Path,
	rc::{Rc, Weak},
	sync::{Arc, atomic::AtomicBool},
	time::Instant,
};

use omp_vfs::{Metadata, OpenOptions};

use crate::{host::{Host, StreamWriter}, openfile::{Fd, OpenFile}};

use self::{device::{Device, OutputSink, ScalarFile}, input::Input};
use super::value::{PStr, Sv, Value};

pub(in crate::perl) use self::{
	command::{ChildContext, PipeChild, ShellSpec, run_capture_in, spawn_system_in, wait_cancellable},
	filetest::{DirHandle, FileTestTarget, file_test, stat, stat_metadata},
	inplace::InPlace,
	mode::{Layers, ModeKind, OpenMode, TwoArgTarget},
};
#[cfg(unix)]
pub(in crate::perl) use self::filetest::supplementary_groups;

/// A pending `alarm` that interrupts a blocking read on a pipe, socket or
/// terminal, so the interpreter can deliver SIGALRM and retry or unwind.
#[derive(Clone)]
#[cfg_attr(not(unix), expect(dead_code, reason = "alarm-interrupted reads poll descriptors on unix only"))]
pub(in crate::perl) struct ReadDeadline {
	/// When the alarm is due.
	pub at: Instant,
	/// Host cancellation, still honoured while waiting.
	pub cancel: Arc<AtomicBool>,
}

/// Error payload of a read abandoned because the alarm deadline passed.
#[derive(Debug)]
struct AlarmDue;

impl fmt::Display for AlarmDue {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.write_str("Interrupted system call")
	}
}

impl std::error::Error for AlarmDue {}

#[cfg(unix)]
fn alarm_error() -> io::Error {
	io::Error::new(io::ErrorKind::Interrupted, AlarmDue)
}

/// Whether a read failed only because its `ReadDeadline` passed; retry it
/// after delivering the alarm.
pub(in crate::perl) fn alarm_due(err: &io::Error) -> bool {
	err.get_ref().is_some_and(|e| e.is::<AlarmDue>())
}

/// A device read through the handle's buffer, interruptible by an alarm.
pub(super) struct Source<'a> {
	device: &'a mut Device,
	deadline: Option<&'a ReadDeadline>,
	prompt_output: Option<&'a Weak<RefCell<Handle>>>,
}

impl Read for Source<'_> {
	fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
		flush_prompt(self.prompt_output);
		if let Some(deadline) = self.deadline {
			self.device.wait_input(deadline)?;
		}
		self.device.read(buf)
	}
}

fn flush_prompt(output: Option<&Weak<RefCell<Handle>>>) {
	if let Some(io) = output.and_then(Weak::upgrade) && let Ok(mut handle) = io.try_borrow_mut() {
		let _ = handle.flush_output();
	}
}

/// A persistent Perl I/O slot, shared by globs and references.
pub(in crate::perl) type Io = Rc<RefCell<Handle>>;

/// The current value of `$/` interpreted as a readline mode.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::perl) enum RecordSep {
	/// Records ending in exactly this string (normally `"\n"`).
	Text(PStr),
	/// Empty `$/`: discard extra newlines, retain up to two per record.
	Paragraph,
	/// Undefined `$/`: read the remaining input as one record.
	Slurp,
	/// Scalar reference `$/`: a maximum character count, or slurp for zero.
	Fixed(usize),
}

impl Default for RecordSep {
	fn default() -> Self {
		Self::Text(PStr::from_bytes(b"\n"))
	}
}

/// Resolved operand for `open`; see `TwoArgTarget` for the unresolved form.
pub(in crate::perl) enum OpenTarget<'a> {
	/// A literal filename in the shell filesystem, including `scheme://` URLs.
	Path(&'a [u8]),
	/// A scalar reference whose bytes serve as the file.
	Scalar(Sv),
	/// `>&`/`<&`: duplicate a previously opened handle's descriptor.
	Dup(Io),
	/// `>&=`/`<&=`: share one descriptor until the last alias closes.
	DupSame(Io),
	/// Reuse a descriptor inherited from the shell. Resolve Perl-opened fds first.
	Descriptor(i32),
	/// Duplicate a descriptor inherited from the shell.
	DupDescriptor(i32),
	/// The host's standard stream, numbered 0, 1, or 2.
	Std(u8),
}

/// The underlying device is only shared on demand by the `&=` form.
#[derive(Default)]
enum Resource {
	#[default]
	Closed,
	Owned(Device),
	Aliased(Rc<RefCell<Device>>),
}

impl Resource {
	fn get<T>(&self, f: impl FnOnce(&Device) -> T) -> Option<T> {
		match self {
			Self::Closed => None,
			Self::Owned(device) => Some(f(device)),
			Self::Aliased(shared) => Some(f(&*shared.try_borrow().ok()?)),
		}
	}

	fn with_mut<T>(&mut self, f: impl FnOnce(&mut Device) -> io::Result<T>) -> io::Result<T> {
		match self {
			Self::Closed => Err(bad_fd()),
			Self::Owned(device) => f(device),
			Self::Aliased(shared) => f(&mut *shared.try_borrow_mut().map_err(|_| bad_fd())?),
		}
	}

	fn alias(&mut self) -> io::Result<Self> {
		let shared = match self {
			Self::Aliased(shared) => Rc::clone(shared),
			Self::Closed => return Err(bad_fd()),
			Self::Owned(_) => {
				let Self::Owned(device) = std::mem::take(self) else { return Err(bad_fd()) };
				let shared = Rc::new(RefCell::new(device));
				*self = Self::Aliased(Rc::clone(&shared));
				shared
			},
		};
		Ok(Self::Aliased(shared))
	}

	fn close(&mut self) -> io::Result<Option<i32>> {
		let device = match std::mem::take(self) {
			Self::Closed => return Err(bad_fd()),
			Self::Owned(device) => device,
			Self::Aliased(shared) => match Rc::try_unwrap(shared) {
				Ok(device) => device.into_inner(),
				Err(_) => return Ok(None),
			},
		};
		device.close()
	}
}

/// `open FH, ">-"` attaches to STDOUT's PerlIO stream, including pending bytes.
enum Output {
	Owned(Vec<u8>),
	Shared(Rc<RefCell<Vec<u8>>>),
}

impl Output {
	fn alias(&mut self) -> Self {
		if let Self::Owned(buf) = self {
			*self = Self::Shared(Rc::new(RefCell::new(std::mem::take(buf))));
		}
		match self { Self::Shared(shared) => Self::Shared(shared.clone()), Self::Owned(_) => unreachable!() }
	}

	fn len(&self) -> usize {
		match self { Self::Owned(buf) => buf.len(), Self::Shared(buf) => buf.borrow().len() }
	}

	#[inline]
	fn with_mut<T>(&mut self, f: impl FnOnce(&mut Vec<u8>) -> T) -> T {
		match self { Self::Owned(buf) => f(buf), Self::Shared(buf) => f(&mut buf.borrow_mut()) }
	}
}

/// One Perl filehandle with independent PerlIO buffering and line counter.
pub(in crate::perl) struct Handle {
	resource: Resource,
	mode: OpenMode,
	layers: Layers,
	descriptor: Option<i32>,
	input: Input,
	shared_input: Option<Rc<RefCell<Input>>>,
	position_known: bool,
	output: Output,
	buffered: bool,
	line_buffered: bool,
	prompt_output: Option<Weak<RefCell<Handle>>>,
	autoflush: bool,
	line: u64,
	read_record_once: bool,
	read_deadline: Option<ReadDeadline>,
	/// Package assigned by `bless` for a direct IO reference.
	pub(in crate::perl) blessed: RefCell<Option<Rc<str>>>,
}

impl fmt::Debug for Handle {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.debug_struct("Handle")
			.field("fileno", &self.fileno())
			.field("layers", &self.layers)
			.field("mode", &self.mode)
			.field("line", &self.line)
			.finish_non_exhaustive()
	}
}

const OUTPUT_CHUNK: usize = 8192;
/// First `sysread` buffer; later slices double while reads keep filling them.
const SYSREAD_SLICE: usize = 4 << 20;

impl Handle {
	/// Parse two-argument magic open syntax. PerlIO layer syntax requires the
	/// three-argument form: `"<:raw file"` would name the file `":raw file"`.
	pub fn parse_two_arg(spec: &[u8]) -> Result<(OpenMode, TwoArgTarget, Layers), String> {
		mode::parse_two_arg(spec)
	}

	/// Parse file, pipe, duplicate, and layer specifiers in an explicit open mode.
	pub fn parse_mode(mode: &[u8]) -> Result<(OpenMode, ModeKind, Layers), String> {
		mode::parse_mode(mode)
	}

	fn new(resource: Resource, mode: OpenMode, layers: Layers, descriptor: Option<i32>, buffered: bool) -> Self {
		Self {
			resource, mode, layers, descriptor, input: Input::default(), shared_input: None, position_known: false,
			output: Output::Owned(Vec::new()), buffered, line_buffered: false, prompt_output: None,
			autoflush: false, line: 0, read_record_once: false, read_deadline: None,
			blessed: RefCell::new(None),
		}
	}

	/// An unopened handle (for a glob with an IO slot but no attached file).
	pub fn closed() -> Self {
		Self::new(Resource::Closed, OpenMode::READ, Layers::default(), None, false)
	}

	/// Wrap a VFS file already opened with flags (for `sysopen` and File::Temp).
	pub fn from_file(mut file: omp_vfs::File, mode: OpenMode, layers: Layers) -> Self {
		let offset = if mode.append { file.seek(SeekFrom::End(0)).unwrap_or(0) } else { 0 };
		let mut handle = Self::new(Resource::Owned(Device::File(file)), mode, layers, None, mode.write);
		handle.set_position(offset);
		handle
	}

	/// Wrap a host-owned descriptor for a socket, OS pipe or inherited fd.
	pub fn from_descriptor(host: &Host, file: OpenFile, mode: OpenMode, layers: Layers) -> Self {
		let device = Device::descriptor(file, Some(host.cancel_flag()), None);
		Self::new(Resource::Owned(device), mode, layers, None, mode.write)
	}

	/// Run an open-pipe command in the interpreter's cwd/environment and tag it for `waitpid`.
	pub fn open_pipe_in(host: &mut Host, mode: OpenMode, shell: ShellSpec<'_>, layers: Layers, context: Option<&ChildContext>, id: i32) -> io::Result<Self> {
		if let ShellSpec::Line(line) = shell {
			if line == b"-" {
				return Err(io::Error::from_raw_os_error(libc::ENOSYS));
			}
			if line.is_empty() {
				return Err(io::ErrorKind::BrokenPipe.into());
			}
		}
		let (file, child) = command::open_pipe(host, shell, mode.read, mode.write, context, id)?;
		let device = Device::descriptor(file, Some(host.cancel_flag()), Some(child));
		Ok(Self::new(Resource::Owned(device), mode, layers, None, mode.write))
	}

	/// Get the pipe child reference independently of this handle's pipe end.
	pub fn child(&self) -> Option<PipeChild> {
		self.resource.get(|device| device.child().cloned()).flatten()
	}

	/// Use a borrowed native descriptor without moving the handle or altering buffering.
	#[cfg(unix)]
	pub fn with_fd<T>(&self, f: impl FnOnce(std::os::fd::BorrowedFd<'_>) -> io::Result<T>) -> io::Result<T> {
		self.resource.get(|device| device.with_fd(f)).ok_or_else(bad_fd)?
	}

	/// Writing to a nonscalar device cannot modify a borrowed Perl scalar.
	pub(in crate::perl) fn writes_external_bytes(&self) -> bool {
		self.mode.write && matches!(&self.resource, Resource::Owned(device) if !matches!(device, Device::Scalar(_)))
	}

	/// Whether the current stream is writable.
	pub fn is_writable(&self) -> bool { self.mode.write && self.is_open() }

	/// Keep standard descriptor numbers attached to their Perl glob on reopen.
	pub fn set_standard_number(&mut self, fd: i32) {
		self.descriptor = Some(fd);
		if fd == 1 && self.buffered { self.line_buffered = self.is_terminal(); }
	}

	/// Deliver pending prompts immediately before a physical terminal read, not
	/// when merely consuming buffered input. A weak link cannot keep STDOUT alive.
	pub fn set_prompt_output(&mut self, output: &Io) {
		self.prompt_output = self.is_terminal().then(|| Rc::downgrade(output));
	}

	/// Override the original Host stream only if this standard handle was reopened or closed.
	pub fn child_stream(&self, index: usize) -> Option<Fd> {
		match self.resource.get(|device| match (index, device) {
			(0, Device::Stdin(_)) | (1 | 2, Device::Stdout { .. }) => None,
			_ => Some(device.child_fd().unwrap_or(Fd::Closed)),
		}) {
			Some(fd) => fd,
			None => Some(Fd::Closed),
		}
	}


	/// Physical PerlIO stack with layer names, canonical arguments and flags.
	pub fn layer_info(&self, output: bool) -> Vec<(&'static str, Option<String>, u32)> {
		if output && !self.mode.write { return Vec::new(); }
		let Some(scalar) = self.resource.get(|dev| matches!(dev, Device::Scalar(_))) else { return Vec::new(); };
		self.layers.info(self.mode, scalar, self.descriptor)
	}

	/// Open a resolved handle using only the shell's descriptors and filesystem.
	/// Flush other open output handles before opening a pipe.
	pub fn open(host: &mut Host, mode: OpenMode, target: OpenTarget<'_>, layers: Layers) -> io::Result<Self> {
		let handle = match target {
			OpenTarget::Path(path) => {
				let path = host.resolve(input_path(path)?);
				let mut opts = OpenOptions::new();
				opts.read(mode.read).write(mode.write).create(mode.create).truncate(mode.truncate).append(mode.append);
				let mut file = host.fs().open_with(path, &opts)?;
				let offset = if mode.append {
					// Perl starts both >> and +>> at EOF. A pipe/device still
					// opens successfully even though it has no end offset.
					file.seek(SeekFrom::End(0)).unwrap_or(0)
				} else {
					0
				};
				let mut handle = Self::new(Resource::Owned(Device::File(file)), mode, layers, None, mode.write);
				handle.set_position(offset);
				handle
			},
			OpenTarget::Scalar(sv) => {
				let scalar = ScalarFile::new(sv, mode.truncate, mode.append)?;
				let offset = scalar.position();
				let buffered = mode.write && layers.explicit_perlio();
				let mut handle = Self::new(Resource::Owned(Device::Scalar(scalar)), mode, layers, Some(-1), buffered);
				handle.set_position(offset);
				handle.input.direct = true;
				handle
			},
			OpenTarget::Dup(source) => {
				let mut source = source.try_borrow_mut().map_err(|_| bad_fd())?;
				source.flush()?;
				let device = source.resource.get(|device| device.duplicate(host.cancel_flag())).ok_or_else(bad_fd)??;
				let mut handle = Self::new(Resource::Owned(device), mode, layers.inherit(source.layers), None, mode.write);
				handle.prompt_output = source.prompt_output.clone();
				handle.set_position(source.tell().max(0) as u64);
				handle
			},
			OpenTarget::DupSame(source) => {
				let mut source = source.try_borrow_mut().map_err(|_| bad_fd())?;
				source.flush()?;
				let fd = source.fileno().filter(|&fd| fd >= 0).ok_or_else(bad_fd)?;
				let offset = source.tell().max(0) as u64;
				let mut handle = Self::new(source.resource.alias()?, mode, layers.inherit(source.layers), Some(fd), mode.write);
				handle.prompt_output = source.prompt_output.clone();
				handle.set_position(offset);
				handle
			},
			OpenTarget::Descriptor(fd) => {
				let file = host.paths().file(fd).ok_or_else(bad_fd)?;
				let device = Device::descriptor(file.clone(), Some(host.cancel_flag()), None);
				Self::new(Resource::Owned(device), mode, layers, Some(fd), mode.write)
			},
			OpenTarget::DupDescriptor(fd) => {
				let file = host.paths().file(fd).ok_or_else(bad_fd)?;
				let file = OpenFile::from_fd(file.to_fd()?).ok_or_else(bad_fd)?;
				let device = Device::descriptor(file, Some(host.cancel_flag()), None);
				Self::new(Resource::Owned(device), mode, layers, None, mode.write)
			},
			OpenTarget::Std(fd) => {
				let mut handle = match fd {
					0 => Self::stdin(host),
					1 => Self::stdout(host),
					2 => Self::stderr(host),
					_ => return Err(bad_fd()),
				};
				handle.mode = OpenMode { append: false, create: false, truncate: false, ..mode };
				handle.layers = layers;
				handle
			},
		};
		Ok(handle)
	}

	/// Attach `open "-"` or ARGV to the standard PerlIO stream without
	/// losing unread bytes; line counts and the ability to close are independent.
	pub fn alias_standard(&mut self, mode: OpenMode, layers: Layers) -> io::Result<Self> {
		let resource = self.resource.alias()?;
		let mut alias = Self::new(resource, mode, layers.inherit(self.layers), self.descriptor, mode.write && self.buffered);
		if mode.write {
			alias.output = self.output.alias();
			alias.line_buffered = self.line_buffered;
			alias.autoflush = self.autoflush;
		}
		alias.prompt_output = self.prompt_output.clone();
		if mode.read {
			let input = self.shared_input.get_or_insert_with(|| Rc::new(RefCell::new(std::mem::take(&mut self.input))));
			alias.shared_input = Some(input.clone());
		}
		Ok(alias)
	}

	/// The host's cancellable stdin, with a separate Perl readline buffer.
	pub fn stdin(host: &Host) -> Self {
		let resource = host.stdin.try_clone().map_or(Resource::Closed, |stdin| Resource::Owned(Device::Stdin(stdin)));
		Self::new(resource, OpenMode::READ, Layers::default(), Some(0), false)
	}

	/// The host's destination-aware stdout writer.
	pub fn stdout(host: &Host) -> Self {
		let file = host.paths().file(1).cloned().unwrap_or_else(|| host.stdout_clone());
		let line_buffered = file.is_terminal();
		let writer = match &host.stderr {
			StreamWriter::Shared(_) | StreamWriter::Async(_) => OutputSink::Managed(host.stdout_writer()),
			_ => OutputSink::Guarded(host.stdout_clone()),
		};
		let mut handle = Self::new(Resource::Owned(Device::Stdout { writer, file }), OpenMode::WRITE, Layers::default(), Some(1), true);
		handle.line_buffered = line_buffered;
		handle
	}

	/// Perl STDERR is unbuffered, even when the host merges the destinations.
	pub fn stderr(host: &Host) -> Self {
		let writer = match &host.stderr {
			StreamWriter::Shared(shared) => OutputSink::Managed(StreamWriter::Shared(shared.clone())),
			StreamWriter::Async(out) => OutputSink::Managed(StreamWriter::Async(out.clone())),
			_ => OutputSink::Guarded(host.stderr_clone()),
		};
		let file = host.paths().file(2).cloned().unwrap_or_else(|| host.stderr_clone());
		let mut handle = Self::new(Resource::Owned(Device::Stdout { writer, file }), OpenMode::WRITE, Layers::default(), Some(2), false);
		handle.autoflush = true;
		handle
	}

	fn in_place(layers: Layers, bytes: Rc<RefCell<Vec<u8>>>) -> Self {
		Self::new(Resource::Owned(Device::InPlace(bytes)), OpenMode::WRITE, layers, Some(-1), false)
	}

	fn check_read(&mut self) -> io::Result<()> {
		if !self.mode.read {
			return Err(bad_fd());
		}
		if self.output.len() != 0 {
			self.flush()?;
		}
		Ok(())
	}

	/// Arm (or with `None` disarm) alarm interruption of this handle's blocking reads.
	pub fn set_read_deadline(&mut self, deadline: Option<ReadDeadline>) {
		self.read_deadline = deadline;
	}

	/// Push bytes back onto the input (PerlIO `ungetc`): the next read,
	/// `getc` or `readline` returns them first and `eof` is false meanwhile.
	pub fn unread(&mut self, bytes: &[u8]) {
		self.with_buffer_mut(|input| input.unread_bytes(bytes));
	}

	/// Forget the part of a record read before an interrupted read was abandoned.
	pub fn discard_partial(&mut self) {
		self.with_buffer_mut(Input::discard_partial);
	}

	fn with_input<T>(&mut self, op: impl FnOnce(&mut Input, &mut Source<'_>) -> io::Result<T>) -> io::Result<T> {
		self.check_read()?;
		let mut shared = self.shared_input.as_ref().map(|input| input.try_borrow_mut().map_err(|_| bad_fd())).transpose()?;
		let input = shared.as_deref_mut().unwrap_or(&mut self.input);
		let deadline = self.read_deadline.as_ref();
		let prompt_output = self.prompt_output.as_ref();
		self.resource.with_mut(|device| {
			let scalar = matches!(device, Device::Scalar(_));
			let result = op(input, &mut Source { device: &mut *device, deadline, prompt_output });
			if scalar {
				// A program may reassign the backing SV between reads. Don't
				// retain stale lookahead or EOF across those calls.
				let pos = device.seek(SeekFrom::Current(-unread_i64(input)?))?;
				input.reset(pos);
			}
			result
		})
	}

	/// Read one scalar `readline` result, retaining its separator and incrementing `$.`.
	pub fn read_record(&mut self, sep: &RecordSep) -> io::Result<Option<PStr>> {
		self.read_record_with_context(sep, false)
	}

	/// Read a record for the list form of `readline`, which does not synthesize
	/// an empty first record when slurping an empty file.
	pub fn read_record_with_context(&mut self, sep: &RecordSep, list: bool) -> io::Result<Option<PStr>> {
		self.read_record_reusing(sep, list, &mut Vec::new())
	}

	pub(in crate::perl) fn read_record_reusing(&mut self, sep: &RecordSep, list: bool, spare: &mut Vec<u8>) -> io::Result<Option<PStr>> {
		let layers = self.layers;
		if layers.raw_bytes() && self.mode.read && self.output.len() == 0
			&& !matches!(self.resource, Resource::Closed)
			&& let RecordSep::Text(text) = sep && !text.utf8 && let [byte] = text.bytes[..]
		{
			let record = match &self.shared_input {
				Some(input) => input.try_borrow_mut().map_err(|_| bad_fd())?.buffered_record(byte, spare),
				None => self.input.buffered_record(byte, spare),
			};
			if let Some(bytes) = record {
				self.read_record_once = true;
				self.line = self.line.saturating_add(1);
				return Ok(Some(PStr::new(bytes, false)));
			}
		}
		let crlf = layers.crlf();
		let bytes = self.with_input(|input, device| {
			input.reuse(spare);
			match sep {
				RecordSep::Slurp | RecordSep::Fixed(0) => input.to_end(device, crlf),
				RecordSep::Paragraph => input.paragraph(device, crlf),
				RecordSep::Fixed(count) => input.read_count(device, *count, crlf, layers.unicode_widths()),
				RecordSep::Text(text) if text.is_empty() => input.paragraph(device, crlf),
				RecordSep::Text(text) => match layers.delimiter(text)? {
					Some(sep) => input.until(device, &sep, crlf),
					None => input.to_end(device, crlf),
				},
			}
		})?;
		let allow_empty = !list && !self.read_record_once && matches!(sep, RecordSep::Slurp | RecordSep::Fixed(0));
		if bytes.is_empty() && !allow_empty {
			return Ok(None);
		}
		self.read_record_once = true;
		self.line = self.line.saturating_add(1);
		Ok(Some(layers.decode(bytes)))
	}

	/// Read one character under the active layers, or return `None` at EOF.
	pub fn getc(&mut self) -> io::Result<Option<PStr>> {
		let ch = self.read(1)?;
		Ok((!ch.is_empty()).then_some(ch))
	}

	/// Buffered Perl `read`, counting characters with a Unicode layer.
	pub fn read(&mut self, len: usize) -> io::Result<PStr> {
		let layers = self.layers;
		let bytes = self.with_input(|input, device| input.read_count(device, len, layers.crlf(), layers.unicode_widths()))?;
		Ok(layers.decode(bytes))
	}

	/// Unbuffered `sysread`; valid on byte-oriented descriptors only.
	pub fn sysread(&mut self, len: usize) -> io::Result<PStr> {
		self.check_read()?;
		if !self.layers.sysread_allowed() {
			return Err(io::Error::new(io::ErrorKind::InvalidInput, "sysread() isn't allowed on :utf8 handles"));
		}
		super::limits::check_len(len, "string").map_err(|_| io::Error::from_raw_os_error(libc::ENOMEM))?;
		// Grow with the data instead of zero-filling a script-sized buffer up front: the first slice is
		// larger than any pipe or terminal delivers at once, so only a full read (a regular file) asks for more.
		let mut out = Vec::new();
		let mut slice = len.min(SYSREAD_SLICE);
		if len != 0 { flush_prompt(self.prompt_output.as_ref()); }
		let deadline = self.read_deadline.as_ref();
		loop {
			let filled = out.len();
			let target = filled + slice;
			out.try_reserve_exact(slice).map_err(|_| io::Error::from_raw_os_error(libc::ENOMEM))?;
			out.resize(target, 0);
			let read = self.resource.with_mut(|device| {
				if filled == 0 && let Some(deadline) = deadline && target != 0 {
					device.wait_input(deadline)?;
				}
				device.sysread(&mut out[filled..target])
			});
			let n = match read {
				Ok(n) => n,
				Err(_) if filled != 0 => 0,
				Err(e) => return Err(e),
			};
			out.truncate(filled + n);
			if n < slice || out.len() >= len {
				break;
			}
			slice = (len - out.len()).min(out.len());
		}
		Ok(PStr::new(out, false))
	}

	/// Unbuffered `syswrite`, valid on byte-oriented descriptors only.
	pub fn syswrite(&mut self, bytes: &[u8]) -> io::Result<usize> {
		if !self.mode.write || !self.is_open() { return Err(bad_fd()); }
		if !self.layers.sysread_allowed() {
			return Err(io::Error::new(io::ErrorKind::InvalidInput, "syswrite() isn't allowed on :utf8 handles"));
		}
		let n = self.resource.with_mut(|device| device.syswrite(bytes))?;
		self.position_known = false;
		Ok(n)
	}

	/// Change a native byte offset without flushing or discarding PerlIO buffers.
	pub fn sysseek(&mut self, offset: i64, whence: u8) -> io::Result<u64> {
		let pos = match whence {
			0 => SeekFrom::Start(u64::try_from(offset).map_err(|_| io::ErrorKind::InvalidInput)?),
			1 => SeekFrom::Current(offset),
			2 => SeekFrom::End(offset),
			_ => return Err(io::ErrorKind::InvalidInput.into()),
		};
		self.position_known = false;
		self.resource.with_mut(|dev| match dev {
			Device::Scalar(_) | Device::InPlace(_) => Err(bad_fd()),
			_ => dev.seek(pos),
		})
	}

	/// Whether the stream has ended (or cannot be read). Does not consume a byte.
	pub fn eof(&mut self) -> bool {
		if self.mode.read && self.output.len() == 0 && self.shared_input.is_none()
			&& matches!(&self.resource, Resource::Owned(device) if !matches!(device, Device::Scalar(_)))
			&& self.input.unread() != 0
		{ return false; }
		self.with_input(|input, source| match &*source.device {
			Device::Scalar(scalar) if input.unread() == 0 => scalar.eof(),
			_ => Ok(input.peek(source)?.is_empty()),
		}).unwrap_or(true)
	}

	fn with_buffer<T>(&self, get: impl FnOnce(&Input) -> T) -> T {
		match &self.shared_input { Some(input) => get(&input.borrow()), None => get(&self.input) }
	}

	fn with_buffer_mut<T>(&mut self, update: impl FnOnce(&mut Input) -> T) -> T {
		match &self.shared_input { Some(input) => update(&mut input.borrow_mut()), None => update(&mut self.input) }
	}

	/// Write a Perl string. `true` means raw output of a wide character and
	/// asks the caller to issue Perl's `Wide character in print` warning.
	pub fn write(&mut self, s: &PStr) -> io::Result<bool> {
		if !self.mode.write || !self.is_open() {
			return Err(bad_fd());
		}
		let (bytes, wide) = if !s.utf8 && self.layers.sysread_allowed() {
			(Cow::Borrowed(s.bytes.as_slice()), false)
		} else { self.layers.encode(s) };
		if !bytes.is_empty() {
			if self.mode.read || self.shared_input.is_some() || self.input.unread() != 0 { self.before_write()?; }
			if self.layers.crlf() {
				let mut rest = bytes.as_ref();
				while let Some(nl) = memchr::memchr(b'\n', rest) {
					self.emit(&rest[..nl])?;
					self.emit(b"\r\n")?;
					rest = &rest[nl + 1..];
				}
				self.emit(rest)?;
			} else {
				self.emit(&bytes)?;
			}
		}
		if self.autoflush {
			self.flush()?;
		}
		Ok(wide)
	}

	fn before_write(&mut self) -> io::Result<()> {
		let unread = self.with_buffer(Input::unread);
		let offset = if unread != 0 {
			let seek = if self.mode.append { SeekFrom::End(0) } else { SeekFrom::Current(-self.with_buffer(unread_i64)?) };
			self.resource.with_mut(|device| device.seek(seek))?
		} else {
			self.with_buffer(|input| input.offset)
		};
		self.with_buffer_mut(|input| input.reset(offset));
		Ok(())
	}

	fn set_position(&mut self, offset: u64) {
		self.with_buffer_mut(|input| input.reset(offset));
		self.position_known = true;
	}

	fn emit(&mut self, bytes: &[u8]) -> io::Result<()> {
		if bytes.is_empty() { return Ok(()); }
		let resource = &mut self.resource;
		if self.buffered && !self.autoflush && !self.layers.unbuffered() {
			let newline = self.line_buffered.then(|| memchr::memrchr(b'\n', bytes)).flatten();
			self.output.with_mut(|buf| {
				let mut rest = bytes;
				if let Some(at) = newline {
					let (lines, tail) = rest.split_at(at + 1);
					Self::buffer_output(resource, buf, lines)?;
					Self::drain(resource, buf)?;
					rest = tail;
				}
				Self::buffer_output(resource, buf, rest)
			})?;
		} else {
			// An alias may have accumulated bytes even if this handle is unbuffered.
			self.output.with_mut(|buf| Self::drain(resource, buf))?;
			resource.with_mut(|device| device.write_all(bytes))?;
		}
		self.with_buffer_mut(|input| input.offset = input.offset.saturating_add(bytes.len() as u64));
		self.position_known &= !self.mode.append;
		Ok(())
	}

	fn buffer_output(resource: &mut Resource, buf: &mut Vec<u8>, bytes: &[u8]) -> io::Result<()> {
		if bytes.is_empty() { return Ok(()); }
		if bytes.len() > OUTPUT_CHUNK - buf.len() { Self::drain(resource, buf)?; }
		if bytes.len() >= OUTPUT_CHUNK { return resource.with_mut(|device| device.write_all(bytes)); }
		if buf.capacity() == 0 { buf.reserve(OUTPUT_CHUNK); }
		buf.extend_from_slice(bytes);
		Ok(())
	}

	fn drain(resource: &mut Resource, bytes: &mut Vec<u8>) -> io::Result<()> {
		if bytes.is_empty() { return Ok(()); }
		let result = resource.with_mut(|device| device.write_all(bytes));
		bytes.clear();
		result
	}

	fn drain_output(&mut self) -> io::Result<()> {
		let resource = &mut self.resource;
		self.output.with_mut(|buf| Self::drain(resource, buf))
	}

	fn flush_output(&mut self) -> io::Result<()> {
		self.drain_output()?;
		if self.mode.write {
			self.resource.with_mut(|device| device.flush())?;
		} else if !self.is_open() {
			return Err(bad_fd());
		}
		Ok(())
	}

	/// Deliver buffered writes and return unused buffered input to seekable
	/// descriptors so a duplicate sees the current logical position.
	pub fn flush(&mut self) -> io::Result<()> {
		self.flush_output()?;
		let unread = self.with_buffer(unread_i64)?;
		if unread == 0 {
			return Ok(());
		}
		match self.resource.with_mut(|device| device.seek(SeekFrom::Current(-unread))) {
			Ok(offset) => self.set_position(offset),
			Err(err) if matches!(err.kind(), io::ErrorKind::NotSeekable | io::ErrorKind::Unsupported) => {},
			Err(err) => return Err(err),
		}
		Ok(())
	}

	/// Set Perl's per-handle `$|`; enabling it also delivers pending writes.
	pub fn set_autoflush(&mut self, on: bool) {
		if on && !self.autoflush && self.mode.write {
			let _ = self.flush_output();
		}
		self.autoflush = on;
	}

	/// The current per-handle `$|` setting.
	pub fn autoflush(&self) -> bool {
		self.autoflush
	}

	/// Apply `binmode` layers to both directions (`[]` means `:raw`).
	pub fn binmode(&mut self, layers: &[u8]) -> Result<(), String> {
		let layers = self.layers.apply(if layers.is_empty() { b":raw" } else { layers })?;
		self.flush().map_err(|err| err.to_string())?;
		self.layers = layers;
		Ok(())
	}

	/// Seek by physical byte position, with whence 0/start, 1/current, 2/end.
	pub fn seek(&mut self, pos: i64, whence: u8) -> io::Result<()> {
		let seek = match whence {
			0 => SeekFrom::Start(u64::try_from(pos).map_err(|_| io::ErrorKind::InvalidInput)?),
			1 => SeekFrom::Current(pos.checked_sub(self.with_buffer(unread_i64)?).ok_or(io::ErrorKind::InvalidInput)?),
			2 => SeekFrom::End(pos),
			_ => return Err(io::ErrorKind::InvalidInput.into()),
		};
		self.flush_output()?;
		let offset = self.resource.with_mut(|device| device.seek(seek))?;
		self.set_position(offset);
		Ok(())
	}

	/// Physical offset including consumed-but-not-flushed bytes; -1 if closed.
	pub fn tell(&mut self) -> i64 {
		if !self.is_open() {
			return -1;
		}
		let (unread, fallback) = self.with_buffer(|input| (input.unread() as u64, input.offset));
		if self.position_known {
			return i64::try_from(fallback).unwrap_or(-1);
		}
		let pending = self.output.len() as u64;
		let append = self.mode.append;
		let pos = self.resource.with_mut(|device| {
			if append && pending != 0 {
				return Ok(device.metadata()?.len().saturating_add(pending));
			}
			let pos = device.stream_position()?.saturating_sub(unread).saturating_add(pending);
			Ok(if matches!(device, Device::Stdout { .. }) { pos.max(fallback) } else { pos })
		}).unwrap_or(fallback);
		i64::try_from(pos).unwrap_or(-1)
	}

	/// Change the size of a writable descriptor, without moving its position.
	pub fn truncate(&mut self, len: u64) -> io::Result<()> {
		if !self.mode.write {
			return Err(bad_fd());
		}
		self.flush()?;
		self.before_write()?;
		self.resource.with_mut(|device| device.set_len(len))
	}

	/// Drop buffered writes undelivered, as a killed process loses its
	/// PerlIO buffers.
	pub fn discard_output(&mut self) {
		self.output.with_mut(Vec::clear);
	}

	/// Close the handle. For a pipe, close its end before waiting for the command
	/// and return `Some` of the command's encoded Perl `$?`.
	pub fn close(&mut self) -> io::Result<Option<i32>> {
		let flushed = self.flush();
		let closed = self.resource.close();
		self.shared_input = None;
		self.input.reset(0);
		self.line = 0;
		self.read_record_once = false;
		flushed.and(closed)
	}

	/// Current per-handle record number (`$.` when this is the last input).
	pub fn line_no(&self) -> u64 {
		self.line
	}

	/// Assign the handle's record number (via `$.` or before starting a file).
	pub fn set_line_no(&mut self, n: u64) {
		self.line = n;
	}

	/// Whether an underlying resource is still open.
	pub fn is_open(&self) -> bool {
		self.resource.get(|_| ()).is_some()
	}

	/// Descriptor number, or `-1` for scalar files; `None` for closed or
	/// provider-backed handles with no mapped descriptor.
	pub fn fileno(&self) -> Option<i32> {
		self.resource.get(|device| self.descriptor.or_else(|| device.fileno())).flatten()
	}

	/// Whether the open resource is a physical terminal.
	pub fn is_terminal(&self) -> bool {
		self.resource.get(Device::terminal).unwrap_or(false)
	}

	fn metadata(&self) -> io::Result<Metadata> {
		self.resource.get(Device::metadata).ok_or_else(bad_fd)?
	}
}

impl Drop for Handle {
	fn drop(&mut self) {
		if !self.is_open() {
			return;
		}
		if std::thread::panicking() {
			// Unwinding: never flush into a full pipe or wait for a child here. The Host reaps it.
			if let Some(child) = self.child() { child.detach(); }
			let _ = self.resource.close();
			return;
		}
		// An implicit close still reaps a pipe child (perl sets `$?` and orders output this way),
		// but the reap and any flush into a full pipe give up once the invocation is cancelled.
		let _ = self.close();
	}
}

fn bad_fd() -> io::Error {
	io::Error::from_raw_os_error(libc::EBADF)
}

fn unread_i64(input: &Input) -> io::Result<i64> {
	i64::try_from(input.unread()).map_err(io::Error::other)
}

fn os_string(bytes: &[u8]) -> Cow<'_, OsStr> {
	#[cfg(unix)]
	{
		use std::os::unix::ffi::OsStrExt as _;
		Cow::Borrowed(OsStr::from_bytes(bytes))
	}
	#[cfg(not(unix))]
	{
		match String::from_utf8_lossy(bytes) {
			Cow::Borrowed(text) => Cow::Borrowed(OsStr::new(text)),
			Cow::Owned(text) => Cow::Owned(text.into()),
		}
	}
}

fn input_path(bytes: &[u8]) -> io::Result<Cow<'_, Path>> {
	if bytes.is_empty() {
		return Err(io::Error::from_raw_os_error(libc::ENOENT));
	}
	if bytes.contains(&0) {
		return Err(io::Error::from_raw_os_error(libc::EINVAL));
	}
	Ok(match os_string(bytes) {
		Cow::Borrowed(os) => Cow::Borrowed(Path::new(os)),
		Cow::Owned(os) => Cow::Owned(os.into()),
	})
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::perl::value::new_sv;

	#[test]
	fn argv_alias_keeps_utf8_and_shares_unread_stdin_without_sharing_line_number() {
		let (host, _) = Host::for_test("perl", "α\nβ\nγ\n", ".");
		let mut stdin = Handle::stdin(&host);
		stdin.binmode(b":utf8").unwrap();
		let sep = RecordSep::default();
		assert_eq!(stdin.read_record(&sep).unwrap(), Some(PStr::from_str("α\n")));
		let mut argv = stdin.alias_standard(OpenMode::READ, Layers::default()).unwrap();
		assert_eq!(argv.read_record(&sep).unwrap(), Some(PStr::from_str("β\n")));
		assert_eq!((stdin.line_no(), argv.line_no()), (1, 1));
		argv.close().unwrap();
		assert_eq!(stdin.read_record(&sep).unwrap(), Some(PStr::from_str("γ\n")));
		assert_eq!(stdin.line_no(), 2);
	}

	#[test]
	fn perlio_reports_encoding_and_crlf_layers_and_pop_removes_the_uppermost_layer() {
		let (mut host, _) = Host::for_test("perl", "", ".");
		let (_, _, layers) = Handle::parse_mode(b"<:crlf:encoding(UTF-8):crlf").unwrap();
		let mut handle = Handle::open(&mut host, OpenMode::READ, OpenTarget::Scalar(new_sv(Value::Undef)), layers).unwrap();
		assert_eq!(handle.layer_info(false), vec![
			("scalar", None, 0x600400),
			("crlf", None, 0x404400),
			("encoding", Some("utf-8-strict".to_owned()), 0x408400),
			("crlf", None, 0x40C400),
		]);
		handle.binmode(b":pop:pop").unwrap();
		assert_eq!(handle.layer_info(false), vec![("scalar", None, 0x600400), ("crlf", None, 0x404400)]);
		assert!(handle.layer_info(true).is_empty());
	}

	#[test]
	fn layered_scalar_records_update_bytes_and_keep_independent_positions() {
		let (mut host, _) = Host::for_test("perl", Vec::new(), ".");
		let scalar = new_sv(Value::bytes(b"\xce\xbb\r\nX\r\n"));
		let (mode, _, layers) = Handle::parse_mode(b"+<:utf8:crlf").unwrap();
		let mut handle = Handle::open(&mut host, mode, OpenTarget::Scalar(Rc::clone(&scalar)), layers).unwrap();
		let text = handle.read_record(&RecordSep::default()).unwrap().unwrap();
		assert_eq!(text, PStr::from_str("λ\n"));
		assert!(text.utf8);
		assert_eq!(handle.tell(), 4);
		assert_eq!(handle.line_no(), 1);
		handle.write(&PStr::from_bytes(b"Y\n")).unwrap();
		assert_eq!(handle.tell(), 7);
		assert_eq!(scalar.get().to_pstr().bytes, b"\xce\xbb\r\nY\r\n");
		assert_eq!(handle.fileno(), Some(-1));
		handle.seek(0, 0).unwrap();
		assert_eq!(handle.read(1).unwrap(), PStr::from_str("λ"));
		assert_eq!(handle.tell(), 2);
		scalar.set(Value::bytes(b"\xce\xbbZ"));
		assert_eq!(handle.getc().unwrap(), Some(PStr::from_bytes(b"Z")));
		assert!(handle.eof());
	}

	#[test]
	fn host_files_read_write_append_dup_and_stat_from_shell_cwd() {
		let dir = tempfile::tempdir().unwrap();
		let (mut host, _) = Host::for_test("perl", Vec::new(), dir.path());
		let path = b" relative ";
		let (mode, _, _) = Handle::parse_mode(b"+>").unwrap();
		let mut file = Handle::open(&mut host, mode, OpenTarget::Path(path), Layers::raw()).unwrap();
		file.write(&PStr::from_bytes(b"old")).unwrap();
		assert_eq!(file.tell(), 3);
		file.seek(1, 0).unwrap();
		assert_eq!(file.getc().unwrap(), Some(PStr::from_bytes(b"l")));
		file.write(&PStr::from_bytes(b"X")).unwrap();
		file.close().unwrap();
		let (mode, _, _) = Handle::parse_mode(b"+>>").unwrap();
		let mut file = Handle::open(&mut host, mode, OpenTarget::Path(path), Layers::raw()).unwrap();
		assert_eq!(file.tell(), 3);
		file.seek(0, 0).unwrap();
		file.write(&PStr::from_bytes(b"new")).unwrap();
		assert_eq!(file.tell(), 6);
		file.close().unwrap();
		assert_eq!(stat(&host, FileTestTarget::Path(path), true).unwrap()[7].to_i64(), 6);
		let file = Handle::open(&mut host, OpenMode::READ, OpenTarget::Path(path), Layers::raw()).unwrap();
		let file = Rc::new(RefCell::new(file));
		let mut duplicate = Handle::open(&mut host, OpenMode::READ, OpenTarget::Dup(Rc::clone(&file)), Layers::raw()).unwrap();
		file.borrow_mut().close().unwrap();
		assert_eq!(duplicate.read(6).unwrap().bytes, b"olXnew");
	}

	#[test]
	fn an_empty_scalar_slurp_produces_one_record_only_in_scalar_context() {
		let (mut host, _) = Host::for_test("perl", Vec::new(), ".");
		let scalar = new_sv(Value::Undef);
		let mut handle = Handle::open(&mut host, OpenMode::READ, OpenTarget::Scalar(scalar), Layers::raw()).unwrap();
		assert!(handle.read_record_with_context(&RecordSep::Slurp, true).unwrap().is_none());
		assert_eq!(handle.line_no(), 0);
		assert_eq!(handle.read_record(&RecordSep::Slurp).unwrap(), Some(PStr::default()));
		assert!(handle.read_record(&RecordSep::Slurp).unwrap().is_none());
		assert_eq!(handle.line_no(), 1);
	}

	#[test]
	fn raw_print_reports_a_wide_character_but_preserves_its_utf8_bytes() {
		let (host, capture) = Host::for_test("perl", Vec::new(), ".");
		let mut stdout = Handle::stdout(&host);
		assert!(!stdout.write(&PStr::from_str("é")).unwrap());
		assert!(stdout.write(&PStr::from_str("λ")).unwrap());
		stdout.flush().unwrap();
		assert_eq!(capture.stdout(), b"\xe9\xce\xbb");
	}
}
