//! Extension configuration, resolution, locking, and local trust state.
//!
//! The crate is intentionally CLI- and host-agnostic: argument parsing lives in
//! the application, Environment-backed materialization lives in the
//! environment host, and this surface owns deterministic data transformations
//! plus durable on-disk state.

pub mod config;
pub mod doctor;
pub mod index;
pub mod lock;
pub mod marketplace;
pub mod resolver;
pub mod trust;
pub mod upgrade;

use omp_core::Str;
use serde::{Deserialize, Serialize};
use strum::{Display, EnumString, IntoStaticStr};

/// The layer in which an extension is resolved and admitted.
#[derive(
	Clone, Copy, Debug, Default, Display, EnumString, Eq, PartialEq, Serialize, Deserialize,
)]
#[serde(rename_all = "lowercase")]
#[strum(serialize_all = "lowercase", ascii_case_insensitive)]
pub enum Layer {
	/// Operator-owned client layer.
	#[default]
	Client,
	/// Workspace-owned layer.
	Workspace,
}

/// The requested trust tier for an extension host.
#[derive(
	Clone, Copy, Debug, Default, Display, EnumString, Eq, PartialEq, Serialize, Deserialize,
)]
#[serde(rename_all = "lowercase")]
#[strum(serialize_all = "lowercase", ascii_case_insensitive)]
pub enum TrustTier {
	/// Isolated, policy-mediated extension host.
	#[default]
	Sandboxed,
	/// Operator-approved trusted extension host.
	Trusted,
}

/// The closed extension diagnostic vocabulary from deployment §3.16.
///
/// Every extension subsystem emits one of these values; callers should use
/// [`ExtensionCode::as_ref`] rather than inventing string codes.
#[derive(
	Clone,
	Copy,
	Debug,
	Deserialize,
	Display,
	EnumString,
	Eq,
	Hash,
	IntoStaticStr,
	PartialEq,
	Serialize,
)]
#[serde(rename_all = "SCREAMING-KEBAB-CASE")]
#[strum(serialize_all = "SCREAMING-KEBAB-CASE", ascii_case_insensitive)]
pub enum ExtensionCode {
	/// A named source had no extension manifest.
	ENoManifest,
	/// An extension manifest could not be parsed.
	EManifestParse,
	/// A requested or declared feature is unknown or malformed.
	EFeature,
	/// A capability lies outside the closed vocabulary.
	ECapUnknown,
	/// An executable capability was open-ended.
	ECapExecOpen,
	/// A layer declared the same id twice.
	EDupId,
	/// A declaration kind is unknown.
	EDeclKind,
	/// Replacement was declared outside workspace scope.
	EReplaceScope,
	/// An extension dependency crossed layers.
	EXlayerDep,
	/// Extension dependency edges form a cycle.
	EExtCycle,
	/// Skills declared requirements.
	ESkillsRequires,
	/// The resolver has no satisfying closure.
	EUnsat,
	/// A requirement conflicts with frozen runtime metadata.
	EFrozenConflict,
	/// A target lacks an installable wheel.
	ETargetMissing,
	/// A wheel ABI is not valid for `CPython` 3.14t.
	EAbiRejected,
	/// A direct URL occurred in a requirement.
	EUrlRequire,
	/// A git source was not pinned.
	EGitFloating,
	/// Locked index configuration drifted.
	EIndexDrift,
	/// A lock format is too new.
	ELockVersion,
	/// A lock was loaded in the wrong layer.
	ELockLayer,
	/// A lock targets a different Python runtime.
	ELockPython,
	/// A lock contains a duplicate extension id.
	ELockDup,
	/// A lock incorrectly contains a link source.
	ELockLink,
	/// A locked resolution no longer satisfies the request.
	ELockDrift,
	/// Artifact integrity verification failed.
	EIntegrity,
	/// A publisher signature failed verification.
	ESig,
	/// A TOFU publisher key changed without rotation.
	EKeyChanged,
	/// A package or extension was revoked.
	ERevoked,
	/// A binary has no target-specific artifact.
	EBinPlatform,
	/// Offline materialization lacks an artifact.
	EOffline,
	/// A vendored tree contained native code.
	EVendorNative,
	/// Operator consent was declined.
	EConsent,
	/// A requested grant named an unknown capability.
	EGrantUnknown,
	/// Extension settings attempted to carry a secret.
	ESettingSecret,
	/// Startup update policy attempted scope escalation or was malformed.
	EUpdatePolicy,
	/// A trusted extension failed to load.
	ETrustedLoad,
	/// A host binary does not export the `CPython` C API.
	EAbiExport,
	/// A lock references a yanked artifact.
	WYanked,
	/// An accepted publisher key rotation occurred.
	WKeyRotated,
	/// An offline revocation list was stale.
	WRevocationStale,
	/// A locked site tree or required entry is missing.
	ESiteMissing,
	/// A site tree contains an untracked entry.
	WSiteExtra,
	/// An installed extension is not covered by an exact operator grant.
	WUngranted,
	/// A vendored dependency duplicates a resolved one.
	WVendorDup,
	/// Resident host cost exceeded the configured budget.
	WPoolCount,
	/// Client and workspace hosts have different API admission sets.
	WApiSkew,
	/// A foreign extension-shaped root was ignored.
	WForeignRoot,
	/// A workspace identity could not be derived.
	WWorkspaceAnon,
	/// Workspace replacement failed a P4 gate.
	WReplaceDenied,
	/// An installed extension has no reproducible lock entry.
	WNoLock,
	/// Ambient `OMP_PY_SITE` bypassed managed site selection.
	WSiteOverride,
	/// A configured index list differs outside locked mode.
	WIndexDrift,
}

impl ExtensionCode {
	/// Process exit status assigned to this stable diagnostic class.
	pub const fn exit_code(self) -> u8 {
		match self {
			Self::EFeature | Self::EUrlRequire | Self::EGitFloating => 2,
			Self::EUnsat | Self::EFrozenConflict | Self::ETargetMissing | Self::EAbiRejected => 3,
			Self::EIntegrity | Self::ESig | Self::EKeyChanged | Self::ERevoked => 4,
			Self::EConsent | Self::EGrantUnknown => 5,
			Self::EOffline => 6,
			Self::EIndexDrift | Self::ELockDrift => 7,
			Self::WYanked
			| Self::WKeyRotated
			| Self::WRevocationStale
			| Self::WSiteExtra
			| Self::WUngranted
			| Self::WVendorDup
			| Self::WPoolCount
			| Self::WApiSkew
			| Self::WForeignRoot
			| Self::WWorkspaceAnon
			| Self::WReplaceDenied
			| Self::WNoLock
			| Self::WSiteOverride
			| Self::WIndexDrift => 0,
			_ => 1,
		}
	}
}

/// A structured extension failure or warning.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
#[error("{code}: {detail}")]
pub struct ExtensionError {
	/// Stable diagnostic code.
	pub code:   ExtensionCode,
	/// Human-actionable detail.
	pub detail: Str,
}

impl ExtensionError {
	/// Creates a typed diagnostic.
	pub fn new(code: ExtensionCode, detail: impl AsRef<str>) -> Self {
		Self { code, detail: Str::new(detail) }
	}
}

impl ExtensionError {
	/// Stable process status for the diagnostic class.
	pub const fn exit_code(&self) -> u8 {
		self.code.exit_code()
	}
}

/// Typed provenance fields stamped wherever an extension acts.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct Provenance {
	/// TOFU-pinned publisher fingerprint.
	pub publisher:       Str,
	/// Publisher-scoped extension identity.
	pub extension_id:    Str,
	/// Exact extension version.
	pub version:         Str,
	/// Exact wheel artifact digest.
	pub artifact_digest: Str,
	/// Resolving layer.
	pub layer:           Layer,
	/// Granted trust tier.
	pub tier:            TrustTier,
	/// Host incarnation generation.
	pub generation:      u64,
}

/// A canonical workspace identity and its grant-key digest.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct WorkspaceUri {
	/// Canonical URI identifying the workspace machine and root.
	pub uri:    Str,
	/// BLAKE3 workspace identity digest.
	pub digest: Str,
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn extension_diagnostic_exit_statuses_follow_the_cli_contract() {
		assert_eq!(ExtensionCode::EFeature.exit_code(), 2);
		assert_eq!(ExtensionCode::EUnsat.exit_code(), 3);
		assert_eq!(ExtensionCode::EIntegrity.exit_code(), 4);
		assert_eq!(ExtensionCode::EConsent.exit_code(), 5);
		assert_eq!(ExtensionCode::EOffline.exit_code(), 6);
		assert_eq!(ExtensionCode::ELockDrift.exit_code(), 7);
		assert_eq!(ExtensionCode::WNoLock.exit_code(), 0);
		assert_eq!(ExtensionCode::EManifestParse.exit_code(), 1);
	}
}
