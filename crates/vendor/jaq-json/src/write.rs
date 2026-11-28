//! Functions and macros for writing (parts of) values.
//!
//! We use a macro so that we can create both
//! formatters ([core::fmt::Formatter]) and
//! writers ([std::io::Write]) from the same code.

use crate::{Map, Val};
use alloc::string::String;
use alloc::vec::Vec;
use core::fmt::{self, Formatter};
#[cfg(feature = "std")]
use std::io;

/// Write a byte.
///
/// This uses `$f` to write bytes not corresponding to normal ASCII characters.
///
/// This is especially useful to pretty-print control characters, such as
/// `'\n'` (U+000A), but also all other control characters.
#[macro_export]
macro_rules! write_byte {
    ($w:ident, $c:expr, $f:expr) => {{
        match $c {
            // Rust does not recognise the following two character escapes
            0x08 => write!($w, "\\b"),
            0x0c => write!($w, "\\f"),
            c @ (b'\t' | b'\n' | b'\r' | b'\\' | b'"') => {
                write!($w, "{}", char::from(c).escape_default())
            }
            0x00..=0x1F | 0x7F..=0xFF => $f,
            c => write!($w, "{}", char::from(c)),
        }
    }};
}

/// Write a UTF-8 string as JSON string, including leading and trailing quotes,
/// as jq does (see [`write_str_with`]).
///
/// This passes all output, which is valid UTF-8, to `$f` as byte slices.
#[macro_export]
macro_rules! write_utf8 {
    ($w:ident, $s:ident, $f:expr) => {{
        $crate::write::write_str_with(&$s[..], false, &mut |part: &[u8]| $f(part))
    }};
}

/// Decode the UTF-8 sequence at the start of non-empty `b` as jq's
/// `jvp_utf8_next`, returning its codepoint (`None` if invalid) and length.
///
/// An invalid sequence spans the bytes jq skips over at once, which is
/// what one U+FFFD replaces.
pub fn utf8_next(b: &[u8]) -> (Option<u32>, usize) {
    let first = b[0];
    let len = match first {
        0x00..=0x7F => return (Some(u32::from(first)), 1),
        0xC2..=0xDF => 2,
        0xE0..=0xEF => 3,
        0xF0..=0xF4 => 4,
        _ => return (None, 1),
    };
    if len > b.len() {
        return (None, b.len());
    }
    let mut c = u32::from(first) & (0x7F >> len);
    for (i, &ch) in b[1..len].iter().enumerate() {
        if ch & 0xC0 != 0x80 {
            return (None, i + 1);
        }
        c = (c << 6) | u32::from(ch & 0x3F);
    }
    let min = [0, 0, 0x80, 0x800, 0x10000][len];
    let valid = c >= min && !(0xD800..=0xDFFF).contains(&c) && c <= 0x10FFFF;
    (valid.then_some(c), len)
}

/// Write a string as JSON string, including leading and trailing quotes,
/// as jq's `jvp_dump_string`.
///
/// `"`, `\`, `\b`, `\t`, `\r`, `\n`, `\f` get backslash escapes, other ASCII
/// control characters and DEL `\u00XX` escapes, and invalid UTF-8 becomes
/// U+FFFD. With `ascii`, every non-ASCII character is written as `\uXXXX`
/// (a surrogate pair beyond U+FFFF).
/// All output passed to `out` is valid UTF-8.
pub fn write_str_with<E>(
    s: &[u8],
    ascii: bool,
    out: &mut impl FnMut(&[u8]) -> Result<(), E>,
) -> Result<(), E> {
    let mut buf = [0u8; 12];
    let mut esc = |c: u32, out: &mut dyn FnMut(&[u8]) -> Result<(), E>| {
        let hex = |v: u32, b: &mut [u8]| {
            const HEX: &[u8; 16] = b"0123456789abcdef";
            b[0] = b'\\';
            b[1] = b'u';
            (0..4).for_each(|i| b[2 + i] = HEX[(v >> (12 - 4 * i)) as usize & 0xF]);
        };
        if c <= 0xFFFF {
            hex(c, &mut buf[..6]);
            out(&buf[..6])
        } else {
            let c = c - 0x10000;
            hex(0xD800 | ((c >> 10) & 0x3FF), &mut buf[..6]);
            hex(0xDC00 | (c & 0x3FF), &mut buf[6..12]);
            out(&buf[..12])
        }
    };
    out(b"\"")?;
    let mut start = 0;
    let mut i = 0;
    while i < s.len() {
        let c = s[i];
        if (0x20..0x7F).contains(&c) && c != b'"' && c != b'\\' {
            i += 1;
            continue;
        }
        out(&s[start..i])?;
        if c < 0x80 {
            let short = match c {
                b'"' => Some(&b"\\\""[..]),
                b'\\' => Some(&b"\\\\"[..]),
                0x08 => Some(&b"\\b"[..]),
                b'\t' => Some(&b"\\t"[..]),
                b'\r' => Some(&b"\\r"[..]),
                b'\n' => Some(&b"\\n"[..]),
                0x0C => Some(&b"\\f"[..]),
                _ => None,
            };
            match short {
                Some(e) => out(e)?,
                None => esc(u32::from(c), out)?,
            }
            i += 1;
        } else {
            let (cp, len) = utf8_next(&s[i..]);
            match (cp, ascii) {
                (Some(cp), true) => esc(cp, out)?,
                (Some(_), false) => out(&s[i..i + len])?,
                (None, true) => esc(0xFFFD, out)?,
                (None, false) => out("\u{FFFD}".as_bytes())?,
            }
            i += len;
        }
        start = i;
    }
    out(&s[start..])?;
    out(b"\"")
}

/// Write a string as JSON string to `w`, as [`write_str_with`].
#[cfg(feature = "std")]
pub fn write_str(w: &mut (impl io::Write + ?Sized), s: &[u8], ascii: bool) -> io::Result<()> {
    write_str_with(s, ascii, &mut |b: &[u8]| w.write_all(b))
}

/// Write a byte string, including leading and trailing quotes.
///
/// This maps all non-ASCII `u8`s to `\xXX`.
#[macro_export]
macro_rules! write_bytes {
    ($w:ident, $s:ident) => {{
        write!($w, "b\"")?;
        $s.iter()
            .try_for_each(|c| $crate::write_byte!($w, *c, write!($w, "\\x{c:02x}")))?;
        write!($w, "\"")
    }};
}

/// Write a comma-separated sequence of values `$xs` with `$f`.
#[macro_export]
macro_rules! write_seq {
    ($w:ident, $pp:expr, $level:expr, $xs:expr, $f:expr) => {{
        let indent = &$pp.indent;
        if indent.is_some() {
            writeln!($w)?;
        }
        let mut iter = $xs.into_iter().peekable();
        while let Some(x) = iter.next() {
            if let Some(indent) = indent {
                write!($w, "{}", indent.repeat($level + 1))?;
            }
            $f(x)?;
            if iter.peek().is_some() {
                write!($w, ",")?;
                if $pp.sep_space && indent.is_none() {
                    write!($w, " ")?
                }
            }
            if indent.is_some() {
                writeln!($w)?
            }
        }
        if let Some(indent) = indent {
            write!($w, "{}", indent.repeat($level))
        } else {
            Ok(())
        }
    }};
}

/// Styles used to pretty-print values.
#[derive(Clone, Default)]
pub struct Styles<S = String> {
    /// null
    pub null: S,
    /// false
    pub r#false: S,
    /// true
    pub r#true: S,
    /// numbers
    pub num: S,
    /// strings
    pub str: S,
    /// arrays
    pub arr: S,
    /// objects
    pub obj: S,
    /// object keys
    pub key: S,

    /// byte strings
    pub bstr: S,

    /// reset pretty printer
    pub reset: S,
}

impl Styles {
    /// Default ANSI styles
    pub fn ansi() -> Self {
        let mut cols = Styles::default().parse("90:39:39:39:32:1;39:1;39:1;34");
        cols.bstr = "\x1b[31m".into();
        cols.reset = "\x1b[0m".into();
        cols
    }

    /// Overwrite styles with those present in `JQ_COLORS` environment variable.
    pub fn parse(mut self, s: &str) -> Self {
        let fields = [
            &mut self.null,
            &mut self.r#false,
            &mut self.r#true,
            &mut self.num,
            &mut self.str,
            &mut self.arr,
            &mut self.obj,
            &mut self.key,
        ];
        for (style, field) in s.split(':').zip(fields) {
            *field = if style.is_empty() {
                "".into()
            } else {
                alloc::format!("\x1b[{style}m")
            }
        }
        self
    }
}

/// Pretty printer.
#[derive(Clone, Default)]
pub struct Pp<S = String> {
    /// indent by repeating given string `n` times
    pub indent: Option<S>,
    /// sort objects by keys
    pub sort_keys: bool,
    /// styles for different types of values
    pub styles: Styles<S>,
    /// put a space after ':'
    ///
    /// This is necessary for YAML, which interprets
    /// {1:2}  as {"1:2": null}, whereas it interprets
    /// {1: 2} as {1: 2}.
    pub sep_space: bool,
    /// write non-ASCII characters in strings as `\uXXXX` escapes (`jq -a`)
    pub ascii: bool,
}

/// Deepest nesting level that printing descends into, as jq's
/// `MAX_PRINT_DEPTH`. A value nested deeper prints as [`TOO_DEEP`].
pub const MAX_DEPTH: usize = 10_000;

/// What printing writes in place of a value nested deeper than [`MAX_DEPTH`].
pub const TOO_DEEP: &str = "<skipped: too deep>";

/// Apply a style `$style` to the output of `$f`.
#[macro_export]
macro_rules! style {
    ($w:ident, $pp:ident, $style:ident, $f:expr) => {{
        let style = &$pp.styles.$style;
        let reset = if style.is_empty() {
            ""
        } else {
            &*$pp.styles.reset
        };
        write!($w, "{style}")?;
        $f?;
        write!($w, "{reset}")
    }};
}

/// One piece of output for [`print_iter`].
pub enum Emit<'a> {
    /// Bytes to write; these are always valid UTF-8.
    Bytes(&'a [u8]),
    /// Pre-formatted text to write.
    Args(fmt::Arguments<'a>),
}

/// The sink [`print_iter`] writes to: it receives each [`Emit`] and may fail.
pub type Emitter<'e, E> = dyn for<'a> FnMut(Emit<'a>) -> Result<(), E> + 'e;

/// Write the indent of level `level`, as `Pp::indent` repeated.
fn emit_indent<E>(emit: &mut Emitter<'_, E>, pp: &Pp, level: usize) -> Result<(), E> {
    if let Some(indent) = &pp.indent {
        for _ in 0..level {
            emit(Emit::Bytes(indent.as_bytes()))?;
        }
    }
    Ok(())
}

/// Write `content` wrapped in `style`, resetting afterwards if styled.
fn emit_styled<E>(emit: &mut Emitter<'_, E>, style: &str, reset: &str, content: &[u8]) -> Result<(), E> {
    if !style.is_empty() {
        emit(Emit::Bytes(style.as_bytes()))?;
    }
    emit(Emit::Bytes(content))?;
    if !style.is_empty() {
        emit(Emit::Bytes(reset.as_bytes()))?;
    }
    Ok(())
}

/// Write a value as JSON to `emit`, without recursing on the native stack.
///
/// This reproduces [`write_val`] / [`format_val`]'s output exactly: the same
/// pretty-printing, escaping, key sorting and `<skipped: too deep>` handling,
/// but with an explicit traversal stack, so deeply nested values cannot
/// overflow the stack.
pub fn print_iter<E>(pp: &Pp, level: usize, v: &Val, emit: &mut Emitter<'_, E>) -> Result<(), E> {
    /// The entries of an object, sorted or in insertion order.
    enum Entries<'a> {
        Plain(&'a Map<Val, Val>),
        Sorted(Vec<(&'a Val, &'a Val)>),
    }

    impl<'a> Entries<'a> {
        fn len(&self) -> usize {
            match self {
                Entries::Plain(m) => m.len(),
                Entries::Sorted(v) => v.len(),
            }
        }

        fn get(&self, i: usize) -> (&'a Val, &'a Val) {
            match self {
                Entries::Plain(m) => m.get_index(i).expect("entry index is in range"),
                Entries::Sorted(v) => {
                    let (k, v) = v[i];
                    (k, v)
                }
            }
        }
    }

    /// A container being printed and how far it has been printed.
    enum Frame<'a> {
        Arr {
            items: &'a [Val],
            i: usize,
            level: usize,
            pp: &'a Pp,
        },
        Obj {
            entries: Entries<'a>,
            i: usize,
            level: usize,
            /// Whether the key of entry `i - 1` is being printed.
            key: bool,
            pp: &'a Pp,
        },
    }

    // Object keys are printed without styles (but with a key style wrapper),
    // so build an unstyled `Pp` for them if the key style is set.
    let unstyled = (!pp.styles.key.is_empty()).then(|| Pp { styles: Styles::default(), ..pp.clone() });
    let key_pp = unstyled.as_ref().unwrap_or(pp);

    let mut stack: Vec<Frame> = Vec::new();
    let mut cur: Option<(&Val, usize, &Pp)> = Some((v, level, pp));

    loop {
        if let Some((x, lv, xpp)) = cur.take() {
            if lv > MAX_DEPTH {
                emit(Emit::Bytes(TOO_DEEP.as_bytes()))?;
            } else {
                match x {
                    Val::Null => emit_styled(emit, &xpp.styles.null, &xpp.styles.reset, b"null")?,
                    Val::Bool(true) => emit_styled(emit, &xpp.styles.r#true, &xpp.styles.reset, b"true")?,
                    Val::Bool(false) => emit_styled(emit, &xpp.styles.r#false, &xpp.styles.reset, b"false")?,
                    Val::Num(n) => {
                        let style = &xpp.styles.num;
                        if !style.is_empty() {
                            emit(Emit::Bytes(style.as_bytes()))?;
                        }
                        emit(Emit::Args(format_args!("{n}")))?;
                        if !style.is_empty() {
                            emit(Emit::Bytes(xpp.styles.reset.as_bytes()))?;
                        }
                    }
                    Val::BStr(b) => {
                        let style = &xpp.styles.bstr;
                        if !style.is_empty() {
                            emit(Emit::Bytes(style.as_bytes()))?;
                        }
                        emit(Emit::Bytes(b"b\""))?;
                        const HEX: &[u8; 16] = b"0123456789abcdef";
                        for &c in b.iter() {
                            match c {
                                0x08 => emit(Emit::Bytes(b"\\b"))?,
                                0x0c => emit(Emit::Bytes(b"\\f"))?,
                                b'\t' => emit(Emit::Bytes(b"\\t"))?,
                                b'\n' => emit(Emit::Bytes(b"\\n"))?,
                                b'\r' => emit(Emit::Bytes(b"\\r"))?,
                                b'\\' => emit(Emit::Bytes(b"\\\\"))?,
                                b'"' => emit(Emit::Bytes(b"\\\""))?,
                                c @ (0x00..=0x1F | 0x7F..=0xFF) => {
                                    let esc = [b'\\', b'x', HEX[usize::from(c >> 4)], HEX[usize::from(c & 0xF)]];
                                    emit(Emit::Bytes(&esc))?;
                                }
                                c => emit(Emit::Bytes(core::slice::from_ref(&c)))?,
                            }
                        }
                        emit(Emit::Bytes(b"\""))?;
                        if !style.is_empty() {
                            emit(Emit::Bytes(xpp.styles.reset.as_bytes()))?;
                        }
                    }
                    Val::TStr(s) => {
                        let style = &xpp.styles.str;
                        if !style.is_empty() {
                            emit(Emit::Bytes(style.as_bytes()))?;
                        }
                        write_str_with(&s[..], xpp.ascii, &mut |part: &[u8]| emit(Emit::Bytes(part)))?;
                        if !style.is_empty() {
                            emit(Emit::Bytes(xpp.styles.reset.as_bytes()))?;
                        }
                    }
                    Val::Arr(a) => {
                        let items: &[Val] = a;
                        emit_styled(emit, &xpp.styles.arr, &xpp.styles.reset, b"[")?;
                        if items.is_empty() {
                            emit_styled(emit, &xpp.styles.arr, &xpp.styles.reset, b"]")?;
                        } else {
                            if xpp.indent.is_some() {
                                emit(Emit::Bytes(b"\n"))?;
                            }
                            stack.push(Frame::Arr { items, i: 0, level: lv, pp: xpp });
                        }
                    }
                    Val::Obj(o) => {
                        let m: &Map<Val, Val> = o;
                        emit_styled(emit, &xpp.styles.obj, &xpp.styles.reset, b"{")?;
                        if m.is_empty() {
                            emit_styled(emit, &xpp.styles.obj, &xpp.styles.reset, b"}")?;
                        } else {
                            if xpp.indent.is_some() {
                                emit(Emit::Bytes(b"\n"))?;
                            }
                            let entries = if xpp.sort_keys {
                                let mut entries: Vec<(&Val, &Val)> = m.iter().collect();
                                entries.sort_by_key(|(k, _v)| *k);
                                Entries::Sorted(entries)
                            } else {
                                Entries::Plain(m)
                            };
                            stack.push(Frame::Obj { entries, i: 0, level: lv, key: false, pp: xpp });
                        }
                    }
                }
            }
        }

        // Start the next element of the top frame, or close the frame.
        {
            let Some(frame) = stack.last_mut() else { return Ok(()) };
            match frame {
                Frame::Arr { items, i, level, pp: fpp } => {
                    if *i < items.len() {
                        if *i > 0 {
                            emit(Emit::Bytes(b","))?;
                            if fpp.sep_space && fpp.indent.is_none() {
                                emit(Emit::Bytes(b" "))?;
                            }
                            if fpp.indent.is_some() {
                                emit(Emit::Bytes(b"\n"))?;
                            }
                        }
                        emit_indent(emit, *fpp, *level + 1)?;
                        let x = &items[*i];
                        let child = Some((x, *level + 1, *fpp));
                        *i += 1;
                        cur = child;
                        continue;
                    }
                    // The frame is done: write its closing delimiter.
                    if fpp.indent.is_some() {
                        emit(Emit::Bytes(b"\n"))?;
                    }
                    emit_indent(emit, *fpp, *level)?;
                    emit_styled(emit, &fpp.styles.arr, &fpp.styles.reset, b"]")?;
                }
                Frame::Obj { entries, i, level, key, pp: fpp } => {
                    if *key {
                        // The key of entry `i - 1` was just printed.
                        if !fpp.styles.key.is_empty() {
                            emit(Emit::Bytes(fpp.styles.reset.as_bytes()))?;
                        }
                        emit_styled(emit, &fpp.styles.obj, &fpp.styles.reset, b":")?;
                        if fpp.sep_space {
                            emit(Emit::Bytes(b" "))?;
                        }
                        let (_, val) = entries.get(*i - 1);
                        let child = Some((val, *level + 1, *fpp));
                        *key = false;
                        cur = child;
                        continue;
                    }
                    if *i < entries.len() {
                        if *i > 0 {
                            emit(Emit::Bytes(b","))?;
                            if fpp.sep_space && fpp.indent.is_none() {
                                emit(Emit::Bytes(b" "))?;
                            }
                            if fpp.indent.is_some() {
                                emit(Emit::Bytes(b"\n"))?;
                            }
                        }
                        emit_indent(emit, *fpp, *level + 1)?;
                        if !fpp.styles.key.is_empty() {
                            emit(Emit::Bytes(fpp.styles.key.as_bytes()))?;
                        }
                        let (k, _) = entries.get(*i);
                        let child = Some((k, *level + 1, key_pp));
                        *key = true;
                        *i += 1;
                        cur = child;
                        continue;
                    }
                    // The frame is done: write its closing delimiter.
                    if fpp.indent.is_some() {
                        emit(Emit::Bytes(b"\n"))?;
                    }
                    emit_indent(emit, *fpp, *level)?;
                    emit_styled(emit, &fpp.styles.obj, &fpp.styles.reset, b"}")?;
                }
            }
        }
        stack.pop();
    }
}

/// Write a value as JSON to a writer, as [`format_val`] to a formatter.
#[macro_export]
macro_rules! format_val {
    ($w:ident, $pp:ident, $level:expr, $v:ident, $f:expr) => {{
        $crate::write::print_iter($pp, $level, $v, &mut |__e| match __e {
            $crate::write::Emit::Bytes(__b) => write!($w, "{}", $crate::bstr(__b)),
            $crate::write::Emit::Args(__a) => $w.write_fmt(__a),
        })
    }};
}

/// Write a value as JSON, using a custom function for child values.
#[macro_export]
macro_rules! write_val {
    ($w:ident, $pp:ident, $level:expr, $v:ident, $f:expr) => {
        $crate::format_val!($w, $pp, $level, $v, $f)
    };
}

/// Write a value as JSON.
///
/// Note that unlike jq, this may actually produce invalid JSON.
/// In particular, this may yield:
///
/// - literals for special floating-point values (NaN, Infinity, -Infinity)
/// - invalid UTF-8 characters
/// - byte strings with `\xXX` sequences
/// - objects with non-string keys
///
/// The key principles behind this behaviour are:
///
/// 1. Printing a value should always succeed.
///    (Otherwise, there would exist values that we could not even inspect.)
/// 2. Printing a value should yield valid JSON if and only if
///    the value can be represented by an equivalent JSON value.
///    (To give users a chance to find non-JSON values and to take appropriate action.)
///
/// jq and jaq agree on principle 1, but disagree on principle 2.
/// In particular, this shows by the fact that `jq -n 'nan'` yields `null`.
/// That means that jq maps values that cannot be represented by JSON
/// to different values that can be represented by JSON.
///
/// In summary,
/// jq may cause silent information loss, whereas
/// jaq may yield invalid JSON values.
/// Choose your poison.
#[cfg(feature = "std")]
pub fn write(w: &mut dyn io::Write, pp: &Pp, level: usize, v: &Val) -> io::Result<()> {
    write_val!(w, pp, level, v, write)
}

pub(crate) struct Buf(pub(crate) alloc::vec::Vec<u8>);

impl Buf {
    fn write_all(&mut self, bytes: &[u8]) -> fmt::Result {
        self.0.extend_from_slice(bytes);
        Ok(())
    }
}

impl fmt::Write for Buf {
    fn write_str(&mut self, s: &str) -> fmt::Result {
        self.write_all(s.as_bytes())
    }
}

pub(crate) fn write_buf(w: &mut Buf, pp: &Pp, level: usize, v: &Val) -> fmt::Result {
    use core::fmt::Write;
    write_val!(w, pp, level, v, write_buf)
}

pub(crate) fn format(w: &mut Formatter, pp: &Pp, level: usize, v: &Val) -> fmt::Result {
    format_val!(w, pp, level, v, format)
}
