//! Canonical production construction for catalog-backed provider routes.

use std::{
	array,
	collections::BTreeMap,
	future::{Future, Ready, ready},
	mem,
	num::NonZeroU32,
	pin::Pin,
	sync::Arc,
	task::{Context, Poll},
	time::{Duration, Instant, SystemTime},
};

use futures::StreamExt as _;
use http::{HeaderName, HeaderValue};
use omp_catalog::{
	NativeToolChoicePenalty, OperationBits, OperationKind, ToolFeatureBits, WireModelId,
	provider::{AuthSpecKind, CodecProfile, DiscoveryKind, RouteDef, TransportKind},
	snapshot::Catalog,
};
use omp_core::{ExposeSecret as _, Str, sf};
use serde_json::{Map as JsonMap, Value as JsonValue, json};
use tower::{Service, ServiceExt as _, util::BoxCloneSyncService};
use url::Url;

use crate::{
	ProviderId,
	account::{
		AccountPool, AccountSelection, AccountSelectionRequest, PinFailure, RateAvailability,
		RotationPolicy,
	},
	auth::{
		AuthManager, AuthScheme, AwsCredentialError, AwsRegistryAvailability, CredentialApplyError,
		CredentialBroker, CredentialError, CredentialKind, CredentialLease, CredentialNeed,
		CredentialShaperRegistry, CredentialSource, LeaseOrigin, OAuthHttpClient, OAuthHttpRequest,
		ProviderShaper, broker::INVOCATION_TAG, sigv4::endpoint_scope, spec::AuthSpec,
	},
	body::BodySource,
	call::{
		AccountRoutingContext, Call, NativeResponseFraming, OperationCall, Setting, StructuredOutput,
		Target, ToolChoice,
	},
	catalog::{AuthSpecId, RouteId},
	codec::{
		BeforeRequestDenied, BeforeRequestDraft, BeforeRequestMutation, Cancellation, Codec,
		DecodeContext, DecoderState, EncodeAttempt, EncodeContext, EncodedRequest,
		HandshakenResponse, NativeResponseFormat, ProviderStateEvent, RawEvent,
		RealtimeWireCodecState, RequestHeader, TransportAttempt, TransportRequest,
		anthropic::AnthropicCodec,
		bedrock::{
			BedrockConverseCodec, BedrockGuardrail, BedrockOptions, guardrail_arn_region,
			sanitize_request_metadata_value,
		},
		bedrock_mantle::{
			BedrockMantleCodec, BedrockMantleDiscoveryCodec,
			expand_endpoint as expand_mantle_endpoint,
			map_auth_rejection as map_mantle_auth_rejection,
		},
		cursor::CursorCodec,
		devin::DevinCodec,
		discovery::{
			AccountModelsDiscoveryCodec, GoogleModelsDiscoveryCodec, OllamaTagsDiscoveryCodec,
			OpenAiModelsDiscoveryCodec,
		},
		gemini::GeminiCodec,
		gitlab::{
			GitLabWorkflowCodec, WorkflowCreationDecoder, bind_created_workflow,
			bind_workflow_decoder, workflow_creation_request,
		},
		glyph,
		google_cca::{
			ANTIGRAVITY_VERSION_MANIFEST_URL, AntigravityPolicy, CcaHeaders, GoogleCcaCodec,
			parse_antigravity_manifest_version,
		},
		ollama::OllamaCodec,
		openai::OpenAiCodec,
		openai_chat,
		openai_codex::OpenAiCodexCodec,
		openai_embedding::OpenAiEmbeddingCodec,
		openai_responses::{OpenAiResponsesCodec, OpenAiResponsesOptions},
		search_brave::BraveSearchCodec,
		search_duckduckgo::DuckduckgoSearchCodec,
		search_ecosia::EcosiaSearchCodec,
		search_exa::ExaSearchCodec,
		search_firecrawl::FirecrawlSearchCodec,
		search_google::GoogleSearchCodec,
		search_hosted::{KimiSearchCodec, SyntheticSearchCodec, ZaiSearchCodec},
		search_jina::JinaSearchCodec,
		search_kagi::KagiSearchCodec,
		search_mojeek::MojeekSearchCodec,
		search_parallel::ParallelSearchCodec,
		search_perplexity::PerplexitySearchCodec,
		search_searxng::SearxngSearchCodec,
		search_startpage::StartpageSearchCodec,
		search_tavily::TavilySearchCodec,
		search_tinyfish::TinyfishSearchCodec,
	},
	error::{
		CredentialFailure, Error, ErrorDetail, ErrorKind, ErrorPhase, KindMismatchRemedy, RetryAction,
	},
	gate::GateCondition,
	layer::{
		AttemptAction, ExecutionContext,
		account::{AccountPoolLayer, AccountSelector},
		admission::{AdmissionController, AdmissionLayer},
		auth::{AuthLeaseLayer, LeaseProvider},
		encode::{AttemptEncoder, CredentialApplier, CredentialApplyLayer, EncodeLayer},
		hook::ProviderErrorLayer,
		intent::{IntentLayer, IntentPlanner},
		operation::{EmbeddingRoutePolicy, OperationPolicyConfig, OperationPolicyLayer},
		rate::{RateLayer, RateLimiter},
		recover::{DiscoveryProjector, RecoveryLayer},
		retry::TransportRetryLayer,
		semantic::{SemanticLayer, SemanticPolicy},
		session::SessionLayer,
		stack::{RouteComposer, RouteProviderService, RouteStackLayers, build_route_stack},
	},
	operation::{
		discovery::CatalogDiscoveryProjector,
		embedding::NormalizationSupport,
		parallel_extract::ParallelExtractCodec,
		usage::{ConsoleUsageManager, UsageServiceConfig},
	},
	plan::{ForcedCallCaps, apply_forced_call_decision, forced_call_ladder},
	receipt::{Adjustment, ExecutionReceipt, FeatureId, Penalty, ReasonId},
	registry::RouteUnavailable,
	session::ConversationSessionPlanner,
	settings::InferenceSettings,
	transport::{
		global_provider_capture, http::HttpTransport, websocket_transport::WebSocketTransport,
	},
};

/// Validated endpoint coordinates for Azure `OpenAI` routes.
#[derive(Clone, Debug)]
pub struct AzureEndpointConfig {
	/// Absolute Azure resource base, for example `https://example.openai.azure.com`.
	pub resource_base:      Str,
	/// Default deployment used when no model-specific mapping exists.
	pub default_deployment: Option<Str>,
	/// Deployment name keyed by provider wire-model id.
	pub deployments:        Arc<BTreeMap<Str, Str>>,
	/// Optional API version overriding the catalog route version.
	pub api_version:        Option<Str>,
}

impl AzureEndpointConfig {
	/// Validates and constructs Azure endpoint coordinates.
	pub fn new(
		resource_base: impl Into<Str>,
		default_deployment: Option<Str>,
		deployments: Arc<BTreeMap<Str, Str>>,
		api_version: Option<Str>,
	) -> Result<Self, &'static str> {
		let resource_base = resource_base.into();
		let url = Url::parse(resource_base.as_str()).map_err(|_| "azure-resource-base-invalid")?;
		if url.scheme() != "https"
			|| url.host_str().is_none()
			|| !url.username().is_empty()
			|| url.password().is_some()
			|| url.query().is_some()
			|| url.fragment().is_some()
		{
			return Err("azure-resource-base-invalid");
		}
		if default_deployment
			.iter()
			.chain(deployments.values())
			.any(|deployment| {
				deployment.trim().is_empty()
					|| deployment.contains('/')
					|| deployment.contains('?')
					|| deployment.contains('#')
			}) {
			return Err("azure-deployment-invalid");
		}
		Ok(Self { resource_base, default_deployment, deployments, api_version })
	}

	fn deployment_for(&self, wire_model: &str) -> Option<&Str> {
		self
			.deployments
			.get(wire_model)
			.or(self.default_deployment.as_ref())
	}
}

/// Provider id whose base URL carries account and gateway coordinates.
const CLOUDFLARE_GATEWAY_PROVIDER: &str = "cloudflare-ai-gateway";

/// Validated account and gateway coordinates for Cloudflare AI Gateway routes.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CloudflareGatewayConfig {
	account: Str,
	gateway: Str,
}

impl CloudflareGatewayConfig {
	/// Validates and constructs the coordinates. Each must be non-empty ASCII
	/// alphanumeric or `-`, so neither can alter the URL path or authority.
	pub fn new(account: impl Into<Str>, gateway: impl Into<Str>) -> Result<Self, &'static str> {
		let account = account.into();
		let gateway = gateway.into();
		if !cloudflare_coordinate_is_valid(account.as_str()) {
			return Err("cloudflare-account-invalid");
		}
		if !cloudflare_coordinate_is_valid(gateway.as_str()) {
			return Err("cloudflare-gateway-invalid");
		}
		Ok(Self { account, gateway })
	}
}

fn cloudflare_coordinate_is_valid(value: &str) -> bool {
	!value.is_empty()
		&& value
			.chars()
			.all(|character| character.is_ascii_alphanumeric() || character == '-')
}

/// Explicit route construction settings for the two Cloud Code Assist clients.
#[derive(Clone)]
pub struct GoogleCcaConfig {
	/// Platform coordinate used in Gemini CLI's public model-bearing
	/// fingerprint.
	pub gemini_cli_platform: Str,
	/// Architecture coordinate used in Gemini CLI's public model-bearing
	/// fingerprint.
	pub gemini_cli_arch:     Str,
	/// Public Antigravity fingerprint supplied by application policy.
	pub antigravity_headers: CcaHeaders,
	/// Typed Antigravity lowering policy.
	pub antigravity_policy:  AntigravityPolicy,
}

/// Fetches the latest Antigravity client version from the official update
/// manifest.
///
/// Returns `None` on any transport, status, or parse failure; callers keep
/// the pinned [`DEFAULT_ANTIGRAVITY_VERSION`] fallback valid. The request
/// mimics `electron-builder`'s update probe so the endpoint serves the same
/// manifest the real client sees.
///
/// [`DEFAULT_ANTIGRAVITY_VERSION`]: crate::codec::google_cca::DEFAULT_ANTIGRAVITY_VERSION
pub async fn discover_antigravity_version(client: &dyn OAuthHttpClient) -> Option<Str> {
	let mut headers = http::HeaderMap::new();
	headers.insert(http::header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
	headers.insert(http::header::USER_AGENT, HeaderValue::from_static("electron-builder"));
	let request =
		OAuthHttpRequest::new(http::Method::GET, ANTIGRAVITY_VERSION_MANIFEST_URL, headers, None)
			.ok()?;
	let response = client.execute(request).await.ok()?;
	if response.status != 200 {
		return None;
	}
	parse_antigravity_manifest_version(response.body.expose_secret())
}

/// Resolved non-secret signing regions supplied by the application.
#[derive(Clone)]
pub struct AuthApplicationConfig {
	/// Resolved environment/endpoint signing region keyed by route.
	pub signing_regions: Arc<BTreeMap<omp_catalog::RouteId, Str>>,
}

impl AuthApplicationConfig {
	/// Binds one resolved AWS region to every catalog route whose endpoint is
	/// explicitly regional.
	pub fn for_catalog(catalog: &Catalog, region: Str) -> Self {
		let signing_regions = catalog
			.routes()
			.iter()
			.filter(|route| route.endpoint.base_url.contains("{region}"))
			.map(|route| (route.id.clone(), region.clone()))
			.collect();
		Self { signing_regions: Arc::new(signing_regions) }
	}
}

type WireService = BoxCloneSyncService<TransportRequest, HandshakenResponse, Error>;

#[derive(Clone)]
struct ProtocolTransport {
	http:      HttpTransport,
	websocket: WebSocketTransport,
}

impl Service<TransportRequest> for ProtocolTransport {
	type Error = Error;
	type Future =
		Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send + 'static>>;
	type Response = HandshakenResponse;

	fn poll_ready(&mut self, _context: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
		Poll::Ready(Ok(()))
	}

	fn call(&mut self, mut request: TransportRequest) -> Self::Future {
		let mut http = self.http.clone();
		let mut websocket = self.websocket.clone();
		Box::pin(async move {
			let started = Instant::now();
			if request.encoded.framing != crate::transport::FramingProtocol::WebSocket {
				return http.ready().await?.call(request).await;
			}
			if request.attempt.provider.as_str() == "gitlab-duo-agent"
				&& let BodySource::Bytes(start_body) = &request.encoded.body
			{
				let creation = workflow_creation_request(&request.encoded.uri, start_body)?;
				let creation_request = TransportRequest {
					encoded:        creation,
					credentials:    request.credentials.clone(),
					signature:      request.signature.clone(),
					decoder:        Some(Box::new(WorkflowCreationDecoder::new())),
					realtime:       None,
					cancel:         request.cancel.clone(),
					response_hooks: request.response_hooks.clone(),
					attempt:        request.attempt.clone(),
				};
				let mut response = http.ready().await?.call(creation_request).await?;
				let mut workflow_id = None;
				if let Some(events) = response.events.as_mut() {
					while let Some(event) = events.next().await {
						if let RawEvent::ProviderState(ProviderStateEvent::Checkpoint {
							id: Some(id),
							..
						}) = event?
						{
							workflow_id = Some(id);
							break;
						}
					}
				}
				let workflow_id = workflow_id.ok_or_else(|| {
					contract_error_for_attempt(&request.attempt, "gitlab-workflow-create-id-missing")
				})?;
				let bound_start = bind_created_workflow(start_body, &workflow_id)?;
				request.encoded.body = BodySource::Bytes(bound_start);
				let decoder = request.decoder.take().ok_or_else(|| {
					contract_error_for_attempt(&request.attempt, "gitlab-workflow-decoder-missing")
				})?;
				request.decoder = Some(bind_workflow_decoder(decoder, workflow_id));
			}
			request.attempt.timeout = request.attempt.timeout.saturating_sub(started.elapsed());
			if request.attempt.timeout.is_zero() {
				return Err(attempt_deadline_error(&request.attempt));
			}
			websocket.ready().await?.call(request).await
		})
	}
}

/// Feature-gated in-process backend inserted beneath the canonical fixed stack.
#[derive(Clone)]
pub struct LocalRouteBackend {
	codec:             Arc<dyn Codec>,
	wire:              WireService,
	framework_timeout: Duration,
}

impl LocalRouteBackend {
	/// Erases a concrete local codec and transport once at application
	/// construction.
	pub fn new<S>(codec: Arc<dyn Codec>, wire: S, framework_timeout: Duration) -> Self
	where
		S: Service<TransportRequest, Response = HandshakenResponse, Error = Error>
			+ Clone
			+ Send
			+ Sync
			+ 'static,
		S::Future: Send + 'static,
	{
		Self { codec, wire: WireService::new(wire), framework_timeout }
	}
}
/// Complete dependencies required to construct production catalog routes.
#[derive(Clone)]
pub struct ProductionDependencies {
	credentials:          CredentialBroker,
	auth_manager:         AuthManager,
	accounts:             AccountPool,
	sessions:             ConversationSessionPlanner,
	websocket:            WebSocketTransport,
	http:                 HttpTransport,
	admission:            AdmissionController,
	google_cca:           GoogleCcaConfig,
	transport_timeout:    Duration,
	auth_application:     AuthApplicationConfig,
	credential_shapers:   Arc<CredentialShaperRegistry>,
	azure_endpoint:       Option<AzureEndpointConfig>,
	cloudflare_gateway:   Option<CloudflareGatewayConfig>,
	usage_manager:        Option<ConsoleUsageManager>,
	settings:             InferenceSettings,
	provider_admission:   Arc<BTreeMap<ProviderId, AdmissionController>>,
	local_routes:         Arc<BTreeMap<RouteId, LocalRouteBackend>>,
	discovery_projectors: Arc<BTreeMap<RouteId, Arc<dyn DiscoveryProjector>>>,
	local_unavailable:    Arc<BTreeMap<RouteId, ReasonId>>,
	aws_registry:         Option<Result<AwsRegistryAvailability, AwsCredentialError>>,
}

impl ProductionDependencies {
	/// Returns the immutable settings snapshot shared by planning and every
	/// route stack.
	pub(crate) const fn settings(&self) -> &InferenceSettings {
		&self.settings
	}

	/// Installs validated Cloudflare AI Gateway coordinates.
	pub fn with_cloudflare_gateway(mut self, gateway: Option<CloudflareGatewayConfig>) -> Self {
		self.cloudflare_gateway = gateway;
		self
	}

	/// Installs validated Azure `OpenAI` endpoint coordinates.
	pub fn with_azure_endpoint(mut self, endpoint: Option<AzureEndpointConfig>) -> Self {
		self.azure_endpoint = endpoint;
		self
	}

	/// Creates production dependencies with explicit policy and shared state.
	pub fn new(
		credentials: CredentialBroker,
		auth_manager: AuthManager,
		accounts: AccountPool,
		sessions: ConversationSessionPlanner,
		websocket: WebSocketTransport,
		google_cca: GoogleCcaConfig,
		http: HttpTransport,
		auth_application: AuthApplicationConfig,
		admission: AdmissionController,
		transport_timeout: Duration,
		discovery_projectors: Arc<BTreeMap<RouteId, Arc<dyn DiscoveryProjector>>>,
		credential_shapers: Arc<CredentialShaperRegistry>,
	) -> Self {
		Self {
			credentials,
			auth_manager,
			accounts,
			sessions,
			websocket,
			http,
			admission,
			google_cca,
			auth_application,
			transport_timeout,
			credential_shapers,
			azure_endpoint: None,
			cloudflare_gateway: None,
			usage_manager: None,
			settings: InferenceSettings::default(),
			provider_admission: Arc::new(BTreeMap::new()),
			discovery_projectors,
			local_routes: Arc::new(BTreeMap::new()),
			local_unavailable: Arc::new(BTreeMap::new()),
			aws_registry: None,
		}
	}

	pub(crate) fn auth_manager(&self) -> AuthManager {
		self.auth_manager.clone()
	}

	pub(crate) fn usage_manager(&self) -> Option<ConsoleUsageManager> {
		self.usage_manager.clone()
	}

	/// Installs application-composed provider console usage backends.
	pub fn with_usage_manager(mut self, manager: ConsoleUsageManager) -> Self {
		self.usage_manager = Some(manager);
		self
	}

	/// Installs secret-free AWS source discovery used to gate AWS routes.
	///
	/// A failed probe is retained as typed construction evidence rather than
	/// silently treating the route as credential-free or leaking a source value.
	pub fn with_aws_registry_availability(
		mut self,
		availability: Result<AwsRegistryAvailability, AwsCredentialError>,
	) -> Self {
		self.aws_registry = Some(availability);
		self
	}

	/// Installs the immutable runtime settings projection used by every route
	/// stack.
	pub fn with_settings(mut self, settings: InferenceSettings) -> Self {
		self.provider_admission = Arc::new(
			settings
				.providers
				.max_in_flight
				.iter()
				.filter(|(_, limit)| **limit > 0)
				.map(|(provider, limit)| {
					(
						ProviderId::from(provider.clone()),
						AdmissionController::new(*limit, settings.providers.max_queued),
					)
				})
				.collect(),
		);
		self.settings = settings;
		self
	}

	/// Adds feature-gated local codec/transport pairs keyed by exact catalog
	/// route.
	pub fn with_local_routes(
		mut self,
		routes: impl IntoIterator<Item = (RouteId, LocalRouteBackend)>,
	) -> Self {
		self.local_routes = Arc::new(routes.into_iter().collect());
		self
	}

	/// Adds precise platform/feature availability evidence for unconstructed
	/// local routes.
	pub fn with_local_unavailable(
		mut self,
		routes: impl IntoIterator<Item = (RouteId, ReasonId)>,
	) -> Self {
		self.local_unavailable = Arc::new(routes.into_iter().collect());
		self
	}
}
/// Concrete route composer used by [`crate::layer::stack::BuiltinConfig`].
#[derive(Clone)]
pub struct ProductionRouteComposer {
	dependencies: ProductionDependencies,
}

impl ProductionRouteComposer {
	/// Creates a composer owning all shared production dependencies.
	pub const fn new(dependencies: ProductionDependencies) -> Self {
		Self { dependencies }
	}
}

fn catalog_auth_for_route(
	route: &RouteDef,
	auth: &omp_catalog::provider::AuthSpec,
) -> omp_catalog::provider::AuthSpec {
	let mut auth = auth.clone();
	if route.codec.as_str() == "bedrock-mantle"
		&& let Some(signing) = auth.signing.as_mut()
	{
		signing.service = sf!("bedrock-mantle");
	}
	auth
}

impl RouteComposer for ProductionRouteComposer {
	fn compose(
		&self,
		catalog: &Catalog,
		route: &RouteDef,
	) -> Result<RouteProviderService, RouteUnavailable> {
		if route_uses_aws_sigv4(catalog, route)
			&& let Some(availability) = &self.dependencies.aws_registry
		{
			match availability {
				Ok(availability) if !aws_route_eligible(route, availability) => {
					return Err(unavailable(route, "aws-credential-source-unavailable"));
				},
				Err(source) => {
					return Err(RouteUnavailable::AwsRegistry {
						route:     route.id.clone(),
						reason:    ReasonId(sf!("aws-registry-discovery-failed")),
						operation: None,
						source:    source.clone(),
					});
				},
				Ok(_) => {},
			}
		}
		let bedrock_guardrail = configured_bedrock_guardrail(&self.dependencies.settings, route);
		let bedrock_request_metadata =
			configured_bedrock_request_metadata(&self.dependencies.settings, route);
		let bedrock_ambient_region = self
			.dependencies
			.auth_application
			.signing_regions
			.get(&route.id);
		let (mut binding, wire, framework_timeout) = match route.transport {
			TransportKind::Local => {
				let backend = self
					.dependencies
					.local_routes
					.get(&route.id)
					.ok_or_else(|| {
						self
							.dependencies
							.local_unavailable
							.get(&route.id)
							.cloned()
							.map_or_else(
								|| {
									unavailable(
										route,
										"local-route-not-constructed-for-current-platform-or-feature",
									)
								},
								|reason| RouteUnavailable::new(route.id.clone(), reason, None),
							)
					})?;
				(
					local_codec_binding(route, backend.codec.clone())?,
					backend.wire.clone(),
					Some(backend.framework_timeout),
				)
			},
			TransportKind::Http | TransportKind::AwsEventStream | TransportKind::Connect => (
				codec_binding(
					route,
					&self.dependencies.google_cca,
					self.dependencies.settings.retry.server_side_fallback,
					stateful_responses(catalog, route),
					bedrock_guardrail,
					bedrock_request_metadata,
					bedrock_ambient_region,
				)?,
				WireService::new(ProtocolTransport {
					http:      self.dependencies.http.clone(),
					websocket: self.dependencies.websocket.clone(),
				}),
				None,
			),
			TransportKind::Websocket => (
				codec_binding(
					route,
					&self.dependencies.google_cca,
					self.dependencies.settings.retry.server_side_fallback,
					stateful_responses(catalog, route),
					bedrock_guardrail,
					bedrock_request_metadata,
					bedrock_ambient_region,
				)?,
				WireService::new(ProtocolTransport {
					http:      self.dependencies.http.clone(),
					websocket: self.dependencies.websocket.clone(),
				}),
				None,
			),
			TransportKind::Webrtc => return Err(unavailable(route, "transport-not-implemented")),
		};
		let discovery = discovery_codec(catalog, route, &binding)?;
		if discovery.is_some() {
			binding.supported.insert_kind(OperationKind::DiscoverModels);
		}
		let advertised = advertised_operations(catalog, route);
		let operation = operation_policy(&binding, advertised);
		let codec = Arc::new(RouteCodecSet::for_route(route, advertised, binding, discovery)?);
		let recovery = if advertised.contains_kind(OperationKind::DiscoverModels) {
			let projector =
				match self
					.dependencies
					.discovery_projectors
					.get(&route.id)
					.cloned()
				{
					Some(projector) => projector,
					None => Arc::new(CatalogDiscoveryProjector::for_route(catalog, route).map_err(
						|source| RouteUnavailable::CatalogDiscoveryProjector {
							route: route.id.clone(),
							reason: ReasonId(sf!("catalog-discovery-projector-invalid")),
							operation: None,
							source,
						},
					)?),
				};
			RecoveryLayer::new(projector)
		} else {
			RecoveryLayer::without_discovery()
		};
		let auth = catalog
			.auth_spec(&route.auth)
			.ok_or_else(|| unavailable(route, "catalog-auth-spec-missing"))?;
		let authenticated = auth.kind != AuthSpecKind::None;
		let credential_required =
			!matches!(auth.kind, AuthSpecKind::None | AuthSpecKind::OptionalBearer);
		let oauth = auth.oauth.as_ref().and_then(|id| catalog.oauth_spec(id));
		let signing_region = route
			.endpoint
			.region
			.clone()
			.or_else(|| {
				self
					.dependencies
					.auth_application
					.signing_regions
					.get(&route.id)
					.cloned()
			})
			.or_else(|| {
				bedrock_guardrail
					.and_then(|guardrail| guardrail_arn_region(guardrail.identifier.as_str()))
					.map(Str::new)
			})
			.or_else(|| {
				(route.codec.as_str() == "bedrock-converse").then(|| {
					crate::codec::anthropic::endpoint_region(route.endpoint.base_url.as_str())
						.map_or_else(|| sf!("us-east-1"), Str::new)
				})
			})
			.or_else(|| (route.codec.as_str() == "bedrock-mantle").then(|| sf!("us-east-1")));
		let route_auth = catalog_auth_for_route(route, auth);
		let runtime_auth = AuthSpec::from_catalog(&route_auth, oauth, signing_region.clone())
			.map_err(|source| RouteUnavailable::CatalogAuthSpec {
				route: route.id.clone(),
				reason: ReasonId(sf!("catalog-auth-spec-invalid")),
				operation: None,
				source,
			})?;
		let mut auth_specs = vec![(route.auth.clone(), runtime_auth)];
		// The provider-declared authentications the route also leases; the
		// stored-kind decisions read the same table.
		if let Some(declared) = crate::auth::broker::declared_auth_lease(route.codec.as_str()) {
			let provider = catalog
				.provider(&route.provider)
				.ok_or_else(|| unavailable(route, "catalog-provider-missing"))?;
			for auth_id in &provider.auth {
				if auth_id == &route.auth {
					continue;
				}
				let Some(auth) = catalog.auth_spec(auth_id) else {
					return Err(unavailable(route, "catalog-auth-spec-missing"));
				};
				if !(declared.accepts)(auth.kind) {
					continue;
				}
				let oauth = auth.oauth.as_ref().and_then(|id| catalog.oauth_spec(id));
				let route_auth = catalog_auth_for_route(route, auth);
				let runtime = AuthSpec::from_catalog(&route_auth, oauth, signing_region.clone())
					.map_err(|source| RouteUnavailable::CatalogAuthSpec {
						route: route.id.clone(),
						reason: ReasonId(sf!("catalog-auth-spec-invalid")),
						operation: None,
						source,
					})?;
				if declared.first {
					auth_specs.insert(0, (auth_id.clone(), runtime));
				} else {
					auth_specs.push((auth_id.clone(), runtime));
				}
			}
		}
		let account = RouteAccountSelector {
			pool: self.dependencies.accounts.clone(),
			provider: route.provider.clone(),
			route: route.id.clone(),
			authenticated,
			invocation: auth_specs
				.iter()
				.any(|(id, _)| self.dependencies.credentials.invocation_overrides(id)),
		};
		let restored_kind = crate::auth::broker::restored_static_secret_kind(
			catalog,
			&route.provider,
			auth_specs
				.iter()
				.filter_map(|(id, _)| catalog.auth_spec(id)),
		);
		let leases = RouteLeaseProvider {
			source: self.dependencies.credentials.clone(),
			shapers: self.dependencies.credential_shapers.clone(),
			provider: route.provider.clone(),
			route_base_url: route.endpoint.base_url.clone(),
			specs: auth_specs.iter().map(|(id, _)| id.clone()).collect(),
			restored_kind,
			authenticated,
			required: credential_required,
		};
		let regional_route = if route.codec.as_str() == "bedrock-mantle" {
			let region = signing_region
				.as_ref()
				.expect("Mantle signing region always has a default");
			Some(
				mantle_regional_route(route, region)
					.map_err(|_| unavailable(route, "bedrock-mantle-endpoint-invalid"))?,
			)
		} else {
			None
		};
		let encoder = RouteEncoder {
			route: route.clone(),
			auth_schemes: auth_specs
				.iter()
				.map(|(_, auth)| AuthScheme::for_spec(auth))
				.collect(),
			headers: catalog
				.header_profile(&route.headers)
				.map(|profile| {
					profile
						.headers
						.iter()
						.map(|header| RequestHeader {
							name:  header.name.clone(),
							value: header.value.clone(),
						})
						.collect::<Vec<_>>()
						.into_boxed_slice()
				})
				.unwrap_or_default(),
			codec,
			azure_endpoint: self.dependencies.azure_endpoint.clone(),
			cloudflare_gateway: self.dependencies.cloudflare_gateway.clone(),
			regional_route,
			// `ai_provider_timeout_seconds` is the operator's ceiling and wins
			// outright. The ambient dependency default only applies when no
			// setting is configured: previously it was `min`-ed in, so the
			// hardcoded 60s clamped every configured value above it and a slow
			// first token failed as `stream.first-event` at ~60s no matter what
			// the setting said. A genuine framework ceiling (local backends)
			// still binds, since exceeding it cannot succeed.
			transport_timeout: configured_transport_timeout(
				self.dependencies.transport_timeout,
				self.dependencies.settings.providers.timeout_seconds,
				framework_timeout,
			),
		};
		let admission = self
			.dependencies
			.provider_admission
			.get(&route.provider)
			.cloned()
			.unwrap_or_else(|| self.dependencies.admission.clone());
		let retry = &self.dependencies.settings.retry;
		let stack = build_route_stack(wire, RouteStackLayers {
			intent: IntentLayer::new(PlannedIntent { route: route.id.clone() }),
			session: SessionLayer::new(self.dependencies.sessions.clone()),
			semantic: SemanticLayer::new(CanonicalSemantic),
			operation: OperationPolicyLayer::new(operation)
				.with_settings(self.dependencies.settings.clone()),
			recovery,
			admission: AdmissionLayer::new(admission),
			account: AccountPoolLayer::new(account),
			auth: AuthLeaseLayer::new(leases),
			retry: TransportRetryLayer::new(retry.max_attempts().saturating_sub(1))
				.with_backoff(retry.backoff()),
			rate: RateLayer::new(PoolRateLimiter { pool: self.dependencies.accounts.clone() }),
			encode: EncodeLayer::new(encoder, false),
			credential_apply: CredentialApplyLayer::new(RouteCredentialApplier {
				auth:     auth_specs.into_iter().map(|(_, auth)| auth).collect(),
				required: credential_required,
				mantle:   route.codec.as_str() == "bedrock-mantle",
			}),
			provider_error: ProviderErrorLayer::new(),
		});
		Ok(RouteProviderService::new(stack))
	}
}

#[derive(Clone)]
struct CodecBinding {
	primary:                   Arc<dyn Codec>,
	supported:                 OperationBits,
	embedding:                 Option<EmbeddingRoutePolicy>,
	openai_embedding_override: bool,
}
fn route_uses_aws_sigv4(catalog: &Catalog, route: &RouteDef) -> bool {
	catalog.provider(&route.provider).is_some_and(|provider| {
		provider.auth.iter().any(|auth| {
			catalog
				.auth_spec(auth)
				.is_some_and(|auth| auth.kind == AuthSpecKind::AwsSigv4)
		})
	})
}

fn aws_route_eligible(route: &RouteDef, availability: &AwsRegistryAvailability) -> bool {
	if route.codec.as_str() == "bedrock-mantle" {
		availability.mantle_eligible()
	} else {
		availability.bedrock_eligible()
	}
}

fn configured_bedrock_guardrail<'a>(
	settings: &'a InferenceSettings,
	route: &RouteDef,
) -> Option<&'a BedrockGuardrail> {
	(route.codec.as_str() == "bedrock-converse")
		.then(|| {
			settings
				.providers
				.bedrock_guardrails
				.get(route.provider.as_str())
		})
		.flatten()
}

fn configured_bedrock_request_metadata<'a>(
	settings: &'a InferenceSettings,
	route: &RouteDef,
) -> Option<&'a BTreeMap<Str, Str>> {
	(route.codec.as_str() == "bedrock-converse")
		.then(|| {
			settings
				.providers
				.bedrock_request_metadata
				.get(route.provider.as_str())
		})
		.flatten()
}

fn operation_bits(kinds: &[OperationKind]) -> OperationBits {
	let mut bits = OperationBits::empty();
	for kind in kinds {
		bits.insert_kind(*kind);
	}
	bits
}

fn operation_policy(binding: &CodecBinding, advertised: OperationBits) -> OperationPolicyConfig {
	OperationPolicyConfig {
		embedding:              advertised
			.contains_kind(OperationKind::Embed)
			.then_some(binding.embedding)
			.flatten(),
		native:                 None,
		usage:                  UsageServiceConfig::new(Duration::MAX),
		discovery_maximum_page: advertised
			.contains_kind(OperationKind::DiscoverModels)
			.then_some(NonZeroU32::MAX),
		exact_token_count:      binding.supported.contains_kind(OperationKind::CountTokens),
	}
}

fn local_codec_binding(
	route: &RouteDef,
	primary: Arc<dyn Codec>,
) -> Result<CodecBinding, RouteUnavailable> {
	match (route.codec.as_str(), route.codec_profile) {
		("local", CodecProfile::AppleFm) => Ok(CodecBinding {
			primary,
			supported: operation_bits(&[OperationKind::Chat, OperationKind::DiscoverModels]),
			embedding: None,
			openai_embedding_override: false,
		}),
		_ => Err(unavailable(route, "codec-or-profile-not-implemented")),
	}
}

/// Whether a Responses route may chain turns by `previous_response_id`.
///
/// The provider's compiled default lowering policy carries the affirmative
/// `stateful_response_chaining` evidence (set for the official `OpenAI`
/// platform, absent for `/v1/responses` proxies that ignore or reject the
/// parameter); a route-level `disable_server_state` restriction wins over it.
fn stateful_responses(catalog: &Catalog, route: &RouteDef) -> bool {
	!route.capability_limits.disable_server_state
		&& catalog
			.provider(&route.provider)
			.and_then(|provider| catalog.wire_policy(&provider.wire_policy))
			.is_some_and(|policy| policy.context.stateful_response_chaining == Some(true))
}

fn codec_binding(
	route: &RouteDef,
	cca: &GoogleCcaConfig,
	server_side_fallback: bool,
	stateful_responses: bool,
	bedrock_guardrail: Option<&BedrockGuardrail>,
	bedrock_request_metadata: Option<&BTreeMap<Str, Str>>,
	bedrock_ambient_region: Option<&Str>,
) -> Result<CodecBinding, RouteUnavailable> {
	let (primary, supported, embedding, openai_embedding_override): (
		Arc<dyn Codec>,
		OperationBits,
		Option<EmbeddingRoutePolicy>,
		bool,
	) = match (route.codec.as_str(), route.codec_profile) {
		("anthropic", CodecProfile::Standard) => (
			Arc::new(AnthropicCodec::direct().with_betas(
				server_side_fallback.then_some(Str::new_static("server-side-fallback-2026-06-01")),
			)),
			operation_bits(&[OperationKind::Chat, OperationKind::CountTokens]),
			None,
			false,
		),
		("bedrock-converse", CodecProfile::Standard) => (
			Arc::new(
				BedrockConverseCodec::new(BedrockOptions {
					guardrail: bedrock_guardrail.cloned(),
					request_metadata: bedrock_request_metadata.cloned().unwrap_or_default(),
					..BedrockOptions::default()
				})
				.with_ambient_region(bedrock_ambient_region.cloned()),
			),
			operation_bits(&[OperationKind::Chat, OperationKind::DiscoverModels]),
			None,
			false,
		),
		("cursor", CodecProfile::Standard) => (
			Arc::new(CursorCodec::new()),
			operation_bits(&[OperationKind::Chat, OperationKind::DiscoverModels]),
			None,
			false,
		),
		("devin", CodecProfile::Standard) => (
			Arc::new(DevinCodec::new()),
			operation_bits(&[OperationKind::Chat, OperationKind::DiscoverModels]),
			None,
			false,
		),
		("gitlab-duo", CodecProfile::Standard) => (
			Arc::new(GitLabWorkflowCodec::new()),
			operation_bits(&[OperationKind::Chat, OperationKind::DiscoverModels]),
			None,
			false,
		),
		("google-genai", CodecProfile::Standard) => (
			Arc::new(GeminiCodec::generative_language(None)),
			operation_bits(&[OperationKind::Chat, OperationKind::CountTokens, OperationKind::Embed]),
			Some(EmbeddingRoutePolicy {
				normalization:          NormalizationSupport::Never,
				maximum_input_tokens:   None,
				native_text_truncation: false,
			}),
			false,
		),
		("google-vertex", CodecProfile::Standard) => (
			Arc::new(GeminiCodec::vertex(None)),
			operation_bits(&[OperationKind::Chat, OperationKind::CountTokens, OperationKind::Embed]),
			Some(EmbeddingRoutePolicy {
				normalization:          NormalizationSupport::Never,
				maximum_input_tokens:   None,
				native_text_truncation: false,
			}),
			false,
		),
		("google-cca", CodecProfile::GoogleCcaGeminiCli) => (
			Arc::new(GoogleCcaCodec::gemini_cli_for_route(
				None,
				cca.gemini_cli_platform.clone(),
				cca.gemini_cli_arch.clone(),
			)),
			operation_bits(&[OperationKind::Chat, OperationKind::DiscoverModels]),
			None,
			false,
		),
		("google-cca", CodecProfile::GoogleCcaAntigravity) => (
			Arc::new(GoogleCcaCodec::antigravity(
				None,
				cca.antigravity_headers.clone(),
				cca.antigravity_policy.clone(),
			)),
			operation_bits(&[OperationKind::Chat, OperationKind::DiscoverModels]),
			None,
			false,
		),
		("ollama", CodecProfile::Standard) => (
			Arc::new(OllamaCodec),
			operation_bits(&[
				OperationKind::Chat,
				OperationKind::Embed,
				OperationKind::DiscoverModels,
			]),
			Some(EmbeddingRoutePolicy {
				normalization:          NormalizationSupport::Never,
				maximum_input_tokens:   None,
				native_text_truncation: true,
			}),
			false,
		),
		("openai-chat", CodecProfile::Standard) => (
			Arc::new(OpenAiCodec::default()),
			operation_bits(&[
				OperationKind::Chat,
				OperationKind::Embed,
				OperationKind::GenerateImage,
				OperationKind::Speak,
				OperationKind::Transcribe,
				OperationKind::Realtime,
			]),
			Some(EmbeddingRoutePolicy {
				normalization:          NormalizationSupport::Never,
				maximum_input_tokens:   None,
				native_text_truncation: false,
			}),
			true,
		),
		("openai-codex", CodecProfile::Standard) => (
			Arc::new(OpenAiCodexCodec::default()),
			operation_bits(&[
				OperationKind::Chat,
				OperationKind::GenerateImage,
				OperationKind::DiscoverModels,
			]),
			None,
			false,
		),
		("openai-responses", CodecProfile::Standard) => (
			Arc::new(OpenAiResponsesCodec::new(OpenAiResponsesOptions {
				stateful: stateful_responses,
				..OpenAiResponsesOptions::default()
			})),
			operation_bits(&[OperationKind::Chat, OperationKind::GenerateImage]),
			None,
			false,
		),
		("bedrock-mantle", CodecProfile::Standard) => (
			Arc::new(BedrockMantleCodec::new(OpenAiResponsesOptions {
				stateful: stateful_responses,
				..OpenAiResponsesOptions::default()
			})),
			operation_bits(&[OperationKind::Chat]),
			None,
			false,
		),
		("openai-embedding", CodecProfile::Standard) => (
			Arc::new(OpenAiEmbeddingCodec::for_openai_protocol()),
			operation_bits(&[OperationKind::Embed]),
			Some(EmbeddingRoutePolicy {
				normalization:          NormalizationSupport::Never,
				maximum_input_tokens:   None,
				native_text_truncation: false,
			}),
			false,
		),
		("search-exa", CodecProfile::Standard) => {
			(Arc::new(ExaSearchCodec), operation_bits(&[OperationKind::Search]), None, false)
		},
		("search-brave", CodecProfile::Standard) => {
			(Arc::new(BraveSearchCodec), operation_bits(&[OperationKind::Search]), None, false)
		},
		("search-duckduckgo", CodecProfile::Standard) => {
			(Arc::new(DuckduckgoSearchCodec), operation_bits(&[OperationKind::Search]), None, false)
		},
		("search-ecosia", CodecProfile::Standard) => {
			(Arc::new(EcosiaSearchCodec), operation_bits(&[OperationKind::Search]), None, false)
		},
		("search-firecrawl", CodecProfile::Standard) => {
			(Arc::new(FirecrawlSearchCodec), operation_bits(&[OperationKind::Search]), None, false)
		},
		("search-jina", CodecProfile::Standard) => {
			(Arc::new(JinaSearchCodec), operation_bits(&[OperationKind::Search]), None, false)
		},
		("search-google", CodecProfile::Standard) => {
			(Arc::new(GoogleSearchCodec), operation_bits(&[OperationKind::Search]), None, false)
		},
		("search-kimi", CodecProfile::Standard) => {
			(Arc::new(KimiSearchCodec), operation_bits(&[OperationKind::Search]), None, false)
		},
		("search-zai", CodecProfile::Standard) => {
			(Arc::new(ZaiSearchCodec), operation_bits(&[OperationKind::Search]), None, false)
		},
		("search-synthetic", CodecProfile::Standard) => {
			(Arc::new(SyntheticSearchCodec), operation_bits(&[OperationKind::Search]), None, false)
		},
		("search-kagi", CodecProfile::Standard) => {
			(Arc::new(KagiSearchCodec), operation_bits(&[OperationKind::Search]), None, false)
		},
		("search-mojeek", CodecProfile::Standard) => {
			(Arc::new(MojeekSearchCodec), operation_bits(&[OperationKind::Search]), None, false)
		},
		("search-parallel", CodecProfile::Standard) => {
			(Arc::new(ParallelSearchCodec), operation_bits(&[OperationKind::Search]), None, false)
		},
		("parallel-extract", CodecProfile::Standard) => {
			(Arc::new(ParallelExtractCodec), operation_bits(&[OperationKind::Extract]), None, false)
		},
		("search-perplexity", CodecProfile::Standard) => {
			(Arc::new(PerplexitySearchCodec), operation_bits(&[OperationKind::Search]), None, false)
		},
		("search-searxng", CodecProfile::Standard) => {
			(Arc::new(SearxngSearchCodec), operation_bits(&[OperationKind::Search]), None, false)
		},
		("search-startpage", CodecProfile::Standard) => {
			(Arc::new(StartpageSearchCodec), operation_bits(&[OperationKind::Search]), None, false)
		},
		("search-tavily", CodecProfile::Standard) => {
			(Arc::new(TavilySearchCodec), operation_bits(&[OperationKind::Search]), None, false)
		},
		("search-tinyfish", CodecProfile::Standard) => {
			(Arc::new(TinyfishSearchCodec), operation_bits(&[OperationKind::Search]), None, false)
		},
		_ => return Err(unavailable(route, "codec-or-profile-not-implemented")),
	};
	Ok(CodecBinding { primary, supported, embedding, openai_embedding_override })
}

fn discovery_codec(
	catalog: &Catalog,
	route: &RouteDef,
	binding: &CodecBinding,
) -> Result<Option<Arc<dyn Codec>>, RouteUnavailable> {
	let Some(discovery) = route.discovery.as_ref() else {
		return Ok(None);
	};
	let spec = catalog
		.discovery_spec(discovery)
		.ok_or_else(|| unavailable(route, "catalog-discovery-spec-missing"))?;
	let codec: Arc<dyn Codec> = match spec.kind {
		DiscoveryKind::OpenAiModels if route.codec.as_str() == "bedrock-mantle" => {
			Arc::new(BedrockMantleDiscoveryCodec::from_spec(spec).map_err(|source| {
				discovery_codec_unavailable(
					route,
					"bedrock-mantle-models-discovery-codec-invalid",
					source,
				)
			})?)
		},
		DiscoveryKind::OpenAiModels => {
			Arc::new(OpenAiModelsDiscoveryCodec::from_spec(spec).map_err(|source| {
				discovery_codec_unavailable(route, "openai-models-discovery-codec-invalid", source)
			})?)
		},
		DiscoveryKind::OllamaTags => {
			Arc::new(OllamaTagsDiscoveryCodec::from_spec(spec).map_err(|source| {
				discovery_codec_unavailable(route, "ollama-tags-discovery-codec-invalid", source)
			})?)
		},
		DiscoveryKind::AccountModels => {
			Arc::new(AccountModelsDiscoveryCodec::from_spec(spec).map_err(|source| {
				discovery_codec_unavailable(route, "account-models-discovery-codec-invalid", source)
			})?)
		},
		DiscoveryKind::GoogleModels => {
			Arc::new(GoogleModelsDiscoveryCodec::from_spec(spec).map_err(|source| {
				discovery_codec_unavailable(route, "google-models-discovery-codec-invalid", source)
			})?)
		},
		DiscoveryKind::Specialized => {
			if !binding
				.supported
				.contains_kind(OperationKind::DiscoverModels)
			{
				return Err(RouteUnavailable::new(
					route.id.clone(),
					ReasonId(sf!("specialized-discovery-codec-not-implemented")),
					Some(OperationKind::DiscoverModels),
				));
			}
			binding.primary.clone()
		},
	};
	Ok(Some(codec))
}

const OPERATION_COUNT: usize = OperationKind::Extract as usize + 1;
const OPERATIONS: [OperationKind; OPERATION_COUNT] = [
	OperationKind::Chat,
	OperationKind::CountTokens,
	OperationKind::Tokenize,
	OperationKind::Detokenize,
	OperationKind::Embed,
	OperationKind::GenerateImage,
	OperationKind::GenerateVideo,
	OperationKind::Speak,
	OperationKind::Transcribe,
	OperationKind::Realtime,
	OperationKind::Search,
	OperationKind::Usage,
	OperationKind::DiscoverModels,
	OperationKind::Auth,
	OperationKind::Native,
	OperationKind::Extract,
];

fn advertised_operations(catalog: &Catalog, route: &RouteDef) -> OperationBits {
	let mut advertised = OperationBits::empty();
	for model in catalog.models() {
		if model.routes.iter().any(|candidate| candidate == &route.id) {
			advertised |= model.capabilities.operations;
		}
	}
	if let Some(limits) = route.capability_limits.operations {
		advertised = OperationBits::from_bits(advertised.bits() & limits.bits());
	}
	if route.discovery.is_some() {
		advertised.insert_kind(OperationKind::DiscoverModels);
	}
	advertised
}

struct RouteCodecSet {
	operations: [Option<Arc<dyn Codec>>; OPERATION_COUNT],
}

impl RouteCodecSet {
	fn for_route(
		route: &RouteDef,
		advertised: OperationBits,
		binding: CodecBinding,
		discovery: Option<Arc<dyn Codec>>,
	) -> Result<Self, RouteUnavailable> {
		let embedding: Arc<dyn Codec> = Arc::new(OpenAiEmbeddingCodec::for_openai_protocol());
		let mut operations: [Option<Arc<dyn Codec>>; OPERATION_COUNT] = array::from_fn(|_| None);
		for operation in OPERATIONS {
			if !advertised.contains_kind(operation) {
				continue;
			}
			if !binding.supported.contains_kind(operation) {
				return Err(RouteUnavailable::new(
					route.id.clone(),
					ReasonId(sf!("advertised-operation-codec-not-implemented")),
					Some(operation),
				));
			}
			operations[operation as usize] = Some(if operation == OperationKind::DiscoverModels {
				discovery
					.clone()
					.ok_or_else(|| unavailable(route, "discovery-codec-not-constructed"))?
			} else if binding.openai_embedding_override && operation == OperationKind::Embed {
				embedding.clone()
			} else {
				binding.primary.clone()
			});
		}
		Ok(Self { operations })
	}

	fn codec(&self, operation: OperationKind) -> Result<&Arc<dyn Codec>, Error> {
		self.operations[operation as usize].as_ref().ok_or_else(|| {
			Error::planning(
				ErrorKind::CapabilityMismatch,
				ErrorDetail::capability(
					Str::new(operation.to_string()),
					ReasonId(sf!("operation-not-advertised-on-route")),
				),
				ExecutionReceipt::default(),
			)
		})
	}
}

impl Codec for RouteCodecSet {
	fn encode(
		&self,
		context: &EncodeContext<'_>,
		operation: &OperationCall,
	) -> Result<EncodedRequest, Error> {
		let encoded_operation = (context.policy.context.glyph_tokenization == Some(true))
			.then(|| glyph::encode_operation(operation))
			.flatten();
		self
			.codec(operation.kind())?
			.encode(context, encoded_operation.as_ref().unwrap_or(operation))
	}

	fn encode_realtime_handshake(
		&self,
		context: &EncodeContext<'_>,
		operation: &OperationCall,
	) -> Result<Option<EncodedRequest>, Error> {
		self
			.codec(operation.kind())?
			.encode_realtime_handshake(context, operation)
	}

	fn decoder(&self, context: &DecodeContext<'_>) -> Result<DecoderState, Error> {
		let decoder = self.codec(context.operation)?.decoder(context)?;
		Ok(
			if context.policy.context.glyph_tokenization == Some(true)
				&& glyph::operation_active(context.operation_call)
			{
				glyph::wrap_decoder(decoder)
			} else {
				decoder
			},
		)
	}

	fn realtime(
		&self,
		context: &DecodeContext<'_>,
	) -> Result<Option<RealtimeWireCodecState>, Error> {
		self.codec(context.operation)?.realtime(context)
	}
}

#[derive(Clone)]
struct RouteEncoder {
	route:              RouteDef,
	auth_schemes:       Box<[AuthScheme]>,
	headers:            Box<[RequestHeader]>,
	codec:              Arc<dyn Codec>,
	azure_endpoint:     Option<AzureEndpointConfig>,
	cloudflare_gateway: Option<CloudflareGatewayConfig>,
	regional_route:     Option<RouteDef>,
	transport_timeout:  Duration,
}

/// Resolves the per-attempt transport ceiling.
///
/// A configured `ai_provider_timeout_seconds` is authoritative: it replaces
/// the ambient default rather than being `min`-ed against it, so an operator
/// can raise the ceiling as well as lower it. Zero means unset and keeps the
/// ambient default.
///
/// `framework` is a real ceiling imposed by a runtime that cannot be asked to
/// wait longer — only local backends have one. Network transports pass `None`:
/// echoing the ambient default back as a "framework" bound is what previously
/// pinned every attempt at 60s regardless of the setting.
fn configured_transport_timeout(
	ambient: Duration,
	configured_seconds: u64,
	framework: Option<Duration>,
) -> Duration {
	let configured = if configured_seconds == 0 {
		ambient
	} else {
		Duration::from_secs(configured_seconds)
	};
	framework.map_or(configured, |ceiling| configured.min(ceiling))
}

const fn forced_choice_penalty(penalty: NativeToolChoicePenalty) -> Penalty {
	match penalty {
		NativeToolChoicePenalty::CacheInvalidated => Penalty::CacheInvalidated,
		NativeToolChoicePenalty::Billable => Penalty::Billable,
		NativeToolChoicePenalty::Latency => Penalty::Latency,
		NativeToolChoicePenalty::Unknown => Penalty::Unknown,
	}
}

fn forced_call_operation(
	operation: &OperationCall,
	plan: &crate::plan::ExecutionPlan,
	execution: &ExecutionContext,
) -> Option<OperationCall> {
	let OperationCall::Chat(request) = operation else {
		return None;
	};
	let forced = request.forced_call?;
	let features = plan
		.policy_model
		.as_ref()
		.and_then(|model| model.capabilities.chat.as_ref())
		.and_then(|chat| chat.tools.constraints())
		.map_or_else(ToolFeatureBits::empty, |tools| tools.features);
	let decision = forced_call_ladder(
		&request.tool_choice,
		ForcedCallCaps::from_wire_policy(
			features,
			plan
				.wire_policy
				.tool
				.forced_choice_penalty
				.map(forced_choice_penalty),
			&plan.wire_policy,
		),
		forced.non_compliant_turns != 0,
		forced.escalations_left,
	);
	if !decision.soft_prompt {
		return None;
	}
	if let Some(escalation) = decision.escalation.as_ref() {
		execution.with_receipt(|receipt| {
			if !receipt.adjustments.contains(escalation) {
				receipt.adjustments.push(escalation.clone());
			}
		});
	}
	Some(OperationCall::Chat(Arc::new(apply_forced_call_decision(request, &decision))))
}

fn encode_wire_request(
	codec: &dyn Codec,
	context: &EncodeContext<'_>,
	operation: &OperationCall,
	execution: &ExecutionContext,
) -> Result<EncodedRequest, Error> {
	if let OperationCall::Chat(request) = operation
		&& let Err(error) = request.validate_named_tool_choice()
	{
		return Err(
			Error::new(
				ErrorKind::InvalidRequest,
				ErrorPhase::Encoding,
				RetryAction::Never,
				ExecutionReceipt::default(),
			)
			.detail(ErrorDetail::NamedToolUnavailable { name: error.name }),
		);
	}
	if operation.kind() == OperationKind::Realtime {
		codec
			.encode_realtime_handshake(context, operation)?
			.ok_or_else(|| contract_error(execution, "realtime-handshake-codec-not-constructed"))
	} else {
		codec.encode(context, operation)
	}
}

fn scheme_for_credential(schemes: &[AuthScheme], kind: CredentialKind) -> Option<AuthScheme> {
	schemes.iter().copied().find(|scheme| {
		matches!(
			(kind, scheme),
			(crate::auth::CredentialKind::ApiKey, crate::auth::AuthScheme::ApiKey)
				| (crate::auth::CredentialKind::Basic, crate::auth::AuthScheme::Basic)
				| (
					crate::auth::CredentialKind::Bearer,
					crate::auth::AuthScheme::OAuth | crate::auth::AuthScheme::ApplicationDefault,
				) | (crate::auth::CredentialKind::SessionToken, crate::auth::AuthScheme::SessionToken,)
				| (crate::auth::CredentialKind::AwsSigV4, crate::auth::AuthScheme::AwsSigV4,)
		)
	})
}
fn append_endpoint_api_version(
	uri: &mut Str,
	api_version: Option<&str>,
	context: &ExecutionContext,
) -> Result<(), Error> {
	let Some(api_version) = api_version else {
		return Ok(());
	};
	let mut parsed = Url::parse(uri.as_str())
		.map_err(|_| contract_error(context, "endpoint-api-version-uri-invalid"))?;
	if parsed.query_pairs().any(|(name, _)| name == "api-version") {
		return Ok(());
	}
	parsed
		.query_pairs_mut()
		.append_pair("api-version", api_version);
	*uri = Str::new(&parsed);
	Ok(())
}

fn mantle_regional_route(
	route: &RouteDef,
	region: &Str,
) -> Result<RouteDef, crate::codec::bedrock_mantle::BedrockMantleEndpointError> {
	let base_url = expand_mantle_endpoint(route.endpoint.base_url.as_str(), region.as_str())?;
	let parsed = Url::parse(base_url.as_str())
		.map_err(crate::codec::bedrock_mantle::BedrockMantleEndpointError::Url)?;
	let mut effective_route = route.clone();
	effective_route.endpoint.base_url = base_url;
	effective_route.endpoint.region = Some(region.clone());
	effective_route.trust_domain.origin = Str::new(parsed.origin().ascii_serialization());
	Ok(effective_route)
}

fn mantle_effective_target(
	route: &RouteDef,
	target: Option<&omp_catalog::WireTarget>,
) -> Option<omp_catalog::WireTarget> {
	target.cloned().map(|mut target| {
		target.endpoint = route.endpoint.clone();
		target
	})
}

fn azure_effective_route(
	route: &RouteDef,
	target: Option<&omp_catalog::WireTarget>,
	config: Option<&AzureEndpointConfig>,
	context: &ExecutionContext,
) -> Result<Option<(RouteDef, omp_catalog::WireTarget)>, Error> {
	if route.provider.as_str() != "azure" {
		return Ok(None);
	}
	let config =
		config.ok_or_else(|| azure_configuration_error(context, "azure-endpoint-not-configured"))?;
	let target =
		target.ok_or_else(|| azure_configuration_error(context, "azure-wire-target-missing"))?;
	let resource = config
		.resource_base
		.as_str()
		.trim_end_matches('/')
		.trim_end_matches("/openai");
	let deployment = config
		.deployment_for(target.wire_model.as_str())
		.ok_or_else(|| azure_configuration_error(context, "azure-deployment-not-configured"))?;
	// Responses is resource-scoped: the deployment travels in `body.model`
	// instead of the `/deployments/{name}` path segment.
	let responses = route.codec.as_str() == "openai-responses";
	let base_url = if responses {
		sf!("{resource}/openai")
	} else {
		sf!("{resource}/openai/deployments/{deployment}")
	};
	let parsed = Url::parse(&base_url)
		.map_err(|_| azure_configuration_error(context, "azure-effective-endpoint-invalid"))?;
	let mut effective_route = route.clone();
	effective_route.endpoint.base_url = base_url;
	if config.api_version.is_some() {
		effective_route.endpoint.api_version = config.api_version.clone();
	}
	effective_route.trust_domain.origin = Str::new(parsed.origin().ascii_serialization());
	let mut effective_target = target.clone();
	effective_target.endpoint = effective_route.endpoint.clone();
	if responses {
		effective_target.wire_model = WireModelId::new(deployment.clone());
	}
	Ok(Some((effective_route, effective_target)))
}

fn cloudflare_effective_route(
	route: &RouteDef,
	target: Option<&omp_catalog::WireTarget>,
	config: Option<&CloudflareGatewayConfig>,
	context: &ExecutionContext,
) -> Result<Option<(RouteDef, Option<omp_catalog::WireTarget>)>, Error> {
	if route.provider.as_str() != CLOUDFLARE_GATEWAY_PROVIDER {
		return Ok(None);
	}
	// A literal placeholder must never reach the wire: without both
	// coordinates the call fails here, before any request is built.
	let config = config
		.ok_or_else(|| azure_configuration_error(context, "cloudflare-gateway-not-configured"))?;
	let fill = |base: &str| {
		base
			.replace("{account}", config.account.as_str())
			.replace("<account>", config.account.as_str())
			.replace("{gateway}", config.gateway.as_str())
			.replace("<gateway>", config.gateway.as_str())
	};
	let base_url = fill(route.endpoint.base_url.as_str());
	if base_url.contains(['{', '}', '<', '>']) {
		return Err(azure_configuration_error(context, "cloudflare-effective-endpoint-invalid"));
	}
	let parsed = Url::parse(&base_url)
		.map_err(|_| azure_configuration_error(context, "cloudflare-effective-endpoint-invalid"))?;
	let mut effective_route = route.clone();
	effective_route.endpoint.base_url = Str::new(base_url);
	effective_route.trust_domain.origin = Str::new(parsed.origin().ascii_serialization());
	let effective_target = target.cloned().map(|mut target| {
		target.endpoint = effective_route.endpoint.clone();
		target
	});
	Ok(Some((effective_route, effective_target)))
}

impl AttemptEncoder<Call, Option<CredentialLease>> for RouteEncoder {
	fn before_request(
		&self,
		call: &mut Call,
		execution: &ExecutionContext,
	) -> impl Future<Output = Result<BeforeRequestMutation, Error>> + Send {
		let route = self.route.clone();
		let headers = self.headers.clone();
		let execution = execution.clone();
		async move {
			if !call.response_hooks.before_request_subscribed() {
				return Ok(BeforeRequestMutation::default());
			}
			let draft = before_request_draft(call, &route, headers);
			let mutation = call
				.response_hooks
				.before_request(&draft)
				.await
				.map_err(|denial| before_request_denied(&execution, denial))?;
			narrow_before_request_intents(
				call,
				&draft.intents,
				mutation.intents.as_deref(),
				&execution,
			)?;
			Ok(mutation)
		}
	}

	fn encode(
		&self,
		call: &Call,
		lease: &Option<CredentialLease>,
		mutation: &BeforeRequestMutation,
		execution: &ExecutionContext,
		attempt: u32,
		provisional: bool,
		cancel: Cancellation,
	) -> Result<TransportRequest, Error> {
		let plan = call
			.execution
			.as_ref()
			.ok_or_else(|| contract_error(execution, "execution-plan-missing"))?;
		if plan.route != self.route.id || plan.codec != self.route.codec {
			return Err(contract_error(execution, "route-codec-does-not-match-plan"));
		}
		let account = execution.account_routing();
		let server_state = execution.session_state();
		let endpoint_override = lease.as_ref().and_then(CredentialLease::endpoint_override);
		let azure = azure_effective_route(
			&self.route,
			plan.wire_target(),
			self.azure_endpoint.as_ref(),
			execution,
		)?;
		let cloudflare = cloudflare_effective_route(
			&self.route,
			plan.wire_target(),
			self.cloudflare_gateway.as_ref(),
			execution,
		)?;
		let (effective_route, effective_target) = if let Some(endpoint_override) = endpoint_override {
			let mut route = self.route.clone();
			route.endpoint.base_url = endpoint_override.clone();
			route.trust_domain.origin = Url::parse(endpoint_override).map_or_else(
				|_| endpoint_override.clone(),
				|url| Str::new(url.origin().ascii_serialization()),
			);
			let target = plan.wire_target().cloned().map(|mut target| {
				target.endpoint.base_url = endpoint_override.clone();
				target
			});
			(Some(route), target)
		} else if let Some((route, target)) = azure {
			(Some(route), Some(target))
		} else if let Some((route, target)) = cloudflare {
			(Some(route), target)
		} else if let Some(route) = &self.regional_route {
			(Some(route.clone()), mantle_effective_target(route, plan.wire_target()))
		} else {
			(None, None)
		};
		let route = effective_route.as_ref().unwrap_or(&self.route);
		if endpoint_override.is_some() || effective_route.is_some() {
			execution.set_effective_trust_domain(route.trust_domain.clone());
		}
		if server_state
			.as_ref()
			.is_some_and(|binding| binding.key.trust_domain != route.trust_domain)
		{
			return Err(session_trust_error(execution));
		}
		let target = effective_target.as_ref().or_else(|| plan.wire_target());
		let auth_scheme = lease
			.as_ref()
			.and_then(|lease| scheme_for_credential(&self.auth_schemes, lease.kind()));
		let encode_context = EncodeContext {
			request_id: &call.id,
			auth_scheme,
			route,
			target,
			policy_model: plan.policy_model.as_deref(),
			policy: &plan.wire_policy,
			thinking_policy: plan.thinking_policy.as_deref(),
			thinking_selection: plan.thinking_selection.as_ref(),
			session: call.session.as_ref(),
			affinity: &call.affinity,
			server_state: server_state.as_ref(),
			account: account.as_ref(),
			attempt: EncodeAttempt::default()
				.with_index(attempt)
				.with_provisional(provisional)
				.with_template_effort_rejected(
					attempt > 0
						&& execution.provider_error_code_seen(openai_chat::TEMPLATE_EFFORT_REJECTED_CODE),
				),
		};
		let adjusted_operation = forced_call_operation(&call.operation, plan, execution);
		let operation = adjusted_operation.as_ref().unwrap_or(&call.operation);
		if matches!(self.route.codec.as_str(), "google-genai" | "google-vertex")
			&& let OperationCall::Chat(request) = operation
			&& matches!(
				&request.output,
				Setting::Prefer(
					StructuredOutput::Regex(_) | StructuredOutput::Lark(_) | StructuredOutput::Ebnf(_)
				)
			) {
			execution.with_receipt(|receipt| {
				let feature = FeatureId(sf!("chat.structured_output"));
				if !receipt.adjustments.iter().any(|adjustment| {
					matches!(
						adjustment,
						Adjustment::Dropped { feature: existing, .. } if existing == &feature
					)
				}) {
					receipt.adjustments.push(Adjustment::Dropped {
						feature,
						reason: ReasonId(sf!("gemini-portable-grammar-unsupported")),
					});
				}
			});
		}
		let mut encoded =
			encode_wire_request(self.codec.as_ref(), &encode_context, operation, execution)?;
		if !encoded.adjustments.is_empty() {
			execution.with_receipt(|receipt| {
				for adjustment in &encoded.adjustments {
					if !receipt.adjustments.contains(adjustment) {
						receipt.adjustments.push(adjustment.clone());
					}
				}
			});
		}
		append_endpoint_api_version(
			&mut encoded.uri,
			route.endpoint.api_version.as_deref(),
			execution,
		)?;
		let bedrock_converse =
			route.codec.as_str() == "bedrock-converse" && operation.kind() == OperationKind::Chat;
		if bedrock_converse {
			merge_bedrock_headers(&mut encoded.headers, &self.headers);
		} else {
			merge_static_headers(&mut encoded.headers, &self.headers, execution)?;
		}
		// Copilot bills by initiator: the headers declare it and the attempt's usage
		// charges it.
		let premium_requests_millionths = if super::copilot::is_copilot(&route.provider)
			&& let OperationCall::Chat(request) = operation
		{
			let dynamics = super::copilot::dynamics(
				request,
				&self.headers,
				plan
					.policy_model
					.as_ref()
					.and_then(|model| model.premium_multiplier_millionths),
			);
			merge_static_headers(&mut encoded.headers, &dynamics.headers, execution)?;
			dynamics.premium_requests_millionths
		} else {
			0
		};
		execution.set_premium_requests_millionths(premium_requests_millionths);
		apply_before_request_mutation(&mut encoded, mutation, execution, bedrock_converse)?;
		if bedrock_converse && mutation.body.contains_key("requestMetadata") {
			sanitize_bedrock_request_metadata(&mut encoded, execution)?;
		}
		if bedrock_converse {
			protect_owned_headers(&mut encoded.headers, true);
		}
		let header_names = encoded
			.headers
			.iter()
			.map(|header| header.name.as_str())
			.collect::<Vec<_>>()
			.join(",");
		let capture_payload = format!(
			"{:?} {:?} {} headers=[{}] request_body_limit={}",
			encoded.operation, encoded.method, encoded.uri, header_names, encoded.bounds.request_body,
		);
		global_provider_capture().capture(
			call.debug_session.as_deref().or_else(|| {
				call
					.session
					.as_ref()
					.map(|session| session.conversation.as_str())
			}),
			"request.pre_dispatch",
			&capture_payload,
		);
		let mut timeout = self.transport_timeout;
		if let Some(hook_timeout) = mutation.timeout {
			timeout = timeout.min(hook_timeout);
		}
		if let Some(deadline) = call.deadline {
			timeout = timeout.min(deadline.saturating_duration_since(Instant::now()));
		}
		if let Some(max_elapsed) = call.budget.max_elapsed {
			timeout = timeout.min(max_elapsed.saturating_sub(execution.elapsed()));
		}
		if timeout.is_zero() {
			return Err(Error::new(
				ErrorKind::DeadlineExceeded,
				ErrorPhase::Connecting,
				RetryAction::Never,
				execution.receipt(),
			));
		}
		let decode_context = DecodeContext {
			request_id: &call.id,
			auth_scheme,
			provider: &plan.provider,
			route: &plan.route,
			target,
			policy_model: plan.policy_model.as_deref(),
			policy: &plan.wire_policy,
			thinking_policy: plan.thinking_policy.as_deref(),
			thinking_selection: plan.thinking_selection.as_ref(),
			operation: operation.kind(),
			operation_call: operation,
			framing: encoded.framing,
			native_response: native_response(operation),
			attempt,
		};
		decode_context.debug_assert_valid();
		let realtime = self.codec.realtime(&decode_context)?;
		let decoder = if realtime.is_none() {
			Some(self.codec.decoder(&decode_context)?)
		} else {
			None
		};
		if (call.operation.kind() == OperationKind::Realtime) != realtime.is_some() {
			return Err(contract_error(execution, "realtime-wire-codec-contract-mismatch"));
		}
		Ok(TransportRequest {
			encoded,
			credentials: None,
			signature: None,
			decoder,
			realtime,
			cancel,
			response_hooks: call.response_hooks.clone(),
			attempt: TransportAttempt {
				request_id: call.id.clone(),
				session: call.debug_session.clone().or_else(|| {
					call
						.session
						.as_ref()
						.map(|session| Str::new(session.conversation.as_str()))
				}),
				provider: plan.provider.clone(),
				model: plan.model.clone(),
				api: Str::new(plan.codec.as_str()),
				route: plan.route.clone(),
				account: account.as_ref().and_then(|routing| routing.account.clone()),
				principal: Some(
					account
						.as_ref()
						.and_then(|routing| routing.principal.clone())
						.unwrap_or_else(|| call.attribution.principal.clone()),
				),
				index: attempt,
				provisional,
				capture_limit: call.budget.max_staging_bytes,
				timeout,
				first_event_timeout: plan
					.wire_policy
					.streaming
					.watchdog
					.and_then(omp_catalog::StreamWatchdog::first_event_timeout),
			},
		})
	}
}

fn before_request_draft(
	call: &Call,
	route: &RouteDef,
	headers: Box<[RequestHeader]>,
) -> BeforeRequestDraft {
	let plan = call
		.execution
		.as_ref()
		.expect("request gate runs only after plan validation");
	let mut scalars = JsonMap::new();
	let mut intents = Vec::new();
	let mut message_count = 0;
	if let OperationCall::Chat(chat) = &call.operation {
		message_count = chat.messages.len();
		if let Some(value) = chat.sampling.temperature {
			scalars.insert("temperature".to_owned(), json!(value));
		}
		if let Some(value) = chat.sampling.top_p {
			scalars.insert("top_p".to_owned(), json!(value));
		}
		if let Some(value) = chat.sampling.top_k {
			scalars.insert("top_k".to_owned(), json!(value));
		}
		if let Some(value) = chat.sampling.min_p {
			scalars.insert("min_p".to_owned(), json!(value));
		}
		if let Some(value) = chat.sampling.seed {
			scalars.insert("seed".to_owned(), json!(value));
		}
		if let Some(value) = chat.sampling.presence_penalty {
			scalars.insert("presence_penalty".to_owned(), json!(value));
		}
		if let Some(value) = chat.sampling.frequency_penalty {
			scalars.insert("frequency_penalty".to_owned(), json!(value));
		}
		if let Some(value) = chat.sampling.repetition_penalty {
			scalars.insert("repetition_penalty".to_owned(), json!(value));
		}
		if let Some(value) = chat.max_output_tokens {
			scalars.insert("max_output_tokens".to_owned(), json!(value));
		}
		if let Some(value) = chat.top_logprobs {
			scalars.insert("top_logprobs".to_owned(), json!(value));
		}
		let mut push_intent = |kind: &'static str| {
			intents.push(json!({
				"kind": kind,
				"on_unsupported": "unspecified",
				"priority": 0,
				"payload": null,
			}));
		};
		if !matches!(chat.tool_choice, Setting::Unset) {
			push_intent("force_call");
		}
		if !matches!(chat.output, Setting::Unset) {
			push_intent("strict");
		}
		if !matches!(chat.reasoning, Setting::Unset) {
			push_intent("reasoning");
		}
		if !matches!(chat.verbosity, Setting::Unset) {
			push_intent("verbosity");
		}
		if !matches!(chat.cache_retention, Setting::Unset) {
			push_intent("cache_retention");
		}
		if !matches!(chat.service_tier, Setting::Unset) {
			push_intent("service_tier");
		}
		if !chat.hosted_tools.is_empty() {
			push_intent("hosted_tool");
		}
		if !chat.safety.is_empty() {
			push_intent("safety");
		}
		if chat.sampling.seed.is_some() {
			push_intent("determinism");
		}
	}
	BeforeRequestDraft {
		provider: plan.provider.clone(),
		route: route.id.clone(),
		model: plan.model.clone(),
		operation: call.operation.kind(),
		scalars,
		headers,
		intents: intents.into_boxed_slice(),
		message_count,
		approx_prompt_tokens: None,
	}
}

fn narrow_before_request_intents(
	call: &mut Call,
	original: &[JsonValue],
	effective: Option<&[JsonValue]>,
	execution: &ExecutionContext,
) -> Result<(), Error> {
	let Some(effective) = effective else {
		return Ok(());
	};
	if effective.iter().any(|intent| !original.contains(intent)) {
		return Err(before_request_contract(execution, "before-request-intents-widened"));
	}
	let OperationCall::Chat(chat) = &mut call.operation else {
		return Ok(());
	};
	let retained = |kind: &str| {
		effective.iter().any(|intent| {
			intent
				.get("kind")
				.and_then(JsonValue::as_str)
				.is_some_and(|candidate| candidate == kind)
		})
	};
	let chat = Arc::make_mut(chat);
	if !retained("force_call") {
		chat.tool_choice = Setting::Unset;
	}
	if !retained("strict") && !retained("grammar") {
		chat.output = Setting::Unset;
	}
	if !retained("reasoning") {
		chat.reasoning = Setting::Unset;
	}
	if !retained("verbosity") {
		chat.verbosity = Setting::Unset;
	}
	if !retained("cache_retention") {
		chat.cache_retention = Setting::Unset;
	}
	if !retained("service_tier") {
		chat.service_tier = Setting::Unset;
	}
	if !retained("hosted_tool") {
		chat.hosted_tools = Arc::from([]);
	}
	if !retained("safety") {
		chat.safety = Arc::from([]);
	}
	if !retained("determinism") {
		chat.sampling.seed = None;
	}
	Ok(())
}

fn apply_before_request_mutation(
	encoded: &mut EncodedRequest,
	mutation: &BeforeRequestMutation,
	execution: &ExecutionContext,
	allow_message_mutation: bool,
) -> Result<(), Error> {
	if !mutation.body.is_empty() {
		if encoded.operation == OperationKind::Chat
			&& !allow_message_mutation
			&& mutation
				.body
				.keys()
				.any(|field| matches!(field.as_str(), "messages" | "input" | "contents" | "system"))
		{
			return Err(before_request_contract(
				execution,
				"before-request-message-mutation-prohibited",
			));
		}
		let BodySource::Bytes(bytes) = &encoded.body else {
			return Err(before_request_contract(execution, "before-request-body-is-not-bounded-json"));
		};
		let mut body = serde_json::from_slice::<JsonValue>(bytes)
			.map_err(|_| before_request_contract(execution, "before-request-body-is-not-json"))?;
		let body = body
			.as_object_mut()
			.ok_or_else(|| before_request_contract(execution, "before-request-body-is-not-object"))?;
		for (field, value) in &mutation.body {
			body.insert(field.clone(), value.clone());
		}
		let bytes = serde_json::to_vec(&body)
			.map_err(|_| before_request_contract(execution, "before-request-body-encode-failed"))?;
		if bytes.len() as u64 > encoded.bounds.request_body {
			return Err(before_request_contract(execution, "before-request-body-limit-exceeded"));
		}
		encoded.body = BodySource::bytes(bytes.into());
	}
	if !mutation.headers.is_empty() {
		let mut headers = encoded
			.headers
			.iter()
			.map(|header| (header.name.to_ascii_lowercase(), header.clone()))
			.collect::<BTreeMap<_, _>>();
		for (name, value) in &mutation.headers {
			let normalized = name.to_ascii_lowercase();
			if matches!(
				normalized.as_str(),
				"authorization" | "proxy-authorization" | "cookie" | "set-cookie"
			) {
				return Err(before_request_contract(
					execution,
					"before-request-credential-header-prohibited",
				));
			}
			normalized.parse::<HeaderName>().map_err(|_| {
				before_request_contract(execution, "before-request-header-name-invalid")
			})?;
			match value {
				Some(value) => {
					HeaderValue::from_str(value.as_str()).map_err(|_| {
						before_request_contract(execution, "before-request-header-value-invalid")
					})?;
					headers
						.insert(normalized, RequestHeader { name: name.clone(), value: value.clone() });
				},
				None => {
					headers.remove(&normalized);
				},
			}
		}
		encoded.headers = headers.into_values().collect::<Vec<_>>().into_boxed_slice();
	}
	Ok(())
}

fn before_request_denied(execution: &ExecutionContext, denial: BeforeRequestDenied) -> Error {
	let mut error = Error::new(
		ErrorKind::Authorization,
		ErrorPhase::Admission,
		RetryAction::Never,
		execution.receipt(),
	)
	.detail(ErrorDetail::provider(denial.reason));
	if let Some(code) = denial.code {
		error = error.code(code);
	}
	error
}

fn sanitize_bedrock_request_metadata(
	encoded: &mut EncodedRequest,
	execution: &ExecutionContext,
) -> Result<(), Error> {
	let BodySource::Bytes(bytes) = &encoded.body else {
		return Err(before_request_contract(execution, "bedrock-request-body-is-not-bounded-json"));
	};
	let mut body = serde_json::from_slice::<JsonValue>(bytes)
		.map_err(|_| before_request_contract(execution, "bedrock-request-body-is-not-json"))?;
	let object = body
		.as_object_mut()
		.ok_or_else(|| before_request_contract(execution, "bedrock-request-body-is-not-object"))?;
	let Some(metadata) = object.remove("requestMetadata") else {
		return Ok(());
	};
	if let Some(metadata) = sanitize_request_metadata_value(metadata) {
		object.insert("requestMetadata".to_owned(), metadata);
	}
	let bytes = serde_json::to_vec(&body)
		.map_err(|_| before_request_contract(execution, "bedrock-request-body-encode-failed"))?;
	if bytes.len() as u64 > encoded.bounds.request_body {
		return Err(before_request_contract(execution, "bedrock-request-body-limit-exceeded"));
	}
	encoded.body = BodySource::bytes(bytes.into());
	Ok(())
}

fn before_request_contract(execution: &ExecutionContext, reason: &'static str) -> Error {
	Error::new(
		ErrorKind::InvalidRequest,
		ErrorPhase::Encoding,
		RetryAction::Never,
		execution.receipt(),
	)
	.detail(ErrorDetail::protocol(ReasonId(Str::new_static(reason))))
}

fn merge_bedrock_headers(destination: &mut Box<[RequestHeader]>, configured: &[RequestHeader]) {
	let mut headers = destination
		.iter()
		.map(|header| (header.name.to_ascii_lowercase(), header.clone()))
		.collect::<BTreeMap<_, _>>();
	for header in configured {
		let name = header.name.to_ascii_lowercase();
		if SIGV4_OWNED_HEADERS.contains(&name.as_str())
			|| matches!(name.as_str(), "accept" | "content-type")
		{
			continue;
		}
		headers.insert(name.clone(), RequestHeader {
			name:  Str::new(name),
			value: header.value.clone(),
		});
	}
	*destination = headers.into_values().collect::<Vec<_>>().into_boxed_slice();
}

fn merge_static_headers(
	destination: &mut Box<[RequestHeader]>,
	configured: &[RequestHeader],
	execution: &ExecutionContext,
) -> Result<(), Error> {
	let mut values = BTreeMap::new();
	let mut merged = Vec::with_capacity(destination.len() + configured.len());
	for header in destination.iter().chain(configured) {
		let name = header.name.to_ascii_lowercase();
		match values.get(&name) {
			Some(value) if value == &header.value => {},
			Some(_) => return Err(contract_error(execution, "conflicting-public-request-header")),
			None => {
				values.insert(name, header.value.clone());
				merged.push(header.clone());
			},
		}
	}
	*destination = merged.into_boxed_slice();
	Ok(())
}

fn native_response(operation: &OperationCall) -> Option<NativeResponseFormat> {
	let OperationCall::Native(request) = operation else {
		return None;
	};
	Some(match request.response_framing {
		NativeResponseFraming::Json => NativeResponseFormat::Json,
		NativeResponseFraming::Sse => NativeResponseFormat::Sse,
		NativeResponseFraming::Bytes => NativeResponseFormat::Bytes,
	})
}

#[derive(Clone, Debug)]
enum RouteAccount {
	Anonymous { _account: AnonymousAccount },
	Brokered { _account: BrokeredAccount },
	Authenticated(Box<AccountSelection>),
}
#[derive(Clone, Debug)]
struct AnonymousAccount {
	_provider: ProviderId,
	_route:    RouteId,
}
#[derive(Clone, Debug)]
struct BrokeredAccount {
	_provider: ProviderId,
	_route:    RouteId,
}

#[derive(Clone)]
struct RouteAccountSelector {
	pool:          AccountPool,
	provider:      ProviderId,
	route:         RouteId,
	authenticated: bool,
	/// The invocation `--api-key` answers this route, so no stored account is
	/// selected, pinned, or rotated to.
	invocation:    bool,
}

impl AccountSelector<Call> for RouteAccountSelector {
	type Account = RouteAccount;

	fn select(&self, call: &Call, context: &ExecutionContext) -> Result<Self::Account, Error> {
		if !self.authenticated {
			return Ok(RouteAccount::Anonymous {
				_account: AnonymousAccount {
					_provider: self.provider.clone(),
					_route:    self.route.clone(),
				},
			});
		}
		if self.invocation {
			return Ok(RouteAccount::Brokered {
				_account: BrokeredAccount {
					_provider: self.provider.clone(),
					_route:    self.route.clone(),
				},
			});
		}
		let (previous_account, rotate, allow_brokered) = match context.attempt_action() {
			AttemptAction::Initial => (None, false, true),
			AttemptAction::RefreshCredential { previous_account } => (previous_account, false, false),
			AttemptAction::RotateAccount { previous_account } => (previous_account, true, false),
		};
		let affinity = context.session_affinity();
		let pin = call
			.affinity
			.account_pins
			.for_provider(&self.provider)
			.cloned();
		// A pinned account may belong to another principal than the bound
		// provider state: selection must reach it, and the session layer then
		// reseeds the account-bound state instead of this selector refusing it.
		let preserve_principal = affinity.is_some() && pin.is_none();
		let quota_scope = omp_catalog::has_quota_tier_policy(self.provider.as_str()).then(|| {
			let model = match &call.target {
				Target::Model(model) | Target::Provider { model, .. } | Target::Route { model, .. } => {
					Some(model.as_str())
				},
				Target::ProviderService(_) | Target::RouteService(_) => None,
			};
			Str::new(
				model
					.and_then(|model| omp_catalog::quota_display_tier(self.provider.as_str(), model))
					.unwrap_or("unknown"),
			)
		});
		let request = AccountSelectionRequest {
			provider: self.provider.clone(),
			route: self.route.clone(),
			affinity: affinity.as_ref().map(|binding| binding.principal.clone()),
			previous_account,
			previous_principal: affinity.as_ref().map(|binding| binding.principal.clone()),
			rotate,
			rotation: RotationPolicy { allow_account_change: true, preserve_principal },
			now: SystemTime::now(),
			quota_scope,
			pin: pin.clone(),
		};
		let failure = match self.pool.select(&request) {
			Ok(selection) => return Ok(RouteAccount::Authenticated(Box::new(selection))),
			Err(failure) => failure,
		};
		if let Some(pin) = &pin {
			// A pin is exclusive: never the brokered or another account.
			let reason = PinFailure::diagnose(pin, &failure.receipt);
			return Err(
				Error::new(
					ErrorKind::AccountDisabled,
					ErrorPhase::Authentication,
					RetryAction::Never,
					context.receipt(),
				)
				.provider(self.provider.clone())
				.route(self.route.clone())
				.code(Str::new_static(reason.into()))
				.detail(ErrorDetail::AccountPin { provider: self.provider.clone(), reason }),
			);
		}
		if failure.receipt.candidates.is_empty() && allow_brokered {
			return Ok(RouteAccount::Brokered {
				_account: BrokeredAccount {
					_provider: self.provider.clone(),
					_route:    self.route.clone(),
				},
			});
		}
		Err(credential_failure(context, &self.provider, CredentialFailure::NoRotationCandidate))
	}

	fn routing(&self, account: &Self::Account) -> Option<AccountRoutingContext> {
		match account {
			RouteAccount::Anonymous { .. } | RouteAccount::Brokered { .. } => None,
			RouteAccount::Authenticated(selection) => Some(selection.routing.clone()),
		}
	}
}

#[derive(Clone)]
struct RouteLeaseProvider {
	source:         CredentialBroker,
	shapers:        Arc<CredentialShaperRegistry>,
	provider:       omp_catalog::ProviderId,
	route_base_url: Str,
	specs:          Box<[AuthSpecId]>,
	/// The kind of a stored static secret the next launch re-stores as one
	/// `specs` lease ([`crate::auth::broker::restored_static_secret_kind`]),
	/// which decides the remedy of a kind mismatch on a stored static secret
	/// ([`LeaseOrigin::StoredSecret`]).
	restored_kind:  Option<CredentialKind>,
	authenticated:  bool,
	required:       bool,
}

fn attribute_invocation_lease(context: &ExecutionContext, lease: &CredentialLease) {
	if lease.source_tag() != Some(INVOCATION_TAG) {
		return;
	}
	context.set_session_state(None);
	let mut routing = context.account_routing().unwrap_or_default();
	routing.account = Some(lease.meta().account.clone());
	routing.principal = Some(lease.meta().principal.clone());
	routing.credential_generation = Some(lease.meta().generation);
	context.set_account_routing(routing);
}

impl LeaseProvider<Call, RouteAccount> for RouteLeaseProvider {
	type Lease = Option<CredentialLease>;

	type Future<'a> = impl Future<Output = Result<Self::Lease, Error>> + Send + 'a;

	fn acquire<'a>(
		&'a self,
		call: &'a Call,
		account: &'a RouteAccount,
		context: &'a ExecutionContext,
	) -> Self::Future<'a> {
		async move {
			if !self.authenticated {
				return match account {
					RouteAccount::Anonymous { .. } => Ok(None),
					RouteAccount::Brokered { .. } | RouteAccount::Authenticated(_) => {
						Err(contract_error(context, "authenticated-account-on-anonymous-route"))
					},
				};
			}
			let (account, principal) = match account {
				RouteAccount::Brokered { .. } => (None, None),
				RouteAccount::Authenticated(selection) => {
					(Some(selection.record.account.clone()), Some(selection.record.principal.clone()))
				},
				RouteAccount::Anonymous { .. } => {
					return Err(contract_error(context, "anonymous-account-on-authenticated-route"));
				},
			};
			let mut resolved = None;
			// Why the specs tried so far produced nothing, kept instead of
			// discarded ([`keep_significant`]); none is an absent source.
			let mut failure = None;
			let refreshing =
				matches!(context.attempt_action(), AttemptAction::RefreshCredential { .. });
			for spec in &self.specs {
				let need = CredentialNeed {
					spec:        spec.clone(),
					account:     account.clone(),
					principal:   principal.clone(),
					valid_after: SystemTime::now(),
				};
				match if refreshing {
					self.source.refresh_account(need).await
				} else {
					self.source.lease(need).await
				} {
					Ok(lease) => {
						resolved = Some(lease);
						break;
					},
					// No source of this spec has a credential, or (refreshing) none
					// renews it.
					Err(CredentialError::Unavailable) => {},
					// A brokered request has no stored credential to blame; a
					// selected stored account that cannot lease is named.
					Err(CredentialError::InvalidSource) => {
						if account.is_some() {
							keep_significant(&mut failure, CredentialFailure::UnusableStoredCredential);
						}
					},
					Err(CredentialError::KindMismatch { expected, actual, origin }) => {
						// Only a stored static secret is ever re-stored: an OAuth
						// access token leases as `bearer` too, and its row never
						// moves.
						let remedy =
							if origin == LeaseOrigin::StoredSecret && self.restored_kind == Some(actual) {
								KindMismatchRemedy::Restart
							} else {
								KindMismatchRemedy::StoreRequiredKind
							};
						keep_significant(&mut failure, CredentialFailure::KindMismatch {
							expected,
							actual,
							remedy,
						});
					},
					Err(CredentialError::StorageLocked { cause }) => {
						keep_significant(&mut failure, CredentialFailure::StorageLocked { cause });
					},
					Err(CredentialError::Cancelled) => {
						return Err(
							Error::new(
								ErrorKind::Cancelled,
								ErrorPhase::Authentication,
								RetryAction::Never,
								context.receipt(),
							)
							.committed(context.is_committed()),
						);
					},
					Err(CredentialError::RefreshFailed) => {
						return Err(credential_failure(
							context,
							&self.provider,
							CredentialFailure::RefreshFailed,
						));
					},
					Err(
						CredentialError::Expired
						| CredentialError::StaleGeneration
						| CredentialError::SourceFailure,
					) if refreshing => {
						return Err(credential_failure(
							context,
							&self.provider,
							CredentialFailure::RefreshFailed,
						));
					},
					Err(CredentialError::Expired) => {
						return Err(credential_failure(
							context,
							&self.provider,
							CredentialFailure::Expired,
						));
					},
					Err(CredentialError::StaleGeneration | CredentialError::SourceFailure) => {
						return Err(credential_failure(
							context,
							&self.provider,
							CredentialFailure::SourceFailed,
						));
					},
				}
			}
			let Some(lease) = resolved else {
				// A locked store fails even an optional route, as any store
				// failure did; a wrong-kind credential there still falls back
				// to an anonymous request.
				let reason = match failure {
					Some(locked @ CredentialFailure::StorageLocked { .. }) => locked,
					_ if !self.required && !refreshing => return Ok(None),
					Some(reason) => reason,
					None if refreshing => CredentialFailure::NotRenewable,
					None => CredentialFailure::NoSource,
				};
				return Err(credential_failure(context, &self.provider, reason));
			};
			attribute_invocation_lease(context, &lease);
			let Some(shaper) = self.shapers.get(&self.provider) else {
				return Ok(Some(lease));
			};
			if lease.scalar_secret().is_none() {
				return Ok(Some(lease));
			}
			// The call budget bounds provider I/O; shapers additionally self-cap
			// network work at ten seconds.
			let deadline = shaper_deadline(call, context);
			Ok(Some(shape_scalar_lease(shaper, lease, &self.route_base_url, deadline).await))
		}
	}
}

/// The pre-send authentication failure a route reports when no credential
/// could be used, naming why ([`Error::credential`]). Route reselection stays
/// open as before, so a planned fallback with its own credential still runs.
fn credential_failure(
	context: &ExecutionContext,
	provider: &ProviderId,
	reason: CredentialFailure,
) -> Error {
	Error::credential(provider.clone(), reason, RetryAction::ReselectRoute, context.receipt())
}

/// Keeps the more significant of `kept` and `reason` for a route whose
/// authentications leased nothing: a locked store, then a stored credential
/// of the wrong kind, then a selected stored credential no authentication can
/// lease. Of two equally significant reasons the first is kept.
fn keep_significant(kept: &mut Option<CredentialFailure>, reason: CredentialFailure) {
	const fn significance(reason: CredentialFailure) -> u8 {
		match reason {
			CredentialFailure::StorageLocked { .. } => 3,
			CredentialFailure::KindMismatch { .. } => 2,
			CredentialFailure::UnusableStoredCredential => 1,
			CredentialFailure::NoRotationCandidate
			| CredentialFailure::NoSource
			| CredentialFailure::Expired
			| CredentialFailure::NotRenewable
			| CredentialFailure::RefreshFailed
			| CredentialFailure::SourceFailed => 0,
		}
	}
	if kept.is_none_or(|kept| significance(reason) > significance(kept)) {
		*kept = Some(reason);
	}
}

async fn shape_scalar_lease(
	shaper: &ProviderShaper,
	lease: CredentialLease,
	route_base_url: &str,
	deadline: Option<Instant>,
) -> CredentialLease {
	let Some(raw) = lease.scalar_secret() else {
		return lease;
	};
	match shaper.shape(raw, route_base_url, deadline).await {
		Some(shaped) => lease.with_shape(shaped),
		None => lease,
	}
}

fn shaper_deadline(call: &Call, context: &ExecutionContext) -> Option<Instant> {
	let budget_deadline = call.budget.max_elapsed.and_then(|max_elapsed| {
		Instant::now().checked_add(max_elapsed.saturating_sub(context.elapsed()))
	});
	match (call.deadline, budget_deadline) {
		(Some(deadline), Some(budget_deadline)) => Some(deadline.min(budget_deadline)),
		(Some(deadline), None) => Some(deadline),
		(None, Some(budget_deadline)) => Some(budget_deadline),
		(None, None) => None,
	}
}

const SIGV4_OWNED_HEADERS: [&str; 6] = [
	"authorization",
	"content-length",
	"host",
	"x-amz-content-sha256",
	"x-amz-date",
	"x-amz-security-token",
];

fn protect_owned_headers(headers: &mut Box<[RequestHeader]>, bedrock_invocation: bool) {
	let original = mem::take(headers).into_vec();
	let mut retained = Vec::with_capacity(original.len() + usize::from(bedrock_invocation) * 2);
	for header in original {
		let name = header.name.to_ascii_lowercase();
		if SIGV4_OWNED_HEADERS.contains(&name.as_str())
			|| (bedrock_invocation && matches!(name.as_str(), "accept" | "content-type"))
		{
			continue;
		}
		retained.push(RequestHeader { name: Str::new(name), value: header.value });
	}
	if bedrock_invocation {
		retained.push(RequestHeader::new_static("content-type", "application/json"));
		retained.push(RequestHeader::new_static("accept", "application/vnd.amazon.eventstream"));
	}
	*headers = retained.into_boxed_slice();
}

fn protect_sigv4_headers(request: &mut TransportRequest, bedrock_invocation: bool) {
	protect_owned_headers(&mut request.encoded.headers, bedrock_invocation);
}

#[derive(Clone)]
struct RouteCredentialApplier {
	auth:     Box<[AuthSpec]>,
	required: bool,
	mantle:   bool,
}

impl CredentialApplier<RouteAccount, Option<CredentialLease>> for RouteCredentialApplier {
	fn apply(
		&self,
		_: &RouteAccount,
		lease: Option<CredentialLease>,
		request: &mut TransportRequest,
		context: &ExecutionContext,
	) -> Result<(), Error> {
		match (self.auth.first(), lease) {
			(Some(AuthSpec::None), None) => Ok(()),
			(Some(AuthSpec::None), Some(_)) => {
				Err(authentication_error(context, "credential-on-anonymous-route"))
			},
			(None, _) => Err(authentication_error(context, "credential-auth-spec-missing")),
			(_, None) if !self.required => Ok(()),
			(_, None) => Err(authentication_error(context, "credential-lease-missing")),
			(_, Some(lease)) => {
				let signing_scope = endpoint_scope(request.encoded.uri.as_str());
				for auth in &self.auth {
					let prepared = match (auth, signing_scope) {
						(AuthSpec::AwsSigV4(spec), Some((service, region)))
							if spec.service != service || spec.region != region =>
						{
							let mut resolved = spec.clone();
							resolved.service = Str::new(service);
							resolved.region = Str::new(region);
							lease.prepare(&AuthSpec::AwsSigV4(resolved), SystemTime::now())
						},
						_ => lease.prepare(auth, SystemTime::now()),
					};
					match prepared {
						Ok(credentials) => {
							if let AuthSpec::AwsSigV4(spec) = auth {
								let bedrock_invocation = request.encoded.operation == OperationKind::Chat
									&& signing_scope.map_or(spec.service == "bedrock", |(service, _)| {
										service == "bedrock"
									});
								protect_sigv4_headers(request, bedrock_invocation);
							}
							request.credentials = Some(credentials);
							return Ok(());
						},
						Err(CredentialApplyError::WrongKind { .. }) => {},
						Err(_) => {
							return Err(authentication_error(context, "credential-application-failed"));
						},
					}
				}
				Err(authentication_error(context, "credential-application-failed"))
			},
		}
	}

	fn map_response_error(&self, scheme: Option<AuthScheme>, error: Error) -> Error {
		if self.mantle {
			map_mantle_auth_rejection(scheme, error)
		} else {
			error
		}
	}
}

#[derive(Clone)]
struct PoolRateLimiter {
	pool: AccountPool,
}

impl<R> RateLimiter<R> for PoolRateLimiter {
	type Future<'a>
		= Ready<Result<(), Error>>
	where
		R: 'a;

	fn reserve<'a>(&'a self, _: &'a R, context: &'a ExecutionContext) -> Self::Future<'a> {
		let result = context.checkpoint(ErrorPhase::Readiness).and_then(|()| {
			let Some(account) = context
				.account_routing()
				.and_then(|routing| routing.account)
			else {
				return Ok(());
			};
			match self
				.pool
				.rate_state(&account)
				.availability(SystemTime::now())
			{
				RateAvailability::Available => Ok(()),
				RateAvailability::Delayed { until } => Err(Error::new(
					ErrorKind::RateLimited,
					ErrorPhase::Admission,
					RetryAction::SameRoute {
						after: until.duration_since(SystemTime::now()).unwrap_or_default(),
					},
					context.receipt(),
				)),
				RateAvailability::ExhaustedUnknownReset => Err(Error::new(
					ErrorKind::RateLimited,
					ErrorPhase::Admission,
					RetryAction::Never,
					context.receipt(),
				)),
			}
		});
		ready(result)
	}
}

#[derive(Clone)]
struct PlannedIntent {
	route: RouteId,
}
impl IntentPlanner for PlannedIntent {
	fn negotiate(&self, call: &mut Call, _: &mut ExecutionReceipt) -> Result<(), Error> {
		let Some(plan) = &call.execution else {
			return Err(Error::planning(
				ErrorKind::ProviderContractMismatch,
				ErrorDetail::protocol(ReasonId(sf!("execution-plan-missing"))),
				ExecutionReceipt::default(),
			));
		};
		if plan.route != self.route {
			return Err(Error::planning(
				ErrorKind::ProviderContractMismatch,
				ErrorDetail::protocol(ReasonId(sf!("planned-route-mismatch"))),
				ExecutionReceipt::default(),
			));
		}
		Ok(())
	}
}
#[derive(Clone, Copy)]
struct CanonicalSemantic;
impl SemanticPolicy<Call> for CanonicalSemantic {
	fn condition(&self, call: &Call) -> Option<GateCondition> {
		let OperationCall::Chat(chat) = &call.operation else {
			return None;
		};
		if call.execution.as_ref().is_some_and(|plan| {
			plan.policy_model.is_some()
				&& plan.wire_policy.streaming.harmony_leak_mitigation == Some(true)
		}) {
			return Some(GateCondition::WholeAttempt);
		}
		if let Setting::Require(ToolChoice::Named(tool)) = &chat.tool_choice {
			return Some(GateCondition::ToolCallReady { tool: tool.clone() });
		}
		if matches!(chat.output, Setting::Require(_)) {
			return Some(GateCondition::ValidStructuredOutput);
		}
		if matches!(chat.tool_choice, Setting::Require(ToolChoice::Required)) {
			return Some(GateCondition::WholeAttempt);
		}
		Some(GateCondition::FirstValidEvent)
	}

	fn max_retries(&self, call: &Call) -> u32 {
		call.budget.max_attempts.saturating_sub(1)
	}
}

fn unavailable(route: &RouteDef, reason: &'static str) -> RouteUnavailable {
	RouteUnavailable::new(route.id.clone(), ReasonId(Str::new(reason)), None)
}

fn discovery_codec_unavailable(
	route: &RouteDef,
	reason: &'static str,
	source: Error,
) -> RouteUnavailable {
	RouteUnavailable::DiscoveryCodec {
		route: route.id.clone(),
		reason: ReasonId(Str::new(reason)),
		operation: Some(OperationKind::DiscoverModels),
		source,
	}
}

fn authentication_error(context: &ExecutionContext, reason: &'static str) -> Error {
	Error::new(
		ErrorKind::Authentication,
		ErrorPhase::Authentication,
		RetryAction::Never,
		context.receipt(),
	)
	.detail(ErrorDetail::protocol(ReasonId(Str::new(reason))))
}

fn azure_configuration_error(context: &ExecutionContext, reason: &'static str) -> Error {
	Error::new(
		ErrorKind::InvalidRequest,
		ErrorPhase::Encoding,
		RetryAction::Never,
		context.receipt(),
	)
	.detail(ErrorDetail::protocol(ReasonId(Str::new(reason))))
}

fn attempt_deadline_error(attempt: &TransportAttempt) -> Error {
	Error::new(
		ErrorKind::DeadlineExceeded,
		ErrorPhase::Connecting,
		RetryAction::Never,
		ExecutionReceipt::default(),
	)
	.provider(attempt.provider.clone())
	.route(attempt.route.clone())
	.request_id(attempt.request_id.clone())
	.detail(ErrorDetail::protocol(ReasonId(sf!("provider-setup-exhausted-attempt-budget",))))
}

fn contract_error_for_attempt(attempt: &TransportAttempt, reason: &'static str) -> Error {
	Error::new(
		ErrorKind::ProviderContractMismatch,
		ErrorPhase::Encoding,
		RetryAction::Never,
		ExecutionReceipt::default(),
	)
	.provider(attempt.provider.clone())
	.route(attempt.route.clone())
	.request_id(attempt.request_id.clone())
	.detail(ErrorDetail::protocol(ReasonId(Str::new(reason))))
}

fn contract_error(context: &ExecutionContext, reason: &'static str) -> Error {
	Error::new(
		ErrorKind::ProviderContractMismatch,
		ErrorPhase::Encoding,
		RetryAction::Never,
		context.receipt(),
	)
	.detail(ErrorDetail::protocol(ReasonId(Str::new(reason))))
}

fn session_trust_error(context: &ExecutionContext) -> Error {
	Error::new(
		ErrorKind::SessionExpired,
		ErrorPhase::Session,
		RetryAction::ReseedSession,
		context.receipt(),
	)
	.detail(ErrorDetail::protocol(ReasonId(sf!("dynamic-endpoint-trust-domain-changed",))))
}

#[cfg(test)]
mod tests {
	use std::sync::atomic::{AtomicUsize, Ordering};

	use bytes::Bytes;
	use http::{Request, header::AUTHORIZATION};
	use omp_catalog::{ModelKey, PolicyModel, ProviderId, WireTarget};
	use omp_core::SecretString;

	use super::*;
	use crate::{
		account::{AccountPin, SessionAccountPins},
		auth::{
			AuthScheme, AuthSpec, CredentialLease, CredentialShaperRegistry, LeaseMeta,
			ShapedCredential,
		},
		call::{
			ChatRequest, ContentPart, DiscoveryRequest, ForcedCall, HostedTool, InferenceAttribution,
			Message, NegotiationPolicy, OpaqueJson, RealtimeRequest, Role, Sampling, Target,
			ToolDefinition, ToolInputConstraint,
		},
		codec::{
			ProviderResponseObservation, ProviderResponseObserver, RequestMethod, SizeBounds,
			google_cca::AntigravityFingerprint,
		},
		id::{AccountId, ConversationId, PrincipalId, ProjectId, RequestId, Revision, ToolCallId},
		operation::discovery::CatalogDiscoveryProjectorError,
		plan::{
			CapabilityAvailability, ExecutionPlan, FallbackScope, ReplayPlan, RouteHealth,
			RuntimeRouteEvidence,
		},
		receipt::ExecutionBudget,
		session::{CredentialGenerationPolicy, PendingServerStateBinding},
	};

	#[test]
	fn configured_provider_timeout_outranks_the_ambient_default() {
		let ambient = Duration::from_secs(60);
		// Unset keeps the ambient default.
		assert_eq!(configured_transport_timeout(ambient, 0, None), ambient);
		// A configured ceiling above the ambient default must win. Network
		// transports pass `framework: None`; passing the ambient default back
		// as a framework bound is what pinned every attempt at 60s, so a slow
		// first token failed as `stream.first-event` whatever the setting said.
		assert_eq!(
			configured_transport_timeout(ambient, 300, None),
			Duration::from_secs(300),
			"a configured ceiling above the ambient default must raise it",
		);
		// Lowering still works.
		assert_eq!(configured_transport_timeout(ambient, 15, None), Duration::from_secs(15));
		// A real framework ceiling (local backends) still binds, since waiting
		// past it cannot succeed.
		assert_eq!(
			configured_transport_timeout(ambient, 300, Some(Duration::from_secs(20))),
			Duration::from_secs(20),
			"a genuine framework ceiling still caps the configured value",
		);
	}
	struct BeforeRequestObserver {
		subscribed: bool,
		calls:      AtomicUsize,
		result:     Result<BeforeRequestMutation, BeforeRequestDenied>,
	}

	impl crate::codec::ProviderHookObserver for BeforeRequestObserver {}

	impl ProviderResponseObserver for BeforeRequestObserver {
		fn subscribed(&self) -> bool {
			false
		}

		fn observe(&self, _: ProviderResponseObservation) {}

		fn before_request_subscribed(&self) -> bool {
			self.subscribed
		}

		fn before_request<'a>(
			&'a self,
			_: &'a BeforeRequestDraft,
		) -> Pin<
			Box<dyn Future<Output = Result<BeforeRequestMutation, BeforeRequestDenied>> + Send + 'a>,
		> {
			self.calls.fetch_add(1, Ordering::Relaxed);
			let result = self.result.clone();
			Box::pin(async move { result })
		}
	}

	#[test]
	fn route_unavailable_preserves_typed_projector_source() {
		let unavailable = RouteUnavailable::CatalogDiscoveryProjector {
			route:     RouteId::from("openai"),
			reason:    ReasonId(sf!("catalog-discovery-projector-invalid")),
			operation: None,
			source:    CatalogDiscoveryProjectorError::ProviderDiscoveryDefaultsMissing,
		};
		let source = std::error::Error::source(&unavailable).expect("typed source");
		assert!(
			source
				.downcast_ref::<CatalogDiscoveryProjectorError>()
				.is_some(),
			"route-unavailable source must remain the concrete projector error",
		);
		let planning = crate::registry::route_unavailable_error(&unavailable, OperationKind::Chat);
		let source = std::error::Error::source(&planning).expect("planning error typed source");
		assert!(
			source
				.downcast_ref::<CatalogDiscoveryProjectorError>()
				.is_some(),
			"planning error must preserve the concrete projector source",
		);
	}

	#[test]
	fn aws_registry_gates_only_routes_backed_by_sigv4_provider_auth() {
		let catalog = Catalog::embedded();
		for provider in ["amazon-bedrock", "bedrock-mantle"] {
			let route = catalog
				.routes()
				.iter()
				.find(|route| route.provider.as_str() == provider)
				.unwrap_or_else(|| panic!("{provider} route"));
			assert!(route_uses_aws_sigv4(catalog, route));
		}
		let openai = catalog
			.routes()
			.iter()
			.find(|route| route.provider.as_str() == "openai")
			.expect("OpenAI route");
		assert!(!route_uses_aws_sigv4(catalog, openai));
	}

	#[test]
	fn aws_registry_unavailability_preserves_typed_secret_free_source() {
		let unavailable = RouteUnavailable::AwsRegistry {
			route:     RouteId::from("bedrock-mantle/primary"),
			reason:    ReasonId(sf!("aws-registry-discovery-failed")),
			operation: None,
			source:    AwsCredentialError::Unavailable,
		};
		let source = std::error::Error::source(&unavailable).expect("typed source");
		assert!(source.downcast_ref::<AwsCredentialError>().is_some());
		let planning = crate::registry::route_unavailable_error(&unavailable, OperationKind::Chat);
		let source = std::error::Error::source(&planning).expect("planning error typed source");
		assert!(source.downcast_ref::<AwsCredentialError>().is_some());
		assert!(!format!("{planning:?}").contains("credential value"));
	}

	#[test]
	fn bundled_openai_and_openrouter_discovery_projectors_construct() {
		let catalog = Catalog::embedded();
		for provider in ["openai", "openrouter"] {
			let route = catalog
				.routes()
				.iter()
				.find(|route| route.provider.as_str() == provider && route.discovery.is_some())
				.unwrap_or_else(|| panic!("{provider} discovery route"));
			CatalogDiscoveryProjector::for_route(catalog, route)
				.unwrap_or_else(|source| panic!("{provider} projector: {source}"));
		}
	}

	fn request_hook_chat() -> ChatRequest {
		ChatRequest {
			messages:          Arc::from([]),
			tools:             Arc::from([]),
			hosted_tools:      Arc::from([HostedTool::CodeExecution]),
			tool_choice:       Setting::Prefer(ToolChoice::Required),
			output:            Setting::Unset,
			reasoning:         Setting::Unset,
			verbosity:         Setting::Unset,
			cache_retention:   Setting::Unset,
			service_tier:      Setting::Unset,
			sampling:          Sampling::default(),
			max_output_tokens: Some(128),
			top_logprobs:      None,
			safety:            Arc::from([]),
			negotiation:       NegotiationPolicy::default(),
			forced_call:       None,
		}
	}

	fn lease(provider: &ProviderId<str>, secret: &str) -> CredentialLease {
		CredentialLease::bearer(
			LeaseMeta {
				account:    AccountId::new("account"),
				principal:  PrincipalId::new(provider.as_str()),
				generation: 1,
				expires_at: None,
			},
			SecretString::from(secret.to_owned()),
		)
	}
	#[test]
	fn cloudflare_gateway_route_fills_account_and_gateway_from_validated_config() {
		let catalog = Catalog::embedded();
		let route = catalog
			.routes()
			.iter()
			.find(|route| route.provider.as_str() == CLOUDFLARE_GATEWAY_PROVIDER)
			.expect("Cloudflare AI Gateway route");
		// The shipped route still carries literal placeholders: this is the
		// defect ADR 0059 names, and the reason the resolver must run.
		assert!(route.endpoint.base_url.as_str().contains("{account}"));
		let config = CloudflareGatewayConfig::new("acct-1", "my-gateway").expect("valid");
		let context = ExecutionContext::new(ExecutionBudget::default());
		let target = WireTarget {
			route:      route.id.clone(),
			codec:      route.codec.clone(),
			endpoint:   route.endpoint.clone(),
			wire_model: sf!("claude-sonnet-4-5").into(),
		};
		let (effective, target) =
			cloudflare_effective_route(route, Some(&target), Some(&config), &context)
				.expect("resolves")
				.expect("cloudflare route");
		assert_eq!(
			effective.endpoint.base_url.as_str(),
			"https://gateway.ai.cloudflare.com/v1/acct-1/my-gateway/anthropic"
		);
		assert_eq!(effective.trust_domain.origin.as_str(), "https://gateway.ai.cloudflare.com");
		assert_eq!(target.expect("target").endpoint, effective.endpoint);
		for part in ["{", "}", "<", ">"] {
			assert!(!effective.endpoint.base_url.as_str().contains(part), "{part}");
		}
	}

	#[test]
	fn cloudflare_gateway_without_config_fails_and_never_yields_a_placeholder_url() {
		let catalog = Catalog::embedded();
		let context = ExecutionContext::new(ExecutionBudget::default());
		let mut checked = 0;
		for route in catalog
			.routes()
			.iter()
			.filter(|route| route.provider.as_str() == CLOUDFLARE_GATEWAY_PROVIDER)
		{
			checked += 1;
			let error = cloudflare_effective_route(route, None, None, &context)
				.expect_err("unconfigured gateway must refuse the call");
			assert_eq!(error.kind, ErrorKind::InvalidRequest);
		}
		assert!(checked > 0, "no Cloudflare route in the catalog");
	}

	#[test]
	fn cloudflare_gateway_config_refuses_unsafe_coordinates() {
		assert!(CloudflareGatewayConfig::new("acct-1", "gw").is_ok());
		for bad in ["", "a/b", "a b", "a?q", "a#f", "a:b", "a.b", "..", "{account}", "a\u{e9}"] {
			assert_eq!(
				CloudflareGatewayConfig::new(bad, "gw"),
				Err("cloudflare-account-invalid"),
				"account {bad:?}"
			);
			assert_eq!(
				CloudflareGatewayConfig::new("acct", bad),
				Err("cloudflare-gateway-invalid"),
				"gateway {bad:?}"
			);
		}
	}

	#[test]
	fn other_providers_are_untouched_by_the_cloudflare_resolver() {
		let catalog = Catalog::embedded();
		let context = ExecutionContext::new(ExecutionBudget::default());
		let config = CloudflareGatewayConfig::new("acct", "gw").expect("valid");
		for route in catalog
			.routes()
			.iter()
			.filter(|route| route.provider.as_str() != CLOUDFLARE_GATEWAY_PROVIDER)
		{
			assert!(
				cloudflare_effective_route(route, None, Some(&config), &context)
					.expect("never errors for other providers")
					.is_none(),
				"{}",
				route.id
			);
		}
	}

	#[test]
	fn azure_routes_shape_chat_deployments_and_resource_scoped_responses() {
		let catalog = Catalog::embedded();
		let chat = catalog
			.routes()
			.iter()
			.find(|route| route.provider.as_str() == "azure" && route.codec.as_str() == "openai-chat")
			.expect("Azure chat route");
		let responses = catalog
			.routes()
			.iter()
			.find(|route| {
				route.provider.as_str() == "azure" && route.codec.as_str() == "openai-responses"
			})
			.expect("Azure Responses route");
		let config = AzureEndpointConfig::new(
			"https://resource.openai.azure.com",
			Some(sf!("production-gpt")),
			Arc::new(BTreeMap::new()),
			Some(sf!("2025-04-01-preview")),
		)
		.expect("valid Azure configuration");
		let context = ExecutionContext::new(ExecutionBudget::default());
		for (route, expected) in [
			(chat, "https://resource.openai.azure.com/openai/deployments/production-gpt"),
			(responses, "https://resource.openai.azure.com/openai"),
		] {
			let target = WireTarget {
				route:      route.id.clone(),
				codec:      route.codec.clone(),
				endpoint:   route.endpoint.clone(),
				wire_model: sf!("gpt-5").into(),
			};
			let (effective, target) =
				azure_effective_route(route, Some(&target), Some(&config), &context)
					.expect("Azure endpoint shapes")
					.expect("Azure route");
			assert_eq!(effective.endpoint.base_url.as_str(), expected);
			assert_eq!(target.endpoint.base_url.as_str(), expected);
			assert_eq!(effective.endpoint.api_version.as_deref(), Some("2025-04-01-preview"));
			assert_eq!(effective.trust_domain.origin.as_str(), "https://resource.openai.azure.com");
			if route.codec.as_str() == "openai-responses" {
				assert_eq!(
					target.wire_model.as_str(),
					"production-gpt",
					"Azure Responses body.model must use the deployment mapping",
				);
				let provider = catalog.provider(&route.provider).expect("Azure provider");
				let policy = catalog
					.wire_policy(&provider.wire_policy)
					.expect("Azure provider wire policy");
				let mut chat = request_hook_chat();
				chat.hosted_tools = Arc::from([]);
				chat.tool_choice = Setting::Unset;
				let operation = OperationCall::Chat(Arc::new(chat));
				let request_id = RequestId::new("azure-responses-deployment");
				let encode_context = EncodeContext {
					request_id: &request_id,
					route: &effective,
					target: Some(&target),
					policy,
					..EncodeContext::default()
				};
				let encoded = OpenAiResponsesCodec::new(OpenAiResponsesOptions::default())
					.encode(&encode_context, &operation)
					.expect("Azure Responses request encodes");
				let BodySource::Bytes(body) = encoded.body else {
					panic!("Azure Responses request body is buffered JSON");
				};
				let body: JsonValue = serde_json::from_slice(&body).expect("request JSON");
				assert_eq!(body["model"], "production-gpt");
			}
		}
	}

	#[test]
	fn official_responses_statefulness_uses_compiled_provider_capability() {
		let catalog = Catalog::embedded();
		let official = catalog
			.routes()
			.iter()
			.find(|route| {
				route.provider.as_str() == "openai" && route.codec.as_str() == "openai-responses"
			})
			.expect("official OpenAI Responses route");
		let proxy = catalog
			.routes()
			.iter()
			.find(|route| {
				route.provider.as_str() == "github-copilot"
					&& route.codec.as_str() == "openai-responses"
			})
			.expect("Responses-compatible proxy route");
		assert!(stateful_responses(catalog, official));
		assert!(
			!stateful_responses(catalog, proxy),
			"a Responses path alone is not evidence of server-state support",
		);
		let mut restricted = official.clone();
		restricted.capability_limits.disable_server_state = true;
		assert!(
			!stateful_responses(catalog, &restricted),
			"route restrictions override the affirmative provider capability",
		);
	}

	#[test]
	fn first_function_call_axis_reaches_cca_gemini_projection() {
		let catalog = Catalog::embedded();
		let (model, route, wire_model) = catalog
			.models()
			.iter()
			.find_map(|model| {
				let policy = catalog.wire_policy(&model.wire_policy)?;
				if policy
					.tool
					.requires_skip_thought_signature_on_first_function_call
					!= Some(true)
				{
					return None;
				}
				model.routes.iter().find_map(|route_id| {
					let route = catalog.route(route_id)?;
					(route.codec.as_str() == "google-cca"
						&& route.codec_profile == CodecProfile::GoogleCcaGeminiCli)
						.then(|| {
							let wire_model = model
								.wire_ids
								.iter()
								.find(|(candidate, _)| candidate == route_id)
								.map(|(_, wire_model)| wire_model.clone())
								.expect("CCA wire model");
							(model, route, wire_model)
						})
				})
			})
			.expect("CCA Gemini model carrying the first-call signature axis");
		let policy = catalog
			.wire_policy(&model.wire_policy)
			.expect("CCA model wire policy");
		let binding = codec_binding(route, &test_cca(), false, false, None, None, None)
			.expect("CCA codec binding");
		let request = ChatRequest {
			messages:          Arc::from([Message {
				role:    Role::Assistant,
				content: Arc::from([
					ContentPart::ToolCall {
						call:      ToolCallId::new("call-1"),
						name:      sf!("lookup"),
						arguments: OpaqueJson::new(json!({"key": "a"})),
						proof:     None,
					},
					ContentPart::ToolCall {
						call:      ToolCallId::new("call-2"),
						name:      sf!("lookup"),
						arguments: OpaqueJson::new(json!({"key": "b"})),
						proof:     None,
					},
				]),
				name:    None,
			}]),
			tools:             Arc::from([]),
			hosted_tools:      Arc::from([]),
			tool_choice:       Setting::Unset,
			output:            Setting::Unset,
			reasoning:         Setting::Unset,
			verbosity:         Setting::Unset,
			cache_retention:   Setting::Unset,
			service_tier:      Setting::Unset,
			sampling:          Sampling::default(),
			max_output_tokens: None,
			top_logprobs:      None,
			safety:            Arc::from([]),
			negotiation:       NegotiationPolicy::default(),
			forced_call:       None,
		};
		let target = WireTarget {
			route: route.id.clone(),
			codec: route.codec.clone(),
			endpoint: route.endpoint.clone(),
			wire_model,
		};
		let request_id = RequestId::new("cca-first-function-call-signature");
		let policy_model = PolicyModel::from(model);
		let account = AccountRoutingContext {
			project: Some(ProjectId::new("test-project")),
			..AccountRoutingContext::default()
		};
		let context = EncodeContext {
			request_id: &request_id,
			route,
			target: Some(&target),
			policy_model: Some(&policy_model),
			policy,
			account: Some(&account),
			..EncodeContext::default()
		};
		let encoded = binding
			.primary
			.encode(&context, &OperationCall::Chat(Arc::new(request)))
			.expect("CCA request encodes through Gemini projection");
		let BodySource::Bytes(body) = encoded.body else {
			panic!("CCA request body is buffered JSON");
		};
		let body: JsonValue = serde_json::from_slice(&body).expect("CCA request JSON");
		let parts = body["request"]["contents"][0]["parts"]
			.as_array()
			.expect("CCA projected parts");
		assert_eq!(parts[0]["thoughtSignature"], "skip_thought_signature_validator",);
		assert!(
			parts[1].get("thoughtSignature").is_none(),
			"the first-call-only catalog axis must not sign later unsigned calls",
		);
	}

	#[test]
	fn route_encoder_applies_forced_call_ladder_and_receipts_paid_escalation_once() {
		let catalog = Catalog::embedded();
		let (model, route, wire_model) = catalog
			.models()
			.iter()
			.find_map(|model| {
				let tools = model.capabilities.chat.as_ref()?.tools.constraints()?;
				if !tools.features.contains(ToolFeatureBits::REQUIRED_CHOICE) {
					return None;
				}
				model.routes.iter().find_map(|route_id| {
					let route = catalog.route(route_id)?;
					(route.provider.as_str() == "anthropic").then(|| {
						let wire_model = model
							.wire_ids
							.iter()
							.find(|(candidate, _)| candidate == route_id)
							.map(|(_, wire_model)| wire_model.clone())
							.expect("Anthropic wire model");
						(model, route.clone(), wire_model)
					})
				})
			})
			.expect("Anthropic model with required tool choice");
		let wire_policy = catalog
			.wire_policy(&model.wire_policy)
			.expect("Anthropic model wire policy");
		assert_eq!(wire_policy.tool.forced_choice, Some(true));
		assert_eq!(
			wire_policy.tool.forced_choice_penalty,
			Some(NativeToolChoicePenalty::CacheInvalidated),
		);

		let (mut encoder, mut call, ..) = discovery_fixture();
		let binding = codec_binding(&route, &test_cca(), false, false, None, None, None)
			.expect("Anthropic codec binding");
		encoder.route = route.clone();
		encoder.codec = binding.primary;
		let plan = Arc::make_mut(call.execution.as_mut().expect("execution plan"));
		plan.operation = OperationKind::Chat;
		plan.model = Some(model.key.clone());
		plan.provider = route.provider.clone();
		plan.route = route.id.clone();
		plan.codec = route.codec.clone();
		plan.policy_model = Some(Arc::new(PolicyModel::from(model)));
		plan.wire_policy = Arc::new(wire_policy.clone());
		plan.wire_target = Some(WireTarget {
			route: route.id.clone(),
			codec: route.codec.clone(),
			endpoint: route.endpoint,
			wire_model,
		});
		let mut chat = request_hook_chat();
		chat.hosted_tools = Arc::from([]);
		chat.tools = Arc::from([ToolDefinition {
			name:        sf!("lookup"),
			description: Some(sf!("Look up a value")),
			input:       ToolInputConstraint::JsonSchema {
				parameters: OpaqueJson::new(json!({"type": "object"})),
				strict:     false,
			},
		}]);
		chat.forced_call = Some(ForcedCall { non_compliant_turns: 0, escalations_left: 1 });
		call.operation = OperationCall::Chat(Arc::new(chat.clone()));

		let soft_context = ExecutionContext::new(ExecutionBudget::default());
		let soft = encoder
			.encode(
				&call,
				&None,
				&BeforeRequestMutation::default(),
				&soft_context,
				0,
				false,
				Cancellation::default(),
			)
			.expect("soft forced-call attempt encodes");
		let BodySource::Bytes(soft_body) = soft.encoded.body else {
			panic!("Anthropic request body is buffered JSON");
		};
		let soft_body = String::from_utf8(soft_body.to_vec()).expect("request body is UTF-8 JSON");
		assert!(soft_body.contains(crate::plan::FORCED_CALL_DIRECTIVE));
		assert!(
			soft_context.receipt().adjustments.is_empty(),
			"the free prompt rung has no paid escalation receipt",
		);

		chat.forced_call = Some(ForcedCall { non_compliant_turns: 1, escalations_left: 1 });
		call.operation = OperationCall::Chat(Arc::new(chat));
		let paid_context = ExecutionContext::new(ExecutionBudget::default());
		for _ in 0..2 {
			encoder
				.encode(
					&call,
					&None,
					&BeforeRequestMutation::default(),
					&paid_context,
					1,
					false,
					Cancellation::default(),
				)
				.expect("paid forced-call attempt encodes");
		}
		assert_eq!(
			paid_context.receipt().adjustments,
			[Adjustment::Escalated {
				feature: FeatureId(sf!("tool_choice")),
				penalty: Penalty::CacheInvalidated,
			}],
			"re-encoding an attempt must not duplicate the escalation receipt",
		);
	}

	#[test]
	fn copilot_requests_declare_the_initiator_and_charge_premium_requests() {
		// A user turn on a 0.33× model bills 0.33 premium requests and says so on the
		// wire; the tool-result continuation is agent-initiated and free.
		let catalog = Catalog::embedded();
		let model = catalog
			.models()
			.iter()
			.find(|model| model.key.as_str() == "github-copilot/claude-haiku-4.5")
			.expect("embedded Copilot Haiku model");
		assert_eq!(
			model.premium_multiplier_millionths,
			Some(omp_catalog::PremiumMultiplier::from_millionths(330_000)),
		);
		let (mut encoder, mut call, ..) = discovery_fixture();
		let route = model
			.routes
			.iter()
			.filter_map(|route| catalog.route(route))
			.find(|route| route.provider.as_str() == super::super::copilot::PROVIDER)
			.expect("Haiku is served by a Copilot route")
			.clone();
		encoder.route = route.clone();
		let wire_model = model
			.wire_ids
			.iter()
			.find(|(candidate, _)| candidate == &route.id)
			.map(|(_, wire_model)| wire_model.clone())
			.expect("Copilot wire model");
		let binding = codec_binding(&route, &test_cca(), false, false, None, None, None)
			.expect("Copilot codec binding");
		encoder.codec = binding.primary;
		let plan = Arc::make_mut(call.execution.as_mut().expect("execution plan"));
		plan.operation = OperationKind::Chat;
		plan.model = Some(model.key.clone());
		plan.policy_model = Some(Arc::new(PolicyModel::from(model)));
		plan.wire_policy = Arc::new(
			catalog
				.wire_policy(&model.wire_policy)
				.expect("Copilot wire policy")
				.clone(),
		);
		plan.provider = route.provider.clone();
		plan.route = route.id.clone();
		plan.codec = route.codec.clone();
		plan.wire_target = Some(WireTarget {
			route: route.id.clone(),
			codec: route.codec.clone(),
			endpoint: route.endpoint,
			wire_model,
		});
		let text = |role, body: &str| Message {
			role,
			content: Arc::from([ContentPart::Text { text: Str::new(body), proof: None }]),
			name: None,
		};
		let mut chat = request_hook_chat();
		chat.hosted_tools = Arc::from([]);
		chat.tool_choice = Setting::Unset;
		chat.messages = Arc::from([text(Role::User, "Read the file.")]);
		call.operation = OperationCall::Chat(Arc::new(chat.clone()));

		let header = |encoded: &TransportRequest, name: &str| {
			encoded
				.encoded
				.headers
				.iter()
				.find(|header| header.name.eq_ignore_ascii_case(name))
				.map(|header| header.value.clone())
		};
		let user_context = ExecutionContext::new(ExecutionBudget::default());
		let user_turn = encoder
			.encode(
				&call,
				&None,
				&BeforeRequestMutation::default(),
				&user_context,
				0,
				false,
				Cancellation::default(),
			)
			.expect("user turn encodes");
		assert_eq!(header(&user_turn, "X-Initiator").as_deref(), Some("user"));
		assert_eq!(header(&user_turn, "X-Interaction-Type").as_deref(), Some("conversation-user"));
		assert_eq!(user_context.premium_requests_millionths(), 330_000);

		chat.messages = Arc::from([
			text(Role::User, "Read the file."),
			Message {
				role:    Role::Assistant,
				content: Arc::from([ContentPart::ToolCall {
					call:      ToolCallId::new("call_1"),
					name:      sf!("read"),
					arguments: OpaqueJson::new(json!({"path": "note.txt"})),
					proof:     None,
				}]),
				name:    None,
			},
			Message {
				role:    Role::Tool,
				content: Arc::from([ContentPart::ToolResult {
					call:     ToolCallId::new("call_1"),
					name:     Some(sf!("read")),
					content:  vec![crate::call::ToolResultContent::Text(sf!("hello"))].into(),
					is_error: false,
				}]),
				name:    None,
			},
		]);
		call.operation = OperationCall::Chat(Arc::new(chat));
		let agent_context = ExecutionContext::new(ExecutionBudget::default());
		let agent_turn = encoder
			.encode(
				&call,
				&None,
				&BeforeRequestMutation::default(),
				&agent_context,
				0,
				false,
				Cancellation::default(),
			)
			.expect("agent continuation encodes");
		assert_eq!(header(&agent_turn, "X-Initiator").as_deref(), Some("agent"));
		assert_eq!(header(&agent_turn, "X-Interaction-Type").as_deref(), Some("conversation-agent"));
		assert_eq!(agent_context.premium_requests_millionths(), 0);
	}

	#[test]
	fn endpoint_api_version_is_appended_without_overwriting_query() {
		let context = ExecutionContext::new(ExecutionBudget::default());
		let mut uri = sf!("https://example.azure.com/openai/responses?trace=1");
		append_endpoint_api_version(&mut uri, Some("2024-10-21"), &context).expect("valid endpoint");
		assert_eq!(
			uri.as_str(),
			"https://example.azure.com/openai/responses?trace=1&api-version=2024-10-21",
		);
	}

	#[test]
	fn mantle_region_expands_the_route_and_preserves_the_wire_model() {
		let catalog = Catalog::embedded();
		let model = catalog
			.model(omp_catalog::ModelKey::from_ref("bedrock-mantle/openai.gpt-5.6-sol"))
			.expect("Mantle model");
		let route = catalog
			.route(omp_catalog::RouteId::from_ref("bedrock-mantle/primary"))
			.expect("Mantle route");
		let provider = catalog.provider(&route.provider).expect("Mantle provider");
		let sigv4 = provider
			.auth
			.iter()
			.filter_map(|id| catalog.auth_spec(id))
			.find(|auth| auth.kind == AuthSpecKind::AwsSigv4)
			.expect("Mantle SigV4 alternative");
		assert_eq!(
			catalog_auth_for_route(route, sigv4)
				.signing
				.expect("Mantle signing contract")
				.service
				.as_str(),
			"bedrock-mantle",
		);
		let wire_model = model
			.wire_ids
			.iter()
			.find(|(route_id, _)| route_id == &route.id)
			.map(|(_, model)| model.clone())
			.expect("Mantle wire model");
		let target = WireTarget {
			route: route.id.clone(),
			codec: route.codec.clone(),
			endpoint: route.endpoint.clone(),
			wire_model,
		};
		let effective =
			mantle_regional_route(route, &sf!("eu-west-2")).expect("valid regional route");
		let target =
			mantle_effective_target(&effective, Some(&target)).expect("model target remains present");

		assert_eq!(
			effective.endpoint.base_url.as_str(),
			"https://bedrock-mantle.eu-west-2.api.aws/openai/v1",
		);
		assert_eq!(effective.endpoint.region.as_deref(), Some("eu-west-2"));
		assert_eq!(
			effective.trust_domain.origin.as_str(),
			"https://bedrock-mantle.eu-west-2.api.aws",
		);
		assert_eq!(target.endpoint, effective.endpoint);
		assert_eq!(target.wire_model.as_str(), "openai.gpt-5.6-sol");
	}

	#[test]
	fn mantle_wire_auth_errors_refine_retry_without_changing_shared_routes() {
		let mantle =
			RouteCredentialApplier { auth: Box::new([]), required: true, mantle: true };
		let shared =
			RouteCredentialApplier { auth: Box::new([]), required: true, mantle: false };
		let rejected = Error::new(
			ErrorKind::Authorization,
			ErrorPhase::Handshake,
			RetryAction::Never,
			ExecutionReceipt::default(),
		)
		.status(Some(403));

		assert_eq!(
			mantle
				.map_response_error(Some(AuthScheme::AwsSigV4), rejected.clone())
				.action,
			RetryAction::RefreshCredentialOnce,
		);
		assert_eq!(
			mantle
				.map_response_error(Some(AuthScheme::OAuth), rejected.clone())
				.action,
			RetryAction::RotateAccount,
		);
		assert_eq!(
			shared
				.map_response_error(Some(AuthScheme::AwsSigV4), rejected)
				.action,
			RetryAction::Never,
		);
	}

	#[test]
	fn mantle_sigv4_signs_the_final_responses_request_with_its_service_scope() {
		let catalog = Catalog::embedded();
		let route = catalog
			.route(omp_catalog::RouteId::from_ref("bedrock-mantle/primary"))
			.expect("Mantle route");
		let provider = catalog.provider(&route.provider).expect("Mantle provider");
		let catalog_auth = provider
			.auth
			.iter()
			.filter_map(|id| catalog.auth_spec(id))
			.find(|auth| auth.kind == AuthSpecKind::AwsSigv4)
			.expect("Mantle SigV4 alternative");
		let catalog_auth = catalog_auth_for_route(route, catalog_auth);
		let runtime_auth = AuthSpec::from_catalog(&catalog_auth, None, Some(sf!("us-west-2")))
			.expect("Mantle runtime auth");
		let lease = CredentialLease::aws_sigv4(
			LeaseMeta {
				account:    AccountId::new("aws"),
				principal:  PrincipalId::new("bedrock-mantle"),
				generation: 1,
				expires_at: None,
			},
			SecretString::from("AKIDEXAMPLE"),
			SecretString::from("secret"),
			Some(SecretString::from("session")),
		);
		let credentials = lease
			.prepare(&runtime_auth, SystemTime::UNIX_EPOCH)
			.expect("prepare Mantle credentials");
		let mut request = Request::builder()
			.method("POST")
			.uri("https://bedrock-mantle.us-west-2.api.aws/openai/v1/responses")
			.body(Bytes::from_static(br#"{"model":"openai.gpt-5.6-sol"}"#))
			.expect("Mantle request");

		credentials
			.finalize_buffered(&mut request)
			.expect("sign Mantle request");

		let authorization = request
			.headers()
			.get(AUTHORIZATION)
			.expect("authorization")
			.to_str()
			.expect("ASCII authorization");
		assert!(authorization.contains("/us-west-2/bedrock-mantle/aws4_request"));
		assert_eq!(request.headers()["x-amz-security-token"], "session");
	}

	#[test]
	fn static_and_runtime_bedrock_routes_inherit_provider_options() {
		let catalog = Catalog::embedded();
		let static_route = catalog
			.routes()
			.iter()
			.find(|route| {
				route.provider.as_str() == "amazon-bedrock"
					&& route.codec.as_str() == "bedrock-converse"
			})
			.expect("static Bedrock route");
		let mut runtime_route = static_route.clone();
		runtime_route.provider = ProviderId::new("runtime-bedrock");
		let static_guardrail = BedrockGuardrail {
			identifier:  sf!("arn:aws:bedrock:eu-west-1:123456789012:guardrail/static"),
			version:     sf!("7"),
			trace:       Some(crate::codec::bedrock::GuardrailTraceMode::EnabledFull),
			stream_mode: Some(crate::codec::bedrock::GuardrailStreamMode::Sync),
		};
		let runtime_guardrail =
			BedrockGuardrail { identifier: sf!("runtime-guardrail"), ..static_guardrail.clone() };
		let mut settings = InferenceSettings::default();
		settings
			.providers
			.bedrock_guardrails
			.insert(sf!("amazon-bedrock"), static_guardrail.clone());
		settings
			.providers
			.bedrock_guardrails
			.insert(sf!("runtime-bedrock"), runtime_guardrail.clone());
		let static_metadata = BTreeMap::from([(sf!("team"), sf!("growth"))]);
		let runtime_metadata = BTreeMap::from([(sf!("team"), sf!("runtime"))]);
		settings
			.providers
			.bedrock_request_metadata
			.insert(sf!("amazon-bedrock"), static_metadata.clone());
		settings
			.providers
			.bedrock_request_metadata
			.insert(sf!("runtime-bedrock"), runtime_metadata.clone());
		assert_eq!(configured_bedrock_guardrail(&settings, static_route), Some(&static_guardrail),);
		assert_eq!(configured_bedrock_guardrail(&settings, &runtime_route), Some(&runtime_guardrail),);
		assert_eq!(
			configured_bedrock_request_metadata(&settings, static_route),
			Some(&static_metadata),
		);
		assert_eq!(
			configured_bedrock_request_metadata(&settings, &runtime_route),
			Some(&runtime_metadata),
		);
	}

	fn test_cca() -> GoogleCcaConfig {
		GoogleCcaConfig {
			gemini_cli_platform: sf!("test"),
			gemini_cli_arch:     sf!("test"),
			antigravity_headers: CcaHeaders::antigravity(
				&AntigravityFingerprint::default(),
				false,
				None,
			),
			antigravity_policy:  AntigravityPolicy::default(),
		}
	}

	fn discovery_fixture() -> (RouteEncoder, Call, RouteAccount, AuthSpec, ProviderId, Str) {
		let catalog = Catalog::try_embedded().expect("embedded catalog");
		let route = catalog
			.routes()
			.iter()
			.find(|route| route.id.as_str() == "github-copilot/primary")
			.expect("GitHub Copilot route")
			.clone();
		let provider = catalog.provider(&route.provider).expect("provider");
		let cca = test_cca();
		let binding =
			codec_binding(&route, &cca, false, false, None, None, None).expect("route codec binding");
		let codec = discovery_codec(catalog, &route, &binding)
			.expect("discovery codec")
			.expect("route supports discovery");
		let auth = catalog.auth_spec(&route.auth).expect("catalog auth");
		let oauth = auth.oauth.as_ref().and_then(|id| catalog.oauth_spec(id));
		let runtime_auth =
			AuthSpec::from_catalog(auth, oauth, route.endpoint.region.clone()).expect("runtime auth");
		let budget = ExecutionBudget::default();
		let operation = OperationCall::DiscoverModels(Arc::new(DiscoveryRequest {
			provider:  Some(route.provider.clone()),
			route:     Some(route.id.clone()),
			cursor:    None,
			page_size: 100,
			operation: None,
		}));
		let plan = ExecutionPlan {
			planned_at:          SystemTime::now(),
			catalog_revision:    catalog.revision().clone(),
			registry_generation: 1,
			expires_at:          Instant::now() + Duration::from_secs(30),
			operation:           OperationKind::DiscoverModels,
			model:               None,
			provider:            route.provider.clone(),
			route:               route.id.clone(),
			codec:               route.codec.clone(),
			policy_model:        None,
			wire_policy:         Arc::new(
				catalog
					.wire_policy(&provider.wire_policy)
					.expect("wire policy")
					.clone(),
			),
			thinking_policy:     None,
			thinking_selection:  None,
			decisions:           Arc::from([]),
			fallback_scope:      FallbackScope { primary: None, explicit: Arc::from([]) },
			fallbacks:           Arc::from([]),
			replay:              ReplayPlan::Replayable,
			budget:              budget.clone(),
			runtime_evidence:    RuntimeRouteEvidence {
				route:            route.id.clone(),
				generation:       1,
				health:           RouteHealth::Unknown,
				quota_millionths: 0,
				latency:          Duration::MAX,
				affinity:         false,
				operation:        CapabilityAvailability::Native,
				capabilities:     Arc::from([]),
			},
			wire_target:         None,
		};
		let call = Call {
			id: RequestId::new("credential-shaping-discovery"),
			target: Target::RouteService(route.id.clone()),
			deadline: None,
			budget,
			session: None,
			debug_session: None,
			affinity: Default::default(),
			response_hooks: Default::default(),
			attribution: InferenceAttribution::core(),
			execution: Some(Arc::new(plan)),
			staging: None,
			operation,
		};
		let account = RouteAccount::Brokered {
			_account: BrokeredAccount {
				_provider: route.provider.clone(),
				_route:    route.id.clone(),
			},
		};
		let base_url = route.endpoint.base_url.clone();
		(
			RouteEncoder {
				route,
				auth_schemes: Box::new([AuthScheme::for_spec(&runtime_auth)]),
				headers: Box::new([]),
				codec,
				azure_endpoint: None,
				cloudflare_gateway: None,
				regional_route: None,
				transport_timeout: Duration::from_secs(30),
			},
			call,
			account,
			runtime_auth,
			provider.id.clone(),
			base_url,
		)
	}

	#[tokio::test]
	async fn before_request_transform_adds_header_and_intersects_intents() {
		let (encoder, mut call, ..) = discovery_fixture();
		call.operation = OperationCall::Chat(Arc::new(request_hook_chat()));
		let retained = json!({
			"kind": "hosted_tool",
			"on_unsupported": "unspecified",
			"priority": 0,
			"payload": null,
		});
		let observer = Arc::new(BeforeRequestObserver {
			subscribed: true,
			calls:      AtomicUsize::new(0),
			result:     Ok(BeforeRequestMutation {
				headers: Box::new([(sf!("x-extension"), Some(sf!("enabled")))]),
				intents: Some(Box::new([retained])),
				..BeforeRequestMutation::default()
			}),
		});
		call.response_hooks = crate::codec::ProviderResponseHooks::new(observer.clone());
		let context = ExecutionContext::new(call.budget.clone());

		let mutation = encoder
			.before_request(&mut call, &context)
			.await
			.expect("transform accepted");

		let OperationCall::Chat(chat) = &call.operation else {
			panic!("chat request remains chat");
		};
		assert!(matches!(chat.tool_choice, Setting::Unset));
		assert_eq!(chat.hosted_tools.len(), 1);
		assert_eq!(observer.calls.load(Ordering::Relaxed), 1);

		let mut encoded = EncodedRequest::new(
			OperationKind::Chat,
			RequestMethod::Post,
			sf!("https://provider.example/chat"),
			Box::new([]),
			BodySource::bytes(Bytes::from_static(b"{}")),
			crate::transport::FramingProtocol::Raw,
			SizeBounds { request_body: 1024, frame: 1024, response: 1024 },
		);
		apply_before_request_mutation(&mut encoded, &mutation, &context, false)
			.expect("header mutation applies");
		assert_eq!(encoded.headers.as_ref(), [RequestHeader::new_static("x-extension", "enabled")]);
	}

	#[test]
	fn bedrock_payload_hook_replaces_messages_and_sanitizes_metadata_before_signing() {
		let (_, call, ..) = discovery_fixture();
		let context = ExecutionContext::new(call.budget);
		let mut mutation = BeforeRequestMutation::default();
		mutation.body.insert(
			"messages".to_owned(),
			serde_json::json!([{"role":"user","content":[{"text":"replacement"}]}]),
		);
		mutation.body.insert(
			"requestMetadata".to_owned(),
			serde_json::json!({"bad*key":"drop","valid":"yes","notString":7}),
		);
		mutation.headers = Box::new([
			(sf!("Content-Type"), Some(sf!("text/plain"))),
			(sf!("Host"), Some(sf!("evil.example"))),
			(sf!("X-Trace"), Some(sf!("kept"))),
		]);
		let mut encoded = EncodedRequest::new(
			OperationKind::Chat,
			RequestMethod::Post,
			sf!("https://bedrock-runtime.us-east-1.amazonaws.com/model/test/converse-stream"),
			Box::new([]),
			BodySource::bytes(Bytes::from_static(
				br#"{"messages":[{"role":"user","content":[{"text":"original"}]}]}"#,
			)),
			crate::transport::FramingProtocol::AwsEventStream,
			SizeBounds { request_body: 1024, frame: 1024, response: 1024 },
		);
		apply_before_request_mutation(&mut encoded, &mutation, &context, true)
			.expect("Bedrock accepts wire-body replacement");
		sanitize_bedrock_request_metadata(&mut encoded, &context)
			.expect("metadata sanitation succeeds");
		protect_owned_headers(&mut encoded.headers, true);
		let BodySource::Bytes(body) = &encoded.body else {
			panic!("bounded request remains buffered");
		};
		let body: JsonValue = serde_json::from_slice(body).expect("mutated body is JSON");
		assert_eq!(
			body["messages"],
			serde_json::json!([{"role":"user","content":[{"text":"replacement"}]}]),
		);
		assert_eq!(body["requestMetadata"], serde_json::json!({"valid":"yes"}));
		let headers = encoded
			.headers
			.iter()
			.map(|header| (header.name.as_str(), header.value.as_str()))
			.collect::<BTreeMap<_, _>>();
		assert_eq!(headers["accept"], "application/vnd.amazon.eventstream");
		assert_eq!(headers["content-type"], "application/json");
		assert_eq!(headers["x-trace"], "kept");
		assert!(!headers.contains_key("host"));
	}

	#[test]
	fn bedrock_header_merge_preserves_caller_headers_and_filters_owned_fields() {
		let mut headers = vec![
			RequestHeader::new_static("content-type", "application/json"),
			RequestHeader::new_static("accept", "application/vnd.amazon.eventstream"),
			RequestHeader::new_static("user-agent", omp_core::USER_AGENT),
		]
		.into_boxed_slice();
		merge_bedrock_headers(&mut headers, &[
			RequestHeader::new_static("Host", "evil.example"),
			RequestHeader::new_static("Content-Type", "text/plain"),
			RequestHeader::new_static("Authorization", "forged"),
			RequestHeader::new_static("User-Agent", "caller-agent"),
			RequestHeader::new_static("X-Trace", "kept"),
		]);
		let headers = headers
			.iter()
			.map(|header| (header.name.as_str(), header.value.as_str()))
			.collect::<BTreeMap<_, _>>();
		assert_eq!(headers["accept"], "application/vnd.amazon.eventstream");
		assert_eq!(headers["content-type"], "application/json");
		assert_eq!(headers["user-agent"], "caller-agent");
		assert_eq!(headers["x-trace"], "kept");
		assert!(!headers.contains_key("host"));
		assert!(!headers.contains_key("authorization"));
	}

	#[tokio::test]
	async fn before_request_deny_fails_the_request() {
		let (encoder, mut call, ..) = discovery_fixture();
		call.response_hooks =
			crate::codec::ProviderResponseHooks::new(Arc::new(BeforeRequestObserver {
				subscribed: true,
				calls:      AtomicUsize::new(0),
				result:     Err(BeforeRequestDenied {
					reason: sf!("request rejected"),
					code:   Some(sf!("extension_policy")),
				}),
			}));
		let context = ExecutionContext::new(call.budget.clone());

		let error = encoder
			.before_request(&mut call, &context)
			.await
			.expect_err("explicit Deny fails request");

		assert_eq!(error.kind, ErrorKind::Authorization);
		assert_eq!(error.code.as_deref(), Some("extension_policy"));
	}

	#[tokio::test]
	async fn before_request_unsubscribed_builds_no_payload_or_frame() {
		let (encoder, mut call, ..) = discovery_fixture();
		let observer = Arc::new(BeforeRequestObserver {
			subscribed: false,
			calls:      AtomicUsize::new(0),
			result:     Ok(BeforeRequestMutation::default()),
		});
		call.response_hooks = crate::codec::ProviderResponseHooks::new(observer.clone());
		let context = ExecutionContext::new(call.budget.clone());

		let mutation = encoder
			.before_request(&mut call, &context)
			.await
			.expect("unsubscribed gate is a no-op");

		assert_eq!(mutation, BeforeRequestMutation::default());
		assert_eq!(observer.calls.load(Ordering::Relaxed), 0);
	}

	fn assert_applied_bearer(
		mut transport: TransportRequest,
		account: &RouteAccount,
		auth: AuthSpec,
		lease: CredentialLease,
		context: &ExecutionContext,
		expected: &str,
	) {
		RouteCredentialApplier { auth: Box::new([auth]), required: true, mantle: false }
			.apply(account, Some(lease), &mut transport, context)
			.expect("prepare credentials");
		let credentials = transport.credentials.take().expect("prepared credentials");
		let mut request = Request::builder()
			.uri(transport.encoded.uri.as_str())
			.body(Bytes::new())
			.expect("HTTP request");
		credentials
			.finalize_streaming(&mut request)
			.expect("apply credentials");
		assert_eq!(
			request
				.headers()
				.get(AUTHORIZATION)
				.expect("authorization")
				.to_str()
				.expect("ASCII authorization"),
			expected,
		);
	}

	#[test]
	fn shaped_credential_rewrites_discovery_uri_and_applied_secret() {
		let (encoder, call, account, auth, provider, _) = discovery_fixture();
		let raw = lease(&provider, "raw");
		let shaped = raw.with_shape(ShapedCredential {
			secret:            Some(SecretString::from("shaped".to_owned())),
			endpoint_override: Some(sf!("https://override.example")),
		});
		let context = ExecutionContext::new(call.budget.clone());
		let transport = encoder
			.encode(
				&call,
				&Some(shaped.clone()),
				&BeforeRequestMutation::default(),
				&context,
				0,
				false,
				Cancellation::default(),
			)
			.expect("encode discovery");
		assert!(
			transport
				.encoded
				.uri
				.as_str()
				.starts_with("https://override.example/")
		);
		assert_applied_bearer(transport, &account, auth, shaped, &context, "Bearer shaped");
	}

	#[test]
	fn missing_shaper_preserves_discovery_uri_and_applied_secret() {
		let (encoder, call, account, auth, provider, base_url) = discovery_fixture();
		let registry = CredentialShaperRegistry::new();
		assert!(registry.get(&provider).is_none());
		let raw = lease(&provider, "raw");
		let context = ExecutionContext::new(call.budget.clone());
		let transport = encoder
			.encode(
				&call,
				&Some(raw.clone()),
				&BeforeRequestMutation::default(),
				&context,
				0,
				false,
				Cancellation::default(),
			)
			.expect("encode discovery");
		assert!(
			transport
				.encoded
				.uri
				.as_str()
				.starts_with(base_url.as_str())
		);
		assert_applied_bearer(transport, &account, auth, raw, &context, "Bearer raw");
	}
	#[test]
	fn optional_bearer_applier_allows_an_absent_lease() {
		let (encoder, call, account, auth, ..) = discovery_fixture();
		let context = ExecutionContext::new(call.budget.clone());
		let mut transport = encoder
			.encode(
				&call,
				&None,
				&BeforeRequestMutation::default(),
				&context,
				0,
				false,
				Cancellation::default(),
			)
			.expect("encode anonymous-capable request");
		RouteCredentialApplier { auth: Box::new([auth]), required: false, mantle: false }
			.apply(&account, None, &mut transport, &context)
			.expect("optional bearer permits no credential");
		assert!(transport.credentials.is_none());
	}

	#[test]
	fn bedrock_endpoint_scope_overrides_the_catalog_fallback() {
		let (encoder, call, account, _, provider, _) = discovery_fixture();
		let context = ExecutionContext::new(call.budget.clone());
		let mut transport = encoder
			.encode(
				&call,
				&Some(lease(&provider, "unused")),
				&BeforeRequestMutation::default(),
				&context,
				0,
				false,
				Cancellation::default(),
			)
			.expect("encode request");
		transport.encoded.uri =
			sf!("https://bedrock-runtime.eu-west-2.amazonaws.com/model/test/converse-stream");
		let auth = AuthSpec::AwsSigV4(crate::auth::SigV4Spec {
			service:          sf!("catalog-fallback"),
			region:           sf!("us-east-1"),
			unsigned_headers: Vec::new(),
		});
		let aws = CredentialLease::aws_sigv4(
			LeaseMeta {
				account:    AccountId::new("aws"),
				principal:  PrincipalId::new("amazon-bedrock"),
				generation: 1,
				expires_at: None,
			},
			SecretString::from("AKIDEXAMPLE".to_owned()),
			SecretString::from("secret".to_owned()),
			None,
		);
		RouteCredentialApplier { auth: Box::new([auth]), required: true, mantle: false }
			.apply(&account, Some(aws), &mut transport, &context)
			.expect("prepare SigV4 credentials");
		let credentials = transport.credentials.take().expect("prepared credentials");
		let mut request = Request::builder()
			.method("POST")
			.uri(transport.encoded.uri.as_str())
			.body(Bytes::new())
			.expect("HTTP request");
		credentials
			.finalize_buffered(&mut request)
			.expect("apply SigV4 credentials");
		let authorization = request
			.headers()
			.get(AUTHORIZATION)
			.expect("authorization")
			.to_str()
			.expect("ASCII authorization");
		assert!(authorization.contains("/eu-west-2/bedrock/aws4_request"));
		assert!(!authorization.contains("/us-east-1/catalog-fallback/aws4_request"));
	}

	#[test]
	fn bedrock_invocation_protects_owned_headers_and_signs_caller_headers() {
		let (encoder, call, account, _, provider, _) = discovery_fixture();
		let context = ExecutionContext::new(call.budget.clone());
		let mut transport = encoder
			.encode(
				&call,
				&Some(lease(&provider, "unused")),
				&BeforeRequestMutation::default(),
				&context,
				0,
				false,
				Cancellation::default(),
			)
			.expect("encode request");
		transport.encoded.operation = OperationKind::Chat;
		transport.encoded.uri =
			sf!("https://bedrock-runtime-fips.cn-north-1.amazonaws.com.cn/model/test/converse-stream");
		transport.encoded.headers = vec![
			RequestHeader::new_static("Content-Type", "text/plain"),
			RequestHeader::new_static("Accept", "text/plain"),
			RequestHeader::new_static("Host", "evil.example"),
			RequestHeader::new_static("Content-Length", "999"),
			RequestHeader::new_static("X-Amz-Date", "19700101T000000Z"),
			RequestHeader::new_static("X-Amz-Content-Sha256", "deadbeef"),
			RequestHeader::new_static("X-Amz-Security-Token", "forged"),
			RequestHeader::new_static("Authorization", "Bearer forged"),
			RequestHeader::new_static("X-Trace", "kept"),
		]
		.into_boxed_slice();
		let auth = AuthSpec::AwsSigV4(crate::auth::SigV4Spec {
			service:          sf!("catalog-fallback"),
			region:           sf!("us-east-1"),
			unsigned_headers: Vec::new(),
		});
		let before = SystemTime::now();
		let aws = CredentialLease::aws_sigv4(
			LeaseMeta {
				account:    AccountId::new("aws"),
				principal:  PrincipalId::new("amazon-bedrock"),
				generation: 1,
				expires_at: None,
			},
			SecretString::from("AKIDEXAMPLE".to_owned()),
			SecretString::from("secret".to_owned()),
			Some(SecretString::from("session".to_owned())),
		);
		RouteCredentialApplier { auth: Box::new([auth]), required: true, mantle: false }
			.apply(&account, Some(aws), &mut transport, &context)
			.expect("prepare SigV4 credentials");
		let after = SystemTime::now();
		let credentials = transport.credentials.take().expect("prepared credentials");
		assert!(credentials.signed_at() >= before);
		assert!(credentials.signed_at() <= after);
		assert_eq!(transport.encoded.headers.as_ref(), [
			RequestHeader::new_static("x-trace", "kept"),
			RequestHeader::new_static("content-type", "application/json"),
			RequestHeader::new_static("accept", "application/vnd.amazon.eventstream"),
		],);

		let body = Bytes::from_static(br#"{"hello":"world"}"#);
		let mut request = Request::builder()
			.method("POST")
			.uri(transport.encoded.uri.as_str())
			.body(body)
			.expect("HTTP request");
		for header in &transport.encoded.headers {
			request.headers_mut().insert(
				HeaderName::from_bytes(header.name.as_bytes()).expect("header name"),
				HeaderValue::from_str(header.value.as_str()).expect("header value"),
			);
		}
		credentials
			.finalize_buffered(&mut request)
			.expect("apply SigV4 credentials");
		let authorization = request
			.headers()
			.get(AUTHORIZATION)
			.expect("authorization")
			.to_str()
			.expect("ASCII authorization");
		assert!(authorization.contains("/cn-north-1/bedrock/aws4_request"));
		assert!(authorization.contains(
			"SignedHeaders=accept;content-type;host;x-amz-content-sha256;x-amz-date;\
			 x-amz-security-token;x-trace",
		));
		assert_eq!(request.headers()["x-amz-security-token"], "session");
		assert!(!request.headers().contains_key("content-length"));
		assert!(!authorization.contains("evil.example"));
		assert!(!authorization.contains("forged"));
	}

	#[test]
	fn dynamic_endpoint_reseeds_state_bound_to_the_catalog_origin() {
		let (encoder, call, _, _, provider, _) = discovery_fixture();
		let raw = lease(&provider, "raw");
		let shaped = raw.with_shape(ShapedCredential {
			secret:            Some(SecretString::from("shaped".to_owned())),
			endpoint_override: Some(sf!("https://override.example")),
		});
		let context = ExecutionContext::new(call.budget.clone());
		let binding = PendingServerStateBinding {
			conversation:          ConversationId::new("conversation"),
			route:                 encoder.route.id.clone(),
			model:                 ModelKey::new("model"),
			principal:             PrincipalId::new("principal"),
			trust_domain:          encoder.route.trust_domain.clone(),
			credential_generation: 1,
			credential_policy:     CredentialGenerationPolicy::PrincipalBound,
			created_at:            SystemTime::now(),
			expires_at:            None,
			handle:                Bytes::from_static(b"state"),
		}
		.commit(Revision::new("revision"));
		context.set_session_state(Some(binding));

		let Err(error) = encoder.encode(
			&call,
			&Some(shaped),
			&BeforeRequestMutation::default(),
			&context,
			0,
			false,
			Cancellation::default(),
		) else {
			panic!("endpoint change must reseed provider state");
		};

		assert_eq!(error.kind, ErrorKind::SessionExpired);
		assert_eq!(error.action, RetryAction::ReseedSession);
		assert_eq!(
			context
				.effective_trust_domain()
				.expect("effective trust domain")
				.origin,
			"https://override.example",
		);
	}

	#[test]
	fn realtime_route_encoder_constructs_websocket_handshake_before_http_encode() {
		let catalog = Catalog::try_embedded().expect("embedded catalog");
		let (model, route, wire_model) = catalog
			.models()
			.iter()
			.find_map(|model| {
				model.routes.iter().find_map(|route_id| {
					let route = catalog.route(route_id)?;
					if route.codec.as_str() != "openai-chat" {
						return None;
					}
					let wire_model = model
						.wire_ids
						.iter()
						.find(|(candidate, _)| candidate == route_id)
						.map(|(_, wire_model)| wire_model.clone())?;
					Some((model, route.clone(), wire_model))
				})
			})
			.expect("catalog OpenAI route");
		let mut route = route;
		route.transport = TransportKind::Websocket;
		let cca = test_cca();
		let binding =
			codec_binding(&route, &cca, false, false, None, None, None).expect("route codec binding");
		let codec = RouteCodecSet::for_route(
			&route,
			OperationBits::for_kind(OperationKind::Realtime),
			binding,
			None,
		)
		.expect("realtime codec slot");
		let policy_model = PolicyModel::from(model);
		let wire_policy = catalog
			.wire_policy(&model.wire_policy)
			.expect("wire policy");
		let target = WireTarget {
			route: route.id.clone(),
			codec: route.codec.clone(),
			endpoint: route.endpoint.clone(),
			wire_model,
		};
		let operation = OperationCall::Realtime(Arc::new(RealtimeRequest {
			instructions:   None,
			modalities:     Arc::from([]),
			voice:          None,
			input_audio:    Setting::Unset,
			output_audio:   Setting::Unset,
			turn_detection: Setting::Unset,
			tools:          Arc::from([]),
			negotiation:    NegotiationPolicy::default(),
		}));
		let request_id = RequestId::new("realtime-handshake-test");
		let context = EncodeContext {
			request_id: &request_id,
			route: &route,
			target: Some(&target),
			policy_model: Some(&policy_model),
			policy: wire_policy,
			..EncodeContext::default()
		};
		let execution = ExecutionContext::new(ExecutionBudget::default());
		let encoded =
			encode_wire_request(&codec, &context, &operation, &execution).expect("realtime handshake");
		assert_eq!(encoded.operation, OperationKind::Realtime);
		assert_eq!(encoded.method, crate::codec::RequestMethod::Get);
		assert_eq!(encoded.framing, crate::transport::FramingProtocol::WebSocket);
		assert!(encoded.uri.as_str().contains("/v1/realtime?model="));
	}

	#[test]
	fn invocation_lease_replaces_selected_account_for_attribution() {
		let (encoder, call, ..) = discovery_fixture();
		let context = ExecutionContext::new(ExecutionBudget::default());
		context.set_session_state(Some(
			PendingServerStateBinding {
				conversation:          ConversationId::new("conversation"),
				route:                 encoder.route.id.clone(),
				model:                 ModelKey::new("model"),
				principal:             PrincipalId::new("stored-principal"),
				trust_domain:          encoder.route.trust_domain.clone(),
				credential_generation: 7,
				credential_policy:     CredentialGenerationPolicy::PrincipalBound,
				created_at:            SystemTime::now(),
				expires_at:            None,
				handle:                Bytes::from_static(b"stored-state"),
			}
			.commit(Revision::new("revision")),
		));
		context.set_account_routing(AccountRoutingContext {
			account: Some(AccountId::new("stored-account")),
			principal: Some(PrincipalId::new("stored-principal")),
			credential_generation: Some(7),
			project: Some(ProjectId::new("project")),
			..AccountRoutingContext::default()
		});
		let lease = CredentialLease::api_key(
			LeaseMeta {
				account:    AccountId::new("invocation"),
				principal:  PrincipalId::new("invocation"),
				generation: 0,
				expires_at: None,
			},
			SecretString::from("invocation-key"),
		)
		.with_source_tag(sf!("invocation"));

		attribute_invocation_lease(&context, &lease);
		assert!(context.session_state().is_none(), "stored provider state is not reused");

		assert_eq!(
			context.account_routing(),
			Some(AccountRoutingContext {
				account: Some(AccountId::new("invocation")),
				principal: Some(PrincipalId::new("invocation")),
				credential_generation: Some(0),
				project: Some(ProjectId::new("project")),
				..AccountRoutingContext::default()
			})
		);
		let transport = encoder
			.encode(
				&call,
				&Some(lease),
				&BeforeRequestMutation::default(),
				&context,
				0,
				false,
				Cancellation::default(),
			)
			.expect("invocation request encodes");
		assert_eq!(transport.attempt.account.as_ref().map(AccountId::as_str), Some("invocation"),);
		assert_eq!(
			transport
				.attempt
				.principal
				.as_ref()
				.map(PrincipalId::as_str),
			Some("invocation"),
		);
		let evidence = BodySource::bytes(Bytes::new())
			.begin_attempt()
			.evidence_handle();
		let error = crate::transport::http::record_failure(
			Error::new(
				ErrorKind::RateLimited,
				ErrorPhase::Connecting,
				RetryAction::SameRoute { after: Duration::ZERO },
				ExecutionReceipt::default(),
			),
			&transport.attempt,
			&evidence,
			Some(429),
			None,
			Instant::now().into(),
			false,
		);
		let attempt = &error.receipt().attempts[0];
		assert_eq!(attempt.account.as_ref().map(AccountId::as_str), Some("invocation"));
		assert_eq!(attempt.principal.as_ref().map(PrincipalId::as_str), Some("invocation"));
	}

	fn pinned_selector(
		accounts: &[&str],
		pin: Option<AccountPin>,
	) -> (RouteAccountSelector, Call, ExecutionContext) {
		let (encoder, mut call, ..) = discovery_fixture();
		let pool = AccountPool::new();
		for account in accounts {
			pool
				.upsert(crate::account::AccountRecord {
					account:               AccountId::new(*account),
					principal:             PrincipalId::new(*account),
					provider:              encoder.route.provider.clone(),
					routes:                std::collections::BTreeSet::from([encoder.route.id.clone()]),
					enabled:               true,
					credential_generation: 1,
					routing:               AccountRoutingContext::default(),
				})
				.expect("account registers");
		}
		call.affinity.account_pins =
			SessionAccountPins::new(pin.map(|pin| (encoder.route.provider.clone(), pin)));
		let selector = RouteAccountSelector {
			pool,
			provider: encoder.route.provider.clone(),
			route: encoder.route.id,
			authenticated: true,
			invocation: false,
		};
		let context = ExecutionContext::new(call.budget.clone());
		(selector, call, context)
	}

	#[test]
	fn pinned_route_selection_serves_only_the_pinned_account() {
		let (selector, call, context) =
			pinned_selector(&["alpha", "beta"], Some(AccountPin::Account(AccountId::new("beta"))));
		let selected = selector
			.select(&call, &context)
			.expect("pinned account serves");
		let RouteAccount::Authenticated(selection) = selected else {
			panic!("a pinned selection is authenticated");
		};
		assert_eq!(selection.record.account, AccountId::new("beta"));
	}

	#[test]
	fn unavailable_pin_is_a_typed_terminal_error_and_never_falls_back() {
		let cases = [
			(&["alpha"][..], AccountPin::Account(AccountId::new("gone")), PinFailure::Removed),
			(&["alpha"][..], AccountPin::Unresolved, PinFailure::Removed),
			(&[][..], AccountPin::Account(AccountId::new("gone")), PinFailure::Removed),
		];
		for (accounts, pin, reason) in cases {
			let (selector, call, context) = pinned_selector(accounts, Some(pin));
			let Err(error) = selector.select(&call, &context) else {
				panic!("an unavailable pin must not select an account");
			};
			assert_eq!(error.kind, ErrorKind::AccountDisabled);
			assert_eq!(error.action, RetryAction::Never);
			assert_eq!(error.code.as_deref(), Some("removed"));
			assert!(matches!(
				error.detail_ref(),
				Some(ErrorDetail::AccountPin { reason: found, .. }) if *found == reason
			));
		}
	}

	#[test]
	fn blocked_pinned_account_reports_why_instead_of_rotating() {
		let (selector, call, context) =
			pinned_selector(&["alpha", "beta"], Some(AccountPin::Account(AccountId::new("alpha"))));
		selector
			.pool
			.cooldown(
				AccountId::new("alpha"),
				SystemTime::now() + Duration::from_secs(600),
				crate::account::CooldownReason::Health,
			)
			.expect("cooldown records");
		let Err(error) = selector.select(&call, &context) else {
			panic!("a cooling pinned account must not be replaced");
		};
		assert!(matches!(
			error.detail_ref(),
			Some(ErrorDetail::AccountPin { reason: PinFailure::CoolingDown, .. })
		));
		assert!(error.to_string().contains("pinned to this session"));
	}

	#[test]
	fn invocation_key_never_selects_a_stored_account() {
		let alpha = AccountId::new("alpha");
		let (mut selector, call, context) =
			pinned_selector(&["alpha", "beta"], Some(AccountPin::Account(alpha.clone())));
		assert!(
			matches!(selector.select(&call, &context), Ok(RouteAccount::Authenticated(_))),
			"without the flag the pinned stored account serves"
		);
		selector.invocation = true;
		assert!(
			matches!(selector.select(&call, &context), Ok(RouteAccount::Brokered { .. })),
			"the flag outranks a pinned stored account"
		);
		selector
			.pool
			.cooldown(
				alpha.clone(),
				SystemTime::now() + Duration::from_secs(600),
				crate::account::CooldownReason::Health,
			)
			.expect("cooldown records");
		context.set_attempt_action(AttemptAction::RotateAccount { previous_account: Some(alpha) });
		assert!(
			matches!(selector.select(&call, &context), Ok(RouteAccount::Brokered { .. })),
			"a cooling stored account neither blocks nor rotates the flag's key"
		);
	}

	#[test]
	fn unpinned_selection_keeps_its_fallback_behaviour() {
		let (selector, call, context) = pinned_selector(&["alpha", "beta"], None);
		assert!(selector.select(&call, &context).is_ok());
		let (selector, call, context) = pinned_selector(&[], None);
		assert!(matches!(selector.select(&call, &context), Ok(RouteAccount::Brokered { .. })));
	}

	#[test]
	fn rotation_without_another_account_names_why() {
		let (selector, call, context) = pinned_selector(&["alpha"], None);
		context.set_attempt_action(AttemptAction::RotateAccount {
			previous_account: Some(AccountId::new("alpha")),
		});
		let Err(error) = selector.select(&call, &context) else {
			panic!("the only account cannot rotate to itself");
		};
		assert_eq!(error.kind, ErrorKind::Authentication);
		assert_eq!(error.action, RetryAction::ReselectRoute);
		assert!(matches!(
			error.detail_ref(),
			Some(ErrorDetail::Credential { reason: CredentialFailure::NoRotationCandidate, .. })
		));
	}

	/// A process environment with no credential variable set.
	struct NoEnvironment;

	impl crate::auth::CredentialEnvironment for NoEnvironment {
		fn read(&self, _: &str) -> Result<Option<SecretString>, CredentialError> {
			Ok(None)
		}
	}

	/// A refresh engine whose every refresh fails as a token endpoint outage
	/// would.
	struct UnreachableTokenEndpoint;

	impl crate::auth::AuthRefreshEngine for UnreachableTokenEndpoint {
		fn refresh(
			&self,
			_: AccountId,
		) -> futures::future::BoxFuture<'_, Result<crate::answer::AccountSummary, Error>> {
			let error = Error::new(
				ErrorKind::Connectivity,
				ErrorPhase::Authentication,
				RetryAction::Never,
				ExecutionReceipt::default(),
			);
			futures::future::FutureExt::boxed(futures::future::ready(Err(error)))
		}
	}

	/// Leases the GitHub Copilot route (a bearer authentication) for one stored
	/// account whose row has `kind` and expiry `expires_at_ms`, through a store
	/// `locked` holds no key for, behind the production stored engine: the
	/// refreshing source over the encrypted store, renewing through `refresh`
	/// or (`None`) the production OAuth refresh engine.
	async fn lease_stored_account(
		kind: &str,
		locked: bool,
		expires_at_ms: Option<u64>,
		refresh: Option<Arc<dyn crate::auth::AuthRefreshEngine>>,
		action: AttemptAction,
	) -> Result<Option<CredentialLease>, Error> {
		use crate::auth::{
			CredentialBrokerEngines, CredentialOrigin, CredentialStore, CredentialWrite,
			HeadlessKeySource, KeyId, OAuthCustomDispatcher, RefreshingCredentialSource,
			StoredCredentialSource, StoredOAuthRefreshEngine, SystemOAuthClock, SystemOAuthHttpClient,
			UnavailableKeySource,
		};
		let (encoder, call, ..) = discovery_fixture();
		let route = encoder.route;
		let directory = tempfile::tempdir().expect("data dir");
		let path = directory.path().join("credentials.db");
		let account = AccountId::new("github-copilot:agent-db");
		let principal = PrincipalId::new("agent-db");
		let secret = omp_core::SecretBox::new(Box::new(b"fake-stored-token".to_vec()));
		CredentialStore::open(&path, Arc::new(HeadlessKeySource::new(KeyId::new("route"), [9; 32])))
			.expect("store")
			.put(CredentialWrite {
				account_id: &account,
				principal_id: &principal,
				kind,
				secret: &secret,
				expires_at_ms,
				origin: CredentialOrigin::Persistent,
				now_ms: 1,
				expected_generation: None,
			})
			.expect("stored account");
		let store = Arc::new(if locked {
			CredentialStore::open(&path, Arc::new(UnavailableKeySource)).expect("locked store")
		} else {
			CredentialStore::open(
				&path,
				Arc::new(HeadlessKeySource::new(KeyId::new("route"), [9; 32])),
			)
			.expect("store")
		});
		let catalog = Catalog::try_embedded().expect("embedded catalog");
		let pool = AccountPool::new();
		pool
			.upsert(crate::account::AccountRecord {
				account:               account.clone(),
				principal:             principal.clone(),
				provider:              route.provider.clone(),
				routes:                std::collections::BTreeSet::from([route.id.clone()]),
				enabled:               true,
				credential_generation: 1,
				routing:               AccountRoutingContext::default(),
			})
			.expect("account registers");
		let refresh = refresh.unwrap_or_else(|| {
			let http = Arc::new(SystemOAuthHttpClient::new());
			let clock = Arc::new(SystemOAuthClock);
			Arc::new(StoredOAuthRefreshEngine::new(
				Arc::new(catalog.clone()),
				Arc::clone(&store),
				pool.clone(),
				Arc::clone(&http),
				Arc::clone(&clock),
				Arc::new(OAuthCustomDispatcher::builtin(http, clock).expect("dispatcher")),
				Arc::new(
					crate::account::RefreshCoordinator::new(
						"route-lease-test",
						crate::account::RefreshPolicy::default(),
					)
					.expect("coordinator"),
				),
			))
		});
		let source = CredentialBroker::from_catalog(
			catalog,
			Arc::new(NoEnvironment),
			CredentialBrokerEngines {
				stored: Some(Arc::new(RefreshingCredentialSource::new(
					Arc::new(StoredCredentialSource::new(store)),
					refresh,
				))),
				..CredentialBrokerEngines::default()
			},
		)
		.expect("broker");
		let selector = RouteAccountSelector {
			pool,
			provider: route.provider.clone(),
			route: route.id.clone(),
			authenticated: true,
			invocation: false,
		};
		let leases = RouteLeaseProvider {
			source,
			shapers: Arc::new(CredentialShaperRegistry::default()),
			provider: route.provider.clone(),
			route_base_url: route.endpoint.base_url.clone(),
			specs: Box::new([route.auth.clone()]),
			restored_kind: restored_kind(catalog, &route.provider, std::slice::from_ref(&route.auth)),
			authenticated: true,
			required: true,
		};
		let context = ExecutionContext::new(call.budget.clone());
		context.set_attempt_action(action);
		let selected = selector
			.select(&call, &context)
			.expect("stored account selected");
		leases.acquire(&call, &selected, &context).await
	}

	/// The kind a route leasing `specs` for `provider` reports as re-stored by
	/// a restart, computed as the production route builder does.
	fn restored_kind(
		catalog: &Catalog,
		provider: &ProviderId<str>,
		specs: &[AuthSpecId],
	) -> Option<CredentialKind> {
		crate::auth::broker::restored_static_secret_kind(
			catalog,
			provider,
			specs.iter().filter_map(|id| catalog.auth_spec(id)),
		)
	}

	/// The reason a stored-account lease failed with.
	fn credential_reason(error: &Error) -> Option<CredentialFailure> {
		match error.detail_ref() {
			Some(ErrorDetail::Credential { reason, .. }) => Some(*reason),
			_ => None,
		}
	}

	fn refreshing() -> AttemptAction {
		AttemptAction::RefreshCredential {
			previous_account: Some(AccountId::new("github-copilot:agent-db")),
		}
	}

	/// A stored row of the kind the route's bearer authentication leases
	/// authenticates; an `api-key` row is a typed kind mismatch naming both
	/// kinds, not a silently skipped source. Copilot's routes take a static
	/// bearer token, so the next launch re-stores the key as one, and the
	/// failure says a restart repairs it.
	#[tokio::test]
	async fn a_wrong_kind_stored_row_is_a_typed_kind_mismatch() {
		assert!(
			lease_stored_account("bearer", false, None, None, AttemptAction::Initial)
				.await
				.expect("a bearer row leases")
				.is_some()
		);

		let mismatch = lease_stored_account("api-key", false, None, None, AttemptAction::Initial)
			.await
			.expect_err("an api-key row cannot authenticate a bearer route");
		assert_eq!(mismatch.kind, ErrorKind::Authentication);
		assert_eq!(mismatch.code.as_deref(), Some("kind_mismatch"));
		assert!(matches!(
			mismatch.detail_ref(),
			Some(ErrorDetail::Credential {
				reason: CredentialFailure::KindMismatch {
					expected: CredentialKind::Bearer,
					actual:   CredentialKind::ApiKey,
					remedy:   KindMismatchRemedy::Restart,
				},
				..
			})
		));
		assert!(
			mismatch.to_string().contains(
				"the stored credential is api-key but this route requires bearer; restarting omp \
				 re-stores it"
			),
			"{mismatch}"
		);
	}

	/// A kind mismatch names the remedy that applies to the row: a restart for
	/// a key the next launch re-stores as the bearer token the route takes
	/// (Hugging Face), and a credential of the route's own kind for a key omp
	/// keeps (Anthropic, whose bundled routes take a key header, on a route
	/// that takes only a bearer token, as under a `models.toml` `auth =
	/// "bearer"`).
	#[tokio::test]
	async fn a_kind_mismatch_names_the_remedy_that_applies() {
		let catalog = Catalog::try_embedded().expect("embedded catalog");
		let (_, call, ..) = discovery_fixture();
		let bearer_spec = |provider: &str| {
			let provider = ProviderId::from_ref(provider);
			crate::auth::provider_auth_specs(catalog, provider)
				.find(|spec| spec.kind == omp_catalog::provider::AuthSpecKind::Bearer)
				.map(|spec| spec.id.clone())
				.expect("a bearer authentication")
		};
		for (provider, remedy) in [
			("huggingface", KindMismatchRemedy::Restart),
			("anthropic", KindMismatchRemedy::StoreRequiredKind),
		] {
			let id = ProviderId::from(provider);
			let specs = [bearer_spec(provider)];
			let leases = RouteLeaseProvider {
				source:         CredentialBroker::from_catalog(
					catalog,
					Arc::new(NoEnvironment),
					crate::auth::CredentialBrokerEngines {
						stored: Some(Arc::new(PerSpecStore { locked: Box::new([]) })),
						..crate::auth::CredentialBrokerEngines::default()
					},
				)
				.expect("broker"),
				shapers:        Arc::new(CredentialShaperRegistry::default()),
				provider:       id.clone(),
				route_base_url: Str::new_static("http://127.0.0.1:9"),
				restored_kind:  restored_kind(catalog, &id, &specs),
				specs:          Box::new(specs),
				authenticated:  true,
				required:       true,
			};
			let context = ExecutionContext::new(call.budget.clone());
			let account = RouteAccount::Brokered {
				_account: BrokeredAccount { _provider: id.clone(), _route: RouteId::new("route") },
			};
			let error = leases
				.acquire(&call, &account, &context)
				.await
				.expect_err("an API key cannot lease on a bearer authentication");
			assert_eq!(
				credential_reason(&error),
				Some(CredentialFailure::KindMismatch {
					expected: CredentialKind::Bearer,
					actual: CredentialKind::ApiKey,
					remedy,
				}),
				"{provider}"
			);
		}
	}

	/// An OAuth account leases as `bearer`, as a stored bearer token does, but
	/// no repair ever moves its row. On a GitHub Copilot route whose
	/// authentication a `models.toml` `auth = "apiKey"` replaced (a key sent as
	/// `Authorization: Bearer`), the next launch re-stores a stored bearer
	/// token as a key, so that token's kind mismatch says a restart repairs
	/// it; a selected OAuth account fails with the same kinds and is told the
	/// route needs a credential of its own kind instead.
	#[tokio::test]
	async fn an_oauth_account_is_never_told_a_restart_repairs_it() {
		use crate::auth::{
			CredentialBrokerEngines, CredentialOrigin, CredentialStore, CredentialWrite,
			HeadlessKeySource, KeyId, OAuthCredentialImport, StoredCredentialSource,
		};
		let (encoder, call, ..) = discovery_fixture();
		let route = encoder.route;
		let embedded = Catalog::try_embedded().expect("embedded catalog");
		assert_eq!(
			embedded
				.auth_spec(&route.auth)
				.expect("Copilot's authentication")
				.kind,
			omp_catalog::provider::AuthSpecKind::Bearer
		);
		// Every authentication Copilot's routes lease (a static bearer token,
		// and OAuth) becomes a key sent as `Authorization: Bearer`, as the one
		// authentication a `models.toml` auth gives every route.
		let mut configured = omp_catalog::CatalogOverlayBuilder::new(omp_catalog::ProvenanceSource {
			kind:           omp_catalog::ProvenanceKind::Configured,
			origin:         "test".into(),
			revision:       None,
			confidence:     omp_catalog::EvidenceConfidence::Declared,
			observed_at_ms: None,
		});
		for spec in crate::auth::provider_auth_specs(embedded, &route.provider) {
			configured = configured.with_auth_spec(omp_catalog::provider::AuthSpec {
				kind: omp_catalog::provider::AuthSpecKind::ApiKey,
				header_name: Some(Str::new_static("authorization")),
				prefix: Some(Str::new_static("Bearer ")),
				query_parameter: None,
				sealed_body: None,
				oauth: None,
				..spec.clone()
			});
		}
		let catalog = embedded
			.with_overlay_stack(
				&omp_catalog::OverlayStack::from_layers([(
					omp_catalog::OverlaySource::UserConfig,
					configured.build(),
				)]),
				omp_catalog::UnsafeTrustScope::ALL,
			)
			.expect("configured catalog");
		let specs = [route.auth.clone()];
		let restored = restored_kind(&catalog, &route.provider, &specs);
		assert_eq!(restored, Some(CredentialKind::Bearer), "a restart re-stores a bearer token here");

		let directory = tempfile::tempdir().expect("data dir");
		let store = Arc::new(
			CredentialStore::open(
				directory.path().join("credentials.db"),
				Arc::new(HeadlessKeySource::new(KeyId::new("route"), [9; 32])),
			)
			.expect("store"),
		);
		let oauth = AccountId::new("github-copilot:oauth");
		let oauth_generation = store
			.import_oauth_bundle(OAuthCredentialImport {
				account_id:    oauth.clone(),
				principal_id:  PrincipalId::new("oauth"),
				access_token:  SecretString::from("fake-oauth-access".to_owned()),
				refresh_token: SecretString::from("fake-oauth-refresh".to_owned()),
				expires_at:    SystemTime::now() + Duration::from_hours(1),
				imported_at:   SystemTime::now(),
				origin:        CredentialOrigin::Persistent,
			})
			.expect("OAuth account")
			.generation;
		let bearer = AccountId::new("github-copilot:token");
		let bearer_generation = store
			.put(CredentialWrite {
				account_id:          &bearer,
				principal_id:        &PrincipalId::new("token"),
				kind:                "bearer",
				secret:              &omp_core::SecretBox::new(Box::new(b"fake-stored-token".to_vec())),
				expires_at_ms:       None,
				origin:              CredentialOrigin::Persistent,
				now_ms:              1,
				expected_generation: None,
			})
			.expect("bearer account")
			.generation;

		for (account, principal, generation, remedy) in [
			(oauth, "oauth", oauth_generation, KindMismatchRemedy::StoreRequiredKind),
			(bearer, "token", bearer_generation, KindMismatchRemedy::Restart),
		] {
			let pool = AccountPool::new();
			pool
				.upsert(crate::account::AccountRecord {
					account:               account.clone(),
					principal:             PrincipalId::new(principal),
					provider:              route.provider.clone(),
					routes:                std::collections::BTreeSet::from([route.id.clone()]),
					enabled:               true,
					credential_generation: generation,
					routing:               AccountRoutingContext::default(),
				})
				.expect("account registers");
			let selector = RouteAccountSelector {
				pool,
				provider: route.provider.clone(),
				route: route.id.clone(),
				authenticated: true,
				invocation: false,
			};
			let leases = RouteLeaseProvider {
				source:         CredentialBroker::from_catalog(
					&catalog,
					Arc::new(NoEnvironment),
					CredentialBrokerEngines {
						stored: Some(Arc::new(StoredCredentialSource::new(Arc::clone(&store)))),
						..CredentialBrokerEngines::default()
					},
				)
				.expect("broker"),
				shapers:        Arc::new(CredentialShaperRegistry::default()),
				provider:       route.provider.clone(),
				route_base_url: route.endpoint.base_url.clone(),
				specs:          Box::new(specs.clone()),
				restored_kind:  restored,
				authenticated:  true,
				required:       true,
			};
			let context = ExecutionContext::new(call.budget.clone());
			let selected = selector
				.select(&call, &context)
				.expect("stored account selected");
			let error = leases
				.acquire(&call, &selected, &context)
				.await
				.expect_err("a bearer lease cannot authenticate a key route");
			assert_eq!(
				credential_reason(&error),
				Some(CredentialFailure::KindMismatch {
					expected: CredentialKind::ApiKey,
					actual: CredentialKind::Bearer,
					remedy,
				}),
				"{account}"
			);
		}
	}

	/// A stored row this process holds no key for is credential storage
	/// unavailable, not an anonymous authentication failure.
	#[tokio::test]
	async fn a_locked_store_is_credential_storage_unavailable() {
		let locked = lease_stored_account("bearer", true, None, None, AttemptAction::Initial)
			.await
			.expect_err("no key decrypts the row");
		assert_eq!(locked.kind, ErrorKind::CredentialStorageUnavailable);
		assert_eq!(locked.code.as_deref(), Some("storage_locked"));
		assert!(matches!(
			locked.detail_ref(),
			Some(ErrorDetail::Credential {
				reason: CredentialFailure::StorageLocked {
					cause: crate::CredentialStorageLock::NoKeySource,
				},
				..
			})
		));
	}

	/// Refreshing a stored static key through the production stored engine
	/// names it as not renewable; a refresh of a renewable credential that
	/// fails is a failed refresh, not an unrenewable credential.
	#[tokio::test]
	async fn refreshing_a_static_key_is_not_renewable() {
		let renewal = lease_stored_account("bearer", false, None, None, refreshing())
			.await
			.expect_err("a static key cannot be refreshed");
		assert_eq!(renewal.kind, ErrorKind::Authentication);
		assert_eq!(renewal.code.as_deref(), Some("not_renewable"));
		assert_eq!(credential_reason(&renewal), Some(CredentialFailure::NotRenewable));

		let failed = lease_stored_account(
			"bearer",
			false,
			None,
			Some(Arc::new(UnreachableTokenEndpoint)),
			refreshing(),
		)
		.await
		.expect_err("the token endpoint is down");
		assert_eq!(failed.kind, ErrorKind::Authentication);
		assert_eq!(credential_reason(&failed), Some(CredentialFailure::RefreshFailed));
	}

	/// A stored static key past its expiry is reported as expired: the
	/// production engine cannot renew it, and the request does not leave as a
	/// detail-less authentication error.
	#[tokio::test]
	async fn an_expired_static_key_is_reported_expired() {
		let expired = lease_stored_account("bearer", false, Some(2), None, AttemptAction::Initial)
			.await
			.expect_err("the key expired");
		assert_eq!(expired.kind, ErrorKind::Authentication);
		assert_eq!(expired.action, RetryAction::ReselectRoute);
		assert_eq!(expired.code.as_deref(), Some("expired"));
		assert_eq!(credential_reason(&expired), Some(CredentialFailure::Expired));
		// A renewable credential whose renewal fails while leasing is a failed
		// refresh.
		let failed = lease_stored_account(
			"bearer",
			false,
			Some(2),
			Some(Arc::new(UnreachableTokenEndpoint)),
			AttemptAction::Initial,
		)
		.await
		.expect_err("the renewal failed");
		assert_eq!(failed.code.as_deref(), Some("refresh_failed"));
		assert_eq!(credential_reason(&failed), Some(CredentialFailure::RefreshFailed));
	}

	/// A selected stored account whose row no authentication can lease (OAuth
	/// material an extension stored under its own `oauth` kind) is named as
	/// such, not reported as an absent credential.
	#[tokio::test]
	async fn an_unleasable_stored_row_is_named() {
		let unusable = lease_stored_account("oauth", false, None, None, AttemptAction::Initial)
			.await
			.expect_err("an oauth row is no static secret");
		assert_eq!(unusable.kind, ErrorKind::Authentication);
		assert_eq!(unusable.code.as_deref(), Some("unusable_stored_credential"));
		assert_eq!(credential_reason(&unusable), Some(CredentialFailure::UnusableStoredCredential));
	}

	/// Answers each authentication's lease from a fixed table: `locked` specs
	/// fail as a locked store, every other spec with an API key read from a
	/// stored row.
	#[derive(Debug)]
	struct PerSpecStore {
		locked: Box<[AuthSpecId]>,
	}

	impl CredentialSource for PerSpecStore {
		fn lease(
			&self,
			need: CredentialNeed,
		) -> crate::auth::CredentialFuture<'_, Result<CredentialLease, CredentialError>> {
			if self.locked.contains(&need.spec) {
				return crate::auth::credential_ready(Err(CredentialError::StorageLocked {
					cause: crate::CredentialStorageLock::NoKeySource,
				}));
			}
			let meta = LeaseMeta {
				account:    need.account.unwrap_or_else(|| AccountId::new("account")),
				principal:  need
					.principal
					.unwrap_or_else(|| PrincipalId::new("principal")),
				generation: 1,
				expires_at: None,
			};
			crate::auth::credential_ready(Ok(CredentialLease::api_key(
				meta,
				SecretString::from("fake-api-key"),
			)
			.with_origin(LeaseOrigin::StoredSecret)))
		}

		fn reject<'a>(
			&'a self,
			_: &'a CredentialLease,
			_: crate::auth::AuthRejection,
		) -> crate::auth::CredentialFuture<'a, Result<(), CredentialError>> {
			crate::auth::credential_ready(Ok(()))
		}
	}

	/// A route with several authentications reports its most significant
	/// failure whatever their order: a locked store outranks a stored
	/// credential of the wrong kind, and the first mismatch is kept.
	#[tokio::test]
	async fn a_locked_store_outranks_a_kind_mismatch_across_authentications() {
		let catalog = Catalog::try_embedded().expect("embedded catalog");
		let (encoder, call, ..) = discovery_fixture();
		let route = encoder.route;
		// Two bearer authentications: Hugging Face's and the Copilot route's.
		let first = catalog
			.provider(ProviderId::from_ref("huggingface"))
			.expect("huggingface")
			.auth[0]
			.clone();
		let second = route.auth.clone();
		for spec in [&first, &second] {
			assert_eq!(
				catalog.auth_spec(spec).map(|auth| auth.kind),
				Some(omp_catalog::provider::AuthSpecKind::Bearer),
				"{spec:?}"
			);
		}
		let failure = |specs: [AuthSpecId; 2], locked: Box<[AuthSpecId]>| {
			let leases = RouteLeaseProvider {
				source:         CredentialBroker::from_catalog(
					catalog,
					Arc::new(NoEnvironment),
					crate::auth::CredentialBrokerEngines {
						stored: Some(Arc::new(PerSpecStore { locked })),
						..crate::auth::CredentialBrokerEngines::default()
					},
				)
				.expect("broker"),
				shapers:        Arc::new(CredentialShaperRegistry::default()),
				provider:       route.provider.clone(),
				route_base_url: route.endpoint.base_url.clone(),
				restored_kind:  restored_kind(catalog, &route.provider, &specs),
				specs:          Box::new(specs),
				authenticated:  true,
				required:       true,
			};
			let call = &call;
			async move {
				let context = ExecutionContext::new(call.budget.clone());
				let account = RouteAccount::Brokered {
					_account: BrokeredAccount {
						_provider: ProviderId::new("github-copilot"),
						_route:    RouteId::new("github-copilot/primary"),
					},
				};
				let error = leases
					.acquire(call, &account, &context)
					.await
					.expect_err("no authentication leases");
				(error.kind, credential_reason(&error))
			}
		};
		let locked = Some(CredentialFailure::StorageLocked {
			cause: crate::CredentialStorageLock::NoKeySource,
		});
		let mismatch = Some(CredentialFailure::KindMismatch {
			expected: CredentialKind::Bearer,
			actual:   CredentialKind::ApiKey,
			remedy:   KindMismatchRemedy::Restart,
		});
		for specs in [[first.clone(), second.clone()], [second, first]] {
			let [earlier, later] = specs.clone();
			// The locked authentication comes first, then after a mismatch.
			let (kind, reason) = failure(specs.clone(), Box::new([earlier])).await;
			assert_eq!(reason, locked, "{specs:?}");
			assert_eq!(kind, ErrorKind::CredentialStorageUnavailable);
			assert_eq!(failure(specs.clone(), Box::new([later])).await.1, locked, "{specs:?}");
			assert_eq!(
				failure(specs.clone(), Box::new([])).await,
				(ErrorKind::Authentication, mismatch)
			);
		}
	}
}
