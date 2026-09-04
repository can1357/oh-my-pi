//! Dashboard and report slash commands: `/usage`, `/stats`, `/context`,
//! `/trace`, `/changelog`, `/hotkeys`, and `/debug`.
//!
//! `/usage` opens the full-screen dashboard; the report commands open a
//! [`ReportPanel`]; `/debug` opens the selector or one inspector. The TS
//! implementation opened a local stats web dashboard for `/stats` and `/trace`;
//! here `/stats` syncs the application's usage index over every stored journal
//! and shows a summary layout in a report, and `/trace` renders the last
//! turn's timeline from the replica plus the recorded kernel notifications.

use omp_con::{ConError, ConResult, Ctx};
use omp_core::Str;
use omp_tui::Icon;

use super::{PaletteEntry, rest};
use crate::{
	actions::{HostAction, post},
	host::HostCommand,
	overlays::{
		PanelCall, PanelEvent, PanelOpener,
		info::{DebugSelector, changelog_report, context_report, hotkeys_report, open_debug},
		report::{PendingReportPanel, ReportPanel},
		reset_usage::ResetUsageSelector,
		services::{Mutation, ServiceError},
		stats::{stats_report, trace_report},
		usage::UsageDashboard,
	},
};

/// Palette icons for this module's commands.
pub const PALETTE: &[PaletteEntry] = &[
	PaletteEntry { name: "usage", icon: Icon::ChartBar },
	PaletteEntry { name: "stats", icon: Icon::Chart },
	PaletteEntry { name: "context", icon: Icon::Context },
	PaletteEntry { name: "trace", icon: Icon::Chart },
	PaletteEntry { name: "changelog", icon: Icon::Newspaper },
	PaletteEntry { name: "hotkeys", icon: Icon::Keyboard },
	PaletteEntry { name: "debug", icon: Icon::Bug },
];

const USAGE_USAGE: &str = "Usage: /usage [show|reset [account|active]]";
/// Status while session files are synchronized.
const STATS_SYNCING: &str = "Syncing session files...";
/// `/trace` preflight when no session file exists.
const NO_TRACE: &str = "No session file yet — send a message first.";
const NO_CHANGELOG: &str = "No changelog entries found.";

fn usage(message: &'static str) -> ConError {
	ConError::Usage(Str::new_static(message))
}

fn open(ctx: &Ctx, opener: PanelOpener) -> ConResult<()> {
	post(ctx, HostAction::Open(opener))
}

fn call(ctx: &Ctx, call: PanelCall) -> ConResult<()> {
	post(ctx, HostAction::Call(call))
}

/// `/usage` subcommands.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum UsageOp {
	/// Open the dashboard.
	Show,
	/// Spend a saved rate-limit reset for `target` (empty lists them).
	Reset(Str),
}

/// Parses `/usage [show|reset [account|active]]`.
pub fn usage_op(words: Option<Str>) -> Result<UsageOp, ConError> {
	let Some(words) = words else {
		return Ok(UsageOp::Show);
	};
	let text = words.as_str().trim();
	let (verb, tail) = text
		.split_once(char::is_whitespace)
		.map_or((text, ""), |(verb, tail)| (verb, tail.trim()));
	match verb.to_ascii_lowercase().as_str() {
		"show" if tail.is_empty() => Ok(UsageOp::Show),
		"reset" => Ok(UsageOp::Reset(Str::new(tail))),
		_ => Err(usage(USAGE_USAGE)),
	}
}

omp_con::cmd! {
	/// Shows provider usage and limits: `/usage [show|reset [account|active]]`.
	usage(?op: Str, ?target: Str) = |ctx, args| match usage_op(rest(args, 0))? {
		UsageOp::Show => open(ctx, PanelOpener::new(|cx| {
			UsageDashboard::open(cx).map(|panel| Box::new(panel) as Box<_>)
		})),
		UsageOp::Reset(target) if target.is_empty() => open(ctx, PanelOpener::new(|cx| {
			ResetUsageSelector::open(cx).map(|panel| Box::new(panel) as Box<_>)
		})),
		UsageOp::Reset(target) => call(ctx, PanelCall::new(move |_cx| {
			PanelEvent::Command(HostCommand::Service(Mutation::ResetUsage { target: target.clone() }))
		})),
	};

	/// Shows historical token usage and cost across every stored session.
	stats() = |ctx, _args| open(ctx, PanelOpener::new(|cx| {
		let pending = cx.services.stats().map_err(|error| Str::new(error.to_string()))?;
		Ok(Box::new(PendingReportPanel::new(
			"stats",
			"Stats",
			STATS_SYNCING,
			pending,
			stats_report,
			cx.ui,
		)) as Box<_>)
	}));

	/// Shows the estimated context usage breakdown.
	context() = |ctx, _args| open(ctx, PanelOpener::new(|cx| {
		let body = context_report(cx.dom, cx.con);
		Ok(Box::new(ReportPanel::new("context", "Context", body, cx.ui)) as Box<_>)
	}));

	/// Shows the last turn's execution trace: requests, tool calls, usage,
	/// and kernel notifications on one timeline.
	trace() = |ctx, _args| open(ctx, PanelOpener::new(|cx| {
		// Kernel notifications are observer-side facts; a host without the
		// feed still traces from the replica alone.
		let events = cx.services.trace_events().unwrap_or_default();
		let body = trace_report(cx.dom, &events).ok_or_else(|| Str::new_static(NO_TRACE))?;
		Ok(Box::new(ReportPanel::new("trace", "Trace", body, cx.ui)) as Box<_>)
	}));

	/// Shows changelog entries: `/changelog [full]`.
	changelog(?full: Str) = |ctx, args| {
		let full = rest(args, 0).is_some_and(|words| {
			words.as_str().split_whitespace().any(|word| word.eq_ignore_ascii_case("full"))
		});
		// An opener's `Err` is the host's status notice, so an empty or
		// unavailable changelog reads use this one-line status notice.
		open(ctx, PanelOpener::new(move |cx| {
			let text = match cx.services.changelog() {
				Ok(text) => text,
				Err(ServiceError::Unavailable(_)) => return Err(Str::new_static(NO_CHANGELOG)),
				Err(error) => return Err(Str::new(error.to_string())),
			};
			let body = changelog_report(&text, full).ok_or_else(|| Str::new_static(NO_CHANGELOG))?;
			let title = if full { "Changelog" } else { "Changelog · recent" };
			Ok(Box::new(ReportPanel::new("changelog", title, body, cx.ui)) as Box<_>)
		}))
	};

	/// Shows all keyboard shortcuts.
	hotkeys() = |ctx, _args| open(ctx, PanelOpener::new(|cx| {
		Ok(Box::new(ReportPanel::new("hotkeys", "Hotkeys", hotkeys_report(cx.con), cx.ui)) as Box<_>)
	}));

	/// Opens the complete native debug tools selector or executes one stable
	/// operation key.
	debug(?operation: Str) = |ctx, args| match rest(args, 0) {
		None => open(ctx, PanelOpener::new(|cx| {
			Ok(Box::new(DebugSelector::open(cx.ui, cx.viewport.width)) as Box<_>)
		})),
		Some(key) => {
			let action = key
				.as_str()
				.trim()
				.parse::<crate::overlays::services::DebugAction>()
				.map_err(|_| usage("Usage: /debug [open-artifacts|performance|work|dump|memory|logs|system|terminal|protocols|raw-sse|transcript|clear-cache]"))?;
			open(ctx, PanelOpener::new(move |cx| {
				open_debug(cx, action, super::control::transcript_text(cx.dom))
			}))
		},
	};
}

#[cfg(test)]
mod tests {
	use omp_core::sf;

	use super::*;

	#[test]
	fn usage_words_parse_show_and_reset() {
		assert_eq!(usage_op(None).unwrap(), UsageOp::Show);
		assert_eq!(usage_op(Some(sf!("show"))).unwrap(), UsageOp::Show);
		assert_eq!(usage_op(Some(sf!("reset"))).unwrap(), UsageOp::Reset(Str::default()));
		assert_eq!(usage_op(Some(sf!("reset active"))).unwrap(), UsageOp::Reset(sf!("active")));
		assert_eq!(
			usage_op(Some(sf!("Reset me@example.com"))).unwrap(),
			UsageOp::Reset(sf!("me@example.com"))
		);
		assert!(matches!(usage_op(Some(sf!("show extra"))), Err(ConError::Usage(_))));
		assert!(matches!(usage_op(Some(sf!("bogus"))), Err(ConError::Usage(_))));
	}
}
