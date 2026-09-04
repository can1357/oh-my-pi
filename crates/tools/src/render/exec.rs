//! Native shell and eval renderers with bounded streaming tails.

use omp_core::Str;
use omp_tool::{CallOutcome, ToolIdentity, render::RenderFold};
use serde::Deserialize;

use super::{
	debug_label,
	view::{El, Tone},
};
use crate::{
	eval::{
		CellOutcome, DisplayOutput, Fault as EvalFault, Language as EvalLanguage,
		Payload as EvalPayload, Update as EvalUpdate,
	},
	gallery::RendererGalleryFixture,
	shell::{
		AdjustmentReceipt, ExecOutcome, Fault as ShellFault, Payload as ShellPayload,
		TranscriptFrame, Update as ShellUpdate,
	},
	view,
};

#[derive(Default)]
pub(super) struct StreamState {
	bytes:               u64,
	last_sequence:       Option<u64>,
	tail:                Vec<u8>,
	cached:              Option<Str>,
	shell_command:       Option<Str>,
	shell_timeout_ms:    Option<u64>,
	shell_timeout_known: bool,
	eval_language:       Option<EvalLanguage>,
	eval_title:          Option<Str>,
	eval_code:           Option<Str>,
}

#[derive(Deserialize)]
#[serde(untagged)]
pub(super) enum ShellRenderOutcome {
	Call(CallOutcome<ShellPayload, ShellFault>),
	Terminal(omp_tool::ToolTerminal<ShellPayload, ShellFault>),
}

pub(super) struct ShellRenderer;

impl RenderFold for ShellRenderer {
	type Outcome = ShellRenderOutcome;
	type State = StreamState;
	type Update = ShellUpdate;

	fn fold(&self, state: &mut Self::State, update: Self::Update) {
		state.bytes = state
			.bytes
			.saturating_add(u64::try_from(update.data.len()).unwrap_or(u64::MAX));
		state.last_sequence = Some(update.sequence);
		append_bounded_tail(&mut state.tail, update.data.as_ref());
		state.cached = Some(render_shell_live(state).into());
	}

	fn fold_args(&self, state: &mut Self::State, args: &omp_core::slopjson::Value, complete: bool) {
		if let Some(command) = args
			.get("command")
			.and_then(omp_core::slopjson::Value::as_str)
		{
			state.shell_command = Some(Str::new(command));
		}
		if let Some(timeout_seconds) = args
			.get("timeout")
			.and_then(omp_core::slopjson::Value::as_f64)
		{
			state.shell_timeout_known = true;
			state.shell_timeout_ms =
				(timeout_seconds != 0.0).then_some((timeout_seconds * 1_000.0).ceil() as u64);
		} else if complete {
			state.shell_timeout_known = true;
			state.shell_timeout_ms = Some(300_000);
		}
		state.cached = Some(render_shell_live(state).into());
	}

	fn view(&self, state: &Self::State, outcome: Option<&Self::Outcome>) -> Option<Str> {
		match outcome {
			None => Some(
				state
					.cached
					.clone()
					.unwrap_or_else(|| render_shell_live(state).into()),
			),
			Some(
				ShellRenderOutcome::Call(CallOutcome::Ok(payload))
				| ShellRenderOutcome::Terminal(omp_tool::ToolTerminal::Done {
					result: Ok(payload), ..
				}),
			) => Some(render_shell_payload(payload, state).into()),
			Some(
				ShellRenderOutcome::Call(CallOutcome::Faulted(ShellFault::CommandFailed { payload }))
				| ShellRenderOutcome::Terminal(omp_tool::ToolTerminal::Done {
					result: Err(ShellFault::CommandFailed { payload }),
					..
				}),
			) => Some(render_shell_payload(payload, state).into()),
			Some(
				ShellRenderOutcome::Call(CallOutcome::Faulted(fault))
				| ShellRenderOutcome::Terminal(omp_tool::ToolTerminal::Done {
					result: Err(fault), ..
				}),
			) => Some(render_fault("bash", &shell_fault(fault)).into()),
			Some(ShellRenderOutcome::Terminal(omp_tool::ToolTerminal::Detached(job))) => {
				Some(render_shell_detached(job).into())
			},
			Some(ShellRenderOutcome::Call(
				CallOutcome::ArgsRejected(_) | CallOutcome::Aborted { .. },
			)) => None,
		}
	}
}

pub(super) struct EvalRenderer;

impl RenderFold for EvalRenderer {
	type Outcome = CallOutcome<EvalPayload, EvalFault>;
	type State = StreamState;
	type Update = EvalUpdate;

	fn fold(&self, state: &mut Self::State, update: Self::Update) {
		state.bytes = state
			.bytes
			.saturating_add(u64::try_from(update.data.len()).unwrap_or(u64::MAX));
		state.last_sequence = Some(update.sequence);
		append_bounded_tail(&mut state.tail, update.data.as_ref());
	}

	fn fold_args(&self, state: &mut Self::State, args: &omp_core::slopjson::Value, complete: bool) {
		if let Some(language) = args
			.get("language")
			.and_then(|value| value.deserialize_into::<EvalLanguage>().ok())
		{
			state.eval_language = Some(language);
		}
		if let Some(code) = args.get("code").and_then(omp_core::slopjson::Value::as_str) {
			state.eval_code = Some(Str::new(code));
		}
		if let Some(title) = args
			.get("title")
			.and_then(omp_core::slopjson::Value::as_str)
		{
			state.eval_title = Some(Str::new(title));
		} else if complete {
			state.eval_title = None;
		}
	}

	fn view(&self, state: &Self::State, outcome: Option<&Self::Outcome>) -> Option<Str> {
		match outcome {
			None => Some(render_eval_live(state).into()),
			Some(CallOutcome::Ok(payload)) => Some(render_eval_payload(payload, state).into()),
			Some(CallOutcome::Faulted(fault)) => Some(render_fault("eval", &eval_fault(fault)).into()),
			Some(CallOutcome::ArgsRejected(_) | CallOutcome::Aborted { .. }) => None,
		}
	}
}

fn append_bounded_tail(tail: &mut Vec<u8>, chunk: &[u8]) {
	const MAX_LIVE_OUTPUT_BYTES: usize = 16 * 1024;
	if chunk.len() >= MAX_LIVE_OUTPUT_BYTES {
		tail.clear();
		tail.extend_from_slice(&chunk[chunk.len() - MAX_LIVE_OUTPUT_BYTES..]);
		return;
	}
	let overflow = tail
		.len()
		.saturating_add(chunk.len())
		.saturating_sub(MAX_LIVE_OUTPUT_BYTES);
	if overflow > 0 {
		tail.drain(..overflow);
	}
	tail.extend_from_slice(chunk);
}

fn render_shell_live(state: &StreamState) -> El {
	let tail = String::from_utf8_lossy(&state.tail);
	view! {
		<col gap=0>
			<row gap=1>
				<text bold fg=accent>{"$"}</text>
				if let Some(command) = &state.shell_command {
					<text bold max-chars=16384 truncate-from="end">{command}</text>
				} else {
					<text fg=muted>{"…"}</text>
				}
				<spinner color=accent label="running"/>
				<spacer/>
				if state.last_sequence.is_some() {
					<bytes value={state.bytes}/>
				} else {
					<text fg=muted>{"starting"}</text>
				}
			</row>
			if !state.tail.is_empty() {
				<hr label="Output"/>
				<pre max-rows=12 overflow="output">{tail.as_ref()}</pre>
			}
		</col>
	}
}

fn render_eval_live(state: &StreamState) -> El {
	let tail = String::from_utf8_lossy(&state.tail);
	view! {
		<col gap=0>
			<row gap=1>
				if let Some(language) = state.eval_language {
					<text bold fg=info>{debug_label(language)}</text>
				}
				if let Some(title) = &state.eval_title {
					<text bold max-chars=256 truncate-from="end">{title}</text>
				}
				<spinner color=accent label="running"/>
				<spacer/>
				<bytes value={state.bytes}/>
			</row>
			if let Some(code) = &state.eval_code {
				<pre fg=accent max-rows=12 overflow="code">{code}</pre>
			}
			if !state.tail.is_empty() {
				<hr label="Output"/>
				<pre max-rows=12 overflow="output">{tail.as_ref()}</pre>
			}
		</col>
	}
}

fn render_fault(tool: &str, message: &str) -> El {
	view! {
		<callout kind="error">{tool}{": "}{message}</callout>
	}
}

fn shell_fault(fault: &ShellFault) -> String {
	match fault {
		ShellFault::Resource { operation, message } => format!("{operation}: {message}"),
		ShellFault::PtyDenied => String::from("PTY allocation denied by invocation scope"),
		ShellFault::InvalidEnvironmentKey { key } => {
			format!("invalid shell environment key {key:?}")
		},
		ShellFault::CommandFailed { payload } => format!(
			"command failed: status={:?}, exit={:?}, signal={:?}",
			payload.status.outcome, payload.status.exit_code, payload.status.signal
		),
	}
}

fn render_shell_detached(job: &omp_tool::JobRef) -> El {
	view! {
		<col gap=0>
			<row sep=" · ">
				<text bold fg=info>{"$ detached"}</text>
				<state status="running"/>
			</row>
			<fact label="job">{&job.id}</fact>
			<fact label="command">{&job.metadata.label}</fact>
			<callout kind="info">{"Completion will be delivered by the job board."}</callout>
		</col>
	}
}

fn render_shell_payload(payload: &ShellPayload, state: &StreamState) -> El {
	let contains_sixel = payload.transcript.iter().any(|frame| {
		frame.data.as_ref().contains(&0x90)
			|| frame
				.data
				.as_ref()
				.windows(2)
				.any(|window| window == b"\x1bP")
	});
	let transcript = bounded_transcript_tail(&payload.transcript, contains_sixel);
	let transcript = String::from_utf8_lossy(&transcript);
	let effective_timeout_ms = payload
		.adjustments
		.iter()
		.find_map(|adjustment| match adjustment {
			AdjustmentReceipt::TimeoutClamped { effective_ms, .. } => Some(*effective_ms),
		});
	let status = shell_state_status(payload);
	let status_tone = shell_status_tone(payload);
	view! {
		<col gap=0>
			<pre fg=accent max-rows=12 overflow="command">{"$ "}{&payload.command}</pre>
			<hr label="Output"/>
			if transcript.is_empty() {
				<text fg=muted>{"(no output)"}</text>
			} else {
				<pre max-rows=20 overflow="output">{transcript.as_ref()}</pre>
			}
			if payload.status.spilled_output.is_some() {
				<fact label="output">{"full output stored as blob"}</fact>
			}
			if payload.status.effects_unknown {
				<callout kind="warn">{"Final effect state is unknown."}</callout>
			}
			if let Some(cwd) = &payload.status.final_cwd_uri {
				<fact label="cwd">{cwd}</fact>
			}
			<row sep=" · ">
				<fact label="Wall">
					<time ms={payload.status.wall_clock_ms} kind="duration"/>
				</fact>
				<fact label="Timeout">
					if let Some(effective_ms) = effective_timeout_ms {
						<time ms={effective_ms} kind="duration"/>
					} else if state.shell_timeout_known {
						if let Some(timeout_ms) = state.shell_timeout_ms {
							<time ms={timeout_ms} kind="duration"/>
						} else {
							{"disabled"}
						}
					} else {
						{"unknown"}
					}
				</fact>
				<fact label="Status">
					<state status={status}/>
					<text fg={status_tone}>{debug_label(payload.status.outcome)}</text>
				</fact>
				if let Some(code) = payload.status.exit_code {
					<fact label="Exit"><text fg={status_tone}>{code.to_string()}</text></fact>
				}
				if let Some(signal) = &payload.status.signal {
					<fact label="Signal">{signal}</fact>
				}
			</row>
		</col>
	}
}

const fn shell_state_status(payload: &ShellPayload) -> &'static str {
	match (payload.status.outcome, payload.status.exit_code) {
		(ExecOutcome::Exited, Some(0) | None) => "completed",
		(ExecOutcome::Cancelled | ExecOutcome::Timeout, _) => "stopped",
		(ExecOutcome::Exited | ExecOutcome::Failed | ExecOutcome::Denied, _) => "failed",
	}
}

const fn shell_status_tone(payload: &ShellPayload) -> Tone {
	match (payload.status.outcome, payload.status.exit_code) {
		(ExecOutcome::Exited, Some(0) | None) => Tone::Ok,
		(ExecOutcome::Cancelled | ExecOutcome::Timeout, _) => Tone::Warn,
		(ExecOutcome::Exited | ExecOutcome::Failed | ExecOutcome::Denied, _) => Tone::Err,
	}
}

fn bounded_transcript_tail(transcript: &[TranscriptFrame], retain_all: bool) -> Vec<u8> {
	const MAX_RENDER_BYTES: usize = 64 * 1024;
	let total = transcript
		.iter()
		.map(|frame| frame.data.len())
		.sum::<usize>();
	let retain = if retain_all {
		total
	} else {
		total.min(MAX_RENDER_BYTES)
	};
	let skip = total.saturating_sub(retain);
	let mut output = Vec::with_capacity(retain);
	let mut offset = 0usize;
	for frame in transcript {
		let bytes = frame.data.as_ref();
		let frame_end = offset.saturating_add(bytes.len());
		if frame_end > skip {
			let start = skip.saturating_sub(offset);
			output.extend_from_slice(&bytes[start..]);
		}
		offset = frame_end;
	}
	output
}

fn eval_fault(fault: &EvalFault) -> String {
	match fault {
		EvalFault::InvalidTimeout => String::from("timeout must be non-negative and finite"),
		EvalFault::Resource { operation, message } => {
			format!("{operation}: {message}")
		},
		EvalFault::SessionLost { message } => message.to_string(),
	}
}

const fn eval_state_status(outcome: CellOutcome) -> &'static str {
	match outcome {
		CellOutcome::Complete => "completed",
		CellOutcome::Error => "failed",
		CellOutcome::Timeout | CellOutcome::Cancelled => "stopped",
	}
}

const fn eval_status_tone(outcome: CellOutcome) -> Tone {
	match outcome {
		CellOutcome::Complete => Tone::Ok,
		CellOutcome::Error => Tone::Err,
		CellOutcome::Timeout | CellOutcome::Cancelled => Tone::Warn,
	}
}

fn render_eval_payload(payload: &EvalPayload, state: &StreamState) -> El {
	let status = eval_state_status(payload.status.outcome);
	let status_tone = eval_status_tone(payload.status.outcome);
	let streamed = String::from_utf8_lossy(&state.tail);
	view! {
		<col gap=0>
			<row gap=1>
				<text bold fg=info>{debug_label(payload.language)}</text>
				if let Some(title) = &payload.title {
					<text bold max-chars=256 truncate-from="end">{title}</text>
				}
				<fact label="Status">
					<state status={status}/>
					<text fg={status_tone}>{debug_label(payload.status.outcome)}</text>
				</fact>
				<spacer/>
				<time ms={payload.status.duration_ms} kind="duration"/>
			</row>
			<pre fg=accent max-rows=12 overflow="code">{&payload.code}</pre>
			<hr label="Output"/>
			if !state.tail.is_empty() {
				<pre max-rows=20 overflow="output">{streamed.as_ref()}</pre>
			}
			if let Some(exception) = &payload.status.exception {
				<pre fg=err max-rows=20 overflow="traceback">
					for (index, line) in exception.traceback.iter().enumerate() {
						if index > 0 { {"\n"} }
						{line}
					}
					if !exception.traceback.is_empty() { {"\n"} }
					{&exception.name}
					if !exception.message.is_empty() {
						{": "}{&exception.message}
					}
				</pre>
			} else if state.tail.is_empty()
				&& !payload.had_output
				&& payload.result.is_none()
				&& payload.display_outputs.is_empty()
			{
				<text fg=muted>{"(no output)"}</text>
			} else {
				if let Some(result) = &payload.result {
					<pre fg=info max-rows=20 overflow="result">{&result.text}</pre>
				}
				for display in &payload.display_outputs {
					match display {
						DisplayOutput::Json { data } | DisplayOutput::Status { event: data } => {
							<json max-depth=3 max-rows=12 max-chars=80>{data.to_string()}</json>
						},
						DisplayOutput::Markdown { text } => {
							<md>{text}</md>
						},
						DisplayOutput::Image { description, .. } => {
							<text fg=muted>{description}</text>
						},
						DisplayOutput::ImageData { data, mime_type } => {
							<row sep=" · ">
								<text fg=muted>{mime_type}</text>
								<bytes value={u64::try_from(data.len()).unwrap_or(u64::MAX)}/>
							</row>
						},
					}
				}
			}
		</col>
	}
}

/// Native shell and eval renderer lifecycle fixtures for the visual QA gallery.
pub fn gallery_fixtures(shell: ToolIdentity, eval: ToolIdentity) -> Vec<RendererGalleryFixture> {
	vec![
		RendererGalleryFixture {
			identity: shell,
			streaming_args: r#"{"command":"git status --short && git log --on"#,
			args: r#"{"command":"git status --short && git log --oneline -5","cwd":"packages/coding-agent","timeout":30}"#,
			progress_update: Some(
				br#"{"channel":"stdout","data":[32,77,32,115,114,99,47,99,108,105,47,103,97,108,108,101,114,121,45,99,108,105,46,116,115,10],"sequence":1,"exec_id":[1],"started":true,"terminal":false}"#,
			),
			success_outcome: br#"{"kind":"ok","value":{"session_id":[1],"exec_id":[1],"command":"git status --short && git log --oneline -5","transcript":[{"channel":"stdout","data":[32,77,32,115,114,99,47,99,108,105,47,103,97,108,108,101,114,121,45,99,108,105,46,116,115,10,32,77,32,115,114,99,47,116,111,111,108,115,47,98,97,115,104,46,116,115,10,63,63,32,115,114,99,47,99,108,105,47,103,97,108,108,101,114,121,45,102,105,120,116,117,114,101,115,47,115,104,101,108,108,46,116,115,10,97,49,98,50,99,51,100,32,87,105,114,101,32,103,97,108,108,101,114,121,32,99,111,109,109,97,110,100,32,105,110,116,111,32,67,76,73,32,100,105,115,112,97,116,99,104,10,57,102,56,101,55,100,54,32,65,100,100,32,84,111,111,108,69,120,101,99,117,116,105,111,110,67,111,109,112,111,110,101,110,116,32,108,105,102,101,99,121,99,108,101,32,115,116,97,116,101,115,10,52,99,53,98,54,97,55,32,69,120,116,114,97,99,116,32,99,114,101,97,116,101,83,104,101,108,108,82,101,110,100,101,114,101,114,32,102,114,111,109,32,98,97,115,104,84,111,111,108,82,101,110,100,101,114,101,114,10,50,100,51,101,52,102,53,32,83,116,114,105,112,32,76,76,77,45,102,97,99,105,110,103,32,110,111,116,105,99,101,115,32,98,101,102,111,114,101,32,84,85,73,32,114,101,110,100,101,114,10,55,97,56,98,57,99,48,32,67,97,112,32,112,114,101,118,105,101,119,32,108,105,110,101,115,32,105,110,32,112,101,110,100,105,110,103,32,99,111,109,109,97,110,100,32,98,108,111,99,107,10],"sequence":1}],"adjustments":[],"status":{"outcome":"exited","exit_code":0,"signal":null,"wall_clock_ms":184,"spilled_output":null,"aborted":false,"effects_unknown":false,"final_cwd_uri":"file:///work/pi/packages/coding-agent","final_cwd_revision":7}}}"#,
			error_outcome: br#"{"kind":"faulted","value":{"kind":"command_failed","payload":{"session_id":[1],"exec_id":[2],"command":"npx tsc --noEmit","transcript":[{"channel":"stderr","data":[115,114,99,47,116,111,111,108,115,47,98,97,115,104,46,116,115,58,49,49,52,50,58,51,52,32,45,32,101,114,114,111,114,32,84,83,50,51,51,57,58,32,80,114,111,112,101,114,116,121,32,39,114,101,113,117,101,115,116,101,100,84,105,109,101,111,117,116,83,101,99,111,110,100,115,39,32,100,111,101,115,32,110,111,116,32,101,120,105,115,116,32,111,110,32,116,121,112,101,32,39,66,97,115,104,84,111,111,108,68,101,116,97,105,108,115,39,46,10,10,49,49,52,50,32,32,32,99,111,110,115,116,32,114,101,113,117,101,115,116,101,100,84,105,109,101,111,117,116,83,101,99,111,110,100,115,32,61,32,100,101,116,97,105,108,115,63,46,114,101,113,117,101,115,116,101,100,84,105,109,101,111,117,116,83,101,99,111,110,100,115,59,10,32,32,32,32,32,32,32,32,32,32,32,32,32,32,32,32,32,32,32,32,32,32,32,32,32,32,32,32,32,32,32,32,32,32,32,32,32,32,126,126,126,126,126,126,126,126,126,126,126,126,126,126,126,126,126,126,126,126,126,126,126,126,126,10,10,70,111,117,110,100,32,49,32,101,114,114,111,114,32,105,110,32,115,114,99,47,116,111,111,108,115,47,98,97,115,104,46,116,115,58,49,49,52,50,10],"sequence":1}],"adjustments":[],"status":{"outcome":"exited","exit_code":2,"signal":null,"wall_clock_ms":5120,"spilled_output":null,"aborted":false,"effects_unknown":false,"final_cwd_uri":"file:///work/pi/packages/coding-agent","final_cwd_revision":7}}}}"#,
		},
		RendererGalleryFixture {
			identity: eval,
			streaming_args: r#"{"language":"py","title":"load config","code":"import json\nfrom pathlib import Path\n\ndata = json.loads(Path(\"package.js"#,
			args: r#"{"language":"py","title":"load config","code":"import json\nfrom pathlib import Path\n\ndata = json.loads(Path(\"package.json\").read_text())\ndeps = data.get(\"dependencies\", {})\nprint(f\"{data['name']} v{data['version']}\")\nprint(f\"{len(deps)} dependencies\")\ndisplay(sorted(deps)[:3])"}"#,
			progress_update: Some(
				br#"{"channel":"stdout","data":[64,111,104,45,109,121,45,112,105,47,99,111,100,105,110,103,45,97,103,101,110,116,32,118,48,46,52,50,46,48,10],"sequence":1}"#,
			),
			success_outcome: br#"{"kind":"ok","value":{"session_id":[1],"cell_id":[1],"language":"py","title":"load config","code":"import json\nfrom pathlib import Path\n\ndata = json.loads(Path(\"package.json\").read_text())\ndeps = data.get(\"dependencies\", {})\nprint(f\"{data['name']} v{data['version']}\")\nprint(f\"{len(deps)} dependencies\")\ndisplay(sorted(deps)[:3])","reset":false,"had_output":true,"result":null,"display_outputs":[{"type":"json","data":["@ai-sdk/anthropic","@oh-my-pi/pi-ai","@oh-my-pi/pi-tui"]}],"status":{"outcome":"complete","exit_code":0,"duration_ms":64,"exception":null}}}"#,
			error_outcome: br#"{"kind":"ok","value":{"session_id":[1],"cell_id":[2],"language":"py","title":"load config","code":"import json\nfrom pathlib import Path\n\ndata = json.loads(Path(\"package.json\").read_text())\ndeps = data.get(\"dependencies\", {})\nprint(f\"{data['name']} v{data['version']}\")","reset":false,"had_output":false,"result":null,"display_outputs":[],"status":{"outcome":"error","exit_code":1,"duration_ms":41,"exception":{"name":"json.decoder.JSONDecodeError","message":"Expecting ',' delimiter: line 12 column 3 (char 318)","traceback":["Traceback (most recent call last):","  File \"<cell 0>\", line 4, in <module>","    data = json.loads(Path(\"package.json\").read_text())","          ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^"]}}}}"#,
		},
	]
}
#[cfg(test)]
mod tests {
	use omp_core::Str;
	use omp_tool::{CallOutcome, Rev, ToolIdentity, render::RenderFold};

	use super::{
		EvalRenderer, ShellRenderOutcome, ShellRenderer, StreamState, gallery_fixtures, render_fault,
		render_shell_detached,
	};
	use crate::{
		eval::{Fault as EvalFault, Payload as EvalPayload, Update as EvalUpdate},
		shell::Update as ShellUpdate,
	};

	fn identity(name: &'static str) -> ToolIdentity {
		ToolIdentity { name: Str::new_static(name), rev: Rev { family: Str::new_static(""), n: 1 } }
	}

	#[test]
	fn detached_shell_view_is_typed_and_escaped() {
		let job = omp_tool::JobRef {
			id:       Str::new("job&1"),
			owner:    omp_tool::JobOwner::NamedProcess {
				name:       Str::new("bash-bg-1"),
				generation: 1,
			},
			metadata: std::sync::Arc::new(omp_tool::JobMetadata::running(
				omp_tool::JobKind::Shell,
				Str::new("echo <done>"),
				1,
			)),
			artifact: omp_tool::ExpectedArtifact {
				description: Str::new("shell output"),
				media_type:  None,
				lifetime:    omp_tool::ArtifactLifetime::Session,
			},
		};
		let view = render_shell_detached(&job).to_tml();
		assert!(view.contains("<state status=running/>"));
		assert!(view.contains("<fact label=job>job&amp;1</fact>"));
		assert!(view.contains("<fact label=command>echo &lt;done&gt;</fact>"));
		assert!(view.contains("<callout kind=info>"));
	}

	#[test]
	fn fixtures_decode_and_render_pi_grade_shell_and_eval_states() {
		let fixtures = gallery_fixtures(identity("bash"), identity("eval"));
		let shell = &fixtures[0];
		let shell_update: ShellUpdate =
			serde_json::from_slice(shell.progress_update.expect("shell progress")).unwrap();
		let shell_renderer = ShellRenderer;
		let mut shell_state = StreamState::default();
		let streaming_args = omp_core::slopjson::parse_streaming(shell.streaming_args);
		shell_renderer.fold_args(&mut shell_state, &streaming_args, false);
		shell_renderer.fold(&mut shell_state, shell_update);
		let live = shell_renderer.view(&shell_state, None).unwrap();
		assert!(live.contains("git status --short &amp;&amp; git log --on"));
		assert!(live.contains("<bytes value=26/>"));
		assert!(live.contains("<hr label=Output/>"));
		assert!(live.contains("<pre max-rows=12 overflow=output>"));
		assert!(!live.contains("ctrl+o"));
		let args = omp_core::slopjson::parse(shell.args).unwrap();
		shell_renderer.fold_args(&mut shell_state, &args, true);
		let shell_ok: ShellRenderOutcome = serde_json::from_slice(shell.success_outcome).unwrap();
		let shell_error: ShellRenderOutcome = serde_json::from_slice(shell.error_outcome).unwrap();
		let success = shell_renderer.view(&shell_state, Some(&shell_ok)).unwrap();
		assert!(success.contains("$ git status --short &amp;&amp; git log --oneline -5"));
		assert!(success.contains("<hr label=Output/>"));
		assert!(success.contains("<pre max-rows=20 overflow=output>"));
		assert!(success.contains("<time ms=184 kind=duration/>"));
		assert!(success.contains("<time ms=30000 kind=duration/>"));
		assert!(success.contains("<fact label=Exit><text fg=ok>0</text></fact>"));
		assert!(!success.contains("ctrl+o"));
		let mut clamped_json: serde_json::Value =
			serde_json::from_slice(shell.success_outcome).unwrap();
		clamped_json["value"]["adjustments"] = serde_json::json!([{
			"kind": "timeout_clamped",
			"requested_ms": 30_000,
			"effective_ms": 7_777
		}]);
		let clamped: ShellRenderOutcome = serde_json::from_value(clamped_json).unwrap();
		let clamped = shell_renderer.view(&shell_state, Some(&clamped)).unwrap();
		assert!(clamped.contains("<time ms=7777 kind=duration/>"));
		assert!(!clamped.contains("<time ms=30000 kind=duration/>"));
		let error = shell_renderer
			.view(&shell_state, Some(&shell_error))
			.unwrap();
		assert!(error.contains("$ npx tsc --noEmit"));
		assert!(error.contains("error TS2339"));
		assert!(error.contains("<fact label=Exit><text fg=err>2</text></fact>"));

		let eval = &fixtures[1];
		let update: EvalUpdate =
			serde_json::from_slice(eval.progress_update.expect("eval progress")).unwrap();
		let eval_renderer = EvalRenderer;
		let mut eval_state = StreamState::default();
		let streaming_args = omp_core::slopjson::parse_streaming(eval.streaming_args);
		eval_renderer.fold_args(&mut eval_state, &streaming_args, false);
		eval_renderer.fold(&mut eval_state, update);
		let live = eval_renderer.view(&eval_state, None).unwrap();
		assert!(live.contains("load config"));
		assert!(live.contains("json.loads"));
		assert!(live.contains("label=running"));
		assert!(live.contains("<bytes value=31/>"), "{live}");
		assert!(live.contains("<pre fg=accent max-rows=12 overflow=code>"));
		let args = omp_core::slopjson::parse(eval.args).unwrap();
		eval_renderer.fold_args(&mut eval_state, &args, true);
		let eval_ok: CallOutcome<EvalPayload, EvalFault> =
			serde_json::from_slice(eval.success_outcome).unwrap();
		let eval_error: CallOutcome<EvalPayload, EvalFault> =
			serde_json::from_slice(eval.error_outcome).unwrap();
		let success = eval_renderer.view(&eval_state, Some(&eval_ok)).unwrap();
		assert!(success.contains("load config"));
		assert!(success.contains("json.loads"));
		assert_eq!(success.matches("@oh-my-pi/coding-agent v0.42.0").count(), 1);
		assert!(success.contains("@ai-sdk/anthropic"));
		assert!(success.contains("<json max-depth=3 max-rows=12 max-chars=80>"));
		assert!(success.contains("<time ms=64 kind=duration/>"));
		assert!(success.contains("<text fg=ok>complete</text>"));
		let error = eval_renderer.view(&eval_state, Some(&eval_error)).unwrap();
		assert!(error.contains("Traceback (most recent call last):"));
		assert!(error.contains("json.decoder.JSONDecodeError"));
		assert!(error.contains("<pre fg=err max-rows=20 overflow=traceback>"));
		assert!(error.contains("<time ms=41 kind=duration/>"));
		assert!(error.contains("<text fg=err>error</text>"));

		let fault = render_fault("eval", "session <lost>");
		assert_eq!(
			fault.to_tml().as_str(),
			"<callout kind=error>eval: session &lt;lost&gt;</callout>"
		);
	}
}
