use std::{fs, path::Path, process::Command, time::Duration};

use bytes::Bytes;
use tokio::time;
use tokio_util::sync::CancellationToken;

use super::{
	commands::GitCommands,
	diff::{self, ChangeKind, GitDiff, LineCount, StatusCounts},
	mutation::{
		CommitOptions, DiffLineSelection, GitMutation, GitMutationConsumer, HunkSelection,
		HunkSelector, LineRange, MutationOutcome, SelectionError,
	},
	query::GitQuery,
	refs::{self, HeadInvalidations, HeadState},
	repo,
};
use crate::vcs::{self, RepositoryAvailability};

fn fixture_git(cwd: &Path, arguments: &[&str]) {
	let output = Command::new("git")
		.current_dir(cwd)
		.args(arguments)
		.env("GIT_TERMINAL_PROMPT", "0")
		.output()
		.expect("fixture git should launch");
	assert!(
		output.status.success(),
		"fixture git {arguments:?} failed: {}",
		String::from_utf8_lossy(&output.stderr)
	);
}

fn repository_fixture() -> tempfile::TempDir {
	let root = tempfile::tempdir().expect("temporary repository root");
	fixture_git(root.path(), &["init", "-b", "main"]);
	fixture_git(root.path(), &["config", "user.name", "OMP Test"]);
	fixture_git(root.path(), &["config", "user.email", "omp@example.invalid"]);
	fs::write(root.path().join("seed.txt"), "seed\n").expect("seed file");
	fixture_git(root.path(), &["add", "seed.txt"]);
	fixture_git(root.path(), &["commit", "-m", "seed"]);
	root
}

#[test]
fn vcs_parsers_preserve_porcelain_renames_binary_and_terminal_newlines() {
	assert_eq!(diff::parse_status(b"M  staged\n M unstaged\n?? untracked\n"), StatusCounts {
		staged:    1,
		unstaged:  1,
		untracked: 1,
	});
	assert_eq!(
		diff::parse_status(
			b"1 M. N... 100644 100644 100644 a a tracked\0? odd\nname\02 R. N... 100644 100644 100644 a a R100 new\0old\0"
		),
		StatusCounts { staged: 2, unstaged: 0, untracked: 1 }
	);
	let entries = diff::parse_status_entries(
		b"M  staged\0 R worktree-name\0worktree-old\0R  staged-name\0staged-old\0C  copied\0copy-source\0?? odd\nname\0UU conflict\0",
	);
	assert_eq!(entries.len(), 6);
	assert_eq!(entries[0].staged, Some(ChangeKind::Modified));
	assert_eq!(entries[1].worktree, Some(ChangeKind::Renamed));
	assert_eq!(
		entries[1].orig_path.as_ref().map(|path| path.as_bytes()),
		Some(b"worktree-old".as_slice())
	);
	assert_eq!(entries[2].staged, Some(ChangeKind::Renamed));
	assert_eq!(entries[2].path.as_bytes(), b"staged-name");
	assert_eq!(entries[3].staged, Some(ChangeKind::Copied));
	assert_eq!(
		entries[3].orig_path.as_ref().map(|path| path.as_bytes()),
		Some(b"copy-source".as_slice())
	);
	assert!(entries[4].untracked);
	assert_eq!(entries[4].path.as_bytes(), b"odd\nname");
	assert!(entries[5].conflicted);
	assert_eq!(entries[5].staged, Some(ChangeKind::Unmerged));
	assert_eq!(entries[5].worktree, Some(ChangeKind::Unmerged));

	let numstat = diff::parse_numstat(Bytes::from_static(
		b"3\t2\tplain\0-\t-\tbin\01\t0\t\0old name\0new name\0",
	))
	.expect("NUL numstat");
	assert_eq!(numstat.len(), 3);
	assert_eq!(numstat[0].added, LineCount::Lines(3));
	assert_eq!(numstat[1].added, LineCount::Binary);
	assert_eq!(
		numstat[2]
			.old_path
			.as_ref()
			.expect("rename old path")
			.as_bytes(),
		b"old name"
	);
	assert_eq!(numstat[2].path.as_bytes(), b"new name");

	let raw = Bytes::from_static(
		b"diff --git a/old b/new\nsimilarity index 90%\nrename from old\nrename to new\n--- a/old\n+++ b/new\n@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\ndiff --git a/image.bin b/image.bin\nnew file mode 100644\nindex 0000000..1111111\nGIT binary patch\nliteral 1\nA\n",
	);
	let parsed = diff::parse_unified(raw.clone());
	assert_eq!(parsed.len(), 2);
	assert_eq!(parsed[0].old_path.as_deref(), Some(b"old".as_slice()));
	assert_eq!(parsed[0].path.as_deref(), Some(b"new".as_slice()));
	assert!(parsed[0].old_no_final_newline);
	assert!(parsed[0].new_no_final_newline);
	assert_eq!(parsed[0].hunks.len(), 1);
	assert!(parsed[1].binary);
	assert_eq!(
		parsed.iter().map(|file| file.raw.len()).sum::<usize>(),
		raw.len(),
		"file patches must retain every input byte"
	);
}

#[tokio::test]
async fn vcs_snapshots_cover_normal_linked_bare_detached_unborn_packed_and_reftable() {
	let cancel = CancellationToken::new();
	let fixture = repository_fixture();
	let normal = vcs::snapshot(fixture.path(), &cancel)
		.await
		.expect("normal snapshot");
	assert_eq!(normal.availability, RepositoryAvailability::Available);
	assert_eq!(normal.branch.as_deref(), Some("main"));
	assert!(normal.head.is_some());
	assert_eq!(normal.status_counts, StatusCounts::default());

	fixture_git(fixture.path(), &["checkout", "--detach", "HEAD"]);
	let repository = repo::discover(fixture.path()).await.unwrap().unwrap();
	assert!(matches!(
		refs::resolve_head(&repository, &cancel).await.unwrap(),
		HeadState::Detached { .. }
	));
	fixture_git(fixture.path(), &["checkout", "main"]);
	fixture_git(fixture.path(), &["pack-refs", "--all", "--prune"]);
	assert!(!repository.common_dir.join("refs/heads/main").exists());
	assert!(matches!(
		refs::resolve_head(&repository, &cancel).await.unwrap(),
		HeadState::Branch { branch: Some(branch), .. } if branch == "main"
	));

	let unborn = tempfile::tempdir().expect("unborn fixture");
	fixture_git(unborn.path(), &["init", "-b", "fresh"]);
	let unborn_repository = repo::discover(unborn.path()).await.unwrap().unwrap();
	assert!(matches!(
		refs::resolve_head(&unborn_repository, &cancel).await.unwrap(),
		HeadState::Unborn { branch: Some(branch), .. } if branch == "fresh"
	));

	let linked = fixture.path().with_extension("linked-vcs-p2");
	fixture_git(fixture.path(), &["worktree", "add", "-b", "linked-p2", linked.to_str().unwrap()]);
	let linked_snapshot = vcs::snapshot(&linked, &cancel).await.unwrap();
	assert_eq!(linked_snapshot.branch.as_deref(), Some("linked-p2"));
	assert_eq!(linked_snapshot.primary_root, normal.primary_root);
	assert_ne!(linked_snapshot.worktree_root, normal.worktree_root);
	fixture_git(fixture.path(), &["worktree", "remove", "--force", linked.to_str().unwrap()]);

	let bare_parent = tempfile::tempdir().expect("bare parent");
	let bare = bare_parent.path().join("fixture.git");
	fixture_git(bare_parent.path(), &[
		"clone",
		"--bare",
		fixture.path().to_str().unwrap(),
		bare.to_str().unwrap(),
	]);
	let bare_snapshot = vcs::snapshot(&bare, &cancel).await.unwrap();
	let canonical_bare = fs::canonicalize(&bare).unwrap();
	assert_eq!(bare_snapshot.availability, RepositoryAvailability::Available);
	assert_eq!(bare_snapshot.worktree_root.as_deref(), Some(canonical_bare.as_path()));
	assert_eq!(bare_snapshot.primary_root.as_deref(), Some(canonical_bare.as_path()));
	assert_eq!(bare_snapshot.status_counts, StatusCounts::default());

	let reftable = tempfile::tempdir().expect("reftable fixture");
	fixture_git(reftable.path(), &["init", "--ref-format=reftable", "-b", "table"]);
	fixture_git(reftable.path(), &["config", "user.name", "OMP Test"]);
	fixture_git(reftable.path(), &["config", "user.email", "omp@example.invalid"]);
	fs::write(reftable.path().join("seed"), "table\n").unwrap();
	fixture_git(reftable.path(), &["add", "seed"]);
	fixture_git(reftable.path(), &["commit", "-m", "reftable"]);
	let reftable_repository = repo::discover(reftable.path()).await.unwrap().unwrap();
	assert!(refs::is_reftable(&reftable_repository).await.unwrap());
	assert!(matches!(
		refs::resolve_head(&reftable_repository, &cancel).await.unwrap(),
		HeadState::Branch { branch: Some(branch), .. } if branch == "table"
	));
}

#[tokio::test]
async fn vcs_head_poll_survives_atomic_replacement_and_coalesces_invalidations() {
	let fixture = repository_fixture();
	let repository = repo::discover(fixture.path()).await.unwrap().unwrap();
	let invalidations = HeadInvalidations::start(&repository).await.unwrap();
	time::sleep(Duration::from_millis(300)).await;
	let head = repository.git_dir.join("HEAD");
	let replacement = repository.git_dir.join("HEAD.omp-replacement");
	fs::write(&replacement, "ref: refs/heads/main\n").unwrap();
	fs::rename(&replacement, &head).unwrap();
	time::timeout(Duration::from_secs(2), invalidations.changed())
		.await
		.expect("atomic replacement invalidation")
		.expect("watch remains live");
	assert!(
		tokio::time::timeout(Duration::from_millis(500), invalidations.changed())
			.await
			.is_err(),
		"one atomic replacement must debounce to one pending invalidation"
	);
}

#[tokio::test]
async fn vcs_commands_queries_and_diff_round_trip_real_repository_bytes() {
	let fixture = repository_fixture();
	let repository = repo::discover(fixture.path()).await.unwrap().unwrap();
	let commands = GitCommands::new();
	let query = GitQuery::new();
	let diffs = GitDiff::new();
	let cancel = CancellationToken::new();

	commands
		.config_set(&repository, "omp.fixture", "yes", &cancel)
		.await
		.unwrap();
	assert_eq!(
		commands
			.config_get(fixture.path(), "omp.fixture", &cancel)
			.await
			.unwrap()
			.as_deref(),
		Some("yes")
	);
	commands
		.create_branch(&repository, "topic", "HEAD", &cancel)
		.await
		.unwrap();
	commands
		.checkout(&repository, "topic", &cancel)
		.await
		.unwrap();
	assert_eq!(
		commands
			.current_branch(fixture.path(), &cancel)
			.await
			.unwrap()
			.as_deref(),
		Some("topic")
	);
	commands
		.checkout(&repository, "main", &cancel)
		.await
		.unwrap();
	commands
		.delete_branch(&repository, "topic", true, &cancel)
		.await
		.unwrap();
	assert!(
		commands
			.list_branches(fixture.path(), false, &cancel)
			.await
			.unwrap()
			.iter()
			.any(|b| b == "main")
	);

	let local_url = fixture.path().to_str().unwrap();
	commands
		.add_remote(&repository, "origin", local_url, &cancel)
		.await
		.unwrap();
	commands
		.add_remote(&repository, "origin", local_url, &cancel)
		.await
		.unwrap();
	assert_eq!(
		commands
			.remote_url(fixture.path(), "origin", &cancel)
			.await
			.unwrap()
			.as_deref(),
		Some(local_url)
	);
	commands
		.fetch_refspec(&repository, "origin", "refs/heads/main", "refs/remotes/origin/main", &cancel)
		.await
		.unwrap();
	fixture_git(fixture.path(), &[
		"symbolic-ref",
		"refs/remotes/origin/HEAD",
		"refs/remotes/origin/main",
	]);
	assert_eq!(
		commands
			.default_branch(fixture.path(), &cancel)
			.await
			.unwrap()
			.as_deref(),
		Some("main")
	);
	assert!(
		commands
			.ref_exists(fixture.path(), "refs/heads/main", &cancel)
			.await
			.unwrap()
	);
	assert!(
		commands
			.resolve_ref(fixture.path(), "HEAD", &cancel)
			.await
			.unwrap()
			.is_some()
	);
	fixture_git(fixture.path(), &["tag", "v1.9"]);
	fixture_git(fixture.path(), &["tag", "v1.10"]);
	assert_eq!(
		commands
			.tags(fixture.path(), "HEAD", &cancel)
			.await
			.unwrap()[0]
			.as_str(),
		"v1.10"
	);
	fs::create_dir(fixture.path().join("nested")).unwrap();
	assert_eq!(
		commands
			.workdir_prefix(&fixture.path().join("nested"), &cancel)
			.await
			.unwrap()
			.as_deref(),
		Some("nested/")
	);

	let odd = "odd\nname.txt";
	fs::write(fixture.path().join(odd), "odd\n").unwrap();
	fixture_git(fixture.path(), &["add", odd]);
	let head = commands
		.resolve_ref(fixture.path(), "HEAD", &cancel)
		.await
		.unwrap()
		.unwrap();
	let cache = format!("160000,{head},deps/sub");
	fixture_git(fixture.path(), &["update-index", "--add", "--cacheinfo", cache.as_str()]);
	let tracked = query.tracked(fixture.path(), &cancel).await.unwrap();
	assert!(tracked.iter().any(|path| path.as_bytes() == odd.as_bytes()));
	assert!(
		query
			.submodules(fixture.path(), &cancel)
			.await
			.unwrap()
			.iter()
			.any(|path| path.as_bytes() == b"deps/sub")
	);
	assert!(
		query
			.tree(fixture.path(), "HEAD", &[], &cancel)
			.await
			.unwrap()
			.iter()
			.any(|path| path.as_bytes() == b"seed.txt")
	);
	assert_eq!(
		query
			.log_subjects(fixture.path(), 1, &cancel)
			.await
			.unwrap()[0]
			.as_str(),
		"seed"
	);
	assert_eq!(
		query
			.log_onelines(fixture.path(), 1, &cancel)
			.await
			.unwrap()
			.len(),
		1
	);
	assert!(
		query
			.rev_list_range(fixture.path(), &head, &head, &cancel)
			.await
			.unwrap()
			.is_empty()
	);
	assert_eq!(
		query
			.rev_list_touching(fixture.path(), "HEAD", "seed.txt", 1, &cancel)
			.await
			.unwrap()
			.len(),
		1
	);
	assert_eq!(
		query
			.show_path(fixture.path(), "HEAD:seed.txt", &cancel)
			.await
			.unwrap(),
		Bytes::from_static(b"seed\n")
	);
	let mut streamed = Vec::new();
	let streamed_output = query
		.show_path_stream(fixture.path(), "HEAD:seed.txt", &cancel, &mut |chunk| {
			streamed.push(chunk);
		})
		.await
		.unwrap();
	assert_eq!(streamed_output, Bytes::from_static(b"seed\n"));
	assert_eq!(
		streamed
			.iter()
			.flat_map(|chunk| chunk.iter().copied())
			.collect::<Vec<_>>(),
		b"seed\n"
	);
	let object_spec = format!("{head}:seed.txt");
	assert_eq!(
		query
			.show_path(fixture.path(), &object_spec, &cancel)
			.await
			.unwrap(),
		Bytes::from_static(b"seed\n")
	);
	assert_eq!(
		query
			.show_path(fixture.path(), ":0:seed.txt", &cancel)
			.await
			.unwrap(),
		Bytes::from_static(b"seed\n")
	);
	assert!(
		query
			.show_path(fixture.path(), "HEAD:missing", &cancel)
			.await
			.is_err()
	);
	let metadata = query
		.commit_metadata(fixture.path(), "HEAD", &cancel)
		.await
		.unwrap();
	assert_eq!(metadata.hash.as_str(), head.as_str());
	assert!(metadata.parents.is_empty());
	assert_eq!(metadata.author_name.as_str(), "OMP Test");
	assert!(metadata.body.as_str().starts_with("seed"));

	fs::write(fixture.path().join("seed.txt"), "changed without newline").unwrap();
	fs::write(fixture.path().join("untracked.bin"), [0, 1, 2, 0xff]).unwrap();
	let counts = diffs.status_counts(fixture.path(), &cancel).await.unwrap();
	assert!(counts.staged >= 2);
	assert_eq!(counts.unstaged, 2);
	assert_eq!(counts.untracked, 1);
	let entries = diffs.status_entries(fixture.path(), &cancel).await.unwrap();
	assert!(
		entries
			.iter()
			.any(|entry| entry.path.as_bytes() == b"seed.txt"
				&& entry.worktree == Some(ChangeKind::Modified))
	);
	assert!(
		entries
			.iter()
			.any(|entry| entry.path.as_bytes() == b"untracked.bin" && entry.untracked)
	);
	let raw = diffs
		.raw(fixture.path(), Default::default(), &[], &cancel)
		.await
		.unwrap();
	let parsed = diff::parse_unified(raw.clone());
	assert_eq!(parsed.len(), 2);
	let seed = parsed
		.iter()
		.find(|file| file.path.as_deref() == Some(b"seed.txt".as_slice()))
		.unwrap();
	assert!(seed.new_no_final_newline);
	assert_eq!(parsed.iter().map(|file| file.raw.len()).sum::<usize>(), raw.len());
	assert!(diffs.has(fixture.path(), false, &cancel).await.unwrap());
	assert!(
		diffs
			.names(fixture.path(), false, &cancel)
			.await
			.unwrap()
			.iter()
			.any(|path| path.as_bytes() == b"seed.txt")
	);
	let numstat = diffs
		.raw(
			fixture.path(),
			diff::DiffOptions { cached: true, numstat: true, ..Default::default() },
			&[],
			&cancel,
		)
		.await
		.unwrap();
	assert!(!diff::parse_numstat(numstat).unwrap().is_empty());
}
#[tokio::test]
async fn interactive_mutations_cover_all_hunks_and_amend() {
	let fixture = repository_fixture();
	let repository = repo::discover(fixture.path()).await.unwrap().unwrap();
	let mutation = GitMutation::new(repository, GitMutationConsumer::InteractiveGit);
	let diffs = GitDiff::new();
	let query = GitQuery::new();
	let cancel = CancellationToken::new();

	fs::write(fixture.path().join("seed.txt"), "changed\n").unwrap();
	fs::write(fixture.path().join("new.txt"), "new\n").unwrap();
	assert!(mutation.stage_all(&cancel).await.unwrap().is_applied());
	assert!(diffs.has(fixture.path(), true, &cancel).await.unwrap());
	assert!(mutation.unstage_all(&cancel).await.unwrap().is_applied());
	assert!(!diffs.has(fixture.path(), true, &cancel).await.unwrap());
	fs::remove_file(fixture.path().join("new.txt")).unwrap();

	let all = [HunkSelection { path: "seed.txt".into(), selector: HunkSelector::All }];
	assert!(
		mutation
			.stage_hunks(&all, &cancel)
			.await
			.unwrap()
			.is_applied()
	);
	assert!(
		mutation
			.unstage_hunks(&all, &cancel)
			.await
			.unwrap()
			.is_applied()
	);
	assert!(!diffs.has(fixture.path(), true, &cancel).await.unwrap());
	assert!(diffs.has(fixture.path(), false, &cancel).await.unwrap());
	assert!(
		mutation
			.discard_hunks(&all, &cancel)
			.await
			.unwrap()
			.is_applied()
	);
	assert_eq!(fs::read(fixture.path().join("seed.txt")).unwrap(), b"seed\n");

	let before = query
		.commit_metadata(fixture.path(), "HEAD", &cancel)
		.await
		.unwrap()
		.hash;
	fs::write(fixture.path().join("seed.txt"), "amended\n").unwrap();
	mutation.stage_all(&cancel).await.unwrap();
	let outcome = mutation
		.create_commit(
			b"amended root\n",
			CommitOptions { amend: true, ..Default::default() },
			&cancel,
		)
		.await
		.unwrap();
	assert!(matches!(outcome, MutationOutcome::Applied(_)));
	let amended = query
		.commit_metadata(fixture.path(), "HEAD", &cancel)
		.await
		.unwrap();
	assert_ne!(amended.hash, before);
	assert!(amended.parents.is_empty());
	assert!(amended.body.as_str().starts_with("amended root"));
	assert_eq!(
		query
			.log_subjects(fixture.path(), 2, &cancel)
			.await
			.unwrap()
			.len(),
		1
	);
}

#[tokio::test]
async fn interactive_line_patches_are_precise_across_content_shapes() {
	let fixture = repository_fixture();
	let repository = repo::discover(fixture.path()).await.unwrap().unwrap();
	let mutation = GitMutation::new(repository, GitMutationConsumer::InteractiveGit);
	let query = GitQuery::new();
	let diffs = GitDiff::new();
	let cancel = CancellationToken::new();

	let base = (1..=20)
		.map(|line| format!("line {line}\n"))
		.collect::<String>();
	fs::write(fixture.path().join("lines.txt"), &base).unwrap();
	fixture_git(fixture.path(), &["add", "lines.txt"]);
	fixture_git(fixture.path(), &["commit", "-m", "line base"]);
	assert_eq!(
		query
			.commit_metadata(fixture.path(), "HEAD", &cancel)
			.await
			.unwrap()
			.parents
			.len(),
		1
	);
	let mut changed_lines = base.lines().map(|line| line.to_owned()).collect::<Vec<_>>();
	changed_lines[1] = "changed 2".to_owned();
	changed_lines[2] = "changed 3".to_owned();
	changed_lines[14] = "changed 15".to_owned();
	let changed = format!("{}\n", changed_lines.join("\n"));
	fs::write(fixture.path().join("lines.txt"), &changed).unwrap();

	let second =
		DiffLineSelection { old: Some(LineRange::new(2, 2)), new: Some(LineRange::new(2, 2)) };
	assert!(
		mutation
			.stage_lines("lines.txt", second, &cancel)
			.await
			.unwrap()
			.is_applied()
	);
	let mut only_second = base.lines().map(|line| line.to_owned()).collect::<Vec<_>>();
	only_second[1] = "changed 2".to_owned();
	let only_second = format!("{}\n", only_second.join("\n"));
	assert_eq!(
		query
			.show_path(fixture.path(), ":0:lines.txt", &cancel)
			.await
			.unwrap(),
		Bytes::from(only_second)
	);
	mutation.unstage_all(&cancel).await.unwrap();

	let third =
		DiffLineSelection { old: Some(LineRange::new(3, 3)), new: Some(LineRange::new(3, 3)) };
	assert!(
		mutation
			.stage_lines("lines.txt", third, &cancel)
			.await
			.unwrap()
			.is_applied()
	);
	let mut only_third = base.lines().map(|line| line.to_owned()).collect::<Vec<_>>();
	only_third[2] = "changed 3".to_owned();
	let only_third = format!("{}\n", only_third.join("\n"));
	assert_eq!(
		query
			.show_path(fixture.path(), ":0:lines.txt", &cancel)
			.await
			.unwrap(),
		Bytes::from(only_third)
	);
	mutation.unstage_all(&cancel).await.unwrap();

	let spanning =
		DiffLineSelection { old: Some(LineRange::new(2, 15)), new: Some(LineRange::new(2, 15)) };
	assert!(
		mutation
			.stage_lines("lines.txt", spanning, &cancel)
			.await
			.unwrap()
			.is_applied()
	);
	assert_eq!(
		query
			.show_path(fixture.path(), ":0:lines.txt", &cancel)
			.await
			.unwrap(),
		Bytes::copy_from_slice(changed.as_bytes())
	);
	assert!(
		mutation
			.unstage_lines("lines.txt", second, &cancel)
			.await
			.unwrap()
			.is_applied()
	);
	let mut without_second = changed_lines.clone();
	without_second[1] = "line 2".to_owned();
	let without_second = format!("{}\n", without_second.join("\n"));
	assert_eq!(
		query
			.show_path(fixture.path(), ":0:lines.txt", &cancel)
			.await
			.unwrap(),
		Bytes::copy_from_slice(without_second.as_bytes())
	);
	assert!(
		mutation
			.discard_lines("lines.txt", second, &cancel)
			.await
			.unwrap()
			.is_applied()
	);
	assert_eq!(fs::read(fixture.path().join("lines.txt")).unwrap(), without_second.as_bytes());

	fs::write(fixture.path().join("eof.txt"), b"old").unwrap();
	fs::write(fixture.path().join("crlf.txt"), b"a\r\nb\r\n").unwrap();
	fs::write(fixture.path().join("binary.bin"), b"a\0b").unwrap();
	fixture_git(fixture.path(), &["add", "eof.txt", "crlf.txt", "binary.bin"]);
	fixture_git(fixture.path(), &["commit", "-m", "content shapes"]);
	fs::write(fixture.path().join("eof.txt"), b"new").unwrap();
	fs::write(fixture.path().join("crlf.txt"), b"a\r\nB\r\n").unwrap();
	fs::write(fixture.path().join("binary.bin"), b"a\0c").unwrap();
	let one = DiffLineSelection { old: Some(LineRange::new(1, 1)), new: Some(LineRange::new(1, 1)) };
	assert!(
		mutation
			.stage_lines("eof.txt", one, &cancel)
			.await
			.unwrap()
			.is_applied()
	);
	assert_eq!(
		query
			.show_path(fixture.path(), ":0:eof.txt", &cancel)
			.await
			.unwrap(),
		Bytes::from_static(b"new")
	);
	let second_line =
		DiffLineSelection { old: Some(LineRange::new(2, 2)), new: Some(LineRange::new(2, 2)) };
	assert!(
		mutation
			.stage_lines("crlf.txt", second_line, &cancel)
			.await
			.unwrap()
			.is_applied()
	);
	assert_eq!(
		query
			.show_path(fixture.path(), ":0:crlf.txt", &cancel)
			.await
			.unwrap(),
		Bytes::from_static(b"a\r\nB\r\n")
	);
	let binary = mutation.stage_lines("binary.bin", one, &cancel).await;
	assert!(
		matches!(
			&binary,
			Err(super::mutation::MutationError::Selection(SelectionError::BinarySubset { .. }))
		),
		"{binary:?}"
	);
	fs::write(fixture.path().join("crlf.txt"), b"changed\r\nB\r\n").unwrap();
	assert!(matches!(
		mutation
			.stage_lines("crlf.txt", DiffLineSelection::new_lines(99, 99), &cancel)
			.await,
		Err(super::mutation::MutationError::Selection(SelectionError::NoMatchingLines { .. }))
	));
	assert!(diffs.has(fixture.path(), false, &cancel).await.unwrap());
}
#[tokio::test]
async fn line_patches_keep_rename_metadata_staged() {
	let fixture = repository_fixture();
	fs::write(fixture.path().join("old-name.txt"), b"one\ntwo\nthree\n").unwrap();
	fixture_git(fixture.path(), &["add", "old-name.txt"]);
	fixture_git(fixture.path(), &["commit", "-m", "rename base"]);
	fixture_git(fixture.path(), &["mv", "old-name.txt", "new-name.txt"]);
	fs::write(fixture.path().join("new-name.txt"), b"one\nchanged\nthree\n").unwrap();
	fixture_git(fixture.path(), &["add", "new-name.txt"]);

	let repository = repo::discover(fixture.path()).await.unwrap().unwrap();
	let mutation = GitMutation::new(repository, GitMutationConsumer::InteractiveGit);
	let query = GitQuery::new();
	let diffs = GitDiff::new();
	let cancel = CancellationToken::new();
	let second =
		DiffLineSelection { old: Some(LineRange::new(2, 2)), new: Some(LineRange::new(2, 2)) };
	assert!(
		mutation
			.unstage_lines("new-name.txt", second, &cancel)
			.await
			.unwrap()
			.is_applied()
	);
	assert_eq!(
		query
			.show_path(fixture.path(), ":0:new-name.txt", &cancel)
			.await
			.unwrap(),
		Bytes::from_static(b"one\ntwo\nthree\n")
	);
	let entries = diffs.status_entries(fixture.path(), &cancel).await.unwrap();
	assert!(entries.iter().any(|entry| {
		entry.path.as_bytes() == b"new-name.txt"
			&& entry.orig_path.as_ref().map(|path| path.as_bytes()) == Some(b"old-name.txt".as_slice())
			&& entry.staged == Some(ChangeKind::Renamed)
	}));
	assert!(
		mutation
			.discard_lines("new-name.txt", second, &cancel)
			.await
			.unwrap()
			.is_applied()
	);
	assert_eq!(fs::read(fixture.path().join("new-name.txt")).unwrap(), b"one\ntwo\nthree\n");
}
