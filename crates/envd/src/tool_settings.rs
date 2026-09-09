//! Typed settings owned by production tool admission and registry composition.

use std::{collections::BTreeMap, path::PathBuf};

use omp_cache::github_cache::GithubCachePolicy;
use omp_con::{Ctx, Kv, Span, Value};
use omp_core::{Duration, Str};
use omp_tool::Effects;
use omp_tools::edit::FormatPolicy;
use serde::{Deserialize, Deserializer, Serialize, Serializer, de};

/// Runtime posture for automatic tool-admission decisions.
pub use super::admission::ApprovalMode;
use super::admission::{ApprovalPolicy, ResolvedApproval, resolve_approval};

omp_con::con_enum!(ApprovalMode);

omp_con::var! {
	/// Per-tool availability overrides.
	pub static SV_TOOLS_ENABLED = sv_tools_enabled: Kv {
		default: Kv::new(),
		validate: |_ctx, values| validate_bool_map(values),
		flags: archive,
		meta: {
			"legacy.path": "tools.enabled",
		},
	};
	/// Maximum timeout the agent can set for any tool; `never` removes the limit.
	pub static SV_TOOLS_MAX_TIMEOUT = sv_tools_max_timeout: Span {
		default: Span::NEVER,
		flags: archive,
		meta: {
			"ui.tab": "tools",
			"ui.group": "Execution",
			"ui.label": "Max Tool Timeout",
			"ui.unit": "s",
			"legacy.path": "tools.max_timeout",
			"legacy.path": "tools.maxTimeout",
		},
	};
	/// Select the edit tool revision; empty selects the route default.
	pub static SV_TOOLS_EDIT_DIALECT = sv_tools_edit_dialect: Str {
		default: Str::default(),
		suggest: ["hl.1", "rep.2", "patch.2", "apply_patch.1", "sloppy.1"],
		flags: archive,
		meta: {
			"ui.tab": "files",
			"ui.group": "Editing",
			"ui.label": "Edit Mode",
			"ui.option.hl.1": "Hashline",
			"ui.option.rep.2": "Replace",
			"ui.option.patch.2": "Patch",
			"ui.option.apply_patch.1": "Apply Patch",
			"ui.option.sloppy.1": "Sloppy",
			"legacy.path": "tools.edit_dialect",
			"legacy.path": "edit.mode",
		},
	};
	/// Append full before and after source when an edit introduces an AST parse failure.
	pub static SV_TOOLS_EDIT_BLACKBOX_ENABLED = sv_tools_edit_blackbox_enabled: bool {
		default: false,
		flags: archive,
		meta: {
			"ui.tab": "files",
			"ui.group": "Editing",
			"ui.label": "Record Parse Regressions",
			"legacy.path": "edit.blackbox.enabled",
		},
	};
	/// Optional JSONL destination for edit black-box diagnostics.
	pub static SV_TOOLS_EDIT_BLACKBOX_PATH = sv_tools_edit_blackbox_path: Str {
		default: Str::default(),
		flags: archive,
		meta: {
			"legacy.path": "tools.edit_blackbox_path",
		},
	};
	/// When an edit breaks a file's AST parse, ask the smol model to repair the broken region.
	pub static SV_TOOLS_EDIT_AUTO_REPAIR = sv_tools_edit_auto_repair: bool {
		default: false,
		flags: archive,
		meta: {
			"ui.tab": "files",
			"ui.group": "Editing",
			"ui.label": "Auto-Repair Parse Regressions",
			"legacy.path": "tools.edit_auto_repair",
			"legacy.path": "edit.autoRepair.enabled",
		},
	};
	/// Abort streaming edit tool calls when patch preview fails.
	pub static SV_TOOLS_EDIT_STREAMING_ABORT = sv_tools_edit_streaming_abort: bool {
		default: false,
		flags: archive,
		meta: {
			"ui.tab": "files",
			"ui.group": "Editing",
			"ui.label": "Abort on Failed Preview",
			"legacy.path": "edit.streamingAbort",
		},
	};
	/// Default approval behavior for tool calls.
	pub static SV_TOOLS_APPROVAL_MODE = sv_tools_approval_mode: ApprovalMode {
		default: ApprovalMode::Yolo,
		flags: archive,
		meta: {
			"ui.tab": "interaction",
			"ui.group": "Approvals",
			"ui.label": "Tool Approval",
			"ui.option.always-ask": "Always ask",
			"ui.option.always-ask.desc": "Auto-approve read-only tools; require confirmation for write and exec tools.",
			"ui.option.write": "Write",
			"ui.option.write.desc": "Auto-approve read-only and write tools; require confirmation for exec tools.",
			"ui.option.yolo": "Yolo",
			"ui.option.yolo.desc": "Auto-approve read, write, and exec tools; user policy can still prompt or block.",
			"legacy.path": "tools.approval_mode",
			"legacy.path": "tools.approvalMode",
		},
	};
	/// Per-tool allow, prompt, or deny overrides honored in every approval mode.
	pub static SV_TOOLS_APPROVAL = sv_tools_approval: Kv {
		default: Kv::new(),
		validate: |_ctx, values| validate_approval_map(values),
		flags: archive,
		meta: {
			"ui.tab": "interaction",
			"ui.group": "Approvals",
			"ui.label": "Tool Approval Policies",
			"legacy.path": "tools.approval",
		},
	};
	/// Accept high-confidence fuzzy matches for whitespace differences.
	pub static SV_TOOLS_EDIT_FUZZY = sv_tools_edit_fuzzy: bool {
		default: true,
		flags: archive,
		meta: {
			"ui.tab": "files",
			"ui.group": "Editing",
			"ui.label": "Fuzzy Match",
			"legacy.path": "edit.fuzzyMatch",
		},
	};
	/// Reject edits anchored on lines a prior read or search never displayed in full.
	pub static SV_TOOLS_EDIT_REQUIRE_SEEN = sv_tools_edit_require_seen: bool {
		default: false,
		flags: archive,
		meta: {
			"ui.tab": "files",
			"ui.group": "Editing",
			"ui.label": "Enforce Seen-Line Guard",
			"legacy.path": "edit.enforceSeenLines",
		},
	};
	/// Prevent editing files that appear to be auto-generated.
	pub static SV_TOOLS_EDIT_GUARD_GENERATED = sv_tools_edit_guard_generated: bool {
		default: true,
		flags: archive,
		meta: {
			"ui.tab": "files",
			"ui.group": "Editing",
			"ui.label": "Block Auto-Generated Files",
			"legacy.path": "tools.edit_guard_generated",
			"legacy.path": "edit.blockAutoGenerated",
		},
	};
	/// Maximum bytes returned by one read call.
	pub static SV_TOOLS_READ_MAX_BYTES = sv_tools_read_max_bytes: i64 {
		default: 1024 * 1024,
		min: 1,
		flags: archive,
		meta: {
			"legacy.path": "tools.read_max_bytes",
		},
	};
	/// Return structural code summaries when read is called without an explicit selector.
	pub static SV_TOOLS_READ_SUMMARIZE = sv_tools_read_summarize: bool {
		default: true,
		flags: archive,
		meta: {
			"ui.tab": "files",
			"ui.group": "Read Summaries",
			"ui.label": "Read Summaries",
			"legacy.path": "read.summarize.enabled",
		},
	};
	/// Prepend line numbers to read tool output by default.
	pub static SV_TOOLS_READ_LINE_NUMBERS = sv_tools_read_line_numbers: bool {
		default: false,
		flags: archive,
		meta: {
			"ui.tab": "files",
			"ui.group": "Reading",
			"ui.label": "Line Numbers",
			"legacy.path": "readLineNumbers",
		},
	};
	/// Lines of context before each grep match.
	pub static SV_TOOLS_GREP_CONTEXT_BEFORE = sv_tools_grep_context_before: u16 {
		default: 1,
		flags: archive,
		meta: {
			"ui.tab": "tools",
			"ui.group": "Grep & Browser",
			"ui.label": "Grep Context Before",
			"ui.option.0": "0 lines",
			"ui.option.1": "1 line",
			"ui.option.2": "2 lines",
			"ui.option.3": "3 lines",
			"ui.option.5": "5 lines",
			"legacy.path": "grep.contextBefore",
		},
	};
	/// Lines of context after each grep match.
	pub static SV_TOOLS_GREP_CONTEXT_AFTER = sv_tools_grep_context_after: u16 {
		default: 3,
		flags: archive,
		meta: {
			"ui.tab": "tools",
			"ui.group": "Grep & Browser",
			"ui.label": "Grep Context After",
			"ui.option.0": "0 lines",
			"ui.option.1": "1 line",
			"ui.option.2": "2 lines",
			"ui.option.3": "3 lines",
			"ui.option.5": "5 lines",
			"ui.option.10": "10 lines",
			"legacy.path": "grep.contextAfter",
		},
	};
	/// Named eval interpreter command overrides.
	pub static SV_TOOLS_EVAL_INTERPRETERS = sv_tools_eval_interpreters: Kv {
		default: Kv::new(),
		validate: |_ctx, values| validate_string_map(values),
		flags: archive,
		meta: {
			"legacy.path": "tools.eval_interpreters",
		},
	};
	/// Tool output above this size is saved as an artifact; the tail is kept inline.
	pub static SV_TOOLS_OUTPUT_SPILL_BYTES = sv_tools_output_spill_bytes: i64 {
		default: 50 * 1024,
		min: 1,
		validate: |ctx, value| {
			if *value <= SV_TOOLS_OUTPUT_MAX_BYTES.get(ctx) {
				Ok(())
			} else {
				Err(Str::new_static("spill threshold exceeds output ceiling"))
			}
		},
		flags: archive,
		meta: {
			"ui.tab": "tools",
			"ui.group": "Output Limits",
			"ui.label": "Artifact Spill Threshold (KB)",
			"ui.unit": "kib",
			"ui.option.1024": "1 KB",
			"ui.option.1024.desc": "~250 tokens",
			"ui.option.2560": "2.5 KB",
			"ui.option.2560.desc": "~625 tokens",
			"ui.option.5120": "5 KB",
			"ui.option.5120.desc": "~1.25K tokens",
			"ui.option.10240": "10 KB",
			"ui.option.10240.desc": "~2.5K tokens",
			"ui.option.20480": "20 KB",
			"ui.option.20480.desc": "~5K tokens",
			"ui.option.30720": "30 KB",
			"ui.option.30720.desc": "~7.5K tokens",
			"ui.option.51200": "50 KB",
			"ui.option.51200.desc": "Default; ~12.5K tokens",
			"ui.option.76800": "75 KB",
			"ui.option.76800.desc": "~19K tokens",
			"ui.option.102400": "100 KB",
			"ui.option.102400.desc": "~25K tokens",
			"ui.option.204800": "200 KB",
			"ui.option.204800.desc": "~50K tokens",
			"ui.option.512000": "500 KB",
			"ui.option.512000.desc": "~125K tokens",
			"ui.option.1024000": "1 MB",
			"ui.option.1024000.desc": "~250K tokens",
			"legacy.path": "tools.output_spill_bytes",
			"legacy.path": "tools.artifactSpillThreshold",
		},
	};
	/// Hard byte ceiling for one materialized tool output.
	pub static SV_TOOLS_OUTPUT_MAX_BYTES = sv_tools_output_max_bytes: i64 {
		default: 16 * 1024 * 1024,
		min: 1,
		validate: |ctx, value| {
			if *value >= SV_TOOLS_OUTPUT_SPILL_BYTES.get(ctx) {
				Ok(())
			} else {
				Err(Str::new_static("output ceiling is below spill threshold"))
			}
		},
		flags: archive,
		meta: {
			"legacy.path": "tools.output_max_bytes",
		},
	};
	/// Ask the agent to describe the intent of each tool call before executing it.
	pub static SV_TOOLS_INTENT_TRACING = sv_tools_intent_tracing: bool {
		default: true,
		flags: archive,
		meta: {
			"ui.tab": "tools",
			"ui.group": "Execution",
			"ui.label": "Intent Tracing",
			"legacy.path": "tools.intentTracing",
		},
	};
	/// Stop the model immediately when an in-band stream fabricates a tool result.
	pub static SV_TOOLS_ABORT_ON_FABRICATED_RESULT = sv_tools_abort_on_fabricated_result: bool {
		default: true,
		flags: archive,
		meta: {
			"ui.tab": "tools",
			"ui.group": "Execution",
			"ui.label": "Abort On Fabricated Tool Result",
			"legacy.path": "tools.abortOnFabricatedResult",
		},
	};
	/// Maximum repeated equivalent calls before interruption.
	pub static SV_TOOLS_LOOP_GUARD_LIMIT = sv_tools_loop_guard_limit: u32 {
		default: 8,
		min: 1,
		flags: archive,
		meta: {
			"legacy.path": "tools.loop_guard_limit",
		},
	};
	/// Cache rendered issue and pull-request views so repeated reads are free.
	pub static SV_GITHUB_CACHE_ENABLED = sv_github_cache_enabled: bool {
		default: true,
		flags: archive,
		meta: {
			"ui.tab": "tools",
			"ui.group": "GitHub",
			"ui.label": "GitHub View Cache",
			"legacy.path": "github.cache.enabled",
		},
	};
	/// Within this window, cached issue and pull-request views are returned without a network refresh.
	pub static SV_GITHUB_CACHE_SOFT_TTL_SEC = sv_github_cache_soft_ttl_sec: i64 {
		default: 300,
		min: 0,
		flags: archive,
		meta: {
			"ui.tab": "tools",
			"ui.group": "GitHub",
			"ui.label": "GitHub Cache Soft TTL",
			"ui.unit": "s",
			"legacy.path": "github.cache.softTtlSec",
		},
	};
	/// Past this window, a cached issue or pull-request view is discarded instead of used as stale fallback.
	pub static SV_GITHUB_CACHE_HARD_TTL_SEC = sv_github_cache_hard_ttl_sec: i64 {
		default: 604800,
		min: 0,
		flags: archive,
		meta: {
			"ui.tab": "tools",
			"ui.group": "GitHub",
			"ui.label": "GitHub Cache Hard TTL",
			"ui.unit": "s",
			"legacy.path": "github.cache.hardTtlSec",
		},
	};
}

/// Typed GitHub cache policy resolved from the control context.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct GithubCacheSettings {
	/// Whether reads and writes may use the persistent cache.
	pub enabled:      bool,
	/// Fresh-hit window in seconds.
	pub soft_ttl_sec: u64,
	/// Absolute retention window in seconds.
	pub hard_ttl_sec: u64,
}

impl GithubCacheSettings {
	/// Resolves the GitHub cache policy from archived convars.
	#[must_use]
	pub fn from_con(ctx: &Ctx) -> Self {
		Self {
			enabled:      SV_GITHUB_CACHE_ENABLED.get(ctx),
			soft_ttl_sec: SV_GITHUB_CACHE_SOFT_TTL_SEC.get(ctx) as u64,
			hard_ttl_sec: SV_GITHUB_CACHE_HARD_TTL_SEC.get(ctx) as u64,
		}
	}

	/// Converts the resolved settings into the cache engine's typed policy.
	#[must_use]
	pub fn policy(self) -> GithubCachePolicy {
		GithubCachePolicy::new(
			self.enabled,
			std::time::Duration::from_secs(self.soft_ttl_sec),
			std::time::Duration::from_secs(self.hard_ttl_sec),
		)
	}
}

/// Tool exposure, timeout, and approval policy resolved from the control
/// context.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ToolSettings {
	/// Explicit per-tool enablement overrides; absent names remain enabled.
	#[serde(skip_serializing_if = "BTreeMap::is_empty")]
	pub enabled: BTreeMap<Str, bool>,
	/// Global ceiling for tool deadlines.
	#[serde(skip_serializing_if = "Option::is_none", with = "optional_duration")]
	pub max_timeout: Option<Duration>,
	/// Optional pinned edit revision (`rep.2`, `patch.2`, or `hl.1`) for this
	/// client.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub edit_dialect: Option<Str>,
	/// Optional JSONL destination for edit black-box diagnostics.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub edit_blackbox_path: Option<PathBuf>,
	/// Repair newly introduced syntax parse errors before commit after validated
	/// reparse and non-revert checks.
	pub edit_auto_repair: bool,
	/// Abort a streaming turn as soon as the edit guard proves it invalid.
	pub edit_streaming_abort: bool,
	/// Permit HTTP(S) URL dispatch from read.
	pub fetch_enabled: bool,
	/// Convert supported documents to Markdown.
	pub render_markdown: bool,
	/// Normalize images to model pixel/output bounds.
	pub auto_resize_images: bool,
	/// Formatter requirement for write/edit transactions.
	pub format_policy: FormatPolicy,
	/// Capture one final diagnostics batch after write.
	pub diagnostics_on_write: bool,
	/// Capture one final diagnostics batch after edit.
	pub diagnostics_on_edit: bool,
	/// Collapse identical final diagnostics across server bindings.
	pub diagnostic_dedup: bool,
	/// Default approval posture, applied after effect-tier resolution.
	pub approval_mode: ApprovalMode,
	/// Authoritative per-tool approval policy overrides.
	#[serde(skip_serializing_if = "BTreeMap::is_empty")]
	pub approval: BTreeMap<Str, ApprovalPolicy>,
	/// Permit fuzzy edit matching when exact anchors are unavailable.
	pub edit_fuzzy: bool,
	/// Similarity threshold for accepted fuzzy edit anchors.
	pub edit_fuzzy_threshold: f64,
	/// Require files to have been read before mutation.
	pub edit_require_seen: bool,
	/// Refuse generated-file edits unless explicitly requested.
	pub edit_guard_generated: bool,
	/// Maximum bytes returned by one read call before spill/summarization.
	pub read_max_bytes: u64,
	/// Summarize supported oversized documents.
	pub read_summarize: bool,
	/// Include source line numbers in text reads.
	pub read_line_numbers: bool,
	/// Context lines before each grep match.
	pub grep_context_before: u16,
	/// Context lines after each grep match.
	pub grep_context_after: u16,
	/// Named eval interpreter command overrides.
	#[serde(skip_serializing_if = "BTreeMap::is_empty")]
	pub eval_interpreters: BTreeMap<Str, Str>,
	/// Bytes retained inline before tool output spills.
	pub output_spill_bytes: u64,
	/// Hard byte ceiling for one materialized tool output.
	pub output_max_bytes: u64,
	/// Include tool-intent decisions in diagnostic tracing.
	pub intent_tracing: bool,
	/// Stop an owned in-band stream as soon as it fabricates a tool result.
	pub abort_on_fabricated_tool_result: bool,
	/// Maximum repeated equivalent tool calls before the loop guard trips.
	pub loop_guard_limit: u32,
}

impl Default for ToolSettings {
	fn default() -> Self {
		Self {
			enabled: BTreeMap::from([
				(Str::new_static("ast_grep"), false),
				(Str::new_static("computer"), false),
			]),
			max_timeout: None,
			edit_dialect: None,
			edit_blackbox_path: None,
			edit_auto_repair: false,
			edit_streaming_abort: false,
			fetch_enabled: true,
			render_markdown: false,
			auto_resize_images: true,
			format_policy: FormatPolicy::Disabled,
			diagnostics_on_write: true,
			diagnostics_on_edit: false,
			diagnostic_dedup: true,
			approval_mode: ApprovalMode::Yolo,
			approval: BTreeMap::new(),
			edit_fuzzy: true,
			edit_fuzzy_threshold: 0.95,
			edit_require_seen: false,
			edit_guard_generated: true,
			read_max_bytes: 1024 * 1024,
			read_summarize: true,
			read_line_numbers: false,
			grep_context_before: 1,
			grep_context_after: 3,
			eval_interpreters: BTreeMap::new(),
			output_spill_bytes: 50 * 1024,
			output_max_bytes: 16 * 1024 * 1024,
			intent_tracing: true,
			abort_on_fabricated_tool_result: true,
			loop_guard_limit: 8,
		}
	}
}

impl ToolSettings {
	/// Resolves tool exposure and admission policy from the process control
	/// context.
	#[must_use]
	pub fn from_con(ctx: &Ctx) -> Self {
		let lsp = omp_tools::settings::LspFileSettings::from_con(ctx);
		let mut enabled = bool_map(SV_TOOLS_ENABLED.get(ctx));
		if !omp_tools::settings::SV_EVAL_PY.get(ctx) {
			enabled.insert(Str::new_static("eval"), false);
		}
		if !omp_tools::settings::SV_AST_GREP_ENABLED.get(ctx) {
			enabled.insert(Str::new_static("ast_grep"), false);
		}
		if !omp_tools::settings::SV_COMPUTER_ENABLED.get(ctx) {
			enabled.entry(Str::new_static("computer")).or_insert(false);
		}
		Self {
			enabled,
			max_timeout: SV_TOOLS_MAX_TIMEOUT.get(ctx).as_finite(),
			edit_dialect: nonempty_str(SV_TOOLS_EDIT_DIALECT.get(ctx)),
			edit_blackbox_path: SV_TOOLS_EDIT_BLACKBOX_ENABLED.get(ctx).then(|| {
				nonempty_str(SV_TOOLS_EDIT_BLACKBOX_PATH.get(ctx)).map_or_else(
					|| PathBuf::from("edit-blackbox.jsonl"),
					|value| PathBuf::from(value.as_str()),
				)
			}),
			edit_auto_repair: SV_TOOLS_EDIT_AUTO_REPAIR.get(ctx),
			edit_streaming_abort: SV_TOOLS_EDIT_STREAMING_ABORT.get(ctx),
			fetch_enabled: omp_tools::settings::SV_FETCH_ENABLED.get(ctx),
			render_markdown: omp_tools::settings::CL_READ_RENDER_MARKDOWN.get(ctx),
			auto_resize_images: omp_tools::settings::SV_IMAGES_AUTO_RESIZE.get(ctx),
			format_policy: if lsp.format_on_write {
				FormatPolicy::BestEffort
			} else {
				FormatPolicy::Disabled
			},
			diagnostics_on_write: lsp.diagnostics_on_write,
			diagnostics_on_edit: lsp.diagnostics_on_edit,
			diagnostic_dedup: lsp.diagnostics_deduplicate,
			approval_mode: SV_TOOLS_APPROVAL_MODE.get(ctx),
			approval: approval_map(SV_TOOLS_APPROVAL.get(ctx)),
			edit_fuzzy: SV_TOOLS_EDIT_FUZZY.get(ctx),
			edit_fuzzy_threshold: omp_tools::settings::SV_EDIT_FUZZY_THRESHOLD.get(ctx),
			edit_require_seen: SV_TOOLS_EDIT_REQUIRE_SEEN.get(ctx),
			edit_guard_generated: SV_TOOLS_EDIT_GUARD_GENERATED.get(ctx),
			read_max_bytes: SV_TOOLS_READ_MAX_BYTES.get(ctx) as u64,
			read_summarize: SV_TOOLS_READ_SUMMARIZE.get(ctx),
			read_line_numbers: SV_TOOLS_READ_LINE_NUMBERS.get(ctx),
			grep_context_before: SV_TOOLS_GREP_CONTEXT_BEFORE.get(ctx),
			grep_context_after: SV_TOOLS_GREP_CONTEXT_AFTER.get(ctx),
			eval_interpreters: string_map(SV_TOOLS_EVAL_INTERPRETERS.get(ctx)),
			output_spill_bytes: SV_TOOLS_OUTPUT_SPILL_BYTES.get(ctx) as u64,
			output_max_bytes: SV_TOOLS_OUTPUT_MAX_BYTES.get(ctx) as u64,
			intent_tracing: SV_TOOLS_INTENT_TRACING.get(ctx),
			abort_on_fabricated_tool_result: SV_TOOLS_ABORT_ON_FABRICATED_RESULT.get(ctx),
			loop_guard_limit: SV_TOOLS_LOOP_GUARD_LIMIT.get(ctx),
		}
	}

	/// Returns a session-local copy with an explicit approval-mode override.
	///
	/// The source settings are unchanged, so callers can apply an invocation
	/// override without persisting it.
	#[must_use]
	pub fn with_approval_mode_override(mut self, approval_mode: Option<ApprovalMode>) -> Self {
		if let Some(approval_mode) = approval_mode {
			self.approval_mode = approval_mode;
		}
		self
	}

	/// Whether a named tool is available after applying the default-enabled
	/// rule.
	pub fn enabled(&self, name: &str) -> bool {
		self.enabled.get(name).copied().unwrap_or(true)
	}

	/// Resolves and receipts one invocation against its live declared effects.
	pub fn approval_for(
		&self,
		invocation_id: impl Into<Str>,
		tool_name: impl Into<Str>,
		effects: &Effects,
	) -> ResolvedApproval {
		let tool_name = tool_name.into();
		resolve_approval(
			invocation_id,
			tool_name.clone(),
			effects,
			self.approval_mode,
			self.approval.get(&tool_name).copied(),
		)
	}
}

fn nonempty_str(value: Str) -> Option<Str> {
	(!value.is_empty()).then_some(value)
}

fn validate_bool_map(values: &Kv) -> Result<(), Str> {
	if values
		.iter()
		.all(|(name, value)| !name.trim().is_empty() && matches!(value, Value::Bool(_)))
	{
		Ok(())
	} else {
		Err(Str::new_static("tool names must be nonempty and values must be booleans"))
	}
}

fn validate_string_map(values: &Kv) -> Result<(), Str> {
	if values
		.iter()
		.all(|(name, value)| !name.trim().is_empty() && matches!(value, Value::Str(_)))
	{
		Ok(())
	} else {
		Err(Str::new_static("names must be nonempty and values must be strings"))
	}
}

fn validate_approval_map(values: &Kv) -> Result<(), Str> {
	if values.iter().all(|(name, value)| {
		!name.trim().is_empty()
			&& value
				.as_str()
				.is_some_and(|value| value.parse::<ApprovalPolicy>().is_ok())
	}) {
		Ok(())
	} else {
		Err(Str::new_static("approval values must be allow, deny, or prompt"))
	}
}

fn bool_map(values: Kv) -> BTreeMap<Str, bool> {
	values
		.0
		.into_iter()
		.filter_map(|(name, value)| Some((name, value.as_bool()?)))
		.collect()
}

fn string_map(values: Kv) -> BTreeMap<Str, Str> {
	values
		.0
		.into_iter()
		.filter_map(|(name, value)| Some((name, Str::new(value.as_str()?))))
		.collect()
}

fn approval_map(values: Kv) -> BTreeMap<Str, ApprovalPolicy> {
	values
		.0
		.into_iter()
		.filter_map(|(name, value)| Some((name, value.as_str()?.parse().ok()?)))
		.collect()
}

mod optional_duration {

	use super::*;

	pub fn serialize<S>(value: &Option<Duration>, serializer: S) -> Result<S::Ok, S::Error>
	where
		S: Serializer,
	{
		match value {
			Some(value) => serializer.serialize_some(&value.to_string()),
			None => serializer.serialize_none(),
		}
	}

	pub fn deserialize<'de, D>(deserializer: D) -> Result<Option<Duration>, D::Error>
	where
		D: Deserializer<'de>,
	{
		Option::<String>::deserialize(deserializer)?
			.map(|value| value.parse().map_err(de::Error::custom))
			.transpose()
	}
}

#[cfg(test)]
mod tests {
	use omp_core::sf;
	use omp_tool::{Effects, ExecEffects};

	use super::*;
	use crate::admission::{ApprovalPolicy, ApprovalSource, ApprovalTier};

	#[test]
	fn typed_con_projection_round_trips() {
		let ctx = Ctx::new();
		SV_TOOLS_APPROVAL_MODE
			.set(&ctx, ApprovalMode::Write)
			.expect("set mode");
		SV_TOOLS_APPROVAL
			.set(&ctx, Kv(vec![(sf!("bash"), Value::Str(Str::new_static("deny")))]))
			.expect("set approval");
		assert_eq!(ToolSettings::from_con(&ctx), ToolSettings {
			approval_mode: ApprovalMode::Write,
			approval: BTreeMap::from([(sf!("bash"), ApprovalPolicy::Deny)]),
			..ToolSettings::default()
		});
	}

	#[test]
	fn read_and_lsp_policy_convars_reach_the_projection() {
		let ctx = Ctx::new();
		assert_eq!(ToolSettings::from_con(&ctx), ToolSettings::default());
		ctx.run("sv_fetch_enabled false").expect("fetch policy");
		ctx.run("cl_read_render_markdown true")
			.expect("markdown policy");
		ctx.run("sv_images_auto_resize false")
			.expect("image policy");
		ctx.run("sv_lsp_format_on_write true")
			.expect("format policy");
		ctx.run("sv_lsp_diagnostics_on_edit true")
			.expect("diagnostics policy");
		ctx.run("sv_lsp_diagnostics_deduplicate false")
			.expect("dedup policy");
		ctx.run("sv_eval_py false").expect("eval policy");
		ctx.run("sv_ast_grep_enabled false")
			.expect("ast-grep policy");
		ctx.run("sv_edit_fuzzy_threshold 0.87")
			.expect("fuzzy threshold");
		assert_eq!(ToolSettings::from_con(&ctx), ToolSettings {
			fetch_enabled: false,
			render_markdown: true,
			auto_resize_images: false,
			format_policy: FormatPolicy::BestEffort,
			diagnostics_on_edit: true,
			diagnostic_dedup: false,
			edit_fuzzy_threshold: 0.87,
			enabled: BTreeMap::from([
				(Str::new_static("eval"), false),
				(Str::new_static("ast_grep"), false),
				(Str::new_static("computer"), false),
			]),
			..ToolSettings::default()
		});
	}

	#[test]
	fn computer_is_disabled_by_default_and_can_be_enabled_per_session() {
		let ctx = Ctx::new();
		assert!(!ToolSettings::from_con(&ctx).enabled("computer"));
		omp_tools::settings::SV_COMPUTER_ENABLED
			.set(&ctx, true)
			.expect("enable computer");
		assert!(ToolSettings::from_con(&ctx).enabled("computer"));
	}

	#[test]
	fn github_cache_group_convars_reach_the_runtime_projection() {
		let ctx = Ctx::new();
		assert_eq!(GithubCacheSettings::from_con(&ctx), GithubCacheSettings {
			enabled:      true,
			soft_ttl_sec: 300,
			hard_ttl_sec: 604_800,
		});
		ctx.run("sv_github_cache_enabled false")
			.expect("cache enablement");
		ctx.run("sv_github_cache_soft_ttl_sec 15")
			.expect("soft TTL");
		ctx.run("sv_github_cache_hard_ttl_sec 90")
			.expect("hard TTL");
		assert_eq!(GithubCacheSettings::from_con(&ctx), GithubCacheSettings {
			enabled:      false,
			soft_ttl_sec: 15,
			hard_ttl_sec: 90,
		});
	}

	#[test]
	fn execution_group_convars_reach_the_runtime_projection() {
		let ctx = Ctx::new();
		ctx.run("sv_tools_abort_on_fabricated_result false")
			.expect("fabricated-result policy");
		assert_eq!(ToolSettings::from_con(&ctx), ToolSettings {
			abort_on_fabricated_tool_result: false,
			..ToolSettings::default()
		});
	}

	#[test]
	fn override_is_applied_to_declared_effect_tier() {
		let settings = ToolSettings {
			approval: BTreeMap::from([(sf!("bash"), ApprovalPolicy::Deny)]),
			..ToolSettings::default()
		};
		let effects = Effects {
			exec: Some(ExecEffects { commands: [sf!("*")].into(), network: true }),
			..Effects::empty()
		};
		let decision = settings.approval_for("call-1", "bash", &effects);
		assert_eq!(decision.tier, ApprovalTier::Exec);
		assert_eq!(decision.policy, ApprovalPolicy::Deny);
		assert_eq!(decision.source, ApprovalSource::User);
	}

	#[test]
	fn approval_mode_override_is_session_local_and_precedes_persisted_mode() {
		let persisted =
			ToolSettings { approval_mode: ApprovalMode::AlwaysAsk, ..ToolSettings::default() };
		let effects = Effects {
			exec: Some(ExecEffects { commands: [sf!("*")].into(), network: true }),
			..Effects::empty()
		};

		let overridden = persisted
			.clone()
			.with_approval_mode_override(Some(ApprovalMode::Yolo));
		assert_eq!(
			overridden.approval_for("override", "bash", &effects).policy,
			ApprovalPolicy::Allow
		);
		assert_eq!(
			persisted.approval_for("persisted", "bash", &effects).policy,
			ApprovalPolicy::Prompt
		);

		let unchanged = persisted.clone().with_approval_mode_override(None);
		assert_eq!(unchanged, persisted);
	}

	#[test]
	fn empty_override_key_is_rejected() {
		let ctx = Ctx::new();
		assert!(
			SV_TOOLS_APPROVAL
				.set(&ctx, Kv(vec![(Str::default(), Value::Str(Str::new_static("prompt")),)]))
				.is_err()
		);
	}
}
