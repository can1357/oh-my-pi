//! GNU quoting-style names (`QUOTING_STYLE`), for the utilities that honor
//! them when printing names: `du` and `env`.
//!
//! `ls` keeps its own table: it renders `locale`/`clocale` with typographic
//! quotes, which uucore's styles cannot express.

use uucore::quoting_style::{QuotingStyle, Quotes};

/// GNU's quoting-style names and the nearest uucore style. uucore has no
/// `c-maybe`, `locale`, or `clocale`; they map to its C-style quoting.
const STYLES: [(&str, QuotingStyle); 10] = [
	("literal", QuotingStyle::Literal { show_control: true }),
	("shell", QuotingStyle::Shell { escape: false, always_quote: false, show_control: true }),
	("shell-always", QuotingStyle::Shell { escape: false, always_quote: true, show_control: true }),
	("shell-escape", QuotingStyle::Shell { escape: true, always_quote: false, show_control: true }),
	("shell-escape-always", QuotingStyle::Shell { escape: true, always_quote: true, show_control: true }),
	("c", QuotingStyle::C_DOUBLE),
	("c-maybe", QuotingStyle::C_DOUBLE),
	("escape", QuotingStyle::C_NO_QUOTES),
	("locale", QuotingStyle::C { quotes: Quotes::Single }),
	("clocale", QuotingStyle::C_DOUBLE),
];

/// The style a quoting-style name selects, matched as GNU's `argmatch` does:
/// in full or as an unambiguous prefix. `None` for an unknown or ambiguous
/// name, which GNU utilities report and then ignore.
pub(crate) fn quoting_style_by_name(name: &str) -> Option<QuotingStyle> {
	if let Some(&(_, style)) = STYLES.iter().find(|(known, _)| *known == name) {
		return Some(style);
	}
	let mut matches = STYLES.iter().filter(|(known, _)| known.starts_with(name));
	let (_, first) = *matches.next()?;
	matches.all(|&(_, style)| style == first).then_some(first)
}
