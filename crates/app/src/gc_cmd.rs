//! Journal pruning plus journal-rooted project/session artifact collection.

use std::{
	fs, io,
	path::{Path, PathBuf},
	time::SystemTime,
};

use miette::{IntoDiagnostic as _, miette};
use omp_journal::{
	blob::{BlobStore, DEFAULT_GC_GRACE, GcPolicy},
	gc::{BlobGcOptions, GcCancellation, collect_blobs_with, prune_abandoned},
};
use serde_json::json;

use crate::cli::GcArgs;

const MAX_DISCOVERY_ENTRIES: usize = 1_000_000;
const MAX_DISCOVERY_DEPTH: usize = 64;
const MAX_JOURNALS_PER_NAMESPACE: usize = 100_000;

/// Scans native `.oms` journals and optionally prunes abandoned branches,
/// unreferenced blobs, orphan local trees, and stale staging content.
pub async fn run(args: GcArgs) -> miette::Result<()> {
	let cancel = GcCancellation::default();
	let worker_cancel = cancel.clone();
	let mut worker = tokio::task::spawn_blocking(move || run_sync(args, &worker_cancel));
	tokio::select! {
		result = &mut worker => result.into_diagnostic()?,
		signal = tokio::signal::ctrl_c() => {
			signal.into_diagnostic()?;
			cancel.cancel();
			worker.await.into_diagnostic()??;
			Err(miette!("journal garbage collection cancelled"))
		},
	}
}

fn run_sync(args: GcArgs, cancel: &GcCancellation) -> miette::Result<()> {
	let data_dir = omp_core::dirs::data_dir(args.data_dir).into_diagnostic()?;
	let roots = match args.sessions_dir {
		Some(directory) => vec![directory],
		None => project_session_roots(&data_dir, cancel).into_diagnostic()?,
	};
	let mut project_paths = Vec::with_capacity(roots.len());
	for sessions in roots {
		check_cancelled(cancel)?;
		let paths = collect_journals(&sessions, cancel).into_diagnostic()?;
		project_paths.push((sessions, paths));
	}

	let mut journals_scanned = 0usize;
	let mut entries_scanned = 0usize;
	let mut journals_pruned = 0usize;
	let mut entries_eligible = 0usize;
	let mut journal_bytes_eligible = 0u64;
	let mut entries_pruned = 0usize;
	let mut journal_bytes_reclaimed = 0u64;
	let mut roots_retained = 0usize;
	let mut blobs_examined = 0usize;
	let mut blobs_eligible = 0usize;
	let mut blob_bytes_eligible = 0u64;
	let mut blobs_removed = 0usize;
	let mut blob_bytes_reclaimed = 0u64;
	let mut temporaries_eligible = 0usize;
	let mut temporary_bytes_eligible = 0u64;
	let mut temporaries_removed = 0usize;
	let mut temporary_bytes_reclaimed = 0u64;
	let mut traversal_entries = 0usize;
	let mut local_session_dirs_removed = 0usize;
	let mut local_temporaries_removed = 0usize;
	let mut local_bytes_eligible = 0u64;
	let mut local_bytes_reclaimed = 0u64;

	for (sessions, paths) in &project_paths {
		check_cancelled(cancel)?;
		if args.apply {
			for path in paths {
				check_cancelled(cancel)?;
				let report = prune_abandoned(path).into_diagnostic()?;
				if report.entries_pruned() != 0 {
					journals_pruned += 1;
					entries_eligible += report.entries_pruned();
					journal_bytes_eligible =
						journal_bytes_eligible.saturating_add(report.bytes_reclaimed());
					entries_pruned += report.entries_pruned();
					journal_bytes_reclaimed =
						journal_bytes_reclaimed.saturating_add(report.bytes_reclaimed());
				}
			}
		}

		let store = BlobStore::open(sessions).into_diagnostic()?;
		let mut options = if args.apply {
			BlobGcOptions::apply(GcPolicy::default())
		} else {
			BlobGcOptions::dry_run(GcPolicy::default())
		};
		options.retain_abandoned = args.apply;
		let report = collect_blobs_with(&store, paths, options, cancel).into_diagnostic()?;
		journals_scanned += report.journals_scanned;
		entries_scanned += report.entries_scanned;
		roots_retained += report.roots_retained;
		if !args.apply {
			entries_eligible += report.abandoned_entries;
			journal_bytes_eligible =
				journal_bytes_eligible.saturating_add(report.journal_bytes_eligible);
			journals_pruned += report.journals_with_abandoned;
		}
		blobs_examined += report.storage.blobs_examined;
		blobs_eligible += report.storage.blobs_eligible;
		blob_bytes_eligible = blob_bytes_eligible.saturating_add(report.storage.blob_bytes_eligible);
		blobs_removed += report.storage.blobs_removed;
		blob_bytes_reclaimed =
			blob_bytes_reclaimed.saturating_add(report.storage.blob_bytes_reclaimed);
		temporaries_eligible += report.storage.temporaries_eligible;
		temporary_bytes_eligible =
			temporary_bytes_eligible.saturating_add(report.storage.temporary_bytes_eligible);
		temporaries_removed += report.storage.temporaries_removed;
		temporary_bytes_reclaimed =
			temporary_bytes_reclaimed.saturating_add(report.storage.temporary_bytes_reclaimed);
		traversal_entries += report.storage.filesystem_entries_visited;

		let local = collect_local_artifacts(sessions, args.apply, cancel).into_diagnostic()?;
		local_session_dirs_removed += local.session_dirs;
		local_temporaries_removed += local.temporaries;
		local_bytes_eligible = local_bytes_eligible.saturating_add(local.bytes);
		if args.apply {
			local_bytes_reclaimed = local_bytes_reclaimed.saturating_add(local.bytes);
		}
	}

	let bytes_eligible = journal_bytes_eligible
		.saturating_add(blob_bytes_eligible)
		.saturating_add(temporary_bytes_eligible)
		.saturating_add(local_bytes_eligible);
	let bytes_reclaimed = journal_bytes_reclaimed
		.saturating_add(blob_bytes_reclaimed)
		.saturating_add(temporary_bytes_reclaimed)
		.saturating_add(local_bytes_reclaimed);
	if args.json {
		println!(
			"{}",
			json!({
				"applied": args.apply,
				"projects": project_paths.len(),
				"journals_scanned": journals_scanned,
				"entries_scanned": entries_scanned,
				"roots_retained": roots_retained,
				"journals_with_abandoned_history": journals_pruned,
				"entries_eligible": entries_eligible,
				"entries_pruned": entries_pruned,
				"journal_bytes_eligible": journal_bytes_eligible,
				"journal_bytes_reclaimed": journal_bytes_reclaimed,
				"blobs_examined": blobs_examined,
				"blobs_eligible": blobs_eligible,
				"blobs_removed": blobs_removed,
				"blob_bytes_eligible": blob_bytes_eligible,
				"blob_bytes_reclaimed": blob_bytes_reclaimed,
				"temporaries_eligible": temporaries_eligible,
				"temporaries_removed": temporaries_removed,
				"temporary_bytes_eligible": temporary_bytes_eligible,
				"temporary_bytes_reclaimed": temporary_bytes_reclaimed,
				"local_session_dirs_eligible": local_session_dirs_removed,
				"local_session_dirs_removed": if args.apply { local_session_dirs_removed } else { 0 },
				"local_temporaries_eligible": local_temporaries_removed,
				"local_temporaries_removed": if args.apply { local_temporaries_removed } else { 0 },
				"local_bytes_eligible": local_bytes_eligible,
				"local_bytes_reclaimed": local_bytes_reclaimed,
				"bytes_eligible": bytes_eligible,
				"bytes_reclaimed": bytes_reclaimed,
				"filesystem_entries_visited": traversal_entries,
			})
		);
	} else if args.apply {
		println!(
			"pruned {entries_pruned} abandoned entries from {journals_pruned} of {journals_scanned} \
			 journals; removed {blobs_removed}/{blobs_eligible} unreferenced blobs and \
			 {temporaries_removed}/{temporaries_eligible} stale CAS temporaries; reclaimed \
			 {bytes_reclaimed}/{bytes_eligible} eligible bytes"
		);
	} else {
		println!(
			"dry run: {entries_eligible} abandoned entries in {journals_pruned} of \
			 {journals_scanned} journals, {blobs_eligible} unreferenced blobs, and \
			 {temporaries_eligible} stale CAS temporaries; {bytes_eligible} bytes eligible; pass \
			 --apply to prune and collect"
		);
	}
	Ok(())
}

fn check_cancelled(cancel: &GcCancellation) -> miette::Result<()> {
	if cancel.is_cancelled() {
		Err(miette!("journal garbage collection cancelled"))
	} else {
		Ok(())
	}
}

fn project_session_roots(data_dir: &Path, cancel: &GcCancellation) -> io::Result<Vec<PathBuf>> {
	let projects = data_dir.join("projects");
	let entries = match fs::read_dir(&projects) {
		Ok(entries) => entries,
		Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
		Err(error) => return Err(error),
	};
	let mut roots = Vec::new();
	let mut visited = 0usize;
	for entry in entries {
		visit(cancel, &mut visited, 0)?;
		let sessions = entry?.path().join("sessions");
		if sessions.is_dir() {
			roots.push(sessions);
		}
	}
	roots.sort();
	Ok(roots)
}

#[derive(Clone, Copy, Debug, Default)]
struct LocalGcReport {
	session_dirs: usize,
	temporaries:  usize,
	bytes:        u64,
}

fn collect_local_artifacts(
	directory: &Path,
	apply: bool,
	cancel: &GcCancellation,
) -> io::Result<LocalGcReport> {
	let entries = match fs::read_dir(directory) {
		Ok(entries) => entries,
		Err(error) if error.kind() == io::ErrorKind::NotFound => {
			return Ok(LocalGcReport::default());
		},
		Err(error) => return Err(error),
	};
	let now = SystemTime::now();
	let mut report = LocalGcReport::default();
	let mut visited = 0usize;
	for entry in entries {
		visit(cancel, &mut visited, 0)?;
		let entry = entry?;
		if !entry.file_type()?.is_dir() {
			continue;
		}
		let session_root = entry.path();
		let local = session_root.join("local");
		if !local.is_dir() {
			continue;
		}
		let journal = directory
			.join(entry.file_name())
			.with_extension(omp_journal::FILE_EXTENSION);
		if !journal.is_file() {
			report.session_dirs += 1;
			report.bytes =
				report
					.bytes
					.saturating_add(directory_bytes(&session_root, 1, cancel, &mut visited)?);
			if apply {
				check_io_cancelled(cancel)?;
				fs::remove_dir_all(&session_root)?;
			}
			continue;
		}
		collect_stale_local_temporaries(&local, now, apply, cancel, 1, &mut visited, &mut report)?;
	}
	Ok(report)
}

fn collect_stale_local_temporaries(
	directory: &Path,
	now: SystemTime,
	apply: bool,
	cancel: &GcCancellation,
	depth: usize,
	visited: &mut usize,
	report: &mut LocalGcReport,
) -> io::Result<()> {
	check_io_cancelled(cancel)?;
	if depth > MAX_DISCOVERY_DEPTH {
		return Err(io::Error::new(
			io::ErrorKind::InvalidData,
			"local-artifact traversal depth limit exceeded",
		));
	}
	for entry in fs::read_dir(directory)? {
		visit(cancel, visited, depth)?;
		let entry = entry?;
		let file_type = entry.file_type()?;
		if file_type.is_dir() {
			collect_stale_local_temporaries(
				&entry.path(),
				now,
				apply,
				cancel,
				depth.saturating_add(1),
				visited,
				report,
			)?;
			continue;
		}
		if !file_type.is_file() {
			continue;
		}
		let name = entry.file_name();
		let name = name.to_string_lossy();
		if !name.starts_with('.') || !name.ends_with(".tmp") {
			continue;
		}
		let metadata = entry.metadata()?;
		let old = metadata
			.modified()
			.ok()
			.and_then(|modified| now.duration_since(modified).ok())
			.is_some_and(|age| age >= DEFAULT_GC_GRACE);
		if !old {
			continue;
		}
		report.temporaries += 1;
		report.bytes = report.bytes.saturating_add(metadata.len());
		if apply {
			check_io_cancelled(cancel)?;
			fs::remove_file(entry.path())?;
		}
	}
	Ok(())
}

fn directory_bytes(
	directory: &Path,
	depth: usize,
	cancel: &GcCancellation,
	visited: &mut usize,
) -> io::Result<u64> {
	check_io_cancelled(cancel)?;
	if depth > MAX_DISCOVERY_DEPTH {
		return Err(io::Error::new(
			io::ErrorKind::InvalidData,
			"local-artifact size traversal depth limit exceeded",
		));
	}
	let mut bytes = 0_u64;
	for entry in fs::read_dir(directory)? {
		visit(cancel, visited, depth)?;
		let entry = entry?;
		let file_type = entry.file_type()?;
		if !file_type.is_file() && !file_type.is_dir() {
			continue;
		}
		let metadata = entry.metadata()?;
		bytes = bytes.saturating_add(if file_type.is_dir() {
			directory_bytes(&entry.path(), depth.saturating_add(1), cancel, visited)?
		} else {
			metadata.len()
		});
	}
	Ok(bytes)
}

fn collect_journals(directory: &Path, cancel: &GcCancellation) -> io::Result<Vec<PathBuf>> {
	let entries = match fs::read_dir(directory) {
		Ok(entries) => entries,
		Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
		Err(error) => return Err(error),
	};
	let mut output = Vec::new();
	let mut visited = 0usize;
	for entry in entries {
		visit(cancel, &mut visited, 0)?;
		let entry = entry?;
		let path = entry.path();
		if entry.file_type()?.is_file()
			&& path.extension().and_then(|value| value.to_str()) == Some(omp_journal::FILE_EXTENSION)
		{
			output.push(path);
			if output.len() > MAX_JOURNALS_PER_NAMESPACE {
				return Err(io::Error::new(io::ErrorKind::InvalidData, "journal-count limit exceeded"));
			}
		}
	}
	output.sort();
	output.dedup();
	Ok(output)
}

fn visit(cancel: &GcCancellation, visited: &mut usize, depth: usize) -> io::Result<()> {
	check_io_cancelled(cancel)?;
	if depth > MAX_DISCOVERY_DEPTH {
		return Err(io::Error::new(
			io::ErrorKind::InvalidData,
			"garbage-collection traversal depth limit exceeded",
		));
	}
	*visited = (*visited).saturating_add(1);
	if *visited > MAX_DISCOVERY_ENTRIES {
		return Err(io::Error::new(
			io::ErrorKind::InvalidData,
			"garbage-collection traversal entry limit exceeded",
		));
	}
	Ok(())
}

fn check_io_cancelled(cancel: &GcCancellation) -> io::Result<()> {
	if cancel.is_cancelled() {
		Err(io::Error::new(io::ErrorKind::Interrupted, "garbage collection cancelled"))
	} else {
		Ok(())
	}
}

#[cfg(test)]
mod tests {
	use omp_core::Str;
	use omp_journal::{EntryDraft, Journal, Kind, kind::KindName};
	use tempfile::tempdir;

	use super::*;

	#[test]
	fn defaults_to_every_project_session_root() {
		let scratch = tempdir().expect("scratch");
		let first = scratch.path().join("projects/first/sessions");
		let second = scratch.path().join("projects/second/sessions");
		fs::create_dir_all(&first).expect("first project");
		fs::create_dir_all(&second).expect("second project");
		fs::create_dir_all(scratch.path().join("projects/third/cache")).expect("unrelated state");

		let cancel = GcCancellation::default();
		let roots = project_session_roots(scratch.path(), &cancel).expect("project roots");
		assert_eq!(roots, vec![first.clone(), second.clone()]);

		let first_journal = first.join("a.oms");
		let second_journal = second.join("b.oms");
		fs::write(&first_journal, "").expect("first journal");
		fs::write(&second_journal, "").expect("second journal");
		fs::create_dir_all(first.join("a/local")).expect("local tree");
		fs::write(first.join("a/local/example.oms"), "not a journal").expect("local artifact");
		let mut journals = Vec::new();
		for root in roots {
			journals.extend(collect_journals(&root, &cancel).expect("collect"));
		}
		journals.sort();
		assert_eq!(journals, vec![first_journal, second_journal]);
	}

	#[test]
	fn applying_gc_isolatedly_collects_every_project_namespace() {
		let scratch = tempdir().expect("scratch");
		let mut retained = Vec::new();
		let mut orphans = Vec::new();
		for project in ["first", "second"] {
			let sessions = scratch
				.path()
				.join("projects")
				.join(project)
				.join("sessions");
			let store = BlobStore::open(&sessions).expect("store");
			let keep = store
				.put(format!("{project}-keep").as_bytes())
				.expect("keep");
			let orphan = store
				.put(format!("{project}-orphan").as_bytes())
				.expect("orphan");
			std::fs::OpenOptions::new()
				.write(true)
				.open(store.path(&orphan))
				.expect("orphan file")
				.set_times(std::fs::FileTimes::new().set_modified(std::time::SystemTime::UNIX_EPOCH))
				.expect("age orphan");
			let path = sessions.join(format!("{project}.oms"));
			let mut journal = Journal::create(path).expect("journal");
			let genesis = journal
				.append(EntryDraft {
					kind:  Kind::known(KindName::Journal),
					by:    None,
					prior: None,
					label: None,
					data:  Str::new_static("{}"),
				})
				.expect("genesis");
			journal
				.append(EntryDraft {
					kind:  Kind::known(KindName::Patch),
					by:    Some(genesis.id),
					prior: None,
					label: None,
					data:  Str::new(format!("{{\"artifact\":\"artifact://sha256/{}\"}}", keep.to_hex())),
				})
				.expect("root");
			retained.push((store.clone(), keep));
			orphans.push((store, orphan));
		}

		run_sync(
			GcArgs {
				data_dir:     Some(scratch.path().to_path_buf()),
				sessions_dir: None,
				apply:        true,
				json:         true,
			},
			&GcCancellation::default(),
		)
		.expect("project collection");

		for (store, reference) in retained {
			assert!(store.has(&reference), "each project's live root survives");
		}
		for (store, reference) in orphans {
			assert!(!store.has(&reference), "each project's orphan is collected");
		}
	}

	#[test]
	fn local_artifacts_follow_their_session_journal_lifetime() {
		let scratch = tempdir().expect("scratch");
		let sessions = scratch.path().join("sessions");
		let retained = sessions.join("retained");
		let orphan = sessions.join("deleted");
		fs::create_dir_all(retained.join("local")).expect("retained local");
		fs::create_dir_all(orphan.join("local")).expect("orphan local");
		fs::write(sessions.join("retained.oms"), b"journal").expect("retained journal");
		fs::write(retained.join("local/paste.md"), b"keep").expect("retained artifact");
		fs::write(orphan.join("local/paste.md"), b"remove").expect("orphan artifact");

		let cancel = GcCancellation::default();
		let dry_run = collect_local_artifacts(&sessions, false, &cancel).expect("dry run");
		assert_eq!(dry_run.session_dirs, 1);
		assert!(orphan.exists(), "dry run must not mutate");

		let applied = collect_local_artifacts(&sessions, true, &cancel).expect("apply");
		assert_eq!(applied.session_dirs, 1);
		assert!(!orphan.exists(), "deleted session local tree is reclaimed");
		assert!(retained.join("local/paste.md").is_file(), "live session local data survives");
	}
}
