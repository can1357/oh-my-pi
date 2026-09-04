//! Bounded newline-delimited JSON frames for the isolated embedding worker.

use std::path::PathBuf;

use omp_core::Str;
use serde::{Deserialize, Serialize};
use strum::{Display, EnumString, IntoStaticStr};

use crate::{Error, Result};

/// Maximum encoded JSON frame size.
pub const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;
/// Maximum texts in one embedding request.
pub const MAX_TEXTS: usize = 256;
/// Maximum aggregate UTF-8 text bytes in one request.
pub const MAX_TEXT_BYTES: usize = 4 * 1024 * 1024;
/// Maximum accepted dense-vector dimensions.
pub const MAX_VECTOR_DIMENSIONS: usize = 4096;
/// Maximum vectors emitted in one outbound streaming frame.
pub const VECTOR_FRAME_ROWS: usize = 32;

/// `FastEmbed` model selected in the parent.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ModelId(pub Str);

/// Parent-to-worker frame.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum InboundFrame {
	/// Load-independent liveness probe.
	Ping {
		/// Request correlation id.
		id: Str,
	},
	/// Lazily initialize or switch the worker model.
	Init {
		/// Request correlation id.
		id:        Str,
		/// Model identifier.
		model:     ModelId,
		/// Optional Hugging Face cache directory.
		cache_dir: Option<PathBuf>,
	},
	/// Embed one bounded ordered batch. Model identity is repeated so a
	/// respawned worker reloads.
	Embed {
		/// Request correlation id.
		id:         Str,
		/// Model identifier.
		model:      ModelId,
		/// Optional Hugging Face cache directory.
		cache_dir:  Option<PathBuf>,
		/// Input texts in result order.
		texts:      Vec<String>,
		/// Optional `FastEmbed` batch size.
		batch_size: Option<usize>,
	},
}

impl InboundFrame {
	/// Correlation identifier.
	pub fn id(&self) -> &str {
		match self {
			Self::Ping { id } | Self::Init { id, .. } | Self::Embed { id, .. } => id.as_str(),
		}
	}

	/// Enforces frame, model, batch, and aggregate input bounds.
	pub fn validate(&self) -> Result<()> {
		if !valid_id(self.id()) {
			return Err(Error::InvalidIdentifier);
		}
		match self {
			Self::Ping { .. } => {},
			Self::Init { model, .. } => validate_model(model)?,
			Self::Embed { model, texts, batch_size, .. } => {
				validate_model(model)?;
				if texts.is_empty()
					|| texts.len() > MAX_TEXTS
					|| batch_size.is_some_and(|batch| batch == 0 || batch > MAX_TEXTS)
					|| texts.iter().any(|text| text.len() > MAX_TEXT_BYTES)
					|| texts
						.iter()
						.try_fold(0usize, |total, text| total.checked_add(text.len()))
						.is_none_or(|total| total > MAX_TEXT_BYTES)
				{
					return Err(Error::InputTooLarge);
				}
			},
		}
		if serde_json::to_vec(self)?.len() > MAX_FRAME_BYTES {
			return Err(Error::InputTooLarge);
		}
		Ok(())
	}
}

/// Worker log severity.
#[derive(
	Clone, Copy, Debug, Display, EnumString, Eq, IntoStaticStr, PartialEq, Serialize, Deserialize,
)]
#[serde(rename_all = "lowercase")]
#[strum(ascii_case_insensitive, serialize_all = "lowercase")]
pub enum LogLevel {
	/// Diagnostic detail.
	Debug,
	/// Recoverable problem.
	Warn,
	/// Request failure.
	Error,
}

/// Worker-to-parent frame.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum OutboundFrame {
	/// Ping response.
	Pong {
		/// Request correlation id.
		id: Str,
	},
	/// Model initialized.
	Ready {
		/// Request correlation id.
		id:         Str,
		/// Worker generation supplied by the supervisor.
		generation: u64,
	},
	/// Ordered vector stream chunk.
	Vectors {
		/// Request correlation id.
		id:         Str,
		/// Worker generation supplied by the supervisor.
		generation: u64,
		/// Zero-based first row index in the request.
		start:      usize,
		/// Total expected rows across all frames.
		total:      usize,
		/// Dense vector rows.
		vectors:    Vec<Vec<f32>>,
		/// Whether this is the final chunk.
		done:       bool,
	},
	/// Typed request failure. Text is diagnostic-only and never converted into a
	/// library error.
	Error {
		/// Request correlation id.
		id:         Str,
		/// Worker generation supplied by the supervisor.
		generation: u64,
		/// Redactable diagnostic.
		message:    Str,
	},
	/// Out-of-band diagnostic.
	Log {
		/// Severity.
		level:   LogLevel,
		/// Message.
		message: Str,
	},
}

impl OutboundFrame {
	/// Enforces correlation, vector, finiteness, and encoded frame bounds.
	pub fn validate(&self) -> Result<()> {
		let id = match self {
			Self::Pong { id }
			| Self::Ready { id, .. }
			| Self::Vectors { id, .. }
			| Self::Error { id, .. } => Some(id.as_str()),
			Self::Log { .. } => None,
		};
		if id.is_some_and(|id| !valid_id(id)) {
			return Err(Error::InvalidIdentifier);
		}
		if let Self::Vectors { start, total, vectors, done, .. } = self
			&& (*total > MAX_TEXTS
				|| vectors.len() > VECTOR_FRAME_ROWS
				|| start
					.checked_add(vectors.len())
					.is_none_or(|end| end > *total)
				|| (*done && start + vectors.len() != *total)
				|| vectors.iter().any(|vector| {
					vector.is_empty()
						|| vector.len() > MAX_VECTOR_DIMENSIONS
						|| vector.iter().any(|value| !value.is_finite())
				})) {
			return Err(Error::InputTooLarge);
		}
		if serde_json::to_vec(self)?.len() > MAX_FRAME_BYTES {
			return Err(Error::InputTooLarge);
		}
		Ok(())
	}
}

fn validate_model(model: &ModelId) -> Result<()> {
	let value = model.0.as_str();
	if value.is_empty()
		|| value.len() > 256
		|| !value
			.bytes()
			.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'-' | b'_' | b'.'))
	{
		return Err(Error::UnsupportedEmbeddingModel);
	}
	Ok(())
}

fn valid_id(id: &str) -> bool {
	!id.is_empty()
		&& id.len() <= 64
		&& id
			.bytes()
			.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}
