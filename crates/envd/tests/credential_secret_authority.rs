//! Proves masking ownership, audited credential reveal, and request-bound
//! scoped tokens.
use std::{
	sync::Arc,
	time::{Duration, SystemTime, UNIX_EPOCH},
};

use omp_ai::{
	auth::{
		AuditedCredentialReveal, CredentialOrigin, CredentialStore, CredentialWrite,
		HeadlessKeySource, KeyId, ScopedCredentialGrant, StoreError,
	},
	id::{AccountId, PrincipalId},
};
use omp_core::{ExposeSecret as _, SecretBox, Str};
use omp_secrets::{
	SecretMaskingAuthority, SecretMaskingError,
	rule::{SecretKind, SecretMode, SecretRule},
};

fn store() -> (tempfile::TempDir, CredentialStore, AccountId) {
	let directory = tempfile::tempdir().expect("tempdir");
	let keys = Arc::new(HeadlessKeySource::new(KeyId::new("control-test"), [0x51; 32]));
	let store = CredentialStore::open(directory.path().join("credentials.db"), keys)
		.expect("credential store");
	let account = AccountId::from("provider:account");
	let principal = PrincipalId::from("credential-principal");
	let secret = SecretBox::new(b"credential-secret".to_vec().into_boxed_slice());
	store
		.put(CredentialWrite {
			account_id:          &account,
			principal_id:        &principal,
			kind:                "api_key",
			secret:              &secret,
			expires_at_ms:       None,
			origin:              CredentialOrigin::Persistent,
			now_ms:              1,
			expected_generation: None,
		})
		.expect("store credential");
	(directory, store, account)
}

#[test]
fn masking_is_owner_generation_fenced_and_seals_on_first_use() {
	let authority = SecretMaskingAuthority::new("dev.extension", 7, [], "placeholder-key")
		.expect("masking authority");
	let rule = SecretRule::new(
		SecretKind::Plain,
		SecretMode::Obfuscate,
		"credential-secret",
		None,
		None,
		Some(Str::new_static("credential")),
	)
	.expect("secret rule");
	authority
		.declare("dev.extension", 7, rule)
		.expect("declare");
	assert_eq!(
		authority.mask("other.extension", 7, "credential-secret"),
		Err(SecretMaskingError::OwnerMismatch)
	);
	assert!(
		authority
			.mask("dev.extension", 7, "credential-secret")
			.expect("mask")
			.starts_with("$$CREDENTIAL_")
	);
	let late = SecretRule::new(
		SecretKind::Plain,
		SecretMode::Replace,
		"another-secret",
		Some(Str::new_static("[redacted]")),
		None,
		None,
	)
	.expect("late rule");
	assert_eq!(authority.declare("dev.extension", 7, late), Err(SecretMaskingError::Sealed));
}

#[test]
fn reveal_commits_bound_audit_before_temporary_exposure() {
	let (_directory, store, account) = store();
	let audit = AuditedCredentialReveal {
		extension:          Str::new_static("dev.extension"),
		caller_principal:   Str::new_static("daemon-principal"),
		provider:           Str::new_static("provider"),
		host_generation:    9,
		session_generation: 4,
		request_id:         31,
		reason:             Str::new_static("extension_control_reveal"),
	};
	let observed = store
		.with_audited_secret(&account, &audit, |secret| {
			secret.expose(|bytes| bytes == b"credential-secret")
		})
		.expect("audited reveal");
	assert!(observed);
	let mut conflicting = audit.clone();
	conflicting.provider = Str::new_static("other-provider");
	assert!(matches!(
		store.with_audited_secret(&account, &conflicting, |_| ()),
		Err(StoreError::RevealAuditConflict)
	));
}

#[test]
fn scoped_tokens_are_durable_idempotent_and_request_bound() {
	let (_directory, store, account) = store();
	let now_ms = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.expect("clock")
		.as_millis() as u64;
	let grant = ScopedCredentialGrant {
		extension:          Str::new_static("dev.extension"),
		caller_principal:   Str::new_static("daemon-principal"),
		provider:           Str::new_static("provider"),
		facet:              Str::new_static("realtime"),
		host_generation:    9,
		session_generation: 4,
		request_id:         32,
		expires_at_ms:      now_ms + Duration::from_secs(60).as_millis() as u64,
	};
	let first = store
		.mint_scoped_token(&account, &grant)
		.expect("first token");
	let replay = store
		.mint_scoped_token(&account, &grant)
		.expect("replayed token");
	assert_eq!(first.token.expose_secret(), replay.token.expose_secret());
	let mut conflicting = grant;
	conflicting.facet = Str::new_static("different");
	assert!(matches!(
		store.mint_scoped_token(&account, &conflicting),
		Err(StoreError::InvalidScopedGrant)
	));
}
