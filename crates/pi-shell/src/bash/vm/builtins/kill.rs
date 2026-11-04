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

/// A signal operand: a number (0 probes) or a name with or without `SIG`.
fn parse_signal(spec: &[u8], platform: Platform) -> Option<Send> {
	if !spec.is_empty() && spec.iter().all(u8::is_ascii_digit) && spec.iter().all(|&c| c == b'0') {
		return Some(Send::Probe);
	}
	Signal::parse_spec(spec, platform).map(Send::Signal)
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
	let mut send = Send::Signal(Signal::Term);
	let mut i = 0;
	if let Some(first) = args.first() {
		let first = first.as_slice();
		if first == b"-l" || first == b"-L" {
			return list(ctx, &args[1..]);
		}
		if first == b"--" {
			i = 1;
		} else if first.starts_with(b"-s") || first.starts_with(b"-n") {
			let attached = &first[2..];
			let spec = if attached.is_empty() {
				let Some(spec) = args.get(1) else {
					ctx.usage(format!("{}: option requires an argument", first.as_bstr()));
					return done(2);
				};
				i = 2;
				spec.as_slice()
			} else {
				i = 1;
				attached
			};
			let numeric = first[1] == b'n';
			let parsed = if numeric && !spec.iter().all(u8::is_ascii_digit) {
				None
			} else {
				parse_signal(spec, platform)
			};
			let Some(parsed) = parsed else {
				ctx.diag(Diag::InvalidSignal { cmd: "kill".into(), spec: spec.into() });
				return done(1);
			};
			send = parsed;
			if args.get(i).is_some_and(|a| a.as_slice() == b"--") {
				i += 1;
			}
		} else if first.starts_with(b"-") && first.len() > 1 {
			let Some(parsed) = parse_signal(&first[1..], platform) else {
				ctx.diag(Diag::InvalidSignal { cmd: "kill".into(), spec: first[1..].into() });
				return done(1);
			};
			send = parsed;
			i = 1;
			if args.get(i).is_some_and(|a| a.as_slice() == b"--") {
				i += 1;
			}
		}
	}
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
		let job = ctx.vp.jobs.get_mut(number).ok_or(TargetError::NoSuchJob)?;
		if matches!(job.state, JobState::Done(_))
			|| matches!(
				ctx.k.proc_state(ctx.cx.store, job.vpid),
				Some(crate::bash::vm::ProcState::Exited(_))
			) {
			return Err(TargetError::NoSuchJob);
		}
		// bash `kill_pid`: continuing a stopped job by `kill` acts like `bg`
		// (the job runs, the current job stays).
		if send == Send::Signal(Signal::Cont) && matches!(job.state, JobState::Stopped(_)) {
			job.state = JobState::Running;
			job.notified = true;
		}
		return Ok(Some(SigTarget::Job(job.id)));
	}
	let pid = std::str::from_utf8(arg)
		.ok()
		.and_then(|s| s.parse::<i32>().ok())
		.ok_or(TargetError::NotAnId)?;
	let base = ctx.k.engine.config().vpid_base;
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

/// `kill -l [sig …]`: the signal table, or names for numbers (statuses
/// above 128 map to their signal) and numbers for names.
pub fn list(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	let platform = ctx.k.engine.config().platform;
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
		let number = std::str::from_utf8(spec)
			.ok()
			.and_then(|s| s.parse::<u16>().ok());
		let sig = match number {
			Some(n) => {
				let n = if n > 128 { n - 128 } else { n };
				u8::try_from(n)
					.ok()
					.and_then(|n| Signal::from_number(n, platform))
			},
			None => Signal::parse_spec(spec, platform),
		};
		match sig {
			Some(sig) if number.is_some() => ctx.out(format!("{sig}\n").as_bytes()),
			Some(sig) => ctx.out(format!("{}\n", sig.number(platform)).as_bytes()),
			None => {
				ctx.diag(Diag::InvalidSignal { cmd: "kill".into(), spec: spec.clone() });
				status = 1;
			},
		}
	}
	done(status)
}
