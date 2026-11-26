use std::{fmt::Write as _, sync::LazyLock};

use quick_xml::{Reader, XmlVersion, events::Event};
use regex::Regex;

static TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<[^>]+>").unwrap());

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
	Rss,
	Atom,
}

#[derive(Clone, Copy)]
enum Field {
	Title,
	Link,
	Date,
	Summary,
	Content,
}

const fn field_name(name: &[u8], kind: Kind) -> Option<Field> {
	Some(match (kind, name) {
		(_, b"title") => Field::Title,
		(_, b"link") => Field::Link,
		(Kind::Rss, b"pubDate") | (Kind::Atom, b"updated") => Field::Date,
		(Kind::Rss, b"description") | (Kind::Atom, b"summary") => Field::Summary,
		(Kind::Atom, b"content") => Field::Content,
		_ => return None,
	})
}

#[derive(Default)]
struct Entry {
	title:   Option<String>,
	link:    Option<String>,
	date:    Option<String>,
	summary: Option<String>,
	content: Option<String>,
}

const fn field(entry: &mut Entry, name: Field) -> &mut Option<String> {
	match name {
		Field::Title => &mut entry.title,
		Field::Link => &mut entry.link,
		Field::Date => &mut entry.date,
		Field::Summary => &mut entry.summary,
		Field::Content => &mut entry.content,
	}
}

fn clean(text: &str) -> String {
	let decoded = html_escape::decode_html_entities(text);
	TAG.replace_all(&decoded, "").trim().to_owned()
}

fn write_entry(out: &mut String, entry: Entry) {
	let title = entry
		.title
		.as_deref()
		.filter(|s| !s.is_empty())
		.unwrap_or("Untitled");
	let _ = writeln!(out, "## {title}");
	if let Some(date) = entry.date.filter(|s| !s.is_empty()) {
		let _ = write!(out, "*{date}*\n\n");
	}
	if let Some(summary) = entry
		.summary
		.filter(|s| !s.is_empty())
		.or(entry.content)
		.filter(|s| !s.is_empty())
	{
		if let Some((end, _)) = summary.char_indices().nth(500) {
			let _ = write!(out, "{}...\n\n", &summary[..end]);
		} else {
			let _ = write!(out, "{summary}\n\n");
		}
	}
	if let Some(link) = entry.link.filter(|s| !s.is_empty()) {
		let _ = write!(out, "[Read more]({link})\n\n");
	}
	out.push_str("---\n\n");
}

/// Render up to `max_items` RSS items or Atom entries; return `None` for
/// unrecognized or malformed XML.
pub fn to_markdown(xml: &str, max_items: usize) -> Option<String> {
	let mut reader = Reader::from_str(xml);
	// Unfold self-closing tags so empty fields still count as their first
	// occurrence.
	reader.config_mut().expand_empty_elements = true;
	let mut level = 0usize;
	let mut seen_root = false;
	let mut rss = false;
	let mut feed = None;
	let mut scope = None;
	let mut title = None;
	let mut count = 0;
	let mut entry = None;
	let mut entries = String::new();
	let mut capture: Option<(Field, usize, String)> = None;
	loop {
		match reader.read_event().ok()? {
			Event::Start(tag) => {
				if level == 0 && std::mem::replace(&mut seen_root, true) {
					return None;
				}
				level += 1;
				let local_name = tag.local_name();
				let name = local_name.as_ref();
				match (level, name) {
					(1, b"rss") => rss = true,
					(1, b"feed") => {
						feed = Some(Kind::Atom);
						scope = Some((1, b"entry".as_slice()));
					},
					(1, _) => return None,
					(2, b"channel") if rss && feed.is_none() => {
						feed = Some(Kind::Rss);
						scope = Some((2, b"item".as_slice()));
					},
					_ => {},
				}
				if let Some((depth, entry_tag)) = scope {
					let kind = feed?;
					if level == depth + 1 && name == entry_tag && count < max_items {
						entry = Some(Entry::default());
					} else if level == depth + 1 && name == b"title" && title.is_none() {
						capture = Some((Field::Title, level, String::new()));
					} else if level == depth + 2
						&& let Some(item) = entry.as_mut()
						&& let Some(key) = field_name(name, kind)
						&& field(item, key).is_none()
					{
						if kind == Kind::Atom && name == b"link" {
							let href = match tag.try_get_attribute("href").ok()? {
								Some(href) => href
									.decoded_and_normalized_value(XmlVersion::Implicit1_0, reader.decoder())
									.ok()?
									.into_owned(),
								None => String::new(),
							};
							item.link = Some(href);
						} else {
							capture = Some((key, level, String::new()));
						}
					}
				}
			},
			Event::End(_) => {
				if capture
					.as_ref()
					.is_some_and(|(_, depth, _)| *depth == level)
				{
					let (key, _, text) = capture.take().unwrap();
					let slot = match entry.as_mut() {
						Some(item) => field(item, key),
						None => &mut title,
					};
					*slot = Some(clean(&text));
				}
				if let Some((depth, _)) = scope {
					if level == depth + 1
						&& let Some(item) = entry.take()
					{
						write_entry(&mut entries, item);
						count += 1;
					}
					if level == depth {
						scope = None;
					}
				}
				level = level.checked_sub(1)?;
			},
			Event::Text(text) => {
				if let Some((_, _, field)) = capture.as_mut() {
					field.push_str(text.decode().ok()?.as_ref());
				} else if level == 0 && !text.iter().all(|byte| byte.is_ascii_whitespace()) {
					return None;
				}
			},
			Event::CData(text) => {
				if let Some((_, _, field)) = capture.as_mut() {
					field.push_str(text.decode().ok()?.as_ref());
				} else if level == 0 {
					return None;
				}
			},
			Event::GeneralRef(reference) => {
				if let Some((_, _, field)) = capture.as_mut() {
					if let Some(value) = reference.resolve_char_ref().ok()? {
						field.push(value);
					} else {
						let reference = reference.decode().ok()?;
						if let Some(value) = quick_xml::escape::resolve_xml_entity(&reference) {
							field.push_str(value);
						} else {
							field.push('&');
							field.push_str(&reference);
							field.push(';');
						}
					}
				} else if level == 0 {
					return None;
				}
			},
			Event::Eof => break,
			_ => {},
		}
	}
	if level != 0 {
		return None;
	}
	let title = title
		.as_deref()
		.filter(|s| !s.is_empty())
		.unwrap_or(match feed? {
			Kind::Rss => "RSS Feed",
			Kind::Atom => "Atom Feed",
		});
	Some(format!("# {title}\n\n{entries}"))
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn rss_cleans_description_and_caps_items() {
		let xml = r"<rss><channel><title>Fluxer blog</title>
		<item><title>Mobile clients &amp; v2</title><link>https://example.test/rss-item</link><description><![CDATA[<p>Open source <b>mobile</b> apps.</p>]]></description><pubDate>Mon, 15 Jun 2026 12:00:00 +0000</pubDate></item>
		<item><title>Omitted item</title></item></channel></rss>";
		assert_eq!(
			to_markdown(xml, 1).as_deref(),
			Some("# Fluxer blog\n\n## Mobile clients & v2\n*Mon, 15 Jun 2026 12:00:00 +0000*\n\nOpen source mobile apps.\n\n[Read more](https://example.test/rss-item)\n\n---\n\n")
		);
	}

	#[test]
	fn atom_prefers_summary_but_falls_back_to_content() {
		let xml = r#"<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom title</title>
		<entry><title>First entry</title><link href="https://example.test/atom-entry"/><updated>2026-06-15T12:00:00Z</updated><summary>Entry summary</summary><content>Not selected</content></entry>
		<entry><title>Second entry</title><summary/><content>Entry content</content></entry></feed>"#;
		assert_eq!(
			to_markdown(xml, 10).as_deref(),
			Some("# Atom title\n\n## First entry\n*2026-06-15T12:00:00Z*\n\nEntry summary\n\n[Read more](https://example.test/atom-entry)\n\n---\n\n## Second entry\nEntry content\n\n---\n\n")
		);
	}
}
