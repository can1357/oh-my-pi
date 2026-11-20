//! `urlmap` and the session's URL mounts ([`crate::mounts`]), through real
//! shells over the host filesystem.

use super::*;

/// A session scratch directory and a skill, for mounts to name.
struct Fixture {
	_dir:  tempfile::TempDir,
	local: std::path::PathBuf,
	skill: std::path::PathBuf,
}

impl Fixture {
	fn new() -> Self {
		let dir = tempfile::tempdir().expect("fixture directory");
		let root = std::fs::canonicalize(dir.path()).expect("canonical fixture directory");
		let (local, skill) = (root.join("session/local"), root.join("skills/review it"));
		std::fs::create_dir_all(local.join("sub")).expect("local root");
		std::fs::create_dir_all(skill.join("scripts")).expect("skill directory");
		std::fs::write(local.join("x.txt"), "local-x\n").expect("local file");
		// Beside the local root: what a `..` out of it would reach.
		std::fs::write(root.join("session/x.txt"), "outside\n").expect("outside file");
		std::fs::write(skill.join("SKILL.md"), "# Review\n").expect("instructions");
		std::fs::write(skill.join("notes.txt"), "notes\n").expect("skill file");
		Self { _dir: dir, local, skill }
	}

	/// The commands that mount the fixture as a session's files are mounted.
	fn mounts(&self) -> String {
		let skill = quote_arg(&self.skill.to_string_lossy());
		let instructions = quote_arg(&self.skill.join("SKILL.md").to_string_lossy());
		format!(
			"urlmap local:// {}; urlmap -r skill://review {skill}; urlmap -r -e skill://review \
			 {instructions}; ",
			quote_arg(&self.local.to_string_lossy()),
		)
	}
}

/// A mounted URL is its host entry: a prefix mount answers below itself, an
/// exact one for its own URL ahead of it, and a directory lists its entries.
#[tokio::test(flavor = "multi_thread")]
async fn a_mount_reads_lists_and_writes_the_host_entries_behind_it() {
	let fixture = Fixture::new();
	let command = format!(
		"{}cat local://x.txt; ls local://; echo new > local://sub/out.txt; cat \
		 local://sub/./out.txt; cat skill://review skill://review/notes.txt",
		fixture.mounts(),
	);

	let (result, output) = execute_captured(command).await;

	assert_eq!(output, "local-x\nsub\nx.txt\nnew\n# Review\nnotes\n");
	assert_eq!(result.exit_code, Some(0));
	assert_eq!(
		std::fs::read_to_string(fixture.local.join("sub/out.txt")).expect("written file"),
		"new\n"
	);
}

/// A read-only mount refuses every change, and what it refused is untouched.
#[tokio::test(flavor = "multi_thread")]
async fn a_read_only_mount_refuses_every_change() {
	let fixture = Fixture::new();
	let command = format!(
		"{}echo x > skill://review/SKILL.md; echo write=$?; echo x >> skill://review; echo \
		 append=$?; rm skill://review/notes.txt; echo rm=$?; mkdir skill://review/new; echo mkdir=$?",
		fixture.mounts(),
	);

	let (_, output) = execute_captured(command).await;

	assert_eq!(output.matches("Read-only file system").count(), 4, "{output}");
	for status in ["write=1", "append=1", "rm=1", "mkdir=1"] {
		assert!(output.contains(status), "{status} in {output}");
	}
	assert_eq!(
		std::fs::read_to_string(fixture.skill.join("SKILL.md")).expect("instructions"),
		"# Review\n"
	);
	assert!(fixture.skill.join("notes.txt").exists());
	assert!(!fixture.skill.join("new").exists());
}

/// No spelling of a mounted URL reaches the host beside its mount, and a URL
/// no mount covers is missing where nothing else serves URLs.
#[tokio::test(flavor = "multi_thread")]
async fn nothing_is_found_above_a_mount_or_outside_every_mount() {
	let fixture = Fixture::new();
	let command = format!(
		"{}cat local://../x.txt; echo up=$?; cat local://sub/../../x.txt; echo deep=$?; cat \
		 local://%2e%2e/x.txt; echo encoded=$?; cat skill://other; echo unmounted=$?; cat \
		 memory://x; echo scheme=$?",
		fixture.mounts(),
	);

	let (_, output) = execute_captured(command).await;

	assert!(!output.contains("outside"), "{output}");
	for status in ["up=1", "deep=1", "encoded=1", "unmounted=1", "scheme=1"] {
		assert!(output.contains(status), "{status} in {output}");
	}
}

/// The listing is the commands that make the same mounts, `-d` removes the
/// mounts at a URL, and the builtin answers its own errors briefly.
#[tokio::test(flavor = "multi_thread")]
async fn the_listing_round_trips_and_mounts_are_removed_by_url() {
	let fixture = Fixture::new();
	let command = format!(
		"{}before=$(urlmap); urlmap -d skill://review; urlmap -d local://; echo \"left=$(urlmap)\"; \
		 cat skill://review; echo gone=$?; eval \"$before\"; [ \"$(urlmap)\" = \"$before\" ] && \
		 echo same; cat skill://review; printf '%s\\n' \"$before\"",
		fixture.mounts(),
	);

	let (result, output) = execute_captured(command).await;

	let listing = format!(
		"urlmap local:// {}\nurlmap -r skill://review '{}'\nurlmap -r -e skill://review '{}'\n",
		fixture.local.display(),
		fixture.skill.display(),
		fixture.skill.join("SKILL.md").display(),
	);
	assert!(output.starts_with("left=\n"), "{output}");
	assert!(output.contains("gone=1\nsame\n# Review\n"), "{output}");
	assert!(output.ends_with(&listing), "{output}");
	assert_eq!(result.exit_code, Some(0));
}

#[tokio::test(flavor = "multi_thread")]
async fn urlmap_is_a_builtin_with_help_and_short_errors() {
	let (_, output) = execute_captured(
		"type urlmap; urlmap --help | head -n 1; echo help=${PIPESTATUS[0]}; urlmap memory /x; echo \
		 url=$?; urlmap local://.. /x; echo above=$?; urlmap local:// skill://x; echo path=$?; \
		 urlmap -d local://; echo unmounted=$?; urlmap -x a b; echo option=$?; urlmap local://; \
		 echo usage=$?"
			.to_owned(),
	)
	.await;

	assert_eq!(
		output,
		"urlmap is a shell builtin\nUsage: urlmap [-r] [-e] URL PATH\nhelp=0\nurlmap: memory: not a \
		 URL path\nurl=1\nurlmap: local://..: above its scheme's root\nabove=1\nurlmap: skill://x: \
		 not a host path\npath=1\nurlmap: local://: not mounted\nunmounted=1\nurlmap: -x: invalid \
		 option\noption=2\nurlmap: usage: urlmap [-r] [-e] URL PATH | -d URL\nusage=2\n"
	);
}

/// A program the shell runs is handed the host entry behind a mounted URL,
/// and a URL no mount covers as it was written.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn an_external_gets_the_host_path_behind_a_mounted_url() {
	let fixture = Fixture::new();
	let command = format!(
		"{}/bin/cat local://x.txt; /bin/sh -c 'printf \"%s\\n\" \"$@\"' sh local://x.txt skill://review \
		 https://example.com/a",
		fixture.mounts(),
	);

	let (result, output) = execute_captured(command).await;

	assert_eq!(
		output,
		format!(
			"local-x\n{}\n{}\nhttps://example.com/a\n",
			fixture.local.join("x.txt").display(),
			fixture.skill.join("SKILL.md").display(),
		)
	);
	assert_eq!(result.exit_code, Some(0));
}

/// A fork starts with its shell's mounts and keeps the ones it adds to itself.
#[tokio::test(flavor = "multi_thread")]
async fn a_fork_starts_with_a_copy_of_the_mounts() {
	let fixture = Fixture::new();
	let shell = Shell::new(None);
	let run = async |shell: &Shell, command: String| {
		let (tx, rx) = flume::unbounded::<String>();
		let result = shell
			.run(ShellRunOptions { command, ..Default::default() }, Some(tx), CancelToken::default())
			.await
			.expect("shell run");
		(result.exit_code, rx.try_iter().collect::<String>())
	};
	run(&shell, fixture.mounts()).await;

	let fork = shell.fork();
	let forked = run(
		&fork,
		format!(
			"cat local://x.txt; urlmap -r extra:// {}",
			quote_arg(&fixture.skill.to_string_lossy())
		),
	)
	.await;
	let parent =
		run(&shell, "urlmap | wc -l; cat extra://notes.txt; echo extra=$?".to_owned()).await;

	assert_eq!(forked, (Some(0), "local-x\n".to_owned()));
	assert!(parent.1.trim_start().starts_with('3'), "{}", parent.1);
	assert!(parent.1.ends_with("extra=1\n"), "{}", parent.1);
}
