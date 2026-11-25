//! Shared HTML preorder arena built on `html5ever`'s tokenizer.
//!
//! Each tag's descendants occupy a contiguous slice in one arena, and adjacent
//! text tokens are merged into one decoded string. Optional HTML end tags
//! (notably `li`, `dt`, `dd`, `tr`, `td`, `th`, `option`, `p`) close
//! implicitly so malformed markup cannot swallow the rest of a page.

use std::{cell::RefCell, ops::Range};

use html5ever::{
	LocalName,
	tendril::StrTendril,
	tokenizer::{
		BufferQueue, CharacterTokens, EndTag, StartTag, Tag, TagToken, Token, TokenSink,
		TokenSinkResult, Tokenizer, states::RawKind,
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
			"p" | "hr" | "div" | "center" | "table" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6"
			| "dl" | "dlc" | "ol" | "ul" | "menu" | "dir" | "pre" | "blockquote" | "bq" => {
				Some((&["p", "h1", "h2", "h3", "h4", "h5", "h6"], &["table", "li", "td", "th"]))
			},
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
	tree.nodes
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
}
