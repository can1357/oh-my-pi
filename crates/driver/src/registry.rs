//! Production inference and credential-service composition.

use std::{
	collections::BTreeMap,
	env,
	env::consts,
	fs,
	future::Future,
	io,
	io::IsTerminal as _,
	path::Path,
	sync,
	sync::{Arc, LazyLock},
	time::Duration,
};

use omp_catalog::{DiscoveryNormalizer, OverlaySource, OverlayStore, UnsafeTrustScope, snapshot};
use omp_core::{Hash32, SecretString, Str, sf};
use omp_envd::browser_fetch::BrowserFetchAdapter;
#[cfg(target_os = "macos")]
use omp_inference::auth::FallbackKeySource;
#[cfg(feature = "local-applefm")]
use omp_inference::provider::builtin::LocalRouteBackend;
#[cfg(feature = "local-applefm")]
use omp_inference::receipt::ReasonId;
use omp_inference::{
	Registry,
	account::{
		AccountPool, AccountStateStore, AccountStateStoreError, RefreshCoordinator, RefreshPolicy,
	},
	auth::{
		AlibabaTokenPlanLoginEngine, AlibabaTokenPlanShaper, AuthControlHandle, AuthLoginEngine,
		AuthManager, AuthManagerBuildError, CredentialAcquisitionLoginEngine,
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
	discovery::{DiscoveryCacheKey, DiscoveryStore},
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
use omp_serve::inference::InferenceRpc;
use omp_settings::{
	SettingsSnapshot,
	manager::{SettingsManager, SettingsManagerError, SettingsPaths},
};
use tokio::time;

use crate::{
	auth_backend,
	auth_backend::GithubCredentialAuthority,
	codex_redemption::CodexRedemptionAuthority,
	discovery::{
		models::{load_or_import_legacy, lower_user_overlay},
		runtime::{CachedDiscoveryHydration, DiscoveryRuntime},
	},
	settings::{CredentialKeySourceSetting, LifecycleSettings},
};

const KEY_SOURCE_ENV: &str = "OMP_LLM_KEY_SOURCE";
const KEYCHAIN_SERVICE: &str = "dev.omp.llm";
const KEYCHAIN_ACCOUNT: &str = "credential-store-master";
const ANTIGRAVITY_VERSION_ENV: &str = "OMP_ANTIGRAVITY_VERSION";
const ANTIGRAVITY_CL_ENV: &str = "OMP_ANTIGRAVITY_CL";
const ANTIGRAVITY_OS_ENV: &str = "OMP_ANTIGRAVITY_OS";
const ANTIGRAVITY_ARCH_ENV: &str = "OMP_ANTIGRAVITY_ARCH";
const ANTIGRAVITY_VERSION_CACHE_FILE: &str = "antigravity-version";
const ANTIGRAVITY_VERSION_FETCH_TIMEOUT: Duration = Duration::from_secs(5);
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
	Inference(#[from] Box<omp_inference::Error>),
	/// Encrypted credential state could not be opened.
	#[error(transparent)]
	CredentialStore(#[from] StoreError),
	/// Credential encryption key provisioning failed.
	#[error(transparent)]
	CredentialKey(#[from] KeyError),
	/// Owner-only credential key file provisioning failed.
	#[error(transparent)]
	CredentialKeyFile(#[from] FileKeyError),
	/// Native settings authority could not be opened.
	#[error(transparent)]
	SettingsManager(#[from] SettingsManagerError),
	/// Web-search settings could not be projected.
	#[error(transparent)]
	SettingsSnapshot(#[from] omp_settings::SnapshotError),
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
	RefreshPolicy(#[from] omp_inference::account::RefreshPolicyError),
	/// Catalog authentication could not be assembled.
	#[error(transparent)]
	AuthManager(#[from] AuthManagerBuildError),
	/// Durable conversation state could not be opened.
	#[error(transparent)]
	Conversation(#[from] ConversationError),
}

impl From<omp_inference::Error> for RegistryError {
	fn from(error: omp_inference::Error) -> Self {
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
	static KEY: LazyLock<String> = LazyLock::new(|| {
		match omp_storage::secret_key::load_or_create() {
			Ok(key) => key,
			Err(error) => {
				tracing::warn!(%error, "could not persist credential-affinity key; using process-local identity");
				omp_core::Ulid::generate().to_string()
			},
		}
	});
	KEY.as_str()
}

/// Opens the encrypted credential database using the environment-selected key
/// source.
pub fn open_credential_store(
	database: impl AsRef<Path>,
) -> Result<Arc<CredentialStore>, RegistryError> {
	let database = database.as_ref();
	let data_dir = database.parent().unwrap_or_else(|| Path::new("."));
	let manager = SettingsManager::open(SettingsPaths::discover(data_dir, None))?;
	let configured = manager
		.snapshot()
		.project::<LifecycleSettings>()?
		.get()
		.credential_key_source;
	open_credential_store_with_mode(database, CredentialKeyMode::from_configuration(configured))
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

/// Composes the immutable production catalog from bundled facts, the fresh
/// credential-blind discovery cache, and native user configuration.
#[tracing::instrument(
	level = "debug",
	skip_all,
	fields(data_dir = %data_dir.display())
)]
pub fn production_catalog(data_dir: &Path) -> Result<Arc<snapshot::Catalog>, RegistryError> {
	let base = snapshot::Catalog::try_embedded()
		.map_err(RegistryError::Catalog)?
		.clone();
	let overlays = Arc::new(OverlayStore::default());
	let cache_path = data_dir.join("models.db");
	let discovery_cache = cache_path.exists();
	if discovery_cache {
		let cache = Arc::new(
			DiscoveryStore::open(&cache_path)
				.map_err(|error| RegistryError::CatalogComposition(Box::new(error)))?,
		);
		let runtime = DiscoveryRuntime::new(cache, Arc::clone(&overlays), []);
		let requests = base
			.providers()
			.iter()
			.filter_map(|provider| {
				let defaults = provider.discovery_defaults.clone()?;
				base
					.routes()
					.iter()
					.any(|route| route.provider == provider.id && route.discovery.is_some())
					.then(|| CachedDiscoveryHydration {
						key:        DiscoveryCacheKey::provider(provider.id.clone()),
						normalizer: DiscoveryNormalizer::new(defaults),
					})
			})
			.collect::<Vec<_>>();
		let now_ms = std::time::SystemTime::now()
			.duration_since(std::time::UNIX_EPOCH)
			.unwrap_or_default()
			.as_millis()
			.try_into()
			.unwrap_or(u64::MAX);
		runtime
			.hydrate_cached(&requests, now_ms)
			.map_err(|error| RegistryError::CatalogComposition(Box::new(error)))?;
	}
	let user_overlay = if let Some(loaded) = load_or_import_legacy(data_dir)
		.map_err(|error| RegistryError::CatalogComposition(Box::new(error)))?
	{
		let overlay = lower_user_overlay(&loaded.config)
			.map_err(|error| RegistryError::CatalogComposition(Box::new(error)))?;
		overlays.replace(OverlaySource::UserConfig, overlay);
		true
	} else {
		false
	};
	let catalog = base
		.with_overlay_stack(&overlays.load(), UnsafeTrustScope::ALL)
		.map_err(|error| RegistryError::CatalogComposition(Box::new(error)))?;
	tracing::debug!(
		discovery_cache,
		user_overlay,
		provider_count = catalog.providers().len(),
		model_count = catalog.models().len(),
		route_count = catalog.routes().len(),
		"production catalog composed"
	);
	Ok(Arc::new(catalog))
}

/// Builds the production inference registry over durable daemon state.
pub async fn production_registry(
	data_dir: &Path,
	credential_store: Arc<CredentialStore>,
) -> Result<Registry, RegistryError> {
	let settings = SettingsManager::open(SettingsPaths::discover(data_dir, None))?.snapshot();
	production_assembly_for_session(
		data_dir,
		credential_store,
		None,
		UsageFetcherRegistry::default(),
		inference_settings(settings.as_ref(), None)?,
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
		.map(|(_, _, _, _, _, usage, _)| usage)
}

/// Builds the production Codex saved-reset redemption authority, when the
/// embedded catalog carries an `openai-codex` route.
pub fn production_redemption_authority(
	data_dir: &Path,
) -> Result<Option<sync::Arc<dyn omp_agent::RedemptionAuthority>>, RegistryError> {
	Ok(production_codex_redemption(data_dir)?.map(|service| {
		sync::Arc::new(CodexRedemptionAuthority::new(sync::Arc::new(service)))
			as sync::Arc<dyn omp_agent::RedemptionAuthority>
	}))
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
		RegistryError::Inference(Box::new(omp_inference::Error::planning(
			omp_inference::ErrorKind::InvalidRequest,
			omp_inference::ErrorDetail::target(sf!("catalog-credential-broker-invalid")),
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
	let settings = SettingsManager::open(SettingsPaths::discover(data_dir, None))?.snapshot();
	production_rpc_registry_with_settings(data_dir, credential_store, settings, None).await
}

/// Builds the RPC registry from the exact session settings snapshot.
pub async fn production_rpc_registry_with_settings(
	data_dir: &Path,
	credential_store: Arc<CredentialStore>,
	settings: Arc<SettingsSnapshot>,
	project_root: Option<&Path>,
) -> Result<(Registry, AuthManager), RegistryError> {
	production_assembly_for_session(
		data_dir,
		credential_store,
		None,
		UsageFetcherRegistry::default(),
		inference_settings(settings.as_ref(), project_root)?,
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
	pub provider_response_hooks: Option<omp_inference::ProviderResponseHooks>,
	/// Catalog composed with frozen extension providers before model selection.
	pub catalog:                 Option<Arc<snapshot::Catalog>>,
	/// Exact layered settings snapshot frozen by the session composer.
	pub settings:                Option<Arc<SettingsSnapshot>>,
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
	production_inference_for_session(
		data_dir,
		tool_registry,
		project_root,
		InferenceSessionOverrides::default(),
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
		settings_override = overrides.settings.is_some(),
	)
)]
pub async fn production_inference_for_session(
	data_dir: &Path,
	tool_registry: Arc<omp_tool::Registry>,
	project_root: Option<&Path>,
	overrides: InferenceSessionOverrides,
) -> Result<ProductionInference, RegistryError> {
	let settings = match overrides.settings.as_ref() {
		Some(snapshot) => Arc::clone(snapshot),
		None => SettingsManager::open(SettingsPaths::discover(data_dir, project_root))?.snapshot(),
	};
	let credential_store = open_credential_store(data_dir.join("credentials.db"))?;
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
			return Err(RegistryError::Inference(Box::new(omp_inference::Error::planning(
				omp_inference::ErrorKind::InvalidRequest,
				omp_inference::ErrorDetail::target(sf!("invocation-credential-override-incomplete")),
				Default::default(),
			))));
		},
	};
	let inference_settings = inference_settings(settings.as_ref(), project_root)?;
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
	let search_settings = settings
		.project::<omp_inference::search_settings::WebSearchSettings>()?
		.get()
		.clone();
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
	settings: &SettingsSnapshot,
	project_root: Option<&Path>,
) -> Result<omp_inference::InferenceSettings, RegistryError> {
	let cwd = project_root
		.map(Path::to_path_buf)
		.or_else(|| env::current_dir().ok())
		.unwrap_or_default();
	let home = env::var_os("HOME").map_or_else(|| cwd.clone(), std::path::PathBuf::from);
	Ok(omp_inference::InferenceSettings {
		retry:     settings
			.project::<omp_inference::settings::RetrySettings>()?
			.get()
			.clone(),
		sampling:  settings
			.project::<omp_inference::settings::SamplingSettings>()?
			.get()
			.clone(),
		providers: settings
			.project::<omp_inference::settings::ProviderRuntimeSettings>()?
			.get()
			.clone(),
		model:     settings
			.project::<omp_catalog::settings::ModelSettings>()?
			.get()
			.resolve_path_scopes(&cwd, &home),
	})
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
		omp_inference::InferenceSettings::default(),
	)
	.await
}

async fn production_assembly_for_session(
	data_dir: &Path,
	credential_store: Arc<CredentialStore>,
	invocation_key: Option<(omp_catalog::ProviderId, SecretString)>,
	usage_fetchers: UsageFetcherRegistry,
	inference_settings: omp_inference::InferenceSettings,
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
	inference_settings: omp_inference::InferenceSettings,
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
		None => production_catalog(data_dir)?,
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
		RegistryError::Inference(Box::new(omp_inference::Error::planning(
			omp_inference::ErrorKind::InvalidRequest,
			omp_inference::ErrorDetail::target(sf!("catalog-credential-broker-invalid")),
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
	let credentials = CredentialBroker::system(&catalog, CredentialBrokerEngines {
		stored: Some(refreshing),
		..CredentialBrokerEngines::default()
	})
	.map_err(|_| {
		RegistryError::Inference(Box::new(omp_inference::Error::planning(
			omp_inference::ErrorKind::InvalidRequest,
			omp_inference::ErrorDetail::target(sf!("catalog-credential-broker-invalid",)),
			Default::default(),
		)))
	})?;
	let credentials = match invocation_key {
		Some((provider, secret)) => credentials
			.with_api_key_override(&catalog, &provider, secret)
			.map_err(|_| {
				RegistryError::Inference(Box::new(omp_inference::Error::planning(
					omp_inference::ErrorKind::InvalidRequest,
					omp_inference::ErrorDetail::target(sf!("invocation-credential-override-invalid")),
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
	let auth_application = AuthApplicationConfig { signing_regions: Arc::new(BTreeMap::new()) };
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
	.with_azure_endpoint(production_azure_endpoint()?);
	let dependencies = dependencies.with_usage_manager(usage_manager);
	#[cfg(feature = "local-applefm")]
	let dependencies = {
		use omp_inference::local::applefm::{AppleFmCodec, AppleFmTransport, FRAMEWORK_TIMEOUT};
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
	fn production_catalog_composes_native_unknown_provider_and_model() {
		let directory = tempfile::tempdir().expect("temporary profile");
		fs::write(
			directory.path().join("models.toml"),
			r#"
[providers.local]
baseUrl = "https://models.example.test"

[providers.local.models."my-model"]
name = "My Model"
api = "openai"
contextWindow = 8192
maxTokens = 1024
"#,
		)
		.expect("models.toml");
		let catalog = production_catalog(directory.path()).expect("composed catalog");
		let provider = omp_catalog::ProviderId::from("local");
		let model = omp_catalog::ModelKey::from("my-model");
		assert!(catalog.provider(&provider).is_some());
		assert!(catalog.model_for_provider(&provider, &model).is_some());
		assert!(
			catalog
				.model_for_provider(&provider, &model)
				.expect("configured model")
				.routes
				.iter()
				.any(|route| catalog
					.route(route)
					.is_some_and(|route| route.provider == provider))
		);
	}

	#[test]
	fn production_catalog_hydrates_fresh_discovery_cache() {
		let directory = tempfile::tempdir().expect("temporary profile");
		let embedded = snapshot::Catalog::try_embedded().expect("embedded catalog");
		let route = embedded
			.routes()
			.iter()
			.find(|route| {
				route.discovery.is_some()
					&& embedded
						.provider(&route.provider)
						.and_then(|provider| provider.discovery_defaults.as_ref())
						.is_some()
			})
			.expect("discovery-capable route");
		let now_ms = 1_900_000_000_000_u64;
		let row = omp_catalog::DiscoveredModel {
			provider:              route.provider.clone(),
			route:                 route.id.clone(),
			wire_model:            omp_catalog::WireModelId::from("cached-driver-composition-test"),
			aliases:               Box::new([]),
			display_name:          Some(Str::new_static("Cached Driver Composition Test")),
			declared_class:        None,
			declared_operations:   omp_catalog::OperationBits::empty(),
			declared_capabilities: None,
			declared_limits:       None,
			extended_context_mode: None,
			availability:          None,
			source:                Str::new_static("driver-test"),
			observed_at_ms:        Some(now_ms),
			updated_at_ms:         None,
			deprecated:            None,
		};
		DiscoveryStore::open(&directory.path().join("models.db"))
			.expect("discovery store")
			.publish(
				&DiscoveryCacheKey::provider(route.provider.clone()),
				&[row],
				now_ms,
				Duration::from_secs(24 * 60 * 60),
			)
			.expect("cache generation");
		let catalog = production_catalog(directory.path()).expect("composed catalog");
		let model = catalog
			.models()
			.iter()
			.find(|model| model.display_name == "Cached Driver Composition Test")
			.expect("cached model");
		assert_eq!(
			catalog
				.resolve_alias(&format!("{}/cached-driver-composition-test", route.provider))
				.map(|resolved| &resolved.key),
			Some(&model.key),
		);
	}

	#[test]
	fn frozen_snapshot_projects_model_policy_into_inference_composition() {
		let document: toml::Table = toml::from_str(
			r#"
[model]
default_thinking = "high"
provider_order = ["anthropic", "openai"]
openai_websockets = "off"
cache_retention = "long"
"#,
		)
		.expect("settings document");
		let manager = SettingsManager::isolated(document).expect("settings manager");
		let settings =
			inference_settings(manager.snapshot().as_ref(), None).expect("inference settings");
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
