//! `CrossRef` (`doi.org/<doi>`): work metadata from the `CrossRef` API, with
//! the JATS abstract converted to Markdown.

use std::fmt::Write as _;

use serde_json::Value;
use url::Url;

use super::{Action, Context, Done, Fetch, Site, arr_of, fetch, html_to_markdown, segment, str_of};

/// Registry entry.
pub const SITE: Site = Site { name: "crossref", open };

const METHOD: &str = "crossref";

fn open(url: &Url, _: &Context) -> Option<Action> {
	if !matches!(url.host_str()?, "doi.org" | "dx.doi.org" | "www.doi.org") {
		return None;
	}
	let doi = percent_decode(url.path().trim_start_matches('/'));
	if doi.is_empty() {
		return None;
	}
	fetch(
		Fetch::get(format!("https://api.crossref.org/works/{}", segment(&doi))).accept_json(),
		move |reply, _| {
			let data = reply.json_value()?;
			let message = data.get("message")?;

			let title = arr_of(message, "title")
				.first()
				.and_then(Value::as_str)
				.map(str::trim)
				.filter(|title| !title.is_empty())
				.unwrap_or("CrossRef Record");
			let authors = format_authors(arr_of(message, "author"));
			let journal = first_str(message, "container-title")
				.or_else(|| first_str(message, "short-container-title"));
			let publisher = str_of(message, "publisher");
			let published = ["published", "published-print", "published-online", "issued", "created"]
				.iter()
				.find_map(|key| format_date(message.get(key)?));
			let doi = str_of(message, "DOI").unwrap_or(&doi);
			let kind = str_of(message, "type").map(|kind| kind.replace('-', " "));
			let abstract_ = str_of(message, "abstract")
				.map(|html| html_to_markdown(&jats_to_p(html), None))
				.filter(|markdown| !markdown.is_empty());

			let mut md = format!("# {title}\n\n");
			if let Some(authors) = &authors {
				let _ = writeln!(md, "**Authors:** {authors}");
			}
			if let Some(journal) = journal {
				let _ = writeln!(md, "**Journal:** {journal}");
			}
			if let Some(publisher) = publisher {
				let _ = writeln!(md, "**Publisher:** {publisher}");
			}
			if let Some(published) = &published {
				let _ = writeln!(md, "**Published:** {published}");
			}
			let _ = writeln!(md, "**DOI:** {doi}");
			if let Some(kind) = &kind {
				let _ = writeln!(md, "**Type:** {kind}");
			}
			md.push_str("\n---\n\n## Abstract\n\n");
			md.push_str(abstract_.as_deref().unwrap_or("No abstract available."));
			md.push('\n');

			Done::new(md, METHOD)
				.title(title)
				.note("Fetched via CrossRef API")
				.finish()
		},
	)
}

/// First non-empty string of the array at `key`.
fn first_str<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
	arr_of(value, key)
		.first()
		.and_then(Value::as_str)
		.filter(|text| !text.is_empty())
}

fn format_authors(authors: &[Value]) -> Option<String> {
	let names: Vec<String> = authors
		.iter()
		.filter_map(|author| {
			if let Some(name) = str_of(author, "name") {
				return Some(name.to_owned());
			}
			let parts: Vec<&str> = ["given", "family"]
				.iter()
				.filter_map(|key| str_of(author, key))
				.collect();
			(!parts.is_empty()).then(|| parts.join(" "))
		})
		.collect();
	(!names.is_empty()).then(|| names.join(", "))
}

/// `YYYY-MM-DD` (padded, omitting missing month or day) of a `date-parts`
/// value.
fn format_date(date: &Value) -> Option<String> {
	let parts = date.get("date-parts")?.as_array()?.first()?.as_array()?;
	let year = parts.first().and_then(Value::as_u64)?;
	let mut out = year.to_string();
	if let Some(month) = parts.get(1).and_then(Value::as_u64) {
		let _ = write!(out, "-{month:02}");
	}
	if let Some(day) = parts.get(2).and_then(Value::as_u64) {
		let _ = write!(out, "-{day:02}");
	}
	Some(out)
}

/// Replace `<jats:p …>` and `</jats:p>` with plain paragraph tags.
fn jats_to_p(html: &str) -> String {
	let mut out = String::with_capacity(html.len());
	let mut i = 0;
	while let Some(pos) = html[i..].find("jats:p") {
		let at = i + pos;
		let before = &html[..at];
		let closing = before.ends_with("</");
		if !closing && !before.ends_with('<') {
			out.push_str(&html[i..at]);
			out.push_str("jats:p");
			i = at + "jats:p".len();
			continue;
		}
		let Some(end) = html[at..].find('>') else {
			break;
		};
		out.push_str(&html[i..at]);
		out.push_str(if closing { "</p>" } else { "<p>" });
		i = at + end + 1;
	}
	out.push_str(&html[i..]);
	out
}

/// Decode `%XX` escapes (the URL path arrives percent-encoded).
fn percent_decode(text: &str) -> String {
	let bytes = text.as_bytes();
	let mut out = Vec::with_capacity(bytes.len());
	let mut i = 0;
	while i < bytes.len() {
		if bytes[i] == b'%'
			&& i + 2 < bytes.len()
			&& let (Some(high), Some(low)) = (hex(bytes[i + 1]), hex(bytes[i + 2]))
		{
			out.push(high << 4 | low);
			i += 3;
			continue;
		}
		out.push(bytes[i]);
		i += 1;
	}
	String::from_utf8_lossy(&out).into_owned()
}

fn hex(byte: u8) -> Option<u8> {
	(byte as char).to_digit(16).map(|digit| digit as u8)
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::super::{Fetched, testing::run};

	#[test]
	fn a_doi_page_reads_the_work_with_its_abstract() {
		let work = json!({
			"message": {
				"title": ["Deep Learning"], "author": [{ "given": "Yann", "family": "LeCun" }, { "name": "Corinna Cortes" }],
				"container-title": ["Nature"], "publisher": "Springer", "published": { "date-parts": [[2015, 5, 27]] },
				"DOI": "10.1038/nature14539", "type": "journal-article",
				"abstract": "<jats:p>Networks with <jats:italic>many</jats:italic> layers.</jats:p>"
			}
		});
		let mut requests = Vec::new();
		let done = run("https://doi.org/10.1038/nature14539", |request| {
			requests.push(request.url.clone());
			Fetched::json(&work)
		})
		.unwrap();
		assert_eq!(requests, ["https://api.crossref.org/works/10.1038%2Fnature14539"]);
		assert_eq!(done.method, "crossref");
		assert_eq!(done.title.as_deref(), Some("Deep Learning"));
		let md = &done.markdown;
		assert!(md.starts_with(
			"# Deep Learning\n\n**Authors:** Yann LeCun, Corinna Cortes\n**Journal:** \
			 Nature\n**Publisher:** Springer\n**Published:** 2015-05-27\n**DOI:** \
			 10.1038/nature14539\n**Type:** journal article\n\n---\n\n## Abstract\n\n"
		));
		assert!(md.contains("Networks with"));
		assert!(!md.contains("jats:"));
	}

	#[test]
	fn an_encoded_doi_is_decoded_and_a_missing_abstract_is_named() {
		let work = json!({ "message": { "title": [], "issued": { "date-parts": [[2024]] } } });
		let mut requests = Vec::new();
		let done = run("https://dx.doi.org/10.1000%2Fsub", |request| {
			requests.push(request.url.clone());
			Fetched::json(&work)
		})
		.unwrap();
		assert_eq!(requests, ["https://api.crossref.org/works/10.1000%2Fsub"]);
		let md = &done.markdown;
		assert!(md.starts_with(
			"# CrossRef Record\n\n**Published:** 2024\n**DOI:** 10.1000/sub\n\n---\n\n## \
			 Abstract\n\nNo abstract available.\n"
		));
		assert!(!md.contains("**Authors:**"));
	}

	#[test]
	fn other_hosts_and_api_failures_fall_through() {
		assert_eq!(run("https://example.test/10.1000/x", |_| panic!("no fetch expected")), None);
		assert_eq!(run("https://doi.org/", |_| panic!("no fetch expected")), None);
		assert_eq!(run("https://doi.org/10.1000/x", |_| Fetched::status(404)), None);
	}
}
