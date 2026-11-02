//! Role orchestration for one rsync run: option outcomes, the connection to
//! the peer (local in-process server half, remote shell, daemon, batch file),
//! protocol setup, the filter-list exchange, the sending and receiving engine
//! threads, the stats exchange, the end-of-run goodbye, error-exit
//! synchronization, and exit-code aggregation.
//!
//! Thread model (see the design doc's phase-2 contract): the sending side runs
//! the scanner and sender on the calling thread; the receiving side receives the
//! initial file list on the calling thread and then runs the generator and the
//! receiver on two scoped threads joined by a [`Sibling`] channel. Out-of-band
//! peer messages are routed by the reader's `on_msg` hook ([`Shared::on_msg`]).
//!
//! Every side has its own abort flag (the `cancel` every engine thread polls):
//! it mirrors the host's cancellation and is also raised when the side fails,
//! so blocked reads on sibling threads end promptly. The first failure decides
//! the exit code; later errors caused by the abort are ignored.

use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use pi_vfs::BlockingFs;

use crate::host::{ChildEnv, Host, ShellPaths, StreamWriter, os_bytes_lossy};
use crate::rsync::flists::lock;
use crate::rsync::time::unix_now;
use crate::rsync::acl::AclOpts;
use crate::rsync::batch::{self, BatchFiles, BatchTee, SharedBatch};
use crate::rsync::checksum::CsumType;
use crate::rsync::consts::{
	IOERR_DEL_LIMIT, IOERR_GENERAL, IOERR_VALID_MASK, IOERR_VANISHED, MAX_WIRE_DEL_STAT,
	MSG_BLOCK_STATS, MSG_DELETED, MSG_ERROR_EXIT, MSG_ERROR_XFER, MSG_IO_ERROR, MSG_IO_TIMEOUT, MSG_NO_SEND,
	MSG_NOOP, MSG_SUCCESS, MSK_ALLOW_FLUSH, NDX_DEL_STATS, NDX_DONE,
};
use crate::rsync::daemon::{self, DaemonConfig};
use crate::rsync::exit::{
	RERR_PROTOCOL, RERR_SIGNAL, RERR_SIGNAL1, RERR_SOCKETIO, RERR_STARTCLIENT, RERR_STREAMIO,
	RERR_SYNTAX, RERR_TIMEOUT, RERR_UNSUPPORTED, RERR_VANISHED, RsyncError,
};
use crate::rsync::filter::{FilterConfig, FileReader, Filters, ImpliedFilters, RuleArg};
use crate::rsync::flist::FlistOpts;
use crate::rsync::flists::Flists;
use crate::rsync::generator::{self, DestTrees, SibOut, Sibling};
use crate::rsync::handshake::{self, Negotiated, Roles, Setup};
use crate::rsync::iconv;
use crate::rsync::log::{self, Info, LogCode, LogConfig, Logger, OutLevels, Role, Stats};
use crate::rsync::meta::MetaOpts;
use crate::rsync::mux::{IoCounters, Msg, MuxReader, MuxWriter, ReadConfig, ReadProbe, WriteConfig};
use crate::rsync::operands::{self, OperandConfig, Operands, Remote};
use crate::rsync::options::{self, FilesFromFd, Options, Parsed};
use crate::rsync::paths::{self, bytes_os_lossy};
use crate::rsync::progress::Progress;
use crate::rsync::scan::{FlistReceiver, Scanner};
use crate::rsync::token::Compress;
use crate::rsync::log::syserr_text;
use crate::rsync::transport::{self, Connection, ShellConfig, TcpConfig};
use crate::rsync::wire::{NdxCodec, Proto, ReadExt, WriteExt};
use crate::rsync::xattr::{XattrOpts, read_varint_bounded};
use crate::rsync::{receiver, sender, usage};

/// Per-run state shared read-only by every engine thread (cheap to clone).
#[derive(Clone)]
pub(crate) struct Ctx {
	pub opts: Arc<Options>,
	pub proto: Proto,
	/// Negotiated block checksum.
	pub xfer_sum: CsumType,
	/// Negotiated whole-file checksum.
	pub file_sum: CsumType,
	/// Checksum seed.
	pub seed: i32,
	/// Negotiated compression (Compress::None without -z).
	pub compress: Compress,
	pub compress_level: Option<i32>,
	/// Already set to this thread's Role.
	pub logger: Logger,
	pub cancel: Arc<AtomicBool>,
	pub fs: BlockingFs,
	/// Shell cwd (absolute); a server's transfer directory.
	pub cwd: PathBuf,
	pub umask: u32,
	pub am_server: bool,
	pub am_sender: bool,
	pub local_server: bool,
	pub am_root: bool,
	/// Negotiated CF_INC_RECURSE.
	pub inc_recurse: bool,
	pub flist_opts: FlistOpts,
	pub meta: MetaOpts,
	pub xattr_opts: XattrOpts,
	pub acl_opts: AclOpts,
	/// All counters (num_files, literal_data, …).
	pub stats: Arc<Mutex<Stats>>,
	/// IOERR_* bits.
	pub io_error: Arc<AtomicI32>,
	pub counters: IoCounters,
	pub iconv: Option<Arc<iconv::Iconv>>,
	/// Client-side --progress printer.
	pub progress: Option<Arc<Mutex<Progress>>>,
	/// The shell's path resolver (MSYS paths, `/dev/fd/N`); resolve operator and
	/// operand paths with `paths.resolve(p)`.
	pub paths: ShellPaths,
	/// `--only-write-batch` on the client sending side: the batch file deltas go to
	/// instead of the peer (the same object the output tee writes into).
	pub batch_only: Option<Arc<Mutex<Box<dyn Write + Send>>>>,
}

impl Ctx {
	/// Clone with `logger.with_role(role)`.
	pub(crate) fn with_role(&self, role: Role) -> Ctx {
		let mut ctx = self.clone();
		ctx.logger = self.logger.with_role(role);
		ctx
	}

	/// Fails with [`RsyncError::cancelled`] once this side's abort flag is raised.
	pub(crate) fn check_cancel(&self) -> Result<(), RsyncError> {
		if self.cancel.load(Ordering::Relaxed) { Err(RsyncError::cancelled()) } else { Ok(()) }
	}

	/// A failed read or write of the protocol stream (`RERR_STREAMIO`), with this side's
	/// connection-closed text for a bare EOF.
	pub(crate) fn stream_error(&self, err: &io::Error) -> RsyncError {
		self.logger.io_error(err, RERR_STREAMIO, self.counters.total_read())
	}

	/// A client-side context for unit tests: protocol 33 without inc-recursion,
	/// MD5 sums, a logger writing nowhere, the native filesystem, and `cwd` =
	/// the system temp dir.
	#[cfg(test)]
	pub(crate) fn for_tests(opts: Options) -> Ctx {
		let logger = Logger::local(Box::new(io::sink()), Box::new(io::sink()), LogConfig::default());
		let paths = ShellPaths::default();
		let neg = Negotiated {
			proto: Proto { version: 33, compat: 0 },
			inc_recurse: false,
			xfer_sum: CsumType::Md5,
			file_sum: CsumType::Md5,
			seed: 0,
			compress: Compress::None,
			compress_level: None,
			receiver_symlink_times: true,
		};
		let parts = CtxParts {
			fs: paths.fs().clone(),
			paths,
			cwd: std::env::temp_dir(),
			umask: 0o022,
			cancel: Arc::new(AtomicBool::new(false)),
			counters: IoCounters::default(),
		};
		let am_sender = opts.am_sender;
		build_ctx(&parts, Arc::new(opts), &neg, logger, false, am_sender, false, None, None)
	}
}

/// Host-derived parts every [`Ctx`] of a side shares.
#[derive(Clone)]
struct CtxParts {
	fs: BlockingFs,
	paths: ShellPaths,
	cwd: PathBuf,
	umask: u32,
	cancel: Arc<AtomicBool>,
	counters: IoCounters,
}

#[allow(clippy::too_many_arguments, reason = "one place assembles every Ctx field")]
fn build_ctx(
	parts: &CtxParts,
	opts: Arc<Options>,
	neg: &Negotiated,
	logger: Logger,
	am_server: bool,
	am_sender: bool,
	local_server: bool,
	iconv: Option<Arc<iconv::Iconv>>,
	batch_only: Option<SharedBatch>,
) -> Ctx {
	let o = &*opts;
	let am_root = o.am_root > 0;
	let fake_super = o.am_root < 0;
	let flist_opts = FlistOpts {
		preserve_uid: o.preserve_uid,
		preserve_gid: o.preserve_gid,
		preserve_links: o.preserve_links,
		preserve_devices: o.preserve_devices,
		preserve_specials: o.preserve_specials,
		preserve_hard_links: o.preserve_hard_links > 0,
		preserve_atimes: o.preserve_atimes > 0,
		preserve_crtimes: o.preserve_crtimes,
		preserve_acls: o.preserve_acls,
		preserve_xattrs: o.preserve_xattrs > 0,
		always_checksum: o.always_checksum,
		checksum_len: neg.file_sum.flist_len(),
		numeric_ids: o.numeric_ids,
		inc_recurse: neg.inc_recurse,
		relative_paths: o.relative_paths > 0,
		am_root,
		max_alloc: o.max_alloc,
		recurse: o.recurse > 0,
		delete_missing_args: o.missing_args == 2,
		copy_devices: o.copy_devices && !am_sender,
		chmod: if am_sender { None } else { o.chmod_modes.clone() },
	};
	let meta = MetaOpts {
		perms: o.preserve_perms,
		executability: o.preserve_executability,
		owner: o.preserve_uid,
		group: o.preserve_gid,
		am_root,
		fake_super,
		times: o.preserve_mtimes,
		omit_dir_times: o.omit_dir_times != 0,
		omit_link_times: o.omit_link_times,
		atimes: o.preserve_atimes > 0,
		crtimes: o.preserve_crtimes,
		modify_window: i64::from(o.modify_window),
		acls: o.preserve_acls,
		xattrs: o.preserve_xattrs > 0,
		dry_run: o.dry_run,
		copy_links: o.copy_links,
		keep_dirlinks: o.keep_dirlinks && !am_sender,
	};
	let xattr_opts = XattrOpts {
		all_namespaces: o.preserve_xattrs > 1,
		fake_super,
		am_root,
		am_sender,
		preserve_links: o.preserve_links,
		preserve_devices: o.preserve_devices,
		preserve_specials: o.preserve_specials,
		dry_run: o.dry_run,
	};
	let acl_opts = AclOpts {
		am_root,
		fake_super,
		numeric_ids: o.numeric_ids,
		inc_recurse: neg.inc_recurse,
		preserve_devices: o.preserve_devices,
		preserve_specials: o.preserve_specials,
		dry_run: o.dry_run,
	};
	let progress = (!am_server && logger.levels().info(Info::Progress) > 0).then(|| {
		let level = logger.levels().info(Info::Progress);
		Arc::new(Mutex::new(Progress::from_logger(&logger, level)))
	});
	Ctx {
		proto: neg.proto,
		xfer_sum: neg.xfer_sum,
		file_sum: neg.file_sum,
		seed: neg.seed,
		compress: neg.compress,
		compress_level: neg.compress_level,
		logger,
		cancel: Arc::clone(&parts.cancel),
		fs: parts.fs.clone(),
		cwd: parts.cwd.clone(),
		umask: parts.umask,
		am_server,
		am_sender,
		local_server,
		am_root,
		inc_recurse: neg.inc_recurse,
		flist_opts,
		meta,
		xattr_opts,
		acl_opts,
		stats: Arc::new(Mutex::new(Stats::default())),
		io_error: Arc::new(AtomicI32::new(0)),
		counters: parts.counters.clone(),
		iconv,
		progress,
		paths: parts.paths.clone(),
		batch_only,
		opts,
	}
}

// ---------------------------------------------------------------------------
// Host plumbing

/// A writer several owners share (stdout/stderr handed to several loggers).
///
/// A server's descriptors may have been left O_NONBLOCK by an upstream client
/// (its socketpair; pipe.c resets only stdin), so EAGAIN waits and retries
/// instead of failing; the host's cancellation ends the wait.
#[derive(Clone)]
struct SharedWrite(Arc<Mutex<Box<dyn Write + Send>>>, Arc<AtomicBool>);

impl SharedWrite {
	fn new(inner: Box<dyn Write + Send>, cancel: &Arc<AtomicBool>) -> Self {
		Self(Arc::new(Mutex::new(inner)), Arc::clone(cancel))
	}

	fn retry<T>(&self, mut op: impl FnMut(&mut Box<dyn Write + Send>) -> io::Result<T>) -> io::Result<T> {
		loop {
			match op(&mut lock(&self.0)) {
				Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
					if self.1.load(Ordering::Relaxed) {
						return Err(RsyncError::cancelled_io());
					}
					thread::sleep(Duration::from_millis(1));
				}
				other => return other,
			}
		}
	}
}

impl Write for SharedWrite {
	fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
		self.retry(|w| w.write(buf))
	}

	fn flush(&mut self) -> io::Result<()> {
		self.retry(|w| w.flush())
	}
}

/// A reader several owners share (stdin: files-from, filter files, batch `-`).
#[derive(Clone)]
struct SharedRead(Arc<Mutex<Box<dyn Read + Send>>>);

impl Read for SharedRead {
	fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
		lock(&self.0).read(buf)
	}
}

/// Everything the run needs from the [`Host`], owned so threads can use it.
#[derive(Clone)]
struct HostIo {
	out: SharedWrite,
	err: SharedWrite,
	stdin: SharedRead,
	stdout_raw: SharedWrite,
	fs: BlockingFs,
	paths: ShellPaths,
	cwd: PathBuf,
	/// What ends this half: the host's cancellation, or for the in-process
	/// server half of a local copy the client's kill (upstream's SIGUSR1).
	cancel: Arc<AtomicBool>,
	/// The host's own cancellation (abort, `timeout`, signals).
	host_cancel: Arc<AtomicBool>,
	child: ChildEnv,
	umask: u32,
	tz: jiff::tz::TimeZone,
	env: Arc<HashMap<String, String>>,
	argv0: OsString,
}

impl HostIo {
	fn new(host: &mut Host, env: Arc<HashMap<String, String>>, argv0: OsString) -> Self {
		let out: Box<dyn Write + Send> = Box::new(host.stdout_writer());
		let err: Box<dyn Write + Send> = match &host.stderr {
			StreamWriter::Shared(shared) => Box::new(StreamWriter::Shared(Arc::clone(shared))),
			_ => Box::new(StreamWriter::line(host.stderr_clone())),
		};
		let stdin: Box<dyn Read + Send> = match host.stdin.try_clone() {
			Ok(stdin) => Box::new(stdin),
			Err(_) => Box::new(io::empty()),
		};
		let stdout_raw: Box<dyn Write + Send> = Box::new(host.stdout_clone());
		#[cfg(unix)]
		let umask = host.umask();
		#[cfg(not(unix))]
		let umask = 0o022;
		let cancel = host.cancel_flag();
		Self {
			out: SharedWrite::new(out, &cancel),
			err: SharedWrite::new(err, &cancel),
			stdin: SharedRead(Arc::new(Mutex::new(stdin))),
			stdout_raw: SharedWrite::new(stdout_raw, &cancel),
			fs: host.fs().clone(),
			paths: host.paths().clone(),
			cwd: host.cwd().to_path_buf(),
			cancel: Arc::clone(&cancel),
			host_cancel: cancel,
			child: host.child_env(),
			umask,
			tz: crate::time_zone::shell_time_zone(host),
			env,
			argv0,
		}
	}

	fn getenv(&self, key: &str) -> Option<String> {
		self.env.get(key).cloned()
	}

	fn resolve(&self, p: &OsStr) -> PathBuf {
		self.paths.resolve(Path::new(p))
	}

	fn print(&self, text: &str) {
		let mut out = self.out.clone();
		let _ = out.write_all(text.as_bytes());
		let _ = out.flush();
	}

	fn is_local_vfs(&self, p: &OsStr) -> bool {
		routes_locally(&self.fs, p)
	}

	fn parts(&self, cancel: Arc<AtomicBool>, counters: IoCounters) -> CtxParts {
		CtxParts {
			fs: self.fs.clone(),
			paths: self.paths.clone(),
			cwd: self.cwd.clone(),
			umask: self.umask,
			cancel,
			counters,
		}
	}
}

/// Whether a `scheme://…` operand names a local path: the shell's filesystem
/// routes that scheme (natively or to an installed provider). Anything else
/// spelled like a URL is upstream's `host:path` with an empty-looking path
/// (`host://abs/path`), so it stays a remote host spec.
fn routes_locally(fs: &BlockingFs, p: &OsStr) -> bool {
	let path = Path::new(p);
	let Some(scheme) = pi_vfs::url_scheme(path) else { return false };
	if fs.is_native_local(path) || fs.symlink_metadata(path).is_ok() {
		return true;
	}
	fs.metadata(PathBuf::from(format!("{scheme}://"))).is_ok()
}

/// Mirrors the host's cancellation into a side's abort flag (and `--stop-at`).
struct Watch {
	done: Arc<AtomicBool>,
	handle: Option<thread::JoinHandle<()>>,
}

impl Watch {
	/// Raises every flag in `flags` once `host` rises.
	fn start(
		host: Arc<AtomicBool>,
		flags: Vec<Arc<AtomicBool>>,
		stop_at: i64,
		shared: Arc<Mutex<Option<Arc<Shared>>>>,
	) -> Self {
		let done = Arc::new(AtomicBool::new(false));
		let flag = Arc::clone(&done);
		let handle = thread::Builder::new()
			.name("rsync-watch".into())
			.spawn(move || {
				let mut stop_at = stop_at;
				while !flag.load(Ordering::Relaxed) {
					if host.load(Ordering::Relaxed) {
						for raised in &flags {
							raised.store(true, Ordering::Relaxed);
						}
						return;
					}
					// Output that can no longer be written ends the run (RERR_MESSAGEIO).
					if let Some(shared) = lock(&shared).clone()
						&& let Some(err) = shared.logger.take_fatal()
					{
						let role = shared.logger.role();
						shared.fail(err, role);
					}
					if stop_at > 0 && unix_now() >= stop_at {
						if let Some(shared) = lock(&shared).clone() {
							stop_at = 0;
							let err = RsyncError::new(RERR_TIMEOUT, "stopping at requested limit").at("io.c", 945);
							let role = shared.logger.role();
							shared.fail(err, role);
						}
					}
					thread::sleep(Duration::from_millis(20));
				}
			})
			.ok();
		Self { done, handle }
	}
}

impl Drop for Watch {
	fn drop(&mut self) {
		self.done.store(true, Ordering::Relaxed);
		if let Some(handle) = self.handle.take() {
			let _ = handle.join();
		}
	}
}

/// Prints an error's diagnostic (one rprintf per line, like upstream's separate calls).
fn report(logger: &Logger, err: &RsyncError) {
	if let Some(message) = &err.message {
		for line in message.split('\n') {
			let mut text = line.as_bytes().to_vec();
			text.push(b'\n');
			logger.rprintf(LogCode::Error, &text);
		}
	}
}

// ---------------------------------------------------------------------------
// Entry point

/// Entry point used by the Utility impl. `argv[0]` is the program name.
pub(crate) fn run(host: &mut Host, argv: Vec<OsString>) -> i32 {
	let env: Arc<HashMap<String, String>> =
		Arc::new(host.env().map(|(k, v)| (k.to_string(), v.to_string())).collect());
	let argv0 = argv.first().cloned().unwrap_or_else(|| OsString::from("rsync"));
	let io = HostIo::new(host, env, argv0);
	let args = argv.get(1..).unwrap_or(&[]);
	let getenv = |k: &str| io.getenv(k);
	let server_like = args.iter().any(|a| a == "--server");
	let code = match options::parse(args, &getenv) {
		Ok(Parsed::Help) => {
			io.print(&usage::help_text());
			0
		}
		Ok(Parsed::Version) => {
			io.print(&usage::version_text());
			0
		}
		Ok(Parsed::VersionJson) => {
			io.print(&usage::version_json_text());
			0
		}
		Ok(Parsed::DaemonHelp) => {
			io.print(&usage::daemon_help_text());
			0
		}
		Ok(Parsed::InfoHelp) => {
			io.print(&OutLevels::info_help());
			0
		}
		Ok(Parsed::DebugHelp) => {
			io.print(&OutLevels::debug_help());
			0
		}
		Err(err) => {
			let logger = startup_logger(&io, server_like);
			report(&logger, &err);
			logger.finish(err.code, err.site, &Stats::default(), false);
			err.code
		}
		Ok(Parsed::Run(opts)) => {
			if opts.am_server {
				server_main(&io, *opts, None)
			} else {
				client_main(&io, *opts, &argv)
			}
		}
	};
	if io.cancel.load(Ordering::Relaxed) { RERR_SIGNAL } else { code }
}

/// A logger for diagnostics before the run's own logger exists.
fn startup_logger(io: &HostIo, am_server: bool) -> Logger {
	let cfg = LogConfig {
		am_server,
		human_readable: 1,
		time_zone: Some(io.tz.clone()),
		..LogConfig::default()
	};
	let role = if am_server { Role::Server } else { Role::Client };
	Logger::local(Box::new(io.out.clone()), Box::new(io.err.clone()), cfg).with_role(role)
}

fn log_config(io: &HostIo, opts: &Options, am_server: bool, local_server: bool) -> LogConfig {
	LogConfig {
		levels: opts.levels.clone(),
		out_format: opts.stdout_format.clone(),
		log_file: opts.logfile_name.as_deref().map(|p| io.resolve(p)),
		log_file_format: opts.logfile_format.clone(),
		human_readable: u8::try_from(opts.human_readable).unwrap_or(u8::MAX),
		eight_bit_output: opts.allow_8bit_chars,
		stderr_mode: opts.stderr_mode(),
		am_server,
		quiet: opts.quiet > 0,
		module: None,
		host: None,
		addr: None,
		user: None,
		module_path: None,
		itemize_changes: u8::try_from(opts.itemize_changes).unwrap_or(u8::MAX),
		dry_run: opts.dry_run,
		local_server,
		preserve_mtimes: opts.preserve_mtimes,
		receiver_symlink_times: true,
		preserve_uid: opts.preserve_uid,
		preserve_gid: opts.preserve_gid,
		always_checksum: opts.always_checksum,
		time_zone: Some(io.tz.clone()),
	}
}

fn daemon_refusal(logger: &Logger, line: u32) -> i32 {
	let err = RsyncError::new(RERR_UNSUPPORTED, "rsync: --daemon is not supported by this rsync")
		.at("main.c", line);
	report(logger, &err);
	logger.finish(err.code, err.site, &Stats::default(), false);
	err.code
}

/// Upstream's exit_cleanup folding of the io_error bits and xfer errors into a
/// zero exit code.
fn fold_exit(code: i32, io_error: i32, got_xfer_error: bool) -> i32 {
	if code != 0 {
		return code;
	}
	let mut code = 0;
	if io_error & IOERR_DEL_LIMIT != 0 {
		code = crate::rsync::exit::RERR_DEL_LIMIT;
	}
	if io_error & IOERR_VANISHED != 0 {
		code = RERR_VANISHED;
	}
	if io_error & IOERR_GENERAL != 0 || got_xfer_error {
		code = crate::rsync::exit::RERR_PARTIAL;
	}
	code
}

// ---------------------------------------------------------------------------
// Failure bookkeeping and peer-message routing

/// The first failure of a side.
struct Failure {
	err: RsyncError,
	role: Role,
	/// The peer ended the run (MSG_ERROR_EXIT): no trailer of our own.
	from_peer: bool,
}

/// State one side's threads and its `on_msg` hook share.
struct Shared {
	logger: Logger,
	writer: Mutex<Option<MuxWriter>>,
	proto: Proto,
	am_sender: bool,
	list_only: bool,
	io_error: Arc<AtomicI32>,
	abort: Arc<AtomicBool>,
	first: Mutex<Option<Failure>>,
	shutting_down: AtomicBool,
	sib: Mutex<Option<Arc<SibOut>>>,
	to_sender: Mutex<Option<flume::Sender<Msg>>>,
	flists: Mutex<Option<Arc<Flists>>>,
	first_message: AtomicBool,
	iconv: Option<Arc<iconv::Iconv>>,
	io_timeout: AtomicI32,
	/// The side's counters (the sender stores the peer's MSG_BLOCK_STATS here).
	stats: Arc<Mutex<Stats>>,
	/// The host's cancellation: failures it causes are not reported (the run
	/// ends with the signal trailer alone, as upstream's sig_int exit).
	host_cancel: Arc<AtomicBool>,
}

impl Shared {
	fn writer(&self) -> Option<MuxWriter> {
		lock(&self.writer).clone()
	}

	/// Records a failure (the first one wins), prints its diagnostic, and stops
	/// the side's other threads. The peer learns the exit code from the exit
	/// tail ([`exit_tail`]), after the trailer, as upstream's exit_cleanup does.
	fn fail(&self, err: RsyncError, role: Role) {
		let code = err.code;
		let mut first = lock(&self.first);
		if first.is_none() {
			if !self.host_cancel.load(Ordering::Relaxed) {
				report(&self.logger.with_role(role), &err);
			}
			*first = Some(Failure { err, role, from_peer: false });
		}
		drop(first);
		self.abort.store(true, Ordering::Relaxed);
		if let Some(sib) = lock(&self.sib).as_ref() {
			sib.send_now(Sibling::ErrorExit(code));
		}
	}

	fn failed(&self) -> bool {
		lock(&self.first).is_some()
	}

	/// Upstream `read_a_msg` for everything but MSG_DATA.
	fn handle_msg(&self, msg: Msg) -> io::Result<()> {
		let int = || -> i32 {
			msg.payload.first_chunk().map_or(0, |&b| i32::from_le_bytes(b))
		};
		match msg.code {
			code if LogCode::from_u8(code).is_some() => {
				let Some(log_code) = LogCode::from_u8(code) else { return Ok(()) };
				if self.first_message.swap(false, Ordering::Relaxed)
					&& self.list_only
					&& !self.am_sender
					&& code == MSG_ERROR_XFER
				{
					check_for_d_option_error(&self.logger, &msg.payload);
				}
				self.logger.from_peer(log_code, &msg.payload);
			}
			MSG_IO_ERROR => {
				self.io_error.fetch_or(int() & IOERR_VALID_MASK, Ordering::Relaxed);
			}
			MSG_IO_TIMEOUT => {
				let val = int();
				if (1..=86400).contains(&val) {
					let current = self.io_timeout.load(Ordering::Relaxed);
					if current == 0 || current > val {
						handshake::io_timeout_notice(&self.logger, val);
						self.io_timeout.store(val, Ordering::Relaxed);
						if let Some(w) = self.writer() {
							w.set_timeout(Some(Duration::from_secs(val as u64)));
						}
					}
				}
			}
			MSG_NOOP => {
				if self.am_sender
					&& let Some(w) = self.writer()
				{
					w.maybe_keepalive(MSK_ALLOW_FLUSH)?;
				}
			}
			MSG_DELETED => {
				let name = match &self.iconv {
					Some(ic) => {
						let (body, dir) = match msg.payload.strip_suffix(b"\0") {
							Some(body) => (body, true),
							None => (&msg.payload[..], false),
						};
						let mut conv = ic.from_wire(body).unwrap_or_else(|_| body.to_vec());
						if dir {
							conv.push(0);
						}
						conv
					}
					None => msg.payload.clone(),
				};
				self.logger.from_peer_deleted(&name);
			}
			MSG_BLOCK_STATS => {
				if self.am_sender
					&& let Some(&bytes) = msg.payload.as_array::<8>()
				{
					lock(&self.stats).touched_blocks_4k = i64::from_le_bytes(bytes);
				}
			}
			MSG_SUCCESS | MSG_NO_SEND if self.am_sender => {
				if let Some(tx) = lock(&self.to_sender).as_ref() {
					let _ = tx.send(msg);
				}
			}
			MSG_NO_SEND => {
				let wire = int();
				let ndx = lock(&self.flists).as_ref().map_or(wire, |f| f.from_wire(wire));
				// The receiver forwards it to the generator (send_msg_int on its pipe).
				if let Some(sib) = lock(&self.sib).as_ref() {
					sib.msg(Sibling::NoSend(ndx));
				}
			}
			MSG_ERROR_EXIT => self.peer_error_exit(&msg.payload),
			_ => {}
		}
		Ok(())
	}

	/// MSG_ERROR_EXIT from the peer: echo it per protocol and role, then end the
	/// side with the peer's code and no trailer of our own. The reader keeps
	/// working so the exit tail can still drain the connection.
	fn peer_error_exit(&self, payload: &[u8]) {
		let val = payload.first_chunk().map_or(0, |&b| i32::from_le_bytes(b));
		if payload.len() == 4
			&& self.proto.version >= 31
			&& let Some(w) = self.writer()
		{
			// A failure to deliver the echo goes unreported: upstream only queues
			// it and exits without flushing after a peer's MSG_ERROR_EXIT.
			let echo: &[u8] = if self.am_sender { &[] } else { &payload[..4] };
			let mut w = w;
			let _ = w.send_msg(MSG_ERROR_EXIT, echo).and_then(|()| w.flush());
		}
		{
			// The peer's exit also explains a connection failure this side ran
			// into first (its writes meeting the closing peer): upstream reads
			// the message while it writes and never reports that failure.
			let mut first = lock(&self.first);
			let superseded = first
				.as_ref()
				.is_none_or(|f| !f.from_peer && matches!(f.err.code, RERR_STREAMIO | RERR_SOCKETIO));
			if superseded {
				*first = Some(Failure { err: RsyncError::bare(val), role: self.logger.role(), from_peer: true });
			}
		}
		self.abort.store(true, Ordering::Relaxed);
		if let Some(sib) = lock(&self.sib).as_ref() {
			sib.send_now(Sibling::ErrorExit(val));
		}
	}

	fn on_msg(self: &Arc<Self>) -> Box<dyn FnMut(Msg) -> io::Result<()> + Send> {
		let shared = Arc::clone(self);
		Box::new(move |msg| shared.handle_msg(msg))
	}
}

/// upstream `check_for_d_option_error`: a pre-2.6.4 server rejecting `-d`.
fn check_for_d_option_error(logger: &Logger, msg: &[u8]) {
	const PREFIX: &[u8] = b"rsync: on remote machine: -";
	const SUFFIX: &[u8] = b": unknown option";
	const OLD_OPTS: &[u8] = b"BCDHIKLPRSTWabceghlnopqrtuvxz";
	let Some(rest) = msg.strip_prefix(PREFIX) else { return };
	if rest.first() == Some(&b'-') {
		return;
	}
	let Some(colon) = rest.iter().position(|&b| b == b':') else { return };
	if !rest[colon..].starts_with(SUFFIX) {
		return;
	}
	let mut saw_d = false;
	for &c in &rest[..colon] {
		if c == b'd' {
			saw_d = true;
		} else if c == b'e' {
			break;
		} else if !OLD_OPTS.contains(&c) {
			return;
		}
	}
	if saw_d {
		logger.rprintf(LogCode::Warning, b"*** Try using \"--old-d\" if remote rsync is <= 2.6.3 ***\n");
	}
}

// ---------------------------------------------------------------------------
// Filters

/// The `--delete-excluded` argv position, as a count of filter options before it
/// (so the rules parsed before it keep no side, like upstream's in-order parse).
fn delete_excluded_position(argv: &[OsString], total: usize) -> usize {
	let mut count = 0usize;
	let mut i = 1;
	while i < argv.len() {
		let arg = os_bytes_lossy(&argv[i]);
		let arg: &[u8] = &arg;
		if arg == b"--" {
			break;
		}
		if arg == b"--delete-excluded" {
			return count.min(total);
		}
		if let Some(long) = arg.strip_prefix(b"--") {
			let (name, has_value) = match long.iter().position(|&b| b == b'=') {
				Some(eq) => (&long[..eq], true),
				None => (long, false),
			};
			if matches!(name, b"filter" | b"exclude" | b"include" | b"exclude-from" | b"include-from") {
				count += 1;
				if !has_value {
					i += 1;
				}
			} else if !has_value && long_takes_value(name) {
				i += 1;
			}
		} else if arg.len() > 1 && arg[0] == b'-' {
			for (k, &c) in arg.iter().enumerate().skip(1) {
				match c {
					b'F' => count += 1,
					b'f' => {
						count += 1;
						if k + 1 == arg.len() {
							i += 1;
						}
						break;
					}
					b'e' | b'B' | b'T' | b'M' | b'@' => {
						if k + 1 == arg.len() {
							i += 1;
						}
						break;
					}
					_ => {}
				}
			}
		}
		i += 1;
	}
	total
}

/// Long options whose value may be the next argv word.
fn long_takes_value(name: &[u8]) -> bool {
	const WITH_VALUE: &[&[u8]] = &[
		b"rsh", b"rsync-path", b"temp-dir", b"compare-dest", b"copy-dest", b"link-dest", b"backup-dir",
		b"suffix", b"chmod", b"chown", b"usermap", b"groupmap", b"files-from", b"out-format",
		b"log-file", b"log-file-format", b"partial-dir", b"timeout", b"contimeout", b"bwlimit",
		b"block-size", b"max-delete", b"max-size", b"min-size", b"max-alloc", b"modify-window",
		b"compress-level", b"compress-choice", b"checksum-choice", b"skip-compress", b"password-file",
		b"early-input", b"port", b"sockopts", b"address", b"protocol", b"iconv", b"checksum-seed",
		b"info", b"debug", b"stderr", b"outbuf", b"write-batch", b"only-write-batch", b"read-batch",
		b"remote-option", b"copy-as", b"stop-after", b"stop-at", b"confine-root", b"config",
		b"dparam", b"compress-threads", b"time-limit",
	];
	WITH_VALUE.contains(&name)
}

fn filter_config(io: &HostIo, opts: &Options, am_sender: bool, am_server: bool, local_server: bool, logger: &Logger, role: Role) -> FilterConfig {
	let fs = io.fs.clone();
	let paths = io.paths.clone();
	let insecure = opts.insecure_links;
	let read_file: FileReader = Arc::new(move |p: &[u8]| {
		let path = paths.resolve(bytes_os_lossy(p));
		let mut f = paths::open_operator_file(&fs, &path, insecure)?;
		let mut buf = Vec::new();
		f.read_to_end(&mut buf)?;
		Ok(buf)
	});
	FilterConfig {
		from0: opts.eol_nulls,
		delete_excluded: false,
		delete_mode: opts.delete_mode,
		prune_empty_dirs: opts.prune_empty_dirs,
		cvs_exclude: opts.cvs_exclude,
		am_sender,
		am_server,
		local_server,
		protocol: u32::try_from(opts.protocol_version).unwrap_or(0),
		home: io.getenv("HOME").map(String::into_bytes),
		cvsignore_env: io.getenv("CVSIGNORE").map(String::into_bytes),
		role,
		logger: Some(logger.clone()),
		read_file: Some(read_file),
	}
}

/// The operator's filter rules in command-line order.
fn client_filters(io: &HostIo, opts: &Options, argv: &[OsString], cfg: FilterConfig) -> Result<Filters, RsyncError> {
	let mut filters = Filters::new(cfg);
	let fs = io.fs.clone();
	let stdin = io.stdin.clone();
	let insecure = opts.insecure_links;
	let paths = io.paths.clone();
	let files = move |p: &Path| -> io::Result<Vec<u8>> {
		let mut buf = Vec::new();
		if p.as_os_str() == "-" {
			stdin.clone().read_to_end(&mut buf)?;
			return Ok(buf);
		}
		// --include-from/--exclude-from files are not confined by --confine-root
		// (rsync 3.5.1 reads one outside DIR).
		let path = paths.resolve(p);
		paths::open_operator_file(&fs, &path, insecure)?.read_to_end(&mut buf)?;
		Ok(buf)
	};
	let split = if opts.delete_excluded {
		delete_excluded_position(argv, opts.filter_rules.len())
	} else {
		opts.filter_rules.len()
	};
	for (i, rule) in opts.filter_rules.iter().enumerate() {
		if i == split {
			filters.set_delete_excluded(true);
		}
		filters.add(rule.rule_arg(), &files)?;
	}
	if opts.delete_excluded {
		filters.set_delete_excluded(true);
	}
	if opts.cvs_exclude {
		filters.add(RuleArg::Cvs, &files)?;
	}
	Ok(filters)
}

/// The partial-dir rule setup_protocol adds (`--partial-dir` relative and not a remote server).
fn add_partial_dir_rule(filters: &mut Filters, opts: &Options, am_sender: bool, proto: u32) -> Result<(), RsyncError> {
	let Some(dir) = opts.partial_dir.as_deref() else { return Ok(()) };
	let dir = os_bytes_lossy(dir).into_owned();
	if dir.first() == Some(&b'/') {
		return Ok(());
	}
	let mut rule = if !am_sender || proto >= 30 { b"-p ".to_vec() } else { b"- ".to_vec() };
	rule.extend_from_slice(&dir);
	if !rule.ends_with(b"/") {
		rule.push(b'/');
	}
	filters.add(RuleArg::Filter(&rule), &no_files)
}

/// A file reader for rule sources that never name files.
fn no_files(_: &Path) -> io::Result<Vec<u8>> {
	Err(io::ErrorKind::NotFound.into())
}

// ---------------------------------------------------------------------------
// --copy-as

/// upstream `become_copy_as_user`. The builtin shares its process with the shell,
/// so the identity switch itself is refused rather than performed; non-root users
/// get the failure the kernel would report to upstream.
fn become_copy_as_user(opts: &Options, logger: &Logger) -> Result<(), RsyncError> {
	let Some(spec) = opts.copy_as.as_deref() else { return Ok(()) };
	let spec = os_bytes_lossy(spec).into_owned();
	if logger.levels().debug(log::Debug::Cmd) >= 2 {
		let line = format!("[{}] copy_as={}\n", logger.role().name(), String::from_utf8_lossy(&spec));
		logger.rprintf(LogCode::Info, line.as_bytes());
	}
	let (user, group) = match spec.iter().position(|&b| b == b':') {
		Some(colon) => (&spec[..colon], Some(&spec[colon + 1..])),
		None => (&spec[..], None),
	};
	let syntax = |text: String, line: u32| RsyncError::new(RERR_SYNTAX, text).at("main.c", line);
	fn numeric(s: &[u8]) -> Option<u32> {
		if s.is_empty() || !s.iter().all(u8::is_ascii_digit) {
			return None;
		}
		std::str::from_utf8(s).ok()?.parse().ok()
	}
	let Some(uid) = numeric(user).or_else(|| crate::rsync::ids::name_uid(user)) else {
		return Err(syntax(format!("Invalid copy-as user: {}", String::from_utf8_lossy(user)), 270));
	};
	let gid = match group {
		Some(g) => match numeric(g).or_else(|| crate::rsync::ids::name_gid(g)) {
			Some(gid) => gid,
			None => return Err(syntax(format!("Invalid copy-as group: {}", String::from_utf8_lossy(g)), 276)),
		},
		None => primary_gid(uid).map_err(|e| syntax(syserr_text(logger.role(), &e, "getpwuid failed"), 282))?,
	};
	switch_identity(uid, gid, logger)
}

#[cfg(unix)]
fn primary_gid(uid: u32) -> io::Result<u32> {
	match nix::unistd::User::from_uid(nix::unistd::Uid::from_raw(uid)) {
		Ok(Some(user)) => Ok(user.gid.as_raw()),
		Ok(None) => Err(io::Error::from_raw_os_error(libc::ENOENT)),
		Err(errno) => Err(io::Error::from_raw_os_error(errno as i32)),
	}
}

#[cfg(not(unix))]
fn primary_gid(_uid: u32) -> io::Result<u32> {
	Err(io::ErrorKind::NotFound.into())
}

#[cfg(unix)]
fn switch_identity(uid: u32, gid: u32, logger: &Logger) -> Result<(), RsyncError> {
	let eperm = io::Error::from_raw_os_error(libc::EPERM);
	let fail = |what: &str, line: u32| {
		Err(RsyncError::new(RERR_SYNTAX, syserr_text(logger.role(), &eperm, what)).at("main.c", line))
	};
	let my_uid = rustix::process::getuid().as_raw();
	let my_gid = rustix::process::getgid().as_raw();
	if my_uid != 0 {
		if gid != my_gid {
			return fail("setgid failed", 289);
		}
		return fail("setgroups failed", 294);
	}
	if uid == my_uid && gid == my_gid {
		return Ok(());
	}
	Err(RsyncError::new(
		RERR_UNSUPPORTED,
		"rsync: --copy-as cannot change the identity of the shell process running this builtin",
	)
	.at("main.c", 289))
}

#[cfg(not(unix))]
fn switch_identity(_uid: u32, _gid: u32, _logger: &Logger) -> Result<(), RsyncError> {
	Ok(())
}

// ---------------------------------------------------------------------------
// Connections

/// The streams of one side, before protocol setup.
struct Streams {
	reader: MuxReader,
	writer: MuxWriter,
	counters: IoCounters,
}

fn make_streams(
	conn_reader: Box<dyn Read + Send>,
	conn_writer: Box<dyn Write + Send>,
	probe: Option<ReadProbe>,
	abort: &Arc<AtomicBool>,
	opts: &Options,
) -> Streams {
	let counters = IoCounters::default();
	let timeout = (opts.io_timeout > 0).then(|| Duration::from_secs(opts.io_timeout as u64));
	let wcfg = WriteConfig {
		bwlimit: (opts.bwlimit > 0).then(|| opts.bwlimit as u64),
		timeout,
		cancel: Some(Arc::clone(abort)),
	};
	let writer = MuxWriter::new(conn_writer, counters.clone(), wcfg);
	let mut reader = MuxReader::new(conn_reader, counters.clone(), Arc::clone(abort), ReadConfig { timeout });
	reader.set_probe(probe);
	reader.link_writer(writer.clone());
	reader.set_counting(false);
	writer.set_counting(false);
	Streams { reader, writer, counters }
}

/// The client's open `--files-from` source (local file or stdin).
fn open_files_from(io: &HostIo, opts: &Options) -> Result<Option<Box<dyn Read + Send>>, RsyncError> {
	match opts.filesfrom_fd {
		FilesFromFd::None => Ok(None),
		FilesFromFd::Stdin => Ok(Some(Box::new(io.stdin.clone()))),
		FilesFromFd::File => {
			let name = opts.files_from.clone().unwrap_or_default();
			// The list file itself is not confined by --confine-root; the names it
			// selects are (scan.rs).
			let path = io.resolve(&name);
			match paths::open_operator_file(&io.fs, &path, opts.insecure_links) {
				Ok(f) => Ok(Some(Box::new(io::BufReader::new(f)))),
				Err(err) => Err(options::files_from_open_error(&name, &err)),
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Client

fn client_main(io: &HostIo, mut opts: Options, argv: &[OsString]) -> i32 {
	// After option parsing upstream's who_am_i() says "Receiver" until the
	// client knows it sends; a --files-from open failure is part of parsing.
	let logger = Logger::local(Box::new(io.out.clone()), Box::new(io.err.clone()), log_config(io, &opts, false, false))
		.with_role(Role::PreReceiver);
	let fail = |err: RsyncError, role: Role| {
		let logger = logger.with_role(role);
		report(&logger, &err);
		logger.finish(err.code, err.site, &Stats::default(), false);
		err.code
	};
	let files_from = match open_files_from(io, &opts) {
		Ok(f) => f,
		Err(err) => return fail(err, Role::Client),
	};
	if opts.am_daemon {
		return daemon_refusal(&logger, 1954);
	}
	let inputs = match client_inputs(io, &mut opts, files_from) {
		Ok(inputs) => inputs,
		Err(err) => return fail(err, Role::PreReceiver),
	};
	// The transfer logger knows whether both halves run here (itemize rules).
	let local = inputs.ops.remote.is_none();
	let role = if inputs.ops.remote_is_sender { Role::PreReceiver } else { Role::Sender };
	let logger = Logger::local(Box::new(io.out.clone()), Box::new(io.err.clone()), log_config(io, &opts, false, local))
		.with_role(role);
	if opts.logfile_name.is_some() {
		logger.open_log_file(&io.fs, opts.insecure_links);
	}
	for notice in &opts.notices {
		logger.rprintf(LogCode::Info, format!("{notice}\n").as_bytes());
	}
	match client_start(io, opts, argv, &logger, inputs) {
		Ok(code) => code,
		// A connection cut short by cancellation ends like upstream's signal exit.
		Err(_) if io.host_cancel.load(Ordering::Relaxed) => {
			let err = RsyncError::cancelled();
			logger.finish(err.code, err.site, &Stats::default(), false);
			err.code
		}
		Err(err) => {
			report(&logger, &err);
			logger.finish(err.code, err.site, &Stats::default(), false);
			err.code
		}
	}
}

/// What the client opens before connecting: `--files-from`, the batch files,
/// and the operand split.
struct ClientInputs {
	files_from: Option<Box<dyn Read + Send>>,
	batch: Option<BatchFiles>,
	ops: Operands,
}

fn client_inputs(
	io: &HostIo,
	opts: &mut Options,
	files_from: Option<Box<dyn Read + Send>>,
) -> Result<ClientInputs, RsyncError> {
	let batch = if opts.write_batch != 0 || opts.read_batch {
		let stdin = io.stdin.clone();
		let mut take = move || -> Box<dyn Read + Send> { Box::new(stdin.clone()) };
		let resolve = |p: &Path| io.paths.resolve(p);
		Some(batch::open_batch_files(opts, &io.fs, &io.cwd, &resolve, &mut take)?)
	} else {
		None
	};
	if opts.write_batch < 0 {
		opts.dry_run = true;
	}
	let vfs = |p: &OsStr| io.is_local_vfs(p);
	let ff_host = opts.filesfrom_host.as_deref().map(|h| h.to_string_lossy().into_owned());
	let ocfg = OperandConfig {
		port: opts.rsync_port,
		shell_cmd: opts.shell_cmd.is_some(),
		old_args: opts.old_style_args > 0,
		read_batch: opts.read_batch,
		files_from_host: ff_host.as_deref(),
		password_file: opts.password_file.is_some(),
		connect_timeout: opts.connect_timeout > 0,
	};
	let ops = operands::parse_operands(&opts.args, &vfs, &ocfg)?;
	Ok(ClientInputs { files_from, batch, ops })
}

/// What reaches the peer: the connection plus how its exit is collected.
enum PeerKind {
	/// The in-process server half; its exit status arrives on the join.
	/// `kill` stops it (upstream's SIGUSR1 to the local child).
	Local { handle: Option<thread::JoinHandle<i32>>, kill: Arc<AtomicBool> },
	/// A remote shell / connect program (reaped by `Connection::finish`).
	Child(Option<Connection>),
	/// TCP daemon or batch file: nothing to wait for.
	None,
}

impl PeerKind {
	/// The peer's exit status as upstream folds it in: after a clean run it is
	/// waited for (wait_process_with_flush); after a failure only a remote
	/// child that already exited counts (cleanup_child_pid, WNOHANG).
	fn status(&mut self, failed: bool) -> i32 {
		match self {
			Self::Local { handle, .. } if !failed => {
				handle.take().map_or(0, |h| h.join().unwrap_or(crate::rsync::exit::RERR_CRASHED))
			}
			Self::Child(conn) if !failed => {
				conn.take().map_or(0, |c| c.finish().map_or_else(|e| e.code, |()| 0))
			}
			Self::Child(Some(conn)) => conn.child_exit_code().unwrap_or(0),
			_ => 0,
		}
	}

	/// Waits for the in-process server half to end and returns its status;
	/// None for other peers or when it was already collected.
	fn join_local(&mut self) -> Option<i32> {
		match self {
			Self::Local { handle, .. } => {
				handle.take().map(|h| h.join().unwrap_or(crate::rsync::exit::RERR_CRASHED))
			}
			_ => None,
		}
	}

	/// Stops a peer that is still running (upstream kill_all(SIGUSR1)) and
	/// reaps it. Idempotent; also runs on drop, so no exit path leaves the
	/// in-process half waiting to be stopped.
	fn stop(&mut self) {
		match self {
			Self::Local { handle, kill } => {
				kill.store(true, Ordering::Relaxed);
				if let Some(h) = handle.take() {
					let _ = h.join();
				}
			}
			// Dropping the guard kills and reaps a child that still runs.
			Self::Child(conn) => drop(conn.take()),
			Self::None => {}
		}
	}
}

impl Drop for PeerKind {
	fn drop(&mut self) {
		self.stop();
	}
}

/// upstream `start_client`: operands, connection, then the transfer.
fn client_start(
	io: &HostIo,
	mut opts: Options,
	argv: &[OsString],
	logger: &Logger,
	inputs: ClientInputs,
) -> Result<i32, RsyncError> {
	let ClientInputs { files_from, batch, ops } = inputs;
	let am_sender = !ops.remote_is_sender;
	let local_server = ops.remote.is_none();
	let daemon_connection = matches!(ops.remote, Some(Remote::Daemon { .. }));
	if local_server {
		opts.old_style_args = 2;
		opts.trust_sender_args = true;
		opts.trust_sender_filter = true;
		if !opts.read_batch && opts.whole_file < 0 && opts.write_batch == 0 {
			opts.whole_file = 1;
		}
	}
	opts.am_sender = am_sender;

	// Implied includes for what a pulling client asked for.
	let implied = (!am_sender && !opts.trust_sender_args).then(|| {
		let mut list = ImpliedFilters::new(opts.relative_paths > 0, opts.recurse > 0, opts.xfer_dirs > 0);
		list.set_logger(Some(logger.clone()), Role::PreReceiver);
		for (i, src) in ops.sources.iter().enumerate() {
			if i == 0 && opts.filesfrom_fd != FilesFromFd::None {
				continue;
			}
			list.add(&os_bytes_lossy(src), daemon_connection);
		}
		Arc::new(Mutex::new(list))
	});

	let abort = Arc::new(AtomicBool::new(false));
	// Stops the in-process server half of a local copy.
	let kill = Arc::new(AtomicBool::new(false));
	let shared_slot: Arc<Mutex<Option<Arc<Shared>>>> = Arc::default();
	// Cancellation stops this side; the server half of a local copy is stopped
	// by the client afterwards (PeerKind::stop), as upstream's parent signals
	// its child once it has reported its own exit.
	let _watch = Watch::start(
		Arc::clone(&io.cancel),
		vec![Arc::clone(&abort)],
		opts.stop_at_utime,
		Arc::clone(&shared_slot),
	);
	let cfg = filter_config(io, &opts, am_sender, false, local_server, logger, logger.role());
	let filters = client_filters(io, &opts, argv, cfg)?;

	let mut remote_protocol = None;
	let mut batch_gen: Option<Box<dyn Read + Send>> = None;
	let mut batch_flags = None;
	let mut batch_writer = None;
	let (conn_reader, conn_writer, probe, peer): (Box<dyn Read + Send>, Box<dyn Write + Send>, Option<ReadProbe>, PeerKind) =
		match (&ops.remote, batch) {
			(None, Some(BatchFiles::Read { data, flags })) => {
				batch_flags = Some(flags);
				let (gen_out, gen_in) = transport::local_pair(Arc::clone(&abort));
				batch_gen = Some(gen_in.reader);
				(data, gen_out.writer, None, PeerKind::None)
			}
			(None, other) => {
				if let Some(BatchFiles::Write { data, script }) = other {
					batch_writer = Some((data, script));
				}
				let (client, server) = transport::local_pair(Arc::clone(&kill));
				let getenv = |k: &str| io.getenv(k);
				let mut sopts = options::local_server_options(&opts, &getenv)?;
				sopts.args = vec![OsString::from(".")];
				sopts.args.push(ops.dest.clone().unwrap_or_else(|| OsString::from(".")));
				sopts.old_style_args = 2;
				// The local half inherits its arguments; nothing travels secluded.
				if sopts.protect_args > 0 {
					sopts.protect_args = 2;
				}
				let info = handshake::local_client_info(&opts, false);
				let mut sfilters = filters.clone();
				sfilters.set_am_sender(false);
				sfilters.set_role(Role::Server);
				let mut sio = io.clone();
				sio.cancel = Arc::clone(&kill);
				let handle = thread::Builder::new()
					.name("rsync-local-server".into())
					.spawn(move || server_main(&sio, sopts, Some(LocalServer { conn: server, client_info: info, filters: sfilters })))
					.map_err(|e| RsyncError::new(crate::rsync::exit::RERR_IPC, syserr_text(Role::Client, &e, "fork")).at("pipe.c", 112))?;
				(client.reader, client.writer, client.probe, PeerKind::Local { handle: Some(handle), kill: Arc::clone(&kill) })
			}
			(Some(remote), other) => {
				if let Some(BatchFiles::Write { data, script }) = other {
					batch_writer = Some((data, script));
				}
				let (mut conn, protocol) = connect_remote(io, &mut opts, &ops, remote, logger)?;
				let protocol = protocol.unwrap_or(0);
				if protocol < 0 {
					// The daemon ended the session (module listing).
					return Ok(0);
				}
				if protocol > 0 {
					remote_protocol = Some(protocol as u32);
				}
				let reader = std::mem::replace(&mut conn.reader, Box::new(io::empty()));
				let writer = std::mem::replace(&mut conn.writer, Box::new(io::sink()));
				let probe = conn.probe.take();
				let peer = if conn.child.is_some() { PeerKind::Child(Some(conn)) } else { PeerKind::None };
				(reader, writer, probe, peer)
			}
		};
	let streams = make_streams(conn_reader, conn_writer, probe, &abort, &opts);
	let end = ClientRun {
		io,
		opts,
		argv,
		logger,
		ops: &ops,
		am_sender,
		local_server,
		remote_protocol,
		batch_flags,
		batch_writer,
		batch_gen,
		files_from,
		filters,
		implied,
		abort,
		shared_slot,
		daemon_socket: daemon_connection && !ops.daemon_over_shell,
	}
	.run(streams, peer);
	Ok(end)
}

/// Connects to a remote shell or daemon. The second value is the daemon's
/// protocol (0 for a remote shell, -1 when the daemon ended the session).
fn connect_remote(
	io: &HostIo,
	opts: &mut Options,
	ops: &Operands,
	remote: &Remote,
	logger: &Logger,
) -> Result<(Connection, Option<i32>), RsyncError> {
	let remote_args = ops.remote_args();
	let getenv = |k: &str| io.getenv(k);
	let rsh = opts
		.shell_cmd
		.as_deref()
		.map(|s| s.to_string_lossy().into_owned())
		.or_else(|| io.getenv("RSYNC_RSH"))
		.unwrap_or_else(|| "ssh".to_string());
	let remote_is_sender = ops.remote_is_sender;
	let (sargs, cut) = options::server_args_split(opts, remote_is_sender);
	let secluded = opts.protect_args > 0;
	match remote {
		Remote::Shell { user, host } => {
			if host.starts_with('-') {
				return Err(RsyncError::new(RERR_SYNTAX, "Invalid remote host: hostnames may not start with '-'.")
					.at("main.c", 1638));
			}
			let cfg = ShellConfig {
				rsh: &rsh,
				user: user.as_deref(),
				host,
				remote_argv: &sargs,
				blocking_io: opts.blocking_io == Some(true),
				old_args: opts.old_style_args > 0,
				secluded_args: secluded,
				rsync_path: &opts.rsync_path,
				remote_is_sender,
				daemon: false,
				secluded_cut: cut,
				files: &remote_args,
				trust_sender_args: opts.trust_sender_args,
				relative_paths: opts.relative_paths > 0,
				af_hint: opts.af_hint,
				env: &[],
				logger,
			};
			Ok((transport::spawn_shell(&io.child, &cfg, Arc::clone(&io.cancel))?, None))
		}
		Remote::Daemon { user, host, .. } => {
			if remote_args.first().is_some_and(|a| os_bytes_lossy(a).first() == Some(&b'/')) && !ops.daemon_over_shell {
				return Err(RsyncError::new(RERR_STARTCLIENT, "ERROR: The remote path must start with a module name not a /")
					.at("main.c", 1981));
			}
			let contimeout = (opts.connect_timeout > 0).then(|| Duration::from_secs(opts.connect_timeout as u64));
			let mut conn = if ops.daemon_over_shell {
				if host.starts_with('-') {
					return Err(RsyncError::new(RERR_SYNTAX, "Invalid remote host: hostnames may not start with '-'.")
						.at("main.c", 1638));
				}
				let port_env = [("RSYNC_PORT".to_string(), ops.env_port.to_string())];
				let cfg = ShellConfig {
					rsh: &rsh,
					user: user.as_deref(),
					host,
					remote_argv: &[],
					blocking_io: opts.blocking_io == Some(true),
					old_args: opts.old_style_args > 0,
					secluded_args: false,
					rsync_path: &opts.rsync_path,
					remote_is_sender,
					daemon: true,
					secluded_cut: None,
					files: &[],
					trust_sender_args: opts.trust_sender_args,
					relative_paths: opts.relative_paths > 0,
					af_hint: opts.af_hint,
					env: &port_env,
					logger,
				};
				transport::spawn_shell(&io.child, &cfg, Arc::clone(&io.cancel))?
			} else {
				let bind = opts.bind_address.as_deref().map(|s| s.to_string_lossy().into_owned());
				let sockopts = opts.sockopts.as_deref().map(|s| s.to_string_lossy().into_owned());
				let tcfg = TcpConfig {
					host,
					port: ops.port,
					bind_address: bind.as_deref(),
					af_hint: opts.af_hint,
					sockopts: sockopts.as_deref(),
					connect_timeout: contimeout,
					getenv: &getenv,
					logger,
				};
				transport::connect_tcp(&tcfg, &io.child, Arc::clone(&io.cancel))?
			};
			let deadline = if ops.daemon_over_shell { contimeout.map(|t| Instant::now() + t) } else { None };
			let password = opts.password_file.as_deref().map(|p| io.resolve(p));
			let early = opts.early_input_file.as_deref().map(|p| io.resolve(p));
			let snapshot = opts.clone();
			let server_args = move |proto: u32| {
				let mut o = snapshot.clone();
				o.protocol_version = proto as i32;
				options::server_args_split(&o, remote_is_sender)
			};
			let stdin = io.stdin.clone();
			let read_line = move || -> io::Result<Vec<u8>> {
				let mut line = Vec::new();
				let mut r = stdin.clone();
				let mut b = [0u8; 1];
				while r.read(&mut b)? == 1 && b[0] != b'\n' {
					line.push(b[0]);
				}
				Ok(line)
			};
			let read_line: &dyn Fn() -> io::Result<Vec<u8>> = &read_line;
			let dcfg = DaemonConfig {
				user: user.as_deref(),
				args: &remote_args,
				server_args: &server_args,
				remote_is_sender,
				protocol: u32::try_from(opts.protocol_version).unwrap_or(0),
				old_args: opts.old_style_args > 0,
				output_motd: opts.output_motd,
				password_file: password.as_deref(),
				early_input: early.as_deref(),
				fs: &io.fs,
				insecure_operator_files: opts.insecure_links,
				getenv: &getenv,
				read_stdin_line: Some(read_line),
				connect_deadline: deadline,
				io_timeout: (opts.io_timeout > 0).then(|| Duration::from_secs(opts.io_timeout as u64)),
			};
			let session = daemon::daemon_handshake(&mut conn, &dcfg, logger)?;
			if session.exited {
				return Ok((conn, Some(-1)));
			}
			opts.protocol_version = session.protocol as i32;
			Ok((conn, Some(session.remote_protocol as i32)))
		}
	}
}

/// Inputs of a client transfer after the connection is up.
struct ClientRun<'a> {
	io: &'a HostIo,
	opts: Options,
	argv: &'a [OsString],
	logger: &'a Logger,
	ops: &'a Operands,
	am_sender: bool,
	local_server: bool,
	remote_protocol: Option<u32>,
	batch_flags: Option<i32>,
	batch_writer: Option<(SharedBatch, PathBuf)>,
	batch_gen: Option<Box<dyn Read + Send>>,
	files_from: Option<Box<dyn Read + Send>>,
	filters: Filters,
	implied: Option<Arc<Mutex<ImpliedFilters>>>,
	abort: Arc<AtomicBool>,
	shared_slot: Arc<Mutex<Option<Arc<Shared>>>>,
	/// A daemon over a TCP socket (upstream `daemon_connection < 0`).
	daemon_socket: bool,
}

/// A client failure before the transfer started: the diagnostic and trailer,
/// then the peer is stopped (upstream exit_cleanup with kill_all). When the
/// host cancelled the run, whatever the cancellation broke (a read failing, a
/// killed remote shell's EOF) ends as upstream's signal exit instead.
fn setup_failed(logger: &Logger, err: &RsyncError, streams: Streams, mut peer: PeerKind, cancelled: bool) -> i32 {
	drop(streams);
	if cancelled {
		peer.stop();
		let err = RsyncError::cancelled();
		logger.finish(err.code, err.site, &Stats::default(), false);
		return err.code;
	}
	report(logger, err);
	let code = err.code.max(peer.status(true));
	logger.finish(code, err.site, &Stats::default(), false);
	peer.stop();
	code
}

impl ClientRun<'_> {
	/// upstream `client_run` + the client's exit_cleanup.
	fn run(self, mut streams: Streams, mut peer: PeerKind) -> i32 {
		let start = Instant::now();
		let logger = self.logger.clone();
		let roles = Roles {
			am_server: false,
			am_sender: self.am_sender,
			local_server: self.local_server,
			read_batch: self.opts.read_batch,
			write_batch: self.opts.write_batch != 0,
		};
		let mut opts = self.opts;
		let getenv = |k: &str| self.io.getenv(k);
		let allow_inc = if self.local_server { opts.inc_recurse_allowed(b"") } else { opts.allow_inc_recurse };
		let setup = Setup {
			roles,
			client_info: b"",
			remote_protocol: self.remote_protocol,
			allow_inc_recurse: allow_inc,
			batch_flags: self.batch_flags,
			getenv: &getenv,
			logger: &logger,
		};
		// Diagnostics of the connection name this side (`connection unexpectedly
		// closed … [sender]`) from the version exchange on.
		streams.reader.set_role(logger.role());
		streams.writer.set_role(logger.role());
		let neg = {
			let Streams { reader, writer, .. } = &mut streams;
			let mut w = writer.clone();
			handshake::setup_protocol(&setup, &mut opts, reader, &mut w)
		};
		let neg = match neg {
			Ok(neg) => neg,
			Err(err) => {
				let cancelled = self.io.host_cancel.load(Ordering::Relaxed);
				return setup_failed(&logger, &err, streams, peer, cancelled);
			}
		};
		logger.set_protocol(neg.proto.version);
		logger.set_checksums(neg.xfer_sum, neg.file_sum);
		logger.set_receiver_symlink_times(neg.receiver_symlink_times);
		streams.reader.set_proto(neg.proto);
		streams.reader.set_server(false, self.local_server);

		let mut filters = self.filters;
		let mut setup_err = add_partial_dir_rule(&mut filters, &opts, self.am_sender, neg.proto.version).err();
		// The replay script is written before the rule exchange (-C rules excluded).
		if setup_err.is_none()
			&& let Some((_, script)) = &self.batch_writer
		{
			let vfs = |p: &OsStr| self.io.is_local_vfs(p);
			let mut raw = self.argv.to_vec();
			if let Some(first) = raw.first_mut() {
				*first = self.io.argv0.clone();
			}
			let text = batch::shell_script(&raw, &opts.args, &filters.script_lines(), opts.eol_nulls, neg.proto.version, &vfs);
			setup_err = match text {
				Ok(text) => batch::write_shell_file(&self.io.fs, script, &text, &opts.batch_name.clone().unwrap_or_default(), opts.insecure_links).err(),
				Err(e) => Some(e),
			};
		}
		let iconv = match (&opts.iconv_opt, setup_err.is_none()) {
			(Some(spec), true) => {
				let locale = iconv::locale_charset(&getenv);
				match iconv::Iconv::with_locale(&os_bytes_lossy(spec), false, Some(&locale)) {
					Ok(ic) => {
						if logger.levels().debug(log::Debug::Iconv) >= 1 {
							logger.rprintf(LogCode::Info, ic.debug_line(logger.role().name()).as_bytes());
						}
						Some(Arc::new(ic))
					}
					Err(e) => {
						setup_err = Some(e);
						None
					}
				}
			}
			_ => None,
		};
		if let Some(err) = setup_err {
			let cancelled = self.io.host_cancel.load(Ordering::Relaxed);
			return setup_failed(&logger, &err, streams, peer, cancelled);
		}

		let batch_shared = self.batch_writer.as_ref().map(|(data, _)| Arc::clone(data));
		let batch_only = (opts.write_batch < 0 && self.am_sender).then(|| batch_shared.clone()).flatten();
		let parts = self.io.parts(Arc::clone(&self.abort), streams.counters.clone());
		let role = if self.am_sender { Role::Sender } else { Role::PreReceiver };
		let opts = Arc::new(opts);
		let ctx = build_ctx(&parts, Arc::clone(&opts), &neg, logger.with_role(role), false, self.am_sender, self.local_server, iconv.clone(), batch_only);
		let shared = Arc::new(Shared {
			logger: logger.with_role(role),
			writer: Mutex::new(Some(streams.writer.clone())),
			proto: neg.proto,
			am_sender: self.am_sender,
			list_only: opts.list_only != 0,
			io_error: Arc::clone(&ctx.io_error),
			abort: Arc::clone(&self.abort),
			first: Mutex::new(None),
			shutting_down: AtomicBool::new(false),
			sib: Mutex::new(None),
			to_sender: Mutex::new(None),
			flists: Mutex::new(None),
			first_message: AtomicBool::new(true),
			iconv,
			io_timeout: AtomicI32::new(opts.io_timeout),
			stats: Arc::clone(&ctx.stats),
			host_cancel: Arc::clone(&self.io.host_cancel),
		});
		*lock(&self.shared_slot) = Some(Arc::clone(&shared));

		let side = SideRun {
			ctx,
			neg,
			shared: Arc::clone(&shared),
			filters,
			files_from: self.files_from,
			batch: batch_shared,
			batch_gen: self.batch_gen,
			implied: self.implied,
			sources: self.ops.sources.clone(),
			dest: self.ops.dest.clone(),
		};
		let mut outcome = side.run(streams);
		*lock(&self.shared_slot) = None;
		// A connection failure against the in-process server half: read what
		// the half still sent, which may be its MSG_ERROR_EXIT (upstream's
		// perform_io reads while its writes fail). The half closes its end
		// when it exits, so this ends at EOF.
		let connection_failure = || {
			lock(&shared.first).as_ref().is_some_and(|f| !f.from_peer && matches!(f.err.code, RERR_STREAMIO | RERR_SOCKETIO))
		};
		if connection_failure()
			&& matches!(peer, PeerKind::Local { .. })
			&& !self.io.host_cancel.load(Ordering::Relaxed)
		{
			if let Some(reader) = outcome.reader.as_mut() {
				shared.abort.store(false, Ordering::Relaxed);
				let mut buf = [0u8; 1024];
				while matches!(reader.read(&mut buf), Ok(n) if n > 0) {}
			}
			// Wherever the failure surfaced (a write blocked behind a full pipe,
			// the file list, a flush), the half that broke the connection is
			// what ended the run: its exit status stands and it has already
			// reported why (upstream's client exits on the child's
			// MSG_ERROR_EXIT without a trailer of its own). Its input is gone
			// now, so it cannot be blocked on us.
			drop(lock(&shared.writer).take());
			drop(outcome.reader.take());
			if connection_failure()
				&& let Some(status) = peer.join_local()
				&& status != 0
			{
				*lock(&shared.first) = Some(Failure {
					err: RsyncError::bare(status),
					role: outcome.role,
					from_peer: true,
				});
			}
		}
		let writer = lock(&shared.writer).take();

		if let Some(err) = logger.take_fatal() {
			shared.fail(err, outcome.role);
		}
		let failure = lock(&shared.first).take();
		let cancelled = self.io.host_cancel.load(Ordering::Relaxed);
		let failed = failure.is_some() || cancelled;
		// The peer's status (wait_process_with_flush / cleanup_child_pid).
		let status = peer.status(failed);
		let mut stats = lock(&outcome.ctx.stats).clone();
		if let Some(totals) = outcome.totals {
			stats.total_read = totals.0;
			stats.total_written = totals.1;
		}
		if !failed && outcome.summary {
			let elapsed = outcome.end.map(|end| end.saturating_duration_since(start));
			logger.with_role(outcome.role).output_summary(&stats, neg.proto.version, elapsed, opts.dry_run, opts.write_batch < 0);
		}
		// The log-file exit line (log_exit) reports the live counters, which
		// include the goodbye exchanged after handle_stats took its snapshot.
		let stats = live_totals(stats, &outcome.ctx.counters);
		let (code, role) = if cancelled {
			let err = RsyncError::cancelled();
			let role = failure.as_ref().map_or(outcome.role, |f| f.role);
			logger.with_role(role).finish(err.code, err.site, &stats, false);
			(err.code, role)
		} else {
			let base = failure.as_ref().map_or(0, |f| f.err.code).max(status);
			let io_error = outcome.ctx.io_error.load(Ordering::Relaxed);
			let code = fold_exit(base, io_error, logger.got_xfer_error());
			match &failure {
				Some(f) => {
					let site = if f.err.code == code { f.err.site } else { outcome.site };
					logger.with_role(f.role).finish(code, site, &stats, f.from_peer && f.err.code == code);
					(code, f.role)
				}
				None => {
					let site = Some(outcome.site.unwrap_or(("main.c", 1983)));
					logger.with_role(outcome.role).finish(code, site, &stats, false);
					(code, outcome.role)
				}
			}
		};
		if !cancelled {
			let tail = Tail {
				writer,
				reader: outcome.reader.take(),
				daemon_socket: self.daemon_socket,
				msgs2stderr: opts.msgs2stderr,
				io_timeout: opts.io_timeout,
			};
			exit_tail(&shared, tail, code, role, failure.as_ref().is_some_and(|f| f.from_peer));
		}
		peer.stop();
		code
	}
}

/// What the exit tail needs of a side's connection.
struct Tail {
	writer: Option<MuxWriter>,
	reader: Option<MuxReader>,
	/// Talking to a daemon over a TCP socket (upstream `daemon_connection < 0`).
	daemon_socket: bool,
	msgs2stderr: u8,
	io_timeout: i32,
}

/// upstream `_exit_cleanup`'s I/O after the trailer. For an error code (other
/// than the connection-level ones) before the run's goodbye, at protocol ≥ 31
/// or from the receiver: tell the peer the code (MSG_ERROR_EXIT, unless this
/// exit answers the peer's), flush unless sending, and — talking to a daemon
/// over a socket, or with `--no-msgs2stderr` — read until the peer closes
/// (noop_io_until_death). An OS-level failure of that I/O is reported once as
/// upstream's `write error` / `read error` line; the exit code stays.
fn exit_tail(shared: &Shared, tail: Tail, code: i32, role: Role, from_peer: bool) {
	let mut error = None;
	let quiet = code == 0 || matches!(code, RERR_SOCKETIO | RERR_STREAMIO | RERR_SIGNAL1 | RERR_TIMEOUT);
	let applies = !quiet
		&& !shared.shutting_down.load(Ordering::Relaxed)
		&& (shared.proto.version >= 31 || role == Role::Receiver);
	if applies && let Some(w) = &tail.writer {
		// Every engine thread has ended; the abort flag would only cancel the
		// tail's own writes and reads now.
		shared.abort.store(false, Ordering::Relaxed);
		let mut w = w.clone();
		if !from_peer
			&& error.is_none()
			&& let Err(e) = w.send_msg(MSG_ERROR_EXIT, &code.to_le_bytes())
		{
			error = socket_error_text(&e, role, "write error");
		}
		if !shared.am_sender
			&& error.is_none()
			&& let Err(e) = w.flush()
		{
			error = socket_error_text(&e, role, "write error");
		}
		if error.is_none()
			&& (tail.msgs2stderr == 0 || tail.daemon_socket)
			&& let Some(mut r) = tail.reader
		{
			if tail.io_timeout <= 0 {
				w.set_timeout(Some(Duration::from_secs(60)));
			}
			let mut buf = [0u8; 1024];
			loop {
				match r.read(&mut buf) {
					Ok(0) => break,
					Ok(_) => {}
					Err(e) => {
						error = socket_error_text(&e, role, "read error");
						break;
					}
				}
			}
		}
	}
	if let Some(text) = error {
		let mut line = text.into_bytes();
		line.push(b'\n');
		let logger = shared.logger.with_role(role);
		logger.rprintf(LogCode::ErrorSocket, &line);
		logger.flush();
	}
}

/// Upstream's `rsync: [role] write error: …` / `read error: …` line for an
/// OS-level connection failure; None for anything else (EOF, cancellation,
/// timeouts), which upstream's exit path does not report there.
fn socket_error_text(err: &io::Error, role: Role, what: &str) -> Option<String> {
	let mapped = RsyncError::from_io(err, RERR_SOCKETIO);
	match mapped.message {
		Some(message) if mapped.code == RERR_SOCKETIO => Some(message),
		None if err.raw_os_error().is_some() => Some(syserr_text(role, err, what)),
		_ => None,
	}
}

// ---------------------------------------------------------------------------
// Server

/// The server half of a local transfer.
struct LocalServer {
	conn: Connection,
	client_info: Vec<u8>,
	filters: Filters,
}

fn server_main(io: &HostIo, opts: Options, local: Option<LocalServer>) -> i32 {
	let startup = startup_logger(io, true);
	if opts.am_daemon {
		return daemon_refusal(&startup.with_role(Role::PreReceiver), 1975);
	}
	let abort = Arc::new(AtomicBool::new(false));
	let shared_slot: Arc<Mutex<Option<Arc<Shared>>>> = Arc::default();
	let _watch = Watch::start(
		Arc::clone(&io.cancel),
		vec![Arc::clone(&abort)],
		opts.stop_at_utime,
		Arc::clone(&shared_slot),
	);
	let local_server = local.is_some();
	let (conn_reader, conn_writer, probe, client_info, local_filters): (Box<dyn Read + Send>, Box<dyn Write + Send>, Option<ReadProbe>, Vec<u8>, Option<Filters>) =
		match local {
			Some(LocalServer { conn, client_info, filters }) => (conn.reader, conn.writer, conn.probe, client_info, Some(filters)),
			None => (Box::new(io.stdin.clone()), Box::new(io.stdout_raw.clone()), None, Vec::new(), None),
		};
	let mut streams = make_streams(conn_reader, conn_writer, probe, &abort, &opts);
	let mut opts = opts;
	if opts.secluded_pending() {
		let argv = match handshake::read_secluded_args(&mut streams.reader, &io.fs, &io.cwd, opts.max_alloc) {
			Ok(argv) => argv,
			Err(err) => {
				report(&startup, &err);
				startup.finish(err.code, err.site, &Stats::default(), false);
				return err.code;
			}
		};
		let getenv = |k: &str| io.getenv(k);
		match options::parse_secluded(opts, argv.get(1..).unwrap_or(&[]), &getenv) {
			Ok(Parsed::Run(o)) => opts = *o,
			Ok(_) => return 0,
			Err(err) => {
				report(&startup, &err);
				startup.finish(err.code, err.site, &Stats::default(), false);
				return err.code;
			}
		}
		if opts.args.is_empty() {
			let err = RsyncError::new(RERR_SYNTAX, usage::help_text().trim_end().to_string()).at("main.c", 1968);
			report(&startup, &err);
			startup.finish(err.code, err.site, &Stats::default(), false);
			return err.code;
		}
	}
	let client_info = if local_server { client_info } else { opts.client_info().into_owned() };

	let sink_writer: Arc<Mutex<Option<MuxWriter>>> = Arc::new(Mutex::new(Some(streams.writer.clone())));
	let sink: log::RemoteSink = {
		let w = Arc::clone(&sink_writer);
		Arc::new(move |code: LogCode, data: &[u8]| -> io::Result<()> {
			let Some(w) = lock(&w).clone() else { return Err(io::Error::other("closed")) };
			w.try_send_msg(code as u8, data)?.ok_or_else(|| io::Error::other("not multiplexed"))
		})
	};
	let base_logger = Logger::remote_with_stderr(sink, Box::new(io.err.clone()), log_config(io, &opts, true, local_server))
		.with_role(if opts.am_sender { Role::Sender } else { Role::PreReceiver });
	{
		let w = Arc::clone(&sink_writer);
		let deleted: log::DeletedSink = Arc::new(move |payload: &[u8]| match lock(&w).clone() {
			Some(w) => w.send_msg(MSG_DELETED, payload),
			None => Ok(()),
		});
		base_logger.set_deleted_sink(Some(deleted));
	}
	if opts.logfile_name.is_some() {
		base_logger.open_log_file(&io.fs, opts.insecure_links);
	}
	for notice in &opts.notices {
		base_logger.rprintf(LogCode::Info, format!("{notice}\n").as_bytes());
	}
	let logger = base_logger;

	let am_sender = opts.am_sender;
	let roles = Roles { am_server: true, am_sender, local_server, read_batch: false, write_batch: false };
	let getenv = |k: &str| io.getenv(k);
	let allow_inc = opts.inc_recurse_allowed(&client_info);
	let setup = Setup {
		roles,
		client_info: &client_info,
		remote_protocol: None,
		allow_inc_recurse: allow_inc,
		batch_flags: None,
		getenv: &getenv,
		logger: &logger,
	};
	streams.reader.set_role(logger.role());
	streams.writer.set_role(logger.role());
	let neg = {
		let mut w = streams.writer.clone();
		handshake::setup_protocol(&setup, &mut opts, &mut streams.reader, &mut w)
	};
	let neg = match neg {
		Ok(neg) => neg,
		Err(err) if local_server && err.code == RERR_PROTOCOL => {
			// The client fails the same protocol check, reports it, and stops
			// this half (upstream: SIGUSR1 to the local child). Closing the
			// connection first makes sure the client cannot wait on it.
			*lock(&sink_writer) = None;
			drop(streams);
			while !io.cancel.load(Ordering::Relaxed) {
				thread::sleep(Duration::from_millis(10));
			}
			return killed_exit(&logger, logger.role(), &Stats::default());
		}
		Err(err) => {
			report(&logger, &err);
			logger.finish(err.code, err.site, &Stats::default(), false);
			*lock(&sink_writer) = None;
			return err.code;
		}
	};
	logger.set_protocol(neg.proto.version);
	logger.set_checksums(neg.xfer_sum, neg.file_sum);
	logger.set_receiver_symlink_times(neg.receiver_symlink_times);
	streams.reader.set_proto(neg.proto);
	streams.reader.set_server(true, local_server);

	let role = if am_sender { Role::Sender } else { Role::PreReceiver };
	let mut filters = match local_filters {
		Some(f) => f,
		None => {
			let cfg = filter_config(io, &opts, am_sender, true, false, &logger, role);
			let mut f = Filters::new(cfg);
			f.set_delete_excluded(opts.delete_excluded);
			if opts.cvs_exclude {
				let _ = f.add(RuleArg::Cvs, &no_files);
			}
			f
		}
	};
	filters.set_logger(Some(logger.with_role(role)));
	let mut setup_err = if local_server {
		add_partial_dir_rule(&mut filters, &opts, am_sender, neg.proto.version).err()
	} else {
		None
	};
	let iconv = match (&opts.iconv_opt, setup_err.is_none()) {
		(Some(spec), true) => {
			let locale = iconv::locale_charset(&getenv);
			match iconv::Iconv::with_locale(&os_bytes_lossy(spec), true, Some(&locale)) {
				Ok(ic) => {
					if logger.levels().debug(log::Debug::Iconv) >= 1 {
						logger.rprintf(LogCode::Info, ic.debug_line(logger.role().name()).as_bytes());
					}
					Some(Arc::new(ic))
				}
				Err(e) => {
					setup_err = Some(e);
					None
				}
			}
		}
		_ => None,
	};
	if let Some(err) = setup_err {
		report(&logger, &err);
		logger.finish(err.code, err.site, &Stats::default(), false);
		*lock(&sink_writer) = None;
		return err.code;
	}

	// The transfer directory (argv[0]) and the remaining operands.
	let args = opts.args.clone();
	let mut parts = io.parts(Arc::clone(&abort), streams.counters.clone());
	let dir = args.first().cloned();
	let rest: Vec<OsString> = args.iter().skip(1).cloned().collect();
	let opts = Arc::new(opts);
	let ctx_logger = logger.with_role(role);
	if let Some(dir) = &dir
		&& (!am_sender || opts.relative_paths <= 0)
	{
		let path = io.resolve(dir);
		match io.fs.metadata(&path) {
			Ok(m) if m.is_dir() => parts.cwd = path,
			res => {
				let err = res.err().unwrap_or_else(|| io::Error::from_raw_os_error(20));
				let what = if am_sender { "change_dir#3" } else { "change_dir#4" };
				let name = String::from_utf8_lossy_owned(paths::full_fname(&io.cwd, &os_bytes_lossy(dir)));
				let line = if am_sender { 984 } else { 1216 };
				let err = RsyncError::new(crate::rsync::exit::RERR_FILESELECT, syserr_text(role, &err, &format!("{what} {name} failed")))
					.at("main.c", line);
				report(&ctx_logger, &err);
				logger.finish(err.code, err.site, &Stats::default(), false);
				*lock(&sink_writer) = None;
				return err.code;
			}
		}
	}
	let ctx = build_ctx(&parts, Arc::clone(&opts), &neg, ctx_logger.clone(), true, am_sender, local_server, iconv.clone(), None);
	let shared = Arc::new(Shared {
		logger: ctx_logger,
		writer: Mutex::new(Some(streams.writer.clone())),
		proto: neg.proto,
		am_sender,
		list_only: opts.list_only != 0,
		io_error: Arc::clone(&ctx.io_error),
		abort: Arc::clone(&abort),
		first: Mutex::new(None),
		shutting_down: AtomicBool::new(false),
		sib: Mutex::new(None),
		to_sender: Mutex::new(None),
		flists: Mutex::new(None),
		first_message: AtomicBool::new(true),
		iconv,
		io_timeout: AtomicI32::new(opts.io_timeout),
		stats: Arc::clone(&ctx.stats),
		host_cancel: Arc::clone(&io.host_cancel),
	});
	*lock(&shared_slot) = Some(Arc::clone(&shared));
	let files_from: Option<Box<dyn Read + Send>> = match opts.filesfrom_fd {
		FilesFromFd::File => match open_files_from(io, &opts) {
			Ok(f) => f,
			Err(err) => {
				shared.fail(err, role);
				None
			}
		},
		_ => None,
	};
	let implied = (!am_sender && !opts.trust_sender_args && files_from.is_some()).then(|| {
		Arc::new(Mutex::new(ImpliedFilters::new(opts.relative_paths > 0, opts.recurse > 0, opts.xfer_dirs > 0)))
	});
	let (sources, dest) = if am_sender {
		let mut sources = rest.clone();
		if sources.is_empty() && (opts.recurse > 0 || opts.xfer_dirs > 0 || opts.list_only != 0) {
			sources.push(OsString::from("."));
		}
		(sources, None)
	} else {
		(Vec::new(), rest.first().cloned())
	};
	let (outcome, reader) = if shared.failed() {
		(None, Some(streams.reader))
	} else {
		let side = SideRun {
			ctx,
			neg,
			shared: Arc::clone(&shared),
			filters,
			files_from,
			batch: None,
			batch_gen: None,
			implied,
			sources,
			dest,
		};
		let mut outcome = side.run(streams);
		let reader = outcome.reader.take();
		(Some(outcome), reader)
	};
	*lock(&shared_slot) = None;
	if let Some(err) = logger.take_fatal() {
		shared.fail(err, outcome.as_ref().map_or(role, |o| o.role));
	}
	let failure = lock(&shared.first).take();
	let (io_error, stats, site) = match &outcome {
		Some(o) => (o.ctx.io_error.load(Ordering::Relaxed), live_totals(lock(&o.ctx.stats).clone(), &o.ctx.counters), o.site),
		None => (0, Stats::default(), None),
	};
	let end_role = failure.as_ref().map_or_else(|| outcome.as_ref().map_or(role, |o| o.role), |f| f.role);
	let writer = lock(&shared.writer).take();
	// A cancelled local copy: the client prints its signal trailer first, then
	// stops this half (upstream's parent SIGUSR1s its child, whose generator
	// reports `received SIGUSR1`). Wait for that stop so the order is upstream's.
	if local_server && io.host_cancel.load(Ordering::Relaxed) {
		let deadline = Instant::now() + Duration::from_secs(10);
		while !io.cancel.load(Ordering::Relaxed) && Instant::now() < deadline {
			thread::sleep(Duration::from_millis(5));
		}
	}
	let code = if local_server && io.cancel.load(Ordering::Relaxed) {
		*lock(&sink_writer) = None;
		// The process upstream signals is the half's generator (its "Receiver"
		// before the split); the receiver child exits quietly.
		killed_exit(&logger, outcome.as_ref().map_or(role, |o| o.role), &stats)
	} else if io.host_cancel.load(Ordering::Relaxed) {
		let err = RsyncError::cancelled();
		logger.with_role(end_role).finish(err.code, err.site, &stats, false);
		err.code
	} else {
		let (code, from_peer) = match &failure {
			Some(f) => {
				logger.with_role(f.role).finish(f.err.code, f.err.site, &stats, f.from_peer);
				(f.err.code, f.from_peer)
			}
			None => {
				// exit_cleanup(0): the folded code is returned but not reported.
				let code = fold_exit(0, io_error, logger.got_xfer_error());
				logger.with_role(end_role).finish(0, site, &stats, false);
				(code, false)
			}
		};
		let tail = Tail {
			writer,
			reader,
			daemon_socket: false,
			msgs2stderr: opts.msgs2stderr,
			io_timeout: opts.io_timeout,
		};
		exit_tail(&shared, tail, code, end_role, from_peer);
		code
	};
	logger.flush();
	*lock(&sink_writer) = None;
	code
}

/// `stats` with the connection's byte counters as they stand now (upstream's
/// `stats.total_read` / `stats.total_written`, which log_exit prints).
fn live_totals(mut stats: Stats, counters: &IoCounters) -> Stats {
	stats.total_read = i64::try_from(counters.total_read()).unwrap_or(i64::MAX);
	stats.total_written = i64::try_from(counters.total_written()).unwrap_or(i64::MAX);
	stats
}

/// The local server half after its client stopped it (upstream's SIGUSR1 to
/// the local child): `rsync error: received SIGUSR1 (code 19) at main.c(1687)`.
/// The connection is gone, so the trailer goes to stderr.
fn killed_exit(logger: &Logger, role: Role, stats: &Stats) -> i32 {
	let err = RsyncError::bare(RERR_SIGNAL1).at("main.c", 1687);
	logger.with_role(role).finish(err.code, err.site, stats, false);
	err.code
}

// ---------------------------------------------------------------------------
// The transfer, for either role

/// One side's transfer after protocol setup.
struct SideRun {
	ctx: Ctx,
	neg: Negotiated,
	shared: Arc<Shared>,
	filters: Filters,
	files_from: Option<Box<dyn Read + Send>>,
	/// Client `--write-batch` file.
	batch: Option<SharedBatch>,
	/// `--read-batch`: the generator's output stream.
	batch_gen: Option<Box<dyn Read + Send>>,
	implied: Option<Arc<Mutex<ImpliedFilters>>>,
	sources: Vec<OsString>,
	dest: Option<OsString>,
}

/// What a side's transfer left for the exit code and summary.
struct Outcome {
	ctx: Ctx,
	/// (total_read, total_written) as the summary reports them.
	totals: Option<(i64, i64)>,
	/// When the stats were taken (upstream `endtime`).
	end: Option<Instant>,
	/// Print the summary (client).
	summary: bool,
	/// The role the run ended as (trailer name).
	role: Role,
	/// Exit site of a normal end.
	site: Option<(&'static str, u32)>,
	/// The connection's read half, kept for the exit tail.
	reader: Option<MuxReader>,
}

/// Reader handle a scanner can own while the session keeps using the reader.
struct LockedReader(Arc<Mutex<MuxReader>>);

impl Read for LockedReader {
	fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
		lock(&self.0).read(buf)
	}
}

impl SideRun {
	fn run(self, streams: Streams) -> Outcome {
		let Streams { reader, writer, counters } = streams;
		let reader = Arc::new(Mutex::new(reader));
		let mut outcome = if self.ctx.am_sender {
			self.run_sender(Arc::clone(&reader), writer, counters)
		} else {
			self.run_receiver(&reader, writer, counters)
		};
		outcome.reader = Arc::try_unwrap(reader).ok().map(|m| m.into_inner().unwrap_or_else(PoisonError::into_inner));
		outcome
	}

	/// Sending side: client push or `--server --sender`.
	fn run_sender(mut self, reader: Arc<Mutex<MuxReader>>, writer: MuxWriter, counters: IoCounters) -> Outcome {
		let ctx = self.ctx.clone();
		let proto = self.neg.proto.version;
		let am_server = ctx.am_server;
		let opts = Arc::clone(&ctx.opts);
		let shared = Arc::clone(&self.shared);
		writer.set_role(Role::Sender);
		lock(&reader).set_role(Role::Sender);
		let mut outcome = Outcome {
			ctx: ctx.clone(),
			totals: None,
			end: None,
			summary: !am_server,
			role: Role::Sender,
			site: Some(if am_server { ("main.c", 1012) } else { ("main.c", 1412) }),
			reader: None,
		};
		let (peer_tx, peer_rx) = flume::unbounded::<Msg>();
		*lock(&shared.to_sender) = Some(peer_tx);
		let socket_files_from = opts.filesfrom_host.is_some();
		let fail = |err: RsyncError| shared.fail(err, Role::Sender);

		// Stream setup.
		let mut lazy_switch = false;
		let res = (|| -> Result<(), RsyncError> {
			if am_server {
				handshake::start_out(&writer, true)?;
				let mux_in = opts.need_messages_from_generator;
				let mut r = lock(&reader);
				if mux_in && socket_files_from && proto < 31 {
					lazy_switch = true;
				}
				handshake::start_in(&mut r, mux_in, shared.on_msg())?;
				self.filters.recv(&mut *r, ctx.proto)?;
			} else {
				handshake::start_out(&writer, proto >= 30)?;
				let mux_in = proto >= 31 || (!socket_files_from && proto >= 23);
				let mut r = lock(&reader);
				handshake::start_in(&mut r, mux_in, shared.on_msg())?;
				let mut w = writer.clone();
				self.filters.send(&mut w, ctx.proto, false)?;
				if let Some(batch) = &self.batch {
					batch::write_header(batch, ctx.proto, ctx.seed).map_err(|e| RsyncError::from_io(&e, crate::rsync::exit::RERR_FILEIO))?;
					writer.set_batch(Some(Box::new(BatchTee(Arc::clone(batch)))));
				}
			}
			Ok(())
		})();
		if let Err(err) = res {
			fail(err);
			return outcome;
		}
		if let Err(err) = become_copy_as_user(&opts, &ctx.logger) {
			fail(err);
			return outcome;
		}
		let files_from: Option<Box<dyn Read + Send>> = if socket_files_from {
			Some(Box::new(LockedReader(Arc::clone(&reader))))
		} else {
			self.files_from.take()
		};
		let flists = Flists::new();
		*lock(&shared.flists) = Some(Arc::clone(&flists));
		let mut filters = self.filters.clone();
		filters.set_role(Role::Sender);
		let mut scanner = match Scanner::new(&ctx, &self.sources, filters, files_from) {
			Ok(s) => s,
			Err(err) => {
				fail(err);
				return outcome;
			}
		};
		if lazy_switch && let Err(e) = lock(&reader).end_multiplex() {
			fail(wire_fail(&ctx, &e, Role::Sender));
			return outcome;
		}
		if let Err(err) = scanner.send_initial(&writer, &flists) {
			fail(err);
			return outcome;
		}
		{
			let mut r = lock(&reader);
			let res = if lazy_switch {
				r.start_multiplex(shared.on_msg())
			} else if !am_server && proto < 31 && socket_files_from && proto >= 23 {
				r.start_multiplex(shared.on_msg())
			} else {
				Ok(())
			};
			if let Err(e) = res {
				drop(r);
				fail(wire_fail(&ctx, &e, Role::Sender));
				return outcome;
			}
		}
		let empty = flists.with_segment(0, |l| l.entries.is_empty()).unwrap_or(true);
		if am_server && empty {
			// do_server_sender: nothing to send ends the run quietly.
			let mut w = writer.clone();
			let _ = w.flush();
			outcome.site = Some(("main.c", 1001));
			return outcome;
		}
		let mut w = writer.clone();
		if let Err(e) = w.flush() {
			fail(wire_fail(&ctx, &e, Role::Sender));
			return outcome;
		}
		let mut r = lock(&reader);
		if let Err(err) = sender::run(&ctx, &mut scanner, &flists, &mut *r, &writer, &peer_rx) {
			drop(r);
			fail(err);
			return outcome;
		}
		if let Err(e) = w.flush() {
			drop(r);
			fail(wire_fail(&ctx, &e, Role::Sender));
			return outcome;
		}
		// handle_stats
		let total_read = counters.total_read() as i64;
		let total_written = counters.total_written() as i64;
		outcome.totals = Some((total_read, total_written));
		outcome.end = Some(Instant::now());
		let stats = lock(&ctx.stats).clone();
		let write_stats = |w: &mut dyn Write| -> io::Result<()> {
			w.write_varlong30(ctx.proto, total_read, 3)?;
			w.write_varlong30(ctx.proto, total_written, 3)?;
			w.write_varlong30(ctx.proto, stats.total_size, 3)?;
			if proto >= 29 {
				w.write_varlong30(ctx.proto, stats.flist_buildtime, 3)?;
				w.write_varlong30(ctx.proto, stats.flist_xfertime, 3)?;
			}
			Ok(())
		};
		let res = if am_server {
			write_stats(&mut w as &mut dyn Write).and_then(|()| w.flush())
		} else if let Some(batch) = &self.batch {
			let mut tee = BatchTee(Arc::clone(batch));
			write_stats(&mut tee as &mut dyn Write)
		} else {
			Ok(())
		};
		if let Err(e) = res {
			drop(r);
			fail(wire_fail(&ctx, &e, Role::Sender));
			return outcome;
		}
		// read_final_goodbye
		shared.shutting_down.store(true, Ordering::Relaxed);
		if let Err(err) = sender_goodbye(&ctx, &mut r, &mut w, scanner.ndx_codec()) {
			drop(r);
			fail(err);
			return outcome;
		}
		drop(r);
		let _ = w.flush();
		if let Some(batch) = &self.batch {
			let _ = lock(batch).flush();
		}
		outcome
	}

	/// Receiving side: client pull, local-copy server half, `--server`, `--read-batch`.
	fn run_receiver(mut self, reader_slot: &Mutex<MuxReader>, writer: MuxWriter, counters: IoCounters) -> Outcome {
		let ctx = self.ctx.clone();
		let proto = self.neg.proto.version;
		let am_server = ctx.am_server;
		let opts = Arc::clone(&ctx.opts);
		let shared = Arc::clone(&self.shared);
		let read_batch = opts.read_batch && !am_server;
		let mut guard = lock(reader_slot);
		let reader: &mut MuxReader = &mut guard;
		reader.set_role(Role::PreReceiver);
		writer.set_role(Role::PreReceiver);
		let mut outcome = Outcome {
			ctx: ctx.clone(),
			totals: None,
			end: None,
			summary: !am_server,
			role: Role::PreReceiver,
			site: Some(if am_server { ("main.c", 1291) } else { ("main.c", 1983) }),
			reader: None,
		};
		let fail = |err: RsyncError, role: Role| shared.fail(err, role);

		let negated = am_server && self.files_from.is_some() && opts.msgs2stderr != 1 && proto < 31;
		if negated {
			ctx.logger.set_levels_negated(true);
		}
		if let Err(err) = become_copy_as_user(&opts, &ctx.logger) {
			fail(err, Role::PreReceiver);
			return outcome;
		}
		let res = (|| -> Result<(), RsyncError> {
			if am_server {
				handshake::start_out(&writer, true)?;
				handshake::start_in(reader, proto >= 30, shared.on_msg())?;
				self.filters.recv(reader, ctx.proto)?;
			} else {
				if !read_batch {
					handshake::start_in(reader, proto >= 23, shared.on_msg())?;
					handshake::start_out(&writer, opts.need_messages_from_generator)?;
					let mut w = writer.clone();
					self.filters.send(&mut w, ctx.proto, true)?;
				} else {
					reader.set_counting(true);
					writer.set_counting(true);
					self.filters.send(&mut io::sink(), ctx.proto, true)?;
				}
				if let Some(batch) = &self.batch {
					batch::write_header(batch, ctx.proto, ctx.seed).map_err(|e| RsyncError::from_io(&e, crate::rsync::exit::RERR_FILEIO))?;
					reader.set_batch(Some(Box::new(BatchTee(Arc::clone(batch)))));
				}
			}
			Ok(())
		})();
		if let Err(err) = res {
			fail(err, Role::PreReceiver);
			return outcome;
		}

		// --files-from forwarding to the sender.
		let forwarder = self.files_from.take().map(|src| {
			let w = writer.clone();
			let implied = self.implied.clone();
			let eol_nulls = opts.eol_nulls;
			let cancel = Arc::clone(&ctx.cancel);
			thread::spawn(move || forward_files_from(src, &w, proto, eol_nulls, implied.as_deref(), &cancel))
		});

		let flists = Flists::new();
		*lock(&shared.flists) = Some(Arc::clone(&flists));
		let mut flist_filters = self.filters.clone();
		flist_filters.set_role(Role::PreReceiver);
		let mut fr = FlistReceiver::new(&ctx, Some(flist_filters));
		if let Some(implied) = &self.implied {
			fr.set_implied(Arc::clone(implied));
		}
		let mut res = fr.recv_initial(reader, &flists);
		if res.is_ok() && ctx.inc_recurse && flists.file_total() == 1 {
			res = fr.recv_additional(reader, &flists);
		}
		if let Some(handle) = forwarder {
			match handle.join() {
				Ok(Ok(())) => {}
				Ok(Err(err)) => fail(err, Role::PreReceiver),
				Err(_) => fail(RsyncError::bare(crate::rsync::exit::RERR_CRASHED), Role::PreReceiver),
			}
		}
		if negated {
			ctx.logger.set_levels_negated(false);
		}
		if let Err(err) = res {
			fail(err, Role::PreReceiver);
			return outcome;
		}
		if shared.failed() {
			return outcome;
		}
		// A client with nothing to receive stops here (client_run); a server
		// receiver still runs the phases so the sender can finish.
		let empty = flists.with_segment(0, |l| l.entries.is_empty()).unwrap_or(true);
		if empty && !am_server {
			outcome.totals = Some((counters.total_read() as i64, counters.total_written() as i64));
			outcome.end = Some(Instant::now());
			return outcome;
		}

		// do_recv
		let mut ropts = (*opts).clone();
		ropts.copy_links = false;
		ropts.copy_dirlinks = false;
		ropts.copy_unsafe_links = false;
		let mut rctx = ctx.clone();
		rctx.meta.copy_links = false;
		rctx.opts = Arc::new(ropts);
		let trees = match DestTrees::open(&rctx, self.dest.as_deref(), &flists) {
			Ok(trees) => trees,
			Err(err) => {
				fail(err, Role::PreReceiver);
				return outcome;
			}
		};
		// do_recv: io_flush(FULL_FLUSH) before the fork, so messages such as
		// "created directory" leave now and the generator starts with nothing
		// pending (its first refill then writes its requests on their own).
		if let Err(e) = writer.clone().flush() {
			fail(ctx.stream_error(&e), Role::PreReceiver);
			return outcome;
		}
		writer.set_role(Role::Generator);
		reader.set_role(Role::Receiver);
		outcome.role = Role::Generator;
		// The receiver → generator pipe. The receiver's refills of its socket input
		// deliver what it queued for the generator; they never write the socket the
		// generator writes (upstream's receiver is a separate process).
		let (sib_out, sib_in) = generator::sib_pipe(&flists, ctx.inc_recurse);
		*lock(&shared.sib) = Some(Arc::clone(&sib_out));
		let hook_out = Arc::clone(&sib_out);
		reader.set_refill_hook(Some(Box::new(move |ready| hook_out.refill(ready))));
		let xattrs = fr.xattrs();
		let acls = fr.acls();
		let mut gen_filters = self.filters.clone();
		gen_filters.set_role(Role::Generator);
		let gen_ctx = rctx.with_role(Role::Generator);
		let recv_ctx = rctx.with_role(Role::Receiver);
		// --read-batch: the generator's output pipe. It stays open until both
		// threads are done: the generator still writes its goodbye after the
		// receiver has stopped reading (upstream lets that output go nowhere).
		let mut batch_gen = self.batch_gen.take();
		let mut client_totals = None;
		let end = Mutex::new(None);
		thread::scope(|s| {
			let gen_writer = writer.clone();
			let gen_shared = Arc::clone(&shared);
			let trees_ref = &trees;
			let flists_ref = &flists;
			let generator_thread = s.spawn(move || {
				let res = generator::run(&gen_ctx, trees_ref, flists_ref, xattrs, acls, gen_filters, &gen_writer, &sib_in);
				match res {
					Ok(()) => {
						gen_shared.shutting_down.store(true, Ordering::Relaxed);
						let mut w = gen_writer.clone();
						// A server generator passes the receiver's protocol-33 block
						// count on to the sender (MSG_BLOCK_STATS) before its goodbye.
						let block_stats = if gen_ctx.am_server && gen_ctx.proto.version >= 33 {
							let touched = lock(&gen_ctx.stats).touched_blocks_4k;
							w.send_msg(MSG_BLOCK_STATS, &touched.to_le_bytes())
						} else {
							Ok(())
						};
						let written = block_stats.and_then(|()| {
							if read_batch {
								w.write_int(NDX_DONE)
							} else {
								NdxCodec::new(gen_ctx.proto).write(&mut w, NDX_DONE)
							}
						});
						let res = written.and_then(|()| w.flush());
						if let Err(e) = res {
							if !gen_shared.failed() {
								gen_shared.fail(gen_ctx.stream_error(&e), Role::Generator);
							}
						}
					}
					Err(err) => gen_shared.fail(err, Role::Generator),
				}
			});
			let recv_shared = Arc::clone(&shared);
			let recv_writer = writer.clone();
			let reader_ref = &mut *reader;
			let fr_ref = &mut fr;
			let end_ref = &end;
			let totals_ref = &mut client_totals;
			let mut batch_gen = batch_gen.as_mut();
			let sib_out = &*sib_out;
			let recv = s.spawn(move || {
				let res = match batch_gen.as_deref_mut() {
					Some(bg) => {
						let bg: &mut dyn Read = &mut **bg;
						receiver::run_batch(&recv_ctx, trees_ref, flists_ref, fr_ref, reader_ref, &recv_writer, sib_out, Some(bg))
					}
					None => receiver::run(&recv_ctx, trees_ref, flists_ref, fr_ref, reader_ref, &recv_writer, sib_out),
				};
				let res = res.and_then(|()| {
					let totals = receiver_stats(&recv_ctx, reader_ref)?;
					*lock(end_ref) = Some(Instant::now());
					*totals_ref = totals;
					// do_recv: NDX_DONE to the generator, then io_flush(FULL_FLUSH).
					sib_out.data(Sibling::Done);
					sib_out.flush_all();
					receiver_goodbye(&recv_ctx, fr_ref, reader_ref, batch_gen.as_deref_mut(), sib_out)
				});
				if let Err(err) = res {
					recv_shared.fail(err, Role::Receiver);
				}
			});
			let _ = recv.join();
			let _ = generator_thread.join();
		});
		*lock(&shared.sib) = None;
		reader.set_refill_hook(None);
		outcome.end = lock(&end).take();
		if !am_server {
			let (read, written) = client_totals.unwrap_or((counters.total_read() as i64, counters.total_written() as i64));
			outcome.totals = Some((read, written));
		}
		outcome.ctx = rctx;
		outcome
	}
}

/// A wire failure as `role` reports it (EOF text names the bytes read so far).
fn wire_fail(ctx: &Ctx, err: &io::Error, role: Role) -> RsyncError {
	ctx.logger.with_role(role).io_error(err, RERR_STREAMIO, ctx.counters.total_read())
}

/// handle_stats on the receiving side: a client reads the sender's totals
/// (read/written swapped) and its file-list times; returns (read, written).
fn receiver_stats(ctx: &Ctx, r: &mut MuxReader) -> Result<Option<(i64, i64)>, RsyncError> {
	if ctx.am_server {
		return Ok(None);
	}
	let io_err = |e: io::Error| ctx.stream_error(&e);
	let total_written = r.read_varlong30(ctx.proto, 3).map_err(io_err)?;
	let total_read = r.read_varlong30(ctx.proto, 3).map_err(io_err)?;
	let total_size = r.read_varlong30(ctx.proto, 3).map_err(io_err)?;
	let mut stats = lock(&ctx.stats);
	stats.total_size = total_size;
	if ctx.proto.version >= 29 {
		stats.flist_buildtime = r.read_varlong30(ctx.proto, 3).map_err(io_err)?;
		stats.flist_xfertime = r.read_varlong30(ctx.proto, 3).map_err(io_err)?;
	}
	Ok(Some((total_read, total_written)))
}

/// upstream `read_del_stats` into the side's stats.
fn read_del_stats(ctx: &Ctx, r: &mut dyn Read) -> Result<(), RsyncError> {
	let role = ctx.logger.role();
	let mut read = |what: &str| read_varint_bounded(r, 0, MAX_WIRE_DEL_STAT, what, role);
	let files = read("deleted_files")?;
	let dirs = read("deleted_dirs")?;
	let symlinks = read("deleted_symlinks")?;
	let devices = read("deleted_devices")?;
	let specials = read("deleted_specials")?;
	let mut stats = lock(&ctx.stats);
	stats.deleted_dirs = dirs;
	stats.deleted_symlinks = symlinks;
	stats.deleted_devices = devices;
	stats.deleted_specials = specials;
	stats.deleted_files = files.saturating_add(dirs).saturating_add(symlinks).saturating_add(devices).saturating_add(specials);
	Ok(())
}

fn invalid_end_packet(ndx: i32, role: Role) -> RsyncError {
	RsyncError::new(RERR_PROTOCOL, format!("Invalid packet at end of run ({ndx}) [{}]", role.name())).at("main.c", 950)
}

/// upstream `write_del_stats`.
fn write_del_stats(ctx: &Ctx, w: &mut dyn Write, codec: &mut NdxCodec) -> io::Result<()> {
	let s = lock(&ctx.stats).clone();
	codec.write(w, NDX_DEL_STATS)?;
	let files = s.deleted_files - s.deleted_dirs - s.deleted_symlinks - s.deleted_devices - s.deleted_specials;
	for v in [files, s.deleted_dirs, s.deleted_symlinks, s.deleted_devices, s.deleted_specials] {
		w.write_varint(v)?;
	}
	Ok(())
}

/// read_final_goodbye on the sending side (deletion stats may precede it; a
/// server sender passes them on so the client's summary has them). `wcodec`
/// is the sending side's write-direction ndx codec.
fn sender_goodbye(ctx: &Ctx, r: &mut MuxReader, w: &mut MuxWriter, wcodec: &mut NdxCodec) -> Result<(), RsyncError> {
	if ctx.proto.version < 24 {
		return Ok(());
	}
	let io_err = |e: io::Error| ctx.stream_error(&e);
	let mut rcodec = NdxCodec::new(ctx.proto);
	let mut next = |r: &mut MuxReader, w: &mut MuxWriter, wcodec: &mut NdxCodec| -> Result<i32, RsyncError> {
		loop {
			let ndx = rcodec.read(r).map_err(io_err)?;
			if ndx == NDX_DEL_STATS {
				read_del_stats(ctx, r)?;
				if ctx.am_server {
					write_del_stats(ctx, w, wcodec).map_err(io_err)?;
				}
				continue;
			}
			return Ok(ndx);
		}
	};
	let mut ndx = next(r, w, wcodec)?;
	if ctx.proto.version >= 31 && ndx == NDX_DONE {
		wcodec.write(w, NDX_DONE).and_then(|()| w.flush()).map_err(io_err)?;
		ndx = next(r, w, wcodec)?;
	}
	if ndx != NDX_DONE {
		return Err(invalid_end_packet(ndx, ctx.logger.role()));
	}
	Ok(())
}

/// read_final_goodbye on the receiver (protocol ≥ 31): the sender's echo of
/// the generator's goodbye is forwarded to the generator as one more Done.
fn receiver_goodbye(
	ctx: &Ctx,
	fr: &mut FlistReceiver,
	r: &mut MuxReader,
	batch_gen: Option<&mut Box<dyn Read + Send>>,
	sib: &SibOut,
) -> Result<(), RsyncError> {
	if ctx.proto.version < 31 {
		return Ok(());
	}
	let io_err = |e: io::Error| ctx.stream_error(&e);
	let ndx = loop {
		let ndx = fr.ndx_codec().read(r).map_err(io_err)?;
		if ndx == NDX_DEL_STATS {
			read_del_stats(ctx, r)?;
			continue;
		}
		break ndx;
	};
	if ndx != NDX_DONE {
		return Err(invalid_end_packet(ndx, Role::Receiver));
	}
	if let Some(bg) = batch_gen {
		loop {
			let v = bg.read_int().map_err(io_err)?;
			if v == NDX_DEL_STATS {
				break;
			}
		}
		read_del_stats(ctx, &mut **bg)?;
	}
	// read_final_goodbye: write_int(f_out, NDX_DONE) to the generator; it leaves with
	// the next refill, which upstream's receiver starts at once.
	sib.data(Sibling::Done);
	sib.flush_all();
	Ok(())
}

/// Forwards a local `--files-from` list to the sender (upstream
/// `forward_filesfrom_data`): line ends become NULs (unless `-0`), runs of
/// NULs collapse, the end is marked by an empty name. Protocols before 31
/// send it outside the multiplexed framing.
fn forward_files_from(
	mut src: Box<dyn Read + Send>,
	w: &MuxWriter,
	proto: u32,
	eol_nulls: bool,
	implied: Option<&Mutex<ImpliedFilters>>,
	cancel: &AtomicBool,
) -> Result<(), RsyncError> {
	let reenable = proto < 31 && w.is_multiplexed();
	if reenable {
		w.end_multiplex().map_err(RsyncError::from_stream)?;
	}
	let mut out = w.clone();
	let mut buf = vec![0u8; 32 * 1024];
	let mut lastchar: u8 = 0;
	let mut partial: Vec<u8> = Vec::new();
	loop {
		if cancel.load(Ordering::Relaxed) {
			return Err(RsyncError::cancelled());
		}
		let n = match src.read(&mut buf) {
			Ok(n) => n,
			Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
			Err(e) => return Err(RsyncError::from_stream(e)),
		};
		if n == 0 {
			let end: &[u8] = if lastchar != 0 { b"\0\0" } else { b"\0" };
			out.write_all(end).map_err(RsyncError::from_stream)?;
			if !partial.is_empty()
				&& let Some(implied) = implied
			{
				lock(implied).add(&partial, false);
			}
			break;
		}
		let chunk = &mut buf[..n];
		if !eol_nulls {
			for b in chunk.iter_mut() {
				if *b == b'\n' || *b == b'\r' {
					*b = 0;
				}
			}
		}
		let mut data: &[u8] = chunk;
		if lastchar == 0 {
			while let Some((0, rest)) = data.split_first() {
				data = rest;
			}
		}
		if data.is_empty() {
			continue;
		}
		let mut packed = Vec::with_capacity(data.len());
		let mut i = 0;
		while i < data.len() {
			let b = data[i];
			packed.push(b);
			i += 1;
			if b == 0 {
				if let Some(implied) = implied {
					lock(implied).add(&partial, false);
				}
				partial.clear();
				while i < data.len() && data[i] == 0 {
					i += 1;
				}
			} else {
				partial.push(b);
			}
		}
		lastchar = data[data.len() - 1];
		out.write_all(&packed).map_err(RsyncError::from_stream)?;
	}
	out.flush().map_err(RsyncError::from_stream)?;
	if reenable {
		w.start_multiplex().map_err(RsyncError::from_stream)?;
	}
	Ok(())
}

#[cfg(test)]
mod tests;
