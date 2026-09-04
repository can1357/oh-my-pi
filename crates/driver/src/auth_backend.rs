//! Typed authentication and encrypted credential-store construction.

use std::{
	collections::BTreeMap,
	env,
	str::{self, FromStr as _},
	sync,
	sync::Arc,
	time,
	time::Duration,
};

use omp_ai::{
	AccountId, PrincipalId, auth,
	auth::{
		APP_HEADER, AuditedCredentialReveal, AuthControlHandle, CommandCredentialError,
		CommandCredentialExecutor, CommandExecutionFuture, CredentialControlWrite, CredentialGrants,
		HOSTNAME_HEADER, INSTALL_ID_HEADER, OAuthControlImport, ScopedCredentialGrant,
		UsageAttribution,
	},
};
use omp_core::{EnvPath, ExposeSecret as _, InvocationPhase, Secret, SecretString, Str};
use omp_env::{EnvClient, ExecEvent};
pub use omp_envd::mcp::auth_authority::CombinedAuthAuthority;
use omp_envd::{
	exthost::control::{
		ControlAuthority, ControlAuthorityFactory, ControlCompositionError,
		ControlConnectionIdentity, ControlEffect, ControlProtocolError, ControlRequestContext,
	},
	mcp::auth_authority::CredentialAuthority,
};
use omp_proto::{
	env::v1::{
		CloseSessionRequest, ExecOutcome, ExecRequest, OpenSessionRequest, OutputChannel, Script,
	},
	omp::auth::{
		v1,
		v1::{
			Block, DeleteCredentialRequest, DisableCredentialRequest, EnableCredentialRequest,
			ImportOAuthRequest, ListCredentialsRequest, MintScopedTokenRequest, PutApiKeyRequest,
			RefreshCredentialRequest, ReportBlockRequest, RevealCredentialRequest,
			auth_client::AuthClient, credential_meta,
		},
	},
};
use omp_secrets::{
	SecretMaskingAuthority,
	rule::{SecretKind, SecretMode, SecretRule},
};
use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;
use tonic::{Request, metadata::MetadataValue, transport::Channel};
use tracing::Instrument as _;
use zeroize::Zeroizing;

use crate::secrets::{key, session::SecretSessionSnapshot};

/// Composes provider and MCP leasing over the one encrypted credential store.
pub fn combined_authority(
	store: sync::Arc<omp_ai::auth::CredentialStore>,
) -> CombinedAuthAuthority {
	CombinedAuthAuthority::new(store)
}

/// Driver-owned adapter from combined provider/MCP credentials to GitHub URLs.
pub struct GithubCredentialAuthority {
	inner: Arc<CombinedAuthAuthority>,
}

impl GithubCredentialAuthority {
	/// Wraps the combined encrypted credential authority.
	pub fn new(inner: Arc<CombinedAuthAuthority>) -> Self {
		Self { inner }
	}
}
/// Composes the encrypted store and adapts it to environment-owned GitHub URLs.
pub fn github_authority(store: Arc<omp_ai::auth::CredentialStore>) -> GithubCredentialAuthority {
	GithubCredentialAuthority::new(Arc::new(combined_authority(store)))
}

impl omp_envd::github_url::CredentialAuthority for GithubCredentialAuthority {
	fn provider_lease(
		&self,
		need: omp_ai::auth::CredentialNeed,
	) -> omp_ai::auth::CredentialFuture<
		'_,
		Result<omp_ai::auth::CredentialLease, omp_ai::auth::CredentialError>,
	> {
		CredentialAuthority::provider_lease(self.inner.as_ref(), need)
	}
}

/// Durable credential grants and exact provider names admitted for one
/// extension.
#[derive(Clone, Debug, Default)]
pub struct CredentialControlGrant {
	/// Independent normal, import, and reveal scopes.
	pub grants:    CredentialGrants,
	/// Exact providers used to resolve omitted Python `provider` arguments.
	pub providers: Arc<[Str]>,
}

/// Factory for authenticated credential and Core-owned secret CONTROL.
pub struct CredentialSecretControlFactory {
	control:         AuthControlHandle,
	grants:          Arc<BTreeMap<Str, CredentialControlGrant>>,
	base_rules:      Arc<[SecretRule]>,
	placeholder_key: Arc<str>,
}

impl CredentialSecretControlFactory {
	/// Composes the live auth owner with deployment-admitted grants and Core
	/// masking inputs.
	pub fn new(
		control: AuthControlHandle,
		grants: BTreeMap<Str, CredentialControlGrant>,
		base_rules: Arc<[SecretRule]>,
		placeholder_key: impl Into<Arc<str>>,
	) -> Self {
		Self {
			control,
			grants: Arc::new(grants),
			base_rules,
			placeholder_key: placeholder_key.into(),
		}
	}
}

impl ControlAuthorityFactory for CredentialSecretControlFactory {
	fn bind(
		&self,
		identity: Arc<ControlConnectionIdentity>,
	) -> Result<Arc<dyn ControlAuthority>, ControlCompositionError> {
		let grant = self
			.grants
			.get(&identity.extension)
			.cloned()
			.unwrap_or_default();
		let masking = SecretMaskingAuthority::new(
			identity.extension.clone(),
			identity.host_generation,
			self.base_rules.iter().cloned(),
			self.placeholder_key.as_ref(),
		)
		.map_err(|error| {
			ControlCompositionError::unavailable("credentials", Str::from(error.to_string()))
		})?;
		Ok(Arc::new(CredentialSecretControlAuthority {
			identity,
			control: self.control.clone(),
			grant,
			masking,
		}))
	}
}

struct CredentialSecretControlAuthority {
	identity: Arc<ControlConnectionIdentity>,
	control:  AuthControlHandle,
	grant:    CredentialControlGrant,
	masking:  SecretMaskingAuthority,
}

#[async_trait::async_trait]
impl ControlAuthority for CredentialSecretControlAuthority {
	fn handles(&self, operation: &str) -> bool {
		matches!(
			operation,
			"omp.creds.list"
				| "omp.creds.store"
				| "omp.creds.refresh"
				| "omp.creds.clear"
				| "omp.creds.disable"
				| "omp.creds.enable"
				| "omp.creds.report_block"
				| "omp.creds.usage"
				| "omp.creds.mint_scoped"
				| "omp.creds.import_oauth"
				| "omp.creds.reveal"
				| "omp.secrets.declare"
				| "omp.secrets.mask"
		)
	}

	fn authorize(
		&self,
		context: &ControlRequestContext,
		operation: &str,
		arguments: &Map<String, Value>,
	) -> Result<(), ControlProtocolError> {
		self.validate_connection(context)?;
		if !self.handles(operation) {
			return Err(control_error("InvalidOperation", "credential operation is not supported"));
		}
		if operation == "omp.secrets.declare" {
			if context.invocation.is_some() {
				return Err(control_error(
					"InvalidPhase",
					"secret declarations are accepted only before callback activation",
				));
			}
			if arguments
				.get("rule")
				.and_then(Value::as_object)
				.unwrap_or(arguments)
				.get("kind")
				.and_then(Value::as_str)
				.is_some_and(|kind| kind.eq_ignore_ascii_case("env"))
				&& !context.connection.capabilities.contains("secrets.env")
			{
				return Err(control_error(
					"PermissionError",
					"environment secret declaration requires secrets.env",
				));
			}
			return Ok(());
		}
		if let Some(invocation) = &context.invocation {
			let minimum = if matches!(
				operation,
				"omp.creds.store"
					| "omp.creds.refresh"
					| "omp.creds.clear"
					| "omp.creds.disable"
					| "omp.creds.enable"
					| "omp.creds.report_block"
					| "omp.creds.mint_scoped"
					| "omp.creds.import_oauth"
					| "omp.creds.reveal"
			) {
				InvocationPhase::EffectsAuthorized
			} else {
				InvocationPhase::Admitted
			};
			if !invocation.phase.allows_operation(minimum) {
				return Err(control_error("InvalidPhase", "credential operation is not allowed now"));
			}
		}
		if operation.starts_with("omp.creds.") {
			let provider = self.provider(arguments)?;
			let scope = if operation == "omp.creds.import_oauth" {
				&self.grant.grants.import
			} else if operation == "omp.creds.reveal" {
				&self.grant.grants.reveal
			} else {
				&self.grant.grants.allow
			};
			scope
				.enforce(provider)
				.map_err(|_| control_error("PermissionError", "credential provider is not granted"))?;
		}
		Ok(())
	}

	async fn request(
		&self,
		context: ControlRequestContext,
		operation: Str,
		arguments: Map<String, Value>,
	) -> Result<Value, ControlProtocolError> {
		self.authorize(&context, operation.as_str(), &arguments)?;
		match operation.as_str() {
			"omp.secrets.declare" => {
				let rule = parse_secret_rule(&arguments)?;
				self
					.masking
					.declare(
						context.connection.extension.as_str(),
						context.connection.host_generation,
						rule,
					)
					.map_err(secret_control_error)?;
				Ok(Value::Null)
			},
			"omp.secrets.mask" => {
				let text = required_str(&arguments, "text")?;
				self
					.masking
					.mask(
						context.connection.extension.as_str(),
						context.connection.host_generation,
						text,
					)
					.map(Value::String)
					.map_err(secret_control_error)
			},
			"omp.creds.list" => {
				let provider = self.provider(&arguments)?;
				let provider = omp_catalog::ProviderId::from(provider);
				let rows = self
					.control
					.accounts(Some(&provider))
					.into_iter()
					.map(|account| self.metadata_value(account))
					.collect::<Result<Vec<_>, _>>()?;
				Ok(Value::Array(rows))
			},
			"omp.creds.store" => {
				let provider = omp_catalog::ProviderId::from(self.provider(&arguments)?);
				let credential = required_object(&arguments, "cred")?;
				let kind = required_str(credential, "kind")?;
				let secret = unseal_secret(
					credential
						.get("secret")
						.ok_or_else(|| control_error("InvalidCredential", "secret is missing"))?,
				)?;
				let identity = optional_str(credential, "identity").map(Str::from);
				let (_, account) = self
					.control
					.store(CredentialControlWrite {
						provider,
						principal: PrincipalId::from(context.connection.principal.id()),
						identity,
						kind: Str::from(kind),
						secret,
						expires_at_ms: optional_u64(credential, "expires_at_ms")?,
					})
					.map_err(store_control_error)?;
				self.metadata_value(account)
			},
			"omp.creds.import_oauth" => {
				let provider = omp_catalog::ProviderId::from(self.provider(&arguments)?);
				let refresh =
					unseal_string(arguments.get("refresh_token").ok_or_else(|| {
						control_error("InvalidCredential", "refresh_token is missing")
					})?)?;
				let access = arguments
					.get("access_token")
					.filter(|value| !value.is_null())
					.map(unseal_string)
					.transpose()?;
				let (_, account) = self
					.control
					.import_oauth(OAuthControlImport {
						provider,
						principal: PrincipalId::from(context.connection.principal.id()),
						identity: optional_str(&arguments, "identity").map(Str::from),
						access_token: access,
						refresh_token: refresh,
						expires_at_ms: optional_u64(&arguments, "expires_at_ms")?,
					})
					.map_err(store_control_error)?;
				self.metadata_value(account)
			},
			"omp.creds.refresh" => {
				let provider = self.provider(&arguments)?;
				let account = match self.selected_account(&arguments) {
					Ok(account) => account,
					Err(error) => {
						tracing::debug!(
							error = %error,
							"credential refresh preflight rejected"
						);
						return Err(error);
					},
				};
				let span = tracing::debug_span!(
					"oauth_refresh",
					authority = "local",
					provider = %provider,
					credential_id = credential_id(&account)
				);
				if let Err(error) = self.control.refresh(account.clone()).instrument(span).await {
					tracing::warn!(
						provider = %provider,
						credential_id = credential_id(&account),
						error = %error,
						"OAuth credential refresh failed"
					);
					return Err(auth_control_error(error));
				}
				tracing::debug!(
					provider = %provider,
					credential_id = credential_id(&account),
					"OAuth credential refresh completed"
				);
				self.metadata_value(self.account_record(&account)?)
			},
			"omp.creds.clear" => {
				let account = self.selected_account(&arguments)?;
				self
					.control
					.delete(account)
					.await
					.map_err(auth_control_error)?;
				Ok(Value::Null)
			},
			"omp.creds.disable" | "omp.creds.enable" => {
				let account = self.selected_account(&arguments)?;
				let enabled = operation.as_str() == "omp.creds.enable";
				let cause = (!enabled)
					.then(|| required_str(&arguments, "cause"))
					.transpose()?;
				let record = self
					.control
					.set_enabled(&account, enabled, cause)
					.map_err(store_control_error)?;
				let mut value = self.metadata_value(record)?;
				if let Some(cause) = cause {
					value["disabled_cause"] = Value::String(cause.to_owned());
				}
				Ok(value)
			},
			"omp.creds.report_block" => {
				let account = self.selected_account(&arguments)?;
				let until_ms = required_u64(&arguments, "until_ms")?;
				let until = time::UNIX_EPOCH
					.checked_add(Duration::from_millis(until_ms))
					.ok_or_else(|| control_error("InvalidBlock", "until_ms is out of range"))?;
				self
					.control
					.report_block(&account, optional_str(&arguments, "scope").unwrap_or("shared"), until)
					.map_err(store_control_error)?;
				Ok(Value::Null)
			},
			"omp.creds.usage" => Ok(Value::Null),
			"omp.creds.mint_scoped" => {
				let provider = self.provider(&arguments)?.to_owned();
				let account = self.selected_account(&arguments)?;
				let ttl = arguments
					.get("ttl")
					.and_then(Value::as_str)
					.map(|ttl| {
						ttl.parse::<omp_core::Duration>()
							.and_then(|ttl| ttl.to_std())
					})
					.transpose()
					.map_err(|_| control_error("InvalidDuration", "scoped token ttl is invalid"))?
					.unwrap_or(Duration::from_secs(300))
					.min(Duration::from_secs(3600));
				let now_ms: u64 = time::SystemTime::now()
					.duration_since(time::UNIX_EPOCH)
					.map_err(|_| control_error("InvalidTime", "system time is invalid"))?
					.as_millis()
					.try_into()
					.map_err(|_| control_error("InvalidTime", "system time is invalid"))?;
				let expires_at_ms =
					now_ms.saturating_add(ttl.as_millis().try_into().unwrap_or(u64::MAX));
				let expires_at_ms = self
					.control
					.metadata(&account)
					.map_err(store_control_error)?
					.and_then(|metadata| metadata.expires_at_ms)
					.map_or(expires_at_ms, |credential_expiry| expires_at_ms.min(credential_expiry));
				let scoped = self
					.control
					.mint_scoped_token(&account, &ScopedCredentialGrant {
						extension: context.connection.extension.clone(),
						caller_principal: Str::from(context.connection.principal.id()),
						provider: Str::from(provider),
						facet: Str::from(required_str(&arguments, "facet")?),
						host_generation: context.connection.host_generation,
						session_generation: context.connection.session_generation,
						request_id: context.request_id,
						expires_at_ms,
					})
					.map_err(store_control_error)?;
				Ok(json!({
					"token": scoped.token.expose_secret(),
					"expires_at_ms": scoped.expires_at_ms,
				}))
			},
			"omp.creds.reveal" => {
				let provider = self.provider(&arguments)?.to_owned();
				let account = self.selected_account(&arguments)?;
				let audit = AuditedCredentialReveal {
					extension:          context.connection.extension.clone(),
					caller_principal:   Str::from(context.connection.principal.id()),
					provider:           Str::from(provider),
					host_generation:    context.connection.host_generation,
					session_generation: context.connection.session_generation,
					request_id:         context.request_id,
					reason:             Str::new_static("extension_control_reveal"),
				};
				self
					.control
					.reveal(&account, &audit, |secret| {
						secret.expose(|bytes| {
							json!({
								"encoding": "base64",
								"data": omp_core::base64::encode(bytes).into_string(),
							})
						})
					})
					.map_err(store_control_error)
			},
			_ => Err(control_error("InvalidOperation", "credential operation is not supported")),
		}
	}

	async fn effect(
		&self,
		context: ControlRequestContext,
		_effect: ControlEffect,
	) -> Result<(), ControlProtocolError> {
		self.validate_connection(&context)?;
		Err(control_error("InvalidOperation", "credential authority does not accept effects"))
	}
}

impl CredentialSecretControlAuthority {
	fn validate_connection(
		&self,
		context: &ControlRequestContext,
	) -> Result<(), ControlProtocolError> {
		if same_control_identity(&self.identity, &context.connection) {
			Ok(())
		} else {
			Err(control_error(
				"StaleGeneration",
				"credential authority belongs to a replaced CONTROL connection",
			))
		}
	}

	fn provider<'a>(
		&'a self,
		arguments: &'a Map<String, Value>,
	) -> Result<&'a str, ControlProtocolError> {
		if let Some(provider) = optional_str(arguments, "provider") {
			return Ok(provider);
		}
		match self.grant.providers.as_ref() {
			[provider] => Ok(provider.as_str()),
			[] => Err(control_error("PermissionError", "no credential provider is granted")),
			_ => Err(control_error(
				"InvalidProvider",
				"provider is required when multiple credential providers are granted",
			)),
		}
	}

	fn selected_account(
		&self,
		arguments: &Map<String, Value>,
	) -> Result<AccountId, ControlProtocolError> {
		let provider = omp_catalog::ProviderId::from(self.provider(arguments)?);
		let requested = arguments
			.get("id")
			.filter(|value| !value.is_null())
			.map(|value| {
				value
					.as_u64()
					.ok_or_else(|| control_error("InvalidCredential", "credential id is invalid"))
			});
		let mut matches = self
			.control
			.accounts(Some(&provider))
			.into_iter()
			.filter(|account| {
				requested.as_ref().is_none_or(|id| {
					id.as_ref()
						.is_ok_and(|id| credential_id(&account.account) == *id)
				})
			});
		let first = matches
			.next()
			.ok_or_else(|| control_error("CredentialNotFound", "credential was not found"))?;
		if matches.next().is_some() {
			return Err(control_error(
				"AmbiguousCredential",
				"credential selector matched more than one account",
			));
		}
		Ok(first.account)
	}

	fn account_record(
		&self,
		account: &AccountId<str>,
	) -> Result<omp_ai::account::AccountRecord, ControlProtocolError> {
		self
			.control
			.accounts(None)
			.into_iter()
			.find(|record| &record.account == account)
			.ok_or_else(|| control_error("CredentialNotFound", "credential was not found"))
	}

	fn metadata_value(
		&self,
		account: omp_ai::account::AccountRecord,
	) -> Result<Value, ControlProtocolError> {
		let metadata = self
			.control
			.metadata(&account.account)
			.map_err(store_control_error)?
			.ok_or_else(|| control_error("CredentialNotFound", "credential was not found"))?;
		let kind = match metadata.kind.as_str() {
			"api-key" | "api_key" => "api_key",
			"oauth-renewable-v1" | "oauth" => "oauth",
			"session-token" | "session_token" => "session",
			"aws" => "aws",
			"bearer" => "bearer",
			other => other,
		};
		let identity = account
			.account
			.as_str()
			.split_once(':')
			.filter(|(provider, _)| *provider == account.provider.as_str())
			.map_or(account.principal.as_str(), |(_, identity)| identity);
		let blocks = self
			.control
			.blocks(&account.account)
			.into_iter()
			.map(|(scope, until_ms)| json!({"scope": scope.as_str(), "until_ms": until_ms}))
			.collect::<Vec<_>>();
		Ok(json!({
			"id": credential_id(&account.account),
			"provider": account.provider.as_str(),
			"identity": identity,
			"kind": kind,
			"expires_at_ms": metadata.expires_at_ms,
			"disabled": !account.enabled,
			"disabled_cause": if account.enabled { Value::Null } else { Value::String("disabled".into()) },
			"state": if account.enabled { "active" } else { "disabled" },
			"blocks": blocks,
		}))
	}
}

/// Authenticated gateway-backed credential and local masking CONTROL factory.
#[derive(Clone)]
pub struct GatewayCredentialSecretControlFactory {
	channel:         Channel,
	bearer_token:    Option<Arc<SecretString>>,
	attribution:     UsageAttribution,
	grants:          Arc<BTreeMap<Str, CredentialControlGrant>>,
	base_rules:      Arc<[SecretRule]>,
	placeholder_key: Arc<str>,
}

/// Constructs the credential authority used by gateway-mode application
/// composition. `attribution` is resolved once by the application and reused
/// for every broker request.
pub fn gateway_credential_control_factory(
	channel: Channel,
	bearer_token: Option<SecretString>,
	attribution: UsageAttribution,
	grants: BTreeMap<Str, CredentialControlGrant>,
	base_rules: Arc<[SecretRule]>,
	placeholder_key: impl Into<Arc<str>>,
) -> GatewayCredentialSecretControlFactory {
	GatewayCredentialSecretControlFactory {
		channel,
		bearer_token: bearer_token.map(Arc::new),
		attribution,
		grants: Arc::new(grants),
		base_rules,
		placeholder_key: placeholder_key.into(),
	}
}
/// Composes a gateway channel and the current masking snapshot into the
/// session CONTROL factory.
pub fn gateway_credential_secret_control_factory(
	channel: Channel,
	attribution: UsageAttribution,
	grants: BTreeMap<Str, CredentialControlGrant>,
	snapshot: &SecretSessionSnapshot,
) -> GatewayCredentialSecretControlFactory {
	gateway_credential_control_factory(
		channel,
		None,
		attribution,
		grants,
		Arc::from(snapshot.rules().to_vec()),
		Arc::<str>::from(key::placeholder_key()),
	)
}

impl ControlAuthorityFactory for GatewayCredentialSecretControlFactory {
	fn bind(
		&self,
		identity: Arc<ControlConnectionIdentity>,
	) -> Result<Arc<dyn ControlAuthority>, ControlCompositionError> {
		let grant = self
			.grants
			.get(&identity.extension)
			.cloned()
			.unwrap_or_default();
		let masking = SecretMaskingAuthority::new(
			identity.extension.clone(),
			identity.host_generation,
			self.base_rules.iter().cloned(),
			self.placeholder_key.as_ref(),
		)
		.map_err(|error| {
			ControlCompositionError::unavailable("credentials", Str::from(error.to_string()))
		})?;
		Ok(Arc::new(GatewayCredentialSecretControlAuthority {
			identity,
			client: AuthClient::new(self.channel.clone()),
			bearer_token: self.bearer_token.clone(),
			attribution: self.attribution.clone(),
			grant,
			masking,
		}))
	}
}

struct GatewayCredentialSecretControlAuthority {
	identity:     Arc<ControlConnectionIdentity>,
	client:       AuthClient<Channel>,
	bearer_token: Option<Arc<SecretString>>,
	attribution:  UsageAttribution,
	grant:        CredentialControlGrant,
	masking:      SecretMaskingAuthority,
}

#[async_trait::async_trait]
impl ControlAuthority for GatewayCredentialSecretControlAuthority {
	fn handles(&self, operation: &str) -> bool {
		matches!(
			operation,
			"omp.creds.list"
				| "omp.creds.store"
				| "omp.creds.refresh"
				| "omp.creds.clear"
				| "omp.creds.disable"
				| "omp.creds.enable"
				| "omp.creds.report_block"
				| "omp.creds.usage"
				| "omp.creds.mint_scoped"
				| "omp.creds.import_oauth"
				| "omp.creds.reveal"
				| "omp.secrets.declare"
				| "omp.secrets.mask"
		)
	}

	fn authorize(
		&self,
		context: &ControlRequestContext,
		operation: &str,
		arguments: &Map<String, Value>,
	) -> Result<(), ControlProtocolError> {
		self.validate_connection(context)?;
		if !self.handles(operation) {
			return Err(control_error("InvalidOperation", "credential operation is not supported"));
		}
		if operation == "omp.secrets.declare" {
			if context.invocation.is_some() {
				return Err(control_error(
					"InvalidPhase",
					"secret declarations are accepted only before callback activation",
				));
			}
			return Ok(());
		}
		if let Some(invocation) = &context.invocation {
			let minimum = if matches!(
				operation,
				"omp.creds.store"
					| "omp.creds.refresh"
					| "omp.creds.clear"
					| "omp.creds.disable"
					| "omp.creds.enable"
					| "omp.creds.report_block"
					| "omp.creds.mint_scoped"
					| "omp.creds.import_oauth"
					| "omp.creds.reveal"
			) {
				InvocationPhase::EffectsAuthorized
			} else {
				InvocationPhase::Admitted
			};
			if !invocation.phase.allows_operation(minimum) {
				return Err(control_error("InvalidPhase", "credential operation is not allowed now"));
			}
		}
		if operation.starts_with("omp.creds.") {
			let provider = self.provider(arguments)?;
			let scope = if operation == "omp.creds.import_oauth" {
				&self.grant.grants.import
			} else if operation == "omp.creds.reveal" {
				&self.grant.grants.reveal
			} else {
				&self.grant.grants.allow
			};
			scope
				.enforce(provider)
				.map_err(|_| control_error("PermissionError", "credential provider is not granted"))?;
		}
		Ok(())
	}

	async fn request(
		&self,
		context: ControlRequestContext,
		operation: Str,
		arguments: Map<String, Value>,
	) -> Result<Value, ControlProtocolError> {
		self.authorize(&context, operation.as_str(), &arguments)?;
		if operation == "omp.secrets.declare" {
			self
				.masking
				.declare(
					context.connection.extension.as_str(),
					context.connection.host_generation,
					parse_secret_rule(&arguments)?,
				)
				.map_err(secret_control_error)?;
			return Ok(Value::Null);
		}
		if operation == "omp.secrets.mask" {
			return self
				.masking
				.mask(
					context.connection.extension.as_str(),
					context.connection.host_generation,
					required_str(&arguments, "text")?,
				)
				.map(Value::String)
				.map_err(secret_control_error);
		}
		self
			.remote_request(context, operation.as_str(), &arguments)
			.await
	}

	async fn effect(
		&self,
		context: ControlRequestContext,
		_effect: ControlEffect,
	) -> Result<(), ControlProtocolError> {
		self.validate_connection(&context)?;
		Err(control_error("InvalidOperation", "credential authority does not accept effects"))
	}
}

impl GatewayCredentialSecretControlAuthority {
	fn validate_connection(
		&self,
		context: &ControlRequestContext,
	) -> Result<(), ControlProtocolError> {
		if same_control_identity(&self.identity, &context.connection) {
			Ok(())
		} else {
			Err(control_error(
				"StaleGeneration",
				"credential authority belongs to a replaced CONTROL connection",
			))
		}
	}

	fn provider<'a>(
		&'a self,
		arguments: &'a Map<String, Value>,
	) -> Result<&'a str, ControlProtocolError> {
		if let Some(provider) = optional_str(arguments, "provider") {
			return Ok(provider);
		}
		match self.grant.providers.as_ref() {
			[provider] => Ok(provider.as_str()),
			[] => Err(control_error("PermissionError", "no credential provider is granted")),
			_ => Err(control_error(
				"InvalidProvider",
				"provider is required when multiple credential providers are granted",
			)),
		}
	}

	fn authenticated<T>(&self, message: T) -> Result<Request<T>, ControlProtocolError> {
		let mut request = Request::new(message);
		let attribution = self.attribution.headers();
		for name in [INSTALL_ID_HEADER, APP_HEADER, HOSTNAME_HEADER] {
			if let Some(value) = attribution.get(name)
				&& let Ok(value) = value.to_str()
				&& let Ok(value) = MetadataValue::try_from(value)
			{
				request.metadata_mut().insert(name, value);
			}
		}
		if let Some(token) = &self.bearer_token {
			let encoded = Zeroizing::new(format!("Bearer {}", token.expose_secret()));
			let mut value = MetadataValue::try_from(encoded.as_str())
				.map_err(|_| control_error("AuthenticationError", "gateway bearer token is invalid"))?;
			value.set_sensitive(true);
			request.metadata_mut().insert("authorization", value);
		}
		Ok(request)
	}

	async fn list(&self, provider: &str) -> Result<Vec<v1::CredentialMeta>, ControlProtocolError> {
		self
			.client
			.clone()
			.list_credentials(self.authenticated(ListCredentialsRequest {
				provider: provider.to_owned(),
				states:   Vec::new(),
			})?)
			.await
			.map_err(remote_control_error)
			.map(|response| response.into_inner().credentials)
	}

	async fn selected_credential_id(
		&self,
		provider: &str,
		arguments: &Map<String, Value>,
	) -> Result<u64, ControlProtocolError> {
		let requested = arguments
			.get("id")
			.filter(|value| !value.is_null())
			.map(|value| {
				value
					.as_u64()
					.ok_or_else(|| control_error("InvalidCredential", "credential id is invalid"))
			})
			.transpose()?;
		let mut matches = self
			.list(provider)
			.await?
			.into_iter()
			.filter(|credential| requested.is_none_or(|id| credential.id == id));
		let first = matches
			.next()
			.ok_or_else(|| control_error("CredentialNotFound", "credential was not found"))?;
		if matches.next().is_some() {
			return Err(control_error(
				"AmbiguousCredential",
				"credential selector matched more than one account",
			));
		}
		Ok(first.id)
	}

	async fn remote_request(
		&self,
		context: ControlRequestContext,
		operation: &str,
		arguments: &Map<String, Value>,
	) -> Result<Value, ControlProtocolError> {
		let provider = self.provider(arguments)?.to_owned();
		let mut client = self.client.clone();
		match operation {
			"omp.creds.list" => Ok(Value::Array(
				self
					.list(&provider)
					.await?
					.into_iter()
					.map(remote_metadata_value)
					.collect(),
			)),
			"omp.creds.store" => {
				let credential = required_object(arguments, "cred")?;
				if !matches!(required_str(credential, "kind")?, "api_key" | "api-key") {
					return Err(control_error(
						"InvalidCredential",
						"gateway credential store accepts API keys; use import_oauth for OAuth",
					));
				}
				let api_key = unseal_string(
					credential
						.get("secret")
						.ok_or_else(|| control_error("InvalidCredential", "secret is missing"))?,
				)?;
				client
					.put_api_key(self.authenticated(PutApiKeyRequest {
						provider,
						api_key: api_key.expose_secret().to_owned(),
					})?)
					.await
					.map_err(remote_control_error)
					.map(|response| remote_metadata_value(response.into_inner()))
			},
			"omp.creds.import_oauth" => {
				let refresh_token =
					unseal_string(arguments.get("refresh_token").ok_or_else(|| {
						control_error("InvalidCredential", "refresh_token is missing")
					})?)?;
				let access_token = arguments
					.get("access_token")
					.filter(|value| !value.is_null())
					.map(unseal_string)
					.transpose()?;
				client
					.import_o_auth(
						self.authenticated(ImportOAuthRequest {
							provider,
							refresh_token: refresh_token.expose_secret().to_owned(),
							access_token: access_token
								.as_ref()
								.map_or_else(String::new, |token| token.expose_secret().to_owned()),
							expires_at_ms: optional_u64(arguments, "expires_at_ms")?.unwrap_or_default(),
							identity: optional_str(arguments, "identity")
								.unwrap_or_default()
								.to_owned(),
							props: None,
						})?,
					)
					.await
					.map_err(remote_control_error)
					.map(|response| remote_metadata_value(response.into_inner()))
			},
			"omp.creds.refresh" => {
				let id = match self.selected_credential_id(&provider, arguments).await {
					Ok(id) => id,
					Err(error) => {
						tracing::debug!(
							provider = %provider,
							error = %error,
							"credential refresh preflight rejected"
						);
						return Err(error);
					},
				};
				let span = tracing::debug_span!(
					"oauth_refresh",
					authority = "gateway",
					provider = %provider,
					credential_id = id
				);
				let response = client
					.refresh_credential(self.authenticated(RefreshCredentialRequest { id })?)
					.instrument(span)
					.await
					.map_err(|error| {
						tracing::warn!(
							provider = %provider,
							credential_id = id,
							error = %error,
							"OAuth credential refresh failed"
						);
						remote_control_error(error)
					})?;
				tracing::debug!(
					provider = %provider,
					credential_id = id,
					"OAuth credential refresh completed"
				);
				Ok(remote_metadata_value(response.into_inner()))
			},
			"omp.creds.clear" => {
				let id = self.selected_credential_id(&provider, arguments).await?;
				client
					.delete_credential(self.authenticated(DeleteCredentialRequest { id })?)
					.await
					.map_err(remote_control_error)?;
				Ok(Value::Null)
			},
			"omp.creds.disable" => {
				let id = self.selected_credential_id(&provider, arguments).await?;
				client
					.disable_credential(self.authenticated(DisableCredentialRequest {
						id,
						cause: required_str(arguments, "cause")?.to_owned(),
					})?)
					.await
					.map_err(remote_control_error)
					.map(|response| remote_metadata_value(response.into_inner()))
			},
			"omp.creds.enable" => {
				let id = self.selected_credential_id(&provider, arguments).await?;
				client
					.enable_credential(self.authenticated(EnableCredentialRequest { id })?)
					.await
					.map_err(remote_control_error)
					.map(|response| remote_metadata_value(response.into_inner()))
			},
			"omp.creds.report_block" => {
				let id = self.selected_credential_id(&provider, arguments).await?;
				client
					.report_block(
						self.authenticated(ReportBlockRequest {
							id,
							block: Some(Block {
								scope:        optional_str(arguments, "scope")
									.unwrap_or("shared")
									.to_owned(),
								provider_key: String::new(),
								until_ms:     required_u64(arguments, "until_ms")?,
							}),
						})?,
					)
					.await
					.map_err(remote_control_error)?;
				Ok(Value::Null)
			},
			"omp.creds.usage" => Ok(Value::Null),
			"omp.creds.mint_scoped" => {
				let response = client
					.mint_scoped_token(self.authenticated(MintScopedTokenRequest {
						provider,
						facet: required_str(arguments, "facet")?.to_owned(),
						session_id: context.connection.session_generation.to_string(),
					})?)
					.await
					.map_err(remote_control_error)?
					.into_inner();
				Ok(json!({"token": response.token, "expires_at_ms": response.expires_at_ms}))
			},
			"omp.creds.reveal" => {
				let id = self.selected_credential_id(&provider, arguments).await?;
				let response = client
					.reveal_credential(self.authenticated(RevealCredentialRequest {
						id,
						provider,
						extension: context.connection.extension.to_string(),
						caller_principal: context.connection.principal.id().to_owned(),
						host_generation: context.connection.host_generation,
						session_generation: context.connection.session_generation,
						request_id: context.request_id,
						reason: "extension_control_reveal".to_owned(),
					})?)
					.await
					.map_err(remote_control_error)?
					.into_inner();
				let secret = Zeroizing::new(response.secret.to_vec());
				Ok(json!({
					"encoding": "base64",
					"data": omp_core::base64::encode(secret.as_slice()).into_string(),
				}))
			},
			_ => Err(control_error("InvalidOperation", "credential operation is not supported")),
		}
	}
}

fn remote_metadata_value(metadata: v1::CredentialMeta) -> Value {
	let kind = match metadata.kind() {
		credential_meta::Kind::ApiKey => "api_key",
		credential_meta::Kind::Oauth => "oauth",
		credential_meta::Kind::Aws => "aws",
		credential_meta::Kind::Unspecified => "unspecified",
	};
	let disabled = metadata.state() == credential_meta::State::Disabled;
	json!({
		"id": metadata.id,
		"provider": metadata.provider,
		"identity": metadata.identity,
		"kind": kind,
		"expires_at_ms": (metadata.expires_at_ms != 0).then_some(metadata.expires_at_ms),
		"disabled": disabled,
		"disabled_cause": (!metadata.disabled_cause.is_empty()).then_some(metadata.disabled_cause),
		"state": if disabled { "disabled" } else { "active" },
		"blocks": metadata.blocks.into_iter().map(|block| {
			json!({"scope": block.scope, "until_ms": block.until_ms})
		}).collect::<Vec<_>>(),
	})
}

fn remote_control_error(error: tonic::Status) -> ControlProtocolError {
	let code = match error.code() {
		tonic::Code::PermissionDenied | tonic::Code::Unauthenticated => "PermissionError",
		tonic::Code::NotFound => "CredentialNotFound",
		tonic::Code::Aborted => "GenerationConflict",
		tonic::Code::InvalidArgument => "InvalidCredential",
		_ => "CredentialOperationFailed",
	};
	control_error(code, error.message())
}

fn parse_secret_rule(arguments: &Map<String, Value>) -> Result<SecretRule, ControlProtocolError> {
	let rule = arguments
		.get("rule")
		.and_then(Value::as_object)
		.unwrap_or(arguments);
	let raw_kind = required_str(rule, "kind")?;
	let (kind, content) = if raw_kind.eq_ignore_ascii_case("env") {
		let name = required_str(rule, "content")?;
		let content = env::var(name)
			.map_err(|_| control_error("SecretEnvironmentMissing", "secret environment is absent"))?;
		(SecretKind::Plain, content)
	} else {
		(
			SecretKind::from_str(raw_kind)
				.map_err(|_| control_error("InvalidSecretRule", "secret kind is invalid"))?,
			required_str(rule, "content")?.to_owned(),
		)
	};
	let mode = SecretMode::from_str(required_str(rule, "mode")?)
		.map_err(|_| control_error("InvalidSecretRule", "secret mode is invalid"))?;
	SecretRule::new(
		kind,
		mode,
		content,
		optional_str(rule, "replacement").map(Str::from),
		optional_str(rule, "flags"),
		optional_str(rule, "friendly_name").map(Str::from),
	)
	.map_err(|_| control_error("InvalidSecretRule", "secret rule is invalid"))
}

fn unseal_secret(value: &Value) -> Result<Secret, ControlProtocolError> {
	let sealed = value
		.as_object()
		.ok_or_else(|| control_error("InvalidCredential", "sealed secret is not an object"))?;
	if optional_str(sealed, "encoding") != Some("base64") {
		return Err(control_error("InvalidCredential", "sealed secret encoding is invalid"));
	}
	let encoded = required_str(sealed, "data")?;
	let bytes = omp_core::base64::decode(encoded.as_bytes())
		.into_vec()
		.map_err(|_| control_error("InvalidCredential", "sealed secret base64 is invalid"))?;
	Ok(Secret::new(bytes))
}

fn unseal_string(value: &Value) -> Result<SecretString, ControlProtocolError> {
	let secret = unseal_secret(value)?;
	secret.expose(|bytes| {
		str::from_utf8(bytes)
			.map(SecretString::from)
			.map_err(|_| control_error("InvalidCredential", "credential secret is not UTF-8"))
	})
}

fn required_object<'a>(
	arguments: &'a Map<String, Value>,
	field: &str,
) -> Result<&'a Map<String, Value>, ControlProtocolError> {
	arguments
		.get(field)
		.and_then(Value::as_object)
		.ok_or_else(|| control_error("InvalidCredential", format!("{field} must be an object")))
}

fn required_str<'a>(
	arguments: &'a Map<String, Value>,
	field: &str,
) -> Result<&'a str, ControlProtocolError> {
	optional_str(arguments, field)
		.ok_or_else(|| control_error("InvalidCredential", format!("{field} is required")))
}

fn optional_str<'a>(arguments: &'a Map<String, Value>, field: &str) -> Option<&'a str> {
	arguments
		.get(field)
		.filter(|value| !value.is_null())
		.and_then(Value::as_str)
}

fn required_u64(arguments: &Map<String, Value>, field: &str) -> Result<u64, ControlProtocolError> {
	arguments
		.get(field)
		.and_then(Value::as_u64)
		.ok_or_else(|| control_error("InvalidCredential", format!("{field} is required")))
}

fn optional_u64(
	arguments: &Map<String, Value>,
	field: &str,
) -> Result<Option<u64>, ControlProtocolError> {
	arguments
		.get(field)
		.filter(|value| !value.is_null())
		.map(|value| {
			value
				.as_u64()
				.ok_or_else(|| control_error("InvalidCredential", format!("{field} is invalid")))
		})
		.transpose()
}

fn credential_id(account: &AccountId<str>) -> u64 {
	if let Ok(id) = account.as_str().parse() {
		return id;
	}
	let mut hash = 0xcbf2_9ce4_8422_2325_u64;
	for byte in b"omp/auth/control-id/v1"
		.iter()
		.chain(account.as_str().as_bytes())
	{
		hash ^= u64::from(*byte);
		hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
	}
	hash
}

fn same_control_identity(
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

fn control_error(code: impl Into<Str>, message: impl Into<Str>) -> ControlProtocolError {
	ControlProtocolError::new(code, message)
}

fn store_control_error(error: auth::StoreError) -> ControlProtocolError {
	match error {
		auth::StoreError::NotFound => control_error("CredentialNotFound", "credential was not found"),
		auth::StoreError::GenerationConflict | auth::StoreError::RevealAuditConflict => {
			control_error("CredentialConflict", error.to_string())
		},
		auth::StoreError::InvalidRevealAudit | auth::StoreError::InvalidScopedGrant => {
			control_error("PermissionError", error.to_string())
		},
		_ => control_error("CredentialStoreError", error.to_string()),
	}
}

fn auth_control_error(error: omp_ai::Error) -> ControlProtocolError {
	control_error("CredentialOperationFailed", error.to_string())
}

fn secret_control_error(error: omp_secrets::SecretMaskingError) -> ControlProtocolError {
	match error {
		omp_secrets::SecretMaskingError::OwnerMismatch
		| omp_secrets::SecretMaskingError::GenerationMismatch { .. } => {
			control_error("StaleGeneration", error.to_string())
		},
		omp_secrets::SecretMaskingError::Sealed => {
			control_error("SecretDeclarationsSealed", error.to_string())
		},
		_ => control_error("SecretMaskingFailed", error.to_string()),
	}
}

/// Environment-backed executor for `!command` credential sources.
#[derive(Clone, Debug)]
pub(crate) struct EnvCommandCredentialExecutor {
	client:     EnvClient,
	cwd:        EnvPath,
	timeout:    Duration,
	max_stdout: usize,
}

impl EnvCommandCredentialExecutor {
	/// Creates a bounded command credential executor rooted at `cwd`.
	pub(crate) const fn new(
		client: EnvClient,
		cwd: EnvPath,
		timeout: Duration,
		max_stdout: usize,
	) -> Self {
		Self { client, cwd, timeout, max_stdout }
	}

	async fn execute_inner(
		&self,
		command: Str,
		cancellation: CancellationToken,
	) -> Result<SecretString, CommandCredentialError> {
		let opened = self
			.client
			.open_session(&self.cwd, OpenSessionRequest::default())
			.await
			.map_err(|_| CommandCredentialError::Execution)?;
		let session = opened.session.clone();
		let run = self
			.client
			.exec(ExecRequest {
				session: opened.session,
				source: Some(Script { text: command.to_string(), ..Script::default() }),
				..ExecRequest::default()
			})
			.await;
		let result = match run {
			Ok(mut run) => {
				let mut stdout = Zeroizing::new(Vec::new());
				loop {
					let event = tokio::select! {
						() = cancellation.cancelled() => {
							Err(CommandCredentialError::Cancelled)
						},
						event = tokio::time::timeout(self.timeout, run.next_event()) => {
							match event {
								Ok(event) => event.map_err(|_| CommandCredentialError::Execution),
								Err(_) => Err(CommandCredentialError::Timeout),
							}
						},
					};
					let event = match event {
						Ok(event) => event,
						Err(error) => break Err(error),
					};
					match event {
						Some(ExecEvent::Output(frame))
							if frame.channel == OutputChannel::Stdout as i32 =>
						{
							if stdout.len().saturating_add(frame.data.len()) > self.max_stdout {
								break Err(CommandCredentialError::OutputTooLarge);
							}
							stdout.extend_from_slice(&frame.data);
						},
						Some(ExecEvent::Exit(exit)) => {
							let Some(status) = exit.status else {
								break Err(CommandCredentialError::Execution);
							};
							if status.outcome == ExecOutcome::Timeout as i32 {
								break Err(CommandCredentialError::Timeout);
							}
							if status.outcome == ExecOutcome::Cancelled as i32 {
								break Err(CommandCredentialError::Cancelled);
							}
							if status.outcome != ExecOutcome::Exited as i32 || status.exit_code != Some(0)
							{
								break Err(CommandCredentialError::Execution);
							}
							let text =
								str::from_utf8(&stdout).map_err(|_| CommandCredentialError::InvalidUtf8)?;
							let trimmed = text.trim();
							if trimmed.is_empty() {
								break Err(CommandCredentialError::Empty);
							}
							break Ok(SecretString::from(trimmed));
						},
						Some(ExecEvent::Started(_) | ExecEvent::Output(_)) => {},
						None => break Err(CommandCredentialError::Execution),
					}
				}
			},
			Err(_) => Err(CommandCredentialError::Execution),
		};
		let _ = self
			.client
			.close_session(CloseSessionRequest { session, ..CloseSessionRequest::default() })
			.await;
		result
	}
}

impl CommandCredentialExecutor for EnvCommandCredentialExecutor {
	fn execute(&self, command: Str, cancellation: CancellationToken) -> CommandExecutionFuture {
		let executor = self.clone();
		Box::pin(async move { executor.execute_inner(command, cancellation).await })
	}
}
