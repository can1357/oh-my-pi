use std::sync::LazyLock;

use rand::RngExt as _;
use zeroize::{Zeroize as _, Zeroizing};

static PLACEHOLDER_KEY: LazyLock<String> = LazyLock::new(resolve_key);

/// Returns the persistent placeholder key or one process-stable ephemeral
/// fallback.
///
/// Persistence failure never blocks a headless session, but the warning makes
/// the loss of cross-restart restoration explicit and actionable.
pub fn placeholder_key() -> &'static str {
	PLACEHOLDER_KEY.as_str()
}

fn resolve_key() -> String {
	match omp_cache::secret_key::load_or_create() {
		Ok(key) => key,
		Err(error) => {
			let path = omp_cache::secret_key::native_path()
				.map_or_else(|_| "<unresolved>".into(), |path| path.display().to_string());
			tracing::warn!(
				%error,
				%path,
				"could not persist the secret placeholder key; using one process-ephemeral key, so placeholders cannot be restored after restart; make the state directory owner-writable"
			);
			ephemeral_key()
		},
	}
}

fn ephemeral_key() -> String {
	let mut bytes = Zeroizing::new(rand::rng().random::<[u8; 32]>());
	let key = omp_core::base64_url::encode_raw(&*bytes).into_string();
	bytes.zeroize();
	key
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn ephemeral_generation_is_valid_key_material() {
		let key = ephemeral_key();
		assert_eq!(key.len(), 43);
		assert_eq!(
			omp_core::base64_url::decode_raw(&key)
				.into_vec()
				.expect("base64url")
				.len(),
			32
		);
	}
}
