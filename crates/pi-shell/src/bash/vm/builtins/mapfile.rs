//! `mapfile` / `readarray` (bash `builtins/mapfile.def`).

use bstr::BString;

use super::{
	Control, Ctx, Outcome, R, done,
	io::{bind_lhs, fd_arg},
	number, opts,
	vars::Lhs,
};
use crate::bash::{
	diag::Diag,
	event::EventData,
	vm::{
		exec::push_script,
		is_ident,
		proc::{AssignValue, Probe, ProbeResult, ScriptKind},
		quote::sh_single_quote,
	},
};

/// The array without an operand.
const DEFAULT_ARRAY: &[u8] = b"MAPFILE";

/// Lines between `-C` callback calls without `-c`.
const DEFAULT_QUANTUM: u64 = 5000;

/// What `mapfile`'s options ask for.
struct Spec<'a> {
	delim:    u8,
	fd:       i32,
	/// Lines to store; 0 for all.
	count:    u64,
	origin:   u64,
	skip:     u64,
	quantum:  u64,
	clear:    bool,
	chop:     bool,
	callback: Option<&'a [u8]>,
}

impl Spec<'_> {
	/// `line` as stored: `-t` drops its delimiter; a NUL ends it (bash
	/// stores C strings).
	fn stored(&self, line: &[u8]) -> BString {
		let mut line = line;
		if self.chop && line.last() == Some(&self.delim) {
			line = &line[..line.len() - 1];
		}
		if let Some(nul) = line.iter().position(|&b| b == 0) {
			line = &line[..nul];
		}
		BString::from(line)
	}
}

/// What one run of `mapfile` stores, as `(line number, line)` with lines
/// numbered from 1 after the skipped ones, and the line whose callback is
/// due: the next run stores it.
struct Batch {
	lines:    Vec<(u64, BString)>,
	callback: Option<(u64, BString)>,
}

/// `mapfile [-d delim] [-n count] [-O origin] [-s count] [-t] [-u fd]
/// [-C callback] [-c quantum] [array]` (also `readarray`).
///
/// As in bash, a `-C` callback runs before its line is stored and reads
/// the input that follows it: `mapfile` reads no further than that line,
/// pushes the callback and runs again when it returns
/// ([`Control::Resume`]), storing the line and reading on.
pub fn mapfile(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	let o = match opts(ctx, args, b"t", b"duOnCcs", false) {
		Ok(o) => o,
		Err(st) => return done(st),
	};
	let mut spec = Spec {
		delim:    b'\n',
		fd:       0,
		count:    0,
		origin:   0,
		skip:     0,
		quantum:  DEFAULT_QUANTUM,
		clear:    true,
		chop:     false,
		callback: None,
	};
	for (flag, _, arg) in &o.flags {
		let arg = arg.as_ref().map_or(&[][..], |a| a.as_slice());
		let bad = match *flag {
			b'd' => {
				spec.delim = arg.first().copied().unwrap_or(0);
				None
			},
			b'u' => match fd_arg(ctx, arg) {
				Ok(fd) => {
					spec.fd = fd;
					None
				},
				Err(st) => return done(st),
			},
			b'n' => unsigned(arg).map_or(Some("invalid line count"), |n| {
				spec.count = n;
				None
			}),
			b'O' => unsigned(arg).map_or(Some("invalid array origin"), |n| {
				spec.origin = n;
				spec.clear = false;
				None
			}),
			b's' => unsigned(arg).map_or(Some("invalid line count"), |n| {
				spec.skip = n;
				None
			}),
			b'c' => unsigned(arg)
				.filter(|&n| n > 0)
				.map_or(Some("invalid callback quantum"), |n| {
					spec.quantum = n;
					None
				}),
			b'C' => {
				spec.callback = Some(arg);
				None
			},
			_ => {
				spec.chop = true;
				None
			},
		};
		if let Some(what) = bad {
			ctx.usage(format!("{}: {what}", bstr::BStr::new(arg)));
			return done(1);
		}
	}
	let name: &[u8] = match o.rest.first() {
		None => DEFAULT_ARRAY,
		Some(n) if n.is_empty() => {
			ctx.usage("empty array variable name");
			return done(2);
		},
		Some(n) => n,
	};
	if !is_ident(name) {
		ctx.err(Diag::InvalidIdent { name: name.into() });
		return done(1);
	}
	// The runs after the first follow callbacks ([`Ctx::resumed`]).
	let run = u64::from(ctx.resumed);
	let mut strip = false;
	if run == 0 {
		match super::vars::indexed_array_target(ctx, name)? {
			Some(s) => strip = s,
			None => return done(1),
		}
	}
	let Batch { lines, callback } = read_run(ctx, &spec, run)?;
	if strip {
		super::vars::strip_nameref(ctx, name)?;
	}
	let items = lines
		.into_iter()
		.map(|(n, line)| (Some(BString::from((spec.origin + n - 1).to_string())), false, line))
		.collect();
	// The first run empties the array (but for `-O`); later ones add to
	// it, whatever the callbacks did to it.
	let lhs = Lhs { name, index: None, append: run > 0 || !spec.clear };
	if !bind_lhs(ctx, lhs, AssignValue::Array(items)) {
		return done(1);
	}
	let (Some(cb), Some((n, line))) = (spec.callback, callback) else {
		return done(0);
	};
	// bash's `run_callback`: `CALLBACK INDEX 'LINE'`, evaluated.
	let mut script = cb.to_vec();
	script.extend_from_slice(format!(" {} ", spec.origin + n - 1).as_bytes());
	script.extend_from_slice(&sh_single_quote(&line));
	script.push(b'\n');
	push_script(ctx.vp, &script, ctx.line, ScriptKind::Eval);
	ctx.k.emit_op(ctx.cx, ctx.vp, 0, EventData::EvalEnter);
	Ok(Outcome { status: 0, control: Control::Resume })
}

/// bash `valid_number` that fits an `unsigned int`.
fn unsigned(arg: &[u8]) -> Option<u64> {
	number(arg)
		.and_then(|n| u32::try_from(n).ok())
		.map(u64::from)
}

/// The lines run `run` of `mapfile` stores. Without a count or callback
/// the input is read to its end at once. Else each run reads, in one
/// probe (part `run + 1`; part 0 holds the skipped lines), the lines up to
/// its callback's or the count, and nothing past them: a run after a
/// callback first stores that callback's line, the previous run's last.
fn read_run(ctx: &Ctx<'_, '_>, spec: &Spec<'_>, run: u64) -> Result<Batch, super::Need> {
	let mut batch = Batch { lines: Vec::new(), callback: None };
	if spec.count == 0 && spec.callback.is_none() {
		let probe = Probe::Input {
			fd:         spec.fd,
			delim:      None,
			lines:      1,
			nchars:     None,
			part:       0,
			timeout_ns: None,
		};
		if let ProbeResult::Input { data, .. } = ctx.probe(probe)? {
			let skip = usize::try_from(spec.skip).unwrap_or(usize::MAX);
			let lines = data.split_inclusive(|&b| b == spec.delim).skip(skip);
			batch.lines = (1..).zip(lines.map(|l| spec.stored(l))).collect();
		}
		return Ok(batch);
	}
	// Up to `lines` lines as part `part`, and whether the input ended.
	let read = |part: u64, lines: u64| -> Result<(BString, bool), super::Need> {
		let (Ok(part), Ok(lines)) = (u32::try_from(part), u32::try_from(lines)) else {
			return Ok((BString::default(), true));
		};
		let probe = Probe::Input {
			fd: spec.fd,
			delim: Some(spec.delim),
			lines,
			nchars: None,
			part,
			timeout_ns: None,
		};
		Ok(match ctx.probe(probe)? {
			ProbeResult::Input { data, eof, .. } => (data, eof),
			_ => (BString::default(), true),
		})
	};
	let quantum = if spec.callback.is_some() {
		spec.quantum
	} else {
		u64::MAX
	};
	// The lines run `r` reads: a quantum, within the count.
	let want = |r: u64| {
		let before = r.saturating_mul(quantum);
		if spec.count == 0 {
			quantum
		} else {
			quantum.min(spec.count.saturating_sub(before))
		}
	};
	// Lines the earlier runs read.
	let before = run.saturating_mul(quantum);
	let ended = if run == 0 {
		spec.skip > 0 && read(0, spec.skip)?.1
	} else {
		let (data, ended) = read(run, want(run - 1))?;
		if let Some(line) = data.split_inclusive(|&b| b == spec.delim).next_back() {
			batch.lines.push((before, spec.stored(line)));
		}
		ended
	};
	let wanted = want(run);
	if ended || wanted == 0 {
		return Ok(batch);
	}
	let (data, _) = read(run + 1, wanted)?;
	let mut lines: Vec<BString> = data
		.split_inclusive(|&b| b == spec.delim)
		.map(|l| spec.stored(l))
		.collect();
	// A whole quantum ends with the line whose callback is due.
	if spec.callback.is_some() && lines.len() as u64 == quantum {
		batch.callback = lines.pop().map(|line| (before + quantum, line));
	}
	batch.lines.extend((before + 1..).zip(lines));
	Ok(batch)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn counts_must_fit_an_unsigned_int() {
		assert_eq!(unsigned(b"5"), Some(5));
		assert_eq!(unsigned(b"-1"), None);
		assert_eq!(unsigned(b"x"), None);
		assert_eq!(unsigned(b"4294967296"), None);
	}
}
