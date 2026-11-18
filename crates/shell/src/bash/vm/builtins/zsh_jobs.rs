//! zsh's job builtins: `jobs`, `fg`, `bg` and `disown` (zsh 5.9 `jobs.c`
//! `bin_fg`), `suspend` (`bin_suspend`) and the job specs of `getjob` and
//! `findjobnam` they share with `kill` and `AUTO_RESUME`. Job lines are
//! zsh's `printjob` ([`jobctl::format_job`]); the current and previous
//! jobs follow zsh's `curjob`/`prevjob` rules (`setcurjob`, `setprevjob`).
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use bstr::{BString, ByteSlice};

use super::{
	Control, Ctx, Need, Outcome, R, Wait, done,
	zsh_args::{Ops, zx},
};
use crate::bash::{
	ControlHandle, Platform,
	signal::{SigTarget, Signal},
	store::JobState,
	vm::{
		jobctl::{self, JobLine},
		proc::{LastBg, Vproc},
		zsh::{nameddir, specials::Special},
	},
	zshopt::ZshOpt,
};

/// Which of `bin_fg`'s builtins runs (`BIN_FG`, `BIN_BG`, `BIN_JOBS`,
/// `BIN_DISOWN`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JobFunc {
	/// `fg`.
	Fg,
	/// `bg`.
	Bg,
	/// `jobs`.
	Jobs,
	/// `disown`.
	Disown,
}

/// zsh `findjobnam`: the newest job whose text starts with `s`.
pub fn findjobnam(vp: &Vproc, s: &[u8]) -> Option<u32> {
	vp.jobs
		.iter()
		.rev()
		.find(|j| !j.text.is_empty() && j.text.starts_with(s))
		.map(|j| j.number)
}

/// zsh `curjob` when it names a job of the table.
fn curjob(vp: &Vproc) -> Option<u32> {
	vp.jobs.current.filter(|&n| vp.jobs.get(n).is_some())
}

/// zsh `prevjob` when it names a job of the table.
fn prevjob(vp: &Vproc) -> Option<u32> {
	vp.jobs.previous.filter(|&n| vp.jobs.get(n).is_some())
}

/// zsh `getjob`: the job `word` names (`%%`, `%+`, `%`, `%-`, `%N`,
/// `%?text`, `%name`, `name`), or `None` after zsh's warning under the
/// builtin's name (silent under `POSIX_BUILTINS` but for a name). Called
/// by the job builtins and `kill`.
pub fn getjob(ctx: &mut Ctx<'_, '_>, word: &[u8], posix: bool) -> Option<u32> {
	let Some(s) = word.strip_prefix(b"%") else {
		return by_name(ctx, word, posix);
	};
	match s.first() {
		None | Some(b'%' | b'+') => {
			let found = curjob(ctx.vp);
			if found.is_none() && !posix {
				ctx.usage("no current job");
			}
			found
		},
		Some(b'-') => {
			let found = prevjob(ctx.vp);
			if found.is_none() && !posix {
				ctx.usage("no previous job");
			}
			found
		},
		Some(c) if c.is_ascii_digit() => {
			// `atoi`: the leading digits.
			let digits = s.iter().take_while(|c| c.is_ascii_digit()).count();
			let found = s[..digits]
				.to_str()
				.ok()
				.and_then(|d| d.parse::<u32>().ok())
				.filter(|&n| n > 0 && ctx.vp.jobs.get(n).is_some());
			if found.is_none() && !posix {
				ctx.usage(format!("%{}: no such job", s.as_bstr()));
			}
			found
		},
		Some(b'?') => {
			let needle = &s[1..];
			let found = ctx
				.vp
				.jobs
				.iter()
				.rev()
				.find(|j| j.text.find(needle).is_some())
				.map(|j| j.number);
			if found.is_none() && !posix {
				ctx.usage(format!("job not found: {}", s.as_bstr()));
			}
			found
		},
		Some(_) => by_name(ctx, s, posix),
	}
}

/// `getjob`'s `jump:` case: a job named by the start of its text.
fn by_name(ctx: &mut Ctx<'_, '_>, name: &[u8], posix: bool) -> Option<u32> {
	let found = findjobnam(ctx.vp, name);
	if found.is_none() && !posix {
		ctx.usage(format!("job not found: {}", name.as_bstr()));
	}
	found
}

/// zsh `setcurjob`: the current job falls back to the previous one when
/// it is gone.
fn setcurjob(vp: &mut Vproc) {
	for _ in 0..2 {
		if vp.jobs.current.is_some() && curjob(vp).is_none() {
			vp.jobs.current = prevjob(vp);
			vp.jobs.previous = jobctl::zsh_prevjob(vp);
		}
	}
	if vp.jobs.previous.is_some() && prevjob(vp).is_none() {
		vp.jobs.previous = jobctl::zsh_prevjob(vp);
	}
}

/// zsh `deletejob` with `printjob`'s fix-up of the current and previous
/// jobs (`curjob = prevjob; prevjob = job`, then `setprevjob`).
fn delete(vp: &mut Vproc, number: u32) {
	vp.jobs.list.retain(|j| j.number != number);
	if vp.jobs.current == Some(number) {
		vp.jobs.current = vp.jobs.previous;
		vp.jobs.previous = Some(number);
	}
	if vp.jobs.previous == Some(number) {
		vp.jobs.previous = jobctl::zsh_prevjob(vp);
	}
}

/// `bin_fg`'s `wait_for_processes`/`scanjobs`: without job control a
/// finished job is gone from zsh's table as soon as it is reaped (its
/// `printjob` prints nothing and deletes it); with it, the finished jobs
/// already reported go, and under `NO_NOTIFY` the changes not reported yet
/// are printed now.
fn scanjobs(ctx: &mut Ctx<'_, '_>, jobbing: bool) -> Result<(), Need> {
	let done: Vec<u32> = ctx
		.vp
		.jobs
		.iter()
		.filter(|j| matches!(j.state, JobState::Done(_)) && (!jobbing || j.notified))
		.map(|j| j.number)
		.collect();
	for n in done {
		delete(ctx.vp, n);
	}
	if jobbing && ctx.vp.parent.is_none() && !ctx.zsh_option(ZshOpt::Notify)? {
		jobctl::notices_before_prompt(ctx.k, ctx.cx, ctx.vp);
	}
	Ok(())
}

/// Whether the shell does job control (zsh `jobbing`): never in a
/// subshell.
fn jobbing(ctx: &mut Ctx<'_, '_>) -> bool {
	ctx.vp.parent.is_none() && jobctl::jobbing(ctx.k, ctx.cx)
}

/// zsh `fprintdir`: `dir` with its named directory prefix as `~name`.
fn printdir(ctx: &mut Ctx<'_, '_>, dir: &[u8]) -> Result<BString, Need> {
	Ok(zx(ctx, |ex| nameddir::abbreviate(ex, dir))?.unwrap_or_else(|_| BString::from(dir)))
}

/// `printjob(jn, lng, 2)` for `jobs`: the job's line on standard output,
/// with `lng & 4` its directory; a finished job is deleted once shown.
fn print_listed(ctx: &mut Ctx<'_, '_>, number: u32, lng: u8) -> Result<(), Need> {
	let platform = ctx.k.engine.config().platform;
	let how =
		JobLine { pid: lng & 1 != 0, leader: lng & 2 != 0, conted: false, thisfmt: false };
	let Some(line) = jobctl::format_job(ctx.vp, number, how, platform) else {
		return Ok(());
	};
	ctx.out(&line);
	if lng & 4 != 0 {
		let wd = ctx.vp.jobs.get(number).map_or_default(|j| j.wd.clone());
		let mut out = b"(pwd : ".to_vec();
		out.extend_from_slice(&printdir(ctx, &wd)?);
		out.extend_from_slice(b")\n");
		ctx.out(&out);
	}
	let finished = ctx
		.vp
		.jobs
		.get(number)
		.is_some_and(|j| matches!(j.state, JobState::Done(_)));
	if finished {
		delete(ctx.vp, number);
	} else if let Some(job) = ctx.vp.jobs.get_mut(number) {
		job.notified = true;
	}
	Ok(())
}

/// `jobs [-dlprsZ] [job …]`, `fg [job …]`, `bg [job …]`, `disown [job …]`
/// (zsh `bin_fg`).
pub fn bin_fg(ctx: &mut Ctx<'_, '_>, ops: &Ops, args: &[BString], func: JobFunc) -> R {
	if ops.isset(b'Z') {
		// `jobs -Z`: zsh rewrites its process title; the shell itself sees
		// no change.
		if ctx.zsh_option(ZshOpt::Restricted)? {
			ctx.usage("-Z is restricted");
			return done(1);
		}
		if args.len() != 1 {
			ctx.usage("-Z requires one argument");
			return done(1);
		}
		return done(0);
	}
	let lng: u8 = if func == JobFunc::Jobs {
		let l = if ops.isset(b'l') {
			1
		} else if ops.isset(b'p') {
			2
		} else {
			0
		};
		l | if ops.isset(b'd') { 4 } else { 0 }
	} else {
		u8::from(ctx.zsh_option(ZshOpt::Longlistjobs)?)
	};
	let jobbing = jobbing(ctx);
	if matches!(func, JobFunc::Fg | JobFunc::Bg) && !jobbing {
		ctx.usage("no job control in this shell.");
		return done(1);
	}
	scanjobs(ctx, jobbing)?;
	setcurjob(ctx.vp);
	if func == JobFunc::Jobs {
		jobctl::jobs_listed(ctx.k);
	}
	let mut first = if args.is_empty() {
		if func == JobFunc::Jobs {
			let (r, s) = (ops.isset(b'r'), ops.isset(b's'));
			let picked: Vec<u32> = ctx
				.vp
				.jobs
				.iter()
				.filter(|j| {
					let stopped = matches!(j.state, JobState::Stopped(_));
					r == s || (r && !stopped) || (s && stopped)
				})
				.map(|j| j.number)
				.collect();
			for n in picked {
				print_listed(ctx, n, lng)?;
			}
			return done(0);
		}
		let Some(cur) = curjob(ctx.vp) else {
			ctx.usage("no current job");
			return done(1);
		};
		Some(cur)
	} else {
		None
	};
	let posix = ctx.zsh_option(ZshOpt::Posixbuiltins)?;
	let autocontinue = ctx.zsh_option(ZshOpt::Autocontinue)?;
	let mut words = args.iter();
	let mut retval = 0;
	loop {
		let word = if first.is_some() { None } else { words.next() };
		if first.is_none() && word.is_none() {
			break;
		}
		if func != JobFunc::Jobs && ctx.vp.jobs.iter().any(|j| j.inherited) {
			ctx.usage("can't manipulate jobs in subshell");
			return done(1);
		}
		let job = match (first.take(), word) {
			(Some(n), _) => Some(n),
			(None, Some(w)) => getjob(ctx, w, posix),
			(None, None) => None,
		};
		let Some(job) = job else {
			retval = 127;
			break;
		};
		let stopped = ctx
			.vp
			.jobs
			.get(job)
			.is_some_and(|j| matches!(j.state, JobState::Stopped(_)));
		// `AUTO_CONTINUE`: a stopped job is put in the background, then
		// disowned.
		let f = if autocontinue && func == JobFunc::Disown && stopped {
			JobFunc::Bg
		} else {
			func
		};
		match f {
			JobFunc::Fg | JobFunc::Bg => {
				if f == JobFunc::Bg && !stopped {
					ctx.usage("job already in background");
					return done(1);
				}
				let Some(j) = ctx.vp.jobs.get_mut(job) else {
					continue;
				};
				let (id, vpid, os_pid, wd) = (j.id, j.vpid, j.os_pid, j.wd.clone());
				j.notified = true;
				if stopped {
					j.state = JobState::Running;
					if f == JobFunc::Bg {
						// `$!` names the job's last process.
						ctx.vp.last_bg = LastBg::new(vpid);
						if let Some(pid) = os_pid {
							ctx.vp.last_bg.set_os(pid);
						}
					}
				}
				// Shuffle the current and previous jobs.
				let jobs = &mut ctx.vp.jobs;
				if jobs.current == Some(job) {
					jobs.current = jobs.previous;
					jobs.previous = if f == JobFunc::Bg { None } else { Some(job) };
				}
				if jobs.previous == Some(job) || jobs.previous.is_none() {
					ctx.vp.jobs.previous = jobctl::zsh_prevjob(ctx.vp);
				}
				if ctx.vp.jobs.current.is_none() {
					ctx.vp.jobs.current = ctx.vp.jobs.previous;
					ctx.vp.jobs.previous = jobctl::zsh_prevjob(ctx.vp);
				}
				// zsh `printjob(…, 3)` prints only under job control.
				if jobbing {
					let platform = ctx.k.engine.config().platform;
					let how = JobLine {
						pid:     lng & 1 != 0,
						leader:  false,
						conted:  stopped,
						thisfmt: false,
					};
					if let Some(line) = jobctl::format_job(ctx.vp, job, how, platform) {
						jobctl::notice(ctx.k, ctx.vp, &line);
					}
				}
				if f == JobFunc::Fg {
					if wd != ctx.vp.cwd {
						let mut out = b"(pwd : ".to_vec();
						out.extend_from_slice(&printdir(ctx, &wd)?);
						out.extend_from_slice(b")\n");
						jobctl::notice(ctx.k, ctx.vp, &out);
					}
					jobctl::give_terminal(ctx.k, ctx.cx, vpid);
				}
				if stopped {
					ControlHandle(ctx.k.ctl.clone()).signal(SigTarget::Job(id), Signal::Cont);
				}
				if f == JobFunc::Fg {
					let wait = Wait {
						children: vec![vpid],
						all:      false,
						any:      false,
						into:     None,
						force:    false,
					};
					return Ok(Outcome { status: 0, control: Control::Wait(wait) });
				}
				if func == JobFunc::Disown {
					delete(ctx.vp, job);
				}
			},
			JobFunc::Jobs => print_listed(ctx, job, lng)?,
			JobFunc::Disown => {
				if stopped {
					let pid = ctx
						.vp
						.jobs
						.get(job)
						.map_or(0, |j| jobctl::group(ctx.k, j.vpid).unwrap_or_else(|| j.pid()));
					ctx.usage(format!("warning: job is suspended, use `kill -CONT -{pid}' to resume"));
				}
				delete(ctx.vp, job);
			},
		}
	}
	done(retval)
}

/// The values of zsh/parameter's `jobstates`, `jobtexts` or `jobdirs`
/// (`sp`) by job number (zsh `scanpmjobstates` and its siblings). Without
/// job control a finished job is already gone from zsh's table.
pub fn job_params(
	vp: &Vproc,
	sp: Special,
	jobbing: bool,
	platform: Platform,
) -> Vec<(BString, BString)> {
	// zsh `selectjobtab`: a subshell reports the job table it copied from
	// the shell (`oldjobtab`) when there was one, else its own jobs; a
	// subshell never makes its own jobs current (`spawnjob` under `subsh`).
	let old = vp.jobs.iter().any(|j| j.inherited);
	// Once the subshell starts a job of its own, zsh's `curjob` no longer
	// names a job of the copied table.
	let own_jobs = vp.jobs.subshell && vp.jobs.iter().any(|j| !j.inherited);
	vp.jobs
		.iter()
		.filter(|j| j.inherited == old)
		.filter(|j| jobbing || !matches!(j.state, JobState::Done(_)))
		.map(|j| {
			let own_in_subshell = own_jobs || (vp.jobs.subshell && !j.inherited);
			let value = match sp {
				Special::Jobtexts => j.text.clone(),
				Special::Jobdirs => j.wd.clone(),
				_ => {
					// zsh `pmjobstate`.
					let mark = if own_in_subshell {
						":"
					} else if vp.jobs.current == Some(j.number) {
						":+"
					} else if vp.jobs.previous == Some(j.number) {
						":-"
					} else {
						":"
					};
					let (whole, one) = match j.state {
						JobState::Running => ("running", String::from("running")),
						JobState::Stopped(sig) => ("suspended", String::from(jobctl::sigmsg(sig))),
						JobState::Done(0) => ("done", String::from("done")),
						JobState::Done(status) => {
							("done", match jobctl::death_signal(status, platform) {
								Some(sig) => String::from(jobctl::sigmsg(sig)),
								// zsh prints the raw wait status here.
								None => format!("exit {}", status << 8),
							})
						},
					};
					BString::from(format!("{whole}{mark}:{}={one}", j.pid()))
				},
			};
			(BString::from(j.number.to_string()), value)
		})
		.collect()
}

/// `suspend [-f]` (zsh `bin_suspend`): stop the shell until it is
/// continued; a login shell only with `-f`.
pub fn suspend(ctx: &mut Ctx<'_, '_>, ops: &Ops) -> R {
	if ctx.zsh_option(ZshOpt::Login)? && !ops.isset(b'f') {
		ctx.usage("can't suspend login shell");
		return done(1);
	}
	if crate::bash::vm::jobctl::suspend_shell(ctx.k, ctx.cx) {
		return done(0);
	}
	let vpid = ctx.vp.vpid;
	ControlHandle(ctx.k.ctl.clone()).signal(SigTarget::Vpid(vpid), Signal::Stop);
	done(0)
}
