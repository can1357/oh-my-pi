//! The stub of a background job: the process this shell forks at `&`, before
//! it expands any word of the job, as Bash forks the job's child first. `$!`
//! names it at once, and `wait`, `kill` and `jobs` reach it.
//!
//! The job then runs in a task of this process (the driver) with the job's
//! own subshell, which expands the job's words once, there. For an external
//! command the driver hands the stub each redirection in turn, as Bash's child
//! makes them, and then the command, which the stub becomes with `execve`.
//! For anything else (a builtin, a function, a compound command, a list) the
//! driver runs it in the subshell and the stub only stands for it: it exits
//! with the job's status, and a signal that ends the stub ends the job.
//!
//! The two talk over a socket the stub holds at a descriptor the command
//! never sees (see `childredirects::drive`). Each request is a 16-byte
//! header, little-endian `kind`, `fd`, `arg` and payload length, then the
//! payload; the stub answers each step with one `i32`: 0, the `errno` of the
//! call that failed, or minus the `errno` of placing the result at its
//! descriptor.

use std::os::fd::{AsRawFd as _, FromRawFd as _, OwnedFd, RawFd};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use tokio::io::{AsyncWriteExt as _, Interest};
use tokio_util::sync::CancellationToken;

use crate::ShellFd;
use crate::interp::ChildOpenMode;

/// The kinds of request the driver sends the stub.
pub(crate) mod frame {
	/// Open the payload path on `fd`, as `arg` (a [`super::ChildOpenMode`]) says.
	pub(crate) const OPEN: u32 = 1;
	/// Duplicate `arg` onto `fd`.
	pub(crate) const DUPLICATE: u32 = 2;
	/// Close `fd`.
	pub(crate) const CLOSE: u32 = 3;
	/// Truncate the file at `fd`, as `O_TRUNC` would.
	pub(crate) const TRUNCATE: u32 = 4;
	/// Place the descriptor that comes with the next byte on `fd`.
	pub(crate) const PLACE: u32 = 5;
	/// Write the payload on standard error and exit with `arg`.
	pub(crate) const REPORT: u32 = 6;
	/// Execute the payload's program: `fd` argument strings and `arg`
	/// environment strings follow the program, each NUL-terminated.
	pub(crate) const EXEC: u32 = 7;
	/// Exit with `arg`.
	pub(crate) const EXIT: u32 = 8;

	/// The size of a request's header.
	pub(crate) const HEADER: usize = 16;
}

impl ChildOpenMode {
	/// This mode as an `OPEN` request carries it.
	pub(crate) const fn to_wire(self) -> i32 {
		match self {
			Self::Read => 0,
			Self::Write => 1,
			Self::WriteNoClobber => 2,
			Self::Append => 3,
			Self::ReadWrite => 4,
		}
	}

	/// The mode an `OPEN` request carries.
	pub(crate) const fn from_wire(wire: i32) -> Option<Self> {
		Some(match wire {
			0 => Self::Read,
			1 => Self::Write,
			2 => Self::WriteNoClobber,
			3 => Self::Append,
			4 => Self::ReadWrite,
			_ => return None,
		})
	}
}

/// Why the stub did not take a step.
#[derive(Debug)]
pub(crate) enum StepFailure {
	/// The call failed with this `errno`.
	Call(i32),
	/// The result could not be placed at its descriptor: this `errno`.
	Target(i32),
	/// The stub is gone: it was killed, or has executed the command already.
	Gone,
}

/// This shell's end of a stub's control socket.
#[derive(Debug)]
pub(crate) struct JobStub {
	/// Requests go out on the socket; a task of this process reads the
	/// stub's answers into the channel, in order.
	channel: tokio::sync::Mutex<Channel>,
	pid:     i32,
	/// The stub has been told how to end (to report or to exit), so it takes
	/// nothing more.
	ended:   AtomicBool,
	/// The stub has been asked to execute the command, report or exit, so its
	/// end of the socket is to close.
	closing: AtomicBool,
	/// Cancelled once the stub's end of the socket has closed.
	closed:  CancellationToken,
}

#[derive(Debug)]
struct Channel {
	requests: tokio::net::unix::OwnedWriteHalf,
	/// Each answer, with the descriptor that came with it: after a step that
	/// set a descriptor, the stub's copy of it, so that this shell expands the
	/// next word with the descriptors the command will have.
	answers:  tokio::sync::mpsc::UnboundedReceiver<(i32, Option<OwnedFd>)>,
}

impl JobStub {
	/// Makes a control socket: this shell's end, and the stub's at a
	/// close-on-exec descriptor above `above` where the open-file limit
	/// leaves room for one, so that no descriptor the stub is given before
	/// it runs replaces it. Where it does not, the socket stays where the
	/// pair put it and moves out of the way of a redirection that names it.
	pub(crate) fn socket(above: RawFd) -> std::io::Result<(tokio::net::UnixStream, OwnedFd)> {
		// Both ends are close-on-exec, as std makes every descriptor.
		let (ours, theirs) = std::os::unix::net::UnixStream::pair()?;
		// SAFETY: plain descriptor call on a descriptor this function owns.
		let raised = unsafe { libc::fcntl(theirs.as_raw_fd(), libc::F_DUPFD_CLOEXEC, above.max(2) + 1) };
		let theirs = if raised < 0 {
			theirs.into()
		} else {
			drop(theirs);
			// SAFETY: `fcntl` made `raised`, which nothing else owns.
			unsafe { OwnedFd::from_raw_fd(raised) }
		};
		ours.set_nonblocking(true)?;
		Ok((tokio::net::UnixStream::from_std(ours)?, theirs))
	}

	/// The stub `pid`, driven over `control`.
	pub(crate) fn new(control: tokio::net::UnixStream, pid: i32) -> Self {
		let (stub_answers, requests) = control.into_split();
		let (answered, answers) = tokio::sync::mpsc::unbounded_channel();
		let closed = CancellationToken::new();
		tokio::spawn({
			let closed = closed.clone();
			async move {
				while let Ok(answer) = receive_answer(&stub_answers).await {
					if answered.send(answer).is_err() {
						break;
					}
				}
				closed.cancel();
			}
		});
		Self {
			channel: tokio::sync::Mutex::new(Channel { requests, answers }),
			pid,
			ended: AtomicBool::new(false),
			closing: AtomicBool::new(false),
			closed,
		}
	}

	/// The stub's process id: `$!`.
	pub(crate) const fn pid(&self) -> i32 {
		self.pid
	}

	/// Whether the stub has been told how to end, or has executed the
	/// command.
	pub(crate) fn has_ended(&self) -> bool {
		self.ended.load(Ordering::Acquire)
	}

	/// Whether the stub's end of the socket closing was asked for (the
	/// command executed, a report or an exit), not a signal ending it.
	pub(crate) fn is_closing(&self) -> bool {
		self.closing.load(Ordering::Acquire)
	}

	/// Opens `path` on `fd` in the stub, as `mode` says; the stub's copy of
	/// the descriptor it opened.
	pub(crate) async fn open(
		&self,
		fd: ShellFd,
		mode: ChildOpenMode,
		path: &Path,
	) -> Result<Option<OwnedFd>, StepFailure> {
		let path = path.as_os_str().as_encoded_bytes();
		if path.contains(&0) {
			return Err(StepFailure::Call(libc::EINVAL));
		}
		self.step(frame::OPEN, fd, mode.to_wire(), path, None).await
	}

	/// Duplicates `from` onto `fd` in the stub; the stub's copy of `fd`.
	pub(crate) async fn duplicate(&self, fd: ShellFd, from: ShellFd) -> Result<Option<OwnedFd>, StepFailure> {
		self.step(frame::DUPLICATE, fd, from, &[], None).await
	}

	/// Closes `fd` in the stub.
	pub(crate) async fn close(&self, fd: ShellFd) -> Result<(), StepFailure> {
		self.step(frame::CLOSE, fd, 0, &[], None).await.map(drop)
	}

	/// Truncates the file at `fd` in the stub; one that is not a regular file
	/// is left alone, as `O_TRUNC` leaves it.
	pub(crate) async fn truncate(&self, fd: ShellFd) -> Result<(), StepFailure> {
		self.step(frame::TRUNCATE, fd, 0, &[], None).await.map(drop)
	}

	/// Gives the stub `file`, which this process opened, at `fd`; the stub's
	/// copy of `fd`.
	pub(crate) async fn place(&self, fd: ShellFd, file: RawFd) -> Result<Option<OwnedFd>, StepFailure> {
		self.step(frame::PLACE, fd, 0, &[], Some(file)).await
	}

	/// Has the stub execute the program `payload` names (see
	/// [`frame::EXEC`]). `Ok` once it has: its end of the socket closed with
	/// the `exec`. The `errno` it failed with otherwise; the stub then waits
	/// to be told how to end.
	pub(crate) async fn exec(&self, payload: &[u8], args: i32, envs: i32) -> Result<(), StepFailure> {
		let mut channel = self.channel.lock().await;
		if self.has_ended() {
			return Err(StepFailure::Gone);
		}
		self.closing.store(true, Ordering::Release);
		send(&mut channel.requests, frame::EXEC, args, envs, payload, None)
			.await
			.map_err(|_| StepFailure::Gone)?;
		match channel.answers.recv().await {
			None => {
				self.ended.store(true, Ordering::Release);
				Ok(())
			},
			Some((errno, _)) => Err(StepFailure::Call(errno)),
		}
	}

	/// Has the stub write `text` on its standard error as it stands and exit
	/// with `status`.
	pub(crate) async fn report(&self, status: u8, text: &[u8]) {
		self.end(frame::REPORT, i32::from(status), text).await;
	}

	/// Has the stub exit with `status`.
	pub(crate) async fn exit(&self, status: u8) {
		self.end(frame::EXIT, i32::from(status), &[]).await;
	}

	/// Waits until the stub's end of the socket closes: the stub has ended,
	/// whatever ended it.
	pub(crate) async fn closed(&self) {
		self.closed.cancelled().await;
	}

	async fn end(&self, kind: u32, status: i32, payload: &[u8]) {
		let mut channel = self.channel.lock().await;
		if self.ended.swap(true, Ordering::AcqRel) {
			return;
		}
		self.closing.store(true, Ordering::Release);
		let _ = send(&mut channel.requests, kind, 0, status, payload, None).await;
	}

	async fn step(
		&self,
		kind: u32,
		fd: ShellFd,
		arg: i32,
		payload: &[u8],
		file: Option<RawFd>,
	) -> Result<Option<OwnedFd>, StepFailure> {
		let mut channel = self.channel.lock().await;
		if self.has_ended() {
			return Err(StepFailure::Gone);
		}
		send(&mut channel.requests, kind, fd, arg, payload, file)
			.await
			.map_err(|_| StepFailure::Gone)?;
		match channel.answers.recv().await {
			None => Err(StepFailure::Gone),
			Some((0, descriptor)) => Ok(descriptor),
			Some((errno, _)) if errno > 0 => Err(StepFailure::Call(errno)),
			Some((errno, _)) => Err(StepFailure::Target(-errno)),
		}
	}
}

/// Receives one answer from the stub: its four bytes, with the descriptor
/// that came with them, if any. An error once the stub's end has closed.
async fn receive_answer(
	answers: &tokio::net::unix::OwnedReadHalf,
) -> std::io::Result<(i32, Option<OwnedFd>)> {
	let socket = answers.as_ref();
	let mut answer = [0u8; 4];
	let mut received = 0;
	let mut descriptor = None;
	while received < answer.len() {
		socket.readable().await?;
		match socket.try_io(Interest::READABLE, || {
			receive_with_descriptor(socket.as_raw_fd(), &mut answer[received..])
		}) {
			Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {},
			Err(error) => return Err(error),
			Ok((0, _)) => return Err(std::io::ErrorKind::UnexpectedEof.into()),
			Ok((read, file)) => {
				received += read;
				// Only the answer's first byte carries one.
				descriptor = descriptor.or(file);
			},
		}
	}
	Ok((i32::from_le_bytes(answer), descriptor))
}

/// Reads into `bytes` from the socket at `socket`, with the descriptor that
/// comes with them, if any, made close-on-exec.
fn receive_with_descriptor(socket: RawFd, bytes: &mut [u8]) -> std::io::Result<(usize, Option<OwnedFd>)> {
	let mut iov = libc::iovec { iov_base: bytes.as_mut_ptr().cast(), iov_len: bytes.len() };
	// Room for one header and one descriptor, aligned as the kernel writes it.
	let mut space = [0u64; 4];
	// SAFETY: a zeroed `msghdr` is valid; every pointer set below outlives the
	// call, and `space` is larger than `CMSG_SPACE` of one descriptor.
	let mut message: libc::msghdr = unsafe { std::mem::zeroed() };
	message.msg_iov = &raw mut iov;
	message.msg_iovlen = 1;
	message.msg_control = space.as_mut_ptr().cast();
	message.msg_controllen = size_of_val(&space) as _;
	#[cfg(target_os = "linux")]
	let flags = libc::MSG_CMSG_CLOEXEC;
	#[cfg(not(target_os = "linux"))]
	let flags = 0;
	// SAFETY: `message` is fully initialized above.
	let read = unsafe { libc::recvmsg(socket, &raw mut message, flags) };
	let read = usize::try_from(read).map_err(|_| std::io::Error::last_os_error())?;
	// SAFETY: the `CMSG_*` helpers stay inside `space`, which `message`
	// describes; a descriptor the kernel put there belongs to this process.
	let descriptor = unsafe {
		let header = libc::CMSG_FIRSTHDR(&raw const message);
		if header.is_null() || (*header).cmsg_level != libc::SOL_SOCKET || (*header).cmsg_type != libc::SCM_RIGHTS {
			None
		} else {
			let raw = libc::CMSG_DATA(header).cast::<RawFd>().read_unaligned();
			#[cfg(not(target_os = "linux"))]
			libc::fcntl(raw, libc::F_SETFD, libc::FD_CLOEXEC);
			Some(OwnedFd::from_raw_fd(raw))
		}
	};
	Ok((read, descriptor))
}

/// Sends one request; `file` goes with a byte after it.
async fn send(
	control: &mut tokio::net::unix::OwnedWriteHalf,
	kind: u32,
	fd: ShellFd,
	arg: i32,
	payload: &[u8],
	file: Option<RawFd>,
) -> std::io::Result<()> {
	let length = u32::try_from(payload.len()).map_err(|_| std::io::Error::from_raw_os_error(libc::E2BIG))?;
	let mut header = [0u8; frame::HEADER];
	header[0..4].copy_from_slice(&kind.to_le_bytes());
	header[4..8].copy_from_slice(&fd.to_le_bytes());
	header[8..12].copy_from_slice(&arg.to_le_bytes());
	header[12..16].copy_from_slice(&length.to_le_bytes());
	control.write_all(&header).await?;
	control.write_all(payload).await?;
	if let Some(file) = file {
		let socket = control.as_ref();
		loop {
			socket.writable().await?;
			match socket.try_io(Interest::WRITABLE, || send_descriptor(socket.as_raw_fd(), file)) {
				Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {},
				sent => return sent,
			}
		}
	}
	Ok(())
}

/// Sends one byte over the socket at `socket`, with `file` attached.
fn send_descriptor(socket: RawFd, file: RawFd) -> std::io::Result<()> {
	let mut byte = [0u8; 1];
	let mut iov = libc::iovec { iov_base: byte.as_mut_ptr().cast(), iov_len: 1 };
	// SAFETY: `CMSG_SPACE` only computes a size.
	let space = unsafe { libc::CMSG_SPACE(size_of::<RawFd>() as u32) } as usize;
	let mut control = vec![0u8; space];
	// SAFETY: a zeroed `msghdr` is valid; every pointer set below outlives the call.
	let mut message: libc::msghdr = unsafe { std::mem::zeroed() };
	message.msg_iov = &raw mut iov;
	message.msg_iovlen = 1;
	message.msg_control = control.as_mut_ptr().cast();
	message.msg_controllen = space as _;
	// SAFETY: `message` describes `control`, which has room for one header and
	// one descriptor; the `CMSG_*` helpers stay inside it.
	unsafe {
		let header = libc::CMSG_FIRSTHDR(&raw const message);
		(*header).cmsg_level = libc::SOL_SOCKET;
		(*header).cmsg_type = libc::SCM_RIGHTS;
		(*header).cmsg_len = libc::CMSG_LEN(size_of::<RawFd>() as u32) as _;
		libc::CMSG_DATA(header).cast::<RawFd>().write_unaligned(file);
	}
	// A stub that is gone raises `EPIPE`, not a `SIGPIPE` for this process.
	#[cfg(target_os = "linux")]
	let flags = libc::MSG_NOSIGNAL;
	#[cfg(not(target_os = "linux"))]
	let flags = 0;
	// SAFETY: `message` is fully initialized above.
	if unsafe { libc::sendmsg(socket, &raw const message, flags) } < 0 {
		return Err(std::io::Error::last_os_error());
	}
	Ok(())
}
