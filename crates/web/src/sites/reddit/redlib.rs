//! Parse the mirror's post and comment cards from the shared HTML arena.

use std::{borrow::Cow, ops::Range};

use super::{
	super::iso_date, Comment, Comments, Done, Entry, Post, Target, ThreadLink, absolute, listing,
	thread,
};
use crate::{
	Hidden,
	dom::{self, Element, Node},
	select::{self, Selection},
	write::markdown,
};

pub(super) fn page(html: &str, target: &Target) -> Option<Done> {
	let nodes = dom::parse(html).ok()?;
	let mut html = Redlib { nodes: &nodes, selection: None };
	let root = 0..nodes.len();
	if let Some(focus) =
		elements(&nodes, root.clone()).find(|tag| class(tag, "post") && class(tag, "highlighted"))
	{
		let mut post = post(&nodes, focus);
		let body = by_class(&nodes, focus, "post_body").and_then(|body| by_class(&nodes, body, "md"));
		post.body = html.markdown(body);
		let comments = elements(&nodes, root)
			.filter(|tag| class(tag, "thread"))
			.flat_map(|thread| children(&nodes, thread))
			.filter(|tag| class(tag, "comment"))
			.map(|comment| html.comment(comment, true).0)
			.collect();
		return Some(thread(post, Comments { visible: comments, hidden: 0 }, target));
	}
	listing(
		target,
		elements(&nodes, root).filter_map(|tag| {
			if class(tag, "post") {
				return Some(Entry::Post(post(&nodes, tag)));
			}
			if class(tag, "user-comment") {
				let (mut comment, link) = html.comment(tag, false);
				// Redlib omits the author from a user's own comment entries.
				if comment.author.is_empty() {
					comment.author = target.user.as_deref().unwrap_or("[unknown]").into();
				}
				return Some(Entry::Comment(comment, link));
			}
			None
		}),
	)
}

fn post<'a>(nodes: &'a [Node], card: &Element) -> Post<'a> {
	let heading = by_class(nodes, card, "post_title");
	let flair = heading.and_then(|tag| by_class(nodes, tag, "post_flair"));
	let title_link = heading.and_then(|tag| {
		elements(nodes, tag.children.clone()).find(|candidate| {
			candidate.name() == "a"
				&& flair.is_none_or(|flair| {
					!(flair.index()..flair.children.end).contains(&candidate.index())
				})
		})
	});
	let header = by_class(nodes, card, "post_header");
	let title = heading.map_or_else(String::new, |tag| text(nodes, tag, flair));
	let link = elements(nodes, card.children.clone()).find(|tag| tag.attr("id") == Some("post_url"));
	Post {
		title: title.into(),
		author: prefixed_text(nodes, by_class(nodes, card, "post_author"), "u/").into(),
		subreddit: prefixed_text(nodes, by_class(nodes, card, "post_subreddit"), "r/").into(),
		permalink: absolute(
			title_link
				.and_then(|tag| tag.attr("href"))
				.unwrap_or_default(),
		),
		score: number(by_class(nodes, card, "post_score")),
		comments: number(by_class(nodes, card, "post_comments")),
		date: date(header.and_then(|tag| by_class(nodes, tag, "created"))),
		link: link.and_then(|tag| tag.attr("href")).unwrap_or_default(),
		flair: flair
			.map_or_else(String::new, |tag| text(nodes, tag, None))
			.into(),
		..Post::default()
	}
}

struct Redlib<'a> {
	nodes:     &'a [Node],
	selection: Option<Selection>,
}

impl<'a> Redlib<'a> {
	fn markdown(&mut self, element: Option<&Element>) -> Cow<'a, str> {
		let Some(element) = element else {
			return Cow::Borrowed("");
		};
		let selection = self
			.selection
			.get_or_insert_with(|| select::full(self.nodes, Hidden::Drop));
		selection.root = element.children.clone();
		markdown::write(self.nodes, selection, None, true).into()
	}

	fn comment(&mut self, card: &'a Element, with_replies: bool) -> (Comment<'a>, ThreadLink<'a>) {
		let nodes = self.nodes;
		let details = child(nodes, Some(card), "comment_right");
		let summary = child(nodes, details, "comment_data");
		let author = summary.and_then(|tag| by_class(nodes, tag, "comment_author"));
		let left = child(nodes, Some(card), "comment_left");
		// The DOM closes the wrapper <p> before the user page's <div class="md">.
		let body = child(nodes, details, "comment_body")
			.and_then(|tag| by_class(nodes, tag, "md"))
			.or_else(|| child(nodes, details, "md"));
		let body = self.markdown(body);
		let replies = if with_replies {
			child(nodes, details, "replies")
				.into_iter()
				.flat_map(|tag| children(nodes, tag))
				.filter(|tag| class(tag, "comment"))
				.map(|tag| self.comment(tag, true).0)
				.collect()
		} else {
			Vec::new()
		};
		let comment = Comment {
			author: prefixed_text(nodes, author, "u/").into(),
			body,
			score: number(left.and_then(|tag| by_class(nodes, tag, "comment_score"))),
			date: date(summary.and_then(|tag| by_class(nodes, tag, "created"))),
			is_op: author.is_some_and(|tag| class(tag, "op")),
			replies: Comments { visible: replies, hidden: 0 },
		};
		let link = summary
			.filter(|_| !with_replies)
			.and_then(|summary| {
				let link = by_class(nodes, summary, "comment_link")?;
				Some(ThreadLink {
					title:     text(nodes, link, None).into(),
					subreddit: prefixed_text(nodes, by_class(nodes, summary, "comment_subreddit"), "r/")
						.into(),
					permalink: absolute(link.attr("href").unwrap_or_default()),
				})
			})
			.unwrap_or_default();
		(comment, link)
	}
}

fn class(tag: &Element, class: &str) -> bool {
	tag.attr("class")
		.is_some_and(|classes| classes.split_ascii_whitespace().any(|name| name == class))
}

fn elements(nodes: &[Node], range: Range<usize>) -> impl Iterator<Item = &Element> {
	nodes[range].iter().filter_map(|node| match node {
		Node::Tag(tag) => Some(tag),
		Node::Text(_) => None,
	})
}

fn by_class<'a>(nodes: &'a [Node], parent: &Element, name: &str) -> Option<&'a Element> {
	elements(nodes, parent.children.clone()).find(|tag| class(tag, name))
}

fn children<'a>(
	nodes: &'a [Node],
	parent: &Element,
) -> impl Iterator<Item = &'a Element> + use<'a> {
	let mut index = parent.children.start;
	let end = parent.children.end;
	std::iter::from_fn(move || {
		while index < end {
			match &nodes[index] {
				Node::Tag(tag) => {
					index = tag.children.end;
					return Some(tag);
				},
				Node::Text(_) => index += 1,
			}
		}
		None
	})
}

fn child<'a>(nodes: &'a [Node], parent: Option<&Element>, name: &str) -> Option<&'a Element> {
	children(nodes, parent?).find(|tag| class(tag, name))
}

fn text(nodes: &[Node], tag: &Element, omit: Option<&Element>) -> String {
	let mut out = String::new();
	let mut index = tag.children.start;
	let mut space = false;
	while index < tag.children.end {
		if let Some(omit) = omit.filter(|omit| index == omit.index()) {
			index = omit.children.end;
			continue;
		}
		if let Node::Text(text) = &nodes[index] {
			for ch in text.chars() {
				if ch.is_whitespace() {
					space = !out.is_empty();
				} else {
					if space {
						out.push(' ');
						space = false;
					}
					out.push(ch);
				}
			}
		}
		index += 1;
	}
	out
}

fn prefixed_text(nodes: &[Node], tag: Option<&Element>, prefix: &str) -> String {
	let mut value = tag.map_or_else(String::new, |tag| text(nodes, tag, None));
	if value.starts_with(prefix) {
		drop(value.drain(..prefix.len()));
	}
	value
}

// Redlib abbreviates the visible score and date; the title attributes contain
// the exact values.
fn number(tag: Option<&Element>) -> Option<i64> {
	let value = tag?.attr("title")?.trim_start();
	let sign = usize::from(value.starts_with(['+', '-']));
	let end = sign
		+ value
			.bytes()
			.skip(sign)
			.take_while(u8::is_ascii_digit)
			.count();
	value[..end].parse().ok()
}

fn date(tag: Option<&Element>) -> String {
	fn parse(date: &str) -> Option<String> {
		if let Some(iso) = iso_date(date) {
			return Some(iso.to_owned());
		}
		// Redlib emits absolute UTC timestamps such as `Mar 19 2026, 10:16:44
		// UTC`.
		let (date, _) = date.split_once(',')?;
		let mut parts = date.split_ascii_whitespace();
		let month = match parts.next()? {
			"Jan" => 1,
			"Feb" => 2,
			"Mar" => 3,
			"Apr" => 4,
			"May" => 5,
			"Jun" => 6,
			"Jul" => 7,
			"Aug" => 8,
			"Sep" => 9,
			"Oct" => 10,
			"Nov" => 11,
			"Dec" => 12,
			_ => return None,
		};
		let day = parts
			.next()?
			.parse::<u8>()
			.ok()
			.filter(|day| (1..=31).contains(day))?;
		let year = parts.next()?.parse::<u16>().ok()?;
		Some(format!("{year:04}-{month:02}-{day:02}"))
	}
	tag.and_then(|tag| tag.attr("title"))
		.and_then(parse)
		.unwrap_or_default()
}
