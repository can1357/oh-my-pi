//! pi's extras through a [`Session`]: utilities and process builtins as engine
//! tasks, the command-running extras as tool calls, pi's gates, and the
//! withheld `suspend`, with real processes.

#![cfg(unix)]

use std::{
	io::{self, Read as _, Seek as _},
	os::unix::ffi::OsStrExt as _,
	path::Path,
	sync::Arc,
	time::{Duration, Instant},
};

use async_trait::async_trait;
use bstr::BString;
use parking_lot::Mutex;
use pi_vfs::{FileHandle, FileSystem, FileType, Metadata, OpenOptions, Permissions, ReadDir};
use tokio_util::sync::CancellationToken;

use crate::{
	session::{RunStdio, Session, SessionConfig},
	vfs::VfsFs,
};

/// The process environment without pi's switches, plus `extra`.
fn env_with(extra: &[(&str, &str)]) -> Vec<(BString, BString)> {
	std::env::vars_os()
		.filter(|(name, _)| !name.as_bytes().starts_with(b"PI_"))
		.map(|(k, v)| (BString::from(k.as_bytes()), BString::from(v.as_bytes())))
		.chain(
			extra
				.iter()
				.map(|&(k, v)| (BString::from(k), BString::from(v))),
		)
		.collect()
}

fn session_in(dir: &Path, extra: &[(&str, &str)]) -> Session {
	Session::new(SessionConfig {
		env:             env_with(extra),
		cwd:             BString::from(dir.as_os_str().as_bytes()),
		fs:              Box::new(crate::sys::StdFs::default()),
		vfs:             None,
		runtime:         tokio::runtime::Handle::current(),
		output_decoding: None,
	})
	.unwrap()
}

fn session() -> Session {
	session_in(&std::env::current_dir().unwrap(), &[])
}

struct Ran {
	status:    i32,
	cancelled: bool,
	stdout:    String,
	stderr:    String,
	elapsed:   Duration,
}

fn read_back(mut file: std::fs::File) -> String {
	file.rewind().unwrap();
	let mut text = String::new();
	file.read_to_string(&mut text).unwrap();
	text
}

async fn run_with(s: &mut Session, command: &str, cancel: CancellationToken) -> Ran {
	let (out, err) = (tempfile::tempfile().unwrap(), tempfile::tempfile().unwrap());
	let stdio = RunStdio {
		stdin:  Some(std::fs::File::open("/dev/null").unwrap()),
		stdout: Some(out.try_clone().unwrap()),
		stderr: Some(err.try_clone().unwrap()),
	};
	let started = Instant::now();
	let outcome = s.run(command, stdio, cancel).await.unwrap();
	Ran {
		status:    outcome.status,
		cancelled: outcome.cancelled,
		stdout:    read_back(out),
		stderr:    read_back(err),
		elapsed:   started.elapsed(),
	}
}

async fn run(s: &mut Session, command: &str) -> Ran {
	run_with(s, command, CancellationToken::new()).await
}

/// stdout of `command`, which must succeed.
async fn out(s: &mut Session, command: &str) -> String {
	let ran = run(s, command).await;
	assert_eq!(ran.status, 0, "{command}: stderr {:?}", ran.stderr);
	ran.stdout
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn sort_is_pis_extra() {
	let mut s = session();
	assert_eq!(out(&mut s, "printf 'b\\na\\n' | sort").await, "a\nb\n");
	assert_eq!(out(&mut s, "type sort").await, "sort is a shell builtin\n");
	assert_eq!(out(&mut s, "command -v sort").await, "sort\n");
	// No PATH needed: the extra is not a program.
	assert_eq!(out(&mut s, "(PATH=/nonexistent; printf 'b\\na\\n' | sort)").await, "a\nb\n");
	// Process builtins are extras too.
	assert_eq!(out(&mut s, "type -t sleep ps").await, "builtin\nbuiltin\n");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn extras_compose_with_builtins_and_each_other() {
	let mut s = session();
	assert_eq!(out(&mut s, "echo x | cat | head -n1").await, "x\n");
	assert_eq!(out(&mut s, "printf '1\\n2\\n3\\n' | cat | head -n1").await, "1\n");
	assert_eq!(
		out(&mut s, "printf 'b\\na\\n' | sort | while read -r l; do echo \"<$l>\"; done").await,
		"<a>\n<b>\n"
	);
	assert_eq!(out(&mut s, "x=$(printf 'b\\na\\n' | sort); echo \"[$x]\"").await, "[a\nb]\n");
	assert_eq!(out(&mut s, "printf 'b\\na\\n' | sort | tr a-z A-Z").await, "A\nB\n");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_extra_reads_no_input_it_does_not_use() {
	let mut s = session();
	// `basename` never reads fd 0: the loop keeps every line.
	assert_eq!(
		out(&mut s, "printf 'a\\nb\\nc\\n' | while read -r l; do basename \"/x/$l\"; done").await,
		"a\nb\nc\n"
	);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn failures_keep_their_status() {
	let mut s = session();
	let ran = run(&mut s, "sort < /definitely/missing").await;
	assert_eq!(ran.status, 1, "stderr: {:?}", ran.stderr);
	assert!(ran.stderr.contains("/definitely/missing"), "stderr: {:?}", ran.stderr);
	let ran = run(&mut s, "sort /definitely/missing").await;
	assert_ne!(ran.status, 0);
	assert!(ran.stderr.starts_with("sort: "), "stderr: {:?}", ran.stderr);
	assert!(ran.stderr.contains("No such file or directory"), "stderr: {:?}", ran.stderr);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn background_extras_are_jobs() {
	let dir = tempfile::tempdir().unwrap();
	let mut s = session_in(dir.path(), &[]);
	let ran = run(
		&mut s,
		"printf 'b\\na\\n' > in.txt; sort < in.txt > out.txt & wait $!; echo \"status $?\"; cat \
		 out.txt",
	)
	.await;
	assert_eq!(
		(ran.status, ran.stdout.as_str()),
		(0, "status 0\na\nb\n"),
		"stderr: {:?}",
		ran.stderr
	);
	assert_eq!(out(&mut s, "sleep 0.1 & sleep 0.1 & wait; echo done").await, "done\n");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancel_ends_an_extra_promptly() {
	let mut s = session();
	let cancel = CancellationToken::new();
	let trigger = cancel.clone();
	tokio::spawn(async move {
		tokio::time::sleep(Duration::from_millis(200)).await;
		trigger.cancel();
	});
	let ran = run_with(&mut s, "sleep 30", cancel).await;
	assert!(ran.cancelled);
	assert!(ran.elapsed < Duration::from_secs(5), "took {:?}", ran.elapsed);
	// The session stays usable.
	assert_eq!(out(&mut s, "echo alive").await, "alive\n");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn pis_switches_hand_utilities_to_path() {
	let dir = std::env::current_dir().unwrap();
	let mut off = session_in(&dir, &[("PI_DISABLE_UUTILS_BUILTINS", "1")]);
	assert_eq!(out(&mut off, "type -t sort").await, "file\n");
	assert_eq!(out(&mut off, "printf 'b\\na\\n' | sort").await, "a\nb\n");
	assert_eq!(out(&mut off, "type -t sleep").await, "builtin\n", "process builtins stay");
	let mut rm_off = session_in(&dir, &[("PI_DISABLE_RM_BUILTIN", "1")]);
	assert_eq!(out(&mut rm_off, "type -t rm mv").await, "file\nbuiltin\n");
	let mut destructive = session_in(&dir, &[("PI_DISABLE_UUTILS_DESTRUCTIVE", "true")]);
	assert_eq!(out(&mut destructive, "type -t cp cat").await, "file\nbuiltin\n");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn env_runs_its_command_through_the_shell() {
	let mut s = session();
	assert_eq!(out(&mut s, "type -t env xargs find").await, "builtin\nbuiltin\nbuiltin\n");
	assert_eq!(out(&mut s, "env FOO=1 sh -c 'echo $FOO'").await, "1\n");
	assert_eq!(out(&mut s, "HOME=/h; env -u HOME sh -c 'echo ${HOME-unset}'").await, "unset\n");
	assert_eq!(out(&mut s, "env -i FOO=2 sh -c 'echo \"$FOO-${HOME-none}\"'").await, "2-none\n");
	assert_eq!(out(&mut s, "env -i FOO=2 printenv FOO").await, "2\n");
	// The change stays in the command's subshell.
	assert_eq!(out(&mut s, "export BAR=x; env BAR=y true; echo $BAR").await, "x\n");
	// Its stdin is the caller's.
	assert_eq!(out(&mut s, "echo piped | env cat").await, "piped\n");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn env_clear_and_unset_remove_inherited_non_shell_entries() {
	// What a program spawned with an empty environment sees anyway: a test
	// runner may add variables to every process this one spawns (cango's
	// tracer adds `CANGO_TRACE`).
	let injected = std::process::Command::new("/usr/bin/env")
		.env_clear()
		.output()
		.unwrap()
		.stdout;
	let injected: Vec<&[u8]> = injected
		.split(|&b| b == b'\n')
		.filter_map(|line| line.split(|&b| b == b'=').next())
		.filter(|name| !name.is_empty())
		.collect();
	let own = |out: String| -> String {
		let mut kept = String::new();
		for line in out.lines() {
			if !injected.contains(&line.split('=').next().unwrap_or_default().as_bytes()) {
				kept.push_str(line);
				kept.push('\n');
			}
		}
		kept
	};
	let mut s = session_in(&std::env::current_dir().unwrap(), &[
		("PI_PROBE-DASH", "1"),
		("PI_PROBE_PLAIN", "1"),
	]);
	let plain = out(&mut s, "/usr/bin/env").await;
	assert!(plain.lines().any(|line| line == "PI_PROBE-DASH=1"));
	assert!(plain.lines().any(|line| line == "PI_PROBE_PLAIN=1"));
	assert_eq!(own(out(&mut s, "env -i /usr/bin/env").await), "");
	assert_eq!(own(out(&mut s, "env -i A=1 /usr/bin/env").await), "A=1\n");
	assert_eq!(own(out(&mut s, "env -i 'PI_PROBE-DASH=2' /usr/bin/env").await), "PI_PROBE-DASH=2\n");
	// A command-prefix assignment shadows the exported global: clearing or
	// removing the binding must not uncover the global's value.
	assert_eq!(own(out(&mut s, "PI_PROBE_PLAIN=temp env -i /usr/bin/env").await), "");
	let shadowed = out(&mut s, "PI_PROBE_PLAIN=temp env -u PI_PROBE_PLAIN /usr/bin/env").await;
	assert!(
		!shadowed
			.lines()
			.any(|line| line.starts_with("PI_PROBE_PLAIN="))
	);
	assert_eq!(
		own(out(&mut s, "f() { local -x PI_PROBE_PLAIN=local; env -i /usr/bin/env; }; f").await),
		""
	);
	let unset = out(&mut s, "env -u 'PI_PROBE-DASH' /usr/bin/env").await;
	assert!(!unset.lines().any(|line| line.starts_with("PI_PROBE-DASH=")));
	assert!(unset.lines().any(|line| line == "PI_PROBE_PLAIN=1"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn xargs_runs_builtins_and_programs() {
	let mut s = session();
	assert_eq!(out(&mut s, "printf '1\\n2\\n' | xargs -n1 echo").await, "1\n2\n");
	assert_eq!(out(&mut s, "echo hi | xargs sh -c 'echo \"[$1]\"' sh").await, "[hi]\n");
	assert_eq!(out(&mut s, "echo hi | xargs /bin/echo").await, "hi\n");
	assert_eq!(out(&mut s, "printf 'b\\na\\n' | xargs -n1 echo | sort").await, "a\nb\n");
}

/// `tail -f` writing into an engine pipe (no native handle) notices while
/// idle that the extra reading it exited, as it does on a native pipe.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn tail_follow_stops_once_the_extra_reading_it_exits() {
	let dir = tempfile::tempdir().unwrap();
	std::fs::write(dir.path().join("log"), "first\nsecond\n").unwrap();
	let mut s = session_in(dir.path(), &[]);
	let ran = tokio::time::timeout(Duration::from_secs(20), run(&mut s, "tail -f log | head -n1"))
		.await
		.expect("tail -f kept following after head exited");
	assert_eq!(ran.stdout, "first\n", "stderr: {:?}", ran.stderr);
}

/// Files an extra creates get the shell's `umask`, whether it runs as a task
/// (`touch`, `mkdir`) or a tool call (`find -fprint`), looser or stricter
/// than the process's.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn extras_create_files_under_the_shell_umask() {
	use std::os::unix::fs::PermissionsExt as _;

	let dir = tempfile::tempdir().unwrap();
	let mut s = session_in(dir.path(), &[]);
	let mode = |name: &str| {
		std::fs::metadata(dir.path().join(name))
			.unwrap()
			.permissions()
			.mode()
			& 0o777
	};
	out(&mut s, "umask 077; touch strict; mkdir strict-dir; find . -maxdepth 0 -fprint strict-find")
		.await;
	assert_eq!(mode("strict"), 0o600);
	assert_eq!(mode("strict-dir"), 0o700);
	assert_eq!(mode("strict-find"), 0o600);
	out(&mut s, "umask 000; touch loose; mkdir loose-dir; find . -maxdepth 0 -fprint loose-find")
		.await;
	assert_eq!(mode("loose"), 0o666);
	assert_eq!(mode("loose-dir"), 0o777);
	assert_eq!(mode("loose-find"), 0o666);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn xargs_does_not_run_functions_and_reports_missing_commands() {
	let mut s = session();
	// pi's runner never ran shell functions: `f` is looked up as a program.
	let ran = run(&mut s, "f(){ echo fn; }; echo a | xargs f; echo \"status $?\"").await;
	assert_eq!(ran.stdout, "status 127\n", "stderr: {:?}", ran.stderr);
	assert!(ran.stderr.contains("xargs: f"), "stderr: {:?}", ran.stderr);
	let ran = run(&mut s, "echo a | xargs no-such-command-here; echo \"status $?\"").await;
	assert_eq!(ran.stdout, "status 127\n", "stderr: {:?}", ran.stderr);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn find_exec_runs_commands() {
	let dir = tempfile::tempdir().unwrap();
	std::fs::write(dir.path().join("x"), "hello\n").unwrap();
	let mut s = session_in(dir.path(), &[]);
	assert_eq!(out(&mut s, "find . -name x -exec echo {} \\;").await, "./x\n");
	assert_eq!(out(&mut s, "find . -name x -exec cat {} +").await, "hello\n");
}

/// awk's command strings are command lines of the shell itself, so pi's
/// builtins run in them; a missing command is the shell's 127.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn awk_runs_command_lines_in_the_shell() {
	let mut s = session();
	assert_eq!(
		out(&mut s, "awk 'BEGIN { system(\"type sort\") }'").await,
		"sort is a shell builtin\n"
	);
	assert_eq!(
		out(&mut s, "printf 'b\\na\\n' | awk '{ print | \"sort\" } END { close(\"sort\") }'").await,
		"a\nb\n"
	);
	assert_eq!(
		out(&mut s, "awk 'BEGIN { while ((\"echo hi\" | getline line) > 0) print \"got \" line }'")
			.await,
		"got hi\n"
	);
	let ran = run(&mut s, "awk 'BEGIN { print system(\"no-such-command-here\") }'").await;
	assert_eq!(ran.stdout, "127\n", "stderr: {:?}", ran.stderr);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn ifne_runs_its_command_on_input() {
	let mut s = session();
	assert_eq!(out(&mut s, "printf 'x\\n' | ifne cat").await, "x\n");
	assert_eq!(out(&mut s, "printf '' | ifne echo nonempty; echo \"s $?\"").await, "s 0\n");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn suspend_is_withheld_and_exec_spares_pi() {
	let mut s = session();
	let ran = run(&mut s, "suspend -f; echo \"status $?\"").await;
	assert_eq!(ran.stdout, "status 1\n");
	assert_eq!(ran.stderr, "suspend: not available in this shell\n");
	assert_eq!(out(&mut s, "(exec /bin/echo hi); echo after").await, "hi\nafter\n");
	// `exec` of a program ends the run, not pi; the session goes on.
	assert_eq!(out(&mut s, "exec /bin/echo bye; echo unreachable").await, "bye\n");
	assert_eq!(out(&mut s, "echo alive").await, "alive\n");
}

// ---------------------------------------------------------------------------
// A provider filesystem.

const NOTES: &[u8] = b"pear\napple\n";

/// One read-only provider file, `mem://notes`; every other path is the host's.
#[derive(Debug)]
struct Notes;

#[async_trait]
impl FileSystem for Notes {
	fn is_native_local(&self, path: &Path) -> bool {
		!pi_vfs::is_virtual_path(path)
	}

	async fn open(&self, path: &Path, _options: &OpenOptions) -> io::Result<pi_vfs::File> {
		if path != Path::new("mem://notes") {
			return Err(io::ErrorKind::NotFound.into());
		}
		Ok(pi_vfs::File::from_handle(NotesHandle { pos: Mutex::new(0) }))
	}

	async fn metadata(&self, path: &Path) -> io::Result<Metadata> {
		if path != Path::new("mem://notes") {
			return Err(io::ErrorKind::NotFound.into());
		}
		Ok(notes_meta())
	}

	async fn read_dir(&self, _path: &Path) -> io::Result<ReadDir> {
		Err(io::ErrorKind::NotFound.into())
	}
}

fn notes_meta() -> Metadata {
	Metadata::new(
		FileType::from_kind(pi_vfs::FileKind::File),
		NOTES.len() as u64,
		Permissions::from_mode(0o644),
	)
}

#[derive(Debug)]
struct NotesHandle {
	pos: Mutex<usize>,
}

#[async_trait]
impl FileHandle for NotesHandle {
	async fn read(&self, buf: &mut [u8]) -> io::Result<usize> {
		let mut pos = self.pos.lock();
		let n = (NOTES.len() - *pos).min(buf.len());
		buf[..n].copy_from_slice(&NOTES[*pos..*pos + n]);
		*pos += n;
		Ok(n)
	}

	async fn write(&self, _buf: &[u8]) -> io::Result<usize> {
		Err(io::ErrorKind::PermissionDenied.into())
	}

	async fn seek(&self, pos: io::SeekFrom) -> io::Result<u64> {
		let mut at = self.pos.lock();
		*at = match pos {
			io::SeekFrom::Start(to) => usize::try_from(to).unwrap_or(usize::MAX).min(NOTES.len()),
			_ => return Err(io::ErrorKind::Unsupported.into()),
		};
		Ok(*at as u64)
	}

	async fn metadata(&self) -> io::Result<Metadata> {
		Ok(notes_meta())
	}
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn utilities_read_provider_files() {
	let vfs = VfsFs::new(pi_vfs::Fs::new(Arc::new(Notes)), tokio::runtime::Handle::current());
	let cwd = std::env::current_dir().unwrap();
	let mut s = Session::new(SessionConfig {
		env:             env_with(&[]),
		cwd:             BString::from(cwd.as_os_str().as_bytes()),
		fs:              Box::new(vfs.clone()),
		vfs:             Some(vfs),
		runtime:         tokio::runtime::Handle::current(),
		output_decoding: None,
	})
	.unwrap();
	assert_eq!(out(&mut s, "sort mem://notes").await, "apple\npear\n");
	assert_eq!(out(&mut s, "head -n1 mem://notes").await, "pear\n");
	assert_eq!(out(&mut s, "cat mem://notes | sort | head -n1").await, "apple\n");
	assert_eq!(out(&mut s, "x=$(sort mem://notes); echo \"[$x]\"").await, "[apple\npear]\n");
}
