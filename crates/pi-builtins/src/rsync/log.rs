//! Everything the user sees: message routing (`rprintf`/`rsyserr`), peer
//! messages, the `--log-file`, per-item `--out-format` lines, `--info` /
//! `--debug` levels, and `--stats` rendering.
//!
//! A [`Logger`] is shared by every role of a transfer (cheap clones; the role
//! is per clone). Client loggers write to local stdout/stderr; a server logger
//! hands messages to the peer the way upstream multiplexes them.

mod format;
mod levels;
mod stats;

use std::{
	io::{self, Write},
	sync::{
		Arc, Mutex,
		atomic::{AtomicBool, AtomicU8, AtomicU32, Ordering},
	},
	time::Duration,
};

#[cfg(all(test, unix))]
pub(crate) use format::itemize;
pub(crate) use format::{ItemizeCtx, big_num, log_format_has, permstring, timestring};
use format::{FormatEnv, FormatItem, expand};
pub(crate) use levels::{Debug, Info, OutLevels, Priority, Words};
pub(crate) use stats::Stats;

use crate::rsync::{
	cstr::until_nul,
	flists::lock,
	checksum::CsumType,
	consts::{
		BIGPATHBUFLEN, ITEM_DELETED, ITEM_LOCAL_CHANGE, ITEM_TRANSFER, MAXPATHLEN, S_IFDIR, S_IFREG,
		SIGNIFICANT_ITEM_FLAGS, mode_is_dir, mode_is_reg,
	},
	exit::{self, RsyncError},
};

/// Message classes (upstream `enum logcode`; values equal the MSG_* codes).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LogCode {
	ErrorXfer = 1,
	Info = 2,
	Error = 3,
	Warning = 4,
	ErrorSocket = 5,
	Log = 6,
	Client = 7,
	ErrorUtf8 = 8,
}

impl LogCode {
	/// The code for a MSG_* tag carrying a log message, if it is one.
	pub(crate) const fn from_u8(tag: u8) -> Option<Self> {
		Some(match tag {
			1 => Self::ErrorXfer,
			2 => Self::Info,
			3 => Self::Error,
			4 => Self::Warning,
			5 => Self::ErrorSocket,
			6 => Self::Log,
			7 => Self::Client,
			8 => Self::ErrorUtf8,
			_ => return None,
		})
	}
}

/// Which part of the transfer is speaking (upstream who_am_i()).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Role {
	Sender,
	Receiver,
	Generator,
	/// Start-up, before roles are assigned, on the client.
	Client,
	/// Start-up, before roles are assigned, on the server.
	Server,
	/// The receiving side before it splits into generator and receiver ("Receiver").
	PreReceiver,
}

impl Role {
	/// Upstream's who_am_i() text.
	pub(crate) const fn name(self) -> &'static str {
		match self {
			Self::Sender => "sender",
			Self::Receiver => "receiver",
			Self::Generator => "generator",
			Self::Client => "client",
			Self::Server => "server",
			Self::PreReceiver => "Receiver",
		}
	}
}

/// `--stderr=errors` (the default): errors to stderr, info to stdout / the peer.
pub(crate) const STDERR_ERRORS: u8 = 0;
/// `--stderr=all` / `--msgs2stderr`: every message to stderr.
pub(crate) const STDERR_ALL: u8 = 1;
/// `--stderr=client` / `--no-msgs2stderr`: a server sends everything to the client.
pub(crate) const STDERR_CLIENT: u8 = 2;

/// Default `--log-file-format`.
pub(crate) const DEFAULT_LOG_FILE_FORMAT: &[u8] = b"%i %n%L";

/// Longest message written to the log file / syslog.
const LOG_MSG_MAX: usize = 2047;

/// Logger settings.
#[derive(Clone, Default)]
pub(crate) struct LogConfig {
	pub levels: OutLevels,
	/// --out-format (or the format implied by -i / -v).
	pub out_format: Option<Vec<u8>>,
	pub log_file: Option<std::path::PathBuf>,
	pub log_file_format: Option<Vec<u8>>,
	/// -h level: 0 = --no-h, 1 = default (separators), 2 = -h (1000), 3 = -hh (1024).
	pub human_readable: u8,
	pub eight_bit_output: bool,
	/// [`STDERR_ERRORS`], [`STDERR_ALL`], or [`STDERR_CLIENT`].
	pub stderr_mode: u8,
	pub am_server: bool,
	pub quiet: bool,
	pub module: Option<Vec<u8>>,
	pub host: Option<Vec<u8>>,
	pub addr: Option<Vec<u8>>,
	pub user: Option<Vec<u8>>,
	/// `%P`: the module path (daemon only; literal `%P` when None).
	pub module_path: Option<Vec<u8>>,
	/// `-i` count (upstream `itemize_changes`), for `stdout_format_has_i`.
	pub itemize_changes: u8,
	pub dry_run: bool,
	/// Both transfer halves run in this process.
	pub local_server: bool,
	pub preserve_mtimes: bool,
	/// The receiver can set symlink times (negotiated).
	pub receiver_symlink_times: bool,
	pub preserve_uid: bool,
	pub preserve_gid: bool,
	/// `-c`: `%C` shows the file-list checksum.
	pub always_checksum: bool,
	/// Zone for `%t`, `%M`, and log-file stamps (the shell's TZ); None = system zone.
	pub time_zone: Option<jiff::tz::TimeZone>,
}

/// Formats and flags derived once from the config (upstream's *_format_has_* globals).
#[derive(Default)]
struct Formats {
	stdout: Option<Vec<u8>>,
	stdout_has_i: u8,
	stdout_has_o_or_i: bool,
	logfile: Option<Vec<u8>>,
	logfile_has_i: bool,
	logfile_has_o_or_i: bool,
}

impl Formats {
	fn new(cfg: &LogConfig) -> Self {
		let mut formats = Self { stdout: cfg.out_format.clone(), ..Self::default() };
		if let Some(format) = &formats.stdout {
			formats.stdout_has_i = if cfg.am_server && log_format_has(format, b'I') {
				2
			} else if log_format_has(format, b'i') {
				cfg.itemize_changes | 1
			} else {
				0
			};
			formats.stdout_has_o_or_i = formats.stdout_has_i != 0 || log_format_has(format, b'o');
		}
		if cfg.log_file.is_some() {
			let format =
				cfg.log_file_format.clone().unwrap_or_else(|| DEFAULT_LOG_FILE_FORMAT.to_vec());
			formats.logfile_has_i = log_format_has(&format, b'i');
			formats.logfile_has_o_or_i = formats.logfile_has_i || log_format_has(&format, b'o');
			formats.logfile = Some(format);
		}
		formats
	}
}

/// Server-side peer sink: sends one message as MSG_<code>.
pub(crate) type RemoteSink = Arc<dyn Fn(LogCode, &[u8]) -> io::Result<()> + Send + Sync>;
/// Server-side MSG_DELETED sink (payload: the name, plus a NUL for directories).
pub(crate) type DeletedSink = Arc<dyn Fn(&[u8]) -> io::Result<()> + Send + Sync>;

enum LogTarget {
	/// No --log-file.
	Off,
	File(Box<dyn Write + Send>),
	/// The log file could not be opened: messages go to syslog (unix) like upstream.
	Syslog,
}

struct Outputs {
	out: Option<Box<dyn Write + Send>>,
	err: Option<Box<dyn Write + Send>>,
	log: LogTarget,
	/// Guards against logging recursion while writing the log file.
	in_block: bool,
}

struct Inner {
	cfg: LogConfig,
	formats: Formats,
	/// `levels` and its negation (files-from silencing).
	levels: [OutLevels; 2],
	negated: AtomicBool,
	tz: jiff::tz::TimeZone,
	remote: Option<RemoteSink>,
	deleted: Mutex<Option<DeletedSink>>,
	outputs: Mutex<Outputs>,
	got_xfer_error: AtomicBool,
	/// Negotiated receiver_symlink_times (starts as `cfg.receiver_symlink_times`).
	receiver_symlink_times: AtomicBool,
	/// Upstream output_needs_newline (1 after a progress line, 2 during flist progress).
	needs_newline: AtomicU8,
	protocol: AtomicU32,
	checksums: Mutex<(CsumType, CsumType)>,
	fatal: Mutex<Option<RsyncError>>,
}

/// Where messages go: local stdout/stderr (client) or the peer (server role).
#[derive(Clone)]
pub(crate) struct Logger {
	inner: Arc<Inner>,
	role: Role,
}

/// Everything the % escapes of --out-format can reference for one item.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct LogItem<'a> {
	pub name: &'a [u8],
	pub mode: u32,
	pub size: u64,
	pub mtime: i64,
	pub uid: u32,
	pub gid: u32,
	pub link: Option<&'a [u8]>,
	pub hlink: Option<&'a [u8]>,
	pub iflags: u32,
	pub op: &'static str,
	pub bytes_xfer: u64,
	pub bytes_csum: u64,
	/// `%C` digest bytes (file-list sum under -c, else the transfer sum), raw.
	pub checksum: Option<&'a [u8]>,
	pub is_dir: bool,
	/// Sender-side directory prefix (`F_PATHNAME`) that `%f` joins in front of the name.
	pub dir_prefix: Option<&'a [u8]>,
	/// FLAG_SKIP_GROUP: `%G` prints `DEFAULT`.
	pub skip_group: bool,
}

impl Logger {
	/// A client-side logger writing to local stdout and stderr.
	pub(crate) fn local(
		out: Box<dyn Write + Send>,
		err: Box<dyn Write + Send>,
		cfg: LogConfig,
	) -> Self {
		Self::build(Some(out), Some(err), None, cfg, Role::Client)
	}

	/// Server role with a local stderr: `--stderr=errors`/`all` route there like upstream,
	/// and messages that cannot be multiplexed (yet) fall back to it.
	pub(crate) fn remote_with_stderr(
		sink: RemoteSink,
		err: Box<dyn Write + Send>,
		cfg: LogConfig,
	) -> Self {
		Self::build(None, Some(err), Some(sink), cfg, Role::Server)
	}

	fn build(
		out: Option<Box<dyn Write + Send>>,
		err: Option<Box<dyn Write + Send>>,
		remote: Option<RemoteSink>,
		cfg: LogConfig,
		role: Role,
	) -> Self {
		let mut negated = cfg.levels.clone();
		negated.negate();
		let levels = [cfg.levels.clone(), negated];
		let tz = cfg.time_zone.clone().unwrap_or_else(jiff::tz::TimeZone::system);
		let formats = Formats::new(&cfg);
		let inner = Inner {
			formats,
			levels,
			negated: AtomicBool::new(false),
			tz,
			remote,
			deleted: Mutex::new(None),
			outputs: Mutex::new(Outputs { out, err, log: LogTarget::Off, in_block: false }),
			got_xfer_error: AtomicBool::new(false),
			receiver_symlink_times: AtomicBool::new(cfg.receiver_symlink_times),
			needs_newline: AtomicU8::new(0),
			protocol: AtomicU32::new(33),
			checksums: Mutex::new((CsumType::Md5, CsumType::Md5)),
			fatal: Mutex::new(None),
			cfg,
		};
		Self { inner: Arc::new(inner), role }
	}

	/// The same logger speaking as `role`.
	pub(crate) fn with_role(&self, role: Role) -> Self {
		Self { inner: Arc::clone(&self.inner), role }
	}

	/// Who this clone speaks as.
	pub(crate) fn role(&self) -> Role {
		self.role
	}

	/// Current output levels (all zero while negated).
	pub(crate) fn levels(&self) -> &OutLevels {
		&self.inner.levels[usize::from(self.inner.negated.load(Ordering::Relaxed))]
	}

	/// The settings this logger was built with.
	pub(crate) fn config(&self) -> &LogConfig {
		&self.inner.cfg
	}

	/// Temporarily silences every info/debug level (negate_output_levels).
	pub(crate) fn set_levels_negated(&self, negated: bool) {
		self.inner.negated.store(negated, Ordering::Relaxed);
	}

	/// The negotiated protocol (pre-30 peers get errors as MSG_ERROR_XFER, warnings as info).
	pub(crate) fn set_protocol(&self, version: u32) {
		self.inner.protocol.store(version, Ordering::Relaxed);
	}

	/// Negotiated transfer and file-list checksum kinds (for `%C`).
	pub(crate) fn set_checksums(&self, xfer: CsumType, file: CsumType) {
		*lock(&self.inner.checksums) = (xfer, file);
	}

	/// Server role: how MSG_DELETED reaches the peer (protocol ≥ 29).
	pub(crate) fn set_deleted_sink(&self, sink: Option<DeletedSink>) {
		*lock(&self.inner.deleted) = sink;
	}

	/// The negotiated receiver_symlink_times (itemize: a symlink whose time cannot be set
	/// shows `T`).
	pub(crate) fn set_receiver_symlink_times(&self, on: bool) {
		self.inner.receiver_symlink_times.store(on, Ordering::Relaxed);
	}

	/// Upstream got_xfer_error: an ErrorXfer message was emitted (the run ends with 23).
	pub(crate) fn got_xfer_error(&self) -> bool {
		self.inner.got_xfer_error.load(Ordering::Relaxed)
	}

	/// Upstream output_needs_newline (0, 1 after an unfinished progress line, 2 for
	/// file-list progress).
	pub(crate) fn needs_newline(&self) -> u8 {
		self.inner.needs_newline.load(Ordering::Relaxed)
	}

	/// Sets output_needs_newline.
	pub(crate) fn set_needs_newline(&self, value: u8) {
		self.inner.needs_newline.store(value, Ordering::Relaxed);
	}

	/// A fatal logging condition upstream exits on (RERR_MESSAGEIO), taken once.
	pub(crate) fn take_fatal(&self) -> Option<RsyncError> {
		lock(&self.inner.fatal).take()
	}

	/// Installs an already-opened `--log-file` (append mode, opened by the caller).
	pub(crate) fn set_log_file(&self, file: Box<dyn Write + Send>) {
		lock(&self.inner.outputs).log = LogTarget::File(file);
	}

	/// log_init: opens `config().log_file` for appending through the operator-file walk.
	/// On failure prints upstream's two messages and falls back to syslog.
	pub(crate) fn open_log_file(&self, fs: &pi_vfs::BlockingFs, insecure: bool) {
		let Some(path) = self.inner.cfg.log_file.clone() else {
			return;
		};
		if path.is_empty() {
			lock(&self.inner.outputs).log = LogTarget::Syslog;
			return;
		}
		match crate::rsync::paths::create_operator_file(fs, &path, true, insecure) {
			Ok(file) => self.set_log_file(Box::new(file)),
			Err(err) => {
				let mut text = b"failed to open log-file ".to_vec();
				text.extend_from_slice(&crate::host::os_bytes_lossy(path.as_os_str()));
				self.rsyserr(LogCode::Error, &err, &text);
				self.rprintf(LogCode::Info, b"Ignoring \"log file\" setting.\n");
				lock(&self.inner.outputs).log = LogTarget::Syslog;
			}
		}
	}

	/// rprintf: `text` carries its own trailing newline like upstream's format strings.
	/// One line per call: embedded control characters (including `\n`) are escaped.
	pub(crate) fn rprintf(&self, code: LogCode, text: &[u8]) {
		if text.len() > BIGPATHBUFLEN - 1 {
			let keep = BIGPATHBUFLEN - 1 - 6;
			let mut cut = text[..keep].to_vec();
			cut.extend_from_slice(b"[...]");
			cut.push(if text.ends_with(b"\n") { b'\n' } else { 0 });
			self.emit(code, &cut, false);
		} else {
			self.emit(code, text, false);
		}
	}

	/// rsyserr: "rsync: [<role>] <text>: <strerror> (<errno>)\n".
	pub(crate) fn rsyserr(&self, code: LogCode, err: &io::Error, text: &[u8]) {
		if crate::rsync::paths::is_untrusted_symlink(err) {
			let mut notice = crate::rsync::paths::UNTRUSTED_SYMLINK_NOTICE.as_bytes().to_vec();
			notice.push(b'\n');
			self.rprintf(LogCode::Error, &notice);
		}
		let mut line = format!("rsync: [{}] ", self.role.name()).into_bytes();
		line.extend_from_slice(text);
		line.extend_from_slice(format!(": {}\n", syserr_suffix(err)).as_bytes());
		self.rprintf(code, &line);
	}

	/// A message that arrived from the peer (client prints it; server forwards it).
	pub(crate) fn from_peer(&self, code: LogCode, text: &[u8]) {
		self.emit(code, text, true);
	}

	/// A MSG_DELETED payload from the peer: a trailing NUL marks a directory.
	pub(crate) fn from_peer_deleted(&self, payload: &[u8]) {
		match payload.strip_suffix(b"\0") {
			Some(name) => self.log_delete(until_nul(name), S_IFDIR),
			None => self.log_delete(until_nul(payload), S_IFREG),
		}
	}

	/// Maps a wire-level io::Error with this logger's role filling upstream's EOF text.
	pub(crate) fn io_error(&self, err: &io::Error, code: i32, bytes_read: u64) -> RsyncError {
		RsyncError::from_io_as(err, code, self.role, bytes_read)
	}

	/// End-of-run bookkeeping (exit_cleanup + log_exit): finishes a pending progress line,
	/// writes the log-file totals line, and prints the exit trailer (`rsync error:` at FERROR,
	/// `rsync warning:` for code 24, nothing for 0). `after_error_exit` suppresses the
	/// duplicate trailer after a peer's MSG_ERROR_EXIT.
	pub(crate) fn finish(
		&self,
		code: i32,
		site: Option<(&'static str, u32)>,
		stats: &Stats,
		after_error_exit: bool,
	) {
		if self.inner.needs_newline.swap(0, Ordering::Relaxed) != 0 {
			let mut outputs = lock(&self.inner.outputs);
			if let Some(out) = outputs.out.as_mut() {
				let _ = out.write_all(b"\n");
			}
		}
		let log_active = !matches!(lock(&self.inner.outputs).log, LogTarget::Off);
		let report = (code != 0 && !after_error_exit)
			|| (log_active
				&& (self.inner.cfg.am_server || self.levels().info(Info::Stats) < 1));
		if report {
			if code == 0 || self.role == Role::Sender {
				self.rprintf(LogCode::Log, stats.log_exit_line().as_bytes());
			}
			let server_success = self.inner.cfg.am_server && code == 0;
			if code != 0 && !server_success {
				let level = if code == exit::RERR_VANISHED { LogCode::Warning } else { LogCode::Error };
				self.rprintf(level, exit::exit_trailer(code, site, self.role).as_bytes());
			}
		}
		self.flush();
	}

	/// output_summary: the --stats block and the sent/received summary, per INFO stats level.
	pub(crate) fn output_summary(
		&self,
		stats: &Stats,
		proto: u32,
		elapsed: Option<Duration>,
		dry_run: bool,
		batch_only: bool,
	) {
		let human = self.inner.cfg.human_readable;
		let levels = self.levels().clone();
		if levels.info(Info::Stats) >= 2 {
			self.rprintf(LogCode::Client, b"\n");
			for line in stats.stats_lines(human, proto, &levels) {
				self.rprintf(LogCode::Info, line.as_bytes());
			}
		}
		if levels.info(Info::Stats) >= 1 {
			let suffix = if batch_only {
				" (BATCH ONLY)"
			} else if dry_run {
				" (DRY RUN)"
			} else {
				""
			};
			self.rprintf(LogCode::Client, b"\n");
			for line in stats.summary_lines(human, elapsed, suffix) {
				self.rprintf(LogCode::Info, line.as_bytes());
			}
		}
		self.flush();
	}

	/// log_item: out-format / log-file-format line for one transferred/changed/deleted item.
	pub(crate) fn log_item(&self, code: LogCode, item: &LogItem<'_>) {
		let formats = &self.inner.formats;
		if code != LogCode::Log
			&& !self.inner.cfg.am_server
			&& let Some(format) = &formats.stdout
		{
			self.formatted(LogCode::Client, format, item, false);
		}
		if code != LogCode::Client
			&& let Some(format) = formats.logfile.as_ref().filter(|format| !format.is_empty())
		{
			self.formatted(LogCode::Log, format, item, false);
		}
	}

	/// maybe_log_item: logs an item if itemizing or its changes are significant.
	pub(crate) fn maybe_log_item(&self, item: &LogItem<'_>, itemizing: bool) {
		let formats = &self.inner.formats;
		let significant = item.iflags & SIGNIFICANT_ITEM_FLAGS;
		let hlink = item.hlink.is_some_and(|hlink| !hlink.is_empty());
		let see_item = itemizing
			&& (significant != 0
				|| hlink || formats.stdout_has_i > 1
				|| (self.levels().info(Info::Name) >= 2 && formats.stdout_has_i != 0));
		let local_change = item.iflags & ITEM_LOCAL_CHANGE != 0 && significant != 0;
		if self.inner.cfg.am_server {
			if formats.logfile.is_some()
				&& !self.inner.cfg.dry_run
				&& see_item && (significant != 0 || formats.logfile_has_i)
			{
				self.log_item(LogCode::Log, item);
			}
		} else if see_item
			|| local_change
			|| hlink || ((mode_is_dir(item.mode) || item.is_dir) && significant != 0)
		{
			let code = if significant != 0 || formats.logfile_has_i {
				LogCode::Info
			} else {
				LogCode::Client
			};
			self.log_item(code, item);
		}
	}

	/// log_delete: reports one deletion (`deleting x` / `*deleting  x`), or forwards it to
	/// the client as MSG_DELETED on a server.
	pub(crate) fn log_delete(&self, name: &[u8], mode: u32) {
		let formats = &self.inner.formats;
		let item = LogItem { name, mode, iflags: ITEM_DELETED, op: "del.", ..LogItem::default() };
		let proto = self.inner.protocol.load(Ordering::Relaxed);
		let deleted_sink = lock(&self.inner.deleted).clone();
		if self.inner.cfg.am_server && proto >= 29 && name.len() < MAXPATHLEN {
			if let Some(sink) = deleted_sink {
				let mut payload = name.to_vec();
				if mode_is_dir(mode) {
					payload.push(0);
				}
				let _ = sink(&payload);
			}
		} else if self.levels().info(Info::Del) >= 1 || formats.stdout.is_some() {
			let format: &[u8] = match &formats.stdout {
				Some(format) if formats.stdout_has_o_or_i => format,
				_ => b"deleting %n",
			};
			self.formatted(LogCode::Client, format, &item, true);
		}
		if self.inner.cfg.dry_run {
			return;
		}
		if let Some(logfile) = &formats.logfile {
			let format: &[u8] = if formats.logfile_has_o_or_i { logfile } else { b"deleting %n" };
			self.formatted(LogCode::Log, format, &item, true);
		}
	}

	/// Flushes stdout and stderr (rflush).
	pub(crate) fn flush(&self) {
		let mut outputs = lock(&self.inner.outputs);
		if let Some(out) = outputs.out.as_mut() {
			let _ = out.flush();
		}
		if let Some(err) = outputs.err.as_mut() {
			let _ = err.flush();
		}
		if let LogTarget::File(file) = &mut outputs.log {
			let _ = file.flush();
		}
	}

	fn formatted(&self, code: LogCode, format: &[u8], item: &LogItem<'_>, from_delete: bool) {
		let cfg = &self.inner.cfg;
		let now = jiff::Timestamp::now().as_second();
		let env = FormatEnv {
			itemize: ItemizeCtx {
				local_server: cfg.local_server,
				preserve_mtimes: cfg.preserve_mtimes,
				receiver_symlink_times: self.inner.receiver_symlink_times.load(Ordering::Relaxed),
			},
			preserve_uid: cfg.preserve_uid,
			preserve_gid: cfg.preserve_gid,
			tz: &self.inner.tz,
			now,
			pid: std::process::id(),
			module: cfg.module.as_deref(),
			host: cfg.host.as_deref(),
			addr: cfg.addr.as_deref(),
			user: cfg.user.as_deref(),
			module_path: cfg.module_path.as_deref(),
			checksum: self.checksum_text(item),
		};
		let fitem = FormatItem {
			name: item.name,
			dir_prefix: item.dir_prefix,
			mode: if item.is_dir && item.mode == 0 { S_IFDIR } else { item.mode },
			size: item.size,
			mtime: item.mtime,
			uid: item.uid,
			gid: item.gid,
			skip_group: item.skip_group,
			link: item.link,
			hlink: item.hlink,
			iflags: item.iflags,
			op: item.op,
			bytes_xfer: item.bytes_xfer,
			bytes_csum: item.bytes_csum,
			from_delete,
		};
		match expand(format, &fitem, &env) {
			Ok(line) => self.emit(code, &line, false),
			Err(err) => {
				let mut text = err.message().into_bytes();
				text.push(b'\n');
				self.rprintf(LogCode::Error, &text);
				let mut fatal = lock(&self.inner.fatal);
				if fatal.is_none() {
					*fatal = Some(RsyncError::bare(exit::RERR_MESSAGEIO).at("log.c", 0));
				}
			}
		}
	}

	/// `%C`: the hex digest when one applies, else the blank width.
	fn checksum_text(&self, item: &LogItem<'_>) -> Result<Vec<u8>, usize> {
		let (xfer, file) = *lock(&self.inner.checksums);
		let always = self.inner.cfg.always_checksum;
		let kind = if always { file } else { xfer };
		// csum_len_for_type(kind, always).
		let len = if always { kind.flist_len() } else { kind.digest_len() };
		let regular = mode_is_reg(item.mode) && !item.is_dir;
		let applies = regular
			&& ((always && item.iflags & ITEM_DELETED == 0) || item.iflags & ITEM_TRANSFER != 0);
		if applies
			&& let Some(sum) = item.checksum
			&& let Some(hex) = sum_as_hex(kind, sum, len)
		{
			return Ok(hex);
		}
		Err(len * 2)
	}

	/// rwrite: routes one message.
	fn emit(&self, code: LogCode, buf: &[u8], is_utf8: bool) {
		let inner = &*self.inner;
		let cfg = &inner.cfg;
		let mut code = match code {
			LogCode::ErrorSocket | LogCode::ErrorUtf8 => LogCode::Error,
			other => other,
		};
		// Peer text is only treated differently with --iconv conversion, which this build
		// performs in the file-list layer; display filtering is the same either way.
		let _ = is_utf8;
		let mut outputs = lock(&inner.outputs);
		if code == LogCode::Client {
			code = LogCode::Info;
		} else if !matches!(outputs.log, LogTarget::Off) {
			if !outputs.in_block {
				outputs.in_block = true;
				let text = &buf[..buf.len().min(LOG_MSG_MAX)];
				let info = matches!(code, LogCode::Info | LogCode::Log);
				write_log(&mut outputs.log, text, info, &inner.tz);
				outputs.in_block = false;
			}
			if code == LogCode::Log {
				return;
			}
		} else if code == LogCode::Log {
			return;
		}
		let mut to_stderr = cfg.stderr_mode == STDERR_ALL;
		match code {
			LogCode::ErrorXfer => {
				inner.got_xfer_error.store(true, Ordering::Relaxed);
				to_stderr = true;
			}
			LogCode::Error | LogCode::Warning => to_stderr = true,
			LogCode::Info => {
				if cfg.quiet {
					return;
				}
			}
			_ => return,
		}
		if let Some(sink) = &inner.remote {
			let forward = match cfg.stderr_mode {
				STDERR_ERRORS => !to_stderr || outputs.err.is_none(),
				STDERR_CLIENT => true,
				// STDERR_ALL: nothing goes to the peer.
				_ => false,
			};
			if forward {
				let mut msg = code;
				if inner.protocol.load(Ordering::Relaxed) < 30 {
					msg = match msg {
						LogCode::Error => LogCode::ErrorXfer,
						LogCode::Warning => LogCode::Info,
						other => other,
					};
				}
				drop(outputs);
				if sink(msg, buf).is_ok() {
					return;
				}
				outputs = lock(&inner.outputs);
			}
			to_stderr = true;
		}
		let escape_8bit = !cfg.eight_bit_output;
		let validate_utf8 = escape_8bit && !cfg.am_server && inner.remote.is_none();
		let mut line = Vec::with_capacity(buf.len() + 8);
		if inner.needs_newline.swap(0, Ordering::Relaxed) != 0 {
			line.push(b'\n');
		}
		let (body, trailing) = match buf.last() {
			Some(&last @ (b'\n' | b'\r')) => (&buf[..buf.len() - 1], Some(last)),
			_ => (buf, None),
		};
		let body = match body.split_first() {
			Some((b'\r', rest)) => {
				line.push(b'\r');
				rest
			}
			_ => body,
		};
		if validate_utf8 {
			for chunk in body.utf8_chunks() {
				filter_into(&mut line, chunk.valid().as_bytes(), false, false);
				for &byte in chunk.invalid() {
					push_octal(&mut line, byte);
				}
			}
		} else {
			filter_into(&mut line, body, escape_8bit, false);
		}
		if let Some(last) = trailing {
			line.push(last);
		}
		let use_err = to_stderr || outputs.out.is_none();
		let writer = if use_err { outputs.err.as_mut() } else { outputs.out.as_mut() };
		if let Some(writer) = writer {
			let _ = writer.write_all(&line);
			if trailing.is_some() {
				let _ = writer.flush();
			}
		}
	}
}

fn push_octal(out: &mut Vec<u8>, byte: u8) {
	out.extend_from_slice(format!("\\#{byte:03o}").as_bytes());
}

/// filtered_fwrite: escapes control characters (not tab), optionally non-ASCII-printable
/// bytes or C1 controls, and any literal `\#ddd` so it cannot be mistaken for an escape.
fn filter_into(out: &mut Vec<u8>, data: &[u8], escape_unprintable: bool, escape_c1: bool) {
	for (index, &byte) in data.iter().enumerate() {
		let looks_escaped = byte == b'\\'
			&& data.len() - index > 4
			&& data[index + 1] == b'#'
			&& data[index + 2..index + 5].iter().all(u8::is_ascii_digit);
		let unprintable = byte != b'\t'
			&& (byte < b' '
				|| (escape_unprintable && !(b' '..=b'~').contains(&byte))
				|| (escape_c1 && (0x80..=0x9f).contains(&byte)));
		if looks_escaped || unprintable {
			push_octal(out, byte);
		} else {
			out.push(byte);
		}
	}
}

/// logit: one log-file line `YYYY/MM/DD hh:mm:ss [pid] message` (or a syslog record).
fn write_log(target: &mut LogTarget, text: &[u8], info: bool, tz: &jiff::tz::TimeZone) {
	let (body, trailing) = match text.last() {
		Some(&last @ (b'\n' | b'\r')) => (&text[..text.len() - 1], Some(last)),
		_ => (text, None),
	};
	match target {
		LogTarget::Off => {}
		LogTarget::File(file) => {
			let mut line = format!(
				"{} [{}] ",
				timestring(jiff::Timestamp::now().as_second(), tz),
				std::process::id()
			)
			.into_bytes();
			filter_into(&mut line, body, false, true);
			line.extend(trailing);
			let _ = file.write_all(&line);
			let _ = file.flush();
		}
		LogTarget::Syslog => syslog(body, info),
	}
}

#[cfg(unix)]
fn syslog(text: &[u8], info: bool) {
	let clean: Vec<u8> = text.iter().copied().filter(|&byte| byte != 0).collect();
	let Ok(message) = std::ffi::CString::new(clean) else {
		return;
	};
	let priority = libc::LOG_DAEMON | if info { libc::LOG_INFO } else { libc::LOG_WARNING };
	// SAFETY: both pointers are valid NUL-terminated strings for the duration of the call,
	// and the "%s" format consumes exactly the one string argument passed.
	unsafe { libc::syslog(priority, c"%s".as_ptr(), message.as_ptr()) };
}

#[cfg(windows)]
fn syslog(_text: &[u8], _info: bool) {
	// Windows has no syslog; upstream builds without one drop these records.
}

/// The errno upstream would print for `err`. OS errors keep their own errno on unix (an
/// untrusted-symlink refusal is `ELOOP`, see [`crate::rsync::paths::os_errno`]); errno-less
/// (virtual filesystem) and Windows errors map their kind to the errno it stands for, `EIO`
/// when none does.
pub(crate) fn errno_of(err: &io::Error) -> i32 {
	#[cfg(unix)]
	if let Some(code) = crate::rsync::paths::os_errno(err) {
		return code;
	}
	kind_errno(err.kind()).unwrap_or(libc::EIO)
}

/// The `strerror` text of [`errno_of`]`(err)` on unix; an error without an errno
/// equivalent (and every Windows error) keeps its own text.
pub(crate) fn strerror(err: &io::Error) -> String {
	#[cfg(unix)]
	if let Some(code) =
		crate::rsync::paths::os_errno(err).or_else(|| kind_errno(err.kind()))
	{
		return crate::host::strip_errno(&io::Error::from_raw_os_error(code));
	}
	crate::host::strip_errno(err)
}

/// `strerror (errno)`, the tail of every rsyserr line.
pub(crate) fn syserr_suffix(err: &io::Error) -> String {
	format!("{} ({})", strerror(err), errno_of(err))
}

/// `rsync: [role] TEXT: strerror (errno)`, the text of upstream's rsyserr (for errors that
/// end the run instead of being logged).
pub(crate) fn syserr_text(role: Role, err: &io::Error, text: &str) -> String {
	format!("rsync: [{}] {text}: {}", role.name(), syserr_suffix(err))
}

/// The errno an error kind corresponds to.
fn kind_errno(kind: io::ErrorKind) -> Option<i32> {
	use io::ErrorKind as K;
	Some(match kind {
		K::NotFound => libc::ENOENT,
		K::PermissionDenied => libc::EACCES,
		K::AlreadyExists => libc::EEXIST,
		K::CrossesDevices => libc::EXDEV,
		K::NotADirectory => libc::ENOTDIR,
		K::IsADirectory => libc::EISDIR,
		K::InvalidInput => libc::EINVAL,
		K::FileTooLarge => libc::EFBIG,
		K::StorageFull => libc::ENOSPC,
		K::NotSeekable => libc::ESPIPE,
		K::ReadOnlyFilesystem => libc::EROFS,
		K::TooManyLinks => libc::EMLINK,
		K::BrokenPipe => libc::EPIPE,
		K::Deadlock => libc::EDEADLK,
		K::InvalidFilename => libc::ENAMETOOLONG,
		K::DirectoryNotEmpty => libc::ENOTEMPTY,
		K::Unsupported => libc::ENOSYS,
		K::OutOfMemory => libc::ENOMEM,
		K::ResourceBusy => libc::EBUSY,
		K::Interrupted => libc::EINTR,
		_ => return None,
	})
}

/// sum_as_hex of the first `len` bytes: canonical digests print in their public byte
/// order; seeded MD4 variants have no canonical form.
fn sum_as_hex(kind: CsumType, sum: &[u8], len: usize) -> Option<Vec<u8>> {
	let reversed = match kind {
		CsumType::None | CsumType::Md4Archaic | CsumType::Md4Old | CsumType::Md4Busted => {
			return None;
		}
		CsumType::Md4 | CsumType::Md5 | CsumType::Sha1 => false,
		CsumType::Xxh64 | CsumType::Xxh3 | CsumType::Xxh128 => true,
	};
	let len = len.min(sum.len());
	let bytes = &sum[..len];
	let mut out = Vec::with_capacity(len * 2);
	let mut push = |byte: u8| {
		out.extend_from_slice(format!("{byte:02x}").as_bytes());
	};
	if reversed {
		bytes.iter().rev().copied().for_each(&mut push);
	} else {
		bytes.iter().copied().for_each(&mut push);
	}
	Some(out)
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::rsync::consts::{ITEM_IS_NEW, ITEM_REPORT_PERMS, ITEM_REPORT_SIZE};

	#[derive(Clone, Default)]
	struct Buf(Arc<Mutex<Vec<u8>>>);

	impl Write for Buf {
		fn write(&mut self, data: &[u8]) -> io::Result<usize> {
			lock(&self.0).extend_from_slice(data);
			Ok(data.len())
		}

		fn flush(&mut self) -> io::Result<()> {
			Ok(())
		}
	}

	impl Buf {
		fn text(&self) -> String {
			String::from_utf8_lossy(&lock(&self.0)).into_owned()
		}

		fn bytes(&self) -> Vec<u8> {
			lock(&self.0).clone()
		}
	}

	fn utc() -> Option<jiff::tz::TimeZone> {
		Some(jiff::tz::TimeZone::UTC)
	}

	fn client(cfg: LogConfig) -> (Logger, Buf, Buf) {
		let (out, err) = (Buf::default(), Buf::default());
		(Logger::local(Box::new(out.clone()), Box::new(err.clone()), cfg), out, err)
	}

	fn base_cfg(format: &str) -> LogConfig {
		LogConfig {
			out_format: Some(format.as_bytes().to_vec()),
			human_readable: 1,
			local_server: true,
			preserve_mtimes: true,
			receiver_symlink_times: true,
			preserve_uid: true,
			preserve_gid: true,
			time_zone: utc(),
			levels: OutLevels::from_verbose(0),
			..LogConfig::default()
		}
	}

	#[test]
	fn routing_info_stdout_errors_stderr() {
		let (logger, out, err) = client(LogConfig::default());
		logger.rprintf(LogCode::Info, b"hello\n");
		logger.rprintf(LogCode::Error, b"bad\n");
		logger.rprintf(LogCode::Warning, b"warn\n");
		logger.rprintf(LogCode::Log, b"only the log\n");
		logger.rprintf(LogCode::Client, b"client\n");
		assert_eq!(out.text(), "hello\nclient\n");
		assert_eq!(err.text(), "bad\nwarn\n");
		assert!(!logger.got_xfer_error());
		logger.with_role(Role::Generator).rprintf(LogCode::ErrorXfer, b"x\n");
		assert!(logger.got_xfer_error());
	}

	#[test]
	fn quiet_and_stderr_all() {
		let (logger, out, err) = client(LogConfig { quiet: true, ..LogConfig::default() });
		logger.rprintf(LogCode::Info, b"hidden\n");
		logger.rprintf(LogCode::Error, b"shown\n");
		assert_eq!((out.text(), err.text()), (String::new(), "shown\n".to_owned()));
		let (logger, out, err) =
			client(LogConfig { stderr_mode: STDERR_ALL, ..LogConfig::default() });
		logger.rprintf(LogCode::Info, b"info\n");
		assert_eq!((out.text(), err.text()), (String::new(), "info\n".to_owned()));
	}

	#[cfg(unix)]
	#[test]
	fn rsyserr_format() {
		let (logger, _, err) = client(LogConfig::default());
		let error = io::Error::from(io::ErrorKind::NotFound);
		logger.with_role(Role::Sender).rsyserr(LogCode::Error, &error, b"change_dir \"/nonexist\" failed");
		assert_eq!(
			err.text(),
			"rsync: [sender] change_dir \"/nonexist\" failed: No such file or directory (2)\n"
		);
	}

	#[cfg(unix)]
	#[test]
	fn rsyserr_uses_os_errno() {
		let (logger, _, err) = client(LogConfig::default());
		let error = io::Error::from_raw_os_error(libc::EROFS);
		logger.with_role(Role::PreReceiver).rsyserr(LogCode::Error, &error, b"mkdir \"/x\" failed");
		assert_eq!(
			err.text(),
			format!("rsync: [Receiver] mkdir \"/x\" failed: Read-only file system ({})\n", libc::EROFS)
		);
	}

	#[test]
	fn names_are_escaped_like_the_reference() {
		// Captured: `\001` and invalid UTF-8 escape, valid UTF-8, tab, and DEL pass, and a
		// literal `\#123` gets its backslash escaped.
		let (logger, out, _) = client(LogConfig::default());
		logger.rprintf(LogCode::Info, b"a\x01b\n");
		logger.rprintf(LogCode::Info, "caf\u{e9}\n".as_bytes());
		logger.rprintf(LogCode::Info, b"x\\#123y\n");
		logger.rprintf(LogCode::Info, b"t\tz\x7fd\n");
		logger.rprintf(LogCode::Info, b"l1 -> b\xffc\xc3\n");
		assert_eq!(
			out.bytes(),
			b"a\\#001b\ncaf\xc3\xa9\nx\\#134#123y\nt\tz\x7fd\nl1 -> b\\#377c\\#303\n".to_vec()
		);
		let (logger, out, _) = client(LogConfig { eight_bit_output: true, ..LogConfig::default() });
		logger.rprintf(LogCode::Info, b"l1 -> b\xffc\xc3 \xc2\x85\x01\n");
		assert_eq!(out.bytes(), b"l1 -> b\xffc\xc3 \xc2\x85\\#001\n".to_vec());
	}

	#[test]
	fn carriage_returns_and_pending_newline() {
		let (logger, out, _) = client(LogConfig::default());
		logger.rprintf(LogCode::Client, b"\r  progress\r");
		logger.set_needs_newline(1);
		logger.rprintf(LogCode::Info, b"next\n");
		assert_eq!(out.text(), "\r  progress\r\nnext\n");
	}

	#[test]
	fn server_forwards_with_old_protocol_mapping() {
		let sent = Arc::new(Mutex::new(Vec::new()));
		let sink_log = Arc::clone(&sent);
		let sink: RemoteSink = Arc::new(move |code, data: &[u8]| {
			lock(&sink_log).push((code, data.to_vec()));
			Ok(())
		});
		let err = Buf::default();
		let logger = Logger::remote_with_stderr(
			sink,
			Box::new(err.clone()),
			LogConfig { am_server: true, stderr_mode: STDERR_CLIENT, ..LogConfig::default() },
		);
		logger.rprintf(LogCode::Info, b"i\n");
		logger.rprintf(LogCode::Error, b"e\n");
		logger.set_protocol(29);
		logger.rprintf(LogCode::Error, b"e29\n");
		logger.rprintf(LogCode::Warning, b"w29\n");
		logger.rprintf(LogCode::Client, b"c\n");
		assert_eq!(
			*lock(&sent),
			vec![
				(LogCode::Info, b"i\n".to_vec()),
				(LogCode::Error, b"e\n".to_vec()),
				(LogCode::ErrorXfer, b"e29\n".to_vec()),
				(LogCode::Info, b"w29\n".to_vec()),
				(LogCode::Info, b"c\n".to_vec()),
			]
		);
		assert_eq!(err.text(), "");
	}

	#[test]
	fn server_errors_go_to_stderr_by_default() {
		let sent = Arc::new(Mutex::new(Vec::new()));
		let sink_log = Arc::clone(&sent);
		let sink: RemoteSink = Arc::new(move |code, _: &[u8]| {
			lock(&sink_log).push(code);
			Ok(())
		});
		let err = Buf::default();
		let logger = Logger::remote_with_stderr(
			sink,
			Box::new(err.clone()),
			LogConfig { am_server: true, ..LogConfig::default() },
		);
		logger.rprintf(LogCode::Info, b"info\n");
		logger.rprintf(LogCode::Error, b"oops\n");
		assert_eq!(*lock(&sent), vec![LogCode::Info]);
		assert_eq!(err.text(), "oops\n");
	}

	#[test]
	fn unsendable_messages_fall_back_to_stderr() {
		let sink: RemoteSink = Arc::new(|_, _: &[u8]| Err(io::Error::other("not multiplexed")));
		let err = Buf::default();
		let logger = Logger::remote_with_stderr(
			sink,
			Box::new(err.clone()),
			LogConfig { am_server: true, stderr_mode: STDERR_CLIENT, ..LogConfig::default() },
		);
		logger.rprintf(LogCode::Info, b"early\n");
		assert_eq!(err.text(), "early\n");
	}

	fn sample(name: &'static [u8], mode: u32, iflags: u32) -> LogItem<'static> {
		LogItem {
			name,
			mode,
			size: 5000,
			mtime: 1_577_836_800,
			uid: 501,
			gid: 0,
			iflags,
			op: "send",
			bytes_xfer: 5043,
			bytes_csum: 16,
			..LogItem::default()
		}
	}

	#[test]
	fn out_format_escapes_and_justification() {
		// Format and outputs captured from `rsync -aH --out-format=...` (3.5.1).
		let format = "[%o][%n][%f][%10l][%-10l|][%'l][%''l][%'''l][%B][%U][%G][%L][%b][%'b][%c]\
		              [%M][%i][%%][%x][%5n|][%-5i|]";
		let (logger, out, _) = client(base_cfg(format));
		let big = LogItem {
			dir_prefix: Some(b"src"),
			..sample(b"big", 0o100_644, ITEM_TRANSFER | ITEM_IS_NEW)
		};
		logger.log_item(LogCode::Info, &big);
		let link = LogItem {
			size: 3,
			link: Some(b"big"),
			bytes_xfer: 0,
			bytes_csum: 0,
			dir_prefix: Some(b"src"),
			mtime: 0,
			..sample(b"lnk", 0o120_755, ITEM_LOCAL_CHANGE | ITEM_IS_NEW)
		};
		logger.log_item(LogCode::Info, &link);
		let lines = out.text();
		let mut lines = lines.lines();
		assert_eq!(
			lines.next().unwrap(),
			"[send][big][src/big][      5000][5000      |][5,000][5.00K][4.88K][rw-r--r--][501][0][]\
			 [5043][5,043][16][2020/01/01-00:00:00][>f+++++++++][%][%x][  big|][>f+++++++++|]"
		);
		assert_eq!(
			lines.next().unwrap(),
			"[send][lnk][src/lnk][         3][3         |][3][3][3][rwxr-xr-x][501][0][ -> big][0]\
			 [0][0][1970/01/01-00:00:00][cL+++++++++][%][%x][  lnk|][cL+++++++++|]"
		);
	}

	#[test]
	fn top_dir_hard_link_and_padding_edge_cases() {
		let (logger, out, _) =
			client(base_cfg("[%05n][%05U][%-05l][%05l][%0'8l][%'08b]%|%10L|%-4L|%h%m%P%u|%G|%'"));
		let dir = LogItem {
			name: b".",
			mode: 0o040_755,
			size: 96,
			dir_prefix: Some(b"src"),
			..LogItem::default()
		};
		logger.log_item(LogCode::Info, &dir);
		let hard = LogItem {
			hlink: Some(b"hl"),
			size: 2,
			bytes_xfer: 45,
			skip_group: true,
			..sample(b"sub/f", 0o100_600, ITEM_TRANSFER)
		};
		logger.log_item(LogCode::Info, &hard);
		let blank_l = format!("|{}|{}|", " ".repeat(14), " ".repeat(8));
		assert_eq!(
			out.text(),
			format!(
				"[000./][00000][96   ][00096][%0'8l][00000000]%{blank_l}%h%P%u|0|%'\n\
				 [sub/f][00501][2    ][00002][%0'8l][00000045]%| => {}hl| => hl  |%h%P%u|DEFAULT|%'\n",
				" ".repeat(8)
			)
		);
	}

	#[test]
	fn deletions_use_deleting_n_or_the_itemize_format() {
		let mut cfg = base_cfg("%i %n%L");
		cfg.itemize_changes = 1;
		let (logger, out, _) = client(cfg);
		logger.log_delete(b"extra", S_IFREG);
		logger.from_peer_deleted(b"gone\0");
		assert_eq!(out.text(), "*deleting   extra\n*deleting   gone/\n");
		let mut cfg = base_cfg("%n");
		cfg.levels.set_info(Info::Del, 1);
		let (logger, out, _) = client(cfg);
		logger.log_delete(b"old", S_IFREG);
		assert_eq!(out.text(), "deleting old\n");
		let (logger, out, _) = client(LogConfig::default());
		logger.log_delete(b"quiet", S_IFREG);
		assert_eq!(out.text(), "");
	}

	#[test]
	fn maybe_log_item_rules() {
		let (logger, out, _) = client(base_cfg("%i %n%L"));
		// Unchanged file, single -i: not shown.
		logger.maybe_log_item(&sample(b"same", 0o100_644, 0), true);
		// Perms changed: shown.
		logger.maybe_log_item(&sample(b"perm", 0o100_644, ITEM_REPORT_PERMS), true);
		assert_eq!(out.text(), ".f...p..... perm\n");
		let mut cfg = base_cfg("%i %n%L");
		cfg.itemize_changes = 2;
		let (logger, out, _) = client(cfg);
		logger.maybe_log_item(&sample(b"same", 0o100_644, 0), true);
		assert_eq!(out.text(), format!(".f{}same\n", " ".repeat(10)));
	}

	#[test]
	fn checksum_escape() {
		let digest: Vec<u8> = (0u8..16).collect();
		let (logger, out, _) = client(base_cfg("%C|%n"));
		logger.log_item(
			LogCode::Info,
			&LogItem { checksum: Some(&digest), ..sample(b"a", 0o100_644, ITEM_TRANSFER) },
		);
		logger.log_item(LogCode::Info, &sample(b".", 0o040_755, 0));
		logger.set_checksums(CsumType::Xxh64, CsumType::Xxh64);
		logger.log_item(
			LogCode::Info,
			&LogItem { checksum: Some(&digest[..8]), ..sample(b"b", 0o100_644, ITEM_TRANSFER) },
		);
		assert_eq!(
			out.text(),
			"000102030405060708090a0b0c0d0e0f|a\n                                |./\n\
			 0706050403020100|b\n"
		);
	}

	#[test]
	fn log_file_lines_and_exit() {
		let file = Buf::default();
		let cfg = LogConfig {
			log_file: Some("x.log".into()),
			time_zone: utc(),
			human_readable: 1,
			..base_cfg("%n%L")
		};
		let (logger, out, err) = client(cfg);
		logger.set_log_file(Box::new(file.clone()));
		logger.rprintf(LogCode::Log, b"building file list\n");
		logger.log_item(LogCode::Info, &sample(b"big\x1b", 0o100_644, ITEM_TRANSFER | ITEM_IS_NEW));
		let stats = Stats { total_written: 10, total_read: 2, total_size: 7, ..Stats::default() };
		logger.finish(exit::RERR_PARTIAL, Some(("main.c", 1412)), &stats, false);
		let text = file.text();
		let pid = std::process::id();
		let lines: Vec<&str> = text.lines().collect();
		assert_eq!(lines.len(), 3, "{text}");
		let stamp_len = "2026/10/29 00:39:06".len();
		assert_eq!(&lines[0][stamp_len..], format!(" [{pid}] building file list"));
		assert_eq!(&lines[1][stamp_len..], format!(" [{pid}] >f+++++++++ big\\#033"));
		assert_eq!(
			&lines[2][stamp_len..],
			format!(
				" [{pid}] rsync error: some files/attrs were not transferred (see previous errors) \
				 (code 23) at main.c(1412) [client=3.5.1]"
			)
		);
		assert_eq!(out.text(), "big\\#033\n");
		assert!(err.text().starts_with("rsync error: some files/attrs"));
		// A successful run logs the totals line to the file only.
		let file = Buf::default();
		let (logger, out, _) = client(LogConfig { log_file: Some("y.log".into()), ..LogConfig::default() });
		logger.set_log_file(Box::new(file.clone()));
		logger.finish(0, None, &stats, false);
		assert!(file.text().ends_with("] sent 10 bytes  received 2 bytes  total size 7\n"));
		assert_eq!(out.text(), "");
	}

	#[test]
	fn finish_prints_trailers() {
		let (logger, out, err) = client(LogConfig::default());
		logger.set_needs_newline(1);
		logger.with_role(Role::Sender).finish(
			exit::RERR_VANISHED,
			Some(("main.c", 1338)),
			&Stats::default(),
			false,
		);
		assert_eq!(out.text(), "\n");
		assert_eq!(
			err.text(),
			"rsync warning: some files vanished before they could be transferred (code 24) at \
			 main.c(1338) [sender=3.5.1]\n"
		);
		let (logger, _, err) = client(LogConfig::default());
		logger.finish(0, None, &Stats::default(), false);
		logger.finish(exit::RERR_PARTIAL, None, &Stats::default(), true);
		assert_eq!(err.text(), "");
	}

	#[test]
	fn summary_goes_through_logger() {
		let mut cfg = LogConfig { human_readable: 1, ..LogConfig::default() };
		cfg.levels.set_info(Info::Stats, 1);
		let (logger, out, _) = client(cfg);
		let stats = Stats { total_written: 229, total_read: 48, total_size: 1_239_620, ..Stats::default() };
		logger.output_summary(&stats, 33, Some(Duration::ZERO), true, false);
		assert_eq!(
			out.text(),
			"\nsent 229 bytes  received 48 bytes  554.00 bytes/sec\ntotal size is 1,239,620  \
			 speedup is 4,475.16 (DRY RUN)\n"
		);
	}

	#[test]
	fn overlong_messages_truncate() {
		let (logger, out, _) = client(LogConfig::default());
		let mut long = vec![b'a'; BIGPATHBUFLEN + 10];
		long.push(b'\n');
		logger.rprintf(LogCode::Info, &long);
		let text = out.bytes();
		assert_eq!(text.len(), BIGPATHBUFLEN - 1);
		assert!(text.ends_with(b"aaa[...]\n"));
	}

	#[test]
	fn format_too_long_is_fatal() {
		let format = "x".repeat(MAXPATHLEN + 1);
		let (logger, _, err) = client(base_cfg(&format));
		logger.log_item(LogCode::Info, &sample(b"a", 0o100_644, ITEM_TRANSFER | ITEM_REPORT_SIZE));
		assert_eq!(err.text(), "log-format string is WAY too long!\n");
		assert_eq!(logger.take_fatal().map(|e| e.code), Some(exit::RERR_MESSAGEIO));
	}
}
