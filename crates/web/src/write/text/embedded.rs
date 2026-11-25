//! Visible labels for links, embedded images and named tab stops.

use super::{Align, Element, Node, Reader, attr, flag};

const TOOLBAR_RELATIONS: &[&str] = &[
	"home",
	"toc",
	"contents",
	"index",
	"glossary",
	"copyright",
	"help",
	"search",
	"bookmark",
	"banner",
	"top",
	"origin",
	"navigator",
	"disclaimer",
	"editor",
	"publisher",
	"trademark",
	"hotlist",
	"begin",
	"first",
	"end",
	"last",
	"documentation",
	"biblioentry",
	"bibliography",
	"start",
	"appendix",
	"up",
	"next",
	"previous",
	"prev",
	"child",
	"sibling",
	"parent",
	"meta",
	"urc",
	"pointer",
	"translation",
	"definition",
	"alternate",
	"section",
	"subsection",
	"chapter",
];

impl Reader<'_> {
	pub(super) fn toolbar_link(&mut self, tag: &Element) {
		let rel = attr(tag, "rel");
		let rev = attr(tag, "rev");
		let supported = if flag(tag, "href") {
			!rev.eq_ignore_ascii_case("made")
				&& !rev.eq_ignore_ascii_case("owner")
				&& (rel.is_empty()
					|| TOOLBAR_RELATIONS
						.iter()
						.any(|r| rel.eq_ignore_ascii_case(r)))
		} else {
			["home", "help", "index"]
				.iter()
				.any(|r| rel.eq_ignore_ascii_case(r))
		};
		if !supported {
			return;
		}
		let title = attr(tag, "title");
		let title = if title.is_empty() { rel } else { title.trim() };
		if title.is_empty() {
			return;
		}
		self.layout.text(if self.toolbar { " " } else { "#" });
		self.toolbar = true;
		self.layout.text(title);
		let class = attr(tag, "class");
		if !class.is_empty() {
			self.layout.text(" (");
			self.layout.text(class);
			self.layout.text(")");
		}
	}

	pub(super) fn refresh(&mut self, tag: &Element) {
		if !attr(tag, "http-equiv").eq_ignore_ascii_case("refresh") {
			return;
		}
		let content = attr(tag, "content").trim_start();
		let digits = content.bytes().take_while(u8::is_ascii_digit).count();
		if digits == 0 {
			return;
		}
		let target = content
			.split(';')
			.skip(1)
			.filter_map(|part| part.split_once('='))
			.find(|(key, _)| key.trim().eq_ignore_ascii_case("url"))
			.and_then(|(_, url)| url.split_ascii_whitespace().next())
			.unwrap_or_default();
		self.layout.boundary(0);
		self.layout.text("REFRESH(");
		self.layout.text(&content[..digits]);
		self.layout.text(" sec): ");
		// A stdin dump resolves relative URLs against Lynx's random temporary
		// filename. In memory there is no source path; retain a relative target.
		if let Some(path) = target.strip_prefix("file:///") {
			self.layout.text("file://localhost/");
			self.layout.text(path);
		} else {
			if target.starts_with("//") {
				self.layout.text("file:");
			} else if target.starts_with('/') {
				self.layout.text("file://localhost");
			}
			self.layout.text(target);
		}
		self.layout.boundary(0);
	}

	pub(super) fn media_separator(&mut self) {
		if self.pre || self.layout.output.is_empty() || !self.layout.line.is_empty() {
			self.layout.separator();
		}
	}

	pub(super) fn image(&mut self, tag: &Element) {
		let object = tag.name() == "object";
		let src = attr(tag, if object { "data" } else { "src" });
		let file = src.rsplit('/').next().unwrap_or_default();
		let map = attr(tag, "usemap").contains('#');
		let title = attr(tag, "title").trim();
		if src
			.trim_start()
			.get(..5)
			.is_some_and(|prefix| prefix.eq_ignore_ascii_case("data:"))
		{
			if let Some(label) = tag
				.attr("alt")
				.filter(|alt| !alt.trim().is_empty())
				.or_else(|| (!title.is_empty()).then_some(title))
			{
				self.media_separator();
				self.layout.text(label);
				self.layout.space = true;
			}
			return;
		}
		self.media_separator();
		if self.anchor && map {
			self.layout.text("[LINK]-");
		}
		let alt = tag.attr("alt").filter(|alt| !map || !alt.trim().is_empty());
		if let Some(alt) = alt {
			self.layout.text(alt);
		} else if !title.is_empty() {
			self.layout.text(title);
		} else if map || (self.anchor && flag(tag, "ismap")) {
			self.layout.text(if map { "[USEMAP" } else { "[ISMAP" });
			if !src.is_empty() {
				self.layout.text(":");
				self.layout.text(file);
			}
			self.layout.text("]");
		} else if (object || flag(tag, "isobject")) && !self.anchor {
			self.layout.text("(OBJECT)");
		} else {
			self.layout.text("[");
			self.layout.text(file);
			self.layout.text("]");
		}
		self.layout.space = !map && !self.layout.line.is_empty() && !self.layout.line.ends_with(' ');
	}

	pub(super) fn tab(&mut self, index: usize) {
		let Node::Tag(tag) = &self.dom[index] else {
			unreachable!()
		};
		let to = attr(tag, "to");
		let indent = attr(tag, "indent");
		let col = self.layout.style.left + self.layout.length;
		let align = tag.attr("align");
		if self.layout.style.align != Align::Left
			|| align.is_some_and(|s| {
				!s.eq_ignore_ascii_case("left") || (to.is_empty() && indent.is_empty())
			}) {
			self.layout.text(" ");
		} else if !to.is_empty() || indent.starts_with(|c: char| c.is_ascii_digit()) {
			let target = if to.is_empty() {
				indent.parse::<usize>().ok().map(|n| n.div_ceil(2))
			} else {
				self.tabs.get(to).copied()
			};
			if let Some(target) = target.filter(|c| (col..self.layout.style.end).contains(c)) {
				self.layout.space = false;
				for _ in col..target {
					self.layout.push(' ');
				}
			} else {
				self.layout.text(" ");
			}
		}
		let id = attr(tag, "id");
		if !id.is_empty() {
			self
				.tabs
				.entry(id)
				.or_insert(self.layout.style.left + self.layout.length);
		}
	}
}
