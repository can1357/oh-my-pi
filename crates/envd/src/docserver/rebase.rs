use std::{
	result,
	time::{Duration, Instant},
};

use bytes::{Bytes, BytesMut};
use omp_core::sf;
use similar::{Algorithm, DiffOp, capture_diff_slices_deadline};

use crate::docserver::{ByteRange, Error, Result};

// `similar` falls back to a coarse but valid diff at the deadline, preventing
// adversarial whole-content replacements from monopolizing a request worker.
const MAX_DIFF_TIME: Duration = Duration::from_millis(50);

fn diff_ops(old: &[u8], new: &[u8]) -> Vec<DiffOp> {
	capture_diff_slices_deadline(
		Algorithm::Myers,
		old,
		new,
		Instant::now().checked_add(MAX_DIFF_TIME),
	)
}

/// A replacement of one half-open range in base-revision byte coordinates.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ByteEdit {
	range:       ByteRange,
	replacement: Bytes,
}

impl ByteEdit {
	/// Creates an edit from its base-coordinate range and exact replacement
	/// bytes.
	pub const fn new(range: ByteRange, replacement: Bytes) -> Self {
		Self { range, replacement }
	}

	/// Returns the half-open range replaced by this edit.
	pub const fn range(&self) -> ByteRange {
		self.range
	}

	/// Returns the exact replacement bytes.
	pub const fn replacement(&self) -> &Bytes {
		&self.replacement
	}
}

/// Base-coordinate ranges which could not be mapped uniquely onto a newer head.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RebaseConflict {
	ranges: Vec<ByteRange>,
}

impl RebaseConflict {
	/// Returns the sorted conflicting ranges in base coordinates.
	pub fn ranges(&self) -> &[ByteRange] {
		&self.ranges
	}

	/// Consumes this conflict and returns its base-coordinate ranges.
	pub fn into_ranges(self) -> Vec<ByteRange> {
		self.ranges
	}
}

/// Exact content produced by edits and the affected finalized-coordinate
/// ranges.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AppliedEdits {
	content:        Bytes,
	changed_ranges: Vec<ByteRange>,
}

impl AppliedEdits {
	/// Returns the exact finalized bytes.
	pub const fn content(&self) -> &Bytes {
		&self.content
	}

	/// Returns changed half-open ranges in finalized output coordinates.
	pub fn changed_ranges(&self) -> &[ByteRange] {
		&self.changed_ranges
	}

	/// Consumes the result into its exact bytes and finalized changed ranges.
	pub fn into_parts(self) -> (Bytes, Vec<ByteRange>) {
		(self.content, self.changed_ranges)
	}
}

/// Validates that edits are sorted, non-overlapping, unambiguous, and in
/// bounds.
pub fn validate_edits(base_len: u64, edits: &[ByteEdit]) -> Result<()> {
	let mut previous: Option<&ByteEdit> = None;
	for edit in edits {
		let range = edit.range.validate(base_len)?;
		if let Some(prior) = previous {
			if byte_identical_duplicate(prior, edit) {
				continue;
			}
			let prior_range = prior.range;
			let starts_not_increasing = range.start() <= prior_range.start();
			let overlaps_prior = range.start() < prior_range.end();
			if starts_not_increasing || overlaps_prior {
				return Err(invalid_edits(
					"byte edits must be sorted, non-overlapping, and have distinct starts",
				));
			}
		}
		previous = Some(edit);
	}
	Ok(())
}

fn byte_identical_duplicate(previous: &ByteEdit, edit: &ByteEdit) -> bool {
	!edit.range.is_empty() && previous == edit
}

/// Applies validated base-coordinate edits with one allocation for the final
/// bytes.
pub fn apply_edits(base: &Bytes, edits: &[ByteEdit]) -> Result<AppliedEdits> {
	let base_len = usize_to_u64(base.len())?;
	validate_edits(base_len, edits)?;
	let mapped = unique_edits(edits)
		.map(|edit| {
			Ok(MappedEdit {
				start:       u64_to_usize(edit.range.start())?,
				end:         u64_to_usize(edit.range.end())?,
				replacement: &edit.replacement,
			})
		})
		.collect::<Result<Vec<_>>>()?;
	apply_mapped(base, &mapped)
}

/// Derives canonical byte edits which transform `base` into `proposed`.
pub fn canonical_edits(base: &Bytes, proposed: &Bytes) -> Result<Vec<ByteEdit>> {
	let mut edits = Vec::new();
	for operation in diff_ops(base, proposed) {
		let (old_start, old_len, new_start, new_len) = match operation {
			DiffOp::Equal { .. } => continue,
			DiffOp::Delete { old_index, old_len, new_index } => (old_index, old_len, new_index, 0),
			DiffOp::Insert { old_index, new_index, new_len } => (old_index, 0, new_index, new_len),
			DiffOp::Replace { old_index, old_len, new_index, new_len } => {
				(old_index, old_len, new_index, new_len)
			},
		};
		let old_end = old_start
			.checked_add(old_len)
			.ok_or_else(|| invalid_edits("canonical edit range overflowed usize"))?;
		let new_end = new_start
			.checked_add(new_len)
			.ok_or_else(|| invalid_edits("canonical replacement range overflowed usize"))?;
		let range = ByteRange::new(usize_to_u64(old_start)?, usize_to_u64(old_end)?)?;
		edits.push(ByteEdit::new(range, proposed.slice(new_start..new_end)));
	}
	validate_edits(usize_to_u64(base.len())?, &edits)?;
	Ok(edits)
}

/// Rebases base-coordinate edits onto `head` only through uniquely unchanged
/// bytes.
///
/// Invalid edit lists are returned as the outer error. Valid edits that overlap
/// or ambiguously border a base-to-head change are returned as an explicit
/// conflict.
pub fn rebase_edits(
	base: &Bytes,
	head: &Bytes,
	edits: &[ByteEdit],
) -> Result<result::Result<AppliedEdits, RebaseConflict>> {
	validate_edits(usize_to_u64(base.len())?, edits)?;
	if base == head {
		return apply_edits(head, edits).map(Ok);
	}
	let equal_regions = equal_regions(base, head)?;
	let mut mapped = Vec::with_capacity(edits.len());
	let mut conflicts = Vec::new();

	for edit in unique_edits(edits) {
		if let Some((start, end)) = map_range(edit.range, base, head, &equal_regions) {
			mapped.push(MappedEdit { start, end, replacement: &edit.replacement });
		} else if conflicts.last() != Some(&edit.range) {
			conflicts.push(edit.range);
		}
	}

	if conflicts.is_empty() {
		Ok(Ok(apply_mapped(head, &mapped)?))
	} else {
		Ok(Err(RebaseConflict { ranges: conflicts }))
	}
}

/// Rebases exact proposed content, first deriving its canonical byte edits.
pub fn rebase_content(
	base: &Bytes,
	head: &Bytes,
	proposed: &Bytes,
) -> Result<result::Result<AppliedEdits, RebaseConflict>> {
	let edits = canonical_edits(base, proposed)?;
	rebase_edits(base, head, &edits)
}

fn unique_edits(edits: &[ByteEdit]) -> impl Iterator<Item = &ByteEdit> {
	let mut previous: Option<&ByteEdit> = None;
	edits.iter().filter(move |edit| {
		if previous.is_some_and(|prior| byte_identical_duplicate(prior, edit)) {
			return false;
		}
		previous = Some(edit);
		true
	})
}

#[derive(Clone, Copy)]
struct EqualRegion {
	base_start: usize,
	base_end:   usize,
	head_start: usize,
	head_end:   usize,
	unique:     bool,
}

struct MappedEdit<'a> {
	start:       usize,
	end:         usize,
	replacement: &'a Bytes,
}

fn equal_regions(base: &Bytes, head: &Bytes) -> Result<Vec<EqualRegion>> {
	let mut regions = Vec::new();
	for operation in diff_ops(base, head) {
		if let DiffOp::Equal { old_index, new_index, len } = operation {
			let base_end = old_index
				.checked_add(len)
				.ok_or_else(|| invalid_edits("base mapping overflowed usize"))?;
			let head_end = new_index
				.checked_add(len)
				.ok_or_else(|| invalid_edits("head mapping overflowed usize"))?;
			let bytes = &base[old_index..base_end];
			regions.push(EqualRegion {
				base_start: old_index,
				base_end,
				head_start: new_index,
				head_end,
				unique: occurs_once(base, bytes) && occurs_once(head, bytes),
			});
		}
	}
	Ok(regions)
}

fn map_range(
	range: ByteRange,
	base: &Bytes,
	head: &Bytes,
	regions: &[EqualRegion],
) -> Option<(usize, usize)> {
	let start = u64_to_usize(range.start()).ok()?;
	let end = u64_to_usize(range.end()).ok()?;
	if start == end {
		return regions.iter().find_map(|region| {
			if !region.unique || start < region.base_start || start > region.base_end {
				return None;
			}
			let interior = start > region.base_start && start < region.base_end;
			let document_start = start == 0 && region.base_start == 0 && region.head_start == 0;
			let document_end =
				start == base.len() && region.base_end == base.len() && region.head_end == head.len();
			let offset = start.checked_sub(region.base_start)?;
			let mapped = region.head_start.checked_add(offset)?;
			(interior || document_start || document_end).then_some((mapped, mapped))
		});
	}

	regions.iter().find_map(|region| {
		if !region.unique || start < region.base_start || end > region.base_end {
			return None;
		}
		let start_offset = start.checked_sub(region.base_start)?;
		let end_offset = end.checked_sub(region.base_start)?;
		Some((
			region.head_start.checked_add(start_offset)?,
			region.head_start.checked_add(end_offset)?,
		))
	})
}

fn apply_mapped(base: &Bytes, edits: &[MappedEdit<'_>]) -> Result<AppliedEdits> {
	if edits.is_empty() {
		return Ok(AppliedEdits { content: base.clone(), changed_ranges: Vec::new() });
	}

	let mut final_len = base.len();
	for edit in edits {
		let removed = edit
			.end
			.checked_sub(edit.start)
			.ok_or_else(|| invalid_edits("mapped edit range was reversed"))?;
		final_len = final_len
			.checked_sub(removed)
			.and_then(|length| length.checked_add(edit.replacement.len()))
			.ok_or_else(|| invalid_edits("edited content length overflowed usize"))?;
	}

	let mut output = BytesMut::with_capacity(final_len);
	let mut source_cursor = 0usize;
	let mut changed_ranges = Vec::with_capacity(edits.len());
	for edit in edits {
		if edit.start < source_cursor || edit.end > base.len() {
			return Err(invalid_edits("mapped edits were out of bounds or overlapping"));
		}
		output.extend_from_slice(&base[source_cursor..edit.start]);
		let changed_start = output.len();
		output.extend_from_slice(edit.replacement);
		let changed_end = output.len();
		changed_ranges
			.push(ByteRange::new(usize_to_u64(changed_start)?, usize_to_u64(changed_end)?)?);
		source_cursor = edit.end;
	}
	output.extend_from_slice(&base[source_cursor..]);
	if output.len() != final_len {
		return Err(invalid_edits("edited content length did not match its checked size"));
	}
	Ok(AppliedEdits { content: output.freeze(), changed_ranges })
}

fn occurs_once(haystack: &[u8], needle: &[u8]) -> bool {
	if needle.is_empty() || needle.len() > haystack.len() {
		return false;
	}
	let mut matches = haystack
		.windows(needle.len())
		.filter(|window| *window == needle);
	matches.next().is_some() && matches.next().is_none()
}

fn usize_to_u64(value: usize) -> Result<u64> {
	u64::try_from(value).map_err(|_| invalid_edits("byte coordinate does not fit in u64"))
}

fn u64_to_usize(value: u64) -> Result<usize> {
	usize::try_from(value).map_err(|_| invalid_edits("byte coordinate does not fit in usize"))
}

const fn invalid_edits(reason: &'static str) -> Error {
	Error::InvalidContent { reason: sf!(reason) }
}

#[cfg(test)]
mod tests {
	use super::*;

	fn edit(start: u64, end: u64, replacement: &'static [u8]) -> ByteEdit {
		ByteEdit::new(
			ByteRange::new(start, end).expect("valid test range"),
			Bytes::from_static(replacement),
		)
	}

	#[test]
	fn direct_edits_preserve_exact_non_utf8_bytes_and_final_ranges() {
		let base = Bytes::from_static(b"a\xffbcdef");
		let applied =
			apply_edits(&base, &[edit(1, 4, b"\x00Z"), edit(6, 7, b"!")]).expect("edits apply");
		assert_eq!(&applied.content()[..], b"a\x00Zde!");
		assert_eq!(applied.changed_ranges(), &[
			ByteRange::new(1, 3).unwrap(),
			ByteRange::new(5, 6).unwrap()
		]);
	}

	#[test]
	fn canonical_edits_round_trip_exact_bytes() {
		let base = Bytes::from_static(b"left\x80 middle right");
		let proposed = Bytes::from_static(b"left\x80 M\x00 right!");
		let edits = canonical_edits(&base, &proposed).expect("canonical diff");
		let applied = apply_edits(&base, &edits).expect("canonical edits apply");
		assert_eq!(applied.content(), &proposed);
	}

	#[test]
	fn stale_disjoint_edit_maps_onto_head() {
		let base = Bytes::from_static(b"alpha beta gamma");
		let head = Bytes::from_static(b"ALPHA beta gamma");
		let rebased = rebase_edits(&base, &head, &[edit(11, 16, b"GAMMA")])
			.expect("valid edits")
			.expect("disjoint edit");
		assert_eq!(&rebased.content()[..], b"ALPHA beta GAMMA");
		assert_eq!(rebased.changed_ranges(), &[ByteRange::new(11, 16).unwrap()]);
	}

	#[test]
	fn changed_target_bytes_conflict_in_base_coordinates() {
		let base = Bytes::from_static(b"alpha beta gamma");
		let head = Bytes::from_static(b"alpha BETA gamma");
		let conflict = rebase_edits(&base, &head, &[edit(7, 9, b"xx")])
			.expect("valid edits")
			.expect_err("overlap conflicts");
		assert_eq!(conflict.ranges(), &[ByteRange::new(7, 9).unwrap()]);
	}

	#[test]
	fn insertions_at_same_changed_gap_conflict() {
		let base = Bytes::from_static(b"left-right");
		let head = Bytes::from_static(b"leftA-right");
		let conflict = rebase_edits(&base, &head, &[edit(4, 4, b"B")])
			.expect("valid edits")
			.expect_err("same-gap insertion conflicts");
		assert_eq!(conflict.ranges(), &[ByteRange::new(4, 4).unwrap()]);
	}

	#[test]
	fn preceding_deletion_shifts_a_disjoint_edit() {
		let base = Bytes::from_static(b"remove|keep|target");
		let head = Bytes::from_static(b"keep|target");
		let rebased = rebase_edits(&base, &head, &[edit(12, 18, b"TARGET")])
			.expect("valid edits")
			.expect("target has unique unchanged mapping");
		assert_eq!(&rebased.content()[..], b"keep|TARGET");
		assert_eq!(rebased.changed_ranges(), &[ByteRange::new(5, 11).unwrap()]);
	}

	#[test]
	fn repeated_context_never_selects_an_arbitrary_alignment() {
		let base = Bytes::from_static(b"aaaa");
		let head = Bytes::from_static(b"aaaaa");
		let conflict = rebase_edits(&base, &head, &[edit(1, 2, b"Z")])
			.expect("valid edits")
			.expect_err("repeated alignment is ambiguous");
		assert_eq!(conflict.ranges(), &[ByteRange::new(1, 2).unwrap()]);
	}

	#[test]
	fn duplicate_nonempty_edits_collapse_before_overlap_validation() {
		let base = Bytes::from_static(b"abcdef");
		let duplicate = edit(1, 4, b"XYZ");
		let applied =
			apply_edits(&base, &[duplicate.clone(), duplicate]).expect("duplicates collapse");
		assert_eq!(&applied.content()[..], b"aXYZef");
		assert_eq!(applied.changed_ranges(), &[ByteRange::new(1, 4).unwrap()]);
	}

	#[test]
	fn duplicate_insertions_remain_ordered_distinct_edits() {
		let base = Bytes::from_static(b"ab");
		assert!(apply_edits(&base, &[edit(1, 1, b"x"), edit(1, 1, b"x")]).is_err());
	}

	#[test]
	fn same_range_with_different_bytes_remains_a_conflicting_overlap() {
		assert!(validate_edits(6, &[edit(1, 4, b"x"), edit(1, 4, b"y")]).is_err());
	}

	#[test]
	fn validator_rejects_crossing_overlap() {
		assert!(validate_edits(6, &[edit(1, 4, b"x"), edit(3, 5, b"y")]).is_err());
	}

	#[test]
	fn invalid_ranges_ordering_and_overlap_are_rejected() {
		let base = Bytes::from_static(b"abcdef");
		assert!(apply_edits(&base, &[edit(5, 7, b"x")]).is_err());
		assert!(apply_edits(&base, &[edit(3, 5, b"x"), edit(2, 3, b"y")]).is_err());
		assert!(apply_edits(&base, &[edit(1, 4, b"x"), edit(3, 5, b"y")]).is_err());
		assert!(apply_edits(&base, &[edit(2, 2, b"x"), edit(2, 2, b"y")]).is_err());
	}
}
