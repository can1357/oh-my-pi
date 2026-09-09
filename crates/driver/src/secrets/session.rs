use std::{path::Path, sync::Arc};

use omp_secrets::{
	builtins::{credential_rules, placeholder_key_rule},
	obfuscator::SecretObfuscator,
	placeholder::rules_need_placeholder_key,
	rule::{SecretRule, SecretRuleError},
};
use parking_lot::{Mutex, MutexGuard};
use thiserror::Error;

use super::{
	config::{SecretConfigError, load_secret_rules},
	env::collect_env_secret_rules,
	key,
};

/// One immutable rule-generation snapshot with session-local reversible
/// mappings.
#[derive(Clone, Debug)]
pub struct SecretSessionSnapshot {
	generation: u64,
	rules:      Arc<[SecretRule]>,
	transform:  Arc<Mutex<SecretObfuscator>>,
}

impl SecretSessionSnapshot {
	/// Builds a snapshot at an explicit configuration or extension-activation
	/// boundary.
	pub fn build(
		generation: u64,
		global_config: &Path,
		project_config: &Path,
		sealed_extension_rules: impl IntoIterator<Item = SecretRule>,
	) -> Result<Self, SecretSessionError> {
		let mut configured = load_secret_rules(global_config, project_config)?;
		configured.extend(sealed_extension_rules);
		configured.extend(collect_env_secret_rules());
		let needs_key = rules_need_placeholder_key(&configured);
		let mut rules = configured;
		rules.extend(credential_rules()?);
		if !needs_key && let Ok(Some(existing_key)) = omp_cache::secret_key::read_without_create() {
			rules.push(placeholder_key_rule(&existing_key)?);
		}
		let transform = if needs_key {
			SecretObfuscator::new(rules.clone(), key::placeholder_key())
		} else {
			SecretObfuscator::with_lazy_key(rules.clone(), || key::placeholder_key().to_owned())
		};
		Ok(Self { generation, rules: Arc::from(rules), transform: Arc::new(Mutex::new(transform)) })
	}

	/// Returns the boundary generation that sealed this snapshot.
	pub const fn generation(&self) -> u64 {
		self.generation
	}

	/// Returns the complete ordered rule snapshot.
	pub fn rules(&self) -> &[SecretRule] {
		&self.rules
	}

	/// Locks the session-local transform state.
	pub fn transform(&self) -> MutexGuard<'_, SecretObfuscator> {
		self.transform.lock()
	}

	/// Returns the shared session transform for provider and agent-loop wiring.
	pub fn transform_handle(&self) -> Arc<Mutex<SecretObfuscator>> {
		Arc::clone(&self.transform)
	}
}

/// Failure to assemble a secret session snapshot.
#[derive(Debug, Error)]
pub enum SecretSessionError {
	/// Configuration loading failed.
	#[error(transparent)]
	Config(#[from] SecretConfigError),
	/// A built-in rule failed validation.
	#[error("invalid Core-owned secret rule")]
	Builtin(#[from] SecretRuleError),
}
