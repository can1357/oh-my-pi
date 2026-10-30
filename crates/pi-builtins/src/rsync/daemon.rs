//! Client half of the rsync daemon protocol (`@RSYNCD:`), over TCP or over a
//! remote shell running `rsync --server --daemon .`.
//!
//! The exchange, line by line: both sides send `@RSYNCD: <proto>.<sub>
//! <digest names>`; the client may send `#early_input=N` plus N bytes, then
//! the module name; the daemon answers with MOTD/listing lines and finally
//! `@RSYNCD: OK`, `@RSYNCD: EXIT`, `@RSYNCD: AUTHREQD <challenge>` (we answer
//! `<user> <base64 digest>`), or `@ERROR…`. After `OK` the client sends the
//! server arguments (NUL-terminated from protocol 30, newline-terminated
//! before) and, for `--secluded-args`, the protected arguments.

use std::{
	ffi::OsString,
	io::{self, Read, Write as _},
	path::Path,
	time::{Duration, Instant},
};

use base64::Engine as _;
use sha2::Digest;

use crate::{
	host::os_bytes_lossy,
	rsync::{
		consts::BIGPATHBUFLEN,
		exit::{
			RERR_CONTIMEOUT, RERR_STARTCLIENT, RERR_STREAMIO, RERR_SYNTAX,
			RERR_UNSUPPORTED, RsyncError,
		},
		log::{Debug, LogCode, Logger, Role, syserr_text},
		paths,
		transport::{ConnCtl, Connection, child_argv_line, secluded_stream, truncate},
	},
};

/// Our daemon-auth digests, strongest first (the order we prefer and announce).
const AUTH_DIGESTS: [AuthDigest; 5] =
	[AuthDigest::Sha512, AuthDigest::Sha256, AuthDigest::Sha1, AuthDigest::Md5, AuthDigest::Md4];
/// Longest negotiation string upstream keeps (`MAX_NSTR_STRLEN` - 1).
const MAX_NSTR: usize = 255;
/// Longest password upstream reads from a password file.
const PASSWORD_MAX: usize = 511;

/// A daemon-auth digest (`valid_auth_checksums`), plus the pre-negotiation MD4
/// variant (seeded with four zero bytes) used when the daemon names none
/// before protocol 30.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AuthDigest {
	Sha512,
	Sha256,
	Sha1,
	Md5,
	Md4,
	Md4Old,
}

impl AuthDigest {
	/// The negotiation name.
	pub(crate) const fn name(self) -> &'static str {
		match self {
			Self::Sha512 => "sha512",
			Self::Sha256 => "sha256",
			Self::Sha1 => "sha1",
			Self::Md5 => "md5",
			Self::Md4 | Self::Md4Old => "md4",
		}
	}

	/// `base64(digest(password ‖ challenge))` without padding.
	pub(crate) fn response(self, password: &[u8], challenge: &[u8]) -> String {
		fn hash<D: Digest>(prefix: &[u8], password: &[u8], challenge: &[u8]) -> Vec<u8> {
			D::new().chain_update(prefix).chain_update(password).chain_update(challenge).finalize().to_vec()
		}
		let sum = match self {
			Self::Sha512 => hash::<sha2::Sha512>(&[], password, challenge),
			Self::Sha256 => hash::<sha2::Sha256>(&[], password, challenge),
			Self::Sha1 => hash::<sha1::Sha1>(&[], password, challenge),
			Self::Md5 => hash::<md5::Md5>(&[], password, challenge),
			Self::Md4 => hash::<md4::Md4>(&[], password, challenge),
			Self::Md4Old => hash::<md4::Md4>(&[0; 4], password, challenge),
		};
		base64::engine::general_purpose::STANDARD_NO_PAD.encode(sum)
	}
}

/// Our digest list as announced in the greeting.
fn our_digest_list() -> String {
	AUTH_DIGESTS.iter().map(|d| d.name()).collect::<Vec<_>>().join(" ")
}

/// Picks the digest we like best among those the daemon lists (names match
/// case-insensitively, separated by spaces).
fn negotiate_digest(theirs: &str) -> Option<AuthDigest> {
	theirs
		.split(' ')
		.filter(|tok| !tok.is_empty())
		.filter_map(|tok| AUTH_DIGESTS.iter().position(|d| d.name().eq_ignore_ascii_case(tok)))
		.min()
		.map(|rank| AUTH_DIGESTS[rank])
}

/// Daemon handshake settings.
pub(crate) struct DaemonConfig<'a> {
	/// User from the URL / host spec; else `USER`, else `LOGNAME`; `nobody`
	/// when none is known at authentication time.
	pub user:                    Option<&'a str>,
	/// The remote operands, module first (`mod/path`, …).
	pub args:                    &'a [OsString],
	/// `options::server_args_split` evaluated for the protocol negotiated in
	/// the greeting: the server options after `--server [--sender]`, and the
	/// `--secluded-args` cut.
	pub server_args:             &'a dyn Fn(u32) -> (Vec<OsString>, Option<usize>),
	/// The daemon side sends (adds `--sender`).
	pub remote_is_sender:        bool,
	/// Our protocol version (`--protocol` or 33).
	pub protocol:                u32,
	/// `--old-args`: no `[ ]` protection against module-name splitting.
	pub old_args:                bool,
	/// Print MOTD (and module listing) lines; `--no-motd` clears it.
	pub output_motd:             bool,
	/// `--password-file` (`-` reads a line from stdin).
	pub password_file:           Option<&'a Path>,
	/// `--early-input`.
	pub early_input:             Option<&'a Path>,
	pub fs:                      &'a pi_vfs::BlockingFs,
	/// Skip the trusted-owner walk for operator files.
	pub insecure_operator_files: bool,
	/// The shell's environment (`USER`, `LOGNAME`, `RSYNC_PASSWORD`).
	pub getenv:                  &'a dyn Fn(&str) -> Option<String>,
	/// Reads one line from stdin (for `--password-file=-`); None = no stdin.
	pub read_stdin_line:         Option<&'a dyn Fn() -> io::Result<Vec<u8>>>,
	/// `--contimeout` deadline for a daemon over a remote shell, computed
	/// before the shell was spawned (upstream bounds spawn + greeting with it).
	pub connect_deadline:        Option<Instant>,
	/// `--timeout`.
	pub io_timeout:              Option<Duration>,
}

/// What the handshake established.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DaemonSession {
	/// The daemon's protocol number (the binary version exchange is skipped
	/// for daemon connections; handshake.rs validates this value).
	pub remote_protocol: u32,
	pub remote_sub:      u32,
	/// Our protocol after the greeting adjustment.
	pub protocol:        u32,
	/// The daemon's digest list from its greeting.
	pub auth_choices:    Option<String>,
	/// The digest used to authenticate, when the daemon asked.
	pub auth_digest:     Option<AuthDigest>,
	/// The daemon ended the session with `@RSYNCD: EXIT` (module listing):
	/// the client exits 0 without a transfer.
	pub exited:          bool,
}

/// Clears the connection's handshake limits however the handshake ends.
struct LimitsGuard(ConnCtl);

impl Drop for LimitsGuard {
	fn drop(&mut self) {
		self.0.set_deadline(None);
		self.0.set_idle_timeout(None);
	}
}

fn startclient(message: impl Into<String>) -> RsyncError {
	RsyncError::new(RERR_STARTCLIENT, message).at("main.c", 1981)
}

/// Client half of the @RSYNCD handshake: greeting/version exchange, module request, auth
/// (password file / RSYNC_PASSWORD, digest negotiation), motd, sending the server args
/// (and secluded args). Returns the remote protocol version and digest choice.
pub(crate) fn daemon_handshake(
	conn: &mut Connection,
	cfg: &DaemonConfig<'_>,
	logger: &Logger,
) -> Result<DaemonSession, RsyncError> {
	let role = logger.role();
	let empty = OsString::new();
	let first = cfg.args.first().unwrap_or(&empty);
	let first = os_bytes_lossy(first).into_owned();
	if first.first() == Some(&b'/') {
		return Err(startclient("ERROR: The remote path must start with a module name"));
	}
	let module = &first[..first.iter().position(|&b| b == b'/').unwrap_or(first.len())];

	let _limits = LimitsGuard(conn.ctl.clone());
	if let Some(at) = cfg.connect_deadline {
		let expired = RsyncError::new(
			RERR_CONTIMEOUT,
			format!("[{}] connection timed out -- exiting", role.name()),
		)
		.at("io.c", 173);
		conn.ctl.set_deadline(Some((at, expired)));
	}
	if let Some(timeout) = cfg.io_timeout {
		conn.ctl.set_idle_timeout(Some((timeout, role)));
	}

	let user = cfg
		.user
		.map(str::to_owned)
		.or_else(|| (cfg.getenv)("USER"))
		.or_else(|| (cfg.getenv)("LOGNAME"));

	// Greeting exchange.
	let ours = our_digest_list();
	send(conn, format!("@RSYNCD: {}.0 {ours}\n", cfg.protocol).as_bytes(), role)?;
	if logger.levels().debug(Debug::Nstr) >= 2 {
		let line = format!("Client daemon auth checksum list (on client): {ours}\n");
		logger.rprintf(LogCode::Info, line.as_bytes());
	}
	let Some(greeting) = read_line(conn, role)? else {
		return Err(startclient("rsync: did not see server greeting"));
	};
	let shown = String::from_utf8_lossy(&greeting).into_owned();
	let Some((remote_protocol, remote_sub)) = parse_greeting(&greeting) else {
		return Err(startclient(format!("rsync: server sent \"{shown}\" rather than greeting")));
	};
	let remote_sub = match remote_sub {
		Some(sub) => sub,
		None if remote_protocol >= 30 => {
			return Err(startclient(format!(
				"rsync: the server omitted the subprotocol value: {shown}"
			)));
		}
		None => 0,
	};
	let auth_choices = greeting
		.get(9..)
		.and_then(|tail| tail.iter().position(|&b| b == b' ').map(|at| &tail[at + 1..]))
		.map(|list| String::from_utf8_lossy(list).into_owned());
	if auth_choices.is_none() && remote_protocol > 31 {
		return Err(startclient(format!("rsync: the server omitted the digest name list: {shown}")));
	}
	let remote = u32::try_from(remote_protocol).unwrap_or(0);
	let mut protocol = cfg.protocol;
	if protocol > remote {
		protocol = remote;
		if remote_sub != 0 {
			protocol = protocol.saturating_sub(1);
		}
	} else if protocol == remote && remote_sub != 0 {
		protocol = protocol.saturating_sub(1);
	}

	if let Some(path) = cfg.early_input {
		send_early_input(conn, cfg, path, role)?;
	}

	// The server argv: --server [--sender] OPTIONS . ARGS (module args protected).
	let (tail, cut) = (cfg.server_args)(protocol);
	let mut sargs: Vec<Vec<u8>> = vec![b"--server".to_vec()];
	if cfg.remote_is_sender {
		sargs.push(b"--sender".to_vec());
	}
	let prefix = sargs.len();
	let cut = cut.map(|c| prefix + c.min(tail.len()));
	sargs.extend(tail.iter().map(|a| os_bytes_lossy(a).into_owned()));
	sargs.push(b".".to_vec());
	let args: Vec<Vec<u8>> = if cfg.args.is_empty() {
		vec![Vec::new()]
	} else {
		cfg.args.iter().map(|a| os_bytes_lossy(a).into_owned()).collect()
	};
	sargs.extend(args.iter().map(|arg| daemon_arg(arg, module, cfg.old_args)));
	let visible = cut.unwrap_or(sargs.len());
	if logger.levels().debug(Debug::Cmd) >= 1 {
		let refs: Vec<&[u8]> = sargs[..visible].iter().map(Vec::as_slice).collect();
		logger.rprintf(LogCode::Client, &child_argv_line("sending daemon args:", &refs));
	}

	let mut request = module.to_vec();
	request.push(b'\n');
	send(conn, &request, role)?;

	let mut auth_digest = None;
	loop {
		let Some(line) = read_line(conn, role)? else {
			return Err(startclient("rsync: didn't get server startup line"));
		};
		if let Some(challenge) = line.strip_prefix(b"@RSYNCD: AUTHREQD ") {
			let choices = auth_choices.as_deref();
			let (digest, reply) =
				auth_reply(cfg, user.as_deref(), challenge, protocol, choices, logger)?;
			send(conn, &reply, role)?;
			auth_digest = Some(digest);
			continue;
		}
		if line == b"@RSYNCD: OK" {
			break;
		}
		if line == b"@RSYNCD: EXIT" {
			return Ok(DaemonSession {
				remote_protocol: remote,
				remote_sub: u32::try_from(remote_sub).unwrap_or(0),
				protocol,
				auth_choices,
				auth_digest,
				exited: true,
			});
		}
		if line.starts_with(b"@ERROR") {
			return Err(startclient(String::from_utf8_lossy_owned(line)));
		}
		if cfg.output_motd {
			let mut text = line;
			text.push(b'\n');
			logger.rprintf(LogCode::Info, &text);
		}
	}

	let mut out = Vec::new();
	for arg in &sargs[..visible] {
		out.extend_from_slice(arg);
		out.push(if protocol >= 30 { 0 } else { b'\n' });
	}
	out.push(if protocol >= 30 { 0 } else { b'\n' });
	if let Some(cut) = cut {
		let mut secluded = vec![b"rsync".to_vec()];
		secluded.extend(sargs[cut..].iter().cloned());
		out.extend_from_slice(&secluded_stream(&secluded));
	}
	send(conn, &out, role)?;

	Ok(DaemonSession {
		remote_protocol: remote,
		remote_sub: u32::try_from(remote_sub).unwrap_or(0),
		protocol,
		auth_choices,
		auth_digest,
		exited: false,
	})
}

/// One server argument as sent to a daemon: the bare module becomes `mod/`,
/// a leading `-` gains `./`, and (unless `--old-args`) every ` mod/` inside an
/// argument becomes `[ ]mod/` so the daemon cannot split it at the module.
fn daemon_arg(arg: &[u8], module: &[u8], old_args: bool) -> Vec<u8> {
	if arg == module {
		let mut out = module.to_vec();
		out.push(b'/');
		return out;
	}
	let mut out = Vec::with_capacity(arg.len() + 4);
	if arg.first() == Some(&b'-') {
		out.extend_from_slice(b"./");
	}
	let mut marker = Vec::with_capacity(module.len() + 2);
	marker.push(b' ');
	marker.extend_from_slice(module);
	marker.push(b'/');
	for (i, &b) in arg.iter().enumerate() {
		if !old_args && b == b' ' && arg[i..].starts_with(&marker) {
			out.extend_from_slice(b"[ ]");
		} else {
			out.push(b);
		}
	}
	out
}

/// `sscanf(line, "@RSYNCD: %d.%d")`: the protocol, and the subprotocol when
/// present.
fn parse_greeting(line: &[u8]) -> Option<(i32, Option<i32>)> {
	let rest = line.strip_prefix(b"@RSYNCD:")?;
	let (proto, rest) = scan_int(rest)?;
	let sub = rest.strip_prefix(b".").and_then(scan_int).map(|(sub, _)| sub);
	Some((proto, sub))
}

/// `%d`: optional whitespace, optional sign, at least one digit.
fn scan_int(s: &[u8]) -> Option<(i32, &[u8])> {
	let s = s.trim_ascii_start();
	let mut i = 0;
	let negative = match s.get(i) {
		Some(b'-') => {
			i += 1;
			true
		}
		Some(b'+') => {
			i += 1;
			false
		}
		_ => false,
	};
	let digits = i;
	let mut value: i64 = 0;
	while let Some(d) = s.get(i).filter(|b| b.is_ascii_digit()) {
		value = value.saturating_mul(10).saturating_add(i64::from(d - b'0'));
		i += 1;
	}
	if i == digits {
		return None;
	}
	let value = if negative { -value } else { value };
	Some((value.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32, &s[i..]))
}

/// Builds the `user digest` reply to an auth challenge.
fn auth_reply(
	cfg: &DaemonConfig<'_>,
	user: Option<&str>,
	challenge: &[u8],
	protocol: u32,
	choices: Option<&str>,
	logger: &Logger,
) -> Result<(AuthDigest, Vec<u8>), RsyncError> {
	let user = user.filter(|u| !u.is_empty()).unwrap_or("nobody");
	let (list, implied) = match choices {
		Some(list) => (truncate(list, MAX_NSTR).to_owned(), false),
		None => ((if protocol >= 30 { "md5" } else { "md4" }).to_owned(), true),
	};
	if logger.levels().debug(Debug::Nstr) >= 2 {
		let line = format!("Server daemon auth checksum list (on client): {list}\n");
		logger.rprintf(LogCode::Info, line.as_bytes());
	}
	let Some(mut digest) = negotiate_digest(&list) else {
		return Err(RsyncError::new(
			RERR_UNSUPPORTED,
			format!(
				"Failed to negotiate a daemon auth checksum choice.\nServer list: {list}\nClient \
				 list: {}",
				our_digest_list()
			),
		)
		.at("compat.c", 406));
	};
	if implied && digest == AuthDigest::Md4 {
		digest = AuthDigest::Md4Old;
	}
	if logger.levels().debug(Debug::Nstr) >= 1 {
		let line = format!("Client negotiated daemon auth checksum: {}\n", digest.name());
		logger.rprintf(LogCode::Info, line.as_bytes());
	}
	let password = password(cfg, logger.role())?;
	let mut reply = format!("{user} ").into_bytes();
	reply.extend_from_slice(digest.response(&password, challenge).as_bytes());
	reply.push(b'\n');
	Ok((digest, reply))
}

/// The password: `--password-file`, else `RSYNC_PASSWORD`, else empty (no
/// terminal to prompt on; upstream's `getpass` fails the same way).
fn password(cfg: &DaemonConfig<'_>, role: Role) -> Result<Vec<u8>, RsyncError> {
	if let Some(path) = cfg.password_file {
		return read_password_file(cfg, path, role);
	}
	if let Some(pass) = (cfg.getenv)("RSYNC_PASSWORD") {
		return Ok(pass.into_bytes());
	}
	Ok(Vec::new())
}

fn auth_error(message: impl Into<String>, line: u32) -> RsyncError {
	RsyncError::new(RERR_SYNTAX, message).at("authenticate.c", line)
}

/// Reads the first line of the password file with upstream's checks.
fn read_password_file(
	cfg: &DaemonConfig<'_>,
	path: &Path,
	role: Role,
) -> Result<Vec<u8>, RsyncError> {
	let shown = path.to_string_lossy();
	let content = if path.as_os_str() == "-" {
		match cfg.read_stdin_line {
			Some(read) => {
				let mut line = read().unwrap_or_default();
				line.truncate(PASSWORD_MAX);
				line
			}
			None => Vec::new(),
		}
	} else {
		let mut file = paths::open_operator_file(cfg.fs, path, cfg.insecure_operator_files)
			.map_err(|err| {
				auth_error(syserr_text(role, &err, &format!("could not open password file {shown}")), 247)
			})?;
		let meta = file
			.metadata()
			.map_err(|err| auth_error(syserr_text(role, &err, &format!("fstat({shown})")), 257))?;
		#[cfg(unix)]
		{
			if meta.mode() & 0o006 != 0 {
				return Err(auth_error("ERROR: password file must not be other-accessible", 261));
			}
			if crate::rsync::ids::effective_uid() == Some(0) && meta.uid().is_some_and(|uid| uid != 0) {
				return Err(auth_error(
					"ERROR: password file must be owned by root when running as root",
					265,
				));
			}
		}
		#[cfg(not(unix))]
		let _ = meta;
		let mut buf = vec![0u8; PASSWORD_MAX];
		let mut len = 0;
		while len < buf.len() {
			match file.read(&mut buf[len..]) {
				Ok(0) => break,
				Ok(n) => len += n,
				Err(err) if err.kind() == io::ErrorKind::Interrupted => {}
				Err(_) => break,
			}
		}
		buf.truncate(len);
		buf
	};
	first_token(&content)
		.map(<[u8]>::to_vec)
		.ok_or_else(|| auth_error(format!("ERROR: failed to read a password from {shown}"), 279))
}

/// `strtok(buf, "\n\r")`: the first run of bytes that are not CR/LF (a NUL
/// ends the buffer).
fn first_token(content: &[u8]) -> Option<&[u8]> {
	let content = &content[..content.iter().position(|&b| b == 0).unwrap_or(content.len())];
	let start = content.iter().position(|&b| b != b'\n' && b != b'\r')?;
	let rest = &content[start..];
	let end = rest.iter().position(|&b| b == b'\n' || b == b'\r').unwrap_or(rest.len());
	Some(&rest[..end])
}

/// `--early-input=FILE`: `#early_input=N\n` and N bytes, before the module.
fn send_early_input(
	conn: &mut Connection,
	cfg: &DaemonConfig<'_>,
	path: &Path,
	role: Role,
) -> Result<(), RsyncError> {
	let shown = path.to_string_lossy();
	let open_failed =
		|err: &io::Error| startclient(syserr_text(role, err, &format!("failed to open {shown}")));
	let mut file = paths::open_operator_file(cfg.fs, path, cfg.insecure_operator_files)
		.map_err(|e| open_failed(&e))?;
	let len = file.metadata().map_err(|e| open_failed(&e))?.len();
	if len > BIGPATHBUFLEN as u64 {
		return Err(startclient(format!("{shown} is > {BIGPATHBUFLEN} bytes.")));
	}
	if len == 0 {
		return Ok(());
	}
	let len = usize::try_from(len).unwrap_or(BIGPATHBUFLEN);
	let mut data = vec![0u8; len];
	let mut got = 0;
	while got < len {
		match file.read(&mut data[got..]) {
			Ok(0) => return Err(startclient(format!("Early EOF in {shown}"))),
			Ok(n) => got += n,
			Err(err) if err.kind() == io::ErrorKind::Interrupted => {}
			Err(_) => return Err(startclient(format!("Early EOF in {shown}"))),
		}
	}
	let mut out = format!("#early_input={len}\n").into_bytes();
	out.extend_from_slice(&data);
	send(conn, &out, role)
}

/// Maps a handshake I/O failure: limits and cancellation carry their exit;
/// anything else is upstream's safe_read/safe_write failure.
fn io_failure(err: &io::Error, role: Role, text: String, line: u32) -> RsyncError {
	if err.get_ref().is_some_and(|inner| inner.is::<RsyncError>()) {
		return RsyncError::from_io(err, RERR_STREAMIO);
	}
	RsyncError::new(RERR_STREAMIO, syserr_text(role, err, &text)).at("io.c", line)
}

fn send(conn: &mut Connection, bytes: &[u8], role: Role) -> Result<(), RsyncError> {
	conn.writer.write_all(bytes).and_then(|()| conn.writer.flush()).map_err(|err| {
		io_failure(&err, role, format!("safe_write failed to write {} bytes to socket", bytes.len()), 405)
	})
}

/// One handshake line, read a byte at a time so nothing after it is
/// consumed; CRs are dropped and the newline stripped. None on EOF, on a NUL
/// byte, or when the line does not fit upstream's buffer.
fn read_line(conn: &mut Connection, role: Role) -> Result<Option<Vec<u8>>, RsyncError> {
	let mut line = Vec::new();
	let mut room = BIGPATHBUFLEN - 1;
	while room > 0 {
		let mut byte = [0u8; 1];
		match conn.reader.read(&mut byte) {
			Ok(0) => return Ok(None),
			Ok(_) => {}
			Err(err) if err.kind() == io::ErrorKind::Interrupted => continue,
			Err(err) => {
				return Err(io_failure(&err, role, "safe_read failed to read 1 bytes".to_owned(), 358));
			}
		}
		match byte[0] {
			0 => return Ok(None),
			b'\n' => return Ok(Some(line)),
			b'\r' => {}
			b => {
				line.push(b);
				room -= 1;
			}
		}
	}
	Ok(None)
}

#[cfg(test)]
mod tests {
	use std::{
		io::{BufRead, BufReader, Write},
		sync::{
			Arc, Mutex,
			atomic::{AtomicBool, Ordering},
		},
	};

	use super::*;
	use crate::rsync::{
		log::LogConfig,
		transport::{Connection, local_pair},
	};

	const PASSWORD: &[u8] = b"s3cr3t pw";
	const CHALLENGE: &[u8] = b"Zm9vYmFyY2hhbGxlbmdl";

	/// Responses rsync 3.5.1 sent for user `alice`, password `s3cr3t pw`, and
	/// challenge `Zm9vYmFyY2hhbGxlbmdl`, captured with a scripted daemon.
	#[test]
	fn auth_digests_match_reference() {
		let cases = [
			(AuthDigest::Sha512, "y3QZtV4pHrsWxIfOb0oa3XPXlWzhK+f0ufdJ4PqL6upCbhMeNLCEeT7nAdhA8A62O0eTQ4dQVbbZsDUhVeBg3g"),
			(AuthDigest::Sha256, "6S8beeuwotxb9K9cGFpBb5Lnf6lwArEwZ2ou9MGyrKY"),
			(AuthDigest::Sha1, "+Y8wJbvJCuEhZkmXAv5HMoLFXto"),
			(AuthDigest::Md5, "mFmkURRGpj4uE75At8s0NA"),
			(AuthDigest::Md4, "R13iUcenasvwOW8Ypf3gWw"),
			(AuthDigest::Md4Old, "ygINi3LU4TN+fbN7xpZg+Q"),
		];
		for (digest, want) in cases {
			assert_eq!(digest.response(PASSWORD, CHALLENGE), want, "{digest:?}");
		}
	}

	#[test]
	fn digest_negotiation_prefers_our_order() {
		assert_eq!(negotiate_digest("md5 sha256"), Some(AuthDigest::Sha256));
		assert_eq!(negotiate_digest("SHA1 md5"), Some(AuthDigest::Sha1));
		assert_eq!(negotiate_digest("  md4  "), Some(AuthDigest::Md4));
		assert_eq!(negotiate_digest("xxh128 foo"), None);
		assert_eq!(negotiate_digest(""), None);
		assert_eq!(our_digest_list(), "sha512 sha256 sha1 md5 md4");
	}

	#[test]
	fn greeting_parsing_follows_sscanf() {
		assert_eq!(parse_greeting(b"@RSYNCD: 33.0 sha512"), Some((33, Some(0))));
		assert_eq!(parse_greeting(b"@RSYNCD:31.2"), Some((31, Some(2))));
		assert_eq!(parse_greeting(b"@RSYNCD: 29"), Some((29, None)));
		assert_eq!(parse_greeting(b"@RSYNCD: x"), None);
		assert_eq!(parse_greeting(b"SSH-2.0"), None);
	}

	#[test]
	fn daemon_args_protect_module_boundaries() {
		assert_eq!(daemon_arg(b"mod", b"mod", false), b"mod/");
		assert_eq!(daemon_arg(b"mod/a mod/b", b"mod", false), b"mod/a[ ]mod/b");
		assert_eq!(daemon_arg(b"mod/a mod/b", b"mod", true), b"mod/a mod/b");
		assert_eq!(daemon_arg(b"-x y", b"-x y", false), b"-x y/");
		assert_eq!(daemon_arg(b" -mod/z", b"-x y", false), b" -mod/z");
		assert_eq!(daemon_arg(b"-a", b"m", false), b"./-a");
	}

	#[test]
	fn password_file_token_rules() {
		assert_eq!(first_token(b"\n\r secret\nnext"), Some(&b" secret"[..]));
		assert_eq!(first_token(b"pw\0hidden"), Some(&b"pw"[..]));
		assert_eq!(first_token(b"\n\n"), None);
		assert_eq!(first_token(b""), None);
	}

	type Captured = Arc<Mutex<Vec<u8>>>;

	fn test_logger() -> (Logger, Captured, Captured) {
		struct Shared(Captured);
		impl Write for Shared {
			fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
				self.0.lock().unwrap().extend_from_slice(buf);
				Ok(buf.len())
			}

			fn flush(&mut self) -> io::Result<()> {
				Ok(())
			}
		}
		let out = Arc::new(Mutex::new(Vec::new()));
		let err = Arc::new(Mutex::new(Vec::new()));
		let logger = Logger::local(
			Box::new(Shared(Arc::clone(&out))),
			Box::new(Shared(Arc::clone(&err))),
			LogConfig::default(),
		)
		.with_role(Role::PreReceiver);
		(logger, out, err)
	}

	fn no_env(_: &str) -> Option<String> {
		None
	}

	fn server_args(proto: u32) -> (Vec<OsString>, Option<usize>) {
		if proto >= 30 { (vec![OsString::from("-de.LsfxCIvu")], None) } else { (Vec::new(), None) }
	}

	fn base_cfg<'a>(args: &'a [OsString], fs: &'a pi_vfs::BlockingFs) -> DaemonConfig<'a> {
		DaemonConfig {
			user: Some("alice"),
			args,
			server_args: &server_args,
			remote_is_sender: true,
			protocol: 33,
			old_args: false,
			output_motd: true,
			password_file: None,
			early_input: None,
			fs,
			insecure_operator_files: false,
			getenv: &no_env,
			read_stdin_line: None,
			connect_deadline: None,
			io_timeout: None,
		}
	}

	type DaemonWriter = Box<dyn Write + Send>;

	/// Runs `script` as the daemon on the server half of a local pair; it gets
	/// a line reader and the writer (dropping it is EOF for the client), and
	/// returns what it captured.
	fn with_daemon<T: Send + 'static>(
		script: impl FnOnce(&mut dyn BufRead, DaemonWriter) -> T + Send + 'static,
	) -> (Connection, std::thread::JoinHandle<T>) {
		let (client, server) = local_pair(Arc::new(AtomicBool::new(false)));
		let handle = std::thread::spawn(move || {
			let Connection { reader, writer, .. } = server;
			let mut reader = BufReader::new(reader);
			script(&mut reader, writer)
		});
		(client, handle)
	}

	fn line(r: &mut dyn BufRead) -> Vec<u8> {
		let mut buf = Vec::new();
		r.read_until(b'\n', &mut buf).unwrap();
		buf
	}

	fn rest(r: &mut dyn BufRead) -> Vec<u8> {
		let mut buf = Vec::new();
		let _ = r.read_to_end(&mut buf);
		buf
	}

	#[test]
	fn scripted_daemon_with_auth_motd_and_args() {
		let (mut conn, daemon) = with_daemon(|r, mut w| {
			let greeting = line(r);
			w.write_all(b"@RSYNCD: 31.0 sha256 md5\n").unwrap();
			let module = line(r);
			w.write_all(b"Welcome\r\n\nto the daemon\n@RSYNCD: AUTHREQD Zm9vYmFyY2hhbGxlbmdl\n").unwrap();
			let auth = line(r);
			w.write_all(b"@RSYNCD: OK\n").unwrap();
			(greeting, module, auth, rest(r))
		});
		let fs = pi_vfs::BlockingFs::native();
		let args = [OsString::from("mod/a mod/b"), OsString::from("mod"), OsString::from("-x")];
		let env = |key: &str| (key == "RSYNC_PASSWORD").then(|| "s3cr3t pw".to_owned());
		let cfg = DaemonConfig { args: &args, getenv: &env, ..base_cfg(&args, &fs) };
		let (logger, out, _) = test_logger();
		let session = daemon_handshake(&mut conn, &cfg, &logger).unwrap();
		drop(conn);
		let (greeting, module, auth, sent) = daemon.join().unwrap();
		assert_eq!(greeting, b"@RSYNCD: 33.0 sha512 sha256 sha1 md5 md4\n");
		assert_eq!(module, b"mod\n");
		assert_eq!(auth, b"alice 6S8beeuwotxb9K9cGFpBb5Lnf6lwArEwZ2ou9MGyrKY\n");
		assert_eq!(
			sent,
			b"--server\0--sender\0-de.LsfxCIvu\0.\0mod/a[ ]mod/b\0mod/\0./-x\0\0"
		);
		assert_eq!(out.lock().unwrap().as_slice(), b"Welcome\n\nto the daemon\n");
		assert_eq!(
			session,
			DaemonSession {
				remote_protocol: 31,
				remote_sub: 0,
				protocol: 31,
				auth_choices: Some("sha256 md5".to_owned()),
				auth_digest: Some(AuthDigest::Sha256),
				exited: false,
			}
		);
	}

	#[test]
	fn protocol_29_daemon_gets_newline_args_and_old_md4() {
		let (mut conn, daemon) = with_daemon(|r, mut w| {
			line(r);
			w.write_all(b"@RSYNCD: 29\n@RSYNCD: AUTHREQD Zm9vYmFyY2hhbGxlbmdl\n").unwrap();
			line(r);
			let auth = line(r);
			w.write_all(b"@RSYNCD: OK\n").unwrap();
			(auth, rest(r))
		});
		let fs = pi_vfs::BlockingFs::native();
		let args = [OsString::from("mod/a")];
		let env = |key: &str| (key == "RSYNC_PASSWORD").then(|| "s3cr3t pw".to_owned());
		let cfg = DaemonConfig { getenv: &env, ..base_cfg(&args, &fs) };
		let (logger, ..) = test_logger();
		let session = daemon_handshake(&mut conn, &cfg, &logger).unwrap();
		drop(conn);
		let (auth, sent) = daemon.join().unwrap();
		assert_eq!(auth, b"alice ygINi3LU4TN+fbN7xpZg+Q\n");
		assert_eq!(sent, b"--server\n--sender\n.\nmod/a\n\n");
		assert_eq!((session.protocol, session.auth_digest), (29, Some(AuthDigest::Md4Old)));
	}

	#[test]
	fn secluded_args_follow_the_visible_ones() {
		let (mut conn, daemon) = with_daemon(|r, mut w| {
			line(r);
			w.write_all(b"@RSYNCD: 33.0 md5\n").unwrap();
			line(r);
			w.write_all(b"@RSYNCD: OK\n").unwrap();
			rest(r)
		});
		let fs = pi_vfs::BlockingFs::native();
		let args = [OsString::from("mod/a b")];
		let split = |_: u32| (vec![OsString::from("-se.LsfxCIvu")], Some(1));
		let cfg = DaemonConfig { server_args: &split, ..base_cfg(&args, &fs) };
		let (logger, ..) = test_logger();
		daemon_handshake(&mut conn, &cfg, &logger).unwrap();
		drop(conn);
		assert_eq!(
			daemon.join().unwrap(),
			b"--server\0--sender\0-se.LsfxCIvu\0\0rsync\0.\0mod/a b\0\0"
		);
	}

	#[test]
	fn daemon_errors_and_exit() {
		let fs = pi_vfs::BlockingFs::native();
		let args = [OsString::from("nomod")];
		let run = |reply: &'static [u8], motd: bool| {
			let (mut conn, daemon) = with_daemon(move |r, mut w| {
				line(r);
				w.write_all(reply).unwrap();
				drop(w);
				rest(r);
			});
			let cfg = DaemonConfig { output_motd: motd, ..base_cfg(&args, &fs) };
			let (logger, out, _) = test_logger();
			let got = daemon_handshake(&mut conn, &cfg, &logger);
			drop(conn);
			daemon.join().unwrap();
			let shown = String::from_utf8_lossy(&out.lock().unwrap()).into_owned();
			(got, shown)
		};
		let (got, _) = run(b"@RSYNCD: 33.0 md5\n@ERROR: Unknown module 'nomod'\n", true);
		let err = got.unwrap_err();
		assert_eq!(err.message.as_deref(), Some("@ERROR: Unknown module 'nomod'"));
		assert_eq!((err.code, err.site), (5, Some(("main.c", 1981))));
		let (got, shown) = run(b"@RSYNCD: 33.0 md5\npub            \tPublic\n@RSYNCD: EXIT\n", true);
		assert!(got.unwrap().exited);
		assert_eq!(shown, "pub            \tPublic\n");
		let (got, shown) = run(b"@RSYNCD: 33.0 md5\npub\n@RSYNCD: EXIT\n", false);
		assert!(got.unwrap().exited);
		assert_eq!(shown, "");
		let (got, _) = run(b"", true);
		assert_eq!(got.unwrap_err().message.as_deref(), Some("rsync: did not see server greeting"));
		let (got, _) = run(b"HELLO\n", true);
		assert_eq!(got.unwrap_err().message.as_deref(), Some("rsync: server sent \"HELLO\" rather than greeting"));
		let (got, _) = run(b"@RSYNCD: 31\n", true);
		assert_eq!(
			got.unwrap_err().message.as_deref(),
			Some("rsync: the server omitted the subprotocol value: @RSYNCD: 31")
		);
		let (got, _) = run(b"@RSYNCD: 32.0\n", true);
		assert_eq!(
			got.unwrap_err().message.as_deref(),
			Some("rsync: the server omitted the digest name list: @RSYNCD: 32.0")
		);
		let (got, _) = run(b"@RSYNCD: 33.0 md5\n", true);
		assert_eq!(got.unwrap_err().message.as_deref(), Some("rsync: didn't get server startup line"));
		let (got, _) = run(b"@RSYNCD: 33.0 xxh128 foo\n@RSYNCD: AUTHREQD abc\n", true);
		let err = got.unwrap_err();
		assert_eq!(err.code, RERR_UNSUPPORTED);
		assert_eq!(
			err.message.as_deref(),
			Some("Failed to negotiate a daemon auth checksum choice.\nServer list: xxh128 foo\nClient list: sha512 sha256 sha1 md5 md4")
		);
	}

	#[test]
	fn leading_slash_module_is_refused_before_talking() {
		let fs = pi_vfs::BlockingFs::native();
		let args = [OsString::from("/abs")];
		let (mut conn, _server) = local_pair(Arc::new(AtomicBool::new(false)));
		let (logger, ..) = test_logger();
		let err = daemon_handshake(&mut conn, &base_cfg(&args, &fs), &logger).unwrap_err();
		assert_eq!(err.message.as_deref(), Some("ERROR: The remote path must start with a module name"));
	}

	#[test]
	fn connect_deadline_maps_to_contimeout() {
		let fs = pi_vfs::BlockingFs::native();
		let args = [OsString::from("mod")];
		let (mut conn, server) = local_pair(Arc::new(AtomicBool::new(false)));
		let cfg = DaemonConfig {
			connect_deadline: Some(Instant::now() + Duration::from_millis(100)),
			..base_cfg(&args, &fs)
		};
		let (logger, ..) = test_logger();
		let err = daemon_handshake(&mut conn, &cfg, &logger).unwrap_err();
		assert_eq!(err.code, RERR_CONTIMEOUT);
		assert_eq!(err.message.as_deref(), Some("[Receiver] connection timed out -- exiting"));
		assert_eq!(err.site, Some(("io.c", 173)));
		// The limit is gone once the handshake returned.
		let probe = std::thread::spawn(move || {
			let mut buf = [0u8; 1];
			let _ = conn.reader.read(&mut buf);
		});
		std::thread::sleep(Duration::from_millis(300));
		assert!(!probe.is_finished());
		drop(server);
		probe.join().unwrap();
	}

	#[test]
	fn io_timeout_during_handshake() {
		let fs = pi_vfs::BlockingFs::native();
		let args = [OsString::from("mod")];
		let (mut conn, _server) = local_pair(Arc::new(AtomicBool::new(false)));
		let cfg = DaemonConfig { io_timeout: Some(Duration::from_millis(100)), ..base_cfg(&args, &fs) };
		let (logger, ..) = test_logger();
		let err = daemon_handshake(&mut conn, &cfg, &logger).unwrap_err();
		assert_eq!(err.code, 30);
		assert_eq!(err.message.as_deref(), Some("[Receiver] io timeout after 0 seconds -- exiting"));
	}

	#[cfg(unix)]
	#[test]
	fn password_file_checks() {
		use std::os::unix::fs::PermissionsExt;
		let dir = tempfile::tempdir().unwrap();
		let fs = pi_vfs::BlockingFs::native();
		let args = [OsString::from("mod")];
		let pw = dir.path().join("pw");
		std::fs::write(&pw, b"\nsecret\r\nignored").unwrap();
		std::fs::set_permissions(&pw, std::fs::Permissions::from_mode(0o644)).unwrap();
		let cfg = DaemonConfig { password_file: Some(&pw), ..base_cfg(&args, &fs) };
		let err = password(&cfg, Role::PreReceiver).unwrap_err();
		assert_eq!(err.message.as_deref(), Some("ERROR: password file must not be other-accessible"));
		assert_eq!((err.code, err.site), (1, Some(("authenticate.c", 261))));
		std::fs::set_permissions(&pw, std::fs::Permissions::from_mode(0o600)).unwrap();
		assert_eq!(password(&cfg, Role::PreReceiver).unwrap(), b"secret");
		let missing = dir.path().join("nope");
		let cfg = DaemonConfig { password_file: Some(&missing), ..base_cfg(&args, &fs) };
		let err = password(&cfg, Role::PreReceiver).unwrap_err();
		let want = format!(
			"rsync: [Receiver] could not open password file {}: No such file or directory (2)",
			missing.display()
		);
		assert_eq!(err.message.as_deref(), Some(want.as_str()));
		assert_eq!(err.site, Some(("authenticate.c", 247)));
		let empty = dir.path().join("empty");
		std::fs::write(&empty, b"\n").unwrap();
		std::fs::set_permissions(&empty, std::fs::Permissions::from_mode(0o600)).unwrap();
		let cfg = DaemonConfig { password_file: Some(&empty), ..base_cfg(&args, &fs) };
		let err = password(&cfg, Role::PreReceiver).unwrap_err();
		assert_eq!(err.site, Some(("authenticate.c", 279)));
		let stdin = || Ok(b"fromstdin\n".to_vec());
		let dash = Path::new("-");
		let cfg = DaemonConfig {
			password_file: Some(dash),
			read_stdin_line: Some(&stdin),
			..base_cfg(&args, &fs)
		};
		assert_eq!(password(&cfg, Role::PreReceiver).unwrap(), b"fromstdin");
	}

	#[cfg(unix)]
	#[test]
	fn early_input_is_sent_before_the_module() {
		let dir = tempfile::tempdir().unwrap();
		let early = dir.path().join("early");
		std::fs::write(&early, b"hello\nworld").unwrap();
		let (mut conn, daemon) = with_daemon(|r, mut w| {
			line(r);
			w.write_all(b"@RSYNCD: 33.0 md5\n").unwrap();
			let head = line(r);
			let mut body = [0u8; 11];
			r.read_exact(&mut body).unwrap();
			let module = line(r);
			w.write_all(b"@ERROR: stop\n").unwrap();
			(head, body, module)
		});
		let fs = pi_vfs::BlockingFs::native();
		let args = [OsString::from("mod")];
		let cfg = DaemonConfig { early_input: Some(&early), ..base_cfg(&args, &fs) };
		let (logger, ..) = test_logger();
		let _ = daemon_handshake(&mut conn, &cfg, &logger);
		let (head, body, module) = daemon.join().unwrap();
		assert_eq!(head, b"#early_input=11\n");
		assert_eq!(&body, b"hello\nworld");
		assert_eq!(module, b"mod\n");
		let big = dir.path().join("big");
		std::fs::write(&big, vec![0u8; 6000]).unwrap();
		let (mut conn, daemon) = with_daemon(|r, mut w| {
			line(r);
			w.write_all(b"@RSYNCD: 33.0 md5\n").unwrap();
		});
		let cfg = DaemonConfig { early_input: Some(&big), ..base_cfg(&args, &fs) };
		let err = daemon_handshake(&mut conn, &cfg, &logger).unwrap_err();
		daemon.join().unwrap();
		assert_eq!(err.message, Some(format!("{} is > 5120 bytes.", big.display())));
	}

	/// The reference binary as a real daemon: module listing and a password
	/// login, over TCP.
	#[cfg(unix)]
	#[test]
	fn live_reference_daemon_listing_and_auth() {
		let Some(rsync) = ["/opt/homebrew/bin/rsync", "/usr/local/bin/rsync", "/usr/bin/rsync"]
			.into_iter()
			.map(Path::new)
			.find(|p| p.exists() && is_samba_rsync(p))
		else {
			return;
		};
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path();
		std::fs::create_dir(root.join("data")).unwrap();
		std::fs::write(root.join("motd"), b"Hello motd\n").unwrap();
		std::fs::write(root.join("secrets"), b"alice:s3cr3t pw\n").unwrap();
		{
			use std::os::unix::fs::PermissionsExt;
			std::fs::set_permissions(root.join("secrets"), std::fs::Permissions::from_mode(0o600)).unwrap();
		}
		let port = {
			let probe = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
			probe.local_addr().unwrap().port()
		};
		let conf = format!(
			"use chroot = no\naddress = 127.0.0.1\nmotd file = {r}/motd\npid file = {r}/pid\n\
			 [pub]\n\tpath = {r}/data\n\tcomment = Public stuff\n\
			 [priv]\n\tpath = {r}/data\n\tauth users = alice\n\tsecrets file = {r}/secrets\n",
			r = root.display()
		);
		std::fs::write(root.join("rsyncd.conf"), conf).unwrap();
		let mut daemon = std::process::Command::new(rsync)
			.arg("--daemon")
			.arg("--no-detach")
			.arg(format!("--port={port}"))
			.arg(format!("--config={}", root.join("rsyncd.conf").display()))
			.stdout(std::process::Stdio::null())
			.stderr(std::process::Stdio::null())
			.spawn()
			.unwrap();
		struct Kill(std::process::Child);
		impl Drop for Kill {
			fn drop(&mut self) {
				let _ = self.0.kill();
				let _ = self.0.wait();
			}
		}
		let _guard = {
			let deadline = Instant::now() + Duration::from_secs(10);
			while std::net::TcpStream::connect(("127.0.0.1", port)).is_err() {
				assert!(Instant::now() < deadline, "daemon did not start");
				if let Ok(Some(_)) = daemon.try_wait() {
					return;
				}
				std::thread::sleep(Duration::from_millis(50));
			}
			Kill(daemon)
		};

		let (host, _) = crate::host::Host::for_test("rsync", "", root);
		let env = host.child_env();
		let connect = |logger: &Logger| {
			let getenv = |_: &str| -> Option<String> { None };
			let cfg = crate::rsync::transport::TcpConfig {
				host: "127.0.0.1",
				port: i32::from(port),
				bind_address: None,
				af_hint: 0,
				sockopts: None,
				connect_timeout: Some(Duration::from_secs(5)),
				getenv: &getenv,
				logger,
			};
			crate::rsync::transport::connect_tcp(&cfg, &env, Arc::new(AtomicBool::new(false))).unwrap()
		};

		let fs = pi_vfs::BlockingFs::native();
		let (logger, out, _) = test_logger();
		let mut conn = connect(&logger);
		let args = [OsString::new()];
		assert!(daemon_handshake(&mut conn, &base_cfg(&args, &fs), &logger).unwrap().exited);
		let listing = String::from_utf8_lossy(&out.lock().unwrap()).into_owned();
		assert_eq!(listing, "Hello motd\n\npub            \tPublic stuff\npriv           \t\n");

		let (logger, ..) = test_logger();
		let mut conn = connect(&logger);
		let args = [OsString::from("priv/")];
		let good = |key: &str| (key == "RSYNC_PASSWORD").then(|| "s3cr3t pw".to_owned());
		let cfg = DaemonConfig { getenv: &good, ..base_cfg(&args, &fs) };
		let session = daemon_handshake(&mut conn, &cfg, &logger).unwrap();
		assert_eq!(session.remote_protocol, 33);
		assert_eq!(session.auth_digest, Some(AuthDigest::Sha512));
		assert!(!session.exited);
		// After OK + args the daemon starts the binary protocol: compat flags
		// and checksum negotiation arrive next (never another text line).
		let mut first = [0u8; 1];
		conn.reader.read_exact(&mut first).unwrap();

		let (logger, ..) = test_logger();
		let mut conn = connect(&logger);
		let bad = |key: &str| (key == "RSYNC_PASSWORD").then(|| "wrong".to_owned());
		let cfg = DaemonConfig { getenv: &bad, ..base_cfg(&args, &fs) };
		let err = daemon_handshake(&mut conn, &cfg, &logger).unwrap_err();
		assert_eq!(err.message.as_deref(), Some("@ERROR: auth failed on module priv"));
		assert_eq!(err.code, 5);
	}

	/// openrsync (`/usr/bin/rsync` on macOS) has no daemon mode.
	#[cfg(unix)]
	fn is_samba_rsync(path: &Path) -> bool {
		std::process::Command::new(path)
			.arg("--version")
			.output()
			.is_ok_and(|out| String::from_utf8_lossy(&out.stdout).starts_with("rsync  version 3."))
	}

	#[test]
	fn cancellation_during_greeting_maps_to_signal() {
		let cancel = Arc::new(AtomicBool::new(false));
		let (mut conn, _server) = local_pair(Arc::clone(&cancel));
		let fs = pi_vfs::BlockingFs::native();
		let args = [OsString::from("mod")];
		let flag = Arc::clone(&cancel);
		std::thread::spawn(move || {
			std::thread::sleep(Duration::from_millis(100));
			flag.store(true, Ordering::Relaxed);
		});
		let (logger, ..) = test_logger();
		let err = daemon_handshake(&mut conn, &base_cfg(&args, &fs), &logger).unwrap_err();
		assert_eq!(err.code, crate::rsync::exit::RERR_SIGNAL);
	}
}
