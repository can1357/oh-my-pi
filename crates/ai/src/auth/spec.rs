//! Catalog-driven authentication protocol specifications.

use std::time::Duration;

use omp_catalog::provider::{OAuthCompletion, OAuthExchangeKind, SealedBodyPlacement};
use omp_core::{Str, sf};
use serde::{Deserialize, Serialize};
use url::Url;

/// Complete data-only authentication description attached to a catalog route.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum AuthSpec {
	/// The route does not authenticate.
	None,
	/// An API key acquired from declared sources in exact catalog order.
	ApiKey {
		/// Sources tried in exact catalog order.
		sources:   Vec<CredentialSourceSpec>,
		/// Request location for the resolved key.
		placement: KeyPlacement,
	},
	/// RFC 7617 basic authentication acquired as two independently named
	/// secrets.
	Basic {
		/// Declarative username/password sources.
		sources:   Vec<CredentialSourceSpec>,
		/// Authorization header placement.
		placement: HeaderPlacement,
	},
	/// A bearer token acquired from declared sources in exact catalog order.
	Bearer {
		/// Sources tried in exact catalog order.
		sources:   Vec<CredentialSourceSpec>,
		/// Request location for the resolved token.
		placement: KeyPlacement,
		/// Non-secret protocol scheme retained in evidence.
		scheme:    BearerScheme,
	},
	/// OAuth 2 authorization-code flow with PKCE.
	OAuthPkce(OAuthPkceSpec),
	/// OAuth 2 device authorization grant.
	OAuthDevice(OAuthDeviceSpec),
	/// Browser-assisted flow completed by pasting an authorization code.
	OAuthPaste(OAuthPasteSpec),
	/// Typed provider-specific OAuth exchange selected by catalog enum.
	OAuthCustom(OAuthCustomSpec),
	/// Application-default credentials resolved in the declared source order.
	ApplicationDefault(AdcSpec),
	/// AWS Signature Version 4 over the exact final request.
	AwsSigV4(SigV4Spec),
	/// A provider session token acquired from a declared source.
	SessionToken(SessionTokenSpec),
}
/// Sanitized bearer-token scheme retained for receipt and observation evidence.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BearerScheme {
	/// OAuth, Entra ID, GitHub App, or another explicit bearer-token protocol.
	OAuth,
	/// Google application-default credentials.
	ApplicationDefault,
}

impl AuthSpec {
	/// Validates structural invariants without acquiring credentials or
	/// performing I/O.
	pub fn validate(&self) -> Result<(), AuthSpecError> {
		match self {
			Self::None => Ok(()),
			Self::ApiKey { sources, placement } | Self::Bearer { sources, placement, .. } => {
				validate_sources(sources)?;
				placement.validate()
			},
			Self::Basic { sources, placement } => {
				validate_sources(sources)?;
				placement.validate()
			},
			Self::OAuthPkce(spec) => spec.validate(),
			Self::OAuthDevice(spec) => spec.validate(),
			Self::OAuthPaste(spec) => spec.validate(),
			Self::ApplicationDefault(spec) => spec.validate(),
			Self::OAuthCustom(spec) => spec.validate(),
			Self::AwsSigV4(spec) => spec.validate(),
			Self::SessionToken(spec) => {
				validate_sources(&spec.sources)?;
				spec.placement.validate()
			},
		}
	}

	/// Converts catalog-owned auth data without provider or credential-kind
	/// inference.
	///
	/// Route construction supplies `resolved_signing_region` only for a
	/// route-endpoint or environment region source.
	pub fn from_catalog(
		spec: &omp_catalog::provider::AuthSpec,
		oauth: Option<&omp_catalog::provider::OAuthSpec>,
		resolved_signing_region: Option<Str>,
	) -> Result<Self, CatalogAuthSpecError> {
		use omp_catalog::provider::{AuthSpecKind, OAuthFlowSpec, RegionSource};
		let placement = || catalog_placement(spec);
		let runtime = match spec.kind {
			AuthSpecKind::None => Self::None,
			AuthSpecKind::ApiKey => Self::ApiKey {
				sources:   require_sources(convert_sources(spec)?)?,
				placement: placement()?,
			},
			AuthSpecKind::Basic => {
				let KeyPlacement::Header(placement) = placement()? else {
					return Err(CatalogAuthSpecError::MissingOrAmbiguousPlacement);
				};
				Self::Basic { sources: require_sources(convert_sources(spec)?)?, placement }
			},
			AuthSpecKind::Bearer
			| AuthSpecKind::OptionalBearer
			| AuthSpecKind::AzureAd
			| AuthSpecKind::GithubApp => Self::Bearer {
				sources:   require_sources(convert_sources(spec)?)?,
				placement: placement()?,
				scheme:    BearerScheme::OAuth,
			},
			AuthSpecKind::Oauth => {
				let oauth = oauth.ok_or(CatalogAuthSpecError::MissingOAuthSpec)?;
				if spec.oauth.as_ref() != Some(&oauth.id) {
					return Err(CatalogAuthSpecError::MismatchedOAuthSpec);
				}
				let client = convert_oauth_client(spec, oauth)?;
				match &oauth.flow {
					OAuthFlowSpec::Pkce {
						authorize_url,
						redirect_uri,
						completion,
						authorize_parameters,
					} => Self::OAuthPkce(OAuthPkceSpec {
						client,
						authorize_url: authorize_url.clone(),
						redirect_uri: redirect_uri.clone(),
						completion: match completion {
							OAuthCompletion::CallbackUrl => PkceCompletion::CallbackUrl,
							OAuthCompletion::PasteCallbackUrl => PkceCompletion::PasteCallbackUrl,
							OAuthCompletion::PasteCode => PkceCompletion::PasteCode,
						},
						authorize_params: convert_oauth_parameters(authorize_parameters),
					}),
					OAuthFlowSpec::DeviceCode { device_authorization_url, polling } => {
						Self::OAuthDevice(OAuthDeviceSpec {
							client,
							device_authorization_url: device_authorization_url.clone(),
							default_interval: Duration::from_millis(polling.default_interval_ms),
							max_interval: Duration::from_millis(polling.maximum_interval_ms),
						})
					},
					OAuthFlowSpec::Paste { authorization_url, prompt } => {
						Self::OAuthPaste(OAuthPasteSpec {
							client,
							authorization_url: authorization_url.clone(),
							prompt: prompt.clone(),
						})
					},
					OAuthFlowSpec::Custom { authorize_url, exchange, parameters, polling } => {
						Self::OAuthCustom(OAuthCustomSpec {
							client,
							authorize_url: authorize_url.clone(),
							exchange: *exchange,
							parameters: convert_oauth_parameters(parameters),
							polling: polling.map(|polling| OAuthPollingSpec {
								max_polls:        polling.maximum_polls,
								default_interval: Duration::from_millis(polling.default_interval_ms),
								max_interval:     Duration::from_millis(polling.maximum_interval_ms),
							}),
						})
					},
				}
			},
			AuthSpecKind::OmpSession => Self::SessionToken(SessionTokenSpec {
				sources:   require_sources(convert_sources(spec)?)?,
				placement: placement()?,
			}),
			AuthSpecKind::GcpAdc => Self::ApplicationDefault(convert_adc(spec, placement()?)?),
			AuthSpecKind::AwsSigv4 => {
				let signing = spec
					.signing
					.as_ref()
					.ok_or(CatalogAuthSpecError::MissingSigningContext)?;
				let region = match &signing.region {
					RegionSource::Fixed { region } => region.clone(),
					RegionSource::RouteEndpoint => {
						resolved_signing_region.ok_or(CatalogAuthSpecError::MissingSigningRegion)?
					},
					RegionSource::Environment { ordered_names } => {
						validate_environment_names(ordered_names)?;
						resolved_signing_region.ok_or(CatalogAuthSpecError::MissingSigningRegion)?
					},
				};
				Self::AwsSigV4(SigV4Spec {
					service: signing.service.clone(),
					region,
					unsigned_headers: Vec::new(),
				})
			},
		};
		runtime
			.validate()
			.map_err(CatalogAuthSpecError::InvalidRuntimeSpec)?;
		Ok(runtime)
	}
}

fn catalog_placement(
	spec: &omp_catalog::provider::AuthSpec,
) -> Result<KeyPlacement, CatalogAuthSpecError> {
	match (&spec.header_name, &spec.query_parameter, spec.sealed_body) {
		(Some(name), None, None) => Ok(KeyPlacement::Header(HeaderPlacement {
			name:   name.clone(),
			prefix: spec.prefix.clone().unwrap_or_default(),
		})),
		(None, Some(name), None) => Ok(KeyPlacement::Query(QueryPlacement { name: name.clone() })),
		(None, None, Some(SealedBodyPlacement::DevinMetadata)) => {
			Ok(KeyPlacement::Body(BodyPlacement::DevinMetadata))
		},
		_ => Err(CatalogAuthSpecError::MissingOrAmbiguousPlacement),
	}
}

fn require_sources(
	sources: Vec<CredentialSourceSpec>,
) -> Result<Vec<CredentialSourceSpec>, CatalogAuthSpecError> {
	if sources.is_empty() {
		Err(CatalogAuthSpecError::MissingCredentialSource)
	} else {
		Ok(sources)
	}
}

fn convert_sources(
	spec: &omp_catalog::provider::AuthSpec,
) -> Result<Vec<CredentialSourceSpec>, CatalogAuthSpecError> {
	let environment = |ordered_names: &[Str]| CredentialSourceSpec::Environment {
		variables: ordered_names.to_vec(),
	};
	let basic_environment =
		|username_names: &[Str], password_names: &[Str]| CredentialSourceSpec::BasicEnvironment {
			username_variables: username_names.to_vec(),
			password_variables: password_names.to_vec(),
		};
	let stored = || CredentialSourceSpec::Stored { profile: None };
	let aws_chain = || CredentialSourceSpec::AwsChain { profile: None };
	let interactive = || CredentialSourceSpec::Interactive;

	spec
		.credential_sources
		.iter()
		.map(|source| {
			use omp_catalog::provider::CredentialSourceSpec;
			match source {
				CredentialSourceSpec::Environment { ordered_names } => Ok(environment(ordered_names)),
				CredentialSourceSpec::BasicEnvironment { username_names, password_names } => {
					Ok(basic_environment(username_names, password_names))
				},
				CredentialSourceSpec::Stored => Ok(stored()),
				CredentialSourceSpec::AwsChain => Ok(aws_chain()),
				CredentialSourceSpec::Oauth { .. } | CredentialSourceSpec::Session => Ok(interactive()),
				CredentialSourceSpec::ApplicationDefault { .. } => {
					Err(CatalogAuthSpecError::ApplicationDefaultSourceOutsideAdc)
				},
			}
		})
		.collect()
}

fn convert_oauth_parameters(
	parameters: &[omp_catalog::provider::OAuthParameter],
) -> Vec<OAuthParameter> {
	parameters
		.iter()
		.map(|parameter| OAuthParameter {
			name:  parameter.name.clone(),
			value: parameter.value.clone(),
		})
		.collect()
}
fn convert_oauth_client(
	auth: &omp_catalog::provider::AuthSpec,
	oauth: &omp_catalog::provider::OAuthSpec,
) -> Result<OAuthClientSpec, CatalogAuthSpecError> {
	use omp_catalog::provider::{OAuthRefreshBehavior, OAuthTokenPlacement};
	let mut found_link = false;
	for source in &auth.credential_sources {
		let flow = {
			use omp_catalog::provider::CredentialSourceSpec;
			let CredentialSourceSpec::Oauth { flow } = source else {
				continue;
			};
			flow
		};
		if flow != &oauth.id {
			return Err(CatalogAuthSpecError::MismatchedOAuthSpec);
		}
		found_link = true;
	}
	if !found_link {
		return Err(CatalogAuthSpecError::MissingCredentialSource);
	}
	let refresh = match &oauth.refresh {
		OAuthRefreshBehavior::Unsupported => OAuthRefreshSpec::Unsupported,
		OAuthRefreshBehavior::TokenEndpoint => OAuthRefreshSpec::TokenEndpoint,
		OAuthRefreshBehavior::Endpoint { url, parameters } => OAuthRefreshSpec::Endpoint {
			url:        url.clone(),
			parameters: convert_oauth_parameters(parameters),
		},
	};
	let placement = match &oauth.placement {
		OAuthTokenPlacement::Header { name, prefix } => {
			KeyPlacement::Header(HeaderPlacement { name: name.clone(), prefix: prefix.clone() })
		},
		OAuthTokenPlacement::Query { parameter } => {
			KeyPlacement::Query(QueryPlacement { name: parameter.clone() })
		},
		OAuthTokenPlacement::SealedBody { placement: SealedBodyPlacement::DevinMetadata } => {
			KeyPlacement::Body(BodyPlacement::DevinMetadata)
		},
	};
	Ok(OAuthClientSpec {
		sources: require_sources(convert_sources(auth)?)?,
		client_id: oauth.client_id.clone(),
		refresh,
		token_url: oauth.token_url.clone(),
		scopes: oauth.scopes.to_vec(),
		audience: oauth.audience.clone(),
		token_params: convert_oauth_parameters(&oauth.token_parameters),
		placement,
	})
}

fn convert_adc(
	spec: &omp_catalog::provider::AuthSpec,
	placement: KeyPlacement,
) -> Result<AdcSpec, CatalogAuthSpecError> {
	use omp_catalog::provider::{
		ApplicationDefaultSource as CatalogAdcSource, CredentialSourceSpec as CatalogSource,
	};
	let mut adc = None;
	for source in &spec.credential_sources {
		if let CatalogSource::ApplicationDefault { sources, .. } = source {
			if adc.is_some() {
				return Err(CatalogAuthSpecError::MultipleApplicationDefaultSources);
			}
			let runtime_sources = sources
				.iter()
				.map(|source| match source {
					CatalogAdcSource::EnvironmentAccessToken { variable } => {
						AdcSourceSpec::EnvironmentAccessToken { variable: variable.clone() }
					},
					CatalogAdcSource::CredentialFile { path_environment, default_path } => {
						AdcSourceSpec::CredentialFile {
							path_variable: path_environment.clone(),
							default_path:  default_path.clone(),
						}
					},
					CatalogAdcSource::Metadata { url, headers } => AdcSourceSpec::Metadata {
						url:     url.clone(),
						headers: headers
							.iter()
							.map(|header| PublicHeader {
								name:  header.name.clone(),
								value: header.value.clone(),
							})
							.collect(),
					},
				})
				.collect();
			let CatalogSource::ApplicationDefault { api_key_env, project_env, location_env, .. } =
				source
			else {
				return Err(CatalogAuthSpecError::UnexpectedCredentialSource);
			};
			adc = Some(AdcSpec {
				sources:      runtime_sources,
				api_key_env:  api_key_env.to_vec(),
				project_env:  project_env.to_vec(),
				location_env: location_env.to_vec(),
				scopes:       spec.scopes.to_vec(),
				audience:     spec.audience.clone(),
				placement:    placement.clone(),
			});
		} else {
			return Err(CatalogAuthSpecError::UnexpectedCredentialSource);
		}
	}
	adc.ok_or(CatalogAuthSpecError::MissingApplicationDefaultSpec)
}

/// Catalog-to-wire authentication conversion failure.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum CatalogAuthSpecError {
	/// Scalar credential placement was missing or contradictory.
	#[error("catalog auth placement is missing or ambiguous")]
	MissingOrAmbiguousPlacement,
	/// An auth kind that acquires scalar material had no real source.
	#[error("catalog auth requires an explicit credential source")]
	MissingCredentialSource,
	/// Linked OAuth record is absent.
	#[error("catalog OAuth auth requires its linked flow")]
	MissingOAuthSpec,
	/// Linked OAuth record has a different identity.
	#[error("catalog OAuth flow identity does not match auth")]
	MismatchedOAuthSpec,
	/// ADC source appeared outside an ADC authentication spec.
	#[error("application-default source appears outside ADC auth")]
	ApplicationDefaultSourceOutsideAdc,
	/// ADC auth omits its complete typed source chain.
	#[error("catalog ADC auth requires a complete application-default specification")]
	MissingApplicationDefaultSpec,
	/// More than one ADC chain was declared.
	#[error("catalog ADC auth declares multiple application-default chains")]
	MultipleApplicationDefaultSources,
	/// ADC auth contains a source owned by another engine.
	#[error("catalog ADC auth contains an unexpected credential source")]
	UnexpectedCredentialSource,
	/// A `SigV4` route did not supply its signing contract.
	#[error("catalog SigV4 route requires explicit signing context")]
	MissingSigningContext,
	/// A dynamic `SigV4` region was not resolved during route construction.
	#[error("catalog SigV4 route requires a resolved signing region")]
	MissingSigningRegion,
	/// Catalog credential environment declaration does not lead with an OMP
	/// name.
	#[error("catalog credential environment source must lead with an OMP_* name")]
	InvalidEnvironmentSource,
	/// Converted runtime data failed structural validation.
	#[error("catalog auth converts to an invalid runtime specification")]
	InvalidRuntimeSpec(#[from] AuthSpecError),
}

/// Catalog declaration of where credential material may be acquired.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum CredentialSourceSpec {
	/// Check the named environment variables in order; values are ephemeral.
	Environment {
		/// Names checked in exact order.
		variables: Vec<Str>,
	},
	/// Read an RFC 7617 username and password from independent environment
	/// lookup orders.
	BasicEnvironment {
		/// Username names checked in exact order.
		username_variables: Vec<Str>,
		/// Password names checked in exact order.
		password_variables: Vec<Str>,
	},
	/// Ask the caller over an interactive login session.
	Interactive,
	/// Read an encrypted account-store record by non-secret profile label.
	Stored {
		/// Optional account-store profile selector.
		profile: Option<Str>,
	},
	/// Resolve the platform's application-default credential chain.
	ApplicationDefault,
	/// Resolve the platform's AWS credential chain.
	AwsChain {
		/// Optional shared-credentials profile selector.
		profile: Option<Str>,
	},
}

/// Permitted placement of an API key or session token.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum KeyPlacement {
	/// Put the credential in a sensitive HTTP header.
	Header(HeaderPlacement),
	/// Defer a sensitive query parameter until final wire serialization.
	Query(QueryPlacement),
	/// Bind the credential into a typed sealed request body at dispatch.
	Body(BodyPlacement),
}

impl KeyPlacement {
	fn validate(&self) -> Result<(), AuthSpecError> {
		match self {
			Self::Header(value) => value.validate(),
			Self::Query(value) => value.validate(),
			Self::Body(_) => Ok(()),
		}
	}
}

impl From<HeaderPlacement> for KeyPlacement {
	fn from(value: HeaderPlacement) -> Self {
		Self::Header(value)
	}
}

/// Typed credential-bearing body formats supported by sealed codecs.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BodyPlacement {
	/// Devin protobuf `Metadata`, finalized before Connect framing and gzip.
	DevinMetadata,
}

/// Header name and non-secret prefix used for a credential.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct HeaderPlacement {
	/// HTTP header name.
	pub name:   Str,
	/// Prefix inserted before the secret, such as `Bearer `.
	#[serde(default)]
	pub prefix: Str,
}

impl HeaderPlacement {
	/// Standard `Authorization: Bearer …` placement.
	pub fn bearer() -> Self {
		Self { name: sf!("authorization"), prefix: sf!("Bearer ") }
	}

	fn validate(&self) -> Result<(), AuthSpecError> {
		if self.name.is_empty() {
			return Err(AuthSpecError::EmptyField("header name"));
		}
		if self
			.prefix
			.bytes()
			.any(|byte| matches!(byte, b'\r' | b'\n'))
		{
			return Err(AuthSpecError::InvalidHeaderPrefix);
		}
		Ok(())
	}
}

/// Query parameter used for a credential at final dispatch.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct QueryPlacement {
	/// Query parameter name.
	pub name: Str,
}

/// Catalog-defined OAuth refresh behavior.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum OAuthRefreshSpec {
	/// This flow does not support refresh.
	Unsupported,
	/// Refresh through the standard token endpoint and token parameters.
	TokenEndpoint,
	/// Refresh through a distinct public endpoint and parameter set.
	Endpoint {
		/// Public refresh endpoint.
		url:        Str,
		/// Additional non-secret refresh parameters.
		parameters: Vec<OAuthParameter>,
	},
}

impl QueryPlacement {
	fn validate(&self) -> Result<(), AuthSpecError> {
		if self.name.is_empty() {
			Err(AuthSpecError::EmptyField("query parameter name"))
		} else {
			Ok(())
		}
	}
}

/// Standard OAuth endpoints and public client parameters shared by flow
/// engines.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct OAuthClientSpec {
	/// Credential sources in exact catalog acquisition order.
	pub sources:      Vec<CredentialSourceSpec>,
	/// Public OAuth client identifier.
	pub client_id:    Str,
	/// Refresh behavior preserved from the catalog.
	pub refresh:      OAuthRefreshSpec,
	/// Token exchange endpoint.
	pub token_url:    Str,
	/// Ordered scope list.
	#[serde(default)]
	pub scopes:       Vec<Str>,
	/// Optional resource audience.
	pub audience:     Option<Str>,
	/// Extra non-secret form fields sent during token exchange.
	#[serde(default)]
	pub token_params: Vec<OAuthParameter>,
	/// Placement of the resulting access token.
	pub placement:    KeyPlacement,
}

impl OAuthClientSpec {
	fn validate(&self) -> Result<(), AuthSpecError> {
		validate_sources(&self.sources)?;
		non_empty(&self.client_id, "OAuth client id")?;
		valid_url(&self.token_url, "OAuth token URL")?;
		self.placement.validate()
	}
}

/// A non-secret catalog-defined OAuth parameter.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct OAuthParameter {
	/// Form or query parameter name.
	pub name:  Str,
	/// Public parameter value.
	pub value: Str,
}

/// Name of the runtime-injected [`OAuthParameter`] carrying the human-readable
/// name of the provider being logged in.
///
/// Interactive custom exchanges use it to address the user by the selected
/// provider: several providers mint keys from one shared console (`OpenCode
/// Zen` and `OpenCode Go` both use `opencode.ai/auth`), so a generic prompt
/// would not say which provider's key is being collected.
pub const PROVIDER_NAME_PARAMETER: &str = "provider_name";

/// Completion mechanism for an authorization-code flow.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PkceCompletion {
	/// Accept a callback URL and require an exact state match.
	CallbackUrl,
	/// Accept a pasted callback URL and require an exact state match.
	PasteCallbackUrl,
	/// Accept a raw code where the provider cannot echo state out of band.
	PasteCode,
}

/// OAuth authorization-code flow with S256 PKCE.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct OAuthPkceSpec {
	/// Shared token endpoint and client parameters.
	pub client:           OAuthClientSpec,
	/// Browser authorization endpoint.
	pub authorize_url:    Str,
	/// Exact redirect URI registered for this client.
	pub redirect_uri:     Str,
	/// How the authorization result reaches the engine.
	pub completion:       PkceCompletion,
	/// Additional public authorization query parameters.
	#[serde(default)]
	pub authorize_params: Vec<OAuthParameter>,
}

impl OAuthPkceSpec {
	fn validate(&self) -> Result<(), AuthSpecError> {
		self.client.validate()?;
		valid_url(&self.authorize_url, "OAuth authorization URL")?;
		valid_url(&self.redirect_uri, "OAuth redirect URL")
	}
}

/// OAuth RFC 8628 device authorization flow.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct OAuthDeviceSpec {
	/// Shared token endpoint and client parameters.
	pub client:                   OAuthClientSpec,
	/// Device authorization endpoint.
	pub device_authorization_url: Str,
	/// Default interval when the server omits one.
	#[serde(with = "duration_millis")]
	pub default_interval:         Duration,
	/// Maximum accepted or slowed-down polling interval.
	#[serde(with = "duration_millis")]
	pub max_interval:             Duration,
}

impl OAuthDeviceSpec {
	fn validate(&self) -> Result<(), AuthSpecError> {
		self.client.validate()?;
		valid_url(&self.device_authorization_url, "device authorization URL")?;
		if self.default_interval.is_zero() || self.max_interval < self.default_interval {
			return Err(AuthSpecError::InvalidPollingInterval);
		}
		Ok(())
	}
}

/// Browser-assisted OAuth exchange completed by a pasted code.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct OAuthPasteSpec {
	/// Shared token endpoint and client parameters.
	pub client:            OAuthClientSpec,
	/// Public page the caller should open to acquire a code.
	pub authorization_url: Str,
	/// Stable, non-secret prompt shown to the caller.
	pub prompt:            Str,
}

impl OAuthPasteSpec {
	fn validate(&self) -> Result<(), AuthSpecError> {
		self.client.validate()?;
		valid_url(&self.authorization_url, "paste-flow authorization URL")?;
		non_empty(&self.prompt, "paste-flow prompt")
	}
}

/// Optional bounds for a typed custom OAuth exchange.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct OAuthPollingSpec {
	/// Optional hard upper bound on polling attempts.
	pub max_polls:        Option<u16>,
	/// Default polling interval.
	#[serde(with = "duration_millis")]
	pub default_interval: Duration,
	/// Maximum accepted polling interval.
	#[serde(with = "duration_millis")]
	pub max_interval:     Duration,
}

/// Catalog-selected custom OAuth exchange with no provider-name dispatch.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct OAuthCustomSpec {
	/// Shared token endpoint and credential sources.
	pub client:        OAuthClientSpec,
	/// Public authorization or login endpoint.
	pub authorize_url: Str,
	/// Exact typed exchange engine discriminator.
	pub exchange:      OAuthExchangeKind,
	/// Additional public exchange parameters.
	pub parameters:    Vec<OAuthParameter>,
	/// Optional polling bounds.
	pub polling:       Option<OAuthPollingSpec>,
}

impl OAuthCustomSpec {
	fn validate(&self) -> Result<(), AuthSpecError> {
		// API-key paste performs no standard token exchange, while OpenRouter
		// binds its clientless exchange exclusively through PKCE. Validate the
		// fields each protocol actually sends instead of inventing a client id.
		match self.exchange {
			OAuthExchangeKind::ApiKeyPaste => {
				validate_sources(&self.client.sources)?;
				self.client.placement.validate()?;
			},
			OAuthExchangeKind::OpenRouterApiKey => {
				validate_sources(&self.client.sources)?;
				valid_url(&self.client.token_url, "OAuth token URL")?;
				self.client.placement.validate()?;
			},
			_ => self.client.validate()?,
		}
		valid_url(&self.authorize_url, "custom OAuth authorization URL")?;
		if let Some(polling) = self.polling
			&& (polling.max_polls == Some(0)
				|| polling.default_interval.is_zero()
				|| polling.max_interval < polling.default_interval)
		{
			return Err(AuthSpecError::InvalidPollingInterval);
		}
		Ok(())
	}
}

/// One source in an application-default credential chain.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum AdcSourceSpec {
	/// An environment variable containing a short-lived access token.
	EnvironmentAccessToken {
		/// Environment variable containing the access token.
		variable: Str,
	},
	/// A JSON credential file selected by an optional environment override.
	CredentialFile {
		/// Optional environment variable that overrides the credential-file path.
		path_variable: Option<Str>,
		/// Optional default credential-file path.
		default_path:  Option<Str>,
	},
	/// A workload metadata endpoint returning a standard OAuth token response.
	Metadata {
		/// Endpoint URL.
		url:     Str,
		/// Public headers sent to the endpoint.
		headers: Vec<PublicHeader>,
	},
}

/// Application-default credential source order and token policy.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct AdcSpec {
	/// Sources tried in exact catalog order.
	pub sources:      Vec<AdcSourceSpec>,
	/// API-key/access-token variables retained in exact catalog order.
	pub api_key_env:  Vec<Str>,
	/// Project variables retained in exact catalog order.
	pub project_env:  Vec<Str>,
	/// Location variables retained in exact catalog order.
	pub location_env: Vec<Str>,
	/// Scopes used for service-account assertions and user refresh.
	#[serde(default)]
	pub scopes:       Vec<Str>,
	/// Optional audience used by workload identity exchanges.
	pub audience:     Option<Str>,
	/// Placement of the resolved access token.
	pub placement:    KeyPlacement,
}

impl AdcSpec {
	pub(crate) fn validate(&self) -> Result<(), AuthSpecError> {
		if self.sources.is_empty() {
			return Err(AuthSpecError::EmptySources);
		}
		for names in [&self.api_key_env, &self.project_env, &self.location_env] {
			if names.first().is_some_and(|name| !name.starts_with("OMP_")) {
				return Err(AuthSpecError::InvalidEnvironmentSource);
			}
		}
		if self
			.sources
			.iter()
			.find_map(|source| match source {
				AdcSourceSpec::EnvironmentAccessToken { variable } => Some(variable),
				_ => None,
			})
			.is_some_and(|name| !name.starts_with("OMP_"))
		{
			return Err(AuthSpecError::InvalidEnvironmentSource);
		}
		self.placement.validate()?;
		for source in &self.sources {
			match source {
				AdcSourceSpec::EnvironmentAccessToken { .. } => {},
				AdcSourceSpec::CredentialFile { path_variable, default_path } => {
					if path_variable.is_none() && default_path.is_none() {
						return Err(AuthSpecError::MissingCredentialPath);
					}
					if path_variable
						.as_ref()
						.is_some_and(|name| !name.starts_with("OMP_"))
					{
						return Err(AuthSpecError::InvalidEnvironmentSource);
					}
				},
				AdcSourceSpec::Metadata { url, .. } => valid_url(url, "ADC metadata URL")?,
			}
		}
		Ok(())
	}
}
fn validate_environment_names(names: &[Str]) -> Result<(), CatalogAuthSpecError> {
	if names.first().is_none_or(|name| !name.starts_with("OMP_")) {
		Err(CatalogAuthSpecError::InvalidEnvironmentSource)
	} else {
		Ok(())
	}
}

/// Public header attached to a metadata request.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct PublicHeader {
	/// Header name.
	pub name:  Str,
	/// Non-secret header value.
	pub value: Str,
}

/// Data required to sign an AWS request with Signature Version 4.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct SigV4Spec {
	/// AWS signing service.
	pub service:          Str,
	/// AWS signing region.
	pub region:           Str,
	/// Additional lower-case headers that must not enter the canonical request.
	#[serde(default)]
	pub unsigned_headers: Vec<Str>,
}

impl SigV4Spec {
	fn validate(&self) -> Result<(), AuthSpecError> {
		non_empty(&self.service, "SigV4 service")?;
		non_empty(&self.region, "SigV4 region")?;
		if self
			.unsigned_headers
			.iter()
			.any(|name| name.bytes().any(|byte| byte.is_ascii_uppercase()))
		{
			return Err(AuthSpecError::UnsignedHeaderNotLowercase);
		}
		Ok(())
	}
}

/// Catalog-driven session token acquisition and placement.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct SessionTokenSpec {
	/// Credential sources in exact catalog order.
	pub sources:   Vec<CredentialSourceSpec>,
	/// Header, query, or sealed typed-body placement.
	pub placement: KeyPlacement,
}

/// Structural authentication-spec validation failure.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum AuthSpecError {
	/// A required catalog field is empty.
	#[error("authentication specification has an empty {0}")]
	EmptyField(&'static str),
	/// A catalog endpoint is not an absolute HTTP(S) URL.
	#[error("authentication specification has an invalid {0}")]
	InvalidUrl(&'static str),
	/// A header prefix contains a line break.
	#[error("authentication header prefix contains a line break")]
	InvalidHeaderPrefix,
	/// A bounded operation was configured with a zero limit.
	#[error("authentication specification has a zero {0}")]
	ZeroBound(&'static str),
	/// Device polling intervals are zero or inverted.
	#[error("device polling intervals are invalid")]
	InvalidPollingInterval,
	/// An ADC chain has no sources.
	#[error("application-default credential chain has no sources")]
	EmptySources,
	/// A credential-file source has neither an override nor a default path.
	#[error("application-default credential-file source has no path")]
	MissingCredentialPath,
	/// `SigV4` unsigned-header names must already be canonical lower case.
	#[error("SigV4 unsigned-header name is not lower case")]
	UnsignedHeaderNotLowercase,
	/// Credential environment variable lists must lead with an OMP-prefixed
	/// name.
	#[error("credential environment source must lead with an OMP_* name")]
	InvalidEnvironmentSource,
}

fn validate_sources(sources: &[CredentialSourceSpec]) -> Result<(), AuthSpecError> {
	if sources.is_empty() {
		return Err(AuthSpecError::EmptySources);
	}
	for source in sources {
		if let CredentialSourceSpec::Environment { variables } = source
			&& variables
				.first()
				.is_none_or(|name| !name.starts_with("OMP_"))
		{
			return Err(AuthSpecError::InvalidEnvironmentSource);
		}
		if let CredentialSourceSpec::BasicEnvironment { username_variables, password_variables } =
			source && (username_variables
			.first()
			.is_none_or(|name| !name.starts_with("OMP_"))
			|| password_variables
				.first()
				.is_none_or(|name| !name.starts_with("OMP_")))
		{
			return Err(AuthSpecError::InvalidEnvironmentSource);
		}
	}
	Ok(())
}

const fn non_empty(value: &str, field: &'static str) -> Result<(), AuthSpecError> {
	if value.is_empty() {
		Err(AuthSpecError::EmptyField(field))
	} else {
		Ok(())
	}
}

fn valid_url(value: &str, field: &'static str) -> Result<(), AuthSpecError> {
	let parsed = Url::parse(value).map_err(|_| AuthSpecError::InvalidUrl(field))?;
	if matches!(parsed.scheme(), "http" | "https") && parsed.has_host() {
		Ok(())
	} else {
		Err(AuthSpecError::InvalidUrl(field))
	}
}

mod duration_millis {
	use std::time::Duration;

	use serde::{Deserialize, Deserializer, Serializer};

	pub fn serialize<S: Serializer>(value: &Duration, serializer: S) -> Result<S::Ok, S::Error> {
		serializer.serialize_u64(value.as_millis().try_into().unwrap_or(u64::MAX))
	}

	pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Duration, D::Error> {
		Ok(Duration::from_millis(u64::deserialize(deserializer)?))
	}
}

#[cfg(test)]
mod tests {

	use super::*;

	#[test]
	fn specs_reject_invalid_device_intervals_and_header_prefixes() {
		let client = OAuthClientSpec {
			sources:      vec![CredentialSourceSpec::Interactive],
			client_id:    "client".into(),
			refresh:      OAuthRefreshSpec::TokenEndpoint,
			token_url:    "https://auth.example/token".into(),
			scopes:       Vec::new(),
			audience:     None,
			token_params: Vec::new(),
			placement:    HeaderPlacement::bearer().into(),
		};
		let device = AuthSpec::OAuthDevice(OAuthDeviceSpec {
			client,
			device_authorization_url: "https://auth.example/device".into(),
			default_interval: Duration::ZERO,
			max_interval: Duration::from_secs(10),
		});
		assert_eq!(device.validate(), Err(AuthSpecError::InvalidPollingInterval));
		let placement = KeyPlacement::Header(HeaderPlacement {
			name:   "authorization".into(),
			prefix: "bad\r\n".into(),
		});
		assert_eq!(placement.validate(), Err(AuthSpecError::InvalidHeaderPrefix));
	}

	#[test]
	fn clientless_custom_spec_validation_matches_exchange_requirements() {
		// The catalog's shared OpenCode console spec carries an empty client id
		// and token endpoint: api-key paste performs no token exchange, so only
		// that exchange may omit both fields. OpenRouter is also clientless,
		// but still requires its PKCE key-provisioning endpoint.
		let spec = |exchange| {
			AuthSpec::OAuthCustom(OAuthCustomSpec {
				client: OAuthClientSpec {
					sources:      vec![CredentialSourceSpec::Interactive],
					client_id:    "".into(),
					refresh:      OAuthRefreshSpec::Unsupported,
					token_url:    "".into(),
					scopes:       Vec::new(),
					audience:     None,
					token_params: Vec::new(),
					placement:    HeaderPlacement::bearer().into(),
				},
				authorize_url: "https://opencode.ai/auth".into(),
				exchange,
				parameters: Vec::new(),
				polling: None,
			})
		};
		assert_eq!(spec(OAuthExchangeKind::ApiKeyPaste).validate(), Ok(()));
		let mut openrouter = spec(OAuthExchangeKind::OpenRouterApiKey);
		let AuthSpec::OAuthCustom(openrouter) = &mut openrouter else {
			unreachable!("constructed custom spec")
		};
		openrouter.client.token_url = "https://openrouter.ai/api/v1/auth/keys".into();
		assert_eq!(openrouter.validate(), Ok(()));
		assert_eq!(
			spec(OAuthExchangeKind::PerplexityEmailOtp).validate(),
			Err(AuthSpecError::EmptyField("OAuth client id"))
		);
	}

	#[test]
	fn environment_sources_require_only_the_first_name_to_be_omp_prefixed() {
		let invalid =
			[CredentialSourceSpec::Environment { variables: vec!["ANTHROPIC_API_KEY".into()] }];
		assert_eq!(validate_sources(&invalid), Err(AuthSpecError::InvalidEnvironmentSource));

		let valid = [CredentialSourceSpec::Environment {
			variables: vec!["OMP_ANTHROPIC_API_KEY".into(), "ANTHROPIC_API_KEY".into()],
		}];
		assert_eq!(validate_sources(&valid), Ok(()));
	}

	#[test]
	fn catalog_devin_session_preserves_explicit_source_and_body_placement() {
		let catalog = {
			use omp_catalog::provider::{AccountScope, AuthSpecKind, CredentialSourceSpec};
			omp_catalog::provider::AuthSpec {
				id:                 omp_catalog::AuthSpecId::new("devin-auth"),
				kind:               AuthSpecKind::OmpSession,
				header_name:        None,
				query_parameter:    None,
				prefix:             None,
				sealed_body:        Some(SealedBodyPlacement::DevinMetadata),
				scopes:             Box::new([]),
				audience:           None,
				account_scope:      AccountScope::Provider,
				credential_sources: Box::new([CredentialSourceSpec::Environment {
					ordered_names: Box::new(["OMP_DEVIN_API_KEY".into()]),
				}]),
				oauth:              None,
				signing:            None,
			}
		};
		let source =
			CredentialSourceSpec::Environment { variables: vec!["OMP_DEVIN_API_KEY".into()] };
		assert_eq!(
			AuthSpec::from_catalog(&catalog, None, None).expect("catalog auth"),
			AuthSpec::SessionToken(SessionTokenSpec {
				sources:   vec![source],
				placement: KeyPlacement::Body(BodyPlacement::DevinMetadata),
			})
		);
	}
}
