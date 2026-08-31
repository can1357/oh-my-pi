//! Adapters from fork-provided materialized-conflict APIs to VCS metadata.

use gix::bstr::ByteSlice as _;
use jj_lib::conflicts::{
	ParsedConflictHunk, ParsedConflictStyle, parse_conflict_any_arity_with_ranges,
	parse_conflict_with_ranges,
};

use crate::types::{ConflictRegion, ConflictTerm, MaterializedConflictStyle};

fn line_number(input: &[u8], offset: usize) -> u32 {
	input[..offset.min(input.len())].find_iter(b"\n").count() as u32 + 1
}

fn last_line_number(input: &[u8], end: usize) -> u32 {
	line_number(input, end.saturating_sub(1))
}

fn term(label: Option<&gix::bstr::BStr>, content: &[u8]) -> ConflictTerm {
	ConflictTerm {
		label:   label.map(|label| label.to_str_lossy().into_owned()),
		content: String::from_utf8_lossy(content).into_owned(),
	}
}

fn git_region(
	input: &[u8],
	conflict: gix::merge::blob::builtin_driver::text::parse::Conflict<'_>,
) -> ConflictRegion {
	let other_offset = conflict.other.content.as_ptr() as usize - input.as_ptr() as usize;
	let ancestor_offset = conflict
		.ancestor
		.as_ref()
		.map(|ancestor| ancestor.content.as_ptr() as usize - input.as_ptr() as usize);
	ConflictRegion {
		start_line:     line_number(input, conflict.source.start),
		separator_line: line_number(input, other_offset).saturating_sub(1),
		end_line:       last_line_number(input, conflict.source.end),
		base_line:      ancestor_offset.map(|offset| line_number(input, offset).saturating_sub(1)),
		style:          MaterializedConflictStyle::Git,
		marker_length:  conflict.marker_size as u32,
		sides:          vec![
			term(conflict.current.label, conflict.current.content),
			term(conflict.other.label, conflict.other.content),
		],
		bases:          conflict
			.ancestor
			.into_iter()
			.map(|ancestor| term(ancestor.label, ancestor.content))
			.collect(),
	}
}

/// Parse strict Git merge/diff3 materialization through gitoxide.
pub(crate) fn git_regions(input: &[u8]) -> Vec<ConflictRegion> {
	gix::merge::blob::builtin_driver::text::parse::conflicts(input, 1)
		.into_iter()
		.map(|conflict| git_region(input, conflict))
		.collect()
}

fn jj_region(input: &[u8], hunk: ParsedConflictHunk) -> Option<ConflictRegion> {
	let style = match hunk.style? {
		ParsedConflictStyle::Git => MaterializedConflictStyle::Git,
		ParsedConflictStyle::JjDiff => MaterializedConflictStyle::JjDiff,
		ParsedConflictStyle::JjSnapshot => MaterializedConflictStyle::JjSnapshot,
	};
	let marker_length = hunk.marker_len? as u32;
	let labels = hunk.labels?;
	let start_line = line_number(input, hunk.source.start);
	let end_line = last_line_number(input, hunk.source.end);
	let sides = hunk
		.value
		.adds()
		.enumerate()
		.map(|(index, content)| {
			let label = labels
				.adds
				.get(index)
				.and_then(Option::as_ref)
				.map(|label| label.as_bstr());
			term(label, content.as_ref())
		})
		.collect();
	let bases = hunk
		.value
		.removes()
		.enumerate()
		.map(|(index, content)| {
			let label = labels
				.removes
				.get(index)
				.and_then(Option::as_ref)
				.map(|label| label.as_bstr());
			term(label, content.as_ref())
		})
		.collect();
	Some(ConflictRegion {
		start_line,
		separator_line: (start_line + 1).min(end_line),
		end_line,
		base_line: None,
		style,
		marker_length,
		sides,
		bases,
	})
}

/// Parse Jujutsu materialization with jj-lib's repository-provided arity and
/// marker length.
pub(crate) fn jj_regions(
	input: &[u8],
	num_sides: usize,
	expected_marker_length: usize,
) -> Vec<ConflictRegion> {
	parse_conflict_with_ranges(input, num_sides, expected_marker_length)
		.into_iter()
		.flatten()
		.filter_map(|hunk| jj_region(input, hunk))
		.collect()
}

/// Parse standalone marker files without repository authority. Git grammar is
/// decoded by gitoxide and Jujutsu grammar by jj-lib; exact source ranges avoid
/// downstream marker rescanning.
pub fn standalone_regions(input: &[u8], minimum_marker_length: usize) -> Vec<ConflictRegion> {
	let mut git =
		gix::merge::blob::builtin_driver::text::parse::conflicts(input, minimum_marker_length)
			.into_iter()
			.map(|conflict| git_region(input, conflict))
			.collect::<Vec<_>>();
	let git_ranges = git
		.iter()
		.map(|region| (region.start_line, region.end_line))
		.collect::<Vec<_>>();
	git.extend(
		parse_conflict_any_arity_with_ranges(input, minimum_marker_length)
			.into_iter()
			.flatten()
			.filter_map(|hunk| jj_region(input, hunk))
			.filter(|region| {
				!git_ranges
					.iter()
					.any(|(start, end)| region.start_line <= *end && *start <= region.end_line)
			}),
	);
	git.sort_by_key(|region| region.start_line);
	git
}
