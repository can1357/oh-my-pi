//! pkg.go.dev (`pkg.go.dev/<module>[@<version>]`): the module's published
//! version from the Go module proxy, then the package page's synopsis,
//! documentation, index and imports.

use std::{fmt::Write as _, ops::Range};

use serde_json::Value;
use url::Url;

use super::{Action, Context, Done, Fetch, Site, fetch, html_to_markdown, segment, str_of};
use crate::dom::{self, Element, Node};

/// Registry entry.
pub const SITE: Site = Site { name: "go-pkg", open };

const METHOD: &str = "go-pkg";
const PROXY: &str = "https://proxy.golang.org";
/// Exports listed before eliding.
const EXPORTS: usize = 50;
/// Imports listed before eliding.
const IMPORTS: usize = 20;
/// Documentation paragraphs rendered.
const PARAGRAPHS: usize = 3;

fn open(url: &Url, _: &Context) -> Option<Action> {
	if url.host_str()? != "pkg.go.dev" {
		return None;
	}
	let path = url
		.path()
		.strip_prefix('/')
		.filter(|path| !path.is_empty())?
		.to_owned();
	let (module, version) = split_version(&path);
	// Standard-library packages (`net/http`, `fmt`: no dot in the first path
	// element) belong to module `std`, which the module proxy does not serve.
	let standard_library = !module.split('/').next().unwrap_or_default().contains('.');
	let page = url.as_str().to_owned();
	if standard_library {
		return page_action(page, "std".to_owned(), version, None, true);
	}
	let latest = version == "latest";
	let proxy = if latest {
		Fetch::get(format!("{PROXY}/{}/@latest", segment(&module))).accept_json()
	} else {
		Fetch::get(format!("{PROXY}/{}/@v/{}.info", segment(&module), segment(&version)))
			.accept_json()
	};
	fetch(proxy, move |reply, _| {
		// A failed or unreadable lookup leaves the page's version chip to name
		// it.
		let info = reply.json_value();
		let version = if latest {
			info
				.as_ref()
				.and_then(|info| str_of(info, "Version"))
				.map_or(version, str::to_owned)
		} else {
			version
		};
		page_action(page, module, version, info, false)
	})
}

/// Module path and requested version of a pkg.go.dev path.
fn split_version(path: &str) -> (String, String) {
	match path.split_once('@') {
		Some((module, rest)) => {
			(module.to_owned(), rest.split('/').next().unwrap_or(rest).to_owned())
		},
		None => (path.to_owned(), "latest".to_owned()),
	}
}

fn page_action(
	page: String,
	module: String,
	version: String,
	info: Option<Value>,
	standard_library: bool,
) -> Option<Action> {
	fetch(Fetch::get(page), move |reply, _| {
		let html = reply.body_text()?;
		let (title, markdown, mut notes) =
			read_page(&html, &module, &version, info.as_ref(), standard_library)?;
		if let Some(info) = info.as_ref() {
			notes.push(format!(
				"published {}",
				info.get("Time").and_then(Value::as_str).unwrap_or_default()
			));
		}
		let mut done = Done::new(markdown, METHOD).title(title);
		for note in notes {
			done = done.note(note);
		}
		done.finish()
	})
}

/// Title, Markdown and notes of a package page.
fn read_page(
	html: &str,
	module: &str,
	version: &str,
	info: Option<&Value>,
	standard_library: bool,
) -> Option<(String, String, Vec<String>)> {
	let nodes = dom::parse(html).ok()?;
	let mut notes = Vec::new();

	let module = actual_module(&nodes, module, standard_library);
	let version = named_version(&nodes, version, info.is_some());
	let license = license(&nodes);
	let import_path = import_path(&nodes, &module);

	let mut sections = header(&import_path, &module, &version, &license);
	synopsis(&nodes, &mut sections);
	documentation(&nodes, &mut sections);
	index(&nodes, &mut sections, &mut notes);
	imports(&nodes, &mut sections, &mut notes);
	Some((import_path, sections.join("\n"), notes))
}

/// The module the breadcrumb names, which is where a subpackage belongs.
fn actual_module(nodes: &[Node], module: &str, standard_library: bool) -> String {
	if standard_library {
		return module.to_owned();
	}
	find_tag(nodes, 0..nodes.len(), |element| has_class(element, "go-Breadcrumb"))
		.and_then(|(_, breadcrumb)| {
			find_tag(nodes, breadcrumb.children.clone(), |element| {
				element.name() == "a"
					&& element
						.attr("href")
						.is_some_and(|href| href.starts_with('/'))
			})
		})
		.and_then(|(_, link)| link.attr("href"))
		.map_or_else(
			|| module.to_owned(),
			|href| {
				href
					.trim_start_matches('/')
					.split('@')
					.next()
					.unwrap_or_default()
					.to_owned()
			},
		)
}

/// The page's version chip (`go1.x` for a standard-library package) when the
/// proxy did not name the version.
fn named_version(nodes: &[Node], version: &str, known: bool) -> String {
	if known {
		return version.to_owned();
	}
	find_tag(nodes, 0..nodes.len(), |element| has_class(element, "go-Chip"))
		.map(|(_, chip)| text_of(nodes, chip.children.clone()))
		.map(|text| text.trim().to_owned())
		.filter(|text| text.starts_with('v') || text.starts_with("go"))
		.unwrap_or_else(|| version.to_owned())
}

fn license(nodes: &[Node]) -> String {
	find_tag(nodes, 0..nodes.len(), |element| {
		element.attr("data-test-id") == Some("UnitHeader-license")
	})
	.map(|(_, element)| text_of(nodes, element.children.clone()).trim().to_owned())
	.filter(|license| !license.is_empty())
	.unwrap_or_else(|| "Unknown".to_owned())
}

fn import_path(nodes: &[Node], module: &str) -> String {
	find_tag(nodes, 0..nodes.len(), |element| {
		element.name() == "input" && element.attr("data-test-id") == Some("UnitHeader-importPath")
	})
	.and_then(|(_, element)| element.attr("value"))
	.filter(|value| !value.is_empty())
	.map_or_else(|| module.to_owned(), str::to_owned)
}

fn header(import_path: &str, module: &str, version: &str, license: &str) -> Vec<String> {
	vec![
		format!("# {import_path}"),
		String::new(),
		format!("**Module:** {module}"),
		format!("**Version:** {version}"),
		format!("**License:** {license}"),
		String::new(),
	]
}

fn synopsis(nodes: &[Node], sections: &mut Vec<String>) {
	let Some((_, header)) =
		find_tag(nodes, 0..nodes.len(), |element| has_class(element, "go-Main-headerContent"))
	else {
		return;
	};
	let Some((_, paragraph)) =
		find_tag(nodes, header.children.clone(), |element| element.name() == "p")
	else {
		return;
	};
	let synopsis = text_of(nodes, paragraph.children.clone()).trim().to_owned();
	if synopsis.is_empty() {
		return;
	}
	sections.push("## Synopsis".to_owned());
	sections.push(String::new());
	sections.push(synopsis);
	sections.push(String::new());
}

fn documentation(nodes: &[Node], sections: &mut Vec<String>) {
	let Some((_, section)) = find_tag(nodes, 0..nodes.len(), |element| {
		element.attr("id") == Some("section-documentation")
	}) else {
		return;
	};
	sections.push("## Documentation".to_owned());
	sections.push(String::new());

	if let Some((_, message)) =
		find_tag(nodes, section.children.clone(), |element| has_class(element, "go-Message"))
	{
		let overview = html_to_markdown(&inner_html(nodes, message.children.clone()), None);
		sections.push(overview.trim().to_owned());
		sections.push(String::new());
	}

	let Some((_, content)) = find_tag(nodes, section.children.clone(), |element| {
		has_class(element, "Documentation-content")
	}) else {
		return;
	};
	let mut parts = Vec::new();
	for (_, paragraph) in find_all(nodes, content.children.clone(), |element| element.name() == "p")
		.into_iter()
		.take(PARAGRAPHS)
	{
		let text = html_to_markdown(&inner_html(nodes, paragraph.children.clone()), None);
		let text = text.trim();
		if !text.is_empty() {
			parts.push(text.to_owned());
		}
	}
	if !parts.is_empty() {
		sections.push(parts.join("\n\n"));
		sections.push(String::new());
	}
}

fn index(nodes: &[Node], sections: &mut Vec<String>, notes: &mut Vec<String>) {
	let Some((_, section)) =
		find_tag(nodes, 0..nodes.len(), |element| element.attr("id") == Some("section-index"))
	else {
		return;
	};
	let Some((_, list)) = find_tag(nodes, section.children.clone(), |element| {
		has_class(element, "Documentation-indexList")
	}) else {
		return;
	};
	sections.push("## Index".to_owned());
	sections.push(String::new());

	let mut exports = Vec::new();
	for (_, item) in find_all(nodes, list.children.clone(), |element| element.name() == "li") {
		let Some((_, link)) = find_tag(nodes, item.children.clone(), |element| element.name() == "a")
		else {
			continue;
		};
		let name = text_of(nodes, link.children.clone());
		let name = name.trim();
		if !name.is_empty() {
			exports.push(format!("- {name}"));
		}
	}
	if exports.is_empty() {
		return;
	}
	let total = exports.len();
	sections.push(
		exports
			.iter()
			.take(EXPORTS)
			.cloned()
			.collect::<Vec<_>>()
			.join("\n"),
	);
	if total > EXPORTS {
		notes.push(format!("showing {EXPORTS} of {total} exports"));
		sections.push(format!("\n[…{} exports elided…]", total - EXPORTS));
	}
	sections.push(String::new());
}

fn imports(nodes: &[Node], sections: &mut Vec<String>, notes: &mut Vec<String>) {
	let Some((_, section)) =
		find_tag(nodes, 0..nodes.len(), |element| element.attr("id") == Some("section-imports"))
	else {
		return;
	};
	let Some((_, list)) =
		find_tag(nodes, section.children.clone(), |element| has_class(element, "go-Message"))
	else {
		return;
	};
	sections.push("## Imports".to_owned());
	sections.push(String::new());

	let mut imports = Vec::new();
	for (_, link) in find_all(nodes, list.children.clone(), |element| element.name() == "a") {
		let name = text_of(nodes, link.children.clone());
		let name = name.trim();
		if !name.is_empty() {
			imports.push(format!("- {name}"));
		}
	}
	if imports.is_empty() {
		return;
	}
	let total = imports.len();
	sections.push(
		imports
			.iter()
			.take(IMPORTS)
			.cloned()
			.collect::<Vec<_>>()
			.join("\n"),
	);
	if total > IMPORTS {
		notes.push(format!("showing {IMPORTS} of {total} imports"));
		sections.push(format!("\n[…{} imports elided…]", total - IMPORTS));
	}
	sections.push(String::new());
}

/// Elements of `range` in document order, with their arena index.
fn elements(nodes: &[Node], range: Range<usize>) -> impl Iterator<Item = (usize, &Element)> + '_ {
	range.filter_map(move |index| match &nodes[index] {
		Node::Tag(element) => Some((index, element)),
		Node::Text(_) => None,
	})
}

/// First element of `range` matching `predicate`.
fn find_tag(
	nodes: &[Node],
	range: Range<usize>,
	predicate: impl Fn(&Element) -> bool,
) -> Option<(usize, &Element)> {
	elements(nodes, range).find(|(_, element)| predicate(element))
}

/// Every element of `range` matching `predicate`, in document order.
fn find_all(
	nodes: &[Node],
	range: Range<usize>,
	predicate: impl Fn(&Element) -> bool,
) -> Vec<(usize, &Element)> {
	elements(nodes, range)
		.filter(|(_, element)| predicate(element))
		.collect()
}

/// Whole-class match, as a `.class` selector does.
fn has_class(element: &Element, class: &str) -> bool {
	element
		.attr("class")
		.is_some_and(|classes| classes.split_whitespace().any(|name| name == class))
}

/// Text of `range`, the `textContent` of the element owning it.
fn text_of(nodes: &[Node], range: Range<usize>) -> String {
	let mut out = String::new();
	for node in &nodes[range] {
		if let Node::Text(text) = node {
			out.push_str(text);
		}
	}
	out
}

/// HTML of `range`, so an HTML fragment can be rendered as Markdown. The arena
/// keeps attributes behind key lookups, so links and images are serialized with
/// the attributes Markdown rendering needs.
fn inner_html(nodes: &[Node], range: Range<usize>) -> String {
	let mut out = String::new();
	for node in &nodes[range] {
		write_node(nodes, node, &mut out);
	}
	out
}

/// Appends `text` with the characters HTML text needs escaped: `&`, `<`, `>`.
fn encode_text_to_string(text: &str, out: &mut String) {
	for character in text.chars() {
		match character {
			'&' => out.push_str("&amp;"),
			'<' => out.push_str("&lt;"),
			'>' => out.push_str("&gt;"),
			_ => out.push(character),
		}
	}
}

/// Appends `value` with the characters a double-quoted attribute needs
/// escaped: `&`, `<`, `>`, `"`.
fn encode_double_quoted_attribute_to_string(value: &str, out: &mut String) {
	for character in value.chars() {
		match character {
			'&' => out.push_str("&amp;"),
			'<' => out.push_str("&lt;"),
			'>' => out.push_str("&gt;"),
			'"' => out.push_str("&quot;"),
			_ => out.push(character),
		}
	}
}

fn write_node(nodes: &[Node], node: &Node, out: &mut String) {
	match node {
		Node::Text(text) => {
			encode_text_to_string(text, out);
		},
		Node::Tag(element) => {
			out.push('<');
			out.push_str(element.name());
			match element.name() {
				"a" => write_attr(element, "href", out),
				"img" => {
					write_attr(element, "src", out);
					write_attr(element, "alt", out);
				},
				_ => {},
			}
			out.push('>');
			for child in &nodes[element.children.clone()] {
				write_node(nodes, child, out);
			}
			let _ = write!(out, "</{}>", element.name());
		},
	}
}

fn write_attr(element: &Element, name: &str, out: &mut String) {
	if let Some(value) = element.attr(name) {
		let _ = write!(out, " {name}=\"");
		encode_double_quoted_attribute_to_string(value, out);
		out.push('"');
	}
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::super::{Fetched, testing::run};

	const PAGE: &str = r##"<html><body>
<div class="go-Breadcrumb"><a href="/github.com/example/mod@v1.2.3">github.com/example/mod</a></div>
<div class="go-Chip">v1.2.3</div>
<a data-test-id="UnitHeader-license">MIT</a>
<input data-test-id="UnitHeader-importPath" value="github.com/example/mod/sub">
<div class="go-Main-headerContent"><p>A demo package.</p></div>
<section id="section-documentation">
<div class="go-Message"><p>Overview of <a href="/other">other</a>.</p></div>
<div class="Documentation-content"><p>First paragraph.</p><p>Second.</p><p>Third.</p><p>Fourth.</p></div>
</section>
<section id="section-index"><ul class="Documentation-indexList">
<li><a href="#Foo">Foo</a></li><li><a href="#Bar">Bar</a></li>
</ul></section>
<section id="section-imports"><div class="go-Message"><a href="/fmt">fmt</a><a href="/os">os</a></div></section>
</body></html>"##;

	#[test]
	fn a_package_page_reads_the_proxy_then_the_page() {
		let mut requests = Vec::new();
		let done = run("https://pkg.go.dev/github.com/example/mod/sub", |request| {
			requests.push(request.url.clone());
			if request.url.starts_with("https://proxy.golang.org") {
				Fetched::json(&json!({ "Version": "v1.2.3", "Time": "2024-01-01T00:00:00Z" }))
			} else {
				Fetched::text("text/html", PAGE)
			}
		})
		.unwrap();
		assert_eq!(requests, [
			"https://proxy.golang.org/github.com%2Fexample%2Fmod%2Fsub/@latest",
			"https://pkg.go.dev/github.com/example/mod/sub"
		]);
		assert_eq!(
			(done.method, done.title.as_deref()),
			("go-pkg", Some("github.com/example/mod/sub"))
		);
		let md = &done.markdown;
		assert!(md.starts_with(
			"# github.com/example/mod/sub\n\n**Module:** github.com/example/mod\n**Version:** \
			 v1.2.3\n**License:** MIT\n"
		));
		assert!(md.contains("## Synopsis\n\nA demo package.\n"));
		assert!(md.contains("## Documentation\n\nOverview of"));
		assert!(md.contains("First paragraph.\n\nSecond.\n\nThird.\n"));
		assert!(!md.contains("Fourth."));
		assert!(md.contains("## Index\n\n- Foo\n- Bar\n"));
		assert!(md.contains("## Imports\n\n- fmt\n- os\n"));
		assert_eq!(done.notes, ["published 2024-01-01T00:00:00Z"]);
	}

	#[test]
	fn a_standard_library_page_takes_one_request_and_its_version_chip() {
		let mut requests = Vec::new();
		let page = r#"<html><body><div class="go-Chip">go1.22.0</div>
		<input data-test-id="UnitHeader-importPath" value="net/http">
		<div class="go-Main-headerContent"><p>Package http provides HTTP client and server implementations.</p></div>
		</body></html>"#;
		let done = run("https://pkg.go.dev/net/http", |request| {
			requests.push(request.url.clone());
			Fetched::text("text/html", page)
		})
		.unwrap();
		assert_eq!(requests, ["https://pkg.go.dev/net/http"]);
		assert_eq!(done.title.as_deref(), Some("net/http"));
		let md = &done.markdown;
		assert!(md.starts_with(
			"# net/http\n\n**Module:** std\n**Version:** go1.22.0\n**License:** Unknown\n"
		));
		assert!(md.contains(
			"## Synopsis\n\nPackage http provides HTTP client and server implementations.\n"
		));
		assert!(done.notes.is_empty());
	}

	#[test]
	fn other_pages_and_failed_requests_fall_through() {
		assert_eq!(run("https://pkg.go.dev/", |_| panic!("no fetch expected")), None);
		assert_eq!(run("https://go.dev/net/http", |_| panic!("no fetch expected")), None);
		let mut requests = Vec::new();
		let versioned = run("https://pkg.go.dev/github.com/example/mod@v1.2.3", |request| {
			requests.push(request.url.clone());
			Fetched::status(404)
		});
		assert_eq!(versioned, None);
		assert_eq!(requests, [
			"https://proxy.golang.org/github.com%2Fexample%2Fmod/@v/v1.2.3.info",
			"https://pkg.go.dev/github.com/example/mod@v1.2.3"
		]);
	}
}
