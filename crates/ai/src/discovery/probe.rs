//! Active model-discovery probing over an injected HTTP boundary.

use std::{collections::BTreeMap, future::Future, mem, pin::Pin, time::Duration};

use bytes::Bytes;
use futures::{StreamExt as _, stream};
use omp_catalog::{
	Availability, DiscoveredModel, ModalityBits, ModelAvailability, ModelLimits, OperationBits,
	OperationKind, Price, PriceUnit, ProviderId, ReasoningCapabilities, ReasoningFeatureBits,
	RouteId, WireModelId,
};
use omp_core::{Str, sf};
use tokio_util::sync::CancellationToken;
use url::Url;

use super::endpoints::{DiscoveryEndpoint, DiscoveryEndpointKind};

const DEFAULT_DISCOVERY_CONTEXT_WINDOW: u64 = 128_000;
const DEFAULT_DISCOVERY_MAX_OUTPUT: u64 = 32_768;
const DEFAULT_ANTHROPIC_PROXY_MAX_OUTPUT: u64 = 8_192;

/// One bounded HTTP probe request.
#[derive(Clone, Eq, PartialEq)]
pub struct ProbeHttpRequest {
	/// HTTP method.
	pub method:   http::Method,
	/// Absolute URL.
	pub url:      Str,
	/// Secret-bearing request headers; diagnostics expose names only.
	pub headers:  http::HeaderMap,
	/// JSON request body for metadata probes.
	pub body:     Bytes,
	/// Endpoint-class deadline.
	pub deadline: Duration,
}

impl std::fmt::Debug for ProbeHttpRequest {
	fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		formatter
			.debug_struct("ProbeHttpRequest")
			.field("method", &self.method)
			.field("url", &redacted_request_url(&self.url))
			.field("header_names", &self.headers.keys().collect::<Vec<_>>())
			.field("body_bytes", &self.body.len())
			.field("deadline", &self.deadline)
			.finish()
	}
}

/// Cold injected HTTP future for endpoint discovery.
pub type ProbeHttpFuture =
	Pin<Box<dyn Future<Output = Result<Bytes, ProbeError>> + Send + 'static>>;

/// Injected HTTP transport used by active discovery.
pub trait DiscoveryHttpClient: Send + Sync + 'static {
	/// Executes one bounded request. Implementations must not follow
	/// cross-origin redirects with credentials.
	fn request(&self, request: ProbeHttpRequest, cancellation: CancellationToken)
	-> ProbeHttpFuture;
}

/// Routes used by a dual-protocol proxy listing.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProxyDiscoveryRoutes {
	/// Route using the OpenAI-compatible chat codec.
	pub openai:    RouteId,
	/// Route using the Anthropic Messages codec.
	pub anthropic: RouteId,
}

/// Active endpoint probe bound to one provider route.
#[derive(Clone)]
pub struct DiscoveryProbe {
	/// Commercial/local provider identity.
	pub provider:     ProviderId,
	/// Default route on which discovered wire model ids are valid.
	pub route:        RouteId,
	/// Per-wire routes for a dual-protocol proxy.
	pub proxy_routes: Option<ProxyDiscoveryRoutes>,
	/// Request headers resolved by the host credential authority.
	pub headers:      http::HeaderMap,
	/// Typed endpoint.
	pub endpoint:     DiscoveryEndpoint,
}

impl std::fmt::Debug for DiscoveryProbe {
	fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		formatter
			.debug_struct("DiscoveryProbe")
			.field("provider", &self.provider)
			.field("route", &self.route)
			.field("proxy_routes", &self.proxy_routes)
			.field("header_names", &self.headers.keys().collect::<Vec<_>>())
			.field("endpoint", &self.endpoint)
			.finish()
	}
}

impl DiscoveryProbe {
	/// Re-probes one selected model against its native discovery endpoint.
	///
	/// Local runtimes expose load-sensitive limits only after selection or JIT
	/// load. LM Studio's native row prefers `loaded_context_length` while
	/// loaded and falls back to `max_context_length` after unload.
	pub async fn probe_model(
		&self,
		wire_model: &WireModelId<str>,
		client: &dyn DiscoveryHttpClient,
		cancellation: CancellationToken,
	) -> Result<Option<DiscoveredModel>, ProbeError> {
		if self.endpoint.kind != DiscoveryEndpointKind::Ollama {
			return Ok(self
				.probe(client, cancellation)
				.await?
				.into_iter()
				.find(|model| *model.wire_model == *wire_model));
		}
		tokio::time::timeout(self.complete_deadline(), async {
			let payload = self
				.request(client, http::Method::GET, "/api/tags", Bytes::new(), cancellation.clone())
				.await?;
			let mut row = self
				.decode_models(&payload, "/api/tags")?
				.into_iter()
				.find(|model| *model.wire_model == *wire_model);
			if let Some(row) = &mut row {
				let body = serde_json::to_vec(&serde_json::json!({"model": wire_model.as_str()}))
					.map(Bytes::from)
					.map_err(|_| ProbeError::Protocol)?;
				if let Ok(Ok(show)) = tokio::time::timeout(
					self.metadata_deadline(),
					self.request(client, http::Method::POST, "/api/show", body, cancellation),
				)
				.await
				{
					let _ = apply_ollama_show(row, &show);
				}
			}
			Ok(row)
		})
		.await
		.map_err(|_| ProbeError::Timeout)?
	}

	/// Probes the endpoint family and returns normalized, secret-free rows.
	///
	/// The deadline covers the complete multi-request probe, not each request
	/// independently, so metadata fan-out cannot multiply startup latency.
	pub async fn probe(
		&self,
		client: &dyn DiscoveryHttpClient,
		cancellation: CancellationToken,
	) -> Result<Vec<DiscoveredModel>, ProbeError> {
		tokio::time::timeout(
			self.complete_deadline(),
			self.probe_within_deadline(client, cancellation),
		)
		.await
		.map_err(|_| ProbeError::Timeout)?
	}

	async fn probe_within_deadline(
		&self,
		client: &dyn DiscoveryHttpClient,
		cancellation: CancellationToken,
	) -> Result<Vec<DiscoveredModel>, ProbeError> {
		if self.endpoint.kind == DiscoveryEndpointKind::LiteLlm {
			return self.probe_litellm(client, cancellation).await;
		}
		if self.endpoint.kind == DiscoveryEndpointKind::LlamaCpp {
			let (payload, props) = tokio::join!(
				self.request(client, http::Method::GET, "/models", Bytes::new(), cancellation.clone(),),
				self.request(client, http::Method::GET, "/props", Bytes::new(), cancellation,),
			);
			let mut rows = self.decode_models(&payload?, "/models")?;
			if let Ok(props) = props {
				let _ = apply_llama_props(&mut rows, &props);
			}
			return Ok(dedupe_models(rows));
		}
		let path = match self.endpoint.kind {
			DiscoveryEndpointKind::Ollama => "/api/tags",
			DiscoveryEndpointKind::LlamaCpp => unreachable!("llama.cpp returned above"),
			DiscoveryEndpointKind::LmStudio => "/api/v0/models",
			DiscoveryEndpointKind::OpenAi if self.endpoint.inject_openai_v1 => "/v1/models",
			DiscoveryEndpointKind::OpenAi => "/models",
			DiscoveryEndpointKind::Proxy => "/v1/models",
			DiscoveryEndpointKind::LiteLlm => unreachable!("LiteLLM has a rich probe path"),
		};
		let payload = self
			.request(client, http::Method::GET, path, Bytes::new(), cancellation.clone())
			.await?;
		let mut rows = self.decode_models(&payload, path)?;
		match self.endpoint.kind {
			DiscoveryEndpointKind::Ollama => {
				let shows = stream::iter((0..rows.len()).map(|index| {
					let model = rows[index].wire_model.clone();
					let cancellation = cancellation.clone();
					async move {
						let body = serde_json::to_vec(&serde_json::json!({"model": model.as_str()}))
							.map(Bytes::from)
							.map_err(|_| ProbeError::Protocol)?;
						Ok::<_, ProbeError>((
							index,
							tokio::time::timeout(
								self.metadata_deadline(),
								self.request(client, http::Method::POST, "/api/show", body, cancellation),
							)
							.await
							.map_err(|_| ProbeError::Timeout)
							.and_then(|result| result),
						))
					}
				}))
				.buffer_unordered(8)
				.collect::<Vec<_>>()
				.await;
				for show in shows {
					let (index, show) = show?;
					if let Ok(show) = show {
						let _ = apply_ollama_show(&mut rows[index], &show);
					}
				}
			},
			DiscoveryEndpointKind::LlamaCpp => unreachable!("llama.cpp returned above"),
			DiscoveryEndpointKind::LmStudio
			| DiscoveryEndpointKind::OpenAi
			| DiscoveryEndpointKind::Proxy => {},
			DiscoveryEndpointKind::LiteLlm => unreachable!("LiteLLM returned above"),
		}
		Ok(dedupe_models(rows))
	}

	fn metadata_deadline(&self) -> Duration {
		self.endpoint.deadline().min(Duration::from_millis(150))
	}

	fn complete_deadline(&self) -> Duration {
		if self.endpoint.kind == DiscoveryEndpointKind::Ollama {
			self
				.endpoint
				.deadline()
				.saturating_add(self.metadata_deadline())
		} else {
			self.endpoint.deadline()
		}
	}

	async fn probe_litellm(
		&self,
		client: &dyn DiscoveryHttpClient,
		cancellation: CancellationToken,
	) -> Result<Vec<DiscoveredModel>, ProbeError> {
		let mut merged = BTreeMap::<WireModelId, (DiscoveredModel, LiteLlmRouteEvidence)>::new();
		for path in ["/model_group/info", "/v2/model/info", "/model/info", "/v1/model/info"] {
			let Ok(payload) = self
				.request(client, http::Method::GET, path, Bytes::new(), cancellation.clone())
				.await
			else {
				continue;
			};
			let Ok(entries) = decode_json_rows(&payload) else {
				continue;
			};
			let had_prior_models = !merged.is_empty();
			for value in &entries {
				let Some(id) = litellm_public_id(value) else {
					continue;
				};
				let evidence = classify_litellm_route(Some(value), id);
				let next = self.decode_model(value, id, path, route_for_evidence(self, evidence));
				let key = next.wire_model.clone();
				if let Some((existing, held)) = merged.get_mut(&key) {
					merge_discovered_model(existing, next);
					*held = held.merge(evidence);
					existing.route = route_for_evidence(self, *held);
				} else if !had_prior_models {
					merged.insert(key, (next, evidence));
				}
			}
			if !merged.is_empty()
				&& merged.values().all(|(model, evidence)| {
					*evidence != LiteLlmRouteEvidence::Unknown
						&& !litellm_pricing_is_partial(&model.declared_pricing)
				}) {
				break;
			}
		}
		if !merged.is_empty() {
			return Ok(merged.into_values().map(|(model, _)| model).collect());
		}
		let path = "/v1/models";
		let payload = self
			.request(client, http::Method::GET, path, Bytes::new(), cancellation)
			.await?;
		let entries = decode_json_rows(&payload)?;
		Ok(dedupe_models(
			entries
				.iter()
				.filter_map(|value| {
					let id = litellm_public_id(value)?;
					let evidence = classify_litellm_route(None, id);
					Some(self.decode_model(value, id, path, route_for_evidence(self, evidence)))
				})
				.collect(),
		))
	}

	async fn request(
		&self,
		client: &dyn DiscoveryHttpClient,
		method: http::Method,
		path: &str,
		body: Bytes,
		cancellation: CancellationToken,
	) -> Result<Bytes, ProbeError> {
		let url = discovery_url(&self.endpoint, path)?;
		let deadline = self.endpoint.deadline();
		let mut headers = self.headers.clone();
		if !body.is_empty() && !headers.contains_key(http::header::CONTENT_TYPE) {
			headers
				.insert(http::header::CONTENT_TYPE, http::HeaderValue::from_static("application/json"));
		}
		let request = ProbeHttpRequest { method, url, headers, body, deadline };
		let request_cancellation = cancellation.clone();
		tokio::select! {
			() = cancellation.cancelled() => Err(ProbeError::Cancelled),
			result = tokio::time::timeout(
				deadline,
				client.request(request, request_cancellation),
			) => {
				result.map_err(|_| ProbeError::Timeout)?
			},
		}
	}

	fn decode_models(
		&self,
		payload: &[u8],
		source_path: &str,
	) -> Result<Vec<DiscoveredModel>, ProbeError> {
		let rows = decode_json_rows(payload)?;
		let mut discovered = Vec::with_capacity(rows.len());
		for value in rows {
			let id = if self.endpoint.kind == DiscoveryEndpointKind::Ollama {
				value.get("model").or_else(|| value.get("name"))
			} else {
				value
					.get("id")
					.or_else(|| value.get("name"))
					.or_else(|| value.get("model"))
					.or_else(|| value.get("model_group"))
					.or_else(|| value.get("model_name"))
			}
			.and_then(serde_json::Value::as_str)
			.ok_or(ProbeError::Protocol)?;
			if id.trim().is_empty() {
				return Err(ProbeError::Protocol);
			}
			let route = if self.endpoint.kind == DiscoveryEndpointKind::Proxy {
				self.proxy_route(&value)
			} else {
				self.route.clone()
			};
			discovered.push(self.decode_model(&value, id, source_path, route));
		}
		Ok(dedupe_models(discovered))
	}

	fn decode_model(
		&self,
		value: &serde_json::Value,
		id: &str,
		source_path: &str,
		route: RouteId,
	) -> DiscoveredModel {
		let context = if self.endpoint.kind == DiscoveryEndpointKind::LmStudio
			&& value.get("state").and_then(serde_json::Value::as_str) == Some("loaded")
		{
			positive_u64(value, &["loaded_context_length"])
				.or_else(|| positive_u64(value, &["max_context_length", "context_length"]))
		} else if self.endpoint.kind == DiscoveryEndpointKind::LlamaCpp {
			llama_model_context_window(value)
				.or_else(|| positive_u64(value, &["context_length", "max_context_length"]))
		} else {
			positive_u64(value, &[
				"context_length",
				"contextWindow",
				"max_context_length",
				"max_model_len",
				"max_input_tokens",
			])
			.or_else(|| nested_positive_u64(value, "model_info", &["max_input_tokens"]))
		};
		let context = context.unwrap_or(DEFAULT_DISCOVERY_CONTEXT_WINDOW);
		let anthropic_proxy = self.endpoint.kind == DiscoveryEndpointKind::Proxy
			&& self
				.proxy_routes
				.as_ref()
				.is_some_and(|routes| routes.anthropic == route);
		let default_output = if anthropic_proxy {
			DEFAULT_ANTHROPIC_PROXY_MAX_OUTPUT
		} else {
			DEFAULT_DISCOVERY_MAX_OUTPUT
		};
		let output = positive_u64(value, &["max_output_tokens", "maxTokens"])
			.or_else(|| nested_positive_u64(value, "model_info", &["max_output_tokens"]))
			.unwrap_or(default_output)
			.min(context);
		let limits = Some(ModelLimits {
			context_window:        Some(context),
			maximum_input_tokens:  None,
			maximum_output_tokens: Some(output),
			maximum_batch:         None,
		});
		let mut operations = OperationBits::empty();
		operations.insert_kind(OperationKind::Chat);
		let declared_capabilities = discovered_capabilities(value, self.endpoint.kind);
		let declared_pricing = if self.endpoint.kind == DiscoveryEndpointKind::LiteLlm {
			litellm_reported_prices(value)
		} else {
			Box::new([])
		};
		DiscoveredModel {
			provider: self.provider.clone(),
			route,
			wire_model: WireModelId::from(id),
			aliases: Box::new([]),
			display_name: value
				.get("display_name")
				.or_else(|| value.get("displayName"))
				.or_else(|| value.get("name"))
				.and_then(serde_json::Value::as_str)
				.filter(|name| *name != id)
				.map(Str::new),
			declared_class: None,
			declared_operations: operations,
			declared_capabilities,
			declared_limits: limits,
			declared_pricing,
			extended_context_mode: None,
			availability: Some(ModelAvailability::Available),
			source: sf!("{}:{}{source_path}", self.endpoint.kind, self.endpoint.redacted_label()),
			observed_at_ms: None,
			updated_at_ms: None,
			deprecated: None,
		}
	}

	fn proxy_route(&self, value: &serde_json::Value) -> RouteId {
		let Some(routes) = &self.proxy_routes else {
			return self.route.clone();
		};
		let endpoints = value
			.get("supported_endpoint_types")
			.and_then(serde_json::Value::as_array);
		if endpoints.is_some_and(|endpoints| {
			endpoints
				.iter()
				.filter_map(serde_json::Value::as_str)
				.any(|endpoint| endpoint.eq_ignore_ascii_case("anthropic"))
		}) {
			routes.anthropic.clone()
		} else if endpoints.is_some_and(|endpoints| {
			endpoints
				.iter()
				.filter_map(serde_json::Value::as_str)
				.any(|endpoint| endpoint.eq_ignore_ascii_case("openai"))
		}) {
			routes.openai.clone()
		} else {
			self.route.clone()
		}
	}
}

fn redacted_request_url(url: &str) -> Str {
	let Ok(mut url) = Url::parse(url) else {
		return Str::new_static("<invalid-endpoint>");
	};
	let _ = url.set_password(None);
	let _ = url.set_username("");
	url.set_path("/");
	url.set_query(None);
	url.set_fragment(None);
	Str::new(url.as_str())
}

fn discovery_url(endpoint: &DiscoveryEndpoint, suffix: &str) -> Result<Str, ProbeError> {
	let mut url = Url::parse(endpoint.base_url.as_str()).map_err(|_| ProbeError::InvalidEndpoint)?;
	let mut path = url.path().trim_end_matches('/').to_owned();
	let native_root = matches!(
		endpoint.kind,
		DiscoveryEndpointKind::Ollama
			| DiscoveryEndpointKind::LlamaCpp
			| DiscoveryEndpointKind::LmStudio
	) || (endpoint.kind == DiscoveryEndpointKind::LiteLlm
		&& !suffix.starts_with("/v1/"));
	if native_root && path.ends_with("/v1") {
		path.truncate(path.len() - 3);
	}
	let suffix = if path.ends_with("/v1") {
		suffix.strip_prefix("/v1").unwrap_or(suffix)
	} else {
		suffix
	};
	path.push('/');
	path.push_str(suffix.trim_start_matches('/'));
	url.set_path(&path);
	url.set_fragment(None);
	Ok(Str::new(url.as_str()))
}

fn dedupe_models(rows: Vec<DiscoveredModel>) -> Vec<DiscoveredModel> {
	let mut merged = BTreeMap::<(RouteId, WireModelId), DiscoveredModel>::new();
	for row in rows {
		let key = (row.route.clone(), row.wire_model.clone());
		if let Some(existing) = merged.get_mut(&key) {
			merge_discovered_model(existing, row);
		} else {
			merged.insert(key, row);
		}
	}
	merged.into_values().collect()
}

fn discovered_capabilities(
	value: &serde_json::Value,
	kind: DiscoveryEndpointKind,
) -> Option<omp_catalog::ModelCapabilities> {
	let capabilities = value.get("capabilities");
	let capability_names = capabilities
		.and_then(serde_json::Value::as_array)
		.map(|values| {
			values
				.iter()
				.filter_map(serde_json::Value::as_str)
				.map(str::to_ascii_lowercase)
				.collect::<Vec<_>>()
		});
	let object = capabilities.and_then(serde_json::Value::as_object);
	let mut modalities = ModalityBits::TEXT;
	let mut has_modality_evidence = false;
	for candidate in [
		value.get("input"),
		value.get("input_modalities"),
		value
			.get("architecture")
			.and_then(|architecture| architecture.get("input_modalities")),
	] {
		if let Some(values) = candidate.and_then(serde_json::Value::as_array) {
			has_modality_evidence = true;
			if values
				.iter()
				.filter_map(serde_json::Value::as_str)
				.any(|value| {
					value.eq_ignore_ascii_case("image") || value.eq_ignore_ascii_case("vision")
				}) {
				modalities.insert(ModalityBits::IMAGE);
			}
		}
	}
	if capability_names.as_ref().is_some_and(|names| {
		names
			.iter()
			.any(|name| matches!(name.as_str(), "image" | "vision"))
	}) || object.is_some_and(|object| {
		object
			.get("image")
			.or_else(|| object.get("vision"))
			.and_then(serde_json::Value::as_bool)
			== Some(true)
	}) || value
		.get("supports_vision")
		.and_then(serde_json::Value::as_bool)
		== Some(true)
	{
		has_modality_evidence = true;
		modalities.insert(ModalityBits::IMAGE);
	}
	has_modality_evidence |= value.get("supports_vision").is_some();
	let has_reasoning_evidence =
		capability_names.is_some() || object.is_some() || value.get("supports_reasoning").is_some();
	let reasoning = capability_names.as_ref().is_some_and(|names| {
		names
			.iter()
			.any(|name| matches!(name.as_str(), "thinking" | "reasoning"))
	}) || object.is_some_and(|object| {
		object
			.get("thinking")
			.or_else(|| object.get("reasoning"))
			.and_then(serde_json::Value::as_bool)
			== Some(true)
	}) || value
		.get("supports_reasoning")
		.and_then(serde_json::Value::as_bool)
		== Some(true);
	if !has_modality_evidence
		&& !has_reasoning_evidence
		&& !matches!(kind, DiscoveryEndpointKind::Ollama | DiscoveryEndpointKind::LlamaCpp)
	{
		return None;
	}
	let mut model = omp_catalog::unknown_capabilities();
	model.operations.insert_kind(OperationKind::Chat);
	let chat = model
		.chat
		.get_or_insert_with(omp_catalog::unknown_chat_capabilities);
	if has_modality_evidence {
		chat.input_modalities = Availability::Native(modalities);
	}
	if has_reasoning_evidence {
		chat.reasoning = if reasoning {
			Availability::Native(ReasoningCapabilities {
				features:              ReasoningFeatureBits::VISIBLE,
				efforts:               Box::new([]),
				minimum_budget_tokens: None,
				maximum_budget_tokens: None,
			})
		} else {
			Availability::Unsupported
		};
	}
	Some(model)
}

fn llama_model_context_window(value: &serde_json::Value) -> Option<u64> {
	value
		.get("meta")
		.and_then(|meta| positive_u64(meta, &["n_ctx"]))
		.or_else(|| llama_configured_context_window(value))
		.or_else(|| {
			value
				.get("meta")
				.and_then(|meta| positive_u64(meta, &["n_ctx_train"]))
		})
}

fn llama_configured_context_window(value: &serde_json::Value) -> Option<u64> {
	let status = value.get("status")?;
	if let Some(arguments) = status.get("args").and_then(serde_json::Value::as_array) {
		for (index, argument) in arguments.iter().enumerate() {
			let Some(argument) = argument.as_str() else {
				continue;
			};
			let (flag, inline) = argument
				.split_once('=')
				.map_or((argument, None), |(flag, value)| (flag, Some(value)));
			if !matches!(flag, "--ctx-size" | "-c") {
				continue;
			}
			let value = inline
				.and_then(positive_u64_text)
				.or_else(|| arguments.get(index + 1).and_then(positive_u64_value));
			if value.is_some() {
				return value;
			}
		}
	}
	let preset = status.get("preset").and_then(serde_json::Value::as_str)?;
	for line in preset.lines() {
		let Some((key, value)) = line.split_once('=') else {
			continue;
		};
		if key.trim() == "ctx-size"
			&& let Some(value) = positive_u64_text(value)
		{
			return Some(value);
		}
	}
	None
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum LiteLlmRouteEvidence {
	OpenAi,
	Other,
	Unknown,
}

impl LiteLlmRouteEvidence {
	const fn merge(self, incoming: Self) -> Self {
		match (self, incoming) {
			(Self::Other, _) | (_, Self::Other) => Self::Other,
			(Self::OpenAi, _) | (_, Self::OpenAi) => Self::OpenAi,
			(Self::Unknown, Self::Unknown) => Self::Unknown,
		}
	}
}

fn decode_json_rows(payload: &[u8]) -> Result<Vec<serde_json::Value>, ProbeError> {
	let mut envelope: serde_json::Value =
		serde_json::from_slice(payload).map_err(|_| ProbeError::Protocol)?;
	take_json_rows(&mut envelope).ok_or(ProbeError::Protocol)
}

fn take_json_rows(envelope: &mut serde_json::Value) -> Option<Vec<serde_json::Value>> {
	if let serde_json::Value::Array(rows) = envelope {
		return Some(mem::take(rows));
	}
	for key in ["data", "models", "result", "items"] {
		if let Some(candidate) = envelope.get_mut(key)
			&& let Some(rows) = take_json_rows(candidate)
		{
			return Some(rows);
		}
	}
	None
}

fn litellm_public_id(value: &serde_json::Value) -> Option<&str> {
	value
		.get("model_group")
		.or_else(|| value.get("model_name"))
		.or_else(|| value.get("id"))
		.or_else(|| value.get("name"))
		.or_else(|| value.get("litellm_params")?.get("model"))
		.and_then(serde_json::Value::as_str)
		.map(str::trim)
		.filter(|id| !id.is_empty())
}

fn classify_litellm_route(value: Option<&serde_json::Value>, id: &str) -> LiteLlmRouteEvidence {
	if let Some(value) = value {
		if let Some(providers) = value.get("providers").and_then(serde_json::Value::as_array) {
			let mut saw_provider = false;
			let all_openai = providers
				.iter()
				.filter_map(serde_json::Value::as_str)
				.map(str::trim)
				.filter(|provider| !provider.is_empty())
				.all(|provider| {
					saw_provider = true;
					provider.eq_ignore_ascii_case("openai")
				});
			if saw_provider {
				return if all_openai {
					LiteLlmRouteEvidence::OpenAi
				} else {
					LiteLlmRouteEvidence::Other
				};
			}
		}
		if let Some(params) = value.get("litellm_params") {
			if let Some(provider) = params
				.get("custom_llm_provider")
				.and_then(serde_json::Value::as_str)
				.map(str::trim)
				.filter(|provider| !provider.is_empty())
			{
				return if provider.eq_ignore_ascii_case("openai") {
					LiteLlmRouteEvidence::OpenAi
				} else {
					LiteLlmRouteEvidence::Other
				};
			}
			if let Some(model) = params
				.get("model")
				.and_then(serde_json::Value::as_str)
				.map(str::trim)
				.filter(|model| !model.is_empty())
				&& let Some((provider, _)) = model.split_once('/')
			{
				return if provider.eq_ignore_ascii_case("openai") {
					LiteLlmRouteEvidence::OpenAi
				} else {
					LiteLlmRouteEvidence::Other
				};
			}
		}
		if let Some(base) = value
			.get("model_info")
			.and_then(|info| info.get("base_model"))
			.or_else(|| value.get("base_model"))
			.and_then(serde_json::Value::as_str)
			&& let Some((provider, _)) = base.trim().split_once('/')
		{
			return if provider.eq_ignore_ascii_case("openai") {
				LiteLlmRouteEvidence::OpenAi
			} else {
				LiteLlmRouteEvidence::Other
			};
		}
	}
	let normalized = id.trim().to_ascii_lowercase();
	if normalized.starts_with("openai/") {
		return LiteLlmRouteEvidence::OpenAi;
	}
	if omp_catalog::is_likely_openai_responses_id(&normalized) {
		LiteLlmRouteEvidence::OpenAi
	} else {
		LiteLlmRouteEvidence::Unknown
	}
}

fn route_for_evidence(probe: &DiscoveryProbe, evidence: LiteLlmRouteEvidence) -> RouteId {
	if evidence == LiteLlmRouteEvidence::OpenAi {
		RouteId::new(format!("{}/openai-responses", probe.provider.as_str()))
	} else {
		probe.route.clone()
	}
}

fn merge_discovered_model(existing: &mut DiscoveredModel, incoming: DiscoveredModel) {
	if incoming.display_name.is_some() {
		existing.display_name = incoming.display_name;
	}
	match (&mut existing.declared_capabilities, incoming.declared_capabilities) {
		(Some(existing), Some(incoming)) => merge_runtime_capabilities(existing, &incoming),
		(None, incoming @ Some(_)) => existing.declared_capabilities = incoming,
		_ => {},
	}
	match (&mut existing.declared_limits, incoming.declared_limits) {
		(Some(existing), Some(incoming)) => {
			if incoming.context_window.is_some() {
				existing.context_window = incoming.context_window;
			}
			if incoming.maximum_output_tokens.is_some() {
				existing.maximum_output_tokens = incoming.maximum_output_tokens;
			}
		},
		(None, limits @ Some(_)) => existing.declared_limits = limits,
		_ => {},
	}
	let mut pricing = existing.declared_pricing.to_vec();
	for incoming in incoming.declared_pricing {
		if let Some(existing) = pricing.iter_mut().find(|price| price.unit == incoming.unit) {
			*existing = incoming;
		} else {
			pricing.push(incoming);
		}
	}
	pricing.sort_unstable_by_key(|price| price.unit);
	existing.declared_pricing = pricing.into_boxed_slice();
	existing.source = incoming.source;
}

fn merge_runtime_capabilities(
	existing: &mut omp_catalog::ModelCapabilities,
	incoming: &omp_catalog::ModelCapabilities,
) {
	existing.operations.insert(incoming.operations);
	let Some(incoming) = &incoming.chat else {
		return;
	};
	let Some(existing) = &mut existing.chat else {
		existing.chat = Some(incoming.clone());
		return;
	};
	if existing.input_modalities.is_unknown() && !incoming.input_modalities.is_unknown() {
		existing.input_modalities = incoming.input_modalities.clone();
	}
	if existing.reasoning.is_unknown() && !incoming.reasoning.is_unknown() {
		existing.reasoning = incoming.reasoning.clone();
	}
}

fn litellm_reported_prices(value: &serde_json::Value) -> Box<[Price]> {
	[
		("input_cost_per_token", PriceUnit::MtokInput),
		("output_cost_per_token", PriceUnit::MtokOutput),
		("cache_read_input_token_cost", PriceUnit::MtokCacheRead),
		("cache_creation_input_token_cost", PriceUnit::MtokCacheWrite),
	]
	.into_iter()
	.filter_map(|(key, unit)| {
		let value = value
			.get(key)
			.filter(|value| !value.is_null())
			.or_else(|| {
				value
					.get("model_info")?
					.get(key)
					.filter(|value| !value.is_null())
			})?;
		let per_token = value
			.as_f64()
			.or_else(|| value.as_str()?.trim().parse::<f64>().ok())?;
		if !per_token.is_finite() || per_token <= 0.0 {
			return None;
		}
		let nanos_usd = (per_token * 1_000_000_000_000_000.0).round();
		(nanos_usd <= u64::MAX as f64).then_some(Price { unit, nanos_usd: nanos_usd as u64 })
	})
	.collect::<Vec<_>>()
	.into_boxed_slice()
}

fn litellm_pricing_is_partial(pricing: &[Price]) -> bool {
	!pricing.is_empty()
		&& [
			PriceUnit::MtokInput,
			PriceUnit::MtokOutput,
			PriceUnit::MtokCacheRead,
			PriceUnit::MtokCacheWrite,
		]
		.into_iter()
		.any(|unit| pricing.iter().all(|price| price.unit != unit))
}

fn nested_positive_u64(value: &serde_json::Value, object: &str, keys: &[&str]) -> Option<u64> {
	value
		.get(object)
		.and_then(|value| positive_u64(value, keys))
}

fn positive_u64(value: &serde_json::Value, keys: &[&str]) -> Option<u64> {
	keys
		.iter()
		.find_map(|key| value.get(*key).and_then(positive_u64_value))
}

fn positive_u64_value(value: &serde_json::Value) -> Option<u64> {
	value
		.as_u64()
		.filter(|value| *value > 0)
		.or_else(|| value.as_str().and_then(positive_u64_text))
}

fn positive_u64_text(value: &str) -> Option<u64> {
	value.trim().parse::<u64>().ok().filter(|value| *value > 0)
}

fn apply_ollama_show(row: &mut DiscoveredModel, payload: &[u8]) -> Result<(), ProbeError> {
	let value: serde_json::Value =
		serde_json::from_slice(payload).map_err(|_| ProbeError::Protocol)?;
	let context = value
		.get("parameters")
		.and_then(serde_json::Value::as_str)
		.and_then(|parameters| {
			parameters.lines().find_map(|line| {
				let mut fields = line.split_whitespace();
				(fields.next() == Some("num_ctx"))
					.then(|| fields.next().and_then(positive_u64_text))
					.flatten()
			})
		})
		.or_else(|| {
			value
				.get("model_info")
				.and_then(serde_json::Value::as_object)
				.and_then(|info| {
					info
						.iter()
						.find(|(key, _)| {
							key.as_str() == "context_length" || key.ends_with(".context_length")
						})
						.and_then(|(_, value)| positive_u64_value(value))
				})
		})
		.or_else(|| positive_u64(&value, &["context_length"]));
	if let Some(context) = context.filter(|value| *value > 0) {
		row.declared_limits
			.get_or_insert(ModelLimits {
				context_window:        None,
				maximum_input_tokens:  None,
				maximum_output_tokens: None,
				maximum_batch:         None,
			})
			.context_window = Some(context);
		if let Some(output) = row
			.declared_limits
			.as_mut()
			.and_then(|limits| limits.maximum_output_tokens.as_mut())
		{
			*output = (*output).min(context);
		}
	}
	if let Some(capabilities) = discovered_capabilities(&value, DiscoveryEndpointKind::Ollama) {
		row.declared_capabilities = Some(capabilities);
	}
	Ok(())
}

fn apply_llama_props(rows: &mut [DiscoveredModel], payload: &[u8]) -> Result<(), ProbeError> {
	let value: serde_json::Value =
		serde_json::from_slice(payload).map_err(|_| ProbeError::Protocol)?;
	let context = value
		.get("default_generation_settings")
		.and_then(|settings| positive_u64(settings, &["n_ctx"]))
		.or_else(|| positive_u64(&value, &["n_ctx", "n_ctx_train", "context_length"]));
	let unlimited_output = [
		value
			.get("default_generation_settings")
			.and_then(|settings| settings.get("params"))
			.and_then(|params| params.get("max_tokens")),
		value
			.get("default_generation_settings")
			.and_then(|settings| settings.get("params"))
			.and_then(|params| params.get("n_predict")),
		value.get("max_tokens"),
		value.get("n_predict"),
	]
	.into_iter()
	.flatten()
	.any(|value| {
		value.as_i64() == Some(-1)
			|| value
				.as_str()
				.is_some_and(|value| value.trim().parse::<i64>() == Ok(-1))
	});
	let capabilities = discovered_capabilities(&value, DiscoveryEndpointKind::LlamaCpp);
	for row in rows {
		if let Some(server_context) = context {
			let limits = row.declared_limits.get_or_insert(ModelLimits {
				context_window:        None,
				maximum_input_tokens:  None,
				maximum_output_tokens: None,
				maximum_batch:         None,
			});
			if limits.context_window == Some(DEFAULT_DISCOVERY_CONTEXT_WINDOW) {
				limits.context_window = Some(server_context);
			}
			let effective_context = limits.context_window.unwrap_or(server_context);
			if unlimited_output {
				limits.maximum_output_tokens = Some(effective_context);
			} else if let Some(output) = limits.maximum_output_tokens.as_mut() {
				*output = (*output).min(effective_context);
			}
		}
		if let Some(incoming) = &capabilities {
			if let Some(existing) = &mut row.declared_capabilities {
				merge_runtime_capabilities(existing, incoming);
			} else {
				row.declared_capabilities = Some(incoming.clone());
			}
		}
	}
	Ok(())
}

/// Redacted transport failure category.
#[derive(Clone, Copy, Debug, strum::IntoStaticStr, thiserror::Error, Eq, PartialEq)]
#[strum(serialize_all = "snake_case")]
pub enum ProbeTransportError {
	/// The request could not be sent or connected.
	#[error("model discovery request transport failed")]
	Request,
	/// The response body stream failed.
	#[error("model discovery response transport failed")]
	Response,
}

/// Typed, redaction-safe probe failure.
#[derive(Clone, Copy, Debug, strum::IntoStaticStr, thiserror::Error, Eq, PartialEq)]
#[strum(serialize_all = "snake_case")]
pub enum ProbeError {
	/// The endpoint missed its loopback/remote deadline.
	#[error("model discovery probe timed out")]
	Timeout,
	/// The caller cancelled discovery.
	#[error("model discovery probe was cancelled")]
	Cancelled,
	/// The endpoint transport failed.
	#[error("model discovery transport failed")]
	Transport(#[source] ProbeTransportError),
	/// The endpoint returned a non-success HTTP status.
	#[error("model discovery endpoint returned HTTP status {status}")]
	HttpStatus {
		/// Numeric status only; response text and URL are intentionally omitted.
		status: u16,
	},
	/// The endpoint response exceeded the authority's byte bound.
	#[error("model discovery response exceeded the bounded byte limit")]
	ResponseTooLarge,
	/// The typed endpoint could not be converted into a request URL.
	#[error("model discovery endpoint is invalid")]
	InvalidEndpoint,
	/// The endpoint response was malformed.
	#[error("model discovery response was malformed")]
	Protocol,
}

#[cfg(test)]
mod tests {
	use std::{collections::BTreeMap, sync::Arc};

	use parking_lot::Mutex;

	use super::*;
	use crate::discovery::endpoints::{EndpointOrigin, configured_endpoint};

	#[derive(Clone)]
	struct FixtureClient(Arc<Bytes>);
	impl DiscoveryHttpClient for FixtureClient {
		fn request(&self, _: ProbeHttpRequest, _: CancellationToken) -> ProbeHttpFuture {
			let payload = Arc::clone(&self.0);
			Box::pin(async move { Ok((*payload).clone()) })
		}
	}
	#[derive(Clone)]
	struct ScriptedClient {
		responses: Arc<BTreeMap<Str, Bytes>>,
		requests:  Arc<Mutex<Vec<Str>>>,
	}

	impl DiscoveryHttpClient for ScriptedClient {
		fn request(&self, request: ProbeHttpRequest, _: CancellationToken) -> ProbeHttpFuture {
			self.requests.lock().push(request.url.clone());
			let response = self.responses.get(request.url.as_str()).cloned();
			Box::pin(
				async move { response.ok_or(ProbeError::Transport(ProbeTransportError::Request)) },
			)
		}
	}

	#[tokio::test]
	async fn litellm_preserves_and_merges_route_evidence() {
		assert!(omp_catalog::is_likely_openai_responses_id("gpt-4.1"));
		assert!(omp_catalog::is_likely_openai_responses_id("chatgpt-4o-latest"));
		assert!(!omp_catalog::is_likely_openai_responses_id("text-embedding-3-large"));

		let endpoint = configured_endpoint(DiscoveryEndpointKind::LiteLlm, "http://primary:4000/v1")
			.expect("endpoint");
		let probe = DiscoveryProbe {
			provider: ProviderId::from("litellm"),
			route: RouteId::from("litellm/primary"),
			proxy_routes: None,
			headers: http::HeaderMap::new(),
			endpoint,
		};
		let requests = Arc::new(Mutex::new(Vec::new()));
		let client = ScriptedClient {
			responses: Arc::new(BTreeMap::from([
				(
					Str::new_static("http://primary:4000/model_group/info"),
					Bytes::from_static(
						br#"{"data":[
							{"model_group":"team","providers":["openai"]},
							{"model_group":"configured","litellm_params":{"custom_llm_provider":"openai"}},
							{"model_group":"backend","litellm_params":{"model":"openai/gpt-5.6"}},
							{"model_group":"mixed","providers":["openai"]},
							{"model_group":"within","providers":["openai"]},
							{"model_group":"within","providers":["anthropic"]},
							{"model_group":"opaque","supports_vision":false}
						]}"#,
					),
				),
				(
					Str::new_static("http://primary:4000/v2/model/info"),
					Bytes::from_static(
						br#"{"data":[
							{"model_name":"mixed","providers":["openai","azure"]},
							{"model_name":"opaque","litellm_params":{"custom_llm_provider":"openai"}}
						]}"#,
					),
				),
			])),
			requests:  requests.clone(),
		};
		let rows = probe
			.probe(&client, CancellationToken::new())
			.await
			.expect("LiteLLM probe");
		let route = |id: &str| {
			rows
				.iter()
				.find(|row| row.wire_model.as_str() == id)
				.unwrap_or_else(|| panic!("{id} row"))
				.route
				.as_str()
		};
		for id in ["team", "configured", "backend", "opaque"] {
			assert_eq!(route(id), "litellm/openai-responses", "{id}");
		}
		assert_eq!(route("within"), "litellm/primary");
		assert!(
			requests
				.lock()
				.iter()
				.any(|url| url.as_str().ends_with("/v2/model/info")),
			"unknown first-endpoint evidence must keep probing"
		);
	}

	#[tokio::test]
	async fn litellm_preserves_partial_and_late_cache_pricing() {
		let endpoint = configured_endpoint(DiscoveryEndpointKind::LiteLlm, "http://primary:4000/v1")
			.expect("endpoint");
		let probe = DiscoveryProbe {
			provider: ProviderId::from("litellm"),
			route: RouteId::from("litellm/primary"),
			proxy_routes: None,
			headers: http::HeaderMap::new(),
			endpoint,
		};
		let client = ScriptedClient {
			responses: Arc::new(BTreeMap::from([
				(
					Str::new_static("http://primary:4000/model_group/info"),
					Bytes::from_static(
						br#"{"data":[{"model_group":"priced","providers":["openai"],"input_cost_per_token":0.0000055,"cache_read_input_token_cost":0.00000055},{"model_group":"partial","providers":["openai"],"cache_read_input_token_cost":0.00000025}]}"#,
					),
				),
				(
					Str::new_static("http://primary:4000/v2/model/info"),
					Bytes::from_static(
						br#"{"data":[{"model_name":"priced","model_info":{"output_cost_per_token":0.000033,"cache_creation_input_token_cost":0.000006875}}]}"#,
					),
				),
			])),
			requests: Arc::new(Mutex::new(Vec::new())),
		};
		let rows = probe
			.probe(&client, CancellationToken::new())
			.await
			.expect("LiteLLM probe");
		let pricing = |id: &str| {
			rows
				.iter()
				.find(|row| row.wire_model.as_str() == id)
				.unwrap_or_else(|| panic!("{id} row"))
				.declared_pricing
				.iter()
				.map(|price| (price.unit, price.nanos_usd))
				.collect::<BTreeMap<_, _>>()
		};
		assert_eq!(
			pricing("priced"),
			BTreeMap::from([
				(PriceUnit::MtokInput, 5_500_000_000),
				(PriceUnit::MtokOutput, 33_000_000_000),
				(PriceUnit::MtokCacheRead, 550_000_000),
				(PriceUnit::MtokCacheWrite, 6_875_000_000),
			])
		);
		assert_eq!(pricing("partial"), BTreeMap::from([(PriceUnit::MtokCacheRead, 250_000_000)]));
	}

	#[tokio::test]
	async fn ollama_show_supplies_runtime_context_reasoning_and_image_metadata() {
		let endpoint =
			configured_endpoint(DiscoveryEndpointKind::Ollama, "http://127.0.0.1:11434/v1")
				.expect("endpoint");
		let client = ScriptedClient {
			responses: Arc::new(BTreeMap::from([
				(
					Str::new_static("http://127.0.0.1:11434/api/tags"),
					Bytes::from_static(br#"{"models":[{"name":"local","model":"local"}]}"#),
				),
				(
					Str::new_static("http://127.0.0.1:11434/api/show"),
					Bytes::from_static(
						br#"{"parameters":"num_ctx 24576\n","capabilities":["thinking","vision"]}"#,
					),
				),
			])),
			requests:  Arc::new(Mutex::new(Vec::new())),
		};
		let probe = DiscoveryProbe {
			provider: ProviderId::from("ollama"),
			route: RouteId::from("ollama/primary"),
			proxy_routes: None,
			headers: http::HeaderMap::new(),
			endpoint,
		};
		let row = probe
			.probe_model(WireModelId::from_ref("local"), &client, CancellationToken::new())
			.await
			.expect("probe")
			.expect("model");
		assert_eq!(
			row.declared_limits
				.as_ref()
				.and_then(|limits| limits.context_window),
			Some(24_576)
		);
		let chat = row
			.declared_capabilities
			.as_ref()
			.and_then(|capabilities| capabilities.chat.as_ref())
			.expect("chat capabilities");
		assert!(matches!(chat.reasoning, Availability::Native(_)));
		assert!(
			chat
				.input_modalities
				.constraints()
				.is_some_and(|modalities| modalities.contains(ModalityBits::IMAGE))
		);
	}

	#[tokio::test]
	async fn llama_runtime_row_precedes_server_and_training_metadata() {
		let endpoint =
			configured_endpoint(DiscoveryEndpointKind::LlamaCpp, "http://127.0.0.1:8080/v1")
				.expect("endpoint");
		let client = ScriptedClient {
			responses: Arc::new(BTreeMap::from([
				(
					Str::new_static("http://127.0.0.1:8080/models"),
					Bytes::from_static(
						br#"{"data":[{"id":"local","meta":{"n_ctx":8192,"n_ctx_train":131072},"architecture":{"input_modalities":["text","image"]}}]}"#,
					),
				),
				(
					Str::new_static("http://127.0.0.1:8080/props"),
					Bytes::from_static(
						br#"{"default_generation_settings":{"n_ctx":4096,"params":{"n_predict":-1}}}"#,
					),
				),
			])),
			requests: Arc::new(Mutex::new(Vec::new())),
		};
		let probe = DiscoveryProbe {
			provider: ProviderId::from("llama.cpp"),
			route: RouteId::from("llama.cpp/primary"),
			proxy_routes: None,
			headers: http::HeaderMap::new(),
			endpoint,
		};
		let rows = probe
			.probe(&client, CancellationToken::new())
			.await
			.expect("probe");
		let limits = rows[0].declared_limits.as_ref().expect("limits");
		assert_eq!(limits.context_window, Some(8192));
		assert_eq!(limits.maximum_output_tokens, Some(8192));
		let modalities = rows[0]
			.declared_capabilities
			.as_ref()
			.and_then(|capabilities| capabilities.chat.as_ref())
			.and_then(|chat| chat.input_modalities.constraints())
			.expect("modalities");
		assert!(modalities.contains(ModalityBits::IMAGE));
	}

	#[tokio::test]
	async fn lm_studio_selected_model_tracks_loaded_context() {
		let endpoint = configured_endpoint(DiscoveryEndpointKind::LmStudio, "http://127.0.0.1:1234")
			.expect("endpoint");
		let probe = DiscoveryProbe {
			provider: ProviderId::from("lm-studio"),
			route: RouteId::from("lm-studio/primary"),
			proxy_routes: None,
			headers: http::HeaderMap::new(),
			endpoint,
		};
		let selected = WireModelId::from("big-model");
		let loaded = probe
			.probe_model(
				&selected,
				&FixtureClient(Arc::new(Bytes::from_static(
					br#"{"data":[{"id":"big-model","state":"loaded","max_context_length":262144,"loaded_context_length":81920}]}"#,
				))),
				CancellationToken::new(),
			)
			.await
			.expect("loaded probe")
			.expect("selected model");
		assert_eq!(
			loaded
				.declared_limits
				.as_ref()
				.and_then(|limits| limits.context_window),
			Some(81_920)
		);
		let unloaded = probe
			.probe_model(
				&selected,
				&FixtureClient(Arc::new(Bytes::from_static(
					br#"{"data":[{"id":"big-model","state":"not-loaded","max_context_length":262144,"loaded_context_length":null}]}"#,
				))),
				CancellationToken::new(),
			)
			.await
			.expect("unloaded probe")
			.expect("selected model");
		assert_eq!(
			unloaded
				.declared_limits
				.as_ref()
				.and_then(|limits| limits.context_window),
			Some(262_144)
		);
	}

	#[tokio::test]
	async fn proxy_routes_each_model_from_declared_endpoint_evidence() {
		let endpoint = configured_endpoint(DiscoveryEndpointKind::Proxy, "https://proxy.example/v1")
			.expect("endpoint");
		let probe = DiscoveryProbe {
			provider: ProviderId::from("proxy"),
			route: RouteId::from("proxy/fallback"),
			proxy_routes: Some(ProxyDiscoveryRoutes {
				openai:    RouteId::from("proxy/openai"),
				anthropic: RouteId::from("proxy/anthropic"),
			}),
			headers: http::HeaderMap::new(),
			endpoint,
		};
		let rows = probe
			.probe(
				&FixtureClient(Arc::new(Bytes::from_static(
					br#"{"data":[
						{"id":"claude","supported_endpoint_types":["anthropic","openai"]},
						{"id":"gpt","supported_endpoint_types":["openai"]},
						{"id":"opaque"}
					]}"#,
				))),
				CancellationToken::new(),
			)
			.await
			.expect("proxy probe");
		let route = |id: &str| {
			rows
				.iter()
				.find(|row| row.wire_model.as_str() == id)
				.expect("row")
				.route
				.as_str()
		};
		assert_eq!(route("claude"), "proxy/anthropic");
		assert_eq!(route("gpt"), "proxy/openai");
		assert_eq!(route("opaque"), "proxy/fallback");
	}

	#[tokio::test]
	async fn openai_models_path_preserves_query_and_honors_v1_policy() {
		let endpoint = crate::discovery::configured_endpoint_with_options(
			DiscoveryEndpointKind::OpenAi,
			"https://models.example/v3/compat?token=secret",
			None,
			Some(false),
		)
		.expect("endpoint");
		let requests = Arc::new(Mutex::new(Vec::new()));
		let client = ScriptedClient {
			responses: Arc::new(BTreeMap::from([(
				Str::new_static("https://models.example/v3/compat/models?token=secret"),
				Bytes::from_static(br#"{"data":[{"id":"model"}]}"#),
			)])),
			requests:  requests.clone(),
		};
		let probe = DiscoveryProbe {
			provider: ProviderId::from("custom"),
			route: RouteId::from("custom-route"),
			proxy_routes: None,
			headers: http::HeaderMap::new(),
			endpoint,
		};
		let rows = probe
			.probe(&client, CancellationToken::new())
			.await
			.expect("OpenAI probe");
		assert_eq!(rows.len(), 1);
		assert_eq!(requests.lock().as_slice(), [Str::new_static(
			"https://models.example/v3/compat/models?token=secret"
		)]);
		assert!(!rows[0].source.contains("secret"));
	}

	#[tokio::test]
	async fn generic_openai_probe_normalizes_models() {
		let endpoint =
			configured_endpoint(DiscoveryEndpointKind::OpenAi, "https://models.example/v1")
				.expect("endpoint");
		assert_eq!(endpoint.origin, EndpointOrigin::Configured);
		let probe = DiscoveryProbe {
			provider: ProviderId::from("custom"),
			route: RouteId::from("custom-route"),
			proxy_routes: None,
			headers: http::HeaderMap::new(),
			endpoint,
		};
		let rows = probe
			.probe(
				&FixtureClient(Arc::new(Bytes::from_static(
					br#"{"data":[{"id":"offline","context_length":8192}]}"#,
				))),
				CancellationToken::new(),
			)
			.await
			.expect("probe");
		assert_eq!(rows[0].wire_model.as_str(), "offline");
		assert_eq!(
			rows[0]
				.declared_limits
				.as_ref()
				.and_then(|limits| limits.context_window),
			Some(8192)
		);
	}

	#[tokio::test]
	async fn duplicate_rows_merge_richer_runtime_metadata_deterministically() {
		let endpoint =
			configured_endpoint(DiscoveryEndpointKind::OpenAi, "https://models.example/v1")
				.expect("endpoint");
		let probe = DiscoveryProbe {
			provider: ProviderId::from("custom"),
			route: RouteId::from("custom-route"),
			proxy_routes: None,
			headers: http::HeaderMap::new(),
			endpoint,
		};
		let rows = probe
			.probe(
				&FixtureClient(Arc::new(Bytes::from_static(
					br#"{"data":[{"id":"same"},{"id":"same","display_name":"Richer","context_length":"16384"}]}"#,
				))),
				CancellationToken::new(),
			)
			.await
			.expect("probe");
		assert_eq!(rows.len(), 1);
		assert_eq!(rows[0].display_name.as_deref(), Some("Richer"));
		assert_eq!(
			rows[0]
				.declared_limits
				.as_ref()
				.and_then(|limits| limits.context_window),
			Some(16_384)
		);
	}

	#[test]
	fn probe_request_debug_redacts_url_headers_and_body() {
		let mut headers = http::HeaderMap::new();
		headers.insert(
			http::header::AUTHORIZATION,
			http::HeaderValue::from_static("Bearer header-secret"),
		);
		let request = ProbeHttpRequest {
			method: http::Method::POST,
			url: Str::new_static(
				"https://user:password@models.example/private-secret?token=query-secret",
			),
			headers,
			body: Bytes::from_static(b"body-secret"),
			deadline: Duration::from_secs(1),
		};
		let debug = format!("{request:?}");
		for secret in ["password", "private-secret", "query-secret", "header-secret", "body-secret"] {
			assert!(!debug.contains(secret), "{secret} leaked through Debug");
		}
		assert!(debug.contains("authorization"));
	}

	#[tokio::test]
	async fn complete_probe_deadline_bounds_a_pending_transport() {
		#[derive(Clone)]
		struct PendingClient;
		impl DiscoveryHttpClient for PendingClient {
			fn request(&self, _: ProbeHttpRequest, _: CancellationToken) -> ProbeHttpFuture {
				Box::pin(std::future::pending())
			}
		}
		let endpoint = crate::discovery::configured_endpoint_with_options(
			DiscoveryEndpointKind::OpenAi,
			"https://models.example/v1",
			Some(1),
			None,
		)
		.expect("endpoint");
		let probe = DiscoveryProbe {
			provider: ProviderId::from("custom"),
			route: RouteId::from("custom-route"),
			proxy_routes: None,
			headers: http::HeaderMap::new(),
			endpoint,
		};
		assert_eq!(
			probe.probe(&PendingClient, CancellationToken::new()).await,
			Err(ProbeError::Timeout)
		);
	}
}
