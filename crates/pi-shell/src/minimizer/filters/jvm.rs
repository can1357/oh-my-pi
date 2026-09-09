//! JVM build-tool output filters (Apache Maven + Gradle).
//!
//! Maven side: Surefire/Failsafe block collapse, compile error/warning dedup,
//! package/install pipeline with quiet-mode toggle and phase detection. Ported
//! from rtk's `src/cmds/jvm/mvn_cmd.rs` — the execution-side concerns
//! (wrapper resolution, tee, exit propagation) do not port; this module filters
//! one already-captured buffer.
//!
//! Gradle side: strip-ansi then task-dispatched filtering. `detect_task`
//! re-tokenises the raw command to route into per-task filters —
//! `Build` / `Test` / `ConnectedTest` / `Lint` / `Dependencies` /
//! `SpringBootRun` — with an `Other` fallback for unrecognised tasks. Each
//! collapses the matching noise
//! (progress redraws, up-to-date task spam, deprecation chatter) while keeping
//! failures, reports, and resolved dependency trees.
//!
//! Replaces the deleted `defs/{maven,gradle,mvn-build}.toml` pipeline filters
//! with a Rust module capable of state-machine parsing (block collapse,
//! continuation tracking, mode toggle) that the TOML DSL cannot express.

use std::{collections::HashSet, fmt::Write as _, sync::LazyLock};

use regex::Regex;

use crate::minimizer::{
	MinimizerCtx, MinimizerOutput,
	primitives::{self, CapClass},
};

/// Cap on emitted failing test-class blocks and `[ERROR] Failures:` summary
/// entries. rtk bound this to `CAP_WARNINGS`; the minimizer's equivalent is
/// [`CapClass::Warnings`] (120).
const fn max_mvn_failing_classes() -> usize {
	CapClass::Warnings.lines()
}

// ── Shared line predicates ──────────────────────────────────────────────────
//
// Pure prefix matches are expressed as `str::starts_with` predicates rather
// than anchored regexes (clippy::trivial_regex, and faster).

/// `[INFO] Running com.example.app.FooTest`
fn is_running(line: &str) -> bool {
	line.starts_with("[INFO] Running ")
}

/// Reactor summary header opening the per-module pass/fail block.
fn is_reactor_summary(line: &str) -> bool {
	line.starts_with("[INFO] Reactor Summary for ")
}

// ── Shared regex patterns ────────────────────────────────────────────────────

/// Surefire/Failsafe per-class close line. Captures `Failures` and `Errors`.
/// Tolerates the optional `<<< FAILURE!` / `<<< ERROR!` marker (3.5.5 emits
/// `<<< FAILURE!` even for errors-only classes; `ERROR!` accepted defensively
/// for other Surefire versions; failure detection is via the captured counts,
/// not the marker). Separator is `-` (Surefire 2.x) or `--` (Surefire 3.x).
/// Prefix INFO/ERROR/WARNING (3.x emits WARNING for classes with only skipped
/// tests).
static CLOSE: LazyLock<Regex> = LazyLock::new(|| {
	Regex::new(
		r"^\[(?:INFO|ERROR|WARNING)\] Tests run: \d+, Failures: (\d+), Errors: (\d+), Skipped: \d+, Time elapsed: [^ ]+ s(?:\s+<<<\s*(?:FAILURE|ERROR)!)?\s+--?\s+in (.+)$",
	)
	.unwrap()
});

/// Final BUILD footer.
static BUILD_FOOT: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"^\[(?:INFO|ERROR)\] BUILD (?:SUCCESS|FAILURE)$").unwrap());

/// `[INFO] Results:` separator before the aggregate.
static RESULTS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\[INFO\] Results:\s*$").unwrap());

/// Aggregate counts line (no `Time elapsed`, no ` - in `).
static AGG: LazyLock<Regex> = LazyLock::new(|| {
	Regex::new(r"^\[(?:INFO|ERROR)\] Tests run: \d+, Failures: \d+, Errors: \d+, Skipped: \d+\s*$")
		.unwrap()
});

/// Plugin banner line: `[INFO] --- plugin:goal (id) @ module ---`.
static PLUGIN_BANNER: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"^\[INFO\] --- .* @ .* ---$").unwrap());

/// Module banner with project name in brackets.
static MODULE_BANNER: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"^\[INFO\] -+< .+ >-+$").unwrap());

/// Compile-error coordinate substring to strip when deduping warnings/errors.
static FILE_COORD: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"/[^:]+\.java:\[\d+,\d+\]").unwrap());

// ── Dispatch ─────────────────────────────────────────────────────────────────

/// True for every Maven/Gradle program token, regardless of subcommand.
///
/// The active phase is decided inside [`filter`] by re-tokenizing the raw
/// command, never by `ctx.subcommand` (which is the FIRST non-flag arg and so
/// mis-reports the phase for `mvn clean install` — it would say `clean`).
#[must_use]
pub fn supports(program: &str, _subcommand: Option<&str>) -> bool {
	is_mvn_family(program) || is_gradle_family(program)
}

fn is_mvn_family(program: &str) -> bool {
	// Defensive `.cmd` arm in case `normalize_program` is bypassed; the
	// normalizer already maps `mvnw.cmd` -> `mvnw`.
	matches!(program, "mvn" | "mvnw" | "mvnw.cmd")
}

fn is_gradle_family(program: &str) -> bool {
	matches!(program, "gradle" | "gradlew" | "gradlew.bat")
}

#[must_use]
pub fn filter(ctx: &MinimizerCtx<'_>, input: &str, _exit_code: i32) -> MinimizerOutput {
	if is_gradle_family(ctx.program) {
		return filter_gradle(ctx, input);
	}

	// Maven family.
	//
	// Verbose flags bypass filtering entirely — the user asked for full output.
	if has_verbose_flag(ctx.command) {
		return MinimizerOutput::passthrough(input);
	}

	let phase = detect_phase(ctx.command);

	// Quiet mode is orthogonal to phase: `mvn -q` suppresses all `[INFO]` lines
	// so the footer guard / `Running` markers the standard filters key off can't
	// fire. Route any non-passthrough phase to `filter_quiet`.
	let text = if phase == MvnPhase::SpringBootRun {
		// `mvn spring-boot:run` — application runtime output, not a build. The
		// banner/INFO strip + keep-list lives in `filter_spring_boot`, shared with
		// the gradle `bootRun` task.
		filter_spring_boot(&primitives::strip_ansi(input))
	} else if is_quiet(ctx.command) && phase != MvnPhase::Passthrough {
		filter_quiet(input)
	} else {
		match phase {
			MvnPhase::Test => filter_surefire(input),
			MvnPhase::Compile => filter_compile(input),
			MvnPhase::Package => filter_package(input),
			MvnPhase::Passthrough => filter_passthrough(input),
			// Unreachable: SpringBootRun handled above. Kept exhaustive.
			MvnPhase::SpringBootRun => filter_passthrough(input),
		}
	};

	if text == input {
		MinimizerOutput::passthrough(input)
	} else {
		MinimizerOutput::transformed(text, input.len())
	}
}

// ── Gradle dispatch ──────────────────────────────────────────────────────────

/// Gradle/`gradlew` entry. Strips ANSI/`\r` progress first (gradle captures
/// carry both), then routes by task. Verbose flags
/// (`--stacktrace`/`--info`/`--debug`/`--full-stacktrace`) bypass filtering —
/// the user explicitly asked for full detail (adopts rtk's
/// `gradlew_cmd.rs::run` user-asked-for-detail rule).
fn filter_gradle(ctx: &MinimizerCtx<'_>, input: &str) -> MinimizerOutput {
	if has_gradle_verbose_flag(ctx.command) {
		return MinimizerOutput::passthrough(input);
	}

	let stripped = primitives::strip_ansi(input);
	let text = match detect_task(ctx.command) {
		GradleTask::Build => filter_gradle_build(&stripped),
		GradleTask::Test => filter_gradle_test(&stripped),
		GradleTask::ConnectedTest => filter_gradle_connected(&stripped),
		GradleTask::Lint => filter_gradle_lint(&stripped),
		GradleTask::Dependencies => filter_gradle_dependencies(&stripped),
		GradleTask::SpringBootRun => filter_spring_boot(&stripped),
		GradleTask::Other => filter_gradle_other(&stripped),
	};

	if text == input {
		MinimizerOutput::passthrough(input)
	} else {
		MinimizerOutput::transformed(text, input.len())
	}
}

/// `--stacktrace`/`--info`/`--debug`/`--full-stacktrace` anywhere → full
/// passthrough (rtk `gradlew_cmd.rs::run`).
fn has_gradle_verbose_flag(command: &str) -> bool {
	arg_tokens(command)
		.any(|a| matches!(a, "--stacktrace" | "--info" | "--debug" | "--full-stacktrace"))
}

// ── Command-token scans (re-tokenize ctx.command) ────────────────────────────

/// Tokens of the raw command with the leading program word dropped, mirroring
/// rtk's `args` slice (which never includes the program). Splitting on
/// whitespace is sufficient for flag/goal detection; quoting subtleties do not
/// affect phase/quiet/verbose decisions.
fn arg_tokens(command: &str) -> impl Iterator<Item = &str> {
	command.split_whitespace().skip(1)
}

/// `-X`/`--debug`/`-e`/`--errors` anywhere → full passthrough.
fn has_verbose_flag(command: &str) -> bool {
	arg_tokens(command).any(|a| matches!(a, "-X" | "--debug" | "-e" | "--errors"))
}

/// `mvn -q` / `mvn --quiet` suppresses all `[INFO]` lines.
fn is_quiet(command: &str) -> bool {
	arg_tokens(command).any(|a| a == "-q" || a == "--quiet")
}

// ── Phase detection ─────────────────────────────────────────────────────────

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum MvnPhase {
	Test,          // test, integration-test (Failsafe = Surefire shape)
	Compile,       // compile, test-compile
	Package,       // package, install, verify, deploy
	SpringBootRun, // spring-boot:run (application runtime, not a build)
	Passthrough,   // clean, site, plugin goals, version/help, empty
}

/// Whether `a` is a Maven lifecycle phase or plugin goal we map to a
/// `MvnPhase`.
fn is_recognized_mvn_goal(a: &str) -> bool {
	matches!(
		a,
		"test"
			| "integration-test"
			| "compile"
			| "test-compile"
			| "package"
			| "install"
			| "verify"
			| "deploy"
			| "clean"
			| "site"
			| "site-deploy"
			| "spring-boot:run"
	) || a.ends_with(":spring-boot-maven-plugin:run")
}

/// Returns non-flag tokens from the command, skipping the value token that
/// follows each known value-taking option.  This prevents option values (e.g.
/// the module name after `-pl`, the project dir after `-p`) from being
/// mistaken for build goals/tasks.
fn jvm_positional_tokens<'a>(command: &'a str, value_flags: &[&str]) -> Vec<&'a str> {
	let mut out = Vec::new();
	let mut tokens = command.split_whitespace().skip(1);
	while let Some(tok) = tokens.next() {
		if tok.starts_with('-') {
			let bare = tok.trim_start_matches('-');
			if value_flags
				.iter()
				.any(|f| f.trim_start_matches('-') == bare)
			{
				tokens.next(); // consume the value that follows this option
			}
		} else {
			out.push(tok);
		}
	}
	out
}

/// Scan args left-to-right, skip flags + `-D…` system props, pick the LAST
/// RECOGNIZED lifecycle goal, ignoring unrecognized positional tokens (e.g. the
/// module name after `-pl`).
///
/// If empty, plugin-form (`:`), or `clean`/`site` → Passthrough. Re-tokenizes
/// the raw command because `ctx.subcommand` is the FIRST non-flag arg and so
/// reports the wrong goal for `mvn clean install`.
#[must_use]
pub fn detect_phase(command: &str) -> MvnPhase {
	// Use the last RECOGNIZED lifecycle goal so that option-value tokens
	// (e.g. the module name after -pl) are ignored.
	let last = jvm_positional_tokens(command, &[
		"-pl",
		"--projects",
		"-P",
		"--activate-profiles",
		"-f",
		"--file",
		"-s",
		"--settings",
		"-gs",
		"--global-settings",
		"-t",
		"--toolchains",
		"-gt",
		"--global-toolchains",
		"-T",
		"--threads",
	])
	.into_iter()
	.rfind(|a| is_recognized_mvn_goal(a))
	.unwrap_or("");

	// `spring-boot:run` is checked BEFORE the generic `:`-plugin-goal guard
	// below: it is application runtime output, not a plugin build step, and
	// routes to the dedicated banner/keep-list filter. Match the bare goal and
	// the fully-qualified `org.springframework.boot:spring-boot-maven-plugin:run`
	// form.
	if last == "spring-boot:run" || last.ends_with(":spring-boot-maven-plugin:run") {
		return MvnPhase::SpringBootRun;
	}

	if last.is_empty() || last.contains(':') {
		return MvnPhase::Passthrough;
	}
	match last {
		"clean" | "site" | "site-deploy" => MvnPhase::Passthrough,
		"test" | "integration-test" => MvnPhase::Test,
		"compile" | "test-compile" => MvnPhase::Compile,
		"package" | "install" | "verify" | "deploy" => MvnPhase::Package,
		_ => MvnPhase::Passthrough,
	}
}

// ── Stack-frame deny-list ────────────────────────────────────────────────────

const FRAMEWORK_FRAME_PREFIXES: &[&str] = &[
	"at org.junit.",
	"at junit.",
	"at org.apache.maven.surefire.",
	"at sun.reflect.",
	"at jdk.internal.reflect.",
	"at jdk.proxy",
	"at java.base/",
	"at java.lang.reflect.",
	"at java.util.",
];

fn is_framework_frame(trimmed: &str) -> bool {
	FRAMEWORK_FRAME_PREFIXES
		.iter()
		.any(|p| trimmed.starts_with(p))
}

/// Boilerplate `[ERROR]` lines Maven emits after `Failed to execute goal` —
/// pure noise pointing at log files and help URLs, no signal for the user/LLM.
/// Deliberately excludes `[ERROR] After correcting the problems` and
/// `[ERROR]   mvn <args> -rf :…` (the resume hint is actionable signal for a
/// multi-module build) and `[ERROR] Failed to execute goal` (signal).
const BOILER_PREFIXES: &[&str] = &[
	"[ERROR] See ",
	"[ERROR] -> [Help",
	"[ERROR] To see the full stack trace",
	"[ERROR] Re-run Maven",
	"[ERROR] For more information",
	"[ERROR] [Help",
];

/// Post-failure help boilerplate, plus the bare `[ERROR]` divider lines Maven
/// emits between boilerplate blocks (same drop rules as `filter_quiet`).
fn is_boilerplate(line: &str) -> bool {
	BOILER_PREFIXES.iter().any(|p| line.starts_with(p)) || line.trim_end() == "[ERROR]"
}

/// `[ERROR] FQN.method -- Time elapsed: 0.030 s <<< FAILURE!` (or `<<<
/// ERROR!`). Distinguished from CLOSE by call position: only consulted when
/// `in_block == false` (CLOSE only occurs while a block is open).
fn is_per_test_subline(line: &str) -> bool {
	line.starts_with("[ERROR] ") && (line.contains("<<< FAILURE!") || line.contains("<<< ERROR!"))
}

// ── English-footer guard ────────────────────────────────────────────────────

fn has_english_footer(stripped: &str) -> bool {
	stripped.lines().any(|l| {
		let t = l.trim();
		t.ends_with(" BUILD SUCCESS") || t.ends_with(" BUILD FAILURE")
	})
}

// ── Outside-block keep list (shared by surefire + package) ──────────────────

/// Multi-module reactor summary keeper. Reads `in_reactor_summary` and toggles
/// it on `[INFO] Reactor Summary for …` (enter) and `BUILD SUCCESS`/`BUILD
/// FAILURE` (exit). Returns `true` for every line while the flag is set so the
/// per-module status rows survive. Returns `false` otherwise — the caller's
/// outside-block keep-list still applies.
///
/// Designed to be called **before** `keep_outside_block` so the `BUILD_FOOT`
/// clears-flag side effect always runs regardless of `||` short-circuit.
fn reactor_summary_keep(line: &str, in_reactor_summary: &mut bool) -> bool {
	if is_reactor_summary(line) {
		*in_reactor_summary = true;
		return true;
	}
	if BUILD_FOOT.is_match(line) {
		*in_reactor_summary = false;
		return false;
	}
	*in_reactor_summary
}

fn keep_outside_block(line: &str) -> bool {
	// Help boilerplate must be rejected before the `[ERROR]` catch-all below.
	if is_boilerplate(line) {
		return false;
	}
	RESULTS.is_match(line)
		|| AGG.is_match(line)
		|| BUILD_FOOT.is_match(line)
		|| MODULE_BANNER.is_match(line)
		|| line.starts_with("[INFO] Total time:")
		|| line.starts_with("[INFO] Finished at:")
		|| line.starts_with("[INFO] Building ")
		|| line.starts_with("[INFO] Scanning ")
		|| line.starts_with("[INFO] Installing ")
		|| line.starts_with("[ERROR] Failures:")
		|| line.starts_with("[ERROR] Errors:")
		|| (line.starts_with("[ERROR]") && !line.starts_with("[ERROR] Tests run:"))
		|| line.starts_with("[INFO] Building war:")
		|| line.starts_with("[INFO] Building jar:")
		|| line.starts_with("[INFO] Building ear:")
}

// ── Surefire block filter ───────────────────────────────────────────────────

/// Shared state machine driving the inner Surefire block + failure-trail
/// behaviour for `filter_surefire` and `filter_package`. Each filter wraps it
/// with its own outside-block keep logic, applied on the
/// [`SurefireStep::Passthrough`] arm.
struct SurefireBlock<'a> {
	block_lines:   Vec<&'a str>,
	block_running: Option<&'a str>,
	in_block:      bool,
	failure_trail: bool,
	/// When set together with `failure_trail`, consumes the trail without
	/// writing it to `out`. Used when the caller capped a failing block.
	drop_trail:    bool,
	/// Set when a trail ends at a blank line; holds the `drop_trail` value so
	/// the next per-test subline of the same class re-enters the trail with the
	/// same keep/drop decision.
	trail_rearm:   Option<bool>,
}

enum SurefireStep<'a> {
	/// Inner machine consumed the line; outer loop should `continue;`.
	Consumed,
	/// A CLOSE line with `Failures > 0` or `Errors > 0` was reached.
	FailingClose { running: Option<&'a str>, lines: Vec<&'a str>, close: &'a str },
	/// Inner machine did not handle the line; outer loop applies its own
	/// outside-block keep logic.
	Passthrough,
}

impl<'a> SurefireBlock<'a> {
	const fn new() -> Self {
		Self {
			block_lines:   Vec::new(),
			block_running: None,
			in_block:      false,
			failure_trail: false,
			drop_trail:    false,
			trail_rearm:   None,
		}
	}

	fn step(&mut self, line: &'a str, out: &mut String) -> SurefireStep<'a> {
		if PLUGIN_BANNER.is_match(line) {
			return SurefireStep::Consumed;
		}

		if is_running(line) {
			if self.in_block {
				self.flush_open_block_as_keep(out);
			}
			self.block_lines.clear();
			self.block_running = Some(line);
			self.in_block = true;
			self.failure_trail = false;
			// Load-bearing: a capped multi-failure class followed by a kept
			// class must not re-arm into the new class's trail decision.
			self.trail_rearm = None;
			return SurefireStep::Consumed;
		}

		if self.in_block {
			if let Some(caps) = CLOSE.captures(line) {
				let fail = caps.get(1).is_some_and(|m| m.as_str() != "0");
				let err = caps.get(2).is_some_and(|m| m.as_str() != "0");
				if fail || err {
					let lines = std::mem::take(&mut self.block_lines);
					let running = self.block_running.take();
					self.in_block = false;
					return SurefireStep::FailingClose { running, lines, close: line };
				}
				self.block_lines.clear();
				self.block_running = None;
				self.in_block = false;
				return SurefireStep::Consumed;
			}
			self.block_lines.push(line);
			return SurefireStep::Consumed;
		}

		if self.failure_trail {
			if line.is_empty() {
				if !self.drop_trail {
					out.push('\n');
				}
				// Arm re-entry: a following per-test subline belongs to the
				// same class and must inherit this trail's keep/drop decision.
				self.trail_rearm = Some(self.drop_trail);
				self.failure_trail = false;
				self.drop_trail = false;
				return SurefireStep::Consumed;
			}
			let t = line.trim_start();
			if t.starts_with("at ") && is_framework_frame(t) {
				return SurefireStep::Consumed;
			}
			if self.drop_trail {
				return SurefireStep::Consumed;
			}
			out.push_str(line);
			out.push('\n');
			return SurefireStep::Consumed;
		}

		if let Some(dropped) = self.trail_rearm {
			if line.is_empty() {
				// Tolerate extra blanks between per-test blocks: stay armed,
				// let the blank fall through (outer keep-lists drop it).
				return SurefireStep::Passthrough;
			}
			self.trail_rearm = None; // disarm unconditionally on non-blank (load-bearing)
			if is_per_test_subline(line) {
				self.failure_trail = true;
				self.drop_trail = dropped;
				if !dropped {
					out.push_str(line);
					out.push('\n');
				}
				return SurefireStep::Consumed;
			}
			// Non-subline: trail is over; already disarmed — fall through.
		}

		SurefireStep::Passthrough
	}

	/// Mark a `FailingClose` as dropped (cap exceeded). Sets `failure_trail` so
	/// the post-close trail is consumed and silently dropped until the next
	/// blank line.
	const fn drop_failing(&mut self) {
		self.failure_trail = true;
		self.drop_trail = true;
		self.trail_rearm = None;
	}

	/// Commit a `FailingClose` to `out`: writes `running`, then `lines` (with
	/// framework frames stripped), then `close`. Enables `failure_trail` so the
	/// post-close exception/user-frame trail is preserved.
	fn commit_failing(
		&mut self,
		out: &mut String,
		running: Option<&str>,
		lines: &[&str],
		close: &str,
	) {
		if let Some(r) = running {
			out.push_str(r);
			out.push('\n');
		}
		for l in lines {
			let t = l.trim_start();
			if t.starts_with("at ") && is_framework_frame(t) {
				continue;
			}
			out.push_str(l);
			out.push('\n');
		}
		out.push_str(close);
		out.push('\n');
		self.failure_trail = true;
		self.trail_rearm = None;
	}

	/// End-of-stream flush: if a block opened and never closed (truncated
	/// output), surface what we have rather than dropping it silently.
	fn finish(&mut self, out: &mut String) {
		if self.in_block {
			self.flush_open_block_as_keep(out);
		}
	}

	fn flush_open_block_as_keep(&mut self, out: &mut String) {
		if let Some(r) = self.block_running.take() {
			out.push_str(r);
			out.push('\n');
		}
		for l in self.block_lines.drain(..) {
			out.push_str(l);
			out.push('\n');
		}
		self.in_block = false;
	}
}

/// `[ERROR] Failures:` summary block cap. Maven emits a summary at the end of a
/// failing test run; on builds with hundreds of failures this can be large. Cap
/// entries at [`max_mvn_failing_classes`] and emit `\n[…N failures elided…]\n`
/// immediately before the `Tests run:` aggregate when entries were dropped.
struct FailuresSummaryCap {
	cap:        usize,
	in_summary: bool,
	emitted:    usize,
	dropped:    usize,
}

impl FailuresSummaryCap {
	const fn new(cap: usize) -> Self {
		Self { cap, in_summary: false, emitted: 0, dropped: 0 }
	}

	/// If `line` is an `[ERROR]   ` entry inside the failures summary, write it
	/// (or count it as dropped) and return `true` so the caller skips its own
	/// keep-list. Returns `false` otherwise.
	fn handle_entry(&mut self, line: &str, out: &mut String) -> bool {
		if !self.in_summary || !line.starts_with("[ERROR]   ") {
			return false;
		}
		// Per core cap policy, `0` means summary-only: no entries, tail still counts.
		if self.emitted < self.cap {
			out.push_str(line);
			out.push('\n');
			self.emitted += 1;
		} else {
			self.dropped += 1;
		}
		true
	}

	/// Detect the `[ERROR] Failures:` header so subsequent `[ERROR]   ` lines
	/// get capped. Caller writes the header to `out`.
	fn handle_header(&mut self, line: &str) {
		if line.starts_with("[ERROR] Failures:") {
			self.in_summary = true;
			self.emitted = 0;
			self.dropped = 0;
		}
	}

	/// Pre-emit the `[…N failures elided…]` tail when the aggregate
	/// `[ERROR] Tests run:` line is about to be written, then close the summary.
	fn handle_aggregate(&mut self, line: &str, out: &mut String) {
		if !self.in_summary || !AGG.is_match(line) {
			return;
		}
		if self.dropped > 0 {
			let _ = write!(out, "\n[…{} failures elided…]\n", self.dropped);
		}
		self.in_summary = false;
		self.emitted = 0;
		self.dropped = 0;
	}

	/// End-of-stream tail emission for cases where the AGG line never arrives.
	fn finish(&self, out: &mut String) {
		if self.in_summary && self.dropped > 0 {
			let _ = write!(out, "\n[…{} failures elided…]\n", self.dropped);
		}
	}
}

/// Buffered single-pass filter for `mvn test` / `mvn integration-test`.
///
/// English-footer guard: if no `BUILD SUCCESS`/`BUILD FAILURE` line is present,
/// return the ANSI-stripped raw input (non-English locale or truncated output).
#[must_use]
pub fn filter_surefire(raw: &str) -> String {
	filter_surefire_with_cap(raw, max_mvn_failing_classes())
}

fn filter_surefire_with_cap(raw: &str, cap: usize) -> String {
	let stripped = primitives::strip_ansi(raw);
	if !has_english_footer(&stripped) {
		return stripped;
	}

	let mut out = String::new();
	let mut block = SurefireBlock::new();
	let mut keep_continuation = false;
	let mut in_reactor_summary = false;
	let mut emitted_failing: usize = 0;
	let mut dropped_failing: usize = 0;
	let mut summary = FailuresSummaryCap::new(cap);

	for line in stripped.lines() {
		match block.step(line, &mut out) {
			SurefireStep::Consumed => continue,
			SurefireStep::FailingClose { running, lines, close } => {
				if emitted_failing < cap {
					block.commit_failing(&mut out, running, &lines, close);
					emitted_failing += 1;
				} else {
					block.drop_failing();
					dropped_failing += 1;
				}
				keep_continuation = false;
				continue;
			},
			SurefireStep::Passthrough => {},
		}

		if keep_continuation && (line.starts_with(' ') || line.starts_with('\t')) {
			out.push_str(line);
			out.push('\n');
			continue;
		}

		// Failures-summary cap: gate `[ERROR]   ` entries, emit `+N more` tail
		// before AGG. The helper consumes only summary entries.
		if summary.handle_entry(line, &mut out) {
			continue;
		}

		// Order matters: call reactor_summary_keep first so its BUILD_FOOT
		// clears-flag side effect always runs regardless of `||` short-circuit.
		let reactor_keep = reactor_summary_keep(line, &mut in_reactor_summary);
		if reactor_keep || keep_outside_block(line) {
			summary.handle_aggregate(line, &mut out);
			summary.handle_header(line);
			out.push_str(line);
			out.push('\n');
			keep_continuation = line.starts_with("[ERROR]")
				&& !line.starts_with("[ERROR] Tests run:")
				&& !line.starts_with("[ERROR] Failures:")
				&& !line.starts_with("[ERROR] Errors:");
			continue;
		}
		// Dropped line: reset so a stale flag can't keep an indented line that
		// follows a dropped `[ERROR]` line.
		keep_continuation = false;
	}

	block.finish(&mut out);
	summary.finish(&mut out);
	if dropped_failing > 0 {
		let _ = write!(out, "\n[…{dropped_failing} failing test classes elided…]\n");
	}
	out
}

// ── Compile filter ──────────────────────────────────────────────────────────

/// Buffered single-pass filter for `mvn compile` / `test-compile`.
///
/// Keeps module banners, `[INFO] Building …`, `[INFO] BUILD …`, totals, finish
/// time, scanning line, and `[ERROR]` blocks with indented continuation
/// (`symbol:` / `location:` / caret). Deduplicates `[WARNING]` lines by
/// normalised message (strip file coordinates).
pub fn filter_compile(raw: &str) -> String {
	let stripped = primitives::strip_ansi(raw);
	if !has_english_footer(&stripped) {
		return stripped;
	}

	let mut out = String::new();
	let mut keep_continuation = false;
	let mut seen_warnings: HashSet<String> = HashSet::new();

	for line in stripped.lines() {
		if MODULE_BANNER.is_match(line) {
			out.push_str(line);
			out.push('\n');
			keep_continuation = false;
			continue;
		}
		if BUILD_FOOT.is_match(line)
			|| line.starts_with("[INFO] Building ")
			|| line.starts_with("[INFO] Total time:")
			|| line.starts_with("[INFO] Finished at:")
			|| line.starts_with("[INFO] Scanning ")
		{
			out.push_str(line);
			out.push('\n');
			keep_continuation = false;
			continue;
		}
		// Help boilerplate: drop before the `[ERROR]` catch-all.
		if is_boilerplate(line) {
			keep_continuation = false;
			continue;
		}
		if line.starts_with("[ERROR]") {
			out.push_str(line);
			out.push('\n');
			keep_continuation = true;
			continue;
		}
		if keep_continuation && (line.starts_with(' ') || line.starts_with('\t')) {
			out.push_str(line);
			out.push('\n');
			continue;
		}
		if line.starts_with("[WARNING]") {
			let payload = line.strip_prefix("[WARNING] ").unwrap_or(line);
			let norm = FILE_COORD.replace_all(payload, "").to_string();
			if seen_warnings.insert(norm) {
				out.push_str(line);
				out.push('\n');
			}
			keep_continuation = false;
			continue;
		}
		// Drop everything else.
		keep_continuation = false;
	}

	out
}

// ── Package filter ──────────────────────────────────────────────────────────

/// Buffered single-pass filter for `mvn package`/`install`/`verify`/`deploy`.
///
/// Mode toggle: starts in compile mode, switches to Surefire when a
/// `[INFO] Running …` line is seen (via [`SurefireBlock`]). Outside any
/// Surefire block, applies the unified keep-list (compile keepers +
/// install/artifact lines).
#[must_use]
pub fn filter_package(raw: &str) -> String {
	filter_package_with_cap(raw, max_mvn_failing_classes())
}

fn filter_package_with_cap(raw: &str, cap: usize) -> String {
	let stripped = primitives::strip_ansi(raw);
	if !has_english_footer(&stripped) {
		return stripped;
	}

	let mut out = String::new();
	let mut block = SurefireBlock::new();
	let mut keep_continuation = false;
	let mut in_reactor_summary = false;
	let mut seen_warnings: HashSet<String> = HashSet::new();
	let mut emitted_failing: usize = 0;
	let mut dropped_failing: usize = 0;
	let mut summary = FailuresSummaryCap::new(cap);

	for line in stripped.lines() {
		match block.step(line, &mut out) {
			SurefireStep::Consumed => continue,
			SurefireStep::FailingClose { running, lines, close } => {
				if emitted_failing < cap {
					block.commit_failing(&mut out, running, &lines, close);
					emitted_failing += 1;
				} else {
					block.drop_failing();
					dropped_failing += 1;
				}
				keep_continuation = false;
				continue;
			},
			SurefireStep::Passthrough => {},
		}

		if summary.handle_entry(line, &mut out) {
			continue;
		}

		// Order matters: call reactor_summary_keep first so its BUILD_FOOT
		// clears-flag side effect always runs regardless of `||` short-circuit.
		let reactor_keep = reactor_summary_keep(line, &mut in_reactor_summary);
		// Outside any Surefire block: compile-keep AND surefire-outside-keep merge.
		if reactor_keep || MODULE_BANNER.is_match(line) || keep_outside_block(line) {
			summary.handle_aggregate(line, &mut out);
			summary.handle_header(line);
			out.push_str(line);
			out.push('\n');
			keep_continuation = line.starts_with("[ERROR]")
				&& !line.starts_with("[ERROR] Tests run:")
				&& !line.starts_with("[ERROR] Failures:")
				&& !line.starts_with("[ERROR] Errors:");
			continue;
		}
		if keep_continuation && (line.starts_with(' ') || line.starts_with('\t')) {
			out.push_str(line);
			out.push('\n');
			continue;
		}
		if line.starts_with("[WARNING]") {
			let payload = line.strip_prefix("[WARNING] ").unwrap_or(line);
			let norm = FILE_COORD.replace_all(payload, "").to_string();
			if seen_warnings.insert(norm) {
				out.push_str(line);
				out.push('\n');
			}
			keep_continuation = false;
			continue;
		}
		keep_continuation = false;
	}

	block.finish(&mut out);
	summary.finish(&mut out);
	if dropped_failing > 0 {
		let _ = write!(out, "\n[…{dropped_failing} failing test classes elided…]\n");
	}
	out
}

// ── Quiet-mode filter ───────────────────────────────────────────────────────

/// Filter for `mvn -q` invocations.
///
/// Under `-q`, Maven 3.x suppresses all `[INFO]` lines, so the standard
/// filters (which key off the English `BUILD SUCCESS` footer and `[INFO]
/// Running` markers) can't fire. This filter handles the residual `-q` shape:
/// green run → empty; failure run keeps the close-line, per-test subline,
/// exception class, user-code frames, failure summary, and the `Failed to
/// execute goal` terminator; drops framework frames and help boilerplate.
pub fn filter_quiet(raw: &str) -> String {
	let stripped = primitives::strip_ansi(raw);
	if stripped.trim().is_empty() {
		return String::new();
	}

	let mut out = String::new();
	let mut failure_trail = false;

	for line in stripped.lines() {
		// Surefire close-line for a failed class — keep + enter failure trail.
		if CLOSE.is_match(line) {
			out.push_str(line);
			out.push('\n');
			failure_trail = line.contains("<<< FAILURE!") || line.contains("<<< ERROR!");
			continue;
		}

		// Per-test failure subline.
		if is_per_test_subline(line) {
			out.push_str(line);
			out.push('\n');
			failure_trail = true;
			continue;
		}

		// Failure-trail body: exception class, user-code frames; drop framework frames.
		if failure_trail {
			if line.trim().is_empty() {
				out.push('\n');
				failure_trail = false;
				continue;
			}
			let t = line.trim_start();
			if t.starts_with("at ") && is_framework_frame(t) {
				continue;
			}
			out.push_str(line);
			out.push('\n');
			continue;
		}

		// Failure summary keepers.
		if line.starts_with("[ERROR] Tests run:")
			|| line.starts_with("[ERROR] Failures:")
			|| line.starts_with("[ERROR] Errors:")
			|| line.starts_with("[ERROR]   ")
			|| line.starts_with("[ERROR] Failed to execute goal")
		{
			out.push_str(line);
			out.push('\n');
			continue;
		}

		// Drop post-failure help boilerplate and bare `[ERROR]` dividers.
		if is_boilerplate(line) {
			continue;
		}

		// Safety net: keep anything else (unexpected output under `-q` is rare).
		out.push_str(line);
		out.push('\n');
	}

	out
}

// ── Passthrough phase (stateless maven.toml-equivalent strip + cap) ──────────

/// Passthrough phase (`clean`, `site`, plugin goals, `--version`, `--help`).
///
/// rtk ran these as raw passthrough, but the deleted `maven.toml` overlay used
/// to strip download/progress/banner noise on top. To preserve the minimizer's
/// current advantage we replicate that stateless strip here plus a [`CapClass`]
/// cap. (Verbose `-X`/`--debug`/`-e`/`--errors` already short-circuited to a
/// true passthrough before reaching this function.)
fn filter_passthrough(raw: &str) -> String {
	let stripped = primitives::strip_ansi(raw);
	let filtered = primitives::strip_lines(&stripped, &[is_passthrough_noise]);
	primitives::head_tail_cap(&filtered, CapClass::List)
}

/// maven.toml's `strip_lines_matching` set, expressed as a predicate:
/// `Downloading`/`Downloaded`/`Progress`, the `[INFO] -+` / `[INFO] --- ` /
/// `[INFO] Building ` / `[INFO] Scanning for projects` banner noise, and bare
/// `[INFO]` lines.
fn is_passthrough_noise(line: &str) -> bool {
	line.starts_with("[INFO] Downloading ")
		|| line.starts_with("[INFO] Downloaded ")
		|| line.starts_with("[INFO] --- ")
		|| line.starts_with("[INFO] Building ")
		|| line.starts_with("[INFO] Scanning for projects")
		|| line.starts_with("Progress ")
		|| line.trim_end() == "[INFO]"
		|| is_info_dash_banner(line)
}

/// `^\[INFO\] -+` — the all-dashes separator / module-banner shells.
fn is_info_dash_banner(line: &str) -> bool {
	let Some(rest) = line.strip_prefix("[INFO] ") else {
		return false;
	};
	rest.starts_with('-')
		&& rest
			.chars()
			.all(|c| c == '-' || c == '<' || c == '>' || c == ' ')
		|| (rest.starts_with('-') && rest.chars().take_while(|&c| c != ' ').all(|c| c == '-'))
}

// ═══════════════════════════════════════════════════════════════════════════
// GRADLE SIDE
//
// Ported from rtk `src/cmds/jvm/gradlew_cmd.rs`. The execution-side `run()`
// dispatcher and `StreamFilter` wrappers drop away: the minimizer filters one
// already-captured buffer, so each rtk per-line `StreamFilter` predicate is
// applied directly over the buffer's lines. Gradle captures carry ANSI colour
// and `\r` progress redraws, so every entry point strips ANSI first.
// ═══════════════════════════════════════════════════════════════════════════

// ── Gradle shared patterns ───────────────────────────────────────────────────

/// `^> Task :` — gradle task-progress lines. Pure literal-anchored, so a
/// `starts_with` (not a regex) keeps `clippy::trivial_regex` happy and is
/// faster.
fn is_gradle_task_line(line: &str) -> bool {
	line.starts_with("> Task :")
}

/// `^\* Try:|^> Run with --|^> Get more help at` (rtk `TRY_SECTION`). The
/// post-failure help block — pure noise pointing at flags and help URLs.
fn is_gradle_try_section(line: &str) -> bool {
	line.starts_with("* Try:")
		|| line.starts_with("> Run with --")
		|| line.starts_with("> Get more help at")
}

/// `^BUILD (SUCCESSFUL|FAILED)` (rtk `BUILD_STATUS`).
fn is_gradle_build_status(line: &str) -> bool {
	line.starts_with("BUILD SUCCESSFUL") || line.starts_with("BUILD FAILED")
}

/// `^\d+ actionable tasks?` (rtk `ACTIONABLE`).
static GRADLE_ACTIONABLE: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"^\d+ actionable tasks?").unwrap());

// ── Task detection ───────────────────────────────────────────────────────────

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum GradleTask {
	Build,
	Test,
	ConnectedTest,
	Lint,
	Dependencies,
	SpringBootRun,
	Other,
}

/// Pick the filter for a gradle invocation by re-tokenizing `ctx.command`.
///
/// Ported from rtk `gradlew_cmd.rs::detect_task` (~31-64). Uses the FIRST
/// recognized task token, lowercased — tasks appear before option-value tokens
/// such as `--tests FooSpec`, so `.find()` on recognized tasks avoids matching
/// option-values. Adapted to take the raw command string instead of rtk's
/// `&[String]` args slice (the minimizer never holds a parsed args vector); the
/// leading program word is dropped by [`arg_tokens`], matching rtk's args slice
/// which never includes the program.
///
/// `bootRun` is checked first so it routes to the dedicated Spring Boot runtime
/// filter (rtk handled `spring-boot:run`/`bootRun` via a separate command).
pub fn detect_task(command: &str) -> GradleTask {
	// Use the FIRST recognized task token to ignore option-value tokens that
	// follow --tests, --rerun, etc. (e.g. "gradle test --tests FooSpec" → Test).
	// When find returns None we need to distinguish two cases:
	//   • no non-flag non-clean tokens at all  → only `clean` was given → Build
	//   • non-flag non-clean tokens existed but none recognized → unrecognized task
	// → Other
	let mut non_clean_tokens = jvm_positional_tokens(command, &[
		"-p",
		"--project-dir",
		"-P",
		"--project-prop",
		"-g",
		"--gradle-user-home",
		"--settings-file",
		"-b",
		"--build-file",
		"--init-script",
		"-I",
		"--max-workers",
		"-c",
		"--configuration-file",
		"--project-cache-dir",
	])
	.into_iter()
	.map(str::to_lowercase)
	.filter(|a| a != "clean")
	.peekable();
	let had_tokens = non_clean_tokens.peek().is_some();
	let task = non_clean_tokens
		.find(|a| {
			a.contains("bootrun")
				|| a.contains("connected")
				|| a.contains("test")
				|| a.contains("assemble")
				|| a.contains("build")
				|| a.contains("bundle")
				|| a.contains("install")
				|| a.contains("lint")
				|| a.contains("ktlint")
				|| a.contains("detekt")
				|| a == "check"
				|| a.contains("dependencies")
		})
		.unwrap_or_default();

	if task.contains("bootrun") {
		GradleTask::SpringBootRun
	} else if task.contains("connected") {
		GradleTask::ConnectedTest
	} else if task.contains("test") {
		GradleTask::Test
	} else if task.contains("assemble")
		|| task.contains("build")
		|| task.contains("bundle")
		|| task.contains("install")
	{
		GradleTask::Build
	} else if task.contains("lint") || task.contains("ktlint") || task.contains("detekt") {
		GradleTask::Lint
	} else if task == "check" {
		GradleTask::Test
	} else if task.contains("dependencies") {
		GradleTask::Dependencies
	} else if had_tokens {
		// Non-flag non-clean tokens existed but none were recognized → unrecognized
		// task (e.g. `gradlew signingReport`). Rtk parity: fall through to Other.
		GradleTask::Other
	} else {
		// No non-flag non-clean tokens at all — only `clean` was passed (filtered
		// out above) → treat as Build to filter task noise (rtk parity).
		GradleTask::Build
	}
}

// ── Build filter (rtk gradlew_cmd.rs::filter_build_line ~179-216) ────────────

/// Daemon/lifecycle chatter prefixes (rtk `DAEMON_LINE` alternation, expressed
/// as literal prefixes).
const GRADLE_DAEMON_PREFIXES: &[&str] = &[
	"Starting a Gradle Daemon",
	"Daemon will be stopped",
	"Reusing configuration cache",
	"Calculating task graph",
	"> Configure project",
	"Deprecated Gradle features",
	"You can use",
	"For more on this",
	"Configuration cache entry",
];

/// `^\s*\d+%|^Downloading|^Configuring|^Resolving|^\[Incubating\]|^Wrote HTML
/// report|^class \S+ could not|^\[android-` (rtk `PROGRESS`). The
/// percentage-progress and `class … could not` shapes need a regex; kept
/// verbatim from rtk.
static GRADLE_PROGRESS: LazyLock<Regex> = LazyLock::new(|| {
	Regex::new(
		r"^\s*\d+%|^Downloading|^Configuring|^Resolving|^\[Incubating\]|^Wrote HTML report|^class \S+ could not|^\[android-",
	)
	.unwrap()
});

/// `(?i)(^FAILURE:|^\* What went wrong:|^\* Where:|> Could not|e:
/// |error:|^Execution failed|Lint found \d+ error)` (rtk `ERROR_LINE`).
static GRADLE_ERROR_LINE: LazyLock<Regex> = LazyLock::new(|| {
	Regex::new(
		r"(?i)(^FAILURE:|^\* What went wrong:|^\* Where:|> Could not|e: |error:|^Execution failed|Lint found \d+ error)",
	)
	.unwrap()
});

/// `^(w: |warning:|Warning:|WARNING:)` (rtk `WARN_LINE`): kotlinc `w: `,
/// javac/gradle `warning:`/`Warning:`.
static GRADLE_WARN_LINE: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"^(w: |warning:|Warning:|WARNING:)").unwrap());

/// `gradle\.com/s/|Publishing build scan` (rtk `BUILD_SCAN`).
fn is_gradle_build_scan(line: &str) -> bool {
	line.contains("gradle.com/s/") || line.contains("Publishing build scan")
}

/// Per-line keep predicate for Build mode (rtk `filter_build_line`).
///
/// Strips daemon/progress/`> Task :`/try-section lines (INCLUDING
/// `> Task :x FAILED` — the `FAILURE:`/`What went wrong` block below carries
/// the signal, a deliberate donor decision), keeps build status / actionable /
/// errors / warnings / build-scan URLs, and preserves blank lines that separate
/// error sections.
fn keep_gradle_build_line(line: &str) -> bool {
	// Always strip these.
	if is_gradle_task_line(line)
		|| GRADLE_DAEMON_PREFIXES.iter().any(|p| line.starts_with(p))
		|| GRADLE_PROGRESS.is_match(line)
		|| is_gradle_try_section(line)
	{
		return false;
	}

	// Always keep these.
	//
	// Beyond rtk's `filter_build_line` keepers, the test-summary and
	// `Test result:` lines are also kept: the deleted `defs/gradle.toml` (a
	// strip-only filter) and snip's `gradlew-bat.yaml` both surfaced them, and a
	// `> Task :test`-only Build invocation otherwise drops its sole failure
	// signal. Task-progress `> Task :x FAILED` lines are still dropped — the
	// strip guard above runs first, so this broader keep side cannot resurrect
	// them (a deliberate donor decision: the `FAILURE:` block carries the
	// signal).
	is_gradle_build_status(line)
		|| GRADLE_ACTIONABLE.is_match(line)
		|| GRADLE_ERROR_LINE.is_match(line)
		|| GRADLE_WARN_LINE.is_match(line)
		|| is_gradle_build_scan(line)
		|| GRADLE_TEST_SUMMARY.is_match(line)
		|| line.contains("Test result")
		|| line.trim().is_empty()
}

fn filter_gradle_build(input: &str) -> String {
	let mut out: Vec<&str> = Vec::new();
	for line in input.lines() {
		if keep_gradle_build_line(line) {
			out.push(line);
		}
	}
	join_lines(&out)
}

// ── Test filter (rtk gradlew_cmd.rs::filter_test ~230-302) ───────────────────

/// `FAILED$| FAILED ` (rtk `FAILED_LINE`).
static GRADLE_FAILED_LINE: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"FAILED$| FAILED ").unwrap());

/// ` PASSED$| SKIPPED$` (rtk `PASSED_SKIPPED`).
static GRADLE_PASSED_SKIPPED: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r" PASSED$| SKIPPED$").unwrap());

/// `\d+ tests? completed|\d+ tests? failed|There were failing tests|See the
/// report at` (rtk `SUMMARY_LINE`). The "See the report at" arm keeps the
/// actionable HTML-report pointer.
static GRADLE_TEST_SUMMARY: LazyLock<Regex> = LazyLock::new(|| {
	Regex::new(r"\d+ tests? completed|\d+ tests? failed|There were failing tests|See the report at")
		.unwrap()
});

/// True if an `at …` stack frame belongs to a test framework (`JUnit`, Gradle
/// runner, reflection) rather than user code. Ported from rtk
/// `gradlew_cmd.rs::is_framework_frame` — DISTINCT from the Maven-side
/// [`is_framework_frame`] (gradle includes `org.gradle.`, excludes
/// `org.apache.maven.surefire.`/`java.base/`/`java.util.`).
fn is_gradle_framework_frame(trimmed: &str) -> bool {
	trimmed.starts_with("at org.junit.")
		|| trimmed.starts_with("at junit.")
		|| trimmed.starts_with("at java.lang.reflect.")
		|| trimmed.starts_with("at sun.reflect.")
		|| trimmed.starts_with("at org.gradle.")
}

/// Test-mode filter (rtk `filter_test`).
///
/// Keeps failing test lines, the exception class+message, and the FIRST
/// user-code frame only (a deliberate aggressive choice vs the Maven side's
/// all-frames trail — donor behaviour kept). Strips `PASSED`/`SKIPPED` per-test
/// lines, `> Task :`, and the try-section. Empty output emits the rtk hint
/// message rather than an empty buffer the generic OK path can't enrich.
fn filter_gradle_test(input: &str) -> String {
	if input.is_empty() {
		return String::new();
	}

	let mut result_lines: Vec<&str> = Vec::new();
	let mut in_failure_block = false;

	for line in input.lines() {
		// Always-noise lines.
		if is_gradle_task_line(line) || is_gradle_try_section(line) {
			continue;
		}

		// Build summary lines always kept.
		if is_gradle_build_status(line)
			|| GRADLE_ACTIONABLE.is_match(line)
			|| GRADLE_TEST_SUMMARY.is_match(line)
		{
			result_lines.push(line);
			continue;
		}

		// PASSED/SKIPPED per-test lines — strip.
		if GRADLE_PASSED_SKIPPED.is_match(line) {
			in_failure_block = false;
			continue;
		}

		// FAILED per-test lines — keep + enter failure block for the stack trace.
		if GRADLE_FAILED_LINE.is_match(line) {
			in_failure_block = true;
			result_lines.push(line);
			continue;
		}

		// Stack-trace lines following a failure.
		if in_failure_block {
			let trimmed = line.trim();
			if trimmed.starts_with("at ") {
				// Stack frame: skip framework frames, keep first user-code frame then close.
				if !is_gradle_framework_frame(trimmed) {
					result_lines.push(line);
					in_failure_block = false;
				}
			} else if !trimmed.is_empty() {
				// Exception class, message line, or assertion detail — keep it.
				// (Covers java.*, kotlin.*, org.opentest4j.*, and message lines.)
				result_lines.push(line);
			}
			// blank lines in failure block: skip (implicit fall-through)
		}
	}

	let filtered = join_lines(&result_lines);

	// Guarantee non-empty, signal-rich output.
	if filtered.trim().is_empty() {
		if input.contains("BUILD SUCCESSFUL") {
			return "ok ✓ (no test output — add testLogging to build.gradle for details)".to_string();
		}
		return input.trim().to_string();
	}

	filtered
}

// ── Connected / instrumented test filter (rtk ~306-350) ──────────────────────

/// `^INSTRUMENTATION_STATUS[_CODE]*:` (rtk `INSTRUMENTATION_STATUS` — the
/// character-class form matches `INSTRUMENTATION_STATUS:` and
/// `INSTRUMENTATION_STATUS_CODE:`).
static GRADLE_INSTRUMENTATION_STATUS: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"^INSTRUMENTATION_STATUS[_CODE]*:").unwrap());

/// `^Starting \d+ tests? on ` (rtk `STARTING_TESTS`).
static GRADLE_STARTING_TESTS: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"^Starting \d+ tests? on ").unwrap());

/// `ConnectedTest` filter (rtk `filter_connected`). Strips Android
/// instrumentation noise, then delegates the surviving PASSED/FAILED-shaped
/// output to [`filter_gradle_test`].
fn filter_gradle_connected(input: &str) -> String {
	if input.is_empty() {
		return String::new();
	}

	// Special case: no device.
	if input.contains("No connected devices!") {
		return "connectedAndroidTest failed: No connected devices! Start an emulator or connect a \
		        device."
			.to_string();
	}

	let mut result_lines: Vec<&str> = Vec::new();
	for line in input.lines() {
		if GRADLE_INSTRUMENTATION_STATUS.is_match(line)
			|| line.starts_with("INSTRUMENTATION_RESULT:")
			|| line.starts_with("INSTRUMENTATION_CODE:")
			|| GRADLE_STARTING_TESTS.is_match(line)
			|| line.starts_with("Installing APK")
			|| is_gradle_task_line(line)
			|| is_gradle_try_section(line)
		{
			continue;
		}
		result_lines.push(line);
	}

	// After stripping instrumentation noise, connected output uses the same
	// PASSED/FAILED format as unit tests — delegate.
	let joined = join_lines(&result_lines);
	let filtered = filter_gradle_test(&joined);

	if filtered.trim().is_empty() {
		return "ok ✓ (connected tests passed)".to_string();
	}
	filtered
}

// ── Lint filter (rtk ~354-432) ───────────────────────────────────────────────

/// `[^:]+:\d+:.*[Ee]rror:.*\[` (rtk `ANDROID_LINT_ERROR`).
static GRADLE_ANDROID_LINT_ERROR: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"[^:]+:\d+:.*[Ee]rror:.*\[").unwrap());

/// `[^:]+:\d+:.*[Ww]arning:.*\[` (rtk `ANDROID_LINT_WARNING`).
static GRADLE_ANDROID_LINT_WARNING: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"[^:]+:\d+:.*[Ww]arning:.*\[").unwrap());

/// `[^:]+:\d+:\d+:.*[Ll]int` (rtk `KTLINT_VIOLATION`).
static GRADLE_KTLINT_VIOLATION: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"[^:]+:\d+:\d+:.*[Ll]int").unwrap());

/// `[^:]+:\d+:\d+:.*error` (rtk `DETEKT_VIOLATION`).
static GRADLE_DETEKT_VIOLATION: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"[^:]+:\d+:\d+:.*error").unwrap());

/// `\d+ (issues?|errors?|warnings?)` (rtk lint `SUMMARY_LINE`).
static GRADLE_LINT_SUMMARY: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"\d+ (issues?|errors?|warnings?)").unwrap());

/// `Wrote (HTML|XML|text) report|file://|/build/reports/lint` (rtk
/// `REPORT_LINE`): long report-path lines to strip.
static GRADLE_LINT_REPORT: LazyLock<Regex> = LazyLock::new(|| {
	Regex::new(r"Wrote (HTML|XML|text) report|file://|/build/reports/lint").unwrap()
});

/// Lint-mode filter (rtk `filter_lint`). Keeps Android-lint / ktlint / detekt
/// violations and summaries, strips report-path lines and `> Task :`/try
/// noise. Android-lint violations carry a multi-line code-snippet + caret +
/// explanation block, separated from the next violation by a blank line; up to
/// 3 non-empty context lines are kept (cross-line state) so the LLM sees the
/// offending code without opening the file.
fn filter_gradle_lint(input: &str) -> String {
	if input.is_empty() {
		return String::new();
	}

	const MAX_CONTEXT_LINES: usize = 3;

	let mut result_lines: Vec<&str> = Vec::new();
	let mut context_remaining: usize = 0;

	for line in input.lines() {
		if is_gradle_task_line(line)
			|| is_gradle_try_section(line)
			|| GRADLE_LINT_REPORT.is_match(line)
		{
			context_remaining = 0;
			continue;
		}

		let is_android_lint =
			GRADLE_ANDROID_LINT_ERROR.is_match(line) || GRADLE_ANDROID_LINT_WARNING.is_match(line);

		if is_gradle_build_status(line)
			|| GRADLE_ACTIONABLE.is_match(line)
			|| GRADLE_LINT_SUMMARY.is_match(line)
			|| is_android_lint
			|| GRADLE_KTLINT_VIOLATION.is_match(line)
			|| GRADLE_DETEKT_VIOLATION.is_match(line)
		{
			result_lines.push(line);
			// Only Android-lint violations carry multi-line context; ktlint/detekt
			// /summary lines are single-line.
			context_remaining = if is_android_lint {
				MAX_CONTEXT_LINES
			} else {
				0
			};
			continue;
		}

		if context_remaining > 0 {
			if line.trim().is_empty() {
				// Blank line terminates the context block.
				context_remaining = 0;
			} else {
				result_lines.push(line);
				context_remaining -= 1;
			}
		}
	}

	let filtered = join_lines(&result_lines);

	if filtered.trim().is_empty() {
		if input.contains("BUILD SUCCESSFUL") {
			return "ok ✓ lint passed".to_string();
		}
		return input.trim().to_string();
	}

	filtered
}

// ── Dependencies filter (rtk ~436-526) ───────────────────────────────────────

/// Cap on top-level dependencies emitted per configuration. rtk bound this to
/// `CAP_LIST` (20); the minimizer's equivalent is [`CapClass::List`] (80).
const fn max_gradle_deps() -> usize {
	CapClass::List.lines()
}

/// Dependencies-mode filter (rtk `filter_dependencies`). Aggregates the gradle
/// dependency tree into a per-configuration table of TOP-LEVEL deps only
/// (transitive `|    +---` / `     \---` rows are dropped), capped at
/// [`max_gradle_deps`].
fn filter_gradle_dependencies(input: &str) -> String {
	if input.is_empty() {
		return String::new();
	}

	let mut configs: Vec<(String, Vec<String>)> = Vec::new();
	let mut current_config = String::new();
	let mut current_deps: Vec<String> = Vec::new();
	let mut total_deps = 0usize;

	for line in input.lines() {
		let trimmed = line.trim();

		// Skip noise.
		if trimmed.is_empty()
			|| is_gradle_task_line(trimmed)
			|| is_gradle_try_section(trimmed)
			|| is_gradle_build_status(trimmed)
			|| GRADLE_ACTIONABLE.is_match(trimmed)
			|| trimmed.starts_with("Downloading")
			|| trimmed.starts_with("Download ")
			|| trimmed.starts_with("Starting a Gradle")
			|| trimmed == "No dependencies"
			|| trimmed == "(n)"
		{
			continue;
		}

		// Configuration header: "compileClasspath - Compile classpath …". Not
		// indented, not a tree line, contains " - ".
		if !trimmed.starts_with('+')
			&& !trimmed.starts_with('|')
			&& !trimmed.starts_with('\\')
			&& !trimmed.starts_with(' ')
			&& trimmed.contains(" - ")
		{
			if !current_config.is_empty() && !current_deps.is_empty() {
				configs.push((current_config.clone(), current_deps.clone()));
			}
			current_config = trimmed.split(" - ").next().unwrap_or(trimmed).to_string();
			current_deps = Vec::new();
			continue;
		}

		// Top-level dependencies only (first level of the tree). Check the
		// UNTRIMMED line — top-level deps start at column 0; transitive deps are
		// indented (`|    +---` or `     \---`).
		if (line.starts_with("+---") || line.starts_with("\\---")) && !current_config.is_empty() {
			let dep = trimmed
				.trim_start_matches("+--- ")
				.trim_start_matches("\\--- ")
				.to_string();
			current_deps.push(dep);
			total_deps += 1;
		}
	}

	// Flush last config.
	if !current_config.is_empty() && !current_deps.is_empty() {
		configs.push((current_config, current_deps));
	}

	if configs.is_empty() {
		if input.contains("BUILD SUCCESSFUL") {
			return "ok ✓ no dependencies".to_string();
		}
		return input.trim().to_string();
	}

	let mut result =
		format!("{} top-level dependencies across {} configurations\n", total_deps, configs.len());

	let cap = max_gradle_deps();
	for (config, deps) in &configs {
		let _ = write!(result, "\n{} ({}):\n", config, deps.len());
		for dep in deps.iter().take(cap) {
			let _ = writeln!(result, "  {dep}");
		}
		if deps.len() > cap {
			let _ = writeln!(result, "  […{} dependencies elided…]", deps.len() - cap);
		}
	}

	result.trim_end().to_string()
}

// ── Other-task filter (light Build-style strip) ──────────────────────────────

/// Filter for gradle tasks that match no specialised category (rtk ran these as
/// raw passthrough). A light Build-style daemon/progress/`> Task :` strip is
/// strictly better than rtk's raw passthrough while keeping every non-noise
/// line — we cannot know which lines carry signal for an unknown task, so the
/// keep side is intentionally permissive: only daemon/progress/task-progress
/// noise is dropped. Verbose flags already short-circuited to passthrough.
fn filter_gradle_other(input: &str) -> String {
	let mut out: Vec<&str> = Vec::new();
	for line in input.lines() {
		if is_gradle_task_line(line)
			|| GRADLE_DAEMON_PREFIXES.iter().any(|p| line.starts_with(p))
			|| GRADLE_PROGRESS.is_match(line)
		{
			continue;
		}
		out.push(line);
	}
	join_lines(&out)
}

// ── Carried-over deleted-def: gradle.toml UP-TO-DATE strip
// ────────────────────
//
// The deleted `defs/gradle.toml` stripped `> Task :…UP-TO-DATE`/`NO-SOURCE`
// /`FROM-CACHE` and daemon chatter. `keep_gradle_build_line` already drops all
// `> Task :` lines (a superset of UP-TO-DATE/NO-SOURCE/FROM-CACHE), the
// Configure/daemon lines, and download progress — so the carried-over behaviour
// is covered by Build mode. The inline tests below pin it.

// ── Shared helpers ───────────────────────────────────────────────────────────

/// Join kept lines with `\n` and a trailing newline when non-empty, mirroring
/// the per-line `format!("{line}\n")` emission of rtk's `StreamFilter`s so the
/// output shape (and token counts) match the donor.
fn join_lines(lines: &[&str]) -> String {
	if lines.is_empty() {
		return String::new();
	}
	let mut out = lines.join("\n");
	out.push('\n');
	out
}

// ═══════════════════════════════════════════════════════════════════════════
// SPRING BOOT RUN MODE (shared by `mvn spring-boot:run` and gradle `bootRun`)
// ═══════════════════════════════════════════════════════════════════════════

/// `bootRun`/`spring-boot:run` application runtime filter.
///
/// Rederived (no injected flags) from rtk `src/filters/spring-boot.toml` and
/// `defs/spring-boot.toml`: a keep-list filter that drops the multi-line Spring
/// banner and INFO/DEBUG/TRACE startup chatter (which never match a keeper) and
/// keeps the actionable runtime signals — `Started … in`, `Tomcat started on
/// port`, ERROR/WARN, Exception, `Caused by:`, `Application run failed`, plus
/// surrounding Maven `[ERROR]`/`BUILD` lines and `Tests run:`. bootRun output
/// is unbounded, so a [`CapClass`] head/tail cap bounds the kept set. Input is
/// expected ANSI-stripped by the caller.
fn filter_spring_boot(input: &str) -> String {
	let mut out: Vec<&str> = Vec::new();
	for line in input.lines() {
		if spring_boot_keep(line) {
			out.push(line);
		}
	}
	let kept = join_lines(&out);
	primitives::head_tail_cap(&kept, CapClass::List)
}

/// rtk spring-boot.toml `keep_lines_matching`, plus the defs/spring-boot.toml
/// `[ERROR] …`/`[WARN] …` Maven-line shapes, as a predicate. A line survives if
/// it carries a startup-success or failure signal; everything else (banner,
/// INFO/DEBUG/TRACE bean chatter) is dropped.
fn spring_boot_keep(line: &str) -> bool {
	SPRING_STARTED.is_match(line)
		|| line.contains("Tomcat started on port")
		|| line.contains("listening on port")
		|| line.contains("ERROR")
		|| line.contains("WARN")
		|| line.contains("Exception")
		|| line.contains("Caused by:")
		|| line.contains("Application run failed")
		|| line.contains("Tests run:")
		|| line.contains("FAILURE")
		|| SPRING_BUILD.is_match(line)
}

/// `Started\s.*\sin\s` (rtk keep-list) — the `Started <App> in <n>s` line.
static SPRING_STARTED: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"Started\s.*\sin\s").unwrap());

/// `BUILD\s` (rtk keep-list) — `BUILD SUCCESS`/`BUILD FAILURE`/`BUILD FAILED`
/// across both mvn and gradle footer shapes.
static SPRING_BUILD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"BUILD\s").unwrap());

#[cfg(test)]
mod tests {
	use super::*;
	use crate::minimizer::MinimizerConfig;

	fn count_tokens(s: &str) -> usize {
		s.split_whitespace().count()
	}

	/// Percent token savings of `out` vs `raw`. Centralised so the
	/// `mul_add`-friendly form lives in one place.
	fn savings_pct(raw: &str, out: &str) -> f64 {
		(count_tokens(out) as f64 / count_tokens(raw) as f64).mul_add(-100.0, 100.0)
	}

	fn ctx<'a>(program: &'a str, command: &'a str, config: &'a MinimizerConfig) -> MinimizerCtx<'a> {
		// subcommand mirrors detect's "first non-flag arg"; jvm never reads it
		// for phase, so the exact value is irrelevant to these tests.
		let subcommand = command.split_whitespace().nth(1);
		MinimizerCtx { program, subcommand, command, config }
	}

	// ── Phase detection (rtk mvn_cmd.rs ~994-1071, command-string adapted) ────

	#[test]
	fn phase_test() {
		assert_eq!(detect_phase("mvn test"), MvnPhase::Test);
	}
	#[test]
	fn phase_integration_test() {
		assert_eq!(detect_phase("mvn integration-test"), MvnPhase::Test);
	}
	#[test]
	fn phase_compile() {
		assert_eq!(detect_phase("mvn compile"), MvnPhase::Compile);
	}
	#[test]
	fn phase_test_compile() {
		assert_eq!(detect_phase("mvn test-compile"), MvnPhase::Compile);
	}
	#[test]
	fn phase_install() {
		assert_eq!(detect_phase("mvn install"), MvnPhase::Package);
	}
	#[test]
	fn phase_package() {
		assert_eq!(detect_phase("mvn package"), MvnPhase::Package);
	}
	#[test]
	fn phase_verify() {
		assert_eq!(detect_phase("mvn verify"), MvnPhase::Package);
	}
	#[test]
	fn phase_deploy() {
		assert_eq!(detect_phase("mvn deploy"), MvnPhase::Package);
	}
	#[test]
	fn phase_clean_install_is_pkg() {
		// The load-bearing case ctx.subcommand gets wrong ("clean").
		assert_eq!(detect_phase("mvn clean install"), MvnPhase::Package);
	}
	#[test]
	fn phase_flags_before_goal() {
		assert_eq!(detect_phase("mvn -B -DskipTests test"), MvnPhase::Test);
	}
	#[test]
	fn phase_clean_only_passthrough() {
		assert_eq!(detect_phase("mvn clean"), MvnPhase::Passthrough);
	}
	#[test]
	fn phase_site_passthrough() {
		assert_eq!(detect_phase("mvn site"), MvnPhase::Passthrough);
	}
	#[test]
	fn phase_plugin_goal_passthrough() {
		assert_eq!(detect_phase("mvn dependency:tree"), MvnPhase::Passthrough);
	}
	#[test]
	fn phase_empty_passthrough() {
		assert_eq!(detect_phase("mvn"), MvnPhase::Passthrough);
	}
	#[test]
	fn phase_version_long() {
		assert_eq!(detect_phase("mvn --version"), MvnPhase::Passthrough);
	}
	#[test]
	fn phase_version_short() {
		assert_eq!(detect_phase("mvn -v"), MvnPhase::Passthrough);
	}
	#[test]
	fn phase_version_java_style() {
		assert_eq!(detect_phase("mvn -version"), MvnPhase::Passthrough);
	}
	#[test]
	fn phase_help() {
		assert_eq!(detect_phase("mvn --help"), MvnPhase::Passthrough);
	}
	#[test]
	fn detect_phase_ignores_pl_module_value() {
		// "-pl module-a" option-value must not shadow the recognized lifecycle goal
		assert_eq!(detect_phase("mvn test -pl module-a"), MvnPhase::Test);
		assert_eq!(detect_phase("mvn install -pl :sub1,:sub2"), MvnPhase::Package);
	}
	#[test]
	fn detect_phase_skips_value_of_value_taking_options() {
		// "-pl test" — "test" is the value of -pl, not a lifecycle goal
		assert_eq!(detect_phase("mvn compile -pl test"), MvnPhase::Compile);
		// "--projects test" — same, long form
		assert_eq!(detect_phase("mvn install --projects test"), MvnPhase::Package);
		// "-pl module-a" value is not a recognised goal; recognised goal still wins
		assert_eq!(detect_phase("mvn test -pl module-a"), MvnPhase::Test);
	}

	// ── Quiet detection (rtk ~1986-2003) ─────────────────────────────────────

	#[test]
	fn quiet_detects_short_flag() {
		assert!(is_quiet("mvn -q test"));
		assert!(is_quiet("mvn test -q"));
		assert!(is_quiet("mvn -B -q -DskipFoo install"));
	}
	#[test]
	fn quiet_detects_long_flag() {
		assert!(is_quiet("mvn --quiet test"));
	}
	#[test]
	fn quiet_does_not_match_unrelated_flags() {
		assert!(!is_quiet("mvn -Q test"));
		assert!(!is_quiet("mvn -quiet test"));
		assert!(!is_quiet("mvn -B test"));
	}

	// ── Verbose bypass ───────────────────────────────────────────────────────

	#[test]
	fn verbose_flags_force_passthrough() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		// `-X` anywhere bypasses filtering even on a Test-phase command.
		let i = include_str!("fixtures/jvm/mvn_test_fail_slice_raw.txt");
		let out = filter(&ctx("mvn", "mvn -X test", &cfg), i, 1);
		assert_eq!(out.text, i, "verbose bypass returns raw input");
		assert!(!out.changed);
	}

	// ── Surefire filter (rtk ~1076-1205) ─────────────────────────────────────

	#[test]
	fn filter_surefire_pass_output_compact() {
		let i = include_str!("fixtures/jvm/mvn_test_pass_slice_raw.txt");
		let o = filter_surefire(i);
		assert!(!o.contains("Running org.apache.commons.cli.help.UtilTest"));
		assert!(!o.contains("Time elapsed: 1.023 s -- in"));
		let savings = savings_pct(i, &o);
		assert!(savings >= 50.0, "pass-fixture savings >=50%, got {savings:.1}%");
	}

	#[test]
	fn filter_surefire_fail_keeps_signal() {
		let i = include_str!("fixtures/jvm/mvn_test_fail_slice_raw.txt");
		let o = filter_surefire(i);
		assert!(o.contains("BUILD FAILURE"));
		assert!(o.contains("Failures: 1"));
	}

	#[test]
	fn surefire_drops_passing_block() {
		let i = include_str!("fixtures/jvm/mvn_test_pass_slice_raw.txt");
		let o = filter_surefire(i);
		assert!(!o.contains("at org.junit."), "framework frames stripped; got:\n{o}");
		assert!(
			!o.contains("Running org.apache.commons.cli.ConverterTests"),
			"passing-test Running line dropped; got:\n{o}"
		);
		assert!(o.contains("BUILD SUCCESS"), "footer preserved; got:\n{o}");
		assert!(o.contains("Tests run: 977, Failures: 0"), "aggregate preserved; got:\n{o}");
	}

	#[test]
	fn surefire_preserves_failing_signal() {
		let i = include_str!("fixtures/jvm/mvn_test_fail_slice_raw.txt");
		let o = filter_surefire(i);
		assert!(o.contains("Failures: 1"), "failing aggregate preserved; got:\n{o}");
		assert!(o.contains("AssertionFailedError"), "exception class preserved; got:\n{o}");
		assert!(
			o.contains("at org.apache.commons.cli.RtkInducedFailTest.rtkInducedFailure"),
			"user-code frame preserved; got:\n{o}"
		);
		assert!(!o.contains("at org.junit."), "framework frames stripped; got:\n{o}");
	}

	#[test]
	fn surefire_matches_legacy_2x_close_line() {
		let i = "[INFO] -----< x >-----\n[INFO] Running x.Foo\n[INFO] Tests run: 3, Failures: 0, \
		         Errors: 0, Skipped: 0, Time elapsed: 0.123 s - in x.Foo\n[INFO] BUILD SUCCESS\n";
		let o = filter_surefire(i);
		assert!(!o.contains("Running x.Foo"), "2.x ` - in ` close-line matched; got:\n{o}");
		assert!(o.contains("BUILD SUCCESS"), "footer preserved; got:\n{o}");
	}

	#[test]
	fn surefire_matches_warning_skipped_close_line() {
		let i = "[INFO] -----< x >-----\n[INFO] Running x.Skip\n[WARNING] Tests run: 5, Failures: \
		         0, Errors: 0, Skipped: 5, Time elapsed: 0.010 s -- in x.Skip\n[INFO] BUILD \
		         SUCCESS\n";
		let o = filter_surefire(i);
		assert!(!o.contains("Running x.Skip"), "[WARNING] close-line matched; got:\n{o}");
	}

	#[test]
	fn surefire_preserves_3x_failure_trail() {
		let i = "[INFO] -----< x >-----\n[INFO] Running x.Foo\n[ERROR] Tests run: 1, Failures: 1, \
		         Errors: 0, Skipped: 0, Time elapsed: 0.033 s <<< FAILURE! -- in x.Foo\n[ERROR] \
		         x.Foo.bar -- Time elapsed: 0.025 s <<< \
		         FAILURE!\norg.opentest4j.AssertionFailedError: expected: <a> but was: <b>\n\tat \
		         x.Foo.bar(Foo.java:25)\n\tat \
		         org.junit.jupiter.api.Assertions.assertEquals(Assertions.java:1)\n\n[INFO] BUILD \
		         FAILURE\n";
		let o = filter_surefire(i);
		assert!(o.contains("AssertionFailedError"), "exception preserved; got:\n{o}");
		assert!(o.contains("at x.Foo.bar"), "user frame preserved; got:\n{o}");
		assert!(!o.contains("at org.junit."), "framework frame stripped in trail; got:\n{o}");
	}

	// ── Multi-failure class (trail re-arm) (rtk ~1213-1379) ───────────────────

	#[test]
	fn surefire_keeps_all_failures_in_multi_failure_class() {
		let i = include_str!("fixtures/jvm/mvn_test_multifail_slice_raw.txt");
		let o = filter_surefire(i);
		assert!(
			o.contains("AssertionFailedError: failOne: addition should equal five"),
			"first failure message preserved; got:\n{o}"
		);
		assert!(
			o.contains("IllegalStateException: failTwo: induced error"),
			"second failure (ERROR! subline) message preserved; got:\n{o}"
		);
		assert!(
			o.contains("at com.example.rtk.CalcTest.failOne(CalcTest.java:12)"),
			"first user frame preserved; got:\n{o}"
		);
		assert!(
			o.contains("at com.example.rtk.CalcTest.failTwo(CalcTest.java:17)"),
			"second user frame preserved; got:\n{o}"
		);
		assert!(!o.contains("at org.junit."), "junit frames stripped; got:\n{o}");
		assert!(!o.contains("at java.base/"), "jdk frames stripped; got:\n{o}");
	}

	#[test]
	fn package_keeps_all_failures_in_multi_failure_class() {
		let i = include_str!("fixtures/jvm/mvn_test_multifail_slice_raw.txt");
		let o = filter_package(i);
		assert!(
			o.contains("AssertionFailedError: failOne: addition should equal five"),
			"first failure message preserved; got:\n{o}"
		);
		assert!(
			o.contains("IllegalStateException: failTwo: induced error"),
			"second failure message preserved; got:\n{o}"
		);
		assert!(!o.contains("at org.junit."), "junit frames stripped; got:\n{o}");
		assert!(!o.contains("at java.base/"), "jdk frames stripped; got:\n{o}");
	}

	#[test]
	fn surefire_drop_failing_drops_all_sublines_of_capped_class() {
		let i = "[INFO] Scanning for projects...\n[INFO] -----< x >-----\n[INFO] Running \
		         x.FailA\n[ERROR] Tests run: 1, Failures: 1, Errors: 0, Skipped: 0, Time elapsed: \
		         0.011 s <<< FAILURE! -- in x.FailA\n[ERROR] x.FailA.one -- Time elapsed: 0.010 s \
		         <<< FAILURE!\norg.opentest4j.AssertionFailedError: boomA\n\tat \
		         x.FailA.one(FailA.java:10)\n\n[INFO] Running x.MultiFail\n[ERROR] Tests run: 2, \
		         Failures: 1, Errors: 1, Skipped: 0, Time elapsed: 0.051 s <<< FAILURE! -- in \
		         x.MultiFail\n[ERROR] x.MultiFail.first -- Time elapsed: 0.020 s <<< \
		         FAILURE!\norg.opentest4j.AssertionFailedError: boomFirst\n\tat \
		         x.MultiFail.first(MultiFail.java:20)\n\n[ERROR] x.MultiFail.second -- Time \
		         elapsed: 0.030 s <<< ERROR!\njava.lang.IllegalStateException: boomSecond\n\tat \
		         x.MultiFail.second(MultiFail.java:30)\n\n[INFO] BUILD FAILURE\n";
		let o = filter_surefire_with_cap(i, 1);
		assert!(o.contains("boomA"), "first class kept; got:\n{o}");
		assert!(
			!o.contains("Running x.MultiFail") && !o.contains("boomFirst"),
			"capped class first block dropped; got:\n{o}"
		);
		assert!(
			!o.contains("x.MultiFail.second") && !o.contains("boomSecond"),
			"capped class second per-test block dropped (re-arm inherits drop); got:\n{o}"
		);
		assert!(
			o.contains("[…1 failing test classes elided…]"),
			"tail counts one class, not one per failure; got:\n{o}"
		);
	}

	#[test]
	fn surefire_rearm_disarms_at_results_boundary() {
		let i = "[INFO] -----< x >-----\n[INFO] Running x.MultiFail\n[ERROR] Tests run: 2, \
		         Failures: 2, Errors: 0, Skipped: 0, Time elapsed: 0.051 s <<< FAILURE! -- in \
		         x.MultiFail\n[ERROR] x.MultiFail.first -- Time elapsed: 0.020 s <<< \
		         FAILURE!\norg.opentest4j.AssertionFailedError: boomFirst\n\n[ERROR] \
		         x.MultiFail.second -- Time elapsed: 0.030 s <<< \
		         FAILURE!\norg.opentest4j.AssertionFailedError: boomSecond\n\n[INFO] \
		         Results:\n[ERROR] Tests run: 2, Failures: 2, Errors: 0, Skipped: 0\n[INFO] BUILD \
		         FAILURE\n";
		let o = filter_surefire(i);
		assert!(o.contains("boomSecond"), "second block kept; got:\n{o}");
		assert!(o.contains("[INFO] Results:"), "Results boundary disarms re-arm; got:\n{o}");
		assert!(o.contains("[ERROR] Tests run: 2, Failures: 2"), "aggregate kept; got:\n{o}");
	}

	#[test]
	fn surefire_tolerates_double_blank_between_failure_blocks() {
		let i = "[INFO] -----< x >-----\n[INFO] Running x.MultiFail\n[ERROR] Tests run: 2, \
		         Failures: 2, Errors: 0, Skipped: 0, Time elapsed: 0.051 s <<< FAILURE! -- in \
		         x.MultiFail\n[ERROR] x.MultiFail.first -- Time elapsed: 0.020 s <<< \
		         FAILURE!\norg.opentest4j.AssertionFailedError: boomFirst\n\n\n[ERROR] \
		         x.MultiFail.second -- Time elapsed: 0.030 s <<< \
		         FAILURE!\norg.opentest4j.AssertionFailedError: boomSecond\n\n[INFO] BUILD FAILURE\n";
		let o = filter_surefire(i);
		assert!(o.contains("boomFirst"), "first block kept; got:\n{o}");
		assert!(o.contains("boomSecond"), "second block re-enters trail; got:\n{o}");
		assert!(!o.contains("\n\n\n"), "no spurious blank lines leak; got:\n{o:?}");
	}

	#[test]
	fn surefire_single_failure_output_unchanged() {
		let i = include_str!("fixtures/jvm/mvn_test_fail_slice_raw.txt");
		let o = filter_surefire(i);
		// Built via `concat!` of one `\n`-terminated line per literal so rustfmt
		// cannot reflow a `\n` across the soft-wrap boundary (a `\`-continuation
		// inside a single literal mangles embedded escapes).
		let expected = concat!(
			"[INFO] Scanning for projects...\n",
			"[INFO] ----------------------< commons-cli:commons-cli >-----------------------\n",
			"[INFO] Building Apache Commons CLI 1.11.1-SNAPSHOT\n",
			"[INFO] Running org.apache.commons.cli.RtkInducedFailTest\n",
			"[ERROR] Tests run: 1, Failures: 1, Errors: 0, Skipped: 0, Time elapsed: 0.033 s <<< \
			 FAILURE! -- in org.apache.commons.cli.RtkInducedFailTest\n",
			"[ERROR] org.apache.commons.cli.RtkInducedFailTest.rtkInducedFailure -- Time elapsed: \
			 0.025 s <<< FAILURE!\n",
			"org.opentest4j.AssertionFailedError: expected: <expected> but was: <actual>\n",
			"\tat org.apache.commons.cli.RtkInducedFailTest.rtkInducedFailure(RtkInducedFailTest.\
			 java:25)\n",
			"\n",
			"[INFO] Results:\n",
			"[ERROR] Failures:\n",
			"[ERROR]   RtkInducedFailTest.rtkInducedFailure:25 expected: <expected> but was: \
			 <actual>\n",
			"[ERROR] Tests run: 978, Failures: 1, Errors: 0, Skipped: 61\n",
			"[INFO] BUILD FAILURE\n",
			"[INFO] Total time:  01:05 min\n",
			"[INFO] Finished at: 2026-05-21T14:57:09Z\n",
			"[ERROR] Failed to execute goal \
			 org.apache.maven.plugins:maven-surefire-plugin:3.5.5:test (default-test) on project \
			 commons-cli: There are test failures.\n",
		);
		assert_eq!(o, expected, "single-failure output must be byte-identical");
	}

	#[test]
	fn savings_mvn_test_multifail_slice() {
		let i = include_str!("fixtures/jvm/mvn_test_multifail_slice_raw.txt");
		let o = filter_surefire(i);
		let savings = savings_pct(i, &o);
		assert!(savings >= 30.0, "multifail slice >=30% savings, got {savings:.1}%");
	}

	#[test]
	fn surefire_drops_help_boilerplate_in_nonquiet_mode() {
		let i = include_str!("fixtures/jvm/mvn_test_multifail_slice_raw.txt");
		let o = filter_surefire(i);
		assert!(o.contains("[ERROR] Failed to execute goal"), "goal terminator kept; got:\n{o}");
		assert!(!o.contains("[Help 1]"), "help link stripped; got:\n{o}");
		assert!(!o.contains("Re-run Maven"), "re-run hint stripped; got:\n{o}");
		assert!(!o.contains("To see the full stack trace"), "stack-trace hint stripped; got:\n{o}");
		assert!(!o.contains("See dump files"), "dump-file pointer stripped; got:\n{o}");
		assert!(
			!o.lines().any(|l| l.trim_end() == "[ERROR]"),
			"bare [ERROR] dividers stripped; got:\n{o}"
		);
	}

	#[test]
	fn close_line_matches_error_marker() {
		let line = "[ERROR] Tests run: 1, Failures: 0, Errors: 1, Skipped: 0, Time elapsed: 0.006 s \
		            <<< ERROR! -- in com.example.rtk.BoomTest";
		let caps = CLOSE
			.captures(line)
			.expect("CLOSE must match an ERROR!-marked close line");
		assert_eq!(caps.get(1).expect("failures group").as_str(), "0");
		assert_eq!(caps.get(2).expect("errors group").as_str(), "1");
	}

	#[test]
	fn surefire_keeps_compile_continuation_on_test_phase() {
		let i = include_str!("fixtures/jvm/mvn_test_compile_fail_slice_raw.txt");
		let o = filter_surefire(i);
		assert!(o.contains("cannot find symbol"), "ERROR line preserved; got:\n{o}");
		assert!(o.contains("symbol:   variable bar"), "indented `symbol:` preserved; got:\n{o}");
		assert!(
			o.contains("location: class org.apache.commons.cli.CompileBreaker"),
			"indented `location:` preserved; got:\n{o}"
		);
		assert!(o.contains("BUILD FAILURE"), "footer preserved; got:\n{o}");
	}

	#[test]
	fn package_still_keeps_compile_error_continuation_after_refactor() {
		let i = include_str!("fixtures/jvm/mvn_compile_error_slice_raw.txt");
		let o = filter_package(i);
		assert!(o.contains("cannot find symbol"), "ERROR line preserved; got:\n{o}");
		assert!(o.contains("symbol:   variable bar"), "indented `symbol:` preserved; got:\n{o}");
		assert!(
			o.contains("location: class org.apache.commons.cli.CompileBreaker"),
			"indented `location:` preserved; got:\n{o}"
		);
	}

	#[test]
	fn surefire_keeps_module_banner() {
		let i = "[INFO] Scanning for projects...\n[INFO] -----< com.example:myapp >-----\n[INFO] \
		         BUILD SUCCESS\n";
		let o = filter_surefire(i);
		assert!(o.contains("-----< com.example:myapp >-----"));
	}

	#[test]
	fn surefire_preserves_real_durations() {
		let i = "[INFO] -----< x >-----\n[INFO] Running x.Foo\n[ERROR] Tests run: 1, Failures: 1, \
		         Errors: 0, Skipped: 0, Time elapsed: 2.341 s <<< FAILURE! - in x.Foo\n[INFO] BUILD \
		         FAILURE\n[INFO] Total time:  4.567 s\n";
		let o = filter_surefire(i);
		assert!(o.contains("2.341 s"), "raw close-line duration preserved; got:\n{o}");
		assert!(o.contains("Total time:  4.567 s"), "raw total time preserved; got:\n{o}");
		assert!(!o.contains("Time elapsed: T s"), "no normalisation in production; got:\n{o}");
	}

	// ── English-footer guard (rtk ~1551-1578) ────────────────────────────────

	#[test]
	fn footer_guard_french_passthrough() {
		let i = include_str!("fixtures/jvm/mvn_locale_fr_raw.txt");
		let o = filter_surefire(i);
		assert!(o.contains("BUILD ÉCHEC"), "footer-guard passes through non-English; got:\n{o}");
		assert_eq!(o.lines().count(), i.lines().count(), "footer-guard returns raw input");
	}

	#[test]
	fn footer_guard_no_pom_passthrough() {
		let i = include_str!("fixtures/jvm/mvn_no_pom_raw.txt");
		let o = filter_surefire(i);
		assert!(o.contains("there is no POM"), "no-pom error preserved; got:\n{o}");
	}

	// ── CRLF line-ending compatibility (rtk ~1589-1615) ──────────────────────

	#[test]
	fn surefire_handles_crlf_line_endings() {
		let i_lf = include_str!("fixtures/jvm/mvn_test_pass_slice_raw.txt").replace("\r\n", "\n");
		let o_lf = filter_surefire(&i_lf);
		let i_crlf = i_lf.replace('\n', "\r\n");
		let o_crlf = filter_surefire(&i_crlf);
		assert_eq!(
			o_lf,
			o_crlf.replace("\r\n", "\n"),
			"CRLF filtered output must match LF (modulo line endings)"
		);
	}

	#[test]
	fn package_handles_crlf_line_endings() {
		let i_lf = include_str!("fixtures/jvm/mvn_install_slice_raw.txt").replace("\r\n", "\n");
		let o_lf = filter_package(&i_lf);
		let i_crlf = i_lf.replace('\n', "\r\n");
		let o_crlf = filter_package(&i_crlf);
		assert_eq!(
			o_lf,
			o_crlf.replace("\r\n", "\n"),
			"CRLF filtered output must match LF (modulo line endings)"
		);
	}

	// ── Cap: failing-class blocks (rtk ~1623-1711) ───────────────────────────

	#[test]
	fn surefire_caps_failing_blocks_emits_tail() {
		let mut i = String::from("[INFO] Scanning for projects...\n[INFO] -----< x >-----\n");
		for n in 1..=5 {
			let _ = write!(
				i,
				"[INFO] Running x.Fail{n}\n[ERROR] Tests run: 1, Failures: 1, Errors: 0, Skipped: 0, \
				 Time elapsed: 0.0{n}1 s <<< FAILURE! -- in x.Fail{n}\n[ERROR] x.Fail{n}.bar -- Time \
				 elapsed: 0.0{n}0 s <<< FAILURE!\norg.opentest4j.AssertionFailedError: boom{n}\n\tat \
				 x.Fail{n}.bar(Fail{n}.java:25)\n\n"
			);
		}
		i.push_str("[INFO] BUILD FAILURE\n");
		let o = filter_surefire_with_cap(&i, 3);
		for n in 1..=3 {
			assert!(o.contains(&format!("Running x.Fail{n}")), "Fail{n} kept; got:\n{o}");
			assert!(o.contains(&format!("in x.Fail{n}")), "Fail{n} close line kept; got:\n{o}");
		}
		for n in 4..=5 {
			assert!(!o.contains(&format!("Running x.Fail{n}")), "Fail{n} dropped; got:\n{o}");
			assert!(
				!o.contains(&format!("AssertionFailedError: boom{n}")),
				"Fail{n} exception dropped; got:\n{o}"
			);
		}
		assert!(o.contains("[…2 failing test classes elided…]"), "tail emitted; got:\n{o}");
	}

	#[test]
	fn surefire_cap_zero_emits_summary_only() {
		let mut i = String::from("[INFO] Scanning for projects...\n[INFO] -----< x >-----\n");
		for n in 1..=5 {
			let _ = write!(
				i,
				"[INFO] Running x.Fail{n}\n[ERROR] Tests run: 1, Failures: 1, Errors: 0, Skipped: 0, \
				 Time elapsed: 0.0{n}1 s <<< FAILURE! -- in x.Fail{n}\n\n"
			);
		}
		i.push_str("[INFO] BUILD FAILURE\n");
		let o = filter_surefire_with_cap(&i, 0);
		for n in 1..=5 {
			assert!(
				!o.contains(&format!("Running x.Fail{n}")),
				"Fail{n} dropped under cap=0; got:\n{o}"
			);
		}
		assert!(o.contains("[…5 failing test classes elided…]"), "tail counts all 5; got:\n{o}");
	}

	#[test]
	fn failures_summary_block_is_capped() {
		let mut i =
			String::from("[INFO] -----< x >-----\n[INFO] Results:\n[INFO]\n[ERROR] Failures:\n");
		for n in 1..=5 {
			let _ = writeln!(i, "[ERROR]   ClassA.test{n}:25 expected: <a> but was: <b{n}>");
		}
		i.push_str(
			"[INFO]\n[ERROR] Tests run: 100, Failures: 5, Errors: 0, Skipped: 0\n[INFO] BUILD \
			 FAILURE\n",
		);
		let o = filter_surefire_with_cap(&i, 3);
		for n in 1..=3 {
			assert!(o.contains(&format!("ClassA.test{n}:25")), "entry {n} kept; got:\n{o}");
		}
		for n in 4..=5 {
			assert!(!o.contains(&format!("ClassA.test{n}:25")), "entry {n} dropped; got:\n{o}");
		}
		let tail_idx = o.find("[…2 failures elided…]").expect("tail must appear");
		let agg_idx = o
			.find("[ERROR] Tests run: 100")
			.expect("aggregate must appear");
		assert!(tail_idx < agg_idx, "tail must precede aggregate; got:\n{o}");
	}

	// ── Multi-module reactor summary (rtk ~1777-1848) ────────────────────────

	#[test]
	fn reactor_summary_kept_on_multi_module_pass() {
		let i = include_str!("fixtures/jvm/mvn_reactor_pass_slice_raw.txt");
		let o = filter_package(i);
		assert!(
			o.contains("Reactor Summary for multi-module-skeleton"),
			"reactor summary header preserved; got:\n{o}"
		);
		assert!(
			o.contains("[INFO] child-a ............................................ SUCCESS"),
			"per-module SUCCESS row preserved; got:\n{o}"
		);
		assert!(
			o.contains("[INFO] child-b ............................................ SUCCESS"),
			"second per-module SUCCESS row preserved; got:\n{o}"
		);
		assert!(o.contains("BUILD SUCCESS"), "footer preserved; got:\n{o}");
	}

	#[test]
	fn reactor_summary_kept_on_multi_module_fail() {
		let i = include_str!("fixtures/jvm/mvn_reactor_fail_slice_raw.txt");
		let o = filter_package(i);
		assert!(
			o.contains("Reactor Summary for multi-module-skeleton"),
			"reactor summary header preserved; got:\n{o}"
		);
		assert!(
			o.contains("child-a ............................................ SUCCESS"),
			"successful module row preserved; got:\n{o}"
		);
		assert!(
			o.contains("child-b ............................................ FAILURE"),
			"failing module row preserved; got:\n{o}"
		);
		assert!(o.contains("BUILD FAILURE"), "footer preserved; got:\n{o}");
		assert!(o.contains("[ERROR] Failed to execute goal"), "goal terminator preserved; got:\n{o}");
		assert!(o.contains("mvn <args> -rf :child-b"), "resume hint preserved; got:\n{o}");
		assert!(!o.contains("[Help 1]"), "help boilerplate stripped; got:\n{o}");
		assert!(!o.contains("Re-run Maven"), "re-run hint stripped; got:\n{o}");
		let savings = savings_pct(i, &o);
		assert!(savings >= 30.0, "reactor-fail slice savings >=30%; got {savings:.1}%");
	}

	// ── Compile filter (rtk ~1853-1891) ──────────────────────────────────────

	#[test]
	fn filter_compile_error_compact() {
		let i = include_str!("fixtures/jvm/mvn_compile_error_slice_raw.txt");
		let o = filter_compile(i);
		let savings = savings_pct(i, &o);
		assert!(savings >= 30.0, "compile-error fixture small; >=30% savings, got {savings:.1}%");
	}

	#[test]
	fn compile_preserves_error_continuation() {
		let i = include_str!("fixtures/jvm/mvn_compile_error_slice_raw.txt");
		let o = filter_compile(i);
		assert!(o.contains("cannot find symbol"), "ERROR line preserved");
		assert!(o.contains("symbol:   variable bar"), "indented continuation preserved");
		assert!(o.contains("BUILD FAILURE"), "footer preserved");
		assert!(!o.contains("[Help 1]"), "help boilerplate stripped; got:\n{o}");
	}

	#[test]
	fn compile_dedupes_warnings() {
		let i = "[INFO] -----< x >-----\n[WARNING] /a.java:[1,2] uses deprecated API\n[WARNING] \
		         /b.java:[3,4] uses deprecated API\n[WARNING] /a.java:[5,6] unchecked cast\n[INFO] \
		         BUILD SUCCESS\n";
		let o = filter_compile(i);
		let warns = o.matches("[WARNING]").count();
		assert_eq!(warns, 2, "dedup by normalised message; got:\n{o}");
	}

	// ── Package filter (rtk ~1895-1926) ──────────────────────────────────────

	#[test]
	fn filter_package_install_compact() {
		let i = include_str!("fixtures/jvm/mvn_install_slice_raw.txt");
		let o = filter_package(i);
		let savings = savings_pct(i, &o);
		assert!(savings >= 50.0, "install-slice savings >=50%, got {savings:.1}%");
	}

	#[test]
	fn package_keeps_install_lines() {
		let i = include_str!("fixtures/jvm/mvn_install_slice_raw.txt");
		let o = filter_package(i);
		assert!(o.contains("Installing"), "install line preserved; got:\n{o}");
		assert!(o.contains("Building jar:"), "jar line preserved; got:\n{o}");
		assert!(!o.contains("at org.junit."), "framework frames stripped; got:\n{o}");
	}

	// ── Quiet mode (`mvn -q`) (rtk ~2005-2108) ───────────────────────────────

	#[test]
	fn quiet_green_run_is_empty() {
		assert_eq!(filter_quiet(""), "");
		assert_eq!(filter_quiet("   \n\n  \n"), "");
	}

	#[test]
	fn quiet_fail_strips_framework_and_boilerplate() {
		let i = include_str!("fixtures/jvm/mvn_quiet_fail_raw.txt");
		let o = filter_quiet(i);
		assert!(
			o.contains("Tests run: 1, Failures: 1, Errors: 0, Skipped: 0"),
			"close-line preserved; got:\n{o}"
		);
		assert!(o.contains("AssertionFailedError"), "exception class preserved; got:\n{o}");
		assert!(o.contains("at x.FailTest.this_will_fail"), "user-code frame preserved; got:\n{o}");
		assert!(o.contains("[ERROR] Failures:"), "failure summary header preserved; got:\n{o}");
		assert!(
			o.contains("[ERROR] Tests run: 6, Failures: 1, Errors: 0, Skipped: 0"),
			"aggregate preserved; got:\n{o}"
		);
		assert!(o.contains("[ERROR] Failed to execute goal"), "goal terminator preserved; got:\n{o}");
		assert!(!o.contains("at org.junit."), "junit frame stripped; got:\n{o}");
		assert!(!o.contains("at java.base/"), "java.base frame stripped; got:\n{o}");
		assert!(!o.contains("To see the full stack trace"), "help boilerplate stripped; got:\n{o}");
		assert!(!o.contains("[Help 1] http"), "help link stripped; got:\n{o}");
		assert!(
			!o.contains("See /tmp/") && !o.contains("See dump files"),
			"log-pointer lines stripped; got:\n{o}"
		);
	}

	#[test]
	fn savings_mvn_quiet_fail() {
		let i = include_str!("fixtures/jvm/mvn_quiet_fail_raw.txt");
		let o = filter_quiet(i);
		let savings = savings_pct(i, &o);
		assert!(savings >= 50.0, "mvn -q fail >=50% savings, got {savings:.1}%");
	}

	#[test]
	fn quiet_unknown_error_line_kept_as_safety_net() {
		let i = "[ERROR] Some unexpected error output we don't classify\n";
		let o = filter_quiet(i);
		assert!(
			o.contains("Some unexpected error output"),
			"unclassified ERROR line preserved; got:\n{o}"
		);
	}

	// ── Dispatch smoke tests ─────────────────────────────────────────────────

	#[test]
	fn dispatch_supports_all_jvm_programs() {
		assert!(supports("mvn", Some("clean")));
		assert!(supports("mvnw", None));
		assert!(supports("gradle", Some("build")));
		assert!(supports("gradlew", Some("test")));
		assert!(supports("mvnw.cmd", None));
		assert!(supports("gradlew.bat", None));
		assert!(!supports("cargo", Some("test")));
	}

	#[test]
	fn gradle_build_strips_tasks_keeps_status() {
		// Replaces the former temporary-passthrough pin: gradle now dispatches to
		// the real Build filter, which strips `> Task :…UP-TO-DATE` noise and
		// keeps the BUILD status (carries over the deleted defs/gradle.toml
		// UP-TO-DATE strip as a Rust filter).
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let i = "> Task :app:compileJava UP-TO-DATE\n> Task :app:test\nBUILD SUCCESSFUL in 8s\n";
		let out = filter(&ctx("gradle", "gradle build", &cfg), i, 0);
		assert!(out.changed, "build filter strips task-progress noise");
		assert!(out.text.contains("BUILD SUCCESSFUL in 8s"), "status kept; got:\n{}", out.text);
		assert!(!out.text.contains("> Task :"), "task lines stripped; got:\n{}", out.text);
	}

	#[test]
	fn dispatch_clean_install_routes_to_package() {
		// End-to-end: `mvn clean install` must route through the Package filter
		// (not the `clean`-Passthrough that ctx.subcommand would pick).
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let i = include_str!("fixtures/jvm/mvn_install_slice_raw.txt");
		let out = filter(&ctx("mvn", "mvn clean install", &cfg), i, 0);
		assert!(out.changed, "package filter transformed install output");
		assert!(out.text.contains("Building jar:"), "package keepers applied; got:\n{}", out.text);
	}

	// ── Carried-over deleted-def test: maven.toml "keeps build failure" ───────

	/// maven.toml's `[[tests]]` "keeps build failure" — the Passthrough-phase
	/// strip (clean/plugin goals) must still surface the BUILD FAILURE +
	/// `Failed to execute goal` signal while dropping `Downloading`/banner
	/// noise.
	#[test]
	fn passthrough_keeps_build_failure_drops_download_noise() {
		let i = "[INFO] Scanning for projects...\n\
		         [INFO] Downloading from central: https://repo.maven.apache.org/foo.jar\n\
		         [INFO] -----\n\
		         [ERROR] Failed to execute goal\n\
		         [INFO] BUILD FAILURE\n";
		let o = filter_passthrough(i);
		assert!(o.contains("[ERROR] Failed to execute goal"), "error kept; got:\n{o}");
		assert!(o.contains("[INFO] BUILD FAILURE"), "footer kept; got:\n{o}");
		assert!(!o.contains("Downloading from central"), "download noise dropped; got:\n{o}");
		assert!(!o.contains("[INFO] -----"), "banner dashes dropped; got:\n{o}");
	}

	// ═══════════════════════════════════════════════════════════════════════
	// GRADLE TESTS (ported from rtk gradlew_cmd.rs inline #[test]s)
	// ═══════════════════════════════════════════════════════════════════════

	// ── Task detection (rtk ~541-658) ───────────────────────────────────────

	#[test]
	fn gradle_detect_connected_wins_over_test() {
		// connectedAndroidTest contains "test" — ConnectedTest must win.
		assert_eq!(detect_task("gradlew connectedDebugAndroidTest"), GradleTask::ConnectedTest);
	}
	#[test]
	fn gradle_detect_assemble_debug() {
		assert_eq!(detect_task("gradlew assembleDebug"), GradleTask::Build);
	}
	#[test]
	fn gradle_detect_test_debug_unit_test() {
		assert_eq!(detect_task("gradlew testDebugUnitTest"), GradleTask::Test);
	}
	#[test]
	fn gradle_detect_module_prefixed_task() {
		assert_eq!(detect_task("gradlew :app:testDebugUnitTest"), GradleTask::Test);
	}
	#[test]
	fn gradle_detect_module_prefixed_assemble() {
		assert_eq!(detect_task("gradlew :app:assembleDebug"), GradleTask::Build);
	}
	#[test]
	fn gradle_detect_flag_value_does_not_trigger_test() {
		// -Pflavor=testRelease should NOT match Test when the task is assemble.
		assert_eq!(detect_task("gradlew assembleRelease -Pflavor=testRelease"), GradleTask::Build);
	}
	#[test]
	fn gradle_detect_multi_task_uses_last() {
		// clean assembleDebug → Build (last non-clean task).
		assert_eq!(detect_task("gradlew clean assembleDebug"), GradleTask::Build);
	}
	#[test]
	fn gradle_detect_lint() {
		assert_eq!(detect_task("gradlew lint"), GradleTask::Lint);
	}
	#[test]
	fn gradle_detect_ktlint() {
		assert_eq!(detect_task("gradlew ktlintCheck"), GradleTask::Lint);
	}
	#[test]
	fn gradle_detect_bundle() {
		assert_eq!(detect_task("gradlew bundleRelease"), GradleTask::Build);
	}
	#[test]
	fn gradle_detect_unknown_passthrough() {
		assert_eq!(detect_task("gradlew signingReport"), GradleTask::Other);
	}
	#[test]
	fn gradle_detect_clean_alone_is_build() {
		// "clean" alone → task.is_empty() after filtering → Build.
		assert_eq!(detect_task("gradlew clean"), GradleTask::Build);
	}
	#[test]
	fn gradle_detect_install_debug() {
		assert_eq!(detect_task("gradlew installDebug"), GradleTask::Build);
	}
	#[test]
	fn gradle_detect_uninstall_debug() {
		// "uninstallDebug" contains "install" → Build (rtk parity).
		assert_eq!(detect_task("gradlew uninstallDebug"), GradleTask::Build);
	}
	#[test]
	fn gradle_detect_clean_install() {
		assert_eq!(detect_task("gradlew clean installDebug"), GradleTask::Build);
	}
	#[test]
	fn gradle_detect_check() {
		assert_eq!(detect_task("gradlew check"), GradleTask::Test);
	}
	#[test]
	fn gradle_detect_dependencies() {
		assert_eq!(detect_task("gradlew dependencies"), GradleTask::Dependencies);
	}
	#[test]
	fn gradle_detect_dependencies_with_module() {
		assert_eq!(detect_task("gradlew :app:dependencies"), GradleTask::Dependencies);
	}
	#[test]
	fn gradle_detect_boot_run_routes_to_spring() {
		// `bootRun` routes to the dedicated Spring Boot runtime filter.
		assert_eq!(detect_task("gradlew bootRun"), GradleTask::SpringBootRun);
		assert_eq!(detect_task("gradlew :app:bootRun"), GradleTask::SpringBootRun);
	}
	#[test]
	fn detect_task_ignores_tests_filter_value() {
		// "--tests FooSpec" option-value must not shadow the task
		assert_eq!(detect_task("./gradlew test --tests FooSpec"), GradleTask::Test);
		assert_eq!(detect_task("./gradlew test --tests com.example.Foo"), GradleTask::Test);
	}
	#[test]
	fn detect_task_skips_value_of_value_taking_options() {
		// "-p test build" — "test" is the value of -p (project-dir), not a task name
		assert_eq!(detect_task("gradle -p test build"), GradleTask::Build);
		// "--project-dir test build" — long form
		assert_eq!(detect_task("gradle --project-dir test build"), GradleTask::Build);
	}

	// ── Build filter (rtk ~660-744, 1128-1230, 1347-1379) ───────────────────

	#[test]
	fn gradle_build_success_strips_task_lines() {
		let input = "> Configure project :app\n> Task :app:preBuild UP-TO-DATE\n> Task \
		             :app:compileDebugKotlin UP-TO-DATE\n> Task :app:assembleDebug \
		             UP-TO-DATE\n\nBUILD SUCCESSFUL in 1m 23s\n42 actionable tasks: 42 executed";
		let o = filter_gradle_build(input);
		// rtk asserts >=70% on its full BUILD fixture; this inlined synthetic
		// slice is smaller, so the floor is relaxed (same rationale the mvn
		// slice-savings tests in this file use vs rtk's fixture thresholds).
		let savings = savings_pct(input, &o);
		assert!(savings >= 55.0, "build savings >=55%, got {savings:.1}%");
		assert!(o.contains("BUILD SUCCESSFUL"), "status kept; got:\n{o}");
		assert!(!o.contains("> Task :"), "task lines stripped; got:\n{o}");
	}

	#[test]
	fn gradle_build_failure_preserves_errors_strips_try() {
		let input = "> Task :app:compileDebugKotlin FAILED\n\nFAILURE: Build failed with an \
		             exception.\n\n* What went wrong:\ne: /src/app/MainActivity.kt: (42, 5): \
		             Unresolved reference: MyService\n\n* Try:\n> Run with --stacktrace option to \
		             get the stack trace.\n> Get more help at https://help.gradle.org\n\nBUILD \
		             FAILED in 12s";
		let o = filter_gradle_build(input);
		assert!(o.contains("Unresolved reference"), "error kept; got:\n{o}");
		assert!(o.contains("BUILD FAILED"), "status kept; got:\n{o}");
		assert!(!o.contains("Run with --stacktrace"), "try section stripped; got:\n{o}");
		assert!(!o.contains("Get more help at"), "help link stripped; got:\n{o}");
	}

	#[test]
	fn gradle_build_filter_never_empty_on_success() {
		let input = "> Task :app:assembleDebug UP-TO-DATE\nBUILD SUCCESSFUL in 3s\n1 actionable \
		             tasks: 1 up-to-date";
		let o = filter_gradle_build(input);
		assert!(!o.trim().is_empty(), "must not be empty on success; got:\n{o}");
		assert!(o.contains("BUILD SUCCESSFUL"));
	}

	#[test]
	fn gradle_build_daemon_lines_stripped() {
		let input = "Starting a Gradle Daemon (subsequent builds will be faster)\nDaemon will be \
		             stopped at the end of the build after running out of JVM memory\n> Task \
		             :app:assembleDebug\nBUILD SUCCESSFUL in 5s";
		let o = filter_gradle_build(input);
		assert!(!o.contains("Daemon"), "daemon lines stripped; got:\n{o}");
		assert!(o.contains("BUILD SUCCESSFUL"));
	}

	#[test]
	fn gradle_build_scan_url_preserved() {
		let input = "> Task :app:assembleDebug\nBUILD SUCCESSFUL in 5s\nPublishing build \
		             scan...\nhttps://gradle.com/s/abc123";
		let o = filter_gradle_build(input);
		assert!(o.contains("gradle.com/s/"), "build scan URL kept; got:\n{o}");
	}

	#[test]
	fn gradle_build_keeps_compiler_warnings() {
		let input = "> Task :app:compileDebugKotlin\nw: /src/Foo.kt: (42, 5): Parameter 'unused' is \
		             never used\nwarning: [options] bootstrap class path not set\nWarning: Gradle \
		             deprecation detected\n\nBUILD SUCCESSFUL in 4s";
		let o = filter_gradle_build(input);
		assert!(o.contains("w: "), "kotlinc warnings kept; got:\n{o}");
		assert!(o.contains("warning: [options]"), "javac warnings kept; got:\n{o}");
		assert!(o.contains("Warning: Gradle"), "Gradle warnings kept; got:\n{o}");
		assert!(o.contains("BUILD SUCCESSFUL"));
		assert!(!o.contains("> Task :"), "task progress stripped; got:\n{o}");
	}

	#[test]
	fn gradle_build_strips_configure_and_dokka_noise() {
		// rtk's "check (build filter on mixed output)" test (~1147-1230).
		let input = "Calculating task graph as no cached configuration is available for tasks: \
		             check\n\n> Configure project :core\nclass \
		             org.jetbrains.dokka.gradle.adapters.AndroidExtensionWrapper could not get \
		             Android Extension for project :core\n[android-junit5]: Cannot configure Jacoco \
		             for this project\n\n> Task :core:preBuild UP-TO-DATE\n> Task :samplev2:lintDebug \
		             FAILED\nLint found 8 errors, 21 warnings. First failure:\n\n/src/LogsScreen.kt:\
		             50: Error: Field requires API level 26 [NewApi]\n    val uiState = \
		             viewModel.uiState.collectAsState()\n\n[Incubating] Problems report is available \
		             at: file:///build/reports/problems.html\n\nDeprecated Gradle features were used \
		             in this build, making it incompatible with Gradle 10.\n\nYou can use \
		             '--warning-mode all' to show the individual deprecation warnings.\n388 \
		             actionable tasks: 97 executed\n\nFAILURE: Build failed with an exception.\n\n* \
		             What went wrong:\nExecution failed for task ':samplev2:lintDebug'.\n\n* Try:\n> \
		             Run with --stacktrace option to get the stack trace.\n\nBUILD FAILED in 3s";
		let o = filter_gradle_build(input);
		assert!(o.contains("BUILD FAILED"), "status kept; got:\n{o}");
		assert!(o.contains("FAILURE:"), "FAILURE line kept; got:\n{o}");
		assert!(o.contains("Execution failed"), "Execution failed kept; got:\n{o}");
		assert!(o.contains("Lint found 8 error"), "lint summary kept; got:\n{o}");
		assert!(o.contains("Error: Field requires"), "lint error kept; got:\n{o}");
		assert!(!o.contains("Configure project"), "configure stripped; got:\n{o}");
		assert!(!o.contains("dokka"), "dokka warnings stripped; got:\n{o}");
		assert!(!o.contains("android-junit5"), "plugin warnings stripped; got:\n{o}");
		assert!(!o.contains("> Task :"), "task lines stripped; got:\n{o}");
		assert!(!o.contains("Incubating"), "incubating stripped; got:\n{o}");
		assert!(!o.contains("Deprecated Gradle"), "deprecated stripped; got:\n{o}");
		assert!(!o.contains("Run with --stacktrace"), "try section stripped; got:\n{o}");
		let savings = savings_pct(input, &o);
		assert!(savings >= 60.0, "mixed-output savings >=60%, got {savings:.1}%");
	}

	// ── Test filter (rtk ~748-860) ──────────────────────────────────────────

	#[test]
	fn gradle_unit_test_failures_preserved_passes_stripped() {
		let input = "> Task :app:testDebugUnitTest\ncom.example.FooTest > test1 \
		             PASSED\ncom.example.FooTest > test2 PASSED\ncom.example.FooTest > testBar \
		             FAILED\n    java.lang.AssertionError: expected:<3> but was:<-1>\n        at \
		             org.junit.Assert.fail(Assert.java:89)\n        at \
		             org.junit.Assert.assertEquals(Assert.java:197)\n        at \
		             com.example.FooTest.testBar(FooTest.kt:25)\ncom.example.FooTest > testQux \
		             PASSED\n\n10 tests completed, 1 failed";
		let o = filter_gradle_test(input);
		assert!(o.contains("testBar FAILED"), "FAILED test kept; got:\n{o}");
		assert!(o.contains("AssertionError"), "exception class kept; got:\n{o}");
		assert!(o.contains("FooTest.testBar"), "user frame kept; got:\n{o}");
		assert!(!o.contains("org.junit.Assert.fail"), "framework frames skipped; got:\n{o}");
		assert!(!o.contains("PASSED"), "PASSED stripped; got:\n{o}");
		assert!(o.contains("10 tests completed, 1 failed"), "summary kept; got:\n{o}");
		// rtk asserts >=60% on its full TEST fixture; this inlined synthetic slice
		// is smaller, so the floor is relaxed.
		let savings = savings_pct(input, &o);
		assert!(savings >= 50.0, "test savings >=50%, got {savings:.1}%");
	}

	#[test]
	fn gradle_unit_test_skips_framework_frames() {
		// Built via `concat!` of one `\n`-terminated literal per line so rustfmt's
		// soft-wrap `\`-continuation cannot mangle the leading-whitespace escapes.
		let input = concat!(
			"com.example.CalcTest > testAdd FAILED\n",
			"    java.lang.AssertionError: expected:<5> but was:<3>\n",
			"        at org.junit.Assert.fail(Assert.java:89)\n",
			"        at org.junit.Assert.assertEquals(Assert.java:197)\n",
			"        at java.lang.reflect.Method.invoke(Method.java:498)\n",
			"        at com.example.CalcTest.testAdd(CalcTest.kt:10)",
		);
		let o = filter_gradle_test(input);
		assert!(o.contains("com.example.CalcTest.testAdd"), "user frame kept; got:\n{o}");
		assert!(!o.contains("org.junit.Assert"), "JUnit frames skipped; got:\n{o}");
		assert!(!o.contains("java.lang.reflect"), "reflection frames skipped; got:\n{o}");
	}

	#[test]
	fn gradle_unit_test_no_testlogging_emits_hint() {
		// Gradle default: no per-test lines shown. Empty output → rtk hint message.
		let input = "> Task :app:testDebugUnitTest\n\nBUILD SUCCESSFUL in 15s\n3 actionable tasks: \
		             1 executed, 2 up-to-date";
		let o = filter_gradle_test(input);
		assert!(!o.is_empty(), "must output something on success; got:\n{o}");
		// The summary regex does not match this output, so the testLogging hint
		// fires (richer than the generic OK an empty buffer would produce).
		assert!(
			o.contains("add testLogging to build.gradle") || o.contains("BUILD SUCCESSFUL"),
			"hint or status present; got:\n{o}"
		);
	}

	#[test]
	fn gradle_test_keeps_testlogging_hint_message() {
		// The actionable testLogging hint an 'OK' cannot convey — deliberate. It
		// fires only when the run produced NO per-test output AND no standalone
		// build-status/summary line survived (a standalone `BUILD SUCCESSFUL` line
		// is kept by `is_gradle_build_status`, which would otherwise satisfy the
		// non-empty guard). The all-`> Task :` input below strips to empty while
		// still containing the `BUILD SUCCESSFUL` substring, exercising the hint.
		let input = "> Task :app:testDebugUnitTest\n> Task :app:check BUILD SUCCESSFUL";
		let o = filter_gradle_test(input);
		assert!(
			o.contains("ok ✓ (no test output — add testLogging to build.gradle for details)"),
			"testLogging hint emitted when filtered output is empty; got:\n{o}"
		);
	}

	#[test]
	fn gradle_unit_test_report_path_preserved() {
		let input = "There were failing tests. See the report at: \
		             file:///app/build/reports/tests/testDebugUnitTest/index.html\nBUILD FAILED in \
		             20s";
		let o = filter_gradle_test(input);
		assert!(o.contains("See the report at"), "report pointer kept; got:\n{o}");
		assert!(o.contains("BUILD FAILED"), "status kept; got:\n{o}");
	}

	#[test]
	fn gradle_try_section_stripped_from_test_output() {
		let input = "com.example.FooTest > testBar FAILED\n    java.lang.AssertionError: expected \
		             true\n\n* Try:\n> Run with --stacktrace option to get the stack trace.\n> Get \
		             more help at https://help.gradle.org\n\nBUILD FAILED in 5s";
		let o = filter_gradle_test(input);
		assert!(!o.contains("Run with --stacktrace"), "try stripped; got:\n{o}");
		assert!(!o.contains("Get more help at"), "help stripped; got:\n{o}");
		assert!(o.contains("BUILD FAILED"), "status kept; got:\n{o}");
	}

	#[test]
	fn gradle_failure_keeps_opentest4j_assertion() {
		let input = concat!(
			"\n",
			"> Task :test FAILED\n",
			"\n",
			"FooTest > myTest FAILED\n",
			"    org.opentest4j.AssertionFailedError: expected: <true> but was: <false>\n",
			"        at FooTest.myTest(FooTest.kt:42)\n",
			"        at \
			 org.junit.platform.engine.discovery.DiscoverySelectors.selectMethod(DiscoverySelectors.\
			 java:218)\n",
			"\n",
			"1 test completed, 1 failed\n",
			"\n",
			"BUILD FAILED in 2s\n",
		);
		let out = filter_gradle_test(input);
		assert!(
			out.contains("AssertionFailedError"),
			"assertion error class must be kept; got:\n{out}"
		);
		assert!(out.contains("expected: <true>"), "assertion message must be kept; got:\n{out}");
		assert!(out.contains("FooTest.myTest"), "user frame must be kept; got:\n{out}");
		assert!(!out.contains("DiscoverySelectors"), "framework frame must be stripped; got:\n{out}");
	}

	// ── Connected test filter (rtk ~864-893) ────────────────────────────────

	#[test]
	fn gradle_connected_strips_device_noise() {
		let input = "Starting 3 tests on Pixel_6_API_33(AVD) - 13\nINSTRUMENTATION_STATUS: \
		             numtests=3\nINSTRUMENTATION_STATUS_CODE: 1\ncom.example.MainActivityTest > \
		             exampleTest[Pixel_6_API_33] FAILED\n    AssertionError: expected \
		             true\nINSTRUMENTATION_STATUS_CODE: -2\nTests run: 3, Failures: 1, Errors: 0, \
		             Skipped: 0";
		let o = filter_gradle_connected(input);
		assert!(o.contains("FAILED"), "FAILED test kept; got:\n{o}");
		assert!(!o.contains("INSTRUMENTATION_STATUS:"), "instrumentation stripped; got:\n{o}");
		assert!(!o.contains("Starting 3 tests"), "starting line stripped; got:\n{o}");
	}

	#[test]
	fn gradle_connected_no_device_error() {
		let input = "com.android.builder.testing.api.DeviceException: No connected devices!";
		let o = filter_gradle_connected(input);
		assert!(o.contains("No connected devices"), "actionable error shown; got:\n{o}");
	}

	// ── Lint filter (rtk ~897-950, 1104-1126) ───────────────────────────────

	#[test]
	fn gradle_lint_preserves_violations() {
		let input = "Wrote HTML report to \
		             file:/path/app/build/reports/lint-results-debug.html\nsrc/main/java/com/\
		             example/MainActivity.kt:45: Error: Format string invalid \
		             [StringFormatInvalid]\n  String.format(getString(R.string.no_args), arg)\n  \
		             ^\n0 errors, 4 warnings";
		let o = filter_gradle_lint(input);
		assert!(o.contains("StringFormatInvalid"), "violation kept; got:\n{o}");
		assert!(o.contains("0 errors, 4 warnings"), "summary kept; got:\n{o}");
		assert!(!o.contains("Wrote HTML report"), "report path stripped; got:\n{o}");
	}

	#[test]
	fn gradle_lint_preserves_warnings_and_context() {
		let input = "src/main/java/com/example/Utils.kt:89: Warning: HardcodedText \
		             [HardcodedText]\n    return \"Hello World\"\n           \
		             ~~~~~~~~~~~~~\nsrc/main/res/layout/activity_main.xml:15: Warning: Missing \
		             contentDescription attribute on image [ContentDescription]\n    \
		             <ImageView\nRan lint on variant debug: 2 warnings";
		let o = filter_gradle_lint(input);
		assert!(o.contains("HardcodedText"), "warning kept; got:\n{o}");
		assert!(o.contains("ContentDescription"), "warning kept; got:\n{o}");
		assert!(o.contains("2 warnings"), "summary kept; got:\n{o}");
		// Context lines after each violation are preserved (cross-line state).
		assert!(o.contains("return \"Hello World\""), "code snippet kept; got:\n{o}");
		assert!(o.contains("<ImageView"), "XML snippet kept; got:\n{o}");
	}

	#[test]
	fn gradle_lint_no_violations_success() {
		let input =
			"> Task :app:lint\nBUILD SUCCESSFUL in 8s\n3 actionable tasks: 1 executed, 2 up-to-date";
		let o = filter_gradle_lint(input);
		assert!(!o.is_empty(), "must output on success; got:\n{o}");
		assert!(
			o.contains("ok ✓ lint passed") || o.contains("BUILD SUCCESSFUL"),
			"success indicated; got:\n{o}"
		);
	}

	// ── Dependencies filter (rtk ~1235-1308) ────────────────────────────────

	#[test]
	fn gradle_dependencies_extracts_top_level() {
		let input =
			"> Task :app:dependencies\n\\
			 n------------------------------------------------------------\nProject \
			 ':app'\n------------------------------------------------------------\n\nimplementation \
			 - Implementation dependencies for the 'main' feature.\n+--- \
			 org.jetbrains.kotlin:kotlin-stdlib:1.9.22\n+--- androidx.core:core-ktx:1.12.0\n+--- \
			 androidx.appcompat:appcompat:1.6.1\n|    +--- androidx.annotation:annotation:1.3.0\n|    \
			 +--- androidx.core:core:1.9.0\n|    \\--- \
			 androidx.cursoradapter:cursoradapter:1.0.0\n+--- \
			 com.google.android.material:material:1.11.0\n|    +--- \
			 androidx.annotation:annotation:1.2.0\n\\--- com.squareup.retrofit2:retrofit:2.9.0\n     \
			 +--- com.squareup.okhttp3:okhttp:3.14.9\n     \\--- \
			 com.squareup.okio:okio:1.17.2\n\ntestImplementation - Test dependencies for the 'main' \
			 feature.\n+--- junit:junit:4.13.2\n\\--- org.mockito:mockito-core:5.8.0\n\nBUILD \
			 SUCCESSFUL in 2s\n1 actionable tasks: 1 executed";
		let o = filter_gradle_dependencies(input);
		assert!(o.contains("implementation (5):"), "config with count; got:\n{o}");
		assert!(o.contains("testImplementation (2):"), "test config; got:\n{o}");
		assert!(o.contains("kotlin-stdlib"), "top-level dep; got:\n{o}");
		assert!(!o.contains("cursoradapter"), "transitive deps stripped; got:\n{o}");
		let savings = savings_pct(input, &o);
		assert!(savings >= 60.0, "deps savings >=60%, got {savings:.1}%");
	}

	#[test]
	fn gradle_dependencies_empty() {
		assert_eq!(filter_gradle_dependencies(""), "");
	}

	#[test]
	fn gradle_dependencies_no_deps() {
		let input = "> Task :app:dependencies\nNo dependencies\n\nBUILD SUCCESSFUL in 1s";
		let o = filter_gradle_dependencies(input);
		assert!(o.contains("ok"), "success shown; got:\n{o}");
	}

	// ── Edge cases / shared helpers (rtk ~1312-1399) ────────────────────────

	#[test]
	fn gradle_filter_empty_input() {
		assert_eq!(filter_gradle_test(""), "");
		assert_eq!(filter_gradle_connected(""), "");
		assert_eq!(filter_gradle_lint(""), "");
		assert_eq!(filter_gradle_dependencies(""), "");
	}

	#[test]
	fn gradle_build_empty_line_preserved() {
		// Blank lines that separate error sections must survive the build filter.
		assert!(keep_gradle_build_line(""), "empty line passes through");
		assert!(keep_gradle_build_line("   "), "whitespace-only line passes through");
	}

	#[test]
	fn gradle_is_framework_frame_classification() {
		assert!(is_gradle_framework_frame("at org.junit.Assert.fail(Assert.java:89)"));
		assert!(is_gradle_framework_frame("at junit.framework.Assert.fail(Assert.java:50)"));
		assert!(is_gradle_framework_frame("at java.lang.reflect.Method.invoke(Method.java:498)"));
		assert!(is_gradle_framework_frame(
			"at org.gradle.api.internal.tasks.testing.SuiteTestClassProcessor.\
			 processTestClass(SuiteTestClassProcessor.java:51)"
		));
		assert!(!is_gradle_framework_frame("at com.example.FooTest.testBar(FooTest.kt:25)"));
		assert!(!is_gradle_framework_frame("at com.example.MyApp.doSomething(MyApp.java:100)"));
	}

	#[test]
	fn gradle_verbose_flag_forces_passthrough() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let i = "> Task :app:compileJava UP-TO-DATE\nBUILD SUCCESSFUL in 5s\n";
		// --info anywhere bypasses filtering even on a Build-task command.
		let out = filter(&ctx("gradlew", "gradlew assembleDebug --info", &cfg), i, 0);
		assert_eq!(out.text, i, "verbose bypass returns raw input");
		assert!(!out.changed);
	}

	#[test]
	fn gradle_other_task_light_strip() {
		// Unknown task: light Build-style daemon/progress/task strip, keep the rest.
		let input = "Starting a Gradle Daemon (subsequent builds will be faster)\n> Task \
		             :app:signingReport\nVariant: debug\nSHA1: AA:BB:CC\nBUILD SUCCESSFUL in 1s";
		let o = filter_gradle_other(input);
		assert!(o.contains("Variant: debug"), "non-noise kept; got:\n{o}");
		assert!(o.contains("SHA1: AA:BB:CC"), "report data kept; got:\n{o}");
		assert!(!o.contains("Starting a Gradle Daemon"), "daemon stripped; got:\n{o}");
		assert!(!o.contains("> Task :"), "task progress stripped; got:\n{o}");
	}

	// ── Carried-over deleted defs/gradle.toml [[tests]] ─────────────────────

	#[test]
	fn gradle_def_strips_up_to_date_and_keeps_result() {
		// defs/gradle.toml "strips UP-TO-DATE and keeps result". Build mode drops
		// all `> Task :` lines (superset of UP-TO-DATE) + Configure noise; keeps
		// the explicit `> Task :app:test` line? rtk gradle.toml kept the bare task
		// line, but the Rust Build filter strips ALL `> Task :` lines and relies on
		// the summary/status lines for signal. The build result + test summary are
		// what carry the signal and they survive.
		let input = "> Configure project :app\n> Task :app:compileJava UP-TO-DATE\n> Task \
		             :app:compileKotlin UP-TO-DATE\n> Task :app:test\n3 tests completed, 1 \
		             failed\nBUILD FAILED in 12s";
		let o = filter_gradle_build(input);
		assert!(o.contains("3 tests completed, 1 failed"), "test summary kept; got:\n{o}");
		assert!(o.contains("BUILD FAILED in 12s"), "status kept; got:\n{o}");
		assert!(!o.contains("UP-TO-DATE"), "UP-TO-DATE stripped; got:\n{o}");
		assert!(!o.contains("Configure project"), "configure stripped; got:\n{o}");
	}

	#[test]
	fn gradle_def_clean_build_untouched() {
		// defs/gradle.toml "clean build untouched": no noise → status + actionable
		// survive unchanged.
		let input = "BUILD SUCCESSFUL in 8s\n7 actionable tasks: 7 executed";
		let o = filter_gradle_build(input);
		assert!(o.contains("BUILD SUCCESSFUL in 8s"), "status kept; got:\n{o}");
		assert!(o.contains("7 actionable tasks: 7 executed"), "actionable kept; got:\n{o}");
	}

	#[test]
	fn gradle_def_empty_after_stripping() {
		// defs/gradle.toml "empty after stripping": only a Configure line → all
		// stripped → empty output (the engine's OK path covers the user-facing msg).
		let input = "> Configure project :app\n";
		let o = filter_gradle_build(input);
		assert!(o.trim().is_empty(), "all noise stripped to empty; got:\n{o}");
	}

	// ── snip gradlew-bat.yaml [[tests]] ─────────────────────────────────────

	#[test]
	fn gradle_snip_build_success() {
		let input = "> Task :compileJava\n> Task :processResources\n> Task :classes\n> Task \
		             :jar\n\nBUILD SUCCESSFUL in 2s\n5 actionable tasks: 5 executed";
		let o = filter_gradle_build(input);
		assert!(o.contains("BUILD SUCCESSFUL in 2s"), "status kept; got:\n{o}");
		assert!(o.contains("5 actionable tasks: 5 executed"), "actionable kept; got:\n{o}");
		assert!(!o.contains("> Task :"), "tasks stripped; got:\n{o}");
	}

	#[test]
	fn gradle_snip_build_failure_with_exception() {
		let input = "> Task :compileJava FAILED\n> Task :processResources UP-TO-DATE\n\nFAILURE: \
		             Build failed with an exception.\n\n* What went wrong:\nExecution failed for \
		             task ':compileJava'.\n> Compilation error: package com.example does not \
		             exist\n\nBUILD FAILED in 1s";
		let o = filter_gradle_build(input);
		assert!(o.contains("FAILURE: Build failed with an exception."), "FAILURE kept; got:\n{o}");
		assert!(o.contains("Compilation error: package com.example"), "error detail kept; got:\n{o}");
		assert!(o.contains("BUILD FAILED in 1s"), "status kept; got:\n{o}");
		assert!(!o.contains("> Task :"), "tasks stripped; got:\n{o}");
	}

	#[test]
	fn gradle_snip_download_and_start_noise_removed() {
		let input = "Downloading https://services.gradle.org/distributions/gradle-8.5-bin.zip\n.....\
		             ..................................................\nStarting a Gradle Daemon \
		             (subsequent builds will be faster)\n\n> Task :test\nTest result: FAILURE\n\nBUILD \
		             FAILED in 5s";
		let o = filter_gradle_build(input);
		assert!(o.contains("Test result: FAILURE"), "test result kept; got:\n{o}");
		assert!(o.contains("BUILD FAILED in 5s"), "status kept; got:\n{o}");
		assert!(!o.contains("Downloading"), "download stripped; got:\n{o}");
		assert!(!o.contains("Starting a Gradle Daemon"), "daemon stripped; got:\n{o}");
		assert!(!o.contains("> Task :"), "tasks stripped; got:\n{o}");
	}

	// ── Gradle dispatch smoke tests ─────────────────────────────────────────

	#[test]
	fn gradle_dispatch_test_task_routes_to_test_filter() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let i = "com.example.FooTest > t1 PASSED\ncom.example.FooTest > t2 FAILED\n    \
		         java.lang.AssertionError: boom\n        at \
		         com.example.FooTest.t2(FooTest.kt:9)\n10 tests completed, 1 failed\nBUILD FAILED \
		         in 3s\n";
		let out = filter(&ctx("gradlew", "gradlew testDebugUnitTest", &cfg), i, 1);
		assert!(out.changed, "test filter transformed output");
		assert!(out.text.contains("t2 FAILED"), "failing test kept; got:\n{}", out.text);
		assert!(!out.text.contains("PASSED"), "passing stripped; got:\n{}", out.text);
	}

	// ═══════════════════════════════════════════════════════════════════════
	// SPRING BOOT RUN TESTS
	// ═══════════════════════════════════════════════════════════════════════

	#[test]
	fn spring_boot_keeps_startup_summary_and_errors() {
		// rtk spring-boot.toml [[tests]] "keeps startup summary and errors".
		let input = "  .   ____          _ \n /\\\\ / ___'_ __ _ _(_)_ __  \n( ( )\\___ | '_ | '_| \
		             | '_ \\ \n \\/  ___)| |_)| | | | | || )\n  '  |____| .__|_| |_|_| |_\\__|\n  \
		             :: Spring Boot ::  (v3.2.0)\n2024-01-01 INFO Initializing Spring\n2024-01-01 \
		             INFO Bean 'dataSource' created\n2024-01-01 INFO Tomcat started on port \
		             8080\n2024-01-01 INFO Started MyApp in 3.2 seconds";
		let o = filter_spring_boot(input);
		assert!(o.contains("Tomcat started on port 8080"), "tomcat line kept; got:\n{o}");
		assert!(o.contains("Started MyApp in 3.2 seconds"), "started line kept; got:\n{o}");
		assert!(!o.contains("Initializing Spring"), "INFO chatter stripped; got:\n{o}");
		assert!(!o.contains("Bean 'dataSource'"), "bean chatter stripped; got:\n{o}");
		assert!(!o.contains(":: Spring Boot ::"), "banner stripped; got:\n{o}");
	}

	#[test]
	fn spring_boot_preserves_errors() {
		// rtk spring-boot.toml [[tests]] "preserves errors".
		let input = "  :: Spring Boot ::  (v3.2.0)\n2024-01-01 INFO Initializing Spring\n2024-01-01 \
		             ERROR Application run failed\nCaused by: java.lang.NullPointerException";
		let o = filter_spring_boot(input);
		assert!(o.contains("ERROR Application run failed"), "error kept; got:\n{o}");
		assert!(o.contains("Caused by: java.lang.NullPointerException"), "cause kept; got:\n{o}");
		assert!(!o.contains("Initializing Spring"), "INFO stripped; got:\n{o}");
	}

	#[test]
	fn spring_boot_routes_from_mvn_goal() {
		// detect_phase wiring: `mvn spring-boot:run` → SpringBootRun.
		assert_eq!(detect_phase("mvn spring-boot:run"), MvnPhase::SpringBootRun);
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let i = "  :: Spring Boot ::  (v3.2.0)\n2024-01-01 INFO Bean created\n2024-01-01 INFO \
		         Tomcat started on port 8080\n2024-01-01 INFO Started MyApp in 2.1 seconds\n";
		let out = filter(&ctx("mvn", "mvn spring-boot:run", &cfg), i, 0);
		assert!(out.changed, "spring-boot filter transformed output");
		assert!(out.text.contains("Tomcat started on port 8080"), "tomcat kept; got:\n{}", out.text);
		assert!(!out.text.contains("Bean created"), "INFO stripped; got:\n{}", out.text);
	}

	#[test]
	fn spring_boot_routes_from_gradle_boot_run() {
		// detect_task wiring: gradle `bootRun` → SpringBootRun.
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let i = "  :: Spring Boot ::  (v3.2.0)\n2024-01-01 INFO Bean created\n2024-01-01 ERROR \
		         Application run failed\nCaused by: java.lang.IllegalStateException\n";
		let out = filter(&ctx("gradlew", "gradlew bootRun", &cfg), i, 1);
		assert!(out.changed, "spring-boot filter transformed output");
		assert!(out.text.contains("ERROR Application run failed"), "error kept; got:\n{}", out.text);
		assert!(out.text.contains("Caused by:"), "cause kept; got:\n{}", out.text);
		assert!(!out.text.contains("Bean created"), "INFO stripped; got:\n{}", out.text);
	}

	#[test]
	fn spring_boot_savings() {
		let input = "  .   ____          _ \n  :: Spring Boot ::  (v3.2.0)\n2024-01-01 INFO \
		             Initializing\n2024-01-01 INFO Bean a\n2024-01-01 INFO Bean b\n2024-01-01 INFO \
		             Bean c\n2024-01-01 INFO Tomcat started on port 8080\n2024-01-01 INFO Started \
		             MyApp in 3.2 seconds";
		let o = filter_spring_boot(input);
		let savings = savings_pct(input, &o);
		assert!(savings >= 50.0, "spring-boot savings >=50%, got {savings:.1}%");
	}
}
