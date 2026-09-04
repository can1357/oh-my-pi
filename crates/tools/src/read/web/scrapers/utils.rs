//! Shared, allocation-conscious helpers for site-specific web scrapers.

use html_to_markdown_rs::convert;
use omp_core::{IntoStr, Str};
use serde::de::DeserializeOwned;

use crate::read::web::types::{HttpResponse, RenderResult, WebError};

/// JSON-decodes a response that has already been fetched.
pub(super) fn decode_json<T: DeserializeOwned>(response: &HttpResponse) -> Result<T, WebError> {
	serde_json::from_slice(&response.body).map_err(|error| WebError::decode(error.to_string()))
}
/// Strictly percent-decodes one URL path component.
///
/// Malformed escapes and decoded byte sequences that are not UTF-8 return
/// `None`; `+` remains a literal plus because this decodes a path, not a form.
pub(super) fn percent_decode_component(component: &str) -> Option<String> {
	let bytes = component.as_bytes();
	let mut decoded = Vec::with_capacity(bytes.len());
	let mut index = 0;
	while index < bytes.len() {
		if bytes[index] != b'%' {
			decoded.push(bytes[index]);
			index += 1;
			continue;
		}
		let high = *bytes.get(index + 1)?;
		let low = *bytes.get(index + 2)?;
		decoded.push(
			hex_digit(high)?
				.checked_mul(16)?
				.checked_add(hex_digit(low)?)?,
		);
		index += 3;
	}
	String::from_utf8(decoded).ok()
}

/// Encodes a JavaScript `encodeURIComponent` component from UTF-8 bytes.
pub(super) fn encode_uri_component(component: &str) -> String {
	const HEX: &[u8; 16] = b"0123456789ABCDEF";
	let mut encoded = String::with_capacity(component.len());
	for byte in component.bytes() {
		if byte.is_ascii_alphanumeric()
			|| matches!(byte, b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')')
		{
			encoded.push(char::from(byte));
		} else {
			encoded.push('%');
			encoded.push(char::from(HEX[usize::from(byte >> 4)]));
			encoded.push(char::from(HEX[usize::from(byte & 0x0f)]));
		}
	}
	encoded
}

const fn hex_digit(byte: u8) -> Option<u8> {
	match byte {
		b'0'..=b'9' => Some(byte - b'0'),
		b'a'..=b'f' => Some(byte - b'a' + 10),
		b'A'..=b'F' => Some(byte - b'A' + 10),
		_ => None,
	}
}

/// Builds a cleaned, capped markdown render result.
pub(super) fn build_result(content: &str, method: impl IntoStr) -> RenderResult {
	RenderResult::markdown(content, method)
}

/// Converts HTML to basic GitHub-flavored markdown.
pub(super) fn html_to_basic_markdown(html: &str) -> Result<Str, WebError> {
	let without_scripts = strip_element_blocks(html, b"<script", b"</script>");
	let cleaned = strip_element_blocks(&without_scripts, b"<style", b"</style>");
	let result = convert(&cleaned, None).map_err(|error| WebError::render(error.to_string()))?;
	Ok(Str::new(result.content.unwrap_or_default().trim()))
}

fn strip_element_blocks(html: &str, opening: &[u8], closing: &[u8]) -> String {
	let mut output = String::with_capacity(html.len());
	let mut cursor = 0;
	while let Some(relative_start) = find_ascii_case_insensitive(&html.as_bytes()[cursor..], opening)
	{
		let start = cursor + relative_start;
		let close_search = start + opening.len();
		let Some(relative_end) =
			find_ascii_case_insensitive(&html.as_bytes()[close_search..], closing)
		else {
			break;
		};
		output.push_str(&html[cursor..start]);
		cursor = close_search + relative_end + closing.len();
	}
	output.push_str(&html[cursor..]);
	output
}

fn find_ascii_case_insensitive(haystack: &[u8], needle: &[u8]) -> Option<usize> {
	haystack
		.windows(needle.len())
		.position(|window| window.eq_ignore_ascii_case(needle))
}

/// Formats a date-like ISO string as `YYYY-MM-DD`, or returns an empty string.
pub(super) fn format_iso_date(value: &str) -> Str {
	let bytes = value.as_bytes();
	if bytes.len() >= 10
		&& bytes[0..4].iter().all(u8::is_ascii_digit)
		&& bytes[4] == b'-'
		&& bytes[5..7].iter().all(u8::is_ascii_digit)
		&& bytes[7] == b'-'
		&& bytes[8..10].iter().all(u8::is_ascii_digit)
	{
		Str::new(&value[..10])
	} else {
		Str::default()
	}
}

/// Formats Unix milliseconds as a UTC `YYYY-MM-DD` date.
pub(super) fn format_unix_date(milliseconds: i64) -> Str {
	let days = milliseconds.div_euclid(86_400_000);
	let (year, month, day) = civil_from_days(days);
	format!("{year:04}-{month:02}-{day:02}").into()
}

// Howard Hinnant's proleptic-Gregorian civil-from-days algorithm.
fn civil_from_days(days_since_epoch: i64) -> (i64, i64, i64) {
	let z = days_since_epoch + 719_468;
	let era = if z >= 0 { z } else { z - 146_096 }.div_euclid(146_097);
	let day_of_era = z - era * 146_097;
	let year_of_era =
		(day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
	let mut year = year_of_era + era * 400;
	let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
	let month_prime = (5 * day_of_year + 2) / 153;
	let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
	let month = month_prime + if month_prime < 10 { 3 } else { -9 };
	year += i64::from(month <= 2);
	(year, month, day)
}

/// Decodes the common HTML entities emitted by supported APIs.
pub(super) fn decode_html_entities(text: &str) -> Str {
	text
		.replace("&lt;", "<")
		.replace("&gt;", ">")
		.replace("&amp;", "&")
		.replace("&quot;", "\"")
		.replace("&#039;", "'")
		.replace("&#39;", "'")
		.replace("&#x27;", "'")
		.replace("&#x2F;", "/")
		.replace("&nbsp;", " ")
		.into()
}

/// Formats seconds as `H:MM:SS` or `M:SS`.
pub(super) fn format_media_duration(total_seconds: u64) -> Str {
	let hours = total_seconds / 3_600;
	let minutes = total_seconds % 3_600 / 60;
	let seconds = total_seconds % 60;
	if hours > 0 {
		format!("{hours}:{minutes:02}:{seconds:02}").into()
	} else {
		format!("{minutes}:{seconds:02}").into()
	}
}

/// Formats an integer with ASCII thousands separators.
pub(super) fn format_number(number: u64) -> Str {
	let digits = number.to_string();
	let mut result = String::with_capacity(digits.len() + digits.len() / 3);
	let first = digits.len() % 3;
	for (index, byte) in digits.bytes().enumerate() {
		if index != 0 && index % 3 == first {
			result.push(',');
		}
		result.push(char::from(byte));
	}
	result.into()
}
/// Formats a number with compact K/M/B notation.
pub(super) fn format_compact_number(number: u64) -> Str {
	match number {
		0..=999 => number.to_string().into(),
		1_000..=9_999 => format_tenths(number, 1_000, 'K').into(),
		10_000..=999_999 => format!("{}K", round_units(number, 1_000)).into(),
		1_000_000..=9_999_999 => format_tenths(number, 1_000_000, 'M').into(),
		10_000_000..=999_999_999 => format!("{}M", round_units(number, 1_000_000)).into(),
		1_000_000_000..=9_999_999_999 => format_tenths(number, 1_000_000_000, 'B').into(),
		_ => format!("{}B", round_units(number, 1_000_000_000)).into(),
	}
}

fn format_tenths(number: u64, divisor: u64, suffix: char) -> String {
	let tenths = ((u128::from(number) * 10 + u128::from(divisor / 2)) / u128::from(divisor)) as u64;
	if tenths.is_multiple_of(10) {
		format!("{}{suffix}", tenths / 10)
	} else {
		format!("{}.{:01}{suffix}", tenths / 10, tenths % 10)
	}
}

fn round_units(number: u64, divisor: u64) -> u64 {
	((u128::from(number) + u128::from(divisor / 2)) / u128::from(divisor)) as u64
}

#[cfg(test)]
mod tests {
	use super::{
		encode_uri_component, format_compact_number, format_iso_date, format_number,
		format_unix_date, html_to_basic_markdown, percent_decode_component,
	};

	#[test]
	fn formats_dates_and_numbers() {
		assert_eq!(format_iso_date("2026-08-14T01:02:03Z").as_str(), "2026-08-14");
		assert_eq!(format_iso_date("not a date").as_str(), "");
		assert_eq!(format_unix_date(0).as_str(), "1970-01-01");
		assert_eq!(format_number(1_234_567).as_str(), "1,234,567");
		assert_eq!(format_compact_number(999).as_str(), "999");
		assert_eq!(format_compact_number(1_234).as_str(), "1.2K");
		assert_eq!(format_compact_number(9_999).as_str(), "10K");
		assert_eq!(format_compact_number(25_000).as_str(), "25K");
		assert_eq!(format_compact_number(1_500_000).as_str(), "1.5M");
	}

	#[test]
	fn percent_decoding_is_strict() {
		assert_eq!(
			percent_decode_component("%40scope%2Fpackage+tag").as_deref(),
			Some("@scope/package+tag")
		);
		assert_eq!(percent_decode_component("%").as_deref(), None);
		assert_eq!(percent_decode_component("%GG").as_deref(), None);
		assert_eq!(percent_decode_component("%FF").as_deref(), None);
		assert_eq!(
			encode_uri_component("@scope/package+tag~!*'()"),
			"%40scope%2Fpackage%2Btag~!*'()"
		);
	}

	#[test]
	fn basic_markdown_strips_script_and_style_blocks() {
		let rendered = html_to_basic_markdown(
			"<p>before</p><SCRIPT type=\"text/javascript\">bad()</script><style>.bad { color: red \
			 }</STYLE><p>after</p>",
		)
		.expect("HTML converts");
		assert_eq!(rendered.as_str(), "before\n\nafter");
	}
}
