//! zsh's builtin table and option parsing for zsh-dialect builtins: the
//! `struct builtin` entries of `builtin.c` `builtins[]` (option string,
//! argument bounds, default options, handler id) and `execbuiltin`, which
//! splits leading `-xyz`/`+xyz` words into an [`Ops`] the handlers read
//! with zsh's `OPT_ISSET`/`OPT_MINUS`/`OPT_PLUS`/`OPT_ARG` rules.
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use std::sync::Arc;

use bstr::BString;

use super::{Control, Ctx, Need, Outcome, R};
use crate::bash::{
	diag::Diag,
	ids::IntrinsicId,
	pattern::zsh::{PatFlags, Pattern, tokenize},
	syntax::zsh::{tok, tok::tail},
	vm::{
		expand::{Expander, Stop, X},
		zsh::{params, zpattern},
	},
	zshopt::ZshOpt,
};

/// `BINF_PLUSOPTS`: `+xyz` is an option word.
pub const PLUSOPTS: u32 = 1 << 1;
/// `BINF_PRINTOPTS`: after `-R` (without `-f`) only `-n`/`-e` are options
/// and unknown letters end the options (`print -R`).
pub const PRINTOPTS: u32 = 1 << 2;
/// `BINF_MAGICEQUALS`: `name=~/x` arguments get tilde expansion.
pub const MAGICEQUALS: u32 = 1 << 4;
/// `BINF_PSPECIAL`: a POSIX special builtin.
pub const PSPECIAL: u32 = 1 << 11;
/// `BINF_SKIPINVALID`: a word with a letter not in the option string is
/// an operand (`echo -x`).
pub const SKIPINVALID: u32 = 1 << 12;
/// `BINF_KEEPNUM`: `-NUM` is an option word.
pub const KEEPNUM: u32 = 1 << 13;
/// `BINF_SKIPDASH`: a lone `-` is an operand (`cd -`).
pub const SKIPDASH: u32 = 1 << 14;
/// `BINF_DASHDASHVALID`: `--` ends the options even with `SKIPINVALID`.
pub const DASHDASHVALID: u32 = 1 << 15;
/// `BINF_HANDLES_OPTS`: the handler parses its own options.
pub const HANDLES_OPTS: u32 = 1 << 18;
/// `BINF_ASSIGN`: takes assignment arguments (the typeset family).
pub const ASSIGN: u32 = 1 << 19;

/// zsh's handler variant ids (`BIN_*` in `zsh.h`): which behaviour of a
/// shared handler a builtin name selects.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Func {
	/// No variant (`0`).
	None,
	/// `BIN_EXPORT`.
	Export,
	/// `BIN_READONLY`.
	Readonly,
	/// `BIN_PRINT` (`print`, `pushln`).
	Print,
	/// `BIN_ECHO`.
	Echo,
	/// `BIN_PRINTF`.
	Printf,
	/// `BIN_TEST`.
	Test,
	/// `BIN_BRACKET` (`[`).
	Bracket,
	/// `BIN_CD` (`cd`, `chdir`).
	Cd,
	/// `BIN_PUSHD`.
	Pushd,
	/// `BIN_POPD`.
	Popd,
	/// `BIN_ENABLE`.
	Enable,
	/// `BIN_DISABLE`.
	Disable,
	/// `BIN_UNALIAS`.
	Unalias,
	/// `BIN_UNFUNCTION`.
	Unfunction,
	/// `BIN_UNHASH`.
	Unhash,
	/// `BIN_UNSET`.
	Unset,
	/// `BIN_COMMAND` (`command -v`/`-V`).
	Command,
}

/// One entry of zsh's builtin table (`struct builtin`).
#[derive(Clone, Copy, Debug)]
pub struct Builtin {
	/// `BINF_*` flags.
	pub flags:   u32,
	/// Fewest operands (`minargs`).
	pub min:     usize,
	/// Most operands, `None` for no limit (`maxargs` -1).
	pub max:     Option<usize>,
	/// Handler variant (`funcid`).
	pub func:    Func,
	/// Option letters (`optstr`; `None` when the handler gets every word):
	/// a letter followed by `:` takes an argument (in the same word or the
	/// next), `::` an optional one in the same word, `:%` an optional
	/// numeric one in the same or the next word.
	pub optstr:  Option<&'static [u8]>,
	/// Options set when not given (`defopts`).
	pub defopts: &'static [u8],
}

/// `BUILTIN(name, flags, handler, min, max, funcid, optstr, defopts)`
/// without the name and handler.
const fn b(
	flags: u32,
	min: usize,
	max: Option<usize>,
	func: Func,
	optstr: Option<&'static [u8]>,
	defopts: &'static [u8],
) -> Builtin {
	Builtin { flags, min, max, func, optstr, defopts }
}

/// zsh `execcmd`'s `magic_assign` for a command named `name`: a
/// `BINF_MAGICEQUALS` builtin (the typeset family, `alias`, `hash`) run
/// with `KSH_TYPESET`, whose `name=value` arguments (zsh word text
/// `word`) expand as assignments, unsplit. Called per argument by the
/// command expansion of zsh units.
pub fn magic_assign_arg(name: &[u8], kshtypeset: bool, word: &[u8]) -> bool {
	use crate::bash::syntax::zsh::{ident_end, tok::EQUALS};
	if !kshtypeset {
		return false;
	}
	let end = ident_end(word, 0);
	end > 0
		&& matches!(word.get(end), Some(&(EQUALS | b'=')))
		&& std::str::from_utf8(name)
			.ok()
			.and_then(builtin)
			.is_some_and(|b| b.flags & MAGICEQUALS != 0)
}

/// Whether `command ARGS` dispatches to `bin_whence` (zsh `execcmd`'s scan
/// of `command`'s options: a `-v` or `-V`, no letter but `pvV`).
fn command_whence(args: &[BString]) -> bool {
	let mut has_vv = false;
	for a in args {
		if a.first() != Some(&b'-') || a.len() == 1 || a.as_slice() == b"--" {
			break;
		}
		for &c in tail(a, 1) {
			match c {
				b'p' => {},
				b'v' | b'V' => has_vv = true,
				_ => return false,
			}
		}
	}
	has_vv
}

/// The typeset family's flags.
const TYPESET: u32 = PLUSOPTS | MAGICEQUALS | PSPECIAL | ASSIGN;

/// zsh's builtin table entry of `name` (zsh 5.9 `builtin.c` `builtins[]`,
/// `module.c` for `zmodload`), for the builtins this engine implements with
/// zsh semantics. A `match`, not a static table: a table of string slices
/// costs a dynamic relocation per pointer at every process start.
pub fn builtin(name: &str) -> Option<Builtin> {
	Some(match name {
		"[" => b(HANDLES_OPTS, 0, None, Func::Bracket, None, b""),
		":" => b(PSPECIAL, 0, None, Func::None, None, b""),
		"alias" => b(MAGICEQUALS | PLUSOPTS, 0, None, Func::None, Some(b"Lgmrs"), b""),
		"autoload" => b(PLUSOPTS, 0, None, Func::None, Some(b"dmktrRTUwWXz"), b"u"),
		"cd" => b(SKIPINVALID | SKIPDASH | DASHDASHVALID, 0, Some(2), Func::Cd, Some(b"qsPL"), b""),
		"command" => b(0, 0, None, Func::Command, Some(b"pvV"), b""),
		"chdir" => {
			b(SKIPINVALID | SKIPDASH | DASHDASHVALID, 0, Some(2), Func::Cd, Some(b"qsPL"), b"")
		},
		"declare" => {
			b(TYPESET, 0, None, Func::None, Some(b"AE:%F:%HL:%R:%TUZ:%afghi:%klmp:%rtuxz"), b"")
		},
		"dirs" => b(0, 0, None, Func::None, Some(b"clpv"), b""),
		"disable" => b(0, 0, None, Func::Disable, Some(b"afmprs"), b""),
		"echo" => b(SKIPINVALID, 0, None, Func::Echo, Some(b"neE"), b"-"),
		"enable" => b(0, 0, None, Func::Enable, Some(b"afmprs"), b""),
		"export" => {
			b(TYPESET, 0, None, Func::Export, Some(b"E:%F:%HL:%R:%TUZ:%afhi:%lp:%rtu"), b"xg")
		},
		"false" => b(0, 0, None, Func::None, None, b""),
		"fc" => b(0, 0, None, Func::None, Some(b"aAdDe:EfiIlLmnpPrRst:W"), b""),
		"float" => b(TYPESET, 0, None, Func::None, Some(b"E:%F:%HL:%R:%Z:%ghlp:%rtux"), b"E"),
		"functions" => b(PLUSOPTS, 0, None, Func::None, Some(b"ckmMstTuUWx:z"), b""),
		"getln" => b(0, 0, None, Func::None, Some(b"ecnAlE"), b"zr"),
		"getopts" => b(0, 2, None, Func::None, None, b""),
		"hash" => b(MAGICEQUALS, 0, None, Func::None, Some(b"Ldfmrv"), b""),
		"history" => b(0, 0, None, Func::None, Some(b"adDEfiLmnpPrt:"), b"l"),
		"integer" => b(TYPESET, 0, None, Func::None, Some(b"HL:%R:%Z:%ghi:%lp:%rtux"), b"i"),
		"let" => b(0, 1, None, Func::None, None, b""),
		"local" => b(TYPESET, 0, None, Func::None, Some(b"AE:%F:%HL:%R:%TUZ:%ahi:%lp:%rtux"), b""),
		"popd" => b(SKIPINVALID | SKIPDASH | DASHDASHVALID, 0, Some(1), Func::Popd, Some(b"q"), b""),
		"print" => b(PRINTOPTS, 0, None, Func::Print, Some(b"abcC:Df:ilmnNoOpPrRsSu:v:x:X:z-"), b""),
		"printf" => b(SKIPINVALID | SKIPDASH, 1, None, Func::Printf, Some(b"v:"), b""),
		"pushd" => {
			b(SKIPINVALID | SKIPDASH | DASHDASHVALID, 0, Some(2), Func::Pushd, Some(b"qsPL"), b"")
		},
		"pushln" => b(0, 0, None, Func::Print, None, b"-nz"),
		"pwd" => b(0, 0, Some(0), Func::None, Some(b"rLP"), b""),
		"read" => b(0, 0, None, Func::None, Some(b"cd:ek:%lnpqrst:%zu:AE"), b""),
		"readonly" => {
			b(TYPESET, 0, None, Func::Readonly, Some(b"AE:%F:%HL:%R:%TUZ:%afghi:%lptux"), b"r")
		},
		"rehash" => b(0, 0, Some(0), Func::None, Some(b"df"), b"r"),
		"set" => b(PSPECIAL | HANDLES_OPTS, 0, None, Func::None, None, b""),
		"shift" => b(PSPECIAL, 0, None, Func::None, Some(b"p"), b""),
		"test" => b(HANDLES_OPTS, 0, None, Func::Test, None, b""),
		"true" => b(0, 0, None, Func::None, None, b""),
		"type" => b(0, 0, None, Func::None, Some(b"ampfsSw"), b"v"),
		"typeset" => {
			b(TYPESET, 0, None, Func::None, Some(b"AE:%F:%HL:%R:%TUZ:%afghi:%klp:%rtuxmz"), b"")
		},
		"unalias" => b(0, 0, None, Func::Unalias, Some(b"ams"), b""),
		"unfunction" => b(0, 1, None, Func::Unfunction, Some(b"m"), b"f"),
		"unhash" => b(0, 1, None, Func::Unhash, Some(b"adfms"), b""),
		"unset" => b(PSPECIAL, 1, None, Func::Unset, Some(b"fmv"), b""),
		"whence" => b(0, 0, None, Func::None, Some(b"acmpvfsSwx:"), b""),
		"where" => b(0, 0, None, Func::None, Some(b"pmsSwx:"), b"ca"),
		"which" => b(0, 0, None, Func::None, Some(b"ampsSwx:"), b"c"),
		"zmodload" => b(0, 0, None, Func::None, Some(b"AFRILP:abcfdilmpsue"), b""),
		_ => return None,
	})
}

/// Run `f` over the zsh parameter code for the builtin in `ctx` (an
/// [`Expander`] sharing the builtin's replay log): `Ok(Err(diag))` for a
/// parameter or math error (zsh `zerr`), `Err` for a store failure or a
/// command substitution to run first.
pub fn zx<T>(
	ctx: &mut Ctx<'_, '_>,
	f: impl FnOnce(&mut Expander<'_, '_>) -> X<T>,
) -> Result<Result<T, Diag>, Need> {
	match params::with_ctx(ctx, f) {
		Ok(v) => Ok(Ok(v)),
		Err(Stop::Fail(d) | Stop::Fatal(d)) => Ok(Err(d)),
		Err(Stop::Store(e)) => Err(Need::Store(e)),
		// A substitution or probe to run first.
		Err(sub) => Err(Need::Sub(sub)),
	}
}

/// A zsh `zerr` from inside a builtin: the message without the builtin's
/// name, status 1, and the rest of the command line abandoned (zsh's
/// `errflag` unwinds to the enclosing `eval` or the top level).
#[allow(clippy::unnecessary_wraps, reason = "a handler's result: `return zerr(ctx, d)` ends it")]
pub fn zerr(ctx: &mut Ctx<'_, '_>, d: Diag) -> R {
	ctx.diag(d);
	Ok(Outcome { status: 1, control: Control::DiscardAll })
}

/// A zsh option in the builtin's vproc.
pub fn isset(ctx: &mut Ctx<'_, '_>, o: ZshOpt) -> Result<bool, Need> {
	ctx.zsh_option(o)
}

/// A builtin's pattern argument (zsh `tokenize` then `patcompile`), with
/// the character classes' environment: `matches` takes raw subjects.
pub struct ZPat {
	pat: Arc<Pattern>,
	env: zpattern::CharEnvBuf,
}

impl ZPat {
	/// zsh `pattry` of raw bytes `s`.
	pub fn matches(&self, s: &[u8]) -> bool {
		self.pat.matches(&tok::metafy(s), &self.env.env())
	}
}

/// Compile builtin argument `text` (raw bytes) as a zsh pattern (zsh
/// `tokenize` + `patcompile(…, PAT_STATIC, …)`). `Ok(None)` after
/// queuing `bad pattern: TEXT` under the builtin's name.
pub fn pattern_arg(ctx: &mut Ctx<'_, '_>, text: &[u8]) -> Result<Option<ZPat>, Need> {
	let mut t = tok::metafy(text);
	tokenize(&mut t);
	let r = zx(ctx, |ex| {
		let pat = zpattern::compile(ex, &t, PatFlags::NONE)?;
		let env = zpattern::char_env(ex)?;
		Ok(ZPat { pat, env })
	})?;
	if let Ok(p) = r {
		Ok(Some(p))
	} else {
		ctx.usage(format!("bad pattern: {}", bstr::BStr::new(text)));
		Ok(None)
	}
}

/// Run builtin `id` in the zsh dialect (`argv[0]` is its name): zsh's
/// option parsing ([`execbuiltin`]) and handler. `None` for the builtins
/// zsh shares with the bash implementation (`eval`, `.`/`source`,
/// `trap`, `kill`, `wait`, the job builtins, `emulate`, `setopt`, …). Out
/// of line: [`super::run`] dispatches every bash builtin too.
#[inline(never)]
pub fn run(id: IntrinsicId, ctx: &mut Ctx<'_, '_>, argv: &[BString]) -> Option<R> {
	use IntrinsicId as I;
	let args = tail(argv, 1);
	match id {
		I::Break => return Some(Ok(super::flow::zsh_break(ctx, args, false))),
		I::Continue => return Some(Ok(super::flow::zsh_break(ctx, args, true))),
		I::Return => return Some(Ok(super::flow::zsh_return(ctx, args))),
		I::Exit => return Some(Ok(super::flow::zsh_exit(ctx, args))),
		I::Source | I::Dot => return Some(super::flow::zsh_source(ctx, args)),
		I::Trap => return Some(super::trap::zsh_trap(ctx, args)),
		I::Bindkey
		| I::Vared
		| I::Zle
		| I::Compctl
		| I::Compcall
		| I::Compadd
		| I::Compset
		| I::Comparguments
		| I::Compdescribe
		| I::Compfiles
		| I::Compgroups
		| I::Compquote
		| I::Comptags
		| I::Comptry
		| I::Compvalues => {
			let what = if matches!(id, I::Bindkey | I::Vared | I::Zle) {
				format!("`{}' (zsh/zle)", ctx.name)
			} else {
				format!("`{}' (zsh/compctl, zsh/complete)", ctx.name)
			};
			ctx.diag(Diag::Unsupported { what: what.into() });
			return Some(super::done(1));
		},
		// zsh `execcmd`: only `command` with `-v`/`-V` among its leading
		// options (and no other letter) is `bin_whence`.
		I::Command if !command_whence(args) => return None,
		_ => {},
	}
	let bn = builtin(ctx.name)?;
	let Some((mut ops, rest)) = execbuiltin(ctx, &bn, args) else {
		return Some(super::done(1));
	};
	let base = argv.len() - rest.len();
	Some(match id {
		I::Colon | I::True => super::done(0),
		I::False => super::done(1),
		I::Print | I::Echo | I::Printf | I::Pushln => {
			super::zsh_print::print(ctx, &mut ops, rest, bn.func)
		},
		I::Bracket => crate::bash::vm::zsh::cond::test(ctx, rest, true),
		I::Test => crate::bash::vm::zsh::cond::test(ctx, rest, false),
		I::Typeset | I::Declare | I::Local | I::Export | I::Readonly | I::Integer | I::Float => {
			super::zsh_typeset::typeset(ctx, &mut ops, rest, base, bn.func)
		},
		I::Set => super::zsh_vars::set(ctx, rest),
		I::Unset => super::zsh_vars::unset(ctx, &ops, rest, bn.func),
		I::Shift => super::zsh_vars::shift(ctx, &ops, rest),
		I::Read => super::zsh_vars::read(ctx, &ops, rest),
		I::Getopts => super::zsh_vars::getopts(ctx, rest),
		I::Let => super::zsh_vars::let_(ctx, rest),
		I::Alias => super::zsh_names::alias(ctx, &ops, rest),
		I::Unalias | I::Unhash | I::Unfunction => super::zsh_names::unhash(ctx, &ops, rest, bn.func),
		I::Hash | I::Rehash => super::zsh_names::hash(ctx, &ops, rest),
		I::Whence | I::Which | I::Where | I::Type | I::Command => {
			super::zsh_names::whence(ctx, &ops, rest, bn.func)
		},
		I::Functions | I::Autoload => super::zsh_names::functions(ctx, &ops, rest, bn.func),
		I::Enable | I::Disable => super::zsh_names::enable(ctx, &ops, rest, bn.func),
		I::Zmodload => super::zsh_names::zmodload(ctx, &ops, rest),
		I::Cd | I::Chdir | I::Pushd | I::Popd => super::zsh_dir::cd(ctx, &ops, rest, bn.func),
		I::Dirs => super::zsh_dir::dirs(ctx, &ops, rest),
		I::Pwd => super::zsh_dir::pwd(ctx),
		I::Fc | I::History => super::history::zsh_fc(ctx, &ops, rest),
		_ => return None,
	})
}

/// Most option arguments one command may carry (zsh `MAX_OPS`-bounded
/// `ops->args`, indexed in the 6 high bits of `ind`).
const MAX_OPTARGS: usize = 63;

/// A builtin's parsed options (zsh `struct options`): per letter whether
/// it was given as `-x` (minus) or `+x` (plus), and its argument.
#[derive(Clone, Debug)]
pub struct Ops {
	/// zsh `ind`: bit 0 = `-x`, bit 1 = `+x`, bits 2.. = 1 + index of the
	/// option's argument in `args`.
	ind:  [u8; 128],
	args: Vec<BString>,
}

impl Default for Ops {
	fn default() -> Self {
		Self { ind: [0; 128], args: Vec::new() }
	}
}

impl Ops {
	fn ind(&self, c: u8) -> u8 {
		self.ind.get(usize::from(c)).copied().unwrap_or(0)
	}

	/// `OPT_ISSET`: `-c` or `+c` was given.
	pub fn isset(&self, c: u8) -> bool {
		self.ind(c) != 0
	}

	/// `OPT_MINUS`: `-c` was given.
	pub fn minus(&self, c: u8) -> bool {
		self.ind(c) & 1 != 0
	}

	/// `OPT_PLUS`: `+c` was given.
	pub fn plus(&self, c: u8) -> bool {
		self.ind(c) & 2 != 0
	}

	/// `OPT_HASARG`: `-c` came with an argument.
	pub fn hasarg(&self, c: u8) -> bool {
		self.ind(c) > 3
	}

	/// `OPT_ARG`: the argument of `-c`.
	pub fn arg(&self, c: u8) -> Option<&[u8]> {
		let i = usize::from(self.ind(c) >> 2);
		i.checked_sub(1)
			.and_then(|i| self.args.get(i))
			.map(|a| a.as_slice())
	}

	/// Mark `c` as given (`ops->ind[c] = 1`), as handlers do for implied
	/// options.
	pub fn set(&mut self, c: u8) {
		if let Some(v) = self.ind.get_mut(usize::from(c)) {
			*v = 1;
		}
	}

	/// Forget `c` (`ops->ind[c] = 0`).
	pub fn clear(&mut self, c: u8) {
		if let Some(v) = self.ind.get_mut(usize::from(c)) {
			*v = 0;
		}
	}
}

/// zsh `execbuiltin`'s option parsing and argument count check for `bn`
/// over `args` (the words after the command name): the options and the
/// operands. `None` after a diagnostic (`bad option: -x`, `argument
/// expected: -x`, `not enough arguments`, `too many arguments`); the
/// builtin's status is then 1.
pub fn execbuiltin<'a>(
	ctx: &mut Ctx<'_, '_>,
	bn: &Builtin,
	args: &'a [BString],
) -> Option<(Ops, &'a [BString])> {
	let mut ops = Ops::default();
	let mut flags = bn.flags;
	let mut i = 0;
	if let Some(mut optstr) = bn.optstr {
		while let Some(word) = args.get(i) {
			let arg = word.as_slice();
			let sense = match arg.first() {
				Some(b'-') => true,
				Some(b'+') if flags & PLUSOPTS != 0 => false,
				_ => break,
			};
			let second = arg.get(1).copied();
			// Digits are not options unless the command says they are.
			if flags & KEEPNUM == 0 && second.is_some_and(|c| c.is_ascii_digit()) {
				break;
			}
			if flags & SKIPDASH != 0 && second.is_none() {
				break;
			}
			if flags & DASHDASHVALID != 0 && arg == b"--" {
				i += 1;
				break;
			}
			// Unrecognised options to `echo` etc. are not options.
			if flags & SKIPINVALID != 0 && tail(arg, 1).iter().any(|c| !optstr.contains(c)) {
				break;
			}
			// `--` or `-` (`ind['-']`), and `+` (`ind['-']` and `ind['+']`).
			let start = usize::from(second == Some(b'-'));
			if arg.get(start + 1).is_none() {
				ops.ind[usize::from(b'-')] = 1;
				if !sense {
					ops.ind[usize::from(b'+')] = 1;
				}
			}
			let mut q = start + 1;
			while let Some(&c) = arg.get(q) {
				let Some(pos) = optstr.iter().position(|&o| o == c) else {
					let sign = if sense { '-' } else { '+' };
					ctx.usage(format!("bad option: {sign}{}", char::from(c)));
					return None;
				};
				ops.ind[usize::from(c & 0x7f)] = if sense { 1 } else { 2 };
				if optstr.get(pos + 1) == Some(&b':') {
					let rest = tail(arg, q + 1);
					let argptr: Option<BString> = match optstr.get(pos + 2) {
						// Optional argument in the same word.
						Some(b':') => (!rest.is_empty()).then(|| rest.into()),
						// Optional numeric argument in the same or the next
						// word.
						Some(b'%') => {
							if rest.first().is_some_and(u8::is_ascii_digit) {
								Some(rest.into())
							} else if let Some(next) = args.get(i + 1)
								&& next.first().is_some_and(u8::is_ascii_digit)
							{
								i += 1;
								Some(next.clone())
							} else {
								None
							}
						},
						// Mandatory argument.
						_ => {
							if !rest.is_empty() {
								Some(rest.into())
							} else if let Some(next) = args.get(i + 1) {
								i += 1;
								Some(next.clone())
							} else {
								ctx.usage(format!("argument expected: -{}", char::from(c)));
								return None;
							}
						},
					};
					if let Some(a) = argptr {
						if ops.args.len() >= MAX_OPTARGS {
							ctx.usage("too many option arguments");
							return None;
						}
						ops.args.push(a);
						let n = u8::try_from(ops.args.len()).unwrap_or(u8::MAX >> 2);
						ops.ind[usize::from(c & 0x7f)] |= n << 2;
						// The rest of the word was the argument.
						break;
					}
				}
				q += 1;
			}
			i += 1;
			// For `print`, the options after `-R` are `echo`'s.
			if flags & PRINTOPTS != 0 && ops.isset(b'R') && !ops.isset(b'f') {
				optstr = b"ne";
				flags |= SKIPINVALID;
			}
			// `--` ends the options.
			if ops.isset(b'-') {
				break;
			}
		}
	} else if flags & HANDLES_OPTS == 0 && args.first().is_some_and(|a| a.as_slice() == b"--") {
		ops.ind[usize::from(b'-')] = 1;
		i += 1;
	}
	for &c in bn.defopts {
		if !ops.isset(c) {
			ops.set(c);
		}
	}
	let rest = tail(args, i);
	if rest.len() < bn.min {
		ctx.usage("not enough arguments");
		return None;
	}
	if bn.max.is_some_and(|max| rest.len() > max) {
		ctx.usage("too many arguments");
		return None;
	}
	Some((ops, rest))
}
