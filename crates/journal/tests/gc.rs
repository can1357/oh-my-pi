//! Journal branch-pruning integration coverage.

use std::{env, process::Command};

use omp_core::Str;
use omp_journal::{
	EntryDraft, Journal, Kind,
	blob::{BlobStore, GcPolicy},
	data::{Attachment, Compaction},
	gc::{
		BlobGcOptions, GcCancellation, GcError, collect_blobs, collect_blobs_with,
		copy_journal_blobs, prune_abandoned,
	},
	kind::KindName,
	live_chain,
};

fn draft(
	kind: KindName,
	by: Option<omp_journal::EntryId>,
	prior: Option<omp_journal::EntryId>,
) -> EntryDraft {
	draft_data(kind, by, prior, Str::new_static("{}"))
}

fn draft_data(
	kind: KindName,
	by: Option<omp_journal::EntryId>,
	prior: Option<omp_journal::EntryId>,
	data: Str,
) -> EntryDraft {
	EntryDraft { kind: Kind::known(kind), by, prior, label: None, data }
}

fn no_grace() -> GcPolicy {
	GcPolicy {
		unreferenced_grace: std::time::Duration::ZERO,
		temporary_grace:    std::time::Duration::ZERO,
	}
}

fn uri(reference: omp_journal::blob::BlobRef) -> String {
	format!("artifact://sha256/{}", reference.to_hex())
}

#[test]
fn prune_of_branched_journal_preserves_live_snapshot_and_shrinks_bytes() {
	let directory = tempfile::tempdir().expect("temporary directory");
	let path = directory.path().join("branched.oms");
	let mut journal = Journal::create(&path).expect("journal creates");
	let genesis = journal
		.append(draft(KindName::Journal, None, None))
		.expect("genesis appends");
	let branch_point = journal
		.append(draft(KindName::TurnStart, Some(genesis.id), None))
		.expect("branch point appends");
	let abandoned = journal
		.append(draft(KindName::MsgUser, Some(branch_point.id), None))
		.expect("abandoned message appends");
	journal
		.append(draft(KindName::TurnStart, Some(branch_point.id), Some(branch_point.id)))
		.expect("replacement turn appends");
	journal
		.append(draft(KindName::MsgUser, Some(branch_point.id), None))
		.expect("replacement message appends");
	drop(journal);

	let (_, before_entries) = Journal::open(&path).expect("journal opens before prune");
	let before_snapshot: Vec<_> = live_chain(&before_entries).cloned().collect();
	assert!(!before_snapshot.iter().any(|entry| entry.id == abandoned.id));
	let before_bytes = std::fs::metadata(&path).expect("metadata").len();

	let report = prune_abandoned(&path).expect("journal prunes");
	let (_, after_entries) = Journal::open(&path).expect("journal opens after prune");
	let after_snapshot: Vec<_> = live_chain(&after_entries).cloned().collect();

	assert_eq!(after_snapshot, before_snapshot);
	assert_eq!(report.entries_pruned(), 1);
	assert_eq!(report.entries_after, after_entries.len());
	assert!(report.bytes_after < before_bytes);
	assert_eq!(std::fs::metadata(path).expect("metadata").len(), report.bytes_after);
}

/// Subprocess half of the cross-process GC exclusion test.
#[test]
#[ignore = "subprocess helper"]
fn gc_lock_subprocess_helper() {
	let path = env::var_os("OMP_JOURNAL_GC_LOCK_TEST_PATH").expect("journal test path");
	let error = prune_abandoned(path).expect_err("parent process owns the writer lock");
	assert!(matches!(
		error,
		omp_journal::gc::GcError::Journal(omp_journal::JournalError::Locked { .. })
	));
}

/// GC contends on the same cross-process lock as writers.
#[test]
fn prune_in_another_process_refuses_a_live_writer() {
	let directory = tempfile::tempdir().expect("temporary directory");
	let path = directory.path().join("process-live.oms");
	let mut journal = Journal::create(&path).expect("journal creates");
	let genesis = journal
		.append(draft(KindName::Journal, None, None))
		.expect("genesis appends");
	journal
		.append(draft(KindName::TurnStart, Some(genesis.id), None))
		.expect("turn appends");
	let status = Command::new(env::current_exe().expect("journal test executable"))
		.args(["--ignored", "--exact", "gc_lock_subprocess_helper"])
		.env("OMP_JOURNAL_GC_LOCK_TEST_PATH", &path)
		.status()
		.expect("run GC contender");
	assert!(status.success(), "subprocess GC must observe the held writer lock");
}

/// Subprocess half of the namespace-wide mark-boundary exclusion test.
#[test]
#[ignore = "subprocess helper"]
fn gc_namespace_lock_subprocess_helper() {
	let path = std::path::PathBuf::from(
		env::var_os("OMP_JOURNAL_GC_NAMESPACE_TEST_PATH").expect("journal test path"),
	);
	let root = path.parent().expect("namespace");
	let store = BlobStore::open(root).expect("blob store");
	let error = collect_blobs_with(
		&store,
		std::slice::from_ref(&path),
		BlobGcOptions::dry_run(no_grace()),
		&GcCancellation::default(),
	)
	.expect_err("parent process owns a shared namespace writer lease");
	assert!(matches!(error, GcError::Journal(omp_journal::JournalError::NamespaceLocked { .. })));
}

/// A writer in another process excludes inventory and sweep as one boundary.
#[test]
fn collection_in_another_process_refuses_a_live_namespace_writer() {
	let directory = tempfile::tempdir().expect("temporary directory");
	let path = directory.path().join("process-live-namespace.oms");
	let mut journal = Journal::create(&path).expect("journal creates");
	journal
		.append(draft(KindName::Journal, None, None))
		.expect("genesis appends");
	let status = Command::new(env::current_exe().expect("journal test executable"))
		.args(["--ignored", "--exact", "gc_namespace_lock_subprocess_helper"])
		.env("OMP_JOURNAL_GC_NAMESPACE_TEST_PATH", &path)
		.status()
		.expect("run namespace GC contender");
	assert!(status.success(), "subprocess GC must observe the held namespace lease");
}

/// GC coordinates with the writer lock: a session that has the journal open
/// is never left appending to an unlinked inode.
#[test]
fn prune_refuses_a_journal_with_a_live_writer() {
	let directory = tempfile::tempdir().expect("temporary directory");
	let path = directory.path().join("live.oms");
	let mut journal = Journal::create(&path).expect("journal creates");
	let genesis = journal
		.append(draft(KindName::Journal, None, None))
		.expect("genesis appends");
	let branch_point = journal
		.append(draft(KindName::TurnStart, Some(genesis.id), None))
		.expect("branch point appends");
	journal
		.append(draft(KindName::TurnStart, Some(branch_point.id), Some(genesis.id)))
		.expect("rewind appends");
	let error = prune_abandoned(&path).expect_err("a live writer blocks pruning");
	assert!(matches!(
		error,
		omp_journal::gc::GcError::Journal(omp_journal::JournalError::Locked { .. })
	));
	// The writer keeps appending to the same, un-replaced file.
	journal
		.append(draft(KindName::MsgUser, Some(genesis.id), None))
		.expect("append after refused prune");
	drop(journal);
	let report = prune_abandoned(&path).expect("prune once the writer is gone");
	assert_eq!(report.entries_before, 4);
	assert_eq!(report.entries_after, 3);
}

#[test]
fn blob_gc_preserves_rewindable_media_until_branch_pruning() {
	let directory = tempfile::tempdir().expect("temporary directory");
	let store = BlobStore::open(directory.path()).expect("blob store");
	let image = store.put(b"image").expect("image");
	let audio = store.put(b"audio").expect("audio");
	let video = store.put(b"video").expect("video");
	let tool = store.put(b"tool").expect("tool artifact");
	let abandoned = store.put(b"abandoned").expect("abandoned media");
	let orphan = store.put(b"orphan").expect("orphan");

	let path = directory.path().join("media.oms");
	let mut journal = Journal::create(&path).expect("journal");
	let genesis = journal
		.append(draft(KindName::Journal, None, None))
		.expect("genesis");
	let turn = journal
		.append(draft(KindName::TurnStart, Some(genesis.id), None))
		.expect("turn");
	let user = serde_json::json!({
		"text": "mixed media",
		"attachments": [
			{"h": image.to_hex().as_str(), "n": image.size, "mime": "image/png"},
			{"h": audio.to_hex().as_str(), "n": audio.size, "mime": "audio/wav"},
			{"h": video.to_hex().as_str(), "n": video.size, "mime": "video/mp4"}
		]
	});
	let user = journal
		.append(draft_data(
			KindName::MsgUser,
			Some(turn.id),
			None,
			Str::new(serde_json::to_string(&user).expect("user json")),
		))
		.expect("user");
	let tool_result = serde_json::json!({
		"outcome": {
			"blob": {
				"hash": tool.to_hex().as_str(),
				"media_type": "application/octet-stream",
				"byte_len": tool.size
			}
		}
	});
	let tool_entry = journal
		.append(draft_data(
			KindName::ToolResult,
			Some(user.id),
			None,
			Str::new(serde_json::to_string(&tool_result).expect("tool json")),
		))
		.expect("tool result");
	let abandoned_patch = serde_json::json!({
		"ops": [["ins", 3, null, {
			"tag": "artifact",
			"props": {"blob": uri(abandoned), "mime": "image/png"}
		}]]
	});
	journal
		.append(draft_data(
			KindName::Patch,
			Some(tool_entry.id),
			None,
			Str::new(serde_json::to_string(&abandoned_patch).expect("patch json")),
		))
		.expect("abandoned patch");
	let live_patch = serde_json::json!({
		"ops": [["set", 3, "media", uri(image)]]
	});
	journal
		.append(draft_data(
			KindName::Patch,
			Some(tool_entry.id),
			Some(tool_entry.id),
			Str::new(serde_json::to_string(&live_patch).expect("live patch json")),
		))
		.expect("rewound live patch");
	drop(journal);

	let before_prune = collect_blobs(&store, std::slice::from_ref(&path), no_grace())
		.expect("collect complete history");
	assert_eq!(before_prune.journals_scanned, 1);
	assert_eq!(before_prune.roots_retained, 5);
	assert!(
		store.has(&abandoned),
		"rewindable history remains rooted until the journal branch is pruned"
	);
	assert!(!store.has(&orphan), "content absent from every history is collected");

	prune_abandoned(&path).expect("prune abandoned branch");
	let after_prune = collect_blobs(&store, std::slice::from_ref(&path), no_grace())
		.expect("collect pruned history");
	assert_eq!(after_prune.roots_retained, 4);
	for retained in [image, audio, video, tool] {
		assert!(store.has(&retained), "live media/tool root must survive");
	}
	assert!(!store.has(&abandoned), "pruning the branch releases its media root");
}

#[test]
fn shared_session_root_survives_switch_and_one_session_deletion() {
	let directory = tempfile::tempdir().expect("temporary directory");
	let store = BlobStore::open(directory.path()).expect("blob store");
	let shared = store.put(b"shared").expect("shared");
	let mut paths = Vec::new();
	for name in ["first", "second"] {
		let path = directory.path().join(format!("{name}.oms"));
		let mut journal = Journal::create(&path).expect("journal");
		let genesis = journal
			.append(draft(KindName::Journal, None, None))
			.expect("genesis");
		journal
			.append(draft_data(
				KindName::Patch,
				Some(genesis.id),
				None,
				Str::new(format!(r#"{{"ops":["{}"]}}"#, uri(shared))),
			))
			.expect("artifact root");
		drop(journal);
		paths.push(path);
	}

	std::fs::remove_file(&paths[0]).expect("delete inactive session");
	let report = collect_blobs(&store, &paths[1..], no_grace()).expect("collect remaining session");
	assert_eq!(report.roots_retained, 1);
	assert!(store.has(&shared), "the other session still roots shared content");

	std::fs::remove_file(&paths[1]).expect("delete last session");
	collect_blobs(&store, &[], no_grace()).expect("collect without sessions");
	assert!(!store.has(&shared), "last journal deletion releases the root");
}

#[test]
fn snapcompact_frames_remain_rooted_and_copy_with_their_session() {
	let parent = tempfile::tempdir().expect("temporary directory");
	let source = BlobStore::open(parent.path().join("source")).expect("source store");
	let destination = BlobStore::open(parent.path().join("destination")).expect("destination store");
	let summary = source.put(b"snapcompact summary").expect("summary");
	let frame = source.put(b"snapcompact png").expect("frame");
	let unrelated = source.put(b"unrelated").expect("unrelated");
	let path = source.root().join("snapcompact.oms");
	let mut journal = Journal::create(&path).expect("journal");
	let genesis = journal
		.append(draft(KindName::Journal, None, None))
		.expect("genesis");
	let payload = Compaction {
		summary,
		boundary: genesis.id,
		method: Some(Str::new_static("snapcompact")),
		tokens_before: Some(100_000),
		tokens_after: Some(8_000),
		warning: None,
		frames: vec![Attachment { blob: frame, mime: Str::new_static("image/png") }],
	};
	journal
		.append(draft_data(
			KindName::Compaction,
			Some(genesis.id),
			None,
			Str::new(serde_json::to_string(&payload).expect("payload json")),
		))
		.expect("compaction");
	drop(journal);

	let report =
		collect_blobs(&source, std::slice::from_ref(&path), no_grace()).expect("collect blobs");
	assert_eq!(report.roots_retained, 2);
	assert!(source.has(&summary), "summary remains rooted");
	assert!(source.has(&frame), "snapcompact frame remains rooted");
	assert!(!source.has(&unrelated), "unrelated blob is collectable");

	assert_eq!(
		copy_journal_blobs(&source, &destination, std::slice::from_ref(&path))
			.expect("copy session roots"),
		2
	);
	assert_eq!(destination.get(&summary).expect("copied summary").as_ref(), b"snapcompact summary");
	assert_eq!(destination.get(&frame).expect("copied frame").as_ref(), b"snapcompact png");
}

#[test]
fn journal_relocation_copies_all_rewindable_roots_but_no_other_session_data() {
	let parent = tempfile::tempdir().expect("temporary directory");
	let source = BlobStore::open(parent.path().join("source")).expect("source store");
	let destination = BlobStore::open(parent.path().join("destination")).expect("destination store");
	let rooted = source.put(b"rooted media").expect("rooted");
	let abandoned = source.put(b"rewindable media").expect("rewindable");
	let unrelated = source.put(b"other session").expect("unrelated");
	let path = source.root().join("moving.oms");
	let mut journal = Journal::create(&path).expect("journal");
	let genesis = journal
		.append(draft(KindName::Journal, None, None))
		.expect("genesis");
	let live = journal
		.append(draft_data(
			KindName::Patch,
			Some(genesis.id),
			None,
			Str::new(format!(r#"{{"ops":["{}"]}}"#, uri(rooted))),
		))
		.expect("root");
	journal
		.append(draft_data(
			KindName::Patch,
			Some(live.id),
			None,
			Str::new(format!(r#"{{"ops":["{}"]}}"#, uri(abandoned))),
		))
		.expect("rewindable branch");
	journal
		.append(draft(KindName::Patch, Some(live.id), Some(live.id)))
		.expect("select earlier branch");
	drop(journal);

	assert_eq!(
		copy_journal_blobs(&source, &destination, std::slice::from_ref(&path))
			.expect("copy rooted blobs"),
		2
	);
	assert!(destination.has(&rooted), "moved session media exists in destination");
	assert!(
		destination.has(&abandoned),
		"retained history remains valid if the moved session rewinds later"
	);
	assert!(!destination.has(&unrelated), "another session's blob does not cross projects");
}

#[test]
fn blob_gc_cleans_abandoned_stages_without_crossing_project_namespaces() {
	let parent = tempfile::tempdir().expect("temporary directory");
	let first = BlobStore::open(parent.path().join("project-a")).expect("first store");
	let second = BlobStore::open(parent.path().join("project-b")).expect("second store");
	let first_blob = first.put(b"same bytes").expect("first blob");
	let second_blob = second.put(b"same bytes").expect("second blob");
	assert_eq!(first_blob, second_blob, "content identity is portable");

	let temporary = first.root().join("tmp/crashed-upload.blob");
	std::fs::write(&temporary, b"partial").expect("temporary");
	let report = collect_blobs(&first, &[], no_grace()).expect("first collection");
	assert_eq!(report.storage.temporaries_removed, 1);
	assert!(!temporary.exists(), "abandoned staging content is removed");
	assert!(!first.has(&first_blob), "first namespace is swept");
	assert!(second.has(&second_blob), "another project's namespace is untouched");
}

#[test]
fn dry_run_and_apply_select_the_same_unreferenced_content() {
	let directory = tempfile::tempdir().expect("temporary directory");
	let store = BlobStore::open(directory.path()).expect("blob store");
	let retained = store.put(b"retained").expect("retained");
	let orphan = store.put(b"orphan").expect("orphan");
	let path = directory.path().join("session.oms");
	let mut journal = Journal::create(&path).expect("journal");
	let genesis = journal
		.append(draft(KindName::Journal, None, None))
		.expect("genesis");
	journal
		.append(draft_data(
			KindName::Patch,
			Some(genesis.id),
			None,
			Str::new(format!(
				"{{\"legacy\":\"blob:sha256:{}\"}}",
				retained.to_hex().as_str().to_ascii_uppercase()
			)),
		))
		.expect("legacy imported root");
	drop(journal);

	let cancel = GcCancellation::default();
	let preview = collect_blobs_with(
		&store,
		std::slice::from_ref(&path),
		BlobGcOptions::dry_run(no_grace()),
		&cancel,
	)
	.expect("dry run");
	assert_eq!(preview.storage.blobs_eligible, 1);
	assert_eq!(preview.storage.blobs_removed, 0);
	assert!(store.has(&orphan), "dry run never removes an eligible blob");

	let applied = collect_blobs_with(
		&store,
		std::slice::from_ref(&path),
		BlobGcOptions::apply(no_grace()),
		&cancel,
	)
	.expect("apply");
	assert_eq!(applied.storage.blobs_eligible, preview.storage.blobs_eligible);
	assert_eq!(applied.storage.blob_bytes_eligible, preview.storage.blob_bytes_eligible);
	assert_eq!(applied.storage.blobs_removed, 1);
	assert!(store.has(&retained));
	assert!(!store.has(&orphan));
}

#[test]
fn namespace_inventory_roots_jobs_checkpoints_and_in_progress_imports() {
	let directory = tempfile::tempdir().expect("temporary directory");
	let store = BlobStore::open(directory.path()).expect("blob store");
	let main_blob = store.put(b"main").expect("main");
	let job_blob = store.put(b"job").expect("job");
	let checkpoint_blob = store.put(b"checkpoint").expect("checkpoint");
	let imported_blob = store.put(b"import").expect("import");
	let orphan = store.put(b"orphan").expect("orphan");

	for (name, reference, field) in [
		("main.oms", main_blob, "attachment"),
		("job-01.oms", job_blob, "artifact"),
		("checkpoint.oms", checkpoint_blob, "checkpoint"),
		(".foreign.importing.oms", imported_blob, "imported"),
	] {
		let path = directory.path().join(name);
		let mut journal = Journal::create(path).expect("journal");
		let genesis = journal
			.append(draft(KindName::Journal, None, None))
			.expect("genesis");
		journal
			.append(draft_data(
				KindName::Patch,
				Some(genesis.id),
				None,
				Str::new(format!("{{\"{field}\":\"{}\"}}", uri(reference))),
			))
			.expect("root entry");
	}

	let cancel = GcCancellation::default();
	let report = collect_blobs_with(
		&store,
		&[directory.path().join("main.oms")],
		BlobGcOptions::apply(no_grace()),
		&cancel,
	)
	.expect("namespace collection");
	assert_eq!(report.journals_scanned, 4);
	assert_eq!(report.roots_retained, 4);
	for retained in [main_blob, job_blob, checkpoint_blob, imported_blob] {
		assert!(store.has(&retained), "every journal class roots its CAS content");
	}
	assert!(!store.has(&orphan));
}

#[test]
fn hypothetical_branch_pruning_releases_only_abandoned_roots_in_dry_run() {
	let directory = tempfile::tempdir().expect("temporary directory");
	let store = BlobStore::open(directory.path()).expect("blob store");
	let live_blob = store.put(b"live").expect("live");
	let branch_blob = store.put(b"branch").expect("branch");
	let path = directory.path().join("branch.oms");
	let mut journal = Journal::create(&path).expect("journal");
	let genesis = journal
		.append(draft(KindName::Journal, None, None))
		.expect("genesis");
	let live = journal
		.append(draft_data(
			KindName::Patch,
			Some(genesis.id),
			None,
			Str::new(format!("{{\"live\":\"{}\"}}", uri(live_blob))),
		))
		.expect("live root");
	journal
		.append(draft_data(
			KindName::Patch,
			Some(live.id),
			None,
			Str::new(format!("{{\"branch\":\"{}\"}}", uri(branch_blob))),
		))
		.expect("branch root");
	journal
		.append(draft(KindName::Patch, Some(live.id), Some(live.id)))
		.expect("rewind");
	drop(journal);

	let mut options = BlobGcOptions::dry_run(no_grace());
	options.retain_abandoned = false;
	let report =
		collect_blobs_with(&store, std::slice::from_ref(&path), options, &GcCancellation::default())
			.expect("preview branch collection");
	assert_eq!(report.journals_with_abandoned, 1);
	assert_eq!(report.abandoned_entries, 1);
	assert_eq!(report.storage.blobs_eligible, 1);
	assert!(store.has(&branch_blob), "preview leaves abandoned content intact");
	assert!(store.has(&live_blob));
}

#[test]
fn collection_refuses_an_active_put_before_journal_stage() {
	let directory = tempfile::tempdir().expect("temporary directory");
	let store = BlobStore::open(directory.path()).expect("blob store");
	let stage = store.begin_put().expect("active blob stage");
	let error = collect_blobs_with(
		&store,
		&[],
		BlobGcOptions::dry_run(no_grace()),
		&GcCancellation::default(),
	)
	.expect_err("active put lease must exclude collection");
	assert!(matches!(error, GcError::Blob(omp_journal::blob::Error::GcBusy)));
	drop(stage);
	collect_blobs_with(&store, &[], BlobGcOptions::dry_run(no_grace()), &GcCancellation::default())
		.expect("collection resumes after the stage is dropped");
}

#[test]
fn collection_refuses_live_writers_and_honors_cancellation_and_bounds() {
	let directory = tempfile::tempdir().expect("temporary directory");
	let store = BlobStore::open(directory.path()).expect("blob store");
	let orphan = store.put(b"bounded orphan").expect("orphan");
	let path = directory.path().join("live.oms");
	let mut journal = Journal::create(&path).expect("journal");
	journal
		.append(draft(KindName::Journal, None, None))
		.expect("genesis");

	let locked = collect_blobs_with(
		&store,
		std::slice::from_ref(&path),
		BlobGcOptions::dry_run(no_grace()),
		&GcCancellation::default(),
	)
	.expect_err("live namespace writer must exclude collection");
	assert!(matches!(locked, GcError::Journal(omp_journal::JournalError::NamespaceLocked { .. })));
	drop(journal);

	let cancelled = GcCancellation::default();
	cancelled.cancel();
	assert!(matches!(
		collect_blobs_with(
			&store,
			std::slice::from_ref(&path),
			BlobGcOptions::dry_run(no_grace()),
			&cancelled,
		),
		Err(GcError::Cancelled)
	));

	let mut bounded = BlobGcOptions::dry_run(no_grace());
	bounded.max_entries = 0;
	assert!(matches!(
		collect_blobs_with(&store, std::slice::from_ref(&path), bounded, &GcCancellation::default(),),
		Err(GcError::Limit { resource: "journal-entry-count", limit: 0 })
	));
	assert!(store.has(&orphan), "journal bound failure is fail-closed");

	let mut bounded_cas = BlobGcOptions::dry_run(no_grace());
	bounded_cas.max_blob_depth = 1;
	assert!(matches!(
		collect_blobs_with(
			&store,
			std::slice::from_ref(&path),
			bounded_cas,
			&GcCancellation::default(),
		),
		Err(GcError::Blob(omp_journal::blob::Error::GcDepthLimit { limit: 1 }))
	));
	assert!(store.has(&orphan), "CAS bound failure is fail-closed");
}
