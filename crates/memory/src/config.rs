//! Native Mnemopi configuration and defaults.

use std::path::PathBuf;

use omp_core::Str;
use serde::{Deserialize, Serialize};
use strum::{Display, EnumString, IntoStaticStr};

/// Selected memory implementation. Memory is globally inactive by default.
#[derive(
	Clone,
	Copy,
	Debug,
	Default,
	Display,
	EnumString,
	Eq,
	IntoStaticStr,
	PartialEq,
	Serialize,
	Deserialize,
)]
#[serde(rename_all = "kebab-case")]
#[strum(ascii_case_insensitive, serialize_all = "kebab-case")]
pub enum MemoryBackend {
	/// Perform no memory effects and advertise no memory capabilities.
	#[default]
	Off,
	/// Use the first-party durable Mnemopi implementation.
	Mnemopi,
}

/// Project-bank scoping policy.
#[derive(
	Clone,
	Copy,
	Debug,
	Default,
	Display,
	EnumString,
	Eq,
	IntoStaticStr,
	PartialEq,
	Serialize,
	Deserialize,
)]
#[serde(rename_all = "kebab-case")]
#[strum(ascii_case_insensitive, serialize_all = "kebab-case")]
pub enum BankScoping {
	/// Read and write one shared bank.
	Global,
	/// Read and write one canonical-project bank.
	#[default]
	PerProject,
	/// Write the canonical-project bank and recall it together with the shared
	/// bank.
	PerProjectTagged,
}

/// Local embedding model family.
#[derive(
	Clone,
	Copy,
	Debug,
	Default,
	Display,
	EnumString,
	Eq,
	IntoStaticStr,
	PartialEq,
	Serialize,
	Deserialize,
)]
#[serde(rename_all = "kebab-case")]
#[strum(ascii_case_insensitive, serialize_all = "kebab-case")]
pub enum EmbeddingVariant {
	/// BAAI BGE base English v1.5 (768 dimensions).
	#[default]
	English,
	/// Multilingual E5 large (1024 dimensions).
	Multilingual,
	/// Disable vectors while preserving lexical and graph recall.
	Disabled,
}

impl EmbeddingVariant {
	/// Returns the model identifier sent to the isolated embedding worker.
	pub const fn model_id(self) -> Option<&'static str> {
		match self {
			Self::English => Some("BAAI/bge-base-en-v1.5"),
			Self::Multilingual => Some("intfloat/multilingual-e5-large"),
			Self::Disabled => None,
		}
	}
}

/// Auxiliary model lane used by extraction and consolidation.
#[derive(
	Clone,
	Copy,
	Debug,
	Default,
	Display,
	EnumString,
	Eq,
	IntoStaticStr,
	PartialEq,
	Serialize,
	Deserialize,
)]
#[serde(rename_all = "kebab-case")]
#[strum(ascii_case_insensitive, serialize_all = "kebab-case")]
pub enum MemoryLlmMode {
	/// Store episodes without model-extracted facts.
	None,
	/// Resolve the configured tiny/smol online role.
	#[default]
	Smol,
	/// Use an Environment-owned OpenAI-compatible completion endpoint.
	Remote,
	/// Use the configured on-device memory model through the auxiliary lane.
	LocalMemoryModel,
}

/// Opaque Environment credential identity; secret material is never persisted
/// here.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct CredentialRef(pub Str);

/// OpenAI-compatible remote embedding configuration.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct RemoteEmbeddingSettings {
	/// Endpoint base URL.
	pub base_url:        Str,
	/// Model name accepted by the endpoint.
	pub model:           Str,
	/// Opaque credential authority reference.
	pub credential:      CredentialRef,
	/// Maximum texts in one Environment egress request.
	#[serde(default = "default_embedding_batch")]
	pub max_batch:       usize,
	/// Maximum aggregate UTF-8 input bytes per request.
	#[serde(default = "default_embedding_input_bytes")]
	pub max_input_bytes: usize,
}

const fn default_embedding_batch() -> usize {
	64
}

const fn default_embedding_input_bytes() -> usize {
	1024 * 1024
}

/// OpenAI-compatible auxiliary completion configuration.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct RemoteLlmSettings {
	/// Endpoint base URL.
	pub base_url:   Str,
	/// Model name accepted by the endpoint.
	pub model:      Str,
	/// Opaque credential authority reference.
	pub credential: CredentialRef,
}

/// Mnemopi settings. [`Self::normalize`] applies floors and hard safety
/// ceilings.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MnemopiSettings {
	/// Optional primary database path; otherwise the app supplies its memory
	/// data root.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub db_path:                  Option<PathBuf>,
	/// Optional shared bank base name.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub bank:                     Option<Str>,
	/// Bank scoping policy.
	#[serde(default)]
	pub scoping:                  BankScoping,
	/// Embedding model family.
	#[serde(default)]
	pub embedding_variant:        EmbeddingVariant,
	/// Optional explicit local model identifier.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub embedding_model:          Option<Str>,
	/// Optional Environment-routed remote embeddings.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub remote_embeddings:        Option<RemoteEmbeddingSettings>,
	/// Recall automatically on the first top-level turn.
	#[serde(default = "default_true")]
	pub auto_recall:              bool,
	/// Retain settled top-level turns automatically.
	#[serde(default = "default_true")]
	pub auto_retain:              bool,
	/// Enable four-voice reciprocal-rank recall.
	#[serde(default)]
	pub polyphonic_recall:        bool,
	/// Enable exact/similar tiered recall caching.
	#[serde(default)]
	pub enhanced_recall:          bool,
	/// Derive graph links as memories enter the durable store.
	#[serde(default)]
	pub proactive_linking:        bool,
	/// Maximum transient working rows retained per session. Zero disables
	/// count/TTL eviction.
	#[serde(default = "default_working_memory_limit")]
	pub working_memory_limit:     usize,
	/// Maximum transient working-row age in hours.
	#[serde(default = "default_working_memory_ttl_hours")]
	pub working_memory_ttl_hours: u64,
	/// User-turn interval for periodic retention.
	#[serde(default = "default_retain_turns")]
	pub retain_every_n_turns:     usize,
	/// Maximum recalled rows.
	#[serde(default = "default_recall_limit")]
	pub recall_limit:             usize,
	/// User-bounded turns included in an automatic recall query.
	#[serde(default = "default_recall_context_turns")]
	pub recall_context_turns:     usize,
	/// Maximum recall-query characters.
	#[serde(default = "default_recall_query_chars")]
	pub recall_max_query_chars:   usize,
	/// Maximum approximate tokens injected into prompts or resolver projections.
	#[serde(default = "default_injection_tokens")]
	pub injection_token_limit:    usize,
	/// Extraction and consolidation model lane.
	#[serde(default)]
	pub llm_mode:                 MemoryLlmMode,
	/// Environment-routed remote completion settings used only in remote mode.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub remote_llm:               Option<RemoteLlmSettings>,
	/// Emit memory debug diagnostics.
	#[serde(default)]
	pub debug:                    bool,
	/// Bounded shutdown drain in milliseconds.
	#[serde(default = "default_shutdown_timeout_ms")]
	pub shutdown_timeout_ms:      u64,
}

const fn default_true() -> bool {
	true
}
const fn default_retain_turns() -> usize {
	4
}
const fn default_working_memory_limit() -> usize {
	1000
}
const fn default_working_memory_ttl_hours() -> u64 {
	24
}
const fn default_recall_limit() -> usize {
	8
}
const fn default_recall_context_turns() -> usize {
	3
}
const fn default_recall_query_chars() -> usize {
	4000
}
const fn default_injection_tokens() -> usize {
	5000
}
const fn default_shutdown_timeout_ms() -> u64 {
	30_000
}

impl Default for MnemopiSettings {
	fn default() -> Self {
		Self {
			db_path:                  None,
			bank:                     None,
			scoping:                  BankScoping::PerProject,
			embedding_variant:        EmbeddingVariant::English,
			embedding_model:          None,
			remote_embeddings:        None,
			auto_recall:              true,
			auto_retain:              true,
			polyphonic_recall:        false,
			enhanced_recall:          false,
			proactive_linking:        false,
			working_memory_limit:     default_working_memory_limit(),
			working_memory_ttl_hours: default_working_memory_ttl_hours(),
			retain_every_n_turns:     default_retain_turns(),
			recall_limit:             default_recall_limit(),
			recall_context_turns:     default_recall_context_turns(),
			recall_max_query_chars:   default_recall_query_chars(),
			injection_token_limit:    default_injection_tokens(),
			llm_mode:                 MemoryLlmMode::Smol,
			remote_llm:               None,
			debug:                    false,
			shutdown_timeout_ms:      default_shutdown_timeout_ms(),
		}
	}
}

impl MnemopiSettings {
	/// Applies parity floors and bounded operational ceilings.
	pub fn normalize(mut self) -> Self {
		self.working_memory_limit = self.working_memory_limit.min(1_000_000);
		self.working_memory_ttl_hours = self.working_memory_ttl_hours.clamp(1, 24 * 365 * 10);
		self.retain_every_n_turns = self.retain_every_n_turns.clamp(1, 10_000);
		self.recall_limit = self.recall_limit.clamp(1, 50);
		self.recall_context_turns = self.recall_context_turns.clamp(1, 64);
		self.recall_max_query_chars = self.recall_max_query_chars.clamp(256, 64 * 1024);
		self.injection_token_limit = self.injection_token_limit.clamp(256, 32 * 1024);
		self.shutdown_timeout_ms = self.shutdown_timeout_ms.clamp(1, 10 * 60 * 1000);
		if let Some(remote) = &mut self.remote_embeddings {
			remote.max_batch = remote.max_batch.clamp(1, 256);
			remote.max_input_bytes = remote.max_input_bytes.clamp(1024, 4 * 1024 * 1024);
		}
		self
	}
}

/// Persisted memory selector and backend settings.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemorySettings {
	/// Active backend; omitted means [`MemoryBackend::Off`].
	#[serde(default)]
	pub backend: MemoryBackend,
}

/// Automatic-learning settings.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct AutolearnSettings {
	/// Enables managed-skill guidance and capture eligibility.
	#[serde(default)]
	pub enabled:        bool,
	/// Schedules a private capture turn when a substantive turn settles.
	#[serde(default)]
	pub auto_continue:  bool,
	/// Minimum settled tool executions in the turn.
	#[serde(default = "default_min_tool_calls")]
	pub min_tool_calls: usize,
}

const fn default_min_tool_calls() -> usize {
	5
}

impl Default for AutolearnSettings {
	fn default() -> Self {
		Self {
			enabled:        false,
			auto_continue:  false,
			min_tool_calls: default_min_tool_calls(),
		}
	}
}
