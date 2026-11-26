//! Selectors from Trafilatura 2.0.0 (`xpaths.py`): marked article bodies (the
//! first `BODY_XPATH` query) and comment sections (`COMMENTS_XPATH`).
//! Copyright (c) 2024 Adrien Barbaresi; Apache-2.0 (see
//! packages/natives/THIRD-PARTY-NOTICES.txt).

use self::{Attribute::*, Match::*};
use crate::dom::Element;

#[derive(Clone, Copy)]
enum Attribute {
	Class,
	Id,
	ItemProp,
	/// The id or the class.
	IdClass,
}

#[derive(Clone, Copy)]
enum Match {
	Exact,
	Contains,
	StartsWith,
	ContainsFolded(&'static [u8]),
}

#[derive(Clone, Copy)]
struct Rule(Attribute, Match, &'static str);

pub(super) struct Selector {
	tags:  &'static [&'static str],
	rules: &'static [Rule],
}

impl Selector {
	fn matches(&self, tag: &Element) -> bool {
		let name = tag.name();
		// XPath `list` names any list element.
		let list = matches!(name, "ul" | "ol" | "dl");
		(self.tags.contains(&name) || (list && self.tags.contains(&"list")))
			&& self.rules.iter().any(|&Rule(attribute, kind, needle)| {
				let test = |key: &str| {
					tag.attr(key)
						.is_some_and(|value| kind.matches(value, needle))
				};
				match attribute {
					Class => test("class"),
					Id => test("id"),
					ItemProp => test("itemprop"),
					IdClass => test("id") || test("class"),
				}
			})
	}
}

impl Match {
	fn matches(self, text: &str, needle: &str) -> bool {
		match self {
			Exact => text == needle,
			Contains => text.contains(needle),
			StartsWith => text.starts_with(needle),
			ContainsFolded(caps) => {
				text.contains(needle)
					|| (text.bytes().any(|byte| caps.contains(&byte))
						&& text
							.as_bytes()
							.windows(needle.len())
							.any(|part| folded_eq(part, needle.as_bytes(), caps)))
			},
		}
	}
}

// XPath translate() only lowercases the explicitly enumerated ASCII letters.
fn folded_eq(text: &[u8], needle: &[u8], caps: &[u8]) -> bool {
	text.iter().zip(needle).all(|(&left, &right)| {
		left == right || (caps.contains(&left) && left.to_ascii_lowercase() == right)
	})
}

pub(super) fn matches_any(selectors: &[Selector], tag: &Element) -> bool {
	selectors.iter().any(|selector| selector.matches(tag))
}

pub(super) const COMMENTS: &[Selector] = &[
	Selector {
		tags:  &["div", "list", "section"],
		rules: &[
			Rule(IdClass, Contains, "commentlist"),
			Rule(Class, Contains, "comment-page"),
			Rule(IdClass, Contains, "comment-list"),
			Rule(Class, Contains, "comments-content"),
			Rule(Class, Contains, "post-comments"),
		],
	},
	Selector {
		tags:  &["div", "section", "list"],
		rules: &[
			Rule(IdClass, StartsWith, "comments"),
			Rule(Class, StartsWith, "Comments"),
			Rule(IdClass, StartsWith, "comment-"),
			Rule(Class, Contains, "article-comments"),
		],
	},
	Selector {
		tags:  &["div", "section", "list"],
		rules: &[
			Rule(Id, StartsWith, "comol"),
			Rule(Id, StartsWith, "disqus_thread"),
			Rule(Id, StartsWith, "dsq-comments"),
		],
	},
	Selector {
		tags:  &["div", "section"],
		rules: &[Rule(Id, StartsWith, "social"), Rule(Class, Contains, "comment")],
	},
];

pub(super) const MARKED_BODY: &[Selector] = &[Selector {
	tags:  &["article", "div", "main", "section"],
	rules: &[
		Rule(Class, Exact, "post"),
		Rule(Class, Exact, "entry"),
		Rule(Class, Contains, "post-text"),
		Rule(Class, Contains, "post_text"),
		Rule(Class, Contains, "post-body"),
		Rule(Class, Contains, "post-entry"),
		Rule(Class, Contains, "postentry"),
		Rule(Class, Contains, "post-content"),
		Rule(Class, Contains, "post_content"),
		Rule(Class, Contains, "postcontent"),
		Rule(Class, Contains, "postContent"),
		Rule(Class, Contains, "post_inner_wrapper"),
		Rule(Class, Contains, "article-text"),
		Rule(Class, Contains, "articletext"),
		Rule(Class, Contains, "articleText"),
		Rule(Id, Contains, "entry-content"),
		Rule(Class, Contains, "entry-content"),
		Rule(Id, Contains, "article-content"),
		Rule(Class, Contains, "article-content"),
		Rule(Id, Contains, "article__content"),
		Rule(Class, Contains, "article__content"),
		Rule(Id, Contains, "article-body"),
		Rule(Class, Contains, "article-body"),
		Rule(Id, Contains, "article__body"),
		Rule(Class, Contains, "article__body"),
		Rule(ItemProp, Exact, "articleBody"),
		Rule(Id, ContainsFolded(b"B"), "articlebody"),
		Rule(Class, ContainsFolded(b"B"), "articlebody"),
		Rule(Id, Exact, "articleContent"),
		Rule(Class, Contains, "ArticleContent"),
		Rule(Class, Contains, "page-content"),
		Rule(Class, Contains, "text-content"),
		Rule(Id, Contains, "body-text"),
		Rule(Class, Contains, "body-text"),
		Rule(Class, Contains, "article__container"),
		Rule(Id, Contains, "art-content"),
		Rule(Class, Contains, "art-content"),
	],
}];
