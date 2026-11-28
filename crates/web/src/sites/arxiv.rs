//! arXiv (`arxiv.org/abs/<id>`): paper metadata from the arXiv Atom API in one
//! request. The `/pdf/` URL shape is matched too, but the paper's PDF is not
//! fetched or converted here; only the metadata is written.

use std::{fmt::Write as _, sync::LazyLock};

use quick_xml::{Reader, XmlVersion, events::Event};
use regex::Regex;
use url::Url;

use super::{Action, Context, Done, Fetch, Site, fetch, iso_date};

/// Registry entry.
pub const SITE: Site = Site { name: "arxiv", open };

const METHOD: &str = "arxiv";
const API: &str = "https://export.arxiv.org/api/query";

static PATH: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"^/(abs|pdf)/(.+?)(?:\.pdf)?$").unwrap());

fn open(url: &Url, _: &Context) -> Option<Action> {
	if url.host_str()? != "arxiv.org" {
		return None;
	}
	let captures = PATH.captures(url.path())?;
	let paper_id = captures.get(2)?.as_str().to_owned();
	fetch(Fetch::get(format!("{API}?id_list={paper_id}")), move |reply, _| {
		let atom = parse_atom(&reply.body_text()?)?;
		let title = atom
			.title
			.clone()
			.unwrap_or_else(|| "arXiv Paper".to_owned());
		Done::new(markdown(&paper_id, &atom), METHOD)
			.title(title)
			.note("Fetched via arXiv API")
			.finish()
	})
}

/// Fields of the first Atom entry.
#[derive(Default)]
struct Atom {
	title:      Option<String>,
	summary:    Option<String>,
	published:  Option<String>,
	authors:    Vec<String>,
	categories: Vec<String>,
}

#[derive(Clone, Copy)]
enum Field {
	Title,
	Summary,
	Published,
	Author,
}

fn markdown(paper_id: &str, atom: &Atom) -> String {
	let mut md = format!("# {}\n\n", atom.title.as_deref().unwrap_or("arXiv Paper"));
	if !atom.authors.is_empty() {
		let _ = writeln!(md, "**Authors:** {}", atom.authors.join(", "));
	}
	if let Some(published) = atom.published.as_deref() {
		let _ = writeln!(md, "**Published:** {published}");
	}
	if !atom.categories.is_empty() {
		let _ = writeln!(md, "**Categories:** {}", atom.categories.join(", "));
	}
	let _ = write!(md, "**arXiv:** {paper_id}\n\n");
	md.push_str("---\n\n## Abstract\n\n");
	md.push_str(
		atom
			.summary
			.as_deref()
			.filter(|text| !text.is_empty())
			.unwrap_or("No abstract available."),
	);
	md.push('\n');
	md
}

/// Parse the first `<entry>` of an arXiv Atom feed; `None` when the feed has no
/// entry or the XML is malformed.
fn parse_atom(xml: &str) -> Option<Atom> {
	let mut reader = Reader::from_str(xml);
	reader.config_mut().expand_empty_elements = true;
	let mut level = 0usize;
	let mut entry_level = 0usize;
	let mut capture: Option<(Field, usize, String)> = None;
	let mut atom = Atom::default();
	loop {
		match reader.read_event().ok()? {
			Event::Start(tag) => {
				level += 1;
				let name = tag.local_name();
				let name = name.as_ref();
				if name == b"entry" && entry_level == 0 {
					entry_level = level;
				} else if entry_level > 0 {
					match name {
						b"title" if level == entry_level + 1 => {
							capture = Some((Field::Title, level, String::new()));
						},
						b"summary" if level == entry_level + 1 => {
							capture = Some((Field::Summary, level, String::new()));
						},
						b"published" if level == entry_level + 1 => {
							capture = Some((Field::Published, level, String::new()));
						},
						b"name" if level == entry_level + 2 => {
							capture = Some((Field::Author, level, String::new()));
						},
						b"category" => {
							if let Some(term) = attribute(&tag, "term", &reader) {
								atom.categories.push(term);
							}
						},
						_ => {},
					}
				}
			},
			Event::End(_) => {
				if capture
					.as_ref()
					.is_some_and(|(_, depth, _)| *depth == level)
				{
					let (field, _, text) = capture.take()?;
					match field {
						Field::Title => {
							let title = text.split_whitespace().collect::<Vec<_>>().join(" ");
							if !title.is_empty() {
								atom.title = Some(title);
							}
						},
						Field::Summary => {
							let summary = text.trim();
							if !summary.is_empty() {
								atom.summary = Some(summary.to_owned());
							}
						},
						Field::Published => atom.published = iso_date(&text).map(str::to_owned),
						Field::Author => {
							let name = text.trim();
							if !name.is_empty() {
								atom.authors.push(name.to_owned());
							}
						},
					}
				}
				if level == entry_level {
					break;
				}
				level = level.checked_sub(1)?;
			},
			Event::Text(text) => {
				if let Some((_, _, buffer)) = capture.as_mut() {
					buffer.push_str(text.decode().ok()?.as_ref());
				}
			},
			Event::CData(text) => {
				if let Some((_, _, buffer)) = capture.as_mut() {
					buffer.push_str(text.decode().ok()?.as_ref());
				}
			},
			Event::GeneralRef(reference) => {
				if let Some((_, _, buffer)) = capture.as_mut() {
					if let Some(value) = reference.resolve_char_ref().ok().flatten() {
						buffer.push(value);
					} else if let Ok(name) = reference.decode() {
						if let Some(value) = quick_xml::escape::resolve_xml_entity(&name) {
							buffer.push_str(value);
						} else {
							buffer.push('&');
							buffer.push_str(&name);
							buffer.push(';');
						}
					}
				}
			},
			Event::Eof => break,
			_ => {},
		}
	}
	atom.entry_seen()
}

impl Atom {
	/// The feed had an entry when any field was seen.
	fn entry_seen(self) -> Option<Self> {
		let seen = self.title.is_some()
			|| self.summary.is_some()
			|| self.published.is_some()
			|| !self.authors.is_empty()
			|| !self.categories.is_empty();
		seen.then_some(self)
	}
}

/// Decoded, unescaped value of `name` on `tag`.
fn attribute(
	tag: &quick_xml::events::BytesStart<'_>,
	name: &str,
	reader: &Reader<&[u8]>,
) -> Option<String> {
	let attribute = tag.try_get_attribute(name).ok().flatten()?;
	attribute
		.decoded_and_normalized_value(XmlVersion::Implicit1_0, reader.decoder())
		.ok()
		.map(std::borrow::Cow::into_owned)
}

#[cfg(test)]
mod tests {
	use super::super::{Fetched, testing::run};

	fn feed() -> String {
		"<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
		<feed xmlns=\"http://www.w3.org/2005/Atom\">\n\
			<entry>\n\
				<id>http://arxiv.org/abs/1706.03762v7</id>\n\
				<title>Attention Is All\n  You Need</title>\n\
				<summary>  The dominant sequence transduction models are based on complex recurrent or convolutional neural networks.  </summary>\n\
				<published>2017-06-12T17:57:34Z</published>\n\
				<author><name>Ashish Vaswani</name></author>\n\
				<author><name>Noam Shazeer</name></author>\n\
				<category term=\"cs.CL\"/>\n\
				<category term=\"cs.LG\"/>\n\
				<link title=\"pdf\" href=\"http://arxiv.org/pdf/1706.03762v7\"/>\n\
			</entry>\n\
		</feed>"
			.to_owned()
	}

	#[test]
	fn an_abstract_page_reads_the_atom_api() {
		let mut requests = Vec::new();
		let done = run("https://arxiv.org/abs/1706.03762", |request| {
			requests.push(request.url.clone());
			Fetched::text("application/atom+xml", feed())
		})
		.unwrap();
		assert_eq!(requests, ["https://export.arxiv.org/api/query?id_list=1706.03762"]);
		assert_eq!(
			(done.method, done.title.as_deref()),
			("arxiv", Some("Attention Is All You Need"))
		);
		assert_eq!(done.notes, ["Fetched via arXiv API"]);
		let md = &done.markdown;
		assert!(md.starts_with(
			"# Attention Is All You Need\n\n**Authors:** Ashish Vaswani, Noam \
			 Shazeer\n**Published:** 2017-06-12\n**Categories:** cs.CL, cs.LG\n**arXiv:** \
			 1706.03762\n\n---\n\n## Abstract\n\n"
		));
		assert!(md.contains(
			"The dominant sequence transduction models are based on complex recurrent or \
			 convolutional neural networks.\n"
		));
		assert!(!md.contains("http://arxiv.org/pdf"));
	}

	#[test]
	fn pdf_urls_match_but_write_only_the_metadata() {
		for url in ["https://arxiv.org/pdf/1706.03762", "https://arxiv.org/pdf/1706.03762.pdf"] {
			let mut requests = Vec::new();
			let done = run(url, |request| {
				requests.push(request.url.clone());
				Fetched::text("application/atom+xml", feed())
			})
			.unwrap();
			assert_eq!(requests, ["https://export.arxiv.org/api/query?id_list=1706.03762"]);
			assert_eq!(done.method, "arxiv");
			assert!(done.markdown.contains("## Abstract"));
		}
	}

	#[test]
	fn other_pages_and_api_failures_fall_through() {
		assert_eq!(run("https://arxiv.org/list/cs.CL/2401", |_| panic!("no fetch expected")), None);
		assert_eq!(run("https://example.test/abs/1706.03762", |_| panic!("no fetch expected")), None);
		assert_eq!(run("https://arxiv.org/abs/1706.03762", |_| Fetched::status(503)), None);
		assert_eq!(
			run("https://arxiv.org/abs/1706.03762", |_| Fetched::text(
				"application/atom+xml",
				"<feed><nope/></feed>"
			)),
			None
		);
	}

	#[test]
	fn a_feed_without_an_entry_declines() {
		let empty = "<feed xmlns=\"http://www.w3.org/2005/Atom\"></feed>";
		assert_eq!(
			run("https://arxiv.org/abs/1706.03762", |_| Fetched::text("application/atom+xml", empty)),
			None
		);
	}
}
