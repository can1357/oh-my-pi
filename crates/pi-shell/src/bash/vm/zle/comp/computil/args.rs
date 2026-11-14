//! `comparguments`: the parser behind `_arguments` (zsh 5.9
//! `Src/Zle/computil.c`, `parse_cadef` … `bin_comparguments`).
//!
//! `comparguments -i` parses the `_arguments` specifications into one
//! definition per set (`- name` / `- (name)`; groups `+ name` are part of
//! every set), parses the command line against each set, and keeps the
//! definitions (with the `active` flags the line left) and the per-set
//! line states in the [`MiscKey::ZshCompArguments`] record, where zsh
//! keeps `ca_laststate` and its cadef cache. The other sub-options read
//! that record. zsh's cache of parsed definitions only saves time, so
//! `-i` parses afresh each call.
//!
//! zsh's linked lists are vectors here: an argument is named by an
//! [`ArgRef`] (set, list, index), an option by its index in its set.

use std::sync::Arc;

use bstr::BString;
use serde::{Deserialize, Serialize};

use super::{
	compcurrent, compwords, fin, gate, ignore_prefix, load, px, save, setaparam, sethparam,
	setsparam, warn,
};
use crate::bash::{
	pattern::zsh::{PatFlags, Pattern, tokenize},
	store::MiscKey,
	syntax::zsh::tok,
	vm::{
		builtins::{Ctx, Need, R, done, zsh_args::Ops},
		zsh::{math::Number, params, zpattern},
	},
	zshopt::ZshOpt,
};

// ---- definitions
// ------------------------------------------------------------------

/// `-S`: `--` ends the options (zsh `CDF_SEP`).
const CDF_SEP: u8 = 1;

/// The argument follows in the next word (`-opt:…`).
const CAO_NEXT: u8 = 1;
/// The argument follows the option directly (`-opt-:…`).
const CAO_DIRECT: u8 = 2;
/// The argument may follow the option directly (`-opt+:…`).
const CAO_ODIRECT: u8 = 3;
/// The argument follows a mandatory `=` (`-opt=-:…`).
const CAO_EQUAL: u8 = 4;
/// The argument follows an optional `=` (`-opt=:…`).
const CAO_OEQUAL: u8 = 5;

/// A plain argument (`:…`).
const CAA_NORMAL: u8 = 1;
/// An optional argument (`::…`).
const CAA_OPT: u8 = 2;
/// The rest arguments (`*:…`).
const CAA_REST: u8 = 3;
/// The rest arguments, `words` narrowed to them (`*::…`).
const CAA_RARGS: u8 = 4;
/// The rest arguments, `words` narrowed to the rest (`*:::…`).
const CAA_RREST: u8 = 5;

/// zsh `struct caarg`: an argument (of the command or of an option).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub(super) struct Caarg {
	/// The description.
	pub(super) descr:  BString,
	/// Exclusions when this argument is on the line.
	xor:               Option<Vec<BString>>,
	/// The action.
	pub(super) action: BString,
	/// `CAA_*`.
	typ:               u8,
	/// The end pattern of `*PAT:…` (metafied, tokenized).
	end:               Option<BString>,
	/// The option this argument belongs to (as written).
	pub(super) opt:    Option<BString>,
	/// Its position.
	num:               i64,
	/// Its earliest position given the optional arguments before it.
	min:               i64,
	/// Whether the number was given explicitly.
	direct:            bool,
	/// Still allowed on the line.
	active:            bool,
	/// The set or group name (`name-`).
	gsname:            Option<BString>,
}

/// zsh `struct caopt`: an option.
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Caopt {
	/// The name.
	name:   BString,
	/// The description.
	descr:  Option<BString>,
	/// Exclusions when this option is on the line.
	xor:    Option<Vec<BString>>,
	/// `CAO_*`.
	typ:    u8,
	/// Its arguments.
	args:   Vec<Caarg>,
	/// Still allowed on the line.
	active: bool,
	/// The set or group name (`name-`).
	gsname: Option<BString>,
	/// `!…`: not completed.
	not:    bool,
	/// Entered in the single-letter table (zsh `d->single[…]`).
	single: bool,
}

/// zsh `struct cadef`: the definitions of one set.
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Cadef {
	/// The options.
	opts:       Vec<Caopt>,
	/// The normal arguments, by number.
	args:       Vec<Caarg>,
	/// The rest arguments.
	rest:       Option<Caarg>,
	/// `-s`: single-letter options may be clumped.
	single:     bool,
	/// The `-M` matcher.
	matcher:    BString,
	/// Normal arguments are still allowed on the line.
	argsactive: bool,
	/// `CDF_*`.
	flags:      u8,
	/// The `-A` pattern (metafied, tokenized).
	nonarg:     Option<BString>,
}

impl Cadef {
	fn new(single: bool, matcher: &[u8], nonarg: Option<&BString>, flags: u8) -> Self {
		Self {
			opts: Vec::new(),
			args: Vec::new(),
			rest: None,
			single,
			matcher: matcher.into(),
			argsactive: false,
			flags,
			nonarg: nonarg.cloned(),
		}
	}
}

/// A `Caarg` of the parsed sets.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
enum ArgRef {
	/// The `i`th normal argument of set `set`.
	Arg { set: usize, i: usize },
	/// The rest arguments of set `set`.
	Rest { set: usize },
	/// The `i`th argument of option `opt` of set `set`.
	Opt { set: usize, opt: usize, i: usize },
}

impl ArgRef {
	fn get(self, sets: &[Cadef]) -> &Caarg {
		match self {
			Self::Arg { set, i } => &sets[set].args[i],
			Self::Rest { set } => sets[set].rest.as_ref().expect("rest argument"),
			Self::Opt { set, opt, i } => &sets[set].opts[opt].args[i],
		}
	}

	fn get_mut(self, sets: &mut [Cadef]) -> &mut Caarg {
		match self {
			Self::Arg { set, i } => &mut sets[set].args[i],
			Self::Rest { set } => sets[set].rest.as_mut().expect("rest argument"),
			Self::Opt { set, opt, i } => &mut sets[set].opts[opt].args[i],
		}
	}

	/// zsh `arg->next`.
	fn next(self, sets: &[Cadef]) -> Option<Self> {
		match self {
			Self::Arg { set, i } => {
				(i + 1 < sets[set].args.len()).then_some(Self::Arg { set, i: i + 1 })
			},
			Self::Rest { .. } => None,
			Self::Opt { set, opt, i } => {
				(i + 1 < sets[set].opts[opt].args.len()).then_some(Self::Opt { set, opt, i: i + 1 })
			},
		}
	}
}

/// The first argument of option `opt` (zsh `opt->args`).
fn first_oarg(sets: &[Cadef], set: usize, opt: usize) -> Option<ArgRef> {
	(!sets[set].opts[opt].args.is_empty()).then_some(ArgRef::Opt { set, opt, i: 0 })
}

/// The scalar part of zsh `struct castate`.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
struct Scal {
	/// The set.
	d:       usize,
	/// The definition for the current word.
	def:     Option<ArgRef>,
	ddef:    Option<ArgRef>,
	/// The option found on the line.
	curopt:  Option<usize>,
	dopt:    Option<usize>,
	/// Options may be completed (`2`: the word is long enough for one).
	opt:     i64,
	/// Normal or rest arguments may be completed.
	arg:     i64,
	/// The first rest argument (+1).
	argbeg:  i64,
	/// The first word after the last option before the cursor.
	optbeg:  i64,
	nargbeg: i64,
	restbeg: i64,
	/// The current word.
	curpos:  i64,
	/// The number of words.
	argend:  i64,
	/// The word is an option.
	inopt:   i64,
	/// In a normal argument.
	inarg:   i64,
	/// The number of the current normal argument.
	nth:     i64,
	/// The word is clumped single-letter options.
	singles: i64,
	oopt:    i64,
	/// The number of active options.
	actopts: i64,
}

/// zsh `struct castate`: the line parsed against one set.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct Castate {
	s:     Scal,
	/// The normal arguments (`$line`).
	args:  Vec<BString>,
	/// The arguments of each option found (`$opt_args`), by option.
	oargs: Vec<Option<Vec<BString>>>,
}

/// zsh's `ca_parsed`, `ca_doff`, `ca_laststate` (with its `snext` chain)
/// and the definitions it points into.
#[derive(Debug, Default, Serialize, Deserialize)]
struct Record {
	parsed: bool,
	doff:   i64,
	sets:   Vec<Cadef>,
	/// `ca_laststate` and the states chained after it.
	states: Vec<Castate>,
}

// ---- helpers
// ------------------------------------------------------------------

/// `s` for a message.
pub(super) fn lossy(s: &[u8]) -> String {
	String::from_utf8_lossy(s).into_owned()
}

/// zsh `rembslashcolon`: drop the backslash of each `\:`.
fn rembslashcolon(s: &[u8]) -> BString {
	let mut out = Vec::with_capacity(s.len());
	for (i, &c) in s.iter().enumerate() {
		if c != b'\\' || s.get(i + 1) != Some(&b':') {
			out.push(c);
		}
	}
	out.into()
}

/// zsh `bslashcolon`: a backslash before each colon.
fn bslashcolon(s: &[u8]) -> BString {
	let mut out = Vec::with_capacity(s.len() * 2);
	for &c in s {
		if c == b':' {
			out.push(b'\\');
		}
		out.push(c);
	}
	out.into()
}

const fn iblank(c: u8) -> bool {
	matches!(c, b' ' | b'\t')
}

/// zsh `inblank`: blank or newline.
pub(super) const fn inblank(c: u8) -> bool {
	matches!(c, b' ' | b'\t' | b'\n')
}

/// Byte `i` of `s`, NUL past the end (C string access).
pub(super) fn at(s: &[u8], i: usize) -> u8 {
	s.get(i).copied().unwrap_or(0)
}

/// `metafy` + `tokenize`: a pattern as `patcompile` takes it.
fn pat_text(s: &[u8]) -> BString {
	let mut t = tok::metafy(s);
	tokenize(&mut t);
	t.into()
}

/// zsh `patcompile(text, 0, NULL)`: `None` for a malformed pattern.
fn patcompile(
	ctx: &mut Ctx<'_, '_>,
	failed: &mut bool,
	text: &[u8],
) -> Result<Option<Arc<Pattern>>, Need> {
	Ok(px(ctx, failed, |ex| zpattern::try_compile(ex, text, PatFlags::NONE))?.flatten())
}

/// zsh `pattry`; a pattern that did not compile matches nothing.
fn pattry(
	ctx: &mut Ctx<'_, '_>,
	failed: &mut bool,
	pat: Option<&Pattern>,
	s: &[u8],
) -> Result<bool, Need> {
	let Some(pat) = pat else { return Ok(false) };
	Ok(px(ctx, failed, |ex| zpattern::matches(ex, pat, s))?.unwrap_or(false))
}

/// The option `pre`+`c` of the single-letter table (zsh `single_index`
/// and `d->single[]`): the last option entered for it.
fn single_opt(d: &Cadef, pre: u8, c: u8) -> Option<usize> {
	if c <= 0x20 || c > 0x7e {
		return None;
	}
	d.opts
		.iter()
		.rposition(|o| o.single && (pre == b'-') == (o.name[0] == b'-') && o.name[1] == c)
}

/// `(a b c)`: zsh's exclusion list at the start of `p` (at `(`); the
/// index after `)`, `None` when unterminated.
pub(super) fn xor_list(p: &[u8], mut k: usize, list: &mut Vec<BString>) -> Option<usize> {
	while k < p.len() && p[k] != b')' {
		k += 1;
		while inblank(at(p, k)) {
			k += 1;
		}
		if at(p, k) == b')' {
			break;
		}
		let q = k;
		k += 1;
		while k < p.len() && p[k] != b')' && !inblank(p[k]) {
			k += 1;
		}
		if k >= p.len() {
			break;
		}
		list.push(p[q..k].into());
	}
	(at(p, k) == b')').then_some(k + 1)
}

// ---- parsing the definitions
// ------------------------------------------------------------------

/// zsh `parse_caarg`: the description and action at `p[*k..]`; `mult`:
/// more arguments may follow (the action ends at a colon, where `*k` is
/// left).
#[expect(clippy::too_many_arguments, reason = "zsh's signature")]
pub(super) fn parse_caarg(
	mult: bool,
	typ: u8,
	num: i64,
	opt: i64,
	oname: Option<&[u8]>,
	p: &[u8],
	k: &mut usize,
	set: Option<&BString>,
) -> Caarg {
	let d = *k;
	while *k < p.len() && p[*k] != b':' {
		if p[*k] == b'\\' && *k + 1 < p.len() {
			*k += 1;
		}
		*k += 1;
	}
	let descr = rembslashcolon(&p[d..*k]);
	let action = if *k < p.len() {
		if mult {
			*k += 1;
			let d = *k;
			while *k < p.len() && p[*k] != b':' {
				if p[*k] == b'\\' && *k + 1 < p.len() {
					*k += 1;
				}
				*k += 1;
			}
			rembslashcolon(&p[d..*k])
		} else {
			let a = rembslashcolon(&p[*k + 1..]);
			*k = p.len();
			a
		}
	} else {
		BString::default()
	};
	Caarg {
		descr,
		xor: None,
		action,
		typ,
		end: None,
		opt: oname.map(BString::from),
		num,
		min: num - opt,
		direct: false,
		active: false,
		gsname: set.cloned(),
	}
}

/// zsh `set_cadef_opts`: the earliest position of each argument not
/// numbered explicitly.
fn set_cadef_opts(d: &mut Cadef) {
	let mut xnum = 0;
	for a in &mut d.args {
		if !a.direct {
			a.min = a.num - xnum;
		}
		if a.typ == CAA_OPT {
			xnum += 1;
		}
	}
}

/// `( … )` around a set or group name: the name and whether it was
/// parenthesized (zsh `axor`).
fn set_name(p: &[u8]) -> (BString, bool) {
	if p.len() >= 2 && p[0] == b'(' && p[p.len() - 1] == b')' {
		(p[1..p.len() - 1].into(), true)
	} else {
		(p.into(), false)
	}
}

/// zsh `parse_cadef`: the definitions of every set; `Err` with the
/// warning to print (`None`: fail quietly).
#[expect(clippy::too_many_lines, reason = "a faithful port of one C function")]
fn parse_cadef(args: &[BString]) -> Result<Vec<Cadef>, Option<String>> {
	// The auto-description, `%d` replaced by the argument's description.
	let ad = args[0]
		.windows(2)
		.position(|w| w == b"%d")
		.map(|k| (&args[0][..k], &args[0][k + 2..]));

	// `-s`, `-S`, `-A pat`, `-M spec`.
	let mut i = 1;
	let (mut single, mut flags) = (false, 0u8);
	let mut nonarg: Option<BString> = None;
	let mut matcher: BString = "r:|[_-]=* r:|=*".into();
	while let Some(p) = args.get(i)
		&& p.len() >= 2
		&& p[0] == b'-'
	{
		let p = &p[1..];
		let mut ok = true;
		for &c in p {
			if c == b'M' || c == b'A' {
				break;
			} else if c != b's' && c != b'S' {
				ok = false;
				break;
			}
		}
		if !ok {
			break;
		}
		let mut j = 0;
		let mut stop = false;
		while j < p.len() {
			match p[j] {
				b's' => single = true,
				b'S' => flags |= CDF_SEP,
				c @ (b'A' | b'M') => {
					let v: BString = if j + 1 < p.len() {
						let v = p[j + 1..].into();
						j = p.len() - 1;
						v
					} else if i + 1 < args.len() {
						i += 1;
						args[i].clone()
					} else {
						stop = true;
						break;
					};
					if c == b'A' {
						nonarg = Some(v);
					} else {
						matcher = v;
					}
				},
				_ => {},
			}
			j += 1;
		}
		if stop {
			break;
		}
		i += 1;
	}
	if args.get(i).is_some_and(|a| a == ":") {
		i += 1;
	}
	if i >= args.len() {
		return Err(None);
	}
	let nonarg = nonarg.map(|n| pat_text(&n));

	let mut sets = vec![Cadef::new(single, &matcher, nonarg.as_ref(), flags)];
	let sargs = i;
	let mut anum: i64 = 1;
	let mut doset: Option<BString> = None;
	let mut axor: Option<BString> = None;
	let mut pendset: Option<usize> = None;
	let mut curset: Option<usize> = None;
	let mut foreignset = false;
	loop {
		if i >= args.len() {
			if pendset.is_none() {
				break;
			}
			// Start the next set: the common definitions again.
			i = sargs;
			doset = None;
			let last = sets.len() - 1;
			set_cadef_opts(&mut sets[last]);
			sets.push(Cadef::new(single, &matcher, nonarg.as_ref(), flags));
			anum = 1;
			foreignset = false;
			curset = pendset.take();
		}
		let set = sets.len() - 1;
		let spec = &args[i];
		if spec == "-" && i + 1 < args.len() {
			foreignset = curset.is_some_and(|c| c != i);
			if foreignset {
				if pendset.is_none() && curset.is_some_and(|c| i > c) {
					pendset = Some(i);
				}
				i += 1;
			} else {
				i += 1;
				let (name, paren) = set_name(&args[i]);
				axor = paren.then(|| name.clone());
				if name.is_empty() {
					return Err(Some("empty set name".into()));
				}
				let mut n = name;
				n.push(b'-');
				doset = Some(n);
				curset = Some(i);
			}
			i += 1;
			continue;
		} else if spec == "+" && i + 1 < args.len() {
			foreignset = false;
			i += 1;
			let (name, paren) = set_name(&args[i]);
			axor = paren.then(|| name.clone());
			if name.is_empty() {
				return Err(Some("empty group name".into()));
			}
			let mut n = name;
			n.push(b'-');
			doset = Some(n);
			i += 1;
			continue;
		} else if foreignset {
			i += 1;
			continue;
		}
		let invalid = |what: &str| Err(Some(format!("{what}: {}", lossy(spec))));
		let p: &[u8] = spec;
		let mut k = 0;
		let not = at(p, 0) == b'!';
		if not {
			k += 1;
		}
		let gaxor = doset.is_some().then_some(axor.as_ref()).flatten();
		let mut xor: Option<Vec<BString>> = None;
		let xnum;
		if at(p, k) == b'(' {
			let mut list = Vec::new();
			let Some(e) = xor_list(p, k, &mut list) else {
				return invalid("invalid argument");
			};
			k = e;
			if let Some(ax) = gaxor {
				list.push(ax.clone());
			}
			xnum = list.len();
			xor = Some(list);
		} else if let Some(ax) = gaxor {
			xnum = 1;
			xor = Some(vec![ax.clone()]);
		} else {
			xnum = 0;
		}

		let c0 = at(p, k);
		if c0 == b'-' || c0 == b'+' || (c0 == b'*' && matches!(at(p, k + 1), b'-' | b'+')) {
			// An option; `-+x` and `+-x` define both `+x` and `-x`.
			let mut again = 0;
			let mut w: Vec<u8> = p[k..].to_vec();
			loop {
				let mut k = 0;
				let mut againp = None;
				let multi = at(&w, 0) == b'*';
				if multi {
					k += 1;
				}
				let name_start;
				if ((at(&w, k) == b'-' && at(&w, k + 1) == b'+')
					|| (at(&w, k) == b'+' && at(&w, k + 1) == b'-'))
					&& !matches!(at(&w, k + 2), 0 | b':' | b'[' | b'=' | b'-' | b'+')
				{
					againp = Some(w[k..].to_vec());
					k += 1;
					name_start = k;
					w[k] = if again > 0 { b'-' } else { b'+' };
					again += 1;
				} else {
					name_start = k;
					if at(&w, k) == b'-' && at(&w, k + 1) == b'-' {
						k += 1;
					}
				}
				if at(&w, k + 1) == 0 {
					return invalid("invalid argument");
				}
				// The name.
				k += 1;
				loop {
					let c = at(&w, k);
					let n = at(&w, k + 1);
					if c == 0
						|| c == b':'
						|| c == b'['
						|| ((c == b'-' || c == b'+') && (n == b':' || n == b'['))
						|| (c == b'=' && (n == b':' || n == b'[' || n == b'-'))
					{
						break;
					}
					if c == b'\\' && n != 0 {
						k += 1;
					}
					k += 1;
				}
				let name_end = k;
				// Its type.
				let mut otype = CAO_NEXT;
				let mut c = at(&w, k);
				if c == b'-' {
					otype = CAO_DIRECT;
					k += 1;
					c = at(&w, k);
				} else if c == b'+' {
					otype = CAO_ODIRECT;
					k += 1;
					c = at(&w, k);
				} else if c == b'=' {
					otype = CAO_OEQUAL;
					k += 1;
					c = at(&w, k);
					if c == b'-' {
						otype = CAO_EQUAL;
						k += 1;
						c = at(&w, k);
					}
				}
				// The description.
				let mut descr: Option<BString> = None;
				if c == b'[' {
					k += 1;
					let d = k;
					while k < w.len() && w[k] != b']' {
						if w[k] == b'\\' && k + 1 < w.len() {
							k += 1;
						}
						k += 1;
					}
					if k >= w.len() {
						return invalid("invalid option definition");
					}
					descr = Some(w[d..k].into());
					k += 1;
					c = at(&w, k);
				}
				if c != 0 && c != b':' {
					return invalid("invalid option definition");
				}
				let name = &w[name_start..name_end];
				if !multi {
					let x = xor.get_or_insert_with(Vec::new);
					x.truncate(xnum);
					x.push(rembslashcolon(name));
				}
				// Its arguments.
				let mut oargs: Vec<Caarg> = Vec::new();
				if c == b':' {
					let (mut oanum, mut onum) = (1, 0);
					while c == b':' {
						let mut rest = false;
						let mut end = None;
						k += 1;
						let atype;
						if at(&w, k) == b':' {
							atype = CAA_OPT;
							k += 1;
						} else if at(&w, k) == b'*' {
							k += 1;
							if at(&w, k) != b':' && at(&w, k) != 0 {
								let e = k;
								k += 1;
								while k < w.len() && w[k] != b':' {
									if w[k] == b'\\' && k + 1 < w.len() {
										k += 1;
									}
									k += 1;
								}
								end = Some(pat_text(&w[e..k]));
							}
							if at(&w, k) != b':' {
								return invalid("invalid option definition");
							}
							k += 1;
							if at(&w, k) == b':' {
								k += 1;
								if at(&w, k) == b':' {
									atype = CAA_RREST;
									k += 1;
								} else {
									atype = CAA_RARGS;
								}
							} else {
								atype = CAA_REST;
							}
							rest = true;
						} else {
							atype = CAA_NORMAL;
						}
						let mut a =
							parse_caarg(!rest, atype, oanum, onum, Some(name), &w, &mut k, doset.as_ref());
						oanum += 1;
						if atype == CAA_OPT {
							onum += 1;
						}
						a.end = end;
						oargs.push(a);
						if rest {
							break;
						}
						c = at(&w, k);
					}
				}
				let descr = descr.or_else(|| {
					let (pre, suf) = ad?;
					let [a] = oargs.as_slice() else { return None };
					a.descr.iter().any(|&c| !iblank(c)).then(|| {
						let mut d = BString::from(pre);
						d.extend_from_slice(&a.descr);
						d.extend_from_slice(suf);
						d
					})
				});
				let in_single =
					single && name.len() == 2 && name[1] != b'-' && name[1] > 0x20 && name[1] <= 0x7e;
				let opt = Caopt {
					name: rembslashcolon(name),
					descr,
					xor: if again == 1 { xor.clone() } else { xor.take() },
					typ: otype,
					args: oargs,
					active: false,
					gsname: doset.clone(),
					not,
					single: in_single,
				};
				sets[set].opts.push(opt);
				match againp {
					Some(a) if again == 1 => w = a,
					_ => break,
				}
			}
		} else if c0 == b'*' {
			// The rest arguments.
			if not {
				i += 1;
				continue;
			}
			k += 1;
			if at(p, k) != b':' {
				return invalid("invalid rest argument definition");
			}
			if sets[set].rest.is_some() {
				return invalid("doubled rest argument definition");
			}
			k += 1;
			let mut typ = CAA_REST;
			if at(p, k) == b':' {
				k += 1;
				if at(p, k) == b':' {
					typ = CAA_RREST;
					k += 1;
				} else {
					typ = CAA_RARGS;
				}
			}
			let mut a = parse_caarg(false, typ, -1, 0, None, p, &mut k, doset.as_ref());
			a.xor = xor;
			sets[set].rest = Some(a);
		} else {
			// A normal argument.
			if not {
				i += 1;
				continue;
			}
			let direct = at(p, k).is_ascii_digit();
			if direct {
				let mut num: i64 = 0;
				while at(p, k).is_ascii_digit() {
					num = num.wrapping_mul(10).wrapping_add(i64::from(p[k] - b'0'));
					k += 1;
				}
				anum = num + 1;
			} else {
				anum += 1;
			}
			if at(p, k) != b':' {
				return invalid("invalid argument");
			}
			k += 1;
			let mut typ = CAA_NORMAL;
			if at(p, k) == b':' {
				typ = CAA_OPT;
				k += 1;
			}
			let mut a = parse_caarg(false, typ, anum - 1, 0, None, p, &mut k, doset.as_ref());
			a.xor = xor;
			a.direct = direct;
			let list = &mut sets[set].args;
			let pos = list
				.iter()
				.position(|t| t.num >= anum - 1)
				.unwrap_or(list.len());
			if list.get(pos).is_some_and(|t| t.num == anum - 1) {
				return invalid("doubled argument definition");
			}
			list.insert(pos, a);
		}
		i += 1;
	}
	let last = sets.len() - 1;
	set_cadef_opts(&mut sets[last]);
	Ok(sets)
}

// ---- looking things up
// ------------------------------------------------------------------

/// zsh `ca_get_opt`: the active option `line` is (`full`) or starts with;
/// the option and the offset of its end in `line` (after an `=`).
fn ca_get_opt(d: &Cadef, line: &[u8], full: bool) -> Option<(usize, usize)> {
	if let Some(i) = d.opts.iter().position(|p| p.active && p.name == line) {
		return Some((i, line.len()));
	}
	if !full {
		for (i, p) in d.opts.iter().enumerate() {
			if !p.active {
				continue;
			}
			let hit = if p.args.is_empty() || p.typ == CAO_NEXT {
				p.name == line
			} else {
				line.starts_with(&p.name)
			};
			if !hit {
				continue;
			}
			let l = p.name.len();
			let eq = matches!(p.typ, CAO_OEQUAL | CAO_EQUAL);
			if eq && l < line.len() && line[l] != b'=' {
				continue;
			}
			return Some((i, if eq && at(line, l) == b'=' { l + 1 } else { l }));
		}
	}
	None
}

/// zsh `ca_get_sopt`: the option the clumped single-letter options in
/// `line` end with; the option, the end of the options in `line`, and
/// the options before it whose arguments follow in the next words.
fn ca_get_sopt(d: &Cadef, line: &[u8]) -> (Option<usize>, Option<usize>, Vec<usize>) {
	let pre = line[0];
	let mut list = Vec::new();
	let mut pp = None;
	let mut i = 1;
	while i < line.len() {
		let p = single_opt(d, pre, line[i]);
		match p {
			Some(o) if d.opts[o].active && !d.opts[o].args.is_empty() => {
				if d.opts[o].typ == CAO_NEXT {
					list.push(o);
				} else {
					i += 1;
					if matches!(d.opts[o].typ, CAO_OEQUAL | CAO_EQUAL) && at(line, i) == b'=' {
						i += 1;
					}
					return (Some(o), Some(i), list);
				}
			},
			Some(o) if d.opts[o].active => {},
			_ => return (None, None, list),
		}
		pp = p.filter(|&o| d.opts[o].name[0] == pre);
		i += 1;
	}
	(pp, pp.map(|_| i), list)
}

/// zsh `ca_foreign_opt`: whether a set other than `cur` has an option
/// named `option`.
fn ca_foreign_opt(sets: &[Cadef], cur: usize, option: &[u8]) -> bool {
	sets
		.iter()
		.enumerate()
		.any(|(i, d)| i != cur && d.opts.iter().any(|p| p.name == option))
}

/// zsh `ca_get_arg`: the definition of normal argument `n` of set `set`.
fn ca_get_arg(sets: &[Cadef], set: usize, mut n: i64) -> Option<ArgRef> {
	let d = &sets[set];
	if !d.argsactive {
		return None;
	}
	let mut i = 0;
	while let Some(a) = d.args.get(i)
		&& (!a.active || n < a.min || n > a.num)
	{
		if !a.active {
			n += 1;
		}
		i += 1;
	}
	if let Some(a) = d.args.get(i)
		&& a.min <= n
		&& a.num >= n
		&& a.active
	{
		return Some(ArgRef::Arg { set, i });
	}
	d.rest
		.as_ref()
		.filter(|r| r.active)
		.map(|_| ArgRef::Rest { set })
}

/// Whether set/group name `gs` is `grp` (zsh's `strncmp` and the length
/// test after it; `exact`: the name is followed only by `extra` bytes).
fn gs_is(gs: Option<&BString>, grp: &[u8], extra: usize, exact: bool) -> bool {
	gs.is_some_and(|gs| gs.starts_with(grp) && (!exact || gs.len() <= grp.len() + extra))
}

/// zsh `ca_inactive`: deactivate what `xor` excludes (`opts`: every
/// option) once word `cur` is reached.
fn ca_inactive(d: &mut Cadef, xor: Option<&[BString]>, cur: i64, opts: bool, compcurrent: i64) {
	if !((xor.is_some() || opts) && cur <= compcurrent) {
		return;
	}
	// The current word may be the prefix of a longer option: exclude only
	// for clumped single-letter options.
	let single = !opts && cur == compcurrent;
	let list = xor.unwrap_or_default();
	let mut n = 0;
	loop {
		let x: &[u8] = if opts {
			b"-"
		} else {
			match list.get(n) {
				Some(x) => x,
				None => break,
			}
		};
		n += 1;
		let mut excludeall = false;
		let mut sep = 0;
		loop {
			let c = at(x, sep);
			if matches!(c, b'+' | b'-' | b':' | b'*') || c.is_ascii_digit() {
				break;
			}
			match x[sep..].iter().position(|&b| b == b'-') {
				Some(k) if sep + k + 1 < x.len() => sep += k + 1,
				_ => {
					// Just the name of a set or group.
					excludeall = true;
					sep = x.len();
					break;
				},
			}
		}
		let grp = (sep > 0).then(|| &x[..sep]);
		let x = &x[sep..];
		let extra = usize::from(excludeall);
		let in_grp = |gs: Option<&BString>| grp.is_none_or(|g| gs_is(gs, g, extra, true));

		if excludeall || x == b":" {
			if let Some(g) = grp {
				for a in &mut d.args {
					if gs_is(a.gsname.as_ref(), g, extra, true) {
						a.active = false;
					}
				}
				if let Some(r) = &mut d.rest
					&& gs_is(r.gsname.as_ref(), g, extra, true)
				{
					r.active = false;
				}
			} else {
				d.argsactive = false;
			}
		}
		if excludeall || x == b"-" {
			for p in &mut d.opts {
				if in_grp(p.gsname.as_ref()) && !(single && p.name.len() >= 3) {
					p.active = false;
				}
			}
		}
		if (excludeall || x == b"*")
			&& let Some(r) = &mut d.rest
			&& in_grp(r.gsname.as_ref())
		{
			r.active = false;
		}
		if !excludeall {
			if at(x, 0).is_ascii_digit() {
				let n = super::atoi(x);
				if let Some(a) = d.args.iter_mut().find(|a| a.num >= n)
					&& a.num == n
					&& grp.is_none_or(|g| gs_is(a.gsname.as_ref(), g, 0, false))
				{
					a.active = false;
				}
			} else if let Some((o, _)) = ca_get_opt(d, x, true)
				&& grp.is_none_or(|g| gs_is(d.opts[o].gsname.as_ref(), g, 0, false))
				&& !(single && d.opts[o].name.len() >= 3)
			{
				d.opts[o].active = false;
			}
			if opts {
				break;
			}
		}
	}
}

/// zsh `ca_opt_arg`: the argument in `line` after the option name
/// (quoting in the name ignored) and an `=`.
fn ca_opt_arg(opt: &Caopt, line: &[u8]) -> BString {
	let o: &[u8] = &opt.name;
	let (mut io, mut il) = (0, 0);
	loop {
		if at(o, io) == b'\\' {
			io += 1;
		}
		if matches!(at(line, il), b'\\' | b'\'' | b'"') {
			il += 1;
		}
		if at(o, io) == 0 || at(o, io) != at(line, il) {
			break;
		}
		io += 1;
		il += 1;
	}
	if at(line, il) != 0 && matches!(opt.typ, CAO_EQUAL | CAO_OEQUAL) {
		if at(line, il) == b'\\' {
			il += 1;
		}
		if at(line, il) == b'=' {
			il += 1;
		}
	}
	line.get(il..).unwrap_or_default().into()
}

/// Whether option type `t` takes its argument from its own word, which
/// ends the option at `pe`.
fn own_word_arg(t: u8, line: &[u8], pe: usize) -> bool {
	let rest = pe < line.len();
	t == CAO_DIRECT
		|| t == CAO_EQUAL
		|| (t == CAO_ODIRECT && rest)
		|| (t == CAO_OEQUAL && (rest || line.get(pe.wrapping_sub(1)) == Some(&b'=')))
}

const fn is_rest(t: u8) -> bool {
	matches!(t, CAA_REST | CAA_RARGS | CAA_RREST)
}

// ---- parsing the line
// ------------------------------------------------------------------

/// The parsed definitions and zsh's `ca_doff` while `-i` parses the line.
struct LineParser<'w> {
	sets:  Vec<Cadef>,
	doff:  i64,
	words: &'w [BString],
	/// `CURRENT`.
	cc:    i64,
	/// `ca_laststate`.
	last:  Castate,
}

/// What a word on the line is.
enum Word {
	/// An option (`ca_get_opt`).
	Opt,
	/// Clumped single-letter options (`ca_get_sopt`).
	Sopts,
	/// An option of another set: this set does not apply.
	Foreign,
	/// A normal argument.
	Arg,
	/// None of these.
	Other,
}

impl LineParser<'_> {
	fn inactive_opt_xor(&mut self, d: usize, o: usize, cur: i64) {
		let x = std::mem::take(&mut self.sets[d].opts[o].xor);
		ca_inactive(&mut self.sets[d], x.as_deref(), cur, false, self.cc);
		self.sets[d].opts[o].xor = x;
	}

	fn inactive_arg_xor(&mut self, d: usize, a: ArgRef, cur: i64) {
		let x = std::mem::take(&mut a.get_mut(&mut self.sets).xor);
		ca_inactive(&mut self.sets[d], x.as_deref(), cur, false, self.cc);
		a.get_mut(&mut self.sets).xor = x;
	}

	/// zsh `ca_parse_line` for set `d`: `true` when the set does not apply
	/// to the line (it has an option of another set); `self.last` is the
	/// state.
	#[expect(clippy::too_many_lines, reason = "a faithful port of one C function")]
	fn parse_line(
		&mut self,
		ctx: &mut Ctx<'_, '_>,
		failed: &mut bool,
		d: usize,
		multi: bool,
	) -> Result<bool, Need> {
		let words = self.words;
		let cc = self.cc;
		{
			let ds = &mut self.sets[d];
			for o in &mut ds.opts {
				o.active = true;
			}
			ds.argsactive = true;
			if let Some(r) = &mut ds.rest {
				r.active = true;
			}
			for a in &mut ds.args {
				a.active = true;
			}
		}
		let argend = words.len() as i64 - 1;
		let mut state = Scal {
			d,
			argbeg: 1,
			optbeg: 1,
			nargbeg: 1,
			restbeg: 1,
			actopts: 1,
			nth: 1,
			inarg: 1,
			opt: 1,
			arg: 1,
			argend,
			curpos: cc,
			..Scal::default()
		};
		// zsh shares these lists between `state` and `ca_laststate`.
		let mut args: Vec<BString> = Vec::new();
		let mut oargs: Vec<Option<Vec<BString>>> = vec![None; self.sets[d].opts.len()];
		let mut last = state;

		let skip = 'parse: {
			if words.len() < 2 {
				last.opt = 0;
				last.arg = 0;
				break 'parse false;
			}
			let napat = match &self.sets[d].nonarg {
				Some(t) => patcompile(ctx, failed, t)?,
				None => None,
			};
			let mut endpat: Option<Arc<Pattern>> = None;
			let mut argxor: Option<ArgRef> = None;
			let mut sopts: Vec<usize> = Vec::new();
			let mut wasopt: Option<usize> = None;
			// zsh's `pe` (reset for each word that is looked at).
			let mut pe: Option<usize>;
			let mut doff: i64 = 0;
			let mut cur: i64 = 2;
			'words: while let Some(line) = words.get((cur - 1) as usize) {
				let line: &[u8] = line;
				let pm = matches!(line.first(), Some(b'-' | b'+'));
				'word: {
					let mut ddef = None;
					let mut adef = None;
					let mut dopt = None;
					state.singles = 0;
					let mut arglast = false;

					if let Some(a) = argxor.take() {
						self.inactive_arg_xor(d, a, cur - 1);
					}
					if self.sets[d].flags & CDF_SEP != 0
						&& cur != cc
						&& state.actopts != 0
						&& line == b"--"
					{
						ca_inactive(&mut self.sets[d], None, cur, true, cc);
						state.actopts = 0;
						break 'word;
					}

					// With a definition for an option or the rest arguments,
					// this word is an argument of that.
					let mut to_cont = false;
					if let Some(def) = state.def {
						state.arg = 0;
						if let Some(co) = state.curopt {
							oargs[co].get_or_insert_with(Vec::new).push(line.into());
						}
						let (dtyp, dopt_is, dend) = {
							let a = def.get(&self.sets);
							(a.typ, a.opt.is_some(), a.end.is_some())
						};
						state.opt = i64::from(dtyp == CAA_OPT);
						if state.opt != 0 && dopt_is {
							state.oopt += 1;
						}
						if is_rest(dtyp) {
							if dend && pattry(ctx, failed, endpat.as_deref(), line)? {
								state.def = None;
								state.curopt = None;
								state.opt = 1;
								state.arg = 1;
								state.argend = cur - 1;
								last.argend = cur - 1;
								to_cont = true;
							}
						} else if let Some(nx) = def.next(&self.sets) {
							state.def = Some(nx);
							state.argbeg = cur;
							state.argend = argend;
						} else if !sopts.is_empty() {
							let co = sopts.remove(0);
							state.curopt = Some(co);
							state.def = first_oarg(&self.sets, d, co);
							state.opt = 0;
							state.argbeg = cur;
							state.optbeg = cur;
							state.inopt = cur;
							state.argend = argend;
							doff = 0;
							state.singles = 1;
							oargs[co].get_or_insert_with(Vec::new);
							to_cont = true;
						} else {
							state.def = None;
							state.curopt = None;
							state.opt = 1;
						}
					} else {
						state.opt = 1;
						state.arg = 1;
						state.curopt = None;
					}

					if !to_cont {
						if state.opt != 0 {
							state.opt = match line.len() {
								0 => 0,
								1 => 1,
								_ => 2,
							};
						}
						pe = None;
						wasopt = None;

						// What is it? (zsh's `if`/`else if` chain, with the
						// assignments its conditions make.)
						let mut kind = Word::Other;
						if state.opt == 2 && pm {
							let r = ca_get_opt(&self.sets[d], line, false);
							state.curopt = r.map(|r| r.0);
							if let Some((co, e)) = r {
								pe = Some(e);
								let eq = line.get(e.wrapping_sub(1)) == Some(&b'=');
								let ok = match self.sets[d].opts[co].typ {
									CAO_OEQUAL => words.get(cur as usize).is_some() || eq,
									CAO_EQUAL => eq || e >= line.len(),
									_ => true,
								};
								if ok {
									kind = Word::Opt;
								}
							}
						}
						if matches!(kind, Word::Other) && state.opt == 2 && self.sets[d].single && pm {
							let (r, e, l) = ca_get_sopt(&self.sets[d], line);
							sopts = l;
							state.curopt = r;
							if r.is_some() {
								pe = e;
							}
							if r.is_some() || (cur != cc && !sopts.is_empty()) {
								kind = Word::Sopts;
							}
						}
						if matches!(kind, Word::Other) {
							if multi && pm && cur != cc && ca_foreign_opt(&self.sets, d, line) {
								kind = Word::Foreign;
							} else if state.arg != 0 && cur <= cc {
								kind = Word::Arg;
							}
						}

						match kind {
							Word::Opt => {
								let co = state.curopt.expect("option");
								let e = pe.expect("option end");
								let eq = line.get(e.wrapping_sub(1)) == Some(&b'=');
								let typ = self.sets[d].opts[co].typ;
								state.def = if typ != CAO_EQUAL || eq {
									first_oarg(&self.sets, d, co)
								} else {
									None
								};
								ddef = state.def;
								if ddef.is_some() {
									dopt = Some(co);
								}
								doff = e as i64;
								state.optbeg = cur;
								state.argbeg = cur;
								state.inopt = cur;
								state.argend = argend;
								let name = &self.sets[d].opts[co].name;
								state.singles = i64::from(
									self.sets[d].single
										&& e >= line.len()
										&& name.len() == 2
										&& name[1] != b'-',
								);
								oargs[co].get_or_insert_with(Vec::new);
								self.inactive_opt_xor(d, co, cur);

								if let Some(def) = state.def
									&& own_word_arg(typ, line, e)
								{
									if !is_rest(def.get(&self.sets).typ) {
										state.def = def.next(&self.sets);
									}
									let a = ca_opt_arg(&self.sets[d].opts[co], line);
									oargs[co].get_or_insert_with(Vec::new).push(a);
								}
								if state.def.is_some() {
									state.opt = 0;
								} else {
									if !self.sets[d].single || self.sets[d].opts[co].name.len() >= 3 {
										wasopt = Some(co);
									}
									state.curopt = None;
								}
							},
							Word::Sopts => {
								if cur != cc && !sopts.is_empty() {
									state.curopt = Some(sopts.remove(0));
								}
								let co = state.curopt.expect("option");
								oargs[co].get_or_insert_with(Vec::new);
								state.def = first_oarg(&self.sets, d, co);
								let typ = self.sets[d].opts[co].typ;
								ddef = if typ == CAO_NEXT && cur == cc {
									None
								} else {
									state.def
								};
								dopt = Some(co);
								doff = pe.map_or(0, |e| e as i64);
								state.optbeg = cur;
								state.argbeg = cur;
								state.inopt = cur;
								state.argend = argend;
								state.singles = i64::from(pe.is_none_or(|e| e >= line.len()));
								for j in 1..pe.unwrap_or(0) {
									if let Some(t) = single_opt(&self.sets[d], line[0], line[j]) {
										oargs[t].get_or_insert_with(Vec::new);
										self.inactive_opt_xor(d, t, cur);
									}
								}
								if let Some(def) = state.def
									&& own_word_arg(typ, line, pe.unwrap_or(0))
								{
									if !is_rest(def.get(&self.sets).typ) {
										state.def = def.next(&self.sets);
									}
									let a = ca_opt_arg(&self.sets[d].opts[co], line);
									oargs[co].get_or_insert_with(Vec::new).push(a);
								}
								if state.def.is_some() {
									state.opt = 0;
								} else {
									state.curopt = None;
								}
							},
							Word::Foreign => break 'parse true,
							Word::Arg => {
								// The `-A` pattern: a match is an unknown option.
								if let Some(np) = &napat
									&& cur < cc
									&& state.actopts != 0
								{
									if pattry(ctx, failed, Some(&**np), line)? {
										break 'word;
									}
									ca_inactive(&mut self.sets[d], None, cur + 1, true, cc);
									state.actopts = 0;
								}
								arglast = true;
								// The first normal argument after an option.
								if state.inopt != 0 {
									state.inopt = 0;
									state.nargbeg = cur - 1;
									state.argend = argend;
								}
								let ds = &self.sets[d];
								if ds.args.is_empty() && ds.rest.is_none() && !line.is_empty() && !pm {
									if !multi && cur > cc {
										break 'words;
									}
									break 'parse true;
								}
								adef = ca_get_arg(&self.sets, d, state.nth);
								state.def = adef;
								if let Some(a) = adef
									&& matches!(a.get(&self.sets).typ, CAA_RREST | CAA_RARGS)
								{
									// The rest arguments: what follows is theirs,
									// unless the current word was described already.
									if last.def.is_some() {
										break 'words;
									}
									state.opt = i64::from(
										cur == state.nargbeg + 1 && (!multi || line.is_empty() || pm),
									);
									state.optbeg = state.nargbeg;
									state.argbeg = cur - 1;
									state.argend = argend;
									args.extend(words[(cur - 1) as usize..].iter().cloned());
									last = state;
									last.ddef = None;
									last.dopt = None;
									break 'words;
								}
								args.push(line.into());
								if let Some(a) = adef {
									state.oopt = a.get(&self.sets).num - state.nth;
								}
								if state.def.is_some() && cur != cc {
									argxor = state.def;
								}
								let dt = state.def.map(|r| r.get(&self.sets).typ);
								if let Some(t) = dt
									&& t != CAA_NORMAL
									&& t != CAA_OPT
									&& state.inarg != 0
								{
									state.restbeg = cur;
									state.inarg = 0;
								} else if dt.is_none_or(|t| t == CAA_NORMAL || t == CAA_OPT) {
									state.inarg = 1;
								}
								state.nth += 1;
								state.def = None;
							},
							Word::Other => {},
						}

						// The end pattern, if needed.
						if let Some(def) = state.def
							&& state.curopt.is_some()
							&& matches!(def.get(&self.sets).typ, CAA_RREST | CAA_RARGS)
						{
							if let Some(end) = &def.get(&self.sets).end {
								endpat = patcompile(ctx, failed, end)?;
							} else {
								let co = state.curopt.expect("option");
								if cur < cc {
									last = state;
								}
								oargs[co]
									.get_or_insert_with(Vec::new)
									.extend(words[(cur - 1) as usize..].iter().cloned());
								last.ddef = None;
								last.dopt = None;
								break 'words;
							}
						} else if let Some(def) = state.def
							&& let Some(end) = &def.get(&self.sets).end
						{
							endpat = patcompile(ctx, failed, end)?;
						}
					}

					// cont: keep the state for the current word.
					if cur + 1 == cc {
						last = state;
						last.ddef = None;
						last.dopt = None;
					} else if cur == cc && last.def.is_none() {
						last.def = ddef;
						if ddef.is_some() {
							last.singles = state.singles;
							if let Some(co) = state.curopt
								&& self.sets[d].opts[co].typ == CAO_NEXT
							{
								last.ddef = ddef;
								last.dopt = dopt;
								last.def = None;
								last.opt = 1;
								self.sets[d].opts[co].active = true;
							} else {
								self.doff = doff;
								last.opt = 0;
							}
						} else {
							last.def = adef;
							last.opt = i64::from(!arglast || !multi || line.is_empty() || pm);
							last.ddef = None;
							last.dopt = None;
							last.optbeg = state.nargbeg;
							last.argbeg = state.restbeg;
							last.argend = state.argend;
							last.singles = state.singles;
							last.oopt = state.oopt;
							if let Some(w) = wasopt {
								self.sets[d].opts[w].active = true;
							}
						}
					}
				}
				cur += 1;
			}
			false
		};
		if !skip {
			last.actopts = self.sets[d].opts.iter().filter(|o| o.active).count() as i64;
		}
		self.last = Castate { s: last, args, oargs };
		Ok(skip)
	}
}

// ---- the results
// ------------------------------------------------------------------

/// The lists `-D` and `-L` return.
#[derive(Default)]
struct Data {
	descr: Vec<BString>,
	act:   Vec<BString>,
	subc:  Vec<BString>,
}

/// zsh `restrict_range`: narrow `words` to `b..=e`.
fn restrict_range(ctx: &mut Ctx<'_, '_>, b: i64, e: i64) {
	if let Some(c) = super::super::comp_mut(ctx.vp) {
		super::super::complete::restrict_range(c, b, e);
	}
}

/// zsh `ca_set_data`: add the descriptions, actions and tags (`subc`) for
/// `arg` (an argument of an option when `opt`; `optdef` the option found
/// on the line) and what may follow it.
fn ca_set_data(
	ctx: &mut Ctx<'_, '_>,
	rec: &Record,
	data: &mut Data,
	mut opt: bool,
	mut arg: Option<ArgRef>,
	optdef: Option<(usize, usize)>,
	single: bool,
) {
	let sets = &rec.sets;
	let head = &rec.states[0].s;
	let head_rest = || {
		sets[head.d]
			.rest
			.as_ref()
			.filter(|r| r.active)
			.map(|_| ArgRef::Rest { set: head.d })
	};
	let mut restr = false;
	let mut miss = false;
	let mut oopt: i64 = 1;
	let mut lopt = false;
	loop {
		let addopt = if opt { 0 } else { head.oopt };
		while let Some(ar) = arg {
			let a = ar.get(sets);
			if !(opt || a.num < 0 || (a.min <= head.nth + addopt && a.num >= head.nth)) {
				break;
			}
			lopt = a.typ == CAA_OPT;
			if !opt && !lopt && oopt > 0 {
				oopt = 0;
			}
			let known = data
				.descr
				.iter()
				.zip(&data.act)
				.any(|(d, ac)| *d == a.descr && *ac == a.action);
			// With an ignored prefix, no normal arguments are completed.
			if single && a.opt.is_none() {
				return;
			}
			if !known {
				data.descr.push(a.descr.clone());
				data.act.push(a.action.clone());
				if !restr {
					if a.typ == CAA_RARGS {
						restr = true;
						restrict_range(ctx, head.optbeg, head.argend);
					} else if a.typ == CAA_RREST {
						restr = true;
						restrict_range(ctx, head.argbeg, head.argend);
					}
				}
				let mut buf = a.gsname.clone().unwrap_or_default();
				if let Some(o) = &a.opt {
					buf.extend_from_slice(b"option");
					buf.extend_from_slice(o);
					if a.num > 0 && a.typ < CAA_REST {
						buf.extend_from_slice(format!("-{}", a.num).as_bytes());
					} else {
						buf.extend_from_slice(b"-rest");
					}
				} else if a.num > 0 {
					buf.extend_from_slice(format!("argument-{}", a.num).as_bytes());
				} else {
					buf.extend_from_slice(b"argument-rest");
				}
				data.subc.push(buf);
			}
			// An argument the option requires in the next word is all that
			// may come here: no normal arguments.
			if a.typ == CAA_NORMAL
				&& opt
				&& optdef.is_some_and(|(s, o)| {
					matches!(sets[s].opts[o].typ, CAO_NEXT | CAO_ODIRECT | CAO_OEQUAL)
				}) {
				return;
			}
			if single {
				break;
			}
			if opt {
				if !lopt {
					break;
				}
				arg = ar.next(sets);
			} else if a.num >= 0 && ar.next(sets).is_none() && miss {
				arg = head_rest();
			} else {
				let onum = a.num;
				let rest = onum != a.min && onum == head.nth;
				arg = ar.next(sets);
				if let Some(n) = arg {
					if n.get(sets).num != onum + 1 {
						miss = true;
					}
				} else if rest || (oopt > 0 && !opt) {
					arg = head_rest();
					oopt = -1;
				}
			}
		}
		if !single && opt && (lopt || head.oopt != 0) {
			opt = false;
			arg = ca_get_arg(sets, head.d, head.nth);
			continue;
		}
		if !opt && oopt > 0 {
			oopt = -1;
			arg = head_rest();
			continue;
		}
		return;
	}
}

/// zsh `ca_nullist`: the arguments joined with NULs.
fn ca_nullist(l: &[BString]) -> BString {
	let mut out = BString::default();
	for (i, s) in l.iter().enumerate() {
		if i > 0 {
			out.push(0);
		}
		out.extend_from_slice(s);
	}
	out
}

/// zsh `ca_colonlist`: the arguments joined with colons, colons and
/// backslashes in them escaped.
fn ca_colonlist(l: &[BString]) -> BString {
	let mut out = BString::default();
	for (i, s) in l.iter().enumerate() {
		if i > 0 {
			out.push(b':');
		}
		for &c in s.iter() {
			if c == b':' || c == b'\\' {
				out.push(b'\\');
			}
			out.push(c);
		}
	}
	out
}

// ---- the builtin
// ------------------------------------------------------------------

/// `comparguments -i|-D|-O|-L|-s|-M|-a|-W|-n ARGS…` (zsh
/// `bin_comparguments`): `_arguments`' parser of its specifications and
/// of the command line.
pub fn comparguments(ctx: &mut Ctx<'_, '_>, _ops: &Ops, args: &[BString]) -> R {
	if !gate(ctx) {
		return done(1);
	}
	let Some(a0) = args.first() else {
		return warn(ctx, "not enough arguments");
	};
	if a0.len() != 2 || a0[0] != b'-' {
		return warn(ctx, format!("invalid argument: {}", lossy(a0)));
	}
	let o = a0[1];
	let rec: Option<Record> = load(ctx, MiscKey::ZshCompArguments)?;
	let rec = match rec {
		Some(r) if r.parsed => Some(r),
		r if o == b'i' || o == b'I' => r,
		_ => return warn(ctx, "no parsed state"),
	};
	let (min, max): (usize, Option<usize>) = match o {
		b'i' => (2, None),
		b'D' => (3, Some(3)),
		b'O' => (4, Some(4)),
		b'L' => (3, Some(4)),
		b's' | b'M' | b'n' => (1, Some(1)),
		b'a' => (0, Some(0)),
		b'W' => (3, Some(3)),
		_ => return warn(ctx, format!("invalid option: {}", lossy(a0))),
	};
	let n = args.len() - 1;
	if n < min {
		return warn(ctx, "not enough arguments");
	} else if max.is_some_and(|m| n > m) {
		return warn(ctx, "too many arguments");
	}
	let mut failed = false;
	if o == b'i' {
		return init(ctx, rec, &args[1..]);
	}
	let rec = rec.expect("parsed state");
	let states = &rec.states;
	let head = &states[0].s;
	let ret = match o {
		b'D' => {
			let doff = rec.doff;
			ignore_prefix(ctx, &mut failed, usize::try_from(doff).unwrap_or(0))?;
			let mut data = Data::default();
			let mut ret = 1;
			for st in states {
				if let Some(def) = st.s.def {
					ret = 0;
					let opt = def.get(&rec.sets).opt.is_some();
					ca_set_data(
						ctx,
						&rec,
						&mut data,
						opt,
						Some(def),
						st.s.curopt.map(|c| (st.s.d, c)),
						doff > 0,
					);
				}
			}
			if ret == 0 {
				setaparam(ctx, &mut failed, &args[1], data.descr)?;
				setaparam(ctx, &mut failed, &args[2], data.act)?;
				setaparam(ctx, &mut failed, &args[3], data.subc)?;
			}
			ret
		},
		b'O' => {
			let cc = compcurrent(ctx, &mut failed)?;
			let mut lists: [Vec<BString>; 4] = Default::default();
			let mut ret = 1;
			for st in states {
				let s = &st.s;
				let def = s.def.map(|r| r.get(&rec.sets));
				let want = s.actopts != 0
					&& (s.opt != 0
						|| (rec.doff != 0 && def.is_some())
						|| def.is_some_and(|a| {
							a.opt.is_some() && (a.typ == CAA_OPT || (a.typ >= CAA_RARGS && a.num < 0))
						}))
					&& def.is_none_or(|a| {
						a.typ < CAA_RARGS
							|| if a.typ == CAA_RARGS {
								s.curpos == s.argbeg + 1
							} else {
								cc == 1
							}
					});
				if !want {
					continue;
				}
				ret = 0;
				for p in &rec.sets[s.d].opts {
					if !p.active || p.not {
						continue;
					}
					let l = &mut lists[match p.typ {
						CAO_NEXT => 0,
						CAO_DIRECT => 1,
						CAO_ODIRECT => 2,
						_ => 3,
					}];
					let mut str = bslashcolon(&p.name);
					if let Some(d) = &p.descr {
						str.push(b':');
						str.extend_from_slice(d);
					}
					if !l.contains(&str) {
						l.push(str);
					}
				}
			}
			if ret == 0 {
				let [next, direct, odirect, equal] = lists;
				setaparam(ctx, &mut failed, &args[1], next)?;
				setaparam(ctx, &mut failed, &args[2], direct)?;
				setaparam(ctx, &mut failed, &args[3], odirect)?;
				setaparam(ctx, &mut failed, &args[4], equal)?;
				0
			} else if head.singles != 0 {
				2
			} else {
				1
			}
		},
		b'L' => {
			let mut data = Data::default();
			let mut ret = 1;
			for st in states {
				let d = st.s.d;
				if let Some((o, _)) = ca_get_opt(&rec.sets[d], &args[1], true)
					&& let Some(a) = first_oarg(&rec.sets, d, o)
				{
					ret = 0;
					ca_set_data(ctx, &rec, &mut data, true, Some(a), Some((d, o)), true);
				}
			}
			if ret == 0 {
				setaparam(ctx, &mut failed, &args[2], data.descr)?;
				setaparam(ctx, &mut failed, &args[3], data.act)?;
				if let Some(name) = args.get(4) {
					setaparam(ctx, &mut failed, name, data.subc)?;
				}
			}
			ret
		},
		b's' => {
			let hit = states
				.iter()
				.find(|st| rec.sets[st.s.d].single && st.s.singles != 0 && st.s.actopts != 0);
			match hit {
				Some(st) => {
					let v: &[u8] = match (st.s.ddef, st.s.dopt) {
						(Some(_), Some(o)) => match rec.sets[st.s.d].opts[o].typ {
							CAO_DIRECT => &b"direct"[..],
							CAO_OEQUAL | CAO_EQUAL => &b"equal"[..],
							_ => &b"next"[..],
						},
						_ => &b""[..],
					};
					setsparam(ctx, &mut failed, &args[1], v)?;
					0
				},
				None => 1,
			}
		},
		b'M' => {
			setsparam(ctx, &mut failed, &args[1], &rec.sets[head.d].matcher)?;
			0
		},
		b'a' => i32::from(
			!states
				.iter()
				.any(|st| !rec.sets[st.s.d].args.is_empty() || rec.sets[st.s.d].rest.is_some()),
		),
		b'W' => {
			let nul = args[3].first() != Some(&b'0');
			let line: Vec<BString> = states.iter().flat_map(|s| s.args.iter().cloned()).collect();
			setaparam(ctx, &mut failed, &args[1], line)?;
			let mut kv = Vec::new();
			for st in states {
				for (o, a) in rec.sets[st.s.d].opts.iter().zip(&st.oargs) {
					if let Some(a) = a {
						let mut k = o.gsname.clone().unwrap_or_default();
						k.extend_from_slice(&o.name);
						kv.push(k);
						kv.push(if nul { ca_nullist(a) } else { ca_colonlist(a) });
					}
				}
			}
			sethparam(ctx, &mut failed, &args[2], &kv)?;
			0
		},
		b'n' => {
			let v = head.optbeg + i64::from(!ctx.zsh_option(ZshOpt::Ksharrays)?);
			px(ctx, &mut failed, |ex| {
				params::setnparam(ex, &args[1], Number::Int(v), v.to_string().as_bytes(), 0).map(|_| ())
			})?;
			0
		},
		_ => unreachable!("sub-option checked above"),
	};
	fin(ret, failed)
}

/// `comparguments -i AUTODESC [-s] [-S] [-A PAT] [-M SPEC] [:] SPECS…`:
/// parse the specifications and the line.
fn init(ctx: &mut Ctx<'_, '_>, rec: Option<Record>, args: &[BString]) -> R {
	let mut failed = false;
	let words = compwords(ctx, &mut failed)?;
	let cc = compcurrent(ctx, &mut failed)?;
	if cc <= 1 || words.is_empty() {
		return fin(1, failed);
	}
	let sets = match parse_cadef(args) {
		Ok(s) => s,
		Err(msg) => {
			if let Some(mut r) = rec
				&& r.parsed
			{
				r.parsed = false;
				save(ctx, MiscKey::ZshCompArguments, Some(&r));
			}
			if let Some(m) = msg {
				ctx.usage(m);
			}
			return fin(1, failed);
		},
	};
	let multi = sets.len() > 1;
	let n = sets.len();
	let mut p = LineParser { sets, doff: 0, words: &words, cc, last: Castate::default() };
	let mut stack: Vec<Castate> = Vec::new();
	let mut ret = 0;
	for d in 0..n {
		let used = !p.parse_line(ctx, &mut failed, d, multi)?;
		let more = d + 1 < n;
		if used && more {
			stack.push(std::mem::take(&mut p.last));
		} else if !used && !more {
			match stack.pop() {
				Some(s) => p.last = s,
				None => ret = 1,
			}
		}
	}
	let mut states = Vec::with_capacity(stack.len() + 1);
	states.push(p.last);
	states.extend(stack.into_iter().rev());
	let rec = Record { parsed: true, doff: p.doff, sets: p.sets, states };
	save(ctx, MiscKey::ZshCompArguments, Some(&rec));
	fin(ret, failed)
}
