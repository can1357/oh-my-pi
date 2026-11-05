//! Brace expansion (bash `brace_expand`) over a parsed word.
//!
//! Brace expansion is purely syntactic: it runs on the word as written,
//! before every other expansion, and only unquoted bytes (`WordPart::Lit`)
//! can open, separate or close a brace expression. The compiler expands a
//! word once into its alternatives; the VM uses them while `braceexpand`
//! (`set -B`) is on.

use crate::bash::syntax as syn;

/// One unit of a word: an active (unquoted) byte or an opaque part.
#[derive(Clone, Copy)]
enum Tok<'a> {
	Ch(u8),
	Atom(&'a syn::WordPart),
	/// A double-quoted part holding a brace expression bash sees as
	/// unquoted ([`quoted_alternatives`]): the part and its alternatives.
	Alts(&'a syn::WordPart, &'a [syn::WordPart]),
}

/// Upper bound on the number of words one brace expression may produce
/// (bash has none; this keeps `{1..999999999}` from exhausting memory).
const MAX_WORDS: usize = 1 << 20;

/// The alternatives of `parts`, or `None` when it has no brace expression.
pub fn expand(parts: &[syn::WordPart]) -> Option<Vec<Vec<syn::WordPart>>> {
	let quirks: Vec<Option<Vec<syn::WordPart>>> = parts.iter().map(quoted_alternatives).collect();
	let candidate = parts
		.iter()
		.any(|p| matches!(p, syn::WordPart::Lit(b) if b.contains(&b'{')))
		|| quirks.iter().any(Option::is_some);
	if !candidate {
		return None;
	}
	let mut toks: Vec<Tok<'_>> = Vec::new();
	for (p, alts) in parts.iter().zip(&quirks) {
		match (p, alts) {
			(syn::WordPart::Lit(b), _) => toks.extend(b.iter().map(|&c| Tok::Ch(c))),
			(other, Some(alts)) => toks.push(Tok::Alts(other, alts)),
			(other, None) => toks.push(Tok::Atom(other)),
		}
	}
	let mut out = Vec::new();
	if !expand_toks(&toks, &mut out) {
		return None;
	}
	Some(out.iter().map(|t| rebuild(t)).collect())
}

/// bash finds braces in the word as written with a naive quote tracker
/// (`brace_gobbler`): in `"${a["{2..6}"]}"` the `"` that opens the
/// subscript string closes the outer one, so the text between the inner
/// quotes is unquoted and its braces expand (`"${a["2"]}" … "${a["6"]}"`).
/// The same holds for a double-quoted string in the operator word of a
/// `${…}` inside double quotes (`"${x:-"{1,2}"}"`). The alternatives of
/// such a double-quoted part, or `None`. An unquoted `${a["{1,2}"]}` keeps
/// its quotes: bash skips `${`.
fn quoted_alternatives(part: &syn::WordPart) -> Option<Vec<syn::WordPart>> {
	quoted_alternatives_from(part, 0)
}

/// [`quoted_alternatives`] for the `${…}` at or after `inner[from]`: the
/// first one expands, then (bash's postamble) each of its alternatives at
/// the later ones; expanded text is not rescanned.
fn quoted_alternatives_from(part: &syn::WordPart, from: usize) -> Option<Vec<syn::WordPart>> {
	let syn::WordPart::DQuote(inner) = part else {
		return None;
	};
	for (j, p) in inner.iter().enumerate().skip(from) {
		let syn::WordPart::Param(param) = p else {
			continue;
		};
		for (w, word) in param_words(param).into_iter().enumerate() {
			let Some(word) = word else {
				continue;
			};
			for (k, sub) in word.parts.iter().enumerate() {
				let syn::WordPart::DQuote(q) = sub else {
					continue;
				};
				let Some(alts) = expand(q) else {
					continue;
				};
				let mut alternatives = Vec::with_capacity(alts.len());
				for alt in alts {
					let mut inner = inner.clone();
					if let syn::WordPart::Param(param) = &mut inner[j]
						&& let Some(word) = param_words_mut(param).into_iter().nth(w).flatten()
					{
						word.parts[k] = syn::WordPart::DQuote(alt);
					}
					let part = syn::WordPart::DQuote(inner);
					match quoted_alternatives_from(&part, j + 1) {
						Some(more) => alternatives.extend(more),
						None => alternatives.push(part),
					}
					if alternatives.len() >= MAX_WORDS {
						break;
					}
				}
				return Some(alternatives);
			}
		}
	}
	None
}

/// The words of a `${…}`: the subscript, then the operator words.
const fn param_words(p: &syn::Param) -> [Option<&syn::Word>; 3] {
	let index = match &p.index {
		Some(syn::Subscript::Expr(w)) => Some(w),
		_ => None,
	};
	let (a, b) = match &p.op {
		syn::ParamOp::Default { word, .. }
		| syn::ParamOp::Assign { word, .. }
		| syn::ParamOp::Alt { word, .. } => (Some(word), None),
		syn::ParamOp::Error { word, .. } => (word.as_ref(), None),
		syn::ParamOp::Trim { pat, .. } => (Some(pat), None),
		syn::ParamOp::Replace { pat, rep, .. } => (Some(pat), rep.as_ref()),
		syn::ParamOp::Case { pat, .. } => (pat.as_ref(), None),
		_ => (None, None),
	};
	[index, a, b]
}

/// [`param_words`], mutable.
const fn param_words_mut(p: &mut syn::Param) -> [Option<&mut syn::Word>; 3] {
	let index = match &mut p.index {
		Some(syn::Subscript::Expr(w)) => Some(w),
		_ => None,
	};
	let (a, b) = match &mut p.op {
		syn::ParamOp::Default { word, .. }
		| syn::ParamOp::Assign { word, .. }
		| syn::ParamOp::Alt { word, .. } => (Some(word), None),
		syn::ParamOp::Error { word, .. } => (word.as_mut(), None),
		syn::ParamOp::Trim { pat, .. } => (Some(pat), None),
		syn::ParamOp::Replace { pat, rep, .. } => (Some(pat), rep.as_mut()),
		syn::ParamOp::Case { pat, .. } => (pat.as_mut(), None),
		_ => (None, None),
	};
	[index, a, b]
}

/// Expand `toks` into `out`; `false` when nothing expanded.
fn expand_toks<'a>(toks: &[Tok<'a>], out: &mut Vec<Vec<Tok<'a>>>) -> bool {
	let mut start = 0;
	while let Some(s) = toks[start..]
		.iter()
		.position(|t| matches!(t, Tok::Ch(b'{') | Tok::Alts(..)))
		.map(|i| start + i)
	{
		if let Tok::Alts(_, alts) = toks[s] {
			let rest = &toks[s + 1..];
			let mut posts = Vec::new();
			if !expand_toks(rest, &mut posts) {
				posts.push(rest.to_vec());
			}
			for alt in alts {
				for post in &posts {
					if out.len() >= MAX_WORDS {
						return true;
					}
					let mut word = Vec::with_capacity(s + 1 + post.len());
					word.extend_from_slice(&toks[..s]);
					word.push(Tok::Atom(alt));
					word.extend_from_slice(post);
					out.push(word);
				}
			}
			return true;
		}
		let Some(e) = matching_close(toks, s) else {
			// An unclosed `{` is literal; a later brace may still expand.
			start = s + 1;
			continue;
		};
		let inner = &toks[s + 1..e];
		let (pieces, alternatives) = if let Some(p) = split_commas(inner) {
			(p, true)
		} else if let Some(p) = sequence(inner) {
			(p, false)
		} else {
			// Neither alternatives nor a sequence: this brace is literal.
			start = s + 1;
			continue;
		};
		// bash `brace_expand`: the preamble stays as written; each
		// alternative and the postamble are expanded on their own, and the
		// combined words (or sequence items) are not rescanned, so
		// `{{1..3}..{7..9}}` is `{1..7} {1..8} …`.
		let rest = &toks[e + 1..];
		let mut posts = Vec::new();
		if !expand_toks(rest, &mut posts) {
			posts.push(rest.to_vec());
		}
		for piece in pieces {
			let mut items = Vec::new();
			if !(alternatives && expand_toks(&piece, &mut items)) {
				items.push(piece);
			}
			for item in &items {
				for post in &posts {
					if out.len() >= MAX_WORDS {
						return true;
					}
					let mut word = Vec::with_capacity(s + item.len() + post.len());
					word.extend_from_slice(&toks[..s]);
					word.extend_from_slice(item);
					word.extend_from_slice(post);
					out.push(word);
				}
			}
		}
		return true;
	}
	false
}

/// A quoted empty string: bash re-reads brace-expanded text, so the `\`
/// a character sequence produces is quote-removed to an empty word
/// (`{Z..a}` has an empty word between `[` and `]`).
static EMPTY_QUOTE: syn::WordPart = syn::WordPart::SQuote(Vec::new());

/// The `}` closing the `{` at `s` (nested braces counted).
fn matching_close(toks: &[Tok<'_>], s: usize) -> Option<usize> {
	let mut depth = 0usize;
	for (i, t) in toks.iter().enumerate().skip(s) {
		match t {
			Tok::Ch(b'{') => depth += 1,
			Tok::Ch(b'}') => {
				depth -= 1;
				if depth == 0 {
					return Some(i);
				}
			},
			_ => {},
		}
	}
	None
}

/// The comma-separated alternatives of a brace body (top-level commas
/// only); `None` without a comma.
fn split_commas<'a>(inner: &[Tok<'a>]) -> Option<Vec<Vec<Tok<'a>>>> {
	let mut depth = 0usize;
	let mut alts = Vec::new();
	let mut cur = Vec::new();
	let mut comma = false;
	for &t in inner {
		match t {
			Tok::Ch(b'{') => depth += 1,
			Tok::Ch(b'}') => depth = depth.saturating_sub(1),
			Tok::Ch(b',') if depth == 0 => {
				comma = true;
				alts.push(std::mem::take(&mut cur));
				continue;
			},
			_ => {},
		}
		cur.push(t);
	}
	alts.push(cur);
	comma.then_some(alts)
}

/// `x..y[..incr]` over integers (zero-padded when either end is) or single
/// characters.
fn sequence<'a>(inner: &[Tok<'a>]) -> Option<Vec<Vec<Tok<'a>>>> {
	let text: Vec<u8> = inner
		.iter()
		.map(|t| match t {
			Tok::Ch(c) => Some(*c),
			Tok::Atom(_) | Tok::Alts(..) => None,
		})
		.collect::<Option<_>>()?;
	let parts: Vec<&[u8]> = split_dots(&text);
	if !(2..=3).contains(&parts.len()) {
		return None;
	}
	let incr = match parts.get(2) {
		Some(i) => parse_int(i)?,
		None => 1,
	};
	let step = incr.unsigned_abs().max(1);
	let items: Vec<Vec<u8>> = match (parse_int(parts[0]), parse_int(parts[1])) {
		(Some(a), Some(b)) => {
			let padded = |p: &[u8]| {
				let digits = p
					.strip_prefix(b"-")
					.or_else(|| p.strip_prefix(b"+"))
					.unwrap_or(p);
				digits.len() > 1 && digits[0] == b'0'
			};
			let width = if padded(parts[0]) || padded(parts[1]) {
				parts[0].len().max(parts[1].len())
			} else {
				0
			};
			let count = a.abs_diff(b) / step + 1;
			if count > MAX_WORDS as u64 {
				return None;
			}
			(0..count)
				.map(|k| {
					let off = i64::try_from(k * step).unwrap_or(i64::MAX);
					let v = if a <= b {
						a.saturating_add(off)
					} else {
						a.saturating_sub(off)
					};
					if v < 0 {
						format!("-{:0w$}", v.unsigned_abs(), w = width.saturating_sub(1)).into_bytes()
					} else {
						format!("{v:0width$}").into_bytes()
					}
				})
				.collect()
		},
		(None, None) if parts[0].len() == 1 && parts[1].len() == 1 => {
			let (a, b) = (parts[0][0], parts[1][0]);
			let step = u8::try_from(step).unwrap_or(u8::MAX).max(1);
			let mut out = Vec::new();
			let mut c = a;
			loop {
				out.push(vec![c]);
				if c == b {
					break;
				}
				let next = if a <= b {
					c.checked_add(step)
				} else {
					c.checked_sub(step)
				};
				match next {
					Some(n) if (a <= b && n <= b) || (a > b && n >= b) => c = n,
					_ => break,
				}
			}
			out
		},
		_ => return None,
	};
	Some(
		items
			.into_iter()
			.map(|w| {
				if w == b"\\" {
					vec![Tok::Atom(&EMPTY_QUOTE)]
				} else {
					w.into_iter().map(Tok::Ch).collect()
				}
			})
			.collect(),
	)
}

/// Split at `..` (exactly two dots).
fn split_dots(text: &[u8]) -> Vec<&[u8]> {
	let mut out = Vec::new();
	let mut rest = text;
	while let Some(i) = rest.windows(2).position(|w| w == b"..") {
		out.push(&rest[..i]);
		rest = &rest[i + 2..];
	}
	out.push(rest);
	out
}

fn parse_int(text: &[u8]) -> Option<i64> {
	let digits = text
		.strip_prefix(b"-")
		.or_else(|| text.strip_prefix(b"+"))
		.unwrap_or(text);
	if digits.is_empty() || !digits.iter().all(u8::is_ascii_digit) {
		return None;
	}
	std::str::from_utf8(text).ok()?.parse().ok()
}

/// Parts from tokens: runs of active bytes become one `Lit`.
fn rebuild(toks: &[Tok<'_>]) -> Vec<syn::WordPart> {
	let mut parts = Vec::new();
	let mut lit = Vec::new();
	for t in toks {
		match t {
			Tok::Ch(c) => lit.push(*c),
			Tok::Atom(p) | Tok::Alts(p, _) => {
				if !lit.is_empty() {
					push_lit(&mut parts, std::mem::take(&mut lit));
				}
				parts.push((*p).clone());
			},
		}
	}
	if !lit.is_empty() {
		push_lit(&mut parts, lit);
	}
	parts
}

/// Append a literal. Brace expansion works on the text as written, so
/// name characters that end up right after an unbraced `$name` extend the
/// name (`$var{x,y}` is `$varx $vary`).
fn push_lit(parts: &mut Vec<syn::WordPart>, mut lit: Vec<u8>) {
	if let Some(syn::WordPart::Param(p)) = parts.last_mut()
		&& let syn::ParamName::Var(name) = &mut p.name
		&& !p.braced
		&& !p.indirect
		&& p.index.is_none()
		&& p.op == syn::ParamOp::None
	{
		let n = lit
			.iter()
			.take_while(|&&c| c.is_ascii_alphanumeric() || c == b'_')
			.count();
		name.extend_from_slice(&lit[..n]);
		lit.drain(..n);
		if lit.is_empty() {
			return;
		}
	}
	parts.push(syn::WordPart::Lit(lit));
}

#[cfg(test)]
mod tests {
	use super::*;

	fn lit(s: &str) -> Vec<syn::WordPart> {
		vec![syn::WordPart::Lit(s.as_bytes().to_vec())]
	}

	fn words(s: &str) -> Vec<String> {
		match expand(&lit(s)) {
			None => vec![s.to_owned()],
			Some(alts) => alts
				.into_iter()
				.map(|parts| {
					parts
						.into_iter()
						.map(|p| match p {
							syn::WordPart::Lit(b) => String::from_utf8(b).unwrap(),
							_ => String::from("<atom>"),
						})
						.collect()
				})
				.collect(),
		}
	}

	// Goldens: bash 5.3.20.
	#[test]
	fn alternatives_nest_and_combine() {
		assert_eq!(words("{a,b}{1..2}"), ["a1", "a2", "b1", "b2"]);
		assert_eq!(words("a{,b}"), ["a", "ab"]);
		assert_eq!(words("{a,{b,c}d}"), ["a", "bd", "cd"]);
		assert_eq!(words("{a}"), ["{a}"]);
		assert_eq!(words("{}"), ["{}"]);
		assert_eq!(words("x{a,b"), ["x{a,b"]);
	}

	// Goldens: upstream braces.tests / braces.right.
	#[test]
	fn unclosed_braces_are_skipped_and_results_not_rescanned() {
		assert_eq!(words("a-{bdef-{g,i}-c"), ["a-{bdef-g-c", "a-{bdef-i-c"]);
		assert_eq!(words("{1..{7..9}}"), ["{1..7}", "{1..8}", "{1..9}"]);
		let w = words("{{1..3}..{7..9}}");
		assert_eq!(w.len(), 9);
		assert_eq!(w[..4], ["{1..7}", "{1..8}", "{1..9}", "{2..7}"]);
		assert_eq!(words("{Z..a}")[1..4], ["[", "<atom>", "]"]);
	}

	#[test]
	fn sequences_pad_step_and_reverse() {
		assert_eq!(words("{01..03}"), ["01", "02", "03"]);
		assert_eq!(words("{a..c..2}"), ["a", "c"]);
		assert_eq!(words("{5..1}"), ["5", "4", "3", "2", "1"]);
		assert_eq!(words("{1..10..4}"), ["1", "5", "9"]);
		assert_eq!(words("{-1..1}"), ["-1", "0", "1"]);
		assert_eq!(words("{1..a}"), ["{1..a}"]);
	}

	#[test]
	fn quoted_parts_are_opaque() {
		let parts = vec![
			syn::WordPart::Lit(b"{a,".to_vec()),
			syn::WordPart::SQuote(b"b,c".to_vec()),
			syn::WordPart::Lit(b"}".to_vec()),
		];
		let alts = expand(&parts).unwrap();
		assert_eq!(alts.len(), 2);
		assert_eq!(alts[1], vec![syn::WordPart::SQuote(b"b,c".to_vec())]);
	}

	fn var(name: &str, braced: bool) -> syn::WordPart {
		syn::WordPart::Param(Box::new(syn::Param {
			name: syn::ParamName::Var(name.as_bytes().to_vec()),
			index: None,
			op: syn::ParamOp::None,
			braced,
			indirect: false,
		}))
	}

	// Goldens: bash 5.3.20 `var=baz varx=vx; echo $var{x,y} ${var}{x,y}`
	// prints `vx vy bazx bazy`.
	#[test]
	fn unbraced_names_absorb_expanded_name_characters() {
		let alts = expand(&[var("var", false), syn::WordPart::Lit(b"{x,y-}".to_vec())]).unwrap();
		assert_eq!(alts, [vec![var("varx", false)], vec![
			var("vary", false),
			syn::WordPart::Lit(b"-".to_vec())
		]]);
		let alts = expand(&[var("var", true), syn::WordPart::Lit(b"{x,y}".to_vec())]).unwrap();
		assert_eq!(alts[0], vec![var("var", true), syn::WordPart::Lit(b"x".to_vec())]);
	}
}
