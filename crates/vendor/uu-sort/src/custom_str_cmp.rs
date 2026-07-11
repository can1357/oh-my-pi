// This file is part of the uutils coreutils package.
//
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

//! Custom string comparisons.
//!
//! The goal is to compare strings without transforming them first (i.e. not
//! allocating new strings)

use std::cmp::Ordering;

fn filter_char(c: u8, ignore_non_printing: bool, ignore_non_dictionary: bool) -> bool {
	if ignore_non_dictionary && !(c.is_ascii_alphanumeric() || c.is_ascii_whitespace()) {
		return false;
	}
	if ignore_non_printing && (c.is_ascii_control() || !c.is_ascii()) {
		return false;
	}
	true
}

fn cmp_chars(a: u8, b: u8, ignore_case: bool) -> Ordering {
	if ignore_case {
		a.to_ascii_uppercase().cmp(&b.to_ascii_uppercase())
	} else {
		a.cmp(&b)
	}
}

pub fn custom_str_cmp(
	a: &[u8],
	b: &[u8],
	ignore_non_printing: bool,
	ignore_non_dictionary: bool,
	ignore_case: bool,
) -> Ordering {
	if !(ignore_case || ignore_non_dictionary || ignore_non_printing) {
		// There are no custom settings. Fall back to the default strcmp, which is
		// faster.
		return a.cmp(b);
	}
	let mut a_chars = a
		.iter()
		.filter(|&&c| filter_char(c, ignore_non_printing, ignore_non_dictionary));
	let mut b_chars = b
		.iter()
		.filter(|&&c| filter_char(c, ignore_non_printing, ignore_non_dictionary));
	loop {
		let a_char = a_chars.next();
		let b_char = b_chars.next();
		match (a_char, b_char) {
			(None, None) => return Ordering::Equal,
			(Some(_), None) => return Ordering::Greater,
			(None, Some(_)) => return Ordering::Less,
			(Some(a_char), Some(b_char)) => {
				let ordering = cmp_chars(*a_char, *b_char, ignore_case);
				if ordering != Ordering::Equal {
					return ordering;
				}
			},
		}
	}
}
