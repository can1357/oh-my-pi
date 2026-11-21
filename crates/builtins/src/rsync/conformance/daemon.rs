//! A reference `rsync --daemon` per side, killed on drop.

use std::fs;
use std::io::{BufRead, BufReader};
use std::net::{TcpListener, TcpStream};
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// Message of the day every listing and transfer prints (unless `--no-motd`).
const MOTD: &str = "Welcome to the conformance daemon\n";

/// Fresh ports tried before giving up.
const ATTEMPTS: usize = 6;

/// How long one attempt waits for the daemon to accept connections. Generous:
/// a loaded machine can take seconds to schedule a freshly spawned process.
const READY_DEADLINE: Duration = Duration::from_secs(30);

/// A running daemon serving `w`'s modules:
///
/// - `rw`: `w/rw`, writable;
/// - `ro`: `w/src`, read-only (the default);
/// - `auth`: `w/src`, user `alice` with password `sekrit` (`{BIN}/pw`);
/// - `hidden`: `w/src`, unlisted.
pub(super) struct Daemon {
	child: Child,
	/// The port it listens on.
	pub(super) port: u16,
}

/// Why one start attempt failed.
enum Failure {
	/// The daemon exited (typically: another process took the port between
	/// our probe and its bind).
	Exited(String),
	/// It never answered with a greeting before the deadline.
	NotReady,
}

impl Daemon {
	/// Starts the daemon with its config, secrets, motd, and log under `dir`
	/// and waits until it greets on its port. A port race (the probed port is
	/// taken before the daemon binds it) or a slow start retries on a fresh
	/// port; after [`ATTEMPTS`] failures this panics with the daemon log.
	pub(super) fn start(reference: &Path, dir: &Path, w: &Path) -> Self {
		fs::create_dir_all(dir).unwrap();
		let secrets = dir.join("secrets");
		fs::write(&secrets, "alice:sekrit\n").unwrap();
		fs::set_permissions(&secrets, fs::Permissions::from_mode(0o600)).unwrap();
		fs::write(dir.join("motd"), MOTD).unwrap();
		let log = dir.join("log");
		let (d, w) = (dir.display(), w.display());
		let conf = format!(
			"pid file = {d}/pid\nlog file = {d}/log\nmotd file = {d}/motd\nuse chroot = no\n\
			 munge symlinks = no\n\n\
			 [rw]\n\tpath = {w}/rw\n\tcomment = read-write module\n\tread only = no\n\n\
			 [ro]\n\tpath = {w}/src\n\tcomment = read-only module\n\n\
			 [auth]\n\tpath = {w}/src\n\tcomment = needs a password\n\tauth users = alice\n\
			 \tsecrets file = {d}/secrets\n\n\
			 [hidden]\n\tpath = {w}/src\n\tlist = no\n"
		);
		let config = dir.join("rsyncd.conf");
		fs::write(&config, conf).unwrap();
		let mut history = String::new();
		for attempt in 1..=ATTEMPTS {
			// A stale pid file from a failed attempt makes the daemon refuse
			// to start; a fresh log keeps each attempt's report separate.
			let _ = fs::remove_file(dir.join("pid"));
			let _ = fs::remove_file(&log);
			let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
			let mut child = Command::new(reference)
				.arg("--daemon")
				.arg("--no-detach")
				.arg(format!("--port={port}"))
				.arg(format!("--config={}", config.display()))
				.env_clear()
				.stdin(Stdio::null())
				.stdout(Stdio::null())
				.stderr(Stdio::null())
				.spawn()
				.unwrap();
			let failure = match wait_ready(&mut child, port) {
				Ok(()) => return Self { child, port },
				Err(failure) => failure,
			};
			let _ = child.kill();
			let _ = child.wait();
			let why = match failure {
				Failure::Exited(status) => format!("exited ({status})"),
				Failure::NotReady => format!("did not greet within {READY_DEADLINE:?}"),
			};
			let log_text = fs::read_to_string(&log).unwrap_or_else(|e| format!("<no log: {e}>"));
			history.push_str(&format!("attempt {attempt}, port {port}: {why}; log:\n{log_text}\n"));
		}
		panic!("reference daemon failed to start after {ATTEMPTS} attempts:\n{history}");
	}
}

/// Waits until `child` answers on `port` with an `@RSYNCD:` greeting, or it
/// exits, or the deadline passes. The greeting matters: when another process
/// holds the IPv4 port, the daemon still starts on IPv6 alone, and a bare
/// connect would reach the foreign listener.
fn wait_ready(child: &mut Child, port: u16) -> Result<(), Failure> {
	let deadline = Instant::now() + READY_DEADLINE;
	loop {
		if let Ok(Some(status)) = child.try_wait() {
			return Err(Failure::Exited(status.to_string()));
		}
		if greets(port) {
			// Still ours: a daemon that lost the bind race exits.
			return match child.try_wait() {
				Ok(Some(status)) => Err(Failure::Exited(status.to_string())),
				_ => Ok(()),
			};
		}
		if Instant::now() >= deadline {
			return Err(Failure::NotReady);
		}
		std::thread::sleep(Duration::from_millis(25));
	}
}

/// Whether something on `port` sends an rsync daemon greeting.
fn greets(port: u16) -> bool {
	let Ok(stream) = TcpStream::connect(("127.0.0.1", port)) else { return false };
	if stream.set_read_timeout(Some(Duration::from_secs(5))).is_err() {
		return false;
	}
	let mut line = String::new();
	BufReader::new(stream).read_line(&mut line).is_ok() && line.starts_with("@RSYNCD: ")
}

impl Drop for Daemon {
	fn drop(&mut self) {
		let _ = self.child.kill();
		let _ = self.child.wait();
	}
}
