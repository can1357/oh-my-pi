//! Direct typed-client integration coverage replacing protocol-SDK
//! compatibility callsites.

use std::{path::Path, sync::Arc, time::Duration};

use omp_ai::{
	Client,
	auth::{CredentialStore, HeadlessKeySource, KeyId},
	call::{
		CallMeta, ChatRequest, ContentPart, DiscoveryRequest, Message, NegotiationPolicy, Role,
		Sampling, Setting, Target,
	},
	id::RequestId,
	receipt::ExecutionBudget,
	router::Router,
};
use omp_catalog::OperationKind;
use omp_core::sf;

fn credential_store(path: &Path) -> Arc<CredentialStore> {
	omp_driver::registry::open_credential_store_with_key_source(
		path,
		Arc::new(HeadlessKeySource::new(KeyId::new("stock-sdk-smoke"), [0x32; 32])),
	)
	.expect("credential store")
}

fn metadata(target: Target, id: &'static str) -> CallMeta {
	CallMeta {
		id: RequestId::from(id),
		target,
		deadline: None,
		budget: ExecutionBudget::default(),
		session: None,
		debug_session: None,
		response_hooks: Default::default(),
	}
}

fn chat_request() -> ChatRequest {
	ChatRequest {
		messages:          Arc::from([Message {
			role:    Role::User,
			content: Arc::from([ContentPart::Text {
				text:  sf!("typed integration smoke"),
				proof: None,
			}]),
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
	}
}

#[tokio::test]
async fn typed_chat_and_discovery_plan_through_the_production_registry() {
	let state = tempfile::tempdir().expect("temporary state");
	let store = credential_store(&state.path().join("credentials.db"));
	let registry = omp_driver::registry::production_registry(state.path(), store)
		.await
		.expect("production registry");
	let chat_model = registry
		.catalog()
		.models()
		.iter()
		.find(|model| {
			model
				.capabilities
				.operations
				.contains_kind(OperationKind::Chat)
				&& model
					.routes
					.iter()
					.any(|route| registry.contains_service(route))
		})
		.map(|model| model.key.clone())
		.expect("catalog advertises a constructed chat model");
	let chat = Client::new(
		registry.service(),
		Router::new(registry.clone(), Duration::from_secs(30)),
		metadata(Target::Model(chat_model), "typed-chat-smoke"),
	);
	let chat_plan = chat.plan(&chat_request()).expect("chat plans");
	assert_eq!(chat_plan.kind(), OperationKind::Chat);

	let discovery_route = registry
		.catalog()
		.routes()
		.iter()
		.find(|route| {
			route.discovery.is_some()
				&& registry.contains_service(&route.id)
				&& registry
					.catalog()
					.provider(&route.provider)
					.is_some_and(|provider| provider.management.supports(OperationKind::DiscoverModels))
		})
		.cloned()
		.unwrap_or_else(|| {
			let failures = registry
				.catalog()
				.routes()
				.iter()
				.filter(|route| route.discovery.is_some())
				.map(|route| (route.id.clone(), registry.unavailability(&route.id).cloned()))
				.collect::<Vec<_>>();
			panic!("catalog has no constructed discovery route: {failures:?}")
		});
	let provider = discovery_route.provider.clone();
	let discovery_request = DiscoveryRequest {
		provider:  Some(provider),
		route:     Some(discovery_route.id.clone()),
		cursor:    None,
		page_size: 100,
		operation: None,
	};
	let discovery = Client::new(
		registry.service(),
		Router::new(registry, Duration::from_secs(30)),
		metadata(Target::RouteService(discovery_route.id), "typed-discovery-smoke"),
	);
	let discovery_plan = discovery.plan(&discovery_request).expect("discovery plans");
	assert_eq!(discovery_plan.kind(), OperationKind::DiscoverModels);
}
