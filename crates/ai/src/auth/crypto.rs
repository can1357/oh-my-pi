//! Authenticated encryption for persisted credential material.

use std::fmt;

use omp_core::{ExposeSecret, SecretBox};
use ring::{
	aead,
	rand::{SecureRandom, SystemRandom},
};
use thiserror::Error;
use zeroize::Zeroize;

use super::key::{EncryptionKey, KeyId};

const NONCE_BYTES: usize = 12;
const AAD_DOMAIN: &[u8] = b"omp-inference/credential/v1";

/// Non-secret record identity authenticated with an encrypted blob.
pub(crate) struct SecretContext<'a> {
	/// Account owning the secret.
	pub(crate) account_id:    &'a str,
	/// Principal identity cryptographically bound to the secret.
	pub(crate) principal_id:  &'a str,
	/// Credential kind stored in metadata.
	pub(crate) kind:          &'a str,
	/// Monotonic credential generation.
	pub(crate) generation:    u64,
	/// Expiry metadata cryptographically bound to the secret.
	pub(crate) expires_at_ms: Option<u64>,
	/// Creation timestamp cryptographically bound to the secret.
	pub(crate) created_at_ms: u64,
	/// Update timestamp cryptographically bound to the secret.
	pub(crate) updated_at_ms: u64,
}

/// Authenticated-encrypted bytes and the key needed to open them.
pub(crate) struct EncryptedBlob {
	/// Identifier of the encryption key.
	pub(crate) key_id:     KeyId,
	/// Unique nonce generated for this encryption operation.
	pub(crate) nonce:      [u8; NONCE_BYTES],
	/// Ciphertext with its authentication tag.
	pub(crate) ciphertext: Vec<u8>,
}

impl fmt::Debug for EncryptedBlob {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("EncryptedBlob")
			.field("key_id", &self.key_id)
			.field("nonce", &"[NON-SECRET UNIQUE VALUE]")
			.field("ciphertext_len", &self.ciphertext.len())
			.finish()
	}
}

/// Failure while sealing or opening a credential secret.
#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
pub enum CryptoError {
	/// Secure random generation failed.
	#[error("secure random generation failed")]
	Random,
	/// Key construction failed.
	#[error("credential encryption key is invalid")]
	InvalidKey,
	/// Ciphertext, nonce, key, or authenticated metadata did not authenticate.
	#[error("credential secret authentication failed")]
	AuthenticationFailed,
	/// Authenticated metadata was too large to encode.
	#[error("credential metadata is too large")]
	MetadataTooLarge,
}

/// Seals secret bytes using AES-256-GCM and fresh random nonces.
pub(crate) fn encrypt<S>(
	key: &EncryptionKey,
	context: SecretContext<'_>,
	plaintext: &SecretBox<S>,
) -> Result<EncryptedBlob, CryptoError>
where
	S: AsRef<[u8]> + Zeroize + ?Sized,
{
	let key_id = key.id().clone();
	let mut nonce = [0_u8; NONCE_BYTES];
	SystemRandom::new()
		.fill(&mut nonce)
		.map_err(|_| CryptoError::Random)?;
	let aad = authenticated_metadata(context)?;
	let unbound = aead::UnboundKey::new(&aead::AES_256_GCM, key.bytes())
		.map_err(|_| CryptoError::InvalidKey)?;
	let sealing_key = aead::LessSafeKey::new(unbound);
	let mut ciphertext = plaintext.expose_secret().as_ref().to_vec();
	if sealing_key
		.seal_in_place_append_tag(
			aead::Nonce::assume_unique_for_key(nonce),
			aead::Aad::from(aad),
			&mut ciphertext,
		)
		.is_err()
	{
		ciphertext.zeroize();
		return Err(CryptoError::InvalidKey);
	}
	Ok(EncryptedBlob { key_id, nonce, ciphertext })
}

/// Opens and authenticates a persisted secret.
pub(crate) fn decrypt(
	key: &EncryptionKey,
	context: SecretContext<'_>,
	blob: &EncryptedBlob,
) -> Result<SecretBox<Vec<u8>>, CryptoError> {
	if blob.key_id != *key.id() {
		return Err(CryptoError::AuthenticationFailed);
	}
	let aad = authenticated_metadata(context)?;
	let unbound = aead::UnboundKey::new(&aead::AES_256_GCM, key.bytes())
		.map_err(|_| CryptoError::InvalidKey)?;
	let key = aead::LessSafeKey::new(unbound);
	let mut plaintext = blob.ciphertext.clone();
	let opened = key.open_in_place(
		aead::Nonce::assume_unique_for_key(blob.nonce),
		aead::Aad::from(aad),
		&mut plaintext,
	);
	let length = if let Ok(bytes) = opened {
		bytes.len()
	} else {
		plaintext.zeroize();
		return Err(CryptoError::AuthenticationFailed);
	};
	plaintext[length..].zeroize();
	plaintext.truncate(length);
	Ok(SecretBox::new(Box::new(plaintext)))
}

fn authenticated_metadata(context: SecretContext<'_>) -> Result<Vec<u8>, CryptoError> {
	let account_len =
		u32::try_from(context.account_id.len()).map_err(|_| CryptoError::MetadataTooLarge)?;
	let principal_len =
		u32::try_from(context.principal_id.len()).map_err(|_| CryptoError::MetadataTooLarge)?;
	let kind_len = u32::try_from(context.kind.len()).map_err(|_| CryptoError::MetadataTooLarge)?;
	let mut aad = Vec::with_capacity(
		AAD_DOMAIN.len()
			+ 4 + context.account_id.len()
			+ 4 + context.principal_id.len()
			+ 4 + context.kind.len()
			+ 25,
	);
	aad.extend_from_slice(AAD_DOMAIN);
	aad.extend_from_slice(&account_len.to_be_bytes());
	aad.extend_from_slice(context.account_id.as_bytes());
	aad.extend_from_slice(&principal_len.to_be_bytes());
	aad.extend_from_slice(context.principal_id.as_bytes());
	aad.extend_from_slice(&kind_len.to_be_bytes());
	aad.extend_from_slice(context.kind.as_bytes());
	aad.extend_from_slice(&context.generation.to_be_bytes());
	if let Some(expires_at_ms) = context.expires_at_ms {
		aad.push(1);
		aad.extend_from_slice(&expires_at_ms.to_be_bytes());
	} else {
		aad.push(0);
		aad.extend_from_slice(&0_u64.to_be_bytes());
	}
	aad.extend_from_slice(&context.created_at_ms.to_be_bytes());
	aad.extend_from_slice(&context.updated_at_ms.to_be_bytes());
	Ok(aad)
}
