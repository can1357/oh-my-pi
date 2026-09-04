//! Construction-time composition of the one fixed inference service stack.

use std::sync;

use omp_catalog::{provider::RouteDef, snapshot::Catalog};
use tower::Layer;

use super::{
	account::{AccountPoolLayer, AccountPoolService},
	admission::{AdmissionLayer, AdmissionService},
	answer::{AnswerLayer, AnswerService},
	attempt::{AttemptLayer, AttemptService},
	auth::{AuthLeaseLayer, AuthLeaseService},
	budget::{OverallBudgetLayer, OverallBudgetService},
	encode::{CredentialApplyLayer, CredentialApplyService, EncodeLayer, EncodeService},
	hook::{HookHandle, NoHookHandle, ProviderErrorLayer, ProviderErrorService},
	intent::{IntentLayer, IntentService},
	observe::{ObserveLayer, ObserveService},
	operation::{OperationPolicyLayer, OperationPolicyService},
	rate::{RateLayer, RateService},
	recover::{RecoveryLayer, RecoveryService},
	retry::{TransportRetryLayer, TransportRetryService},
	semantic::{SemanticLayer, SemanticService},
	session::{SessionLayer, SessionService},
	staging::{StagingLayer, StagingService},
};
use crate::{
	Answer, Call, Error,
	auth::manager::AuthManager,
	layer::{LayerCall, budget::InferenceLedger},
	operation::usage::ConsoleUsageManager,
	provider::builtin::{ProductionDependencies, ProductionRouteComposer},
	registry::RouteUnavailable,
	settings::InferenceSettings,
};

/// Construction-time erased route service that reuses the outer logical
/// execution context.
pub type RouteProviderService = tower::util::BoxCloneSyncService<LayerCall<Call>, Answer, Error>;

/// Construction-time route-stack factory consumed by the immutable registry
/// builder.
pub trait RouteStackFactory: Send + Sync + 'static {
	/// Builds the comprehensive service for one catalog route or returns typed
	/// construction evidence.
	fn build(
		&self,
		catalog: &Catalog,
		route: &RouteDef,
	) -> Result<RouteProviderService, RouteUnavailable>;
}

/// Complete production route composer supplied with account, auth, session,
/// codec, rate, transport, projection, and observation dependencies by the
/// application composition root.
pub trait RouteComposer: Send + Sync + 'static {
	/// Composes the fixed stack once for a concrete route.
	fn compose(
		&self,
		catalog: &Catalog,
		route: &RouteDef,
	) -> Result<RouteProviderService, RouteUnavailable>;
}

/// Production configuration for built-in route construction.
#[derive(Clone)]
pub struct BuiltinConfig {
	composer:      sync::Arc<dyn RouteComposer>,
	auth_manager:  Option<AuthManager>,
	usage_manager: Option<ConsoleUsageManager>,
	settings:      InferenceSettings,
}
impl BuiltinConfig {
	/// Creates configuration from a production composer owning all route-scoped
	/// dependencies.
	pub fn new(composer: sync::Arc<dyn RouteComposer>) -> Self {
		Self {
			composer,
			auth_manager: None,
			usage_manager: None,
			settings: InferenceSettings::default(),
		}
	}

	/// Creates the canonical production composer from explicit shared
	/// dependencies.
	pub fn production(dependencies: ProductionDependencies) -> Self {
		let auth_manager = dependencies.auth_manager();
		let usage_manager = dependencies.usage_manager();
		let settings = dependencies.settings().clone();
		Self {
			composer: sync::Arc::new(ProductionRouteComposer::new(dependencies)),
			auth_manager: Some(auth_manager),
			usage_manager,
			settings,
		}
	}

	/// Attaches the comprehensive auth-management service used by provider-level
	/// auth operations.
	pub fn with_auth_manager(mut self, auth_manager: AuthManager) -> Self {
		self.auth_manager = Some(auth_manager);
		self
	}

	/// Attaches provider console usage backends used by usage operations.
	pub fn with_usage_manager(mut self, usage_manager: ConsoleUsageManager) -> Self {
		self.usage_manager = Some(usage_manager);
		self
	}

	/// Borrows the auth manager for registry management-service injection.
	pub(crate) const fn auth_manager(&self) -> Option<&AuthManager> {
		self.auth_manager.as_ref()
	}

	/// Borrows the console usage manager for registry management-service
	/// injection.
	pub(crate) const fn usage_manager(&self) -> Option<&ConsoleUsageManager> {
		self.usage_manager.as_ref()
	}

	/// Borrows the immutable settings snapshot shared by routing and route
	/// execution.
	pub(crate) const fn settings(&self) -> &InferenceSettings {
		&self.settings
	}
}

/// Registry-facing factory that delegates only construction; request stacks are
/// never rebuilt.
#[derive(Clone)]
pub struct BuiltinRouteStackFactory {
	config: BuiltinConfig,
}
impl BuiltinRouteStackFactory {
	/// Creates a factory from complete production dependencies.
	pub const fn new(config: BuiltinConfig) -> Self {
		Self { config }
	}
}
impl RouteStackFactory for BuiltinRouteStackFactory {
	fn build(
		&self,
		catalog: &Catalog,
		route: &RouteDef,
	) -> Result<RouteProviderService, RouteUnavailable> {
		self.config.composer.compose(catalog, route)
	}
}

/// Construction inputs for a route-local stack; outer execution state is
/// supplied by the registry.
#[derive(Clone)]
pub struct RouteStackLayers<I, SS, SM, AP, AC, RL, EN, CA, H = NoHookHandle> {
	/// Canonical operation-specific planning and response validation.
	pub operation:        OperationPolicyLayer,
	/// Intent negotiation.
	pub intent:           IntentLayer<I>,
	/// Session strategy and reseed policy.
	pub session:          SessionLayer<SS>,
	/// Transactional semantic attempts.
	pub semantic:         SemanticLayer<SM>,
	/// Route-scoped recovery and conservative discovery projection.
	pub recovery:         RecoveryLayer,
	/// Route/account admission.
	pub admission:        AdmissionLayer,
	/// Account selection.
	pub account:          AccountPoolLayer<AP>,
	/// Opaque credential lease acquisition.
	pub auth:             AuthLeaseLayer<AC>,
	/// Replay-safe same-route retry.
	pub retry:            TransportRetryLayer,
	/// Per-transport-attempt rate reservation.
	pub rate:             RateLayer<RL>,
	/// Pure codec lowering and the pre-encoding hook seam.
	pub encode:           EncodeLayer<EN, H>,
	/// Credential application and optional per-attempt signing hook.
	pub credential_apply: CredentialApplyLayer<CA, H>,
	/// Classified provider-error interception before registry fallback safety.
	pub provider_error:   ProviderErrorLayer<H>,
}

impl<I, SS, SM, AP, AC, RL, EN, CA> RouteStackLayers<I, SS, SM, AP, AC, RL, EN, CA> {
	/// Threads one concrete cold-path hook dispatcher through every inference
	/// seam without introducing dynamic dispatch.
	pub fn with_hook<H: HookHandle>(
		self,
		hook: H,
	) -> RouteStackLayers<I, SS, SM, AP, AC, RL, EN, CA, H> {
		RouteStackLayers {
			operation:        self.operation,
			intent:           self.intent,
			session:          self.session,
			semantic:         self.semantic,
			recovery:         self.recovery,
			admission:        self.admission,
			account:          self.account,
			auth:             self.auth,
			retry:            self.retry,
			rate:             self.rate,
			encode:           self.encode.with_hook(hook.clone()),
			credential_apply: self.credential_apply.with_hook(hook.clone()),
			provider_error:   self.provider_error.with_hook(hook),
		}
	}
}

/// Stack segment from credential application through canonical recovery.
pub type RecoveryStack<W, CA, EN, RL, AC, AP, H> = RecoveryService<
	AttemptService<
		AdmissionService<
			AccountPoolService<
				AuthLeaseService<
					TransportRetryService<
						RateService<EncodeService<CredentialApplyService<W, CA, H>, EN, H>, RL>,
					>,
					AC,
				>,
				AP,
			>,
		>,
	>,
>;
/// Stack segment through semantic validation and typed answer projection.
pub type AnswerStack<W, CA, EN, RL, AC, AP, SM, H> =
	AnswerService<SemanticService<RecoveryStack<W, CA, EN, RL, AC, AP, H>, SM>>;
/// Stack segment from intent through session and response processing.
pub type IntentStack<W, CA, EN, RL, AC, AP, SM, SS, I, H> = OperationPolicyService<
	IntentService<SessionService<AnswerStack<W, CA, EN, RL, AC, AP, SM, H>, SS>, I>,
>;
/// Full route stack with an error hook enclosing every route-local failure.
pub type HookedRouteStack<W, CA, EN, RL, AC, AP, SM, SS, I, H> =
	ProviderErrorService<IntentStack<W, CA, EN, RL, AC, AP, SM, SS, I, H>, H>;
/// Outer execution service type wrapping the full registry fallback loop
/// exactly once.
pub type OuterExecutionService<S, O> = ObserveService<OverallBudgetService<StagingService<S>>, O>;

/// Applies route-local layers exactly once; the returned service accepts an
/// existing `LayerCall`.
///
/// Outer to inner: Intent → Session → Answer → Semantic → Recovery →
/// Attempt(Admission → `AccountPool` → `AuthLease` → `TransportRetry` → Rate →
/// Encode → `CredentialApply` → `WireTransport`).
pub fn build_route_stack<W, I, SS, SM, AP, AC, RL, EN, CA, H>(
	wire: W,
	layers: RouteStackLayers<I, SS, SM, AP, AC, RL, EN, CA, H>,
) -> HookedRouteStack<W, CA, EN, RL, AC, AP, SM, SS, I, H>
where
	W: Clone,
	CA: Clone,
	EN: Clone,
	RL: Clone,
	AC: Clone,
	AP: Clone,
	SM: Clone,
	SS: Clone,
	I: Clone,
	H: HookHandle,
{
	let service = layers.credential_apply.layer(wire);
	let service = layers.encode.layer(service);
	let service = layers.rate.layer(service);
	let service = layers.retry.layer(service);
	let service = layers.auth.layer(service);
	let service = layers.account.layer(service);
	let service = layers.admission.layer(service);
	let service = AttemptLayer.layer(service);
	let service = layers.recovery.layer(service);
	let service = layers.semantic.layer(service);
	let service = AnswerLayer.layer(service);
	let service = layers.session.layer(service);
	let service = layers.operation.layer(layers.intent.layer(service));
	layers.provider_error.layer(service)
}

/// Wraps the complete preplanned registry fallback service in one budget and
/// observation boundary.
pub fn build_execution_stack<S, O>(
	dispatch: S,
	observer: ObserveLayer<O>,
	ledger: InferenceLedger,
) -> OuterExecutionService<S, O>
where
	O: Clone,
{
	observer.layer(OverallBudgetLayer::new(ledger).layer(StagingLayer.layer(dispatch)))
}
