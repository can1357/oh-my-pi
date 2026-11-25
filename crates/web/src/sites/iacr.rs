//! IACR ePrint Archive (`eprint.iacr.org/<year>/<number>`): title, authors,
//! date, keywords and abstract from the paper page. `.pdf` URLs are declined so
//! the reader's own PDF path reads the paper: the TS handler converted the PDF
//! with a binary tool, which a sans-I/O handler cannot do.

use std::{fmt::Write as _, ops::Range};

use url::Url;

use super::{Action, Context, Done, Fetch, Site, fetch};
use crate::dom::{self, Element, Node};

/// Registry entry.
pub const SITE: Site = Site { name: "iacr", open };

const METHOD: &str = "iacr";
const NOTE: &str = "Fetched from IACR ePrint Archive";

fn open(url: &Url, _: &Context) -> Option<Action> {
	if url.host_str()? != "eprint.iacr.org" {
		return None;
	}
	let (year, number) = paper(url.path())?;
	let paper_id = format!("{year}/{number}");
	fetch(Fetch::get(format!("https://eprint.iacr.org/{paper_id}")), move |reply, _| {
		let nodes = dom::parse(&reply.body_text()?).ok()?;
		let title = title(&nodes);
		let authors = authors(&nodes);
		let abstract_text = abstract_text(&nodes);
		let keywords = keywords(&nodes);
		let date = meta_content(&nodes, "citation_publication_date");

		let mut md = format!("# {title}\n\n");
		if !authors.is_empty() {
			let _ = writeln!(md, "**Authors:** {}", authors.join(", "));
		}
		if let Some(date) = date {
			let _ = writeln!(md, "**Date:** {date}");
		}
		let _ = writeln!(md, "**ePrint:** {paper_id}");
		if let Some(keywords) = keywords {
			let _ = writeln!(md, "**Keywords:** {keywords}");
		}
		let _ = write!(md, "\n---\n\n## Abstract\n\n{abstract_text}\n\n");

		Done::new(md, METHOD).title(title).note(NOTE).finish()
	})
}

/// The `<year>/<number>` a paper URL names, wherever the pattern starts (the
/// TS regex was unanchored) and with any `.pdf` suffix.
fn paper(path: &str) -> Option<(&str, &str)> {
	if std::path::Path::new(path)
		.extension()
		.is_some_and(|ext| ext.eq_ignore_ascii_case("pdf"))
	{
		return None;
	}
	for (index, _) in path.match_indices('/') {
		let rest = path.get(index + 1..)?;
		let Some((year, number)) = rest.split_once('/') else {
			continue;
		};
		if year.len() == 4 && year.bytes().all(|byte| byte.is_ascii_digit()) && is_number(number) {
			return Some((year, number));
		}
	}
	None
}

fn is_number(number: &str) -> bool {
	!number.is_empty() && number.bytes().all(|byte| byte.is_ascii_digit())
}

fn title(nodes: &[Node]) -> String {
	find_tag(nodes, 0..nodes.len(), |element| element.name() == "h3" && has_class(element, "mb-3"))
		.map(|(_, element)| text_of(nodes, element.children.clone()).trim().to_owned())
		.filter(|title| !title.is_empty())
		.or_else(|| meta_content(nodes, "citation_title"))
		.unwrap_or_else(|| "IACR ePrint Paper".to_owned())
}

fn authors(nodes: &[Node]) -> Vec<String> {
	find_all(nodes, 0..nodes.len(), |element| {
		element.name() == "meta" && element.attr("name") == Some("citation_author")
	})
	.into_iter()
	.filter_map(|(_, element)| element.attr("content"))
	.filter(|author| !author.is_empty())
	.map(str::to_owned)
	.collect()
}

/// The paragraph after the `Abstract` heading, else the meta description.
fn abstract_text(nodes: &[Node]) -> String {
	find_all(nodes, 0..nodes.len(), |element| element.name() == "h5")
		.into_iter()
		.find(|(_, element)| text_of(nodes, element.children.clone()).contains("Abstract"))
		.and_then(|(index, _)| parent_of(nodes, index))
		.and_then(|parent| find_tag(nodes, parent.children.clone(), |element| element.name() == "p"))
		.map(|(_, element)| text_of(nodes, element.children.clone()).trim().to_owned())
		.filter(|text| !text.is_empty())
		.or_else(|| meta_content(nodes, "description"))
		.unwrap_or_else(|| "No abstract available.".to_owned())
}

fn keywords(nodes: &[Node]) -> Option<String> {
	find_tag(nodes, 0..nodes.len(), |element| has_class(element, "keywords"))
		.map(|(_, element)| {
			text_of(nodes, element.children.clone())
				.replacen("Keywords:", "", 1)
				.trim()
				.to_owned()
		})
		.filter(|keywords| !keywords.is_empty())
}

/// `content` of the first `<meta name="...">`.
fn meta_content(nodes: &[Node], name: &str) -> Option<String> {
	find_tag(nodes, 0..nodes.len(), |element| {
		element.name() == "meta" && element.attr("name") == Some(name)
	})
	.and_then(|(_, element)| element.attr("content"))
	.filter(|content| !content.is_empty())
	.map(str::to_owned)
}

/// Elements of `range` in document order, with their arena index.
fn elements(nodes: &[Node], range: Range<usize>) -> impl Iterator<Item = (usize, &Element)> + '_ {
	range.filter_map(move |index| match &nodes[index] {
		Node::Tag(element) => Some((index, element)),
		Node::Text(_) => None,
	})
}

/// First element of `range` matching `predicate`.
fn find_tag(
	nodes: &[Node],
	range: Range<usize>,
	predicate: impl Fn(&Element) -> bool,
) -> Option<(usize, &Element)> {
	elements(nodes, range).find(|(_, element)| predicate(element))
}

/// Every element of `range` matching `predicate`, in document order.
fn find_all(
	nodes: &[Node],
	range: Range<usize>,
	predicate: impl Fn(&Element) -> bool,
) -> Vec<(usize, &Element)> {
	elements(nodes, range)
		.filter(|(_, element)| predicate(element))
		.collect()
}

/// Whole-class match, as a `.class` selector does.
fn has_class(element: &Element, class: &str) -> bool {
	element
		.attr("class")
		.is_some_and(|classes| classes.split_whitespace().any(|name| name == class))
}

/// Text of `range`, the `textContent` of the element owning it.
fn text_of(nodes: &[Node], range: Range<usize>) -> String {
	let mut out = String::new();
	for node in &nodes[range] {
		if let Node::Text(text) = node {
			out.push_str(text);
		}
	}
	out
}

/// Innermost element whose descendants contain `index`.
fn parent_of(nodes: &[Node], index: usize) -> Option<&Element> {
	elements(nodes, 0..nodes.len())
		.filter(|(_, element)| element.children.contains(&index))
		.map(|(_, element)| element)
		.last()
}

#[cfg(test)]
mod tests {
	use super::super::{Fetched, testing::run};

	const PAGE: &str = r#"<html><head>
<meta name="citation_title" content="Meta Title">
<meta name="citation_author" content="Alice Author">
<meta name="citation_author" content="Bob Builder">
<meta name="citation_author" content="">
<meta name="citation_publication_date" content="2023-01-17">
<meta name="description" content="Meta abstract.">
</head><body>
<h3 class="mb-3">A Title That Wins</h3>
<div class="container"><h5>Abstract</h5><p>The abstract paragraph.</p></div>
<div class="keywords">Keywords: crypto, proofs</div>
</body></html>"#;

	#[test]
	fn a_paper_page_renders_its_metadata_and_abstract() {
		let mut requests = Vec::new();
		let done = run("https://eprint.iacr.org/2023/123", |request| {
			requests.push(request.url.clone());
			Fetched::text("text/html", PAGE)
		})
		.unwrap();
		assert_eq!(requests, ["https://eprint.iacr.org/2023/123"]);
		assert_eq!((done.method, done.title.as_deref()), ("iacr", Some("A Title That Wins")));
		let md = &done.markdown;
		assert!(md.starts_with(
			"# A Title That Wins\n\n**Authors:** Alice Author, Bob Builder\n**Date:** \
			 2023-01-17\n**ePrint:** 2023/123\n**Keywords:** crypto, proofs\n"
		));
		assert!(md.ends_with("\n---\n\n## Abstract\n\nThe abstract paragraph.\n\n"));
		assert_eq!(done.notes, ["Fetched from IACR ePrint Archive"]);
	}

	#[test]
	fn meta_tags_stand_in_for_a_missing_heading_and_abstract() {
		let page = r#"<html><head>
<meta name="citation_title" content="Meta Title">
<meta name="description" content="Meta abstract.">
</head><body><p>Nothing else.</p></body></html>"#;
		let done =
			run("https://eprint.iacr.org/2023/123", |_| Fetched::text("text/html", page)).unwrap();
		assert_eq!(done.title.as_deref(), Some("Meta Title"));
		assert!(
			done
				.markdown
				.contains("**ePrint:** 2023/123\n\n---\n\n## Abstract\n\nMeta abstract.\n\n")
		);
		assert!(!done.markdown.contains("**Authors:**"));
		assert!(!done.markdown.contains("**Keywords:**"));

		let bare =
			run("https://eprint.iacr.org/2023/123", |_| Fetched::text("text/html", "<p>Nothing.</p>"))
				.unwrap();
		assert!(
			bare
				.markdown
				.starts_with("# IACR ePrint Paper\n\n**ePrint:** 2023/123\n")
		);
		assert!(
			bare
				.markdown
				.ends_with("## Abstract\n\nNo abstract available.\n\n")
		);

		let nested = run("https://eprint.iacr.org/foo/2023/123", |request| {
			assert_eq!(request.url, "https://eprint.iacr.org/2023/123");
			Fetched::text("text/html", "<p>Nothing.</p>")
		})
		.unwrap();
		assert!(nested.markdown.contains("**ePrint:** 2023/123\n"));
	}

	#[test]
	fn other_pages_pdfs_and_failed_requests_fall_through() {
		assert_eq!(run("https://eprint.iacr.org/", |_| panic!("no fetch expected")), None);
		assert_eq!(run("https://eprint.iacr.org/2023/abc", |_| panic!("no fetch expected")), None);
		assert_eq!(run("https://eprint.iacr.org/23/123", |_| panic!("no fetch expected")), None);
		assert_eq!(run("https://example.test/2023/123", |_| panic!("no fetch expected")), None);
		assert_eq!(
			run("https://eprint.iacr.org/2023/123.pdf", |_| panic!("no fetch expected")),
			None
		);
		assert_eq!(run("https://eprint.iacr.org/2023/123", |_| Fetched::status(500)), None);
	}
}
