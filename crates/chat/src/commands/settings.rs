//! `/settings`: opens the settings selector over
//! the console variable registry ([`SettingsPanel`]).

use omp_tui::Icon;

use super::PaletteEntry;
use crate::{
	actions::{HostAction, post},
	overlays::{PanelOpener, settings::SettingsPanel},
};

/// Palette icons for this module's commands.
pub const PALETTE: &[PaletteEntry] = &[PaletteEntry { name: "settings", icon: Icon::Gear }];

omp_con::cmd! {
	/// Opens the settings menu.
	settings() = |ctx, _args| {
		post(ctx, HostAction::Open(PanelOpener::new(|cx| {
			SettingsPanel::open(cx).map(|panel| Box::new(panel) as Box<_>)
		})))
	};
}
