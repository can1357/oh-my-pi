//! `getopts optstring name [arg …]` (bash `builtins/getopts.def` over
//! `lib/sh/getopt.c`).

use bstr::BString;

use super::{Ctx, Need, R, assign, done};
use crate::bash::{
	diag::Diag,
	store::Attrs,
	vm::{
		is_ident,
		state::{self, Level},
	},
};

/// bash's `builtin_usage` line: no shell-name or line prefix.
const USAGE: &[u8] = b"getopts: usage: getopts optstring name [arg ...]\n";

/// What one scan step found.
enum Found {
	/// No more options (`EOF`).
	End,
	/// An option letter (or `?`/`:` from a doubled-colon optstring), with
	/// its argument.
	Opt(u8, Option<BString>),
	/// A letter not in the optstring.
	Invalid(u8),
	/// A letter whose argument is missing.
	Missing(u8),
}

/// `getopts optstring name [arg …]`: parse the next option of the
/// arguments (the positional parameters without any) into `name`,
/// `OPTARG` and `OPTIND`.
pub fn getopts(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	let args = match args.first() {
		Some(a) if a.as_slice() == b"--" => &args[1..],
		// getopts takes no options (bash's `internal_getopt` with none).
		Some(a) if a.len() > 1 && a[0] == b'-' => {
			ctx.err(Diag::Usage { msg: format!("-{}: invalid option", char::from(a[1])).into() });
			ctx.out_fd(2, USAGE);
			return done(2);
		},
		_ => args,
	};
	let [spec, name, operands @ ..] = args else {
		ctx.out_fd(2, USAGE);
		return done(2);
	};
	let silent = spec.first() == Some(&b':');
	let spec = if silent { &spec[1..] } else { spec.as_slice() };
	let positional;
	let operands = if operands.is_empty() {
		positional = ctx.positional()?;
		positional.as_slice()
	} else {
		operands
	};
	let opterr = !silent
		&& ctx
			.scalar(b"OPTERR")?
			.filter(|v| !v.is_empty())
			.is_none_or(|v| atoi(&v) != 0);
	let current = ctx.scalar(b"OPTIND")?;
	let value = atoi(current.as_ref().map_or(&[][..], |v| v.as_slice()));
	let at = optind_scope(ctx)?;
	let state = &ctx.vp.getopts;
	let (mut optind, mut next) = if current == state.optind && at == state.at {
		(value, state.next)
	} else if value < 0 || value == 1 {
		// bash `sv_optind`: an assigned `OPTIND` of 1 (or below 0) restarts.
		(0, None)
	} else {
		(value, state.next)
	};
	let found = scan(ctx, spec, operands, opterr, &mut optind, &mut next);
	let shown = BString::from(optind.to_string());
	ctx.vp.getopts.optind = Some(shown.clone());
	ctx.vp.getopts.next = next;
	if let Err(d) = assign(ctx.k, ctx.vp, ctx.cx, b"OPTIND", shown, Level::Dynamic) {
		ctx.diag(d);
	}
	ctx.vp.getopts.at = optind_scope(ctx)?;
	match found {
		Found::End => {
			unset_optarg(ctx)?;
			bind(ctx, name, b"?");
			done(1)
		},
		Found::Invalid(c) => {
			let status = bind(ctx, name, b"?");
			if silent {
				set_optarg(ctx, BString::from(vec![c]));
			} else {
				unset_optarg(ctx)?;
			}
			done(status)
		},
		Found::Missing(c) => {
			let status = if silent {
				let status = bind(ctx, name, b":");
				set_optarg(ctx, BString::from(vec![c]));
				status
			} else {
				let status = bind(ctx, name, b"?");
				unset_optarg(ctx)?;
				status
			};
			done(status)
		},
		Found::Opt(c, arg) => {
			match arg {
				Some(arg) => set_optarg(ctx, arg),
				None => unset_optarg(ctx)?,
			}
			done(bind(ctx, name, &[c]))
		},
	}
}

/// bash `sh_getopt` over `$0` + `operands`: `optind` indexes that argv
/// (0: not started), `next` the position inside an option word.
fn scan(
	ctx: &mut Ctx<'_, '_>,
	spec: &[u8],
	operands: &[BString],
	opterr: bool,
	optind: &mut i64,
	next: &mut Option<(u32, u32)>,
) -> Found {
	let argc = operands.len() as i64 + 1;
	if *optind >= argc || *optind < 0 {
		*optind = argc;
		return Found::End;
	}
	if *optind == 0 {
		*optind = 1;
		*next = None;
	}
	// Inside an option word: the word and the offset of its next letter.
	let inside = next.filter(|&(cur, ci)| {
		(cur as usize)
			.checked_sub(1)
			.and_then(|i| operands.get(i))
			.is_some_and(|word| (ci as usize) < word.len())
	});
	let (cur, ci) = if let Some(pos) = inside {
		pos
	} else {
		let Some(word) = operands.get(*optind as usize - 1) else {
			return Found::End;
		};
		if word.as_slice() == b"--" {
			*optind += 1;
			return Found::End;
		}
		if word.first() != Some(&b'-') || word.len() == 1 {
			return Found::End;
		}
		(*optind as u32, 1)
	};
	let word = &operands[cur as usize - 1];
	let c = word[ci as usize];
	let rest = ci as usize + 1;
	if rest >= word.len() {
		*optind += 1;
		*next = None;
	} else {
		*next = Some((cur, rest as u32));
	}
	let Some(at) = spec.iter().position(|&s| s == c).filter(|_| c != b':') else {
		if opterr {
			message(ctx, "illegal option", c);
		}
		return Found::Invalid(c);
	};
	if spec.get(at + 1) != Some(&b':') {
		return Found::Opt(c, None);
	}
	let arg = if next.is_some() {
		*optind += 1;
		BString::from(&word[rest..])
	} else if *optind == argc {
		if opterr {
			message(ctx, "option requires an argument", c);
		}
		*next = None;
		return if spec.first() == Some(&b':') {
			Found::Opt(b':', Some(BString::default()))
		} else {
			Found::Missing(c)
		};
	} else {
		let arg = operands[*optind as usize - 1].clone();
		*optind += 1;
		arg
	};
	*next = None;
	Found::Opt(c, Some(arg))
}

/// The innermost scope that holds `OPTIND` (`None`: the shell's own).
fn optind_scope(ctx: &mut Ctx<'_, '_>) -> Result<Option<u32>, Need> {
	Ok(state::binding_scope(&ctx.k.root, ctx.cx.store, ctx.vp, b"OPTIND")?.map(|i| i as u32))
}

/// bash's `BADOPT`/`NEEDARG`: `$0: MSG -- C` straight to stderr.
fn message(ctx: &mut Ctx<'_, '_>, msg: &str, c: u8) {
	let mut text = ctx.k.argv0.to_vec();
	text.extend_from_slice(b": ");
	text.extend_from_slice(msg.as_bytes());
	text.extend_from_slice(b" -- ");
	text.push(c);
	text.push(b'\n');
	ctx.out_fd(2, &text);
}

/// bash `getopts_bind_variable`: 0, 1 for an invalid name, 2 for a
/// readonly one.
fn bind(ctx: &mut Ctx<'_, '_>, name: &[u8], value: &[u8]) -> i32 {
	if !is_ident(name) {
		ctx.err(Diag::InvalidIdent { name: name.into() });
		return 1;
	}
	match assign(ctx.k, ctx.vp, ctx.cx, name, value.into(), Level::Dynamic) {
		Ok(()) => 0,
		// A name reference to no valid name (`declare -n r; getopts x r`):
		// bash's `sh_invalidid` names the builtin.
		Err(d @ Diag::InvalidIdent { .. }) => {
			ctx.err(d);
			2
		},
		Err(d) => {
			ctx.diag(d);
			2
		},
	}
}

fn set_optarg(ctx: &mut Ctx<'_, '_>, value: BString) {
	if let Err(d) = assign(ctx.k, ctx.vp, ctx.cx, b"OPTARG", value, Level::Dynamic) {
		ctx.diag(d);
	}
}

/// bash `unbind_variable_noref`: a readonly `OPTARG` stays.
fn unset_optarg(ctx: &mut Ctx<'_, '_>) -> Result<(), Need> {
	let readonly = ctx
		.var(b"OPTARG")?
		.is_some_and(|v| v.attrs.contains(Attrs::READONLY));
	if !readonly {
		ctx.set_var(b"OPTARG", None, Level::Dynamic);
	}
	Ok(())
}

/// C `atoi`: leading blanks, a sign and digits; anything else ends it.
fn atoi(text: &[u8]) -> i64 {
	let t = text.trim_ascii_start();
	let (neg, digits) = match t.first() {
		Some(b'-') => (true, &t[1..]),
		Some(b'+') => (false, &t[1..]),
		_ => (false, t),
	};
	let mut v: i64 = 0;
	for &c in digits.iter().take_while(|c| c.is_ascii_digit()) {
		v = v.wrapping_mul(10).wrapping_add(i64::from(c - b'0'));
	}
	if neg { v.wrapping_neg() } else { v }
}

#[cfg(test)]
mod tests {
	use super::atoi;

	#[test]
	fn atoi_stops_at_junk() {
		assert_eq!(atoi(b" 12x"), 12);
		assert_eq!(atoi(b"-3"), -3);
		assert_eq!(atoi(b""), 0);
		assert_eq!(atoi(b"x1"), 0);
	}
}
