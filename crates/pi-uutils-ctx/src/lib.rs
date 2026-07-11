//! Thread-local I/O + working-directory context for running uutils utilities
//! in-process as shell builtins.
//!
//! uutils utilities write to the process-global `std::io::stdout()`/`stderr()`,
//! read the process-global `std::io::stdin()`, and resolve relative paths
//! against the process-global current directory. None of that is correct when
//! the utility runs as a builtin inside a long-lived shell process: output must
//! go to the command's (possibly piped/redirected) file descriptors, and
//! relative paths must resolve against the *shell's* working directory.
//!
//! This crate provides a thread-local context that vendored uutils crates are
//! patched to consult instead of the process globals. The shell host installs a
//! context for the duration of a single utility invocation on a dedicated
//! blocking thread (so concurrent pipeline stages, each on their own thread,
//! stay isolated), runs the utility, then tears the context down.

use std::{
	cell::RefCell,
	collections::HashMap,
	io::{self, Read, Write},
	path::{Path, PathBuf},
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
};

struct Ctx {
	stdin:                 Box<dyn Read + Send>,
	/// Raw fd backing `stdin` when it is a real OS file/pipe, used for
	/// cancellable readiness polling on unix. `None` for non-fd readers.
	stdin_fd:              Option<i32>,
	/// Whether stdin is a shell pipe/stream that should be searched implicitly.
	stdin_is_search_input: bool,
	stdout:                Box<dyn Write + Send>,
	stderr:                Box<dyn Write + Send>,
	cwd:                   PathBuf,
	env:                   HashMap<String, String>,
	/// Set by the host when the command is aborted/timed out; makes a blocked
	/// `stdin` read return EOF so the utility unwinds promptly.
	cancel:                Arc<AtomicBool>,
	exit_code:             i32,
}

thread_local! {
	static CTX: RefCell<Option<Ctx>> = const { RefCell::new(None) };
}

/// I/O streams, working directory, environment, and cancel flag for a single
/// utility invocation. Grouped into one value to keep [`scope`] readable.
pub struct ScopeIo {
	/// Standard input reader.
	pub stdin:                 Box<dyn Read + Send>,
	/// Raw fd backing `stdin` when it is a real OS file/pipe (unix), used for
	/// cancellable readiness polling; `None` for non-fd readers.
	pub stdin_fd:              Option<i32>,
	/// Whether stdin should be used as `rg PATTERN`'s implicit input.
	pub stdin_is_search_input: bool,
	/// Standard output writer.
	pub stdout:                Box<dyn Write + Send>,
	/// Standard error writer.
	pub stderr:                Box<dyn Write + Send>,
	/// Working directory that relative paths resolve against.
	pub cwd:                   PathBuf,
	/// Exported shell environment.
	pub env:                   HashMap<String, String>,
	/// Set by the host on abort/timeout to unblock a stalled `stdin` read.
	pub cancel:                Arc<AtomicBool>,
}

/// Installs `io` as the current thread's uutils context, runs `f`, then
/// restores whatever context (if any) was previously installed — even if `f`
/// panics. Returns the value produced by `f`.
///
/// The previous context is saved and restored rather than cleared, so nested
/// scopes (and leftover state across tests sharing a thread) stay correct.
pub fn scope<R>(io: ScopeIo, f: impl FnOnce() -> R) -> R {
	struct Guard {
		prev: Option<Ctx>,
	}
	impl Drop for Guard {
		fn drop(&mut self) {
			CTX.with(|c| {
				*c.borrow_mut() = self.prev.take();
			});
		}
	}

	let prev = CTX.with(|c| {
		c.borrow_mut().replace(Ctx {
			stdin:                 io.stdin,
			stdin_fd:              io.stdin_fd,
			stdin_is_search_input: io.stdin_is_search_input,
			stdout:                io.stdout,
			stderr:                io.stderr,
			cwd:                   io.cwd,
			env:                   io.env,
			cancel:                io.cancel,
			exit_code:             0,
		})
	});
	let _guard = Guard { prev };
	f()
}
/// Returns the exit code accumulated via [`set_exit_code`] during the current
/// scope (0 when none was set or no context is installed).
pub fn exit_code() -> i32 {
	CTX.with(|c| c.borrow().as_ref().map_or(0, |ctx| ctx.exit_code))
}

/// Records a non-zero exit code (uutils' `show!`/`show_if_err!` analogues call
/// this when a recoverable error is reported but processing continues).
pub fn set_exit_code(code: i32) {
	CTX.with(|c| {
		if let Some(ctx) = c.borrow_mut().as_mut() {
			ctx.exit_code = code;
		}
	});
}

/// The shell working directory of the current scope, or `.` when unset.
pub fn cwd() -> PathBuf {
	CTX.with(|c| {
		c.borrow()
			.as_ref()
			.map_or_else(|| PathBuf::from("."), |ctx| ctx.cwd.clone())
	})
}

/// Resolves `p` against the scope's working directory when relative; absolute
/// paths are returned unchanged. uutils utilities are patched to resolve every
/// path argument through this before touching the filesystem.
pub fn resolve(p: impl AsRef<Path>) -> PathBuf {
	let p = p.as_ref();
	if p.is_absolute() {
		p.to_path_buf()
	} else {
		cwd().join(p)
	}
}

/// Looks up an environment variable from the scope's environment map (the
/// shell's exported variables). uutils utilities are patched to read the
/// environment through this rather than `std::env::var`, because the embedding
/// shell's exported variables are not present in the host process environment.
pub fn var(key: &str) -> Option<String> {
	CTX.with(|c| {
		c.borrow()
			.as_ref()
			.and_then(|ctx| ctx.env.get(key).cloned())
	})
}
/// Returns true when scoped stdin is a shell pipe or custom stream that should
/// be treated as `rg PATTERN`'s implicit input instead of searching `.`.
#[must_use]
pub fn stdin_is_search_input() -> bool {
	CTX.with(|c| {
		c.borrow()
			.as_ref()
			.is_some_and(|ctx| ctx.stdin_is_search_input)
	})
}

macro_rules! ctx_writer {
	($name:ident, $field:ident, $doc:literal) => {
		#[doc = $doc]
		#[derive(Clone, Copy)]
		pub struct $name;

		impl $name {
			/// Mirror of `std::io::Stdout::lock`; the handle is already the
			/// lockable target, so this is the identity. Lets patched uutils
			/// code keep its `let out = ...; let out = out.lock();` shape.
			#[must_use]
			pub fn lock(self) -> Self {
				self
			}
		}

		impl Write for $name {
			fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
				CTX.with(|c| match c.borrow_mut().as_mut() {
					Some(ctx) => ctx.$field.write(buf),
					// No context installed: discard rather than leak onto the
					// host process's real fd.
					None => Ok(buf.len()),
				})
			}

			fn flush(&mut self) -> io::Result<()> {
				CTX.with(|c| match c.borrow_mut().as_mut() {
					Some(ctx) => ctx.$field.flush(),
					None => Ok(()),
				})
			}
		}
	};
}

ctx_writer!(CtxStdout, stdout, "Context-aware stand-in for `std::io::Stdout`.");
ctx_writer!(CtxStderr, stderr, "Context-aware stand-in for `std::io::Stderr`.");

/// Context-aware stand-in for `std::io::Stdin`.
#[derive(Clone, Copy)]
pub struct CtxStdin;

impl CtxStdin {
	/// Identity lock, mirroring `std::io::Stdin::lock`.
	#[must_use]
	pub fn lock(self) -> Self {
		self
	}
}

impl Read for CtxStdin {
	fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
		CTX.with(|c| {
			let mut guard = c.borrow_mut();
			let Some(ctx) = guard.as_mut() else {
				return Ok(0);
			};
			if ctx.cancel.load(Ordering::Relaxed) {
				return Ok(0);
			}
			// On unix, wait for readiness in short slices so an abort/timeout is
			// observed even when input never arrives on a blocked pipe: the
			// utility then sees EOF and unwinds cleanly (no detached thread, no
			// writes after the host has moved on).
			#[cfg(unix)]
			if let Some(fd) = ctx.stdin_fd {
				loop {
					if ctx.cancel.load(Ordering::Relaxed) {
						return Ok(0);
					}
					let mut pfd = libc::pollfd { fd, events: libc::POLLIN, revents: 0 };
					// SAFETY: one `pollfd` valid for the call; `fd` is owned by the
					// live `OpenFile` held in this context.
					let r = unsafe { libc::poll(&mut pfd, 1, 200) };
					if r < 0 {
						let err = io::Error::last_os_error();
						if err.kind() == io::ErrorKind::Interrupted {
							continue;
						}
						return Err(err);
					}
					if r > 0 {
						break;
					}
				}
			}
			ctx.stdin.read(buf)
		})
	}
}

/// Returns the context stdout handle.
#[must_use]
pub fn stdout() -> CtxStdout {
	CtxStdout
}

/// Returns the context stderr handle.
#[must_use]
pub fn stderr() -> CtxStderr {
	CtxStderr
}

/// Returns the context stdin handle.
#[must_use]
pub fn stdin() -> CtxStdin {
	CtxStdin
}
