//! Data-driven interactive startup notices, persisted once per application
//! version.

use std::{
	env, fs,
	io::{self, IsTerminal as _},
	path::Path,
	sync::LazyLock,
	thread,
	time::{Duration, Instant},
};

use omp_core::Str;
use parking_lot::Mutex;

const NOTICE_VERSION_FILE: &str = "startup-notice-version";
const MAX_CHANGELOG_BYTES: usize = 64 * 1024;
const MAX_UNSEEN_RELEASES: usize = 3;
const WATCHDOG_INTERVAL: Duration = Duration::from_secs(10);

struct StartupWatchdog {
	stop:    flume::Sender<()>,
	started: Instant,
}

static STARTUP_WATCHDOG: LazyLock<Mutex<Option<StartupWatchdog>>> =
	LazyLock::new(|| Mutex::new(None));

/// Arms the process startup watchdog until CLI dispatch hands control to a
/// mode owner.
pub fn start_watchdog() {
	let mut state = STARTUP_WATCHDOG.lock();
	if state.is_some() {
		return;
	}
	let started = Instant::now();
	let (stop, stopped) = flume::bounded::<()>(1);
	thread::Builder::new()
		.name("omp-startup-watchdog".to_owned())
		.spawn(move || {
			while stopped.recv_timeout(WATCHDOG_INTERVAL).is_err() {
				eprintln!(
					"Still starting after {}s — phase: CLI bootstrap / dispatch",
					started.elapsed().as_secs()
				);
			}
		})
		.ok();
	*state = Some(StartupWatchdog { stop, started });
}

/// Stops the startup watchdog at the mode handoff and emits the requested
/// machine-oriented timing fact.
pub fn stop_watchdog() {
	let watchdog = STARTUP_WATCHDOG.lock().take();
	let Some(watchdog) = watchdog else {
		return;
	};
	let _ = watchdog.stop.send(());
	let startup_dispatch_ms = watchdog.started.elapsed().as_millis();
	if env::var_os("OMP_TIMING").is_some() {
		eprintln!("OMP_TIMING startup_dispatch_ms={}", startup_dispatch_ms);
	}
	tracing::info!(startup_dispatch_ms, "cli dispatch handed off");
}

const RELEASE_NOTES: &str = concat!(
	"# Changelog\n\n",
	"All notable changes to OMP are recorded here.\n\n",
	"## [",
	env!("CARGO_PKG_VERSION"),
	"]\n\n",
	"### Added\n\n",
	"- Native session titles and startup release-note eligibility.\n",
);

/// Invocation facts which decide whether interactive startup presentation is
/// eligible.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Eligibility {
	/// An existing session is being resumed, continued, or forked.
	pub resume: bool,
	/// User-facing incidental output was explicitly disabled.
	pub quiet:  bool,
	/// Machine-oriented timing output was requested.
	pub timing: bool,
}

impl Eligibility {
	/// Returns whether startup presentation may be emitted to this terminal.
	pub fn allows(self, terminal: bool) -> bool {
		terminal && !self.resume && !self.quiet && !self.timing
	}
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct Release<'a> {
	version: &'a str,
	body:    &'a str,
}

/// Emits the splash and up to three unseen release summaries once for this
/// binary version.
///
/// Ineligible invocations neither print nor advance the seen-version marker, so
/// a later fresh interactive launch can still present the release notes.
pub fn show_once(
	data_dir: &Path,
	model: Option<&Str>,
	thinking: Option<&str>,
	eligibility: Eligibility,
) -> io::Result<()> {
	if !eligibility.allows(io::stderr().is_terminal()) {
		return Ok(());
	}
	let seen_version = read_seen_version(data_dir)?;
	if seen_version.as_deref() == Some(env!("CARGO_PKG_VERSION")) {
		return Ok(());
	}

	eprintln!("OMP coding agent");
	for release in unseen_releases(RELEASE_NOTES, seen_version.as_deref()) {
		eprintln!("What's new in {}: {}", release.version, summarize(release.body));
	}
	if let Some(model) = model {
		if let Some(thinking) = thinking {
			eprintln!("Model scope: {model} · thinking {thinking}");
		} else {
			eprintln!("Model scope: {model}");
		}
	}
	fs::create_dir_all(data_dir)?;
	fs::write(data_dir.join(NOTICE_VERSION_FILE), env!("CARGO_PKG_VERSION"))
}

fn read_seen_version(data_dir: &Path) -> io::Result<Option<String>> {
	match fs::read_to_string(data_dir.join(NOTICE_VERSION_FILE)) {
		Ok(version) => Ok(Some(version.trim().to_owned())),
		Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
		Err(error) => Err(error),
	}
}

fn unseen_releases<'a>(changelog: &'a str, seen_version: Option<&str>) -> Vec<Release<'a>> {
	let changelog = &changelog[..changelog.len().min(MAX_CHANGELOG_BYTES)];
	let mut releases = Vec::with_capacity(MAX_UNSEEN_RELEASES);
	let mut current: Option<(&str, usize)> = None;
	for (offset, _) in changelog.match_indices('\n') {
		let line_start = offset + 1;
		let rest = &changelog[line_start..];
		let Some(line_end) = rest.find('\n') else {
			continue;
		};
		let heading = rest[..line_end].trim();
		let Some(version) = heading
			.strip_prefix("## [")
			.and_then(|value| value.split_once(']').map(|pair| pair.0))
		else {
			continue;
		};
		if let Some((previous, body_start)) = current.take() {
			releases
				.push(Release { version: previous, body: changelog[body_start..line_start].trim() });
			if releases.len() == MAX_UNSEEN_RELEASES || Some(version) == seen_version {
				return releases;
			}
		}
		if Some(version) == seen_version {
			return releases;
		}
		current = Some((version, line_start + line_end + 1));
	}
	if let Some((version, body_start)) = current
		&& releases.len() < MAX_UNSEEN_RELEASES
	{
		releases.push(Release { version, body: changelog[body_start..].trim() });
	}
	releases
}

fn summarize(body: &str) -> String {
	let mut summary = String::new();
	for line in body.lines().map(str::trim) {
		let Some(item) = line.strip_prefix("- ") else {
			continue;
		};
		if !summary.is_empty() {
			summary.push_str("; ");
		}
		summary.push_str(item);
		if summary.len() >= 320 {
			summary.truncate(320);
			summary.push_str("...");
			break;
		}
	}
	if summary.is_empty() {
		"Release notes available.".to_owned()
	} else {
		summary
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn eligibility_suppresses_every_noninteractive_lane() {
		assert!(Eligibility::default().allows(true));
		assert!(!Eligibility::default().allows(false));
		assert!(!Eligibility { resume: true, ..Eligibility::default() }.allows(true));
		assert!(!Eligibility { quiet: true, ..Eligibility::default() }.allows(true));
		assert!(!Eligibility { timing: true, ..Eligibility::default() }.allows(true));
	}

	#[test]
	fn version_marker_is_recognized() {
		let state = tempfile::tempdir().expect("state");
		fs::create_dir_all(state.path()).expect("create");
		fs::write(state.path().join(NOTICE_VERSION_FILE), env!("CARGO_PKG_VERSION")).expect("marker");
		assert_eq!(
			read_seen_version(state.path()).expect("read").as_deref(),
			Some(env!("CARGO_PKG_VERSION"))
		);
	}

	#[test]
	fn changelog_stops_at_seen_version_and_caps_results() {
		let notes = "# Changelog\n\n## [4.0.0]\n- Four\n## [3.0.0]\n- Three\n## [2.0.0]\n- Two\n## \
		             [1.0.0]\n- One\n";
		let releases = unseen_releases(notes, Some("1.0.0"));
		assert_eq!(
			releases
				.iter()
				.map(|release| release.version)
				.collect::<Vec<_>>(),
			["4.0.0", "3.0.0", "2.0.0"]
		);
		assert_eq!(summarize(releases[0].body), "Four");
	}
}
