//! The reader pipeline ([`reader`]) and the Lynx-complete visible selection
//! ([`full`]) it starts from.

use std::{
	collections::{HashMap, HashSet},
	ops::Range,
};

use super::{
	Selection, Tree, apply_with_backup, backup_allows, drop_siblings, end, outermost,
	prune_with_backup, raw_len, rules, text_len, walk,
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

/// Select visible page content. With `reveal`, the reader opens what a reader
/// can open: a closed `<details>` whose body is prose, and collapsed
/// accordion and tab panels (`hidden` panels labelled by their toggle). A
/// closed `<details>` whose body is a menu of links goes entirely; its
/// summary alone is a dangling label. Lynx shows each closed `<details>` as
/// its summary.
fn visible(nodes: &[Node], hidden: Hidden, reveal: bool) -> Selection {
	let mut dropped = vec![false; nodes.len()];
	mark_hidden(nodes, hidden, reveal, &mut dropped, 0..nodes.len());
	Selection { root: 0..nodes.len(), dropped, recoverable_only: false }
}

/// Flag what [`visible`] hides within `range`.
fn mark_hidden(
	nodes: &[Node],
	hidden: Hidden,
	reveal: bool,
	dropped: &mut [bool],
	range: Range<usize>,
) {
	let mut index = range.start;
	while index < range.end {
		if dropped[index] {
			index = end(nodes, index);
			continue;
		}
		if let Node::Tag(tag) = &nodes[index] {
			if (is_hidden(tag, hidden) && !(reveal && is_collapsed_panel(tag)))
				|| matches!(tag.name(), "script" | "style" | "title" | "svg")
			{
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
				&& reveal
				&& !holds_prose(nodes, tag)
			{
				dropped[index] = true;
				index = tag.children.end;
				continue;
			}
			if matches!(hidden, Hidden::Drop)
				&& tag.name() == "details"
				&& !tag.has_attr("open")
				&& !reveal
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
}

/// Content a page control expands: a hidden block whose id a control names
/// (`aria-controls`) or that follows its toggle (a button, an element with
/// `aria-expanded`), and that is shaped like content — a table, a definition
/// list, paragraphs or at least 80 characters of text, mostly not links —
/// rather than chrome: no menu, dialog or landmark role, no navigation,
/// header, footer, aside, dialog or form inside, no landmark around it, and
/// not `aria-hidden` (decorative duplicates and line-number gutters).
fn expand_collapsed(tree: &Tree, dropped: &mut [bool]) {
	let nodes = tree.nodes;
	let controlled: HashSet<&str> = nodes
		.iter()
		.filter_map(|node| match node {
			Node::Tag(tag) => tag.attr("aria-controls"),
			Node::Text(_) => None,
		})
		.flat_map(str::split_ascii_whitespace)
		.collect();
	// The toggle is the element just before in the markup, shown or not.
	let markup = vec![false; nodes.len()];
	let mut index = 0;
	while index < nodes.len() {
		let Node::Tag(tag) = &nodes[index] else {
			index += 1;
			continue;
		};
		if !dropped[index] {
			index += 1;
			continue;
		}
		let toggled = tag.attr("id").is_some_and(|id| controlled.contains(id))
			|| previous_element(tree, &markup, tag)
				.is_some_and(|toggle| toggle.name() == "button" || toggle.has_attr("aria-expanded"));
		if toggled && is_hidden(tag, Hidden::Drop) && is_collapsed_content(tree, tag) {
			// Reveal it; what it holds is judged as the rest of the page was.
			dropped[index] = false;
			mark_hidden(nodes, Hidden::Drop, true, dropped, tag.children.clone());
		}
		index = tag.children.end;
	}
}

/// See [`expand_collapsed`].
fn is_collapsed_content(tree: &Tree, tag: &Element) -> bool {
	let nodes = tree.nodes;
	let chrome_role = |tag: &Element| {
		has_role(tag, &[
			"dialog",
			"alertdialog",
			"menu",
			"menubar",
			"navigation",
			"tooltip",
			"banner",
			"contentinfo",
			"complementary",
			"search",
			"listbox",
		])
	};
	let chrome = |tag: &Element| {
		matches!(
			tag.name(),
			"nav"
				| "header"
				| "footer"
				| "aside"
				| "dialog"
				| "form"
				| "menu"
				| "template"
				| "noscript"
		) || chrome_role(tag)
	};
	let inner = &nodes[tag.children.clone()];
	if chrome(tag)
		|| tag
			.attr("aria-hidden")
			.is_some_and(|value| value.trim().eq_ignore_ascii_case("true"))
		|| std::iter::successors(tree.parent(tag.index()), |&parent| tree.parent(parent))
			.filter_map(|parent| tree.tag(parent))
			.any(chrome)
		|| inner
			.iter()
			.any(|node| matches!(node, Node::Tag(inner) if chrome(inner)))
	{
		return false;
	}
	let count = LinkCount::of(nodes, &[], tag.children.clone());
	count.text > 0
		&& 2 * count.link < count.text
		&& (count.text >= COLLAPSED_MIN_CHARS
			|| inner.iter().any(
				|node| matches!(node, Node::Tag(block) if matches!(block.name(), "table" | "dl" | "p")),
			))
}

/// Text that makes a collapsed block content on its own.
const COLLAPSED_MIN_CHARS: usize = 80;

/// A panel hidden only by the `hidden` attribute until its toggle opens it:
/// an accordion region labelled by its button, a tab panel, or
/// `hidden="until-found"` (which find-in-page reveals).
fn is_collapsed_panel(tag: &Element) -> bool {
	tag.attr("hidden").is_some()
		&& !tag
			.attr("aria-hidden")
			.is_some_and(|value| value.trim().eq_ignore_ascii_case("true"))
		&& !tag.attr("style").is_some_and(|style| {
			let style = style.to_ascii_lowercase();
			style.contains("display:none") || style.contains("display: none")
		})
		&& (tag
			.attr("hidden")
			.is_some_and(|value| value.eq_ignore_ascii_case("until-found"))
			|| has_role(tag, &["tabpanel"])
			|| (has_role(tag, &["region"]) && tag.has_attr("aria-labelledby")))
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
/// 1. Start from everything visible, as Lynx shows it, and open what a reader
///    opens: prose `<details>`, collapsed accordion and tab panels. A closed
///    `<details>` holding only links goes. With [`Hidden::Reachable`], hidden
///    content a page control toggles (a table, a definition list, prose) opens
///    too; hidden menus, landmarks and dialogs never do.
/// 2. Drop controls: form fields (except labelled selects stating a value),
///    buttons, dialogs, popovers, menus, comment forms, skip links, pagers,
///    edit/report links, heading permalinks, sign-in, feedback and comment
///    prompts, taxonomy lines ("Filed under: …"), bars of separated links
///    (except inside an `<article>`), image maps, Tailwind-`hidden` elements
///    and elements parked off-screen by an inline transform. Tab lists of plain
///    text labels stay.
/// 3. Drop navigation, banner, contentinfo and complementary landmarks, except
///    asides holding labelled data or sitting in running prose (callouts). Kept
///    only if more than one seventh of the text survives, or if a non-empty
///    `main` survives and what goes is mostly links.
/// 4. Drop blocks whose class or id names chrome (footer, cookie, feedback,
///    share, ad, nav, menu, print-hidden, visually hidden, ...) or a
///    link-dominated sidebar, never a heading, an admonition, a link-free
///    inline widget in a sentence or a block framing the main region, an
///    article or the page heading. Same one-seventh guard. Bylines in a post
///    footer come back without the footer's chrome.
/// 5. Drop comment sections trafilatura recognizes (comment lists, Disqus),
///    except threads of three or more comments. Same guard.
/// 6. Drop teaser sections ("Related posts", "Keep reading", or a heading
///    beside a "View All" link) introduced by a heading without an anchor id.
///    Same guard.
/// 7. Narrow to the innermost content region (`main`, an `<article>`, a
///    trafilatura-marked article body) holding two thirds of the remaining
///    text, never past the page heading (the one the title names, else the
///    first non-logo `<h1>`); data asides beside it stay. Footnotes the region
///    links to come back.
/// 8. Drop link-dominated blocks trailing the last paragraph before any further
///    heading (topic tags, share and reuse links). Same guard.
/// 9. Drop link menus: lists of three or more items that are each one short
///    link and nothing else, unless a heading or a sentence ending in ':'
///    introduces the list. Same guard.
/// 10. Drop in-page tables of contents: lists whose links all point at the
///     page's headings, and link-free rails of short labels that appear twice
///     (a scroll-spy index). Same guard. Then drop labels left behind by the
///     controls they introduced ("Reply via email to" over a dropped button).
/// 11. Restore the page heading when none survived, with its standfirst (or, in
///     a hero outside any article, the paragraph and date beside it).
/// 12. When almost no text survives, fall back to a body-level `<noscript>`
///     holding a heading and prose (the static copy of an app shell).
pub fn reader(nodes: &[Node], hidden: Hidden) -> Selection {
	// What a reader can reveal (prose disclosures, accordion and tab panels)
	// the pipeline reveals itself. `Reachable` also expands collapsed content
	// that a page control toggles, but never hidden menus, footers and dialogs.
	let expand = hidden == Hidden::Reachable;
	let hidden = if expand { Hidden::Drop } else { hidden };
	let tree = Tree::new(nodes);
	let mut selection = visible(nodes, hidden, true);
	if expand {
		expand_collapsed(&tree, &mut selection.dropped);
	}
	drop_controls(&tree, &mut selection.dropped);
	let controlled = selection.dropped.clone();
	let root = selection.root.clone();
	drop_landmarks(&tree, &mut selection.dropped, &controlled);
	prune_with_backup(nodes, &mut selection.dropped, root.clone(), |tag| {
		(is_chrome(&tree, tag) || is_link_sidebar(nodes, &controlled, tag))
			&& !frames_content(nodes, tag)
	});
	prune_with_backup(nodes, &mut selection.dropped, root.clone(), |tag| {
		is_comment_section(&tree, tag)
	});
	drop_teasers(&tree, &mut selection.dropped, &controlled);
	restore_bylines(&tree, &mut selection.dropped, &controlled);
	let region = narrow_to_region(&tree, &mut selection.dropped, &controlled);
	drop_trailing_links(&tree, &mut selection.dropped, region);
	restore_footnotes(&tree, &mut selection.dropped, &controlled, region);
	let narrowed = selection.dropped.clone();
	prune_with_backup(nodes, &mut selection.dropped, root, |tag| {
		is_link_menu(&tree, &narrowed, tag)
	});
	drop_contents_lists(&tree, &mut selection.dropped);
	drop_repeated_rails(&tree, &mut selection.dropped);
	drop_orphan_labels(&tree, &mut selection.dropped);
	if let Some(heading) = restore_title(&tree, &mut selection.dropped, &controlled)
		&& !restore_lead(&tree, &mut selection.dropped, &controlled, heading)
	{
		restore_hero(&tree, &mut selection.dropped, &controlled, heading);
	}
	restore_noscript(&tree, &mut selection.dropped, &controlled);
	selection
}

/// Words marking a post's author or publication time.
const BYLINE_WORDS: &[&str] = &["author", "byline", "vcard", "published", "timestamp", "dateline"];
/// A byline line is at most this long.
const BYLINE_MAX_CHARS: usize = 200;

/// Restore bylines that chrome pruning took with their footer ("Posted by Ann
/// at 09:57" inside a post footer that also holds share buttons): for each
/// element marked as author or publication time inside a post (an `<article>`
/// or a block classed `post`, `entry` or `hentry`), bring back its line (its
/// parent) without the line's own chrome, if at most 200 characters remain.
fn restore_bylines(tree: &Tree, dropped: &mut [bool], controlled: &[bool]) {
	let nodes = tree.nodes;
	let marked: Vec<usize> = walk(nodes, controlled, 0..nodes.len())
		.filter_map(|(index, node)| match node {
			Node::Tag(tag)
				if is_byline(tag)
					&& std::iter::successors(tree.parent(index), |&parent| tree.parent(parent))
						.filter_map(|parent| tree.tag(parent))
						.any(|post| {
							post.name() == "article"
								|| post.attr("class").is_some_and(|class| {
									class
										.split_ascii_whitespace()
										.any(|token| matches!(token, "post" | "entry" | "hentry"))
								})
						}) =>
			{
				Some(index)
			},
			_ => None,
		})
		.collect();
	for index in marked {
		let shown = std::iter::successors(Some(index), |&index| tree.parent(index))
			.all(|index| !dropped[index]);
		let Some(line) = tree.parent(index) else {
			continue;
		};
		if shown {
			continue;
		}
		let mut trial = dropped.to_vec();
		tree.restore(&mut trial, controlled, line);
		let range = tree.range(line);
		let mut inner = range.start + 1;
		while inner < range.end {
			if let Node::Tag(tag) = &nodes[inner]
				&& is_chrome(tree, tag)
			{
				trial[inner] = true;
				inner = tag.children.end;
			} else {
				inner += 1;
			}
		}
		let text = text_len(nodes, &trial, range.start + 1..range.end);
		if (1..=BYLINE_MAX_CHARS).contains(&text) {
			dropped.copy_from_slice(&trial);
		}
	}
}

/// An element marked as a post's author or publication time.
fn is_byline(tag: &Element) -> bool {
	tag.attr("rel")
		.is_some_and(|rel| rel.eq_ignore_ascii_case("author"))
		|| tag
			.attr("itemprop")
			.is_some_and(|prop| matches!(prop, "author" | "datePublished"))
		|| class_and_id(tag).any(|token| {
			token_words(token).any(|word| {
				BYLINE_WORDS
					.iter()
					.any(|byline| word.eq_ignore_ascii_case(byline))
			})
		})
}

/// Pipeline step 7 (after narrowing): bring back footnotes that in-content
/// links point at (`<a href="#footnote-1">`) when they sit outside the kept
/// region; a target counts as a footnote when its id or class says so
/// (`footnote`, `endnote`, an id starting `fn`).
fn restore_footnotes(
	tree: &Tree,
	dropped: &mut [bool],
	controlled: &[bool],
	region: Option<usize>,
) {
	let nodes = tree.nodes;
	let Some(region) = region else { return };
	let targets: HashSet<&str> = walk(nodes, dropped, tree.range(region))
		.filter_map(|(_, node)| match node {
			Node::Tag(link) if link.name() == "a" => link.attr("href")?.trim().strip_prefix('#'),
			_ => None,
		})
		.collect();
	if targets.is_empty() {
		return;
	}
	let notes: Vec<usize> = nodes
		.iter()
		.enumerate()
		.filter_map(|(index, node)| {
			let Node::Tag(tag) = node else { return None };
			let id = tag.attr("id")?;
			let named = |text: &str| {
				let text = text.to_ascii_lowercase();
				text.contains("footnote") || text.contains("endnote")
			};
			(targets.contains(id)
				&& (named(id)
					|| id.to_ascii_lowercase().starts_with("fn")
					|| tag.attr("class").is_some_and(named)))
			.then_some(index)
		})
		.collect();
	for index in notes {
		let shown_now = std::iter::successors(Some(index), |&index| tree.parent(index))
			.all(|index| !dropped[index]);
		let shown_before = std::iter::successors(Some(index), |&index| tree.parent(index))
			.all(|index| !controlled[index]);
		if !shown_now && shown_before {
			tree.restore(dropped, controlled, index);
		}
	}
}

/// A label is at most this long.
const ORPHAN_LABEL_MAX_CHARS: usize = 40;

/// Drop labels left behind by the controls they introduced: an h2–h6, or a
/// short text ending in ':', whose siblings were all form controls (or, for a
/// ':' label, links) that are gone ("Reply via email to" above a dropped
/// button, "Posted in:" before dropped tag links).
fn drop_orphan_labels(tree: &Tree, dropped: &mut [bool]) {
	let nodes = tree.nodes;
	let orphans: Vec<usize> = walk(nodes, dropped, 0..nodes.len())
		.filter_map(|(index, node)| {
			let Node::Tag(tag) = node else { return None };
			let text = label(nodes, dropped, tag.children.clone(), ORPHAN_LABEL_MAX_CHARS)?;
			let heading = is_heading(tag.name()) && tag.name() != "h1";
			if text.is_empty() || !(heading || text.ends_with(':')) {
				return None;
			}
			let parent = tree.parent(index).and_then(|parent| tree.tag(parent))?;
			let kinds: &[&str] = if heading {
				&["button", "form", "input", "select", "textarea"]
			} else {
				&["button", "form", "input", "select", "textarea", "a"]
			};
			let mut others = 0;
			let mut child = parent.children.start;
			while child < parent.children.end {
				match &nodes[child] {
					Node::Text(text) if !text.trim().is_empty() => return None,
					Node::Tag(other) if child != index => {
						let control = kinds.contains(&other.name())
							|| nodes[other.children.clone()].iter().any(
								|node| matches!(node, Node::Tag(inner) if kinds.contains(&inner.name())),
							);
						if !control || text_len(nodes, dropped, tree.range(child)) > 0 {
							return None;
						}
						others += 1;
					},
					_ => {},
				}
				child = end(nodes, child);
			}
			(others > 0).then_some(index)
		})
		.collect();
	for index in orphans {
		dropped[index] = true;
	}
}

/// Pipeline step 3: drop landmarks with the one-seventh guard, which a page
/// whose chrome outweighs a short `main` overrides: when a non-empty `main`
/// survives and the landmarks are mostly links, they go anyway.
fn drop_landmarks(tree: &Tree, dropped: &mut [bool], controlled: &[bool]) {
	let nodes = tree.nodes;
	let all = 0..nodes.len();
	let removed = outermost(nodes, dropped, all.clone(), |tag| {
		is_landmark(tree, tag) && !is_data_aside(tree, controlled, tag)
	});
	if removed.is_empty() {
		return;
	}
	let allowed = backup_allows(nodes, dropped, all.clone(), &removed) || {
		let mut trial = dropped.to_vec();
		for &index in &removed {
			trial[index] = true;
		}
		let main_survives = walk(nodes, &trial, all).any(|(_, node)| {
			matches!(node, Node::Tag(tag)
				if (tag.name() == "main" || has_role(tag, &["main"]))
					&& text_len(nodes, &trial, tag.children.clone()) > 0)
		});
		let (text, link) = removed.iter().fold((0, 0), |(text, link), &index| {
			let count = LinkCount::of(nodes, dropped, tree.range(index));
			(text + count.text, link + count.link)
		});
		main_survives && text > 0 && 2 * link >= text
	};
	if allowed {
		for index in removed {
			dropped[index] = true;
		}
	}
}

/// A block named `sidebar` whose text is at least half links (a category
/// list); a sidebar of prose or data (a repository's about box) stays.
fn is_link_sidebar(nodes: &[Node], dropped: &[bool], tag: &Element) -> bool {
	!is_heading(tag.name())
		&& class_and_id(tag).any(|token| {
			!token.contains(':') && token_words(token).any(|word| word.eq_ignore_ascii_case("sidebar"))
		})
		&& {
			let count = LinkCount::of(nodes, dropped, tag.children.clone());
			count.text > 0 && 2 * count.link >= count.text
		}
}

/// A rail holds at least this many short labels...
const RAIL_MIN_LABELS: usize = 4;
/// ...each at most this long...
const RAIL_LABEL_MAX_CHARS: usize = 40;
/// ...and at least this much text in all (a menu rather than a word or two).
const RAIL_MIN_CHARS: usize = 60;
/// Longer blocks are content, whatever repeats.
const RAIL_MAX_CHARS: usize = 2000;

/// Pipeline step 10 (second part): drop link-free blocks of short labels whose
/// whole text appears in two or more separate blocks: the copies of a
/// scroll-spy index ("Menu: Dumplings, Buns, …" for desktop and for mobile).
/// Tables and code repeat legitimately and never count.
fn drop_repeated_rails(tree: &Tree, dropped: &mut [bool]) {
	let nodes = tree.nodes;
	let mut rails: HashMap<String, Vec<usize>> = HashMap::new();
	for (index, node) in walk(nodes, dropped, 0..nodes.len()) {
		let Node::Tag(tag) = node else { continue };
		if matches!(tag.name(), "html" | "body" | "pre" | "code" | "table" | "thead" | "tbody" | "tr" | "td" | "th")
			|| has_role(tag, &["table", "grid", "treegrid"])
			|| nodes[tag.children.clone()].iter().any(
				|node| matches!(node, Node::Tag(inner) if matches!(inner.name(), "a" | "pre" | "code")),
			)
			|| std::iter::successors(tree.parent(index), |&parent| tree.parent(parent))
				.filter_map(|parent| tree.tag(parent))
				.any(|parent| {
					matches!(parent.name(), "pre" | "code" | "table")
						|| has_role(parent, &["table", "grid", "treegrid"])
				})
		{
			continue;
		}
		let Some(text) = label(nodes, dropped, tag.children.clone(), RAIL_MAX_CHARS) else {
			continue;
		};
		if text.chars().count() < RAIL_MIN_CHARS {
			continue;
		}
		let mut labels = 0;
		let short = walk(nodes, dropped, tag.children.clone()).all(|(_, node)| match node {
			Node::Tag(block) if direct_text(nodes, block) => {
				labels += 1;
				label(nodes, dropped, block.children.clone(), RAIL_LABEL_MAX_CHARS).is_some()
			},
			_ => true,
		});
		if short && labels >= RAIL_MIN_LABELS {
			rails.entry(text).or_default().push(index);
		}
	}
	let mut blocks = Vec::new();
	for copies in rails.values() {
		let outer: Vec<usize> = copies
			.iter()
			.copied()
			.filter(|&copy| {
				!copies
					.iter()
					.any(|&other| other != copy && tree.range(other).contains(&copy))
			})
			.collect();
		if outer.len() >= 2 {
			blocks.extend(outer);
		}
	}
	blocks.sort_unstable();
	apply_with_backup(nodes, dropped, 0..nodes.len(), &blocks);
}

/// Comment entries (items, definitions, articles) that make a comment section
/// a thread worth keeping.
const THREAD_MIN_ENTRIES: usize = 3;

/// A trafilatura comment section that is not part of a thread of comments
/// (a discussion the page exists for).
fn is_comment_section(tree: &Tree, tag: &Element) -> bool {
	let thread = |tag: &Element| {
		rules::matches_any(rules::COMMENTS, tag)
			&& tree.nodes[tag.children.clone()]
				.iter()
				.filter(
					|node| matches!(node, Node::Tag(entry) if matches!(entry.name(), "dd" | "li" | "article")),
				)
				.count()
				>= THREAD_MIN_ENTRIES
	};
	rules::matches_any(rules::COMMENTS, tag)
		&& !thread(tag)
		&& !std::iter::successors(tree.parent(tag.index()), |&index| tree.parent(index))
			.filter_map(|index| tree.tag(index))
			.any(thread)
}

/// Teaser headings ("Related posts") are short.
const TEASER_HEADING_MAX_CHARS: usize = 40;
/// A teaser block holds at most this much text.
const TEASER_MAX_CHARS: usize = 3000;
/// Text besides the heading that a teaser block may hold outside links (a
/// badge, a "View all" label).
const TEASER_LABEL_MAX_CHARS: usize = 40;
/// Openings of teaser-section headings.
const TEASER_HEADINGS: &[&str] = &[
	"related",
	"keep reading",
	"read next",
	"read more",
	"more from",
	"more articles",
	"more posts",
	"more stories",
	"you may also like",
	"you might also like",
	"similar",
	"up next",
	"see more",
	"more like this",
	"continue reading",
	"explore more",
	"popular",
	"latest news",
];

/// An h2–h4 without an anchor id whose text opens like a teaser section.
/// Document sections ("Related resources" in a docs outline) carry ids.
fn is_teaser_heading(nodes: &[Node], tag: &Element) -> bool {
	matches!(tag.name(), "h2" | "h3" | "h4")
		&& !tag.has_attr("id")
		&& plain_label(nodes, tag.children.clone(), TEASER_HEADING_MAX_CHARS).is_some_and(|text| {
			TEASER_HEADINGS
				.iter()
				.any(|opening| starts_with_words(&text, opening))
		})
}

/// The largest block around a teaser heading whose other text is a short
/// label or mostly links.
fn teaser_block(tree: &Tree, controlled: &[bool], heading: usize) -> Option<usize> {
	let nodes = tree.nodes;
	let heading_len = LinkCount::of(nodes, controlled, tree.range(heading)).text;
	let mut block = None;
	let mut current = tree.parent(heading);
	while let Some(parent) = current {
		let Some(tag) = tree.tag(parent) else { break };
		if matches!(tag.name(), "html" | "body" | "main" | "article") {
			break;
		}
		let count = LinkCount::of(nodes, controlled, tag.children.clone());
		let other = count.text.saturating_sub(heading_len);
		if count.text >= TEASER_MAX_CHARS
			|| (other > TEASER_LABEL_MAX_CHARS && 2 * count.link < other)
		{
			break;
		}
		block = Some(parent);
		current = tree.parent(parent);
	}
	block
}

/// Openings of a link that lists a whole collection ("View All").
const VIEW_ALL_LINKS: &[&str] =
	&["view all", "see all", "show all", "browse all", "view more", "see more"];

/// An h2–h4 without an anchor id beside a "View All" link: the head of a
/// grid of cards from elsewhere on the site.
fn is_view_all_heading(tree: &Tree, heading: &Element) -> bool {
	let nodes = tree.nodes;
	matches!(heading.name(), "h2" | "h3" | "h4")
		&& !heading.has_attr("id")
		&& tree
			.parent(heading.index())
			.and_then(|parent| tree.tag(parent))
			.is_some_and(|parent| {
				nodes[parent.children.clone()].iter().any(|node| {
					matches!(node, Node::Tag(link) if link.name() == "a"
					&& plain_label(nodes, link.children.clone(), LABEL_MAX_CHARS).is_some_and(|text| {
						VIEW_ALL_LINKS.iter().any(|opening| starts_with_words(&text, opening))
					}))
				})
			})
}

/// The largest block around a section heading that holds no other heading of
/// its level and less than [`TEASER_MAX_CHARS`] of text: the section.
fn section_block(tree: &Tree, dropped: &[bool], heading: &Element) -> Option<usize> {
	let nodes = tree.nodes;
	let mut block = None;
	let mut current = tree.parent(heading.index());
	while let Some(parent) = current {
		let Some(tag) = tree.tag(parent) else { break };
		if matches!(tag.name(), "html" | "body" | "main" | "article")
			|| text_len(nodes, dropped, tag.children.clone()) >= TEASER_MAX_CHARS
			|| walk(nodes, dropped, tag.children.clone()).any(|(index, node)| {
				index != heading.index()
					&& matches!(node, Node::Tag(other) if other.name() == heading.name())
			}) {
			break;
		}
		block = Some(parent);
		current = tree.parent(parent);
	}
	block
}

/// Pipeline step 6: drop each teaser heading with the largest block around it
/// whose other text is a short label or mostly links, measured before any
/// pruning so cards removed earlier leave no orphan heading; and each heading
/// beside a "View All" link with its section of cards.
fn drop_teasers(tree: &Tree, dropped: &mut [bool], controlled: &[bool]) {
	let nodes = tree.nodes;
	let mut blocks: Vec<usize> = Vec::new();
	for (index, node) in walk(nodes, dropped, 0..nodes.len()) {
		let Node::Tag(heading) = node else { continue };
		let block = if is_teaser_heading(nodes, heading) {
			teaser_block(tree, controlled, index)
		} else if is_view_all_heading(tree, heading) {
			section_block(tree, dropped, heading)
		} else {
			continue;
		};
		if let Some(block) = block
			&& !blocks.iter().any(|&kept| tree.range(kept).contains(&block))
		{
			blocks.retain(|&kept| !tree.range(block).contains(&kept));
			blocks.push(block);
		}
	}
	apply_with_backup(nodes, dropped, 0..nodes.len(), &blocks);
}

/// Pipeline step 10: drop in-page tables of contents, each with the wrapper
/// (`details`, `nav`, a titled `div`) that holds nothing else but a short
/// label such as "Table of Contents".
fn drop_contents_lists(tree: &Tree, dropped: &mut [bool]) {
	let nodes = tree.nodes;
	let mut anchors: HashSet<&str> = HashSet::new();
	for node in nodes {
		let Node::Tag(heading) = node else { continue };
		if !is_heading(heading.name()) {
			continue;
		}
		// A heading is reached by its own id, an id inside it, or the id of
		// the section it opens.
		anchors.extend(
			std::iter::once(heading)
				.chain(
					nodes[heading.children.clone()]
						.iter()
						.filter_map(|node| match node {
							Node::Tag(tag) => Some(tag),
							Node::Text(_) => None,
						}),
				)
				.filter_map(|tag| tag.attr("id")),
		);
		if let Some(section) = tree
			.parent(heading.index())
			.and_then(|index| tree.tag(index))
			&& matches!(section.name(), "section" | "div")
			&& let Some(id) = section.attr("id")
		{
			anchors.insert(id);
		}
	}
	let mut blocks = Vec::new();
	let mut index = 0;
	while index < nodes.len() {
		if dropped[index] {
			index = end(nodes, index);
			continue;
		}
		match &nodes[index] {
			Node::Tag(list) if is_contents_list(tree, dropped, list, &anchors) => {
				blocks.push(contents_block(tree, dropped, index));
				index = list.children.end;
			},
			_ => index += 1,
		}
	}
	// A wrapper climbed from one list may hold a later one.
	blocks.sort_unstable();
	blocks.dedup();
	let outer: Vec<usize> = blocks
		.iter()
		.copied()
		.filter(|&block| {
			!blocks
				.iter()
				.any(|&other| other != block && tree.range(other).contains(&block))
		})
		.collect();
	apply_with_backup(nodes, dropped, 0..nodes.len(), &outer);
}

/// A table of contents has at least this many links.
const CONTENTS_MIN_LINKS: usize = 3;
/// Text besides the list that its wrapper may hold.
const CONTENTS_LABEL_MAX_CHARS: usize = 30;

/// A top-level list of at least three links, all to the page's own headings,
/// that is nearly all link text and not introduced by a sentence ending in
/// ':' (a list the text points at).
fn is_contents_list(
	tree: &Tree,
	dropped: &[bool],
	list: &Element,
	anchors: &HashSet<&str>,
) -> bool {
	let nodes = tree.nodes;
	if !matches!(list.name(), "ul" | "ol")
		|| tree
			.parent(list.index())
			.and_then(|index| tree.tag(index))
			.is_some_and(|parent| parent.name() == "li")
	{
		return false;
	}
	let mut links = 0;
	for (_, node) in walk(nodes, dropped, list.children.clone()) {
		if let Node::Tag(tag) = node
			&& tag.name() == "a"
		{
			let Some(target) = tag
				.attr("href")
				.and_then(|href| href.trim().strip_prefix('#'))
			else {
				return false;
			};
			if !anchors.contains(target) {
				return false;
			}
			links += 1;
		}
	}
	let count = LinkCount::of(nodes, dropped, list.children.clone());
	links >= CONTENTS_MIN_LINKS
		&& 5 * count.link >= 4 * count.text
		&& !introduced_by_sentence(tree, dropped, list)
}

/// The list's wrapper chain holding nothing but the list and a short label.
fn contents_block(tree: &Tree, dropped: &[bool], list: usize) -> usize {
	let nodes = tree.nodes;
	let mut block = list;
	while let Some(parent) = tree.parent(block) {
		let Some(tag) = tree.tag(parent) else { break };
		if !matches!(tag.name(), "details" | "nav" | "div" | "section" | "aside") {
			break;
		}
		let total = LinkCount::of(nodes, dropped, tag.children.clone()).text;
		let own = LinkCount::of(nodes, dropped, tree.range(block)).text;
		if total - own > CONTENTS_LABEL_MAX_CHARS {
			break;
		}
		block = parent;
	}
	block
}

/// Whether the element just before `tag` is a paragraph ending in ':'.
fn introduced_by_sentence(tree: &Tree, dropped: &[bool], tag: &Element) -> bool {
	previous_element(tree, dropped, tag).is_some_and(|previous| {
		previous.name() == "p"
			&& label(tree.nodes, dropped, previous.children.clone(), usize::MAX)
				.is_some_and(|text| text.ends_with(':'))
	})
}

/// The selected element sibling just before `tag`.
fn previous_element<'a>(tree: &Tree<'a>, dropped: &[bool], tag: &Element) -> Option<&'a Element> {
	let nodes = tree.nodes;
	let parent = tree.parent(tag.index()).and_then(|index| tree.tag(index))?;
	let mut previous = None;
	let mut sibling = parent.children.start;
	while sibling < tag.index() {
		if !dropped[sibling] && matches!(nodes[sibling], Node::Tag(_)) {
			previous = Some(sibling);
		}
		sibling = end(nodes, sibling);
	}
	previous.and_then(|index| tree.tag(index))
}

/// A static copy of an app shell holds at least this much text.
const NOSCRIPT_MIN_CHARS: usize = 400;
/// Below this much selected text the page counts as empty.
const EMPTY_MAX_CHARS: usize = 200;

/// Pipeline step 12: when the selection is nearly empty, show each
/// body-level `<noscript>` holding a heading, a paragraph and at least 400
/// characters: the content an app shell ships for script-less readers (a
/// one-line "enable JavaScript" notice does not qualify).
fn restore_noscript(tree: &Tree, dropped: &mut [bool], controlled: &[bool]) {
	let nodes = tree.nodes;
	if text_len(nodes, dropped, 0..nodes.len()) >= EMPTY_MAX_CHARS {
		return;
	}
	for (index, node) in nodes.iter().enumerate() {
		let Node::Tag(tag) = node else { continue };
		if tag.name() != "noscript"
			|| tree
				.parent(index)
				.and_then(|parent| tree.tag(parent))
				.is_none_or(|parent| parent.name() != "body")
		{
			continue;
		}
		let inner = &nodes[tag.children.clone()];
		let has = |names: &[&str]| {
			inner
				.iter()
				.any(|node| matches!(node, Node::Tag(tag) if names.contains(&tag.name())))
		};
		if has(&["h1", "h2", "h3"])
			&& has(&["p"])
			&& LinkCount::of(nodes, &[], tag.children.clone()).text >= NOSCRIPT_MIN_CHARS
		{
			let mut source = controlled.to_vec();
			source[index] = false;
			tree.restore(dropped, &source, index);
		}
	}
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
/// callout). As in ARIA, a `<header>` inside an article, aside, main, nav or
/// section belongs to that section and is no landmark; so is a `<footer>`
/// inside an article, aside, nav or section, but a footer directly in `main`
/// is the page's (copyright, site links). An `<aside>` sitting in running
/// prose (its parent holds two or more paragraphs) that is mostly not links is
/// a callout (`aside.warning` in a docs page), not a sidebar.
fn is_landmark(tree: &Tree, tag: &Element) -> bool {
	match tag.attr("role") {
		Some(roles) if !roles.trim().is_empty() => {
			has_role(tag, &["navigation", "banner", "contentinfo", "complementary"])
		},
		_ => match tag.name() {
			"nav" => true,
			"aside" => !is_callout(tree, tag),
			name @ ("header" | "footer") => {
				!std::iter::successors(tree.parent(tag.index()), |&index| tree.parent(index))
					.filter_map(|index| tree.tag(index))
					.any(|section| match section.name() {
						"article" | "aside" | "nav" | "section" => true,
						"main" => name == "header",
						_ => name == "header" && has_role(section, &["main"]),
					})
			},
			_ => false,
		},
	}
}

/// Paragraphs beside an aside that make it part of running prose.
const PROSE_SIBLING_PARAGRAPHS: usize = 2;

/// An aside among paragraphs whose text is mostly not links.
fn is_callout(tree: &Tree, aside: &Element) -> bool {
	let nodes = tree.nodes;
	let Some(parent) = tree.parent(aside.index()).and_then(|index| tree.tag(index)) else {
		return false;
	};
	let mut paragraphs = 0;
	let mut child = parent.children.start;
	while child < parent.children.end {
		if matches!(&nodes[child], Node::Tag(tag) if tag.name() == "p") {
			paragraphs += 1;
		}
		child = end(nodes, child);
	}
	let count = LinkCount::of(nodes, &[], aside.children.clone());
	paragraphs >= PROSE_SIBLING_PARAGRAPHS && count.text > 0 && 2 * count.link < count.text
}

/// Labelled fields that make an aside data rather than navigation.
const DATA_ASIDE_MIN_LABELS: usize = 3;

/// A complementary aside holding labelled data (a package's install command,
/// repository, downloads and version under their own headings) rather than
/// links: it is content.
fn is_data_aside(tree: &Tree, dropped: &[bool], tag: &Element) -> bool {
	let nodes = tree.nodes;
	let complementary = match tag.attr("role") {
		Some(roles) if !roles.trim().is_empty() => has_role(tag, &["complementary"]),
		_ => tag.name() == "aside",
	};
	if !complementary {
		return false;
	}
	let labels = walk(nodes, dropped, tag.children.clone())
		.filter(|&(index, node)| {
			let Node::Tag(inner) = node else { return false };
			if !matches!(inner.name(), "h2" | "h3" | "h4" | "h5" | "h6" | "dt" | "th") {
				return false;
			}
			let count = LinkCount::of(nodes, dropped, inner.children.clone());
			count.text > count.link
				&& !std::iter::successors(tree.parent(index), |&parent| tree.parent(parent))
					.take_while(|&parent| parent != tag.index())
					.filter_map(|parent| tree.tag(parent))
					.any(|parent| parent.name() == "a" && parent.has_attr("href"))
		})
		.count();
	let count = LinkCount::of(nodes, dropped, tag.children.clone());
	labels >= DATA_ASIDE_MIN_LABELS && 2 * count.link < count.text
}

// ── Controls ─────────────────────────────────────────────────────────────

/// Drop controls everywhere: pipeline step 2 of [`reader`].
fn drop_controls(tree: &Tree, dropped: &mut [bool]) {
	let nodes = tree.nodes;
	let mut prompts: Vec<usize> = walk(nodes, dropped, 0..nodes.len())
		.filter_map(|(index, node)| match node {
			Node::Tag(tag)
				if matches!(tag.name(), "a" | "button")
					&& is_sign_in(nodes, tag)
					&& !in_prose_paragraph(tree, dropped, tag) =>
			{
				Some(index)
			},
			_ => None,
		})
		.collect();
	prompts.extend(feedback_prompts(nodes, dropped, FEEDBACK_PROMPTS));
	for index in prompts {
		let block = prompt_block(tree, dropped, index);
		dropped[block] = true;
	}
	// A taxonomy row goes as one line: the block around its label, not the
	// post footer that also names the author.
	for index in feedback_prompts(nodes, dropped, TAXONOMY_LABELS) {
		let line = std::iter::successors(Some(index), |&index| tree.parent(index))
			.find(|&index| {
				tree
					.tag(index)
					.is_none_or(|tag| !INLINE.contains(&tag.name()))
			})
			.filter(|&line| text_len(nodes, dropped, tree.range(line)) <= FEEDBACK_MAX_CHARS)
			.unwrap_or(index);
		dropped[line] = true;
	}
	let pagers: Vec<usize> = walk(nodes, dropped, 0..nodes.len())
		.filter_map(|(index, node)| match node {
			Node::Tag(tag) if tag.name() == "a" => labelled_pager(tree, index),
			_ => None,
		})
		.collect();
	for index in pagers {
		dropped[index] = true;
	}
	if let Some(bar) = promo_bar(tree, dropped) {
		dropped[bar] = true;
	}
	let values = stated_values(tree, dropped);
	controls(tree, dropped, 0..nodes.len(), false, &values);
	drop_field_labels(tree, dropped);
}

/// A promo bar holds at most this much text.
const PROMO_MAX_CHARS: usize = 200;

/// A sticky or fixed bar before the page's content holding one short linked
/// sentence ("Enrollment for my course is open! Join"): an announcement
/// strip, not content.
fn promo_bar(tree: &Tree, dropped: &[bool]) -> Option<usize> {
	let nodes = tree.nodes;
	let content = nodes.iter().position(|node| {
		matches!(node, Node::Tag(tag)
			if matches!(tag.name(), "main" | "article" | "h1") || has_role(tag, &["main"]))
	})?;
	walk(nodes, dropped, 0..content).find_map(|(index, node)| {
		let Node::Tag(tag) = node else { return None };
		let pinned = tag.attr("class").is_some_and(|class| {
			class
				.split_ascii_whitespace()
				.any(|token| token == "sticky" || token == "fixed")
		}) || tag.attr("style").is_some_and(|style| {
			let style: String = style.chars().filter(|ch| !ch.is_whitespace()).collect();
			let style = style.to_ascii_lowercase();
			style.contains("position:sticky") || style.contains("position:fixed")
		});
		let inner = &nodes[tag.children.clone()];
		let has = |names: &[&str]| {
			inner.iter().any(
				|node| matches!(node, Node::Tag(tag) if names.contains(&tag.name()) || is_heading(tag.name())),
			)
		};
		(pinned
			&& (1..=PROMO_MAX_CHARS).contains(&text_len(nodes, dropped, tag.children.clone()))
			&& inner
				.iter()
				.any(|node| matches!(node, Node::Tag(link) if link.name() == "a"))
			&& !has(&["nav", "ul", "ol", "form"]))
		.then_some(index)
	})
}

/// A field label ("Version:") is at most this long.
const FIELD_LABEL_MAX_CHARS: usize = 30;

/// Drop the label left before a dropped form field: climb from the field
/// while its ancestors hold no other text, then drop the element just before
/// if its text is a short label ending in ':'.
fn drop_field_labels(tree: &Tree, dropped: &mut [bool]) {
	let nodes = tree.nodes;
	let fields: Vec<usize> = nodes
		.iter()
		.enumerate()
		.filter(|&(index, node)| {
			dropped[index]
				&& matches!(node, Node::Tag(tag) if matches!(tag.name(), "select" | "input" | "textarea"))
		})
		.map(|(index, _)| index)
		.collect();
	for field in fields {
		let mut holder = field;
		while let Some(parent) = tree.parent(holder) {
			let Some(tag) = tree.tag(parent) else { break };
			if matches!(tag.name(), "html" | "body")
				|| text_len(nodes, dropped, tag.children.clone()) > 0
			{
				break;
			}
			holder = parent;
		}
		let Some(holder_tag) = tree.tag(holder) else {
			continue;
		};
		if let Some(previous) = previous_element(tree, dropped, holder_tag)
			&& label(nodes, dropped, previous.children.clone(), FIELD_LABEL_MAX_CHARS)
				.is_some_and(|text| text.ends_with(':'))
		{
			dropped[previous.index()] = true;
		}
	}
}

/// A paragraph at least this long is running prose.
const PROSE_PARAGRAPH_MIN_CHARS: usize = 80;

/// Whether a link sits in a paragraph of prose it is at most two fifths of
/// ("Don't have an account yet? Sign up for free and start building …"): a
/// call to action inside an article, not a sign-in prompt.
fn in_prose_paragraph(tree: &Tree, dropped: &[bool], link: &Element) -> bool {
	let nodes = tree.nodes;
	let paragraph = std::iter::successors(tree.parent(link.index()), |&index| tree.parent(index))
		.filter_map(|index| tree.tag(index))
		.take_while(|tag| !matches!(tag.name(), "div" | "section" | "li" | "body"))
		.find(|tag| tag.name() == "p");
	paragraph.is_some_and(|paragraph| {
		let text = text_len(nodes, dropped, paragraph.children.clone());
		text >= PROSE_PARAGRAPH_MIN_CHARS
			&& 5 * text_len(nodes, dropped, link.children.clone()) <= 2 * text
	})
}

/// Openings of page-feedback widgets, feed-subscription and comment prompts.
const FEEDBACK_PROMPTS: &[&str] = &[
	"subscribe to",
	"was this page helpful",
	"was this article helpful",
	"was this helpful",
	"was this content helpful",
	"was this documentation helpful",
	"was this guide helpful",
	"did this page help",
	"is this page helpful",
	"did you find this helpful",
	"did you find this page helpful",
	"rate this page",
	"how helpful was this",
	"add comment",
	"add a comment",
	"leave a comment",
	"leave a reply",
	"post a comment",
];
/// Openings of a post's taxonomy row ("Filed under: research").
const TAXONOMY_LABELS: &[&str] = &["posted in", "filed under"];
/// A feedback widget's text is at most this long.
const FEEDBACK_MAX_CHARS: usize = 200;

/// The innermost elements whose text opens with one of `openings` ("Was this
/// page helpful? Yes No").
fn feedback_prompts(nodes: &[Node], dropped: &[bool], openings: &[&str]) -> Vec<usize> {
	let mut found: Vec<usize> = Vec::new();
	for (index, node) in walk(nodes, dropped, 0..nodes.len()) {
		let Node::Tag(tag) = node else { continue };
		if label(nodes, dropped, tag.children.clone(), FEEDBACK_MAX_CHARS).is_some_and(|text| {
			openings
				.iter()
				.any(|prompt| starts_with_words(&text, prompt))
		}) {
			// Preorder: an outer match precedes the inner one that replaces it.
			found.retain(|&outer| end(nodes, outer) <= index);
			found.push(index);
		}
	}
	found
}

/// A pager label ("Previous message:") is at most this long.
const PAGER_LABEL_MAX_CHARS: usize = 30;

/// A link labelled as a pager by the text before it ("Next message:
/// <a>subject</a>"): the item or paragraph holding it, else the link.
fn labelled_pager(tree: &Tree, link: usize) -> Option<usize> {
	let nodes = tree.nodes;
	let parent = tree.parent(link)?;
	let start = tree.tag(parent)?.children.start;
	let before = plain_label(nodes, start..link, PAGER_LABEL_MAX_CHARS)?;
	let label = before.strip_suffix(':')?.trim_end();
	let mut words = label.rsplit(' ');
	let last = words.next()?;
	let pager = |word: &str| {
		["previous", "prev", "next", "older", "newer"]
			.iter()
			.any(|pager| word.eq_ignore_ascii_case(pager))
	};
	let labelled = pager(last) || words.next().is_some_and(pager);
	labelled.then(|| {
		if tree
			.tag(parent)
			.is_some_and(|tag| matches!(tag.name(), "li" | "p"))
		{
			parent
		} else {
			link
		}
	})
}

/// Drop controls among the siblings of `range` and below. Inside headings,
/// summaries and terms a button is the label itself (accordions) and stays.
fn controls(
	tree: &Tree,
	dropped: &mut [bool],
	range: Range<usize>,
	label: bool,
	values: &HashSet<usize>,
) {
	let nodes = tree.nodes;
	// A row of separated links inside an article (a project's "Demo | Paper |
	// Docs" line) is the author's; bars elsewhere are menus.
	let in_article = range.start > 0
		&& std::iter::successors(Some(range.start - 1), |&index| tree.parent(index))
			.filter_map(|index| tree.tag(index))
			.any(|tag| tag.name() == "article");
	if !in_article {
		drop_link_runs(nodes, dropped, range.clone());
	}
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
		if values.contains(&index) {
			// A labelled select states a value; the writers show its option.
		} else if is_control(nodes, tag, label || content_button(tree, dropped, tag))
			|| ((is_tailwind_hidden(tag) || is_off_screen(tag)) && !frames_content(nodes, tag))
		{
			dropped[index] = true;
		} else {
			let label = label || is_heading(tag.name()) || matches!(tag.name(), "summary" | "dt");
			controls(tree, dropped, tag.children.clone(), label, values);
		}
		index = tag.children.end;
	}
}

/// Buttons can be the visible labels of list entries, or words embedded in
/// a sentence. Their popovers and other controls are still pruned normally.
fn content_button(tree: &Tree, dropped: &[bool], tag: &Element) -> bool {
	if tag.name() != "button" {
		return false;
	}
	let Some(parent) = tree.parent(tag.index()).and_then(|index| tree.tag(index)) else {
		return false;
	};
	(tag.has_attr("popovertarget") && parent.name() == "li")
		|| (parent.name() == "p"
			&& text_len(tree.nodes, dropped, parent.children.clone())
				> text_len(tree.nodes, dropped, tag.children.clone()))
}

/// Words naming a picker that changes the page rather than stating a value.
const PICKER_WORDS: &[&str] =
	&["version", "language", "lang", "locale", "theme", "appearance", "currency", "sort"];

/// The selects that state a configured value (an order form's "Memory: 128 GB
/// RAM"): labelled by a `<label>` (wrapping it, pointing at its id, or just
/// before it), outside headers, navigation, footers and asides, and not a
/// version, language, theme, currency or sort picker.
fn stated_values(tree: &Tree, dropped: &[bool]) -> HashSet<usize> {
	let nodes = tree.nodes;
	let targets: HashSet<&str> = walk(nodes, dropped, 0..nodes.len())
		.filter_map(|(_, node)| match node {
			Node::Tag(tag) if tag.name() == "label" => tag.attr("for"),
			_ => None,
		})
		.collect();
	walk(nodes, dropped, 0..nodes.len())
		.filter_map(|(index, node)| match node {
			Node::Tag(select) if select.name() == "select" => {
				let ancestors =
					|| std::iter::successors(tree.parent(index), |&parent| tree.parent(parent));
				let labelled = select.attr("id").is_some_and(|id| targets.contains(id))
					|| ancestors()
						.filter_map(|parent| tree.tag(parent))
						.any(|tag| tag.name() == "label")
					|| previous_element(tree, dropped, select).is_some_and(|tag| {
						// A label just before, unless it belongs to another field.
						tag.name() == "label"
							&& !tag.has_attr("for")
							&& !nodes[tag.children.clone()].iter().any(|node| {
								matches!(node, Node::Tag(field)
									if matches!(field.name(), "select" | "input" | "textarea"))
							})
					});
				let picker = ["name", "id", "aria-label", "class"].iter().any(|key| {
					select.attr(key).is_some_and(|value| {
						token_words(value).any(|word| {
							PICKER_WORDS
								.iter()
								.any(|picker| word.eq_ignore_ascii_case(picker))
						})
					})
				});
				let chrome = ancestors()
					.filter_map(|parent| tree.tag(parent))
					.any(|tag| {
						matches!(tag.name(), "header" | "nav" | "footer" | "aside")
							|| has_role(tag, &["navigation", "banner", "contentinfo", "search"])
					});
				(labelled && !picker && !chrome).then_some(index)
			},
			_ => None,
		})
		.collect()
}

/// An element moved fully off-screen by its inline style
/// (`transform: translateY(-100%)`): an announcement bar or drawer waiting for
/// a script to slide it in.
fn is_off_screen(tag: &Element) -> bool {
	tag.attr("style").is_some_and(|style| {
		let style: String = style
			.chars()
			.filter(|ch| !ch.is_whitespace())
			.collect::<String>()
			.to_ascii_lowercase();
		["translatex(-100%)", "translatey(-100%)", "translatex(100%)", "translatey(100%)"]
			.iter()
			.any(|offset| style.contains(offset))
	})
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
		// An image map is a clickable menu. Other images without alt text are
		// the writer's call (diagram or decoration).
		"img" => tag.has_attr("usemap") || tag.has_attr("ismap"),
		"a" => {
			is_skip_link(nodes, tag)
				|| is_pager(nodes, tag)
				|| is_page_tool(nodes, tag)
				|| (label && is_permalink(nodes, tag))
		},
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
		])
		|| (has_role(tag, &["tablist"]) && !is_label_tablist(nodes, tag))
}

/// A tab list whose tabs are plain text labels (response codes 200, 404,
/// 422 over their panels) and that holds no panel itself: the labels name
/// content and stay. Tabs made of buttons, links or form fields are controls.
fn is_label_tablist(nodes: &[Node], list: &Element) -> bool {
	let mut tabs = 0;
	let mut child = list.children.start;
	while child < list.children.end {
		match &nodes[child] {
			Node::Text(text) if text.trim().is_empty() => {},
			Node::Tag(tab) if has_role(tab, &["tab"]) => {
				if matches!(tab.name(), "a" | "button" | "input")
					|| nodes[tab.children.clone()].iter().any(|node| {
						matches!(node, Node::Tag(inner)
						if matches!(inner.name(), "a" | "button" | "input" | "label" | "select")
							|| has_role(inner, &["tabpanel"]))
					}) {
					return false;
				}
				tabs += 1;
			},
			_ => return false,
		}
		child = end(nodes, child);
	}
	tabs > 0
}

/// Glyphs heading permalinks show (`¶`, `#`, `§`, a link emoji), or nothing.
const PERMALINK_GLYPHS: &[&str] = &["", "¶", "#", "§", "🔗", "⚓", "∞"];

/// A same-page link inside a heading or term whose text is a permalink glyph
/// or empty (`<a class="hash-link" href="#cause">​</a>`).
fn is_permalink(nodes: &[Node], link: &Element) -> bool {
	link
		.attr("href")
		.is_some_and(|href| href.trim().starts_with('#'))
		&& plain_label(nodes, link.children.clone(), 4).is_some_and(|text| {
			PERMALINK_GLYPHS
				.contains(&text.trim_matches(|ch: char| ch == '\u{200b}' || ch.is_whitespace()))
		})
}

/// Tailwind display utilities a responsive variant can restore
/// (`md:block`).
const DISPLAY_UTILITIES: &[&str] = &[
	"block",
	"flex",
	"inline",
	"inline-block",
	"inline-flex",
	"grid",
	"inline-grid",
	"table",
	"table-cell",
	"table-row",
	"contents",
	"flow-root",
	"list-item",
];

/// A Tailwind `hidden` element (`display: none`) that no responsive variant
/// shows again (`hidden md:block` shows on wide screens).
fn is_tailwind_hidden(tag: &Element) -> bool {
	// A table's header rows explain its data even when styled away.
	!matches!(tag.name(), "thead" | "tr" | "th" | "caption")
		&& tag.attr("class").is_some_and(|class| {
			class
				.split_ascii_whitespace()
				.any(|token| token == "hidden")
				&& !class.split_ascii_whitespace().any(|token| {
					token
						.rsplit_once(':')
						.is_some_and(|(_, utility)| DISPLAY_UTILITIES.contains(&utility))
				})
		})
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
		// A whole linked card can end in a decorative arrow without being a
		// previous/next control.
		if (text.starts_with(ARROWS) || text.ends_with(ARROWS))
			&& nodes[tag.children.clone()]
				.iter()
				.filter(|node| card_block(nodes, node))
				.nth(1)
				.is_none()
		{
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
			|| walk(nodes, dropped, tag.children.clone()).any(|(index, node)| {
				matches!(node, Node::Tag(paragraph)
					if paragraph.name() == "p"
						&& !tree.range(index).contains(&control)
						&& text_len(nodes, dropped, paragraph.children.clone())
							>= PROSE_PARAGRAPH_MIN_CHARS)
			})
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
		start:     usize,
		end:       usize,
		links:     usize,
		/// A separator (not only brackets) joins the run.
		bar:       bool,
		/// A separator follows the last link.
		gap:       bool,
		/// Every link's own text is bracketed (`[ date ] [ thread ]`).
		bracketed: bool,
	}
	const fn finish(nodes: &[Node], dropped: &mut [bool], run: &mut Option<Run>) {
		if let Some(run) = run.take()
			&& run.links >= BAR_MIN_LINKS
			&& (run.bar || run.bracketed)
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
				let bracketed = is_bracketed(nodes, dropped, tag);
				if let Some(current) = run.as_mut().filter(|run| run.gap) {
					current.links += 1;
					current.end = next;
					current.gap = false;
					current.bracketed &= bracketed;
				} else {
					finish(nodes, dropped, &mut run);
					run = Some(Run {
						start: lead.unwrap_or(index),
						end: next,
						links: 1,
						bar: false,
						gap: false,
						bracketed,
					});
				}
				lead = None;
			},
			Node::Text(text)
				if text.chars().all(|ch| {
					ch.is_whitespace() || BAR_SEPARATORS.contains(&ch) || BAR_BRACKETS.contains(&ch)
				}) =>
			{
				// `] [` between links joins a bracketed bar (`[ date ] [ thread
				// ]`).
				let separator =
					text.contains(BAR_SEPARATORS) || (text.contains(']') && text.contains('['));
				let joins = separator || text.contains(BAR_BRACKETS);
				match &mut run {
					Some(run) => {
						// Whitespace alone joins links that bracket themselves.
						run.gap |= joins || run.bracketed;
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

/// Whether a link's whole text is wrapped in brackets (`[ date ]`).
fn is_bracketed(nodes: &[Node], dropped: &[bool], link: &Element) -> bool {
	label(nodes, dropped, link.children.clone(), LABEL_MAX_CHARS)
		.is_some_and(|text| text.len() > 2 && text.starts_with('[') && text.ends_with(']'))
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
			if (previous.is_ascii_alphabetic() && current.is_ascii_digit())
				|| (previous.is_ascii_digit() && current.is_ascii_alphabetic())
				|| (previous.is_ascii_lowercase() && current.is_ascii_uppercase())
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

/// Pipeline step 7: keep only the innermost content region holding two
/// thirds of the remaining text. Narrowing never leaves the page heading
/// behind: once a region holds the heading, an inner region must hold it
/// too. Data asides beside the region stay. Returns the region.
fn narrow_to_region(tree: &Tree, dropped: &mut [bool], controlled: &[bool]) -> Option<usize> {
	let nodes = tree.nodes;
	let all = 0..nodes.len();
	let total = text_len(nodes, dropped, all.clone());
	// The page heading: the one the title names, else the first heading that
	// is not just a logo link (a title naming only the site).
	let heading = named_heading(nodes, dropped, document_title(nodes).as_deref()).or_else(|| {
		walk(nodes, dropped, 0..nodes.len()).find_map(|(index, node)| match node {
			Node::Tag(tag) if tag.name() == "h1" => {
				let count = LinkCount::of(nodes, dropped, tag.children.clone());
				(count.text > count.link).then_some(index)
			},
			_ => None,
		})
	});
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
				&& !matches!(&nodes[sibling], Node::Tag(aside) if is_data_aside(tree, controlled, aside))
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

/// A link holding at least two text blocks (a title and a description).
fn is_card(nodes: &[Node], dropped: &[bool], link: &Element) -> bool {
	walk(nodes, dropped, link.children.clone())
		.filter(|(_, node)| card_block(nodes, node))
		.nth(1)
		.is_some()
}

fn card_block(nodes: &[Node], node: &Node) -> bool {
	matches!(node, Node::Tag(block)
		if (matches!(block.name(), "div" | "p" | "section") || is_heading(block.name()))
			&& direct_text(nodes, block))
}

/// Whether an element has a non-blank text node among its own children.
fn direct_text(nodes: &[Node], tag: &Element) -> bool {
	let mut child = tag.children.start;
	while child < tag.children.end {
		if matches!(&nodes[child], Node::Text(text) if !text.trim().is_empty()) {
			return true;
		}
		child = end(nodes, child);
	}
	false
}

/// Pipeline step 8: drop blocks after the last paragraph, preformatted block
/// or quote of `region` (or of the page) whose text is at least half link
/// text — topic tags, share and reuse links, a list's "More information"
/// link — up to the next heading, which starts a section of its own ("See
/// also", references). Blocks holding cards (links with a title and a
/// description) stay. Kept only if more than one seventh of the text
/// survives.
fn drop_trailing_links(tree: &Tree, dropped: &mut [bool], region: Option<usize>) {
	let nodes = tree.nodes;
	let range = region.map_or(0..nodes.len(), |region| tree.range(region));
	let Some(last) = walk(nodes, dropped, range.clone())
		.filter_map(|(index, node)| match node {
			Node::Tag(tag)
				if matches!(tag.name(), "p" | "pre" | "blockquote")
					&& text_len(nodes, dropped, tag.children.clone()) > 0 =>
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
		// Cards (a link holding a title and a description) are an index of
		// the page's own sections, not a row of tags.
		if walk(nodes, dropped, range.clone()).any(
			|(_, node)| matches!(node, Node::Tag(tag) if tag.name() == "a" && is_card(nodes, dropped, tag)),
		) {
			continue;
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
	// A heading or a sentence ending in ':' introduces a list the text
	// points at ("See also", "The built-in formatters are:").
	!previous_element(tree, dropped, list).is_some_and(|previous| is_heading(previous.name()))
		&& !introduced_by_sentence(tree, dropped, list)
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
	"menu",
	"modal",
	"nav",
	"navbar",
	"navigation",
	"newsletter",
	"noprint",
	"overlay",
	"pager",
	"paginator",
	"pagination",
	"poll",
	"polls",
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
	"tooltip",
	"topbar",
];

/// A class or id naming chrome: a chrome word ([`names_chrome`]) or a hidden
/// state ([`hidden_by_class`]).
fn is_chrome(tree: &Tree, tag: &Element) -> bool {
	(names_chrome(tag) && !inline_in_prose(tree, tag)) || hidden_by_class(tree, tag)
}

/// Phrasing elements: inline within a paragraph.
const INLINE: &[&str] = &[
	"span", "a", "code", "kbd", "em", "strong", "b", "i", "small", "abbr", "cite", "mark", "sub",
	"sup", "time", "var", "samp", "q", "u", "s",
];

/// An inline element holding no link inside a paragraph, list item or cell:
/// a widget in a sentence (a settings reference styled as a dropdown) whose
/// text is part of the sentence. Its own controls still go as controls.
fn inline_in_prose(tree: &Tree, tag: &Element) -> bool {
	INLINE.contains(&tag.name())
		&& !std::iter::once(tag)
			.chain(
				tree.nodes[tag.children.clone()]
					.iter()
					.filter_map(|node| match node {
						Node::Tag(inner) => Some(inner),
						Node::Text(_) => None,
					}),
			)
			.any(|inner| inner.name() == "a")
		&& std::iter::successors(tree.parent(tag.index()), |&index| tree.parent(index))
			.filter_map(|index| tree.tag(index))
			.find(|ancestor| !INLINE.contains(&ancestor.name()))
			.is_some_and(|block| matches!(block.name(), "p" | "li" | "td" | "dd"))
}

/// A class or id holding a chrome word, or naming a version badge. Headings
/// are content whatever their classes say (Docusaurus marks every section
/// heading `anchor anchorTargetStickyNavbar_*`), and so are admonitions
/// (`admonition`, `callout`) even when styled as a banner.
fn names_chrome(tag: &Element) -> bool {
	if is_heading(tag.name())
		|| tag.attr("class").is_some_and(|class| {
			let class = class.to_ascii_lowercase();
			class.contains("admonition") || class.contains("callout")
		}) {
		return false;
	}
	class_and_id(tag).any(|token| {
		if token.contains(':') || token.starts_with("border-") || token == "text-nav" {
			return false;
		}
		let mut version = false;
		let mut badge = false;
		for word in token_words(token) {
			if CHROME_WORDS
				.iter()
				.any(|chrome| word.eq_ignore_ascii_case(chrome))
			{
				return true;
			}
			version |= word.eq_ignore_ascii_case("version");
			badge |= word.eq_ignore_ascii_case("badge");
		}
		version && badge
	})
}

/// A class marking hidden text: a print-hidden utility (`noprint`,
/// `d-print-none`), visually hidden text (`sr-only`, `visually-hidden`) or a
/// hidden state (`is-hidden`). Responsive utility variants (`md:hidden`) only
/// toggle layout. Visually hidden text stays when a responsive variant shows
/// it (`sm:not-sr-only`) or when it spells out a sibling glyph hidden from
/// screen readers (`<span aria-hidden>—</span><span class=sr-only>Unknown
/// </span>`).
fn hidden_by_class(tree: &Tree, tag: &Element) -> bool {
	class_and_id(tag).any(|token| {
		if token.contains(':') {
			return false;
		}
		let mut print = false;
		let mut hides = false;
		let mut before = "";
		let mut previous = "";
		for word in token_words(token) {
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
				return !shown_responsively(tag) && !spells_out_glyph(tree, tag);
			}
			before = previous;
			previous = word;
		}
		let lower = |prefix: &str| {
			token
				.get(..prefix.len())
				.is_some_and(|head| head.eq_ignore_ascii_case(prefix))
		};
		// `field--label-hidden` hides a field's label, not the field.
		let hides_part = ["label", "title", "caption", "legend", "icon", "heading"]
			.iter()
			.any(|part| before.eq_ignore_ascii_case(part));
		(print && hides)
			|| (token.len() > "-hidden".len()
				&& token
					.get(token.len() - "-hidden".len()..)
					.is_some_and(|tail| tail.eq_ignore_ascii_case("-hidden"))
				&& !lower("overflow")
				&& !hides_part)
	})
}

/// A responsive `not-sr-only` variant (`sm:not-sr-only`).
fn shown_responsively(tag: &Element) -> bool {
	tag.attr("class").is_some_and(|class| {
		class
			.split_ascii_whitespace()
			.any(|token| token.ends_with(":not-sr-only"))
	})
}

/// Whether a sibling element hidden from screen readers shows text (a glyph
/// this element spells out).
fn spells_out_glyph(tree: &Tree, tag: &Element) -> bool {
	let nodes = tree.nodes;
	let Some(parent) = tree.parent(tag.index()).and_then(|index| tree.tag(index)) else {
		return false;
	};
	let mut sibling = parent.children.start;
	while sibling < parent.children.end {
		if let Node::Tag(glyph) = &nodes[sibling]
			&& sibling != tag.index()
			&& glyph
				.attr("aria-hidden")
				.is_some_and(|value| value.trim().eq_ignore_ascii_case("true"))
			&& LinkCount::of(nodes, &[], glyph.children.clone()).text > 0
		{
			return true;
		}
		sibling = end(nodes, sibling);
	}
	false
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

/// Pipeline step 11: restore the page heading when the selection lost every
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
fn restore_lead(tree: &Tree, dropped: &mut [bool], source: &[bool], heading: usize) -> bool {
	let nodes = tree.nodes;
	let after = end(nodes, heading);
	let Some(first) = walk(nodes, dropped, after..nodes.len()).find_map(|(index, node)| {
		matches!(node, Node::Text(text) if !text.trim().is_empty()).then_some(index)
	}) else {
		return false;
	};
	let Some(frame) =
		std::iter::successors(tree.parent(heading), |&index| tree.parent(index)).find(|&index| {
			tree
				.tag(index)
				.is_some_and(|tag| matches!(tag.name(), "article" | "main") || has_role(tag, &["main"]))
		})
	else {
		return false;
	};
	if first >= end(nodes, frame) {
		return false;
	}
	let shown = |index: usize| {
		std::iter::successors(Some(index), |&index| tree.parent(index)).all(|index| {
			tree.tag(index).is_none_or(|tag| {
				!matches!(tag.name(), "figure" | "figcaption")
					&& !is_landmark(tree, tag)
					&& !is_chrome(tree, tag)
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
	for &index in &lead {
		tree.restore(dropped, source, index);
	}
	!lead.is_empty()
}

/// At most this many blocks of a hero come back with its heading.
const HERO_MAX_BLOCKS: usize = 3;
/// A date line is at most this long.
const DATE_MAX_CHARS: usize = 40;

/// When a restored heading sits in a hero outside any article or main (no
/// standfirst found), restore the blocks after it in the same container: a
/// prose standfirst (at least [`LEAD_MIN_CHARS`], mostly not links) and a
/// date line.
fn restore_hero(tree: &Tree, dropped: &mut [bool], source: &[bool], heading: usize) {
	let nodes = tree.nodes;
	let Some(parent) = tree.parent(heading).and_then(|index| tree.tag(index)) else {
		return;
	};
	let mut restored = 0;
	let mut sibling = end(nodes, heading);
	while sibling < parent.children.end && restored < HERO_MAX_BLOCKS {
		let next = end(nodes, sibling);
		if !source[sibling]
			&& let Node::Tag(block) = &nodes[sibling]
		{
			let prose = block.name() == "p"
				|| nodes[block.children.clone()]
					.iter()
					.any(|node| matches!(node, Node::Tag(tag) if tag.name() == "p"));
			let count = LinkCount::of(nodes, source, block.children.clone());
			let keep = if prose {
				count.text >= LEAD_MIN_CHARS && 2 * count.link < count.text
			} else {
				label(nodes, source, block.children.clone(), DATE_MAX_CHARS)
					.is_some_and(|text| is_date(&text))
			};
			if keep {
				tree.restore(dropped, source, sibling);
				restored += 1;
			}
		}
		sibling = next;
	}
}

/// Whether short text reads as a date: a four-digit year with a month name or
/// an ISO date.
fn is_date(text: &str) -> bool {
	const MONTHS: &[&str] =
		&["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
	let words: Vec<String> = text
		.split(|ch: char| !ch.is_alphanumeric())
		.filter(|word| !word.is_empty())
		.map(str::to_ascii_lowercase)
		.collect();
	let year = words.iter().any(|word| {
		word.len() == 4
			&& word.chars().all(|ch| ch.is_ascii_digit())
			&& matches!(&word[..2], "19" | "20")
	});
	let month = words
		.iter()
		.any(|word| MONTHS.iter().any(|month| word.starts_with(month)));
	let iso = text.split_whitespace().any(|token| {
		let parts: Vec<&str> = token.split('-').collect();
		parts.len() == 3
			&& parts[0].len() == 4
			&& parts
				.iter()
				.all(|part| !part.is_empty() && part.chars().all(|ch| ch.is_ascii_digit()))
	});
	(year && month) || iso
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
