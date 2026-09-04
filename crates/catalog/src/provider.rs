//! Provider, route, endpoint, authentication, and discovery records.

use std::time::Duration;

use omp_core::Str;
use serde::{Deserialize, Serialize};
use smallvec::SmallVec;
use strum::{Display, EnumString, IntoStaticStr};

use crate::{
	capability::{OperationBits, OperationKind},
	discover::DiscoveryDefaults,
	id::{
		AuthSpecId, CodecId, DiscoverySpecId, HeaderProfileId, ModelKey, OAuthSpecId, ProviderId,
		RouteId, WirePolicyId,
	},
};

/// Transport used to exchange encoded requests and responses.
#[derive(
	Clone,
	Copy,
	Debug,
	Display,
	EnumString,
	Eq,
	Hash,
	IntoStaticStr,
	PartialEq,
	Serialize,
	Deserialize,
)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case", ascii_case_insensitive)]
pub enum TransportKind {
	/// HTTP request and response streaming.
	Http,
	/// Bidirectional WebSocket transport.
	Websocket,
	/// Bidirectional WebRTC transport.
	Webrtc,
	/// AWS event-stream framing over HTTP.
	AwsEventStream,
	/// Connect protocol framing.
	Connect,
	/// In-process local execution.
	Local,
}

/// Typed codec-construction discriminator independent of provider identity.
#[derive(
	Clone,
	Copy,
	Debug,
	Default,
	Display,
	EnumString,
	Eq,
	Hash,
	IntoStaticStr,
	PartialEq,
	Serialize,
	Deserialize,
)]
#[serde(rename_all = "kebab-case")]
#[strum(serialize_all = "kebab-case", ascii_case_insensitive)]
pub enum CodecProfile {
	/// Conventional constructor for the selected codec.
	#[default]
	Standard,
	/// Google Cloud Code Assist contract used by Gemini CLI.
	GoogleCcaGeminiCli,
	/// Google Cloud Code Assist contract used by Antigravity.
	GoogleCcaAntigravity,
	/// Apple Foundation Models local runtime.
	AppleFm,
}

/// Authentication protocol represented by an [`AuthSpec`].
#[derive(
	Clone,
	Copy,
	Debug,
	Display,
	EnumString,
	Eq,
	Hash,
	IntoStaticStr,
	PartialEq,
	Serialize,
	Deserialize,
)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case", ascii_case_insensitive)]
pub enum AuthSpecKind {
	/// No credentials are required.
	None,
	/// Static API key authentication.
	ApiKey,
	/// RFC 7617 username and password authentication.
	Basic,
	/// Bearer token authentication.
	Bearer,
	/// Bearer token authentication that permits anonymous requests when no
	/// credential is available.
	OptionalBearer,
	/// OAuth authorization and refresh.
	Oauth,
	/// AWS Signature Version 4.
	AwsSigv4,
	/// Google application-default credentials.
	GcpAdc,
	/// Microsoft Entra ID credentials.
	AzureAd,
	/// GitHub application credentials.
	GithubApp,
	/// OMP-managed session credentials.
	OmpSession,
}

/// Scope at which one authenticated principal and its quota are shared.
#[derive(
	Clone,
	Copy,
	Debug,
	Display,
	EnumString,
	Eq,
	Hash,
	IntoStaticStr,
	PartialEq,
	Serialize,
	Deserialize,
)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case", ascii_case_insensitive)]
pub enum AccountScope {
	/// Credentials are shared across the whole provider.
	Provider,
	/// Credentials are isolated to one route.
	Route,
	/// Credentials are isolated by endpoint region.
	Region,
}

/// Typed credential-bearing body placement compiled from provider source.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SealedBodyPlacement {
	/// Devin protobuf request metadata.
	DevinMetadata,
}
/// One source in an application-default credential chain.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApplicationDefaultSource {
	/// Reads a short-lived access token from one environment variable.
	EnvironmentAccessToken {
		/// Environment variable name.
		variable: Str,
	},
	/// Reads a public credential document path.
	CredentialFile {
		/// Optional environment variable overriding the credential path.
		path_environment: Option<Str>,
		/// Optional default credential path.
		default_path:     Option<Str>,
	},
	/// Requests a standard token response from a workload metadata endpoint.
	Metadata {
		/// Public metadata endpoint URL.
		url:     Str,
		/// Non-secret metadata request headers.
		headers: Box<[StaticHeader]>,
	},
}

/// Public credential acquisition source.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CredentialSourceSpec {
	/// Reads the first populated environment variable from an ordered list.
	Environment {
		/// Environment variable names in exact lookup order.
		ordered_names: Box<[Str]>,
	},
	/// Reads an RFC 7617 username and password from independent environment
	/// lookup orders.
	BasicEnvironment {
		/// Username environment variable names in exact lookup order.
		username_names: Box<[Str]>,
		/// Password environment variable names in exact lookup order.
		password_names: Box<[Str]>,
	},
	/// Reads an encrypted credential from the account store.
	Stored,
	/// Resolves application-default credentials from declared environment
	/// inputs.
	ApplicationDefault {
		/// API key or access-token environment variables in lookup order.
		api_key_env:  Box<[Str]>,
		/// Project environment variables in lookup order.
		project_env:  Box<[Str]>,
		/// Location environment variables in lookup order.
		location_env: Box<[Str]>,
		/// Complete application-default sources in exact acquisition order.
		sources:      Box<[ApplicationDefaultSource]>,
	},
	/// Resolves the standard AWS credential chain.
	AwsChain,
	/// Runs an interned public OAuth flow.
	Oauth {
		/// OAuth flow specification identifier.
		flow: OAuthSpecId,
	},
	/// Acquires an interactive provider session credential.
	Session,
}

/// Source of the AWS region used for Signature Version 4.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RegionSource {
	/// Uses the selected route endpoint's normalized region.
	RouteEndpoint,
	/// Uses one fixed catalog region.
	Fixed {
		/// Fixed AWS region.
		region: Str,
	},
	/// Reads the first populated environment variable from an ordered list.
	Environment {
		/// Region environment variables in exact lookup order.
		ordered_names: Box<[Str]>,
	},
}

/// Exact AWS Signature Version 4 signing contract.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct SigV4Spec {
	/// AWS signing service.
	pub service: Str,
	/// Typed source of the AWS signing region.
	pub region:  RegionSource,
}

/// Placement of a resolved OAuth access token.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OAuthTokenPlacement {
	/// Places the token in a sensitive request header.
	Header {
		/// Header name.
		name:   Str,
		/// Prefix inserted before the token.
		prefix: Str,
	},
	/// Places the token in a sensitive query parameter at final dispatch.
	Query {
		/// Query parameter name.
		parameter: Str,
	},
	/// Binds the token into a typed sealed request body.
	SealedBody {
		/// Typed body field selected by the codec.
		placement: SealedBodyPlacement,
	},
}

/// Non-secret OAuth form or query parameter.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct OAuthParameter {
	/// Parameter name.
	pub name:  Str,
	/// Public parameter value.
	pub value: Str,
}

/// Completion mechanism for an OAuth authorization-code flow.
#[derive(
	Clone,
	Copy,
	Debug,
	Display,
	EnumString,
	Eq,
	Hash,
	IntoStaticStr,
	PartialEq,
	Serialize,
	Deserialize,
)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case", ascii_case_insensitive)]
pub enum OAuthCompletion {
	/// Receives a loopback callback URL and validates its state.
	CallbackUrl,
	/// Accepts a pasted callback URL and validates its state.
	PasteCallbackUrl,
	/// Accepts a raw authorization code.
	PasteCode,
}

/// Typed custom OAuth exchange engine selected without provider-name policy.
#[derive(
	Clone,
	Copy,
	Debug,
	Display,
	EnumString,
	Eq,
	Hash,
	IntoStaticStr,
	PartialEq,
	Serialize,
	Deserialize,
)]
#[serde(rename_all = "kebab-case")]
#[strum(serialize_all = "kebab-case", ascii_case_insensitive)]
pub enum OAuthExchangeKind {
	/// Extracts account claims from the `OpenAI` Codex token response.
	OpenAiCodexClaims,
	/// Completes Anthropic's JSON PKCE token exchange.
	AnthropicPkce,
	/// Exchanges a GitHub device token for a Copilot session token.
	GithubCopilotSessionToken,
	/// Completes PKCE through an external application redirect.
	ExternalRedirectPkce,
	/// Polls Cursor's public login exchange endpoint.
	CursorPoll,
	/// Completes Google Antigravity PKCE and Cloud Code Assist provisioning.
	GoogleAntigravity,
	/// Completes Gemini CLI PKCE and Cloud Code Assist project discovery.
	GoogleGeminiCli,
	/// Exchanges a Z.AI authorization result for an API key.
	ZaiApiKey,
	/// Exchanges an `OpenRouter` PKCE authorization result for a durable API
	/// key.
	OpenRouterApiKey,
	/// Exchanges a Devin CLI authorization result for a token.
	DevinCliToken,
	/// Completes Perplexity's email one-time-password flow.
	PerplexityEmailOtp,
	/// Collects an API key through an interactive paste flow.
	ApiKeyPaste,
}

/// OAuth device polling bounds.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct OAuthPollingSpec {
	/// Optional catalog safety bound on token polling attempts.
	/// Provider-reported expiry remains authoritative when this bound is
	/// absent.
	pub maximum_polls:       Option<u16>,
	/// Default polling interval in milliseconds.
	pub default_interval_ms: u64,
	/// Largest accepted or slowed-down interval in milliseconds.
	pub maximum_interval_ms: u64,
}

/// Flow-specific public OAuth endpoints and completion behavior.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OAuthFlowSpec {
	/// Authorization-code flow with S256 PKCE.
	Pkce {
		/// Browser authorization endpoint.
		authorize_url:        Str,
		/// Exact registered redirect URI.
		redirect_uri:         Str,
		/// How the authorization result reaches the runtime.
		completion:           OAuthCompletion,
		/// Additional public authorization query parameters.
		authorize_parameters: Box<[OAuthParameter]>,
	},
	/// RFC 8628 device authorization flow.
	DeviceCode {
		/// Device authorization endpoint.
		device_authorization_url: Str,
		/// Typed token polling bounds.
		polling:                  OAuthPollingSpec,
	},
	/// Browser-assisted exchange completed by pasted input.
	Paste {
		/// Public page the caller opens.
		authorization_url: Str,
		/// Stable non-secret prompt shown to the caller.
		prompt:            Str,
	},
	/// Provider protocol that requires a distinct typed exchange engine.
	Custom {
		/// Public authorization or login endpoint.
		authorize_url: Str,
		/// Exchange engine selected independently of provider identity.
		exchange:      OAuthExchangeKind,
		/// Additional public flow parameters.
		parameters:    Box<[OAuthParameter]>,
		/// Optional polling bounds for asynchronous exchanges.
		polling:       Option<OAuthPollingSpec>,
	},
}

/// Refresh-token behavior for an OAuth flow.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OAuthRefreshBehavior {
	/// The flow cannot refresh credentials.
	Unsupported,
	/// Refreshes through the standard token endpoint.
	TokenEndpoint,
	/// Refreshes through a distinct public endpoint.
	Endpoint {
		/// Public refresh endpoint.
		url:        Str,
		/// Additional non-secret refresh parameters.
		parameters: Box<[OAuthParameter]>,
	},
}

/// Evidence used to bind refreshed credentials to a stable principal.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrincipalResolution {
	/// Reads the principal from a verified ID-token claim.
	IdTokenClaim {
		/// Top-level claim name or RFC 6901 JSON Pointer.
		claim: Str,
	},
	/// Reads the first present stable principal claim from the access-token JWT.
	AccessTokenClaims {
		/// Ordered top-level claim names or RFC 6901 JSON Pointers.
		claims: Box<[Str]>,
	},
	/// Reads the principal from a typed token-response field.
	TokenResponseField {
		/// JSON Pointer into the known token response schema.
		pointer: Str,
	},
	/// Fetches public principal metadata after token exchange.
	UserinfoEndpoint {
		/// Public user-information endpoint.
		url:   Str,
		/// Field carrying the stable principal identifier.
		field: Str,
	},
	/// Uses a reviewed static principal label.
	StaticLabel {
		/// Stable non-secret label.
		label: Str,
	},
}

/// Interned public OAuth flow data with no credential secrets.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct OAuthSpec {
	/// Stable content-derived OAuth specification identifier.
	pub id:                   OAuthSpecId,
	/// Public installed-application client identifier.
	pub client_id:            Str,
	/// Token exchange endpoint.
	pub token_url:            Str,
	/// Ordered requested scopes.
	pub scopes:               Box<[Str]>,
	/// Optional resource audience.
	pub audience:             Option<Str>,
	/// Placement of the resulting access token.
	pub placement:            OAuthTokenPlacement,
	/// Additional public token exchange parameters.
	pub token_parameters:     Box<[OAuthParameter]>,
	/// Flow-specific endpoints and completion behavior.
	pub flow:                 OAuthFlowSpec,
	/// Refresh-token behavior.
	pub refresh:              OAuthRefreshBehavior,
	/// Typed evidence for stable principal identity across token refreshes.
	pub principal_resolution: Option<PrincipalResolution>,
}

/// Interned authentication requirements without credential values.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct AuthSpec {
	/// Stable content-derived authentication specification identifier.
	pub id:                 AuthSpecId,
	/// Credential protocol.
	pub kind:               AuthSpecKind,
	/// Header receiving the credential, when header placement is used.
	pub header_name:        Option<Str>,
	/// Query parameter receiving the credential, when query placement is used.
	pub query_parameter:    Option<Str>,
	/// Prefix placed before a credential value.
	pub prefix:             Option<Str>,
	/// Typed sealed-body placement, mutually exclusive with header and query.
	#[serde(default)]
	pub sealed_body:        Option<SealedBodyPlacement>,
	/// OAuth or identity-provider scopes.
	pub scopes:             Box<[Str]>,
	/// Optional token audience.
	pub audience:           Option<Str>,
	/// Principal and quota sharing boundary.
	pub account_scope:      AccountScope,
	/// Credential sources in exact acquisition order.
	pub credential_sources: Box<[CredentialSourceSpec]>,
	/// Direct link to the OAuth flow when this authentication spec uses OAuth.
	pub oauth:              Option<OAuthSpecId>,
	/// Exact signing contract for request-signing authentication.
	pub signing:            Option<SigV4Spec>,
}

/// Concrete endpoint configuration with optional region identity.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct EndpointSpec {
	/// Base endpoint URL, possibly containing compiler-validated placeholders.
	pub base_url:    Str,
	/// Stable region name used for routing and account scope.
	pub region:      Option<Str>,
	/// Required provider API version appended at final URL construction.
	#[serde(default)]
	pub api_version: Option<Str>,
}

/// Redirect behavior at an endpoint trust boundary.
#[derive(
	Clone,
	Copy,
	Debug,
	Display,
	EnumString,
	Eq,
	Hash,
	IntoStaticStr,
	PartialEq,
	Serialize,
	Deserialize,
)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case", ascii_case_insensitive)]
pub enum RedirectTrust {
	/// Redirects are rejected.
	Deny,
	/// Redirects within the original origin are accepted.
	SameOrigin,
	/// Cross-origin redirects are accepted without forwarding credentials.
	PublicOnly,
}

/// Endpoint origin and credential-forwarding trust boundary.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct TrustDomain {
	/// Canonical trusted origin.
	pub origin:          Str,
	/// Redirect policy for this origin.
	pub redirects:       RedirectTrust,
	/// Whether explicitly configured plaintext HTTP is permitted.
	pub allow_plaintext: bool,
}

/// One static non-secret request header.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct StaticHeader {
	/// Header name validated by the catalog compiler.
	pub name:  Str,
	/// Header value containing no credentials.
	pub value: Str,
}

/// Interned ordered static header set.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct HeaderProfile {
	/// Stable content-derived header profile identifier.
	pub id:      HeaderProfileId,
	/// Usually-small headers copied into each encoded request.
	pub headers: SmallVec<StaticHeader, 4>,
}

/// Remote model-list schema family.
#[derive(
	Clone,
	Copy,
	Debug,
	Display,
	EnumString,
	Eq,
	Hash,
	IntoStaticStr,
	PartialEq,
	Serialize,
	Deserialize,
)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case", ascii_case_insensitive)]
pub enum DiscoveryKind {
	/// OpenAI-compatible model listing.
	OpenAiModels,
	/// Google model listing.
	GoogleModels,
	/// Ollama tags listing.
	OllamaTags,
	/// Account-scoped model listing.
	AccountModels,
	/// Codec-owned specialized listing.
	Specialized,
}

/// Pagination strategy for remote model discovery.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiscoveryPagination {
	/// A single response contains the complete list.
	SinglePage,
	/// A response cursor is passed in a query parameter.
	Cursor {
		/// Query parameter carrying the next cursor.
		query_parameter: Str,
	},
	/// A numeric page is passed in a query parameter.
	PageNumber {
		/// Query parameter carrying the page number.
		query_parameter: Str,
		/// First page number.
		first_page:      u32,
	},
}

/// Interned remote model-discovery specification.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct DiscoverySpec {
	/// Stable content-derived discovery specification identifier.
	pub id:            DiscoverySpecId,
	/// Typed discovery response family.
	pub kind:          DiscoveryKind,
	/// Human-readable discovery source label.
	pub label:         Str,
	/// Endpoint-relative discovery path.
	pub path:          Str,
	/// Pagination strategy.
	pub pagination:    DiscoveryPagination,
	/// Whether absence from a successful listing proves unavailability.
	pub authoritative: bool,
	/// Requested periodic poll interval. Runtime scheduling never polls more
	/// frequently than five seconds.
	#[serde(default)]
	pub interval:      Option<Duration>,
}

impl DiscoverySpec {
	/// Returns the periodic polling interval after applying the five-second
	/// floor required for background discovery.
	pub fn polling_interval(&self) -> Option<Duration> {
		self
			.interval
			.map(|interval| interval.max(Duration::from_secs(5)))
	}
}

/// Provider registry relationship for declarative aliases and replacements.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RegistryMapping {
	/// A directly usable provider.
	Concrete,
	/// Another provider ID names the same provider domain.
	Alias {
		/// Canonical provider target.
		target: ProviderId,
		/// Human-auditable catalog rationale.
		reason: Str,
	},
	/// Another inference component supplies this provider behavior.
	Replacement {
		/// Stable component name.
		component: Str,
		/// Human-auditable catalog rationale.
		reason:    Str,
	},
}

/// Provider-level management operations and account behavior.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ManagementCapabilities {
	/// Management operations exposed by the provider.
	pub operations:        OperationBits,
	/// Whether several stored principals may be selected or rotated.
	pub multiple_accounts: bool,
	/// Whether credentials can be refreshed without changing principal.
	pub refresh:           bool,
	/// Whether quota observations are scoped to individual principals.
	pub principal_quota:   bool,
}

impl ManagementCapabilities {
	/// Reports whether a management operation is exposed.
	pub const fn supports(self, operation: OperationKind) -> bool {
		self.operations.contains_kind(operation)
	}
}

/// Declarative commercial, account, and quota domain.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ProviderDef {
	/// Stable provider identifier.
	pub id:                 ProviderId,
	/// Human-readable provider name.
	pub name:               Str,
	/// Provider-recommended default model selector.
	pub default_model:      Option<ModelKey>,
	/// Eligible authentication specifications in preference order.
	pub auth:               Box<[AuthSpecId]>,
	/// Provider account and management capabilities.
	pub management:         ManagementCapabilities,
	/// Provider-owned route identifiers in deterministic order.
	pub routes:             Box<[RouteId]>,
	/// Provider-default lowering policy for model-less management operations.
	pub wire_policy:        WirePolicyId,
	/// Authored defaults for conservative runtime model discovery.
	pub discovery_defaults: Option<DiscoveryDefaults>,
	/// Registry relationship used during deterministic normalization.
	pub mapping:            RegistryMapping,
}

/// Route-level restrictions applied after model capabilities.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct RouteRestrictions {
	/// Optional allowlist of operations; `None` leaves model operations
	/// unchanged.
	pub operations:             Option<OperationBits>,
	/// Route-specific context token ceiling.
	pub maximum_context_tokens: Option<u64>,
	/// Route-specific output token ceiling.
	pub maximum_output_tokens:  Option<u64>,
	/// Whether server-side conversation state is disabled on this route.
	pub disable_server_state:   bool,
	/// Whether prompt caching is disabled on this route.
	pub disable_prompt_caching: bool,
	/// Whether strict tool schemas are disabled on this route.
	pub disable_strict_tools:   bool,
}

/// Codex-family connection preference captured as route data.
#[derive(
	Clone,
	Copy,
	Debug,
	Display,
	EnumString,
	Eq,
	Hash,
	IntoStaticStr,
	PartialEq,
	Serialize,
	Deserialize,
)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case", ascii_case_insensitive)]
pub enum CodexTransportPreference {
	/// Use HTTP only.
	HttpOnly,
	/// Prefer WebSocket and fall back to HTTP.
	WebsocketPreferred,
}

/// Concrete endpoint, codec, authentication, and trust configuration.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct RouteDef {
	/// Stable route identifier.
	pub id:                 RouteId,
	/// Owning commercial or local provider domain.
	pub provider:           ProviderId,
	/// Typed codec-construction profile.
	pub codec_profile:      CodecProfile,
	/// Wire codec used by this route.
	pub codec:              CodecId,
	/// Network or local transport used by the codec.
	pub transport:          TransportKind,
	/// Concrete endpoint and region.
	pub endpoint:           EndpointSpec,
	/// Authentication requirements.
	pub auth:               AuthSpecId,
	/// Static safe request headers.
	pub headers:            HeaderProfileId,
	/// Optional model discovery specification.
	pub discovery:          Option<DiscoverySpecId>,
	/// Restrictions layered over model capabilities.
	pub capability_limits:  RouteRestrictions,
	/// Credential-forwarding and redirect boundary.
	pub trust_domain:       TrustDomain,
	/// Protocol-specific Codex connection preference.
	pub codex_transport:    CodexTransportPreference,
	/// Whether the reduced Responses schema is selected.
	pub use_responses_lite: Option<bool>,
	/// Route priority, where larger values are preferred.
	pub priority:           Option<u32>,
}
