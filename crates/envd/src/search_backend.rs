//! Late-bound bridge from the environment tool registry to the one inference
//! facade.

use std::{fmt, sync, sync::OnceLock};

use futures::StreamExt as _;
use omp_core::{Str, sf};
use omp_proto::{
	inference::v1::{self as pb, image_event, inference_client::InferenceClient, speak_event},
	thread::v1,
};
use omp_tools::web_search::{BackendError, BackendErrorKind, SearchBackend};
use thiserror::Error;
use tonic::transport;
use tracing::Instrument as _;

use crate::SearchInference;

/// Failure to bind the one production inference facade.
#[derive(Clone, Copy, Debug, Error)]
pub enum SearchBindingError {
	/// A facade was already installed for this environment generation.
	#[error("web search inference facade is already bound")]
	AlreadyBound,
}

/// Late-bound application DI seam used by `web_search@2`.
///
/// Environment tools are assembled before the inference facade. The bridge is
/// stable inside the immutable tool registry and receives the already-built
/// facade exactly once; it never constructs providers or credential state.
pub struct SearchBridgeHost {
	inference: OnceLock<SearchFacade>,
}

enum SearchFacade {
	Local(sync::Arc<dyn SearchInference>),
	Remote(InferenceClient<transport::Channel>),
}

impl SearchBridgeHost {
	/// Creates an unbound host for registry construction.
	pub(crate) fn new(inference: Option<sync::Arc<dyn SearchInference>>) -> Self {
		Self {
			inference: inference
				.map(SearchFacade::Local)
				.map_or_else(OnceLock::new, OnceLock::from),
		}
	}

	/// Installs a client for an already-running inference daemon.
	pub fn bind_remote(&self, channel: transport::Channel) -> Result<(), SearchBindingError> {
		self
			.inference
			.set(SearchFacade::Remote(InferenceClient::new(channel)))
			.map_err(|_| SearchBindingError::AlreadyBound)
	}

	/// Routes one image generation/edit through the already-bound inference
	/// facade and returns the final artifact blobs.
	#[tracing::instrument(name = "media_generate_image", level = "debug", skip_all)]
	pub(crate) async fn generate_image(
		&self,
		request: pb::GenerateImageRequest,
	) -> Result<Vec<v1::Blob>, BackendError> {
		let Some(inference) = self.inference.get() else {
			return Err(unbound_media());
		};
		match inference {
			SearchFacade::Local(inference) => inference.generate_image(request).await,
			SearchFacade::Remote(client) => {
				let mut client = client.clone();
				let response = client
					.generate_image(tonic::Request::new(request))
					.await
					.map_err(media_status)?;
				collect_images(response.into_inner()).await
			},
		}
	}

	/// Routes speech synthesis and concatenates encoded chunks in wire order.
	#[tracing::instrument(name = "media_speak", level = "debug", skip_all)]
	pub async fn speak(&self, request: pb::SpeakRequest) -> Result<Vec<u8>, BackendError> {
		let Some(inference) = self.inference.get() else {
			return Err(unbound_media());
		};
		match inference {
			SearchFacade::Local(inference) => inference.speak(request).await,
			SearchFacade::Remote(client) => {
				let mut client = client.clone();
				let response = client
					.speak(tonic::Request::new(request))
					.await
					.map_err(media_status)?;
				collect_audio(response.into_inner()).await
			},
		}
	}
}
async fn collect_images<S>(mut events: S) -> Result<Vec<v1::Blob>, BackendError>
where
	S: futures::Stream<Item = Result<pb::ImageEvent, tonic::Status>> + Unpin,
{
	while let Some(event) = events.next().await {
		let event = event.map_err(media_status)?;
		if let Some(image_event::Event::Done(done)) = event.event {
			return Ok(done.images);
		}
	}
	Err(BackendError {
		kind:   BackendErrorKind::Provider,
		code:   sf!("media_stream_incomplete"),
		status: None,
	})
}

async fn collect_audio<S>(mut events: S) -> Result<Vec<u8>, BackendError>
where
	S: futures::Stream<Item = Result<pb::SpeakEvent, tonic::Status>> + Unpin,
{
	let mut audio = Vec::new();
	while let Some(event) = events.next().await {
		match event.map_err(media_status)?.event {
			Some(speak_event::Event::Chunk(chunk)) => audio.extend_from_slice(&chunk.audio),
			Some(speak_event::Event::Done(done)) => {
				if let Some(blob) = done.audio {
					audio.extend_from_slice(&blob.inline);
				}
				return Ok(audio);
			},
			None => {},
		}
	}
	Err(BackendError {
		kind:   BackendErrorKind::Provider,
		code:   sf!("media_stream_incomplete"),
		status: None,
	})
}
fn unbound_media() -> BackendError {
	BackendError {
		kind:   BackendErrorKind::Unavailable,
		code:   sf!("backend_unbound"),
		status: None,
	}
}

/// Redacts a gRPC failure into the stable tool-facing classification.
///
/// The status message is deliberately discarded because it may contain
/// provider response bodies, account identifiers, or credential diagnostics.
pub fn redacted_status(status: &tonic::Status) -> BackendError {
	let kind = match status.code() {
		tonic::Code::Cancelled => BackendErrorKind::Cancelled,
		tonic::Code::DeadlineExceeded => BackendErrorKind::Timeout,
		tonic::Code::Unauthenticated => BackendErrorKind::Authentication,
		tonic::Code::PermissionDenied => BackendErrorKind::Permission,
		tonic::Code::ResourceExhausted => BackendErrorKind::RateLimited,
		tonic::Code::InvalidArgument | tonic::Code::OutOfRange => BackendErrorKind::InvalidRequest,
		tonic::Code::FailedPrecondition | tonic::Code::NotFound | tonic::Code::Unavailable => {
			BackendErrorKind::Unavailable
		},
		_ => BackendErrorKind::Provider,
	};
	BackendError { kind, code: Str::new(status.code().to_string()), status: None }
}

fn media_status(status: tonic::Status) -> BackendError {
	redacted_status(&status)
}

impl SearchBackend for SearchBridgeHost {
	fn search(
		&self,
		request: pb::SearchRequest,
	) -> impl Future<Output = Result<pb::SearchResponse, BackendError>> + Send + '_ {
		let span = tracing::debug_span!("search_request", provider = %request.engine, limit = request.limit, transport = tracing::field::Empty);
		async move {
			let Some(inference) = self.inference.get() else {
				return Err(BackendError {
					kind:   BackendErrorKind::Unavailable,
					code:   sf!("backend_unbound"),
					status: None,
				});
			};
			let response = match inference {
				SearchFacade::Local(inference) => {
					tracing::Span::current().record("transport", "local");
					return inference.search(request).await;
				},
				SearchFacade::Remote(client) => {
					tracing::Span::current().record("transport", "remote");
					let mut client = client.clone();
					client.search(tonic::Request::new(request)).await
				},
			}
			.map_err(|status| redacted_status(&status))?;
			Ok(response.into_inner())
		}
		.instrument(span)
	}
}

impl fmt::Debug for SearchBridgeHost {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("SearchBridgeHost")
			.field("bound", &self.inference.get().is_some())
			.finish()
	}
}
