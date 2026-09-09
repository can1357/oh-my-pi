//! Per-turn usage row projected from a `<usage>`
//! element and its enclosing `<turn>`.

use std::fmt::Write as _;

use jiff::{Timestamp, fmt::strtime, tz::TimeZone};
use omp_core::{Str, StrMut};
use omp_dom::{Dom, Handle, KnownTag, PropId, Tag};
use omp_tui::{Icon, IntoComponent as _, UiContext, dom};

use super::{entry_ms, format_duration, format_number, prop_u64};
use crate::cards::Component;

/// Below this, the throughput figure
/// is nonsense (cached or instant responses yield absurd tok/s).
const MIN_DURATION_MS: u64 = 100;

/// Local `YYYY-MM-DD HH:mm:ss` timestamp layout.
const TIMESTAMP_FORMAT: &str = "%Y-%m-%d %H:%M:%S";

/// Everything the usage row reads, lifted off the DOM once per projection.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct UsageFacts {
	/// Uncached prompt tokens (`tokens-in`).
	pub input:        u64,
	/// Completion tokens (`tokens-out`).
	pub output:       u64,
	/// Prompt tokens served from the provider cache.
	pub cache_read:   u64,
	/// Prompt tokens written to the provider cache.
	pub cache_write:  u64,
	/// Milliseconds to the first streamed token.
	pub ttft_ms:      Option<u64>,
	/// Milliseconds from request start to completion.
	pub duration_ms:  Option<u64>,
	/// Unix milliseconds of the `<usage>` entry.
	pub completed_ms: Option<u64>,
	/// Unix milliseconds of the turn's `<user>` entry.
	pub started_ms:   Option<u64>,
}

impl UsageFacts {
	/// Prompt→yield wall time,
	/// `None` when either end is unknown or the span is not positive.
	#[must_use]
	pub fn elapsed_ms(&self) -> Option<u64> {
		let (started, completed) = (self.started_ms?, self.completed_ms?);
		(completed > started).then(|| completed - started)
	}
}

/// Reads a `<usage>` element and locates its turn's `<user>` entry for the
/// prompt timestamp. An unknown handle yields all-zero facts.
#[must_use]
pub fn usage_facts(dom: &Dom, usage: Handle) -> UsageFacts {
	let Some(node) = dom.get(usage) else {
		return UsageFacts::default();
	};
	let started_ms = dom.parent(usage).and_then(|turn| {
		dom.children(turn)
			.iter()
			.filter_map(|child| dom.get(*child))
			.find(|child| child.tag == Tag::Known(KnownTag::User))
			.and_then(entry_ms)
	});
	UsageFacts {
		input: prop_u64(node, PropId::TokensIn),
		output: prop_u64(node, PropId::TokensOut),
		cache_read: prop_u64(node, PropId::CacheRead),
		cache_write: prop_u64(node, PropId::CacheWrite),
		ttft_ms: optional(node, PropId::TtftMs),
		duration_ms: optional(node, PropId::DurationMs),
		completed_ms: entry_ms(node),
		started_ms,
	}
}

fn optional(node: &omp_dom::Node, prop: PropId) -> Option<u64> {
	node
		.prop(&prop.into())
		.is_some()
		.then(|| prop_u64(node, prop))
}

/// Timestamp, `Δ` wait badge,
/// input (`input + cacheWrite`), output, cache read when non-zero, TTFT
/// when known, and throughput above [`MIN_DURATION_MS`] — joined by two
/// spaces. Icons resolve through the charset so the line inlines anywhere.
#[must_use]
pub fn usage_line(facts: &UsageFacts, ui: &UiContext) -> Str {
	let charset = ui.charset;
	let time = charset.icon(Icon::Time);
	fn separate(line: &mut StrMut) {
		if !line.is_empty() {
			line.push_str("  ");
		}
	}
	let mut line = StrMut::with_capacity(96);
	if let Some(stamp) = facts
		.completed_ms
		.filter(|ms| *ms > 0)
		.and_then(|ms| local_timestamp(ms, &TimeZone::system()))
	{
		line.push_str(&stamp);
	}
	if let Some(elapsed) = facts.elapsed_ms() {
		separate(&mut line);
		let _ = write!(line, "{time}Δ{}", format_duration(elapsed));
	}
	separate(&mut line);
	let _ = write!(
		line,
		"{} {}",
		charset.icon(Icon::Input),
		format_number(facts.input.saturating_add(facts.cache_write))
	);
	separate(&mut line);
	let _ = write!(line, "{} {}", charset.icon(Icon::Output), format_number(facts.output));
	if facts.cache_read > 0 {
		separate(&mut line);
		let _ = write!(line, "{} {}", charset.icon(Icon::Cache), format_number(facts.cache_read));
	}
	if let Some(ttft) = facts.ttft_ms.filter(|ttft| *ttft > 0) {
		separate(&mut line);
		#[allow(clippy::cast_precision_loss, reason = "display rounding only")]
		let seconds = ttft as f64 / 1_000.0;
		let _ = write!(line, "{time} {seconds:.1}s");
	}
	if let Some(duration) = facts
		.duration_ms
		.filter(|duration| *duration > MIN_DURATION_MS && facts.output > 0)
	{
		// TPS over the total request duration — the post-TTFT window
		// undercounts generation time when reasoning tokens are hidden
		// before the first visible byte, inflating the rate.
		separate(&mut line);
		#[allow(clippy::cast_precision_loss, reason = "display rounding only")]
		let tok_per_sec = facts.output as f64 / duration as f64 * 1_000.0;
		let _ = write!(line, "{} {tok_per_sec:.1}/s", charset.icon(Icon::Throughput));
	}
	line.freeze()
}

/// One blank row, then
/// the muted usage line inset by one cell.
#[must_use]
pub fn usage_block(facts: &UsageFacts, ui: &UiContext) -> Component {
	let line = usage_line(facts, ui);
	dom! {
		<col>
			<spacer/>
			<text fg=muted pad-x=1>{line}</text>
		</col>
	}
	.into_component()
}

/// `YYYY-MM-DD HH:mm:ss` in `zone`; `None` when the instant is out of range.
fn local_timestamp(ms: u64, zone: &TimeZone) -> Option<String> {
	let timestamp = Timestamp::from_millisecond(i64::try_from(ms).ok()?).ok()?;
	strtime::format(TIMESTAMP_FORMAT, &timestamp.to_zoned(zone.clone())).ok()
}

#[cfg(test)]
mod tests {
	use omp_tui::{Charset, Ui, frame_text};

	use super::*;

	fn ctx() -> UiContext {
		UiContext { charset: Charset::Unicode, ..UiContext::default() }
	}

	fn full() -> UsageFacts {
		UsageFacts {
			input:        11_500,
			output:       640,
			cache_read:   8_000,
			cache_write:  500,
			ttft_ms:      Some(800),
			duration_ms:  Some(4_200),
			completed_ms: Some(1_772_400_000_000),
			started_ms:   Some(1_772_400_000_000 - 4_200),
		}
	}

	#[test]
	fn usage_line_orders_parts_like_pi() {
		let ui = ctx();
		let charset = ui.charset;
		let line = usage_line(&full(), &ui);
		let parts: Vec<&str> = line.as_str().split("  ").collect();
		assert_eq!(parts.len(), 7, "{line}");
		assert_eq!(parts[0].len(), 19, "{line}");
		assert_eq!(parts[1], format!("{}Δ4.2s", charset.icon(Icon::Time)));
		assert_eq!(parts[2], format!("{} 12K", charset.icon(Icon::Input)));
		assert_eq!(parts[3], format!("{} 640", charset.icon(Icon::Output)));
		assert_eq!(parts[4], format!("{} 8K", charset.icon(Icon::Cache)));
		assert_eq!(parts[5], format!("{} 0.8s", charset.icon(Icon::Time)));
		assert_eq!(parts[6], format!("{} 152.4/s", charset.icon(Icon::Throughput)));
	}

	#[test]
	fn throughput_hidden_below_min_duration() {
		let ui = ctx();
		let throughput = ui.charset.icon(Icon::Throughput);
		let at =
			|duration_ms| usage_line(&UsageFacts { duration_ms: Some(duration_ms), ..full() }, &ui);
		assert!(!at(100).contains(throughput), "{}", at(100));
		assert!(at(101).contains(throughput), "{}", at(101));
		let silent = usage_line(&UsageFacts { output: 0, ..full() }, &ui);
		assert!(!silent.contains(throughput), "{silent}");
	}

	#[test]
	fn cache_read_omitted_when_zero() {
		let ui = ctx();
		let cache = ui.charset.icon(Icon::Cache);
		let line = usage_line(&UsageFacts { cache_read: 0, ..full() }, &ui);
		assert!(!line.contains(cache), "{line}");
		assert_eq!(line.split("  ").count(), 6, "{line}");
	}

	#[test]
	fn wait_badge_requires_both_timestamps() {
		let ui = ctx();
		let badge = format!("{}Δ", ui.charset.icon(Icon::Time));
		let no_start = usage_line(&UsageFacts { started_ms: None, ..full() }, &ui);
		assert!(!no_start.contains(&badge), "{no_start}");
		let no_end = usage_line(&UsageFacts { completed_ms: None, ..full() }, &ui);
		assert!(!no_end.contains(&badge), "{no_end}");
		assert!(!no_end.starts_with(char::is_numeric), "{no_end}");
		let reversed = UsageFacts { started_ms: Some(1_772_400_000_001), ..full() };
		assert!(!usage_line(&reversed, &ui).contains(&badge));
		assert!(usage_line(&full(), &ui).contains(&badge));
	}

	#[test]
	fn local_timestamp_is_zero_padded() {
		// 2026-03-02T01:02:05Z: every field below ten pads to two digits.
		let ms = 1_772_413_325_000;
		assert_eq!(local_timestamp(ms, &TimeZone::UTC).unwrap(), "2026-03-02 01:02:05");
		let local = local_timestamp(ms, &TimeZone::system()).unwrap();
		assert_eq!(local.len(), 19, "{local}");
		for (index, byte) in local.bytes().enumerate() {
			match index {
				4 | 7 => assert_eq!(byte, b'-', "{local}"),
				10 => assert_eq!(byte, b' ', "{local}"),
				13 | 16 => assert_eq!(byte, b':', "{local}"),
				_ => assert!(byte.is_ascii_digit(), "{local}"),
			}
		}
		assert!(local.ends_with(":05"), "{local}");
	}

	#[test]
	fn usage_block_paints_blank_row_then_inset_line() {
		let ui = ctx();
		let ui_frame = Ui::from_root(usage_block(&full(), &ui), 100, ui.clone());
		let text = frame_text(ui_frame.frame());
		let rows: Vec<&str> = text.lines().collect();
		assert_eq!(rows.len(), 2, "{text}");
		assert!(rows[0].trim().is_empty(), "{text}");
		assert_eq!(rows[1], format!(" {}", usage_line(&full(), &ui)), "{text}");
	}
}
