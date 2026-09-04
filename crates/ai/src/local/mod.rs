//! In-process inference with shared bounded lifecycle and verified artifacts.

/// Apple Foundation Models dynamic runtime.
#[cfg(feature = "local-applefm")]
pub mod applefm;
/// Verified, root-confined model artifacts.
pub mod artifact;
/// FastEmbed local embeddings.
/// Named tiny-model device preferences and fallback order.
pub mod device;
#[cfg(feature = "local-embedding")]
pub mod embedding;
/// llama.cpp GGUF text generation.
/// Bounded tiny-message preprocessing and structural chat formatting.
pub mod message_preproc;
/// Candle Parakeet speech recognition.
#[cfg(feature = "local-stt")]
pub mod parakeet;
/// Shared admission, memory, cancellation, and idle-unload lifecycle.
pub mod runtime;
/// Backend-neutral speech catalog and artifact-backed cache snapshots.
pub mod speech_catalog;
/// Candle Whisper speech recognition.
#[cfg(feature = "local-stt")]
pub mod stt;
/// Curated GGUF title, memory, and classifier artifacts.
pub mod tiny_catalog;
/// Tiny generated-title validation and casing reconciliation.
pub mod title;
/// Kokoro-82M speech synthesis.
#[cfg(feature = "local-tts")]
pub mod tts;

pub use artifact::{
	ArtifactCacheState, ArtifactCacheStatus, ArtifactError, ArtifactFetchRequest,
	ArtifactFetchResponse, ArtifactFetcher, ArtifactIoOperation, ArtifactManifest,
	ArtifactManifestReceipt, ArtifactProgress, ArtifactReceipt, ArtifactResult, ArtifactShard,
	ArtifactSpec, ArtifactStore, SystemArtifactBody, SystemArtifactFetcher, VerifiedArtifact,
	sha256_digest,
};
pub use runtime::{
	AdmissionControl, AvailabilityEvidence, LocalCancellation, LocalError, LocalErrorKind,
	LocalExecutionReceipt, LocalResult, LocalRuntime, MemoryPool, MemoryReservation, RuntimeLease,
};
pub use speech_catalog::{
	ArtifactDownloadCapabilities, DEFAULT_KOKORO_VOICE, DEFAULT_LIVE_VOICE, DEFAULT_STT_PRESET,
	DEFAULT_TTS_MODEL, DEFAULT_TTS_PROVIDER, DEFAULT_XAI_VOICE, KOKORO_VOICES, KokoroVoice,
	LIVE_VOICE_SETTING, LIVE_VOICES, LiveSpeechCatalog, LiveVoice, SPEECH_VOICE_SETTING,
	STT_MODEL_SETTING, STT_PRESETS, SpeechArtifactManifests, SpeechCatalog, SpeechCatalogError,
	SpeechCatalogSnapshot, SpeechDefaults, SpeechSettingKeys, SpeechToTextCatalog,
	SpeechToTextModelOption, SpeechVoiceOption, SttPreset, TTS_MODEL_SETTING, TTS_PROVIDER_SETTING,
	TTS_VOICE_SETTING, TextToSpeechCatalog, TextToSpeechModelOption, XAI_VOICES, XaiSpeechCatalog,
	XaiVoice,
};
pub use tiny_catalog::{
	CLASSIFIER_MODELS, DEFAULT_MEMORY_LOCAL_MODEL, DEFAULT_TITLE_LOCAL_MODEL, MEMORY_MODEL_SETTING,
	MEMORY_MODELS, ONLINE_TINY_MODEL, TINY_MODEL_SETTING, TITLE_MODELS, TinyArtifact,
	TinyBlockedEvidence, TinyModelSpec, TinyWorkload, model as tiny_model, models as tiny_models,
};
