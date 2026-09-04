//! Backend-neutral speech synthesis settings shared by local and hosted
//! producers.

use serde::{Deserialize, Serialize};
use strum::{Display, EnumString, IntoStaticStr};

/// Backend preference for generated speech files.
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
pub enum TtsProvider {
	/// Prefer local synthesis unless the requested format requires a hosted
	/// backend.
	#[default]
	Auto,
	/// Require local Kokoro synthesis.
	Local,
	/// Require hosted xAI synthesis.
	Xai,
	/// Require hosted `DeepInfra` synthesis.
	Deepinfra,
}

omp_con::con_enum!(TtsProvider);

/// Local speech synthesis model selection.
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
pub enum TtsModel {
	/// Kokoro-82M.
	#[default]
	Kokoro,
}

omp_con::con_enum!(TtsModel);

/// Stable curated Kokoro voice id.
#[derive(
	Clone,
	Copy,
	Debug,
	Default,
	Deserialize,
	Display,
	EnumString,
	Eq,
	Hash,
	IntoStaticStr,
	PartialEq,
	Serialize,
	strum::VariantNames,
)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case", ascii_case_insensitive)]
pub enum KokoroVoice {
	/// Heart, American female.
	#[default]
	AfHeart,
	/// Bella, American female.
	AfBella,
	/// Nicole, American female.
	AfNicole,
	/// Aoede, American female.
	AfAoede,
	/// Kore, American female.
	AfKore,
	/// Sarah, American female.
	AfSarah,
	/// Michael, American male.
	AmMichael,
	/// Fenrir, American male.
	AmFenrir,
	/// Puck, American male.
	AmPuck,
	/// Emma, British female.
	BfEmma,
	/// George, British male.
	BmGeorge,
	/// Fable, British male.
	BmFable,
}

omp_con::con_enum!(KokoroVoice);

omp_con::var! {
	/// Generated-speech provider routing policy.
	pub static AI_TTS_PROVIDER = ai_tts_provider: TtsProvider {
		default: TtsProvider::Auto,
		flags: archive,
		meta: {
			"legacy.path": "providers.tts",
		},
	};
	/// On-device neural TTS model (Kokoro-82M) used by the local TTS backend
	pub static CL_TTS_MODEL = cl_tts_model: TtsModel {
		default: TtsModel::Kokoro,
		flags: archive,
		meta: {
			"ui.tab": "providers",
			"ui.group": "Services",
			"ui.label": "Local TTS Model",
			"ui.option.kokoro": "Kokoro-82M",
			"ui.option.kokoro.desc": "Kokoro-82M neural TTS — SoTA on-device quality, multi-voice, fully local",
			"legacy.path": "tts.localModel",
		},
	};
	/// Direct local synthesis voice.
	pub static CL_TTS_VOICE = cl_tts_voice: KokoroVoice {
		default: KokoroVoice::AfHeart,
		flags: archive,
		meta: {
			"legacy.path": "tts.localVoice",
		},
	};
}
