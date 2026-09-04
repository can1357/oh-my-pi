//! Curated GGUF artifacts for title, memory, and tiny-classifier inference.

use std::path::PathBuf;

use omp_core::Str;

use super::artifact::{
	ArtifactManifest, ArtifactResult, ArtifactShard, ArtifactSpec, sha256_digest,
};

/// Persisted sentinel selecting the deterministic online role chain.
pub const ONLINE_TINY_MODEL: &str = "online";
/// Default local title model when an explicit local download is requested.
pub const DEFAULT_TITLE_LOCAL_MODEL: &str = "lfm2-700m";
/// Default local model for memory and classifier work.
pub const DEFAULT_MEMORY_LOCAL_MODEL: &str = "lfm2-1.2b";
/// Stable settings key for title-model selection.
pub const TINY_MODEL_SETTING: &str = "providers.tinyModel";
/// Stable settings key for Mnemopi's model selection.
pub const MEMORY_MODEL_SETTING: &str = "providers.memoryModel";

/// One native tiny-model workload.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TinyWorkload {
	/// Three-to-six-word session titles.
	Title,
	/// Bounded Mnemopi extraction and consolidation completions.
	Memory,
	/// Closed-ladder difficulty classification.
	Classifier,
}

/// Evidence explaining an upstream model/runtime combination that is
/// deliberately blocked.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TinyBlockedEvidence {
	/// Runtime to which the block applies.
	pub runtime:     &'static str,
	/// Actionable reason for the block.
	pub reason:      &'static str,
	/// Whether the block also applies to OMP's native GGUF runtime.
	pub blocks_gguf: bool,
}

/// Immutable identity of one curated `Q4_K_M` GGUF artifact.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TinyArtifact {
	/// Root-relative cache path.
	pub path:   &'static str,
	/// Revision-pinned public source.
	pub source: &'static str,
	/// Exact file length.
	pub bytes:  u64,
	/// Exact SHA-256 digest published by Hugging Face LFS.
	pub sha256: [u8; 32],
}

impl TinyArtifact {
	/// Builds the shared verified-download manifest for this artifact.
	pub fn manifest(self, id: &'static str) -> ArtifactResult<ArtifactManifest> {
		ArtifactManifest::new(id, vec![ArtifactShard {
			spec:   ArtifactSpec {
				path:   PathBuf::from(self.path),
				bytes:  self.bytes,
				sha256: self.sha256,
			},
			source: Str::new_static(self.source),
		}])
	}
}

/// Curated native tiny-model metadata.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TinyModelSpec {
	/// Stable persisted model id.
	pub id:               &'static str,
	/// Picker label.
	pub label:            &'static str,
	/// User-facing selection guidance.
	pub description:      &'static str,
	/// Model family.
	pub family:           &'static str,
	/// Whether the chat template may emit hidden reasoning.
	pub reasoning:        bool,
	/// Context allocation used by the role adapter.
	pub context_tokens:   u32,
	/// Verified `Q4_K_M` artifact.
	pub artifact:         TinyArtifact,
	/// Upstream blocked-runtime evidence, when one exists.
	pub blocked_evidence: Option<TinyBlockedEvidence>,
}

impl TinyModelSpec {
	/// Builds this model's verified-download manifest.
	pub fn manifest(self) -> ArtifactResult<ArtifactManifest> {
		self.artifact.manifest(self.id)
	}
}

/// Title registry for native GGUF `Q4_K_M` artifacts.
pub const TITLE_MODELS: [TinyModelSpec; 5] = [
	TinyModelSpec {
		id: "lfm2-350m",
		label: "LFM2 350M",
		description: "Smallest fast local title model; best on constrained machines.",
		family: "lfm2",
		reasoning: false,
		context_tokens: 4_096,
		artifact: TinyArtifact {
			path: "tiny/lfm2-350m/LFM2-350M-Q4_K_M.gguf",
			source: "https://huggingface.co/LiquidAI/LFM2-350M-GGUF/resolve/8fdc9d526b7ed346b19257551b05816c7912ecc2/LFM2-350M-Q4_K_M.gguf",
			bytes: 229_309_376,
			sha256: sha256_digest(b"a4d000c7064bd3b2e42c6845836286a899a4e79cf1791da1a6797b58d575957d"),
		},
		blocked_evidence: None,
	},
	TinyModelSpec {
		id: "qwen3-0.6b",
		label: "Qwen3 0.6B",
		description: "Most robust local title option; slower first load.",
		family: "qwen3",
		reasoning: true,
		context_tokens: 4_096,
		artifact: TinyArtifact {
			path: "tiny/qwen3-0.6b/Qwen_Qwen3-0.6B-Q4_K_M.gguf",
			source: "https://huggingface.co/bartowski/Qwen_Qwen3-0.6B-GGUF/resolve/60b85c0e3d8fe0f6474f406922a26d12aca4550d/Qwen_Qwen3-0.6B-Q4_K_M.gguf",
			bytes: 484_220_320,
			sha256: sha256_digest(b"9acfc1e001311f34b4252001b626f2e466d592a42065f66571bff3790d4e1b14"),
		},
		blocked_evidence: None,
	},
	TinyModelSpec {
		id: "gemma-270m",
		label: "Gemma 270M",
		description: "Smallest viable title model; lowest cache footprint.",
		family: "gemma3",
		reasoning: false,
		context_tokens: 4_096,
		artifact: TinyArtifact {
			path: "tiny/gemma-270m/google_gemma-3-270m-it-Q4_K_M.gguf",
			source: "https://huggingface.co/bartowski/google_gemma-3-270m-it-GGUF/resolve/d127a4e2c6ed47fdf409a956867b604c040432f9/google_gemma-3-270m-it-Q4_K_M.gguf",
			bytes: 253_115_168,
			sha256: sha256_digest(b"c866c9f113f2e9aa2225c5997ede437392b8fa844ba5db9e4c77e315ffe20800"),
		},
		blocked_evidence: None,
	},
	TinyModelSpec {
		id: "qwen2.5-0.5b",
		label: "Qwen2.5 0.5B",
		description: "Balanced local fallback with moderate startup cost.",
		family: "qwen2.5",
		reasoning: false,
		context_tokens: 4_096,
		artifact: TinyArtifact {
			path: "tiny/qwen2.5-0.5b/Qwen2.5-0.5B-Instruct-Q4_K_M.gguf",
			source: "https://huggingface.co/bartowski/Qwen2.5-0.5B-Instruct-GGUF/resolve/41ba88dbac95fed2528c92514c131d73eb5a174b/Qwen2.5-0.5B-Instruct-Q4_K_M.gguf",
			bytes: 397_808_192,
			sha256: sha256_digest(b"6eb923e7d26e9cea28811e1a8e852009b21242fb157b26149d3b188f3a8c8653"),
		},
		blocked_evidence: None,
	},
	TinyModelSpec {
		id: "lfm2-700m",
		label: "LFM2 700M",
		description: "Highest-quality recommended local title model.",
		family: "lfm2",
		reasoning: false,
		context_tokens: 4_096,
		artifact: TinyArtifact {
			path: "tiny/lfm2-700m/LFM2-700M-Q4_K_M.gguf",
			source: "https://huggingface.co/LiquidAI/LFM2-700M-GGUF/resolve/43e05b4efd464155b3807bde379942bb43d8ee3c/LFM2-700M-Q4_K_M.gguf",
			bytes: 468_624_320,
			sha256: sha256_digest(b"684e8406dc13321452b3f6aeca432776e2a6a7e1ad6c23f7887b8fe3efbe2efa"),
		},
		blocked_evidence: None,
	},
];

/// Mnemopi registry, also used by the local difficulty classifier.
pub const MEMORY_MODELS: [TinyModelSpec; 5] = [
	TinyModelSpec {
		id: "qwen3-1.7b",
		label: "Qwen3 1.7B",
		description: "High-capacity memory model; native GGUF avoids the blocked ONNX cache path.",
		family: "qwen3",
		reasoning: true,
		context_tokens: 8_192,
		artifact: TinyArtifact {
			path: "tiny/qwen3-1.7b/Qwen_Qwen3-1.7B-Q4_K_M.gguf",
			source: "https://huggingface.co/bartowski/Qwen_Qwen3-1.7B-GGUF/resolve/dcb19155b962dbb6389f4691a982043a8e651022/Qwen_Qwen3-1.7B-Q4_K_M.gguf",
			bytes: 1_282_439_584,
			sha256: sha256_digest(b"72c5c3cb38fa32d5256e2fe30d03e7a64c6c79e668ad84057e3bd66e250b24fb"),
		},
		blocked_evidence: Some(TinyBlockedEvidence {
			runtime: "onnxruntime-node",
			reason: "Qwen3 RotaryEmbedding cache updates are unsupported by the ONNX runtime",
			blocks_gguf: false,
		}),
	},
	TinyModelSpec {
		id: "llama3.2:3b",
		label: "Llama 3.2 3B",
		description: "Largest local memory option; highest disk, RAM, and latency cost.",
		family: "llama3.2",
		reasoning: false,
		context_tokens: 8_192,
		artifact: TinyArtifact {
			path: "tiny/llama3.2-3b/Llama-3.2-3B-Instruct-Q4_K_M.gguf",
			source: "https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/5ab33fa94d1d04e903623ae72c95d1696f09f9e8/Llama-3.2-3B-Instruct-Q4_K_M.gguf",
			bytes: 2_019_377_696,
			sha256: sha256_digest(b"6c1a2b41161032677be168d354123594c0e6e67d2b9227c84f296ad037c728ff"),
		},
		blocked_evidence: None,
	},
	TinyModelSpec {
		id: "gemma-3-1b",
		label: "Gemma 3 1B",
		description: "Strong consolidation and deduplication at a lighter footprint.",
		family: "gemma3",
		reasoning: false,
		context_tokens: 8_192,
		artifact: TinyArtifact {
			path: "tiny/gemma-3-1b/google_gemma-3-1b-it-Q4_K_M.gguf",
			source: "https://huggingface.co/bartowski/google_gemma-3-1b-it-GGUF/resolve/116f76234503685a98f572982177b11d44ec8ff1/google_gemma-3-1b-it-Q4_K_M.gguf",
			bytes: 806_058_496,
			sha256: sha256_digest(b"12bf0fff8815d5f73a3c9b586bd8fee8e7b248c935de70dec367679873d0f29d"),
		},
		blocked_evidence: None,
	},
	TinyModelSpec {
		id: "qwen2.5-1.5b",
		label: "Qwen2.5 1.5B",
		description: "Fine-grained atomic fact extraction with weaker consolidation.",
		family: "qwen2.5",
		reasoning: false,
		context_tokens: 8_192,
		artifact: TinyArtifact {
			path: "tiny/qwen2.5-1.5b/Qwen2.5-1.5B-Instruct-Q4_K_M.gguf",
			source: "https://huggingface.co/bartowski/Qwen2.5-1.5B-Instruct-GGUF/resolve/9eadc66189c7641e1ddd226b8267a9119b2ce2d4/Qwen2.5-1.5B-Instruct-Q4_K_M.gguf",
			bytes: 986_048_768,
			sha256: sha256_digest(b"1adf0b11065d8ad2e8123ea110d1ec956dab4ab038eab665614adba04b6c3370"),
		},
		blocked_evidence: None,
	},
	TinyModelSpec {
		id: "lfm2-1.2b",
		label: "LFM2 1.2B",
		description: "Fastest-loading all-round memory and classifier model.",
		family: "lfm2",
		reasoning: false,
		context_tokens: 8_192,
		artifact: TinyArtifact {
			path: "tiny/lfm2-1.2b/LFM2-1.2B-Q4_K_M.gguf",
			source: "https://huggingface.co/LiquidAI/LFM2-1.2B-GGUF/resolve/5399e76c648f4eb8c053feb1ab747277dea5bf8b/LFM2-1.2B-Q4_K_M.gguf",
			bytes: 730_893_248,
			sha256: sha256_digest(b"55175400e3f509a9616227afeffd58d87e80b9f628a5d3d54ada884d85221fed"),
		},
		blocked_evidence: None,
	},
];

/// The classifier deliberately shares the memory registry and artifacts.
pub const CLASSIFIER_MODELS: &[TinyModelSpec] = &MEMORY_MODELS;

/// Resolves a model by stable id across title and memory registries.
pub fn model(id: &str) -> Option<&'static TinyModelSpec> {
	TITLE_MODELS
		.iter()
		.chain(MEMORY_MODELS.iter())
		.find(|spec| spec.id == id)
}

/// Borrows the exact registry for one workload.
pub const fn models(workload: TinyWorkload) -> &'static [TinyModelSpec] {
	match workload {
		TinyWorkload::Title => &TITLE_MODELS,
		TinyWorkload::Memory => &MEMORY_MODELS,
		TinyWorkload::Classifier => CLASSIFIER_MODELS,
	}
}

#[cfg(test)]
mod tests {
	use std::collections::HashSet;

	use super::*;

	#[test]
	fn registries_are_unique_and_manifests_are_verified() {
		let mut ids = HashSet::new();
		for spec in TITLE_MODELS.iter().chain(MEMORY_MODELS.iter()) {
			assert!(ids.insert(spec.id));
			let manifest = spec.manifest().expect("valid curated manifest");
			assert_eq!(manifest.shards.len(), 1);
			assert_eq!(manifest.shards[0].spec.bytes, spec.artifact.bytes);
		}
		assert_eq!(model(DEFAULT_TITLE_LOCAL_MODEL).map(|spec| spec.id), Some("lfm2-700m"));
		assert_eq!(model(DEFAULT_MEMORY_LOCAL_MODEL).map(|spec| spec.id), Some("lfm2-1.2b"));
	}

	#[test]
	fn classifier_reuses_memory_artifacts() {
		assert_eq!(CLASSIFIER_MODELS, MEMORY_MODELS);
		assert!(model("qwen3-1.7b").unwrap().blocked_evidence.is_some());
		assert!(
			!model("qwen3-1.7b")
				.unwrap()
				.blocked_evidence
				.unwrap()
				.blocks_gguf
		);
	}
}
