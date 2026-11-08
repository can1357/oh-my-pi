//! zsh/compctl: the old completion system (`compctl`, `compcall`), and the
//! completion `zsh -f` does when no completion widget function is set
//! (zsh's `compctl_make` hook: Tab completes command names, files,
//! parameters, `~user`, …).
//!
//! Ported from zsh 5.9 `Src/Zle/compctl.c` (MIT-style licence, Copyright
//! (c) 1992-1997 Paul Falstad and the zsh development group).
//!
//! zsh keeps the definitions in C statics (`compctltab`, `patcomps`, the
//! special `cc_compos`, `cc_default`, `cc_first` and the global matchers
//! `cmatcher`); here they are one store record ([`MiscKey::ZshCompctl`],
//! postcard) so subshells and restored shells see them. A definition is
//! a value tree ([`Cc`]); zsh's pointer identity of compctls (the `-x`
//! patterns, the `+` alternatives, the lists of compctls already used)
//! is the position of a compctl in the tree a generation run numbers
//! ([`generate`]).
//!
//! Generating matches calls shell functions (`-K`, `-y`), expands words
//! (`-s`, `-g`, `-W`, the word on the line) and reads directories, so it
//! runs as the `compcall` builtin: the `compctl_make` hook ([`make`]) asks
//! the editor to run `compcall` with the hook's data in the completion
//! state, and `compcall` re-runs from scratch after each probe or
//! function call like every builtin ([`generate`]).

mod generate;

use std::collections::BTreeMap;

use bstr::{BString, ByteSlice};
pub use generate::{CcRun, cleanup, compcall, compctlread, loaded, make};
use serde::{Deserialize, Serialize};

use super::{
	compmatch::parse_cmatcher,
	computil::{atoi, load, rembslash, save},
};
use crate::bash::{
	pattern::zsh::{haswilds, remnulargs, tokenize},
	store::{KeyBuf, MiscKey},
	syntax::zsh::tok::{self, at, metafy, unmetafy, untokenize},
	vm::{
		builtins::{
			Ctx, Need, R, done,
			zsh_args::{Ops, isset, zx},
			zsh_print::charset,
			zsh_quote::{Charset, QuoteOpts, quotedzputs, quotestring_backslash},
		},
		zsh::zpattern,
	},
	zshopt::ZshOpt,
};

// ---- the flags of a compctl (compctl.h)
// --------------------------------------

/// zsh `CC_*` (`compctl.mask`): what to complete.
pub(crate) mod cc {
	pub const FILES: u32 = 1 << 0;
	pub const COMMPATH: u32 = 1 << 1;
	pub const REMOVE: u32 = 1 << 2;
	pub const OPTIONS: u32 = 1 << 3;
	pub const VARS: u32 = 1 << 4;
	pub const BINDINGS: u32 = 1 << 5;
	pub const ARRAYS: u32 = 1 << 6;
	pub const INTVARS: u32 = 1 << 7;
	pub const SHFUNCS: u32 = 1 << 8;
	pub const PARAMS: u32 = 1 << 9;
	pub const ENVVARS: u32 = 1 << 10;
	pub const JOBS: u32 = 1 << 11;
	pub const RUNNING: u32 = 1 << 12;
	pub const STOPPED: u32 = 1 << 13;
	pub const BUILTINS: u32 = 1 << 14;
	pub const ALREG: u32 = 1 << 15;
	pub const ALGLOB: u32 = 1 << 16;
	pub const USERS: u32 = 1 << 17;
	pub const DISCMDS: u32 = 1 << 18;
	pub const EXCMDS: u32 = 1 << 19;
	pub const SCALARS: u32 = 1 << 20;
	pub const READONLYS: u32 = 1 << 21;
	pub const SPECIALS: u32 = 1 << 22;
	pub const DELETE: u32 = 1 << 23;
	pub const NAMED: u32 = 1 << 24;
	pub const QUOTEFLAG: u32 = 1 << 25;
	pub const EXTCMDS: u32 = 1 << 26;
	pub const RESWDS: u32 = 1 << 27;
	pub const DIRS: u32 = 1 << 28;
	pub const EXPANDEXPL: u32 = 1 << 30;
}

/// zsh `CC_*` of `compctl.mask2`.
pub(crate) mod cc2 {
	pub const NOSORT: u32 = 1 << 0;
	pub const XORCONT: u32 = 1 << 1;
	pub const CCCONT: u32 = 1 << 2;
	pub const PATCONT: u32 = 1 << 3;
	pub const DEFCONT: u32 = 1 << 4;
	pub const UNIQCON: u32 = 1 << 5;
	pub const UNIQALL: u32 = 1 << 6;
}

/// zsh `CCT_*`: the condition codes of `compctl -x`.
pub(crate) mod cct {
	pub const POS: u8 = 1;
	pub const CURSTR: u8 = 2;
	pub const CURPAT: u8 = 3;
	pub const WORDSTR: u8 = 4;
	pub const WORDPAT: u8 = 5;
	pub const CURSUF: u8 = 6;
	pub const CURPRE: u8 = 7;
	pub const CURSUB: u8 = 8;
	pub const CURSUBC: u8 = 9;
	pub const NUMWORDS: u8 = 10;
	pub const RANGESTR: u8 = 11;
	pub const RANGEPAT: u8 = 12;
	pub const QUOTE: u8 = 13;
}

// ---- definitions
// -------------------------------------------------------------

/// One `[…]` of a `compctl -x` condition (zsh `compcond.u`). Strings are
/// metafied, as zsh keeps them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) enum Arg {
	/// `p[a,b]`, `m[a,b]` (zsh `u.r`).
	Range(i32, i32),
	/// `s[str]`, `S[str]`, `q[str]` (zsh `u.s.s`).
	Str(BString),
	/// `r[a,b]`, `R[a,b]` (zsh `u.l`; `b` may be missing).
	Pair(BString, Option<BString>),
	/// `c[n,str]`, `C`, `w`, `W`, `n`, `N` (zsh `u.s.p`, `u.s.s`).
	Num(i32, BString),
}

/// One condition of `compctl -x` (zsh `struct compcond` without its
/// `and`/`or` links).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Cond {
	/// [`cct`] code.
	pub ty:   u8,
	/// Its `[…]` arguments, any of which may match.
	pub args: Vec<Arg>,
}

/// The `+` alternative of a compctl (zsh `compctl.xor`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) enum Xor {
	/// A bare `+`: the default completion (`&cc_default`).
	Default,
	/// The flags after `+`.
	Cc(Box<Cc>),
}

/// zsh `struct compctl`: one definition. Strings are metafied.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Cc {
	pub mask:    u32,
	pub mask2:   u32,
	/// `-k`.
	pub keyvar:  Option<BString>,
	/// `-g`.
	pub glob:    Option<BString>,
	/// `-s`.
	pub str:     Option<BString>,
	/// `-K`.
	pub func:    Option<BString>,
	/// `-X`/`-Y`.
	pub explain: Option<BString>,
	/// `-y`.
	pub ylist:   Option<BString>,
	/// `-P`.
	pub prefix:  Option<BString>,
	/// `-S`.
	pub suffix:  Option<BString>,
	/// `-l`.
	pub subcmd:  Option<BString>,
	/// `-h`.
	pub substr:  Option<BString>,
	/// `-W`.
	pub withd:   Option<BString>,
	/// `-H`'s pattern.
	pub hpat:    Option<BString>,
	/// `-H`'s number of events.
	pub hnum:    i32,
	/// `-J`/`-V`.
	pub gname:   Option<BString>,
	/// The `-x` patterns (zsh's `ext` list linked by `next`).
	pub ext:     Vec<Self>,
	/// This one's condition when it is an `-x` pattern: or'ed groups of
	/// and'ed conditions.
	pub cond:    Vec<Vec<Cond>>,
	/// `+`.
	pub xor:     Option<Xor>,
	/// `-M`'s specification.
	pub mstr:    Option<BString>,
}

impl Cc {
	/// A fresh compctl (zsh `zshcalloc`).
	const fn zero() -> Self {
		Self {
			mask:    0,
			mask2:   0,
			keyvar:  None,
			glob:    None,
			str:     None,
			func:    None,
			explain: None,
			ylist:   None,
			prefix:  None,
			suffix:  None,
			subcmd:  None,
			substr:  None,
			withd:   None,
			hpat:    None,
			hnum:    0,
			gname:   None,
			ext:     Vec::new(),
			cond:    Vec::new(),
			xor:     None,
			mstr:    None,
		}
	}

	/// zsh `cc_compos` as `setup_` makes it.
	const fn compos() -> Self {
		let mut c = Self::zero();
		c.mask = cc::COMMPATH;
		c
	}

	/// zsh `cc_default` as `setup_` makes it.
	const fn default_cc() -> Self {
		let mut c = Self::zero();
		c.mask = cc::FILES;
		c
	}

	/// zsh `cc_first` as `setup_` makes it.
	const fn first() -> Self {
		let mut c = Self::zero();
		c.mask2 = cc2::CCCONT;
		c
	}
}

/// All of zsh/compctl's definitions.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct State {
	/// zsh `compctltab`, by command name (metafied).
	pub tab:     BTreeMap<BString, Cc>,
	/// zsh `patcomps`: pattern (metafied, tokenized) and definition, the
	/// latest first.
	pub pats:    Vec<(BString, Cc)>,
	/// zsh `cc_compos` (`-C`).
	pub compos:  Cc,
	/// zsh `cc_default` (`-D`).
	pub default: Cc,
	/// zsh `cc_first` (`-T`).
	pub first:   Cc,
	/// zsh `cmatcher`: the global match specifications (`compctl -M`).
	pub gmatch:  Vec<BString>,
}

impl Default for State {
	fn default() -> Self {
		Self {
			tab:     BTreeMap::new(),
			pats:    Vec::new(),
			compos:  Cc::compos(),
			default: Cc::default_cc(),
			first:   Cc::first(),
			gmatch:  Vec::new(),
		}
	}
}

/// The definitions (zsh's state after `setup_` when none were made).
pub(crate) fn state(ctx: &mut Ctx<'_, '_>) -> Result<State, Need> {
	Ok(load(ctx, MiscKey::ZshCompctl)?.unwrap_or_default())
}

/// zsh/compctl's `finish_`: unloading the module drops the definitions;
/// the global matchers (a static `setup_` does not reset) stay.
pub fn finish(ctx: &mut Ctx<'_, '_>) -> Result<(), Need> {
	let st = state(ctx)?;
	if st.gmatch.is_empty() {
		ctx.store_record(KeyBuf::Misc(MiscKey::ZshCompctl), None);
	} else {
		let kept = State { gmatch: st.gmatch, ..State::default() };
		save(ctx, MiscKey::ZshCompctl, Some(&kept));
	}
	Ok(())
}

// ---- parsing (get_compctl, get_xcompctl, cc_assign)
// --------------------------

/// zsh `cclist` bits.
mod cl {
	/// `-L`.
	pub const LIST: u32 = 1 << 0;
	/// `-C`.
	pub const COMMAND: u32 = 1 << 1;
	/// `-D`.
	pub const DEFAULT: u32 = 1 << 2;
	/// `-T`.
	pub const FIRST: u32 = 1 << 3;
	/// `compctl + names`.
	pub const REMOVE: u32 = 1 << 4;
	/// `-L` and `-M`.
	pub const LISTMATCH: u32 = 1 << 5;
	/// Any of `-C`, `-D`, `-T`.
	pub const SPECIAL: u32 = COMMAND | DEFAULT | FIRST;
}

/// One argument word as zsh's `char **argv` sees it: the (metafied)
/// bytes and where `*argv` points in them; `compctl` walks the letters
/// of an option word by moving that pointer.
struct Word {
	buf: Vec<u8>,
	off: usize,
}

/// The parser of the `compctl` arguments (zsh's `argv` cursor and the
/// `cclist` static).
struct Parser {
	words:  Vec<Word>,
	cclist: u32,
}

/// The `argv_end` word (`"x"`): assigning it to `*argv` ends the word
/// being scanned.
const ARGV_END: &[u8] = b"x";

impl Parser {
	/// `argv[a]` exists (zsh `argv[a] != NULL`).
	const fn has(&self, a: usize) -> bool {
		a < self.words.len()
	}

	/// `argv[a][k]` (NUL past the end).
	fn ch(&self, a: usize, k: usize) -> u8 {
		self.words.get(a).map_or(0, |w| at(&w.buf, w.off + k))
	}

	/// `argv[a]` from its pointer on.
	fn rest(&self, a: usize) -> &[u8] {
		self
			.words
			.get(a)
			.map_or(&[][..], |w| tok::tail(&w.buf, w.off))
	}

	/// `argv[a] + k` as a string.
	fn from(&self, a: usize, k: usize) -> BString {
		self
			.words
			.get(a)
			.map_or_else(BString::default, |w| BString::from(tok::tail(&w.buf, w.off + k)))
	}

	/// `*argv = s`.
	fn set(&mut self, a: usize, s: &[u8]) {
		if let Some(w) = self.words.get_mut(a) {
			w.buf = s.to_vec();
			w.off = 0;
		}
	}

	/// `strcmp(argv[a], s) == 0`.
	fn is(&self, a: usize, s: &[u8]) -> bool {
		self.has(a) && self.rest(a) == s
	}
}

/// The flags parsed so far (zsh's `struct compctl cct`): what
/// [`cc_assign`] copies into a compctl.
#[derive(Clone)]
struct Cct {
	cc: Cc,
}

impl Cct {
	const fn new() -> Self {
		let mut cc = Cc::zero();
		cc.mask2 = cc2::CCCONT;
		Self { cc }
	}
}

/// Which special compctl `cc_assign` assigns to.
#[derive(Clone, Copy)]
enum Special {
	Compos,
	Default,
	First,
}

impl State {
	const fn special(&mut self, s: Special) -> &mut Cc {
		match s {
			Special::Compos => &mut self.compos,
			Special::Default => &mut self.default,
			Special::First => &mut self.first,
		}
	}
}

/// What the argument after a flag letter is: the rest of the word, or
/// the next word (zsh's repeated `if ((*argv)[1]) … else if (!argv[1])
/// … else …`). `None` after the warning `expected`.
fn flag_arg(
	ctx: &mut Ctx<'_, '_>,
	p: &mut Parser,
	a: &mut usize,
	expected: &str,
) -> Option<BString> {
	if p.ch(*a, 1) != 0 {
		let v = p.from(*a, 1);
		p.set(*a, ARGV_END);
		Some(v)
	} else if !p.has(*a + 1) {
		ctx.usage(format!("{expected} after -{}", char::from(p.ch(*a, 0))));
		None
	} else {
		*a += 1;
		let v = p.from(*a, 0);
		p.set(*a, ARGV_END);
		Some(v)
	}
}

/// zsh `get_compctl`: parse the flags at `*a` into `cc` (`first`: not in
/// an `-x` pattern). At the top level (`specials` given) the first
/// assignment goes to the special compctl `-C`/`-D`/`-T` select instead.
/// `Err(())` after a warning.
#[allow(clippy::too_many_lines, reason = "one function, as zsh's get_compctl")]
fn get_compctl<'s>(
	ctx: &mut Ctx<'_, '_>,
	p: &mut Parser,
	a: &mut usize,
	cc: &'s mut Cc,
	mut specials: Option<&'s mut State>,
	first: bool,
	mut isdef: bool,
) -> Result<(), ()> {
	let mut cc: &'s mut Cc = cc;
	let mut ready = 0;
	let mut hx = false;

	// `compctl + foo …`: remove the definitions.
	if first
		&& p.ch(*a, 0) == b'+'
		&& p.ch(*a, 1) == 0
		&& !(p.has(*a + 1) && p.ch(*a + 1, 0) == b'-' && p.ch(*a + 1, 1) != 0)
	{
		*a += 1;
		if p.has(*a) && p.ch(*a, 0) == b'-' {
			*a += 1;
		}
		p.cclist = cl::REMOVE;
		return Ok(());
	}

	let mut cct = Cct::new();
	while ready == 0 && p.has(*a) && p.ch(*a, 0) == b'-' && (p.ch(*a, 1) != 0 || !first) {
		if p.ch(*a, 1) == 0 {
			p.set(*a, b"-+");
		}
		while ready == 0 && {
			p.words[*a].off += 1;
			p.ch(*a, 0) != 0
		} {
			let c = p.ch(*a, 0);
			let m = &mut cct.cc;
			match c {
				b'f' => m.mask |= cc::FILES,
				b'c' => m.mask |= cc::COMMPATH,
				b'm' => m.mask |= cc::EXTCMDS,
				b'w' => m.mask |= cc::RESWDS,
				b'o' => m.mask |= cc::OPTIONS,
				b'v' => m.mask |= cc::VARS,
				b'b' => m.mask |= cc::BINDINGS,
				b'A' => m.mask |= cc::ARRAYS,
				b'I' => m.mask |= cc::INTVARS,
				b'F' => m.mask |= cc::SHFUNCS,
				b'p' => m.mask |= cc::PARAMS,
				b'E' => m.mask |= cc::ENVVARS,
				b'j' => m.mask |= cc::JOBS,
				b'r' => m.mask |= cc::RUNNING,
				b'z' => m.mask |= cc::STOPPED,
				b'B' => m.mask |= cc::BUILTINS,
				b'a' => m.mask |= cc::ALREG | cc::ALGLOB,
				b'R' => m.mask |= cc::ALREG,
				b'G' => m.mask |= cc::ALGLOB,
				b'u' => m.mask |= cc::USERS,
				b'd' => m.mask |= cc::DISCMDS,
				b'e' => m.mask |= cc::EXCMDS,
				b'N' => m.mask |= cc::SCALARS,
				b'O' => m.mask |= cc::READONLYS,
				b'Z' => m.mask |= cc::SPECIALS,
				b'q' => m.mask |= cc::REMOVE,
				b'U' => m.mask |= cc::DELETE,
				b'n' => m.mask |= cc::NAMED,
				b'Q' => m.mask |= cc::QUOTEFLAG,
				b'/' => m.mask |= cc::DIRS,
				b't' => {
					let spec = if p.ch(*a, 1) != 0 {
						let v = p.from(*a, 1);
						p.set(*a, ARGV_END);
						v
					} else if !p.has(*a + 1) {
						ctx.usage(format!("retry specification expected after -{}", char::from(c)));
						return Err(());
					} else {
						*a += 1;
						let v = p.from(*a, 0);
						p.set(*a, ARGV_END);
						v
					};
					cct.cc.mask2 = match at(&spec, 0) {
						b'+' => cc2::XORCONT,
						b'n' => 0,
						b'-' => cc2::PATCONT,
						b'x' => cc2::DEFCONT,
						other => {
							ctx.usage(format!(
								"invalid retry specification character `{}'",
								show(&[other])
							));
							return Err(());
						},
					};
					if spec.len() > 1 {
						ctx.usage(format!(
							"too many retry specification characters: `{}'",
							show(&spec[1..])
						));
						return Err(());
					}
				},
				b'k' => cct.cc.keyvar = Some(flag_arg(ctx, p, a, "variable name expected").ok_or(())?),
				b'K' => cct.cc.func = Some(flag_arg(ctx, p, a, "function name expected").ok_or(())?),
				b'Y' | b'X' => {
					if c == b'Y' {
						cct.cc.mask |= cc::EXPANDEXPL;
					} else {
						cct.cc.mask &= !cc::EXPANDEXPL;
					}
					cct.cc.explain = Some(flag_arg(ctx, p, a, "string expected").ok_or(())?);
				},
				// zsh warns and goes on without a list.
				b'y' => {
					if let Some(v) = flag_arg(ctx, p, a, "function/variable expected") {
						cct.cc.ylist = Some(v);
					}
				},
				b'P' => cct.cc.prefix = Some(flag_arg(ctx, p, a, "string expected").ok_or(())?),
				b'S' => cct.cc.suffix = Some(flag_arg(ctx, p, a, "string expected").ok_or(())?),
				b'g' => cct.cc.glob = Some(flag_arg(ctx, p, a, "glob pattern expected").ok_or(())?),
				b's' => cct.cc.str = Some(flag_arg(ctx, p, a, "command string expected").ok_or(())?),
				b'l' => cct.cc.subcmd = Some(flag_arg(ctx, p, a, "command name expected").ok_or(())?),
				b'h' => cct.cc.substr = Some(flag_arg(ctx, p, a, "command name expected").ok_or(())?),
				b'W' => cct.cc.withd = Some(flag_arg(ctx, p, a, "path expected").ok_or(())?),
				b'J' => cct.cc.gname = Some(flag_arg(ctx, p, a, "group name expected").ok_or(())?),
				b'V' => {
					cct.cc.gname = Some(flag_arg(ctx, p, a, "group name expected").ok_or(())?);
					cct.cc.mask2 |= cc2::NOSORT;
				},
				b'1' => {
					cct.cc.mask2 |= cc2::UNIQALL;
					cct.cc.mask2 &= !cc2::UNIQCON;
				},
				b'2' => {
					cct.cc.mask2 |= cc2::UNIQCON;
					cct.cc.mask2 &= !cc2::UNIQALL;
				},
				b'M' => {
					if p.cclist & cl::LIST != 0 {
						p.cclist |= cl::LISTMATCH;
					} else {
						let spec = flag_arg(ctx, p, a, "matching specification expected").ok_or(())?;
						if !valid_cmatcher(ctx, &spec) {
							return Err(());
						}
						cct.cc.mstr = Some(spec);
					}
				},
				b'H' => {
					if p.ch(*a, 1) != 0 {
						cct.cc.hnum = atoi(&p.from(*a, 1)) as i32;
					} else if p.has(*a + 1) {
						*a += 1;
						cct.cc.hnum = atoi(&p.from(*a, 0)) as i32;
					} else {
						ctx.usage(format!("number expected after -{}", char::from(c)));
						return Err(());
					}
					if !p.has(*a + 1) {
						ctx.usage(format!("missing pattern after -{}", char::from(p.ch(*a, 0))));
						return Err(());
					}
					*a += 1;
					let mut hpat = p.from(*a, 0);
					if cct.cc.hnum < 1 {
						cct.cc.hnum = 0;
					}
					if hpat.as_slice() == b"*" {
						hpat = BString::default();
					}
					cct.cc.hpat = Some(hpat);
					p.set(*a, ARGV_END);
				},
				b'C' | b'D' | b'T' => {
					if first && !hx {
						p.cclist |= match c {
							b'C' => cl::COMMAND,
							b'D' => {
								isdef = true;
								cl::DEFAULT
							},
							_ => cl::FIRST,
						};
					} else {
						ctx.usage(match c {
							b'C' => "misplaced command completion (-C) flag",
							b'D' => "misplaced default completion (-D) flag",
							_ => "misplaced first completion (-T) flag",
						});
						return Err(());
					}
				},
				b'L' => {
					if !first || hx {
						ctx.usage("illegal use of -L flag");
						return Err(());
					}
					p.cclist |= cl::LIST;
				},
				b'x' => {
					if !p.has(*a + 1) {
						ctx.usage(format!("condition expected after -{}", char::from(c)));
						return Err(());
					}
					if first {
						*a += 1;
						if get_xcompctl(ctx, p, a, &mut cct, isdef).is_err() {
							return Err(());
						}
						ready = 2;
					} else {
						ctx.usage("recursive extended completion not allowed");
						return Err(());
					}
				},
				_ => {
					if !first && (c == b'-' || c == b'+') && p.ch(*a, 1) == 0 {
						p.words[*a].off -= 1;
						*a -= 1;
						ready = 1;
					} else {
						ctx.usage(format!("bad option: -{}", show(&[c])));
						return Err(());
					}
				},
			}
		}

		*a += 1;
		if p.has(*a) && (ready == 0 || ready == 2) && p.ch(*a, 0) == b'+' && p.ch(*a, 1) == 0 {
			// An alternative (`+`): assign what was parsed first.
			cc = cc_assign(ctx, p, cc, &mut specials, &cct, first && !hx)?;
			hx = true;
			ready = 0;
			*a += 1;
			if !p.has(*a)
				|| p.ch(*a, 0) != b'-'
				|| p.ch(*a, 1) == 0
				|| (p.ch(*a, 1) == b'-' && p.ch(*a, 2) == 0)
			{
				// A bare `+`: the default completion.
				if isdef {
					ctx.usage("recursive xor'd default completions not allowed");
				} else {
					cc.xor = Some(Xor::Default);
				}
			} else {
				cc.xor = Some(Xor::Cc(Box::new(Cc::zero())));
				let prev = cc;
				cc = match &mut prev.xor {
					Some(Xor::Cc(next)) => next,
					_ => unreachable!("just set"),
				};
				cct = Cct::new();
			}
		}
	}
	if ready == 0 && p.has(*a) && p.ch(*a, 0) == b'-' {
		*a += 1;
	}
	if cct.cc.mask & (cc::EXCMDS | cc::DISCMDS) == 0 {
		cct.cc.mask |= cc::EXCMDS;
	}
	cc_assign(ctx, p, cc, &mut specials, &cct, first && !hx)?;
	Ok(())
}

/// zsh `get_xcompctl`: the `-x pattern flags - pattern flags … --` part,
/// at `*a`, into `cct.ext`. Ends at the word before the command names.
fn get_xcompctl(
	ctx: &mut Ctx<'_, '_>,
	p: &mut Parser,
	a: &mut usize,
	cct: &mut Cct,
	isdef: bool,
) -> Result<(), ()> {
	let mut ready = false;
	let mut ext: Vec<Cc> = Vec::new();
	let result = loop {
		if ready {
			break Ok(());
		}
		let Ok(cond) = parse_cond(ctx, p.rest(*a).to_vec()) else {
			break Err(());
		};
		let mut next = Cc::zero();
		next.cond = cond;
		*a += 1;
		let r = get_compctl(ctx, p, a, &mut next, None, false, isdef);
		ext.push(next);
		if r.is_err() {
			break Err(());
		}
		if !p.has(*a) && p.cclist & cl::SPECIAL != 0 {
			// The end of a `-C`, `-D` or `-T` definition.
			ready = true;
			continue;
		}
		if !p.has(*a)
			|| p.ch(*a, 0) != b'-'
			|| ((p.ch(*a, 1) == 0 || p.ch(*a, 1) == b'+') && !p.has(*a + 1))
		{
			ctx.usage("missing command names");
			break Err(());
		}
		if p.is(*a, b"--") {
			ready = true;
		} else if p.is(*a, b"-+") && p.is(*a + 1, b"--") {
			ready = true;
			*a += 1;
		}
		*a += 1;
	};
	// zsh keeps what it parsed in `cct->ext` until the caller frees it
	// on an error.
	cct.cc.ext = ext;
	result?;
	*a -= 1;
	Ok(())
}

/// The conditions of one `-x` pattern word (zsh's loop in
/// `get_xcompctl`): or'ed groups of and'ed conditions.
#[allow(clippy::too_many_lines, reason = "one loop, as zsh's")]
fn parse_cond(ctx: &mut Ctx<'_, '_>, word: Vec<u8>) -> Result<Vec<Vec<Cond>>, ()> {
	const CLOSE: u8 = 0o200;
	const COMMA: u8 = 0o201;
	// A C string: work on a NUL-terminated copy.
	let mut s = word;
	s.push(0);
	let len = s.len();
	let g = |s: &[u8], i: usize| if i < len { s[i] } else { 0 };
	let mut ors: Vec<Vec<Cond>> = vec![vec![Cond::default()]];
	let mut t = 0;
	let err = |ctx: &mut Ctx<'_, '_>| {
		ctx.usage("error in condition");
		Err(())
	};
	// The string from `tt` to the NUL written at `t`.
	let cut = |s: &[u8], tt: usize, t: usize| BString::from(&s[tt..t]);
	while g(&s, t) != 0 {
		while g(&s, t) == b' ' {
			t += 1;
		}
		let ty = match g(&s, t) {
			b'q' => cct::QUOTE,
			b's' => cct::CURSUF,
			b'S' => cct::CURPRE,
			b'p' => cct::POS,
			b'c' => cct::CURSTR,
			b'C' => cct::CURPAT,
			b'w' => cct::WORDSTR,
			b'W' => cct::WORDPAT,
			b'n' => cct::CURSUB,
			b'N' => cct::CURSUBC,
			b'm' => cct::NUMWORDS,
			b'r' => cct::RANGESTR,
			b'R' => cct::RANGEPAT,
			other => {
				let code = if other == 0 { Vec::new() } else { vec![other] };
				ctx.usage(format!("unknown condition code: {}", show(&code)));
				return Err(());
			},
		};
		if g(&s, t + 1) != b'[' {
			ctx.usage(format!("expected condition after condition code: {}", show(&[g(&s, t)])));
			return Err(());
		}
		t += 1;
		// Count the `[…]`s, marking the active `]`s and `,`s.
		let mut l = 0;
		let mut tt = t;
		while g(&s, tt) == b'[' {
			l = 1;
			tt += 1;
			while g(&s, tt) != 0 && l != 0 {
				let c = g(&s, tt);
				if c == b'\\' && g(&s, tt + 1) != 0 {
					tt += 1;
				} else if c == b'[' {
					l += 1;
				} else if c == b']' {
					l -= 1;
				} else if l == 1 && c == b',' {
					s[tt] = COMMA;
				}
				tt += 1;
			}
			if s[tt - 1] == b']' {
				s[tt - 1] = CLOSE;
			}
		}
		if l != 0 {
			ctx.usage("error after condition code: [");
			return Err(());
		}
		let mut cond = Cond { ty, args: Vec::new() };
		while g(&s, t) == b'[' {
			t += 1;
			while g(&s, t) == b' ' {
				t += 1;
			}
			let mut tt = t;
			let arg = match ty {
				cct::POS | cct::NUMWORDS => {
					while !matches!(g(&s, t), 0 | COMMA | CLOSE) {
						t += 1;
					}
					let sav = g(&s, t);
					if sav == 0 {
						return err(ctx);
					}
					s[t] = 0;
					let a = atoi(&s[tt..t]) as i32;
					let b = if sav == CLOSE {
						a
					} else {
						t += 1;
						tt = t;
						while !matches!(g(&s, t), 0 | CLOSE) {
							t += 1;
						}
						if g(&s, t) == 0 {
							return err(ctx);
						}
						s[t] = 0;
						atoi(&s[tt..t]) as i32
					};
					Arg::Range(a, b)
				},
				cct::CURSUF | cct::CURPRE | cct::QUOTE => {
					while !matches!(g(&s, t), 0 | CLOSE) {
						if s[t] == COMMA {
							s[t] = b',';
						}
						t += 1;
					}
					if g(&s, t) == 0 {
						return err(ctx);
					}
					s[t] = 0;
					Arg::Str(cut(&s, tt, t))
				},
				cct::RANGESTR | cct::RANGEPAT => {
					while !matches!(g(&s, t), 0 | COMMA | CLOSE) {
						t += 1;
					}
					if g(&s, t) == 0 {
						return err(ctx);
					}
					let hc = s[t] == COMMA;
					s[t] = 0;
					let a = cut(&s, tt, t);
					let b = if hc {
						t += 1;
						tt = t;
						while !matches!(g(&s, t), 0 | CLOSE) {
							if s[t] == COMMA {
								s[t] = b',';
							}
							t += 1;
						}
						if g(&s, t) == 0 {
							return err(ctx);
						}
						s[t] = 0;
						Some(cut(&s, tt, t))
					} else {
						None
					};
					Arg::Pair(a, b)
				},
				_ => {
					while !matches!(g(&s, t), 0 | CLOSE | COMMA) {
						t += 1;
					}
					if matches!(g(&s, t), 0 | CLOSE) {
						return err(ctx);
					}
					s[t] = 0;
					let n = atoi(&s[tt..t]) as i32;
					t += 1;
					tt = t;
					while !matches!(g(&s, t), 0 | CLOSE) {
						if s[t] == COMMA {
							s[t] = b',';
						}
						t += 1;
					}
					if g(&s, t) == 0 {
						return err(ctx);
					}
					s[t] = 0;
					Arg::Num(n, cut(&s, tt, t))
				},
			};
			cond.args.push(arg);
			t += 1;
		}
		if let Some(last) = ors.last_mut().and_then(|g| g.last_mut()) {
			*last = cond;
		}
		while g(&s, t) == b' ' {
			t += 1;
		}
		if g(&s, t) == b',' {
			// Another condition to or.
			ors.push(vec![Cond::default()]);
			t += 1;
		} else if g(&s, t) != 0 {
			// Another condition to and.
			if let Some(group) = ors.last_mut() {
				group.push(Cond::default());
			}
		}
	}
	Ok(ors)
}

/// zsh `cc_assign`: copy the flags in `cct` into `cc`, or, when `reass`
/// and `-C`/`-D`/`-T` was given (not listing), into that special
/// compctl, emptied first (zsh `cc_reassign`). The compctl assigned.
fn cc_assign<'s>(
	ctx: &mut Ctx<'_, '_>,
	p: &Parser,
	cc: &'s mut Cc,
	specials: &mut Option<&'s mut State>,
	cct: &Cct,
	reass: bool,
) -> Result<&'s mut Cc, ()> {
	let mut cc = cc;
	if reass && p.cclist & cl::LIST == 0 {
		let sp = p.cclist & cl::SPECIAL;
		if sp.count_ones() > 1 {
			ctx.usage("can't set -D, -T, and -C simultaneously");
			return Err(());
		}
		let which = if sp & cl::COMMAND != 0 {
			Some(Special::Compos)
		} else if sp & cl::DEFAULT != 0 {
			Some(Special::Default)
		} else if sp & cl::FIRST != 0 {
			Some(Special::First)
		} else {
			None
		};
		if let Some(which) = which
			&& let Some(st) = specials.take()
		{
			cc = st.special(which);
			cc.ext.clear();
			cc.xor = None;
		}
	}
	let n = &cct.cc;
	cc.mask = n.mask;
	cc.mask2 = n.mask2;
	cc.keyvar.clone_from(&n.keyvar);
	cc.glob.clone_from(&n.glob);
	cc.str.clone_from(&n.str);
	cc.func.clone_from(&n.func);
	cc.explain.clone_from(&n.explain);
	cc.ylist.clone_from(&n.ylist);
	cc.prefix.clone_from(&n.prefix);
	cc.suffix.clone_from(&n.suffix);
	cc.subcmd.clone_from(&n.subcmd);
	cc.substr.clone_from(&n.substr);
	cc.withd.clone_from(&n.withd);
	cc.gname.clone_from(&n.gname);
	cc.hpat.clone_from(&n.hpat);
	cc.hnum = n.hnum;
	cc.mstr.clone_from(&n.mstr);
	cc.ext.clone_from(&n.ext);
	Ok(cc)
}

/// zsh `parse_cmatcher(name, s) != pcm_err`, its warnings reported.
fn valid_cmatcher(ctx: &mut Ctx<'_, '_>, s: &[u8]) -> bool {
	let mut msgs: Vec<Vec<u8>> = Vec::new();
	let ok = parse_cmatcher(Some(ctx.name.as_bytes()), s, &mut |m| msgs.push(m.to_vec())).is_ok();
	for m in msgs {
		ctx.usage(show(&m));
	}
	ok
}

/// A message argument: raw bytes for the terminal.
fn show(s: &[u8]) -> String {
	unmetafy(s).to_str_lossy().into_owned()
}

/// zsh `compctl_name_pat`: a command name argument is a pattern
/// (`Ok(tokenized)`) when it has wildcards, else the name with
/// backslashes removed (`Err`). Both metafied.
fn name_pat(ctx: &mut Ctx<'_, '_>, name: &[u8]) -> Result<Result<BString, BString>, Need> {
	let mut s = name.to_vec();
	tokenize(&mut s);
	remnulargs(&mut s);
	let opts = match zx(ctx, zpattern::opts)? {
		Ok(o) => o,
		Err(d) => {
			ctx.diag(d);
			return Ok(Err(rembslash(name)));
		},
	};
	if haswilds(&mut s, &opts) {
		Ok(Ok(s.into()))
	} else {
		Ok(Err(rembslash(name)))
	}
}

// ---- printing --------------------------------------------------------------

/// What printing needs from the shell: quoting options.
struct Out {
	rc:       bool,
	cs:       Charset,
	qo:       QuoteOpts,
	/// `-L`: print `compctl` commands.
	list:     bool,
	/// zsh `showmask`: print only compctls with one of these flags.
	showmask: u32,
}

impl Out {
	fn new(ctx: &mut Ctx<'_, '_>, list: bool, showmask: u32) -> Result<Self, Need> {
		let cs = charset(ctx)?;
		Ok(Self {
			rc: isset(ctx, ZshOpt::Rcquotes)?,
			cs,
			qo: QuoteOpts {
				extended_glob: isset(ctx, ZshOpt::Extendedglob)?,
				magic_equal_subst: isset(ctx, ZshOpt::Magicequalsubst)?,
				cs,
			},
			list,
			showmask,
		})
	}

	/// zsh `quotedzputs` of a metafied string.
	fn q(&self, out: &mut Vec<u8>, s: &[u8]) {
		out.extend_from_slice(&quotedzputs(&unmetafy(s), self.rc, self.cs));
	}

	/// zsh `printif`.
	fn printif(&self, out: &mut Vec<u8>, s: Option<&BString>, c: u8) {
		if let Some(s) = s {
			out.extend_from_slice(b" -");
			out.push(c);
			out.push(b' ');
			self.q(out, s);
		}
	}

	/// zsh `printqt`.
	fn printqt(&self, out: &mut Vec<u8>, s: &[u8]) {
		for &c in &unmetafy(s) {
			if c == b'\'' {
				out.extend_from_slice(if self.rc { b"''" } else { b"'\\''" });
			} else {
				out.push(c);
			}
		}
	}

	/// The name of a command (`quotestring(…, QT_BACKSLASH)` then
	/// `quotedzputs`), or a pattern's.
	fn name(&self, out: &mut Vec<u8>, s: &[u8], ispat: bool) {
		let mut p = s.to_vec();
		untokenize(&mut p);
		if ispat {
			self.q(out, &p);
		} else {
			let raw = unmetafy(&p);
			let quoted = quotestring_backslash(&raw, false, self.qo);
			out.extend_from_slice(&quotedzputs(&quoted, self.rc, self.cs));
		}
	}
}

/// Which compctl is printed: the special ones show their flag.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Which {
	Plain,
	Compos,
	Default,
	First,
}

/// zsh `printcompctl(s, cc, 0, ispat)`.
fn printcompctl(
	o: &mut Out,
	out: &mut Vec<u8>,
	s: Option<&[u8]>,
	c: &Cc,
	ispat: bool,
	which: Which,
) {
	const CSS: &[u8] = b"fcqovbAIFpEjrzBRGudeNOZUnQmw/";
	const MSS: &[u8] = b" pcCwWsSnNmrRq";
	let mut flags = c.mask;
	let flags2 = c.mask2;
	if flags & cc::EXCMDS != 0 && flags & cc::DISCMDS == 0 {
		flags &= !cc::EXCMDS;
	}
	if o.showmask != 0 && flags & o.showmask == 0 {
		return;
	}
	let oldshowmask = o.showmask;
	o.showmask = 0;

	if let Some(s) = s {
		if o.list {
			out.extend_from_slice(b"compctl");
			match which {
				Which::Compos => out.extend_from_slice(b" -C"),
				Which::Default => out.extend_from_slice(b" -D"),
				Which::First => out.extend_from_slice(b" -T"),
				Which::Plain => {},
			}
		} else {
			o.name(out, s, ispat);
		}
	}

	let mut t: u32 = 0x7fff_ffff;
	if flags & t != 0 || flags2 & (cc2::UNIQALL | cc2::UNIQCON) != 0 {
		out.extend_from_slice(b" -");
		if flags & (cc::ALREG | cc::ALGLOB) == cc::ALREG | cc::ALGLOB {
			out.push(b'a');
			flags &= !(cc::ALREG | cc::ALGLOB);
		}
		for &ch in CSS {
			if flags & t & 1 != 0 {
				out.push(ch);
			}
			flags >>= 1;
			t >>= 1;
		}
		if flags2 & cc2::UNIQALL != 0 {
			out.push(b'1');
		} else if flags2 & cc2::UNIQCON != 0 {
			out.push(b'2');
		}
	}
	if flags2 & (cc2::XORCONT | cc2::PATCONT | cc2::DEFCONT) != 0 {
		out.extend_from_slice(b" -t");
		if flags2 & cc2::XORCONT != 0 {
			out.push(b'+');
		}
		if flags2 & cc2::PATCONT != 0 {
			out.push(b'-');
		}
		if flags2 & cc2::DEFCONT != 0 {
			out.push(b'x');
		}
	} else if flags2 & cc2::CCCONT == 0 {
		out.extend_from_slice(b" -tn");
	}
	o.printif(out, c.mstr.as_ref(), b'M');
	o.printif(
		out,
		c.gname.as_ref(),
		if flags2 & cc2::NOSORT != 0 {
			b'V'
		} else {
			b'J'
		},
	);
	o.printif(out, c.keyvar.as_ref(), b'k');
	o.printif(out, c.func.as_ref(), b'K');
	o.printif(
		out,
		c.explain.as_ref(),
		if c.mask & cc::EXPANDEXPL != 0 {
			b'Y'
		} else {
			b'X'
		},
	);
	o.printif(out, c.ylist.as_ref(), b'y');
	o.printif(out, c.prefix.as_ref(), b'P');
	o.printif(out, c.suffix.as_ref(), b'S');
	o.printif(out, c.glob.as_ref(), b'g');
	o.printif(out, c.str.as_ref(), b's');
	o.printif(out, c.subcmd.as_ref(), b'l');
	o.printif(out, c.substr.as_ref(), b'h');
	o.printif(out, c.withd.as_ref(), b'W');
	if let Some(h) = &c.hpat {
		out.extend_from_slice(format!(" -H {} ", c.hnum).as_bytes());
		o.q(out, h);
	}

	if !c.ext.is_empty() {
		out.extend_from_slice(b" -x");
		for (k, c2) in c.ext.iter().enumerate() {
			out.extend_from_slice(b" '");
			for (oi, ands) in c2.cond.iter().enumerate() {
				if oi > 0 {
					out.extend_from_slice(b" , ");
				}
				for (ai, cond) in ands.iter().enumerate() {
					if ai > 0 {
						out.push(b' ');
					}
					out.push(MSS.get(usize::from(cond.ty)).copied().unwrap_or(b' '));
					for arg in &cond.args {
						out.push(b'[');
						match arg {
							Arg::Range(a, b) => out.extend_from_slice(format!("{a},{b}").as_bytes()),
							Arg::Str(s) => o.printqt(out, s),
							// zsh prints a missing second string through a
							// NULL pointer (and crashes); here it is empty.
							Arg::Pair(a, b) => {
								o.printqt(out, a);
								out.push(b',');
								o.printqt(out, b.as_deref().map_or(&[][..], |b| b.as_slice()));
							},
							Arg::Num(n, s) => {
								out.extend_from_slice(format!("{n},").as_bytes());
								o.printqt(out, s);
							},
						}
						out.push(b']');
					}
				}
			}
			out.push(b'\'');
			let mut flat = c2.clone();
			flat.cond.clear();
			printcompctl(o, out, None, &flat, false, Which::Plain);
			if k + 1 < c.ext.len() {
				out.extend_from_slice(b" -");
			}
		}
		if o.list {
			out.extend_from_slice(b" --");
		}
	}
	if let Some(x) = &c.xor {
		out.extend_from_slice(b" +");
		if let Xor::Cc(x) = x {
			printcompctl(o, out, None, x, false, Which::Plain);
		}
	}
	if let Some(s) = s {
		if o.list && which == Which::Plain {
			if matches!(at(s, 0), b'-' | b'+') {
				out.extend_from_slice(b" -");
			}
			out.push(b' ');
			o.name(out, s, ispat);
		}
		out.push(b'\n');
	}
	o.showmask = oldshowmask;
}

/// zsh `print_gmatcher(ac)`.
fn print_gmatcher(out: &mut Vec<u8>, st: &State, ac: bool) {
	if st.gmatch.is_empty() {
		return;
	}
	out.extend_from_slice(if ac { b"compctl -M" } else { b"MATCH" });
	for s in &st.gmatch {
		out.extend_from_slice(b" '");
		out.extend_from_slice(&unmetafy(s));
		out.push(b'\'');
	}
	out.push(b'\n');
}

/// Print `c` and queue it for stdout.
fn emit(ctx: &mut Ctx<'_, '_>, o: &mut Out, s: Option<&[u8]>, c: &Cc, ispat: bool, which: Which) {
	let mut out = Vec::new();
	printcompctl(o, &mut out, s, c, ispat, which);
	ctx.out(&out);
}

// ---- the builtin -----------------------------------------------------------

/// zsh `bin_compctl`: define, remove and list compctls, or set the
/// global match specifications (`compctl -M spec…`).
pub fn compctl(ctx: &mut Ctx<'_, '_>, _ops: &Ops, args: &[BString]) -> R {
	let mut st = state(ctx)?;
	let before = st.clone();
	let r = bin_compctl(ctx, &mut st, args);
	if st != before {
		save(ctx, MiscKey::ZshCompctl, Some(&st));
	}
	r
}

#[allow(clippy::too_many_lines, reason = "one function, as zsh's bin_compctl")]
fn bin_compctl(ctx: &mut Ctx<'_, '_>, st: &mut State, args: &[BString]) -> R {
	let mut p = Parser {
		words:  args
			.iter()
			.map(|a| Word { buf: metafy(a), off: 0 })
			.collect(),
		cclist: 0,
	};
	let mut showmask = 0;
	let mut a = 0;
	let mut cc = Cc::zero();
	if p.has(0) {
		// The global matchers: `-M` and specs only.
		if p.is(0, b"-M") && (1..p.words.len()).all(|i| p.ch(i, 0) != b'-') {
			let specs: Vec<BString> = (1..p.words.len()).map(|i| p.from(i, 0)).collect();
			for s in &specs {
				if !valid_cmatcher(ctx, s) {
					return done(1);
				}
			}
			st.gmatch = specs;
			// zsh's `set_gmatcher` returns 1 either way.
			return done(1);
		}
		if get_compctl(ctx, &mut p, &mut a, &mut cc, Some(&mut *st), true, false).is_err() {
			return done(1);
		}
		showmask = cc.mask;
		if showmask & cc::EXCMDS != 0 && showmask & cc::DISCMDS == 0 {
			showmask &= !cc::EXCMDS;
		}
	}
	let rest: Vec<BString> = (a..p.words.len()).map(|i| p.from(i, 0)).collect();
	let list = p.cclist & cl::LIST != 0;

	// No command names and no -C/-D/-T: print everything (or only the
	// compctls with the flags given).
	if rest.is_empty() && p.cclist & (cl::SPECIAL | cl::LISTMATCH) == 0 {
		let mut o = Out::new(ctx, list, showmask)?;
		for (pat, c) in &st.pats {
			emit(ctx, &mut o, Some(pat.as_slice()), c, true, Which::Plain);
		}
		for (name, c) in &st.tab {
			emit(ctx, &mut o, Some(name.as_slice()), c, false, Which::Plain);
		}
		let n = |s: &'static [u8]| if list { &b""[..] } else { s };
		emit(ctx, &mut o, Some(n(b"COMMAND")), &st.compos, false, Which::Compos);
		emit(ctx, &mut o, Some(n(b"DEFAULT")), &st.default, false, Which::Default);
		emit(ctx, &mut o, Some(n(b"FIRST")), &st.first, false, Which::First);
		let mut out = Vec::new();
		print_gmatcher(&mut out, st, list);
		ctx.out(&out);
		return done(0);
	}

	// Listing the commands given (or the special compctls).
	if list {
		let mut o = Out::new(ctx, true, 0)?;
		let mut ret = 0;
		for arg in &rest {
			let found = match name_pat(ctx, arg)? {
				Ok(pat) => st
					.pats
					.iter()
					.find(|(p, _)| *p == pat)
					.map(|(p, c)| (p.clone(), c.clone(), true)),
				Err(name) => st.tab.get(&name).map(|c| (name.clone(), c.clone(), false)),
			};
			if let Some((n, c, ispat)) = found {
				emit(ctx, &mut o, Some(n.as_slice()), &c, ispat, Which::Plain);
			} else {
				let shown = match name_pat(ctx, arg)? {
					Ok(pat) => {
						let mut v = pat.to_vec();
						untokenize(&mut v);
						BString::from(v)
					},
					Err(name) => name,
				};
				ctx.usage(format!("no compctl defined for {}", show(&shown)));
				ret = 1;
			}
		}
		if p.cclist & cl::COMMAND != 0 {
			emit(ctx, &mut o, Some(&b""[..]), &st.compos, false, Which::Compos);
		}
		if p.cclist & cl::DEFAULT != 0 {
			emit(ctx, &mut o, Some(&b""[..]), &st.default, false, Which::Default);
		}
		if p.cclist & cl::FIRST != 0 {
			emit(ctx, &mut o, Some(&b""[..]), &st.first, false, Which::First);
		}
		if p.cclist & cl::LISTMATCH != 0 {
			let mut out = Vec::new();
			print_gmatcher(&mut out, st, true);
			ctx.out(&out);
		}
		return done(ret);
	}

	// Assign the compctl to the commands given.
	if !rest.is_empty() {
		if p.cclist & cl::SPECIAL != 0 {
			ctx.usage("extraneous commands ignored");
		} else {
			process_cc(ctx, st, &rest, &cc, p.cclist & cl::REMOVE != 0)?;
		}
	}
	done(0)
}

/// zsh `compctl_process_cc`: define `cc` for the commands and patterns
/// `names`, or remove theirs (`compctl + names`).
fn process_cc(
	ctx: &mut Ctx<'_, '_>,
	st: &mut State,
	names: &[BString],
	c: &Cc,
	remove: bool,
) -> Result<(), Need> {
	for n in names {
		match name_pat(ctx, n)? {
			Ok(pat) => {
				st.pats.retain(|(p, _)| *p != pat);
				if !remove {
					st.pats.insert(0, (pat, c.clone()));
				}
			},
			Err(name) => {
				if remove {
					st.tab.remove(&name);
				} else {
					st.tab.insert(name, c.clone());
				}
			},
		}
	}
	Ok(())
}
