//! Catalog-ordered application-default credential resolution.

use std::{
	env, fmt, fs, io, mem,
	path::{Path, PathBuf},
	time::{Duration, SystemTime, UNIX_EPOCH},
};

use http::{HeaderMap, HeaderName, HeaderValue, Method};
use omp_core::{ExposeSecret, SecretString, Str, base64, base64_url};
use ring::{
	rand::SystemRandom,
	signature::{RSA_PKCS1_SHA256, RsaKeyPair},
};
use serde::{Deserialize, Serialize};
use url::form_urlencoded;
use zeroize::Zeroizing;

use super::{
	lease::{CredentialLease, LeaseMeta},
	oauth::{OAuthError, OAuthHttpClient, OAuthHttpRequest, OAuthHttpResponse},
	spec::{AdcSourceSpec, AdcSpec, PublicHeader},
};

const JWT_GRANT: &str = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const TOKEN_EXCHANGE_GRANT: &str = "urn:ietf:params:oauth:grant-type:token-exchange";
const ACCESS_TOKEN_TYPE: &str = "urn:ietf:params:oauth:token-type:access_token";

/// Host environment and secret-file boundary used by ADC resolution.
pub trait AdcRuntime: Send + Sync {
	/// Reads an environment value into a zeroizing secret wrapper.
	fn environment(&self, name: &str) -> Result<Option<SecretString>, AdcRuntimeError>;
	/// Reads a bounded UTF-8 credential file into a zeroizing secret wrapper.
	fn read_secret_file(&self, path: &Path) -> Result<SecretString, AdcRuntimeError>;
	/// Expands a catalog `~/` path without selecting a vendor-specific
	/// directory.
	fn expand_home(&self, path: &str) -> Result<PathBuf, AdcRuntimeError>;
}

/// Operating-system ADC runtime.
#[derive(Clone, Copy, Debug, Default)]
pub struct SystemAdcRuntime;

impl AdcRuntime for SystemAdcRuntime {
	fn environment(&self, name: &str) -> Result<Option<SecretString>, AdcRuntimeError> {
		match env::var(name) {
			Ok(value) => Ok(Some(SecretString::from(value))),
			Err(env::VarError::NotPresent) => Ok(None),
			Err(env::VarError::NotUnicode(_)) => Err(AdcRuntimeError::InvalidEnvironment),
		}
	}

	fn read_secret_file(&self, path: &Path) -> Result<SecretString, AdcRuntimeError> {
		match fs::read_to_string(path) {
			Ok(value) => Ok(SecretString::from(value)),
			Err(error) if error.kind() == io::ErrorKind::NotFound => Err(AdcRuntimeError::NotFound),
			Err(_) => Err(AdcRuntimeError::Io),
		}
	}

	fn expand_home(&self, path: &str) -> Result<PathBuf, AdcRuntimeError> {
		let Some(rest) = path.strip_prefix("~/") else {
			return Ok(PathBuf::from(path));
		};
		let home = env::var_os("HOME").ok_or(AdcRuntimeError::NoHome)?;
		Ok(PathBuf::from(home).join(rest))
	}
}

/// Generic, provider-name-free ADC engine.
pub struct AdcEngine<'a, C, R = SystemAdcRuntime> {
	http:    &'a C,
	runtime: &'a R,
}

impl<'a, C> AdcEngine<'a, C, SystemAdcRuntime> {
	/// Constructs an engine over the operating-system source boundary.
	pub const fn system(http: &'a C, runtime: &'a SystemAdcRuntime) -> Self {
		Self { http, runtime }
	}
}

impl<'a, C, R> AdcEngine<'a, C, R>
where
	C: OAuthHttpClient,
	R: AdcRuntime,
{
	/// Constructs an engine over an injectable source boundary.
	pub const fn new(http: &'a C, runtime: &'a R) -> Self {
		Self { http, runtime }
	}

	/// Resolves the first usable source in exact catalog order.
	pub async fn resolve(
		&self,
		spec: &AdcSpec,
		meta: LeaseMeta,
		issued_at: SystemTime,
	) -> Result<AdcResolution, AdcError> {
		spec.validate().map_err(|_| AdcError::InvalidSpec)?;
		for source in &spec.sources {
			match source {
				AdcSourceSpec::EnvironmentAccessToken { variable } => {
					if let Some(token) = self.runtime.environment(variable)? {
						if token.expose_secret().is_empty() {
							return Err(AdcError::EmptyCredential);
						}
						return Ok(AdcResolution {
							lease:         CredentialLease::bearer(meta, token),
							source:        AdcSourceKind::Environment,
							quota_project: None,
						});
					}
				},
				AdcSourceSpec::CredentialFile { path_variable, default_path } => {
					let override_path = match path_variable {
						Some(variable) => self.runtime.environment(variable)?,
						None => None,
					};
					let (path, required) = if let Some(path) = override_path {
						(PathBuf::from(path.expose_secret()), true)
					} else if let Some(path) = default_path {
						(self.runtime.expand_home(path)?, false)
					} else {
						continue;
					};
					let file = match self.runtime.read_secret_file(&path) {
						Ok(file) => file,
						Err(AdcRuntimeError::NotFound) if !required => continue,
						Err(error) => return Err(error.into()),
					};
					return self.resolve_file(spec, meta, issued_at, file).await;
				},
				AdcSourceSpec::Metadata { url, headers } => {
					if let Some(resolution) = self
						.resolve_metadata(meta.clone(), issued_at, url, headers)
						.await?
					{
						return Ok(resolution);
					}
				},
			}
		}
		Err(AdcError::Unavailable)
	}

	async fn resolve_file(
		&self,
		spec: &AdcSpec,
		meta: LeaseMeta,
		issued_at: SystemTime,
		file: SecretString,
	) -> Result<AdcResolution, AdcError> {
		let credential: CredentialFile = serde_json::from_str(file.expose_secret())
			.map_err(|_| AdcError::MalformedCredentialFile)?;
		match &credential {
			CredentialFile::AuthorizedUser {
				client_id,
				client_secret,
				refresh_token,
				token_uri,
				quota_project_id,
			} => {
				let fields = [
					("grant_type", "refresh_token"),
					("client_id", client_id.as_str()),
					("client_secret", client_secret.as_str()),
					("refresh_token", refresh_token.as_str()),
				];
				let request = Self::form_request(token_uri, &fields)?;
				let response = self.execute(request).await?;
				let token = parse_token_response(response)?;
				Ok(AdcResolution {
					lease:         token.into_lease(meta, issued_at),
					source:        AdcSourceKind::AuthorizedUser,
					quota_project: quota_project_id.as_deref().map(Str::new),
				})
			},
			CredentialFile::ServiceAccount {
				client_email,
				private_key,
				token_uri,
				quota_project_id,
			} => {
				let assertion = service_account_assertion(
					client_email,
					private_key,
					token_uri,
					&spec.scopes,
					issued_at,
				)?;
				let fields = [("grant_type", JWT_GRANT), ("assertion", assertion.expose_secret())];
				let request = Self::form_request(token_uri, &fields)?;
				let response = self.execute(request).await?;
				let token = parse_token_response(response)?;
				Ok(AdcResolution {
					lease:         token.into_lease(meta, issued_at),
					source:        AdcSourceKind::ServiceAccount,
					quota_project: quota_project_id.as_deref().map(Str::new),
				})
			},
			CredentialFile::ExternalAccount {
				audience,
				subject_token_type,
				token_url,
				credential_source,
				quota_project_id,
			} => {
				let source_path = self.runtime.expand_home(&credential_source.file)?;
				let subject = self.runtime.read_secret_file(&source_path)?;
				if subject.expose_secret().trim().is_empty() {
					return Err(AdcError::EmptyCredential);
				}
				let requested_token_type = ACCESS_TOKEN_TYPE;
				let fields = [
					("grant_type", TOKEN_EXCHANGE_GRANT),
					("audience", audience.as_str()),
					("requested_token_type", requested_token_type),
					("subject_token_type", subject_token_type.as_str()),
					("subject_token", subject.expose_secret().trim()),
				];
				let request = Self::form_request(token_url, &fields)?;
				let response = self.execute(request).await?;
				let token = parse_token_response(response)?;
				Ok(AdcResolution {
					lease:         token.into_lease(meta, issued_at),
					source:        AdcSourceKind::ExternalAccount,
					quota_project: quota_project_id.as_deref().map(Str::new),
				})
			},
		}
	}

	async fn resolve_metadata(
		&self,
		meta: LeaseMeta,
		issued_at: SystemTime,
		url: &str,
		headers: &[PublicHeader],
	) -> Result<Option<AdcResolution>, AdcError> {
		let mut request_headers = HeaderMap::new();
		for header in headers {
			let name =
				HeaderName::from_bytes(header.name.as_bytes()).map_err(|_| AdcError::InvalidSpec)?;
			let value = HeaderValue::from_str(&header.value).map_err(|_| AdcError::InvalidSpec)?;
			request_headers.insert(name, value);
		}
		let request = OAuthHttpRequest::new(Method::GET, url, request_headers, None)
			.map_err(OAuthError::from)?;
		let response = self.execute(request).await?;
		if response.status == 404 || response.status == 403 {
			return Ok(None);
		}
		let token = parse_token_response(response)?;
		Ok(Some(AdcResolution {
			lease:         token.into_lease(meta, issued_at),
			source:        AdcSourceKind::Metadata,
			quota_project: None,
		}))
	}

	fn form_request(url: &str, fields: &[(&str, &str)]) -> Result<OAuthHttpRequest, AdcError> {
		let mut serializer = form_urlencoded::Serializer::new(String::new());
		for (name, value) in fields {
			serializer.append_pair(name, value);
		}
		Ok(OAuthHttpRequest::secret_form(url, SecretString::from(serializer.finish()))
			.map_err(OAuthError::from)?)
	}

	async fn execute(&self, request: OAuthHttpRequest) -> Result<OAuthHttpResponse, AdcError> {
		self
			.http
			.execute(request)
			.await
			.map_err(|_| AdcError::Transport)
	}
}

/// Non-secret evidence describing the source that resolved an ADC lease.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AdcSourceKind {
	/// Catalog-declared environment access token.
	Environment,
	/// Authorized-user refresh credential file.
	AuthorizedUser,
	/// Service-account signed assertion.
	ServiceAccount,
	/// External-account subject-token exchange.
	ExternalAccount,
	/// Workload metadata endpoint.
	Metadata,
}

/// Resolved ADC lease plus safe billing/source evidence.
pub struct AdcResolution {
	/// Opaque bearer credential lease.
	pub lease:         CredentialLease,
	/// Source selected by catalog order.
	pub source:        AdcSourceKind,
	/// Optional non-secret billing project.
	pub quota_project: Option<Str>,
}

impl fmt::Debug for AdcResolution {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("AdcResolution")
			.field("lease", &self.lease)
			.field("source", &self.source)
			.field("quota_project", &self.quota_project)
			.finish()
	}
}

/// ADC source boundary failure with no path, environment value, or file
/// content.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum AdcRuntimeError {
	/// Optional source file does not exist.
	#[error("application-default credential file was not found")]
	NotFound,
	/// Credential file could not be read.
	#[error("application-default credential file could not be read")]
	Io,
	/// Environment value is not Unicode.
	#[error("application-default environment value is invalid")]
	InvalidEnvironment,
	/// Home-directory expansion is unavailable.
	#[error("application-default home directory is unavailable")]
	NoHome,
}

/// ADC resolution failure with typed, redacted evidence.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum AdcError {
	/// No declared source produced a credential.
	#[error("application-default credentials are unavailable")]
	Unavailable,
	/// Catalog source declaration is invalid.
	#[error("application-default credential specification is invalid")]
	InvalidSpec,
	/// Explicit source contains an empty credential.
	#[error("application-default credential is empty")]
	EmptyCredential,
	/// Credential file is not one of the supported typed formats.
	#[error("application-default credential file is malformed")]
	MalformedCredentialFile,
	/// Token endpoint response is malformed or rejects the grant.
	#[error("application-default token exchange was rejected")]
	TokenExchangeRejected {
		/// HTTP status returned by the token endpoint.
		status: u16,
	},
	/// Credential source I/O failed.
	#[error(transparent)]
	Runtime(#[from] AdcRuntimeError),
	/// Secret-bearing HTTP request could not be constructed.
	#[error("application-default token endpoint is invalid")]
	Request,
	/// HTTP transport failed without retaining source text.
	#[error("application-default credential transport failed")]
	Transport,
	/// Service-account private key or signature is invalid.
	#[error("application-default service-account signing failed")]
	Signing,
	/// Issued-at time cannot be represented.
	#[error("application-default assertion time is invalid")]
	InvalidTime,
}

impl From<OAuthError> for AdcError {
	fn from(_: OAuthError) -> Self {
		Self::Request
	}
}

#[derive(Deserialize)]
#[serde(tag = "type")]
enum CredentialFile {
	#[serde(rename = "authorized_user")]
	AuthorizedUser {
		client_id:        String,
		client_secret:    String,
		refresh_token:    String,
		token_uri:        String,
		quota_project_id: Option<String>,
	},
	#[serde(rename = "service_account")]
	ServiceAccount {
		client_email:     String,
		private_key:      String,
		token_uri:        String,
		quota_project_id: Option<String>,
	},
	#[serde(rename = "external_account")]
	ExternalAccount {
		audience:           String,
		subject_token_type: String,
		token_url:          String,
		credential_source:  ExternalCredentialSource,
		quota_project_id:   Option<String>,
	},
}

impl Drop for CredentialFile {
	fn drop(&mut self) {
		use zeroize::Zeroize;
		match self {
			Self::AuthorizedUser {
				client_id,
				client_secret,
				refresh_token,
				token_uri,
				quota_project_id,
			} => {
				client_id.zeroize();
				client_secret.zeroize();
				refresh_token.zeroize();
				token_uri.zeroize();
				quota_project_id.zeroize();
			},
			Self::ServiceAccount { client_email, private_key, token_uri, quota_project_id } => {
				client_email.zeroize();
				private_key.zeroize();
				token_uri.zeroize();
				quota_project_id.zeroize();
			},
			Self::ExternalAccount {
				audience,
				subject_token_type,
				token_url,
				credential_source,
				quota_project_id,
			} => {
				audience.zeroize();
				subject_token_type.zeroize();
				token_url.zeroize();
				credential_source.file.zeroize();
				quota_project_id.zeroize();
			},
		}
	}
}

#[derive(Deserialize)]
struct ExternalCredentialSource {
	file: String,
}

#[derive(Deserialize)]
struct AdcTokenResponse {
	access_token: Option<String>,
	expires_in:   Option<u64>,
	token_type:   Option<String>,
}

struct AdcToken {
	access_token: SecretString,
	expires_in:   Option<Duration>,
}

impl AdcToken {
	fn into_lease(self, mut meta: LeaseMeta, issued_at: SystemTime) -> CredentialLease {
		if meta.expires_at.is_none() {
			meta.expires_at = self
				.expires_in
				.and_then(|duration| issued_at.checked_add(duration));
		}
		CredentialLease::bearer(meta, self.access_token)
	}
}

fn parse_token_response(response: OAuthHttpResponse) -> Result<AdcToken, AdcError> {
	if !(200..300).contains(&response.status) {
		return Err(AdcError::TokenExchangeRejected { status: response.status });
	}
	let parsed: AdcTokenResponse = serde_json::from_str(response.body.expose_secret())
		.map_err(|_| AdcError::TokenExchangeRejected { status: response.status })?;
	let access_token = parsed
		.access_token
		.filter(|value| !value.is_empty())
		.ok_or(AdcError::TokenExchangeRejected { status: response.status })?;
	if parsed
		.token_type
		.as_deref()
		.is_some_and(|value| !value.eq_ignore_ascii_case("bearer"))
	{
		return Err(AdcError::TokenExchangeRejected { status: response.status });
	}
	Ok(AdcToken {
		access_token: SecretString::from(access_token),
		expires_in:   parsed.expires_in.map(Duration::from_secs),
	})
}

#[derive(Serialize)]
struct JwtClaims<'a> {
	iss:   &'a str,
	scope: String,
	aud:   &'a str,
	iat:   u64,
	exp:   u64,
}

fn service_account_assertion(
	client_email: &str,
	private_key_pem: &str,
	token_uri: &str,
	scopes: &[Str],
	issued_at: SystemTime,
) -> Result<SecretString, AdcError> {
	let iat = issued_at
		.duration_since(UNIX_EPOCH)
		.map_err(|_| AdcError::InvalidTime)?
		.as_secs();
	let exp = iat.checked_add(3_600).ok_or(AdcError::InvalidTime)?;
	let claims = JwtClaims {
		iss: client_email,
		scope: scopes.iter().map(Str::as_str).collect::<Vec<_>>().join(" "),
		aud: token_uri,
		iat,
		exp,
	};
	let header = base64_url::encode_raw(br#"{"alg":"RS256","typ":"JWT"}"#).into_string();
	let claims_json = Zeroizing::new(serde_json::to_vec(&claims).map_err(|_| AdcError::Signing)?);
	let claims = base64_url::encode_raw(&claims_json[..]).into_string();
	let mut signed = Zeroizing::new(String::with_capacity(header.len() + claims.len() + 1));
	signed.push_str(&header);
	signed.push('.');
	signed.push_str(&claims);
	let key_der = decode_private_key(private_key_pem)?;
	let pair = RsaKeyPair::from_pkcs8(&key_der).map_err(|_| AdcError::Signing)?;
	let mut signature = Zeroizing::new(vec![0_u8; pair.public().modulus_len()]);
	pair
		.sign(&RSA_PKCS1_SHA256, &SystemRandom::new(), signed.as_bytes(), &mut signature)
		.map_err(|_| AdcError::Signing)?;
	let encoded_signature = base64_url::encode_raw(&signature[..]).into_string();
	signed.push('.');
	signed.push_str(&encoded_signature);
	Ok(SecretString::from(mem::take(&mut *signed)))
}

fn decode_private_key(pem: &str) -> Result<Zeroizing<Vec<u8>>, AdcError> {
	let mut encoded = Zeroizing::new(String::new());
	for line in pem.lines() {
		if !line.starts_with("-----") {
			encoded.push_str(line.trim());
		}
	}
	if encoded.is_empty() {
		return Err(AdcError::Signing);
	}
	let decoded = base64::decode(encoded.as_bytes())
		.into_vec()
		.map_err(|_| AdcError::Signing)?;
	Ok(Zeroizing::new(decoded))
}

#[cfg(test)]
mod tests {
	use std::collections::HashMap;

	use futures::{FutureExt, future::BoxFuture};
	use parking_lot::Mutex;

	use super::{
		super::{
			oauth::OAuthTransportError as OauthOAuthTransportError,
			spec::HeaderPlacement as SpecHeaderPlacement,
		},
		*,
	};
	use crate::id::{AccountId, PrincipalId};

	#[derive(Default)]
	struct Runtime {
		env:   HashMap<String, String>,
		files: HashMap<PathBuf, String>,
	}

	impl AdcRuntime for Runtime {
		fn environment(&self, name: &str) -> Result<Option<SecretString>, AdcRuntimeError> {
			Ok(self.env.get(name).cloned().map(SecretString::from))
		}

		fn read_secret_file(&self, path: &Path) -> Result<SecretString, AdcRuntimeError> {
			self
				.files
				.get(path)
				.cloned()
				.map(SecretString::from)
				.ok_or(AdcRuntimeError::NotFound)
		}

		fn expand_home(&self, path: &str) -> Result<PathBuf, AdcRuntimeError> {
			Ok(PathBuf::from(path))
		}
	}

	struct Http(Mutex<Vec<OAuthHttpResponse>>);
	impl OAuthHttpClient for Http {
		fn execute(
			&self,
			_: OAuthHttpRequest,
		) -> BoxFuture<'_, Result<OAuthHttpResponse, OauthOAuthTransportError>> {
			async move { Ok(self.0.lock().remove(0)) }.boxed()
		}
	}

	fn meta() -> LeaseMeta {
		LeaseMeta {
			account:    AccountId::from("adc-account"),
			principal:  PrincipalId::from("adc-principal"),
			generation: 1,
			expires_at: None,
		}
	}

	#[tokio::test]
	async fn catalog_source_order_prefers_ephemeral_environment_token() {
		let runtime = Runtime {
			env:   HashMap::from([("OMP_TOKEN".to_owned(), "environment-secret".to_owned())]),
			files: HashMap::new(),
		};
		let http = Http(Mutex::new(Vec::new()));
		let engine = AdcEngine::new(&http, &runtime);
		let spec = AdcSpec {
			sources:      vec![
				AdcSourceSpec::EnvironmentAccessToken { variable: "OMP_TOKEN".into() },
				AdcSourceSpec::Metadata {
					url:     "http://metadata.test/token".into(),
					headers: Vec::new(),
				},
			],
			api_key_env:  Vec::new(),
			project_env:  Vec::new(),
			location_env: Vec::new(),
			scopes:       Vec::new(),
			audience:     None,
			placement:    SpecHeaderPlacement::bearer().into(),
		};
		let resolution = engine
			.resolve(&spec, meta(), UNIX_EPOCH)
			.await
			.expect("ADC");
		assert_eq!(resolution.source, AdcSourceKind::Environment);
		assert!(!format!("{resolution:?}").contains("environment-secret"));
	}

	#[tokio::test]
	async fn upstream_environment_name_is_rejected_even_when_populated() {
		let runtime = Runtime {
			env:   HashMap::from([("GOOGLE_ACCESS_TOKEN".to_owned(), "upstream-secret".to_owned())]),
			files: HashMap::new(),
		};
		let http = Http(Mutex::new(Vec::new()));
		let engine = AdcEngine::new(&http, &runtime);
		let spec = AdcSpec {
			sources:      vec![AdcSourceSpec::EnvironmentAccessToken {
				variable: "GOOGLE_ACCESS_TOKEN".into(),
			}],
			api_key_env:  Vec::new(),
			project_env:  Vec::new(),
			location_env: Vec::new(),
			scopes:       Vec::new(),
			audience:     None,
			placement:    SpecHeaderPlacement::bearer().into(),
		};
		assert!(matches!(
			engine.resolve(&spec, meta(), UNIX_EPOCH).await,
			Err(AdcError::InvalidSpec)
		));
	}

	#[tokio::test]
	async fn authorized_user_file_refreshes_without_error_text_or_secret_debug() {
		let file = r#"{"type":"authorized_user","client_id":"client","client_secret":"client-secret","refresh_token":"refresh-secret","token_uri":"https://auth.example/token","quota_project_id":"billing"}"#;
		let runtime = Runtime {
			env:   HashMap::new(),
			files: HashMap::from([(PathBuf::from("credential.json"), file.to_owned())]),
		};
		let http = Http(Mutex::new(vec![OAuthHttpResponse {
			status:  200,
			headers: HeaderMap::new(),
			body:    SecretString::from(
				r#"{"access_token":"minted-secret","expires_in":3600,"token_type":"Bearer"}"#
					.to_owned(),
			),
		}]));
		let engine = AdcEngine::new(&http, &runtime);
		let spec = AdcSpec {
			sources:      vec![AdcSourceSpec::CredentialFile {
				path_variable: None,
				default_path:  Some("credential.json".into()),
			}],
			api_key_env:  Vec::new(),
			project_env:  Vec::new(),
			location_env: Vec::new(),
			scopes:       vec!["scope".into()],
			audience:     None,
			placement:    SpecHeaderPlacement::bearer().into(),
		};
		let resolution = engine
			.resolve(&spec, meta(), UNIX_EPOCH)
			.await
			.expect("ADC");
		assert_eq!(resolution.source, AdcSourceKind::AuthorizedUser);
		let debug = format!("{resolution:?}");
		for secret in ["client-secret", "refresh-secret", "minted-secret"] {
			assert!(!debug.contains(secret));
		}
	}
}
