//! Client operand parsing: which operands are remote, which host they name,
//! and whether the peer is reached through a remote shell or an rsync daemon.
//!
//! Host specifications follow rsync 3.5.1:
//!
//! - `[USER@]HOST:PATH` — remote shell.
//! - `[USER@]HOST::MODULE/PATH` — rsync daemon (over TCP, or over the remote
//!   shell when `-e` was given).
//! - `rsync://[USER@]HOST[:PORT]/MODULE/PATH` — rsync daemon, scheme matched
//!   case-insensitively.
//! - `HOST` may be an IPv6 literal in brackets (`[::1]:path`); the brackets are
//!   not part of the host name.
//! - A `/` before the first `:` makes the operand local (`./host:file`).
//! - `SCHEME://…` (scheme other than `rsync`) that the shell's filesystem routes
//!   to a virtual provider is a local path.
//! - On Windows, drive-letter (`C:\x`, `C:/x`, `C:x`) and UNC (`\\srv\share`)
//!   operands are local, and `\` before the first `:` makes an operand local
//!   like `/` does.
//!
//! With a remote source, further sources may repeat the host (`host:a host:b`)
//! or leave it empty (`host:a :b`); a final operand starting with `:` is a
//! source too, so `host:a :b` has no destination (list-only).

use std::ffi::{OsStr, OsString};

use crate::{
	host::os_bytes_lossy,
	rsync::{
		exit::{RERR_STARTCLIENT, RERR_SOCKETIO, RERR_SYNTAX, RsyncError},
		paths::bytes_os_lossy,
	},
};

/// Upstream's default daemon port.
const RSYNC_PORT: i32 = 873;
/// `rsync://`, matched case-insensitively.
const URL_PREFIX: &[u8] = b"rsync://";

/// Where the remote end is.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Remote {
	Shell { user: Option<String>, host: String },
	/// `port` is the explicitly requested port (URL or `--port`) when it fits a
	/// `u16`; `None` means the default (873) or an out-of-range request, see
	/// [`Operands::port`] for the value actually dialled.
	Daemon { user: Option<String>, host: String, port: Option<u16> },
}

/// Client-side operand split (upstream start_client / check_for_hostspec rules).
#[derive(Clone, Debug)]
pub(crate) struct Operands {
	pub remote: Option<Remote>,
	/// True when the remote (or, for local copies, the server half) sends.
	pub remote_is_sender: bool,
	/// Paths as given to the sender side (remote paths stripped of host prefix).
	pub sources: Vec<OsString>,
	/// Destination path (None ⇒ --list-only behavior).
	pub dest: Option<OsString>,
	/// A daemon reached through the remote shell (`-e` given with a daemon
	/// spec): spawn `rsync --server --daemon .` and run the daemon handshake
	/// over the shell's pipes.
	pub daemon_over_shell: bool,
	/// The TCP port a daemon connection dials (873 by default). Upstream keeps it
	/// as an `int`, so an out-of-range request reaches the resolver and fails
	/// there with its error text. 0 for non-daemon transfers.
	pub port: i32,
	/// The value upstream exports as `RSYNC_PORT` to a daemon-over-shell child:
	/// the explicit URL/`--port` value, else the `--port` option (0 when unset).
	pub env_port: i32,
}

impl Operands {
	/// The arguments the remote side receives as its file operands: the remote
	/// sources when pulling, the destination when pushing (upstream
	/// `remote_argv`). Empty for local transfers.
	pub(crate) fn remote_args(&self) -> Vec<OsString> {
		match (&self.remote, self.remote_is_sender) {
			(None, _) => Vec::new(),
			(Some(_), true) => self.sources.clone(),
			(Some(_), false) => self.dest.iter().cloned().collect(),
		}
	}
}

/// Settings that steer operand parsing (from the parsed options).
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct OperandConfig<'a> {
	/// `--port` (0 when not given), with upstream's `int` range.
	pub port: i32,
	/// `-e`/`--rsh` was given on the command line (`RSYNC_RSH` does not count):
	/// a daemon spec then runs over the remote shell instead of TCP.
	pub shell_cmd: bool,
	/// `--old-args` (any level).
	pub old_args: bool,
	/// `--read-batch`: no source operands; the destination must be local.
	pub read_batch: bool,
	/// Host part of a remote `--files-from` (`Some("")` for `:FILE`), including
	/// any `user@`.
	pub files_from_host: Option<&'a str>,
	/// `--password-file` was given.
	pub password_file: bool,
	/// `--contimeout` was given with a non-zero value.
	pub connect_timeout: bool,
}

/// A recognised host specification.
struct HostSpec<'a> {
	/// `[USER@]HOST`, IPv6 brackets removed.
	host: Vec<u8>,
	/// Everything after the host part (and after `:`/`::`/the URL's `/`).
	path: &'a [u8],
}

/// Client-side operand split (upstream start_client / check_for_hostspec rules).
///
/// `args` are the operands after option parsing. `is_local_vfs` answers whether a
/// `SCHEME://…` operand is served by a virtual filesystem provider (then it is a
/// local path, never a host spec).
pub(crate) fn parse_operands(
	args: &[OsString],
	is_local_vfs: &dyn Fn(&OsStr) -> bool,
	cfg: &OperandConfig<'_>,
) -> Result<Operands, RsyncError> {
	let Some(first) = args.first() else {
		// Option parsing rejects an empty operand list before this point.
		return Err(RsyncError::bare(RERR_SYNTAX));
	};
	let vfs = is_local_vfs;
	let mut rsync_port = cfg.port;
	let mut env_port = cfg.port;

	if cfg.read_batch {
		let Some(last) = args.last() else { return Err(RsyncError::bare(RERR_SYNTAX)) };
		if hostspec(last, Some(&mut rsync_port), vfs).is_some() {
			return Err(syntax("remote destination is not allowed with --read-batch", 1542));
		}
		return Ok(Operands {
			remote: None,
			remote_is_sender: true,
			sources: Vec::new(),
			dest: Some(last.clone()),
			daemon_over_shell: false,
			port: 0,
			env_port: 0,
		});
	}

	/// Which way the transfer goes, with what each direction still needs.
	enum Shape {
		/// Remote sources; the local destination, if any.
		Pull(Option<OsString>),
		/// Local sources to a remote destination.
		Push(Vec<OsString>),
	}

	let machine: Vec<u8>;
	let shape;
	let mut remote_args: Vec<OsString>;

	if let Some(found) = hostspec(first, Some(&mut rsync_port), vfs) {
		// Remote source.
		machine = found.host;
		remote_args = Vec::with_capacity(args.len());
		remote_args.push(bytes_os_lossy(found.path).into_owned());
		remote_args.extend(args[1..].iter().cloned());
		let last = &args[args.len() - 1];
		if args.len() == 1 || os_bytes_lossy(last).first() == Some(&b':') {
			shape = Shape::Pull(None);
		} else if hostspec(last, Some(&mut 0), vfs).is_some() {
			return Err(syntax("The source and destination cannot both be remote.", 1489));
		} else {
			remote_args.pop();
			shape = Shape::Pull(Some(last.clone()));
		}
		if let Some(ff) = cfg.files_from_host
			&& !ff.is_empty()
			&& ff.as_bytes() != machine.as_slice()
		{
			return Err(syntax(
				"--files-from hostname is not the same as the transfer hostname",
				1497,
			));
		}
	} else {
		// Local source; the last operand decides whether the destination is remote.
		let mut locals: Vec<OsString> = args.to_vec();
		let dest_arg = if locals.len() > 1 {
			let p = locals.pop().unwrap_or_default();
			if p.is_empty() {
				if !cfg.old_args {
					return Err(syntax(
						"Empty destination arg specified (use \".\" or see --old-args).",
						698,
					));
				}
				Some(OsString::from("."))
			} else {
				Some(p)
			}
		} else {
			None
		};
		let probe = dest_arg.clone().unwrap_or_else(|| OsString::from("."));
		match hostspec(&probe, Some(&mut rsync_port), vfs) {
			Some(found) => {
				if let Some(ff) = cfg.files_from_host
					&& !ff.is_empty()
					&& ff.as_bytes() != found.host.as_slice()
				{
					return Err(syntax(
						"--files-from hostname is not the same as the transfer hostname",
						1521,
					));
				}
				machine = found.host;
				remote_args = vec![bytes_os_lossy(found.path).into_owned()];
			}
			None => {
				if cfg.files_from_host.is_some() {
					return Err(syntax(
						"--files-from cannot be remote when the transfer is local",
						1528,
					));
				}
				return finish_local(locals, dest_arg, vfs);
			}
		}
		shape = Shape::Push(locals);
	}

	// An empty remote path means the remote home (or module list for daemons).
	if rsync_port == 0
		&& let Some(head) = remote_args.first_mut()
		&& head.is_empty()
	{
		*head = OsString::from(".");
	}

	let (remote_is_sender, sources, dest) = match shape {
		Shape::Pull(dest) => {
			(true, check_remote_sources(&remote_args, &machine, rsync_port, vfs)?, dest)
		}
		Shape::Push(locals) => {
			check_local_sources(&locals, vfs)?;
			(false, locals, remote_args.first().cloned())
		}
	};

	let daemon = rsync_port != 0;
	let port = if rsync_port < 0 {
		RSYNC_PORT
	} else {
		env_port = rsync_port;
		rsync_port
	};
	let (user, host) = split_user(&machine);

	let remote = if daemon && !cfg.shell_cmd {
		let module_path = remote_args.first().map(|a| os_bytes_lossy(a).into_owned());
		if module_path.as_deref().and_then(<[u8]>::first) == Some(&b'/') {
			return Err(RsyncError::new(
				RERR_STARTCLIENT,
				"ERROR: The remote path must start with a module name not a /",
			)
			.at("main.c", 1981));
		}
		let explicit = (rsync_port > 0).then(|| u16::try_from(port).ok()).flatten();
		if rsync_port > 0 && explicit.is_none() {
			// Upstream hands the out-of-range number to the resolver, which
			// refuses it before any connection attempt.
			return Err(out_of_range_port(&host, port));
		}
		Remote::Daemon { user, host, port: explicit }
	} else {
		if cfg.password_file && !daemon {
			return Err(syntax(
				"The --password-file option may only be used when accessing an rsync daemon.",
				1620,
			));
		}
		if cfg.connect_timeout && !daemon {
			return Err(syntax(
				"The --contimeout option may only be used when connecting to an rsync daemon.",
				1626,
			));
		}
		if host.starts_with('-') {
			return Err(syntax("Invalid remote host: hostnames may not start with '-'.", 1638));
		}
		if daemon {
			let explicit = (rsync_port > 0).then(|| u16::try_from(port).ok()).flatten();
			Remote::Daemon { user, host, port: explicit }
		} else {
			Remote::Shell { user, host }
		}
	};

	Ok(Operands {
		remote: Some(remote),
		remote_is_sender,
		sources,
		dest,
		daemon_over_shell: daemon && cfg.shell_cmd,
		port: if daemon { port } else { 0 },
		env_port: if daemon { env_port } else { 0 },
	})
}

/// Remote sources after the first may repeat the host or leave it empty, and must
/// use the same kind of host spec and port; returns them stripped of their host
/// part (an empty shell path becomes `.`).
fn check_remote_sources(
	remote_args: &[OsString],
	machine: &[u8],
	rsync_port: i32,
	vfs: &dyn Fn(&OsStr) -> bool,
) -> Result<Vec<OsString>, RsyncError> {
	let mut checked = Vec::with_capacity(remote_args.len());
	for (i, arg) in remote_args.iter().enumerate() {
		if i == 0 {
			checked.push(arg.clone());
			continue;
		}
		let mut port = rsync_port;
		let Some(found) = hostspec(arg, Some(&mut port), vfs) else {
			return Err(syntax(
				format!(
					"Unexpected local arg: {}\nIf arg is a remote file/dir, prefix it with a colon \
					 (:).",
					String::from_utf8_lossy(&os_bytes_lossy(arg))
				),
				1589,
			));
		};
		if !found.host.is_empty() && found.host != machine {
			return Err(syntax("All source args must come from the same machine.", 1593));
		}
		if port != rsync_port {
			let text = if rsync_port == 0 || port == 0 {
				"All source args must use the same hostspec format."
			} else {
				"All source args must use the same port number."
			};
			return Err(syntax(text, 1600));
		}
		if rsync_port == 0 && found.path.is_empty() {
			checked.push(OsString::from("."));
		} else {
			checked.push(bytes_os_lossy(found.path).into_owned());
		}
	}
	Ok(checked)
}

/// A transfer with no remote operand.
fn finish_local(
	sources: Vec<OsString>,
	dest: Option<OsString>,
	vfs: &dyn Fn(&OsStr) -> bool,
) -> Result<Operands, RsyncError> {
	check_local_sources(&sources, vfs)?;
	Ok(Operands {
		remote: None,
		remote_is_sender: false,
		sources,
		dest,
		daemon_over_shell: false,
		port: 0,
		env_port: 0,
	})
}

/// Local sources must be non-empty and must not name a host.
fn check_local_sources(
	sources: &[OsString],
	vfs: &dyn Fn(&OsStr) -> bool,
) -> Result<(), RsyncError> {
	for (i, arg) in sources.iter().enumerate() {
		if arg.is_empty() {
			return Err(syntax("Empty source arg specified.", 1569));
		}
		if i > 0 && hostspec(arg, Some(&mut 0), vfs).is_some() {
			return Err(syntax(
				format!("Unexpected remote arg: {}", String::from_utf8_lossy(&os_bytes_lossy(arg))),
				1573,
			));
		}
	}
	Ok(())
}

/// Splits a `--files-from` argument naming a remote file (`host:FILE`,
/// `:FILE`, `host::FILE`, `rsync://host/FILE`): returns the host part
/// (`""` for `:FILE`) and the file name. `None` for a local file.
pub(crate) fn files_from_hostspec(
	arg: &OsStr,
	is_local_vfs: &dyn Fn(&OsStr) -> bool,
) -> Option<(String, OsString)> {
	let mut port = 0;
	let found = hostspec(arg, Some(&mut port), is_local_vfs)?;
	Some((String::from_utf8_lossy_owned(found.host), bytes_os_lossy(found.path).into_owned()))
}

/// `check_for_hostspec` plus the virtual-filesystem exemption.
fn hostspec<'a>(
	arg: &'a OsStr,
	port: Option<&mut i32>,
	is_local_vfs: &dyn Fn(&OsStr) -> bool,
) -> Option<HostSpec<'a>> {
	let bytes = crate::host::os_bytes(arg)?;
	if is_virtual_scheme(bytes) && is_local_vfs(arg) {
		return None;
	}
	if cfg!(windows) && is_windows_local(bytes) {
		return None;
	}
	check_for_hostspec(bytes, port)
}

/// Windows operands that name local paths even though they contain a `:`:
/// drive-letter and UNC paths, and anything with a `\` before its first `:`.
fn is_windows_local(arg: &[u8]) -> bool {
	if arg.len() >= 2 && arg[0].is_ascii_alphabetic() && arg[1] == b':' {
		return true;
	}
	if arg.starts_with(b"\\\\") {
		return true;
	}
	let colon = arg.iter().position(|&b| b == b':').unwrap_or(arg.len());
	arg[..colon].contains(&b'\\')
}

/// `SCHEME://` with a scheme other than `rsync`.
fn is_virtual_scheme(arg: &[u8]) -> bool {
	let Some(colon) = arg.iter().position(|&b| b == b':') else { return false };
	let scheme = &arg[..colon];
	!scheme.is_empty()
		&& scheme[0].is_ascii_alphabetic()
		&& scheme.iter().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'-' | b'.'))
		&& arg[colon..].starts_with(b"://")
		&& !scheme.eq_ignore_ascii_case(b"rsync")
}

/// Recognises `HOST:PATH`, `HOST::PATH` and (when `port` is given)
/// `rsync://HOST[:PORT]/PATH`. On a daemon spec `*port` becomes the URL's port,
/// or -1 ("default") when neither the URL nor the caller's value names one; on
/// a shell spec it becomes 0.
fn check_for_hostspec<'a>(arg: &'a [u8], port: Option<&mut i32>) -> Option<HostSpec<'a>> {
	if let Some(port) = port {
		if arg.len() >= URL_PREFIX.len() && arg[..URL_PREFIX.len()].eq_ignore_ascii_case(URL_PREFIX)
		{
			if let Some((spec, url_port)) = parse_hostspec(&arg[URL_PREFIX.len()..], true) {
				if let Some(value) = url_port {
					*port = value;
				}
				if *port == 0 {
					*port = -1;
				}
				return Some(spec);
			}
		}
		let (spec, _) = parse_hostspec(arg, false)?;
		if let Some(rest) = spec.path.strip_prefix(b":") {
			if *port == 0 {
				*port = -1;
			}
			return Some(HostSpec { host: spec.host, path: rest });
		}
		*port = 0;
		return Some(spec);
	}
	let (spec, _) = parse_hostspec(arg, false)?;
	match spec.path.strip_prefix(b":") {
		Some(rest) => Some(HostSpec { host: spec.host, path: rest }),
		None => Some(spec),
	}
}

/// The `[USER@]HOST` scanner. In URL mode a missing path is allowed, `/` ends
/// the host, and `:DIGITS` is a port (returned as upstream's `atoi` would
/// read it).
fn parse_hostspec(s: &[u8], url: bool) -> Option<(HostSpec<'_>, Option<i32>)> {
	let mut host_start = 0;
	let mut host_len: Option<usize> = None;
	let mut user_len = 0;
	let mut port = None;
	let mut i = 0;
	loop {
		let Some(&c) = s.get(i) else {
			if !url {
				return None;
			}
			host_len.get_or_insert(i - host_start);
			break;
		};
		if c == b':' || c == b'/' {
			host_len.get_or_insert(i - host_start);
			i += 1;
			if c == b'/' {
				if !url {
					return None;
				}
			} else if url {
				let digits = i;
				while s.get(i).is_some_and(u8::is_ascii_digit) {
					i += 1;
				}
				port = Some(atoi(&s[digits..i]));
				if let Some(&next) = s.get(i) {
					if next != b'/' {
						return None;
					}
					i += 1;
				}
			}
			break;
		}
		if c == b'@' {
			user_len = i + 1;
			host_start = i + 1;
		} else if c == b'[' {
			if i != host_start {
				return None;
			}
			host_start += 1;
			while s.get(i).is_some_and(|&b| b != b']' && b != b'/') {
				i += 1;
			}
			let len = i - host_start;
			host_len = Some(len);
			let closed = s.get(i) == Some(&b']');
			let follows_ok = matches!(s.get(i + 1), None | Some(b'/' | b':'));
			if !closed || !follows_ok || len == 0 {
				return None;
			}
		}
		i += 1;
	}
	let host_len = host_len.unwrap_or(0);
	let mut host = Vec::with_capacity(user_len + host_len);
	host.extend_from_slice(&s[..user_len]);
	host.extend_from_slice(&s[host_start..host_start + host_len]);
	Some((HostSpec { host, path: &s[i..] }, port))
}

/// C `atoi` over a digit run: overflow saturates like `strtol`, then the value
/// is truncated to `int`.
fn atoi(digits: &[u8]) -> i32 {
	let value = digits.iter().fold(0i64, |acc, &d| {
		acc.checked_mul(10).and_then(|v| v.checked_add(i64::from(d - b'0'))).unwrap_or(i64::MAX)
	});
	value as i32
}

/// `user@host` → (Some(user), host), split at the last `@`.
fn split_user(machine: &[u8]) -> (Option<String>, String) {
	match machine.iter().rposition(|&b| b == b'@') {
		Some(at) => (
			Some(String::from_utf8_lossy(&machine[..at]).into_owned()),
			String::from_utf8_lossy(&machine[at + 1..]).into_owned(),
		),
		None => (None, String::from_utf8_lossy(machine).into_owned()),
	}
}

/// The resolver's refusal of a port number that does not fit a TCP port, as
/// upstream reports it from the connect attempt.
fn out_of_range_port(host: &str, port: i32) -> RsyncError {
	let text = crate::rsync::transport::unknown_name_text();
	RsyncError::new(RERR_SOCKETIO, format!("rsync: getaddrinfo: {host} {port}: {text}"))
		.at("clientserver.c", 165)
}

fn syntax(message: impl Into<String>, line: u32) -> RsyncError {
	RsyncError::new(RERR_SYNTAX, message).at("main.c", line)
}

#[cfg(test)]
mod tests {
	use super::*;

	fn os(v: &[&str]) -> Vec<OsString> {
		v.iter().map(OsString::from).collect()
	}

	fn no_vfs(_: &OsStr) -> bool {
		false
	}

	fn parse(args: &[&str], cfg: &OperandConfig<'_>) -> Result<Operands, RsyncError> {
		parse_operands(&os(args), &no_vfs, cfg)
	}

	fn ok(args: &[&str]) -> Operands {
		parse(args, &OperandConfig::default()).expect("operands parse")
	}

	fn err(args: &[&str], cfg: &OperandConfig<'_>) -> (i32, String, Option<(&'static str, u32)>) {
		let e = parse(args, cfg).expect_err("operands must fail");
		(e.code, e.message.unwrap_or_default(), e.site)
	}

	fn shell(user: Option<&str>, host: &str) -> Option<Remote> {
		Some(Remote::Shell { user: user.map(str::to_owned), host: host.to_owned() })
	}

	fn daemon(user: Option<&str>, host: &str, port: Option<u16>) -> Option<Remote> {
		Some(Remote::Daemon { user: user.map(str::to_owned), host: host.to_owned(), port })
	}

	fn strs(v: &[OsString]) -> Vec<String> {
		v.iter().map(|s| s.to_string_lossy().into_owned()).collect()
	}

	/// Expected results captured from rsync 3.5.1 (`-e` with an argv-dumping
	/// fake shell, `RSYNC_CONNECT_PROG` with `--debug=connect`).
	#[test]
	fn successful_operand_table() {
		struct Case {
			args:   &'static [&'static str],
			remote: Option<Remote>,
			sender: bool,
			src:    &'static [&'static str],
			dest:   Option<&'static str>,
			port:   i32,
		}
		let cases = [
			Case {
				args:   &["host:a", ":b"],
				remote: shell(None, "host"),
				sender: true,
				src:    &["a", "b"],
				dest:   None,
				port:   0,
			},
			Case {
				args:   &["host:a", ":b", "dest"],
				remote: shell(None, "host"),
				sender: true,
				src:    &["a", "b"],
				dest:   Some("dest"),
				port:   0,
			},
			Case {
				args:   &["hh:a", ":b", ":c"],
				remote: shell(None, "hh"),
				sender: true,
				src:    &["a", "b", "c"],
				dest:   None,
				port:   0,
			},
			Case {
				args:   &["host:a", "host:b", "d"],
				remote: shell(None, "host"),
				sender: true,
				src:    &["a", "b"],
				dest:   Some("d"),
				port:   0,
			},
			Case {
				args:   &["host:", "dest"],
				remote: shell(None, "host"),
				sender: true,
				src:    &["."],
				dest:   Some("dest"),
				port:   0,
			},
			Case {
				args:   &["src", "host:"],
				remote: shell(None, "host"),
				sender: false,
				src:    &["src"],
				dest:   Some("."),
				port:   0,
			},
			Case {
				args:   &["[::1]:a", "dest"],
				remote: shell(None, "::1"),
				sender: true,
				src:    &["a"],
				dest:   Some("dest"),
				port:   0,
			},
			Case {
				args:   &["u@[fe80::1]:a", "dest"],
				remote: shell(Some("u"), "fe80::1"),
				sender: true,
				src:    &["a"],
				dest:   Some("dest"),
				port:   0,
			},
			Case {
				args:   &["@host:a", "dest"],
				remote: shell(Some(""), "host"),
				sender: true,
				src:    &["a"],
				dest:   Some("dest"),
				port:   0,
			},
			Case {
				args:   &["a@b@host:a", "dest"],
				remote: shell(Some("a@b"), "host"),
				sender: true,
				src:    &["a"],
				dest:   Some("dest"),
				port:   0,
			},
			Case {
				args:   &[":foo", "dest"],
				remote: shell(None, ""),
				sender: true,
				src:    &["foo"],
				dest:   Some("dest"),
				port:   0,
			},
			Case {
				args:   &["hh:a", ""],
				remote: shell(None, "hh"),
				sender: true,
				src:    &["a"],
				dest:   Some(""),
				port:   0,
			},
			Case {
				args:   &["[::1]x:a", "dest"],
				remote: None,
				sender: false,
				src:    &["[::1]x:a"],
				dest:   Some("dest"),
				port:   0,
			},
			Case {
				args:   &["./host:a", "dest"],
				remote: None,
				sender: false,
				src:    &["./host:a"],
				dest:   Some("dest"),
				port:   0,
			},
			Case {
				args:   &["a/b:c", "dest"],
				remote: None,
				sender: false,
				src:    &["a/b:c"],
				dest:   Some("dest"),
				port:   0,
			},
			Case {
				args:   &["only"],
				remote: None,
				sender: false,
				src:    &["only"],
				dest:   None,
				port:   0,
			},
			Case {
				args:   &["host::a", "::b", "dest"],
				remote: daemon(None, "host", None),
				sender: true,
				src:    &["a", "b"],
				dest:   Some("dest"),
				port:   873,
			},
			Case {
				args:   &["host::a", "host::b", "dest"],
				remote: daemon(None, "host", None),
				sender: true,
				src:    &["a", "b"],
				dest:   Some("dest"),
				port:   873,
			},
			Case {
				args:   &["rsync://host:55/a", "rsync://host/b", "dest"],
				remote: daemon(None, "host", Some(55)),
				sender: true,
				src:    &["a", "b"],
				dest:   Some("dest"),
				port:   55,
			},
			Case {
				args:   &["RSYNC://u@Host/a", "dest"],
				remote: daemon(Some("u"), "Host", None),
				sender: true,
				src:    &["a"],
				dest:   Some("dest"),
				port:   873,
			},
			Case {
				args:   &["rsync://host"],
				remote: daemon(None, "host", None),
				sender: true,
				src:    &[""],
				dest:   None,
				port:   873,
			},
			Case {
				args:   &["rsync://h:0/m", "dest"],
				remote: daemon(None, "h", None),
				sender: true,
				src:    &["m"],
				dest:   Some("dest"),
				port:   873,
			},
			Case {
				args:   &["rsync://[::1]:8730/mod/x", "d"],
				remote: daemon(None, "::1", Some(8730)),
				sender: true,
				src:    &["mod/x"],
				dest:   Some("d"),
				port:   8730,
			},
			Case {
				args:   &["src", "host::mod/"],
				remote: daemon(None, "host", None),
				sender: false,
				src:    &["src"],
				dest:   Some("mod/"),
				port:   873,
			},
			// A malformed URL port falls back to a shell spec for host "rsync".
			Case {
				args:   &["rsync://h:12x/m", "dest"],
				remote: shell(None, "rsync"),
				sender: true,
				src:    &["//h:12x/m"],
				dest:   Some("dest"),
				port:   0,
			},
		];
		for case in &cases {
			let got = ok(case.args);
			assert_eq!(got.remote, case.remote, "{:?}", case.args);
			assert_eq!(got.remote_is_sender, case.sender, "{:?}", case.args);
			assert_eq!(strs(&got.sources), case.src, "{:?}", case.args);
			assert_eq!(
				got.dest.map(|d| d.to_string_lossy().into_owned()).as_deref(),
				case.dest,
				"{:?}",
				case.args
			);
			assert_eq!(got.port, case.port, "{:?}", case.args);
		}
	}

	#[test]
	fn port_option_versus_url_port() {
		let cfg = OperandConfig { port: 99, ..Default::default() };
		let got = parse(&["host::a", "dest"], &cfg).unwrap();
		assert_eq!((got.port, got.remote), (99, daemon(None, "host", Some(99))));
		let got = parse(&["rsync://host/a", "dest"], &cfg).unwrap();
		assert_eq!(got.port, 99);
		// An empty URL port resets to the default even with --port.
		let got = parse(&["rsync://host:/a", "dest"], &cfg).unwrap();
		assert_eq!((got.port, got.env_port), (873, 99));
		let got = parse(&["rsync://host:55/a", "dest"], &cfg).unwrap();
		assert_eq!((got.port, got.env_port), (55, 55));
		let got = ok(&["host::a", "dest"]);
		assert_eq!((got.port, got.env_port), (873, 0));
	}

	#[test]
	fn daemon_over_shell_needs_explicit_rsh() {
		let cfg = OperandConfig { shell_cmd: true, ..Default::default() };
		let got = parse(&["u@host::mod/x", "dest"], &cfg).unwrap();
		assert!(got.daemon_over_shell);
		assert_eq!(got.remote, daemon(Some("u"), "host", None));
		assert!(!ok(&["u@host::mod/x", "dest"]).daemon_over_shell);
		// Over a shell, the leading-slash module check is the daemon's job.
		assert!(parse(&["host::/abs", "dest"], &cfg).is_ok());
		let (_, msg, _) = err(&["-h::m", "d"], &cfg);
		assert_eq!(msg, "Invalid remote host: hostnames may not start with '-'.");
	}

	#[test]
	fn operand_errors_match_upstream() {
		let d = OperandConfig::default();
		let cases: &[(&[&str], OperandConfig<'_>, i32, &str, u32)] = &[
			(&["host:a", "b", "dest"], d, 1,
				"Unexpected local arg: b\nIf arg is a remote file/dir, prefix it with a colon (:).", 1589),
			(&["host:a", "other:b", "dest"], d, 1, "All source args must come from the same machine.", 1593),
			(&["u@host:a", "host:b", "dest"], d, 1, "All source args must come from the same machine.", 1593),
			(&["host:a", "host:b"], d, 1, "The source and destination cannot both be remote.", 1489),
			(&["src", "other:x", "host:"], d, 1, "Unexpected remote arg: other:x", 1573),
			(&["", "host:x"], d, 1, "Empty source arg specified.", 1569),
			(&["src", ""], d, 1, "Empty destination arg specified (use \".\" or see --old-args).", 698),
			(&["-host:a", "dest"], d, 1, "Invalid remote host: hostnames may not start with '-'.", 1638),
			(&["host::a", ":b", "dest"], d, 1, "All source args must use the same hostspec format.", 1600),
			(&["host:a", "::b", "dest"], d, 1, "All source args must use the same hostspec format.", 1600),
			(&["rsync://h:5/a", "rsync://h:6/b", "d"], d, 1, "All source args must use the same port number.", 1600),
			(&["host::/abs", "dest"], d, 5, "ERROR: The remote path must start with a module name not a /", 1981),
			(&["rsync://host//abs", "dest"], d, 5, "ERROR: The remote path must start with a module name not a /", 1981),
			(&["host:a", "dest"], OperandConfig { password_file: true, ..d }, 1,
				"The --password-file option may only be used when accessing an rsync daemon.", 1620),
			(&["host:a", "dest"], OperandConfig { connect_timeout: true, ..d }, 1,
				"The --contimeout option may only be used when connecting to an rsync daemon.", 1626),
			(&["host:a", "dest"], OperandConfig { files_from_host: Some("other"), ..d }, 1,
				"--files-from hostname is not the same as the transfer hostname", 1497),
			(&["src", "host:d"], OperandConfig { files_from_host: Some("other"), ..d }, 1,
				"--files-from hostname is not the same as the transfer hostname", 1521),
			(&["src", "dest"], OperandConfig { files_from_host: Some(""), ..d }, 1,
				"--files-from cannot be remote when the transfer is local", 1528),
			(&["host:x"], OperandConfig { read_batch: true, ..d }, 1,
				"remote destination is not allowed with --read-batch", 1542),
		];
		for (args, cfg, code, msg, line) in cases {
			let (got_code, got_msg, site) = err(args, cfg);
			assert_eq!((got_code, got_msg.as_str()), (*code, *msg), "{args:?}");
			assert_eq!(site.map(|s| s.1), Some(*line), "{args:?}");
		}
	}

	#[test]
	fn files_from_host_may_match_or_be_empty() {
		let cfg = OperandConfig { files_from_host: Some("u@host"), ..Default::default() };
		assert!(parse(&["u@host:a", "dest"], &cfg).is_ok());
		let cfg = OperandConfig { files_from_host: Some(""), ..Default::default() };
		assert!(parse(&["host:a", "dest"], &cfg).is_ok());
		let ff = files_from_hostspec(OsStr::new("host:list"), &no_vfs).unwrap();
		assert_eq!(ff, ("host".to_owned(), OsString::from("list")));
		let ff = files_from_hostspec(OsStr::new(":list"), &no_vfs).unwrap();
		assert_eq!(ff.0, "");
		assert!(files_from_hostspec(OsStr::new("./x:y"), &no_vfs).is_none());
	}

	#[test]
	fn old_args_turn_an_empty_destination_into_dot() {
		let cfg = OperandConfig { old_args: true, ..Default::default() };
		let got = parse(&["src", ""], &cfg).unwrap();
		assert_eq!(got.dest, Some(OsString::from(".")));
	}

	#[test]
	fn virtual_scheme_operands_stay_local() {
		let vfs = |p: &OsStr| p.to_string_lossy().starts_with("mem://");
		let got = parse_operands(&os(&["mem://a", "host:b"]), &vfs, &OperandConfig::default())
			.unwrap();
		assert_eq!(got.remote, shell(None, "host"));
		assert_eq!(strs(&got.sources), ["mem://a"]);
		let got =
			parse_operands(&os(&["src", "mem://dest"]), &vfs, &OperandConfig::default()).unwrap();
		assert_eq!(got.remote, None);
		// A scheme the shell does not route is a host spec, as upstream parses it.
		let got =
			parse_operands(&os(&["src", "other://dest"]), &vfs, &OperandConfig::default()).unwrap();
		assert_eq!(got.remote, shell(None, "other"));
		assert_eq!(got.dest, Some(OsString::from("//dest")));
		// rsync:// is never virtual.
		let all = |_: &OsStr| true;
		let got =
			parse_operands(&os(&["rsync://h/m", "d"]), &all, &OperandConfig::default()).unwrap();
		assert_eq!(got.remote, daemon(None, "h", None));
	}

	#[test]
	fn read_batch_takes_only_a_local_destination() {
		let cfg = OperandConfig { read_batch: true, ..Default::default() };
		let got = parse(&["dest"], &cfg).unwrap();
		assert_eq!((got.remote, got.dest), (None, Some(OsString::from("dest"))));
	}

	#[test]
	fn atoi_truncates_like_c() {
		assert_eq!(atoi(b""), 0);
		assert_eq!(atoi(b"8730"), 8730);
		assert_eq!(atoi(b"4294967297"), 1);
		assert_eq!(atoi(b"99999999999999999999999"), -1);
	}

	#[test]
	fn out_of_range_url_port_fails_like_the_resolver() {
		let e = parse(&["rsync://localhost:70000/x/"], &OperandConfig::default()).unwrap_err();
		assert_eq!(e.code, 10);
		assert!(
			e.message.unwrap().starts_with("rsync: getaddrinfo: localhost 70000: "),
			"resolver text"
		);
		assert_eq!(e.site, Some(("clientserver.c", 165)));
	}

	#[test]
	fn windows_drive_and_unc_operands_are_local() {
		assert!(is_windows_local(b"C:\\x"));
		assert!(is_windows_local(b"C:/x"));
		assert!(is_windows_local(b"c:x"));
		assert!(is_windows_local(b"\\\\server\\share\\x"));
		assert!(is_windows_local(b"dir\\sub:file"));
		assert!(!is_windows_local(b"host:path"));
		assert!(!is_windows_local(b"ab:c\\d"));
	}

	#[cfg(windows)]
	#[test]
	fn windows_operands_parse_as_local_paths() {
		let got = ok(&["C:\\src", "D:dest"]);
		assert_eq!(got.remote, None);
		assert_eq!(strs(&got.sources), ["C:\\src"]);
		let got = ok(&["\\\\srv\\share\\x", "host:y"]);
		assert_eq!(got.remote, shell(None, "host"));
	}

	#[test]
	fn remote_args_follow_the_direction() {
		assert_eq!(strs(&ok(&["hh:a", ":b", "d"]).remote_args()), ["a", "b"]);
		assert_eq!(strs(&ok(&["s", "hh:x"]).remote_args()), ["x"]);
		assert!(ok(&["s", "d"]).remote_args().is_empty());
	}
}
