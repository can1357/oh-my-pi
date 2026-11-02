//! TCP connections to an rsync daemon: direct, through an HTTP `CONNECT` proxy
//! (`RSYNC_PROXY`), or through a helper program (`RSYNC_CONNECT_PROG`), with
//! `--address`, `-4`/`-6`, `--sockopts`, and `--contimeout`.

use std::{
	io::{self, Read, Write},
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
	time::{Duration, Instant},
};

use super::{ConnCtl, Connection, Sock, sock_halves, truncate};
use crate::rsync::log::syserr_text;
use crate::{
	host::ChildEnv,
	rsync::{
		exit::{RERR_CONTIMEOUT, RERR_IPC, RERR_SIGNAL, RERR_SOCKETIO, RsyncError},
		log::{Debug, LogCode, Logger},
	},
};

#[cfg(unix)]
#[path = "tcp/sock_unix.rs"]
mod sock;
#[cfg(windows)]
#[path = "tcp/sock_windows.rs"]
mod sock;

/// Upstream's proxy line/request buffer size (`PROXY_BUF_SIZE`).
const PROXY_BUF_SIZE: usize = 1024;
/// How long a connect-program socket pair waits for its own connection.
#[cfg(unix)]
const SOCKETPAIR_ACCEPT_TIMEOUT: Duration = Duration::from_secs(60);

/// TCP connect settings.
pub(crate) struct TcpConfig<'a> {
	/// Daemon host (brackets of an IPv6 literal already removed).
	pub host:            &'a str,
	/// Port to dial, upstream's `int` (873 by default).
	pub port:            i32,
	/// `--address`: local address to bind before connecting.
	pub bind_address:    Option<&'a str>,
	/// `-4`/`-6` (0 = any).
	pub af_hint:         u8,
	/// `--sockopts`.
	pub sockopts:        Option<&'a str>,
	/// `--contimeout`: bound on each connect attempt.
	pub connect_timeout: Option<Duration>,
	/// The shell's environment (`RSYNC_PROXY`, `RSYNC_CONNECT_PROG`,
	/// `RSYNC_SHELL`).
	pub getenv:          &'a dyn Fn(&str) -> Option<String>,
	pub logger:          &'a Logger,
}

/// The resolver's text for an unknown host or service (`EAI_NONAME`).
pub(crate) fn unknown_name_text() -> String {
	sock::gai_text(sock::EAI_NONAME)
}

fn socket_failure() -> RsyncError {
	RsyncError::bare(RERR_SOCKETIO).at("clientserver.c", 165)
}

fn socket_failure_msg(text: impl Into<String>) -> RsyncError {
	RsyncError::new(RERR_SOCKETIO, text).at("clientserver.c", 165)
}

/// TCP connect to a daemon (RSYNC_PROXY, RSYNC_CONNECT_PROG, --address, -4/-6,
/// --sockopts, --contimeout).
///
/// Diagnostics upstream prints while it keeps trying (bad socket options,
/// per-address connect failures, proxy refusals) go through `cfg.logger`; the
/// returned error carries the final exit (code 10 at clientserver.c(165),
/// code 35 at socket.c(437) for `--contimeout`).
pub(crate) fn connect_tcp(
	cfg: &TcpConfig<'_>,
	env: &ChildEnv,
	cancel: Arc<AtomicBool>,
) -> Result<Connection, RsyncError> {
	let logger = cfg.logger;
	if let Some(prog) = (cfg.getenv)("RSYNC_CONNECT_PROG") {
		let shell = (cfg.getenv)("RSYNC_SHELL");
		let posix_shell = cfg!(unix) || shell.is_some();
		let prog = if prog.contains('%') {
			if connect_host_unsafe(cfg.host, posix_shell) {
				return Err(socket_failure_msg("unsafe host characters for RSYNC_CONNECT_PROG"));
			}
			let host = if posix_shell { posix_quote(cfg.host) } else { cfg.host.to_owned() };
			expand_connect_prog(&prog, &host)
		} else {
			prog
		};
		if logger.levels().debug(Debug::Connect) >= 1 {
			let line = format!(
				"Using RSYNC_CONNECT_PROG instead of opening tcp connection to {} port {}\n",
				cfg.host, cfg.port
			);
			logger.rprintf(LogCode::Info, line.as_bytes());
		}
		return sock_exec(&prog, shell.as_deref(), env, cancel, logger);
	}
	if logger.levels().debug(Debug::Connect) >= 1 {
		let line = format!("opening tcp connection to {} port {}\n", cfg.host, cfg.port);
		logger.rprintf(LogCode::Info, line.as_bytes());
	}
	open_socket_out(cfg, &cancel)
}

/// An HTTP proxy from `RSYNC_PROXY` (`[USER:PASS@]HOST:PORT`).
struct Proxy {
	host: String,
	port: String,
	auth: Option<(String, String)>,
}

fn parse_proxy(spec: &str) -> Result<Proxy, RsyncError> {
	let spec = truncate(spec, PROXY_BUF_SIZE - 1);
	let (auth, hostport) = match spec.rfind('@') {
		Some(at) => {
			let Some((user, pass)) = spec[..at].split_once(':') else {
				return Err(socket_failure_msg(
					"invalid proxy specification: should be USER:PASS@HOST:PORT",
				));
			};
			(Some((user.to_owned(), pass.to_owned())), &spec[at + 1..])
		}
		None => (None, spec),
	};
	let Some((host, port)) = hostport.split_once(':') else {
		return Err(socket_failure_msg("invalid proxy specification: should be HOST:PORT"));
	};
	Ok(Proxy { host: host.to_owned(), port: truncate(port, 9).to_owned(), auth })
}

/// Why one connect attempt stopped.
enum Abort {
	Failed(io::Error),
	Timeout,
	Cancelled,
}

fn open_socket_out(
	cfg: &TcpConfig<'_>,
	cancel: &Arc<AtomicBool>,
) -> Result<Connection, RsyncError> {
	let logger = cfg.logger;
	let debug = logger.levels().debug(Debug::Connect);
	let proxy = match (cfg.getenv)("RSYNC_PROXY").filter(|p| !p.is_empty()) {
		Some(spec) => Some(parse_proxy(&spec)?),
		None => None,
	};
	let (host, service) = match &proxy {
		Some(proxy) => {
			if debug >= 1 {
				let line =
					format!("connection via http proxy {} port {}\n", proxy.host, proxy.port);
				logger.rprintf(LogCode::Info, line.as_bytes());
			}
			(proxy.host.clone(), proxy.port.clone())
		}
		None => (cfg.host.to_owned(), cfg.port.to_string()),
	};
	let family = sock::family(cfg.af_hint);
	let addrs = sock::resolve(Some(&host), Some(&service), family, false).map_err(|code| {
		socket_failure_msg(format!("rsync: getaddrinfo: {host} {service}: {}", sock::gai_text(code)))
	})?;

	let mut failures: Vec<(usize, io::Error)> = Vec::new();
	let mut connected = None;
	for (index, addr) in addrs.iter().enumerate() {
		let Ok(socket) = sock::Socket::new(addr) else { continue };
		if let Some(bind) = cfg.bind_address
			&& !bind_local(&socket, addr, bind, logger)
		{
			continue;
		}
		let deadline = cfg.connect_timeout.map(|t| Instant::now() + t);
		set_socket_options(&socket, cfg.sockopts, logger);
		match connect_polled(&socket, addr, deadline, cancel) {
			Ok(()) => {}
			Err(Abort::Timeout) => return Err(RsyncError::bare(RERR_CONTIMEOUT).at("socket.c", 437)),
			Err(Abort::Cancelled) => return Err(RsyncError::cancelled()),
			Err(Abort::Failed(err)) => {
				failures.push((index, err));
				continue;
			}
		}
		let stream = socket.into_stream().map_err(|_| socket_failure())?;
		#[cfg(unix)]
		super::no_sigpipe(std::os::fd::AsFd::as_fd(&stream));
		let ctl = ConnCtl::default();
		let (mut reader, mut writer, probe) = sock_halves(Sock::Tcp(stream), cancel, &ctl);
		if let Some(proxy) = &proxy {
			match establish_proxy(&mut *reader, &mut *writer, cfg.host, cfg.port, proxy, logger) {
				Ok(true) => {}
				Ok(false) => continue,
				Err(err) => return Err(err),
			}
		}
		if debug >= 2 {
			let line = format!("Connected to {host} ({})\n", sock::numeric_host(addr));
			logger.rprintf(LogCode::Info, line.as_bytes());
		}
		connected = Some(Connection { reader, writer, probe: Some(probe), child: None, ctl });
		break;
	}

	if connected.is_none() || debug >= 2 {
		for (index, err) in &failures {
			let text = format!("failed to connect to {host} ({})", sock::numeric_host(&addrs[*index]));
			logger.rsyserr(LogCode::Error, err, text.as_bytes());
		}
	}
	connected.ok_or_else(socket_failure)
}

/// `--address`: binds `socket` to the first local address of `bind` in the
/// candidate's family. A resolver failure is reported; a bind failure is not
/// (upstream stays silent, the machine may lack that family's address).
fn bind_local(socket: &sock::Socket, addr: &sock::Addr, bind: &str, logger: &Logger) -> bool {
	let locals = match sock::resolve(Some(bind), None, addr.family, true) {
		Ok(locals) => locals,
		Err(code) => {
			let line = format!("rsync: getaddrinfo {bind}: {}\n", sock::gai_text(code));
			logger.rprintf(LogCode::Error, line.as_bytes());
			return false;
		}
	};
	locals.iter().any(|local| socket.bind(local).is_ok())
}

/// Non-blocking connect, waiting in slices for completion, cancellation, or
/// the `--contimeout` deadline.
fn connect_polled(
	socket: &sock::Socket,
	addr: &sock::Addr,
	deadline: Option<Instant>,
	cancel: &AtomicBool,
) -> Result<(), Abort> {
	match socket.start_connect(addr) {
		Ok(true) => return Ok(()),
		Ok(false) => {}
		Err(err) => return Err(Abort::Failed(err)),
	}
	loop {
		if cancel.load(Ordering::Relaxed) {
			return Err(Abort::Cancelled);
		}
		let mut wait = Duration::from_millis(100);
		if let Some(at) = deadline {
			let now = Instant::now();
			if now >= at {
				return Err(Abort::Timeout);
			}
			wait = wait.min(at - now);
		}
		match socket.wait_writable(wait) {
			Ok(false) => {}
			Ok(true) => {
				return match socket.take_error() {
					Ok(None) => Ok(()),
					Ok(Some(err)) | Err(err) => Err(Abort::Failed(err)),
				};
			}
			Err(err) => return Err(Abort::Failed(err)),
		}
	}
}

/// How a `--sockopts` name is applied.
#[derive(Clone, Copy)]
enum OptKind {
	/// `NAME` (1) or `NAME=N`.
	Value,
	/// Always set to this value; `NAME=N` is a syntax error (but still set).
	On(i32),
}

/// Upstream's socket option table, restricted to what this platform defines.
fn socket_option(name: &str) -> Option<(i32, i32, OptKind)> {
	use sock::opt;
	const IPTOS_LOWDELAY: i32 = 0x10;
	const IPTOS_THROUGHPUT: i32 = 0x08;
	Some(match name {
		"SO_KEEPALIVE" => (opt::SOL_SOCKET, opt::SO_KEEPALIVE, OptKind::Value),
		"SO_REUSEADDR" => (opt::SOL_SOCKET, opt::SO_REUSEADDR, OptKind::Value),
		"SO_BROADCAST" => (opt::SOL_SOCKET, opt::SO_BROADCAST, OptKind::Value),
		"TCP_NODELAY" => (opt::IPPROTO_TCP, opt::TCP_NODELAY, OptKind::Value),
		"IPTOS_LOWDELAY" => (opt::IPPROTO_IP, opt::IP_TOS, OptKind::On(IPTOS_LOWDELAY)),
		"IPTOS_THROUGHPUT" => (opt::IPPROTO_IP, opt::IP_TOS, OptKind::On(IPTOS_THROUGHPUT)),
		"SO_SNDBUF" => (opt::SOL_SOCKET, opt::SO_SNDBUF, OptKind::Value),
		"SO_RCVBUF" => (opt::SOL_SOCKET, opt::SO_RCVBUF, OptKind::Value),
		"SO_SNDLOWAT" => (opt::SOL_SOCKET, opt::SO_SNDLOWAT, OptKind::Value),
		"SO_RCVLOWAT" => (opt::SOL_SOCKET, opt::SO_RCVLOWAT, OptKind::Value),
		"SO_SNDTIMEO" => (opt::SOL_SOCKET, opt::SO_SNDTIMEO, OptKind::Value),
		"SO_RCVTIMEO" => (opt::SOL_SOCKET, opt::SO_RCVTIMEO, OptKind::Value),
		_ => return None,
	})
}

/// One parsed `--sockopts` word.
#[derive(Debug, PartialEq, Eq)]
struct SockOpt<'a> {
	name:  &'a str,
	value: i32,
	/// `NAME=VALUE` was written.
	given: bool,
}

/// Splits `--sockopts` like `strtok(" \t,")`; `NAME=VALUE` takes `atoi(VALUE)`.
fn parse_sockopts(spec: &str) -> Vec<SockOpt<'_>> {
	spec.split([' ', '\t', ','])
		.filter(|tok| !tok.is_empty())
		.map(|tok| match tok.split_once('=') {
			Some((name, value)) => SockOpt { name, value: c_atoi(value), given: true },
			None => SockOpt { name: tok, value: 1, given: false },
		})
		.collect()
}

/// Applies `--sockopts`; problems are reported and skipped, as upstream does.
fn set_socket_options(socket: &sock::Socket, spec: Option<&str>, logger: &Logger) {
	let Some(spec) = spec else { return };
	for opt in parse_sockopts(spec) {
		let Some((level, name, kind)) = socket_option(opt.name) else {
			let line = format!("Unknown socket option {}\n", opt.name);
			logger.rprintf(LogCode::Error, line.as_bytes());
			continue;
		};
		let value = match kind {
			OptKind::Value => opt.value,
			OptKind::On(on) => {
				if opt.given {
					let line = format!("syntax error -- {} does not take a value\n", opt.name);
					logger.rprintf(LogCode::Error, line.as_bytes());
				}
				on
			}
		};
		if let Err(err) = socket.set_int(level, name, value) {
			let text = format!("failed to set socket option {}", opt.name);
			logger.rsyserr(LogCode::Error, &err, text.as_bytes());
		}
	}
}

/// C `atoi`: optional leading whitespace and sign, then digits; anything
/// else ends the number.
fn c_atoi(s: &str) -> i32 {
	let s = s.trim_start_matches([' ', '\t', '\n', '\r', '\x0b', '\x0c']);
	let (negative, digits) = match s.as_bytes().first() {
		Some(b'-') => (true, &s[1..]),
		Some(b'+') => (false, &s[1..]),
		_ => (false, s),
	};
	let mut value: i64 = 0;
	for b in digits.bytes().take_while(u8::is_ascii_digit) {
		value = value.saturating_mul(10).saturating_add(i64::from(b - b'0'));
	}
	(if negative { value.saturating_neg() } else { value }) as i32
}

/// The HTTP `CONNECT` request for `host:port`, with Basic proxy
/// authorization when credentials were given; Err carries upstream's text.
fn proxy_request(
	host: &str,
	port: i32,
	auth: Option<&(String, String)>,
) -> Result<String, &'static str> {
	if host.bytes().any(|b| b < 0x20 || b == 0x7f) {
		return Err("invalid control character in proxy CONNECT host");
	}
	let (header, token) = match auth {
		Some((user, pass)) => {
			let joined = format!("{user}:{pass}");
			let joined = truncate(&joined, PROXY_BUF_SIZE - 1);
			if (joined.len() * 8 + 5) / 6 >= PROXY_BUF_SIZE - 3 {
				return Err("authentication information is too long");
			}
			use base64::Engine as _;
			let token = base64::engine::general_purpose::STANDARD.encode(joined.as_bytes());
			("\r\nProxy-Authorization: Basic ", token)
		}
		None => ("", String::new()),
	};
	let request = format!("CONNECT {host}:{port} HTTP/1.0{header}{token}\r\n\r\n");
	if request.len() >= PROXY_BUF_SIZE {
		return Err("proxy CONNECT request too long");
	}
	Ok(request)
}

/// Outcome of reading one proxy response line.
enum ProxyLine {
	Line(Vec<u8>),
	TooLong,
	Failed(io::Error),
}

/// Reads one `\n`-terminated line of at most `PROXY_BUF_SIZE - 1` bytes
/// (the newline included), byte by byte so nothing past the header is
/// consumed.
fn read_proxy_line(reader: &mut dyn Read) -> Result<ProxyLine, RsyncError> {
	let mut line = Vec::new();
	while line.len() < PROXY_BUF_SIZE - 1 {
		let mut byte = [0u8; 1];
		match reader.read(&mut byte) {
			Ok(1) => {
				line.push(byte[0]);
				if byte[0] == b'\n' {
					return Ok(ProxyLine::Line(line));
				}
			}
			Ok(_) => return Ok(ProxyLine::Failed(io::Error::from_raw_os_error(0))),
			Err(err) if is_cancel(&err) => return Err(RsyncError::cancelled()),
			Err(err) => return Ok(ProxyLine::Failed(err)),
		}
	}
	Ok(ProxyLine::TooLong)
}

fn is_cancel(err: &io::Error) -> bool {
	err.get_ref()
		.and_then(|inner| inner.downcast_ref::<RsyncError>())
		.is_some_and(|e| e.code == RERR_SIGNAL)
}

/// Runs the `CONNECT` exchange. Ok(false) after a refusal or I/O problem
/// (already reported); Err only for cancellation.
fn establish_proxy(
	reader: &mut dyn Read,
	writer: &mut dyn Write,
	host: &str,
	port: i32,
	proxy: &Proxy,
	logger: &Logger,
) -> Result<bool, RsyncError> {
	let error = |text: String| {
		logger.rprintf(LogCode::Error, format!("{text}\n").as_bytes());
		Ok(false)
	};
	let request = match proxy_request(host, port, proxy.auth.as_ref()) {
		Ok(request) => request,
		Err(text) => return error(text.to_owned()),
	};
	if let Err(err) = writer.write_all(request.as_bytes()).and_then(|()| writer.flush()) {
		if is_cancel(&err) {
			return Err(RsyncError::cancelled());
		}
		logger.rsyserr(LogCode::Error, &err, b"failed to write to proxy");
		return Ok(false);
	}
	let status = match read_proxy_line(reader)? {
		ProxyLine::Line(line) => line,
		ProxyLine::TooLong => return error("proxy response line too long".to_owned()),
		ProxyLine::Failed(err) => {
			logger.rsyserr(LogCode::Error, &err, b"failed to read from proxy");
			return Ok(false);
		}
	};
	let mut status = &status[..status.len() - 1];
	if let Some(stripped) = status.strip_suffix(b"\r") {
		status = stripped;
	}
	if !proxy_status_ok(status) {
		return error(format!("bad response from proxy -- {}", String::from_utf8_lossy(status)));
	}
	loop {
		match read_proxy_line(reader)? {
			ProxyLine::Line(line) => {
				if line == b"\n" || line == b"\r\n" {
					return Ok(true);
				}
			}
			ProxyLine::TooLong => return error("proxy response header line too long".to_owned()),
			ProxyLine::Failed(err) => {
				logger.rsyserr(LogCode::Error, &err, b"failed to read from proxy");
				return Ok(false);
			}
		}
	}
}

/// `HTTP/<version> 2…`.
fn proxy_status_ok(status: &[u8]) -> bool {
	let Some(rest) = status.strip_prefix(b"HTTP/") else { return false };
	let after_version =
		rest.iter().position(|b| !(b.is_ascii_digit() || *b == b'.')).unwrap_or(rest.len());
	let rest = &rest[after_version..];
	let code_at = rest.iter().position(|&b| b != b' ').unwrap_or(rest.len());
	rest.get(code_at) == Some(&b'2')
}

/// A host that would not stay a single literal word through a (nested)
/// shell. On Windows' `cmd.exe`, `%` expands variables, so it is refused too.
fn connect_host_unsafe(host: &str, posix_shell: bool) -> bool {
	let Some(first) = host.bytes().next() else { return true };
	if b"-+~%".contains(&first) {
		return true;
	}
	host.bytes().any(|b| {
		!(b.is_ascii_alphanumeric() || b"._:-%+~".contains(&b)) || (!posix_shell && b == b'%')
	})
}

/// Single-quotes `s` for a POSIX shell.
fn posix_quote(s: &str) -> String {
	format!("'{}'", s.replace('\'', "'\\''"))
}

/// `%H` → `host`, `%%` → `%`; any other `%` passes through.
fn expand_connect_prog(prog: &str, host: &str) -> String {
	let mut out = String::with_capacity(prog.len() + host.len());
	let mut chars = prog.chars().peekable();
	while let Some(c) = chars.next() {
		if c == '%'
			&& let Some(expansion) = chars.next_if_map(|next| match next {
				'%' => Ok("%"),
				'H' => Ok(host),
				_ => Err(next),
			})
		{
			out.push_str(expansion);
			continue;
		}
		out.push(c);
	}
	out
}

/// Runs `prog` through the shell with its stdin/stdout on our connection: a
/// loopback TCP socket pair on unix (so a `rsync --daemon` helper sees a real
/// TCP peer, as with upstream), pipes on Windows.
fn sock_exec(
	prog: &str,
	shell: Option<&str>,
	env: &ChildEnv,
	cancel: Arc<AtomicBool>,
	logger: &Logger,
) -> Result<Connection, RsyncError> {
	let role = logger.role();
	if logger.levels().debug(Debug::Cmd) >= 1 {
		logger.rprintf(LogCode::Info, format!("Running socket program: \"{prog}\"\n").as_bytes());
	}
	let fork_error = |err: &io::Error| {
		RsyncError::new(RERR_IPC, syserr_text(role, err, "fork")).at("socket.c", 1069)
	};
	let cmd = match shell {
		Some(shell) => {
			let mut cmd = env.command(shell).map_err(|err| fork_error(&err))?;
			cmd.arg("-c").arg(prog);
			cmd
		}
		None => system_command(env, prog).map_err(|err| fork_error(&err))?,
	};
	#[cfg(unix)]
	{
		use std::os::fd::OwnedFd;
		let mut cmd = cmd;
		let (ours, theirs) = socketpair_tcp(&cancel).map_err(|err| {
			if is_cancel(&err) {
				RsyncError::cancelled()
			} else {
				socket_failure_msg(syserr_text(role, &err, "socketpair_tcp failed"))
			}
		})?;
		super::no_sigpipe(std::os::fd::AsFd::as_fd(&ours));
		let theirs_out = theirs.try_clone().map_err(|err| fork_error(&err))?;
		cmd.stdin(std::process::Stdio::from(OwnedFd::from(theirs)));
		cmd.stdout(std::process::Stdio::from(OwnedFd::from(theirs_out)));
		let spawned = cmd.spawn();
		drop(cmd);
		let ctl = ConnCtl::default();
		let child = match spawned {
			Ok(child) => {
				Some(super::ChildGuard::new(env, child, Arc::clone(&cancel), false, role))
			}
			// The program could not start: upstream's helper exits at once and
			// the client sees the connection close.
			Err(_) => None,
		};
		let (reader, writer, probe) = sock_halves(Sock::Tcp(ours), &cancel, &ctl);
		Ok(Connection { reader, writer, probe: Some(probe), child, ctl })
	}
	#[cfg(windows)]
	{
		let ctl = ConnCtl::default();
		super::spawn_piped(env, cmd, true, &cancel, &ctl, false, role).map_err(|err| fork_error(&err))
	}
}

/// `system(prog)`: `/bin/sh -c` on unix, `cmd.exe /C` on Windows.
fn system_command(env: &ChildEnv, prog: &str) -> io::Result<std::process::Command> {
	#[cfg(unix)]
	{
		let mut cmd = env.command("/bin/sh")?;
		cmd.arg("-c").arg(prog);
		Ok(cmd)
	}
	#[cfg(windows)]
	{
		use std::os::windows::process::CommandExt;
		let mut cmd = env.command("cmd.exe")?;
		cmd.raw_arg("/C").raw_arg(prog);
		Ok(cmd)
	}
}

/// A connected loopback TCP pair (ours, the program's), verified so that a
/// local process racing a connection onto the listener cannot take our place.
#[cfg(unix)]
fn socketpair_tcp(
	cancel: &AtomicBool,
) -> io::Result<(std::net::TcpStream, std::net::TcpStream)> {
	use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
	let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
	let target = listener.local_addr()?;
	let connector = TcpStream::connect(target)?;
	listener.set_nonblocking(true)?;
	let deadline = Instant::now() + SOCKETPAIR_ACCEPT_TIMEOUT;
	let accepted = loop {
		match listener.accept() {
			Ok((stream, _)) => break stream,
			Err(err) if matches!(err.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted) => {
				if cancel.load(Ordering::Relaxed) {
					return Err(RsyncError::cancelled_io());
				}
				if Instant::now() >= deadline {
					return Err(io::Error::from(io::ErrorKind::TimedOut));
				}
				std::thread::sleep(Duration::from_millis(10));
			}
			Err(err) => return Err(err),
		}
	};
	accepted.set_nonblocking(false)?;
	let peer = accepted.peer_addr()?;
	let local = connector.local_addr()?;
	let loopback = |addr: &SocketAddr| matches!(addr, SocketAddr::V4(v4) if v4.ip().is_loopback());
	if peer != local || !loopback(&peer) || !loopback(&local) {
		return Err(io::Error::from_raw_os_error(libc::EPERM));
	}
	Ok((accepted, connector))
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn proxy_spec_parsing_and_errors() {
		let p = parse_proxy("proxy.example:3128").unwrap();
		assert_eq!((p.host.as_str(), p.port.as_str(), p.auth.is_none()), ("proxy.example", "3128", true));
		let p = parse_proxy("us:er:p@ss@px:80").unwrap();
		assert_eq!(p.auth, Some(("us".to_owned(), "er:p@ss".to_owned())));
		assert_eq!(p.host, "px");
		let p = parse_proxy("px:1234567890123").unwrap();
		assert_eq!(p.port, "123456789");
		let err = parse_proxy("user@px:80").err().unwrap();
		assert_eq!(err.message.as_deref(), Some("invalid proxy specification: should be USER:PASS@HOST:PORT"));
		let err = parse_proxy("u:p@px").err().unwrap();
		assert_eq!(err.message.as_deref(), Some("invalid proxy specification: should be HOST:PORT"));
		assert_eq!((err.code, err.site), (10, Some(("clientserver.c", 165))));
	}

	#[test]
	fn proxy_request_format_and_limits() {
		assert_eq!(proxy_request("h", 873, None).unwrap(), "CONNECT h:873 HTTP/1.0\r\n\r\n");
		let auth = ("Aladdin".to_owned(), "open sesame".to_owned());
		assert_eq!(
			proxy_request("h", 873, Some(&auth)).unwrap(),
			"CONNECT h:873 HTTP/1.0\r\nProxy-Authorization: Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==\r\n\r\n"
		);
		assert_eq!(proxy_request("h\r\nX: y", 1, None), Err("invalid control character in proxy CONNECT host"));
		let long = ("u".repeat(800), "p".to_owned());
		assert_eq!(proxy_request("h", 1, Some(&long)), Err("authentication information is too long"));
		// The request must fit upstream's 1024-byte buffer with its NUL:
		// 1023 bytes is the longest accepted.
		assert_eq!(proxy_request(&"h".repeat(1000), 1, None).map(|r| r.len()), Ok(1023));
		assert_eq!(proxy_request(&"h".repeat(1001), 1, None), Err("proxy CONNECT request too long"));
	}

	fn quiet_logger() -> (Logger, Arc<std::sync::Mutex<Vec<u8>>>) {
		struct Shared(Arc<std::sync::Mutex<Vec<u8>>>);
		impl Write for Shared {
			fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
				self.0.lock().unwrap().extend_from_slice(buf);
				Ok(buf.len())
			}

			fn flush(&mut self) -> io::Result<()> {
				Ok(())
			}
		}
		let err = Arc::new(std::sync::Mutex::new(Vec::new()));
		let logger = Logger::local(
			Box::new(io::sink()),
			Box::new(Shared(Arc::clone(&err))),
			crate::rsync::log::LogConfig::default(),
		);
		(logger, err)
	}

	fn run_proxy(response: &[u8]) -> (Result<bool, RsyncError>, Vec<u8>, String) {
		let (logger, err) = quiet_logger();
		let proxy = Proxy { host: "px".into(), port: "1".into(), auth: None };
		let mut reader = io::Cursor::new(response.to_vec());
		let mut sent = Vec::new();
		let ok = establish_proxy(&mut reader, &mut sent, "daemon", 873, &proxy, &logger);
		let rest = response[usize::try_from(reader.position()).unwrap()..].to_vec();
		let text = String::from_utf8_lossy(&err.lock().unwrap()).into_owned();
		(ok, rest, text)
	}

	#[test]
	fn proxy_exchange_consumes_only_the_header() {
		let (ok, rest, text) =
			run_proxy(b"HTTP/1.1 200 Connection established\r\nVia: x\r\n\r\n@RSYNCD: 33.0\n");
		assert!(ok.unwrap(), "{text}");
		assert_eq!(rest, b"@RSYNCD: 33.0\n");
	}

	#[test]
	fn proxy_refusals_are_reported() {
		let (ok, _, text) = run_proxy(b"HTTP/1.0 403 Forbidden\r\n\r\n");
		assert!(!ok.unwrap());
		assert_eq!(text, "bad response from proxy -- HTTP/1.0 403 Forbidden\n");
		let (ok, _, text) = run_proxy(b"SSH-2.0-OpenSSH\r\n");
		assert!(!ok.unwrap());
		assert_eq!(text, "bad response from proxy -- SSH-2.0-OpenSSH\n");
		let mut long = vec![b'H'; 2000];
		long.push(b'\n');
		let (ok, _, text) = run_proxy(&long);
		assert!(!ok.unwrap());
		assert_eq!(text, "proxy response line too long\n");
		let mut header = b"HTTP/1.0 200 OK\r\n".to_vec();
		header.extend(vec![b'x'; 1500]);
		let (_, _, text) = run_proxy(&header);
		assert_eq!(text, "proxy response header line too long\n");
	}

	#[test]
	fn proxy_status_parsing() {
		assert!(proxy_status_ok(b"HTTP/1.1 200 OK"));
		assert!(proxy_status_ok(b"HTTP/2   204"));
		assert!(!proxy_status_ok(b"HTTP/1.1 407 Auth"));
		assert!(!proxy_status_ok(b"HTTP/1.1"));
	}

	#[test]
	fn sockopts_split_like_strtok() {
		let opts = parse_sockopts("FOO, SO_KEEPALIVE=1\tIPTOS_LOWDELAY=3,,SO_SNDBUF= 65536x");
		assert_eq!(
			opts,
			[
				SockOpt { name: "FOO", value: 1, given: false },
				SockOpt { name: "SO_KEEPALIVE", value: 1, given: true },
				SockOpt { name: "IPTOS_LOWDELAY", value: 3, given: true },
				// strtok splits at the space, so "SO_SNDBUF=" has an empty value
				// (atoi → 0) and "65536x" is a separate (unknown) option word.
				SockOpt { name: "SO_SNDBUF", value: 0, given: true },
				SockOpt { name: "65536x", value: 1, given: false },
			]
		);
		assert_eq!(c_atoi(" -42abc"), -42);
		assert!(socket_option("TCP_NODELAY").is_some());
		assert!(socket_option("tcp_nodelay").is_none());
	}

	#[test]
	fn connect_prog_host_quoting() {
		assert_eq!(expand_connect_prog("nc %H 873 %% %x %", "'h'"), "nc 'h' 873 % %x %");
		assert!(!connect_host_unsafe("fe80::1%eth0", true));
		assert!(connect_host_unsafe("fe80::1%eth0", false));
		for bad in ["", "-x", "+x", "~root", "%self", "a b", "a;b", "a'b", "a$b"] {
			assert!(connect_host_unsafe(bad, true), "{bad:?}");
		}
		assert_eq!(posix_quote("a'b"), "'a'\\''b'");
	}

	#[cfg(unix)]
	#[test]
	fn unsafe_connect_prog_host_is_refused() {
		let (logger, _) = quiet_logger();
		let env = |key: &str| (key == "RSYNC_CONNECT_PROG").then(|| "nc %H 873".to_owned());
		let cfg = TcpConfig {
			host: "x;reboot",
			port: 873,
			bind_address: None,
			af_hint: 0,
			sockopts: None,
			connect_timeout: None,
			getenv: &env,
			logger: &logger,
		};
		let (host, _) = crate::host::Host::for_test("rsync", "", std::env::temp_dir());
		let err = connect_tcp(&cfg, &host.child_env(), Arc::new(AtomicBool::new(false)))
			.err()
			.unwrap();
		assert_eq!(err.message.as_deref(), Some("unsafe host characters for RSYNC_CONNECT_PROG"));
		assert_eq!(err.code, RERR_SOCKETIO);
	}

	#[cfg(unix)]
	#[test]
	fn connect_prog_talks_over_a_tcp_pair() {
		let (logger, _) = quiet_logger();
		let env = |key: &str| match key {
			"RSYNC_CONNECT_PROG" => Some("printf 'host=%s\\n' %H; cat".to_owned()),
			_ => None,
		};
		let cfg = TcpConfig {
			host: "example.org",
			port: 873,
			bind_address: None,
			af_hint: 0,
			sockopts: None,
			connect_timeout: None,
			getenv: &env,
			logger: &logger,
		};
		let (mut host, _) = crate::host::Host::for_test("rsync", "", std::env::temp_dir());
		host.set_test_var("PATH", "/usr/bin:/bin");
		let mut conn = connect_tcp(&cfg, &host.child_env(), Arc::new(AtomicBool::new(false))).unwrap();
		conn.writer.write_all(b"ping\n").unwrap();
		let mut got = [0u8; 22];
		conn.reader.read_exact(&mut got).unwrap();
		assert_eq!(&got, b"host=example.org\nping\n");
		conn.finish().unwrap();
	}

	#[test]
	fn refused_connection_reports_each_address() {
		let (logger, err) = quiet_logger();
		let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
		let port = i32::from(listener.local_addr().unwrap().port());
		drop(listener);
		let env = |_: &str| -> Option<String> { None };
		let cfg = TcpConfig {
			host: "127.0.0.1",
			port,
			bind_address: None,
			af_hint: 4,
			sockopts: Some("NOPE,IPTOS_LOWDELAY=3"),
			connect_timeout: None,
			getenv: &env,
			logger: &logger,
		};
		let (host, _) = crate::host::Host::for_test("rsync", "", std::env::temp_dir());
		let e = connect_tcp(&cfg, &host.child_env(), Arc::new(AtomicBool::new(false))).err().unwrap();
		assert_eq!((e.code, e.site), (RERR_SOCKETIO, Some(("clientserver.c", 165))));
		let text = String::from_utf8_lossy(&err.lock().unwrap()).into_owned();
		assert!(text.starts_with("Unknown socket option NOPE\nsyntax error -- IPTOS_LOWDELAY does not take a value\n"), "{text}");
		assert!(text.contains("failed to connect to 127.0.0.1 (127.0.0.1): "), "{text}");
	}

	#[test]
	fn unresolvable_host_reports_getaddrinfo() {
		let (logger, _) = quiet_logger();
		let env = |_: &str| -> Option<String> { None };
		let cfg = TcpConfig {
			host: "nonexistent.invalid",
			port: 873,
			bind_address: None,
			af_hint: 0,
			sockopts: None,
			connect_timeout: None,
			getenv: &env,
			logger: &logger,
		};
		let (host, _) = crate::host::Host::for_test("rsync", "", std::env::temp_dir());
		let e = connect_tcp(&cfg, &host.child_env(), Arc::new(AtomicBool::new(false))).err().unwrap();
		assert!(
			e.message.unwrap().starts_with("rsync: getaddrinfo: nonexistent.invalid 873: "),
			"resolver message"
		);
	}

	#[test]
	fn direct_connection_and_contimeout() {
		let (logger, _) = quiet_logger();
		let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
		let port = i32::from(listener.local_addr().unwrap().port());
		let env = |_: &str| -> Option<String> { None };
		let cfg = TcpConfig {
			host: "127.0.0.1",
			port,
			bind_address: Some("127.0.0.1"),
			af_hint: 0,
			sockopts: Some("TCP_NODELAY,SO_KEEPALIVE"),
			connect_timeout: Some(Duration::from_secs(5)),
			getenv: &env,
			logger: &logger,
		};
		let (host, _) = crate::host::Host::for_test("rsync", "", std::env::temp_dir());
		let mut conn = connect_tcp(&cfg, &host.child_env(), Arc::new(AtomicBool::new(false))).unwrap();
		let (mut server, _) = listener.accept().unwrap();
		server.write_all(b"@RSYNCD: 33.0\n").unwrap();
		let mut got = [0u8; 14];
		conn.reader.read_exact(&mut got).unwrap();
		assert_eq!(&got, b"@RSYNCD: 33.0\n");
	}
}
