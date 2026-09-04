//! AWS credential discovery, refresh, and bounded source resolution.
//!
//! The resolver follows the AWS SDK precedence exactly: environment, web
//! identity, shared profile, container credentials, then `IMDSv2`. Secret
//! values cross this module only as [`SecretString`] and every public
//! diagnostic is deliberately source-typed and redacted.

use std::{
	collections::{BTreeMap, BTreeSet},
	env, fmt, fs, io,
	path::{Path, PathBuf},
	process::Stdio,
	sync::{
		Arc, LazyLock,
		atomic::{AtomicU64, Ordering},
	},
	time::{Duration, SystemTime, UNIX_EPOCH},
};

use bytes::Bytes;
use futures::{
	FutureExt as _,
	future::{BoxFuture, Shared},
};
use http::{HeaderMap, HeaderValue, Method, Request, header::CONTENT_TYPE};
use omp_core::{ExposeSecret as _, SecretString, Str, hex, parse_rfc3339, sf};
use omp_oauth::OAuthRequestError;
use parking_lot::Mutex;
use ring::digest::{SHA1_FOR_LEGACY_USE_ONLY, digest};
use serde::Deserialize;
use tokio::{process::Command, time};
use tokio_util::sync::CancellationToken;
use url::Url;

use super::{
	lease::{
		AuthRejection, CredentialError, CredentialFuture, CredentialLease, CredentialNeed,
		CredentialSource, LeaseMeta,
	},
	oauth::{OAuthHttpClient, OAuthHttpRequest, OAuthTransportError, SystemOAuthHttpClient},
	sigv4::{AwsCredential, SigV4Error, sign_request},
	spec::SigV4Spec,
};

/// Refresh lead time used for every expiring AWS credential.
pub const AWS_REFRESH_SKEW: Duration = Duration::from_secs(60);
/// Cache lifetime for file session credentials whose source omits expiration.
pub const AWS_FILE_SESSION_CREDENTIAL_TTL: Duration = Duration::from_mins(5);
/// End-to-end ceiling for one shared credential-chain resolution.
pub const AWS_SHARED_RESOLVE_TIMEOUT: Duration = Duration::from_secs(30);
/// Per-request ceiling for EC2 metadata service calls.
pub const AWS_IMDS_REQUEST_TIMEOUT: Duration = Duration::from_secs(1);

const ECS_BASE_URL: &str = "http://169.254.170.2/";
const IMDS_IPV4_BASE_URL: &str = "http://169.254.169.254/";
const IMDS_IPV6_BASE_URL: &str = "http://[fd00:ec2::254]/";

/// Non-secret AWS profile and region selection for one resolver.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct AwsCredentialOptions {
	/// Explicit profile; otherwise `AWS_PROFILE`, then `default`.
	pub profile: Option<Str>,
	/// Explicit region; otherwise environment, shared config, then `us-east-1`.
	pub region:  Option<Str>,
}

/// Secret-free result of the AWS registry's local credential-source discovery.
///
/// This is availability evidence, not a credential lease. The probe never
/// retains or exposes bearer values, and never reads web-identity token
/// contents, container responses, IMDS responses, SSO caches, or
/// credential-process output.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AwsRegistryAvailability {
	profile:        Str,
	region:         Str,
	bearer:         bool,
	environment:    bool,
	web_identity:   bool,
	shared_profile: bool,
	container:      bool,
	imds:           bool,
}

impl AwsRegistryAvailability {
	/// Returns the effective shared-profile name used by discovery.
	pub fn profile(&self) -> &str {
		&self.profile
	}

	/// Returns the effective region used by Bedrock endpoints and `SigV4`.
	pub fn region(&self) -> &str {
		&self.region
	}

	/// Reports whether a Bedrock bearer token is configured.
	pub const fn has_bearer(&self) -> bool {
		self.bearer
	}

	/// Reports whether a complete access-key pair is configured in the
	/// environment.
	pub const fn has_environment_credentials(&self) -> bool {
		self.environment
	}

	/// Reports whether the ambient web-identity pair is configured.
	pub const fn has_web_identity(&self) -> bool {
		self.web_identity
	}

	/// Reports whether the selected shared profile terminates in a source the
	/// non-interactive resolver can use.
	pub const fn has_shared_profile(&self) -> bool {
		self.shared_profile
	}

	/// Reports whether an ECS/EKS container credential endpoint is configured.
	pub const fn has_container_credentials(&self) -> bool {
		self.container
	}

	/// Reports whether ambient EC2 instance metadata is eligible.
	pub const fn has_imds(&self) -> bool {
		self.imds
	}

	/// Reports whether any `SigV4` credential-chain source is locally
	/// discoverable.
	pub const fn has_sigv4_source(&self) -> bool {
		self.environment || self.web_identity || self.shared_profile || self.container || self.imds
	}

	/// Reports whether the Amazon Bedrock routes are eligible for construction.
	pub const fn bedrock_eligible(&self) -> bool {
		self.bearer || self.has_sigv4_source()
	}

	/// Reports whether the Bedrock Mantle route is eligible for construction.
	pub const fn mantle_eligible(&self) -> bool {
		self.bearer || self.has_sigv4_source()
	}

	/// Adds an invocation-scoped bearer override without retaining its value.
	pub const fn with_bearer_override(mut self) -> Self {
		self.bearer = true;
		self
	}
}

/// Exact environment ingress used by the AWS credential chain.
pub trait AwsCredentialEnvironment: Send + Sync {
	/// Reads one exact AWS variable without aliases.
	fn read(&self, name: &'static str) -> Result<Option<SecretString>, AwsEnvironmentError>;
}

/// Process environment implementation.
#[derive(Clone, Copy, Debug, Default)]
pub struct SystemAwsCredentialEnvironment;

impl AwsCredentialEnvironment for SystemAwsCredentialEnvironment {
	fn read(&self, name: &'static str) -> Result<Option<SecretString>, AwsEnvironmentError> {
		match env::var(name) {
			Ok(value) => Ok(Some(SecretString::from(value))),
			Err(env::VarError::NotPresent) => Ok(None),
			Err(env::VarError::NotUnicode(_)) => Err(AwsEnvironmentError::NotUnicode { name }),
		}
	}
}

/// Typed, secret-free process-environment failure.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum AwsEnvironmentError {
	/// An AWS variable was present but could not be represented as UTF-8.
	#[error("AWS environment variable {name} is not valid Unicode")]
	NotUnicode {
		/// Exact non-secret variable name.
		name: &'static str,
	},
}

/// AWS credential operation used in redacted errors.
#[derive(Clone, Copy, Debug, Eq, PartialEq, strum::Display)]
#[strum(serialize_all = "kebab-case")]
pub enum AwsCredentialOperation {
	/// Shared credentials file.
	CredentialsFile,
	/// Shared config file.
	ConfigFile,
	/// Web identity token file.
	WebIdentityToken,
	/// Web identity STS exchange.
	WebIdentityExchange,
	/// Signed STS role exchange.
	AssumeRole,
	/// SSO cache directory.
	SsoCache,
	/// SSO role credential exchange.
	SsoRole,
	/// External credential process.
	CredentialProcess,
	/// Container authorization token file.
	ContainerToken,
	/// Container credential endpoint.
	Container,
	/// EC2 metadata service.
	Imds,
}

/// Fully typed AWS credential failure. No variant retains response bodies,
/// tokens, process output, or request URLs.
#[derive(Clone, Debug, thiserror::Error)]
pub enum AwsCredentialError {
	/// Environment access failed.
	#[error(transparent)]
	Environment(#[from] AwsEnvironmentError),
	/// Filesystem access failed.
	#[error("AWS {operation} I/O failed")]
	Io {
		/// Failing operation.
		operation: AwsCredentialOperation,
		/// Typed source error, which contains no file contents.
		#[source]
		source:    Arc<io::Error>,
	},
	/// A configured endpoint was rejected by credential-source safety policy.
	#[error("AWS {operation} endpoint is unsafe")]
	InvalidEndpoint {
		/// Failing operation.
		operation: AwsCredentialOperation,
	},
	/// A configured endpoint was not a valid URL.
	#[error("AWS {operation} endpoint URL is invalid")]
	Url {
		/// Failing operation.
		operation: AwsCredentialOperation,
		/// Typed URL parser source.
		#[source]
		source:    url::ParseError,
	},
	/// A typed HTTP request could not be constructed.
	#[error("AWS {operation} request is invalid")]
	Request {
		/// Failing operation.
		operation: AwsCredentialOperation,
		/// Typed request-validation source.
		#[source]
		source:    OAuthRequestError,
	},
	/// An HTTP request builder rejected the finalized signed request.
	#[error("AWS {operation} request construction failed")]
	RequestBuild {
		/// Failing operation.
		operation: AwsCredentialOperation,
		/// Typed HTTP builder source.
		#[source]
		source:    Arc<http::Error>,
	},
	/// A signed STS request could not be finalized.
	#[error("AWS assume-role request signing failed")]
	Signing {
		/// Typed `SigV4` source.
		#[source]
		source: SigV4Error,
	},
	/// A bounded network exchange failed before an HTTP response.
	#[error("AWS {operation} transport failed")]
	Transport {
		/// Failing operation.
		operation: AwsCredentialOperation,
		/// Typed transport source.
		#[source]
		source:    OAuthTransportError,
	},
	/// A bounded network exchange returned a non-success status.
	#[error("AWS {operation} returned HTTP {status}")]
	Http {
		/// Failing operation.
		operation: AwsCredentialOperation,
		/// Response status only; the body is intentionally discarded.
		status:    u16,
	},
	/// A JSON response was malformed.
	#[error("AWS {operation} returned malformed JSON")]
	Json {
		/// Failing operation.
		operation: AwsCredentialOperation,
		/// Parser source; it carries location, never the source document.
		#[source]
		source:    Arc<serde_json::Error>,
	},
	/// A response omitted required credential fields.
	#[error("AWS {operation} response is missing required credential fields")]
	MissingCredentialFields {
		/// Failing operation.
		operation: AwsCredentialOperation,
	},
	/// A dynamic credential omitted a valid expiration.
	#[error("AWS {operation} response has a missing or invalid expiration")]
	InvalidExpiration {
		/// Failing operation.
		operation: AwsCredentialOperation,
	},
	/// No source in the AWS chain produced credentials.
	#[error("no AWS credential source produced usable credentials")]
	Unavailable,
	/// Shared resolution exceeded its hard deadline.
	#[error("AWS credential resolution exceeded its bounded deadline")]
	ResolutionTimeout,
	/// A profile role chain contains a cycle.
	#[error("AWS profile role chain contains a cycle at {profile}")]
	ProfileCycle {
		/// Non-secret profile name.
		profile: Str,
	},
	/// A role profile has no supported base credential source.
	#[error("AWS role profile {profile} has no usable base credential source")]
	RoleSourceMissing {
		/// Non-secret profile name.
		profile: Str,
	},
	/// A role profile requires unsupported interactive MFA.
	#[error("AWS profile {profile} requires unsupported interactive MFA")]
	MfaUnsupported {
		/// Non-secret profile name.
		profile: Str,
	},
	/// A profile names an unsupported `credential_source` value.
	#[error("AWS profile {profile} names an unsupported credential source")]
	UnsupportedCredentialSource {
		/// Non-secret profile name.
		profile: Str,
	},
	/// SSO cached login is absent.
	#[error("AWS SSO cached login is missing")]
	SsoTokenMissing,
	/// SSO cached login has expired.
	#[error("AWS SSO cached login has expired")]
	SsoTokenExpired,
	/// `credential_process` had an invalid command line.
	#[error("AWS credential process command is invalid")]
	InvalidProcessCommand,
	/// `credential_process` could not be launched or awaited.
	#[error("AWS credential process execution failed")]
	ProcessIo {
		/// Typed process source.
		#[source]
		source: Arc<io::Error>,
	},
	/// `credential_process` exited unsuccessfully. Output is discarded.
	#[error("AWS credential process exited with status {status}")]
	ProcessStatus {
		/// Exit status, or `-1` when terminated without one.
		status: i32,
	},
	/// `credential_process` returned a malformed envelope.
	#[error("AWS credential process returned a malformed envelope")]
	ProcessEnvelope {
		/// Parser source; source text is not retained.
		#[source]
		source: Arc<serde_json::Error>,
	},
	/// `credential_process` returned an unsupported protocol version.
	#[error("AWS credential process returned an unsupported protocol version")]
	ProcessVersion,
}

impl AwsCredentialError {
	const fn credential_error(&self) -> CredentialError {
		match self {
			Self::Unavailable => CredentialError::Unavailable,
			_ => CredentialError::SourceFailure,
		}
	}
}

#[derive(Clone)]
struct ResolvedCredential {
	access_key_id:     SecretString,
	secret_access_key: SecretString,
	session_token:     Option<SecretString>,
	expires_at:        Option<SystemTime>,
}

impl fmt::Debug for ResolvedCredential {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("ResolvedCredential")
			.field("material", &"[REDACTED]")
			.field("expires_at", &self.expires_at)
			.finish()
	}
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct CacheKey {
	profile:            Str,
	region:             Str,
	load_shared_config: bool,
}

#[derive(Clone)]
struct CacheEntry {
	credential: ResolvedCredential,
	generation: u64,
}

type SharedResolution = Shared<BoxFuture<'static, Result<CacheEntry, AwsCredentialError>>>;

#[derive(Default)]
struct ResolverState {
	cache:        BTreeMap<CacheKey, CacheEntry>,
	availability: BTreeMap<CacheKey, AwsRegistryAvailability>,
	flights:      BTreeMap<CacheKey, SharedResolution>,
}

static SYSTEM_STATE: LazyLock<Arc<Mutex<ResolverState>>> =
	LazyLock::new(|| Arc::new(Mutex::new(ResolverState::default())));
static SYSTEM_GENERATION: LazyLock<Arc<AtomicU64>> = LazyLock::new(|| Arc::new(AtomicU64::new(0)));

/// Process-wide-style AWS credential source with per-profile/region caching
/// and single-flight cold resolution.
#[derive(Clone)]
pub struct AwsCredentialSource {
	options:     AwsCredentialOptions,
	environment: Arc<dyn AwsCredentialEnvironment>,
	http:        Arc<dyn OAuthHttpClient>,
	state:       Arc<Mutex<ResolverState>>,
	generation:  Arc<AtomicU64>,
}

impl AwsCredentialSource {
	/// Constructs the production AWS chain over the process environment and the
	/// shared bounded rustls HTTP transport.
	pub fn system() -> Self {
		Self {
			options:     AwsCredentialOptions::default(),
			environment: Arc::new(SystemAwsCredentialEnvironment),
			http:        Arc::new(SystemOAuthHttpClient::with_timeout(AWS_SHARED_RESOLVE_TIMEOUT)),
			state:       Arc::clone(&SYSTEM_STATE),
			generation:  Arc::clone(&SYSTEM_GENERATION),
		}
	}

	/// Constructs an injected resolver for a fixed profile/region scope.
	pub fn new(
		options: AwsCredentialOptions,
		environment: Arc<dyn AwsCredentialEnvironment>,
		http: Arc<dyn OAuthHttpClient>,
	) -> Self {
		Self {
			options,
			environment,
			http,
			state: Arc::new(Mutex::new(ResolverState::default())),
			generation: Arc::new(AtomicU64::new(0)),
		}
	}

	/// Resolves an opaque signing lease while preserving typed AWS failures.
	pub async fn resolve(
		&self,
		need: &CredentialNeed,
	) -> Result<CredentialLease, AwsCredentialError> {
		self.resolve_for_need(need, false).await
	}

	/// Resolves the effective non-secret region through the same environment
	/// and shared-profile precedence used by credential acquisition.
	pub async fn effective_region(&self) -> Result<Str, AwsCredentialError> {
		Ok(self.resolve_scope(&self.options).await?.region)
	}

	/// Discovers the local AWS sources that make Bedrock routes eligible.
	///
	/// Discovery is filesystem-local and side-effect-free: it examines source
	/// configuration but never executes a credential process or calls STS,
	/// container endpoints, or IMDS. Results share the resolver's exact
	/// profile/region cache scope.
	pub async fn registry_availability(
		&self,
	) -> Result<AwsRegistryAvailability, AwsCredentialError> {
		let key = self.resolve_scope(&self.options).await?;
		if let Some(availability) = self.state.lock().availability.get(&key).cloned() {
			return Ok(availability);
		}
		let availability = self.discover_registry_availability(&key).await?;
		self
			.state
			.lock()
			.availability
			.insert(key, availability.clone());
		Ok(availability)
	}

	/// Clears every cached scope. In-flight work remains shared and bounded.
	pub fn clear_cache(&self) {
		let mut state = self.state.lock();
		state.cache.clear();
		state.availability.clear();
	}

	/// Invalidates the exact effective profile/region scope.
	pub async fn invalidate(&self, options: AwsCredentialOptions) -> Result<(), AwsCredentialError> {
		let key = self.resolve_scope(&options).await?;
		let mut state = self.state.lock();
		state.cache.remove(&key);
		state.availability.remove(&key);
		Ok(())
	}

	async fn resolve_for_need(
		&self,
		need: &CredentialNeed,
		force: bool,
	) -> Result<CredentialLease, AwsCredentialError> {
		let key = self.resolve_scope(&self.options).await?;
		if !force && let Some(entry) = self.cached(&key, SystemTime::now()) {
			return Ok(self.lease_from(entry, need));
		}
		let flight = {
			let mut state = self.state.lock();
			if let Some(existing) = state.flights.get(&key) {
				existing.clone()
			} else {
				let resolver = self.clone();
				let flight_key = key.clone();
				let flight = async move {
					let result =
						time::timeout(AWS_SHARED_RESOLVE_TIMEOUT, resolver.resolve_fresh(&flight_key))
							.await
							.map_err(|_| AwsCredentialError::ResolutionTimeout)?
							.map(|credential| CacheEntry {
								credential,
								generation: resolver
									.generation
									.fetch_add(1, Ordering::Relaxed)
									.saturating_add(1),
							});
					let mut state = resolver.state.lock();
					if let Ok(entry) = &result {
						state.cache.insert(flight_key.clone(), entry.clone());
					}
					state.flights.remove(&flight_key);
					result
				}
				.boxed()
				.shared();
				state.flights.insert(key.clone(), flight.clone());
				flight
			}
		};
		let entry = flight.await?;
		Ok(self.lease_from(entry, need))
	}

	fn cached(&self, key: &CacheKey, now: SystemTime) -> Option<CacheEntry> {
		let state = self.state.lock();
		let entry = state.cache.get(key)?;
		let fresh = entry.credential.expires_at.is_none_or(|expiration| {
			expiration
				.duration_since(now)
				.is_ok_and(|remaining| remaining > AWS_REFRESH_SKEW)
		});
		fresh.then(|| entry.clone())
	}

	fn lease_from(&self, entry: CacheEntry, need: &CredentialNeed) -> CredentialLease {
		let profile = self
			.options
			.profile
			.clone()
			.unwrap_or_else(|| Str::new("aws"));
		let account = need
			.account
			.clone()
			.unwrap_or_else(|| crate::AccountId::from(profile.as_str()));
		let principal = need
			.principal
			.clone()
			.unwrap_or_else(|| crate::PrincipalId::from("aws-chain"));
		CredentialLease::aws_sigv4(
			LeaseMeta {
				account,
				principal,
				generation: entry.generation,
				expires_at: entry.credential.expires_at,
			},
			entry.credential.access_key_id,
			entry.credential.secret_access_key,
			entry.credential.session_token,
		)
	}

	async fn resolve_scope(
		&self,
		options: &AwsCredentialOptions,
	) -> Result<CacheKey, AwsCredentialError> {
		let env_profile = self.env_text("AWS_PROFILE")?;
		let explicit_profile = options.profile.clone().filter(|value| !value.is_empty());
		let profile = explicit_profile
			.clone()
			.or(env_profile.clone())
			.unwrap_or_else(|| Str::new("default"));
		let load_shared_config = explicit_profile.is_some()
			|| env_profile.is_some()
			|| self
				.env_text("AWS_SDK_LOAD_CONFIG")?
				.is_some_and(|value| matches!(value.to_ascii_lowercase().as_str(), "1" | "true"));
		let region = if let Some(region) = options.region.as_ref().filter(|value| !value.is_empty()) {
			region.clone()
		} else if let Some(region) = self.env_text("AWS_REGION")? {
			region
		} else if let Some(region) = self.env_text("AWS_DEFAULT_REGION")? {
			region
		} else if load_shared_config {
			self
				.profile_region(&profile)
				.await?
				.unwrap_or_else(|| Str::new("us-east-1"))
		} else {
			Str::new("us-east-1")
		};
		Ok(CacheKey { profile, region, load_shared_config })
	}

	async fn profile_region(&self, profile: &str) -> Result<Option<Str>, AwsCredentialError> {
		let Some(path) = self.config_path()? else {
			return Ok(None);
		};
		let Ok(Some(ini)) = read_ini_file(&path, AwsCredentialOperation::ConfigFile).await else {
			return Ok(None);
		};
		Ok(ini
			.get(profile)
			.and_then(|section| section.get("region"))
			.filter(|region| !region.is_empty())
			.cloned())
	}

	async fn discover_registry_availability(
		&self,
		key: &CacheKey,
	) -> Result<AwsRegistryAvailability, AwsCredentialError> {
		let bearer = self.env_secret("OMP_AWS_BEARER_TOKEN_BEDROCK")?.is_some()
			|| self.env_secret("AWS_BEARER_TOKEN_BEDROCK")?.is_some();
		let environment = self.environment_source_configured()?;
		let web_identity = self.web_identity_source_configured()?;
		let container = self.container_source_configured()?;
		let metadata_enabled = self.metadata_enabled()?;
		let imds = metadata_enabled
			&& (self
				.env_text("AWS_EC2_METADATA_SERVICE_ENDPOINT")?
				.is_some()
				|| is_ec2_host());
		let shared_profile = match self
			.profile_source_configured(key, environment, container, metadata_enabled)
			.await
		{
			Ok(configured) => configured,
			Err(_) if bearer || environment || web_identity || container || imds => false,
			Err(source) => return Err(source),
		};
		Ok(AwsRegistryAvailability {
			profile: key.profile.clone(),
			region: key.region.clone(),
			bearer,
			environment,
			web_identity,
			shared_profile,
			container,
			imds,
		})
	}

	async fn profile_source_configured(
		&self,
		key: &CacheKey,
		environment: bool,
		container: bool,
		metadata_enabled: bool,
	) -> Result<bool, AwsCredentialError> {
		let credentials = match self.credentials_path()? {
			Some(path) => read_ini_file(&path, AwsCredentialOperation::CredentialsFile).await?,
			None => None,
		};
		let config = if key.load_shared_config {
			match self.config_path()? {
				Some(path) => read_ini_file(&path, AwsCredentialOperation::ConfigFile).await?,
				None => None,
			}
		} else {
			None
		};
		profile_has_credential_source(
			&key.profile,
			credentials.as_ref(),
			config.as_ref(),
			environment,
			container,
			metadata_enabled,
			BTreeSet::new(),
		)
	}

	fn environment_source_configured(&self) -> Result<bool, AwsCredentialError> {
		Ok(self.env_secret("AWS_ACCESS_KEY_ID")?.is_some()
			&& self.env_secret("AWS_SECRET_ACCESS_KEY")?.is_some())
	}

	fn web_identity_source_configured(&self) -> Result<bool, AwsCredentialError> {
		Ok(self.env_text("AWS_WEB_IDENTITY_TOKEN_FILE")?.is_some()
			&& self.env_text("AWS_ROLE_ARN")?.is_some())
	}

	fn container_source_configured(&self) -> Result<bool, AwsCredentialError> {
		Ok(self
			.env_text("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI")?
			.is_some()
			|| self
				.env_text("AWS_CONTAINER_CREDENTIALS_FULL_URI")?
				.is_some())
	}

	fn metadata_enabled(&self) -> Result<bool, AwsCredentialError> {
		Ok(!self
			.env_text("AWS_EC2_METADATA_DISABLED")?
			.is_some_and(|value| value.eq_ignore_ascii_case("true")))
	}

	async fn resolve_fresh(&self, key: &CacheKey) -> Result<ResolvedCredential, AwsCredentialError> {
		if let Some(value) = self.environment_credentials()? {
			return Ok(value);
		}
		if let Some(value) = self.web_identity_credentials(&key.region).await? {
			return Ok(value);
		}
		if let Some(value) = self.profile_credentials(key).await? {
			return Ok(value);
		}
		if let Some(value) = self.container_credentials().await? {
			return Ok(value);
		}
		if !self
			.env_text("AWS_EC2_METADATA_DISABLED")?
			.is_some_and(|value| value.eq_ignore_ascii_case("true"))
			&& let Some(value) = self.imds_credentials().await?
		{
			return Ok(value);
		}
		Err(AwsCredentialError::Unavailable)
	}

	fn env_secret(&self, name: &'static str) -> Result<Option<SecretString>, AwsCredentialError> {
		Ok(self
			.environment
			.read(name)?
			.filter(|value| !value.expose_secret().is_empty()))
	}

	fn env_text(&self, name: &'static str) -> Result<Option<Str>, AwsCredentialError> {
		Ok(self
			.env_secret(name)?
			.map(|value| Str::new(value.expose_secret())))
	}

	fn environment_credentials(&self) -> Result<Option<ResolvedCredential>, AwsCredentialError> {
		let Some(access_key_id) = self.env_secret("AWS_ACCESS_KEY_ID")? else {
			return Ok(None);
		};
		let Some(secret_access_key) = self.env_secret("AWS_SECRET_ACCESS_KEY")? else {
			return Ok(None);
		};
		Ok(Some(ResolvedCredential {
			access_key_id,
			secret_access_key,
			session_token: self.env_secret("AWS_SESSION_TOKEN")?,
			expires_at: None,
		}))
	}

	fn credentials_path(&self) -> Result<Option<PathBuf>, AwsCredentialError> {
		if let Some(path) = self.env_text("AWS_SHARED_CREDENTIALS_FILE")? {
			return Ok(Some(PathBuf::from(path.as_str())));
		}
		Ok(home_directory(self.environment.as_ref())?.map(|home| home.join(".aws/credentials")))
	}

	fn config_path(&self) -> Result<Option<PathBuf>, AwsCredentialError> {
		if let Some(path) = self.env_text("AWS_CONFIG_FILE")? {
			return Ok(Some(PathBuf::from(path.as_str())));
		}
		Ok(home_directory(self.environment.as_ref())?.map(|home| home.join(".aws/config")))
	}

	async fn profile_credentials(
		&self,
		key: &CacheKey,
	) -> Result<Option<ResolvedCredential>, AwsCredentialError> {
		let credentials = match self.credentials_path()? {
			Some(path) => read_ini_file(&path, AwsCredentialOperation::CredentialsFile).await?,
			None => None,
		};
		let config = if key.load_shared_config {
			match self.config_path()? {
				Some(path) => read_ini_file(&path, AwsCredentialOperation::ConfigFile).await?,
				None => None,
			}
		} else {
			None
		};
		let context = ProfileContext {
			credentials: &credentials,
			config:      &config,
			region:      &key.region,
		};
		self
			.resolve_profile_chain(&key.profile, &context, BTreeSet::new())
			.await
	}

	fn resolve_profile_chain<'a>(
		&'a self,
		profile: &'a str,
		context: &'a ProfileContext<'a>,
		mut seen: BTreeSet<Str>,
	) -> BoxFuture<'a, Result<Option<ResolvedCredential>, AwsCredentialError>> {
		async move {
			if !seen.insert(Str::new(profile)) {
				return Err(AwsCredentialError::ProfileCycle { profile: Str::new(profile) });
			}
			let mut merged = context
				.config
				.as_ref()
				.and_then(|ini| ini.get(profile))
				.cloned()
				.unwrap_or_default();
			if let Some(values) = context
				.credentials
				.as_ref()
				.and_then(|ini| ini.get(profile))
			{
				merged.extend(values.clone());
			}
			if merged.is_empty() {
				return Ok(None);
			}
			if let Some(role_arn) = merged.get("role_arn").filter(|value| !value.is_empty()) {
				if let Some(token_file) = merged
					.get("web_identity_token_file")
					.filter(|value| !value.is_empty())
				{
					return self
						.assume_role_with_web_identity(
							role_arn,
							token_file,
							merged.get("role_session_name").map(Str::as_str),
							context.region,
						)
						.await
						.map(Some);
				}
				if merged
					.get("mfa_serial")
					.is_some_and(|value| !value.is_empty())
				{
					return Err(AwsCredentialError::MfaUnsupported { profile: Str::new(profile) });
				}
				let base = if let Some(source_profile) = merged
					.get("source_profile")
					.filter(|value| !value.is_empty())
				{
					self
						.resolve_profile_chain(source_profile, context, seen)
						.await?
						.ok_or_else(|| AwsCredentialError::RoleSourceMissing {
							profile: Str::new(profile),
						})?
				} else if let Some(source) = merged
					.get("credential_source")
					.filter(|value| !value.is_empty())
				{
					self
						.resolve_credential_source(source, context.region, profile)
						.await?
						.ok_or_else(|| AwsCredentialError::RoleSourceMissing {
							profile: Str::new(profile),
						})?
				} else {
					return Err(AwsCredentialError::RoleSourceMissing { profile: Str::new(profile) });
				};
				return self
					.assume_role(
						&base,
						role_arn,
						context.region,
						merged.get("role_session_name").map(Str::as_str),
						merged.get("duration_seconds").map(Str::as_str),
						merged.get("external_id").map(Str::as_str),
					)
					.await
					.map(Some);
			}
			if let (Some(access_key_id), Some(secret_access_key)) = (
				merged
					.get("aws_access_key_id")
					.filter(|value| !value.is_empty()),
				merged
					.get("aws_secret_access_key")
					.filter(|value| !value.is_empty()),
			) {
				let session_token = merged
					.get("aws_session_token")
					.filter(|value| !value.is_empty());
				let expires_at =
					session_token.map(|_| SystemTime::now() + AWS_FILE_SESSION_CREDENTIAL_TTL);
				return Ok(Some(ResolvedCredential {
					access_key_id: SecretString::from(access_key_id.to_string()),
					secret_access_key: SecretString::from(secret_access_key.to_string()),
					session_token: session_token.map(|value| SecretString::from(value.to_string())),
					expires_at,
				}));
			}
			if merged
				.get("sso_account_id")
				.is_some_and(|value| !value.is_empty())
				&& merged
					.get("sso_role_name")
					.is_some_and(|value| !value.is_empty())
			{
				return self
					.sso_credentials(&merged, context.config.as_ref())
					.await
					.map(Some);
			}
			if let Some(command) = merged
				.get("credential_process")
				.filter(|value| !value.is_empty())
			{
				return self.credential_process(command).await.map(Some);
			}
			Ok(None)
		}
		.boxed()
	}

	async fn resolve_credential_source(
		&self,
		source: &str,
		_region: &str,
		profile: &str,
	) -> Result<Option<ResolvedCredential>, AwsCredentialError> {
		match source {
			"Environment" => self.environment_credentials(),
			"Ec2InstanceMetadata" => {
				if self
					.env_text("AWS_EC2_METADATA_DISABLED")?
					.is_some_and(|value| value.eq_ignore_ascii_case("true"))
				{
					Ok(None)
				} else {
					self.imds_credentials().await
				}
			},
			"EcsContainer" => self.container_credentials().await,
			_ => Err(AwsCredentialError::UnsupportedCredentialSource { profile: Str::new(profile) }),
		}
	}

	async fn web_identity_credentials(
		&self,
		region: &str,
	) -> Result<Option<ResolvedCredential>, AwsCredentialError> {
		let Some(token_file) = self.env_text("AWS_WEB_IDENTITY_TOKEN_FILE")? else {
			return Ok(None);
		};
		let Some(role_arn) = self.env_text("AWS_ROLE_ARN")? else {
			return Ok(None);
		};
		let session_name = self.env_text("AWS_ROLE_SESSION_NAME")?;
		self
			.assume_role_with_web_identity(&role_arn, &token_file, session_name.as_deref(), region)
			.await
			.map(Some)
	}

	async fn assume_role_with_web_identity(
		&self,
		role_arn: &str,
		token_file: &str,
		session_name: Option<&str>,
		region: &str,
	) -> Result<ResolvedCredential, AwsCredentialError> {
		let token = tokio::fs::read_to_string(token_file)
			.await
			.map_err(|source| AwsCredentialError::Io {
				operation: AwsCredentialOperation::WebIdentityToken,
				source:    Arc::new(source),
			})?;
		if token.trim().is_empty() {
			return Err(AwsCredentialError::MissingCredentialFields {
				operation: AwsCredentialOperation::WebIdentityToken,
			});
		}
		let generated_session = format!("omp-{}", std::process::id());
		let body = form(&[
			("Action", "AssumeRoleWithWebIdentity"),
			("Version", "2011-06-15"),
			("RoleArn", role_arn),
			("RoleSessionName", session_name.unwrap_or(&generated_session)),
			("WebIdentityToken", token.trim()),
		]);
		let endpoint = sts_endpoint(region);
		let response = self
			.http(
				AwsCredentialOperation::WebIdentityExchange,
				Method::POST,
				&endpoint,
				form_headers(),
				Some(SecretString::from(body)),
				None,
			)
			.await?;
		parse_sts_credentials(
			response.body.expose_secret(),
			AwsCredentialOperation::WebIdentityExchange,
		)
	}

	async fn assume_role(
		&self,
		base: &ResolvedCredential,
		role_arn: &str,
		region: &str,
		session_name: Option<&str>,
		duration_seconds: Option<&str>,
		external_id: Option<&str>,
	) -> Result<ResolvedCredential, AwsCredentialError> {
		let generated_session = format!("omp-{}", std::process::id());
		let mut fields = vec![
			("Action", "AssumeRole"),
			("Version", "2011-06-15"),
			("RoleArn", role_arn),
			("RoleSessionName", session_name.unwrap_or(&generated_session)),
		];
		if let Some(value) = duration_seconds {
			fields.push(("DurationSeconds", value));
		}
		if let Some(value) = external_id {
			fields.push(("ExternalId", value));
		}
		let body = form(&fields);
		let endpoint = sts_endpoint(region);
		let mut request = Request::builder()
			.method(Method::POST)
			.uri(&endpoint)
			.body(Bytes::copy_from_slice(body.as_bytes()))
			.map_err(|source| AwsCredentialError::RequestBuild {
				operation: AwsCredentialOperation::AssumeRole,
				source:    Arc::new(source),
			})?;
		request
			.headers_mut()
			.insert(CONTENT_TYPE, HeaderValue::from_static("application/x-www-form-urlencoded"));
		let credential = AwsCredential::new(
			base.access_key_id.clone(),
			base.secret_access_key.clone(),
			base.session_token.clone(),
		);
		sign_request(
			&credential,
			&SigV4Spec {
				service:          Str::new("sts"),
				region:           Str::new(region),
				unsigned_headers: Vec::new(),
			},
			SystemTime::now(),
			&mut request,
		)
		.map_err(|source| AwsCredentialError::Signing { source })?;
		let headers = request.headers().clone();
		let response = self
			.http(
				AwsCredentialOperation::AssumeRole,
				Method::POST,
				&endpoint,
				headers,
				Some(SecretString::from(body)),
				None,
			)
			.await?;
		parse_sts_credentials(response.body.expose_secret(), AwsCredentialOperation::AssumeRole)
	}

	async fn sso_credentials(
		&self,
		profile: &BTreeMap<Str, Str>,
		config: Option<&AwsIni>,
	) -> Result<ResolvedCredential, AwsCredentialError> {
		let mut start_url = profile.get("sso_start_url").cloned();
		let mut region = profile.get("sso_region").cloned();
		let session_name = profile.get("sso_session");
		let session_key = session_name.map(|name| format!("sso-session:{name}"));
		if let Some(session) = session_key
			.as_deref()
			.and_then(|key| config.and_then(|ini| ini.get(key)))
		{
			start_url = start_url.or_else(|| session.get("sso_start_url").cloned());
			region = region.or_else(|| session.get("sso_region").cloned());
		}
		let (Some(start_url), Some(region)) = (start_url, region) else {
			return Err(AwsCredentialError::SsoTokenMissing);
		};
		let token = self
			.load_sso_token(&start_url, session_name.map(Str::as_str))
			.await?
			.ok_or(AwsCredentialError::SsoTokenMissing)?;
		if token
			.expires_at
			.as_deref()
			.and_then(parse_rfc3339)
			.is_some_and(|expiration| expiration <= SystemTime::now())
		{
			return Err(AwsCredentialError::SsoTokenExpired);
		}
		let access_token = token
			.access_token
			.filter(|token| !token.is_empty())
			.ok_or(AwsCredentialError::SsoTokenMissing)?;
		let account = profile
			.get("sso_account_id")
			.ok_or(AwsCredentialError::SsoTokenMissing)?;
		let role = profile
			.get("sso_role_name")
			.ok_or(AwsCredentialError::SsoTokenMissing)?;
		let mut url =
			Url::parse(&format!("https://portal.sso.{region}.amazonaws.com/federation/credentials"))
				.map_err(|source| AwsCredentialError::Url {
				operation: AwsCredentialOperation::SsoRole,
				source,
			})?;
		url.query_pairs_mut()
			.append_pair("account_id", account)
			.append_pair("role_name", role);
		let mut headers = HeaderMap::new();
		let mut token_header = HeaderValue::from_str(&access_token).map_err(|_| {
			AwsCredentialError::MissingCredentialFields { operation: AwsCredentialOperation::SsoRole }
		})?;
		token_header.set_sensitive(true);
		headers.insert("x-amz-sso_bearer_token", token_header);
		let response = self
			.http(AwsCredentialOperation::SsoRole, Method::GET, url.as_str(), headers, None, None)
			.await?;
		let envelope: SsoRoleEnvelope =
			serde_json::from_str(response.body.expose_secret()).map_err(|source| {
				AwsCredentialError::Json {
					operation: AwsCredentialOperation::SsoRole,
					source:    Arc::new(source),
				}
			})?;
		let role = envelope
			.role_credentials
			.ok_or(AwsCredentialError::MissingCredentialFields {
				operation: AwsCredentialOperation::SsoRole,
			})?;
		if role.access_key_id.is_empty()
			|| role.secret_access_key.is_empty()
			|| role.session_token.is_empty()
		{
			return Err(AwsCredentialError::MissingCredentialFields {
				operation: AwsCredentialOperation::SsoRole,
			});
		}
		let expiration = UNIX_EPOCH
			.checked_add(Duration::from_millis(role.expiration))
			.ok_or(AwsCredentialError::InvalidExpiration {
				operation: AwsCredentialOperation::SsoRole,
			})?;
		Ok(ResolvedCredential {
			access_key_id:     SecretString::from(role.access_key_id),
			secret_access_key: SecretString::from(role.secret_access_key),
			session_token:     Some(SecretString::from(role.session_token)),
			expires_at:        Some(expiration),
		})
	}

	async fn load_sso_token(
		&self,
		start_url: &str,
		session_name: Option<&str>,
	) -> Result<Option<SsoToken>, AwsCredentialError> {
		let Some(home) = home_directory(self.environment.as_ref())? else {
			return Ok(None);
		};
		let directory = home.join(".aws/sso/cache");
		let mut entries = match tokio::fs::read_dir(&directory).await {
			Ok(entries) => entries,
			Err(source) if source.kind() == io::ErrorKind::NotFound => return Ok(None),
			Err(source) => {
				return Err(AwsCredentialError::Io {
					operation: AwsCredentialOperation::SsoCache,
					source:    Arc::new(source),
				});
			},
		};
		let key = session_name.unwrap_or(start_url);
		let hash =
			hex::encode(digest(&SHA1_FOR_LEGACY_USE_ONLY, key.as_bytes()).as_ref()).into_string();
		let preferred = format!("{hash}.json");
		let mut paths = Vec::new();
		while let Some(entry) =
			entries
				.next_entry()
				.await
				.map_err(|source| AwsCredentialError::Io {
					operation: AwsCredentialOperation::SsoCache,
					source:    Arc::new(source),
				})? {
			let path = entry.path();
			if path
				.extension()
				.is_some_and(|extension| extension == "json")
			{
				paths.push(path);
			}
		}
		paths.sort_by_key(|path| {
			path
				.file_name()
				.is_none_or(|name| name != preferred.as_str())
		});
		for path in paths {
			let Ok(text) = tokio::fs::read_to_string(&path).await else {
				continue;
			};
			let Ok(token) = serde_json::from_str::<SsoToken>(&text) else {
				continue;
			};
			let is_preferred = path
				.file_name()
				.is_some_and(|name| name == preferred.as_str());
			if token.start_url.as_deref() == Some(start_url)
				|| (session_name.is_some() && is_preferred)
			{
				return Ok(Some(token));
			}
		}
		Ok(None)
	}

	async fn credential_process(
		&self,
		command: &str,
	) -> Result<ResolvedCredential, AwsCredentialError> {
		let argv = tokenize_credential_process(command)?;
		let Some(executable) = argv.first() else {
			return Err(AwsCredentialError::InvalidProcessCommand);
		};
		let executable_name = executable.to_ascii_lowercase();
		let mut child = if cfg!(windows)
			&& (executable_name.ends_with(".cmd") || executable_name.ends_with(".bat"))
		{
			let mut child = Command::new("cmd.exe");
			child.args(["/d", "/s", "/c", command]);
			child
		} else {
			let mut child = Command::new(executable.as_str());
			child.args(argv[1..].iter().map(Str::as_str));
			child
		};
		child
			.stdin(Stdio::null())
			.stdout(Stdio::piped())
			.stderr(Stdio::null())
			.kill_on_drop(true);
		let output = child
			.output()
			.await
			.map_err(|source| AwsCredentialError::ProcessIo { source: Arc::new(source) })?;
		if !output.status.success() {
			return Err(AwsCredentialError::ProcessStatus {
				status: output.status.code().unwrap_or(-1),
			});
		}
		let envelope: ProcessEnvelope = serde_json::from_slice(&output.stdout)
			.map_err(|source| AwsCredentialError::ProcessEnvelope { source: Arc::new(source) })?;
		if envelope.version != Some(1) {
			return Err(AwsCredentialError::ProcessVersion);
		}
		let (Some(access_key_id), Some(secret_access_key)) =
			(envelope.access_key_id, envelope.secret_access_key)
		else {
			return Err(AwsCredentialError::MissingCredentialFields {
				operation: AwsCredentialOperation::CredentialProcess,
			});
		};
		if access_key_id.is_empty() || secret_access_key.is_empty() {
			return Err(AwsCredentialError::MissingCredentialFields {
				operation: AwsCredentialOperation::CredentialProcess,
			});
		}
		let session_token = envelope.session_token.filter(|token| !token.is_empty());
		let expires_at = if envelope.expiration.is_some() || session_token.is_some() {
			Some(
				envelope
					.expiration
					.as_deref()
					.and_then(parse_rfc3339)
					.unwrap_or_else(SystemTime::now),
			)
		} else {
			None
		};
		Ok(ResolvedCredential {
			access_key_id: SecretString::from(access_key_id),
			secret_access_key: SecretString::from(secret_access_key),
			session_token: session_token.map(SecretString::from),
			expires_at,
		})
	}

	async fn container_credentials(&self) -> Result<Option<ResolvedCredential>, AwsCredentialError> {
		let relative = self.env_text("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI")?;
		let full = self.env_text("AWS_CONTAINER_CREDENTIALS_FULL_URI")?;
		if relative.is_none() && full.is_none() {
			return Ok(None);
		}
		let endpoint = if let Some(relative) = relative {
			if !relative.starts_with('/') || relative.starts_with("//") {
				return Err(AwsCredentialError::InvalidEndpoint {
					operation: AwsCredentialOperation::Container,
				});
			}
			Url::parse(ECS_BASE_URL)
				.and_then(|base| base.join(relative.trim_start_matches('/')))
				.map_err(|source| AwsCredentialError::Url {
					operation: AwsCredentialOperation::Container,
					source,
				})?
		} else {
			let parsed = Url::parse(full.as_deref().unwrap_or_default()).map_err(|source| {
				AwsCredentialError::Url { operation: AwsCredentialOperation::Container, source }
			})?;
			if parsed.scheme() != "https" && !parsed.host_str().is_some_and(is_local_or_metadata_host)
			{
				return Err(AwsCredentialError::InvalidEndpoint {
					operation: AwsCredentialOperation::Container,
				});
			}
			parsed
		};
		let mut authorization = self.env_secret("AWS_CONTAINER_AUTHORIZATION_TOKEN")?;
		if authorization.is_none()
			&& let Some(path) = self.env_text("AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE")?
		{
			let token = tokio::fs::read_to_string(path.as_str())
				.await
				.map_err(|source| AwsCredentialError::Io {
					operation: AwsCredentialOperation::ContainerToken,
					source:    Arc::new(source),
				})?;
			if !token.trim().is_empty() {
				authorization = Some(SecretString::from(token.trim().to_owned()));
			}
		}
		let mut headers = HeaderMap::new();
		if let Some(authorization) = authorization {
			let mut value = HeaderValue::from_str(authorization.expose_secret()).map_err(|_| {
				AwsCredentialError::MissingCredentialFields {
					operation: AwsCredentialOperation::ContainerToken,
				}
			})?;
			value.set_sensitive(true);
			headers.insert(http::header::AUTHORIZATION, value);
		}
		let response = self
			.http(
				AwsCredentialOperation::Container,
				Method::GET,
				endpoint.as_str(),
				headers,
				None,
				None,
			)
			.await?;
		let envelope: ContainerEnvelope = serde_json::from_str(response.body.expose_secret())
			.map_err(|source| AwsCredentialError::Json {
				operation: AwsCredentialOperation::Container,
				source:    Arc::new(source),
			})?;
		let ContainerEnvelope { access_key_id, secret_access_key, token, expiration } = envelope;
		let (Some(access_key_id), Some(secret_access_key), Some(token)) =
			(access_key_id, secret_access_key, token)
		else {
			return Err(AwsCredentialError::MissingCredentialFields {
				operation: AwsCredentialOperation::Container,
			});
		};
		if access_key_id.is_empty() || secret_access_key.is_empty() || token.is_empty() {
			return Err(AwsCredentialError::MissingCredentialFields {
				operation: AwsCredentialOperation::Container,
			});
		}
		let expiration =
			required_expiration(expiration.as_deref(), AwsCredentialOperation::Container)?;
		Ok(Some(ResolvedCredential {
			access_key_id:     SecretString::from(access_key_id),
			secret_access_key: SecretString::from(secret_access_key),
			session_token:     Some(SecretString::from(token)),
			expires_at:        Some(expiration),
		}))
	}

	async fn imds_credentials(&self) -> Result<Option<ResolvedCredential>, AwsCredentialError> {
		let mode = self.env_text("AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE")?;
		let fallback = if mode
			.as_deref()
			.is_some_and(|mode| mode.eq_ignore_ascii_case("ipv6"))
		{
			IMDS_IPV6_BASE_URL
		} else {
			IMDS_IPV4_BASE_URL
		};
		let base = self
			.env_text("AWS_EC2_METADATA_SERVICE_ENDPOINT")?
			.unwrap_or_else(|| Str::new(fallback));
		let mut base = match Url::parse(&base) {
			Ok(base) if matches!(base.scheme(), "http" | "https") && base.host_str().is_some() => base,
			_ => return Ok(None),
		};
		if !base.path().ends_with('/') {
			base.set_path(&format!("{}/", base.path()));
		}
		let token_url = match base.join("latest/api/token") {
			Ok(value) => value,
			Err(_) => return Ok(None),
		};
		let mut headers = HeaderMap::new();
		headers.insert("x-aws-ec2-metadata-token-ttl-seconds", HeaderValue::from_static("21600"));
		let token = match self
			.http(
				AwsCredentialOperation::Imds,
				Method::PUT,
				token_url.as_str(),
				headers,
				None,
				Some(AWS_IMDS_REQUEST_TIMEOUT),
			)
			.await
		{
			Ok(response) => response.body,
			Err(_) => return Ok(None),
		};
		let mut headers = HeaderMap::new();
		let Ok(mut token_header) = HeaderValue::from_str(token.expose_secret()) else {
			return Ok(None);
		};
		token_header.set_sensitive(true);
		headers.insert("x-aws-ec2-metadata-token", token_header.clone());
		let role_url = match base.join("latest/meta-data/iam/security-credentials/") {
			Ok(value) => value,
			Err(_) => return Ok(None),
		};
		let role = match self
			.http(
				AwsCredentialOperation::Imds,
				Method::GET,
				role_url.as_str(),
				headers.clone(),
				None,
				Some(AWS_IMDS_REQUEST_TIMEOUT),
			)
			.await
		{
			Ok(response) => Str::new(response.body.expose_secret().trim()),
			Err(_) => return Ok(None),
		};
		if role.is_empty() {
			return Ok(None);
		}
		let credentials_url = match base.join(&format!(
			"latest/meta-data/iam/security-credentials/{}",
			url::form_urlencoded::byte_serialize(role.as_bytes()).collect::<String>()
		)) {
			Ok(value) => value,
			Err(_) => return Ok(None),
		};
		let response = match self
			.http(
				AwsCredentialOperation::Imds,
				Method::GET,
				credentials_url.as_str(),
				headers,
				None,
				Some(AWS_IMDS_REQUEST_TIMEOUT),
			)
			.await
		{
			Ok(response) => response,
			Err(_) => return Ok(None),
		};
		let Ok(envelope) = serde_json::from_str::<ContainerEnvelope>(response.body.expose_secret())
		else {
			return Ok(None);
		};
		let (Some(access_key_id), Some(secret_access_key), Some(token), Some(expiration)) = (
			envelope.access_key_id,
			envelope.secret_access_key,
			envelope.token,
			envelope.expiration.as_deref().and_then(parse_rfc3339),
		) else {
			return Ok(None);
		};
		Ok(Some(ResolvedCredential {
			access_key_id:     SecretString::from(access_key_id),
			secret_access_key: SecretString::from(secret_access_key),
			session_token:     Some(SecretString::from(token)),
			expires_at:        Some(expiration),
		}))
	}

	async fn http(
		&self,
		operation: AwsCredentialOperation,
		method: Method,
		url: &str,
		headers: HeaderMap,
		body: Option<SecretString>,
		deadline: Option<Duration>,
	) -> Result<super::OAuthHttpResponse, AwsCredentialError> {
		let cancellation = CancellationToken::new();
		let request = OAuthHttpRequest::new(method, url, headers, body)
			.map_err(|source| AwsCredentialError::Request { operation, source })?
			.with_cancellation(cancellation.clone());
		let exchange = self.http.execute(request);
		let response = if let Some(deadline) = deadline {
			if let Ok(result) = time::timeout(deadline, exchange).await {
				result
			} else {
				cancellation.cancel();
				return Err(AwsCredentialError::Transport { operation, source: OAuthTransportError });
			}
		} else {
			exchange.await
		}
		.map_err(|source| AwsCredentialError::Transport { operation, source })?;
		if !(200..300).contains(&response.status) {
			return Err(AwsCredentialError::Http { operation, status: response.status });
		}
		Ok(response)
	}
}

fn profile_has_credential_source(
	profile: &str,
	credentials: Option<&AwsIni>,
	config: Option<&AwsIni>,
	environment: bool,
	container: bool,
	metadata_enabled: bool,
	mut seen: BTreeSet<Str>,
) -> Result<bool, AwsCredentialError> {
	if !seen.insert(Str::new(profile)) {
		return Err(AwsCredentialError::ProfileCycle { profile: Str::new(profile) });
	}
	let mut merged = config
		.and_then(|ini| ini.get(profile))
		.cloned()
		.unwrap_or_default();
	if let Some(values) = credentials.and_then(|ini| ini.get(profile)) {
		merged.extend(values.clone());
	}
	if let Some(_role_arn) = merged.get("role_arn").filter(|value| !value.is_empty()) {
		if merged
			.get("web_identity_token_file")
			.is_some_and(|value| !value.is_empty())
		{
			return Ok(true);
		}
		if merged
			.get("mfa_serial")
			.is_some_and(|value| !value.is_empty())
		{
			return Ok(false);
		}
		if let Some(source) = merged
			.get("credential_source")
			.filter(|value| !value.is_empty())
		{
			return match source.as_str() {
				"Environment" => Ok(environment),
				"EcsContainer" => Ok(container),
				"Ec2InstanceMetadata" => Ok(metadata_enabled),
				_ => {
					Err(AwsCredentialError::UnsupportedCredentialSource { profile: Str::new(profile) })
				},
			};
		}
		if let Some(source_profile) = merged
			.get("source_profile")
			.filter(|value| !value.is_empty())
		{
			return profile_has_credential_source(
				source_profile,
				credentials,
				config,
				environment,
				container,
				metadata_enabled,
				seen,
			);
		}
		return Ok(false);
	}
	if merged
		.get("aws_access_key_id")
		.is_some_and(|value| !value.is_empty())
		&& merged
			.get("aws_secret_access_key")
			.is_some_and(|value| !value.is_empty())
	{
		return Ok(true);
	}
	if merged
		.get("credential_process")
		.is_some_and(|value| !value.is_empty())
	{
		return Ok(true);
	}
	if merged
		.get("sso_account_id")
		.is_none_or(|value| value.is_empty())
		|| merged
			.get("sso_role_name")
			.is_none_or(|value| value.is_empty())
	{
		return Ok(false);
	}
	if merged
		.get("sso_start_url")
		.is_some_and(|value| !value.is_empty())
		&& merged
			.get("sso_region")
			.is_some_and(|value| !value.is_empty())
	{
		return Ok(true);
	}
	let Some(session) = merged
		.get("sso_session")
		.filter(|value| !value.is_empty())
		.and_then(|name| config.and_then(|ini| ini.get(&sf!("sso-session:{name}"))))
	else {
		return Ok(false);
	};
	Ok(session
		.get("sso_start_url")
		.is_some_and(|value| !value.is_empty())
		&& session
			.get("sso_region")
			.is_some_and(|value| !value.is_empty()))
}

fn is_ec2_host() -> bool {
	const CHECKS: [(&str, fn(&str) -> bool); 5] = [
		("/sys/hypervisor/uuid", |value| value.starts_with("ec2")),
		("/sys/devices/virtual/dmi/id/product_uuid", |value| value.starts_with("ec2")),
		("/sys/devices/virtual/dmi/id/board_asset_tag", |value| {
			value.starts_with("ec2") || value.starts_with("i-")
		}),
		("/sys/devices/virtual/dmi/id/sys_vendor", |value| value.contains("amazon ec2")),
		("/sys/devices/virtual/dmi/id/bios_vendor", |value| value.contains("amazon ec2")),
	];
	CHECKS.iter().any(|(path, matches)| {
		fs::read_to_string(path)
			.is_ok_and(|value| matches(value.trim().to_ascii_lowercase().as_str()))
	})
}

impl fmt::Debug for AwsCredentialSource {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("AwsCredentialSource")
			.field("options", &self.options)
			.field("cache_scopes", &self.state.lock().cache.len())
			.finish_non_exhaustive()
	}
}

impl CredentialSource for AwsCredentialSource {
	fn lease(
		&self,
		need: CredentialNeed,
	) -> CredentialFuture<'_, Result<CredentialLease, CredentialError>> {
		futures::future::Either::Right(
			async move {
				self
					.resolve_for_need(&need, false)
					.await
					.map_err(|error| error.credential_error())
			}
			.boxed(),
		)
	}

	fn refresh_lease(
		&self,
		need: CredentialNeed,
	) -> CredentialFuture<'_, Result<CredentialLease, CredentialError>> {
		futures::future::Either::Right(
			async move {
				self
					.resolve_for_need(&need, true)
					.await
					.map_err(|error| error.credential_error())
			}
			.boxed(),
		)
	}

	fn reject<'a>(
		&'a self,
		_lease: &'a CredentialLease,
		_evidence: AuthRejection,
	) -> CredentialFuture<'a, Result<(), CredentialError>> {
		futures::future::Either::Right(
			async move {
				self
					.invalidate(self.options.clone())
					.await
					.map_err(|error| error.credential_error())
			}
			.boxed(),
		)
	}
}

/// Parsed AWS shared configuration keyed by normalized section name.
pub type AwsIni = BTreeMap<Str, BTreeMap<Str, Str>>;

struct ProfileContext<'a> {
	credentials: &'a Option<AwsIni>,
	config:      &'a Option<AwsIni>,
	region:      &'a str,
}

async fn read_ini_file(
	path: &Path,
	operation: AwsCredentialOperation,
) -> Result<Option<AwsIni>, AwsCredentialError> {
	match tokio::fs::read_to_string(path).await {
		Ok(text) => Ok(Some(parse_aws_ini(&text))),
		Err(source) if source.kind() == io::ErrorKind::NotFound => Ok(None),
		Err(source) => Err(AwsCredentialError::Io { operation, source: Arc::new(source) }),
	}
}

/// Parses AWS shared credentials/config INI sections, including normalized
/// `profile` and `sso-session` section names.
pub fn parse_aws_ini(text: &str) -> AwsIni {
	let mut output = BTreeMap::new();
	let mut current: Option<Str> = None;
	for raw in text.lines() {
		let line = raw.trim();
		if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
			continue;
		}
		if let Some(section) = line
			.strip_prefix('[')
			.and_then(|line| line.strip_suffix(']'))
		{
			let section = section.trim();
			let normalized = if let Some(profile) = section.strip_prefix("profile ") {
				Str::new(profile.trim())
			} else if let Some(session) = section.strip_prefix("sso-session ") {
				Str::new(format!("sso-session:{}", session.trim()))
			} else {
				Str::new(section)
			};
			output
				.entry(normalized.clone())
				.or_insert_with(BTreeMap::new);
			current = Some(normalized);
			continue;
		}
		let Some(section) = &current else {
			continue;
		};
		let Some((key, value)) = line.split_once('=') else {
			continue;
		};
		output
			.entry(section.clone())
			.or_default()
			.insert(Str::new(key.trim()), Str::new(value.trim()));
	}
	output
}

/// Tokenizes an AWS `credential_process` command without invoking a shell.
pub fn tokenize_credential_process(command: &str) -> Result<Vec<Str>, AwsCredentialError> {
	#[derive(Clone, Copy, Eq, PartialEq)]
	enum Mode {
		Normal,
		Single,
		Double,
	}
	let mut tokens = Vec::new();
	let mut current = String::new();
	let mut has_token = false;
	let mut mode = Mode::Normal;
	let mut chars = command.chars().peekable();
	while let Some(character) = chars.next() {
		match mode {
			Mode::Normal => match character {
				'\'' => {
					mode = Mode::Single;
					has_token = true;
				},
				'"' => {
					mode = Mode::Double;
					has_token = true;
				},
				'\\' => {
					let Some(next) = chars.next() else {
						current.push('\\');
						has_token = true;
						break;
					};
					current.push(next);
					has_token = true;
				},
				value if value.is_ascii_whitespace() => {
					if has_token {
						tokens.push(Str::new(std::mem::take(&mut current)));
						has_token = false;
					}
				},
				value => {
					current.push(value);
					has_token = true;
				},
			},
			Mode::Single => {
				if character == '\'' {
					mode = Mode::Normal;
				} else {
					current.push(character);
				}
			},
			Mode::Double => {
				if character == '"' {
					mode = Mode::Normal;
				} else if character == '\\' {
					if chars
						.peek()
						.is_some_and(|next| matches!(next, '$' | '`' | '"' | '\\'))
					{
						current.push(chars.next().expect("peeked character"));
					} else {
						current.push(character);
					}
				} else {
					current.push(character);
				}
			},
		}
	}
	if mode != Mode::Normal {
		return Err(AwsCredentialError::InvalidProcessCommand);
	}
	if has_token {
		tokens.push(Str::new(current));
	}
	Ok(tokens)
}

fn home_directory(
	environment: &dyn AwsCredentialEnvironment,
) -> Result<Option<PathBuf>, AwsCredentialError> {
	for name in ["HOME", "USERPROFILE"] {
		if let Some(value) = environment
			.read(name)?
			.filter(|value| !value.expose_secret().is_empty())
		{
			return Ok(Some(PathBuf::from(value.expose_secret())));
		}
	}
	Ok(None)
}

fn form(fields: &[(&str, &str)]) -> String {
	let mut serializer = url::form_urlencoded::Serializer::new(String::new());
	for (name, value) in fields {
		serializer.append_pair(name, value);
	}
	serializer.finish()
}

fn form_headers() -> HeaderMap {
	let mut headers = HeaderMap::new();
	headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/x-www-form-urlencoded"));
	headers
}

fn sts_endpoint(region: &str) -> String {
	let suffix = if region.starts_with("cn-") {
		"amazonaws.com.cn"
	} else {
		"amazonaws.com"
	};
	format!("https://sts.{region}.{suffix}/")
}

fn parse_sts_credentials(
	xml: &str,
	operation: AwsCredentialOperation,
) -> Result<ResolvedCredential, AwsCredentialError> {
	let (Some(access_key_id), Some(secret_access_key), Some(session_token)) =
		(xml_tag(xml, "AccessKeyId"), xml_tag(xml, "SecretAccessKey"), xml_tag(xml, "SessionToken"))
	else {
		return Err(AwsCredentialError::MissingCredentialFields { operation });
	};
	let expiration = required_expiration(xml_tag(xml, "Expiration").as_deref(), operation)?;
	Ok(ResolvedCredential {
		access_key_id:     SecretString::from(access_key_id),
		secret_access_key: SecretString::from(secret_access_key),
		session_token:     Some(SecretString::from(session_token)),
		expires_at:        Some(expiration),
	})
}

fn required_expiration(
	value: Option<&str>,
	operation: AwsCredentialOperation,
) -> Result<SystemTime, AwsCredentialError> {
	value
		.and_then(parse_rfc3339)
		.ok_or(AwsCredentialError::InvalidExpiration { operation })
}

fn xml_tag(xml: &str, tag: &str) -> Option<String> {
	let open = format!("<{tag}>");
	let close = format!("</{tag}>");
	let value = xml.split_once(&open)?.1.split_once(&close)?.0;
	if value.is_empty() {
		return None;
	}
	Some(
		value
			.replace("&amp;", "&")
			.replace("&lt;", "<")
			.replace("&gt;", ">")
			.replace("&quot;", "\"")
			.replace("&apos;", "'"),
	)
}

fn is_local_or_metadata_host(host: &str) -> bool {
	let host = host.trim_matches(['[', ']']).to_ascii_lowercase();
	if host == "localhost" || host.ends_with(".localhost") || host == "metadata.google.internal" {
		return true;
	}
	if let Ok(address) = host.parse::<std::net::IpAddr>() {
		return match address {
			std::net::IpAddr::V4(address) => {
				address.is_loopback()
					|| address.is_unspecified()
					|| address.is_private()
					|| address.is_link_local()
			},
			std::net::IpAddr::V6(address) => {
				address.is_loopback()
					|| address.is_unspecified()
					|| ((address.segments()[0] & 0xfe00) == 0xfc00)
					|| ((address.segments()[0] & 0xffc0) == 0xfe80)
			},
		};
	}
	false
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct ProcessEnvelope {
	version:           Option<u8>,
	access_key_id:     Option<String>,
	secret_access_key: Option<String>,
	session_token:     Option<String>,
	expiration:        Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct ContainerEnvelope {
	access_key_id:     Option<String>,
	secret_access_key: Option<String>,
	token:             Option<String>,
	expiration:        Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SsoToken {
	access_token: Option<String>,
	expires_at:   Option<String>,
	start_url:    Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SsoRoleEnvelope {
	role_credentials: Option<SsoRoleCredentials>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SsoRoleCredentials {
	access_key_id:     String,
	secret_access_key: String,
	session_token:     String,
	expiration:        u64,
}

#[cfg(test)]
mod tests {
	use std::{
		collections::{BTreeMap, VecDeque},
		sync::{
			Arc,
			atomic::{AtomicUsize, Ordering},
		},
		time::{Duration, SystemTime},
	};

	use futures::{FutureExt as _, future::BoxFuture};
	use http::HeaderMap;
	use omp_catalog::AuthSpecId;
	use omp_core::{SecretString, Str, sf};
	use parking_lot::Mutex;

	use super::{
		AWS_FILE_SESSION_CREDENTIAL_TTL, AwsCredentialEnvironment, AwsCredentialError,
		AwsCredentialOptions, AwsCredentialSource, AwsEnvironmentError, parse_aws_ini,
		tokenize_credential_process,
	};
	use crate::auth::{
		CredentialKind, CredentialNeed, OAuthHttpClient, OAuthHttpRequest, OAuthHttpResponse,
		OAuthTransportError,
	};

	#[derive(Default)]
	struct FakeEnvironment {
		values: BTreeMap<&'static str, SecretString>,
	}

	impl FakeEnvironment {
		fn with(mut self, name: &'static str, value: impl Into<String>) -> Self {
			self.values.insert(name, SecretString::from(value.into()));
			self
		}
	}

	impl AwsCredentialEnvironment for FakeEnvironment {
		fn read(&self, name: &'static str) -> Result<Option<SecretString>, AwsEnvironmentError> {
			Ok(self.values.get(name).cloned())
		}
	}

	struct ScriptedHttp {
		calls:     AtomicUsize,
		responses: Mutex<VecDeque<(u16, &'static str)>>,
		urls:      Mutex<Vec<Str>>,
	}

	impl ScriptedHttp {
		fn new(responses: impl IntoIterator<Item = (u16, &'static str)>) -> Self {
			Self {
				calls:     AtomicUsize::new(0),
				responses: Mutex::new(responses.into_iter().collect()),
				urls:      Mutex::new(Vec::new()),
			}
		}
	}

	impl OAuthHttpClient for ScriptedHttp {
		fn execute(
			&self,
			request: OAuthHttpRequest,
		) -> BoxFuture<'_, Result<OAuthHttpResponse, OAuthTransportError>> {
			let (_, url, ..) = request.into_parts();
			self.calls.fetch_add(1, Ordering::Relaxed);
			self.urls.lock().push(Str::new(url.as_str()));
			let response = self.responses.lock().pop_front();
			async move {
				let (status, body) = response.ok_or(OAuthTransportError)?;
				Ok(OAuthHttpResponse {
					status,
					headers: HeaderMap::new(),
					body: SecretString::from(body),
				})
			}
			.boxed()
		}
	}

	fn need() -> CredentialNeed {
		CredentialNeed {
			spec:        AuthSpecId::from("amazon-bedrock"),
			account:     None,
			principal:   None,
			valid_after: SystemTime::UNIX_EPOCH,
		}
	}

	fn sts_xml(expiration: &'static str) -> &'static str {
		match expiration {
			"future" => {
				"<Credentials><AccessKeyId>AKIAWEB</AccessKeyId><SecretAccessKey>secret</\
				 SecretAccessKey><SessionToken>token</SessionToken><Expiration>2099-01-01T00:00:00Z</\
				 Expiration></Credentials>"
			},
			"expired" => {
				"<Credentials><AccessKeyId>AKIAWEB</AccessKeyId><SecretAccessKey>secret</\
				 SecretAccessKey><SessionToken>token</SessionToken><Expiration>2020-01-01T00:00:00Z</\
				 Expiration></Credentials>"
			},
			_ => unreachable!("closed test fixture"),
		}
	}

	fn web_environment(token_path: &str) -> FakeEnvironment {
		FakeEnvironment::default()
			.with("AWS_WEB_IDENTITY_TOKEN_FILE", token_path)
			.with("AWS_ROLE_ARN", "arn:aws:iam::123456789012:role/test")
	}

	#[test]
	fn ini_normalizes_profile_and_sso_session_sections() {
		let ini = parse_aws_ini(
			"[profile work]\nregion = eu-west-1\n[sso-session corp]\nsso_region=us-east-2\n",
		);
		assert_eq!(ini["work"]["region"], "eu-west-1");
		assert_eq!(ini["sso-session:corp"]["sso_region"], "us-east-2");
	}

	#[test]
	fn process_tokenizer_preserves_quoted_windows_paths_and_empty_arguments() {
		let argv =
			tokenize_credential_process(r#""C:\Program Files\auth.exe" --profile 'team one' """#)
				.expect("valid command");
		assert_eq!(argv.iter().map(Str::as_str).collect::<Vec<_>>(), [
			"C:\\Program Files\\auth.exe",
			"--profile",
			"team one",
			""
		]);
	}

	#[test]
	fn process_tokenizer_rejects_unterminated_quotes() {
		assert!(tokenize_credential_process("auth 'broken").is_err());
	}

	#[test]
	fn process_tokenizer_accepts_empty_input_as_an_empty_argv() {
		assert!(
			tokenize_credential_process("  \t ")
				.expect("empty command is valid token input")
				.is_empty()
		);
	}

	#[tokio::test]
	async fn environment_precedes_every_network_credential_source() {
		let directory = tempfile::tempdir().expect("temporary directory");
		let token_path = directory.path().join("token");
		std::fs::write(&token_path, "identity-token").expect("write token");
		let environment = web_environment(token_path.to_str().expect("utf-8 path"))
			.with("AWS_ACCESS_KEY_ID", "AKIAENV")
			.with("AWS_SECRET_ACCESS_KEY", "environment-secret");
		let http = Arc::new(ScriptedHttp::new([(403, "must not be observed")]));
		let resolver = AwsCredentialSource::new(
			AwsCredentialOptions::default(),
			Arc::new(environment),
			http.clone(),
		);

		let lease = resolver.resolve(&need()).await.expect("environment lease");

		assert_eq!(lease.kind(), CredentialKind::AwsSigV4);
		assert_eq!(http.calls.load(Ordering::Relaxed), 0);
		assert!(lease.meta().expires_at.is_none());
	}

	#[tokio::test]
	async fn concurrent_web_identity_resolution_is_single_flight_and_cached() {
		let directory = tempfile::tempdir().expect("temporary directory");
		let token_path = directory.path().join("token");
		std::fs::write(&token_path, "identity-token").expect("write token");
		let http = Arc::new(ScriptedHttp::new([(200, sts_xml("future"))]));
		let resolver = AwsCredentialSource::new(
			AwsCredentialOptions::default(),
			Arc::new(web_environment(token_path.to_str().expect("utf-8 path"))),
			http.clone(),
		);
		let request = need();

		let (left, right) = tokio::join!(resolver.resolve(&request), resolver.resolve(&request));
		let left = left.expect("left waiter");
		let right = right.expect("right waiter");
		let cached = resolver.resolve(&request).await.expect("cached lease");

		assert_eq!(http.calls.load(Ordering::Relaxed), 1);
		assert_eq!(left.meta().generation, right.meta().generation);
		assert_eq!(left.meta().generation, cached.meta().generation);
	}

	#[tokio::test]
	async fn refresh_skew_does_not_cache_expired_dynamic_credentials() {
		let directory = tempfile::tempdir().expect("temporary directory");
		let token_path = directory.path().join("token");
		std::fs::write(&token_path, "identity-token").expect("write token");
		let http =
			Arc::new(ScriptedHttp::new([(200, sts_xml("expired")), (200, sts_xml("expired"))]));
		let resolver = AwsCredentialSource::new(
			AwsCredentialOptions::default(),
			Arc::new(web_environment(token_path.to_str().expect("utf-8 path"))),
			http.clone(),
		);

		let first = resolver.resolve(&need()).await.expect("first exchange");
		let second = resolver.resolve(&need()).await.expect("second exchange");

		assert_eq!(http.calls.load(Ordering::Relaxed), 2);
		assert_ne!(first.meta().generation, second.meta().generation);
	}

	#[tokio::test]
	async fn profile_session_credentials_receive_a_five_minute_cache_ttl() {
		let directory = tempfile::tempdir().expect("temporary directory");
		let aws = directory.path().join(".aws");
		std::fs::create_dir(&aws).expect("create AWS directory");
		std::fs::write(
			aws.join("credentials"),
			concat!(
				"[default]\n",
				"aws_access_key_id = AKIAPROFILE\n",
				"aws_secret_access_key = profile-secret\n",
				"aws_session_token = profile-token\n",
			),
		)
		.expect("write credentials");
		let environment =
			FakeEnvironment::default().with("HOME", directory.path().to_str().expect("utf-8 path"));
		let http = Arc::new(ScriptedHttp::new([]));
		let resolver = AwsCredentialSource::new(
			AwsCredentialOptions::default(),
			Arc::new(environment),
			http.clone(),
		);
		let before = SystemTime::now();

		let lease = resolver.resolve(&need()).await.expect("profile lease");
		let after = SystemTime::now();
		let expiration = lease.meta().expires_at.expect("session TTL");

		assert_eq!(http.calls.load(Ordering::Relaxed), 0);
		assert_eq!(AWS_FILE_SESSION_CREDENTIAL_TTL, Duration::from_secs(5 * 60));
		assert!(expiration >= before + AWS_FILE_SESSION_CREDENTIAL_TTL);
		assert!(expiration <= after + AWS_FILE_SESSION_CREDENTIAL_TTL);
	}

	#[tokio::test]
	async fn effective_region_uses_the_credential_chain_precedence() {
		let resolver = AwsCredentialSource::new(
			AwsCredentialOptions {
				profile: Some(Str::new("team")),
				region:  Some(Str::new("eu-west-2")),
			},
			Arc::new(FakeEnvironment::default().with("AWS_REGION", "us-east-2")),
			Arc::new(ScriptedHttp::new([])),
		);

		assert_eq!(resolver.effective_region().await.expect("explicit region"), sf!("eu-west-2"),);
	}

	#[tokio::tes]
	async fn registry_availability_classifies_every_ambient_source_without_network() {
		let environment = FakeEnvironment::default()
			.with("AWS_ACCESS_KEY_ID", "AKIAENV")
			.with("AWS_SECRET_ACCESS_KEY", "environment-secret")
			.with("AWS_WEB_IDENTITY_TOKEN_FILE", "/run/secrets/aws-token")
			.with("AWS_ROLE_ARN", "arn:aws:iam::123456789012:role/test")
			.with("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "/v2/credentials")
			.with("AWS_EC2_METADATA_SERVICE_ENDPOINT", "http://127.0.0.1:1338")
			.with("AWS_REGION", "eu-central-1")
			.with("OMP_AWS_BEARER_TOKEN_BEDROCK", "TOP-SECRET-BEARER");
		let resolver = AwsCredentialSource::new(
			AwsCredentialOptions::default(),
			Arc::new(environment),
			Arc::new(ScriptedHttp::new([])),
		);

		let availability = resolver
			.registry_availability()
			.await
			.expect("local discovery");

		assert_eq!(availability.region(), "eu-central-1");
		assert!(availability.has_bearer());
		assert!(availability.has_environment_credentials());
		assert!(availability.has_web_identity());
		assert!(availability.has_container_credentials());
		assert!(availability.has_imds());
		assert!(availability.bedrock_eligible());
		assert!(availability.mantle_eligible());
		assert!(!format!("{availability:?}").contains("TOP-SECRET"));
	}

	#[tokio::test]
	async fn registry_availability_rejects_partial_pairs_and_disabled_imds() {
		let resolver = AwsCredentialSource::new(
			AwsCredentialOptions::default(),
			Arc::new(
				FakeEnvironment::default()
					.with("AWS_ACCESS_KEY_ID", "missing-secret")
					.with("AWS_WEB_IDENTITY_TOKEN_FILE", "/run/secrets/missing-role")
					.with("AWS_EC2_METADATA_SERVICE_ENDPOINT", "http://127.0.0.1:1338")
					.with("AWS_EC2_METADATA_DISABLED", "TRUE"),
			),
			Arc::new(ScriptedHttp::new([])),
		);

		let availability = resolver
			.registry_availability()
			.await
			.expect("local discovery");

		assert!(!availability.has_environment_credentials());
		assert!(!availability.has_web_identity());
		assert!(!availability.has_imds());
		assert!(!availability.has_sigv4_source());
		assert!(!availability.bedrock_eligible());
		assert!(!availability.mantle_eligible());
	}

	#[tokio::test]
	async fn registry_profile_discovery_is_cached_and_exactly_invalidated() {
		let directory = tempfile::tempdir().expect("temporary directory");
		let aws = directory.path().join(".aws");
		std::fs::create_dir(&aws).expect("create AWS directory");
		let credentials = aws.join("credentials");
		std::fs::write(
			&credentials,
			concat!(
				"[base]\n",
				"aws_access_key_id = AKIAPROFILE\n",
				"aws_secret_access_key = profile-secret\n",
			),
		)
		.expect("write credentials");
		std::fs::write(
			aws.join("config"),
			concat!(
				"[profile team]\n",
				"region = eu-west-2\n",
				"role_arn = arn:aws:iam::123456789012:role/team\n",
				"source_profile = base\n",
			),
		)
		.expect("write config");
		let options = AwsCredentialOptions { profile: Some(sf!("team")), region: None };
		let resolver = AwsCredentialSource::new(
			options.clone(),
			Arc::new(
				FakeEnvironment::default().with("HOME", directory.path().to_str().expect("utf-8 path")),
			),
			Arc::new(ScriptedHttp::new([])),
		);
		let mut other_region = resolver.clone();
		other_region.options.region = Some(sf!("us-west-2"));

		let initial = resolver
			.registry_availability()
			.await
			.expect("initial discovery");
		let other_initial = other_region
			.registry_availability()
			.await
			.expect("other-region discovery");
		assert_eq!(initial.profile(), "team");
		assert_eq!(initial.region(), "eu-west-2");
		assert!(initial.has_shared_profile());
		assert_eq!(other_initial.region(), "us-west-2");
		assert!(other_initial.has_shared_profile());

		std::fs::write(&credentials, "[base]\n").expect("remove profile credentials");
		assert!(
			resolver
				.registry_availability()
				.await
				.expect("cached discovery")
				.has_shared_profile()
		);

		resolver
			.invalidate(options)
			.await
			.expect("invalidate exact scope");
		assert!(
			!resolver
				.registry_availability()
				.await
				.expect("refreshed discovery")
				.has_shared_profile()
		);
		assert!(
			other_region
				.registry_availability()
				.await
				.expect("other scope remains cached")
				.has_shared_profile()
		);
	}

	#[tokio::test]
	async fn cache_is_scoped_by_effective_region() {
		let directory = tempfile::tempdir().expect("temporary directory");
		let token_path = directory.path().join("token");
		std::fs::write(&token_path, "identity-token").expect("write token");
		let http = Arc::new(ScriptedHttp::new([(200, sts_xml("future")), (200, sts_xml("future"))]));
		let east = AwsCredentialSource::new(
			AwsCredentialOptions {
				profile: Some(Str::new("team")),
				region:  Some(Str::new("us-east-1")),
			},
			Arc::new(web_environment(token_path.to_str().expect("utf-8 path"))),
			http.clone(),
		);
		let mut west = east.clone();
		west.options.region = Some(Str::new("eu-west-1"));

		let east_first = east.resolve(&need()).await.expect("east");
		let west = west.resolve(&need()).await.expect("west");
		let east_cached = east.resolve(&need()).await.expect("east cached");

		assert_eq!(http.calls.load(Ordering::Relaxed), 2);
		assert_ne!(east_first.meta().generation, west.meta().generation);
		assert_eq!(east_first.meta().generation, east_cached.meta().generation);
		assert!(http.urls.lock()[0].contains("sts.us-east-1."));
		assert!(http.urls.lock()[1].contains("sts.eu-west-1."));
	}

	#[tokio::test]
	async fn provider_error_text_never_contains_response_body() {
		let directory = tempfile::tempdir().expect("temporary directory");
		let token_path = directory.path().join("token");
		std::fs::write(&token_path, "identity-token").expect("write token");
		let http = Arc::new(ScriptedHttp::new([(403, "TOP-SECRET-PROVIDER-BODY")]));
		let resolver = AwsCredentialSource::new(
			AwsCredentialOptions::default(),
			Arc::new(web_environment(token_path.to_str().expect("utf-8 path"))),
			http,
		);

		let error = resolver
			.resolve(&need())
			.await
			.expect_err("rejected exchange");

		assert!(matches!(&error, AwsCredentialError::Http { status: 403, .. }));
		assert!(!error.to_string().contains("TOP-SECRET"));
		assert!(!format!("{error:?}").contains("TOP-SECRET"));
	}
}
