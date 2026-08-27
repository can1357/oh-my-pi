//! Cross-process reconstruction of durable session intent.

use std::{
	iter,
	path::{Path, PathBuf},
};

use omp_core::Str;
use omp_scribe::{Value, map};
use omp_storage::transcript::{self, Kind, ModelChange};
use thiserror::Error;

use crate::{AgentSnapshot, Journal, JournalError, prompt_keys};

/// Cold-revival failure.
#[derive(Debug, Error)]
pub enum RevivalError {
	/// The journal could not be opened or projected.
	#[error(transparent)]
	Journal(#[from] JournalError),
	/// The transcript could not be read while deriving restart intent.
	#[error(transparent)]
	Transcript(#[from] transcript::Error),
}

/// Durable facts required to restart an equivalent loop around a journal.
pub struct RevivedSession {
	/// Sole mutable owner reopened on the existing journal.
	pub journal: Journal,
	/// Reconstructed loop snapshot, including workspace and tool manifest.
	pub snapshot: AgentSnapshot,
	/// Most recent journaled temporary model selection.
	pub model_override: Option<ModelChange>,
	/// Whether inference must discard provider-native session affinity before
	/// the next request.
	pub provider_reset: bool,
	/// Whether the journal restored an explicit per-turn tool restriction.
	pub has_durable_tool_restriction: bool,
	/// Original immutable workspace root recorded by the journal header.
	pub original_root: PathBuf,
}

/// Cold-loads the journal and applies its durable projections on the supplied
/// current policy/grants/tool registry snapshot.
///
/// The supplied snapshot owns current executable capabilities and policy. The
/// journal restores only names that still exist in that registry, preventing a
/// stale manifest from granting a tool that the restarted process did not
/// mount.
pub fn revive(path: &Path, snapshot: AgentSnapshot) -> Result<RevivedSession, RevivalError> {
	let journal = Journal::open(path)?;
	revive_existing(path, journal, snapshot)
}

/// Reconstructs durable intent while retaining an already-open sole journal
/// owner.
pub fn revive_existing(
	path: &Path,
	journal: Journal,
	mut snapshot: AgentSnapshot,
) -> Result<RevivedSession, RevivalError> {
	let log = transcript::load(path)?;
	let mut model_override = None;
	let mut provider_reset = false;
	for index in log.live() {
		let Some(transcript::Entry::Ok(event)) = log.get(index) else {
			continue;
		};
		match &event.kind {
			Kind::Infer { model: transcript::Patch::Set(change), .. } => {
				model_override = Some(change.clone());
			},
			Kind::Infer { model: transcript::Patch::Clear, .. } => model_override = None,
			Kind::ProviderReset => provider_reset = true,
			Kind::TurnReceipt(_) => provider_reset = false,
			_ => {},
		}
	}
	let roots = journal.workspace_roots(&log.header().cwd)?;
	let primary_uri = roots.primary().to_string_lossy().into_owned();
	snapshot.props.set(prompt_keys::CWD, primary_uri.clone());
	let primary = map! { "canonical_uri" => primary_uri };
	let additional = roots
		.secondary()
		.iter()
		.map(|root| map! { "canonical_uri" => root.as_os_str().to_string_lossy().into_owned() })
		.collect::<Vec<_>>();
	let all = iter::once(primary.clone())
		.chain(additional.iter().cloned())
		.collect::<Vec<Value>>();
	snapshot
		.props
		.set(prompt_keys::ROOTS, map! { "revision" => 0_i64, "primary" => primary, "roots" => all });
	snapshot
		.props
		.set(prompt_keys::ADDITIONAL_ROOTS, additional);
	let latest_turn_start = journal.latest_turn_start();
	let has_durable_tool_restriction = latest_turn_start.is_some();
	if let Some(start) = latest_turn_start {
		let mounted = &snapshot.registry;
		snapshot.enabled_tools = start
			.enabled_tools
			.iter()
			.filter(|name| mounted.resolved_identity(name.as_str()).is_some())
			.cloned()
			.collect::<Vec<Str>>()
			.into();
	}
	Ok(RevivedSession {
		journal,
		snapshot,
		model_override,
		provider_reset,
		has_durable_tool_restriction,
		original_root: log.header().cwd.clone(),
	})
}
#[cfg(test)]
mod tests {
	use omp_core::Hash32;
	use omp_proto::thread::v1::{self as thread_pb, item, part};
	use omp_storage::{
		blob::BlobRef,
		transcript::{Header, SessionId, SnapcompactArchive},
	};
	use omp_tool::{CapsBase, ModelClass, Registry};
	use tempfile::tempdir;

	use super::*;
	use crate::{Compact, project_journal};

	fn message(text: &str) -> thread_pb::Item {
		thread_pb::Item {
			kind: Some(item::Kind::Message(thread_pb::Message {
				role:  thread_pb::Role::User as i32,
				parts: vec![thread_pb::Part { kind: Some(part::Kind::Text(text.to_owned())) }],
			})),
			..Default::default()
		}
	}

	#[test]
	fn cold_revival_retains_canonical_compaction_summary_and_frames() {
		let scratch = tempdir().expect("temporary directory");
		let path = scratch.path().join("session.jsonl");
		let header = Header {
			v:       4,
			id:      SessionId(Str::new_static("revival-compact")),
			created: 1,
			cwd:     scratch.path().to_owned(),
		};
		let mut journal = Journal::create(&path, &header).expect("create journal");
		journal
			.append_optimistic(2, message("discarded"), None)
			.expect("append discarded prefix");
		let kept = journal
			.append_optimistic(3, message("kept"), None)
			.expect("append kept suffix");
		let frame = BlobRef { hash: Hash32::new([7; 32]), size: 17 };
		journal
			.compact(4, Compact {
				summary:       Str::new_static("durable summary"),
				short:         None,
				first_kept:    kept,
				tokens_before: 100,
				tokens_after:  Some(20),
				method:        Some(Str::new_static("snapcompact")),
				warning:       None,
				snapcompact:   Some(SnapcompactArchive {
					source:          BlobRef { hash: Hash32::new([3; 32]), size: 31 },
					frames:          vec![frame],
					source_tokens:   100,
					image_tokens:    10,
					png_bytes:       17,
					truncated_chars: 0,
					shape:           Str::new_static("test"),
				}),
				superseded:    Vec::new(),
			})
			.expect("compact journal");
		drop(journal);

		let revived = revive(&path, AgentSnapshot::default()).expect("revive compacted journal");
		assert!(!revived.has_durable_tool_restriction);
		let log = revived.journal.load().expect("load revived journal");
		let thread = project_journal(&log, log.as_ref(), &Registry::new(), &CapsBase {
			maximum_parts:      8,
			maximum_text_bytes: 4096,
			media:              true,
			model_class:        ModelClass::Standard,
		})
		.expect("project revived journal");
		assert_eq!(thread.items.len(), 2);
		let Some(item::Kind::Message(summary)) = &thread.items[0].kind else {
			panic!("compaction projects as a summary message");
		};
		assert!(matches!(
			summary.parts.as_slice(),
			[
				thread_pb::Part { kind: Some(part::Kind::Text(text)) },
				thread_pb::Part { kind: Some(part::Kind::Blob(blob)) },
			] if text.contains("durable summary")
				&& blob.hash.as_ref() == frame.hash.as_bytes()
				&& blob.size == frame.size
		));
		assert_eq!(thread.items[1], message("kept"));
	}
}
