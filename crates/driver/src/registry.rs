//! Production inference and credential-service composition.

use std::{
	collections::{BTreeMap, BTreeSet},
	env,
	env::consts,
	fs,
	future::Future,
	io,
	io::IsTerminal as _,
	path::Path,
	sync::{Arc, LazyLock},
	time::Duration,
};

#[cfg(target_os = "macos")]
use omp_ai::auth::FallbackKeySource;
#[cfg(feature = "local-applefm")]
use omp_ai::provider::builtin::LocalRouteBackend;
#[cfg(feature = "local-applefm")]
use omp_ai::receipt::ReasonId;
use omp_ai::{
	Registry,
	account::{
		AccountPool, AccountStateStore, AccountStateStoreError, RefreshCoordinator, RefreshPolicy,
	},
	auth::{
		AlibabaTokenPlanLoginEngine, AlibabaTokenPlanShaper, AuthControlHandle, AuthLoginEngine,
		AuthManager, AuthManagerBuildError, AwsCredentialSource, CredentialAcquisitionLoginEngine,
		CredentialAcquisitionLoginEngineError, CredentialAffinityResolver, CredentialBroker,
		CredentialBrokerEngines, CredentialShaperRegistry, CredentialStore, FileCredentialKeySource,
		FileKeyError, GithubCopilotShaper, KeyError, KeySource, OAuthCustomDispatcher,
		OAuthLoginEngine, OAuthLoginEngineError, OsCredentialKeySource, ProviderShaper,
		RefreshingCredentialSource, SecretLoginEngine, SecretLoginEngineError, StoreError,
		StoredOAuthRefreshEngine, SystemOAuthClock, SystemOAuthHttpClient, UnavailableKeySource,
		oauth::OAuthCustomDispatchError,
	},
	call::AuthMethod,
	codec::google_cca::{
		AntigravityFingerprint, AntigravityPolicy, CcaHeaders, DEFAULT_ANTIGRAVITY_ARCH,
		DEFAULT_ANTIGRAVITY_CL, DEFAULT_ANTIGRAVITY_OS, DEFAULT_ANTIGRAVITY_VERSION,
	},
	id::AccountId,
	layer::{admission::AdmissionController, stack::BuiltinConfig},
	operation::usage::{
		ConsoleUsageFetcher, ConsoleUsageManager, UsageFetcherRegistry,
		alibaba_token_plan::AlibabaTokenPlanUsageFetcher,
		claude::ClaudeUsageFetcher,
		cursor::CursorUsageFetcher,
		gemini::GeminiUsageFetcher,
		github_copilot::GithubCopilotUsageFetcher,
		google_antigravity::GoogleAntigravityUsageFetcher,
		kimi::KimiUsageFetcher,
		minimax_code::MiniMaxCodeUsageFetcher,
		ollama::OllamaUsageFetcher,
		openai_codex::{CodexRedemption, CodexRedemptionReason, OpenAiCodexUsageFetcher},
		opencode_go::OpenCodeGoUsageFetcher,
		synthetic::SyntheticUsageFetcher,
		umans::UmansUsageFetcher,
		xai_oauth::XaiOauthUsageFetcher,
		zai::ZaiUsageFetcher,
	},
	provider::builtin::{
		AuthApplicationConfig, AzureEndpointConfig, GoogleCcaConfig, ProductionDependencies,
		discover_antigravity_version,
	},
	session::{ConversationError, ConversationSessionPlanner},
	transport::{http::HttpTransport, websocket_transport::WebSocketTransport},
};
use omp_catalog::{
	CatalogOverlay, ContextStrategy, DiscoveryDefaults, DiscoveryNormalizer, OverlaySource,
	OverlayStack, Pricing, ProvenanceKind, ProvenanceSource, UnsafeTrustScope,
	provider::AuthSpecKind, snapshot,
};
use omp_core::{Hash32, SecretString, Str, sf};
use omp_envd::browser_fetch::BrowserFetchAdapter;
use omp_serve::inference::InferenceRpc;
use tokio::time;

use crate::{auth_backend, auth_backend::GithubCredentialAuthority};

/// Credential database encryption-key source selected at startup.
#[derive(
	Clone,
	Copy,
	Debug,
	Default,
	Eq,
	PartialEq,
	serde::Deserialize,
	serde::Serialize,
	strum::Display,
	strum::EnumString,
	strum::IntoStaticStr,
	strum::VariantNames,
)]
#[serde(rename_all = "kebab-case")]
#[strum(serialize_all = "kebab-case", ascii_case_insensitive)]
pub enum CredentialKeySourceSetting {
	/// Select the local file only for an interactive owner.
	#[default]
	Auto,
	/// Refuse durable secret reads and writes.
	Unavailable,
	/// Use an owner-only file beside the credential database.
	LocalFile,
	/// Use the operating-system credential service.
	OsKeychain,
}

omp_con::con_enum!(CredentialKeySourceSetting);

omp_con::var! {
	/// Encryption-key source for the durable credential database.
	pub static SV_CREDENTIAL_KEY_SOURCE = sv_credential_key_source: CredentialKeySourceSetting {
		default: CredentialKeySourceSetting::Auto,
		flags: archive,
	};
}

const KEY_SOURCE_ENV: &str = "OMP_LLM_KEY_SOURCE";
const KEYCHAIN_SERVICE: &str = "dev.omp.llm";
const KEYCHAIN_ACCOUNT: &str = "credential-store-master";
const ANTIGRAVITY_VERSION_ENV: &str = "OMP_ANTIGRAVITY_VERSION";
const ANTIGRAVITY_CL_ENV: &str = "OMP_ANTIGRAVITY_CL";
const ANTIGRAVITY_OS_ENV: &str = "OMP_ANTIGRAVITY_OS";
const ANTIGRAVITY_ARCH_ENV: &str = "OMP_ANTIGRAVITY_ARCH";
const ANTIGRAVITY_VERSION_CACHE_FILE: &str = "antigravity-version";
const ANTIGRAVITY_VERSION_FETCH_TIMEOUT: Duration = Duration::from_secs(5);
const MODEL_DISCOVERY_CACHE_TTL: Duration = Duration::from_secs(2 * 60 * 60);
const AZURE_BASE_URL_ENV: &str = "OMP_AZURE_OPENAI_BASE_URL";
const AZURE_RESOURCE_NAME_ENV: &str = "OMP_AZURE_OPENAI_RESOURCE_NAME";
const AZURE_DEPLOYMENT_ENV: &str = "OMP_AZURE_OPENAI_DEPLOYMENT";
const AZURE_API_VERSION_ENV: &str = "OMP_AZURE_OPENAI_API_VERSION";

/// Production inference-registry or credential-state construction failure.
#[derive(Debug, thiserror::Error)]
pub enum RegistryError {
	/// Durable state directory could not be prepared.
	#[error("could not prepare inference state directory")]
	PrepareState(#[source] io::Error),
	/// The checked-in catalog snapshot is invalid.
	#[error("embedded catalog snapshot is invalid")]
	Catalog(#[source] &'static omp_catalog::snapshot::SnapshotError),
	/// Native configuration or discovery cache could not be composed.
	#[error("live catalog composition failed")]
	CatalogComposition(#[source] Box<dyn std::error::Error + Send + Sync + 'static>),
	/// Registry construction or route service failed.
	#[error(transparent)]
	Inference(#[from] Box<omp_ai::Error>),
	/// Encrypted credential state could not be opened.
	#[error(transparent)]
	CredentialStore(#[from] StoreError),
	/// Credential encryption key provisioning failed.
	#[error(transparent)]
	CredentialKey(#[from] KeyError),
	/// Owner-only credential key file provisioning failed.
	#[error(transparent)]
	CredentialKeyFile(#[from] FileKeyError),
	/// Console policy could not be resolved.
	#[error(transparent)]
	Console(#[from] omp_con::ConError),
	/// Durable account state could not be opened.
	#[error(transparent)]
	AccountState(#[from] AccountStateStoreError),
	/// A static secret login engine was invalid.
	#[error(transparent)]
	SecretLogin(#[from] SecretLoginEngineError),
	/// A credential-acquisition engine was invalid.
	#[error(transparent)]
	CredentialAcquisitionLogin(#[from] CredentialAcquisitionLoginEngineError),
	/// An OAuth login engine was invalid.
	#[error(transparent)]
	OAuthLogin(#[from] OAuthLoginEngineError),
	/// A custom OAuth exchange handler could not be registered.
	#[error(transparent)]
	OAuthCustom(#[from] OAuthCustomDispatchError),
	/// Refresh coordination policy was invalid.
	#[error(transparent)]
	RefreshPolicy(#[from] omp_ai::account::RefreshPolicyError),
	/// Catalog authentication could not be assembled.
	#[error(transparent)]
	AuthManager(#[from] AuthManagerBuildError),
	/// Durable conversation state could not be opened.
	#[error(transparent)]
	Conversation(#[from] ConversationError),
}

impl From<omp_ai::Error> for RegistryError {
	fn from(error: omp_ai::Error) -> Self {
		Self::Inference(Box::new(error))
	}
}

/// Selection of the credential encryption-key source.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum CredentialKeyMode {
	/// Fail closed without accessing persistent encryption-key material.
	#[default]
	Unavailable,
	/// Use an owner-only key file beside the credential database.
	LocalFile,
	/// Use the operating-system credential service after explicit opt-in.
	OsKeychain,
}

impl CredentialKeyMode {
	/// Selects the key source from an explicit environment override followed by
	/// the typed settings value. Malformed values fail closed; the `auto`
	/// default uses an owner-only local key file as the filesystem security
	/// boundary for interactive processes and fails closed for unattended
	/// ones.
	pub fn from_configuration(configured: CredentialKeySourceSetting) -> Self {
		let interactive = io::stdin().is_terminal() && io::stderr().is_terminal();
		Self::resolve(env::var(KEY_SOURCE_ENV).ok().as_deref(), configured, interactive)
	}

	fn resolve(
		explicit: Option<&str>,
		configured: CredentialKeySourceSetting,
		interactive: bool,
	) -> Self {
		let auto = if interactive {
			Self::LocalFile
		} else {
			Self::Unavailable
		};
		match explicit.map(str::trim) {
			Some("local-file") => Self::LocalFile,
			Some("os-keychain") => Self::OsKeychain,
			Some("auto") => auto,
			Some("unavailable") | Some(_) => Self::Unavailable,
			None => match configured {
				CredentialKeySourceSetting::Auto => auto,
				CredentialKeySourceSetting::Unavailable => Self::Unavailable,
				CredentialKeySourceSetting::LocalFile => Self::LocalFile,
				CredentialKeySourceSetting::OsKeychain => Self::OsKeychain,
			},
		}
	}
}

fn placeholder_affinity_key() -> &'static str {
	static KEY: LazyLock<String> = LazyLock::new(|| match omp_cache::secret_key::load_or_create() {
		Ok(key) => key,
		Err(error) => {
			tracing::warn!(%error, "could not persist credential-affinity key; using process-local identity");
			omp_core::Ulid::generate().to_string()
		},
	});
	KEY.as_str()
}

/// Opens the encrypted credential database using default console policy.
pub fn open_credential_store(
	database: impl AsRef<Path>,
) -> Result<Arc<CredentialStore>, RegistryError> {
	open_credential_store_from_con(database, &omp_con::Ctx::new())
}

/// Opens the encrypted credential database using the effective console policy.
pub fn open_credential_store_from_con(
	database: impl AsRef<Path>,
	ctx: &omp_con::Ctx,
) -> Result<Arc<CredentialStore>, RegistryError> {
	let configured = SV_CREDENTIAL_KEY_SOURCE.get(ctx);
	open_credential_store_with_mode(
		database.as_ref(),
		CredentialKeyMode::from_configuration(configured),
	)
}

fn open_credential_store_with_mode(
	database: &Path,
	mode: CredentialKeyMode,
) -> Result<Arc<CredentialStore>, RegistryError> {
	match mode {
		CredentialKeyMode::Unavailable => {
			open_credential_store_with_key_source(database, Arc::new(UnavailableKeySource))
		},
		CredentialKeyMode::LocalFile => open_local_file_credential_store(database.as_ref()),
		CredentialKeyMode::OsKeychain => {
			let key_source = OsCredentialKeySource::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
			if key_source.active_key().is_err() {
				key_source.rotate()?;
			}
			open_credential_store_with_key_source(database, Arc::new(key_source))
		},
	}
}

fn open_local_file_credential_store(
	database: &Path,
) -> Result<Arc<CredentialStore>, RegistryError> {
	let file = FileCredentialKeySource::open(database.with_extension("key"))?;
	#[cfg(target_os = "macos")]
	{
		// One-time clean cutover for credentials written by the old interactive
		// default. The fallback is consulted only for legacy key identifiers;
		// after this transaction all rows use the file key and later rebuilds
		// never contact Keychain. Denial aborts the transaction without losing
		// the existing encrypted records.
		let source = FallbackKeySource::new(
			file,
			OsCredentialKeySource::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT),
		);
		let store = open_credential_store_with_key_source(database, Arc::new(source))?;
		store.rotate_keys()?;
		Ok(store)
	}
	#[cfg(not(target_os = "macos"))]
	{
		open_credential_store_with_key_source(database, Arc::new(file))
	}
}

/// Opens encrypted credential state with an explicitly supplied non-secret key
/// source.
pub fn open_credential_store_with_key_source(
	database: impl AsRef<Path>,
	key_source: Arc<dyn KeySource>,
) -> Result<Arc<CredentialStore>, RegistryError> {
	Ok(Arc::new(CredentialStore::open(database.as_ref(), key_source)?))
}

/// Returns the immutable production catalog with configured and fresh
/// runtime-discovery layers materialized in explicit precedence order.
pub fn production_catalog(data_dir: &Path) -> Result<Arc<snapshot::Catalog>, RegistryError> {
	let bundled = snapshot::Catalog::try_embedded()
		.map_err(RegistryError::Catalog)?
		.clone();
	let loaded = if data_dir.exists() {
		crate::discovery::models::load_or_import_legacy(data_dir).map_err(catalog_composition)?
	} else {
		None
	};
	let user_overlay = loaded
		.as_ref()
		.map(|loaded| crate::discovery::models::lower_user_overlay(&loaded.config))
		.transpose()
		.map_err(catalog_composition)?;
	let configured = if let Some(overlay) = &user_overlay {
		bundled
			.with_overlay_stack(
				&OverlayStack::from_layers([(OverlaySource::UserConfig, overlay.clone())]),
				UnsafeTrustScope::ALL,
			)
			.map_err(catalog_composition)?
	} else {
		bundled
	};
	let cache_path = data_dir.join("models.db");
	if !cache_path.exists() {
		return Ok(Arc::new(configured));
	}
	let store = omp_ai::discovery::DiscoveryStore::open(&cache_path).map_err(catalog_composition)?;
	let now_ms = std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.unwrap_or_default()
		.as_millis()
		.try_into()
		.unwrap_or(u64::MAX);
	let probes = crate::discovery::models::discovery_probes(
		loaded.as_ref().map(|loaded| &loaded.config),
		&configured,
	)
	.map_err(catalog_composition)?;
	let mut cache_keys = BTreeSet::new();
	for route in configured.routes() {
		if route.discovery.is_some() {
			cache_keys.insert(omp_ai::discovery::DiscoveryCacheKey::provider(route.provider.clone()));
		}
	}
	for probe in probes {
		cache_keys
			.insert(omp_ai::discovery::DiscoveryCacheKey::endpoint(probe.provider, &probe.endpoint));
	}
	let mut normalized = Vec::new();
	for key in cache_keys {
		let Some(cached) = store
			.load_fresh(&key, now_ms)
			.map_err(catalog_composition)?
		else {
			continue;
		};
		let Some(provider) = configured.provider(&key.provider) else {
			continue;
		};
		let defaults = configured
			.discovery_defaults(&key.provider)
			.cloned()
			.unwrap_or_else(|| DiscoveryDefaults {
				wire_policy:          provider.wire_policy.clone(),
				extended_wire_policy: None,
				context:              ContextStrategy::Replay,
				thinking:             None,
				pricing:              Pricing::default(),
			});
		let explicit = loaded
			.as_ref()
			.and_then(|loaded| loaded.config.providers.get(key.provider.as_str()));
		for record in DiscoveryNormalizer::new(defaults)
			.normalize_batch(&cached.rows)
			.map_err(catalog_composition)?
		{
			let explicitly_configured = explicit.is_some_and(|provider| {
				provider.models.contains_key(record.model.key.as_str())
					|| provider
						.model_overrides
						.contains_key(record.model.key.as_str())
			});
			if !explicitly_configured {
				normalized.push(record.into_catalog_overlay());
			}
		}
	}
	if normalized.is_empty() {
		return Ok(Arc::new(configured));
	}
	let overlay = CatalogOverlay::combined(
		ProvenanceSource {
			kind:           ProvenanceKind::Discovered,
			origin:         Str::new_static("models.db"),
			revision:       None,
			confidence:     omp_catalog::EvidenceConfidence::Inferred,
			observed_at_ms: Some(now_ms),
		},
		normalized,
	);
	let catalog = configured
		.with_overlay_stack(
			&OverlayStack::from_layers([(OverlaySource::DiskCache, overlay)]),
			UnsafeTrustScope::NONE,
		)
		.map_err(catalog_composition)?;
	Ok(Arc::new(catalog))
}

fn catalog_composition(source: impl std::error::Error + Send + Sync + 'static) -> RegistryError {
	RegistryError::CatalogComposition(Box::new(source))
}

async fn refresh_model_discovery_cache(
	data_dir: &Path,
	catalog: Arc<snapshot::Catalog>,
) -> Result<Arc<snapshot::Catalog>, RegistryError> {
	use omp_ai::discovery::{
		DiscoveryCacheKey, DiscoveryStore, DiscoveryStoreError, ProviderDiscoveryState,
		ProviderLifecycle,
	};

	let loaded =
		crate::discovery::models::load_or_import_legacy(data_dir).map_err(catalog_composition)?;
	let probes = crate::discovery::models::discovery_probes(
		loaded.as_ref().map(|loaded| &loaded.config),
		&catalog,
	)
	.map_err(catalog_composition)?;
	if probes.is_empty() {
		return Ok(catalog);
	}
	let store =
		Arc::new(DiscoveryStore::open(&data_dir.join("models.db")).map_err(catalog_composition)?);
	let now_ms = std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.unwrap_or_default()
		.as_millis()
		.try_into()
		.unwrap_or(u64::MAX);
	store.prune_expired(now_ms).map_err(catalog_composition)?;
	let http = omp_envd::model_discovery::ModelDiscoveryHttpHost::new();
	let mut pending = Vec::new();
	for probe in probes {
		let key = DiscoveryCacheKey::endpoint(probe.provider.clone(), &probe.endpoint);
		if store
			.load_fresh(&key, now_ms)
			.map_err(catalog_composition)?
			.is_some()
		{
			continue;
		}
		if store
			.lifecycle(&key)
			.map_err(catalog_composition)?
			.is_some_and(|state| {
				state.state == ProviderDiscoveryState::Failed
					&& state.retry_at_ms.is_some_and(|retry| retry > now_ms)
			}) {
			continue;
		}
		store
			.set_lifecycle(&ProviderLifecycle {
				provider:       probe.provider.clone(),
				cache_scope:    key.credential_scope.clone(),
				state:          ProviderDiscoveryState::Probing,
				error_code:     None,
				observed_at_ms: now_ms,
				retry_at_ms:    None,
			})
			.map_err(catalog_composition)?;
		let store = Arc::clone(&store);
		let http = http.clone();
		pending.push(async move {
			let provider = probe.provider.clone();
			match probe
				.probe(&http, tokio_util::sync::CancellationToken::new())
				.await
			{
				Ok(mut rows) => {
					crate::discovery::models::apply_runtime_discovery_overrides(&probe, &mut rows);
					for row in &mut rows {
						row.observed_at_ms = Some(now_ms);
					}
					store.publish(&key, &rows, now_ms, MODEL_DISCOVERY_CACHE_TTL)?;
					Ok::<bool, DiscoveryStoreError>(true)
				},
				Err(error) => {
					let error_code: &'static str = error.into();
					tracing::debug!(
						provider = %provider,
						error_code,
						"bounded model discovery probe was unavailable"
					);
					store.set_lifecycle(&ProviderLifecycle {
						provider,
						cache_scope: key.credential_scope.clone(),
						state: ProviderDiscoveryState::Failed,
						error_code: Some(Str::new_static(error_code)),
						observed_at_ms: now_ms,
						retry_at_ms: Some(now_ms.saturating_add(5 * 60 * 1000)),
					})?;
					Ok::<bool, DiscoveryStoreError>(false)
				},
			}
		});
	}
	let mut changed = false;
	for result in futures::future::join_all(pending).await {
		changed |= result.map_err(catalog_composition)?;
	}
	if changed {
		production_catalog(data_dir)
	} else {
		Ok(catalog)
	}
}

/// Builds the production inference registry over durable daemon state.
pub async fn production_registry(
	data_dir: &Path,
	credential_store: Arc<CredentialStore>,
) -> Result<Registry, RegistryError> {
	production_registry_from_con(data_dir, credential_store, &omp_con::Ctx::new()).await
}

/// Builds the production inference registry from the effective console context.
pub async fn production_registry_from_con(
	data_dir: &Path,
	credential_store: Arc<CredentialStore>,
	ctx: &omp_con::Ctx,
) -> Result<Registry, RegistryError> {
	production_assembly_for_session(
		data_dir,
		credential_store,
		None,
		UsageFetcherRegistry::default(),
		inference_settings(ctx, None),
	)
	.await
	.map(|(registry, ..)| registry)
}
/// Builds the production console-usage authority over the canonical
/// credential and account stores.
pub async fn production_usage_manager(
	data_dir: &Path,
) -> Result<ConsoleUsageManager, RegistryError> {
	let credential_store = open_credential_store(data_dir.join("credentials.db"))?;
	production_assembly(data_dir, credential_store)
		.await
		.map(|(_, _, _, _, _, usage, ..)| usage)
}

/// Redeems one saved Codex reset for an exact durable account.
pub async fn redeem_codex_reset(
	data_dir: &Path,
	account: &AccountId<str>,
) -> Result<Option<bool>, RegistryError> {
	let Some(service) = production_codex_redemption(data_dir)? else {
		return Ok(None);
	};
	Ok(Some(
		service
			.redeem_account(CodexRedemptionReason::Restore, account)
			.await,
	))
}

fn production_codex_redemption(data_dir: &Path) -> Result<Option<CodexRedemption>, RegistryError> {
	let catalog = snapshot::Catalog::try_embedded().map_err(RegistryError::Catalog)?;
	let credential_store = open_credential_store(data_dir.join("credentials.db"))?;
	let stored = Arc::new(auth_backend::combined_authority(credential_store));
	let credentials = CredentialBroker::system(catalog, CredentialBrokerEngines {
		stored: Some(stored),
		..CredentialBrokerEngines::default()
	})
	.map_err(|_| {
		RegistryError::Inference(Box::new(omp_ai::Error::planning(
			omp_ai::ErrorKind::InvalidRequest,
			omp_ai::ErrorDetail::target(sf!("catalog-credential-broker-invalid")),
			Default::default(),
		)))
	})?;
	let accounts = AccountPool::with_store(Arc::new(AccountStateStore::open(
		&data_dir.join("credentials.db"),
	)?))?;
	let http = Arc::new(SystemOAuthHttpClient::new());
	Ok(CodexRedemption::from_catalog(catalog, credentials, accounts, http))
}

/// Builds the production inference registry and exposes a clone of its one
/// authentication manager to the stdio RPC host.
pub async fn production_rpc_registry(
	data_dir: &Path,
	credential_store: Arc<CredentialStore>,
) -> Result<(Registry, AuthManager), RegistryError> {
	production_rpc_registry_from_con(data_dir, credential_store, &omp_con::Ctx::new(), None).await
}

/// Builds the RPC registry from the effective console context.
pub async fn production_rpc_registry_from_con(
	data_dir: &Path,
	credential_store: Arc<CredentialStore>,
	ctx: &omp_con::Ctx,
	project_root: Option<&Path>,
) -> Result<(Registry, AuthManager), RegistryError> {
	production_assembly_for_session(
		data_dir,
		credential_store,
		None,
		UsageFetcherRegistry::default(),
		inference_settings(ctx, project_root),
	)
	.await
	.map(|(registry, _, _, _, auth, ..)| (registry, auth))
}

/// Invocation-owned inference values that must not enter agent or durable
/// state.
#[derive(Default)]
pub struct InferenceSessionOverrides {
	/// Provider pinned by an invocation API-key lease.
	pub provider:                Option<omp_catalog::ProviderId>,
	/// Generic API key held only by the session's credential broker overlay.
	pub api_key:                 Option<SecretString>,
	/// Opaque prompt-cache identity lowered by compatible codecs.
	pub prompt_cache_affinity:   Option<Str>,
	/// Shared extension-host usage registry allocated before inference assembly.
	pub usage_fetchers:          Option<UsageFetcherRegistry>,
	/// Session-owned provider response hook sink.
	pub provider_response_hooks: Option<omp_ai::ProviderResponseHooks>,
	/// Catalog composed with frozen extension providers before model selection.
	pub catalog:                 Option<Arc<snapshot::Catalog>>,
	/// Effective console context for the session.
	pub con:                     Option<Arc<omp_con::Ctx>>,
}

/// Session-owned production inference authorities assembled from one credential
/// owner.
pub struct ProductionInference {
	/// Immutable registry used by direct chat and provider CONTROL projection.
	pub registry:             Registry,
	/// Cloneable route composition retained for atomic provider registry
	/// rebuilds.
	pub builtins:             BuiltinConfig,
	/// RPC facade sharing the registry's route services and conversation owner.
	pub rpc:                  InferenceRpc,
	/// Narrow GitHub URL credential projection over the canonical encrypted
	/// store.
	pub credential_authority: Arc<dyn omp_envd::github_url::CredentialAuthority>,
	/// Same encrypted authority used for MCP native-key import and OAuth leases.
	pub mcp_authority:        Arc<auth_backend::CombinedAuthAuthority>,
	/// MCP OAuth coordinator over that exact authority.
	pub mcp_oauth:            Arc<omp_envd::mcp::oauth::McpOAuth>,
	/// Authentication owner assembled into the registry's production route
	/// stack.
	pub auth_manager:         AuthManager,
	/// Lifecycle CONTROL view of that exact authentication owner.
	pub auth_control:         AuthControlHandle,
	/// Shared provider usage registry accepting extension-scoped overlays.
	pub usage_fetchers:       UsageFetcherRegistry,
}

/// Builds the production inference RPC authority used by the gateway and chat.
pub async fn production_inference(
	data_dir: &Path,
	tool_registry: Arc<omp_tool::Registry>,
	project_root: Option<&Path>,
) -> Result<ProductionInference, RegistryError> {
	production_inference_from_con(
		data_dir,
		tool_registry,
		project_root,
		Arc::new(omp_con::Ctx::new()),
	)
	.await
}

/// Builds the production inference RPC authority from the process console.
pub async fn production_inference_from_con(
	data_dir: &Path,
	tool_registry: Arc<omp_tool::Registry>,
	project_root: Option<&Path>,
	ctx: Arc<omp_con::Ctx>,
) -> Result<ProductionInference, RegistryError> {
	production_inference_for_session(
		data_dir,
		tool_registry,
		project_root,
		InferenceSessionOverrides { con: Some(ctx), ..Default::default() },
	)
	.await
}

/// Builds a session-owned production inference stack with ephemeral overrides.
#[tracing::instrument(
	level = "debug",
	skip_all,
	fields(
		data_dir = %data_dir.display(),
		project_root = ?project_root,
		provider = ?overrides.provider.as_ref(),
		catalog_override = overrides.catalog.is_some(),
	)
)]
pub async fn production_inference_for_session(
	data_dir: &Path,
	tool_registry: Arc<omp_tool::Registry>,
	project_root: Option<&Path>,
	overrides: InferenceSessionOverrides,
) -> Result<ProductionInference, RegistryError> {
	let ctx = overrides
		.con
		.as_ref()
		.map_or_else(|| Arc::new(omp_con::Ctx::new()), Arc::clone);
	let credential_store =
		open_credential_store_from_con(data_dir.join("credentials.db"), ctx.as_ref())?;
	let provider = overrides.provider.clone();
	let provider_override = provider.is_some();
	let catalog = overrides.catalog.clone();
	let catalog_override = catalog.is_some();
	let usage_fetchers = overrides.usage_fetchers.unwrap_or_default();
	let provider_response_hooks = overrides.provider_response_hooks.unwrap_or_default();
	let invocation_key = match (provider.as_ref(), overrides.api_key) {
		(Some(provider), Some(secret)) => Some((provider.clone(), secret)),
		(None, None) => None,
		(Some(_), None) | (None, Some(_)) => {
			return Err(RegistryError::Inference(Box::new(omp_ai::Error::planning(
				omp_ai::ErrorKind::InvalidRequest,
				omp_ai::ErrorDetail::target(sf!("invocation-credential-override-incomplete")),
				Default::default(),
			))));
		},
	};
	let inference_settings = inference_settings(ctx.as_ref(), project_root);
	let (registry, sessions, authority, mcp_authority, auth_manager, usage_manager, builtins) =
		production_assembly_with_catalog(
			data_dir,
			credential_store,
			invocation_key,
			usage_fetchers,
			inference_settings,
			catalog,
		)
		.await?;
	let usage_fetchers = usage_manager.fetchers();
	let search_settings = omp_ai::search_settings::WebSearchSettings::from_con(ctx.as_ref());
	let rpc = InferenceRpc::new(registry.clone(), sessions, tool_registry)
		.with_session_overrides(provider, overrides.prompt_cache_affinity)
		.with_provider_response_hooks(provider_response_hooks.clone())
		.with_search_settings(search_settings);
	auth_manager.bind_provider_hooks(provider_response_hooks);
	let auth_control = auth_manager.control_handle();
	let mcp_oauth = Arc::new(omp_envd::mcp::oauth::McpOAuth::new(
		Arc::new(SystemOAuthHttpClient::new()),
		Arc::clone(&mcp_authority),
		Arc::new(omp_envd::mcp::oauth::SystemBrowserLauncher),
	));
	let inference = ProductionInference {
		registry,
		builtins,
		rpc,
		credential_authority: authority,
		mcp_authority,
		mcp_oauth,
		auth_manager,
		auth_control,
		usage_fetchers,
	};
	tracing::debug!(provider_override, catalog_override, "production inference stack composed");
	Ok(inference)
}

fn inference_settings(
	ctx: &omp_con::Ctx,
	project_root: Option<&Path>,
) -> omp_ai::InferenceSettings {
	let cwd = project_root
		.map(Path::to_path_buf)
		.or_else(|| env::current_dir().ok())
		.unwrap_or_default();
	let home = env::var_os("HOME").map_or_else(|| cwd.clone(), std::path::PathBuf::from);
	omp_ai::InferenceSettings {
		retry:                     omp_ai::settings::RetrySettings::from_con(ctx),
		sampling:                  omp_ai::settings::SamplingSettings::from_con(ctx),
		providers:                 omp_ai::settings::ProviderRuntimeSettings::from_con(ctx),
		model:                     omp_catalog::settings::ModelSettings::from_con(ctx)
			.resolve_path_scopes(&cwd, &home),
		context_promotion_enabled: omp_ai::settings::AI_CONTEXT_PROMOTION_ENABLED.get(ctx),
	}
}

async fn production_assembly(
	data_dir: &Path,
	credential_store: Arc<CredentialStore>,
) -> Result<
	(
		Registry,
		ConversationSessionPlanner,
		Arc<dyn omp_envd::github_url::CredentialAuthority>,
		Arc<auth_backend::CombinedAuthAuthority>,
		AuthManager,
		ConsoleUsageManager,
		BuiltinConfig,
	),
	RegistryError,
> {
	production_assembly_for_session(
		data_dir,
		credential_store,
		None,
		UsageFetcherRegistry::default(),
		omp_ai::InferenceSettings::default(),
	)
	.await
}

async fn production_assembly_for_session(
	data_dir: &Path,
	credential_store: Arc<CredentialStore>,
	invocation_key: Option<(omp_catalog::ProviderId, SecretString)>,
	usage_fetchers: UsageFetcherRegistry,
	inference_settings: omp_ai::InferenceSettings,
) -> Result<
	(
		Registry,
		ConversationSessionPlanner,
		Arc<dyn omp_envd::github_url::CredentialAuthority>,
		Arc<auth_backend::CombinedAuthAuthority>,
		AuthManager,
		ConsoleUsageManager,
		BuiltinConfig,
	),
	RegistryError,
> {
	production_assembly_with_catalog(
		data_dir,
		credential_store,
		invocation_key,
		usage_fetchers,
		inference_settings,
		None,
	)
	.await
}

async fn production_assembly_with_catalog(
	data_dir: &Path,
	credential_store: Arc<CredentialStore>,
	invocation_key: Option<(omp_catalog::ProviderId, SecretString)>,
	usage_fetchers: UsageFetcherRegistry,
	inference_settings: omp_ai::InferenceSettings,
	catalog: Option<Arc<snapshot::Catalog>>,
) -> Result<
	(
		Registry,
		ConversationSessionPlanner,
		Arc<dyn omp_envd::github_url::CredentialAuthority>,
		Arc<auth_backend::CombinedAuthAuthority>,
		AuthManager,
		ConsoleUsageManager,
		BuiltinConfig,
	),
	RegistryError,
> {
	fs::create_dir_all(data_dir).map_err(RegistryError::PrepareState)?;
	let catalog = match catalog {
		Some(catalog) => catalog,
		None => {
			let catalog = production_catalog(data_dir)?;
			refresh_model_discovery_cache(data_dir, catalog).await?
		},
	};
	#[cfg(feature = "local-applefm")]
	let apple_routes = catalog
		.routes()
		.iter()
		.filter(|route| {
			route.codec_profile == omp_catalog::CodecProfile::AppleFm
				&& route.transport == omp_catalog::TransportKind::Local
		})
		.map(|route| route.id.clone())
		.collect::<Vec<_>>();
	let stored = Arc::new(auth_backend::combined_authority(credential_store.clone()));
	let database = data_dir.join("credentials.db");
	let accounts = AccountPool::with_store(Arc::new(AccountStateStore::open(&database)?))?;
	let oauth_http = Arc::new(SystemOAuthHttpClient::new());
	// Resolve the Antigravity client version concurrently with the remaining
	// assembly: route codecs freeze their headers at construction, so the
	// bounded manifest probe must settle before `GoogleCcaConfig` is built.
	let antigravity_version = antigravity_version_task(data_dir, oauth_http.clone());
	let oauth_clock = Arc::new(SystemOAuthClock);
	let oauth_custom =
		Arc::new(OAuthCustomDispatcher::builtin(oauth_http.clone(), oauth_clock.clone())?);
	let refresh_coordinator =
		Arc::new(RefreshCoordinator::new("omp-auth-refresh", RefreshPolicy::default())?);
	let acquisition_credentials = CredentialBroker::system(&catalog, CredentialBrokerEngines {
		stored: Some(stored.clone()),
		..CredentialBrokerEngines::default()
	})
	.map_err(|_| {
		RegistryError::Inference(Box::new(omp_ai::Error::planning(
			omp_ai::ErrorKind::InvalidRequest,
			omp_ai::ErrorDetail::target(sf!("catalog-credential-broker-invalid")),
			Default::default(),
		)))
	})?;
	let login_engines: Vec<Arc<dyn AuthLoginEngine>> = vec![
		// Provider-scoped engines must precede generic engines for the same method.
		Arc::new(AlibabaTokenPlanLoginEngine::new(
			catalog.clone(),
			credential_store.clone(),
			accounts.clone(),
			oauth_http.clone(),
		)),
		Arc::new(SecretLoginEngine::new(
			AuthMethod::ApiKey,
			sf!("api-key"),
			catalog.clone(),
			credential_store.clone(),
			accounts.clone(),
		)?),
		Arc::new(SecretLoginEngine::new(
			AuthMethod::SessionToken,
			sf!("session-token"),
			catalog.clone(),
			credential_store.clone(),
			accounts.clone(),
		)?),
		Arc::new(CredentialAcquisitionLoginEngine::new(
			AuthMethod::ApplicationDefault,
			sf!("application-default"),
			catalog.clone(),
			acquisition_credentials.clone(),
			accounts.clone(),
		)?),
		Arc::new(CredentialAcquisitionLoginEngine::new(
			AuthMethod::AwsCredentialChain,
			sf!("aws-credential-chain"),
			catalog.clone(),
			acquisition_credentials.clone(),
			accounts.clone(),
		)?),
		Arc::new(OAuthLoginEngine::new(
			AuthMethod::OAuthPkce,
			catalog.clone(),
			credential_store.clone(),
			accounts.clone(),
			oauth_http.clone(),
			oauth_clock.clone(),
			oauth_custom.clone(),
		)?),
		Arc::new(OAuthLoginEngine::new(
			AuthMethod::OAuthDevice,
			catalog.clone(),
			credential_store.clone(),
			accounts.clone(),
			oauth_http.clone(),
			oauth_clock.clone(),
			oauth_custom.clone(),
		)?),
	];
	let refresh = Arc::new(StoredOAuthRefreshEngine::new(
		catalog.clone(),
		credential_store.clone(),
		accounts.clone(),
		oauth_http.clone(),
		oauth_clock,
		oauth_custom,
		refresh_coordinator,
	));
	let refreshing = Arc::new(RefreshingCredentialSource::new(stored.clone(), refresh.clone()));
	let aws = AwsCredentialSource::system();
	let invocation_supplies_aws_bearer = invocation_key.as_ref().is_some_and(|(provider, _)| {
		catalog.provider(provider).is_some_and(|provider| {
			provider.auth.iter().any(|auth| {
				catalog
					.auth_spec(auth)
					.is_some_and(|auth| auth.kind == AuthSpecKind::AwsSigv4)
			})
		})
	});
	let mut aws_availability = aws.registry_availability().await;
	if invocation_supplies_aws_bearer {
		aws_availability = aws_availability.map(|availability| availability.with_bearer_override());
	}
	let credentials = CredentialBroker::system(&catalog, CredentialBrokerEngines {
		stored: Some(refreshing),
		aws: Some(Arc::new(aws)),
		..CredentialBrokerEngines::default()
	})
	.map_err(|_| {
		RegistryError::Inference(Box::new(omp_ai::Error::planning(
			omp_ai::ErrorKind::InvalidRequest,
			omp_ai::ErrorDetail::target(sf!("catalog-credential-broker-invalid",)),
			Default::default(),
		)))
	})?;
	let credentials = match invocation_key {
		Some((provider, secret)) => credentials
			.with_api_key_override(&catalog, &provider, secret)
			.map_err(|_| {
				RegistryError::Inference(Box::new(omp_ai::Error::planning(
					omp_ai::ErrorKind::InvalidRequest,
					omp_ai::ErrorDetail::target(sf!("invocation-credential-override-invalid")),
					Default::default(),
				)))
			})?,
		None => credentials,
	};
	let auth_manager = AuthManager::new(
		catalog.clone(),
		credential_store,
		credentials.clone(),
		accounts.clone(),
		login_engines,
		refresh,
	)?
	.with_affinity_resolver(CredentialAffinityResolver::new(
		Hash32::sum(placeholder_affinity_key().as_bytes()).into_bytes(),
	));
	let exposed_auth_manager = auth_manager.clone();
	usage_fetchers.install_builtins([
		Arc::new(AlibabaTokenPlanUsageFetcher::new(oauth_http.clone()))
			as Arc<dyn ConsoleUsageFetcher>,
		Arc::new(ClaudeUsageFetcher::new(oauth_http.clone())),
		Arc::new(OpenAiCodexUsageFetcher::new(oauth_http.clone())),
		Arc::new(GithubCopilotUsageFetcher::new(oauth_http.clone())),
		Arc::new(CursorUsageFetcher::new(oauth_http.clone())),
		Arc::new(XaiOauthUsageFetcher::new(oauth_http.clone())),
		Arc::new(GoogleAntigravityUsageFetcher::new(oauth_http.clone())),
		Arc::new(GeminiUsageFetcher::new(oauth_http.clone())),
		Arc::new(KimiUsageFetcher::new(oauth_http.clone())),
		Arc::new(ZaiUsageFetcher::new(oauth_http.clone())),
		Arc::new(MiniMaxCodeUsageFetcher::new(oauth_http.clone())),
		Arc::new(MiniMaxCodeUsageFetcher::china(oauth_http.clone())),
		Arc::new(UmansUsageFetcher::new(oauth_http.clone())),
		Arc::new(SyntheticUsageFetcher::new(oauth_http.clone())),
		Arc::new(OpenCodeGoUsageFetcher::new(oauth_http.clone())),
		Arc::new(OllamaUsageFetcher::new()),
		Arc::new(OllamaUsageFetcher::cloud()),
	]);
	let usage_manager = ConsoleUsageManager::new(
		catalog.clone(),
		credentials.clone(),
		accounts.clone(),
		usage_fetchers,
	);
	let exposed_usage_manager = usage_manager.clone();
	let mut credential_shapers = CredentialShaperRegistry::new();
	credential_shapers
		.register(ProviderShaper::AlibabaTokenPlan(AlibabaTokenPlanShaper::new()))
		.expect("Alibaba Token Plan credential shaper registered once");
	credential_shapers
		.register(ProviderShaper::GithubCopilot(GithubCopilotShaper::new(oauth_http)))
		.expect("GitHub Copilot credential shaper registered once");
	let sessions = ConversationSessionPlanner::open(&database, catalog.clone())?;
	let aws_region = aws_availability
		.as_ref()
		.map_or_else(|_| sf!("us-east-1"), |availability| Str::new(availability.region()));
	let auth_application = AuthApplicationConfig::for_catalog(&catalog, aws_region);
	let antigravity_fingerprint = AntigravityFingerprint {
		version: antigravity_version.await,
		cl:      env_override(ANTIGRAVITY_CL_ENV).unwrap_or_else(|| sf!(DEFAULT_ANTIGRAVITY_CL)),
		os:      env_override(ANTIGRAVITY_OS_ENV).unwrap_or_else(|| sf!(DEFAULT_ANTIGRAVITY_OS)),
		arch:    env_override(ANTIGRAVITY_ARCH_ENV).unwrap_or_else(|| sf!(DEFAULT_ANTIGRAVITY_ARCH)),
	};
	let google_cca = GoogleCcaConfig {
		gemini_cli_platform: Str::from(consts::OS),
		gemini_cli_arch:     Str::from(consts::ARCH),
		antigravity_headers: CcaHeaders::antigravity(&antigravity_fingerprint, false, None),
		antigravity_policy:  AntigravityPolicy::default(),
	};
	let dependencies = ProductionDependencies::new(
		credentials,
		auth_manager,
		accounts,
		sessions.clone(),
		WebSocketTransport::new(),
		google_cca,
		HttpTransport::new().with_browser_fetch(BrowserFetchAdapter),
		auth_application,
		AdmissionController::new(32, 128),
		Duration::from_secs(60),
		Arc::new(BTreeMap::new()),
		Arc::new(credential_shapers),
	)
	.with_settings(inference_settings)
	.with_aws_registry_availability(aws_availability)
	.with_azure_endpoint(production_azure_endpoint()?);
	let dependencies = dependencies.with_usage_manager(usage_manager);
	#[cfg(feature = "local-applefm")]
	let dependencies = {
		use omp_ai::local::applefm::{AppleFmCodec, AppleFmTransport, FRAMEWORK_TIMEOUT};
		match AppleFmTransport::new() {
			Ok(transport) => {
				let backend =
					LocalRouteBackend::new(Arc::new(AppleFmCodec), transport, FRAMEWORK_TIMEOUT);
				dependencies.with_local_routes(
					apple_routes
						.into_iter()
						.map(|route| (route, backend.clone())),
				)
			},
			Err(evidence) => {
				let route_count = apple_routes.len();
				if route_count > 0 {
					tracing::warn!(
						provider = "applefm",
						state = %evidence.state.code(),
						route_count,
						"local provider initialization failed; routes are unavailable"
					);
				}
				let reason = ReasonId(Str::from(evidence.state.code()));
				dependencies.with_local_unavailable(
					apple_routes
						.into_iter()
						.map(|route| (route, reason.clone())),
				)
			},
		}
	};
	let builtins = BuiltinConfig::production(dependencies);
	let registry = Registry::builder(catalog)
		.with_builtins(builtins.clone())?
		.build()?;
	let authority: Arc<dyn omp_envd::github_url::CredentialAuthority> =
		Arc::new(GithubCredentialAuthority::new(Arc::clone(&stored)));
	Ok((
		registry,
		sessions,
		authority,
		stored,
		exposed_auth_manager,
		exposed_usage_manager,
		builtins,
	))
}

/// Resolves the Antigravity client version without blocking assembly work:
/// explicit `OMP_ANTIGRAVITY_VERSION` override → bounded update-manifest
/// discovery → last discovered release persisted in the data directory →
/// pinned reference fallback.
fn antigravity_version_task(
	data_dir: &Path,
	client: Arc<SystemOAuthHttpClient>,
) -> impl Future<Output = Str> {
	let override_version = env_override(ANTIGRAVITY_VERSION_ENV);
	let cache_path = data_dir.join(ANTIGRAVITY_VERSION_CACHE_FILE);
	let fetch = override_version.is_none().then(|| {
		tokio::spawn(async move {
			time::timeout(
				ANTIGRAVITY_VERSION_FETCH_TIMEOUT,
				discover_antigravity_version(client.as_ref()),
			)
			.await
			.ok()
			.flatten()
		})
	});
	async move {
		if let Some(version) = override_version {
			return version;
		}
		if let Some(fetch) = fetch
			&& let Ok(Some(version)) = fetch.await
		{
			// Best-effort persistence so offline boots keep the discovered release.
			let _ = fs::write(&cache_path, version.as_str());
			return version;
		}
		// Discovery failed: prefer the persisted release over the pinned default
		// only when it is actually newer (a stale cache must not undo a shipped
		// fallback bump).
		let cached = fs::read_to_string(&cache_path).ok().and_then(|raw| {
			let raw = raw.trim();
			release_ordinal(raw).map(|ordinal| (Str::from(raw), ordinal))
		});
		let pinned = release_ordinal(DEFAULT_ANTIGRAVITY_VERSION).unwrap_or_default();
		match cached {
			Some((version, ordinal)) if ordinal > pinned => {
				tracing::warn!(
					provider = "google_antigravity",
					fallback = "cached",
					"provider version discovery failed; using fallback"
				);
				version
			},
			_ => {
				tracing::warn!(
					provider = "google_antigravity",
					fallback = "pinned",
					"provider version discovery failed; using fallback"
				);
				sf!(DEFAULT_ANTIGRAVITY_VERSION)
			},
		}
	}
}

/// Parses a `major.minor.patch` release into an orderable key; any other
/// shape is rejected.
fn release_ordinal(version: &str) -> Option<[u64; 3]> {
	let mut ordinal = [0_u64; 3];
	let mut parts = version.split('.');
	for slot in &mut ordinal {
		let part = parts.next()?;
		if part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()) {
			return None;
		}
		*slot = part.parse().ok()?;
	}
	parts.next().is_none().then_some(ordinal)
}

/// Reads a non-empty trimmed environment override.
fn env_override(name: &str) -> Option<Str> {
	env::var(name).ok().and_then(|value| {
		let value = value.trim();
		(!value.is_empty()).then(|| Str::from(value))
	})
}
fn production_azure_endpoint() -> Result<Option<AzureEndpointConfig>, RegistryError> {
	let base = match (env_override(AZURE_BASE_URL_ENV), env_override(AZURE_RESOURCE_NAME_ENV)) {
		(Some(base), _) => Some(base),
		(None, Some(resource))
			if resource
				.chars()
				.all(|character| character.is_ascii_alphanumeric() || character == '-') =>
		{
			Some(Str::from(format!("https://{}.openai.azure.com", resource.as_str())))
		},
		(None, Some(_)) => {
			return Err(RegistryError::CatalogComposition(Box::new(io::Error::new(
				io::ErrorKind::InvalidInput,
				"OMP_AZURE_OPENAI_RESOURCE_NAME is invalid",
			))));
		},
		(None, None) => None,
	};
	let Some(base) = base else {
		return Ok(None);
	};
	AzureEndpointConfig::new(
		base,
		env_override(AZURE_DEPLOYMENT_ENV),
		Arc::new(BTreeMap::new()),
		env_override(AZURE_API_VERSION_ENV),
	)
	.map(Some)
	.map_err(|code| {
		RegistryError::CatalogComposition(Box::new(io::Error::new(io::ErrorKind::InvalidInput, code)))
	})
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn default_context_declares_credential_key_source() {
		let ctx = omp_con::Ctx::new();
		assert_eq!(SV_CREDENTIAL_KEY_SOURCE.get(&ctx), CredentialKeySourceSetting::Auto);
	}

	#[test]
	fn credential_key_mode_requires_deliberate_configuration() {
		assert_eq!(
			CredentialKeyMode::resolve(None, CredentialKeySourceSetting::Unavailable, true),
			CredentialKeyMode::Unavailable,
		);
		assert_eq!(
			CredentialKeyMode::resolve(None, CredentialKeySourceSetting::LocalFile, false),
			CredentialKeyMode::LocalFile,
		);
		assert_eq!(
			CredentialKeyMode::resolve(None, CredentialKeySourceSetting::OsKeychain, false),
			CredentialKeyMode::OsKeychain,
		);
	}
	#[test]
	fn auto_uses_a_local_key_file_only_for_interactive_processes() {
		assert_eq!(
			CredentialKeyMode::resolve(None, CredentialKeySourceSetting::Auto, true),
			CredentialKeyMode::LocalFile,
		);
		assert_eq!(
			CredentialKeyMode::resolve(None, CredentialKeySourceSetting::Auto, false),
			CredentialKeyMode::Unavailable,
		);
		assert_eq!(
			CredentialKeyMode::resolve(Some("auto"), CredentialKeySourceSetting::Unavailable, true),
			CredentialKeyMode::LocalFile,
		);
	}

	#[test]
	fn explicit_environment_selection_precedes_config_and_invalid_values_fail_closed() {
		assert_eq!(
			CredentialKeyMode::resolve(
				Some("local-file"),
				CredentialKeySourceSetting::Unavailable,
				false,
			),
			CredentialKeyMode::LocalFile,
		);
		assert_eq!(
			CredentialKeyMode::resolve(
				Some("os-keychain"),
				CredentialKeySourceSetting::LocalFile,
				false,
			),
			CredentialKeyMode::OsKeychain,
		);
		assert_eq!(
			CredentialKeyMode::resolve(Some("typo"), CredentialKeySourceSetting::LocalFile, true),
			CredentialKeyMode::Unavailable,
		);
	}
	#[test]
	fn frozen_snapshot_projects_model_policy_into_inference_composition() {
		let ctx = omp_con::Ctx::new();
		ctx.run("ai_default_thinking high")
			.expect("thinking setting");
		ctx.run("ai_provider_order [anthropic openai]")
			.expect("provider order setting");
		ctx.run("ai_openai_websockets off")
			.expect("websocket setting");
		ctx.run("ai_cache_retention long").expect("cache setting");
		let settings = inference_settings(&ctx, None);
		assert_eq!(settings.model.default_thinking, omp_catalog::ThinkingEffort::High,);
		assert_eq!(
			settings
				.model
				.provider_order
				.iter()
				.map(Str::as_str)
				.collect::<Vec<_>>(),
			["anthropic", "openai"],
		);
		assert_eq!(settings.model.openai_websockets, omp_catalog::settings::WireToggle::Off,);
		assert_eq!(
			settings.model.cache_retention,
			omp_catalog::settings::CacheRetentionSetting::Long,
		);
	}
}
