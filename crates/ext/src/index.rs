//! Canonical signed native OMP extension index.

use std::{collections::BTreeSet, fs, path::Path, str::FromStr as _};

use jiff::Timestamp;
use omp_core::Str;
use serde::{Deserialize, Serialize};

use super::{
	ExtensionCode, ExtensionError,
	config::{FeatureManifest, StaticDeclaration},
	resolver::compare_versions,
	trust::{KeyRotation, verify_signed_payload},
};

/// Current signed-index format.
pub const INDEX_VERSION: u32 = 1;
/// Ordered configured signed-index sources.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct IndexConfig {
	/// First-index precedence entries.
	#[serde(default, rename = "index")]
	pub entries: Vec<IndexConfigEntry>,
}

/// One named signed-index URL.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct IndexConfigEntry {
	/// Stable local index name.
	pub name: Str,
	/// HTTPS URL of the signed index snapshot.
	pub url:  String,
}

impl IndexConfig {
	/// Reads an absent config as an empty index list.
	#[tracing::instrument(
		name = "extension_index_config_read",
		level = "debug",
		skip_all,
		fields(path = %path.display())
	)]
	pub fn read(path: &Path) -> Result<Self, ExtensionError> {
		if !path.exists() {
			tracing::debug!(cache_hit = false, "extension index config not found");
			return Ok(Self::default());
		}
		let result = fs::read_to_string(path)
			.map_err(|error| ExtensionError::new(ExtensionCode::EIntegrity, error.to_string()))
			.and_then(|text| {
				toml::from_str::<Self>(&text)
					.map_err(|error| ExtensionError::new(ExtensionCode::EIntegrity, error.to_string()))
			});
		if let Ok(config) = &result {
			tracing::debug!(
				cache_hit = true,
				index_count = config.entries.len(),
				"extension index config loaded"
			);
		}
		result
	}
}

/// One explicit claim that an extension may shadow a bundled capability.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ShadowClaim {
	/// Capability family, such as `tool` or `agent`.
	pub kind: Str,
	/// Bundled capability name.
	pub name: Str,
}

/// One target-specific, hash-pinned wheel advertised by the index.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct IndexArtifact {
	/// Target triple, or `any` for a pure Python wheel.
	pub target:    Str,
	/// Artifact URL.
	pub url:       String,
	/// Wheel filename.
	pub file:      Str,
	/// Wheel compatibility tag.
	pub tag:       Str,
	/// Exact byte length.
	pub size:      u64,
	/// BLAKE3 digest prefixed by `b3:`.
	pub blake3:    Str,
	/// SHA-256 digest prefixed by `sha256:`.
	pub sha256:    Str,
	/// Publisher signature over both hashes and the complete manifest
	/// capability graph digest.
	pub signature: Str,
}

/// An immutable extension release in the native index.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct IndexRelease {
	/// Exact PEP 440 release version.
	pub version:                    Str,
	/// Canonical manifest BLAKE3 digest.
	pub manifest_digest:            Str,
	/// Complete signed capability-graph digest.
	#[serde(default)]
	pub manifest_capability_digest: Str,
	/// Digest of declared capabilities and hard-tool claims.
	pub capability_digest:          Str,
	/// Base dependency requirements.
	#[serde(default)]
	pub requires:                   Vec<Str>,
	/// Base capability grants.
	#[serde(default)]
	pub capabilities:               Vec<Str>,
	/// Named optional features.
	#[serde(default)]
	pub features:                   std::collections::BTreeMap<Str, FeatureManifest>,
	/// Complete signed declaration inventory.
	#[serde(default)]
	pub declarations:               Vec<StaticDeclaration>,
	/// Whether index review/attestation completed.
	#[serde(default)]
	pub attested:                   bool,
	/// Whether the release is yanked from new resolutions.
	#[serde(default)]
	pub yanked:                     bool,
	/// Explicit bundled-name shadow claims.
	#[serde(default)]
	pub shadows:                    Vec<ShadowClaim>,
	/// Target artifacts.
	pub artifacts:                  Vec<IndexArtifact>,
}

impl IndexRelease {
	/// Digest covered by the publisher artifact signature.
	pub fn signature_capability_digest(&self) -> &Str {
		if self.manifest_capability_digest.is_empty() {
			&self.capability_digest
		} else {
			&self.manifest_capability_digest
		}
	}

	/// Reconstructs the signed manifest surface needed for feature projection.
	pub fn deployment_manifest(&self) -> crate::config::DeploymentManifest {
		crate::config::DeploymentManifest {
			id:           Str::new_static(""),
			entry:        Str::new_static(""),
			settings:     Default::default(),
			requires:     self.requires.clone(),
			capabilities: self.capabilities.clone(),
			features:     self.features.clone(),
			binaries:     Vec::new(),
			declarations: self.declarations.clone(),
		}
	}
}

/// One publisher-scoped extension identity.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct IndexExtension {
	/// Stable extension identity.
	pub id:            Str,
	/// Python distribution name.
	pub distribution:  Str,
	/// Human-readable summary.
	#[serde(default)]
	pub description:   Str,
	/// Base64 Ed25519 publisher key.
	pub publisher_key: Str,
	/// Optional key continuity proof signed by the previously pinned key.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub key_rotation:  Option<KeyRotation>,
	/// Available immutable releases.
	pub releases:      Vec<IndexRelease>,
}

/// Signed canonical native index snapshot.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct SignedIndex {
	/// Index format version.
	pub version:     u32,
	/// Stable index identity.
	pub name:        Str,
	/// RFC 3339 snapshot issuance time.
	pub issued_at:   Str,
	/// RFC 3339 snapshot expiry time.
	pub valid_until: Str,
	/// Extension catalog, sorted by id in canonical snapshots.
	pub extensions:  Vec<IndexExtension>,
	/// Detached Ed25519 signature from the configured index key.
	pub signature:   Str,
}

#[derive(Serialize)]
struct UnsignedIndex<'a> {
	version:     u32,
	name:        &'a Str,
	issued_at:   &'a Str,
	valid_until: &'a Str,
	extensions:  &'a [IndexExtension],
}

impl SignedIndex {
	/// Reads and validates a signed JSON index snapshot.
	#[tracing::instrument(
		name = "extension_index_load",
		level = "debug",
		skip_all,
		fields(path = %path.display())
	)]
	pub fn read(path: &Path, index_key: &str) -> Result<Self, ExtensionError> {
		let result: Result<Self, ExtensionError> = (|| {
			let bytes = fs::read(path)
				.map_err(|error| ExtensionError::new(ExtensionCode::EIntegrity, error.to_string()))?;
			let index: Self = serde_json::from_slice(&bytes).map_err(|error| {
				ExtensionError::new(ExtensionCode::EManifestParse, error.to_string())
			})?;
			index.verify(index_key)?;
			Ok(index)
		})();
		if let Ok(index) = &result {
			tracing::debug!(
				cache_hit = true,
				index_name = %index.name,
				extension_count = index.extensions.len(),
				"extension index cache loaded"
			);
		}
		result
	}

	/// Verifies version, freshness, canonical ordering, uniqueness, and the
	/// detached index signature. Signed bytes are canonical JSON of every field
	/// except `signature`.
	pub fn verify(&self, index_key: &str) -> Result<(), ExtensionError> {
		self.verify_at(index_key, Timestamp::now())
	}

	/// Verifies a signed index at an authority-supplied instant.
	#[tracing::instrument(
		name = "extension_index_verify",
		level = "debug",
		skip_all,
		fields(index_name = %self.name, extension_count = self.extensions.len())
	)]
	pub fn verify_at(&self, index_key: &str, now: Timestamp) -> Result<(), ExtensionError> {
		if self.version != INDEX_VERSION {
			return Err(ExtensionError::new(
				ExtensionCode::EManifestParse,
				"unsupported signed-index version",
			));
		}
		let issued_at = Timestamp::from_str(self.issued_at.as_str()).map_err(|error| {
			ExtensionError::new(
				ExtensionCode::EIntegrity,
				format!("invalid signed-index issued_at: {error}"),
			)
		})?;
		let valid_until = Timestamp::from_str(self.valid_until.as_str()).map_err(|error| {
			ExtensionError::new(
				ExtensionCode::EIntegrity,
				format!("invalid signed-index valid_until: {error}"),
			)
		})?;
		if issued_at > now || valid_until <= now || valid_until <= issued_at {
			return Err(ExtensionError::new(
				ExtensionCode::EIntegrity,
				"signed index is not currently valid",
			));
		}
		let mut previous: Option<&Str> = None;
		let mut ids = BTreeSet::new();
		for extension in &self.extensions {
			if extension.id.as_str().is_empty() || extension.publisher_key.as_str().is_empty() {
				return Err(ExtensionError::new(
					ExtensionCode::EManifestParse,
					"index extension has an empty identity or publisher key",
				));
			}
			if extension.key_rotation.as_ref().is_some_and(|rotation| {
				rotation.id != extension.id || rotation.new_key != extension.publisher_key
			}) {
				return Err(ExtensionError::new(
					ExtensionCode::EKeyChanged,
					"index key rotation does not match its extension identity",
				));
			}
			if previous.is_some_and(|previous| previous >= &extension.id) || !ids.insert(&extension.id)
			{
				return Err(ExtensionError::new(
					ExtensionCode::EManifestParse,
					"index extensions are not uniquely sorted by id",
				));
			}
			previous = Some(&extension.id);
			let mut release_versions = BTreeSet::new();
			for release in &extension.releases {
				compare_versions(release.version.as_str(), release.version.as_str())?;
				if !release_versions.insert(&release.version) {
					return Err(ExtensionError::new(
						ExtensionCode::EManifestParse,
						"index extension contains a duplicate release version",
					));
				}
				if release.artifacts.is_empty() {
					return Err(ExtensionError::new(
						ExtensionCode::ETargetMissing,
						"index release has no target artifacts",
					));
				}
				if !release.features.is_empty()
					|| !release.capabilities.is_empty()
					|| !release.declarations.is_empty()
				{
					let manifest = release.deployment_manifest();
					manifest.validate()?;
					let digest = crate::config::manifest_capability_digest(&manifest)?;
					if release.manifest_capability_digest != digest {
						return Err(ExtensionError::new(
							ExtensionCode::EIntegrity,
							"index release capability graph digest is not canonical",
						));
					}
				}
				let mut targets = BTreeSet::new();
				for artifact in &release.artifacts {
					if !targets.insert(&artifact.target)
						|| !artifact.blake3.as_str().starts_with("b3:")
						|| !artifact.sha256.as_str().starts_with("sha256:")
						|| artifact.signature.as_str().is_empty()
					{
						return Err(ExtensionError::new(
							ExtensionCode::EManifestParse,
							"index release has duplicate targets or incomplete signed hashes",
						));
					}
				}
			}
		}
		let payload = serde_json::to_vec(&UnsignedIndex {
			version:     self.version,
			name:        &self.name,
			issued_at:   &self.issued_at,
			valid_until: &self.valid_until,
			extensions:  &self.extensions,
		})
		.map_err(|error| ExtensionError::new(ExtensionCode::ESig, error.to_string()))?;
		verify_signed_payload(index_key, &payload, self.signature.as_str())
	}

	/// Returns the greatest eligible PEP 440 release.
	pub fn latest_release<'a>(
		&self,
		extension: &'a IndexExtension,
		attested_only: bool,
	) -> Option<&'a IndexRelease> {
		extension
			.releases
			.iter()
			.filter(|release| !release.yanked && (!attested_only || release.attested))
			.max_by(|left, right| {
				compare_versions(left.version.as_str(), right.version.as_str())
					.expect("release versions were validated with the signed index")
			})
	}

	/// Looks up one non-yanked exact release.
	pub fn release(&self, id: &str, version: &str) -> Option<(&IndexExtension, &IndexRelease)> {
		let extension = self
			.extensions
			.iter()
			.find(|extension| extension.id == id)?;
		let release = extension
			.releases
			.iter()
			.find(|release| release.version == version && !release.yanked)?;
		Some((extension, release))
	}

	/// Searches descriptions and identities in deterministic index order.
	pub fn search<'a>(
		&'a self,
		query: &'a str,
		capability_shadow: Option<&'a str>,
		attested_only: bool,
	) -> impl Iterator<Item = (&'a IndexExtension, &'a IndexRelease)> + 'a {
		let query = query.to_ascii_lowercase();
		self.extensions.iter().filter_map(move |extension| {
			if !extension.id.as_str().to_ascii_lowercase().contains(&query)
				&& !extension
					.description
					.as_str()
					.to_ascii_lowercase()
					.contains(&query)
			{
				return None;
			}
			let release = extension
				.releases
				.iter()
				.filter(|release| {
					!release.yanked
						&& (!attested_only || release.attested)
						&& capability_shadow
							.is_none_or(|name| release.shadows.iter().any(|shadow| shadow.name == name))
				})
				.max_by(|left, right| {
					compare_versions(left.version.as_str(), right.version.as_str())
						.expect("release versions were validated with the signed index")
				})?;
			Some((extension, release))
		})
	}
}

/// Requires every manifest shadow claim to have an exact user-configured
/// declaration. Index presence alone never changes built-in precedence.
pub fn validate_shadow_consent(
	release: &IndexRelease,
	configured: impl IntoIterator<Item = ShadowClaim>,
) -> Result<(), ExtensionError> {
	let configured: BTreeSet<(Str, Str)> = configured
		.into_iter()
		.map(|claim| (claim.kind, claim.name))
		.collect();
	if release
		.shadows
		.iter()
		.any(|claim| !configured.contains(&(claim.kind.clone(), claim.name.clone())))
	{
		return Err(ExtensionError::new(
			ExtensionCode::EConsent,
			"extension declares an unapproved built-in shadow",
		));
	}
	Ok(())
}

#[cfg(test)]
mod tests {
	use super::*;

	fn release(version: &'static str) -> IndexRelease {
		IndexRelease {
			version:                    Str::new_static(version),
			manifest_digest:            Str::new_static("b3:manifest"),
			manifest_capability_digest: Str::new_static("b3:capabilities"),
			capability_digest:          Str::new_static("b3:capabilities"),
			requires:                   Vec::new(),
			capabilities:               Vec::new(),
			features:                   std::collections::BTreeMap::new(),
			declarations:               Vec::new(),
			attested:                   true,
			yanked:                     false,
			shadows:                    Vec::new(),
			artifacts:                  Vec::new(),
		}
	}

	#[test]
	fn latest_release_uses_pep_440_order_not_json_order() {
		let index = SignedIndex {
			version:     INDEX_VERSION,
			name:        Str::new_static("test"),
			issued_at:   Str::new_static("2026-01-01T00:00:00Z"),
			valid_until: Str::new_static("2027-01-01T00:00:00Z"),
			extensions:  Vec::new(),
			signature:   Str::new_static("invalid"),
		};
		let extension = IndexExtension {
			id:            Str::new_static("sample"),
			distribution:  Str::new_static("sample"),
			description:   Str::new_static(""),
			publisher_key: Str::new_static("key"),
			key_rotation:  None,
			releases:      vec![release("2.0rc1"), release("1.9"), release("2.0")],
		};
		assert_eq!(index.latest_release(&extension, false).unwrap().version, "2.0");
	}

	#[test]
	fn expired_index_is_rejected_before_signature_admission() {
		let index = SignedIndex {
			version:     INDEX_VERSION,
			name:        Str::new_static("test"),
			issued_at:   Str::new_static("2025-01-01T00:00:00Z"),
			valid_until: Str::new_static("2025-01-02T00:00:00Z"),
			extensions:  Vec::new(),
			signature:   Str::new_static("invalid"),
		};
		let now = Timestamp::from_str("2026-01-01T00:00:00Z").unwrap();
		let error = index.verify_at("invalid", now).unwrap_err();
		assert_eq!(error.code, ExtensionCode::EIntegrity);
	}
}
