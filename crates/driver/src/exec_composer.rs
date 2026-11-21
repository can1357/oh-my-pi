//! Shared composition of remote execution requests and REAPI backends.
//!
//! Operator configuration determines the destination and credentials. Input
//! capture stays local; callers authorize the destination before connecting.

use std::{
	collections::BTreeMap, env, fs, future::Future, io, path::Path, str::FromStr, sync::Arc,
	time::Duration,
};

use bytes::Bytes;
use omp_adw::{ApprovalScope, NetworkScope, Posture, WriteScope};
use omp_ai::auth::command::CommandCredentialResolver;
use omp_con::Ctx;
use omp_core::{Hash32, SecretString, Str};
use omp_env::{BlobDownloadEvent, EnvClient};
use omp_envd::CommandCredentialExecutorFactory as _;
use omp_exec::{
	BackendId, BuildCommand, BuildSystemAdapter, CachePolicy, CargoJust, Digest, EnvEntry,
	ExecutionError, ExecutionRequest, InputSet, Platform, ReattachHandle, RepoPins, capture_entries,
};
use omp_exec_reapi::{
	ExecuteConfig, ReapiBackend, Toolchain,
	cas::{BlobSource, InputSource},
	endpoint::Endpoint,
	profile::{ArchSpelling, Credential, Profile},
	tree::InputFile,
};
use omp_observability::attrs::omp_exec as exec_attrs;
use omp_proto::{
	blob::v1::{GetRequest, StatRequest},
	env::v1::CaptureInputsRequest,
};
use tokio_util::sync::CancellationToken;
use tracing::Instrument as _;

use crate::{bridges::CommandCredentials, cfg::CfgFiles, workspace_trust::evaluate_workspace};

omp_con::var! {
	/// Remote REAPI address. Empty disables remote execution.
	pub static SV_EXEC_REMOTE_ENDPOINT = sv_exec_remote_endpoint: Str {
		default: Str::default(), flags: archive,
	};
	/// Remote action-cache policy: `off`, `read`, or `read-write`.
	pub static SV_EXEC_REMOTE_CACHE = sv_exec_remote_cache: Str {
		default: Str::new_static("off"), flags: archive,
	};
	/// Operator-chosen REAPI profile name. Behaviour comes from the profile
	/// convars below, not from this name.
	pub static SV_EXEC_REMOTE_PROFILE = sv_exec_remote_profile: Str {
		default: Str::new_static("reapi"), flags: archive,
	};
	/// Metadata header that carries the remote credential. Empty means none.
	pub static SV_EXEC_REMOTE_CREDENTIAL_HEADER = sv_exec_remote_credential_header: Str {
		default: Str::default(), flags: archive,
	};
	/// Architecture property spelling: `reapi` (`ISA`/`x86-64`) or `short`
	/// (`Arch`/`amd64`).
	pub static SV_EXEC_REMOTE_ARCH_SPELLING = sv_exec_remote_arch_spelling: Str {
		default: Str::new_static("reapi"), flags: archive,
	};
	/// Fixed platform properties on every action: comma-separated `k=v` pairs.
	/// Empty means none. Keys and values are trimmed; empty keys are refused.
	pub static SV_EXEC_REMOTE_FIXED_PROPERTIES = sv_exec_remote_fixed_properties: Str {
		default: Str::default(), flags: archive,
	};
	/// When true, refuse non-`off` action-cache policy. Use for profiles where
	/// runner recycling would make an action-cache hit an unsafe substitute for
	/// a full execution result.
	pub static SV_EXEC_REMOTE_REFUSE_ACTION_CACHE = sv_exec_remote_refuse_action_cache: bool {
		default: false, flags: archive,
	};
	/// Command credential source, prefixed with `!`; never the key itself.
	pub static SV_EXEC_REMOTE_CREDENTIAL = sv_exec_remote_credential: Str {
		default: Str::default(), flags: archive,
	};
	/// Digest-pinned remote image for the repository's Cargo/just toolchain.
	pub static SV_EXEC_REMOTE_IMAGE = sv_exec_remote_image: Str {
		default: Str::default(), flags: archive,
	};
	/// Extra operator-approved upload deny patterns, comma separated.
	pub static SV_EXEC_UPLOAD_EXCLUDE = sv_exec_upload_exclude: Str {
		default: Str::default(), flags: archive,
	};
	/// Paths exempted by the operator from upload denial, comma separated.
	pub static SV_EXEC_UPLOAD_ALLOW = sv_exec_upload_allow: Str {
		default: Str::default(), flags: archive,
	};
}

/// Enforced by the Linux runner profile: the remote action cannot write the
/// local workspace and networking is off.
pub const REMOTE_POSTURE: Posture = Posture {
	write:    WriteScope::ReadOnly,
	network:  NetworkScope::Disabled,
	approval: ApprovalScope::Yolo,
};
/// An error while composing or running remote execution.
#[derive(Debug, thiserror::Error)]
pub enum RemoteError {
	/// The endpoint or image is not configured.
	#[error("remote execution is not configured with an endpoint and digest-pinned image")]
	MissingConfiguration,
	/// The environment credential is missing or empty.
	#[error("remote credential environment variable is missing or empty")]
	EnvironmentCredential,
	/// The credential source has an unsupported form.
	#[error("remote credential must be an env:NAME or !command source")]
	CredentialSource,
	/// The credential command failed.
	#[error("operator remote credential command failed")]
	Credential(#[source] omp_ai::auth::command::CommandCredentialError),
	/// The repository toolchain pins could not be read.
	#[error("repository toolchain pins could not be read")]
	Pins(#[source] io::Error),
	/// The build command could not be planned.
	#[error("CargoJust could not plan this command")]
	Plan(#[source] omp_exec::PlanError),
	/// The endpoint is invalid or insecure.
	#[error("remote endpoint is not secure")]
	Endpoint(#[source] omp_exec_reapi::endpoint::EndpointError),
	/// The environment could not capture inputs.
	#[error("project Environment input capture failed")]
	Capture(#[source] omp_env::ClientError),
	/// A tracked input was refused by an upload rule.
	#[error("tracked input was refused: {path} matched {rule}")]
	InputRefused {
		/// The refused path.
		path: Str,
		/// The rule that refused the path.
		rule: Str,
	},
	/// The environment capture manifest is invalid.
	#[error("invalid environment capture manifest")]
	Manifest,
	/// The remote execution failed.
	#[error("remote action failed: {0}")]
	Execute(#[source] ExecutionError),
	/// The remote action failed before acceptance; the error may permit local
	/// fallback (ADR 0040 Part C.3).
	#[error("remote action failed before acceptance: {0}")]
	PreAcceptanceFailed(#[source] ExecutionError),
	/// The environment could not materialize an artifact.
	#[error("remote artifact could not be materialized into the Environment blob store")]
	Materialize(#[source] omp_env::ClientError),
	/// `sv_exec_remote_arch_spelling` is not `reapi` or `short`.
	#[error("remote arch spelling must be reapi or short")]
	InvalidArchSpelling,
	/// `sv_exec_remote_fixed_properties` is not comma-separated `k=v` pairs.
	#[error("remote fixed properties must be comma-separated k=v pairs")]
	InvalidFixedProperties,
	/// Action-cache mode `read` or `read-write` is refused when
	/// `sv_exec_remote_refuse_action_cache` is set.
	#[error(
		"cache policy read or read-write is not allowed when sv_exec_remote_refuse_action_cache is \
		 set"
	)]
	CachePolicyConflict,
	/// A reattach handle names a backend generic execution does not compose.
	#[error("the reattach handle names backend {backend}, which generic execution does not compose")]
	UnknownBackend {
		/// The backend the handle names.
		backend: BackendId,
	},
	/// The project state directory could not be prepared.
	#[error("project state directory could not be prepared")]
	StateDirectory(#[source] io::Error),
	/// The project Environment could not be opened.
	#[error("project Environment could not be opened")]
	Environment(#[source] omp_envd::EnvdError),
}

pub(crate) fn config_list(value: impl AsRef<str>) -> Vec<String> {
	value
		.as_ref()
		.split(",")
		.map(|part| part.trim())
		.filter(|part| !part.is_empty())
		.map(|part| part.to_string())
		.collect()
}
fn repo_pins(root: &Path) -> Result<RepoPins, io::Error> {
	let rust = fs::read_to_string(root.join("rust-toolchain.toml"))?;
	let ci = fs::read_to_string(root.join(".github/workflows/ci.yml"))?;
	let python = fs::read_to_string(root.join("crates/py/scripts/fetch-python.sh"))?;
	let channel = rust
		.lines()
		.find_map(|line| line.trim().strip_prefix("channel = "))
		.map(|value| value.trim_matches('"'));
	let nextest = ci
		.lines()
		.find_map(|line| line.trim().strip_prefix("tool: nextest@"));
	let tag = python.lines().find_map(|line| line.strip_prefix("TAG="));
	let version = python.lines().find_map(|line| line.strip_prefix("VER="));
	let (Some(channel), Some(nextest), Some(tag), Some(version)) = (channel, nextest, tag, version)
	else {
		return Err(io::Error::new(io::ErrorKind::InvalidData, "toolchain pins missing"));
	};
	Ok(RepoPins {
		rust_toolchain: Str::new(channel),
		nextest:        Str::new(nextest.trim()),
		cpython_tag:    Str::new(tag.trim()),
		cpython:        Str::new(version.trim()),
	})
}

/// Reads captured inputs from the project environment.
#[derive(Clone)]
pub struct EnvironmentInputs(EnvClient);

impl EnvironmentInputs {
	/// Shares the native capture reader without creating a remote backend.
	pub(crate) fn new(environment: EnvClient) -> Self {
		Self(environment)
	}

	/// Verified capture paths and blob lengths, using the execution manifest
	/// reader.
	pub(crate) async fn captured_files(&self, manifest: Digest) -> io::Result<Vec<(String, u64)>> {
		Ok(self
			.files(manifest)
			.await?
			.into_iter()
			.map(|file| (file.path, file.digest.size))
			.collect())
	}

	pub(crate) async fn bytes(&self, digest: Digest) -> io::Result<Bytes> {
		let download = self
			.0
			.blob_get(GetRequest {
				hash:   Bytes::copy_from_slice(digest.hash.as_bytes()),
				offset: 0,
				length: 0,
			})
			.await
			.map_err(io::Error::other)?;
		let mut output = Vec::new();
		download
			.write_verified(digest.hash, digest.size, digest.size, &mut output)
			.await
			.map_err(io::Error::other)?;
		Ok(Bytes::from(output))
	}
}

impl BlobSource for EnvironmentInputs {
	fn read(&self, digest: Digest) -> impl Future<Output = io::Result<Bytes>> + Send + '_ {
		self.bytes(digest)
	}

	fn read_range(
		&self,
		digest: Digest,
		offset: u64,
		len: u64,
	) -> impl Future<Output = io::Result<Bytes>> + Send + '_ {
		async move {
			if offset > digest.size || len > digest.size - offset {
				return Err(io::Error::new(io::ErrorKind::InvalidInput, "blob range exceeds size"));
			}
			let mut download = self
				.0
				.blob_get(GetRequest {
					hash: Bytes::copy_from_slice(digest.hash.as_bytes()),
					offset,
					length: len,
				})
				.await
				.map_err(io::Error::other)?;
			let mut output = Vec::with_capacity(len.min(64 * 1024) as usize);
			let mut completed = false;
			while let Some(event) = download.next_event().await.map_err(io::Error::other)? {
				match event {
					BlobDownloadEvent::Chunk(chunk) => {
						if !chunk.hash.is_empty() && chunk.hash.as_ref() != digest.hash.as_bytes()
							|| chunk.size.is_some_and(|size| size != digest.size)
							|| output.len().saturating_add(chunk.data.len()) as u64 > len
						{
							return Err(io::Error::new(
								io::ErrorKind::InvalidData,
								"blob range metadata mismatch",
							));
						}
						output.extend_from_slice(&chunk.data);
					},
					BlobDownloadEvent::Complete(_) => {
						completed = true;
						break;
					},
				}
			}
			if !completed || output.len() as u64 != len {
				return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "blob range incomplete"));
			}
			Ok(Bytes::from(output))
		}
	}
}

impl InputSource for EnvironmentInputs {
	fn files(
		&self,
		manifest: Digest,
	) -> impl Future<Output = io::Result<Vec<InputFile>>> + Send + '_ {
		async move {
			let bytes = self.bytes(manifest).await?;
			let mut files = Vec::new();
			for entry in capture_entries(&bytes)? {
				let stat = self
					.0
					.blob_stat(StatRequest { hash: Bytes::copy_from_slice(entry.hash.as_bytes()) })
					.await
					.map_err(io::Error::other)?;
				if !stat.present {
					return Err(io::Error::new(io::ErrorKind::NotFound, "capture blob missing"));
				}
				files.push(InputFile {
					path:       entry.path,
					digest:     Digest::new(entry.hash, stat.size),
					executable: entry.executable,
				});
			}
			Ok(files)
		}
	}
}

/// A non-secret destination suitable for persisting with an execution handle.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DestinationIdentity {
	/// The backend identifier used in execution handles.
	pub backend:  BackendId,
	/// The normalized transport URL, including scheme, host and port.
	pub endpoint: Str,
	/// The REAPI instance name.
	pub instance: Str,
}

/// A snapshot of operator-controlled execution configuration.
pub struct ExecutionSettings {
	/// The raw endpoint URL text from the operator setting.
	endpoint_text:       Str,
	/// The parsed endpoint.
	endpoint:            Endpoint,
	/// The container image reference.
	image:               Str,
	/// The credential source (environment variable or command).
	credential_source:   Str,
	/// The REAPI profile name.
	profile:             Str,
	/// The cache policy name.
	cache:               Str,
	/// The credential header name.
	credential_header:   Str,
	/// The architecture spelling.
	arch_spelling:       Str,
	/// Comma-separated fixed platform properties.
	fixed_properties:    Str,
	/// Whether to refuse GitHub Actions caching.
	refuse_action_cache: bool,
	/// Glob patterns for files to exclude from upload.
	deny_globs:          Str,
	/// Paths explicitly allowed for upload.
	allow_paths:         Str,
}

/// A planned request with locally captured inputs and its repository pins.
pub struct PreparedExecution {
	/// The request to submit after destination approval.
	pub request: ExecutionRequest,
	/// The toolchain pins used to plan and configure the backend.
	pub pins:    RepoPins,
}

const BACKEND_NAME: &str = "remote";
const INSTANCE: &str = "";

/// Parses comma-separated `k=v` platform properties into a deterministic map.
fn parse_fixed_properties(value: &str) -> Result<BTreeMap<Str, Str>, RemoteError> {
	let mut fixed = BTreeMap::new();
	for part in value.split(',') {
		let part = part.trim();
		if part.is_empty() {
			continue;
		}
		let Some((key, value)) = part.split_once('=') else {
			return Err(RemoteError::InvalidFixedProperties);
		};
		let key = key.trim();
		let value = value.trim();
		if key.is_empty() {
			return Err(RemoteError::InvalidFixedProperties);
		}
		fixed.insert(Str::new(key), Str::new(value));
	}
	Ok(fixed)
}

fn profile_from_operator_data(
	name: Str,
	credential_header: &str,
	arch_spelling: &str,
	fixed_properties: &str,
	cache_name: &str,
	refuse_action_cache: bool,
) -> Result<(Profile, CachePolicy), RemoteError> {
	let arch =
		ArchSpelling::from_str(arch_spelling).map_err(|_| RemoteError::InvalidArchSpelling)?;
	let credential_header = if credential_header.is_empty() {
		None
	} else {
		Some(Str::new(credential_header))
	};
	let profile = Profile {
		name,
		credential_header,
		arch,
		image_property: Str::new_static("container-image"),
		fixed: parse_fixed_properties(fixed_properties)?,
	};
	let cache = cache_name.parse().unwrap_or_default();
	if refuse_action_cache && cache != CachePolicy::Off {
		return Err(RemoteError::CachePolicyConflict);
	}
	Ok((profile, cache))
}

impl ExecutionSettings {
	/// Reads and validates operator settings for REAPI execution.
	///
	/// # Errors
	///
	/// Returns an error for invalid settings.
	pub fn generic(ctx: &Ctx) -> Result<Self, RemoteError> {
		Self::snapshot(ctx)
	}

	pub(crate) fn for_adw(ctx: &Ctx) -> Result<Self, RemoteError> {
		Self::snapshot(ctx)
	}

	fn snapshot(ctx: &Ctx) -> Result<Self, RemoteError> {
		let endpoint_text = SV_EXEC_REMOTE_ENDPOINT.get(ctx);
		let image = SV_EXEC_REMOTE_IMAGE.get(ctx);
		if endpoint_text.is_empty() || image.is_empty() || !image.contains("@sha256:") {
			return Err(RemoteError::MissingConfiguration);
		}
		let endpoint = Endpoint::parse(&endpoint_text).map_err(RemoteError::Endpoint)?;
		Ok(Self {
			endpoint_text,
			endpoint,
			image,
			credential_source: SV_EXEC_REMOTE_CREDENTIAL.get(ctx),
			profile: SV_EXEC_REMOTE_PROFILE.get(ctx),
			cache: SV_EXEC_REMOTE_CACHE.get(ctx),
			credential_header: SV_EXEC_REMOTE_CREDENTIAL_HEADER.get(ctx),
			arch_spelling: SV_EXEC_REMOTE_ARCH_SPELLING.get(ctx),
			fixed_properties: SV_EXEC_REMOTE_FIXED_PROPERTIES.get(ctx),
			refuse_action_cache: SV_EXEC_REMOTE_REFUSE_ACTION_CACHE.get(ctx),
			deny_globs: SV_EXEC_UPLOAD_EXCLUDE.get(ctx),
			allow_paths: SV_EXEC_UPLOAD_ALLOW.get(ctx),
		})
	}

	/// Builds the REAPI profile and validated cache policy from this snapshot.
	pub(crate) fn resolved_profile(&self) -> Result<(Profile, CachePolicy), RemoteError> {
		profile_from_operator_data(
			self.profile.clone(),
			&self.credential_header,
			&self.arch_spelling,
			&self.fixed_properties,
			&self.cache,
			self.refuse_action_cache,
		)
	}

	#[allow(dead_code)]
	pub(crate) fn profile_name(&self) -> &str {
		&self.profile
	}

	#[allow(dead_code)]
	pub(crate) fn cache_name(&self) -> &str {
		&self.cache
	}

	pub(crate) fn refuse_action_cache(&self) -> bool {
		self.refuse_action_cache
	}

	#[allow(dead_code)]
	pub(crate) fn endpoint_text(&self) -> &str {
		&self.endpoint_text
	}

	/// Returns the destination identity without credentials or action inputs.
	pub fn destination_identity(&self) -> DestinationIdentity {
		DestinationIdentity {
			backend:  BackendId::new_static(BACKEND_NAME),
			endpoint: Str::from(self.endpoint.transport_url()),
			instance: Str::new_static(INSTANCE),
		}
	}

	/// Returns the validated endpoint host: the subject a network approval for
	/// this destination names.
	pub fn endpoint_host(&self) -> &str {
		self.endpoint.host()
	}

	/// Resolves the configured operator credential without connecting to REAPI.
	///
	/// # Errors
	///
	/// Returns an error when the credential source or command fails.
	pub async fn credential(
		&self,
		environment: &EnvClient,
		root: &Path,
		cancel: &CancellationToken,
	) -> Result<Credential, RemoteError> {
		if let Some(credential) = self.environment_credential()? {
			return Ok(credential);
		}
		let command = self
			.credential_source
			.strip_prefix("!")
			.ok_or(RemoteError::CredentialSource)?;
		let executor = CommandCredentials.make(environment.clone(), root);
		let secret = CommandCredentialResolver::new(executor, Duration::from_secs(1))
			.resolve(&command, cancel.clone())
			.await
			.map_err(RemoteError::Credential)?;
		Ok(Credential::new(secret))
	}

	fn environment_credential(&self) -> Result<Option<Credential>, RemoteError> {
		if let Some(name) = self.credential_source.strip_prefix("env:") {
			let value = env::var(name)
				.ok()
				.filter(|value| !value.trim().is_empty())
				.ok_or(RemoteError::EnvironmentCredential)?;
			Ok(Some(Credential::new(SecretString::from(value))))
		} else if self.credential_source.starts_with('!') {
			Ok(None)
		} else {
			Err(RemoteError::CredentialSource)
		}
	}

	/// Plans the command and captures its inputs without contacting the
	/// destination.
	///
	/// # Errors
	///
	/// Returns an error when planning or environment capture fails.
	pub async fn prepare(
		&self,
		environment: &EnvClient,
		root: &Path,
		command: &BuildCommand,
	) -> Result<PreparedExecution, RemoteError> {
		let pins = repo_pins(root).map_err(RemoteError::Pins)?;
		let plan = CargoJust::default()
			.plan(command, &pins)
			.map_err(RemoteError::Plan)?;
		let mut request = plan.requests.first().ok_or(RemoteError::Manifest)?.clone();
		if !request.argv.is_empty() {
			let mut argv = request.argv.to_vec();
			argv[0] = Str::new_static("/usr/local/bin/just");
			request.argv = Arc::from(argv);
		}
		let capture = environment
			.capture_inputs(CaptureInputsRequest {
				include_untracked: true,
				deny_globs: config_list(&self.deny_globs),
				allow_paths: config_list(&self.allow_paths),
				wire_revision: omp_proto::SCHEMA_REV,
				..Default::default()
			})
			.instrument(tracing::info_span!("omp.exec.capture"))
			.await
			.map_err(RemoteError::Capture)?;
		tracing::info!(
			{ exec_attrs::INPUT_FILES } = capture.files,
			{ exec_attrs::INPUT_BYTES } = capture.bytes,
			"capture complete"
		);
		if let Some(refused) = capture.refused.first() {
			return Err(RemoteError::InputRefused {
				path: Str::new(&refused.path),
				rule: Str::new(&refused.rule),
			});
		}
		let hash: [u8; 32] = capture
			.manifest_hash
			.as_ref()
			.try_into()
			.map_err(|_| RemoteError::Manifest)?;
		request.inputs = Some(InputSet {
			manifest: Digest::new(Hash32::new(hash), capture.manifest_size),
			files:    capture.files,
			bytes:    capture.bytes,
			excluded: omp_exec::ExclusionCounts {
				rules:    Arc::from([]),
				symlinks: capture.excluded_symlinks,
			},
		});
		Ok(PreparedExecution { request, pins })
	}

	/// Builds the backend configuration for the validated destination.
	pub(crate) fn config(
		&self,
		pins: &RepoPins,
		profile: Profile,
		cache: CachePolicy,
		credential: Credential,
	) -> ExecuteConfig {
		let mut config = resume_config(profile, cache, credential);
		config.toolchains =
			BTreeMap::from([(CargoJust::toolchain(pins).to_string().into(), Toolchain {
				image: Some(self.image.clone()),
				env:   Arc::from([EnvEntry {
					name:  Str::new_static("PATH"),
					value: Str::new_static("/usr/local/cargo/bin:/usr/local/bin:/usr/bin:/bin"),
				}]),
			})]);
		config
	}

	/// Connects the generic backend after the caller authorizes the destination.
	///
	/// # Errors
	///
	/// Returns a typed profile, transport, authentication, or capability error.
	pub async fn connect(
		&self,
		environment: EnvClient,
		pins: &RepoPins,
		credential: Credential,
	) -> Result<ReapiBackend<EnvironmentInputs>, RemoteError> {
		let (profile, cache) = self.resolved_profile()?;
		self
			.connect_config(environment, self.config(pins, profile, cache, credential))
			.await
	}

	pub(crate) async fn connect_config(
		&self,
		environment: EnvClient,
		config: ExecuteConfig,
	) -> Result<ReapiBackend<EnvironmentInputs>, RemoteError> {
		ReapiBackend::connect(self.endpoint.clone(), config, EnvironmentInputs(environment))
			.await
			.map_err(RemoteError::Execute)
	}
}

/// The configuration of a backend that only resumes accepted work.
///
/// A resume plans and uploads nothing, so it maps no toolchain to an image.
fn resume_config(profile: Profile, cache: CachePolicy, credential: Credential) -> ExecuteConfig {
	ExecuteConfig {
		id: BackendId::new_static(BACKEND_NAME),
		instance: Str::new_static(INSTANCE),
		profile,
		credential: Some(credential),
		platform: Platform::LINUX_X86_64,
		enforced: REMOTE_POSTURE,
		cache,
		platform_properties: BTreeMap::new(),
		toolchains: BTreeMap::new(),
	}
}

/// Input source for a resume, which never uploads a new request.
#[derive(Clone)]
pub struct ResumeInputs;

impl BlobSource for ResumeInputs {
	fn read(&self, _digest: Digest) -> impl Future<Output = io::Result<Bytes>> + Send + '_ {
		std::future::ready(Err(io::Error::other("resume has no input blobs")))
	}

	fn read_range(
		&self,
		_digest: Digest,
		_offset: u64,
		_len: u64,
	) -> impl Future<Output = io::Result<Bytes>> + Send + '_ {
		std::future::ready(Err(io::Error::other("resume has no input blobs")))
	}
}

impl InputSource for ResumeInputs {
	fn files(
		&self,
		_manifest: Digest,
	) -> impl Future<Output = io::Result<Vec<InputFile>>> + Send + '_ {
		std::future::ready(Err(io::Error::other("resume has no input manifest")))
	}
}

/// A backend connected to resume work the operator's destination accepted.
///
/// A command credential retains its project Environment until the run ends.
pub struct ResumeConnection {
	backend:      ReapiBackend<ResumeInputs>,
	_environment: Option<omp_envd::ProjectEnvironment>,
}

impl ResumeConnection {
	/// Connects the backend `handle` names at the configured destination.
	///
	/// Call it only after the job's journaled destination matched
	/// [`ExecutionSettings::destination_identity`]: this is the first contact
	/// with the destination. Command credentials resolve in the project
	/// Environment at `root`, under the workspace trust stored in `data_dir`.
	/// Environment credentials do not start a project Environment. A daemon
	/// spawned for a command credential uses a two-second idle timeout.
	///
	/// # Errors
	///
	/// Refuses a handle that names another backend before anything starts, and
	/// returns the profile, Environment, credential, or connection failure.
	pub async fn open(
		settings: &ExecutionSettings,
		handle: &ReattachHandle,
		ctx: Arc<Ctx>,
		root: &Path,
		data_dir: &Path,
		cancel: &CancellationToken,
	) -> Result<Self, RemoteError> {
		if handle.backend.as_str() != BACKEND_NAME {
			return Err(RemoteError::UnknownBackend { backend: handle.backend.clone() });
		}
		let (profile, cache) = settings.resolved_profile()?;
		let (credential, environment) = if let Some(credential) = settings.environment_credential()? {
			(credential, None)
		} else {
			let state_dir = omp_env::project_state::directory(data_dir, root)
				.map_err(RemoteError::StateDirectory)?;
			fs::create_dir_all(&state_dir).map_err(RemoteError::StateDirectory)?;
			// No kernel is composed here, so the workspace's own stored decision
			// applies, failing closed when none was made.
			let workspace_trust = evaluate_workspace(data_dir, root).trust();
			let environment =
				omp_envd::ProjectEnvironment::attach(root, &state_dir, omp_envd::AttachOptions {
					py_eval:            false,
					approval_mode:      None,
					trusted_extensions: Vec::new(),
					contributed_values: Vec::new(),
					con:                ctx,
					bridges:            omp_envd::RegistryBridges {
						content: omp_envd::ActiveContentInputs {
							workspace_trust,
							..omp_envd::ActiveContentInputs::default()
						},
						..omp_envd::RegistryBridges::default()
					},
					spawn_idle_timeout: Some(2),
					spawn_policy:       CfgFiles::new(Some(root))
						.ok()
						.and_then(|files| files.daemon_policy(workspace_trust).ok()),
				})
				.await
				.map_err(RemoteError::Environment)?;
			let credential = settings
				.credential(environment.client(), root, cancel)
				.await?;
			(credential, Some(environment))
		};
		let backend = ReapiBackend::connect(
			settings.endpoint.clone(),
			resume_config(profile, cache, credential),
			ResumeInputs,
		)
		.await
		.map_err(RemoteError::Execute)?;
		Ok(Self { backend, _environment: environment })
	}

	/// The connected backend.
	#[must_use]
	pub const fn backend(&self) -> &ReapiBackend<ResumeInputs> {
		&self.backend
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn context(endpoint: &str) -> Ctx {
		let ctx = Ctx::new();
		SV_EXEC_REMOTE_ENDPOINT
			.set(&ctx, Str::new(endpoint))
			.unwrap();
		SV_EXEC_REMOTE_IMAGE
			.set(&ctx, Str::new_static("image@sha256:abc"))
			.unwrap();
		ctx
	}

	fn identity(endpoint: &str) -> DestinationIdentity {
		ExecutionSettings::generic(&context(endpoint))
			.unwrap()
			.destination_identity()
	}

	fn pins() -> RepoPins {
		RepoPins {
			rust_toolchain: Str::new_static("1.90.0"),
			nextest:        Str::new_static("0.9.100"),
			cpython_tag:    Str::new_static("20250101"),
			cpython:        Str::new_static("3.13.1"),
		}
	}

	#[test]
	fn unset_profile_convars_equal_the_portable_reapi_profile() {
		let ctx = context("grpcs://example.com");
		SV_EXEC_REMOTE_PROFILE
			.set(&ctx, Str::new_static("reapi"))
			.unwrap();
		SV_EXEC_REMOTE_CACHE
			.set(&ctx, Str::new_static("READ"))
			.unwrap();
		let (profile, cache) = ExecutionSettings::generic(&ctx)
			.unwrap()
			.resolved_profile()
			.unwrap();
		assert_eq!(profile, Profile::reapi());
		assert_eq!(cache, CachePolicy::Read);
	}

	#[test]
	fn operator_convars_reproduce_the_former_buildbuddy_profile_fields() {
		let ctx = context("grpcs://example.com");
		SV_EXEC_REMOTE_PROFILE
			.set(&ctx, Str::new_static("operator"))
			.unwrap();
		SV_EXEC_REMOTE_CREDENTIAL_HEADER
			.set(&ctx, Str::new_static("x-buildbuddy-api-key"))
			.unwrap();
		SV_EXEC_REMOTE_ARCH_SPELLING
			.set(&ctx, Str::new_static("short"))
			.unwrap();
		SV_EXEC_REMOTE_FIXED_PROPERTIES
			.set(&ctx, Str::new_static("workload-isolation-type=oci"))
			.unwrap();
		SV_EXEC_REMOTE_REFUSE_ACTION_CACHE.set(&ctx, true).unwrap();
		SV_EXEC_REMOTE_CACHE
			.set(&ctx, Str::new_static("off"))
			.unwrap();
		let (profile, cache) = ExecutionSettings::generic(&ctx)
			.unwrap()
			.resolved_profile()
			.unwrap();
		assert_eq!(profile.name.as_str(), "operator");
		assert_eq!(profile.credential_header.as_deref(), Some("x-buildbuddy-api-key"));
		assert_eq!(profile.arch, ArchSpelling::Short);
		assert_eq!(profile.image_property.as_str(), "container-image");
		assert_eq!(
			profile
				.fixed
				.get("workload-isolation-type")
				.map(Str::as_str),
			Some("oci")
		);
		assert_eq!(cache, CachePolicy::Off);
	}

	#[test]
	fn refuse_action_cache_rejects_non_off_cache_policy() {
		let ctx = context("grpcs://example.com");
		SV_EXEC_REMOTE_REFUSE_ACTION_CACHE.set(&ctx, true).unwrap();
		SV_EXEC_REMOTE_CACHE
			.set(&ctx, Str::new_static("read"))
			.unwrap();
		let err = ExecutionSettings::generic(&ctx)
			.unwrap()
			.resolved_profile()
			.unwrap_err();
		assert!(matches!(err, RemoteError::CachePolicyConflict), "got {err:?}");
	}

	#[test]
	fn fixed_properties_parse_comma_separated_pairs() {
		let fixed = parse_fixed_properties(" a=1 , b=two,c=3 ").unwrap();
		assert_eq!(fixed.get("a").map(Str::as_str), Some("1"));
		assert_eq!(fixed.get("b").map(Str::as_str), Some("two"));
		assert_eq!(fixed.get("c").map(Str::as_str), Some("3"));
		assert!(matches!(
			parse_fixed_properties("no-equals"),
			Err(RemoteError::InvalidFixedProperties)
		));
		assert!(matches!(
			parse_fixed_properties("=empty-key"),
			Err(RemoteError::InvalidFixedProperties)
		));
	}

	#[test]
	fn config_carries_the_validated_destination_and_pinned_toolchain() {
		let settings = ExecutionSettings::generic(&context("grpcs://example.com")).unwrap();
		let pins = pins();
		let config =
			settings.config(&pins, Profile::reapi(), CachePolicy::ReadWrite, Credential::new("token"));
		assert_eq!(config.id.as_str(), "remote");
		assert_eq!(config.instance.as_str(), "");
		assert_eq!(config.instance, settings.destination_identity().instance);
		assert_eq!(config.profile, Profile::reapi());
		assert_eq!(config.credential.as_ref().map(Credential::expose), Some("token"));
		assert_eq!(config.platform, Platform::LINUX_X86_64);
		assert_eq!(config.enforced, REMOTE_POSTURE);
		assert_eq!(config.cache, CachePolicy::ReadWrite);
		assert!(config.platform_properties.is_empty());
		assert_eq!(config.toolchains.len(), 1);
		let toolchain = &config.toolchains[CargoJust::toolchain(&pins).to_string().as_str()];
		assert_eq!(toolchain.image.as_deref(), Some("image@sha256:abc"));
		assert_eq!(&*toolchain.env, [EnvEntry {
			name:  Str::new_static("PATH"),
			value: Str::new_static("/usr/local/cargo/bin:/usr/local/bin:/usr/bin:/bin"),
		}]);
	}

	#[test]
	fn destination_identity_is_stable_and_distinguishes_endpoints() {
		let first = identity("grpcs://example.com");
		let same = identity("grpcs://example.com");
		let equivalent = identity("grpcs://example.com:443");
		let other = identity("grpcs://other.example.com");
		assert_eq!(first, same);
		assert_eq!(first, equivalent);
		assert_ne!(first, other);
		assert_ne!(identity("grpcs://example.com:8443"), identity("grpcs://example.com"));
		assert_ne!(identity("grpc://127.0.0.1:8980"), identity("grpcs://127.0.0.1:8980"));
		assert_eq!(first.backend.as_str(), "remote");
		assert_eq!(first.instance.as_str(), "");
		let json = serde_json::to_string(&first).unwrap();
		assert_eq!(serde_json::from_str::<DestinationIdentity>(&json).unwrap(), first);
	}

	#[test]
	fn resume_config_names_the_destination_and_pins_no_toolchain() {
		let settings = ExecutionSettings::generic(&context("grpcs://example.com")).unwrap();
		let config = resume_config(Profile::reapi(), CachePolicy::Read, Credential::new("token"));
		assert_eq!(config.id, settings.destination_identity().backend);
		assert_eq!(config.instance, settings.destination_identity().instance);
		assert_eq!(config.profile, Profile::reapi());
		assert_eq!(config.credential.as_ref().map(Credential::expose), Some("token"));
		assert_eq!(config.platform, Platform::LINUX_X86_64);
		assert_eq!(config.enforced, REMOTE_POSTURE);
		assert_eq!(config.cache, CachePolicy::Read);
		assert!(config.platform_properties.is_empty());
		assert!(config.toolchains.is_empty());
	}

	#[tokio::test]
	async fn resume_refuses_a_handle_for_another_backend_before_opening_anything() {
		let settings = ExecutionSettings::generic(&context("grpcs://example.com")).unwrap();
		let handle = ReattachHandle::new(
			BackendId::new_static("other"),
			Str::new_static("operations/1"),
			omp_exec::ExecutionId::new_static("exec-1"),
		);
		let missing = Path::new("/nonexistent/omp-resume");
		let opened = ResumeConnection::open(
			&settings,
			&handle,
			Arc::new(Ctx::new()),
			missing,
			missing,
			&CancellationToken::new(),
		)
		.await;
		assert!(
			matches!(&opened, Err(RemoteError::UnknownBackend { backend }) if backend.as_str() == "other")
		);
	}

	#[tokio::test]
	async fn resume_environment_credential_does_not_start_project_environment() {
		let temp = tempfile::tempdir().unwrap();
		let data_dir = temp.path().join("uncreated-data");
		let mut settings = ExecutionSettings::generic(&context("grpc://127.0.0.1:1")).unwrap();
		settings.credential_source = Str::new_static("env:PATH");
		let handle = ReattachHandle::new(
			BackendId::new_static("remote"),
			Str::new_static("operations/1"),
			omp_exec::ExecutionId::new_static("exec-1"),
		);
		let opened = tokio::time::timeout(
			Duration::from_secs(5),
			ResumeConnection::open(
				&settings,
				&handle,
				Arc::new(Ctx::new()),
				temp.path(),
				&data_dir,
				&CancellationToken::new(),
			),
		)
		.await
		.expect("connection attempt is bounded");
		assert!(opened.is_err());
		assert!(!data_dir.exists(), "environment credential must not start an environment");
		settings.credential_source = Str::new_static("!printf token");
		assert!(settings.environment_credential().unwrap().is_none());
	}
}
