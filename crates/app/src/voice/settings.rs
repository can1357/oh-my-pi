//! Voice command-stream variables.

pub use omp_ai::speech_settings::{
	AI_TTS_PROVIDER, CL_TTS_MODEL, CL_TTS_VOICE, KokoroVoice, TtsModel, TtsProvider,
};
use omp_core::Str;
use serde::{Deserialize, Serialize};
use strum::{Display, EnumString, IntoStaticStr};

/// Dictation auto-submit policy.
#[derive(
	Clone,
	Copy,
	Debug,
	Default,
	Deserialize,
	Display,
	EnumString,
	Eq,
	IntoStaticStr,
	PartialEq,
	Serialize,
	strum::VariantNames,
)]
#[serde(rename_all = "kebab-case")]
#[strum(serialize_all = "kebab-case", ascii_case_insensitive)]
pub enum SttSubmitTrigger {
	/// Never submit automatically.
	#[default]
	Never,
	/// Submit a sufficiently long utterance when capture is released.
	Release,
	/// Submit only a complete sentence when capture is released.
	ReleaseComplete,
	/// Submit when the user speaks the submit trigger.
	SaySubmit,
}

/// Which assistant output is vocalized.
#[derive(
	Clone,
	Copy,
	Debug,
	Default,
	Deserialize,
	Display,
	EnumString,
	Eq,
	IntoStaticStr,
	PartialEq,
	Serialize,
	strum::VariantNames,
)]
#[serde(rename_all = "lowercase")]
#[strum(serialize_all = "lowercase", ascii_case_insensitive)]
pub enum SpeechMode {
	/// Speak assistant messages and thinking.
	All,
	/// Speak assistant messages without thinking.
	#[default]
	Assistant,
	/// Speak only the final message at turn completion.
	Yield,
}

omp_con::con_enum!(SttSubmitTrigger);
omp_con::con_enum!(SpeechMode);

/// Speech recognition model selection.
#[derive(
	Clone, Copy, Debug, Default, EnumString, Eq, IntoStaticStr, PartialEq, strum::VariantNames,
)]
#[strum(serialize_all = "lowercase", ascii_case_insensitive)]
pub enum SttModel {
	/// Parakeet TDT v3.
	#[default]
	Parakeet,
	/// Whisper Base.
	Fast,
	/// Whisper Small.
	Balanced,
	/// Whisper Large v3 Turbo.
	Turbo,
}

omp_con::con_enum!(SttModel);

/// Realtime provider voice selection.
#[derive(
	Clone, Copy, Debug, Default, EnumString, Eq, IntoStaticStr, PartialEq, strum::VariantNames,
)]
#[strum(serialize_all = "lowercase", ascii_case_insensitive)]
pub enum LiveVoice {
	/// Arbor.
	Arbor,
	/// Breeze.
	Breeze,
	/// Cove.
	Cove,
	/// Ember.
	Ember,
	/// Juniper.
	Juniper,
	/// Maple.
	Maple,
	/// Sol.
	#[default]
	Sol,
	/// Spruce.
	Spruce,
	/// Vale.
	Vale,
}

omp_con::con_enum!(LiveVoice);

omp_con::var! {
	/// Enable speech-to-text input via microphone.
	pub static CL_VOICE_STT_ENABLED = cl_voice_stt_enabled: bool {
		default: false,
		flags: archive,
		meta: {
			"ui.tab": "interaction",
			"ui.group": "Speech",
			"ui.label": "Speech-to-Text",
			"legacy.path": "stt.enabled",
		},
	};
	/// Speech recognition language hint.
	pub static CL_STT_LANGUAGE = cl_stt_language: Str {
		default: Str::new_static("en"),
		flags: archive,
		meta: {
			"legacy.path": "stt.language",
		},
	};
	/// Local on-device speech model. Parakeet TDT v3 (sherpa-onnx) is the SoTA
	/// default; Whisper base/small/large-v3-turbo tiers (transformers.js) trade
	/// size for multilingual coverage. Downloaded on first use.
	pub static CL_STT_MODEL = cl_stt_model: SttModel {
		default: SttModel::Parakeet,
		flags: archive,
		meta: {
			"ui.tab": "interaction",
			"ui.group": "Speech",
			"ui.label": "Speech Model",
			"ui.option.fast": "Fast (Whisper base)",
			"ui.option.fast.desc": "Whisper base, multilingual. Smallest + fastest; lowest accuracy. Best for low-resource machines.",
			"ui.option.balanced": "Balanced (Whisper small)",
			"ui.option.balanced.desc": "Whisper small, multilingual. More accurate than Fast, still light on CPU/RAM.",
			"ui.option.turbo": "Turbo (Whisper large-v3)",
			"ui.option.turbo.desc": "Whisper large-v3-turbo, 99 languages. Widest language coverage; large download, slower.",
			"ui.option.parakeet": "Parakeet TDT v3 (SoTA)",
			"ui.option.parakeet.desc": "NVIDIA Parakeet TDT 0.6B v3, 25 languages. Open ASR Leaderboard leader — best accuracy and far fastest decoding. Default.",
			"legacy.path": "stt.modelName",
		},
	};
	/// Choose when speech dictation automatically submits: Never, Release (2+
	/// words), Release with complete sentence, or When I Say Submit.
	pub static CL_STT_SUBMIT_TRIGGER = cl_stt_submit_trigger: SttSubmitTrigger {
		default: SttSubmitTrigger::Never,
		flags: archive,
		meta: {
			"ui.tab": "interaction",
			"ui.group": "Speech",
			"ui.label": "Speech-to-Text Submit Trigger",
			"ui.option.never": "Never",
			"ui.option.never.desc": "Never automatically submit; insert dictation and remain in editor.",
			"ui.option.release": "Release",
			"ui.option.release.desc": "Submit on release if the utterance has 2+ words to avoid accidental sends.",
			"ui.option.release-complete": "Release with complete sentence",
			"ui.option.release-complete.desc": "Submit on release if the utterance ends with sentence-terminal punctuation (. ? ! etc.).",
			"ui.option.say-submit": "When I Say Submit",
			"ui.option.say-submit.desc": "Submit if the utterance ends with a word containing 'submit' (strips that word before submitting).",
			"legacy.path": "stt.submitTrigger",
		},
	};
	/// Speak the assistant's output aloud through the speakers as it streams.
	pub static CL_SPEECH_ENABLED = cl_speech_enabled: bool {
		default: false,
		flags: archive,
		meta: {
			"ui.tab": "providers",
			"ui.group": "Services",
			"ui.label": "Speech Vocalization",
			"legacy.path": "speech.enabled",
		},
	};
	/// What to speak: all = assistant messages + thinking; assistant = messages
	/// only; yield = only the final message at turn end.
	pub static CL_SPEECH_MODE = cl_speech_mode: SpeechMode {
		default: SpeechMode::Assistant,
		flags: archive,
		meta: {
			"ui.tab": "providers",
			"ui.group": "Services",
			"ui.label": "Speech Vocalization Mode",
			"ui.option.all": "All (messages + thinking)",
			"ui.option.assistant": "Assistant messages",
			"ui.option.yield": "Final message only",
			"legacy.path": "speech.mode",
		},
	};
	/// Enables natural speech rewriting.
	pub static CL_SPEECH_ENHANCED = cl_speech_enhanced: bool {
		default: false,
		flags: archive,
		meta: {
			"legacy.path": "speech.enhanced",
		},
	};
	/// Kokoro voice used when speaking the assistant's output aloud.
	pub static CL_SPEECH_VOICE = cl_speech_voice: KokoroVoice {
		default: KokoroVoice::AfHeart,
		flags: archive,
		meta: {
			"ui.tab": "providers",
			"ui.group": "Services",
			"ui.label": "Speech Vocalization Voice",
			"ui.option.af_heart": "Heart (American female)",
			"ui.option.af_bella": "Bella (American female)",
			"ui.option.af_nicole": "Nicole (American female)",
			"ui.option.af_aoede": "Aoede (American female)",
			"ui.option.af_kore": "Kore (American female)",
			"ui.option.af_sarah": "Sarah (American female)",
			"ui.option.am_michael": "Michael (American male)",
			"ui.option.am_fenrir": "Fenrir (American male)",
			"ui.option.am_puck": "Puck (American male)",
			"ui.option.bf_emma": "Emma (British female)",
			"ui.option.bm_george": "George (British male)",
			"ui.option.bm_fable": "Fable (British male)",
			"legacy.path": "speech.voice",
		},
	};
	/// Voice used by Codex-backed realtime voice sessions.
	pub static CL_LIVE_VOICE = cl_live_voice: LiveVoice {
		default: LiveVoice::Sol,
		flags: archive,
		meta: {
			"ui.tab": "providers",
			"ui.group": "Services",
			"ui.label": "Live Voice",
			"legacy.path": "live.voice",
		},
	};
	/// Stable realtime microphone device ID; empty selects the system default.
	pub static CL_LIVE_INPUT_DEVICE = cl_live_input_device: Str {
		default: Str::default(),
		flags: archive
	};
	/// Stable realtime speaker device ID; empty selects the system default.
	pub static CL_LIVE_OUTPUT_DEVICE = cl_live_output_device: Str {
		default: Str::default(),
		flags: archive
	};
}
