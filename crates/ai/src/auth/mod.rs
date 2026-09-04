//! Catalog-driven authentication, sealed credential leases, and interactive
//! login protocols.

pub mod adc;
pub mod alibaba_token_plan;
pub mod apply;
pub mod attribution;
pub mod aws;
pub mod broker;
pub mod command;
pub mod crypto;
pub mod github_copilot;
pub mod key;
pub mod lease;
pub mod login;
pub mod manager;
pub mod oauth;
pub mod scope;
pub mod search;
pub mod shape;
pub mod sigv4;
pub mod spec;
pub mod store;
pub use adc::{
	AdcEngine, AdcError, AdcResolution, AdcRuntime, AdcRuntimeError, AdcSourceKind, SystemAdcRuntime,
};
pub use alibaba_token_plan::{
	ALIBABA_TOKEN_PLAN_BASE_URL, ALIBABA_TOKEN_PLAN_CN_BASE_URL, AlibabaTokenPlanCredential,
	AlibabaTokenPlanLoginEngine, AlibabaTokenPlanLoginError, AlibabaTokenPlanShaper,
	parse_alibaba_token_plan_credential, serialize_alibaba_token_plan_credential,
};
pub use apply::{
	CommandHeaderResolveError, CommandHeaderRetry, CommandHeaderSource, CustomAuthApplyError,
	SecretHeader, apply_custom_auth,
};
pub use attribution::{
	APP_HEADER, AttributionError, ClientUsageIdentity, HOSTNAME_HEADER, INSTALL_ID_HEADER,
	UsageAttribution, resolve_app_name, resolve_forwarded_attribution,
};
pub use aws::{
	AWS_FILE_SESSION_CREDENTIAL_TTL, AWS_IMDS_REQUEST_TIMEOUT, AWS_REFRESH_SKEW,
	AWS_SHARED_RESOLVE_TIMEOUT, AwsCredentialEnvironment, AwsCredentialError,
	AwsCredentialOperation, AwsCredentialOptions, AwsCredentialSource, AwsEnvironmentError, AwsIni,
	AwsRegistryAvailability, SystemAwsCredentialEnvironment, parse_aws_ini,
	tokenize_credential_process,
};
pub use broker::{
	CredentialBroker, CredentialBrokerEngines, CredentialBrokerError, CredentialEnvironment,
	SystemCredentialEnvironment,
};
pub use command::{
	CommandCredentialError, CommandCredentialExecutor, CommandCredentialResolver,
	CommandExecutionFuture,
};
pub use github_copilot::{
	COPILOT_API_VERSION, COPILOT_USER_AGENT, CopilotProbeFuture, GithubCopilotShaper,
	PERSONAL_GITHUB_COPILOT_BASE_URL, PUBLIC_GITHUB_HOSTS, ParsedCopilotApiKey, copilot_base_url,
	discover_copilot_api_endpoint, is_personal_base_url, is_public_github_host,
	normalize_api_endpoint, normalize_domain, normalize_enterprise_domain, parse_copilot_api_key,
};
pub use key::{
	FallbackKeySource, FileCredentialKeySource, FileKeyError, HeadlessKeySource, KeyError, KeyId,
	KeySource, OsCredentialKeySource, UnavailableKeySource,
};
pub use lease::{
	AppliedCredentials, AuthRejection, AuthRejectionKind, AuthScheme, CredentialApplyError,
	CredentialError, CredentialFuture, CredentialKind, CredentialLease, CredentialNeed,
	CredentialSource, LeaseMeta, credential_ready,
};
pub use login::{
	DEFAULT_LOGIN_CHANNEL_CAPACITY, LoginCancellation, LoginChannelError, LoginDriver,
	SecretLoginError, complete_secret_login, default_login_channels, login_channels,
	prompt_for_secret,
};
pub use manager::{
	AuthControlHandle, AuthLoginEngine, AuthManager, AuthManagerBuildError, AuthRefreshEngine,
	CodexLiveCredential, CodexLiveCredentialError, CredentialAcquisitionLoginEngine,
	CredentialAcquisitionLoginEngineError, CredentialAffinityError, CredentialAffinityResolver,
	CredentialControlWrite, OAuthControlImport, OAuthLoginEngine, OAuthLoginEngineError,
	RefreshingCredentialSource, SecretLoginEngine, SecretLoginEngineError, StoredOAuthRefreshEngine,
};
pub use oauth::{
	DevicePending, OAuthClock, OAuthCredentialManagerError, OAuthCustomDispatchError,
	OAuthCustomDispatcher, OAuthCustomHandler, OAuthEngine, OAuthEntropy, OAuthError,
	OAuthHttpClient, OAuthHttpRequest, OAuthHttpResponse, OAuthProviderCode, OAuthRefreshFuture,
	OAuthTokenSet, OAuthTransportError, PkcePending, SystemEntropySource, SystemOAuthClock,
	SystemOAuthHttpClient,
};
pub use scope::{CredentialGrants, CredentialScope, CredentialScopeError};
pub use search::{
	API_PROVIDER_LADDER, PERPLEXITY_LADDER, SearchCredentialMode, automatically_available,
	select_search_credential,
};
pub use shape::{
	CredentialShaperRegistry, DuplicateShaperError, ProviderShapeFuture, ProviderShaper,
	ShapedCredential,
};
pub use spec::{
	AdcSourceSpec, AdcSpec, AuthSpec, AuthSpecError, BearerScheme, BodyPlacement,
	CatalogAuthSpecError, CredentialSourceSpec, HeaderPlacement, KeyPlacement, OAuthClientSpec,
	OAuthCustomSpec, OAuthDeviceSpec, OAuthParameter, OAuthPasteSpec, OAuthPkceSpec,
	OAuthPollingSpec, OAuthRefreshSpec, PROVIDER_NAME_PARAMETER, PkceCompletion, PublicHeader,
	QueryPlacement, SessionTokenSpec, SigV4Spec,
};
pub use store::{
	AuditedCredentialReveal, CredentialMetadata, CredentialOrigin, CredentialStore, CredentialWrite,
	LeaseOutcome, OAuthCredentialImport, PersistentLease, ScopedCredentialGrant,
	ScopedCredentialToken, StoreError, StoredCredentialSource,
};
