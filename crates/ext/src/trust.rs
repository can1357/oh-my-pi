//! Local grant, publisher-key, and revocation state.

use std::{collections::BTreeSet, fs, io, path::Path, str::FromStr as _};

use jiff::Timestamp;
use omp_core::{Hash32, Str, base64, encoding::hex, sf};
use ring::signature::{ED25519, UnparsedPublicKey};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::{
	ExtensionCode, ExtensionError, Layer, TrustTier, WorkspaceUri, lock::atomic_toml,
	resolver::version_satisfies,
};

/// Directory containment covered by an operator grant.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GrantScope {
	/// Only the workspace recorded on the grant.
	#[default]
	Exact,
	/// The recorded workspace and every workspace below it.
	Subtree,
}

/// Lifetime of an interactive operator grant.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GrantDuration {
	/// Admit only the current interactive attempt.
	Once,
	/// Admit for the remainder of the current process session.
	Session,
	/// Persist the grant for future sessions.
	#[default]
	Persistent,
}

/// An operator-originated capability grant.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct Grant {
	/// Extension identity.
	pub id:                Str,
	/// TOFU-pinned publisher fingerprint.
	pub publisher:         Str,
	/// Layer where the grant applies.
	pub layer:             Layer,
	/// Workspace identity, omitted for client-layer grants.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub workspace:         Option<WorkspaceUri>,
	/// Workspace containment covered by this grant.
	#[serde(default)]
	pub scope:             GrantScope,
	/// Hash of the canonical declared capability set.
	pub capability_digest: Str,
	/// Tier approved by the operator.
	pub tier:              TrustTier,
	/// Approved code-shipping level.
	pub ship:              Str,
	/// RFC 3339 timestamp.
	pub granted_at:        Str,
	/// Operator channel: interactive, flag, or env.
	pub granted_by:        Str,
	/// Lifetime selected by the operator.
	#[serde(default)]
	pub duration:          GrantDuration,
}

/// Local grant file, never committed with a workspace.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct GrantsFile {
	/// File format version.
	#[serde(default = "one")]
	pub version: u32,
	/// Durable grants.
	#[serde(rename = "grant", default)]
	pub grants:  Vec<Grant>,
}

/// Failure while committing an operator grant through the canonical grant
/// file writer.
#[derive(Debug, Error)]
pub enum GrantPersistenceError {
	/// Existing grant state could not be decoded.
	#[error("existing extension grants could not be read")]
	Read(#[source] ExtensionError),
	/// The atomically replaced grant file could not be written.
	#[error("extension grants could not be persisted")]
	Write(#[source] io::Error),
	/// A process-local grant was passed to the durable grant writer.
	#[error("session-only extension grants cannot be persisted")]
	SessionOnly,
}

/// Returns whether the most-specific applicable operator grant admits an
/// extension.
///
/// Workspace grants resolve from the requested workspace toward its ancestors.
/// An exact grant takes precedence over a subtree grant rooted at the same
/// workspace. Once a more-specific decision exists, a broader grant cannot
/// silently override changed publisher, capability, tier, or shipping facts.
#[tracing::instrument(
	name = "extension_grant_verify",
	level = "debug",
	skip_all,
	fields(extension_id = %id, layer = ?layer)
)]
pub fn grant_covers(
	grants: &GrantsFile,
	id: &Str,
	publisher: &Str,
	layer: Layer,
	workspace: Option<&WorkspaceUri>,
	capability_digest: &Str,
	tier: TrustTier,
	ship: &Str,
) -> bool {
	let Some(specificity) = grants
		.grants
		.iter()
		.filter(|grant| grant.id == *id && grant.layer == layer)
		.filter_map(|grant| grant_specificity(grant, workspace))
		.max()
	else {
		return false;
	};
	grants.grants.iter().any(|grant| {
		grant.id == *id
			&& grant.layer == layer
			&& grant_specificity(grant, workspace) == Some(specificity)
			&& grant.publisher == *publisher
			&& grant.capability_digest == *capability_digest
			&& grant.tier == tier
			&& grant.ship == *ship
	})
}

fn grant_specificity(grant: &Grant, workspace: Option<&WorkspaceUri>) -> Option<(usize, bool)> {
	match (grant.workspace.as_ref(), workspace, grant.scope) {
		(None, None, GrantScope::Exact) => Some((0, true)),
		(Some(granted), Some(requested), GrantScope::Exact) if granted == requested => {
			Some((granted.uri.len(), true))
		},
		(Some(granted), Some(requested), GrantScope::Subtree)
			if uri_contains(&granted.uri, &requested.uri) =>
		{
			Some((granted.uri.len(), false))
		},
		_ => None,
	}
}

fn uri_contains(parent: &str, child: &str) -> bool {
	parent == child
		|| child
			.strip_prefix(parent)
			.is_some_and(|suffix| parent.ends_with('/') || suffix.starts_with('/'))
}

/// A non-interactive grant request parsed from `OMP_EXT_GRANT`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GrantRequest {
	/// Extension id named by the operator.
	pub id:           Str,
	/// Explicit capabilities, or `*` for all declared capabilities.
	pub capabilities: BTreeSet<Str>,
	/// Explicit tier approval when supplied.
	pub tier:         Option<TrustTier>,
}

/// Parses the operator-only `OMP_EXT_GRANT` channel.
///
/// Each semicolon-separated entry is `id:cap,cap`, `id:*`, or
/// `id:tier=trusted`; malformed entries fail closed rather than silently
/// dropping an intended capability grant.
pub fn parse_grant_requests(value: &str) -> Result<Vec<GrantRequest>, ExtensionError> {
	value
		.split(';')
		.filter(|entry| !entry.is_empty())
		.map(|entry| {
			let (id, grants) = entry.split_once(':').ok_or_else(|| {
				ExtensionError::new(ExtensionCode::EGrantUnknown, "grant entry must be id:capability")
			})?;
			if id.is_empty() || grants.is_empty() {
				return Err(ExtensionError::new(
					ExtensionCode::EGrantUnknown,
					"grant entry has an empty id or capability",
				));
			}
			let mut capabilities = BTreeSet::new();
			let mut tier = None;
			for grant in grants.split(',') {
				if let Some(value) = grant.strip_prefix("tier=") {
					tier = Some(value.parse().map_err(|_| {
						ExtensionError::new(ExtensionCode::EGrantUnknown, "unknown grant tier")
					})?);
				} else if !grant.is_empty() {
					capabilities.insert(Str::new(grant));
				}
			}
			Ok(GrantRequest { id: Str::new(id), capabilities, tier })
		})
		.collect()
}

/// Returns whether a parsed environment request approves the declared
/// capability set. Unknown requested capabilities are an error, preserving the
/// `E-GRANT-UNKNOWN` typo defense.
pub fn validate_grant_request(
	request: &GrantRequest,
	declared: impl IntoIterator<Item = Str>,
) -> Result<bool, ExtensionError> {
	let declared: BTreeSet<Str> = declared.into_iter().collect();
	if request.capabilities.contains(&sf!("*")) {
		return Ok(true);
	}
	if !request.capabilities.is_subset(&declared) {
		return Err(ExtensionError::new(
			ExtensionCode::EGrantUnknown,
			"grant names an undeclared capability",
		));
	}
	Ok(request.capabilities == declared)
}

impl GrantsFile {
	/// Reads an absent local grant file as an empty durable grant set.
	///
	/// Process-local entries are ignored even if a hand-edited file contains
	/// one, so a session decision cannot become durable by serialization.
	pub fn read(path: &Path) -> Result<Self, ExtensionError> {
		let mut grants: Self = read_toml_or_default(path)?;
		grants
			.grants
			.retain(|grant| grant.duration == GrantDuration::Persistent);
		Ok(grants)
	}

	/// Atomically writes only durable grants to the local grant file.
	pub fn write(&self, path: &Path) -> io::Result<()> {
		let durable = Self {
			version: self.version,
			grants:  self
				.grants
				.iter()
				.filter(|grant| grant.duration == GrantDuration::Persistent)
				.cloned()
				.collect(),
		};
		atomic_toml(path, &durable)
	}

	/// Replaces the prior decision for one extension and atomically persists the
	/// operator's new durable grant.
	///
	/// This is the sole read-modify-write entry point for interactive consent;
	/// callers cannot accidentally update an in-memory copy without committing
	/// it through the trust domain's atomic writer.
	pub fn persist(path: &Path, grant: Grant) -> Result<Self, GrantPersistenceError> {
		if grant.duration != GrantDuration::Persistent {
			return Err(GrantPersistenceError::SessionOnly);
		}
		let mut grants = Self::read(path).map_err(GrantPersistenceError::Read)?;
		grants.grants.retain(|existing| {
			existing.id != grant.id
				|| existing.layer != grant.layer
				|| existing.workspace != grant.workspace
		});
		grants.grants.push(grant);
		grants.write(path).map_err(GrantPersistenceError::Write)?;
		Ok(grants)
	}
}

/// A TOFU-pinned publisher key.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct KeyPin {
	/// Extension identity protected by this pin.
	pub id:                 Str,
	/// Base64 Ed25519 public key.
	pub key:                Str,
	/// Exact version first seen under this key.
	pub introduced_version: Str,
	/// RFC 3339 pin timestamp.
	pub introduced_at:      Str,
}

/// Local TOFU key pins.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct KeysFile {
	/// File format version.
	#[serde(default = "one")]
	pub version: u32,
	/// One pin per extension identity.
	#[serde(rename = "key", default)]
	pub keys:    Vec<KeyPin>,
}

/// A publisher rotation signed by the currently pinned key.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct KeyRotation {
	/// Extension identity whose key rotates.
	pub id:        Str,
	/// New base64 Ed25519 public key.
	pub new_key:   Str,
	/// Detached base64 signature from the old key over `id\nnew_key`.
	pub signature: Str,
}

impl KeysFile {
	/// Reads an absent key file as an empty pin set.
	pub fn read(path: &Path) -> Result<Self, ExtensionError> {
		read_toml_or_default(path)
	}

	/// Atomically writes local key pins.
	pub fn write(&self, path: &Path) -> io::Result<()> {
		atomic_toml(path, self)
	}

	/// Records an operator-confirmed publisher key after validating its Ed25519
	/// shape. This is the only intentional bypass of TOFU continuity and is
	/// reserved for `omp ext trust --key`; ordinary installs must use
	/// [`Self::verify_or_pin`].
	pub fn accept_operator_key(
		&mut self,
		id: &Str,
		key: &Str,
		version: &Str,
		now: &Str,
	) -> Result<bool, ExtensionError> {
		validate_public_key(key.as_str())?;
		let replacement = KeyPin {
			id:                 id.clone(),
			key:                key.clone(),
			introduced_version: version.clone(),
			introduced_at:      now.clone(),
		};
		if let Some(pin) = self.keys.iter_mut().find(|pin| pin.id == *id) {
			let changed = pin != &replacement;
			*pin = replacement;
			Ok(changed)
		} else {
			self.keys.push(replacement);
			Ok(true)
		}
	}

	/// Pins a first-seen key, rejects a changed key, or accepts a rotation only
	/// when its signature verifies against the old pin.
	#[tracing::instrument(
		name = "extension_publisher_trust",
		level = "debug",
		skip_all,
		fields(extension_id = %id, rotation_provided = rotation.is_some())
	)]
	pub fn verify_or_pin(
		&mut self,
		id: &Str,
		key: &Str,
		version: &Str,
		now: &Str,
		rotation: Option<&KeyRotation>,
	) -> Result<Option<ExtensionCode>, ExtensionError> {
		let Some(pin) = self.keys.iter_mut().find(|pin| pin.id == *id) else {
			self.keys.push(KeyPin {
				id:                 id.clone(),
				key:                key.clone(),
				introduced_version: version.clone(),
				introduced_at:      now.clone(),
			});
			tracing::debug!("publisher key pinned");
			return Ok(None);
		};
		if pin.key == *key {
			tracing::debug!("publisher key matched existing pin");
			return Ok(None);
		}
		let Some(rotation) =
			rotation.filter(|rotation| rotation.id == *id && rotation.new_key == *key)
		else {
			return Err(ExtensionError::new(
				ExtensionCode::EKeyChanged,
				"publisher key changed without a signed rotation",
			));
		};
		verify_publisher_rotation(pin.key.as_str(), id, key.as_str(), rotation)?;
		pin.key.clone_from(key);
		tracing::info!("publisher key rotation verified");
		Ok(Some(ExtensionCode::WKeyRotated))
	}
}

/// Verifies publisher-key continuity against the exact previously pinned key.
#[tracing::instrument(
	name = "extension_publisher_rotation_verify",
	level = "debug",
	skip_all,
	fields(extension_id = %id)
)]
pub fn verify_publisher_rotation(
	current_key: &str,
	id: &Str,
	new_key: &str,
	rotation: &KeyRotation,
) -> Result<(), ExtensionError> {
	(|| {
		if rotation.id != *id || rotation.new_key != new_key {
			return Err(ExtensionError::new(
				ExtensionCode::EKeyChanged,
				"publisher key changed without a matching signed rotation",
			));
		}
		verify_signature(
			current_key,
			format!("{}\n{}", rotation.id, rotation.new_key).as_bytes(),
			rotation.signature.as_str(),
		)
	})()
}
/// A revoked extension version predicate. Version matching is deliberately
/// delegated to the resolver; materialization compares exact lock versions.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct RevokedVersion {
	/// Extension id.
	pub id:       Str,
	/// Revoked PEP 440 version expression.
	pub versions: Str,
	/// Security rationale.
	pub reason:   Str,
	/// Advisory URL.
	pub advisory: String,
}

/// Signed revocation snapshot.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct RevocationsFile {
	/// File format version.
	pub version:     u32,
	/// RFC 3339 issuance timestamp.
	pub issued_at:   Str,
	/// RFC 3339 expiry timestamp.
	pub valid_until: Str,
	/// Revoked extension versions.
	pub revoked:     Vec<RevokedVersion>,
	/// Index signature over the canonical unsigned JSON payload.
	pub signature:   Str,
}

/// Staleness decision for a locally cached revocation snapshot.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RevocationFreshness {
	/// Snapshot is still current.
	Fresh,
	/// Snapshot is stale but ordinary offline mode proceeds with warning.
	Warn(ExtensionCode),
	/// Strict offline mode refuses stale state.
	Reject(ExtensionCode),
}

impl RevocationsFile {
	/// Reads a signed JSON revocation snapshot.
	#[tracing::instrument(
		name = "extension_revocations_load",
		level = "debug",
		skip_all,
		fields(path = %path.display())
	)]
	pub fn read(path: &Path) -> Result<Self, ExtensionError> {
		let result = fs::read(path)
			.map_err(|error| ExtensionError::new(ExtensionCode::ERevoked, error.to_string()))
			.and_then(|data| {
				serde_json::from_slice::<Self>(&data)
					.map_err(|error| ExtensionError::new(ExtensionCode::ERevoked, error.to_string()))
			});
		if let Ok(revocations) = &result {
			tracing::debug!(
				cache_hit = true,
				revocation_count = revocations.revoked.len(),
				"extension revocation cache loaded"
			);
		}
		result
	}

	/// Verifies the index signature over the canonical unsigned snapshot.
	#[tracing::instrument(
		name = "extension_revocations_verify",
		level = "debug",
		skip_all,
		fields(revocation_count = self.revoked.len())
	)]
	pub fn verify(&self, index_key: &str) -> Result<(), ExtensionError> {
		#[derive(Serialize)]
		struct Unsigned<'a> {
			version:     u32,
			issued_at:   &'a Str,
			valid_until: &'a Str,
			revoked:     &'a [RevokedVersion],
		}

		serde_json::to_vec(&Unsigned {
			version:     self.version,
			issued_at:   &self.issued_at,
			valid_until: &self.valid_until,
			revoked:     &self.revoked,
		})
		.map_err(|error| ExtensionError::new(ExtensionCode::ESig, error.to_string()))
		.and_then(|payload| verify_signature(index_key, &payload, self.signature.as_str()))
	}

	/// Returns the matching revocation predicate for an exact locked version.
	pub fn revocation_for(
		&self,
		id: &Str,
		version: &Str,
	) -> Result<Option<&RevokedVersion>, ExtensionError> {
		for entry in self.revoked.iter().filter(|entry| entry.id == *id) {
			if version_satisfies(version.as_str(), entry.versions.as_str())? {
				return Ok(Some(entry));
			}
		}
		Ok(None)
	}

	/// Atomically writes a revocation snapshot.
	pub fn write(&self, path: &Path) -> io::Result<()> {
		let parent = path.parent().unwrap_or_else(|| Path::new("."));
		fs::create_dir_all(parent)?;
		let temporary = path.with_extension("json.tmp");

		fs::write(&temporary, serde_json::to_vec_pretty(self).map_err(io::Error::other)?)?;
		fs::rename(temporary, path)
	}

	/// Returns the documented stale-list decision after parsing RFC 3339
	/// instants, including non-UTC offsets.
	pub fn freshness(&self, now: &str, strict_offline: bool) -> RevocationFreshness {
		let issued_at = Timestamp::from_str(self.issued_at.as_str());
		let valid_until = Timestamp::from_str(self.valid_until.as_str());
		let now = Timestamp::from_str(now);
		let freshness = if issued_at.is_ok_and(|issued_at| {
			valid_until.is_ok_and(|valid_until| {
				now.is_ok_and(|now| issued_at <= now && valid_until >= now && issued_at < valid_until)
			})
		}) {
			RevocationFreshness::Fresh
		} else if strict_offline {
			RevocationFreshness::Reject(ExtensionCode::ERevoked)
		} else {
			RevocationFreshness::Warn(ExtensionCode::WRevocationStale)
		};
		match freshness {
			RevocationFreshness::Fresh => {
				tracing::debug!(strict_offline, "extension revocation cache is fresh");
			},
			RevocationFreshness::Warn(code) => {
				tracing::warn!(?code, strict_offline, "extension revocation cache is stale");
			},
			RevocationFreshness::Reject(code) => {
				tracing::warn!(?code, strict_offline, "extension revocation cache rejected");
			},
		}
		freshness
	}
}

/// Produces the consent digest from normalized capabilities and hard-tool
/// claims. Sorting makes semantically equal manifests produce one grant key.
pub fn capability_digest(
	capabilities: impl IntoIterator<Item = Str>,
	hard_tools: impl IntoIterator<Item = Str>,
) -> Str {
	let mut entries: BTreeSet<Str> = capabilities.into_iter().collect();
	entries.extend(hard_tools.into_iter().map(|tool| sf!("tools.hard:{tool}")));
	let mut hasher = Hash32::hasher();
	for entry in entries {
		hasher.update(entry.as_str().as_bytes());
		hasher.update(b"\n");
	}
	sf!("b3:{}", hasher.finalize().to_hex())
}

/// Verifies an Ed25519 signature over `blake3 || sha256 || capability_digest`.
#[tracing::instrument(name = "extension_artifact_signature_verify", level = "debug", skip_all)]
pub fn verify_artifact_signature(
	key: &str,
	blake3_digest: &str,
	sha256_digest: &str,
	capability_digest: &str,
	signature: &str,
) -> Result<(), ExtensionError> {
	(|| {
		let decode_digest = |digest: &str, prefix: &str| {
			hex::decode(digest.strip_prefix(prefix).unwrap_or(digest).as_bytes())
				.into_vec()
				.map_err(|_| {
					ExtensionError::new(ExtensionCode::ESig, format!("invalid {prefix} digest"))
				})
		};
		let blake3 = decode_digest(blake3_digest, "b3:")?;
		let sha256 = decode_digest(sha256_digest, "sha256:")?;
		let capability = decode_digest(capability_digest, "b3:")?;
		let mut message = Vec::with_capacity(blake3.len() + sha256.len() + capability.len());
		message.extend_from_slice(&blake3);
		message.extend_from_slice(&sha256);
		message.extend_from_slice(&capability);
		verify_signature(key, &message, signature)
	})()
}

/// Verifies a detached Ed25519 signature over canonical authority-owned bytes.
pub fn verify_signed_payload(
	key: &str,
	message: &[u8],
	signature: &str,
) -> Result<(), ExtensionError> {
	verify_signature(key, message, signature)
}

fn validate_public_key(key: &str) -> Result<(), ExtensionError> {
	let key = key.strip_prefix("ed25519:").unwrap_or(key);
	let key = base64::decode(key.as_bytes())
		.into_vec()
		.map_err(|_| ExtensionError::new(ExtensionCode::ESig, "publisher key is not base64"))?;
	if key.len() != 32 {
		return Err(ExtensionError::new(ExtensionCode::ESig, "publisher key is not 32 bytes"));
	}
	Ok(())
}

fn verify_signature(key: &str, message: &[u8], signature: &str) -> Result<(), ExtensionError> {
	let key = key.strip_prefix("ed25519:").unwrap_or(key);
	let signature = signature.strip_prefix("ed25519:sig:").unwrap_or(signature);
	let key = base64::decode(key.as_bytes())
		.into_vec()
		.map_err(|_| ExtensionError::new(ExtensionCode::ESig, "publisher key is not base64"))?;
	let signature = base64::decode(signature.as_bytes())
		.into_vec()
		.map_err(|_| ExtensionError::new(ExtensionCode::ESig, "signature is not base64"))?;
	if key.len() != 32 {
		return Err(ExtensionError::new(ExtensionCode::ESig, "publisher key is not 32 bytes"));
	}
	if signature.len() != 64 {
		return Err(ExtensionError::new(ExtensionCode::ESig, "invalid Ed25519 signature"));
	}
	UnparsedPublicKey::new(&ED25519, &key)
		.verify(message, &signature)
		.map_err(|_| ExtensionError::new(ExtensionCode::ESig, "signature verification failed"))
}

const fn one() -> u32 {
	1
}

fn read_toml_or_default<T: for<'de> Deserialize<'de> + Default>(
	path: &Path,
) -> Result<T, ExtensionError> {
	if !path.exists() {
		return Ok(T::default());
	}
	let text = fs::read_to_string(path)
		.map_err(|error| ExtensionError::new(ExtensionCode::EIntegrity, error.to_string()))?;
	toml::from_str(&text)
		.map_err(|error| ExtensionError::new(ExtensionCode::EIntegrity, error.to_string()))
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn stale_revocation_fails_open_unless_strict() {
		let list = RevocationsFile {
			version:     1,
			issued_at:   sf!("2026-01-01T00:00:00Z"),
			valid_until: sf!("2026-01-02T00:00:00Z"),
			revoked:     vec![],
			signature:   sf!("ed25519:sig:"),
		};
		assert_eq!(
			list.freshness("2026-01-03T00:00:00Z", false),
			RevocationFreshness::Warn(ExtensionCode::WRevocationStale)
		);
		assert_eq!(
			list.freshness("2026-01-03T00:00:00Z", true),
			RevocationFreshness::Reject(ExtensionCode::ERevoked)
		);
	}

	#[test]
	fn operator_key_acceptance_replaces_tofu_pin_but_rejects_malformed_keys() {
		let id = sf!("acme.reviewer");
		let first = Str::new(base64::encode(&[1_u8; 32]).into_string());
		let second = Str::new(base64::encode(&[2_u8; 32]).into_string());
		let mut keys = KeysFile::default();
		assert!(
			keys
				.accept_operator_key(&id, &first, &sf!("1.0.0"), &sf!("first"))
				.expect("first key")
		);
		assert!(
			keys
				.accept_operator_key(&id, &second, &sf!("2.0.0"), &sf!("second"))
				.expect("replacement key")
		);
		assert_eq!(keys.keys.len(), 1);
		assert_eq!(keys.keys[0].key, second);
		assert_eq!(
			keys
				.accept_operator_key(&id, &sf!("invalid"), &sf!("3.0.0"), &sf!("third"))
				.unwrap_err()
				.code,
			ExtensionCode::ESig
		);
	}

	#[test]
	fn widened_capabilities_require_a_new_grant() {
		let id = sf!("acme.reviewer");
		let publisher = sf!("ed25519:key");
		let old = capability_digest([sf!("net")], []);
		let widened = capability_digest([sf!("net"), sf!("exec")], []);
		let grants = GrantsFile {
			version: 1,
			grants:  vec![Grant {
				id:                id.clone(),
				publisher:         publisher.clone(),
				layer:             Layer::Client,
				workspace:         None,
				scope:             GrantScope::Exact,
				capability_digest: old,
				tier:              TrustTier::Sandboxed,
				ship:              sf!("installed"),
				granted_at:        sf!("now"),
				granted_by:        sf!("interactive"),
				duration:          GrantDuration::Persistent,
			}],
		};
		assert!(!grant_covers(
			&grants,
			&id,
			&publisher,
			Layer::Client,
			None,
			&widened,
			TrustTier::Sandboxed,
			&sf!("installed"),
		));
		assert!(!grant_covers(
			&grants,
			&id,
			&publisher,
			Layer::Client,
			None,
			&grants.grants[0].capability_digest,
			TrustTier::Trusted,
			&sf!("installed"),
		));
		assert!(!grant_covers(
			&grants,
			&id,
			&publisher,
			Layer::Client,
			None,
			&grants.grants[0].capability_digest,
			TrustTier::Sandboxed,
			&sf!("pickle"),
		));
	}
	#[test]
	fn interactive_persist_round_trips_through_the_canonical_writer() {
		let directory = tempfile::tempdir().expect("grant directory");
		let path = directory.path().join("grants.toml");
		let grant = Grant {
			id:                sf!("acme.reviewer"),
			publisher:         sf!("ed25519:publisher"),
			layer:             Layer::Client,
			workspace:         None,
			scope:             GrantScope::Exact,
			capability_digest: sf!("b3:capabilities"),
			tier:              TrustTier::Sandboxed,
			ship:              sf!("installed"),
			granted_at:        sf!("2026-08-27T00:00:00Z"),
			granted_by:        sf!("interactive"),
			duration:          GrantDuration::Persistent,
		};
		let persisted = GrantsFile::persist(&path, grant.clone()).expect("persist grant");
		assert_eq!(persisted.grants, [grant.clone()]);
		assert_eq!(GrantsFile::read(&path).expect("read grant").grants, [grant]);
	}

	fn workspace(uri: &'static str) -> WorkspaceUri {
		WorkspaceUri { uri: Str::new_static(uri), digest: sf!("digest:{uri}") }
	}

	fn workspace_grant(workspace: WorkspaceUri, scope: GrantScope, digest: &'static str) -> Grant {
		Grant {
			id: sf!("acme.reviewer"),
			publisher: sf!("ed25519:publisher"),
			layer: Layer::Workspace,
			workspace: Some(workspace),
			scope,
			capability_digest: Str::new_static(digest),
			tier: TrustTier::Sandboxed,
			ship: sf!("installed"),
			granted_at: sf!("2026-08-28T00:00:00Z"),
			granted_by: sf!("interactive"),
			duration: GrantDuration::Persistent,
		}
	}

	#[test]
	fn subtree_grant_covers_a_child_workspace() {
		let child = workspace("file:///work/team/project/");
		let grant =
			workspace_grant(workspace("file:///work/team/"), GrantScope::Subtree, "b3:capabilities");
		let grants = GrantsFile { version: 1, grants: vec![grant.clone()] };
		assert!(grant_covers(
			&grants,
			&grant.id,
			&grant.publisher,
			Layer::Workspace,
			Some(&child),
			&grant.capability_digest,
			grant.tier,
			&grant.ship,
		));
	}

	#[test]
	fn most_specific_workspace_grant_wins() {
		let child = workspace("file:///work/team/project/");
		let parent =
			workspace_grant(workspace("file:///work/team/"), GrantScope::Subtree, "b3:parent");
		let exact = workspace_grant(child.clone(), GrantScope::Exact, "b3:child");
		let grants = GrantsFile { version: 1, grants: vec![parent.clone(), exact.clone()] };
		assert!(!grant_covers(
			&grants,
			&parent.id,
			&parent.publisher,
			Layer::Workspace,
			Some(&child),
			&parent.capability_digest,
			parent.tier,
			&parent.ship,
		));
		assert!(grant_covers(
			&grants,
			&exact.id,
			&exact.publisher,
			Layer::Workspace,
			Some(&child),
			&exact.capability_digest,
			exact.tier,
			&exact.ship,
		));
	}

	#[test]
	fn session_only_grants_never_persist() {
		let directory = tempfile::tempdir().expect("grant directory");
		let path = directory.path().join("grants.toml");
		let grant = Grant {
			duration: GrantDuration::Session,
			..workspace_grant(
				workspace("file:///work/team/project/"),
				GrantScope::Exact,
				"b3:capabilities",
			)
		};
		GrantsFile { version: 1, grants: vec![grant.clone()] }
			.write(&path)
			.expect("write durable subset");
		assert!(
			GrantsFile::read(&path)
				.expect("read grants")
				.grants
				.is_empty()
		);
		assert!(matches!(GrantsFile::persist(&path, grant), Err(GrantPersistenceError::SessionOnly)));
		assert!(
			GrantsFile::read(&path)
				.expect("read grants")
				.grants
				.is_empty()
		);
	}

	#[test]
	fn revocations_apply_pep_440_predicates_to_exact_locked_versions() {
		let list = RevocationsFile {
			version:     1,
			issued_at:   sf!("2026-01-01T00:00:00Z"),
			valid_until: sf!("2027-01-01T00:00:00Z"),
			revoked:     vec![RevokedVersion {
				id:       sf!("sample"),
				versions: sf!(">=1.2,<2,!=1.5"),
				reason:   sf!("security"),
				advisory: "https://example.invalid/advisory".to_owned(),
			}],
			signature:   sf!("invalid"),
		};
		assert!(
			list
				.revocation_for(&sf!("sample"), &sf!("1.4"))
				.unwrap()
				.is_some()
		);
		assert!(
			list
				.revocation_for(&sf!("sample"), &sf!("1.5"))
				.unwrap()
				.is_none()
		);
		assert!(
			list
				.revocation_for(&sf!("sample"), &sf!("2.0"))
				.unwrap()
				.is_none()
		);
	}
}
