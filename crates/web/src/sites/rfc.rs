//! RFC Editor (`rfc-editor.org`, `datatracker.ietf.org`, `tools.ietf.org`):
//! RFC metadata from the RFC Editor JSON API and the plain-text document.

use std::fmt::Write as _;

use serde_json::Value;
use url::Url;

use super::{Action, Context, Done, Fetch, Site, arr_of, fetch, str_of, strs_of, u64_of};

/// Registry entry.
pub const SITE: Site = Site { name: "rfc", open };

const METHOD: &str = "rfc";
const EDITOR: &str = "https://www.rfc-editor.org/rfc";

fn open(url: &Url, _: &Context) -> Option<Action> {
	let number = number(url)?;
	fetch(Fetch::get(format!("{EDITOR}/rfc{number}.txt")), move |reply, _| {
		let text = reply.body_text()?;
		fetch(Fetch::get(format!("{EDITOR}/rfc{number}.json")).accept_json(), move |reply, _| {
			let metadata = reply.json_value().filter(Value::is_object);
			document(&number, metadata.as_ref(), &text).finish()
		})
	})
}

/// The RFC number a supported URL names.
fn number(url: &Url) -> Option<String> {
	let path = url.path();
	match url.host_str()? {
		"www.rfc-editor.org" | "rfc-editor.org" => {
			let rest = path.strip_prefix("/rfc/rfc")?;
			if let Some(number) = [".html", ".txt", ".pdf"]
				.iter()
				.find_map(|suffix| strip_suffix(rest, suffix))
			{
				return digits(number);
			}
			digits(rest)
		},
		"datatracker.ietf.org" => {
			let rest = path
				.strip_prefix("/doc/html/")
				.or_else(|| path.strip_prefix("/doc/"))?;
			let rest = strip_prefix(rest, "rfc")?;
			digits(rest.strip_suffix('/').unwrap_or(rest))
		},
		"tools.ietf.org" => digits(path.strip_prefix("/html/rfc")?),
		_ => None,
	}
}

/// `text` without a case-insensitive `suffix`, when it ends with one.
fn strip_suffix<'a>(text: &'a str, suffix: &str) -> Option<&'a str> {
	let length = text.len().checked_sub(suffix.len())?;
	text
		.get(length..)?
		.eq_ignore_ascii_case(suffix)
		.then(|| &text[..length])
}

/// `text` without a case-insensitive `prefix`, when it starts with one.
fn strip_prefix<'a>(text: &'a str, prefix: &str) -> Option<&'a str> {
	text
		.get(..prefix.len())
		.filter(|head| head.eq_ignore_ascii_case(prefix))
		.map(|_| &text[prefix.len()..])
}

fn digits(text: &str) -> Option<String> {
	(!text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit())).then(|| text.to_owned())
}

/// Markdown header (from `metadata` when the JSON API answered) and full text.
fn document(number: &str, metadata: Option<&Value>, text: &str) -> Done {
	let mut md = String::new();
	let note;
	if let Some(metadata) = metadata {
		note = "Metadata from RFC Editor JSON API";
		let _ =
			write!(md, "# RFC {number}: {}\n\n", str_of(metadata, "title").unwrap_or("(untitled)"));
		let authors: Vec<String> = arr_of(metadata, "authors")
			.iter()
			.map(|author| match str_of(author, "affiliation") {
				Some(affiliation) => {
					format!("{} ({affiliation})", str_of(author, "name").unwrap_or(""))
				},
				None => str_of(author, "name").unwrap_or("").to_owned(),
			})
			.collect();
		if !authors.is_empty() {
			let _ = writeln!(md, "**Authors:** {}", authors.join(", "));
		}
		if let Some(date) = str_of(metadata, "pub_date") {
			let _ = writeln!(md, "**Published:** {date}");
		}
		if let Some(status) = str_of(metadata, "current_status") {
			let _ = writeln!(md, "**Status:** {status}");
		}
		if let Some(stream) = str_of(metadata, "stream") {
			let _ = writeln!(md, "**Stream:** {stream}");
		}
		if let Some(area) = str_of(metadata, "area") {
			let _ = writeln!(md, "**Area:** {area}");
		}
		if let Some(group) = str_of(metadata, "wg_acronym") {
			let _ = writeln!(md, "**Working Group:** {group}");
		}
		if let Some(pages) = u64_of(metadata, "page_count").filter(|pages| *pages > 0) {
			let _ = writeln!(md, "**Pages:** {pages}");
		}
		for (key, label) in [
			("obsoletes", "Obsoletes"),
			("obsoleted_by", "Obsoleted by"),
			("updates", "Updates"),
			("updated_by", "Updated by"),
		] {
			let values = strs_of(metadata, key);
			if !values.is_empty() {
				let _ = writeln!(md, "**{label}:** {}", values.join(", "));
			}
		}
		let keywords = strs_of(metadata, "keywords");
		if !keywords.is_empty() {
			let _ = writeln!(md, "**Keywords:** {}", keywords.join(", "));
		}
		if let Some(errata) = str_of(metadata, "errata_url") {
			let _ = writeln!(md, "**Errata:** {errata}");
		}
		md.push('\n');
		if let Some(abstract_) = str_of(metadata, "abstract") {
			let _ = write!(md, "## Abstract\n\n{abstract_}\n\n");
		}
		md.push_str("---\n\n");
	} else {
		note = "Metadata not available, showing plain text only";
		let _ = write!(md, "# RFC {number}\n\n");
	}

	md.push_str("## Full Text\n\n```\n");
	md.push_str(&clean_rfc_text(text));
	md.push_str("\n```\n");

	Done::new(md, METHOD)
		.url(format!("{EDITOR}/rfc{number}"))
		.note(note)
}

/// Drop form feeds with the page header that follows them and `[Page N]`
/// footers, then cap blank-line runs at three newlines.
fn clean_rfc_text(text: &str) -> String {
	let mut cleaned: Vec<&str> = Vec::new();
	let mut skip = 0;
	for line in text.split('\n') {
		if skip > 0 {
			skip -= 1;
			continue;
		}
		if line.contains('\u{c}') {
			skip = 3;
			continue;
		}
		if is_page_footer(line) {
			continue;
		}
		cleaned.push(line);
	}
	collapse_newlines(&cleaned.join("\n"), 3)
}

fn is_page_footer(line: &str) -> bool {
	let line = line.trim();
	let Some(rest) = line.strip_prefix("[Page ") else {
		return false;
	};
	let Some(number) = rest.strip_suffix(']') else {
		return false;
	};
	!number.is_empty() && number.bytes().all(|byte| byte.is_ascii_digit())
}

fn collapse_newlines(text: &str, max: usize) -> String {
	let mut out = String::with_capacity(text.len());
	let mut run = 0;
	for character in text.chars() {
		if character == '\n' {
			run += 1;
			if run <= max {
				out.push(character);
			}
		} else {
			run = 0;
			out.push(character);
		}
	}
	out
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::super::{Fetched, testing::run};

	#[test]
	fn an_rfc_reads_metadata_and_plain_text() {
		let text =
			"Intro line\n\n\x0cRFC 2616  HTTP/1.1  June 1999\n\nBody line\n\n\n\n\n[Page 2]\nTail\n";
		let mut requests = Vec::new();
		let done = run("https://www.rfc-editor.org/rfc/rfc2616.html", |request| {
			requests.push(request.url.clone());
			if std::path::Path::new(&request.url)
				.extension()
				.is_some_and(|ext| ext.eq_ignore_ascii_case("json"))
			{
				Fetched::json(&json!({
					"title": "Hypertext Transfer Protocol -- HTTP/1.1",
					"authors": [{ "name": "R. Fielding", "affiliation": "UC Irvine" }, { "name": "J. Gettys" }],
					"pub_date": "June 1999", "current_status": "Draft Standard", "stream": "IETF",
					"area": "Applications", "wg_acronym": "httpwg", "page_count": 176,
					"obsoletes": ["2068"], "updated_by": ["7230"], "keywords": ["HTTP"],
					"abstract": "The Hypertext Transfer Protocol."
				}))
			} else {
				Fetched::text("text/plain", text)
			}
		})
		.unwrap();
		assert_eq!(requests, [
			"https://www.rfc-editor.org/rfc/rfc2616.txt",
			"https://www.rfc-editor.org/rfc/rfc2616.json"
		]);
		assert_eq!(done.method, "rfc");
		assert_eq!(done.url.as_deref(), Some("https://www.rfc-editor.org/rfc/rfc2616"));
		let md = &done.markdown;
		assert!(md.starts_with(
			"# RFC 2616: Hypertext Transfer Protocol -- HTTP/1.1\n\n**Authors:** R. Fielding (UC \
			 Irvine), J. Gettys\n**Published:** June 1999\n**Status:** Draft Standard\n**Stream:** \
			 IETF\n**Area:** Applications\n**Working Group:** httpwg\n**Pages:** 176\n**Obsoletes:** \
			 2068\n**Updated by:** 7230\n**Keywords:** HTTP\n\n## Abstract\n\nThe Hypertext Transfer \
			 Protocol.\n\n---\n\n## Full Text\n\n```\n"
		));
		assert!(md.contains("```\nIntro line\n\n\nTail\n"));
		assert!(!md.contains('\u{c}') && !md.contains("[Page 2]"));
		assert!(!md.contains("\n\n\n\n"));
		assert_eq!(done.notes, ["Metadata from RFC Editor JSON API"]);
	}

	#[test]
	fn all_supported_url_shapes_match() {
		for url in [
			"https://rfc-editor.org/rfc/rfc1",
			"https://datatracker.ietf.org/doc/rfc1/",
			"https://datatracker.ietf.org/doc/html/rfc1",
			"https://tools.ietf.org/html/rfc1",
		] {
			let done = run(url, |request| {
				assert!(
					request
						.url
						.starts_with("https://www.rfc-editor.org/rfc/rfc1")
				);
				if std::path::Path::new(&request.url)
					.extension()
					.is_some_and(|ext| ext.eq_ignore_ascii_case("json"))
				{
					Fetched::status(404)
				} else {
					Fetched::text("text/plain", "RFC 1\n\nbody\n")
				}
			})
			.unwrap();
			assert_eq!(done.markdown, "# RFC 1\n\n## Full Text\n\n```\nRFC 1\n\nbody\n\n```\n");
			assert_eq!(done.notes, ["Metadata not available, showing plain text only"]);
		}
	}

	#[test]
	fn other_pages_and_missing_text_fall_through() {
		assert_eq!(
			run("https://www.rfc-editor.org/rfc/rfc2616.pdf.gz", |_| panic!("no fetch expected")),
			None
		);
		assert_eq!(
			run("https://datatracker.ietf.org/doc/draft-ietf-quic", |_| panic!("no fetch expected")),
			None
		);
		assert_eq!(run("https://www.rfc-editor.org/rfc/rfc2616", |_| Fetched::status(500)), None);
	}
}
