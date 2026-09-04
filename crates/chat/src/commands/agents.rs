//! Agent slash commands:
//! `/agents` opens the definitions browser, `/hub` the live supervisor, and
//! `transcript <id>` — the console line the hub runs on Enter (ADR 0014) —
//! stacks the transcript viewer for one child over the hub.

use omp_con::{ConError, ConResult, Ctx};
use omp_core::Str;
use omp_tui::Icon;

use super::{PaletteEntry, rest};
use crate::{
	actions::{HostAction, post},
	overlays::{
		PanelOpener,
		agents::AgentsHub,
		hub::{AgentHub, TranscriptViewer},
	},
};

/// Palette icons for this module's commands.
pub const PALETTE: &[PaletteEntry] = &[
	PaletteEntry { name: "agents", icon: Icon::Agents },
	PaletteEntry { name: "hub", icon: Icon::Group },
	PaletteEntry { name: "transcript", icon: Icon::Session },
];

fn open(ctx: &Ctx, opener: PanelOpener) -> ConResult<()> {
	post(ctx, HostAction::Open(opener))
}

omp_con::cmd! {
	/// Browses agent definitions: enable or disable classes and inspect their cfg.
	agents() = |ctx, _args| open(ctx, PanelOpener::new(|cx| {
		Ok(Box::new(AgentsHub::open(cx)) as Box<_>)
	}));

	/// Opens the live agent hub: roster, inspector, and activity feed.
	hub() = |ctx, _args| open(ctx, PanelOpener::new(|cx| {
		Ok(Box::new(AgentHub::open(cx)) as Box<_>)
	}));

	/// Opens the transcript viewer for one child agent: `transcript <id>`.
	transcript(id: Str) = |ctx, args| {
		let id = rest(args, 0)
			.ok_or_else(|| ConError::Usage(Str::new_static("Usage: transcript <agent id>")))?;
		open(ctx, PanelOpener::new(move |cx| {
			Ok(Box::new(TranscriptViewer::open(cx, id.as_str())?) as Box<_>)
		}))
	};
}
