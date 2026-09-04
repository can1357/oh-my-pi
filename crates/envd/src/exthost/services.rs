//! Manifest-gated inter-extension services over CONTROL.

use std::{
	collections::{BTreeMap, BTreeSet},
	sync::{
		Arc,
		atomic::{AtomicU64, Ordering},
	},
};

use async_trait::async_trait;
use flume::Receiver;
use omp_ai::recovery::tools::{ToolAssemblyLimits, validate_schema};
use omp_core::{CowBytes, Duration, DurationUnit, LifecyclePhase, SparseMap, Str, sf};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use thiserror::Error;

use super::control::{
	ControlAuthority, ControlAuthorityFactory, ControlCompositionError, ControlConnectionIdentity,
	ControlEffect, ControlProtocolError, ControlRequestContext,
};
use crate::worker::HostKey;

/// Exact service name and revision.
#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct ServiceKey {
	/// Globally qualified service name.
	pub name: Str,
	/// Explicit compatibility revision.
	pub rev:  u32,
}

impl ServiceKey {
	/// Creates a service identity.
	pub fn new(name: impl Into<Str>, rev: u32) -> Self {
		Self { name: name.into(), rev }
	}
}

/// Frozen structural codec for one public async service method.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ServiceMethodSchema {
	/// Public method name.
	pub name:          Str,
	/// JSON Schema for the positional/keyword request object.
	pub input_schema:  Value,
	/// JSON Schema for the successful result.
	pub result_schema: Value,
}

/// One exact frozen provider declaration installed after FREEZE verification.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ServiceProviderDeclaration {
	/// Exact service identity.
	pub service: ServiceKey,
	/// Sealed method codecs in declaration order.
	pub methods: Arc<[ServiceMethodSchema]>,
}

/// Provider declarations and consumer grants published from one manifest.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ServiceManifest {
	provides: BTreeSet<ServiceKey>,
	requires: BTreeSet<ServiceKey>,
}

impl ServiceManifest {
	/// Normalizes provider declarations and consumer requirements.
	pub fn new(
		provides: impl IntoIterator<Item = ServiceKey>,
		requires: impl IntoIterator<Item = ServiceKey>,
	) -> Self {
		Self { provides: provides.into_iter().collect(), requires: requires.into_iter().collect() }
	}

	/// Iterates over services this extension declares as a provider.
	pub fn provides(&self) -> impl DoubleEndedIterator<Item = &ServiceKey> + ExactSizeIterator {
		self.provides.iter()
	}

	/// Iterates over services this extension is granted permission to consume.
	pub fn requires(&self) -> impl DoubleEndedIterator<Item = &ServiceKey> + ExactSizeIterator {
		self.requires.iter()
	}
}

/// Exact difference between manifest services and frozen decorators.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ServiceDeclarationDrift {
	/// Manifest providers absent from the frozen registry.
	pub missing:    Box<[ServiceKey]>,
	/// Frozen providers absent from the manifest.
	pub unexpected: Box<[ServiceKey]>,
}

impl ServiceDeclarationDrift {
	fn between(expected: &BTreeSet<ServiceKey>, actual: &BTreeSet<ServiceKey>) -> Self {
		Self {
			missing:    expected.difference(actual).cloned().collect(),
			unexpected: actual.difference(expected).cloned().collect(),
		}
	}

	/// Returns whether the provider sets are equal.
	pub fn is_empty(&self) -> bool {
		self.missing.is_empty() && self.unexpected.is_empty()
	}
}

/// The only sanctioned transport for inter-extension RPC.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ServiceTransport {
	/// A brokered request on the dedicated CONTROL descriptor.
	Control,
}

/// A resolved, manifest-authorized service connection.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ServiceRoute {
	/// Consumer whose manifest contains the requirement.
	pub caller:              HostKey,
	/// Active extension providing this exact revision.
	pub provider:            HostKey,
	/// Provider generation fenced when the route was resolved.
	pub provider_generation: u64,
	/// Resolved service identity.
	pub service:             ServiceKey,
	/// Transport fixed by the service contract.
	pub transport:           ServiceTransport,
}

/// Result of resolving a manifest-authorized service dependency.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ServiceConnection {
	/// The provider is active and calls may be correlated immediately.
	Active(ServiceRoute),
	/// The admitted provider must complete its lazy lifecycle before retrying.
	ActivationRequired {
		/// Consumer whose manifest contains the requirement.
		caller:   HostKey,
		/// Admitted provider to activate.
		provider: HostKey,
		/// Exact service revision which triggered activation.
		service:  ServiceKey,
	},
}

/// Correlation and generation fields carried by one service Request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ServiceRequestMeta {
	/// Caller's current child generation.
	pub host_generation:    u64,
	/// Session epoch shared by the caller and provider.
	pub session_generation: u64,
	/// Caller deadline propagated to the provider.
	pub deadline:           Duration,
}

/// Broker-assigned request correlation identifier.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct ServiceCallId(
	/// Monotonic nonzero correlation value scoped to this broker.
	pub u64,
);

/// CONTROL request delivered to a provider child.
pub struct ServiceDispatch {
	/// Broker correlation identifier.
	pub id:      ServiceCallId,
	/// Authorized route.
	pub route:   ServiceRoute,
	/// Caller-scoped request metadata.
	pub meta:    ServiceRequestMeta,
	/// Public async method name.
	pub method:  Str,
	/// Encoded method arguments.
	pub payload: CowBytes<'static>,
}

/// Provider response routed to the correlated caller.
pub enum ServiceResponse {
	/// Successful encoded return value.
	Success(CowBytes<'static>),
	/// Provider-reported method failure.
	Failure(Str),
	/// Provider became unavailable before producing a result.
	Unavailable(Str),
}

/// Cancellation propagated when the caller drops its pending Request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ServiceCancellation {
	/// Correlated call to cancel.
	pub id:                  ServiceCallId,
	/// Provider child which owns the executing method.
	pub provider:            HostKey,
	/// Provider generation which owns the executing method.
	pub provider_generation: u64,
}

/// Manifest, routing, or correlation failure.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum ServiceError {
	/// Frozen method codecs are empty or structurally malformed.
	#[error("frozen service declaration has invalid method codecs")]
	InvalidDeclaration,
	/// A host published more than one manifest.
	#[error("service manifest for {0:?} is already published")]
	DuplicateManifest(HostKey),
	/// Provider activation named a host whose manifest was never published.
	#[error("service manifest for {0:?} is not published")]
	UnknownManifest(HostKey),
	/// Two admitted extensions provide the same exact service revision.
	#[error("service {service:?} is provided by both {first:?} and {second:?}")]
	DuplicateProvider {
		/// Conflicting service identity.
		service: ServiceKey,
		/// Existing provider.
		first:   HostKey,
		/// New provider.
		second:  HostKey,
	},
	/// Frozen `@omp.service` decorators drifted from the manifest.
	#[error("frozen service declarations differ from the manifest")]
	DeclarationDrift(ServiceDeclarationDrift),
	/// The consumer has no manifest grant for the requested service.
	#[error("extension {caller:?} has no declared grant for service {service:?}")]
	Capability {
		/// Consumer attempting to connect.
		caller:  HostKey,
		/// Undeclared service dependency.
		service: ServiceKey,
	},
	/// No admitted extension provides the exact revision.
	#[error("no admitted provider for service {0:?}")]
	Unavailable(ServiceKey),
	/// A provider route was resolved before that provider's current generation.
	#[error("service route for {0:?} belongs to a stale provider generation")]
	StaleRoute(ServiceKey),
	/// A caller frame belonged to an old child or session generation.
	#[error(
		"stale service generation for {host:?}: expected host {expected_host} session \
		 {expected_session}, got host {actual_host} session {actual_session}"
	)]
	StaleGeneration {
		/// Caller host identity.
		host:             HostKey,
		/// Current caller host generation.
		expected_host:    u64,
		/// Request caller host generation.
		actual_host:      u64,
		/// Broker session generation.
		expected_session: u64,
		/// Request session generation.
		actual_session:   u64,
	},
	/// A response did not match a pending correlation or its provider
	/// generation.
	#[error("stale or unknown service response correlation {0}")]
	StaleCorrelation(u64),
}

const _: () = assert!(std::mem::size_of::<ServiceError>() <= 128, "ServiceError must stay compact");

/// Failure observed while awaiting a service method.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum ServiceCallError {
	/// The provider returned an application error.
	#[error("service method failed: {0}")]
	Provider(Str),
	/// The provider disconnected or was replaced before responding.
	#[error("service provider became unavailable: {0}")]
	Unavailable(Str),
}

struct PendingRecord {
	provider:        HostKey,
	host_generation: u64,
	response:        flume::Sender<ServiceResponse>,
}

/// Awaitable half of one correlated service Request.
///
/// Dropping this value before a response removes the correlation immediately
/// and emits a CONTROL cancellation. No journal entry or agent message is used
/// as a request, response, wake-up, or fallback transport.
pub struct PendingServiceCall {
	id:                  ServiceCallId,
	provider:            HostKey,
	provider_generation: u64,
	pending:             Arc<Mutex<SparseMap<u64, PendingRecord>>>,
	cancellations:       flume::Sender<ServiceCancellation>,
	response:            Receiver<ServiceResponse>,
	armed:               bool,
}

impl PendingServiceCall {
	/// Waits for the provider response while preserving caller cancellation.
	pub async fn response(mut self) -> Result<CowBytes<'static>, ServiceCallError> {
		let response = self.response.recv_async().await;
		self.armed = false;
		match response {
			Ok(ServiceResponse::Success(payload)) => Ok(payload),
			Ok(ServiceResponse::Failure(message)) => Err(ServiceCallError::Provider(message)),
			Ok(ServiceResponse::Unavailable(message)) => Err(ServiceCallError::Unavailable(message)),
			Err(_) => Err(ServiceCallError::Unavailable(sf!("provider response channel closed"))),
		}
	}
}

impl Drop for PendingServiceCall {
	fn drop(&mut self) {
		if !self.armed {
			return;
		}
		if self.pending.lock().remove(self.id.0).is_some() {
			let _ = self.cancellations.send(ServiceCancellation {
				id:                  self.id,
				provider:            self.provider.clone(),
				provider_generation: self.provider_generation,
			});
		}
	}
}

#[derive(Clone)]
struct ActiveProvider {
	host:       HostKey,
	generation: u64,
}

/// Core-side manifest registry and CONTROL service request broker.
pub struct ServiceBroker {
	session_generation: u64,
	manifests:          BTreeMap<HostKey, ServiceManifest>,
	admitted:           BTreeMap<ServiceKey, HostKey>,
	providers:          BTreeMap<ServiceKey, ActiveProvider>,
	provider_methods:   BTreeMap<ServiceKey, Arc<[ServiceMethodSchema]>>,
	active_generations: BTreeMap<HostKey, u64>,
	next_id:            AtomicU64,
	pending:            Arc<Mutex<SparseMap<u64, PendingRecord>>>,
	cancellations_tx:   flume::Sender<ServiceCancellation>,
	cancellations_rx:   Receiver<ServiceCancellation>,
}

impl ServiceBroker {
	/// Creates an empty broker fenced to one session epoch. This is inert until
	/// manifests are published and providers activate.
	pub fn new(session_generation: u64) -> Self {
		let (cancellations_tx, cancellations_rx) = flume::unbounded();
		Self {
			session_generation,
			manifests: BTreeMap::new(),
			admitted: BTreeMap::new(),
			providers: BTreeMap::new(),
			provider_methods: BTreeMap::new(),
			active_generations: BTreeMap::new(),
			next_id: AtomicU64::new(1),
			pending: Arc::new(Mutex::new(SparseMap::new())),
			cancellations_tx,
			cancellations_rx,
		}
	}

	fn allocate_call_id(&self) -> ServiceCallId {
		let id = self
			.next_id
			.try_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
				Some(if current == u64::MAX { 1 } else { current + 1 })
			})
			.expect("service call id update closure is infallible");
		ServiceCallId(id)
	}

	/// Publishes static service declarations and grants without starting a
	/// child.
	pub fn publish_manifest(
		&mut self,
		host: HostKey,
		manifest: ServiceManifest,
	) -> Result<(), ServiceError> {
		if self.manifests.contains_key(&host) {
			tracing::warn!(
				extension_id = %host.extension(),
				"extension service roster publication rejected",
			);
			return Err(ServiceError::DuplicateManifest(host));
		}
		for service in manifest.provides() {
			if let Some(first) = self.admitted.get(service) {
				tracing::warn!(
					extension_id = %host.extension(),
					service = %service.name,
					service_revision = service.rev,
					first_extension_id = %first.extension(),
					"extension service roster publication rejected",
				);
				return Err(ServiceError::DuplicateProvider {
					service: service.clone(),
					first:   first.clone(),
					second:  host,
				});
			}
		}
		for service in manifest.provides() {
			self.admitted.insert(service.clone(), host.clone());
		}
		let provider_count = manifest.provides().len();
		let requirement_count = manifest.requires().len();
		let extension_id = host.extension().clone();
		self.manifests.insert(host, manifest);
		tracing::info!(
			%extension_id,
			provider_count,
			requirement_count,
			"extension service roster admitted",
		);
		Ok(())
	}

	/// Verifies a frozen provider registry and makes its exact revisions
	/// routable.
	pub fn activate_provider(
		&mut self,
		host: &HostKey,
		host_generation: u64,
		declared: impl IntoIterator<Item = ServiceKey>,
	) -> Result<(), ServiceError> {
		let actual = declared.into_iter().collect::<BTreeSet<_>>();
		let expected = self
			.manifests
			.get(host)
			.ok_or_else(|| ServiceError::UnknownManifest(host.clone()))?
			.provides
			.clone();
		if self
			.active_generations
			.get(host)
			.is_some_and(|generation| *generation != host_generation)
		{
			self.deactivate_provider(host, "provider generation replaced");
		}
		let drift = ServiceDeclarationDrift::between(&expected, &actual);
		if !drift.is_empty() {
			return Err(ServiceError::DeclarationDrift(drift));
		}
		for service in &actual {
			if let Some(first) = self.providers.get(service)
				&& first.host != *host
			{
				return Err(ServiceError::DuplicateProvider {
					service: service.clone(),
					first:   first.host.clone(),
					second:  host.clone(),
				});
			}
		}
		for service in actual {
			self.providers.insert(service, ActiveProvider {
				host:       host.clone(),
				generation: host_generation,
			});
		}
		self
			.active_generations
			.insert(host.clone(), host_generation);
		Ok(())
	}

	/// Verifies a complete frozen provider table and retains its exact method
	/// codecs for CONTROL clients.
	pub fn activate_provider_declarations(
		&mut self,
		host: &HostKey,
		host_generation: u64,
		declared: impl IntoIterator<Item = ServiceProviderDeclaration>,
	) -> Result<(), ServiceError> {
		let declared = declared.into_iter().collect::<Vec<_>>();
		if declared.iter().any(|declaration| {
			let mut names = BTreeSet::new();
			declaration.methods.is_empty()
				|| declaration.methods.iter().any(|method| {
					method.name.is_empty()
						|| !method.input_schema.is_object()
						|| !method.result_schema.is_object()
						|| !names.insert(method.name.clone())
				})
		}) {
			return Err(ServiceError::InvalidDeclaration);
		}
		let actual = declared
			.iter()
			.map(|declaration| declaration.service.clone())
			.collect::<BTreeSet<_>>();
		self.activate_provider(host, host_generation, actual)?;
		for declaration in declared {
			self
				.provider_methods
				.insert(declaration.service, declaration.methods);
		}
		self
			.active_generations
			.insert(host.clone(), host_generation);
		Ok(())
	}

	/// Returns sealed method codecs for one generation-fenced active route.
	pub fn methods(&self, route: &ServiceRoute) -> Result<Arc<[ServiceMethodSchema]>, ServiceError> {
		let current = self.providers.get(&route.service);
		if !current.is_some_and(|provider| {
			provider.host == route.provider && provider.generation == route.provider_generation
		}) {
			return Err(ServiceError::StaleRoute(route.service.clone()));
		}
		self
			.provider_methods
			.get(&route.service)
			.filter(|methods| !methods.is_empty())
			.cloned()
			.ok_or_else(|| ServiceError::Unavailable(route.service.clone()))
	}

	/// Resolves a connection only when the consumer manifest grants it.
	///
	/// An admitted but inactive provider is returned as
	/// [`ServiceConnection::ActivationRequired`], allowing the supervisor to
	/// run its lazy lifecycle and retry without ambient service discovery.
	pub fn connect(
		&self,
		caller: &HostKey,
		service: ServiceKey,
	) -> Result<ServiceConnection, ServiceError> {
		let granted = self
			.manifests
			.get(caller)
			.is_some_and(|manifest| manifest.requires.contains(&service));
		if !granted {
			return Err(ServiceError::Capability { caller: caller.clone(), service });
		}
		if let Some(provider) = self.providers.get(&service) {
			return Ok(ServiceConnection::Active(ServiceRoute {
				caller: caller.clone(),
				provider: provider.host.clone(),
				provider_generation: provider.generation,
				service,
				transport: ServiceTransport::Control,
			}));
		}
		let provider = self
			.admitted
			.get(&service)
			.cloned()
			.ok_or_else(|| ServiceError::Unavailable(service.clone()))?;
		Ok(ServiceConnection::ActivationRequired { caller: caller.clone(), provider, service })
	}

	/// Begins one method call and installs its response correlation before the
	/// dispatch can be written to CONTROL.
	///
	/// # Errors
	/// Returns [`ServiceError::StaleRoute`] when a restart replaced the provider
	/// after `connect` resolved it.
	pub fn begin_call(
		&self,
		route: ServiceRoute,
		meta: ServiceRequestMeta,
		method: impl Into<Str>,
		payload: CowBytes<'static>,
	) -> Result<(ServiceDispatch, PendingServiceCall), ServiceError> {
		if !self
			.manifests
			.get(&route.caller)
			.is_some_and(|manifest| manifest.requires.contains(&route.service))
		{
			return Err(ServiceError::Capability { caller: route.caller, service: route.service });
		}
		let active_host = self.active_generations.get(&route.caller).copied();
		let expected_host = active_host.unwrap_or(0);
		if active_host.is_none()
			|| meta.session_generation != self.session_generation
			|| meta.host_generation != expected_host
		{
			return Err(ServiceError::StaleGeneration {
				host: route.caller,
				expected_host,
				actual_host: meta.host_generation,
				expected_session: self.session_generation,
				actual_session: meta.session_generation,
			});
		}
		let current = self.providers.get(&route.service);
		if !current.is_some_and(|provider| {
			provider.host == route.provider && provider.generation == route.provider_generation
		}) {
			return Err(ServiceError::StaleRoute(route.service));
		}
		let id = self.allocate_call_id();
		let (response_tx, response_rx) = flume::bounded(1);
		self.pending.lock().insert(id.0, PendingRecord {
			provider:        route.provider.clone(),
			host_generation: route.provider_generation,
			response:        response_tx,
		});
		let pending = PendingServiceCall {
			id,
			provider: route.provider.clone(),
			provider_generation: route.provider_generation,
			pending: Arc::clone(&self.pending),
			cancellations: self.cancellations_tx.clone(),
			response: response_rx,
			armed: true,
		};
		let dispatch = ServiceDispatch { id, route, meta, method: method.into(), payload };
		Ok((dispatch, pending))
	}

	/// Completes one correlated call after validating provider and generation.
	pub fn complete(
		&self,
		provider: &HostKey,
		host_generation: u64,
		id: ServiceCallId,
		response: ServiceResponse,
	) -> Result<(), ServiceError> {
		let mut pending = self.pending.lock();
		let Some(record) = pending.get(id.0) else {
			return Err(ServiceError::StaleCorrelation(id.0));
		};
		if &record.provider != provider || record.host_generation != host_generation {
			return Err(ServiceError::StaleCorrelation(id.0));
		}
		let record = pending
			.remove(id.0)
			.expect("validated pending correlation exists");
		drop(pending);
		let _ = record.response.send(response);
		Ok(())
	}

	/// Removes one provider's routes and fails only its in-flight method calls.
	pub fn deactivate_provider(&mut self, provider: &HostKey, reason: impl Into<Str>) {
		self.active_generations.remove(provider);
		let removed = self
			.providers
			.iter()
			.filter(|(_, active)| &active.host == provider)
			.map(|(service, _)| service.clone())
			.collect::<Vec<_>>();
		self.providers.retain(|_, active| &active.host != provider);
		for service in removed {
			self.provider_methods.remove(&service);
		}
		let reason = reason.into();
		self.pending.lock().retain(|_, record| {
			if &record.provider == provider {
				let _ = record
					.response
					.send(ServiceResponse::Unavailable(reason.clone()));
				false
			} else {
				true
			}
		});
	}

	/// Receives the next caller cancellation for forwarding on CONTROL.
	pub async fn cancellation(&self) -> Option<ServiceCancellation> {
		self.cancellations_rx.recv_async().await.ok()
	}

	/// Returns the number of in-flight correlated calls.
	pub fn pending_len(&self) -> usize {
		self.pending.lock().len()
	}
}
/// Live supervisor seam used by the service CONTROL authority.
///
/// Implementations activate the admitted provider in the existing supervisor
/// and dispatch through its generation-fenced CONTROL mailbox.
#[async_trait]
pub trait ServiceDispatchBackend: Send + Sync + 'static {
	/// Lazily activates an admitted provider, updating the shared broker with
	/// the provider's sealed declarations before returning.
	async fn activate(&self, provider: &HostKey, service: &ServiceKey) -> Result<(), Str>;

	/// Delivers one already-authorized correlated call to the provider actor.
	async fn dispatch(&self, dispatch: ServiceDispatch) -> Result<ServiceResponse, Str>;
}

/// Connection-scoped owner of `omp.services.*`.
pub struct ServiceControlAuthority {
	identity: Arc<ControlConnectionIdentity>,
	broker:   Arc<Mutex<ServiceBroker>>,
	backend:  Arc<dyn ServiceDispatchBackend>,
	caller:   HostKey,
}

/// Factory binding service requests to the authenticated extension identity.
pub struct ServiceControlAuthorityFactory {
	broker:  Arc<Mutex<ServiceBroker>>,
	backend: Arc<dyn ServiceDispatchBackend>,
}

impl ServiceControlAuthorityFactory {
	/// Creates a factory over the supervisor's sole live broker and dispatch
	/// seam.
	pub fn new(broker: Arc<Mutex<ServiceBroker>>, backend: Arc<dyn ServiceDispatchBackend>) -> Self {
		Self { broker, backend }
	}
}

impl ControlAuthorityFactory for ServiceControlAuthorityFactory {
	fn bind(
		&self,
		identity: Arc<ControlConnectionIdentity>,
	) -> Result<Arc<dyn ControlAuthority>, ControlCompositionError> {
		let caller =
			HostKey::new(identity.layer.clone(), identity.tier.clone(), identity.extension.clone());
		Ok(Arc::new(ServiceControlAuthority {
			identity,
			broker: Arc::clone(&self.broker),
			backend: Arc::clone(&self.backend),
			caller,
		}))
	}
}

impl ServiceControlAuthority {
	fn validate(&self, context: &ControlRequestContext) -> Result<(), ControlProtocolError> {
		if Arc::ptr_eq(&context.connection, &self.identity) {
			Ok(())
		} else {
			Err(ControlProtocolError::new(
				"StaleGeneration",
				"service CONTROL authority belongs to a replaced connection",
			))
		}
	}

	fn key(arguments: &Map<String, Value>) -> Result<ServiceKey, ControlProtocolError> {
		let name = arguments
			.get("name")
			.and_then(Value::as_str)
			.filter(|name| !name.is_empty())
			.ok_or_else(|| {
				ControlProtocolError::new("InvalidService", "service name must be non-empty")
			})?;
		let rev = arguments
			.get("rev")
			.and_then(Value::as_u64)
			.and_then(|rev| u32::try_from(rev).ok())
			.filter(|rev| *rev != 0)
			.ok_or_else(|| {
				ControlProtocolError::new("InvalidService", "service revision must be positive")
			})?;
		Ok(ServiceKey::new(name, rev))
	}

	fn service_error(error: ServiceError) -> ControlProtocolError {
		match error {
			ServiceError::Capability { caller, service } => ControlProtocolError::new(
				"CapabilityError",
				"the extension manifest does not grant this service",
			)
			.with_details(json!({
				"extension": caller.extension().as_str(),
				"capability": format!("service:{}@{}", service.name, service.rev),
			})),
			ServiceError::Unavailable(service) => ControlProtocolError::new(
				"ResourceUnavailable",
				"the admitted service provider is not active",
			)
			.retryable(true)
			.with_details(json!({"name": service.name.as_str(), "rev": service.rev})),
			ServiceError::StaleRoute(service) => {
				ControlProtocolError::new("StaleGeneration", "the service provider was replaced")
					.retryable(true)
					.with_details(json!({"name": service.name.as_str(), "rev": service.rev}))
			},
			ServiceError::StaleGeneration {
				expected_host,
				actual_host,
				expected_session,
				actual_session,
				..
			} => ControlProtocolError::new(
				"StaleGeneration",
				"the service call belongs to a stale caller generation",
			)
			.with_details(json!({
				"expected_host": expected_host,
				"actual_host": actual_host,
				"expected_session": expected_session,
				"actual_session": actual_session,
			})),
			other => ControlProtocolError::new("ServiceProtocolError", other.to_string()),
		}
	}

	fn validate_method_input(
		schema: &ServiceMethodSchema,
		args: &[Value],
		kwargs: &Map<String, Value>,
	) -> Result<(), ControlProtocolError> {
		let Some(properties) = schema
			.input_schema
			.get("properties")
			.and_then(Value::as_object)
		else {
			return validate_schema(
				&schema.input_schema,
				&Value::Object(kwargs.clone()),
				false,
				ToolAssemblyLimits::default(),
			)
			.map_err(|issue| {
				ControlProtocolError::new(
					"InvalidServiceArguments",
					"service arguments violate the sealed method schema",
				)
				.with_details(json!({"path": issue.path.as_str(), "rule": issue.rule}))
			});
		};
		if args.len() > properties.len() {
			return Err(ControlProtocolError::new(
				"InvalidServiceArguments",
				"service call supplies more positional arguments than the sealed method",
			));
		}
		let mut input = Map::new();
		for ((name, _), value) in properties.iter().zip(args) {
			input.insert(name.clone(), value.clone());
		}
		for (name, value) in kwargs {
			if input.insert(name.clone(), value.clone()).is_some() {
				return Err(ControlProtocolError::new(
					"InvalidServiceArguments",
					"service argument was supplied both positionally and by name",
				));
			}
		}
		validate_schema(
			&schema.input_schema,
			&Value::Object(input),
			true,
			ToolAssemblyLimits::default(),
		)
		.map_err(|issue| {
			ControlProtocolError::new(
				"InvalidServiceArguments",
				"service arguments violate the sealed method schema",
			)
			.with_details(json!({"path": issue.path.as_str(), "rule": issue.rule}))
		})
	}

	fn validate_method_result(
		schema: &ServiceMethodSchema,
		result: Value,
	) -> Result<Value, ControlProtocolError> {
		validate_schema(&schema.result_schema, &result, true, ToolAssemblyLimits::default())
			.map_err(|issue| {
				ControlProtocolError::new(
					"ServiceResultSchemaError",
					"provider result violates the sealed method schema",
				)
				.with_details(json!({"path": issue.path.as_str(), "rule": issue.rule}))
			})?;
		Ok(result)
	}

	async fn route(&self, service: ServiceKey) -> Result<ServiceRoute, ControlProtocolError> {
		let connection = self
			.broker
			.lock()
			.connect(&self.caller, service.clone())
			.map_err(Self::service_error)?;
		match connection {
			ServiceConnection::Active(route) => Ok(route),
			ServiceConnection::ActivationRequired { provider, service, .. } => {
				self
					.backend
					.activate(&provider, &service)
					.await
					.map_err(|message| {
						ControlProtocolError::new("ResourceUnavailable", message)
							.retryable(true)
							.with_details(json!({
								"name": service.name.as_str(),
								"rev": service.rev,
								"provider": provider.extension().as_str(),
							}))
					})?;
				match self
					.broker
					.lock()
					.connect(&self.caller, service)
					.map_err(Self::service_error)?
				{
					ServiceConnection::Active(route) => Ok(route),
					ServiceConnection::ActivationRequired { .. } => Err(
						ControlProtocolError::new(
							"ResourceUnavailable",
							"service provider activation did not publish a live generation",
						)
						.retryable(true),
					),
				}
			},
		}
	}
}

#[async_trait]
impl ControlAuthority for ServiceControlAuthority {
	fn handles(&self, operation: &str) -> bool {
		matches!(operation, "omp.services.connect" | "omp.services.call")
	}

	fn authorize(
		&self,
		context: &ControlRequestContext,
		_operation: &str,
		_arguments: &Map<String, Value>,
	) -> Result<(), ControlProtocolError> {
		self.validate(context)?;
		if context
			.invocation
			.as_ref()
			.is_some_and(|invocation| invocation.lifecycle != LifecyclePhase::Active)
		{
			return Err(ControlProtocolError::new(
				"PhaseError",
				"service requests require an active extension lifecycle",
			));
		}
		Ok(())
	}

	async fn request(
		&self,
		context: ControlRequestContext,
		operation: Str,
		arguments: Map<String, Value>,
	) -> Result<Value, ControlProtocolError> {
		self.validate(&context)?;
		let service = Self::key(&arguments)?;
		let route = self.route(service).await?;
		if operation.as_str() == "omp.services.connect" {
			let methods = self
				.broker
				.lock()
				.methods(&route)
				.map_err(Self::service_error)?;
			return Ok(json!({"methods": methods.as_ref()}));
		}
		let method = arguments
			.get("method")
			.and_then(Value::as_str)
			.filter(|method| !method.is_empty())
			.ok_or_else(|| {
				ControlProtocolError::new("InvalidServiceMethod", "service method is required")
			})?;
		let methods = self
			.broker
			.lock()
			.methods(&route)
			.map_err(Self::service_error)?;
		let schema = methods
			.iter()
			.find(|schema| schema.name.as_str() == method)
			.cloned()
			.ok_or_else(|| {
				ControlProtocolError::new(
					"InvalidServiceMethod",
					"the method is absent from the sealed service declaration",
				)
			})?;
		let args = arguments.get("args").cloned().unwrap_or_else(|| json!([]));
		let kwargs = arguments
			.get("kwargs")
			.cloned()
			.unwrap_or_else(|| json!({}));
		let (Some(args_values), Some(kwargs_values)) = (args.as_array(), kwargs.as_object()) else {
			return Err(ControlProtocolError::new(
				"InvalidServiceArguments",
				"service args and kwargs must be an array and object",
			));
		};
		Self::validate_method_input(&schema, args_values, kwargs_values)?;
		let payload =
			serde_json::to_vec(&json!({"args": args, "kwargs": kwargs})).map_err(|error| {
				ControlProtocolError::new(
					"InvalidServiceArguments",
					sf!("service arguments are not encodable: {error}"),
				)
			})?;
		let meta = ServiceRequestMeta {
			host_generation:    self.identity.host_generation,
			session_generation: self.identity.session_generation,
			deadline:           Duration::new(300, DurationUnit::Seconds),
		};
		let (dispatch, pending) = self
			.broker
			.lock()
			.begin_call(route, meta, method, CowBytes::from(payload))
			.map_err(Self::service_error)?;
		let provider = dispatch.route.provider.clone();
		let provider_generation = dispatch.route.provider_generation;
		let id = dispatch.id;
		let response = self.backend.dispatch(dispatch).await.map_err(|message| {
			ControlProtocolError::new("ServiceDispatchFailed", message).retryable(true)
		})?;
		self
			.broker
			.lock()
			.complete(&provider, provider_generation, id, response)
			.map_err(Self::service_error)?;
		let encoded = pending.response().await.map_err(|error| match error {
			ServiceCallError::Provider(message) => {
				ControlProtocolError::new("ServiceCallFailed", message)
			},
			ServiceCallError::Unavailable(message) => {
				ControlProtocolError::new("ResourceUnavailable", message).retryable(true)
			},
		})?;
		let result = serde_json::from_slice(encoded.as_ref()).map_err(|error| {
			ControlProtocolError::new(
				"ServiceResultCodecError",
				sf!("provider returned malformed JSON: {error}"),
			)
		})?;
		Self::validate_method_result(&schema, result)
	}

	async fn effect(
		&self,
		context: ControlRequestContext,
		_effect: ControlEffect,
	) -> Result<(), ControlProtocolError> {
		self.validate(&context)?;
		Err(ControlProtocolError::new(
			"UnsupportedEffect",
			"services do not accept fire-and-forget effects",
		))
	}
}
