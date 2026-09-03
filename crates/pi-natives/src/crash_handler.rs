//! Native crash diagnostics.
//!
//! Installs Rust-side panic and allocation-error hooks the first time the
//! native module loads, so any crash inside `pi-natives` writes an actionable
//! record (thread, payload, backtrace) to disk and to stderr before the host
//! process exits.
//!
//! Without these hooks, Bun receives only the bare
//! `memory allocation of N bytes failed` line and aborts with no stack —
//! see issue #2211 ("Windows crash: Rust allocator failure after tasklist.exe
//! popup"). The cdylib builds with `panic = "unwind"`, so a panic in vendored
//! uutils code unwinds to the shell boundary and is recovered as a failed
//! command, and a panic in a `task::blocking` worker is caught at the napi
//! boundary and surfaces as a rejected JS Promise; such recoverable panics are
//! logged to disk only, while fatal crashes (allocation failure, or panics
//! with no active recovery scope) still get the stderr dump + process exit.
//! Either way the record stays diagnosable.
//!
//! Notes:
//! - Backtraces are captured via [`Backtrace::force_capture`], so they work
//!   regardless of `RUST_BACKTRACE`.
//! - The crash log path mirrors the JS side (`packages/utils/src/dirs.ts`):
//!   `$XDG_STATE_HOME/omp/logs/` on Linux / macOS when the user has migrated to
//!   XDG (i.e. that directory already exists and `PI_CODING_AGENT_DIR` isn't
//!   pointed somewhere custom), otherwise `<home>/<PI_CONFIG_DIR>/logs/`
//!   (defaulting to `~/.omp/logs/`).
//! - Hook installation is idempotent across repeated module loads.

use std::{
	alloc::Layout,
	backtrace::Backtrace,
	cell::Cell,
	ffi::OsStr,
	fmt::Write as _,
	fs::{self, OpenOptions},
	io::Write as _,
	path::{Path, PathBuf},
	process,
	sync::{
		Once,
		atomic::{AtomicBool, Ordering},
	},
	thread,
	time::{SystemTime, UNIX_EPOCH},
};

/// Default directory name for OMP's per-user state (overridable via
/// `PI_CONFIG_DIR`, matching `packages/utils/src/dirs.ts`).
const DEFAULT_CONFIG_DIR: &str = ".omp";

/// App name used as the XDG-root subdirectory (`$XDG_STATE_HOME/omp/`),
/// matching `APP_NAME` in `packages/utils/src/dirs.ts`.
#[cfg(any(target_os = "linux", target_os = "macos"))]
const APP_NAME: &str = "omp";

static INSTALL: Once = Once::new();
static ALLOC_HOOK_ACTIVE: AtomicBool = AtomicBool::new(false);

thread_local! {
	/// Active `task::blocking` panic recovery frames on this thread.
	///
	/// The panic hook runs before [`std::panic::catch_unwind`] returns. A
	/// borrow-free `Cell` lets the hook recognize panics that are already inside
	/// a known recovery boundary without touching potentially borrowed task
	/// state while the stack is unwinding.
	static BLOCKING_TASK_PANIC_SCOPE_DEPTH: Cell<usize> = const { Cell::new(0) };
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PanicDisposition {
	/// No recovery boundary is active: persist the report, echo it to stderr,
	/// and chain to the default hook (which ends the process).
	Fatal,
	/// The panic will be caught and mapped to a failed command / rejected
	/// Promise: persist the report to the crash log for diagnosis, but keep
	/// stderr quiet and do not chain to the default hook.
	LoggedRecoverable,
}

/// Install the panic and allocation-error hooks. Idempotent.
pub fn install() {
	INSTALL.call_once(|| {
		let prev_panic = std::panic::take_hook();
		std::panic::set_hook(Box::new(move |info| match panic_disposition() {
			PanicDisposition::LoggedRecoverable => {
				let report = format_panic_report(info);
				persist(&report, CrashKind::Panic, false);
			},
			PanicDisposition::Fatal => {
				let report = format_panic_report(info);
				persist(&report, CrashKind::Panic, true);
				prev_panic(info);
			},
		}));

		std::alloc::set_alloc_error_hook(|layout| {
			// Print the canonical line before doing anything allocation-prone.
			// If this is genuine process-wide OOM, report formatting/path work may
			// recursively enter this hook; the secondary entry writes the same
			// stack-only fallback and aborts immediately.
			write_alloc_failure_line(std::io::stderr(), layout.size());
			if ALLOC_HOOK_ACTIVE.swap(true, Ordering::AcqRel) {
				process::abort();
			}
			let report = format_alloc_report(layout);
			persist(&report, CrashKind::Alloc, true);
			process::abort();
		});
	});
}

/// Run `f` inside a `task::blocking` panic recovery boundary.
///
/// The global panic hook checks this thread-local scope before reporting a
/// panic. When a blocking worker closure panics, [`std::panic::catch_unwind`]
/// will turn it into a rejected JS Promise, so the hook downgrades the panic
/// to [`PanicDisposition::LoggedRecoverable`]: the report (location +
/// backtrace) is still persisted to the crash log, but nothing is echoed to
/// stderr and the default hook is not chained.
pub(crate) fn blocking_task_panic_scope<R>(f: impl FnOnce() -> R) -> R {
	struct Guard;

	impl Drop for Guard {
		fn drop(&mut self) {
			BLOCKING_TASK_PANIC_SCOPE_DEPTH.with(|d| d.set(d.get().saturating_sub(1)));
		}
	}

	BLOCKING_TASK_PANIC_SCOPE_DEPTH.with(|d| d.set(d.get() + 1));
	let _guard = Guard;
	f()
}

fn blocking_task_panic_scope_active() -> bool {
	BLOCKING_TASK_PANIC_SCOPE_DEPTH.with(|d| d.get() > 0)
}

fn panic_disposition() -> PanicDisposition {
	if blocking_task_panic_scope_active() || pi_shell::panic_scope_active() {
		PanicDisposition::LoggedRecoverable
	} else {
		PanicDisposition::Fatal
	}
}

#[derive(Clone, Copy)]
enum CrashKind {
	Panic,
	Alloc,
}

impl CrashKind {
	const fn as_str(self) -> &'static str {
		match self {
			Self::Panic => "panic",
			Self::Alloc => "alloc",
		}
	}
}

fn format_panic_report(info: &std::panic::PanicHookInfo<'_>) -> String {
	let bt = Backtrace::force_capture();
	let location = info.location().map_or_else(
		|| String::from("<unknown>"),
		|l| format!("{}:{}:{}", l.file(), l.line(), l.column()),
	);
	let mut out = report_header(CrashKind::Panic);
	let _ = writeln!(out, "location: {location}");
	let _ = writeln!(out, "message:  {}", panic_payload(info.payload()));
	let _ = writeln!(out, "backtrace:\n{bt}");
	out
}

fn format_alloc_report(layout: Layout) -> String {
	// Capturing a backtrace allocates. If the global allocator is in a state
	// where small allocations keep failing this will recurse into the hook —
	// `Backtrace::force_capture` swallows the secondary failure internally and
	// returns an empty backtrace, which is still strictly more useful than the
	// nothing the default handler prints.
	let bt = Backtrace::force_capture();
	let mut out = report_header(CrashKind::Alloc);
	let _ = writeln!(out, "size:      {} bytes", layout.size());
	let _ = writeln!(out, "alignment: {} bytes", layout.align());
	let _ = writeln!(out, "backtrace:\n{bt}");
	out
}

fn report_header(kind: CrashKind) -> String {
	let thread_name = thread::current().name().unwrap_or("<unnamed>").to_owned();
	let now_ms = unix_millis();
	format!(
		"pi-natives {kind} crash\npid:       {pid}\nthread:    {thread_name}\ntimestamp: {now_ms} \
		 (unix ms)\n",
		kind = kind.as_str(),
		pid = process::id(),
	)
}
fn write_alloc_failure_line(mut out: impl std::io::Write, size: usize) {
	let _ = out.write_all(b"memory allocation of ");
	let mut digits = [0u8; usize::MAX.ilog10() as usize + 1];
	let mut pos = digits.len();
	let mut value = size;
	if value == 0 {
		pos -= 1;
		digits[pos] = b'0';
	} else {
		while value > 0 {
			pos -= 1;
			digits[pos] = b'0' + (value % 10) as u8;
			value /= 10;
		}
	}
	let _ = out.write_all(&digits[pos..]);
	let _ = out.write_all(b" bytes failed\n");
}

/// Extract a printable message from a panic payload captured by
/// [`std::panic::catch_unwind`] or handed to the panic hook. Handles the two
/// shapes `panic!` produces — `&'static str` (literal) and `String`
/// (formatted) — and degrades to a sentinel for arbitrary
/// [`panic_any`](std::panic::panic_any) payloads.
pub(crate) fn panic_payload(payload: &(dyn std::any::Any + Send)) -> String {
	if let Some(s) = payload.downcast_ref::<&'static str>() {
		(*s).to_owned()
	} else if let Some(s) = payload.downcast_ref::<String>() {
		s.clone()
	} else {
		String::from("<non-string panic payload>")
	}
}

fn persist(report: &str, kind: CrashKind, echo_stderr: bool) {
	// Echo to stderr so the user sees something even when the file write fails
	// (read-only home, missing $HOME, …). Suppressed for recoverable panics
	// (uutils shell boundary, `task::blocking` workers), which surface as a
	// failed command / rejected Promise instead of a crash.
	if echo_stderr {
		let _ = writeln!(std::io::stderr(), "{report}");
	}

	let Some(path) = crash_log_path(kind) else {
		return;
	};
	if let Some(parent) = path.parent() {
		let _ = fs::create_dir_all(parent);
	}
	if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
		let _ = f.write_all(report.as_bytes());
		let _ = f.flush();
		let _ = f.sync_data();
		if echo_stderr {
			let _ =
				writeln!(std::io::stderr(), "pi-natives crash report written to {}", path.display());
		}
	}
}

fn crash_log_path(kind: CrashKind) -> Option<PathBuf> {
	let dir = logs_dir()?;
	Some(build_crash_log_path(&dir, kind, process::id(), unix_millis()))
}

fn build_crash_log_path(dir: &Path, kind: CrashKind, pid: u32, now_ms: u128) -> PathBuf {
	dir.join(format!("native-{}-{pid}-{now_ms}.log", kind.as_str()))
}

fn logs_dir() -> Option<PathBuf> {
	let home = home_dir()?;
	let config_override = std::env::var_os("PI_CONFIG_DIR");
	let xdg_logs = xdg_state_logs_from_env(&home, config_override.as_deref());
	Some(resolve_logs_dir(&home, config_override.as_deref(), xdg_logs))
}

fn resolve_logs_dir(
	home: &Path,
	config_dir_override: Option<&OsStr>,
	xdg_state_logs: Option<PathBuf>,
) -> PathBuf {
	// XDG takes precedence so users who migrated to `$XDG_STATE_HOME/omp/logs/`
	// see native crash reports in the same directory the JS logger rotates.
	if let Some(p) = xdg_state_logs {
		return p;
	}
	let config_dir = config_dir_override
		.filter(|s| !s.is_empty())
		.unwrap_or_else(|| OsStr::new(DEFAULT_CONFIG_DIR));
	let base = config_root_dir(home, config_dir);
	base.join("logs")
}

/// Compute the XDG-state logs dir if the runtime environment matches the
/// JS-side eligibility rules in `packages/utils/src/dirs.ts`: linux/macos,
/// `$XDG_STATE_HOME` set, `$XDG_STATE_HOME/omp` exists on disk, and
/// `PI_CODING_AGENT_DIR` is unset or pointing at the default agent dir.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn xdg_state_logs_from_env(home: &Path, config_dir_override: Option<&OsStr>) -> Option<PathBuf> {
	let default_agent_dir = default_agent_dir(home, config_dir_override);
	let agent_override = std::env::var_os("PI_CODING_AGENT_DIR");
	let xdg_state_home = std::env::var_os("XDG_STATE_HOME");
	xdg_state_logs(
		xdg_state_home.as_deref(),
		agent_override.as_deref(),
		&default_agent_dir,
		Path::exists,
	)
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
#[allow(clippy::missing_const_for_fn, reason = "windows/non-xdg platforms keep the signature")]
fn xdg_state_logs_from_env(_home: &Path, _config_dir_override: Option<&OsStr>) -> Option<PathBuf> {
	None
}

/// Pure XDG-eligibility computation extracted for unit testing — no env
/// reads, no fs reads. `omp_dir_exists` decides whether the candidate
/// `<xdg_state_home>/omp` actually lives on disk.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn xdg_state_logs(
	xdg_state_home: Option<&OsStr>,
	agent_dir_override: Option<&OsStr>,
	default_agent_dir: &Path,
	omp_dir_exists: impl FnOnce(&Path) -> bool,
) -> Option<PathBuf> {
	if let Some(ov) = agent_dir_override.filter(|s| !s.is_empty()) {
		// `path.resolve(value)` on the JS side: make absolute against cwd
		// without touching the filesystem. Anything that diverges from the
		// default agent dir disables XDG, matching `isDefault === false`.
		let resolved = std::path::absolute(Path::new(ov)).ok()?;
		if resolved != default_agent_dir {
			return None;
		}
	}
	let xdg = xdg_state_home.filter(|s| !s.is_empty())?;
	let omp_dir = Path::new(xdg).join(APP_NAME);
	if !omp_dir_exists(&omp_dir) {
		return None;
	}
	Some(omp_dir.join("logs"))
}
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn default_agent_dir(home: &Path, config_dir_override: Option<&OsStr>) -> PathBuf {
	let config_dir = config_dir_override
		.filter(|s| !s.is_empty())
		.unwrap_or_else(|| OsStr::new(DEFAULT_CONFIG_DIR));
	let base = config_root_dir(home, config_dir);
	base.join("agent")
}

fn config_root_dir(home: &Path, config_dir: &OsStr) -> PathBuf {
	let mut base = PathBuf::from(home);
	for component in Path::new(config_dir).components() {
		match component {
			std::path::Component::Prefix(_) | std::path::Component::RootDir => {},
			std::path::Component::CurDir => {},
			std::path::Component::ParentDir => {
				base.pop();
			},
			std::path::Component::Normal(part) => base.push(part),
		}
	}
	base
}

fn home_dir() -> Option<PathBuf> {
	#[cfg(unix)]
	{
		std::env::var_os("HOME").map(PathBuf::from)
	}
	#[cfg(windows)]
	{
		if let Some(profile) = std::env::var_os("USERPROFILE") {
			return Some(PathBuf::from(profile));
		}
		let drive = std::env::var_os("HOMEDRIVE")?;
		let path = std::env::var_os("HOMEPATH")?;
		let mut combined = drive;
		combined.push(path);
		Some(PathBuf::from(combined))
	}
}

fn unix_millis() -> u128 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map_or(0, |d| d.as_millis())
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn blocking_task_panic_scope_downgrades_to_logged_recoverable() {
		assert_eq!(panic_disposition(), PanicDisposition::Fatal);
		blocking_task_panic_scope(|| {
			assert_eq!(panic_disposition(), PanicDisposition::LoggedRecoverable);
		});
		assert_eq!(panic_disposition(), PanicDisposition::Fatal);
	}

	#[test]
	fn blocking_task_panic_scope_restores_after_unwind() {
		// Silence the process-global hook for the injected panic (and serialize
		// the swap with every other hook-mutating test — see `crate::testing`).
		let _silence = crate::testing::SilenceHook::new();
		let unwound = std::panic::catch_unwind(|| blocking_task_panic_scope(|| panic!("boom")));

		assert!(unwound.is_err(), "panic propagated to catch_unwind");
		assert_eq!(panic_disposition(), PanicDisposition::Fatal);
	}

	#[test]
	fn alloc_report_contains_size_alignment_and_backtrace() {
		let layout = Layout::from_size_align(7714, 8).unwrap();
		let report = format_alloc_report(layout);
		assert!(report.contains("pi-natives alloc crash"), "report missing header: {report}");
		assert!(report.contains("size:      7714 bytes"), "report missing size: {report}");
		assert!(report.contains("alignment: 8 bytes"), "report missing alignment: {report}");
		assert!(report.contains("backtrace:"), "report missing backtrace section: {report}");
		assert!(
			report.contains(&format!("pid:       {}", process::id())),
			"report missing pid: {report}"
		);
		assert!(report.contains("thread:"), "report missing thread: {report}");
	}

	#[test]
	fn alloc_failure_line_matches_rust_default_text_without_heap_formatting() {
		let mut buf = Vec::new();
		write_alloc_failure_line(&mut buf, 7714);
		assert_eq!(buf, b"memory allocation of 7714 bytes failed\n");
		buf.clear();
		write_alloc_failure_line(&mut buf, usize::MAX);
		assert_eq!(buf, format!("memory allocation of {} bytes failed\n", usize::MAX).as_bytes());
	}

	#[test]
	fn panic_payload_handles_str_string_and_other() {
		let static_str: Box<dyn std::any::Any + Send> = Box::new("static panic");
		assert_eq!(panic_payload(&*static_str), "static panic");

		let owned: Box<dyn std::any::Any + Send> = Box::new(String::from("owned panic"));
		assert_eq!(panic_payload(&*owned), "owned panic");

		let other: Box<dyn std::any::Any + Send> = Box::new(42u32);
		assert_eq!(panic_payload(&*other), "<non-string panic payload>");
	}

	#[test]
	fn resolve_logs_dir_defaults_under_dot_omp() {
		let dir = resolve_logs_dir(Path::new("/tmp/pi-natives-test-home"), None, None);
		assert_eq!(dir, PathBuf::from("/tmp/pi-natives-test-home/.omp/logs"));
	}

	#[test]
	fn resolve_logs_dir_honors_relative_pi_config_dir() {
		let dir = resolve_logs_dir(
			Path::new("/tmp/pi-natives-test-home"),
			Some(OsStr::new(".omp-dev")),
			None,
		);
		assert_eq!(dir, PathBuf::from("/tmp/pi-natives-test-home/.omp-dev/logs"));
	}

	#[test]
	fn resolve_logs_dir_reroots_absolute_pi_config_dir_under_home() {
		// JS resolves the config root via `path.join(os.homedir(),
		// getConfigDirName())`, which never honors an absolute PI_CONFIG_DIR — it is
		// always re-rooted under `$HOME` (and `..` components are normalized away).
		let dir = resolve_logs_dir(
			Path::new("/tmp/pi-natives-test-home"),
			Some(OsStr::new("/var/tmp/pi-natives-state")),
			None,
		);
		assert_eq!(dir, PathBuf::from("/tmp/pi-natives-test-home/var/tmp/pi-natives-state/logs"));
	}

	#[test]
	fn resolve_logs_dir_normalizes_parent_components_like_path_join() {
		let dir = resolve_logs_dir(
			Path::new("/tmp/pi-natives-test-home"),
			Some(OsStr::new("nested/../.omp-dev")),
			None,
		);
		assert_eq!(dir, PathBuf::from("/tmp/pi-natives-test-home/.omp-dev/logs"));
	}

	#[cfg(any(target_os = "linux", target_os = "macos"))]
	#[test]
	fn xdg_state_logs_ignores_empty_agent_dir_override() {
		// An empty PI_CODING_AGENT_DIR is "unset", not a divergent override; it
		// must not disable XDG resolution.
		let dir = xdg_state_logs(
			Some(OsStr::new("/xdg/state")),
			Some(OsStr::new("")),
			Path::new("/tmp/pi-natives-test-home/.omp/agent"),
			|_p| true,
		);
		assert_eq!(dir, Some(PathBuf::from("/xdg/state/omp/logs")));
	}

	#[test]
	fn resolve_logs_dir_ignores_empty_pi_config_dir() {
		let dir =
			resolve_logs_dir(Path::new("/tmp/pi-natives-test-home"), Some(OsStr::new("")), None);
		assert_eq!(dir, PathBuf::from("/tmp/pi-natives-test-home/.omp/logs"));
	}

	#[test]
	fn resolve_logs_dir_prefers_xdg_when_provided() {
		let dir = resolve_logs_dir(
			Path::new("/tmp/pi-natives-test-home"),
			None,
			Some(PathBuf::from("/xdg/state/omp/logs")),
		);
		assert_eq!(dir, PathBuf::from("/xdg/state/omp/logs"));
	}

	#[cfg(any(target_os = "linux", target_os = "macos"))]
	#[test]
	fn xdg_state_logs_resolves_when_dir_exists_and_no_agent_override() {
		let dir = xdg_state_logs(
			Some(OsStr::new("/xdg/state")),
			None,
			Path::new("/tmp/pi-natives-test-home/.omp/agent"),
			|_p| true,
		);
		assert_eq!(dir, Some(PathBuf::from("/xdg/state/omp/logs")));
	}

	#[cfg(any(target_os = "linux", target_os = "macos"))]
	#[test]
	fn xdg_state_logs_skipped_when_omp_dir_missing() {
		let dir = xdg_state_logs(
			Some(OsStr::new("/xdg/state")),
			None,
			Path::new("/tmp/pi-natives-test-home/.omp/agent"),
			|_p| false,
		);
		assert_eq!(dir, None);
	}

	#[cfg(any(target_os = "linux", target_os = "macos"))]
	#[test]
	fn xdg_state_logs_skipped_when_xdg_state_home_unset_or_empty() {
		let default_agent = Path::new("/tmp/pi-natives-test-home/.omp/agent");
		assert_eq!(xdg_state_logs(None, None, default_agent, |_p| true), None);
		assert_eq!(xdg_state_logs(Some(OsStr::new("")), None, default_agent, |_p| true), None);
	}

	#[cfg(any(target_os = "linux", target_os = "macos"))]
	#[test]
	fn xdg_state_logs_skipped_when_agent_dir_overridden() {
		// `PI_CODING_AGENT_DIR` pointing elsewhere mirrors the JS `isDefault === false`
		// branch in `packages/utils/src/dirs.ts` and must disable XDG.
		let dir = xdg_state_logs(
			Some(OsStr::new("/xdg/state")),
			Some(OsStr::new("/some/custom/agent")),
			Path::new("/tmp/pi-natives-test-home/.omp/agent"),
			|_p| true,
		);
		assert_eq!(dir, None);
	}

	#[cfg(any(target_os = "linux", target_os = "macos"))]
	#[test]
	fn xdg_state_logs_honored_when_agent_override_matches_default() {
		let default_agent = std::path::absolute(Path::new("./.omp/agent")).unwrap();
		let dir = xdg_state_logs(
			Some(OsStr::new("/xdg/state")),
			Some(OsStr::new("./.omp/agent")),
			&default_agent,
			|_p| true,
		);
		assert_eq!(dir, Some(PathBuf::from("/xdg/state/omp/logs")));
	}

	#[cfg(any(target_os = "linux", target_os = "macos"))]
	#[test]
	fn default_agent_dir_uses_dot_omp_by_default() {
		let dir = default_agent_dir(Path::new("/tmp/pi-natives-test-home"), None);
		assert_eq!(dir, PathBuf::from("/tmp/pi-natives-test-home/.omp/agent"));
	}
	#[cfg(any(target_os = "linux", target_os = "macos"))]
	#[test]
	fn default_agent_dir_respects_pi_config_dir() {
		let dir =
			default_agent_dir(Path::new("/tmp/pi-natives-test-home"), Some(OsStr::new(".omp-dev")));
		assert_eq!(dir, PathBuf::from("/tmp/pi-natives-test-home/.omp-dev/agent"));
	}

	#[test]
	fn build_crash_log_path_tags_kind_and_pid() {
		let dir = Path::new("/tmp/pi-natives-test-home/.omp/logs");
		let panic_log = build_crash_log_path(dir, CrashKind::Panic, 4242, 1_700_000_000_000);
		assert_eq!(
			panic_log,
			PathBuf::from("/tmp/pi-natives-test-home/.omp/logs/native-panic-4242-1700000000000.log")
		);
		let alloc_log = build_crash_log_path(dir, CrashKind::Alloc, 99, 1);
		assert_eq!(
			alloc_log,
			PathBuf::from("/tmp/pi-natives-test-home/.omp/logs/native-alloc-99-1.log")
		);
	}
}
