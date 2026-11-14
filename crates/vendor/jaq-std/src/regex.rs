//! jq's `_match_impl` (`f_match` in jq's `src/builtin.c`), on Oniguruma
//! with jq's syntax (Perl_NG) and options.
use crate::{ValT, ValTx};
use alloc::boxed::Box;
use alloc::string::String;
use alloc::vec::Vec;
use jaq_core::native::{bome, v, Filter};
use jaq_core::{DataT, Error, RunPtr, ValR};
use onig::{MatchParam, Regex, RegexOptions, Region, SearchOptions, Syntax};

/// Codepoint offsets of byte positions in `s`, for positions visited in
/// mostly ascending order, counted as jq does: a position inside a
/// character counts that character.
struct Cps<'a> {
    s: &'a [u8],
    /// start of the last character counted
    prev: usize,
    byte: usize,
    cp: usize,
}

impl Cps<'_> {
    fn at(&mut self, pos: usize) -> usize {
        if pos <= self.prev {
            (self.prev, self.byte, self.cp) = (0, 0, 0);
        }
        while self.byte < pos {
            self.prev = self.byte;
            self.byte += crate::utf8_len(self.s[self.byte]);
            self.cp += 1;
        }
        self.cp
    }
}

fn obj<V: ValT>(fields: impl IntoIterator<Item = (&'static str, V)>) -> V {
    let kvs = fields.into_iter().map(|(k, v)| (V::from(String::from(k)), v));
    V::from_map(kvs).unwrap_or_default()
}

/// Bytes of the input as a string, as jq's `jv_string_sized`.
fn text<V: ValT>(b: &[u8]) -> V {
    V::from(crate::utf8_lossy(b))
}

fn num<V: ValT>(n: usize) -> V {
    V::from(n as isize)
}

/// Options for the modifier string, as jq; `Ok((options, global))`.
fn modifiers<V: ValT>(mods: &V) -> Result<(RegexOptions, bool), Error<V>> {
    let mut options = RegexOptions::REGEX_OPTION_CAPTURE_GROUP;
    let mut global = false;
    if *mods == V::default() {
        return Ok((options, global));
    }
    let s = mods.str().ok_or_else(|| mods.type_error("is not a string"))?;
    for c in s.chars() {
        options |= match c {
            'g' => {
                global = true;
                RegexOptions::REGEX_OPTION_NONE
            }
            'i' => RegexOptions::REGEX_OPTION_IGNORECASE,
            'x' => RegexOptions::REGEX_OPTION_EXTEND,
            'm' => RegexOptions::REGEX_OPTION_MULTILINE,
            's' => RegexOptions::REGEX_OPTION_SINGLELINE,
            'p' => RegexOptions::REGEX_OPTION_MULTILINE | RegexOptions::REGEX_OPTION_SINGLELINE,
            'l' => RegexOptions::REGEX_OPTION_FIND_LONGEST,
            'n' => RegexOptions::REGEX_OPTION_FIND_NOT_EMPTY,
            _ => return Err(Error::str(alloc::format!("{s} is not a valid modifier string"))),
        };
    }
    Ok((options, global))
}

fn failure<V: ValT>(e: onig::Error) -> Error<V> {
    Error::str(alloc::format!("Regex failure: {}", e.description()))
}

fn match_impl<V: ValT>(input: &V, re: &V, mods: &V, test: bool) -> ValR<V> {
    let s = input
        .str()
        .ok_or_else(|| input.type_error("cannot be matched, as it is not a string"))?;
    let re_s = re.str().ok_or_else(|| re.type_error("is not a string"))?;
    let (options, global) = modifiers(mods)?;
    let reg = Regex::with_options(&re_s, options, Syntax::perl_ng()).map_err(failure)?;

    // names of capture groups, by group number
    let mut names: Vec<Option<String>> = Vec::new();
    names.resize(reg.captures_len(), None);
    reg.foreach_name(|name, groups| {
        for g in groups {
            if let Some(slot) = names.get_mut(*g as usize - 1) {
                *slot = Some(String::from(name));
            }
        }
        true
    });
    let name = |i: usize| names[i - 1].clone().map_or_else(V::default, V::from);

    let bytes = s.as_bytes();
    let end = bytes.len();
    let mut cps = Cps { s: bytes, prev: 0, byte: 0, cp: 0 };
    let mut out = Vec::new();
    let mut start = 0;
    let mut region = Region::new();
    loop {
        let found = reg
            .search_with_param(
                &*s,
                start,
                end,
                SearchOptions::SEARCH_OPTION_NONE,
                Some(&mut region),
                MatchParam::default(),
            )
            .map_err(failure)?;
        if found.is_none() {
            break;
        }
        if test {
            return Ok(V::from(true));
        }
        let (beg0, end0) = region.pos(0).unwrap_or((0, 0));
        let idx = cps.at(beg0);
        let len = cps.at(end0) - idx;
        let captures = (1..region.len()).map(|i| match region.pos(i) {
            None => obj([
                ("offset", V::from(-1isize)),
                ("string", V::default()),
                ("length", num(0)),
                ("name", name(i)),
            ]),
            Some((b, e)) if b == e || beg0 == end0 => obj([
                ("offset", num(cps.at(b))),
                ("string", V::from(String::new())),
                ("length", num(0)),
                ("name", name(i)),
            ]),
            Some((b, e)) => {
                let off = cps.at(b);
                obj([
                    ("offset", num(off)),
                    ("length", num(cps.at(e) - off)),
                    ("string", text(&bytes[b..e])),
                    ("name", name(i)),
                ])
            }
        });
        let captures: V = captures.collect();
        out.push(obj([
            ("offset", num(idx)),
            ("length", num(len)),
            ("string", text(&bytes[beg0..end0])),
            ("captures", captures),
        ]));
        // as jq, step one byte past an empty match, even into a character
        start = if beg0 == end0 { end0 + 1 } else { end0 };
        if !global || start > end {
            break;
        }
    }
    Ok(if test { V::from(false) } else { out.into_iter().collect() })
}

pub fn funs<D: DataT>() -> Box<[Filter<RunPtr<D>>]>
where
    for<'a> D::V<'a>: ValT,
{
    Box::new([("_match_impl", v(3), |mut cv| {
        let test = cv.0.pop_var();
        let mods = cv.0.pop_var();
        let re = cv.0.pop_var();
        bome(match_impl(&cv.1, &re, &mods, test == D::V::from(true)))
    })])
}
