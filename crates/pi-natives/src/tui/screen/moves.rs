//! Row-move planning for paints a terminal may present half-applied.
//!
//! Without synchronized output (DEC 2026) a terminal can show any prefix of a
//! frame's bytes. Repainting a viewport whose content shifted row by row,
//! top-down, then exposes rows already rewritten above rows that have not moved
//! yet, and the seam shows the shifted rows twice. Moving the surviving rows
//! with delete-line/insert-line first keeps every intermediate screen a
//! coherent, shifted copy of the previous frame, and leaves only the rows that
//! really changed to rewrite.
//!
//! Rows are integer keys: [`BLANK_ROW`] for an empty row, [`UNKNOWN_ROW`] for
//! committed history the planner does not model (never matched, never moved),
//! and any other value for one distinct line.

use crate::term::Batch;

/// Key of an empty row.
pub(crate) const BLANK_ROW: i32 = 0;
/// Key of a row whose content is not modeled; it matches nothing.
pub(crate) const UNKNOWN_ROW: i32 = -1;

/// `count` rows starting at screen row `from` move to start at `to`; the rows
/// they vacate turn blank.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct RowMove {
	pub from:  usize,
	pub to:    usize,
	pub count: usize,
}

/// The band move that turns the most rows of `screen` into `target`, or `None`
/// when no move saves a row rewrite. Only rows at or below `base` are moved or
/// vacated. An upward move never lands on row 0: it deletes lines at its
/// destination, and Terminal.app archives lines deleted from the top row into
/// scrollback.
///
/// `screen` and `target` describe the same rows and must be equally long.
pub(crate) fn find_row_move(screen: &[i32], target: &[i32], base: usize) -> Option<RowMove> {
	debug_assert_eq!(screen.len(), target.len());
	let height = screen.len();
	// sums[r].0: rows above r already matching in place; sums[r].1: rows above
	// r whose target is blank (a vacated row then matches).
	let mut sums = Vec::with_capacity(height + 1);
	let (mut hits, mut blanks) = (0isize, 0isize);
	sums.push((hits, blanks));
	for r in 0..height {
		hits += isize::from(target[r] != UNKNOWN_ROW && screen[r] == target[r]);
		blanks += isize::from(target[r] == BLANK_ROW);
		sums.push((hits, blanks));
	}
	let hits = |from: usize, to: usize| sums[to].0 - sums[from].0;
	let blanks = |from: usize, to: usize| sums[to].1 - sums[from].1;

	let mut best = None;
	let mut best_gain = 0isize;
	// Nearer shifts first, so a tie keeps the smaller move.
	for distance in 1..height.saturating_sub(base) {
		// `up`: rows move toward row 0, taking the content `distance` rows below.
		for up in [true, false] {
			let first = if up { base.max(1) } else { base + distance };
			let last = if up { height - distance } else { height };
			let source = |r: usize| if up { r + distance } else { r - distance };
			let mut start = None;
			let mut content = false;
			for r in first..=last {
				if r < last && target[r] != UNKNOWN_ROW && screen[source(r)] == target[r] {
					start.get_or_insert(r);
					content |= target[r] != BLANK_ROW;
					continue;
				}
				if let Some(start) = start
					&& content
				{
					let count = r - start;
					// Rows the move rewrites: its destination plus the band it
					// vacates.
					let (vacated_start, vacated_end) = if up {
						(r, r + distance)
					} else {
						(start - distance, start)
					};
					let gain = count as isize - hits(start, r) + blanks(vacated_start, vacated_end)
						- hits(vacated_start, vacated_end);
					if gain > best_gain {
						best = Some(RowMove { from: source(start), to: start, count });
						best_gain = gain;
					}
				}
				start = None;
				content = false;
			}
		}
	}
	best
}

/// Apply `mv` to a screen model, as [`emit_row_move`] applies it to the
/// terminal.
pub(crate) fn apply_row_move(screen: &mut [i32], mv: RowMove) {
	let RowMove { from, to, count } = mv;
	// The destination band never overlaps the rows the move vacates.
	screen.copy_within(from..from + count, to);
	if from < to {
		screen[from..to].fill(BLANK_ROW);
	} else {
		screen[to + count..from + count].fill(BLANK_ROW);
	}
}

/// Append the ops performing `mv` on a `height`-row screen with default
/// margins: rows outside the band and its vacated rows keep their place. Lines
/// inserted or deleted take the current background, so callers reset SGR
/// first.
pub(crate) fn emit_row_move(batch: &mut Batch<'_>, mv: RowMove, height: usize) {
	let RowMove { from, to, count } = mv;
	// Screen rows and shifts are bounded by the terminal height.
	let row = |index: usize| index as u32 + 1;
	if to < from {
		let shift = (from - to) as u32;
		batch.move_to(row(to), 1).delete_lines(shift);
		if from + count < height {
			batch.move_to(row(to + count), 1).insert_lines(shift);
		}
		return;
	}
	let shift = (to - from) as u32;
	if to + count < height {
		batch.move_to(row(from + count), 1).delete_lines(shift);
	}
	batch.move_to(row(from), 1).insert_lines(shift);
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::term::Device;

	/// Plan and apply moves until none helps; returns the moves and the model.
	fn settle(mut screen: Vec<i32>, target: &[i32], base: usize) -> (Vec<RowMove>, Vec<i32>) {
		let mut moves = Vec::new();
		while let Some(mv) = find_row_move(&screen, target, base) {
			apply_row_move(&mut screen, mv);
			moves.push(mv);
			assert!(moves.len() <= screen.len(), "every move must gain a row");
		}
		(moves, screen)
	}

	fn emitted(mv: RowMove, height: usize) -> String {
		let mut device = Device::capture();
		device.emit(|batch| emit_row_move(batch, mv, height));
		String::from_utf8(device.take_output().concat()).unwrap()
	}

	#[test]
	fn identical_screens_need_no_move() {
		assert_eq!(find_row_move(&[1, 2, 3, 0], &[1, 2, 3, 0], 0), None);
		assert_eq!(find_row_move(&[], &[], 0), None);
	}

	#[test]
	fn scrolled_content_moves_up_as_one_band() {
		// Row 1 scrolled away; rows 2..5 survive one row higher and a new row
		// appears at the bottom.
		let screen = [9, 1, 2, 3, 4, 5];
		let target = [9, 2, 3, 4, 5, 6];
		let mv = find_row_move(&screen, &target, 0).unwrap();
		assert_eq!(mv, RowMove { from: 2, to: 1, count: 4 });
		let (moves, settled) = settle(screen.to_vec(), &target, 0);
		assert_eq!(moves, [mv]);
		// Only the vacated bottom row is left to rewrite.
		assert_eq!(settled, [9, 2, 3, 4, 5, BLANK_ROW]);
	}

	#[test]
	fn inserted_row_moves_the_tail_down() {
		let screen = [1, 2, 3, 4, BLANK_ROW];
		let target = [1, 7, 2, 3, 4];
		let mv = find_row_move(&screen, &target, 0).unwrap();
		assert_eq!(mv, RowMove { from: 1, to: 2, count: 3 });
		let mut model = screen.to_vec();
		apply_row_move(&mut model, mv);
		assert_eq!(model, [1, BLANK_ROW, 2, 3, 4]);
	}

	#[test]
	fn an_upward_move_never_lands_on_the_top_row() {
		// Everything shifts up by one, but deleting at row 0 would archive the
		// line into Terminal.app scrollback: the band starts at row 1.
		let screen = [1, 2, 3, 4];
		let target = [2, 3, 4, 5];
		assert_eq!(find_row_move(&screen, &target, 0), Some(RowMove { from: 2, to: 1, count: 2 }));
	}

	#[test]
	fn rows_above_the_base_are_neither_moved_nor_vacated() {
		let screen = [UNKNOWN_ROW, UNKNOWN_ROW, 1, 2, 3];
		let target = [UNKNOWN_ROW, UNKNOWN_ROW, 2, 3, 4];
		assert_eq!(find_row_move(&screen, &target, 2), Some(RowMove { from: 3, to: 2, count: 2 }));
		// A downward move may not vacate history either.
		let screen = [1, 2, 3, BLANK_ROW];
		let target = [UNKNOWN_ROW, 1, 2, 3];
		assert_eq!(find_row_move(&screen, &target, 1), Some(RowMove { from: 1, to: 2, count: 2 }));
	}

	#[test]
	fn unknown_rows_match_nothing() {
		let screen = [UNKNOWN_ROW, UNKNOWN_ROW, UNKNOWN_ROW];
		let target = [UNKNOWN_ROW, UNKNOWN_ROW, UNKNOWN_ROW];
		assert_eq!(find_row_move(&screen, &target, 0), None);
	}

	#[test]
	fn a_band_of_blank_rows_alone_is_not_worth_moving() {
		let screen = [1, BLANK_ROW, BLANK_ROW, 2];
		let target = [3, 4, BLANK_ROW, BLANK_ROW];
		assert_eq!(find_row_move(&screen, &target, 0), None);
	}

	#[test]
	fn the_nearer_shift_wins_a_tie() {
		// Row 3's content is on screen one row below and two rows above; both
		// moves leave the same rows to rewrite, and the one-row shift is kept.
		let screen = [BLANK_ROW, 5, BLANK_ROW, BLANK_ROW, 5, BLANK_ROW];
		let target = [BLANK_ROW, BLANK_ROW, BLANK_ROW, 5, BLANK_ROW, BLANK_ROW];
		assert_eq!(find_row_move(&screen, &target, 0), Some(RowMove { from: 2, to: 1, count: 4 }));
	}

	#[test]
	fn upward_move_deletes_at_the_destination_then_reopens_below_the_band() {
		// Rows 2..4 move up one row on a 6-row screen: delete the row above the
		// band, then insert below it so the rows under the band stay put.
		assert_eq!(
			emitted(RowMove { from: 2, to: 1, count: 3 }, 6),
			"\x1b[2;1H\x1b[1M\x1b[5;1H\x1b[1L"
		);
		// A band reaching the last row needs no re-insert.
		assert_eq!(emitted(RowMove { from: 2, to: 1, count: 4 }, 6), "\x1b[2;1H\x1b[1M");
	}

	#[test]
	fn downward_move_deletes_below_the_band_then_inserts_above_it() {
		assert_eq!(
			emitted(RowMove { from: 1, to: 3, count: 2 }, 6),
			"\x1b[4;1H\x1b[2M\x1b[2;1H\x1b[2L"
		);
		// The band lands on the last rows: nothing below it to delete.
		assert_eq!(emitted(RowMove { from: 1, to: 3, count: 3 }, 6), "\x1b[2;1H\x1b[2L");
	}

	#[test]
	fn the_model_and_the_emitted_ops_agree() {
		// Replay the emitted delete/insert-line ops on a plain row model and
		// compare with `apply_row_move`.
		fn replay(mut rows: Vec<i32>, ops: &str) -> Vec<i32> {
			let mut cursor = 0usize;
			for op in ops.split("\x1b[").skip(1) {
				let (params, kind) = op.split_at(op.len() - 1);
				match kind {
					"H" => cursor = params.split(';').next().unwrap().parse::<usize>().unwrap() - 1,
					"M" => {
						for _ in 0..params.parse::<usize>().unwrap() {
							rows.remove(cursor);
							rows.push(BLANK_ROW);
						}
					},
					"L" => {
						for _ in 0..params.parse::<usize>().unwrap() {
							rows.pop();
							rows.insert(cursor, BLANK_ROW);
						}
					},
					other => panic!("unexpected op {other}"),
				}
			}
			rows
		}

		let screen = vec![1, 2, 3, 4, 5, 6, 7, 8];
		for mv in [
			RowMove { from: 3, to: 1, count: 2 },
			RowMove { from: 3, to: 1, count: 5 },
			RowMove { from: 1, to: 4, count: 2 },
			RowMove { from: 1, to: 4, count: 4 },
		] {
			let mut model = screen.clone();
			apply_row_move(&mut model, mv);
			assert_eq!(replay(screen.clone(), &emitted(mv, screen.len())), model, "{mv:?}");
		}
	}
}
