//! Workpool-specific transcript cards.
//!
//! Scheduling transitions are display-only journal observations; worker batch
//! results remain ordinary authenticated IRC so the model receives them once.
//! Both shapes render through this module without becoming a second source of
//! pool state.

use std::fmt::Write as _;

use omp_core::{Str, sf};
use omp_journal::data::{IrcDirection, IrcTraffic, WorkpoolMode, WorkpoolObservation};
use omp_tui::{IntoComponent as _, dom};

use crate::cards::Component;

const COLLAPSED_ITEMS: usize = 3;
const EXPANDED_ITEMS: usize = 12;
const COLLAPSED_RESULT_LINES: usize = 3;
const EXPANDED_RESULT_LINES: usize = 12;

/// Parsed, producer-authenticated scheduling transition.
pub(super) fn observation(traffic: &IrcTraffic) -> Option<WorkpoolObservation> {
	WorkpoolObservation::try_from(traffic).ok()
}

/// A strict worker-result header emitted by `WorkpoolProducer` on the ordinary
/// peer path.
pub(super) struct BatchResult<'a> {
	batch:  &'a str,
	status: &'a str,
	output: &'a str,
}

/// Recognizes the scheduler's stable `Batch ID completed|failed` envelope.
/// General IRC prose is intentionally not guessed into a workpool result.
pub(super) fn batch_result(traffic: &IrcTraffic) -> Option<BatchResult<'_>> {
	if traffic.direction != IrcDirection::Incoming || traffic.reply_to.is_none() {
		return None;
	}
	let mut lines = traffic.body.lines();
	let header = lines.next()?.trim();
	let mut words = header.split_whitespace();
	if words.next()? != "Batch" {
		return None;
	}
	let batch = words.next()?;
	let status = words.next()?;
	if words.next().is_some() || !matches!(status, "completed" | "failed" | "cancelled") {
		return None;
	}
	let output = traffic
		.body
		.as_str()
		.strip_prefix(header)?
		.trim_start_matches(|ch| matches!(ch, '\r' | '\n'));
	Some(BatchResult { batch, status, output })
}

/// Typed scheduling transition card. Each journal entry remains one immutable
/// transcript block; its mode describes the pool/worker/item state at that
/// exact point in producer order.
pub(super) fn transition_card(
	observation: &WorkpoolObservation,
	expanded: bool,
	age: Str,
) -> Component {
	let pool = observation.pool.clone();
	let worker = observation.to.clone();
	let state: &'static str = if observation.mode == WorkpoolMode::Dispatched {
		"running"
	} else {
		observation.mode.into()
	};
	let terminal = matches!(observation.mode, WorkpoolMode::Completed | WorkpoolMode::Cancelled);
	let failed = observation.mode == WorkpoolMode::Cancelled;
	let items = item_lines(observation.body.as_str());
	let max = if expanded {
		EXPANDED_ITEMS
	} else {
		COLLAPSED_ITEMS
	};
	let shown = items.len().min(max);
	let hidden = items.len().saturating_sub(shown);
	let mut rows = Vec::with_capacity(shown + usize::from(hidden > 0));
	for (index, (id, text)) in items.into_iter().take(shown).enumerate() {
		let last = index + 1 == shown && hidden == 0;
		rows.push(
			dom! {
				<row gap=1 pad-x=1>
					if last { <i:tree-last fg=muted/> } else { <i:tree-branch fg=muted/> }
					if observation.mode == WorkpoolMode::Queued { <i:pending fg=muted/> }
					else { <i:pending fg=output/> }
					<text fg=accent>{id}</text><text fg=output truncate=end>{text}</text>
					<text fg=muted>{sf!("⟨{state}⟩")}</text>
				</row>
			}
			.into_component(),
		);
	}
	if hidden > 0 {
		rows.push(
			dom! { <row gap=1 pad-x=1><i:tree-last fg=muted/><text fg=muted>{sf!("… {hidden} more items")}</text></row> }
				.into_component(),
		);
	}
	let body = (!terminal && rows.is_empty() && !observation.body.trim().is_empty())
		.then(|| Str::new(observation.body.trim()));
	dom! {
		<box border=round bc={if failed { "err" } else if terminal { "muted" } else { "accent" }} bg={if failed { "error_surface" } else { "panel" }} bleed pad-x=1 title_pad=3>
			<row kind=title gap=1>
				if observation.mode == WorkpoolMode::Completed { <i:done fg=ok/> }
				else if observation.mode == WorkpoolMode::Cancelled { <i:cancelled fg=warn/> }
				else { <i:package fg=accent/> }
				<text fg=accent>{"Pool"}</text><text bold>{pool}</text>
				if !terminal { <i:selected fg=accent/><text fg=accent>{worker}</text> }
				<text fg={if failed { "err" } else { "muted" }}>{sf!("⟨{state}⟩")}</text>
				if observation.reply_to.is_some() { <text fg=muted>{"reply"}</text> }
				<text fg=muted>{age}</text>
			</row>
			if let Some(body) = body { <text pad-x=2 fg=output>{body}</text> }
			{rows}
			if terminal && !observation.body.trim().is_empty() {
				<text pad-x=2 fg={if failed { "err" } else { "output" }}>{observation.body.clone()}</text>
			}
		</box>
	}
	.into_component()
}

/// Worker batch result/error card. The authenticated peer remains the sender;
/// the card only projects its retained ordinary-IRC body.
pub(super) fn result_card(
	traffic: &IrcTraffic,
	result: &BatchResult<'_>,
	expanded: bool,
	age: Str,
) -> Component {
	let worker = traffic
		.from
		.clone()
		.unwrap_or_else(|| Str::new_static("worker"));
	let batch = Str::new(result.batch);
	let status = result.status;
	let failed = status != "completed";
	let output = result_preview(
		result.output,
		if expanded {
			EXPANDED_RESULT_LINES
		} else {
			COLLAPSED_RESULT_LINES
		},
	);
	dom! {
		<box border=round bc={if failed { "err" } else { "muted" }} bg={if failed { "error_surface" } else { "panel" }} bleed pad-x=1 title_pad=3>
			<row kind=title gap=1>
				if failed { <i:error fg=err/> } else { <i:done fg=ok/> }
				<text fg=accent>{"Batch"}</text><text bold>{batch}</text>
				<text fg={if failed { "err" } else { "ok" }}>{sf!("⟨{status}⟩")}</text>
				<text fg=muted>{sf!("⟨{worker}⟩")}</text><text fg=muted>{"reply"}</text><text fg=muted>{age}</text>
			</row>
			if !output.is_empty() {
				<hr title={if failed { "Error" } else { "Result" }} title_pad=3 bc={if failed { "err" } else { "muted" }}/>
				if output.starts_with("artifact://") && !output.contains('\n') { <a href={output.clone()}>{output}</a> }
				else { <pre fg={if failed { "err" } else { "output" }}>{output}</pre> }
			}
		</box>
	}
	.into_component()
}

fn item_lines(body: &str) -> Vec<(Str, Str)> {
	body
		.lines()
		.filter_map(|line| {
			let line = line.trim();
			let rest = line.strip_prefix('[')?;
			let (id, text) = rest.split_once("] ")?;
			(!id.is_empty() && !text.trim().is_empty()).then(|| (Str::new(id), Str::new(text.trim())))
		})
		.collect()
}

fn result_preview(text: &str, max: usize) -> Str {
	let text = text.trim_end();
	let lines = text.lines().collect::<Vec<_>>();
	let shown = lines.len().min(max);
	let hidden = lines.len().saturating_sub(shown);
	let mut output = lines.into_iter().take(shown).collect::<Vec<_>>().join("\n");
	if hidden > 0 {
		let _ = write!(output, "\n… {hidden} more lines");
	}
	Str::new(output)
}
