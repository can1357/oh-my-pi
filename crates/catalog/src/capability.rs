#![allow(missing_docs, reason = "strum IntoStaticStr emits undocumented inherent methods")]

//! Typed operation and capability vocabulary.

use omp_core::Str;
use serde::{Deserialize, Serialize};
use strum::{Display, EnumString, IntoStaticStr};

macro_rules! bitset {
	($(#[$meta:meta])* $name:ident, $repr:ty) => {
		$(#[$meta])*
		#[derive(Clone, Copy, Debug, Default, Eq, Hash, PartialEq, Serialize, Deserialize)]
		#[repr(transparent)]
		#[serde(transparent)]
		pub struct $name($repr);

		impl $name {
			/// Returns an empty set.
			pub const fn empty() -> Self {
				Self(0)
			}

			/// Constructs a set from its stable serialized representation.
			pub const fn from_bits(bits: $repr) -> Self {
				Self(bits)
			}

			/// Returns the stable serialized representation.
			pub const fn bits(self) -> $repr {
				self.0
			}

			/// Reports whether no bits are present.
			pub const fn is_empty(self) -> bool {
				self.0 == 0
			}

			/// Reports whether every bit in `other` is present.
			pub const fn contains(self, other: Self) -> bool {
				(self.0 & other.0) == other.0
			}

			/// Reports whether any bit in `other` is present.
			pub const fn intersects(self, other: Self) -> bool {
				(self.0 & other.0) != 0
			}

			/// Returns the union of two sets.
			pub const fn union(self, other: Self) -> Self {
				Self(self.0 | other.0)
			}

			/// Adds every bit from `other`.
			pub const fn insert(&mut self, other: Self) {
				self.0 |= other.0;
			}
		}

		impl std::ops::BitOr for $name {
			type Output = Self;

			fn bitor(self, rhs: Self) -> Self::Output {
				self.union(rhs)
			}
		}

		impl std::ops::BitOrAssign for $name {
			fn bitor_assign(&mut self, rhs: Self) {
				self.insert(rhs);
			}
		}
	};
}

/// Closed operation vocabulary shared by catalog and request layers.
#[allow(missing_docs, reason = "strum IntoStaticStr generates undocumented as_str")]
#[derive(
	Clone,
	Copy,
	Debug,
	Display,
	EnumString,
	Eq,
	Hash,
	IntoStaticStr,
	Ord,
	PartialEq,
	PartialOrd,
	Serialize,
	Deserialize,
)]
#[repr(u8)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case", ascii_case_insensitive, const_into_str)]
pub enum OperationKind {
	/// Streaming or unary conversational generation.
	Chat,
	/// Counts tokens without returning token identifiers.
	CountTokens,
	/// Converts text into token identifiers.
	Tokenize,
	/// Converts token identifiers back into text.
	Detokenize,
	/// Produces vector embeddings.
	Embed,
	/// Generates or edits images.
	GenerateImage,
	/// Generates or edits video.
	GenerateVideo,
	/// Synthesizes speech.
	Speak,
	/// Transcribes audio.
	Transcribe,
	/// Opens a bidirectional realtime session.
	Realtime,
	/// Performs standalone web search.
	Search,
	/// Reads account usage or quota.
	Usage,
	/// Discovers remotely available models.
	DiscoverModels,
	/// Manages authentication and accounts.
	Auth,
	/// Executes an allowlisted native-wire operation.
	Native,
	/// Extracts bounded content from a set of web resources.
	Extract,
}

bitset!(/// Compact membership set for [`OperationKind`] values.
	OperationBits, u16);

impl OperationBits {
	/// Returns the one-bit set corresponding to `kind`.
	pub const fn for_kind(kind: OperationKind) -> Self {
		Self(1_u16 << kind as u8)
	}

	/// Reports whether `kind` is present.
	pub const fn contains_kind(self, kind: OperationKind) -> bool {
		self.contains(Self::for_kind(kind))
	}

	/// Adds `kind` to this set.
	pub const fn insert_kind(&mut self, kind: OperationKind) {
		self.insert(Self::for_kind(kind));
	}
}

/// Declares how a supported behavior is reproduced without native wire support.
#[allow(missing_docs, reason = "strum IntoStaticStr generates undocumented as_str")]
#[derive(
	Clone,
	Copy,
	Debug,
	Display,
	EnumString,
	Eq,
	Hash,
	IntoStaticStr,
	PartialEq,
	Serialize,
	Deserialize,
)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case", ascii_case_insensitive, const_into_str)]
pub enum Emulation {
	/// Rewrites the canonical request before encoding.
	RequestTransform,
	/// Adds explicit control instructions to the prompt.
	PromptInstruction,
	/// Enforces the contract by validating or transforming output.
	ResponseTransform,
	/// Uses another canonical operation with equivalent semantics.
	SurrogateOperation,
}

/// Evidence-aware availability of a capability and its constraints.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Availability<C> {
	/// Evidence proves the capability is unavailable.
	Unsupported,
	/// Available evidence is insufficient to decide.
	Unknown,
	/// The route implements the capability directly.
	Native(C),
	/// The runtime can implement the capability under declared constraints.
	Emulated {
		/// Constraints that remain after emulation.
		constraints: C,
		/// Mechanism used to emulate the capability.
		method:      Emulation,
	},
}

impl<C> Availability<C> {
	/// Reports whether evidence explicitly proves lack of support.
	pub const fn is_unsupported(&self) -> bool {
		matches!(self, Self::Unsupported)
	}

	/// Reports whether support remains unknown.
	pub const fn is_unknown(&self) -> bool {
		matches!(self, Self::Unknown)
	}

	/// Returns native or emulated constraints when the capability is usable.
	pub const fn constraints(&self) -> Option<&C> {
		match self {
			Self::Native(constraints) | Self::Emulated { constraints, .. } => Some(constraints),
			Self::Unsupported | Self::Unknown => None,
		}
	}
}

bitset!(/// Roles accepted by a chat endpoint.
	RoleBits, u8);
impl RoleBits {
	/// Developer-instruction role.
	pub const DEVELOPER: Self = Self(1 << 1);
	/// System-instruction role.
	pub const SYSTEM: Self = Self(1 << 0);
}

bitset!(/// Independent tool-call behaviors.
	ToolFeatureBits, u16);
impl ToolFeatureBits {
	/// Tool use can be explicitly disabled.
	pub const DISABLED_CHOICE: Self = Self(1 << 4);
	/// A specific named tool can be required.
	pub const NAMED_CHOICE: Self = Self(1 << 2);
	/// Multiple tool calls may be emitted together.
	pub const PARALLEL: Self = Self(1 << 0);
	/// At least one tool call can be required.
	pub const REQUIRED_CHOICE: Self = Self(1 << 3);
	/// Tool parameter schemas can be enforced strictly.
	pub const STRICT_SCHEMA: Self = Self(1 << 1);
}

bitset!(/// Native structured-output forms.
	StructuredOutputBits, u8);
impl StructuredOutputBits {
	/// A JSON object can be enforced.
	pub const JSON_OBJECT: Self = Self(1 << 0);
	/// A JSON Schema can be enforced.
	pub const JSON_SCHEMA: Self = Self(1 << 1);
}

bitset!(/// Supported grammar constraint languages.
	GrammarBits, u8);
impl GrammarBits {
	/// Every grammar constraint language represented by the catalog.
	pub const ALL: Self = Self::LARK.union(Self::REGEX).union(Self::EBNF);
	/// EBNF grammar constraints.
	pub const EBNF: Self = Self(1 << 2);
	/// Lark grammar constraints.
	pub const LARK: Self = Self(1 << 1);
	/// Regular-expression constraints.
	pub const REGEX: Self = Self(1 << 0);
}

bitset!(/// Supported text verbosity controls.
	TextVerbosityBits, u8);
impl TextVerbosityBits {
	/// Expanded output preference.
	pub const HIGH: Self = Self(1 << 2);
	/// Concise output preference.
	pub const LOW: Self = Self(1 << 0);
	/// Default-length output preference.
	pub const MEDIUM: Self = Self(1 << 1);
}

/// Named reasoning effort vocabulary.
#[allow(missing_docs, reason = "strum IntoStaticStr generates undocumented as_str")]
#[derive(
	Clone,
	Copy,
	Debug,
	Display,
	EnumString,
	Eq,
	Hash,
	IntoStaticStr,
	Ord,
	PartialEq,
	PartialOrd,
	Serialize,
	Deserialize,
)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case", ascii_case_insensitive, const_into_str)]
pub enum ReasoningEffort {
	/// Disables explicit reasoning.
	Off,
	/// Minimal reasoning effort.
	Minimal,
	/// Low reasoning effort.
	Low,
	/// Medium reasoning effort.
	Medium,
	/// High reasoning effort.
	High,
	/// Extra-high reasoning effort.
	Xhigh,
	/// Maximum provider-defined reasoning effort.
	Max,
}

/// A serving mode that modifies a model's reasoning behavior.
#[allow(missing_docs, reason = "strum IntoStaticStr generates undocumented as_str")]
#[derive(
	Clone,
	Copy,
	Debug,
	Display,
	EnumString,
	Eq,
	Hash,
	IntoStaticStr,
	PartialEq,
	Serialize,
	Deserialize,
)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case", ascii_case_insensitive, const_into_str)]
pub enum ModelReasoningMode {
	/// Provider-defined premium reasoning mode.
	Pro,
}

bitset!(/// Independent reasoning behaviors.
	ReasoningFeatureBits, u8);
impl ReasoningFeatureBits {
	/// An explicit token budget is accepted.
	pub const BUDGET: Self = Self(1 << 2);
	/// Named effort levels are accepted.
	pub const EFFORT: Self = Self(1 << 1);
	/// Signed reasoning blocks can be replayed.
	pub const SIGNATURES: Self = Self(1 << 3);
	/// Reasoning content may be shown to callers.
	pub const VISIBLE: Self = Self(1 << 0);
}

/// Multi-dimensional reasoning constraints.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ReasoningCapabilities {
	/// Independent supported reasoning behaviors.
	pub features:              ReasoningFeatureBits,
	/// Accepted named effort levels in stable preference order.
	pub efforts:               Box<[ReasoningEffort]>,
	/// Smallest accepted reasoning token budget, when bounded.
	pub minimum_budget_tokens: Option<u32>,
	/// Largest accepted reasoning token budget, when bounded.
	pub maximum_budget_tokens: Option<u32>,
}

bitset!(/// Canonical media modalities.
	ModalityBits, u8);
impl ModalityBits {
	/// Audio modality.
	pub const AUDIO: Self = Self(1 << 2);
	/// Document or PDF modality.
	pub const DOCUMENT: Self = Self(1 << 4);
	/// Image modality.
	pub const IMAGE: Self = Self(1 << 1);
	/// Text modality.
	pub const TEXT: Self = Self(1 << 0);
	/// Video modality.
	pub const VIDEO: Self = Self(1 << 3);
}

bitset!(/// Image encodings accepted by chat input decoders.
	ImageInputFormatBits, u8);
impl ImageInputFormatBits {
	/// Every canonical image input encoding.
	pub const ALL: Self = Self(Self::PNG.0 | Self::JPEG.0 | Self::GIF.0 | Self::WEBP.0);
	/// GIF image input.
	pub const GIF: Self = Self(1 << 2);
	/// JPEG image input.
	pub const JPEG: Self = Self(1 << 1);
	/// PNG image input.
	pub const PNG: Self = Self(1 << 0);
	/// Formats decoded by `stb_image` builds used by local model servers.
	pub const STB: Self = Self(Self::PNG.0 | Self::JPEG.0 | Self::GIF.0);
	/// WebP image input.
	pub const WEBP: Self = Self(1 << 3);
}

/// Image decoder family at the selected model boundary.
#[derive(
	Clone,
	Copy,
	Debug,
	Display,
	EnumString,
	Eq,
	Hash,
	IntoStaticStr,
	PartialEq,
	Serialize,
	Deserialize,
)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case", ascii_case_insensitive, const_into_str)]
pub enum ImageDecoderFamily {
	/// Provider-native decoder with all declared canonical formats.
	Native,
	/// `stb_image`-compatible decoder without WebP support.
	Stb,
}

/// Accepted chat image formats and decoder behavior.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ImageInputCapabilities {
	/// Accepted encoded image formats.
	pub formats: ImageInputFormatBits,
	/// Decoder family determining compatibility behavior.
	pub decoder: ImageDecoderFamily,
}

bitset!(/// Hosted tools callable inside chat generation.
	HostedToolBits, u8);
impl HostedToolBits {
	/// Hosted code execution.
	pub const CODE: Self = Self(1 << 2);
	/// Hosted ranked web search.
	pub const SEARCH: Self = Self(1 << 1);
	/// Hosted general web access.
	pub const WEB: Self = Self(1 << 0);
}

bitset!(/// Prompt-cache retention classes.
	CacheRetentionBits, u8);
impl CacheRetentionBits {
	/// Request-lifetime cache retention.
	pub const EPHEMERAL: Self = Self(1 << 0);
	/// Extended cache retention.
	pub const LONG: Self = Self(1 << 2);
	/// Provider-standard cache retention.
	pub const STANDARD: Self = Self(1 << 1);
}

/// Prompt-cache constraints.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct PromptCacheCapabilities {
	/// Supported cache retention classes.
	pub retention:             CacheRetentionBits,
	/// Minimum cacheable prefix length in tokens, if known.
	pub minimum_prefix_tokens: Option<u32>,
	/// Maximum number of explicit cache breakpoints, if bounded.
	pub maximum_breakpoints:   Option<u8>,
}

/// One provider service tier exposed to callers.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ServiceTier {
	/// Stable tier name passed through typed policy.
	pub name:     Str,
	/// Relative scheduling preference, where larger values are preferred.
	pub priority: i16,
}

/// Provider family whose service-tier vocabulary shares wire semantics.
#[derive(
	Clone,
	Copy,
	Debug,
	Display,
	EnumString,
	Eq,
	Hash,
	IntoStaticStr,
	PartialEq,
	Serialize,
	Deserialize,
)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case", ascii_case_insensitive)]
pub enum ProviderFamily {
	/// OpenAI-compatible flex, scale, and priority tiers.
	OpenAi,
	/// Anthropic priority and fast-mode tiers.
	Anthropic,
	/// Google flex and priority tiers.
	Google,
	/// Provider-specific vocabulary without family defaults.
	Other,
}

/// Session role used when resolving an inherited tier intent.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TierAudience {
	/// Interactive or headless root session.
	Session,
	/// Spawned task agent.
	Subagent,
	/// Passive advisor.
	Advisor,
}

/// Declarative service-tier intent before child inheritance is resolved.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "mode", content = "tier")]
pub enum ServiceTierIntent {
	/// Preserve provider defaults.
	#[default]
	Unset,
	/// Reuse the parent session's concrete family tier.
	Inherit,
	/// Select an exact typed provider tier.
	Select(ServiceTier),
}

/// Per-family tier policy plus subagent/advisor inheritance controls.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct FamilyServiceTierPolicy {
	/// OpenAI-family session intent.
	pub openai:    ServiceTierIntent,
	/// Anthropic-family session intent.
	pub anthropic: ServiceTierIntent,
	/// Google-family session intent.
	pub google:    ServiceTierIntent,
	/// Spawned-agent override or inheritance.
	pub subagent:  ServiceTierIntent,
	/// Advisor override or inheritance.
	pub advisor:   ServiceTierIntent,
}

impl Default for FamilyServiceTierPolicy {
	fn default() -> Self {
		Self {
			openai:    ServiceTierIntent::Unset,
			anthropic: ServiceTierIntent::Unset,
			google:    ServiceTierIntent::Unset,
			subagent:  ServiceTierIntent::Inherit,
			advisor:   ServiceTierIntent::Inherit,
		}
	}
}

impl FamilyServiceTierPolicy {
	/// Resolves one concrete tier before canonical intent negotiation.
	pub fn resolve(
		&self,
		family: ProviderFamily,
		audience: TierAudience,
		parent: Option<&ServiceTier>,
	) -> Option<ServiceTier> {
		let family_intent = match family {
			ProviderFamily::OpenAi => &self.openai,
			ProviderFamily::Anthropic => &self.anthropic,
			ProviderFamily::Google => &self.google,
			ProviderFamily::Other => &ServiceTierIntent::Unset,
		};
		let audience_intent = match audience {
			TierAudience::Session => family_intent,
			TierAudience::Subagent => &self.subagent,
			TierAudience::Advisor => &self.advisor,
		};
		match audience_intent {
			ServiceTierIntent::Select(tier) => Some(tier.clone()),
			ServiceTierIntent::Inherit => parent.cloned().or_else(|| match family_intent {
				ServiceTierIntent::Select(tier) => Some(tier.clone()),
				ServiceTierIntent::Unset | ServiceTierIntent::Inherit => None,
			}),
			ServiceTierIntent::Unset => None,
		}
	}
}

impl ServiceTier {
	/// Validates and constructs a family-defined wire tier.
	pub fn for_family(family: ProviderFamily, name: &str) -> Option<Self> {
		let priority = match (family, name) {
			(ProviderFamily::OpenAi, "auto" | "default") => 0,
			(ProviderFamily::OpenAi, "flex") => -1,
			(ProviderFamily::OpenAi, "scale") => 1,
			(ProviderFamily::OpenAi, "priority") => 2,
			(ProviderFamily::Anthropic, "default") => 0,
			(ProviderFamily::Anthropic, "priority" | "fast") => 1,
			(ProviderFamily::Google, "default") => 0,
			(ProviderFamily::Google, "flex") => -1,
			(ProviderFamily::Google, "priority") => 1,
			(ProviderFamily::Other, _) | (..) => return None,
		};
		Some(Self { name: Str::new(name), priority })
	}
}

bitset!(/// Independent sampling controls.
	SamplingControlBits, u16);
impl SamplingControlBits {
	/// Frequency penalty.
	pub const FREQUENCY_PENALTY: Self = Self(1 << 3);
	/// Presence penalty.
	pub const PRESENCE_PENALTY: Self = Self(1 << 4);
	/// Stop sequences.
	pub const STOP: Self = Self(1 << 5);
	/// Temperature sampling.
	pub const TEMPERATURE: Self = Self(1 << 0);
	/// Top-k sampling.
	pub const TOP_K: Self = Self(1 << 2);
	/// Nucleus sampling.
	pub const TOP_P: Self = Self(1 << 1);
}

bitset!(/// Independent safety and context-filter controls.
	SafetyControlBits, u8);
impl SafetyControlBits {
	/// Context filtering can be configured.
	pub const CONTEXT_FILTERS: Self = Self(1 << 1);
	/// Provider safety thresholds can be selected.
	pub const SAFETY_SETTINGS: Self = Self(1 << 0);
}

bitset!(/// Independent deterministic-generation controls.
	DeterminismBits, u8);
impl DeterminismBits {
	/// A provider deterministic mode can be requested.
	pub const DETERMINISTIC_MODE: Self = Self(1 << 1);
	/// A numeric seed can be supplied.
	pub const SEED: Self = Self(1 << 0);
}

/// Server-side conversation-state constraints.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ServerStateCapabilities {
	/// Whether state handles may continue a previous response.
	pub continuation:         bool,
	/// Whether provider expiry evidence is available.
	pub expiry_evidence:      bool,
	/// Whether a fork must be reseeded from canonical history.
	pub fork_requires_reseed: bool,
}

/// Token-level log-probability constraints.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct LogProbabilityCapabilities {
	/// Largest supported number of alternative token probabilities.
	pub maximum_top_logprobs: u16,
	/// Whether prompt-token probabilities are available.
	pub prompt_logprobs:      bool,
}

/// Tool declaration and choice constraints.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ToolCapabilities {
	/// Independent supported tool behaviors.
	pub features:      ToolFeatureBits,
	/// Maximum declared tools per request, when bounded.
	pub maximum_tools: Option<u16>,
}

/// Complete chat capability axes.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ChatCapabilities {
	/// Roles accepted at conversation start.
	pub roles:             Availability<RoleBits>,
	/// Instruction roles accepted after conversation start.
	pub mid_session_roles: Availability<RoleBits>,
	/// Tool declaration, parallelism, schema, and choice support.
	pub tools:             Availability<ToolCapabilities>,
	/// Native JSON object and schema output support.
	pub structured_output: Availability<StructuredOutputBits>,
	/// Grammar-constrained generation support.
	pub grammar:           Availability<GrammarBits>,
	/// Text verbosity controls.
	pub text_verbosity:    Availability<TextVerbosityBits>,
	/// Reasoning visibility, effort, budget, and signature behavior.
	pub reasoning:         Availability<ReasoningCapabilities>,
	/// Media and document inputs accepted by chat.
	pub input_modalities:  Availability<ModalityBits>,
	/// Encoded image inputs accepted by the chat decoder.
	#[serde(default = "unknown_image_input")]
	pub image_input:       Availability<ImageInputCapabilities>,
	/// Provider-hosted tools callable inside chat.
	pub hosted_tools:      Availability<HostedToolBits>,
	/// Prompt cache and retention behavior.
	pub prompt_caching:    Availability<PromptCacheCapabilities>,
	/// Selectable provider service tiers.
	pub service_tiers:     Availability<Box<[ServiceTier]>>,
	/// Sampling controls.
	pub sampling:          Availability<SamplingControlBits>,
	/// Safety and context-filter controls.
	pub safety:            Availability<SafetyControlBits>,
	/// Seed and deterministic modes.
	pub determinism:       Availability<DeterminismBits>,
	/// Provider-side conversation state.
	pub server_state:      Availability<ServerStateCapabilities>,
	/// Token-level probability output.
	pub logprobs:          Availability<LogProbabilityCapabilities>,
}

const fn unknown_image_input() -> Availability<ImageInputCapabilities> {
	Availability::Unknown
}

/// Selectable embedding dimension bounds.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct DimensionRange {
	/// Smallest selectable dimension.
	pub minimum: u32,
	/// Largest selectable dimension.
	pub maximum: u32,
}

bitset!(/// Embedding output representations.
	EmbeddingFormatBits, u8);
impl EmbeddingFormatBits {
	/// Base64-encoded binary vector components.
	pub const BASE64: Self = Self(1 << 1);
	/// IEEE-754 vector components.
	pub const FLOAT: Self = Self(1 << 0);
	/// Quantized integer vector components.
	pub const QUANTIZED: Self = Self(1 << 2);
}

bitset!(/// Canonical embedding input representations.
	EmbeddingInputBits, u8);
impl EmbeddingInputBits {
	/// Text inputs encoded by the selected model's tokenizer.
	pub const TEXT: Self = Self(1 << 0);
	/// Pre-tokenized integer token identifier sequences.
	pub const TOKEN_IDS: Self = Self(1 << 1);
}

/// Embedding operation constraints.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct EmbeddingCapabilities {
	/// Accepted input modalities.
	pub input_modalities: ModalityBits,
	/// Accepted canonical input representations.
	pub input_kinds:      EmbeddingInputBits,
	/// Supported output representations.
	pub formats:          EmbeddingFormatBits,
	/// Maximum inputs in one batch, if bounded.
	pub maximum_batch:    Option<u32>,
	/// Selectable output dimensions.
	pub dimensions:       Availability<DimensionRange>,
}

bitset!(/// Image generation and editing behaviors.
	ImageFeatureBits, u8);
impl ImageFeatureBits {
	/// Existing-image editing.
	pub const EDIT: Self = Self(1 << 1);
	/// Text-to-image generation.
	pub const GENERATE: Self = Self(1 << 0);
	/// Masked inpainting.
	pub const MASK: Self = Self(1 << 2);
	/// Multiple candidates per request.
	pub const MULTIPLE: Self = Self(1 << 3);
}

/// Image operation constraints.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ImageCapabilities {
	/// Supported image behaviors.
	pub features:         ImageFeatureBits,
	/// Accepted input modalities.
	pub input_modalities: ModalityBits,
	/// Maximum generated images per request, if bounded.
	pub maximum_outputs:  Option<u16>,
	/// Maximum output pixels, if bounded.
	pub maximum_pixels:   Option<u64>,
}

bitset!(/// Video generation and editing behaviors.
	VideoFeatureBits, u8);
impl VideoFeatureBits {
	/// Generated audio tracks.
	pub const AUDIO_TRACK: Self = Self(1 << 3);
	/// Existing-video editing.
	pub const EDIT: Self = Self(1 << 2);
	/// Text-to-video generation.
	pub const GENERATE: Self = Self(1 << 0);
	/// Image-conditioned video generation.
	pub const IMAGE_CONDITIONING: Self = Self(1 << 1);
}

/// Video operation constraints.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct VideoCapabilities {
	/// Supported video behaviors.
	pub features:             VideoFeatureBits,
	/// Maximum duration in milliseconds, if bounded.
	pub maximum_duration_ms:  Option<u64>,
	/// Maximum output pixels per frame, if bounded.
	pub maximum_frame_pixels: Option<u64>,
}

bitset!(/// Speech synthesis behaviors.
	SpeechFeatureBits, u8);
impl SpeechFeatureBits {
	/// Caller-selected speaking speed.
	pub const SPEED: Self = Self(1 << 2);
	/// Streaming audio output.
	pub const STREAMING: Self = Self(1 << 0);
	/// Caller-supplied pronunciation or style instructions.
	pub const STYLE_INSTRUCTIONS: Self = Self(1 << 3);
	/// Caller-selected voices.
	pub const VOICE_SELECTION: Self = Self(1 << 1);
}

/// Speech synthesis constraints.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct SpeechCapabilities {
	/// Supported synthesis behaviors.
	pub features:                 SpeechFeatureBits,
	/// Maximum input characters, if bounded.
	pub maximum_input_characters: Option<u32>,
	/// Supported output audio encodings.
	pub output_formats:           AudioFormatBits,
}

bitset!(/// Canonical audio encodings.
	AudioFormatBits, u16);
impl AudioFormatBits {
	/// AAC stream or container.
	pub const AAC: Self = Self(1 << 4);
	/// FLAC container.
	pub const FLAC: Self = Self(1 << 5);
	/// MP3 container.
	pub const MP3: Self = Self(1 << 2);
	/// Opus stream or container.
	pub const OPUS: Self = Self(1 << 3);
	/// Raw linear PCM.
	pub const PCM: Self = Self(1 << 0);
	/// WAV container.
	pub const WAV: Self = Self(1 << 1);
}

bitset!(/// Transcription behaviors.
	TranscriptionFeatureBits, u8);
impl TranscriptionFeatureBits {
	/// Speaker diarization.
	pub const DIARIZATION: Self = Self(1 << 1);
	/// Language auto-detection.
	pub const LANGUAGE_DETECTION: Self = Self(1 << 4);
	/// Streaming partial transcripts.
	pub const STREAMING: Self = Self(1 << 0);
	/// Translation into another language.
	pub const TRANSLATION: Self = Self(1 << 3);
	/// Word timestamps.
	pub const WORD_TIMESTAMPS: Self = Self(1 << 2);
}

/// Speech transcription constraints.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct TranscriptionCapabilities {
	/// Supported transcription behaviors.
	pub features:            TranscriptionFeatureBits,
	/// Accepted audio encodings.
	pub input_formats:       AudioFormatBits,
	/// Maximum input duration in milliseconds, if bounded.
	pub maximum_duration_ms: Option<u64>,
}

bitset!(/// Realtime session behaviors.
	RealtimeFeatureBits, u16);
impl RealtimeFeatureBits {
	/// Bidirectional audio events.
	pub const AUDIO: Self = Self(1 << 1);
	/// Server-side voice activity detection.
	pub const SERVER_VAD: Self = Self(1 << 5);
	/// Bidirectional text events.
	pub const TEXT: Self = Self(1 << 0);
	/// Tool call events.
	pub const TOOLS: Self = Self(1 << 2);
	/// WebRTC transport.
	pub const WEBRTC: Self = Self(1 << 4);
	/// WebSocket transport.
	pub const WEBSOCKET: Self = Self(1 << 3);
}

/// Realtime session constraints.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct RealtimeCapabilities {
	/// Supported realtime behaviors and transports.
	pub features:           RealtimeFeatureBits,
	/// Maximum session duration in milliseconds, if bounded.
	pub maximum_session_ms: Option<u64>,
	/// Supported audio encodings.
	pub audio_formats:      AudioFormatBits,
}

bitset!(/// Standalone search controls.
	SearchFeatureBits, u8);
impl SearchFeatureBits {
	/// Provider-generated answer synthesis.
	pub const ANSWER_SYNTHESIS: Self = Self(1 << 3);
	/// Included or excluded domain filters.
	pub const DOMAINS: Self = Self(1 << 1);
	/// Locale selection.
	pub const LOCALE: Self = Self(1 << 2);
	/// Recency filters.
	pub const RECENCY: Self = Self(1 << 0);
}

/// Standalone search constraints.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct SearchCapabilities {
	/// Supported search controls.
	pub features:        SearchFeatureBits,
	/// Maximum returned results, if bounded.
	pub maximum_results: Option<u16>,
}

bitset!(/// Tokenization-family operation support.
	TokenizationFeatureBits, u8);
impl TokenizationFeatureBits {
	/// Per-token byte spans.
	pub const BYTE_SPANS: Self = Self(1 << 3);
	/// Token counting.
	pub const COUNT: Self = Self(1 << 0);
	/// Token-to-text conversion.
	pub const DETOKENIZE: Self = Self(1 << 2);
	/// Text-to-token conversion.
	pub const TOKENIZE: Self = Self(1 << 1);
}

/// Token counting and tokenization constraints.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct TokenizationCapabilities {
	/// Supported tokenization behaviors.
	pub features:            TokenizationFeatureBits,
	/// Maximum input bytes, if bounded.
	pub maximum_input_bytes: Option<u64>,
}

/// All model-scoped operation capabilities.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ModelCapabilities {
	/// Operations known to be supported by at least one eligible route.
	pub operations:    OperationBits,
	/// Conversational generation capabilities.
	pub chat:          Option<ChatCapabilities>,
	/// Embedding capabilities.
	pub embeddings:    Option<EmbeddingCapabilities>,
	/// Image generation and editing capabilities.
	pub image:         Option<ImageCapabilities>,
	/// Video generation and editing capabilities.
	pub video:         Option<VideoCapabilities>,
	/// Speech synthesis capabilities.
	pub speech:        Option<SpeechCapabilities>,
	/// Speech transcription capabilities.
	pub transcription: Option<TranscriptionCapabilities>,
	/// Realtime session capabilities.
	pub realtime:      Option<RealtimeCapabilities>,
	/// Standalone search capabilities.
	pub search:        Option<SearchCapabilities>,
	/// Token counting and token conversion capabilities.
	pub tokenization:  Option<TokenizationCapabilities>,
}

#[cfg(test)]
mod tests {
	use super::*;
	#[test]
	fn stb_image_input_formats_exclude_webp() {
		assert!(ImageInputFormatBits::STB.contains(ImageInputFormatBits::PNG));
		assert!(ImageInputFormatBits::STB.contains(ImageInputFormatBits::JPEG));
		assert!(ImageInputFormatBits::STB.contains(ImageInputFormatBits::GIF));
		assert!(!ImageInputFormatBits::STB.contains(ImageInputFormatBits::WEBP));
		assert!(ImageInputFormatBits::ALL.contains(ImageInputFormatBits::WEBP));
	}

	#[test]
	fn child_tier_inherits_concrete_parent_family_intent() {
		let parent = ServiceTier::for_family(ProviderFamily::OpenAi, "priority").expect("tier");
		let policy = FamilyServiceTierPolicy::default();
		assert_eq!(
			policy.resolve(ProviderFamily::OpenAi, TierAudience::Subagent, Some(&parent)),
			Some(parent)
		);
		assert!(ServiceTier::for_family(ProviderFamily::Anthropic, "flex").is_none());
	}
}
