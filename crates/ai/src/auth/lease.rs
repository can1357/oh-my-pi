//! Opaque credential leases and innermost request mutation.

use std::{fmt, io::Write as _, sync::Arc, time::SystemTime};

use bytes::Bytes;
use futures::future::{BoxFuture, Either, Ready, ready};
use http::{Extensions, HeaderMap, HeaderName, HeaderValue, Request, Uri};
use omp_catalog::AuthSpecId;
use omp_core::{ExposeSecret, SecretString, Str, encoding::base64};
use zeroize::Zeroizing;

use super::{
	shape::ShapedCredential,
	sigv4::{AwsCredential, SigV4Error, sign_request},
	spec::{
		AuthSpec, BearerScheme, BodyPlacement, HeaderPlacement, KeyPlacement, QueryPlacement,
		SessionTokenSpec as SpecSessionTokenSpec, SigV4Spec,
	},
};
use crate::{
	codec::{Cancellation, SealedBodyTemplate},
	id::{AccountId, PrincipalId},
};

/// Non-secret identity and freshness metadata attached to a credential lease.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LeaseMeta {
	/// Opaque account identity.
	pub account:    AccountId,
	/// Authenticated principal used for session affinity.
	pub principal:  PrincipalId,
	/// Monotonic credential generation checked at redemption.
	pub generation: u64,
	/// Optional absolute expiration time.
	pub expires_at: Option<SystemTime>,
}

/// Non-secret category of credential material held by a lease.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CredentialKind {
	/// Provider API key.
	ApiKey,
	/// RFC 7617 username and password pair.
	Basic,
	/// OAuth or application-default bearer token.
	Bearer,
	/// Provider session token.
	SessionToken,
	/// AWS access-key tuple used only by `SigV4`.
	AwsSigV4,
}

#[derive(Clone)]
enum LeaseMaterial {
	ApiKey(SecretString),
	Basic { username: SecretString, password: SecretString },
	Bearer(SecretString),
	SessionToken(SecretString),
	Aws(AwsCredential),
}

impl LeaseMaterial {
	const fn kind(&self) -> CredentialKind {
		match self {
			Self::ApiKey(_) => CredentialKind::ApiKey,
			Self::Basic { .. } => CredentialKind::Basic,
			Self::Bearer(_) => CredentialKind::Bearer,
			Self::SessionToken(_) => CredentialKind::SessionToken,
			Self::Aws(_) => CredentialKind::AwsSigV4,
		}
	}

	const fn scalar(&self) -> Result<&SecretString, CredentialApplyError> {
		match self {
			Self::ApiKey(value) | Self::Bearer(value) | Self::SessionToken(value) => Ok(value),
			Self::Basic { .. } => Err(CredentialApplyError::WrongKind {
				expected: CredentialKind::ApiKey,
				actual:   CredentialKind::Basic,
			}),
			Self::Aws(_) => Err(CredentialApplyError::WrongKind {
				expected: CredentialKind::Bearer,
				actual:   CredentialKind::AwsSigV4,
			}),
		}
	}
}

impl fmt::Debug for LeaseMaterial {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter.write_str("LeaseMaterial([REDACTED])")
	}
}

struct LeaseInner {
	meta:     LeaseMeta,
	material: LeaseMaterial,
}

impl fmt::Debug for LeaseInner {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("LeaseInner")
			.field("meta", &self.meta)
			.field("kind", &self.material.kind())
			.field("material", &"[REDACTED]")
			.finish()
	}
}

/// Opaque claim on one generation of secret credential material.
///
/// The lease has no public secret accessor and no serialization implementation.
/// Its only public secret-bearing operations mutate a sensitive header/query
/// sink or sign a finalized request.
#[derive(Clone)]
pub struct CredentialLease {
	inner:             Arc<LeaseInner>,
	source_tag:        Option<Str>,
	endpoint_override: Option<Str>,
}

impl CredentialLease {
	/// Constructs an API-key lease at a one-way secret ingress boundary.
	pub fn api_key(meta: LeaseMeta, secret: SecretString) -> Self {
		Self {
			inner:             Arc::new(LeaseInner { meta, material: LeaseMaterial::ApiKey(secret) }),
			source_tag:        None,
			endpoint_override: None,
		}
	}

	/// Constructs an RFC 7617 lease from independently acquired secrets.
	pub fn basic(meta: LeaseMeta, username: SecretString, password: SecretString) -> Self {
		Self {
			inner:             Arc::new(LeaseInner {
				meta,
				material: LeaseMaterial::Basic { username, password },
			}),
			source_tag:        None,
			endpoint_override: None,
		}
	}

	/// Constructs an OAuth or application-default bearer lease.
	pub fn bearer(meta: LeaseMeta, secret: SecretString) -> Self {
		Self {
			inner:             Arc::new(LeaseInner { meta, material: LeaseMaterial::Bearer(secret) }),
			source_tag:        None,
			endpoint_override: None,
		}
	}

	/// Constructs a provider session-token lease.
	pub fn session_token(meta: LeaseMeta, secret: SecretString) -> Self {
		Self {
			inner:             Arc::new(LeaseInner {
				meta,
				material: LeaseMaterial::SessionToken(secret),
			}),
			source_tag:        None,
			endpoint_override: None,
		}
	}

	/// Constructs an AWS signing lease at a one-way secret ingress boundary.
	pub fn aws_sigv4(
		meta: LeaseMeta,
		access_key_id: SecretString,
		secret_access_key: SecretString,
		session_token: Option<SecretString>,
	) -> Self {
		Self {
			inner:             Arc::new(LeaseInner {
				meta,
				material: LeaseMaterial::Aws(AwsCredential::new(
					access_key_id,
					secret_access_key,
					session_token,
				)),
			}),
			source_tag:        None,
			endpoint_override: None,
		}
	}

	/// Returns non-secret account metadata.
	pub fn meta(&self) -> &LeaseMeta {
		&self.inner.meta
	}

	/// Returns the credential category without revealing material.
	pub fn kind(&self) -> CredentialKind {
		self.inner.material.kind()
	}

	/// Returns whether this generation is already expired at `now`.
	pub fn is_expired_at(&self, now: SystemTime) -> bool {
		self
			.inner
			.meta
			.expires_at
			.is_some_and(|expires_at| expires_at <= now)
	}

	pub(crate) fn with_source_tag(mut self, source_tag: Str) -> Self {
		self.source_tag = Some(source_tag);
		self
	}

	pub(crate) fn source_tag(&self) -> Option<&str> {
		self.source_tag.as_deref()
	}

	pub(crate) fn scalar_secret(&self) -> Option<&SecretString> {
		self.inner.material.scalar().ok()
	}

	pub(crate) fn with_shape(self, shaped: ShapedCredential) -> Self {
		let kind = self.kind();
		let Self { inner, source_tag, .. } = self;
		let inner = match shaped.secret {
			None => inner,
			Some(secret) => {
				let material = match kind {
					CredentialKind::ApiKey => LeaseMaterial::ApiKey(secret),
					CredentialKind::Basic => {
						return Self { inner, source_tag, endpoint_override: None };
					},
					CredentialKind::Bearer => LeaseMaterial::Bearer(secret),
					CredentialKind::SessionToken => LeaseMaterial::SessionToken(secret),
					CredentialKind::AwsSigV4 => {
						return Self { inner, source_tag, endpoint_override: None };
					},
				};
				Arc::new(LeaseInner { meta: inner.meta.clone(), material })
			},
		};
		Self { inner, source_tag, endpoint_override: shaped.endpoint_override }
	}

	pub(crate) const fn endpoint_override(&self) -> Option<&Str> {
		self.endpoint_override.as_ref()
	}

	/// Prepares an opaque credential application for the innermost transport.
	///
	/// The returned value retains the lease rather than copying secret headers.
	/// A wire transport calls [`AppliedCredentials::finalize_streaming`] or
	/// [`AppliedCredentials::finalize_buffered`] only after method, URI, public
	/// headers, and body representation are final.
	pub fn prepare(
		&self,
		spec: &AuthSpec,
		signed_at: SystemTime,
	) -> Result<AppliedCredentials, CredentialApplyError> {
		let scheme = AuthScheme::for_spec(spec);
		let expected = match spec {
			AuthSpec::None => None,
			AuthSpec::ApiKey { .. } => Some(CredentialKind::ApiKey),
			AuthSpec::Basic { .. } => Some(CredentialKind::Basic),
			AuthSpec::Bearer { .. }
			| AuthSpec::OAuthPkce(_)
			| AuthSpec::OAuthDevice(_)
			| AuthSpec::OAuthPaste(_)
			| AuthSpec::OAuthCustom(_)
			| AuthSpec::ApplicationDefault(_) => Some(CredentialKind::Bearer),
			AuthSpec::AwsSigV4(_) => Some(CredentialKind::AwsSigV4),
			AuthSpec::SessionToken(_) => Some(CredentialKind::SessionToken),
		};
		if let Some(expected) = expected
			&& self.kind() != expected
		{
			return Err(CredentialApplyError::WrongKind { expected, actual: self.kind() });
		}
		Ok(AppliedCredentials { lease: self.clone(), spec: spec.clone(), signed_at, scheme })
	}

	/// Applies scalar material to a sensitive header value.
	pub fn apply_header(
		&self,
		placement: &HeaderPlacement,
		headers: &mut HeaderMap,
	) -> Result<(), CredentialApplyError> {
		let secret = self.inner.material.scalar()?;
		let name = HeaderName::from_bytes(placement.name.as_bytes())
			.map_err(|_| CredentialApplyError::InvalidHeader)?;
		let mut joined =
			Zeroizing::new(Vec::with_capacity(placement.prefix.len() + secret.expose_secret().len()));
		joined.extend_from_slice(placement.prefix.as_bytes());
		joined.extend_from_slice(secret.expose_secret().as_bytes());
		let mut value =
			HeaderValue::from_bytes(&joined).map_err(|_| CredentialApplyError::InvalidHeader)?;
		value.set_sensitive(true);
		headers.insert(name, value);
		Ok(())
	}

	fn apply_basic(
		&self,
		placement: &HeaderPlacement,
		headers: &mut HeaderMap,
	) -> Result<(), CredentialApplyError> {
		let LeaseMaterial::Basic { username, password } = &self.inner.material else {
			return Err(CredentialApplyError::WrongKind {
				expected: CredentialKind::Basic,
				actual:   self.kind(),
			});
		};
		if username.expose_secret().contains(':') {
			return Err(CredentialApplyError::InvalidBasicUsername);
		}
		let mut plain = Zeroizing::new(Vec::with_capacity(
			username.expose_secret().len() + password.expose_secret().len() + 1,
		));
		plain.extend_from_slice(username.expose_secret().as_bytes());
		plain.push(b':');
		plain.extend_from_slice(password.expose_secret().as_bytes());
		let encoded_len = plain.len().div_ceil(3) * 4;
		let mut joined = Zeroizing::new(Vec::with_capacity(placement.prefix.len() + encoded_len));
		joined.extend_from_slice(placement.prefix.as_bytes());
		{
			let mut writer = base64::encode_writer(&mut *joined);
			writer
				.write_all(&plain)
				.map_err(|_| CredentialApplyError::InvalidHeader)?;
			writer
				.into_inner()
				.map_err(|_| CredentialApplyError::InvalidHeader)?;
		}
		let name = HeaderName::from_bytes(placement.name.as_bytes())
			.map_err(|_| CredentialApplyError::InvalidHeader)?;
		let mut value =
			HeaderValue::from_bytes(&joined).map_err(|_| CredentialApplyError::InvalidHeader)?;
		value.set_sensitive(true);
		headers.insert(name, value);
		Ok(())
	}

	/// Defers scalar material as a redacted query parameter in request
	/// extensions.
	pub fn apply_query(
		&self,
		placement: &QueryPlacement,
		extensions: &mut Extensions,
	) -> Result<(), CredentialApplyError> {
		let secret = self.inner.material.scalar()?;
		extensions.insert(SensitiveQuery::new(placement.name.clone(), secret.clone()));
		Ok(())
	}

	/// Signs a finalized buffered request with AWS Signature Version 4.
	pub fn sign(
		&self,
		spec: &SigV4Spec,
		signed_at: SystemTime,
		request: &mut Request<Bytes>,
	) -> Result<(), CredentialApplyError> {
		let LeaseMaterial::Aws(credential) = &self.inner.material else {
			return Err(CredentialApplyError::WrongKind {
				expected: CredentialKind::AwsSigV4,
				actual:   self.kind(),
			});
		};
		sign_request(credential, spec, signed_at, request).map_err(CredentialApplyError::Signing)
	}

	/// Applies the catalog specification to an exact finalized request.
	pub fn apply(
		&self,
		spec: &AuthSpec,
		signed_at: SystemTime,
		request: &mut Request<Bytes>,
	) -> Result<(), CredentialApplyError> {
		match spec {
			AuthSpec::AwsSigV4(value) => self.sign(value, signed_at, request),
			_ => self.apply_streaming(spec, request),
		}
	}

	/// Applies scalar header/query authentication to a finalized streaming
	/// request.
	///
	/// `SigV4` is rejected because its canonical request requires exact body
	/// bytes.
	pub fn apply_streaming<B>(
		&self,
		spec: &AuthSpec,
		request: &mut Request<B>,
	) -> Result<(), CredentialApplyError> {
		match spec {
			AuthSpec::None => Ok(()),
			AuthSpec::ApiKey { placement, .. }
			| AuthSpec::Bearer { placement, .. }
			| AuthSpec::SessionToken(SpecSessionTokenSpec { placement, .. }) => {
				self.apply_key_placement(placement, request)
			},
			AuthSpec::Basic { placement, .. } => self.apply_basic(placement, request.headers_mut()),
			AuthSpec::OAuthPkce(value) => self.apply_key_placement(&value.client.placement, request),
			AuthSpec::OAuthDevice(value) => self.apply_key_placement(&value.client.placement, request),
			AuthSpec::OAuthPaste(value) => self.apply_key_placement(&value.client.placement, request),
			AuthSpec::OAuthCustom(value) => self.apply_key_placement(&value.client.placement, request),
			AuthSpec::ApplicationDefault(value) => self.apply_key_placement(&value.placement, request),
			AuthSpec::AwsSigV4(_) => Err(CredentialApplyError::RequiresBufferedBody),
		}
	}

	fn apply_key_placement<B>(
		&self,
		placement: &KeyPlacement,
		request: &mut Request<B>,
	) -> Result<(), CredentialApplyError> {
		match placement {
			KeyPlacement::Header(value) => self.apply_header(value, request.headers_mut()),
			KeyPlacement::Query(value) => {
				self.apply_query(value, request.extensions_mut())?;
				SensitiveQuery::materialize(request)
			},
			KeyPlacement::Body(_) => Err(CredentialApplyError::RequiresSealedBody),
		}
	}
}

impl fmt::Debug for CredentialLease {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("CredentialLease")
			.field("account", &self.inner.meta.account)
			.field("principal", &self.inner.meta.principal)
			.field("generation", &self.inner.meta.generation)
			.field("expires_at", &self.inner.meta.expires_at)
			.field("kind", &self.kind())
			.field("material", &"[REDACTED]")
			.field("endpoint_override", &self.endpoint_override)
			.finish()
	}
}

/// Sanitized authentication scheme evidence safe for traces and receipts.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AuthScheme {
	/// No credential mutation.
	None,
	/// API key header or deferred query placement.
	ApiKey,
	/// RFC 7617 basic authentication.
	Basic,
	/// OAuth access token.
	OAuth,
	/// Application-default access token.
	ApplicationDefault,
	/// AWS Signature Version 4.
	AwsSigV4,
	/// Provider session token.
	SessionToken,
}

impl AuthScheme {
	pub(crate) const fn for_spec(spec: &AuthSpec) -> Self {
		match spec {
			AuthSpec::None => Self::None,
			AuthSpec::ApiKey { .. } => Self::ApiKey,
			AuthSpec::Basic { .. } => Self::Basic,
			AuthSpec::Bearer { scheme: BearerScheme::OAuth, .. }
			| AuthSpec::OAuthPkce(_)
			| AuthSpec::OAuthDevice(_)
			| AuthSpec::OAuthPaste(_)
			| AuthSpec::OAuthCustom(_) => Self::OAuth,
			AuthSpec::Bearer { scheme: BearerScheme::ApplicationDefault, .. }
			| AuthSpec::ApplicationDefault(_) => Self::ApplicationDefault,
			AuthSpec::AwsSigV4(_) => Self::AwsSigV4,
			AuthSpec::SessionToken(_) => Self::SessionToken,
		}
	}
}

/// Opaque credentials carried separately from a secret-free encoded request.
///
/// This value has no secret-bearing fields or mutation primitives exposed to
/// codecs, policy, cassettes, or receipts. The wire transport may only finalize
/// it into an exact buffered HTTP request at the last dispatch boundary.
#[derive(Clone)]
pub struct AppliedCredentials {
	lease:     CredentialLease,
	spec:      AuthSpec,
	signed_at: SystemTime,
	scheme:    AuthScheme,
}

impl AppliedCredentials {
	/// Returns sanitized scheme evidence.
	pub const fn scheme(&self) -> AuthScheme {
		self.scheme
	}

	/// Returns when a time-sensitive signature will be produced.
	pub const fn signed_at(&self) -> SystemTime {
		self.signed_at
	}

	/// Returns whether finalization requires exact buffered request bytes.
	pub const fn requires_buffered_body(&self) -> bool {
		matches!(self.scheme, AuthScheme::AwsSigV4)
	}

	/// Returns whether this credential may only be placed through a sealed body.
	pub const fn requires_sealed_body(&self) -> bool {
		matches!(
			&self.spec,
			AuthSpec::SessionToken(super::spec::SessionTokenSpec {
				placement: KeyPlacement::Body(_),
				..
			})
		)
	}

	/// Applies credentials to the exact final buffered request.
	///
	/// `SigV4` hashes and signs these body bytes. Scalar schemes use the same
	/// header/query path as streaming transport without exposing their values.
	pub fn finalize_buffered(
		&self,
		request: &mut Request<Bytes>,
	) -> Result<(), CredentialApplyError> {
		self.lease.apply(&self.spec, self.signed_at, request)
	}

	/// Applies scalar credentials to a final request with a streaming body.
	///
	/// `SigV4` returns [`CredentialApplyError::RequiresBufferedBody`] before any
	/// request mutation.
	pub fn finalize_streaming<B>(
		&self,
		request: &mut Request<B>,
	) -> Result<(), CredentialApplyError> {
		self.lease.apply_streaming(&self.spec, request)
	}

	/// Consumes and binds a sealed typed body before any body reader is opened.
	pub(crate) fn finalize_sealed_body(
		&self,
		template: SealedBodyTemplate,
		cancel: &Cancellation,
		limit: u64,
	) -> Result<Bytes, CredentialApplyError> {
		if cancel.is_cancelled() {
			return Err(CredentialApplyError::Cancelled);
		}
		let placement = match &self.spec {
			AuthSpec::SessionToken(SpecSessionTokenSpec {
				placement: KeyPlacement::Body(placement),
				..
			}) => *placement,
			_ => return Err(CredentialApplyError::RequiresSealedBody),
		};
		if template.placement() != placement {
			return Err(CredentialApplyError::WrongBodyPlacement {
				expected: placement,
				actual:   template.placement(),
			});
		}
		let secret = self.lease.inner.material.scalar()?;
		let bytes = template.bind(secret.expose_secret())?;
		if bytes.len() as u64 > limit {
			return Err(CredentialApplyError::BodyTooLarge { limit });
		}
		if cancel.is_cancelled() {
			return Err(CredentialApplyError::Cancelled);
		}
		Ok(bytes)
	}

	/// Returns the non-secret account identity for admission evidence.
	pub fn account(&self) -> &AccountId<str> {
		&self.lease.meta().account
	}

	/// Returns the non-secret principal identity for session affinity.
	pub fn principal(&self) -> &PrincipalId<str> {
		&self.lease.meta().principal
	}
}

impl fmt::Debug for AppliedCredentials {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("AppliedCredentials")
			.field("scheme", &self.scheme)
			.field("account", &self.account())
			.field("principal", &self.principal())
			.field("signed_at", &self.signed_at)
			.field("material", &"[REDACTED]")
			.finish()
	}
}

/// Opaque query credential deferred until final wire serialization.
#[derive(Clone)]
struct SensitiveQuery {
	name:  Str,
	value: SecretString,
}

impl SensitiveQuery {
	const fn new(name: Str, value: SecretString) -> Self {
		Self { name, value }
	}

	/// Moves a pending query credential into the final URI immediately before
	/// dispatch.
	pub(crate) fn materialize<B>(request: &mut Request<B>) -> Result<(), CredentialApplyError> {
		let Some(query) = request.extensions_mut().remove::<Self>() else {
			return Ok(());
		};
		let uri = append_query(request.uri(), &query.name, query.value.expose_secret())?;
		*request.uri_mut() = uri;
		Ok(())
	}
}

impl fmt::Debug for SensitiveQuery {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("SensitiveQuery")
			.field("name", &self.name)
			.field("value", &"[REDACTED]")
			.finish()
	}
}

fn append_query(uri: &Uri, name: &str, value: &str) -> Result<Uri, CredentialApplyError> {
	let mut encoded =
		Zeroizing::new(String::with_capacity(uri.to_string().len() + name.len() + value.len() + 2));
	encoded.push_str(&uri.to_string());
	encoded.push(if uri.query().is_some() { '&' } else { '?' });
	percent_encode(name.as_bytes(), &mut encoded);
	encoded.push('=');
	percent_encode(value.as_bytes(), &mut encoded);
	encoded
		.parse()
		.map_err(|_| CredentialApplyError::InvalidQuery)
}

fn percent_encode(bytes: &[u8], output: &mut String) {
	const HEX: &[u8; 16] = b"0123456789ABCDEF";
	for &byte in bytes {
		if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
			output.push(char::from(byte));
		} else {
			output.push('%');
			output.push(char::from(HEX[usize::from(byte >> 4)]));
			output.push(char::from(HEX[usize::from(byte & 0x0f)]));
		}
	}
}

/// Typed evidence explaining why a credential generation was rejected.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuthRejection {
	/// Rejection classification.
	pub kind:        AuthRejectionKind,
	/// HTTP-like status, when available.
	pub status:      Option<u16>,
	/// Sanitized protocol code from a closed parser vocabulary.
	pub code:        Option<Str>,
	/// Whether the same principal may be refreshed.
	pub refreshable: bool,
}

/// Credential rejection classification used by account and retry policy.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AuthRejectionKind {
	/// Credential is expired but may be refreshable.
	Expired,
	/// Credential is invalid or revoked.
	Invalid,
	/// Account is disabled.
	Disabled,
	/// Principal is authenticated but not authorized for the operation.
	Unauthorized,
	/// Refresh grant itself was rejected.
	RefreshRejected,
}

/// Non-secret requirements passed to a credential source.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CredentialNeed {
	/// Catalog authentication specification identity.
	pub spec:        AuthSpecId,
	/// Optional account affinity selected by account policy.
	pub account:     Option<AccountId>,
	/// Optional principal affinity selected by session policy.
	pub principal:   Option<PrincipalId>,
	/// Earliest acceptable expiry to avoid leasing nearly-expired credentials.
	pub valid_after: SystemTime,
}

/// Failure to acquire or reject a credential without retaining source text.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum CredentialError {
	/// No credential source produced a usable generation.
	#[error("no usable credential is available")]
	Unavailable,
	/// Selected generation changed before redemption.
	#[error("credential lease generation is stale")]
	StaleGeneration,
	/// Credential is expired.
	#[error("credential lease is expired")]
	Expired,
	/// Credential source rejected its non-secret specification.
	#[error("credential source specification is invalid")]
	InvalidSource,
	/// Credential acquisition was cancelled.
	#[error("credential acquisition was cancelled")]
	Cancelled,
	/// Credential source failed without retaining secret-bearing detail.
	#[error("credential source failed")]
	SourceFailure,
}

/// Future returned across the `dyn CredentialSource` boundary.
///
/// Sources that answer synchronously (environment variables, invocation
/// overrides, the encrypted store) ride `Ready` without allocating; only a
/// source that performs real I/O (OAuth refresh, ADC, AWS chain, provider
/// sessions) boxes one cold future per acquisition.
pub type CredentialFuture<'a, T> = Either<Ready<T>, BoxFuture<'a, T>>;

/// Wraps an already-known answer in a [`CredentialFuture`] without allocating.
#[inline]
pub fn credential_ready<'a, T: Send + 'a>(value: T) -> CredentialFuture<'a, T> {
	Either::Left(ready(value))
}

/// Secret-isolating credential acquisition and rejection boundary.
pub trait CredentialSource: Send + Sync {
	/// Acquires one opaque credential generation.
	fn lease(
		&self,
		need: CredentialNeed,
	) -> CredentialFuture<'_, Result<CredentialLease, CredentialError>>;

	/// Explicitly refreshes a renewable credential, then leases the resulting
	/// generation once.
	///
	/// Nonrenewable sources fail closed rather than reacquiring unchanged
	/// material.
	fn refresh_lease(
		&self,
		_need: CredentialNeed,
	) -> CredentialFuture<'_, Result<CredentialLease, CredentialError>> {
		credential_ready(Err(CredentialError::Unavailable))
	}

	/// Rejects a generation using structured, secret-free provider evidence.
	fn reject<'a>(
		&'a self,
		lease: &'a CredentialLease,
		evidence: AuthRejection,
	) -> CredentialFuture<'a, Result<(), CredentialError>>;
}

/// Failure to apply a lease to a finalized request.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum CredentialApplyError {
	/// Credential kind cannot satisfy the requested operation.
	#[error("credential kind does not match authentication operation")]
	WrongKind {
		/// Required credential kind.
		expected: CredentialKind,
		/// Credential kind supplied by the lease.
		actual:   CredentialKind,
	},
	/// Catalog header name, prefix, or secret bytes are not valid HTTP.
	#[error("credential could not be represented as a sensitive header")]
	InvalidHeader,
	/// RFC 7617 usernames may not contain the user/password delimiter.
	#[error("basic-auth username contains a colon")]
	InvalidBasicUsername,
	/// Query placement could not produce a valid final URI.
	#[error("credential could not be represented as a sensitive query")]
	InvalidQuery,
	/// Exact final-request signing failed.
	#[error(transparent)]
	Signing(SigV4Error),
	/// A streaming body cannot be signed without explicit replayable staging.
	#[error("SigV4 requires an exact buffered or explicitly staged request body")]
	RequiresBufferedBody,
	/// A sealed codec template could not decode or encode its typed body.
	#[error("sealed body template is invalid")]
	InvalidSealedBody,
	/// A body placement must be finalized through a sealed codec template.
	#[error("credential requires sealed typed-body finalization")]
	RequiresSealedBody,
	/// The catalog body placement and codec template do not agree.
	#[error("sealed body placement does not match the codec template")]
	WrongBodyPlacement {
		/// Required placement declared by the catalog.
		expected: BodyPlacement,
		/// Placement supplied by the sealed codec template.
		actual:   BodyPlacement,
	},
	/// Sealed body construction exceeded the route's request bound.
	#[error("sealed body exceeded its request byte bound")]
	BodyTooLarge {
		/// Maximum number of request bytes accepted by the route.
		limit: u64,
	},
	/// Cancellation won before sealed bytes were exposed to a body reader.
	#[error("sealed body credential binding was cancelled")]
	Cancelled,
}

/// Creates deterministic non-secret metadata for ephemeral credentials.
pub const fn ephemeral_meta(
	account: AccountId,
	principal: PrincipalId,
	expires_at: Option<SystemTime>,
) -> LeaseMeta {
	LeaseMeta { account, principal, generation: 0, expires_at }
}

#[cfg(test)]
mod tests {
	use std::time::UNIX_EPOCH;

	use omp_core::sf;

	use super::*;
	use crate::{
		auth::{
			ShapedCredential as AuthShapedCredential,
			spec::{BodyPlacement, CredentialSourceSpec, SessionTokenSpec},
		},
		codec::{SealedBodyTemplate, devin::DevinSealedBody},
	};

	fn meta() -> LeaseMeta {
		LeaseMeta {
			account:    AccountId::from("account"),
			principal:  PrincipalId::from("principal"),
			generation: 7,
			expires_at: None,
		}
	}

	#[test]
	fn endpoint_only_shape_reuses_secret_lease_allocation() {
		let lease =
			CredentialLease::bearer(meta(), SecretString::from("unchanged-secret".to_owned()));
		let original = Arc::clone(&lease.inner);
		let shaped = lease.with_shape(AuthShapedCredential {
			secret:            None,
			endpoint_override: Some(sf!("https://override.example")),
		});
		assert!(Arc::ptr_eq(&original, &shaped.inner));
		assert_eq!(shaped.endpoint_override().map(Str::as_str), Some("https://override.example"),);
	}

	#[test]
	fn debug_and_pending_query_never_format_plaintext_material() {
		let material = "a b&c=secret";
		let lease = CredentialLease::api_key(meta(), SecretString::from(material.to_owned()));
		let mut request = Request::builder()
			.uri("https://example.test/path?public=1")
			.body(Bytes::new())
			.expect("request");
		lease
			.apply_query(&QueryPlacement { name: "key".into() }, request.extensions_mut())
			.expect("query");
		let debug = format!("{lease:?} {:?}", request.extensions().get::<SensitiveQuery>());
		assert!(!debug.contains(material));
		assert_eq!(request.uri(), "https://example.test/path?public=1");
		SensitiveQuery::materialize(&mut request).expect("materialize");
		assert_eq!(request.uri(), "https://example.test/path?public=1&key=a%20b%26c%3Dsecret");
	}

	#[test]
	fn sensitive_headers_are_marked_and_lease_does_not_format_material() {
		let material = "super-secret-token";
		let lease = CredentialLease::bearer(meta(), SecretString::from(material.to_owned()));
		let mut headers = HeaderMap::new();
		lease
			.apply_header(&HeaderPlacement::bearer(), &mut headers)
			.expect("header");
		assert!(headers["authorization"].is_sensitive());
		assert_eq!(headers["authorization"], "Bearer super-secret-token");
		assert!(!format!("{headers:?} {lease:?}").contains(material));
	}

	fn sealed_spec() -> AuthSpec {
		AuthSpec::SessionToken(SessionTokenSpec {
			sources:   vec![CredentialSourceSpec::Interactive],
			placement: KeyPlacement::Body(BodyPlacement::DevinMetadata),
		})
	}

	#[test]
	fn sealed_binding_uses_the_current_lease_generation() {
		let template = || {
			SealedBodyTemplate::Devin(DevinSealedBody::Discovery(Bytes::from_static(&[0x0a, 0x00])))
		};
		let first = CredentialLease::session_token(
			LeaseMeta { generation: 7, ..meta() },
			SecretString::from("first-generation".to_owned()),
		)
		.prepare(&sealed_spec(), UNIX_EPOCH)
		.expect("first credentials");
		let second = CredentialLease::session_token(
			LeaseMeta { generation: 8, ..meta() },
			SecretString::from("second-generation".to_owned()),
		)
		.prepare(&sealed_spec(), UNIX_EPOCH)
		.expect("second credentials");
		let cancel = Cancellation::default();
		let first_bytes = first
			.finalize_sealed_body(template(), &cancel, 4096)
			.expect("first body");
		let second_bytes = second
			.finalize_sealed_body(template(), &cancel, 4096)
			.expect("second body");
		assert_ne!(first_bytes, second_bytes);
		let debug = format!("{first:?} {second:?}");
		assert!(!debug.contains("first-generation"));
		assert!(!debug.contains("second-generation"));
	}

	#[test]
	fn cancellation_prevents_sealed_binding() {
		let credentials =
			CredentialLease::session_token(meta(), SecretString::from("cancelled-secret".to_owned()))
				.prepare(&sealed_spec(), UNIX_EPOCH)
				.expect("credentials");
		let cancel = Cancellation::default();
		cancel.cancel();
		let result = credentials.finalize_sealed_body(
			SealedBodyTemplate::Devin(DevinSealedBody::Discovery(Bytes::from_static(&[0x0a, 0x00]))),
			&cancel,
			4096,
		);
		assert_eq!(result, Err(CredentialApplyError::Cancelled));
		assert!(!format!("{result:?}").contains("cancelled-secret"));
	}

	#[test]
	fn body_placement_rejects_generic_finalization() {
		let credentials =
			CredentialLease::session_token(meta(), SecretString::from("secret".to_owned()))
				.prepare(&sealed_spec(), UNIX_EPOCH)
				.expect("credentials");
		let mut request = Request::new(Bytes::new());
		assert_eq!(
			credentials.finalize_streaming(&mut request),
			Err(CredentialApplyError::RequiresSealedBody)
		);
	}

	#[test]
	fn sealed_body_rejects_the_wrong_credential_kind() {
		let error =
			CredentialLease::api_key(meta(), SecretString::from("wrong-kind-secret".to_owned()))
				.prepare(&sealed_spec(), UNIX_EPOCH)
				.expect_err("API key cannot satisfy a session-token body");
		assert_eq!(error, CredentialApplyError::WrongKind {
			expected: CredentialKind::SessionToken,
			actual:   CredentialKind::ApiKey,
		});
		assert!(!format!("{error:?}").contains("wrong-kind-secret"));
	}
}
