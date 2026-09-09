//! Stable Kokoro-82M model and voice registration.

/// Engine model id shared with speech settings and artifact manifests.
pub const MODEL_ID: &str = "kokoro";
/// Native model sample rate.
pub const SAMPLE_RATE: u32 = 24_000;
/// Default flagship grade-A voice.
pub const DEFAULT_VOICE: &str = "af_heart";

/// One built-in Kokoro voice.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct VoiceSpec {
	/// Stable voice id.
	pub id:    &'static str,
	/// Picker label.
	pub label: &'static str,
}

/// Exactly twelve curated American and British voices in picker order.
pub const VOICES: [VoiceSpec; 12] = [
	VoiceSpec { id: "af_heart", label: "Heart (American female)" },
	VoiceSpec { id: "af_bella", label: "Bella (American female)" },
	VoiceSpec { id: "af_nicole", label: "Nicole (American female)" },
	VoiceSpec { id: "af_aoede", label: "Aoede (American female)" },
	VoiceSpec { id: "af_kore", label: "Kore (American female)" },
	VoiceSpec { id: "af_sarah", label: "Sarah (American female)" },
	VoiceSpec { id: "am_michael", label: "Michael (American male)" },
	VoiceSpec { id: "am_fenrir", label: "Fenrir (American male)" },
	VoiceSpec { id: "am_puck", label: "Puck (American male)" },
	VoiceSpec { id: "bf_emma", label: "Emma (British female)" },
	VoiceSpec { id: "bm_george", label: "George (British male)" },
	VoiceSpec { id: "bm_fable", label: "Fable (British male)" },
];

/// Complete local engine registration.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ModelRegistration {
	/// Stable model id.
	pub id:            &'static str,
	/// Native output sample rate.
	pub sample_rate:   u32,
	/// Default voice id.
	pub default_voice: &'static str,
	/// Curated built-in voices.
	pub voices:        &'static [VoiceSpec],
}

/// Kokoro-82M engine registration consumed by the inference adapter.
pub const REGISTRATION: ModelRegistration = ModelRegistration {
	id:            MODEL_ID,
	sample_rate:   SAMPLE_RATE,
	default_voice: DEFAULT_VOICE,
	voices:        &VOICES,
};

/// Resolves a voice, falling back for stale ids and the legacy `default`
/// sentinel.
pub fn resolve_voice(requested: Option<&str>) -> &'static VoiceSpec {
	requested
		.filter(|voice| *voice != "default")
		.and_then(|voice| VOICES.iter().find(|candidate| candidate.id == voice))
		.unwrap_or(&VOICES[0])
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn registration_is_stable_and_stale_voices_fall_back() {
		assert_eq!(REGISTRATION.voices.len(), 12);
		assert_eq!(REGISTRATION.default_voice, "af_heart");
		assert_eq!(resolve_voice(Some("bm_fable")).id, "bm_fable");
		assert_eq!(resolve_voice(Some("stale")).id, "af_heart");
		assert_eq!(resolve_voice(Some("default")).id, "af_heart");
	}
}
