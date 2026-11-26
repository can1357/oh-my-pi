//! Child invocations and process control (perlfunc, perlvar, perlop, perlipc).

use std::{io, time::{Duration, Instant}};

use crate::perl::{
	ast::{Builtin, Call, CallSlot, ExprKind}, interp::{Cx, Flow, Interp, PResult, Ret},
	io::{ChildContext, Handle, Layers, PipeChild, RecordSep, ShellSpec, run_capture_in, spawn_system_in}, value::{PStr, Value},
};

use super::{READ, fail, interruptible, list, one, set_io_errno, topic, warn_on};

pub(super) fn child_id(interp: &mut Interp<'_>) -> i32 {
	let mut id = interp.sys.last_child_id.checked_sub(1).filter(|id| *id > 0).unwrap_or(i32::MAX);
	while interp.sys.children.contains_key(&id) { id = id.checked_sub(1).filter(|id| *id > 0).unwrap_or(i32::MAX); }
	interp.sys.last_child_id = id;
	id
}

/// Register a native module's Host command under an interpreter-local waitable identity.
pub(in crate::perl) fn register_host_child(interp: &mut Interp<'_>, child: crate::host::RunningCommand) -> i32 {
	let id = child_id(interp);
	let cancel = interp.host().cancel_flag();
	interp.sys.children.insert(id, PipeChild::new(id, child, Some(cancel)));
	id
}

pub(super) fn context(interp: &mut Interp<'_>) -> ChildContext {
	let mut context = ChildContext::new(interp.resolve_path(b"."), interp.env_pairs());
	for (index, name) in ["STDIN", "STDOUT", "STDERR"].into_iter().enumerate() {
		if let Some(io) = interp.handle(name, false) && let Some(fd) = io.borrow().child_stream(index) {
			context.set_stream(index, fd);
		}
	}
	context
}

/// Execute a command substitution and return its bytes or input records.
pub(in crate::perl) fn backticks(interp: &mut Interp<'_>, command: PStr, cx: Cx) -> PResult<Ret> {
	interp.flush_outputs();
	let context = context(interp);
	let result = if interp.alarm_deadline().is_some() && !command.bytes.trim_ascii().is_empty() {
		capture_interruptible(interp, &command.bytes, &context)?
	} else {
		run_capture_in(interp.host(), ShellSpec::Line(&command.bytes), Some(&context))
	};
	match result {
		Ok((bytes, status)) => {
			interp.set_child_status(status);
			let str = PStr::new(bytes, false);
			if cx != Cx::List { return Ok(one(Value::Str(str))); }
			Ok(Ret::Many(records(str, interp.input_sep())))
		},
		Err(_) if interp.is_cancelled() => Err(Flow::Cancelled),
		Err(e) => {
			child_error(interp, &command.bytes, &e);
			Ok(if cx == Cx::List { Ret::Many(Vec::new()) } else { one(Value::Undef) })
		},
	}
}

/// `qx` while an alarm is pending: read the child's output through a pipe
/// handle whose blocking reads the alarm can interrupt.
fn capture_interruptible(interp: &mut Interp<'_>, command: &[u8], context: &ChildContext) -> PResult<io::Result<(Vec<u8>, i32)>> {
	let id = child_id(interp);
	let opened = Handle::open_pipe_in(interp.host(), READ, ShellSpec::Line(command), Layers::raw(), Some(context), id);
	let io = match opened { Ok(h) => std::rc::Rc::new(std::cell::RefCell::new(h)), Err(e) => return Ok(Err(e)) };
	let output = interruptible(interp, &io, |h| h.read_record(&RecordSep::Slurp))?;
	let status = io.borrow_mut().close();
	Ok(output.and_then(|bytes| {
		let status = status?.unwrap_or(0);
		Ok((bytes.map(|s| s.bytes).unwrap_or_default(), status))
	}))
}

/// Wait for `system`'s child, delivering a pending alarm meanwhile (Perl's
/// waitpid restarts after a handler returns; a dying handler leaves the child running).
fn wait_system(interp: &mut Interp<'_>, child: crate::host::RunningCommand) -> PResult<io::Result<i32>> {
	let id = child_id(interp);
	let cancel = interp.host().cancel_flag();
	let child = PipeChild::new(id, child, Some(cancel));
	let mut pause = Duration::from_micros(200);
	loop {
		if let Some(status) = child.status(false) { return Ok(status); }
		if interp.is_cancelled() { return Err(Flow::Cancelled); }
		if let Err(flow) = interp.poll_alarm() {
			interp.sys.children.insert(id, child);
			return Err(flow);
		}
		std::thread::sleep(pause);
		pause = (pause * 2).min(Duration::from_millis(5));
	}
}

fn records(mut str: PStr, sep: RecordSep) -> Vec<Value> {
	if str.is_empty() { return Vec::new(); }
	let val = |s: &[u8]| Value::bytes(s);
	let bytes = str.bytes.as_slice();
	match sep {
		RecordSep::Fixed(0) | RecordSep::Slurp => vec![Value::Str(str)],
		RecordSep::Fixed(n) => bytes.chunks(n).map(val).collect(),
		RecordSep::Text(s) if !s.is_empty() => {
			let delimiter = if s.utf8 {
				let Some(b) = s.downgraded() else { return vec![Value::Str(str)]; };
				b
			} else { s.bytes };
			let mut out = Vec::new();
			let mut from = 0;
			for at in memchr::memmem::find_iter(bytes, &delimiter) {
				let end = at + delimiter.len();
				out.push(val(&bytes[from..end]));
				from = end;
			}
			if from == 0 { return vec![Value::Str(str)]; }
			if from < bytes.len() {
				str.bytes.drain(..from);
				out.push(Value::Str(str));
			}
			out
		},
		RecordSep::Text(_) | RecordSep::Paragraph => {
			let mut out = Vec::new();
			let mut tail = bytes;
			while let Some(start) = tail.iter().position(|b| *b != b'\n') {
				tail = &tail[start..];
				let end = memchr::memmem::find(tail, b"\n\n").map_or(tail.len(), |n| n + 2);
				out.push(val(&tail[..end]));
				tail = &tail[end..];
			}
			out
		},
	}
}

pub(super) fn call(interp: &mut Interp<'_>, b: Builtin, call: &Call, cx: Cx) -> PResult<Ret> {
	use Builtin as B;
	let program = if let Some(CallSlot::Program(e)) = &call.slot {
		let v = interp.eval_scalar(e)?;
		Some(interp.stringify(&v)?.bytes)
	} else { None };
	let vals = if b == B::Readpipe { Vec::new() } else { list(interp, call)? };
	let value = |i: usize| vals.get(i).unwrap_or(&Value::Undef);
	match b {
		B::System | B::Exec => {
			let mut argv = Vec::with_capacity(vals.len());
			for v in &vals { argv.push(interp.stringify(v)?.bytes); }
			if argv.is_empty() {
				let err = io::Error::from_raw_os_error(libc::ENOENT);
				if b == B::Exec {
					set_io_errno(interp, &err);
					child_warning(interp, b"", &err);
					return Ok(one(Value::Int(0)));
				}
				child_error(interp, b"", &err);
				return Ok(one(Value::Int(-1)));
			}
			let name = program.as_deref().unwrap_or(&argv[0]);
			let spec = if let Some(program) = &program { ShellSpec::Program { program, argv: &argv } }
				else if argv.len() == 1 { ShellSpec::Line(&argv[0]) } else { ShellSpec::Argv(&argv) };
			interp.flush_outputs();
			let context = context(interp);
			// Always poll: the wait must observe cancellation and a pending alarm.
			let status = match spawn_system_in(interp.host(), spec, Some(&context)) {
				Ok(Ok(child)) => wait_system(interp, child)?,
				Ok(Err(status)) => Ok(status),
				Err(e) => Err(e),
			};
			match status {
				Ok(status) => {
					interp.set_child_status(status);
					if b == B::Exec {
						let signal = status & 127;
						return Err(Flow::Exit(if signal == 0 { status >> 8 } else { 128 + signal }));
					}
					Ok(one(Value::Int(i64::from(status))))
				},
				Err(_) if interp.is_cancelled() => Err(Flow::Cancelled),
				Err(e) => {
					if b == B::Exec {
						set_io_errno(interp, &e);
						child_warning(interp, name, &e);
						Ok(one(Value::Int(0)))
					} else {
						child_error(interp, name, &e);
						Ok(one(Value::Int(-1)))
					}
				},
			}
		},
		B::Readpipe => {
			let val = match call.args.as_deref() {
				Some(expr) if !matches!(&expr.kind, ExprKind::List(items) if items.is_empty()) => interp.eval_scalar(expr)?,
				_ => topic(interp)?,
			};
			let str = interp.stringify(&val)?;
			backticks(interp, str, cx)
		},
		B::Fork => Ok(fail(interp, libc::ENOSYS)),
		B::Wait => wait(interp, -1, 0),
		B::Waitpid => wait(interp, value(0).to_i64() as i32, value(1).to_i64() as i32),
		B::Kill => kill(interp, &vals),
		B::Alarm => {
			let secs = match vals.first() { Some(v) => v.to_i64(), None => topic(interp)?.to_i64() };
			if secs < 0 {
				warn_on(interp, "misc", || "alarm() with negative argument".into());
				return Ok(one(Value::Undef));
			}
			let deadline = if secs != 0 { Instant::now().checked_add(Duration::from_secs(secs as u64)) } else { None };
			Ok(one(Value::Int(interp.set_alarm(deadline) as i64)))
		},
		B::Getppid => Ok(one(Value::Int(logical_ppid(interp)))),
		B::Getpgrp | B::Setpgrp | B::Getpriority | B::Setpriority => Ok(os_process(interp, b, &vals)),
		_ => Ok(one(Value::Undef)),
	}
}

fn child_error(interp: &mut Interp<'_>, name: &[u8], err: &io::Error) {
	interp.set_child_status(-1);
	set_io_errno(interp, err);
	child_warning(interp, name, err);
}

fn child_warning(interp: &mut Interp<'_>, name: &[u8], err: &io::Error) {
	warn_on(interp, "exec", || {
		let s = err.to_string();
		let message = s.split(" (os error ").next().unwrap_or(&s);
		let name = String::from_utf8_lossy(name);
		format!("Can't exec \"{name}\": {message}")
	});
}

fn wait(interp: &mut Interp<'_>, id: i32, flags: i32) -> PResult<Ret> {
	// A Host command may be an in-process utility and therefore have no OS
	// PID; pipe opens return an interpreter-owned id in either case.
	loop {
		let mut exists = false;
		let mut complete = None;
		for (&candidate, child) in &interp.sys.children {
			if id > 0 && id != candidate { continue; }
			exists = true;
			if let Some(status) = child.status(false) { complete = Some((candidate, status)); break; }
		}
		if let Some((id, status)) = complete {
			interp.sys.children.remove(&id);
			match status {
				Ok(status) => { interp.set_child_status(status); return Ok(one(Value::Int(i64::from(id)))); },
				Err(e) => { set_io_errno(interp, &e); interp.set_child_status(-1); return Ok(one(Value::Int(-1))); },
			}
		}
		if !exists {
			interp.set_errno_code(libc::ECHILD);
			interp.set_child_status(-1);
			return Ok(one(Value::Int(-1)));
		}
		if flags & 1 != 0 { return Ok(one(Value::Int(0))); }
		if interp.is_cancelled() { return Err(Flow::Cancelled); }
		if interp.poll_alarm()? {
			interp.set_errno_code(libc::EINTR);
			return Ok(one(Value::Int(-1)));
		}
		std::thread::sleep(Duration::from_millis(5));
	}
}

fn kill(interp: &mut Interp<'_>, vals: &[Value]) -> PResult<Ret> {
	#[cfg(unix)]
	{
		use nix::{sys::signal::{Signal, kill}, unistd::{Pid, getpgid, getpgrp, getpid, getppid}};
		let Some((sig, targets)) = vals.split_first() else { return Err(interp.die_msg("Not enough arguments for kill")); };
		let (code, group) = if sig.looks_like_number() {
			let n = sig.to_i64() as i32;
			(n.saturating_abs(), n < 0)
		} else {
			let s = interp.stringify(sig)?;
			let s = s.to_string_lossy();
			let negative = s.starts_with('-');
			let signal = s.strip_prefix('-').unwrap_or(&s);
			let sig = if signal.starts_with("SIG") { signal.to_owned() } else { format!("SIG{signal}") };
			let signal = sig.parse::<Signal>().map_err(|_| interp.die_msg(format!("Unrecognized signal name \"{s}\"")))?;
			(signal as i32, negative)
		};
		let signal = if code == 0 { None } else if let Ok(sig) = Signal::try_from(code) { Some(sig) }
			else { interp.set_errno_code(libc::EINVAL); return Ok(one(Value::Int(0))); };
		// The shell's own group and its real parent (terminal, tmux, agent) with that parent's group are off limits.
		let shell_group = getpgrp().as_raw();
		let parent = getppid().as_raw();
		let parent_group = getpgid(Some(Pid::from_raw(parent))).map(Pid::as_raw).ok();
		let protected = |p: i32| {
			matches!(p, -1 | 0) || p == -shell_group || p == parent || p == -parent || parent_group.is_some_and(|g| p == -g)
		};
		let mut n = 0;
		for pid in targets {
			if !pid.looks_like_number() { return Err(interp.die_msg("Can't kill a non-numeric process ID")); }
			let p = pid.to_i64() as i32;
			if let Some(child) = interp.sys.children.get(&p) {
				let result = child.signal(code);
				match result { Ok(()) => n += 1, Err(e) => set_io_errno(interp, &e) }
				continue;
			}
			let p = if group { -p.saturating_abs() } else { p };
			if p == getpid().as_raw() && let Some(signal) = signal {
				let name = signal.as_str();
				interp.raise_signal(name.strip_prefix("SIG").unwrap_or(name), code)?;
				n += 1;
				continue;
			}
			let result = if signal.is_some() && protected(p) {
				// Never broadcast a signal or send it to the embedding shell's group or its parent.
				Err(nix::errno::Errno::EPERM)
			} else { kill(Pid::from_raw(p), signal) };
			match result { Ok(()) => n += 1, Err(e) => interp.set_errno_code(e as i32) }
		}
		Ok(one(Value::Int(n)))
	}
	#[cfg(not(unix))]
	{ let _ = vals; interp.set_errno_code(libc::ENOSYS); Ok(one(Value::Int(0))) }
}

/// `getppid` as the script sees it: the embedding shell runs the script in-process, so the shell
/// (pid `$$`) is its logical parent. The shell's real parent (terminal, tmux, agent) is never exposed.
pub(in crate::perl) fn logical_ppid(_interp: &Interp<'_>) -> i64 { i64::from(std::process::id()) }

fn os_process(interp: &mut Interp<'_>, b: Builtin, vals: &[Value]) -> Ret {
	#[cfg(unix)]
	{
		use Builtin as B;
		use nix::unistd;
		use rustix::process as p;
		let val = |i: usize| vals.get(i).map_or(0, Value::to_i64) as i32;
		let value = |n| one(Value::Int(i64::from(n)));
		let uid = |i| (val(i) != -1).then(|| p::Uid::from_raw(val(i) as u32));
		let pid = |i| p::Pid::from_raw(val(i));
		match b {
			B::Getpgrp => match unistd::getpgid(Some(unistd::Pid::from_raw(val(0)))) {
				Ok(id) => value(id.as_raw()), Err(e) => fail(interp, e as i32),
			},
			// The script runs inside the shell and its children are Host commands with interpreter-local ids,
			// not OS pids it owns: any real pid belongs to the shell, its jobs or its parent. Refuse them all.
			B::Setpgrp | B::Setpriority => fail(interp, libc::EPERM),
			B::Getpriority => match match val(0) {
				0 => p::getpriority_process(pid(1)),
				1 => p::getpriority_pgrp(pid(1)),
				2 => match uid(1) { Some(uid) => p::getpriority_user(uid), None => return fail(interp, libc::EINVAL) },
				_ => return fail(interp, libc::EINVAL),
			} { Ok(n) => value(n), Err(e) => fail(interp, e.raw_os_error()) },
			_ => one(Value::Undef),
		}
	}
	#[cfg(not(unix))]
	{ let _ = (b, vals); fail(interp, libc::ENOSYS) }
}
