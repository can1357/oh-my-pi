//! zsh's special parameters: `params.c`'s `special_params`
//! table and the built-in `zsh/parameter` views (`Modules/parameter.c`),
//! as views over the engine's state.
//!
//! Three kinds:
//! - **computed** specials read engine state on every access (`argv`, `$#`,
//!   `status`, `$$`, `$-`, `LINENO`, `RANDOM`, `pipestatus`, `funcstack`,
//!   `options`, …) and write it back (`argv=(…)` sets the positional
//!   parameters, `options[x]=on` sets an option);
//! - **tied** arrays (`path fpath cdpath manpath module_path mailpath psvar
//!   fignore zsh_eval_context`) are views of their colon-separated scalar
//!   (`PATH`, …), which is an ordinary stored variable;
//! - **plain** specials (`IFS`, `HOME`, `PS1`, `OPTIND`, `TRY_BLOCK_ERROR`, …)
//!   are stored variables zsh merely flags as special (`${(t)IFS}` is
//!   `scalar-special`); `ZSH_VERSION`, `ZSH_PATCHLEVEL`, `ZSH_NAME` and
//!   `ZSH_ARGZERO` are plain parameters with a computed default.
//!
//! zsh names exist only in zsh dialect: bash code never consults this
//! table.
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use bstr::BString;
use strum::IntoEnumIterator;

use super::{
	params::{PValue, Param, PmFlags},
	text::word_list,
};
use crate::bash::{
	diag::Diag,
	store::{Key, KeyBuf, MiscKey, Record, Table},
	syntax::zsh::tok::span,
	vm::{
		expand::{Expander, Stop, X},
		state,
	},
	zshopt::ZshOpt,
};

/// The colon-array ties zsh has built in (`IPDEF8`/`IPDEF9`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Tie {
	/// `path` / `PATH`.
	Path,
	/// `fpath` / `FPATH`.
	Fpath,
	/// `cdpath` / `CDPATH`.
	Cdpath,
	/// `manpath` / `MANPATH`.
	Manpath,
	/// `module_path` / `MODULE_PATH`.
	ModulePath,
	/// `mailpath` / `MAILPATH`.
	Mailpath,
	/// `psvar` / `PSVAR`.
	Psvar,
	/// `fignore` / `FIGNORE`.
	Fignore,
	/// `zsh_eval_context` / `ZSH_EVAL_CONTEXT`.
	ZshEvalContext,
}

impl Tie {
	/// Every tie.
	const ALL: [Self; 9] = [
		Self::Path,
		Self::Fpath,
		Self::Cdpath,
		Self::Manpath,
		Self::ModulePath,
		Self::Mailpath,
		Self::Psvar,
		Self::Fignore,
		Self::ZshEvalContext,
	];

	/// The array's name.
	pub const fn array(self) -> &'static str {
		match self {
			Self::Path => "path",
			Self::Fpath => "fpath",
			Self::Cdpath => "cdpath",
			Self::Manpath => "manpath",
			Self::ModulePath => "module_path",
			Self::Mailpath => "mailpath",
			Self::Psvar => "psvar",
			Self::Fignore => "fignore",
			Self::ZshEvalContext => "zsh_eval_context",
		}
	}

	/// The scalar's name.
	pub const fn scalar(self) -> &'static str {
		match self {
			Self::Path => "PATH",
			Self::Fpath => "FPATH",
			Self::Cdpath => "CDPATH",
			Self::Manpath => "MANPATH",
			Self::ModulePath => "MODULE_PATH",
			Self::Mailpath => "MAILPATH",
			Self::Psvar => "PSVAR",
			Self::Fignore => "FIGNORE",
			Self::ZshEvalContext => "ZSH_EVAL_CONTEXT",
		}
	}
}

/// A zsh special parameter.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Special {
	/// `argv`: the positional parameters, writable.
	Argv,
	/// `*` and `@`.
	Star,
	/// `#` and `ARGC`.
	Pound,
	/// `?` and `status`.
	Status,
	/// `$`.
	Dollar,
	/// `!`.
	Bang,
	/// `-`: the single-letter options that are on.
	Dash,
	/// `0`.
	Zero,
	/// `_`.
	Underscore,
	/// `LINENO`.
	Lineno,
	/// `PPID`.
	Ppid,
	/// `RANDOM`.
	Random,
	/// `SECONDS`.
	Seconds,
	/// `HISTCMD`.
	Histcmd,
	/// `UID`.
	Uid,
	/// `EUID`.
	Euid,
	/// `GID`.
	Gid,
	/// `EGID`.
	Egid,
	/// `USERNAME`.
	Username,
	/// `TTYIDLE`.
	Ttyidle,
	/// `ZSH_SUBSHELL`.
	ZshSubshell,
	/// `pipestatus`.
	Pipestatus,
	/// `funcstack`.
	Funcstack,
	/// `dirstack`.
	Dirstack,
	/// `TRY_BLOCK_ERROR`: the error flag an `always` list sees.
	TryBlockError,
	/// `TRY_BLOCK_INTERRUPT`.
	TryBlockInterrupt,
	/// A tied colon array (`path`, …).
	TiedArray(Tie),
	/// The scalar side of a built-in tie (`PATH`, …): a stored variable.
	TiedScalar(Tie),
	/// `options`.
	Options,
	/// `functions`.
	Functions,
	/// `aliases`.
	Aliases,
	/// `galiases`.
	Galiases,
	/// `saliases`.
	Saliases,
	/// `commands`.
	Commands,
	/// `parameters`.
	Parameters,
	/// `builtins`.
	Builtins,
	/// `modules`.
	Modules,
	/// A stored variable zsh flags as special (`IFS`, `HOME`, …), by index
	/// into the plain table.
	Plain(u8),
	/// `ZSH_VERSION`, `ZSH_PATCHLEVEL`, `ZSH_NAME`, `ZSH_ARGZERO`: plain
	/// parameters with a computed default.
	Version(u8),
}

/// Plain specials (space separated, see [`word_list`]); their type flags
/// (`${(t)…}` per zsh 5.9) are [`PLAIN_FLAGS`], in the same order.
const PLAIN: &[u8] = b"IFS HOME TERM TERMINFO TERMINFO_DIRS WORDCHARS KEYBOARD_HACK histchars \
	HISTCHARS LANG LC_ALL LC_COLLATE LC_CTYPE LC_MESSAGES LC_NUMERIC LC_TIME COLUMNS LINES SHLVL \
	FUNCNEST OPTIND OPTARG NULLCMD READNULLCMD SPROMPT";

/// The type flags of the [`PLAIN`] specials.
const PLAIN_FLAGS: [PmFlags; 25] = [
	PmFlags::SCALAR,
	PmFlags::SCALAR,
	PmFlags::SCALAR,
	PmFlags::SCALAR,
	PmFlags::SCALAR,
	PmFlags::SCALAR,
	PmFlags::SCALAR,
	PmFlags::SCALAR,
	PmFlags::SCALAR,
	PmFlags::SCALAR,
	PmFlags::SCALAR,
	PmFlags::SCALAR,
	PmFlags::SCALAR,
	PmFlags::SCALAR,
	PmFlags::SCALAR,
	PmFlags::SCALAR,
	PmFlags::INTEGER,
	PmFlags::INTEGER,
	PmFlags::INTEGER,
	PmFlags::INTEGER,
	PmFlags::INTEGER,
	PmFlags::SCALAR,
	PmFlags::SCALAR,
	PmFlags::SCALAR,
	PmFlags::SCALAR,
];

/// Prompt specials (scalar-special), space separated.
const PROMPTS: &[u8] = b"PS1 PS2 PS3 PS4 prompt PROMPT PROMPT2 PROMPT3 PROMPT4";

/// The parameters with a computed default, space separated.
const VERSION: &[u8] = b"ZSH_VERSION ZSH_PATCHLEVEL ZSH_NAME ZSH_ARGZERO";

/// Every computed or tied special name, space separated
/// ([`super::params::scan_names`] lists them).
pub const NAMES: &[u8] = b"argv * @ # ARGC ? status $ ! - 0 _ LINENO PPID RANDOM SECONDS HISTCMD \
	UID EUID GID EGID USERNAME TTYIDLE ZSH_SUBSHELL pipestatus funcstack dirstack TRY_BLOCK_ERROR \
	TRY_BLOCK_INTERRUPT path fpath cdpath manpath module_path mailpath psvar fignore \
	zsh_eval_context ZSH_EVAL_CONTEXT options functions aliases galiases saliases commands \
	parameters builtins modules ZSH_VERSION ZSH_PATCHLEVEL ZSH_NAME ZSH_ARGZERO";

/// The special `name` names in zsh dialect.
pub fn lookup(name: &[u8]) -> Option<Special> {
	Some(match name {
		b"argv" => Special::Argv,
		b"*" | b"@" => Special::Star,
		b"#" | b"ARGC" => Special::Pound,
		b"?" | b"status" => Special::Status,
		b"$" => Special::Dollar,
		b"!" => Special::Bang,
		b"-" => Special::Dash,
		b"0" => Special::Zero,
		b"_" => Special::Underscore,
		b"LINENO" => Special::Lineno,
		b"PPID" => Special::Ppid,
		b"RANDOM" => Special::Random,
		b"SECONDS" => Special::Seconds,
		b"HISTCMD" => Special::Histcmd,
		b"UID" => Special::Uid,
		b"EUID" => Special::Euid,
		b"GID" => Special::Gid,
		b"EGID" => Special::Egid,
		b"USERNAME" => Special::Username,
		b"TTYIDLE" => Special::Ttyidle,
		b"ZSH_SUBSHELL" => Special::ZshSubshell,
		b"pipestatus" => Special::Pipestatus,
		b"funcstack" => Special::Funcstack,
		b"dirstack" => Special::Dirstack,
		b"TRY_BLOCK_ERROR" => Special::TryBlockError,
		b"TRY_BLOCK_INTERRUPT" => Special::TryBlockInterrupt,
		b"options" => Special::Options,
		b"functions" => Special::Functions,
		b"aliases" => Special::Aliases,
		b"galiases" => Special::Galiases,
		b"saliases" => Special::Saliases,
		b"commands" => Special::Commands,
		b"parameters" => Special::Parameters,
		b"builtins" => Special::Builtins,
		b"modules" => Special::Modules,
		_ => {
			if let Some(t) = Tie::ALL.iter().find(|t| t.array().as_bytes() == name) {
				return Some(Special::TiedArray(*t));
			}
			if let Some(t) = Tie::ALL.iter().find(|t| t.scalar().as_bytes() == name) {
				return Some(Special::TiedScalar(*t));
			}
			if let Some(i) = word_list(PLAIN).position(|n| n == name) {
				return Some(Special::Plain(u8::try_from(i).unwrap_or(0)));
			}
			if word_list(PROMPTS).any(|n| n == name) {
				return Some(Special::Plain(u8::MAX));
			}
			if let Some(i) = word_list(VERSION).position(|n| n == name) {
				return Some(Special::Version(u8::try_from(i).unwrap_or(0)));
			}
			return None;
		},
	})
}

impl Special {
	/// The `PM_*` flags zsh gives it (`${(t)…}`).
	pub const fn flags(self) -> PmFlags {
		const S: PmFlags = PmFlags::SPECIAL;
		const RO: PmFlags = PmFlags::READONLY;
		const HH: PmFlags = PmFlags(PmFlags::HIDE.0 | PmFlags::HIDEVAL.0);
		let f = match self {
			Self::Argv | Self::Pipestatus => PmFlags::ARRAY.0,
			Self::Star => PmFlags::ARRAY.0 | RO.0,
			Self::Pound
			| Self::Status
			| Self::Dollar
			| Self::Bang
			| Self::Lineno
			| Self::Ppid
			| Self::Histcmd
			| Self::Ttyidle
			| Self::ZshSubshell => PmFlags::INTEGER.0 | RO.0,
			Self::Random
			| Self::Seconds
			| Self::Uid
			| Self::Euid
			| Self::Gid
			| Self::Egid
			| Self::TryBlockError
			| Self::TryBlockInterrupt => PmFlags::INTEGER.0,
			Self::Dash => RO.0,
			Self::Zero | Self::Underscore | Self::Username => 0,
			Self::Funcstack => PmFlags::ARRAY.0 | RO.0 | HH.0,
			Self::Dirstack => PmFlags::ARRAY.0 | HH.0,
			Self::TiedArray(Tie::ZshEvalContext) => PmFlags::ARRAY.0 | RO.0 | PmFlags::TIED.0,
			Self::TiedArray(_) => PmFlags::ARRAY.0 | PmFlags::TIED.0,
			Self::TiedScalar(Tie::ZshEvalContext) => RO.0 | PmFlags::TIED.0,
			Self::TiedScalar(_) => PmFlags::TIED.0,
			Self::Options
			| Self::Functions
			| Self::Aliases
			| Self::Galiases
			| Self::Saliases
			| Self::Commands => PmFlags::HASHED.0 | HH.0,
			Self::Parameters | Self::Builtins | Self::Modules => PmFlags::HASHED.0 | RO.0 | HH.0,
			Self::Plain(i) => {
				if (i as usize) < PLAIN_FLAGS.len() {
					PLAIN_FLAGS[i as usize].0
				} else {
					0
				}
			},
			Self::Version(_) => return PmFlags::SCALAR,
		};
		// zsh's read-only specials are all `PM_READONLY_SPECIAL`.
		let f = if f & RO.0 != 0 {
			f | PmFlags::RO_BY_DESIGN.0
		} else {
			f
		};
		PmFlags(f | S.0)
	}

	/// Whether assignments to it fail with `read-only variable`.
	pub const fn readonly(self) -> bool {
		self.flags().contains(PmFlags::READONLY)
	}

	/// Whether it is a stored variable with special flags (or a computed
	/// default) rather than a view.
	pub const fn is_plain(self) -> bool {
		match self {
			// `ZSH_EVAL_CONTEXT` is computed from the call stack.
			Self::TiedScalar(Tie::ZshEvalContext) => false,
			Self::Plain(_) | Self::TiedScalar(_) | Self::Version(_) => true,
			_ => false,
		}
	}

	/// Whether a stored variable named `name` is its own value (not a bash
	/// variable it shadows). A stored `_` (imported from the environment,
	/// or bash's own `$_`) is no bash value zsh code loses: zsh ignores it.
	pub const fn is_backed_by(self, _name: &[u8]) -> bool {
		self.is_plain() || matches!(self, Self::Underscore)
	}

	/// The built-in tie partner and separator.
	pub const fn tie_partner(self) -> Option<(&'static str, u8)> {
		match self {
			Self::TiedScalar(t) => Some((t.array(), b':')),
			Self::TiedArray(t) => Some((t.scalar(), b':')),
			_ => None,
		}
	}

	/// The computed default of a [`Special::Version`] parameter.
	fn default(self, ex: &Expander<'_, '_>) -> Option<BString> {
		let Self::Version(i) = self else {
			return None;
		};
		Some(match i {
			0 => BString::from("5.9"),
			1 => BString::from("zsh-5.9-0-g73d3173"),
			2 => {
				let a = &ex.k.argv0;
				let base = a.rsplit(|&c| c == b'/').next().unwrap_or(a);
				BString::from(base.strip_prefix(b"-").unwrap_or(base))
			},
			_ => ex.k.argv0.clone(),
		})
	}
}

/// A number as text.
fn num(n: impl std::fmt::Display) -> BString {
	BString::from(n.to_string())
}

/// The parameter a special shows (its value read now).
///
/// # Errors
/// [`Stop::Store`] when the state cannot be read.
pub fn param(ex: &mut Expander<'_, '_>, sp: Special, name: &[u8]) -> X<Param> {
	let value = get(ex, sp)?;
	let mut flags = sp.flags();
	let value = value.unwrap_or_else(|| {
		flags = flags.with(PmFlags::UNSET);
		match flags.type_bits() {
			PmFlags::ARRAY => PValue::Array(Vec::new()),
			PmFlags::HASHED => PValue::Hash(Vec::new()),
			_ => PValue::Scalar(BString::default()),
		}
	});
	Ok(Param::special(name, flags, value, sp))
}

/// The value of a computed special (`None`: unset).
///
/// # Errors
/// [`Stop::Store`] when the state cannot be read.
#[expect(clippy::too_many_lines, reason = "one arm per special")]
pub fn get(ex: &mut Expander<'_, '_>, sp: Special) -> X<Option<PValue>> {
	let scalar = |s: BString| Ok(Some(PValue::Scalar(s)));
	match sp {
		Special::Argv | Special::Star => {
			let p = state::positional_ref(&ex.k.root, ex.cx.store, ex.vp)?.to_vec();
			Ok(Some(PValue::Array(p)))
		},
		Special::Pound => {
			let n = state::positional_ref(&ex.k.root, ex.cx.store, ex.vp)?.len();
			scalar(num(n))
		},
		Special::Status => scalar(num(ex.vp.status)),
		Special::Dollar => match state::record(ex.cx.store, ex.vp, Key::Misc(MiscKey::ShellPid))? {
			Some(Record::Misc(v)) => scalar(v.clone()),
			_ => scalar(num(ex.k.shell_pid)),
		},
		Special::Bang => scalar(num(ex.last_bg()?.unwrap_or(0))),
		Special::Dash => {
			let mode = ex.vp.mode;
			let mut s = BString::default();
			for c in b'0'..=b'z' {
				if let Some((opt, inv)) = ZshOpt::letter(c, mode)
					&& state::zsh_option(&mut ex.k.root, ex.cx.store, ex.vp, opt)? != inv
				{
					s.push(c);
				}
			}
			scalar(s)
		},
		Special::Zero => {
			// zsh `doshfunc` makes the name `$0` at the call when
			// FUNCTION_ARGZERO is on then: an `emulate -L sh` in the body
			// does not change it. The caller's options are saved with the
			// call; after a sticky switch the body's are the entry ones. A
			// call without it keeps its caller's `$0`: the walk goes on
			// outwards.
			if let Some(top) = state::func_scope(&ex.k.root, ex.cx.store, ex.vp)? {
				for i in (0..=top).rev() {
					let Some(f) = state::scope_func(ex.cx.store, ex.vp, i)? else {
						continue;
					};
					if f.is_empty() {
						continue;
					}
					let at_entry = match state::scope_zsh(ex.cx.store, ex.vp, i)? {
						Some(z) if !z.restore_sticky => z.opts.get(ZshOpt::Functionargzero),
						_ => {
							state::zsh_option(&mut ex.k.root, ex.cx.store, ex.vp, ZshOpt::Functionargzero)?
						},
					};
					if at_entry {
						return scalar(f);
					}
				}
			}
			scalar(state::dollar0(ex.cx.store, ex.vp, &ex.k.argv0)?)
		},
		Special::Underscore => {
			match state::record(ex.cx.store, ex.vp, Key::Misc(MiscKey::LastArg))? {
				Some(Record::Misc(v)) => scalar(v.clone()),
				_ => scalar(BString::default()),
			}
		},
		Special::Lineno => {
			let line = ex.k.zsh_site(ex.cx, ex.vp, ex.line).1;
			scalar(num(line))
		},
		Special::Ppid => scalar(num(ex.cx.host.ppid())),
		Special::Random => scalar(num(ex.k.next_random(ex.cx.store) & 0x7fff)),
		Special::Seconds => {
			scalar(num(ex.cx.host.now_ns().saturating_sub(ex.k.start_ns) / 1_000_000_000))
		},
		Special::Histcmd => scalar(BString::from("0")),
		Special::Uid => scalar(num(ex.cx.host.user().uid)),
		Special::Euid => scalar(num(ex.cx.host.user().euid)),
		Special::Gid | Special::Egid => scalar(num(ex.cx.host.user().gid)),
		Special::Username => scalar(ex.cx.host.user().name),
		Special::Ttyidle => scalar(BString::from("-1")),
		Special::ZshSubshell => scalar(num(crate::bash::vm::subshell_depth(ex.vp))),
		Special::TryBlockError => scalar(num(crate::bash::vm::exec::try_block_error(ex.vp))),
		Special::TryBlockInterrupt => {
			scalar(num(crate::bash::vm::exec::try_block_error(ex.vp).min(0)))
		},
		Special::Pipestatus => {
			Ok(Some(PValue::Array(ex.vp.pipestatus.iter().map(|s| num(*s)).collect())))
		},
		Special::Funcstack => {
			let n = state::scope_count(&ex.k.root, ex.vp);
			let mut out = Vec::new();
			for i in (0..n).rev() {
				if let Some(f) = state::scope_func(ex.cx.store, ex.vp, i)?
					&& !f.is_empty()
				{
					out.push(f);
				}
			}
			Ok(Some(PValue::Array(out)))
		},
		Special::Dirstack => {
			let mut v = crate::bash::vm::builtins::dirstack::dirstack_value(ex.cx.store, ex.vp)?;
			v.remove(0);
			Ok(Some(PValue::Array(v)))
		},
		Special::TiedArray(Tie::ZshEvalContext) => Ok(Some(PValue::Array(eval_context(ex.vp)))),
		Special::TiedScalar(Tie::ZshEvalContext) => {
			scalar(BString::from(eval_context(ex.vp).join(&b":"[..])))
		},
		Special::TiedArray(t) => {
			// The array side is unset with its scalar (`unset MANPATH`).
			let Some(v) = state::lookup(&ex.k.root, ex.cx.store, ex.vp, t.scalar().as_bytes())? else {
				return Ok(None);
			};
			Ok(Some(PValue::Array(match v.as_scalar() {
				Some(s) if !s.is_empty() => s.split(|&c| c == b':').map(BString::from).collect(),
				_ => Vec::new(),
			})))
		},
		Special::Options => {
			let mut out = Vec::with_capacity(ZshOpt::COUNT);
			for o in ZshOpt::iter() {
				let on = state::zsh_option(&mut ex.k.root, ex.cx.store, ex.vp, o)?;
				let name: &'static str = o.into();
				out.push((BString::from(name), BString::from(if on { "on" } else { "off" })));
			}
			Ok(Some(PValue::Hash(out)))
		},
		Special::Functions => {
			let recs = state::scan(&ex.k.root, ex.cx.store, ex.vp, Table::Func)?;
			Ok(Some(PValue::Hash(
				recs
					.into_iter()
					.filter_map(|(k, r)| match (k, r) {
						(KeyBuf::Func(n), Record::Func { source, .. }) => Some((n, func_body(&source))),
						_ => None,
					})
					.collect(),
			)))
		},
		Special::Aliases => {
			let recs = state::scan(&ex.k.root, ex.cx.store, ex.vp, Table::Alias)?;
			Ok(Some(PValue::Hash(
				recs
					.into_iter()
					.filter_map(|(k, r)| match (k, r) {
						(KeyBuf::Alias(n), Record::Alias(v)) => Some((n, v)),
						_ => None,
					})
					.collect(),
			)))
		},
		Special::Galiases | Special::Saliases => {
			let want = sp == Special::Saliases;
			let recs = state::scan(&ex.k.root, ex.cx.store, ex.vp, Table::ZshAlias)?;
			Ok(Some(PValue::Hash(
				recs
					.into_iter()
					.filter_map(|(k, r)| match (k, r) {
						(KeyBuf::ZshAlias { suffix, name }, Record::Alias(v)) if suffix == want => {
							Some((name, v))
						},
						_ => None,
					})
					.collect(),
			)))
		},
		Special::Commands => {
			let recs = state::scan(&ex.k.root, ex.cx.store, ex.vp, Table::CmdHash)?;
			Ok(Some(PValue::Hash(
				recs
					.into_iter()
					.filter_map(|(k, r)| match (k, r) {
						(KeyBuf::CmdHash(n), Record::CmdHash { path, .. }) => Some((n, path)),
						_ => None,
					})
					.collect(),
			)))
		},
		Special::Parameters => {
			// zsh's scanpmparameters reads types, never values: list
			// `parameters` itself without computing it again.
			let names = super::params::scan_names(ex)?;
			let mut out = Vec::with_capacity(names.len());
			for n in names {
				let p = if lookup(&n) == Some(Special::Parameters) {
					Param::special(&n, sp.flags(), PValue::Hash(Vec::new()), sp)
				} else if let Some(p) = super::params::getparam(ex, &n)? {
					p
				} else {
					continue;
				};
				if p.is_set() {
					out.push((n, p.type_name()));
				}
			}
			Ok(Some(PValue::Hash(out)))
		},
		Special::Builtins => {
			let mut names: Vec<&'static str> = crate::bash::ids::IntrinsicId::iter()
				.map(<&'static str>::from)
				.collect();
			names.sort_unstable();
			Ok(Some(PValue::Hash(
				names
					.into_iter()
					.map(|n| (BString::from(n), BString::from("defined")))
					.collect(),
			)))
		},
		Special::Modules => {
			Ok(Some(PValue::Hash(vec![(BString::from("zsh/parameter"), BString::from("loaded"))])))
		},
		Special::Version(_) => Ok(sp.default(ex).map(PValue::Scalar)),
		Special::Plain(_) | Special::TiedScalar(_) => Ok(None),
	}
}

/// zsh `zsh_eval_context`: `toplevel` (or the context a subshell started
/// in), then one word per function call (`shfunc`), `eval`, sourced file
/// (`file`), trap (`trap`) and command substitution (`cmdsubst`) on the
/// vproc's stack, outermost first. `child_running` keeps it for a child.
pub fn eval_context(vp: &crate::bash::vm::proc::Vproc) -> Vec<BString> {
	use crate::bash::vm::proc::{FrameKind, ScriptKind};
	let mut out = match vp.zsh.as_deref() {
		Some(z) if !z.context.is_empty() => z.context.clone(),
		_ => vec![BString::from("toplevel")],
	};
	for (i, f) in vp.frames.iter().enumerate() {
		let word = match &f.kind {
			FrameKind::Function { .. } => "shfunc",
			FrameKind::Script { what: ScriptKind::Eval, .. } if i == 0 && vp.parent.is_some() => {
				"cmdsubst"
			},
			FrameKind::Script { what: ScriptKind::Eval, .. } => "eval",
			FrameKind::Script { what: ScriptKind::Source, .. } => "file",
			FrameKind::Script { what: ScriptKind::Trap { .. }, .. } => "trap",
			_ => continue,
		};
		out.push(BString::from(word));
	}
	out
}

/// The body of a function as `$functions` shows it: the text between the
/// outer braces of its canonical source, re-indented with one tab.
fn func_body(source: &[u8]) -> BString {
	let open = source.iter().position(|&c| c == b'{');
	let close = source.iter().rposition(|&c| c == b'}');
	match (open, close) {
		(Some(a), Some(b)) if a < b => {
			let inner = span(source, a + 1, b).trim_ascii();
			let mut out = BString::default();
			for (i, line) in inner.split(|&c| c == b'\n').enumerate() {
				if i > 0 {
					out.push(b'\n');
				}
				out.push(b'\t');
				out.extend_from_slice(line.trim_ascii_start());
			}
			out
		},
		_ => BString::from(source),
	}
}

/// Assign `value` to the computed special `sp` (zsh's set functions).
///
/// # Errors
/// `read-only variable: NAME` for read-only specials, a type mismatch,
/// a store failure.
pub fn set(ex: &mut Expander<'_, '_>, sp: Special, name: &[u8], value: PValue) -> X<()> {
	if sp.readonly() {
		return Err(Stop::Fail(Diag::Readonly { name: BString::from(name) }));
	}
	let as_array = |v: PValue| match v {
		PValue::Array(a) => a,
		PValue::Scalar(s) => vec![s],
		PValue::Hash(h) => h.into_iter().flat_map(|(k, v)| [k, v]).collect(),
	};
	let as_scalar = |v: &PValue| match v {
		PValue::Scalar(s) => s.clone(),
		PValue::Array(a) => BString::from(a.join(&b" "[..])),
		PValue::Hash(_) => BString::default(),
	};
	match sp {
		Special::Argv => {
			state::set_positional(&mut ex.k.root, ex.cx.store, ex.vp, as_array(value));
		},
		Special::Pipestatus => {
			ex.vp.pipestatus = as_array(value)
				.iter()
				.map(|s| {
					std::str::from_utf8(s)
						.ok()
						.and_then(|s| s.trim().parse().ok())
						.unwrap_or(0)
				})
				.collect();
		},
		Special::TryBlockError => {
			let v = super::params::parse_int(&as_scalar(&value));
			crate::bash::vm::exec::set_try_block_error(ex.vp, v);
		},
		Special::TryBlockInterrupt => {},
		Special::Random => {
			let seed = super::params::parse_int(&as_scalar(&value));
			ex.k.seed_random(ex.cx.store, seed);
		},
		Special::Seconds => {
			let secs = u64::try_from(super::params::parse_int(&as_scalar(&value))).unwrap_or(0);
			let now = ex.cx.host.now_ns();
			ex.k.start_ns = now.saturating_sub(secs.saturating_mul(1_000_000_000));
			let v = ex.k.start_ns;
			ex.k.root.set_misc(ex.cx.store, MiscKey::StartNs, num(v));
		},
		Special::TiedArray(t) => {
			let joined = BString::from(as_array(value).join(&b":"[..]));
			let attrs = state::lookup_declared(&ex.k.root, ex.cx.store, ex.vp, t.scalar().as_bytes())?
				.map_or(crate::bash::store::Attrs::NONE, |v| v.attrs)
				.without(crate::bash::store::Attrs::INVISIBLE);
			state::store_var(
				&mut ex.k.root,
				ex.cx.store,
				ex.vp,
				t.scalar().as_bytes(),
				Some(state::Var::scalar(joined, attrs)),
				state::Level::Dynamic,
			);
			// zsh `arrfixenv`: a new `path` empties the command hash table.
			if t.scalar() == "PATH" {
				crate::bash::vm::builtins::flush_hash(&mut ex.k.root, ex.cx.store, ex.vp)?;
			}
		},
		Special::Options => {
			let pairs: Vec<(BString, BString)> = match value {
				PValue::Hash(h) => h,
				other => {
					let a = as_array(other);
					a.chunks(2)
						.map(|p| (p[0].clone(), p.get(1).cloned().unwrap_or_default()))
						.collect()
				},
			};
			for (k, v) in pairs {
				set_option(ex, &k, &v)?;
			}
		},
		Special::Aliases | Special::Galiases | Special::Saliases => {
			let PValue::Hash(h) = value else {
				return Ok(());
			};
			for (k, v) in h {
				let key = match sp {
					Special::Aliases => KeyBuf::Alias(k),
					s => KeyBuf::ZshAlias { suffix: s == Special::Saliases, name: k },
				};
				state::store_record(&mut ex.k.root, ex.cx.store, ex.vp, key, Some(Record::Alias(v)));
			}
		},
		Special::Dirstack => {
			let entries = as_array(value);
			let rec = (!entries.is_empty()).then_some(Record::DirStack(entries));
			state::store_record(&mut ex.k.root, ex.cx.store, ex.vp, KeyBuf::DirStack, rec);
		},
		Special::Zero
		| Special::Underscore
		| Special::Uid
		| Special::Euid
		| Special::Gid
		| Special::Egid => {},
		Special::Username | Special::Commands | Special::Functions => {
			return Err(Stop::Fail(Diag::Unsupported {
				what: format!("assigning to zsh special `{}'", bstr::BStr::new(name)).into(),
			}));
		},
		_ => return Err(Stop::Fail(Diag::Readonly { name: BString::from(name) })),
	}
	Ok(())
}

/// `options[name]=value` (zsh `setpmoption`): `on` or `off`, else
/// `invalid value`; an unknown name is `no such option`.
fn set_option(ex: &mut Expander<'_, '_>, name: &[u8], value: &[u8]) -> X<()> {
	if value != b"on" && value != b"off" {
		let msg = BString::from(format!("invalid value: {}", bstr::BStr::new(value)));
		ex.k.diag(ex.cx, ex.vp, ex.line, Diag::Warning { msg });
		return Ok(());
	}
	let Some((opt, inv)) = ZshOpt::lookup(name) else {
		let d = Diag::NoSuchOption { name: BString::from(name) };
		ex.k.diag(ex.cx, ex.vp, ex.line, d);
		return Ok(());
	};
	let on = (value == b"on") != inv;
	let cur = state::zsh_option(&mut ex.k.root, ex.cx.store, ex.vp, opt)?;
	if cur == on {
		return Ok(());
	}
	let interactive = opt == ZshOpt::Exec
		&& state::zsh_option(&mut ex.k.root, ex.cx.store, ex.vp, ZshOpt::Interactive)?;
	if opt.fixed(cur, on, interactive) {
		let msg = BString::from(format!("can't change option: {}", bstr::BStr::new(name)));
		ex.k.diag(ex.cx, ex.vp, ex.line, Diag::Warning { msg });
		return Ok(());
	}
	state::set_zsh_option(&mut ex.k.root, ex.cx.store, ex.vp, opt, on)?;
	Ok(())
}

/// Unset the computed special `sp` (zsh unsets the value and keeps the
/// special; `unset argv` empties the positional parameters).
///
/// # Errors
/// `read-only variable` for read-only specials.
pub fn unset(ex: &mut Expander<'_, '_>, sp: Special, name: &[u8]) -> X<()> {
	match sp {
		Special::Argv => {
			state::set_positional(&mut ex.k.root, ex.cx.store, ex.vp, Vec::new());
			Ok(())
		},
		Special::Pipestatus => {
			ex.vp.pipestatus.clear();
			Ok(())
		},
		Special::TiedArray(t) => {
			state::unset_var(&mut ex.k.root, ex.cx.store, ex.vp, t.scalar().as_bytes(), true);
			Ok(())
		},
		_ if sp.readonly() => Err(Stop::Fail(Diag::Readonly { name: BString::from(name) })),
		_ => Ok(()),
	}
}
