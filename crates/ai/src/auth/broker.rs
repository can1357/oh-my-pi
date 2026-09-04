//! Catalog-aware credential acquisition across typed source engines.

use std::{collections::BTreeMap, env, fmt, sync::Arc};

use futures::future::{Either, FutureExt as _};
use omp_catalog::{AuthSpecId, Catalog, provider::AuthSpecKind};
use omp_core::{SecretString, Str, sf};

use super::{
	aws::AwsCredentialSource,
	lease::{
		AuthRejection, CredentialError, CredentialFuture, CredentialKind, CredentialLease,
		CredentialNeed, CredentialSource, LeaseMeta, credential_ready,
	},
};
use crate::{AccountId, PrincipalId};

const ENVIRONMENT_TAG: &str = "environment";
const STORED_TAG: &str = "stored";
const ADC_TAG: &str = "application-default";
const AWS_TAG: &str = "aws-chain";
const OAUTH_TAG: &str = "oauth";
const SESSION_TAG: &str = "session";
const INVOCATION_TAG: &str = "invocation";

/// Secret environment boundary used by [`CredentialBroker`].
pub trait CredentialEnvironment: Send + Sync {
	/// Reads one exact catalog-declared name into a zeroizing secret wrapper.
	fn read(&self, name: &str) -> Result<Option<SecretString>, CredentialError>;
}

/// Process environment implementation that performs no alias or fallback
/// lookup.
#[derive(Clone, Copy, Debug, Default)]
pub struct SystemCredentialEnvironment;

impl CredentialEnvironment for SystemCredentialEnvironment {
	fn read(&self, name: &str) -> Result<Option<SecretString>, CredentialError> {
		if name.is_empty() {
			return Err(CredentialError::InvalidSource);
		}
		match env::var(name) {
			Ok(value) if value.is_empty() => Err(CredentialError::InvalidSource),
			Ok(value) => Ok(Some(SecretString::from(value))),
			Err(env::VarError::NotPresent) => Ok(None),
			Err(env::VarError::NotUnicode(_)) => Err(CredentialError::SourceFailure),
		}
	}
}

/// Optional typed engines used by the catalog credential broker.
#[derive(Clone, Default)]
pub struct CredentialBrokerEngines {
	/// Encrypted account-store engine.
	pub stored:              Option<Arc<dyn CredentialSource>>,
	/// Application-default credential engine.
	pub application_default: Option<Arc<dyn CredentialSource>>,
	/// AWS credential-chain engine.
	pub aws:                 Option<Arc<dyn CredentialSource>>,
	/// OAuth login/refresh engine.
	pub oauth:               Option<Arc<dyn CredentialSource>>,
	/// Interactive provider-session engine.
	pub session:             Option<Arc<dyn CredentialSource>>,
}

impl fmt::Debug for CredentialBrokerEngines {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("CredentialBrokerEngines")
			.field("stored", &self.stored.is_some())
			.field("application_default", &self.application_default.is_some())
			.field("aws", &self.aws.is_some())
			.field("oauth", &self.oauth.is_some())
			.field("session", &self.session.is_some())
			.finish()
	}
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum EngineKind {
	Stored,
	ApplicationDefault,
	Aws,
	OAuth,
	Session,
}

impl EngineKind {
	const fn tag(self) -> &'static str {
		match self {
			Self::Stored => STORED_TAG,
			Self::ApplicationDefault => ADC_TAG,
			Self::Aws => AWS_TAG,
			Self::OAuth => OAUTH_TAG,
			Self::Session => SESSION_TAG,
		}
	}
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum BrokerSource {
	Environment(Box<[Str]>),
	BasicEnvironment { username_names: Box<[Str]>, password_names: Box<[Str]> },
	Engine(EngineKind),
}
#[derive(Clone, Debug)]
struct InvocationOverride {
	specs:  Arc<BTreeMap<AuthSpecId, CredentialKind>>,
	secret: SecretString,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct BrokerPlan {
	kind:    CredentialKind,
	sources: Box<[BrokerSource]>,
}

/// Catalog compilation failure for credential acquisition plans.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum CredentialBrokerError {
	/// An authenticated catalog record has no declared acquisition source.
	#[error("catalog authentication specification has no credential source")]
	MissingSource(AuthSpecId),
	/// A credential environment source is empty or does not lead with an OMP
	/// name.
	#[error("catalog credential environment source must lead with an OMP_* name")]
	InvalidEnvironment(AuthSpecId),
	/// The selected provider does not exist in the catalog.
	#[error("invocation credential override names an unknown provider")]
	UnknownProvider(omp_catalog::ProviderId),
	/// The selected provider has no scalar authentication compatible with a
	/// generic API key.
	#[error("selected provider does not accept a generic invocation API key")]
	UnsupportedOverride(omp_catalog::ProviderId),
}

/// Catalog-aware composite credential source.
///
/// Plans retain exact catalog source order. Only `Unavailable` advances to the
/// next source; cancellation, invalid source, expiry, staleness, and engine
/// failure remain typed terminal evidence.
#[derive(Clone)]
pub struct CredentialBroker {
	plans:       Arc<BTreeMap<AuthSpecId, BrokerPlan>>,
	environment: Arc<dyn CredentialEnvironment>,
	engines:     CredentialBrokerEngines,
	invocation:  Option<InvocationOverride>,
}

impl CredentialBroker {
	/// Compiles immutable acquisition plans from the canonical catalog.
	pub fn from_catalog(
		catalog: &Catalog,
		environment: Arc<dyn CredentialEnvironment>,
		engines: CredentialBrokerEngines,
	) -> Result<Self, CredentialBrokerError> {
		let mut plans = BTreeMap::new();
		for auth in catalog.auth_specs() {
			let Some(kind) = credential_kind(auth.kind) else {
				continue;
			};
			let mut sources = Vec::with_capacity(auth.credential_sources.len());
			for source in &auth.credential_sources {
				use omp_catalog::provider::CredentialSourceSpec as CatalogSource;
				let source = match source {
					CatalogSource::Environment { ordered_names } => {
						if ordered_names
							.first()
							.is_none_or(|name| !name.starts_with("OMP_"))
						{
							return Err(CredentialBrokerError::InvalidEnvironment(auth.id.clone()));
						}
						BrokerSource::Environment(ordered_names.clone())
					},
					CatalogSource::BasicEnvironment { username_names, password_names } => {
						if username_names
							.first()
							.is_none_or(|name| !name.starts_with("OMP_"))
							|| password_names
								.first()
								.is_none_or(|name| !name.starts_with("OMP_"))
						{
							return Err(CredentialBrokerError::InvalidEnvironment(auth.id.clone()));
						}
						BrokerSource::BasicEnvironment {
							username_names: username_names.clone(),
							password_names: password_names.clone(),
						}
					},
					CatalogSource::Stored => BrokerSource::Engine(EngineKind::Stored),
					CatalogSource::ApplicationDefault { .. } => {
						BrokerSource::Engine(EngineKind::ApplicationDefault)
					},
					CatalogSource::AwsChain => BrokerSource::Engine(EngineKind::Aws),
					CatalogSource::Oauth { .. } => BrokerSource::Engine(EngineKind::OAuth),
					CatalogSource::Session => BrokerSource::Engine(EngineKind::Session),
				};
				sources.push(source);
			}
			if sources.is_empty() {
				return Err(CredentialBrokerError::MissingSource(auth.id.clone()));
			}
			plans.insert(auth.id.clone(), BrokerPlan { kind, sources: sources.into_boxed_slice() });
		}
		Ok(Self { plans: Arc::new(plans), environment, engines, invocation: None })
	}

	/// Uses the process environment without upstream aliases and installs the
	/// complete process-wide AWS credential chain when no injected engine was
	/// supplied.
	pub fn system(
		catalog: &Catalog,
		mut engines: CredentialBrokerEngines,
	) -> Result<Self, CredentialBrokerError> {
		if engines.aws.is_none() {
			engines.aws = Some(Arc::new(AwsCredentialSource::system()));
		}
		Self::from_catalog(catalog, Arc::new(SystemCredentialEnvironment), engines)
	}

	/// Returns a session-owned broker overlay for one selected provider.
	///
	/// The generic key is held only by the returned clone. It is never written
	/// to the process environment or delegated to a durable credential engine.
	pub fn with_api_key_override(
		&self,
		catalog: &Catalog,
		provider: &omp_catalog::ProviderId<str>,
		secret: SecretString,
	) -> Result<Self, CredentialBrokerError> {
		let provider = catalog
			.provider(provider)
			.ok_or_else(|| CredentialBrokerError::UnknownProvider(provider.to_owned()))?;
		let specs = provider
			.auth
			.iter()
			.filter_map(|id| {
				let kind = credential_kind(catalog.auth_spec(id)?.kind)?;
				matches!(
					kind,
					CredentialKind::ApiKey | CredentialKind::Bearer | CredentialKind::SessionToken
				)
				.then(|| (id.clone(), kind))
			})
			.collect::<BTreeMap<_, _>>();
		if specs.is_empty() {
			return Err(CredentialBrokerError::UnsupportedOverride(provider.id.clone()));
		}
		let mut broker = self.clone();
		broker.invocation = Some(InvocationOverride { specs: Arc::new(specs), secret });
		Ok(broker)
	}

	/// Refreshes the renewable engine for an exact account/spec selection.
	///
	/// Stored OAuth is authoritative when installed. An AWS-only plan refreshes
	/// its chain in place so rejected or expiring role credentials are
	/// re-resolved. Environment, invocation, ADC, and session sources remain
	/// nonrenewable, and no ordinary source fallback occurs.
	pub fn refresh_account(
		&self,
		need: CredentialNeed,
	) -> CredentialFuture<'_, Result<CredentialLease, CredentialError>> {
		let Some(plan) = self.plans.get(&need.spec) else {
			return credential_ready(Err(CredentialError::InvalidSource));
		};
		let Some(selected) = [EngineKind::Stored, EngineKind::OAuth, EngineKind::Aws]
			.into_iter()
			.find(|kind| {
				self.engine(*kind).is_some()
					&& plan
						.sources
						.iter()
						.any(|source| source == &BrokerSource::Engine(*kind))
			})
		else {
			return credential_ready(Err(CredentialError::Unavailable));
		};
		let kind = plan.kind;
		let refreshed = self
			.engine(selected)
			.expect("selected installed renewable engine")
			.refresh_lease(need.clone());
		map_credential(refreshed, move |result| {
			result.and_then(|lease| Self::validate_lease(lease, &need, kind, selected.tag()))
		})
	}

	/// Refreshes the exact source that produced a rejected lease and returns
	/// its new generation once.
	///
	/// Environment and invocation credentials are nonrenewable and fail
	/// closed; no later source is tried.
	pub fn refresh_lease<'a>(
		&'a self,
		rejected: &'a CredentialLease,
		need: CredentialNeed,
	) -> CredentialFuture<'a, Result<CredentialLease, CredentialError>> {
		let Some(tag) = rejected.source_tag() else {
			return credential_ready(Err(CredentialError::InvalidSource));
		};
		let engine = match tag {
			STORED_TAG => EngineKind::Stored,
			AWS_TAG => EngineKind::Aws,
			OAUTH_TAG => EngineKind::OAuth,
			ENVIRONMENT_TAG | INVOCATION_TAG | ADC_TAG | SESSION_TAG => {
				return credential_ready(Err(CredentialError::Unavailable));
			},
			_ => return credential_ready(Err(CredentialError::InvalidSource)),
		};
		let Some(plan) = self.plans.get(&need.spec) else {
			return credential_ready(Err(CredentialError::InvalidSource));
		};
		let Some(source) = self.engine(engine) else {
			return credential_ready(Err(CredentialError::Unavailable));
		};
		let kind = plan.kind;
		map_credential(source.refresh_lease(need.clone()), move |result| {
			result.and_then(|lease| Self::validate_lease(lease, &need, kind, engine.tag()))
		})
	}

	fn invocation_lease(
		&self,
		need: &CredentialNeed,
	) -> Option<Result<CredentialLease, CredentialError>> {
		let invocation = self.invocation.as_ref()?;
		let kind = *invocation.specs.get(&need.spec)?;
		let account = need
			.account
			.clone()
			.unwrap_or_else(|| AccountId::from("invocation"));
		let principal = need
			.principal
			.clone()
			.unwrap_or_else(|| PrincipalId::from("invocation"));
		let meta = LeaseMeta { account, principal, generation: 0, expires_at: None };
		let lease = match kind {
			CredentialKind::ApiKey => CredentialLease::api_key(meta, invocation.secret.clone()),
			CredentialKind::Bearer => CredentialLease::bearer(meta, invocation.secret.clone()),
			CredentialKind::SessionToken => {
				CredentialLease::session_token(meta, invocation.secret.clone())
			},
			CredentialKind::Basic | CredentialKind::AwsSigV4 => {
				return Some(Err(CredentialError::InvalidSource));
			},
		};
		Some(Ok(lease.with_source_tag(sf!(INVOCATION_TAG))))
	}

	fn engine(&self, kind: EngineKind) -> Option<&Arc<dyn CredentialSource>> {
		match kind {
			EngineKind::Stored => self.engines.stored.as_ref(),
			EngineKind::ApplicationDefault => self.engines.application_default.as_ref(),
			EngineKind::Aws => self.engines.aws.as_ref(),
			EngineKind::OAuth => self.engines.oauth.as_ref(),
			EngineKind::Session => self.engines.session.as_ref(),
		}
	}

	/// Reads the first declared name that is set, tracing every miss.
	///
	/// Returns the name that produced the secret so the lease can be
	/// attributed without exposing the value.
	fn read_environment<'n>(
		&self,
		names: &'n [Str],
		spec: &AuthSpecId,
	) -> Result<Option<(&'n Str, SecretString)>, CredentialError> {
		for name in names {
			match self.environment.read(name)? {
				Some(secret) => {
					tracing::debug!(spec = %spec, variable = %name, "credential environment variable set");
					return Ok(Some((name, secret)));
				},
				None => {
					tracing::debug!(spec = %spec, variable = %name, "credential environment variable unset");
				},
			}
		}
		Ok(None)
	}

	/// Lease identity for an environment credential.
	///
	/// Brokered routes (no durable account selected) carry no identity, so the
	/// lease is attributed to the environment and the variable that produced
	/// it; an explicit account/principal from a selected record is kept.
	fn environment_meta(need: &CredentialNeed, variable: &Str) -> LeaseMeta {
		let account = need
			.account
			.clone()
			.unwrap_or_else(|| AccountId::from(ENVIRONMENT_TAG));
		let principal = need
			.principal
			.clone()
			.unwrap_or_else(|| PrincipalId::from(variable.as_str()));
		LeaseMeta { account, principal, generation: 0, expires_at: None }
	}

	fn environment_lease(
		&self,
		names: &[Str],
		need: &CredentialNeed,
		kind: CredentialKind,
	) -> Result<CredentialLease, CredentialError> {
		let Some((variable, secret)) = self.read_environment(names, &need.spec)? else {
			return Err(CredentialError::Unavailable);
		};
		let meta = Self::environment_meta(need, variable);
		let lease = match kind {
			CredentialKind::ApiKey => CredentialLease::api_key(meta, secret),
			CredentialKind::Basic => return Err(CredentialError::InvalidSource),
			CredentialKind::Bearer => CredentialLease::bearer(meta, secret),
			CredentialKind::SessionToken => CredentialLease::session_token(meta, secret),
			CredentialKind::AwsSigV4 => return Err(CredentialError::InvalidSource),
		};
		Ok(lease.with_source_tag(sf!(ENVIRONMENT_TAG)))
	}

	fn basic_environment_lease(
		&self,
		username_names: &[Str],
		password_names: &[Str],
		need: &CredentialNeed,
	) -> Result<CredentialLease, CredentialError> {
		let Some((variable, username)) = self.read_environment(username_names, &need.spec)? else {
			return Err(CredentialError::Unavailable);
		};
		let Some((_, password)) = self.read_environment(password_names, &need.spec)? else {
			return Err(CredentialError::Unavailable);
		};
		let meta = Self::environment_meta(need, variable);
		Ok(CredentialLease::basic(meta, username, password).with_source_tag(sf!(ENVIRONMENT_TAG)))
	}

	fn validate_lease(
		lease: CredentialLease,
		need: &CredentialNeed,
		expected: CredentialKind,
		tag: &'static str,
	) -> Result<CredentialLease, CredentialError> {
		if lease.kind() != expected {
			return Err(CredentialError::InvalidSource);
		}
		if need
			.account
			.as_ref()
			.is_some_and(|account| account != &lease.meta().account)
			|| need
				.principal
				.as_ref()
				.is_some_and(|principal| principal != &lease.meta().principal)
		{
			return Err(CredentialError::InvalidSource);
		}
		if lease.is_expired_at(need.valid_after) {
			return Err(CredentialError::Expired);
		}
		Ok(lease.with_source_tag(Str::new(tag)))
	}
}

impl fmt::Debug for CredentialBroker {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("CredentialBroker")
			.field("plans", &self.plans.len())
			.field("engines", &self.engines)
			.field("invocation", &self.invocation.is_some())
			.finish()
	}
}

impl CredentialBroker {
	/// Tries one plan source; `Err(Unavailable)` means "try the next".
	fn source_lease(
		&self,
		source: &BrokerSource,
		need: &CredentialNeed,
		kind: CredentialKind,
	) -> CredentialFuture<'_, Result<CredentialLease, CredentialError>> {
		match source {
			BrokerSource::Environment(names) => {
				credential_ready(self.environment_lease(names, need, kind))
			},
			BrokerSource::BasicEnvironment { username_names, password_names } => {
				credential_ready(self.basic_environment_lease(username_names, password_names, need))
			},
			BrokerSource::Engine(engine) => match self.engine(*engine) {
				Some(installed) => {
					let need = need.clone();
					let tag = engine.tag();
					map_credential(installed.lease(need.clone()), move |result| {
						result.and_then(|lease| Self::validate_lease(lease, &need, kind, tag))
					})
				},
				None => credential_ready(Err(CredentialError::Unavailable)),
			},
		}
	}
}

impl CredentialSource for CredentialBroker {
	/// Walks the plan's sources in order. Every source that answers
	/// synchronously (environment, invocation, the encrypted store) is
	/// resolved inline; the first source that must perform I/O boxes the
	/// remainder of the walk once.
	fn lease(
		&self,
		need: CredentialNeed,
	) -> CredentialFuture<'_, Result<CredentialLease, CredentialError>> {
		if let Some(lease) = self.invocation_lease(&need) {
			return credential_ready(lease);
		}
		let Some(plan) = self.plans.get(&need.spec) else {
			return credential_ready(Err(CredentialError::InvalidSource));
		};
		let mut sources = plan.sources.iter();
		while let Some(source) = sources.next() {
			let pending = match self.source_lease(source, &need, plan.kind) {
				Either::Left(ready) => {
					let result = ready.into_inner();
					if matches!(&result, Err(CredentialError::Unavailable)) {
						continue;
					}
					return credential_ready(result);
				},
				Either::Right(pending) => pending,
			};
			let kind = plan.kind;
			return Either::Right(
				async move {
					let result = pending.await;
					if !matches!(&result, Err(CredentialError::Unavailable)) {
						return result;
					}
					for source in sources {
						let result = self.source_lease(source, &need, kind).await;
						if !matches!(&result, Err(CredentialError::Unavailable)) {
							return result;
						}
					}
					Err(CredentialError::Unavailable)
				}
				.boxed(),
			);
		}
		credential_ready(Err(CredentialError::Unavailable))
	}

	fn reject<'a>(
		&'a self,
		lease: &'a CredentialLease,
		evidence: AuthRejection,
	) -> CredentialFuture<'a, Result<(), CredentialError>> {
		let Some(tag) = lease.source_tag() else {
			return credential_ready(Err(CredentialError::InvalidSource));
		};
		let kind = match tag {
			ENVIRONMENT_TAG | INVOCATION_TAG => return credential_ready(Ok(())),
			STORED_TAG => EngineKind::Stored,
			ADC_TAG => EngineKind::ApplicationDefault,
			AWS_TAG => EngineKind::Aws,
			OAUTH_TAG => EngineKind::OAuth,
			SESSION_TAG => EngineKind::Session,
			_ => return credential_ready(Err(CredentialError::InvalidSource)),
		};
		match self.engine(kind) {
			Some(engine) => engine.reject(lease, evidence),
			None => credential_ready(Err(CredentialError::Unavailable)),
		}
	}
}

/// Applies a synchronous continuation to a credential future without
/// allocating when the answer is already known.
fn map_credential<'a, T: Send + 'a, U: Send + 'a>(
	future: CredentialFuture<'a, T>,
	map: impl FnOnce(T) -> U + Send + 'a,
) -> CredentialFuture<'a, U> {
	match future {
		Either::Left(ready) => credential_ready(map(ready.into_inner())),
		Either::Right(pending) => Either::Right(pending.map(map).boxed()),
	}
}

const fn credential_kind(kind: AuthSpecKind) -> Option<CredentialKind> {
	match kind {
		AuthSpecKind::None => None,
		AuthSpecKind::ApiKey => Some(CredentialKind::ApiKey),
		AuthSpecKind::Basic => Some(CredentialKind::Basic),
		AuthSpecKind::Bearer
		| AuthSpecKind::OptionalBearer
		| AuthSpecKind::Oauth
		| AuthSpecKind::GcpAdc
		| AuthSpecKind::AzureAd
		| AuthSpecKind::GithubApp => Some(CredentialKind::Bearer),
		AuthSpecKind::AwsSigv4 => Some(CredentialKind::AwsSigV4),
		AuthSpecKind::OmpSession => Some(CredentialKind::SessionToken),
	}
}

#[cfg(test)]
mod tests {
	use std::{
		sync::atomic::{AtomicUsize, Ordering},
		time::SystemTime,
	};

	use bytes::Bytes;
	use http::Request;
	use omp_core::ExposeSecret as _;
	use parking_lot::Mutex;

	use super::{super::lease::AuthRejectionKind, *};
	use crate::{
		auth::AuthSpec,
		id::{AccountId, PrincipalId},
	};

	#[derive(Debug, Default)]
	struct EmptyEnvironment;

	impl CredentialEnvironment for EmptyEnvironment {
		fn read(&self, _: &str) -> Result<Option<SecretString>, CredentialError> {
			Ok(None)
		}
	}
	#[derive(Debug, Default)]
	struct TrackingEnvironment {
		reads: AtomicUsize,
	}

	impl CredentialEnvironment for TrackingEnvironment {
		fn read(&self, _: &str) -> Result<Option<SecretString>, CredentialError> {
			self.reads.fetch_add(1, Ordering::Relaxed);
			Ok(None)
		}
	}

	#[derive(Debug, Default)]
	struct TrackingStore {
		leases: AtomicUsize,
	}

	impl CredentialSource for TrackingStore {
		fn lease(
			&self,
			_: CredentialNeed,
		) -> CredentialFuture<'_, Result<CredentialLease, CredentialError>> {
			self.leases.fetch_add(1, Ordering::Relaxed);
			credential_ready(Err(CredentialError::Unavailable))
		}

		fn reject<'a>(
			&'a self,
			_: &'a CredentialLease,
			_: AuthRejection,
		) -> CredentialFuture<'a, Result<(), CredentialError>> {
			credential_ready(Ok(()))
		}
	}

	#[tokio::test]
	async fn invocation_key_is_provider_scoped_and_bypasses_external_sources() {
		let catalog = Catalog::embedded();
		let selected = catalog
			.providers()
			.iter()
			.find_map(|provider| {
				provider.auth.iter().find_map(|spec| {
					let kind = credential_kind(catalog.auth_spec(spec)?.kind)?;
					matches!(
						kind,
						CredentialKind::ApiKey | CredentialKind::Bearer | CredentialKind::SessionToken
					)
					.then(|| (provider, spec.clone()))
				})
			})
			.expect("provider with scalar authentication");
		let selected_kind = credential_kind(
			catalog
				.auth_spec(&selected.1)
				.expect("selected authentication spec")
				.kind,
		)
		.expect("selected scalar authentication kind");
		let other = catalog
			.auth_specs()
			.iter()
			.find(|spec| {
				spec.id != selected.1
					&& credential_kind(spec.kind).is_some()
					&& !selected.0.auth.contains(&spec.id)
			})
			.expect("authentication outside selected provider");
		let environment = Arc::new(TrackingEnvironment::default());
		let store = Arc::new(TrackingStore::default());
		let broker =
			CredentialBroker::from_catalog(catalog, environment.clone(), CredentialBrokerEngines {
				stored: Some(store.clone()),
				..CredentialBrokerEngines::default()
			})
			.expect("base broker")
			.with_api_key_override(catalog, &selected.0.id, SecretString::from("invocation-only-key"))
			.expect("provider override");
		let need = |spec| CredentialNeed {
			spec,
			account: Some(AccountId::from("selected-account")),
			principal: Some(PrincipalId::from("selected-principal")),
			valid_after: SystemTime::UNIX_EPOCH,
		};

		let lease = broker
			.lease(need(selected.1.clone()))
			.await
			.expect("invocation lease");
		assert_eq!(lease.scalar_secret().expect("scalar key").expose_secret(), "invocation-only-key");
		assert_eq!(lease.kind(), selected_kind);
		assert_eq!(lease.meta().account.as_str(), "selected-account");
		assert_eq!(lease.meta().principal.as_str(), "selected-principal");
		assert_eq!(
			broker
				.refresh_lease(&lease, need(selected.1.clone()))
				.await
				.expect_err("invocation credentials are nonrenewable"),
			CredentialError::Unavailable,
		);
		assert_eq!(
			broker
				.refresh_account(need(selected.1.clone()))
				.await
				.expect_err("account has no renewable stored credential"),
			CredentialError::Unavailable,
		);
		assert_eq!(environment.reads.load(Ordering::Relaxed), 0);
		assert_eq!(store.leases.load(Ordering::Relaxed), 0);

		assert_eq!(
			broker.lease(need(other.id.clone())).await.unwrap_err(),
			CredentialError::Unavailable
		);
		assert!(
			environment.reads.load(Ordering::Relaxed) > 0 || store.leases.load(Ordering::Relaxed) > 0
		);
	}

	#[tokio::test]
	async fn explicit_bedrock_key_remains_bearer_instead_of_resolving_to_sigv4() {
		let catalog = Catalog::embedded();
		let provider = catalog
			.provider(omp_catalog::ProviderId::from_ref("amazon-bedrock"))
			.expect("embedded Bedrock provider");
		let _route = provider
			.routes
			.iter()
			.filter_map(|id| catalog.route(id))
			.find(|route| route.codec.as_str() == "bedrock-converse")
			.expect("Bedrock Converse route");
		let bearer = provider
			.auth
			.iter()
			.find(|id| {
				catalog
					.auth_spec(id)
					.is_some_and(|auth| auth.kind == AuthSpecKind::Bearer)
			})
			.expect("Bedrock bearer alternative");
		let broker = CredentialBroker::from_catalog(
			catalog,
			Arc::new(EmptyEnvironment),
			CredentialBrokerEngines::default(),
		)
		.expect("base broker")
		.with_api_key_override(catalog, &provider.id, SecretString::from("explicit-bedrock-token"))
		.expect("Bedrock bearer override");

		let lease = broker
			.lease(CredentialNeed {
				spec:        bearer.clone(),
				account:     None,
				principal:   None,
				valid_after: SystemTime::UNIX_EPOCH,
			})
			.await
			.expect("explicit bearer lease");
		assert_eq!(lease.kind(), CredentialKind::Bearer);
		assert_eq!(
			lease.scalar_secret().expect("bearer token").expose_secret(),
			"explicit-bedrock-token",
		);

		let catalog_auth = catalog.auth_spec(bearer).expect("catalog bearer auth");
		let runtime_auth =
			AuthSpec::from_catalog(catalog_auth, None, None).expect("runtime bearer auth");
		let applied = lease
			.prepare(&runtime_auth, SystemTime::UNIX_EPOCH)
			.expect("AWS bearer alternative prepares");
		let mut request = Request::builder()
			.uri("https://bedrock-runtime.us-east-1.amazonaws.com/model/test/converse-stream")
			.body(Bytes::new())
			.expect("request");
		applied
			.finalize_buffered(&mut request)
			.expect("AWS bearer alternative applies");
		assert_eq!(request.headers()["authorization"], "Bearer explicit-bedrock-token");
	}

	#[test]
	fn embedded_catalog_compiles_one_exact_plan_per_authenticated_spec() {
		let catalog = Catalog::embedded();
		let broker = CredentialBroker::from_catalog(
			catalog,
			Arc::new(EmptyEnvironment),
			CredentialBrokerEngines::default(),
		)
		.expect("credential plans");
		let authenticated = catalog
			.auth_specs()
			.iter()
			.filter(|auth| credential_kind(auth.kind).is_some())
			.count();
		assert_eq!(broker.plans.len(), authenticated);
		for auth in catalog
			.auth_specs()
			.iter()
			.filter(|auth| credential_kind(auth.kind).is_some())
		{
			let plan = broker
				.plans
				.get(&auth.id)
				.expect("plan by exact auth identity");
			assert_eq!(plan.sources.len(), auth.credential_sources.len());
		}
	}

	#[derive(Debug)]
	struct OrderedEnvironment {
		calls: Mutex<Vec<Str>>,
	}

	impl CredentialEnvironment for OrderedEnvironment {
		fn read(&self, name: &str) -> Result<Option<SecretString>, CredentialError> {
			self.calls.lock().push(name.into());
			Ok((name == "ANTHROPIC_API_KEY").then(|| SecretString::from("secret".to_owned())))
		}
	}

	#[tokio::test]
	async fn environment_names_are_tried_in_declared_order() {
		let spec = AuthSpecId::new("ordered");
		let environment = Arc::new(OrderedEnvironment { calls: Mutex::new(Vec::new()) });
		let broker = CredentialBroker {
			plans:       Arc::new(BTreeMap::from([(spec.clone(), BrokerPlan {
				kind:    CredentialKind::ApiKey,
				sources: vec![BrokerSource::Environment(
					vec![sf!("OMP_ANTHROPIC_API_KEY"), sf!("ANTHROPIC_API_KEY")].into_boxed_slice(),
				)]
				.into_boxed_slice(),
			})])),
			environment: environment.clone(),
			engines:     CredentialBrokerEngines::default(),
			invocation:  None,
		};
		let lease = broker
			.lease(CredentialNeed {
				spec,
				account: Some(AccountId::from("account")),
				principal: Some(PrincipalId::from("principal")),
				valid_after: SystemTime::UNIX_EPOCH,
			})
			.await
			.expect("second source");
		assert_eq!(lease.kind(), CredentialKind::ApiKey);
		assert_eq!(*environment.calls.lock(), vec![
			sf!("OMP_ANTHROPIC_API_KEY"),
			sf!("ANTHROPIC_API_KEY")
		]);
		assert!(!format!("{broker:?} {lease:?}").contains("secret"));
	}

	/// Route execution with no durable account selects a brokered identity
	/// (`account: None`); a vendor environment name must still yield a lease.
	#[tokio::test]
	async fn brokered_need_without_account_leases_vendor_environment_name() {
		let spec = AuthSpecId::new("ordered");
		let environment = Arc::new(OrderedEnvironment { calls: Mutex::new(Vec::new()) });
		let broker = CredentialBroker {
			plans:       Arc::new(BTreeMap::from([(spec.clone(), BrokerPlan {
				kind:    CredentialKind::ApiKey,
				sources: vec![BrokerSource::Environment(
					vec![sf!("OMP_ANTHROPIC_API_KEY"), sf!("ANTHROPIC_API_KEY")].into_boxed_slice(),
				)]
				.into_boxed_slice(),
			})])),
			environment: environment.clone(),
			engines:     CredentialBrokerEngines::default(),
			invocation:  None,
		};
		let lease = broker
			.lease(CredentialNeed {
				spec,
				account: None,
				principal: None,
				valid_after: SystemTime::UNIX_EPOCH,
			})
			.await
			.expect("brokered environment lease");
		assert_eq!(lease.kind(), CredentialKind::ApiKey);
		assert_eq!(lease.scalar_secret().expect("scalar key").expose_secret(), "secret");
		assert_eq!(lease.source_tag(), Some(ENVIRONMENT_TAG));
		assert_eq!(lease.meta().account.as_str(), ENVIRONMENT_TAG);
		assert_eq!(lease.meta().principal.as_str(), "ANTHROPIC_API_KEY");
		assert_eq!(*environment.calls.lock(), vec![
			sf!("OMP_ANTHROPIC_API_KEY"),
			sf!("ANTHROPIC_API_KEY")
		]);
	}

	/// Environment, invocation, and encrypted-store sources answer without
	/// touching the heap: the broker resolves the plan walk inline and only a
	/// source that performs I/O boxes.
	#[test]
	fn synchronous_sources_lease_and_reject_without_boxing() {
		let spec = AuthSpecId::new("ordered");
		let stored: Arc<dyn CredentialSource> = Arc::new(TrackingStore::default());
		let broker = CredentialBroker {
			plans:       Arc::new(BTreeMap::from([(spec.clone(), BrokerPlan {
				kind:    CredentialKind::ApiKey,
				sources: vec![
					BrokerSource::Engine(EngineKind::Stored),
					BrokerSource::Environment(vec![sf!("ANTHROPIC_API_KEY")].into_boxed_slice()),
				]
				.into_boxed_slice(),
			})])),
			environment: Arc::new(OrderedEnvironment { calls: Mutex::new(Vec::new()) }),
			engines:     CredentialBrokerEngines { stored: Some(stored), ..Default::default() },
			invocation:  None,
		};
		let need = CredentialNeed {
			spec,
			account: None,
			principal: None,
			valid_after: SystemTime::UNIX_EPOCH,
		};
		let Either::Left(ready) = broker.lease(need.clone()) else {
			panic!("stored miss followed by environment hit must resolve inline");
		};
		let lease = ready.into_inner().expect("environment lease");
		assert_eq!(lease.source_tag(), Some(ENVIRONMENT_TAG));
		let Either::Left(rejected) = broker.reject(&lease, AuthRejection {
			kind:        AuthRejectionKind::Unauthorized,
			status:      Some(403),
			code:        None,
			refreshable: false,
		}) else {
			panic!("environment rejection is synchronous");
		};
		assert_eq!(rejected.into_inner(), Ok(()));
		let Either::Left(unknown) =
			broker.lease(CredentialNeed { spec: AuthSpecId::new("missing"), ..need })
		else {
			panic!("unknown spec is rejected inline");
		};
		assert_eq!(unknown.into_inner().map(|_| ()), Err(CredentialError::InvalidSource));
	}
}
