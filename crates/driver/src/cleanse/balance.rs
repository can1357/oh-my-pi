//! Severity-weighted whole-file diagnostic grouping.

use std::collections::BTreeMap;

use omp_core::Str;

use super::types::{Diagnostic, FileIssues, Severity};

/// Groups diagnostics by file and calculates severity/detail weight.
pub fn group_by_file(diagnostics: &[Diagnostic]) -> Vec<FileIssues> {
	let mut grouped = BTreeMap::<Option<Str>, Vec<Diagnostic>>::new();
	for diagnostic in diagnostics {
		grouped
			.entry(diagnostic.file.clone())
			.or_default()
			.push(diagnostic.clone());
	}
	let mut groups = grouped
		.into_iter()
		.map(|(file, diagnostics)| {
			let weight = diagnostics.iter().map(weight).sum();
			FileIssues { file, diagnostics, weight }
		})
		.collect::<Vec<_>>();
	groups.sort_by(|left, right| {
		right
			.weight
			.cmp(&left.weight)
			.then(left.file.cmp(&right.file))
	});
	groups
}

fn weight(diagnostic: &Diagnostic) -> u64 {
	let severity = match diagnostic.severity {
		Severity::Error => 8,
		Severity::Warning => 4,
		Severity::Info => 2,
	};
	let missing_location = u64::from(diagnostic.file.is_none()) * 5
		+ u64::from(diagnostic.line.is_none()) * 3
		+ u64::from(diagnostic.column.is_none());
	let missing_detail =
		u64::from(diagnostic.code.is_none()) + u64::from(diagnostic.suggestion.is_none());
	severity + missing_location + missing_detail
}
