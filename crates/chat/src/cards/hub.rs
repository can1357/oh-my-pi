//! Typed card for peer, job, and named-process coordination.

use std::time::{SystemTime, UNIX_EPOCH};

use omp_core::{Str, sf};
use omp_dom::{Node, PropId};
use omp_tui::{IntoComponent as _, UiContext, dom};
use serde_json::Value;

use super::{Card, CardStatus, CardView, Component, elapsed_badge, typed_input};

/// Unified hub card; the `op` argument selects the compact presentation.
pub struct HubCard;

impl Card for HubCard {
	fn tool(&self) -> &'static str {
		"hub"
	}

	fn render(&self, view: &CardView<'_>, _expanded: bool, ui: &UiContext) -> Component {
		let args = typed_input::<omp_tools::hub::Params>(view);
		let raw = view.args_text().unwrap_or_default();
		let op = args
			.as_ref()
			.and_then(|value| string_at(value, "op"))
			.or_else(|| partial_string(raw, "op"));
		let has_ids = args
			.as_ref()
			.and_then(|value| value.get("ids"))
			.is_some_and(Value::is_array)
			|| raw.contains("\"ids\"");
		match (op, has_ids) {
			(Some("logs"), _) => render_logs(view, args.as_ref(), ui),
			(Some("send"), _) => render_send(view, args.as_ref(), raw),
			(Some("inbox"), _) => render_inbox(view, args.as_ref(), raw, false),
			(Some("wait"), true) | (Some("jobs" | "cancel"), _) => {
				render_jobs(view, args.as_ref(), raw, op == Some("cancel"))
			},
			(Some("wait"), false) => render_inbox(view, args.as_ref(), raw, true),
			(Some("list"), _) => render_roster(view),
			(Some("start" | "stop" | "restart" | "describe" | "ps"), _) => {
				render_process(view, args.as_ref(), raw, op.unwrap_or_default())
			},
			_ => render_generic(view),
		}
	}
}

/// Decodes the typed hub envelope first, then its model-facing JSON text.
/// Hub is intentionally a wrapper tool: unlike ordinary typed cards, its
/// operation-specific projection is nested in `Response::text`.
fn result_value(view: &CardView<'_>) -> Option<Value> {
	let response = view.result::<omp_tools::hub::Response>()?;
	serde_json::from_str(response.text.as_str())
		.ok()
		.or_else(|| Some(serde_json::json!({ "text": response.text })))
}

fn render_generic(view: &CardView<'_>) -> Component {
	let result = result_value(view);
	let detail = result
		.as_ref()
		.and_then(|value| {
			string_at(value, "detail")
				.or_else(|| string_at(value, "text"))
				.or_else(|| value.get("peers")?.as_array()?.first()?.get("id")?.as_str())
		})
		.map(Str::new);
	let fault = diag_text(view.diag);
	let icon = match view.status {
		CardStatus::Done => dom! { <i:check-button fg=ok/> }.into_component(),
		CardStatus::Failed => dom! { <i:error fg=err/> }.into_component(),
		CardStatus::StreamingArgs | CardStatus::InProgress => {
			dom! { <i:pending fg=output/> }.into_component()
		},
	};
	dom! {
		<col>
			<row gap=1>{icon}<text fg=accent>{"Hub"}</text>
				if let Some(badge) = elapsed_badge(view) { {badge} }
			</row>
			if let Some(detail) = detail { <text pad-x=2 fg=output>{detail}</text> }
			if let Some(fault) = fault { <text pad-x=2 fg=err>{fault}</text> }
		</col>
	}
	.into_component()
}

fn render_process(
	view: &CardView<'_>,
	args: Option<&Value>,
	raw: &str,
	fallback_op: &str,
) -> Component {
	let result = result_value(view);
	let op = args
		.and_then(|value| string_at(value, "op"))
		.or_else(|| partial_string(raw, "op"))
		.unwrap_or(fallback_op);
	let name = result
		.as_ref()
		.and_then(|value| string_at(value, "name"))
		.or_else(|| args.and_then(|value| string_at(value, "name")))
		.or_else(|| partial_string(raw, "name"))
		.unwrap_or_default();
	let command = result
		.as_ref()
		.and_then(|value| string_at(value, "command"))
		.map(Str::new)
		.or_else(|| command_from_args(args));
	let detail = result
		.as_ref()
		.and_then(|value| string_at(value, "detail"))
		.map(Str::new);
	let pid = result
		.as_ref()
		.and_then(|value| value.get("pid"))
		.and_then(Value::as_u64);
	let wall_ms = result
		.as_ref()
		.and_then(|value| value.get("wall_ms"))
		.and_then(Value::as_u64);
	let text = result
		.as_ref()
		.and_then(|value| string_at(value, "text"))
		.map(Str::new);
	let fault = diag_text(view.diag);
	let icon = match view.status {
		CardStatus::Done => dom! { <i:launch/> }.into_component(),
		CardStatus::Failed => dom! { <i:error/> }.into_component(),
		CardStatus::StreamingArgs | CardStatus::InProgress => {
			dom! { <spinner kind=status/> }.into_component()
		},
	};
	dom! {
		<col>
			<row gap=0>
				{icon}<text>{" "}</text><text fg=accent>{format!("Launch {op}")}</text><text>{":"}</text><text fg=output wrap=pre>{format!(" {name}")}</text>
				if view.status != CardStatus::Failed { if let Some(command) = command { <text fg=muted wrap=pre>{format!(" {command}")}</text> } }
				if let Some(detail) = detail { <text fg=muted>{detail}</text> }
				if let Some(pid) = pid { <text fg=muted>{"· pid"}</text><text fg=muted>{sf!("{pid}")}</text> }
				if let Some(wall_ms) = wall_ms { <text fg=muted>{"· up"}</text><time ms={wall_ms}/> }
				if let Some(badge) = elapsed_badge(view) { {badge} }
			</row>
			if let Some(text) = text { <text fg=muted>{text}</text> }
			if let Some(fault) = fault { <text fg=err>{fault}</text> }
		</col>
	}
	.into_component()
}

fn render_logs(view: &CardView<'_>, args: Option<&Value>, _ui: &UiContext) -> Component {
	let result = result_value(view);
	let logs = result.as_ref().and_then(|value| value.get("logs"));
	let name = logs
		.and_then(|value| string_at(value, "name"))
		.or_else(|| args.and_then(|value| string_at(value, "name")))
		.unwrap_or_default();
	let detail = logs
		.and_then(|value| string_at(value, "detail"))
		.map(Str::new);
	let text = logs
		.and_then(|value| string_at(value, "text"))
		.map(Str::new);
	match view.status {
		CardStatus::StreamingArgs | CardStatus::InProgress => {
			let follow = args
				.and_then(|value| value.get("follow"))
				.and_then(Value::as_bool)
				.unwrap_or(false);
			dom! {
				<row gap=0><spinner kind=status/><text>{" "}</text><text fg=accent>{"Launch logs"}</text><text>{":"}</text><text fg=output wrap=pre>{format!(" {name}")}</text>
					if follow { <text fg=muted wrap=pre>{" follow"}</text> }
					if let Some(badge) = elapsed_badge(view) { {badge} }
				</row>
			}
			.into_component()
		},
		CardStatus::Done => {
			dom! {
				<box border=round bc=muted title_pad=3 pad="0 1">
					<row kind=title gap=0><i:launch fg=accent/><text>{" "}</text><text fg=accent>{"Launch logs"}</text><text>{":"}</text>
						<text fg=output wrap=pre>{format!(" {name}")}</text>
						if let Some(detail) = detail { <text fg=ok wrap=pre>{format!(" {detail}")}</text> }
						<text>{" "}</text>
					</row>
					<hr title="Output" title_pad=3 bc=muted/>
					if let Some(text) = text { <pre fg=output>{text}</pre> }
				</box>
			}
			.into_component()
		},
		CardStatus::Failed => {
			let fault = diag_text(view.diag).unwrap_or_else(|| Str::new_static("operation failed"));
			dom! {
				<box border=round bc=err title_pad=3 pad="0 1">
					<row kind=title gap=0><i:error fg=err/><text>{" "}</text><text fg=accent>{"Launch logs"}</text><text>{":"}</text><text fg=output wrap=pre>{format!(" {name}")}</text><text>{" "}</text></row>
					<hr title="Output" title_pad=3 bc=err/><pre fg=err>{fault}</pre>
				</box>
			}
			.into_component()
		},
	}
}

fn render_send(view: &CardView<'_>, args: Option<&Value>, raw: &str) -> Component {
	let result = result_value(view);
	let sent = result.as_ref().and_then(|value| value.get("sent"));
	let mut to = Str::new(
		sent
			.and_then(|value| string_at(value, "to"))
			.or_else(|| args.and_then(|value| string_at(value, "to")))
			.or_else(|| partial_string(raw, "to"))
			.unwrap_or_default(),
	);
	let fault = diag_text(view.diag);
	if view.status == CardStatus::Failed
		&& let Some(recipient) = fault.as_deref().and_then(quoted_value)
	{
		to = Str::new(recipient);
	}
	let message = args
		.and_then(|value| string_at(value, "message"))
		.or_else(|| partial_string(raw, "message"))
		.filter(|text| !text.is_empty())
		.map(Str::new);
	let kind = if view.status == CardStatus::Done {
		sent
			.and_then(|value| string_at(value, "kind"))
			.map(Str::new)
	} else if view.status == CardStatus::Failed {
		Some(Str::new_static("failed"))
	} else if args
		.and_then(|value| value.get("await"))
		.and_then(Value::as_bool)
		.unwrap_or(false)
	{
		Some(Str::new_static("await reply"))
	} else {
		None
	};
	let reply = sent
		.and_then(|value| string_at(value, "text"))
		.map(Str::new);
	let icon = match view.status {
		CardStatus::Done => dom! { <i:irc fg=accent/> }.into_component(),
		CardStatus::Failed => dom! { <i:error fg=err/> }.into_component(),
		CardStatus::StreamingArgs | CardStatus::InProgress => {
			dom! { <i:pending fg=output/> }.into_component()
		},
	};
	dom! {
		<col>
			<row gap=1>{icon}<text fg=accent>{"IRC"}</text><i:selected fg=accent/><text fg=accent>{to.clone()}</text>
				if let Some(kind) = kind { <text fg=muted>{kind}</text> }
				if let Some(badge) = elapsed_badge(view) { {badge} }
			</row>
			if let Some(message) = message {
				<row gap=1 pad-x=2><i:tree-vertical fg=muted/><text fg=muted>{message}</text></row>
			}
			if let Some(reply) = reply {
				<row gap=1 pad-x=2><i:back fg=muted/><text fg=accent>{to.clone()}</text><text fg=muted>{"just now"}</text></row>
				<row gap=1 pad-x=2><i:tree-vertical fg=muted/><text fg=output>{reply}</text></row>
			}
			if let Some(fault) = fault {
				<row gap=1><i:tree-last fg=muted/><text fg=output>{to}</text><text fg=err>{"⟨failed⟩"}</text>
					<text fg=err>{"–"}</text><text fg=err>{fault}</text>
				</row>
			}
		</col>
	}
	.into_component()
}

fn render_inbox(view: &CardView<'_>, args: Option<&Value>, raw: &str, waiting: bool) -> Component {
	let result = result_value(view);
	let messages = result
		.as_ref()
		.and_then(|value| value.get("inbox"))
		.and_then(Value::as_array)
		.map(Vec::as_slice)
		.unwrap_or_default();
	let from = args
		.and_then(|value| string_at(value, "from"))
		.or_else(|| partial_string(raw, "from"))
		.map(Str::new);
	let peek = args
		.and_then(|value| value.get("peek"))
		.and_then(Value::as_bool)
		.unwrap_or(false);
	let timeout = args
		.and_then(|value| value.get("timeoutMs"))
		.and_then(Value::as_u64)
		.map(format_timeout);
	let fault = diag_text(view.diag);
	let count = messages.len();
	let mut rows = Vec::with_capacity(messages.len());
	for (index, message) in messages.iter().enumerate() {
		let sender = Str::new(string_at(message, "from").unwrap_or_default());
		let text = Str::new(string_at(message, "text").unwrap_or_default());
		let age = relative_age(message);
		let kind = string_at(message, "kind").map(Str::new);
		let last = index + 1 == messages.len();
		if waiting {
			rows.push(
				dom! { <row gap=1><i:tree-vertical fg=muted/><text fg=output>{text}</text></row> }
					.into_component(),
			);
		} else {
			rows.push(
				dom! {
					<col>
						<row gap=1>
							if last { <i:tree-last fg=muted/> } else { <i:tree-branch fg=muted/> }
							<text fg=accent>{sender}</text>
							if let Some(age) = age { <time fg=muted ms={age} kind="relative"/> }
							if let Some(kind) = kind { <text fg=muted>{sf!("⟨{kind}⟩")}</text> }
						</row>
						if last {
							<row gap=1 pad-x=3><i:tree-vertical fg=muted/><text fg=output>{text}</text></row>
						} else {
							<row gap=0><i:tree-vertical fg=muted/><row gap=1 pad-x=2><i:tree-vertical fg=muted/><text fg=output>{text}</text></row></row>
						}
					</col>
				}
				.into_component(),
			);
		}
	}
	let icon = match view.status {
		CardStatus::Done => dom! { <i:irc fg=accent/> }.into_component(),
		CardStatus::Failed if waiting => dom! { <i:warning-status fg=warn/> }.into_component(),
		CardStatus::Failed => dom! { <i:error fg=err/> }.into_component(),
		CardStatus::StreamingArgs | CardStatus::InProgress => {
			dom! { <i:pending fg=output/> }.into_component()
		},
	};
	dom! {
		<col pad-x=1>
			<row gap=1>{icon}<text fg=accent>{"IRC"}</text>
				if let Some(from) = from.clone() { <i:back fg=accent/><text fg=accent>{from}</text> } else { <text fg=accent>{"inbox"}</text> }
				if count > 0 && !waiting { <text fg=muted>{sf!("{count}")}</text><text fg=muted>{"messages ·"}</text> }
				if peek { <text fg=muted>{"peek"}</text> }
				if view.status == CardStatus::Done && waiting { <text fg=muted>{"just now"}</text> }
				if view.status == CardStatus::Failed && waiting { <text fg=muted>{"timed out"}</text> }
				if matches!(view.status, CardStatus::StreamingArgs | CardStatus::InProgress) && waiting {
					if let Some(timeout) = timeout { <text fg=muted>{"timeout"}</text><text fg=muted>{timeout}</text> }
				}
				if let Some(badge) = elapsed_badge(view) { {badge} }
			</row>
			if !rows.is_empty() {
				if waiting { <col pad-x=2>{rows}</col> } else { <col>{rows}</col> }
			}
			if let Some(fault) = fault {
				if waiting {
					<row gap=1 pad-x=2><text fg=err>{"Error:"}</text><text fg=err>{fault}</text></row>
				} else {
					<text fg=err pad-x=2>{fault}</text>
				}
			}
		</col>
	}
	.into_component()
}

fn render_roster(view: &CardView<'_>) -> Component {
	let result = result_value(view);
	let peers = result
		.as_ref()
		.and_then(|value| value.get("peers"))
		.and_then(Value::as_array)
		.map(Vec::as_slice)
		.unwrap_or_default();
	let idle = peers
		.iter()
		.filter(|peer| string_at(peer, "status") == Some("idle"))
		.count();
	let parked = peers
		.iter()
		.filter(|peer| string_at(peer, "status") == Some("parked"))
		.count();
	let unread: u64 = peers
		.iter()
		.filter_map(|peer| peer.get("unread").and_then(Value::as_u64))
		.sum();
	let mut rows = Vec::with_capacity(peers.len());
	for (index, peer) in peers.iter().enumerate() {
		let id = Str::new(string_at(peer, "id").unwrap_or_default());
		let status = string_at(peer, "status").unwrap_or_default();
		let kind = string_at(peer, "kind").map(Str::new);
		let detail = string_at(peer, "detail").map(Str::new);
		let count = peer.get("unread").and_then(Value::as_u64).unwrap_or(0);
		let age = relative_age(peer);
		let last = index + 1 == peers.len();
		rows.push(
			dom! {
				<row gap=1>
					if last { <i:tree-last fg=muted/> } else { <i:tree-branch fg=muted/> }
					if status == "parked" { <i:unselected fg=output/> } else { <i:bullet fg=ok/> }
					<text fg={if status == "parked" { "output" } else { "ok" }}>{status}</text><text fg=accent>{id}</text>
					if let Some(kind) = kind { <text fg=muted>{kind}</text> }
					if let Some(detail) = detail { <text fg=muted>{detail}</text> }
					if count > 0 { <text fg=warning>{sf!("⟨{count} unread⟩")}</text> }
					if let Some(age) = age { <time ms={age} kind="relative"/> }
				</row>
			}
			.into_component(),
		);
	}
	let fault = diag_text(view.diag);
	let icon = match view.status {
		CardStatus::Done => dom! { <i:irc fg=accent/> }.into_component(),
		CardStatus::Failed => dom! { <i:error fg=err/> }.into_component(),
		CardStatus::StreamingArgs | CardStatus::InProgress => {
			dom! { <i:pending fg=output/> }.into_component()
		},
	};
	dom! {
		<col pad-x=1>
			<row gap=1>{icon}<text fg=accent>{"IRC peers"}</text>
				if !peers.is_empty() {
					<text fg=muted>{sf!("{idle} idle · {parked} parked · ")}</text><text fg=warn>{sf!("{unread} unread")}</text>
				}
				if let Some(badge) = elapsed_badge(view) { {badge} }
			</row>
			if !rows.is_empty() { <col>{rows}</col> }
			if let Some(fault) = fault { <text fg=err pad-x=2>{fault}</text> }
		</col>
	}
	.into_component()
}

/// Job snapshots for `wait`/`jobs` and the `cancel` receipt: `cancel` is a
/// job-style op whose
/// pending frame reads `cancel <id>` and whose result counts the cancelled
/// rows instead of falling back to the generic card).
fn render_jobs(view: &CardView<'_>, args: Option<&Value>, raw: &str, cancel: bool) -> Component {
	let result = result_value(view);
	let jobs = result
		.as_ref()
		.and_then(|value| value.get("jobs"))
		.and_then(Value::as_array)
		.map(Vec::as_slice)
		.unwrap_or_default();
	let ids = args
		.and_then(|value| value.get("ids"))
		.and_then(Value::as_array)
		.map(Vec::as_slice)
		.unwrap_or_default();
	let verb = if cancel { "cancel" } else { "poll" };
	if matches!(view.status, CardStatus::StreamingArgs | CardStatus::InProgress) {
		let count = ids.len();
		let partial_id = partial_first_array_string(raw, "ids");
		return dom! {
			<row gap=1><i:pending fg=output/><text fg=accent>{verb}</text>
				if count == 1 { <text>{ids[0].as_str().unwrap_or_default()}</text> }
				else if count > 1 { <text>{sf!("{count}")}</text><text>{"jobs"}</text> }
				else if let Some(id) = partial_id { <text>{id}</text> }
				if let Some(badge) = elapsed_badge(view) { {badge} }
			</row>
		}
		.into_component();
	}
	if cancel && jobs.is_empty() {
		return render_cancel_receipt(view, result.as_ref(), ids);
	}
	let ok_count = jobs
		.iter()
		.filter(|job| string_at(job, "status") != Some("failed"))
		.count();
	let failed_count = jobs.len().saturating_sub(ok_count);
	let mut rows = Vec::with_capacity(jobs.len());
	for (index, job) in jobs.iter().enumerate() {
		let failed = string_at(job, "status") == Some("failed");
		let id = Str::new(string_at(job, "id").unwrap_or_default());
		let kind = string_at(job, "kind").map(Str::new);
		let label = string_at(job, "label").map(Str::new);
		let text = string_at(job, "text").map(Str::new);
		let wall_ms = job.get("wall_ms").and_then(Value::as_u64);
		let last = index + 1 == jobs.len();
		rows.push(
			dom! {
				<col>
					<row gap=1>
						if last { <i:tree-last fg=muted/> } else { <i:tree-branch fg=muted/> }
						if failed { <i:error fg=err/> } else { <i:done fg=ok/> }
						<text fg=output>{id}</text>
						if let Some(kind) = kind { <text fg={if failed { "err" } else { "ok" }}>{sf!("⟨{kind}⟩")}</text> }
						if let Some(label) = label { <text fg=output>{label}</text> }
						if let Some(wall_ms) = wall_ms { <time ms={wall_ms}/> }
					</row>
					if let Some(text) = text {
						if last {
							<text fg=muted pad-x=5>{text}</text>
						} else {
							<row gap=0><i:tree-vertical/><text fg=muted pad-x=4>{text}</text></row>
						}
					}
				</col>
			}
			.into_component(),
		);
	}
	let count = jobs.len();
	let settled = if count == 1 {
		"1 job settled".into()
	} else {
		sf!("{count} jobs settled")
	};
	dom! {
		<col>
			<row gap=1><i:warning-status fg=warn/><text fg=accent>{settled}</text>
				if ok_count > 0 { <text fg=ok>{sf!("{ok_count} done")}</text> }
				if failed_count > 0 {
					if ok_count > 0 { <text>{"·"}</text> }
					<text fg=err>{sf!("{failed_count} failed")}</text>
				}
			</row>
			if !rows.is_empty() { <col>{rows}</col> }
		</col>
	}
	.into_component()
}

/// Settled `cancel` without job rows: the backend answers `{cancelled: N}`,
/// so the card lists the requested ids under the count as warning-tinted
/// metadata beside the title.
fn render_cancel_receipt(view: &CardView<'_>, result: Option<&Value>, ids: &[Value]) -> Component {
	let requested = ids.len();
	let title = match ids {
		[only] => sf!("cancel {}", only.as_str().unwrap_or_default()),
		_ => sf!("cancel {requested} jobs"),
	};
	let cancelled = result
		.and_then(|value| value.get("cancelled"))
		.and_then(Value::as_u64)
		.and_then(|count| usize::try_from(count).ok());
	let failed = view.status == CardStatus::Failed;
	let fault = failed.then(|| diag_text(view.diag)).flatten();
	let partial = cancelled.is_some_and(|count| count < requested);
	let id_rows = ids
		.iter()
		.filter_map(Value::as_str)
		.map(Str::new)
		.collect::<Vec<_>>();
	let last_index = id_rows.len().saturating_sub(1);
	dom! {
		<col>
			<row gap=1>
				if failed { <i:error/> }
				else if partial || cancelled.is_none() { <i:warning-status/> }
				else { <i:done/> }
				<text bold>{title}</text>
				if let Some(count) = cancelled {
					<text fg=warning>{sf!("{count}")}</text><text fg=warning>{"cancelled"}</text>
					if partial {
						<text fg=muted>{"·"}</text>
						<text fg=muted>{sf!("{}", requested - count)}</text><text fg=muted>{"not found"}</text>
					}
				}
			</row>
			if let Some(fault) = fault { <text fg=error pad-x=2>{fault}</text> }
			else {
				for (index, id) in id_rows.into_iter().enumerate() {
					<row gap=1>
						if index == last_index { <i:tree-last/> } else { <i:tree-branch/> }
						<i:cancelled/><text>{id}</text>
					</row>
				}
			}
		</col>
	}
	.into_component()
}

fn command_from_args(args: Option<&Value>) -> Option<Str> {
	let args = args?;
	let application = string_at(args, "application")?;
	let mut command = application.to_owned();
	if let Some(argv) = args.get("args").and_then(Value::as_array) {
		for arg in argv.iter().filter_map(Value::as_str) {
			command.push(' ');
			command.push_str(arg);
		}
	}
	Some(Str::new(command))
}

fn string_at<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
	value.get(key).and_then(Value::as_str)
}

fn partial_string<'a>(json: &'a str, key: &str) -> Option<&'a str> {
	let marker = sf!("\"{key}\":\"");
	let start = json.find(marker.as_str())? + marker.len();
	let rest = &json[start..];
	Some(rest.split('"').next().unwrap_or(rest))
}

fn partial_first_array_string<'a>(json: &'a str, key: &str) -> Option<&'a str> {
	let marker = sf!("\"{key}\":[\"");
	let start = json.find(marker.as_str())? + marker.len();
	let rest = &json[start..];
	Some(rest.split('"').next().unwrap_or(rest))
}

fn quoted_value(text: &str) -> Option<&str> {
	let (_, tail) = text.split_once('"')?;
	Some(tail.split('"').next().unwrap_or(tail))
}

fn relative_age(value: &Value) -> Option<u64> {
	if let Some(age) = value.get("age_ms").and_then(Value::as_u64) {
		return Some(age);
	}
	let timestamp = value.get("ts").and_then(Value::as_u64)?;
	let now = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.ok()
		.and_then(|duration| u64::try_from(duration.as_millis()).ok())?;
	Some(now.saturating_sub(timestamp))
}

fn format_timeout(ms: u64) -> Str {
	if ms >= 60_000 && ms.is_multiple_of(60_000) {
		sf!("{}m", ms / 60_000)
	} else if ms >= 1_000 {
		sf!("{}.{:01}s", ms / 1_000, (ms % 1_000) / 100)
	} else {
		sf!("{ms}ms")
	}
}

fn diag_text(node: Option<&Node>) -> Option<Str> {
	node.and_then(|node| {
		node.content.clone().or_else(|| {
			node
				.prop(&PropId::Text.into())
				.and_then(|value| value.as_str())
				.map(Str::new)
		})
	})
}
