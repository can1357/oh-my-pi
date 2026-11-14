//! `comptags` and `comptry`: the tag sets `_tags` and friends keep per
//! function level (computil.c "Tags stuff").

use std::collections::BTreeMap;

use bstr::{BStr, BString, ByteSlice};
use serde::{Deserialize, Serialize};

use super::{fin, gate, load, px, save, setaparam, setsparam, warn};
use crate::bash::{
	pattern::zsh::{PatFlags, haswilds, tokenize},
	store::MiscKey,
	syntax::zsh::tok::{COMMA, INBRACE, OUTBRACE, metafy},
	vm::{
		builtins::{Ctx, Need, R, done, history::zfc::locallevel, zsh_args::Ops},
		zsh::{brace, zpattern},
	},
	zshopt::ZshOpt,
};

/// zsh `MAX_TAGS`: function levels with tag sets.
const MAX_TAGS: i64 = 256;

/// zsh `struct ctset`: one tag set.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct Ctset {
	/// The tags (`tag` or `tag:label`).
	tags: Vec<BString>,
	/// The last tag `-A` looked for.
	tag:  Option<BString>,
	/// Where `-A` continues in `tags`.
	ptr:  usize,
}

/// zsh `struct ctags`: the tags offered at one function level.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct Ctags {
	/// All tags offered.
	all:     Vec<BString>,
	/// The context.
	context: BString,
	/// No `-N` yet.
	init:    bool,
	/// The tag sets, first one current.
	sets:    Vec<Ctset>,
}

/// zsh's `comptags[]` (by `locallevel`) and `lasttaglevel`.
#[derive(Debug, Default, Serialize, Deserialize)]
struct Tags {
	levels:       BTreeMap<i64, Ctags>,
	lasttaglevel: i64,
}

fn load_tags(ctx: &mut Ctx<'_, '_>) -> Result<Tags, Need> {
	Ok(load(ctx, MiscKey::ZshCompTags)?.unwrap_or_default())
}

fn save_tags(ctx: &mut Ctx<'_, '_>, t: &Tags) {
	let keep = !t.levels.is_empty() || t.lasttaglevel != 0;
	save(ctx, MiscKey::ZshCompTags, keep.then_some(t));
}

/// zsh `arrcontains`: whether `a` holds `s`; with `colon`, each side
/// compares up to its first `:`.
fn arrcontains(a: &[BString], s: &[u8], colon: bool) -> bool {
	a.iter().any(|e| {
		if colon {
			upto_colon(e) == upto_colon(s)
		} else {
			e.as_slice() == s
		}
	})
}

/// `s` up to its first `:`.
fn upto_colon(s: &[u8]) -> &[u8] {
	s.find_byte(b':').map_or(s, |i| &s[..i])
}

/// zsh `bin_comptags`.
pub fn comptags(ctx: &mut Ctx<'_, '_>, _ops: &Ops, args: &[BString]) -> R {
	if !gate(ctx) {
		return done(1);
	}
	let a0 = args[0].as_slice();
	if a0.first() != Some(&b'-') || a0.len() < 2 || (a0.len() > 2 && (a0[2] != b'-' || a0.len() > 3))
	{
		return warn(ctx, format!("invalid argument: {}", BStr::new(a0)));
	}
	let level = locallevel(ctx.vp) - i64::from(a0.len() > 2);
	if level >= MAX_TAGS {
		return warn(ctx, "nesting level too deep");
	}
	let mut t = load_tags(ctx)?;
	let op = a0[1];
	if op != b'i' && op != b'I' && !t.levels.contains_key(&level) {
		return warn(ctx, "no tags registered");
	}
	let (min, max): (usize, Option<usize>) = match op {
		b'i' => (2, None),
		b'C' | b'R' | b'S' => (1, Some(1)),
		b'T' | b'N' => (0, Some(0)),
		b'A' => (2, Some(3)),
		_ => return warn(ctx, format!("invalid option: {}", BStr::new(a0))),
	};
	let n = args.len() - 1;
	if n < min {
		return warn(ctx, "not enough arguments");
	}
	if max.is_some_and(|m| n > m) {
		return warn(ctx, "too many arguments");
	}
	let mut failed = false;
	let status = match op {
		b'i' => {
			t.levels.insert(level, Ctags {
				all:     args[2..].to_vec(),
				context: args[1].clone(),
				init:    true,
				sets:    Vec::new(),
			});
			t.lasttaglevel = level;
			save_tags(ctx, &t);
			0
		},
		b'C' => {
			let c = t.levels[&level].context.clone();
			setsparam(ctx, &mut failed, &args[1], &c)?;
			0
		},
		b'T' => i32::from(t.levels[&level].sets.is_empty()),
		b'N' => {
			let ct = t.levels.get_mut(&level).expect("checked above");
			if ct.init {
				ct.init = false;
			} else if !ct.sets.is_empty() {
				ct.sets.remove(0);
			}
			let empty = ct.sets.is_empty();
			save_tags(ctx, &t);
			i32::from(empty)
		},
		b'R' => {
			let ct = &t.levels[&level];
			i32::from(
				!ct.sets
					.first()
					.is_some_and(|s| arrcontains(&s.tags, &args[1], true)),
			)
		},
		b'A' => {
			let Some(s) = t.levels.get_mut(&level).and_then(|ct| ct.sets.first_mut()) else {
				return done(1);
			};
			let tag = args[1].as_slice();
			if s.tag.as_deref().is_none_or(|t| t.as_bytes() != tag) {
				s.tag = Some(tag.into());
				s.ptr = 0;
			}
			// The first tag from `ptr` on that is `TAG` or `TAG:…`: the
			// index and where the value starts in it.
			let found = s.tags[s.ptr..].iter().enumerate().find_map(|(i, q)| {
				if !q.starts_with(tag) {
					return None;
				}
				match q.get(tag.len()) {
					None => Some((s.ptr + i, 0)),
					Some(b':') => Some((s.ptr + i, tag.len() + 1)),
					Some(_) => None,
				}
			});
			let Some((qi, voff)) = found else {
				s.tag = None;
				save_tags(ctx, &t);
				return done(1);
			};
			s.ptr = qi + 1;
			let q = s.tags[qi].clone();
			save_tags(ctx, &t);
			let v = &q[voff..];
			let val: BString = if v.first() == Some(&b'-') {
				[tag, v].concat().into()
			} else {
				v.into()
			};
			setsparam(ctx, &mut failed, &args[2], &val)?;
			if let Some(name) = args.get(3) {
				let end = q[voff..].find_byte(b':').map_or(q.len(), |e| voff + e);
				setsparam(ctx, &mut failed, name, &q[..end])?;
			}
			0
		},
		// b'S'
		_ => match t.levels[&level].sets.first() {
			Some(s) => {
				let tags = s.tags.clone();
				setaparam(ctx, &mut failed, &args[1], tags)?;
				0
			},
			None => 1,
		},
	};
	fin(status, failed)
}

/// zsh `bin_comptry`.
pub fn comptry(ctx: &mut Ctx<'_, '_>, _ops: &Ops, args: &[BString]) -> R {
	if !gate(ctx) {
		return done(1);
	}
	let mut t = load_tags(ctx)?;
	let ll = t.lasttaglevel;
	if ll == 0 || !t.levels.contains_key(&ll) {
		return warn(ctx, "no tags registered");
	}
	let Some(first) = args.first() else {
		return done(0);
	};
	let mut failed = false;
	if first == "-m" {
		let all = t.levels[&ll].all.clone();
		// zsh keeps one list (and count) across the arguments: each
		// argument with matches adds a set of everything found so far.
		let mut list: Vec<BString> = Vec::new();
		let mut num = 0usize;
		let braceccl = ctx.zsh_option(ZshOpt::Braceccl)?;
		for arg in &args[1..] {
			let s = arg.as_slice();
			let mut i = 0;
			while i < s.len() {
				while i < s.len() && matches!(s[i], b' ' | b'\t') {
					i += 1;
				}
				// The word with backslashes removed, and where its first
				// unquoted `:` is.
				let mut word: Vec<u8> = Vec::new();
				let mut colon: Option<usize> = None;
				while i < s.len() && !matches!(s[i], b' ' | b'\t' | b'\n') {
					if colon.is_none() && s[i] == b':' {
						colon = Some(word.len());
					}
					if s[i] == b'\\' && i + 1 < s.len() {
						i += 1;
					}
					word.push(s[i]);
					i += 1;
				}
				if i < s.len() {
					i += 1;
				}
				if word.is_empty() {
					continue;
				}
				let name = &word[..colon.unwrap_or(word.len())];
				let rest = colon.map(|c| &word[c + 1..]);
				let mut qq = metafy(name);
				let mut j = 0;
				while j < qq.len() {
					match qq[j] {
						b'\\' if j + 1 < qq.len() => j += 1,
						b'{' => qq[j] = INBRACE,
						b'}' => qq[j] = OUTBRACE,
						b',' => qq[j] = COMMA,
						_ => {},
					}
					j += 1;
				}
				tokenize(&mut qq);
				let Some(popts) = px(ctx, &mut failed, zpattern::opts)? else {
					return fin(1, failed);
				};
				if haswilds(&mut qq, &popts) || brace::hasbraces(&mut qq, braceccl) {
					let mut blist = vec![qq];
					let mut b = 0;
					while b < blist.len() {
						while brace::hasbraces(&mut blist[b], braceccl) {
							let w = std::mem::take(&mut blist[b]);
							let exp = brace::xpandbraces(&w, braceccl);
							blist.splice(b..=b, exp).for_each(drop);
						}
						b += 1;
					}
					for pat in blist {
						let Some(prog) =
							px(ctx, &mut failed, |ex| zpattern::try_compile(ex, &pat, PatFlags::NONE))?
								.flatten()
						else {
							continue;
						};
						for a in &all {
							if list.iter().any(|l| upto_colon(l) == a.as_slice()) {
								continue;
							}
							let hit = px(ctx, &mut failed, |ex| zpattern::matches(ex, &prog, a))?
								.unwrap_or(false);
							if hit {
								let mut n = a.clone();
								if let Some(r) = rest {
									n.push(b':');
									n.extend_from_slice(r);
								}
								list.push(n);
								num += 1;
							}
						}
					}
				} else if arrcontains(&all, name, false)
					&& !t.levels[&ll]
						.sets
						.iter()
						.any(|set| arrcontains(&set.tags, name, false))
				{
					list.push(word.clone().into());
					num += 1;
				}
			}
			if num > 0 {
				t.levels
					.get_mut(&ll)
					.expect("checked above")
					.sets
					.push(Ctset { tags: list.clone(), ..Ctset::default() });
			}
		}
	} else {
		let (sep, rest) = if first == "-s" {
			(true, &args[1..])
		} else {
			(false, args)
		};
		let ct = t.levels.get_mut(&ll).expect("checked above");
		let keep: Vec<BString> = rest
			.iter()
			.filter(|p| {
				arrcontains(&ct.all, p, true) && !ct.sets.iter().any(|s| arrcontains(&s.tags, p, false))
			})
			.cloned()
			.collect();
		if !keep.is_empty() {
			if sep {
				ct.sets.extend(
					keep
						.into_iter()
						.map(|tag| Ctset { tags: vec![tag], ..Ctset::default() }),
				);
			} else {
				ct.sets.push(Ctset { tags: keep, ..Ctset::default() });
			}
		}
	}
	save_tags(ctx, &t);
	fin(0, failed)
}
