//! Compile-time constants, as jq folds them while parsing.
//!
//! jq's parser turns literals, strings without interpolation, arrays and
//! objects of constants, and arithmetic or comparisons of constants into
//! constants (`gen_const`, `gen_const_array`, `gen_const_object` and
//! `constant_fold` in `src/compile.c` and `src/parser.y`).
//! Whether a term is constant decides some errors, such as
//! `Cannot use number (0) as object key` and `Module metadata must be constant`,
//! and module metadata is kept as a constant for `modulemeta`.

use super::lex::StrPart;
use super::parse::{BinaryOp, Term};
use crate::ops::{Cmp, Math};
use alloc::{string::String, vec::Vec};
use core::cmp::Ordering;
use core::fmt::Write;

/// Constant JSON value.
#[derive(Clone, Debug, PartialEq)]
pub enum Const {
    /// `null`
    Null,
    /// `true` or `false`
    Bool(bool),
    /// number literal, as written
    Lit(String),
    /// number computed by folding
    Num(f64),
    /// string
    Str(String),
    /// array
    Arr(Vec<Const>),
    /// object, in insertion order
    Obj(Vec<(String, Const)>),
}

impl Const {
    /// jq's name for the kind of the value (`jv_kind_name`).
    pub fn kind_name(&self) -> &'static str {
        match self {
            Self::Null => "null",
            Self::Bool(_) => "boolean",
            Self::Lit(_) | Self::Num(_) => "number",
            Self::Str(_) => "string",
            Self::Arr(_) => "array",
            Self::Obj(_) => "object",
        }
    }

    fn rank(&self) -> u8 {
        match self {
            Self::Null => 0,
            Self::Bool(false) => 1,
            Self::Bool(true) => 2,
            Self::Lit(_) | Self::Num(_) => 3,
            Self::Str(_) => 4,
            Self::Arr(_) => 5,
            Self::Obj(_) => 6,
        }
    }

    /// The value of a number.
    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Self::Lit(l) => Some(l.parse().unwrap_or(f64::INFINITY)),
            Self::Num(n) => Some(*n),
            _ => None,
        }
    }

    /// Look up a key of an object.
    pub fn get(&self, key: &str) -> Option<&Self> {
        match self {
            Self::Obj(kvs) => kvs.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    fn insert(kvs: &mut Vec<(String, Self)>, k: String, v: Self) {
        match kvs.iter_mut().find(|(k_, _)| *k_ == k) {
            Some(kv) => kv.1 = v,
            None => kvs.push((k, v)),
        }
    }

    /// Compact JSON, as jq dumps it.
    pub fn dump(&self) -> String {
        let mut s = String::new();
        self.dump_to(&mut s);
        s
    }

    fn dump_to(&self, out: &mut String) {
        match self {
            Self::Null => out.push_str("null"),
            Self::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            Self::Lit(l) => out.push_str(l),
            Self::Num(n) => fmt_f64(*n, out),
            Self::Str(s) => dump_str(s, out),
            Self::Arr(a) => {
                out.push('[');
                for (i, x) in a.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    x.dump_to(out);
                }
                out.push(']');
            }
            Self::Obj(o) => {
                out.push('{');
                for (i, (k, v)) in o.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    dump_str(k, out);
                    out.push(':');
                    v.dump_to(out);
                }
                out.push('}');
            }
        }
    }

    /// `<kind> (<abbreviated dump>)`, as jq names values in its messages.
    pub fn describe(&self) -> String {
        alloc::format!("{} ({})", self.kind_name(), dump_trunc(&self.dump(), 30))
    }
}

/// Cut `dumped` to fit a C buffer of `bufsize` bytes, ending in `...` and the
/// closing delimiter when cut, as jq's `jv_dump_string_trunc`.
pub fn dump_trunc(dumped: &str, bufsize: usize) -> String {
    let bytes = dumped.as_bytes();
    if bytes.len() < bufsize {
        return dumped.into();
    }
    let delim = match bytes.first() {
        Some(b'"') => Some('"'),
        Some(b'[') => Some(']'),
        Some(b'{') => Some('}'),
        _ => None,
    };
    let mut l = bufsize - if delim.is_some() { 5 } else { 4 };
    while l > 0 && !dumped.is_char_boundary(l) {
        l -= 1;
    }
    let mut out = String::from(&dumped[..l]);
    out.push_str("...");
    out.extend(delim);
    out
}

fn dump_str(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            '\r' => out.push_str("\\r"),
            '\x08' => out.push_str("\\b"),
            '\x0c' => out.push_str("\\f"),
            c if (c as u32) < 0x20 || c == '\x7f' => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// A double as jq prints it (`jvp_dtoa_fmt`): the shortest representation,
/// in exponential notation if the decimal exponent is below -4 or above 17.
fn fmt_f64(n: f64, out: &mut String) {
    if n.is_nan() {
        return out.push_str("null");
    }
    let n = n.clamp(f64::MIN, f64::MAX);
    if n == 0.0 {
        return out.push_str(if n.is_sign_negative() { "-0" } else { "0" });
    }
    let e = alloc::format!("{:e}", n.abs());
    let (mant, exp) = e.split_once('e').unwrap_or((&e, "0"));
    let digits: String = mant.chars().filter(char::is_ascii_digit).collect();
    let decpt = exp.parse::<i32>().unwrap_or(0) + 1;
    if n < 0.0 {
        out.push('-');
    }
    let nd = digits.len() as i32;
    if decpt <= -4 || decpt > nd + 15 {
        out.push_str(&digits[..1]);
        if nd > 1 {
            out.push('.');
            out.push_str(&digits[1..]);
        }
        let _ = write!(out, "e{}{:02}", if decpt - 1 < 0 { '-' } else { '+' }, (decpt - 1).abs());
    } else if decpt <= 0 {
        out.push_str("0.");
        (0..-decpt).for_each(|_| out.push('0'));
        out.push_str(&digits);
    } else if decpt >= nd {
        out.push_str(&digits);
        (0..decpt - nd).for_each(|_| out.push('0'));
    } else {
        out.push_str(&digits[..decpt as usize]);
        out.push('.');
        out.push_str(&digits[decpt as usize..]);
    }
}

fn cmp(a: &Const, b: &Const) -> Ordering {
    use Const::*;
    match (a, b) {
        (Lit(_) | Num(_), Lit(_) | Num(_)) => {
            let (x, y) = (a.as_f64().unwrap_or(0.0), b.as_f64().unwrap_or(0.0));
            x.partial_cmp(&y).unwrap_or(Ordering::Equal)
        }
        (Str(x), Str(y)) => x.as_bytes().cmp(y.as_bytes()),
        (Arr(x), Arr(y)) => {
            for (x, y) in x.iter().zip(y) {
                match cmp(x, y) {
                    Ordering::Equal => continue,
                    o => return o,
                }
            }
            x.len().cmp(&y.len())
        }
        (Obj(x), Obj(y)) => {
            fn keys(o: &[(String, Const)]) -> Vec<&str> {
                let mut k: Vec<_> = o.iter().map(|(k, _)| k.as_str()).collect();
                k.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
                k
            }
            let (kx, ky) = (keys(x), keys(y));
            let ka = Arr(kx.iter().map(|k| Str((*k).into())).collect());
            let kb = Arr(ky.iter().map(|k| Str((*k).into())).collect());
            match cmp(&ka, &kb) {
                Ordering::Equal => {}
                o => return o,
            }
            for k in kx {
                match cmp(a.get(k).unwrap_or(&Null), b.get(k).unwrap_or(&Null)) {
                    Ordering::Equal => continue,
                    o => return o,
                }
            }
            Ordering::Equal
        }
        _ => a.rank().cmp(&b.rank()),
    }
}

/// `a op b` for constants, `None` if jq would not fold it into a constant.
fn fold(a: Const, op: &BinaryOp<&str>, b: Const) -> Option<Const> {
    use Const::*;
    let num = |a: &Const, b: &Const| Some((a.as_f64()?, b.as_f64()?));
    Some(match op {
        BinaryOp::Cmp(c) => {
            let o = cmp(&a, &b);
            Bool(match c {
                Cmp::Eq => o == Ordering::Equal,
                Cmp::Ne => o != Ordering::Equal,
                Cmp::Lt => o == Ordering::Less,
                Cmp::Gt => o == Ordering::Greater,
                Cmp::Le => o != Ordering::Greater,
                Cmp::Ge => o != Ordering::Less,
            })
        }
        BinaryOp::Math(Math::Add) => match (a, b) {
            (Null, x) | (x, Null) => x,
            (Str(mut x), Str(y)) => {
                x.push_str(&y);
                Str(x)
            }
            (Arr(mut x), Arr(y)) => {
                x.extend(y);
                Arr(x)
            }
            (Obj(mut x), Obj(y)) => {
                y.into_iter().for_each(|(k, v)| Const::insert(&mut x, k, v));
                Obj(x)
            }
            (a, b) => {
                let (x, y) = num(&a, &b)?;
                Num(x + y)
            }
        },
        BinaryOp::Math(Math::Sub) => match (a, b) {
            (Arr(x), Arr(y)) => Arr(x.into_iter().filter(|x| !y.contains(x)).collect()),
            (a, b) => {
                let (x, y) = num(&a, &b)?;
                Num(x - y)
            }
        },
        BinaryOp::Math(Math::Mul) => {
            let (x, y) = num(&a, &b)?;
            Num(x * y)
        }
        BinaryOp::Math(Math::Div) => {
            let (x, y) = num(&a, &b)?;
            if y == 0.0 {
                return None;
            }
            Num(x / y)
        }
        BinaryOp::Math(Math::Rem) => {
            let (x, y) = num(&a, &b)?;
            if x.is_nan() || y.is_nan() {
                return None;
            }
            let (x, y) = (x as i64, y as i64);
            if y == 0 {
                return None;
            }
            Num((x.unsigned_abs() % y.unsigned_abs()) as f64 * if x < 0 { -1.0 } else { 1.0 })
        }
        _ => return None,
    })
}

/// The constant that `t` is, if jq would consider it constant.
///
/// `loc_file` is the file name that `$__loc__` reports.
pub fn konst(t: &Term<&str>, loc_file: &str) -> Option<Const> {
    Some(match t {
        Term::Num(n) => Const::Lit((*n).into()),
        Term::Bool(b) => Const::Bool(*b),
        Term::Null => Const::Null,
        Term::Str(_, parts) => {
            let mut s = String::new();
            for part in parts {
                match part {
                    StrPart::Str(x) => s.push_str(x),
                    StrPart::Char(c) => s.push(*c),
                    StrPart::Term(_) => return None,
                }
            }
            Const::Str(s)
        }
        Term::Arr(None) => Const::Arr(Vec::new()),
        Term::Arr(Some(xs)) => {
            let mut elems = Vec::new();
            let mut stack = Vec::from([&**xs]);
            while let Some(x) = stack.pop() {
                match x {
                    Term::BinOp(l, BinaryOp::Comma, r) => {
                        stack.push(r);
                        stack.push(l);
                    }
                    x => elems.push(konst(x, loc_file)?),
                }
            }
            Const::Arr(elems)
        }
        Term::Obj(kvs) => {
            let mut o = Vec::new();
            for (k, v) in kvs {
                let (Const::Str(k), Some(v)) = (konst(k, loc_file)?, v.as_ref()) else {
                    return None;
                };
                Const::insert(&mut o, k, konst(v, loc_file)?);
            }
            Const::Obj(o)
        }
        Term::Loc(line) => Const::Obj(Vec::from([
            ("file".into(), Const::Str(loc_file.into())),
            ("line".into(), Const::Lit(alloc::format!("{line}"))),
        ])),
        Term::BinOp(l, op @ (BinaryOp::Math(_) | BinaryOp::Cmp(_)), r) => {
            fold(konst(l, loc_file)?, op, konst(r, loc_file)?)?
        }
        _ => return None,
    })
}
