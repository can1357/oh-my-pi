//! Connection setup after the transport is up: the binary protocol-version
//! exchange, compatibility flags (and the client's `-e.<caps>` string they are
//! derived from on the server), checksum/compression name negotiation, the
//! checksum seed, `--secluded-args` transport, and the points where each side
//! switches its streams to buffered/multiplexed I/O.
//!
//! Byte counting: nothing exchanged here counts toward `--stats` totals; the
//! session turns counting on when a direction starts buffering
//! ([`start_in`] / [`start_out`]).

use std::ffi::OsString;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use crate::rsync::cstr::atol;
use crate::rsync::time::unix_now;
use crate::rsync::checksum::{self, ChecksumChoice, CsumType};
use crate::rsync::consts::{
	CF_AVOID_XATTR_OPTIM, CF_CHKSUM_SEED_FIX, CF_ID0_NAMES, CF_INC_RECURSE, CF_INPLACE_PARTIAL_DIR,
	CF_SAFE_FLIST, CF_SYMLINK_ICONV, CF_SYMLINK_TIMES, CF_VARINT_FLIST_FLAGS, MAX_PROTOCOL_VERSION,
	MIN_PROTOCOL_VERSION, PROTOCOL_VERSION, SUBPROTOCOL_VERSION,
};
use crate::rsync::exit::{RERR_PROTOCOL, RERR_SYNTAX, RERR_UNSUPPORTED, RsyncError};
use crate::rsync::log::{Debug, Info, LogCode, Logger};
use crate::rsync::mux::{Msg, MuxReader, MuxWriter};
use crate::rsync::options::Options;
use crate::rsync::paths::{bytes_os_lossy, vec_os_lossy};
use crate::rsync::token::{self, Compress};
use crate::rsync::wire::{Proto, ReadExt, WriteExt};

/// Upstream `MAX_NSTR_STRLEN`: negotiation strings are read into a buffer this big.
const MAX_NSTR_STRLEN: usize = 256;
/// Longest secluded argument line upstream reads (`MAXPATHLEN` buffer).
const MAX_ARG_LEN: usize = 4096;

/// Who runs this side of the protocol.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Roles {
	pub am_server: bool,
	pub am_sender: bool,
	pub local_server: bool,
	/// `--read-batch`: the peer is a batch file (nothing is written to it).
	pub read_batch: bool,
	/// `--write-batch`/`--only-write-batch` on the client.
	pub write_batch: bool,
}

/// Inputs of [`setup_protocol`] beyond the streams.
pub(crate) struct Setup<'a> {
	pub roles: Roles,
	/// Server side: the peer's capability string (`-e.<caps>` without the `e`);
	/// a local server gets the string its client would have sent.
	pub client_info: &'a [u8],
	/// The peer's protocol when already known (daemon greeting, batch header).
	pub remote_protocol: Option<u32>,
	/// Whether this side permits incremental recursion (upstream `allow_inc_recurse`).
	pub allow_inc_recurse: bool,
	/// Batch stream flags (`--read-batch`), applied after the version checks.
	pub batch_flags: Option<i32>,
	pub getenv: &'a dyn Fn(&str) -> Option<String>,
	pub logger: &'a Logger,
}

/// What the two sides agreed on.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Negotiated {
	pub proto: Proto,
	pub inc_recurse: bool,
	pub xfer_sum: CsumType,
	pub file_sum: CsumType,
	pub seed: i32,
	pub compress: Compress,
	/// Effective compression level (None without compression).
	pub compress_level: Option<i32>,
	/// The receiver can set symlink times (itemize shows `T` otherwise).
	pub receiver_symlink_times: bool,
}

/// Upstream `get_subprotocol_version`.
fn our_subprotocol(protocol: u32) -> u32 {
	if protocol < PROTOCOL_VERSION { 0 } else { SUBPROTOCOL_VERSION }
}

/// Upstream `check_sub_protocol`: a server lowers its protocol when either side
/// only speaks a pre-release of it.
fn check_sub_protocol(protocol: &mut u32, client_info: &[u8]) {
	let our_sub = our_subprotocol(*protocol);
	let their_protocol = atol(client_info);
	let their_sub = client_info
		.iter()
		.position(|&b| b == b'.')
		.map(|dot| atol(&client_info[dot + 1..]))
		.unwrap_or(0);
	if their_protocol == 0 || their_sub == 0 {
		if our_sub != 0 {
			*protocol = protocol.saturating_sub(1);
		}
		return;
	}
	let mine = i64::from(*protocol);
	if their_protocol < mine {
		*protocol = u32::try_from(their_protocol - 1).unwrap_or(0);
		return;
	}
	let their_sub = if their_protocol > mine { 0 } else { their_sub };
	if their_sub != i64::from(our_sub) {
		*protocol = protocol.saturating_sub(1);
	}
}

/// The capability string a local server sees (upstream `maybe_add_e_option`
/// output without its `e`), taken from the server argv its client builds.
pub(crate) fn local_client_info(client: &Options, remote_is_sender: bool) -> Vec<u8> {
	let args = crate::rsync::options::server_args(client, remote_is_sender);
	for arg in &args {
		let bytes = crate::host::os_bytes_lossy(arg);
		if bytes.first() == Some(&b'-') && bytes.get(1) != Some(&b'-') {
			if let Some(pos) = bytes.array_windows().position(|w| w == b"e.") {
				return bytes[pos + 1..].to_vec();
			}
			return Vec::new();
		}
	}
	Vec::new()
}

fn proto_error(text: String, line: u32) -> RsyncError {
	RsyncError::new(RERR_PROTOCOL, text).at("compat.c", line)
}

/// Upstream `setup_protocol`: version exchange (unless already known), the
/// protocol-range checks, batch flag reconciliation, the protocol-dependent
/// option adjustments, compat flags, name negotiation, and the checksum seed.
///
/// `opts` is adjusted in place the way upstream adjusts its globals. For
/// `--read-batch`, `r` is the batch stream and nothing is written to `w`.
pub(crate) fn setup_protocol(
	s: &Setup<'_>,
	opts: &mut Options,
	r: &mut dyn Read,
	w: &mut dyn Write,
) -> Result<Negotiated, RsyncError> {
	let roles = s.roles;
	let logger = s.logger;
	let who = if roles.am_server { "Server" } else { "Client" };
	let mut protocol = u32::try_from(opts.protocol_version).unwrap_or(0);

	let remote = match s.remote_protocol {
		Some(remote) => remote,
		None => {
			if roles.am_server && !roles.local_server {
				check_sub_protocol(&mut protocol, s.client_info);
			}
			if !roles.read_batch {
				w.write_int(protocol as i32).map_err(RsyncError::from_stream)?;
				w.flush().map_err(RsyncError::from_stream)?;
			}
			let remote = r.read_int().map_err(RsyncError::from_stream)?;
			let remote = u32::try_from(remote).unwrap_or(0);
			// Daemon sessions already folded the remote version into ours.
			protocol = protocol.min(remote);
			remote
		}
	};
	if roles.read_batch && remote > protocol {
		return Err(proto_error(
			format!("The protocol version in the batch file is too new ({remote} > {protocol})."),
			614,
		));
	}
	if logger.levels().debug(Debug::Proto) >= 1 {
		let line = format!("({who}) Protocol versions: remote={remote}, negotiated={protocol}\n");
		logger.rprintf(LogCode::Info, line.as_bytes());
	}
	if !(MIN_PROTOCOL_VERSION..=MAX_PROTOCOL_VERSION).contains(&remote) {
		return Err(proto_error(
			"protocol version mismatch -- is your shell clean?\n(see the rsync manpage for an explanation)"
				.to_string(),
			625,
		));
	}
	if protocol < MIN_PROTOCOL_VERSION {
		return Err(proto_error(
			format!("--protocol must be at least {MIN_PROTOCOL_VERSION} on the {who}."),
			634,
		));
	}
	if protocol > PROTOCOL_VERSION {
		return Err(proto_error(
			format!("--protocol must be no more than {PROTOCOL_VERSION} on the {who}."),
			639,
		));
	}
	if let Some(flags) = s.batch_flags {
		crate::rsync::batch::check_batch_flags(opts, flags, protocol, logger)?;
	}
	if !opts.saw_stderr_opt && protocol <= 28 && roles.am_server {
		opts.msgs2stderr = 0;
	}
	if let Some(err) = opts.preallocate_refusal(roles.am_server, roles.am_sender) {
		return Err(err);
	}

	let mut proto = Proto { version: protocol, compat: 0 };
	let mut negotiated_strings = false;
	let mut receiver_symlink_times = false;
	let mut inc_recurse = false;

	if protocol < 30 {
		if opts.append_mode == 1 {
			opts.append_mode = 2;
		}
		if opts.preserve_acls && !roles.local_server {
			return Err(proto_error(
				format!("--acls requires protocol 30 or higher (negotiated {protocol})."),
				672,
			));
		}
		if opts.preserve_xattrs > 0 && !roles.local_server {
			return Err(proto_error(
				format!("--xattrs requires protocol 30 or higher (negotiated {protocol})."),
				679,
			));
		}
	}
	if opts.delete_mode && !(opts.delete_before || opts.delete_during != 0 || opts.delete_after) {
		if protocol < 30 {
			opts.delete_before = true;
		} else {
			opts.delete_during = 1;
		}
	}

	if protocol >= 30 {
		let info = s.client_info;
		let has = |c: u8| info.contains(&c);
		let compat = if roles.am_server {
			let mut compat = if s.allow_inc_recurse { CF_INC_RECURSE } else { 0 };
			compat |= CF_SYMLINK_TIMES;
			if crate::rsync::usage::SUPPORT_ICONV {
				compat |= CF_SYMLINK_ICONV;
			}
			if has(b'f') {
				compat |= CF_SAFE_FLIST;
			}
			if has(b'x') {
				compat |= CF_AVOID_XATTR_OPTIM;
			}
			if has(b'C') {
				compat |= CF_CHKSUM_SEED_FIX;
			}
			if has(b'I') {
				compat |= CF_INPLACE_PARTIAL_DIR;
			}
			if has(b'u') {
				compat |= CF_ID0_NAMES;
			}
			if has(b'v') {
				negotiated_strings = true;
				compat |= CF_VARINT_FLIST_FLAGS;
			}
			if has(b'V') {
				if !roles.write_batch {
					compat |= CF_VARINT_FLIST_FLAGS;
				}
				w.write_u8(compat as u8).map_err(RsyncError::from_stream)?;
			} else {
				w.write_varint(compat as i32).map_err(RsyncError::from_stream)?;
			}
			compat
		} else {
			let compat = r.read_varint().map_err(RsyncError::from_stream)? as u32;
			if compat & CF_VARINT_FLIST_FLAGS != 0 {
				negotiated_strings = true;
			}
			compat
		};
		proto.compat = compat;
		inc_recurse = compat & CF_INC_RECURSE != 0;
		if compat & CF_VARINT_FLIST_FLAGS == 0 && opts.preserve_crtimes {
			return Err(proto_error(
				"Both rsync versions must be at least 3.2.0 for --crtimes.".to_string(),
				764,
			));
		}
		receiver_symlink_times = if roles.am_sender {
			if roles.am_server { has(b'L') } else { compat & CF_SYMLINK_TIMES != 0 }
		} else {
			true
		};
		if inc_recurse && !s.allow_inc_recurse {
			let what = if roles.read_batch { "batch file" } else { "connection" };
			return Err(RsyncError::new(
				RERR_SYNTAX,
				format!("Incompatible options specified for inc-recursive {what}."),
			)
			.at("compat.c", 785));
		}
		opts.need_messages_from_generator = true;
	} else if !roles.am_sender {
		receiver_symlink_times = true;
	}
	if roles.read_batch {
		negotiated_strings = false;
	}

	let (xfer_sum, file_sum, compress, compress_level) =
		negotiate_the_strings(s, opts, proto, negotiated_strings, r, w)?;

	let seed = if roles.am_server {
		let seed = if opts.checksum_seed != 0 { opts.checksum_seed } else { time_seed() };
		w.write_int(seed).map_err(RsyncError::from_stream)?;
		seed
	} else {
		r.read_int().map_err(RsyncError::from_stream)?
	};
	w.flush().map_err(RsyncError::from_stream)?;
	if xfer_sum == CsumType::None {
		opts.whole_file = 1;
	}

	Ok(Negotiated {
		proto,
		inc_recurse,
		xfer_sum,
		file_sum,
		seed,
		compress,
		compress_level,
		receiver_symlink_times,
	})
}

/// Default checksum seed: `time ^ (pid << 6)`.
fn time_seed() -> i32 {
	(unix_now() as i32) ^ ((std::process::id() as i32).wrapping_shl(6))
}

/// The env list as upstream's `getenv_nstr` sees it (batch writers force the old choice).
fn nstr_env(s: &Setup<'_>, opts: &Options, compress: bool, protocol: u32) -> Option<String> {
	if opts.write_batch != 0 {
		return Some(
			if compress {
				"zlib"
			} else if protocol >= 30 {
				"md5"
			} else {
				"md4"
			}
			.to_string(),
		);
	}
	(s.getenv)(if compress { "RSYNC_COMPRESS_LIST" } else { "RSYNC_CHECKSUM_LIST" })
}

type Choices = (CsumType, CsumType, Compress, Option<i32>);

/// Upstream `negotiate_the_strings` + `parse_checksum_choice(1)` + `parse_compress_choice(1)`.
fn negotiate_the_strings(
	s: &Setup<'_>,
	opts: &Options,
	proto: Proto,
	negotiated: bool,
	r: &mut dyn Read,
	w: &mut dyn Write,
) -> Result<Choices, RsyncError> {
	let am_server = s.roles.am_server;
	let logger = s.logger;
	let debug_nstr = logger.levels().debug(Debug::Nstr);
	let (send_level, on) = if am_server { (3, "server") } else { (2, "client") };
	let who = if am_server { "Server" } else { "Client" };
	let peer = if am_server { "Client" } else { "Server" };

	let csum_env = nstr_env(s, opts, false, proto.version);
	let comp_env = nstr_env(s, opts, true, proto.version);
	let want_csum = opts.checksum_choice.is_none();
	let want_comp = opts.do_compression != 0 && opts.compress_choice.is_none();
	let csum_ours = checksum::checksum_list(csum_env.as_deref(), am_server);
	let comp_ours = token::compress_list(comp_env.as_deref(), am_server);

	for (wanted, kind, ours) in [(want_csum, "checksum", &csum_ours), (want_comp, "compress", &comp_ours)]
	{
		if !wanted {
			continue;
		}
		let list = ours.join(" ");
		if debug_nstr >= send_level {
			let line = format!("{who} {kind} list (on {on}): {list}\n");
			logger.rprintf(LogCode::Info, line.as_bytes());
		}
		if negotiated {
			w.write_vstring(list.as_bytes()).map_err(RsyncError::from_stream)?;
		}
	}
	if negotiated {
		w.flush().map_err(RsyncError::from_stream)?;
	}

	let mut recv = |kind: &str, ours: &[&'static str], fallback: &str| -> Result<String, RsyncError> {
		let theirs = if negotiated {
			r.read_vstring(MAX_NSTR_STRLEN, RERR_UNSUPPORTED, ("compat.c", 406))
				.map_err(RsyncError::from_stream)?
		} else {
			fallback.as_bytes().to_vec()
		};
		if debug_nstr >= send_level {
			let line = format!("{peer} {kind} list (on {on}): {}\n", String::from_utf8_lossy(&theirs));
			logger.rprintf(LogCode::Info, line.as_bytes());
		}
		checksum::pick(ours, &theirs, am_server).ok_or_else(|| {
			checksum::negotiate_failure(kind, ours, &theirs, am_server, negotiated)
		})
	};
	let csum_pick = if want_csum {
		let fallback = if proto.version >= 30 { "md5" } else { "md4" };
		Some(recv("checksum", csum_ours.as_slice(), fallback)?)
	} else {
		None
	};
	let comp_pick = if want_comp { Some(recv("compress", comp_ours.as_slice(), "zlib")?) } else { None };
	let (csum_pick, comp_pick) =
		if negotiated { (csum_pick, comp_pick) } else { (None, None) };

	// Checksums.
	let (xfer_sum, file_sum, csum_name) = match &csum_pick {
		Some(name) => {
			let kind = CsumType::from_name(name).unwrap_or(CsumType::default_for(proto));
			(kind, kind, name.clone())
		}
		None => {
			let choice = match &opts.checksum_choice {
				Some(text) => {
					let text = text.to_string_lossy();
					ChecksumChoice::parse(&text).map_err(|msg| {
						RsyncError::new(RERR_UNSUPPORTED, msg).at("checksum.c", 157)
					})?
				}
				None => ChecksumChoice::default(),
			};
			let (xfer, file) = choice.resolve(proto);
			if am_server && opts.checksum_choice.is_some() {
				let env = (s.getenv)("RSYNC_CHECKSUM_LIST");
				if !checksum::checksum_env_allows(env.as_deref(), xfer, file) {
					let shown = opts.checksum_choice.as_deref().map(|c| c.to_string_lossy().into_owned());
					return Err(checksum::choice_refused("checksum", &shown.unwrap_or_default()));
				}
			}
			let name = match &opts.checksum_choice {
				Some(text) => text.to_string_lossy().into_owned(),
				None => xfer.name().to_string(),
			};
			(xfer, file, name)
		}
	};
	if debug_nstr >= if am_server { 3 } else { 1 } {
		let neg = if csum_pick.is_some() { " negotiated" } else { "" };
		logger.rprintf(LogCode::Info, format!("{who}{neg} checksum: {csum_name}\n").as_bytes());
	}

	// Compression.
	let mut compress = match &comp_pick {
		Some(name) => Compress::from_name(name).unwrap_or(Compress::None),
		None => match &opts.compress_choice {
			Some(name) => Compress::from_name(&name.to_string_lossy()).unwrap_or(Compress::None),
			None if opts.do_compression != 0 => Compress::Zlib,
			None => Compress::None,
		},
	};
	let level = compress.effective_level(opts.do_compression_level);
	if compress != Compress::None && level.is_none() {
		compress = Compress::None;
	}
	if debug_nstr >= if am_server { 3 } else { 1 }
		&& (compress != Compress::None || opts.do_compression_level.is_some())
	{
		let neg = if comp_pick.is_some() { " negotiated" } else { "" };
		let shown_level = level.or(opts.do_compression_level).unwrap_or(i32::MIN);
		let line = format!("{who}{neg} compress: {} (level {shown_level})\n", compress.name());
		logger.rprintf(LogCode::Info, line.as_bytes());
	}
	let level = if compress == Compress::None { None } else { level };
	Ok((xfer_sum, file_sum, compress, level))
}

/// Reads the `--secluded-args` argv a client sends right after starting
/// `rsync --server -s …`: NUL-terminated strings, an empty one ends the list.
/// File arguments after the `.` separator are wildcard-expanded on this side
/// (upstream `read_args` + `glob_expand`, relative to `cwd`).
pub(crate) fn read_secluded_args(
	r: &mut dyn Read,
	fs: &pi_vfs::BlockingFs,
	cwd: &Path,
	max_alloc: u64,
) -> Result<Vec<OsString>, RsyncError> {
	let mut argv: Vec<Vec<u8>> = Vec::new();
	let mut total: u64 = 0;
	let mut after_dot = false;
	loop {
		let mut line = Vec::new();
		loop {
			let b = r.read_u8().map_err(RsyncError::from_stream)?;
			if b == 0 {
				break;
			}
			if line.len() >= MAX_ARG_LEN - 1 {
				return Err(RsyncError::new(RERR_PROTOCOL, "secluded argument too long")
					.at("io.c", 1500));
			}
			line.push(b);
		}
		if line.is_empty() {
			break;
		}
		total += line.len() as u64 + 1;
		if total > max_alloc {
			return Err(RsyncError::new(
				crate::rsync::exit::RERR_MALLOC,
				format!("[{}] exceeded --max-alloc={} setting (file=io.c, line=1510)", "server", max_alloc),
			)
			.at("util2.c", 80));
		}
		if after_dot {
			argv.extend(glob_expand(fs, cwd, &line));
		} else {
			if line == b"." {
				after_dot = true;
			}
			argv.push(line);
		}
	}
	Ok(argv.into_iter().map(vec_os_lossy).collect())
}

/// Upstream `glob_expand` (non-daemon): `*?[` components are matched against
/// directory entries (dot entries `.`/`..` skipped); an argument that matches
/// nothing is kept as given (cleaned).
pub(crate) fn glob_expand(fs: &pi_vfs::BlockingFs, cwd: &Path, arg: &[u8]) -> Vec<Vec<u8>> {
	use crate::rsync::paths::{
		CFN_COLLAPSE_DOT_DOT_DIRS, CFN_KEEP_DOT_DIRS, CFN_KEEP_TRAILING_SLASH, clean_fname_flags,
	};
	let flags = CFN_KEEP_DOT_DIRS | CFN_KEEP_TRAILING_SLASH | CFN_COLLAPSE_DOT_DOT_DIRS;
	let cleaned = clean_fname_flags(arg, flags).unwrap_or_else(|v| v);
	let mut out = Vec::new();
	glob_match(fs, cwd, &cleaned, Vec::new(), &mut out);
	if out.is_empty() {
		out.push(cleaned);
	}
	out
}

fn local_path(cwd: &Path, buf: &[u8]) -> PathBuf {
	if buf.is_empty() {
		return cwd.to_path_buf();
	}
	let p = bytes_os_lossy(buf);
	let p = Path::new(&p);
	if p.is_absolute() { p.to_path_buf() } else { cwd.join(p) }
}

fn glob_match(fs: &pi_vfs::BlockingFs, cwd: &Path, arg: &[u8], mut prefix: Vec<u8>, out: &mut Vec<Vec<u8>>) {
	let mut arg = arg;
	while arg.starts_with(b"./") {
		prefix.extend_from_slice(b"./");
		arg = &arg[2..];
	}
	let (part, rest) = match arg.iter().position(|&b| b == b'/') {
		Some(slash) => (&arg[..slash], Some(&arg[slash + 1..])),
		None => (arg, None),
	};
	if part.iter().any(|b| matches!(b, b'*' | b'?' | b'[')) {
		let Ok(dir) = fs.read_dir(local_path(cwd, &prefix)) else { return };
		for entry in dir.flatten() {
			let name = entry.file_name();
			let name = crate::host::os_bytes_lossy(&name).into_owned();
			if name == b"." || name == b".." {
				continue;
			}
			if !crate::rsync::wildmatch::wildmatch(part, &name) {
				continue;
			}
			glob_step(fs, cwd, &name, true, rest, prefix.clone(), out);
		}
	} else {
		glob_step(fs, cwd, part, false, rest, prefix, out);
	}
}

fn glob_step(
	fs: &pi_vfs::BlockingFs,
	cwd: &Path,
	name: &[u8],
	from_glob: bool,
	rest: Option<&[u8]>,
	mut prefix: Vec<u8>,
	out: &mut Vec<Vec<u8>>,
) {
	prefix.extend_from_slice(name);
	if from_glob || (rest.is_some() && !name.is_empty()) {
		let Ok(meta) = fs.metadata(local_path(cwd, &prefix)) else { return };
		if rest.is_some() && !meta.is_dir() {
			return;
		}
	}
	match rest {
		Some(rest) => {
			prefix.push(b'/');
			glob_match(fs, cwd, rest, prefix, out);
		}
		None => out.push(prefix),
	}
}

/// Turns a direction's byte counting on (upstream starts counting once a
/// direction is buffered).
pub(crate) fn start_out(w: &MuxWriter, multiplex: bool) -> Result<(), RsyncError> {
	w.set_counting(true);
	if multiplex {
		w.start_multiplex().map_err(RsyncError::from_stream)?;
	}
	Ok(())
}

/// Input side of [`start_out`]: buffered (raw) or multiplexed with `on_msg`.
pub(crate) fn start_in(
	r: &mut MuxReader,
	multiplex: bool,
	on_msg: Box<dyn FnMut(Msg) -> io::Result<()> + Send>,
) -> Result<(), RsyncError> {
	r.set_counting(true);
	if multiplex {
		r.start_multiplex(on_msg).map_err(RsyncError::from_stream)?;
	}
	Ok(())
}

/// `Setting --timeout=N to match server` (MSG_IO_TIMEOUT handling).
pub(crate) fn io_timeout_notice(logger: &Logger, secs: i32) {
	if logger.levels().info(Info::Misc) >= 2 {
		logger.rprintf(LogCode::Info, format!("Setting --timeout={secs} to match server\n").as_bytes());
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn logger() -> Logger {
		Logger::local(Box::new(io::sink()), Box::new(io::sink()), Default::default())
	}

	fn opts() -> Options {
		Options { protocol_version: 33, ..Options::default() }
	}

	fn setup<'a>(roles: Roles, info: &'a [u8], env: &'a dyn Fn(&str) -> Option<String>, l: &'a Logger) -> Setup<'a> {
		Setup {
			roles,
			client_info: info,
			remote_protocol: None,
			allow_inc_recurse: true,
			batch_flags: None,
			getenv: env,
			logger: l,
		}
	}

	const CLIENT: Roles =
		Roles { am_server: false, am_sender: true, local_server: false, read_batch: false, write_batch: false };
	const SERVER: Roles =
		Roles { am_server: true, am_sender: false, local_server: false, read_batch: false, write_batch: false };

	/// Server half of protocol 33 with the client caps rsync 3.5.1 sends.
	#[test]
	fn server_writes_version_compat_lists_and_seed() {
		let l = logger();
		let env = |_: &str| None;
		let s = setup(SERVER, b".iLsfxCIvu", &env, &l);
		let mut o = Options { checksum_seed: 7, ..opts() };
		// Client side: version 33, then its checksum list.
		let mut input = Vec::new();
		input.write_int(33).unwrap();
		input.write_vstring(b"xxh128 xxh3 xxh64 md5 md4 sha1").unwrap();
		let mut out = Vec::new();
		let n = setup_protocol(&s, &mut o, &mut &input[..], &mut out).unwrap();
		assert_eq!(n.proto.version, 33);
		assert_eq!(n.xfer_sum, CsumType::Xxh128);
		assert_eq!(n.seed, 7);
		assert!(n.inc_recurse);
		let mut r = &out[..];
		assert_eq!(r.read_int().unwrap(), 33);
		let compat = r.read_varint().unwrap() as u32;
		assert_eq!(compat & CF_INC_RECURSE, CF_INC_RECURSE);
		assert_eq!(compat & CF_VARINT_FLIST_FLAGS, CF_VARINT_FLIST_FLAGS);
		assert_eq!(compat & CF_CHKSUM_SEED_FIX, CF_CHKSUM_SEED_FIX);
		assert_eq!(
			r.read_vstring(MAX_NSTR_STRLEN, RERR_UNSUPPORTED, ("compat.c", 406)).unwrap(),
			b"xxh128 xxh3 xxh64 md5 md4 sha1 none"
		);
		assert_eq!(r.read_int().unwrap(), 7);
		assert!(r.is_empty());
	}

	#[test]
	fn client_reads_protocol_29_peer_without_negotiation() {
		let l = logger();
		let env = |_: &str| None;
		let s = setup(CLIENT, b"", &env, &l);
		let mut o = opts();
		let mut input = Vec::new();
		input.write_int(29).unwrap();
		input.write_int(1234).unwrap();
		let mut out = Vec::new();
		let n = setup_protocol(&s, &mut o, &mut &input[..], &mut out).unwrap();
		assert_eq!(n.proto.version, 29);
		assert_eq!(n.xfer_sum, CsumType::Md4Old);
		assert_eq!(n.seed, 1234);
		assert!(!n.receiver_symlink_times);
		assert_eq!(out, 33i32.to_le_bytes());
	}

	#[test]
	fn old_peer_is_a_protocol_mismatch() {
		let l = logger();
		let env = |_: &str| None;
		let s = setup(CLIENT, b"", &env, &l);
		let mut input = Vec::new();
		input.write_int(28).unwrap();
		let err = setup_protocol(&s, &mut opts(), &mut &input[..], &mut Vec::new()).unwrap_err();
		assert_eq!(err.code, RERR_PROTOCOL);
		assert_eq!(err.site, Some(("compat.c", 625)));
		assert!(err.message.unwrap().starts_with("protocol version mismatch"));
	}

	#[test]
	fn protocol_option_range() {
		let l = logger();
		let env = |_: &str| None;
		let s = setup(CLIENT, b"", &env, &l);
		// A peer started with the same --protocol (a local copy's server half).
		let mut input = Vec::new();
		input.write_int(40).unwrap();
		let mut o = Options { protocol_version: 40, ..opts() };
		let err = setup_protocol(&s, &mut o, &mut &input[..], &mut Vec::new()).unwrap_err();
		assert_eq!(err.message.as_deref(), Some("--protocol must be no more than 33 on the Client."));
		assert_eq!(err.site, Some(("compat.c", 639)));
		let mut input = Vec::new();
		input.write_int(33).unwrap();
		let mut o = Options { protocol_version: 28, ..opts() };
		let err = setup_protocol(&s, &mut o, &mut &input[..], &mut Vec::new()).unwrap_err();
		assert_eq!(err.message.as_deref(), Some("--protocol must be at least 29 on the Client."));
	}

	#[test]
	fn failed_negotiation_lists_both_sides() {
		let l = logger();
		let env = |_: &str| None;
		let s = setup(CLIENT, b"", &env, &l);
		let mut input = Vec::new();
		input.write_int(33).unwrap();
		input.write_varint((CF_INC_RECURSE | CF_VARINT_FLIST_FLAGS) as i32).unwrap();
		input.write_vstring(b"bogus").unwrap();
		let err = setup_protocol(&s, &mut opts(), &mut &input[..], &mut Vec::new()).unwrap_err();
		assert_eq!(err.code, RERR_UNSUPPORTED);
		assert!(err.message.unwrap().starts_with("Failed to negotiate a checksum choice."));
	}

	#[test]
	fn local_client_info_takes_the_e_option() {
		let o = Options { recurse: 1, args: vec!["a".into(), "b".into()], ..opts() };
		let info = local_client_info(&o, false);
		assert!(info.starts_with(b"."), "{:?}", String::from_utf8_lossy(&info));
		assert!(info.contains(&b'v'));
	}

	#[test]
	fn sub_protocol_lowering() {
		let mut p = 33;
		check_sub_protocol(&mut p, b".iLsfxCIvu");
		assert_eq!(p, 33);
		let mut p = 33;
		check_sub_protocol(&mut p, b"32.1");
		assert_eq!(p, 31);
	}

	#[test]
	fn glob_expansion_matches_entries_and_keeps_misses() {
		let dir = tempfile::tempdir().unwrap();
		std::fs::write(dir.path().join("a1"), b"").unwrap();
		std::fs::write(dir.path().join("a2"), b"").unwrap();
		std::fs::create_dir(dir.path().join("d")).unwrap();
		std::fs::write(dir.path().join("d/x"), b"").unwrap();
		let fs = crate::host::ShellPaths::default().fs().clone();
		let mut got = glob_expand(&fs, dir.path(), b"a*");
		got.sort();
		assert_eq!(got, vec![b"a1".to_vec(), b"a2".to_vec()]);
		assert_eq!(glob_expand(&fs, dir.path(), b"?/x"), vec![b"d/x".to_vec()]);
		assert_eq!(glob_expand(&fs, dir.path(), b"zz*"), vec![b"zz*".to_vec()]);
	}

	#[test]
	fn secluded_args_stream() {
		let dir = tempfile::tempdir().unwrap();
		let fs = crate::host::ShellPaths::default().fs().clone();
		let data = b"rsync\0--server\0-r\0.\0src/\0\0";
		let argv = read_secluded_args(&mut &data[..], &fs, dir.path(), 1 << 20).unwrap();
		let want: Vec<OsString> = ["rsync", "--server", "-r", ".", "src/"].iter().map(OsString::from).collect();
		assert_eq!(argv, want);
	}
}
