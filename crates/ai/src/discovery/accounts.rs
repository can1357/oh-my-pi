//! Credential-blind multi-account catalog merging.

use std::collections::BTreeMap;

use omp_catalog::{DiscoveredModel, ProviderId, WireModelId};
use omp_core::Str;

/// Discovered rows tied only to an opaque account-affinity digest.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AccountCatalog {
	/// Provider account domain.
	pub provider:         ProviderId,
	/// Opaque stable affinity; never a token, key, or account payload.
	pub account_affinity: Str,
	/// Secret-free discovery rows.
	pub rows:             Vec<DiscoveredModel>,
}

/// One merged row with every account affinity on which it was observed.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AccountDiscoveredModel {
	/// Normalized discovery row.
	pub model:      DiscoveredModel,
	/// Sorted, deduplicated opaque affinities.
	pub affinities: Box<[Str]>,
}

/// Merges account-scoped catalogs deterministically without persisting
/// credential material.
pub fn merge_account_catalogs(catalogs: &[AccountCatalog]) -> Vec<AccountDiscoveredModel> {
	let mut merged = BTreeMap::<(ProviderId, WireModelId), AccountDiscoveredModel>::new();
	for catalog in catalogs {
		for row in &catalog.rows {
			if row.provider != catalog.provider {
				continue;
			}
			let key = (row.provider.clone(), row.wire_model.clone());
			let entry = merged.entry(key).or_insert_with(|| AccountDiscoveredModel {
				model:      row.clone(),
				affinities: Box::new([]),
			});
			let mut affinities = entry.affinities.to_vec();
			if !affinities.contains(&catalog.account_affinity) {
				affinities.push(catalog.account_affinity.clone());
				affinities.sort();
				entry.affinities = affinities.into_boxed_slice();
			}
			// Prefer richer declared evidence without replacing the stable identity.
			if entry.model.declared_limits.is_none() {
				entry.model.declared_limits = row.declared_limits;
			}
			if entry.model.declared_capabilities.is_none() {
				entry
					.model
					.declared_capabilities
					.clone_from(&row.declared_capabilities);
			}
		}
	}
	merged.into_values().collect()
}

#[cfg(test)]
mod tests {
	use omp_catalog::{OperationBits, RouteId};

	use super::*;

	fn row() -> DiscoveredModel {
		DiscoveredModel {
			provider:              ProviderId::from("codex"),
			route:                 RouteId::from("codex"),
			wire_model:            WireModelId::from("gpt"),
			aliases:               Box::new([]),
			display_name:          None,
			declared_class:        None,
			declared_operations:   OperationBits::empty(),
			declared_capabilities: None,
			declared_limits:       None,
			declared_pricing:      Box::new([]),
			extended_context_mode: None,
			availability:          None,
			source:                Str::new_static("account-catalog"),
			observed_at_ms:        None,
			updated_at_ms:         None,
			deprecated:            None,
		}
	}

	#[test]
	fn duplicate_rows_merge_only_opaque_affinities() {
		let catalogs = [
			AccountCatalog {
				provider:         ProviderId::from("codex"),
				account_affinity: Str::new_static("digest-b"),
				rows:             vec![row()],
			},
			AccountCatalog {
				provider:         ProviderId::from("codex"),
				account_affinity: Str::new_static("digest-a"),
				rows:             vec![row()],
			},
		];
		let merged = merge_account_catalogs(&catalogs);
		assert_eq!(merged.len(), 1);
		assert_eq!(merged[0].affinities.as_ref(), ["digest-a", "digest-b"]);
	}
}
