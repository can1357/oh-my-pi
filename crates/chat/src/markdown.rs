//! Renderer-faithful Markdown facts: the hyperlinks a message
//! would draw, gathered from the same Markdown renderer the transcript uses
//! so fenced code, code spans, escapes, reference definitions, and the
//! autolink rules agree with the screen.

use omp_core::{Str, StrMut};
use omp_dom::{Dom, KnownTag, Tag};
use omp_tui::{LinkId, RichSink, Style, markdown::MdTheme, with_link_url};

use crate::project::{AssistantPart, assistant_parts};

/// A hyperlink the renderer draws for a message: inline `[text](href)`,
/// `<autolink>`, bare URL, or reference link.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Link {
	/// Visible link text; equals `href` for autolinks and bare URLs.
	pub text: Str,
	/// Absolute http(s) destination exactly as the renderer resolved it.
	pub href: Str,
}

/// Layout width the extraction renders at: the widest row the renderer
/// addresses, so no paragraph the transcript wrapped is wrapped here and a
/// link the screen broke across rows comes back whole.
const EXTRACT_WIDTH: u16 = u16::MAX;

/// Collects the link runs the renderer emits, joining one hyperlink's runs
/// across nested emphasis and mid-word soft wraps.
struct LinkSink {
	links: Vec<(LinkId, StrMut)>,
	/// Whether the newest link is still open: the last run carried its id.
	open:  bool,
}

impl RichSink for LinkSink {
	fn run(&mut self, style: Style, text: &str) {
		let Some(id) = style.spec().link else {
			self.open = false;
			return;
		};
		match self.links.last_mut() {
			Some((current, label)) if self.open && *current == id => label.push_str(text),
			_ => self.links.push((id, StrMut::new(text))),
		}
		self.open = true;
	}

	fn newline(&mut self) {
		self.open = false;
	}

	/// A mid-word break is pure layout: the link continues byte-exact.
	fn soft_wrap(&mut self) {}
}

/// Every http(s) link the renderer would draw for `text`, in document order,
/// deduplicated by destination. `mailto:`/`file:`
/// destinations are not something to hand to the clipboard or the system
/// opener from a transcript, so they are skipped.
#[must_use]
pub fn extract_links(text: &str) -> Vec<Link> {
	if !text.contains("http") && !text.contains("://") && !text.contains('[') && !text.contains('<')
	{
		return Vec::new();
	}
	let mut sink = LinkSink { links: Vec::new(), open: false };
	omp_tui::markdown::render(&Str::new(text), EXTRACT_WIDTH, &MdTheme::default(), &mut sink);
	let mut links: Vec<Link> = Vec::new();
	for (id, label) in sink.links {
		// A closure, not `Str::from`: the resolver is higher-ranked over the
		// borrowed URL and a path does not generalize.
		let Some(href) = with_link_url(id, |url| Str::from(url)) else {
			continue;
		};
		if !is_http(href.as_str()) || links.iter().any(|known| known.href == href) {
			continue;
		}
		let label = label.freeze();
		let text = if label.trim().is_empty() {
			href.clone()
		} else {
			Str::new(label.trim())
		};
		links.push(Link { text, href });
	}
	links
}

fn is_http(href: &str) -> bool {
	let scheme_end = href.find("://").unwrap_or(0);
	href[..scheme_end].eq_ignore_ascii_case("http")
		|| href[..scheme_end].eq_ignore_ascii_case("https")
}

/// The most recent link of any assistant message on the live chain: the last
/// link of the last message that has one.
#[must_use]
pub fn last_link(dom: &Dom) -> Option<Link> {
	let mut last = None;
	for turn in dom.children(dom.body()) {
		for handle in dom.children(*turn) {
			let Some(node) = dom.get(*handle) else {
				continue;
			};
			if node.tag != Tag::Known(KnownTag::Assistant) {
				continue;
			}
			for part in assistant_parts(dom, *handle, node) {
				let AssistantPart::Text { text, .. } = part else {
					continue;
				};
				if let Some(link) = extract_links(text.as_str()).pop() {
					last = Some(link);
				}
			}
		}
	}
	last
}

#[cfg(test)]
mod tests {
	use super::*;

	fn hrefs(text: &str) -> Vec<String> {
		extract_links(text)
			.into_iter()
			.map(|link| link.href.to_string())
			.collect()
	}

	/// Inline, autolink, bare, and reference links in
	/// document order; the label is the visible text, or the destination
	/// for autolinks and bare URLs.
	#[test]
	fn links_come_out_in_document_order_with_their_visible_text() {
		let text = "See [the docs](https://example.com/docs) and <https://a.example/> or \
		            https://bare.example/path?q=1.\n\nAlso [ref][r].\n\n[r]: https://ref.example/x";
		let links = extract_links(text);
		assert_eq!(
			links
				.iter()
				.map(|link| (link.text.as_str(), link.href.as_str()))
				.collect::<Vec<_>>(),
			[
				("the docs", "https://example.com/docs"),
				("https://a.example/", "https://a.example/"),
				("https://bare.example/path?q=1", "https://bare.example/path?q=1"),
				("ref", "https://ref.example/x"),
			]
		);
	}

	/// Code never links: fenced blocks and code spans keep their URLs
	/// literal on screen, so they are not link targets either. Duplicate
	/// destinations fold to one, and non-http schemes are skipped.
	#[test]
	fn code_duplicates_and_non_http_schemes_are_not_links() {
		let text = "```\nhttps://fenced.example/\n```\n`https://span.example/` \
		            [a](https://dup.example/) [b](https://dup.example/) \
		            [mail](mailto:x@example.com) [file](file:///tmp/x) [ftp](ftp://h/x)";
		assert_eq!(hrefs(text), ["https://dup.example/"]);
		assert_eq!(extract_links("plain prose without links"), Vec::<Link>::new());
	}

	/// A label with nested emphasis is one link, and a URL far longer than
	/// any transcript row stays whole.
	#[test]
	fn nested_emphasis_and_long_urls_keep_one_link() {
		let links = extract_links("[**bold** and _italic_ label](https://example.com/)");
		assert_eq!(links.len(), 1);
		assert_eq!(links[0].text, "bold and italic label");
		let url = format!("https://long.example/{}", "a".repeat(5000));
		let text = format!("see {url} now");
		let links = extract_links(&text);
		assert_eq!(links.len(), 1, "{links:?}");
		assert_eq!(links[0].href, url);
		assert_eq!(links[0].text, url);
	}
}
