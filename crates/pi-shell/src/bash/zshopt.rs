//! zsh 5.9's option table: the zsh dialect's mode options.
//!
//! From `Src/options.c` (`optns`, `zshletters`, `kshletters`) with the
//! emulation defaults, generated once and checked in; the order is zsh's
//! (alphabetical), so `setopt` listings come out sorted.
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use serde::{Deserialize, Serialize};

use crate::bash::{ids::ModeId, store::OptId};

/// A zsh option (zsh 5.9 `optns`, aliases excluded).
///
/// Stored per shell as
/// [`Key::ZshOpt`](crate::bash::store::Key::ZshOpt) records (absent: the `zsh`
/// emulation default), except the env options shared with bash
/// ([`ZshOpt::env_twin`]), which live in
/// [`Key::Opt`](crate::bash::store::Key::Opt).
#[derive(
	Clone,
	Copy,
	Debug,
	PartialEq,
	Eq,
	Hash,
	PartialOrd,
	Ord,
	Serialize,
	Deserialize,
	strum::EnumString,
	strum::VariantNames,
	strum::EnumIter,
)]
#[strum(serialize_all = "lowercase")]
#[serde(rename_all = "lowercase")]
#[expect(missing_docs, reason = "each variant is the zsh option of the same name")]
pub enum ZshOpt {
	Aliases,
	Aliasfuncdef,
	Allexport,
	Alwayslastprompt,
	Alwaystoend,
	Appendcreate,
	Appendhistory,
	Autocd,
	Autocontinue,
	Autolist,
	Automenu,
	Autonamedirs,
	Autoparamkeys,
	Autoparamslash,
	Autopushd,
	Autoremoveslash,
	Autoresume,
	Badpattern,
	Banghist,
	Bareglobqual,
	Bashautolist,
	Bashrematch,
	Beep,
	Bgnice,
	Braceccl,
	Bsdecho,
	Caseglob,
	Casematch,
	Casepaths,
	Cbases,
	Cprecedences,
	Cdablevars,
	Cdsilent,
	Chasedots,
	Chaselinks,
	Checkjobs,
	Checkrunningjobs,
	Clobber,
	Clobberempty,
	Combiningchars,
	Completealiases,
	Completeinword,
	Continueonerror,
	Correct,
	Correctall,
	Cshjunkiehistory,
	Cshjunkieloops,
	Cshjunkiequotes,
	Cshnullcmd,
	Cshnullglob,
	Debugbeforecmd,
	Emacs,
	Equals,
	Errexit,
	Errreturn,
	Exec,
	Extendedglob,
	Extendedhistory,
	Evallineno,
	Flowcontrol,
	Forcefloat,
	Functionargzero,
	Glob,
	Globalexport,
	Globalrcs,
	Globassign,
	Globcomplete,
	Globdots,
	Globstarshort,
	Globsubst,
	Hashcmds,
	Hashdirs,
	Hashexecutablesonly,
	Hashlistall,
	Histallowclobber,
	Histbeep,
	Histexpiredupsfirst,
	Histfcntllock,
	Histfindnodups,
	Histignorealldups,
	Histignoredups,
	Histignorespace,
	Histlexwords,
	Histnofunctions,
	Histnostore,
	Histsubstpattern,
	Histreduceblanks,
	Histsavebycopy,
	Histsavenodups,
	Histverify,
	Hup,
	Ignorebraces,
	Ignoreclosebraces,
	Ignoreeof,
	Incappendhistory,
	Incappendhistorytime,
	Interactive,
	Interactivecomments,
	Ksharrays,
	Kshautoload,
	Kshglob,
	Kshoptionprint,
	Kshtypeset,
	Kshzerosubscript,
	Listambiguous,
	Listbeep,
	Listpacked,
	Listrowsfirst,
	Listtypes,
	Localoptions,
	Localloops,
	Localpatterns,
	Localtraps,
	Login,
	Longlistjobs,
	Magicequalsubst,
	Mailwarning,
	Markdirs,
	Menucomplete,
	Monitor,
	Multibyte,
	Multifuncdef,
	Multios,
	Nomatch,
	Notify,
	Nullglob,
	Numericglobsort,
	Octalzeroes,
	Overstrike,
	Pathdirs,
	Pathscript,
	Pipefail,
	Posixaliases,
	Posixargzero,
	Posixbuiltins,
	Posixcd,
	Posixidentifiers,
	Posixjobs,
	Posixstrings,
	Posixtraps,
	Printeightbit,
	Printexitvalue,
	Privileged,
	Promptbang,
	Promptcr,
	Promptpercent,
	Promptsp,
	Promptsubst,
	Pushdignoredups,
	Pushdminus,
	Pushdsilent,
	Pushdtohome,
	Rcexpandparam,
	Rcquotes,
	Rcs,
	Recexact,
	Rematchpcre,
	Restricted,
	Rmstarsilent,
	Rmstarwait,
	Sharehistory,
	Shfileexpansion,
	Shglob,
	Shinstdin,
	Shnullcmd,
	Shoptionletters,
	Shortloops,
	Shortrepeat,
	Shwordsplit,
	Singlecommand,
	Singlelinezle,
	Sourcetrace,
	Sunkeyboardhack,
	Transientrprompt,
	Trapsasync,
	Typesetsilent,
	Typesettounset,
	Unset,
	Verbose,
	Vi,
	Warncreateglobal,
	Warnnestedvar,
	Xtrace,
	Zle,
	Dvorak,
}

crate::bash::packed_names::packed_names!(ZshOpt, Display);

/// zsh `OPT_CSH`: on by default under `emulate csh`.
const OPT_CSH: u8 = 1 << 1;
/// zsh `OPT_KSH`.
const OPT_KSH: u8 = 1 << 2;
/// zsh `OPT_SH`.
const OPT_SH: u8 = 1 << 3;
/// zsh `OPT_ZSH`.
const OPT_ZSH: u8 = 1 << 4;
/// zsh `OPT_EMULATE`: reset by every `emulate`, not only by `emulate -R`.
const OPT_EMULATE: u8 = 1 << 6;
/// zsh `OPT_SPECIAL`: never set by `emulate`.
const OPT_SPECIAL: u8 = 1 << 7;

const _: () = assert!(ZshOpt::COUNT <= 3 * 64, "ZshOpts holds every option");

/// `optns` flags by [`ZshOpt`] discriminant.
const FLAGS: [u8; ZshOpt::COUNT] = [
	0x5e, 0x4c, 0x40, 0x1e, 0x00, 0x4c, 0x1e, 0x40, 0x00, 0x1e, 0x1e, 0x00, 0x1e, 0x1e, 0x00, 0x1e,
	0x00, 0x52, 0x12, 0x50, 0x00, 0x00, 0x1e, 0x52, 0x40, 0x48, 0x1e, 0x1e, 0x00, 0x00, 0x4e, 0x40,
	0x00, 0x40, 0x40, 0x50, 0x50, 0x5e, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x42, 0x42, 0x42,
	0x42, 0x42, 0x1e, 0x00, 0x50, 0x40, 0x40, 0x1e, 0x40, 0x02, 0x50, 0x1e, 0x00, 0x52, 0x5e, 0x50,
	0x1e, 0x42, 0x00, 0x40, 0x40, 0x4e, 0x1e, 0x1e, 0x00, 0x1e, 0x00, 0x1e, 0x00, 0x00, 0x00, 0x00,
	0x00, 0x00, 0x00, 0x00, 0x00, 0x40, 0x00, 0x1e, 0x00, 0x00, 0x50, 0x48, 0x40, 0x00, 0x00, 0x00,
	0x80, 0x0c, 0x4c, 0x4c, 0x44, 0x44, 0x00, 0x00, 0x1e, 0x1e, 0x00, 0x00, 0x1e, 0x44, 0x40, 0x40,
	0x44, 0x80, 0x00, 0x40, 0x00, 0x00, 0x00, 0x80, 0x1e, 0x50, 0x50, 0x52, 0x10, 0x40, 0x40, 0x48,
	0x00, 0x40, 0x4c, 0x40, 0x4c, 0x40, 0x4c, 0x4c, 0x4c, 0x4c, 0x4c, 0x4c, 0x00, 0x00, 0x80, 0x04,
	0x1e, 0x12, 0x1e, 0x0c, 0x40, 0x40, 0x00, 0x40, 0x40, 0x40, 0x1e, 0x00, 0x00, 0x80, 0x0c, 0x00,
	0x04, 0x4c, 0x4c, 0x80, 0x4c, 0x4c, 0x52, 0x40, 0x4c, 0x80, 0x04, 0x00, 0x00, 0x00, 0x00, 0x4c,
	0x4c, 0x5c, 0x00, 0x00, 0x40, 0x40, 0x00, 0x80, 0x00,
];

/// zsh's option aliases (`OPT_ALIAS` entries): the option alias `name`
/// stands for and whether it is inverted. A `match`, not a table of string
/// slices (one dynamic relocation each at every process start).
const fn alias(name: &[u8]) -> Option<(ZshOpt, bool)> {
	Some(match name {
		b"braceexpand" => (ZshOpt::Ignorebraces, true),
		b"dotglob" => (ZshOpt::Globdots, false),
		b"hashall" => (ZshOpt::Hashcmds, false),
		b"histappend" => (ZshOpt::Appendhistory, false),
		b"histexpand" => (ZshOpt::Banghist, false),
		b"log" => (ZshOpt::Histnofunctions, true),
		b"mailwarn" => (ZshOpt::Mailwarning, false),
		b"onecmd" => (ZshOpt::Singlecommand, false),
		b"physical" => (ZshOpt::Chaselinks, false),
		b"promptvars" => (ZshOpt::Promptsubst, false),
		b"stdin" => (ZshOpt::Shinstdin, false),
		b"trackall" => (ZshOpt::Hashcmds, false),
		_ => return None,
	})
}

impl ZshOpt {
	/// Number of options.
	pub const COUNT: usize = 185;

	/// The bitset word and mask of this option ([`ZshOpts`]).
	const fn bit(self) -> (usize, u64) {
		let i = self as usize;
		(i / 64, 1 << (i % 64))
	}

	/// Default under emulation `mode` (zsh `defset`): `sh` and `ksh` use
	/// zsh's sh and ksh columns, every other mode the zsh column.
	pub const fn default_in(self, mode: ModeId) -> bool {
		let col = match mode {
			ModeId::ZshSh | ModeId::Sh => OPT_SH,
			ModeId::Ksh => OPT_KSH,
			ModeId::Zsh | ModeId::Bash => OPT_ZSH,
		};
		FLAGS[self as usize] & col != 0
	}

	/// Whether `emulate` without `-R` resets it (zsh `OPT_EMULATE`).
	pub const fn emulation_relevant(self) -> bool {
		FLAGS[self as usize] & OPT_EMULATE != 0
	}

	/// zsh `dosetopt`'s refusals: whether the option, now `cur`, cannot
	/// become `on` (`interactive`, `shinstdin` and `singlecommand` are
	/// fixed, `zle` needs a terminal, `restricted` cannot be turned off,
	/// `exec` not off in an `interactive` shell). Shared by `setopt` and
	/// assignments to `$options` (zsh `setpmoption`).
	pub const fn fixed(self, cur: bool, on: bool, interactive: bool) -> bool {
		match self {
			Self::Interactive | Self::Shinstdin | Self::Singlecommand => cur != on,
			Self::Zle => on,
			Self::Restricted => cur && !on,
			Self::Exec => !on && interactive,
			_ => false,
		}
	}

	/// Whether `emulate` never sets it (zsh `OPT_SPECIAL`: `interactive`,
	/// `login`, `monitor`, `privileged`, `restricted`, `shinstdin`,
	/// `singlecommand`, `zle`).
	pub const fn special(self) -> bool {
		FLAGS[self as usize] & OPT_SPECIAL != 0
	}

	/// Whether `emulate csh` would turn it on (kept for `emulate -l csh`
	/// listings; csh emulation itself is unsupported).
	pub const fn csh_default(self) -> bool {
		FLAGS[self as usize] & OPT_CSH != 0
	}

	/// The bash option this env option is shared with (env
	/// options cross the mode boundary), and whether the zsh option is its
	/// inverse (`clobber` = not `noclobber`). `None` for a mode option.
	pub const fn env_twin(self) -> Option<(OptId, bool)> {
		Some(match self {
			Self::Allexport => (OptId::Allexport, false),
			Self::Errexit => (OptId::Errexit, false),
			Self::Clobber => (OptId::Noclobber, true),
			Self::Exec => (OptId::Noexec, true),
			Self::Glob => (OptId::Noglob, true),
			Self::Unset => (OptId::Nounset, true),
			Self::Pipefail => (OptId::Pipefail, false),
			Self::Verbose => (OptId::Verbose, false),
			Self::Xtrace => (OptId::Xtrace, false),
			Self::Monitor => (OptId::Monitor, false),
			Self::Notify => (OptId::Notify, false),
			Self::Ignoreeof => (OptId::Ignoreeof, false),
			Self::Privileged => (OptId::Privileged, false),
			Self::Hashcmds => (OptId::Hashall, false),
			_ => return None,
		})
	}

	/// zsh `optlookup`: the option `name` names (case and `_` ignored, a
	/// `no` prefix inverts, aliases resolved), and whether it is inverted.
	pub fn lookup(name: &[u8]) -> Option<(Self, bool)> {
		let norm: Vec<u8> = name
			.iter()
			.filter(|&&c| c != b'_')
			.map(u8::to_ascii_lowercase)
			.collect();
		let find = |n: &[u8]| -> Option<(Self, bool)> {
			let s = std::str::from_utf8(n).ok()?;
			if let Ok(opt) = s.parse::<Self>() {
				return Some((opt, false));
			}
			alias(n)
		};
		if let Some(rest) = norm.strip_prefix(b"no")
			&& let Some((opt, inv)) = find(rest)
		{
			return Some((opt, !inv));
		}
		find(&norm)
	}

	/// zsh `optlookupc` under emulation `mode`: the option a single-letter
	/// flag (`set -X`, `setopt -X`) names and whether the letter means its
	/// inverse (ksh letters under `sh`/`ksh` emulation, zsh's otherwise).
	pub const fn letter(c: u8, mode: ModeId) -> Option<(Self, bool)> {
		if matches!(mode, ModeId::ZshSh | ModeId::Ksh | ModeId::Sh) {
			Self::ksh_letter(c)
		} else {
			Self::zsh_letter(c)
		}
	}

	/// zsh `zshletters`.
	const fn zsh_letter(c: u8) -> Option<(Self, bool)> {
		Some(match c {
			b'0' => (Self::Correct, false),
			b'1' => (Self::Printexitvalue, false),
			b'2' => (Self::Badpattern, true),
			b'3' => (Self::Nomatch, true),
			b'4' => (Self::Globdots, false),
			b'5' => (Self::Notify, false),
			b'6' => (Self::Bgnice, false),
			b'7' => (Self::Ignoreeof, false),
			b'8' => (Self::Markdirs, false),
			b'9' => (Self::Autolist, false),
			b'B' => (Self::Beep, true),
			b'C' => (Self::Clobber, true),
			b'D' => (Self::Pushdtohome, false),
			b'E' => (Self::Pushdsilent, false),
			b'F' => (Self::Glob, true),
			b'G' => (Self::Nullglob, false),
			b'H' => (Self::Rmstarsilent, false),
			b'I' => (Self::Ignorebraces, false),
			b'J' => (Self::Autocd, false),
			b'K' => (Self::Banghist, true),
			b'L' => (Self::Sunkeyboardhack, false),
			b'M' => (Self::Singlelinezle, false),
			b'N' => (Self::Autopushd, false),
			b'O' => (Self::Correctall, false),
			b'P' => (Self::Rcexpandparam, false),
			b'Q' => (Self::Pathdirs, false),
			b'R' => (Self::Longlistjobs, false),
			b'S' => (Self::Recexact, false),
			b'T' => (Self::Cdablevars, false),
			b'U' => (Self::Mailwarning, false),
			b'V' => (Self::Promptcr, true),
			b'W' => (Self::Autoresume, false),
			b'X' => (Self::Listtypes, false),
			b'Y' => (Self::Menucomplete, false),
			b'Z' => (Self::Zle, false),
			b'a' => (Self::Allexport, false),
			b'd' => (Self::Globalrcs, true),
			b'e' => (Self::Errexit, false),
			b'f' => (Self::Rcs, true),
			b'g' => (Self::Histignorespace, false),
			b'h' => (Self::Histignoredups, false),
			b'i' => (Self::Interactive, false),
			b'k' => (Self::Interactivecomments, false),
			b'l' => (Self::Login, false),
			b'm' => (Self::Monitor, false),
			b'n' => (Self::Exec, true),
			b'p' => (Self::Privileged, false),
			b'r' => (Self::Restricted, false),
			b's' => (Self::Shinstdin, false),
			b't' => (Self::Singlecommand, false),
			b'u' => (Self::Unset, true),
			b'v' => (Self::Verbose, false),
			b'w' => (Self::Chaselinks, false),
			b'x' => (Self::Xtrace, false),
			b'y' => (Self::Shwordsplit, false),
			_ => return None,
		})
	}

	/// zsh `kshletters`.
	const fn ksh_letter(c: u8) -> Option<(Self, bool)> {
		Some(match c {
			b'C' => (Self::Clobber, true),
			b'T' => (Self::Trapsasync, false),
			b'X' => (Self::Markdirs, false),
			b'a' => (Self::Allexport, false),
			b'b' => (Self::Notify, false),
			b'e' => (Self::Errexit, false),
			b'f' => (Self::Glob, true),
			b'i' => (Self::Interactive, false),
			b'l' => (Self::Login, false),
			b'm' => (Self::Monitor, false),
			b'n' => (Self::Exec, true),
			b'p' => (Self::Privileged, false),
			b'r' => (Self::Restricted, false),
			b's' => (Self::Shinstdin, false),
			b't' => (Self::Singlecommand, false),
			b'u' => (Self::Unset, true),
			b'v' => (Self::Verbose, false),
			b'x' => (Self::Xtrace, false),
			_ => return None,
		})
	}

	/// The `set -X` letter that shows this option in `$-` under emulation
	/// `mode` (zsh `dashgetfn`), and whether the letter stands for its
	/// inverse.
	pub fn letter_of(self, mode: ModeId) -> Option<(u8, bool)> {
		(b'0'..=b'z').find_map(|c| match Self::letter(c, mode) {
			Some((o, inv)) if o == self => Some((c, inv)),
			_ => None,
		})
	}
}

/// A set of zsh option values, one bit per [`ZshOpt`]: saved by a zsh
/// function call (`LOCAL_OPTIONS`, sticky emulation) and cached by the
/// engine for the root shell.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ZshOpts([u64; 3]);

impl ZshOpts {
	/// The defaults of emulation `mode` (zsh `installemulation` with
	/// `emulate -R`, special options off).
	pub fn defaults(mode: ModeId) -> Self {
		use strum::IntoEnumIterator;
		let mut set = Self::default();
		for opt in ZshOpt::iter() {
			set.set(opt, opt.default_in(mode));
		}
		set
	}

	/// Whether `opt` is on.
	pub const fn get(&self, opt: ZshOpt) -> bool {
		let (w, m) = opt.bit();
		self.0[w] & m != 0
	}

	/// Turn `opt` on or off.
	pub const fn set(&mut self, opt: ZshOpt, on: bool) {
		let (w, m) = opt.bit();
		if on {
			self.0[w] |= m;
		} else {
			self.0[w] &= !m;
		}
	}
}

#[cfg(test)]
mod tests {
	use strum::IntoEnumIterator;

	use super::*;

	#[test]
	fn count_and_bitset_cover_every_option() {
		assert_eq!(ZshOpt::iter().count(), ZshOpt::COUNT);
		assert_eq!(ZshOpt::iter().next_back().map(|o| o as usize), Some(ZshOpt::COUNT - 1));
	}

	#[test]
	fn lookup_follows_optlookup() {
		assert_eq!(ZshOpt::lookup(b"EXTENDED_GLOB"), Some((ZshOpt::Extendedglob, false)));
		assert_eq!(ZshOpt::lookup(b"no_match"), Some((ZshOpt::Nomatch, false)));
		assert_eq!(ZshOpt::lookup(b"nonomatch"), Some((ZshOpt::Nomatch, true)));
		assert_eq!(ZshOpt::lookup(b"notify"), Some((ZshOpt::Notify, false)));
		assert_eq!(ZshOpt::lookup(b"braceexpand"), Some((ZshOpt::Ignorebraces, true)));
		assert_eq!(ZshOpt::lookup(b"nobraceexpand"), Some((ZshOpt::Ignorebraces, false)));
		assert_eq!(ZshOpt::lookup(b"nosuchoption"), None);
	}

	#[test]
	fn emulation_defaults_differ_where_zsh_says() {
		assert!(ZshOpt::Nomatch.default_in(ModeId::Zsh));
		assert!(!ZshOpt::Nomatch.default_in(ModeId::ZshSh));
		assert!(ZshOpt::Shwordsplit.default_in(ModeId::ZshSh));
		assert!(!ZshOpt::Shwordsplit.default_in(ModeId::Zsh));
		assert!(ZshOpt::Ksharrays.default_in(ModeId::Ksh));
		assert!(ZshOpt::Interactive.special());
		assert!(!ZshOpt::Kshglob.special());
	}

	#[test]
	fn letters_follow_the_emulation() {
		assert_eq!(ZshOpt::letter(b'f', ModeId::Zsh), Some((ZshOpt::Rcs, true)));
		assert_eq!(ZshOpt::letter(b'f', ModeId::ZshSh), Some((ZshOpt::Glob, true)));
		assert_eq!(ZshOpt::letter(b'b', ModeId::Ksh), Some((ZshOpt::Notify, false)));
		assert_eq!(ZshOpt::letter(b'b', ModeId::Zsh), None);
	}

	#[test]
	fn opts_bits_round_trip() {
		let mut s = ZshOpts::default();
		for o in ZshOpt::iter() {
			s.set(o, true);
			assert!(s.get(o));
		}
		s.set(ZshOpt::Xtrace, false);
		assert!(!s.get(ZshOpt::Xtrace));
		assert!(s.get(ZshOpt::Zle));
	}
}
