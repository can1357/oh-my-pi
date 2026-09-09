//! MCP projection of the app's combined encrypted credential authority.

use std::{fmt, mem, sync::Arc, time::SystemTime};

use futures::future::BoxFuture;
use omp_ai::{
	auth::{
		AuditedCredentialReveal, AuthRejection, CredentialError, CredentialFuture, CredentialLease,
		CredentialNeed, CredentialOrigin, CredentialSource, CredentialStore, CredentialWrite,
		StoreError, StoredCredentialSource,
	},
	id::{AccountId, PrincipalId},
};
use omp_catalog::AuthSpecId;
use omp_core::{ExposeSecret as _, Hash32, SecretBox, SecretString, Str};
use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, Zeroizing};

/// Opaque session-safe affinity. It contains no token, key, header, or URL.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct AuthAffinity {
	/// Encrypted-store account identity.
	pub account:   AccountId,
	/// Authenticated profile/principal identity.
	pub principal: PrincipalId,
}

/// Complete renewable MCP OAuth record retained in one encrypted store row.
pub(crate) struct StoredMcpOAuthCredential {
	/// Current access token.
	pub access_token:   SecretString,
	/// Renewable token retained across restart.
	pub refresh_token:  Option<SecretString>,
	/// Discovered token endpoint.
	pub token_endpoint: Str,
	/// Explicit or dynamically registered client identity.
	pub client_id:      Str,
	/// Optional confidential client material.
	pub client_secret:  Option<SecretString>,
	/// RFC 8707 resource indicator.
	pub resource:       Option<Str>,
	/// Absolute access-token expiration.
	pub expires_at_ms:  Option<u64>,
	/// Encrypted-store generation.
	pub generation:     u64,
}

#[derive(Serialize)]
struct StoredMcpOAuthCredentialRef<'a> {
	access_token:   &'a str,
	refresh_token:  Option<&'a str>,
	token_endpoint: &'a str,
	client_id:      &'a str,
	client_secret:  Option<&'a str>,
	resource:       Option<&'a str>,
	expires_at_ms:  Option<u64>,
}

#[derive(Deserialize, Zeroize)]
struct StoredMcpOAuthCredentialOwned {
	access_token:   String,
	refresh_token:  Option<String>,
	token_endpoint: String,
	client_id:      String,
	client_secret:  Option<String>,
	resource:       Option<String>,
	expires_at_ms:  Option<u64>,
}

/// Shared provider+MCP lease and refresh boundary.
///
/// Consumers receive only sealed [`CredentialLease`] values. Refresh first
/// rejects the observed generation with typed evidence, then reacquires the
/// same opaque affinity; token bytes never cross this trait.
pub trait CredentialAuthority: CredentialSource {
	/// Issues a provider lease from the combined encrypted store.
	fn provider_lease(
		&self,
		need: CredentialNeed,
	) -> CredentialFuture<'_, Result<CredentialLease, CredentialError>>;

	/// Issues an MCP lease pinned to session-safe affinity.
	fn mcp_lease<'a>(
		&'a self,
		affinity: &'a AuthAffinity,
		valid_after: SystemTime,
	) -> BoxFuture<'a, Result<CredentialLease, CredentialError>>;

	/// Rejects and refreshes one observed MCP generation.
	fn refresh_mcp<'a>(
		&'a self,
		affinity: &'a AuthAffinity,
		rejected: &'a CredentialLease,
		evidence: AuthRejection,
		valid_after: SystemTime,
	) -> BoxFuture<'a, Result<CredentialLease, CredentialError>>;
}

/// One provider+MCP encrypted credential authority.
///
/// Provider and MCP leases traverse the same [`CredentialStore`] and sealed
/// [`CredentialLease`] type; MCP never receives a plaintext token accessor.
#[derive(Clone)]
pub struct CombinedAuthAuthority {
	store:  Arc<CredentialStore>,
	stored: StoredCredentialSource,
}

impl CombinedAuthAuthority {
	/// Composes both credential domains over one already-open encrypted store.
	pub fn new(store: Arc<CredentialStore>) -> Self {
		Self { stored: StoredCredentialSource::new(store.clone()), store }
	}

	/// Issues a provider lease through the shared encrypted-store source.
	pub async fn provider_lease(
		&self,
		need: CredentialNeed,
	) -> Result<CredentialLease, CredentialError> {
		self.stored.lease(need).await
	}

	/// Derives a non-reversible account identity from profile and the configured
	/// MCP server URL. Mount display names never participate, so renaming a
	/// mount preserves its grant while changing its endpoint cannot reuse one.
	pub fn mcp_affinity(profile: &str, server_url: &str, principal: PrincipalId) -> AuthAffinity {
		let mut hasher = Hash32::hasher();
		hasher.update(b"omp-mcp-affinity/v1\0");
		hasher.update(profile.as_bytes());
		hasher.update(b"\0");
		hasher.update(server_url.as_bytes());
		let digest = hasher.finalize();
		AuthAffinity { account: AccountId::new(format!("mcp/{}", digest.to_hex())), principal }
	}

	/// Atomically imports or rotates one MCP bearer token at the sole secret
	/// ingress boundary.
	pub fn persist_mcp_bearer(
		&self,
		affinity: &AuthAffinity,
		token: SecretString,
		expires_at_ms: Option<u64>,
		now_ms: u64,
		expected_generation: Option<u64>,
	) -> Result<u64, StoreError> {
		self.persist_mcp_secret(affinity, "bearer", token, expires_at_ms, now_ms, expected_generation)
	}

	fn persist_mcp_secret(
		&self,
		affinity: &AuthAffinity,
		kind: &'static str,
		value: SecretString,
		expires_at_ms: Option<u64>,
		now_ms: u64,
		expected_generation: Option<u64>,
	) -> Result<u64, StoreError> {
		let secret = SecretBox::new(Box::new(value.expose_secret().as_bytes().to_vec()));
		let metadata = self.store.put(CredentialWrite {
			account_id: &affinity.account,
			principal_id: &affinity.principal,
			kind,
			secret: &secret,
			expires_at_ms,
			origin: CredentialOrigin::Persistent,
			now_ms,
			expected_generation,
		})?;
		Ok(metadata.generation)
	}

	/// Atomically persists one complete renewable MCP OAuth record.
	pub(crate) fn persist_mcp_oauth(
		&self,
		affinity: &AuthAffinity,
		credential: &StoredMcpOAuthCredential,
		now_ms: u64,
		expected_generation: Option<u64>,
	) -> Result<u64, McpOAuthStoreError> {
		let encoded = serde_json::to_vec(&StoredMcpOAuthCredentialRef {
			access_token:   credential.access_token.expose_secret(),
			refresh_token:  credential
				.refresh_token
				.as_ref()
				.map(|secret| secret.expose_secret()),
			token_endpoint: credential.token_endpoint.as_str(),
			client_id:      credential.client_id.as_str(),
			client_secret:  credential
				.client_secret
				.as_ref()
				.map(|secret| secret.expose_secret()),
			resource:       credential.resource.as_deref(),
			expires_at_ms:  credential.expires_at_ms,
		})
		.map_err(|_| McpOAuthStoreError::InvalidRecord)?;
		let secret = SecretBox::new(Box::new(encoded));
		let metadata = self.store.put(CredentialWrite {
			account_id: &affinity.account,
			principal_id: &affinity.principal,
			kind: "mcp-oauth",
			secret: &secret,
			expires_at_ms: credential.expires_at_ms,
			origin: CredentialOrigin::Persistent,
			now_ms,
			expected_generation,
		})?;
		Ok(metadata.generation)
	}

	/// Loads and audits one complete renewable MCP OAuth record.
	pub(crate) fn load_mcp_oauth(
		&self,
		affinity: &AuthAffinity,
	) -> Result<Option<StoredMcpOAuthCredential>, McpOAuthStoreError> {
		let Some(metadata) = self.store.metadata(&affinity.account)? else {
			return Ok(None);
		};
		if metadata.kind.as_str() != "mcp-oauth" {
			return Ok(None);
		}
		let digest = Hash32::sum(affinity.account.as_str().as_bytes());
		let mut prefix = [0_u8; 8];
		prefix.copy_from_slice(&digest.as_bytes()[..8]);
		let host_generation = u64::from_le_bytes(prefix) & i64::MAX as u64;
		prefix.copy_from_slice(&digest.as_bytes()[8..16]);
		let request_id = (u64::from_le_bytes(prefix) ^ metadata.generation) & i64::MAX as u64;
		let audit = AuditedCredentialReveal {
			extension: Str::new_static("envd-mcp-oauth"),
			caller_principal: Str::from(affinity.principal.as_str()),
			provider: Str::new_static("mcp"),
			host_generation,
			session_generation: 1,
			request_id,
			reason: Str::new_static("load renewable MCP OAuth state"),
		};
		let decoded = self
			.store
			.with_audited_secret(&affinity.account, &audit, |secret| {
				secret.expose(|bytes| serde_json::from_slice::<StoredMcpOAuthCredentialOwned>(bytes))
			})?;
		let decoded = decoded.map_err(|_| McpOAuthStoreError::InvalidRecord)?;
		let mut decoded = Zeroizing::new(decoded);
		Ok(Some(StoredMcpOAuthCredential {
			access_token:   SecretString::from(mem::take(&mut decoded.access_token)),
			refresh_token:  mem::take(&mut decoded.refresh_token).map(SecretString::from),
			token_endpoint: Str::from(mem::take(&mut decoded.token_endpoint)),
			client_id:      Str::from(mem::take(&mut decoded.client_id)),
			client_secret:  mem::take(&mut decoded.client_secret).map(SecretString::from),
			resource:       mem::take(&mut decoded.resource).map(Str::from),
			expires_at_ms:  decoded.expires_at_ms,
			generation:     metadata.generation,
		}))
	}

	/// Deletes every stored secret for one MCP affinity.
	pub fn delete_mcp(&self, affinity: &AuthAffinity) -> Result<bool, StoreError> {
		self.store.delete(&affinity.account)
	}

	/// Issues an MCP bearer lease pinned to opaque affinity and minimum expiry.
	pub async fn mcp_lease(
		&self,
		affinity: &AuthAffinity,
		valid_after: SystemTime,
	) -> Result<CredentialLease, CredentialError> {
		self
			.stored
			.lease(CredentialNeed {
				spec: AuthSpecId::from(Str::new_static("mcp")),
				account: Some(affinity.account.clone()),
				principal: Some(affinity.principal.clone()),
				valid_after,
			})
			.await
	}
}

impl CredentialAuthority for CombinedAuthAuthority {
	fn provider_lease(
		&self,
		need: CredentialNeed,
	) -> CredentialFuture<'_, Result<CredentialLease, CredentialError>> {
		self.stored.lease(need)
	}

	fn mcp_lease<'a>(
		&'a self,
		affinity: &'a AuthAffinity,
		valid_after: SystemTime,
	) -> BoxFuture<'a, Result<CredentialLease, CredentialError>> {
		Box::pin(async move { CombinedAuthAuthority::mcp_lease(self, affinity, valid_after).await })
	}

	fn refresh_mcp<'a>(
		&'a self,
		affinity: &'a AuthAffinity,
		rejected: &'a CredentialLease,
		evidence: AuthRejection,
		valid_after: SystemTime,
	) -> BoxFuture<'a, Result<CredentialLease, CredentialError>> {
		Box::pin(async move {
			self.stored.reject(rejected, evidence).await?;
			CombinedAuthAuthority::mcp_lease(self, affinity, valid_after).await
		})
	}
}

impl CredentialSource for CombinedAuthAuthority {
	fn lease(
		&self,
		need: CredentialNeed,
	) -> CredentialFuture<'_, Result<CredentialLease, CredentialError>> {
		self.stored.lease(need)
	}

	fn reject<'a>(
		&'a self,
		lease: &'a CredentialLease,
		evidence: AuthRejection,
	) -> CredentialFuture<'a, Result<(), CredentialError>> {
		self.stored.reject(lease, evidence)
	}
}

/// Complete MCP OAuth record persistence failure.
#[derive(Debug, thiserror::Error)]
pub enum McpOAuthStoreError {
	/// Encrypted credential store operation failed.
	#[error(transparent)]
	Store(#[from] StoreError),
	/// Persisted record could not be decoded safely.
	#[error("persisted MCP OAuth credential is malformed")]
	InvalidRecord,
}

impl fmt::Debug for CombinedAuthAuthority {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter.write_str("CombinedAuthAuthority(..)")
	}
}

#[cfg(test)]
mod tests {
	use omp_ai::auth::{CredentialKind, HeadlessKeySource, KeyId};

	use super::*;

	#[tokio::test]
	async fn provider_and_mcp_leases_share_one_encrypted_store() {
		let directory = tempfile::tempdir().expect("credential directory");
		let keys = Arc::new(HeadlessKeySource::new(KeyId::new("test-key"), [7; 32]));
		let store = Arc::new(
			CredentialStore::open(directory.path().join("credentials.sqlite3"), keys)
				.expect("credential store"),
		);
		let authority = CombinedAuthAuthority::new(store);
		let affinity = CombinedAuthAuthority::mcp_affinity(
			"work",
			"https://mcp.example/tenant?token=never-persist-this",
			PrincipalId::from("profile"),
		);
		assert!(!affinity.account.as_str().contains("mcp.example"));
		authority
			.persist_mcp_bearer(&affinity, SecretString::from("opaque-token"), None, 1, None)
			.expect("persist bearer");
		let mcp = authority
			.mcp_lease(&affinity, SystemTime::UNIX_EPOCH)
			.await
			.expect("MCP lease");
		let provider = authority
			.provider_lease(CredentialNeed {
				spec:        AuthSpecId::from("provider"),
				account:     Some(affinity.account.clone()),
				principal:   Some(affinity.principal.clone()),
				valid_after: SystemTime::UNIX_EPOCH,
			})
			.await
			.expect("provider lease");
		assert_eq!(mcp.kind(), CredentialKind::Bearer);
		assert_eq!(mcp.meta(), provider.meta());
	}

	#[test]
	fn renewable_oauth_record_survives_authority_reopen_complete() {
		let directory = tempfile::tempdir().expect("credential directory");
		let keys = Arc::new(HeadlessKeySource::new(KeyId::new("test-key"), [9; 32]));
		let path = directory.path().join("credentials.sqlite3");
		let authority = CombinedAuthAuthority::new(Arc::new(
			CredentialStore::open(&path, keys.clone()).expect("credential store"),
		));
		let affinity = CombinedAuthAuthority::mcp_affinity(
			"default",
			"restartable",
			PrincipalId::from("default"),
		);
		let generation = authority
			.persist_mcp_oauth(
				&affinity,
				&StoredMcpOAuthCredential {
					access_token:   SecretString::from("access"),
					refresh_token:  Some(SecretString::from("refresh")),
					token_endpoint: Str::from("https://auth.example/token"),
					client_id:      Str::from("client"),
					client_secret:  Some(SecretString::from("secret")),
					resource:       Some(Str::from("https://mcp.example")),
					expires_at_ms:  Some(42),
					generation:     0,
				},
				1,
				None,
			)
			.expect("persist OAuth");
		drop(authority);

		let reopened = CombinedAuthAuthority::new(Arc::new(
			CredentialStore::open(path, keys).expect("reopen credential store"),
		));
		let credential = reopened
			.load_mcp_oauth(&affinity)
			.expect("load OAuth")
			.expect("stored OAuth");
		assert_eq!(credential.generation, generation);
		assert_eq!(credential.access_token.expose_secret(), "access");
		assert_eq!(
			credential
				.refresh_token
				.as_ref()
				.expect("refresh")
				.expose_secret(),
			"refresh"
		);
		assert_eq!(credential.token_endpoint, "https://auth.example/token");
		assert_eq!(credential.client_id, "client");
		assert_eq!(
			credential
				.client_secret
				.as_ref()
				.expect("client secret")
				.expose_secret(),
			"secret"
		);
		assert_eq!(credential.resource.as_deref(), Some("https://mcp.example"));
	}

	#[test]
	fn affinity_is_profile_and_server_url_scoped() {
		let principal = PrincipalId::from("default");
		let first = CombinedAuthAuthority::mcp_affinity(
			"default",
			"https://mcp.example/one",
			principal.clone(),
		);
		let same = CombinedAuthAuthority::mcp_affinity(
			"default",
			"https://mcp.example/one",
			principal.clone(),
		);
		let other_url = CombinedAuthAuthority::mcp_affinity(
			"default",
			"https://mcp.example/two",
			principal.clone(),
		);
		let other_profile =
			CombinedAuthAuthority::mcp_affinity("work", "https://mcp.example/one", principal);
		assert_eq!(first, same);
		assert_ne!(first, other_url);
		assert_ne!(first, other_profile);
	}

	#[tokio::test]
	async fn deleting_mcp_credential_removes_it_from_the_shared_store() {
		let directory = tempfile::tempdir().expect("credential directory");
		let keys = Arc::new(HeadlessKeySource::new(KeyId::new("test-key"), [7; 32]));
		let store = Arc::new(
			CredentialStore::open(directory.path().join("credentials.sqlite3"), keys)
				.expect("credential store"),
		);
		let authority = CombinedAuthAuthority::new(store);
		let affinity = CombinedAuthAuthority::mcp_affinity(
			"default",
			"https://mcp.example/server",
			PrincipalId::from("default"),
		);
		authority
			.persist_mcp_bearer(&affinity, SecretString::from("opaque-token"), None, 1, None)
			.expect("persist bearer");

		assert!(authority.delete_mcp(&affinity).expect("delete bearer"));
		assert!(
			authority
				.mcp_lease(&affinity, SystemTime::UNIX_EPOCH)
				.await
				.is_err(),
			"deleted MCP credential must not remain leasable",
		);
		assert!(
			!authority
				.delete_mcp(&affinity)
				.expect("delete absent bearer")
		);
	}
}
