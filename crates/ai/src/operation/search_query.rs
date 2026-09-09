//! Google-style search query parsing and deterministic constraint lowering.

use std::{iter, mem};

use omp_core::Str;

/// One free-text search term.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct QueryTerm {
	/// Term text without operator prefixes or quotes.
	pub text:    Str,
	/// Whether the term must be matched verbatim.
	pub phrase:  bool,
	/// Whether the term is excluded.
	pub negated: bool,
	/// Contiguous OR-group identity.
	pub group:   Option<u32>,
}

/// Parsed Google-style constraints retained independently of provider syntax.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct SearchQuery {
	/// Original caller text.
	pub raw:                Str,
	/// Free-text terms after directive extraction.
	pub terms:              Vec<QueryTerm>,
	/// Included site/domain/path prefixes.
	pub sites:              Vec<Str>,
	/// Excluded site/domain/path prefixes.
	pub excluded_sites:     Vec<Str>,
	/// Required URL substrings.
	pub in_url:             Vec<Str>,
	/// Excluded URL substrings.
	pub excluded_in_url:    Vec<Str>,
	/// Required title substrings.
	pub in_title:           Vec<Str>,
	/// Excluded title substrings.
	pub excluded_in_title:  Vec<Str>,
	/// Required body substrings, retained for provider query lowering.
	pub in_text:            Vec<Str>,
	/// Excluded body substrings, retained for provider query lowering.
	pub excluded_in_text:   Vec<Str>,
	/// Included file extensions without a leading dot.
	pub filetypes:          Vec<Str>,
	/// Excluded file extensions without a leading dot.
	pub excluded_filetypes: Vec<Str>,
	/// Inclusive ISO lower date bound.
	pub after:              Option<Str>,
	/// Exclusive ISO upper date bound.
	pub before:             Option<Str>,
	/// Normalized language hint.
	pub language:           Option<Str>,
	/// Whether recognized syntax was present.
	pub has_directives:     bool,
}

impl SearchQuery {
	/// Whether any result-filterable constraint is present.
	pub const fn has_constraints(&self) -> bool {
		!self.sites.is_empty()
			|| !self.excluded_sites.is_empty()
			|| !self.in_url.is_empty()
			|| !self.excluded_in_url.is_empty()
			|| !self.in_title.is_empty()
			|| !self.excluded_in_title.is_empty()
			|| !self.filetypes.is_empty()
			|| !self.excluded_filetypes.is_empty()
			|| self.after.is_some()
			|| self.before.is_some()
	}

	/// Renders only the free-text terms, retaining phrases, exclusions and OR
	/// groups.
	pub fn text(&self) -> Str {
		Str::new(render_terms(&self.terms, QuerySyntax::GOOGLE))
	}
}

/// Search syntax supported natively by one engine.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct QuerySyntax {
	/// Quoted phrases.
	pub phrases:    bool,
	/// Negated terms.
	pub negation:   bool,
	/// OR groups.
	pub or_groups:  bool,
	/// Site directives.
	pub site:       bool,
	/// URL directives.
	pub in_url:     bool,
	/// Title directives.
	pub in_title:   bool,
	/// Body directives.
	pub in_text:    bool,
	/// File-extension directives.
	pub filetype:   bool,
	/// Date range directives.
	pub date_range: bool,
}

impl QuerySyntax {
	/// Full classic Google-style syntax.
	pub const GOOGLE: Self = Self {
		phrases:    true,
		negation:   true,
		or_groups:  true,
		site:       true,
		in_url:     true,
		in_title:   true,
		in_text:    true,
		filetype:   true,
		date_range: true,
	};
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct RawToken {
	text:         Str,
	quoted:       bool,
	quoted_value: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ConstraintField {
	Site,
	InUrl,
	InTitle,
	InText,
	Filetype,
	Before,
	After,
	Language,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AllMode {
	InUrl,
	InTitle,
	InText,
}

/// Parses a raw query without dropping unknown or malformed syntax.
pub fn parse_search_query(raw: &str) -> SearchQuery {
	let mut query = SearchQuery { raw: Str::new(raw), ..SearchQuery::default() };
	let tokens = tokenize(raw);
	let mut negate_next = false;
	let mut or_pending = false;
	let mut last_was_term = false;
	let mut group_sequence = 0_u32;
	let mut all_mode = None;
	let mut index = 0;
	while index < tokens.len() {
		let token = &tokens[index];
		if token.quoted {
			push_term(
				&mut query,
				token.text.as_str(),
				true,
				&mut negate_next,
				&mut or_pending,
				&mut last_was_term,
				&mut group_sequence,
				all_mode,
			);
			index += 1;
			continue;
		}
		match token.text.as_str() {
			"(" | ")" => {
				index += 1;
				continue;
			},
			"OR" | "|" | "||" => {
				or_pending = true;
				query.has_directives = true;
				index += 1;
				continue;
			},
			"AND" | "&&" => {
				query.has_directives = true;
				index += 1;
				continue;
			},
			"NOT" | "!" => {
				negate_next = true;
				query.has_directives = true;
				index += 1;
				continue;
			},
			"-" | "+" => {
				if token.text == "-" && tokens.get(index + 1).is_some_and(|next| next.quoted) {
					negate_next = true;
				}
				index += 1;
				continue;
			},
			_ => {},
		}

		if let Some((prefix, name, mut value)) = split_directive(token.text.as_str()) {
			if let Some(mode) = all_mode_for(name) {
				all_mode = Some(mode);
				query.has_directives = true;
				if !value.is_empty() {
					push_constraint(&mut query, mode.field(), value, prefix == '-');
				}
				or_pending = false;
				last_was_term = false;
				index += 1;
				continue;
			}
			if let Some(field) = directive_field(name) {
				if value.is_empty()
					&& let Some(next) = tokens.get(index + 1)
					&& (next.quoted || !is_reserved(next.text.as_str()))
				{
					value = next.text.as_str();
					index += 1;
				}
				if value.is_empty() {
					query.has_directives = true;
					index += 1;
					continue;
				}
				let negated = prefix == '-' || negate_next;
				negate_next = false;
				match field {
					ConstraintField::Before | ConstraintField::After => {
						if let Some(date) = parse_date_value(value) {
							if field == ConstraintField::Before {
								query.before = Some(date);
							} else {
								query.after = Some(date);
							}
							query.has_directives = true;
							or_pending = false;
							last_was_term = false;
						} else {
							push_term(
								&mut query,
								token.text.as_str(),
								false,
								&mut negate_next,
								&mut or_pending,
								&mut last_was_term,
								&mut group_sequence,
								all_mode,
							);
						}
					},
					ConstraintField::Language => {
						query.language = Some(Str::new(value.to_ascii_lowercase()));
						query.has_directives = true;
						or_pending = false;
						last_was_term = false;
					},
					_ => push_constraint(&mut query, field, value, negated),
				}
				index += 1;
				continue;
			}
		}

		let mut text = token.text.as_str();
		if text.starts_with('-') && text.len() > 1 {
			query.has_directives = true;
			negate_next = true;
			text = text.trim_start_matches('-');
			if let Some((_, name, value)) = split_directive(text)
				&& let Some(field) = directive_field(name)
				&& !matches!(
					field,
					ConstraintField::Before | ConstraintField::After | ConstraintField::Language
				) {
				negate_next = false;
				push_constraint(&mut query, field, value, true);
				index += 1;
				continue;
			}
		} else if text.starts_with('+') && text.len() > 1 {
			query.has_directives = true;
			push_term(
				&mut query,
				&text[1..],
				true,
				&mut negate_next,
				&mut or_pending,
				&mut last_was_term,
				&mut group_sequence,
				all_mode,
			);
			index += 1;
			continue;
		}
		if !text.is_empty() {
			push_term(
				&mut query,
				text,
				false,
				&mut negate_next,
				&mut or_pending,
				&mut last_was_term,
				&mut group_sequence,
				all_mode,
			);
		}
		index += 1;
	}
	query
}

/// Parses flexible date spellings into validated ISO `YYYY-MM-DD`.
pub fn parse_date_value(value: &str) -> Option<Str> {
	let value = value.trim();
	let parts = value
		.split(['-', '/', '.'])
		.map(|part| part.parse::<u32>().ok())
		.collect::<Option<Vec<_>>>()?;
	let (year, mut month, mut day) = match parts.as_slice() {
		[year] if value.len() == 4 => (*year, 1, 1),
		[year, month]
			if value
				.as_bytes()
				.get(4)
				.is_some_and(|byte| matches!(byte, b'-' | b'/' | b'.')) =>
		{
			(*year, *month, 1)
		},
		[year, month, day]
			if value
				.as_bytes()
				.get(4)
				.is_some_and(|byte| matches!(byte, b'-' | b'/' | b'.')) =>
		{
			(*year, *month, *day)
		},
		[first, second, year] => (*year, *first, *second),
		_ => return None,
	};
	if month > 12 && day <= 12 {
		mem::swap(&mut month, &mut day);
	}
	if !(1000..=9999).contains(&year) || !(1..=12).contains(&month) {
		return None;
	}
	let leap = year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400));
	let days = match month {
		2 if leap => 29,
		2 => 28,
		4 | 6 | 9 | 11 => 30,
		_ => 31,
	};
	if day == 0 || day > days {
		return None;
	}
	Some(Str::new(format!("{year:04}-{month:02}-{day:02}")))
}

/// Rebuilds a query using only syntax supported by an engine.
pub fn format_query(query: &SearchQuery, syntax: QuerySyntax) -> Str {
	let mut parts = Vec::new();
	let text = render_terms(&query.terms, syntax);
	if !text.is_empty() {
		parts.push(text);
	}
	if syntax.site {
		if query.sites.len() > 1 && syntax.or_groups {
			parts.push(format!(
				"({})",
				query
					.sites
					.iter()
					.map(|site| format!("site:{site}"))
					.collect::<Vec<_>>()
					.join(" OR ")
			));
		} else {
			parts.extend(query.sites.iter().map(|site| format!("site:{site}")));
		}
		parts.extend(
			query
				.excluded_sites
				.iter()
				.map(|site| format!("-site:{site}")),
		);
	}
	append_directives(&mut parts, syntax.in_url, "inurl", &query.in_url, &query.excluded_in_url);
	append_directives(
		&mut parts,
		syntax.in_title,
		"intitle",
		&query.in_title,
		&query.excluded_in_title,
	);
	append_directives(&mut parts, syntax.in_text, "intext", &query.in_text, &query.excluded_in_text);
	append_directives(
		&mut parts,
		syntax.filetype,
		"filetype",
		&query.filetypes,
		&query.excluded_filetypes,
	);
	if syntax.date_range {
		if let Some(after) = &query.after {
			parts.push(format!("after:{after}"));
		}
		if let Some(before) = &query.before {
			parts.push(format!("before:{before}"));
		}
	}
	if parts.is_empty() {
		parts.extend(
			query
				.sites
				.iter()
				.chain(&query.in_title)
				.chain(&query.in_url)
				.chain(&query.in_text)
				.chain(&query.filetypes)
				.map(ToString::to_string),
		);
	}
	let rendered = parts.join(" ");
	if rendered.trim().is_empty() {
		query.raw.clone()
	} else {
		Str::new(rendered)
	}
}

fn tokenize(raw: &str) -> Vec<RawToken> {
	let chars = raw.chars().collect::<Vec<_>>();
	let mut tokens = Vec::new();
	let mut index = 0;
	while index < chars.len() {
		while index < chars.len() && chars[index].is_whitespace() {
			index += 1;
		}
		if index == chars.len() {
			break;
		}
		if is_quote(chars[index]) {
			index += 1;
			let mut value = String::new();
			while index < chars.len() && !is_quote(chars[index]) {
				value.push(chars[index]);
				index += 1;
			}
			if index < chars.len() {
				index += 1;
			}
			if !value.trim().is_empty() {
				tokens.push(RawToken {
					text:         Str::new(value.trim()),
					quoted:       true,
					quoted_value: false,
				});
			}
			continue;
		}
		let mut value = String::new();
		let mut quoted_value = false;
		while index < chars.len() && !chars[index].is_whitespace() {
			if is_quote(chars[index]) && value.ends_with(':') {
				index += 1;
				while index < chars.len() && !is_quote(chars[index]) {
					value.push(chars[index]);
					index += 1;
				}
				quoted_value = true;
				if index < chars.len() {
					index += 1;
				}
				continue;
			}
			if is_quote(chars[index]) {
				break;
			}
			value.push(chars[index]);
			index += 1;
		}
		if !value.is_empty() {
			for token in split_parens(&value) {
				tokens.push(RawToken { text: Str::new(token), quoted: false, quoted_value });
			}
		}
	}
	tokens
}

fn split_parens(value: &str) -> Vec<&str> {
	let mut output = Vec::new();
	let mut value = value;
	while let Some(rest) = value.strip_prefix('(') {
		output.push("(");
		value = rest;
	}
	let mut trailing = 0;
	while let Some(body) = value.strip_suffix(')') {
		let depth = body
			.chars()
			.fold(0_i32, |depth, character| match character {
				'(' => depth + 1,
				')' => depth - 1,
				_ => depth,
			});
		if depth > 0 {
			break;
		}
		value = body;
		trailing += 1;
	}
	if !value.is_empty() {
		output.push(value);
	}
	output.extend(iter::repeat_n(")", trailing));
	output
}

const fn is_quote(character: char) -> bool {
	matches!(character, '"' | '\u{201c}' | '\u{201d}')
}

fn split_directive(token: &str) -> Option<(char, &str, &str)> {
	let (prefix, token) = match token.as_bytes().first().copied() {
		Some(b'+' | b'-') => (token.as_bytes()[0] as char, &token[1..]),
		_ => ('\0', token),
	};
	let (name, value) = token.split_once(':')?;
	if name.is_empty()
		|| !name
			.bytes()
			.enumerate()
			.all(|(index, byte)| byte.is_ascii_alphabetic() || (index > 0 && byte == b'-'))
	{
		return None;
	}
	Some((prefix, name, value))
}

const fn directive_field(name: &str) -> Option<ConstraintField> {
	if name.eq_ignore_ascii_case("site")
		|| name.eq_ignore_ascii_case("domain")
		|| name.eq_ignore_ascii_case("host")
	{
		Some(ConstraintField::Site)
	} else if name.eq_ignore_ascii_case("inurl") || name.eq_ignore_ascii_case("url") {
		Some(ConstraintField::InUrl)
	} else if name.eq_ignore_ascii_case("intitle") || name.eq_ignore_ascii_case("title") {
		Some(ConstraintField::InTitle)
	} else if name.eq_ignore_ascii_case("intext")
		|| name.eq_ignore_ascii_case("inbody")
		|| name.eq_ignore_ascii_case("inanchor")
	{
		Some(ConstraintField::InText)
	} else if name.eq_ignore_ascii_case("filetype") || name.eq_ignore_ascii_case("ext") {
		Some(ConstraintField::Filetype)
	} else if name.eq_ignore_ascii_case("before") || name.eq_ignore_ascii_case("until") {
		Some(ConstraintField::Before)
	} else if name.eq_ignore_ascii_case("after") || name.eq_ignore_ascii_case("since") {
		Some(ConstraintField::After)
	} else if name.eq_ignore_ascii_case("lang") || name.eq_ignore_ascii_case("language") {
		Some(ConstraintField::Language)
	} else {
		None
	}
}

const fn all_mode_for(name: &str) -> Option<AllMode> {
	if name.eq_ignore_ascii_case("allinurl") {
		Some(AllMode::InUrl)
	} else if name.eq_ignore_ascii_case("allintitle") {
		Some(AllMode::InTitle)
	} else if name.eq_ignore_ascii_case("allintext") {
		Some(AllMode::InText)
	} else {
		None
	}
}

impl AllMode {
	const fn field(self) -> ConstraintField {
		match self {
			Self::InUrl => ConstraintField::InUrl,
			Self::InTitle => ConstraintField::InTitle,
			Self::InText => ConstraintField::InText,
		}
	}
}

fn is_reserved(token: &str) -> bool {
	matches!(token, "(" | ")" | "OR" | "AND" | "NOT" | "|" | "||" | "&&" | "!")
		|| split_directive(token).is_some_and(|(_, name, _)| {
			directive_field(name).is_some() || all_mode_for(name).is_some()
		})
}

fn push_constraint(query: &mut SearchQuery, field: ConstraintField, value: &str, negated: bool) {
	let value = value.trim();
	if value.is_empty() {
		return;
	}
	query.has_directives = true;
	let target = match (field, negated) {
		(ConstraintField::Site, false) => &mut query.sites,
		(ConstraintField::Site, true) => &mut query.excluded_sites,
		(ConstraintField::InUrl, false) => &mut query.in_url,
		(ConstraintField::InUrl, true) => &mut query.excluded_in_url,
		(ConstraintField::InTitle, false) => &mut query.in_title,
		(ConstraintField::InTitle, true) => &mut query.excluded_in_title,
		(ConstraintField::InText, false) => &mut query.in_text,
		(ConstraintField::InText, true) => &mut query.excluded_in_text,
		(ConstraintField::Filetype, false) => &mut query.filetypes,
		(ConstraintField::Filetype, true) => &mut query.excluded_filetypes,
		_ => return,
	};
	let normalized = match field {
		ConstraintField::Site => normalize_site(value),
		ConstraintField::Filetype => value.trim_start_matches('.').to_ascii_lowercase(),
		_ => value.to_owned(),
	};
	if !normalized.is_empty() {
		target.push(Str::new(normalized));
	}
}

#[allow(clippy::too_many_arguments, reason = "parser state is explicit and allocation-free")]
fn push_term(
	query: &mut SearchQuery,
	text: &str,
	phrase: bool,
	negate_next: &mut bool,
	or_pending: &mut bool,
	last_was_term: &mut bool,
	group_sequence: &mut u32,
	all_mode: Option<AllMode>,
) {
	let negated = mem::take(negate_next);
	if let Some(mode) = all_mode {
		push_constraint(query, mode.field(), text, negated);
		return;
	}
	let mut term = QueryTerm { text: Str::new(text), phrase, negated, group: None };
	if *or_pending
		&& *last_was_term
		&& let Some(previous) = query.terms.last_mut()
	{
		let group = *previous.group.get_or_insert_with(|| {
			*group_sequence = group_sequence.saturating_add(1);
			*group_sequence
		});
		term.group = Some(group);
	}
	*or_pending = false;
	*last_was_term = true;
	query.terms.push(term);
}

fn normalize_site(value: &str) -> String {
	let mut site = value.trim().to_ascii_lowercase();
	if let Some((_, rest)) = site.split_once("://") {
		site = rest.to_owned();
	}
	if let Some(rest) = site.strip_prefix("*.") {
		site = rest.to_owned();
	}
	site.trim_end_matches(['/', '.']).to_owned()
}

fn render_terms(terms: &[QueryTerm], syntax: QuerySyntax) -> String {
	let mut parts = Vec::new();
	let mut index = 0;
	while index < terms.len() {
		let term = &terms[index];
		if let Some(group) = term.group
			&& syntax.or_groups
		{
			let mut members = Vec::new();
			while index < terms.len() && terms[index].group == Some(group) {
				if let Some(member) = render_term(&terms[index], syntax) {
					members.push(member);
				}
				index += 1;
			}
			if members.len() > 1 {
				parts.push(format!("({})", members.join(" OR ")));
			} else {
				parts.extend(members);
			}
			continue;
		}
		if let Some(rendered) = render_term(term, syntax) {
			parts.push(rendered);
		}
		index += 1;
	}
	parts.join(" ")
}

fn render_term(term: &QueryTerm, syntax: QuerySyntax) -> Option<String> {
	if term.negated && !syntax.negation {
		return None;
	}
	let body = if term.phrase && syntax.phrases {
		format!("\"{}\"", term.text)
	} else {
		term.text.to_string()
	};
	Some(if term.negated {
		format!("-{body}")
	} else {
		body
	})
}

fn append_directives(
	parts: &mut Vec<String>,
	enabled: bool,
	name: &str,
	included: &[Str],
	excluded: &[Str],
) {
	if !enabled {
		return;
	}
	parts.extend(
		included
			.iter()
			.map(|value| format!("{name}:{}", quote_value(value))),
	);
	parts.extend(
		excluded
			.iter()
			.map(|value| format!("-{name}:{}", quote_value(value))),
	);
}

fn quote_value(value: &str) -> String {
	if value.chars().any(char::is_whitespace) {
		format!("\"{value}\"")
	} else {
		value.to_owned()
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn parses_aliases_phrases_groups_exclusions_and_dates() {
		let query = parse_search_query(
			"\"rust tower\" +exact foo OR bar -noise site:https://*.Example.COM/docs \
			 -domain:blocked.test inurl:api -title:draft filetype:.PDF after:2024/2/29 \
			 until:03/04/2025 lang:EN-us",
		);
		assert_eq!(query.text(), "\"rust tower\" \"exact\" (foo OR bar) -noise");
		assert_eq!(query.sites, [Str::new_static("example.com/docs")]);
		assert_eq!(query.excluded_sites, [Str::new_static("blocked.test")]);
		assert_eq!(query.in_url, [Str::new_static("api")]);
		assert_eq!(query.excluded_in_title, [Str::new_static("draft")]);
		assert_eq!(query.filetypes, [Str::new_static("pdf")]);
		assert_eq!(query.after.as_deref(), Some("2024-02-29"));
		assert_eq!(query.before.as_deref(), Some("2025-03-04"));
		assert_eq!(query.language.as_deref(), Some("en-us"));
		assert!(query.has_constraints());
	}

	#[test]
	fn malformed_dates_and_unknown_directives_remain_terms() {
		let query = parse_search_query("before:2023-02-29 TS2345:error https://example.test");
		assert_eq!(query.before, None);
		assert_eq!(
			query
				.terms
				.iter()
				.map(|term| term.text.as_str())
				.collect::<Vec<_>>(),
			["before:2023-02-29", "TS2345:error", "https://example.test"]
		);
	}

	#[test]
	fn formats_only_supported_syntax_with_nonempty_fallback() {
		let query = parse_search_query("site:example.test intitle:\"release notes\"");
		assert_eq!(format_query(&query, QuerySyntax::default()), "example.test release notes");
		assert_eq!(
			format_query(&query, QuerySyntax::GOOGLE),
			"site:example.test intitle:\"release notes\""
		);
	}
}
