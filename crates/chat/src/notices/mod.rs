//! Transcript notices and maintenance surfaces: provider errors, retry
//! countdowns, compaction dividers, cache-miss markers, per-turn usage rows,
//! extension and hook message boxes, desktop notifications, and the
//! vocalizer.
//!
//! Every renderer here is a pure function of session-DOM element state (ADR
//! 0005: the actor projects, never authors). The DOM contract the renderers
//! read, all on elements the kernel journals into a `<turn>`:
//!
//! - `<notice kind=K>` with text content. `K` ∈ `error | warn | warning | info
//!   | success` (controller notices), `diagnostics` (late LSP findings, `name`
//!   = server), `tangent` (background `/tan` dispatch, `id` = job id, `label` =
//!   work summary), `advisor` (`data={AdvisorMessage}` with ordered `notes[]
//!   {advisor,severity,note}`). Older journals may retain scalar advisor props,
//!   `hook`, or `custom` notices.
//! - `<developer kind=custom|hook name=TYPE display=BOOL presentation=FRAME>`
//!   keeps extension content model-visible while retaining exact renderer
//!   identity and optional replacement TML. Actors fall back to the semantic
//!   Markdown body when replacement parsing fails.
//! - `<notice kind=irc data={IrcTraffic}>` is the typed
//!   incoming/autoreply/relay/work-pool observation projected by every actor.
//!   `<user file_mention=true data={FileMentions}>` preserves auto-read path
//!   order, materialization state, model content, and image blob refs.
//! - `<user async_result=true data={"jobs":[...]}>` keeps the model-facing
//!   notice in its body but projects one compact typed completion row per job;
//!   `<user launch_completion=true data={"daemons":[...]}>` does the same for
//!   terminal supervised processes and follows tool-activity visibility; `<user
//!   skill_prompt=true data={SkillPrompt}>` projects the framed skill
//!   invocation while its body remains an ordinary model-facing user message;
//!   `<user author=guest>` renders as the collaboration guest bubble; `<user
//!   synthetic=true>` collapses to the `Synthetic input · size · lines ·
//!   ctrl+o` row.
//! - `<usage tokens-in tokens-out cost-nano-usd cache-read cache-write ttft-ms
//!   duration-ms>`; the row timestamp and prompt→yield wait derive from the
//!   ULID timestamps of the `<usage>` and `<user>` entry ids.
//! - `<meta><compaction boundary method tokens-before tokens-after warning
//!   summary>`; `boundary` names the last entry hidden by the summary, so the
//!   divider lands after the turn containing that entry.
//!
//! The one observer-only exception is [`update::UpdateAvailable`]: the local
//! interactive host may show a validated official release without journaling
//! it, so replay, remote spectators, print, RPC, and ACP remain deterministic.

pub mod cache;
pub mod custom;
pub mod divider;
pub mod error;
pub(crate) mod file_mentions;
pub(crate) mod irc;
pub(crate) mod local;
pub mod misc;
pub mod retry;
pub mod session_exit;
pub(crate) mod skill;
pub mod update;
pub mod usage;
pub mod voice;
pub(crate) mod workpool;

use omp_core::{Str, Ulid};
use omp_dom::{Node, PropId, Value};

/// String property, when present and non-empty.
#[must_use]
pub fn prop_text(node: &Node, prop: PropId) -> Option<Str> {
	node
		.prop(&prop.into())
		.and_then(Value::as_str)
		.filter(|text| !text.is_empty())
		.map(Str::new)
}

/// Unsigned integer property; absent or non-integer reads as zero.
#[must_use]
pub fn prop_u64(node: &Node, prop: PropId) -> u64 {
	match node.prop(&prop.into()) {
		Some(Value::Int(value)) => u64::try_from(*value).unwrap_or_default(),
		_ => 0,
	}
}

/// Boolean property; absent reads as `false`.
#[must_use]
pub fn prop_bool(node: &Node, prop: PropId) -> bool {
	match node.prop(&prop.into()) {
		Some(Value::Bool(value)) => *value,
		Some(Value::Str(value)) => value.as_str() == "true",
		Some(Value::Int(value)) => *value != 0,
		_ => false,
	}
}

/// Unix-millisecond timestamp of the journal entry that minted `node`,
/// decoded from its `id` ULID.
#[must_use]
pub fn entry_ms(node: &Node) -> Option<u64> {
	node
		.prop(&PropId::Id.into())
		.and_then(Value::as_str)
		.and_then(|id| Ulid::from_string(id).ok())
		.map(Ulid::timestamp_ms)
}

/// Formats numbers as `999`, `1K`, `1.5K`, `25K`, `1M`, `1.5M`, `25M`, or
/// `1.5B`.
#[must_use]
pub fn format_number(value: u64) -> String {
	fn trim1(value: f64) -> String {
		let text = format!("{value:.1}");
		text.strip_suffix(".0").map_or(text.clone(), str::to_owned)
	}
	#[allow(clippy::cast_precision_loss, reason = "display rounding only")]
	let n = value as f64;
	if value < 1_000 {
		value.to_string()
	} else if value < 10_000 {
		format!("{}K", trim1(n / 1_000.0))
	} else if value < 1_000_000 {
		format!("{}K", (n / 1_000.0).round())
	} else if value < 10_000_000 {
		format!("{}M", trim1(n / 1_000_000.0))
	} else if value < 1_000_000_000 {
		format!("{}M", (n / 1_000_000.0).round())
	} else if value < 10_000_000_000 {
		format!("{}B", trim1(n / 1_000_000_000.0))
	} else {
		format!("{}B", (n / 1_000_000_000.0).round())
	}
}

/// Writes durations as `0ms`, `347ms`, `2.5s`, `1m20s`, `1h5m`, or `2d`.
pub fn write_duration(out: &mut impl std::fmt::Write, ms: u64) -> std::fmt::Result {
	const SEC: u64 = 1_000;
	const MIN: u64 = 60 * SEC;
	const HOUR: u64 = 60 * MIN;
	const DAY: u64 = 24 * HOUR;
	#[allow(clippy::cast_precision_loss, reason = "display rounding only")]
	if ms == 0 {
		out.write_str("0ms")
	} else if ms < SEC {
		write!(out, "{ms}ms")
	} else if ms < MIN {
		write!(out, "{:.1}s", ms as f64 / SEC as f64)
	} else if ms < HOUR {
		let mins = ms / MIN;
		let secs = (ms % MIN) / SEC;
		if secs > 0 {
			write!(out, "{mins}m{secs}s")
		} else {
			write!(out, "{mins}m")
		}
	} else if ms < DAY {
		let hours = ms / HOUR;
		let mins = (ms % HOUR) / MIN;
		if mins > 0 {
			write!(out, "{hours}h{mins}m")
		} else {
			write!(out, "{hours}h")
		}
	} else {
		let days = ms / DAY;
		let hours = (ms % DAY) / HOUR;
		if hours > 0 {
			write!(out, "{days}d{hours}h")
		} else {
			write!(out, "{days}d")
		}
	}
}

/// Allocating convenience wrapper for [`write_duration`].
#[must_use]
pub fn format_duration(ms: u64) -> String {
	let mut output = String::new();
	let _ = write_duration(&mut output, ms);
	output
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn pi_number_formatting() {
		assert_eq!(format_number(999), "999");
		assert_eq!(format_number(1_000), "1K");
		assert_eq!(format_number(1_500), "1.5K");
		assert_eq!(format_number(25_000), "25K");
		assert_eq!(format_number(50_900), "51K");
		assert_eq!(format_number(1_000_000), "1M");
		assert_eq!(format_number(1_500_000), "1.5M");
		assert_eq!(format_number(25_000_000), "25M");
		assert_eq!(format_number(1_500_000_000), "1.5B");
	}

	#[test]
	fn pi_duration_formatting() {
		assert_eq!(format_duration(0), "0ms");
		assert_eq!(format_duration(347), "347ms");
		assert_eq!(format_duration(2_500), "2.5s");
		assert_eq!(format_duration(80_000), "1m20s");
		assert_eq!(format_duration(120_000), "2m");
		assert_eq!(format_duration(3_900_000), "1h5m");
		assert_eq!(format_duration(172_800_000), "2d");
	}
}
