//! The reader pipeline ([`reader`]) and the Lynx-complete visible selection
//! ([`full`]) it starts from.

use std::ops::Range;

use super::{
	Selection, Tree, drop_siblings, end, prune_with_backup, raw_len, rules, text_len, walk,
};
use crate::{
	Hidden,
	dom::{Element, Node},
};

/// Check the HTML visibility signals controlled by the caller's policy.
pub fn is_hidden(tag: &Element, hidden: Hidden) -> bool {
	let name = tag.name();
	if matches!(name, "template" | "noscript") {
		let shadow_root =
			name == "template" && matches!(tag.attr("shadowrootmode"), Some("open" | "closed"));
		return matches!(hidden, Hidden::Drop)
			|| (!shadow_root && matches!(hidden, Hidden::Reachable));
	}
	matches!(hidden, Hidden::Drop)
		&& (tag.has_attr("hidden")
			|| tag
				.attr("aria-hidden")
				.is_some_and(|value| value.trim().eq_ignore_ascii_case("true"))
			|| tag
				.attr("style")
				.unwrap_or_default()
				.split(';')
				.filter_map(|declaration| declaration.split_once(':'))
				.any(|(property, value)| {
					let value = value.split('!').next().unwrap_or_default().trim();
					let property = property.trim();
					(property.eq_ignore_ascii_case("display") && value.eq_ignore_ascii_case("none"))
						|| (property.eq_ignore_ascii_case("visibility")
							&& value.eq_ignore_ascii_case("hidden"))
				}))
}

/// Select visible page content, including navigation and other page landmarks.
pub fn full(nodes: &[Node], hidden: Hidden) -> Selection {
	visible(nodes, hidden, false)
}

/// Select visible page content. With `reveal_prose`, a closed `<details>`
/// whose body is prose rather than a menu of links counts as content: a reader
/// opens it, while lynx shows only its summary.
fn visible(nodes: &[Node], hidden: Hidden, reveal_prose: bool) -> Selection {
	let mut dropped = vec![false; nodes.len()];
	let mut index = 0;
	while index < nodes.len() {
		if dropped[index] {
			index = end(nodes, index);
			continue;
		}
		if let Node::Tag(tag) = &nodes[index] {
			if is_hidden(tag, hidden) || matches!(tag.name(), "script" | "style" | "title" | "svg") {
				dropped[index] = true;
				index = tag.children.end;
				continue;
			}
			if tag.name() == "head" {
				// The text writer displays toolbar links and refresh notices.
				// Other head contents never contribute to the page body.
				let mut child = tag.children.start;
				while child < tag.children.end {
					if !matches!(&nodes[child], Node::Tag(tag) if matches!(tag.name(), "link" | "meta"))
					{
						dropped[child] = true;
					}
					child = end(nodes, child);
				}
			}
			if matches!(hidden, Hidden::Drop)
				&& tag.name() == "details"
				&& !tag.has_attr("open")
				&& !(reveal_prose && holds_prose(nodes, tag))
			{
				// A closed details element exposes only its first summary. Its own
				// visibility and that of the summary still obey ordinary HTML
				// rules.
				let mut child = tag.children.start;
				let mut summary = false;
				while child < tag.children.end {
					if !summary && matches!(&nodes[child], Node::Tag(tag) if tag.name() == "summary") {
						summary = true;
					} else {
						dropped[child] = true;
					}
					child = end(nodes, child);
				}
			}
		}
		index += 1;
	}
	Selection { root: 0..nodes.len(), dropped, recoverable_only: false }
}

/// Whether a `<details>` body (everything but its first summary) is mostly
/// text outside links.
fn holds_prose(nodes: &[Node], details: &Element) -> bool {
	let mut summary = false;
	let mut count = LinkCount::default();
	let mut child = details.children.start;
	while child < details.children.end {
		match &nodes[child] {
			Node::Tag(tag) if !summary && tag.name() == "summary" => summary = true,
			_ => count.add(nodes, &[], child..end(nodes, child), false),
		}
		child = end(nodes, child);
	}
	count.text > 0 && 2 * count.link < count.text
}

/// Visible characters of a subtree and those inside links.
#[derive(Default)]
struct LinkCount {
	text: usize,
	link: usize,
}

impl LinkCount {
	/// Count `range`, skipping subtrees flagged in `dropped` (which may be
	/// empty: nothing dropped).
	fn of(nodes: &[Node], dropped: &[bool], range: Range<usize>) -> Self {
		let mut count = Self::default();
		count.add(nodes, dropped, range, false);
		count
	}

	fn add(&mut self, nodes: &[Node], dropped: &[bool], range: Range<usize>, in_link: bool) {
		let mut index = range.start;
		while index < range.end {
			if dropped.get(index).copied().unwrap_or(false) {
				index = end(nodes, index);
				continue;
			}
			match &nodes[index] {
				Node::Text(text) => {
					let chars = text.chars().filter(|ch| !ch.is_whitespace()).count();
					self.text += chars;
					if in_link {
						self.link += chars;
					}
				},
				Node::Tag(tag) if !matches!(tag.name(), "script" | "style" | "template") => {
					let link = in_link || (tag.name() == "a" && tag.has_attr("href"));
					self.add(nodes, dropped, tag.children.clone(), link);
				},
				Node::Tag(_) => {},
			}
			index = end(nodes, index);
		}
	}
}

/// Select the page's content: one rule pipeline, the same for every page.
///
/// 1. Start from everything visible, as Lynx shows it; a closed `<details>`
///    whose body is prose opens.
/// 2. Drop controls: form fields, buttons, dialogs, popovers, menus, comment
///    forms, skip links, pagers, edit/report links, sign-in prompts, bars of
///    separated links and images without alt text.
/// 3. Drop navigation, banner, contentinfo and complementary landmarks, except
///    asides holding labelled data. Kept only if more than one seventh of the
///    text survives.
/// 4. Drop blocks whose class or id names chrome (footer, cookie, feedback,
///    share, ad, print-hidden, visually hidden, ...), never one framing the
///    main region, an article or the page heading. Same guard.
/// 5. Drop comment sections trafilatura recognizes (comment lists, Disqus).
///    Same guard: where comments are the page (a thread), they stay.
/// 6. Narrow to the innermost content region (`main`, an `<article>`, a
///    trafilatura-marked article body) holding two thirds of the remaining
///    text, never past the page heading; data asides beside it stay.
/// 7. Drop link-dominated blocks trailing the last paragraph before any further
///    heading (topic tags, share and reuse links). Same guard.
/// 8. Drop link menus: lists of three or more items that are each one short
///    link and nothing else, unless a heading introduces the list (a "See also"
///    section). Same guard.
/// 9. Restore the page heading when none survived, with its standfirst.
pub fn reader(nodes: &[Node], hidden: Hidden) -> Selection {
	let tree = Tree::new(nodes);
	let mut selection = visible(nodes, hidden, true);
	drop_controls(&tree, &mut selection.dropped);
	let controlled = selection.dropped.clone();
	let root = selection.root.clone();
	prune_with_backup(nodes, &mut selection.dropped, root.clone(), |tag| {
		is_landmark(&tree, tag) && !is_data_aside(nodes, &controlled, tag)
	});
	prune_with_backup(nodes, &mut selection.dropped, root.clone(), |tag| {
		is_chrome(tag) && !frames_content(nodes, tag)
	});
	prune_with_backup(nodes, &mut selection.dropped, root.clone(), |tag| {
		rules::matches_any(rules::COMMENTS, tag)
	});
	let region = narrow_to_region(&tree, &mut selection.dropped, &controlled);
	drop_trailing_links(&tree, &mut selection.dropped, region);
	let narrowed = selection.dropped.clone();
	prune_with_backup(nodes, &mut selection.dropped, root, |tag| {
		is_link_menu(&tree, &narrowed, tag)
	});
	if let Some(heading) = restore_title(&tree, &mut selection.dropped, &controlled) {
		restore_lead(&tree, &mut selection.dropped, &controlled, heading);
	}
	selection
}

/// A content region must hold this share of the remaining text.
const REGION_SHARE: (usize, usize) = (2, 3);
/// A sign-in prompt block holds at most this much text.
const PROMPT_MAX_CHARS: usize = 300;
/// Labels longer than this are prose, not controls.
const LABEL_MAX_CHARS: usize = 60;
/// A title block holds at most this much text besides its heading.
const TITLE_BLOCK_EXTRA_CHARS: usize = 80;

const fn is_heading(name: &str) -> bool {
	matches!(name.as_bytes(), [b'h', b'1'..=b'6'])
}

fn has_role(tag: &Element, wanted: &[&str]) -> bool {
	tag.attr("role").is_some_and(|roles| {
		roles.split_ascii_whitespace().any(|role| {
			wanted
				.iter()
				.any(|wanted| role.eq_ignore_ascii_case(wanted))
		})
	})
}

/// Navigation, banner, contentinfo and complementary landmarks. An explicit
/// role overrides the element's implicit one (`<aside role="note">` is a
/// callout). As in ARIA, a `<header>` or `<footer>` inside an article,
/// aside, main, nav or section belongs to that section and is no landmark.
fn is_landmark(tree: &Tree, tag: &Element) -> bool {
	match tag.attr("role") {
		Some(roles) if !roles.trim().is_empty() => {
			has_role(tag, &["navigation", "banner", "contentinfo", "complementary"])
		},
		_ => match tag.name() {
			"nav" | "aside" => true,
			"header" | "footer" => {
				!std::iter::successors(tree.parent(tag.index()), |&index| tree.parent(index))
					.filter_map(|index| tree.tag(index))
					.any(|section| {
						matches!(section.name(), "article" | "aside" | "main" | "nav" | "section")
							|| has_role(section, &["main"])
					})
			},
			_ => false,
		},
	}
}

/// Labelled fields that make an aside data rather than navigation.
const DATA_ASIDE_MIN_LABELS: usize = 3;

/// A complementary aside holding labelled data (a package's install command,
/// repository, downloads and version under their own headings) rather than
/// links: it is content.
fn is_data_aside(nodes: &[Node], dropped: &[bool], tag: &Element) -> bool {
	let complementary = match tag.attr("role") {
		Some(roles) if !roles.trim().is_empty() => has_role(tag, &["complementary"]),
		_ => tag.name() == "aside",
	};
	if !complementary {
		return false;
	}
	let labels = walk(nodes, dropped, tag.children.clone())
		.filter(|(_, node)| {
			matches!(node, Node::Tag(inner)
				if matches!(inner.name(), "h2" | "h3" | "h4" | "h5" | "h6" | "dt" | "th"))
		})
		.count();
	let count = LinkCount::of(nodes, dropped, tag.children.clone());
	labels >= DATA_ASIDE_MIN_LABELS && 2 * count.link < count.text
}

// ── Controls ─────────────────────────────────────────────────────────────

/// Drop controls everywhere: pipeline step 2 of [`reader`].
fn drop_controls(tree: &Tree, dropped: &mut [bool]) {
	let nodes = tree.nodes;
	let prompts: Vec<usize> = walk(nodes, dropped, 0..nodes.len())
		.filter_map(|(index, node)| match node {
			Node::Tag(tag) if matches!(tag.name(), "a" | "button") && is_sign_in(nodes, tag) => {
				Some(index)
			},
			_ => None,
		})
		.collect();
	for index in prompts {
		let block = prompt_block(tree, dropped, index);
		dropped[block] = true;
	}
	controls(tree, dropped, 0..nodes.len(), false);
}

/// Drop controls among the siblings of `range` and below. Inside headings,
/// summaries and terms a button is the label itself (accordions) and stays.
fn controls(tree: &Tree, dropped: &mut [bool], range: Range<usize>, label: bool) {
	let nodes = tree.nodes;
	drop_link_runs(nodes, dropped, range.clone());
	let mut index = range.start;
	while index < range.end {
		if dropped[index] {
			index = end(nodes, index);
			continue;
		}
		let Node::Tag(tag) = &nodes[index] else {
			index += 1;
			continue;
		};
		if is_control(nodes, tag, label) {
			dropped[index] = true;
		} else {
			let label = label || is_heading(tag.name()) || matches!(tag.name(), "summary" | "dt");
			controls(tree, dropped, tag.children.clone(), label);
		}
		index = tag.children.end;
	}
}

fn is_control(nodes: &[Node], tag: &Element, label: bool) -> bool {
	let control = match tag.name() {
		"link" | "dialog" | "input" | "select" | "textarea" | "option" | "datalist" | "search"
		| "menu" => true,
		"button" => !label,
		// A comment or reply form; a form wrapping the page is no control.
		"form" => {
			nodes[tag.children.clone()]
				.iter()
				.any(|node| matches!(node, Node::Tag(field) if field.name() == "textarea"))
				&& !frames_content(nodes, tag)
		},
		// Spacers, tracking pixels and decorative images carry no text.
		"img" => tag.attr("alt").is_none_or(|alt| alt.trim().is_empty()),
		"a" => is_skip_link(nodes, tag) || is_pager(nodes, tag) || is_page_tool(nodes, tag),
		_ => false,
	};
	control
		|| tag.has_attr("popover")
		|| tag
			.attr("aria-modal")
			.is_some_and(|value| value.trim().eq_ignore_ascii_case("true"))
		|| has_role(tag, &[
			"dialog",
			"alertdialog",
			"alert",
			"menu",
			"menubar",
			"tooltip",
			"search",
			"toolbar",
			"tablist",
		])
}

/// Whitespace-collapsed text of the selected nodes in `range` when it is at
/// most `limit` characters.
fn label(nodes: &[Node], dropped: &[bool], range: Range<usize>, limit: usize) -> Option<String> {
	collapse(
		walk(nodes, dropped, range).filter_map(|(_, node)| match node {
			Node::Text(text) => Some(text.as_str()),
			Node::Tag(_) => None,
		}),
		limit,
	)
}

/// Whitespace-collapsed text of all nodes in `range` when it is at most
/// `limit` characters.
fn plain_label(nodes: &[Node], range: Range<usize>, limit: usize) -> Option<String> {
	collapse(
		nodes[range].iter().filter_map(|node| match node {
			Node::Text(text) => Some(text.as_str()),
			Node::Tag(_) => None,
		}),
		limit,
	)
}

fn collapse<'a>(texts: impl Iterator<Item = &'a str>, limit: usize) -> Option<String> {
	let mut out = String::new();
	let mut chars = 0;
	for text in texts {
		for word in text.split_whitespace() {
			if !out.is_empty() {
				out.push(' ');
				chars += 1;
			}
			out.push_str(word);
			chars += word.chars().count();
			if chars > limit {
				return None;
			}
		}
	}
	Some(out)
}

fn starts_with_words(text: &str, prefix: &str) -> bool {
	text
		.get(..prefix.len())
		.is_some_and(|head| head.eq_ignore_ascii_case(prefix))
		&& !text[prefix.len()..].starts_with(|ch: char| ch.is_alphanumeric())
}

/// "Skip to content" and "Jump to navigation" links.
fn is_skip_link(nodes: &[Node], tag: &Element) -> bool {
	tag.attr("href")
		.is_some_and(|href| href.trim().starts_with('#'))
		&& plain_label(nodes, tag.children.clone(), LABEL_MAX_CHARS).is_some_and(|text| {
			starts_with_words(&text, "skip") || starts_with_words(&text, "jump to")
		})
}

const ARROWS: &[char] = &['←', '→', '«', '»', '‹', '›'];

/// Previous/next pager links.
fn is_pager(nodes: &[Node], tag: &Element) -> bool {
	if tag.attr("rel").is_some_and(|rel| {
		rel.split_ascii_whitespace().any(|rel| {
			["next", "prev", "previous"]
				.iter()
				.any(|w| rel.eq_ignore_ascii_case(w))
		})
	}) {
		return true;
	}
	let mut texts = nodes[tag.children.clone()]
		.iter()
		.filter_map(|node| match node {
			Node::Text(text) if !text.trim().is_empty() => Some(text.trim()),
			_ => None,
		});
	let Some(first) = texts.next() else {
		return false;
	};
	let last = texts.next_back().unwrap_or(first);
	[first, last].into_iter().any(|text| {
		if text.starts_with(ARROWS) || text.ends_with(ARROWS) {
			return true;
		}
		let word = text.trim_matches(|ch: char| ARROWS.contains(&ch) || ch.is_whitespace());
		[
			"previous",
			"prev",
			"next",
			"older",
			"newer",
			"previous page",
			"next page",
			"previous article",
			"next article",
			"previous post",
			"next post",
			"older posts",
			"newer posts",
		]
		.iter()
		.any(|pager| word.eq_ignore_ascii_case(pager))
			|| ["previous:", "prev:", "next:"]
				.iter()
				.any(|prefix| starts_with_words(word, prefix))
	})
}

/// Edit, source and report links about the page itself.
fn is_page_tool(nodes: &[Node], tag: &Element) -> bool {
	let Some(text) = plain_label(nodes, tag.children.clone(), 40) else {
		return false;
	};
	["edit", "edit source", "view source", "edit page", "view page source", "report"]
		.iter()
		.any(|tool| text.eq_ignore_ascii_case(tool))
		|| [
			"edit this page",
			"edit this article",
			"edit on github",
			"update on github",
			"improve this page",
			"view this page on github",
			"suggest an edit",
			"suggest edits",
			"report a problem",
			"report an issue",
			"report a bug",
			"report abuse",
			"report malware",
			"report this",
			"report repository",
			"report content",
			"report spam",
		]
		.iter()
		.any(|tool| starts_with_words(&text, tool))
}

/// Sign-in, sign-up and account-creation links and buttons.
fn is_sign_in(nodes: &[Node], tag: &Element) -> bool {
	plain_label(nodes, tag.children.clone(), 40).is_some_and(|text| {
		[
			"sign in",
			"sign up",
			"sign on",
			"signin",
			"signup",
			"log in",
			"login",
			"log on",
			"register",
			"create account",
			"create an account",
			"create a free account",
			"create your account",
			"join for free",
			"join now",
		]
		.iter()
		.any(|prompt| starts_with_words(&text, prompt))
	})
}

/// The largest short block around a sign-in control: the whole prompt ("Join
/// the community ... Sign up"), never a section with headings.
fn prompt_block(tree: &Tree, dropped: &[bool], control: usize) -> usize {
	let nodes = tree.nodes;
	let mut block = control;
	while let Some(parent) = tree.parent(block) {
		let Some(tag) = tree.tag(parent) else { break };
		if matches!(tag.name(), "html" | "body" | "main" | "article")
			|| is_landmark(tree, tag)
			|| has_role(tag, &["main"])
			|| text_len(nodes, dropped, tag.children.clone()) > PROMPT_MAX_CHARS
			|| nodes[tag.children.clone()]
				.iter()
				.any(|node| matches!(node, Node::Tag(tag) if matches!(tag.name(), "h1" | "h2" | "h3")))
		{
			break;
		}
		block = parent;
	}
	block
}

/// Separators that join a bar of links (`a | b | c`, `a · b · c`).
const BAR_SEPARATORS: &[char] = &['|', '·', '•', '∙', '⋅', '‧', '›', '»', '/', '⁄'];
/// Brackets that may also sit between bar links (`a | b (c)`).
const BAR_BRACKETS: &[char] = &['(', ')', '[', ']'];
/// A link bar has at least this many links.
const BAR_MIN_LINKS: usize = 3;

/// Drop runs of at least three sibling links joined only by separators: menu
/// and footer bars, item action rows (`hide | past | favorite`). Separator
/// text right before the run goes with it.
fn drop_link_runs(nodes: &[Node], dropped: &mut [bool], range: Range<usize>) {
	struct Run {
		start: usize,
		end:   usize,
		links: usize,
		/// A separator (not only brackets) joins the run.
		bar:   bool,
		/// A separator follows the last link.
		gap:   bool,
	}
	const fn finish(nodes: &[Node], dropped: &mut [bool], run: &mut Option<Run>) {
		if let Some(run) = run.take()
			&& run.links >= BAR_MIN_LINKS
			&& run.bar
		{
			let mut index = run.start;
			while index < run.end {
				dropped[index] = true;
				index = end(nodes, index);
			}
		}
	}

	let mut run: Option<Run> = None;
	let mut lead = None;
	let mut index = range.start;
	while index < range.end {
		let next = end(nodes, index);
		match &nodes[index] {
			_ if dropped[index] => {
				finish(nodes, dropped, &mut run);
				lead = None;
			},
			Node::Tag(tag)
				if tag.name() == "a"
					&& tag.has_attr("href")
					&& text_len(nodes, dropped, tag.children.clone()) <= LABEL_MAX_CHARS =>
			{
				if let Some(current) = run.as_mut().filter(|run| run.gap) {
					current.links += 1;
					current.end = next;
					current.gap = false;
				} else {
					finish(nodes, dropped, &mut run);
					run = Some(Run {
						start: lead.unwrap_or(index),
						end:   next,
						links: 1,
						bar:   false,
						gap:   false,
					});
				}
				lead = None;
			},
			Node::Text(text)
				if text.chars().all(|ch| {
					ch.is_whitespace() || BAR_SEPARATORS.contains(&ch) || BAR_BRACKETS.contains(&ch)
				}) =>
			{
				let separator = text.contains(BAR_SEPARATORS);
				let joins = separator || text.contains(BAR_BRACKETS);
				match &mut run {
					Some(run) => {
						run.gap |= joins;
						run.bar |= separator;
					},
					None => lead = joins.then_some(index),
				}
			},
			_ => {
				finish(nodes, dropped, &mut run);
				lead = None;
			},
		}
		index = next;
	}
	finish(nodes, dropped, &mut run);
}

// ── Regions and chrome ───────────────────────────────────────────────────

/// Words of a class or id token, split at punctuation and camelCase humps
/// (`signedOutBanner` → `signed`, `Out`, `Banner`).
fn token_words(token: &str) -> impl Iterator<Item = &str> {
	let bytes = token.as_bytes();
	let word = |byte: u8| byte.is_ascii_alphanumeric() || byte >= 0x80;
	let mut at = 0;
	std::iter::from_fn(move || {
		while at < bytes.len() && !word(bytes[at]) {
			at += 1;
		}
		if at == bytes.len() {
			return None;
		}
		let start = at;
		at += 1;
		while at < bytes.len() && word(bytes[at]) {
			let (previous, current) = (bytes[at - 1], bytes[at]);
			if (previous.is_ascii_lowercase() && current.is_ascii_uppercase())
				|| (previous.is_ascii_uppercase()
					&& current.is_ascii_uppercase()
					&& bytes.get(at + 1).is_some_and(u8::is_ascii_lowercase))
			{
				break;
			}
			at += 1;
		}
		Some(&token[start..at])
	})
}

fn class_and_id(tag: &Element) -> impl Iterator<Item = &str> {
	// Heading ids are slugs of their text, not layout names.
	let id = (!is_heading(tag.name())).then(|| tag.attr("id")).flatten();
	tag.attr("class")
		.into_iter()
		.chain(id)
		.flat_map(str::split_ascii_whitespace)
}

/// A content region: `<main>`, `role="main"`, a block named main
/// (`main_text`, `main-content`), an `<article>`, a block whose class is the
/// token `post` or `entry`, or an article body trafilatura recognizes
/// (`articleBody`, `entry-content`, `post-content`, ...).
fn is_region(tag: &Element) -> bool {
	match tag.name() {
		"main" | "article" => true,
		"div" | "section" => {
			has_role(tag, &["main"])
				|| class_and_id(tag)
					.any(|token| token_words(token).any(|word| word.eq_ignore_ascii_case("main")))
				|| tag.attr("class").is_some_and(|class| {
					class
						.split_ascii_whitespace()
						.any(|token| token == "post" || token == "entry")
				})
				|| rules::matches_any(rules::MARKED_BODY, tag)
		},
		_ => has_role(tag, &["main"]),
	}
}

/// Pipeline step 5: keep only the innermost content region holding two
/// thirds of the remaining text. Narrowing never leaves the page heading
/// behind: once a region holds the heading, an inner region must hold it
/// too. Data asides beside the region stay. Returns the region.
fn narrow_to_region(tree: &Tree, dropped: &mut [bool], controlled: &[bool]) -> Option<usize> {
	let nodes = tree.nodes;
	let all = 0..nodes.len();
	let total = text_len(nodes, dropped, all.clone());
	let heading = named_heading(nodes, dropped, document_title(nodes).as_deref());
	let holds = |region: usize| heading.is_some_and(|heading| tree.range(region).contains(&heading));
	let mut region: Option<usize> = None;
	let mut index = 0;
	while index < nodes.len() {
		if dropped[index] {
			index = end(nodes, index);
			continue;
		}
		match &nodes[index] {
			Node::Tag(tag) if is_region(tag) => {
				let len = text_len(nodes, dropped, tag.children.clone());
				if len > 0
					&& len * REGION_SHARE.1 >= total * REGION_SHARE.0
					&& (region.is_none_or(|outer| !holds(outer)) || holds(index))
				{
					// A nested region with enough text replaces this one.
					region = Some(index);
					index += 1;
				} else {
					index = tag.children.end;
				}
			},
			_ => index += 1,
		}
	}
	let found = region?;
	let mut child = found;
	while let Some(parent) = tree.parent(child) {
		let Some(tag) = tree.tag(parent) else { break };
		let mut sibling = tag.children.start;
		while sibling < tag.children.end {
			if sibling != child
				&& !matches!(&nodes[sibling], Node::Tag(aside) if is_data_aside(nodes, controlled, aside))
			{
				dropped[sibling] = true;
			}
			sibling = end(nodes, sibling);
		}
		child = parent;
	}
	drop_siblings(nodes, dropped, all, child);
	Some(found)
}

/// Pipeline step 6: drop blocks after the last paragraph of `region` (or of
/// the page) whose text is at least half link text — topic tags, share and
/// reuse links — up to the next heading, which starts a section of its own
/// ("See also", references). Kept only if more than one seventh of the text
/// survives.
fn drop_trailing_links(tree: &Tree, dropped: &mut [bool], region: Option<usize>) {
	let nodes = tree.nodes;
	let range = region.map_or(0..nodes.len(), |region| tree.range(region));
	let Some(last) = walk(nodes, dropped, range.clone())
		.filter_map(|(index, node)| match node {
			Node::Tag(tag)
				if tag.name() == "p" && text_len(nodes, dropped, tag.children.clone()) > 0 =>
			{
				Some(index)
			},
			_ => None,
		})
		.last()
	else {
		return;
	};
	// Blocks wholly after the paragraph: later siblings of it and of each
	// ancestor inside the range, in document order.
	let mut trailing = Vec::new();
	let mut child = last;
	while child != range.start {
		let Some(parent) = tree.parent(child) else {
			break;
		};
		let Some(tag) = tree.tag(parent) else { break };
		let mut sibling = end(nodes, child);
		while sibling < tag.children.end {
			if !dropped[sibling] && matches!(nodes[sibling], Node::Tag(_)) {
				trailing.push(sibling);
			}
			sibling = end(nodes, sibling);
		}
		child = parent;
	}
	let mut removed = Vec::new();
	for block in trailing {
		let range = tree.range(block);
		if walk(nodes, dropped, range.clone())
			.any(|(_, node)| matches!(node, Node::Tag(tag) if is_heading(tag.name())))
		{
			break;
		}
		let count = LinkCount::of(nodes, dropped, range);
		if count.text > 0 && 2 * count.link >= count.text {
			removed.push(block);
		}
	}
	let total = raw_len(nodes, dropped, 0..nodes.len());
	let lost = removed
		.iter()
		.map(|&block| raw_len(nodes, dropped, tree.range(block)))
		.sum::<usize>();
	if total - lost > total / 7 {
		for block in removed {
			dropped[block] = true;
		}
	}
}

/// Items a link menu has at least.
const MENU_MIN_ITEMS: usize = 3;
/// Longest link label in a link menu.
const MENU_LABEL_MAX_CHARS: usize = 20;

/// A list of at least three items that are each one short link and nothing
/// else (`Home`, `Shop`, `Contact`), not introduced by a heading of its own.
fn is_link_menu(tree: &Tree, dropped: &[bool], list: &Element) -> bool {
	let nodes = tree.nodes;
	if !matches!(list.name(), "ul" | "ol") {
		return false;
	}
	let mut items = 0;
	let mut index = list.children.start;
	while index < list.children.end {
		let next = end(nodes, index);
		match &nodes[index] {
			_ if dropped[index] => {},
			Node::Text(text) if text.trim().is_empty() => {},
			Node::Tag(item) if item.name() == "li" && is_link_item(nodes, dropped, item) => items += 1,
			_ => return false,
		}
		index = next;
	}
	if items < MENU_MIN_ITEMS {
		return false;
	}
	// The element before the list, if any, must not be a heading.
	let Some(parent) = tree
		.parent(list.index())
		.and_then(|parent| tree.tag(parent))
	else {
		return true;
	};
	let mut previous = None;
	let mut sibling = parent.children.start;
	while sibling < list.index() {
		if !dropped[sibling] && matches!(nodes[sibling], Node::Tag(_)) {
			previous = Some(sibling);
		}
		sibling = end(nodes, sibling);
	}
	!previous
		.and_then(|previous| tree.tag(previous))
		.is_some_and(|previous| is_heading(previous.name()))
}

/// A list item holding exactly one link with a short label and nothing else.
fn is_link_item(nodes: &[Node], dropped: &[bool], item: &Element) -> bool {
	let mut link = None;
	let mut index = item.children.start;
	while index < item.children.end {
		match &nodes[index] {
			_ if dropped[index] => {},
			Node::Text(text) if text.trim().is_empty() => {},
			Node::Tag(tag) if tag.name() == "a" && link.is_none() => link = Some(tag),
			_ => return false,
		}
		index = end(nodes, index);
	}
	link.is_some_and(|link| {
		(1..=MENU_LABEL_MAX_CHARS).contains(&text_len(nodes, dropped, link.children.clone()))
	})
}

/// Class and id words naming page chrome.
const CHROME_WORDS: &[&str] = &[
	"ad",
	"ads",
	"advert",
	"advertisement",
	"banner",
	"breadcrumb",
	"breadcrumbs",
	"catlinks",
	"consent",
	"cookie",
	"cookies",
	"dropdown",
	"editsection",
	"feedback",
	"footer",
	"gdpr",
	"login",
	"modal",
	"navbar",
	"navigation",
	"newsletter",
	"noprint",
	"overlay",
	"pager",
	"paginator",
	"pagination",
	"popup",
	"promo",
	"rating",
	"ratings",
	"register",
	"share",
	"sharing",
	"signin",
	"signup",
	"skip",
	"skiplink",
	"skiplinks",
	"sponsor",
	"sponsored",
	"subscribe",
	"subscription",
	"toolbar",
	"tools",
	"tooltip",
];

/// A class or id naming chrome: a chrome word, a print-hidden utility
/// (`noprint`, `d-print-none`), visually hidden text (`sr-only`,
/// `visually-hidden`) or a hidden state (`is-hidden`). Responsive utility
/// variants (`md:hidden`) only toggle layout.
fn is_chrome(tag: &Element) -> bool {
	class_and_id(tag).any(|token| {
		if token.contains(':') {
			return false;
		}
		let mut print = false;
		let mut hides = false;
		let mut before = "";
		let mut previous = "";
		for word in token_words(token) {
			if CHROME_WORDS
				.iter()
				.any(|chrome| word.eq_ignore_ascii_case(chrome))
			{
				return true;
			}
			print |= word.eq_ignore_ascii_case("print");
			hides |= ["none", "hidden", "hide", "no"]
				.iter()
				.any(|hide| word.eq_ignore_ascii_case(hide));
			let pair = |first: &str, second: &str| {
				previous.eq_ignore_ascii_case(first) && word.eq_ignore_ascii_case(second)
			};
			if pair("visually", "hidden")
				|| pair("screen", "reader")
				|| (pair("sr", "only") && !before.eq_ignore_ascii_case("not"))
			{
				return true;
			}
			before = previous;
			previous = word;
		}
		let lower = |prefix: &str| {
			token
				.get(..prefix.len())
				.is_some_and(|head| head.eq_ignore_ascii_case(prefix))
		};
		(print && hides)
			|| (token.len() > "-hidden".len()
				&& token
					.get(token.len() - "-hidden".len()..)
					.is_some_and(|tail| tail.eq_ignore_ascii_case("-hidden"))
				&& !lower("overflow"))
	})
}

/// Whether a chrome-named block wraps the content itself (`flex-wrap-footer`
/// around `<main>`): it holds the main region, an article or the page
/// heading.
fn frames_content(nodes: &[Node], tag: &Element) -> bool {
	nodes[tag.children.clone()].iter().any(|node| {
		matches!(node, Node::Tag(inner)
			if matches!(inner.name(), "main" | "article" | "h1") || has_role(inner, &["main"]))
	})
}

// ── Title ────────────────────────────────────────────────────────────────

/// Whitespace-collapsed text of the document `<title>`.
fn document_title(nodes: &[Node]) -> Option<String> {
	nodes.iter().find_map(|node| match node {
		Node::Tag(tag) if tag.name() == "title" => {
			plain_label(nodes, tag.children.clone(), usize::MAX).filter(|title| !title.is_empty())
		},
		_ => None,
	})
}

/// The page heading: the first of the longest visible `<h1>`s whose text the
/// document title contains. A logo heading names the site, which the title
/// also contains; the longest named heading is the page's own.
fn named_heading(nodes: &[Node], dropped: &[bool], title: Option<&str>) -> Option<usize> {
	let title = title?;
	let limit = title.chars().count();
	let mut named: Option<(usize, usize)> = None;
	for (index, node) in walk(nodes, dropped, 0..nodes.len()) {
		if let Node::Tag(tag) = node
			&& tag.name() == "h1"
			&& let Some(text) = label(nodes, dropped, tag.children.clone(), limit)
			&& !text.is_empty()
			&& title.contains(text.as_str())
			&& named.is_none_or(|(_, len)| text.len() > len)
		{
			named = Some((index, text.len()));
		}
	}
	named.map(|(index, _)| index)
}

/// Pipeline step 7: restore the page heading when the selection lost every
/// `<h1>`: the page heading ([`named_heading`]), else the first visible `<h1>`
/// that is not just a logo link, else the innermost element outside links
/// whose text is the title (or one of its ` | `-separated parts). A short
/// block around the heading that holds only text (title and author) comes
/// with it. `source` is the selection before pruning. Returns the restored
/// node.
fn restore_title(tree: &Tree, dropped: &mut [bool], source: &[bool]) -> Option<usize> {
	let nodes = tree.nodes;
	let all = 0..nodes.len();
	if walk(nodes, dropped, all.clone()).any(|(_, node)| {
		matches!(node, Node::Tag(tag)
			if tag.name() == "h1" && text_len(nodes, dropped, tag.children.clone()) > 0)
	}) {
		return None;
	}
	let title = document_title(nodes);
	let first = || {
		walk(nodes, source, all.clone()).find_map(|(index, node)| match node {
			Node::Tag(tag) if tag.name() == "h1" => {
				let count = LinkCount::of(nodes, source, tag.children.clone());
				(count.text > count.link).then_some(index)
			},
			_ => None,
		})
	};
	let target = match named_heading(nodes, source, title.as_deref()).or_else(first) {
		Some(heading) => title_block(tree, source, heading),
		None => titled_element(nodes, source, title.as_deref()?)?,
	};
	tree.restore(dropped, source, target);
	Some(target)
}

/// Paragraphs at least this long between a restored heading and the body are
/// its standfirst.
const LEAD_MIN_CHARS: usize = 50;
/// At most this many standfirst paragraphs come back.
const LEAD_MAX_PARAGRAPHS: usize = 3;

/// After restoring the page heading, restore the standfirst: prose paragraphs
/// between the heading and the selected body inside the same `<article>` or
/// `<main>`, outside figures, landmarks and chrome, mostly not links.
fn restore_lead(tree: &Tree, dropped: &mut [bool], source: &[bool], heading: usize) {
	let nodes = tree.nodes;
	let after = end(nodes, heading);
	let Some(first) = walk(nodes, dropped, after..nodes.len()).find_map(|(index, node)| {
		matches!(node, Node::Text(text) if !text.trim().is_empty()).then_some(index)
	}) else {
		return;
	};
	let Some(frame) =
		std::iter::successors(tree.parent(heading), |&index| tree.parent(index)).find(|&index| {
			tree
				.tag(index)
				.is_some_and(|tag| matches!(tag.name(), "article" | "main") || has_role(tag, &["main"]))
		})
	else {
		return;
	};
	if first >= end(nodes, frame) {
		return;
	}
	let shown = |index: usize| {
		std::iter::successors(Some(index), |&index| tree.parent(index)).all(|index| {
			tree.tag(index).is_none_or(|tag| {
				!matches!(tag.name(), "figure" | "figcaption")
					&& !is_landmark(tree, tag)
					&& !is_chrome(tag)
			})
		})
	};
	let lead: Vec<usize> = walk(nodes, source, after..first)
		.filter_map(|(index, node)| match node {
			Node::Tag(tag) if tag.name() == "p" && shown(index) => {
				let count = LinkCount::of(nodes, source, tag.children.clone());
				(count.text >= LEAD_MIN_CHARS && 2 * count.link < count.text).then_some(index)
			},
			_ => None,
		})
		.take(LEAD_MAX_PARAGRAPHS)
		.collect();
	for index in lead {
		tree.restore(dropped, source, index);
	}
}

/// The heading's parent when it is a short text-only block holding the
/// heading and, say, an author line (`<h1>` beside `<h2>`), else the heading.
fn title_block(tree: &Tree, source: &[bool], heading: usize) -> usize {
	let nodes = tree.nodes;
	let Some(parent) = tree.parent(heading) else {
		return heading;
	};
	let Some(block) = tree.tag(parent) else {
		return heading;
	};
	let heading_len = text_len(nodes, source, tree.range(heading));
	// Empty icon links and decorative images do not make the block chrome.
	let simple = matches!(block.name(), "div" | "hgroup" | "header" | "section")
		&& text_len(nodes, source, block.children.clone()) <= heading_len + TITLE_BLOCK_EXTRA_CHARS
		&& !walk(nodes, source, block.children.clone()).any(|(_, node)| {
			matches!(node, Node::Tag(tag) if match tag.name() {
				"a" | "button" => text_len(nodes, source, tag.children.clone()) > 0,
				"img" => tag.attr("alt").is_some_and(|alt| !alt.trim().is_empty()),
				name => matches!(name, "input" | "nav" | "ul" | "ol"),
			})
		});
	if simple { parent } else { heading }
}

/// The innermost visible element outside links whose whole text is the
/// document title or, failing that, one of its separated parts, longest first
/// (the site name is usually the shortest). A link with the title text is the
/// site's logo or a self-link, not the heading.
fn titled_element(nodes: &[Node], source: &[bool], title: &str) -> Option<usize> {
	let mut parts: Vec<&str> = [" | ", " - ", " – ", " — ", " · ", " :: ", " » "]
		.iter()
		.flat_map(|separator| title.split(separator))
		.map(str::trim)
		.filter(|part| *part != title && part.chars().count() >= 10)
		.collect();
	parts.sort_by_key(|part| std::cmp::Reverse(part.len()));
	parts.dedup();
	std::iter::once(title)
		.chain(parts)
		.find_map(|text| element_with_text(nodes, source, text))
}

/// The innermost of the first visible elements whose whole text is `text`.
fn element_with_text(nodes: &[Node], source: &[bool], text: &str) -> Option<usize> {
	let limit = text.chars().count();
	let mut found: Option<(usize, usize)> = None;
	let mut index = 0;
	while index < nodes.len() {
		if found.is_some_and(|(_, bound)| index >= bound) {
			break;
		}
		if source[index] {
			index = end(nodes, index);
			continue;
		}
		let Node::Tag(tag) = &nodes[index] else {
			index += 1;
			continue;
		};
		if matches!(tag.name(), "head" | "title" | "script" | "style" | "svg" | "a") {
			index = tag.children.end;
			continue;
		}
		if !matches!(tag.name(), "html" | "body")
			&& label(nodes, source, tag.children.clone(), limit).is_some_and(|label| label == text)
		{
			let bound = found.map_or(tag.children.end, |(_, bound)| bound);
			found = Some((index, bound));
		}
		index += 1;
	}
	found.map(|(index, _)| index)
}
