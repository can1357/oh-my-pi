//! Read the Docs (`*.readthedocs.io`, `readthedocs.org`): the page's main
//! content, preferring the raw source its Edit link points at.

use std::{fmt::Write as _, ops::Range};

use url::Url;

use super::{Action, Context, Done, Fetch, Site, fetch, html_to_markdown};
use crate::dom::{self, Element, Node};

/// Registry entry.
pub const SITE: Site = Site { name: "readthedocs", open };

const METHOD: &str = "readthedocs";
/// A raw source body larger than this is not the page's text.
const MAX_SOURCE_BYTES: usize = 1_000_000;
/// Attributes worth carrying into the HTML handed to the Markdown renderer.
const KEPT_ATTRS: [&str; 6] = ["href", "src", "alt", "title", "id", "class"];
/// Classes of chrome removed from the main content.
const REMOVED_CLASSES: [&str; 6] =
	["headerlink", "viewcode-link", "sidebar", "related", "sphinxsidebar", "toctree-wrapper"];
/// Directories a docs root lives in (`docs/`, `doc/source/`, …).
const DOCS_ROOT_DIR: [&str; 6] = ["docs", "doc", "documentation", "source", "src", "content"];

fn open(url: &Url, _: &Context) -> Option<Action> {
	let host = url.host_str()?;
	if !(host.ends_with(".readthedocs.io")
		|| matches!(host, "readthedocs.org" | "www.readthedocs.org"))
	{
		return None;
	}
	let requested = url.clone();
	fetch(Fetch::get(url.as_str()), move |reply, _| {
		let html = reply.body_text()?;
		let final_url = Url::parse(&reply.url).ok().unwrap_or(requested);
		let nodes = dom::parse(&html).ok()?;

		let mut notes: Vec<String> = Vec::new();
		let root = if let Some(index) = main_content(&nodes) {
			Some(index)
		} else {
			notes.push("Using full body content (no main content div found)".to_owned());
			find_body(&nodes)
		};
		let content = root.map_or_else(String::new, |index| {
			let mut html = String::new();
			serialize(&nodes, children(&nodes, index), &mut html);
			html_to_markdown(&html, None).trim().to_owned()
		});

		let page = final_url.path().to_owned();
		let Some(source) = edit_source(&nodes, &page, &mut notes) else {
			return finish(content, notes);
		};
		fetch(Fetch::get(source.clone()), move |reply, _| {
			match reply
				.body_text()
				.filter(|text| !text.is_empty() && text.len() < MAX_SOURCE_BYTES)
			{
				Some(text) => {
					notes.push(format!("Fetched raw source from {source}"));
					let mut done = Done::new(text, METHOD);
					for note in notes {
						done = done.note(note);
					}
					done.finish()
				},
				None => finish(content, notes),
			}
		})
	})
}

/// Finish on the extracted content, or say it could not be extracted.
fn finish(mut content: String, mut notes: Vec<String>) -> Option<Action> {
	if content.is_empty() {
		"No content extracted from Read the Docs page".clone_into(&mut content);
		notes.push("Failed to extract content".to_owned());
	}
	let mut done = Done::new(content, METHOD);
	for note in notes {
		done = done.note(note);
	}
	done.finish()
}

/// The child node range of the element (or text) at `index`.
fn children(nodes: &[Node], index: usize) -> Range<usize> {
	match &nodes[index] {
		Node::Tag(tag) => tag.children.clone(),
		Node::Text(_) => index..index + 1,
	}
}

/// A main-content selector: `.document`, `[role="main"]`, `main`,
/// `.rst-content`, `.body`.
enum Selector {
	Class(&'static str),
	Role,
	Tag(&'static str),
}

const MAIN_SELECTORS: [Selector; 5] = [
	Selector::Class("document"),
	Selector::Role,
	Selector::Tag("main"),
	Selector::Class("rst-content"),
	Selector::Class("body"),
];

fn matches_selector(node: &Node, selector: &Selector) -> bool {
	let Node::Tag(tag) = node else {
		return false;
	};
	match selector {
		Selector::Class(class) => contains_class(tag, class),
		Selector::Role => roles(tag).any(|role| role.eq_ignore_ascii_case("main")),
		Selector::Tag(name) => tag.name() == *name,
	}
}

fn contains_class(tag: &Element, class: &str) -> bool {
	tag.attr("class").is_some_and(|classes| {
		classes
			.split_ascii_whitespace()
			.any(|candidate| candidate == class)
	})
}

fn roles(tag: &Element) -> impl Iterator<Item = &str> {
	tag.attr("role")
		.unwrap_or_default()
		.split_ascii_whitespace()
}

fn find(nodes: &[Node], selector: &Selector) -> Option<usize> {
	(0..nodes.len()).find(|index| matches_selector(&nodes[*index], selector))
}

fn main_content(nodes: &[Node]) -> Option<usize> {
	MAIN_SELECTORS
		.iter()
		.find_map(|selector| find(nodes, selector))
}

fn find_body(nodes: &[Node]) -> Option<usize> {
	find(nodes, &Selector::Tag("body"))
}

/// Navigation, sidebars and footers that are removed from the main content.
fn removed(tag: &Element) -> bool {
	matches!(tag.name(), "nav" | "footer")
		|| REMOVED_CLASSES
			.iter()
			.any(|class| contains_class(tag, class))
}

/// Re-serialize the main content so the Markdown renderer sees only it.
fn serialize(nodes: &[Node], range: Range<usize>, out: &mut String) {
	let mut index = range.start;
	while index < range.end {
		match &nodes[index] {
			Node::Text(text) => {
				escape(text, out);
				index += 1;
			},
			Node::Tag(tag) => {
				if removed(tag) {
					index = tag.children.end;
					continue;
				}
				let _ = write!(out, "<{}", tag.name());
				for key in KEPT_ATTRS {
					if let Some(value) = tag.attr(key) {
						let _ = write!(out, " {key}=\"");
						escape(value, out);
						out.push('"');
					}
				}
				out.push('>');
				serialize(nodes, tag.children.clone(), out);
				let _ = write!(out, "</{}>", tag.name());
				index = tag.children.end;
			},
		}
	}
}

fn escape(text: &str, out: &mut String) {
	for character in text.chars() {
		match character {
			'&' => out.push_str("&amp;"),
			'<' => out.push_str("&lt;"),
			'>' => out.push_str("&gt;"),
			'"' => out.push_str("&quot;"),
			other => out.push(other),
		}
	}
}

/// The raw-source URL of the page's own Edit link, when its repo ref matches
/// the requested documentation version.
fn edit_source(nodes: &[Node], final_path: &str, notes: &mut Vec<String>) -> Option<String> {
	let version = version_slug(final_path);
	let page = doc_path(final_path.split('/').skip(3), Extension::Html);
	for node in nodes {
		let Node::Tag(tag) = node else {
			continue;
		};
		if tag.name() != "a" {
			continue;
		}
		let Some(href) = tag.attr("href") else {
			continue;
		};
		if !(href.contains("github.com") || href.contains("gitlab.com")) {
			continue;
		}
		let mut text = String::new();
		push_text(nodes, tag.children.clone(), &mut text);
		if !text.to_lowercase().contains("edit") {
			continue;
		}
		// A body link can say "edit" too and point at any repository; only the
		// page's own Edit link names the file the page was built from.
		let Some((reference, file)) = source_link(href) else {
			continue;
		};
		if !builds_page(&doc_path(file.split('/'), Extension::Source), &page) {
			continue;
		}
		let matches_version = version
			.as_deref()
			.is_some_and(|slug| matches!(slug, "latest" | "stable") || slug == reference);
		if !matches_version {
			notes.push(format!(
				"Skipped raw source from {href}: repository ref does not match documentation version \
				 {}",
				version.as_deref().unwrap_or("(unknown)")
			));
			continue;
		}
		return Some(
			href
				.replacen("/blob/", "/raw/", 1)
				.replacen("/edit/", "/raw/", 1),
		);
	}
	None
}

/// The `(ref, path)` of a `/blob/…`, `/raw/…` or `/edit/…` URL.
fn source_link(href: &str) -> Option<(&str, &str)> {
	let marker = ["/blob/", "/raw/", "/edit/"]
		.iter()
		.filter_map(|marker| href.find(marker).map(|at| (at, marker.len())))
		.min_by_key(|(at, _)| *at)?;
	let rest = href.get(marker.0 + marker.1..)?;
	let slash = rest.find('/')?;
	let reference = &rest[..slash];
	let file = rest[slash + 1..].split(['#', '?']).next().unwrap_or("");
	(!reference.is_empty() && !file.is_empty()).then_some((reference, file))
}

fn push_text(nodes: &[Node], range: Range<usize>, out: &mut String) {
	let mut index = range.start;
	while index < range.end {
		match &nodes[index] {
			Node::Text(text) => {
				out.push_str(text);
				index += 1;
			},
			Node::Tag(tag) => {
				push_text(nodes, tag.children.clone(), out);
				index = tag.children.end;
			},
		}
	}
}

/// The requested docs version is the second path segment (`/<lang>/<slug>/…`).
fn version_slug(path: &str) -> Option<String> {
	let parts: Vec<&str> = path.split('/').collect();
	let [_, language, version, _, ..] = parts.as_slice() else {
		return None;
	};
	(!language.is_empty() && !version.is_empty()).then(|| (*version).to_owned())
}

/// A page path without the file extension or a trailing index/README.
struct DocPath {
	/// Decoded path segments.
	segments: Vec<String>,
	/// The path named an index or README file (or the docs root).
	index:    bool,
}

#[derive(Clone, Copy)]
enum Extension {
	/// Builders name output files `.html`.
	Html,
	/// Source files carry any extension.
	Source,
}

fn doc_path<'a>(segments: impl Iterator<Item = &'a str>, extension: Extension) -> DocPath {
	let mut parts: Vec<String> = segments
		.filter(|segment| !segment.is_empty())
		.map(percent_decode)
		.collect();
	let last = parts
		.pop()
		.map(|segment| strip_extension(&segment, extension));
	let index = last
		.as_ref()
		.is_none_or(|last| last.eq_ignore_ascii_case("index") || last.eq_ignore_ascii_case("readme"));
	if !index && let Some(last) = last {
		parts.push(last);
	}
	DocPath { segments: parts, index }
}

fn strip_extension(segment: &str, extension: Extension) -> String {
	match extension {
		Extension::Html => {
			for suffix in [".html", ".htm"] {
				if let Some(head) = segment
					.len()
					.checked_sub(suffix.len())
					.map(|length| &segment[..length])
					&& segment[head.len()..].eq_ignore_ascii_case(suffix)
				{
					return head.to_owned();
				}
			}
			segment.to_owned()
		},
		Extension::Source => segment.rfind('.').map_or_else(
			|| segment.to_owned(),
			|dot| {
				if dot + 1 == segment.len() {
					segment.to_owned()
				} else {
					segment[..dot].to_owned()
				}
			},
		),
	}
}

/// A page at `docs/a/b` builds from `a/b.md`, `a/b/index.rst`, …, under any
/// docs root in the repository.
fn builds_page(source: &DocPath, page: &DocPath) -> bool {
	if page.segments.is_empty() {
		return source.index
			&& source.segments.iter().all(|segment| {
				DOCS_ROOT_DIR
					.iter()
					.any(|root| root.eq_ignore_ascii_case(segment))
			});
	}
	let Some(offset) = source.segments.len().checked_sub(page.segments.len()) else {
		return false;
	};
	page
		.segments
		.iter()
		.enumerate()
		.all(|(index, segment)| source.segments[offset + index] == *segment)
}

fn percent_decode(segment: &str) -> String {
	let bytes = segment.as_bytes();
	let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
	let mut index = 0;
	while index < bytes.len() {
		match (
			bytes[index],
			bytes.get(index + 1).copied().and_then(hex),
			bytes.get(index + 2).copied().and_then(hex),
		) {
			(b'%', Some(high), Some(low)) => {
				out.push(high * 16 + low);
				index += 3;
			},
			(byte, ..) => {
				out.push(byte);
				index += 1;
			},
		}
	}
	String::from_utf8_lossy(&out).into_owned()
}

fn hex(byte: u8) -> Option<u8> {
	(byte as char).to_digit(16).map(|digit| digit as u8)
}

#[cfg(test)]
mod tests {
	use super::super::{Fetched, testing::run};

	const PAGE: &str = "https://niquests.readthedocs.io/en/v3.18.5/user/quickstart.html";
	const PAGE_DIR: &str = "https://niquests.readthedocs.io/en/latest/misc/deployment/";
	const QUICKSTART: &str = "<html><body><div class=\"document\"><h1>Quickstart</h1><p>Versioned \
	                          v3.18.5 quickstart content.</p></div><a href=\"{HREF}\">Edit on \
	                          GitHub</a></body></html>";

	fn page(href: &str) -> String {
		QUICKSTART.replace("{HREF}", href)
	}

	#[test]
	fn falls_back_to_the_page_when_the_edit_link_targets_another_branch() {
		let mut requests = 0;
		let done = run(PAGE, |request| {
			requests += 1;
			if request.url.contains("github.com") {
				Fetched::text("text/plain", "MAIN BRANCH RST SOURCE")
			} else {
				Fetched::text(
					"text/html",
					page("https://github.com/jawah/niquests/blob/main/docs/user/quickstart.rst"),
				)
			}
		})
		.unwrap();
		assert_eq!(requests, 1);
		assert_eq!(done.method, "readthedocs");
		assert!(done.markdown.contains("Versioned v3.18.5"));
		assert!(!done.markdown.contains("MAIN BRANCH RST SOURCE"));
		assert!(!done.notes.join("\n").contains("Fetched raw source"));
		assert!(
			done
				.notes
				.join("\n")
				.contains("repository ref does not match documentation version v3.18.5")
		);
	}

	#[test]
	fn fetches_raw_source_when_the_edit_link_ref_matches_the_version() {
		let mut requests = Vec::new();
		let done = run(PAGE, |request| {
			requests.push(request.url.clone());
			if request.url.contains("github.com") {
				Fetched::text("text/plain", "VERSIONED RAW SOURCE")
			} else {
				Fetched::text(
					"text/html",
					page("https://github.com/jawah/niquests/blob/v3.18.5/docs/user/quickstart.rst"),
				)
			}
		})
		.unwrap();
		assert_eq!(requests, [
			PAGE.to_owned(),
			"https://github.com/jawah/niquests/raw/v3.18.5/docs/user/quickstart.rst".to_owned()
		]);
		assert_eq!(done.markdown, "VERSIONED RAW SOURCE");
		assert_eq!(done.notes, ["Fetched raw source from https://github.com/jawah/niquests/raw/v3.18.5/docs/user/quickstart.rst"]);
	}

	#[test]
	fn floating_latest_versions_take_any_ref() {
		let done = run("https://niquests.readthedocs.io/en/latest/user/quickstart.html", |request| {
			if request.url.contains("github.com") {
				Fetched::text("text/plain", "MAIN BRANCH RST SOURCE")
			} else {
				Fetched::text(
					"text/html",
					page("https://github.com/jawah/niquests/blob/main/docs/user/quickstart.rst"),
				)
			}
		})
		.unwrap();
		assert_eq!(done.notes, ["Fetched raw source from https://github.com/jawah/niquests/raw/main/docs/user/quickstart.rst"]);
	}

	#[test]
	fn ignores_body_links_to_another_repositorys_files() {
		let html = "<html><body><div class=\"document\"><h1>Deployment</h1><p>Deploy with the <a href=\"https://github.com/mother-of-all-self-hosting/mash-playbook/blob/main/docs/supported-services.md\">wide variety of open-source services</a> playbook.</p></div></body></html>";
		let mut requests = 0;
		let done = run(PAGE_DIR, |_| {
			requests += 1;
			Fetched::text("text/html", html)
		})
		.unwrap();
		assert_eq!(requests, 1);
		assert!(done.markdown.contains("Deploy with the"));
		assert!(!done.markdown.contains("UNRELATED REPOSITORY FILE"));
	}

	#[test]
	fn fetches_the_index_source_for_the_docs_root_page() {
		let done = run("https://niquests.readthedocs.io/en/latest/", |request| {
			if request.url.contains("github.com") {
				Fetched::text("text/plain", "INDEX RST SOURCE")
			} else {
				Fetched::text(
					"text/html",
					page("https://github.com/jawah/niquests/blob/main/docs/index.rst"),
				)
			}
		})
		.unwrap();
		assert_eq!(done.markdown, "INDEX RST SOURCE");
	}

	#[test]
	fn ignores_a_subsection_index_edit_link_on_the_docs_root_page() {
		let mut requests = 0;
		let done = run("https://niquests.readthedocs.io/en/latest/", |_| {
			requests += 1;
			Fetched::text(
				"text/html",
				page("https://github.com/other/project/blob/main/docs/subsection/index.rst"),
			)
		})
		.unwrap();
		assert_eq!(requests, 1);
		assert!(done.markdown.contains("Versioned v3.18.5"));
	}

	#[test]
	fn matches_a_percent_encoded_page_path() {
		let done = run(
			"https://jupyter-notebook.readthedocs.io/en/latest/examples/Importing%20Notebooks.html",
			|request| {
				if request.url.contains("github.com") {
					Fetched::text("text/plain", "NOTEBOOK SOURCE")
				} else {
					Fetched::text(
						"text/html",
						page(
							"https://github.com/jupyter/notebook/edit/main/docs/source/examples/\
							 Importing Notebooks.ipynb",
						),
					)
				}
			},
		)
		.unwrap();
		assert_eq!(done.markdown, "NOTEBOOK SOURCE");
	}

	#[test]
	fn keeps_dots_in_a_directory_style_page_name() {
		let done =
			run("https://niquests.readthedocs.io/en/latest/reference/package.module/", |request| {
				if request.url.contains("github.com") {
					Fetched::text("text/plain", "MODULE RST SOURCE")
				} else {
					Fetched::text(
					"text/html",
					page("https://github.com/jawah/niquests/blob/main/docs/reference/package.module.rst"),
				)
				}
			})
			.unwrap();
		assert_eq!(done.markdown, "MODULE RST SOURCE");
	}

	#[test]
	fn other_hosts_and_failed_pages_fall_through() {
		assert_eq!(run("https://example.test/docs/", |_| panic!("no fetch expected")), None);
		assert_eq!(run(PAGE, |_| Fetched::status(404)), None);
	}
}
