//! `FastEmbed`-backed local text embeddings.

use std::{
	collections::HashMap,
	path::PathBuf,
	sync::{Arc, LazyLock},
	time::Duration,
};

use fastembed::{TextEmbedding, TextInitOptions};
use omp_core::Str;
use serde::Deserialize;

use super::runtime::{
	LocalCancellation, LocalError, LocalErrorKind, LocalExecutionReceipt, LocalResult, LocalRuntime,
	MemoryPool,
};

const MODEL_CATALOG_JSON: &str = include_str!("embedding_models.json");

/// Third-party provenance disclosed for a model before `FastEmbed` can download
/// it.
///
/// A missing optional value means the bundled catalog does not establish that
/// fact. Downloaded model artifacts are never covered by OMP's project
/// licenses.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ModelDownloadMetadata {
	/// `FastEmbed` model variant name.
	pub model:               Str,
	/// Hugging Face repository `FastEmbed` downloads from.
	pub download_repository: Str,
	/// Repository-relative model artifact selected by `FastEmbed`.
	pub artifact:            Str,
	/// Immutable upstream revision, when established.
	pub source_revision:     Option<Str>,
	/// Upstream model license identifier or expression, when established.
	pub license:             Option<Str>,
	/// Upstream license text or terms URL, when established.
	pub license_url:         Option<Str>,
	/// Whether upstream requires affirmative acceptance, when established.
	pub acceptance_required: Option<bool>,
	/// Upstream acceptance flow or terms URL, when established.
	pub acceptance_url:      Option<Str>,
	/// Always false: downloaded artifacts are outside OMP's license grant.
	pub omp_license_applies: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ModelCatalog {
	schema_version:    u32,
	fastembed_version: Str,
	models:            Vec<ModelDownloadMetadata>,
}

static MODEL_CATALOG: LazyLock<Result<HashMap<Str, ModelDownloadMetadata>, String>> =
	LazyLock::new(parse_model_catalog);

fn model_catalog() -> LocalResult<&'static HashMap<Str, ModelDownloadMetadata>> {
	MODEL_CATALOG.as_ref().map_err(|error| {
		LocalError::new(
			LocalErrorKind::Backend,
			format!("FastEmbed model provenance catalog is invalid: {error}"),
		)
	})
}

/// Returns third-party metadata for a selected model without downloading it.
pub fn model_download_metadata(
	model: &fastembed::EmbeddingModel,
) -> LocalResult<&'static ModelDownloadMetadata> {
	let model_name = Str::new(model.to_string());
	model_catalog()?.get(&model_name).ok_or_else(|| {
		LocalError::new(
			LocalErrorKind::Backend,
			format!("FastEmbed model provenance is missing for {model_name}"),
		)
	})
}

fn parse_model_catalog() -> Result<HashMap<Str, ModelDownloadMetadata>, String> {
	let catalog: ModelCatalog =
		serde_json::from_str(MODEL_CATALOG_JSON).map_err(|error| error.to_string())?;
	if catalog.schema_version != 1 {
		return Err(format!("unsupported schema version {}", catalog.schema_version));
	}
	if catalog.fastembed_version.trim().is_empty() {
		return Err("FastEmbed version is empty".to_owned());
	}

	let mut entries = HashMap::with_capacity(catalog.models.len());
	for metadata in catalog.models {
		if metadata.model.trim().is_empty()
			|| metadata.download_repository.trim().is_empty()
			|| metadata.artifact.trim().is_empty()
		{
			return Err("model identity fields must be non-empty".to_owned());
		}
		if metadata.omp_license_applies {
			return Err(format!("{} incorrectly applies an OMP project license", metadata.model));
		}
		for (name, value) in [
			("source_revision", metadata.source_revision.as_deref()),
			("license", metadata.license.as_deref()),
			("license_url", metadata.license_url.as_deref()),
			("acceptance_url", metadata.acceptance_url.as_deref()),
		] {
			if value.is_some_and(|value| value.trim().is_empty()) {
				return Err(format!("{} has an empty {name}", metadata.model));
			}
		}
		if metadata.acceptance_required == Some(true) && metadata.acceptance_url.is_none() {
			return Err(format!("{} requires acceptance without an acceptance URL", metadata.model));
		}
		let model = metadata.model.clone();
		if entries.insert(model.clone(), metadata).is_some() {
			return Err(format!("duplicate model {model}"));
		}
	}

	let supported = TextEmbedding::list_supported_models();
	if entries.len() != supported.len() {
		return Err(format!(
			"catalog has {} entries but FastEmbed exposes {} models",
			entries.len(),
			supported.len()
		));
	}
	for info in supported {
		let model = info.model.to_string();
		let metadata = entries
			.get(model.as_str())
			.ok_or_else(|| format!("missing FastEmbed model {model}"))?;
		if metadata.download_repository.as_str() != info.model_code.as_str()
			|| metadata.artifact.as_str() != info.model_file.as_str()
		{
			return Err(format!("{model} download identity does not match FastEmbed"));
		}
	}
	Ok(entries)
}

/// Configuration for a real `FastEmbed` model.
#[derive(Clone, Debug)]
pub struct EmbeddingConfig {
	/// Model from `FastEmbed`'s typed catalog.
	pub model:           fastembed::EmbeddingModel,
	/// Hugging Face cache used by `FastEmbed`.
	pub cache_dir:       PathBuf,
	/// Maximum tokenized input length.
	pub max_length:      usize,
	/// Estimated resident bytes charged before loading.
	pub resident_bytes:  usize,
	/// Admission limit; currently must be one because `FastEmbed` access is
	/// serialized.
	pub max_concurrency: usize,
	/// Duration after which an explicit idle sweep unloads the model.
	pub idle_timeout:    Duration,
}

/// Per-call embedding controls.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct EmbeddingOptions {
	/// Optional `FastEmbed` batch size.
	pub batch_size: Option<usize>,
	/// Whether to L2-normalize every vector.
	pub normalize:  bool,
}

impl Default for EmbeddingOptions {
	fn default() -> Self {
		Self { batch_size: None, normalize: true }
	}
}

/// Embedding result with lifecycle/isolation evidence.
#[derive(Debug)]
pub struct EmbeddingOutput {
	/// One vector per input, in input order.
	pub embeddings: Vec<Vec<f32>>,
	/// Local runtime execution receipt.
	pub receipt:    LocalExecutionReceipt,
}

/// Lazy, bounded adapter over `FastEmbed`'s ONNX runtime.
#[derive(Clone)]
pub struct EmbeddingAdapter {
	runtime:  LocalRuntime<TextEmbedding>,
	metadata: &'static ModelDownloadMetadata,
}

impl EmbeddingAdapter {
	/// Creates a lazy adapter without downloading or loading until first use.
	pub fn new(config: EmbeddingConfig, memory: Arc<MemoryPool>) -> LocalResult<Self> {
		if config.max_length == 0 {
			return Err(LocalError::new(
				LocalErrorKind::InvalidInput,
				"embedding maximum length must be non-zero",
			));
		}
		let metadata = model_download_metadata(&config.model)?;
		let resident_bytes = config.resident_bytes;
		let max_concurrency = config.max_concurrency;
		let idle_timeout = config.idle_timeout;
		let runtime = LocalRuntime::new(
			move || {
				let options = TextInitOptions::new(config.model.clone())
					.with_cache_dir(config.cache_dir.clone())
					.with_max_length(config.max_length)
					.with_show_download_progress(false);
				TextEmbedding::try_new(options).map_err(|error| {
					LocalError::new(LocalErrorKind::Backend, format!("FastEmbed load failed: {error}"))
				})
			},
			memory,
			resident_bytes,
			max_concurrency,
			idle_timeout,
		)?;
		Ok(Self { runtime, metadata })
	}

	/// Returns third-party model metadata before any lazy download begins.
	///
	/// Construction does not access the network. Callers can present this
	/// disclosure before the first [`Self::embed`] call, which is the boundary
	/// where `FastEmbed` may download the selected artifact.
	pub const fn download_metadata(&self) -> &ModelDownloadMetadata {
		self.metadata
	}

	/// Embeds an owned batch using the real ONNX model.
	pub fn embed(
		&self,
		texts: Vec<String>,
		options: EmbeddingOptions,
		cancel: &LocalCancellation,
	) -> LocalResult<EmbeddingOutput> {
		if texts.is_empty() {
			return Err(LocalError::new(
				LocalErrorKind::InvalidInput,
				"embedding requires at least one input",
			));
		}
		if options.batch_size == Some(0) {
			return Err(LocalError::new(
				LocalErrorKind::InvalidInput,
				"embedding batch size must be non-zero",
			));
		}
		let lease = self.runtime.acquire(cancel)?;
		let receipt = lease.receipt();
		let mut embeddings = lease.with_engine(|model| {
			model.embed(texts, options.batch_size).map_err(|error| {
				LocalError::new(LocalErrorKind::Backend, format!("FastEmbed inference failed: {error}"))
			})
		})?;
		if cancel.is_cancelled() {
			return Err(LocalError::cancelled());
		}
		if options.normalize {
			for embedding in &mut embeddings {
				normalize(embedding);
			}
		}
		Ok(EmbeddingOutput { embeddings, receipt })
	}

	/// Borrows the shared lifecycle runtime for idle sweeps and diagnostics.
	pub const fn runtime(&self) -> &LocalRuntime<TextEmbedding> {
		&self.runtime
	}
}

fn normalize(embedding: &mut [f32]) {
	let norm = embedding
		.iter()
		.map(|value| value * value)
		.sum::<f32>()
		.sqrt();
	if norm > 0.0 && norm.is_finite() {
		for value in embedding {
			*value /= norm;
		}
	}
}

#[cfg(test)]
mod tests {
	use serde_json::Value;

	use super::*;

	#[test]
	fn downloaded_model_catalog_matches_fastembed() {
		let catalog = parse_model_catalog().expect("valid model provenance catalog");
		assert_eq!(catalog.len(), TextEmbedding::list_supported_models().len());
	}

	#[test]
	fn catalog_entries_explicitly_include_provenance_fields() {
		let catalog: Value =
			serde_json::from_str(MODEL_CATALOG_JSON).expect("valid model provenance JSON");
		let models = catalog["models"].as_array().expect("models array");
		for model in models {
			for field in
				["source_revision", "license", "license_url", "acceptance_required", "acceptance_url"]
			{
				assert!(
					model.get(field).is_some(),
					"{} must explicitly include {field}",
					model["model"]
				);
			}
			assert_eq!(model["omp_license_applies"], false);
		}
	}
}
