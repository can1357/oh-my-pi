//! Runtime model discovery service and conservative catalog normalization.

use std::{
	collections::{BTreeMap, BTreeSet},
	future::Future,
	num::NonZeroU32,
	sync::Arc,
	task::{Context, Poll},
};

use omp_core::{Str, sf};
use tower::Service;

use crate::{
	answer::{Answer, AnswerBody, ModelDiscoveryPage},
	call::{Call, DiscoveryRequest, OperationCall},
	catalog::{
		DiscoveredModel, DiscoveryNormalizer, ModelKey, ModelSpec, OperationKind, Pricing,
		ProviderId, RouteDef, RouteId, WireModelId, snapshot::Catalog, taxonomy,
	},
	error::{Error, ErrorDetail, ErrorKind, ErrorPhase, RetryAction},
	layer::recover::DiscoveryProjector,
	operation::{OperationRequest, OperationResponse},
	receipt::{ExecutionReceipt, ReasonId},
};

/// Provider wire rows and continuation state returned by a discovery codec.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RawDiscoveryPage {
	/// Typed provider-declared rows; no inferred defaults have been applied.
	pub models:      Vec<DiscoveredModel>,
	/// Opaque continuation cursor.
	pub next_cursor: Option<Str>,
}

/// Returns whether a route uses the `OpenAI` Responses wire contract.
fn is_responses_codec(codec: &str) -> bool {
	matches!(codec, "openai-responses" | "bedrock-mantle")
}

/// Sibling-catalog responses-route hints for gateway-first discovered ids.
///
/// The `OpenCode` gateways ship models before any census bundles them
/// (`muse-spark-1.2[-contributor]`, served only at `/responses`).
/// When an unbundled discovered id — or its billing-variant base (`-free`,
/// `-contributor`) — is bundled on this provider or a declared sibling gateway
/// with an `openai-responses` route, the listing materializes on this
/// provider's responses route instead of the discovery route. Only the
/// responses signal is borrowed: anthropic and chat transports genuinely
/// diverge across the gateways (`minimax-m2.5`), and pricing never transfers.
#[derive(Clone, Debug)]
struct ResponsesRouteHints {
	/// Bundled wire identifiers — on this provider or a sibling gateway —
	/// whose model rides an `openai-responses` route.
	wire_ids: Arc<BTreeSet<WireModelId>>,
	/// This provider's responses route; the materialization target.
	target:   RouteId,
}

impl ResponsesRouteHints {
	/// Whether the discovered wire id — exactly or via its billing-variant
	/// base — is hinted onto the responses route.
	fn hinted(&self, wire_model: &WireModelId<str>) -> bool {
		if self.wire_ids.contains(wire_model) {
			return true;
		}
		taxonomy()
			.billing_variant_plain(wire_model.as_str())
			.is_some_and(|base| self.wire_ids.contains(WireModelId::from_ref(base)))
	}
}

/// A catalog route cannot construct its discovery projector.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum CatalogDiscoveryProjectorError {
	/// The route advertises discovery without naming a discovery specification.
	#[error("route has no discovery specification")]
	RouteHasNoDiscoverySpec,
	/// The route names a discovery specification absent from the catalog.
	#[error("catalog discovery specification is missing")]
	CatalogDiscoverySpecMissing,
	/// The route names a provider absent from the catalog.
	#[error("catalog discovery provider is missing")]
	CatalogDiscoveryProviderMissing,
	/// The provider has no authored defaults for discovered models.
	#[error("provider discovery defaults are missing")]
	ProviderDiscoveryDefaultsMissing,
	/// Discovery defaults attempted to inherit thinking or pricing.
	#[error("discovery defaults must not inherit thinking or pricing")]
	DefaultsInheritThinkingOrPricing,
	/// Discovery defaults and the provider disagree on wire policy.
	#[error("discovery wire policy does not match provider")]
	WirePolicyMismatch,
	/// Two catalog models claim the same wire identifier on this route.
	#[error(
		"wire model {wire_model} is claimed by both {first} and {second} on the discovery route"
	)]
	DuplicateRouteWireModelIdentifier {
		/// Duplicated provider wire identifier.
		wire_model: WireModelId,
		/// First normalized model claiming the identifier.
		first:      ModelKey,
		/// Second normalized model claiming the identifier.
		second:     ModelKey,
	},
}

/// Route-scoped projector applying canonical discovery normalization during
/// response recovery.
#[derive(Clone, Debug)]
pub struct CatalogDiscoveryProjector {
	normalizer:        DiscoveryNormalizer,
	allowlist:         Option<Arc<BTreeMap<WireModelId, ModelSpec>>>,
	provider_bundled:  Option<Arc<BTreeMap<WireModelId, ModelSpec>>>,
	canonical_bundled: Option<Arc<BTreeMap<Str, ModelSpec>>>,
	hints:             Option<ResponsesRouteHints>,
	provider:          ProviderId,
	route:             RouteId,
}

impl CatalogDiscoveryProjector {
	/// Constructs a projector from exact route identity and compiler-owned
	/// normalization defaults.
	pub const fn new(normalizer: DiscoveryNormalizer, provider: ProviderId, route: RouteId) -> Self {
		Self {
			normalizer,
			allowlist: None,
			provider_bundled: None,
			canonical_bundled: None,
			hints: None,
			provider,
			route,
		}
	}

	/// Constructs a mixed bundled/unknown projector from authored provider
	/// discovery defaults.
	pub fn for_route(
		catalog: &Catalog,
		route: &RouteDef,
	) -> Result<Self, CatalogDiscoveryProjectorError> {
		let discovery = route
			.discovery
			.as_ref()
			.ok_or(CatalogDiscoveryProjectorError::RouteHasNoDiscoverySpec)?;
		catalog
			.discovery_spec(discovery)
			.ok_or(CatalogDiscoveryProjectorError::CatalogDiscoverySpecMissing)?;
		let provider = catalog
			.provider(&route.provider)
			.ok_or(CatalogDiscoveryProjectorError::CatalogDiscoveryProviderMissing)?;
		let defaults = catalog
			.discovery_defaults(&route.provider)
			.cloned()
			.ok_or(CatalogDiscoveryProjectorError::ProviderDiscoveryDefaultsMissing)?;
		if defaults.thinking.is_some() || defaults.pricing != Pricing::default() {
			return Err(CatalogDiscoveryProjectorError::DefaultsInheritThinkingOrPricing);
		}
		if defaults.wire_policy != provider.wire_policy {
			return Err(CatalogDiscoveryProjectorError::WirePolicyMismatch);
		}
		let mut allowlist: BTreeMap<WireModelId, ModelSpec> = BTreeMap::new();
		for model in catalog.models() {
			for (candidate, wire_model) in &model.wire_ids {
				if candidate != &route.id {
					continue;
				}
				if let Some(existing) = allowlist.get(wire_model) {
					return Err(CatalogDiscoveryProjectorError::DuplicateRouteWireModelIdentifier {
						wire_model: wire_model.clone(),
						first:      existing.key.clone(),
						second:     model.key.clone(),
					});
				}
				allowlist.insert(wire_model.clone(), model.clone());
			}
		}
		let hints = responses_route_hints(catalog, route);
		let provider_bundled = (taxonomy().has_routing_variants(route.provider.as_str())
			|| taxonomy().recovers_canonical_params(route.provider.as_str())
			|| hints.is_some())
		.then(|| {
			// The taxonomy declares provider-scoped routing-variant suffixes
			// (`gpt-5.6-luna-wm`), canonical-parameter recovery, or a responses-route
			// hint group. The route allowlist above is scoped to the discovery route,
			// but the
			// bundled SKUs may live on per-model routes, so collect every
			// bundled wire identity owned by this provider for the
			// plain-counterpart and seeded-row lookups.
			let owned: BTreeSet<_> = catalog
				.routes()
				.iter()
				.filter(|definition| definition.provider == route.provider)
				.map(|definition| &definition.id)
				.collect();
			let mut bundled = BTreeMap::new();
			for model in catalog.models() {
				for (candidate, wire_model) in &model.wire_ids {
					if owned.contains(candidate) {
						bundled
							.entry(wire_model.clone())
							.or_insert_with(|| model.clone());
					}
				}
			}
			Arc::new(bundled)
		});
		let canonical_bundled = taxonomy()
			.recovers_canonical_params(route.provider.as_str())
			.then(|| {
				// Canonical open-weight rows normally carry namespaced ids
				// (`deepseek-ai/`). Exact gateway-first response pins may also recover a
				// reviewed bare canonical card (Muse Spark). The first entry in frozen catalog
				// order wins deterministically.
				let owners: BTreeMap<_, _> = catalog
					.routes()
					.iter()
					.map(|definition| (&definition.id, &definition.provider))
					.collect();
				let mut index = BTreeMap::new();
				for model in catalog.models() {
					let Some(relative) = model
						.routes
						.first()
						.and_then(|route_id| owners.get(route_id))
						.and_then(|owner| model.key.as_str().strip_prefix(owner.as_str()))
						.and_then(|rest| rest.strip_prefix('/'))
					else {
						continue;
					};
					if !relative.contains('/')
						&& !hints
							.as_ref()
							.is_some_and(|hints| hints.hinted(WireModelId::from_ref(relative)))
					{
						continue;
					}
					index
						.entry(Str::new(relative.to_ascii_lowercase()))
						.or_insert_with(|| model.clone());
				}
				Arc::new(index)
			});
		Ok(Self {
			normalizer: DiscoveryNormalizer::new(defaults),
			allowlist: Some(Arc::new(allowlist)),
			provider_bundled,
			canonical_bundled,
			hints,
			provider: route.provider.clone(),
			route: route.id.clone(),
		})
	}
}

/// Builds the responses-route hint set for a provider with exact route pins or
/// a declared sibling group: authored gateway-first ids plus every
/// bundled wire id on this provider or a sibling gateway riding an
/// openai-responses route, and this provider's deterministic materialization
/// target.
fn responses_route_hints(catalog: &Catalog, route: &RouteDef) -> Option<ResponsesRouteHints> {
	let taxonomy = taxonomy();
	let group = taxonomy.responses_hint_group(route.provider.as_str());
	let pinned = taxonomy.responses_route_models(route.provider.as_str());
	if group.is_none() && pinned.is_none() {
		return None;
	}
	// The materialization target mirrors resolver ordering: highest priority,
	// then lexicographically smallest route id.
	let target = catalog
		.routes()
		.iter()
		.filter(|definition| {
			definition.provider == route.provider && is_responses_codec(definition.codec.as_str())
		})
		.max_by(|left, right| {
			left
				.priority
				.unwrap_or(0)
				.cmp(&right.priority.unwrap_or(0))
				.then_with(|| right.id.cmp(&left.id))
		})
		.map(|definition| definition.id.clone())?;
	let responses_routes: BTreeSet<_> = catalog
		.routes()
		.iter()
		.filter(|definition| is_responses_codec(definition.codec.as_str()))
		.map(|definition| &definition.id)
		.collect();
	let owners: BTreeMap<_, _> = catalog
		.routes()
		.iter()
		.map(|definition| (&definition.id, &definition.provider))
		.collect();
	let mut wire_ids: BTreeSet<WireModelId> = pinned
		.into_iter()
		.flatten()
		.map(|model| WireModelId::from(model.as_str()))
		.collect();
	if let Some(group) = group {
		for model in catalog.models() {
			let Some(owner) = model.routes.first().and_then(|id| owners.get(id)) else {
				continue;
			};
			if !group
				.iter()
				.any(|member| member.eq_ignore_ascii_case(owner.as_str()))
			{
				continue;
			}
			if !model.routes.iter().any(|id| responses_routes.contains(id)) {
				continue;
			}
			for (_, wire_model) in &model.wire_ids {
				wire_ids.insert(wire_model.clone());
			}
		}
	}
	Some(ResponsesRouteHints { wire_ids: Arc::new(wire_ids), target })
}

impl DiscoveryProjector for CatalogDiscoveryProjector {
	fn project(
		&self,
		request: &DiscoveryRequest,
		rows: Vec<DiscoveredModel>,
		next_cursor: Option<Str>,
	) -> Result<ModelDiscoveryPage, Error> {
		match &self.allowlist {
			None => normalize_page(
				&self.normalizer,
				&self.provider,
				&self.route,
				request,
				RawDiscoveryPage { models: rows, next_cursor },
			),
			Some(allowlist) => project_mixed_page(
				allowlist,
				self.provider_bundled.as_deref(),
				self.canonical_bundled.as_deref(),
				self.hints.as_ref(),
				&self.normalizer,
				&self.provider,
				&self.route,
				request,
				rows,
				next_cursor,
			),
		}
	}
}

#[allow(
	clippy::too_many_arguments,
	reason = "route-scoped projection is a single internal seam with exact identity inputs"
)]
fn project_mixed_page(
	allowlist: &BTreeMap<WireModelId, ModelSpec>,
	provider_bundled: Option<&BTreeMap<WireModelId, ModelSpec>>,
	canonical_bundled: Option<&BTreeMap<Str, ModelSpec>>,
	hints: Option<&ResponsesRouteHints>,
	normalizer: &DiscoveryNormalizer,
	provider: &ProviderId<str>,
	route: &RouteId<str>,
	request: &DiscoveryRequest,
	rows: Vec<DiscoveredModel>,
	next_cursor: Option<Str>,
) -> Result<ModelDiscoveryPage, Error> {
	if rows.len() > request.page_size as usize {
		return Err(protocol_error("discovery_backend_exceeded_page_size"));
	}
	if next_cursor.as_ref().is_some_and(|cursor| cursor.is_empty()) {
		return Err(protocol_error("discovery_backend_returned_empty_cursor"));
	}
	let mut seen_wire: BTreeSet<WireModelId> = BTreeSet::new();
	let mut seen_models = BTreeSet::new();
	let mut models = Vec::new();
	let push =
		|model: ModelSpec, seen_models: &mut BTreeSet<ModelKey>, models: &mut Vec<ModelSpec>| {
			if !seen_models.insert(model.key.clone()) {
				return;
			}
			if request
				.operation
				.is_some_and(|operation| !model.capabilities.operations.contains_kind(operation))
			{
				return;
			}
			models.push(model);
		};
	for row in rows {
		if &row.provider != provider || &row.route != route {
			return Err(protocol_error("discovery_row_route_mismatch"));
		}
		if !seen_wire.insert(row.wire_model.clone()) {
			continue;
		}
		let bundled = allowlist.get(&row.wire_model).or_else(|| {
			// The backend's own bundled slug wins over any synthesized clone
			// or conservative normalization, even off the discovery route.
			provider_bundled.and_then(|bundled| bundled.get(&row.wire_model))
		});
		let model = if let Some(model) = bundled {
			model.clone()
		} else if let Some(plain) =
			routing_variant_counterpart(provider_bundled, provider, &row.wire_model)
		{
			// Declared routing variant of a bundled plain SKU:
			// register the suffixed wire identity with base-model
			// metadata derived from the plain spec, then keep the
			// plain identity itself resolvable under authoritative
			// discovery.
			push(routing_variant_spec(plain, &row), &mut seen_models, &mut models);
			plain.clone()
		} else {
			let mut model = normalizer
				.normalize(&row)
				.map_err(|_| protocol_error("discovery_normalization_failed"))?
				.model;
			if let Some(canonical) = canonical_reference(canonical_bundled, hints, &model.key) {
				recover_canonical_params(&mut model, canonical, &row);
			}
			if let Some(hints) = hints
				&& hints.hinted(&row.wire_model)
			{
				// Gateway-first id bundled with an openai-responses route on
				// this provider or a sibling gateway: materialize the listing on this
				// provider's responses route instead of the discovery route. Canonical
				// intrinsic parameters may be recovered separately; pricing and wire
				// policy never transfer.
				model.wire_ids = Box::new([(hints.target.clone(), row.wire_model.clone())]);
				model.routes = Box::new([hints.target.clone()]);
			}
			model
		};
		push(model, &mut seen_models, &mut models);
	}
	Ok(ModelDiscoveryPage { models, next_cursor })
}

/// Returns the bundled plain counterpart backing a declared routing-variant
/// wire identifier (`gpt-5.6-luna-wm` → the bundled `gpt-5.6-luna` spec).
fn routing_variant_counterpart<'catalog>(
	provider_bundled: Option<&'catalog BTreeMap<WireModelId, ModelSpec>>,
	provider: &ProviderId<str>,
	wire_model: &WireModelId<str>,
) -> Option<&'catalog ModelSpec> {
	let bundled = provider_bundled?;
	let plain = taxonomy().routing_variant_plain(provider.as_str(), wire_model.as_str())?;
	bundled.get(plain)
}

/// Returns the bundled canonical reference backing a discovered open-weight
/// identity (`deepseek-ai/DeepSeek-V4-Pro` resold under its canonical id) or an
/// exact bare gateway-first response pin.
///
/// The index construction, not this lookup, limits bare identities to reviewed
/// provider-scoped pins, so generic slugs never inherit another provider's
/// card.
fn canonical_reference<'catalog>(
	canonical_bundled: Option<&'catalog BTreeMap<Str, ModelSpec>>,
	hints: Option<&ResponsesRouteHints>,
	key: &ModelKey<str>,
) -> Option<&'catalog ModelSpec> {
	let index = canonical_bundled?;
	let lookup = key.as_str().to_ascii_lowercase();
	if !lookup.contains('/')
		&& !hints.is_some_and(|hints| hints.hinted(WireModelId::from_ref(lookup.as_str())))
	{
		return None;
	}
	index.get(lookup.as_str())
}

/// Recovers intrinsic base-model parameters for a discovered open-weight row
/// from its bundled canonical reference.
///
/// Only intrinsic facts transfer — display name, context window, output
/// limit, the interned thinking policy, and unknown chat modality/reasoning
/// evidence. Pricing, wire policy, routes, and effort routing stay
/// provider-specific: discovery never borrows a tariff across providers.
fn recover_canonical_params(model: &mut ModelSpec, canonical: &ModelSpec, row: &DiscoveredModel) {
	if row.display_name.is_none() {
		model.display_name.clone_from(&canonical.display_name);
	}
	if model.limits.context_window.is_none() {
		model.limits.context_window = canonical.limits.context_window;
	}
	if model.limits.maximum_output_tokens.is_none() {
		model.limits.maximum_output_tokens =
			match (canonical.limits.maximum_output_tokens, model.limits.context_window) {
				(Some(tokens), Some(window)) => Some(tokens.min(window)),
				(tokens, _) => tokens,
			};
	}
	if model.thinking.is_none() {
		model.thinking.clone_from(&canonical.thinking);
	}
	if let (Some(chat), Some(reference)) =
		(model.capabilities.chat.as_mut(), canonical.capabilities.chat.as_ref())
	{
		if chat.input_modalities.is_unknown() {
			chat
				.input_modalities
				.clone_from(&reference.input_modalities);
		}
		if chat.reasoning.is_unknown() {
			chat.reasoning.clone_from(&reference.reasoning);
		}
	}
}

/// Builds the routing-variant listing from its canonical plain spec.
///
/// The variant listing binds the advertised suffixed wire identity to the
/// discovery route while deriving every base-model fact (context window,
/// pricing, capabilities, thinking) from the bundled plain SKU.
fn routing_variant_spec(plain: &ModelSpec, row: &DiscoveredModel) -> ModelSpec {
	let mut model = plain.clone();
	// The counterpart lookup already proved the wire identifier carries a
	// declared routing-variant suffix; append that exact suffix to the plain
	// key so the variant stays a distinct, explicitly selectable listing.
	let plain_wire_len = taxonomy()
		.routing_variant_plain(row.provider.as_str(), row.wire_model.as_str())
		.map_or(row.wire_model.as_str().len(), str::len);
	let suffix = &row.wire_model.as_str()[plain_wire_len..];
	model.key = ModelKey::from(format!("{}{suffix}", plain.key.as_str()));
	if let Some(display_name) = &row.display_name {
		model.display_name = display_name.clone();
	}
	model.wire_ids = Box::new([(row.route.clone(), row.wire_model.clone())]);
	model.routes = Box::new([row.route.clone()]);
	model
}

/// Concrete discovery service over a provider-specific typed backend.
#[derive(Clone, Debug)]
pub struct DiscoveryService<S> {
	inner:             S,
	normalizer:        DiscoveryNormalizer,
	maximum_page_size: NonZeroU32,
}

impl<S> DiscoveryService<S> {
	/// Constructs a discovery service with route-owned policy defaults.
	pub const fn new(
		inner: S,
		normalizer: DiscoveryNormalizer,
		maximum_page_size: NonZeroU32,
	) -> Self {
		Self { inner, normalizer, maximum_page_size }
	}

	/// Validates a discovery request without silently changing an explicit page
	/// size.
	pub fn prepare(&self, request: &DiscoveryRequest) -> Result<DiscoveryRequest, Error> {
		if request.page_size == 0 {
			return Err(request_error("discovery.page_size", "zero_discovery_page_size"));
		}
		if request.page_size > self.maximum_page_size.get() {
			return Err(capability_error(
				"discovery.page_size",
				"discovery_page_size_exceeds_route_limit",
			));
		}
		if request
			.cursor
			.as_ref()
			.is_some_and(|cursor| cursor.is_empty())
		{
			return Err(request_error("discovery.cursor", "empty_discovery_cursor"));
		}
		Ok(DiscoveryRequest {
			provider:  request.provider.clone(),
			route:     request.route.clone(),
			cursor:    request.cursor.clone(),
			page_size: request.page_size,
			operation: request.operation,
		})
	}
}

impl<S> Service<Call> for DiscoveryService<S>
where
	S: Service<
			OperationRequest<DiscoveryRequest>,
			Response = OperationResponse<RawDiscoveryPage>,
			Error = Error,
		>,
	S::Future: Send + 'static,
{
	type Error = Error;
	type Response = Answer;

	type Future = impl Future<Output = Result<Answer, Error>> + Send;

	fn poll_ready(&mut self, context: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
		self.inner.poll_ready(context)
	}

	fn call(&mut self, call: Call) -> Self::Future {
		let prepared = match &call.operation {
			OperationCall::DiscoverModels(request) => self.prepare(request).map(Arc::new),
			_ => Err(wrong_operation(&call)),
		};
		let pending = prepared.as_ref().ok().map(|request| {
			self
				.inner
				.call(OperationRequest::from_call(&call, Arc::clone(request)))
		});
		let normalizer = self.normalizer.clone();
		async move {
			let request = prepared?;
			let Some(pending) = pending else {
				return Err(protocol_error("discovery_backend_not_called"));
			};
			let response = pending.await?;
			if response.meta.model.is_some() {
				return Err(protocol_error("discovery_response_must_not_select_model"));
			}
			if request
				.provider
				.as_ref()
				.is_some_and(|provider| provider != &response.meta.provider)
				|| request
					.route
					.as_ref()
					.is_some_and(|route| route != &response.meta.route)
			{
				return Err(protocol_error("discovery_response_selector_mismatch"));
			}
			let page = normalize_page(
				&normalizer,
				&response.meta.provider,
				&response.meta.route,
				&request,
				response.output,
			)?;
			Ok(OperationResponse { meta: response.meta, receipt: response.receipt, output: page }
				.into_answer(AnswerBody::Models))
		}
	}
}

/// Validates provider rows and applies the canonical conservative discovery
/// normalizer.
pub fn normalize_page(
	normalizer: &DiscoveryNormalizer,
	provider: &ProviderId<str>,
	route: &RouteId<str>,
	request: &DiscoveryRequest,
	page: RawDiscoveryPage,
) -> Result<ModelDiscoveryPage, Error> {
	if page.models.len() > request.page_size as usize {
		return Err(protocol_error("discovery_backend_exceeded_page_size"));
	}
	if page
		.next_cursor
		.as_ref()
		.is_some_and(|cursor| cursor.is_empty())
	{
		return Err(protocol_error("discovery_backend_returned_empty_cursor"));
	}
	for row in &page.models {
		if &row.provider != provider || &row.route != route {
			return Err(protocol_error("discovery_row_route_mismatch"));
		}
	}
	let mut models = normalizer
		.normalize_batch(&page.models)
		.map_err(|_| protocol_error("discovery_normalization_failed"))?
		.into_iter()
		.map(|normalized| normalized.model)
		.collect::<Vec<_>>();
	if let Some(operation) = request.operation {
		models.retain(|model| model.capabilities.operations.contains_kind(operation));
	}
	Ok(ModelDiscoveryPage { models, next_cursor: page.next_cursor })
}

fn wrong_operation(call: &Call) -> Error {
	Error::new(
		ErrorKind::InternalInvariant,
		ErrorPhase::Internal,
		RetryAction::Never,
		ExecutionReceipt::default(),
	)
	.detail(ErrorDetail::capability(
		Str::new(OperationKind::DiscoverModels.to_string()),
		ReasonId(sf!("operation_service_mismatch")),
	))
	.request_id(call.id.clone())
}

fn request_error(feature: &'static str, reason: &'static str) -> Error {
	Error::planning(
		ErrorKind::InvalidRequest,
		ErrorDetail::capability(Str::new(feature), ReasonId(Str::new(reason))),
		ExecutionReceipt::default(),
	)
}

fn capability_error(feature: &'static str, reason: &'static str) -> Error {
	Error::planning(
		ErrorKind::CapabilityMismatch,
		ErrorDetail::capability(Str::new(feature), ReasonId(Str::new(reason))),
		ExecutionReceipt::default(),
	)
}

fn protocol_error(reason: &'static str) -> Error {
	Error::new(
		ErrorKind::ProviderContractMismatch,
		ErrorPhase::Discovery,
		RetryAction::Never,
		ExecutionReceipt::default(),
	)
	.detail(ErrorDetail::protocol(ReasonId(Str::new(reason))))
}

#[cfg(test)]
mod tests {
	use std::{
		collections::{BTreeMap, BTreeSet},
		num::NonZeroU32,
		sync::Arc,
	};

	use omp_core::{Str, sf};

	use super::{
		CatalogDiscoveryProjector, DiscoveryService, RawDiscoveryPage, ResponsesRouteHints,
		normalize_page, project_mixed_page,
	};
	use crate::{
		call::DiscoveryRequest,
		catalog::{
			ContextStrategy, DiscoveredModel, DiscoveryDefaults, DiscoveryNormalizer, ModelKey,
			ModelLimits, ModelSpec, OperationBits, OperationKind, Price, PriceUnit, Pricing,
			ProviderId, RouteId, ThinkingPolicyId, WireModelId, WirePolicyId, snapshot::Catalog,
		},
		layer::recover::DiscoveryProjector,
	};

	fn discovered(
		provider: &ProviderId<str>,
		route: &RouteId<str>,
		wire_model: &str,
	) -> DiscoveredModel {
		let mut operations = OperationBits::empty();
		operations.insert_kind(OperationKind::Embed);
		DiscoveredModel {
			provider:              provider.to_owned(),
			route:                 route.to_owned(),
			wire_model:            WireModelId::from(wire_model),
			aliases:               Box::new([]),
			display_name:          None,
			declared_class:        None,
			declared_operations:   operations,
			declared_capabilities: None,
			declared_limits:       None,
			declared_pricing:      Box::new([]),
			extended_context_mode: None,
			availability:          None,
			source:                "oracle".into(),
			observed_at_ms:        Some(1),
			updated_at_ms:         None,
			deprecated:            None,
		}
	}

	fn projector(provider: &ProviderId<str>, route: &RouteId<str>) -> CatalogDiscoveryProjector {
		CatalogDiscoveryProjector::new(
			DiscoveryNormalizer::new(DiscoveryDefaults {
				wire_policy:          WirePolicyId::from("wire"),
				extended_wire_policy: None,
				context:              ContextStrategy::Replay,
				thinking:             None,
				pricing:              Pricing::default(),
			}),
			provider.to_owned(),
			route.to_owned(),
		)
	}
	#[test]
	fn discovery_request_page_bound_is_enforced_before_backend_execution() {
		let normalizer = DiscoveryNormalizer::new(DiscoveryDefaults {
			wire_policy: WirePolicyId::from("wire"),

			extended_wire_policy: None,
			context:              ContextStrategy::Replay,
			thinking:             None,
			pricing:              Pricing::default(),
		});
		let service = DiscoveryService::new((), normalizer, NonZeroU32::new(100).expect("non-zero"));
		assert!(
			service
				.prepare(&DiscoveryRequest {
					provider:  None,
					route:     None,
					cursor:    Some("next".into()),
					page_size: 1_000,
					operation: None,
				})
				.is_err()
		);
		let prepared = service
			.prepare(&DiscoveryRequest {
				provider:  None,
				route:     None,
				cursor:    Some("next".into()),
				page_size: 100,
				operation: None,
			})
			.expect("bounded request");
		assert_eq!(prepared.page_size, 100);
		assert!(
			service
				.prepare(&DiscoveryRequest {
					provider:  None,
					route:     None,
					cursor:    None,
					page_size: 0,
					operation: None,
				})
				.is_err()
		);
	}

	#[test]
	fn provider_rows_are_normalized_and_capability_filtered() {
		let normalizer = DiscoveryNormalizer::new(DiscoveryDefaults {
			wire_policy:          WirePolicyId::from("wire"),
			extended_wire_policy: None,
			context:              ContextStrategy::Replay,
			thinking:             None,
			pricing:              Pricing::default(),
		});
		let provider = ProviderId::from("provider");
		let route = RouteId::from("route");
		let mut operations = OperationBits::empty();
		operations.insert_kind(OperationKind::Embed);
		let page = normalize_page(
			&normalizer,
			&provider,
			&route,
			&DiscoveryRequest {
				provider:  Some(provider.clone()),
				route:     Some(route.clone()),
				cursor:    None,
				page_size: 10,
				operation: Some(OperationKind::Embed),
			},
			RawDiscoveryPage {
				models:      vec![DiscoveredModel {
					provider:              provider.clone(),
					route:                 route.clone(),
					wire_model:            WireModelId::from("embedding-model"),
					aliases:               Box::new([]),
					display_name:          None,
					declared_class:        None,
					declared_operations:   operations,
					declared_capabilities: None,
					declared_limits:       None,
					declared_pricing:      Box::new([]),
					extended_context_mode: None,
					availability:          None,
					source:                "oracle".into(),
					observed_at_ms:        Some(1),
					updated_at_ms:         None,
					deprecated:            None,
				}],
				next_cursor: Some("next".into()),
			},
		)
		.expect("normalized page");
		assert_eq!(page.models.len(), 1);
		assert!(
			page.models[0]
				.capabilities
				.operations
				.contains_kind(OperationKind::Embed)
		);
		assert_eq!(page.next_cursor.as_deref(), Some("next"));
	}

	#[test]
	fn catalog_projector_deduplicates_and_preserves_pagination_deterministically() {
		let provider = ProviderId::from("provider");
		let route = RouteId::from("route");
		let row = discovered(&provider, &route, "embedding-model");
		let request = DiscoveryRequest {
			provider:  Some(provider.clone()),
			route:     Some(route.clone()),
			cursor:    Some("page-1".into()),
			page_size: 2,
			operation: Some(OperationKind::Embed),
		};
		let projector = projector(&provider, &route);
		let first = projector
			.project(&request, vec![row.clone(), row.clone()], Some("page-2".into()))
			.expect("projected page");
		let replay = projector
			.project(&request, vec![row.clone(), row], Some("page-2".into()))
			.expect("deterministic replay");
		assert_eq!(first.models.len(), 1);
		assert_eq!(replay.models, first.models);
		assert_eq!(replay.next_cursor, first.next_cursor);
	}

	#[test]
	fn catalog_projector_rejects_scope_size_and_empty_cursor() {
		let provider = ProviderId::from("provider");
		let route = RouteId::from("route");
		let projector = projector(&provider, &route);
		let request = DiscoveryRequest {
			provider:  Some(provider.clone()),
			route:     Some(route.clone()),
			cursor:    None,
			page_size: 1,
			operation: None,
		};
		let valid = discovered(&provider, &route, "one");
		let wrong = discovered(ProviderId::from_ref("other"), &route, "wrong");
		assert!(projector.project(&request, vec![wrong], None).is_err());
		assert!(
			projector
				.project(&request, vec![valid.clone(), discovered(&provider, &route, "two")], None)
				.is_err()
		);
		assert!(
			projector
				.project(&request, vec![valid], Some("".into()))
				.is_err()
		);
	}

	#[test]
	fn mixed_projection_preserves_known_models_and_conservatively_normalizes_unknown_rows() {
		let provider = ProviderId::from("provider");
		let route = RouteId::from("route");
		let normalizer = DiscoveryNormalizer::new(DiscoveryDefaults {
			wire_policy:          WirePolicyId::from("wire"),
			extended_wire_policy: None,
			context:              ContextStrategy::Replay,
			thinking:             None,
			pricing:              Pricing::default(),
		});
		let known_row = discovered(&provider, &route, "known");
		let known = normalizer
			.normalize(&known_row)
			.expect("known fixture")
			.model;
		let mut allowlist = BTreeMap::new();
		allowlist.insert(WireModelId::from("known"), known.clone());
		let request = DiscoveryRequest {
			provider:  Some(provider.clone()),
			route:     Some(route.clone()),
			cursor:    None,
			page_size: 4,
			operation: None,
		};
		let page = project_mixed_page(
			&allowlist,
			None,
			None,
			None,
			&normalizer,
			&provider,
			&route,
			&request,
			vec![known_row.clone(), discovered(&provider, &route, "unknown"), known_row],
			Some("next".into()),
		)
		.expect("mixed page");
		assert_eq!(page.models.len(), 2);
		assert_eq!(page.models[0], known);
		assert_eq!(page.models[1].thinking, None);
		assert_eq!(page.models[1].pricing, Pricing::default());
		assert_eq!(page.next_cursor.as_deref(), Some("next"));
	}

	fn codex_fixture() -> (ProviderId, RouteId, DiscoveryNormalizer, BTreeMap<WireModelId, ModelSpec>)
	{
		let provider = ProviderId::from("openai-codex");
		let route = RouteId::from("openai-codex/primary");
		let normalizer = DiscoveryNormalizer::new(DiscoveryDefaults {
			wire_policy:          WirePolicyId::from("wire"),
			extended_wire_policy: None,
			context:              ContextStrategy::Replay,
			thinking:             None,
			pricing:              Pricing::default(),
		});
		// Canonical bundled plain SKU on its own per-model route, carrying the
		// enriched base-model metadata a conservative normalization would not
		// reconstruct.
		let plain_route = RouteId::from("route-luna");
		let mut plain = normalizer
			.normalize(&discovered(&provider, &plain_route, "gpt-5.6-luna"))
			.expect("plain fixture")
			.model;
		plain.key = ModelKey::from("openai-codex/gpt-5.6-luna");
		plain.limits.context_window = Some(1_000_000);
		let mut bundled = BTreeMap::new();
		bundled.insert(WireModelId::from("gpt-5.6-luna"), plain);
		(provider, route, normalizer, bundled)
	}

	#[test]
	fn codex_worker_slug_registers_plain_route_with_canonical_metadata() {
		let (provider, route, normalizer, bundled) = codex_fixture();
		let request = DiscoveryRequest {
			provider:  Some(provider.clone()),
			route:     Some(route.clone()),
			cursor:    None,
			page_size: 4,
			operation: None,
		};
		let page = project_mixed_page(
			&BTreeMap::new(),
			Some(&bundled),
			None,
			None,
			&normalizer,
			&provider,
			&route,
			&request,
			vec![discovered(&provider, &route, "gpt-5.6-luna-wm")],
			None,
		)
		.expect("worker page");
		assert_eq!(page.models.len(), 2, "worker and synthesized plain listings");
		let worker = &page.models[0];
		let plain = &page.models[1];
		assert_eq!(worker.key.as_str(), "openai-codex/gpt-5.6-luna-wm");
		assert_eq!(worker.wire_ids.as_ref(), &[(route, WireModelId::from("gpt-5.6-luna-wm"))]);
		assert_eq!(
			worker.limits.context_window,
			Some(1_000_000),
			"worker listing derives the context floor from the canonical plain slug"
		);
		assert_eq!(plain.key.as_str(), "openai-codex/gpt-5.6-luna");
		assert_eq!(plain.limits.context_window, Some(1_000_000));
		assert_eq!(worker.pricing, plain.pricing);
	}

	#[test]
	fn codex_advertised_plain_slug_wins_over_synthesized_clone() {
		let (provider, route, normalizer, bundled) = codex_fixture();
		let request = DiscoveryRequest {
			provider:  Some(provider.clone()),
			route:     Some(route.clone()),
			cursor:    None,
			page_size: 4,
			operation: None,
		};
		let page = project_mixed_page(
			&BTreeMap::new(),
			Some(&bundled),
			None,
			None,
			&normalizer,
			&provider,
			&route,
			&request,
			vec![
				discovered(&provider, &route, "gpt-5.6-luna"),
				discovered(&provider, &route, "gpt-5.6-luna-wm"),
			],
			None,
		)
		.expect("worker page");
		let keys: Vec<&str> = page.models.iter().map(|model| model.key.as_str()).collect();
		assert_eq!(keys, ["openai-codex/gpt-5.6-luna", "openai-codex/gpt-5.6-luna-wm"]);
		assert_eq!(
			page.models[0].limits.context_window,
			Some(1_000_000),
			"the advertised plain slug binds the bundled spec, not a conservative clone"
		);
	}

	#[test]
	fn codex_unknown_worker_slug_stays_verbatim() {
		let (provider, route, normalizer, bundled) = codex_fixture();
		let request = DiscoveryRequest {
			provider:  Some(provider.clone()),
			route:     Some(route.clone()),
			cursor:    None,
			page_size: 4,
			operation: None,
		};
		let page = project_mixed_page(
			&BTreeMap::new(),
			Some(&bundled),
			None,
			None,
			&normalizer,
			&provider,
			&route,
			&request,
			vec![discovered(&provider, &route, "gpt-6-nova-wm")],
			None,
		)
		.expect("unknown worker page");
		assert_eq!(page.models.len(), 1, "no plain counterpart is synthesized");
		assert_eq!(page.models[0].limits.context_window, None);
		assert!(!page.models[0].key.as_str().ends_with("-wm/gpt-6-nova"));
	}

	fn gmi_fixture() -> (ProviderId, RouteId, DiscoveryNormalizer, BTreeMap<Str, ModelSpec>) {
		let provider = ProviderId::from("gmi-cloud");
		let route = RouteId::from("gmi-cloud/primary");
		let normalizer = DiscoveryNormalizer::new(DiscoveryDefaults {
			wire_policy:          WirePolicyId::from("wire"),
			extended_wire_policy: None,
			context:              ContextStrategy::Replay,
			thinking:             None,
			pricing:              Pricing::default(),
		});
		// Canonical reference bundled by another provider under the same
		// namespaced open-weight identity, carrying limits, thinking, and a
		// tariff that must never transfer.
		let reference_provider = ProviderId::from("huggingface");
		let reference_route = RouteId::from("huggingface/primary");
		let mut canonical = normalizer
			.normalize(&discovered(
				&reference_provider,
				&reference_route,
				"deepseek-ai/DeepSeek-V4-Pro",
			))
			.expect("canonical fixture")
			.model;
		canonical.key = ModelKey::from("huggingface/deepseek-ai/DeepSeek-V4-Pro");
		canonical.display_name = "DeepSeek V4 Pro".into();
		canonical.limits.context_window = Some(1_000_000);
		canonical.limits.maximum_output_tokens = Some(384_000);
		canonical.thinking = Some(ThinkingPolicyId::from("thinking-deepseek-v4"));
		canonical.pricing = Pricing::new(
			vec![Price { unit: PriceUnit::MtokInput, nanos_usd: 280_000_000 }],
			Vec::new(),
		)
		.expect("valid canonical pricing");
		let mut index = BTreeMap::new();
		index.insert(sf!("deepseek-ai/deepseek-v4-pro"), canonical);
		(provider, route, normalizer, index)
	}

	#[test]
	fn gmi_bare_row_recovers_canonical_params_but_never_pricing() {
		// GMI's /v1/models returns bare {id} rows for open-weight models it resells
		// under canonical ids; intrinsic parameters come
		// from the bundled canonical reference index, the tariff never does.
		let (provider, route, normalizer, canonical) = gmi_fixture();
		let request = DiscoveryRequest {
			provider:  Some(provider.clone()),
			route:     Some(route.clone()),
			cursor:    None,
			page_size: 4,
			operation: None,
		};
		let page = project_mixed_page(
			&BTreeMap::new(),
			None,
			Some(&canonical),
			None,
			&normalizer,
			&provider,
			&route,
			&request,
			vec![discovered(&provider, &route, "deepseek-ai/DeepSeek-V4-Pro")],
			None,
		)
		.expect("recovered page");
		assert_eq!(page.models.len(), 1);
		let model = &page.models[0];
		assert_eq!(model.key.as_str(), "deepseek-ai/DeepSeek-V4-Pro");
		assert_eq!(model.display_name.as_str(), "DeepSeek V4 Pro");
		assert_eq!(model.limits.context_window, Some(1_000_000));
		assert_eq!(model.limits.maximum_output_tokens, Some(384_000));
		assert_eq!(
			model.thinking.as_ref().map(|id| id.as_str()),
			Some("thinking-deepseek-v4"),
			"reasoning ladder is recovered from the canonical reference"
		);
		assert_eq!(model.pricing, Pricing::default(), "tariffs never cross providers");
		assert_eq!(model.wire_ids.as_ref(), &[(
			route.clone(),
			WireModelId::from("deepseek-ai/DeepSeek-V4-Pro")
		)]);
		assert_eq!(
			model.routes.as_ref(),
			std::slice::from_ref(&route),
			"discovery route binding is kept"
		);
	}

	#[test]
	fn gmi_declared_evidence_outranks_the_canonical_reference() {
		let (provider, route, normalizer, canonical) = gmi_fixture();
		let mut row = discovered(&provider, &route, "deepseek-ai/DeepSeek-V4-Pro");
		row.display_name = Some("GMI DeepSeek".into());
		row.declared_limits = Some(ModelLimits {
			context_window:        Some(131_072),
			maximum_input_tokens:  None,
			maximum_output_tokens: Some(8_192),
			maximum_batch:         None,
		});
		let request = DiscoveryRequest {
			provider:  Some(provider.clone()),
			route:     Some(route.clone()),
			cursor:    None,
			page_size: 4,
			operation: None,
		};
		let page = project_mixed_page(
			&BTreeMap::new(),
			None,
			Some(&canonical),
			None,
			&normalizer,
			&provider,
			&route,
			&request,
			vec![row],
			None,
		)
		.expect("declared page");
		let model = &page.models[0];
		assert_eq!(model.display_name.as_str(), "GMI DeepSeek");
		assert_eq!(model.limits.context_window, Some(131_072));
		assert_eq!(model.limits.maximum_output_tokens, Some(8_192));
	}

	#[test]
	fn bare_generic_slugs_never_inherit_a_canonical_card() {
		let (provider, route, normalizer, mut canonical) = gmi_fixture();
		let stray = canonical
			.get("deepseek-ai/deepseek-v4-pro")
			.expect("fixture entry")
			.clone();
		canonical.insert(sf!("deepseek-v4"), stray);
		let request = DiscoveryRequest {
			provider:  Some(provider.clone()),
			route:     Some(route.clone()),
			cursor:    None,
			page_size: 4,
			operation: None,
		};
		let page = project_mixed_page(
			&BTreeMap::new(),
			None,
			Some(&canonical),
			None,
			&normalizer,
			&provider,
			&route,
			&request,
			vec![discovered(&provider, &route, "deepseek-v4")],
			None,
		)
		.expect("conservative page");
		let model = &page.models[0];
		assert_eq!(model.limits.context_window, None, "bare slugs stay conservative");
		assert_eq!(model.thinking, None);
	}

	#[test]
	fn gmi_cloud_route_wires_canonical_recovery_from_the_embedded_catalog() {
		// The bundled taxonomy declares gmi-cloud's canonical-parameter recovery,
		// so the route projector recovers
		// intrinsic params for a bare discovered open-weight row from another
		// provider's bundled card (never its tariff), while the provider's own
		// bundled seed keeps its full card — including GMI's published prices —
		// even though it lives on a per-model route.
		use crate::catalog::snapshot::Catalog;
		let catalog = Catalog::embedded();
		let route = catalog
			.route(RouteId::from_ref("gmi-cloud/primary"))
			.expect("gmi-cloud primary route is bundled");
		let projector =
			CatalogDiscoveryProjector::for_route(catalog, route).expect("gmi-cloud projector");
		let provider = ProviderId::from("gmi-cloud");
		let request = DiscoveryRequest {
			provider:  Some(provider.clone()),
			route:     Some(route.id.clone()),
			cursor:    None,
			page_size: 4,
			operation: None,
		};
		let page = projector
			.project(
				&request,
				vec![
					discovered(&provider, &route.id, "deepseek-ai/DeepSeek-V4-Pro"),
					discovered(&provider, &route.id, "deepseek-ai/DeepSeek-V4-Flash"),
				],
				None,
			)
			.expect("gmi discovery page");
		let pro = page
			.models
			.iter()
			.find(|model| model.key.as_str().ends_with("DeepSeek-V4-Pro"))
			.expect("recovered V4-Pro listing");
		assert!(pro.limits.context_window.is_some(), "context window recovered");
		assert!(pro.limits.maximum_output_tokens.is_some(), "output limit recovered");
		assert!(pro.thinking.is_some(), "thinking ladder recovered from the canonical card");
		assert_eq!(pro.pricing, Pricing::default(), "tariffs never cross providers");
		assert_eq!(pro.routes.as_ref(), std::slice::from_ref(&route.id), "discovery route binding");
		let flash = page
			.models
			.iter()
			.find(|model| model.key.as_str().ends_with("DeepSeek-V4-Flash"))
			.expect("seeded V4-Flash listing");
		assert_ne!(flash.pricing, Pricing::default(), "the provider's own seed keeps its tariff");
		assert!(flash.thinking.is_some(), "the provider's own seed keeps its thinking policy");
	}

	fn hint_request(provider: &ProviderId<str>, route: &RouteId<str>) -> DiscoveryRequest {
		DiscoveryRequest {
			provider:  Some(provider.to_owned()),
			route:     Some(route.to_owned()),
			cursor:    None,
			page_size: 8,
			operation: None,
		}
	}

	#[test]
	fn hinted_gateway_first_ids_materialize_on_the_responses_route() {
		// The OpenCode gateways ship models before any census bundles them. An
		// unbundled id whose sibling-bundled spec — or
		// billing-variant base — rides openai-responses must rebind to the
		// provider's responses route; everything else keeps the discovery
		// route.
		let provider = ProviderId::from("opencode-go");
		let route = RouteId::from("opencode-go/primary");
		let target = RouteId::from("opencode-go/responses");
		let hints = ResponsesRouteHints {
			wire_ids: Arc::new(BTreeSet::from([
				WireModelId::from("muse-spark-1.2"),
				WireModelId::from("gpt-5.5"),
			])),
			target:   target.clone(),
		};
		let normalizer = DiscoveryNormalizer::new(DiscoveryDefaults {
			wire_policy:          WirePolicyId::from("wire"),
			extended_wire_policy: None,
			context:              ContextStrategy::Replay,
			thinking:             None,
			pricing:              Pricing::default(),
		});
		let canonical = Catalog::embedded()
			.model(ModelKey::from_ref("meta/muse-spark-1.2-contributor"))
			.expect("canonical Muse contributor")
			.clone();
		let canonical_bundled =
			BTreeMap::from([(Str::new_static("muse-spark-1.2-contributor"), canonical)]);
		let page = project_mixed_page(
			&BTreeMap::new(),
			None,
			Some(&canonical_bundled),
			Some(&hints),
			&normalizer,
			&provider,
			&route,
			&hint_request(&provider, &route),
			vec![
				// Sibling gateway bundles the exact id on responses.
				discovered(&provider, &route, "gpt-5.5"),
				// Billing-variant base is hinted (bundled taxonomy suffix).
				discovered(&provider, &route, "muse-spark-1.2-contributor"),
				// Anthropic-only sibling ids are never in the hint set.
				discovered(&provider, &route, "minimax-m2.5"),
				// No signal anywhere: the discovery route stays.
				discovered(&provider, &route, "brand-new-model"),
			],
			None,
		)
		.expect("hinted page");
		let routes_of = |wire: &str| -> Box<[RouteId]> {
			page
				.models
				.iter()
				.find(|model| {
					model
						.wire_ids
						.iter()
						.any(|(_, wire_model)| wire_model.as_str() == wire)
				})
				.unwrap_or_else(|| panic!("{wire} listing"))
				.routes
				.clone()
		};
		assert_eq!(routes_of("gpt-5.5").as_ref(), std::slice::from_ref(&target));
		assert_eq!(routes_of("muse-spark-1.2-contributor").as_ref(), std::slice::from_ref(&target));
		assert_eq!(routes_of("minimax-m2.5").as_ref(), std::slice::from_ref(&route));
		assert_eq!(routes_of("brand-new-model").as_ref(), std::slice::from_ref(&route));
		let contributor = page
			.models
			.iter()
			.find(|model| model.key.as_str().ends_with("muse-spark-1.2-contributor"))
			.expect("contributor listing");
		assert_eq!(
			contributor.wire_ids.as_ref(),
			&[(target, WireModelId::from("muse-spark-1.2-contributor"))],
			"the wire identity follows the rebound route"
		);
		assert_eq!(contributor.pricing, Pricing::default(), "pricing never follows the hint");
		assert_eq!(contributor.limits.context_window, Some(1_048_576));
		assert_eq!(contributor.limits.maximum_output_tokens, Some(131_072));
		assert!(contributor.thinking.is_some(), "canonical thinking ladder recovered");
	}

	#[test]
	fn opencode_go_muse_discovery_recovers_intrinsic_parameters() {
		let catalog = Catalog::embedded();
		let route = catalog
			.route(RouteId::from_ref("opencode-go/primary"))
			.expect("Go discovery route is bundled");
		let projector = CatalogDiscoveryProjector::for_route(catalog, route).expect("Go projector");
		let provider = ProviderId::from("opencode-go");
		let page = projector
			.project(
				&hint_request(&provider, &route.id),
				vec![
					discovered(&provider, &route.id, "muse-spark-1.2"),
					discovered(&provider, &route.id, "muse-spark-1.2-contributor"),
				],
				None,
			)
			.expect("Muse discovery page");
		assert_eq!(page.models.len(), 2);
		for model in &page.models {
			assert_eq!(model.limits.context_window, Some(1_048_576));
			assert_eq!(model.limits.maximum_output_tokens, Some(131_072));
			assert!(model.thinking.is_some(), "{} thinking ladder", model.key);
			assert_eq!(
				model.routes.as_ref(),
				std::slice::from_ref(&route.id),
				"{} Responses route",
				model.key
			);
		}
	}

	#[test]
	fn opencode_zen_gateway_first_ids_ride_the_hinted_responses_route() {
		// The bundled taxonomy declares the OpenCode gateway group, and opencode-zen's
		// discovery route is its anthropic
		// primary — exactly where an unhinted gateway-first responses model
		// would break every turn.
		use crate::catalog::snapshot::Catalog;
		let catalog = Catalog::embedded();
		let route = catalog
			.route(RouteId::from_ref("opencode-zen/primary"))
			.expect("zen primary route is bundled");
		assert_eq!(route.codec.as_str(), "anthropic", "zen discovery route is the anthropic primary");
		let projector = CatalogDiscoveryProjector::for_route(catalog, route).expect("zen projector");
		let provider = ProviderId::from("opencode-zen");
		let page = projector
			.project(
				&hint_request(&provider, &route.id),
				vec![
					// Billing variant of zen's own bundled responses SKU.
					discovered(&provider, &route.id, "gpt-5.5-pro-free"),
					// Bundled chat SKU off the discovery route keeps its card.
					discovered(&provider, &route.id, "deepseek-v4-pro"),
					// No bundled signal on either gateway: stays conservative.
					discovered(&provider, &route.id, "muse-spark-1.3"),
				],
				None,
			)
			.expect("zen discovery page");
		let find = |suffix: &str| -> &ModelSpec {
			page
				.models
				.iter()
				.find(|model| {
					model
						.wire_ids
						.iter()
						.any(|(_, wire_model)| wire_model.as_str() == suffix)
				})
				.unwrap_or_else(|| panic!("{suffix} listing"))
		};
		let free = find("gpt-5.5-pro-free");
		let free_route = free.routes.first().expect("rebound route");
		assert_ne!(free_route, &route.id, "hinted id leaves the anthropic discovery route");
		assert_eq!(
			catalog
				.route(free_route)
				.expect("rebound route is bundled")
				.codec
				.as_str(),
			"openai-responses"
		);
		let bundled = find("deepseek-v4-pro");
		assert_ne!(
			bundled.pricing,
			Pricing::default(),
			"the provider's own bundled card wins even off the discovery route"
		);
		let unknown = find("muse-spark-1.3");
		assert_eq!(
			unknown.routes.as_ref(),
			std::slice::from_ref(&route.id),
			"no bundled signal on either gateway keeps the discovery route"
		);
	}
}
