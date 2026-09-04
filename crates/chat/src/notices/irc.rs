//! Replay-stable IRC transcript cards projected from typed journal payloads.

use std::time::{SystemTime, UNIX_EPOCH};

use omp_core::{Str, StrMut};
use omp_dom::{Node, PropId, Value};
use omp_journal::data::{IrcDirection, IrcTraffic};
use omp_tui::{IntoComponent as _, components::hr::truncate_to_width, dom};
use smallvec::SmallVec;

use super::workpool;
use crate::cards::Component;

const COLLAPSED_LINES: usize = 3;
const EXPANDED_LINES: usize = 12;
const BODY_LINE_WIDTH: u16 = 100;

/// Reads an IRC payload from its journal-derived notice node.
#[must_use]
pub(crate) fn traffic(node: &Node) -> Option<IrcTraffic> {
	if node.prop(&PropId::Kind.into()).and_then(Value::as_str) != Some("irc") {
		return None;
	}
	let Value::Json(data) = node.prop(&PropId::Data.into())? else {
		return None;
	};
	serde_json::from_str(data.get()).ok()
}

/// Plain-text projection used by transcript dumps and block identity.
#[must_use]
pub(crate) fn traffic_text(traffic: &IrcTraffic) -> Str {
	let mut text = StrMut::new("");
	text.push_str(title_text(traffic).as_str());
	let meta = meta_parts(traffic);
	for (index, part) in meta.iter().enumerate() {
		if index == 0 {
			text.push(' ');
		} else {
			text.push_str(" · ");
		}
		text.push_str(part.as_str());
	}
	if !traffic.body.trim().is_empty() {
		text.push('\n');
		text.push_str(traffic.body.as_str());
	}
	text.freeze()
}

/// Direction-specific IRC card with a three-line folded body and twelve-line
/// expanded body.
#[must_use]
pub(crate) fn traffic_card(traffic: &IrcTraffic, expanded: bool) -> Component {
	if let Some(observation) = workpool::observation(traffic) {
		return workpool::transition_card(&observation, expanded, age(traffic.timestamp_ms));
	}
	if let Some(result) = workpool::batch_result(traffic) {
		return workpool::result_card(traffic, &result, expanded, age(traffic.timestamp_ms));
	}
	let from = trimmed_or(traffic.from.as_ref(), "?");
	let to = trimmed_or(traffic.to.as_ref(), "?");
	let pool = trimmed_or(traffic.pool.as_ref(), "?");
	let title = match traffic.direction {
		IrcDirection::Incoming => {
			dom! { <row gap=1 fg=accent><text>{"IRC"}</text><i:back/><text>{from}</text></row> }
				.into_component()
		},
		IrcDirection::Autoreply => {
			dom! { <row gap=1 fg=accent><text>{"IRC"}</text><i:selected/><text>{to}</text></row> }
				.into_component()
		},
		IrcDirection::Relay => {
			dom! { <row gap=1 fg=accent><text>{"IRC"}</text><text>{from}</text><i:selected/><text>{to}</text></row> }
				.into_component()
		},
		IrcDirection::Workpool => {
			dom! { <row gap=1 fg=accent><text>{"Pool"}</text><text>{pool}</text><i:selected/><text>{to}</text></row> }
				.into_component()
		},
	};
	let meta = meta_parts(traffic);
	let body = body_rows(traffic.body.as_str(), expanded);
	dom! {
		<col pad-x=1>
			<row gap=1><i:irc fg=accent/>{title}
				if !meta.is_empty() {
					<row gap=0 fg=muted dim>
						for (index, part) in meta.iter().enumerate() {
							if index > 0 { <i:dot/> }
							<text>{part.clone()}</text>
						}
					</row>
				}
			</row>
			if !body.is_empty() { <col pad-x=2>{body}</col> }
		</col>
	}
	.into_component()
}

fn trimmed_or(value: Option<&Str>, fallback: &'static str) -> Str {
	value
		.map(Str::as_str)
		.map(str::trim)
		.filter(|value| !value.is_empty())
		.map_or_else(|| Str::new_static(fallback), header_text)
}

fn header_text(value: &str) -> Str {
	if value.contains(['\r', '\n']) {
		Str::new(value.replace("\r\n", " ").replace(['\r', '\n'], " "))
	} else {
		Str::new(value)
	}
}

fn title_text(traffic: &IrcTraffic) -> Str {
	let from = trimmed_or(traffic.from.as_ref(), "?");
	let to = trimmed_or(traffic.to.as_ref(), "?");
	let pool = trimmed_or(traffic.pool.as_ref(), "?");
	let mut title = StrMut::new("");
	match traffic.direction {
		IrcDirection::Incoming => {
			title.push_str("IRC ⟵ ");
			title.push_str(from.as_str());
		},
		IrcDirection::Autoreply => {
			title.push_str("IRC ➤ ");
			title.push_str(to.as_str());
		},
		IrcDirection::Relay => {
			title.push_str("IRC ");
			title.push_str(from.as_str());
			title.push_str(" ➤ ");
			title.push_str(to.as_str());
		},
		IrcDirection::Workpool => {
			title.push_str("Pool ");
			title.push_str(pool.as_str());
			title.push_str(" ➤ ");
			title.push_str(to.as_str());
		},
	}
	title.freeze()
}

fn meta_parts(traffic: &IrcTraffic) -> SmallVec<Str, 4> {
	let mut meta = SmallVec::new();
	if traffic.direction == IrcDirection::Autoreply {
		meta.push(Str::new_static("auto"));
	}
	if traffic.direction == IrcDirection::Workpool
		&& let Some(mode) = traffic
			.mode
			.as_ref()
			.map(Str::as_str)
			.map(str::trim)
			.filter(|mode| !mode.is_empty())
	{
		meta.push(header_text(mode));
	}
	if traffic
		.reply_to
		.as_ref()
		.is_some_and(|reply| !reply.trim().is_empty())
	{
		meta.push(Str::new_static("reply"));
	}
	meta.push(age(traffic.timestamp_ms));
	meta
}

fn age(timestamp_ms: u64) -> Str {
	let now = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.ok()
		.and_then(|duration| u64::try_from(duration.as_millis()).ok())
		.unwrap_or(timestamp_ms);
	let seconds = now.saturating_sub(timestamp_ms).saturating_add(500) / 1_000;
	let seconds = seconds.max(1);
	let minutes = seconds / 60;
	let hours = minutes / 60;
	let days = hours / 24;
	let weeks = days / 7;
	let months = days / 30;
	if months > 0 {
		omp_core::sf!("{months}mo ago")
	} else if weeks > 0 {
		omp_core::sf!("{weeks}w ago")
	} else if days > 0 {
		omp_core::sf!("{days}d ago")
	} else if hours > 0 {
		omp_core::sf!("{hours}h ago")
	} else if minutes > 0 {
		omp_core::sf!("{minutes}m ago")
	} else {
		Str::new_static("just now")
	}
}

fn body_rows(body: &str, expanded: bool) -> Vec<Component> {
	let max = if expanded {
		EXPANDED_LINES
	} else {
		COLLAPSED_LINES
	};
	let nonempty = body
		.lines()
		.filter(|line| !line.trim().is_empty())
		.collect::<Vec<_>>();
	let shown = nonempty.len().min(max);
	let mut rows = Vec::with_capacity(shown + usize::from(nonempty.len() > shown));
	for line in nonempty.iter().take(shown) {
		let line = preview_line(line);
		rows.push(
			dom! {
				<row gap=1><i:quote-border fg=muted/><text fg=output truncate=end>{line}</text></row>
			}
			.into_component(),
		);
	}
	let hidden = nonempty.len().saturating_sub(shown);
	if hidden > 0 {
		let label = if hidden == 1 {
			omp_core::sf!("… +{hidden} more line")
		} else {
			omp_core::sf!("… +{hidden} more lines")
		};
		rows.push(
			dom! {
				<row gap=1><i:quote-border fg=muted/><text fg=muted dim>{label}</text></row>
			}
			.into_component(),
		);
	}
	rows
}

fn preview_line(line: &str) -> Str {
	let line = line.trim().replace('\t', "   ");
	let clipped = truncate_to_width(&line, BODY_LINE_WIDTH);
	if clipped.ellipsis {
		let mut out = StrMut::new(clipped.text);
		out.push('…');
		out.freeze()
	} else {
		Str::new(line)
	}
}

#[cfg(test)]
mod tests {
	use omp_dom::{KnownTag, Tag};
	use omp_tui::{Ui, UiContext, frame_text};
	use smallvec::smallvec;

	use super::*;

	fn node(traffic: &IrcTraffic) -> Node {
		Node {
			tag:     Tag::Known(KnownTag::Notice),
			props:   smallvec![
				(PropId::Kind.into(), Value::Str(Str::new_static("irc"))),
				(
					PropId::Data.into(),
					Value::Json(serde_json::value::to_raw_value(traffic).expect("typed payload")),
				),
			],
			kids:    Vec::new(),
			content: Some(traffic.body.clone()),
		}
	}

	fn render(component: Component) -> String {
		let ui = Ui::from_root(component, 120, UiContext::default());
		frame_text(ui.frame())
	}

	#[test]
	fn incoming_card_uses_pi_header_and_folded_body() {
		let payload = IrcTraffic {
			direction:    IrcDirection::Incoming,
			from:         Some(Str::new_static("Scout")),
			to:           Some(Str::new_static("Main")),
			body:         Str::new_static("one\ntwo\nthree\nfour\nfive"),
			reply_to:     Some(Str::new_static("01K4A")),
			pool:         None,
			mode:         None,
			timestamp_ms: u64::MAX,
		};
		assert_eq!(traffic(&node(&payload)), Some(payload.clone()));
		let folded = render(traffic_card(&payload, false));
		assert!(folded.contains("✉ IRC ⟵ Scout reply · just now"), "{folded:?}");
		assert!(folded.contains("▏ one"), "{folded:?}");
		assert!(folded.contains("▏ three"), "{folded:?}");
		assert!(folded.contains("▏ … +2 more lines"), "{folded:?}");
		assert!(!folded.contains("four"), "{folded:?}");
		let expanded = render(traffic_card(&payload, true));
		assert!(expanded.contains("▏ five"), "{expanded:?}");
		assert!(!expanded.contains("more lines"), "{expanded:?}");
	}

	#[test]
	fn direction_headers_match_pi() {
		let cases = [
			(IrcDirection::Incoming, "IRC ⟵ from"),
			(IrcDirection::Autoreply, "IRC ➤ to"),
			(IrcDirection::Relay, "IRC from ➤ to"),
			(IrcDirection::Workpool, "Pool audit ➤ to"),
		];
		for (direction, expected) in cases {
			let traffic = IrcTraffic {
				direction,
				from: Some(Str::new_static("from")),
				to: Some(Str::new_static("to")),
				body: Str::new_static("body"),
				reply_to: None,
				pool: Some(Str::new_static("audit")),
				mode: Some(Str::new_static("parallel")),
				timestamp_ms: u64::MAX,
			};
			let rendered = render(traffic_card(&traffic, false));
			assert!(rendered.contains(expected), "{direction:?}: {rendered:?}");
		}
	}
}
