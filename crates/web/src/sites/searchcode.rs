//! searchcode.com. A `/codesearch/view/<id>` page is one snippet from the
//! `result` API; a search page is one query against the `codesearch_I` API.

use std::fmt::Write as _;

use serde_json::Value;
use url::Url;

use super::{Action, Context, Done, Fetch, Site, arr_of, fetch, format_number, segment, str_of};

/// Registry entry.
pub const SITE: Site = Site { name: "searchcode", open };

const METHOD: &str = "searchcode";
/// Results rendered on a search page.
const MAX_RESULTS: usize = 10;
/// Line numbers listed before they collapse to a range.
const MAX_LISTED_LINES: usize = 10;

fn open(url: &Url, _: &Context) -> Option<Action> {
	if !matches!(url.host_str()?, "searchcode.com" | "www.searchcode.com") {
		return None;
	}
	let path = url.path();
	if let Some(id) = path
		.strip_prefix("/codesearch/view/")
		.and_then(|rest| rest.split('/').next())
		.filter(|id| !id.is_empty())
	{
		return snippet(id);
	}
	let query = url
		.query_pairs()
		.find(|(key, _)| key == "q")
		.map(|(_, value)| value.into_owned())?;
	if query.is_empty() || !matches!(path, "/" | "/codesearch" | "/codesearch/") {
		return None;
	}
	let page = ["p", "page"]
		.iter()
		.find_map(|key| {
			url.query_pairs()
				.find(|(name, _)| name == *key)
				.map(|(_, value)| value.into_owned())
		})
		.filter(|value| !value.is_empty())
		.and_then(|value| leading_int(&value))
		.filter(|page| *page >= 0)
		.map_or(0, |page| page as u64);
	let api = format!("https://searchcode.com/api/codesearch_I/?q={}&p={page}", segment(&query));
	fetch(Fetch::get(api).accept_json(), move |reply, _| {
		let data = reply.json_value()?;
		let results = arr_of(&data, "results");
		let total = number(&data, "total").or_else(|| number(&data, "total_results"));
		let mut md = format!(
			"# Searchcode Results\n\n## Description\n\nSearch results for `{query}` on \
			 searchcode.com.\n\n## Metadata\n\n**Query:** `{query}`\n**Page:** {page}\n"
		);
		if let Some(total) = total {
			let _ = writeln!(md, "**Total Results:** {}", format_number(total));
		}
		let _ = writeln!(md, "**Result Count:** {}", results.len());
		if let Some(next) = number(&data, "nextpage") {
			let _ = writeln!(md, "**Next Page:** {}", count_text(next));
		}
		md.push_str("\n## Results\n\n");
		if results.is_empty() {
			md.push_str("_No results found._\n");
		} else {
			for result in results.iter().take(MAX_RESULTS) {
				write_result(&mut md, result);
			}
			if results.len() > MAX_RESULTS {
				let _ = writeln!(md, "\n_Only showing first {MAX_RESULTS} results._");
			}
		}
		Done::new(md, METHOD)
			.title("Searchcode Results")
			.note("Fetched via searchcode API")
			.finish()
	})
}

/// A single snippet from the `result` API.
fn snippet(id: &str) -> Option<Action> {
	let request =
		Fetch::get(format!("https://searchcode.com/api/result/{}/", segment(id))).accept_json();
	let id = id.to_owned();
	fetch(request, move |reply, _| {
		let data = reply.json_value()?;
		let filename = str_of(&data, "filename")
			.or_else(|| str_of(&data, "location"))
			.map_or_else(|| format!("Result {id}"), str::to_owned);
		let lines = parse_lines(data.get("lines"));
		let view_url = str_of(&data, "url")
			.map_or_else(|| format!("https://searchcode.com/codesearch/view/{id}"), str::to_owned);
		let mut md = format!(
			"# {filename}\n\n## Description\n\nCode snippet from searchcode.com.\n\n## Metadata\n\n"
		);
		for (label, value) in [
			("Repository", str_of(&data, "repo")),
			("Language", str_of(&data, "language")),
			("File", str_of(&data, "filename")),
			("Location", str_of(&data, "location")),
		] {
			if let Some(value) = value {
				let _ = writeln!(md, "**{label}:** {value}");
			}
		}
		if let Some(formatted) = format_lines(&lines) {
			let _ = writeln!(md, "**Lines:** {formatted}");
		}
		let _ = writeln!(md, "**Result ID:** {id}");
		let _ = writeln!(md, "**URL:** {view_url}");
		md.push_str("\n## Snippet");
		match code_block(&data, &lines) {
			Some(block) => md.push_str(&block),
			None => md.push_str("\n\n_No snippet available._\n"),
		}
		Done::new(md, METHOD)
			.title(filename)
			.note("Fetched via searchcode API")
			.finish()
	})
}

/// One result of a search page.
fn write_result(md: &mut String, result: &Value) {
	let filename = str_of(result, "filename")
		.or_else(|| str_of(result, "location"))
		.unwrap_or("Result");
	let lines = parse_lines(result.get("lines"));
	let id = result_id(result);
	let view_url = str_of(result, "url").map(str::to_owned).or_else(|| {
		id.as_ref()
			.map(|id| format!("https://searchcode.com/codesearch/view/{id}"))
	});
	let _ = writeln!(md, "### {filename}\n");
	for (label, value) in [
		("Repository", str_of(result, "repo")),
		("Language", str_of(result, "language")),
		("File", str_of(result, "filename")),
		("Location", str_of(result, "location")),
	] {
		if let Some(value) = value {
			let _ = writeln!(md, "**{label}:** {value}");
		}
	}
	if let Some(formatted) = format_lines(&lines) {
		let _ = writeln!(md, "**Lines:** {formatted}");
	}
	if let Some(view_url) = view_url {
		let _ = writeln!(md, "**URL:** {view_url}");
	}
	if let Some(block) = code_block(result, &lines) {
		let _ = writeln!(md, "{block}");
	}
	md.push('\n');
}

/// The id of a result, whether the API sent it as a number or a string.
fn result_id(result: &Value) -> Option<String> {
	match result.get("id")? {
		Value::String(text) => Some(text.clone()),
		Value::Number(number) => Some(number.to_string()),
		_ => None,
	}
}

/// The number at `key` (`null` and non-numbers are absent).
fn number(value: &Value, key: &str) -> Option<f64> {
	value.get(key)?.as_f64()
}

/// A number rendered without a thousands suffix (page numbers, not counts).
fn count_text(value: f64) -> String {
	if value.fract() == 0.0 {
		format!("{}", value as i64)
	} else {
		value.to_string()
	}
}

/// The integer at the start of `text`, like `Number.parseInt(text, 10)`.
fn leading_int(text: &str) -> Option<i64> {
	let trimmed = text.trim_start();
	let (negative, digits) = match trimmed.strip_prefix('-') {
		Some(rest) => (true, rest),
		None => (false, trimmed),
	};
	let digits: String = digits.chars().take_while(|c| c.is_ascii_digit()).collect();
	let value: i64 = digits.parse().ok()?;
	Some(if negative { -value } else { value })
}

/// The line numbers the API sent as a number, a string or an array.
fn parse_lines(value: Option<&Value>) -> Vec<i64> {
	let Some(value) = value else {
		return Vec::new();
	};
	let entry = |item: &Value| {
		item
			.as_i64()
			.or_else(|| item.as_f64().map(|number| number as i64))
			.or_else(|| item.as_str().and_then(leading_int))
	};
	let mut lines = Vec::new();
	match value {
		Value::Array(items) => lines.extend(items.iter().filter_map(entry)),
		Value::String(text) => {
			lines.extend(
				text
					.split(|c: char| c == ',' || c.is_whitespace())
					.filter(|part| !part.is_empty())
					.filter_map(leading_int),
			);
		},
		_ => lines.extend(entry(value)),
	}
	lines
}

fn format_lines(lines: &[i64]) -> Option<String> {
	match lines.len() {
		0 => None,
		len if len <= MAX_LISTED_LINES => Some(
			lines
				.iter()
				.map(i64::to_string)
				.collect::<Vec<_>>()
				.join(", "),
		),
		len => Some(format!("{}-{} ({len} lines)", lines.iter().min()?, lines.iter().max()?)),
	}
}

/// A fenced code block, with each line prefixed by its number when the API
/// sent one number per line.
fn code_block(data: &Value, lines: &[i64]) -> Option<String> {
	let code = str_of(data, "code")?;
	let code_lines: Vec<&str> = code
		.trim_end()
		.split('\n')
		.map(|line| line.trim_end_matches('\r'))
		.collect();
	let language =
		str_of(data, "language").map_or_default(|language| language.trim().to_lowercase());
	let body = if lines.len() == code_lines.len() {
		code_lines
			.iter()
			.zip(lines)
			.map(|(line, number)| format!("{number}: {line}"))
			.collect::<Vec<_>>()
			.join("\n")
	} else {
		code_lines.join("\n")
	};
	Some(format!("\n\n```{language}\n{body}\n```\n"))
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::super::{Fetched, testing::run};

	#[test]
	fn a_snippet_page_numbers_the_lines_the_api_labelled() {
		let snippet = json!({
			"filename": "hello.py", "repo": "octo/repo", "language": "Python",
			"code": "print('a')\r\nprint('b')", "lines": [10, 11]
		});
		let mut requests = Vec::new();
		let done = run("https://searchcode.com/codesearch/view/42", |request| {
			requests.push(request.url.clone());
			Fetched::json(&snippet)
		})
		.unwrap();
		assert_eq!(requests, ["https://searchcode.com/api/result/42/"]);
		assert_eq!((done.method, done.title.as_deref()), ("searchcode", Some("hello.py")));
		let md = &done.markdown;
		assert!(md.starts_with(
			"# hello.py\n\n## Description\n\nCode snippet from searchcode.com.\n\n## Metadata\n\n"
		));
		assert!(md.contains(
			"**Repository:** octo/repo\n**Language:** Python\n**File:** hello.py\n**Lines:** 10, \
			 11\n**Result ID:** 42\n"
		));
		assert!(md.contains(
			"**URL:** https://searchcode.com/codesearch/view/42\n\n## Snippet\n\n```python\n10: \
			 print('a')\n11: print('b')\n```\n"
		));
		assert_eq!(done.notes, ["Fetched via searchcode API"]);
	}

	#[test]
	fn a_search_page_lists_ten_results_and_collapses_long_line_lists() {
		let results: Vec<serde_json::Value> = (0..11)
			.map(|index| {
				json!({
					"id": index, "filename": format!("file{index}.rs"),
					"lines": "1 2 3 4 5 6 7 8 9 10 11", "code": "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk"
				})
			})
			.collect();
		let mut requests = Vec::new();
		let done = run("https://searchcode.com/codesearch?q=foo&p=1", |request| {
			requests.push(request.url.clone());
			Fetched::json(&json!({ "results": results, "total_results": 200, "nextpage": 2 }))
		})
		.unwrap();
		assert_eq!(requests, ["https://searchcode.com/api/codesearch_I/?q=foo&p=1"]);
		let md = &done.markdown;
		assert!(md.contains(
			"**Query:** `foo`\n**Page:** 1\n**Total Results:** 200\n**Result Count:** 11\n**Next \
			 Page:** 2\n\n## Results\n\n"
		));
		assert!(md.contains("### file0.rs\n\n**File:** file0.rs\n**Lines:** 1-11 (11 lines)\n**URL:** https://searchcode.com/codesearch/view/0\n"));
		assert!(md.contains("### file9.rs\n"));
		assert!(!md.contains("### file10.rs\n"));
		assert!(md.contains("\n_Only showing first 10 results._\n"));
		assert_eq!(done.title.as_deref(), Some("Searchcode Results"));
	}

	#[test]
	fn other_pages_and_api_failures_fall_through() {
		assert_eq!(run("https://searchcode.com/about?q=foo", |_| panic!("no fetch expected")), None);
		assert_eq!(
			run("https://example.test/codesearch?q=foo", |_| panic!("no fetch expected")),
			None
		);
		assert_eq!(run("https://searchcode.com/codesearch/view/42", |_| Fetched::status(500)), None);
	}
}
