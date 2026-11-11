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

use std::sync::LazyLock;

use bstr::{BStr, BString, ByteSlice};
use hashbrown::HashMap;
use strum::IntoEnumIterator;

use super::{
	params::{PValue, Param, PmFlags},
	text::word_list,
};
use crate::bash::{
	diag::Diag,
	ids::Platform,
	store::{Attrs, Key, KeyBuf, MiscKey, Record, Table, VarValue},
	syntax::zsh::tok::span,
	vm::{
		builtins::{zsh_mod_curses::CursesParam, zsh_mod_example::ExParam},
		expand::{Expander, Stop, X},
		state::{self, Var},
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
	/// `watch` / `WATCH` (zsh/watch).
	Watch,
}

impl Tie {
	/// Every tie.
	const ALL: [Self; 10] = [
		Self::Path,
		Self::Fpath,
		Self::Cdpath,
		Self::Manpath,
		Self::ModulePath,
		Self::Mailpath,
		Self::Psvar,
		Self::Fignore,
		Self::ZshEvalContext,
		Self::Watch,
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
			Self::Watch => "watch",
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
			Self::Watch => "WATCH",
		}
	}

	/// The separator joining the array into the scalar: `;` for the
	/// directory lists on Windows, whose paths hold `:` (`C:\…`) and whose
	/// `PATH` other programs read with `;`.
	pub const fn separator(self, platform: Platform) -> u8 {
		if matches!(platform, Platform::Windows)
			&& matches!(
				self,
				Self::Path | Self::Fpath | Self::Cdpath | Self::Manpath | Self::ModulePath
			) {
			b';'
		} else {
			b':'
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
	/// `HISTSIZE`.
	Histsize,
	/// `SAVEHIST`.
	Savehist,
	/// `histchars` and `HISTCHARS`.
	Histchars,
	/// `history` (zsh/parameter): the events by number.
	History,
	/// `historywords` (zsh/parameter): the events' words.
	Historywords,
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
	/// `functions_source`: the file each function was defined in.
	FunctionsSource,
	/// `functrace`: `caller:line` of each call on the function stack.
	Functrace,
	/// `funcsourcetrace`: `file:line` where each level was defined.
	Funcsourcetrace,
	/// `funcfiletrace`: `file:line` of each call in its file.
	Funcfiletrace,
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
	/// `jobstates`: each job's state, `state:mark:pid=state…`.
	Jobstates,
	/// `jobtexts`: each job's command text.
	Jobtexts,
	/// `jobdirs`: each job's directory.
	Jobdirs,
	/// `nameddirs`: the named directory table (writable).
	Nameddirs,
	/// `userdirs`: the users' home directories in the named directory table.
	Userdirs,
	/// `mapfile` (zsh/mapfile): file contents by name.
	Mapfile,
	/// `EPOCHSECONDS` (zsh/datetime).
	EpochSeconds,
	/// `EPOCHREALTIME` (zsh/datetime).
	EpochRealtime,
	/// `epochtime` (zsh/datetime): seconds and nanoseconds.
	Epochtime,
	/// `langinfo` (zsh/langinfo).
	Langinfo,
	/// `terminfo` (zsh/terminfo): the terminal's terminfo capabilities.
	Terminfo,
	/// `termcap` (zsh/termcap): the terminal's termcap capabilities.
	Termcap,
	/// `zsh_scheduled_events` (zsh/sched).
	ZshScheduledEvents,
	/// `errnos` (zsh/system): the platform's `errno` names.
	Errnos,
	/// `sysparams` (zsh/system): `pid`, `ppid`, `procsubstpid`.
	Sysparams,
	/// `exint`, `exstr`, `exarr` (zsh/example).
	Example(ExParam),
	/// `zcurses_colors`, `zcurses_attrs`, `zcurses_keycodes`,
	/// `zcurses_windows`, `ZCURSES_COLORS`, `ZCURSES_COLOR_PAIRS`
	/// (zsh/curses).
	Curses(CursesParam),
	/// A parameter of the line editor (`BUFFER`, `CURSOR`, …, zsh
	/// `makezleparams`) or zsh/zleparameter (`widgets`, `keymaps`).
	Zle(crate::bash::vm::zle::params::Zp),
	/// A completion special (`words`, `CURRENT`, `PREFIX`, …, `compstate`;
	/// zsh/complete's `comprparams`), present while a completion function
	/// runs.
	Comp(crate::bash::vm::zle::comp::complete::Cp),
	/// A stored variable zsh flags as special (`IFS`, `HOME`, …), by index
	/// into the plain table.
	Plain(u8),
	/// `ZSH_VERSION`, `ZSH_PATCHLEVEL`, `ZSH_NAME`, `ZSH_ARGZERO`: plain
	/// parameters with a computed default.
	Version(u8),
}

/// Plain specials (space separated, see [`word_list`]); their type flags
/// (`${(t)…}` per zsh 5.9) are [`PLAIN_FLAGS`], in the same order.
const PLAIN: &[u8] = b"IFS HOME TERM TERMINFO TERMINFO_DIRS WORDCHARS KEYBOARD_HACK LANG LC_ALL \
	LC_COLLATE LC_CTYPE LC_MESSAGES LC_NUMERIC LC_TIME COLUMNS LINES SHLVL FUNCNEST OPTIND OPTARG \
	NULLCMD READNULLCMD SPROMPT";

/// The type flags of the [`PLAIN`] specials.
const PLAIN_FLAGS: [PmFlags; 23] = [
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
const PROMPTS: &[u8] =
	b"PS1 PS2 PS3 PS4 RPS1 RPS2 prompt PROMPT PROMPT2 PROMPT3 PROMPT4 RPROMPT RPROMPT2";

/// The specials zsh leaves out when it starts emulating sh or ksh
/// (`params.c` `special_params` past its first terminator).
const ZSH_START_ONLY: &[u8] = b"ARGC HISTCHARS status prompt PROMPT PROMPT2 PROMPT3 PROMPT4 RPROMPT RPROMPT2 \
	MANPATH manpath argv fignore cdpath fpath mailpath psvar zsh_eval_context module_path path pipestatus";

/// [`lookup`]'s answer `sp` for `name` as the shell started: started as sh
/// or ksh ([`MiscKey::ZshStartedSh`]) the zsh-only specials are ordinary
/// names and the colon-array scalars (`PATH`, …) are untied scalar
/// specials (`special_params_sh`).
///
/// # Errors
/// [`Stop::Store`] when the store fails.
pub fn as_started(
	ex: &mut Expander<'_, '_>,
	sp: Option<Special>,
	name: &[u8],
) -> X<Option<Special>> {
	let Some(s) = sp else {
		return Ok(None);
	};
	let affected =
		matches!(s, Special::TiedScalar(_)) || word_list(ZSH_START_ONLY).any(|n| n == name);
	if !affected
		|| !matches!(
			state::record(ex.cx.store, ex.vp, Key::Misc(MiscKey::ZshStartedSh))?,
			Some(Record::Misc(_))
		) {
		return Ok(sp);
	}
	Ok(match s {
		Special::TiedScalar(_) if name != b"MANPATH" => Some(Special::Plain(u8::MAX)),
		_ => None,
	})
}

/// The prompt specials that share one value (`params.c`: the `IPDEF7`
/// entries `PS1`, `prompt` and `PROMPT` all point at `prompt`, …), the
/// startup name first.
pub const PROMPT_GROUPS: [&[&[u8]]; 6] = [
	&[b"PS1", b"PROMPT", b"prompt"],
	&[b"PS2", b"PROMPT2"],
	&[b"PS3", b"PROMPT3"],
	&[b"PS4", b"PROMPT4"],
	&[b"RPS1", b"RPROMPT"],
	&[b"RPS2", b"RPROMPT2"],
];

/// The prompt specials sharing `name`'s value ([`PROMPT_GROUPS`]),
/// `name` included; empty for any other name.
pub fn prompt_group(name: &[u8]) -> &'static [&'static [u8]] {
	PROMPT_GROUPS
		.iter()
		.find(|g| g.contains(&name))
		.copied()
		.unwrap_or_default()
}

/// The parameters with a computed default, space separated.
const VERSION: &[u8] = b"ZSH_VERSION ZSH_PATCHLEVEL ZSH_NAME ZSH_ARGZERO";

/// Every computed or tied special name, space separated
/// ([`super::params::scan_names`] lists them).
pub const NAMES: &[u8] = b"argv * @ # ARGC ? status $ ! - 0 _ LINENO PPID RANDOM SECONDS HISTCMD \
	HISTSIZE SAVEHIST histchars HISTCHARS history historywords \
	UID EUID GID EGID USERNAME TTYIDLE ZSH_SUBSHELL pipestatus funcstack dirstack TRY_BLOCK_ERROR \
	TRY_BLOCK_INTERRUPT path fpath cdpath manpath module_path mailpath psvar fignore \
	zsh_eval_context ZSH_EVAL_CONTEXT options functions functions_source functrace funcsourcetrace funcfiletrace aliases galiases saliases commands \
	parameters builtins modules jobstates jobtexts jobdirs nameddirs userdirs mapfile EPOCHSECONDS EPOCHREALTIME epochtime langinfo terminfo termcap zsh_scheduled_events errnos sysparams exint exstr exarr zcurses_colors zcurses_attrs zcurses_keycodes zcurses_windows ZCURSES_COLORS ZCURSES_COLOR_PAIRS watch WATCH ZSH_VERSION ZSH_PATCHLEVEL ZSH_NAME ZSH_ARGZERO";

/// [`scan`]'s answers for every name it knows ([`NAMES`], the tie
/// scalars, [`PLAIN`], [`PROMPTS`], [`VERSION`], the ZLE and completion
/// specials): every variable access asks [`lookup`], and most names are
/// not special.
static TABLE: LazyLock<HashMap<&'static [u8], Special>> = LazyLock::new(|| {
	word_list(NAMES)
		.chain(
			Tie::ALL
				.iter()
				.flat_map(|t| [t.array().as_bytes(), t.scalar().as_bytes()]),
		)
		.chain(word_list(PLAIN))
		.chain(word_list(PROMPTS))
		.chain(word_list(VERSION))
		.chain(crate::bash::vm::zle::params::NAMES.iter().copied())
		.chain(crate::bash::vm::zle::comp::complete::NAMES.iter().copied())
		.filter_map(|name| scan(name).map(|sp| (name, sp)))
		.collect()
});

/// The special `name` names in zsh dialect.
pub fn lookup(name: &[u8]) -> Option<Special> {
	let found = TABLE.get(name).copied();
	debug_assert_eq!(
		found,
		scan(name),
		"`{}` is special but missing from the names TABLE is built from",
		BStr::new(name)
	);
	found
}

/// The special `name` names in zsh dialect, by its definition (see
/// [`TABLE`]).
fn scan(name: &[u8]) -> Option<Special> {
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
		b"HISTSIZE" => Special::Histsize,
		b"SAVEHIST" => Special::Savehist,
		b"histchars" | b"HISTCHARS" => Special::Histchars,
		b"history" => Special::History,
		b"historywords" => Special::Historywords,
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
		b"functions_source" => Special::FunctionsSource,
		b"functrace" => Special::Functrace,
		b"funcsourcetrace" => Special::Funcsourcetrace,
		b"funcfiletrace" => Special::Funcfiletrace,
		b"aliases" => Special::Aliases,
		b"galiases" => Special::Galiases,
		b"saliases" => Special::Saliases,
		b"commands" => Special::Commands,
		b"parameters" => Special::Parameters,
		b"builtins" => Special::Builtins,
		b"modules" => Special::Modules,
		b"jobstates" => Special::Jobstates,
		b"jobtexts" => Special::Jobtexts,
		b"jobdirs" => Special::Jobdirs,
		b"nameddirs" => Special::Nameddirs,
		b"userdirs" => Special::Userdirs,
		b"mapfile" => Special::Mapfile,
		b"EPOCHSECONDS" => Special::EpochSeconds,
		b"EPOCHREALTIME" => Special::EpochRealtime,
		b"epochtime" => Special::Epochtime,
		b"langinfo" => Special::Langinfo,
		b"terminfo" => Special::Terminfo,
		b"termcap" => Special::Termcap,
		b"zsh_scheduled_events" => Special::ZshScheduledEvents,
		b"errnos" => Special::Errnos,
		b"sysparams" => Special::Sysparams,
		b"exint" => Special::Example(ExParam::Int),
		b"exstr" => Special::Example(ExParam::Str),
		b"exarr" => Special::Example(ExParam::Arr),
		b"zcurses_colors"
		| b"zcurses_attrs"
		| b"zcurses_keycodes"
		| b"zcurses_windows"
		| b"ZCURSES_COLORS"
		| b"ZCURSES_COLOR_PAIRS" => Special::Curses(CursesParam::lookup(name)?),
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
			if let Some(z) = crate::bash::vm::zle::params::lookup(name) {
				return Some(Special::Zle(z));
			}
			if let Some(c) = crate::bash::vm::zle::comp::complete::lookup(name) {
				return Some(Special::Comp(c));
			}
			return None;
		},
	})
}

impl Special {
	/// The module whose `p:NAME` feature this special is: it exists only
	/// while the module provides it, or loads the module when used
	/// (`PM_AUTOLOAD`); see
	/// [`zsh_module::param_present`](crate::bash::vm::builtins::zsh_module::param_present).
	pub const fn module(self) -> Option<&'static str> {
		match self {
			Self::Funcstack
			| Self::Dirstack
			| Self::Options
			| Self::Functions
			| Self::FunctionsSource
			| Self::Functrace
			| Self::Funcsourcetrace
			| Self::Funcfiletrace
			| Self::Aliases
			| Self::Galiases
			| Self::Saliases
			| Self::Commands
			| Self::Parameters
			| Self::Builtins
			| Self::Modules
			| Self::Jobstates
			| Self::Jobtexts
			| Self::Jobdirs
			| Self::Nameddirs
			| Self::Userdirs
			| Self::History
			| Self::Historywords => Some("zsh/parameter"),
			Self::Mapfile => Some("zsh/mapfile"),
			Self::EpochSeconds | Self::EpochRealtime | Self::Epochtime => Some("zsh/datetime"),
			Self::Langinfo => Some("zsh/langinfo"),
			Self::Terminfo => Some("zsh/terminfo"),
			Self::Termcap => Some("zsh/termcap"),
			Self::ZshScheduledEvents => Some("zsh/sched"),
			Self::Errnos | Self::Sysparams => Some("zsh/system"),
			Self::Example(_) => Some("zsh/example"),
			Self::Curses(_) => Some("zsh/curses"),
			Self::Zle(z) => z.module(),
			Self::Comp(_) => None,
			Self::TiedArray(Tie::Watch) | Self::TiedScalar(Tie::Watch) => Some("zsh/watch"),
			_ => None,
		}
	}

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
			Self::Zero | Self::Underscore | Self::Username | Self::Histchars => 0,
			Self::Histsize | Self::Savehist => PmFlags::INTEGER.0,
			Self::History => PmFlags::HASHED.0 | RO.0 | HH.0,
			Self::Historywords => PmFlags::ARRAY.0 | RO.0 | HH.0,
			Self::Funcstack => PmFlags::ARRAY.0 | RO.0 | HH.0,
			Self::FunctionsSource => PmFlags::HASHED.0 | RO.0 | HH.0,
			Self::Functrace | Self::Funcsourcetrace | Self::Funcfiletrace => {
				PmFlags::ARRAY.0 | RO.0 | HH.0
			},
			Self::Dirstack => PmFlags::ARRAY.0 | HH.0,
			// zsh/watch does not flag its pair `PM_TIED` (`${(t)watch}` is
			// `array-special`).
			Self::TiedArray(Tie::Watch) => PmFlags::ARRAY.0,
			Self::TiedScalar(Tie::Watch) => 0,
			Self::TiedArray(Tie::ZshEvalContext) => PmFlags::ARRAY.0 | RO.0 | PmFlags::TIED.0,
			Self::TiedArray(_) => PmFlags::ARRAY.0 | PmFlags::TIED.0,
			Self::TiedScalar(Tie::ZshEvalContext) => RO.0 | PmFlags::TIED.0,
			Self::TiedScalar(_) => PmFlags::TIED.0,
			Self::Options
			| Self::Functions
			| Self::Aliases
			| Self::Galiases
			| Self::Saliases
			| Self::Commands
			| Self::Nameddirs
			| Self::Mapfile => PmFlags::HASHED.0 | HH.0,
			Self::Langinfo => PmFlags::HASHED.0 | HH.0,
			Self::Terminfo | Self::Termcap => PmFlags::HASHED.0 | RO.0 | HH.0,
			Self::ZshScheduledEvents => PmFlags::ARRAY.0 | RO.0 | HH.0,
			Self::Errnos => PmFlags::ARRAY.0 | RO.0 | HH.0,
			Self::Sysparams => PmFlags::HASHED.0 | RO.0 | HH.0,
			Self::Curses(p) if p.integer() => PmFlags::INTEGER.0 | RO.0 | HH.0,
			Self::Curses(_) => PmFlags::ARRAY.0 | RO.0 | HH.0,
			Self::Zle(z) => z.flags().0,
			// zsh/complete's are plain `PM_READONLY` (`QIPREFIX`).
			Self::Comp(c) => return PmFlags(c.flags().0 | S.0),
			// zsh/example's parameters are not special (`PARAMDEF`s).
			Self::Example(p) => {
				return match p {
					ExParam::Int => PmFlags::INTEGER,
					ExParam::Str => PmFlags::SCALAR,
					ExParam::Arr => PmFlags::ARRAY,
				};
			},
			Self::EpochSeconds => PmFlags::INTEGER.0 | RO.0 | HH.0,
			Self::EpochRealtime => PmFlags::FFLOAT.0 | RO.0 | HH.0,
			Self::Epochtime => PmFlags::ARRAY.0 | RO.0 | HH.0,
			Self::Parameters
			| Self::Builtins
			| Self::Modules
			| Self::Jobstates
			| Self::Jobtexts
			| Self::Jobdirs
			| Self::Userdirs => PmFlags::HASHED.0 | RO.0 | HH.0,
			Self::Plain(i) => {
				if (i as usize) < PLAIN_FLAGS.len() {
					PLAIN_FLAGS[i as usize].0
				} else {
					0
				}
			},
			Self::Version(_) => return PmFlags::SCALAR,
		};
		// zsh's built-in read-only specials are all `PM_READONLY_SPECIAL`;
		// zsh/datetime's are plain `PM_READONLY` (`typeset -p` lists them).
		let module_ro = matches!(self, Self::EpochSeconds | Self::EpochRealtime | Self::Epochtime);
		let f = if f & RO.0 != 0 && !module_ro {
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

	/// Whether one key is read without computing the whole association
	/// ([`get_elem`]): zsh/parameter's tables whose scan is costly
	/// (regenerated function bodies, the type of every parameter, the
	/// command hash, the history) and the modules' tables answered per
	/// name. Shell plugins test them per key in every prompt.
	pub const fn keyed(self) -> bool {
		matches!(
			self,
			Self::Functions
				| Self::FunctionsSource
				| Self::Parameters
				| Self::Commands
				| Self::History
				| Self::Mapfile
				| Self::Terminfo
				| Self::Termcap
		)
	}

	/// Whether a stored variable named `name` is its own value (not a bash
	/// variable it shadows). A stored `_` (imported from the environment,
	/// or bash's own `$_`) is no bash value zsh code loses: zsh ignores it.
	pub const fn is_backed_by(self, _name: &[u8]) -> bool {
		// An imported `HISTSIZE`/`SAVEHIST` is the special's initial value;
		// `USERNAME` (always in a Windows environment, kept for the programs
		// the shell runs) names the user the special does.
		self.is_plain()
			|| matches!(self, Self::Underscore | Self::Histsize | Self::Savehist | Self::Username)
	}

	/// The built-in tie partner and separator.
	pub const fn tie_partner(self, platform: Platform) -> Option<(&'static str, u8)> {
		match self {
			Self::TiedScalar(t) => Some((t.array(), t.separator(platform))),
			Self::TiedArray(t) => Some((t.scalar(), t.separator(platform))),
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
	let base = if sp == Special::Seconds {
		let (ty, b) = seconds_type(ex)?;
		flags = flags.without(PmFlags::INTEGER).with(ty);
		b
	} else {
		0
	};
	let value = value.unwrap_or_else(|| {
		flags = flags.with(PmFlags::UNSET);
		match flags.type_bits() {
			PmFlags::ARRAY => PValue::Array(Vec::new()),
			PmFlags::HASHED => PValue::Hash(Vec::new()),
			_ => PValue::Scalar(BString::default()),
		}
	});
	let mut p = Param::special(name, flags, value, sp, ex.k.engine.config().platform);
	p.base = base;
	if let Special::Comp(cp) = sp {
		// zsh/complete's are locals of the completion function
		// (`makecompparams` at its level); `CURRENT` has base 10.
		let nested = crate::bash::vm::zle::comp::comp(ex.vp)
			.map_or(0, |c| c.complete.wraps.len().saturating_sub(1));
		p.scope =
			state::func_scope(&ex.k.root, ex.cx.store, ex.vp)?.map(|s| s.saturating_sub(nested));
		if cp == crate::bash::vm::zle::comp::complete::Cp::Current {
			p.base = 10;
		}
	}
	Ok(p)
}

/// zsh `typeset_single`'s `newspecial` for a computed special: `local
/// NAME` in scope `scope` keeps `NAME` the special itself. Its value now
/// (for `SECONDS` the clock start and type) is kept in the scope's
/// binding of `NAME` ([`Attrs::ZSH_LOCAL_SPECIAL`]) and comes back when
/// the scope ends ([`restore_locals`]).
///
/// # Errors
/// Outside a zsh function scope (nothing would restore it); a store
/// failure.
pub fn make_local(ex: &mut Expander<'_, '_>, sp: Special, name: &[u8], scope: usize) -> X<()> {
	// The line editor's and completion's specials are `PM_REMOVABLE`:
	// `scanendscope` only unsets the local, which their unset functions
	// ignore, so the value set in the function stays.
	if matches!(sp, Special::Zle(_) | Special::Comp(_)) {
		let var = Var { attrs: Attrs::ZSH_LOCAL_SPECIAL, value: VarValue::Str(BString::default()) };
		state::scope_set(&mut ex.k.root, ex.cx.store, ex.vp, scope, name, Some(var));
		return Ok(());
	}
	let Some(mut z) = state::scope_zsh(ex.cx.store, ex.vp, scope)? else {
		return Err(Stop::Fail(Diag::Unsupported {
			what: format!("local zsh special `{}' outside a zsh function", bstr::BStr::new(name))
				.into(),
		}));
	};
	let mut attrs = Attrs::ZSH_LOCAL_SPECIAL;
	let value = if sp == Special::Seconds {
		let (ty, base) = seconds_type(ex)?;
		let c = match ty {
			PmFlags::EFLOAT => 'E',
			PmFlags::FFLOAT => 'F',
			_ => 'i',
		};
		VarValue::Str(BString::from(format!("{}:{c}{base}", ex.k.start_ns)))
	} else {
		match get(ex, sp)? {
			Some(PValue::Scalar(s)) => VarValue::Str(s),
			Some(PValue::Array(a)) => super::params::indexed(a),
			Some(PValue::Hash(h)) => VarValue::Assoc(h.into()),
			None => {
				attrs = attrs.with(Attrs::INVISIBLE);
				VarValue::Str(BString::default())
			},
		}
	};
	state::scope_set(&mut ex.k.root, ex.cx.store, ex.vp, scope, name, Some(Var { attrs, value }));
	if !z.specials.iter().any(|n| n == name) {
		z.specials.push(BString::from(name));
		state::set_scope_zsh(&mut ex.k.root, ex.cx.store, ex.vp, scope, Some(z));
	}
	Ok(())
}

/// zsh `scanendscope` as the innermost scope (a zsh function's) ends: the
/// computed specials made local in it ([`make_local`]) get their values
/// from before back through their set functions, whose own complaints
/// are not reported (zsh's have none at that point).
///
/// # Errors
/// A store failure.
pub fn restore_locals(ex: &mut Expander<'_, '_>) -> X<()> {
	let Some(top) = state::scope_count(&ex.k.root, ex.vp).checked_sub(1) else {
		return Ok(());
	};
	let Some(z) = state::scope_zsh(ex.cx.store, ex.vp, top)? else {
		return Ok(());
	};
	for name in &z.specials {
		let Some(Some(var)) = state::scope_var(ex.cx.store, ex.vp, top, name)? else {
			continue;
		};
		let Some(sp) = lookup(name).filter(|_| var.attrs.contains(Attrs::ZSH_LOCAL_SPECIAL)) else {
			continue;
		};
		let res = if sp == Special::Seconds {
			let text = var.as_scalar().unwrap_or_default();
			let (start, ty) = text.split_once_str(":").unwrap_or((text, &b"i"[..]));
			if let Some(start) = std::str::from_utf8(start).ok().and_then(|s| s.parse().ok()) {
				ex.k.start_ns = start;
				ex.k
					.root
					.set_misc(ex.cx.store, MiscKey::StartNs, num(start));
			}
			let flags = match ty.first() {
				Some(b'E') => PmFlags::EFLOAT,
				Some(b'F') => PmFlags::FFLOAT,
				_ => PmFlags::INTEGER,
			};
			let base = std::str::from_utf8(ty.get(1..).unwrap_or_default())
				.ok()
				.and_then(|s| s.parse().ok())
				.unwrap_or(0);
			set_seconds_type(ex, flags, base);
			Ok(())
		} else if var.attrs.contains(Attrs::INVISIBLE) {
			unset(ex, sp, name)
		} else {
			let value = match var.value {
				VarValue::Str(s) => PValue::Scalar(s),
				VarValue::Indexed(items) => {
					PValue::Array(items.iter().map(|(_, v)| v.clone()).collect())
				},
				VarValue::Assoc(items) => PValue::Hash(items.to_vec()),
			};
			set(ex, sp, name, value)
		};
		if let Err(Stop::Store(e)) = res {
			return Err(Stop::Store(e));
		}
	}
	Ok(())
}

/// The type `typeset` gave `SECONDS` (zsh `setsecondstype`;
/// [`MiscKey::ZshSecondsType`]): [`PmFlags::INTEGER`], `EFLOAT` or
/// `FFLOAT`, and the base or precision (0: the default).
///
/// # Errors
/// [`Stop::Store`] when the store fails.
pub fn seconds_type(ex: &mut Expander<'_, '_>) -> X<(PmFlags, u8)> {
	Ok(match state::record(ex.cx.store, ex.vp, Key::Misc(MiscKey::ZshSecondsType))? {
		Some(Record::Misc(v)) => {
			let ty = match v.first() {
				Some(b'E') => PmFlags::EFLOAT,
				Some(b'F') => PmFlags::FFLOAT,
				_ => PmFlags::INTEGER,
			};
			let base = std::str::from_utf8(v.get(1..).unwrap_or_default())
				.ok()
				.and_then(|s| s.parse().ok())
				.unwrap_or(0);
			(ty, base)
		},
		_ => (PmFlags::INTEGER, 0),
	})
}

/// zsh `setsecondstype`: `SECONDS` counts as `ty` from now on, shown with
/// base or precision `base`. `false` (nothing changed) when `ty` is not
/// one of the numeric types.
pub fn set_seconds_type(ex: &mut Expander<'_, '_>, ty: PmFlags, base: u8) -> bool {
	let c = match ty {
		PmFlags::INTEGER => 'i',
		PmFlags::EFLOAT => 'E',
		PmFlags::FFLOAT => 'F',
		_ => return false,
	};
	let rec = (c != 'i' || !matches!(base, 0 | 10))
		.then(|| Record::Misc(BString::from(format!("{c}{base}"))));
	state::store_record(
		&mut ex.k.root,
		ex.cx.store,
		ex.vp,
		KeyBuf::Misc(MiscKey::ZshSecondsType),
		rec,
	);
	true
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
			// outwards. A `.` file run under FUNCTION_ARGZERO names itself
			// while no call is nearer (zsh `bin_dot`).
			if let Some(file) = crate::bash::vm::callstack::source_argzero(ex.vp) {
				return scalar(file.clone());
			}
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
			// Wrapping: an assignment may put the start before the host
			// clock's origin (or after it: a negative value).
			let ns = ex.cx.host.now_ns().wrapping_sub(ex.k.start_ns) as i64;
			let (ty, base) = seconds_type(ex)?;
			if ty == PmFlags::INTEGER {
				let secs = ns.div_euclid(1_000_000_000);
				if matches!(base, 0 | 10) {
					return scalar(num(secs));
				}
				let o = super::arith::math_options(ex)?;
				return scalar(BString::from(super::math::convbase(secs, i32::from(base), o)));
			}
			// zsh `floatsecondsgetfn`.
			let d = ns as f64 / 1e9;
			let kind = if ty == PmFlags::EFLOAT {
				super::math::FloatKind::Exponent
			} else {
				super::math::FloatKind::Fixed
			};
			scalar(BString::from(super::math::convfloat(d, i32::from(base), kind)))
		},
		Special::Histcmd => {
			let n = crate::bash::vm::builtins::history::zsh::curhist(&ex.k.root, ex.cx.store, ex.vp)?;
			scalar(num(n))
		},
		Special::Histsize | Special::Savehist => {
			let save = sp == Special::Savehist;
			let v = crate::bash::vm::builtins::history::zsh::size_param(
				&mut ex.k.root,
				ex.cx.store,
				ex.vp,
				save,
			)?;
			Ok(v.map(|v| PValue::Scalar(num(v))))
		},
		Special::Histchars => scalar(crate::bash::vm::builtins::history::zsh::histchars_param(
			&ex.k.root,
			ex.cx.store,
			ex.vp,
		)?),
		Special::History => Ok(Some(PValue::Hash(
			crate::bash::vm::builtins::history::zsh::history_param(&ex.k.root, ex.cx.store, ex.vp)?,
		))),
		Special::Historywords => {
			Ok(Some(PValue::Array(crate::bash::vm::builtins::history::zsh::historywords_param(
				&ex.k.root,
				ex.cx.store,
				ex.vp,
			)?)))
		},
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
		Special::ZshScheduledEvents => Ok(Some(PValue::Array(
			crate::bash::vm::builtins::zsh_mod_sched::scheduled_events(ex.cx.store, ex.vp)?,
		))),
		Special::Example(p) => crate::bash::vm::builtins::zsh_mod_example::param_get(ex, p),
		Special::Curses(p) => Ok(Some(crate::bash::vm::builtins::zsh_mod_curses::param_get(ex, p))),
		Special::Zle(z) => Ok(crate::bash::vm::zle::params::get(ex, z)),
		Special::Comp(c) => Ok(crate::bash::vm::zle::comp::complete::get(ex, c)),
		Special::TiedArray(Tie::ZshEvalContext) => Ok(Some(PValue::Array(eval_context(ex.vp)))),
		Special::TiedScalar(Tie::ZshEvalContext) => {
			scalar(BString::from(eval_context(ex.vp).join(&b":"[..])))
		},
		Special::TiedArray(t) => {
			// The array side is unset with its scalar (`unset MANPATH`).
			let Some(v) = state::lookup(&ex.k.root, ex.cx.store, ex.vp, t.scalar().as_bytes())? else {
				return Ok(None);
			};
			let sep = t.separator(ex.k.engine.config().platform);
			Ok(Some(PValue::Array(match v.as_scalar() {
				Some(s) if !s.is_empty() => s.split(|&c| c == sep).map(BString::from).collect(),
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
			let engine = &ex.k.engine;
			Ok(Some(PValue::Hash(
				recs
					.into_iter()
					.filter_map(|(k, r)| match (k, r) {
						(KeyBuf::Func(n), Record::Func { source, .. }) => {
							Some((n, engine.function_body(&source, func_body)))
						},
						_ => None,
					})
					.collect(),
			)))
		},
		// zsh/parameter `functracegetfn`, `funcsourcetracegetfn`,
		// `funcfiletracegetfn`: one `file:line` pair per level of the
		// function stack, innermost first ([`funcstack_levels`]).
		Special::Functrace | Special::Funcsourcetrace | Special::Funcfiletrace => {
			let levels = funcstack_levels(ex);
			let pair = |mut name: BString, line: u32| {
				name.push(b':');
				name.extend_from_slice(line.to_string().as_bytes());
				name
			};
			let mut out = Vec::with_capacity(levels.len());
			for (i, l) in levels.iter().enumerate().rev() {
				out.push(match sp {
					Special::Functrace => pair(l.caller.clone(), l.line),
					Special::Funcsourcetrace => pair(l.file.clone(), l.flineno),
					// Called from a function: the line in the file that
					// function came from; from a file: as `$functrace`.
					_ => match i.checked_sub(1).map(|j| &levels[j]) {
						Some(p) if !p.source => pair(p.file.clone(), p.flineno + l.line),
						_ => pair(l.caller.clone(), l.line),
					},
				});
			}
			Ok(Some(PValue::Array(out)))
		},
		// zsh/parameter `getfunctionsource`: the file it was defined in.
		Special::FunctionsSource => {
			let recs = state::scan(&ex.k.root, ex.cx.store, ex.vp, Table::Func)?;
			Ok(Some(PValue::Hash(
				recs
					.into_iter()
					.filter_map(|(k, r)| match (k, r) {
						(KeyBuf::Func(n), Record::Func { file, attrs, .. }) => {
							let src = function_source(&n, file, attrs);
							Some((n, src))
						},
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
			// zsh `scanpmcommands`/`getpmcommand`: under `HASH_LIST_ALL`
			// the table is filled first.
			if state::zsh_option(&mut ex.k.root, ex.cx.store, ex.vp, ZshOpt::Hashlistall)? {
				fill_cmdnamtab(ex)?;
			}
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
		// zsh's scanpmparameters reads types, never values.
		Special::Parameters => {
			let names = super::params::scan_names(ex)?;
			let mut out = Vec::with_capacity(names.len());
			for n in names {
				if let Some(ty) = parameter_type(ex, &n)? {
					out.push((n, ty));
				}
			}
			Ok(Some(PValue::Hash(out)))
		},
		Special::Builtins => Ok(Some(PValue::Hash(
			crate::bash::vm::builtins::zsh_module::builtins_param(ex.cx.store, ex.vp)?,
		))),
		Special::Modules => Ok(Some(PValue::Hash(
			crate::bash::vm::builtins::zsh_module::modules_param(ex.cx.store, ex.vp)?,
		))),
		Special::Jobstates | Special::Jobtexts | Special::Jobdirs => {
			let platform = ex.k.engine.config().platform;
			let jobbing = crate::bash::vm::jobctl::jobbing(ex.k, ex.cx);
			Ok(Some(PValue::Hash(crate::bash::vm::builtins::zsh_jobs::job_params(
				ex.vp, sp, jobbing, platform,
			))))
		},
		Special::Nameddirs | Special::Userdirs => {
			let users = sp == Special::Userdirs;
			if users {
				super::nameddir::fill(ex)?;
			}
			let t = super::nameddir::load(ex)?;
			Ok(Some(PValue::Hash(
				t.entries()
					.filter(|e| (e.flags & super::nameddir::ND_USERNAME != 0) == users)
					.map(|e| (BString::from(e.name), BString::from(e.dir)))
					.collect(),
			)))
		},
		Special::Mapfile => crate::bash::vm::builtins::zsh_mod_mapfile::scan(ex),
		Special::Langinfo => crate::bash::vm::builtins::zsh_mod_langinfo::scan(ex),
		Special::Terminfo => crate::bash::vm::builtins::zsh_mod_terminfo::scan(ex),
		Special::Termcap => crate::bash::vm::builtins::zsh_mod_termcap::scan(ex),
		Special::Errnos => {
			Ok(Some(PValue::Array(crate::bash::vm::builtins::zsh_mod_system::errnos())))
		},
		Special::Sysparams => {
			Ok(Some(PValue::Hash(crate::bash::vm::builtins::zsh_mod_system::sysparams(ex)?)))
		},
		Special::EpochSeconds => scalar(num(ex.cx.host.wall().secs)),
		Special::EpochRealtime => {
			let now = ex.cx.host.wall();
			scalar(BString::from(format!(
				"{:.10}",
				f64::mul_add(f64::from(now.nanos), 1e-9, now.secs as f64)
			)))
		},
		Special::Epochtime => {
			let now = ex.cx.host.wall();
			Ok(Some(PValue::Array(vec![num(now.secs), num(now.nanos)])))
		},
		Special::Version(_) => Ok(sp.default(ex).map(PValue::Scalar)),
		Special::Plain(_) | Special::TiedScalar(_) => Ok(None),
	}
}

/// One key of a keyed special ([`Special::keyed`]), as zsh/parameter's
/// `getnode` functions answer it (`None`: no such key) without the scan
/// [`get`] does.
///
/// # Errors
/// [`Stop::Store`] when the state cannot be read.
pub fn get_elem(ex: &mut Expander<'_, '_>, sp: Special, key: &[u8]) -> X<Option<BString>> {
	match sp {
		Special::Functions => match state::record(ex.cx.store, ex.vp, Key::Func(key.as_bstr()))? {
			Some(Record::Func { source, .. }) => {
				Ok(Some(ex.k.engine.function_body(source, func_body)))
			},
			_ => Ok(None),
		},
		Special::FunctionsSource => {
			match state::record(ex.cx.store, ex.vp, Key::Func(key.as_bstr()))? {
				Some(Record::Func { file, attrs, .. }) => {
					Ok(Some(function_source(key, file.clone(), *attrs)))
				},
				_ => Ok(None),
			}
		},
		Special::Parameters => parameter_type(ex, key),
		// zsh `getpmcommand`: an unhashed name fills the table first under
		// `HASH_LIST_ALL`.
		Special::Commands => {
			let hashed = |ex: &mut Expander<'_, '_>| -> X<Option<BString>> {
				Ok(match state::record(ex.cx.store, ex.vp, Key::CmdHash(key.as_bstr()))? {
					Some(Record::CmdHash { path, .. }) => Some(path.clone()),
					_ => None,
				})
			};
			if let Some(path) = hashed(ex)? {
				return Ok(Some(path));
			}
			if !state::zsh_option(&mut ex.k.root, ex.cx.store, ex.vp, ZshOpt::Hashlistall)? {
				return Ok(None);
			}
			fill_cmdnamtab(ex)?;
			hashed(ex)
		},
		// zsh/parameter's `getpmhistory`: any event, the latest too.
		Special::History => Ok(crate::bash::vm::builtins::history::zsh::history_elem(
			&ex.k.root,
			ex.cx.store,
			ex.vp,
			key,
		)?),
		// zsh/mapfile's `getpmmapfile` reads the file itself.
		Special::Mapfile => crate::bash::vm::builtins::zsh_mod_mapfile::get(ex, key),
		// `getterminfo` / `gettermcap` answer names the scan omits
		// (extended capabilities, unset booleans of termcap).
		Special::Terminfo => crate::bash::vm::builtins::zsh_mod_terminfo::get(ex, key),
		Special::Termcap => crate::bash::vm::builtins::zsh_mod_termcap::get(ex, key),
		_ => Ok(match get(ex, sp)? {
			Some(PValue::Hash(h)) => h.into_iter().find(|(k, _)| k == key).map(|(_, v)| v),
			_ => None,
		}),
	}
}

/// zsh/parameter `getfunctionsource` for the function `name` defined in
/// `file`: an autoload stub of `autoload /dir/name` (`PM_LOADDIR`) is in
/// `dir/name`.
fn function_source(name: &[u8], file: BString, attrs: Attrs) -> BString {
	if attrs.contains(Attrs::ZSH_UNDEFINED) && !file.is_empty() {
		let mut p = file;
		p.push(b'/');
		p.extend_from_slice(name);
		p
	} else {
		file
	}
}

/// zsh/parameter `getpmparameter`: the type of the set parameter `name`
/// (its value is never computed).
fn parameter_type(ex: &mut Expander<'_, '_>, name: &[u8]) -> X<Option<BString>> {
	Ok(super::params::getparam_type(ex, name)?
		.filter(super::params::Param::is_set)
		.map(|p| p.type_name()))
}

/// zsh `zsh_eval_context`: `toplevel` (`cmdarg` while the root shell runs a
/// `-c` string, or the context a subshell started in), then one word per
/// function call (`shfunc`), `eval`, sourced file
/// (`file`), trap (`trap`) and command substitution (`cmdsubst`) on the
/// vproc's stack, outermost first. `child_running` keeps it for a child.
pub fn eval_context(vp: &crate::bash::vm::proc::Vproc) -> Vec<BString> {
	use crate::bash::vm::proc::{FrameKind, ScriptKind};
	let mut out = match vp.zsh.as_deref() {
		Some(z) if !z.context.is_empty() => z.context.clone(),
		_ if vp.parent.is_none()
			&& vp.runs.front().is_some_and(|r| {
				matches!(r.chain.links[0].origin, crate::bash::event::Origin::Command)
			}) =>
		{
			vec![BString::from("cmdarg")]
		},
		_ => vec![BString::from("toplevel")],
	};
	for (i, f) in vp.frames.iter().enumerate() {
		let word = match &f.kind {
			FrameKind::Function { autoload, .. } => {
				out.push(BString::from("shfunc"));
				if *autoload {
					out.push(BString::from("loadautofunc"));
				}
				continue;
			},
			FrameKind::Script { what: ScriptKind::Eval, .. } if i == 0 && vp.parent.is_some() => {
				// A `zpty` command names its own context.
				if let Some(word) = vp.zsh.as_deref().and_then(|z| z.first_context.as_ref()) {
					out.push(word.clone());
					continue;
				}
				"cmdsubst"
			},
			FrameKind::Script { what: ScriptKind::Eval, .. } => "eval",
			FrameKind::Script { what: ScriptKind::Source, .. } => "file",
			FrameKind::Script { what: ScriptKind::Trap { .. }, .. } => "trap",
			FrameKind::Script { what: ScriptKind::Code(c), .. } => c.context(),
			_ => continue,
		};
		out.push(BString::from(word));
	}
	out
}

/// zsh `fillcmdnamtable` (`hashdir` of each directory of `$path` not
/// checked yet): every entry of every absolute directory of `$PATH`
/// (only executable plain files under `HASH_EXECUTABLES_ONLY`) not in the
/// command table yet goes in as `DIR/NAME`, the first directory winning.
/// Done once per `PATH` until the table is emptied
/// ([`MiscKey::ZshPathChecked`]); directories are listed through the
/// replay log. New entries are committed only after all probes finish,
/// so a replay consumes the same answers in the same order.
///
/// # Errors
/// A parked probe, a store failure.
pub fn fill_cmdnamtab(ex: &mut Expander<'_, '_>) -> X<()> {
	use crate::bash::vm::{
		fsprobe::FsReq,
		proc::{Atom, Probe},
	};
	let path = state::lookup(&ex.k.root, ex.cx.store, ex.vp, b"PATH")?
		.and_then(|v| v.as_scalar().map(BString::from))
		.unwrap_or_default();
	if matches!(
		state::record(ex.cx.store, ex.vp, Key::Misc(MiscKey::ZshPathChecked))?,
		Some(Record::Misc(p)) if *p == path
	) {
		return Ok(());
	}
	let exec_only =
		state::zsh_option(&mut ex.k.root, ex.cx.store, ex.vp, ZshOpt::Hashexecutablesonly)?;
	// The next logged answer, or the probe that gets it.
	let ask = |ex: &mut Expander<'_, '_>, probe: Probe| -> X<Atom> {
		if let Some(atom) = ex.log.get(ex.cursor).cloned() {
			ex.cursor += 1;
			return Ok(atom);
		}
		Err(Stop::Probe(probe))
	};
	let platform = ex.k.engine.config().platform;
	let windows = platform == Platform::Windows;
	// Every directory's listing is asked first, and the table is built only
	// once all are answered: each answer re-runs the expansion, which
	// otherwise rebuilt the names of every directory listed before it.
	let mut lists: Vec<(&[u8], usize)> = Vec::new();
	for dir in path.split(|&c| c == crate::bash::vm::probe::path_separator(platform)) {
		// zsh `isrelative`: not absolute, or with a `.` or `..` component.
		let absolute = dir.first() == Some(&b'/')
			|| (windows && crate::bash::vm::probe::is_windows_absolute(dir));
		if !absolute
			|| dir
				.split(|&c| c == b'/' || (windows && c == b'\\'))
				.any(|c| c == b"." || c == b"..")
		{
			continue;
		}
		if ex.log.get(ex.cursor).is_none() {
			let seq = u32::try_from(ex.cursor).unwrap_or(u32::MAX);
			let req = Box::new(FsReq::ReadDir { path: BString::from(dir) });
			return Err(Stop::Probe(Probe::Fs { seq, req }));
		}
		lists.push((dir, ex.cursor));
		ex.cursor += 1;
	}
	let mut entries = HashMap::new();
	for (dir, at) in lists {
		let Some(Atom::List(names)) = ex.log.get(at).cloned() else {
			continue;
		};
		for name in names {
			if entries.contains_key(&name)
				|| state::record(ex.cx.store, ex.vp, Key::CmdHash(name.as_bstr()))?.is_some()
			{
				continue;
			}
			let mut full = BString::from(dir);
			full.push(b'/');
			full.extend_from_slice(&name);
			// zsh's test for an executable plain file: `access(X_OK)`, then
			// not a directory (a directory lists).
			if exec_only {
				let x = ask(ex, Probe::Access { path: full.clone(), mode: 4 })?;
				if !matches!(x, Atom::Str(Some(_))) {
					continue;
				}
				let seq = u32::try_from(ex.cursor).unwrap_or(u32::MAX);
				let req = Box::new(FsReq::ReadDir { path: full.clone() });
				if matches!(ask(ex, Probe::Fs { seq, req })?, Atom::List(_)) {
					continue;
				}
			}
			entries.insert(name, full);
		}
	}
	for (name, full) in entries {
		let rec = Record::CmdHash { path: full, hits: 0 };
		state::store_record(&mut ex.k.root, ex.cx.store, ex.vp, KeyBuf::CmdHash(name), Some(rec));
	}
	let mark = Some(Record::Misc(path));
	state::store_record(
		&mut ex.k.root,
		ex.cx.store,
		ex.vp,
		KeyBuf::Misc(MiscKey::ZshPathChecked),
		mark,
	);
	Ok(())
}

/// One level of zsh's function stack (`struct funcstack`): a function
/// call or a `.` file.
struct FuncLevel {
	/// `name`: the function's, the `.` file's.
	name:    BString,
	/// `caller`: `$0` where the call was made (the level below's name, the
	/// shell's or the script's at the bottom).
	caller:  BString,
	/// `lineno`: the line of the call, counted as the caller counts them.
	line:    u32,
	/// `filename`: the file the function was defined in, the `.` file.
	file:    BString,
	/// `flineno`: the line of the function's definition in it (0 for a
	/// `.` file and an autoloaded function).
	flineno: u32,
	/// `FS_SOURCE`.
	source:  bool,
}

/// zsh's function stack (`funcstack`), bottom first, from the calls the
/// vproc made ([`crate::bash::vm::callstack`]); `eval` levels are not
/// kept there.
fn funcstack_levels(ex: &Expander<'_, '_>) -> Vec<FuncLevel> {
	use crate::bash::{event::Origin, vm::callstack::CallKind};
	// A function's lines count from its definition's (zsh `lineno` in a
	// function); one without a definition line (`u32::MAX`) from 0.
	let def_line = |depth: u32| {
		(depth as usize)
			.checked_sub(1)
			.and_then(|fi| ex.vp.frames.get(fi)?.unit.as_ref())
			.map(|u| crate::bash::vm::callstack::definition_line(u))
			.filter(|&l| l != u32::MAX)
			.unwrap_or(0)
	};
	let calls = ex
		.vp
		.calls
		.iter()
		.filter(|c| !matches!(c.kind, CallKind::Args(_)));
	let mut out: Vec<FuncLevel> = Vec::new();
	for c in calls {
		let (caller, base) = if let Some(p) = out.last() {
			(p.name.clone(), if p.source { 0 } else { p.flineno })
		} else {
			let top = match &c.kind {
				// A `.` file at the top: the script's name (`zsh` for a
				// `-c` string).
				CallKind::Source { .. } => {
					match ex
						.vp
						.runs
						.front()
						.and_then(|r| r.chain.links.first())
						.map(|l| &l.origin)
					{
						Some(Origin::File(path)) => path.clone(),
						_ => BString::from("zsh"),
					}
				},
				_ => ex.k.argv0.clone(),
			};
			(top, 0)
		};
		out.push(match &c.kind {
			CallKind::Function { name, file, line, .. } => FuncLevel {
				name: name.clone(),
				caller,
				line: line.saturating_sub(base),
				file: file.clone(),
				flineno: def_line(c.depth),
				source: false,
			},
			CallKind::Source { file, line, argzero, .. } => {
				let file = argzero.clone().unwrap_or_else(|| file.clone());
				FuncLevel {
					name: file.clone(),
					caller,
					line: line.saturating_sub(base),
					file,
					flineno: 0,
					source: true,
				}
			},
			CallKind::Args(_) => continue,
		});
	}
	out
}

/// The body of a function as `$functions` shows it (zsh `getfunction`):
/// regenerated from its canonical source; for a source that is no one
/// definition, the text between the outer braces re-indented with one tab.
fn func_body(source: &[u8]) -> BString {
	if let Some(body) = crate::bash::syntax::zsh::source_body_text(source) {
		return body.into();
	}
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
		Special::Histsize | Special::Savehist => {
			let v = super::params::parse_int(&as_scalar(&value));
			let save = sp == Special::Savehist;
			crate::bash::vm::builtins::history::zsh::set_size_param(
				&mut ex.k.root,
				ex.cx.store,
				ex.vp,
				save,
				Some(v),
			)?;
		},
		Special::Histchars => {
			let v = as_scalar(&value);
			let res = crate::bash::vm::builtins::history::zsh::set_histchars_param(
				&mut ex.k.root,
				ex.cx.store,
				ex.vp,
				&v,
			)?;
			if let Err(d) = res {
				ex.k.diag(ex.cx, ex.vp, ex.line, d);
			}
		},
		Special::Random => {
			let seed = super::params::parse_int(&as_scalar(&value));
			ex.k.seed_random(ex.cx.store, seed);
		},
		Special::Seconds => {
			// zsh `intsecondssetfn` / `floatsecondssetfn`.
			let text = as_scalar(&value);
			let ns = if seconds_type(ex)?.0 == PmFlags::INTEGER {
				super::params::parse_int(&text).saturating_mul(1_000_000_000)
			} else {
				let d: f64 = std::str::from_utf8(&text)
					.ok()
					.and_then(|s| s.trim().parse().ok())
					.unwrap_or(0.0);
				// Nanoseconds (`as` saturates).
				(d * 1e9) as i64
			};
			let now = ex.cx.host.now_ns();
			ex.k.start_ns = now.wrapping_sub(ns as u64);
			let v = ex.k.start_ns;
			ex.k.root.set_misc(ex.cx.store, MiscKey::StartNs, num(v));
		},
		Special::Example(p) => {
			crate::bash::vm::builtins::zsh_mod_example::param_set(ex, p, value)?;
		},
		Special::TiedArray(t) => {
			let sep = t.separator(ex.k.engine.config().platform);
			let joined = BString::from(as_array(value).join(&[sep][..]));
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
		Special::Nameddirs => {
			// zsh `setpmnameddirs`: the table's non-user entries become
			// the value's (an entry kept keeps its place).
			let pairs: Vec<(BString, BString)> = match value {
				PValue::Hash(h) => h,
				other => {
					let a = as_array(other);
					a.chunks(2)
						.map(|p| (p[0].clone(), p.get(1).cloned().unwrap_or_default()))
						.collect()
				},
			};
			let mut t = super::nameddir::load(ex)?;
			let stale: Vec<BString> = t
				.entries()
				.filter(|e| {
					e.flags & super::nameddir::ND_USERNAME == 0
						&& !pairs.iter().any(|(k, _)| k.as_slice() == e.name)
				})
				.map(|e| BString::from(e.name))
				.collect();
			for n in stale {
				t.remove(&n);
			}
			for (k, v) in pairs {
				t.add(&k, &v, 0);
			}
			super::nameddir::save(ex, &t);
		},
		Special::Zero | Special::Underscore => {},
		Special::Uid | Special::Euid | Special::Gid | Special::Egid => {
			return set_id(ex, sp, super::params::parse_int(&as_scalar(&value)));
		},
		Special::Mapfile => return crate::bash::vm::builtins::zsh_mod_mapfile::set_all(ex, value),
		// zsh/langinfo has no set function for the whole association: an
		// assignment does nothing.
		Special::Langinfo => {},
		Special::Zle(z) => return crate::bash::vm::zle::params::set(ex, z, value),
		Special::Comp(c) => return crate::bash::vm::zle::comp::complete::set(ex, c, value),
		Special::Functions => return set_functions(ex, value),
		Special::Username | Special::Commands => {
			return Err(Stop::Fail(Diag::Unsupported {
				what: format!("assigning to zsh special `{}'", bstr::BStr::new(name)).into(),
			}));
		},
		_ => return Err(Stop::Fail(Diag::Readonly { name: BString::from(name) })),
	}
	Ok(())
}

/// zsh/parameter `setpmfunctions` (`functions=(…)`, `functions+=(…)`)
/// and `setpmfunction` (`functions[f]=…`, which comes here with the whole
/// table): each entry whose body is not the function's text already is
/// defined from it (`setfunction`); one that does not parse is `invalid
/// function definition`. Functions not named stay.
fn set_functions(ex: &mut Expander<'_, '_>, value: PValue) -> X<()> {
	let pairs: Vec<(BString, BString)> = match value {
		PValue::Hash(h) => h,
		other => {
			let a = match other {
				PValue::Array(a) => a,
				PValue::Scalar(s) => vec![s],
				PValue::Hash(_) => Vec::new(),
			};
			a.chunks(2)
				.map(|p| (p[0].clone(), p.get(1).cloned().unwrap_or_default()))
				.collect()
		},
	};
	let feat = crate::bash::vm::mode::features(
		&mut ex.k.root,
		ex.cx.store,
		ex.vp,
		crate::bash::syntax::Features::ZSH,
	)?;
	for (name, body) in pairs {
		let current = state::record(ex.cx.store, ex.vp, Key::Func(bstr::BStr::new(&name)))?;
		if let Some(Record::Func { source, .. }) = &current
			&& ex.k.engine.function_body(source, func_body) == body
		{
			continue;
		}
		let mut src = name.to_vec();
		src.extend_from_slice(b" () {\n");
		src.extend_from_slice(&body);
		src.extend_from_slice(b"\n}");
		let Some(mut f) = crate::bash::ir::function_from_source(&src, ex.vp.mode, feat) else {
			ex.k.diag(ex.cx, ex.vp, ex.line, Diag::Warning {
				msg: "invalid function definition".into(),
			});
			continue;
		};
		f.name = name;
		let line = ex.line;
		let _ = crate::bash::vm::builtins::define_function(ex.k, ex.vp, ex.cx, &f, line, false);
	}
	Ok(())
}

/// A prefix assignment `UID=value cmd` (`EUID`, `GID`, `EGID` alike): zsh
/// `addvars` sets the special, so an id the shell cannot take fails the
/// command ([`set_id`]); other names pass.
///
/// # Errors
/// That failure.
pub fn check_id_prefix(ex: &Expander<'_, '_>, name: &[u8], value: &[u8]) -> X<()> {
	match lookup(name) {
		Some(sp @ (Special::Uid | Special::Euid | Special::Gid | Special::Egid)) => {
			set_id(ex, sp, super::params::parse_int(value))
		},
		_ => Ok(()),
	}
}

/// zsh `uidsetfn`, `euidsetfn`, `gidsetfn`, `egidsetfn`: `setuid` and
/// friends. An unprivileged shell may only keep the ids it has (anything
/// else is `EPERM`, a fatal `failed to change user ID`); really changing
/// the shell's identity is not supported.
fn set_id(ex: &Expander<'_, '_>, sp: Special, want: i64) -> X<()> {
	let user = ex.cx.host.user();
	let (what, have) = match sp {
		Special::Uid => ("user ID", i64::from(user.uid)),
		Special::Euid => ("effective user ID", i64::from(user.euid)),
		Special::Gid => ("group ID", i64::from(user.gid)),
		_ => ("effective group ID", i64::from(user.gid)),
	};
	if want == have && user.uid == user.euid {
		return Ok(());
	}
	if user.euid == 0 || user.uid != user.euid {
		return Err(Stop::Fail(Diag::Unsupported {
			what: format!("changing the shell's {what}").into(),
		}));
	}
	Err(Stop::Fail(Diag::ZshSubst {
		msg: BString::from(format!("failed to change {what}: operation not permitted")),
	}))
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
	let interactive = matches!(opt, ZshOpt::Exec | ZshOpt::Zle)
		&& state::zsh_option(&mut ex.k.root, ex.cx.store, ex.vp, ZshOpt::Interactive)?
		&& (opt != ZshOpt::Zle || crate::bash::vm::jobctl::shtty_file(ex.k).is_some());
	if opt.fixed(cur, on, interactive)
		|| (opt == ZshOpt::Monitor
			&& on
			&& !crate::bash::vm::jobctl::enable_monitor(ex.k, ex.cx, ex.vp))
	{
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
		Special::Histsize | Special::Savehist => {
			let save = sp == Special::Savehist;
			crate::bash::vm::builtins::history::zsh::set_size_param(
				&mut ex.k.root,
				ex.cx.store,
				ex.vp,
				save,
				None,
			)?;
			Ok(())
		},
		Special::TiedArray(t) => {
			state::unset_var(&mut ex.k.root, ex.cx.store, ex.vp, t.scalar().as_bytes(), true);
			Ok(())
		},
		Special::Mapfile => crate::bash::vm::builtins::zsh_mod_mapfile::unset_whole(ex),
		// zsh/langinfo has no unset function: the association stays.
		Special::Langinfo => Ok(()),
		Special::Zle(z) => crate::bash::vm::zle::params::unset(ex, z),
		Special::Comp(c) => {
			crate::bash::vm::zle::comp::complete::unset(ex, c);
			Ok(())
		},
		Special::Example(p) => crate::bash::vm::builtins::zsh_mod_example::param_unset(ex, p),
		_ if sp.readonly() => Err(Stop::Fail(Diag::Readonly { name: BString::from(name) })),
		// zsh/parameter's unset functions change nothing (`unset dirstack`
		// keeps the stack): `PM_UNSET` on the special that stays.
		_ if sp.module().is_some() => {
			crate::bash::vm::builtins::zsh_module::set_param_unset(ex, name, true)
		},
		_ => Ok(()),
	}
}
