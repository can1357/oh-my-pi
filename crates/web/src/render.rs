//! One-shot HTML rendering: parse once, collect facts, select, write, judge
//! the verdict.

use std::{fmt::Write as _, ops::Range};

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
	/// Written content (Markdown from embedded data or the body's `<noscript>`
	/// content when `strategy` is `"embedded"`, whatever the requested format).
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
	let visible = visible_text(&nodes, &selection);
	let mut verdict = wall::page(&nodes, &facts, &visible);
	let mut summary = None;
	let (content, strategy) = match verdict {
		Verdict::JsShell | Verdict::Empty => {
			let extracted = match verdict {
				Verdict::JsShell => embedded::extract(&nodes, &facts),
				_ => None,
			};
			if let Some(markdown) = extracted {
				(markdown, "embedded")
			} else if let Some(markdown) = noscript(&nodes, base) {
				// The page shows this only to readers without scripts: it is script
				// driven, and this is its content.
				verdict = Verdict::JsShell;
				(markdown, "embedded")
			} else {
				if verdict == Verdict::JsShell {
					summary = embedded::summary(&nodes, &facts);
				}
				(content, strategy)
			}
		},
		// A wall's challenge text is never page content.
		Verdict::Wall(_) => (String::new(), strategy),
		Verdict::Ok if options.mode == Mode::Reader => {
			(with_faq(content, &facts, &visible, options.format), strategy)
		},
		Verdict::Ok => (content, strategy),
	};
	Rendered { content, title: facts.title.clone(), verdict, strategy, summary, facts }
}

/// Markdown of the largest `<noscript>` in the body when it holds content
/// rather than a request to enable JavaScript.
fn noscript(nodes: &[dom::Node], base: Option<&Url>) -> Option<String> {
	let body = nodes.iter().find_map(|node| match node {
		dom::Node::Tag(tag) if tag.name() == "body" => Some(tag.children.clone()),
		_ => None,
	});
	let range = body.unwrap_or(0..nodes.len());
	let mask = select::full(nodes, Hidden::All).dropped;
	let mut best: Option<(usize, Range<usize>)> = None;
	let mut i = range.start;
	while i < range.end {
		let dom::Node::Tag(tag) = &nodes[i] else {
			i += 1;
			continue;
		};
		if tag.name() != "noscript" {
			i += 1;
			continue;
		}
		let text = visible_in(nodes, tag.children.clone(), &mask);
		let chars = text.chars().count();
		if chars > wall::MIN_RENDERED_CHARS
			&& !wall::is_block_page(&text)
			&& best.as_ref().is_none_or(|(most, _)| chars > *most)
		{
			best = Some((chars, tag.children.clone()));
		}
		i = tag.children.end;
	}
	let (_, root) = best?;
	let selection = select::Selection { root, dropped: mask, recoverable_only: false };
	let markdown = write::markdown::write(nodes, &selection, base, true);
	(!markdown.trim().is_empty()).then_some(markdown)
}

/// `content` with the page's JSON-LD FAQ answers that its output lacks (an
/// accordion whose panels are collapsed, or that the selection dropped with its
/// footer). In Markdown they join the page's own FAQ section when it has one,
/// and an answer shown without its question (a dropped accordion button) gets
/// the question as a heading above it.
fn with_faq(mut content: String, facts: &Facts, visible: &str, format: Format) -> String {
	let entries = embedded::faq(facts);
	if entries.is_empty() {
		return content;
	}
	if format == Format::Markdown {
		return merge_faq(content, visible, &entries);
	}
	let output = collapse(&content);
	let missing: Vec<_> = entries
		.into_iter()
		.filter(|(_, answer)| !visible.contains(answer.as_str()) && !output.contains(answer.as_str()))
		.collect();
	if missing.is_empty() {
		return content;
	}
	let mut section = "Frequently asked questions".to_owned();
	for (question, answer) in &missing {
		let _ = write!(section, "\n\n{question}\n\n   {answer}");
	}
	let trimmed = content.trim_end().len();
	content.truncate(trimmed);
	if !content.is_empty() {
		content.push_str("\n\n");
	}
	content.push_str(&section);
	content.push('\n');
	content
}

/// Whitespace-collapsed `text`.
fn collapse(text: &str) -> String {
	let mut out = String::with_capacity(text.len());
	for word in text.split_whitespace() {
		if !out.is_empty() {
			out.push(' ');
		}
		out.push_str(word);
	}
	out
}

/// Level and text of an ATX heading line.
fn heading(line: &str) -> Option<(usize, &str)> {
	let trimmed = line.trim_start();
	if line.len() - trimmed.len() > 3 {
		return None;
	}
	let level = trimmed.bytes().take_while(|&b| b == b'#').count();
	let rest = &trimmed[level..];
	((1..=6).contains(&level) && (rest.is_empty() || rest.starts_with([' ', '\t'])))
		.then(|| (level, rest.trim().trim_end_matches('#').trim_end()))
}

/// A heading naming a page's FAQ section.
fn is_faq_heading(text: &str) -> bool {
	let lower = text.to_lowercase();
	lower.contains("frequently asked")
		|| lower
			.split(|c: char| !c.is_alphanumeric())
			.any(|word| word == "faq" || word == "faqs")
}

/// Text of a Markdown line without its block markers, link targets, emphasis
/// and code marks or escapes, whitespace-collapsed.
fn plain_line(line: &str) -> String {
	let mut text = line.trim_start().trim_start_matches('#').trim_start();
	loop {
		let rest = text
			.strip_prefix("> ")
			.or_else(|| {
				text
					.strip_prefix(['-', '*', '+'])
					.filter(|rest| rest.starts_with(' '))
			})
			.or_else(|| {
				let digits = text.bytes().take_while(u8::is_ascii_digit).count();
				if digits == 0 {
					return None;
				}
				text[digits..]
					.strip_prefix(['.', ')'])
					.filter(|rest| rest.starts_with(' '))
			});
		match rest {
			Some(rest) => text = rest.trim_start(),
			None => break,
		}
	}
	let mut out = String::with_capacity(text.len());
	let mut chars = text.chars().peekable();
	while let Some(c) = chars.next() {
		match c {
			'\\' => out.extend(chars.next()),
			']' if chars.peek() == Some(&'(') => {
				for c in chars.by_ref() {
					if c == ')' {
						break;
					}
				}
			},
			'!' if chars.peek() == Some(&'[') => {},
			'[' | ']' | '*' | '`' => {},
			c => out.push(c),
		}
	}
	collapse(&out)
}

/// Markdown `content` merged with the page's JSON-LD FAQ `entries`:
///
/// - an answer the output shows without its question gets the question as a
///   heading above it;
/// - a question heading with nothing under it gets its answer;
/// - a question heading whose section holds only parts of its answer (the
///   answer as a list, say) is left as it is;
/// - every other pair whose answer the output lacks goes to the end of the
///   page's FAQ section, or to a new one at the end.
fn merge_faq(content: String, visible: &str, entries: &[(String, String)]) -> String {
	let lines: Vec<&str> = content.lines().collect();
	let mut code = vec![false; lines.len()];
	let mut fence: Option<char> = None;
	for (index, line) in lines.iter().enumerate() {
		let trimmed = line.trim_start();
		let marker = if trimmed.starts_with("```") {
			Some('`')
		} else if trimmed.starts_with("~~~") {
			Some('~')
		} else {
			None
		};
		match (fence, marker) {
			(None, Some(m)) => {
				fence = Some(m);
				code[index] = true;
			},
			(Some(open), Some(m)) if open == m => {
				fence = None;
				code[index] = true;
			},
			(Some(_), _) => code[index] = true,
			(None, None) => {},
		}
	}
	let headings: Vec<Option<(usize, &str)>> = lines
		.iter()
		.zip(&code)
		.map(|(line, &code)| if code { None } else { heading(line) })
		.collect();
	// The page's FAQ heading, and the line its section ends before.
	let section = headings.iter().enumerate().find_map(|(index, heading)| {
		let (level, text) = (*heading)?;
		is_faq_heading(text).then(|| {
			let end = headings[index + 1..]
				.iter()
				.position(|h| h.is_some_and(|(next, _)| next <= level))
				.map_or(lines.len(), |offset| index + 1 + offset);
			(level, end)
		})
	});
	let plains: Vec<String> = lines.iter().map(|line| plain_line(line)).collect();
	let output = plains.join(" ");
	let shown = |text: &str| visible.contains(text) || output.contains(text);
	// Questions to write above a line, and answers to write below a heading.
	let mut names: Vec<Option<&str>> = vec![None; lines.len()];
	let mut fills: Vec<Option<&str>> = vec![None; lines.len()];
	let mut missing = Vec::new();
	for (question, answer) in entries {
		if shown(answer.as_str()) {
			if !shown(question.as_str())
				&& let Some(index) = (0..lines.len()).find(|&i| !code[i] && plains[i] == *answer)
			{
				names[index].get_or_insert(question.as_str());
			}
			continue;
		}
		if let Some(at) = (0..lines.len()).find(|&i| headings[i].is_some() && plains[i] == *question)
		{
			let mut body = (at + 1..lines.len())
				.take_while(|&i| headings[i].is_none())
				.filter(|&i| !plains[i].is_empty())
				.peekable();
			if body.peek().is_none() {
				fills[at].get_or_insert(answer.as_str());
				continue;
			}
			if body.all(|i| answer.contains(plains[i].as_str())) {
				continue;
			}
		}
		missing.push((question.clone(), answer.clone()));
	}
	if missing.is_empty() && names.iter().chain(&fills).all(Option::is_none) {
		return content;
	}
	let block = |level: usize| embedded::faq_markdown(&missing, level.min(6));
	let mut out = String::with_capacity(content.len() + 1024);
	let mut current = 1;
	for (index, line) in lines.iter().enumerate() {
		if let Some((level, end)) = section
			&& end == index
			&& !missing.is_empty()
		{
			out.push_str(&block(level + 1));
			out.push_str("\n\n");
		}
		if let Some(question) = names[index] {
			let _ = write!(out, "{} {question}\n\n", "#".repeat((current + 1).min(6)));
		}
		if let Some((level, _)) = headings[index] {
			current = level;
		}
		out.push_str(line);
		out.push('\n');
		if let Some(answer) = fills[index] {
			let _ = write!(out, "\n{answer}\n");
		}
	}
	if !missing.is_empty() {
		match section {
			Some((level, end)) if end == lines.len() => {
				out.push('\n');
				out.push_str(&block(level + 1));
				out.push('\n');
			},
			Some(_) => {},
			None => {
				let _ = write!(out, "\n## Frequently asked questions\n\n{}\n", block(3));
			},
		}
	}
	out
}

/// Visible text of `selection`, whitespace-collapsed: text nodes and image alt
/// text, without metadata, scripts or form-control labels.
fn visible_text(nodes: &[dom::Node], selection: &select::Selection) -> String {
	visible_in(nodes, selection.root.clone(), &selection.dropped)
}

/// [`visible_text`] of the nodes in `root` under the `dropped` mask.
fn visible_in(nodes: &[dom::Node], root: Range<usize>, dropped: &[bool]) -> String {
	let mut out = String::new();
	let mut push = |text: &str| {
		for word in text.split_whitespace() {
			if !out.is_empty() {
				out.push(' ');
			}
			out.push_str(word);
		}
	};
	let end = root.end.min(nodes.len());
	let mut i = root.start;
	while i < end {
		if dropped.get(i).copied().unwrap_or(false) {
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
	fn a_body_noscript_with_content_stands_in_for_an_empty_shell() {
		let prose = "Every harness runs the same pinned tasks with each model, and only verifier \
		             passes count toward the score that the leaderboard shows.";
		let html = format!(
			"<html><head><noscript><img src=/pixel.gif></noscript></head><body><main \
			 id=main></main><script \
			 src=/app.js></script><noscript><h1>Benchmark</h1><p>{prose}</p><p>The charts need \
			 JavaScript.</p></noscript></body></html>"
		);
		for format in [Format::Markdown, Format::Text] {
			let rendered = render(&html, None, &Options { format, ..Options::default() });
			assert_eq!(rendered.verdict, Verdict::JsShell);
			assert_eq!(rendered.strategy, "embedded");
			assert!(rendered.content.starts_with("# Benchmark"), "{}", rendered.content);
			assert!(rendered.content.contains(prose));
		}
		// A noscript that only asks for JavaScript is no content.
		let gate = "<html><body><div id=root></div><noscript>You need to enable JavaScript to run \
		            this app.</noscript></body></html>";
		assert_ne!(render(gate, None, &Options::default()).strategy, "embedded");
	}

	#[test]
	fn json_ld_faq_the_selection_lost_is_appended() {
		let answer = "Booking ahead is recommended, particularly for dinner and weekend dates.";
		let data = format!(
			r#"{{"@type":"FAQPage","mainEntity":[{{"@type":"Question","name":"Do I need to book?","acceptedAnswer":{{"@type":"Answer","text":"{answer}"}}}},{{"@type":"Question","name":"Is it open daily?","acceptedAnswer":{{"@type":"Answer","text":"Yes."}}}}]}}"#
		);
		let html = page().replace(
			"</article>",
			&format!(
				"<h2>Is it open daily?</h2><p>Yes.</p></article><script \
				 type=\"application/ld+json\">{data}</script>"
			),
		);
		let rendered = render(&html, None, &Options::default());
		assert!(rendered.content.contains(&format!(
			"## Frequently asked questions\n\n### Do I need to book?\n\n{answer}"
		)));
		assert_eq!(rendered.content.matches("Is it open daily?").count(), 1);
		let full = render(&html, None, &Options { mode: Mode::Full, ..Options::default() });
		assert!(!full.content.contains("Do I need to book?"));
	}

	#[test]
	fn json_ld_faq_joins_the_pages_own_faq_section() {
		let first = "Our interface returns structured records so developers can query them without \
		             scraping each source by hand.";
		let second = "It covers four platforms through the same typed interface and response models.";
		let data = format!(
			r#"{{"@type":"FAQPage","mainEntity":[{{"@type":"Question","name":"What is it?","acceptedAnswer":{{"@type":"Answer","text":"{first}"}}}},{{"@type":"Question","name":"What does it cover?","acceptedAnswer":{{"@type":"Answer","text":"{second}"}}}}]}}"#
		);
		let html = page().replace(
			"</article>",
			&format!(
				"<h2>Frequently asked questions</h2><p>{first}</p><h2>Pricing</h2><p>A free tier is \
				 available.</p></article><script type=\"application/ld+json\">{data}</script>"
			),
		);
		let content = render(&html, None, &Options::default()).content;
		assert!(
			content.contains(&format!(
				"## Frequently asked questions\n\n### What is it?\n\n{first}\n\n### What does it \
				 cover?\n\n{second}\n\n## Pricing"
			)),
			"{content}"
		);
		assert_eq!(content.matches("Frequently asked questions").count(), 1);
		assert_eq!(content.matches(first).count(), 1);
	}

	#[test]
	fn an_faq_answer_shown_in_parts_or_missing_under_its_heading() {
		let listed = "Variants are suffixes. Dynamic variants work on all models: online attaches \
		              web results, floor prioritizes the lowest price.";
		let hidden = "Credits never expire while the account stays active and in good standing.";
		let data = format!(
			r#"{{"@type":"FAQPage","mainEntity":[{{"@type":"Question","name":"What are variants?","acceptedAnswer":{{"@type":"Answer","text":"{listed}"}}}},{{"@type":"Question","name":"Do credits expire?","acceptedAnswer":{{"@type":"Answer","text":"{hidden}"}}}}]}}"#
		);
		let html = page().replace(
			"</article>",
			&format!(
				"<h2>FAQ</h2><h3>What are variants?</h3><p>Variants are suffixes.</p><p>Dynamic \
				 variants work on all models:</p><ul><li><a href=\"/online\"><code>online</code></a> \
				 attaches web results</li></ul><h3>Do credits expire?</h3></article><script \
				 type=\"application/ld+json\">{data}</script>"
			),
		);
		let content = render(&html, None, &Options::default()).content;
		assert!(content.contains(&format!("### Do credits expire?\n\n{hidden}")), "{content}");
		assert_eq!(content.matches("What are variants?").count(), 1);
		assert!(!content.contains("Frequently asked questions"));
		assert_eq!(
			plain_line("1. > - [`:free`](https://x.test/m) \\– **free** model"),
			":free – free model"
		);
	}

	#[test]
	fn empty_page_is_empty() {
		let rendered = render("<html><head></head><body></body></html>", None, &Options::default());
		assert!(matches!(rendered.verdict, Verdict::Empty));
		assert!(rendered.content.trim().is_empty());
	}
}
