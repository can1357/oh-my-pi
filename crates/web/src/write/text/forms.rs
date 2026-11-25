//! Static representations of browser controls, including form-wide selection
//! and the byte-oriented overlay used by Lynx dumps.

use std::{
	borrow::Cow,
	collections::{HashMap, HashSet},
};

use super::{Element, Layout, Node, Reader, Selection, attr, flag, selected_nodes};

// Dump mode uses 24 display rows. HTML caps the requested textarea height at
// three screens, but never discards extra lines already in the field value.
const MAX_ROWS: usize = 3 * 24;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
	Text,
	Password,
	File,
	Checkbox,
	Radio,
	Submit,
	Reset,
	Image,
	Button,
	Hidden,
	Range,
	Keygen,
	Textarea,
}

impl Kind {
	fn of(el: &Element) -> Self {
		let ty = attr(el, "type");
		if ty.is_empty() && el.name() == "button" {
			return Self::Submit;
		}
		for (name, kind) in [
			("password", Self::Password),
			("file", Self::File),
			("checkbox", Self::Checkbox),
			("radio", Self::Radio),
			("submit", Self::Submit),
			("reset", Self::Reset),
			("image", Self::Image),
			("button", Self::Button),
			("hidden", Self::Hidden),
			("range", Self::Range),
			("keygen", Self::Keygen),
			("textarea", Self::Textarea),
		] {
			if ty.eq_ignore_ascii_case(name) {
				return kind;
			}
		}
		Self::Text
	}
}

// The reference accepts an initial decimal prefix, not necessarily the whole
// attribute.
fn decimal(s: &str) -> usize {
	s.bytes()
		.take_while(u8::is_ascii_digit)
		.fold(0usize, |n, c| n.saturating_mul(10).saturating_add(usize::from(c - b'0')))
}

fn dimension(el: &Element, name: &str, default: usize, max: usize) -> usize {
	let s = attr(el, name);
	if s.as_bytes().first().is_some_and(u8::is_ascii_digit) {
		decimal(s).min(max)
	} else {
		default
	}
}

fn input_size(el: &Element, max: usize) -> usize {
	let s = attr(el, "size").trim_start_matches(|c: char| c.is_ascii_whitespace());
	let n = decimal(s.strip_prefix(['+', '-']).unwrap_or(s));
	if n == 0 {
		20.min(max)
	} else if s.starts_with('-') {
		0
	} else {
		n.min(max)
	}
}

// Checked radios and one-field submission can depend on controls seen later
// in the form, so determine their state before rendering.
#[derive(Default)]
pub(super) struct Forms {
	checked: HashSet<usize>,
	submits: Vec<usize>,
}

impl Forms {
	pub(super) fn scan(nodes: &[Node], selection: &Selection) -> Self {
		let mut result = Self::default();
		let mut radios = HashMap::new();
		let mut form = 0;
		let mut end = 0;
		let mut select_end = 0;
		let mut fields = 0usize;
		let mut candidate = None;
		for (i, node) in selected_nodes(nodes, &selection.dropped, selection.root.clone()) {
			if i >= end
				&& fields == 1
				&& let Some(field) = candidate.take()
			{
				result.submits.push(field);
			}
			let Node::Tag(el) = node else { continue };
			match el.name() {
				"form" => {
					form = i + 1;
					end = el.children.end;
					fields = 0;
					candidate = None;
				},
				"input" | "button" => {
					let kind = Kind::of(el);
					if kind == Kind::Radio {
						// Form number advances at <form>, not at </form>. Out-of-form
						// radios after it can thus change that form's selected field.
						let slot = radios.entry((form, attr(el, "name"))).or_insert(i + 1);
						if el.name() == "input" && flag(el, "checked") {
							*slot = i + 1;
						}
					}
					if i < end && kind != Kind::Hidden && !(kind == Kind::Range && el.name() == "input")
					{
						fields += 1;
						if matches!(kind, Kind::Text | Kind::File | Kind::Password) {
							candidate = Some(i + 1);
						}
					}
				},
				"select" => select_end = el.children.end,
				"option" if i < end && i < select_end => fields += 1,
				"textarea"
					if i < end
						&& (dimension(el, "rows", 4, MAX_ROWS) != 0
							|| selected_nodes(nodes, &selection.dropped, el.children.clone()).any(
								|(_, n)| matches!(n, Node::Text(s) if !s.trim_matches('\n').is_empty()),
							)) =>
				{
					fields += 1;
				},
				_ => {},
			}
		}
		if fields == 1
			&& let Some(field) = candidate
		{
			result.submits.push(field);
		}
		result.checked = radios.into_values().collect();
		result
	}
}

// Leading/trailing blanks disappear and each run of ordinary ASCII whitespace
// is one space. Keep already-normal labels borrowed, including the
// overwhelmingly common empty value.
fn reduce_blanks(s: &str) -> Cow<'_, str> {
	let s = s.trim_matches(|c: char| c.is_ascii_whitespace());
	if !s.bytes().any(|c| c.is_ascii_whitespace() && c != b' ') && !s.contains("  ") {
		return Cow::Borrowed(s);
	}
	let mut result = String::with_capacity(s.len());
	for word in s.split_ascii_whitespace() {
		if !result.is_empty() {
			result.push(' ');
		}
		result.push_str(word);
	}
	Cow::Owned(result)
}

fn attr_value(tag: &Element) -> Cow<'_, str> {
	let value = attr(tag, "value");
	if value.contains('\u{a0}') {
		Cow::Owned(value.replace('\u{a0}', " "))
	} else {
		Cow::Borrowed(value)
	}
}

fn put(layout: &mut Layout, c: char) {
	if c == ' ' {
		layout.field_space();
	} else {
		layout.push(c);
	}
}

// The dump overlays values onto an existing run of placeholder cells. Its size
// limit measures UTF-8 bytes, but each decoded character consumes one
// placeholder.
fn field(layout: &mut Layout, value: &str, size: usize, fill: char) {
	layout.flush_space();
	let mut count = 0;
	for (byte, c) in value.char_indices() {
		if byte >= size {
			break;
		}
		put(layout, c);
		count += 1;
	}
	for _ in count..size {
		put(layout, fill);
	}
}

impl Reader<'_> {
	const fn before_control(&mut self) {
		if self.pre {
			return;
		}
		self.layout.space = !self.layout.line.is_empty() || self.layout.output.is_empty();
	}

	fn max_field(&self) -> usize {
		self
			.layout
			.style
			.end
			.saturating_sub(self.layout.style.left)
			.max(1)
	}

	fn checked(&self, tag: &Element, kind: Kind) -> &'static str {
		if kind == Kind::Checkbox {
			if tag.name() == "input" && flag(tag, "checked") {
				"[X]"
			} else {
				"[ ]"
			}
		} else if self.forms.checked.contains(&tag.children.start) {
			"(*)"
		} else {
			"( )"
		}
	}

	pub(super) fn input(&mut self, tag: &Element) {
		self.before_control();
		let kind = Kind::of(tag);
		let raw = attr_value(tag);
		let raw: &str = &raw;
		let max = self.max_field();
		match kind {
			Kind::Hidden | Kind::Range => {},
			Kind::Radio | Kind::Checkbox => {
				let label = self.checked(tag, kind);
				self.layout.flush_space();
				for c in label.chars() {
					self.layout.push(c);
				}
				self.layout.space = !self.pre;
			},
			Kind::Image | Kind::Submit | Kind::Reset => {
				let alt = attr(tag, "alt");
				let src = attr(tag, "src");
				let use_alt = kind == Kind::Image && raw.is_empty() && !alt.is_empty();
				let value = reduce_blanks(if use_alt { alt } else { raw });
				self.layout.flush_space();
				if kind == Kind::Image && !use_alt && raw.is_empty() && !src.is_empty() {
					self.layout.push('[');
					for c in src.rsplit('/').next().unwrap_or_default().chars() {
						put(&mut self.layout, c);
					}
					self.layout.text("]-Submit");
				} else {
					let label: &str = if value.is_empty() {
						match kind {
							Kind::Image => "[IMAGE]-Submit",
							Kind::Reset => "Reset",
							_ => "Submit",
						}
					} else {
						&value
					};
					for c in label.chars() {
						put(&mut self.layout, c);
					}
				}
			},
			Kind::Button => {
				self.layout.text("[BUTTON Input] (not implemented)");
				let n = if raw.is_empty() { 5 } else { raw.len() };
				for _ in 0..n.min(self.layout.columns.saturating_sub(9)) {
					self.layout.push('_');
				}
			},
			_ => {
				let size = input_size(
					tag,
					if matches!(kind, Kind::Password | Kind::File | Kind::Keygen) {
						self.layout.columns.saturating_sub(9)
					} else {
						max
					},
				);
				if kind == Kind::Keygen
					|| self
						.forms
						.submits
						.binary_search(&tag.children.start)
						.is_ok()
				{
					field(&mut self.layout, "", size, '_');
				} else {
					let ty = attr(tag, "type");
					let value = if ty.is_empty() || ty.eq_ignore_ascii_case("text") || kind == Kind::File
					{
						reduce_blanks(raw)
					} else {
						Cow::Borrowed(raw)
					};
					field(&mut self.layout, &value, size, if kind == Kind::File { ' ' } else { '_' });
				}
			},
		}
	}

	pub(super) fn button(&mut self, tag: &Element) {
		self.before_control();
		self.layout.text("(");
		let kind = Kind::of(tag);
		let name = attr(tag, "name");
		let raw = attr_value(tag);
		let raw: &str = &raw;
		let value = if raw.is_empty() {
			Cow::Borrowed(if kind == Kind::Button && !name.is_empty() {
				name
			} else {
				"BUTTON"
			})
		} else {
			reduce_blanks(raw)
		};
		let label = match kind {
			Kind::Radio | Kind::Checkbox => self.checked(tag, kind),
			Kind::Reset if value.is_empty() => "Reset",
			Kind::Submit if value.is_empty() => "Submit",
			Kind::Image if value.is_empty() => "[IMAGE]-Submit",
			_ => &value,
		};
		for c in label.chars() {
			put(&mut self.layout, c);
		}
		if matches!(kind, Kind::Checkbox | Kind::Radio) && value.len() > 3 {
			for c in String::from_utf8_lossy(&value.as_bytes()[3..]).chars() {
				put(&mut self.layout, c);
			}
		}
		if !self.pre && kind == Kind::Button && value.is_empty() {
			for _ in 0..5 {
				self.layout.field_space();
			}
		}
		let fill = match kind {
			Kind::Text | Kind::Password | Kind::Textarea
				if self
					.forms
					.submits
					.binary_search(&tag.children.start)
					.is_err() =>
			{
				Some('_')
			},
			Kind::Text | Kind::Password | Kind::File | Kind::Range | Kind::Keygen => Some(' '),
			_ => None,
		};
		if !self.pre
			&& let Some(fill) = fill
		{
			for _ in label.len()..20 {
				put(&mut self.layout, fill);
			}
		}
		self.layout.push(')');
		self.layout.space = !self.pre;
		self.nodes(tag.children.clone());
	}

	pub(super) fn select(&mut self, tag: &Element) {
		let multiple = flag(tag, "multiple");
		let mut chosen = String::new();
		let mut widest = 0;
		let mut first = true;
		let mut title = String::new();
		let mut nodes = selected_nodes(self.dom, self.dropped, tag.children.clone()).peekable();
		while let Some((_, node)) = nodes.next() {
			let Node::Tag(option) = node else { continue };
			if option.name() != "option" {
				continue;
			}
			title.clear();
			// Lynx collects character data until the next OPTION or /SELECT, not
			// /OPTION.
			while let Some((_, node)) =
				nodes.next_if(|(_, node)| !matches!(node, Node::Tag(el) if el.name() == "option"))
			{
				if let Node::Text(s) = node {
					title.push_str(s);
				}
			}
			if multiple {
				self.layout.boundary(0);
				self.layout.text(if flag(option, "selected") {
					"[X]"
				} else {
					"[ ]"
				});
				let title = title.trim_matches(|c: char| c.is_ascii_whitespace());
				if !title.is_empty() {
					self.layout.push(' ');
				}
				for c in title.chars() {
					match c {
						'\n' | '\r' => self.layout.literal_newline(),
						'\t' => {
							for _ in 0..8 - (self.layout.style.left + self.layout.length) % 8 {
								self.layout.push(' ');
							}
						},
						'\u{a0}' => self.layout.push(' '),
						c => self.layout.push(c),
					}
				}
			} else {
				let folded = reduce_blanks(&title);
				let select = first || flag(option, "selected");
				if select {
					chosen.clear();
				}
				let mut width = 0;
				for c in folded.chars().filter(|&c| c != '\u{ad}') {
					let c = if c == '\u{a0}' { ' ' } else { c };
					width += c.len_utf8();
					if select {
						chosen.push(c);
					}
				}
				widest = widest.max(width);
			}
			first = false;
		}
		if multiple {
			self.layout.boundary(0);
		} else if !first {
			self.layout.text("[");
			for c in chosen.chars() {
				put(&mut self.layout, c);
			}
			let padding = widest - chosen.len();
			for _ in 0..padding {
				self.layout.push('_');
			}
			// The popup backing label is UTF-8 followed by dots. The byte-oriented
			// dump consumes just one backing byte per decoded value/filler cell.
			let used = chosen.chars().count() + padding;
			if used < chosen.len() {
				for c in String::from_utf8_lossy(&chosen.as_bytes()[used..]).chars() {
					put(&mut self.layout, c);
				}
			}
			for _ in used.max(chosen.len())..widest {
				self.layout.push('.');
			}
			self.layout.push(']');
		}
	}

	pub(super) fn textarea(&mut self, tag: &Element) {
		if self.layout.line.is_empty() {
			self.layout.gap += 1;
		}
		self.layout.boundary(0);
		let max = self.max_field();
		let cols = dimension(tag, "cols", 60.min(max), self.layout.columns);
		let size = if cols == 0 { 20 } else { cols }.min(max);
		let rows = dimension(tag, "rows", 4, MAX_ROWS);
		let content = self.inner(tag);
		let mut rest = content.trim_matches(['\n', '\r']);
		let mut lines = std::iter::from_fn(|| {
			if rest.is_empty() {
				return None;
			}
			if let Some(end) = rest.find(['\n', '\r']) {
				let line = &rest[..end];
				let next = &rest[end..];
				rest = next.strip_prefix("\r\n").unwrap_or_else(|| &next[1..]);
				Some(line)
			} else {
				Some(std::mem::take(&mut rest))
			}
		});
		for _ in 0..rows {
			field(&mut self.layout, lines.next().unwrap_or_default(), size, '_');
			self.layout.boundary(0);
		}
		// Pre-filled lines beyond ROWS get their own fields, including blank
		// lines.
		for line in lines {
			field(&mut self.layout, line, size.min(cols), '_');
			for _ in size..cols {
				self.layout.push('_');
			}
			self.layout.boundary(0);
		}
	}
}

#[cfg(test)]
mod tests {
	use super::super::dump;

	// Stock Lynx 2.9.3, -dump -nolist -width=250 with UTF-8 input/display.
	#[test]
	fn finalizes_forms_before_printing_their_fields() {
		assert_eq!(
			dump(
				"<form>A<input size=4 value=Jane><input type=hidden></form><form>B<input \
				 type=password value=pass size=5><input type=checkbox></form>"
			)
			.unwrap(),
			"   A ____\n   B pass_ [ ]\n"
		);
		assert_eq!(
			dump(
				"A<input type=radio name=x><form>B<input type=radio name=x></form>C<input type=radio \
				 name=x checked>D"
			)
			.unwrap(),
			"   A (*) B ( )\n   C (*) D\n"
		);
	}

	#[test]
	fn uses_field_specific_labels_padding_and_clipping() {
		assert_eq!(
			dump(
				"A<input type=hidden>B<input type=range>C<input type=button value=Go>Z<input \
				 type=image src=/a/b.png>X<input type=image alt=' Go   now '>Y<button type=button \
				 name=Click>ok</button>."
			)
			.unwrap(),
			"   A B C [BUTTON Input] (not implemented)__Z [b.png]-SubmitX Go nowY (Click) ok.\n"
		);
		assert_eq!(
			dump("A<input type=text size=7 value='  a   b  '>Z<input type=file size=4 value=a>")
				.unwrap(),
			"   A a b____Z a   \n"
		);
		assert_eq!(dump("A<input type=password size=4 value=éééé>X").unwrap(), "   A éé__X\n");
	}

	#[test]
	fn popups_and_checkbox_lists_have_distinct_text_rules() {
		assert_eq!(
			dump(
				"A<select></select>B<select size=2><option>h<b>i</b><br>t <option selected>A   \
				 B</option> C</select>Z<select multiple><option>A  B<option selected>C</select>Q"
			)
			.unwrap(),
			"   AB[A B C]Z\n   [ ] A  B\n   [X] C\n   Q\n"
		);
		assert_eq!(
			dump(
				"A<select><option selected>x<option>猫猫</select>B<select><option>abcdef<option \
				 selected>éé</select>q"
			)
			.unwrap(),
			"   A[x_____]B[éé__..]q\n"
		);
	}

	#[test]
	fn textarea_keeps_extra_lines_and_limits_requested_rows() {
		assert_eq!(
			dump("A<textarea rows='1x' cols=3>\n\nABCDE\n\nx\n</textarea>B").unwrap(),
			"   A\n   ABC\n   ___\n   x__\n   B\n"
		);
		assert_eq!(
			dump("<textarea cols=1 rows=999></textarea>").unwrap(),
			format!("\n{}", "   _\n".repeat(72))
		);
	}
}
