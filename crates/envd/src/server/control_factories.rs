//! Production CONTROL authority factories for one environment.

use super::{
	devices::{ProductionDeviceCatalogObserver, ProductionDeviceInvocationAdmission},
	error::EnvdError,
	prelude::*,
};

pub(in crate::server) type ProductionResolverTable = ResolverTable<UrlResolver>;

pub(in crate::server) struct ProductionControlBindings {
	pub(in crate::server) factory:       Arc<HostControlAuthorityFactory>,
	pub(in crate::server) resources:     Arc<sync::OnceLock<Arc<ProductionResolverTable>>>,
	pub(in crate::server) callbacks:     Arc<CallbackDispatcherSlot>,
	pub(in crate::server) registry:      Arc<RegistryControlFactory>,
	pub(in crate::server) hooks:         Arc<HookControlFactory>,
	/// Live forge device client bound to the device catalog (cap-forge).
	#[cfg(feature = "cap-forge")]
	pub(in crate::server) forge_devices: crate::forge_adapter::LiveForgeDeviceClient,
	/// Live CI device client bound to the device catalog (cap-ci).
	#[cfg(feature = "cap-ci")]
	pub(in crate::server) ci_devices:    crate::forge_adapter::LiveCiDeviceClient,
}

pub(in crate::server) struct WeakExtensionCallbackDispatcher {
	pub(in crate::server) supervisor: Weak<ExtHostSupervisor>,
}

#[async_trait::async_trait]
impl CallbackDispatcher for WeakExtensionCallbackDispatcher {
	async fn dispatch(
		&self,
		target: Arc<ControlConnectionIdentity>,
		dispatch: ControlDispatch,
	) -> Result<serde_json::Value, ControlProtocolError> {
		let supervisor = self.supervisor.upgrade().ok_or_else(|| {
			ControlProtocolError::new(
				"CallbackUnavailable",
				"extension callback supervisor is no longer active",
			)
		})?;
		CallbackDispatcher::dispatch(supervisor.as_ref(), target, dispatch).await
	}

	async fn dispatch_ui(
		&self,
		target: Arc<ControlConnectionIdentity>,
		authority: crate::exthost::control::ControlInvocationAuthority,
		dispatch: UiCallbackDispatch,
		timeout: Duration,
	) -> Result<UiDispatchResult, ControlProtocolError> {
		let supervisor = self.supervisor.upgrade().ok_or_else(|| {
			ControlProtocolError::new(
				"CallbackUnavailable",
				"extension callback supervisor is no longer active",
			)
		})?;
		CallbackDispatcher::dispatch_ui(supervisor.as_ref(), target, authority, dispatch, timeout)
			.await
	}
}

#[derive(Clone, Copy)]
enum DeclaredExternalDomain {
	Policy,
	Parameters,
	Workers,
	DirectFilesystem,
	Credentials,
	Prompts,
	Sessions,
	Ui,
	Telemetry,
	Jobs,
	Provider,
	Services,
}

impl DeclaredExternalDomain {
	pub(in crate::server) fn declared(self, manifest: &ExtensionManifest) -> bool {
		let declarations = manifest.static_declarations();
		match self {
			Self::Policy => true,
			Self::Parameters => manifest.declarations.tools().next().is_some(),
			Self::Workers => !declarations.workers.is_empty() || !declarations.placement.is_empty(),
			Self::DirectFilesystem => manifest
				.declarations
				.permits(EscapeCapability::DirectFilesystem),
			Self::Credentials => true,
			Self::Prompts => true,
			Self::Sessions => !declarations.ui.commands.is_empty(),
			Self::Ui => {
				!declarations.ui.commands.is_empty()
					|| !declarations.ui.shortcuts.is_empty()
					|| !declarations.ui.message_renderers.is_empty()
					|| !declarations.ui.completions.is_empty()
			},
			Self::Telemetry => true,
			Self::Jobs => !declarations.ui.verdict_renderers.is_empty(),
			Self::Provider => true,
			Self::Services => {
				manifest.services.provides().next().is_some()
					|| manifest.services.requires().next().is_some()
			},
		}
	}

	pub(in crate::server) const fn name(self) -> &'static str {
		match self {
			Self::Policy => "policy",
			Self::Parameters => "parameters",
			Self::Workers => "workers",
			Self::DirectFilesystem => "direct-filesystem",
			Self::Credentials => "credentials",
			Self::Prompts => "prompts",
			Self::Sessions => "sessions",
			Self::Ui => "ui",
			Self::Telemetry => "telemetry",
			Self::Jobs => "jobs",
			Self::Provider => "provider",
			Self::Services => "services",
		}
	}

	fn factory(
		self,
		factories: &ExternalDomainControlFactories,
	) -> Option<Arc<dyn ControlAuthorityFactory>> {
		match self {
			Self::Policy => factories.policy.clone(),
			Self::Parameters => factories.parameters.clone(),
			Self::Workers => factories.workers.clone(),
			Self::DirectFilesystem => factories.direct_filesystem.clone(),
			Self::Credentials => factories.credentials.clone(),
			Self::Prompts => factories.prompts.clone(),
			Self::Sessions => factories.sessions.clone(),
			Self::Ui => factories.ui.clone(),
			Self::Telemetry => factories.telemetry.clone(),
			Self::Jobs => factories.jobs.clone(),
			Self::Provider => factories.provider.clone(),
			Self::Services => factories.services.clone(),
		}
	}
}

struct ManifestGatedControlFactory {
	domain:    DeclaredExternalDomain,
	manifests: Arc<BTreeMap<(Str, Str, Str), ExtensionManifest>>,
	slot:      Arc<DomainControlSlot>,
}

impl ControlAuthorityFactory for ManifestGatedControlFactory {
	fn bind(
		&self,
		identity: Arc<ControlConnectionIdentity>,
	) -> Result<Arc<dyn ControlAuthority>, ControlCompositionError> {
		let manifest = self
			.manifests
			.get(&(identity.layer.clone(), identity.tier.clone(), identity.extension.clone()))
			.ok_or_else(|| {
				ControlCompositionError::unavailable(
					self.domain.name(),
					"authenticated extension has no deployment manifest",
				)
			})?;
		if !self.domain.declared(manifest) {
			return Ok(Arc::new(UndeclaredControlAuthority));
		}
		Ok(Arc::new(LateBoundControlAuthority {
			domain: self.domain,
			identity,
			slot: Arc::clone(&self.slot),
			bound: Mutex::new(None),
		}))
	}
}

struct LateBoundControlAuthority {
	domain:   DeclaredExternalDomain,
	identity: Arc<ControlConnectionIdentity>,
	slot:     Arc<DomainControlSlot>,
	bound:    Mutex<Option<(u64, Arc<dyn ControlAuthority>)>>,
}

impl LateBoundControlAuthority {
	pub(in crate::server) fn owner(
		&self,
	) -> Result<(u64, Arc<dyn ControlAuthority>), ControlProtocolError> {
		let (id, factories) = self.slot.snapshot().ok_or_else(|| {
			ControlProtocolError::new(
				"AccessDenied",
				sf!("no active {} CONTROL lease authorizes this session", self.domain.name()),
			)
		})?;
		if let Some((bound_id, owner)) = self.bound.lock().as_ref() {
			if *bound_id == id {
				return Ok((id, Arc::clone(owner)));
			}
			return Err(ControlProtocolError::new(
				"StaleGeneration",
				"the driver/app CONTROL lease replaced this connection's authority",
			));
		}
		let factory = self.domain.factory(&factories).ok_or_else(|| {
			ControlProtocolError::new(
				"AccessDenied",
				sf!("the active CONTROL lease does not grant {}", self.domain.name()),
			)
		})?;
		let owner = factory
			.bind(Arc::clone(&self.identity))
			.map_err(|error| ControlProtocolError::new("AuthorityBindingFailed", fault(error)))?;
		if !self.slot.is_live(id) {
			return Err(ControlProtocolError::new(
				"StaleGeneration",
				"the driver/app CONTROL lease changed while binding",
			));
		}
		*self.bound.lock() = Some((id, Arc::clone(&owner)));
		Ok((id, owner))
	}
}

#[async_trait::async_trait]
impl ControlAuthority for LateBoundControlAuthority {
	fn handles(&self, operation: &str) -> bool {
		if let Some((_, owner)) = self.bound.lock().as_ref() {
			return owner.handles(operation);
		}
		self
			.owner()
			.is_ok_and(|(_, owner)| owner.handles(operation))
	}

	fn authorize(
		&self,
		context: &ControlRequestContext,
		operation: &str,
		arguments: &serde_json::Map<String, serde_json::Value>,
	) -> Result<(), ControlProtocolError> {
		let (_, owner) = self.owner()?;
		owner.authorize(context, operation, arguments)
	}

	async fn request(
		&self,
		context: ControlRequestContext,
		operation: Str,
		arguments: serde_json::Map<String, serde_json::Value>,
	) -> Result<serde_json::Value, ControlProtocolError> {
		let (id, owner) = self.owner()?;
		let result = owner.request(context, operation, arguments).await;
		if !self.slot.is_live(id) {
			return Err(ControlProtocolError::new(
				"StaleGeneration",
				"the driver/app CONTROL lease changed during the request",
			));
		}
		result
	}

	async fn effect(
		&self,
		context: ControlRequestContext,
		effect: ControlEffect,
	) -> Result<(), ControlProtocolError> {
		let (id, owner) = self.owner()?;
		let result = owner.effect(context, effect).await;
		if !self.slot.is_live(id) {
			return Err(ControlProtocolError::new(
				"StaleGeneration",
				"the driver/app CONTROL lease changed during the effect",
			));
		}
		result
	}
}

struct CompositeControlFactory {
	owners: Box<[Arc<dyn ControlAuthorityFactory>]>,
}

impl ControlAuthorityFactory for CompositeControlFactory {
	fn bind(
		&self,
		identity: Arc<ControlConnectionIdentity>,
	) -> Result<Arc<dyn ControlAuthority>, ControlCompositionError> {
		let mut owners = Vec::with_capacity(self.owners.len());
		for owner in &self.owners {
			owners.push(owner.bind(Arc::clone(&identity))?);
		}
		let effects = Arc::new(UndeclaredControlAuthority);
		Ok(Arc::new(CompositeControlAuthority::new(owners, effects)))
	}
}

struct UndeclaredControlAuthority;

#[async_trait::async_trait]
impl ControlAuthority for UndeclaredControlAuthority {
	fn handles(&self, _operation: &str) -> bool {
		false
	}

	fn authorize(
		&self,
		_context: &ControlRequestContext,
		_operation: &str,
		_arguments: &serde_json::Map<String, serde_json::Value>,
	) -> Result<(), ControlProtocolError> {
		Err(ControlProtocolError::new(
			"UndeclaredOperation",
			"the extension manifest does not declare this CONTROL domain",
		))
	}

	async fn request(
		&self,
		_context: ControlRequestContext,
		_operation: Str,
		_arguments: serde_json::Map<String, serde_json::Value>,
	) -> Result<serde_json::Value, ControlProtocolError> {
		Err(ControlProtocolError::new(
			"UndeclaredOperation",
			"the extension manifest does not declare this CONTROL domain",
		))
	}

	async fn effect(
		&self,
		_context: ControlRequestContext,
		_effect: ControlEffect,
	) -> Result<(), ControlProtocolError> {
		Err(ControlProtocolError::new(
			"UndeclaredOperation",
			"the extension manifest does not declare this CONTROL domain",
		))
	}
}

struct ProductionEnvdControlFactory {
	state_dir:         PathBuf,
	session_id:        Str,
	telemetry:         Arc<TelemetryIndex>,
	intents:           Arc<Mutex<BTreeMap<(Str, Str, Str, Str), serde_json::Value>>>,
	resources:         Arc<sync::OnceLock<Arc<ProductionResolverTable>>>,
	scheme_generation: Arc<crate::SchemeGeneration>,
}

impl ControlAuthorityFactory for ProductionEnvdControlFactory {
	fn bind(
		&self,
		identity: Arc<ControlConnectionIdentity>,
	) -> Result<Arc<dyn ControlAuthority>, ControlCompositionError> {
		Ok(Arc::new(ProductionEnvdControlAuthority {
			identity,
			state_dir: self.state_dir.clone(),
			session_id: self.session_id.clone(),
			telemetry: Arc::clone(&self.telemetry),
			intents: Arc::clone(&self.intents),
			resources: Arc::clone(&self.resources),
			scheme_generation: Arc::clone(&self.scheme_generation),
		}))
	}
}

struct ProductionEnvdControlAuthority {
	identity:          Arc<ControlConnectionIdentity>,
	state_dir:         PathBuf,
	session_id:        Str,
	telemetry:         Arc<TelemetryIndex>,
	intents:           Arc<Mutex<BTreeMap<(Str, Str, Str, Str), serde_json::Value>>>,
	resources:         Arc<sync::OnceLock<Arc<ProductionResolverTable>>>,
	scheme_generation: Arc<crate::SchemeGeneration>,
}

impl ProductionEnvdControlAuthority {
	pub(in crate::server) fn validate(
		&self,
		context: &ControlRequestContext,
	) -> Result<(), ControlProtocolError> {
		if same_control_connection(&self.identity, &context.connection) {
			Ok(())
		} else {
			Err(ControlProtocolError::new(
				"StaleGeneration",
				"CONTROL authority belongs to a replaced extension-host connection",
			))
		}
	}
}

#[async_trait::async_trait]
impl ControlAuthority for ProductionEnvdControlAuthority {
	fn handles(&self, operation: &str) -> bool {
		matches!(operation, "omp.state_dir" | "omp.urls.read" | "omp.schemes.live")
	}

	fn authorize(
		&self,
		context: &ControlRequestContext,
		_operation: &str,
		_arguments: &serde_json::Map<String, serde_json::Value>,
	) -> Result<(), ControlProtocolError> {
		self.validate(context)
	}

	async fn request(
		&self,
		context: ControlRequestContext,
		operation: Str,
		_arguments: serde_json::Map<String, serde_json::Value>,
	) -> Result<serde_json::Value, ControlProtocolError> {
		self.validate(&context)?;
		match operation.as_str() {
			"omp.state_dir" => {
				Ok(serde_json::Value::String(self.state_dir.to_string_lossy().into_owned()))
			},
			"omp.schemes.live" => Ok(self.scheme_generation.listing_payload()),
			"omp.urls.read" => {
				let url = _arguments
					.get("url")
					.and_then(serde_json::Value::as_str)
					.filter(|url| !url.is_empty())
					.ok_or_else(|| {
						ControlProtocolError::new("InvalidUrl", "omp.urls.read requires a non-empty url")
					})?;
				let parsed = selector::parse_uri(url)
					.map_err(|error| ControlProtocolError::new("InvalidUrl", fault(error)))?
					.ok_or_else(|| {
						ControlProtocolError::new(
							"InvalidUrl",
							"omp.urls.read requires an absolute typed URL",
						)
					})?;
				let resources = self.resources.get().ok_or_else(|| {
					ControlProtocolError::new(
						"ControlOwnerUnavailable",
						"the Environment URL resolver table is not active",
					)
					.retryable(true)
				})?;
				let read = if parsed.scheme == resolver::Scheme::Unknown {
					resources.read_unknown(url, &parsed.selector).await
				} else {
					resources
						.read_query(parsed.scheme, parsed.resource, parsed.query, &parsed.selector)
						.await
				}
				.ok_or_else(|| {
					ControlProtocolError::new(
						"SchemeNotReadable",
						sf!("no live Environment resolver owns {}", parsed.raw_scheme),
					)
				})?
				.map_err(|error| ControlProtocolError::new("UrlReadFailed", error.message().clone()))?;
				Ok(serde_json::json!({
					"$bytes": omp_core::base64::encode(read.as_ref())
				}))
			},
			operation => Err(ControlProtocolError::new(
				"InvalidOperation",
				sf!("auxiliary CONTROL owner does not handle {operation}"),
			)),
		}
	}

	async fn effect(
		&self,
		context: ControlRequestContext,
		effect: ControlEffect,
	) -> Result<(), ControlProtocolError> {
		self.validate(&context)?;
		match effect {
			ControlEffect::Intent(payload) => {
				let object = payload.as_object().ok_or_else(|| {
					ControlProtocolError::new("InvalidIntent", "provider intent effect is not an object")
				})?;
				let operation = object
					.get("operation")
					.and_then(serde_json::Value::as_str)
					.ok_or_else(|| {
						ControlProtocolError::new("InvalidIntent", "provider intent operation is missing")
					})?;
				let arguments = object
					.get("arguments")
					.and_then(serde_json::Value::as_object)
					.ok_or_else(|| {
						ControlProtocolError::new(
							"InvalidIntent",
							"provider intent arguments are missing",
						)
					})?;
				let key = arguments
					.get("key")
					.and_then(serde_json::Value::as_str)
					.filter(|key| !key.is_empty())
					.ok_or_else(|| {
						ControlProtocolError::new(
							"InvalidIntent",
							"provider intent key must be non-empty",
						)
					})?;
				let owner = (
					self.identity.layer.clone(),
					self.identity.tier.clone(),
					self.identity.extension.clone(),
					Str::from(key),
				);
				match operation {
					"omp.intents.set" => {
						let intents = arguments
							.get("intents")
							.and_then(serde_json::Value::as_array)
							.ok_or_else(|| {
								ControlProtocolError::new(
									"InvalidIntent",
									"provider intent set requires an intents array",
								)
							})?;
						for intent in intents {
							let intent = intent.as_object().ok_or_else(|| {
								ControlProtocolError::new(
									"InvalidIntent",
									"provider intent rows must be objects",
								)
							})?;
							let kind = intent
								.get("kind")
								.and_then(serde_json::Value::as_str)
								.ok_or_else(|| {
									ControlProtocolError::new(
										"InvalidIntent",
										"provider intent kind is missing",
									)
								})?;
							if !matches!(
								kind,
								"strict"
									| "grammar" | "force_call"
									| "service_tier" | "verbosity"
									| "cache_retention"
									| "reasoning" | "safety"
									| "determinism" | "hosted_tool"
							) {
								return Err(ControlProtocolError::new(
									"InvalidIntent",
									sf!("unknown provider intent kind: {kind}"),
								));
							}
							let fallback = intent
								.get("on_unsupported")
								.and_then(serde_json::Value::as_str)
								.ok_or_else(|| {
									ControlProtocolError::new(
										"InvalidIntent",
										"provider intent fallback is missing",
									)
								})?;
							if !matches!(fallback, "unspecified" | "error" | "ignore" | "emulate") {
								return Err(ControlProtocolError::new(
									"InvalidIntent",
									sf!("unknown provider intent fallback: {fallback}"),
								));
							}
							let priority = intent
								.get("priority")
								.and_then(serde_json::Value::as_u64)
								.ok_or_else(|| {
									ControlProtocolError::new(
										"InvalidIntent",
										"provider intent priority must be an unsigned integer",
									)
								})?;
							if priority > u64::from(u32::MAX) {
								return Err(ControlProtocolError::new(
									"InvalidIntent",
									"provider intent priority exceeds u32",
								));
							}
						}
						self
							.intents
							.lock()
							.insert(owner, serde_json::Value::Array(intents.clone()));
						Ok(())
					},
					"omp.intents.clear" => {
						self.intents.lock().remove(&owner);
						Ok(())
					},
					_ => Err(ControlProtocolError::new(
						"InvalidIntent",
						sf!("unsupported provider intent effect: {operation}"),
					)),
				}
			},
			ControlEffect::Log(payload) => {
				tracing::info!(
					extension = %self.identity.extension,
					payload = %payload,
					"extension host log"
				);
				Ok(())
			},
			ControlEffect::Instrument(payload) => {
				let encoded = serde_json::to_vec(&payload).map_err(|error| {
					ControlProtocolError::new(
						"InvalidTelemetry",
						fault_in("telemetry event is not JSON encodable", error),
					)
				})?;
				let kind = payload
					.get("kind")
					.and_then(serde_json::Value::as_str)
					.unwrap_or("extension.instrument");
				let occurred_at_ms = SystemTime::now()
					.duration_since(UNIX_EPOCH)
					.map_or(0, |elapsed| elapsed.as_millis().try_into().unwrap_or(u64::MAX));
				self
					.telemetry
					.append(self.session_id.as_str(), kind, occurred_at_ms, &encoded)
					.map_err(|error| {
						ControlProtocolError::new(
							"TelemetryWriteFailed",
							fault_in("the Environment telemetry owner rejected the event", error),
						)
					})?;
				Ok(())
			},
			ControlEffect::Ui(_) => Err(ControlProtocolError::new(
				"InvalidEffect",
				"auxiliary CONTROL owner accepts only logs and internal observations",
			)),
		}
	}
}

struct ProductionMcpControlFactory {
	mcp: Arc<McpService>,
}

impl ControlAuthorityFactory for ProductionMcpControlFactory {
	fn bind(
		&self,
		identity: Arc<ControlConnectionIdentity>,
	) -> Result<Arc<dyn ControlAuthority>, ControlCompositionError> {
		let cancellation = CancellationToken::new();
		let control = self
			.mcp
			.control(Arc::clone(&identity), cancellation.clone())
			.ok_or_else(|| {
				ControlCompositionError::unavailable("mcp", "the Environment MCP manager is not bound")
			})?;
		Ok(Arc::new(ProductionMcpControlAuthority { identity, control, cancellation }))
	}
}

struct ProductionMcpControlAuthority {
	identity:     Arc<ControlConnectionIdentity>,
	control:      McpControl,
	cancellation: CancellationToken,
}

impl Drop for ProductionMcpControlAuthority {
	fn drop(&mut self) {
		self.cancellation.cancel();
	}
}

#[async_trait::async_trait]
impl ControlAuthority for ProductionMcpControlAuthority {
	fn handles(&self, operation: &str) -> bool {
		matches!(
			operation,
			"omp.mcp.mount" | "omp.mcp.unmount" | "omp.mcp.servers" | "omp.mcp.invoke"
		)
	}

	fn authorize(
		&self,
		context: &ControlRequestContext,
		_operation: &str,
		_arguments: &serde_json::Map<String, serde_json::Value>,
	) -> Result<(), ControlProtocolError> {
		if same_control_connection(&self.identity, &context.connection) {
			Ok(())
		} else {
			Err(ControlProtocolError::new(
				"StaleGeneration",
				"MCP authority belongs to a replaced extension-host connection",
			))
		}
	}

	async fn request(
		&self,
		context: ControlRequestContext,
		operation: Str,
		arguments: serde_json::Map<String, serde_json::Value>,
	) -> Result<serde_json::Value, ControlProtocolError> {
		self.authorize(&context, operation.as_str(), &arguments)?;
		self
			.control
			.dispatch_with_cancel(
				operation.as_str(),
				serde_json::Value::Object(arguments),
				self.cancellation.child_token(),
			)
			.await
			.map_err(|error| {
				ControlProtocolError::new(
					"McpControlError",
					fault_in("the Environment MCP owner rejected the request", error),
				)
			})
	}

	async fn effect(
		&self,
		context: ControlRequestContext,
		_effect: ControlEffect,
	) -> Result<(), ControlProtocolError> {
		if same_control_connection(&self.identity, &context.connection) {
			Err(ControlProtocolError::new(
				"InvalidMcpEffect",
				"MCP does not accept fire-and-forget effects",
			))
		} else {
			Err(ControlProtocolError::new(
				"StaleGeneration",
				"MCP authority belongs to a replaced extension-host connection",
			))
		}
	}
}

struct UnboundAgentsControlFactory;

impl ControlAuthorityFactory for UnboundAgentsControlFactory {
	fn bind(
		&self,
		identity: Arc<ControlConnectionIdentity>,
	) -> Result<Arc<dyn ControlAuthority>, ControlCompositionError> {
		Ok(Arc::new(UnboundAgentsControlAuthority { identity }))
	}
}

struct UnboundAgentsControlAuthority {
	identity: Arc<ControlConnectionIdentity>,
}

#[async_trait::async_trait]
impl ControlAuthority for UnboundAgentsControlAuthority {
	fn handles(&self, operation: &str) -> bool {
		operation.starts_with("omp.agents.")
	}

	fn authorize(
		&self,
		context: &ControlRequestContext,
		_operation: &str,
		_arguments: &serde_json::Map<String, serde_json::Value>,
	) -> Result<(), ControlProtocolError> {
		if same_control_connection(&self.identity, &context.connection) {
			Err(
				ControlProtocolError::new(
					"AgentsOwnerUnavailable",
					"no installed Agents lease owns this CONTROL connection",
				)
				.retryable(true),
			)
		} else {
			Err(ControlProtocolError::new(
				"StaleGeneration",
				"Agents authority belongs to a replaced extension-host connection",
			))
		}
	}

	async fn request(
		&self,
		context: ControlRequestContext,
		operation: Str,
		arguments: serde_json::Map<String, serde_json::Value>,
	) -> Result<serde_json::Value, ControlProtocolError> {
		self.authorize(&context, operation.as_str(), &arguments)?;
		Err(
			ControlProtocolError::new(
				"AgentsOwnerUnavailable",
				"no installed Agents lease owns this CONTROL connection",
			)
			.retryable(true),
		)
	}

	async fn effect(
		&self,
		context: ControlRequestContext,
		_effect: ControlEffect,
	) -> Result<(), ControlProtocolError> {
		self.authorize(&context, "omp.agents.effect", &serde_json::Map::new())
	}
}

pub(in crate::server) fn same_control_connection(
	expected: &ControlConnectionIdentity,
	actual: &ControlConnectionIdentity,
) -> bool {
	expected.extension == actual.extension
		&& expected.principal == actual.principal
		&& expected.artifact_digest == actual.artifact_digest
		&& expected.layer == actual.layer
		&& expected.tier == actual.tier
		&& expected.trust == actual.trust
		&& expected.host_generation == actual.host_generation
		&& expected.session_generation == actual.session_generation
		&& expected.capabilities == actual.capabilities
}

pub(in crate::server) fn bind_live_session_authority_snapshot(
	config: &mut ExtHostConfig,
	root: &Path,
	authority: Option<&Arc<dyn omp_contract::SessionAuthority>>,
) {
	let Some(authority) = authority else {
		return;
	};
	let Some(endpoint) = authority.lookup(config.session_id.as_str()) else {
		return;
	};
	let mut depth = 0_u32;
	let mut cursor = endpoint.topology.parent_id.clone();
	let mut seen = BTreeSet::new();
	while let Some(parent) = cursor {
		if !seen.insert(parent.clone()) {
			break;
		}
		depth = depth.saturating_add(1);
		if depth == 64 {
			break;
		}
		cursor = authority
			.lookup(parent.as_str())
			.and_then(|parent| parent.topology.parent_id);
	}
	let root =
		Url::from_file_path(root).map_or_else(|_| String::from("file:///"), |root| root.to_string());
	let started_at_ms = config
		.session_started_at
		.duration_since(UNIX_EPOCH)
		.unwrap_or_default()
		.as_millis()
		.try_into()
		.unwrap_or(u64::MAX);
	config.bind_session_authority_snapshot(
		serde_json::json!({
			"id": endpoint.id.as_str(),
			"title": (!endpoint.name.is_empty()).then(|| endpoint.name.as_str()),
			"title_source": "system",
			"cwd": root.clone(),
			"project": root,
			"created_ms": started_at_ms,
			"updated_ms": started_at_ms,
			"status": "pending",
			"kind": match endpoint.topology.role {
				SessionRole::Main => "interactive",
				SessionRole::Child => "subagent",
			},
			"parent": endpoint.topology.parent_id.as_deref(),
			"entries": 0,
			"turns": 0,
			"usage": {},
			"cost": {"nanos_usd": 0, "estimated": true},
			"models": [],
			"remote": false,
		}),
		depth,
	);
}

pub(in crate::server) fn register_extension_convars(
	con: &Ctx,
	extensions: &[ExtHostSpec],
) -> Result<(), EnvdError> {
	for extension in extensions {
		crate::exthost::register_extension_setting_convars(
			con,
			extension.key.extension().as_str(),
			&extension.manifest.setting_schemas,
			&extension.settings,
		)?;
	}
	Ok(())
}

pub(in crate::server) fn production_control_authorities(
	state_dir: &Path,
	session_id: &Str,
	telemetry: &Arc<TelemetryIndex>,
	mcp: &Arc<McpService>,
	extensions: &[ExtHostSpec],
	domain_control: Arc<DomainControlSlot>,
	convars: Arc<dyn ControlAuthorityFactory>,
	quota_runtime: ControlQuotaRuntime,
	extension_tool_call_timeout: Duration,
	scheme_generation: Arc<crate::SchemeGeneration>,
) -> ProductionControlBindings {
	let resources = Arc::new(sync::OnceLock::new());
	let manifests = Arc::new(
		extensions
			.iter()
			.map(|extension| {
				(
					(
						extension.key.layer().clone(),
						extension.key.tier().clone(),
						extension.key.extension().clone(),
					),
					extension.manifest.clone(),
				)
			})
			.collect::<BTreeMap<_, _>>(),
	);
	let registry_owner = RegistryControlFactory::new(manifests.as_ref().clone());
	let callbacks = CallbackDispatcherSlot::new();
	let device_factory = DeviceControlFactory::new(
		Arc::clone(&registry_owner),
		callbacks.clone(),
		Arc::new(ProductionDeviceCatalogObserver),
		Arc::new(ProductionDeviceInvocationAdmission),
	);
	#[cfg(feature = "cap-forge")]
	let forge_devices = {
		let client = crate::forge_adapter::LiveForgeDeviceClient::default();
		client.bind(device_factory.forge_invoker());
		client
	};
	#[cfg(feature = "cap-ci")]
	let ci_devices = {
		let client = crate::forge_adapter::LiveCiDeviceClient::default();
		client.bind(device_factory.ci_invoker());
		client
	};
	let devices: Arc<dyn ControlAuthorityFactory> = device_factory;
	let extension_settings = extensions
		.iter()
		.map(|extension| {
			(
				(
					extension.key.layer().clone(),
					extension.key.tier().clone(),
					extension.key.extension().clone(),
				),
				extension.settings.clone(),
			)
		})
		.collect();
	let hooks = HookControlFactory::new(
		Arc::clone(&registry_owner),
		callbacks.clone(),
		BTreeMap::new(),
		extension_settings,
		extension_tool_call_timeout,
	);
	hooks.bind_mcp_drop_journal(Arc::clone(telemetry), session_id.clone());
	let hooks_factory: Arc<dyn ControlAuthorityFactory> = hooks.clone();
	let envd: Arc<dyn ControlAuthorityFactory> = Arc::new(ProductionEnvdControlFactory {
		state_dir:         state_dir.to_path_buf(),
		session_id:        session_id.clone(),
		telemetry:         Arc::clone(telemetry),
		intents:           Arc::new(Mutex::new(BTreeMap::new())),
		resources:         Arc::clone(&resources),
		scheme_generation: Arc::clone(&scheme_generation),
	});
	let registry = RegistryControlAuthorities::new(devices, hooks_factory);
	let gated = |domain| -> Arc<dyn ControlAuthorityFactory> {
		Arc::new(ManifestGatedControlFactory {
			domain,
			manifests: Arc::clone(&manifests),
			slot: Arc::clone(&domain_control),
		})
	};
	let policy_owner = gated(DeclaredExternalDomain::Policy);
	let parameters = gated(DeclaredExternalDomain::Parameters);
	let workers = gated(DeclaredExternalDomain::Workers);
	let direct_filesystem = gated(DeclaredExternalDomain::DirectFilesystem);
	let credentials = gated(DeclaredExternalDomain::Credentials);
	let prompts = gated(DeclaredExternalDomain::Prompts);
	let sessions = gated(DeclaredExternalDomain::Sessions);
	let ui = gated(DeclaredExternalDomain::Ui);
	let telemetry_owner = gated(DeclaredExternalDomain::Telemetry);
	let jobs = gated(DeclaredExternalDomain::Jobs);
	let provider_owner = gated(DeclaredExternalDomain::Provider);
	let services = gated(DeclaredExternalDomain::Services);
	let auxiliary: Arc<dyn ControlAuthorityFactory> = Arc::new(CompositeControlFactory {
		owners: vec![Arc::clone(&envd), parameters, workers, direct_filesystem, convars]
			.into_boxed_slice(),
	});
	let artifacts: Arc<dyn ControlAuthorityFactory> =
		Arc::new(FixedControlAuthorityFactory::new(Arc::new(UndeclaredControlAuthority)));
	let persistence = PersistenceControlAuthorities::new(sessions, artifacts, credentials);
	let policy = PolicyControlAuthorities::new(policy_owner, prompts);
	let presentation = PresentationControlAuthorities::new(ui, telemetry_owner, jobs);
	let provider = ProviderControlAuthorities::new(provider_owner, services);
	let envd = EnvdControlAuthorities::new(
		registry,
		persistence,
		policy,
		presentation,
		provider,
		auxiliary,
		envd,
	);
	let external = ExternalControlAuthorities::new(
		Arc::new(UnboundAgentsControlFactory),
		Arc::new(ProductionMcpControlFactory { mcp: Arc::clone(mcp) }),
	);
	ProductionControlBindings {
		factory: Arc::new(
			HostControlAuthorityFactory::new(envd, external).with_quota_runtime(quota_runtime),
		),
		resources,
		callbacks,
		registry: registry_owner,
		hooks,
		#[cfg(feature = "cap-forge")]
		forge_devices,
		#[cfg(feature = "cap-ci")]
		ci_devices,
	}
}
