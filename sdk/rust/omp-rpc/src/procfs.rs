//! Linux /proc evidence for teardown.
//!
//! Teardown confirms a process group gone only on positive evidence that no
//! member of the group, process or thread, is alive. Anything it cannot read
//! or prove counts as alive. The Go, Python and Rust SDKs apply the same rules.

use std::{collections::HashSet, io};

/// What teardown reads: /proc and `kill(pid, 0)`. Tests answer chosen reads
/// and probes themselves.
pub(crate) trait Proc {
	/// Names in the /proc directory `path`.
	fn list(&self, path: &str) -> io::Result<Vec<String>>;
	/// Contents of the /proc file `path`.
	fn read(&self, path: &str) -> io::Result<Vec<u8>>;
	/// `kill(pid, 0)`.
	fn probe(&self, pid: libc::pid_t) -> io::Result<()>;
}

/// The real /proc and `kill`.
pub(crate) struct System;

impl Proc for System {
	fn list(&self, path: &str) -> io::Result<Vec<String>> {
		let mut names = Vec::new();
		for entry in std::fs::read_dir(path)? {
			// An entry that cannot be read fails the whole listing: a listing
			// with a hole proves nothing.
			if let Some(name) = entry?.file_name().to_str() {
				names.push(name.to_owned());
			}
		}
		Ok(names)
	}

	fn read(&self, path: &str) -> io::Result<Vec<u8>> {
		std::fs::read(path)
	}

	fn probe(&self, pid: libc::pid_t) -> io::Result<()> {
		// SAFETY: `kill` has no memory-safety preconditions; signal 0 only
		// probes.
		if unsafe { libc::kill(pid, 0) } == 0 {
			Ok(())
		} else {
			Err(io::Error::last_os_error())
		}
	}
}

/// /proc could not be read, so it proves nothing.
#[derive(Debug)]
pub(crate) struct Unproven;

/// ENOENT or ESRCH: the process or thread exited and was reaped while it was
/// being read.
fn vanished(error: &io::Error) -> bool {
	error.kind() == io::ErrorKind::NotFound || error.raw_os_error() == Some(libc::ESRCH)
}

/// Whether a /proc task state is dead: Z (zombie), X or x.
const fn dead(state: u8) -> bool {
	matches!(state, b'Z' | b'X' | b'x')
}

fn is_pid(name: &str) -> bool {
	!name.is_empty() && name.bytes().all(|byte| byte.is_ascii_digit())
}

/// State and process group of the task at `/proc/<name>` (a pid, or
/// `<pid>/task/<tid>`); `None` when the task is gone.
pub(crate) fn stat(proc: &impl Proc, name: &str) -> Result<Option<(u8, libc::pid_t)>, Unproven> {
	let stat = match proc.read(&format!("/proc/{name}/stat")) {
		Ok(stat) => stat,
		Err(error) if vanished(&error) => return Ok(None),
		Err(_) => return Err(Unproven),
	};
	// `pid (comm) state ppid pgrp ...`: comm can contain spaces and ')', so
	// the fields are read after the final ')'.
	let rparen = stat
		.iter()
		.rposition(|&byte| byte == b')')
		.ok_or(Unproven)?;
	let mut fields = stat[rparen + 1..]
		.split(u8::is_ascii_whitespace)
		.filter(|field| !field.is_empty());
	let &[state] = fields.next().ok_or(Unproven)? else {
		return Err(Unproven);
	};
	let _ppid = fields.next();
	let pgrp = fields
		.next()
		.and_then(|field| std::str::from_utf8(field).ok())
		.filter(|field| is_pid(field))
		.and_then(|field| field.parse().ok())
		.ok_or(Unproven)?;
	Ok(Some((state, pgrp)))
}

/// Whether every thread of process `pid` is dead or gone. A process whose
/// main thread exited reads Z in `/proc/<pid>/stat` while its other threads
/// run; only `/proc/<pid>/task` lists them.
pub(crate) fn threads_dead(proc: &impl Proc, pid: &str) -> Result<bool, Unproven> {
	let tids = match proc.list(&format!("/proc/{pid}/task")) {
		Ok(tids) => tids,
		Err(error) if vanished(&error) => return Ok(true), // the whole process was reaped
		Err(_) => return Err(Unproven),
	};
	for tid in tids {
		if let Some((state, _)) = stat(proc, &format!("{pid}/task/{tid}"))?
			&& !dead(state)
		{
			return Ok(false);
		}
	}
	Ok(true)
}

/// Whether /proc proves that no member of group `pgid`, no process and no
/// thread, is alive.
///
/// Call it only after `kill(-pgid, SIGKILL)`: the kernel lets no member that
/// signal reached start a process or a thread, so the scan cannot miss a
/// member created behind it unless a member the signal did not reach created
/// it. The checks below rule that case out.
///
/// It returns false, proving nothing, when:
/// - /proc is not this pid namespace's procfs, or is mounted with hidepid;
/// - /proc cannot be listed, or a stat or a task list cannot be read or parsed
///   for any reason but ENOENT or ESRCH, which mean the task is gone;
/// - a member, or any thread of one, is in a state other than Z, X or x;
/// - `kill(member, 0)` fails with anything but ESRCH: SIGKILL did not reach
///   that member (EPERM), so it may still start processes or threads;
/// - a second listing of /proc holds a member the first listing did not.
pub(crate) fn group_dead(proc: &impl Proc, pgid: libc::pid_t) -> bool {
	scan(proc, pgid).unwrap_or(false)
}

fn scan(proc: &impl Proc, pgid: libc::pid_t) -> Result<bool, Unproven> {
	if !lists_every_process(proc) {
		return Ok(false);
	}
	let first = proc.list("/proc").map_err(|_| Unproven)?;
	for name in &first {
		if !is_pid(name) {
			continue;
		}
		let Some((state, member_pgid)) = stat(proc, name)? else {
			continue;
		};
		if member_pgid != pgid {
			continue;
		}
		if !dead(state) || !threads_dead(proc, name)? {
			return Ok(false);
		}
		let pid = name.parse().map_err(|_| Unproven)?;
		match proc.probe(pid) {
			Ok(()) => {},
			Err(error) if error.raw_os_error() == Some(libc::ESRCH) => {},
			Err(_) => return Ok(false),
		}
	}
	let listed: HashSet<&str> = first.iter().map(String::as_str).collect();
	for name in proc.list("/proc").map_err(|_| Unproven)? {
		if listed.contains(name.as_str()) || !is_pid(&name) {
			continue;
		}
		if let Some((_, member_pgid)) = stat(proc, &name)?
			&& member_pgid == pgid
		{
			return Ok(false);
		}
	}
	Ok(true)
}

/// Whether /proc shows every process of this pid namespace: its `self` entry
/// is this process, and its mount at /proc carries no `hidepid` option other
/// than 0 or off (hidepid hides other users' and non-dumpable processes).
fn lists_every_process(proc: &impl Proc) -> bool {
	let (Ok(self_stat), Ok(mountinfo)) =
		(proc.read("/proc/self/stat"), proc.read("/proc/self/mountinfo"))
	else {
		return false;
	};
	let pid = self_stat
		.split(|&byte| byte == b' ')
		.next()
		.unwrap_or_default();
	if pid != std::process::id().to_string().as_bytes() {
		return false;
	}
	// `id parent major:minor root mountpoint options [optional...] - fstype
	// source superoptions`. The last mount at /proc is the one on top. Only
	// ASCII fields are matched, so a lossy decode of other bytes is harmless.
	let mountinfo = String::from_utf8_lossy(&mountinfo);
	let mut top = None;
	for line in mountinfo.lines() {
		let Some((before, after)) = line.split_once(" - ") else {
			continue;
		};
		let fields: Vec<&str> = before.split_whitespace().collect();
		if fields.len() >= 6 && fields[4] == "/proc" {
			top = Some((fields[5], after));
		}
	}
	let Some((options, after)) = top else {
		return false;
	};
	let super_fields: Vec<&str> = after.split_whitespace().collect();
	if super_fields.len() < 3 || super_fields[0] != "proc" {
		return false;
	}
	options
		.split(',')
		.chain(super_fields[2].split(','))
		.all(|option| {
			option
				.strip_prefix("hidepid=")
				.is_none_or(|value| value == "0" || value == "off")
		})
}

#[cfg(test)]
mod tests {
	use std::{
		cell::RefCell,
		collections::HashMap,
		io::{BufRead, BufReader, Read},
		os::unix::process::CommandExt,
		process::{Child, Command, Stdio},
		time::{Duration, Instant},
	};

	use super::*;
	use crate::client::{Client, ClientOptions, terminate_with};

	const HELPER_ENV: &str = "OMP_RPC_TEST_HELPER";
	const HELPER_READY: &str = "omp-rpc-helper-ready";

	/// Not a test: the body of a helper process the tests below start. It
	/// ignores SIGTERM, then ends the process's main thread alone (exit(2),
	/// not exit_group(2)) while other threads run on, so /proc/<pid>/stat reads
	/// Z although the process is alive.
	#[test]
	#[ignore = "helper process body; runs only when a test re-executes this binary"]
	fn main_thread_exits_helper() {
		if std::env::var_os(HELPER_ENV).is_none() {
			return;
		}
		extern "C" fn exit_this_thread(_: libc::c_int) {
			// SAFETY: exit(2) ends only the calling thread and is
			// async-signal-safe.
			unsafe { libc::syscall(libc::SYS_exit, 0) };
		}
		let handler: extern "C" fn(libc::c_int) = exit_this_thread;
		// SAFETY: sets this helper process's own signal dispositions.
		unsafe {
			libc::signal(libc::SIGTERM, libc::SIG_IGN);
			libc::signal(libc::SIGUSR1, handler as libc::sighandler_t);
		}
		std::thread::spawn(|| {
			loop {
				std::thread::sleep(Duration::from_secs(3600));
			}
		});
		println!("{HELPER_READY}");
		// SAFETY: tgkill with tid == pid signals the main thread, whose handler
		// then ends it; whichever thread this is, another one lives on.
		unsafe {
			let pid = libc::getpid();
			libc::syscall(libc::SYS_tgkill, pid, pid, libc::SIGUSR1);
		}
		loop {
			std::thread::sleep(Duration::from_secs(3600));
		}
	}

	/// Kills and reaps its child when dropped, so no test leaves a process.
	struct Reap(Child);

	impl Reap {
		fn pid(&self) -> libc::pid_t {
			libc::pid_t::try_from(self.0.id()).unwrap()
		}
	}

	impl Drop for Reap {
		fn drop(&mut self) {
			let _ = self.0.kill();
			let _ = self.0.wait();
		}
	}

	fn wait_for_state(pid: libc::pid_t, want: u8) {
		let deadline = Instant::now() + Duration::from_secs(5);
		loop {
			if let Ok(Some((state, _))) = stat(&System, &pid.to_string())
				&& state == want
			{
				return;
			}
			assert!(Instant::now() < deadline, "process {pid} never reached state {}", want as char);
			std::thread::sleep(Duration::from_millis(10));
		}
	}

	/// Whether /proc proves `pid` dead: its entry is gone, or it and every one
	/// of its threads are in a dead state.
	fn proven_dead(pid: libc::pid_t) -> bool {
		let name = pid.to_string();
		match stat(&System, &name) {
			Ok(None) => true,
			Ok(Some((state, _))) => dead(state) && matches!(threads_dead(&System, &name), Ok(true)),
			Err(Unproven) => false,
		}
	}

	/// A process in group `pgid` (0: a group of its own) whose main thread has
	/// exited while its other threads run, and that ignores SIGTERM.
	fn start_main_thread_exited(pgid: libc::pid_t) -> Reap {
		let mut child = Command::new(std::env::current_exe().unwrap())
			.args(["--exact", "procfs::tests::main_thread_exits_helper", "--ignored", "--nocapture"])
			.args(["--test-threads=1"])
			.env(HELPER_ENV, "1")
			.process_group(pgid)
			.stdin(Stdio::null())
			.stdout(Stdio::piped())
			.stderr(Stdio::null())
			.spawn()
			.unwrap();
		let stdout = child.stdout.take().unwrap();
		let helper = Reap(child);
		let ready = BufReader::new(stdout)
			.lines()
			.any(|line| line.is_ok_and(|line| line.contains(HELPER_READY)));
		assert!(ready, "helper never reported ready");
		wait_for_state(helper.pid(), b'Z');
		assert_eq!(
			threads_dead(&System, &helper.pid().to_string()).ok(),
			Some(false),
			"helper has no live thread left"
		);
		helper
	}

	/// A process in a group of its own that exits at once and is not reaped
	/// until it is dropped: a dead-but-unreaped member.
	fn start_unreaped_dead() -> Reap {
		let mut child = Command::new("sh")
			.args(["-c", "exit 0"])
			.process_group(0)
			.stdin(Stdio::null())
			.stdout(Stdio::piped())
			.spawn()
			.unwrap();
		let mut stdout = child.stdout.take().unwrap();
		let dead = Reap(child);
		stdout.read_to_end(&mut Vec::new()).unwrap();
		wait_for_state(dead.pid(), b'Z');
		dead
	}

	fn start_sleeper(pgid: libc::pid_t) -> Reap {
		Reap(
			Command::new("sleep")
				.arg("30")
				.process_group(pgid)
				.spawn()
				.unwrap(),
		)
	}

	type Answer<'a, T> = Box<dyn Fn() -> io::Result<T> + 'a>;

	/// Answers the reads and probes it names itself and passes the rest to
	/// [`System`].
	#[derive(Default)]
	struct Rigged<'a> {
		dirs:   HashMap<String, Answer<'a, Vec<String>>>,
		files:  HashMap<String, Answer<'a, Vec<u8>>>,
		probes: HashMap<libc::pid_t, Answer<'a, ()>>,
	}

	impl Proc for Rigged<'_> {
		fn list(&self, path: &str) -> io::Result<Vec<String>> {
			self
				.dirs
				.get(path)
				.map_or_else(|| System.list(path), |answer| answer())
		}

		fn read(&self, path: &str) -> io::Result<Vec<u8>> {
			self
				.files
				.get(path)
				.map_or_else(|| System.read(path), |answer| answer())
		}

		fn probe(&self, pid: libc::pid_t) -> io::Result<()> {
			self
				.probes
				.get(&pid)
				.map_or_else(|| System.probe(pid), |answer| answer())
		}
	}

	fn denied<T>() -> io::Result<T> {
		Err(io::Error::from_raw_os_error(libc::EACCES))
	}

	/// Teardown confirms a group dead only on positive evidence that no member,
	/// process or thread, is alive: every row but the first is a group /proc
	/// must not prove dead.
	#[test]
	fn group_dead_needs_positive_evidence() {
		let dead = start_unreaped_dead();
		let live = start_sleeper(0);
		let main_exited = start_main_thread_exited(0);
		let (dead, live, main_exited) = (dead.pid(), live.pid(), main_exited.pid());

		let rows: Vec<(&str, libc::pid_t, Rigged, bool)> = vec![
			("only a dead, unreaped member", dead, Rigged::default(), true),
			(
				"a member whose main thread exited while another thread runs",
				main_exited,
				Rigged::default(),
				false,
			),
			(
				"a live member whose stat is unreadable",
				live,
				Rigged {
					files: HashMap::from([(
						format!("/proc/{live}/stat"),
						Box::new(denied) as Answer<_>,
					)]),
					..Rigged::default()
				},
				false,
			),
			(
				"a live member whose stat is malformed",
				live,
				Rigged {
					files: HashMap::from([(
						format!("/proc/{live}/stat"),
						Box::new(|| Ok(b"garbage".to_vec())) as Answer<_>,
					)]),
					..Rigged::default()
				},
				false,
			),
			(
				"a dead member whose thread list is unreadable",
				dead,
				Rigged {
					dirs: HashMap::from([(format!("/proc/{dead}/task"), Box::new(denied) as Answer<_>)]),
					..Rigged::default()
				},
				false,
			),
			(
				"a dead member whose thread stat is unreadable",
				dead,
				Rigged {
					files: HashMap::from([(
						format!("/proc/{dead}/task/{dead}/stat"),
						Box::new(denied) as Answer<_>,
					)]),
					..Rigged::default()
				},
				false,
			),
			(
				"an unlistable /proc",
				dead,
				Rigged {
					dirs: HashMap::from([(
						"/proc".to_owned(),
						Box::new(|| Err(io::Error::from_raw_os_error(libc::EIO))) as Answer<_>,
					)]),
					..Rigged::default()
				},
				false,
			),
			(
				"a /proc mounted with hidepid",
				dead,
				Rigged {
					files: HashMap::from([(
						"/proc/self/mountinfo".to_owned(),
						Box::new(|| {
							Ok(b"29 34 0:26 / /proc rw,nosuid shared:13 - proc proc rw,hidepid=invisible\n".to_vec())
						}) as Answer<_>,
					)]),
					..Rigged::default()
				},
				false,
			),
			(
				"a /proc of another pid namespace",
				dead,
				Rigged {
					files: HashMap::from([(
						"/proc/self/stat".to_owned(),
						Box::new(|| Ok(b"1 (init) S 0 1 1 0 -1\n".to_vec())) as Answer<_>,
					)]),
					..Rigged::default()
				},
				false,
			),
			(
				"a dead member SIGKILL could not reach",
				dead,
				Rigged {
					probes: HashMap::from([(
						dead,
						Box::new(|| Err(io::Error::from_raw_os_error(libc::EPERM))) as Answer<_>,
					)]),
					..Rigged::default()
				},
				false,
			),
		];
		let wrong: Vec<&str> = rows
			.iter()
			.filter(|(_, pgid, proc, want)| group_dead(proc, *pgid) != *want)
			.map(|(name, ..)| *name)
			.collect();
		assert!(wrong.is_empty(), "group_dead gave the wrong answer for: {wrong:?}");
	}

	/// A member whose main thread exited reads Z in /proc although its other
	/// threads run. It ignores SIGTERM, so only SIGKILL ends it: close must not
	/// report success while one of its threads is alive.
	#[test]
	fn close_kills_a_member_whose_main_thread_exited() {
		let mut leader = Command::new("sh");
		leader
			.arg("-c")
			.arg(r#"printf '{"type":"ready"}\n'; exec sleep 30"#);
		let (client, _events) = Client::spawn(leader, ClientOptions::default()).unwrap();
		let pgid = libc::pid_t::try_from(client.pid().unwrap()).unwrap();
		let member = start_main_thread_exited(pgid);

		let outcome = client.close();
		assert!(
			outcome.is_err() || proven_dead(member.pid()),
			"close returned Ok while member {} still has a live thread",
			member.pid()
		);
		outcome.expect("close");
	}

	/// A /proc scan is not a snapshot: a member can join the group after the
	/// listing, and the member the listing holds can then die. Teardown must
	/// not confirm a group whose new member it never saw while it runs.
	#[test]
	fn terminate_rejects_a_member_that_joined_during_the_scan() {
		let mut leader = start_sleeper(0);
		let pgid = leader.pid();
		let mut member = Command::new("sh")
			.args(["-c", "trap '' TERM; echo ready; exec sleep 30"])
			.process_group(pgid)
			.stdout(Stdio::piped())
			.spawn()
			.unwrap();
		let stdout = member.stdout.take().unwrap();
		let member = Reap(member);
		let mut ready = String::new();
		BufReader::new(stdout).read_line(&mut ready).unwrap();
		assert_eq!(ready, "ready\n");

		let late: RefCell<Option<Reap>> = RefCell::new(None);
		let proc = Rigged {
			dirs: HashMap::from([(
				"/proc".to_owned(),
				Box::new(|| {
					let names = System.list("/proc");
					if late.borrow().is_none() {
						// Behind the listing: a new member joins, then the
						// member the listing holds dies (it is our child, so
						// its pid stays ours until it is reaped).
						*late.borrow_mut() = Some(start_sleeper(pgid));
						// SAFETY: signals our own unreaped child.
						unsafe { libc::kill(member.pid(), libc::SIGKILL) };
						wait_for_state(member.pid(), b'Z');
					}
					names
				}) as Answer<_>,
			)]),
			..Rigged::default()
		};
		let outcome = terminate_with(&mut leader.0, |pgid| group_dead(&proc, pgid));
		let late = late.borrow();
		let late = late.as_ref().expect("teardown never listed /proc");
		assert!(
			outcome.is_err() || proven_dead(late.pid()),
			"teardown confirmed while member {}, which joined during the scan, runs",
			late.pid()
		);
	}
}
