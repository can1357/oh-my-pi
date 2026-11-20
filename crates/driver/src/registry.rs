//! Production inference and credential-service composition.

use std::{
	collections::{BTreeMap, BTreeSet},
	env,
	env::consts,
	fs,
	future::Future,
	io,
	io::IsTerminal as _,
	path::{Path, PathBuf},
	sync::{Arc, LazyLock},
	time::{Duration, SystemTime, UNIX_EPOCH},
};

#[cfg(target_os = "macos")]
use omp_ai::auth::FallbackKeySource;
#[cfg(feature = "local-applefm")]
use omp_ai::provider::builtin::LocalRouteBackend;
#[cfg(feature = "local-applefm")]
use omp_ai::receipt::ReasonId;
use omp_ai::{
	CallAffinity, CallMeta, Client, ProviderService, Registry, RegistryHandle,
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
		AuthApplicationConfig, AzureEndpointConfig, CloudflareGatewayConfig, GoogleCcaConfig,
		ProductionDependencies, discover_antigravity_version,
	},
	router::Router,
	session::{ConversationError, ConversationSessionPlanner},
	transport::{http::HttpTransport, websocket_transport::WebSocketTransport},
};
use omp_catalog::{
	CatalogOverlay, ContextStrategy, DiscoveryDefaults, DiscoveryNormalizer, OverlaySource,
	OverlayStack, Pricing, ProvenanceKind, ProvenanceSource, UnsafeTrustScope,
	provider::{AuthSpecKind, CredentialSourceSpec},
	snapshot,
};
use omp_core::{Hash32, SecretString, Str, sf};
#[cfg(feature = "cap-browser")]
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
const CLOUDFLARE_ACCOUNT_ID_ENV: &str = "OMP_CLOUDFLARE_ACCOUNT_ID";
const CLOUDFLARE_GATEWAY_NAME_ENV: &str = "OMP_CLOUDFLARE_AI_GATEWAY_NAME";

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
	open_credential_store_with_mode(database.as_ref(), credential_key_mode(ctx))
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

/// The credential key source this process resolves from `ctx`
/// (`sv_credential_key_source`) and `OMP_LLM_KEY_SOURCE`.
pub fn credential_key_mode(ctx: &omp_con::Ctx) -> CredentialKeyMode {
	CredentialKeyMode::from_configuration(SV_CREDENTIAL_KEY_SOURCE.get(ctx))
}

/// A provider's stored logins cannot be decrypted by this process, which
/// resolved no key source ([`omp_ai::CredentialStorageLock::NoKeySource`]).
#[derive(Debug, thiserror::Error)]
#[error(
	"{provider} has stored logins. Credential storage is locked: {}.",
	omp_ai::CredentialStorageLock::NoKeySource
)]
pub struct StoredLoginsLocked {
	/// Provider whose stored logins are locked.
	pub provider: omp_catalog::ProviderId,
}

/// Refuses a launch that would authenticate `provider` with stored logins
/// this process cannot decrypt.
///
/// That is when `mode` is [`CredentialKeyMode::Unavailable`] and `data_dir`'s
/// account state holds an enabled account of `provider`, while no request the
/// launch's plan may send can authenticate without the store: no catalog
/// authentication of `provider` ([`omp_ai::auth::provider_auth_specs`]) is
/// anonymous, resolves from application-default, AWS, or session sources, or
/// names a credential environment variable that is set (the broker leases
/// those before any stored login), and neither does one of another provider
/// that `model`'s other routes or its planned fallbacks (`retry`, as the
/// router walks them) would use.
///
/// Without a credential database there is nothing to unlock. Account state
/// that cannot be read is left to the composition, which reports it.
///
/// # Errors
///
/// Returns [`StoredLoginsLocked`], whose message names `OMP_LLM_KEY_SOURCE`
/// and `sv_credential_key_source`.
pub fn ensure_stored_logins_unlockable(
	mode: CredentialKeyMode,
	data_dir: &Path,
	catalog: &snapshot::Catalog,
	retry: &omp_ai::settings::RetrySettings,
	provider: &omp_catalog::ProviderId<str>,
	model: Option<&omp_catalog::ModelKey<str>>,
) -> Result<(), StoredLoginsLocked> {
	let database = data_dir.join("credentials.db");
	if mode != CredentialKeyMode::Unavailable
		|| !database.is_file()
		|| leases_without_store(catalog, provider)
	{
		return Ok(());
	}
	// Providers serving `model` on its other routes, then its planned
	// fallbacks' providers.
	let route_providers = |model: &omp_catalog::ModelKey<str>| {
		catalog
			.model(model)
			.into_iter()
			.flat_map(|spec| spec.routes.iter())
			.filter_map(|route| catalog.route(route))
			.map(|route| &route.provider)
	};
	let mut others = model.into_iter().flat_map(|model| {
		let fallbacks = if retry.model_fallback {
			let budget = usize::try_from(retry.max_attempts().saturating_sub(1)).unwrap_or(usize::MAX);
			retry.fallback_walk(model, Some(provider), budget, |candidate| {
				route_providers(candidate).next().cloned()
			})
		} else {
			Vec::new()
		};
		route_providers(model).chain(
			fallbacks
				.into_iter()
				.flat_map(move |fallback| route_providers(&fallback)),
		)
	});
	if others
		.any(|other| other.as_str() != provider.as_str() && leases_without_store(catalog, other))
	{
		return Ok(());
	}
	let stored = AccountStateStore::open(&database)
		.and_then(|state| AccountPool::with_store(Arc::new(state)))
		.is_ok_and(|accounts| {
			accounts
				.accounts()
				.iter()
				.any(|record| record.enabled && record.provider.as_str() == provider.as_str())
		});
	if stored {
		return Err(StoredLoginsLocked { provider: provider.to_owned() });
	}
	Ok(())
}

/// Whether some catalog authentication of `provider` can lease without the
/// credential store: it is anonymous, resolves from application-default,
/// AWS, or session sources, or names a credential variable that is set.
fn leases_without_store(
	catalog: &snapshot::Catalog,
	provider: &omp_catalog::ProviderId<str>,
) -> bool {
	let set = |names: &[Str]| {
		names
			.iter()
			.any(|name| env::var_os(name.as_str()).is_some_and(|value| !value.is_empty()))
	};
	omp_ai::auth::provider_auth_specs(catalog, provider).any(|spec| {
		spec.kind == AuthSpecKind::None
			|| spec.credential_sources.iter().any(|source| match source {
				CredentialSourceSpec::Environment { ordered_names } => set(ordered_names),
				CredentialSourceSpec::BasicEnvironment { password_names, .. } => set(password_names),
				CredentialSourceSpec::ApplicationDefault { .. }
				| CredentialSourceSpec::AwsChain
				| CredentialSourceSpec::Session => true,
				CredentialSourceSpec::Stored | CredentialSourceSpec::Oauth { .. } => false,
			})
	})
}

/// Returns the immutable production catalog with configured and fresh
/// runtime-discovery layers materialized in explicit precedence order.
pub fn production_catalog(data_dir: &Path) -> Result<Arc<snapshot::Catalog>, RegistryError> {
	let bundled = snapshot::Catalog::try_embedded()
		.map_err(RegistryError::Catalog)?
		.clone();
	let loaded =
		crate::discovery::models::load_configured_models(data_dir).map_err(catalog_composition)?;
	let user_overlay = loaded
		.as_ref()
		.map(crate::discovery::models::lower_user_overlay)
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
	let probes = crate::discovery::models::discovery_probes(loaded.as_ref(), &configured)
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
	let mut claimed = DiscoveryClaims::default();
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
			.and_then(|loaded| loaded.providers.get(key.provider.as_str()));
		for record in DiscoveryNormalizer::new(defaults)
			.normalize_batch(&cached.rows)
			.map_err(catalog_composition)?
		{
			if let Some(record) = claimed.admit(&configured, explicit, record) {
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

/// Keys already taken by the runtime-discovery layer being assembled.
///
/// Discovery is an additive layer over the bundled and configured catalog: a
/// discovered row may add a model, never replace one. The overlay resolver
/// patches an existing key in place, so a row that reused a bundled or
/// configured key, or one an earlier cache generation already added, would
/// rewrite that model's routes and wire ids. Keys are provider-scoped by the
/// normalizer, so the only same-key rows left are the owning provider's own
/// listing of a model the catalog already declares, and the first one wins.
#[derive(Default)]
struct DiscoveryClaims {
	models:  BTreeSet<omp_catalog::ModelKey>,
	aliases: BTreeSet<Str>,
}

impl DiscoveryClaims {
	/// Returns `record` when it adds a new model, keeping only the aliases
	/// that stay inside its provider's namespace and name nothing yet.
	fn admit(
		&mut self,
		configured: &snapshot::Catalog,
		explicit: Option<&crate::discovery::models::ProviderConfig>,
		mut record: omp_catalog::NormalizedDiscovery,
	) -> Option<omp_catalog::NormalizedDiscovery> {
		let provider = record.provider.as_str();
		// `models.toml` entries are keyed `<provider>/<id>` like the listing's
		// rows; the configured facts outrank whatever the listing declares,
		// including a row that normalized the same wire id to another key.
		let explicitly_configured = explicit.is_some_and(|declared| {
			declared.declares(&record.provider, &record.model.key)
				|| record
					.model
					.wire_ids
					.iter()
					.any(|(_, wire)| declared.declares_wire(wire.as_str()))
		});
		if explicitly_configured
			|| configured.model(&record.model.key).is_some()
			|| !self.models.insert(record.model.key.clone())
		{
			return None;
		}
		let aliases = std::mem::take(&mut record.aliases);
		record.aliases = aliases
			.into_vec()
			.into_iter()
			.filter(|alias| {
				// The resolver scopes a bare alias to its provider and keeps a
				// namespaced one verbatim; only the provider's own namespace
				// is open to discovery.
				let name = if alias.alias.contains('/') {
					alias.alias.clone()
				} else {
					sf!("{provider}/{}", alias.alias)
				};
				name
					.strip_prefix(provider)
					.is_some_and(|rest| rest.starts_with('/'))
					&& configured.resolve_alias(&name).is_none()
					&& configured
						.model(omp_catalog::ModelKey::from_ref(&name))
						.is_none()
					&& self.aliases.insert(name)
			})
			.collect();
		Some(record)
	}
}

fn catalog_composition(source: impl std::error::Error + Send + Sync + 'static) -> RegistryError {
	RegistryError::CatalogComposition(Box::new(source))
}

/// One discovery pass over the configured probes.
struct DiscoveryPass {
	/// The catalog after the pass: rebuilt from the cache when any probe
	/// published, else the catalog the pass started from.
	catalog:   Arc<snapshot::Catalog>,
	/// Whether any probe published a new cache generation.
	published: bool,
}

/// Probes every configured discovery endpoint whose cache is stale, plus every
/// endpoint of `forced` (a provider whose credentials just changed) even when
/// its cache is fresh or its last failure is still backing off.
async fn refresh_model_discovery_cache(
	data_dir: &Path,
	catalog: Arc<snapshot::Catalog>,
	credential_store: &Arc<CredentialStore>,
	forced: Option<&omp_catalog::ProviderId<str>>,
) -> Result<DiscoveryPass, RegistryError> {
	use omp_ai::discovery::{
		DiscoveryCacheKey, DiscoveryStore, DiscoveryStoreError, ProviderDiscoveryState,
		ProviderLifecycle,
	};

	let loaded =
		crate::discovery::models::load_configured_models(data_dir).map_err(catalog_composition)?;
	let mut probes = crate::discovery::models::discovery_probes(loaded.as_ref(), &catalog)
		.map_err(catalog_composition)?;
	if probes.is_empty() {
		return Ok(DiscoveryPass { catalog, published: false });
	}
	crate::discovery::models::authenticate_probes_from_store(
		&mut probes,
		&catalog,
		credential_store,
		std::time::SystemTime::now(),
	)
	.await;
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
		let forced = forced.is_some_and(|provider| probe.provider.as_str() == provider.as_str());
		if !forced
			&& store
				.load_fresh(&key, now_ms)
				.map_err(catalog_composition)?
				.is_some()
		{
			continue;
		}
		if !forced
			&& store
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
		// Loopback runtimes are usually absent, so their failure is the steady
		// state; a provider the user configured is expected to answer.
		let configured = loaded
			.as_ref()
			.is_some_and(|loaded| loaded.providers.contains_key(probe.provider.as_str()));
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
					if configured {
						tracing::warn!(
							provider = %provider,
							error_code,
							"configured provider model discovery failed"
						);
					} else {
						tracing::debug!(
							provider = %provider,
							error_code,
							"bounded model discovery probe was unavailable"
						);
					}
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
	let mut published = false;
	for result in futures::future::join_all(pending).await {
		published |= result.map_err(catalog_composition)?;
	}
	Ok(if published {
		DiscoveryPass { catalog: production_catalog(data_dir)?, published }
	} else {
		DiscoveryPass { catalog, published }
	})
}

/// Why a mid-session model-discovery refresh runs.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DiscoveryRefresh {
	/// The earliest cached discovery generation reached its TTL.
	Expired,
	/// A login changed this provider's credentials: re-probe its endpoints
	/// even while their cache is fresh.
	LoggedIn(omp_catalog::ProviderId),
}

/// Re-runs runtime model discovery for a composed session and publishes the
/// result atomically through the session's [`RegistryHandle`].
///
/// A refresh rebuilds one complete registry over the refreshed catalog from
/// the retained [`BuiltinConfig`] and swaps it in; snapshots already loaded
/// (an in-flight turn's) keep routing through the registry they loaded.
#[derive(Clone)]
pub struct DiscoveryRefresher {
	data_dir:    PathBuf,
	credentials: Arc<CredentialStore>,
	builtins:    BuiltinConfig,
	registry:    RegistryHandle,
}

impl DiscoveryRefresher {
	/// Runs one discovery pass. Publishes and returns the refreshed catalog
	/// when any probe produced a new generation; returns `None` and leaves the
	/// published registry untouched otherwise. On error nothing is published.
	pub async fn refresh(
		&self,
		why: &DiscoveryRefresh,
	) -> Result<Option<Arc<snapshot::Catalog>>, RegistryError> {
		let current = self.registry.load();
		let forced = match why {
			DiscoveryRefresh::Expired => None,
			DiscoveryRefresh::LoggedIn(provider) => Some(&**provider),
		};
		let pass = refresh_model_discovery_cache(
			&self.data_dir,
			Arc::clone(current.shared_catalog()),
			&self.credentials,
			forced,
		)
		.await?;
		if !pass.published {
			return Ok(None);
		}
		let registry = Registry::builder(Arc::clone(&pass.catalog))
			.with_builtins(self.builtins.clone())?
			.with_generation(current.generation().saturating_add(1))
			.build()?;
		self.registry.replace(registry);
		tracing::debug!(
			?why,
			models = pass.catalog.models().len(),
			"published refreshed model discovery"
		);
		Ok(Some(pass.catalog))
	}

	/// Wall-clock instant the earliest still-fresh cached generation expires.
	pub fn next_expiry(&self) -> Result<Option<SystemTime>, RegistryError> {
		let path = self.data_dir.join("models.db");
		if !path.exists() {
			return Ok(None);
		}
		let store = omp_ai::discovery::DiscoveryStore::open(&path).map_err(catalog_composition)?;
		let now_ms = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.unwrap_or_default()
			.as_millis()
			.try_into()
			.unwrap_or(u64::MAX);
		Ok(store
			.next_expiry_ms(now_ms)
			.map_err(catalog_composition)?
			.map(|expiry| UNIX_EPOCH + Duration::from_millis(expiry)))
	}

	/// Starts the session's discovery refresh owner: one mailbox of refresh
	/// requests plus a deadline timer armed at the next cache expiry. Every
	/// published catalog is handed to `publish`; a failed refresh keeps the
	/// current catalog and logs at warn. The owner stops once every
	/// [`DiscoveryRefreshSender`] is dropped.
	pub fn spawn(
		self,
		publish: impl Fn(Arc<snapshot::Catalog>) + Send + Sync + 'static,
	) -> DiscoveryRefreshSender {
		let (tx, rx) = flume::unbounded();
		tokio::spawn(async move {
			loop {
				let deadline = match self.next_expiry() {
					Ok(expiry) => expiry.map(|expiry| {
						let wait = expiry.duration_since(SystemTime::now()).unwrap_or_default();
						time::Instant::now() + wait + Duration::from_millis(1)
					}),
					Err(error) => {
						tracing::warn!(%error, "model discovery cache expiry is unreadable");
						None
					},
				};
				let why = tokio::select! {
					request = rx.recv_async() => match request {
						Ok(why) => why,
						Err(_) => break,
					},
					() = time::sleep_until(deadline.unwrap_or_else(time::Instant::now)),
						if deadline.is_some() => DiscoveryRefresh::Expired,
				};
				match self.refresh(&why).await {
					Ok(Some(catalog)) => publish(catalog),
					Ok(None) => {},
					Err(error) => tracing::warn!(
						%error,
						?why,
						"model discovery refresh failed; keeping the current catalog"
					),
				}
			}
		});
		DiscoveryRefreshSender { tx }
	}
}

/// Mailbox into a running [`DiscoveryRefresher`] owner.
#[derive(Clone)]
pub struct DiscoveryRefreshSender {
	tx: flume::Sender<DiscoveryRefresh>,
}

impl DiscoveryRefreshSender {
	/// Queues one refresh; never blocks. A stopped owner drops the request.
	pub fn request(&self, why: DiscoveryRefresh) {
		let _ = self.tx.send(why);
	}
}

/// Read side of one session's catalog publication.
#[derive(Clone)]
pub enum LiveCatalog {
	/// The production stack's registry publication point: every read sees the
	/// latest discovery refresh.
	Published(RegistryHandle),
	/// A fixed snapshot (behind a remote gateway, whose catalog lives there).
	Fixed(Arc<snapshot::Catalog>),
}

impl LiveCatalog {
	/// The catalog as currently published.
	#[must_use]
	pub fn load(&self) -> Arc<snapshot::Catalog> {
		match self {
			Self::Published(registry) => Arc::clone(registry.load().shared_catalog()),
			Self::Fixed(catalog) => Arc::clone(catalog),
		}
	}
}

/// A route client pinned to one published registry snapshot.
///
/// Planning and dispatch both run on the pinned registry, so a discovery
/// refresh can never split a request across two generations. The pin moves
/// only when its owner calls [`Self::adopt_published`], which the kernel does
/// once at the start of each turn: an in-flight turn keeps its routes, the
/// next turn sees the swap.
pub struct PinnedRoutes {
	live:     RegistryHandle,
	registry: Registry,
	client:   Client<ProviderService, Router>,
}

/// How long a plan stays valid before dispatch must re-plan it.
const PLAN_TTL: Duration = Duration::from_secs(30);

impl PinnedRoutes {
	/// Pins the currently published registry.
	#[must_use]
	pub fn new(live: RegistryHandle, meta: CallMeta, affinity: CallAffinity) -> Self {
		let registry = Registry::clone(&live.load());
		let client = Client::new(registry.service(), Router::new(registry.clone(), PLAN_TTL), meta)
			.with_affinity(affinity);
		Self { live, registry, client }
	}

	/// Re-pins to the latest publication when it changed, carrying the call
	/// metadata and affinity over; returns whether the pin moved. Route
	/// services are constructed with the registry, never here.
	pub fn adopt_published(&mut self) -> bool {
		let published = self.live.load();
		if published.same_publication(&self.registry) {
			return false;
		}
		let registry = Registry::clone(&published);
		let meta = self.client.call_meta().clone();
		let affinity = self.client.affinity().clone();
		self.client = Client::new(registry.service(), Router::new(registry.clone(), PLAN_TTL), meta)
			.with_affinity(affinity);
		self.registry = registry;
		true
	}

	/// The pinned registry.
	#[must_use]
	pub const fn registry(&self) -> &Registry {
		&self.registry
	}

	/// The pinned registry's catalog.
	#[must_use]
	pub fn catalog(&self) -> &Arc<snapshot::Catalog> {
		self.registry.shared_catalog()
	}

	/// The client over the pinned registry.
	#[must_use]
	pub const fn client(&self) -> &Client<ProviderService, Router> {
		&self.client
	}

	/// Mutably borrows the client over the pinned registry.
	pub const fn client_mut(&mut self) -> &mut Client<ProviderService, Router> {
		&mut self.client
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
	.map(|assembly| Registry::clone(&assembly.registry.load()))
}
/// Builds the production console-usage authority over the canonical
/// credential and account stores.
pub async fn production_usage_manager(
	data_dir: &Path,
) -> Result<ConsoleUsageManager, RegistryError> {
	let credential_store = open_credential_store(data_dir.join("credentials.db"))?;
	production_assembly(data_dir, credential_store)
		.await
		.map(|assembly| assembly.usage_manager)
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
	.map(|assembly| (Registry::clone(&assembly.registry.load()), assembly.auth_manager))
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
	/// The session's one registry publication point. Its current snapshot's
	/// catalog layers bundled, configured, and runtime-discovered models as
	/// the latest discovery refresh left them; model selection and pickers
	/// read it through [`Self::catalog`], never an earlier snapshot.
	pub registry:             RegistryHandle,
	/// Cloneable route composition retained for atomic provider registry
	/// rebuilds.
	pub builtins:             BuiltinConfig,
	/// Mid-session discovery refresh over `registry`; `None` when the caller
	/// composed the catalog itself (extension providers), which is final.
	pub discovery:            Option<DiscoveryRefresher>,
	/// RPC facade sharing the registry's route services and conversation owner.
	pub rpc:                  InferenceRpc,
	/// Narrow GitHub URL credential projection over the canonical encrypted
	/// store.
	pub credential_authority: Arc<dyn omp_envd::forge_url::CredentialAuthority>,
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

impl ProductionInference {
	/// The catalog as currently published: the latest discovery refresh.
	#[must_use]
	pub fn catalog(&self) -> Arc<snapshot::Catalog> {
		Arc::clone(self.registry.load().shared_catalog())
	}
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
	let ProductionAssembly {
		registry,
		discovery,
		sessions,
		authority,
		stored: mcp_authority,
		auth_manager,
		usage_manager,
		builtins,
	} = production_assembly_with_catalog(
		data_dir,
		project_root,
		credential_store,
		invocation_key,
		usage_fetchers,
		inference_settings,
		catalog,
	)
	.await?;
	let usage_fetchers = usage_manager.fetchers();
	let search_settings = omp_ai::search_settings::WebSearchSettings::from_con(ctx.as_ref());
	// The RPC facade projects the launch generation; in-process chat follows
	// later publications through `registry`.
	let rpc = InferenceRpc::new(Registry::clone(&registry.load()), sessions, tool_registry)
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
		discovery,
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

/// Every authority one production composition assembles over a single
/// credential owner.
struct ProductionAssembly {
	/// Publication point whose first snapshot routes through the catalog this
	/// composition's discovery refresh left.
	registry:      RegistryHandle,
	/// Later refreshes of that discovery, when the catalog is not caller-owned.
	discovery:     Option<DiscoveryRefresher>,
	sessions:      ConversationSessionPlanner,
	authority:     Arc<dyn omp_envd::forge_url::CredentialAuthority>,
	stored:        Arc<auth_backend::CombinedAuthAuthority>,
	auth_manager:  AuthManager,
	usage_manager: ConsoleUsageManager,
	builtins:      BuiltinConfig,
}

async fn production_assembly(
	data_dir: &Path,
	credential_store: Arc<CredentialStore>,
) -> Result<ProductionAssembly, RegistryError> {
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
) -> Result<ProductionAssembly, RegistryError> {
	production_assembly_with_catalog(
		data_dir,
		None,
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
	project_root: Option<&Path>,
	credential_store: Arc<CredentialStore>,
	invocation_key: Option<(omp_catalog::ProviderId, SecretString)>,
	usage_fetchers: UsageFetcherRegistry,
	inference_settings: omp_ai::InferenceSettings,
	catalog: Option<Arc<snapshot::Catalog>>,
) -> Result<ProductionAssembly, RegistryError> {
	fs::create_dir_all(data_dir).map_err(RegistryError::PrepareState)?;
	// The one-time v1 import runs first, so the `models.toml` it writes is in
	// this session's catalog and authentication stack, and a v1
	// `models.yml` key authenticates the discovery refresh below.
	crate::v1_import::first_run(data_dir, project_root, &credential_store);
	// A caller-composed catalog is final. Otherwise the cached snapshot seeds
	// the authentication stack, whose provider, route, and auth facts runtime
	// discovery never changes; the refresh below adds models only.
	let (catalog, refresh_discovery) = match catalog {
		Some(catalog) => (catalog, false),
		None => (production_catalog(data_dir)?, true),
	};
	let discovery_credentials = Arc::clone(&credential_store);
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
	// Before any request or discovery refresh leases a stored row.
	repair_stored_secret_kinds(&auth_manager.control_handle());
	let catalog = if refresh_discovery {
		refresh_model_discovery_cache(data_dir, catalog, &discovery_credentials, None)
			.await?
			.catalog
	} else {
		catalog
	};
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
		{
			let http = HttpTransport::new();
			#[cfg(feature = "cap-browser")]
			let http = http.with_browser_fetch(BrowserFetchAdapter);
			http
		},
		auth_application,
		AdmissionController::new(32, 128),
		Duration::from_secs(60),
		Arc::new(BTreeMap::new()),
		Arc::new(credential_shapers),
	)
	.with_settings(inference_settings)
	.with_aws_registry_availability(aws_availability)
	.with_azure_endpoint(production_azure_endpoint()?)
	.with_cloudflare_gateway(production_cloudflare_gateway()?);
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
	let registry = Registry::builder(Arc::clone(&catalog))
		.with_builtins(builtins.clone())?
		.build()?
		.into_handle();
	let discovery = refresh_discovery.then(|| DiscoveryRefresher {
		data_dir:    data_dir.to_path_buf(),
		credentials: discovery_credentials,
		builtins:    builtins.clone(),
		registry:    registry.clone(),
	});
	let authority: Arc<dyn omp_envd::forge_url::CredentialAuthority> =
		Arc::new(GithubCredentialAuthority::new(Arc::clone(&stored)));
	Ok(ProductionAssembly {
		registry,
		discovery,
		sessions,
		authority,
		stored,
		auth_manager: exposed_auth_manager,
		usage_manager: exposed_usage_manager,
		builtins,
	})
}

/// Re-stores every static secret stored under a kind its provider's routes
/// do not lease ([`AuthControlHandle::repair_static_secret_kinds`]) in the
/// catalog this composition authenticates with, so a row an earlier writer
/// stored under another kind, or one a catalog or `models.toml` change left
/// behind, is usable by the time the first request leases it.
///
/// Composition never fails for it. Each row is repaired on its own, and every
/// failure is logged with its account and what it left the row as
/// ([`omp_ai::auth::SecretKindRepairError`]): a row this process cannot
/// decrypt (a key source unavailable without a terminal, or a row sealed under
/// a key it does not hold) keeps its kind for a later launch, and its requests
/// report why it cannot be used; a row re-stored whose new generation the
/// account pool did not take is not tried again. The rows after a failure are
/// still repaired, and a row another launch re-stored first is no failure.
/// Nothing is decrypted unless some row needs re-storing.
fn repair_stored_secret_kinds(control: &AuthControlHandle) {
	let outcome = match control.repair_static_secret_kinds() {
		Ok(outcome) => outcome,
		Err(error) => {
			tracing::warn!(
				error = &error as &dyn std::error::Error,
				"could not list stored credentials to re-store them under the kind their provider's \
				 routes lease"
			);
			return;
		},
	};
	for repair in outcome.repaired {
		let repaired: &'static str = repair.repaired.into();
		tracing::info!(
			account = repair.account.as_str(),
			stored = repair.stored.as_str(),
			repaired,
			"re-stored a credential under the kind its provider's routes lease"
		);
	}
	for repair in outcome.restored_elsewhere {
		let repaired: &'static str = repair.repaired.into();
		tracing::debug!(
			account = repair.account.as_str(),
			stored = repair.stored.as_str(),
			repaired,
			"another launch re-stored a credential under the kind its provider's routes lease first"
		);
	}
	for failure in outcome.failed {
		let repaired: &'static str = failure.repair.repaired.into();
		tracing::warn!(
			account = failure.repair.account.as_str(),
			stored = failure.repair.stored.as_str(),
			repaired,
			error = &failure.error as &dyn std::error::Error,
			"could not finish re-storing a credential under the kind its provider's routes lease"
		);
	}
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
/// Reads the Cloudflare AI Gateway coordinates from the environment.
fn production_cloudflare_gateway() -> Result<Option<CloudflareGatewayConfig>, RegistryError> {
	cloudflare_gateway_from(
		env_override(CLOUDFLARE_ACCOUNT_ID_ENV),
		env_override(CLOUDFLARE_GATEWAY_NAME_ENV),
	)
}

/// Both values present and valid give a config; either absent leaves the
/// gateway unconfigured, which fails each call with a typed error rather than
/// sending a placeholder. A present but invalid value is refused at startup.
fn cloudflare_gateway_from(
	account: Option<Str>,
	gateway: Option<Str>,
) -> Result<Option<CloudflareGatewayConfig>, RegistryError> {
	let invalid = |code: &'static str| {
		RegistryError::CatalogComposition(Box::new(io::Error::new(io::ErrorKind::InvalidInput, code)))
	};
	match (account, gateway) {
		(Some(account), Some(gateway)) => CloudflareGatewayConfig::new(account, gateway)
			.map(Some)
			.map_err(invalid),
		(Some(account), None) => CloudflareGatewayConfig::new(account, "x")
			.map(|_| None)
			.map_err(invalid),
		(None, Some(gateway)) => CloudflareGatewayConfig::new("x", gateway)
			.map(|_| None)
			.map_err(invalid),
		(None, None) => Ok(None),
	}
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
	fn cloudflare_gateway_needs_both_values_and_refuses_invalid_ones() {
		let some = |value: &str| Some(Str::from(value));
		assert!(
			cloudflare_gateway_from(None, None)
				.expect("unset")
				.is_none()
		);
		assert!(
			cloudflare_gateway_from(some("acct-1"), None)
				.expect("half")
				.is_none()
		);
		assert!(
			cloudflare_gateway_from(None, some("gw"))
				.expect("half")
				.is_none()
		);
		assert!(
			cloudflare_gateway_from(some("acct-1"), some("gw"))
				.expect("both")
				.is_some()
		);
		for bad in ["a/b", "a b", "a?x=1", "a#f", "a:b", "..", "{account}"] {
			assert!(cloudflare_gateway_from(some(bad), some("gw")).is_err(), "account {bad}");
			assert!(cloudflare_gateway_from(some("acct"), some(bad)).is_err(), "gateway {bad}");
			assert!(cloudflare_gateway_from(some(bad), None).is_err(), "lone account {bad}");
		}
	}

	#[test]
	fn default_context_declares_credential_key_source() {
		let ctx = omp_con::Ctx::new();
		assert_eq!(SV_CREDENTIAL_KEY_SOURCE.get(&ctx), CredentialKeySourceSetting::Auto);
	}

	/// A provider whose stored logins this process cannot decrypt is refused
	/// up front with a message naming the key-source settings; any key source,
	/// no stored login, or a set credential variable lets the launch through.
	#[test]
	fn stored_logins_without_a_key_source_are_refused_with_the_remedy() {
		let directory = tempfile::tempdir().expect("data dir");
		let data_dir = directory.path();
		let catalog = snapshot::Catalog::embedded();
		let poolside = omp_catalog::ProviderId::from_ref("poolside");
		let laguna = omp_catalog::ModelKey::from_ref("poolside/laguna");
		let no_fallbacks = omp_ai::settings::RetrySettings::default();
		let check = |mode| {
			ensure_stored_logins_unlockable(mode, data_dir, catalog, &no_fallbacks, poolside, None)
		};
		// SAFETY: nextest runs each test in its own process; nothing else in
		// this one reads the environment concurrently.
		unsafe { env::remove_var("OMP_POOLSIDE_API_KEY") };
		assert!(check(CredentialKeyMode::Unavailable).is_ok(), "no credential database yet");

		let accounts = AccountPool::with_store(Arc::new(
			AccountStateStore::open(data_dir.join("credentials.db")).expect("account state"),
		))
		.expect("accounts");
		let login = |enabled| omp_ai::account::AccountRecord {
			account: AccountId::from("poolside:agent-db"),
			principal: omp_ai::PrincipalId::from("agent-db"),
			provider: poolside.to_owned(),
			routes: BTreeSet::new(),
			enabled,
			credential_generation: 1,
			routing: omp_ai::call::AccountRoutingContext::default(),
		};
		accounts.upsert(login(false)).expect("disabled login");
		assert!(
			check(CredentialKeyMode::Unavailable).is_ok(),
			"a disabled login is never selected, so nothing needs unlocking"
		);
		accounts.upsert(login(true)).expect("stored login");

		let error = check(CredentialKeyMode::Unavailable).expect_err("locked stored login");
		let message = error.to_string();
		assert!(message.starts_with("poolside has stored logins. Credential storage is locked"));
		assert!(message.contains("OMP_LLM_KEY_SOURCE=local-file"), "{message}");
		assert!(message.contains("sv_credential_key_source local-file"), "{message}");
		assert!(check(CredentialKeyMode::LocalFile).is_ok());
		assert!(check(CredentialKeyMode::OsKeychain).is_ok());
		assert!(
			ensure_stored_logins_unlockable(
				CredentialKeyMode::Unavailable,
				data_dir,
				catalog,
				&no_fallbacks,
				omp_catalog::ProviderId::from_ref("huggingface"),
				None,
			)
			.is_ok(),
			"another provider's stored login does not block this one"
		);

		// A planned fallback to a provider keyed only by an environment
		// variable can serve the request once that variable is set.
		let (fallback, variable) = catalog
			.models()
			.iter()
			.find_map(|spec| {
				let mut providers = spec
					.routes
					.iter()
					.filter_map(|route| catalog.route(route))
					.map(|route| route.provider.clone());
				let provider = providers.next()?;
				if provider.as_str() == "poolside" || providers.any(|other| other != provider) {
					return None;
				}
				let variable =
					omp_ai::auth::provider_auth_specs(catalog, &provider).find_map(|auth| {
						auth
							.credential_sources
							.iter()
							.find_map(|source| match source {
								CredentialSourceSpec::Environment { ordered_names } => {
									ordered_names.first().cloned()
								},
								_ => None,
							})
					})?;
				// SAFETY: as above.
				unsafe { env::remove_var(variable.as_str()) };
				(!leases_without_store(catalog, &provider)).then(|| (spec.key.clone(), variable))
			})
			.expect("a model of a provider keyed by an environment variable");
		let chained = omp_ai::settings::RetrySettings {
			fallback_chains: BTreeMap::from([(Str::new(laguna.as_str()), vec![Str::new(
				fallback.as_str(),
			)])]),
			..omp_ai::settings::RetrySettings::default()
		};
		let planned = |retry: &omp_ai::settings::RetrySettings| {
			ensure_stored_logins_unlockable(
				CredentialKeyMode::Unavailable,
				data_dir,
				catalog,
				retry,
				poolside,
				Some(laguna),
			)
		};
		assert!(planned(&chained).is_err(), "the fallback {fallback} has no credential either");
		// SAFETY: as above.
		unsafe { env::set_var(variable.as_str(), "fake-fallback-key") };
		assert!(planned(&chained).is_ok(), "the fallback {fallback} authenticates from {variable}");
		assert!(planned(&no_fallbacks).is_err(), "no fallback is planned without a chain");
		let disabled = omp_ai::settings::RetrySettings { model_fallback: false, ..chained };
		assert!(planned(&disabled).is_err(), "model fallback is off");
		// SAFETY: as above.
		unsafe { env::remove_var(variable.as_str()) };

		// SAFETY: as above.
		unsafe { env::set_var("OMP_POOLSIDE_API_KEY", "fake-environment-key") };
		assert!(
			check(CredentialKeyMode::Unavailable).is_ok(),
			"an environment credential is leased before the stored login"
		);
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
