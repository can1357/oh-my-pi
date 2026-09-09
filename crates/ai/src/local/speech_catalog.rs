//! Backend-neutral speech catalog and artifact-backed cache snapshots.

use std::{collections::HashSet, path::PathBuf};

use omp_core::Str;
use serde::{Deserialize, Serialize};
use strum::{Display, EnumString, IntoStaticStr};

use super::{
	artifact::{
		ArtifactCacheState, ArtifactError, ArtifactManifest, ArtifactResult, ArtifactShard,
		ArtifactSpec, ArtifactStore, sha256_digest,
	},
	runtime::{LocalCancellation, LocalResult},
};
pub use crate::speech_settings::KokoroVoice;

/// Stable setting key for the selected speech-to-text preset.
pub const STT_MODEL_SETTING: &str = "stt.modelName";
/// Stable setting key for the selected local text-to-speech model.
pub const TTS_MODEL_SETTING: &str = "tts.localModel";
/// Stable setting key for the local text-to-speech voice.
pub const TTS_VOICE_SETTING: &str = "tts.localVoice";
/// Stable setting key for assistant-output vocalization voice.
pub const SPEECH_VOICE_SETTING: &str = "speech.voice";
/// Stable setting key for realtime voice.
pub const LIVE_VOICE_SETTING: &str = "live.voice";
/// Stable setting key for local/cloud text-to-speech routing.
pub const TTS_PROVIDER_SETTING: &str = "providers.tts";

/// Stable default speech-to-text preset.
pub const DEFAULT_STT_PRESET: SttPreset = SttPreset::Parakeet;
/// Stable default local text-to-speech model.
pub const DEFAULT_TTS_MODEL: &str = "kokoro";
/// Stable default Kokoro voice.
pub const DEFAULT_KOKORO_VOICE: KokoroVoice = KokoroVoice::AfHeart;
/// Stable default realtime voice.
pub const DEFAULT_LIVE_VOICE: LiveVoice = LiveVoice::Sol;
/// Stable default xAI Grok Voice built-in voice.
pub const DEFAULT_XAI_VOICE: XaiVoice = XaiVoice::Eve;
/// Stable default text-to-speech provider routing policy.
pub const DEFAULT_TTS_PROVIDER: &str = "auto";

/// Stable local speech-to-text preset id.
#[derive(
	Clone,
	Copy,
	Debug,
	Deserialize,
	Display,
	EnumString,
	Eq,
	Hash,
	IntoStaticStr,
	PartialEq,
	Serialize,
)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case", ascii_case_insensitive)]
pub enum SttPreset {
	/// Whisper base multilingual preset.
	Fast,
	/// Whisper small multilingual preset.
	Balanced,
	/// Whisper large-v3-turbo multilingual preset.
	Turbo,
	/// NVIDIA Parakeet TDT 0.6B v3 preset.
	Parakeet,
}

/// Stable realtime voice id.
#[derive(
	Clone,
	Copy,
	Debug,
	Deserialize,
	Display,
	EnumString,
	Eq,
	Hash,
	IntoStaticStr,
	PartialEq,
	Serialize,
)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case", ascii_case_insensitive)]
pub enum LiveVoice {
	/// Arbor realtime voice.
	Arbor,
	/// Breeze realtime voice.
	Breeze,
	/// Cove realtime voice.
	Cove,
	/// Ember realtime voice.
	Ember,
	/// Juniper realtime voice.
	Juniper,
	/// Maple realtime voice.
	Maple,
	/// Sol realtime voice.
	Sol,
	/// Spruce realtime voice.
	Spruce,
	/// Vale realtime voice.
	Vale,
}

/// Built-in xAI Grok Voice id. xAI may additionally accept custom ids.
#[derive(
	Clone,
	Copy,
	Debug,
	Deserialize,
	Display,
	EnumString,
	Eq,
	Hash,
	IntoStaticStr,
	PartialEq,
	Serialize,
)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case", ascii_case_insensitive)]
pub enum XaiVoice {
	/// Ara built-in voice.
	Ara,
	/// Eve built-in voice.
	Eve,
	/// Leo built-in voice.
	Leo,
	/// Rex built-in voice.
	Rex,
	/// Sal built-in voice.
	Sal,
}

/// Exactly four supported local speech-to-text presets in picker order.
pub const STT_PRESETS: [SttPreset; 4] =
	[SttPreset::Fast, SttPreset::Balanced, SttPreset::Turbo, SttPreset::Parakeet];

/// Exactly twelve curated Kokoro voices in picker order.
pub const KOKORO_VOICES: [KokoroVoice; 12] = [
	KokoroVoice::AfHeart,
	KokoroVoice::AfBella,
	KokoroVoice::AfNicole,
	KokoroVoice::AfAoede,
	KokoroVoice::AfKore,
	KokoroVoice::AfSarah,
	KokoroVoice::AmMichael,
	KokoroVoice::AmFenrir,
	KokoroVoice::AmPuck,
	KokoroVoice::BfEmma,
	KokoroVoice::BmGeorge,
	KokoroVoice::BmFable,
];

/// Exactly nine supported realtime voices in picker order.
pub const LIVE_VOICES: [LiveVoice; 9] = [
	LiveVoice::Arbor,
	LiveVoice::Breeze,
	LiveVoice::Cove,
	LiveVoice::Ember,
	LiveVoice::Juniper,
	LiveVoice::Maple,
	LiveVoice::Sol,
	LiveVoice::Spruce,
	LiveVoice::Vale,
];

/// xAI's documented built-in voices in picker order.
pub const XAI_VOICES: [XaiVoice; 5] =
	[XaiVoice::Ara, XaiVoice::Eve, XaiVoice::Leo, XaiVoice::Rex, XaiVoice::Sal];

#[derive(Clone, Copy)]
struct SttMetadata {
	id:          SttPreset,
	label:       &'static str,
	description: &'static str,
}

const STT_METADATA: [SttMetadata; 4] = [
	SttMetadata {
		id:          SttPreset::Fast,
		label:       "Fast (Whisper base)",
		description: "Whisper base, multilingual. Smallest and fastest; best for low-resource \
		              machines.",
	},
	SttMetadata {
		id:          SttPreset::Balanced,
		label:       "Balanced (Whisper small)",
		description: "Whisper small, multilingual. More accurate than Fast while remaining light on \
		              CPU and memory.",
	},
	SttMetadata {
		id:          SttPreset::Turbo,
		label:       "Turbo (Whisper large-v3)",
		description: "Whisper large-v3-turbo, multilingual. Widest language coverage and largest \
		              download.",
	},
	SttMetadata {
		id:          SttPreset::Parakeet,
		label:       "Parakeet TDT v3 (SoTA)",
		description: "NVIDIA Parakeet TDT 0.6B v3, 25 languages. Default for accuracy and decoding \
		              throughput.",
	},
];

#[derive(Clone, Copy)]
struct VoiceMetadata<I> {
	id:    I,
	label: &'static str,
}

const KOKORO_METADATA: [VoiceMetadata<KokoroVoice>; 12] = [
	VoiceMetadata { id: KokoroVoice::AfHeart, label: "Heart (American female)" },
	VoiceMetadata { id: KokoroVoice::AfBella, label: "Bella (American female)" },
	VoiceMetadata { id: KokoroVoice::AfNicole, label: "Nicole (American female)" },
	VoiceMetadata { id: KokoroVoice::AfAoede, label: "Aoede (American female)" },
	VoiceMetadata { id: KokoroVoice::AfKore, label: "Kore (American female)" },
	VoiceMetadata { id: KokoroVoice::AfSarah, label: "Sarah (American female)" },
	VoiceMetadata { id: KokoroVoice::AmMichael, label: "Michael (American male)" },
	VoiceMetadata { id: KokoroVoice::AmFenrir, label: "Fenrir (American male)" },
	VoiceMetadata { id: KokoroVoice::AmPuck, label: "Puck (American male)" },
	VoiceMetadata { id: KokoroVoice::BfEmma, label: "Emma (British female)" },
	VoiceMetadata { id: KokoroVoice::BmGeorge, label: "George (British male)" },
	VoiceMetadata { id: KokoroVoice::BmFable, label: "Fable (British male)" },
];

const LIVE_METADATA: [VoiceMetadata<LiveVoice>; 9] = [
	VoiceMetadata { id: LiveVoice::Arbor, label: "Arbor" },
	VoiceMetadata { id: LiveVoice::Breeze, label: "Breeze" },
	VoiceMetadata { id: LiveVoice::Cove, label: "Cove" },
	VoiceMetadata { id: LiveVoice::Ember, label: "Ember" },
	VoiceMetadata { id: LiveVoice::Juniper, label: "Juniper" },
	VoiceMetadata { id: LiveVoice::Maple, label: "Maple" },
	VoiceMetadata { id: LiveVoice::Sol, label: "Sol" },
	VoiceMetadata { id: LiveVoice::Spruce, label: "Spruce" },
	VoiceMetadata { id: LiveVoice::Vale, label: "Vale" },
];

const XAI_METADATA: [VoiceMetadata<XaiVoice>; 5] = [
	VoiceMetadata { id: XaiVoice::Ara, label: "Ara" },
	VoiceMetadata { id: XaiVoice::Eve, label: "Eve" },
	VoiceMetadata { id: XaiVoice::Leo, label: "Leo" },
	VoiceMetadata { id: XaiVoice::Rex, label: "Rex" },
	VoiceMetadata { id: XaiVoice::Sal, label: "Sal" },
];

/// Platform/backend manifests associated with backend-neutral catalog ids.
#[derive(Clone, Debug)]
pub struct SpeechArtifactManifests {
	stt:    [(SttPreset, ArtifactManifest); 4],
	kokoro: ArtifactManifest,
}

impl SpeechArtifactManifests {
	/// Builds the revision-pinned speech artifact portfolio.
	///
	/// Whisper and Parakeet use Candle-compatible safetensors checkpoints, while
	/// Kokoro uses the safetensors conversion consumed by the local Kokoro
	/// engine. Kokoro's single manifest deliberately
	/// includes every curated voice so switching voices never performs network
	/// I/O after the model becomes ready.
	pub fn curated() -> Result<Self, SpeechCatalogError> {
		const WHISPER_BASE_REVISION: &str = "e37978b90ca9030d5170a5c07aadb050351a65bb";
		const WHISPER_SMALL_REVISION: &str = "973afd24965f72e36ca33b3055d56a652f456b4d";
		const WHISPER_TURBO_REVISION: &str = "41f01f3fe87f28c78e2fbf8b568835947dd65ed9";
		const PARAKEET_REVISION: &str = "ed2b7e8c15f9aaa0b5772e2efb986255eaef7e15";
		const KOKORO_REVISION: &str = "e02c9eada7ce7416798af36b190a8a2dd2ecd566";

		let whisper_base = "https://huggingface.co/openai/whisper-base/resolve";
		let fast = ArtifactManifest::new("stt-fast-whisper-base", vec![
			speech_shard(
				"speech/stt/fast/model.safetensors",
				&format!("{whisper_base}/{WHISPER_BASE_REVISION}/model.safetensors"),
				290_403_936,
				b"07cadb9f25677c8d50df603e66a98fbd842cce45047139baeb16e6219a1e807b",
			),
			speech_shard(
				"speech/stt/fast/config.json",
				&format!("{whisper_base}/{WHISPER_BASE_REVISION}/config.json"),
				1_983,
				b"1617473816d10137971c1cbd9b8a529ade4343d63af95d727993d3706aae6423",
			),
			speech_shard(
				"speech/stt/fast/tokenizer.json",
				&format!("{whisper_base}/{WHISPER_BASE_REVISION}/tokenizer.json"),
				2_480_466,
				b"5aca11a905abd927aac05308d59a1bf7d307367224036974527ed96f1bab867e",
			),
		])
		.map_err(|source| SpeechCatalogError::Artifact { source })?;
		let whisper_small = "https://huggingface.co/openai/whisper-small/resolve";
		let balanced = ArtifactManifest::new("stt-balanced-whisper-small", vec![
			speech_shard(
				"speech/stt/balanced/model.safetensors",
				&format!("{whisper_small}/{WHISPER_SMALL_REVISION}/model.safetensors"),
				966_995_080,
				b"1d7734884874f1a1513ed9aa760a4f8e97aaa02fd6d93a3a85d27b2ae9ca596b",
			),
			speech_shard(
				"speech/stt/balanced/config.json",
				&format!("{whisper_small}/{WHISPER_SMALL_REVISION}/config.json"),
				1_967,
				b"e6a2b489da1b5aed65a8eb8d1e7466fa867ad5643a8bc138ba708bd56b2875c4",
			),
			speech_shard(
				"speech/stt/balanced/tokenizer.json",
				&format!("{whisper_small}/{WHISPER_SMALL_REVISION}/tokenizer.json"),
				2_480_466,
				b"27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566",
			),
		])
		.map_err(|source| SpeechCatalogError::Artifact { source })?;
		let whisper_turbo = "https://huggingface.co/openai/whisper-large-v3-turbo/resolve";
		let turbo = ArtifactManifest::new("stt-turbo-whisper-large-v3-turbo", vec![
			speech_shard(
				"speech/stt/turbo/model.safetensors",
				&format!("{whisper_turbo}/{WHISPER_TURBO_REVISION}/model.safetensors"),
				1_617_824_864,
				b"542566a422ae4f3fd23f1ba11add198fca01bbf82e66e6a2857b3f608b1eb9d1",
			),
			speech_shard(
				"speech/stt/turbo/config.json",
				&format!("{whisper_turbo}/{WHISPER_TURBO_REVISION}/config.json"),
				1_256,
				b"c5b526b3e3cd64cd8940dabb45e8ba726629e22d8ed389c29b552f9140daf04a",
			),
			speech_shard(
				"speech/stt/turbo/tokenizer.json",
				&format!("{whisper_turbo}/{WHISPER_TURBO_REVISION}/tokenizer.json"),
				2_710_337,
				b"297b13372ac43916285644fb9687add3cc62ee2a1adb60da3dc25cc94c1871fd",
			),
		])
		.map_err(|source| SpeechCatalogError::Artifact { source })?;
		let parakeet_base = "https://huggingface.co/mlx-community/parakeet-tdt-0.6b-v3/resolve";
		let parakeet = ArtifactManifest::new("stt-parakeet-tdt-0.6b-v3", vec![
			speech_shard(
				"speech/stt/parakeet/model.safetensors",
				&format!("{parakeet_base}/{PARAKEET_REVISION}/model.safetensors"),
				2_508_288_736,
				b"05e01c7f396c298cf7d23f61da7b504adeab698f0aaeafd9c82d198625464592",
			),
			speech_shard(
				"speech/stt/parakeet/config.json",
				&format!("{parakeet_base}/{PARAKEET_REVISION}/config.json"),
				244_093,
				b"f320f1292511f34ec47f513755fe20fd01dbfc09a925d42730e66059a6e1ef4c",
			),
			speech_shard(
				"speech/stt/parakeet/vocab.txt",
				&format!("{parakeet_base}/{PARAKEET_REVISION}/vocab.txt"),
				46_772,
				b"3cde1409fd78783a79b29ed4d32da57c746993856f7c8263bcb905d2e5839db7",
			),
		])
		.map_err(|source| SpeechCatalogError::Artifact { source })?;

		let kokoro_base = "https://huggingface.co/prince-canuma/Kokoro-82M/resolve";
		let mut kokoro_shards = Vec::with_capacity(14);
		kokoro_shards.push(speech_shard(
			"speech/tts/kokoro/config.json",
			&format!("{kokoro_base}/{KOKORO_REVISION}/config.json"),
			2_351,
			b"5abb01e2403b072bf03d04fde160443e209d7a0dad49a423be15196b9b43c17f",
		));
		kokoro_shards.push(speech_shard(
			"speech/tts/kokoro/kokoro-v1_0.safetensors",
			&format!("{kokoro_base}/{KOKORO_REVISION}/kokoro-v1_0.safetensors"),
			327_115_152,
			b"4e9ecdf03b8b6cf906070390237feda473dc13327cb8d56a43deaa374c02acd8",
		));
		for (voice, digest) in [
			("af_heart", b"4e40b08984cd84a86b4d07960939bd85bb6b3747dd747b7de48dca3aaeab37ca"),
			("af_bella", b"a18024b9332f5ff217c7f604cbe94449a3ca51c3b8d85500e31cd3cbdc4ef6ce"),
			("af_nicole", b"769ee38efeb131196eaab5ed43592b315bba829881d4aee7411872efa6cf05c6"),
			("af_aoede", b"fce9bf78661a0444ca333f5687183d850bfb73b71c67f2678dd5ddb3ac3a96d2"),
			("af_kore", b"71fb664533d3bcbed8cf96eafe9280dfa7c244302ded62501a0b42d18377ed1b"),
			("af_sarah", b"2bc36ea1b08925188da3c81e30858952bec28fbb61512bdd573312e5a62dd3f9"),
			("am_michael", b"19a8661430456e2bbf0a68b52fa9b49678bb0fb7418619f868df77921f5aa43c"),
			("am_fenrir", b"843c5a6abcd2f25f242e1bf3b008c3c8fcc8f6d99f081767275e1c852eb7beee"),
			("am_puck", b"a6be98717a1332b631c689c25b69e6e0e48693453002d160d0690a80cf989d47"),
			("bf_emma", b"ed92055e1ed96f2a0b4a52b76956dcfd76627bd548c33801743a62c0817dec01"),
			("bm_george", b"a3a6682cde622e7aee35597b91947fa018f78be101a97587a100effe227e5a21"),
			("bm_fable", b"146cd42da875a06d45b9808f5dbdc1b0485283a590187aaeffda64239f0faa54"),
		] {
			let relative = format!("speech/tts/kokoro/voices/{voice}.safetensors");
			let source = format!("{kokoro_base}/{KOKORO_REVISION}/voices/{voice}.safetensors");
			kokoro_shards.push(speech_shard(&relative, &source, 522_339, digest));
		}
		let kokoro = ArtifactManifest::new("tts-kokoro-82m-v1.0", kokoro_shards)
			.map_err(|source| SpeechCatalogError::Artifact { source })?;

		Self::new(
			[
				(SttPreset::Fast, fast),
				(SttPreset::Balanced, balanced),
				(SttPreset::Turbo, turbo),
				(SttPreset::Parakeet, parakeet),
			],
			kokoro,
		)
	}

	/// Constructs bindings and enforces exactly one manifest per STT preset.
	pub fn new(
		stt: [(SttPreset, ArtifactManifest); 4],
		kokoro: ArtifactManifest,
	) -> Result<Self, SpeechCatalogError> {
		let mut ids = HashSet::with_capacity(stt.len());
		for (id, manifest) in &stt {
			manifest
				.validate()
				.map_err(|source| SpeechCatalogError::Artifact { source })?;
			if !ids.insert(*id) {
				return Err(SpeechCatalogError::DuplicateSttPreset { preset: *id });
			}
		}
		if STT_PRESETS.iter().any(|id| !ids.contains(id)) {
			return Err(SpeechCatalogError::MissingSttPreset);
		}
		kokoro
			.validate()
			.map_err(|source| SpeechCatalogError::Artifact { source })?;
		Ok(Self { stt, kokoro })
	}

	/// Returns the platform manifest for one STT preset.
	pub fn stt_manifest(&self, preset: SttPreset) -> &ArtifactManifest {
		self
			.stt
			.iter()
			.find_map(|(id, manifest)| (*id == preset).then_some(manifest))
			.expect("constructor proves every STT preset has one manifest")
	}

	/// Returns the platform manifest for Kokoro-82M.
	pub const fn kokoro_manifest(&self) -> &ArtifactManifest {
		&self.kokoro
	}

	/// Verifies and returns the engine paths for one STT preset in manifest
	/// order.
	pub fn verified_stt_paths(
		&self,
		store: &ArtifactStore,
		preset: SttPreset,
		cancel: &LocalCancellation,
	) -> LocalResult<Vec<PathBuf>> {
		verified_paths(store, self.stt_manifest(preset), cancel)
	}

	/// Verifies and returns Kokoro config, weights, and all voice paths.
	pub fn verified_kokoro_paths(
		&self,
		store: &ArtifactStore,
		cancel: &LocalCancellation,
	) -> LocalResult<Vec<PathBuf>> {
		verified_paths(store, self.kokoro_manifest(), cancel)
	}
}

fn verified_paths(
	store: &ArtifactStore,
	manifest: &ArtifactManifest,
	cancel: &LocalCancellation,
) -> LocalResult<Vec<PathBuf>> {
	manifest
		.shards
		.iter()
		.map(|shard| {
			store
				.verify(&shard.spec, cancel)
				.map(|artifact| artifact.path().to_path_buf())
		})
		.collect()
}

fn speech_shard(path: &str, source: &str, bytes: u64, digest: &[u8; 64]) -> ArtifactShard {
	ArtifactShard {
		spec:   ArtifactSpec { path: PathBuf::from(path), bytes, sha256: sha256_digest(digest) },
		source: Str::new(source),
	}
}

/// Invalid platform artifact bindings for the speech catalog.
#[derive(Debug, thiserror::Error)]
pub enum SpeechCatalogError {
	/// The same STT preset was bound more than once.
	#[error("speech artifact bindings contain duplicate STT preset {preset}")]
	DuplicateSttPreset {
		/// Repeated preset.
		preset: SttPreset,
	},
	/// One of the four required STT presets had no binding.
	#[error("speech artifact bindings must contain every STT preset exactly once")]
	MissingSttPreset,
	/// An artifact manifest was invalid.
	#[error("speech artifact manifest is invalid")]
	Artifact {
		/// Typed manifest failure.
		#[source]
		source: ArtifactError,
	},
}

/// Stable settings-key projection for ACP, setup, and native frontends.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechSettingKeys {
	/// Speech-to-text model setting.
	pub speech_to_text_model:    Str,
	/// Local text-to-speech model setting.
	pub text_to_speech_model:    Str,
	/// Local text-to-speech voice setting.
	pub text_to_speech_voice:    Str,
	/// Assistant vocalization voice setting.
	pub speech_voice:            Str,
	/// Realtime voice setting.
	pub live_voice:              Str,
	/// Text-to-speech provider route setting.
	pub text_to_speech_provider: Str,
}

/// Stable catalog defaults.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechDefaults {
	/// Default speech-to-text preset.
	pub speech_to_text_model:    SttPreset,
	/// Default local text-to-speech model.
	pub text_to_speech_model:    Str,
	/// Default Kokoro voice.
	pub text_to_speech_voice:    KokoroVoice,
	/// Default assistant-vocalization voice.
	pub speech_voice:            KokoroVoice,
	/// Default realtime voice.
	pub live_voice:              LiveVoice,
	/// Default xAI built-in voice.
	pub xai_voice:               XaiVoice,
	/// Default text-to-speech provider route.
	pub text_to_speech_provider: Str,
}

/// Capabilities of the shared verified artifact downloader.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactDownloadCapabilities {
	/// Downloads may be cancelled without publishing incomplete files.
	pub cancellable:        bool,
	/// Valid sidecars may be resumed.
	pub resumable:          bool,
	/// Every promoted file is length- and SHA-256-verified.
	pub checksum_verified:  bool,
	/// Multi-shard progress is aggregate and monotonic.
	pub aggregate_progress: bool,
	/// Promotion replaces final paths atomically.
	pub atomic_promotion:   bool,
	/// Whether this particular model has more than one shard.
	pub multi_shard:        bool,
}

impl ArtifactDownloadCapabilities {
	const fn for_manifest(manifest: &ArtifactManifest) -> Self {
		Self {
			cancellable:        true,
			resumable:          true,
			checksum_verified:  true,
			aggregate_progress: true,
			atomic_promotion:   true,
			multi_shard:        manifest.shards.len() > 1,
		}
	}
}

/// Serializable labeled voice option.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SpeechVoiceOption {
	/// Stable voice id.
	pub value: Str,
	/// Human-readable label.
	pub label: Str,
}

/// Serializable STT model option with actual artifact cache evidence.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechToTextModelOption {
	/// Stable preset id.
	pub value:       SttPreset,
	/// Human-readable label.
	pub label:       Str,
	/// Concise picker description.
	pub description: Str,
	/// Cache evidence derived from manifest files and checksums.
	pub cache:       ArtifactCacheState,
	/// Shared downloader capabilities.
	pub download:    ArtifactDownloadCapabilities,
}

/// Serializable local TTS model option with voices and cache evidence.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextToSpeechModelOption {
	/// Stable model id.
	pub value:       Str,
	/// Human-readable label.
	pub label:       Str,
	/// Concise picker description.
	pub description: Str,
	/// Native PCM sample rate.
	pub sample_rate: u32,
	/// Voice choices which require no additional download.
	pub voices:      Vec<SpeechVoiceOption>,
	/// Cache evidence derived from manifest files and checksums.
	pub cache:       ArtifactCacheState,
	/// Shared downloader capabilities.
	pub download:    ArtifactDownloadCapabilities,
}

/// Serializable STT section.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechToTextCatalog {
	/// Owning setting key.
	pub setting:       Str,
	/// Stable default preset.
	pub default_value: SttPreset,
	/// Exactly four preset options.
	pub models:        Vec<SpeechToTextModelOption>,
}

/// Serializable local TTS section.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextToSpeechCatalog {
	/// Owning model setting key.
	pub model_setting:        Str,
	/// Owning direct-TTS voice setting key.
	pub voice_setting:        Str,
	/// Owning assistant-vocalization voice setting key.
	pub speech_voice_setting: Str,
	/// Stable default model.
	pub default_model:        Str,
	/// Stable default voice.
	pub default_voice:        KokoroVoice,
	/// Kokoro model entry.
	pub models:               Vec<TextToSpeechModelOption>,
	/// Default-model voice options.
	pub voices:               Vec<SpeechVoiceOption>,
}

/// Serializable realtime-voice section.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveSpeechCatalog {
	/// Owning setting key.
	pub setting:       Str,
	/// Stable default voice.
	pub default_voice: LiveVoice,
	/// Exactly nine realtime voices.
	pub voices:        Vec<SpeechVoiceOption>,
}

/// Serializable xAI speech section.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XaiSpeechCatalog {
	/// Stable default built-in voice.
	pub default_voice:    XaiVoice,
	/// Documented built-in voices.
	pub built_in_voices:  Vec<SpeechVoiceOption>,
	/// Whether caller-supplied custom voice ids are accepted.
	pub custom_voice_ids: bool,
}

/// Serializable backend-neutral speech catalog snapshot.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechCatalogSnapshot {
	/// Stable settings-key map.
	pub settings:       SpeechSettingKeys,
	/// Stable defaults.
	pub defaults:       SpeechDefaults,
	/// Local STT section.
	pub speech_to_text: SpeechToTextCatalog,
	/// Local TTS section.
	pub text_to_speech: TextToSpeechCatalog,
	/// Realtime voice section.
	pub live:           LiveSpeechCatalog,
	/// Hosted xAI voice section.
	pub xai:            XaiSpeechCatalog,
}

/// Stateless owner of the canonical speech catalog.
#[derive(Clone, Copy, Debug, Default)]
pub struct SpeechCatalog;

impl SpeechCatalog {
	/// Builds a serializable snapshot whose cache fields are derived from actual
	/// manifest artifacts in `store`.
	pub fn snapshot(
		&self,
		store: &ArtifactStore,
		artifacts: &SpeechArtifactManifests,
		cancel: &LocalCancellation,
	) -> ArtifactResult<SpeechCatalogSnapshot> {
		let mut stt_models = Vec::with_capacity(STT_METADATA.len());
		for metadata in STT_METADATA {
			let manifest = artifacts.stt_manifest(metadata.id);
			stt_models.push(SpeechToTextModelOption {
				value:       metadata.id,
				label:       Str::from(metadata.label),
				description: Str::from(metadata.description),
				cache:       store.inspect_manifest(manifest, cancel)?,
				download:    ArtifactDownloadCapabilities::for_manifest(manifest),
			});
		}
		let voices = KOKORO_METADATA
			.iter()
			.map(|voice| voice_option(voice.id.into(), voice.label))
			.collect::<Vec<_>>();
		let kokoro = artifacts.kokoro_manifest();
		let tts_model = TextToSpeechModelOption {
			value:       Str::from(DEFAULT_TTS_MODEL),
			label:       Str::from("Kokoro-82M"),
			description: Str::from(
				"Kokoro-82M neural TTS with multi-voice, fully local 24 kHz synthesis.",
			),
			sample_rate: 24_000,
			voices:      voices.clone(),
			cache:       store.inspect_manifest(kokoro, cancel)?,
			download:    ArtifactDownloadCapabilities::for_manifest(kokoro),
		};
		Ok(SpeechCatalogSnapshot {
			settings:       SpeechSettingKeys {
				speech_to_text_model:    Str::from(STT_MODEL_SETTING),
				text_to_speech_model:    Str::from(TTS_MODEL_SETTING),
				text_to_speech_voice:    Str::from(TTS_VOICE_SETTING),
				speech_voice:            Str::from(SPEECH_VOICE_SETTING),
				live_voice:              Str::from(LIVE_VOICE_SETTING),
				text_to_speech_provider: Str::from(TTS_PROVIDER_SETTING),
			},
			defaults:       SpeechDefaults {
				speech_to_text_model:    DEFAULT_STT_PRESET,
				text_to_speech_model:    Str::from(DEFAULT_TTS_MODEL),
				text_to_speech_voice:    DEFAULT_KOKORO_VOICE,
				speech_voice:            DEFAULT_KOKORO_VOICE,
				live_voice:              DEFAULT_LIVE_VOICE,
				xai_voice:               DEFAULT_XAI_VOICE,
				text_to_speech_provider: Str::from(DEFAULT_TTS_PROVIDER),
			},
			speech_to_text: SpeechToTextCatalog {
				setting:       Str::from(STT_MODEL_SETTING),
				default_value: DEFAULT_STT_PRESET,
				models:        stt_models,
			},
			text_to_speech: TextToSpeechCatalog {
				model_setting: Str::from(TTS_MODEL_SETTING),
				voice_setting: Str::from(TTS_VOICE_SETTING),
				speech_voice_setting: Str::from(SPEECH_VOICE_SETTING),
				default_model: Str::from(DEFAULT_TTS_MODEL),
				default_voice: DEFAULT_KOKORO_VOICE,
				models: vec![tts_model],
				voices,
			},
			live:           LiveSpeechCatalog {
				setting:       Str::from(LIVE_VOICE_SETTING),
				default_voice: DEFAULT_LIVE_VOICE,
				voices:        LIVE_METADATA
					.iter()
					.map(|voice| voice_option(voice.id.into(), voice.label))
					.collect(),
			},
			xai:            XaiSpeechCatalog {
				default_voice:    DEFAULT_XAI_VOICE,
				built_in_voices:  XAI_METADATA
					.iter()
					.map(|voice| voice_option(voice.id.into(), voice.label))
					.collect(),
				custom_voice_ids: true,
			},
		})
	}
}

fn voice_option(id: &'static str, label: &'static str) -> SpeechVoiceOption {
	SpeechVoiceOption { value: Str::from(id), label: Str::from(label) }
}

#[cfg(test)]
mod tests {
	use std::fs;

	use sha2::{Digest as _, Sha256};
	use tempfile::tempdir;

	use super::*;
	use crate::local::artifact::{ArtifactCacheStatus, ArtifactShard, ArtifactSpec};

	fn manifest(id: &str, path: &str, bytes: &[u8]) -> ArtifactManifest {
		ArtifactManifest::new(id, vec![ArtifactShard {
			spec:   ArtifactSpec {
				path:   path.into(),
				bytes:  bytes.len() as u64,
				sha256: Sha256::digest(bytes).into(),
			},
			source: Str::from("https://fixtures.invalid/artifact"),
		}])
		.unwrap()
	}

	#[test]
	fn catalog_has_exact_stable_ids_defaults_and_setting_keys() {
		assert_eq!(STT_PRESETS.len(), 4);
		assert_eq!(HashSet::from(STT_PRESETS).len(), 4);
		assert_eq!(DEFAULT_STT_PRESET, SttPreset::Parakeet);
		assert_eq!(KOKORO_VOICES.len(), 12);
		assert_eq!(HashSet::from(KOKORO_VOICES).len(), 12);
		assert_eq!(<&'static str>::from(DEFAULT_KOKORO_VOICE), "af_heart");
		assert_eq!(LIVE_VOICES.len(), 9);
		assert_eq!(HashSet::from(LIVE_VOICES).len(), 9);
		assert_eq!(<&'static str>::from(DEFAULT_LIVE_VOICE), "sol");
		assert_eq!(HashSet::from(XAI_VOICES).len(), XAI_VOICES.len());
		assert_eq!(<&'static str>::from(DEFAULT_XAI_VOICE), "eve");
		assert_eq!(STT_MODEL_SETTING, "stt.modelName");
		assert_eq!(TTS_MODEL_SETTING, "tts.localModel");
		assert_eq!(TTS_VOICE_SETTING, "tts.localVoice");
		assert_eq!(SPEECH_VOICE_SETTING, "speech.voice");
		assert_eq!(LIVE_VOICE_SETTING, "live.voice");
	}

	#[test]
	fn snapshot_cache_state_comes_from_verified_files_and_sidecars() {
		let directory = tempdir().expect("temporary artifact root");
		let store = ArtifactStore::open(directory.path()).unwrap();
		let fast = manifest("fast", "fast.bin", b"fast");
		let balanced = manifest("balanced", "balanced.bin", b"balanced");
		let turbo = manifest("turbo", "turbo.bin", b"turbo");
		let parakeet = manifest("parakeet", "parakeet.bin", b"parakeet");
		let kokoro = manifest("kokoro", "kokoro.bin", b"kokoro");
		fs::write(directory.path().join("fast.bin"), b"fast").unwrap();
		fs::write(directory.path().join("balanced.bin.part"), b"bal").unwrap();
		fs::write(directory.path().join("turbo.bin"), b"wrong").unwrap();
		fs::write(directory.path().join("kokoro.bin"), b"kokoro").unwrap();
		let artifacts = SpeechArtifactManifests::new(
			[
				(SttPreset::Fast, fast),
				(SttPreset::Balanced, balanced),
				(SttPreset::Turbo, turbo),
				(SttPreset::Parakeet, parakeet),
			],
			kokoro,
		)
		.unwrap();
		let snapshot = SpeechCatalog
			.snapshot(&store, &artifacts, &LocalCancellation::new())
			.unwrap();
		assert_eq!(snapshot.speech_to_text.models.len(), 4);
		assert_eq!(snapshot.speech_to_text.models[0].cache.status, ArtifactCacheStatus::Ready);
		assert_eq!(snapshot.speech_to_text.models[1].cache.status, ArtifactCacheStatus::Partial);
		assert_eq!(snapshot.speech_to_text.models[2].cache.status, ArtifactCacheStatus::Corrupt);
		assert_eq!(snapshot.speech_to_text.models[3].cache.status, ArtifactCacheStatus::Missing);
		assert_eq!(snapshot.text_to_speech.models.len(), 1);
		assert_eq!(snapshot.text_to_speech.models[0].voices.len(), 12);
		assert_eq!(snapshot.text_to_speech.models[0].cache.status, ArtifactCacheStatus::Ready);
		assert_eq!(snapshot.live.voices.len(), 9);
		assert_eq!(snapshot.xai.built_in_voices.len(), 5);
		assert!(snapshot.xai.custom_voice_ids);
	}

	#[test]
	fn artifact_bindings_reject_duplicate_or_missing_presets() {
		let fixture = || manifest("fixture", "fixture.bin", b"fixture");
		let result = SpeechArtifactManifests::new(
			[
				(SttPreset::Fast, fixture()),
				(SttPreset::Fast, fixture()),
				(SttPreset::Turbo, fixture()),
				(SttPreset::Parakeet, fixture()),
			],
			fixture(),
		);
		assert!(matches!(result, Err(SpeechCatalogError::DuplicateSttPreset { .. })));
	}
	#[test]
	fn curated_manifests_bind_every_runtime_file() {
		let artifacts = SpeechArtifactManifests::curated().expect("curated manifests");
		assert_eq!(artifacts.stt_manifest(SttPreset::Fast).shards.len(), 3);
		assert_eq!(artifacts.stt_manifest(SttPreset::Balanced).shards.len(), 3);
		assert_eq!(artifacts.stt_manifest(SttPreset::Turbo).shards.len(), 3);
		assert_eq!(artifacts.stt_manifest(SttPreset::Parakeet).shards.len(), 3);
		assert_eq!(artifacts.kokoro_manifest().shards.len(), 14);
		assert!(
			artifacts
				.kokoro_manifest()
				.shards
				.iter()
				.any(|shard| { shard.spec.path.ends_with("voices/af_heart.safetensors") })
		);
		assert!(
			artifacts
				.kokoro_manifest()
				.shards
				.iter()
				.all(|shard| { shard.source.as_str().contains("/resolve/") && shard.spec.bytes > 0 })
		);
	}
}
