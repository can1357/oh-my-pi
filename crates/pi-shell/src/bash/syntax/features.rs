//! Parse-affecting options and the alias seam.

use core::ops::BitOr;

/// Grammar switches that change how bytes parse.
///
/// The engine derives them from the shell options at the moment a top-level
/// command is parsed (`shopt -s extglob` takes effect on the next line) and
/// announces them in `UnitCompiled`, so a client re-parses with the same set.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct Features(u32);

impl Features {
	/// The locale's charset is Big5 or GBK: a byte 0x81–0xFE starts a
	/// two-byte character whose second byte may look like ASCII (`\`,
	/// `` ` ``, `|`, `{`). bash reads whole characters, so that byte is not
	/// special. UTF-8, EUC and single-byte charsets need no flag.
	pub const DOUBLE_BYTE: Self = Self(1 << 3);
	/// `shopt -s extglob`: `?( ) *( ) +( ) @( ) !( )` lex as pattern groups.
	pub const EXTGLOB: Self = Self(1);
	/// GB18030: like [`Features::DOUBLE_BYTE`], and a second byte 0x30–0x39
	/// makes the character four bytes long.
	pub const GB18030: Self = Self(1 << 4);
	/// Every charset flag.
	const MULTIBYTE: u32 = Self::DOUBLE_BYTE.0 | Self::GB18030.0 | Self::SHIFT_JIS.0;
	/// No switches: plain bash 5.3.
	pub const NONE: Self = Self(0);
	/// `set -o posix`: POSIX-mode grammar differences.
	pub const POSIX: Self = Self(1 << 1);
	/// `Shift_JIS`: a byte 0x81–0x9F or 0xE0–0xFC starts a two-byte
	/// character whose second byte may look like ASCII.
	pub const SHIFT_JIS: Self = Self(1 << 5);
	/// zsh grammar (a mode of the zsh dialect: `zsh`, `ksh` or zsh's `sh`
	/// emulation). The `ZSH_*` bits below are the zsh options that change
	/// how zsh's lexer and parser read bytes (zsh 5.9 `lex.c`/`parse.c`);
	/// they mean nothing without this bit.
	pub const ZSH: Self = Self(1 << 2);
	/// zsh `aliasfuncdef`.
	pub const ZSH_ALIAS_FUNC_DEF: Self = Self(1 << 20);
	/// zsh `cshjunkieloops`.
	pub const ZSH_CSH_JUNKIE_LOOPS: Self = Self(1 << 12);
	/// zsh `cshjunkiequotes`.
	pub const ZSH_CSH_JUNKIE_QUOTES: Self = Self(1 << 11);
	/// zsh `ignorebraces`.
	pub const ZSH_IGNORE_BRACES: Self = Self(1 << 9);
	/// zsh `ignoreclosebraces`.
	pub const ZSH_IGNORE_CLOSE_BRACES: Self = Self(1 << 10);
	/// zsh `interactivecomments` (zsh reads comments in a non-interactive
	/// shell regardless; the engine sets the bit then).
	pub const ZSH_INTERACTIVE_COMMENTS: Self = Self(1 << 18);
	/// zsh `kshglob`.
	pub const ZSH_KSH_GLOB: Self = Self(1 << 14);
	/// zsh `multifuncdef`.
	pub const ZSH_MULTI_FUNC_DEF: Self = Self(1 << 17);
	/// zsh `noaliases` (the `aliases` option is off).
	pub const ZSH_NO_ALIASES: Self = Self(1 << 19);
	/// zsh `posixaliases`.
	pub const ZSH_POSIX_ALIASES: Self = Self(1 << 13);
	/// zsh `posixbuiltins`.
	pub const ZSH_POSIX_BUILTINS: Self = Self(1 << 16);
	/// zsh `rcquotes`.
	pub const ZSH_RC_QUOTES: Self = Self(1 << 15);
	/// zsh `shortloops`.
	pub const ZSH_SHORT_LOOPS: Self = Self(1 << 7);
	/// zsh `shortrepeat`.
	pub const ZSH_SHORT_REPEAT: Self = Self(1 << 8);
	/// zsh `shglob`.
	pub const ZSH_SH_GLOB: Self = Self(1 << 6);

	/// Raw bits, for serialization.
	pub const fn bits(self) -> u32 {
		self.0
	}

	/// Features from raw bits; unknown bits are dropped.
	pub const fn from_bits(bits: u32) -> Self {
		Self(bits & 0x1f_ffff)
	}

	/// Whether every switch in `other` is on.
	pub const fn contains(self, other: Self) -> bool {
		self.0 & other.0 == other.0
	}

	/// Whether a charset flag is on: characters can end in ASCII-looking
	/// bytes.
	pub const fn multibyte(self) -> bool {
		self.0 & Self::MULTIBYTE != 0
	}

	/// Byte length of the character that starts with `lead`, followed by
	/// `next`, under the charset flag; 1 without one or for a byte that
	/// starts no multibyte character.
	pub const fn char_len(self, lead: u8, next: u8) -> usize {
		if self.contains(Self::SHIFT_JIS) {
			return if matches!(lead, 0x81..=0x9f | 0xe0..=0xfc) {
				2
			} else {
				1
			};
		}
		if !matches!(lead, 0x81..=0xfe) {
			return 1;
		}
		if self.contains(Self::GB18030) {
			return if next.is_ascii_digit() { 4 } else { 2 };
		}
		if self.contains(Self::DOUBLE_BYTE) {
			2
		} else {
			1
		}
	}
}

impl BitOr for Features {
	type Output = Self;

	fn bitor(self, rhs: Self) -> Self {
		Self(self.0 | rhs.0)
	}
}

/// Alias table seen by the parser while it reads one top-level command.
///
/// The engine implements it over its alias records; [`NoAliases`] is the
/// empty table used by tools and visualizers.
pub trait AliasLookup {
	/// Replacement text for `name`, if `name` is an alias.
	fn alias(&self, name: &[u8]) -> Option<&[u8]>;

	/// zsh grammar: replacement text of global alias `name` (`alias -g`),
	/// expanded in any word position.
	fn global_alias(&self, _name: &[u8]) -> Option<&[u8]> {
		None
	}

	/// zsh grammar: replacement text of suffix alias `suffix` (`alias -s`),
	/// for a command word ending in `.suffix`.
	fn suffix_alias(&self, _suffix: &[u8]) -> Option<&[u8]> {
		None
	}

	/// zsh grammar: whether reserved word `word` was disabled (`disable
	/// -r`), so it parses as a plain word.
	fn reserved_disabled(&self, _word: &[u8]) -> bool {
		false
	}
}

/// The empty alias table.
#[derive(Clone, Copy, Debug, Default)]
pub struct NoAliases;

impl AliasLookup for NoAliases {
	fn alias(&self, _name: &[u8]) -> Option<&[u8]> {
		None
	}
}

/// [`NoAliases`] as the parser takes it: pass this rather than `&NoAliases`.
///
/// Every `&NoAliases` coercion to `&dyn AliasLookup` emits its own vtable
/// copy per codegen unit, each a few dynamic relocations applied at every
/// process start.
pub static NO_ALIASES: &(dyn AliasLookup + Sync) = &NoAliases;
