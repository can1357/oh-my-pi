//! Immutable provider route registry and construction-time builder.

use std::{
	collections::HashMap,
	iter, ops,
	sync::Arc,
	task::{Context, Poll},
	time::{Instant, SystemTime},
};

use arc_swap::ArcSwap;
use futures::future::BoxFuture;
use omp_core::{Str, sf};
use tower::{Service, ServiceExt};
use tracing::Instrument as _;

use crate::{
	answer::{Answer, AnswerBody, ResponseMeta},
	auth::{AuthManager, AwsCredentialError, CatalogAuthSpecError},
	body::RetryDecision,
	call::{Call, OperationCall},
	catalog::{CatalogRevision, OperationKind, ProviderId, RouteDef, RouteId, snapshot::Catalog},
	error::{Error, ErrorDetail, ErrorKind, ErrorPhase, RetryAction},
	id::RequestId,
	layer::{
		ExecutionContext, LayerCall,
		budget::{InferenceBudget, InferenceBudgetPolicy, InferenceLedger},
		observe::{NoopObserver, ObserveLayer, Observer},
		stack::{
			BuiltinConfig, BuiltinRouteStackFactory, RouteProviderService, RouteStackFactory,
			build_execution_stack,
		},
	},
	operation::{discovery::CatalogDiscoveryProjectorError, usage::ConsoleUsageManager},
	provider::ProviderService,
	receipt::{AttemptOutcome, ExecutionReceipt, ReasonId},
	settings,
};

/// Typed evidence explaining why a catalog route has no constructed service.
#[derive(Clone, Debug, thiserror::Error)]
pub enum RouteUnavailable {
	/// Construction failed without a more precise typed source.
	#[error("route unavailable")]
	Static {
		/// Catalog route that could not be constructed.
		route:     RouteId,
		/// Stable secret-free reason.
		reason:    ReasonId,
		/// Operation affected when the failure is narrower than the route.
		operation: Option<OperationKind>,
	},
	/// The route's catalog discovery projection is invalid.
	#[error("route discovery projector is invalid")]
	CatalogDiscoveryProjector {
		/// Catalog route that could not be constructed.
		route:     RouteId,
		/// Stable secret-free reason.
		reason:    ReasonId,
		/// Operation affected when the failure is narrower than the route.
		operation: Option<OperationKind>,
		/// Exact catalog projection failure.
		#[source]
		source:    CatalogDiscoveryProjectorError,
	},
	/// Local AWS provider availability discovery failed.
	#[error("AWS route availability discovery failed")]
	AwsRegistry {
		/// Catalog route that could not be constructed.
		route:     RouteId,
		/// Stable secret-free reason.
		reason:    ReasonId,
		/// Operation affected when the failure is narrower than the route.
		operation: Option<OperationKind>,
		/// Exact secret-free AWS discovery failure.
		#[source]
		source:    AwsCredentialError,
	},
	/// The route's catalog authentication specification is invalid.
	#[error("route authentication specification is invalid")]
	CatalogAuthSpec {
		/// Catalog route that could not be constructed.
		route:     RouteId,
		/// Stable secret-free reason.
		reason:    ReasonId,
		/// Operation affected when the failure is narrower than the route.
		operation: Option<OperationKind>,
		/// Exact catalog authentication conversion failure.
		#[source]
		source:    CatalogAuthSpecError,
	},
	/// The route's model-discovery codec specification is invalid.
	#[error("route discovery codec specification is invalid")]
	DiscoveryCodec {
		/// Catalog route that could not be constructed.
		route:     RouteId,
		/// Stable secret-free reason.
		reason:    ReasonId,
		/// Operation affected when the failure is narrower than the route.
		operation: Option<OperationKind>,
		/// Exact codec construction failure.
		#[source]
		source:    Error,
	},
}

impl RouteUnavailable {
	/// Creates source-free construction evidence.
	pub const fn new(route: RouteId, reason: ReasonId, operation: Option<OperationKind>) -> Self {
		Self::Static { route, reason, operation }
	}

	/// Returns the catalog route that could not be constructed.
	pub const fn route(&self) -> &RouteId {
		match self {
			Self::Static { route, .. }
			| Self::CatalogDiscoveryProjector { route, .. }
			| Self::AwsRegistry { route, .. }
			| Self::CatalogAuthSpec { route, .. }
			| Self::DiscoveryCodec { route, .. } => route,
		}
	}

	/// Returns the stable secret-free reason.
	pub const fn reason(&self) -> &ReasonId {
		match self {
			Self::Static { reason, .. }
			| Self::CatalogDiscoveryProjector { reason, .. }
			| Self::AwsRegistry { reason, .. }
			| Self::CatalogAuthSpec { reason, .. }
			| Self::DiscoveryCodec { reason, .. } => reason,
		}
	}

	/// Returns the operation affected by this construction failure.
	pub const fn operation(&self) -> Option<OperationKind> {
		match self {
			Self::Static { operation, .. }
			| Self::CatalogDiscoveryProjector { operation, .. }
			| Self::AwsRegistry { operation, .. }
			| Self::CatalogAuthSpec { operation, .. }
			| Self::DiscoveryCodec { operation, .. } => *operation,
		}
	}
}

#[derive(Clone)]
enum RouteBinding {
	Available(RouteProviderService),
	Unavailable(RouteUnavailable),
}

/// Immutable registry of catalog definitions and preconstructed route services.
#[derive(Clone)]
pub struct Registry {
	inner: Arc<RegistryInner>,
}

struct RegistryInner {
	catalog:          Arc<Catalog>,
	bindings:         HashMap<RouteId, RouteBinding>,
	auth_manager:     Option<AuthManager>,
	usage_manager:    Option<ConsoleUsageManager>,
	inference_ledger: InferenceLedger,
	generation:       u64,
	settings:         settings::InferenceSettings,
}

impl Registry {
	/// Starts a construction-time builder for one immutable catalog snapshot.
	pub fn builder(catalog: Arc<Catalog>) -> RegistryBuilder {
		RegistryBuilder {
			catalog,
			bindings: HashMap::new(),
			auth_manager: None,
			usage_manager: None,
			inference_ledger: InferenceLedger::default(),
			generation: 1,
			settings: settings::InferenceSettings::default(),
		}
	}

	/// Returns the immutable catalog revision used by this registry.
	pub fn catalog_revision(&self) -> &CatalogRevision<str> {
		self.inner.catalog.revision()
	}

	/// Returns the registry state generation captured by execution plans.
	pub fn generation(&self) -> u64 {
		self.inner.generation
	}

	/// Borrows the immutable catalog snapshot.
	pub fn catalog(&self) -> &Catalog {
		&self.inner.catalog
	}

	/// Returns the immutable settings snapshot shared by planning and route
	/// execution.
	pub fn settings(&self) -> &settings::InferenceSettings {
		&self.inner.settings
	}

	/// Reports whether direct route-independent authentication operations are
	/// constructed.
	pub fn contains_auth_manager(&self) -> bool {
		self.inner.auth_manager.is_some()
	}

	/// Reports whether direct route-independent usage operations are
	/// constructed.
	pub fn contains_usage_manager(&self) -> bool {
		self.inner.usage_manager.is_some()
	}

	/// Returns the constructed route-independent usage manager.
	pub fn usage_manager(&self) -> Option<ConsoleUsageManager> {
		self.inner.usage_manager.clone()
	}

	/// Returns typed construction evidence for an unavailable route.
	pub fn unavailability(&self, route: &RouteId<str>) -> Option<&RouteUnavailable> {
		match self.inner.bindings.get(route) {
			Some(RouteBinding::Unavailable(evidence)) => Some(evidence),
			Some(RouteBinding::Available(_)) | None => None,
		}
	}

	/// Returns whether a concrete route has a constructed comprehensive service.
	pub fn contains_service(&self, route: &RouteId<str>) -> bool {
		matches!(self.inner.bindings.get(route), Some(RouteBinding::Available(_)))
	}

	/// Creates a clone-cheap comprehensive dispatch service with no observation
	/// sink.
	pub fn service(&self) -> ProviderService {
		self.service_with_observer(NoopObserver)
	}

	/// Creates one outer logical-execution boundary around all exact route
	/// fallbacks.
	pub fn service_with_observer<O: Observer>(&self, observer: O) -> ProviderService {
		ProviderService::new(build_execution_stack(
			RegistryDispatch { registry: self.clone() },
			ObserveLayer::new(observer),
			self.inner.inference_ledger.clone(),
		))
	}

	/// Validates a planned call against current catalog and registry state
	/// before route dispatch.
	pub fn validate_plan(&self, call: &Call, now: Instant) -> Result<(), Error> {
		let plan = call.execution.as_ref().ok_or_else(|| {
			Error::planning(
				ErrorKind::InvalidRequest,
				ErrorDetail::target(sf!("call-has-no-execution-plan")),
				ExecutionReceipt::default(),
			)
		})?;
		plan.validate(now, self.catalog_revision(), self.generation())?;
		if call.operation.kind() != plan.operation {
			return Err(Error::planning(
				ErrorKind::ProviderContractMismatch,
				ErrorDetail::capability(
					Str::new(call.operation.kind().to_string()),
					ReasonId(sf!("planned-operation-mismatch")),
				),
				ExecutionReceipt::default(),
			));
		}
		Ok(())
	}

	pub(crate) fn route_service(
		&self,
		route: &RouteId<str>,
		operation: OperationKind,
	) -> Result<RouteProviderService, Error> {
		match self.inner.bindings.get(route) {
			Some(RouteBinding::Available(service)) => Ok(service.clone()),
			Some(RouteBinding::Unavailable(evidence)) => {
				Err(route_unavailable_error(evidence, operation))
			},
			None => Err(target_error(route.as_str())),
		}
	}
}
/// Atomically published registry snapshot held for one complete lookup.
///
/// A snapshot owns the loaded [`Registry`], so rebuilding the live registry
/// cannot invalidate catalog or route-service references used by its caller.
#[derive(Clone)]
pub struct RegistrySnapshot {
	registry: Arc<Registry>,
}

impl ops::Deref for RegistrySnapshot {
	type Target = Registry;

	fn deref(&self) -> &Self::Target {
		&self.registry
	}
}

/// Rebuildable registry publication point.
///
/// Readers call [`Self::load`] once, then perform all catalog, generation, and
/// route-service lookups through the returned [`RegistrySnapshot`]. Rebuilds
/// publish a wholly preconstructed [`Registry`]; they never construct route
/// stacks on a request path.
#[derive(Clone)]
pub struct RegistryHandle {
	current: Arc<ArcSwap<Registry>>,
}

impl RegistryHandle {
	/// Starts publication from one fully constructed registry.
	pub fn new(registry: Registry) -> Self {
		Self { current: Arc::new(ArcSwap::from_pointee(registry)) }
	}

	/// Loads exactly one immutable registry snapshot for a lookup.
	pub fn load(&self) -> RegistrySnapshot {
		RegistrySnapshot { registry: self.current.load_full() }
	}

	/// Atomically publishes a wholly rebuilt registry and returns the previous
	/// immutable snapshot for optional draining or inspection.
	pub fn replace(&self, registry: Registry) -> RegistrySnapshot {
		RegistrySnapshot { registry: self.current.swap(Arc::new(registry)) }
	}

	/// Creates a dispatch service that loads the registry once per call.
	pub fn service(&self) -> ProviderService {
		self.service_with_observer(NoopObserver)
	}

	/// Creates a dispatch service with one outer observation boundary per call.
	pub fn service_with_observer<O: Observer>(&self, observer: O) -> ProviderService {
		ProviderService::new(build_execution_stack(
			LiveRegistryDispatch { registry: self.clone() },
			ObserveLayer::new(observer),
			InferenceLedger::default(),
		))
	}
}

impl Registry {
	/// Moves this immutable registry behind an atomic rebuild publication point.
	pub fn into_handle(self) -> RegistryHandle {
		RegistryHandle::new(self)
	}
}

/// Construction-time builder; mutation ends permanently at
/// [`RegistryBuilder::build`].
pub struct RegistryBuilder {
	catalog:          Arc<Catalog>,
	bindings:         HashMap<RouteId, RouteBinding>,
	auth_manager:     Option<AuthManager>,
	usage_manager:    Option<ConsoleUsageManager>,
	inference_ledger: InferenceLedger,
	generation:       u64,
	settings:         settings::InferenceSettings,
}

impl RegistryBuilder {
	/// Sets the generation captured by plans after this complete registry is
	/// rebuilt. Call this after all construction-time registrations so a catalog
	/// overlay generation is preserved exactly.
	pub const fn with_generation(mut self, generation: u64) -> Self {
		self.generation = generation;
		self
	}

	/// Sets the default inference envelope for extensions without a dedicated
	/// policy.
	pub fn with_default_inference_budget(
		self,
		per_turn: InferenceBudget,
		per_session: InferenceBudget,
	) -> Self {
		self
			.inference_ledger
			.set_default_policy(InferenceBudgetPolicy { per_turn, per_session });
		self
	}

	/// Sets hard turn and session ceilings for one extension.
	pub fn with_inference_budget(
		self,
		extension: Str,
		per_turn: InferenceBudget,
		per_session: InferenceBudget,
	) -> Self {
		self
			.inference_ledger
			.set_policy(extension, InferenceBudgetPolicy { per_turn, per_session });
		self
	}

	/// Registers one preconstructed route-local service for a catalog route.
	pub fn register_route(
		mut self,
		route: RouteId,
		service: RouteProviderService,
	) -> Result<Self, Error> {
		self.require_catalog_route(&route)?;
		if self
			.bindings
			.insert(route.clone(), RouteBinding::Available(service))
			.is_some()
		{
			return Err(duplicate_route_error(&route));
		}
		self.generation = self.generation.saturating_add(1);
		Ok(self)
	}

	/// Registers typed unavailability for a catalog route that cannot be
	/// constructed.
	pub fn register_unavailable(mut self, evidence: RouteUnavailable) -> Result<Self, Error> {
		self.require_catalog_route(evidence.route())?;
		if self
			.bindings
			.insert(evidence.route().clone(), RouteBinding::Unavailable(evidence.clone()))
			.is_some()
		{
			return Err(duplicate_route_error(evidence.route()));
		}
		self.generation = self.generation.saturating_add(1);
		Ok(self)
	}

	/// Registers the one route-independent authentication/account-management
	/// service.
	pub fn with_auth_manager(mut self, manager: AuthManager) -> Self {
		self.auth_manager = Some(manager);
		self.generation = self.generation.saturating_add(1);
		self
	}

	/// Registers route-independent provider console usage backends.
	pub fn with_usage_manager(mut self, manager: ConsoleUsageManager) -> Self {
		self.usage_manager = Some(manager);
		self.generation = self.generation.saturating_add(1);
		self
	}

	/// Constructs every catalog route exactly once through a production
	/// route-stack factory.
	#[tracing::instrument(
		level = "debug",
		name = "registry_construct_routes",
		skip_all,
		fields(
			catalog_revision = self.catalog.revision().as_str(),
			route_count = self.catalog.routes().len()
		)
	)]
	pub fn with_factory(mut self, factory: Arc<dyn RouteStackFactory>) -> Result<Self, Error> {
		for route in self.catalog.routes() {
			if self.bindings.contains_key(&route.id) {
				continue;
			}
			let binding = match factory.build(&self.catalog, route) {
				Ok(service) => RouteBinding::Available(service),
				Err(evidence) => RouteBinding::Unavailable(evidence),
			};
			self.bindings.insert(route.id.clone(), binding);
			self.generation = self.generation.saturating_add(1);
		}
		Ok(self)
	}

	/// Constructs every built-in route once from complete production composition
	/// dependencies.
	pub fn with_builtins(self, config: BuiltinConfig) -> Result<Self, Error> {
		let auth_manager = config.auth_manager().cloned();
		let usage_manager = config.usage_manager().cloned();
		let settings = config.settings().clone();
		let builder = match auth_manager {
			Some(manager) => self.with_auth_manager(manager),
			None => self,
		};
		let builder = match usage_manager {
			Some(manager) => builder.with_usage_manager(manager),
			None => builder,
		};
		let mut builder = builder.with_factory(Arc::new(BuiltinRouteStackFactory::new(config)))?;
		builder.settings = settings;
		Ok(builder)
	}

	/// Freezes all definitions and services into a clone-cheap immutable
	/// registry.
	#[tracing::instrument(
		level = "debug",
		name = "registry_build",
		skip_all,
		fields(
			catalog_revision = self.catalog.revision().as_str(),
			generation = self.generation,
			route_count = self.catalog.routes().len()
		)
	)]
	pub fn build(self) -> Result<Registry, Error> {
		for route in self.catalog.routes() {
			if !self.bindings.contains_key(&route.id) {
				return Err(Error::planning(
					ErrorKind::RouteUnavailable,
					ErrorDetail::capability(
						Str::new(route.id.as_str()),
						ReasonId(sf!("route-has-no-service-or-unavailability-evidence")),
					),
					ExecutionReceipt::default(),
				));
			}
		}
		if self
			.catalog
			.providers()
			.iter()
			.any(|provider| provider.management.supports(OperationKind::Auth))
			&& self.auth_manager.is_none()
		{
			return Err(Error::planning(
				ErrorKind::RouteUnavailable,
				ErrorDetail::capability(
					Str::new(OperationKind::Auth.to_string()),
					ReasonId(sf!("auth-manager-not-constructed")),
				),
				ExecutionReceipt::default(),
			));
		}
		tracing::debug!(
			generation = self.generation,
			route_count = self.bindings.len(),
			"inference registry built"
		);
		Ok(Registry {
			inner: Arc::new(RegistryInner {
				catalog:          self.catalog,
				bindings:         self.bindings,
				auth_manager:     self.auth_manager,
				usage_manager:    self.usage_manager,
				inference_ledger: self.inference_ledger,
				generation:       self.generation,
				settings:         self.settings,
			}),
		})
	}

	/// Builds an explicitly non-routable catalog projection for control-plane
	/// code that only needs immutable catalog and generation lookups.
	///
	/// The returned registry contains no route, authentication, or usage
	/// services. Calls through [`Registry::service`] therefore fail closed.
	pub fn build_catalog_projection(self) -> Registry {
		Registry {
			inner: Arc::new(RegistryInner {
				catalog:          self.catalog,
				bindings:         HashMap::new(),
				auth_manager:     None,
				usage_manager:    None,
				inference_ledger: self.inference_ledger,
				generation:       self.generation,
				settings:         self.settings,
			}),
		}
	}

	fn require_catalog_route(&self, route: &RouteId<str>) -> Result<&RouteDef, Error> {
		self
			.catalog
			.route(route)
			.ok_or_else(|| target_error(route.as_str()))
	}
}

#[derive(Clone)]
struct LiveRegistryDispatch {
	registry: RegistryHandle,
}

impl Service<LayerCall<Call>> for LiveRegistryDispatch {
	type Error = Error;
	type Future = BoxFuture<'static, Result<Answer, Error>>;
	type Response = Answer;

	/// Dispatch readiness is enforced inside each exact selected route service.
	fn poll_ready(&mut self, _context: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
		Poll::Ready(Ok(()))
	}

	fn call(&mut self, call: LayerCall<Call>) -> Self::Future {
		let registry = self.registry.clone();
		Box::pin(async move {
			let snapshot = registry.load();
			snapshot
				.registry
				.inner
				.inference_ledger
				.admit(&call.payload, &call.context)?;
			let accounting_call = call.payload.clone();
			let context = call.context.clone();
			let result = dispatch_preplanned(snapshot.registry.as_ref().clone(), call).await;
			snapshot
				.registry
				.inner
				.inference_ledger
				.charge(&accounting_call, &context);
			result
		})
	}
}

#[derive(Clone)]
struct RegistryDispatch {
	registry: Registry,
}

impl Service<LayerCall<Call>> for RegistryDispatch {
	type Error = Error;
	type Future = BoxFuture<'static, Result<Answer, Error>>;
	type Response = Answer;

	/// Dispatch readiness is enforced inside each exact selected route service.
	fn poll_ready(&mut self, _context: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
		Poll::Ready(Ok(()))
	}

	fn call(&mut self, call: LayerCall<Call>) -> Self::Future {
		let registry = self.registry.clone();
		Box::pin(async move { dispatch_preplanned(registry, call).await })
	}
}

async fn dispatch_preplanned(
	registry: Registry,
	mut layered: LayerCall<Call>,
) -> Result<Answer, Error> {
	registry.validate_plan(&layered.payload, Instant::now())?;
	let mut plan = layered
		.payload
		.execution
		.as_ref()
		.expect("validated planned call")
		.as_ref()
		.clone();
	if let OperationCall::Auth(request) = &layered.payload.operation {
		let manager = registry.inner.auth_manager.as_ref().ok_or_else(|| {
			Error::planning(
				ErrorKind::RouteUnavailable,
				ErrorDetail::capability(
					Str::new(OperationKind::Auth.to_string()),
					ReasonId(sf!("auth-manager-not-constructed")),
				),
				layered.context.receipt(),
			)
		})?;
		let provider_span = tracing::debug_span!(
			"provider_request",
			provider = plan.provider.as_str(),
			model = "",
			route = plan.route.as_str(),
			operation = %layered.payload.operation.kind(),
			attempt = 1_u64,
		);
		let body = match manager
			.execute(request.as_ref().clone())
			.instrument(provider_span)
			.await
		{
			Ok(body) => body,
			Err(mut error) => {
				attribute_error(&mut error, &plan.provider, &plan.route, &layered.payload.id);
				layered.context.finalize_error(&mut error);
				return Err(error);
			},
		};
		return Ok(Answer {
			meta:    ResponseMeta {
				request_id:          layered.payload.id.clone(),
				provider:            plan.provider.clone(),
				route:               plan.route.clone(),
				model:               None,
				provider_request_id: None,
				created_at:          SystemTime::now(),
			},
			receipt: layered.context.receipt(),
			body:    AnswerBody::Auth(body),
		});
	}
	if let OperationCall::Usage(request) = &layered.payload.operation {
		let manager = registry.inner.usage_manager.as_ref().ok_or_else(|| {
			Error::planning(
				ErrorKind::RouteUnavailable,
				ErrorDetail::capability(
					Str::new(OperationKind::Usage.to_string()),
					ReasonId(sf!("usage-manager-not-constructed")),
				),
				layered.context.receipt(),
			)
		})?;
		let deadline = layered.payload.deadline.or_else(|| {
			layered.payload.budget.max_elapsed.and_then(|maximum| {
				Instant::now().checked_add(maximum.saturating_sub(layered.context.elapsed()))
			})
		});
		let provider_span = tracing::debug_span!(
			"provider_request",
			provider = plan.provider.as_str(),
			model = "",
			route = plan.route.as_str(),
			operation = %layered.payload.operation.kind(),
			attempt = 1_u64,
		);
		let body = match manager
			.execute(&plan.provider, &plan.route, request, deadline)
			.instrument(provider_span)
			.await
		{
			Ok(body) => body,
			Err(mut error) => {
				attribute_error(&mut error, &plan.provider, &plan.route, &layered.payload.id);
				layered.context.finalize_error(&mut error);
				return Err(error);
			},
		};
		return Ok(Answer {
			meta:    ResponseMeta {
				request_id:          layered.payload.id.clone(),
				provider:            plan.provider.clone(),
				route:               plan.route.clone(),
				model:               None,
				provider_request_id: None,
				created_at:          SystemTime::now(),
			},
			receipt: layered.context.receipt(),
			body:    AnswerBody::Usage(Box::new(body)),
		});
	}
	let candidates = plan.fallbacks.iter().cloned().collect::<Vec<_>>();
	for (index, fallback) in iter::once(None)
		.chain(candidates.iter().map(Some))
		.enumerate()
	{
		if let Some(fallback) = fallback {
			plan.model = fallback.model.clone();
			plan.provider = fallback.provider.clone();
			plan.route = fallback.route.clone();
			plan.codec = fallback.codec.clone();
			plan.policy_model = fallback.policy_model.clone();
			plan.wire_policy = fallback.wire_policy.clone();
			plan.thinking_policy = fallback.thinking_policy.clone();
			plan.thinking_selection = fallback.thinking_selection.clone();
			plan.decisions = fallback.decisions.clone();
			plan.runtime_evidence = fallback.runtime_evidence.clone();
			plan.wire_target = fallback.wire_target.clone();
			plan.fallbacks = candidates[index..].into();
			layered.payload.execution = Some(Arc::new(plan.clone()));
		}
		let service = match registry.route_service(&plan.route, layered.payload.operation.kind()) {
			Ok(service) => service,
			Err(mut error) => {
				attribute_error(&mut error, &plan.provider, &plan.route, &layered.payload.id);
				layered.context.finalize_error(&mut error);
				return Err(error);
			},
		};
		let attempt_start = layered.context.receipt().attempts.len();
		let provider_span = tracing::debug_span!(
			"provider_request",
			provider = plan.provider.as_str(),
			model = plan.model.as_ref().map_or("", |model| model.as_str()),
			route = plan.route.as_str(),
			operation = %layered.payload.operation.kind(),
			attempt = index.saturating_add(1),
		);
		match service
			.oneshot(layered.clone())
			.instrument(provider_span)
			.await
		{
			Ok(mut answer) => {
				layered.context.merge_receipt(&answer.receipt);
				answer.receipt = layered.context.receipt();
				if index > 0
					&& let (Some(primary), Some(selected)) =
						(plan.fallback_scope.primary.as_ref(), plan.model.as_ref())
					&& primary != selected
				{
					settings::record_fallback(primary, selected);
				}
				return Ok(answer);
			},
			Err(mut error) => {
				attribute_error(&mut error, &plan.provider, &plan.route, &layered.payload.id);
				let has_next = index < candidates.len();
				let credential_distinct = candidates
					.get(index)
					.is_some_and(|candidate| candidate.provider != plan.provider);
				let context_promotion = !error.committed
					&& error.kind == ErrorKind::ContextOverflow
					&& plan.model.as_ref().is_some_and(|model| {
						registry
							.catalog()
							.model(model)
							.and_then(|model| model.context_promotion_target.as_ref())
							.zip(
								candidates
									.get(index)
									.and_then(|candidate| candidate.model.as_ref()),
							)
							.is_some_and(|(target, next)| target == next)
					});
				if context_promotion || fallback_is_safe(&error, has_next, credential_distinct) {
					layered.context.merge_receipt(error.receipt());
					hide_attempts_since(&layered.context, attempt_start);
					let next = candidates.get(index);
					tracing::warn!(
						provider = plan.provider.as_str(),
						model = plan.model.as_ref().map_or("", |model| model.as_str()),
						route = plan.route.as_str(),
						next_provider = next.map_or("", |candidate| candidate.provider.as_str()),
						next_model = next
							.and_then(|candidate| candidate.model.as_ref())
							.map_or("", |model| model.as_str()),
						error_kind = ?error.kind,
						error_phase = ?error.phase,
						context_promotion,
						"provider request failed; trying planned fallback"
					);
					continue;
				}
				layered.context.finalize_error(&mut error);
				return Err(error);
			},
		}
	}
	unreachable!("primary route and finite preplanned fallbacks always return")
}

fn attribute_error(
	error: &mut Error,
	provider: &ProviderId<str>,
	route: &RouteId<str>,
	request_id: &RequestId<str>,
) {
	if error.provider.is_none() {
		error.provider = Some(Box::new(provider.to_owned()));
	}
	if error.route.is_none() {
		error.route = Some(Box::new(route.to_owned()));
	}
	if error.request_id.is_none() {
		error.request_id = Some(Box::new(request_id.to_owned()));
	}
}

fn fallback_is_safe(error: &Error, has_next: bool, credential_distinct: bool) -> bool {
	if !has_next || error.committed || error.action != RetryAction::ReselectRoute {
		return false;
	}
	if error.receipt().attempts.is_empty() {
		return error.phase == ErrorPhase::Admission
			|| (error.phase == ErrorPhase::Authentication && credential_distinct);
	}
	error.receipt().attempts.last().is_some_and(|attempt| {
		attempt.outcome != AttemptOutcome::FailedCommitted
			&& attempt.body.retry_decision == RetryDecision::Allow
	})
}

fn hide_attempts_since(context: &ExecutionContext, start: usize) {
	context.with_receipt(|receipt| {
		for attempt in receipt.attempts.iter_mut().skip(start) {
			attempt.hidden = true;
		}
	});
}

/// Projects construction evidence into the planning error returned to callers.
pub(crate) fn route_unavailable_error(
	evidence: &RouteUnavailable,
	operation: OperationKind,
) -> Error {
	let reason = if evidence.operation().is_none() || evidence.operation() == Some(operation) {
		evidence.reason().clone()
	} else {
		ReasonId(sf!("route-operation-not-constructed"))
	};
	let error = Error::planning(
		ErrorKind::RouteUnavailable,
		ErrorDetail::capability(Str::new(operation.to_string()), reason),
		ExecutionReceipt::default(),
	)
	.route(evidence.route().clone());
	match evidence {
		RouteUnavailable::CatalogDiscoveryProjector { source, .. } => {
			error.projector_source(source.clone())
		},
		RouteUnavailable::AwsRegistry { source, .. } => error.aws_registry_source(source.clone()),
		_ => error,
	}
}

fn target_error(selector: &str) -> Error {
	Error::planning(
		ErrorKind::TargetNotFound,
		ErrorDetail::target(Str::new(selector)),
		ExecutionReceipt::default(),
	)
}

fn duplicate_route_error(route: &RouteId<str>) -> Error {
	Error::planning(
		ErrorKind::ProviderContractMismatch,
		ErrorDetail::capability(
			Str::new(route.as_str()),
			ReasonId(sf!("duplicate-route-registration")),
		),
		ExecutionReceipt::default(),
	)
}

#[cfg(test)]
mod tests {
	use std::{
		env, fs,
		path::PathBuf,
		sync::{
			Arc,
			atomic::{AtomicUsize, Ordering},
		},
		time::{Duration, Instant, SystemTime, UNIX_EPOCH},
	};

	use futures::FutureExt as _;
	use tower::service_fn;

	use super::*;
	use crate::{
		account::AccountPool,
		answer::{AccountSummary, AuthAnswer, AuthSession},
		auth::{
			AuthLoginEngine, AuthRefreshEngine, CredentialBroker, CredentialBrokerEngines,
			CredentialStore, HeadlessKeySource, KeyId,
		},
		body::{AttemptBodyEvidence, Replayability, RetryDecisionReason},
		call::{
			AuthMethod, AuthRequest, InferenceAttribution as CallInferenceAttribution, LoginRequest,
			Target,
		},
		catalog::AuthSpecId as CatalogAuthSpecId,
		error::ErrorPhase,
		id::AccountId as IdAccountId,
		plan::{
			CapabilityAvailability, ExecutionPlan, FallbackScope, ReplayPlan, RouteHealth,
			RuntimeRouteEvidence,
		},
		receipt::{
			AttemptReceipt, Cost, ExecutionBudget as ReceiptExecutionBudget, ExecutionBudget,
			ProviderEvidence, Usage,
		},
	};

	#[derive(Clone, Copy)]
	struct UnusedLogin(AuthMethod);

	impl AuthLoginEngine for UnusedLogin {
		fn method(&self) -> AuthMethod {
			self.0
		}

		fn supports(&self, _provider: &ProviderId<str>) -> bool {
			true
		}

		fn begin(
			&self,
			_request: LoginRequest,
			_spec: CatalogAuthSpecId,
		) -> futures::future::BoxFuture<'_, Result<AuthSession, Error>> {
			async { Err(test_auth_error()) }.boxed()
		}
	}

	struct UnusedRefresh;

	impl AuthRefreshEngine for UnusedRefresh {
		fn refresh(
			&self,
			_account: IdAccountId,
		) -> futures::future::BoxFuture<'_, Result<AccountSummary, Error>> {
			async { Err(test_auth_error()) }.boxed()
		}
	}

	fn test_auth_error() -> Error {
		Error::new(
			ErrorKind::InternalInvariant,
			ErrorPhase::Authentication,
			RetryAction::Never,
			ExecutionReceipt::default(),
		)
	}

	fn auth_manager(catalog: Arc<Catalog>) -> (AuthManager, PathBuf) {
		let suffix = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.unwrap()
			.as_nanos();
		let path =
			env::temp_dir().join(format!("omp-auth-manager-{}-{suffix}.sqlite", std::process::id()));
		let store = Arc::new(
			CredentialStore::open(
				&path,
				Arc::new(HeadlessKeySource::new(KeyId::new("registry-test"), [7; 32])),
			)
			.unwrap(),
		);
		let broker = CredentialBroker::system(&catalog, CredentialBrokerEngines::default()).unwrap();
		let methods = [
			AuthMethod::ApiKey,
			AuthMethod::OAuthPkce,
			AuthMethod::OAuthDevice,
			AuthMethod::ApplicationDefault,
			AuthMethod::AwsCredentialChain,
			AuthMethod::SessionToken,
		];
		let engines = methods
			.into_iter()
			.map(|method| Arc::new(UnusedLogin(method)) as Arc<dyn AuthLoginEngine>)
			.collect();
		let manager = AuthManager::new(
			catalog,
			store,
			broker,
			AccountPool::new(),
			engines,
			Arc::new(UnusedRefresh),
		)
		.unwrap();
		(manager, path)
	}

	fn attempt(decision: RetryDecision) -> AttemptReceipt {
		AttemptReceipt {
			index:     0,
			hidden:    false,
			provider:  None,
			route:     None,
			account:   None,
			principal: None,
			body:      AttemptBodyEvidence {
				opened:         true,
				consumed:       decision != RetryDecision::Allow,
				replayability:  Replayability::Replayable,
				retry_decision: decision,
				reason:         if decision == RetryDecision::Allow {
					RetryDecisionReason::ReplayableSource
				} else {
					RetryDecisionReason::ConsumedOneShot
				},
			},

			outcome:           AttemptOutcome::FailedPreCommit,
			usage:             Usage::default(),
			cost:              Cost::default(),
			provider_evidence: ProviderEvidence::default(),
			elapsed:           Duration::ZERO,
		}
	}

	fn route_error(decision: Option<RetryDecision>) -> Error {
		let mut receipt = ExecutionReceipt::default();
		if let Some(decision) = decision {
			receipt.record_attempt(attempt(decision));
		}
		Error::new(
			ErrorKind::Connectivity,
			ErrorPhase::Connecting,
			RetryAction::ReselectRoute,
			receipt,
		)
	}

	#[test]
	fn dispatch_errors_inherit_the_selected_route_identity() {
		let provider = ProviderId::from("planned-provider");
		let route = RouteId::from("planned-route");
		let request_id = RequestId::from("planned-request");
		let mut error = test_auth_error();
		attribute_error(&mut error, &provider, &route, &request_id);
		assert_eq!(error.provider.as_deref(), Some(&provider));
		assert_eq!(error.route.as_deref(), Some(&route));
		assert_eq!(error.request_id.as_deref(), Some(&request_id));

		let mut specific = test_auth_error()
			.provider(ProviderId::from("specific-provider"))
			.route(RouteId::from("specific-route"))
			.request_id(RequestId::from("specific-request"));
		attribute_error(&mut specific, &provider, &route, &request_id);
		assert_eq!(specific.provider.as_deref().map(ProviderId::as_str), Some("specific-provider"));
		assert_eq!(specific.route.as_deref().map(RouteId::as_str), Some("specific-route"));
		assert_eq!(specific.request_id.as_deref().map(RequestId::as_str), Some("specific-request"));
	}
	#[test]
	fn rebuilt_handle_publishes_a_new_plan_generation() {
		let catalog = Arc::new(Catalog::embedded().clone());
		let registry = Registry {
			inner: Arc::new(RegistryInner {
				catalog:          catalog.clone(),
				bindings:         HashMap::new(),
				auth_manager:     None,
				usage_manager:    None,
				inference_ledger: InferenceLedger::default(),
				generation:       7,
				settings:         settings::InferenceSettings::default(),
			}),
		};
		let handle = registry.into_handle();
		assert_eq!(handle.load().generation(), 7);
		let previous = handle.replace(Registry {
			inner: Arc::new(RegistryInner {
				catalog,
				bindings: HashMap::new(),
				auth_manager: None,
				usage_manager: None,
				inference_ledger: InferenceLedger::default(),
				generation: 8,
				settings: settings::InferenceSettings::default(),
			}),
		});
		assert_eq!(previous.generation(), 7);
		assert_eq!(handle.load().generation(), 8);
	}
	#[test]
	fn catalog_projection_is_explicitly_non_routable() {
		let catalog = Arc::new(Catalog::embedded().clone());
		let projection = Registry::builder(catalog.clone()).build_catalog_projection();
		assert_eq!(projection.catalog_revision(), catalog.revision());
		assert_eq!(projection.generation(), 1);
		assert!(
			!catalog
				.routes()
				.iter()
				.any(|route| projection.contains_service(&route.id))
		);
		assert!(!projection.contains_auth_manager());
	}

	#[test]
	fn fallback_requires_precommit_reselect_and_explicit_body_permission() {
		assert!(fallback_is_safe(&route_error(Some(RetryDecision::Allow)), true, false));
		assert!(!fallback_is_safe(&route_error(Some(RetryDecision::Suppress)), true, false));
		assert!(!fallback_is_safe(&route_error(None), true, false));
		assert!(!fallback_is_safe(&route_error(Some(RetryDecision::Allow)), false, false));
		let committed = route_error(Some(RetryDecision::Allow)).committed(true);
		assert!(!fallback_is_safe(&committed, true, false));
		let mut committed_attempt = route_error(Some(RetryDecision::Allow));
		committed_attempt.receipt_mut().attempts[0].outcome = AttemptOutcome::FailedCommitted;
		assert!(!fallback_is_safe(&committed_attempt, true, false));
	}
	#[test]
	fn prebody_auth_fallback_requires_a_different_provider() {
		let error = Error::new(
			ErrorKind::Authentication,
			ErrorPhase::Authentication,
			RetryAction::ReselectRoute,
			ExecutionReceipt::default(),
		);
		assert!(fallback_is_safe(&error, true, true));
		assert!(!fallback_is_safe(&error, true, false));
		assert!(!fallback_is_safe(&error, false, true));
	}

	#[test]
	fn failed_fallback_receipts_are_hidden_once_in_shared_context() {
		let context = ExecutionContext::new(ReceiptExecutionBudget::default());
		let mut failed = ExecutionReceipt::default();
		failed.record_attempt(attempt(RetryDecision::Allow));
		context.merge_receipt(&failed);
		hide_attempts_since(&context, 0);
		let mut success = ExecutionReceipt::default();
		let mut visible = attempt(RetryDecision::Suppress);
		visible.index = 1;
		visible.outcome = AttemptOutcome::Succeeded;
		success.record_attempt(visible);
		context.merge_receipt(&success);
		let receipt = context.receipt();
		assert_eq!(receipt.attempts.len(), 2);
		assert!(receipt.attempts[0].hidden);
		assert!(!receipt.attempts[1].hidden);
		assert_eq!((receipt.attempts[0].index, receipt.attempts[1].index), (0, 1));
	}
	#[tokio::test]
	async fn auth_operations_bypass_route_codec_service() {
		let catalog = Arc::new(Catalog::embedded().clone());
		let route = catalog.routes().first().unwrap().clone();
		let provider = catalog.provider(&route.provider).unwrap().clone();
		let wire_policy = Arc::new(catalog.wire_policy(&provider.wire_policy).unwrap().clone());
		let (manager, store_path) = auth_manager(catalog.clone());
		let wire_calls = Arc::new(AtomicUsize::new(0));
		let calls = wire_calls.clone();
		let service = RouteProviderService::new(service_fn(move |_call: LayerCall<Call>| {
			calls.fetch_add(1, Ordering::Relaxed);
			async { Err::<Answer, Error>(test_auth_error()) }
		}));
		let registry = Registry {
			inner: Arc::new(RegistryInner {
				catalog:          catalog.clone(),
				bindings:         HashMap::from([(route.id.clone(), RouteBinding::Available(service))]),
				auth_manager:     Some(manager),
				usage_manager:    None,
				inference_ledger: InferenceLedger::default(),
				generation:       1,
				settings:         settings::InferenceSettings::default(),
			}),
		};
		let budget = ExecutionBudget::default();
		let now = Instant::now();
		let plan = ExecutionPlan {
			planned_at: SystemTime::now(),
			catalog_revision: catalog.revision().clone(),
			registry_generation: 1,
			expires_at: now + Duration::from_secs(30),
			operation: OperationKind::Auth,
			model: None,
			provider: provider.id.clone(),
			route: route.id.clone(),
			codec: route.codec.clone(),
			policy_model: None,
			wire_policy,
			thinking_policy: None,
			thinking_selection: None,
			decisions: Arc::from([]),
			fallback_scope: FallbackScope { primary: None, explicit: Arc::from([]) },
			fallbacks: Arc::from([]),
			replay: ReplayPlan::Replayable,
			budget: budget.clone(),
			runtime_evidence: RuntimeRouteEvidence {
				route:            route.id.clone(),
				generation:       1,
				health:           RouteHealth::Unknown,
				quota_millionths: 0,
				latency:          Duration::MAX,
				affinity:         false,
				operation:        CapabilityAvailability::Native,
				capabilities:     Arc::from([]),
			},
			wire_target: None,
		};
		let call = Call {
			id:             RequestId::from("auth-bypass"),
			target:         Target::ProviderService(provider.id),
			deadline:       None,
			budget:         budget.clone(),
			session:        None,
			debug_session:  None,
			affinity:       Default::default(),
			response_hooks: Default::default(),
			attribution:    CallInferenceAttribution::core(),
			execution:      Some(Arc::new(plan)),
			operation:      OperationCall::Auth(Arc::new(AuthRequest::ListAccounts {
				provider: None,
			})),
			staging:        None,
		};
		let answer = dispatch_preplanned(registry, LayerCall {
			payload: call,
			context: ExecutionContext::new(budget),
		})
		.await
		.unwrap();
		assert!(
			matches!(answer.body, AnswerBody::Auth(AuthAnswer::Accounts(accounts)) if accounts.is_empty())
		);
		assert_eq!(wire_calls.load(Ordering::Relaxed), 0);
		let _ = fs::remove_file(store_path);
	}
}
