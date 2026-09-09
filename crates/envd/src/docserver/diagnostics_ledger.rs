//! New-and-changed-only diagnostic delivery ledger.

use std::collections::{HashMap, HashSet};

use omp_core::{Hash32, Str};
use omp_proto::lsp::{Diagnostic, Range, Severity};

/// One file's diagnostic delivery delta.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct DiagnosticDelta {
	/// New findings and findings whose content changed at the same identity.
	pub changed: Vec<Diagnostic>,
	/// Number of previously delivered findings that disappeared.
	pub cleared: usize,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct Identity {
	range:  Range,
	code:   Option<Str>,
	source: Str,
}

/// Per-workspace diagnostic identities used by inline and deferred delivery.
#[derive(Default)]
pub struct DiagnosticsLedger {
	files: HashMap<Str, HashMap<Identity, Hash32>>,
}

impl DiagnosticsLedger {
	/// Records the newest complete snapshot and returns only its delivery delta.
	pub fn update(
		&mut self,
		uri: Str,
		diagnostics: Vec<Diagnostic>,
		deduplicate: bool,
	) -> DiagnosticDelta {
		let previous = self.files.remove(&uri).unwrap_or_default();
		let mut current = HashMap::with_capacity(diagnostics.len());
		let mut seen = HashSet::new();
		let mut changed = Vec::new();
		for diagnostic in diagnostics {
			let identity = Identity {
				range:  diagnostic.range,
				code:   diagnostic.code.clone(),
				source: diagnostic.source.clone(),
			};
			let fingerprint = fingerprint(&diagnostic);
			if deduplicate && !seen.insert((identity.clone(), fingerprint)) {
				continue;
			}
			if previous.get(&identity) != Some(&fingerprint) {
				changed.push(diagnostic);
			}
			current.insert(identity, fingerprint);
		}
		let cleared = previous
			.keys()
			.filter(|identity| !current.contains_key(*identity))
			.count();
		self.files.insert(uri, current);
		DiagnosticDelta { changed, cleared }
	}

	/// Invalidates cached identities below a workspace-relative path prefix.
	pub fn invalidate_prefix(&mut self, uri_prefix: &str) {
		self.files.retain(|uri, _| !uri.starts_with(uri_prefix));
	}

	/// Removes all cached identities, for workspace/config generation changes.
	pub fn clear(&mut self) {
		self.files.clear();
	}
}

fn fingerprint(diagnostic: &Diagnostic) -> Hash32 {
	let mut hasher = Hash32::hasher();
	hasher.update(diagnostic.uri.as_bytes());
	hasher.update(diagnostic.message.as_bytes());
	hasher.update(&[severity_byte(diagnostic.severity)]);
	if let Some(code) = &diagnostic.code {
		hasher.update(code.as_bytes());
	}
	hasher.finalize()
}

const fn severity_byte(severity: Severity) -> u8 {
	match severity {
		Severity::Error => 1,
		Severity::Warning => 2,
		Severity::Information => 3,
		Severity::Hint => 4,
	}
}
