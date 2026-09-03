//! Canonical production construction for catalog-backed provider routes.

use std::{
	array,
	collections::BTreeMap,
	future::{Future, Ready, ready},
	num::NonZeroU32,
	pin::Pin,
	sync::Arc,
	task::{Context, Poll},
	time::{Duration, Instant, SystemTime},
};

use futures::StreamExt as _;
use http::{HeaderName, HeaderValue};
use omp_catalog::{
	OperationBits, OperationKind,
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
		AccountPool, AccountSelection, AccountSelectionRequest, RateAvailability, RotationPolicy,
	},
	auth::{
		AuthManager, AuthScheme, CredentialApplyError, CredentialBroker, CredentialError,
		CredentialKind, CredentialLease, CredentialNeed, CredentialShaperRegistry, CredentialSource,
		OAuthHttpClient, OAuthHttpRequest, ProviderShaper, spec::AuthSpec,
	},
	body::BodySource,
	call::{
		AccountRoutingContext, Call, NativeResponseFraming, OperationCall, Setting, StructuredOutput,
		ToolChoice,
	},
	catalog::{AuthSpecId, RouteId},
	codec::{
		BeforeRequestDenied, BeforeRequestDraft, BeforeRequestMutation, Cancellation, Codec,
		DecodeContext, DecoderState, EncodeAttempt, EncodeContext, EncodedRequest,
		HandshakenResponse, NativeResponseFormat, ProviderStateEvent, RawEvent,
		RealtimeWireCodecState, RequestHeader, TransportAttempt, TransportRequest,
		anthropic::AnthropicCodec,
		bedrock::{BedrockConverseCodec, BedrockGuardrail, BedrockOptions, guardrail_arn_region},
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
		openai_responses::OpenAiResponsesCodec,
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
	error::{Error, ErrorDetail, ErrorKind, ErrorPhase, RetryAction},
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
	receipt::{Adjustment, ExecutionReceipt, FeatureId, ReasonId},
	registry::RouteUnavailable,
	session::ConversationSessionPlanner,
	settings::InferenceSettings,
	transport::{
		global_provider_capture, http::HttpTransport, websocket_transport::WebSocketTransport,
	},
};

/// Validated endpoint coordinates for Azure OpenAI routes.
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
	usage_manager:        Option<ConsoleUsageManager>,
	settings:             InferenceSettings,
	provider_admission:   Arc<BTreeMap<ProviderId, AdmissionController>>,
	local_routes:         Arc<BTreeMap<RouteId, LocalRouteBackend>>,
	discovery_projectors: Arc<BTreeMap<RouteId, Arc<dyn DiscoveryProjector>>>,
	local_unavailable:    Arc<BTreeMap<RouteId, ReasonId>>,
}

impl ProductionDependencies {
	/// Returns the immutable settings snapshot shared by planning and every
	/// route stack.
	pub(crate) const fn settings(&self) -> &InferenceSettings {
		&self.settings
	}

	/// Installs validated Azure OpenAI endpoint coordinates.
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
			usage_manager: None,
			settings: InferenceSettings::default(),
			provider_admission: Arc::new(BTreeMap::new()),
			discovery_projectors,
			local_routes: Arc::new(BTreeMap::new()),
			local_unavailable: Arc::new(BTreeMap::new()),
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

impl RouteComposer for ProductionRouteComposer {
	fn compose(
		&self,
		catalog: &Catalog,
		route: &RouteDef,
	) -> Result<RouteProviderService, RouteUnavailable> {
		let bedrock_guardrail = configured_bedrock_guardrail(&self.dependencies.settings, route);
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
								|reason| RouteUnavailable {
									route: route.id.clone(),
									reason,
									operation: None,
								},
							)
					})?;
				(
					local_codec_binding(route, backend.codec.clone())?,
					backend.wire.clone(),
					backend.framework_timeout,
				)
			},
			TransportKind::Http | TransportKind::AwsEventStream | TransportKind::Connect => (
				codec_binding(
					route,
					&self.dependencies.google_cca,
					self.dependencies.settings.retry.server_side_fallback,
					bedrock_guardrail,
					bedrock_ambient_region,
				)?,
				WireService::new(ProtocolTransport {
					http:      self.dependencies.http.clone(),
					websocket: self.dependencies.websocket.clone(),
				}),
				self.dependencies.transport_timeout,
			),
			TransportKind::Websocket => (
				codec_binding(
					route,
					&self.dependencies.google_cca,
					self.dependencies.settings.retry.server_side_fallback,
					bedrock_guardrail,
					bedrock_ambient_region,
				)?,
				WireService::new(ProtocolTransport {
					http:      self.dependencies.http.clone(),
					websocket: self.dependencies.websocket.clone(),
				}),
				self.dependencies.transport_timeout,
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
			let projector = match self
				.dependencies
				.discovery_projectors
				.get(&route.id)
				.cloned()
			{
				Some(projector) => projector,
				None => Arc::new(
					CatalogDiscoveryProjector::for_route(catalog, route)
						.map_err(|_| unavailable(route, "catalog-discovery-projector-invalid"))?,
				),
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
			});
		let runtime_auth = AuthSpec::from_catalog(auth, oauth, signing_region.clone())
			.map_err(|_| unavailable(route, "catalog-auth-spec-invalid"))?;
		let mut auth_specs = vec![(route.auth.clone(), runtime_auth)];
		if matches!(route.codec.as_str(), "anthropic" | "search-perplexity") {
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
				if auth.kind != AuthSpecKind::Oauth
					&& !(route.codec.as_str() == "anthropic"
						&& matches!(auth.kind, AuthSpecKind::Bearer | AuthSpecKind::OptionalBearer))
				{
					continue;
				}
				let oauth = auth.oauth.as_ref().and_then(|id| catalog.oauth_spec(id));
				let runtime = AuthSpec::from_catalog(auth, oauth, signing_region.clone())
					.map_err(|_| unavailable(route, "catalog-auth-spec-invalid"))?;
				if route.codec.as_str() == "search-perplexity" {
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
		};
		let leases = RouteLeaseProvider {
			source: self.dependencies.credentials.clone(),
			shapers: self.dependencies.credential_shapers.clone(),
			provider: route.provider.clone(),
			route_base_url: route.endpoint.base_url.clone(),
			specs: auth_specs.iter().map(|(id, _)| id.clone()).collect(),
			authenticated,
			required: credential_required,
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
			transport_timeout: self
				.dependencies
				.transport_timeout
				.min(framework_timeout)
				.min(Duration::from_secs(self.dependencies.settings.providers.timeout_seconds)),
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

fn codec_binding(
	route: &RouteDef,
	cca: &GoogleCcaConfig,
	server_side_fallback: bool,
	bedrock_guardrail: Option<&BedrockGuardrail>,
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
			Arc::new(OpenAiResponsesCodec::default()),
			operation_bits(&[OperationKind::Chat, OperationKind::GenerateImage]),
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
		DiscoveryKind::OpenAiModels => Arc::new(
			OpenAiModelsDiscoveryCodec::from_spec(spec)
				.map_err(|_| unavailable(route, "openai-models-discovery-codec-invalid"))?,
		),
		DiscoveryKind::OllamaTags => Arc::new(
			OllamaTagsDiscoveryCodec::from_spec(spec)
				.map_err(|_| unavailable(route, "ollama-tags-discovery-codec-invalid"))?,
		),
		DiscoveryKind::AccountModels => Arc::new(
			AccountModelsDiscoveryCodec::from_spec(spec)
				.map_err(|_| unavailable(route, "account-models-discovery-codec-invalid"))?,
		),
		DiscoveryKind::GoogleModels => Arc::new(
			GoogleModelsDiscoveryCodec::from_spec(spec)
				.map_err(|_| unavailable(route, "google-models-discovery-codec-invalid"))?,
		),
		DiscoveryKind::Specialized => {
			if !binding
				.supported
				.contains_kind(OperationKind::DiscoverModels)
			{
				return Err(RouteUnavailable {
					route:     route.id.clone(),
					reason:    ReasonId(sf!("specialized-discovery-codec-not-implemented")),
					operation: Some(OperationKind::DiscoverModels),
				});
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
				return Err(RouteUnavailable {
					route:     route.id.clone(),
					reason:    ReasonId(sf!("advertised-operation-codec-not-implemented")),
					operation: Some(operation),
				});
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
	route:             RouteDef,
	auth_schemes:      Box<[AuthScheme]>,
	headers:           Box<[RequestHeader]>,
	codec:             Arc<dyn Codec>,
	azure_endpoint:    Option<AzureEndpointConfig>,
	transport_timeout: Duration,
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
	*uri = Str::new(parsed.to_string());
	Ok(())
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
	let base_url = if route.codec.as_str() == "openai-responses" {
		sf!("{resource}/openai")
	} else {
		let deployment = config
			.deployment_for(target.wire_model.as_str())
			.ok_or_else(|| azure_configuration_error(context, "azure-deployment-not-configured"))?;
		sf!("{resource}/openai/deployments/{deployment}")
	};
	let parsed = Url::parse(&base_url)
		.map_err(|_| azure_configuration_error(context, "azure-effective-endpoint-invalid"))?;
	let mut effective_route = route.clone();
	effective_route.endpoint.base_url = base_url.clone();
	if config.api_version.is_some() {
		effective_route.endpoint.api_version = config.api_version.clone();
	}
	effective_route.trust_domain.origin = Str::new(parsed.origin().ascii_serialization());
	let mut effective_target = target.clone();
	effective_target.endpoint = effective_route.endpoint.clone();
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
		if matches!(self.route.codec.as_str(), "google-genai" | "google-vertex")
			&& let OperationCall::Chat(request) = &call.operation
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
			encode_wire_request(self.codec.as_ref(), &encode_context, &call.operation, execution)?;
		append_endpoint_api_version(
			&mut encoded.uri,
			route.endpoint.api_version.as_deref(),
			execution,
		)?;
		if encoded.operation == OperationKind::DiscoverModels
			&& route.provider.as_str() == "anthropic"
		{
			let discovery_headers = self
				.headers
				.iter()
				.filter(|header| !header.name.eq_ignore_ascii_case("anthropic-version"))
				.cloned()
				.collect::<Vec<_>>();
			merge_static_headers(&mut encoded.headers, &discovery_headers, execution)?;
		} else {
			merge_static_headers(&mut encoded.headers, &self.headers, execution)?;
		}
		apply_before_request_mutation(&mut encoded, mutation, execution)?;
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
			call
				.session
				.as_ref()
				.map(|session| session.conversation.as_str()),
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
			operation: call.operation.kind(),
			operation_call: &call.operation,
			framing: encoded.framing,
			native_response: native_response(&call.operation),
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
				provider: plan.provider.clone(),
				model: plan.model.clone(),
				api: Str::new(plan.codec.as_str()),
				route: plan.route.clone(),
				account: account.as_ref().and_then(|routing| routing.account.clone()),
				principal: Some(call.attribution.principal.clone()),
				index: attempt,
				provisional,
				capture_limit: call.budget.max_staging_bytes,
				timeout,
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
) -> Result<(), Error> {
	if !mutation.body.is_empty() {
		if encoded.operation == OperationKind::Chat
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

fn before_request_contract(execution: &ExecutionContext, reason: &'static str) -> Error {
	Error::new(
		ErrorKind::InvalidRequest,
		ErrorPhase::Encoding,
		RetryAction::Never,
		execution.receipt(),
	)
	.detail(ErrorDetail::protocol(ReasonId(Str::new_static(reason))))
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
}

impl AccountSelector<Call> for RouteAccountSelector {
	type Account = RouteAccount;

	fn select(&self, _: &Call, context: &ExecutionContext) -> Result<Self::Account, Error> {
		if !self.authenticated {
			return Ok(RouteAccount::Anonymous {
				_account: AnonymousAccount {
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
		let preserve_principal = affinity.is_some();
		let request = AccountSelectionRequest {
			provider: self.provider.clone(),
			route: self.route.clone(),
			affinity: affinity.as_ref().map(|binding| binding.principal.clone()),
			previous_account,
			previous_principal: affinity.as_ref().map(|binding| binding.principal.clone()),
			rotate,
			rotation: RotationPolicy { allow_account_change: true, preserve_principal },
			now: SystemTime::now(),
		};
		match self.pool.select(&request) {
			Ok(selection) => Ok(RouteAccount::Authenticated(Box::new(selection))),
			Err(error) if error.receipt.candidates.is_empty() && allow_brokered => {
				Ok(RouteAccount::Brokered {
					_account: BrokeredAccount {
						_provider: self.provider.clone(),
						_route:    self.route.clone(),
					},
				})
			},
			Err(_) => Err(Error::new(
				ErrorKind::Authentication,
				ErrorPhase::Authentication,
				RetryAction::ReselectRoute,
				context.receipt(),
			)),
		}
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
	authenticated:  bool,
	required:       bool,
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
					Err(CredentialError::Unavailable | CredentialError::InvalidSource) => {},
					Err(_) => {
						return Err(Error::new(
							ErrorKind::Authentication,
							ErrorPhase::Authentication,
							RetryAction::ReselectRoute,
							context.receipt(),
						));
					},
				}
			}
			let Some(lease) = resolved else {
				if !self.required && !refreshing {
					return Ok(None);
				}
				return Err(Error::new(
					ErrorKind::Authentication,
					ErrorPhase::Authentication,
					RetryAction::ReselectRoute,
					context.receipt(),
				));
			};
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

#[derive(Clone)]
struct RouteCredentialApplier {
	auth:     Box<[AuthSpec]>,
	required: bool,
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
				let signing_region =
					crate::codec::anthropic::endpoint_region(request.encoded.uri.as_str()).map(Str::new);
				for auth in &self.auth {
					let prepared = match (auth, signing_region.as_ref()) {
						(AuthSpec::AwsSigV4(spec), Some(region)) if &spec.region != region => {
							let mut resolved = spec.clone();
							resolved.region = region.clone();
							lease.prepare(&AuthSpec::AwsSigV4(resolved), SystemTime::now())
						},
						_ => lease.prepare(auth, SystemTime::now()),
					};
					match prepared {
						Ok(credentials) => {
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
	RouteUnavailable {
		route:     route.id.clone(),
		reason:    ReasonId(Str::new(reason)),
		operation: None,
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
		auth::{
			AuthScheme, AuthSpec, CredentialLease, CredentialShaperRegistry, LeaseMeta,
			ShapedCredential,
		},
		call::{
			ChatRequest, DiscoveryRequest, HostedTool, InferenceAttribution, NegotiationPolicy,
			RealtimeRequest, Sampling, Target,
		},
		codec::{
			ProviderResponseObservation, ProviderResponseObserver, RequestMethod, SizeBounds,
			google_cca::AntigravityFingerprint,
		},
		id::{AccountId, ConversationId, PrincipalId, RequestId, Revision},
		plan::{
			CapabilityAvailability, ExecutionPlan, FallbackScope, ReplayPlan, RouteHealth,
			RuntimeRouteEvidence,
		},
		receipt::ExecutionBudget,
		session::{CredentialGenerationPolicy, PendingServerStateBinding},
	};
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
		}
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
	fn static_and_runtime_bedrock_routes_inherit_provider_guardrails() {
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
			trace:       crate::codec::bedrock::GuardrailTraceMode::EnabledFull,
			stream_mode: crate::codec::bedrock::GuardrailStreamMode::Sync,
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
		assert_eq!(configured_bedrock_guardrail(&settings, static_route), Some(&static_guardrail),);
		assert_eq!(configured_bedrock_guardrail(&settings, &runtime_route), Some(&runtime_guardrail),);
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
		let cca = GoogleCcaConfig {
			gemini_cli_platform: sf!("test"),
			gemini_cli_arch:     sf!("test"),
			antigravity_headers: CcaHeaders::antigravity(
				&AntigravityFingerprint::default(),
				false,
				None,
			),
			antigravity_policy:  AntigravityPolicy::default(),
		};
		let binding = codec_binding(&route, &cca, false, None, None).expect("route codec binding");
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
		apply_before_request_mutation(&mut encoded, &mutation, &context)
			.expect("header mutation applies");
		assert_eq!(encoded.headers.as_ref(), [RequestHeader::new_static("x-extension", "enabled")]);
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
		RouteCredentialApplier { auth: Box::new([auth]), required: true }
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
		RouteCredentialApplier { auth: Box::new([auth]), required: false }
			.apply(&account, None, &mut transport, &context)
			.expect("optional bearer permits no credential");
		assert!(transport.credentials.is_none());
	}

	#[test]
	fn bedrock_endpoint_region_overrides_the_sigv4_scope() {
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
			service:          sf!("bedrock"),
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
		RouteCredentialApplier { auth: Box::new([auth]), required: true }
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
		assert!(!authorization.contains("/us-east-1/bedrock/aws4_request"));
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
		let cca = GoogleCcaConfig {
			gemini_cli_platform: sf!("test"),
			gemini_cli_arch:     sf!("test"),
			antigravity_headers: CcaHeaders::antigravity(
				&AntigravityFingerprint::default(),
				false,
				None,
			),
			antigravity_policy:  AntigravityPolicy::default(),
		};
		let binding = codec_binding(&route, &cca, false, None, None).expect("route codec binding");
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
}
