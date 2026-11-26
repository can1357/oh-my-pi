//! List counters, labels and hanging paragraph margins in a plain-text dump.

use std::fmt::NumBuffer;

use smallvec::SmallVec;

use super::{Align, Element, Layout, Reader, Style, align, attr, flag, own_number};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
	Bullet,
	Ordered,
	Plain,
	Description { compact: bool },
}

impl Kind {
	fn gap(self) -> usize {
		usize::from(self == Self::Description { compact: false })
	}

	fn margins(self, level: usize) -> (usize, usize) {
		let level = level.min(6);
		match self {
			Self::Description { compact: false } => ((6 * level + 2).max(3), 6 * level + 10),
			Self::Description { compact: true } => (5 * level + 3, 5 * level + 10),
			Self::Plain => (5 * level + 3, 5 * level + 7 + usize::from(level >= 5)),
			Self::Bullet | Self::Ordered => (5 * level + 3, 5 * level + 7),
		}
	}
}

#[derive(Clone, Copy)]
struct Number {
	value: i32,
	kind:  u8,
}

const VOID: i32 = -29_998;
const CONTINUE: i32 = VOID - 1;
const UNUSED: Number = Number { value: VOID, kind: b'1' };

// Lynx has independent counters through level eleven; deeper lists reuse the
// final slot. A continuation draws from its nearest numbered ancestor, or from
// the last printed number/type even if that list has already closed.
pub(super) struct Lists {
	stack:     SmallVec<[Kind; 8]>,
	counters:  [Number; 12],
	last:      Number,
	marker:    Option<(usize, usize)>, // output/line offsets immediately after a label
	term_line: Option<usize>,          // output offset at the start of the term's first line
}

impl Default for Lists {
	fn default() -> Self {
		Self {
			stack:     SmallVec::new(),
			counters:  [UNUSED; 12],
			last:      Number { value: 0, kind: b'1' },
			marker:    None,
			term_line: Some(0),
		}
	}
}

impl Lists {
	pub(super) fn is_empty(&self) -> bool {
		self.stack.is_empty()
	}

	pub(super) fn has_markers(&self) -> bool {
		matches!(self.stack.last(), Some(Kind::Ordered | Kind::Bullet | Kind::Plain))
	}

	fn number(&mut self, tag: &Element) -> Number {
		let slot = (self.stack.len() - 1).min(11);
		let counter = &mut self.counters[slot];
		if let Some(kind) = number_type(tag) {
			counter.kind = kind;
		}
		let value = attr(tag, "value");
		if value
			.strip_prefix('-')
			.unwrap_or(value)
			.as_bytes()
			.first()
			.is_some_and(u8::is_ascii_digit)
		{
			counter.value = integer(value).max(VOID + 1);
		}
		let number = if counter.value >= VOID {
			if counter.kind != b'1' {
				counter.value = counter.value.max(1);
			}
			let number = *counter;
			counter.value = counter.value.wrapping_add(1);
			number
		} else if let Some(outer) = self.counters[..slot]
			.iter_mut()
			.rev()
			.find(|n| n.value > VOID)
		{
			let number = *outer;
			outer.value = outer.value.wrapping_add(1);
			number
		} else {
			Number { value: self.last.value.wrapping_add(1), ..self.last }
		};
		self.last = number;
		number
	}
}

fn number_type(tag: &Element) -> Option<u8> {
	attr(tag, "type")
		.bytes()
		.next()
		.filter(|c| matches!(c, b'1' | b'a' | b'A' | b'i' | b'I'))
}

// Sequence attributes use the signed decimal prefix, not the HTML number
// parser.
fn integer(input: &str) -> i32 {
	let input = input.trim_ascii_start();
	let digits = input.strip_prefix(['-', '+']).unwrap_or(input);
	let mut value = 0i64;
	for b in digits.bytes().take_while(u8::is_ascii_digit) {
		value = value.saturating_mul(10).saturating_sub(i64::from(b - b'0'));
	}
	(if input.starts_with('-') {
		value
	} else {
		value.saturating_neg()
	}) as i32
}

fn first_number(tag: &Element) -> Number {
	let mut kind = number_type(tag).unwrap_or(b'1');
	let value = if flag(tag, "seqnum") || flag(tag, "start") {
		let value = ["seqnum", "start"]
			.into_iter()
			.map(|key| attr(tag, key))
			.find(|s| !s.is_empty());
		value
			.map_or(1, integer)
			.max(if kind == b'1' { VOID + 1 } else { 1 })
	} else if flag(tag, "continue") {
		kind = b'1';
		CONTINUE
	} else {
		1
	};
	Number { value, kind }
}

impl Number {
	fn label(self, layout: &mut Layout) {
		let mut bytes = SmallVec::<[u8; 16]>::new();
		match self.kind {
			b'a' | b'A' => {
				let mut n = self.value.clamp(1, 18_278);
				while n != 0 {
					n -= 1;
					bytes.push(self.kind + (n % 26) as u8);
					n /= 26;
				}
				bytes.reverse();
			},
			b'i' | b'I' => {
				let mut n = self.value.min(3000);
				for (value, digits) in [
					(1000, "M"),
					(900, "CM"),
					(500, "D"),
					(400, "CD"),
					(100, "C"),
					(90, "XC"),
					(50, "L"),
					(40, "XL"),
					(10, "X"),
					(9, "IX"),
					(5, "V"),
					(4, "IV"),
					(1, "I"),
				] {
					while n >= value {
						bytes.extend_from_slice(digits.as_bytes());
						n -= value;
					}
				}
				if self.kind == b'i' {
					bytes.make_ascii_lowercase();
				}
			},
			_ => {
				bytes.extend_from_slice(self.value.format_into(&mut NumBuffer::new()).as_bytes());
			},
		}
		// All numbers begin at the list's first-line margin, padded to at least
		// two columns.
		layout.style.left = (layout.style.left + 2usize.saturating_sub(bytes.len()))
			.min(layout.columns.saturating_sub(2));
		for b in bytes {
			layout.push(char::from(b));
		}
		layout.push('.');
		layout.marker_space();
	}
}

impl Reader<'_> {
	fn list_style(&mut self, first: usize, rest: usize) {
		let body = self.layout.body();
		self.layout.style(Style { left: first, ..body });
		self.layout.next_left = rest.min(self.layout.columns.saturating_sub(2));
	}

	fn after_marker(&self) -> bool {
		self.lists.marker == Some((self.layout.output.len(), self.layout.line.len()))
	}

	fn list_boundary(&mut self, gap: usize) {
		// Unmarked items and list headers contain nonbreaking padding. Their
		// otherwise empty lines count once even though dumps strip trailing
		// space.
		let empty_marker = self.layout.line.is_empty() && self.after_marker();
		let old_gap = self.layout.gap;
		self.layout.boundary(gap);
		if empty_marker {
			self.layout.gap = old_gap + 1 + gap;
		}
		self.lists.marker = None;
	}

	pub(super) fn break_empty_marker(&mut self) -> bool {
		if self.layout.line.is_empty() && self.after_marker() {
			self.list_boundary(0);
			self.layout.style.left = self.layout.next_left;
			true
		} else {
			false
		}
	}

	pub(super) fn list(&mut self, tag: &Element) {
		let kind = match tag.name() {
			"ol" => Kind::Ordered,
			"ul" if !flag(tag, "plain") && !attr(tag, "type").eq_ignore_ascii_case("plain") => {
				Kind::Bullet
			},
			"dl" | "dlc" => Kind::Description { compact: tag.name() == "dlc" || flag(tag, "compact") },
			_ => Kind::Plain,
		};
		let level = self.lists.stack.len();
		let parent = self.lists.stack.last().copied();
		let (first, rest) = kind.margins(level);
		let old = self.layout.style;
		let old_next = self.layout.next_left;
		let gap = kind.gap().max(parent.map_or(0, Kind::gap));
		let same_style = level > 6
			&& parent.is_some_and(|p| {
				p == kind
					|| matches!((p, kind), (Kind::Ordered, Kind::Bullet) | (Kind::Bullet, Kind::Ordered))
			});
		if !same_style {
			self.list_boundary(gap);
			self.list_style(first, rest);
			self.lists.term_line = Some(self.layout.output.len());
		}
		if kind == Kind::Ordered {
			self.lists.counters[level.min(11)] = first_number(tag);
		}
		self.lists.stack.push(kind);
		self.nodes(tag.children.clone());
		self.lists.stack.pop();
		if kind == Kind::Ordered {
			self.lists.counters[level.min(11)] = UNUSED;
		}
		self.list_boundary(if same_style {
			0
		} else {
			gap.max(usize::from(parent.is_none()))
		});
		self.layout.style(Style { left: old_next, ..old });
		self.lists.term_line = None;
	}

	pub(super) fn list_item(&mut self, tag: &Element) {
		let kind = self.lists.stack.last().copied();
		let level = self.lists.stack.len().saturating_sub(1);
		let body_left = self.layout.body().left;
		let (first, rest) = kind.map_or((body_left, body_left), |k| k.margins(level));
		let gap = kind.map_or(1, Kind::gap);
		// An ordered item's own visible number, which its marker shows.
		let mut own = None;
		match tag.name() {
			"dt" => {
				let on_first_line = self.lists.term_line == Some(self.layout.output.len());
				self.list_boundary(if on_first_line { 0 } else { gap });
				self.list_style(first, rest);
				self.lists.term_line = Some(self.layout.output.len());
			},
			"dd" => {
				self.list_boundary(0);
				self.list_style(rest, rest);
				self.lists.term_line = None;
			},
			name => {
				self.list_boundary(gap);
				self.list_style(first, rest);
				if name == "lh" {
					self.layout.style.left += 1;
				} else {
					match kind {
						Some(Kind::Ordered) => {
							let number = self.lists.number(tag);
							number.label(&mut self.layout);
							if number.kind == b'1' {
								own = own_number(self.dom, self.dropped, tag, i64::from(number.value));
							}
						},
						Some(Kind::Bullet) => {
							self.layout.style.left += 2;
							self.layout.push(char::from(b"*+o#@-="[level % 7]));
							self.layout.marker_space();
						},
						_ => self.layout.style.left += 2,
					}
				}
				self.lists.marker = Some((self.layout.output.len(), self.layout.line.len()));
				self.lists.term_line = Some(self.layout.output.len());
			},
		}
		// Closing LI/DT/DD is not a paragraph break: trailing sibling text stays
		// on this line.
		let outer = self.skip;
		self.skip = own.or(outer);
		self.nodes(tag.children.clone());
		self.skip = outer;
	}

	pub(super) fn list_heading(&mut self, tag: &Element) {
		if !self.layout.line.is_empty() && !self.after_marker() {
			let level = self.lists.stack.len() - 1;
			let (first, rest) = self.lists.stack[level].margins(level);
			self.list_boundary(0);
			self.list_style(first + 1, rest);
		}
		self.nodes(tag.children.clone());
	}

	pub(super) fn list_paragraph(&mut self, tag: &Element) {
		let gap = self.lists.stack.last().copied().map_or(0, Kind::gap);
		if !self.layout.line.is_empty() && !self.after_marker() {
			self.list_boundary(gap);
			self.layout.style = align(tag, self.layout.style);
		}
		self.nodes(tag.children.clone());
		if !self.layout.line.is_empty() && !self.after_marker() {
			self.list_boundary(if tag.name() == "p" { gap } else { 0 });
		}
		self.layout.style.align = Align::Left;
	}
}

#[cfg(test)]
mod tests {
	use super::super::dump;

	#[test]
	fn continuation_borrows_the_outer_sequence_and_remembers_its_type() {
		let html = "<ol seqnum=25junk start=9 type=A><li>outer<ol \
		            continue><li>inner<li>inner</ol>tail<li>outer</ol><ol continue><li>again</ol>";
		assert_eq!(
			dump(html).unwrap(),
			"    Y. outer\n         Z. inner\n        AA. inner\n       tail\n   AB. outer\n\n   AC. \
			 again\n"
		);
	}

	#[test]
	fn labels_change_type_in_place_and_keep_a_fixed_left_margin() {
		let html = "<ol start=-5><li>a<li type=i>b<li value=4001>c<li type=A value=20000>d<li \
		            type=1 value=12345abc>e<br>f</ol>";
		assert_eq!(
			dump(html).unwrap(),
			"   -5. a\n    i. b\n   mmm. c\n   ZZZ. d\n   12345. e\n       f\n"
		);
	}

	#[test]
	fn mixed_lists_share_depth_and_restore_hanging_margins() {
		let html =
			"<ul plain><li>head<br>more<dl><dt>t<dt>u<dd>v<ul><li>w</ul>end<dt>x</dl>tail</ul>body";
		assert_eq!(
			dump(html).unwrap(),
			"     head\n       more\n\n        t\n        u\n                v\n\n               o \
			 w\n\n                end\n\n        x\n\n       tail\n\n   body\n"
		);
	}

	#[test]
	fn compact_descriptions_and_item_end_tags_do_not_force_breaks() {
		let html =
			"a<dl compact><dt>x</dt>tail<dd>y</dd>tail<dl compact><dt>z<dd>desc</dl>more</dl>b";
		assert_eq!(
			dump(html).unwrap(),
			"   a\n   xtail\n          ytail\n        z\n               desc\n          more\n\n   \
			 b\n"
		);
	}

	#[test]
	fn list_headers_and_paragraphs_use_the_current_item_margins() {
		let html = "<ul><lh>head<li><p>first<p>second</p>tail<h3>sub</h3>end<li>last</ul>";
		assert_eq!(
			dump(html).unwrap(),
			"    head\n     * first\n       second\n       tail\n    subend\n     * last\n"
		);
	}

	#[test]
	fn unmarked_items_preserve_empty_lines_and_do_not_accumulate_indent() {
		assert_eq!(dump("<menu><li><li>x</menu>body").unwrap(), "\n     x\n\n   body\n");
		assert_eq!(dump("<ul plain><li><br>x</ul>").unwrap(), "\n       x\n");
		assert_eq!(
			dump("<li>one<li>two<dt>term<dd>def").unwrap(),
			"     one\n\n     two\n   term\n   def\n"
		);
	}

	#[test]
	fn marker_and_long_first_word_stay_together() {
		let html = format!("<ul><li>  {}<p>after</ul>", "x".repeat(240));
		assert_eq!(
			dump(&html).unwrap(),
			format!("     * {}\n       xxx\n       after\n", "x".repeat(237))
		);
	}
}
