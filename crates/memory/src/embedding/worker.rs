//! Isolated `FastEmbed` worker state machine.

use std::path::Path;
#[cfg(feature = "local-embedding")]
use std::path::PathBuf;

#[cfg(feature = "local-embedding")]
use fastembed::{EmbeddingModel, TextEmbedding, TextInitOptions};
use omp_core::Str;

use super::protocol::{InboundFrame, OutboundFrame, VECTOR_FRAME_ROWS};
use crate::{Error, Result};

/// Single-process model owner. Failed loads never poison the retryable model
/// slot.
pub struct EmbeddingWorker {
	#[cfg(feature = "local-embedding")]
	loaded: Option<LoadedModel>,
}

#[cfg(feature = "local-embedding")]
struct LoadedModel {
	id:        Str,
	cache_dir: Option<PathBuf>,
	model:     TextEmbedding,
}

impl Default for EmbeddingWorker {
	fn default() -> Self {
		Self::new()
	}
}

impl EmbeddingWorker {
	/// Creates an unloaded worker.
	pub const fn new() -> Self {
		Self {
			#[cfg(feature = "local-embedding")]
			loaded:                                     None,
		}
	}

	/// Handles one validated frame and returns ordered response frames.
	pub fn handle(&mut self, frame: InboundFrame, generation: u64) -> Vec<OutboundFrame> {
		if frame.validate().is_err() {
			return vec![OutboundFrame::Error {
				id: Str::new(frame.id()),
				generation,
				message: Str::new_static("invalid or over-limit embedding frame"),
			}];
		}
		match frame {
			InboundFrame::Ping { id } => vec![OutboundFrame::Pong { id }],
			InboundFrame::Init { id, model, cache_dir } => {
				match self.ensure_loaded(&model.0, cache_dir.as_deref()) {
					Ok(()) => vec![OutboundFrame::Ready { id, generation }],
					Err(error) => vec![worker_error(id, generation, &error)],
				}
			},
			InboundFrame::Embed { id, model, cache_dir, texts, batch_size } => {
				match self.embed(&model.0, cache_dir.as_deref(), texts, batch_size) {
					Ok(vectors) => vector_frames(id, generation, vectors),
					Err(error) => vec![worker_error(id, generation, &error)],
				}
			},
		}
	}

	#[cfg(feature = "local-embedding")]
	fn ensure_loaded(&mut self, id: &Str, cache_dir: Option<&Path>) -> Result<()> {
		if self
			.loaded
			.as_ref()
			.is_some_and(|loaded| loaded.id == *id && loaded.cache_dir.as_deref() == cache_dir)
		{
			return Ok(());
		}
		let model = resolve_model(id.as_str())?;
		let mut options = TextInitOptions::new(model)
			.with_max_length(512)
			.with_show_download_progress(false);
		if let Some(cache_dir) = cache_dir {
			options = options.with_cache_dir(cache_dir.to_path_buf());
		}
		let loaded = TextEmbedding::try_new(options).map_err(|_| Error::EmbeddingWorker)?;
		self.loaded = Some(LoadedModel {
			id:        id.clone(),
			cache_dir: cache_dir.map(Path::to_path_buf),
			model:     loaded,
		});
		Ok(())
	}

	#[cfg(not(feature = "local-embedding"))]
	const fn ensure_loaded(&mut self, _id: &Str, _cache_dir: Option<&Path>) -> Result<()> {
		Err(Error::UnsupportedEmbeddingModel)
	}

	#[cfg(feature = "local-embedding")]
	fn embed(
		&mut self,
		id: &Str,
		cache_dir: Option<&Path>,
		texts: Vec<String>,
		batch_size: Option<usize>,
	) -> Result<Vec<Vec<f32>>> {
		self.ensure_loaded(id, cache_dir)?;
		let loaded = self.loaded.as_mut().ok_or(Error::EmbeddingWorker)?;
		let mut vectors = loaded
			.model
			.embed(texts, batch_size)
			.map_err(|_| Error::EmbeddingWorker)?;
		for vector in &mut vectors {
			normalize(vector)?;
		}
		Ok(vectors)
	}

	#[cfg(not(feature = "local-embedding"))]
	fn embed(
		&mut self,
		_id: &Str,
		_cache_dir: Option<&Path>,
		_texts: Vec<String>,
		_batch_size: Option<usize>,
	) -> Result<Vec<Vec<f32>>> {
		Err(Error::UnsupportedEmbeddingModel)
	}
}

#[cfg(feature = "local-embedding")]
fn resolve_model(id: &str) -> Result<EmbeddingModel> {
	match id {
		"BAAI/bge-base-en-v1.5" | "Xenova/bge-base-en-v1.5" | "fast-bge-base-en-v1.5" => {
			Ok(EmbeddingModel::BGEBaseENV15)
		},
		"intfloat/multilingual-e5-large"
		| "Qdrant/multilingual-e5-large-onnx"
		| "fast-multilingual-e5-large" => Ok(EmbeddingModel::MultilingualE5Large),
		_ => Err(Error::UnsupportedEmbeddingModel),
	}
}

#[cfg(feature = "local-embedding")]
fn normalize(vector: &mut [f32]) -> Result<()> {
	if vector.is_empty() || vector.iter().any(|value| !value.is_finite()) {
		return Err(Error::EmbeddingWorker);
	}
	let norm = vector.iter().map(|value| value * value).sum::<f32>().sqrt();
	if norm == 0.0 {
		return Err(Error::EmbeddingWorker);
	}
	for value in vector {
		*value /= norm;
	}
	Ok(())
}

fn vector_frames(id: Str, generation: u64, vectors: Vec<Vec<f32>>) -> Vec<OutboundFrame> {
	let total = vectors.len();
	vectors
		.chunks(VECTOR_FRAME_ROWS)
		.enumerate()
		.map(|(chunk, rows)| {
			let start = chunk * VECTOR_FRAME_ROWS;
			OutboundFrame::Vectors {
				id: id.clone(),
				generation,
				start,
				total,
				vectors: rows.to_vec(),
				done: start + rows.len() == total,
			}
		})
		.collect()
}

fn worker_error(id: Str, generation: u64, error: &Error) -> OutboundFrame {
	OutboundFrame::Error { id, generation, message: Str::new(error.to_string()) }
}
