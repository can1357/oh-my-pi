//! Driver-owned optional capabilities injected into the environment host.

use std::{
	path::Path,
	sync::{Arc, OnceLock},
	time::Duration,
};

use futures::StreamExt as _;
use omp_ai::auth::command::CommandCredentialExecutor;
use omp_cache::telemetry_cache::TelemetryIndex;
use omp_core::{EnvPath, Str, sf};
use omp_env::EnvClient;
use omp_envd::github_url::GithubCredentialBridge;
use omp_proto::{
	inference::v1::{
		self as pb, image_event, inference_client::InferenceClient,
		inference_server::Inference as InferenceService, speak_event,
	},
	thread::v1,
};
use omp_serve::inference::InferenceRpc;
use omp_tools::web_search::{BackendError, BackendErrorKind};

use crate::auth_backend::EnvCommandCredentialExecutor;

/// Inference service binding retained by compositions that enable search.
#[derive(Default)]
pub struct InferenceBridge {
	facade: OnceLock<InferenceFacade>,
}

enum InferenceFacade {
	Local(InferenceRpc),
	Remote(InferenceClient<tonic::transport::Channel>),
}

/// Failure to bind the session's inference owner to its environment tools.
#[derive(Clone, Copy, Debug, thiserror::Error)]
pub enum InferenceBridgeError {
	/// The immutable environment generation already has an inference owner.
	#[error("environment inference bridge is already bound")]
	AlreadyBound,
}

impl InferenceBridge {
	/// Installs the fully composed session inference facade exactly once.
	pub fn bind(&self, rpc: InferenceRpc) -> Result<(), InferenceBridgeError> {
		self
			.facade
			.set(InferenceFacade::Local(rpc))
			.map_err(|_| InferenceBridgeError::AlreadyBound)
	}

	/// Installs an already-running inference gateway exactly once.
	pub fn bind_remote(
		&self,
		channel: tonic::transport::Channel,
	) -> Result<(), InferenceBridgeError> {
		self
			.facade
			.set(InferenceFacade::Remote(InferenceClient::new(channel)))
			.map_err(|_| InferenceBridgeError::AlreadyBound)
	}

	fn facade(&self) -> Result<&InferenceFacade, BackendError> {
		self.facade.get().ok_or_else(|| BackendError {
			kind:   BackendErrorKind::Unavailable,
			code:   sf!("backend_unbound"),
			status: None,
		})
	}
}

#[async_trait::async_trait]
impl omp_envd::SearchInference for InferenceBridge {
	async fn search(&self, request: pb::SearchRequest) -> Result<pb::SearchResponse, BackendError> {
		let response = match self.facade()? {
			InferenceFacade::Local(rpc) => {
				InferenceService::search(rpc, tonic::Request::new(request)).await
			},
			InferenceFacade::Remote(client) => {
				let mut client = client.clone();
				client.search(tonic::Request::new(request)).await
			},
		}
		.map_err(|status| omp_envd::search_backend::redacted_status(&status))?;
		Ok(response.into_inner())
	}

	async fn generate_image(
		&self,
		request: pb::GenerateImageRequest,
	) -> Result<Vec<v1::Blob>, BackendError> {
		match self.facade()? {
			InferenceFacade::Local(rpc) => {
				let events = InferenceService::generate_image(rpc, tonic::Request::new(request))
					.await
					.map_err(|status| omp_envd::search_backend::redacted_status(&status))?
					.into_inner();
				collect_images(events).await
			},
			InferenceFacade::Remote(client) => {
				let mut client = client.clone();
				let events = client
					.generate_image(tonic::Request::new(request))
					.await
					.map_err(|status| omp_envd::search_backend::redacted_status(&status))?
					.into_inner();
				collect_images(events).await
			},
		}
	}

	async fn speak(&self, request: pb::SpeakRequest) -> Result<Vec<u8>, BackendError> {
		match self.facade()? {
			InferenceFacade::Local(rpc) => {
				let events = InferenceService::speak(rpc, tonic::Request::new(request))
					.await
					.map_err(|status| omp_envd::search_backend::redacted_status(&status))?
					.into_inner();
				collect_audio(events).await
			},
			InferenceFacade::Remote(client) => {
				let mut client = client.clone();
				let events = client
					.speak(tonic::Request::new(request))
					.await
					.map_err(|status| omp_envd::search_backend::redacted_status(&status))?
					.into_inner();
				collect_audio(events).await
			},
		}
	}
}

async fn collect_images<S>(mut events: S) -> Result<Vec<v1::Blob>, BackendError>
where
	S: futures::Stream<Item = Result<pb::ImageEvent, tonic::Status>> + Unpin,
{
	while let Some(event) = events.next().await {
		let event = event.map_err(|status| omp_envd::search_backend::redacted_status(&status))?;
		if let Some(image_event::Event::Done(done)) = event.event {
			return Ok(done.images);
		}
	}
	Err(incomplete("image_stream_incomplete"))
}

async fn collect_audio<S>(mut events: S) -> Result<Vec<u8>, BackendError>
where
	S: futures::Stream<Item = Result<pb::SpeakEvent, tonic::Status>> + Unpin,
{
	let mut audio = Vec::new();
	while let Some(event) = events.next().await {
		match event
			.map_err(|status| omp_envd::search_backend::redacted_status(&status))?
			.event
		{
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
	Err(incomplete("speech_stream_incomplete"))
}

fn incomplete(code: &'static str) -> BackendError {
	BackendError { kind: BackendErrorKind::Provider, code: Str::new_static(code), status: None }
}

/// Session goal-control binding.
#[derive(Clone, Default)]
pub struct AgentGoalControl;

/// Runs `!command` credential sources inside the project Environment.
///
/// Runs credential commands with a 10-second timeout and a 1 MiB stdout limit.
#[derive(Clone, Copy, Debug, Default)]
pub struct CommandCredentials;

impl CommandCredentials {
	const MAX_STDOUT: usize = 1 << 20;
	const TIMEOUT: Duration = Duration::from_secs(10);
}

impl omp_envd::CommandCredentialExecutorFactory for CommandCredentials {
	fn make(&self, client: EnvClient, cwd: &Path) -> Arc<dyn CommandCredentialExecutor> {
		let cwd = EnvPath::new(Str::new(cwd.to_string_lossy()))
			.unwrap_or_else(|_| EnvPath::new(Str::new_static(".")).expect("non-empty literal"));
		Arc::new(EnvCommandCredentialExecutor::new(client, cwd, Self::TIMEOUT, Self::MAX_STDOUT))
	}
}

/// Starts the consent-only AutoQA delivery worker once GitHub credentials
/// exist.
#[derive(Clone, Copy, Debug, Default)]
pub struct TelemetryDelivery;

impl omp_envd::TelemetryUpload for TelemetryDelivery {
	fn start(&self, index: Arc<TelemetryIndex>, credentials: Arc<GithubCredentialBridge>) {
		crate::telemetry_upload::start(index, credentials);
	}
}

/// Builds the baseline environment bridges for one project.
///
/// Core tools, Python registrations, and session routing are installed by the
/// environment and kernel composition directly; this helper carries the
/// optional host-resource authority plus the driver-owned inference,
/// command-credential, and telemetry-delivery seams.
#[must_use]
pub fn builtin(
	_root: &Path,
	search: Arc<InferenceBridge>,
	_goal_control: AgentGoalControl,
	host_resources: Option<Arc<dyn omp_envd::HostResources>>,
) -> omp_envd::RegistryBridges {
	omp_envd::RegistryBridges {
		host_resources,
		search: Some(search),
		command_credentials: Some(Arc::new(CommandCredentials)),
		telemetry_upload: Some(Arc::new(TelemetryDelivery)),
		..omp_envd::RegistryBridges::default()
	}
}
