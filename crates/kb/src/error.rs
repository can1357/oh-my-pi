use std::{io, num::TryFromIntError, process::ExitStatus, str::Utf8Error, string::FromUtf8Error};

use omp_core::Hash32ParseError;
use serde_json::Error as JsonError;
use thiserror::Error as ThisError;

pub type Result<T, E = Error> = std::result::Result<T, E>;

#[derive(Debug, ThisError)]
pub enum Error {
	#[error("{action}")]
	Wrapped {
		action: String,
		#[source]
		source: Box<Error>,
	},
	#[error("git {args} failed: {stderr}")]
	Git { args: String, stderr: String },
	#[error("{name} failed with {status}")]
	Producer { name: &'static str, status: ExitStatus },
	#[error("unsupported file type: {path}")]
	UnsupportedFile { path: String },
	#[error("unsupported knowledge-base head version {version}")]
	HeadVersion { version: u32 },
	#[error("unsupported knowledge-base index version {version}")]
	IndexVersion { version: u32 },
	#[error("knowledge-base object digest mismatch")]
	DigestMismatch,
	#[error("repository HEAD moved while SCIP producers were running")]
	RevisionChangedDuringProducers,
	#[error("repository changed while SCIP producers were running: {path}")]
	ChangedDuringProducers { path: String },
	#[error("repository changed while building the index")]
	ChangedDuringBuild,
	#[error("index has no definitions")]
	NoDefinitions,
	#[error("SCIP index has no definitions")]
	EmptyScip,
	#[error("invalid refresh path: {path}")]
	InvalidRefresh { path: String },
	#[error("unsafe SCIP document path: {path:?}")]
	UnsafePath { path: String },
	#[error("{fact}")]
	Rejected { fact: String },
	#[error(transparent)]
	Io(#[from] io::Error),
	#[error(transparent)]
	Json(#[from] JsonError),
	#[error(transparent)]
	Utf8(#[from] FromUtf8Error),
	#[error(transparent)]
	Utf8Slice(#[from] Utf8Error),
	#[error(transparent)]
	Integer(#[from] TryFromIntError),
	#[error(transparent)]
	Digest(#[from] Hash32ParseError),
	#[error(transparent)]
	Other(Box<dyn std::error::Error + Send + Sync>),
}

impl Error {
	pub(crate) fn rejected(fact: impl Into<String>) -> Self {
		Self::Rejected { fact: fact.into() }
	}

	pub(crate) fn foreign(
		action: impl Into<String>,
		source: impl std::error::Error + Send + Sync + 'static,
	) -> Self {
		Self::Other(Box::new(source)).wrap(action)
	}

	pub(crate) fn wrap(self, action: impl Into<String>) -> Self {
		Self::Wrapped { action: action.into(), source: Box::new(self) }
	}
}

pub(crate) trait Context<T> {
	fn context(self, action: impl Into<String>) -> Result<T>;
}

impl<T, E> Context<T> for std::result::Result<T, E>
where
	E: Into<Error>,
{
	fn context(self, action: impl Into<String>) -> Result<T> {
		self.map_err(|error| error.into().wrap(action))
	}
}

impl<T> Context<T> for Option<T> {
	fn context(self, action: impl Into<String>) -> Result<T> {
		self.ok_or_else(|| Error::rejected(action))
	}
}
