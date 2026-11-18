//! Behavior of the platform's backends on a real directory tree.

use std::{
	fs, io,
	path::{Path, PathBuf},
	time::{Duration, Instant},
};

use crate::watch::{Backend, Batch, Config, Flags, Root, Watcher};

const TIMEOUT: Duration = Duration::from_secs(20);

type Batches = flume::Receiver<io::Result<Batch>>;

/// Every event seen so far, and how many batches they came in.
#[derive(Default)]
struct Seen {
	events:  Vec<(PathBuf, Flags)>,
	batches: usize,
}

impl Seen {
	/// Receives batches until `done` holds for the events seen.
	fn until(&mut self, batches: &Batches, done: impl Fn(&Self) -> bool) {
		let deadline = Instant::now() + TIMEOUT;
		while !done(self) {
			let left = deadline.saturating_duration_since(Instant::now());
			let Ok(batch) = batches.recv_timeout(left) else {
				panic!("timed out; saw {:?}", self.events);
			};
			let batch = batch.expect("watch ended");
			assert!(!batch.is_empty(), "an empty batch was delivered");
			self.batches += 1;
			self.events.extend(
				batch
					.iter()
					.map(|event| (event.path.to_path_buf(), event.flags)),
			);
		}
	}

	/// Whether an event for `path` carried `flags`.
	fn has(&self, path: &Path, flags: Flags) -> bool {
		self
			.events
			.iter()
			.any(|(seen, seen_flags)| seen == path && seen_flags.contains(flags))
	}

	fn mentions(&self, path: &Path) -> bool {
		self.events.iter().any(|(seen, _)| seen == path)
	}
}

fn watch(config: Config) -> (Watcher, Batches) {
	Watcher::channel(config).expect("start watcher")
}

/// The flags a content change shows as: an update, or on backends that only
/// see a file replaced or closed, one of those.
const CHANGED: [Flags; 4] = [Flags::UPDATED, Flags::CREATED, Flags::CLOSE_WRITE, Flags::RENAMED];

fn changed(seen: &Seen, path: &Path) -> bool {
	CHANGED.iter().any(|&flag| seen.has(path, flag))
}

#[test]
fn reports_create_update_and_remove_below_the_given_root() {
	let dir = tempfile::tempdir().unwrap();
	// Not canonical on macOS (`/var` is a symlink): events must come back
	// under the root as given.
	let root = dir.path().to_path_buf();
	fs::create_dir(root.join("sub")).unwrap();
	let (_watcher, batches) = watch(Config::new([Root::recursive(&root)]));
	let mut seen = Seen::default();

	let file = root.join("sub").join("a.txt");
	fs::write(&file, "one").unwrap();
	seen.until(&batches, |seen| seen.has(&file, Flags::CREATED));

	seen.events.clear();
	fs::write(&file, "two").unwrap();
	seen.until(&batches, |seen| changed(seen, &file));

	fs::remove_file(&file).unwrap();
	seen.until(&batches, |seen| seen.has(&file, Flags::REMOVED));
}

#[test]
fn flat_root_reports_entries_but_not_what_lies_deeper() {
	let dir = tempfile::tempdir().unwrap();
	let root = dir.path().to_path_buf();
	fs::create_dir(root.join("sub")).unwrap();
	let (_watcher, batches) = watch(Config::new([Root::flat(&root)]));
	let mut seen = Seen::default();

	let deep = root.join("sub").join("deep.txt");
	let top = root.join("top.txt");
	fs::write(&deep, "x").unwrap();
	fs::write(&top, "x").unwrap();
	seen.until(&batches, |seen| seen.has(&top, Flags::CREATED));
	assert!(!seen.mentions(&deep), "saw {:?}", seen.events);
}

#[test]
fn file_root_survives_atomic_save_and_recreation() {
	let dir = tempfile::tempdir().unwrap();
	let file = dir.path().join("config.toml");
	let other = dir.path().join("other.toml");
	fs::write(&file, "v1").unwrap();
	let (_watcher, batches) = watch(Config::new([Root::flat(&file)]));
	let mut seen = Seen::default();

	// An editor's save: write a temporary file, rename it over the target.
	for round in 0..3 {
		seen.events.clear();
		let temp = dir.path().join(format!(".config.toml.{round}"));
		fs::write(&temp, format!("v{round}")).unwrap();
		fs::rename(&temp, &file).unwrap();
		seen.until(&batches, |seen| changed(seen, &file));
	}

	seen.events.clear();
	fs::remove_file(&file).unwrap();
	seen.until(&batches, |seen| seen.has(&file, Flags::REMOVED) || seen.has(&file, Flags::RENAMED));
	seen.events.clear();
	fs::write(&other, "sibling").unwrap();
	fs::write(&file, "again").unwrap();
	seen.until(&batches, |seen| changed(seen, &file));
	assert!(!seen.mentions(&other), "a file root reported its sibling: {:?}", seen.events);
}

#[test]
fn burst_of_thousands_of_files_is_reported_in_full_or_as_overflow() {
	const FILES: usize = 3000;
	let dir = tempfile::tempdir().unwrap();
	let root = dir.path().to_path_buf();
	let mut config = Config::new([Root::recursive(&root)]);
	config.latency = Duration::from_millis(50);
	let (_watcher, batches) = watch(config);

	for index in 0..FILES {
		if index % 100 == 0 {
			fs::create_dir(root.join(format!("d{}", index / 100))).unwrap();
		}
		fs::write(
			root
				.join(format!("d{}", index / 100))
				.join(format!("f{index}")),
			"x",
		)
		.unwrap();
	}
	let mut seen = Seen::default();
	let all = |seen: &Seen| {
		let mut paths: Vec<&PathBuf> = seen
			.events
			.iter()
			.filter(|(path, _)| {
				path
					.file_name()
					.is_some_and(|name| name.as_encoded_bytes()[0] == b'f')
			})
			.map(|(path, _)| path)
			.collect();
		paths.sort_unstable();
		paths.dedup();
		paths.len() == FILES
	};
	// Every file, unless the system itself dropped events under the load, which
	// it must then say.
	seen.until(&batches, |seen| {
		all(seen)
			|| seen
				.events
				.iter()
				.any(|(_, flags)| flags.contains(Flags::OVERFLOW))
	});
	// Gathered, not one delivery per file.
	assert!(seen.batches < FILES / 4, "{} batches for {FILES} files", seen.batches);
}

#[test]
fn directories_created_later_are_watched_with_what_they_already_hold() {
	let dir = tempfile::tempdir().unwrap();
	let root = dir.path().to_path_buf();
	let (_watcher, batches) = watch(Config::new([Root::recursive(&root)]));
	let mut seen = Seen::default();

	let nested = root.join("a").join("b").join("c");
	fs::create_dir_all(&nested).unwrap();
	let early = nested.join("early.txt");
	fs::write(&early, "x").unwrap();
	seen.until(&batches, |seen| seen.has(&early, Flags::CREATED));

	let late = nested.join("late.txt");
	fs::write(&late, "x").unwrap();
	seen.until(&batches, |seen| seen.has(&late, Flags::CREATED));

	// A renamed directory is watched under its new name.
	let moved = root.join("moved");
	fs::rename(root.join("a"), &moved).unwrap();
	let inside = moved.join("b").join("c").join("inside.txt");
	fs::write(&inside, "x").unwrap();
	seen.until(&batches, |seen| seen.has(&inside, Flags::CREATED));
}

#[test]
fn filter_drops_events_and_coalescing_merges_a_path() {
	let dir = tempfile::tempdir().unwrap();
	let root = dir.path().to_path_buf();
	let mut config = Config::new([Root::recursive(&root)]);
	config.latency = Duration::from_millis(300);
	config.filter = Some(Box::new(|path, _| path.extension().is_some_and(|ext| ext == "rs")));
	let (_watcher, batches) = watch(config);
	let mut seen = Seen::default();

	let dropped = root.join("notes.txt");
	let kept = root.join("main.rs");
	fs::write(&dropped, "x").unwrap();
	fs::write(&kept, "x").unwrap();
	fs::write(&kept, "y").unwrap();
	seen.until(&batches, |seen| seen.mentions(&kept));
	assert!(!seen.mentions(&dropped), "saw {:?}", seen.events);
	let mentions = seen.events.iter().filter(|(path, _)| *path == kept).count();
	assert!(mentions <= seen.batches, "{mentions} events of one path in {} batches", seen.batches);
}

#[test]
fn latency_gathers_changes_into_one_batch() {
	let dir = tempfile::tempdir().unwrap();
	let root = dir.path().to_path_buf();
	let mut config = Config::new([Root::recursive(&root)]);
	config.latency = Duration::from_millis(600);
	let (_watcher, batches) = watch(config);

	let first = root.join("first");
	let second = root.join("second");
	fs::write(&first, "x").unwrap();
	std::thread::sleep(Duration::from_millis(100));
	fs::write(&second, "x").unwrap();
	let batch = batches.recv_timeout(TIMEOUT).unwrap().unwrap();
	let paths: Vec<&Path> = batch.iter().map(|event| event.path).collect();
	assert!(paths.contains(&first.as_path()) && paths.contains(&second.as_path()), "{paths:?}");
}

#[test]
fn missing_root_is_awaited_and_a_removed_one_is_watched_again() {
	let dir = tempfile::tempdir().unwrap();
	let root = dir.path().join("later");
	let (_watcher, batches) = watch(Config::new([Root::recursive(&root)]));
	let mut seen = Seen::default();

	fs::create_dir(&root).unwrap();
	seen.until(&batches, |seen| seen.has(&root, Flags::CREATED));
	let file = root.join("f");
	// The root's watch may lag its creation; keep writing until it shows.
	seen.until_touched(&batches, &file);

	fs::remove_dir_all(&root).unwrap();
	seen.until(&batches, |seen| seen.has(&root, Flags::REMOVED) || seen.has(&file, Flags::REMOVED));
	seen.events.clear();
	fs::create_dir(&root).unwrap();
	seen.until_touched(&batches, &file);

	let mut strict = Config::new([Root::recursive(dir.path().join("never"))]);
	strict.await_missing = false;
	let error = Watcher::channel(strict)
		.err()
		.expect("a missing root fails the start");
	assert_eq!(error.kind(), io::ErrorKind::NotFound);
}

impl Seen {
	/// Rewrites `file` until an event for it arrives.
	fn until_touched(&mut self, batches: &Batches, file: &Path) {
		let deadline = Instant::now() + TIMEOUT;
		while !self.mentions(file) {
			assert!(Instant::now() < deadline, "timed out; saw {:?}", self.events);
			let _ = fs::write(file, "x");
			if let Ok(batch) = batches.recv_timeout(Duration::from_millis(200)) {
				let batch = batch.expect("watch ended");
				self.batches += 1;
				self.events.extend(
					batch
						.iter()
						.map(|event| (event.path.to_path_buf(), event.flags)),
				);
			}
		}
	}
}

#[test]
fn polling_and_named_backends_report_changes() {
	for &backend in Backend::available() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		fs::write(root.join("seed"), "x").unwrap();
		let mut config = Config::new([Root::recursive(&root)]);
		config.backend = backend;
		config.poll_interval = Duration::from_millis(100);
		let (watcher, batches) = watch(config);
		assert_eq!(watcher.backend(), backend);
		assert_eq!(Backend::from_monitor_name(backend.monitor_name()), Some(backend));

		let file = root.join("new.txt");
		let mut seen = Seen::default();
		fs::write(&file, "x").unwrap();
		seen.until(&batches, |seen| seen.has(&file, Flags::CREATED));
		fs::remove_file(&file).unwrap();
		seen.until(&batches, |seen| seen.has(&file, Flags::REMOVED));

		drop(watcher);
		let deadline = Instant::now() + TIMEOUT;
		loop {
			match batches.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
				Ok(_) => {},
				Err(flume::RecvTimeoutError::Disconnected) => break,
				Err(flume::RecvTimeoutError::Timeout) => panic!("{backend:?} kept its sink"),
			}
		}
	}
}

/// A flat root that already holds entries: a new entry is followed from its
/// creation to its removal, and what was there is not reported as new.
#[cfg(unix)]
#[test]
fn every_backend_follows_a_new_entry_of_a_flat_root() {
	use std::{io::Write as _, os::unix::fs::PermissionsExt as _};

	for &backend in Backend::available() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		fs::write(root.join("seed.txt"), "x").unwrap();
		fs::create_dir(root.join("sub")).unwrap();
		let mut config = Config::new([Root::flat(&root)]);
		config.backend = backend;
		config.poll_interval = Duration::from_millis(100);
		config.coalesce = false;
		let (_watcher, batches) = watch(config);
		let mut seen = Seen::default();

		let file = root.join("k1");
		fs::write(&file, "a").unwrap();
		seen.until(&batches, |seen| seen.has(&file, Flags::CREATED));
		// `FSEvents` may still deliver what happened just before the stream.
		if backend != Backend::FsEvents {
			let old = seen.mentions(&root.join("seed.txt")) || seen.mentions(&root.join("sub"));
			assert!(!old, "{backend:?} reported old entries: {:?}", seen.events);
		}

		seen.events.clear();
		fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
		seen.until(&batches, |seen| {
			seen.has(&file, Flags::ATTRIBUTE_MODIFIED) || seen.has(&file, Flags::OWNER_MODIFIED)
		});

		seen.events.clear();
		let mut appended = fs::OpenOptions::new().append(true).open(&file).unwrap();
		appended.write_all(b"more").unwrap();
		drop(appended);
		seen.until(&batches, |seen| changed(seen, &file));

		fs::remove_file(&file).unwrap();
		seen.until(&batches, |seen| seen.has(&file, Flags::REMOVED));
	}
}

#[test]
fn flags_use_fswatch_names_and_bits() {
	let flags = Flags::CREATED | Flags::IS_FILE;
	assert_eq!(flags.bits(), 2 | 512);
	assert_eq!(flags.names().collect::<Vec<_>>(), ["Created", "IsFile"]);
	assert_eq!(format!("{flags:?}"), "Created|IsFile");
	assert_eq!(Flags::from_name("OwnerModified"), Some(Flags::OWNER_MODIFIED));
	assert_eq!(Flags::from_name("NoOp"), Some(Flags::NO_OP));
	assert_eq!(Flags::from_name("nope"), None);
	assert_eq!(Flags::OVERFLOW.bits(), 8192);
}
