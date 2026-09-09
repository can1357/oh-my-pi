//! Native ACP exec-backend routing settings.

use omp_con::Ctx;
use serde::{Deserialize, Serialize};

/// Routing policy for capability-advertised ACP terminal execution.
#[derive(
	Clone,
	Copy,
	Debug,
	Default,
	Deserialize,
	Eq,
	PartialEq,
	Serialize,
	strum::Display,
	strum::EnumString,
	strum::IntoStaticStr,
	strum::VariantNames,
)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case")]
pub enum AcpRouting {
	/// Prefer ACP for eligible calls only when the Environment advertises it.
	#[default]
	Auto,
	/// Never route shell execution through ACP.
	Never,
}

omp_con::con_enum!(AcpRouting);

omp_con::var! {
	/// Choose whether eligible shell calls prefer a capable ACP terminal backend.
	pub static SV_ACP_ROUTING = sv_acp_routing: AcpRouting {
		default: AcpRouting::Auto,
		flags: archive,
		meta: {
			"legacy.path": "acp.routing",
		},
	};
}

/// ACP execution settings consumed by shell backend selection.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct AcpSettings {
	/// Capability-gated terminal routing policy.
	pub routing: AcpRouting,
}

impl AcpSettings {
	/// Resolves ACP routing policy from the process control context.
	#[must_use]
	pub fn from_con(ctx: &Ctx) -> Self {
		Self { routing: SV_ACP_ROUTING.get(ctx) }
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn acp_con_projection_round_trips() {
		let ctx = Ctx::new();
		SV_ACP_ROUTING
			.set(&ctx, AcpRouting::Never)
			.expect("set routing");
		assert_eq!(AcpSettings::from_con(&ctx), AcpSettings { routing: AcpRouting::Never });
	}
}
