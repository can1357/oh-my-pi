//! One-shot HTML rendering: parse once, collect facts, select, write, judge
//! the verdict.

use url::Url;

use crate::{
	Hidden, dom, embedded,
	facts::{self, Facts},
	select,
	wall::{self, Verdict},
	write,
};

/// Output format of the writer.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Format {
	/// Markdown (`write::markdown`).
	#[default]
	Markdown,
	/// Lynx-style plain text (`write::text`).
	Text,
}

/// Which selection to write.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Mode {
	/// The reader pipeline (`select::reader`): the page's content without its
	/// chrome.
	#[default]
	Reader,
	/// Everything visible, as Lynx shows it.
	Full,
}

impl Mode {
	/// Parse a mode name: `"reader"` (or its former name `"auto"`) or
	/// `"full"`.
	pub fn parse(name: &str) -> Option<Self> {
		match name {
			"reader" | "auto" => Some(Self::Reader),
			"full" => Some(Self::Full),
			_ => None,
		}
	}
}

/// Rendering options.
#[derive(Clone, Copy, Debug)]
pub struct Options {
	/// Writer format.
	pub format: Format,
	/// Candidate selection.
	pub mode:   Mode,
	/// Hidden-content policy.
	pub hidden: Hidden,
	/// Emit images (Markdown only).
	pub images: bool,
	/// Line width (text only).
	pub width:  usize,
}

impl Default for Options {
	fn default() -> Self {
		Self {
			format: Format::Markdown,
			mode:   Mode::Reader,
			hidden: Hidden::Drop,
			images: true,
			width:  250,
		}
	}
}

/// A rendered page.
pub struct Rendered {
	/// Written content (Markdown from embedded data when `strategy` is
	/// `"embedded"`, whatever the requested format).
	pub content:  String,
	/// Document title.
	pub title:    Option<String>,
	/// Page verdict; a JS shell keeps `JsShell` even when embedded data
	/// supplied the content.
	pub verdict:  Verdict,
	/// `"reader"`, `"full"` or `"embedded"`.
	pub strategy: &'static str,
	/// A script shell's Open Graph summary when embedded data supplied
	/// nothing: what a reader returns once nothing better is found, never part
	/// of `content`.
	pub summary:  Option<String>,
	/// Facts collected from the document.
	pub facts:    Facts,
}

/// Render `html` fetched from `page_url` under `options`.
pub fn render(html: &str, page_url: Option<&Url>, options: &Options) -> Rendered {
	// Parsing fails only past the tokenizer's 4 GiB capacity; such input
	// renders as an empty page.
	let nodes = dom::parse(html).unwrap_or_default();
	let facts = match page_url {
		Some(url) => facts::collect(&nodes, url),
		None => facts::collect(&nodes, &Url::parse("about:blank").expect("valid URL")),
	};
	let hidden = options.hidden;
	let (selection, strategy) = match options.mode {
		Mode::Reader => (select::reader(&nodes, hidden), "reader"),
		Mode::Full => (select::full(&nodes, hidden), "full"),
	};
	let base = facts.base.as_ref().or(page_url);
	let content = match options.format {
		Format::Markdown => write::markdown::write(&nodes, &selection, base, options.images),
		Format::Text => write::text::write(&nodes, &selection, options.width),
	};
	// Judged on the selection's text, not the writer's output: link toolbars and
	// control notation exist in one format only.
	let verdict = wall::page(&nodes, &facts, &visible_text(&nodes, &selection));
	let mut summary = None;
	let (content, strategy) = match verdict {
		Verdict::JsShell => {
			if let Some(markdown) = embedded::extract(&nodes, &facts) {
				(markdown, "embedded")
			} else {
				summary = embedded::summary(&nodes, &facts);
				(content, strategy)
			}
		},
		// A wall's challenge text is never page content.
		Verdict::Wall(_) => (String::new(), strategy),
		_ => (content, strategy),
	};
	Rendered { content, title: facts.title.clone(), verdict, strategy, summary, facts }
}

/// Visible text of `selection`, whitespace-collapsed: text nodes and image alt
/// text, without metadata, scripts or form-control labels.
fn visible_text(nodes: &[dom::Node], selection: &select::Selection) -> String {
	let mut out = String::new();
	let mut push = |text: &str| {
		for word in text.split_whitespace() {
			if !out.is_empty() {
				out.push(' ');
			}
			out.push_str(word);
		}
	};
	let end = selection.root.end.min(nodes.len());
	let mut i = selection.root.start;
	while i < end {
		if selection.dropped.get(i).copied().unwrap_or(false) {
			i = match &nodes[i] {
				dom::Node::Tag(tag) => tag.children.end,
				dom::Node::Text(_) => i + 1,
			};
			continue;
		}
		match &nodes[i] {
			dom::Node::Text(text) => {
				push(text);
				i += 1;
			},
			dom::Node::Tag(tag) => match tag.name() {
				"head" | "title" | "script" | "style" | "template" | "noscript" | "svg" | "button"
				| "select" | "option" | "datalist" | "textarea" => i = tag.children.end,
				name => {
					if name == "img"
						&& let Some(alt) = tag.attr("alt")
					{
						push(alt);
					}
					i += 1;
				},
			},
		}
	}
	out
}

#[cfg(test)]
mod tests {
	use std::fmt::Write as _;

	use super::*;

	fn page() -> String {
		let prose: String = (0..8).fold(String::new(), |mut prose, i| {
			let _ = write!(
				prose,
				"<p>Paragraph {i} tells the story at length, with enough plain words to read like an \
				 actual article body rather than navigation chrome or a caption.</p>"
			);
			prose
		});
		format!(
			"<html><head><title>Story</title><meta property=\"og:type\" \
			 content=\"article\"></head><body><nav><a href=\"/\">Home</a> <a \
			 href=\"/news\">News</a></nav><article><h1>Story</h1>{prose}</article><footer>Copyright \
			 Example</footer></body></html>"
		)
	}

	#[test]
	fn reader_mode_writes_the_content_without_chrome() {
		let url = Url::parse("https://example.com/story").unwrap();
		for format in [Format::Markdown, Format::Text] {
			let rendered = render(&page(), Some(&url), &Options { format, ..Options::default() });
			assert_eq!(rendered.strategy, "reader");
			assert!(matches!(rendered.verdict, Verdict::Ok));
			assert_eq!(rendered.title.as_deref(), Some("Story"));
			assert!(rendered.content.contains("Paragraph 7 tells the story"));
			assert!(!rendered.content.contains("Copyright Example"), "{format:?}");
		}
	}

	#[test]
	fn full_mode_keeps_every_visible_landmark() {
		for format in [Format::Markdown, Format::Text] {
			let rendered =
				render(&page(), None, &Options { mode: Mode::Full, format, ..Options::default() });
			assert_eq!(rendered.strategy, "full");
			assert!(rendered.content.contains("Paragraph 3 tells the story"));
			assert!(rendered.content.contains("Copyright Example"));
		}
	}

	#[test]
	fn mode_names_parse() {
		assert_eq!(Mode::parse("auto"), Some(Mode::Reader));
		assert_eq!(Mode::parse("reader"), Some(Mode::Reader));
		assert_eq!(Mode::parse("full"), Some(Mode::Full));
		assert_eq!(Mode::parse("article"), None);
	}

	#[test]
	fn the_verdict_is_the_same_in_every_format() {
		let shell = r#"<html><head><title>Video</title><link rel="alternate" href="/feed">
			<link rel="search" href="/search"></head><body><div id="root"></div>
			<form><button>Sign in</button><input type="checkbox"> <select><option>English</option></select></form>
			<script src="/app.js"></script></body></html>"#;
		for format in [Format::Markdown, Format::Text] {
			let rendered =
				render(shell, None, &Options { format, mode: Mode::Full, ..Options::default() });
			assert_eq!(rendered.verdict, Verdict::JsShell, "{format:?}");
		}
	}

	#[test]
	fn empty_page_is_empty() {
		let rendered = render("<html><head></head><body></body></html>", None, &Options::default());
		assert!(matches!(rendered.verdict, Verdict::Empty));
		assert!(rendered.content.trim().is_empty());
	}
}
