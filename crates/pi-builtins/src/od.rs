//! `od` builtin: dump files in octal and other formats.
//!
//! Ported from uutils coreutils 0.8.0.
//!
//! The clap model, legacy format flags, traditional `[+]OFFSET` operands, and
//! `-j`/`-N` size parsing follow uutils. Type decoding, column padding, input
//! skipping, and float rendering are implemented to match the reference output
//! byte for byte, which uutils does not reproduce.

use std::{
	ffi::OsString,
	io::{self, Read, Seek, Write},
};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{Arg, ArgAction, ArgMatches, Command, builder::ValueParser, parser::ValueSource};
use pi_vfs::File;
use uucore::{
	display::Quotable,
	parser::{
		parse_size::{ParseSizeError, Parser},
		shortcut_value_parser::ShortcutValueParser,
	},
};

use crate::host::{Host, Utility, format_usage, matches_parser, strip_errno, util};

mod options {
	pub const HELP: &str = "help";
	pub const ADDRESS_RADIX: &str = "address-radix";
	pub const SKIP_BYTES: &str = "skip-bytes";
	pub const READ_BYTES: &str = "read-bytes";
	pub const ENDIAN: &str = "endian";
	pub const STRINGS: &str = "strings";
	pub const FORMAT: &str = "format";
	pub const OUTPUT_DUPLICATES: &str = "output-duplicates";
	pub const TRADITIONAL: &str = "traditional";
	pub const WIDTH: &str = "width";
	pub const FILENAME: &str = "FILENAME";
}

/// Legacy single-letter format options: clap id, the `-t` spec it stands for,
/// and its help line (`None` for GNU's obsolescent, undocumented aliases).
const LEGACY_FORMATS: [(&str, &str, Option<&str>); 20] = [
	("a", "a", Some("same as -t a,  select named characters, ignoring high-order bit")),
	("B", "o2", None),
	("b", "o1", Some("same as -t o1, select octal bytes")),
	("c", "c", Some("same as -t c,  select printable characters or backslash escapes")),
	("D", "u4", None),
	("d", "u2", Some("same as -t u2, select unsigned decimal 2-byte units")),
	("e", "fD", None),
	("F", "fD", None),
	("f", "fF", Some("same as -t fF, select floats")),
	("H", "x4", None),
	("h", "x2", None),
	("I", "dL", None),
	("i", "dI", Some("same as -t dI, select decimal ints")),
	("L", "dL", None),
	("l", "dL", Some("same as -t dL, select decimal longs")),
	("O", "o4", None),
	("o", "o2", Some("same as -t o2, select octal 2-byte units")),
	("s", "d2", Some("same as -t d2, select decimal 2-byte units")),
	("X", "x4", None),
	("x", "x2", Some("same as -t x2, select hexadecimal 2-byte units")),
];

/// Options whose presence selects the modern operand syntax (GNU `modern`).
const MODERN_OPTIONS: [&str; 7] = [
	options::ADDRESS_RADIX,
	options::SKIP_BYTES,
	options::READ_BYTES,
	options::STRINGS,
	options::FORMAT,
	options::OUTPUT_DUPLICATES,
	options::WIDTH,
];

/// Size suffixes GNU `od` accepts for BYTES (`xstrtol` with `bEGKkMmPQRTYZ0`).
const BYTE_SUFFIXES: &[&str] = &[
	"b", "K", "KB", "KD", "KiB", "k", "kB", "kD", "kiB", "M", "MB", "MD", "MiB", "m", "mB", "mD", "miB", "G", "GB",
	"GD", "GiB", "T", "TB", "TD", "TiB", "P", "PB", "PD", "PiB", "E", "EB", "ED", "EiB", "Z", "ZB", "ZD", "ZiB", "Y",
	"YB", "YD", "YiB", "R", "RB", "RD", "RiB", "Q", "QB", "QD", "QiB",
];

const AFTER_HELP: &str = "\
If first and second call formats both apply, the second format is assumed
if the last operand begins with + or (if there are 2 operands) a digit.
An OFFSET operand means -j OFFSET.  LABEL is the pseudo-address
at first byte printed, incremented when dump is progressing.
For OFFSET and LABEL, a 0x or 0X prefix indicates hexadecimal;
suffixes may be . for octal and b for multiply by 512.

TYPE is made up of one or more of these specifications:
  a          named character, ignoring high-order bit
  c          printable character or backslash escape
  d[SIZE]    signed decimal, SIZE bytes per integer
  f[SIZE]    floating point, SIZE bytes per float
  o[SIZE]    octal, SIZE bytes per integer
  u[SIZE]    unsigned decimal, SIZE bytes per integer
  x[SIZE]    hexadecimal, SIZE bytes per integer

SIZE is a number.  For TYPE in [doux], SIZE may also be C for
sizeof(char), S for sizeof(short), I for sizeof(int) or L for
sizeof(long).  If TYPE is f, SIZE may also be B for Brain 16 bit,
H for Half precision float, F for sizeof(float), D for sizeof(double),
or L for sizeof(long double).

Adding a z suffix to any type displays printable characters at the end of
each output line.

BYTES is hex with 0x or 0X prefix, and may have a multiplier suffix:
  b    512
  KB   1000
  K    1024
  MB   1000*1000
  M    1024*1024
and so on for G, T, P, E, Z, Y, R, Q.
Binary prefixes can be used, too: KiB=K, MiB=M, and so on.";

const DEFAULT_BYTES_PER_BLOCK: i64 = 16;

fn uu_app() -> Command {
	let mut app = Command::new("od")
		.version("0.8.0")
		.about(
			"Write an unambiguous representation, octal bytes by default, of FILE to standard output.  With more \
			 than one FILE argument, concatenate them in the listed order to form the input.\n\nWith no FILE, or \
			 when FILE is -, read standard input.",
		)
		.override_usage(format_usage(
			"od [OPTION]... [FILE]...\nod [-abcdfilosx]... [FILE] [[+]OFFSET[.][b]]\nod --traditional [OPTION]... \
			 [FILE] [[+]OFFSET[.][b] [+][LABEL][.][b]]",
		))
		.after_help(AFTER_HELP)
		.infer_long_args(true)
		.args_override_self(true)
		// `-h` is a legacy format flag.
		.disable_help_flag(true)
		.arg(Arg::new(options::HELP).long(options::HELP).help("display this help and exit").action(ArgAction::Help))
		.arg(
			Arg::new(options::ADDRESS_RADIX)
				.short('A')
				.long(options::ADDRESS_RADIX)
				.allow_hyphen_values(true)
				.value_name("RADIX")
				.help("output format for file offsets; RADIX is one of [doxn], for Decimal, Octal, Hex or None"),
		)
		.arg(
			Arg::new(options::ENDIAN)
				.long(options::ENDIAN)
				.value_name("big|little")
				.value_parser(ShortcutValueParser::new(["big", "little"]))
				.help("swap input bytes according the specified order"),
		)
		.arg(
			Arg::new(options::SKIP_BYTES)
				.short('j')
				.long(options::SKIP_BYTES)
				.allow_hyphen_values(true)
				.value_name("BYTES")
				.help("skip BYTES input bytes first"),
		)
		.arg(
			Arg::new(options::READ_BYTES)
				.short('N')
				.long(options::READ_BYTES)
				.allow_hyphen_values(true)
				.value_name("BYTES")
				.help("limit dump to BYTES input bytes"),
		)
		.arg(
			Arg::new(options::STRINGS)
				.short('S')
				.long(options::STRINGS)
				.value_name("BYTES")
				.num_args(0..=1)
				.default_missing_value("3")
				.help("show only NUL terminated strings of at least BYTES (default 3) printable characters"),
		)
		.arg(
			Arg::new(options::FORMAT)
				.short('t')
				.long(options::FORMAT)
				.allow_hyphen_values(true)
				.value_name("TYPE")
				.action(ArgAction::Append)
				.help("select output format or formats"),
		)
		.arg(
			Arg::new(options::OUTPUT_DUPLICATES)
				.short('v')
				.long(options::OUTPUT_DUPLICATES)
				.action(ArgAction::SetTrue)
				.help("do not use * to mark line suppression"),
		)
		.arg(
			Arg::new(options::WIDTH)
				.short('w')
				.long(options::WIDTH)
				.value_name("BYTES")
				.num_args(0..=1)
				.default_missing_value("32")
				.help("output BYTES bytes per output line; 32 is implied when BYTES is not specified"),
		)
		.arg(
			Arg::new(options::TRADITIONAL)
				.long(options::TRADITIONAL)
				.action(ArgAction::SetTrue)
				.help("accept arguments in third form above"),
		)
		.arg(
			Arg::new(options::FILENAME)
				.hide(true)
				.action(ArgAction::Append)
				.value_parser(ValueParser::os_string())
				.value_hint(clap::ValueHint::FilePath),
		);
	// Each occurrence records its spec and argv index, so formats accumulate
	// in command-line order alongside `-t`.
	for (id, spec, help) in LEGACY_FORMATS {
		let short = id.chars().next().unwrap_or_default();
		let arg = Arg::new(id).short(short).action(ArgAction::Append).num_args(0).default_missing_value(spec);
		app = app.arg(match help {
			Some(help) => arg.help(help),
			None => arg.hide(true),
		});
	}
	app
}

/// Parsed `od` invocation.
pub(crate) struct Od {
	matches: ArgMatches,
}

matches_parser!(Od, uu_app);

impl Utility for Od {
	const NAME: &'static str = "od";

	fn run(self, host: &mut Host) -> i32 {
		let mut out = host.stdout_writer();
		let code = match run_od(host, &mut out, &self.matches) {
			Ok(code) | Err(code) => code,
		};
		if let Err(err) = out.flush() {
			if err.kind() == io::ErrorKind::BrokenPipe {
				return crate::host::SIGPIPE_EXIT_CODE;
			}
			host.error(format!("write error: {}", strip_errno(&err)), 1);
			return 1;
		}
		code
	}
}

/// Creates the `od` builtin registration.
pub(crate) fn od_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Od, SE>()
}

// ── Numbers ────────────────────────────────────────────────────────────────

/// Parses a BYTES argument of `option` (`-j`, `-N`, `-S`): decimal, `0`
/// octal, or `0x` hex, with GNU's multiplier suffixes, at most `i64::MAX`.
fn parse_bytes(value: &str, option: &str) -> Result<i64, String> {
	let hex;
	let text = match value.strip_prefix("0X") {
		Some(rest) => {
			hex = format!("0x{rest}");
			hex.as_str()
		},
		None => value,
	};
	let parsed = Parser::default().with_allow_list(BYTE_SUFFIXES).parse(text);
	match parsed {
		Ok(n) => i64::try_from(n).map_err(|_| format!("{option} argument {} too large", value.quote())),
		Err(ParseSizeError::SizeTooBig(_)) => Err(format!("{option} argument {} too large", value.quote())),
		// A leading digit always parses as a number in GNU, so what follows
		// it (`08`, `0x`) is a bad suffix.
		Err(ParseSizeError::InvalidSuffix(_)) => Err(format!("invalid suffix in {option} argument {}", value.quote())),
		Err(_) if value.starts_with(|c: char| c.is_ascii_digit()) => {
			Err(format!("invalid suffix in {option} argument {}", value.quote()))
		},
		Err(_) => Err(format!("invalid {option} argument {}", value.quote())),
	}
}

/// Parses `-w`'s BYTES: GNU reads it as plain decimal without suffixes, a
/// grammar `parse_size` (octal on a leading `0`, suffixes) cannot express.
fn parse_width(value: &str) -> Result<i64, String> {
	let digits = value.bytes().take_while(u8::is_ascii_digit).count();
	if digits == 0 {
		return Err(format!("invalid -w argument {}", value.quote()));
	}
	if digits < value.len() {
		return Err(format!("invalid suffix in -w argument {}", value.quote()));
	}
	match value.parse::<i64>() {
		Ok(0) => Err(format!("invalid -w argument {}", value.quote())),
		Ok(n) => Ok(n),
		Err(_) => Err(format!("-w argument {} too large", value.quote())),
	}
}

/// Parses a traditional `[+]OFFSET[.][b]` operand (uutils
/// `parse_offset_operand`, with GNU's radix rules): octal by default, decimal
/// with a `.`, hex with `0x`; `b` multiplies by 512 and `B` by 1024.
/// `Ok(None)` when `arg` is not an offset; `Err` when it overflows.
fn parse_offset_operand(arg: &str) -> Result<Option<i64>, ()> {
	let s = arg.strip_prefix('+').unwrap_or(arg);
	if !s.starts_with(|c: char| c.is_ascii_digit()) {
		return Ok(None);
	}
	let decimal = s.find('.').filter(|&dot| matches!(&s[dot + 1..], "" | "b" | "B"));
	let text = match decimal {
		Some(dot) => format!("{}{}", &s[..dot], &s[dot + 1..]),
		None => s.to_owned(),
	};
	let (digits, radix) = match text.strip_prefix("0x").or_else(|| text.strip_prefix("0X")) {
		Some(hex) if decimal.is_none() => (hex, 16),
		_ => (text.as_str(), if decimal.is_some() { 10 } else { 8 }),
	};
	let len = digits.find(|c: char| !c.is_digit(radix)).unwrap_or(digits.len());
	let multiplier: u64 = match &digits[len..] {
		"" => 1,
		"b" => 512,
		"B" => 1024,
		_ => return Ok(None),
	};
	if len == 0 {
		return Ok(None);
	}
	u64::from_str_radix(&digits[..len], radix)
		.ok()
		.and_then(|n| n.checked_mul(multiplier))
		.and_then(|n| i64::try_from(n).ok())
		.map(Some)
		.ok_or(())
}

// ── Format specs ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
	Signed,
	Unsigned,
	Octal,
	Hex,
	Half,
	Brain,
	Float,
	Double,
	Named,
	Char,
}

#[derive(Debug, Clone)]
struct Spec {
	kind:  Kind,
	size:  usize,
	width: i64,
	pad:   i64,
	z:     bool,
}

/// Decodes one `-t` argument (GNU `decode_format_string`), appending to
/// `specs`; `Err` is the diagnostic without the `od: ` prefix.
///
/// Kept from GNU rather than uutils `parse_type_string`: sizes follow this
/// platform's C types (`fL` is `double` here, 16-byte types are rejected) and
/// the diagnostics are GNU's.
fn decode_format(arg: &str, specs: &mut Vec<Spec>) -> Result<(), String> {
	let quoted = arg.quote();
	let mut s = arg.as_bytes();
	while let Some(&c) = s.split_off_first() {
		let (kind, size, width) = match c {
			b'd' | b'o' | b'u' | b'x' => {
				let size = match s.first() {
					Some(b'C') => 1,
					Some(b'S') => 2,
					Some(b'I') => 4,
					Some(b'L') => 8,
					_ => 0,
				};
				let size = if size != 0 {
					s = &s[1..];
					size
				} else {
					match leading_int(s) {
						None => return Err(format!("invalid type string {}", quoted)),
						Some((0, 0)) => 4,
						Some((n, len)) => {
							if !matches!(n, 1 | 2 | 4 | 8) {
								return Err(format!(
									"invalid type string {};\nthis system doesn't provide a {n}-byte integral type",
									quoted
								));
							}
							s = &s[len..];
							n as usize
						},
					}
				};
				let bits = 8 * size as i64;
				let (kind, width) = match c {
					b'd' => (Kind::Signed, bits_strlen(bits - 1) + 1),
					b'o' => (Kind::Octal, (bits + 2) / 3),
					b'u' => (Kind::Unsigned, bits_strlen(bits)),
					_ => (Kind::Hex, (bits + 3) / 4),
				};
				(kind, size, width)
			},
			b'f' => {
				let letter = match s.first() {
					Some(b'B') => Some((Kind::Brain, 2)),
					Some(b'H') => Some((Kind::Half, 2)),
					Some(b'F') => Some((Kind::Float, 4)),
					Some(b'D' | b'L') => Some((Kind::Double, 8)),
					_ => None,
				};
				let (kind, size) = match letter {
					Some(found) => {
						s = &s[1..];
						found
					},
					None => match leading_int(s) {
						None => return Err(format!("invalid type string {}", quoted)),
						Some((0, 0)) => (Kind::Double, 8),
						Some((n, len)) => {
							let kind = match n {
								2 => Kind::Half,
								4 => Kind::Float,
								8 => Kind::Double,
								_ => {
									return Err(format!(
										"invalid type string {};\nthis system doesn't provide a {n}-byte floating point type",
										quoted
									));
								},
							};
							s = &s[len..];
							(kind, n as usize)
						},
					},
				};
				let width = match kind {
					Kind::Double => 24,
					_ => 15,
				};
				(kind, size, width)
			},
			b'a' => (Kind::Named, 1, 3),
			b'c' => (Kind::Char, 1, 3),
			_ => {
				let c = String::from_utf8_lossy(&[c]).into_owned();
				return Err(format!("invalid character '{c}' in type string {quoted}"));
			},
		};
		let z = s.first() == Some(&b'z');
		if z {
			s = &s[1..];
		}
		specs.push(Spec { kind, size, width, pad: 0, z });
	}
	Ok(())
}

/// GNU `simple_strtoi`: `Some((value, digits))`, `None` on `int` overflow.
fn leading_int(s: &[u8]) -> Option<(i64, usize)> {
	let mut sum: i64 = 0;
	let mut len = 0;
	for &c in s.iter().take_while(|c| c.is_ascii_digit()) {
		sum = sum * 10 + i64::from(c - b'0');
		if sum > i64::from(i32::MAX) {
			return None;
		}
		len += 1;
	}
	Some((sum, len))
}

/// `INT_BITS_STRLEN_BOUND`: decimal digits needed for `bits` bits.
const fn bits_strlen(bits: i64) -> i64 {
	(bits * 146 + 484) / 485
}

// ── Value rendering ────────────────────────────────────────────────────────

const fn is_print(c: u8) -> bool {
	matches!(c, 0x20..=0x7e)
}

const CHARNAME: [&str; 33] = [
	"nul", "soh", "stx", "etx", "eot", "enq", "ack", "bel", "bs", "ht", "nl", "vt", "ff", "cr", "so", "si", "dle",
	"dc1", "dc2", "dc3", "dc4", "nak", "syn", "etb", "can", "em", "sub", "esc", "fs", "gs", "rs", "us", "sp",
];

/// C `%.{prec}g` without `#`.
///
/// Not uucore's `num_format::Float` (`FloatVariant::Shortest`): it rounds
/// exact ties away from zero (`3.39453125` → `3.3945313` at 8 digits) where C
/// rounds them to even (`3.3945312`), which `-tfH`/`-tfB` hit constantly.
/// Rust's `{:.*e}` rounds the exact binary value half-to-even, like glibc.
fn format_g(x: f64, prec: usize) -> String {
	if x.is_nan() {
		// glibc spells a negative NaN `-nan`; other C libraries drop the sign.
		return if x.is_sign_negative() && cfg!(target_os = "linux") { "-nan".into() } else { "nan".into() };
	}
	if x.is_infinite() {
		return if x < 0.0 { "-inf".into() } else { "inf".into() };
	}
	if x == 0.0 {
		return if x.is_sign_negative() { "-0".into() } else { "0".into() };
	}
	let prec = prec.max(1);
	let sci = format!("{:.*e}", prec - 1, x);
	let (mantissa, exp) = sci.split_once('e').unwrap_or((&sci, "0"));
	let exp: i64 = exp.parse().unwrap_or(0);
	let strip = |text: &str| -> String {
		if text.contains('.') {
			text.trim_end_matches('0').trim_end_matches('.').to_owned()
		} else {
			text.to_owned()
		}
	};
	if exp < -4 || exp >= prec as i64 {
		let sign = if exp < 0 { '-' } else { '+' };
		format!("{}e{sign}{:02}", strip(mantissa), exp.abs())
	} else {
		strip(&format!("{:.*}", (prec as i64 - 1 - exp) as usize, x))
	}
}

/// gnulib `ftoastr`/`dtoastr`: the shortest `%g` that reads back exactly.
/// uutils pads fixed precisions instead, so its float columns differ from GNU.
fn float_to_str(x: f64, single: bool) -> String {
	let (min, dig, bound) = if single { (f64::from(f32::MIN_POSITIVE), 6, 9) } else { (f64::MIN_POSITIVE, 15, 17) };
	let mut prec = if x.abs() < min { 1 } else { dig };
	loop {
		let text = format_g(x, prec);
		let exact = if single {
			text.parse::<f32>().is_ok_and(|back| f64::from(back) == x)
		} else {
			text.parse::<f64>().is_ok_and(|back| back == x)
		};
		if exact || prec >= bound {
			return text;
		}
		prec += 1;
	}
}

fn half_to_f32(bits: u16) -> f32 {
	let sign = if bits & 0x8000 != 0 { -1.0 } else { 1.0 };
	let exp = i32::from((bits >> 10) & 0x1f);
	let mant = f32::from(bits & 0x3ff);
	match exp {
		0 => sign * mant * 2f32.powi(-24),
		31 if mant == 0.0 => sign * f32::INFINITY,
		31 => f32::from_bits(u32::from(bits & 0x8000) << 16 | 0x7fc0_0000 | (u32::from(bits & 0x3ff) << 13)),
		_ => sign * (1.0 + mant / 1024.0) * 2f32.powi(exp - 15),
	}
}

/// Renders one datum of `spec` starting at `bytes`.
fn render(spec: &Spec, bytes: &[u8], big_endian: bool, text: &mut String) {
	use std::fmt::{NumBuffer, Write as _};
	let raw = if big_endian {
		bytes.iter().fold(0u64, |acc, &b| acc << 8 | u64::from(b))
	} else {
		bytes.iter().rev().fold(0u64, |acc, &b| acc << 8 | u64::from(b))
	};
	let width = spec.width as usize;
	text.clear();
	let _ = match spec.kind {
		Kind::Signed => {
			let shift = 64 - 8 * spec.size;
			text.write_str((((raw << shift) as i64) >> shift).format_into(&mut NumBuffer::new()))
		},
		Kind::Unsigned => text.write_str(raw.format_into(&mut NumBuffer::new())),
		Kind::Octal => write!(text, "{raw:0width$o}"),
		Kind::Hex => write!(text, "{raw:0width$x}"),
		Kind::Half => write!(text, "{}", float_to_str(f64::from(half_to_f32(raw as u16)), true)),
		Kind::Brain => write!(text, "{}", float_to_str(f64::from(f32::from_bits((raw as u32) << 16)), true)),
		Kind::Float => write!(text, "{}", float_to_str(f64::from(f32::from_bits(raw as u32)), true)),
		Kind::Double => write!(text, "{}", float_to_str(f64::from_bits(raw), false)),
		Kind::Named => {
			let c = bytes[0] & 0x7f;
			match c {
				127 => text.write_str("del"),
				0..=0x20 => text.write_str(CHARNAME[usize::from(c)]),
				_ => text.write_char(char::from(c)),
			}
		},
		Kind::Char => match bytes[0] {
			0 => text.write_str("\\0"),
			7 => text.write_str("\\a"),
			8 => text.write_str("\\b"),
			0x0c => text.write_str("\\f"),
			b'\n' => text.write_str("\\n"),
			b'\r' => text.write_str("\\r"),
			b'\t' => text.write_str("\\t"),
			0x0b => text.write_str("\\v"),
			c if is_print(c) => text.write_char(char::from(c)),
			c => write!(text, "{c:03o}"),
		},
	};
}

/// Total padding before field `i` of `fields` (GNU `pad_at`).
const fn pad_at(fields: i64, i: i64, pad: i64) -> i64 {
	pad / fields * i + (pad % fields) * i / fields
}

// ── Addresses ──────────────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq)]
enum AddrStyle {
	None,
	Std,
	Paren,
	Label,
}

struct Addr {
	style:         AddrStyle,
	base:          u32,
	pad:           usize,
	pseudo_offset: i64,
}

impl Addr {
	fn std(&self, out: &mut Vec<u8>, address: i64) {
		let digits = match self.base {
			10 => format!("{address:0width$}", width = self.pad),
			16 => format!("{address:0width$x}", width = self.pad),
			_ => format!("{address:0width$o}", width = self.pad),
		};
		out.extend_from_slice(digits.as_bytes());
	}

	/// GNU `format_address`; `c == 0` appends nothing. `Err` when the
	/// pseudo-address overflows.
	fn write(&self, out: &mut Vec<u8>, address: i64, c: u8) -> Result<(), ()> {
		match self.style {
			AddrStyle::None => return Ok(()),
			AddrStyle::Std => self.std(out, address),
			AddrStyle::Paren => {
				out.push(b'(');
				self.std(out, address);
				out.push(b')');
			},
			AddrStyle::Label => {
				self.std(out, address);
				out.extend_from_slice(b" (");
				self.std(out, address.checked_add(self.pseudo_offset).ok_or(())?);
				out.push(b')');
			},
		}
		if c != 0 {
			out.push(c);
		}
		Ok(())
	}
}

// ── Input ──────────────────────────────────────────────────────────────────

enum Source {
	Stdin,
	File(File),
	Dir,
}

/// The concatenation of the operand files (GNU `file_list`/`in_stream`).
struct Inputs {
	names:    Vec<OsString>,
	next:     usize,
	current:  Option<Source>,
	name:     OsString,
	buffered: bool,
	buf:      Vec<u8>,
	pos:      usize,
	len:      usize,
	/// Pending read error for the current file, reported on close.
	error:    Option<io::Error>,
}

impl Inputs {
	fn display(&self) -> String {
		if self.name == "-" { "standard input".to_owned() } else { self.name.maybe_quote().to_string() }
	}

	/// GNU `open_next_file`.
	fn open_next(&mut self, host: &mut Host) -> bool {
		let mut ok = true;
		while self.current.is_none() {
			let Some(name) = self.names.get(self.next).cloned() else { return ok };
			self.next += 1;
			self.name = name;
			self.pos = 0;
			self.len = 0;
			if self.name == "-" {
				self.current = Some(Source::Stdin);
				continue;
			}
			let path = host.resolve(&self.name);
			if host.fs().is_dir(&path) {
				self.current = Some(Source::Dir);
				continue;
			}
			match host.fs().open(&path) {
				Ok(file) => self.current = Some(Source::File(file)),
				Err(err) => {
					host.error(format!("{}: {}", self.display(), strip_errno(&err)), 1);
					ok = false;
				},
			}
		}
		ok
	}

	/// GNU `check_and_close`.
	fn close(&mut self, host: &mut Host) -> bool {
		self.current = None;
		self.pos = 0;
		self.len = 0;
		match self.error.take() {
			Some(err) => {
				host.error(format!("{}: {}", self.display(), strip_errno(&err)), 1);
				false
			},
			None => true,
		}
	}

	fn raw_read(&mut self, host: &mut Host, dst: &mut [u8]) -> io::Result<usize> {
		match self.current.as_mut() {
			Some(Source::Stdin) => host.stdin.read(dst),
			Some(Source::File(file)) => file.read(dst),
			Some(Source::Dir) => Err(io::Error::from_raw_os_error(libc::EISDIR)),
			None => Ok(0),
		}
	}

	/// Reads from the current file only; `0` means EOF or error.
	fn read(&mut self, host: &mut Host, dst: &mut [u8]) -> usize {
		if self.pos == self.len && self.buffered && dst.len() < 8192 {
			if self.buf.is_empty() {
				self.buf.resize(64 * 1024, 0);
			}
			let mut buf = std::mem::take(&mut self.buf);
			let n = self.read_retry(host, &mut buf);
			self.buf = buf;
			self.pos = 0;
			self.len = n;
		}
		if self.pos < self.len {
			let n = dst.len().min(self.len - self.pos);
			dst[..n].copy_from_slice(&self.buf[self.pos..self.pos + n]);
			self.pos += n;
			return n;
		}
		self.read_retry(host, dst)
	}

	fn read_retry(&mut self, host: &mut Host, dst: &mut [u8]) -> usize {
		loop {
			match self.raw_read(host, dst) {
				Ok(n) => return n,
				Err(err) if err.kind() == io::ErrorKind::Interrupted => {},
				Err(err) => {
					self.error = Some(err);
					return 0;
				},
			}
		}
	}

	/// GNU `read_block`: fills up to `dst.len()` bytes across files.
	fn read_block(&mut self, host: &mut Host, dst: &mut [u8]) -> (usize, bool) {
		let mut ok = true;
		let mut filled = 0;
		while self.current.is_some() {
			while filled < dst.len() {
				let n = self.read(host, &mut dst[filled..]);
				if n == 0 {
					break;
				}
				filled += n;
			}
			if filled == dst.len() {
				break;
			}
			ok &= self.close(host);
			ok &= self.open_next(host);
		}
		(filled, ok)
	}

	/// GNU `read_char`.
	fn read_char(&mut self, host: &mut Host) -> (Option<u8>, bool) {
		let mut ok = true;
		let mut byte = [0u8];
		while self.current.is_some() {
			if self.read(host, &mut byte) == 1 {
				return (Some(byte[0]), ok);
			}
			ok &= self.close(host);
			ok &= self.open_next(host);
		}
		(None, ok)
	}

	/// GNU `skip`; `Err` means the combined input is too short.
	fn skip(&mut self, host: &mut Host, mut n: i64) -> Result<bool, ()> {
		let mut ok = true;
		if n == 0 {
			return Ok(true);
		}
		while self.current.is_some() {
			if let Some(Source::File(file)) = self.current.as_mut()
				&& let Ok(meta) = file.metadata()
				&& meta.is_file()
			{
				let size = i64::try_from(meta.len()).unwrap_or(i64::MAX);
				if size < n {
					n -= size;
				} else {
					if let Err(err) = file.seek_relative(n) {
						self.error = Some(err);
					}
					n = 0;
				}
			} else {
				let mut scratch = [0u8; 8192];
				while n > 0 {
					let want = scratch.len().min(n as usize);
					let got = self.read(host, &mut scratch[..want]);
					if got == 0 {
						if self.error.is_some() {
							n = 0;
						}
						break;
					}
					n -= got as i64;
				}
			}
			if n == 0 {
				break;
			}
			ok &= self.close(host);
			ok &= self.open_next(host);
		}
		if n != 0 {
			return Err(());
		}
		Ok(ok)
	}
}

// ── Option handling ────────────────────────────────────────────────────────

struct Config {
	specs:        Vec<Spec>,
	addr:         Addr,
	skip:         i64,
	end_offset:   i64,
	abbreviate:   bool,
	strings:      Option<i64>,
	desired:      i64,
	swap:         bool,
	files:        Vec<OsString>,
	pseudo_start: Option<i64>,
}

/// The file operands, possibly with a traditional offset and label (uutils
/// `CommandLineInputs`).
#[derive(Debug, PartialEq, Eq)]
enum CommandLineInputs {
	FileNames(Vec<OsString>),
	FileAndOffset(Option<OsString>, i64, Option<i64>),
}

/// Overflowing offset operand; GNU reports it with `ERANGE` text.
fn offset_operand(arg: &OsString) -> Result<Option<i64>, String> {
	match arg.to_str() {
		Some(text) => parse_offset_operand(text)
			.map_err(|()| format!("{}: {}", arg.maybe_quote(), strip_errno(&io::Error::from_raw_os_error(libc::ERANGE)))),
		None => Ok(None),
	}
}

/// Interprets the operands (uutils `parse_inputs`, with GNU's selection
/// rules): without modern options, a last operand starting with `+` (or, of
/// two, a digit) is an offset; `--traditional` also takes a label.
fn parse_inputs(matches: &ArgMatches, mut inputs: Vec<OsString>) -> Result<CommandLineInputs, String> {
	let traditional = matches.get_flag(options::TRADITIONAL);
	let modern = MODERN_OPTIONS.iter().any(|id| matches.value_source(id) == Some(ValueSource::CommandLine));
	if modern && !traditional {
		return Ok(CommandLineInputs::FileNames(inputs));
	}
	let leads = |arg: &OsString, digit: bool| {
		arg.to_str().and_then(|s| s.bytes().next()).is_some_and(|c| c == b'+' || (digit && c.is_ascii_digit()))
	};
	match inputs.len() {
		1 if (traditional || leads(&inputs[0], false)) && let Some(offset) = offset_operand(&inputs[0])? => {
			return Ok(CommandLineInputs::FileAndOffset(None, offset, None));
		},
		2 if (traditional || leads(&inputs[1], true)) && let Some(offset) = offset_operand(&inputs[1])? => {
			if traditional && let Some(start) = offset_operand(&inputs[0])? {
				return Ok(CommandLineInputs::FileAndOffset(None, start, Some(offset)));
			}
			inputs.truncate(1);
			return Ok(CommandLineInputs::FileAndOffset(inputs.pop(), offset, None));
		},
		3 if traditional
			&& let Some(offset) = offset_operand(&inputs[1])?
			&& let Some(label) = offset_operand(&inputs[2])? =>
		{
			inputs.truncate(1);
			return Ok(CommandLineInputs::FileAndOffset(inputs.pop(), offset, Some(label)));
		},
		_ => {},
	}
	Ok(CommandLineInputs::FileNames(inputs))
}

fn run_od(host: &mut Host, out: &mut impl Write, matches: &ArgMatches) -> Result<i32, i32> {
	let fail = |host: &mut Host, message: String| {
		host.error(message, 1);
		1
	};
	let mut cfg = Config {
		specs:        Vec::new(),
		addr:         Addr { style: AddrStyle::Std, base: 8, pad: 7, pseudo_offset: 0 },
		skip:         0,
		end_offset:   -1,
		abbreviate:   !matches.get_flag(options::OUTPUT_DUPLICATES),
		strings:      None,
		desired:      0,
		swap:         false,
		files:        Vec::new(),
		pseudo_start: None,
	};

	// `-t` values and legacy flags accumulate in command-line order.
	let mut formats: Vec<(usize, &String)> = Vec::new();
	for id in std::iter::once(options::FORMAT).chain(LEGACY_FORMATS.iter().map(|(id, ..)| *id)) {
		if let (Some(indices), Some(values)) = (matches.indices_of(id), matches.get_many::<String>(id)) {
			formats.extend(indices.zip(values));
		}
	}
	formats.sort_unstable_by_key(|&(index, _)| index);
	let mut ok = true;
	for (_, format) in formats {
		if let Err(message) = decode_format(format, &mut cfg.specs) {
			host.error(message, 1);
			ok = false;
		}
	}
	if !ok {
		return Err(1);
	}

	if let Some(radix) = matches.get_one::<String>(options::ADDRESS_RADIX) {
		let first = radix.chars().next().unwrap_or('\0');
		let (style, base, pad) = match first {
			'd' => (AddrStyle::Std, 10, 7),
			'o' => (AddrStyle::Std, 8, 7),
			'x' => (AddrStyle::Std, 16, 6),
			'n' => (AddrStyle::None, 8, 0),
			_ => {
				return Err(fail(
					host,
					format!("invalid output address radix '{first}'; it must be one character from [doxn]"),
				));
			},
		};
		cfg.addr = Addr { style, base, pad, pseudo_offset: 0 };
	}
	if let Some(value) = matches.get_one::<String>(options::SKIP_BYTES) {
		cfg.skip = parse_bytes(value, "-j").map_err(|message| fail(host, message))?;
	}
	let max_bytes = match matches.get_one::<String>(options::READ_BYTES) {
		Some(value) => parse_bytes(value, "-N").map_err(|message| fail(host, message))?,
		None => -1,
	};
	if let Some(value) = matches.get_one::<String>(options::STRINGS) {
		let min = parse_bytes(value, "-S").map_err(|message| fail(host, message))?;
		// GNU allocates `min + 1` bytes.
		if min == i64::MAX {
			return Err(fail(host, format!("-S argument {} too large", value.quote())));
		}
		cfg.strings = Some(min);
	}
	if let Some(value) = matches.get_one::<String>(options::WIDTH) {
		cfg.desired = parse_width(value).map_err(|message| fail(host, message))?;
	}
	if let Some(endian) = matches.get_one::<String>(options::ENDIAN) {
		cfg.swap = (endian == "big") != cfg!(target_endian = "big");
	}
	if cfg.strings.is_some() && !cfg.specs.is_empty() {
		return Err(fail(host, "no type may be specified when dumping strings".to_owned()));
	}

	let operands = matches.get_many::<OsString>(options::FILENAME).into_iter().flatten().cloned().collect();
	match parse_inputs(matches, operands).map_err(|message| fail(host, message))? {
		CommandLineInputs::FileNames(files) => {
			if matches.get_flag(options::TRADITIONAL) && files.len() > 1 {
				let message = format_args!(
					"extra operand {}\nod: compatibility mode supports at most one file",
					files[1].quote()
				);
				return Err(host.usage_error(message, 1));
			}
			cfg.files = files;
		},
		CommandLineInputs::FileAndOffset(file, offset, label) => {
			cfg.files.extend(file);
			cfg.skip = offset;
			cfg.pseudo_start = label;
		},
	}

	if cfg.pseudo_start.is_some() {
		if cfg.addr.style == AddrStyle::None {
			cfg.addr = Addr { style: AddrStyle::Paren, base: 8, pad: 7, pseudo_offset: 0 };
		} else {
			cfg.addr.style = AddrStyle::Label;
		}
	}
	if max_bytes >= 0 {
		match cfg.skip.checked_add(max_bytes) {
			Some(end) => cfg.end_offset = end,
			None => {
				host.error("skip-bytes + read-bytes is too large", 1);
				return Err(1);
			},
		}
	}
	if cfg.specs.is_empty() {
		let _ = decode_format("oS", &mut cfg.specs);
	}
	if cfg.files.is_empty() {
		cfg.files.push(OsString::from("-"));
	}

	let mut inputs = Inputs {
		names:    std::mem::take(&mut cfg.files),
		next:     0,
		current:  None,
		name:     OsString::new(),
		buffered: cfg.end_offset < 0 || cfg.strings.is_some(),
		buf:      Vec::new(),
		pos:      0,
		len:      0,
		error:    None,
	};
	let mut ok = inputs.open_next(host);
	if inputs.current.is_none() {
		return Ok(i32::from(!ok));
	}
	match inputs.skip(host, cfg.skip) {
		Ok(skipped) => ok &= skipped,
		Err(()) => {
			host.error("cannot skip past end of combined input", 1);
			return Err(1);
		},
	}
	if inputs.current.is_none() {
		return Ok(i32::from(!ok));
	}
	cfg.addr.pseudo_offset = cfg.pseudo_start.map_or(0, |start| start - cfg.skip);

	let ok = if let Some(min) = cfg.strings {
		ok & dump_strings(host, out, &mut inputs, &cfg, min)?
	} else {
		ok & dump(host, out, &mut inputs, &mut cfg)?
	};
	Ok(i32::from(!ok))
}

fn lcm_of(specs: &[Spec]) -> i64 {
	fn gcd(a: i64, b: i64) -> i64 {
		if b == 0 { a } else { gcd(b, a % b) }
	}
	specs.iter().fold(1, |l, spec| {
		let size = spec.size as i64;
		l / gcd(l, size) * size
	})
}

fn emit(host: &mut Host, out: &mut impl Write, line: &mut Vec<u8>) -> Result<(), i32> {
	let result = out.write_all(line);
	line.clear();
	match result {
		Ok(()) => Ok(()),
		Err(err) if err.kind() == io::ErrorKind::BrokenPipe => Err(crate::host::SIGPIPE_EXIT_CODE),
		Err(err) => {
			host.error(format!("write error: {}", strip_errno(&err)), 1);
			Err(1)
		},
	}
}

fn pseudo_overflow(host: &mut Host) -> i32 {
	host.error("pseudo address too large for input", 1);
	1
}

struct BlockWriter {
	first:           bool,
	prev_pair_equal: bool,
	big_endian:      bool,
	bytes_per_block: usize,
	field:           String,
}

impl BlockWriter {
	/// GNU `write_block`.
	fn write(
		&mut self,
		cfg: &Config,
		line: &mut Vec<u8>,
		offset: i64,
		n_bytes: usize,
		prev: &[u8],
		curr: &[u8],
	) -> Result<(), ()> {
		let bpb = self.bytes_per_block;
		if cfg.abbreviate && !self.first && n_bytes == bpb && prev[..bpb] == curr[..bpb] {
			if !self.prev_pair_equal {
				line.extend_from_slice(b"*\n");
				self.prev_pair_equal = true;
			}
		} else {
			self.prev_pair_equal = false;
			for (i, spec) in cfg.specs.iter().enumerate() {
				let fields = (bpb / spec.size) as i64;
				let blank = ((bpb - n_bytes) / spec.size) as i64;
				if i == 0 {
					cfg.addr.write(line, offset, 0)?;
				} else {
					line.resize(line.len() + cfg.addr.pad, b' ');
				}
				let mut pad_remaining = spec.pad;
				let mut index = fields;
				let mut at = 0;
				while blank < index {
					let next_pad = pad_at(fields, index - 1, spec.pad);
					let width = (pad_remaining - next_pad + spec.width) as usize;
					render(spec, &curr[at..at + spec.size], self.big_endian, &mut self.field);
					let _ = write!(line, "{:>width$}", self.field);
					at += spec.size;
					pad_remaining = next_pad;
					index -= 1;
				}
				if spec.z {
					let fill = blank * spec.width + pad_at(fields, blank, spec.pad);
					line.resize(line.len() + fill as usize, b' ');
					line.extend_from_slice(b"  >");
					line.extend(curr[..n_bytes].iter().map(|&c| if is_print(c) { c } else { b'.' }));
					line.push(b'<');
				}
				line.push(b'\n');
			}
		}
		self.first = false;
		Ok(())
	}
}

/// GNU `dump`.
fn dump(host: &mut Host, out: &mut impl Write, inputs: &mut Inputs, cfg: &mut Config) -> Result<bool, i32> {
	let l_c_m = lcm_of(&cfg.specs);
	let bytes_per_block = if cfg.desired != 0 {
		if cfg.desired % l_c_m == 0 {
			cfg.desired
		} else {
			let _ = writeln!(host.stderr, "od: warning: invalid width {}; using {l_c_m} instead", cfg.desired);
			l_c_m
		}
	} else if l_c_m < DEFAULT_BYTES_PER_BLOCK {
		DEFAULT_BYTES_PER_BLOCK - DEFAULT_BYTES_PER_BLOCK % l_c_m
	} else {
		l_c_m
	};
	let mut width_per_block = 0;
	for spec in &cfg.specs {
		let fields = bytes_per_block / spec.size as i64;
		if (fields - 1).checked_mul(fields - 1).is_none() {
			host.error(format!("{} is too large", cfg.desired), 1);
			return Err(1);
		}
		width_per_block = width_per_block.max((spec.width + 1) * fields);
	}
	for spec in &mut cfg.specs {
		let fields = bytes_per_block / spec.size as i64;
		spec.pad = width_per_block - spec.width * fields;
	}

	let bpb = usize::try_from(bytes_per_block).map_err(|_| {
		host.error("memory exhausted", 1);
		1
	})?;
	let mut storage: Vec<u8> = Vec::new();
	if bpb.checked_mul(2).is_none_or(|total| storage.try_reserve_exact(total).is_err()) {
		host.error("memory exhausted", 1);
		return Err(1);
	}
	storage.resize(bpb * 2, 0);
	let (mut a, mut b) = storage.split_at_mut(bpb);

	let mut writer = BlockWriter {
		first:           true,
		prev_pair_equal: false,
		big_endian:      cfg!(target_endian = "big") != cfg.swap,
		bytes_per_block: bpb,
		field:           String::new(),
	};
	let mut line = Vec::new();
	let mut ok = true;
	let mut offset = cfg.skip;
	let mut n_read;
	loop {
		let bound = if cfg.end_offset < 0 { i64::MAX } else { cfg.end_offset - offset };
		if bound <= 0 || host.is_cancelled() {
			n_read = 0;
			break;
		}
		let needed = bpb.min(usize::try_from(bound).unwrap_or(usize::MAX));
		let (got, read_ok) = inputs.read_block(host, &mut b[..needed]);
		n_read = got;
		ok &= read_ok;
		if n_read < bpb {
			break;
		}
		writer.write(cfg, &mut line, offset, n_read, a, b).map_err(|()| pseudo_overflow(host))?;
		emit(host, out, &mut line)?;
		offset += n_read as i64;
		std::mem::swap(&mut a, &mut b);
		if !ok {
			break;
		}
	}
	if n_read > 0 {
		let l_c_m = l_c_m as usize;
		let to_write = (n_read + l_c_m - 1) / l_c_m * l_c_m;
		b[n_read..to_write].fill(0);
		writer.write(cfg, &mut line, offset, n_read, a, b).map_err(|()| pseudo_overflow(host))?;
		offset += n_read as i64;
	}
	if ok || offset != 0 {
		cfg.addr.write(&mut line, offset, b'\n').map_err(|()| pseudo_overflow(host))?;
	}
	emit(host, out, &mut line)?;
	if cfg.end_offset >= 0 && cfg.end_offset <= offset {
		ok &= inputs.close(host);
	}
	Ok(ok)
}

/// GNU `dump_strings`.
fn dump_strings(host: &mut Host, out: &mut impl Write, inputs: &mut Inputs, cfg: &Config, min: i64) -> Result<bool, i32> {
	let end = cfg.end_offset;
	let mut address = cfg.skip;
	let mut ok = true;
	let mut buf: Vec<u8> = Vec::new();
	let mut line = Vec::new();
	loop {
		if host.is_cancelled() {
			return Ok(ok);
		}
		if end >= 0 && (end < min || end - min < address) {
			break;
		}
		buf.clear();
		// `None`: gave up on this string; `Some(true)`: NUL-terminated.
		let mut state = Some(false);
		while !(end >= 0 && end <= address) {
			let (c, read_ok) = inputs.read_char(host);
			ok &= read_ok;
			let Some(c) = c else {
				emit(host, out, &mut line)?;
				return Ok(ok);
			};
			address += 1;
			buf.push(c);
			if c == 0 {
				state = Some(true);
				break;
			}
			if !is_print(c) {
				state = None;
				break;
			}
		}
		let Some(nul) = state else { continue };
		if (buf.len() - usize::from(nul)) as i64 >= min {
			cfg.addr.write(&mut line, address - buf.len() as i64, b' ').map_err(|()| pseudo_overflow(host))?;
			line.extend(buf.iter().take_while(|&&c| c != 0));
			line.push(b'\n');
			emit(host, out, &mut line)?;
		}
	}
	emit(host, out, &mut line)?;
	ok &= inputs.close(host);
	Ok(ok)
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::host::run_util;

	fn od(args: &[&str], stdin: &str) -> (i32, String, String) {
		let (code, capture) = run_util::<Od>(args, stdin, std::env::temp_dir());
		(code, capture.out(), capture.err())
	}

	#[test]
	fn char_escapes_and_squash() {
		let (code, out, _) = od(&["-c"], "a\tb\n\0\u{7f}");
		assert_eq!(code, 0);
		assert_eq!(out, "0000000   a  \\t   b  \\n  \\0 177\n0000006\n");
		let (_, out, _) = od(&["-An", "-tx1"], &"a".repeat(40));
		assert_eq!(out, format!(" {}\n*\n {}\n", ["61"; 16].join(" "), ["61"; 8].join(" ")));
	}

	#[test]
	fn floats_named_and_trailer() {
		let (_, out, _) = od(&["-An", "-tfF", "-w4"], "\0\0\u{40}\u{3f}");
		assert_eq!(out, "            0.75\n");
		// C `%g` rounds exact ties to even.
		let (_, out, _) = od(&["-An", "-tfH", "-w2"], "\u{4}\u{3c}");
		assert_eq!(out, "       1.0039062\n");
		let (_, out, _) = od(&["-ta"], "\u{1}A ");
		assert_eq!(out, "0000000 soh   A  sp\n0000003\n");
		let (_, out, _) = od(&["-w2", "-tx1z"], "abc");
		assert_eq!(out, "0000000 61 62  >ab<\n0000002 63     >c<\n0000003\n");
	}

	#[test]
	fn skip_limit_endian_strings() {
		let (_, out, _) = od(&["-j", "3", "-N", "5", "-to1"], "abcdefghij");
		assert_eq!(out, "0000003 144 145 146 147 150\n0000010\n");
		let (_, out, _) = od(&["-Ax", "-td2", "--endian=big"], "\u{1}\u{2}");
		assert_eq!(out, "000000    258\n000002\n");
		let (_, out, _) = od(&["-S", "4"], "hi\0hello\0x");
		assert_eq!(out, "0000003 hello\n");
		let (_, out, _) = od(&["+1"], "abc");
		assert_eq!(out, "0000001 061542\n0000003\n");
	}

	#[test]
	fn errors() {
		let (code, _, err) = od(&["-td3"], "");
		assert_eq!(code, 1);
		assert_eq!(err, "od: invalid type string 'd3';\nthis system doesn't provide a 3-byte integral type\n");
		let (code, _, err) = od(&["-q"], "");
		assert_eq!(code, 1);
		assert!(err.contains("'-q'"), "{err}");
		let (code, _, err) = od(&["--traditional", "a", "b", "c", "d"], "");
		assert_eq!(code, 1);
		assert_eq!(
			err,
			"od: extra operand 'b'\nod: compatibility mode supports at most one file\nTry 'od --help' for more \
			 information.\n"
		);
		let (code, _, err) = od(&["-j", "08"], "");
		assert_eq!((code, err.as_str()), (1, "od: invalid suffix in -j argument '08'\n"));
		let (code, _, err) = od(&["-j", "9"], "abc");
		assert_eq!((code, err.as_str()), (1, "od: cannot skip past end of combined input\n"));
		let (code, out, _) = od(&[], "");
		assert_eq!((code, out.as_str()), (0, "0000000\n"));
		let (code, out, _) = od(&["--help"], "");
		assert!(code == 0 && out.contains("Usage: od [OPTION]... [FILE]..."), "{out}");
	}

	#[test]
	fn number_suffixes() {
		assert_eq!(parse_bytes("0x10", "-j"), Ok(16));
		assert_eq!(parse_bytes("0X10", "-j"), Ok(16));
		assert_eq!(parse_bytes("010", "-j"), Ok(8));
		assert_eq!(parse_bytes("1KB", "-j"), Ok(1000));
		assert_eq!(parse_bytes("1KiB", "-j"), Ok(1024));
		assert_eq!(parse_bytes("2b", "-j"), Ok(1024));
		assert_eq!(parse_bytes("-1", "-N"), Err("invalid -N argument '-1'".to_owned()));
		assert_eq!(parse_bytes("1g", "-N"), Err("invalid suffix in -N argument '1g'".to_owned()));
		assert_eq!(parse_bytes("9E", "-N"), Err("-N argument '9E' too large".to_owned()));
		assert_eq!(parse_width("010"), Ok(10));
		assert_eq!(parse_width("1K"), Err("invalid suffix in -w argument '1K'".to_owned()));
		assert_eq!(parse_offset_operand("+10."), Ok(Some(10)));
		assert_eq!(parse_offset_operand("10b"), Ok(Some(8 * 512)));
		assert_eq!(parse_offset_operand("0x1b"), Ok(Some(27)));
		assert_eq!(parse_offset_operand("08"), Ok(None));
		assert_eq!(parse_offset_operand("99"), Ok(None));
		assert_eq!(parse_offset_operand("+7777777777777777777777"), Err(()));
	}

	#[test]
	fn legacy_flags_and_types_keep_command_line_order() {
		let (_, out, _) = od(&["-c", "-tx1", "-b"], "A");
		assert_eq!(out, "0000000   A\n         41\n        101\n0000001\n");
		let (_, out, _) = od(&["-bc"], "A");
		assert_eq!(out, "0000000 101\n          A\n0000001\n");
	}
}
