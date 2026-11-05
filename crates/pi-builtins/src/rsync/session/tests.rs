//! End-to-end runs of the builtin: local copies (both halves in-process),
//! transfers against the reference `rsync --server` through a fake remote
//! shell, batch round trips, and the option outcomes.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use super::*;
use crate::host::run_util;
use crate::rsync::Rsync;

fn run(argv: &[&str], cwd: &Path) -> (i32, String, String) {
	let (code, cap) = run_util::<Rsync>(argv, "", cwd);
	(code, cap.out(), cap.err())
}

/// The reference rsync 3.x binary, when one is installed.
fn reference() -> Option<PathBuf> {
	let mut candidates = vec![PathBuf::from("/opt/homebrew/bin/rsync")];
	if let Some(path) = std::env::var_os("PATH") {
		candidates.extend(std::env::split_paths(&path).map(|d| d.join("rsync")));
	}
	candidates.into_iter().find(|p| {
		Command::new(p)
			.arg("--version")
			.output()
			.is_ok_and(|o| String::from_utf8_lossy(&o.stdout).starts_with("rsync  version 3."))
	})
}

/// A small tree: a file, a nested file, and (unix) a symlink.
fn make_tree(root: &Path) {
	fs::create_dir_all(root.join("sub")).unwrap();
	fs::write(root.join("a"), b"hello\n").unwrap();
	fs::write(root.join("sub/b"), b"x\n").unwrap();
	fs::write(root.join("big"), (0..200_000u32).flat_map(|i| i.to_le_bytes()).collect::<Vec<u8>>()).unwrap();
	#[cfg(unix)]
	std::os::unix::fs::symlink("a", root.join("link")).unwrap();
}

/// Asserts `b` mirrors `a` (contents, symlink targets, and mtimes of files).
fn assert_same_tree(a: &Path, b: &Path) {
	let mut names: Vec<_> = fs::read_dir(a).unwrap().map(|e| e.unwrap().file_name()).collect();
	names.sort();
	let mut other: Vec<_> = fs::read_dir(b).unwrap().map(|e| e.unwrap().file_name()).collect();
	other.sort();
	assert_eq!(names, other, "entries of {}", b.display());
	for name in names {
		let (pa, pb) = (a.join(&name), b.join(&name));
		let ma = fs::symlink_metadata(&pa).unwrap();
		let mb = fs::symlink_metadata(&pb).unwrap();
		assert_eq!(ma.file_type().is_dir(), mb.file_type().is_dir(), "{}", pb.display());
		if ma.file_type().is_symlink() {
			assert_eq!(fs::read_link(&pa).unwrap(), fs::read_link(&pb).unwrap());
		} else if ma.is_dir() {
			assert_same_tree(&pa, &pb);
		} else {
			assert_eq!(fs::read(&pa).unwrap(), fs::read(&pb).unwrap(), "{}", pb.display());
		}
	}
}

fn mtime(p: &Path) -> std::time::SystemTime {
	fs::metadata(p).unwrap().modified().unwrap()
}

/// The physical path of `dir`, resolved like `realpath`: `fs::canonicalize`
/// spells Windows paths `\\?\…`, where `/` is not a separator.
fn physical(dir: &Path) -> PathBuf {
	pi_vfs::BlockingFs::native().canonicalize_with(dir, &pi_vfs::CanonicalizeOptions::default()).unwrap()
}

#[test]
fn version_and_help_go_to_stdout() {
	let dir = tempfile::tempdir().unwrap();
	let (code, out, err) = run(&["--version"], dir.path());
	assert_eq!(code, 0);
	assert!(out.starts_with("rsync  version 3.5.1  protocol version 33\n"), "{out}");
	assert_eq!(err, "");
	let (code, out, _) = run(&["--help"], dir.path());
	assert_eq!(code, 0);
	assert!(out.contains("Usage: rsync [OPTION]... SRC [SRC]... DEST"), "{out}");
}

/// Captured from rsync 3.5.1: no arguments prints the usage to stderr.
#[test]
fn no_arguments_is_a_usage_error() {
	let dir = tempfile::tempdir().unwrap();
	let (code, out, err) = run(&[], dir.path());
	assert_eq!(code, 1);
	assert_eq!(out, "");
	assert!(err.ends_with("rsync error: syntax or usage error (code 1) at main.c(1898) [client=3.5.1]\n"), "{err}");
}

#[test]
fn daemon_mode_is_refused() {
	let dir = tempfile::tempdir().unwrap();
	let (code, _, err) = run(&["--daemon"], dir.path());
	assert_eq!(code, 4);
	assert!(err.starts_with("rsync: --daemon is not supported by this rsync\n"), "{err}");
	assert!(err.contains("(code 4) at main.c(1954)"), "{err}");
}

/// A local copy's server half that its client stops before the half has
/// finished its own side of the protocol exchange ends as rsync 3.5.1's
/// local child does when SIGUSR1 reaches it there: `received SIGUSR1 (code
/// 19) at main.c(1687)`, not the line of a cancelled exchange. Here the stop
/// is raised before the half starts, so its exchange always fails as
/// cancelled. Before, only a protocol mismatch took that path, and the race
/// this covers showed up about 3 times in 2,000 runs of
/// `too_old_protocol_is_a_mismatch`, so a regression would have been a rare
/// flake; a review asked for this deterministic test.
#[test]
fn a_local_half_stopped_during_its_protocol_exchange_ends_with_sigusr1() {
	let dir = tempfile::tempdir().unwrap();
	let (mut host, cap) = crate::host::Host::for_test("rsync", Vec::new(), dir.path());
	let mut io = HostIo::new(&mut host, Arc::new(HashMap::new()), OsString::from("rsync"));
	let kill = Arc::new(AtomicBool::new(true));
	io.cancel = Arc::clone(&kill);
	let getenv = |_: &str| None;
	let argv: Vec<OsString> = ["-a", "src/", "d/"].iter().map(OsString::from).collect();
	let Ok(Parsed::Run(client)) = options::parse(&argv, &getenv) else {
		panic!("the client's options did not parse");
	};
	let mut sopts = options::local_server_options(&client, &getenv).unwrap();
	sopts.args = vec![OsString::from("."), OsString::from("d/")];
	sopts.old_style_args = 2;
	let filters = Filters::new(FilterConfig { am_server: true, local_server: true, role: Role::Server, ..FilterConfig::default() });
	let (_client, server) = transport::local_pair(Arc::clone(&kill));
	let info = handshake::local_client_info(&client, false);
	let code = server_main(&io, sopts, Some(LocalServer { conn: server, client_info: info, filters }));
	assert_eq!((code, cap.err()), (RERR_SIGNAL1, "rsync error: received SIGUSR1 (code 19) at main.c(1687) [Receiver=3.5.1]\n".to_owned()));
}

/// A `--server --sender` whose output is blocked still reads its peer. With
/// `--timeout=4`, a peer that stops reading the server's output for 6
/// seconds after setup, but sends an empty `MSG_DATA` frame every 250 ms,
/// keeps the transfer alive, as rsync 3.5.1's `perform_io` reads while it
/// waits to write: a review measured rsync 3.5.1 surviving this exchange and
/// sending the 388,292 bytes it held once reads resumed. Without a readiness
/// probe on the server's stdin a pass waiting to write read nothing, the
/// frames never counted as input, and the server exited with code 30 after 4
/// seconds, as it still does at upstream main. A review of #17849 found it;
/// the probes this change gives a server's stdio are what fix it.
#[cfg(unix)]
#[test]
fn a_blocked_server_sender_reads_its_peers_frames() {
	use std::io::{Read, Write};

	struct FdIn(Arc<fs::File>);
	impl Read for FdIn {
		fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
			(&*self.0).read(buf)
		}
	}
	impl Write for FdIn {
		fn write(&mut self, _: &[u8]) -> io::Result<usize> {
			Err(io::ErrorKind::Unsupported.into())
		}
		fn flush(&mut self) -> io::Result<()> {
			Ok(())
		}
	}
	impl crate::openfile::Stream for FdIn {
		fn raw_fd(&self) -> Option<std::os::fd::RawFd> {
			Some(std::os::fd::AsRawFd::as_raw_fd(&*self.0))
		}
	}

	let dir = tempfile::tempdir().unwrap();
	let src = dir.path().join("src");
	fs::create_dir(&src).unwrap();
	// A file list far larger than a pipe holds.
	for i in 0..2000 {
		fs::write(src.join(format!("{i:05}-{}", "x".repeat(180))), b"").unwrap();
	}
	let (to_server_r, to_server_w) = nix::unistd::pipe().unwrap();
	let (from_server_r, from_server_w) = nix::unistd::pipe().unwrap();
	let (mut host, cap) =
		crate::host::Host::for_test_with_stdin("rsync", Box::new(FdIn(Arc::new(fs::File::from(to_server_r)))), dir.path());
	host.set_test_stdout(fs::File::from(from_server_w).into());
	let peer = thread::spawn(move || {
		let (mut to_server, mut from_server) = (fs::File::from(to_server_w), fs::File::from(from_server_r));
		to_server.write_all(&31u32.to_le_bytes())?;
		// Protocol, compatibility flags and checksum seed.
		from_server.read_exact(&mut [0u8; 9])?;
		// The empty filter list, as one multiplexed data frame.
		to_server.write_all(&[4, 0, 0, 7, 0, 0, 0, 0])?;
		let quiet = Instant::now();
		while quiet.elapsed() < Duration::from_secs(6) {
			thread::sleep(Duration::from_millis(250));
			if to_server.write_all(&[0, 0, 0, 7]).is_err() {
				break;
			}
		}
		let mut drained = Vec::new();
		let mut buf = vec![0u8; 1 << 16];
		while drained.len() < 300_000 {
			match from_server.read(&mut buf)? {
				0 => break,
				n => drained.extend_from_slice(&buf[..n]),
			}
		}
		io::Result::Ok(drained.len())
	});
	let argv: Vec<OsString> =
		["rsync", "--server", "--sender", "-r", "--protocol=31", "--timeout=4", ".", "src/"].iter().map(OsString::from).collect();
	let started = Instant::now();
	let code = super::run(&mut host, argv);
	let lasted = started.elapsed();
	// The server's ends of both pipes close with the host, so a peer still
	// waiting on them sees the end rather than waiting for ever.
	drop(host);
	let drained = peer.join().unwrap();
	let err = cap.err();
	assert!(!err.contains("timeout"), "the server timed out after {lasted:?} while its peer kept it alive: {err}");
	assert_ne!(code, RERR_TIMEOUT, "{err}");
	assert!(lasted >= Duration::from_secs(6), "the server ended after {lasted:?}: {err}");
	assert!(drained.is_ok_and(|n| n >= 300_000), "the held file list did not come once reads resumed: {err}");
}

/// A `--server --sender` that times out while its peer has stopped reading
/// lets go of its stdout once the run ends. Its output thread used to stay
/// with the write it could not finish for as long as the process lived,
/// holding the descriptor, so the shell's next command still found the old
/// pipe open: a review of #17849 found it, at upstream main as well. Here
/// the peer completes setup, then neither reads nor writes; the run times
/// out after 4 seconds, and once the host is gone the pipe must report that
/// no writer is left within 2 seconds. The check polls the read end without
/// reading it, because draining the pipe would let a held thread finish its
/// writes and close the pipe on its own.
#[cfg(unix)]
#[test]
fn a_timed_out_server_releases_its_stdout() {
	use std::io::{Read, Write};
	use std::os::fd::AsRawFd;

	struct FdIn(Arc<fs::File>);
	impl Read for FdIn {
		fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
			(&*self.0).read(buf)
		}
	}
	impl Write for FdIn {
		fn write(&mut self, _: &[u8]) -> io::Result<usize> {
			Err(io::ErrorKind::Unsupported.into())
		}
		fn flush(&mut self) -> io::Result<()> {
			Ok(())
		}
	}
	impl crate::openfile::Stream for FdIn {
		fn raw_fd(&self) -> Option<std::os::fd::RawFd> {
			Some(std::os::fd::AsRawFd::as_raw_fd(&*self.0))
		}
	}

	let dir = tempfile::tempdir().unwrap();
	let src = dir.path().join("src");
	fs::create_dir(&src).unwrap();
	for i in 0..2000 {
		fs::write(src.join(format!("{i:05}-{}", "x".repeat(180))), b"").unwrap();
	}
	let (to_server_r, to_server_w) = nix::unistd::pipe().unwrap();
	let (from_server_r, from_server_w) = nix::unistd::pipe().unwrap();
	let (mut host, cap) =
		crate::host::Host::for_test_with_stdin("rsync", Box::new(FdIn(Arc::new(fs::File::from(to_server_r)))), dir.path());
	host.set_test_stdout(fs::File::from(from_server_w).into());
	let (ended_tx, ended) = std::sync::mpsc::channel::<()>();
	let peer = thread::spawn(move || {
		let (mut to_server, mut from_server) = (fs::File::from(to_server_w), fs::File::from(from_server_r));
		to_server.write_all(&31u32.to_le_bytes())?;
		from_server.read_exact(&mut [0u8; 9])?;
		to_server.write_all(&[4, 0, 0, 7, 0, 0, 0, 0])?;
		// Silent and not reading until the run is over and the host is gone.
		let _ = ended.recv();
		let deadline = Instant::now() + Duration::from_secs(2);
		while Instant::now() < deadline {
			let mut pfd = libc::pollfd { fd: from_server.as_raw_fd(), events: libc::POLLIN, revents: 0 };
			// SAFETY: one pollfd, valid for the call, on a descriptor this thread owns.
			if unsafe { libc::poll(&mut pfd, 1, 100) } > 0 && pfd.revents & libc::POLLHUP != 0 {
				return io::Result::Ok(true);
			}
		}
		drop(to_server);
		io::Result::Ok(false)
	});
	let argv: Vec<OsString> =
		["rsync", "--server", "--sender", "-r", "--protocol=31", "--timeout=4", ".", "src/"].iter().map(OsString::from).collect();
	let code = super::run(&mut host, argv);
	let err = cap.err();
	drop(host);
	ended_tx.send(()).unwrap();
	let released = peer.join().unwrap();
	assert_eq!(code, RERR_TIMEOUT, "the run was meant to time out: {err}");
	assert!(released.is_ok_and(|r| r), "a writer of the server's stdout was still open 2 s after the run ended: {err}");
}

/// Captured from rsync 3.5.1: `rsync --protocol=19 -a src/ d/` on a local copy.
#[test]
fn too_old_protocol_is_a_mismatch() {
	let dir = tempfile::tempdir().unwrap();
	make_tree(&dir.path().join("src"));
	let (code, _, err) = run(&["--protocol=19", "-a", "src/", "d/"], dir.path());
	assert_eq!(code, 2);
	// The server half fails the same check and is stopped by its client
	// (upstream: SIGUSR1 to the local child).
	assert_eq!(
		err,
		"protocol version mismatch -- is your shell clean?\n(see the rsync manpage for an explanation)\n\
		 rsync error: protocol incompatibility (code 2) at compat.c(625) [sender=3.5.1]\n\
		 rsync error: received SIGUSR1 (code 19) at main.c(1687) [Receiver=3.5.1]\n"
	);
}

/// Captured from rsync 3.5.1: when the server half of a local copy fails while
/// setting up, the client exits with its code and prints nothing of its own.
#[test]
fn local_server_setup_failure_is_reported_once() {
	let tmp = tempfile::tempdir().unwrap();
	let dir = physical(tmp.path());
	fs::create_dir_all(dir.join("src")).unwrap();
	fs::write(dir.join("src/a"), b"a\n").unwrap();
	// A file list far larger than the in-process pipe, so the client is still
	// writing it when the server half gives up.
	for i in 0..600 {
		let name = format!("{i:04}-a-rather-long-file-name-to-make-the-file-list-big.txt");
		fs::write(dir.join("src").join(name), b"x").unwrap();
	}
	let (code, _, err) = run(&["-ai", "src/", "dst/new/deeper/"], &dir);
	assert_eq!(code, 11, "{err}");
	assert_eq!(
		err,
		format!(
			"rsync: [Receiver] mkdir \"{}/dst/new/deeper\" failed: No such file or directory (2)\n\
			 rsync error: error in file IO (code 11) at main.c(821) [Receiver=3.5.1]\n",
			String::from_utf8_lossy(&crate::rsync::paths::path_bytes(&dir))
		)
	);
	let (code, _, err) = run(&["-ai", "--temp-dir=../nope", "src/", "dst2/"], &dir);
	assert_eq!(code, 1, "{err}");
	assert_eq!(
		err,
		"The temp-dir does not exist: ../nope\n\
		 rsync error: syntax or usage error (code 1) at main.c(1069) [Receiver=3.5.1]\n"
	);
}

/// Captured from rsync 3.5.1: `rsync --protocol=40 -a src/ d/`.
#[test]
fn too_new_protocol_option_on_a_local_copy() {
	let dir = tempfile::tempdir().unwrap();
	make_tree(&dir.path().join("src"));
	let (code, _, err) = run(&["--protocol=40", "-a", "src/", "d/"], dir.path());
	assert_eq!(code, 2);
	assert_eq!(
		err,
		"--protocol must be no more than 33 on the Client.\n\
		 rsync error: protocol incompatibility (code 2) at compat.c(639) [sender=3.5.1]\n\
		 rsync error: received SIGUSR1 (code 19) at main.c(1687) [Receiver=3.5.1]\n"
	);
}

/// Captured from rsync 3.5.1 (a build without preallocation): `rsync --preallocate f h`.
#[test]
fn preallocate_is_refused_by_the_receiving_half() {
	let dir = tempfile::tempdir().unwrap();
	fs::write(dir.path().join("f"), b"x\n").unwrap();
	let (code, _, err) = run(&["--preallocate", "f", "h"], dir.path());
	if crate::rsync::usage::SUPPORT_PREALLOCATION {
		assert_eq!(code, 0, "{err}");
		return;
	}
	assert_eq!(code, 12, "{err}");
	assert_eq!(
		err,
		"preallocation is not supported on this Server\n\
		 rsync error: syntax or usage error (code 1) at compat.c(660) [Receiver=3.5.1]\n\
		 rsync: connection unexpectedly closed (0 bytes received so far) [sender]\n\
		 rsync error: error in rsync protocol data stream (code 12) at io.c(303) [sender=3.5.1]\n"
	);
}

/// Protocol 33 MSG_BLOCK_STATS: the receiving half's 4 KiB block count reaches
/// the sending client's --stats (rsync 3.5.1 prints 1 for this delta).
#[test]
fn touched_blocks_reach_the_sending_client() {
	let dir = tempfile::tempdir().unwrap();
	let data: Vec<u8> = (0..65536u32).map(|i| (i.wrapping_mul(2_654_435_761) >> 13) as u8).collect();
	fs::write(dir.path().join("src"), &data).unwrap();
	fs::write(dir.path().join("dst"), &data).unwrap();
	let mut changed = data;
	changed[..3].copy_from_slice(b"xyz");
	fs::write(dir.path().join("src"), &changed).unwrap();
	let (code, out, err) = run(&["-a", "--stats", "--inplace", "-I", "--no-whole-file", "src", "dst"], dir.path());
	assert_eq!((code, err.as_str()), (0, ""), "{out}");
	assert!(out.contains("Number of 4 KiB logical blocks touched: 1\n"), "{out}");
	assert_eq!(fs::read(dir.path().join("dst")).unwrap(), changed);
}

/// `--confine-root` bounds option paths and --files-from entries, not the
/// transfer roots or the list file (rsync 3.5.1 exits 0 for both).
#[test]
fn confine_root_leaves_roots_and_list_file_alone() {
	let tmp = tempfile::tempdir().unwrap();
	// Physical paths: the confine check (like the reference's) refuses a path
	// that only reaches the root through an alias such as macOS's /var symlink.
	let dir = physical(tmp.path());
	let root = dir.join("X/root");
	fs::create_dir_all(&root).unwrap();
	fs::write(root.join("keep"), b"k\n").unwrap();
	fs::write(dir.join("list"), b"keep\n").unwrap();
	let confine = format!("--confine-root={}", root.display());
	let keep = root.join("keep");
	let (code, _, err) = run(&["-r", &confine, keep.to_str().unwrap(), "d/"], &dir);
	assert_eq!((code, err.as_str()), (0, ""));
	assert_eq!(fs::read(dir.join("d/keep")).unwrap(), b"k\n");
	let list = format!("--files-from={}", dir.join("list").display());
	let src = format!("{}/", root.display());
	let (code, _, err) = run(&["-r", &confine, &list, &src, "d2/"], &dir);
	assert_eq!((code, err.as_str()), (0, ""));
	assert_eq!(fs::read(dir.join("d2/keep")).unwrap(), b"k\n");
}

/// `host://path` is a host spec unless the shell's filesystem routes the scheme.
#[test]
fn url_spelled_operand_without_a_provider_is_remote() {
	let fs = crate::host::ShellPaths::default().fs().clone();
	assert!(!routes_locally(&fs, OsStr::new("localhost:///tmp/x")));
	assert!(!routes_locally(&fs, OsStr::new("/tmp/x")));
}

#[cfg(unix)]
#[test]
fn url_spelled_remote_operand_reaches_the_shell() {
	let Some(rsync) = reference() else { return };
	let dir = tempfile::tempdir().unwrap();
	fs::create_dir_all(dir.path().join("Y/src")).unwrap();
	fs::write(dir.path().join("Y/src/file"), b"hi\n").unwrap();
	let rsh = fake_rsh(dir.path());
	let rpath = format!("--rsync-path={}", rsync.display());
	let source = format!("h:/{}/Y/src/file", dir.path().display());
	assert!(source.starts_with("h://"));
	let (code, _, err) = run(&["-a", "-e", rsh.to_str().unwrap(), &rpath, &source, "d1/"], dir.path());
	assert_eq!((code, err.as_str()), (0, ""));
	assert_eq!(fs::read(dir.path().join("d1/file")).unwrap(), b"hi\n");
}

/// Parses "sent X bytes  received Y bytes" (commas allowed) from a line.
fn sent_received(line: &str) -> (i64, i64) {
	let num = |word: &str| word.replace(',', "").parse::<i64>().unwrap();
	let words: Vec<&str> = line.split_whitespace().collect();
	let at = |key: &str| words.iter().position(|w| *w == key).map(|i| num(words[i + 1])).unwrap();
	(at("sent"), at("received"))
}

/// The bytes of the log-file exit line (`sent N bytes  received M bytes  total size T`).
fn log_exit_line(log: &str) -> (i64, i64) {
	let line = log.lines().find(|l| l.contains("] sent ") && l.contains(" total size ")).unwrap();
	sent_received(line)
}

/// The --log-file exit line reports the connection's live byte counters (log_exit),
/// which include what was exchanged after the --stats snapshot (handle_stats).
/// Every comparison is within one run, because byte totals can vary between runs.
#[test]
fn log_file_exit_line_uses_live_counters() {
	let dir = tempfile::tempdir().unwrap();
	let src = dir.path().join("src");
	fs::create_dir_all(&src).unwrap();
	fs::write(src.join("a"), (0..300_000u32).map(|i| (i.wrapping_mul(2_654_435_761) >> 11) as u8).collect::<Vec<u8>>()).unwrap();
	fs::write(src.join("b"), b"hi\n").unwrap();

	// Local push. A clean client run with --stats writes no exit line, but one
	// ending with code 23 writes both (the summary, then log_exit on the error
	// exit), so a missing extra source puts the two in one run. Measured with
	// rsync 3.5.1 (`-a --stats --log-file=r.log src/ nope dst/`, six runs, all
	// identical): --stats sent 300,244 / received 57, log line sent 300249 /
	// received 74. That is +5 sent (the sender's goodbye NDX_DONE frame) and +17
	// received (the receiver's MSG_BLOCK_STATS frame, 12, and goodbye frame, 5).
	let (code, out, _) = run(&["-a", "--stats", "--log-file=r.log", "src/", "nope", "d1/"], dir.path());
	assert_eq!(code, 23, "{out}");
	let summary = sent_received(out.lines().find(|l| l.starts_with("sent ")).unwrap());
	let log = fs::read_to_string(dir.path().join("r.log")).unwrap();
	assert_eq!(log_exit_line(&log), (summary.0 + 5, summary.1 + 17), "{log}");

	// Pull from the reference server. A pulling client logs the exit line only
	// on a clean run without --stats, so its counterpart is the server's own
	// log line for the same connection: the client sent exactly what the
	// server received. The client received what the server sent, plus whatever
	// the server wrote after logging. Measured with rsync 3.5.1 on both ends
	// (five runs): client sent 70 = server received 70 every time; client
	// received 300264 or 300280 against server sent 300264.
	#[cfg(unix)]
	{
		use std::os::unix::fs::PermissionsExt;
		let Some(rsync) = reference() else { return };
		// Runs the remote command through sh so --rsync-path can carry options.
		let rsh = dir.path().join("shrsh");
		fs::write(&rsh, "#!/bin/sh\nshift\nexec /bin/sh -c \"$*\"\n").unwrap();
		fs::set_permissions(&rsh, fs::Permissions::from_mode(0o755)).unwrap();
		let server_log = dir.path().join("s.log");
		let rpath = format!("--rsync-path={} --log-file={}", rsync.display(), server_log.display());
		let source = format!("h:{}/src/", dir.path().display());
		let (code, _, err) = run(&["-a", "--log-file=p.log", "-e", rsh.to_str().unwrap(), &rpath, &source, "p/"], dir.path());
		assert_eq!((code, err.as_str()), (0, ""));
		let client = log_exit_line(&fs::read_to_string(dir.path().join("p.log")).unwrap());
		let server = log_exit_line(&fs::read_to_string(&server_log).unwrap());
		assert_eq!(client.0, server.1, "client sent vs server received");
		assert!(matches!(client.1 - server.0, 0 | 16), "client received {} vs server sent {}", client.1, server.0);
	}
}

/// Local `--delete` copies terminate at protocol 29 (the server's input is not
/// multiplexed, so its reads never refill) and at 33 (inc-recursion: the receiver's
/// successes are messages that can hold back its forwarded lists): before the
/// receiver blocks on the socket it hands every queued item to the generator.
#[test]
fn local_delete_copies_terminate() {
	for args in [&["-aiH", "--delete", "--protocol=29"][..], &["-ai", "--delete", "--protocol=29"], &["-ai", "--delete"]] {
		let dir = tempfile::tempdir().unwrap();
		make_tree(&dir.path().join("src"));
		fs::create_dir_all(dir.path().join("dst/sub")).unwrap();
		fs::write(dir.path().join("dst/stale"), b"x").unwrap();
		fs::write(dir.path().join("dst/sub/stale2"), b"y").unwrap();
		let cwd = dir.path().to_path_buf();
		let mut argv: Vec<&'static str> = args.to_vec();
		argv.extend(["src/", "dst/"]);
		let (tx, rx) = std::sync::mpsc::channel();
		std::thread::spawn(move || {
			let _ = tx.send(run(&argv, &cwd));
		});
		let (code, _, err) = rx.recv_timeout(std::time::Duration::from_secs(60)).expect("local --delete copy hung");
		assert_eq!((code, err.as_str()), (0, ""), "{args:?}");
		assert!(!dir.path().join("dst/stale").exists() && !dir.path().join("dst/sub/stale2").exists());
	}
}

/// Byte totals are a function of the transfer, give or take where a frame
/// ends. rsync 3.5.1 closes its pending data frame whenever it has to wait
/// for input (`io.c` `perform_io`), so a run that waited once more reports
/// one more 4-byte multiplex header: on this tree it did in 16 of 200 runs on
/// two busy CPUs (none of 200 idle), and the builtin in 1 of 200, idle and
/// busy alike. The same local copy run repeatedly must therefore report
/// counts that differ only by whole headers; apart by anything else, or by
/// more than four headers (the bound the conformance harness allows, after a
/// three-header difference was measured under load), frames meet reads where
/// upstream's would not.
#[test]
fn local_copy_byte_totals_differ_only_by_frame_headers() {
	let dir = tempfile::tempdir().unwrap();
	make_tree(&dir.path().join("src"));
	for i in 0..20 {
		fs::write(dir.path().join(format!("src/sub/f{i}")), format!("file {i}\n").repeat(i + 1)).unwrap();
	}
	let mut totals = Vec::new();
	for run_no in 0..5 {
		let dest = format!("d{run_no}/");
		let (code, out, err) = run(&["-a", "--stats", "src/", &dest], dir.path());
		assert_eq!((code, err.as_str()), (0, ""), "{out}");
		let summary = out.lines().find(|l| l.starts_with("sent ")).unwrap();
		totals.push(sent_received(summary));
	}
	for (which, count) in [("sent", 0), ("received", 1)] {
		let values: Vec<i64> = totals.iter().map(|t| if count == 0 { t.0 } else { t.1 }).collect();
		let (least, most) = (values.iter().min().unwrap(), values.iter().max().unwrap());
		assert!(values.iter().all(|v| (v - least) % 4 == 0) && most - least <= 16, "{which}: {totals:?}");
	}
}

/// A server's stdio may be O_NONBLOCK: EAGAIN is retried, not fatal.
#[test]
fn shared_writer_retries_would_block() {
	struct Flaky {
		left: usize,
		out: Arc<Mutex<Vec<u8>>>,
	}
	impl Write for Flaky {
		fn write(&mut self, b: &[u8]) -> io::Result<usize> {
			if self.left > 0 {
				self.left -= 1;
				return Err(io::ErrorKind::WouldBlock.into());
			}
			lock(&self.out).extend_from_slice(b);
			Ok(b.len())
		}
		fn flush(&mut self) -> io::Result<()> {
			Ok(())
		}
	}
	let out = Arc::new(Mutex::new(Vec::new()));
	let cancel = Arc::new(AtomicBool::new(false));
	let mut w = SharedWrite::new(Box::new(Flaky { left: 3, out: Arc::clone(&out) }), &cancel);
	w.write_all(b"data").unwrap();
	assert_eq!(&*lock(&out), b"data");
	let mut stuck = SharedWrite::new(Box::new(Flaky { left: usize::MAX, out }), &cancel);
	cancel.store(true, Ordering::Relaxed);
	let err = stuck.write_all(b"x").unwrap_err();
	assert_eq!(RsyncError::from_io(&err, 0).code, RERR_SIGNAL);
}

/// Cancelling while the client waits on its peer (a remote shell that never
/// answers) ends the run promptly with upstream's signal exit: code 20 and the
/// `received SIGINT, SIGTERM, or SIGHUP (code 20) at rsync.c(874)` trailer.
#[cfg(unix)]
#[test]
fn cancel_mid_connection_exits_20_with_trailer() {
	use std::os::unix::fs::PermissionsExt;

	use clap::Parser as _;
	let dir = tempfile::tempdir().unwrap();
	make_tree(&dir.path().join("src"));
	let rsh = dir.path().join("stuckrsh");
	fs::write(&rsh, "#!/bin/sh\nexec sleep 30\n").unwrap();
	fs::set_permissions(&rsh, fs::Permissions::from_mode(0o755)).unwrap();
	let (mut host, cap) = crate::host::Host::for_test_owning("rsync", Vec::new(), dir.path());
	let cancel = host.cancel_flag_for_test();
	let canceller = std::thread::spawn(move || {
		std::thread::sleep(Duration::from_millis(300));
		cancel.store(true, Ordering::Relaxed);
	});
	let rsh_arg = rsh.to_str().unwrap().to_string();
	let parsed = Rsync::try_parse_from(["rsync", "--", "-a", "-e", &rsh_arg, "src/", "h:dst/"]).unwrap();
	let started = Instant::now();
	let code = crate::host::run_caught::<Rsync>(parsed, &mut host);
	canceller.join().unwrap();
	assert_eq!(code, RERR_SIGNAL);
	assert!(started.elapsed() < Duration::from_secs(10), "cancellation was not prompt");
	assert_eq!(cap.err(), "rsync error: received SIGINT, SIGTERM, or SIGHUP (code 20) at rsync.c(874) [sender=3.5.1]\n");
}

/// Cancelling a local copy mid-transfer. A cancellation of the command
/// reaches the server half as well as the client, as a signal to the process
/// group does: the half ends at its next I/O step with its own code-20 line,
/// and the client follows. rsync 3.5.1 (`rsync -a --bwlimit=500 bigsrc/
/// dst/`, SIGTERM to the process group, 10 runs) printed these two lines in
/// 6; the client's line first then the half's in 2; the client's then the
/// half's SIGUSR1 line in 2.
///
/// Both lines are out well inside the 400 ms upstream sleeps before its own
/// (it cannot see its child; this half is a thread of this process, so the
/// client waits for the half's report instead and goes straight on). A host
/// that stops collecting a cancelled command's output once the command
/// returns keeps only what was written by then, and with the sleep the
/// client's line came too late for it.
#[test]
fn cancel_local_copy_reports_like_upstream() {
	use clap::Parser as _;
	let dir = tempfile::tempdir().unwrap();
	fs::create_dir_all(dir.path().join("bigsrc")).unwrap();
	fs::write(dir.path().join("bigsrc/f"), vec![0u8; 8 << 20]).unwrap();
	let (mut host, cap) = crate::host::Host::for_test_owning("rsync", Vec::new(), dir.path());
	let cancel = host.cancel_flag_for_test();
	let (sent, cancelled_at) = std::sync::mpsc::channel();
	let canceller = std::thread::spawn(move || {
		std::thread::sleep(Duration::from_millis(500));
		cancel.store(true, Ordering::Relaxed);
		sent.send(Instant::now()).unwrap();
	});
	// --bwlimit keeps the copy running well past the cancellation.
	let parsed = Rsync::try_parse_from(["rsync", "--", "-a", "--bwlimit=500", "bigsrc/", "dst/"]).unwrap();
	let started = Instant::now();
	let code = crate::host::run_caught::<Rsync>(parsed, &mut host);
	let ended = Instant::now();
	canceller.join().unwrap();
	let after = ended.saturating_duration_since(cancelled_at.recv().unwrap());
	assert_eq!(code, RERR_SIGNAL);
	assert!(started.elapsed() < Duration::from_secs(10), "cancellation was not prompt");
	assert!(after < super::SIGNAL_GRACE, "the client's report came {after:?} after the cancellation");
	assert_eq!(
		cap.err(),
		"rsync error: received SIGINT, SIGTERM, or SIGHUP (code 20) at io.c(604) [generator=3.5.1]\n\
		 rsync error: received SIGINT, SIGTERM, or SIGHUP (code 20) at rsync.c(874) [sender=3.5.1]\n"
	);
}

/// Cancelling a local copy while its server half is still setting up (here
/// blocked opening a FIFO given as its log file, which nobody opens): the
/// half, which got the signal too but has no I/O step to end at, ends at
/// its client's stop, after the client's line. rsync 3.5.1 (`rsync -a
/// -M--log-file=FIFO src/ d/`, SIGTERM to the process group, 10 runs)
/// printed these two lines in 5; the half's SIGUSR1 line second in 3; the
/// half's code-20 line first in 2. The half's wait for a reader ends at its
/// stop; before, the client waited for the half until someone opened the
/// FIFO.
#[cfg(unix)]
#[test]
fn cancelling_a_local_copy_in_setup_reports_before_the_server_half() {
	use clap::Parser as _;
	let dir = tempfile::tempdir().unwrap();
	make_tree(&dir.path().join("src"));
	let fifo = dir.path().join("logfifo");
	assert!(Command::new("mkfifo").arg(&fifo).status().unwrap().success());
	let (mut host, cap) = crate::host::Host::for_test_owning("rsync", Vec::new(), dir.path());
	let cancel = host.cancel_flag_for_test();
	let canceller = std::thread::spawn(move || {
		std::thread::sleep(Duration::from_millis(300));
		cancel.store(true, Ordering::Relaxed);
	});
	let rescue = release_fifo_after(fifo.clone(), Duration::from_secs(10));
	let log_file = format!("-M--log-file={}", fifo.display());
	let parsed = Rsync::try_parse_from(["rsync", "--", "-a", log_file.as_str(), "src/", "d/"]).unwrap();
	let started = Instant::now();
	let code = crate::host::run_caught::<Rsync>(parsed, &mut host);
	let took = started.elapsed();
	canceller.join().unwrap();
	drop(rescue);
	assert!(took < Duration::from_secs(5), "the server half waited for its log FIFO: {took:?}");
	assert_eq!(code, RERR_SIGNAL);
	assert_eq!(
		cap.err(),
		"rsync error: received SIGINT, SIGTERM, or SIGHUP (code 20) at rsync.c(874) [sender=3.5.1]\n\
		 rsync error: received SIGINT, SIGTERM, or SIGHUP (code 20) at rsync.c(874) [Receiver=3.5.1]\n"
	);
}

/// A local copy whose client and server half both log to FIFOs, cancelled
/// with the client's log full; the half's log gets a reader `server_log_at`
/// after the cancellation, and both are drained 900 ms after it. Returns
/// stderr. Upstream's half of a client that logs opens its log only at its
/// first log write ("receiving file list"), so it is waiting there, past
/// the protocol setup, when the client is cancelled; the client sleeps
/// 400 ms (`sig_int`), signals the half, then logs its exit line, which
/// waits on its full log.
#[cfg(unix)]
fn both_logs_cancelled(server_log_at: Duration) -> (i32, String) {
	use std::io::Read as _;
	use std::os::unix::fs::OpenOptionsExt;

	use clap::Parser as _;
	let dir = tempfile::tempdir().unwrap();
	make_tree(&dir.path().join("src"));
	let (server_log, client_log) = (dir.path().join("serverlog"), dir.path().join("clientlog"));
	for fifo in [&server_log, &client_log] {
		assert!(Command::new("mkfifo").arg(fifo).status().unwrap().success());
	}
	// Both ends of the client's log, held here, so its open does not wait.
	let mut client_log_end =
		fs::OpenOptions::new().read(true).write(true).custom_flags(libc::O_NONBLOCK).open(&client_log).unwrap();
	let (mut host, cap) = crate::host::Host::for_test_owning("rsync", Vec::new(), dir.path());
	let cancel = host.cancel_flag_for_test();
	let release = server_log.clone();
	let driver = std::thread::spawn(move || {
		std::thread::sleep(Duration::from_millis(300));
		// Fill the client's log, then cancel: its exit line waits to be logged.
		while std::io::Write::write(&mut client_log_end, &[b'x'; 4096]).is_ok() {}
		cancel.store(true, Ordering::Relaxed);
		let cancelled = Instant::now();
		std::thread::sleep(server_log_at);
		// Let the server half open its log.
		let mut server_log_end = fs::OpenOptions::new().read(true).custom_flags(libc::O_NONBLOCK).open(&release).unwrap();
		std::thread::sleep((cancelled + Duration::from_millis(900)).saturating_duration_since(Instant::now()));
		// Then let both logs drain.
		let mut buf = [0u8; 65536];
		let deadline = Instant::now() + Duration::from_secs(10);
		while Instant::now() < deadline {
			let _ = server_log_end.read(&mut buf);
			match client_log_end.read(&mut buf) {
				Ok(0) => break,
				Ok(_) | Err(_) => std::thread::sleep(Duration::from_millis(10)),
			}
		}
	});
	let parsed = Rsync::try_parse_from([
		"rsync",
		"--",
		"-a",
		&format!("--log-file={}", client_log.display()),
		&format!("-M--log-file={}", server_log.display()),
		"src/",
		"d/",
	])
	.unwrap();
	let code = crate::host::run_caught::<Rsync>(parsed, &mut host);
	drop(driver);
	(code, cap.err())
}

/// [`both_logs_cancelled`] with the half's log opened 300 ms after the
/// cancellation, within the client's 400 ms: the half gets past its log and
/// ends at its next I/O step with its own line, before the client, whose
/// exit line waits on its log. rsync 3.5.1, SIGTERM to the process group, 10
/// runs: these two lines in 7, the client's alone in 3. (With the signal to
/// the client alone, which no cancellation of the builtin gives, rsync
/// printed the half's SIGUSR1 line instead, before or after the client's.)
#[cfg(unix)]
#[test]
fn a_half_past_its_log_reports_before_a_client_waiting_on_its_own() {
	let (code, err) = both_logs_cancelled(Duration::from_millis(300));
	assert_eq!(code, RERR_SIGNAL, "{err}");
	assert_eq!(
		err,
		"rsync error: received SIGINT, SIGTERM, or SIGHUP (code 20) at io.c(604) [Receiver=3.5.1]\n\
		 rsync error: received SIGINT, SIGTERM, or SIGHUP (code 20) at rsync.c(874) [sender=3.5.1]\n"
	);
}

/// [`both_logs_cancelled`] with the half's log opened 900 ms after the
/// cancellation, past the client's 400 ms: the half is still opening its
/// log, inside its first log write, when the client stops it, so its line
/// is lost (`rwrite`'s `in_block`) and the client's prints alone. rsync
/// 3.5.1, SIGTERM to the process group, 10 runs: this line alone in 7, the
/// half's code-20 line first in 3; to the client alone, this line in 15 of 15.
#[cfg(unix)]
#[test]
fn a_half_stopped_opening_its_log_prints_nothing_when_the_client_logs() {
	let (code, err) = both_logs_cancelled(Duration::from_millis(900));
	assert_eq!(code, RERR_SIGNAL, "{err}");
	assert_eq!(err, "rsync error: received SIGINT, SIGTERM, or SIGHUP (code 20) at rsync.c(874) [sender=3.5.1]\n");
}

/// Opens the other end of the FIFO at `path` (without waiting) every 50 ms
/// from `after` on, until dropped: a test whose run should not wait on the
/// FIFO then fails on its time limit instead of hanging.
#[cfg(unix)]
fn release_fifo_after(path: PathBuf, after: Duration) -> impl Drop {
	use std::os::unix::fs::OpenOptionsExt;
	struct Stop(Arc<AtomicBool>);
	impl Drop for Stop {
		fn drop(&mut self) {
			self.0.store(true, Ordering::Relaxed);
		}
	}
	let stop = Arc::new(AtomicBool::new(false));
	let flag = Arc::clone(&stop);
	std::thread::spawn(move || {
		let deadline = Instant::now() + after;
		while !flag.load(Ordering::Relaxed) {
			if Instant::now() >= deadline {
				for write in [false, true] {
					let _ = fs::OpenOptions::new().read(!write).write(write).custom_flags(libc::O_NONBLOCK).open(&path);
				}
			}
			std::thread::sleep(Duration::from_millis(50));
		}
	});
	Stop(stop)
}

/// Cancelling `--read-batch` while the batch file is a FIFO, one nobody
/// writes to or one whose writer sends nothing, and `--write-batch` while it
/// is a FIFO nobody reads, ends at once with upstream's signal exit as the
/// receiver. Captured from rsync 3.5.1 under `LC_ALL=C`, SIGTERM 0.6 s in,
/// three runs of each: exactly this line, exit 20. Before, the read or the
/// open did not observe the cancellation: the bash tool gave up on the
/// command with nothing printed, and `timeout` waited for it indefinitely.
/// There is no peer here to report before this run, so it reports without
/// waiting out rsync's 400 ms grace; sleeping it out put the line past the
/// window of a host that stops collecting output when the command returns.
#[cfg(unix)]
#[test]
fn cancelling_a_batch_on_a_fifo_reports_the_signal() {
	use std::os::unix::fs::OpenOptionsExt;

	use clap::Parser as _;
	let dir = tempfile::tempdir().unwrap();
	make_tree(&dir.path().join("src"));
	let fifo = dir.path().join("batch");
	assert!(Command::new("mkfifo").arg(&fifo).status().unwrap().success());
	let cases: [(&str, &[&str], bool); 3] = [
		("no writer", &["--read-batch=batch", "dst/"], false),
		("a silent writer", &["--read-batch=batch", "dst/"], true),
		("no reader", &["-a", "--write-batch=batch", "src/", "dst/"], false),
	];
	for (case, args, silent_writer) in cases {
		let held = silent_writer.then(|| {
			fs::OpenOptions::new().read(true).write(true).custom_flags(libc::O_NONBLOCK).open(&fifo).unwrap()
		});
		let rescue = release_fifo_after(fifo.clone(), Duration::from_secs(10));
		let (mut host, cap) = crate::host::Host::for_test_owning("rsync", Vec::new(), dir.path());
		let cancel = host.cancel_flag_for_test();
		let (sent, cancelled_at) = std::sync::mpsc::channel();
		let canceller = std::thread::spawn(move || {
			std::thread::sleep(Duration::from_millis(300));
			cancel.store(true, Ordering::Relaxed);
			sent.send(Instant::now()).unwrap();
		});
		let parsed = Rsync::try_parse_from(["rsync", "--"].into_iter().chain(args.iter().copied())).unwrap();
		let started = Instant::now();
		let code = crate::host::run_caught::<Rsync>(parsed, &mut host);
		let took = started.elapsed();
		let ended = Instant::now();
		canceller.join().unwrap();
		let after = ended.saturating_duration_since(cancelled_at.recv().unwrap());
		drop((rescue, held));
		assert!(took < Duration::from_secs(5), "{case}: {took:?}");
		// Nothing here reports before this run, so it must not wait out
		// rsync's grace: a host that stops collecting a cancelled command's
		// output when the command returns never saw the line below.
		assert!(after < super::SIGNAL_GRACE, "{case}: the report came {after:?} after the cancellation");
		assert_eq!(code, RERR_SIGNAL, "{case}: {}", cap.err());
		assert_eq!(
			cap.err(),
			"rsync error: received SIGINT, SIGTERM, or SIGHUP (code 20) at rsync.c(874) [Receiver=3.5.1]\n",
			"{case}"
		);
	}
}

/// A cancelled client stops its remote shell with SIGUSR1, as rsync 3.5.1's
/// exit cleanup does (`kill_all`), after its own trailer, and forwards what
/// the remote side prints for it before reaping it. rsync 3.5.1 with a real
/// server held in setup (`-e RSH --rsync-path=rsync -M--log-file=FIFO src/
/// h:dst/`, SIGTERM, three runs) printed its trailer, then the server's
/// `received SIGUSR1 (code 19) at main.c(1687) [server=3.5.1]`; here a shell
/// stands in for that server. Before, the remote shell was killed outright
/// the moment the run was cancelled, and the second line never came.
#[cfg(unix)]
#[test]
fn a_cancelled_client_lets_its_remote_shell_report_sigusr1() {
	use std::os::unix::fs::PermissionsExt;

	use clap::Parser as _;
	let dir = tempfile::tempdir().unwrap();
	make_tree(&dir.path().join("src"));
	let rsh = dir.path().join("trailerrsh");
	fs::write(
		&rsh,
		"#!/bin/sh\ntrap 'echo \"rsync error: received SIGUSR1 (code 19) at main.c(1687) [server=3.5.1]\" >&2; exit 19' USR1\nwhile :; do sleep 0.05; done\n",
	)
	.unwrap();
	fs::set_permissions(&rsh, fs::Permissions::from_mode(0o755)).unwrap();
	let (mut host, cap) = crate::host::Host::for_test_owning("rsync", Vec::new(), dir.path());
	let cancel = host.cancel_flag_for_test();
	let canceller = std::thread::spawn(move || {
		std::thread::sleep(Duration::from_millis(300));
		cancel.store(true, Ordering::Relaxed);
	});
	let rsh_arg = rsh.to_str().unwrap().to_string();
	let parsed = Rsync::try_parse_from(["rsync", "--", "-a", "-e", &rsh_arg, "src/", "h:dst/"]).unwrap();
	let started = Instant::now();
	let code = crate::host::run_caught::<Rsync>(parsed, &mut host);
	canceller.join().unwrap();
	assert_eq!(code, RERR_SIGNAL);
	assert!(started.elapsed() < Duration::from_secs(10), "cancellation was not prompt");
	assert_eq!(
		cap.err(),
		"rsync error: received SIGINT, SIGTERM, or SIGHUP (code 20) at rsync.c(874) [sender=3.5.1]\n\
		 rsync error: received SIGUSR1 (code 19) at main.c(1687) [server=3.5.1]\n"
	);
}

/// Cancelling a local copy whose server half's `--log-file` FIFO is full and
/// nobody drains it ends promptly, not held by the half's blocked log write:
/// the half drops its trailer (as rsync 3.5.1 drops a log line it cannot
/// write at once) and the client's line prints alone. rsync 3.5.1 under a
/// process-group SIGTERM with the FIFO nearly full printed this line alone
/// (6 of 10, the half's `io.c(604)` line with it in 4); the builtin prints
/// the more frequent one. Before, the client's wait for the half never
/// returned, so the run hung past its cancellation.
#[cfg(unix)]
#[test]
fn a_cancelled_copy_with_a_full_log_fifo_does_not_hang() {
	use std::io::Write as _;
	use std::os::unix::fs::OpenOptionsExt;

	use clap::Parser as _;
	let dir = tempfile::tempdir().unwrap();
	make_tree(&dir.path().join("src"));
	let fifo = dir.path().join("slog");
	assert!(Command::new("mkfifo").arg(&fifo).status().unwrap().success());
	// A reader keeps the FIFO open; a writer fills it so every log write blocks.
	let _reader = fs::OpenOptions::new().read(true).custom_flags(libc::O_NONBLOCK).open(&fifo).unwrap();
	let mut filler = fs::OpenOptions::new().write(true).custom_flags(libc::O_NONBLOCK).open(&fifo).unwrap();
	while filler.write(&[b'x'; 4096]).is_ok() {}
	let (mut host, cap) = crate::host::Host::for_test_owning("rsync", Vec::new(), dir.path());
	let cancel = host.cancel_flag_for_test();
	let canceller = std::thread::spawn(move || {
		std::thread::sleep(Duration::from_millis(300));
		cancel.store(true, Ordering::Relaxed);
	});
	let parsed = Rsync::try_parse_from(["rsync", "--", "-a", "-M--log-file=slog", "src/", "dst/"]).unwrap();
	let started = Instant::now();
	let code = crate::host::run_caught::<Rsync>(parsed, &mut host);
	canceller.join().unwrap();
	assert!(started.elapsed() < Duration::from_secs(10), "the run hung on the full log FIFO: {:?}", started.elapsed());
	assert_eq!(code, RERR_SIGNAL, "{}", cap.err());
	assert_eq!(cap.err(), "rsync error: received SIGINT, SIGTERM, or SIGHUP (code 20) at rsync.c(874) [sender=3.5.1]\n");
}

/// A daemon reached over a remote shell (`rsync -e RSH src/ h::mod/`),
/// cancelled during the daemon handshake: the client reports first, after
/// its 400 ms, then stops the remote shell, whose SIGUSR1 line follows, as
/// rsync 3.5.1's exit cleanup orders it (the client's line, then the remote
/// daemon's `received SIGUSR1`, in 6 of 6 runs in review, password-file and
/// early-input FIFOs). Before, the cancelled handshake dropped the
/// connection, which stopped the remote shell first. A shell stands in for
/// the remote daemon: it greets, then waits.
#[cfg(unix)]
#[test]
fn a_cancelled_daemon_handshake_reports_before_its_remote_shell() {
	use std::os::unix::fs::PermissionsExt;

	use clap::Parser as _;
	let dir = tempfile::tempdir().unwrap();
	make_tree(&dir.path().join("src"));
	let rsh = dir.path().join("daemonrsh");
	fs::write(
		&rsh,
		"#!/bin/sh\ntrap 'echo \"rsync error: received SIGUSR1 (code 19) at main.c(1687) [Receiver=3.5.1]\" >&2; exit 19' USR1\nprintf '@RSYNCD: 31.0\\n'\nwhile :; do sleep 0.05; done\n",
	)
	.unwrap();
	fs::set_permissions(&rsh, fs::Permissions::from_mode(0o755)).unwrap();
	let (mut host, cap) = crate::host::Host::for_test_owning("rsync", Vec::new(), dir.path());
	let cancel = host.cancel_flag_for_test();
	let canceller = std::thread::spawn(move || {
		std::thread::sleep(Duration::from_millis(300));
		cancel.store(true, Ordering::Relaxed);
	});
	let rsh_arg = rsh.to_str().unwrap().to_string();
	let parsed = Rsync::try_parse_from(["rsync", "--", "-a", "-e", &rsh_arg, "src/", "h::mod/"]).unwrap();
	let started = Instant::now();
	let code = crate::host::run_caught::<Rsync>(parsed, &mut host);
	canceller.join().unwrap();
	assert_eq!(code, RERR_SIGNAL, "{}", cap.err());
	assert!(started.elapsed() < Duration::from_secs(10), "cancellation was not prompt");
	assert_eq!(
		cap.err(),
		"rsync error: received SIGINT, SIGTERM, or SIGHUP (code 20) at rsync.c(874) [sender=3.5.1]\n\
		 rsync error: received SIGUSR1 (code 19) at main.c(1687) [Receiver=3.5.1]\n"
	);
}

/// A client cancelled while it opens its own `--log-file` FIFO, which nobody
/// reads, ends there, before any server half starts: the code-20 line alone
/// (rsync 3.5.1 opens that log before its signal handlers exist and dies
/// with no output; the pull request states this one difference). Before, it
/// went on, started its local half, and that half printed a protocol error.
#[cfg(unix)]
#[test]
fn a_client_cancelled_opening_its_log_starts_no_half() {
	use clap::Parser as _;
	let dir = tempfile::tempdir().unwrap();
	make_tree(&dir.path().join("src"));
	let fifo = dir.path().join("logfifo");
	assert!(Command::new("mkfifo").arg(&fifo).status().unwrap().success());
	let (mut host, cap) = crate::host::Host::for_test_owning("rsync", Vec::new(), dir.path());
	let cancel = host.cancel_flag_for_test();
	let canceller = std::thread::spawn(move || {
		std::thread::sleep(Duration::from_millis(600));
		cancel.store(true, Ordering::Relaxed);
	});
	let parsed = Rsync::try_parse_from(["rsync", "--", "-a", "--log-file=logfifo", "src/", "dst/"]).unwrap();
	let code = crate::host::run_caught::<Rsync>(parsed, &mut host);
	canceller.join().unwrap();
	assert_eq!(code, RERR_SIGNAL, "{}", cap.err());
	assert_eq!(cap.err(), "rsync error: received SIGINT, SIGTERM, or SIGHUP (code 20) at rsync.c(874) [sender=3.5.1]\n");
	assert!(!dir.path().join("dst").exists());
}

/// Cancelling a copy whose `--log-file`, `--write-batch` file or batch
/// script is a FIFO a reader holds but empties nothing from (filled before
/// the start) ends as rsync 3.5.1 does. rsync 3.5.1 under `LC_ALL=C`,
/// SIGTERM to the process group 0.6 s in, 10 runs of each: the log-file
/// line in 6 (the half's SIGUSR1 line alone in 4), the batch-file line in 10,
/// the batch-script lines in 6 (the client's line, then the half's SIGUSR1
/// line, in 4). A trailer due while the client's log write is blocked is
/// lost, as `rwrite` drops it, so only the server half's shows. Before, each
/// write stayed blocked until someone read the FIFO.
#[cfg(unix)]
#[test]
fn cancelling_a_write_to_a_full_fifo_ends_as_rsync_does() {
	use std::os::unix::fs::OpenOptionsExt;

	use clap::Parser as _;
	let cases: [(&str, &str, &[&str], &str); 3] = [
		(
			"log file",
			"logfifo",
			&["-a", "--log-file=logfifo", "src/", "dst/"],
			"rsync error: received SIGINT, SIGTERM, or SIGHUP (code 20) at io.c(604) [Receiver=3.5.1]\n",
		),
		(
			"batch file",
			"batch",
			&["-a", "--write-batch=batch", "src/", "dst/"],
			"rsync error: received SIGINT, SIGTERM, or SIGHUP (code 20) at rsync.c(874) [Receiver=3.5.1]\n",
		),
		(
			"batch script",
			"b.sh",
			&["-a", "--write-batch=b", "src/", "dst/"],
			"rsync error: received SIGINT, SIGTERM, or SIGHUP (code 20) at io.c(604) [Receiver=3.5.1]\n\
			 rsync error: received SIGINT, SIGTERM, or SIGHUP (code 20) at rsync.c(874) [sender=3.5.1]\n",
		),
	];
	for (case, fifo_name, args, expected) in cases {
		let dir = tempfile::tempdir().unwrap();
		make_tree(&dir.path().join("src"));
		let fifo = dir.path().join(fifo_name);
		assert!(Command::new("mkfifo").arg(&fifo).status().unwrap().success());
		let reader = fs::OpenOptions::new().read(true).custom_flags(libc::O_NONBLOCK).open(&fifo).unwrap();
		{
			let mut filler = fs::OpenOptions::new().write(true).custom_flags(libc::O_NONBLOCK).open(&fifo).unwrap();
			while std::io::Write::write(&mut filler, &[b'x'; 4096]).is_ok() {}
		}
		let rescue = release_fifo_after(fifo.clone(), Duration::from_secs(10));
		let (mut host, cap) = crate::host::Host::for_test_owning("rsync", Vec::new(), dir.path());
		let cancel = host.cancel_flag_for_test();
		let canceller = std::thread::spawn(move || {
			std::thread::sleep(Duration::from_millis(300));
			cancel.store(true, Ordering::Relaxed);
		});
		let parsed = Rsync::try_parse_from(["rsync", "--"].into_iter().chain(args.iter().copied())).unwrap();
		let started = Instant::now();
		let code = crate::host::run_caught::<Rsync>(parsed, &mut host);
		let took = started.elapsed();
		canceller.join().unwrap();
		drop((rescue, reader));
		assert!(took < Duration::from_secs(5), "{case}: {took:?}");
		assert_eq!((code, cap.err().as_str()), (RERR_SIGNAL, expected), "{case}");
	}
}

/// A cancelled run ends with upstream's signal exit (code 20).
#[test]
fn cancelled_run_exits_20() {
	use clap::Parser as _;
	let dir = tempfile::tempdir().unwrap();
	make_tree(&dir.path().join("src"));
	let (mut host, _cap) = crate::host::Host::for_test("rsync", Vec::new(), dir.path());
	host.cancel_for_test();
	let parsed = Rsync::try_parse_from(["rsync", "--", "-a", "src/", "dst/"]).unwrap();
	assert_eq!(crate::host::run_caught::<Rsync>(parsed, &mut host), RERR_SIGNAL);
}

/// What `dir/name` holds without following a symlink: its mode, its contents
/// (a symlink's target), and its `--fake-super` stat record, when the
/// filesystem has user xattrs.
#[cfg(target_os = "linux")]
fn stored(dir: &Path, name: &str) -> (u32, Vec<u8>, Option<Vec<u8>>) {
	use std::os::unix::ffi::OsStrExt;
	use std::os::unix::fs::MetadataExt;
	let path = dir.join(name);
	let meta = fs::symlink_metadata(&path).unwrap();
	let contents = if meta.file_type().is_symlink() {
		fs::read_link(&path).unwrap().as_os_str().as_bytes().to_vec()
	} else {
		fs::read(&path).unwrap()
	};
	let tree = crate::rsync::tree::Tree::open(
		&pi_vfs::BlockingFs::native(),
		dir,
		&crate::rsync::tree::TreeOpts::default(),
	)
	.unwrap();
	let record = tree
		.get_xattr(Path::new(name), std::ffi::OsStr::new(crate::rsync::meta::XSTAT_ATTR), false)
		.ok()
		.flatten();
	(meta.mode(), contents, record)
}

/// Whether user xattrs can be set on regular files under `dir`.
#[cfg(target_os = "linux")]
fn user_xattrs_work(dir: &Path) -> bool {
	fs::write(dir.join("xattr-probe"), b"").unwrap();
	let tree =
		crate::rsync::tree::Tree::open(&pi_vfs::BlockingFs::native(), dir, &crate::rsync::tree::TreeOpts::default())
			.unwrap();
	let works = tree.set_xattr(Path::new("xattr-probe"), std::ffi::OsStr::new("user.probe"), b"1", false).is_ok();
	fs::remove_file(dir.join("xattr-probe")).unwrap();
	works
}

/// Linux keeps no user xattr on a symlink, so `--fake-super` stores one as a
/// regular file holding its target (mode 0777 plus owner read-write) with the
/// real type in the stat record, reads such a file back as a symlink when
/// sending, and replaces a real symlink at the destination with a stored
/// one. Captured from rsync 3.5.1: `rsync -ai --fake-super src/ d1/` stores
/// `link -> f` as `0o100777`, contents `f`, `user.rsync.%stat` =
/// `120777 0,0 UID:GID`; a rerun prints nothing; `--fake-super d1/ d2/` lists
/// `cL+++++++++ link -> f` and stores it again; a real symlink in the
/// destination gets `cLc........ link -> f`.
#[cfg(target_os = "linux")]
#[test]
fn fake_super_stores_symlinks_as_files_holding_their_targets() {
	use std::os::unix::fs::{MetadataExt, symlink};
	let dir = tempfile::tempdir().unwrap();
	if !user_xattrs_work(dir.path()) {
		return;
	}
	let src = dir.path().join("src");
	fs::create_dir_all(&src).unwrap();
	fs::write(src.join("f"), b"data\n").unwrap();
	symlink("f", src.join("link")).unwrap();
	symlink("nowhere", src.join("dangling")).unwrap();
	let me = fs::metadata(dir.path()).unwrap();
	let record = format!("120777 0,0 {}:{}", me.uid(), me.gid()).into_bytes();

	let (code, out, err) = run(&["-ai", "--fake-super", "src/", "d1/"], dir.path());
	assert_eq!((code, err.as_str()), (0, ""), "{out}");
	assert!(out.contains("cL+++++++++ link -> f\n") && out.contains("cL+++++++++ dangling -> nowhere\n"), "{out}");
	let d1 = dir.path().join("d1");
	assert_eq!(stored(&d1, "link"), (0o100777, b"f".to_vec(), Some(record.clone())));
	assert_eq!(stored(&d1, "dangling"), (0o100777, b"nowhere".to_vec(), Some(record.clone())));

	let (code, out, err) = run(&["-ai", "--fake-super", "src/", "d1/"], dir.path());
	assert_eq!((code, out.as_str(), err.as_str()), (0, "", ""));

	let (code, out, err) = run(&["-ai", "--fake-super", "d1/", "d2/"], dir.path());
	assert_eq!((code, err.as_str()), (0, ""), "{out}");
	assert!(out.contains("cL+++++++++ link -> f\n"), "{out}");
	assert_eq!(stored(&dir.path().join("d2"), "link"), (0o100777, b"f".to_vec(), Some(record.clone())));
	// Named as an operand, a stored symlink is read the same way.
	let (code, out, err) = run(&["-ai", "--fake-super", "d1/link", "d3/"], dir.path());
	assert_eq!((code, err.as_str()), (0, ""), "{out}");
	assert!(out.contains("cL+++++++++ link -> f\n"), "{out}");
	assert_eq!(stored(&dir.path().join("d3"), "link"), (0o100777, b"f".to_vec(), Some(record.clone())));

	// A real symlink in the destination is replaced by a stored one; with its
	// time as the source's, only the target is reported, and with another
	// time the time too (rsync 3.5.1: `cLc........` and `cLc.t......`).
	let set_link_time = |path: &Path, secs: libc::time_t| {
		use std::os::unix::ffi::OsStrExt;
		let name = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
		let time = libc::timespec { tv_sec: secs, tv_nsec: 0 };
		let times = [time, time];
		let rc = unsafe { libc::utimensat(libc::AT_FDCWD, name.as_ptr(), times.as_ptr(), libc::AT_SYMLINK_NOFOLLOW) };
		assert_eq!(rc, 0, "{}", io::Error::last_os_error());
	};
	set_link_time(&src.join("link"), 978_307_200);
	for (name, secs, line) in [("d4", 978_307_200, "cLc........ link -> f\n"), ("d5", 1_012_608_000, "cLc.t...... link -> f\n")] {
		let dest = dir.path().join(name);
		fs::create_dir_all(&dest).unwrap();
		symlink("f", dest.join("link")).unwrap();
		set_link_time(&dest.join("link"), secs);
		let (code, out, err) = run(&["-ai", "--fake-super", "src/", &format!("{name}/")], dir.path());
		assert_eq!((code, err.as_str()), (0, ""), "{out}");
		assert!(out.contains(line), "{out}");
		assert_eq!(stored(&dest, "link"), (0o100777, b"f".to_vec(), Some(record.clone())));
		assert_eq!(fs::symlink_metadata(dest.join("link")).unwrap().mtime(), 978_307_200);
	}
}

/// `-b --inplace` copies a read-only destination file to its backup through
/// the handle that created the backup, as upstream's unlink_and_reopen does,
/// so the backup and the update both succeed. Captured from rsync 3.5.1
/// (`rsync -aib --inplace --backup-dir=BAK src/ dst/`, `dst/f` mode 0400):
/// exit 0, `dst/f` updated with the source's mode, `BAK/f` the old contents
/// with mode 0400.
#[cfg(unix)]
#[test]
fn inplace_backup_of_a_read_only_file_succeeds() {
	use std::os::unix::fs::PermissionsExt;
	let dir = tempfile::tempdir().unwrap();
	let (src, dst, bak) = (dir.path().join("src"), dir.path().join("dst"), dir.path().join("bak"));
	fs::create_dir_all(&src).unwrap();
	fs::create_dir_all(&dst).unwrap();
	fs::write(src.join("f"), b"data\n").unwrap();
	fs::set_permissions(src.join("f"), fs::Permissions::from_mode(0o664)).unwrap();
	let old = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(978_307_200);
	let read_only_original = || {
		let f = dst.join("f");
		if f.exists() {
			fs::set_permissions(&f, fs::Permissions::from_mode(0o600)).unwrap();
		}
		fs::write(&f, b"old-contents\n").unwrap();
		fs::set_permissions(&f, fs::Permissions::from_mode(0o400)).unwrap();
		fs::File::open(&f).unwrap().set_modified(old).unwrap();
	};
	let backup_dir = format!("--backup-dir={}", bak.display());
	for whole_file in ["-W", "--no-W"] {
		read_only_original();
		let (code, out, err) = run(&["-aib", "--inplace", whole_file, &backup_dir, "src/", "dst/"], dir.path());
		assert_eq!((code, err.as_str()), (0, ""), "{whole_file}: {out}");
		assert!(out.contains(">f.stp..... f\n"), "{whole_file}: {out}");
		assert_eq!(fs::read(dst.join("f")).unwrap(), b"data\n");
		assert_eq!(fs::metadata(dst.join("f")).unwrap().permissions().mode() & 0o7777, 0o664);
		assert_eq!(fs::read(bak.join("f")).unwrap(), b"old-contents\n");
		assert_eq!(fs::metadata(bak.join("f")).unwrap().permissions().mode() & 0o7777, 0o400);
		fs::remove_file(bak.join("f")).unwrap();
	}
}

#[test]
fn local_archive_copy_then_noop_rerun() {
	let dir = tempfile::tempdir().unwrap();
	let src = dir.path().join("src");
	make_tree(&src);
	let (code, out, err) = run(&["-ai", "src/", "dst/"], dir.path());
	assert_eq!((code, err.as_str()), (0, ""), "{out}");
	assert_same_tree(&src, &dir.path().join("dst"));
	assert_eq!(mtime(&src.join("big")), mtime(&dir.path().join("dst/big")));
	let mut expected = String::from("created directory dst\ncd+++++++++ ./\n>f+++++++++ a\n>f+++++++++ big\n");
	if cfg!(unix) {
		expected.push_str("cL+++++++++ link -> a\n");
	}
	expected.push_str("cd+++++++++ sub/\n>f+++++++++ sub/b\n");
	assert_eq!(out, expected);
	// Nothing changed: a second run itemizes nothing.
	let (code, out, err) = run(&["-ai", "src/", "dst/"], dir.path());
	assert_eq!((code, out.as_str(), err.as_str()), (0, "", ""));
}

#[test]
fn itemize_output_matches_reference() {
	let Some(rsync) = reference() else { return };
	let dir = tempfile::tempdir().unwrap();
	let src = dir.path().join("src");
	make_tree(&src);
	fs::create_dir_all(dir.path().join("ours")).unwrap();
	fs::create_dir_all(dir.path().join("theirs")).unwrap();
	fs::write(dir.path().join("ours/a"), b"old!!\n").unwrap();
	fs::write(dir.path().join("theirs/a"), b"old!!\n").unwrap();
	let theirs = Command::new(&rsync).args(["-ai", "src/", "theirs/"]).current_dir(dir.path()).output().unwrap();
	let (code, out, _) = run(&["-ai", "src/", "ours/"], dir.path());
	assert_eq!(code, 0);
	assert_eq!(out, String::from_utf8_lossy(&theirs.stdout));
	let theirs = Command::new(&rsync).args(["-ai", "src/", "theirs/"]).current_dir(dir.path()).output().unwrap();
	let (_, out, _) = run(&["-ai", "src/", "ours/"], dir.path());
	assert_eq!(out, String::from_utf8_lossy(&theirs.stdout));
}

#[test]
fn delete_removes_extraneous_files() {
	let dir = tempfile::tempdir().unwrap();
	let src = dir.path().join("src");
	make_tree(&src);
	assert_eq!(run(&["-a", "src/", "dst/"], dir.path()).0, 0);
	fs::write(dir.path().join("dst/extra"), b"gone").unwrap();
	fs::create_dir(dir.path().join("dst/olddir")).unwrap();
	// Adding the extras bumped dst's mtime; restore src's so only the deletions are itemized
	// rather than also `.d..t...... ./` whenever the writes crossed a timestamp tick.
	let src_mtime = fs::metadata(&src).unwrap().modified().unwrap();
	fs::set_times_nofollow(dir.path().join("dst"), fs::FileTimes::new().set_modified(src_mtime)).unwrap();
	let (code, out, err) = run(&["-ai", "--delete", "src/", "dst/"], dir.path());
	assert_eq!((code, err.as_str()), (0, ""));
	assert_eq!(out, "*deleting   olddir/\n*deleting   extra\n");
	assert_same_tree(&src, &dir.path().join("dst"));
}

#[test]
fn checksum_mode_catches_same_size_and_time() {
	let dir = tempfile::tempdir().unwrap();
	let src = dir.path().join("src");
	make_tree(&src);
	assert_eq!(run(&["-a", "src/", "dst/"], dir.path()).0, 0);
	let target = dir.path().join("dst/a");
	let when = mtime(&target);
	fs::write(&target, b"HELLO\n").unwrap();
	fs::File::options().write(true).open(&target).unwrap().set_modified(when).unwrap();
	// The quick check sees nothing to do.
	let (_, out, _) = run(&["-ai", "src/", "dst/"], dir.path());
	assert_eq!(out, "");
	assert_eq!(fs::read(&target).unwrap(), b"HELLO\n");
	// -c compares contents.
	let (code, out, _) = run(&["-aic", "src/", "dst/"], dir.path());
	assert_eq!(code, 0);
	assert_eq!(out, ">fc........ a\n");
	assert_eq!(fs::read(&target).unwrap(), b"hello\n");
}

#[test]
fn dry_run_changes_nothing() {
	let dir = tempfile::tempdir().unwrap();
	make_tree(&dir.path().join("src"));
	let (code, out, _) = run(&["-ain", "src/", "dst/"], dir.path());
	assert_eq!(code, 0);
	assert!(out.starts_with("created directory dst\ncd+++++++++ ./\n>f+++++++++ a\n"), "{out}");
	assert!(!dir.path().join("dst").exists());
	let (code, out, _) = run(&["-an", "--stats", "src/", "dst/"], dir.path());
	assert_eq!(code, 0);
	assert!(out.contains("Number of regular files transferred: 3"), "{out}");
	assert!(out.trim_end().ends_with("(DRY RUN)"), "{out}");
}

#[test]
fn list_only_matches_reference() {
	let dir = tempfile::tempdir().unwrap();
	make_tree(&dir.path().join("src"));
	let (code, out, _) = run(&["--list-only", "src/"], dir.path());
	assert_eq!(code, 0);
	assert!(out.lines().any(|l| l.starts_with("-rw") && l.ends_with(" a")), "{out}");
	let Some(rsync) = reference() else { return };
	let theirs = Command::new(&rsync).args(["--list-only", "src/"]).current_dir(dir.path()).output().unwrap();
	assert_eq!(out, String::from_utf8_lossy(&theirs.stdout));
	let (_, out, _) = run(&["-r", "src"], dir.path());
	let theirs = Command::new(&rsync).args(["-r", "src"]).current_dir(dir.path()).output().unwrap();
	assert_eq!(out, String::from_utf8_lossy(&theirs.stdout));
}

/// A fake remote shell that runs the remote command locally.
#[cfg(unix)]
fn fake_rsh(dir: &Path) -> PathBuf {
	use std::os::unix::fs::PermissionsExt;
	let path = dir.join("fakersh");
	fs::write(&path, "#!/bin/sh\nshift\nexec \"$@\"\n").unwrap();
	fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
	path
}

#[cfg(unix)]
#[test]
fn remote_shell_push_and_pull_against_reference_server() {
	let Some(rsync) = reference() else { return };
	let dir = tempfile::tempdir().unwrap();
	let src = dir.path().join("src");
	make_tree(&src);
	let rsh = fake_rsh(dir.path());
	let rsh = rsh.to_str().unwrap();
	let rpath = format!("--rsync-path={}", rsync.display());
	let pushed = dir.path().join("pushed");
	let dest = format!("h:{}/", pushed.display());
	let (code, out, err) = run(&["-ai", "-e", rsh, &rpath, "src/", &dest], dir.path());
	assert_eq!((code, err.as_str()), (0, ""), "{out}");
	// A pushing client itemizes sends with `<` (rsync 3.5.1 over a remote shell).
	assert!(out.contains("<f+++++++++ sub/b\n"), "{out}");
	assert_same_tree(&src, &pushed);
	// Pull it back, with deltas against a stale copy.
	let pulled = dir.path().join("pulled");
	fs::create_dir(&pulled).unwrap();
	let mut stale = fs::read(src.join("big")).unwrap();
	stale.truncate(500_000);
	stale.extend_from_slice(b"stale tail");
	fs::write(pulled.join("big"), stale).unwrap();
	let source = format!("h:{}/", pushed.display());
	let (code, out, err) = run(&["-a", "--stats", "-e", rsh, &rpath, &source, "pulled/"], dir.path());
	assert_eq!((code, err.as_str()), (0, ""), "{out}");
	assert!(out.contains("Matched data: "), "{out}");
	assert_same_tree(&src, &pulled);
	// Protocol 29 against the same server.
	let old = dir.path().join("old");
	let dest = format!("h:{}/", old.display());
	let (code, _, err) = run(&["-a", "--protocol=29", "-e", rsh, &rpath, "src/", &dest], dir.path());
	assert_eq!((code, err.as_str()), (0, ""));
	assert_same_tree(&src, &old);
}

/// A descriptor as the test host's stdin stream, so a run sees a real fd 0.
#[cfg(unix)]
struct FdStream(Arc<fs::File>);

#[cfg(unix)]
impl io::Read for FdStream {
	fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
		(&*self.0).read(buf)
	}
}

#[cfg(unix)]
impl io::Write for FdStream {
	fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
		(&*self.0).write(buf)
	}

	fn flush(&mut self) -> io::Result<()> {
		Ok(())
	}
}

#[cfg(unix)]
impl crate::openfile::Stream for FdStream {
	fn raw_fd(&self) -> Option<std::os::fd::RawFd> {
		Some(std::os::fd::AsRawFd::as_raw_fd(&*self.0))
	}
}

/// rsync 3.5.1 pulls from the builtin run as `--server --sender` on real
/// descriptors, FIFOs behind its remote shell, so the server's connection
/// has the stdio probes and writes of `PIPE_BUF` bytes: the server and the
/// client exit 0 and the copy is whole. Not checked: the server's byte
/// totals, which take one frame header more than rsync 3.5.1's server here
/// (three or four more on `main`), as the builtin cuts its output frames.
#[cfg(unix)]
#[test]
fn a_reference_client_pulls_from_a_server_on_real_stdio() {
	use std::os::unix::fs::PermissionsExt;
	let Some(rsync) = reference() else { return };
	if Command::new("python3").args(["-c", ""]).status().is_err() {
		eprintln!("skipping: no python3 for the relay");
		return;
	}
	let dir = tempfile::tempdir().unwrap();
	make_tree(&dir.path().join("src"));
	let (c2s, s2c, recorded) = (dir.path().join("c2s"), dir.path().join("s2c"), dir.path().join("argv"));
	for fifo in [&c2s, &s2c] {
		nix::unistd::mkfifo(fifo, nix::sys::stat::Mode::from_bits_truncate(0o600)).unwrap();
	}
	// The remote shell records the server's command, a word a line, and
	// relays the connection through the FIFOs. rsync's client leaves the
	// shell's stdout non-blocking, which `cat` does not retry, so the relay
	// clears that first; and a background job of a non-interactive `sh`
	// reads `/dev/null`, so the client's end goes to it on fd 3.
	let rsh = dir.path().join("fifo-rsh");
	fs::write(
		&rsh,
		format!(
			"#!/bin/sh\nshift\nprintf '%s\\n' \"$@\" > '{argv}.tmp' && mv '{argv}.tmp' '{argv}'\n\
			 python3 -c 'import fcntl, os\nfor fd in 0, 1: fcntl.fcntl(fd, fcntl.F_SETFL, fcntl.fcntl(fd, fcntl.F_GETFL) & ~os.O_NONBLOCK)'\n\
			 exec 3<&0\ncat <&3 > '{c2s}' &\nexec cat '{s2c}' 3<&-\n",
			argv = recorded.display(),
			c2s = c2s.display(),
			s2c = s2c.display()
		),
	)
	.unwrap();
	fs::set_permissions(&rsh, fs::Permissions::from_mode(0o755)).unwrap();
	let source = format!("h:{}/src/", dir.path().display());
	let client = Command::new(&rsync)
		.args(["-a", "--stats", "-e", rsh.to_str().unwrap(), &source, "got/"])
		.current_dir(dir.path())
		.stdout(std::process::Stdio::piped())
		.stderr(std::process::Stdio::piped())
		.spawn()
		.unwrap();
	let deadline = Instant::now() + Duration::from_secs(20);
	while !recorded.exists() {
		assert!(Instant::now() < deadline, "the remote shell never started");
		thread::sleep(Duration::from_millis(10));
	}
	let argv: Vec<OsString> = fs::read_to_string(&recorded).unwrap().lines().map(OsString::from).collect();
	assert_eq!(argv.get(1..3), Some(&[OsString::from("--server"), OsString::from("--sender")][..]), "{argv:?}");
	let stdin = fs::File::open(&c2s).unwrap();
	let stdout = fs::OpenOptions::new().write(true).open(&s2c).unwrap();
	let (mut host, cap) = crate::host::Host::for_test_with_stdin("rsync", Box::new(FdStream(Arc::new(stdin))), dir.path());
	host.set_test_stdout(stdout.into());
	let code = super::run(&mut host, argv);
	drop(host);
	let pulled = client.wait_with_output().unwrap();
	let client_err = String::from_utf8_lossy(&pulled.stderr);
	assert_eq!(code, 0, "server: {}\nclient: {client_err}", cap.err());
	assert!(pulled.status.success(), "{client_err}");
	assert_same_tree(&dir.path().join("src"), &dir.path().join("got"));
}

/// A tree whose only file is unreadable (`m/file`, mode 000); false when running
/// as root, where the file stays readable.
#[cfg(unix)]
fn unreadable_only_file(dir: &Path) -> bool {
	use std::os::unix::fs::PermissionsExt;
	let file = dir.join("m/file");
	fs::create_dir_all(dir.join("m")).unwrap();
	fs::write(&file, b"payload\n").unwrap();
	fs::set_permissions(&file, fs::Permissions::from_mode(0)).unwrap();
	fs::File::open(&file).is_err()
}

/// Runs `argv` in `cwd` on its own thread; panics when it does not finish.
#[cfg(unix)]
fn run_bounded(argv: Vec<String>, cwd: &Path, what: &str) -> (i32, String, String) {
	let cwd = cwd.to_path_buf();
	let (tx, rx) = std::sync::mpsc::channel();
	std::thread::spawn(move || {
		let argv: Vec<&str> = argv.iter().map(String::as_str).collect();
		let _ = tx.send(run(&argv, &cwd));
	});
	rx.recv_timeout(std::time::Duration::from_secs(60)).unwrap_or_else(|_| panic!("{what} hung"))
}

/// Under inc-recursion the sender's MSG_NO_SEND for the only file reaches the
/// receiving side while its receiver already waits for input; the receiver
/// forwards it to the generator in its next output pass, which completes the
/// segment, so the run ends with code 23 instead of hanging (rsync 3.5.1).
#[cfg(unix)]
#[test]
fn unreadable_only_file_is_a_partial_transfer() {
	let dir = tempfile::tempdir().unwrap();
	if !unreadable_only_file(dir.path()) {
		return;
	}
	let argv = vec!["-r".to_owned(), "m/file".to_owned(), "d1/".to_owned()];
	let (code, out, err) = run_bounded(argv, dir.path(), "local copy of an unreadable file");
	assert_eq!(code, 23, "{out}{err}");
	assert!(err.starts_with("rsync: [sender] send_files failed to open \""), "{err}");
	assert!(err.contains("m/file\": Permission denied (13)\n"), "{err}");
	assert!(
		err.ends_with(
			"rsync error: some files/attrs were not transferred (see previous errors) (code 23) at main.c(1412) [sender=3.5.1]\n"
		),
		"{err}"
	);
	assert!(!dir.path().join("d1/file").exists());

	// The same from a reference `--server --sender`: our receiver forwards its
	// MSG_NO_SEND.
	let Some(rsync) = reference() else { return };
	let rsh = fake_rsh(dir.path());
	let argv = vec![
		"-r".to_owned(),
		"-e".to_owned(),
		rsh.to_str().unwrap().to_owned(),
		format!("--rsync-path={}", rsync.display()),
		format!("h:{}/m/file", dir.path().display()),
		"d2/".to_owned(),
	];
	let (code, out, err) = run_bounded(argv, dir.path(), "pull of an unreadable file");
	assert_eq!(code, 23, "{out}{err}");
	assert!(err.contains("send_files failed to open"), "{err}");
	assert!(
		err.ends_with(
			"rsync error: some files/attrs were not transferred (see previous errors) (code 23) at main.c(1983) [generator=3.5.1]\n"
		),
		"{err}"
	);
}

#[cfg(unix)]
#[test]
fn remote_error_exit_code_is_the_servers() {
	let Some(rsync) = reference() else { return };
	let dir = tempfile::tempdir().unwrap();
	let rsh = fake_rsh(dir.path());
	let rpath = format!("--rsync-path={}", rsync.display());
	let source = format!("h:{}/nonexistent/", dir.path().display());
	let (code, _, err) = run(&["-r", "-e", rsh.to_str().unwrap(), &rpath, &source, "out/"], dir.path());
	assert_eq!(code, 23, "{err}");
	assert!(err.contains("change_dir"), "{err}");
	// Captured from rsync 3.5.1: after the trailer the client's MSG_ERROR_EXIT
	// meets the departed server (exit_cleanup's tail).
	assert!(
		err.ends_with(
			"(code 23) at main.c(1983) [Receiver=3.5.1]\nrsync: [Receiver] write error: Broken pipe (32)\n"
		),
		"{err}"
	);
}

#[test]
fn batch_write_then_read_round_trip() {
	let dir = tempfile::tempdir().unwrap();
	let src = dir.path().join("src");
	make_tree(&src);
	let (code, _, err) = run(&["-a", "--exclude=*.o", "--write-batch=b", "src/", "d1/"], dir.path());
	assert_eq!((code, err.as_str()), (0, ""));
	assert_same_tree(&src, &dir.path().join("d1"));
	let script = fs::read_to_string(dir.path().join("b.sh")).unwrap();
	assert_eq!(script, "'rsync' --filter='._-' '-a' --read-batch='b' ${1:-'d1/'} <<'#E#'\n- *.o\n#E#\n");
	#[cfg(unix)]
	{
		use std::os::unix::fs::PermissionsExt;
		let mode = fs::metadata(dir.path().join("b.sh")).unwrap().permissions().mode() & 0o777;
		assert_eq!(mode, 0o700);
	}
	let (code, out, err) = run(&["-a", "-i", "--read-batch=b", "d2/"], dir.path());
	assert_eq!((code, err.as_str()), (0, ""), "{out}");
	assert_same_tree(&src, &dir.path().join("d2"));
	// --only-write-batch leaves the destination alone.
	let (code, out, _) = run(&["-a", "--only-write-batch=c", "-v", "src/", "d3/"], dir.path());
	assert_eq!(code, 0);
	assert!(!dir.path().join("d3").exists());
	assert!(out.trim_end().ends_with("(BATCH ONLY)"), "{out}");
	let (code, _, _) = run(&["-a", "--read-batch=c", "d3/"], dir.path());
	assert_eq!(code, 0);
	assert_same_tree(&src, &dir.path().join("d3"));
}

#[test]
fn batch_read_by_reference_rsync() {
	let Some(rsync) = reference() else { return };
	// The batch file carries our protocol (33); an older reference refuses it.
	let version = Command::new(&rsync).arg("--version").output().unwrap();
	if !String::from_utf8_lossy(&version.stdout).contains("protocol version 33") {
		return;
	}
	let dir = tempfile::tempdir().unwrap();
	let src = dir.path().join("src");
	make_tree(&src);
	let (code, _, _) = run(&["-a", "--only-write-batch=b", "src/", "d1/"], dir.path());
	assert_eq!(code, 0);
	let status = Command::new(&rsync).args(["-a", "--read-batch=b", "d1/"]).current_dir(dir.path()).status().unwrap();
	assert!(status.success());
	assert_same_tree(&src, &dir.path().join("d1"));
	// And the other way round.
	let status = Command::new(&rsync).args(["-a", "--only-write-batch=r", "src/", "d2/"]).current_dir(dir.path()).status().unwrap();
	assert!(status.success());
	let (code, _, err) = run(&["-a", "--read-batch=r", "d2/"], dir.path());
	assert_eq!((code, err.as_str()), (0, ""));
	assert_same_tree(&src, &dir.path().join("d2"));
}

#[test]
fn missing_source_is_a_partial_transfer() {
	let dir = tempfile::tempdir().unwrap();
	let (code, _, err) = run(&["-a", "nope", "dst/"], dir.path());
	assert_eq!(code, 23, "{err}");
	assert!(err.contains("link_stat"), "{err}");
	assert!(err.ends_with("(code 23) at main.c(1412) [sender=3.5.1]\n"), "{err}");
}

#[test]
fn fold_exit_precedence() {
	assert_eq!(fold_exit(0, IOERR_DEL_LIMIT | IOERR_VANISHED, false), RERR_VANISHED);
	assert_eq!(fold_exit(0, IOERR_VANISHED, true), crate::rsync::exit::RERR_PARTIAL);
	assert_eq!(fold_exit(0, IOERR_DEL_LIMIT, false), crate::rsync::exit::RERR_DEL_LIMIT);
	assert_eq!(fold_exit(12, IOERR_GENERAL, true), 12);
	assert_eq!(fold_exit(0, 0, false), 0);
}

#[test]
fn delete_excluded_position_counts_rules_before_it() {
	let argv: Vec<OsString> =
		["rsync", "-f- a", "--exclude", "b", "--delete-excluded", "--include=c", "x", "y"].iter().map(OsString::from).collect();
	assert_eq!(delete_excluded_position(&argv, 3), 2);
	let argv: Vec<OsString> = ["rsync", "--delete-excluded", "-f- a"].iter().map(OsString::from).collect();
	assert_eq!(delete_excluded_position(&argv, 1), 0);
	let argv: Vec<OsString> = ["rsync", "-e", "--delete-excluded", "-f- a"].iter().map(OsString::from).collect();
	assert_eq!(delete_excluded_position(&argv, 1), 1);
}

#[test]
fn d_option_hint_for_old_servers() {
	let buf = std::sync::Arc::new(Mutex::new(Vec::new()));
	struct Out(Arc<Mutex<Vec<u8>>>);
	impl Write for Out {
		fn write(&mut self, b: &[u8]) -> io::Result<usize> {
			lock(&self.0).extend_from_slice(b);
			Ok(b.len())
		}
		fn flush(&mut self) -> io::Result<()> {
			Ok(())
		}
	}
	let logger = Logger::local(Box::new(io::sink()), Box::new(Out(Arc::clone(&buf))), LogConfig::default());
	check_for_d_option_error(&logger, b"rsync: on remote machine: -vde.LsfxC: unknown option");
	check_for_d_option_error(&logger, b"rsync: on remote machine: --dirs: unknown option");
	assert_eq!(&*lock(&buf), b"*** Try using \"--old-d\" if remote rsync is <= 2.6.3 ***\n");
}

#[test]
fn files_from_forwarding_collapses_lines() {
	let counters = IoCounters::default();
	struct Out(Arc<Mutex<Vec<u8>>>);
	impl Write for Out {
		fn write(&mut self, b: &[u8]) -> io::Result<usize> {
			lock(&self.0).extend_from_slice(b);
			Ok(b.len())
		}
		fn flush(&mut self) -> io::Result<()> {
			Ok(())
		}
	}
	let buf = Arc::new(Mutex::new(Vec::new()));
	let w = MuxWriter::new(Box::new(Out(Arc::clone(&buf))), counters, WriteConfig::default());
	// With -R the whole forwarded path is what was asked for.
	let implied = Mutex::new(ImpliedFilters::new(true, false, false));
	let src: Box<dyn Read + Send> = Box::new(&b"\n\na\r\n\nb/c\nlast"[..]);
	forward_files_from(src, &w, 31, false, Some(&implied), &AtomicBool::new(false)).unwrap();
	assert_eq!(&*lock(&buf), b"a\0b/c\0last\0\0");
	assert_eq!(lock(&implied).check(b"b/c", false), crate::rsync::filter::Verdict::Include);
}

/// `--insecure-links` restores the legacy chmod: a destination directory that
/// is a symlink (`-K`) gets the source directory's mode on what it points to,
/// and the run succeeds, as with rsync 3.5.1 (exit 0, mode set).
#[cfg(unix)]
#[test]
fn insecure_links_sets_a_mode_through_a_destination_symlink() {
	use std::os::unix::fs::{PermissionsExt, symlink};
	let dir = tempfile::tempdir().unwrap();
	make_tree(&dir.path().join("src"));
	fs::set_permissions(dir.path().join("src/sub"), fs::Permissions::from_mode(0o755)).unwrap();
	fs::create_dir_all(dir.path().join("dst/realsub")).unwrap();
	fs::set_permissions(dir.path().join("dst/realsub"), fs::Permissions::from_mode(0o700)).unwrap();
	symlink("realsub", dir.path().join("dst/sub")).unwrap();
	let (code, _, err) = run(&["-aK", "--insecure-links", "src/", "dst/"], dir.path());
	assert_eq!((code, err.as_str()), (0, ""));
	let mode = fs::metadata(dir.path().join("dst/realsub")).unwrap().permissions().mode() & 0o7777;
	assert_eq!(mode, 0o755);
	assert!(fs::symlink_metadata(dir.path().join("dst/sub")).unwrap().file_type().is_symlink());
}

/// A `--log-file` that cannot be opened is reported as rsync 3.5.1 reports
/// it, and the copy goes on. Measured with rsync 3.5.1 under `LC_ALL=C`: a
/// missing directory, a directory, and (not as root) a directory it may not
/// write give the client `rsync: [client] failed to open log-file …` on
/// stderr and `Ignoring "log file" setting.` on stdout, and a local copy's
/// server half (`-M--log-file=`) both lines on stderr as `[Receiver]`; an
/// empty name means syslog and prints nothing on either side. Before, the
/// client named itself `[sender]`, and an empty name opened the current
/// directory and failed with `Is a directory (21)`.
#[cfg(unix)]
#[test]
fn a_log_file_that_cannot_be_opened_is_reported_as_rsync_does() {
	use std::os::unix::fs::PermissionsExt;
	let dir = tempfile::tempdir().unwrap();
	make_tree(&dir.path().join("src"));
	fs::create_dir_all(dir.path().join("adir")).unwrap();
	fs::create_dir_all(dir.path().join("ro")).unwrap();
	fs::set_permissions(dir.path().join("ro"), fs::Permissions::from_mode(0o555)).unwrap();
	let d = dir.path().display().to_string();
	let mut cases = vec![
		("missing", format!("{d}/nope/x.log"), Some(format!("{d}/nope/x.log: No such file or directory (2)"))),
		("dir", format!("{d}/adir"), Some(format!("{d}/adir: Is a directory (21)"))),
		("empty", String::new(), None),
	];
	if !nix::unistd::geteuid().is_root() {
		cases.push(("unwritable", format!("{d}/ro/x.log"), Some(format!("{d}/ro/x.log: Permission denied (13)"))));
	}
	for (case, path, failure) in cases {
		for server in [false, true] {
			let _ = fs::remove_dir_all(dir.path().join("dst"));
			let arg = if server { format!("-M--log-file={path}") } else { format!("--log-file={path}") };
			let (code, out, err) = run(&["-a", &arg, "src/", "dst/"], dir.path());
			let (want_out, want_err) = match (&failure, server) {
				(None, _) => (String::new(), String::new()),
				(Some(why), false) => {
					("Ignoring \"log file\" setting.\n".to_string(), format!("rsync: [client] failed to open log-file {why}\n"))
				},
				(Some(why), true) => (
					String::new(),
					format!("rsync: [Receiver] failed to open log-file {why}\nIgnoring \"log file\" setting.\n"),
				),
			};
			assert_eq!((code, out, err), (0, want_out, want_err), "{case} server={server}");
			assert_eq!(fs::read(dir.path().join("dst/sub/b")).unwrap(), b"x\n", "{case} server={server}");
		}
	}
}

/// The builtin run as a remote server (`--server`, as a client's remote
/// shell starts it) names itself `[server]` when its `--log-file` cannot be
/// opened, as rsync 3.5.1's remote server does while it is starting up.
#[cfg(unix)]
#[test]
fn a_remote_server_names_itself_server_when_its_log_cannot_be_opened() {
	let dir = tempfile::tempdir().unwrap();
	let log = dir.path().join("nope/x.log");
	let arg = format!("--log-file={}", log.display());
	let (_, _, err) = run(&["--server", "-logDtpre.iLsfxCIvu", &arg, ".", "dst/"], dir.path());
	let first = err.lines().next().unwrap_or_default();
	assert_eq!(first, format!("rsync: [server] failed to open log-file {}: No such file or directory (2)", log.display()), "{err}");
}
