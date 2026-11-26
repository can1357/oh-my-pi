//! Content selection over the shared HTML arena: the reader pipeline and the
//! Lynx-complete visible selection (see [`pipeline`]).

mod pipeline;
mod rules;

use std::ops::Range;

pub use self::pipeline::{full, is_hidden, reader};
use crate::dom::{Element, Node};

/// Selection into the original HTML arena.
pub struct Selection {
	/// Root slice of nodes to visit (`0..0` when no content survived).
	pub root:             Range<usize>,
	/// Effective mask. Dropped tags also exclude their entire subtree.
	pub dropped:          Vec<bool>,
	/// Informational flag kept for the writers' tests; the selections here
	/// always leave it `false`.
	pub recoverable_only: bool,
}

const NO_PARENT: usize = usize::MAX;

const fn end(nodes: &[Node], index: usize) -> usize {
	match &nodes[index] {
		Node::Text(_) => index + 1,
		Node::Tag(tag) => tag.children.end,
	}
}

fn walk<'a>(
	nodes: &'a [Node],
	dropped: &'a [bool],
	range: Range<usize>,
) -> impl Iterator<Item = (usize, &'a Node)> {
	let mut index = range.start;
	std::iter::from_fn(move || {
		while index < range.end {
			let current = index;
			if dropped[current] {
				index = end(nodes, current);
			} else {
				index += 1;
				return Some((current, &nodes[current]));
			}
		}
		None
	})
}

fn text_len(nodes: &[Node], dropped: &[bool], range: Range<usize>) -> usize {
	walk(nodes, dropped, range)
		.filter_map(|(_, node)| match node {
			Node::Text(text) => Some(TextSize::new(text)),
			Node::Tag(_) => None,
		})
		.fold(TextSize::default(), TextSize::join)
		.chars
}

/// Character count of concatenated, whitespace-normalized text without
/// allocating a string.
#[derive(Clone, Copy, Default)]
struct TextSize {
	chars:          usize,
	leading_space:  bool,
	trailing_space: bool,
}

impl TextSize {
	fn new(text: &str) -> Self {
		let trimmed = text.trim();
		let mut words = trimmed.split_whitespace();
		let chars = words.next().map_or(0, |word| {
			word.chars().count() + words.map(|word| 1 + word.chars().count()).sum::<usize>()
		});
		Self {
			chars,
			leading_space: text.len() != text.trim_start().len(),
			trailing_space: text.len() != text.trim_end().len(),
		}
	}

	fn join(self, next: Self) -> Self {
		match (self.chars, next.chars) {
			(0, _) => Self { leading_space: self.leading_space || next.leading_space, ..next },
			(_, 0) => Self { trailing_space: self.trailing_space || next.trailing_space, ..self },
			_ => Self {
				chars:          self.chars
					+ next.chars
					+ usize::from(self.trailing_space || next.leading_space),
				leading_space:  self.leading_space,
				trailing_space: next.trailing_space,
			},
		}
	}
}

struct Tree<'a> {
	nodes:   &'a [Node],
	parents: Vec<usize>,
}

impl<'a> Tree<'a> {
	fn new(nodes: &'a [Node]) -> Self {
		let mut stack: Vec<&Element> = Vec::new();
		let mut parents = Vec::with_capacity(nodes.len());
		for (index, node) in nodes.iter().enumerate() {
			while stack.last().is_some_and(|tag| tag.children.end <= index) {
				stack.pop();
			}
			parents.push(stack.last().map_or(NO_PARENT, |tag| tag.index()));
			if let Node::Tag(tag) = node
				&& !tag.children.is_empty()
			{
				stack.push(tag);
			}
		}
		Self { nodes, parents }
	}

	fn parent(&self, index: usize) -> Option<usize> {
		let parent = self.parents[index];
		(parent != NO_PARENT).then_some(parent)
	}

	const fn range(&self, index: usize) -> Range<usize> {
		index..end(self.nodes, index)
	}

	const fn tag(&self, index: usize) -> Option<&'a Element> {
		match &self.nodes[index] {
			Node::Tag(tag) => Some(tag),
			Node::Text(_) => None,
		}
	}

	/// Show the subtree at `index` as `source` shows it, without showing
	/// anything else: every hidden ancestor reopens with only the path to
	/// `index`.
	fn restore(&self, dropped: &mut [bool], source: &[bool], index: usize) {
		for i in self.range(index) {
			dropped[i] = source[i];
		}
		let mut path = vec![index];
		let mut topmost = None;
		let mut child = index;
		while let Some(parent) = self.parent(child) {
			path.push(parent);
			if dropped[parent] {
				topmost = Some(path.len() - 1);
			}
			child = parent;
		}
		let Some(topmost) = topmost else { return };
		for step in (1..=topmost).rev() {
			let parent = path[step];
			dropped[parent] = false;
			if let Some(tag) = self.tag(parent) {
				drop_siblings(self.nodes, dropped, tag.children.clone(), path[step - 1]);
			}
		}
	}
}

/// Character count of the selected text in `range`. Matches lxml
/// `text_content()`: whitespace counts and nothing is trimmed.
fn raw_len(nodes: &[Node], dropped: &[bool], range: Range<usize>) -> usize {
	walk(nodes, dropped, range)
		.filter_map(|(_, node)| match node {
			Node::Text(text) => Some(text.chars().count()),
			Node::Tag(_) => None,
		})
		.sum()
}

/// Drop every direct child of `range` except `keep`.
const fn drop_siblings(nodes: &[Node], dropped: &mut [bool], range: Range<usize>, keep: usize) {
	let mut index = range.start;
	while index < range.end {
		if index != keep {
			dropped[index] = true;
		}
		index = end(nodes, index);
	}
}

/// Apply a discard pass (outermost matches only); keep it only if strictly
/// more than one seventh of the original text survives, trafilatura's backup
/// rule (`htmlprocessing.py`).
fn prune_with_backup(
	nodes: &[Node],
	dropped: &mut [bool],
	range: Range<usize>,
	discard: impl FnMut(&Element) -> bool,
) {
	let removed = outermost(nodes, dropped, range.clone(), discard);
	apply_with_backup(nodes, dropped, range, &removed);
}

/// The outermost selected elements in `range` that `matches` accepts.
fn outermost(
	nodes: &[Node],
	dropped: &[bool],
	range: Range<usize>,
	mut matches: impl FnMut(&Element) -> bool,
) -> Vec<usize> {
	let mut index = range.start;
	let mut found = Vec::new();
	while index < range.end {
		if dropped[index] {
			index = end(nodes, index);
		} else if let Node::Tag(tag) = &nodes[index]
			&& matches(tag)
		{
			found.push(index);
			index = tag.children.end;
		} else {
			index += 1;
		}
	}
	found
}

/// Whether dropping `removed` (disjoint subtrees) keeps strictly more than
/// one seventh of the text in `range`.
fn backup_allows(nodes: &[Node], dropped: &[bool], range: Range<usize>, removed: &[usize]) -> bool {
	let original = raw_len(nodes, dropped, range);
	let lost = removed
		.iter()
		.map(|&index| raw_len(nodes, dropped, index..end(nodes, index)))
		.sum::<usize>();
	original - lost > original / 7
}

/// Drop `removed` (disjoint subtrees) if [`backup_allows`] it.
fn apply_with_backup(nodes: &[Node], dropped: &mut [bool], range: Range<usize>, removed: &[usize]) {
	if !removed.is_empty() && backup_allows(nodes, dropped, range, removed) {
		for &index in removed {
			dropped[index] = true;
		}
	}
}

#[cfg(test)]
mod tests {
	use std::fmt::Write as _;

	use super::*;
	use crate::{Hidden, dom::parse};

	fn selected(html: &str, select: impl FnOnce(&[Node], Hidden) -> Selection) -> String {
		let nodes = parse(html).unwrap();
		let selection = select(&nodes, Hidden::Drop);
		walk(&nodes, &selection.dropped, selection.root)
			.filter_map(|(_, node)| match node {
				Node::Text(text) => Some(text.as_str()),
				Node::Tag(_) => None,
			})
			.collect::<Vec<_>>()
			.join(" ")
	}

	const PROSE: &str =
		"The researchers compared notes, checked the evidence, and revised the report. ";

	#[test]
	fn reader_preserves_repeated_code_and_aria_table_cells() {
		let line = "<span>const repeatedValue</span><span> = veryLongObjectName.</span>\
		            <span>getImportantValue</span><span>(anotherArgument);</span>";
		let rail = "<span>First navigation label</span><span>Second navigation label</span>\
		            <span>Third navigation label</span><span>Fourth navigation label</span>";
		let html = format!(
			"<main><h1>Source listing</h1><p>{}</p>\
			 <div role='table' data-markdown-slug='js'>\
			 <div role='row'><code role='cell'>{line}</code></div>\
			 <div role='row'><code role='cell'>{line}</code></div>\
			 <div role='row'><div role='cell'>{line}</div></div>\
			 <div role='row'><div role='cell'>{line}</div></div></div>\
			 <code>{line}</code><code>{line}</code>\
			 <div>{rail}</div><div>{rail}</div></main>",
			PROSE.repeat(4)
		);
		let output = selected(&html, reader);
		assert_eq!(output.matches("getImportantValue").count(), 6, "{output}");
		assert!(!output.contains("First navigation label"), "{output}");
	}

	#[test]
	fn reader_keeps_linked_cards_with_arrow_but_drops_pagers() {
		let html = format!(
			"<main><h1>GPU prices</h1><p>{}</p><h2>Shop by memory</h2>\
			 <div><a href='/4gb'><p>Cheapest 4GB GPU</p>\
			 <p>Example GPU · €659</p><span>See all GPUs</span><span>→</span></a>\
			 <a href='/8gb'><p>Cheapest 8GB GPU</p>\
			 <p>Another GPU · €437</p><span>See all GPUs</span><span>→</span></a></div>\
			 <a href='/next'>Next →</a></main>",
			PROSE.repeat(3)
		);
		let output = selected(&html, reader);
		for text in ["Cheapest 4GB GPU", "Example GPU", "Cheapest 8GB GPU", "Another GPU"] {
			assert!(output.contains(text), "{text} missing from {output}");
		}
		assert!(!output.contains("Next →"), "{output}");
	}

	#[test]
	fn reader_keeps_text_nav_color_utility_but_drops_navigation() {
		let html = format!(
			"<main><h1>Installation</h1><p>{}</p>\
			 <div class='text-nav text-muted'>Invites are going out to our mailing list</div>\
			 <h2>Linux <span class='text-nav'>Server only</span></h2>\
			 <p class='text-nav'>Install the server using these instructions.</p>\
			 <div class='nav'>Unrelated navigation</div></main>",
			PROSE.repeat(3)
		);
		let output = selected(&html, reader);
		for text in [
			"Invites are going out to our mailing list",
			"Server only",
			"Install the server using these instructions.",
		] {
			assert!(output.contains(text), "{text} missing from {output}");
		}
		assert!(!output.contains("Unrelated navigation"), "{output}");
	}

	#[test]
	fn reader_keeps_login_instructions_next_to_sign_in_actions() {
		let html = format!(
			"<main><h1>First API call</h1><div><div>Log in to the account</div>\
			 <div><p>{}</p><div><p>{}</p><div><a href='/register'>Register an account</a>\
			 <a href='/login'>Log in now</a></div></div></div></div><p>{}</p></main>",
			PROSE.repeat(2),
			PROSE.repeat(2),
			PROSE.repeat(4)
		);
		let output = selected(&html, reader);
		assert!(output.contains("Log in to the account"), "{output}");
		assert!(output.matches(PROSE.trim()).count() >= 8, "{output}");
		assert!(!output.contains("Register an account"), "{output}");
		assert!(!output.contains("Log in now"), "{output}");
	}

	#[test]
	fn reader_keeps_content_buttons_and_table_rows_with_border_utilities() {
		let html = format!(
			"<main><h1>Models</h1><p>Using an agent instead? <button>Set it up with one \
			 command</button>.</p><ul><li><button popovertarget='details'>Project \
			 Alpha</button><div id='details' popover role='dialog'>Hidden details</div></li></ul>\
			 <table><tr class='border-b border-nav'><th>Model</th><th>Speed</th></tr><tr \
			 class='border-b border-nav'><td>Example model</td><td>500</td></tr></table>\
			 <p>{}</p><button>Copy page</button></main>",
			PROSE.repeat(4)
		);
		let output = selected(&html, reader);
		for text in ["Set it up with one command", "Project Alpha", "Example model", "500"] {
			assert!(output.contains(text), "{text} missing from {output}");
		}
		for text in ["Hidden details", "Copy page"] {
			assert!(!output.contains(text), "{text} in {output}");
		}
	}

	#[test]
	fn reader_drops_digit_prefixed_footer_chrome() {
		let html = format!(
			"<main><h1>Article</h1><p>{}</p></main><div class='_2016footer2TopWrapper'>\
			 <p>Footer copyright and company information</p></div>",
			PROSE.repeat(4)
		);
		let output = selected(&html, reader);
		assert!(output.contains(PROSE.trim()), "{output}");
		assert!(!output.contains("Footer copyright"), "{output}");
	}

	#[test]
	fn reader_drops_news_aside_even_with_non_link_widget_text() {
		let html = format!(
			"<main><article><h1>Article</h1><p>{}</p></article><aside><h2>Latest news</h2>\
			 <div><a href='/one'><h2>Unrelated story one</h2></a><a href='/two'><h2>\
			 Unrelated story two</h2></a><a href='/three'><h2>Unrelated story three</h2></a>\
			 </div><div>{}</div></aside></main>",
			PROSE.repeat(8),
			"Subscription widget markup and promotional text. ".repeat(20)
		);
		let output = selected(&html, reader);
		assert!(output.contains(PROSE.trim()), "{output}");
		assert!(!output.contains("Unrelated story"), "{output}");
		assert!(!output.contains("Subscription widget"), "{output}");
	}

	#[test]
	fn reader_drops_latest_news_card_section() {
		let html = format!(
			"<main><h1>Article</h1><p>{}</p><div><h2>Latest news</h2><ul><li><a \
			 href='/one'>Unrelated story one</a></li><li><a href='/two'>Unrelated story \
			 two</a></li></ul></div></main>",
			PROSE.repeat(4)
		);
		let output = selected(&html, reader);
		assert!(output.contains(PROSE.trim()), "{output}");
		assert!(!output.contains("Unrelated story"), "{output}");
	}

	#[test]
	fn reader_drops_controls_and_chrome_and_keeps_the_heading() {
		let prose = PROSE.repeat(4);
		let html = format!(
			"<html><head><title>Story - Site</title></head><body><a href='#main'>Skip to \
			 content</a><header><h1>Story</h1><a href='/login'>Sign in</a></header><main \
			 id='main'><p>{prose}</p><button>Copy page</button><img src='s.gif'><p><a \
			 href='/a'>alpha</a> | <a href='/b'>beta</a> | <a href='/c'>gamma</a></p><div \
			 class='page-feedback'>Was this page helpful?</div><a href='/setup' rel='prev'>Previous: \
			 Setup</a></main><div class='site-footer'>Copyright</div></body></html>"
		);
		let output = selected(&html, reader);
		assert!(output.starts_with("Story "), "{output}");
		assert!(output.contains(prose.trim()));
		for noise in ["Skip", "Sign in", "Copy page", "alpha", "helpful", "Previous", "Copyright"] {
			assert!(!output.contains(noise), "{noise} in {output}");
		}
	}

	#[test]
	fn reader_keeps_callouts_and_prose_details_but_not_link_menus() {
		let prose = PROSE.repeat(4);
		let html = format!(
			"<main><p>{prose}</p><aside role='note'><p>Callout \
			 text.</p></aside><details><summary>Deep dive</summary><p>Hidden \
			 explanation.</p></details><details><summary>caches</summary><ul><li><a \
			 href='/x'>Archive</a></li></ul></details></main>"
		);
		let output = selected(&html, reader);
		assert!(output.contains("Callout text."));
		assert!(output.contains("Hidden explanation."));
		assert!(!output.contains("Archive"));
	}

	#[test]
	fn reader_narrows_to_the_story_with_its_heading_standfirst_and_closing_note() {
		let prose = PROSE.repeat(4);
		let html = format!(
			"<html><head><title>Big story | Paper</title></head><body><nav><a \
			 href='/'>Home</a></nav><main><article><h1>Big story</h1><p>The standfirst sums up the \
			 whole story in one long sentence for readers.</p><div \
			 class='article-body'><p>{prose}</p><p>{prose}</p><footer><p>The show streams \
			 now.</p></footer><div><a href='/t/a'>Television</a><a \
			 href='/t/b'>Reviews</a></div></div></article><section><h2>Most viewed</h2><ol><li><a \
			 href='/x'>Other story</a></li></ol></section></main></body></html>"
		);
		let output = selected(&html, reader);
		assert!(output.starts_with("Big story The standfirst"), "{output}");
		assert!(output.contains("The show streams now."));
		for noise in ["Home", "Television", "Most viewed", "Other story"] {
			assert!(!output.contains(noise), "{noise} in {output}");
		}
	}

	#[test]
	fn reader_restores_a_title_without_a_heading() {
		let prose = PROSE.repeat(4);
		let html = format!(
			"<html><title>Slow web pages hurt</title><header><strong>Slow web pages \
			 hurt</strong></header><main><p>{prose}</p><p>{prose}</p></main></html>"
		);
		assert!(selected(&html, reader).starts_with("Slow web pages hurt "));
	}

	#[test]
	fn reader_keeps_comments_that_are_the_page_but_not_comment_forms_or_sign_in_prompts() {
		let html = format!(
			"<main><h1>Thread</h1><p>Which tool should I use?</p><div \
			 class='comment'><p>{PROSE}</p></div><div class='comment'><p>{PROSE}</p></div><div \
			 class='comment'><p>{PROSE}</p></div><form><textarea></textarea><button>Post</button></\
			 form><p>Want to reply? <a href='/login'>Sign in</a></p></main>"
		);
		let output = selected(&html, reader);
		assert_eq!(output.matches(PROSE.trim()).count(), 3, "{output}");
		assert!(!output.contains("Post"));
		assert!(!output.contains("Want to reply"));
	}

	#[test]
	fn reader_drops_a_comment_section_and_a_link_menu_from_an_article() {
		let html = "<article><h1>Estuary monitoring</h1><p>Scientists tracked coastal currents by \
		            measuring the changing salinity of the estuary every six hours.</p><div \
		            class='post-comments'><p>Unrelated reader comments should not become part of \
		            the article.</p></div><ul><li><a href='/'>Home</a></li><li><a \
		            href='/shop'>Shop</a></li><li><a href='/contact'>Contact</a></li></ul><p>During \
		            the dry season the monitoring stations still detected freshwater flowing \
		            seaward below the surface.</p></article>";
		let output = selected(html, reader);
		assert!(output.contains("changing salinity"));
		assert!(output.contains("flowing seaward"));
		assert!(!output.contains("Unrelated reader comments"));
		assert!(!output.contains("Shop"));
		// A heading makes the same list a section of its own.
		let see_also = html.replace("<ul>", "<h2>See also</h2><ul>");
		assert!(selected(&see_also, reader).contains("Shop"));
	}

	#[test]
	fn reader_keeps_a_data_aside_beside_the_content() {
		let prose = PROSE.repeat(4);
		let html = format!(
			"<nav><a href='/'>Home</a></nav><main><article><h1>pkg</h1><p>{prose}</p></\
			 article><aside><h3>Install</h3><p>npm i \
			 pkg</p><h3>Version</h3><p>1.2.3</p><h3>License</h3><p>MIT</p></aside></main>"
		);
		let output = selected(&html, reader);
		assert!(output.contains("npm i pkg"));
		assert!(output.contains("MIT"));
		assert!(!output.contains("Home"));
	}

	#[test]
	fn reader_prunes_landmarks_unless_they_contain_nearly_everything() {
		let prose = PROSE.repeat(4);
		let html = format!(
			"<header>Site \
			 identity</header><nav>Menu</nav><main>{prose}</main><footer>Copyright</\
			 footer><aside>Sidebar</aside>"
		);
		assert_eq!(selected(&html, reader), prose);
		assert_eq!(selected("<aside>123456</aside><p>x</p>", reader), "123456 x");
	}

	/// `body` inside `<main>` after enough prose to pass the guards.
	fn page_with(body: &str) -> String {
		format!("<html><body><main><p>{}</p>{body}</main></body></html>", PROSE.repeat(4))
	}

	#[test]
	fn reader_keeps_headings_whatever_their_class_but_drops_permalinks() {
		let output = selected(
			&page_with(
				"<h2 class='anchor anchorTargetStickyNavbar_Vzrq' id='cause'>Cause<a \
				 class='hash-link' href='#cause'>\u{200b}</a></h2><h3 id='fix'>Fix<a \
				 href='#fix'>¶</a></h3>",
			),
			reader,
		);
		assert!(output.contains("Cause"), "{output}");
		assert!(output.contains("Fix"));
		assert!(!output.contains('\u{200b}') && !output.contains('¶'));
	}

	#[test]
	fn reader_drops_tailwind_hidden_unless_a_breakpoint_shows_it() {
		let output = selected(
			&page_with(
				"<div class='status-pill hidden'>reconnecting</div><span class='hidden \
				 md:inline'>Wide label</span>",
			),
			reader,
		);
		assert!(!output.contains("reconnecting"));
		assert!(output.contains("Wide label"));
	}

	#[test]
	fn reader_keeps_visually_hidden_text_that_spells_out_a_glyph_or_shows_responsively() {
		let output = selected(
			&page_with(
				"<p><span aria-hidden='true'>—</span><span class='sr-only'>Policy \
				 unknown</span></p><table><thead class='sr-only \
				 sm:not-sr-only'><tr><th>Parameter</th></tr></thead></table><p>Link<span \
				 class='sr-only'>opens in a new tab</span></p>",
			),
			reader,
		);
		assert!(output.contains("Policy unknown"));
		assert!(output.contains("Parameter"));
		assert!(!output.contains("opens in a new tab"));
	}

	#[test]
	fn reader_opens_collapsed_panels_but_not_hidden_content() {
		let output = selected(
			&page_with(
				"<button id='q1' aria-controls='a1'>Question?</button><div id='a1' role='region' \
				 aria-labelledby='q1' hidden><p>Answer text.</p></div><div role='tabpanel' \
				 hidden><p>Python sample.</p></div><div hidden><p>Secret.</p></div>",
			),
			reader,
		);
		assert!(output.contains("Answer text."));
		assert!(output.contains("Python sample."));
		assert!(!output.contains("Secret."));
	}

	#[test]
	fn reader_drops_a_link_menu_details_entirely() {
		let output = selected(
			&page_with(
				"<details><summary>Table of Contents</summary><ul><li><a \
				 href='#a'>Abstract</a></li></ul></details>",
			),
			reader,
		);
		assert!(!output.contains("Table of Contents"));
	}

	#[test]
	fn reader_drops_link_heavy_landmarks_around_a_short_main() {
		let links = (0..60).fold(String::new(), |mut links, i| {
			let _ = write!(
				links,
				"<li><a href='/doc/{i}'>Reference page number {i} of the manual</a></li>"
			);
			links
		});
		let html = format!("<nav><ul>{links}</ul></nav><main><p>Short body.</p></main>");
		let output = selected(&html, reader);
		assert!(output.contains("Short body."));
		assert!(!output.contains("Reference page"), "{output}");
	}

	#[test]
	fn reader_drops_a_footer_in_main_but_keeps_an_article_footer() {
		let output = selected(
			&page_with(
				"<article><p>Story.</p><footer><p>Streaming now.</p></footer></article><footer>© 2026 \
				 Site</footer>",
			),
			reader,
		);
		assert!(output.contains("Streaming now."));
		assert!(!output.contains("2026 Site"));
	}

	#[test]
	fn reader_keeps_callout_asides_and_admonition_banners() {
		let output = selected(
			&page_with(
				"<div><p>First step.</p><aside class='warning'>Keep this key secret.</aside><p>Second \
				 step.</p></div><div class='pep-banner sticky-banner admonition'><p>This document is \
				 historical.</p></div>",
			),
			reader,
		);
		assert!(output.contains("Keep this key secret."));
		assert!(output.contains("This document is historical."));
	}

	#[test]
	fn reader_keeps_a_comment_thread() {
		let output = selected(
			&page_with(
				"<div id='comments' class='comments'><h4>3 comments:</h4><dl><dt>Ann</dt><dd>First \
				 reply.</dd><dt>Bo</dt><dd>Second reply.</dd><dt>Cy</dt><dd>Third \
				 reply.</dd></dl></div>",
			),
			reader,
		);
		assert!(output.contains("3 comments:"));
		assert!(output.contains("Third reply."));
	}

	#[test]
	fn reader_keeps_a_call_to_action_in_running_prose() {
		let output = selected(
			&page_with(
				"<p>Don't have an account yet? <a href='/join'>Sign up for free</a> and start \
				 building with the API today, in a few minutes.</p>",
			),
			reader,
		);
		assert!(output.contains("Sign up for free"));
	}

	#[test]
	fn reader_drops_feedback_widgets_and_labelled_pagers() {
		let output = selected(
			&page_with(
				"<div class='root_x'><p>Was this page \
				 helpful?</p><button>Yes</button></div><ul><li>Next message: <a href='/3'>Later \
				 subject</a></li></ul><p>Sorted by: [ <a href='d'>date</a> ] [ <a href='t'>thread</a> \
				 ] [ <a href='s'>author</a> ]</p>",
			),
			reader,
		);
		for noise in ["helpful", "Later subject", "thread", "author"] {
			assert!(!output.contains(noise), "{noise} in {output}");
		}
	}

	#[test]
	fn reader_drops_teaser_sections_but_not_document_sections() {
		let html = format!(
			"<html><body><main><article><p>{}</p><h2 id='related-resources'>Related \
			 resources</h2><ul><li><a href='/guide'>Configuration \
			 guide</a></li></ul></article><section><h2>Related posts</h2><a \
			 href='/other'><h3>Another story entirely</h3></a></section></main></body></html>",
			PROSE.repeat(4)
		);
		let output = selected(&html, reader);
		assert!(output.contains("Configuration guide"));
		assert!(!output.contains("Related posts"));
		assert!(!output.contains("Another story"));
	}

	#[test]
	fn reader_drops_an_in_page_table_of_contents_unless_the_text_introduces_it() {
		let list = "<ul><li><a href='#intro'>Introduction to the toolkit</a></li><li><a \
		            href='#usage'>Usage of the main commands</a></li><li><a href='#faq'>Frequently \
		            asked questions</a></li></ul>";
		let sections = format!(
			"<h2 id='intro'>Intro</h2><p>{PROSE}</p><h2 id='usage'>Usage</h2><p>{PROSE}</p><h2 \
			 id='faq'>FAQ</h2><p>{PROSE}</p>"
		);
		let contents = format!("<div class='toc'><p>Contents</p>{list}</div>{sections}");
		let output = selected(&page_with(&contents), reader);
		assert!(!output.contains("Introduction to the toolkit"));
		assert!(!output.contains("Contents"));
		let introduced = format!("<p>The sections are:</p>{list}{sections}");
		assert!(selected(&page_with(&introduced), reader).contains("Introduction to the toolkit"));
	}

	#[test]
	fn reader_falls_back_to_a_noscript_copy_of_an_empty_app_shell() {
		let prose = PROSE.repeat(8);
		let html = format!(
			"<html><body><main \
			 id='app'></main><noscript><h1>Eval</h1><p>{prose}</p></noscript></body></html>"
		);
		assert!(selected(&html, reader).contains(prose.trim()));
		let gate = "<html><body><main id='app'></main><noscript><p>Please enable \
		            JavaScript.</p></noscript></body></html>";
		assert!(!selected(gate, reader).contains("enable"));
	}

	#[test]
	fn reader_drops_menus_top_bars_and_version_badges_by_name() {
		let output = selected(
			&page_with(
				"<div id='menu'><p>Pins and index</p></div><div class='topbar'>MY ACCOUNT</div><span \
				 class='theme-doc-version-badge'>Version: 1.13</span>",
			),
			reader,
		);
		for noise in ["Pins", "MY ACCOUNT", "Version:"] {
			assert!(!output.contains(noise), "{noise} in {output}");
		}
	}

	#[test]
	fn reader_with_reachable_reveals_disclosures_but_not_hidden_chrome() {
		let html = page_with(
			"<details><summary>More</summary><p>Hidden explanation.</p></details><div \
			 style='display:none'><a href='/policy'>Policy and \
			 Safety</a></div><details><summary>caches</summary><ul><li><a \
			 href='/x'>Archive</a></li></ul></details><footer hidden>© 2026 Corp</footer>",
		);
		let nodes = parse(&html).unwrap();
		let selection = reader(&nodes, Hidden::Reachable);
		let output = walk(&nodes, &selection.dropped, selection.root)
			.filter_map(|(_, node)| match node {
				Node::Text(text) => Some(text.as_str()),
				Node::Tag(_) => None,
			})
			.collect::<String>();
		assert!(output.contains("Hidden explanation."));
		for noise in ["Policy", "Archive", "2026 Corp"] {
			assert!(!output.contains(noise), "{noise} in {output}");
		}
	}

	#[test]
	fn reader_with_reachable_expands_collapsed_content_but_not_collapsed_menus() {
		let html = page_with(
			"<button aria-expanded='false'>Item details</button><div \
			 style='display:none'><table><tr><td>Brand</td><td>Wakefit</td></tr></table></\
			 div><button aria-expanded='false'>Menu</button><div hidden><a href='/a'>Shop</a> <a \
			 href='/b'>Account</a></div><div hidden><p>Access requires \
			 authorization.</p></div><template><p>Template-only claim</p></template>",
		);
		let nodes = parse(&html).unwrap();
		let text = |hidden| {
			let selection = reader(&nodes, hidden);
			walk(&nodes, &selection.dropped, selection.root)
				.filter_map(|(_, node)| match node {
					Node::Text(text) => Some(text.as_str()),
					Node::Tag(_) => None,
				})
				.collect::<Vec<_>>()
				.join(" ")
		};
		let reachable = text(Hidden::Reachable);
		assert!(reachable.contains("Brand Wakefit"), "{reachable}");
		for chrome in ["Shop", "authorization", "Template-only"] {
			assert!(!reachable.contains(chrome), "{chrome} in {reachable}");
		}
		assert!(!text(Hidden::Drop).contains("Wakefit"));
	}

	#[test]
	fn reader_keeps_trailing_cards_but_drops_trailing_bars_and_links() {
		let output = selected(
			&page_with(
				"<pre>diff body</pre><ul><li><b>Sorted by:</b> <a href='d'>[ date ]</a> <a href='t'>[ \
				 thread ]</a> <a href='s'>[ subject ]</a></li></ul><hr><a href='/list'>More \
				 information about the list</a>",
			),
			reader,
		);
		assert!(!output.contains("[ thread ]"), "{output}");
		assert!(!output.contains("More information"));
		let output = selected(
			&page_with(
				"<p>Last paragraph.</p><div><a href='/a'><div>Embeddings</div><div>A vector \
				 representation of an input.</div></a><a href='/b'><div>Chat</div><div>Replies to \
				 messages.</div></a></div>",
			),
			reader,
		);
		assert!(output.contains("A vector representation of an input."));
	}

	#[test]
	fn reader_drops_a_field_label_with_its_field_but_keeps_other_labels() {
		let output = selected(
			&page_with(
				"<div><span>Version:</span><span><select><option>1.0</option></select></span></\
				 div><label for='c'>Billing cycle</label><select \
				 id='c'><option>Monthly</option></select>",
			),
			reader,
		);
		assert!(!output.contains("Version:"));
		assert!(output.contains("Billing cycle"));
	}

	#[test]
	fn reader_drops_subscription_prompts_and_promo_bars() {
		let html = format!(
			"<html><body><div class='sticky top-0'><p>Enrollment is open! <a href='/course'>Course \
			 page</a></p></div><main><h1>Title</h1><p>{}</p><div class='blog-feeds'><div>Subscribe \
			 to: <a href='/feed'>Posts (Atom)</a></div></div></main></body></html>",
			PROSE.repeat(4)
		);
		let output = selected(&html, reader);
		assert!(!output.contains("Enrollment"), "{output}");
		assert!(!output.contains("Posts (Atom)"));
	}

	#[test]
	fn reader_drops_link_sidebars_but_keeps_prose_sidebars() {
		let output = selected(
			&page_with(
				"<div class='cart-sidebar'><a href='/a'>Europe servers</a> <a href='/b'>Asia \
				 servers</a></div><div class='sidebarSection'><p>Empowering everyone to build \
				 software.</p><a href='/s'>12k stars</a></div>",
			),
			reader,
		);
		assert!(!output.contains("Europe servers"));
		assert!(output.contains("Empowering everyone"));
	}

	#[test]
	fn reader_drops_a_repeated_rail_of_short_labels() {
		let rail = "<div><p>Menu</p><p>Crystal Dumplings</p><p>Har Gao</p><p>Siu Mai</p><p>Xiao \
		            Long Bao</p><p>Pork Gyoza</p></div>";
		let dishes =
			"<h3>Siu Mai</h3><p>Pork and prawn dumplings, steamed to order and served in fours.</p>";
		let output = selected(&page_with(&format!("{rail}{dishes}{rail}")), reader);
		assert_eq!(output.matches("Siu Mai").count(), 1, "{output}");
		assert!(output.contains("Pork and prawn"));
		// A single index is left alone.
		let output = selected(&page_with(&format!("{rail}{dishes}")), reader);
		assert!(output.contains("Crystal Dumplings"));
	}

	#[test]
	fn reader_keeps_labelled_selects_but_not_pickers() {
		let output = selected(
			&page_with(
				"<form><div><label for='ram'>Memory</label><select id='ram'><option>128 GB \
				 RAM</option></select></div><label>Plan <select><option \
				 selected>Monthly</option></select></label><select><option>Europe</option></\
				 select><label for='v'>Version:</label><select id='v' \
				 name='version'><option>latest</option></select></form><header><label \
				 for='h'>Size</label><select id='h'><option>Large</option></select></header>",
			),
			reader,
		);
		assert!(output.contains("128 GB RAM"), "{output}");
		assert!(output.contains("Monthly"));
		for noise in ["Europe", "latest", "Version:", "Large"] {
			assert!(!output.contains(noise), "{noise} in {output}");
		}
	}

	#[test]
	fn reader_drops_a_bar_parked_off_screen() {
		let output = selected(
			&format!(
				"<html><body><div style='opacity:0;transform:translateY(-100%)'><p>Enrollment is \
				 open! <a href='/course'>Course page</a></p></div><p>{}</p></body></html>",
				PROSE.repeat(4)
			),
			reader,
		);
		assert!(!output.contains("Enrollment"), "{output}");
	}

	#[test]
	fn reader_does_not_narrow_past_a_page_heading_the_title_misses() {
		let rows = (0..40).fold(String::new(), |mut rows, i| {
			let _ = write!(rows, "<tr><td>icon-{i}.svg</td><td>image/svg+xml</td><td>2 kB</td></tr>");
			rows
		});
		let html = format!(
			"<html><head><title>Site</title></head><body><main><header><h1>pkg-name</h1><p>A package \
			 of brand icons.</p></header><main><table><thead \
			 class='hidden'><tr><th>Filename</th></tr></thead><tbody>{rows}</tbody></table></main></\
			 main></body></html>"
		);
		let output = selected(&html, reader);
		for kept in ["pkg-name", "A package of brand icons.", "Filename", "icon-39.svg"] {
			assert!(output.contains(kept), "{kept} missing from {output}");
		}
	}

	#[test]
	fn reader_restores_a_hero_standfirst_and_date_with_its_heading() {
		let html = format!(
			"<html><head><title>Blog</title></head><body><section><div><h1>Incident \
			 report</h1><p>During a routine evaluation the institute identified an incident worth \
			 sharing.</p><div>— Aug 4, \
			 2026</div></div></section><article><p>{}</p></article></body></html>",
			PROSE.repeat(4)
		);
		let output = selected(&html, reader);
		assert!(output.starts_with("Incident report"), "{output}");
		assert!(output.contains("During a routine evaluation"));
		assert!(output.contains("Aug 4, 2026"));
	}

	#[test]
	fn reader_keeps_the_name_of_an_inline_widget_in_a_sentence() {
		let output = selected(
			&page_with(
				"<p>Disable it with <span class='setting'><span class='setting-dropdown'><span \
				 class='setting-link-main'>terminal.shell.enabled</span><button>v</button><span \
				 role='menu'>Open in editor</span></span></span> set to false.</p>",
			),
			reader,
		);
		assert!(output.contains("terminal.shell.enabled"), "{output}");
		assert!(!output.contains("Open in editor"));
	}

	#[test]
	fn reader_keeps_a_link_row_in_an_article_but_not_a_bar_outside() {
		let html = format!(
			"<html><body><div><a href='/'>new</a> | <a href='/past'>past</a> | <a \
			 href='/ask'>ask</a></div><article><p>{}</p><p><a href='/demo'>Demo</a> | <a \
			 href='/repo'>Repository</a> | <a href='/paper'>Paper</a></p></article></body></html>",
			PROSE.repeat(4)
		);
		let output = selected(&html, reader);
		assert!(output.contains("Paper"), "{output}");
		assert!(!output.contains("past"));
	}

	#[test]
	fn reader_restores_a_byline_from_a_post_footer_without_its_share_row() {
		let output = selected(
			&format!(
				"<html><body><article class='post'><p>{}</p><div class='post-footer'><div><span \
				 class='post-author vcard'>Posted by Ann</span> <span class='post-timestamp'>at \
				 09:57</span> <a class='share-button' href='/s'>Share to \
				 X</a></div></div></article></body></html>",
				PROSE.repeat(4)
			),
			reader,
		);
		assert!(output.contains("Posted by Ann"), "{output}");
		assert!(output.contains("at 09:57"));
		assert!(!output.contains("Share to X"));
	}

	#[test]
	fn reader_brings_back_footnotes_the_article_links_to() {
		let html = format!(
			"<html><body><main><article><p>{}<a href='#footnote-1'>1</a></p></article><div \
			 class='notes'><div id='footnote-1'>Prices apply after the \
			 period.</div></div></main></body></html>",
			PROSE.repeat(6)
		);
		assert!(selected(&html, reader).contains("Prices apply after the period."));
	}

	#[test]
	fn reader_drops_labels_left_by_their_controls_and_comment_prompts() {
		let output = selected(
			&page_with(
				"<div><h2>Reply via email to</h2><form><button>Ann</button></form></div><div \
				 class='continue'><a class='comment-reply'>Add \
				 comment</a></div><article><footer><p><span>Filed under:</span> <a \
				 href='/t'>Gemini</a></p><p>Author: Cursor Team</p></footer></article>",
			),
			reader,
		);
		for noise in ["Reply via email", "Add comment", "Filed under:", "Gemini"] {
			assert!(!output.contains(noise), "{noise} in {output}");
		}
		assert!(output.contains("Author: Cursor Team"), "{output}");
	}

	#[test]
	fn reader_keeps_text_tab_labels_but_not_button_tabs() {
		let output = selected(
			&page_with(
				"<ul role='tablist'><li role='tab'>200</li><li role='tab'>404</li></ul><div \
				 role='tabpanel'><p>Successful response.</p></div><div role='tablist'><button \
				 role='tab'>Python</button></div>",
			),
			reader,
		);
		assert!(output.contains("404"), "{output}");
		assert!(!output.contains("Python"));
	}

	#[test]
	fn reader_drops_view_all_card_grids_polls_but_not_label_hidden_fields() {
		let output = selected(
			&page_with(
				"<div class='field field--label-hidden'><p>Supported models list.</p></div><div><div \
				 class='d-flex'><h2>More Restaurants</h2><a href='/r'>View All</a></div><div><h3><a \
				 href='/x'>Other place</a></h3><p>An excerpt about the other place and its \
				 food…</p></div></div><div class='block-poll'><h2>Which brand is \
				 easiest?</h2><p>Dell</p></div>",
			),
			reader,
		);
		assert!(output.contains("Supported models list."));
		for noise in ["More Restaurants", "Other place", "Which brand"] {
			assert!(!output.contains(noise), "{noise} in {output}");
		}
	}

	#[test]
	fn reader_drops_image_maps_but_leaves_other_alt_less_images_to_the_writer() {
		let nodes = parse(&page_with(
			"<img src='diagram.png'><img src='s.gif' height='1' width='40'><img src='nav.gif' 			 \
			 usemap='#nav' ismap>",
		))
		.unwrap();
		let selection = reader(&nodes, Hidden::Drop);
		let shown: Vec<&str> = walk(&nodes, &selection.dropped, selection.root)
			.filter_map(|(_, node)| match node {
				Node::Tag(tag) if tag.name() == "img" => tag.attr("src"),
				_ => None,
			})
			.collect();
		assert_eq!(shown, ["diagram.png", "s.gif"]);
	}

	#[test]
	fn full_keeps_every_visible_landmark() {
		let output = selected("<nav>Menu</nav><main>Body</main><footer>Copyright</footer>", full);
		assert_eq!(output, "Menu Body Copyright");
	}
}
