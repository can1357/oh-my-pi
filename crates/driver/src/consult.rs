//! Source resolution for `/seance`: read-only selection of a finished session.
//!
//! Resolution never opens a journal for writing. Listing a directory, scanning
//! a journal and probing its lock sidecar change no file, so the sessions
//! directory is identical before and after a call.

use std::{
	fs, io,
	path::{Path, PathBuf},
};

use omp_core::Str;
use omp_journal::{
	Journal, JournalError, data::MsgAssistantStart, kind::MSG_ASSISTANT_START, live_chain,
};

use crate::sessions::SessionIndex;

/// Shortest accepted session-id prefix.
pub const MIN_PREFIX_LEN: usize = 8;

/// Why a consult source could not be resolved.
#[derive(Debug, thiserror::Error)]
pub enum ConsultError {
	/// The selector was empty.
	#[error("session selector is empty")]
	EmptySelector,
	/// An id prefix was shorter than [`MIN_PREFIX_LEN`].
	#[error("session id prefix `{prefix}` is shorter than {MIN_PREFIX_LEN} characters")]
	PrefixTooShort {
		/// The rejected prefix.
		prefix: Str,
	},
	/// No session matched the selector.
	#[error("no session matches `{selector}`")]
	NotFound {
		/// The unmatched selector.
		selector: Str,
	},
	/// More than one session matched an id prefix.
	#[error("session id prefix `{prefix}` is ambiguous ({count} matches)")]
	Ambiguous {
		/// The ambiguous prefix.
		prefix: Str,
		/// How many sessions matched.
		count:  usize,
	},
	/// The path lies outside the sessions directory.
	#[error("`{path}` is outside the sessions directory")]
	OutsideSessions {
		/// The refused path.
		path: PathBuf,
	},
	/// The source is a v1 `.jsonl` transcript, which cannot be consulted.
	#[error("`{path}` is a v1 transcript, not an omp2 session journal")]
	ForeignTranscript {
		/// The refused path.
		path: PathBuf,
	},
	/// The session is open in another process.
	#[error("the session is open elsewhere; consult it after it ends")]
	Live {
		/// The live journal.
		path: PathBuf,
	},
	/// The journal records no model and no override was given.
	#[error("the session records no model; pass --model")]
	NoSavedModel {
		/// The journal that holds no `msg.assistant.start`.
		path: PathBuf,
	},
	/// The journal could not be read.
	#[error("session journal could not be read")]
	Journal(#[from] JournalError),
	/// A filesystem operation failed.
	#[error("session path could not be inspected")]
	Io(#[from] io::Error),
}

/// A session chosen for consultation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConsultSource {
	/// Session id, the journal file stem.
	pub id:    Str,
	/// Canonical journal path, inside the sessions directory.
	pub path:  PathBuf,
	/// Model to consult with: the override, else the saved model.
	pub model: Str,
}

/// Resolves `selector` to a finished session under `sessions_dir`.
///
/// A token with no path separator and no `.` is an id: a full id or a prefix of
/// at least [`MIN_PREFIX_LEN`] characters, matched case-insensitively, with
/// exactly one match required. Anything else is a path, which is canonicalized
/// and must lie under the canonical `sessions_dir`.
///
/// # Errors
///
/// Returns a [`ConsultError`] naming the first refusal. Nothing is created,
/// truncated or repaired.
pub fn resolve_source(
	sessions_dir: &Path,
	selector: &str,
	model_override: Option<&str>,
) -> Result<ConsultSource, ConsultError> {
	let selector = selector.trim();
	if selector.is_empty() {
		return Err(ConsultError::EmptySelector);
	}
	let root = fs::canonicalize(sessions_dir)?;
	let is_path = selector.contains(['/', '\\']) || selector.contains('.');
	let path = if is_path {
		confine(&root, selector)?
	} else {
		by_id(&root, selector)?
	};
	if path.extension().and_then(|value| value.to_str()) == Some("jsonl") {
		return Err(ConsultError::ForeignTranscript { path });
	}
	if Journal::is_live(&path)? {
		return Err(ConsultError::Live { path });
	}
	let entries = Journal::scan(&path)?;
	let model = match model_override {
		Some(model) => Str::new(model),
		None => {
			saved_model(&entries).ok_or_else(|| ConsultError::NoSavedModel { path: path.clone() })?
		},
	};
	let id = path
		.file_stem()
		.and_then(|value| value.to_str())
		.map(Str::new)
		.ok_or_else(|| ConsultError::NotFound { selector: Str::new(selector) })?;
	Ok(ConsultSource { id, path, model })
}

fn confine(root: &Path, selector: &str) -> Result<PathBuf, ConsultError> {
	let candidate = Path::new(selector);
	let joined = if candidate.is_absolute() {
		candidate.to_path_buf()
	} else {
		root.join(candidate)
	};
	let canonical = fs::canonicalize(&joined).map_err(|error| match error.kind() {
		io::ErrorKind::NotFound => ConsultError::NotFound { selector: Str::new(selector) },
		_ => ConsultError::Io(error),
	})?;
	if canonical.starts_with(root) {
		Ok(canonical)
	} else {
		Err(ConsultError::OutsideSessions { path: canonical })
	}
}

fn by_id(root: &Path, token: &str) -> Result<PathBuf, ConsultError> {
	if token.chars().count() < MIN_PREFIX_LEN {
		return Err(ConsultError::PrefixTooShort { prefix: Str::new(token) });
	}
	let index = SessionIndex::open(root)?;
	let needle = token.to_ascii_lowercase();
	let mut matches: Vec<_> = index
		.list()
		.into_iter()
		.filter(|session| session.id.to_ascii_lowercase().starts_with(&needle))
		.collect();
	match matches.len() {
		0 => Err(ConsultError::NotFound { selector: Str::new(token) }),
		1 => {
			let session = matches.remove(0);
			confine(root, &session.path.to_string_lossy())
		},
		count => Err(ConsultError::Ambiguous { prefix: Str::new(token), count }),
	}
}

/// Model of the last `msg.assistant.start` on the selected live branch.
fn saved_model(entries: &[omp_journal::Entry]) -> Option<Str> {
	live_chain(entries)
		.filter(|entry| entry.kind.name.as_str() == MSG_ASSISTANT_START)
		.filter_map(|entry| serde_json::from_str::<MsgAssistantStart>(entry.data.as_str()).ok())
		.last()
		.map(|start| start.model)
}

#[cfg(test)]
mod tests {
	use std::{collections::BTreeMap, fs, os::unix::fs::symlink, path::Path};

	use omp_core::Str;
	use omp_journal::{
		EntryDraft, EntryId, Journal, Kind,
		kind::{JOURNAL, MSG_ASSISTANT_START, MSG_USER},
	};
	use tempfile::tempdir;

	use super::{ConsultError, resolve_source};

	fn kind(name: &'static str) -> Kind {
		Kind { name: Str::new_static(name), rev: 1 }
	}

	fn draft(
		name: &'static str,
		by: Option<EntryId>,
		prior: Option<EntryId>,
		data: &str,
	) -> EntryDraft {
		EntryDraft { kind: kind(name), by, prior, label: None, data: Str::new(data) }
	}

	fn start(model: &str) -> String {
		format!(r#"{{"model":"{model}","provider":"p","route":"r"}}"#)
	}

	/// Writes a finished journal and returns the id of its last entry.
	fn write_session(dir: &Path, stem: &str, models: &[&str]) -> EntryId {
		let mut journal = Journal::create(dir.join(format!("{stem}.oms"))).expect("create");
		let genesis = journal
			.append(draft(JOURNAL, None, None, r#"{"version":1,"cwd":"/tmp","created":"now"}"#))
			.expect("genesis")
			.id;
		let mut last = genesis;
		for model in models {
			last = journal
				.append(draft(MSG_ASSISTANT_START, Some(genesis), Some(last), &start(model)))
				.expect("start")
				.id;
		}
		last
	}

	fn listing(dir: &Path) -> BTreeMap<String, (u64, std::time::SystemTime)> {
		fs::read_dir(dir)
			.expect("read_dir")
			.map(|entry| {
				let entry = entry.expect("entry");
				let meta = entry.metadata().expect("meta");
				(
					entry.file_name().to_string_lossy().into_owned(),
					(meta.len(), meta.modified().expect("mtime")),
				)
			})
			.collect()
	}

	const ID: &str = "01JABCDEFGHJKMNPQRSTVWXYZ0";

	#[test]
	fn resolves_by_full_id_and_by_prefix_case_insensitively() {
		let dir = tempdir().expect("dir");
		write_session(dir.path(), ID, &["claude-sonnet-5-5"]);
		let full = resolve_source(dir.path(), ID, None).expect("full");
		let prefix = resolve_source(dir.path(), &ID[..8].to_ascii_lowercase(), None).expect("prefix");
		assert_eq!(full, prefix);
		assert_eq!(full.model.as_str(), "claude-sonnet-5-5");
		assert_eq!(full.id.as_str(), ID);
	}

	#[test]
	fn resolution_leaves_the_directory_listing_identical() {
		let dir = tempdir().expect("dir");
		write_session(dir.path(), ID, &["m"]);
		let before = listing(dir.path());
		resolve_source(dir.path(), ID, None).expect("resolve");
		assert_eq!(listing(dir.path()), before);
	}

	#[test]
	fn a_live_session_is_refused() {
		let dir = tempdir().expect("dir");
		let path = dir.path().join(format!("{ID}.oms"));
		let (_held, _) = {
			write_session(dir.path(), ID, &["m"]);
			Journal::open(&path).expect("hold the writer lock")
		};
		let error = resolve_source(dir.path(), ID, None).expect_err("live");
		assert!(matches!(error, ConsultError::Live { .. }), "{error:?}");
	}

	#[test]
	fn a_torn_tail_is_not_truncated() {
		let dir = tempdir().expect("dir");
		write_session(dir.path(), ID, &["m"]);
		let path = dir.path().join(format!("{ID}.oms"));
		let mut bytes = fs::read(&path).expect("read");
		bytes.extend_from_slice(b"event: msg.assistant.start\ndata: {\"mod");
		fs::write(&path, &bytes).expect("tear");
		let before = fs::read(&path).expect("before");
		let _ = resolve_source(dir.path(), ID, None);
		assert_eq!(fs::read(&path).expect("after"), before);
	}

	#[test]
	fn parent_traversal_and_symlink_escapes_are_refused() {
		let root = tempdir().expect("root");
		let sessions = root.path().join("sessions");
		let outside = root.path().join("outside");
		fs::create_dir_all(&sessions).expect("sessions");
		fs::create_dir_all(&outside).expect("outside");
		write_session(&outside, ID, &["m"]);
		let error = resolve_source(&sessions, &format!("../outside/{ID}.oms"), None).expect_err("..");
		assert!(matches!(error, ConsultError::OutsideSessions { .. }), "{error:?}");
		symlink(outside.join(format!("{ID}.oms")), sessions.join("link.oms")).expect("symlink");
		let error = resolve_source(&sessions, "link.oms", None).expect_err("symlink");
		assert!(matches!(error, ConsultError::OutsideSessions { .. }), "{error:?}");
	}

	#[test]
	fn a_sibling_directory_sharing_a_string_prefix_is_not_inside() {
		let root = tempdir().expect("root");
		let sessions = root.path().join("sessions");
		let sibling = root.path().join("sessions-evil");
		fs::create_dir_all(&sessions).expect("sessions");
		fs::create_dir_all(&sibling).expect("sibling");
		write_session(&sibling, ID, &["m"]);
		let error = resolve_source(&sessions, &format!("../sessions-evil/{ID}.oms"), None)
			.expect_err("sibling");
		assert!(matches!(error, ConsultError::OutsideSessions { .. }), "{error:?}");
	}

	#[test]
	fn ambiguous_unknown_and_short_selectors_are_refused() {
		let dir = tempdir().expect("dir");
		write_session(dir.path(), "01JAAAAAAA1", &["m"]);
		write_session(dir.path(), "01JAAAAAAA2", &["m"]);
		let ambiguous = resolve_source(dir.path(), "01JAAAAAAA", None).expect_err("ambiguous");
		assert!(matches!(ambiguous, ConsultError::Ambiguous { count: 2, .. }), "{ambiguous:?}");
		let unknown = resolve_source(dir.path(), "01JZZZZZZZZ", None).expect_err("unknown");
		assert!(matches!(unknown, ConsultError::NotFound { .. }), "{unknown:?}");
		let short = resolve_source(dir.path(), "01JAAAA", None).expect_err("short");
		assert!(matches!(short, ConsultError::PrefixTooShort { .. }), "{short:?}");
	}

	#[test]
	fn a_jsonl_transcript_is_a_foreign_transcript() {
		let dir = tempdir().expect("dir");
		fs::write(dir.path().join("old.jsonl"), b"{}\n").expect("write");
		let error = resolve_source(dir.path(), "old.jsonl", None).expect_err("jsonl");
		assert!(matches!(error, ConsultError::ForeignTranscript { .. }), "{error:?}");
	}

	#[test]
	fn an_abandoned_branch_model_is_ignored() {
		let dir = tempdir().expect("dir");
		let mut journal = Journal::create(dir.path().join(format!("{ID}.oms"))).expect("create");
		let genesis = journal
			.append(draft(JOURNAL, None, None, r#"{"version":1,"cwd":"/tmp","created":"now"}"#))
			.expect("genesis")
			.id;
		let kept = journal
			.append(draft(MSG_ASSISTANT_START, Some(genesis), Some(genesis), &start("kept-model")))
			.expect("kept")
			.id;
		journal
			.append(draft(MSG_ASSISTANT_START, Some(genesis), Some(kept), &start("abandoned-model")))
			.expect("abandoned");
		journal
			.append(draft(MSG_USER, Some(genesis), Some(kept), r#"{"text":"fork"}"#))
			.expect("fork");
		drop(journal);
		let source = resolve_source(dir.path(), ID, None).expect("resolve");
		assert_eq!(source.model.as_str(), "kept-model");
	}

	#[test]
	fn no_assistant_start_needs_an_override() {
		let dir = tempdir().expect("dir");
		write_session(dir.path(), ID, &[]);
		let error = resolve_source(dir.path(), ID, None).expect_err("no model");
		assert!(matches!(error, ConsultError::NoSavedModel { .. }), "{error:?}");
		let source = resolve_source(dir.path(), ID, Some("override-model")).expect("override");
		assert_eq!(source.model.as_str(), "override-model");
	}

	#[test]
	fn the_override_wins_over_the_saved_model() {
		let dir = tempdir().expect("dir");
		write_session(dir.path(), ID, &["saved"]);
		let source = resolve_source(dir.path(), ID, Some("chosen")).expect("resolve");
		assert_eq!(source.model.as_str(), "chosen");
	}
}
