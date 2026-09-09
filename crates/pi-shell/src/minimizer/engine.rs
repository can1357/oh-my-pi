//! Minimizer pipeline: detect, dispatch, and fail-safe filter execution.

use std::{
	panic::{AssertUnwindSafe, catch_unwind},
	sync::{
		LazyLock,
		atomic::{AtomicU64, Ordering},
	},
};

use crate::minimizer::{
	MinimizerConfig, MinimizerCtx, MinimizerOutput, detect, filters,
	pipeline::{self, CompiledPipeline, PipelineRegistry},
	plan,
};
/// Captured outputs shorter than this are returned verbatim without filtering.
pub const MIN_MINIMIZE_CHARS: usize = 1_000;
fn is_below_minimize_threshold(captured: &str) -> bool {
	captured.chars().take(MIN_MINIMIZE_CHARS).count() < MIN_MINIMIZE_CHARS
}

/// Minimization strategy for a shell command.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MinimizerMode {
	/// Stream output unchanged.
	None,
	/// Capture the whole command and apply one filter to the whole buffer.
	WholeCommand,
	/// Execute a safe `&&` / `;` chain segment-by-segment.
	SegmentedChain,
}

/// Return the minimization mode for a command.
#[must_use]
pub fn mode_for(command: &str, config: &MinimizerConfig) -> MinimizerMode {
	match plan::analyze(command) {
		plan::CommandPlan::Single { .. } => {
			let Some(identity) = detect::detect(command) else {
				return MinimizerMode::None;
			};
			if identity_has_filter(&identity, config) {
				MinimizerMode::WholeCommand
			} else {
				MinimizerMode::None
			}
		},
		plan::CommandPlan::Chain { segments } => {
			// Only route a chain through the segmented runner when the minimizer is
			// enabled, the legacy kill-switch is off, at least one segment is
			// eligible, and no segment can permanently rewire the shell's own file
			// descriptors (`exec >out`). Any failed guard restores the pre-PR
			// single-exec passthrough behaviour.
			if config.enabled
				&& !config.legacy_filters_active()
				&& chain_has_eligible_segment(&segments, config)
				&& !chain_mutates_shell_fds(&segments)
			{
				MinimizerMode::SegmentedChain
			} else {
				MinimizerMode::None
			}
		},
		plan::CommandPlan::Compound | plan::CommandPlan::Piped | plan::CommandPlan::Unsupported => {
			MinimizerMode::None
		},
	}
}

/// Return true when the command should be captured for minimization.
#[must_use]
pub fn should_minimize(command: &str, config: &MinimizerConfig) -> bool {
	!matches!(mode_for(command, config), MinimizerMode::None)
}

/// Apply a matching filter to captured output.
///
/// Panics inside filters are caught and converted to pass-through output so
/// minimization can never be the reason a shell command loses output.
///
/// When a filter actually rewrites the text, the returned
/// [`MinimizerOutput`] carries the original buffer in `original_text` so the
/// JS session layer can persist it via its `ArtifactManager` and splice an
/// `artifact://<id>` reference back into the visible text before showing it
/// to the agent. The minimizer itself never formats the reference — ids are
/// assigned by the session store, not content-addressed.
#[must_use]
pub fn apply(
	command: &str,
	captured: &str,
	exit_code: i32,
	config: &MinimizerConfig,
) -> MinimizerOutput {
	let input_bytes = captured.len();

	if input_bytes > config.max_capture_bytes as usize {
		return MinimizerOutput::passthrough(captured).labeled("too-large");
	}

	// Structural guard: this whole-buffer path only handles single simple
	// commands. Safe chains are intentionally kept opaque here so the engine
	// can only segment them when the shell executes each piece separately.
	// Pipes can feed downstream parsers (awk, jq, rg, …), so rewriting their
	// combined output is a correctness bug.
	match plan::analyze(command) {
		plan::CommandPlan::Single { .. } => {},
		plan::CommandPlan::Chain { segments } => {
			return apply_chain(command, &segments, captured, exit_code, config);
		},
		plan::CommandPlan::Piped => {
			return MinimizerOutput::passthrough(captured).labeled("piped");
		},
		plan::CommandPlan::Compound => {
			return MinimizerOutput::passthrough(captured).labeled("compound");
		},
		plan::CommandPlan::Unsupported => {
			return MinimizerOutput::passthrough(captured).labeled("parse-error");
		},
	}

	let Some(identity) = detect::detect(command) else {
		record_unknown_command(command);
		return MinimizerOutput::passthrough(captured).labeled("unknown");
	};
	apply_identity(&identity, command, captured, exit_code, config)
}

/// Apply the whole-buffer dispatch path for a `Chain { segments }` plan.
///
/// The FFI whole-buffer entry point sees the entire chain's captured stdout
/// (interleaved across segments) — it cannot split it back into per-segment
/// slices. That makes the whole-buffer path fundamentally unable to minimize a
/// chain safely: every git renderer that condenses output (`condense_status`,
/// `compact_diff_output`, `condense_stash`, …) parses the buffer and rebuilds a
/// single synthetic result, so feeding it two segments' interleaved captures
/// produces output that never existed for any one command.
///
/// Concretely, `git -C a status && git -C b status` would let `condense_status`
/// overwrite `summary.branch` with the *last* repo and sum both repos'
/// clean/dirty counts into one fabricated status. The same multi-capture merge
/// corrupts same-subcommand `diff`/`stash`/`log`/… chains: none of these
/// renderers is associative over concatenated captures, and the whole-buffer
/// path has no way to attribute lines back to their originating segment.
///
/// Per-segment minimization (where each segment is captured in isolation and is
/// safe to route through its own filter) is handled separately by the segmented
/// chain runner. The whole-buffer path therefore stays opaque for every chain:
/// it preserves the captured bytes verbatim and labels the result `compound`.
///
/// Kill-switch parity (M2): `legacy_filters_active` also returns the opaque
/// passthrough so callers can rollback without recompile.
fn apply_chain(
	command: &str,
	segments: &[plan::ChainSegment],
	captured: &str,
	_exit_code: i32,
	_config: &MinimizerConfig,
) -> MinimizerOutput {
	let _ = (command, segments);
	MinimizerOutput::passthrough(captured).labeled("compound")
}

fn identity_has_filter(identity: &detect::CommandIdentity, config: &MinimizerConfig) -> bool {
	if !config.is_program_enabled(&identity.program) {
		return false;
	}

	let subcommand = identity.subcommand.as_deref();
	filters::supports(&identity.program, subcommand)
		|| resolve_pipeline(config, &identity.program, subcommand).is_some()
}

fn chain_has_eligible_segment(segments: &[plan::ChainSegment], config: &MinimizerConfig) -> bool {
	segments.iter().any(|segment| {
		detect::detect(&segment.command)
			.is_some_and(|identity| identity_has_filter(&identity, config))
			|| is_common_chain_utility(&segment.program)
	})
}

/// True when any segment can permanently rewire the shell's own file
/// descriptors. The segmented chain runner executes each segment in a fresh
/// capture context with its own stdout/stderr pipe, so fd mutations made by one
/// segment (e.g. `exec >out`, `exec 2>err`) are not honored by the segments
/// that follow: output the user redirected to a file would instead be captured
/// and returned to the caller. When such a segment is present we refuse to
/// segment and leave the chain opaque (passthrough), preserving the original
/// redirection semantics.
fn chain_mutates_shell_fds(segments: &[plan::ChainSegment]) -> bool {
	segments.iter().any(is_shell_fd_mutating_segment)
}

/// True when a segment's effective command can mutate the shell parse/runtime
/// environment in a way that segmented execution cannot preserve.
///
/// `exec` rewires fds; `eval` / `source` / `.` can introduce that opaquely;
/// `alias` / `unalias` change how later words in separate `run_string` calls
/// are expanded. Resolves the simple direct case from the parsed program word
/// first so quoted assignments such as `FOO="a b" exec >out` cannot fool the
/// fallback whitespace scan.
fn is_shell_fd_mutating_segment(segment: &plan::ChainSegment) -> bool {
	if is_shell_state_mutating_program(&segment.program) {
		return true;
	}
	if matches!(segment.program.as_str(), "command" | "builtin")
		&& command_wrapper_invokes_mutator(segment)
	{
		return true;
	}
	false
}

fn is_shell_state_mutating_program(program: &str) -> bool {
	matches!(program, "exec" | "eval" | "source" | "." | "alias" | "unalias")
}

fn command_wrapper_invokes_mutator(segment: &plan::ChainSegment) -> bool {
	for word in segment.command.split_whitespace() {
		if is_shell_state_mutating_program(word) {
			return true;
		}
		// A split quoted assignment means we are no longer looking at real shell
		// words. Stay opaque rather than proving safety from corrupted tokens.
		if is_ambiguous_assignment_fragment(word) {
			return true;
		}
		if word == "command" || word == "builtin" || word.starts_with('-') || is_env_assignment(word)
		{
			continue;
		}
		return false;
	}
	false
}

fn is_ambiguous_assignment_fragment(word: &str) -> bool {
	is_env_assignment(word) && (word.contains('"') || word.contains('\''))
}

/// True for a leading `KEY=value` environment assignment (a prefix that does
/// not change which command word ultimately runs).
fn is_env_assignment(word: &str) -> bool {
	word.split_once('=').is_some_and(|(key, _)| {
		!key.is_empty() && key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
	})
}

/// Common shell utilities that on their own would not warrant whole-command
/// minimization, but whose presence in a `&&` / `;` chain alongside other
/// segments is enough to fire the segmented chain runner. Each such segment
/// is captured and passes through `minimizer::apply` which will treat it as
/// `Single` with no matching filter and stream the text unchanged.
fn is_common_chain_utility(program: &str) -> bool {
	matches!(
		program,
		"echo"
			| "printf"
			| "head"
			| "tail"
			| "file"
			| "which"
			| "type"
			| "sed"
			| "awk"
			| "sleep"
			| "seq"
			| "cp" | "mv"
			| "rm" | "mkdir"
			| "rmdir"
			| "touch"
			| "basename"
			| "dirname"
			| "realpath"
			| "readlink"
			| "true"
			| "false"
			| "yes"
			| "tr" | "tee"
			| "sort"
			| "uniq"
			| "cut"
			| "paste"
			| "rev"
			| "split"
			| "comm"
			| "patch"
			| "xargs"
			| "unzip"
			| "zip"
			| "tar"
			| "gzip"
			| "gunzip"
			| "cd" | "pwd"
			| "export"
			| "env"
			| "test"
	)
}

fn apply_identity(
	identity: &detect::CommandIdentity,
	command: &str,
	captured: &str,
	exit_code: i32,
	config: &MinimizerConfig,
) -> MinimizerOutput {
	if !config.is_program_enabled(&identity.program) {
		return MinimizerOutput::passthrough(captured).labeled("disabled");
	}

	let subcommand = identity.subcommand.as_deref();

	if filters::supports(&identity.program, subcommand) {
		if is_below_minimize_threshold(captured) {
			return MinimizerOutput::passthrough(captured).labeled("too-short");
		}
		let ctx = MinimizerCtx { program: &identity.program, subcommand, command, config };
		let Ok(rust_output) =
			catch_unwind(AssertUnwindSafe(|| filters::filter(&ctx, captured, exit_code)))
		else {
			return MinimizerOutput::passthrough(captured)
				.labeled(program_label(&identity.program))
				.with_original(captured);
		};
		let label = program_label(&identity.program);
		let overlaid = apply_pipeline_overlay(
			config,
			&identity.program,
			subcommand,
			exit_code,
			rust_output,
			label,
		);
		return ensure_success_visible(overlaid, exit_code).with_original(captured);
	}

	if let Some(pipeline) = resolve_pipeline(config, &identity.program, subcommand) {
		if pipeline.skipped_by_exit(exit_code) {
			return MinimizerOutput::passthrough(captured).labeled("exit-skip");
		}
		if is_below_minimize_threshold(captured) {
			return MinimizerOutput::passthrough(captured).labeled("too-short");
		}
		let text = catch_unwind(AssertUnwindSafe(|| pipeline.apply(captured).into_owned()))
			.unwrap_or_else(|_| captured.to_string());
		if text == captured {
			return MinimizerOutput::passthrough(captured).labeled("pipeline-noop");
		}
		return ensure_success_visible(
			MinimizerOutput::transformed(text, captured.len()).labeled("pipeline"),
			exit_code,
		)
		.with_original(captured);
	}

	record_unknown_command(command);
	MinimizerOutput::passthrough(captured).labeled("unsupported")
}

fn ensure_success_visible(output: MinimizerOutput, exit_code: i32) -> MinimizerOutput {
	if exit_code == 0 && output.changed && output.text.trim().is_empty() {
		output.with_text("OK\n".to_string())
	} else {
		output
	}
}

/// Per-program label for telemetry. Returns one of a fixed static set so the
/// N-API boundary can carry it as `&'static str` without allocation.
fn program_label(program: &str) -> &'static str {
	match program {
		"git" => "git",
		"yadm" => "yadm",
		"gt" => "gt",
		"bun" => "bun",
		"bunx" => "bunx",
		"cargo" => "cargo",
		"go" => "go",
		"cmake" => "cmake",
		"ctest" => "ctest",
		"ninja" => "ninja",
		"gtest" => "gtest",
		"gtest-parallel" => "gtest",
		program if filters::cpp::is_gtest_binary_name(program) => "gtest",
		"golangci-lint" => "golangci-lint",
		"dotnet" => "dotnet",
		"mvn" | "mvnw" | "mvnw.cmd" => "mvn",
		"gradle" | "gradlew" | "gradlew.bat" => "gradle",
		"docker" => "docker",
		"kubectl" => "kubectl",
		"helm" => "helm",
		"gh" => "gh",
		"pytest" => "pytest",
		"ruff" => "ruff",
		"mypy" => "mypy",
		"python" => "python",
		"python3" => "python3",
		"rspec" => "rspec",
		"rake" => "rake",
		"rails" => "rails",
		"rubocop" => "rubocop",
		"rustfmt" => "rustfmt",
		"xxd" => "xxd",
		"strings" => "strings",
		"od" => "od",
		"tsc" => "tsc",
		"eslint" => "eslint",
		"biome" => "biome",
		"jest" => "jest",
		"vitest" => "vitest",
		"playwright" => "playwright",
		"npm" => "npm",
		"pnpm" => "pnpm",
		"yarn" => "yarn",
		"pip" => "pip",
		"pip3" => "pip3",
		"bundle" => "bundle",
		"brew" => "brew",
		"composer" => "composer",
		"uv" => "uv",
		"poetry" => "poetry",
		"aws" => "aws",
		"curl" => "curl",
		"wget" => "wget",
		"psql" => "psql",
		"ls" => "ls",
		"tree" => "tree",
		"find" => "find",
		"grep" => "grep",
		"rg" => "rg",
		"wc" => "wc",
		"cat" => "cat",
		"read" => "read",
		"stat" => "stat",
		"du" => "du",
		"df" => "df",
		"jq" => "jq",
		_ => "builtin",
	}
}

/// If a pipeline matches this program, re-apply it as an *overlay* on top of
/// the Rust filter's output. This lets users tune built-in filter results via
/// their settings TOML without replacing the underlying Rust logic.
fn apply_pipeline_overlay(
	config: &MinimizerConfig,
	program: &str,
	subcommand: Option<&str>,
	exit_code: i32,
	inner: MinimizerOutput,
	primary_label: &'static str,
) -> MinimizerOutput {
	let Some(pipeline) = resolve_pipeline(config, program, subcommand) else {
		return inner.labeled(primary_label);
	};
	if pipeline.skipped_by_exit(exit_code) {
		return inner.labeled(primary_label);
	}
	let text = catch_unwind(AssertUnwindSafe(|| pipeline.apply(&inner.text).into_owned()))
		.unwrap_or_else(|_| inner.text.clone());
	if text == inner.text {
		return inner.labeled(primary_label);
	}
	let output_bytes = text.len();
	MinimizerOutput {
		text,
		changed: true,
		input_bytes: inner.input_bytes,
		output_bytes,
		filter: "pipeline+builtin",
		original_text: inner.original_text,
	}
}

/// Find the first matching pipeline across user-defined + built-in registries.
fn resolve_pipeline<'a>(
	config: &'a MinimizerConfig,
	program: &str,
	subcommand: Option<&str>,
) -> Option<&'a CompiledPipeline> {
	if let Some(user) = config.user_pipelines.as_deref()
		&& let Some(pipeline) = user.find(program, subcommand)
	{
		return Some(pipeline);
	}
	builtin_pipelines().find(program, subcommand)
}

// Atomic counter for commands that reached `apply` without a matching filter.
static UNKNOWN_COMMAND_COUNT: AtomicU64 = AtomicU64::new(0);

// Per-thread mirror of the counter: integration tests drive `apply` from
// parallel tokio workers, so equality assertions on the process-wide atomic
// race. Tests assert on the calling thread's own recordings instead.
#[cfg(test)]
thread_local! {
	static THREAD_UNKNOWN_COMMAND_COUNT: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

fn record_unknown_command(_command: &str) {
	UNKNOWN_COMMAND_COUNT.fetch_add(1, Ordering::Relaxed);
	#[cfg(test)]
	THREAD_UNKNOWN_COMMAND_COUNT.with(|count| count.set(count.get() + 1));
}

/// Total number of commands that fell through `apply` without any matching
/// filter. Useful for a "coverage gap" indicator in telemetry dashboards.
pub fn unknown_command_count() -> u64 {
	UNKNOWN_COMMAND_COUNT.load(Ordering::Relaxed)
}

/// Unknown-command recordings made by the current thread. Race-free
/// alternative to [`unknown_command_count`] for test assertions.
#[cfg(test)]
fn thread_unknown_command_count() -> u64 {
	THREAD_UNKNOWN_COMMAND_COUNT.with(std::cell::Cell::get)
}

const BUILTIN_FILTERS_TOML: &str = include_str!(concat!(env!("OUT_DIR"), "/builtin_filters.toml"));

static BUILTIN_PIPELINES: LazyLock<PipelineRegistry> =
	LazyLock::new(|| match pipeline::parse_file(BUILTIN_FILTERS_TOML, "builtin") {
		Ok((pipelines, tests)) => PipelineRegistry { pipelines, tests },
		Err(err) => {
			eprintln!("[pi-natives minimizer] failed to load built-in filters: {err}");
			PipelineRegistry::default()
		},
	});

fn builtin_pipelines() -> &'static PipelineRegistry {
	&BUILTIN_PIPELINES
}

/// Expose the built-in registry's inline tests for the verify CLI surface.
#[must_use]
pub fn verify_builtin_filters() -> Vec<pipeline::TestOutcome> {
	pipeline::run_tests(builtin_pipelines())
}

#[cfg(test)]
fn minimizable_input(input: &str) -> String {
	let mut output = input.to_string();
	while output.chars().count() < MIN_MINIMIZE_CHARS {
		output.push('\n');
	}
	output
}

#[cfg(test)]
mod tests {
	use std::{
		fmt::Write as _,
		fs,
		sync::atomic::{AtomicUsize, Ordering},
	};

	static CONFIG_COUNTER: AtomicUsize = AtomicUsize::new(0);

	use super::*;
	use crate::minimizer::MinimizerOptions;
	fn config_from_settings(contents: &str) -> MinimizerConfig {
		let nonce = CONFIG_COUNTER.fetch_add(1, Ordering::Relaxed);
		let path = std::env::temp_dir()
			.join(format!("pi-shell-minimizer-engine-{}-{nonce}.toml", std::process::id()));
		fs::write(&path, contents).expect("write minimizer settings");
		let cfg = MinimizerConfig::from_options(&MinimizerOptions {
			enabled: Some(true),
			settings_path: Some(path.to_string_lossy().into_owned()),
			..Default::default()
		});
		let _ = fs::remove_file(path);
		cfg
	}

	#[test]
	fn output_below_minimum_is_not_minimized() {
		let cfg = config_from_settings(
			r#"
schema_version = 1
[filters.printf]
match_command = "^printf$"
replace = [{ pattern = "x", replacement = "y" }]
"#,
		);
		let short = "x".repeat(MIN_MINIMIZE_CHARS - 1);
		let exact = "x".repeat(MIN_MINIMIZE_CHARS);

		let short_result = apply("printf", &short, 0, &cfg);
		assert_eq!(short_result.text, short);
		assert!(!short_result.changed);
		assert_eq!(short_result.filter, "too-short");

		let exact_result = apply("printf", &exact, 0, &cfg);
		assert!(exact_result.changed);
		assert_ne!(exact_result.text, exact);
	}
	#[test]
	fn disabled_config_does_not_minimize() {
		let cfg = MinimizerConfig::default();
		assert!(!should_minimize("git status", &cfg));
		let out = apply("git status", "## main\n", 0, &cfg);
		assert!(!out.changed);
	}

	#[test]
	fn disabled_minimizer_and_disabled_program_do_not_transform_supported_command() {
		let input = "diff --git a/file.rs b/file.rs\n@@\n-old\n+new\n";

		let disabled = MinimizerConfig::default();
		assert!(!should_minimize("git diff", &disabled));
		let out = apply("git diff", input, 0, &disabled);
		assert!(!out.changed);
		assert_eq!(out.text, input);
		assert_eq!(out.filter, "disabled");

		let except_git = MinimizerConfig {
			enabled: true,
			except: std::iter::once("git".to_string()).collect(),
			..Default::default()
		};
		assert!(!should_minimize("git diff", &except_git));
		let out = apply("git diff", input, 0, &except_git);
		assert!(!out.changed);
		assert_eq!(out.text, input);
		assert_eq!(out.filter, "disabled");
	}

	#[test]
	fn pipeline_overlay_honors_subcommand_and_exit_gates() {
		let cfg = config_from_settings(
			r#"
schema_version = 1
[filters.git_diff_overlay]
match_command = "^git$"
match_subcommand = "^diff$"
strip_lines_matching = [".*"]
on_empty = "OVERLAY"
only_on_exit = [0]
"#,
		);
		let diff_input = minimizable_input("diff --git a/file.rs b/file.rs\n@@\n-old\n+new\n");
		let diff = apply("git diff", &diff_input, 0, &cfg);
		assert_eq!(diff.filter, "pipeline+builtin");
		assert_eq!(diff.text, "OVERLAY");

		let status_input = minimizable_input("## main\n M file.rs\n");
		let status = apply("git status", &status_input, 0, &cfg);
		assert_ne!(status.filter, "pipeline+builtin");
		assert!(status.text.contains("unstaged 1"));

		let failed = apply("git diff", &diff_input, 1, &cfg);
		assert_ne!(failed.filter, "pipeline+builtin");
		assert!(failed.text.contains("file changed"));
	}

	// Regression guards for the builtin npx catch-all def (defs/npx.toml). Its
	// `match_subcommand` must exclude every subcommand owned/routed elsewhere so
	// it cannot shadow `nx-wrapped` (standalone path) or overlay the Rust
	// lint/test filters (overlay path). These tests fail loudly if that
	// exclusion set ever desyncs from filters::supports's npx routing.
	#[test]
	fn npx_def_does_not_shadow_nx_wrapped() {
		// `npx nx` is NOT routed by filters::supports, so apply_identity falls to
		// the standalone resolve_pipeline branch. nx-wrapped (nx.toml) must win
		// and strip the NX banner; the bare npx def must not claim subcommand
		// `nx`.
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let input = minimizable_input(
			"\n >  NX   Running target build for 3 projects\n\n> nx run app:build\nError: build \
			 failed\n\n >  NX   Ran target build for 3 projects (2s)\n",
		);
		let out = apply("npx nx build", &input, 0, &cfg);
		assert!(
			!out.text.contains("NX   Running target"),
			"npx def shadowed nx-wrapped; NX banner survived: {:?}",
			out.text
		);
		assert!(out.text.contains("Error: build failed"));
	}
	#[test]
	fn npx_def_does_not_overlay_routed_eslint() {
		// `npx eslint` IS routed by filters::supports, so the Rust lint filter
		// runs and apply_pipeline_overlay re-selects a matching pipeline. The npx
		// def must NOT match subcommand `eslint`, so no overlay re-applies its
		// max_lines/strip on top of the lint diagnostics. Output must equal the
		// direct `eslint` invocation (same filter label, not "pipeline+builtin").
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let mut input = String::new();
		for i in 0..120 {
			let _ = writeln!(input, "/src/file{i}.ts:{i}:1  error  Something is wrong  rule/name");
		}
		let npx = apply("npx eslint src/", &input, 1, &cfg);
		let direct = apply("eslint src/", &input, 1, &cfg);
		// Label differs by program token (npx -> "builtin", eslint -> "eslint"),
		// but it must NOT be the overlay label and the TEXT must be the un-mutated
		// lint output — same lines, no max_lines truncation.
		assert_ne!(
			npx.filter, "pipeline+builtin",
			"npx def overlaid the routed eslint filter output"
		);
		assert_eq!(
			npx.text, direct.text,
			"npx eslint output diverged from direct eslint (overlay mutated it)"
		);
	}
	#[test]
	fn npx_def_fires_for_unknown_tool() {
		// The def must still strip the install preamble / npm warn/notice noise
		// for genuinely UNKNOWN tools (its whole purpose). cowsay is not routed
		// or owned by any other def, so the npx pipeline claims it.
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let input = minimizable_input(
			"Need to install the following packages:\ncowsay@1.6.0\nOk to proceed? (y)\n\nnpm warn \
			 deprecated foo@1.0.0: use bar instead\n< Hello >\n",
		);
		let out = apply("npx cowsay hello", &input, 0, &cfg);
		assert!(out.changed);
		assert!(!out.text.contains("Need to install"));
		assert!(!out.text.contains("Ok to proceed"));
		assert!(!out.text.contains("npm warn"));
		assert!(out.text.contains("< Hello >"));
	}

	#[test]
	fn enabled_known_filter_minimizes() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		assert!(should_minimize("git diff", &cfg));
		let input = minimizable_input("diff --git a/file.rs b/file.rs\n@@\n-old\n+new\n");
		let out = apply("git diff", &input, 0, &cfg);
		assert!(out.changed);
		assert!(out.text.contains("file changed"));
	}

	#[test]
	fn enabled_config_minimizes_git_status() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		assert!(should_minimize("git status", &cfg));
		let input = minimizable_input("## main\n M file.rs\n");
		let out = apply("git status", &input, 0, &cfg);
		assert!(out.changed);
		assert!(out.text.contains("unstaged 1"));
		assert_eq!(out.filter, "git");
	}

	#[test]
	fn successful_minimization_keeps_visible_ok_when_filter_removes_all_lines() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let input = format!(
			"{}    Finished `dev` profile [unoptimized + debuginfo] target(s) in 1.23s\n",
			"   Compiling app v0.1.0\n".repeat(200),
		);
		let out = apply("cargo build", &input, 0, &cfg);

		assert!(out.changed);
		assert_eq!(out.text, "OK\n");
		assert_eq!(out.output_bytes, out.text.len());
		assert!(out.original_text.is_some());
	}

	#[test]
	fn rustc_query_output_is_not_collapsed_to_ok() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let input = "/opt/rust/lib/rustlib\n";
		let out = apply("rustc --print sysroot", input, 0, &cfg);

		assert_eq!(out.text, input);
		assert!(!out.changed);
	}

	#[test]
	fn successful_user_pipeline_empty_output_returns_visible_ok() {
		let cfg = config_from_settings(
			r#"
schema_version = 1
[filters.empty_ok]
match_command = "^printf$"
strip_lines_matching = [".*"]
"#,
		);

		let input = minimizable_input("drop me\n");
		let out = apply("printf done", &input, 0, &cfg);

		assert!(out.changed);
		assert_eq!(out.text, "OK\n");
		assert_eq!(out.filter, "pipeline");
		assert_eq!(out.output_bytes, out.text.len());
		assert_eq!(out.original_text.as_deref(), Some(input.as_str()));
	}

	#[test]
	fn failed_minimization_does_not_invent_ok_for_empty_output() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let input = "   Compiling app v0.1.0\n".repeat(200);
		let out = apply("cargo build", &input, 1, &cfg);

		assert!(out.changed);
		assert_eq!(out.text, "");
		assert!(out.original_text.is_some());
	}

	#[test]
	fn unknown_command_is_passthrough() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		assert!(!should_minimize("echo hello", &cfg));
		let out = apply("echo hello", "hello\n", 0, &cfg);
		assert_eq!(out.text, "hello\n");
		assert!(!out.changed);
	}

	#[test]
	fn segmented_chain_mode_is_only_for_eligible_safe_chains() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		assert_eq!(
			mode_for("git diff --stat && git diff --name-only", &cfg),
			MinimizerMode::SegmentedChain
		);
		assert_eq!(mode_for("git diff ; printf done", &cfg), MinimizerMode::SegmentedChain);
		// Common shell utilities make a chain eligible for the segmented runner
		// even when no segment has a dedicated filter — segments stream through
		// per-segment passthrough so the chain itself is captured for telemetry.
		assert_eq!(mode_for("false && echo no ; echo yes", &cfg), MinimizerMode::SegmentedChain);
		assert_eq!(mode_for("foo || bar", &cfg), MinimizerMode::None);
		assert_eq!(mode_for("git status | cat", &cfg), MinimizerMode::None);
		assert_eq!(mode_for("sleep 1 &", &cfg), MinimizerMode::None);
		assert_eq!(mode_for("(cd foo && make)", &cfg), MinimizerMode::None);
	}

	#[test]
	fn segmented_chain_supported_command_does_not_record_unknown() {
		// Phase 7 (Mode α resolution): supported chains route through
		// filters::dispatch via the chain decomposer instead of falling
		// back to passthrough. The unknown-command counter must remain
		// stable — the chain entry point is structurally known. Asserted on
		// this thread's recordings: parallel integration tests legitimately
		// bump the process-wide counter.
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let input = "diff --git a/file.rs b/file.rs\n@@\n-old\n+new\n";
		let before = thread_unknown_command_count();

		assert_eq!(mode_for("git diff ; printf done", &cfg), MinimizerMode::SegmentedChain);
		let out = apply("git diff ; printf done", input, 0, &cfg);

		// Whole-buffer entry: a mixed chain (`git diff` + `printf`) stays opaque
		// rather than running the git filter over the interleaved capture. The
		// chain entry point is still structurally known, so no unknown-command is
		// recorded (per-segment minimization is the segmented runner's job).
		assert!(!out.changed, "mixed chain must stay passthrough in whole-buffer minimization");
		assert_eq!(out.filter, "compound");
		assert_eq!(thread_unknown_command_count(), before);
	}

	#[test]
	fn cpp_tools_minimize_through_dispatch() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		assert!(should_minimize("ctest --output-on-failure", &cfg));
		assert!(should_minimize("./build/foo_test --gtest_filter=Foo.*", &cfg));

		let ctest_input = minimizable_input(
			"Test project /tmp/build\n1/2 Test #1: ok ........   Passed    0.01 sec\n2/2 Test #2: \
			 bad .......***Failed    0.02 sec\nThe following tests FAILED:\n",
		);
		let ctest = apply("ctest --output-on-failure", &ctest_input, 8, &cfg);
		assert!(ctest.changed);
		assert_eq!(ctest.filter, "ctest");
		assert!(!ctest.text.contains("Test #1"));
		assert!(ctest.text.contains("Test #2: bad"));

		let gtest_input = minimizable_input(
			"[ RUN      ] Foo.Pass\n[       OK ] Foo.Pass (0 ms)\nfoo_test.cc:42: Failure\nExpected: \
			 1\n[  FAILED  ] Foo.Fails\n",
		);
		let gtest = apply("./build/foo_test", &gtest_input, 1, &cfg);
		assert!(gtest.changed);
		assert_eq!(gtest.filter, "gtest");
		assert!(!gtest.text.contains("Foo.Pass"));
		assert!(gtest.text.contains("foo_test.cc:42: Failure"));
	}

	#[test]
	fn git_status_chain_stays_opaque() {
		// `condense_status` rebuilds a single synthetic status from the whole
		// buffer: it keeps only the last `On branch …` it sees and sums every
		// segment's clean/dirty counts. For `git -C a status && git -C b status`
		// that fabricates one status that never existed for either repo, so the
		// whole-buffer path must stay opaque and preserve the captured bytes.
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let input = "On branch feature-a\n M a.rs\nOn branch feature-b\n M b.rs\n";
		let out = apply("git -C a status && git -C b status", input, 0, &cfg);
		assert!(!out.changed, "same-subcommand status chain must stay passthrough");
		assert_eq!(out.filter, "compound");
		assert_eq!(out.text, input, "captured output must be preserved verbatim");
		// Both repos' branch headers survive — no synthetic merged status.
		assert!(out.text.contains("feature-a") && out.text.contains("feature-b"));
	}

	#[test]
	fn git_commit_chain_differing_actions_stays_opaque() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let input = "On branch main\nChanges to be committed:\n  modified: src/lib.rs\n[main \
		             abc1234] init\n 1 file changed, 1 insertion(+)\n";
		let out = apply("git commit --dry-run && git commit -m init", input, 0, &cfg);
		assert!(!out.changed, "commit actions share a subcommand but not an output contract");
		assert_eq!(out.filter, "compound");
		assert_eq!(out.text, input);
	}

	#[test]
	fn git_only_chain_differing_subcommands_stays_opaque() {
		// `git status && git log` must NOT route the whole buffer through one
		// subcommand filter: `condense_status` rebuilds output from its own parse
		// and would silently drop the `git log` segment's lines. Stay opaque and
		// preserve the captured output verbatim.
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let input = "## main\n M file.rs\n";
		let out = apply("git status && git log -1", input, 0, &cfg);
		assert!(!out.changed, "differing-subcommand git chain must stay passthrough");
		assert_eq!(out.filter, "compound");
		assert_eq!(out.text, input, "captured output must be preserved verbatim");
	}

	#[test]
	fn git_diff_chain_differing_formats_stays_opaque() {
		// `git diff --name-only && git diff --stat` share the `diff` subcommand but
		// select incompatible renderers. Routing the combined buffer through one
		// (the whole-chain command carries BOTH `--name-only` and `--stat`, so the
		// diff filter would treat it as a stat buffer) corrupts the listing
		// segment's output. Diverging diff formats must stay opaque.
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let input =
			"src/a.rs\nsrc/b.rs\n src/a.rs | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n";
		let out = apply("git diff --name-only && git diff --stat", input, 0, &cfg);
		assert!(!out.changed, "differing diff formats must stay passthrough");
		assert_eq!(out.filter, "compound");
		assert_eq!(out.text, input, "captured output must be preserved verbatim");
	}

	#[test]
	fn git_diff_chain_same_format_stays_opaque() {
		// Even same-format diff chains stay opaque on the whole-buffer path: the
		// renderer parses the combined buffer and rebuilds one summary, with no
		// way to attribute files back to each segment's repo/ref. `git -C a diff
		// && git -C b diff` would merge both repos into one fabricated stat, so
		// the captured bytes must be preserved verbatim.
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let mut listing = String::new();
		for i in 0..30 {
			use std::fmt::Write as _;
			let _ = writeln!(listing, "src/file{i}.rs");
		}
		let out = apply("git diff --name-only && git diff --name-only HEAD~1", &listing, 0, &cfg);
		assert!(!out.changed, "same-format diff chain must stay passthrough");
		assert_eq!(out.filter, "compound");
		assert_eq!(out.text, listing, "captured output must be preserved verbatim");
	}

	#[test]
	fn git_diff_raw_and_default_diff_stays_opaque() {
		// `git diff --raw && git diff` share the `diff` subcommand but have
		// incompatible output formats (raw vs unified). They MUST get distinct
		// format keys so the chain stays opaque.
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let input = ":100644 100644 12345... abcde... M\tsrc/a.rs\n diff --git a/src/a.rs \
		             b/src/a.rs\nindex abc..def 100644\n--- a/src/a.rs\n+++ b/src/a.rs\n@@ -1 +1 \
		             @@\n-old\n+new\n";
		let out = apply("git diff --raw && git diff", input, 0, &cfg);
		assert!(!out.changed, "raw+unified diff must stay opaque");
		assert_eq!(out.filter, "compound");
		assert_eq!(out.text, input, "captured output must be preserved verbatim");
	}

	#[test]
	fn git_diff_summary_and_default_diff_stays_opaque() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let input = " create mode 100644 src/a.rs\n delete mode 100644 src/b.rs\n";
		let out = apply("git diff --summary && git diff", input, 0, &cfg);
		assert!(!out.changed, "summary+unified diff must stay opaque");
		assert_eq!(out.filter, "compound");
	}

	#[test]
	fn git_diff_check_and_default_diff_stays_opaque() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let input = "src/a.rs:1: leftover conflict marker\n";
		let out = apply("git diff --check && git diff", input, 0, &cfg);
		assert!(!out.changed, "check+unified diff must stay opaque");
		assert_eq!(out.filter, "compound");
	}

	#[test]
	fn git_diff_same_raw_format_stays_opaque() {
		// Same subcommand AND same raw format still stays opaque on the
		// whole-buffer path: like every git chain here, the combined capture
		// cannot be attributed back to each segment, so it is preserved verbatim.
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let input = ":100644 100644 12345... abcde... M\tsrc/a.rs\n:100644 100644 67890... fghij... \
		             M\tsrc/b.rs\n";
		let out = apply("git diff --raw && git diff --raw HEAD~1", input, 0, &cfg);
		assert!(!out.changed, "same-raw-format diff chain must stay passthrough");
		assert_eq!(out.filter, "compound");
		assert_eq!(out.text, input, "captured output must be preserved verbatim");
	}
	#[test]
	fn mixed_chain_stays_opaque_in_whole_buffer_minimization() {
		// A mixed chain (`git status` + unrelated `echo`) must NOT route the whole
		// interleaved capture through the first segment's filter: `condense_status`
		// rebuilds from its own parse and would drop the `echo` segment's output.
		// Stay opaque and preserve the captured bytes verbatim.
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let input = "## main\n M file.rs\nIMPORTANT side-effect line\n";
		let out = apply("git status && echo IMPORTANT side-effect line", input, 0, &cfg);
		assert!(!out.changed, "mixed chain must stay passthrough");
		assert_eq!(out.filter, "compound");
		assert_eq!(out.text, input, "captured output must be preserved verbatim");
		assert!(out.text.contains("IMPORTANT side-effect line"));
	}

	#[test]
	fn unsupported_first_segment_chain_is_passthrough() {
		// Phase 7: chains whose first segment has no filter fall back to
		// passthrough labeled "compound" (preserves legacy behavior).
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let out = apply("zzzobscure && zzznever", "noise\n", 0, &cfg);
		assert!(!out.changed);
		assert_eq!(out.filter, "compound");
	}

	#[test]
	fn chain_legacy_filters_active_passes_through() {
		// Phase 7 kill-switch parity (M2): legacy_filters_active=true returns
		// passthrough.labeled("compound") regardless of segment shape.
		let cfg =
			MinimizerConfig { enabled: true, legacy_filters_active: true, ..Default::default() };
		let input = "## main\n M file.rs\n";
		let out = apply("git status && git log -1", input, 0, &cfg);
		assert!(!out.changed);
		assert_eq!(out.filter, "compound");
	}

	#[test]
	fn legacy_filters_active_disables_segmented_chain() {
		// Kill-switch parity: with the legacy filters flag set, an otherwise
		// eligible safe chain must NOT route through the segmented runner so
		// pre-segmentation single-exec behavior is restored.
		let mut cfg = MinimizerConfig { enabled: true, ..Default::default() };
		cfg.legacy_filters_active = true;
		assert_eq!(mode_for("git diff --stat && git diff --name-only", &cfg), MinimizerMode::None);
		assert_eq!(mode_for("git diff ; printf done", &cfg), MinimizerMode::None);
	}

	#[test]
	fn disabled_config_does_not_segment_chain() {
		// With the master switch off, no chain is segmented even when a segment
		// would otherwise be eligible.
		let cfg = MinimizerConfig::default();
		assert!(!cfg.enabled);
		assert_eq!(mode_for("git diff ; printf done", &cfg), MinimizerMode::None);
	}

	#[test]
	fn chains_with_exec_fd_mutation_are_not_segmented() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		// `exec >out` rewires the shell's stdout; segmenting would run the
		// following segment with a fresh capture pipe and lose the redirection,
		// returning output to the caller that should have gone to the file.
		assert_eq!(mode_for("exec >out ; echo hi", &cfg), MinimizerMode::None);
		assert_eq!(mode_for("exec 2>err ; git status", &cfg), MinimizerMode::None);
		// The fd-mutating segment poisons the chain even when it is not first.
		assert_eq!(mode_for("git status ; exec >out", &cfg), MinimizerMode::None);
		// `exec` wrapped by `command`/`builtin` (with flags or env assignments)
		// mutates the same fds and must also block segmentation.
		assert_eq!(mode_for("command exec >out ; echo hi", &cfg), MinimizerMode::None);
		assert_eq!(mode_for("builtin exec >out ; echo hi", &cfg), MinimizerMode::None);
		assert_eq!(mode_for("git diff ; command -p exec 2>err", &cfg), MinimizerMode::None);
		assert_eq!(mode_for("FOO=\"a b\" exec >out ; echo hi", &cfg), MinimizerMode::None);
		assert_eq!(mode_for("FOO=\"a b\" command exec >out ; echo hi", &cfg), MinimizerMode::None);
		// Alias mutations affect later words when segments are parsed in separate
		// calls, so they must stay on the original single-parse path too.
		assert_eq!(mode_for("alias cat='printf hacked' ; cat file", &cfg), MinimizerMode::None);
		assert_eq!(mode_for("unalias cat ; cat file", &cfg), MinimizerMode::None);
		// A real command merely named with `exec` as an argument is not the
		// builtin and must NOT block segmentation.
		assert_eq!(mode_for("echo exec ; printf done", &cfg), MinimizerMode::SegmentedChain);
		// Such chains pass through untouched.
		let out = apply("exec >out ; echo hi", "hi\n", 0, &cfg);
		assert_eq!(out.text, "hi\n");
		assert!(!out.changed);
	}

	// ── Rails def standalone + bundle exec re-dispatch guards ────────

	#[test]
	fn rails_db_migrate_routes_to_standalone_def() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let input = minimizable_input(
			"== 20240115 CreateUsers: migrating\n-- create_table(:users)\n   -> 0.0234s\n== 20240115 \
			 CreateUsers: migrated\n\n== 20240116 AddIndexToOrders: migrating\n-- \
			 add_index(:orders)\n   -> 0.0123s\n== 20240116 AddIndexToOrders: migrated\n",
		);
		let out = apply("rails db:migrate", &input, 0, &cfg);
		assert!(out.changed);
		assert!(out.text.contains("✓ CreateUsers"));
		assert!(out.text.contains("✓ AddIndexToOrders"));
		assert!(!out.text.contains("-- create_table"));
		assert!(!out.text.contains("-> 0.0234s"));
		// Must NOT be an overlay label; standalone pipeline gets "pipeline".
		assert_eq!(out.filter, "pipeline");
	}

	#[test]
	fn rails_routes_routes_to_standalone_def() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let input = minimizable_input(
			"                                  Prefix Verb   URI Pattern                                                                                       Controller#Action\n                                    root GET    /                                                                                                 home#index\n",
		);
		let out = apply("rails routes", &input, 0, &cfg);
		assert!(out.changed);
		assert!(!out.text.contains("Prefix"));
		assert!(out.text.contains("root GET"));
		assert_eq!(out.filter, "pipeline");
	}

	#[test]
	fn rake_routes_regression_unminimized() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let input = minimizable_input(
			"                                  Prefix Verb   URI Pattern                                                                                       Controller#Action\n                                    root GET    /                                                                                                 home#index\n",
		);
		let out = apply("rake routes", &input, 0, &cfg);
		assert!(out.changed, "rake routes should be minimized by the rails-routes def");
		assert!(!out.text.contains("Prefix"));
		assert!(out.text.contains("root GET"));
	}

	#[test]
	fn bundle_exec_rails_db_migrate_reaches_def() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let input = minimizable_input(
			"== 20240115 CreateUsers: migrating\n-- create_table(:users)\n   -> 0.0234s\n== 20240115 \
			 CreateUsers: migrated\n",
		);
		let out = apply("bundle exec rails db:migrate", &input, 0, &cfg);
		assert!(out.changed);
		assert!(out.text.contains("CreateUsers"));
		assert!(!out.text.contains("-- create_table"));
	}

	#[test]
	fn bundle_exec_rails_routes_reaches_def() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let input = minimizable_input(
			"                                  Prefix Verb   URI Pattern                                                                                       Controller#Action\n                                    root GET    /                                                                                                 home#index\n",
		);
		let out = apply("bundle exec rails routes", &input, 0, &cfg);
		assert!(out.changed);
		assert!(!out.text.contains("Prefix"));
		assert!(out.text.contains("root GET"));
	}

	#[test]
	fn rails_db_migrate_no_double_truncation() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let mut input = String::new();
		for i in 0..100 {
			let _ = write!(
				input,
				"== 20240115 Migration{i}: migrating\n-- step\n   -> 0.0s\n== 20240115 Migration{i}: \
				 migrated\n\n"
			);
		}
		let out = apply("rails db:migrate", &input, 0, &cfg);
		assert!(out.changed);
		// Only the def's max_lines=40 cap should fire; filter_rake's head_tail must
		// NOT also condense. Both now emit `[…Nln elided…]`, so a single marker
		// proves no double truncation (two would mean both stages fired).
		assert_eq!(
			out.text.matches("ln elided…]").count(),
			1,
			"double truncation detected: {:#?}",
			out.text
		);
	}

	#[test]
	fn rails_db_migrate_keyword_in_name_not_dropped() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let input = minimizable_input(
			"== 20240115 CreateTestResults: migrating\n-- create_table(:test_results)\n   -> \
			 0.0234s\n== 20240115 CreateTestResults: migrated\n\n== 20240116 AddIndexToOrders: \
			 migrating\n-- add_index(:orders)\n   -> 0.0123s\n== 20240116 AddIndexToOrders: \
			 migrated\n",
		);
		let out = apply("rails db:migrate", &input, 0, &cfg);
		assert!(out.changed);
		// Both migrations must survive; the old overlay-on-rake would keep only
		// lines containing "test" and silently drop AddIndexToOrders.
		assert!(out.text.contains("CreateTestResults"), "CreateTestResults was dropped");
		assert!(out.text.contains("AddIndexToOrders"), "AddIndexToOrders was dropped");
	}

	// Regression guards for the builtin rails defs (rails-migrate.toml,
	// rails-routes.toml). Their `match_subcommand` scopes are MANDATORY:
	// unscoped they would overlay the Rust minitest filter output for
	// `rails test` / `rake test` and strip failure-detail lines
	// ('Expected: true'). These tests fail loudly if the scope is removed.
	#[test]
	fn rails_def_does_not_overlay_routed_minitest() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let input = "Run options: --seed 1\n\n# Running:\n\n.F\n\n  1) Failure:\nUserTest#test_name \
		             [test/models/user_test.rb:8]:\nExpected: true\n  Actual: false\n\n2 runs, 2 \
		             assertions, 1 failures, 0 errors, 0 skips\n";
		let rails = apply("rails test", input, 1, &cfg);
		let rake = apply("rake test", input, 1, &cfg);
		// Must NOT be an overlay label; minitest filter gets its own program label.
		assert_ne!(
			rails.filter, "pipeline+builtin",
			"rails-migrate def overlaid the routed minitest filter output"
		);
		assert_ne!(
			rake.filter, "pipeline+builtin",
			"rails-migrate def overlaid the routed minitest filter output"
		);
		// Failure-detail lines must survive — the rails-migrate def's
		// keep_lines_matching would drop them.
		assert!(rails.text.contains("Expected: true"), "rails test dropped minitest failure detail");
		assert!(rails.text.contains("Actual: false"));
		assert!(rake.text.contains("Expected: true"), "rake test dropped minitest failure detail");
		assert!(rake.text.contains("Actual: false"));
	}

	#[test]
	fn rails_routes_def_does_not_overlay_routed_minitest() {
		// Same guard for rails-routes.toml: `match_subcommand = "^routes$"`
		// must not leak to `rails test`.
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let input = "Run options: --seed 1\n\n# Running:\n\n.F\n\n  1) Failure:\nUserTest#test_name \
		             [test/models/user_test.rb:8]:\nExpected: true\n  Actual: false\n\n2 runs, 2 \
		             assertions, 1 failures, 0 errors, 0 skips\n";
		let out = apply("rails test", input, 1, &cfg);
		assert_ne!(
			out.filter, "pipeline+builtin",
			"rails-routes def overlaid the routed minitest filter output"
		);
		assert!(out.text.contains("Expected: true"), "rails test dropped minitest failure detail");
	}
}

#[cfg(test)]
mod pipeline_integration_tests {
	use super::*;
	use crate::minimizer::MinimizerOptions;

	#[test]
	fn builtin_filters_parse_and_pass_inline_tests() {
		let outcomes = verify_builtin_filters();
		let failures: Vec<_> = outcomes.iter().filter(|o| !o.passed).collect();
		assert!(
			failures.is_empty(),
			"{} built-in inline tests failed:\n{}",
			failures.len(),
			failures
				.iter()
				.map(|f| format!(
					" - [{}/{}] expected {:?}, got {:?}",
					f.filter_name, f.test_name, f.expected, f.actual
				))
				.collect::<Vec<_>>()
				.join("\n")
		);
		assert!(!outcomes.is_empty(), "expected built-in inline tests");
	}

	#[test]
	fn gradle_routes_to_jvm_filter_via_apply() {
		let cfg = MinimizerConfig::from_options(&MinimizerOptions {
			enabled: Some(true),
			..Default::default()
		});
		let input = minimizable_input(
			"> Task :app:compileJava UP-TO-DATE\n> Task :app:test\nBUILD SUCCESSFUL in 8s\n",
		);
		let out = apply("gradle build", &input, 0, &cfg);
		// gradle.toml is deleted; gradle now dispatches to the Rust jvm Build
		// filter, which strips `> Task :…UP-TO-DATE` task-progress noise (the
		// carried-over defs/gradle.toml behaviour, now as a Rust filter — NOT a
		// TOML pipeline) and keeps the BUILD status.
		assert!(out.changed, "gradle build filter strips task-progress noise");
		assert!(out.text.contains("BUILD SUCCESSFUL"));
		assert!(!out.text.contains("> Task :"), "task lines stripped; got:\n{}", out.text);
		assert_eq!(out.filter, "gradle", "telemetry label routes through jvm program_label");
	}

	#[test]
	fn too_large_input_is_passthrough() {
		let cfg = MinimizerConfig::from_options(&MinimizerOptions {
			enabled: Some(true),
			max_capture_bytes: Some(1024),
			..Default::default()
		});
		let big = "x".repeat(2048);
		let out = apply("git status", &big, 0, &cfg);
		assert!(!out.changed);
		assert_eq!(out.filter, "too-large");
	}

	#[test]
	fn unknown_command_counter_increments() {
		let cfg = MinimizerConfig::from_options(&MinimizerOptions {
			enabled: Some(true),
			..Default::default()
		});
		let global_before = unknown_command_count();
		let thread_before = thread_unknown_command_count();
		let _ = apply("zzzobscurecmd foo", "hi\n", 0, &cfg);
		// Exact accounting on this thread; monotonic advance on the public
		// process-wide counter (other threads may add, never subtract).
		assert_eq!(thread_unknown_command_count(), thread_before + 1);
		assert!(
			unknown_command_count() > global_before,
			"counter should advance for unknown commands"
		);
	}
}
