//! Render the ordinary text stream first. A simple table is a set of extra
//! blanks inserted into that stream, not a separate HTML-to-string renderer.
use std::ops::Range;

use super::{Align, Element, Layout, Node, Reader, Style, attr};

fn alignment(tag: &Element) -> Option<Align> {
	super::alignment(attr(tag, "align"))
}

fn span(tag: &Element, name: &str) -> usize {
	let value = attr(tag, name);
	let digits = value.bytes().take_while(u8::is_ascii_digit).count();
	// Larger values are ignored by the simple-table layout, not clamped.
	value[..digits]
		.parse()
		.ok()
		.filter(|&n| n <= 200)
		.unwrap_or(1)
}

const fn padding(align: Align, spare: usize) -> usize {
	match align {
		Align::Left => 0,
		Align::Center => spare / 2,
		Align::Right => spare,
	}
}

#[derive(Default, Clone)]
struct Column {
	start:      usize,
	width:      usize,
	// An earlier spanned cell already accounts for space before this edge.
	span_start: Option<usize>,
	free_row:   usize,
}

struct Cell {
	columns: Range<usize>,
	bytes:   Range<usize>,
	width:   usize,
	align:   Align,
}

struct Row {
	bytes:  Range<usize>,
	cells:  Range<usize>,
	// Text that continues from a preceding physical line, before the first
	// tracked cell on this line. Keep its indentation as printed.
	prefix: usize,
}

#[derive(Default)]
struct Cursor {
	column:     usize,
	previous:   Option<(usize, usize)>,
	first_cell: usize,
	prefix:     usize,
}

struct Table {
	columns:            usize,
	align:              Option<Align>,
	initial_cell_space: bool,
	group_align:        Option<Align>,
	col_align:          Vec<Option<Align>>,
	groups:             Vec<usize>,
	rows:               Vec<Row>,
	cells:              Vec<Cell>,
	cols:               Vec<Column>,
	row_number:         usize,
	grid:               bool,
}

impl Table {
	fn new(tag: &Element, columns: usize) -> Self {
		Self {
			columns,
			align: alignment(tag),
			initial_cell_space: true,
			group_align: None,
			col_align: Vec::new(),
			groups: Vec::new(),
			rows: Vec::new(),
			cells: Vec::new(),
			cols: Vec::new(),
			row_number: 0,
			grid: true,
		}
	}

	fn add_columns(&mut self, tag: &Element, group: Option<Align>) {
		let count = span(tag, "span").max(1);
		// Empty columns cost no display space. Bound metadata independently
		// of untrusted numeric attributes, not by allocating for their value.
		let end = self.col_align.len().saturating_add(count).min(self.columns);
		self.col_align.resize(end, alignment(tag).or(group));
	}

	fn advance(&mut self, edge: usize, to: usize, from_width: bool) {
		let mut by = to.saturating_sub(self.cols[edge].start);
		for i in edge..self.cols.len() {
			if from_width && self.cols[i].span_start.is_some_and(|start| start < edge) {
				let previous = &self.cols[i - 1];
				by = to
					.max(previous.start + previous.width)
					.saturating_sub(self.cols[i].start);
			}
			if by == 0 {
				break;
			}
			self.cols[i].start += by;
		}
	}

	fn record(
		&mut self,
		tag: &Element,
		cursor: &mut Cursor,
		row_align: Option<Align>,
		raw: usize,
		bytes: Range<usize>,
		width: usize,
	) {
		let mut col = cursor.column;
		while self
			.cols
			.get(col)
			.is_some_and(|c| c.free_row > self.row_number)
		{
			col += 1;
		}
		let count = match span(tag, "colspan") {
			0 => self
				.groups
				.iter()
				.copied()
				.find(|end| *end > col)
				.unwrap_or_else(|| self.col_align.len().max(self.cols.len().saturating_sub(1)))
				.saturating_sub(col)
				.max(1),
			n => n,
		};
		if count > self.columns || col + count > self.columns {
			self.grid = false;
			return;
		}
		let end = col + count;
		if end >= self.cols.len() {
			let start = self.cols.last().map_or(0, |c| c.start);
			self
				.cols
				.resize(end + 1, Column { start, ..Default::default() });
		}
		let rowspan = span(tag, "rowspan");
		let until = match rowspan {
			0 => usize::MAX,
			1 => self.row_number,
			n => self.row_number.saturating_add(n),
		};
		for c in &mut self.cols[col..end] {
			c.free_row = until;
		}
		if count > 1 {
			self.cols[end].span_start = Some(self.cols[end].span_start.unwrap_or(col).min(col));
		}
		let start = cursor
			.previous
			.map_or(raw, |(prev, pos)| self.cols[prev].start + raw.saturating_sub(pos));
		self.advance(col, start, false);
		if count == 1 {
			self.cols[col].width = self.cols[col].width.max(width);
		}
		if width != 0 {
			let to = (raw + width).max(self.cols[end - 1].start + self.cols[end - 1].width);
			self.advance(end, to, true);
		}
		let align = alignment(tag)
			.or_else(|| self.col_align.get(col).copied().flatten())
			.or(row_align)
			.unwrap_or_else(|| {
				if tag.name() == "th" {
					Align::Center
				} else {
					Align::Left
				}
			});
		self
			.cells
			.push(Cell { columns: col..end, bytes, width, align });
		cursor.previous = Some((col, raw));
		cursor.column = end;
	}

	fn finish_line(&mut self, cursor: &Cursor, bytes: Range<usize>, indent: usize, output: &str) {
		if cursor.first_cell == self.cells.len() {
			return;
		}
		for cell in &mut self.cells[cursor.first_cell..] {
			cell.bytes.start += indent;
			cell.bytes.end += indent;
		}
		let prefix = if cursor.prefix == 0 {
			0
		} else {
			indent + cursor.prefix
		};
		let line = &output[bytes.clone()];
		// Inline controls or a block can replace the current style and split
		// the line at an earlier word. Only apply positions still referring
		// to complete characters in the physical line that was printed.
		if !line.is_char_boundary(prefix.min(line.len()))
			|| self.cells[cursor.first_cell..].iter().any(|cell| {
				!line.is_char_boundary(cell.bytes.start.min(line.len()))
					|| !line.is_char_boundary(cell.bytes.end.min(line.len()))
			}) {
			self.grid = false;
			return;
		}
		self
			.rows
			.push(Row { bytes, cells: cursor.first_cell..self.cells.len(), prefix });
	}

	fn position(&self, cell: &Cell) -> usize {
		let col = &self.cols[cell.columns.start];
		let width = self.cols[cell.columns.end]
			.start
			.saturating_sub(col.start + 1)
			.max(col.width);
		col.start + padding(cell.align, width.saturating_sub(cell.width))
	}

	fn fixup(&self, layout: &mut Layout, parent: Style) {
		if !self.grid || self.rows.is_empty() {
			return;
		}
		let cols = layout.columns;
		let width = self
			.cells
			.iter()
			.filter(|c| c.width != 0)
			.map(|c| self.position(c) + c.width)
			.max()
			.unwrap_or(0);
		if width > cols {
			return;
		}
		let left = parent.left.min(cols - width);
		let offset = left
			+ padding(self.align.unwrap_or(parent.align), parent.end.saturating_sub(left + width));
		let start = self.rows[0].bytes.start;
		let original = layout.output.split_off(start);
		let mut previous = start;
		for row in &self.rows {
			let gap_seg = &original[previous - start..row.bytes.start - start];

			layout.output.push_str(gap_seg);
			let contents = &original[row.bytes.start - start..row.bytes.end - start];
			let raw_prefix = &contents[..row.prefix.min(contents.len())];
			let prefix = raw_prefix.trim_start_matches(' ');
			let mut column = if prefix.is_empty() {
				0
			} else {
				layout.output.extend(std::iter::repeat_n(' ', offset));

				layout.output.push_str(prefix);
				offset + prefix.chars().count()
			};
			for cell in &self.cells[row.cells.clone()] {
				if cell.bytes.start >= contents.len() || cell.width == 0 {
					continue;
				}
				let cell_end = cell.bytes.end.min(contents.len());
				let cell_str = &contents[cell.bytes.start..cell_end];
				let pos = offset + self.position(cell);
				let actual_pos = pos.max(column);
				layout
					.output
					.extend(std::iter::repeat_n(' ', pos.saturating_sub(column)));

				layout.output.push_str(cell_str);
				column = actual_pos + cell.width;
			}
			previous = row.bytes.end;
		}
		let tail = &original[previous - start..];

		layout.output.push_str(tail);
	}
}

impl Reader<'_> {
	pub(super) fn table(&mut self, tag: &Element) {
		if self.pre {
			return self.literal_table(tag.children.clone());
		}
		let nested = self.table_grid.replace(true).is_some();
		if nested && self.layout.output.is_empty() && self.layout.line.is_empty() {
			self.layout.gap = 1;
		}
		self.layout.boundary(usize::from(!nested));
		let old = self.layout.style;

		let mut table = Table::new(tag, self.layout.columns);
		if self.layout.output.is_empty()
			&& let Some(i) = tag.children.start.checked_sub(2)
			&& i > 0
			&& let Node::Text(text) = &self.dom[i]
			&& text.trim_ascii().is_empty()
		{
			table.initial_cell_space = false;
		}
		let body = self.layout.body();
		self
			.layout
			.style(Style { align: table.align.unwrap_or(Align::Left), ..body });
		self.table_parts(tag.children.clone(), &mut table);
		self
			.layout
			.boundary(usize::from(!nested && self.lists.is_empty()));
		if self.table_grid == Some(true) {
			table.fixup(&mut self.layout, old);
		}
		self.table_grid = nested.then_some(false);
		self.layout.style(old);
	}

	fn literal_table(&mut self, range: Range<usize>) {
		let mut i = range.start;
		while i < range.end {
			if self.is_skipped(i) {
				i = match &self.dom[i] {
					Node::Text(_) => i + 1,
					Node::Tag(tag) => tag.children.end,
				};
				continue;
			}
			let Node::Tag(tag) = &self.dom[i] else {
				self.nodes(i..i + 1);
				i += 1;
				continue;
			};
			match tag.name() {
				"tr" => {
					self.layout.boundary(0);
					self.literal_table(tag.children.clone());
					self.layout.boundary(0);
				},
				"td" | "th" => {
					self.layout.push(' ');
					self.nodes(tag.children.clone());
				},
				"caption" => {
					self.layout.boundary(1);
					self.layout.literal("CAPTION: ");
					self.nodes(tag.children.clone());
					self.layout.boundary(1);
				},
				"thead" | "tbody" | "tfoot" => self.literal_table(tag.children.clone()),
				_ => self.element(tag),
			}
			i = tag.children.end;
		}
	}

	fn table_parts(&mut self, range: Range<usize>, table: &mut Table) {
		let mut i = range.start;
		while i < range.end {
			if self.is_skipped(i) {
				i = match &self.dom[i] {
					Node::Text(_) => i + 1,
					Node::Tag(tag) => tag.children.end,
				};
				continue;
			}
			let Node::Tag(tag) = &self.dom[i] else {
				if self.layout.output.is_empty()
					&& table.initial_cell_space
					&& let Node::Text(t) = &self.dom[i]
					&& t.trim_ascii().is_empty()
				{
					table.initial_cell_space = false;
					if !t.contains(['\r', '\n']) {
						self.layout.gap = 1;
					}
				}
				self.nodes(i..i + 1);
				i += 1;
				continue;
			};
			match tag.name() {
				"tr" => self.table_row(tag, table),
				"thead" | "tbody" | "tfoot" => {
					for c in &mut table.cols {
						c.free_row = 0;
					}
					table.group_align = alignment(tag);
					self.table_parts(tag.children.clone(), table);
				},
				"colgroup" => {
					let start = table.col_align.len();
					for (_, child) in super::selected_nodes(self.dom, self.dropped, tag.children.clone())
					{
						if let Node::Tag(col) = child
							&& col.name() == "col"
						{
							table.add_columns(col, alignment(tag));
						}
					}
					if table.col_align.len() == start {
						table.add_columns(tag, None);
					}
					table.groups.push(table.col_align.len());
				},
				"col" => table.add_columns(tag, None),
				"caption" => {
					self.layout.boundary(1);
					self.layout.text("CAPTION: ");
					self.nodes(tag.children.clone());
					self.layout.boundary(1);
				},
				"td" | "th" => {
					table.grid = false;
					if self.layout.output.is_empty() && self.layout.line.is_empty() {
						self.layout.style.left = self.layout.body().left + 1;
					}
					self.layout.space = !self.layout.line.is_empty();
					self.nodes(tag.children.clone());
				},
				_ => self.element(tag),
			}
			i = tag.children.end;
		}
	}

	fn table_row(&mut self, row: &Element, table: &mut Table) {
		self.layout.boundary(0);
		let first = self.layout.output.is_empty() && table.initial_cell_space;
		let old = self.layout.style;
		let row_align = alignment(row);
		let inherited = row_align.or(table.group_align).or(table.align);
		let body = self.layout.body();
		let style = Style {
			left: body.left + usize::from(first),
			align: row_align.or(table.align).unwrap_or(Align::Left),
			..body
		};
		self.layout.style(style);
		self.layout.next_left = body.left;
		let mut cursor = Cursor { first_cell: table.cells.len(), ..Default::default() };
		let mut i = row.children.start;
		while i < row.children.end {
			if self.is_skipped(i) {
				i = match &self.dom[i] {
					Node::Text(_) => i + 1,
					Node::Tag(tag) => tag.children.end,
				};
				continue;
			}
			let Node::Tag(tag) = &self.dom[i] else {
				if let Node::Text(t) = &self.dom[i] {
					if !t.trim_ascii().is_empty() {
						table.grid = false;
					} else if first && cursor.column == 0 && t.contains(['\r', '\n']) {
						self.layout.style.left = body.left;
					}
				}
				self.nodes(i..i + 1);
				i += 1;
				continue;
			};
			if matches!(tag.name(), "td" | "th") {
				self.table_cell(tag, table, &mut cursor, inherited);
			} else {
				table.grid = false;
				self.element(tag);
			}
			i = tag.children.end;
		}
		let begin = self.layout.output.len() + self.layout.gap;
		let indent = self.layout.style.left
			+ padding(
				self.layout.style.align,
				self
					.layout
					.style
					.end
					.saturating_sub(self.layout.style.left + self.layout.length),
			);
		if first
			&& self.layout.line.is_empty()
			&& cursor.first_cell < table.cells.len()
			&& self.layout.output.is_empty()
		{
			self.layout.gap = 1;
		}
		self.layout.boundary(0);
		if table.grid && self.layout.output.len() > begin {
			table.finish_line(
				&cursor,
				begin..self.layout.output.len() - 1,
				indent,
				&self.layout.output,
			);
		}
		table.row_number += 1;
		self.layout.style(old);
	}

	fn table_cell(
		&mut self,
		tag: &Element,
		table: &mut Table,
		cursor: &mut Cursor,
		inherited: Option<Align>,
	) {
		let before = self.layout.output.len();
		let line_style = self.layout.style;
		let byte = self.layout.line.len();
		let length = self.layout.length;
		let raw =
			length + usize::from(byte != 0) + line_style.left.saturating_sub(self.layout.body().left);
		self.layout.space = byte != 0;
		self.nodes(tag.children.clone());
		if self.table_grid == Some(false) {
			table.grid = false;
		}
		if !table.grid {
			return;
		}

		// A leading control can request its own separator even in an empty
		// row. Unlike a literal &nbsp;, it doesn't belong to the cell.
		let separated = byte != 0
			|| super::selected_nodes(self.dom, self.dropped, tag.children.clone())
				.find_map(|(_, n)| match n {
					Node::Text(t) if t.trim_ascii().is_empty() => None,
					Node::Tag(t) if matches!(t.name(), "input" | "select" | "img" | "button") => {
						Some(true)
					},
					Node::Tag(_) => None,
					_ => Some(false),
				})
				.unwrap_or(false);

		if self.layout.output.len() == before {
			let separator =
				usize::from(separated && self.layout.line.as_bytes().get(byte) == Some(&b' '));
			let start = byte + separator;
			table.record(
				tag,
				cursor,
				inherited,
				raw,
				start..self.layout.line.len(),
				self.layout.length.saturating_sub(length + separator),
			);
			return;
		}

		// A break can occur *at* a cell boundary (e.g. <td>text<br>),
		// or at the start of the row's first cell. Both leave the other
		// physical lines eligible for column fixups. Interleaved text in a
		// later cell cannot be shifted without damaging its continuation.
		let emitted = &self.layout.output[before..];
		let begin = before + emitted.bytes().take_while(|&b| b == b'\n').count();
		if let Some((line, _)) = self.layout.output[begin..].split_once('\n') {
			let indent = match line_style.align {
				Align::Left => line_style
					.left
					.min(line.len() - line.trim_start_matches(' ').len()),
				_ => line.len() - line.trim_start_matches(' ').len(),
			};
			let content = &line[indent..];
			let separator = usize::from(separated && content.as_bytes().get(byte) == Some(&b' '));
			let start = (byte + separator).min(content.len());
			if !content.is_char_boundary(start) {
				table.grid = false;
				return;
			}
			let width = content[start..].chars().count();
			if cursor.column > 0 && width > 0 && !self.layout.line.is_empty() {
				table.grid = false;
				return;
			}
			if width != 0 {
				table.record(tag, cursor, inherited, raw, start..content.len(), width);
			}
			if cursor.column > 1 || self.layout.line.is_empty() {
				table.finish_line(cursor, begin..begin + line.len(), indent, &self.layout.output);
			}
		}
		*cursor = Cursor {
			first_cell: table.cells.len(),
			prefix: self.layout.line.len(),
			..Default::default()
		};
	}
}

#[cfg(test)]
mod tests {
	use super::super::dump;

	#[test]
	fn cell_column_row_group_precedence_and_rendered_caption() {
		let html = "<table><caption><q>Inventory</q></caption><colgroup align=right><col><col \
		            align=left></colgroup><tbody \
		            align=center><tr><td>A<td><q>Y</q><td>C<tr><td>AAAA<td><input size=5 \
		            value=hi><td>CCCCC</table>";
		assert_eq!(
			dump(html).unwrap(),
			"   CAPTION: \"Inventory\"\n\n      A \"Y\"     C\n   AAAA hi___ CCCCC\n"
		);
	}

	#[test]
	fn spanning_cells_and_reserved_columns() {
		let html = "<table><tr><th colspan=2>Spanning<td>X<tr><td \
		            rowspan=2>A<td>BBB<td>column<tr><td>z<td>x</table>";
		assert_eq!(dump(html).unwrap(), "    Spanning  X\n    A BBB     column\n      z       x\n");
	}

	#[test]
	fn nested_grid_preserves_inline_text_and_fields() {
		let html = "<table><tr><td>Outer<table><tr><td><q>I</q><td>Row<tr><td>Inner<td><input \
		            size=3 value=x></table>After<td>End</table>";
		assert_eq!(dump(html).unwrap(), "    Outer\n   \"I\"   Row\n   Inner x__\n   After End\n");
	}

	#[test]
	fn multiline_first_cell_and_trailing_break_keep_other_rows_aligned() {
		let html = "<table><tr><td>α<br>γ<td>δ<tr><td>a<td>z</table>";
		assert_eq!(dump(html).unwrap(), "    α\n   γ δ\n     a z\n");
		let html = "<table><tr><td>A<td>B<br><tr><td>long<td>x</table>";
		assert_eq!(dump(html).unwrap(), "    A    B\n    long x\n");
	}

	#[test]
	fn indentation_newline_before_first_cell_does_not_widen_grid() {
		let html = "<table>\n  <tr><td>foo<td>bar<tr><td>x<td>y</table>";
		assert_eq!(dump(html).unwrap(), "   foo bar\n   x   y\n");
	}

	#[test]
	fn table_inside_pre_has_literal_cell_separators() {
		let html = "<pre>Before<table><tr><td>A<td>Long<tr><td>ABCD<td>Z</table>After</pre>";
		assert_eq!(dump(html).unwrap(), "Before\n A Long\n ABCD Z\nAfter\n");
	}

	#[test]
	fn multiline_cell_keeps_original_text_flow() {
		let html = "<table><tr><td>head<td>tail<br>next<tr><td>x<td>123</table>";
		assert_eq!(dump(html).unwrap(), "    head tail\n   next\n   x 123\n");
	}
}
