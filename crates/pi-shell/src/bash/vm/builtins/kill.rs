//! The `kill` builtin: virtual processes stay on the shell's signal bus;
//! other pids go to
//! [`Host::signal_process`](crate::bash::Host::signal_process).

use std::fmt::Write as _;

use bstr::{BString, ByteSlice};
use strum::IntoEnumIterator;

use super::{Ctx, R, done};
use crate::bash::{
	ControlHandle, Platform, SigTarget, Signal, Vpid, diag::Diag, vm::proc::JobState,
};

/// What `kill` sends.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Send {
	/// Signal 0: check that the target exists, deliver nothing.
	Probe,
	/// A signal.
	Signal(Signal),
}

impl Send {
	pub(super) const fn signal(self) -> Option<Signal> {
		match self {
			Self::Probe => None,
			Self::Signal(sig) => Some(sig),
		}
	}
}

/// Bash's `decode_signal` uses signed decimal numbers and its canonical
/// `initialize_signames` table, not every alias the OS defines. All kill
/// spellings use this decoder; `display_signal_list` also maps exit statuses.
fn parse_signal(spec: &[u8], platform: Platform, prefix: bool, listing: bool) -> Option<Send> {
	if let Ok(number) = std::str::from_utf8(spec.trim_ascii()).ok()?.parse::<i64>() {
		let number = if listing && number > 128 {
			number - 128
		} else {
			number
		};
		return match number {
			0 => Some(Send::Probe),
			_ => u8::try_from(number)
				.ok()
				.and_then(|n| Signal::from_number(n, platform))
				.map(Send::Signal),
		};
	}
	if spec.eq_ignore_ascii_case(b"EXIT") {
		return Some(Send::Probe);
	}
	let unprefixed = if spec
		.get(..3)
		.is_some_and(|s| s.eq_ignore_ascii_case(b"SIG"))
	{
		&spec[3..]
	} else {
		spec
	};
	// decode_signal handles RTMIN offsets with valid_number before its
	// SIG-prefix permission check. RTMAX offsets must instead match one
	// of initialize_signames' canonical entries.
	if platform == Platform::Linux
		&& unprefixed
			.get(..6)
			.is_some_and(|s| s.eq_ignore_ascii_case(b"RTMIN+"))
	{
		let offset = std::str::from_utf8(unprefixed[6..].trim_ascii())
			.ok()?
			.parse::<i64>()
			.ok()
			.and_then(|n| u8::try_from(n).ok())?;
		return (offset <= 30)
			.then(|| Signal::from_number(34 + offset, platform).map(Send::Signal))
			.flatten();
	}
	let name = if prefix { unprefixed } else { spec };
	Signal::iter()
		.find(|sig| {
			let canonical: &'static str = (*sig).into();
			sig.number(platform) != 0 && name.eq_ignore_ascii_case(canonical.as_bytes())
		})
		.map(Send::Signal)
}

/// Why a target could not be signalled.
pub(super) enum TargetError {
	/// `%n` names no live job.
	NoSuchJob,
	/// zsh `getjob` already reported the bad spec.
	Reported,
	/// Neither a number nor a job spec.
	NotAnId,
	/// A vpid that is not a child of this shell.
	NoSuchProcess,
	/// The host refused or failed.
	Host(std::io::Error),
}

/// `kill [-s sig | -n num | -sig] pid|%job …`, `kill -l [sig …]`.
pub fn kill(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	let platform = ctx.k.engine.config().platform;
	let prefix = !ctx.option(crate::bash::store::OptId::Posix)?;
	let mut send = Some(Send::Signal(Signal::Term));
	let mut spec: &[u8] = b"TERM";
	let mut saw_signal = false;
	let mut listing = false;
	let mut i = 0;
	// kill_builtin finishes option decoding before it signals any operand.
	// Even a lone '-' is a signal specification (the invalid empty name).
	while let Some(word) = args.get(i).map(|a| a.as_slice()) {
		if word == b"-l" || word == b"-L" {
			listing = true;
			i += 1;
		} else if word == b"--" {
			i += 1;
			break;
		} else if word == b"-s" || word == b"-n" {
			let Some(value) = args.get(i + 1) else {
				ctx.usage(format!("{}: option requires an argument", word.as_bstr()));
				return done(1);
			};
			spec = value;
			send = parse_signal(spec, platform, prefix, false);
			saw_signal = true;
			i += 2;
		} else if (word.starts_with(b"-s") && word.get(2).is_some_and(u8::is_ascii_alphabetic))
			|| (word.starts_with(b"-n") && word.get(2).is_some_and(u8::is_ascii_digit))
		{
			spec = &word[2..];
			send = parse_signal(spec, platform, prefix, false);
			saw_signal = true;
			i += 1;
		} else if word == b"-?" {
			ctx.builtin_usage();
			return done(2);
		} else if word.starts_with(b"-") && !saw_signal {
			spec = &word[1..];
			send = parse_signal(spec, platform, prefix, false);
			saw_signal = true;
			i += 1;
		} else {
			break;
		}
	}
	if listing {
		return list(ctx, &args[i..]);
	}
	let Some(send) = send else {
		ctx.diag(Diag::InvalidSignal { cmd: "kill".into(), spec: spec.into() });
		return done(1);
	};
	if i == args.len() {
		ctx.builtin_usage();
		return done(2);
	}
	let mut status = 0;
	for arg in &args[i..] {
		match target(ctx, arg, send, None) {
			Ok(Some(target)) => {
				if let Some(sig) = send.signal() {
					ControlHandle(ctx.k.ctl.clone()).signal(target, sig);
				}
			},
			Ok(None) => {},
			Err(err) => {
				let msg = match err {
					TargetError::Reported => {
						status = 1;
						continue;
					},
					TargetError::NoSuchJob => format!("{}: no such job", arg.as_bstr()),
					TargetError::NotAnId => {
						// bash `sh_badpid`.
						format!("`{}': not a pid or valid job spec", arg.as_bstr())
					},
					TargetError::NoSuchProcess => format!("({}) - No such process", arg.as_bstr()),
					TargetError::Host(e) => {
						format!("({}) - {}", arg.as_bstr(), crate::bash::diag::strerror(&e))
					},
				};
				ctx.usage(msg);
				status = 1;
			},
		}
	}
	done(status)
}

/// Resolve one operand: a virtual process to signal on the bus
/// (`Ok(Some)`), an OS process the host signalled itself (`Ok(None)`), or
/// an error. `zsh`: zsh dialect, with `POSIX_BUILTINS`.
pub(super) fn target(
	ctx: &mut Ctx<'_, '_>,
	arg: &[u8],
	send: Send,
	zsh: Option<bool>,
) -> Result<Option<SigTarget>, TargetError> {
	if arg.starts_with(b"%") {
		let number = match zsh {
			Some(posix) => super::zsh_jobs::getjob(ctx, arg, posix).ok_or(TargetError::Reported)?,
			None => super::jobs::spec(ctx, arg).map_err(|_| TargetError::NoSuchJob)?,
		};
		return job_target(ctx, number, send);
	}
	let pid = std::str::from_utf8(arg)
		.ok()
		.and_then(|s| s.parse::<i32>().ok())
		.ok_or(TargetError::NotAnId)?;
	let base = ctx.k.engine.config().vpid_base;
	// kill_pid interprets pid < -1 as a process group. Only job-control
	// jobs own such a group; a job without job control must still use the
	// host's killpg path, not jobspec expansion.
	if pid < -1
		&& let Some(number) = ctx
			.vp
			.jobs
			.by_pid(pid.unsigned_abs())
			.filter(|job| job.control)
			.map(|job| job.number)
	{
		return job_target(ctx, number, send);
	}
	// A job's (or `$!`'s) program OS pid names the job's vproc: the signal
	// reaches the program through it, and the job's state follows.
	let named = u32::try_from(pid)
		.ok()
		.filter(|&p| p > 0)
		.map(|p| ctx.vp.vpid_of(p));
	let live = named.filter(|&v| {
		let st = ctx.k.proc_state(ctx.cx.store, v);
		// `$!` of a job disowned before the scheduler adopted it is known
		// only by `$!` (as `wait`'s `is_child`).
		(ctx.vp.jobs.by_vpid(v).is_some()
			|| st == Some(crate::bash::vm::ProcState::Running)
			|| (st.is_none() && ctx.vp.last_bg.is(v)))
			&& !matches!(st, Some(crate::bash::vm::ProcState::Exited(_)))
	});
	match u32::try_from(pid) {
		Ok(p) if p > 0 && p == ctx.k.shell_pid => Ok(Some(SigTarget::Vpid(Vpid(base)))),
		Ok(p) if p > 0 && p == ctx.vp.vpid.0 => Ok(Some(SigTarget::Vpid(ctx.vp.vpid))),
		Ok(_) if live.is_some() => Ok(live.map(SigTarget::Vpid)),
		// A finished job's program pid may already name another process.
		Ok(p) if p >= base || named.is_some_and(|v| v.0 != p) => Err(TargetError::NoSuchProcess),
		_ => ctx
			.cx
			.host
			.signal_process(pid, send.signal())
			.map(|()| None)
			.map_err(TargetError::Host),
	}
}

fn job_target(
	ctx: &mut Ctx<'_, '_>,
	number: u32,
	send: Send,
) -> Result<Option<SigTarget>, TargetError> {
	let job = ctx.vp.jobs.get_mut(number).ok_or(TargetError::NoSuchJob)?;
	if matches!(job.state, JobState::Done(_))
		|| matches!(
			ctx.k.proc_state(ctx.cx.store, job.vpid),
			Some(crate::bash::vm::ProcState::Exited(_))
		) {
		return Err(TargetError::NoSuchJob);
	}
	// kill_pid treats a kill-continued stopped group like bg.
	if send == Send::Signal(Signal::Cont) && matches!(job.state, JobState::Stopped(_)) {
		job.state = JobState::Running;
		job.notified = true;
	}
	Ok(Some(SigTarget::Job(job.id)))
}

/// `kill -l [sig …]`: the signal table, or names for numbers (statuses
/// above 128 map to their signal) and numbers for names.
pub fn list(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	let platform = ctx.k.engine.config().platform;
	let prefix = !ctx.option(crate::bash::store::OptId::Posix)?;
	if args.is_empty() {
		let mut signals: Vec<_> = Signal::iter().filter(|s| s.number(platform) != 0).collect();
		signals.sort_by_key(|s| s.number(platform));
		// bash `display_signal_list`: five `N) SIGNAME` per line, tab
		// separated; POSIX mode lists bare names on one line.
		let posix = ctx.option(crate::bash::store::OptId::Posix)?;
		let mut text = String::new();
		if posix {
			let names: Vec<String> = signals.iter().map(ToString::to_string).collect();
			text.push_str(&names.join(" "));
			text.push('\n');
		} else {
			for (i, s) in signals.iter().enumerate() {
				let _ = write!(text, "{:2}) SIG{s}", s.number(platform));
				text.push(if (i + 1).is_multiple_of(5) {
					'\n'
				} else {
					'\t'
				});
			}
			if !signals.len().is_multiple_of(5) {
				text.push('\n');
			}
		}
		ctx.out(text.as_bytes());
		return done(0);
	}
	let mut status = 0;
	for spec in args {
		let numeric = spec
			.trim_ascii()
			.first()
			.is_some_and(|c| c.is_ascii_digit() || matches!(c, b'+' | b'-'));
		match parse_signal(spec, platform, prefix, true) {
			Some(send) if numeric => match send {
				Send::Probe => ctx.out(b"EXIT\n"),
				Send::Signal(sig) => ctx.out(format!("{sig}\n").as_bytes()),
			},
			Some(send) => {
				ctx.out(
					format!("{}\n", send.signal().map_or(0, |sig| sig.number(platform))).as_bytes(),
				);
			},
			None => {
				ctx.diag(Diag::InvalidSignal { cmd: "kill".into(), spec: spec.clone() });
				status = 1;
			},
		}
	}
	done(status)
}
