//! SQLite credential metadata and encrypted-secret persistence.

use std::{
	fmt,
	fs::OpenOptions,
	future::Future,
	io,
	path::{Path, PathBuf},
	pin::Pin,
	sync::Arc,
	time::{Duration, SystemTime, UNIX_EPOCH},
};

use omp_core::{ExposeSecret, Secret, SecretBox, SecretString, Str, sf};
use ring::hmac;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::{
	crypto::{CryptoError, EncryptedBlob, SecretContext, decrypt, encrypt},
	key::{EncryptionKey, KeyError, KeyId, KeySource},
	lease::{
		AuthRejection, CredentialError, CredentialFuture, CredentialLease, CredentialNeed,
		CredentialSource, LeaseMeta, credential_ready,
	},
	oauth,
	oauth::OAuthError,
};
use crate::{
	account::{
		CredentialFreshness, PersistentRefreshLease, RefreshLeaseAcquire, RefreshLeaseRequest,
		RefreshLeaseStore, RefreshLeaseWait, RefreshReceipt, RefreshResult, RefreshStoreError,
	},
	id::{AccountId, PrincipalId},
};

const SCHEMA_VERSION: u32 = 3;
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);
const OAUTH_RENEWABLE_KIND: &str = "oauth-renewable-v1";

/// Origin of credential material presented to persistence.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CredentialOrigin {
	/// Credential produced by an interactive or explicitly persistent source.
	Persistent,
	/// Process-environment credential that must remain ephemeral.
	Environment,
}

/// Secret-free metadata for one stored credential.
#[derive(Clone, Eq, PartialEq, Serialize, Deserialize)]
pub struct CredentialMetadata {
	/// Stable account identifier.
	pub account_id:    AccountId,
	/// Stable authenticated principal identifier.
	pub principal_id:  PrincipalId,
	/// Credential shape understood by the inner authentication layer.
	pub kind:          Str,
	/// Monotonic generation incremented by every secret update.
	pub generation:    u64,
	/// Creation time in Unix milliseconds.
	pub created_at_ms: u64,
	/// Last update time in Unix milliseconds.
	pub updated_at_ms: u64,
	/// Optional expiry time in Unix milliseconds.
	pub expires_at_ms: Option<u64>,
}

impl fmt::Debug for CredentialMetadata {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("CredentialMetadata")
			.field("account_id", &self.account_id)
			.field("principal_id", &self.principal_id)
			.field("kind", &self.kind)
			.field("generation", &self.generation)
			.field("created_at_ms", &self.created_at_ms)
			.field("updated_at_ms", &self.updated_at_ms)
			.field("expires_at_ms", &self.expires_at_ms)
			.finish()
	}
}
/// Authenticated evidence durably committed before one temporary reveal.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuditedCredentialReveal {
	/// Extension receiving the temporary secret projection.
	pub extension:          Str,
	/// Authenticated daemon principal which owns the CONTROL connection.
	pub caller_principal:   Str,
	/// Provider scope already authorized by the CONTROL boundary.
	pub provider:           Str,
	/// Active child incarnation.
	pub host_generation:    u64,
	/// Active session incarnation.
	pub session_generation: u64,
	/// Child-local request correlation, unique within the host generation.
	pub request_id:         u64,
	/// Closed, non-secret purpose recorded for operator review.
	pub reason:             Str,
}
/// Authenticated request for one durable, facet-restricted scoped token.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScopedCredentialGrant {
	/// Extension receiving the token.
	pub extension:          Str,
	/// Authenticated daemon principal owning the CONTROL connection.
	pub caller_principal:   Str,
	/// Provider namespace already admitted by the CONTROL boundary.
	pub provider:           Str,
	/// Provider-defined facet this token may authorize.
	pub facet:              Str,
	/// Active child incarnation.
	pub host_generation:    u64,
	/// Active session incarnation.
	pub session_generation: u64,
	/// Child-local request correlation used for idempotent minting.
	pub request_id:         u64,
	/// Absolute expiration in Unix milliseconds.
	pub expires_at_ms:      u64,
}

/// One temporary scoped token; diagnostics remain redacted.
pub struct ScopedCredentialToken {
	/// Opaque token material returned exactly once to the scoped consumer.
	pub token:         SecretString,
	/// Absolute expiration in Unix milliseconds.
	pub expires_at_ms: u64,
}

impl fmt::Debug for ScopedCredentialToken {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("ScopedCredentialToken")
			.field("token", &"[REDACTED]")
			.field("expires_at_ms", &self.expires_at_ms)
			.finish()
	}
}

/// Decrypted credential returned only to the credential-source boundary.
pub(crate) struct StoredCredential {
	/// Non-secret persisted metadata.
	pub(crate) metadata: CredentialMetadata,
	/// Short-lived, zeroizing secret material.
	pub(crate) secret:   SecretBox<Vec<u8>>,
}

impl fmt::Debug for StoredCredential {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("StoredCredential")
			.field("metadata", &self.metadata)
			.field("secret", &"[REDACTED]")
			.finish()
	}
}

/// Input for an atomic credential insert or replacement.
pub struct CredentialWrite<'a, S: zeroize::Zeroize + ?Sized = [u8]> {
	/// Account receiving the secret.
	pub account_id:          &'a AccountId<str>,
	/// Principal owning the account.
	pub principal_id:        &'a PrincipalId<str>,
	/// Credential kind authenticated with the ciphertext.
	pub kind:                &'a str,
	/// New secret bytes.
	pub secret:              &'a SecretBox<S>,
	/// Optional expiry time in Unix milliseconds.
	pub expires_at_ms:       Option<u64>,
	/// Source controlling whether persistence is permitted.
	pub origin:              CredentialOrigin,
	/// Current Unix time in milliseconds.
	pub now_ms:              u64,
	/// Optional compare-and-swap generation.
	pub expected_generation: Option<u64>,
}
/// Renewable OAuth material imported from an external credential authority.
///
/// The store converts this typed input into its canonical opaque renewal
/// bundle; callers never encode or depend on that private format.
pub struct OAuthCredentialImport {
	/// Account receiving the renewable credential.
	pub account_id:    AccountId,
	/// Stable non-secret identity associated with the credential.
	pub principal_id:  PrincipalId,
	/// Current OAuth access token.
	pub access_token:  SecretString,
	/// OAuth refresh token used for coordinated renewal.
	pub refresh_token: SecretString,
	/// Absolute access-token expiry.
	pub expires_at:    SystemTime,
	/// Time at which this external credential was imported.
	pub imported_at:   SystemTime,
	/// Source controlling whether persistence is permitted.
	pub origin:        CredentialOrigin,
}

/// Crate-private opaque OAuth renewal payload persistence input.
pub(crate) struct OAuthCredentialWrite<'a> {
	/// Account receiving the renewable bundle.
	pub(crate) account_id:          &'a AccountId<str>,
	/// Principal owning the account.
	pub(crate) principal_id:        &'a PrincipalId<str>,
	/// Opaque OAuth-owned bundle bytes.
	pub(crate) bundle:              &'a SecretBox<Vec<u8>>,
	/// Optional access-token expiry time in Unix milliseconds.
	pub(crate) expires_at_ms:       Option<u64>,
	/// Source controlling whether persistence is permitted.
	pub(crate) origin:              CredentialOrigin,
	/// Current Unix time in milliseconds.
	pub(crate) now_ms:              u64,
	/// Optional compare-and-swap generation.
	pub(crate) expected_generation: Option<u64>,
}

/// Crate-private stored OAuth bundle visible only inside authentication.
pub(crate) struct StoredOAuthCredential {
	/// Secret-free persisted metadata.
	pub(crate) metadata: CredentialMetadata,
	/// OAuth-owned opaque bytes, zeroized on drop.
	pub(crate) bundle:   SecretBox<Vec<u8>>,
}

impl fmt::Debug for StoredOAuthCredential {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("StoredOAuthCredential")
			.field("metadata", &self.metadata)
			.field("bundle", &"[REDACTED]")
			.finish()
	}
}

/// Fencing token for one cross-process lease holder.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PersistentLease {
	/// Account whose operation is leased.
	pub account_id:    AccountId,
	/// Operation namespace, such as `refresh`.
	pub kind:          Str,
	/// Opaque process owner identifier.
	pub owner:         Str,
	/// Monotonic fencing epoch.
	pub epoch:         u64,
	/// Lease expiry in Unix milliseconds.
	pub expires_at_ms: u64,
}

impl PersistentLease {
	fn from_refresh(lease: &PersistentRefreshLease) -> Result<Self, StoreError> {
		let epoch = lease
			.id
			.as_str()
			.parse::<u64>()
			.map_err(|_| StoreError::MalformedLease)?;
		Ok(Self {
			account_id: lease.account.clone(),
			kind: sf!("refresh"),
			owner: lease.owner.clone(),
			epoch,
			expires_at_ms: unix_ms(lease.expires_at)?,
		})
	}
}

/// Result of trying to acquire a cross-process lease.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LeaseOutcome {
	/// Caller acquired the lease and fencing token.
	Acquired(PersistentLease),
	/// Another process owns an unexpired lease.
	Held {
		/// Current opaque owner.
		owner:         Str,
		/// Current fencing epoch.
		epoch:         u64,
		/// Expiry in Unix milliseconds.
		expires_at_ms: u64,
	},
}

/// Persistence failure with no secret-bearing diagnostic fields.
#[derive(Debug, Error)]
pub enum StoreError {
	/// SQLite rejected an operation.
	#[error("credential metadata database operation failed")]
	Database(#[source] rusqlite::Error),
	/// The database was created by a newer implementation.
	#[error("credential store schema {found} is newer than supported schema {supported}")]
	NewerSchema {
		/// Schema version found in the file.
		found:     u32,
		/// Newest supported schema version.
		supported: u32,
	},
	/// The requested account does not exist.
	#[error("credential account was not found")]
	NotFound,
	/// A compare-and-swap generation did not match.
	#[error("credential generation changed concurrently")]
	GenerationConflict,
	/// An update attempted to bind an existing account to another principal.
	#[error("credential account cannot change authenticated principal")]
	PrincipalChanged,
	/// A fencing token no longer owns an unexpired persistent lease.
	#[error("credential persistence lease is no longer owned")]
	LeaseLost,
	/// The credential generation or lease epoch overflowed.
	#[error("credential persistence counter exhausted")]
	CounterExhausted,
	/// Environment credentials may not be persisted.
	#[error("environment credentials are ephemeral and cannot be persisted")]
	EphemeralCredential,
	/// A stored nonce has an invalid shape.
	#[error("stored credential envelope is malformed")]
	MalformedEnvelope,
	/// The configured key source failed.
	#[error(transparent)]
	Key(#[from] KeyError),
	/// Authenticated encryption failed.
	#[error(transparent)]
	Crypto(#[from] CryptoError),
	/// An imported OAuth bundle could not be encoded canonically.
	#[error(transparent)]
	OAuth(#[from] OAuthError),
	/// A supplied system time predates the Unix epoch or overflows milliseconds.
	#[error("credential persistence time is out of range")]
	InvalidTime,
	/// Audited reveal evidence omitted an authenticated binding.
	#[error("credential reveal audit context is invalid")]
	InvalidRevealAudit,
	/// A retried reveal request changed its authenticated evidence.
	#[error("credential reveal audit request conflicts with durable evidence")]
	RevealAuditConflict,
	/// Durable secret-free account lifecycle state rejected an operation.
	#[error("credential account state operation failed")]
	AccountState,
	/// A scoped-token request omitted or contradicted an authenticated binding.
	#[error("credential scoped-token grant is invalid")]
	InvalidScopedGrant,
	/// A refresh-coordinator lease identity could not be mapped to its fencing
	/// epoch.
	#[error("credential persistence lease identity is malformed")]
	MalformedLease,
	/// A secret-free backup destination could not be created exclusively.
	#[error("credential metadata backup destination could not be created")]
	BackupIo(#[source] io::Error),
}

impl From<rusqlite::Error> for StoreError {
	fn from(error: rusqlite::Error) -> Self {
		Self::Database(error)
	}
}

/// Process-safe handle to one SQLite credential store.
///
/// Each operation opens its own SQLite connection. WAL mode and immediate write
/// transactions provide concurrent readers plus cross-process write and lease
/// serialization without sharing secret material between processes.
pub struct CredentialStore {
	path: PathBuf,
	keys: Arc<dyn KeySource>,
}

/// Secret-safe credential source backed by [`CredentialStore`].
#[derive(Clone)]
pub struct StoredCredentialSource {
	store: Arc<CredentialStore>,
}

impl StoredCredentialSource {
	/// Creates an opaque lease source over an opened encrypted credential store.
	pub const fn new(store: Arc<CredentialStore>) -> Self {
		Self { store }
	}

	/// Returns the underlying store for secret-free account metadata operations.
	pub const fn store(&self) -> &Arc<CredentialStore> {
		&self.store
	}
}

impl fmt::Debug for StoredCredentialSource {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("StoredCredentialSource")
			.finish_non_exhaustive()
	}
}

impl CredentialStore {
	/// Opens or migrates a credential store.
	pub fn open(path: impl Into<PathBuf>, keys: Arc<dyn KeySource>) -> Result<Self, StoreError> {
		let store = Self { path: path.into(), keys };
		let mut connection = store.connection()?;
		connection.pragma_update(None, "journal_mode", "WAL")?;
		migrate(&mut connection)?;
		Ok(store)
	}

	/// Atomically inserts or replaces a credential and increments its
	/// generation.
	pub fn put<S>(&self, write: CredentialWrite<'_, S>) -> Result<CredentialMetadata, StoreError>
	where
		S: AsRef<[u8]> + zeroize::Zeroize + ?Sized,
	{
		self.put_inner(write, None)
	}

	/// Canonically encodes and persists an imported renewable OAuth bundle.
	pub fn import_oauth_bundle(
		&self,
		import: OAuthCredentialImport,
	) -> Result<CredentialMetadata, StoreError> {
		let expires_in = import
			.expires_at
			.duration_since(import.imported_at)
			.unwrap_or(Duration::ZERO);
		let bundle =
			oauth::encode_imported_bundle(import.access_token, import.refresh_token, expires_in)?;
		self.put_oauth_bundle(OAuthCredentialWrite {
			account_id:          &import.account_id,
			principal_id:        &import.principal_id,
			bundle:              &bundle,
			expires_at_ms:       Some(unix_ms(import.expires_at)?),
			origin:              import.origin,
			now_ms:              unix_ms(import.imported_at)?,
			expected_generation: None,
		})
	}

	/// Persists an OAuth-owned opaque renewable bundle atomically.
	pub(crate) fn put_oauth_bundle(
		&self,
		write: OAuthCredentialWrite<'_>,
	) -> Result<CredentialMetadata, StoreError> {
		self.put_oauth_bundle_inner(write, None)
	}

	/// Persists an OAuth-owned opaque bundle under a current refresh fencing
	/// token.
	pub(crate) fn put_oauth_bundle_under_lease(
		&self,
		write: OAuthCredentialWrite<'_>,
		lease: &PersistentLease,
		now: SystemTime,
	) -> Result<CredentialMetadata, StoreError> {
		if write.account_id != &lease.account_id {
			return Err(StoreError::LeaseLost);
		}
		self.put_oauth_bundle_inner(write, Some((lease, unix_ms(now)?)))
	}

	/// Persists an OAuth bundle under the account coordinator's opaque refresh
	/// lease.
	pub(crate) fn put_oauth_bundle_under_refresh_lease(
		&self,
		write: OAuthCredentialWrite<'_>,
		lease: &PersistentRefreshLease,
		now: SystemTime,
	) -> Result<CredentialMetadata, StoreError> {
		let persistent = PersistentLease::from_refresh(lease)?;
		self.put_oauth_bundle_under_lease(write, &persistent, now)
	}

	fn put_oauth_bundle_inner(
		&self,
		write: OAuthCredentialWrite<'_>,
		lease: Option<(&PersistentLease, u64)>,
	) -> Result<CredentialMetadata, StoreError> {
		self.put_inner(
			CredentialWrite {
				account_id:          write.account_id,
				principal_id:        write.principal_id,
				kind:                OAUTH_RENEWABLE_KIND,
				secret:              write.bundle,
				expires_at_ms:       write.expires_at_ms,
				origin:              write.origin,
				now_ms:              write.now_ms,
				expected_generation: write.expected_generation,
			},
			lease,
		)
	}

	/// Loads one OAuth-owned opaque renewable bundle inside the auth boundary.
	pub(crate) fn load_oauth_bundle(
		&self,
		account_id: &AccountId<str>,
	) -> Result<StoredOAuthCredential, StoreError> {
		let stored = self.get(account_id)?;
		if stored.metadata.kind != OAUTH_RENEWABLE_KIND {
			return Err(StoreError::NotFound);
		}
		Ok(StoredOAuthCredential { metadata: stored.metadata, bundle: stored.secret })
	}

	/// Atomically updates a credential only while a lease fencing token is
	/// current.
	pub fn put_under_lease<S>(
		&self,
		write: CredentialWrite<'_, S>,
		lease: &PersistentLease,
		now: SystemTime,
	) -> Result<CredentialMetadata, StoreError>
	where
		S: AsRef<[u8]> + zeroize::Zeroize + ?Sized,
	{
		if write.account_id != &lease.account_id {
			return Err(StoreError::LeaseLost);
		}
		self.put_inner(write, Some((lease, unix_ms(now)?)))
	}

	fn put_inner<S>(
		&self,
		write: CredentialWrite<'_, S>,
		lease: Option<(&PersistentLease, u64)>,
	) -> Result<CredentialMetadata, StoreError>
	where
		S: AsRef<[u8]> + zeroize::Zeroize + ?Sized,
	{
		if write.origin == CredentialOrigin::Environment {
			return Err(StoreError::EphemeralCredential);
		}
		let active_key = self.keys.active_key()?;
		let mut connection = self.connection()?;
		let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
		if let Some((lease, now_ms)) = lease {
			let owns_lease = transaction.query_row(
				"SELECT EXISTS(
					SELECT 1 FROM leases
					WHERE account_id = ?1 AND kind = ?2 AND owner = ?3 AND epoch = ?4
						AND expires_at_ms > ?5
				)",
				params![
					lease.account_id.as_str(),
					lease.kind.as_str(),
					lease.owner.as_str(),
					lease.epoch,
					now_ms,
				],
				|row| row.get::<_, bool>(0),
			)?;
			if !owns_lease {
				return Err(StoreError::LeaseLost);
			}
		}
		let previous = transaction
			.query_row(
				"SELECT generation, created_at_ms, principal_id FROM credentials WHERE account_id = ?1",
				[write.account_id.as_str()],
				|row| Ok((row.get::<_, u64>(0)?, row.get::<_, u64>(1)?, row.get::<_, String>(2)?)),
			)
			.optional()?;
		if previous
			.as_ref()
			.is_some_and(|row| row.2 != write.principal_id.as_str())
		{
			return Err(StoreError::PrincipalChanged);
		}
		if let (Some(expected), actual) =
			(write.expected_generation, previous.as_ref().map(|row| row.0))
			&& Some(expected) != actual
		{
			return Err(StoreError::GenerationConflict);
		}
		let generation = previous
			.as_ref()
			.map_or(Ok(1), |row| row.0.checked_add(1).ok_or(StoreError::CounterExhausted))?;
		let created_at_ms = previous.as_ref().map_or(write.now_ms, |row| row.1);
		let blob = encrypt(
			&active_key,
			SecretContext {
				account_id: write.account_id.as_str(),
				principal_id: write.principal_id.as_str(),
				kind: write.kind,
				generation,
				expires_at_ms: write.expires_at_ms,
				created_at_ms,
				updated_at_ms: write.now_ms,
			},
			write.secret,
		)?;
		transaction.execute(
			"INSERT INTO credentials (
				account_id, principal_id, kind, generation, created_at_ms, updated_at_ms,
				expires_at_ms, key_id, nonce, secret_ciphertext
			) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
			ON CONFLICT(account_id) DO UPDATE SET
				kind = excluded.kind,
				generation = excluded.generation,
				updated_at_ms = excluded.updated_at_ms,
				expires_at_ms = excluded.expires_at_ms,
				key_id = excluded.key_id,
				nonce = excluded.nonce,
				secret_ciphertext = excluded.secret_ciphertext",
			params![
				write.account_id.as_str(),
				write.principal_id.as_str(),
				write.kind,
				generation,
				created_at_ms,
				write.now_ms,
				write.expires_at_ms,
				blob.key_id.as_str(),
				blob.nonce.as_slice(),
				blob.ciphertext,
			],
		)?;
		transaction.commit()?;
		Ok(CredentialMetadata {
			account_id: write.account_id.to_owned(),
			principal_id: write.principal_id.to_owned(),
			kind: Str::new(write.kind),
			generation,
			created_at_ms,
			updated_at_ms: write.now_ms,
			expires_at_ms: write.expires_at_ms,
		})
	}

	/// Loads and authenticates one credential.
	pub(crate) fn get(&self, account_id: &AccountId<str>) -> Result<StoredCredential, StoreError> {
		let connection = self.connection()?;
		let row = connection
			.query_row(
				"SELECT principal_id, kind, generation, created_at_ms, updated_at_ms,
					expires_at_ms, key_id, nonce, secret_ciphertext
				 FROM credentials WHERE account_id = ?1",
				[account_id.as_str()],
				|row| {
					Ok((
						row.get::<_, String>(0)?,
						row.get::<_, String>(1)?,
						row.get::<_, u64>(2)?,
						row.get::<_, u64>(3)?,
						row.get::<_, u64>(4)?,
						row.get::<_, Option<u64>>(5)?,
						row.get::<_, String>(6)?,
						row.get::<_, Vec<u8>>(7)?,
						row.get::<_, Vec<u8>>(8)?,
					))
				},
			)
			.optional()?
			.ok_or(StoreError::NotFound)?;
		let nonce: [u8; 12] = row
			.7
			.try_into()
			.map_err(|_| StoreError::MalformedEnvelope)?;
		let key_id = KeyId::new(row.6);
		let key = self.keys.key(&key_id)?;
		let blob = EncryptedBlob { key_id, nonce, ciphertext: row.8 };
		let secret = decrypt(
			&key,
			SecretContext {
				account_id:    account_id.as_str(),
				principal_id:  &row.0,
				kind:          &row.1,
				generation:    row.2,
				expires_at_ms: row.5,
				created_at_ms: row.3,
				updated_at_ms: row.4,
			},
			&blob,
		)?;
		Ok(StoredCredential {
			metadata: CredentialMetadata {
				account_id:    AccountId::from(account_id),
				principal_id:  PrincipalId::new(row.0),
				kind:          Str::new(row.1),
				generation:    row.2,
				created_at_ms: row.3,
				updated_at_ms: row.4,
				expires_at_ms: row.5,
			},
			secret,
		})
	}

	/// Commits authenticated audit evidence before temporarily exposing one
	/// decrypted secret to `use_secret`.
	///
	/// The secret cannot be obtained without a durable audit row. Retries with
	/// identical request evidence are idempotent; changing any bound field for
	/// the same extension, host generation, and request id fails closed.
	pub fn with_audited_secret<R>(
		&self,
		account_id: &AccountId<str>,
		audit: &AuditedCredentialReveal,
		use_secret: impl FnOnce(&Secret) -> R,
	) -> Result<R, StoreError> {
		if audit.extension.is_empty()
			|| audit.caller_principal.is_empty()
			|| audit.provider.is_empty()
			|| audit.reason.is_empty()
		{
			return Err(StoreError::InvalidRevealAudit);
		}
		let metadata = self.metadata(account_id)?.ok_or(StoreError::NotFound)?;
		let observed_at_ms = unix_ms(SystemTime::now())?;
		let mut connection = self.connection()?;
		let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
		let existing = transaction
			.query_row(
				"SELECT account_id, caller_principal, provider, session_generation, reason
				 FROM credential_reveal_audit
				 WHERE extension = ?1 AND host_generation = ?2 AND request_id = ?3",
				params![audit.extension.as_str(), audit.host_generation, audit.request_id,],
				|row| {
					Ok((
						row.get::<_, String>(0)?,
						row.get::<_, String>(1)?,
						row.get::<_, String>(2)?,
						row.get::<_, u64>(3)?,
						row.get::<_, String>(4)?,
					))
				},
			)
			.optional()?;
		if existing.as_ref().is_some_and(|existing| {
			existing.0 != account_id.as_str()
				|| existing.1 != audit.caller_principal.as_str()
				|| existing.2 != audit.provider.as_str()
				|| existing.3 != audit.session_generation
				|| existing.4 != audit.reason.as_str()
		}) {
			return Err(StoreError::RevealAuditConflict);
		}
		if existing.is_none() {
			transaction.execute(
				"INSERT INTO credential_reveal_audit (
				 extension, caller_principal, provider, host_generation, session_generation,
				 request_id, account_id, credential_principal, credential_generation, reason,
				 observed_at_ms
				 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
				params![
					audit.extension.as_str(),
					audit.caller_principal.as_str(),
					audit.provider.as_str(),
					audit.host_generation,
					audit.session_generation,
					audit.request_id,
					account_id.as_str(),
					metadata.principal_id.as_str(),
					metadata.generation,
					audit.reason.as_str(),
					observed_at_ms,
				],
			)?;
		}
		transaction.commit()?;
		let stored = self.get(account_id)?;
		if stored.metadata.generation != metadata.generation {
			return Err(StoreError::GenerationConflict);
		}
		let temporary = Secret::new(stored.secret.expose_secret().clone());
		Ok(use_secret(&temporary))
	}

	/// Mints or replays one idempotent, durable scoped-token grant.
	pub fn mint_scoped_token(
		&self,
		account_id: &AccountId<str>,
		grant: &ScopedCredentialGrant,
	) -> Result<ScopedCredentialToken, StoreError> {
		self.mint_scoped_token_inner(account_id, grant, false)
	}

	/// Mints a grant or replays its original expiration when an RPC retry
	/// reconstructs the same durable request.
	pub fn mint_scoped_token_replay(
		&self,
		account_id: &AccountId<str>,
		grant: &ScopedCredentialGrant,
	) -> Result<ScopedCredentialToken, StoreError> {
		self.mint_scoped_token_inner(account_id, grant, true)
	}

	fn mint_scoped_token_inner(
		&self,
		account_id: &AccountId<str>,
		grant: &ScopedCredentialGrant,
		replay_expiration: bool,
	) -> Result<ScopedCredentialToken, StoreError> {
		if grant.extension.is_empty()
			|| grant.caller_principal.is_empty()
			|| grant.provider.is_empty()
			|| grant.facet.is_empty()
			|| grant.expires_at_ms <= unix_ms(SystemTime::now())?
		{
			return Err(StoreError::InvalidScopedGrant);
		}
		let mut connection = self.connection()?;
		let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
		let exists = transaction
			.query_row(
				"SELECT 1 FROM credentials WHERE account_id = ?1",
				[account_id.as_str()],
				|row| row.get::<_, u8>(0),
			)
			.optional()?
			.is_some();
		if !exists {
			return Err(StoreError::NotFound);
		}
		let existing = transaction
			.query_row(
				"SELECT account_id, caller_principal, provider, facet, session_generation,
				 expires_at_ms, key_id
				 FROM credential_scoped_grants
				 WHERE extension = ?1 AND host_generation = ?2 AND request_id = ?3",
				params![grant.extension.as_str(), grant.host_generation, grant.request_id],
				|row| {
					Ok((
						row.get::<_, String>(0)?,
						row.get::<_, String>(1)?,
						row.get::<_, String>(2)?,
						row.get::<_, String>(3)?,
						row.get::<_, u64>(4)?,
						row.get::<_, u64>(5)?,
						row.get::<_, String>(6)?,
					))
				},
			)
			.optional()?;
		let mut effective = grant.clone();
		if replay_expiration && let Some(existing) = &existing {
			effective.expires_at_ms = existing.5;
		}
		let key = if let Some(existing) = existing {
			if existing.0 != account_id.as_str()
				|| existing.1 != effective.caller_principal.as_str()
				|| existing.2 != effective.provider.as_str()
				|| existing.3 != effective.facet.as_str()
				|| existing.4 != effective.session_generation
				|| existing.5 != effective.expires_at_ms
			{
				return Err(StoreError::InvalidScopedGrant);
			}
			self.keys.key(&KeyId::new(existing.6))?
		} else {
			let key = self.keys.active_key()?;
			transaction.execute(
				"INSERT INTO credential_scoped_grants (
				 extension, caller_principal, provider, facet, host_generation,
				 session_generation, request_id, account_id, expires_at_ms, key_id,
				 created_at_ms
				 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
				params![
					effective.extension.as_str(),
					effective.caller_principal.as_str(),
					effective.provider.as_str(),
					effective.facet.as_str(),
					effective.host_generation,
					effective.session_generation,
					effective.request_id,
					account_id.as_str(),
					effective.expires_at_ms,
					key.id().as_str(),
					unix_ms(SystemTime::now())?,
				],
			)?;
			key
		};
		transaction.commit()?;
		let token = scoped_token_material(&key, account_id, &effective);
		Ok(ScopedCredentialToken {
			token:         SecretString::from(token),
			expires_at_ms: effective.expires_at_ms,
		})
	}

	/// Returns secret-free metadata for an account.
	pub fn metadata(
		&self,
		account_id: &AccountId<str>,
	) -> Result<Option<CredentialMetadata>, StoreError> {
		let connection = self.connection()?;
		connection
			.query_row(
				"SELECT principal_id, kind, generation, created_at_ms, updated_at_ms, expires_at_ms
				 FROM credentials WHERE account_id = ?1",
				[account_id.as_str()],
				|row| metadata_from_row(AccountId::from(account_id), row, 0),
			)
			.optional()
			.map_err(StoreError::from)
	}

	/// Lists every credential as secret-free metadata.
	pub fn list_metadata(&self) -> Result<Vec<CredentialMetadata>, StoreError> {
		let connection = self.connection()?;
		let mut statement = connection.prepare(
			"SELECT account_id, principal_id, kind, generation, created_at_ms, updated_at_ms, \
			 expires_at_ms
			 FROM credentials ORDER BY account_id",
		)?;
		let rows = statement.query_map([], |row| {
			let account_id = AccountId::new(row.get::<_, String>(0)?);
			metadata_from_row(account_id, row, 1)
		})?;
		rows
			.collect::<Result<Vec<_>, _>>()
			.map_err(StoreError::from)
	}

	/// Deletes credential metadata, encrypted bytes, and associated leases
	/// atomically.
	pub fn delete(&self, account_id: &AccountId<str>) -> Result<bool, StoreError> {
		let connection = self.connection()?;
		Ok(connection
			.execute("DELETE FROM credentials WHERE account_id = ?1", [account_id.as_str()])?
			!= 0)
	}

	/// Re-encrypts every secret with the active key in one transaction.
	pub fn rotate_keys(&self) -> Result<usize, StoreError> {
		let active = self.keys.active_key()?;
		let mut connection = self.connection()?;
		let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
		let encrypted = {
			let mut statement = transaction.prepare(
				"SELECT account_id, principal_id, kind, generation, expires_at_ms, created_at_ms,
					updated_at_ms, key_id, nonce, secret_ciphertext FROM credentials",
			)?;
			let rows = statement.query_map([], |row| {
				Ok((
					row.get::<_, String>(0)?,
					row.get::<_, String>(1)?,
					row.get::<_, String>(2)?,
					row.get::<_, u64>(3)?,
					row.get::<_, Option<u64>>(4)?,
					row.get::<_, u64>(5)?,
					row.get::<_, u64>(6)?,
					row.get::<_, String>(7)?,
					row.get::<_, Vec<u8>>(8)?,
					row.get::<_, Vec<u8>>(9)?,
				))
			})?;
			rows.collect::<Result<Vec<_>, _>>()?
		};
		let mut changed = 0;
		for (
			account,
			principal,
			kind,
			generation,
			expires_at_ms,
			created_at_ms,
			updated_at_ms,
			old_key_id,
			nonce,
			ciphertext,
		) in &encrypted
		{
			if old_key_id == active.id().as_str() {
				continue;
			}
			let nonce: [u8; 12] = nonce
				.as_slice()
				.try_into()
				.map_err(|_| StoreError::MalformedEnvelope)?;
			let old_key_id = KeyId::new(old_key_id.as_str());
			let old_key = self.keys.key(&old_key_id)?;
			let secret = decrypt(
				&old_key,
				SecretContext {
					account_id: account,
					principal_id: principal,
					kind,
					generation: *generation,
					expires_at_ms: *expires_at_ms,
					created_at_ms: *created_at_ms,
					updated_at_ms: *updated_at_ms,
				},
				&EncryptedBlob { key_id: old_key_id, nonce, ciphertext: ciphertext.clone() },
			)?;
			let replacement = encrypt(
				&active,
				SecretContext {
					account_id: account,
					principal_id: principal,
					kind,
					generation: *generation,
					expires_at_ms: *expires_at_ms,
					created_at_ms: *created_at_ms,
					updated_at_ms: *updated_at_ms,
				},
				&secret,
			)?;
			transaction.execute(
				"UPDATE credentials SET key_id = ?2, nonce = ?3, secret_ciphertext = ?4 WHERE \
				 account_id = ?1",
				params![
					account,
					replacement.key_id.as_str(),
					replacement.nonce.as_slice(),
					replacement.ciphertext
				],
			)?;
			changed += 1;
		}
		transaction.commit()?;
		Ok(changed)
	}

	/// Tries to acquire an expiring, cross-process lease.
	pub fn try_acquire_lease(
		&self,
		account_id: &AccountId<str>,
		kind: &str,
		owner: &str,
		now: SystemTime,
		ttl: Duration,
	) -> Result<LeaseOutcome, StoreError> {
		let now_ms = unix_ms(now)?;
		let expires_at_ms = now_ms
			.checked_add(u64::try_from(ttl.as_millis()).map_err(|_| StoreError::InvalidTime)?)
			.ok_or(StoreError::InvalidTime)?;
		let mut connection = self.connection()?;
		let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
		if !transaction.query_row(
			"SELECT EXISTS(SELECT 1 FROM credentials WHERE account_id = ?1)",
			[account_id.as_str()],
			|row| row.get::<_, bool>(0),
		)? {
			return Err(StoreError::NotFound);
		}
		let current = transaction
			.query_row(
				"SELECT owner, epoch, expires_at_ms FROM leases WHERE account_id = ?1 AND kind = ?2",
				params![account_id.as_str(), kind],
				|row| Ok((row.get::<_, String>(0)?, row.get::<_, u64>(1)?, row.get::<_, u64>(2)?)),
			)
			.optional()?;
		if let Some((held_owner, epoch, held_until)) = &current
			&& *held_until > now_ms
			&& held_owner != owner
		{
			return Ok(LeaseOutcome::Held {
				owner:         Str::new(held_owner.as_str()),
				epoch:         *epoch,
				expires_at_ms: *held_until,
			});
		}
		let epoch = current
			.map_or(Ok(1), |(_, epoch, _)| epoch.checked_add(1).ok_or(StoreError::CounterExhausted))?;
		transaction.execute(
			"INSERT INTO leases (account_id, kind, owner, epoch, expires_at_ms)
			 VALUES (?1, ?2, ?3, ?4, ?5)
			 ON CONFLICT(account_id, kind) DO UPDATE SET
				owner = excluded.owner, epoch = excluded.epoch, expires_at_ms = excluded.expires_at_ms",
			params![account_id.as_str(), kind, owner, epoch, expires_at_ms],
		)?;
		transaction.commit()?;
		Ok(LeaseOutcome::Acquired(PersistentLease {
			account_id: account_id.to_owned(),
			kind: Str::new(kind),
			owner: Str::new(owner),
			epoch,
			expires_at_ms,
		}))
	}

	/// Renews a still-owned, unexpired lease.
	pub fn renew_lease(
		&self,
		lease: &mut PersistentLease,
		now: SystemTime,
		ttl: Duration,
	) -> Result<bool, StoreError> {
		let now_ms = unix_ms(now)?;
		let expires_at_ms = now_ms
			.checked_add(u64::try_from(ttl.as_millis()).map_err(|_| StoreError::InvalidTime)?)
			.ok_or(StoreError::InvalidTime)?;
		let connection = self.connection()?;
		let changed = connection.execute(
			"UPDATE leases SET expires_at_ms = ?5
			 WHERE account_id = ?1 AND kind = ?2 AND owner = ?3 AND epoch = ?4 AND expires_at_ms > ?6",
			params![
				lease.account_id.as_str(),
				lease.kind.as_str(),
				lease.owner.as_str(),
				lease.epoch,
				expires_at_ms,
				now_ms,
			],
		)?;
		if changed != 0 {
			lease.expires_at_ms = expires_at_ms;
		}
		Ok(changed != 0)
	}

	/// Releases a lease only when its fencing token still matches.
	pub fn release_lease(&self, lease: &PersistentLease) -> Result<bool, StoreError> {
		let connection = self.connection()?;
		Ok(connection.execute(
			"DELETE FROM leases WHERE account_id = ?1 AND kind = ?2 AND owner = ?3 AND epoch = ?4",
			params![lease.account_id.as_str(), lease.kind.as_str(), lease.owner.as_str(), lease.epoch],
		)? != 0)
	}

	/// Writes a deliberately secret-free SQLite metadata backup.
	pub fn backup_metadata(&self, destination: impl AsRef<Path>) -> Result<(), StoreError> {
		let metadata = self.list_metadata()?;
		let destination = destination.as_ref();
		drop(
			OpenOptions::new()
				.write(true)
				.create_new(true)
				.open(destination)
				.map_err(StoreError::BackupIo)?,
		);
		let mut output = Connection::open(destination)?;
		let transaction = output.transaction_with_behavior(TransactionBehavior::Immediate)?;
		transaction.execute_batch(
			"DROP TABLE IF EXISTS credential_metadata;
			 CREATE TABLE credential_metadata (
				account_id TEXT PRIMARY KEY,
				principal_id TEXT NOT NULL,
				kind TEXT NOT NULL,
				generation INTEGER NOT NULL,
				created_at_ms INTEGER NOT NULL,
				updated_at_ms INTEGER NOT NULL,
				expires_at_ms INTEGER
			 );",
		)?;
		for record in metadata {
			transaction.execute(
				"INSERT INTO credential_metadata VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
				params![
					record.account_id.as_str(),
					record.principal_id.as_str(),
					record.kind.as_str(),
					record.generation,
					record.created_at_ms,
					record.updated_at_ms,
					record.expires_at_ms,
				],
			)?;
		}
		transaction.commit()?;
		Ok(())
	}

	fn connection(&self) -> Result<Connection, StoreError> {
		let connection = Connection::open(&self.path)?;
		connection.busy_timeout(BUSY_TIMEOUT)?;
		connection.pragma_update(None, "foreign_keys", true)?;
		Ok(connection)
	}
}

impl StoredCredentialSource {
	/// Reads one lease from the encrypted store; SQLite access is synchronous
	/// so the answer is known before any future is returned.
	fn lease_now(&self, need: CredentialNeed) -> Result<CredentialLease, CredentialError> {
		let account = need.account.ok_or(CredentialError::Unavailable)?;
		if let Ok(stored) = self.store.load_oauth_bundle(&account) {
			let lease = oauth::lease_stored_bundle(stored, need.valid_after)?;
			if need
				.principal
				.as_ref()
				.is_some_and(|principal| principal != &lease.meta().principal)
			{
				return Err(CredentialError::Unavailable);
			}
			return Ok(lease);
		}
		let stored = self.store.get(&account).map_err(|error| match error {
			StoreError::NotFound => CredentialError::Unavailable,
			_ => CredentialError::SourceFailure,
		})?;
		if need
			.principal
			.as_ref()
			.is_some_and(|principal| principal != &stored.metadata.principal_id)
		{
			return Err(CredentialError::Unavailable);
		}
		let expires_at = stored
			.metadata
			.expires_at_ms
			.map(system_time_from_ms)
			.transpose()
			.map_err(|_| CredentialError::SourceFailure)?;
		if expires_at.is_some_and(|expires_at| expires_at <= need.valid_after) {
			return Err(CredentialError::Expired);
		}
		let material = String::from_utf8(stored.secret.expose_secret().clone())
			.map_err(|_| CredentialError::SourceFailure)?;
		let meta = LeaseMeta {
			account: stored.metadata.account_id,
			principal: stored.metadata.principal_id,
			generation: stored.metadata.generation,
			expires_at,
		};
		let material = SecretString::from(material);
		match stored.metadata.kind.as_str() {
			"api-key" => Ok(CredentialLease::api_key(meta, material)),
			"bearer" => Ok(CredentialLease::bearer(meta, material)),
			"session-token" => Ok(CredentialLease::session_token(meta, material)),
			_ => Err(CredentialError::InvalidSource),
		}
	}

	fn reject_now(&self, lease: &CredentialLease) -> Result<(), CredentialError> {
		let metadata = self
			.store
			.metadata(&lease.meta().account)
			.map_err(|_| CredentialError::SourceFailure)?
			.ok_or(CredentialError::Unavailable)?;
		if metadata.generation != lease.meta().generation {
			return Err(CredentialError::StaleGeneration);
		}
		Ok(())
	}
}

impl CredentialSource for StoredCredentialSource {
	fn lease(
		&self,
		need: CredentialNeed,
	) -> CredentialFuture<'_, Result<CredentialLease, CredentialError>> {
		credential_ready(self.lease_now(need))
	}

	fn reject<'a>(
		&'a self,
		lease: &'a CredentialLease,
		_evidence: AuthRejection,
	) -> CredentialFuture<'a, Result<(), CredentialError>> {
		credential_ready(self.reject_now(lease))
	}
}

impl RefreshLeaseStore for CredentialStore {
	fn try_acquire<'a>(
		&'a self,
		request: &'a RefreshLeaseRequest,
	) -> Pin<Box<dyn Future<Output = Result<RefreshLeaseAcquire, RefreshStoreError>> + Send + 'a>> {
		Box::pin(async move {
			let outcome = self
				.try_acquire_lease(
					&request.account,
					"refresh",
					request.owner.as_str(),
					request.now,
					request.ttl,
				)
				.map_err(refresh_store_error)?;
			match outcome {
				LeaseOutcome::Acquired(lease) => {
					Ok(RefreshLeaseAcquire::Acquired(PersistentRefreshLease {
						id:         Str::new(lease.epoch.to_string()),
						account:    lease.account_id,
						owner:      lease.owner,
						expires_at: system_time_from_ms(lease.expires_at_ms)
							.map_err(refresh_store_error)?,
					}))
				},
				LeaseOutcome::Held { expires_at_ms, .. } => Ok(RefreshLeaseAcquire::HeldByPeer {
					expires_at: system_time_from_ms(expires_at_ms).map_err(refresh_store_error)?,
				}),
			}
		})
	}

	fn wait_for_newer<'a>(
		&'a self,
		account: &'a AccountId<str>,
		minimum_generation: u64,
		lease_expires_at: SystemTime,
	) -> Pin<Box<dyn Future<Output = Result<RefreshLeaseWait, RefreshStoreError>> + Send + 'a>> {
		Box::pin(async move {
			loop {
				let observed_at = SystemTime::now();
				if let Some(metadata) = self.metadata(account).map_err(refresh_store_error)?
					&& metadata.generation >= minimum_generation
				{
					let freshness = CredentialFreshness {
						generation: metadata.generation,
						issued_at: None,
						expires_at: metadata
							.expires_at_ms
							.map(system_time_from_ms)
							.transpose()
							.map_err(refresh_store_error)?,
						observed_at,
					};
					let receipt = RefreshReceipt {
						account:              account.to_owned(),
						principal:            metadata.principal_id.clone(),
						rejected_generation:  minimum_generation.saturating_sub(1),
						resulting_generation: Some(metadata.generation),
						steps:                vec![crate::account::RefreshStep::PeerResultObserved {
							generation: metadata.generation,
						}],
					};
					return Ok(RefreshLeaseWait::Published(Box::new(RefreshResult {
						account: account.to_owned(),
						principal: metadata.principal_id,
						freshness,
						receipt,
					})));
				}
				if observed_at >= lease_expires_at {
					return Ok(RefreshLeaseWait::LeaseExpired { observed_at });
				}
				let remaining = lease_expires_at
					.duration_since(observed_at)
					.unwrap_or_default()
					.min(Duration::from_millis(25));
				use tokio::time;
				time::sleep(remaining).await;
			}
		})
	}

	fn renew<'a>(
		&'a self,
		lease: &'a mut PersistentRefreshLease,
		now: SystemTime,
		ttl: Duration,
	) -> Pin<Box<dyn Future<Output = Result<bool, RefreshStoreError>> + Send + 'a>> {
		Box::pin(async move {
			let epoch = lease
				.id
				.as_str()
				.parse::<u64>()
				.map_err(|_| refresh_contract_error("refresh lease identity is malformed"))?;
			let mut persistent = PersistentLease {
				account_id: lease.account.clone(),
				kind: sf!("refresh"),
				owner: lease.owner.clone(),
				epoch,
				expires_at_ms: unix_ms(lease.expires_at).map_err(refresh_store_error)?,
			};
			let renewed =
				Self::renew_lease(self, &mut persistent, now, ttl).map_err(refresh_store_error)?;
			if renewed {
				lease.expires_at =
					system_time_from_ms(persistent.expires_at_ms).map_err(refresh_store_error)?;
			}
			Ok(renewed)
		})
	}

	fn publish<'a>(
		&'a self,
		lease: &'a PersistentRefreshLease,
		result: &'a RefreshResult,
	) -> Pin<Box<dyn Future<Output = Result<(), RefreshStoreError>> + Send + 'a>> {
		Box::pin(async move {
			if lease.account != result.account {
				return Err(refresh_contract_error("refresh result account does not match lease"));
			}
			let epoch = lease
				.id
				.as_str()
				.parse::<u64>()
				.map_err(|_| refresh_contract_error("refresh lease identity is malformed"))?;
			let connection = self.connection().map_err(refresh_store_error)?;
			let owns_lease = connection
				.query_row(
					"SELECT EXISTS(
						SELECT 1 FROM leases
						WHERE account_id = ?1 AND kind = 'refresh' AND owner = ?2 AND epoch = ?3
					)",
					params![lease.account.as_str(), lease.owner.as_str(), epoch],
					|row| row.get::<_, bool>(0),
				)
				.map_err(StoreError::from)
				.map_err(refresh_store_error)?;
			if !owns_lease {
				return Err(refresh_contract_error("refresh lease is no longer owned"));
			}
			let metadata = self
				.metadata(&lease.account)
				.map_err(refresh_store_error)?
				.ok_or_else(|| refresh_contract_error("refreshed credential metadata is missing"))?;
			if metadata.principal_id != result.principal {
				return Err(refresh_contract_error("refresh result principal does not match storage"));
			}
			if metadata.generation < result.freshness.generation {
				return Err(refresh_contract_error("refresh result generation is not persisted"));
			}
			Ok(())
		})
	}

	fn release<'a>(
		&'a self,
		lease: &'a PersistentRefreshLease,
	) -> Pin<Box<dyn Future<Output = Result<(), RefreshStoreError>> + Send + 'a>> {
		Box::pin(async move {
			let epoch = lease
				.id
				.as_str()
				.parse::<u64>()
				.map_err(|_| refresh_contract_error("refresh lease identity is malformed"))?;
			let expires_at_ms = unix_ms(lease.expires_at).map_err(refresh_store_error)?;
			let persistent = PersistentLease {
				account_id: lease.account.clone(),
				kind: sf!("refresh"),
				owner: lease.owner.clone(),
				epoch,
				expires_at_ms,
			};
			self
				.release_lease(&persistent)
				.map_err(refresh_store_error)?;
			Ok(())
		})
	}
}

impl Clone for CredentialStore {
	fn clone(&self) -> Self {
		Self { path: self.path.clone(), keys: Arc::clone(&self.keys) }
	}
}

impl fmt::Debug for CredentialStore {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("CredentialStore")
			.finish_non_exhaustive()
	}
}

fn migrate(connection: &mut Connection) -> Result<(), StoreError> {
	let found = connection.pragma_query_value(None, "user_version", |row| row.get::<_, u32>(0))?;
	if found > SCHEMA_VERSION {
		return Err(StoreError::NewerSchema { found, supported: SCHEMA_VERSION });
	}
	let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
	if found == 0 {
		transaction.execute_batch(
			"CREATE TABLE credentials (
				account_id TEXT PRIMARY KEY,
				principal_id TEXT NOT NULL,
				kind TEXT NOT NULL,
				generation INTEGER NOT NULL CHECK(generation > 0),
				created_at_ms INTEGER NOT NULL,
				updated_at_ms INTEGER NOT NULL,
				expires_at_ms INTEGER,
				key_id TEXT NOT NULL,
				nonce BLOB NOT NULL CHECK(length(nonce) = 12),
				secret_ciphertext BLOB NOT NULL CHECK(length(secret_ciphertext) >= 16)
			 );",
		)?;
	} else if found == 1 {
		transaction.execute_batch(
			"ALTER TABLE credentials ADD COLUMN created_at_ms INTEGER NOT NULL DEFAULT 0;
			 ALTER TABLE credentials ADD COLUMN expires_at_ms INTEGER;",
		)?;
	}
	transaction.execute_batch(
		"CREATE TABLE IF NOT EXISTS leases (
			account_id TEXT NOT NULL REFERENCES credentials(account_id) ON DELETE CASCADE,
			kind TEXT NOT NULL,
			owner TEXT NOT NULL,
			epoch INTEGER NOT NULL CHECK(epoch > 0),
			expires_at_ms INTEGER NOT NULL,
			PRIMARY KEY (account_id, kind)
		 );
		 CREATE INDEX IF NOT EXISTS credentials_principal ON credentials(principal_id);
		 CREATE INDEX IF NOT EXISTS leases_expiry ON leases(expires_at_ms);
		 CREATE TABLE IF NOT EXISTS credential_reveal_audit (
			extension TEXT NOT NULL,
			caller_principal TEXT NOT NULL,
			provider TEXT NOT NULL,
			host_generation INTEGER NOT NULL,
			session_generation INTEGER NOT NULL,
			request_id INTEGER NOT NULL,
			account_id TEXT NOT NULL,
			credential_principal TEXT NOT NULL,
			credential_generation INTEGER NOT NULL,
			reason TEXT NOT NULL,
			observed_at_ms INTEGER NOT NULL,
			PRIMARY KEY (extension, host_generation, request_id)
		 );
		 CREATE INDEX IF NOT EXISTS credential_reveal_audit_account
		 ON credential_reveal_audit(account_id, observed_at_ms);
		 CREATE TABLE IF NOT EXISTS credential_scoped_grants (
			extension TEXT NOT NULL,
			caller_principal TEXT NOT NULL,
			provider TEXT NOT NULL,
			facet TEXT NOT NULL,
			host_generation INTEGER NOT NULL,
			session_generation INTEGER NOT NULL,
			request_id INTEGER NOT NULL,
			account_id TEXT NOT NULL,
			expires_at_ms INTEGER NOT NULL,
			key_id TEXT NOT NULL,
			created_at_ms INTEGER NOT NULL,
			PRIMARY KEY (extension, host_generation, request_id)
		 );
		 CREATE INDEX IF NOT EXISTS credential_scoped_grants_expiry
		 ON credential_scoped_grants(expires_at_ms);",
	)?;
	transaction.pragma_update(None, "user_version", SCHEMA_VERSION)?;
	transaction.commit()?;
	Ok(())
}

fn metadata_from_row(
	account_id: AccountId,
	row: &rusqlite::Row<'_>,
	offset: usize,
) -> rusqlite::Result<CredentialMetadata> {
	Ok(CredentialMetadata {
		account_id,
		principal_id: PrincipalId::new(row.get::<_, String>(offset)?),
		kind: Str::new(row.get::<_, String>(offset + 1)?),
		generation: row.get(offset + 2)?,
		created_at_ms: row.get(offset + 3)?,
		updated_at_ms: row.get(offset + 4)?,
		expires_at_ms: row.get(offset + 5)?,
	})
}

fn scoped_token_material(
	key: &EncryptionKey,
	account: &AccountId<str>,
	grant: &ScopedCredentialGrant,
) -> String {
	let key = hmac::Key::new(hmac::HMAC_SHA256, key.bytes());
	let mut context = hmac::Context::with_key(&key);
	context.update(b"omp/credential-scoped-token/v1");
	for value in [
		account.as_str(),
		grant.extension.as_str(),
		grant.caller_principal.as_str(),
		grant.provider.as_str(),
		grant.facet.as_str(),
	] {
		context.update(&(value.len() as u64).to_le_bytes());
		context.update(value.as_bytes());
	}
	context.update(&grant.host_generation.to_le_bytes());
	context.update(&grant.session_generation.to_le_bytes());
	context.update(&grant.request_id.to_le_bytes());
	context.update(&grant.expires_at_ms.to_le_bytes());
	omp_core::base64_url::encode_raw(context.sign().as_ref()).into_string()
}

fn unix_ms(time: SystemTime) -> Result<u64, StoreError> {
	let millis = time
		.duration_since(UNIX_EPOCH)
		.map_err(|_| StoreError::InvalidTime)?
		.as_millis();
	u64::try_from(millis).map_err(|_| StoreError::InvalidTime)
}

fn system_time_from_ms(millis: u64) -> Result<SystemTime, StoreError> {
	UNIX_EPOCH
		.checked_add(Duration::from_millis(millis))
		.ok_or(StoreError::InvalidTime)
}

fn refresh_store_error(error: StoreError) -> RefreshStoreError {
	let code = match error {
		StoreError::Database(_) => "database",
		StoreError::NewerSchema { .. } => "schema",
		StoreError::NotFound => "not-found",
		StoreError::GenerationConflict => "generation-conflict",
		StoreError::PrincipalChanged => "principal-changed",
		StoreError::LeaseLost => "lease-lost",
		StoreError::CounterExhausted => "counter-exhausted",
		StoreError::EphemeralCredential => "ephemeral",
		StoreError::MalformedEnvelope => "malformed-envelope",
		StoreError::MalformedLease => "malformed-lease",
		StoreError::Key(_) => "key-unavailable",
		StoreError::Crypto(_) => "authentication",
		StoreError::OAuth(_) => "oauth-bundle",
		StoreError::InvalidTime => "invalid-time",
		StoreError::InvalidRevealAudit => "invalid-reveal-audit",
		StoreError::RevealAuditConflict => "reveal-audit-conflict",
		StoreError::AccountState => "account-state",
		StoreError::InvalidScopedGrant => "invalid-scoped-grant",
		StoreError::BackupIo(_) => "backup",
	};
	RefreshStoreError {
		code:    Str::new(code),
		summary: sf!("persistent credential coordination failed"),
	}
}

fn refresh_contract_error(summary: &'static str) -> RefreshStoreError {
	RefreshStoreError { code: sf!("contract"), summary: Str::new(summary) }
}

#[cfg(test)]
mod tests {
	use std::{
		fs,
		sync::{Arc, Barrier},
		thread,
		time::Duration,
	};

	use omp_core::{ExposeSecret, SecretBox};
	use rusqlite::Connection;
	use tempfile::tempdir;

	use super::{super::oauth::StoredOAuthBundle as OauthStoredOAuthBundle, *};
	use crate::auth::{
		crypto::{SecretContext, encrypt},
		key::{HeadlessKeySource, KeyId, UnavailableKeySource},
	};

	const KEY_ONE: [u8; 32] = [0x11; 32];
	const KEY_TWO: [u8; 32] = [0x22; 32];

	fn boxed_secret(value: &[u8]) -> SecretBox<[u8]> {
		SecretBox::new(value.to_vec().into_boxed_slice())
	}

	fn source(id: &str, key: [u8; 32]) -> Arc<HeadlessKeySource> {
		Arc::new(HeadlessKeySource::new(KeyId::new(id), key))
	}

	fn put(
		store: &CredentialStore,
		account: &AccountId<str>,
		value: &[u8],
		now_ms: u64,
	) -> CredentialMetadata {
		let secret = boxed_secret(value);
		store
			.put(CredentialWrite {
				account_id: account,
				principal_id: PrincipalId::from_ref("principal"),
				kind: "bearer",
				secret: &secret,
				expires_at_ms: Some(now_ms + 10_000),
				origin: CredentialOrigin::Persistent,
				now_ms,
				expected_generation: None,
			})
			.expect("persist credential")
	}

	#[test]
	fn encrypted_roundtrip_never_stores_plaintext() {
		let directory = tempdir().expect("temporary directory");
		let path = directory.path().join("credentials.sqlite");
		let store = CredentialStore::open(&path, source("key-one", KEY_ONE)).expect("open store");
		let account = AccountId::new("account");
		let metadata = put(&store, &account, b"roundtrip-secret-marker", 100);
		let loaded = store.get(&account).expect("load credential");
		assert_eq!(loaded.secret.expose_secret().as_slice(), b"roundtrip-secret-marker");
		assert_eq!(loaded.metadata, metadata);

		for artifact in
			[&path, &path.with_extension("sqlite-wal"), &path.with_extension("sqlite-shm")]
		{
			if let Ok(bytes) = fs::read(artifact) {
				assert!(
					!bytes
						.windows(b"roundtrip-secret-marker".len())
						.any(|window| window == b"roundtrip-secret-marker")
				);
			}
		}
	}

	#[test]
	fn opaque_oauth_bundle_roundtrips_and_refreshes_with_fencing() {
		let directory = tempdir().expect("temporary directory");
		let path = directory.path().join("credentials.sqlite");
		let store = CredentialStore::open(&path, source("key", KEY_ONE)).expect("open store");
		let account = AccountId::new("oauth-account");
		let principal = PrincipalId::new("oauth-principal");
		let bundle = SecretBox::new(Box::new(b"access-marker\\0refresh-marker\\0Bearer".to_vec()));
		let first = store
			.put_oauth_bundle(OAuthCredentialWrite {
				account_id:          &account,
				principal_id:        &principal,
				bundle:              &bundle,
				expires_at_ms:       Some(2_000),
				origin:              CredentialOrigin::Persistent,
				now_ms:              1_000,
				expected_generation: None,
			})
			.expect("persist OAuth bundle");
		assert_eq!(first.generation, 1);
		assert_eq!(first.kind, OAUTH_RENEWABLE_KIND);
		let loaded = store
			.load_oauth_bundle(&account)
			.expect("load opaque OAuth bundle");
		assert_eq!(
			loaded.bundle.expose_secret().as_slice(),
			b"access-marker\\0refresh-marker\\0Bearer"
		);
		assert!(!format!("{loaded:?}").contains("refresh-marker"));

		let start = UNIX_EPOCH + Duration::from_secs(1);
		let lease = match store
			.try_acquire_lease(&account, "refresh", "refresh-process", start, Duration::from_secs(30))
			.expect("acquire refresh lease")
		{
			LeaseOutcome::Acquired(lease) => lease,
			LeaseOutcome::Held { .. } => panic!("refresh lease unexpectedly held"),
		};
		let refreshed =
			SecretBox::new(Box::new(b"new-access-marker\\0new-refresh-marker\\0Bearer".to_vec()));
		let second = store
			.put_oauth_bundle_under_lease(
				OAuthCredentialWrite {
					account_id:          &account,
					principal_id:        &principal,
					bundle:              &refreshed,
					expires_at_ms:       Some(4_000),
					origin:              CredentialOrigin::Persistent,
					now_ms:              2_000,
					expected_generation: Some(first.generation),
				},
				&lease,
				start,
			)
			.expect("persist refreshed OAuth bundle");
		assert_eq!(second.generation, first.generation + 1);
		let loaded = store
			.load_oauth_bundle(&account)
			.expect("load refreshed OAuth bundle");
		assert_eq!(
			loaded.bundle.expose_secret().as_slice(),
			b"new-access-marker\\0new-refresh-marker\\0Bearer"
		);
		for artifact in
			[&path, &path.with_extension("sqlite-wal"), &path.with_extension("sqlite-shm")]
		{
			if let Ok(bytes) = fs::read(artifact) {
				assert!(
					!bytes
						.windows(b"new-refresh-marker".len())
						.any(|window| window == b"new-refresh-marker")
				);
			}
		}
	}

	#[test]
	fn imported_oauth_bundle_roundtrips_as_renewable() {
		let directory = tempdir().expect("temporary directory");
		let path = directory.path().join("credentials.sqlite");
		let store = CredentialStore::open(&path, source("key", KEY_ONE)).expect("open store");
		let account = AccountId::new("anthropic:person@example.com");
		let principal = PrincipalId::new("person@example.com");
		let imported_at = UNIX_EPOCH + Duration::from_secs(100);
		let expires_at = UNIX_EPOCH + Duration::from_secs(3_700);

		let metadata = store
			.import_oauth_bundle(OAuthCredentialImport {
				account_id: account.clone(),
				principal_id: principal.clone(),
				access_token: SecretString::from("imported-access"),
				refresh_token: SecretString::from("imported-refresh"),
				expires_at,
				imported_at,
				origin: CredentialOrigin::Persistent,
			})
			.expect("import OAuth bundle");
		assert_eq!(metadata.account_id, account);
		assert_eq!(metadata.principal_id, principal);
		assert_eq!(metadata.expires_at_ms, Some(3_700_000));
		assert_eq!(metadata.kind, OAUTH_RENEWABLE_KIND);

		let stored = store
			.load_oauth_bundle(&account)
			.expect("load imported OAuth bundle");
		let refresh = OauthStoredOAuthBundle::decode(&stored.bundle)
			.expect("decode canonical OAuth bundle")
			.into_refresh()
			.expect("imported bundle is renewable");
		assert_eq!(refresh.expose_secret(), "imported-refresh");
	}

	#[test]
	fn environment_oauth_bundle_is_never_persisted() {
		let directory = tempdir().expect("temporary directory");
		let store =
			CredentialStore::open(directory.path().join("credentials.sqlite"), source("key", KEY_ONE))
				.expect("open store");
		let account = AccountId::new("environment-oauth");
		let bundle = SecretBox::new(Box::new(b"environment-refresh-marker".to_vec()));
		assert!(matches!(
			store.put_oauth_bundle(OAuthCredentialWrite {
				account_id:          &account,
				principal_id:        PrincipalId::from_ref("principal"),
				bundle:              &bundle,
				expires_at_ms:       None,
				origin:              CredentialOrigin::Environment,
				now_ms:              1,
				expected_generation: None,
			}),
			Err(StoreError::EphemeralCredential)
		));
		assert_eq!(store.metadata(&account).expect("metadata"), None);
	}

	#[tokio::test]
	async fn stored_source_returns_only_opaque_leases() {
		let directory = tempdir().expect("temporary directory");
		let store = Arc::new(
			CredentialStore::open(directory.path().join("credentials.sqlite"), source("key", KEY_ONE))
				.expect("open store"),
		);
		let account = AccountId::new("source-account");
		put(&store, &account, b"lease-secret-marker", 100);
		let source = StoredCredentialSource::new(store);
		let lease = source
			.lease(CredentialNeed {
				spec:        omp_catalog::AuthSpecId::new("auth"),
				account:     Some(account),
				principal:   Some(PrincipalId::new("principal")),
				valid_after: UNIX_EPOCH + Duration::from_millis(101),
			})
			.await
			.expect("opaque lease");
		assert_eq!(lease.meta().generation, 1);
		assert!(!format!("{lease:?} {source:?}").contains("lease-secret-marker"));
	}

	#[test]
	fn wrong_key_and_tampering_fail_authentication() {
		let directory = tempdir().expect("temporary directory");
		let path = directory.path().join("credentials.sqlite");
		let account = AccountId::new("account");
		let store = CredentialStore::open(&path, source("same-id", KEY_ONE)).expect("open store");
		put(&store, &account, b"protected", 100);

		let wrong =
			CredentialStore::open(&path, source("same-id", KEY_TWO)).expect("open wrong-key store");
		let wrong_error = wrong.get(&account).expect_err("wrong key must fail");
		assert!(!format!("{wrong_error:?}").contains("protected"));
		assert!(matches!(wrong_error, StoreError::Crypto(CryptoError::AuthenticationFailed)));

		let connection = Connection::open(&path).expect("tamper connection");
		connection
			.execute(
				"UPDATE credentials SET principal_id = 'tampered-principal'
				 WHERE account_id = 'account'",
				[],
			)
			.expect("tamper authenticated metadata");
		assert!(matches!(
			store.get(&account),
			Err(StoreError::Crypto(CryptoError::AuthenticationFailed))
		));
		connection
			.execute(
				"UPDATE credentials SET principal_id = 'principal' WHERE account_id = 'account'",
				[],
			)
			.expect("restore authenticated metadata");
		let mut ciphertext: Vec<u8> = connection
			.query_row(
				"SELECT secret_ciphertext FROM credentials WHERE account_id = 'account'",
				[],
				|row| row.get(0),
			)
			.expect("ciphertext");
		ciphertext[0] ^= 0x80;
		connection
			.execute("UPDATE credentials SET secret_ciphertext = ?1 WHERE account_id = 'account'", [
				&ciphertext,
			])
			.expect("tamper");
		assert!(matches!(
			store.get(&account),
			Err(StoreError::Crypto(CryptoError::AuthenticationFailed))
		));
	}

	#[test]
	fn version_one_encrypted_store_migrates_without_plaintext_path() {
		let directory = tempdir().expect("temporary directory");
		let path = directory.path().join("credentials.sqlite");
		let key_source = source("legacy-key", KEY_ONE);
		let key = key_source.active_key().expect("active key");
		let plaintext = boxed_secret(b"legacy-encrypted");
		let blob = encrypt(
			&key,
			SecretContext {
				account_id:    "account",
				principal_id:  "principal",
				kind:          "api-key",
				generation:    1,
				expires_at_ms: None,
				created_at_ms: 0,
				updated_at_ms: 44,
			},
			&plaintext,
		)
		.expect("encrypt legacy record");
		let connection = Connection::open(&path).expect("legacy database");
		connection
			.execute_batch(
				"CREATE TABLE credentials (
					account_id TEXT PRIMARY KEY,
					principal_id TEXT NOT NULL,
					kind TEXT NOT NULL,
					generation INTEGER NOT NULL,
					updated_at_ms INTEGER NOT NULL,
					key_id TEXT NOT NULL,
					nonce BLOB NOT NULL,
					secret_ciphertext BLOB NOT NULL
				 );
				 PRAGMA user_version = 1;",
			)
			.expect("legacy schema");
		connection
			.execute("INSERT INTO credentials VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)", params![
				"account",
				"principal",
				"api-key",
				1_u64,
				44_u64,
				blob.key_id.as_str(),
				blob.nonce.as_slice(),
				blob.ciphertext,
			])
			.expect("legacy row");
		drop(connection);

		let store = CredentialStore::open(&path, key_source).expect("migrate");
		let loaded = store
			.get(AccountId::from_ref("account"))
			.expect("load migrated");
		assert_eq!(loaded.secret.expose_secret().as_slice(), b"legacy-encrypted");
		assert_eq!(loaded.metadata.created_at_ms, 0);
		assert_eq!(loaded.metadata.expires_at_ms, None);
	}

	#[test]
	fn dropped_transaction_rolls_back_metadata_and_ciphertext() {
		let directory = tempdir().expect("temporary directory");
		let path = directory.path().join("credentials.sqlite");
		let account = AccountId::new("account");
		let store = CredentialStore::open(&path, source("key", KEY_ONE)).expect("open store");
		put(&store, &account, b"before-crash", 10);

		{
			let mut connection = Connection::open(&path).expect("crashing connection");
			let transaction = connection
				.transaction_with_behavior(TransactionBehavior::Immediate)
				.expect("begin transaction");
			transaction
				.execute(
					"UPDATE credentials SET generation = 99, secret_ciphertext = zeroblob(16)
					 WHERE account_id = 'account'",
					[],
				)
				.expect("provisional update");
		}

		let loaded = store.get(&account).expect("load rolled-back credential");
		assert_eq!(loaded.metadata.generation, 1);
		assert_eq!(loaded.secret.expose_secret().as_slice(), b"before-crash");
	}

	#[test]
	fn account_principal_binding_cannot_change() {
		let directory = tempdir().expect("temporary directory");
		let store =
			CredentialStore::open(directory.path().join("credentials.sqlite"), source("key", KEY_ONE))
				.expect("open store");
		let account = AccountId::new("account");
		put(&store, &account, b"original", 1);
		let replacement = boxed_secret(b"replacement");
		assert!(matches!(
			store.put(CredentialWrite {
				account_id:          &account,
				principal_id:        PrincipalId::from_ref("different-principal"),
				kind:                "bearer",
				secret:              &replacement,
				expires_at_ms:       None,
				origin:              CredentialOrigin::Persistent,
				now_ms:              2,
				expected_generation: Some(1),
			}),
			Err(StoreError::PrincipalChanged)
		));
		let loaded = store.get(&account).expect("original credential");
		assert_eq!(loaded.metadata.principal_id, PrincipalId::new("principal"));
		assert_eq!(loaded.secret.expose_secret().as_slice(), b"original");
	}

	#[test]
	fn concurrent_readers_and_writers_observe_atomic_generations() {
		let directory = tempdir().expect("temporary directory");
		let path = directory.path().join("credentials.sqlite");
		let store = Arc::new(
			CredentialStore::open(&path, source("key", KEY_ONE)).expect("open concurrent store"),
		);
		let account = AccountId::new("shared");
		put(&store, &account, b"initial", 1);
		let workers = 8;
		let barrier = Arc::new(Barrier::new(workers));
		let mut threads = Vec::new();
		for worker in 0..workers {
			let store = Arc::clone(&store);
			let account = account.clone();
			let barrier = Arc::clone(&barrier);
			threads.push(thread::spawn(move || {
				barrier.wait();
				let value = format!("writer-{worker}");
				put(&store, &account, value.as_bytes(), 10 + worker as u64);
				let observed = store.get(&account).expect("concurrent read");
				assert!(observed.metadata.generation >= 2);
				let empty: &[u8] = &[];
				assert_ne!(observed.secret.expose_secret().as_slice(), empty);
			}));
		}
		for worker in threads {
			worker.join().expect("worker");
		}
		assert_eq!(
			store
				.get(&account)
				.expect("final credential")
				.metadata
				.generation,
			9
		);
	}

	#[test]
	fn expired_lease_is_recovered_with_new_fencing_epoch() {
		let directory = tempdir().expect("temporary directory");
		let store =
			CredentialStore::open(directory.path().join("credentials.sqlite"), source("key", KEY_ONE))
				.expect("open store");
		let account = AccountId::new("account");
		put(&store, &account, b"secret", 1);
		let start = UNIX_EPOCH + Duration::from_secs(100);
		let first = match store
			.try_acquire_lease(&account, "refresh", "process-a", start, Duration::from_secs(5))
			.expect("first lease")
		{
			LeaseOutcome::Acquired(lease) => lease,
			LeaseOutcome::Held { .. } => panic!("first lease unexpectedly held"),
		};
		assert!(matches!(
			store
				.try_acquire_lease(
					&account,
					"refresh",
					"process-b",
					start + Duration::from_secs(4),
					Duration::from_secs(5),
				)
				.expect("held lease"),
			LeaseOutcome::Held { .. }
		));
		let second = match store
			.try_acquire_lease(
				&account,
				"refresh",
				"process-b",
				start + Duration::from_secs(6),
				Duration::from_secs(5),
			)
			.expect("expired recovery")
		{
			LeaseOutcome::Acquired(lease) => lease,
			LeaseOutcome::Held { .. } => panic!("expired lease remained held"),
		};
		assert!(second.epoch > first.epoch);
		let stale_secret = boxed_secret(b"stale-refresh");
		assert!(matches!(
			store.put_under_lease(
				CredentialWrite {
					account_id:          &account,
					principal_id:        PrincipalId::from_ref("principal"),
					kind:                "bearer",
					secret:              &stale_secret,
					expires_at_ms:       None,
					origin:              CredentialOrigin::Persistent,
					now_ms:              2,
					expected_generation: Some(1),
				},
				&first,
				start + Duration::from_secs(6),
			),
			Err(StoreError::LeaseLost)
		));
		let fresh_secret = boxed_secret(b"fresh-refresh");
		store
			.put_under_lease(
				CredentialWrite {
					account_id:          &account,
					principal_id:        PrincipalId::from_ref("principal"),
					kind:                "bearer",
					secret:              &fresh_secret,
					expires_at_ms:       None,
					origin:              CredentialOrigin::Persistent,
					now_ms:              3,
					expected_generation: Some(1),
				},
				&second,
				start + Duration::from_secs(6),
			)
			.expect("fenced refresh write");
		assert_eq!(
			store
				.get(&account)
				.expect("fresh credential")
				.secret
				.expose_secret()
				.as_slice(),
			b"fresh-refresh"
		);
		assert!(!store.release_lease(&first).expect("stale release"));
		assert!(store.release_lease(&second).expect("current release"));
	}

	#[test]
	fn unavailable_key_and_environment_credentials_fail_closed() {
		let directory = tempdir().expect("temporary directory");
		let path = directory.path().join("credentials.sqlite");
		let store = CredentialStore::open(&path, source("key", KEY_ONE)).expect("open store");
		let account = AccountId::new("environment");
		let secret = boxed_secret(b"ephemeral-marker");
		assert!(matches!(
			store.put(CredentialWrite {
				account_id:          &account,
				principal_id:        PrincipalId::from_ref("principal"),
				kind:                "api-key",
				secret:              &secret,
				expires_at_ms:       None,
				origin:              CredentialOrigin::Environment,
				now_ms:              1,
				expected_generation: None,
			}),
			Err(StoreError::EphemeralCredential)
		));
		assert_eq!(store.metadata(&account).expect("metadata lookup"), None);
		for artifact in
			[&path, &path.with_extension("sqlite-wal"), &path.with_extension("sqlite-shm")]
		{
			if let Ok(bytes) = fs::read(artifact) {
				assert!(
					!bytes
						.windows(b"ephemeral-marker".len())
						.any(|window| window == b"ephemeral-marker")
				);
			}
		}

		let unavailable =
			CredentialStore::open(path, Arc::new(UnavailableKeySource)).expect("open unavailable");
		let persistent = boxed_secret(b"not-written");
		assert!(matches!(
			unavailable.put(CredentialWrite {
				account_id:          AccountId::from_ref("missing-key"),
				principal_id:        PrincipalId::from_ref("principal"),
				kind:                "api-key",
				secret:              &persistent,
				expires_at_ms:       None,
				origin:              CredentialOrigin::Persistent,
				now_ms:              2,
				expected_generation: None,
			}),
			Err(StoreError::Key(KeyError::Unavailable))
		));
		assert_eq!(
			unavailable
				.metadata(AccountId::from_ref("missing-key"))
				.expect("failed write metadata"),
			None
		);
	}

	#[test]
	fn rotation_changes_key_and_nonce_without_changing_generation() {
		let directory = tempdir().expect("temporary directory");
		let path = directory.path().join("credentials.sqlite");
		let keys = source("key-one", KEY_ONE);
		let store = CredentialStore::open(&path, keys.clone()).expect("open store");
		let account = AccountId::new("account");
		put(&store, &account, b"rotation-secret", 1);
		let before: (String, Vec<u8>) = Connection::open(&path)
			.expect("inspect")
			.query_row(
				"SELECT key_id, nonce FROM credentials WHERE account_id = 'account'",
				[],
				|row| Ok((row.get(0)?, row.get(1)?)),
			)
			.expect("before envelope");
		keys
			.install_active(KeyId::new("key-two"), KEY_TWO)
			.expect("install active key");
		assert_eq!(store.rotate_keys().expect("rotate keys"), 1);
		let after: (String, Vec<u8>) = Connection::open(&path)
			.expect("inspect")
			.query_row(
				"SELECT key_id, nonce FROM credentials WHERE account_id = 'account'",
				[],
				|row| Ok((row.get(0)?, row.get(1)?)),
			)
			.expect("after envelope");
		assert_eq!(before.0, "key-one");
		assert_eq!(after.0, "key-two");
		assert_ne!(before.1, after.1);
		let loaded = store.get(&account).expect("load rotated");
		assert_eq!(loaded.metadata.generation, 1);
		assert_eq!(loaded.secret.expose_secret().as_slice(), b"rotation-secret");
		assert_eq!(store.rotate_keys().expect("already current"), 0);
		let unchanged_nonce: Vec<u8> = Connection::open(&path)
			.expect("inspect unchanged")
			.query_row("SELECT nonce FROM credentials WHERE account_id = 'account'", [], |row| {
				row.get(0)
			})
			.expect("unchanged envelope");
		assert_eq!(unchanged_nonce, after.1);
	}

	#[test]
	fn diagnostics_and_metadata_backup_are_secret_free() {
		let directory = tempdir().expect("temporary directory");
		let path = directory.path().join("credentials.sqlite");
		let backup = directory.path().join("metadata.sqlite");
		let keys = source("key", KEY_ONE);
		let store = CredentialStore::open(&path, keys.clone()).expect("open store");
		let account = AccountId::new("account");
		put(&store, &account, b"redaction-marker", 1);
		let loaded = store.get(&account).expect("load");
		assert!(!format!("{loaded:?}").contains("redaction-marker"));
		assert!(!format!("{store:?}").contains(path.to_string_lossy().as_ref()));
		assert!(!format!("{keys:?}").contains(&format!("{KEY_ONE:?}")));
		store.backup_metadata(&backup).expect("metadata backup");
		assert!(matches!(store.backup_metadata(&backup), Err(StoreError::BackupIo(_))));
		let backup_bytes = fs::read(&backup).expect("read backup");
		assert!(
			!backup_bytes
				.windows(b"redaction-marker".len())
				.any(|window| window == b"redaction-marker")
		);
		let backup_connection = Connection::open(backup).expect("backup database");
		let schema: String = backup_connection
			.query_row("SELECT sql FROM sqlite_master WHERE name = 'credential_metadata'", [], |row| {
				row.get(0)
			})
			.expect("backup schema");
		assert!(!schema.contains("ciphertext"));
		assert!(!schema.contains("nonce"));
		assert!(!schema.contains("key_id"));
	}
}
