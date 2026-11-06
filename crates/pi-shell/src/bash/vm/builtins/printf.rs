//! bash `printf`, ported from bash 5.3 `builtins/printf.def`: the format is
//! reused until the arguments run out, `%b %q %Q %(…)T %n` are bash's own,
//! the C conversions follow printf(3) with bash's argument rules
//! (`strtoimax`, `'c` character codes, `Result too large`), and `%ls %lc`
//! (`%S %C`) count characters in a UTF-8 locale.

use bstr::{BString, ByteSlice};

use super::{
	Ctx, Need, R, done,
	io::{bind, invalid_number},
	strftime,
	vars::{Lhs, set_value},
};
use crate::bash::{
	diag::Diag,
	store::Attrs,
	vm::{is_ident, locale, proc::AssignValue, quote, state::Level},
};

/// bash's `builtin_usage` line: no shell-name or line prefix.
const USAGE: &[u8] = b"printf: usage: printf [-v var] format [arguments]\n";

/// `strerror(EOVERFLOW)`: printf(3) cannot produce more than `INT_MAX`
/// bytes.
const EOVERFLOW: &str = "Value too large to be stored in data type";

/// C `INT_MAX`: printf(3) widths, precisions and output lengths.
const INT_MAX: usize = 0x7fff_ffff;

/// `strftime` output longer than this is dropped (bash's `TIMELEN_MAX`).
const TIMELEN_MAX: usize = 128;

/// bash `printf [-v var] format [arguments]`.
pub fn printf(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	let mut i = 0;
	let mut vname: Option<&[u8]> = None;
	while let Some(a) = args.get(i) {
		if a.as_slice() == b"--" {
			i += 1;
			break;
		}
		if a.len() < 2 || a[0] != b'-' {
			break;
		}
		if a[1] != b'v' {
			ctx.usage(format!("-{}: invalid option", char::from(a[1])));
			ctx.out_fd(2, USAGE);
			return done(2);
		}
		i += 1;
		// The name's argv index (counting argv[0]) when it is a word of its
		// own: only such a word can have been written as an array
		// reference.
		let (name, at) = if a.len() > 2 {
			(&a[2..], usize::MAX)
		} else if let Some(n) = args.get(i) {
			i += 1;
			(n.as_slice(), i)
		} else {
			ctx.usage("-v: option requires an argument");
			ctx.out_fd(2, USAGE);
			return done(2);
		};
		if !super::vars::assignable_name(ctx, name, at)? {
			ctx.err(Diag::InvalidIdent { name: name.into() });
			return done(2);
		}
		vname = Some(name);
	}
	let Some((format, rest)) = args[i..].split_first() else {
		ctx.out_fd(2, USAGE);
		return done(2);
	};
	if format.is_empty() {
		let ok = vname.is_none_or(|name| bind(ctx, name, AssignValue::Scalar(BString::default())));
		return done(i32::from(!ok));
	}
	let cs = locale::charset(ctx.k, ctx.cx.store, ctx.vp);
	let utf8 = cs == locale::Charset::Utf8;
	let point = locale::decimal_point(ctx.k, ctx.cx.store, ctx.vp);
	let mut f = Fmt {
		ctx,
		args: rest,
		next: 0,
		out: Vec::new(),
		flushed: 0,
		vflag: vname.is_some(),
		pass_start: 0,
		conv_err: false,
		utf8,
		cs,
		point,
	};
	let status = loop {
		f.pass_start = f.out.len();
		if let Err(st) = f.pass(format)? {
			break st;
		}
		if f.next == 0 || f.next >= rest.len() {
			break i32::from(f.conv_err);
		}
	};
	let Fmt { ctx, out, flushed, .. } = f;
	if let Some(name) = vname {
		let ok = bind(ctx, name, AssignValue::Scalar(out.into()));
		done(if ok { status } else { 1 })
	} else {
		ctx.out(&out[flushed..]);
		done(status)
	}
}

/// printf(3) flags of one directive.
#[derive(Clone, Copy, Default)]
struct Flags {
	left:  bool,
	plus:  bool,
	space: bool,
	alt:   bool,
	zero:  bool,
}

/// A field width as written.
#[derive(Clone, Copy)]
enum Width<'f> {
	None,
	/// `*`: the argument's value (already range-checked by `getint`).
	Star(i32),
	/// Literal digits.
	Lit(&'f [u8]),
}

/// A precision as written.
#[derive(Clone, Copy)]
enum Prec<'f> {
	None,
	/// `.*`: the argument's value.
	Star(i32),
	/// `.digits`; empty for a bare `.`.
	Lit(&'f [u8]),
	/// `.-digits`: printf(3) ignores it.
	Neg,
}

/// One `%` directive without its conversion character.
#[derive(Clone, Copy)]
struct Spec<'f> {
	flags: Flags,
	width: Width<'f>,
	prec:  Prec<'f>,
}

/// `Err(status)` stops the whole `printf` (bash's `PRETURN`).
type Step = Result<(), i32>;

struct Fmt<'x, 'a, 'c> {
	ctx:        &'x mut Ctx<'a, 'c>,
	args:       &'x [BString],
	next:       usize,
	out:        Vec<u8>,
	/// Bytes of `out` already written (bash's stdout is line-buffered, so
	/// complete lines precede a diagnostic).
	flushed:    usize,
	/// `-v`: the output goes to a variable, nothing is written.
	vflag:      bool,
	/// Start of this pass's output (`%n` counts from here).
	pass_start: usize,
	/// A conversion error was reported (the status becomes 1).
	conv_err:   bool,
	utf8:       bool,
	/// The locale's character set (`\u`/`\U` escapes).
	cs:         locale::Charset,
	/// The locale's decimal point (`%f %e %g %a`).
	point:      u8,
}

impl<'x> Fmt<'x, '_, '_> {
	/// One pass over the format; `Ok(Err(status))` stops `printf`.
	fn pass(&mut self, fmt: &[u8]) -> Result<Step, Need> {
		let mut i = 0;
		while i < fmt.len() {
			let c = fmt[i];
			if c == b'\\' {
				let (used, _, err) = tescape(&fmt[i + 1..], false, self.cs, &mut self.out);
				self.escape_error(err);
				i += 1 + used;
				continue;
			}
			if c != b'%' {
				self.out.push(c);
				i += 1;
				continue;
			}
			let start = i;
			i += 1;
			if fmt.get(i) == Some(&b'%') {
				self.out.push(b'%');
				i += 1;
				continue;
			}
			let mut flags = Flags::default();
			while let Some(&flag) = fmt.get(i) {
				match flag {
					b'#' => flags.alt = true,
					b'-' => flags.left = true,
					b'+' => flags.plus = true,
					b' ' => flags.space = true,
					b'0' => flags.zero = true,
					b'\'' => {},
					_ => break,
				}
				i += 1;
			}
			let width = if fmt.get(i) == Some(&b'*') {
				i += 1;
				Width::Star(self.getint(0))
			} else {
				let len = digits_at(&fmt[i..]);
				i += len;
				if len == 0 {
					Width::None
				} else {
					Width::Lit(&fmt[i - len..i])
				}
			};
			let mut prec = Prec::None;
			if fmt.get(i) == Some(&b'.') {
				i += 1;
				if fmt.get(i) == Some(&b'*') {
					i += 1;
					prec = Prec::Star(self.getint(-1));
				} else {
					let neg = fmt.get(i) == Some(&b'-');
					if neg {
						i += 1;
					}
					let len = digits_at(&fmt[i..]);
					i += len;
					prec = if neg && len > 0 {
						Prec::Neg
					} else {
						Prec::Lit(&fmt[i - len..i])
					};
				}
			}
			let mut long = false;
			while let Some(&modifier) = fmt.get(i) {
				if !b"hjlLtz".contains(&modifier) {
					break;
				}
				long |= modifier == b'l';
				i += 1;
			}
			let Some(&conv) = fmt.get(i) else {
				self.usage(format!("`{}': missing format character", fmt[start..].as_bstr()));
				return Ok(Err(1));
			};
			i += 1;
			let spec = Spec { flags, width, prec };
			if conv == b'(' {
				match time_format(&fmt[i..]) {
					Ok((tfmt, used)) => {
						i += used;
						if let Err(st) = self.time(tfmt, &spec)? {
							return Ok(Err(st));
						}
					},
					Err(bad) => {
						self.usage(format!(
							"warning: `{}': invalid time format specification",
							char::from(bad)
						));
						self.out.push(b'%');
						i = start + 1;
					},
				}
				continue;
			}
			if let Err(st) = self.convert(conv, long, &spec) {
				return Ok(Err(st));
			}
		}
		Ok(Ok(()))
	}

	/// Queue `d`, after the complete lines produced so far: bash's stdout
	/// is line-buffered and its diagnostics go straight to stderr.
	fn report(&mut self, d: Diag, prefixed: bool) {
		if !self.vflag
			&& let Some(nl) = self.out[self.flushed..].iter().rposition(|&b| b == b'\n')
		{
			let end = self.flushed + nl + 1;
			self.ctx.out(&self.out[self.flushed..end]);
			self.flushed = end;
		}
		if prefixed {
			self.ctx.err(d);
		} else {
			self.ctx.diag(d);
		}
	}

	/// `printf: MSG`.
	fn usage(&mut self, msg: impl Into<std::borrow::Cow<'static, str>>) {
		self.report(Diag::Usage { msg: msg.into() }, true);
	}

	/// Report an escape that bash diagnoses (output continues).
	fn escape_error(&mut self, err: Option<EscError>) {
		match err {
			Some(EscError::Hex) => self.usage("missing hex digit for \\x"),
			Some(EscError::Unicode(c)) => {
				self.usage(format!("missing unicode digit for \\{}", char::from(c)));
			},
			None => {},
		}
	}

	fn convert(&mut self, conv: u8, long: bool, spec: &Spec<'_>) -> Step {
		match conv {
			b'c' | b'C' if (long || conv == b'C') && self.utf8 => {
				let arg = self.getstr();
				let ch = first_char(arg);
				if ch.is_empty() {
					// A null argument gives a single NUL byte (POSIX interp 1647).
					self.printstr(b"\0", spec);
				} else {
					self.printwide(ch, spec);
				}
				Ok(())
			},
			b'c' | b'C' => {
				let ch = self.getchr();
				self.c_pad(&[ch], spec)
			},
			b's' | b'S' if (long || conv == b'S') && self.utf8 => {
				let arg = self.getstr();
				self.printwide(arg, spec);
				Ok(())
			},
			b's' | b'S' => {
				let arg = self.getstr();
				let arg = match c_prec(spec) {
					Some(p) => &arg[..p.min(arg.len())],
					None => arg,
				};
				self.c_pad(arg, spec)
			},
			b'b' => {
				let arg = self.getstr();
				let mut s = Vec::with_capacity(arg.len());
				let sawc = self.bexpand(arg, &mut s);
				self.printstr(&s, spec);
				if sawc {
					// bash returns its current status here, before the
					// conversion-error check.
					return Err(0);
				}
				Ok(())
			},
			b'n' => {
				let var = self.getstr();
				if !var.is_empty() {
					if !is_ident(var) {
						self.report(Diag::InvalidIdent { name: var.into() }, true);
						return Err(1);
					}
					let tw = self.out.len() - self.pass_start;
					let lhs = Lhs { name: var, index: None, append: false };
					let ctx = &mut *self.ctx;
					let value = AssignValue::Scalar(BString::from(tw.to_string()));
					if let Err(d) = set_value(ctx.k, ctx.cx, ctx.vp, lhs, value, Level::Dynamic) {
						self.report(d, false);
					}
				}
				Ok(())
			},
			b'q' | b'Q' => {
				let mut arg = self.getstr();
				if conv == b'Q' {
					let p = match spec.prec {
						Prec::Star(p) => usize::try_from(p).ok(),
						Prec::Lit([]) | Prec::None | Prec::Neg => None,
						Prec::Lit(d) => decimal(d),
					};
					if let Some(p) = p {
						arg = &arg[..p.min(arg.len())];
					}
				}
				let q = quote(arg, spec.flags.alt, self.utf8);
				if conv == b'Q' {
					// The precision applied to the argument; the quoted text
					// is printed whole (literal digits are still checked).
					let (w, left) = self.str_width(spec);
					let _ = self.str_prec(spec);
					pad(&mut self.out, &q, w, left);
				} else {
					self.printstr(&q, spec);
				}
				Ok(())
			},
			b'd' | b'i' => {
				let v = self.getintmax();
				let sign = if v < 0 {
					"-"
				} else if spec.flags.plus {
					"+"
				} else if spec.flags.space {
					" "
				} else {
					""
				};
				self.c_int(sign, "", &v.unsigned_abs().to_string(), spec)
			},
			b'o' | b'u' | b'x' | b'X' => {
				let v = self.getuintmax();
				let (digits, prefix) = match conv {
					b'u' => (v.to_string(), ""),
					b'o' => (format!("{v:o}"), ""),
					b'x' => (format!("{v:x}"), if spec.flags.alt && v != 0 { "0x" } else { "" }),
					_ => (format!("{v:X}"), if spec.flags.alt && v != 0 { "0X" } else { "" }),
				};
				if conv == b'o' && spec.flags.alt {
					// `#` makes the first digit a 0.
					let prec = c_prec(spec).unwrap_or(1);
					let shown = if v == 0 && prec == 0 {
						0
					} else {
						digits.len().max(prec)
					};
					if shown == 0 || (shown == digits.len() && !digits.starts_with('0')) {
						return self.c_int("", "0", &digits, spec);
					}
				}
				self.c_int("", prefix, &digits, spec)
			},
			b'e' | b'E' | b'f' | b'F' | b'g' | b'G' | b'a' | b'A' => {
				let v = self.getfloat();
				let mut body = float(v.abs(), conv, spec.flags.alt, c_prec(spec));
				if self.point != b'.' {
					body = body.replace('.', &char::from(self.point).to_string());
				}
				let sign = if v.is_sign_negative() {
					"-"
				} else if spec.flags.plus {
					"+"
				} else if spec.flags.space {
					" "
				} else {
					""
				};
				let mut s = Vec::from(sign.as_bytes());
				let width = c_width(spec).map_or(0, |(w, _)| w);
				if spec.flags.zero
					&& !spec.flags.left
					&& v.is_finite()
					&& sign.len() + body.len() < width
				{
					let (pre, digits) = if body.starts_with("0x") || body.starts_with("0X") {
						body.split_at(2)
					} else {
						("", body.as_str())
					};
					s.extend_from_slice(pre.as_bytes());
					s.resize(width - digits.len(), b'0');
					s.extend_from_slice(digits.as_bytes());
				} else {
					s.extend_from_slice(body.as_bytes());
				}
				self.c_pad(&s, spec)
			},
			_ => {
				self.usage(format!("`{}': invalid format character", char::from(conv)));
				Err(1)
			},
		}
	}

	/// `%(fmt)T`: the argument (seconds since the epoch, `-1` now, `-2`
	/// shell start; none means now) formatted by `strftime` in `$TZ`.
	fn time(&mut self, tfmt: &[u8], spec: &Spec<'_>) -> Result<Step, Need> {
		let arg = if self.next < self.args.len() {
			self.getintmax()
		} else {
			-1
		};
		let host = &self.ctx.cx.host;
		let now = host.wall().secs;
		let secs = match arg {
			-1 => now,
			-2 => {
				let up = host.now_ns().saturating_sub(self.ctx.k.start_ns) / 1_000_000_000;
				now - i64::try_from(up).unwrap_or(0)
			},
			s => s,
		};
		// bash's `sv_tz`: only an exported `TZ` reaches `localtime`.
		let tz = self
			.ctx
			.var(b"TZ")?
			.filter(|v| v.attrs.contains(Attrs::EXPORT))
			.and_then(|v| v.as_scalar().map(BString::from));
		let (offset, abbr) = self
			.ctx
			.cx
			.host
			.tz_offset(tz.as_ref().map(|t| t.as_bstr()), secs);
		let tfmt = if tfmt.is_empty() {
			b"%X".as_slice()
		} else {
			tfmt
		};
		let mut text = strftime::format(tfmt, secs, offset, &abbr);
		if text.len() >= TIMELEN_MAX {
			text.clear();
		}
		self.printstr(&text, spec);
		Ok(Ok(()))
	}

	/// `%b` argument expansion; `true` when `\c` ended it.
	fn bexpand(&mut self, s: &[u8], out: &mut Vec<u8>) -> bool {
		let mut i = 0;
		while i < s.len() {
			if i + 1 == s.len() {
				out.push(s[i]);
				break;
			}
			if s[i] != b'\\' {
				out.push(s[i]);
				i += 1;
				continue;
			}
			let (used, sawc, err) = tescape(&s[i + 1..], true, self.cs, out);
			self.escape_error(err);
			if sawc {
				return true;
			}
			i += 1 + used;
		}
		false
	}

	/// bash `printstr`: `s` with the directive's width and precision in
	/// bytes, literal values diagnosed.
	fn printstr(&mut self, s: &[u8], spec: &Spec<'_>) {
		let (w, left) = self.str_width(spec);
		let nc = self
			.str_prec(spec)
			.filter(|&p| p <= s.len())
			.unwrap_or(s.len());
		pad(&mut self.out, &s[..nc], w, left);
	}

	/// bash `printwidestr`: width and precision count characters.
	fn printwide(&mut self, s: &[u8], spec: &Spec<'_>) {
		let (w, left) = self.str_width(spec);
		let prec = self.str_prec(spec);
		let mut end = 0;
		let mut count = 0;
		while end < s.len() && prec.is_none_or(|p| count < p) {
			end += first_char(&s[end..]).len();
			count += 1;
		}
		let fill = w.saturating_sub(count);
		if !left {
			self.out.resize(self.out.len() + fill, b' ');
		}
		self.out.extend_from_slice(&s[..end]);
		if left {
			self.out.resize(self.out.len() + fill, b' ');
		}
	}

	/// printstr's field width: literal digits beyond `INT_MAX` are reported
	/// and ignored.
	fn str_width(&mut self, spec: &Spec<'_>) -> (usize, bool) {
		let left = spec.flags.left;
		match spec.width {
			Width::None => (0, left),
			Width::Star(w) => (w.unsigned_abs() as usize, left || w < 0),
			Width::Lit(d) => {
				if let Some(w) = decimal(d) {
					(w, left)
				} else {
					self.erange(d);
					(0, left)
				}
			},
		}
	}

	/// printstr's precision: a bare `.` is 0, literal digits beyond
	/// `INT_MAX` are reported and ignored.
	fn str_prec(&mut self, spec: &Spec<'_>) -> Option<usize> {
		match spec.prec {
			Prec::None => None,
			Prec::Star(p) => usize::try_from(p).ok(),
			Prec::Neg | Prec::Lit([]) => Some(0),
			Prec::Lit(d) => {
				let p = decimal(d);
				if p.is_none() {
					self.erange(d);
				}
				p
			},
		}
	}

	/// Pad `body` to the printf(3) field width; a width printf(3) cannot
	/// produce stops `printf` with `EOVERFLOW`.
	fn c_pad(&mut self, body: &[u8], spec: &Spec<'_>) -> Step {
		let Some((w, left)) = c_width(spec).filter(|&(w, _)| w.max(body.len()) < INT_MAX) else {
			self.usage(EOVERFLOW);
			return Err(1);
		};
		pad(&mut self.out, body, w, left);
		Ok(())
	}

	/// An integer conversion: precision as minimum digits, `0` padding
	/// between sign/prefix and digits.
	fn c_int(&mut self, sign: &str, prefix: &str, digits: &str, spec: &Spec<'_>) -> Step {
		let prec = c_prec(spec);
		let digits = if prec == Some(0) && digits == "0" {
			""
		} else {
			digits
		};
		let mut s = Vec::with_capacity(digits.len() + 4);
		s.extend_from_slice(sign.as_bytes());
		s.extend_from_slice(prefix.as_bytes());
		let zero_fill = match c_width(spec) {
			Some((w, false)) if prec.is_none() && spec.flags.zero => {
				Some(w.saturating_sub(s.len() + digits.len()))
			},
			_ => None,
		};
		let zeros = zero_fill.unwrap_or_else(|| prec.map_or(0, |p| p.saturating_sub(digits.len())));
		s.resize(s.len() + zeros, b'0');
		s.extend_from_slice(digits.as_bytes());
		self.c_pad(&s, spec)
	}

	/// The next argument without consuming it.
	fn peek(&self) -> Option<&'x [u8]> {
		self.args.get(self.next).map(|a| a.as_slice())
	}

	/// bash `getstr`: the next argument, `""` when none is left.
	fn getstr(&mut self) -> &'x [u8] {
		let a = self.peek().unwrap_or_default();
		self.next = (self.next + 1).min(self.args.len());
		a
	}

	/// bash `getchr`: the first byte of the next argument (NUL for none).
	fn getchr(&mut self) -> u8 {
		self.getstr().first().copied().unwrap_or(0)
	}

	/// bash `asciicode`: the character after a leading quote.
	fn asciicode(&mut self) -> i64 {
		let arg = self.getstr();
		let rest = &arg[1..];
		if self.utf8 {
			let ch = first_char(rest);
			if let Ok(s) = std::str::from_utf8(ch)
				&& let Some(c) = s.chars().next()
			{
				return i64::from(u32::from(c));
			}
		}
		rest.first().map_or(0, |&b| i64::from(b))
	}

	/// bash `getint`: a `*` width or precision; `overflow` when the value
	/// does not fit an `int` (reported).
	fn getint(&mut self, overflow: i32) -> i32 {
		let Some(arg) = self.peek() else {
			return 0;
		};
		if matches!(arg.first(), Some(b'\'' | b'"')) {
			return self.asciicode() as i32;
		}
		let p = strtonum(arg);
		let (v, erange) = p.signed();
		let out_of_range = erange || i32::try_from(v).is_err();
		self.check(arg, p.end, out_of_range);
		self.next += 1;
		if out_of_range { overflow } else { v as i32 }
	}

	/// bash `getintmax` (`strtoimax`).
	fn getintmax(&mut self) -> i64 {
		let Some(arg) = self.peek() else {
			return 0;
		};
		if matches!(arg.first(), Some(b'\'' | b'"')) {
			return self.asciicode();
		}
		let p = strtonum(arg);
		let (v, erange) = p.signed();
		self.check(arg, p.end, erange);
		self.next += 1;
		v
	}

	/// bash `getuintmax` (`strtoumax`: negative values wrap).
	fn getuintmax(&mut self) -> u64 {
		let Some(arg) = self.peek() else {
			return 0;
		};
		if matches!(arg.first(), Some(b'\'' | b'"')) {
			return self.asciicode() as u64;
		}
		let p = strtonum(arg);
		let (v, erange) = p.unsigned();
		self.check(arg, p.end, erange);
		self.next += 1;
		v
	}

	/// bash `getfloatmax` (`strtold`).
	fn getfloat(&mut self) -> f64 {
		let Some(arg) = self.peek() else {
			return 0.0;
		};
		if matches!(arg.first(), Some(b'\'' | b'"')) {
			return self.asciicode() as f64;
		}
		let (v, end, erange) = strtod(arg);
		self.check(arg, end, erange);
		self.next += 1;
		v
	}

	/// bash `chk_converror`: unconverted text is an invalid number, then
	/// `ERANGE` is `Result too large`.
	fn check(&mut self, arg: &[u8], end: usize, erange: bool) {
		if end == 0 || end < arg.len() {
			self.usage(invalid_number(arg));
			self.conv_err = true;
		} else if erange {
			self.erange(arg);
		}
	}

	/// bash `printf_erange`.
	fn erange(&mut self, what: &[u8]) {
		self.usage(format!("{}: Result too large", what.as_bstr()));
		self.conv_err = true;
	}
}

/// Number of ASCII digits at the start of `s`.
fn digits_at(s: &[u8]) -> usize {
	s.iter().take_while(|c| c.is_ascii_digit()).count()
}

/// Literal decimal digits as a width or precision; `None` above `INT_MAX`.
fn decimal(d: &[u8]) -> Option<usize> {
	let mut v: usize = 0;
	for &c in d {
		v = v.checked_mul(10)?.checked_add(usize::from(c - b'0'))?;
	}
	(v <= INT_MAX).then_some(v)
}

/// The width printf(3) uses and whether the field is left-justified;
/// `None` when a literal width exceeds `INT_MAX` (`EOVERFLOW`).
fn c_width(spec: &Spec<'_>) -> Option<(usize, bool)> {
	let left = spec.flags.left;
	match spec.width {
		Width::None => Some((0, left)),
		Width::Star(w) => Some((w.unsigned_abs() as usize, left || w < 0)),
		Width::Lit(d) => decimal(d).map(|w| (w, left)),
	}
}

/// The precision printf(3) uses: negative or out-of-range ones are
/// ignored, a bare `.` is 0.
fn c_prec(spec: &Spec<'_>) -> Option<usize> {
	match spec.prec {
		Prec::None | Prec::Neg => None,
		Prec::Star(p) => usize::try_from(p).ok(),
		Prec::Lit([]) => Some(0),
		Prec::Lit(d) => decimal(d),
	}
}

/// Append `s` padded with spaces to `width` bytes.
fn pad(out: &mut Vec<u8>, s: &[u8], width: usize, left: bool) {
	let fill = width.saturating_sub(s.len());
	if !left {
		out.resize(out.len() + fill, b' ');
	}
	out.extend_from_slice(s);
	if left {
		out.resize(out.len() + fill, b' ');
	}
}

/// The first UTF-8 character of `s` (a single byte when invalid).
fn first_char(s: &[u8]) -> &[u8] {
	let Some(&b) = s.first() else {
		return s;
	};
	let n = match b {
		0xc2..=0xdf => 2,
		0xe0..=0xef => 3,
		0xf0..=0xf4 => 4,
		_ => 1,
	};
	if n > 1 && s.len() >= n && std::str::from_utf8(&s[..n]).is_ok() {
		&s[..n]
	} else {
		&s[..1]
	}
}

/// `%(fmt)T` after the `(`: the time format and the bytes used through
/// the `T`; without a matching `)T`, the byte bash names in its warning
/// (the one after the `)`, NUL at the end).
fn time_format(s: &[u8]) -> Result<(&[u8], usize), u8> {
	let mut depth = 1;
	for (i, &c) in s.iter().enumerate() {
		match c {
			b'(' => depth += 1,
			b')' => {
				depth -= 1;
				if depth == 0 {
					return match s.get(i + 1) {
						Some(b'T') => Ok((&s[..i], i + 2)),
						other => Err(other.copied().unwrap_or(0)),
					};
				}
			},
			_ => {},
		}
	}
	Err(0)
}

/// An escape bash diagnoses.
#[derive(Clone, Copy)]
enum EscError {
	/// `\x` without hex digits.
	Hex,
	/// `\u`/`\U` without hex digits.
	Unicode(u8),
}

/// bash `tescape`: decode the escape after a backslash (`s` starts after
/// it) into `out`. `for_b` is `%b` processing (`\c` stops, `\0nnn`, quotes
/// stay escaped). Returns the bytes used (0 leaves the following byte to
/// the caller after a literal backslash), whether `\c` was seen, and a
/// diagnostic.
fn tescape(
	text: &[u8],
	for_b: bool,
	cs: locale::Charset,
	out: &mut Vec<u8>,
) -> (usize, bool, Option<EscError>) {
	let Some(&first) = text.first() else {
		out.push(b'\\');
		return (0, false, None);
	};
	let mut used = 1;
	match first {
		b'a' => out.push(0x07),
		b'b' => out.push(0x08),
		b'e' | b'E' => out.push(0x1b),
		b'f' => out.push(0x0c),
		b'n' => out.push(b'\n'),
		b'r' => out.push(b'\r'),
		b't' => out.push(b'\t'),
		b'v' => out.push(0x0b),
		b'0'..=b'7' => {
			let mut value = u32::from(first - b'0');
			let mut more = 2 + usize::from(value == 0 && for_b);
			while more > 0 && matches!(text.get(used), Some(b'0'..=b'7')) {
				value = value * 8 + u32::from(text[used] - b'0');
				used += 1;
				more -= 1;
			}
			out.push((value & 0xff) as u8);
		},
		b'x' => {
			let (value, count) = hex(&text[1..], 2);
			if count == 0 {
				out.push(b'\\');
				return (0, false, Some(EscError::Hex));
			}
			out.push((value & 0xff) as u8);
			used += count;
		},
		b'u' | b'U' => {
			let (value, count) = hex(&text[1..], if first == b'u' { 4 } else { 8 });
			if count == 0 {
				out.push(b'\\');
				return (0, false, Some(EscError::Unicode(first)));
			}
			used += count;
			locale::push_code_point(cs, value, out);
		},
		b'\\' => out.push(b'\\'),
		b'\'' | b'"' | b'?' if !for_b => out.push(first),
		b'c' if for_b => return (1, true, None),
		_ => {
			out.push(b'\\');
			return (0, false, None);
		},
	}
	(used, false, None)
}

/// Up to `max` hex digits: (value, count).
fn hex(s: &[u8], max: usize) -> (u32, usize) {
	let mut v = 0u32;
	let mut n = 0;
	for &c in s.iter().take(max) {
		let Some(d) = char::from(c).to_digit(16) else {
			break;
		};
		v = v.wrapping_mul(16).wrapping_add(d);
		n += 1;
	}
	(v, n)
}

/// `%q`/`%Q` quoting (bash `sh_quote_reusable`-style): `''` for empty,
/// `$'…'` when a byte is not printable, `'…'` for `%#q`, else backslashes.
fn quote(s: &[u8], alt: bool, utf8: bool) -> Vec<u8> {
	if s.is_empty() {
		return b"''".to_vec();
	}
	if quote::ansic_shouldquote(s, utf8) {
		return quote::ansic(s, utf8);
	}
	if alt {
		return quote::sh_single_quote(s);
	}
	backslash_quote(s, utf8)
}

/// bash `sh_backslash_quote` with flags 3: its metacharacter table, `#`
/// first, `~` first or after `:`/`=`.
fn backslash_quote(s: &[u8], utf8: bool) -> Vec<u8> {
	let mut out = Vec::with_capacity(s.len() * 2);
	let mut i = 0;
	while i < s.len() {
		let c = s[i];
		if c >= 0x80 && utf8 {
			let ch = first_char(&s[i..]);
			out.extend_from_slice(ch);
			i += ch.len();
			continue;
		}
		let special = matches!(
			c,
			b'\t'
				| b'\n'
				| b' '
				| b'!'
				| b'"'
				| b'$'
				| b'&'
				| b'\''
				| b'('
				| b')'
				| b'*'
				| b','
				| b';'
				| b'<'
				| b'>'
				| b'?'
				| b'['
				| b'\\'
				| b']'
				| b'^'
				| b'`'
				| b'{'
				| b'|'
				| b'}'
		) || (c == b'#' && i == 0)
			|| (c == b'~' && (i == 0 || matches!(s[i - 1], b':' | b'=')));
		if special {
			out.push(b'\\');
		}
		out.push(c);
		i += 1;
	}
	out
}

/// A C integer literal as `strtoimax`/`strtoumax` with base 0 read it.
struct Num {
	neg: bool,
	/// Magnitude, saturated far above `u64::MAX`.
	mag: u128,
	/// Bytes converted (0: none, `endptr == str`).
	end: usize,
}

impl Num {
	/// `strtoimax`: the value and whether it overflowed (clamped).
	const fn signed(&self) -> (i64, bool) {
		if self.neg {
			if self.mag > 1u128 << 63 {
				(i64::MIN, true)
			} else {
				((self.mag as i128).wrapping_neg() as i64, false)
			}
		} else if self.mag > i64::MAX as u128 {
			(i64::MAX, true)
		} else {
			(self.mag as i64, false)
		}
	}

	/// `strtoumax`: negative values wrap, overflow clamps to the maximum.
	const fn unsigned(&self) -> (u64, bool) {
		if self.mag > u64::MAX as u128 {
			return (u64::MAX, true);
		}
		let v = self.mag as u64;
		(if self.neg { v.wrapping_neg() } else { v }, false)
	}
}

/// C `isspace`.
const fn c_space(c: u8) -> bool {
	matches!(c, b' ' | b'\t' | b'\n' | 0x0b | 0x0c | b'\r')
}

/// Parse a C integer (`0x` hex, leading-`0` octal, decimal) after
/// optional white space and sign.
fn strtonum(s: &[u8]) -> Num {
	let mut i = 0;
	while i < s.len() && c_space(s[i]) {
		i += 1;
	}
	let mut neg = false;
	if let Some(&c @ (b'+' | b'-')) = s.get(i) {
		neg = c == b'-';
		i += 1;
	}
	let (radix, start) = if s.get(i) == Some(&b'0')
		&& matches!(s.get(i + 1), Some(b'x' | b'X'))
		&& s.get(i + 2).is_some_and(u8::is_ascii_hexdigit)
	{
		(16, i + 2)
	} else if s.get(i) == Some(&b'0') {
		(8, i)
	} else {
		(10, i)
	};
	let mut j = start;
	let mut mag: u128 = 0;
	while let Some(d) = s.get(j).and_then(|&c| char::from(c).to_digit(radix)) {
		mag = mag
			.saturating_mul(u128::from(radix))
			.saturating_add(u128::from(d));
		j += 1;
	}
	if j == start {
		return Num { neg, mag: 0, end: 0 };
	}
	Num { neg, mag, end: j }
}

/// C `strtod` over a prefix of `s`: the value, the bytes converted (0 for
/// none) and whether it over- or underflowed (`ERANGE`).
fn strtod(arg: &[u8]) -> (f64, usize, bool) {
	let mut at = 0;
	while at < arg.len() && c_space(arg[at]) {
		at += 1;
	}
	let mut neg = false;
	if let Some(&sign @ (b'+' | b'-')) = arg.get(at) {
		neg = sign == b'-';
		at += 1;
	}
	let body = &arg[at..];
	let signed = |value: f64| if neg { -value } else { value };
	let starts =
		|word: &[u8]| body.len() >= word.len() && body[..word.len()].eq_ignore_ascii_case(word);
	if starts(b"inf") {
		let len = if starts(b"infinity") { 8 } else { 3 };
		return (signed(f64::INFINITY), at + len, false);
	}
	if starts(b"nan") {
		let close = body
			.get(4..)
			.filter(|_| body[3] == b'(')
			.and_then(|rest| rest.iter().position(|&b| b == b')'))
			.filter(|&close| {
				body[4..4 + close]
					.iter()
					.all(|&b| b.is_ascii_alphanumeric() || b == b'_')
			});
		let len = close.map_or(3, |close| 5 + close);
		return (signed(f64::NAN), at + len, false);
	}
	if body.len() > 2
		&& body[0] == b'0'
		&& matches!(body[1], b'x' | b'X')
		&& (body[2].is_ascii_hexdigit()
			|| (body[2] == b'.' && body.get(3).is_some_and(u8::is_ascii_hexdigit)))
	{
		let (value, len) = hex_float(&body[2..]);
		let erange = value.is_infinite() || value.is_subnormal();
		return (signed(value), at + 2 + len, erange);
	}
	let mut end = digits_at(body);
	let mut ndigits = end;
	if body.get(end) == Some(&b'.') {
		let frac = digits_at(&body[end + 1..]);
		ndigits += frac;
		end += 1 + frac;
	}
	if ndigits == 0 {
		return (0.0, 0, false);
	}
	if matches!(body.get(end), Some(b'e' | b'E')) {
		let mut exp_at = end + 1;
		if matches!(body.get(exp_at), Some(b'+' | b'-')) {
			exp_at += 1;
		}
		let exp_digits = digits_at(&body[exp_at..]);
		if exp_digits > 0 {
			end = exp_at + exp_digits;
		}
	}
	let text = &body[..end];
	let value = std::str::from_utf8(text)
		.ok()
		.and_then(|t| t.parse::<f64>().ok())
		.unwrap_or(0.0);
	let mantissa_nonzero = text
		.iter()
		.take_while(|b| !matches!(b, b'e' | b'E'))
		.any(|&b| matches!(b, b'1'..=b'9'));
	let erange = value.is_infinite() || value.is_subnormal() || (value == 0.0 && mantissa_nonzero);
	(signed(value), at + end, erange)
}

/// A hexadecimal float body after `0x`: the value and the bytes used.
fn hex_float(text: &[u8]) -> (f64, usize) {
	let mut mant: u64 = 0;
	let mut exp: i64 = 0;
	let mut at = 0;
	let mut seen_point = false;
	while let Some(&byte) = text.get(at) {
		if byte == b'.' && !seen_point {
			seen_point = true;
			at += 1;
			continue;
		}
		let Some(digit) = char::from(byte).to_digit(16) else {
			break;
		};
		if mant >> 60 == 0 {
			mant = mant * 16 + u64::from(digit);
			if seen_point {
				exp -= 4;
			}
		} else if !seen_point {
			exp += 4;
		}
		at += 1;
	}
	if matches!(text.get(at), Some(b'p' | b'P')) {
		let mut exp_at = at + 1;
		let neg = text.get(exp_at) == Some(&b'-');
		if matches!(text.get(exp_at), Some(b'+' | b'-')) {
			exp_at += 1;
		}
		let count = digits_at(&text[exp_at..]);
		if count > 0 {
			let mut written: i64 = 0;
			for &byte in &text[exp_at..exp_at + count] {
				written = written
					.saturating_mul(10)
					.saturating_add(i64::from(byte - b'0'));
			}
			exp = exp.saturating_add(if neg { -written } else { written });
			at = exp_at + count;
		}
	}
	let mut value = mant as f64;
	let mut left = exp.clamp(-3000, 3000) as i32;
	while left > 0 {
		let step = left.min(1000);
		value *= 2f64.powi(step);
		left -= step;
	}
	while left < 0 {
		let step = left.max(-1000);
		value *= 2f64.powi(step);
		left -= step;
	}
	(value, at)
}

/// C `%e %f %g %a` of a non-negative value (the caller adds the sign).
fn float(v: f64, conv: u8, alt: bool, prec: Option<usize>) -> String {
	let upper = conv.is_ascii_uppercase();
	let s = if v.is_nan() {
		"nan".to_owned()
	} else if v.is_infinite() {
		"inf".to_owned()
	} else {
		match conv.to_ascii_lowercase() {
			b'f' => {
				let p = prec.unwrap_or(6);
				let mut s = format!("{v:.p$}");
				if alt && p == 0 {
					s.push('.');
				}
				s
			},
			b'e' => exp(v, prec.unwrap_or(6), alt),
			b'g' => {
				let p = match prec {
					Some(0) => 1,
					Some(p) => p,
					None => 6,
				};
				let x = if v == 0.0 { 0 } else { exp_of(v, p) };
				let s = if x < -4 || x >= p as i32 {
					exp(v, p - 1, alt)
				} else {
					let fp = (p as i32 - 1 - x).max(0) as usize;
					let mut s = format!("{v:.fp$}");
					if alt && fp == 0 {
						s.push('.');
					}
					s
				};
				if alt { s } else { strip_zeros(&s) }
			},
			_ => hex_float_text(v, prec, alt),
		}
	};
	if upper { s.to_ascii_uppercase() } else { s }
}

/// Decimal exponent of `v` rounded to `p` significant digits.
fn exp_of(v: f64, p: usize) -> i32 {
	let s = format!("{v:.prec$e}", prec = p.saturating_sub(1));
	s.split_once('e')
		.and_then(|(_, e)| e.parse().ok())
		.unwrap_or(0)
}

/// `d.ddde±XX`.
fn exp(v: f64, prec: usize, alt: bool) -> String {
	let s = format!("{v:.prec$e}");
	let (mant, e) = s.split_once('e').unwrap_or((&s, "0"));
	let e: i32 = e.parse().unwrap_or(0);
	let mut out = String::from(mant);
	if alt && prec == 0 {
		out.push('.');
	}
	out.push('e');
	out.push(if e < 0 { '-' } else { '+' });
	let a = e.unsigned_abs();
	if a < 10 {
		out.push('0');
	}
	out.push_str(&a.to_string());
	out
}

/// `%g` without `#`: drop trailing fractional zeros and a bare point.
fn strip_zeros(s: &str) -> String {
	let (mant, e) = s.find('e').map_or((s, ""), |i| s.split_at(i));
	let mant = if mant.contains('.') {
		mant.trim_end_matches('0').trim_end_matches('.')
	} else {
		mant
	};
	format!("{mant}{e}")
}

/// `%a` of a finite non-negative double, normalized to `0x1.…p±e`
/// (subnormals too); with a precision the fraction is rounded to that
/// many hex digits (ties to even).
fn hex_float_text(v: f64, prec: Option<usize>, alt: bool) -> String {
	if v == 0.0 {
		let frac = prec.map_or_else(String::new, |p| "0".repeat(p));
		let point = if frac.is_empty() && !alt { "" } else { "." };
		return format!("0x0{point}{frac}p+0");
	}
	let bits = v.to_bits();
	let raw_exp = ((bits >> 52) & 0x7ff) as i32;
	let stored = bits & ((1u64 << 52) - 1);
	let (frac, mut e) = if raw_exp == 0 {
		// Subnormal: shift the leading 1 into the implicit position.
		let shift = stored.leading_zeros() as i32 - 11;
		((stored << shift) & ((1u64 << 52) - 1), -1022 - shift)
	} else {
		(stored, raw_exp - 1023)
	};
	let mut lead = 1u64;
	let digits = match prec {
		Some(p) if p < 13 => {
			let drop = 52 - 4 * p as u32;
			let kept = frac >> drop;
			let rest = frac & ((1u64 << drop) - 1);
			let half = 1u64 << (drop - 1);
			let mut kept = kept;
			if rest > half || (rest == half && kept & 1 == 1) {
				kept += 1;
			}
			if p == 0 {
				lead += kept;
				String::new()
			} else if kept >> (4 * p) != 0 {
				lead += 1;
				let low = kept & ((1u64 << (4 * p)) - 1);
				format!("{low:0p$x}")
			} else {
				format!("{kept:0p$x}")
			}
		},
		Some(p) => {
			let mut s = format!("{frac:013x}");
			s.push_str(&"0".repeat(p - 13));
			s
		},
		None => {
			let s = format!("{frac:013x}");
			s.trim_end_matches('0').to_owned()
		},
	};
	if lead == 2 {
		lead = 1;
		e += 1;
	}
	let point = if digits.is_empty() && !alt { "" } else { "." };
	format!("0x{lead}{point}{digits}p{}{}", if e < 0 { '-' } else { '+' }, e.unsigned_abs())
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::bash::vm::builtins::io::split_ref;

	fn esc(s: &str, for_b: bool) -> (Vec<u8>, usize, bool) {
		let mut out = Vec::new();
		let (n, c, _) = tescape(s.as_bytes(), for_b, locale::Charset::Utf8, &mut out);
		(out, n, c)
	}

	// Goldens: bash 5.3.20 `printf 'x\c'` keeps `\c`, `%b` stops at it;
	// `\0nnn` takes three digits after the 0 only in `%b`.
	#[test]
	fn escapes_follow_tescape() {
		assert_eq!(esc("c", false), (b"\\".to_vec(), 0, false));
		assert_eq!(esc("c", true), (Vec::new(), 1, true));
		assert_eq!(esc("1017", true), (b"A".to_vec(), 3, false));
		assert_eq!(esc("0101", true), (b"A".to_vec(), 4, false));
		assert_eq!(esc("0101", false), (b"\x08".to_vec(), 3, false));
		assert_eq!(esc("\"", true), (b"\\".to_vec(), 0, false));
		assert_eq!(esc("\"", false), (b"\"".to_vec(), 1, false));
		assert_eq!(esc("x41", false), (b"A".to_vec(), 3, false));
		assert_eq!(esc("xg", false), (b"\\".to_vec(), 0, false));
		assert_eq!(esc("u00e9", false), ("é".as_bytes().to_vec(), 5, false));
	}

	// Goldens: bash 5.3.20 `printf '%q %q %q %q %q %#q' '~a' 'a=~b' 'a:~' '#x'
	// 'x#' 'a b'`, `printf '%q' $'B\315' é` in C and UTF-8 locales.
	#[test]
	fn quoting_matches_bash() {
		let q = |s: &[u8], alt, utf8| String::from_utf8_lossy(&quote(s, alt, utf8)).into_owned();
		assert_eq!(q(b"~a", false, true), "\\~a");
		assert_eq!(q(b"a=~b", false, true), "a=\\~b");
		assert_eq!(q(b"a:~", false, true), "a:\\~");
		assert_eq!(q(b"#x", false, true), "\\#x");
		assert_eq!(q(b"x#", false, true), "x#");
		assert_eq!(q(b"a b", true, true), "'a b'");
		assert_eq!(q(b"no-quotes-needed", false, true), "no-quotes-needed");
		assert_eq!(q(b"quotes;needed", false, true), "quotes\\;needed");
		assert_eq!(q(b"B\xcd", false, true), "$'B\\315'");
		assert_eq!(q("é".as_bytes(), false, true), "é");
		assert_eq!(q("é".as_bytes(), false, false), "$'\\303\\251'");
		assert_eq!(q(b"a\x80", false, true), "$'a\\200'");
		assert_eq!(q(b"", false, true), "''");
	}

	#[test]
	fn integers_parse_like_strtoimax() {
		assert_eq!(strtonum(b" 12").signed(), (12, false));
		assert_eq!(strtonum(b"0x10").signed(), (16, false));
		assert_eq!(strtonum(b"010").signed(), (8, false));
		assert_eq!(strtonum(b"0x").end, 1);
		assert_eq!(strtonum(b"9223372036854775825").signed(), (i64::MAX, true));
		assert_eq!(strtonum(b"-9223372036854775815").signed(), (i64::MIN, true));
		assert_eq!(strtonum(b"-1").unsigned(), (u64::MAX, false));
		assert_eq!(strtonum(b"+").end, 0);
	}

	#[test]
	fn floats_parse_like_strtod() {
		assert_eq!(strtod(b"1.5x"), (1.5, 3, false));
		assert_eq!(strtod(b"1e3"), (1000.0, 3, false));
		assert_eq!(strtod(b"1e"), (1.0, 1, false));
		assert_eq!(strtod(b"0x1.8p1"), (3.0, 7, false));
		assert!(strtod(b"-inf").0.is_infinite());
		assert!(strtod(b"1e-320").2);
		assert_eq!(strtod(b"abc").1, 0);
	}

	// Goldens: bash 5.3.20 on macOS `printf '%e %g %G %#g %05.1f %-8.3e| %.0e
	// %#.0f %a %A %.2a %10.1a %a'`.
	#[test]
	fn float_conversions_match_c() {
		assert_eq!(float(0.0, b'e', false, None), "0.000000e+00");
		assert_eq!(float(1e100, b'g', false, None), "1e+100");
		assert_eq!(float(1e-10, b'G', false, None), "1E-10");
		assert_eq!(float(1.0, b'g', true, None), "1.00000");
		assert_eq!(float(2.345, b'f', false, Some(1)), "2.3");
		assert_eq!(float(12345.678, b'e', false, Some(3)), "1.235e+04");
		assert_eq!(float(5.0, b'e', false, Some(0)), "5e+00");
		assert_eq!(float(3.0, b'f', true, Some(0)), "3.");
		assert_eq!(float(1.0, b'a', false, None), "0x1p+0");
		assert_eq!(float(255.0, b'A', false, None), "0X1.FEP+7");
		assert_eq!(float(1.0, b'a', false, Some(2)), "0x1.00p+0");
		assert_eq!(float(3.3, b'a', false, Some(1)), "0x1.ap+1");
		assert_eq!(float(0.1, b'a', false, None), "0x1.999999999999ap-4");
		assert_eq!(float(1e-320, b'a', false, None), "0x1.fap-1064");
		assert_eq!(float(f64::INFINITY, b'f', false, None), "inf");
		assert_eq!(float(f64::NAN, b'F', false, None), "NAN");
	}

	#[test]
	fn references_split_into_name_and_subscript() {
		assert_eq!(split_ref(b"a"), Some((&b"a"[..], None)));
		assert_eq!(split_ref(b"a[1]"), Some((&b"a"[..], Some(&b"1"[..]))));
		assert_eq!(split_ref(b"invalid-var"), None);
		assert_eq!(split_ref(b"a[]"), None);
	}

	#[test]
	fn time_formats_nest_parentheses() {
		assert_eq!(time_format(b"%x (foo) %X)T rest"), Ok((&b"%x (foo) %X"[..], 13)));
		assert_eq!(time_format(b"abde)Z"), Err(b'Z'));
	}
}
