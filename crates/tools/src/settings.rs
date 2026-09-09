//! Typed convars and settings owned by the tool runtime.

use omp_con::Ctx;
use serde::{Deserialize, Serialize};

/// Default number of prior diagnostic identities retained for deduplication.
pub const DEFAULT_DIAGNOSTIC_HISTORY_CAPACITY: usize = 1_024;
/// Default maximum diagnostics retained in one committed batch.
pub const DEFAULT_DIAGNOSTICS_PER_BATCH: usize = 256;
/// Hard upper bound for the diagnostic identity ledger.
pub const MAX_DIAGNOSTIC_HISTORY_CAPACITY: usize = 16_384;
/// Hard upper bound for one committed diagnostic batch.
pub const MAX_DIAGNOSTICS_PER_BATCH: usize = 4_096;

/// URL-fetch policy applied before read dispatch.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default)]
pub struct FetchSettings {
	/// Whether read may perform HTTP(S) fetches.
	pub enabled: bool,
}

impl Default for FetchSettings {
	fn default() -> Self {
		Self { enabled: true }
	}
}

impl FetchSettings {
	/// Projects the current fetch policy from the control plane.
	#[must_use]
	pub fn from_con(ctx: &Ctx) -> Self {
		Self { enabled: SV_FETCH_ENABLED.get(ctx) }
	}
}

/// Image handling policy applied by read.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ImageSettings {
	/// Whether oversized images are decoded and resized for model compatibility.
	pub auto_resize: bool,
}

impl Default for ImageSettings {
	fn default() -> Self {
		Self { auto_resize: true }
	}
}

impl ImageSettings {
	/// Projects the current image policy from the control plane.
	#[must_use]
	pub fn from_con(ctx: &Ctx) -> Self {
		Self { auto_resize: SV_IMAGES_AUTO_RESIZE.get(ctx) }
	}
}

/// Text presentation policy applied by read.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ReadSettings {
	/// Whether Markdown reads carry rendered-Markdown presentation metadata.
	pub render_markdown: bool,
}

impl ReadSettings {
	/// Projects the current read presentation policy from the control plane.
	#[must_use]
	pub fn from_con(ctx: &Ctx) -> Self {
		Self { render_markdown: CL_READ_RENDER_MARKDOWN.get(ctx) }
	}
}

/// LSP policy captured once for a file-tool invocation.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LspFileSettings {
	/// Whether whole-file writes request formatter execution.
	pub format_on_write:              bool,
	/// Whether whole-file writes request revision-bound diagnostics.
	pub diagnostics_on_write:         bool,
	/// Whether edit transactions request revision-bound diagnostics.
	pub diagnostics_on_edit:          bool,
	/// Whether diagnostics already surfaced for a file are suppressed.
	pub diagnostics_deduplicate:      bool,
	/// Maximum prior diagnostic identities retained by the deduplication ledger.
	pub diagnostics_history_capacity: usize,
	/// Maximum diagnostics retained in one committed batch.
	pub max_diagnostics_per_batch:    usize,
}

impl Default for LspFileSettings {
	fn default() -> Self {
		Self {
			format_on_write:              false,
			diagnostics_on_write:         true,
			diagnostics_on_edit:          false,
			diagnostics_deduplicate:      true,
			diagnostics_history_capacity: DEFAULT_DIAGNOSTIC_HISTORY_CAPACITY,
			max_diagnostics_per_batch:    DEFAULT_DIAGNOSTICS_PER_BATCH,
		}
	}
}

impl LspFileSettings {
	/// Projects the current LSP file policy from the control plane.
	#[must_use]
	pub fn from_con(ctx: &Ctx) -> Self {
		Self {
			format_on_write:              SV_LSP_FORMAT_ON_WRITE.get(ctx),
			diagnostics_on_write:         SV_LSP_DIAGNOSTICS_ON_WRITE.get(ctx),
			diagnostics_on_edit:          SV_LSP_DIAGNOSTICS_ON_EDIT.get(ctx),
			diagnostics_deduplicate:      SV_LSP_DIAGNOSTICS_DEDUPLICATE.get(ctx),
			diagnostics_history_capacity: SV_LSP_DIAGNOSTICS_HISTORY_CAPACITY.get(ctx) as usize,
			max_diagnostics_per_batch:    SV_LSP_MAX_DIAGNOSTICS_PER_BATCH.get(ctx) as usize,
		}
	}

	/// Reports whether all LSP policy bounds hold.
	#[must_use]
	pub fn validate(&self) -> bool {
		(1..=MAX_DIAGNOSTIC_HISTORY_CAPACITY).contains(&self.diagnostics_history_capacity)
			&& (1..=MAX_DIAGNOSTICS_PER_BATCH).contains(&self.max_diagnostics_per_batch)
	}
}

/// Complete immutable file-tool policy projection.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default)]
pub struct FileToolSettings {
	/// Fetch settings.
	pub fetch:  FetchSettings,
	/// Image settings.
	pub images: ImageSettings,
	/// Read presentation settings.
	pub read:   ReadSettings,
	/// LSP mutation settings.
	pub lsp:    LspFileSettings,
}

impl FileToolSettings {
	/// Projects all file-tool policy from the control plane.
	#[must_use]
	pub fn from_con(ctx: &Ctx) -> Self {
		Self {
			fetch:  FetchSettings::from_con(ctx),
			images: ImageSettings::from_con(ctx),
			read:   ReadSettings::from_con(ctx),
			lsp:    LspFileSettings::from_con(ctx),
		}
	}
}

omp_con::var! {
	/// Amount of tail content kept inline when output spills to artifact.
	pub static SV_TOOLS_ARTIFACT_TAIL_BYTES = sv_tools_artifact_tail_bytes: i64 {
		default: 20 * 1024,
		min: 1,
		flags: archive,
		meta: {
			"ui.tab": "tools",
			"ui.group": "Output Limits",
			"ui.label": "Artifact Tail Size (KB)",
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
			"ui.option.20480.desc": "Default; ~5K tokens",
			"ui.option.51200": "50 KB",
			"ui.option.51200.desc": "~12.5K tokens",
			"ui.option.102400": "100 KB",
			"ui.option.102400.desc": "~25K tokens",
			"ui.option.204800": "200 KB",
			"ui.option.204800.desc": "~50K tokens",
			"legacy.path": "tools.artifactTailBytes",
		},
	};
	/// Amount of head content kept inline alongside the tail when output spills to artifact
	/// (middle elision). 0 disables — keep tail only.
	pub static SV_TOOLS_ARTIFACT_HEAD_BYTES = sv_tools_artifact_head_bytes: i64 {
		default: 20 * 1024,
		min: 0,
		flags: archive,
		meta: {
			"ui.tab": "tools",
			"ui.group": "Output Limits",
			"ui.label": "Artifact Head Size (KB)",
			"ui.unit": "kib",
			"ui.option.0": "0 KB",
			"ui.option.0.desc": "Disabled; tail-only truncation",
			"ui.option.1024": "1 KB",
			"ui.option.1024.desc": "~250 tokens",
			"ui.option.2560": "2.5 KB",
			"ui.option.2560.desc": "~625 tokens",
			"ui.option.5120": "5 KB",
			"ui.option.5120.desc": "~1.25K tokens",
			"ui.option.10240": "10 KB",
			"ui.option.10240.desc": "~2.5K tokens",
			"ui.option.20480": "20 KB",
			"ui.option.20480.desc": "Default; ~5K tokens",
			"ui.option.51200": "50 KB",
			"ui.option.51200.desc": "~12.5K tokens",
			"ui.option.102400": "100 KB",
			"ui.option.102400.desc": "~25K tokens",
			"ui.option.204800": "200 KB",
			"ui.option.204800.desc": "~50K tokens",
			"legacy.path": "tools.artifactHeadBytes",
		},
	};
	/// Per-line byte cap for streaming tool outputs (bash, python, js eval) and `read`. Lines wider
	/// than this are ellipsis-truncated; remaining bytes up to the next newline are dropped. 0
	/// disables.
	pub static SV_TOOLS_OUTPUT_MAX_COLUMNS = sv_tools_output_max_columns: i64 {
		default: 768,
		min: 0,
		flags: archive,
		meta: {
			"ui.tab": "tools",
			"ui.group": "Output Limits",
			"ui.label": "Output Column Cap",
			"ui.option.0": "Off",
			"ui.option.0.desc": "No per-line cap",
			"ui.option.256": "256",
			"ui.option.256.desc": "Tight",
			"ui.option.512": "512",
			"ui.option.768": "768",
			"ui.option.768.desc": "Default",
			"ui.option.1024": "1024",
			"ui.option.2048": "2048",
			"ui.option.4096": "4096",
			"ui.option.4096.desc": "Loose",
			"legacy.path": "tools.outputMaxColumns",
		},
	};
	/// Maximum lines of tail content kept inline when output spills to artifact.
	pub static SV_TOOLS_ARTIFACT_TAIL_LINES = sv_tools_artifact_tail_lines: i64 {
		default: 500,
		min: 1,
		flags: archive,
		meta: {
			"ui.tab": "tools",
			"ui.group": "Output Limits",
			"ui.label": "Artifact Tail Lines",
			"ui.option.50": "50 lines",
			"ui.option.50.desc": "~250 tokens",
			"ui.option.100": "100 lines",
			"ui.option.100.desc": "~500 tokens",
			"ui.option.250": "250 lines",
			"ui.option.250.desc": "~1.25K tokens",
			"ui.option.500": "500 lines",
			"ui.option.500.desc": "Default; ~2.5K tokens",
			"ui.option.1000": "1000 lines",
			"ui.option.1000.desc": "~5K tokens",
			"ui.option.2000": "2000 lines",
			"ui.option.2000.desc": "~10K tokens",
			"ui.option.5000": "5000 lines",
			"ui.option.5000.desc": "~25K tokens",
			"legacy.path": "tools.artifactTailLines",
		},
	};
	/// Similarity threshold (0-1) for accepting fuzzy matches.
	pub static SV_EDIT_FUZZY_THRESHOLD = sv_edit_fuzzy_threshold: f64 {
		default: 0.95,
		flags: archive,
		meta: {
			"ui.tab": "files",
			"ui.group": "Editing",
			"ui.label": "Fuzzy Match Threshold",
			"ui.option.0.85": "0.85",
			"ui.option.0.85.desc": "Lenient",
			"ui.option.0.9": "0.90",
			"ui.option.0.9.desc": "Moderate",
			"ui.option.0.95": "0.95",
			"ui.option.0.95.desc": "Default",
			"ui.option.0.98": "0.98",
			"ui.option.0.98.desc": "Strict",
			"legacy.path": "edit.fuzzyThreshold",
		},
	};
	/// Allow the eval tool to dispatch Python cells to the IPython kernel.
	pub static SV_EVAL_PY = sv_eval_py: bool {
		default: true,
		flags: archive,
		meta: {
			"ui.tab": "shell",
			"ui.group": "Eval & Runtimes",
			"ui.label": "Python Eval Backend",
			"legacy.path": "eval.py",
		},
	};
	/// Let eval cells define tools (@tool in Python, tool(fn) in JS) that task, agent(), and
	/// workpool() subagents can call.
	pub static SV_EVAL_TOOLS_ENABLED = sv_eval_tools_enabled: bool {
		default: true,
		flags: archive,
		meta: {
			"ui.tab": "shell",
			"ui.group": "Eval & Runtimes",
			"ui.label": "Eval-Defined Tools",
			"legacy.path": "eval.tools.enabled",
		},
	};
	/// Spawn a new subagent for every workpool item instead of reusing workers or batching queued
	/// items.
	pub static SV_EVAL_WORKPOOL_FRESH_AGENTS = sv_eval_workpool_fresh_agents: bool {
		default: false,
		flags: archive,
		meta: {
			"ui.tab": "shell",
			"ui.group": "Eval & Runtimes",
			"ui.label": "Fresh Workpool Agents",
			"legacy.path": "eval.workpool.freshAgents",
		},
	};
	/// Enable the ast_grep tool for structural AST search.
	pub static SV_AST_GREP_ENABLED = sv_ast_grep_enabled: bool {
		default: false,
		flags: archive,
		meta: {
			"ui.tab": "tools",
			"ui.group": "Available Tools",
			"ui.label": "AST Grep",
			"legacy.path": "astGrep.enabled",
		},
	};
	/// Enable the scriptable host-desktop eval prelude (screenshots, input, accessibility).
	pub static SV_COMPUTER_ENABLED = sv_computer_enabled: bool {
		default: false,
		flags: archive,
		meta: {
			"ui.tab": "tools",
			"ui.group": "Available Tools",
			"ui.label": "Computer",
			"legacy.path": "computer.enabled",
		},
	};
	/// Enable the vault:// internal URL for reading and editing Obsidian vault content via the
	/// Obsidian CLI. When disabled, vault:// resolution is refused and the vault:// entry is omitted
	/// from the system prompt.
	pub static SV_VAULT_ENABLED = sv_vault_enabled: bool {
		default: false,
		flags: archive,
		meta: {
			"ui.tab": "tools",
			"ui.group": "Available Tools",
			"ui.label": "Obsidian Vault",
			"legacy.path": "vault.enabled",
		},
	};
}

omp_con::var! {
	/// Allow the read tool to fetch and process URLs.
	pub static SV_FETCH_ENABLED = sv_fetch_enabled: bool {
		default: true,
		flags: archive | replicated,
		meta: {
			"ui.tab": "tools",
			"ui.group": "Available Tools",
			"ui.label": "Read URLs",
			"legacy.path": "fetch.enabled",
		},
	};
	/// Resize large images to 2000x2000 max for better model compatibility.
	pub static SV_IMAGES_AUTO_RESIZE = sv_images_auto_resize: bool {
		default: true,
		flags: archive | session | replicated,
		meta: {
			"ui.tab": "appearance",
			"ui.group": "Images",
			"ui.label": "Auto-Resize Images",
			"legacy.path": "images.autoResize",
		},
	};
	/// Render Markdown read results as formatted terminal previews instead of raw source.
	pub static CL_READ_RENDER_MARKDOWN = cl_read_render_markdown: bool {
		default: false,
		flags: archive,
		meta: {
			"ui.tab": "files",
			"ui.group": "Reading",
			"ui.label": "Markdown Previews",
			"legacy.path": "read.renderMarkdown",
		},
	};
	/// Automatically format code files using LSP after writing.
	pub static SV_LSP_FORMAT_ON_WRITE = sv_lsp_format_on_write: bool {
		default: false,
		flags: archive | replicated,
		meta: {
			"ui.tab": "files",
			"ui.group": "LSP",
			"ui.label": "Format on Write",
			"legacy.path": "lsp.formatOnWrite",
		},
	};
	/// Return LSP diagnostics after writing code files.
	pub static SV_LSP_DIAGNOSTICS_ON_WRITE = sv_lsp_diagnostics_on_write: bool {
		default: true,
		flags: archive | replicated,
		meta: {
			"ui.tab": "files",
			"ui.group": "LSP",
			"ui.label": "Diagnostics on Write",
			"legacy.path": "lsp.diagnosticsOnWrite",
		},
	};
	/// Return LSP diagnostics after editing code files.
	pub static SV_LSP_DIAGNOSTICS_ON_EDIT = sv_lsp_diagnostics_on_edit: bool {
		default: false,
		flags: archive | replicated,
		meta: {
			"ui.tab": "files",
			"ui.group": "LSP",
			"ui.label": "Diagnostics on Edit",
			"legacy.path": "lsp.diagnosticsOnEdit",
		},
	};
	/// Suppress post-edit LSP diagnostics already shown for a file; only surface new or changed ones.
	pub static SV_LSP_DIAGNOSTICS_DEDUPLICATE = sv_lsp_diagnostics_deduplicate: bool {
		default: true,
		flags: archive | replicated,
		meta: {
			"ui.tab": "files",
			"ui.group": "LSP",
			"ui.label": "Deduplicate Diagnostics",
			"legacy.path": "lsp.diagnosticsDeduplicate",
		},
	};
	/// Maximum prior diagnostic identities retained by the deduplication ledger.
	pub static SV_LSP_DIAGNOSTICS_HISTORY_CAPACITY = sv_lsp_diagnostics_history_capacity: u32 {
		default: DEFAULT_DIAGNOSTIC_HISTORY_CAPACITY as u32,
		min: 1,
		max: MAX_DIAGNOSTIC_HISTORY_CAPACITY as u32,
		flags: archive | replicated,
		meta: {
			"legacy.path": "lsp.diagnosticsHistoryCapacity",
		},
	};
	/// Maximum diagnostics retained in one committed batch.
	pub static SV_LSP_MAX_DIAGNOSTICS_PER_BATCH = sv_lsp_max_diagnostics_per_batch: u32 {
		default: DEFAULT_DIAGNOSTICS_PER_BATCH as u32,
		min: 1,
		max: MAX_DIAGNOSTICS_PER_BATCH as u32,
		flags: archive | replicated,
		meta: {
			"legacy.path": "lsp.maxDiagnosticsPerBatch",
		},
	};
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn projects_defaults_and_ctx_override() {
		let ctx = Ctx::new();
		SV_FETCH_ENABLED.set(&ctx, false).expect("set fetch policy");
		let projection = FileToolSettings::from_con(&ctx);
		assert!(!projection.fetch.enabled);
		assert!(projection.lsp.validate());
	}

	#[test]
	fn rejects_unbounded_diagnostic_policy() {
		let settings =
			LspFileSettings { diagnostics_history_capacity: 0, ..LspFileSettings::default() };
		assert!(!settings.validate());
	}
}
