//! POSIX character classes and collating-symbol names shared by the glob
//! matcher and the ERE engine.

/// POSIX character classes, matched in the C locale.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Class {
	/// `[:ascii:]` (bash globs only; glibc regex rejects it)
	Ascii,
	/// `[:alnum:]`
	Alnum,
	/// `[:alpha:]`
	Alpha,
	/// `[:blank:]`
	Blank,
	/// `[:cntrl:]`
	Cntrl,
	/// `[:digit:]`
	Digit,
	/// `[:graph:]`
	Graph,
	/// `[:lower:]`
	Lower,
	/// `[:print:]`
	Print,
	/// `[:punct:]`
	Punct,
	/// `[:space:]`
	Space,
	/// `[:upper:]`
	Upper,
	/// `[:word:]` (bash globs only; glibc regex rejects it)
	Word,
	/// `[:xdigit:]`
	Xdigit,
}

impl Class {
	/// The class named `name` (the text between `[:` and `:]`).
	pub const fn parse(name: &[u8]) -> Option<Self> {
		Some(match name {
			b"ascii" => Self::Ascii,
			b"alnum" => Self::Alnum,
			b"alpha" => Self::Alpha,
			b"blank" => Self::Blank,
			b"cntrl" => Self::Cntrl,
			b"digit" => Self::Digit,
			b"graph" => Self::Graph,
			b"lower" => Self::Lower,
			b"print" => Self::Print,
			b"punct" => Self::Punct,
			b"space" => Self::Space,
			b"upper" => Self::Upper,
			b"word" => Self::Word,
			b"xdigit" => Self::Xdigit,
			_ => return None,
		})
	}

	/// Whether byte `c` is in the class (C locale: bytes above 0x7f never
	/// are).
	pub const fn matches(self, c: u8) -> bool {
		match self {
			Self::Ascii => c.is_ascii(),
			Self::Alnum => c.is_ascii_alphanumeric(),
			Self::Alpha => c.is_ascii_alphabetic(),
			Self::Blank => c == b' ' || c == b'\t',
			Self::Cntrl => c.is_ascii_control(),
			Self::Digit => c.is_ascii_digit(),
			Self::Graph => c.is_ascii_graphic(),
			Self::Lower => c.is_ascii_lowercase(),
			Self::Print => c.is_ascii_graphic() || c == b' ',
			Self::Punct => c.is_ascii_punctuation(),
			Self::Space => matches!(c, b' ' | b'\t' | b'\n' | b'\r' | 0x0b | 0x0c),
			Self::Upper => c.is_ascii_uppercase(),
			Self::Word => c.is_ascii_alphanumeric() || c == b'_',
			Self::Xdigit => c.is_ascii_hexdigit(),
		}
	}

	/// Whether character `c` is in the class in a UTF-8 locale; ASCII as
	/// [`Class::matches`], other characters by their Unicode properties
	/// (`digit` and `xdigit` stay ASCII, as glibc's `iswdigit`).
	pub fn matches_char(self, c: char) -> bool {
		if c.is_ascii() {
			return self.matches(c as u8);
		}
		match self {
			Self::Alnum => c.is_alphanumeric(),
			Self::Alpha => c.is_alphabetic(),
			Self::Blank => c.is_whitespace() && !matches!(c, '\u{85}' | '\u{2028}' | '\u{2029}'),
			Self::Cntrl => c.is_control(),
			Self::Ascii | Self::Digit | Self::Xdigit => false,
			Self::Graph => !c.is_control() && !c.is_whitespace(),
			Self::Print => !c.is_control(),
			Self::Lower => c.is_lowercase(),
			Self::Punct => !c.is_control() && !c.is_whitespace() && !c.is_alphanumeric(),
			Self::Space => c.is_whitespace(),
			Self::Upper => c.is_uppercase(),
			Self::Word => c.is_alphanumeric(),
		}
	}
}

/// bash's `collsym` table lookup: the byte a collating-symbol name such as
/// `space` or `hyphen` stands for (`posix_collsyms`, lib/glob/collsyms.h).
/// Single characters are not in the table.
pub fn collsym(name: &[u8]) -> Option<u8> {
	COLLSYMS
		.iter()
		.find(|(n, _)| n.as_bytes() == name)
		.map(|&(_, code)| code)
}

/// bash's `posix_collsyms` (lib/glob/collsyms.h).
const COLLSYMS: &[(&str, u8)] = &[
	("NUL", 0),
	("SOH", 1),
	("STX", 2),
	("ETX", 3),
	("EOT", 4),
	("ENQ", 5),
	("ACK", 6),
	("alert", 7),
	("BS", 8),
	("backspace", 8),
	("HT", 9),
	("tab", 9),
	("LF", 10),
	("newline", 10),
	("VT", 11),
	("vertical-tab", 11),
	("FF", 12),
	("form-feed", 12),
	("CR", 13),
	("carriage-return", 13),
	("SO", 14),
	("SI", 15),
	("DLE", 16),
	("DC1", 17),
	("DC2", 18),
	("DC3", 19),
	("DC4", 20),
	("NAK", 21),
	("SYN", 22),
	("ETB", 23),
	("CAN", 24),
	("EM", 25),
	("SUB", 26),
	("ESC", 27),
	("IS4", 28),
	("FS", 28),
	("IS3", 29),
	("GS", 29),
	("IS2", 30),
	("RS", 30),
	("IS1", 31),
	("US", 31),
	("space", b' '),
	("exclamation-mark", b'!'),
	("quotation-mark", b'"'),
	("number-sign", b'#'),
	("dollar-sign", b'$'),
	("percent-sign", b'%'),
	("ampersand", b'&'),
	("apostrophe", b'\''),
	("left-parenthesis", b'('),
	("right-parenthesis", b')'),
	("asterisk", b'*'),
	("plus-sign", b'+'),
	("comma", b','),
	("hyphen", b'-'),
	("hyphen-minus", b'-'),
	("minus", b'-'),
	("dash", b'-'),
	("period", b'.'),
	("full-stop", b'.'),
	("slash", b'/'),
	("solidus", b'/'),
	("zero", b'0'),
	("one", b'1'),
	("two", b'2'),
	("three", b'3'),
	("four", b'4'),
	("five", b'5'),
	("six", b'6'),
	("seven", b'7'),
	("eight", b'8'),
	("nine", b'9'),
	("colon", b':'),
	("semicolon", b';'),
	("less-than-sign", b'<'),
	("equals-sign", b'='),
	("greater-than-sign", b'>'),
	("question-mark", b'?'),
	("commercial-at", b'@'),
	("left-square-bracket", b'['),
	("backslash", b'\\'),
	("reverse-solidus", b'\\'),
	("right-square-bracket", b']'),
	("circumflex", b'^'),
	("circumflex-accent", b'^'),
	("underscore", b'_'),
	("grave-accent", b'`'),
	("left-brace", b'{'),
	("left-curly-bracket", b'{'),
	("vertical-line", b'|'),
	("right-brace", b'}'),
	("right-curly-bracket", b'}'),
	("tilde", b'~'),
	("DEL", 0x7f),
];
