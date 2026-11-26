//! Ollama models: combine the public tags index with model-page metadata.

use std::fmt::Write as _;

use serde_json::Value;
use url::Url;

use super::{Action, Context, Done, Fetch, Fetched, Site, decode_segment, fetch, segment, str_of};
use crate::dom::{self, Node};

pub const SITE: Site = Site { name: "ollama", open };

const TAGS: &str = "https://ollama.com/api/tags";
const MAX_TAGS: usize = 40;
const RESERVED_ROOTS: &[&str] = &[
	"library", "models", "blog", "docs", "download", "cloud", "signin", "signout", "search", "api",
	"terms", "privacy", "license", "settings", "pricing", "account",
];

struct Target {
	base:      String,
	tag:       Option<String>,
	page_url:  String,
	shorthand: bool,
}

impl Target {
	fn parse(url: &Url) -> Option<Self> {
		if !matches!(url.host_str()?, "ollama.com" | "www.ollama.com") {
			return None;
		}
		let mut parts = url.path_segments()?.filter(|part| !part.is_empty());
		let first = parts.next()?;
		let second = parts.next();
		let (namespace, model, shorthand) = if first == "library" {
			(None, decode_segment(second?)?, false)
		} else {
			if RESERVED_ROOTS.contains(&base_ref(first)) {
				return None;
			}
			match second {
				Some(model) => (Some(decode_segment(first)?), decode_segment(model)?, false),
				None => (None, decode_segment(first)?, true),
			}
		};
		let model_base = base_ref(&model);
		let mut page_url = url.origin().ascii_serialization();
		let directory = namespace.as_deref().unwrap_or("library");
		let _ = write!(page_url, "/{}/{}", segment(directory), segment(model_base));
		let (base, tag) = if let Some(namespace) = namespace {
			let base = format!("{namespace}/{model_base}");
			let tag = (namespace.contains(':') || model.contains(':'))
				.then(|| format!("{namespace}/{model}"));
			(base, tag)
		} else {
			let base = model_base.to_owned();
			let tag = model.contains(':').then(|| model.into_owned());
			(base, tag)
		};
		Some(Self { base, tag, page_url, shorthand })
	}
}

fn base_ref(model: &str) -> &str {
	model.split_once(':').map_or(model, |(base, _)| base)
}

fn model_name(model: &Value) -> &str {
	model["model"]
		.as_str()
		.or_else(|| model["name"].as_str())
		.unwrap_or_default()
}

fn matches_base(name: &str, base: &str) -> bool {
	matches!(name.as_bytes().get(base.len()), None | Some(b':'))
		&& name
			.get(..base.len())
			.is_some_and(|prefix| prefix.eq_ignore_ascii_case(base))
}

fn open(url: &Url, _: &Context) -> Option<Action> {
	let Target { base, tag, page_url, shorthand } = Target::parse(url)?;
	fetch(Fetch::get(TAGS).accept_json(), move |reply, _| {
		let models = reply.json_value().and_then(|mut data| {
			let models = data.get_mut("models")?.as_array_mut()?;
			Some(std::mem::take(models))
		});
		let has_index = models.is_some();
		let mut matches = models.unwrap_or_default();
		matches.retain(|model| matches_base(model_name(model), &base));
		if shorthand
			&& has_index
			&& (matches.is_empty()
				|| tag.as_ref().is_some_and(|tag| {
					!matches
						.iter()
						.any(|model| model_name(model).eq_ignore_ascii_case(tag))
				})) {
			return None;
		}
		fetch(Fetch::get(page_url), move |reply, _| render(base, tag.as_deref(), &matches, reply))
	})
}

#[derive(Default)]
struct Page<'a> {
	description: Option<&'a str>,
	parameters:  Vec<String>,
	tags:        Vec<&'a str>,
}

fn page_details<'a>(nodes: &'a [Node], base: &str) -> Page<'a> {
	let mut page = Page::default();
	let mut descriptions = [None; 3];
	for node in nodes {
		let Node::Tag(element) = node else { continue };
		match element.name() {
			"meta" => {
				let rank = if element
					.attr("name")
					.is_some_and(|name| name.eq_ignore_ascii_case("description"))
				{
					Some(0)
				} else {
					element.attr("property").and_then(|property| {
						["og:description", "twitter:description"]
							.iter()
							.position(|key| property.eq_ignore_ascii_case(key))
							.map(|i| i + 1)
					})
				};
				if let Some(rank) = rank
					&& descriptions[rank].is_none()
					&& let Some(content) = element
						.attr("content")
						.map(str::trim)
						.filter(|s| !s.is_empty())
				{
					descriptions[rank] = Some(content);
				}
			},
			"span" if element.has_attr("x-test-size") => {
				if let [Node::Text(text)] = &nodes[element.children.clone()]
					&& !text.trim().is_empty()
				{
					push_unique(&mut page.parameters, text.trim().to_uppercase());
				}
			},
			_ => {},
		}
		if let Some(tag) = element
			.attr("href")
			.and_then(|link| link.strip_prefix("/library/"))
			.map(str::trim)
			&& (tag == base
				|| tag
					.strip_prefix(base)
					.is_some_and(|suffix| suffix.starts_with(':')))
		{
			push_unique(&mut page.tags, tag);
		}
	}
	page.description = descriptions.into_iter().flatten().next();
	page
}

fn push_unique<T: PartialEq>(values: &mut Vec<T>, value: T) {
	if !values.contains(&value) {
		values.push(value);
	}
}

fn render(base: String, tag: Option<&str>, models: &[Value], page: Fetched) -> Option<Action> {
	if !page.ok() && models.is_empty() {
		return None;
	}
	let nodes = page
		.body_text()
		.and_then(|html| dom::parse(&html).ok())
		.unwrap_or_default();
	let details = page_details(&nodes, &base);
	let selected = tag.and_then(|tag| models.iter().find(|model| model_name(model) == tag));
	let mut parameters = Vec::new();
	let detail_models = selected.map_or(models, std::slice::from_ref);
	for model in detail_models {
		if let Some(size) = str_of(&model["details"], "parameter_size") {
			push_unique(&mut parameters, size.to_uppercase());
		}
	}
	for size in details.parameters {
		push_unique(&mut parameters, size);
	}

	let mut md = format!("# {base}\n\n");
	if let Some(description) = details.description {
		let _ = write!(md, "{description}\n\n");
	}
	let _ = writeln!(md, "**Model:** {base}");
	if let Some(tag) = tag {
		let _ = writeln!(md, "**Tag:** {tag}");
	}
	if !parameters.is_empty() {
		md.push_str("**Parameters:** ");
		for (index, parameter) in parameters.iter().enumerate() {
			if index > 0 {
				md.push_str(", ");
			}
			md.push_str(parameter);
		}
		md.push('\n');
	}
	write_model_size(&mut md, models, selected);
	let mut tags = Vec::new();
	for model in models {
		let name = model_name(model);
		if !name.is_empty() {
			push_unique(&mut tags, name);
		}
	}
	if tags.is_empty() {
		tags = details.tags;
	}
	if !tags.is_empty() {
		tags.sort_unstable_by_key(|&tag| (!tag.ends_with(":latest"), tag));
		md.push_str("**Available Tags:** ");
		for (index, tag) in tags.iter().take(MAX_TAGS).enumerate() {
			if index > 0 {
				md.push_str(", ");
			}
			let _ = write!(md, "`{tag}`");
		}
		if tags.len() > MAX_TAGS {
			let _ = write!(md, " […{} tags elided…]", tags.len() - MAX_TAGS);
		}
		md.push('\n');
	}
	let ok = page.ok();
	let mut done = Done::new(md, "ollama")
		.title(base)
		.note("Fetched via Ollama API");
	if ok && !page.url.is_empty() {
		done.url = Some(page.url);
	}
	done.finish()
}

fn write_model_size(md: &mut String, models: &[Value], selected: Option<&Value>) {
	let selected = selected
		.and_then(|model| model["size"].as_f64())
		.filter(|size| *size != 0.0);
	if let Some(size) = selected {
		md.push_str("**Size:** ");
		write_bytes(md, size);
		md.push('\n');
		return;
	}
	let mut sizes = models.iter().filter_map(|model| model["size"].as_f64());
	let Some(first) = sizes.next() else { return };
	let (min, max) = sizes.fold((first, first), |(min, max), size| (size.min(min), size.max(max)));
	if min == max {
		md.push_str("**Size:** ");
		write_bytes(md, min);
	} else {
		md.push_str("**Size Range:** ");
		write_bytes(md, min);
		md.push_str(" - ");
		write_bytes(md, max);
	}
	md.push('\n');
}

fn write_bytes(md: &mut String, size: f64) {
	const KB: f64 = 1024.0;
	const MB: f64 = KB * KB;
	const GB: f64 = MB * KB;
	if size < KB {
		let _ = write!(md, "{size}B");
	} else {
		let (divisor, unit) = if size < MB {
			(KB, "KB")
		} else if size < GB {
			(MB, "MB")
		} else {
			(GB, "GB")
		};
		let rounded = (size * 10.0 / divisor).round() / 10.0;
		let _ = write!(md, "{rounded:.1}{unit}");
	}
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::{super::testing::run, *};

	#[test]
	fn shorthands_and_namespaced_tags_combine_index_and_page_metadata() {
		for (path, page, sizes, aggregate) in [
			("/llama", "https://www.ollama.com/library/llama", "8.0B, 70B, 8B", true),
			("/acme/llama%3A8b/blobs/foo", "https://www.ollama.com/acme/llama", "8.0B, 8B", false),
		] {
			let base = if aggregate { "llama" } else { "acme/llama" };
			let done = run(&format!("https://www.ollama.com{path}"), |request| {
				if request.url == TAGS {
					return Fetched::json(&json!({"models": [
						{"model": format!("{base}:8b"), "size": 4096, "details": {"parameter_size": "8.0b"}},
						{"name": format!("{base}:latest"), "size": 8192, "details": {"parameter_size": "70b"}}
					]}));
				}
				assert_eq!(request.url, page);
				Fetched::text("text/html", r#"<meta property="og:description" content="Fallback"><meta name="description" content="Model &amp; friends"><span x-test-size>8B</span>"#)
			}).unwrap();
			assert_eq!(done.method, "ollama");
			assert_eq!(done.url.as_deref(), Some(page));
			assert!(
				done
					.markdown
					.contains(&format!("# {base}\n\nModel & friends\n\n**Model:** {base}"))
			);
			assert!(
				done
					.markdown
					.contains(&format!("**Parameters:** {sizes}\n"))
			);
			assert!(
				done
					.markdown
					.contains(&format!("**Available Tags:** `{base}:latest`, `{base}:8b`"))
			);
			if aggregate {
				assert!(done.markdown.contains("**Size Range:** 4.0KB - 8.0KB"));
			} else {
				assert!(
					done.markdown.contains("**Tag:** acme/llama:8b")
						&& done.markdown.contains("**Size:** 4.0KB")
				);
			}
		}
	}

	#[test]
	fn canonical_library_pages_fall_back_to_html_when_the_tags_index_is_unavailable() {
		let done = run("https://ollama.com/library/special:13b/tags", |request| {
			if request.url == TAGS {
				return Fetched::status(503);
			}
			assert_eq!(request.url, "https://ollama.com/library/special");
			Fetched::text("text/html", r#"<meta property="twitter:description" content="A &quot;custom&quot; model"><span x-test-size>13b</span><a href="/library/special:13b">13b</a><a href="/library/special:latest">latest</a>"#)
		}).unwrap();
		assert!(done.markdown.contains("A \"custom\" model"));
		assert!(
			done
				.markdown
				.contains("**Parameters:** 13B\n**Available Tags:** `special:latest`, `special:13b`")
		);

		let done = run("https://ollama.com/library/special:13b", |request| {
			if request.url == TAGS {
				Fetched::json(&json!({"models": [{"name": "special:13b", "size": 1024}]}))
			} else {
				Fetched::status(503)
			}
		})
		.unwrap();
		assert_eq!(done.url, None);
		assert!(
			done
				.markdown
				.contains("**Size:** 1.0KB\n**Available Tags:** `special:13b`")
		);
	}

	#[test]
	fn unrelated_routes_and_absent_shorthand_tags_decline_without_a_page_fetch() {
		assert_eq!(run("https://ollama.com/blog/article", |_| panic!("no fetch expected")), None);
		for path in ["/turbo", "/llama:2b"] {
			assert_eq!(
				run(&format!("https://ollama.com{path}"), |request| {
					assert_eq!(request.url, TAGS);
					Fetched::json(&json!({"models": [{"model": "llama:8b"}]}))
				}),
				None
			);
		}
		assert_eq!(run("https://ollama.com/library/llama", |_| Fetched::status(503)), None);
	}
}
