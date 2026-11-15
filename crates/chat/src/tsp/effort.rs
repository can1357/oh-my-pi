//! The thinking-effort segment of the native status band (ADR 0041 phase 3).
//!
//! Tern draws the level as its `effort` glyph, a ring that fills rung by rung.
//! A Tern without that kind gets v1's fallback, a four-cell `blocks` meter,
//! and one without `meter` either gets the level as text alone.

use omp_ai::ReasoningEffort;
use omp_core::Str;
use omp_tui::tsp::wire::{Hello, Kind, Node};
use serde::Serialize;

use super::typed_props;

/// Action a click on the effort segment sends; the host cycles the thinking
/// level as the cycle key does.
pub const THINKING_CYCLE: &str = "thinking.cycle";

/// Id of the effort segment inside the status band.
pub const EFFORT_SEG_ID: &str = "status-effort";
/// Id of the glyph (or fallback meter) inside the effort segment.
const GLYPH_ID: &str = "status-effort-glyph";

/// Cells of the fallback meter: one per rung of the glyph.
const METER_STEPS: u8 = 4;

#[derive(Serialize)]
struct Actions {
	click: &'static str,
}

#[derive(Serialize)]
struct SegProps<'a> {
	text:    &'a str,
	title:   &'static str,
	actions: Actions,
}

#[derive(Serialize)]
struct GlyphProps<'a> {
	level: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
enum MeterStyle {
	Blocks,
}

#[derive(Serialize)]
struct MeterProps {
	/// Filled share; absent (the wire's `null`) for a level with no rung
	/// (`auto`).
	#[serde(skip_serializing_if = "Option::is_none")]
	value: Option<f32>,
	style: MeterStyle,
	steps: u8,
}

/// The kind that draws the level on a terminal announcing `hello`, or `None`
/// when only the text can.
#[must_use]
pub fn glyph_kind(hello: &Hello) -> Option<Kind> {
	[Kind::Effort, Kind::Meter]
		.into_iter()
		.find(|kind| hello.draws(*kind))
}

/// Filled rungs of the four-rung glyph for `level`.
fn rungs(level: &str) -> Option<u8> {
	Some(match level.parse::<ReasoningEffort>().ok()? {
		ReasoningEffort::Off => 0,
		ReasoningEffort::Minimal | ReasoningEffort::Low => 1,
		ReasoningEffort::Medium => 2,
		ReasoningEffort::High => 3,
		ReasoningEffort::Xhigh | ReasoningEffort::Max => METER_STEPS,
	})
}

/// The status `seg` showing thinking effort `level`, drawn with `glyph`
/// (see [`glyph_kind`]).
#[must_use]
pub fn effort_seg(level: &str, glyph: Option<Kind>) -> Node {
	let child = |k: Kind, p| Node { id: Str::new_static(GLYPH_ID), k, p, c: Vec::new() };
	let glyph = match glyph {
		Some(Kind::Effort) => Some(child(Kind::Effort, typed_props(&GlyphProps { level }))),
		Some(Kind::Meter) => Some(child(
			Kind::Meter,
			typed_props(&MeterProps {
				value: rungs(level).map(|rungs| f32::from(rungs) / f32::from(METER_STEPS)),
				style: MeterStyle::Blocks,
				steps: METER_STEPS,
			}),
		)),
		_ => None,
	};
	Node {
		p:  typed_props(&SegProps {
			text:    level,
			title:   "Thinking effort",
			actions: Actions { click: THINKING_CYCLE },
		}),
		id: Str::new_static(EFFORT_SEG_ID),
		k:  Kind::Seg,
		c:  glyph.into_iter().collect(),
	}
}
