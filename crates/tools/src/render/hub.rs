//! Native hub renderer: IRC rosters, jobs, processes, logs, and messages.

use std::time::{SystemTime, UNIX_EPOCH};

use omp_core::{Str, sf};
use omp_tool::{CallOutcome, ToolIdentity, render::RenderFold};

use super::{
	fault_view, live_view,
	view::{El, Prop, Tag},
};
use crate::{
	gallery::RendererGalleryFixture,
	hub::{Fault as HubFault, Response as HubResponse},
	view,
};

#[derive(Default)]
struct HubArgsState {
	op:          Option<Str>,
	to:          Option<Str>,
	from:        Option<Str>,
	name:        Option<Str>,
	message:     Option<Str>,
	command:     Option<Str>,
	ids:         usize,
	cursor:      Option<u64>,
	await_reply: bool,
	complete:    bool,
}

#[derive(Default)]
pub(super) struct HubState {
	latest: Option<HubResponse>,
	args:   HubArgsState,
}

pub(super) struct HubRenderer;

impl RenderFold for HubRenderer {
	type Outcome = CallOutcome<HubResponse, HubFault>;
	type State = HubState;
	type Update = HubResponse;

	fn fold(&self, state: &mut Self::State, update: Self::Update) {
		state.latest = Some(update);
	}

	fn fold_args(&self, state: &mut Self::State, args: &omp_core::slopjson::Value, complete: bool) {
		let string = |key| {
			args
				.get(key)
				.and_then(omp_core::slopjson::Value::as_str)
				.map(Str::from)
		};
		let application = args
			.get("application")
			.and_then(omp_core::slopjson::Value::as_str);
		let command = application.map(|application| {
			let mut command = String::from(application);
			if let Some(values) = args
				.get("args")
				.and_then(omp_core::slopjson::Value::as_array)
			{
				for value in values {
					if let Some(value) = value.as_str() {
						command.push(' ');
						command.push_str(value);
					}
				}
			}
			Str::from(command)
		});
		state.args = HubArgsState {
			op: string("op"),
			to: string("to"),
			from: string("from"),
			name: string("name"),
			message: string("message"),
			command,
			ids: args
				.get("ids")
				.and_then(omp_core::slopjson::Value::as_array)
				.map_or(0, |ids| ids.len()),
			cursor: args
				.get("cursor")
				.and_then(omp_core::slopjson::Value::as_u64),
			await_reply: args
				.get("await")
				.and_then(omp_core::slopjson::Value::as_bool)
				.unwrap_or(false),
			complete,
		};
	}

	fn view(&self, state: &Self::State, outcome: Option<&Self::Outcome>) -> Option<Str> {
		match outcome {
			None => state
				.latest
				.as_ref()
				.and_then(|response| render_hub_response_with_args(response, Some(&state.args)))
				.or_else(|| render_hub_args(&state.args))
				.or_else(|| Some(live_view("hub", "waiting for peer, job, or process activity")))
				.map(Into::into),
			Some(CallOutcome::Ok(response)) => {
				render_hub_response_with_args(response, Some(&state.args)).map(Into::into)
			},
			Some(CallOutcome::Faulted(fault)) => Some(fault_view("hub", &fault.message).into()),
			Some(CallOutcome::ArgsRejected(_) | CallOutcome::Aborted { .. }) => None,
		}
	}
}

fn render_hub_args(args: &HubArgsState) -> Option<El> {
	let op = args.op.as_deref()?;
	let content = match op {
		"list" => view! {
			<col gap=0>
				<row sep=" · ">
					<text bold fg=info>{"IRC peers"}</text>
					<spinner>{"loading roster"}</spinner>
				</row>
			</col>
		},
		"jobs" => view! {
			<col gap=0>
				<row sep=" · ">
					<text bold fg=info>{"Background jobs"}</text>
					<spinner>{"loading job board"}</spinner>
				</row>
			</col>
		},
		"send" => {
			let to = args.to.as_deref().or(args.name.as_deref()).unwrap_or("…");
			let phase = if args.complete {
				"sending"
			} else {
				"composing"
			};
			view! {
				<col gap=0>
					<row sep=" · ">
						<text bold fg=info>{"IRC → "}{to}</text>
						if args.await_reply {
							<text fg=muted>{"awaiting reply"}</text>
						}
						<spinner>{phase}</spinner>
					</row>
					if let Some(message) = args.message.as_deref() {
						{quote_view(message, false)}
					}
				</col>
			}
		},
		"wait" => {
			let from = args
				.from
				.as_deref()
				.or(args.name.as_deref())
				.unwrap_or("any peer");
			let waiting = if args.ids == 0 {
				Str::from("waiting")
			} else {
				sf!("waiting on {} {}", args.ids, if args.ids == 1 { "job" } else { "jobs" })
			};
			view! {
				<col gap=0>
					<row sep=" · ">
						<text bold fg=info>{"IRC ← "}{from}</text>
						<spinner>{waiting}</spinner>
					</row>
				</col>
			}
		},
		"inbox" => view! {
			<col gap=0>
				<row sep=" · ">
					<text bold fg=info>{"IRC inbox"}</text>
					<spinner>{"checking messages"}</spinner>
				</row>
			</col>
		},
		"start" => {
			let name = args.name.as_deref().unwrap_or("…");
			view! {
				<col gap=0>
					<row sep=" · ">
						<text bold fg=info>{"Launch start: "}{name}</text>
						if let Some(command) = args.command.as_deref() {
							<text>{command}</text>
						}
						<spinner>{"starting"}</spinner>
					</row>
				</col>
			}
		},
		"logs" => {
			let name = args.name.as_deref().unwrap_or("…");
			view! {
				<col gap=0>
					<row sep=" · ">
						<text bold fg=info>{"Launch logs: "}{name}</text>
						if let Some(cursor) = args.cursor {
							<text fg=muted>{sf!("cursor {cursor}")}</text>
						}
						<spinner>{"reading"}</spinner>
					</row>
				</col>
			}
		},
		"ps" => view! {
			<col gap=0>
				<row sep=" · ">
					<text bold fg=info>{"Launch processes"}</text>
					<spinner>{"loading"}</spinner>
				</row>
			</col>
		},
		_ => {
			let name = args.name.as_deref();
			view! {
				<col gap=0>
					<row sep=" · ">
						<text bold fg=info>
							{op}
							if let Some(name) = name { {": "}{name} }
						</text>
						<spinner>{"working"}</spinner>
					</row>
				</col>
			}
		},
	};
	Some(content)
}

#[cfg(test)]
fn render_hub_response(response: &HubResponse) -> Option<Str> {
	render_hub_response_with_args(response, None).map(Into::into)
}

fn render_hub_response_with_args(
	response: &HubResponse,
	args: Option<&HubArgsState>,
) -> Option<El> {
	let value = serde_json::from_str::<serde_json::Value>(&response.text).ok()?;
	let object = value.as_object()?;
	if let Some(peers) = object.get("peers").and_then(serde_json::Value::as_array) {
		return Some(render_hub_roster(
			peers,
			object.get("counts").and_then(serde_json::Value::as_object),
		));
	}
	if let Some(jobs) = object.get("jobs").and_then(serde_json::Value::as_array) {
		return Some(render_hub_jobs(
			jobs,
			object.get("waitingMs").and_then(serde_json::Value::as_u64),
		));
	}
	if let Some(processes) = object
		.get("processes")
		.and_then(serde_json::Value::as_array)
	{
		return Some(render_hub_processes(processes));
	}
	if object.contains_key("lines") {
		return Some(render_hub_logs(object));
	}
	if object.contains_key("deliveries") {
		return Some(render_hub_send(object, args));
	}
	if object.contains_key("messages") {
		return Some(render_hub_inbox(object));
	}
	if object.contains_key("message")
		|| object.contains_key("timeout")
		|| object.contains_key("waitedMs")
	{
		return Some(render_hub_wait(object, args));
	}
	if object.contains_key("ready") && object.contains_key("name") {
		return Some(render_hub_start(object, args));
	}
	Some(render_hub_process_or_job(object))
}

fn render_hub_roster(
	peers: &[serde_json::Value],
	counts: Option<&serde_json::Map<String, serde_json::Value>>,
) -> El {
	let running = counts
		.and_then(|counts| json_u64(counts, &["running"]))
		.unwrap_or_else(|| peer_status_count(peers, "running"));
	let idle = counts
		.and_then(|counts| json_u64(counts, &["idle"]))
		.unwrap_or_else(|| peer_status_count(peers, "idle"));
	let parked = counts
		.and_then(|counts| json_u64(counts, &["parked"]))
		.unwrap_or_else(|| peer_status_count(peers, "parked"));
	let now_ms = now_ms();
	view! {
		<col gap=0 max-rows=12 overflow="peers">
			<row sep=" · ">
				<text bold fg=info>{"IRC peers"}</text>
				<text fg=accent>{sf!("{running} running")}</text>
				<text fg=muted>{sf!("{idle} idle")}</text>
				<text fg=muted>{sf!("{parked} parked")}</text>
			</row>
			for peer in peers {
				if let Some(peer) = peer.as_object() {
					<row sep=" · ">
						{state_view(json_string(peer, &["status", "lifecycle"]).unwrap_or("unknown"))}
						<text bold>{json_string(peer, &["id", "name", "callerName"]).unwrap_or("unknown")}</text>
						if let Some(name) = json_string(peer, &["name", "displayName"])
							.filter(|name| *name != json_string(peer, &["id", "name", "callerName"]).unwrap_or("unknown"))
						{
							<text fg=muted>{name}</text>
						}
						<text fg=muted>{json_string(peer, &["kind"]).unwrap_or("agent")}</text>
						if let Some(parent) = json_string(peer, &["parent", "parentId"]) {
							<text fg=muted>{"of "}{parent}</text>
						}
						if let Some(activity) = json_string(peer, &["activity"]) {
							<text fg=secondary>{activity}</text>
						}
						if let Some(unread) = json_u64(peer, &["unread", "unreadCount"]).filter(|unread| *unread > 0) {
							<text fg=warn>{sf!("[{unread} unread]")}</text>
						}
						if let Some(age_ms) = object_age_ms(
							peer,
							now_ms,
							&["lastActivityMs", "updatedAtMs"],
							&["ageMs", "activityMs"],
						) {
							{relative_time_view(age_ms)}
						}
					</row>
				}
			}
		</col>
	}
}

fn render_hub_jobs(jobs: &[serde_json::Value], waiting_ms: Option<u64>) -> El {
	let mut done = 0_u64;
	let mut failed = 0_u64;
	let mut running = 0_u64;
	for job in jobs {
		let Some(status) = job
			.as_object()
			.and_then(|job| json_string(job, &["status", "state", "lifecycle"]))
		else {
			continue;
		};
		match status {
			"completed" | "done" | "success" => done += 1,
			"failed" | "error" => failed += 1,
			"queued" | "running" | "active" | "waiting" => running += 1,
			_ => {},
		}
	}
	let title = if running == 0 {
		sf!("{} jobs settled", jobs.len())
	} else {
		sf!("{} jobs", jobs.len())
	};
	view! {
		<col gap=0 max-rows=12 overflow="jobs">
			<row sep=" · ">
				<text bold fg=info>{title}</text>
				<text fg=ok>{sf!("{done} done")}</text>
				<text fg=err>{sf!("{failed} failed")}</text>
				if running > 0 {
					<text fg=accent>{sf!("{running} running")}</text>
				}
				if let Some(waiting_ms) = waiting_ms {
					<spinner>{"waiting"}</spinner>
					<time kind="duration" ms={waiting_ms}/>
				}
			</row>
			for job in jobs {
				if let Some(job) = job.as_object() {
					<row sep=" · ">
						{state_view(json_string(job, &["status", "state", "lifecycle"]).unwrap_or("unknown"))}
						<text fg=secondary>{json_string(job, &["kind", "type"]).unwrap_or("job")}</text>
						<text bold>{json_string(job, &["label", "name"]).unwrap_or_else(|| json_string(job, &["id", "job", "name"]).unwrap_or("unknown"))}</text>
						if json_string(job, &["label", "name"]).unwrap_or_else(|| json_string(job, &["id", "job", "name"]).unwrap_or("unknown"))
							!= json_string(job, &["id", "job", "name"]).unwrap_or("unknown")
						{
							<text fg=muted>{json_string(job, &["id", "job", "name"]).unwrap_or("unknown")}</text>
						}
						if let Some(duration) = json_u64(job, &["durationMs", "elapsedMs"]) {
							<time kind="duration" ms={duration}/>
						}
					</row>
					if let Some((preview, error)) = json_string(job, &["error", "errorText"])
						.map(|preview| (preview, true))
						.or_else(|| json_string(job, &["result", "resultText"]).map(|preview| (preview, false)))
					{
						{quote_view(preview, error)}
					}
				}
			}
		</col>
	}
}

fn render_hub_processes(processes: &[serde_json::Value]) -> El {
	view! {
		<col gap=0 max-rows=12 overflow="processes">
			<row sep=" · ">
				<text bold fg=secondary>{"Launch processes"}</text>
				<text fg=muted>{sf!("{} supervised", processes.len())}</text>
			</row>
			for process in processes {
				if let Some(process) = process.as_object() {
					<row sep=" · ">
						{state_view(json_string(process, &["status", "state"]).unwrap_or("unknown"))}
						<text bold>{json_string(process, &["name"]).unwrap_or("unknown")}</text>
						if let Some(pid) = json_u64(process, &["pid"]) {
							<text fg=muted>{sf!("pid {pid}")}</text>
						}
						if let Some(uptime) = json_u64(process, &["uptimeMs", "elapsedMs"]) {
							<text fg=muted>{"up"}</text>
							<time kind="duration" ms={uptime}/>
						}
						if let Some(restarts) = json_u64(process, &["restartCount"]).filter(|count| *count > 0) {
							<text fg=muted>{sf!("{restarts} restarts")}</text>
						}
					</row>
				}
			}
		</col>
	}
}

fn render_hub_start(
	object: &serde_json::Map<String, serde_json::Value>,
	args_state: Option<&HubArgsState>,
) -> El {
	let name = json_string(object, &["name"])
		.or_else(|| args_state.and_then(|args| args.name.as_deref()))
		.unwrap_or("unknown");
	let command = if let Some(command) = json_string(object, &["command", "cmd"]) {
		Some(view! { <text>{command}</text> })
	} else if let Some(application) = json_string(object, &["application"]) {
		Some(view! {
			<text>
				{application}
				if let Some(args) = object.get("args").and_then(serde_json::Value::as_array) {
					for arg in args.iter().filter_map(serde_json::Value::as_str) {
						{" "}{arg}
					}
				}
			</text>
		})
	} else {
		args_state
			.and_then(|args| args.command.as_deref())
			.map(|command| view! { <text>{command}</text> })
	};
	let state = if object.get("ready").and_then(serde_json::Value::as_bool) == Some(true) {
		"ready"
	} else {
		json_string(object, &["state", "status"]).unwrap_or("starting")
	};
	view! {
		<col gap=0>
			<row sep=" · ">
				<text bold fg=secondary>{"Launch start:"}</text>
				<text bold>{name}</text>
				if let Some(command) = command {
					{command}
				}
				{state_view(state)}
				if let Some(pid) = json_u64(object, &["pid"]) {
					<text fg=muted>{sf!("pid {pid}")}</text>
				}
				if let Some(uptime) = json_u64(object, &["uptimeMs", "elapsedMs"]) {
					<text fg=muted>{"up"}</text>
					<time kind="duration" ms={uptime}/>
				} else if let Some(generation) = json_u64(object, &["generation"]) {
					<text fg=muted>{sf!("generation {generation}")}</text>
				}
			</row>
			if let Some(matched) = json_string(object, &["readyMatch", "matchedLog", "matched"]) {
				<text fg=muted>{"log matched: "}{matched}</text>
			}
		</col>
	}
}

fn render_hub_logs(object: &serde_json::Map<String, serde_json::Value>) -> El {
	view! {
		<col gap=0>
			<row sep=" · ">
				<text bold fg=secondary>{"Launch logs:"}</text>
				if let Some(name) = json_string(object, &["name"]) {
					<text bold>{name}</text>
				}
				if let Some(state) = json_string(object, &["state", "status"]) {
					{state_view(state)}
				}
				if let Some(cursor) = json_u64(object, &["cursor"]) {
					<text fg=muted>{sf!("cursor {cursor}")}</text>
				}
				if object.get("timedOut").and_then(serde_json::Value::as_bool) == Some(true) {
					<callout kind="warn">{"Log follow timed out."}</callout>
				}
			</row>
			<box border=round bc=border pad="0 1">
				<pre max-rows=80 overflow="log lines">
					if let Some(lines) = object.get("lines").and_then(serde_json::Value::as_array) {
						for (index, line) in lines.iter().enumerate() {
							if index > 0 { {"\n"} }
							{line.as_str().unwrap_or_default()}
						}
					} else if let Some(lines) = object.get("lines").and_then(serde_json::Value::as_str) {
						{lines}
					}
				</pre>
			</box>
		</col>
	}
}

fn render_hub_send(
	object: &serde_json::Map<String, serde_json::Value>,
	args_state: Option<&HubArgsState>,
) -> El {
	let deliveries = object
		.get("deliveries")
		.and_then(serde_json::Value::as_array)
		.map(Vec::as_slice)
		.unwrap_or_default();
	let to = json_string(object, &["to"])
		.or_else(|| {
			deliveries
				.first()
				.and_then(serde_json::Value::as_object)
				.and_then(|delivery| json_string(delivery, &["to", "recipient"]))
		})
		.or_else(|| args_state.and_then(|args| args.to.as_deref().or(args.name.as_deref())))
		.unwrap_or("unknown");
	let mut delivered = 0_u64;
	let mut failed = 0_u64;
	let mut revived = 0_u64;
	for delivery in deliveries {
		let Some(delivery) = delivery.as_object() else {
			continue;
		};
		match json_string(delivery, &["outcome", "status"]).unwrap_or("delivered") {
			"failed" => failed += 1,
			"revived" => revived += 1,
			_ => delivered += 1,
		}
	}
	let reply = object.get("reply");
	let now_ms = now_ms();
	view! {
		<col gap=0 max-rows=12 overflow="deliveries">
			<row sep=" · ">
				<text bold fg=info>{"IRC → "}{to}</text>
				if deliveries.len() == 1 {
					{state_view(
						deliveries[0]
							.as_object()
							.and_then(|delivery| json_string(delivery, &["outcome", "status"]))
							.unwrap_or("delivered")
					)}
				} else {
					if delivered > 0 {
						<text fg=ok>{sf!("{delivered} delivered")}</text>
					}
					if revived > 0 {
						<text fg=ok>{sf!("{revived} revived")}</text>
					}
					if failed > 0 {
						<text fg=err>{sf!("{failed} failed")}</text>
					}
				}
			</row>
			if let Some(sent) = json_string(object, &["sent", "outgoing", "body"])
				.or_else(|| args_state.and_then(|args| args.message.as_deref()))
			{
				{quote_view(sent, false)}
			}
			for delivery in deliveries {
				if let Some(delivery) = delivery.as_object() {
					<row sep=" · ">
						{state_view(json_string(delivery, &["outcome", "status"]).unwrap_or("delivered"))}
						<text bold>{json_string(delivery, &["to", "recipient"]).unwrap_or("unknown")}</text>
						if let Some(error) = json_string(delivery, &["error", "reason"]) {
							<callout kind="error">{error}</callout>
						}
					</row>
				}
			}
			if let Some(reply) = reply.and_then(serde_json::Value::as_object) {
				<row sep=" · ">
					<text fg=info>
						{"IRC ← "}
						{json_string(reply, &["from", "sender"]).unwrap_or(to)}
					</text>
					if let Some(age_ms) = object_age_ms(reply, now_ms, &["sentMs", "timestampMs"], &["ageMs"]) {
						{relative_time_view(age_ms)}
					}
					if reply.contains_key("replyTo") {
						<text fg=muted>{"reply"}</text>
					}
				</row>
				if let Some(body) = json_string(reply, &["message", "text", "body"]) {
					{quote_view(body, false)}
				}
			} else if reply.is_some_and(serde_json::Value::is_null) {
				<callout kind="warn">{"No reply yet; check inbox or wait again."}</callout>
			}
		</col>
	}
}

fn render_hub_inbox(object: &serde_json::Map<String, serde_json::Value>) -> El {
	let messages = object
		.get("messages")
		.and_then(serde_json::Value::as_array)
		.map(Vec::as_slice)
		.unwrap_or_default();
	let count = if messages.is_empty() {
		Str::from("empty")
	} else {
		sf!(
			"{} {}",
			messages.len(),
			if messages.len() == 1 {
				"message"
			} else {
				"messages"
			}
		)
	};
	let now_ms = now_ms();
	view! {
		<col gap=0 max-rows=12 overflow="messages">
			<row sep=" · ">
				<text bold fg=info>{"IRC inbox"}</text>
				<text fg=muted>{count}</text>
			</row>
			for message in messages {
				if let Some(message) = message.as_object() {
					<row sep=" · ">
						<text bold fg=info>{json_string(message, &["from", "sender"]).unwrap_or("unknown")}</text>
						if let Some(age_ms) = object_age_ms(message, now_ms, &["sentMs", "timestampMs"], &["ageMs"]) {
							{relative_time_view(age_ms)}
						}
						if message.get("replyTo").is_some_and(|reply_to| !reply_to.is_null()) {
							<text fg=muted>{"reply"}</text>
						}
					</row>
					if let Some(body) = json_string(message, &["message", "text", "body"]) {
						{quote_view(body, false)}
					}
				} else {
					{quote_view(message.as_str().unwrap_or_default(), false)}
				}
			}
		</col>
	}
}

fn render_hub_wait(
	object: &serde_json::Map<String, serde_json::Value>,
	args_state: Option<&HubArgsState>,
) -> El {
	let message = object.get("message").and_then(serde_json::Value::as_object);
	let from = message
		.and_then(|message| json_string(message, &["from", "sender"]))
		.or_else(|| json_string(object, &["from"]))
		.or_else(|| args_state.and_then(|args| args.from.as_deref().or(args.name.as_deref())))
		.unwrap_or("any peer");
	let now_ms = now_ms();
	view! {
		<col gap=0>
			<row sep=" · ">
				<text bold fg=info>{"IRC ← "}{from}</text>
				if let Some(age_ms) = message.and_then(|message| {
					object_age_ms(message, now_ms, &["sentMs", "timestampMs"], &["ageMs"])
				}) {
					{relative_time_view(age_ms)}
				}
			</row>
			if message.is_none() {
				<callout kind="warn">{"Timed out."}</callout>
				if let Some(waited) = json_u64(object, &["waitingMs", "waitedMs"]) {
					<row sep=" · ">
						<text fg=muted>{"waited"}</text>
						<time kind="duration" ms={waited}/>
					</row>
				}
			}
			if let Some(message) = message
				&& let Some(body) = json_string(message, &["message", "text", "body"])
			{
				{quote_view(body, false)}
			}
		</col>
	}
}

fn render_hub_process_or_job(object: &serde_json::Map<String, serde_json::Value>) -> El {
	let label = if object.contains_key("job") {
		"Job"
	} else if object.contains_key("name") || object.contains_key("event") {
		"Launch"
	} else {
		"Hub"
	};
	let mut content = El::new(Tag::Col).prop(Prop::Gap, 0_u64).child(view! {
		<row gap=1>
			<text bold fg=secondary>{label}</text>
			<text bold>
				if let Some(name) = json_string(object, &["name", "job"]) {
					{name}
				}
			</text>
		</row>
	});
	for (key, value) in object {
		if matches!(key.as_str(), "name" | "job") {
			continue;
		}
		if matches!(key.as_str(), "state" | "status")
			&& let Some(status) = value.as_str()
		{
			content.push(state_view(status));
			continue;
		}
		content.push(
			El::new(Tag::Fact)
				.prop(Prop::Label, key.as_str())
				.text(json_compact(value)),
		);
	}
	content
}

fn quote_view(body: &str, error: bool) -> El {
	view! {
		<quote kind={if error { "error" } else { "normal" }}>{body}</quote>
	}
}

fn state_view(status: &str) -> El {
	view! {
		<state status={normalized_state(status)}/>
	}
}

fn normalized_state(status: &str) -> &str {
	match status {
		"done" | "success" | "complete" | "delivered" | "revived" => "completed",
		"error" => "failed",
		"queued" | "waiting" | "starting" | "reviving" => "running",
		"ready" => "active",
		"exited" => "stopped",
		status => status,
	}
}

fn relative_time_view(age_ms: u64) -> El {
	view! {
		<time kind="relative" ms={age_ms}/>
	}
}
fn peer_status_count(peers: &[serde_json::Value], wanted: &str) -> u64 {
	peers
		.iter()
		.filter_map(serde_json::Value::as_object)
		.filter(|peer| json_string(peer, &["status", "lifecycle"]) == Some(wanted))
		.count()
		.try_into()
		.unwrap_or(u64::MAX)
}

fn object_age_ms(
	object: &serde_json::Map<String, serde_json::Value>,
	now_ms: u64,
	timestamp_keys: &[&str],
	age_keys: &[&str],
) -> Option<u64> {
	json_u64(object, age_keys).or_else(|| {
		json_u64(object, timestamp_keys).map(|timestamp_ms| now_ms.saturating_sub(timestamp_ms))
	})
}

fn now_ms() -> u64 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.unwrap_or_default()
		.as_millis()
		.try_into()
		.unwrap_or(u64::MAX)
}

fn json_string<'a>(
	object: &'a serde_json::Map<String, serde_json::Value>,
	keys: &[&str],
) -> Option<&'a str> {
	keys
		.iter()
		.find_map(|key| object.get(*key).and_then(serde_json::Value::as_str))
}

fn json_u64(object: &serde_json::Map<String, serde_json::Value>, keys: &[&str]) -> Option<u64> {
	keys
		.iter()
		.find_map(|key| object.get(*key).and_then(serde_json::Value::as_u64))
}

fn json_compact(value: &serde_json::Value) -> String {
	match value {
		serde_json::Value::String(value) => value.clone(),
		_ => serde_json::to_string(value).unwrap_or_default(),
	}
}

/// Native hub renderer lifecycle fixtures for the visual QA gallery.
pub fn gallery_fixtures(hub: ToolIdentity) -> Vec<RendererGalleryFixture> {
	vec![
		RendererGalleryFixture {
			identity: hub.clone(),
			streaming_args: r#"{"op":"list","status":"ru"#,
			args: r#"{"op":"list","limit":32}"#,
			progress_update: Some(
				br#"{"text":"{\"peers\":[],\"counts\":{\"running\":0,\"idle\":0,\"parked\":2}}","useless":true}"#,
			),
			success_outcome: br#"{"kind":"ok","value":{"text":"{\"peers\":[{\"id\":\"AuthLoader\",\"kind\":\"task sub\",\"status\":\"running\",\"parent\":\"Main\",\"activity\":\"reviewing auth flow\",\"unread\":2,\"ageMs\":240000},{\"id\":\"RateLimiter\",\"kind\":\"task sub\",\"status\":\"idle\",\"parent\":\"Main\",\"activity\":\"tests green\",\"unread\":0,\"ageMs\":19000}],\"counts\":{\"running\":1,\"idle\":1,\"parked\":2,\"shown\":2,\"truncated\":0}}","useless":false}}"#,
			error_outcome: br#"{"kind":"faulted","value":{"message":"peer registry unavailable"}}"#,
		},
		RendererGalleryFixture {
			identity: hub.clone(),
			streaming_args: r#"{"op":"jobs","ids":["bash_a"#,
			args: r#"{"op":"jobs"}"#,
			progress_update: Some(
				br#"{"text":"{\"waitingMs\":1400,\"jobs\":[{\"id\":\"bash_a1b2\",\"kind\":\"bash\",\"status\":\"running\",\"label\":\"bun test crates/tools\",\"durationMs\":1400}]}","useless":true}"#,
			),
			success_outcome: br#"{"kind":"ok","value":{"text":"{\"jobs\":[{\"id\":\"bash_a1b2\",\"kind\":\"bash\",\"status\":\"completed\",\"label\":\"bun test crates/tools\",\"durationMs\":18420,\"result\":\"42 tests passed\"},{\"id\":\"bash_c3d4\",\"kind\":\"bash\",\"status\":\"completed\",\"label\":\"bun test packages/tui\",\"durationMs\":9210,\"result\":\"18 tests passed\"},{\"id\":\"bash_e5f6\",\"kind\":\"bash\",\"status\":\"failed\",\"label\":\"bun test packages/agent\",\"durationMs\":3370,\"error\":\"expected 200, received 429\"}]}","useless":false}}"#,
			error_outcome: br#"{"kind":"faulted","value":{"message":"job board unavailable"}}"#,
		},
		RendererGalleryFixture {
			identity: hub.clone(),
			streaming_args: r#"{"op":"send","to":"AuthLoader","message":"Can you verify the refresh-tok"#,
			args: r#"{"op":"send","to":"AuthLoader","message":"Can you verify the refresh-token race?","await":true}"#,
			progress_update: None,
			success_outcome: br#"{"kind":"ok","value":{"text":"{\"deliveries\":[{\"to\":\"AuthLoader\",\"outcome\":\"revived\"}],\"reply\":{\"from\":\"AuthLoader\",\"to\":\"Main\",\"message\":\"Confirmed: the lease now serializes refreshes.\",\"replyTo\":\"01HZX\",\"ageMs\":4000}}","useless":false}}"#,
			error_outcome: br#"{"kind":"faulted","value":{"message":"unknown agent AuthLoader"}}"#,
		},
		RendererGalleryFixture {
			identity: hub.clone(),
			streaming_args: r#"{"op":"inbox","peek":fa"#,
			args: r#"{"op":"inbox","peek":false}"#,
			progress_update: Some(
				br#"{"text":"{\"messages\":[]}","useless":true}"#,
			),
			success_outcome: br#"{"kind":"ok","value":{"text":"{\"messages\":[{\"id\":\"01J1\",\"from\":\"AuthLoader\",\"to\":\"Main\",\"message\":\"OAuth callback coverage is complete.\",\"ageMs\":12000},{\"id\":\"01J2\",\"from\":\"RateLimiter\",\"to\":\"Main\",\"message\":\"I found one retry-after edge case.\",\"replyTo\":\"01J0\",\"ageMs\":240000}]}","useless":false}}"#,
			error_outcome: br#"{"kind":"faulted","value":{"message":"inbox unavailable"}}"#,
		},
		RendererGalleryFixture {
			identity: hub.clone(),
			streaming_args: r#"{"op":"start","name":"web","application":"bu"#,
			args: r#"{"op":"start","name":"web","application":"bun","args":["run","dev"],"ready":{"log":"Local:.*http","port":5173}}"#,
			progress_update: None,
			success_outcome: br#"{"kind":"ok","value":{"text":"{\"name\":\"web\",\"generation\":3,\"ready\":true,\"pid\":45102,\"uptimeMs\":1400,\"matchedLog\":\"Local: http://localhost:5173\"}","useless":false}}"#,
			error_outcome: br#"{"kind":"faulted","value":{"message":"process web exited before readiness"}}"#,
		},
		RendererGalleryFixture {
			identity: hub,
			streaming_args: r#"{"op":"logs","name":"we"#,
			args: r#"{"op":"logs","name":"web","follow":true,"cursor":118,"lines":100}"#,
			progress_update: Some(
				br#"{"text":"{\"name\":\"web\",\"state\":\"running\",\"lines\":[\"building client...\"],\"cursor\":119}","useless":true}"#,
			),
			success_outcome: br#"{"kind":"ok","value":{"text":"{\"name\":\"web\",\"state\":\"ready\",\"lines\":[\"$ bun run dev\",\"VITE v6.1.0 ready in 412 ms\",\"> Local: http://localhost:5173/\",\"GET /api/session 200 8ms\"],\"cursor\":148,\"timedOut\":false}","useless":false}}"#,
			error_outcome: br#"{"kind":"faulted","value":{"message":"process web was not found"}}"#,
		},
	]
}

#[cfg(test)]
mod tests {
	use bytes::Bytes;
	use omp_core::Str;
	use omp_tool::{
		CallOutcome,
		render::{RenderFold, ViewState},
	};

	use super::{HubRenderer, HubState, gallery_fixtures, render_hub_response};
	use crate::{
		hub::{Fault as HubFault, Response as HubResponse},
		render::test_support::{identities, registry},
	};

	#[test]
	fn hub_renderer_projects_wait_progress_and_rich_roster() {
		let (registry, identities) = registry(identities());
		let hub = identities.hub.as_ref().expect("hub identity");
		let mut state = ViewState::new();
		let progress = HubResponse {
			text:    Str::from(
				r#"{"waitingMs":1400,"jobs":[{"id":"bash_1","kind":"bash","status":"running","label":"bun test","durationMs":1400}]}"#,
			),
			useless: true,
		};
		registry
			.fold(
				hub,
				&mut state,
				Bytes::from(serde_json::to_vec(&progress).expect("progress serializes")),
			)
			.expect("hub progress folds");
		let live = registry
			.view(hub, &state, None)
			.expect("hub progress renders");
		assert!(live.contains("<spinner>waiting</spinner><time kind=duration ms=1400/>"));
		assert!(live.contains("<text fg=secondary>bash</text>"));

		let response = HubResponse {
			text:    Str::from(
				r#"{"peers":[{"id":"AuthLoader","status":"running","kind":"task sub","unread":2,"parent":"Main","ageMs":240000}],"counts":{"running":1,"idle":0,"parked":3}}"#,
			),
			useless: false,
		};
		let encoded = serde_json::to_vec(&CallOutcome::<HubResponse, HubFault>::Ok(response))
			.expect("outcome serializes");
		let roster = registry
			.view(hub, &state, Some(&encoded))
			.expect("roster renders");
		assert!(roster.contains("IRC peers"));
		assert!(roster.contains("<text fg=muted>0 idle</text><text fg=muted>3 parked</text>"));
		assert!(roster.contains("<text fg=muted>task sub</text><text fg=muted>of Main</text>"));
		assert!(roster.contains("[2 unread]"));
		assert!(roster.contains("<time kind=relative ms=240000/>"));
	}

	#[test]
	fn hub_send_quotes_payload_and_reports_delivery_exactly() {
		let response = HubResponse {
			text:    Str::from(
				r#"{"to":"AuthLoader","sent":"Check <token>","deliveries":[{"to":"AuthLoader","outcome":"revived"}]}"#,
			),
			useless: false,
		};
		let rendered = render_hub_response(&response).expect("send renders");
		assert!(rendered.contains("<quote kind=normal>Check &lt;token&gt;</quote>"));
		assert!(rendered.contains("<state status=completed/>"));
	}

	#[test]
	fn hub_views_cover_jobs_inbox_wait_start_logs_and_processes() {
		let cases = [
			(
				r#"{"jobs":[{"id":"bash_1","kind":"bash","status":"completed","label":"bun test","durationMs":18420,"result":"42 passed"},{"id":"bash_2","kind":"bash","status":"failed","label":"bun check","durationMs":900,"error":"type mismatch"}]}"#,
				["2 jobs settled", "1 done", "1 failed", "<quote kind=error>type mismatch</quote>"]
					.as_slice(),
			),
			(
				r#"{"messages":[{"from":"RateLimiter","message":"Retry fixed","replyTo":"01","ageMs":12000}]}"#,
				["IRC inbox", "RateLimiter", ">reply</text>", "<time kind=relative ms=12000/>"]
					.as_slice(),
			),
			(
				r#"{"message":{"from":"AuthLoader","message":"Verified","ageMs":4000}}"#,
				[
					"IRC ← AuthLoader",
					"<quote kind=normal>Verified</quote>",
					"<time kind=relative ms=4000/>",
				]
				.as_slice(),
			),
			(
				r#"{"name":"web","command":"bun run dev","ready":true,"pid":45102,"uptimeMs":1400,"matchedLog":"ready"}"#,
				[
					"Launch start:",
					"bun run dev",
					"pid 45102",
					"<time kind=duration ms=1400/>",
					"log matched: ready",
				]
				.as_slice(),
			),
			(
				r#"{"name":"web","state":"ready","lines":["GET / 200"],"cursor":148}"#,
				[
					"Launch logs:",
					"<state status=active/>",
					"cursor 148",
					"<pre max-rows=80 overflow=\"log lines\">GET / 200</pre>",
				]
				.as_slice(),
			),
			(
				r#"{"processes":[{"name":"web","state":"ready","pid":45102,"uptimeMs":1400}]}"#,
				["Launch processes", "web", "pid 45102", "<time kind=duration ms=1400/>"].as_slice(),
			),
			(
				r#"{"answer":42,"status":"complete"}"#,
				["Hub", "<fact label=answer>42</fact>", "<state status=completed/>"].as_slice(),
			),
		];
		for (text, expected) in cases {
			let rendered =
				render_hub_response(&HubResponse { text: Str::from(text), useless: false })
					.expect("hub response renders");
			for needle in expected {
				assert!(rendered.contains(needle), "missing {needle:?} in {rendered}");
			}
		}
	}

	#[test]
	fn hub_streaming_args_preview_and_settled_views_reuse_committed_args() {
		let mut state = HubState::default();
		HubRenderer.fold_args(
			&mut state,
			&omp_core::slopjson::parse_streaming(
				r#"{"op":"send","to":"AuthLoader","message":"Check the refresh-tok"#,
			),
			false,
		);
		let streaming = HubRenderer
			.view(&state, None)
			.expect("streaming args render");
		assert!(streaming.contains("IRC → AuthLoader"));
		assert!(streaming.contains("Check the refresh-tok"));
		assert!(streaming.contains("<spinner>composing</spinner>"));

		HubRenderer.fold_args(
			&mut state,
			&omp_core::slopjson::parse(
				r#"{"op":"send","to":"AuthLoader","message":"Check the refresh-token race","await":true}"#,
			)
			.expect("committed args parse"),
			true,
		);
		let outcome = CallOutcome::Ok(HubResponse {
			text:    Str::from(r#"{"deliveries":[{"to":"AuthLoader","outcome":"delivered"}]}"#),
			useless: false,
		});
		let settled = HubRenderer
			.view(&state, Some(&outcome))
			.expect("settled send renders");
		assert!(settled.contains("Check the refresh-token race"));
		assert!(settled.contains("IRC → AuthLoader"));
	}

	#[test]
	fn hub_gallery_fixtures_decode_updates_and_outcomes() {
		let (_, identities) = registry(identities());
		let hub = identities.hub.expect("hub identity");
		let fixtures = gallery_fixtures(hub);
		assert_eq!(fixtures.len(), 6);
		for fixture in fixtures {
			assert!(!fixture.streaming_args.is_empty());
			assert!(!fixture.args.is_empty());
			let _ = omp_core::slopjson::parse_streaming(fixture.streaming_args);
			omp_core::slopjson::parse(fixture.args).expect("fixture committed args decode");
			if let Some(update) = fixture.progress_update {
				serde_json::from_slice::<HubResponse>(update).expect("fixture update decodes");
			}
			serde_json::from_slice::<CallOutcome<HubResponse, HubFault>>(fixture.success_outcome)
				.expect("fixture success decodes");
			serde_json::from_slice::<CallOutcome<HubResponse, HubFault>>(fixture.error_outcome)
				.expect("fixture error decodes");
		}
	}
}
