//! Explicit internal-resource mutation routing contracts.
//!
//! This module recognizes the fixed native mutation families plus the bounded
//! RPC host-resource fallback. The Environment still admits every write.

use omp_core::Str;

use super::{
	resolver::Scheme,
	selector::{ParsedSelector, parse_uri},
};

/// Environment capability required by an internal-resource mutation.
#[derive(Clone, Copy, Debug, Eq, PartialEq, strum::Display)]
#[strum(serialize_all = "snake_case")]
pub enum MutationCapability {
	/// Native SSH/SFTP mutation authority.
	Ssh,
	/// Granted vault mutation authority.
	Vault,
	/// Session attachment commit authority.
	Attachment,
	/// RPC host-owned generation-fenced authority.
	Host,
}

/// One whole-resource mutation admitted for an Environment transaction.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResourceMutationRequest {
	/// Exact authored URI, excluding a no-op whole-file display selector.
	pub uri:        Str,
	/// Exact bytes to commit.
	pub content:    Str,
	/// Capability the Environment must check before opening a transaction.
	pub capability: MutationCapability,
}

/// Environment-owned receipt after an atomic resource transaction.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResourceMutationReceipt {
	/// Canonical URI committed by the resource owner.
	pub canonical_uri: Str,
	/// Exact number of UTF-8 bytes committed.
	pub byte_len:      u64,
	/// Monotone resource revision after commitment.
	pub revision:      u64,
}

/// Explicit mutation-route syntax fault.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum MutationRouteFault {
	/// A routed URI contains a partial-file selector.
	#[error("internal-resource writes address a whole resource; remove selector :{selector}")]
	PartialSelector {
		/// Rejected selector text.
		selector: Str,
	},
	/// A URI query is not legal for this mutation family.
	#[error("{scheme}:// writes do not accept query parameters")]
	QueryNotAllowed {
		/// Routed scheme.
		scheme: &'static str,
	},
	/// The URI itself is malformed.
	#[error("invalid internal-resource mutation URI")]
	InvalidUri,
}

/// Recognize an explicit native or RPC host-owned mutation route.
///
/// `Ok(None)` means the target is not one of these resource families and the
/// caller should continue ordinary archive/SQLite/filesystem dispatch.
pub fn route_resource_mutation(
	path: &str,
	content: impl Into<Str>,
) -> Result<Option<ResourceMutationRequest>, MutationRouteFault> {
	let Some(parsed) = parse_uri(path).map_err(|_| MutationRouteFault::InvalidUri)? else {
		return Ok(None);
	};
	let capability = match parsed.scheme {
		Scheme::Ssh => MutationCapability::Ssh,
		Scheme::Vault => MutationCapability::Vault,
		Scheme::Attachment => MutationCapability::Attachment,
		Scheme::Unknown => MutationCapability::Host,
		_ => return Ok(None),
	};
	if let Some(selector) = parsed.selector_text
		&& !matches!(parsed.selector, ParsedSelector::Raw | ParsedSelector::Conflicts)
	{
		return Err(MutationRouteFault::PartialSelector { selector: Str::new(selector) });
	}
	if parsed.query.is_some() && !matches!(parsed.scheme, Scheme::Unknown | Scheme::Vault) {
		return Err(MutationRouteFault::QueryNotAllowed { scheme: parsed.scheme.into() });
	}
	let uri = parsed.selector_text.map_or_else(
		|| Str::new(path),
		|_| {
			Str::new(parsed.query.map_or_else(
				|| format!("{}://{}", parsed.raw_scheme, parsed.resource),
				|query| format!("{}://{}?{query}", parsed.raw_scheme, parsed.resource),
			))
		},
	);
	Ok(Some(ResourceMutationRequest { uri, content: content.into(), capability }))
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn routes_only_explicit_mutation_families() {
		assert_eq!(
			route_resource_mutation("ssh://host/path", "body")
				.unwrap()
				.unwrap()
				.capability,
			MutationCapability::Ssh
		);
		assert_eq!(
			route_resource_mutation("vault://notes/file.md", "body")
				.unwrap()
				.unwrap()
				.capability,
			MutationCapability::Vault
		);
		assert_eq!(
			route_resource_mutation("attachment://session/image.png", "body")
				.unwrap()
				.unwrap()
				.capability,
			MutationCapability::Attachment
		);
		assert!(
			route_resource_mutation("mcp://server/resource", "body")
				.unwrap()
				.is_none()
		);
	}

	#[test]
	fn rejects_partial_writes_and_resource_queries() {
		assert!(matches!(
			route_resource_mutation("ssh://host/path:1-2", "body"),
			Err(MutationRouteFault::PartialSelector { .. })
		));
		assert!(matches!(
			route_resource_mutation("attachment://session/image?q=x", "body"),
			Err(MutationRouteFault::QueryNotAllowed { .. })
		));
		let vault = route_resource_mutation("vault://notes/file.md?op=create", "body")
			.expect("vault query route")
			.expect("vault request");
		assert_eq!(vault.capability, MutationCapability::Vault);
		assert_eq!(vault.uri, "vault://notes/file.md?op=create");
	}
}
