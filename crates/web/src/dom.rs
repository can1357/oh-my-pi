//! Shared HTML preorder arena built on `html5ever`'s tokenizer.
//!
//! Each tag's descendants occupy a contiguous slice in one arena, and adjacent
//! text tokens are merged into one decoded string. Optional HTML end tags
//! (notably `li`, `dt`, `dd`, `tr`, `td`, `th`, `option`, `p`) close
//! implicitly so malformed markup cannot swallow the rest of a page.

use std::{
	cell::RefCell,
	collections::{HashMap, HashSet},
	ops::Range,
};

use html5ever::{
	LocalName,
	tendril::StrTendril,
	tokenizer::{
		BufferQueue, CharacterTokens, CommentToken, EndTag, StartTag, Tag, TagToken, Token,
		TokenSink, TokenSinkResult, Tokenizer, states::RawKind,
	},
};

/// Maximum open-tag depth before nesting is flattened.
pub const MAX_DEPTH: usize = 256;

/// A node in the document preorder arena.
pub enum Node {
	/// Decoded character data.
	Text(String),
	/// An HTML tag with attributes and a range of descendants.
	Tag(Element),
}

/// An element in the document preorder arena.
pub struct Element {
	name:         LocalName,
	attrs:        Box<[(LocalName, String)]>,
	/// Contiguous range of all descendants.
	pub children: Range<usize>,
}

impl Element {
	/// Lowercase HTML tag name.
	pub fn name(&self) -> &str {
		&self.name
	}

	/// Index of this tag within its owning `Vec<Node>` arena.
	pub const fn index(&self) -> usize {
		self.children.start - 1
	}

	/// Attribute value by lowercase name, including empty values.
	pub fn attr(&self, key: &str) -> Option<&str> {
		self
			.attrs
			.iter()
			.find(|(name, _)| &**name == key)
			.map(|(_, value)| value.as_str())
	}

	/// Whether an attribute is present, regardless of its value.
	pub fn has_attr(&self, key: &str) -> bool {
		self.attrs.iter().any(|(name, _)| &**name == key)
	}
}

#[derive(Default)]
struct Tree {
	nodes:         Vec<Node>,
	open:          Vec<usize>,
	last_was_text: bool,
	/// Open React Suspense boundaries (`<!--$?-->`, `<!--$-->`, `<!--$!-->`):
	/// the first node inside and the element they opened in.
	suspense_open: Vec<(usize, Option<usize>)>,
	/// Closed boundaries (`<!--/$-->`) whose markers share one parent.
	suspense:      Vec<Range<usize>>,
}

impl Tree {
	fn close(&mut self, index: usize) {
		self.last_was_text = false;
		let end = self.nodes.len();
		for i in self.open.drain(index..) {
			if let Node::Tag(el) = &mut self.nodes[i] {
				el.children.end = end;
			}
		}
	}

	fn find_open(&self, matches: &[&str], scope: &[&str]) -> Option<usize> {
		for (i, node) in self.open.iter().enumerate().rev() {
			let Node::Tag(el) = &self.nodes[*node] else {
				unreachable!()
			};
			if matches.contains(&el.name()) {
				return Some(i);
			}
			if scope.contains(&el.name()) {
				break;
			}
		}
		None
	}

	/// Track React Suspense boundary markers; other comments are dropped.
	fn comment(&mut self, text: &str) {
		let parent = self.open.last().copied();
		if text == "/$" {
			if let Some((start, opened)) = self.suspense_open.pop()
				&& opened == parent
			{
				self.suspense.push(start..self.nodes.len());
			}
		} else if text.starts_with('$') {
			self.suspense_open.push((self.nodes.len(), parent));
		}
	}

	fn push_text(&mut self, raw: &str) {
		if raw.is_empty() {
			return;
		}
		if self.last_was_text
			&& let Some(Node::Text(prev)) = self.nodes.last_mut()
		{
			prev.push_str(raw);
		} else {
			self.nodes.push(Node::Text(raw.to_owned()));
			self.last_was_text = true;
		}
	}

	fn start(&mut self, tag: Tag) -> TokenSinkResult<()> {
		self.last_was_text = false;
		let name = &*tag.name;
		let implicit: Option<(&[&str], &[&str])> = match name {
			"li" | "lh" => Some((&["li", "lh"], &["ul", "ol", "dir", "menu"])),
			"dt" | "dd" => Some((&["dt", "dd"], &["dl", "dlc"])),
			"thead" | "tbody" | "tfoot" | "colgroup" | "caption" => {
				Some((&["td", "th", "tr", "thead", "tbody", "tfoot", "caption", "colgroup"], &[
					"table",
				]))
			},
			"tr" => Some((&["td", "th", "tr", "caption", "colgroup"], &["table"])),
			"th" | "td" => Some((&["th", "td"], &["tr", "table"])),
			"option" => Some((&["option"], &["select"])),
			"select" | "input" | "button" | "textarea" | "form" | "script" => Some((&["select"], &[])),
			"body" => Some((&["head"], &["html"])),
			// As in HTML5, a heading start closes an open paragraph or heading;
			// other block starts close only a paragraph, so a heading keeps a
			// `center` or `div` wrapped around its text.
			"h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
				Some((&["p", "h1", "h2", "h3", "h4", "h5", "h6"], &["table", "li", "td", "th"]))
			},
			"p" | "hr" | "div" | "center" | "table" | "dl" | "dlc" | "ol" | "ul" | "menu" | "dir"
			| "pre" | "blockquote" | "bq" => Some((&["p"], &["table", "li", "td", "th"])),
			_ => None,
		};
		if let Some((matches, scope)) = implicit {
			while let Some(i) = self.find_open(matches, scope) {
				self.close(i);
			}
		}
		let i = self.nodes.len();
		let void = tag.self_closing
			|| matches!(
				name,
				"area"
					| "base"
					| "basefont"
					| "bgsound"
					| "br"
					| "col"
					| "embed"
					| "frame"
					| "hr"
					| "hy"
					| "shy"
					| "tab"
					| "img"
					| "input"
					| "isindex"
					| "keygen"
					| "link"
					| "meta"
					| "param"
					| "source"
					| "track"
					| "wbr"
			);
		let raw = match name {
			"script" => Some(RawKind::ScriptData),
			"style" | "xmp" | "listing" | "plaintext" => Some(RawKind::Rawtext),
			"textarea" | "title" | "math" => Some(RawKind::Rcdata),
			_ => None,
		};
		// Past the nesting limit, flatten further elements into their parent
		// instead of refusing the page. Raw-text elements still open: they hold
		// only text, so the depth grows by at most one.
		let void = void || (raw.is_none() && self.open.len() >= MAX_DEPTH);
		let attrs: Box<[(LocalName, String)]> = tag
			.attrs
			.into_iter()
			.map(|attr| (attr.name.local, attr.value.to_string()))
			.collect();
		self
			.nodes
			.push(Node::Tag(Element { name: tag.name, attrs, children: i + 1..i + 1 }));
		if !void {
			self.open.push(i);
		}
		if !void && let Some(raw) = raw {
			TokenSinkResult::RawData(raw)
		} else {
			TokenSinkResult::Continue
		}
	}
}

#[derive(Default)]
struct Sink(RefCell<Tree>);

impl TokenSink for Sink {
	type Handle = ();

	fn process_token(&self, token: Token, _: u64) -> TokenSinkResult<()> {
		let mut tree = self.0.borrow_mut();
		match token {
			CharacterTokens(raw) => tree.push_text(&raw),
			CommentToken(text) => tree.comment(&text),
			TagToken(tag) => match tag.kind {
				StartTag => return tree.start(tag),
				EndTag => {
					if let Some(i) = tree.find_open(&[&tag.name], &[]) {
						tree.close(i);
					}
				},
			},
			_ => {},
		}
		TokenSinkResult::Continue
	}
}

fn tokenize(source: StrTendril) -> Vec<Node> {
	let input = BufferQueue::default();
	input.push_back(source);
	let tokenizer = Tokenizer::new(Sink::default(), Default::default());
	let _ = tokenizer.feed(&input);
	tokenizer.end();
	let mut tree = tokenizer.sink.0.into_inner();
	tree.close(0);
	splice_streamed(tree.nodes, &tree.suspense)
}

/// Apply React streaming SSR swaps: a Suspense boundary opening with
/// `<template id="B:n">` is replaced, fallback included, by the children of
/// the hidden `<div id="S:n">` that `$RC("B:n","S:n")` moves there, and the
/// hidden copy goes. The page then holds the streamed content once, where it
/// belongs.
fn splice_streamed(nodes: Vec<Node>, boundaries: &[Range<usize>]) -> Vec<Node> {
	let mut segments: HashMap<&str, usize> = HashMap::new();
	for (index, node) in nodes.iter().enumerate() {
		if let Node::Tag(tag) = node
			&& tag.name() == "div"
			&& tag.has_attr("hidden")
			&& let Some(id) = tag.attr("id").and_then(|id| id.strip_prefix("S:"))
		{
			segments.insert(id, index);
		}
	}
	if segments.is_empty() {
		return nodes;
	}
	let mut swaps: HashMap<usize, (usize, usize)> = HashMap::new();
	let mut moved: HashSet<usize> = HashSet::new();
	for boundary in boundaries {
		if let Some(Node::Tag(template)) = nodes.get(boundary.start)
			&& template.name() == "template"
			&& let Some(id) = template.attr("id").and_then(|id| id.strip_prefix("B:"))
			&& let Some(&segment) = segments.get(id)
			&& !(boundary.start..boundary.end).contains(&segment)
		{
			swaps.insert(boundary.start, (boundary.end, segment));
			moved.insert(segment);
		}
	}
	if swaps.is_empty() {
		return nodes;
	}
	let len = nodes.len();
	let mut old: Vec<Option<Node>> = nodes.into_iter().map(Some).collect();
	let mut out = Vec::with_capacity(len);
	copy_spliced(&mut old, 0..len, &swaps, &moved, &mut out);
	out
}

/// Copy the sibling nodes of `range` into `out`, applying `swaps` (boundary
/// start → boundary end and segment) and skipping `moved` segments.
fn copy_spliced(
	old: &mut [Option<Node>],
	range: Range<usize>,
	swaps: &HashMap<usize, (usize, usize)>,
	moved: &HashSet<usize>,
	out: &mut Vec<Node>,
) {
	let mut index = range.start;
	while index < range.end {
		if let Some(&(stop, segment)) = swaps.get(&index) {
			if let Some(Node::Tag(tag)) = &old[segment] {
				let children = tag.children.clone();
				copy_spliced(old, children, swaps, moved, out);
			}
			index = stop.max(index + 1);
			continue;
		}
		match old[index].take() {
			Some(Node::Text(text)) => {
				out.push(Node::Text(text));
				index += 1;
			},
			Some(Node::Tag(mut tag)) => {
				let children = tag.children.clone();
				if moved.contains(&index) {
					// Its children went to the boundary; restore the tag so a
					// later boundary can still read their range.
					old[index] = Some(Node::Tag(tag));
					index = children.end;
					continue;
				}
				let at = out.len();
				tag.children = at + 1..at + 1;
				out.push(Node::Tag(tag));
				copy_spliced(old, children.clone(), swaps, moved, out);
				let end = out.len();
				if let Node::Tag(tag) = &mut out[at] {
					tag.children.end = end;
				}
				index = children.end;
			},
			None => index += 1,
		}
	}
}

/// Parse HTML verbatim into a `Send + Sync` preorder node arena.
///
/// # Errors
/// Returns an error when the input exceeds tokenizer capacity.
pub fn parse(html: &str) -> Result<Vec<Node>, String> {
	let capacity =
		u32::try_from(html.len()).map_err(|_| "HTML input exceeds tokenizer capacity".to_owned())?;
	let mut source = StrTendril::with_capacity(capacity);
	source.push_slice(html);
	Ok(tokenize(source))
}

/// Parse HTML with Lynx `-stdin` line normalization (trimming trailing ASCII
/// whitespace on each line before appending LF, prior to entity decoding).
///
/// # Errors
/// Returns an error when the input exceeds tokenizer capacity.
pub fn parse_stdin(html: &str) -> Result<Vec<Node>, String> {
	let capacity = u32::try_from(html.len())
		.ok()
		.and_then(|n| n.checked_add(1))
		.ok_or_else(|| "HTML input exceeds tokenizer capacity".to_owned())?;
	let mut source = StrTendril::with_capacity(capacity);
	for line in html.split_terminator('\n') {
		source.push_slice(line.trim_ascii_end());
		source.push_char('\n');
	}
	Ok(tokenize(source))
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn nesting_past_the_limit_flattens_but_keeps_raw_text_raw() {
		let html = format!("{}deep<script><b>code</b></script>tail", "<div>".repeat(MAX_DEPTH + 50));
		let nodes = parse(&html).unwrap();
		let texts: Vec<&str> = nodes
			.iter()
			.filter_map(|n| match n {
				Node::Text(s) => Some(s.as_str()),
				Node::Tag(_) => None,
			})
			.collect();
		assert_eq!(texts, ["deep", "<b>code</b>", "tail"]);
		let Some(Node::Tag(script)) = nodes
			.iter()
			.find(|n| matches!(n, Node::Tag(e) if e.name() == "script"))
		else {
			unreachable!()
		};
		assert_eq!(script.children.len(), 1);
	}

	#[test]
	fn streamed_segments_replace_their_boundary_once() {
		let html = "<main><p>Intro</p><!--$?--><template \
		            id=\"B:0\"></template><p>Loading</p><!--/$--><p>End</p></main><div hidden \
		            id=\"S:0\"><p>Streamed</p></div><script>$RC(\"B:0\",\"S:0\")</script>";
		let nodes = parse(html).unwrap();
		let texts: Vec<&str> = nodes
			.iter()
			.filter_map(|node| match node {
				Node::Text(text) => Some(text.as_str()),
				Node::Tag(_) => None,
			})
			.collect();
		assert_eq!(texts, ["Intro", "Streamed", "End", "$RC(\"B:0\",\"S:0\")"]);
		// Ranges stay consistent: `main` holds the spliced paragraph.
		let Some(Node::Tag(main)) = nodes
			.iter()
			.find(|n| matches!(n, Node::Tag(e) if e.name() == "main"))
		else {
			unreachable!()
		};
		assert!(
			nodes[main.children.clone()]
				.iter()
				.any(|node| matches!(node, Node::Text(text) if text == "Streamed"))
		);
		assert!(
			!nodes
				.iter()
				.any(|node| matches!(node, Node::Tag(tag) if tag.attr("id") == Some("S:0")))
		);
	}

	#[test]
	fn blocks_nest_in_headings() {
		let nodes = parse("<h1><center>Title</center></h1><p>Body").unwrap();
		assert!(nodes.iter().any(|node| {
			matches!(node, Node::Tag(tag) if tag.name() == "h1"
				&& nodes[tag.children.clone()]
					.iter()
					.any(|inner| matches!(inner, Node::Text(text) if text == "Title")))
		}));
		// Another heading still closes the open one.
		let nodes = parse("<h1>One<h2>Two</h2>").unwrap();
		let h1 = nodes
			.iter()
			.find_map(|node| match node {
				Node::Tag(tag) if tag.name() == "h1" => Some(tag),
				_ => None,
			})
			.unwrap();
		assert_eq!(h1.children.len(), 1);
	}
}
