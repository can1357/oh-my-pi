//! Process-level secret policy and composition.

use std::{collections::BTreeMap, sync::Arc};

use omp_ai::auth::AuthControlHandle;
use omp_core::Str;
use omp_envd::worker::ExtHostSpec;
use omp_secrets::SecretMaskingAuthority;

use crate::auth_backend::{CredentialControlGrant, CredentialSecretControlFactory};

/// Global/project rule loading.
pub mod config;
/// Credential-shaped environment collection.
pub mod env;
/// Persistent placeholder-key resolution with a process-stable ephemeral
/// fallback.
pub mod key;
/// Immutable per-session snapshot composition.
pub mod session;
use session::SecretSessionSnapshot;

/// Lowers deployment-admitted credential scopes into the exact Core-side
/// grants consumed by the credential CONTROL factory.
pub fn credential_control_grants(
	extensions: &[ExtHostSpec],
) -> BTreeMap<Str, CredentialControlGrant> {
	use omp_ai::auth::{CredentialGrants, CredentialScope};

	fn scope(value: Option<&serde_json::Value>) -> Arc<[Str]> {
		match value {
			Some(serde_json::Value::String(value)) => Arc::from([Str::new(value)]),
			Some(serde_json::Value::Array(values)) => values
				.iter()
				.filter_map(serde_json::Value::as_str)
				.map(Str::new)
				.collect::<Vec<_>>()
				.into(),
			_ => Arc::from([]),
		}
	}

	extensions
		.iter()
		.map(|extension| {
			let declarations = extension.manifest.static_declarations();
			let allow = scope(declarations.capability_grants.get("credentials.allow"));
			let import = scope(declarations.capability_grants.get("credentials.import"));
			let reveal = scope(declarations.capability_grants.get("credentials.reveal"));
			let providers = allow
				.iter()
				.filter(|provider| !provider.contains('*') && !provider.contains('?'))
				.cloned()
				.collect::<Vec<_>>()
				.into();
			(extension.key.extension().clone(), CredentialControlGrant {
				grants: CredentialGrants {
					allow:  CredentialScope::new(allow),
					import: CredentialScope::new(import),
					reveal: CredentialScope::new(reveal),
				},
				providers,
			})
		})
		.collect()
}

/// Builds one Core-owned masking authority over the immutable session rules.
pub fn core_secret_masking_authority(
	snapshot: &SecretSessionSnapshot,
	extension: impl Into<Str>,
	host_generation: u64,
) -> Result<Arc<SecretMaskingAuthority>, omp_secrets::SecretMaskingError> {
	SecretMaskingAuthority::new(
		extension,
		host_generation,
		snapshot.rules().iter().cloned(),
		key::placeholder_key(),
	)
	.map(Arc::new)
}

/// Composes the live auth handle and Core masking snapshot into the CONTROL
/// domain factory consumed by Environment authority wiring.
pub fn credential_secret_control_factory(
	control: AuthControlHandle,
	grants: BTreeMap<Str, CredentialControlGrant>,
	snapshot: &SecretSessionSnapshot,
) -> CredentialSecretControlFactory {
	CredentialSecretControlFactory::new(
		control,
		grants,
		Arc::from(snapshot.rules().to_vec()),
		Arc::<str>::from(key::placeholder_key()),
	)
}
