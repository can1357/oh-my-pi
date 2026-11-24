//! `date -d`-style date strings (absolute, relative such as `10 minutes ago`,
//! `@epoch`, zone abbreviations), shared by `date` and `find -newerXt`.

use std::{collections::HashMap, sync::LazyLock};

use jiff::{Zoned, tz::{Offset, TimeZone, TimeZoneDatabase}};
use parse_datetime::ParseDateTimeError;

/// Timezone abbreviations with known fixed UTC offsets.
/// Checked first because the abbreviation encodes the exact offset
/// (e.g., EDT always means UTC-4, even in winter when New York observes EST).
/// Offset is in seconds to support half-hour zones like IST (UTC+5:30).
/// All other timezones (JST, CET, etc.) are dynamically resolved from IANA
/// database.
static FIXED_OFFSET_ABBREVIATIONS: &[(&str, i32)] = &[
	("UTC", 0),
	("GMT", 0),
	("MEST", 7200), // UTC+2 Middle European Summer Time
	// US timezones (GNU compatible)
	("PST", -28800), // UTC-8
	("PDT", -25200), // UTC-7
	("MST", -25200), // UTC-7
	("MDT", -21600), // UTC-6
	("CST", -21600), // UTC-6 (Ambiguous: US Central, not China/Cuba)
	("CDT", -18000), // UTC-5
	("EST", -18000), // UTC-5
	("EDT", -14400), // UTC-4
	// Indian Standard Time (Ambiguous: India vs Israel vs Ireland)
	("IST", 19800), // UTC+5:30
	// Australian timezones
	("AWST", 28800), // UTC+8
	("ACST", 34200), // UTC+9:30
	("ACDT", 37800), // UTC+10:30
	("AEST", 36000), // UTC+10
	("AEDT", 39600), // UTC+11
	// German timezones
	("MEZ", 3600),  // UTC+1
	("MESZ", 7200), // UTC+2
	// Asian timezones
	("KST", 32400), // UTC+9 Korean Standard Time
];

/// Lazy-loaded timezone abbreviation lookup map built from IANA database.
static TZ_ABBREV_CACHE: LazyLock<HashMap<String, String>> = LazyLock::new(build_tz_abbrev_map);

/// Build timezone abbreviation lookup map from IANA database.
/// This is a fallback for abbreviations not covered by
/// FIXED_OFFSET_ABBREVIATIONS.
fn build_tz_abbrev_map() -> HashMap<String, String> {
	let mut map = HashMap::new();
	let tzdb = TimeZoneDatabase::bundled();

	for tz_name in tzdb.available() {
		let tz_str = tz_name.as_str();
		// Use last component as potential abbreviation
		// e.g., "Pacific/Fiji" could map to "FIJI"
		if let Some(last_part) = tz_str.split('/').next_back() {
			let potential_abbrev = last_part.to_uppercase();
			// Only add if it looks like an abbreviation (2-5 uppercase chars)
			if potential_abbrev.len() >= 2
				&& potential_abbrev.len() <= 5
				&& potential_abbrev.chars().all(|c| c.is_ascii_uppercase())
			{
				map.entry(potential_abbrev)
					.or_insert_with(|| tz_str.to_string());
			}
		}
	}

	map
}

/// Get IANA timezone name for a given abbreviation.
/// Uses lazy-loaded cache with preferred mappings for disambiguation.
fn tz_abbrev_to_iana(abbrev: &str) -> Option<&str> {
	TZ_ABBREV_CACHE.get(abbrev).map(String::as_str)
}

/// Attempts to parse a date string that contains a timezone abbreviation (e.g.
/// "EST").
///
/// If an abbreviation is found and the date is parsable, returns `Some(Zoned)`.
/// Returns `None` if no abbreviation is detected or if parsing fails,
/// indicating that standard parsing should be attempted.
fn try_parse_with_abbreviation<S: AsRef<str>>(date_str: S, now: &Zoned) -> Option<Zoned> {
	let s = date_str.as_ref();

	// Look for timezone abbreviation at the end of the string
	// Pattern: ends with uppercase letters (2-5 chars)
	if let Some(last_word) = s.split_whitespace().last() {
		// Check if it's a potential timezone abbreviation (all uppercase, 2-5 chars)
		if last_word.len() >= 2
			&& last_word.len() <= 5
			&& last_word.chars().all(|c| c.is_ascii_uppercase())
		{
			let tz = if let Some(&(_, offset_secs)) = FIXED_OFFSET_ABBREVIATIONS
				.iter()
				.find(|(abbr, _)| *abbr == last_word)
			{
				Offset::from_seconds(offset_secs).ok().map(TimeZone::fixed)
			} else {
				tz_abbrev_to_iana(last_word).and_then(|name| TimeZone::get(name).ok())
			};

			if let Some(tz) = tz {
				let date_part = s.trim_end_matches(last_word).trim();
				// Parse in the target timezone so "10:30 EDT" means 10:30 in EDT
				if let Ok(parsed) = parse_datetime::parse_datetime_at_date(now.clone(), date_part)
					&& let Some(parsed) = parsed.into_zoned()
				{
					let dt = parsed.datetime();
					if let Ok(zoned) = dt.to_zoned(tz) {
						return Some(zoned);
					}
				}
			}
		}
	}

	// No abbreviation found or couldn't resolve, return original
	None
}

/// Parse a GNU-style date relative to `now`. The second result indicates
/// whether an explicit timezone abbreviation was resolved by our extension.
pub(crate) fn parse_date(input: &str, now: &Zoned) -> Result<(Zoned, bool), ParseDateTimeError> {
	if let Some(zoned) = try_parse_with_abbreviation(input, now) {
		return Ok((zoned, true));
	}
	let zoned = parse_datetime::parse_datetime_at_date(now.clone(), input)?
		.into_zoned()
		.ok_or(ParseDateTimeError::InvalidInput)?;
	Ok((zoned, false))
}
