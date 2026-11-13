//! Values as jq's error messages mention them.
//!
//! jq names a value by its kind and an abbreviated compact dump, as in
//! `Cannot iterate over number (123)` or
//! `string ("very-long-long-long-long...") cannot be negated`.
//! [`describe`] reproduces that; [`type_error`] and [`type_error2`] build the
//! errors jq's `type_error`/`type_error2` (src/builtin.c) raise.
use crate::{Error, Val};
use alloc::string::String;

/// Size of the buffer jq abbreviates a value into for its messages
/// (`char errbuf[30]` throughout jq's sources), including the C string's NUL.
pub const ERRBUF: usize = 30;

/// jq's name for the kind of `v` (`jv_kind_name`).
pub fn kind_name(v: &Val) -> &'static str {
    match v {
        Val::Null => "null",
        Val::Bool(_) => "boolean",
        Val::Num(_) => "number",
        Val::BStr(_) | Val::TStr(_) => "string",
        Val::Arr(_) => "array",
        Val::Obj(_) => "object",
    }
}

/// `v` dumped as compact JSON and cut to fit a C buffer of `bufsize` bytes,
/// ending in `...` and the closing delimiter when cut (`jv_dump_string_trunc`).
pub fn dump_trunc(v: &Val, bufsize: usize) -> String {
    // a long string is cut to its first `bufsize` codepoints before dumping,
    // as jq does, so that dumping never escapes more than can be shown
    let dumped = match v {
        Val::TStr(s) | Val::BStr(s) if s.len() > bufsize => {
            use bstr::ByteSlice;
            let end = s.char_indices().nth(bufsize).map_or(s.len(), |(start, ..)| start);
            alloc::format!("{}", Val::utf8_str(s.slice(..end)))
        }
        v => alloc::format!("{v}"),
    };
    let bytes = dumped.as_bytes();
    if bytes.len() <= bufsize - 1 {
        return dumped;
    }
    if bufsize < 8 {
        return String::from_utf8_lossy(&bytes[..bufsize - 1]).into_owned();
    }
    let delim = match bytes[0] {
        b'"' => Some('"'),
        b'[' => Some(']'),
        b'{' => Some('}'),
        _ => None,
    };
    let mut l = bufsize - if delim.is_some() { 5 } else { 4 };
    // do not cut a UTF-8 sequence: start the cut at the last codepoint's start
    while l > 0 && !dumped.is_char_boundary(l) {
        l -= 1;
    }
    let mut out = String::from(&dumped[..l]);
    out.push_str("...");
    out.extend(delim);
    out
}

/// `v` as jq's messages show it: `<kind> (<abbreviated dump>)`.
pub fn describe(v: &Val) -> String {
    alloc::format!("{} ({})", kind_name(v), dump_trunc(v, ERRBUF))
}

/// The error about a non-string object key `k`: `Cannot use <kind> (<dump>)
/// as object key`, as jq's `INSERT`/`jv_object_set` paths.
pub fn object_key(k: &Val) -> Error {
    Error::str(alloc::format!("Cannot use {} as object key", describe(k)))
}

/// The error `<kind> (<dump>) <msg>` about `v`, as jq's `type_error`.
pub fn type_error(v: &Val, msg: &str) -> Error {
    Error::str(alloc::format!("{} {msg}", describe(v)))
}

/// The error `<kind> (<dump>) and <kind> (<dump>) <msg>` about `a` and `b`,
/// as jq's `type_error2`.
pub fn type_error2(a: &Val, b: &Val, msg: &str) -> Error {
    Error::str(alloc::format!("{} and {} {msg}", describe(a), describe(b)))
}
