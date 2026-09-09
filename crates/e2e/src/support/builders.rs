//! Journal-first builders shared by end-to-end proofs.

use omp_journal::{Entry, Journal, kind};

/// Opens a journal and returns every recovered entry.
pub fn journal_entries(path: &std::path::Path) -> Vec<Entry> {
	Journal::scan(path).expect("journal scans")
}

/// Asserts that every non-genesis entry carries its journal cause.
pub fn assert_all_entries_caused(entries: &[Entry]) {
	for entry in entries {
		if entry.kind.name.as_str() == kind::JOURNAL {
			assert!(entry.by.is_none(), "genesis has no cause");
		} else {
			assert!(entry.by.is_some(), "{} must carry by:", entry.kind.name);
		}
	}
}
