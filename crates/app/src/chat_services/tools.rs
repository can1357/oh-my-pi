//! `/tools`: the kernel's policy-resolved tool roster projected from the
//! composed [`omp_tool::Registry`].

use omp_chat::overlays::services::{ServiceResult, ToolRow};
use omp_core::{Str, sf};
use omp_tool::{Presentation, ToolRoute};

use super::ServiceState;

/// Every live registry claim in wire-name order. Slot and device tools are
/// active; hidden declarations are listed but inactive until a session
/// policy selects them (the panel overrides `active` from the DOM roster).
pub(super) fn roster(state: &ServiceState) -> ServiceResult<Vec<ToolRow>> {
	let registry = &state.registry;
	let mut rows = Vec::with_capacity(registry.live_identities().len());
	for (name, rev) in registry.live_identities() {
		let Ok(spec) = registry.live_spec(name.as_str()) else {
			continue;
		};
		let presentation = registry
			.presentation(name.as_str())
			.unwrap_or(Presentation::Slot);
		let tier = registry
			.devices()
			.find(|device| device.name == name)
			.and_then(|device| device.metadata)
			.and_then(|metadata| metadata.tier.clone());
		let source = match registry.route(name.as_str()) {
			Ok(ToolRoute::Native) => Str::new_static("builtin"),
			Ok(ToolRoute::Remote) => Str::new_static("remote"),
			Ok(ToolRoute::Worker { name: worker, .. }) => sf!("ext:{worker}"),
			Err(_) => registry
				.claim(name.as_str())
				.map_or_else(Str::default, |claim| claim.claimant.clone()),
		};
		rows.push(ToolRow {
			name: name.clone(),
			description: spec.description.clone(),
			rev: u32::from(rev.n),
			tier,
			active: presentation != Presentation::Hidden,
			source,
		});
	}
	Ok(rows)
}
