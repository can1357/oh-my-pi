//! Perl's selected output stream, print-family operators and select (perlfunc, perlvar).

use std::{io, time::{Duration, Instant}};

use crate::perl::{
	ast::{Builtin, Call, CallSlot, ExprKind}, interp::{Cx, Flow, Interp, PResult, Ret},
	func::data, io::Io, value::{PStr, Ref, Sv, Value},
};

use super::{args, errno, fail, handles, list, one, scalar, set_io_errno, topic, warn_on};

pub(super) fn call(interp: &mut Interp<'_>, b: Builtin, call: &Call, cx: Cx) -> PResult<Ret> {
	if b == Builtin::Select { return select(interp, call, cx); }
	let explicit = if let Some(CallSlot::Handle(e)) = &call.slot {
		let io = if matches!(&e.kind, ExprKind::Bareword(_)) {
			handles::from_expr(interp, e)?
		} else {
			let v = interp.eval_scalar(e)?;
			match v {
				Value::Undef => return Err(interp.die_msg("Can't use an undefined value as a symbol reference")),
				Value::Ref(r) if !matches!(r, Ref::Glob(_) | Ref::Io(_)) => return Err(interp.die_msg("Not a GLOB reference")),
				_ => handles::handle_value(interp, &v),
			}
		};
		Some((io, handles::spelling(e)))
	} else { None };
	let (io, name) = match explicit {
		Some((io, name)) => (io, name),
		None => (Some(interp.selected()), None),
	};
	let default = args(call).is_empty();
	let tied = io.as_ref().is_some_and(|io| interp.tied_handle(io).is_some());
	// A plain topic printed to a device outside Perl cannot alias its own destination.
	// Release its borrow before warnings (which can run arbitrary Perl) or a second write.
	if default && !tied && b != Builtin::Printf
		&& let Some(io) = io.as_ref().filter(|io| io.borrow().writes_external_bytes())
	{
		let sv = interp.topic();
		if let Some(value) = sv.plain_value() && let Value::Str(text) = &*value {
			let sep = record_separator(interp, b);
			let result = io.borrow_mut().write(text);
			drop(value);
			if !write_result(interp, result, b.name())? { return Ok(one(Value::Undef)); }
			if let Some(s) = sep && !write(interp, io, &s, b.name())? { return Ok(one(Value::Undef)); }
			return Ok(super::yes());
		}
	}
	let mut single = None;
	let mut formatted = None;
	let vals = if b == Builtin::Printf || tied {
		let svs = if default { vec![interp.topic()] }
			else if let Some(expr) = call.args.as_deref() { interp.eval_aliases(expr)? }
			else { Vec::new() };
		if tied && let Some(io) = &io {
			let method = if b == Builtin::Printf { "PRINTF" } else { "PRINT" };
			// `say FH` calls PRINT with a dynamically scoped newline in $\.
			let sep = (b == Builtin::Say).then(|| interp.sv("main::\\"));
			let old = sep.as_ref().map(|sep| sep.replace(Value::bytes(b"\n")));
			let ret = interp.call_tied_handle(io, method, svs, Cx::Scalar);
			if let (Some(sep), Some(old)) = (sep, old) { sep.set(old); }
			return ret.unwrap_or_else(|| Ok(one(Value::Undef)));
		}
		let Some((fmt, rest)) = svs.split_first() else { return Ok(one(Value::Undef)); };
		let fmt = interp.read_sv(fmt)?;
		let fmt = interp.stringify(&fmt)?;
		formatted = Some(data::format(interp, Builtin::Printf, &fmt, rest)?);
		Vec::new()
	} else if default {
		single = Some(topic(interp)?);
		Vec::new()
	} else { list(interp, call)? };
	let Some(io) = io else {
		warn_on(interp, "unopened", || format!("{}() on unopened filehandle {}", b.name(), name.as_deref().unwrap_or("")));
		return Ok(fail(interp, libc::EBADF));
	};
	if let Some(formatted) = formatted {
		return Ok(if write(interp, &io, &formatted, "printf")? { super::yes() } else { one(Value::Undef) });
	}
	let field = if vals.len() > 1 { interp.output_field_sep() } else { None };
	let record = record_separator(interp, b);
	if !check_writable(interp, &io, b.name()) { return Ok(one(Value::Undef)); }
	for (i, val) in single.into_iter().chain(vals).enumerate() {
		if i != 0 && let Some(s) = &field && !write(interp, &io, s, b.name())? { return Ok(one(Value::Undef)); }
		if val.is_undef() { warn_on(interp, "uninitialized", || format!("Use of uninitialized value in {}", b.name())); }
		let s = if let Value::Str(s) = val { s } else { interp.stringify(&val)? };
		if !write(interp, &io, &s, b.name())? { return Ok(one(Value::Undef)); }
	}
	if let Some(s) = &record && !write(interp, &io, s, b.name())? { return Ok(one(Value::Undef)); }
	Ok(super::yes())
}

fn record_separator(interp: &Interp<'_>, b: Builtin) -> Option<std::borrow::Cow<'static, PStr>> {
	use std::borrow::Cow;
	static NEWLINE: std::sync::LazyLock<PStr> = std::sync::LazyLock::new(|| PStr::from_bytes(b"\n"));
	if b == Builtin::Say { Some(Cow::Borrowed(&NEWLINE)) } else { interp.output_record_sep().map(Cow::Owned) }
}

fn check_writable(interp: &mut Interp<'_>, io: &Io, operation: &str) -> bool {
	let (open, writable) = { let h = io.borrow(); (h.is_open(), h.is_writable()) };
	if writable { return true; }
	let (_, name) = handles::identity(interp, io);
	if open {
		warn_on(interp, "io", || format!("Filehandle {name} opened only for input"));
	} else {
		warn_on(interp, "closed", || format!("{operation}() on closed filehandle {name}"));
	}
	interp.set_errno_code(libc::EBADF);
	false
}

pub(super) fn write(interp: &mut Interp<'_>, io: &Io, text: &PStr, operation: &str) -> PResult<bool> {
	if !check_writable(interp, io, operation) { return Ok(false); }
	let result = io.borrow_mut().write(text);
	write_result(interp, result, operation)
}

fn write_result(interp: &mut Interp<'_>, result: io::Result<bool>, operation: &str) -> PResult<bool> {
	match result {
		Ok(wide) => {
			if wide { interp.warn_category_default("utf8", format!("Wide character in {operation}")); }
			Ok(true)
		},
		Err(_) if interp.is_cancelled() => Err(Flow::Cancelled),
		Err(e) => { set_io_errno(interp, &e); Ok(false) },
	}
}

fn select(interp: &mut Interp<'_>, call: &Call, cx: Cx) -> PResult<Ret> {
	let es = args(call);
	match es {
		[] => { let io = interp.selected(); Ok(one(handles::identity(interp, &io).0)) },
		[e] => {
			let chosen = handles::select_slot(interp, e)?;
			let old = interp.set_selected(chosen);
			Ok(one(handles::identity(interp, &old).0))
		},
		[r, w, e, timeout] => {
			let mut sets = Vec::with_capacity(3);
			for expr in [r, w, e] {
				let (dest, val) = if matches!(expr.kind, ExprKind::Variable(..) | ExprKind::Deref(..) | ExprKind::Select(..) | ExprKind::Group(..)) {
					let sv = interp.eval_lvalue(expr)?;
					let val = interp.read_sv(&sv)?;
					(Some(sv), val)
				} else { (None, interp.eval_scalar(expr)?) };
				let mask = if val.is_undef() { None } else {
					let mut s = interp.stringify(&val)?;
					if s.utf8 { s.bytes = s.downgraded().ok_or_else(|| interp.die_msg("Wide character in select"))?; }
					Some(s.bytes)
				};
				if mask.as_ref().is_some_and(|bytes| !bytes.is_empty()) && dest.is_none() {
					return Err(interp.die_msg("Modification of a read-only value attempted"));
				}
				sets.push(DescriptorSet { mask, dest });
			}
			let timeout = scalar(interp, Some(timeout))?;
			let wait = if timeout.is_undef() { None } else {
				Some(Duration::try_from_secs_f64(timeout.to_f64().max(0.0)).unwrap_or(Duration::MAX))
			};
			let start = Instant::now();
			let ready = match poll(interp, &mut sets, wait) {
				Ok(n) => n as i64,
				Err(PollError::Flow(flow)) => return Err(flow),
				Err(PollError::Io(e)) => { errno(interp, &e); -1 },
			};
			if ready >= 0 {
				for set in sets {
					if let (Some(bytes), Some(dest)) = (set.mask, set.dest) && !bytes.is_empty() {
						interp.write_sv(&dest, Value::Str(PStr::new(bytes, false)))?;
					}
				}
			}
			if cx == Cx::List {
				let remaining = wait.map_or(Value::Undef, |d| {
					Value::Num(if cfg!(target_os = "linux") { d.saturating_sub(start.elapsed()).as_secs_f64() } else { d.as_secs_f64() })
				});
				Ok(Ret::Many(vec![Value::Int(ready), remaining]))
			} else { Ok(one(Value::Int(ready))) }
		},
		_ => Err(interp.die_msg("Not enough arguments for select")),
	}
}

struct DescriptorSet { mask: Option<Vec<u8>>, dest: Option<Sv> }

enum PollError { Io(io::Error), Flow(Flow) }
impl From<io::Error> for PollError { fn from(e: io::Error) -> Self { Self::Io(e) } }
impl From<Flow> for PollError { fn from(e: Flow) -> Self { Self::Flow(e) } }

fn poll(interp: &mut Interp<'_>, sets: &mut [DescriptorSet], timeout: Option<Duration>) -> Result<usize, PollError> {
	#[cfg(unix)]
	{
		use nix::poll::{PollFd, PollFlags as P, PollTimeout};
		let types = [P::POLLIN, P::POLLOUT, P::POLLPRI];
		// Decode descriptors in ascending order and resolve each at once: the first one that is not open
		// fails with EBADF (as perl's select does) before any later bit costs memory or time.
		let used = sets.iter().map(|s| s.mask.as_ref().and_then(|m| m.iter().rposition(|&b| b != 0)).map_or(0, |at| at + 1)).max().unwrap_or(0);
		let mut registered = Vec::new();
		for i in 0..used {
			let bytes: [u8; 3] = std::array::from_fn(|k| sets.get(k).and_then(|s| s.mask.as_ref()).and_then(|m| m.get(i)).copied().unwrap_or(0));
			let mut bits = bytes[0] | bytes[1] | bytes[2];
			while bits != 0 {
				let bit = bits.trailing_zeros();
				bits &= bits - 1;
				let flags = bytes.iter().zip(types).filter(|&(&byte, _)| byte & (1u8 << bit) != 0).fold(P::empty(), |acc, (_, flag)| acc | flag);
				let number = i32::try_from(i * 8 + bit as usize).map_err(|_| super::bad_fd())?;
				let fd = match handles::by_fd(interp, number) {
					Some(io) => io.borrow().with_fd(|fd| fd.try_clone_to_owned())?,
					None => interp.host().paths().file(number).ok_or_else(super::bad_fd)?.try_borrow_as_fd()?.try_clone_to_owned()?,
				};
				registered.push((number, fd, flags));
			}
		}
		let mut polls: Vec<_> = registered.iter().map(|(_, fd, flag)| {
			use std::os::fd::AsFd as _;
			PollFd::new(fd.as_fd(), *flag)
		}).collect();
		let start = Instant::now();
		loop {
			if interp.is_cancelled() { return Err(Flow::Cancelled.into()); }
			if interp.poll_alarm()? { return Err(io::Error::from_raw_os_error(libc::EINTR).into()); }
			let remaining = timeout.map_or(Duration::MAX, |d| d.saturating_sub(start.elapsed()));
			let millis = remaining.as_millis().saturating_add(u128::from(remaining.subsec_nanos() % 1_000_000 != 0)).min(40) as u16;
			match nix::poll::poll(&mut polls, PollTimeout::from(millis)) {
				Ok(0) if !remaining.is_zero() && timeout.is_none_or(|d| start.elapsed() < d) => continue,
				Ok(_) => break,
				Err(nix::errno::Errno::EINTR) => continue,
				Err(e) => return Err(io::Error::from_raw_os_error(e as i32).into()),
			}
		}
		if polls.iter().any(|p| p.revents().is_some_and(|e| e.contains(P::POLLNVAL))) { return Err(super::bad_fd().into()); }
		for set in sets.iter_mut() { if let Some(bytes) = &mut set.mask { bytes.fill(0); } }
		let mut count = 0;
		for ((fd, _, requested), state) in registered.iter().zip(&polls) {
			let events = state.revents().unwrap_or_else(P::empty);
			for ((mask, flag), additional) in sets.iter_mut().zip(types).zip([P::POLLHUP | P::POLLERR, P::POLLERR, P::empty()]) {
				if requested.contains(flag) && events.intersects(flag | additional)
					&& let Some(byte) = mask.mask.as_mut().and_then(|set| set.get_mut(*fd as usize / 8))
				{
					*byte |= 1 << (*fd % 8);
					count += 1;
				}
			}
		}
		Ok(count)
	}
	#[cfg(not(unix))]
	{
		if sets.iter().any(|s| s.mask.as_ref().is_some_and(|v| v.iter().any(|&b| b != 0))) {
			return Err(io::Error::from(io::ErrorKind::Unsupported).into());
		}
		let start = Instant::now();
		loop {
			if interp.is_cancelled() { return Err(Flow::Cancelled.into()); }
			if interp.poll_alarm()? { return Err(io::Error::from_raw_os_error(libc::EINTR).into()); }
			let remaining = timeout.map_or(Duration::MAX, |d| d.saturating_sub(start.elapsed()));
			if remaining.is_zero() { return Ok(0); }
			std::thread::sleep(remaining.min(Duration::from_millis(40)));
		}
	}
}
