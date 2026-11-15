//! Proves models configured in `models.toml` join the catalog keyed
//! `<provider>/<model>`, like bundled and discovered models.
//!
//! The file names models by the provider's own id; lowering scopes them, and
//! references between them (`compactionModel`, `contextPromotionTarget`)
//! resolve inside the declaring provider before any catalog-wide selection.
//! A configured `auth` replaces the routes' authentication, and with it the
//! kind a stored credential of the provider must have, except for a provider
//! whose bundled routes take a key, whose stored key never moves.

use std::{
	fmt::Write as _,
	fs,
	path::Path,
	sync::Arc,
	time::{Duration, SystemTime, UNIX_EPOCH},
};

use omp_ai::{
	AuthEvent, AuthResponse,
	account::{AccountPool, AccountRecord, AccountStateStore},
	auth::{
		AuthControlHandle, AuthLoginEngine as _, CredentialBroker, CredentialBrokerEngines,
		CredentialControlWrite, CredentialEnvironment, CredentialError, CredentialKind,
		CredentialMetadata, CredentialNeed, CredentialOrigin, CredentialSource as _, CredentialStore,
		CredentialWrite, HeadlessKeySource, KeyId, SecretLoginEngine, StoredCredentialSource,
		UnavailableKeySource, provider_auth_specs,
	},
	call::{AccountRoutingContext, AuthInput, AuthMethod, LoginRequest},
	discovery::{DiscoveryCacheKey, DiscoveryStore},
};
use omp_catalog::{
	AuthSpecId, DiscoveredModel, ModelKey, ModelLimits, OperationBits, OperationKind, OverlaySource,
	OverlayStack, ProviderId, RouteId, UnsafeTrustScope, WireModelId,
	provider::CredentialSourceSpec, settings::ModelSettings, snapshot::Catalog,
};
use omp_core::{SecretString, Str};
use omp_driver::{
	discovery::{
		models::{ModelsConfig, discovery_probes, load_models_config, lower_user_overlay},
		roles::resolve_role_selector,
	},
	registry::{production_catalog, production_registry},
};

/// Lowers `models_toml` over the embedded catalog, as the production registry
/// does before any discovery layer.
fn configured(models_toml: &str) -> Catalog {
	let config: ModelsConfig = toml::from_str(models_toml).expect("models.toml decodes");
	Catalog::embedded()
		.with_overlay_stack(
			&OverlayStack::from_layers([(
				OverlaySource::UserConfig,
				lower_user_overlay(&config).expect("config lowers"),
			)]),
			UnsafeTrustScope::ALL,
		)
		.expect("configured catalog")
}

fn key(text: &str) -> ModelKey {
	ModelKey::from(text)
}

const TWO_PROVIDERS: &str = "[providers.alpha]\nbaseUrl='https://alpha.example/v1'\nauth='none'\n\
                             api='openai-completions'\n\
                             [providers.alpha.models.shared]\nname='Alpha Shared'\ncontextWindow=1000\n\
                             [providers.beta]\nbaseUrl='https://beta.example/v1'\nauth='none'\n\
                             api='openai-completions'\n\
                             [providers.beta.models.shared]\nname='Beta Shared'\ncontextWindow=2000\n";

#[test]
fn two_providers_configuring_the_same_model_name_each_keep_their_own_model() {
	let catalog = configured(TWO_PROVIDERS);
	for (provider, name, window) in
		[("alpha", "Alpha Shared", 1_000), ("beta", "Beta Shared", 2_000)]
	{
		let scoped = key(&format!("{provider}/shared"));
		let model = catalog
			.model(&scoped)
			.unwrap_or_else(|| panic!("{scoped} survives beside the other provider's entry"));
		let route = RouteId::from(format!("{provider}-configured"));
		assert_eq!(model.routes.as_ref(), std::slice::from_ref(&route), "{scoped} routes");
		assert_eq!(
			model.wire_ids.as_ref(),
			[(route, WireModelId::from("shared"))],
			"{scoped} sends the provider's own id"
		);
		assert_eq!(model.display_name, name, "{scoped} name");
		assert_eq!(model.limits.context_window, Some(window), "{scoped} limits");
	}
	assert!(
		catalog.model(ModelKey::from_ref("shared")).is_none(),
		"no configured model is keyed without its provider"
	);
}

#[test]
fn bare_references_resolve_within_the_declaring_provider_first() {
	let bundled = Catalog::embedded()
		.models()
		.iter()
		.find(|model| !model.routes.is_empty() && model.key.as_str().split('/').count() == 2)
		.expect("a bundled provider/model key");
	let catalog = configured(&format!(
		"[providers.alpha]\nbaseUrl='https://alpha.example/v1'\nauth='none'\n\
		 api='openai-completions'\n\
		 [providers.alpha.models.fast]\ncontextPromotionTarget='large'\ncompactionModel='fast'\n\
		 [providers.alpha.models.large]\n\
		 [providers.beta]\nbaseUrl='https://beta.example/v1'\nauth='none'\n\
		 api='openai-completions'\n\
		 [providers.beta.models.large]\ncompactionModel='alpha/fast'\n\
		 contextPromotionTarget='later'\n\
		 [providers.beta.models.pinned]\ncompactionModel='{}'\n",
		bundled.key
	));
	let model = |text: &str| catalog.model(&key(text)).expect("configured model");

	let fast = model("alpha/fast");
	assert_eq!(
		fast.context_promotion_target,
		Some(key("alpha/large")),
		"a bare target names the declaring provider's model, not beta's `large`"
	);
	assert_eq!(fast.compaction_model, Some(key("alpha/fast")));

	let large = model("beta/large");
	assert_eq!(
		large.compaction_model,
		Some(key("alpha/fast")),
		"a qualified reference resolves catalog-wide"
	);
	assert_eq!(
		large.context_promotion_target,
		Some(key("beta/later")),
		"a reference naming nothing yet stays in the provider discovery fills"
	);

	assert_eq!(model("beta/pinned").compaction_model, Some(bundled.key.clone()));
}

#[test]
fn configured_models_resolve_by_scoped_key_and_by_bare_id() {
	let catalog = configured(
		"[providers.easycliproxy]\nbaseUrl='https://proxy.example/v1'\nauth='none'\n\
		 api='openai-completions'\n\
		 [providers.easycliproxy.models.claude-opus-5]\n\
		 [providers.easycliproxy.models.proxy-only-fast]\n",
	);
	let settings = ModelSettings::default();
	let resolve = |selector: &str| {
		resolve_role_selector(&catalog, &settings, selector)
			.unwrap_or_else(|error| panic!("{selector} resolves: {error}"))
			.model
	};
	assert_eq!(resolve("easycliproxy/claude-opus-5"), key("easycliproxy/claude-opus-5"));
	assert_eq!(resolve("proxy-only-fast"), key("easycliproxy/proxy-only-fast"));
	let bare = resolve("claude-opus-5");
	assert!(
		bare.as_str().ends_with("/claude-opus-5") && catalog.model(&bare).is_some(),
		"a bare id selects a provider-scoped model, got {bare}"
	);
}

/// ADR 0059 D1: a self-hosted Otari gateway is a `baseUrl` on the bundled
/// `otari` provider id, not a catalog schema change. The overlay redirects the
/// catalog's own route (no `otari-configured` copy), keeps its wire and
/// credential contract, and touches no other provider.
#[test]
fn a_base_url_on_a_catalog_provider_id_redirects_its_catalog_route() {
	const HOSTED: &str = "https://api.otari.ai/api/v1";
	const SELF_HOSTED: &str = "https://otari.internal.example/api/v1";
	let bundled = Catalog::embedded();
	let otari = ProviderId::from_ref("otari");
	let bundled_provider = bundled
		.provider(otari)
		.expect("otari is a catalog provider");
	let [route_id] = bundled_provider.routes.as_ref() else {
		panic!("otari has one catalog route");
	};
	let bundled_route = bundled.route(route_id).expect("otari route");
	assert_eq!(bundled_route.endpoint.base_url.as_str(), HOSTED);

	let catalog = configured(&format!("[providers.otari]\nbaseUrl='{SELF_HOSTED}'\n"));
	let provider = catalog.provider(otari).expect("otari survives the overlay");
	assert_eq!(
		provider.routes, bundled_provider.routes,
		"the overlay patches the catalog route instead of adding a configured one"
	);
	assert!(
		catalog
			.route(RouteId::from_ref("otari-configured"))
			.is_none(),
		"a catalog provider id never takes the user-added provider path"
	);
	let route = catalog.route(route_id).expect("patched otari route");
	assert_eq!(route.endpoint.base_url.as_str(), SELF_HOSTED);
	assert_eq!(route.codec, bundled_route.codec, "the wire protocol is unchanged");
	assert_eq!(route.auth, bundled_route.auth, "the credential contract is unchanged");
	assert_eq!(route.discovery, bundled_route.discovery, "discovery is unchanged");
	assert_eq!(provider.auth, bundled_provider.auth, "the provider still takes its bundled key");

	for other in ["sambanova", "coralbricks", "helmcode", "modular"] {
		let id = ProviderId::from_ref(other);
		let routes = |catalog: &Catalog| {
			catalog
				.provider(id)
				.expect("bundled provider")
				.routes
				.iter()
				.map(|route| catalog.route(route).expect("route").endpoint.clone())
				.collect::<Vec<_>>()
		};
		assert_eq!(routes(&catalog), routes(&bundled), "{other} keeps its hosted endpoint");
	}
}

fn now_ms() -> u64 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.expect("clock after epoch")
		.as_millis()
		.try_into()
		.expect("millisecond clock")
}

#[test]
fn a_configured_model_wins_over_its_providers_discovered_row() {
	const MODELS_TOML: &str = "[providers.alpha]\nbaseUrl='https://alpha.example/v1'\nauth='none'\n\
	                           discovery={type='openai-models-list'}\n\
	                           [providers.alpha.models.fast]\nid='shared-model'\n\
	                           name='Configured Fast'\ncontextWindow=4242\n";
	let data_dir = tempfile::tempdir().expect("scratch data dir");
	let path = data_dir.path().join("models.toml");
	fs::write(&path, MODELS_TOML).expect("models.toml");
	let config = load_models_config(&path).expect("config decodes");
	let probes = discovery_probes(Some(&config), &configured(MODELS_TOML)).expect("probes");
	let probe = probes
		.iter()
		.find(|probe| probe.provider.as_str() == "alpha")
		.expect("configured provider probe");

	let mut operations = OperationBits::empty();
	operations.insert_kind(OperationKind::Chat);
	let listed = DiscoveredModel {
		provider:              probe.provider.clone(),
		route:                 probe.route.clone(),
		wire_model:            WireModelId::from("shared-model"),
		aliases:               Box::new([]),
		display_name:          Some(Str::new_static("Listed Impostor")),
		declared_class:        None,
		declared_operations:   operations,
		declared_capabilities: None,
		declared_limits:       Some(ModelLimits {
			context_window:        Some(1_024),
			maximum_input_tokens:  None,
			maximum_output_tokens: None,
			maximum_batch:         None,
		}),
		declared_pricing:      Box::new([]),
		extended_context_mode: None,
		availability:          None,
		source:                Str::new_static("test-listing"),
		observed_at_ms:        Some(now_ms()),
		updated_at_ms:         None,
		deprecated:            None,
	};
	DiscoveryStore::open(&data_dir.path().join("models.db"))
		.expect("cache")
		.publish(
			&DiscoveryCacheKey::endpoint(probe.provider.clone(), &probe.endpoint),
			&[listed],
			now_ms(),
			Duration::from_hours(1),
		)
		.expect("publish cached listing");

	let catalog = production_catalog(data_dir.path()).expect("production catalog");
	let model = catalog
		.model(&key("alpha/shared-model"))
		.expect("the configured model keeps its provider-scoped key");
	assert_eq!(model.display_name, "Configured Fast");
	assert_eq!(model.limits.context_window, Some(4_242));
	assert!(
		catalog.model(ModelKey::from_ref("shared-model")).is_none(),
		"no configured model is keyed without its provider"
	);
	assert_eq!(
		catalog
			.models()
			.iter()
			.filter(|model| model.key.as_str().ends_with("/shared-model"))
			.count(),
		1,
		"the listing adds no second record for the configured model"
	);
}

/// Hugging Face declares a bearer token, but `auth = 'apiKey'` (what the v1
/// importer writes for a keyed `models.yml` provider) makes its routes lease
/// an API key. The base URL is a closed local port, so a composition that
/// refreshes discovery never leaves the machine.
const HUGGINGFACE_API_KEY_ROUTES: &str =
	"[providers.huggingface]\nbaseUrl='http://127.0.0.1:9/v1'\nauth='apiKey'\n";

/// The authentication `HUGGINGFACE_API_KEY_ROUTES` gives every Hugging Face
/// route.
fn configured_auth() -> AuthSpecId {
	AuthSpecId::from("huggingface-configured-auth")
}

/// The credential store and account pool of `data_dir`.
fn stores(data_dir: &Path) -> (Arc<CredentialStore>, AccountPool) {
	let database = data_dir.join("credentials.db");
	let store = Arc::new(
		CredentialStore::open(
			&database,
			Arc::new(HeadlessKeySource::new(KeyId::new("configured-kind"), [5; 32])),
		)
		.expect("credential store"),
	);
	let accounts =
		AccountPool::with_store(Arc::new(AccountStateStore::open(&database).expect("state")))
			.expect("account pool");
	(store, accounts)
}

/// Stores `secret` for `provider` under `kind` exactly as given, as an
/// earlier writer did, and registers its account `<provider>:<identity>`.
fn earlier_row(
	store: &CredentialStore,
	accounts: &AccountPool,
	provider: &str,
	identity: &str,
	kind: &str,
	secret: &[u8],
) -> CredentialMetadata {
	let account = omp_ai::AccountId::from(format!("{provider}:{identity}"));
	let principal = omp_ai::PrincipalId::from(identity);
	let metadata = store
		.put(CredentialWrite {
			account_id: &account,
			principal_id: &principal,
			kind,
			secret: &omp_core::SecretBox::new(Box::new(secret.to_vec())),
			expires_at_ms: None,
			origin: CredentialOrigin::Persistent,
			now_ms: 1,
			expected_generation: None,
		})
		.expect("earlier row");
	accounts
		.upsert(AccountRecord {
			account,
			principal,
			provider: ProviderId::from(provider),
			routes: std::collections::BTreeSet::new(),
			enabled: true,
			credential_generation: metadata.generation,
			routing: AccountRoutingContext::default(),
		})
		.expect("earlier account");
	metadata
}

/// Stores `secret` as the `bearer` row `/login` wrote for Hugging Face from
/// its declared authentication before it followed the routes' kind, and
/// registers its account.
fn earlier_bearer_login(
	store: &CredentialStore,
	accounts: &AccountPool,
	secret: &[u8],
) -> CredentialMetadata {
	earlier_row(store, accounts, "huggingface", "api-key", "bearer", secret)
}

/// A process environment with no credential variable set.
struct NoEnvironment;

impl CredentialEnvironment for NoEnvironment {
	fn read(&self, _: &str) -> Result<Option<SecretString>, CredentialError> {
		Ok(None)
	}
}

/// Leases `account` from `store` on the configured Hugging Face
/// authentication.
async fn lease_configured(
	catalog: &Catalog,
	store: &Arc<CredentialStore>,
	account: &str,
) -> Result<omp_ai::auth::CredentialLease, CredentialError> {
	lease_on(catalog, store, configured_auth(), account).await
}

/// Leases `account` from `store` on the catalog authentication `spec`.
async fn lease_on(
	catalog: &Catalog,
	store: &Arc<CredentialStore>,
	spec: AuthSpecId,
	account: &str,
) -> Result<omp_ai::auth::CredentialLease, CredentialError> {
	let broker =
		CredentialBroker::from_catalog(catalog, Arc::new(NoEnvironment), CredentialBrokerEngines {
			stored: Some(Arc::new(StoredCredentialSource::new(Arc::clone(store)))),
			..CredentialBrokerEngines::default()
		})
		.expect("broker");
	broker
		.lease(CredentialNeed {
			spec,
			account: Some(omp_ai::AccountId::from(account)),
			principal: None,
			valid_after: SystemTime::now(),
		})
		.await
}

/// The `authorization` header `lease` puts on a request under the configured
/// authentication.
fn authorization(catalog: &Catalog, lease: &omp_ai::auth::CredentialLease) -> String {
	applied_header(catalog, &configured_auth(), lease, "authorization")
}

/// The `header` `lease` puts on a request under the catalog authentication
/// `spec`.
fn applied_header(
	catalog: &Catalog,
	spec: &AuthSpecId,
	lease: &omp_ai::auth::CredentialLease,
	header: &str,
) -> String {
	let spec = catalog.auth_spec(spec).expect("catalog auth");
	let runtime = omp_ai::auth::AuthSpec::from_catalog(spec, None, None).expect("runtime auth");
	let mut request = http::Request::builder()
		.uri("http://127.0.0.1:9/v1/chat/completions")
		.body(bytes::Bytes::new())
		.expect("request");
	lease
		.prepare(&runtime, SystemTime::now())
		.expect("the lease prepares")
		.finalize_buffered(&mut request)
		.expect("the lease applies");
	request.headers()[header]
		.to_str()
		.expect("ASCII header")
		.to_owned()
}

/// Answers an API-key login's prompt with `key` and returns the account it
/// completes with.
async fn answer_key_login(session: omp_ai::answer::AuthSession, key: &str) -> omp_ai::AccountId {
	loop {
		let event = tokio::time::timeout(Duration::from_secs(5), session.events.recv_async())
			.await
			.expect("login event in time")
			.expect("login channel")
			.expect("login event");
		match event {
			AuthEvent::Prompt(_) => session
				.responses
				.send_async(AuthResponse {
					session: session.id.clone(),
					input:   AuthInput::ApiKey(SecretString::from(key.to_owned())),
				})
				.await
				.expect("answer the prompt"),
			AuthEvent::Complete(account) => return account.account,
			AuthEvent::OpenUrl { .. } | AuthEvent::ShowDeviceCode { .. } | AuthEvent::Waiting => {},
		}
	}
}

/// A configured auth decides the kind a Hugging Face credential is stored
/// under: a `bearer` row stored before is re-stored as `api-key`, and an
/// extension's bearer token and a `/login` key (which picks the provider's
/// declared bearer authentication) are stored as `api-key`. Each then leases
/// on the configured authentication.
#[tokio::test]
async fn a_configured_auth_decides_the_stored_credential_kind() {
	let catalog = Arc::new(configured(HUGGINGFACE_API_KEY_ROUTES));
	let data_dir = tempfile::tempdir().expect("scratch data dir");
	let (store, accounts) = stores(data_dir.path());
	let control =
		AuthControlHandle::offline(Arc::clone(&catalog), Arc::clone(&store), accounts.clone())
			.expect("control");

	let earlier = earlier_bearer_login(&store, &accounts, b"hf-fake-earlier");
	assert_eq!(
		lease_configured(&catalog, &store, "huggingface:api-key")
			.await
			.expect_err("a bearer row cannot lease on the configured auth"),
		CredentialError::KindMismatch {
			expected: CredentialKind::ApiKey,
			actual:   CredentialKind::Bearer,
			origin:   omp_ai::auth::LeaseOrigin::StoredSecret,
		}
	);
	let repairs = control.repair_static_secret_kinds().expect("repair");
	assert!(repairs.failed.is_empty(), "{:?}", repairs.failed);
	assert_eq!(
		repairs
			.repaired
			.iter()
			.map(|repair| (repair.account.as_str(), repair.stored.as_str(), repair.repaired))
			.collect::<Vec<_>>(),
		[("huggingface:api-key", "bearer", CredentialKind::ApiKey)]
	);
	let repaired = store
		.metadata(&earlier.account_id)
		.expect("metadata")
		.expect("row");
	assert_eq!(repaired.kind.as_str(), "api-key");
	assert_eq!(repaired.generation, earlier.generation + 1);
	let lease = lease_configured(&catalog, &store, "huggingface:api-key")
		.await
		.expect("the re-stored row leases");
	assert_eq!(authorization(&catalog, &lease), "Bearer hf-fake-earlier");
	let again = control.repair_static_secret_kinds().expect("again");
	assert!(again.repaired.is_empty() && again.failed.is_empty(), "{again:?}");

	let (extension, _) = control
		.store(CredentialControlWrite {
			provider:      ProviderId::from("huggingface"),
			principal:     omp_ai::PrincipalId::from("extension"),
			identity:      Some(Str::new_static("extension")),
			kind:          Str::new_static("bearer"),
			secret:        omp_core::Secret::from(b"hf-fake-extension".to_vec()),
			expires_at_ms: None,
		})
		.expect("extension store");
	assert_eq!(extension.kind.as_str(), "api-key");

	let declared = catalog
		.provider(ProviderId::from_ref("huggingface"))
		.expect("huggingface")
		.auth[0]
		.clone();
	assert_eq!(
		catalog.auth_spec(&declared).expect("declared auth").kind,
		omp_catalog::provider::AuthSpecKind::Bearer
	);
	let engine = SecretLoginEngine::new(
		AuthMethod::ApiKey,
		Str::new_static("login"),
		Arc::clone(&catalog),
		Arc::clone(&store),
		accounts,
	)
	.expect("API-key login engine");
	let session = engine
		.begin(LoginRequest { provider: ProviderId::from("huggingface"), method: None }, declared)
		.await
		.expect("login starts");
	assert_eq!(answer_key_login(session, "hf-fake-login").await.as_str(), "huggingface:login");
	let login = lease_configured(&catalog, &store, "huggingface:login")
		.await
		.expect("the login leases on the configured auth");
	assert_eq!(login.kind(), CredentialKind::ApiKey);
	assert_eq!(authorization(&catalog, &login), "Bearer hf-fake-login");
}

/// The production composition re-stores a row stored under a kind its
/// provider's routes do not lease before any request leases it, and a second
/// composition finds nothing left to re-store.
#[tokio::test]
async fn composition_restores_a_row_its_routes_do_not_lease() {
	// SAFETY: nextest runs each test in its own process, and this runs before
	// the composition spawns anything that reads the environment.
	unsafe { std::env::set_var("OMP_ANTIGRAVITY_VERSION", "1.0.0") };
	let data_dir = tempfile::tempdir().expect("scratch data dir");
	fs::write(data_dir.path().join("models.toml"), HUGGINGFACE_API_KEY_ROUTES).expect("models.toml");
	let (store, accounts) = stores(data_dir.path());
	let earlier = earlier_bearer_login(&store, &accounts, b"hf-fake-composed");

	production_registry(data_dir.path(), Arc::clone(&store))
		.await
		.expect("production composition");

	let repaired = store
		.metadata(&earlier.account_id)
		.expect("metadata")
		.expect("row");
	assert_eq!(repaired.kind.as_str(), "api-key");
	assert_eq!(repaired.generation, earlier.generation + 1);
	let catalog = production_catalog(data_dir.path()).expect("production catalog");
	let lease = lease_configured(&catalog, &store, "huggingface:api-key")
		.await
		.expect("the re-stored row leases");
	assert_eq!(authorization(&catalog, &lease), "Bearer hf-fake-composed");

	production_registry(data_dir.path(), Arc::clone(&store))
		.await
		.expect("second composition");
	assert_eq!(store.metadata(&earlier.account_id).expect("metadata"), Some(repaired));
}

/// Anthropic's bundled routes take a key header, and a `models.toml` auth
/// that replaces them never moves its stored key: under `auth = 'bearer'` the
/// key would otherwise be re-stored as `bearer`, which Anthropic's OAuth
/// authentication leases once the auth is removed, sending the key as a
/// bearer token. Composing with the auth and again without it leaves the row
/// as it was, a key written under the auth keeps its kind too, and the row
/// leases on the key header again.
#[tokio::test]
async fn a_configured_auth_never_moves_a_key_its_bundled_routes_take() {
	// SAFETY: nextest runs each test in its own process, and this runs before
	// the composition spawns anything that reads the environment.
	unsafe { std::env::set_var("OMP_ANTIGRAVITY_VERSION", "1.0.0") };
	let data_dir = tempfile::tempdir().expect("scratch data dir");
	let models = data_dir.path().join("models.toml");
	fs::write(&models, "[providers.anthropic]\nbaseUrl='http://127.0.0.1:9'\nauth='bearer'\n")
		.expect("models.toml");
	let (store, accounts) = stores(data_dir.path());
	let key = earlier_row(&store, &accounts, "anthropic", "api-key", "api-key", b"sk-ant-fake-kept");

	production_registry(data_dir.path(), Arc::clone(&store))
		.await
		.expect("composition under the configured auth");
	assert_eq!(store.metadata(&key.account_id).expect("metadata"), Some(key.clone()));
	let configured = production_catalog(data_dir.path()).expect("configured catalog");
	let control = AuthControlHandle::offline(configured, Arc::clone(&store), accounts.clone())
		.expect("control");
	let (written, _) = control
		.store(CredentialControlWrite {
			provider:      ProviderId::from("anthropic"),
			principal:     omp_ai::PrincipalId::from("extension"),
			identity:      Some(Str::new_static("extension")),
			kind:          Str::new_static("api-key"),
			secret:        omp_core::Secret::from(b"sk-ant-fake-written".to_vec()),
			expires_at_ms: None,
		})
		.expect("extension store");
	assert_eq!(written.kind.as_str(), "api-key");

	fs::write(&models, "[providers.anthropic]\nbaseUrl='http://127.0.0.1:9'\n")
		.expect("auth removed");
	production_registry(data_dir.path(), Arc::clone(&store))
		.await
		.expect("composition without the configured auth");
	assert_eq!(store.metadata(&key.account_id).expect("metadata"), Some(key.clone()));
	let catalog = production_catalog(data_dir.path()).expect("catalog");
	let header = provider_auth_specs(&catalog, ProviderId::from_ref("anthropic"))
		.find(|spec| spec.kind == omp_catalog::provider::AuthSpecKind::ApiKey)
		.expect("Anthropic's key authentication");
	let lease = lease_on(&catalog, &store, header.id.clone(), "anthropic:api-key")
		.await
		.expect("the key leases on the key header");
	assert_eq!(lease.kind(), CredentialKind::ApiKey);
	let name = header.header_name.clone().expect("a header authentication");
	assert_eq!(applied_header(&catalog, &header.id, &lease, name.as_str()), "sk-ant-fake-kept");
}

/// Under `[providers.anthropic] auth = 'bearer'` no route of Anthropic takes
/// an API key, and omp keeps an Anthropic key's kind, so an API-key `/login`
/// (Anthropic's declared `x-api-key` authentication) is refused before it
/// prompts and stores nothing, naming the variable the configured auth reads.
/// Without the auth the same login stores the key its routes take.
#[tokio::test]
async fn a_login_no_route_would_take_is_refused() {
	let configured =
		Arc::new(configured("[providers.anthropic]\nbaseUrl='http://127.0.0.1:9'\nauth='bearer'\n"));
	let data_dir = tempfile::tempdir().expect("scratch data dir");
	let (store, accounts) = stores(data_dir.path());
	let anthropic = ProviderId::from("anthropic");
	let key_auth = configured
		.provider(&anthropic)
		.expect("anthropic")
		.auth
		.iter()
		.find(|id| {
			configured.auth_spec(id).expect("declared auth").kind
				== omp_catalog::provider::AuthSpecKind::ApiKey
		})
		.expect("Anthropic's key authentication")
		.clone();
	let engine = |catalog: Arc<Catalog>| {
		SecretLoginEngine::new(
			AuthMethod::ApiKey,
			Str::new_static("login"),
			catalog,
			Arc::clone(&store),
			accounts.clone(),
		)
		.expect("API-key login engine")
	};
	let login = LoginRequest { provider: anthropic.clone(), method: None };

	let Err(refused) = engine(Arc::clone(&configured))
		.begin(login.clone(), key_auth.clone())
		.await
	else {
		panic!("a key no route takes is refused");
	};
	assert_eq!(refused.code.as_deref(), Some("login_kind_not_leased"));
	assert_eq!(
		refused.detail_ref(),
		Some(&omp_ai::ErrorDetail::LoginKindNotLeased {
			provider: anthropic.clone(),
			kind:     CredentialKind::ApiKey,
			remedy:   omp_ai::UnleasedLoginRemedy::Variable {
				kind:     CredentialKind::Bearer,
				variable: Str::new_static("OMP_ANTHROPIC_API_KEY"),
			},
		})
	);
	let rendered = refused.to_string();
	assert!(
		rendered.contains(
			"the routes of anthropic take no stored api-key under the current configuration"
		) && rendered.contains("set OMP_ANTHROPIC_API_KEY to give them the bearer they take"),
		"{rendered}"
	);
	assert!(store.list_metadata().expect("rows").is_empty(), "the login stored nothing");

	let session = engine(Arc::new(Catalog::embedded().clone()))
		.begin(login, key_auth)
		.await
		.expect("the bundled routes take a key");
	let account = answer_key_login(session, "sk-ant-fake-login").await;
	assert_eq!(
		store
			.metadata(&account)
			.expect("metadata")
			.expect("row")
			.kind
			.as_str(),
		"api-key"
	);
}

/// A composition whose key source is unavailable (no terminal) cannot
/// decrypt a row to re-store it, and still composes: the row is left as it
/// was, and the next composition that can decrypt it re-stores it.
#[tokio::test]
async fn a_locked_store_composes_and_leaves_rows_for_a_later_repair() {
	// SAFETY: nextest runs each test in its own process, and this runs before
	// the composition spawns anything that reads the environment.
	unsafe { std::env::set_var("OMP_ANTIGRAVITY_VERSION", "1.0.0") };
	let data_dir = tempfile::tempdir().expect("scratch data dir");
	// The bundled bearer authentication, on a closed local port.
	fs::write(
		data_dir.path().join("models.toml"),
		"[providers.huggingface]\nbaseUrl='http://127.0.0.1:9/v1'\n",
	)
	.expect("models.toml");
	let (store, accounts) = stores(data_dir.path());
	// An API key the v1 importer stored as `api-key` for Hugging Face, whose
	// routes lease a bearer token.
	let key =
		earlier_row(&store, &accounts, "huggingface", "agent-db", "api-key", b"hf-fake-locked");
	let locked = Arc::new(
		CredentialStore::open(data_dir.path().join("credentials.db"), Arc::new(UnavailableKeySource))
			.expect("locked store"),
	);

	production_registry(data_dir.path(), locked)
		.await
		.expect("a store this process cannot decrypt still composes");
	assert_eq!(store.metadata(&key.account_id).expect("metadata"), Some(key.clone()));

	production_registry(data_dir.path(), Arc::clone(&store))
		.await
		.expect("composition that can decrypt");
	let repaired = store
		.metadata(&key.account_id)
		.expect("metadata")
		.expect("row");
	assert_eq!(repaired.kind.as_str(), "bearer");
	assert_eq!(repaired.generation, key.generation + 1);
}

/// A `models.toml` auth leaves no lasting change on a stored key or token:
/// for a bundled provider of every authentication shape, a key or token
/// written under `auth = 'apiKey'` or `auth = 'bearer'` and then re-stored by
/// a launch without the auth leases, on each of the provider's bundled
/// authentications, exactly as the same key or token written without the auth.
/// So removing the auth sends every stored secret as it would have been sent
/// had the auth never been configured, whatever the auth made of its kind
/// meanwhile.
#[tokio::test]
async fn a_configured_auth_leaves_no_lasting_kind_change() {
	let bundled = Catalog::embedded();
	// One file per auth configures it for every provider; each provider's auth
	// replaces only its own routes'.
	let configured_by = |auth: &str| {
		let mut models = String::new();
		for provider in bundled.providers() {
			writeln!(
				models,
				"[providers.\"{}\"]\nbaseUrl='http://127.0.0.1:9'\nauth='{auth}'",
				provider.id
			)
			.expect("write to a string");
		}
		Arc::new(configured(&models))
	};
	let configured = [("apiKey", configured_by("apiKey")), ("bearer", configured_by("bearer"))];
	// One provider per authentication shape: the authentications its routes
	// lease, bundled and under each auth (kind, placement, and whether they
	// read the store, in order). Providers of one shape are stored and leased
	// alike.
	let shape = |catalog: &Catalog, provider: &ProviderId<str>| {
		provider_auth_specs(catalog, provider)
			.map(|spec| {
				(
					spec.kind,
					spec.header_name.as_deref().map(str::to_ascii_lowercase),
					spec.prefix.clone(),
					spec.query_parameter.is_some(),
					spec.sealed_body.is_some(),
					spec
						.credential_sources
						.iter()
						.any(|source| matches!(source, CredentialSourceSpec::Stored)),
				)
			})
			.collect::<Vec<_>>()
	};
	let mut shapes = std::collections::BTreeSet::new();
	let providers = bundled
		.providers()
		.iter()
		.filter(|provider| {
			shapes.insert(format!("{:?}", [
				shape(bundled, &provider.id),
				shape(&configured[0].1, &provider.id),
				shape(&configured[1].1, &provider.id),
			]))
		})
		.collect::<Vec<_>>();

	let data_dir = tempfile::tempdir().expect("scratch data dir");
	let (store, accounts) = stores(data_dir.path());
	let write = |control: &AuthControlHandle, provider: &ProviderId, identity: String, kind| {
		control
			.store(CredentialControlWrite {
				provider:      provider.clone(),
				principal:     omp_ai::PrincipalId::from(identity.as_str()),
				identity:      Some(Str::from(identity)),
				kind:          Str::new_static(kind),
				secret:        omp_core::Secret::from(b"fake-configured-secret".to_vec()),
				expires_at_ms: None,
			})
			.expect("write")
			.0
	};
	let unconfigured =
		AuthControlHandle::offline(Arc::new(bundled.clone()), Arc::clone(&store), accounts.clone())
			.expect("bundled control");
	let controls = configured.each_ref().map(|(auth, catalog)| {
		let control =
			AuthControlHandle::offline(Arc::clone(catalog), Arc::clone(&store), accounts.clone())
				.expect("configured control");
		(*auth, control)
	});
	// (provider, the account written under an auth, the one written without)
	let mut pairs = Vec::new();
	let mut moved = 0_usize;
	for provider in &providers {
		for written in ["api-key", "bearer"] {
			let without = write(&unconfigured, &provider.id, format!("bundled-{written}"), written);
			for (auth, control) in &controls {
				let under_auth = write(control, &provider.id, format!("{auth}-{written}"), written);
				moved += usize::from(under_auth.kind.as_str() != written);
				pairs.push((provider.id.clone(), under_auth.account_id, without.account_id.clone()));
			}
		}
	}
	assert!(moved > 0, "some auth moves a row, or this proves nothing");

	let repairs = unconfigured
		.repair_static_secret_kinds()
		.expect("launch without the auth");
	assert!(repairs.failed.is_empty(), "{:?}", repairs.failed);
	let broker =
		CredentialBroker::from_catalog(bundled, Arc::new(NoEnvironment), CredentialBrokerEngines {
			stored: Some(Arc::new(StoredCredentialSource::new(Arc::clone(&store)))),
			..CredentialBrokerEngines::default()
		})
		.expect("broker");
	let leased = |spec: &AuthSpecId, account: &omp_ai::AccountId| {
		let lease = broker.lease(CredentialNeed {
			spec:        spec.clone(),
			account:     Some(account.clone()),
			principal:   None,
			valid_after: SystemTime::now(),
		});
		async move { lease.await.ok().map(|lease| lease.kind()) }
	};
	let kind = |account: &omp_ai::AccountId| {
		store
			.metadata(account)
			.expect("metadata")
			.expect("row")
			.kind
	};
	for (provider, under_auth, without) in &pairs {
		// Two rows of one kind, secret, and expiry lease alike, so only rows
		// the launch left under different kinds need their leases compared.
		if kind(under_auth) == kind(without) {
			continue;
		}
		for spec in provider_auth_specs(bundled, provider) {
			assert_eq!(
				leased(&spec.id, under_auth).await,
				leased(&spec.id, without).await,
				"{under_auth} and {without} on {} ({:?})",
				spec.id,
				spec.kind
			);
		}
	}
}

/// A provider whose bundled routes take a bearer credential only from OAuth
/// keeps a key's kind under `auth = 'bearer'`: re-stored as `bearer`, the key
/// would lease on its OAuth authentication once the auth is removed, and be
/// sent where an OAuth access token goes.
#[tokio::test]
async fn a_configured_auth_never_moves_a_key_into_an_oauth_lease() {
	// SAFETY: nextest runs each test in its own process, and this runs before
	// the composition spawns anything that reads the environment.
	unsafe { std::env::set_var("OMP_ANTIGRAVITY_VERSION", "1.0.0") };
	let data_dir = tempfile::tempdir().expect("scratch data dir");
	let models = data_dir.path().join("models.toml");
	fs::write(
		&models,
		"[providers.google-antigravity]\nbaseUrl='http://127.0.0.1:9'\nauth='bearer'\n",
	)
	.expect("models.toml");
	let (store, accounts) = stores(data_dir.path());
	let key =
		earlier_row(&store, &accounts, "google-antigravity", "agent-db", "api-key", b"fake-key");

	production_registry(data_dir.path(), Arc::clone(&store))
		.await
		.expect("composition under the configured auth");
	assert_eq!(store.metadata(&key.account_id).expect("metadata"), Some(key.clone()));

	fs::remove_file(&models).expect("auth removed");
	production_registry(data_dir.path(), Arc::clone(&store))
		.await
		.expect("composition without the configured auth");
	assert_eq!(store.metadata(&key.account_id).expect("metadata"), Some(key));
	let catalog = production_catalog(data_dir.path()).expect("catalog");
	for spec in provider_auth_specs(&catalog, ProviderId::from_ref("google-antigravity")) {
		assert!(
			lease_on(&catalog, &store, spec.id.clone(), "google-antigravity:agent-db")
				.await
				.is_err(),
			"the key never leases on {} ({:?})",
			spec.id,
			spec.kind
		);
	}
}
