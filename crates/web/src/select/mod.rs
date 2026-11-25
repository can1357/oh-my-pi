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
	mut discard: impl FnMut(&Element) -> bool,
) {
	let mut index = range.start;
	let mut removed = Vec::new();
	while index < range.end {
		if dropped[index] {
			index = end(nodes, index);
		} else if let Node::Tag(tag) = &nodes[index]
			&& discard(tag)
		{
			removed.push(index);
			index = tag.children.end;
		} else {
			index += 1;
		}
	}
	if removed.is_empty() {
		return;
	}
	let original = raw_len(nodes, dropped, range);
	let lost = removed
		.iter()
		.map(|&index| raw_len(nodes, dropped, index..end(nodes, index)))
		.sum::<usize>();
	if original - lost > original / 7 {
		for index in removed {
			dropped[index] = true;
		}
	}
}

#[cfg(test)]
mod tests {
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

	#[test]
	fn full_keeps_every_visible_landmark() {
		let output = selected("<nav>Menu</nav><main>Body</main><footer>Copyright</footer>", full);
		assert_eq!(output, "Menu Body Copyright");
	}
}
