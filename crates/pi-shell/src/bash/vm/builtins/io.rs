//! `echo`, `read` and the `select` query.

use bstr::{BString, ByteSlice};

use super::{
	Ctx, Need, R, done, number, opts,
	vars::{Lhs, set_value},
};
use crate::bash::{
	diag::Diag,
	fs::FileKind,
	vm::{
		Cx, Kernel,
		exec::Flow,
		expand::DEFAULT_IFS,
		is_ident,
		locale::{self, Charset},
		probe,
		proc::{AssignValue, LoopKind, PendingWrite, Probe, ProbeResult, Vproc},
		state::{self, Level, Var},
	},
};

/// bash `echo` (with `xpg_echo` off): leading `-n`/`-e`/`-E` option words,
/// then the arguments separated by spaces.
pub fn echo(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	// bash `echo.def`: `xpg_echo` turns escapes on; with POSIX mode as well,
	// no option words are recognized.
	let xpg = ctx.option(crate::bash::store::OptId::XpgEcho)?;
	let options = !(xpg && ctx.option(crate::bash::store::OptId::Posix)?);
	let mut out = Vec::new();
	echo_bytes(args, &mut out, xpg, options);
	ctx.out(&out);
	done(0)
}

fn echo_bytes(args: &[BString], out: &mut Vec<u8>, xpg: bool, options: bool) {
	let mut newline = true;
	let mut escapes = xpg;
	let mut rest = args;
	while options && let Some((first, tail)) = rest.split_first() {
		let Some(flags) = first.strip_prefix(b"-") else {
			break;
		};
		if flags.is_empty() || !flags.iter().all(|c| matches!(c, b'n' | b'e' | b'E')) {
			break;
		}
		for &c in flags {
			match c {
				b'n' => newline = false,
				b'e' => escapes = true,
				_ => escapes = false,
			}
		}
		rest = tail;
	}
	for (i, arg) in rest.iter().enumerate() {
		if i > 0 {
			out.push(b' ');
		}
		if escapes {
			if escapes_into(arg, out, false) {
				return;
			}
		} else {
			out.extend_from_slice(arg);
		}
	}
	if newline {
		out.push(b'\n');
	}
}

/// Append `arg` with `echo -e` escapes decoded (`printf %b` when
/// `printf_b`: `\0nnn` takes up to 3 digits after the 0, as in `echo`, and
/// `\nnn` without the leading 0 is also octal); `true` when `\c` stops
/// output.
pub fn escapes_into(arg: &[u8], out: &mut Vec<u8>, printf_b: bool) -> bool {
	let mut pos = 0;
	while pos < arg.len() {
		let byte = arg[pos];
		pos += 1;
		if byte != b'\\' || pos == arg.len() {
			out.push(byte);
			continue;
		}
		let esc = arg[pos];
		pos += 1;
		match esc {
			b'a' => out.push(0x07),
			b'b' => out.push(0x08),
			b'c' => return true,
			b'e' | b'E' => out.push(0x1b),
			b'f' => out.push(0x0c),
			b'n' => out.push(b'\n'),
			b'r' => out.push(b'\r'),
			b't' => out.push(b'\t'),
			b'v' => out.push(0x0b),
			b'\\' => out.push(b'\\'),
			b'0' => {
				let (value, len) = digits(&arg[pos..], 8, 3);
				out.push(value as u8);
				pos += len;
			},
			b'1'..=b'7' if printf_b => {
				let (value, len) = digits(&arg[pos - 1..], 8, 3);
				out.push(value as u8);
				pos += len - 1;
			},
			b'x' => match digits(&arg[pos..], 16, 2) {
				(_, 0) => out.extend_from_slice(b"\\x"),
				(value, len) => {
					out.push(value as u8);
					pos += len;
				},
			},
			b'u' | b'U' => {
				let max = if esc == b'u' { 4 } else { 8 };
				match digits(&arg[pos..], 16, max) {
					(_, 0) => out.extend_from_slice(&[b'\\', esc]),
					(value, len) => {
						pos += len;
						let ch = char::from_u32(value).unwrap_or(char::REPLACEMENT_CHARACTER);
						out.extend_from_slice(ch.encode_utf8(&mut [0; char::MAX_LEN_UTF8]).as_bytes());
					},
				}
			},
			_ => out.extend_from_slice(&[b'\\', esc]),
		}
	}
	false
}

/// Up to `max` digits in `radix` at the start of `s`: (value, count).
pub fn digits(text: &[u8], radix: u32, max: usize) -> (u32, usize) {
	let mut value = 0u32;
	let mut count = 0;
	for &byte in text.iter().take(max) {
		let Some(digit) = char::from(byte).to_digit(radix) else {
			break;
		};
		value = value * radix + digit;
		count += 1;
	}
	(value, count)
}

/// bash `sh_invalidnum`: `ARG: invalid number` (octal and hex spelled out).
pub fn invalid_number(arg: &[u8]) -> String {
	let what = match arg {
		[b'0', d, ..] if d.is_ascii_digit() => "invalid octal number",
		[b'0', b'x', ..] => "invalid hex number",
		_ => "invalid number",
	};
	format!("{}: {what}", arg.as_bstr())
}

/// `name` or `name[subscript]` (bash `valid_identifier` /
/// `valid_array_reference`): the name and the subscript text.
pub fn split_ref(name: &[u8]) -> Option<(&[u8], Option<&[u8]>)> {
	if is_ident(name) {
		return Some((name, None));
	}
	let open = name.find_byte(b'[')?;
	let (base, sub) = (&name[..open], &name[open + 1..]);
	let sub = sub.strip_suffix(b"]")?;
	(is_ident(base) && !sub.is_empty()).then_some((base, Some(sub)))
}

/// Assign `value` to `name` (`name[sub]` allowed) as builtins bind
/// variables: a readonly variable is reported without the builtin prefix
/// (bash `err_readonly`). `false` when the assignment failed.
pub fn bind(ctx: &mut Ctx<'_, '_>, name: &[u8], value: AssignValue) -> bool {
	let Some((base, index)) = split_ref(name) else {
		ctx.err(Diag::InvalidIdent { name: name.into() });
		return false;
	};
	bind_lhs(ctx, Lhs { name: base, index, append: false }, value)
}

/// Assign `value` to `lhs` as [`bind`] does.
pub fn bind_lhs(ctx: &mut Ctx<'_, '_>, lhs: Lhs<'_>, value: AssignValue) -> bool {
	match set_value(ctx.k, ctx.cx, ctx.vp, lhs, value, Level::Dynamic) {
		Ok(()) => true,
		Err(d @ Diag::Readonly { .. }) => {
			ctx.diag(d);
			false
		},
		Err(d) => {
			ctx.err(d);
			false
		},
	}
}

/// One character of `read`'s input: where its bytes start in
/// [`Line::bytes`], and whether a backslash escaped it (escaped characters
/// never delimit fields).
#[derive(Clone, Copy, Debug)]
struct Ch {
	at:      usize,
	escaped: bool,
}

/// Input of `read` after backslash processing, cut into the locale's
/// characters.
#[derive(Default)]
struct Line {
	bytes: Vec<u8>,
	/// One entry per character once a character is multibyte or escaped;
	/// until then (`!wide`) character `k` is byte `k`, unescaped.
	chars: Vec<Ch>,
	wide:  bool,
}

impl Line {
	/// Number of characters.
	const fn len(&self) -> usize {
		if self.wide {
			self.chars.len()
		} else {
			self.bytes.len()
		}
	}

	/// Byte offset of character `k` (the end for `k == len`).
	fn at(&self, k: usize) -> usize {
		if self.wide {
			self.chars.get(k).map_or(self.bytes.len(), |c| c.at)
		} else {
			k.min(self.bytes.len())
		}
	}

	/// Whether a backslash escaped character `k`.
	fn escaped(&self, k: usize) -> bool {
		self.wide && self.chars[k].escaped
	}

	/// The bytes of character `k`.
	fn char_bytes(&self, k: usize) -> &[u8] {
		&self.bytes[self.at(k)..self.at(k + 1)]
	}

	/// Characters `a..b` as text.
	fn text(&self, a: usize, b: usize) -> BString {
		BString::from(&self.bytes[self.at(a)..self.at(b)])
	}

	/// All of it as text.
	fn all(&self) -> BString {
		BString::from(self.bytes.as_slice())
	}

	fn push(&mut self, bytes: &[u8], escaped: bool) {
		if !self.wide && (bytes.len() != 1 || escaped) {
			self.chars = (0..self.bytes.len())
				.map(|at| Ch { at, escaped: false })
				.collect();
			self.wide = true;
		}
		if self.wide {
			self.chars.push(Ch { at: self.bytes.len(), escaped });
		}
		self.bytes.extend_from_slice(bytes);
	}

	/// Characters of one unescaped byte each.
	fn push_bytes(&mut self, run: &[u8]) {
		if self.wide {
			let at = self.bytes.len();
			self
				.chars
				.extend((at..at + run.len()).map(|at| Ch { at, escaped: false }));
		}
		self.bytes.extend_from_slice(run);
	}
}

/// The length of the run at the start of `data` that [`LineState::step`]
/// would take byte by byte as characters of their own: no backslash
/// (unless `raw`), delimiter or NUL, and each byte a whole character of `cs`.
fn plain_len(data: &[u8], raw: bool, delim: Option<u8>, cs: Charset) -> usize {
	let ascii_only = match cs {
		Charset::Utf8 => true,
		Charset::Bytes | Charset::Latin1 => false,
		Charset::Encoding(enc) if enc.is_single_byte() => false,
		// A stateful or multibyte charset may give an ASCII byte meaning.
		Charset::Encoding(_) => return 0,
	};
	data
		.iter()
		.position(|&c| {
			Some(c) == delim || c == 0 || (c == b'\\' && !raw) || (ascii_only && !c.is_ascii())
		})
		.unwrap_or(data.len())
}

/// bash's `read` loop over successive chunks of input: backslash
/// handling, NUL skipping, the delimiter, and the characters `-n` counts.
/// A multibyte character is read whole (bash's `read_mbchar`), so its
/// later bytes are never a backslash or the delimiter.
#[derive(Default)]
struct LineState {
	line:       Line,
	/// The last byte was an unescaped backslash.
	pass_next:  bool,
	/// The bytes of a multibyte character still being read, and whether
	/// it was escaped.
	mb:         Vec<u8>,
	mb_escaped: bool,
}

impl LineState {
	/// Feed `data`; `true` when an unescaped delimiter ended the line.
	fn feed(&mut self, mut data: &[u8], raw: bool, delim: Option<u8>, cs: Charset) -> bool {
		while let Some((&c, after)) = data.split_first() {
			if self.mb.is_empty() && !self.pass_next {
				let run = plain_len(data, raw, delim, cs);
				if run > 0 {
					self.line.push_bytes(&data[..run]);
					data = &data[run..];
					continue;
				}
			}
			data = after;
			if self.mb.is_empty() {
				if self.step(c, raw, delim, cs) {
					return true;
				}
				continue;
			}
			self.mb.push(c);
			let Some(n) = locale::char_len(cs, &self.mb, true) else {
				continue;
			};
			// A complete character, or (invalid) the lead byte alone: the
			// bytes after it are input again.
			let rest = self.mb.split_off(n);
			let ch = std::mem::take(&mut self.mb);
			self.line.push(&ch, self.mb_escaped);
			for r in rest {
				if self.step(r, raw, delim, cs) {
					return true;
				}
			}
		}
		false
	}

	/// One byte outside a multibyte character.
	fn step(&mut self, c: u8, raw: bool, delim: Option<u8>, cs: Charset) -> bool {
		if self.pass_next {
			self.pass_next = false;
			// `\<newline>` (and `\<NUL>`) vanish.
			if c != b'\n' && c != 0 {
				self.start(c, true, cs);
			}
			return false;
		}
		if c == b'\\' && !raw {
			self.pass_next = true;
			return false;
		}
		if Some(c) == delim {
			return true;
		}
		if c != 0 {
			self.start(c, false, cs);
		}
		false
	}

	/// A character starting with byte `c`.
	fn start(&mut self, c: u8, escaped: bool, cs: Charset) {
		if locale::char_len(cs, &[c], true).is_none() {
			self.mb.push(c);
			self.mb_escaped = escaped;
		} else {
			self.line.push(&[c], escaped);
		}
	}

	/// The line once input ended: an unfinished multibyte character keeps
	/// its bytes, as one character.
	fn finish(mut self) -> Line {
		if !self.mb.is_empty() {
			let mb = std::mem::take(&mut self.mb);
			self.line.push(&mb, self.mb_escaped);
		}
		self.line
	}

	/// Whether `n` whole characters were read.
	const fn full(&self, n: usize) -> bool {
		self.line.len() >= n && self.mb.is_empty()
	}

	/// Bytes to ask for next so no more than `n` characters are read.
	const fn want(&self, n: usize) -> usize {
		if self.mb.is_empty() {
			n.saturating_sub(self.line.len())
		} else {
			1
		}
	}
}

/// `IFS` as `read` splits by it: its characters (in the locale's
/// charset), and whether it is exactly ` \t\n` (bash's `sh_style_split`,
/// where only those three count as IFS whitespace).
struct Ifs<'a> {
	chars:    Vec<&'a [u8]>,
	sh_style: bool,
}

impl<'a> Ifs<'a> {
	fn new(ifs: &'a [u8], cs: Charset) -> Self {
		let mut chars = Vec::new();
		let mut i = 0;
		while i < ifs.len() {
			let n = locale::char_len(cs, &ifs[i..], false).unwrap_or(1);
			chars.push(&ifs[i..i + n]);
			i += n;
		}
		Self { chars, sh_style: ifs == b" \t\n" }
	}

	/// Whether character `k` of `m` is an unescaped `IFS` character.
	fn sep(&self, m: &Line, k: usize) -> bool {
		!m.escaped(k) && self.chars.contains(&m.char_bytes(k))
	}

	/// bash's `ifs_whitesep`: space, tab and newline with the default
	/// `IFS`, any `isspace` character otherwise.
	fn whitesep(&self, m: &Line, k: usize) -> bool {
		match m.char_bytes(k) {
			[c] => {
				matches!(c, b' ' | b'\t' | b'\n')
					|| (!self.sh_style && matches!(c, 0x0b | 0x0c | b'\r'))
			},
			_ => false,
		}
	}
}

/// Whether character `k` is a space, tab or newline (bash's `spctabnl`).
fn spctabnl(m: &Line, k: usize) -> bool {
	matches!(m.char_bytes(k), b" " | b"\t" | b"\n")
}

/// One field starting at character `i`: `(field, next)`, as bash's
/// `get_word_from_string` splits it (leading IFS whitespace skipped, then
/// the field, then its delimiter: one IFS character, any space, tab or
/// newline in `IFS`, and after IFS whitespace one more non-whitespace IFS
/// character with the whitespace around it).
fn field(ifs: &Ifs<'_>, m: &Line, mut i: usize) -> (BString, usize) {
	// `IFS=`: nothing separates (`IFS= read -r line`).
	if ifs.chars.is_empty() {
		return (m.text(i.min(m.len()), m.len()), m.len());
	}
	while i < m.len() && ifs.sep(m, i) && ifs.whitesep(m, i) {
		i += 1;
	}
	let mut j = i;
	while j < m.len() && !ifs.sep(m, j) {
		j += 1;
	}
	let word = m.text(i, j);
	let whitesep = j < m.len() && ifs.whitesep(m, j);
	if j < m.len() {
		j += 1;
	}
	while j < m.len() && spctabnl(m, j) && ifs.sep(m, j) {
		j += 1;
	}
	if j < m.len() && whitesep && ifs.sep(m, j) && !ifs.whitesep(m, j) {
		j += 1;
		while j < m.len() && ifs.whitesep(m, j) && ifs.sep(m, j) {
			j += 1;
		}
	}
	(word, j)
}

/// The value of `read`'s last variable from character `i` on: the single
/// field left, or the rest with trailing IFS whitespace (any `isspace`
/// character in `IFS`, escaped ones too) removed, as bash's
/// `strip_trailing_ifs_whitespace` does.
fn last_value(ifs: &Ifs<'_>, m: &Line, i: usize) -> BString {
	if i >= m.len() {
		return BString::default();
	}
	let (word, next) = field(ifs, m, i);
	if next >= m.len() {
		return word;
	}
	let mut end = m.len();
	while end > i + 1 {
		let c = m.char_bytes(end - 1);
		if !(matches!(c, b" " | b"\t" | b"\n" | b"\x0b" | b"\x0c" | b"\r") && ifs.chars.contains(&c))
		{
			break;
		}
		end -= 1;
	}
	m.text(i, end)
}

/// Index of the first character after leading space, tab or newline in
/// `IFS` (bash's `read` strips those before splitting).
fn skip_ifs_ws(ifs: &Ifs<'_>, m: &Line) -> usize {
	(0..m.len())
		.take_while(|&k| spctabnl(m, k) && ifs.sep(m, k))
		.count()
}

/// Split `m` into all of its fields (`read -a`).
fn split_all(ifs: &Ifs<'_>, m: &Line) -> Vec<BString> {
	let mut out = Vec::new();
	let mut i = skip_ifs_ws(ifs, m);
	while i < m.len() {
		let (f, next) = field(ifs, m, i);
		out.push(f);
		i = next;
	}
	out
}

/// How a `read` ended.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Ended {
	/// The delimiter or the character count was reached.
	Complete,
	/// End of file first (status 1).
	Eof,
	/// The timeout passed first (status 142).
	TimedOut,
}

/// What [`read_line`] reads: the fd, where to stop, and how long to wait.
#[derive(Clone, Copy)]
struct LineSpec {
	fd:         i32,
	delim:      Option<u8>,
	nchars:     Option<usize>,
	raw:        bool,
	cs:         Charset,
	timeout_ns: Option<u64>,
}

/// Read one line (or up to `delim`/`nchars` characters) from `fd`,
/// joining `\` continuation lines unless `raw`. `prompt` goes to stderr
/// before the first read.
fn read_line(
	ctx: &mut Ctx<'_, '_>,
	spec: LineSpec,
	prompt: Option<&[u8]>,
) -> Result<(Line, Ended), Need> {
	let LineSpec { fd, delim, nchars, raw, cs, timeout_ns } = spec;
	let mut st = LineState::default();
	let mut part = 0;
	loop {
		if nchars.is_some_and(|n| st.full(n)) {
			return Ok((st.finish(), Ended::Complete));
		}
		let want = nchars.map(|n| st.want(n));
		let probe = Probe::Input { fd, delim, lines: 1, nchars: want, part, timeout_ns };
		let answer = match ctx.probe(probe) {
			Ok(a) => a,
			Err(need) => {
				// The builtin runs once per answered probe, so the prompt is
				// written once, before the first read blocks.
				if part == 0
					&& let Some(p) = prompt
				{
					ctx.vp
						.out
						.push_back(PendingWrite { fd: 2, bytes: p.into(), off: 0 });
				}
				return Err(need);
			},
		};
		let ProbeResult::Input { data, eof, timed_out } = answer else {
			return Ok((st.finish(), Ended::Eof));
		};
		let ended = st.feed(&data, raw, delim, cs);
		if timed_out {
			return Ok((st.finish(), Ended::TimedOut));
		}
		if ended {
			return Ok((st.finish(), Ended::Complete));
		}
		if eof {
			return Ok((st.finish(), Ended::Eof));
		}
		part += 1;
	}
}

/// A `read -t` / `TMOUT` value in seconds (decimal fraction allowed) as ns;
/// `None` for anything else (negative, not a number).
fn timeout_value(text: &[u8]) -> Option<u64> {
	let s = std::str::from_utf8(text).ok()?;
	let (int, frac) = s.split_once('.').unwrap_or((s, ""));
	if (int.is_empty() && frac.is_empty())
		|| !int.bytes().all(|c| c.is_ascii_digit())
		|| !frac.bytes().all(|c| c.is_ascii_digit())
	{
		return None;
	}
	let secs: u64 = if int.is_empty() { 0 } else { int.parse().ok()? };
	let mut nanos: u64 = 0;
	for (i, c) in frac.bytes().take(9).enumerate() {
		nanos += u64::from(c - b'0') * 10u64.pow(8 - i as u32);
	}
	secs.checked_mul(1_000_000_000)?.checked_add(nanos)
}

/// bash `valid_number` limited to an `int` that is not negative.
fn count_arg(arg: &[u8]) -> Option<usize> {
	number(arg)
		.filter(|&n| n >= 0)
		.and_then(|n| i32::try_from(n).ok())
		.and_then(|n| usize::try_from(n).ok())
}

/// A `-u fd` argument: the fd, or `Err(status)` after bash's message.
pub fn fd_arg(ctx: &mut Ctx<'_, '_>, arg: &[u8]) -> Result<i32, i32> {
	let Some(fd) = count_arg(arg).and_then(|n| i32::try_from(n).ok()) else {
		ctx.usage(format!("{}: invalid file descriptor specification", arg.as_bstr()));
		return Err(1);
	};
	if !ctx
		.vp
		.fds
		.get(fd)
		.is_some_and(crate::bash::fd::FdRef::is_open)
	{
		ctx.usage(format!("{fd}: invalid file descriptor: Bad file descriptor"));
		return Err(1);
	}
	Ok(fd)
}

/// bash `read`. `-e`/`-E` (readline editing) read a plain line: without
/// a terminal bash drops them too, and `-i` only seeds readline.
pub fn read(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	let o = match opts(ctx, args, b"Eers", b"adinNptu", false) {
		Ok(o) => o,
		Err(st) => return done(st),
	};
	// argv index (counting argv[0]) of the first name operand.
	let base = 1 + args.len() - o.rest.len();
	let mut raw = false;
	let mut array = None;
	let mut delim = Some(b'\n');
	let mut nchars = None;
	let mut exact = false;
	let mut fd = 0;
	let mut timeout = None;
	let mut prompt = None;
	for (c, _, arg) in &o.flags {
		let arg = arg.as_ref().map_or(&[][..], |a| a.as_slice());
		match *c {
			b'r' => raw = true,
			b'a' => array = Some(arg),
			b'd' => delim = Some(arg.first().copied().unwrap_or(0)),
			b'p' => prompt = Some(arg),
			b't' => {
				let Some(ns) = timeout_value(arg) else {
					ctx.usage(format!("{}: invalid timeout specification", arg.as_bstr()));
					return done(1);
				};
				timeout = Some(ns);
			},
			b'n' | b'N' => {
				let Some(n) = count_arg(arg) else {
					ctx.usage(invalid_number(arg));
					return done(1);
				};
				nchars = Some(n);
				exact |= *c == b'N';
			},
			b'u' => match fd_arg(ctx, arg) {
				Ok(f) => fd = f,
				Err(st) => return done(st),
			},
			// -s (no echo) and -e/-E/-i (readline) only act on a terminal.
			_ => {},
		}
	}
	if timeout == Some(0) {
		// `read -t 0`: report whether input is available; read nothing.
		let ready = ctx.probe(Probe::Ready { fd })? == ProbeResult::Ok(true);
		return done(i32::from(!ready));
	}
	if let Some(first) = o.rest.first()
		&& !super::vars::assignable_name(ctx, first, base)?
	{
		ctx.err(Diag::InvalidIdent { name: first.clone() });
		return done(1);
	}
	let delim = if exact { None } else { delim };
	let cs = locale::charset(ctx.k, ctx.cx.store, ctx.vp);
	let (marked, status) = if nchars == Some(0) {
		(Line::default(), 0)
	} else {
		let timeout_ns = match timeout {
			Some(ns) => Some(ns),
			None => ctx
				.scalar(b"TMOUT")?
				.and_then(|t| timeout_value(&t))
				.filter(|&ns| ns > 0),
		};
		let tty = ctx.vp.fds.handle(fd).kind() == Some(FileKind::Tty);
		let spec = LineSpec { fd, delim, nchars, raw, cs, timeout_ns };
		let (marked, ended) = read_line(ctx, spec, prompt.filter(|_| tty))?;
		let status = match ended {
			Ended::Complete => 0,
			Ended::Eof => 1,
			// 128 + SIGALRM, as bash reports a `read` timeout.
			Ended::TimedOut => 142,
		};
		(marked, status)
	};
	let ifs = if exact {
		BString::default()
	} else {
		ctx.scalar(b"IFS")?
			.unwrap_or_else(|| BString::from(DEFAULT_IFS))
	};
	if let Some(name) = array {
		if !is_ident(name) {
			ctx.err(Diag::InvalidIdent { name: name.into() });
			return done(1);
		}
		let Some(strip) = super::vars::indexed_array_target(ctx, name)? else {
			return done(1);
		};
		if strip {
			super::vars::strip_nameref(ctx, name)?;
		}
		let items = split_all(&Ifs::new(&ifs, cs), &marked)
			.into_iter()
			.map(|v| (None, false, v))
			.collect();
		if !bind(ctx, name, AssignValue::Array(items)) {
			return done(1);
		}
		return done(status);
	}
	let Some((last, init)) = o.rest.split_last() else {
		if !bind(ctx, b"REPLY", AssignValue::Scalar(marked.all())) {
			return done(2);
		}
		return done(status);
	};
	let ifs = Ifs::new(&ifs, cs);
	let mut i = skip_ifs_ws(&ifs, &marked);
	for (j, name) in init.iter().enumerate() {
		if !super::vars::assignable_name(ctx, name, base + j)? {
			ctx.err(Diag::InvalidIdent { name: name.clone() });
			return done(1);
		}
		let value = if i < marked.len() {
			let (f, next) = field(&ifs, &marked, i);
			i = next;
			f
		} else {
			BString::default()
		};
		if !bind(ctx, name, AssignValue::Scalar(value)) {
			return done(2);
		}
	}
	if !super::vars::assignable_name(ctx, last, base + init.len())? {
		ctx.err(Diag::InvalidIdent { name: last.clone() });
		return done(1);
	}
	if !bind(ctx, last, AssignValue::Scalar(last_value(&ifs, &marked, i))) {
		return done(1);
	}
	done(status)
}

/// Digits needed for `n`.
fn number_len(n: usize) -> usize {
	n.checked_ilog10().map_or(1, |l| l as usize + 1)
}

/// bash `print_select_list`: the menu in columns over `$COLUMNS`.
fn select_menu(items: &[BString], columns: usize) -> Vec<u8> {
	use std::fmt::Write as _;
	let n = items.len();
	let indices_len = number_len(n);
	let max_elem_len = items.iter().map(|i| i.chars().count()).max().unwrap_or(0) + indices_len + 4;
	let mut out = String::new();
	let cols = (columns / max_elem_len).max(1);
	let rows = if n == 0 {
		1
	} else {
		n / cols + usize::from(!n.is_multiple_of(cols))
	};
	let cols = if n == 0 {
		1
	} else {
		n / rows + usize::from(!n.is_multiple_of(rows))
	};
	let (rows, _cols) = if rows == 1 { (cols, 1) } else { (rows, cols) };
	let first_len = number_len(rows);
	for row in 0..rows {
		let mut ind = row;
		let mut pos = 0;
		loop {
			let width = if pos == 0 { first_len } else { indices_len };
			let item = items[ind].to_str_lossy();
			let _ = write!(out, "{:>width$}) {item}", ind + 1);
			let elem_len = item.chars().count() + width + 2;
			ind += rows;
			if ind >= n {
				break;
			}
			// bash `indent`: tabs to tab stops, then spaces.
			let (mut from, to) = (pos + elem_len, pos + max_elem_len);
			while from < to {
				if to / 8 > from / 8 {
					out.push('\t');
					from += 8 - from % 8;
				} else {
					out.push(' ');
					from += 1;
				}
			}
			pos += max_elem_len;
		}
		out.push('\n');
	}
	out.into_bytes()
}

fn scalar_of(k: &Kernel, cx: &mut Cx<'_>, vp: &Vproc, name: &[u8]) -> Option<BString> {
	state::lookup(&k.root, cx.store, vp, name)
		.ok()
		.flatten()
		.and_then(|v| v.as_scalar().map(BString::from))
}

/// `$COLUMNS` / `$LINES` as a positive size, else `default`.
fn terminal_size(k: &Kernel, cx: &mut Cx<'_>, vp: &Vproc, name: &[u8], default: usize) -> usize {
	scalar_of(k, cx, vp, name)
		.and_then(|c| number(&c))
		.and_then(|c| usize::try_from(c).ok())
		.filter(|&c| c > 0)
		.unwrap_or(default)
}

/// The next `select` choice: print the menu (first time, or after an
/// empty reply) and `$PS3`, read a line into `REPLY`. `Ok(None)` at end of
/// input; `Err` parks the loop op.
pub fn select_next(
	k: &mut Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	_line: u32,
) -> Result<Option<(BString, BString)>, Flow> {
	let Some(rec) = vp.frames.last().and_then(|f| f.loops.last()) else {
		return Ok(None);
	};
	let LoopKind::Select { var, items, first, more } = &rec.kind else {
		return Ok(None);
	};
	// An empty list ends the loop at once, with status 0.
	if items.is_empty() {
		return Ok(None);
	}
	let (var, items, mut print_menu, mut more) = (var.clone(), items.clone(), *first, *more);
	let zsh = vp.mode.dialect() == crate::bash::ids::Dialect::Zsh;
	let mut sc = vp
		.frames
		.last_mut()
		.and_then(|f| f.scratch.take())
		.unwrap_or_default();
	let mut part = 0;
	let result = loop {
		let p =
			Probe::Input { fd: 0, delim: Some(b'\n'), lines: 1, nchars: None, part, timeout_ns: None };
		// zsh pages the menu: each page moves `more` on, so a replayed
		// part computes it again.
		let zsh_menu = if zsh && print_menu {
			let columns = terminal_size(k, cx, vp, b"COLUMNS", 80);
			let lines = terminal_size(k, cx, vp, b"LINES", 24);
			let (text, next) = zsh_select_list(&items, more, columns, lines);
			more = next;
			Some(text)
		} else {
			None
		};
		let answer = if let Some(r) = probe::cached(&sc, &p) {
			r.clone()
		} else {
			if sc.probing() != Some(&p) {
				let mut text = zsh_menu.unwrap_or_default();
				if print_menu && !zsh {
					let columns = terminal_size(k, cx, vp, b"COLUMNS", 80);
					text.extend_from_slice(&select_menu(&items, columns));
				}
				let ps3 = if zsh { "?# " } else { "#? " };
				text.extend_from_slice(&scalar_of(k, cx, vp, b"PS3").unwrap_or_else(|| ps3.into()));
				vp.out
					.push_back(PendingWrite { fd: 2, bytes: text.into(), off: 0 });
			}
			match probe::perform(k, cx, vp, &mut sc, &p) {
				Ok(r) => r,
				Err(key) => {
					if let Some(f) = vp.frames.last_mut() {
						f.scratch = Some(sc);
					}
					return Err(Flow::Block(key));
				},
			}
		};
		let ProbeResult::Input { data, eof, .. } = answer else {
			break None;
		};
		if eof && data.is_empty() {
			if zsh {
				// zsh `execselect`: `REPLY` empty, a newline on stderr; the
				// loop's status is its last command's.
				let reply = Some(Var::scalar(BString::default(), crate::bash::store::Attrs::NONE));
				state::store_var(&mut k.root, cx.store, vp, b"REPLY", reply, Level::Dynamic);
				vp.out
					.push_back(PendingWrite { fd: 2, bytes: BString::from("\n"), off: 0 });
				break None;
			}
			vp.out
				.push_back(PendingWrite { fd: 1, bytes: BString::from("\n"), off: 0 });
			if let Some(rec) = vp.frames.last_mut().and_then(|f| f.loops.last_mut()) {
				rec.status = 1;
			}
			break None;
		}
		let mut line = LineState::default();
		// REPLY is the whole line: character boundaries do not matter.
		line.feed(&data, false, Some(b'\n'), Charset::Bytes);
		let reply = line.finish().all();
		state::store_var(
			&mut k.root,
			cx.store,
			vp,
			b"REPLY",
			Some(Var::scalar(reply.clone(), crate::bash::store::Attrs::NONE)),
			Level::Dynamic,
		);
		if reply.is_empty() {
			print_menu = true;
			part += 1;
			continue;
		}
		let choice = if zsh {
			// zsh `atoi`: the leading digits.
			let digits = reply.iter().take_while(|c| c.is_ascii_digit()).count();
			std::str::from_utf8(&reply[..digits])
				.ok()
				.and_then(|s| s.parse::<usize>().ok())
		} else {
			number(&reply).and_then(|n| usize::try_from(n).ok())
		};
		let choice = choice.filter(|&n| n >= 1 && n <= items.len());
		break Some((var, choice.map_or_else(BString::default, |n| items[n - 1].clone())));
	};
	if let Some(rec) = vp.frames.last_mut().and_then(|f| f.loops.last_mut())
		&& let LoopKind::Select { first, more: m, .. } = &mut rec.kind
	{
		*first = false;
		*m = more;
	}
	Ok(result)
}

/// zsh `selectlist`: the menu page starting at row `start`, in columns
/// over `columns - 1` and at most `lines - 2` rows; the row the next page
/// starts at (0 once the menu is complete).
fn zsh_select_list(items: &[BString], start: u32, columns: usize, lines: usize) -> (Vec<u8>, u32) {
	let ct = items.len();
	let mut longest = items.iter().map(|i| i.len()).max().unwrap_or(0).max(1) + 1;
	let mut t0 = ct;
	while t0 > 0 {
		t0 /= 10;
		longest += 1;
	}
	let width = columns.saturating_sub(1);
	let fct = (width / (longest + 3)).max(1);
	let fw = if width / (longest + 3) == 0 {
		0
	} else {
		width / fct
	};
	let colsz = ct.div_ceil(fct);
	let start = start as usize;
	let mut out = Vec::new();
	let mut t1 = start;
	while t1 != colsz && t1 - start < lines.saturating_sub(2) {
		let mut ap = t1;
		loop {
			let n = ap + 1;
			let before = out.len();
			out.extend_from_slice(n.to_string().as_bytes());
			out.extend_from_slice(b") ");
			out.extend_from_slice(&items[ap]);
			let shown = out.len() - before;
			out.resize(before + shown.max(fw), b' ');
			ap += colsz;
			if ap >= ct {
				break;
			}
		}
		out.push(b'\n');
		t1 += 1;
	}
	let more = if t1 < colsz { t1 } else { 0 };
	(out, u32::try_from(more).unwrap_or(0))
}

#[cfg(test)]
mod tests {
	use super::*;

	fn echo_out(args: &[&str]) -> String {
		let args: Vec<BString> = args.iter().map(|a| BString::from(*a)).collect();
		let mut out = Vec::new();
		echo_bytes(&args, &mut out, false, true);
		String::from_utf8(out).unwrap()
	}

	// Goldens from bash 5.3.20: `echo -e "a\tb" -n; echo -n x; echo; echo -E
	// "a\\tb"; echo -- -n; echo -nn y; echo`.
	#[test]
	fn option_words_only_lead_and_only_from_n_e_e() {
		assert_eq!(echo_out(&["-e", "a\\tb", "-n"]), "a\tb -n\n");
		assert_eq!(echo_out(&["-n", "x"]), "x");
		assert_eq!(echo_out(&["-E", "a\\tb"]), "a\\tb\n");
		assert_eq!(echo_out(&["--", "-n"]), "-- -n\n");
		assert_eq!(echo_out(&["-nn", "y"]), "y");
		assert_eq!(echo_out(&["-"]), "-\n");
		assert_eq!(echo_out(&["-nx"]), "-nx\n");
	}

	#[test]
	fn escapes_decode_octal_hex_unicode_and_stop_at_backslash_c() {
		assert_eq!(echo_out(&["-e", "\\0101\\x42\\u00e9"]), "AB\u{e9}\n");
		assert_eq!(echo_out(&["-e", "a\\cb", "c"]), "a");
		assert_eq!(echo_out(&["-e", "\\xzz\\q\\"]), "\\xzz\\q\\\n");
	}

	fn marked(s: &str, raw: bool) -> Line {
		let mut st = LineState::default();
		st.feed(s.as_bytes(), raw, Some(b'\n'), Charset::Utf8);
		st.finish()
	}

	/// `read` into `n` variables, as the builtin splits.
	fn vars(input: &str, ifs: &str, count: usize) -> Vec<String> {
		let (ifs, line) = (Ifs::new(ifs.as_bytes(), Charset::Utf8), marked(input, false));
		let mut at = skip_ifs_ws(&ifs, &line);
		let mut out = Vec::new();
		for _ in 1..count {
			let value = if at < line.len() {
				let (word, next) = field(&ifs, &line, at);
				at = next;
				word
			} else {
				BString::default()
			};
			out.push(value.to_string());
		}
		out.push(last_value(&ifs, &line, at).to_string());
		out
	}

	// Goldens: bash 5.3.20 `IFS=… read a b <<< …; echo "[$a][$b]"`.
	#[test]
	fn last_variable_takes_the_rest_minus_one_trailing_delimiter() {
		assert_eq!(vars("x:y:\n", ":", 2), ["x", "y"]);
		assert_eq!(vars("x:y:z:\n", ":", 2), ["x", "y:z:"]);
		assert_eq!(vars(" x : y :  \n", ": ", 2), ["x", "y"]);
		assert_eq!(vars("  lead  trail  \n", " \t\n", 1), ["lead  trail"]);
		assert_eq!(vars("a\\ b c\n", " \t\n", 2), ["a b", "c"]);
	}

	// Golden: bash 5.3.20 read9.sub: with a non-default IFS every `isspace`
	// character in it is IFS whitespace (trailing `\t\r\f\v` go), a space
	// outside IFS stays.
	#[test]
	fn non_default_ifs_whitespace_is_isspace() {
		assert_eq!(vars("  line\tb \t\r\x0c\x0b\n", "\t\r\x0c\x0b", 2), ["  line", "b "]);
		assert_eq!(vars("a : b\n", ": ", 2), ["a", "b"]);
		assert_eq!(vars("a :: b\n", ": ", 3), ["a", "", "b"]);
	}

	// Goldens: bash 5.3.20 read.tests `echo " a  b\ " | read x [y]`: the
	// last variable keeps an escaped blank only when it is a single field.
	#[test]
	fn escaped_trailing_blank_survives_only_in_a_single_field() {
		assert_eq!(vars(" a  b\\ \n", " \t\n", 2), ["a", "b "]);
		assert_eq!(vars(" a  b\\ \n", " \t\n", 1), ["a  b"]);
		assert_eq!(vars(" a  b  \n", " \t\n", 1), ["a  b"]);
	}

	// `read -n` counts characters: a UTF-8 character's bytes count once,
	// backslashes and NULs not at all.
	#[test]
	fn character_count_follows_bash() {
		let mut st = LineState::default();
		st.feed("é\\x\0y".as_bytes(), false, Some(b'\n'), Charset::Utf8);
		assert_eq!(st.line.len(), 3);
		assert!(st.full(3));
		let mut st = LineState::default();
		st.feed(&[0xc3], false, Some(b'\n'), Charset::Utf8);
		assert!(!st.full(1));
		assert_eq!(st.want(1), 1);
		let mut st = LineState::default();
		st.feed(&[0xc3, 0xa9], false, None, Charset::Bytes);
		assert_eq!(st.line.len(), 2);
	}

	// Goldens: bash 5.3.20 glob2.sub under `LC_ALL=zh_TW.big5`: α is
	// \xa3\x5c; its `\` byte is part of the character, not an escape, and
	// an IFS of α splits on the whole character.
	#[test]
	fn multibyte_characters_are_read_and_split_whole() {
		let big5 = Charset::Encoding(encoding_rs::BIG5);
		let mut st = LineState::default();
		st.feed(b"\xa3\\ b c\n", false, Some(b'\n'), big5);
		let line = st.finish();
		let ws = Ifs::new(b" \t\n", big5);
		let at = skip_ifs_ws(&ws, &line);
		let (first, next) = field(&ws, &line, at);
		assert_eq!(first, &b"\xa3\\"[..]);
		assert_eq!(field(&ws, &line, next).0, "b");
		let mut st = LineState::default();
		st.feed(b"A\xa3\\B\n", false, Some(b'\n'), big5);
		let line = st.finish();
		assert_eq!(split_all(&Ifs::new(b"\xa3\\", big5), &line), ["A", "B"]);
		// A UTF-8 IFS character splits only on itself, not on its bytes.
		let mut st = LineState::default();
		st.feed("aébé".as_bytes(), true, None, Charset::Utf8);
		assert_eq!(split_all(&Ifs::new("é".as_bytes(), Charset::Utf8), &st.finish()), ["a", "b"]);
	}

	#[test]
	fn read_a_splits_every_field_and_keeps_empty_inner_ones() {
		let f: Vec<String> = split_all(&Ifs::new(b":", Charset::Utf8), &marked("a::b:\n", false))
			.into_iter()
			.map(|b| b.to_string())
			.collect();
		assert_eq!(f, ["a", "", "b"]);
		let f: Vec<String> =
			split_all(&Ifs::new(b"/", Charset::Utf8), &marked("/kghfjk/jkfzuk/i\n", true))
				.into_iter()
				.map(|b| b.to_string())
				.collect();
		assert_eq!(f, ["", "kghfjk", "jkfzuk", "i\n"].map(|s| s.trim_end_matches('\n').to_owned()));
	}

	#[test]
	fn backslash_newline_continues_unless_raw() {
		let mut st = LineState::default();
		assert!(!st.feed(b"x\\\n", false, Some(b'\n'), Charset::Utf8));
		assert!(LineState::default().feed(b"x\\\n", true, Some(b'\n'), Charset::Utf8));
		// An escaped delimiter other than newline is kept.
		let mut st = LineState::default();
		assert!(!st.feed(b"a\\;", false, Some(b';'), Charset::Utf8));
		assert!(st.feed(b"b;", false, Some(b';'), Charset::Utf8));
		assert_eq!(st.finish().all(), "a;b");
	}

	// Golden: bash 5.3.20 `select x in $(seq 30)` with COLUMNS unset.
	#[test]
	fn select_menu_columns_match_bash() {
		let items: Vec<BString> = (1..=30).map(|i| BString::from(i.to_string())).collect();
		let menu = String::from_utf8(select_menu(&items, 80)).unwrap();
		let first = menu.lines().next().unwrap();
		assert_eq!(
			first,
			"1) 1\t 4) 4\t 7) 7\t10) 10\t13) 13\t16) 16\t19) 19\t22) 22\t25) 25\t28) 28"
		);
		let items: Vec<BString> = ["a", "b", "c"].map(BString::from).to_vec();
		assert_eq!(String::from_utf8(select_menu(&items, 80)).unwrap(), "1) a\n2) b\n3) c\n");
	}
}
