use omp_core::{Str, StrMut};
use smallvec::SmallVec;
use xutf::Text;

use super::{Alignment, MdTheme, parse_inline};
use crate::{
	frame::Style,
	rich::{Pipeline, RichSink, RichText, SPACES, cell_width},
};

const MAX_UNBROKEN_WORD_WIDTH: u16 = 30;

type ColumnWidths = SmallVec<u16, 8>;

fn measurements(line: &RichText) -> (u16, u16) {
	let mut widest_line = 0_u16;
	let mut widest_word = 0_u16;
	let mut word_width = 0_u16;
	for row in 0..line.rows() {
		widest_line = widest_line.max(line.row_width(row));
		for (_, text) in line.row_runs(row) {
			for grapheme in text.graphemes() {
				let width = cell_width(grapheme);
				if grapheme.chars().all(char::is_whitespace) {
					widest_word = widest_word.max(word_width);
					word_width = 0;
				} else {
					word_width = word_width.saturating_add(width);
				}
			}
		}
		widest_word = widest_word.max(word_width);
		word_width = 0;
	}
	(widest_line, widest_word.clamp(1, MAX_UNBROKEN_WORD_WIDTH))
}

fn allocate_columns(natural: &[u16], minimum_words: &[u16], available: u16) -> ColumnWidths {
	let columns = natural.len();
	let mut minimum: ColumnWidths = minimum_words.iter().copied().collect();
	let mut minimum_total = minimum.iter().copied().fold(0_u16, u16::saturating_add);
	if minimum_total > available {
		minimum.fill(1);
		let remaining = available.saturating_sub(u16::try_from(columns).unwrap_or(u16::MAX));
		if remaining > 0 {
			let total_weight: u32 = minimum_words
				.iter()
				.map(|width| u32::from(width.saturating_sub(1)))
				.sum();
			let mut allocated = 0_u16;
			for (slot, word_width) in minimum.iter_mut().zip(minimum_words) {
				let weight = u32::from(word_width.saturating_sub(1));
				let growth = (weight * u32::from(remaining))
					.checked_div(total_weight)
					.map_or(0, |val| u16::try_from(val).unwrap_or(u16::MAX));
				*slot = slot.saturating_add(growth);
				allocated = allocated.saturating_add(growth);
			}
			let mut leftover = remaining.saturating_sub(allocated);
			for slot in &mut minimum {
				if leftover == 0 {
					break;
				}
				*slot += 1;
				leftover -= 1;
			}
		}
		minimum_total = minimum.iter().copied().fold(0_u16, u16::saturating_add);
	}

	let natural_total = natural.iter().copied().fold(0_u16, u16::saturating_add);
	if natural_total <= available {
		return natural
			.iter()
			.zip(&minimum)
			.map(|(natural, minimum)| (*natural).max(*minimum))
			.collect();
	}

	let grow_potential: u32 = natural
		.iter()
		.zip(&minimum)
		.map(|(natural, minimum)| u32::from(natural.saturating_sub(*minimum)))
		.sum();
	let extra = available.saturating_sub(minimum_total);
	let mut widths: ColumnWidths = natural
		.iter()
		.zip(&minimum)
		.map(|(natural, minimum)| {
			let delta = u32::from(natural.saturating_sub(*minimum));
			let growth = (delta * u32::from(extra))
				.checked_div(grow_potential)
				.map_or(0, |val| u16::try_from(val).unwrap_or(u16::MAX));
			(*minimum).saturating_add(growth)
		})
		.collect();

	let allocated = widths.iter().copied().fold(0_u16, u16::saturating_add);
	let mut remaining = available.saturating_sub(allocated);
	while remaining > 0 {
		let mut grew = false;
		for (index, width) in widths.iter_mut().enumerate() {
			if remaining == 0 {
				break;
			}
			if *width < natural[index] {
				*width += 1;
				remaining -= 1;
				grew = true;
			}
		}
		if !grew {
			break;
		}
	}
	widths
}

fn border(widths: &[u16], (left, junction, right): (char, char, char), fill: char) -> Str {
	let characters = widths
		.iter()
		.copied()
		.fold(widths.len().saturating_add(1), |total, width| {
			total.saturating_add(usize::from(width.saturating_add(2)))
		});
	let mut output = StrMut::with_capacity(characters.saturating_mul(3));
	output.push(left);
	for (index, width) in widths.iter().enumerate() {
		for _ in 0..width.saturating_add(2) {
			output.push(fill);
		}
		output.push(if index + 1 == widths.len() {
			right
		} else {
			junction
		});
	}
	output.freeze()
}

fn push_spaces(sink: &mut dyn RichSink, style: Style, mut count: u16) {
	while count != 0 {
		let chunk = usize::from(count).min(SPACES.len());
		sink.run(style, &SPACES[..chunk]);
		count -= u16::try_from(chunk).unwrap_or(count);
	}
}

fn raw_row(cells: &[&str]) -> Str {
	let mut output = StrMut::new("| ");
	for (index, cell) in cells.iter().enumerate() {
		if index != 0 {
			output.push_str(" | ");
		}
		output.push_str(cell);
	}
	output.push_str(" |");
	output.freeze()
}

fn push_fallback(sink: &mut dyn RichSink, raw: Str, width: u16, theme: &MdTheme) {
	let mut wrap = (&mut *sink).wrap(width);
	wrap.run(theme.base, raw.as_str());
	wrap.finish();
	sink.newline();
}

fn fallback_table(
	rows: &[Vec<&str>],
	alignments: &[Alignment],
	width: u16,
	theme: &MdTheme,
	sink: &mut dyn RichSink,
) {
	if let Some(header) = rows.first() {
		push_fallback(sink, raw_row(header), width, theme);
		let mut separator = StrMut::new("| ");
		for (index, alignment) in alignments.iter().enumerate() {
			if index != 0 {
				separator.push_str(" | ");
			}
			separator.push_str(match alignment {
				Alignment::Left => "---",
				Alignment::Center => ":---:",
				Alignment::Right => "---:",
			});
		}
		separator.push_str(" |");
		push_fallback(sink, separator.freeze(), width, theme);
	}
	for row in rows.iter().skip(1) {
		push_fallback(sink, raw_row(row), width, theme);
	}
}

/// Renders a GFM table as a box-bordered grid using shared column allocation.
pub fn render_table(
	rows: &[Vec<&str>],
	alignments: &[Alignment],
	width: u16,
	theme: &MdTheme,
	sink: &mut dyn RichSink,
) {
	let columns = alignments.len();
	if columns == 0 || rows.is_empty() {
		return;
	}
	let border_overhead =
		u16::try_from(columns.saturating_mul(3).saturating_add(1)).unwrap_or(u16::MAX);
	let available = width.saturating_sub(border_overhead);
	if width < border_overhead || available < u16::try_from(columns).unwrap_or(u16::MAX) {
		fallback_table(rows, alignments, width, theme, sink);
		return;
	}

	let parsed: Vec<SmallVec<RichText, 8>> = rows
		.iter()
		.map(|row| {
			(0..columns)
				.map(|column| {
					let mut cell = RichText::default();
					if let Some(text) = row.get(column) {
						parse_inline(text, theme, theme.base, &mut cell);
					}
					cell
				})
				.collect()
		})
		.collect();
	let mut natural: ColumnWidths = smallvec::smallvec![0_u16; columns];
	let mut minimum: ColumnWidths = smallvec::smallvec![1_u16; columns];
	for row in &parsed {
		for (column, cell) in row.iter().enumerate() {
			let (line, word) = measurements(cell);
			natural[column] = natural[column].max(line);
			minimum[column] = minimum[column].max(word);
		}
	}
	let widths = allocate_columns(&natural, &minimum, available);
	let grid = theme.charset.grid();
	let top = border(&widths, grid.top, grid.fill);
	let middle = border(&widths, grid.middle, grid.fill);
	let bottom = border(&widths, grid.bottom, grid.fill);

	sink.run(theme.base, top.as_str());
	sink.newline();
	for (row_index, row) in parsed.iter().enumerate() {
		let wrapped: SmallVec<RichText, 8> = row
			.iter()
			.enumerate()
			.map(|(column, cell)| {
				let mut output = RichText::default();
				let mut wrap = (&mut output).wrap(widths[column]);
				if cell.rows() != 0 {
					cell.replay_row(0, &mut wrap);
				}
				wrap.finish();
				output
			})
			.collect();
		let height = wrapped.iter().map(RichText::rows).max().unwrap_or(1);
		for line_index in 0..height {
			sink.run(theme.base, grid.lead);
			for column in 0..columns {
				let cell = &wrapped[column];
				let cell_width = if line_index < cell.rows() {
					cell.row_width(line_index)
				} else {
					0
				};
				let padding = widths[column].saturating_sub(cell_width);
				let (before, after) = match alignments[column] {
					Alignment::Left => (0, padding),
					Alignment::Center => (padding / 2, padding - padding / 2),
					Alignment::Right => (padding, 0),
				};
				let padding_style = if row_index == 0 {
					theme.base.bold()
				} else {
					theme.base
				};
				push_spaces(sink, padding_style, before);
				if line_index < cell.rows() {
					if row_index == 0 {
						let mut bold = (&mut *sink).restyle(Style::bold);
						cell.replay_row(line_index, &mut bold);
					} else {
						cell.replay_row(line_index, sink);
					}
				}
				push_spaces(sink, padding_style, after);
				sink.run(
					theme.base,
					if column + 1 == columns {
						grid.tail
					} else {
						grid.mid
					},
				);
			}
			sink.newline();
		}
		if row_index == 0 || row_index + 1 < parsed.len() {
			sink.run(theme.base, middle.as_str());
			sink.newline();
		}
	}
	sink.run(theme.base, bottom.as_str());
	sink.newline();
}

#[cfg(test)]
mod tests {
	use super::*;

	fn texts(lines: &RichText) -> Vec<String> {
		(0..lines.rows())
			.map(|row| lines.row_text(row).to_owned())
			.collect()
	}

	#[test]
	fn allocation_natural_and_proportional_squeeze() {
		assert_eq!(allocate_columns(&[4, 7], &[2, 3], 11), [4, 7]);
		assert_eq!(allocate_columns(&[10, 20], &[4, 5], 18), [7, 11]);
	}

	#[test]
	fn allocation_scales_word_floors() {
		assert_eq!(allocate_columns(&[20, 20], &[10, 20], 8), [3, 5]);
	}

	#[test]
	fn borders_alignment_wrapping_and_bold_header() {
		let text = "Name|Description|A|A very long value";
		let rows = vec![vec![&text[..4], &text[5..16]], vec![&text[17..18], &text[19..]]];
		let theme = MdTheme::default();
		let mut output = RichText::default();
		render_table(&rows, &[Alignment::Right, Alignment::Center], 24, &theme, &mut output);
		let plain = texts(&output);
		assert!(plain[0].starts_with('┌') && plain[0].contains('┬') && plain[0].ends_with('┐'));
		assert!(
			plain
				.iter()
				.any(|line| line.starts_with('├') && line.contains('┼') && line.ends_with('┤'))
		);
		assert!(plain.last().unwrap().starts_with('└') && plain.last().unwrap().ends_with('┘'));
		assert!(plain.len() > 5, "the long data cell wraps to multiple rows");
		assert!(
			output
				.row_runs(1)
				.any(|(style, text)| style == theme.base.bold() && text.contains('N'))
		);
		assert!(plain[1].contains(" Name │"), "right alignment pads before the first header");
	}

	#[test]
	fn aligns_header_and_body_cells_by_column() {
		let rows = vec![vec!["L", "C", "R"], vec!["long", "wide", "full"], vec!["x", "y", "z"]];
		let mut output = RichText::default();
		render_table(
			&rows,
			&[Alignment::Left, Alignment::Center, Alignment::Right],
			24,
			&MdTheme::default(),
			&mut output,
		);
		assert_eq!(texts(&output), [
			"┌──────┬──────┬──────┐",
			"│ L    │  C   │    R │",
			"├──────┼──────┼──────┤",
			"│ long │ wide │ full │",
			"├──────┼──────┼──────┤",
			"│ x    │  y   │    z │",
			"└──────┴──────┴──────┘",
		]);
	}

	#[test]
	fn exact_small_table_rows() {
		let rows = vec![vec!["A", "B"], vec!["1", "2"]];
		let mut output = RichText::default();
		render_table(
			&rows,
			&[Alignment::Left, Alignment::Left],
			20,
			&MdTheme::default(),
			&mut output,
		);
		assert_eq!(texts(&output), ["┌───┬───┐", "│ A │ B │", "├───┼───┤", "│ 1 │ 2 │", "└───┴───┘"]);
	}
}
