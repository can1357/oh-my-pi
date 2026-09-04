//! Plan mode commands: `/plan [prompt]`
//! toggles the plan Director (ADR 0015 `<meta><directors>` engagement) and
//! submits the prompt once on; `/plan-review` opens the observer-local
//! review overlay over the plan artifact.

use omp_core::Str;
use omp_tui::Icon;

use super::{CommandAction, PaletteEntry, post, rest};

/// Palette icons for this module's commands.
pub const PALETTE: &[PaletteEntry] =
	&[PaletteEntry { name: "plan", icon: Icon::Plan }, PaletteEntry {
		name: "plan-review",
		icon: Icon::Plan,
	}];

/// Default plan artifact.
pub const DEFAULT_PLAN: &str = "local://PLAN.md";

omp_con::cmd! {
	/// Toggles plan mode; a prompt is submitted once plan mode is on.
	plan(?prompt: Str) = |ctx, args| post(ctx, CommandAction::Plan { prompt: rest(args, 0) });

	/// Opens the plan review overlay: sections, execution model, approve or refine.
	"plan-review"() = |ctx, _args| post(ctx, CommandAction::PlanReview);

	/// Plan review verdict: `plan_approve [role] [compact|keep]…` (posted by the overlay).
	plan_approve(?role: Str, ?flags: Str) = |ctx, args| {
		let mut role = None;
		let mut compact = false;
		let mut keep = false;
		for index in 0..args.len() {
			let word = args.get::<Str>(index)?;
			match word.as_str() {
				"compact" => compact = true,
				"keep" => keep = true,
				other if role.is_none() => role = Some(Str::new(other)),
				_ => {},
			}
		}
		post(ctx, CommandAction::PlanApprove { role, compact, keep })
	};
}
