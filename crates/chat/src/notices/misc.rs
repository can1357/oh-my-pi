//! Custom transcript notices: background-job deliveries, late LSP
//! diagnostics, `/tan` breadcrumbs, advisor notes, collaboration guest
//! bubbles, and collapsed synthetic input.

use std::fmt::Write as _;

use omp_core::{Str, StrMut, sf};
use omp_dom::{Node, PropId, Value};
use omp_journal::data::{
	AdvisorMessage, AdvisorNote, AdvisorSeverity, AsyncJobStatus, AsyncResult, LaunchCompletion,
	LaunchDaemonCompletion, LaunchDaemonStatus,
};
use omp_tui::{IntoComponent as _, dom};

use super::{format_duration, prop_text};
use crate::cards::{Component, file_link, path_language_icon};

/// Reads an async-result payload from its journal-derived user node.
#[must_use]
pub(crate) fn async_result(node: &Node) -> Option<AsyncResult> {
	if node.prop(&omp_dom::PropKey::Custom(Str::new_static("async_result")))
		!= Some(&Value::Bool(true))
	{
		return None;
	}
	let Value::Json(data) = node.prop(&PropId::Data.into())? else {
		return None;
	};
	let result: AsyncResult = serde_json::from_str(data.get()).ok()?;
	(!result.jobs.is_empty()).then_some(result)
}

/// Plain text represented by an async-result block. It carries every compact
/// row fact so transcript dumps and non-terminal projections match the visible
/// presentation; artifact and fault details remain in the model-facing body.
#[must_use]
pub(crate) fn async_result_text(result: &AsyncResult) -> Str {
	let mut text = StrMut::new("");
	for (index, job) in result.jobs.iter().enumerate() {
		if index > 0 {
			text.push('\n');
		}
		let _ = write!(text, "Background job {} [{}] {}", job.status, job.job_type, job.id);
		if !job.label.is_empty() {
			let _ = write!(text, " — {}", job.label);
		}
		let _ = write!(text, " ({})", format_duration(job.duration_ms));
	}
	text.freeze()
}

/// One compact success/failure row per completed background-job delivery.
#[must_use]
pub(crate) fn async_result_block(result: &AsyncResult) -> Component {
	let rows = result
		.jobs
		.iter()
		.map(|job| {
			let failed = job.status != AsyncJobStatus::Completed;
			let state = sf!("Background job {}", job.status);
			let kind = sf!("[{}]", job.job_type);
			let duration = sf!("({})", format_duration(job.duration_ms));
			let label = (!job.label.is_empty()).then(|| job.label.clone());
			dom! {
				<row gap=1 pad-x=1>
					if failed { <i:error fg=err/> } else { <i:done fg=ok/> }
					<text fg={if failed { "err" } else { "ok" }}>{state}</text>
					<text fg=muted dim>{kind}</text>
					<text fg=accent>{job.id.clone()}</text>
					if let Some(label) = label {
						<i:dash fg=muted dim/>
						<text fg=muted dim truncate=end>{label}</text>
					}
					<text fg=muted dim>{duration}</text>
				</row>
			}
			.into_component()
		})
		.collect::<Vec<Component>>();
	dom! { <col>{rows}</col> }.into_component()
}

/// Reads a supervised-process completion payload from its journal-derived
/// user node.
#[must_use]
pub(crate) fn launch_completion(node: &Node) -> Option<LaunchCompletion> {
	if node.prop(&omp_dom::PropKey::Custom(Str::new_static("launch_completion")))
		!= Some(&Value::Bool(true))
	{
		return None;
	}
	let Value::Json(data) = node.prop(&PropId::Data.into())? else {
		return None;
	};
	let completion: LaunchCompletion = serde_json::from_str(data.get()).ok()?;
	(!completion.daemons.is_empty()).then_some(completion)
}

/// Plain-text projection of supervised-process completion rows.
#[must_use]
pub(crate) fn launch_completion_text(completion: &LaunchCompletion) -> Str {
	let mut text = StrMut::new("");
	for (index, daemon) in completion.daemons.iter().enumerate() {
		if index > 0 {
			text.push('\n');
		}
		let _ = write!(text, "Supervised process {} {}", daemon.status, daemon.name);
		if let Some(code) = daemon.exit_code {
			let _ = write!(text, " (exit {code})");
		}
		let _ = write!(text, " ({})", format_duration(daemon.duration_ms));
		if let Some(fault) = &daemon.fault {
			let _ = write!(text, " — {}", fault.kind);
			if let Some(message) = &fault.message {
				let _ = write!(text, ": {message}");
			}
			if let Some(signal) = &fault.signal {
				let _ = write!(text, " ({signal})");
			}
		}
	}
	text.freeze()
}

/// Compact success/failure projection of one supervised-process completion.
#[must_use]
fn launch_daemon_row(daemon: &LaunchDaemonCompletion) -> Component {
	let failed = daemon.status == LaunchDaemonStatus::Failed;
	let state = sf!("Supervised process {}", daemon.status);
	let exit = daemon.exit_code.map(|code| sf!("(exit {code})"));
	let duration = sf!("({})", format_duration(daemon.duration_ms));
	let name = daemon.name.clone();
	dom! {
		<row gap=1 pad-x=1>
			if failed { <i:error fg=err/> } else { <i:done fg=ok/> }
			<text fg={if failed { "err" } else { "ok" }}>{state}</text>
			<text fg=accent>{name}</text>
			if let Some(exit) = exit { <text fg=muted dim>{exit}</text> }
			<text fg=muted dim>{duration}</text>
		</row>
	}
	.into_component()
}

/// One compact row per terminal supervised process.
#[must_use]
pub(crate) fn launch_completion_block(completion: &LaunchCompletion) -> Component {
	let rows = completion
		.daemons
		.iter()
		.map(launch_daemon_row)
		.collect::<Vec<Component>>();
	dom! { <col>{rows}</col> }.into_component()
}

/// Dispatches a `<notice kind=K>` custom kind to its renderer; `None` for
/// the controller kinds (`error | warn | info | success`) and anything else.
#[must_use]
pub fn custom_notice(kind: &str, node: &Node, expanded: bool) -> Option<Component> {
	match kind {
		"diagnostics" => Some(diagnostics_card(node, expanded)),
		"tangent" => Some(tangent_pill(node)),
		"advisor" => Some(advisor_card(node, expanded)),
		_ => None,
	}
}

/// One parsed `path:line:col [severity] [source] message (code)` line.
struct Diagnostic<'a> {
	path:     &'a str,
	line:     &'a str,
	col:      &'a str,
	severity: &'a str,
	message:  &'a str,
	code:     Option<&'a str>,
}

impl<'a> Diagnostic<'a> {
	fn parse(text: &'a str) -> Option<Self> {
		let (location, rest) = text.split_once(" [")?;
		let mut location = location.rsplitn(3, ':');
		let col = location.next()?;
		let line = location.next()?;
		let path = location.next()?;
		if path.is_empty() || !is_digits(line) || !is_digits(col) {
			return None;
		}
		let (severity, rest) = rest.split_once(']')?;
		if !matches!(severity, "error" | "warning" | "info" | "hint") {
			return None;
		}
		let mut message = rest.trim_start();
		if let Some(tail) = message.strip_prefix('[')
			&& let Some((_, tail)) = tail.split_once(']')
		{
			message = tail.trim_start();
		}
		let code = message
			.strip_suffix(')')
			.and_then(|body| body.rfind(" ("))
			.map(|at| (&message[at + 2..message.len() - 1], &message[..at]));
		let (code, message) = match code {
			Some((code, body)) => (Some(code), body),
			None => (None, message),
		};
		Some(Self { path, line, col, severity, message, code })
	}

	fn icon(&self) -> &'static str {
		match self.severity {
			"error" => "error",
			"warning" => "warning-status",
			_ => "info-status",
		}
	}

	fn color(&self) -> &'static str {
		match self.severity {
			"error" => "error",
			"warning" => "warning",
			_ => "output",
		}
	}
}

fn is_digits(text: &str) -> bool {
	!text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit())
}

fn legacy_diagnostics(node: &Node) -> omp_session::late_diagnostics::LateDiagnostics {
	let mut files = Vec::<omp_session::late_diagnostics::LateDiagnosticsFile>::new();
	for line in node
		.content
		.as_deref()
		.into_iter()
		.flat_map(str::lines)
		.map(str::trim_end)
		.filter(|line| !line.trim().is_empty())
	{
		let path = Diagnostic::parse(line).map_or("", |diagnostic| diagnostic.path);
		let index = files
			.iter()
			.position(|file| file.path == path)
			.unwrap_or_else(|| {
				files.push(omp_session::late_diagnostics::LateDiagnosticsFile {
					path:     Str::new(path),
					summary:  Str::new_static(""),
					errored:  false,
					messages: Vec::new(),
				});
				files.len() - 1
			});
		files[index].errored |= line.contains("[error]");
		files[index].messages.push(Str::new(line));
	}
	omp_session::late_diagnostics::LateDiagnostics { files }
}

/// Late LSP diagnostics that arrived after an edit tool returned. The typed
/// `files[]` payload is the durable grouping contract; both this card and edit
/// surfaces project the same file/diagnostic tree semantics.
#[must_use]
pub fn diagnostics_card(node: &Node, expanded: bool) -> Component {
	let diagnostics = omp_session::late_diagnostics::LateDiagnostics::from_node(node)
		.unwrap_or_else(|| legacy_diagnostics(node));
	let total = diagnostics
		.files
		.iter()
		.map(|file| file.messages.len())
		.sum::<usize>();
	if total == 0 {
		return dom! { <col/> }.into_component();
	}
	let limit = if expanded { total } else { total.min(5) };
	let errored = diagnostics.files.iter().any(|file| file.errored);
	let mut summary = StrMut::new("");
	for file in &diagnostics.files {
		if file.summary.is_empty() {
			continue;
		}
		if !summary.is_empty() {
			summary.push_str(", ");
		}
		summary.push_str(&file.summary);
	}

	let mut shown = 0usize;
	let mut file_blocks = Vec::new();
	for file in diagnostics
		.files
		.iter()
		.filter(|file| !file.messages.is_empty())
	{
		if shown == limit {
			break;
		}
		let take = (limit - shown).min(file.messages.len());
		let is_last_file = shown + take == total;
		let source_path = file.path.as_str();
		let path = file
			.messages
			.iter()
			.find_map(|message| Diagnostic::parse(message).map(|diagnostic| diagnostic.path))
			.unwrap_or(source_path);
		let href = file_link(source_path);
		let diagnostics = file
			.messages
			.iter()
			.take(take)
			.enumerate()
			.map(|(index, message)| {
				let last = index + 1 == take;
				match Diagnostic::parse(message) {
					Some(diagnostic) => {
						let icon = diagnostic.icon();
						let color = diagnostic.color();
						let location = sf!(":{}:{}", diagnostic.line, diagnostic.col);
						let message = diagnostic.message.replace('\t', "    ");
						let code = diagnostic.code.map(|code| sf!("({code})"));
						dom! {
							<row gap=1>
								if is_last_file { <text>{"  "}</text> } else { <icon name="tree-vertical" fg=muted dim/> }
								<icon name={if last { "tree-last" } else { "tree-branch" }} fg=muted dim/>
								<icon name={icon} fg={color}/>
								<text fg=muted dim href={href.clone()}>{location}</text>
								<text fg={color}>{message}</text>
								if let Some(code) = code { <text fg=muted dim>{code}</text> }
							</row>
						}
						.into_component()
					},
					None => {
						let color = if message.contains("[error]") {
							"error"
						} else if message.contains("[warning]") {
							"warning"
						} else {
							"muted"
						};
						dom! {
							<row gap=1>
								if is_last_file { <text>{"  "}</text> } else { <icon name="tree-vertical" fg=muted dim/> }
								<icon name={if last { "tree-last" } else { "tree-branch" }} fg=muted dim/>
								<text fg={color} grow>{message.replace('\t', "    ")}</text>
							</row>
						}
						.into_component()
					},
				}
			})
			.collect::<Vec<_>>();
		file_blocks.push(
			dom! {
				<col>
					<row gap=1>
						<icon name={if is_last_file { "tree-last" } else { "tree-branch" }} fg=muted dim/>
						<icon name={path_language_icon(path)} fg=muted/>
						<text fg=accent href={href}>{path}</text>
					</row>
					{diagnostics}
				</col>
			}
			.into_component(),
		);
		shown += take;
	}
	let remaining = total.saturating_sub(shown);
	dom! {
		<col pad-x=1>
			<row gap=1>
				if errored { <icon name="error" fg=error/> } else { <icon name="warning-status" fg=warning/> }
				<text bold>{"Late diagnostics"}</text>
				if !summary.is_empty() { <text fg=muted dim>{sf!("({summary})")}</text> }
			</row>
			<col pad-x=1>{file_blocks}</col>
			if remaining > 0 {
				<row pad-x=1 gap=1>
					<icon name="tree-last" fg=muted dim/>
					<text fg=muted>{sf!("… {remaining} more ⟨Ctrl+O: Expand⟩")}</text>
				</row>
			}
		</col>
	}
	.into_component()
}

/// Maximum preview length for background-tangent work.
const TAN_WORK_PREVIEW_LENGTH: usize = 56;

/// Previews work with tabs converted to spaces,
/// whitespace runs collapsed, cut to 55 characters plus `…`.
fn preview_work(work: &str) -> Str {
	let mut text = StrMut::with_capacity(work.len());
	for word in work.split_whitespace() {
		if !text.is_empty() {
			text.push(' ');
		}
		text.push_str(word);
	}
	if text.chars().count() <= TAN_WORK_PREVIEW_LENGTH {
		return text.freeze();
	}
	let mut cut = StrMut::with_capacity(TAN_WORK_PREVIEW_LENGTH + 3);
	cut.extend(text.chars().take(TAN_WORK_PREVIEW_LENGTH - 1));
	cut.push('…');
	cut.freeze()
}

/// `/tan` background-dispatch breadcrumb:
/// one muted row `<output> Tangent dispatched [task] <id> — <work>`, with the
/// job id in accent and the work preview dimmed.
#[must_use]
pub fn tangent_pill(node: &Node) -> Component {
	let id = prop_text(node, PropId::Id).unwrap_or_else(|| Str::new_static("unknown"));
	let work = prop_text(node, PropId::Label).map(|label| preview_work(&label));
	dom! {
		<row gap=1 pad-x=1>
			<icon name="output" fg=muted/>
			<text fg=muted>{"Tangent dispatched"}</text>
			<text fg=muted dim>{"[task]"}</text>
			<text fg=accent>{id}</text>
			if let Some(work) = work {
				<icon name="dash" fg=muted dim/>
				<text fg=muted dim>{work}</text>
			}
		</row>
	}
	.into_component()
}

/// Number of notes shown before the shared transcript expansion is engaged.
const COLLAPSED_ADVISOR_NOTES: usize = 3;

/// Reads the typed advisor payload from its journal-derived notice.
///
/// The legacy scalar shape remains readable so existing `.oms` sessions keep
/// their visible and copyable note after this clean producer cutover.
#[must_use]
pub(crate) fn advisor_message(node: &Node) -> Option<AdvisorMessage> {
	if let Some(Value::Json(data)) = node.prop(&PropId::Data.into())
		&& let Ok(message) = serde_json::from_str::<AdvisorMessage>(data.get())
		&& !message.notes.is_empty()
	{
		return Some(message);
	}
	let content = node.content.as_deref().unwrap_or_default().trim();
	let summary = prop_text(node, PropId::Label);
	if content.is_empty() && summary.is_none() {
		return None;
	}
	let mut note = StrMut::new("");
	if let Some(summary) = summary {
		note.push_str(summary.trim().as_str());
	}
	if !content.is_empty() {
		if !note.is_empty() {
			note.push('\n');
		}
		note.push_str(content);
	}
	let severity = prop_text(node, PropId::Severity)
		.and_then(|severity| severity.parse().ok())
		.unwrap_or_default();
	Some(AdvisorMessage {
		notes: vec![AdvisorNote {
			advisor: Str::new_static("default"),
			severity,
			note: note.freeze(),
		}],
	})
}

/// Complete clipboard/search projection of an advisor card.
#[must_use]
pub(crate) fn advisor_message_text(message: &AdvisorMessage) -> Str {
	let mut text = StrMut::new("");
	for (index, entry) in message.notes.iter().enumerate() {
		if index > 0 {
			text.push('\n');
		}
		let _ = write!(text, "[{}]", entry.severity);
		if entry.advisor != "default" {
			let _ = write!(text, " [{}]", entry.advisor.replace('\t', "    "));
		}
		if !entry.note.is_empty() {
			text.push(' ');
			text.push_str(entry.note.as_str());
		}
	}
	text.freeze()
}

fn severity_color(severity: AdvisorSeverity) -> &'static str {
	match severity {
		AdvisorSeverity::Blocker => "error",
		AdvisorSeverity::Concern => "warning",
		AdvisorSeverity::Nit => "muted",
	}
}

/// Batched advisor notes injected into the primary session: a counted header,
/// one attributed severity rail per
/// note, three-note collapsed preview, and every paragraph when expanded.
#[must_use]
pub fn advisor_card(node: &Node, expanded: bool) -> Component {
	let message = advisor_message(node).unwrap_or(AdvisorMessage { notes: Vec::new() });
	let blockers = message
		.notes
		.iter()
		.filter(|entry| entry.severity == AdvisorSeverity::Blocker)
		.count();
	let note_count = message.notes.len();
	let count_label = sf!("{note_count} {}", if note_count == 1 { "note" } else { "notes" });
	let blocker_label = (blockers > 0)
		.then(|| sf!("{blockers} {}", if blockers == 1 { "blocker" } else { "blockers" }));
	let shown = if expanded {
		message.notes.as_slice()
	} else {
		&message.notes[..message.notes.len().min(COLLAPSED_ADVISOR_NOTES)]
	};
	let rows = shown
		.iter()
		.map(|entry| {
			let color = severity_color(entry.severity);
			let severity: &'static str = entry.severity.into();
			let advisor =
				(entry.advisor != "default").then(|| sf!("[{}]", entry.advisor.replace('\t', "    ")));
			let mut paragraphs = entry
				.note
				.lines()
				.map(str::trim_end)
				.filter(|paragraph| !paragraph.trim().is_empty())
				.map(|paragraph| Str::new(paragraph.replace('\t', "    ")));
			let first = paragraphs.next();
			let rest = paragraphs.collect::<Vec<_>>();
			dom! {
				<row gap=1 pad-x=1>
					<hr vertical border=heavy fg={color}/>
					<col grow>
						<row gap=1>
							<row>
								<icon name="bracket-left" fg={color}/>
								<text fg={color}>{severity}</text>
								<icon name="bracket-right" fg={color}/>
							</row>
							if let Some(advisor) = advisor { <text fg=muted dim>{advisor}</text> }
							if let Some(first) = first {
								<text wrap=word grow>{first}</text>
							}
						</row>
						for paragraph in rest {
							<text wrap=word>{paragraph}</text>
						}
					</col>
				</row>
			}
			.into_component()
		})
		.collect::<Vec<Component>>();
	let hidden = message.notes.len().saturating_sub(shown.len());
	let hidden_label =
		(hidden > 0).then(|| sf!("… +{hidden} more {}", if hidden == 1 { "note" } else { "notes" }));
	dom! {
		<col pad-x=1>
			<row gap=1>
				<icon name="advisor" fg=accent/>
				<text bold fg=accent>{"Advisor"}</text>
				<row gap=0 fg=muted dim>
					<text>{count_label}</text>
					if let Some(blocker_label) = blocker_label {
						<icon name="dot"/>
						<text fg=error>{blocker_label}</text>
					}
				</row>
			</row>
			{rows}
			if let Some(hidden_label) = hidden_label {
				<row gap=1 pad-x=1>
					<hr vertical border=heavy fg=muted/>
					<text fg=muted dim>{hidden_label}</text>
				</row>
			}
		</col>
	}
	.into_component()
}

/// Collaboration guest prompt: the user
/// bubble under a bold accent `«author» ›` tag naming who typed it.
#[must_use]
pub fn guest_bubble(author: &str, text: Str) -> Component {
	let author = author.trim();
	let tag = sf!("«{}» ›", if author.is_empty() { "guest" } else { author });
	dom! {
		<col>
			<text fg=accent bold pad-x=1>{tag}</text>
			{bubble(text)}
		</col>
	}
	.into_component()
}

/// User-message bubble: Markdown on the `userMessageBg` tint with
/// one cell of padding on every side.
fn bubble(text: Str) -> Component {
	dom! { <md bg=surface pad="1 1">{text}</md> }.into_component()
}

/// Formats bytes as `512B`, `1.5KB`, or `2.3MB`.
pub(crate) fn format_bytes(bytes: usize) -> String {
	const KB: f64 = 1024.0;
	#[allow(clippy::cast_precision_loss, reason = "display rounding only")]
	let n = bytes as f64;
	if n < KB {
		format!("{bytes}B")
	} else if n < KB * KB {
		format!("{:.1}KB", n / KB)
	} else if n < KB * KB * KB {
		format!("{:.1}MB", n / (KB * KB))
	} else {
		format!("{:.1}GB", n / (KB * KB * KB))
	}
}

/// The first Markdown
/// heading's text, else `Synthetic input`.
fn synthetic_label(text: &str) -> &str {
	for raw in text.lines() {
		let line = raw.trim();
		if line.is_empty() {
			continue;
		}
		let hashes = line.bytes().take_while(|byte| *byte == b'#').count();
		if (1..=6).contains(&hashes)
			&& let Some(heading) = line[hashes..].strip_prefix(char::is_whitespace)
		{
			let heading = heading.trim();
			return if heading.is_empty() {
				"Synthetic input"
			} else {
				heading
			};
		}
		return "Synthetic input";
	}
	"Synthetic input"
}

/// Summarizes synthetic input as
/// `<label> · <size> · <n> lines`.
fn synthetic_summary(text: &str) -> Str {
	let lines = if text.is_empty() {
		0
	} else {
		text.split('\n').count()
	};
	sf!(
		"{} · {} · {lines} line{}",
		synthetic_label(text),
		format_bytes(text.len()),
		if lines == 1 { "" } else { "s" }
	)
}

/// Synthetic (agent-attributed) user input: one dim
/// `<label> · <size> · <n> lines · ctrl+o` row; expanded, the full bubble
/// follows it.
#[must_use]
pub fn synthetic_row(text: &str, expanded: bool) -> Component {
	let summary = sf!("{} · ctrl+o", synthetic_summary(text));
	let body = expanded.then(|| bubble(Str::new(text)));
	dom! {
		<col>
			<text fg=muted dim pad-x=1 truncate=end>{summary}</text>
			if let Some(body) = body { {body} }
		</col>
	}
	.into_component()
}

#[cfg(test)]
mod tests {
	use omp_dom::{KnownTag, PropKey, Tag, Value};
	use omp_tui::{CellContent, Color, Ui, UiContext, frame_text, with_link_url};
	use smallvec::smallvec;

	use super::*;

	fn notice(kind: &str, props: &[(PropId, &str)], content: Option<&str>) -> Node {
		let mut all: smallvec::SmallVec<(PropKey, Value), 4> =
			smallvec![(PropId::Kind.into(), Value::Str(Str::new(kind)))];
		for (prop, value) in props {
			all.push(((*prop).into(), Value::Str(Str::new(value))));
		}
		Node {
			tag:     Tag::Known(KnownTag::Notice),
			props:   all,
			kids:    Vec::new(),
			content: content.map(Str::new),
		}
	}

	fn advisor_notice(notes: Vec<AdvisorNote>) -> Node {
		let message = AdvisorMessage { notes };
		let data = serde_json::value::to_raw_value(&message).expect("advisor message serializes");
		Node {
			tag:     Tag::Known(KnownTag::Notice),
			props:   smallvec![
				(PropId::Kind.into(), Value::Str(Str::new_static("advisor"))),
				(PropId::Data.into(), Value::Json(data)),
			],
			kids:    Vec::new(),
			content: Some(Str::new_static("fallback advisor text")),
		}
	}

	fn render(component: Component, width: u16) -> String {
		let ui = Ui::from_root(component, width, UiContext::default());
		frame_text(ui.frame())
	}

	#[test]
	fn launch_completion_is_typed_and_compact() {
		let completion = LaunchCompletion {
			daemons: vec![
				LaunchDaemonCompletion {
					name:        Str::new_static("web"),
					status:      LaunchDaemonStatus::Completed,
					exit_code:   Some(0),
					duration_ms: 2_500,
					fault:       None,
				},
				LaunchDaemonCompletion {
					name:        Str::new_static("worker"),
					status:      LaunchDaemonStatus::Failed,
					exit_code:   Some(17),
					duration_ms: 80_000,
					fault:       Some(omp_journal::data::LaunchDaemonFault {
						kind:    omp_journal::data::LaunchDaemonFaultKind::Failed,
						message: Some(Str::new_static("readiness process exited")),
						signal:  Some(Str::new_static("SIGTERM")),
					}),
				},
			],
		};
		let data = serde_json::value::to_raw_value(&completion).expect("completion serializes");
		let node = Node {
			tag:     Tag::Known(KnownTag::User),
			props:   smallvec![
				(PropKey::Custom(Str::new_static("launch_completion")), Value::Bool(true),),
				(PropId::Data.into(), Value::Json(data)),
			],
			kids:    Vec::new(),
			content: Some(Str::new_static("model-facing completion notice")),
		};
		assert_eq!(launch_completion(&node), Some(completion.clone()));

		let text = launch_completion_text(&completion);
		assert_eq!(
			text.as_str(),
			"Supervised process completed web (exit 0) (2.5s)\nSupervised process failed worker \
			 (exit 17) (1m20s) — failed: readiness process exited (SIGTERM)"
		);
		let rendered = render(launch_completion_block(&completion), 80);
		assert!(
			rendered.contains("Supervised process completed web (exit 0) (2.5s)"),
			"{rendered:?}"
		);
		assert!(
			rendered.contains("Supervised process failed worker (exit 17) (1m20s)"),
			"{rendered:?}"
		);
		assert!(
			!rendered.contains("readiness process exited"),
			"fault detail stays out of the compact row: {rendered:?}"
		);
	}

	#[test]
	fn tangent_pill_text() {
		let node = notice(
			"tangent",
			&[(PropId::Id, "job-7"), (PropId::Label, "refactor\tthe   parser\nand add tests")],
			None,
		);
		let text = render(tangent_pill(&node), 80);
		assert_eq!(text, " ⤴ Tangent dispatched [task] job-7 — refactor the parser and add tests");

		let long = "a".repeat(40) + " " + &"b".repeat(40);
		let preview = preview_work(&long);
		assert_eq!(preview.chars().count(), TAN_WORK_PREVIEW_LENGTH);
		assert!(preview.ends_with('…'));
		let exact = "x".repeat(TAN_WORK_PREVIEW_LENGTH);
		assert_eq!(preview_work(&exact), exact.as_str(), "exactly 56 characters is not cut");

		let bare = notice("tangent", &[(PropId::Id, "job-8")], None);
		assert_eq!(render(tangent_pill(&bare), 80), " ⤴ Tangent dispatched [task] job-8");
		assert!(custom_notice("tangent", &bare, false).is_some());
		assert!(custom_notice("error", &bare, false).is_none());
	}

	fn rail_color(component: Component) -> omp_tui::Color {
		let ui = Ui::from_root(component, 40, UiContext::default());
		let frame = ui.frame();
		for y in 0..frame.size().height {
			for x in 0..frame.size().width {
				if let CellContent::Grapheme { text, .. } = frame.cell(x, y).content()
					&& text == "┃"
				{
					return frame.cell(x, y).style().foreground_color();
				}
			}
		}
		panic!("no rail painted:\n{}", frame_text(frame));
	}

	#[test]
	fn advisor_batch_counts_attributes_collapses_and_wraps() {
		let theme = UiContext::default().theme;
		let node = advisor_notice(vec![
			AdvisorNote {
				advisor:  Str::new_static("security"),
				severity: AdvisorSeverity::Blocker,
				note:     Str::new_static(
					"The retry loop re-reads the config every time.\nCache it outside the loop.",
				),
			},
			AdvisorNote {
				advisor:  Str::new_static("performance"),
				severity: AdvisorSeverity::Concern,
				note:     Str::new_static("Avoid rebuilding the complete transcript for each delta."),
			},
			AdvisorNote {
				advisor:  Str::new_static("default"),
				severity: AdvisorSeverity::Nit,
				note:     Str::new_static("Keep the helper private."),
			},
			AdvisorNote {
				advisor:  Str::new_static("security"),
				severity: AdvisorSeverity::Blocker,
				note:     Str::new_static("Do not log the credential."),
			},
			AdvisorNote {
				advisor:  Str::new_static("docs"),
				severity: AdvisorSeverity::Nit,
				note:     Str::new_static("Name the public contract."),
			},
		]);
		assert_eq!(advisor_message(&node).expect("typed message").notes.len(), 5);
		assert_eq!(rail_color(advisor_card(&node, false)), theme.err);

		let collapsed = render(advisor_card(&node, false), 80);
		assert!(collapsed.contains("Advisor 5 notes · 2 blockers"), "{collapsed:?}");
		assert!(collapsed.contains("⟦blocker⟧ [security]"), "{collapsed:?}");
		assert!(collapsed.contains("⟦concern⟧ [performance]"), "{collapsed:?}");
		assert!(collapsed.contains("⟦nit⟧ Keep the helper private."), "{collapsed:?}");
		assert!(collapsed.contains("… +2 more notes"), "{collapsed:?}");
		assert!(!collapsed.contains("Do not log the credential."), "{collapsed:?}");

		let expanded = render(advisor_card(&node, true), 42);
		assert!(expanded.contains("Do not log") && expanded.contains("credential."), "{expanded:?}");
		assert!(
			expanded.contains("Name the public") && expanded.contains("contract."),
			"{expanded:?}"
		);
		assert!(!expanded.contains("more notes"), "{expanded:?}");
		assert!(
			expanded.contains("complete")
				&& expanded.contains("transcript")
				&& expanded.contains("delta"),
			"long paragraph wraps without disappearing: {expanded:?}"
		);
		assert_eq!(
			advisor_message_text(&advisor_message(&node).expect("typed message")).as_str(),
			"[blocker] [security] The retry loop re-reads the config every time.\nCache it outside \
			 the loop.\n[concern] [performance] Avoid rebuilding the complete transcript for each \
			 delta.\n[nit] Keep the helper private.\n[blocker] [security] Do not log the \
			 credential.\n[nit] [docs] Name the public contract."
		);

		let legacy = notice(
			"advisor",
			&[(PropId::Severity, "concern"), (PropId::Label, "Tests are missing")],
			Some("The parser change has no coverage."),
		);
		assert!(render(advisor_card(&legacy, false), 60).contains("Tests are missing"));
	}

	#[test]
	fn synthetic_row_collapses_size_and_lines() {
		let mut text = String::from("# Session update\n");
		for index in 0..13 {
			text.push_str(&format!("line {index} of the replay dump {}\n", "x".repeat(64)));
		}
		let text = text.trim_end().to_owned();
		assert_eq!(text.split('\n').count(), 14);
		assert_eq!(text.len(), 1202, "1202 bytes is 1.2KB");
		assert_eq!(synthetic_summary(&text), "Session update · 1.2KB · 14 lines");
		assert_eq!(synthetic_summary(""), "Synthetic input · 0B · 0 lines");
		assert_eq!(synthetic_summary("one"), "Synthetic input · 3B · 1 line");
		assert_eq!(synthetic_summary("#no heading\nmore"), "Synthetic input · 16B · 2 lines");

		let collapsed = render(synthetic_row(&text, false), 60);
		assert_eq!(collapsed, " Session update · 1.2KB · 14 lines · ctrl+o");
		let expanded = render(synthetic_row(&text, true), 60);
		assert!(expanded.starts_with(" Session update · 1.2KB · 14 lines · ctrl+o\n"));
		// The expanded body is
		// the Markdown `UserMessageComponent`, so the heading renders as a
		// heading rather than its raw `#` source.
		assert!(expanded.contains("\n Session update\n\n line 0 of the replay dump"), "{expanded:?}");
		assert!(!expanded.contains("# Session update"), "{expanded:?}");
	}

	#[test]
	fn guest_bubble_prefixes_bold_author_and_user_tinted_markdown() {
		let ui = Ui::from_root(
			guest_bubble("alice", Str::new_static("can we ship **today**?")),
			40,
			UiContext::default(),
		);
		let text = frame_text(ui.frame());
		let lines: Vec<&str> = text.lines().collect();
		assert_eq!(lines[0], " «alice» ›");
		assert_eq!(lines[1], "", "tinted padding row above the bubble body");
		assert_eq!(lines[2], " can we ship today?");
		assert!(ui.frame().cell(1, 0).style().spec().bold, "authenticated author tag is bold");
		assert_ne!(
			ui.frame().cell(1, 2).style().background_color(),
			Color::Default,
			"Markdown body receives the semantic user-message tint"
		);
		let anonymous = render(guest_bubble("  ", Str::new_static("hi")), 40);
		assert!(anonymous.starts_with(" «guest» ›\n"));
	}

	#[test]
	fn diagnostics_group_by_file_cap_then_expand() {
		use omp_session::late_diagnostics::{LateDiagnostics, LateDiagnosticsFile};

		let payload = LateDiagnostics {
			files: vec![
				LateDiagnosticsFile {
					path:     Str::new_static("/abs/src/lib.rs"),
					summary:  Str::new_static("2 error(s), 2 warning(s)"),
					errored:  true,
					messages: vec![
						Str::new_static("src/lib.rs:12:5 [error] [rustc] mismatched types (E0308)"),
						Str::new_static("src/lib.rs:40:1 [warning] [rustc] unused import"),
						Str::new_static("src/lib.rs:41:1 [error] [rustc] missing field (E0063)"),
						Str::new_static("src/lib.rs:50:2 [warning] [rustc] unused variable"),
					],
				},
				LateDiagnosticsFile {
					path:     Str::new_static("/abs/src/main.rs"),
					summary:  Str::new_static("2 warning(s)"),
					errored:  false,
					messages: vec![
						Str::new_static("src/main.rs:3:1 [warning] [rustc] unused import"),
						Str::new_static("src/main.rs:9:4 [warning] [rustc] unused result"),
					],
				},
			],
		};
		let data = serde_json::value::to_raw_value(&payload).expect("diagnostics serialize");
		let node = Node {
			tag:     Tag::Known(KnownTag::Developer),
			props:   smallvec![
				(PropId::Kind.into(), Value::Str(Str::new_static("diagnostics"))),
				(PropId::Data.into(), Value::Json(data)),
			],
			kids:    Vec::new(),
			content: Some(payload.body()),
		};

		let ui = Ui::from_root(diagnostics_card(&node, false), 100, UiContext::default());
		let frame = ui.frame();
		let collapsed = frame_text(frame);
		let size = frame.size();
		let href = (0..size.height).find_map(|row| {
			(0..size.width).find_map(|col| {
				frame
					.cell(col, row)
					.style()
					.spec()
					.link
					.and_then(|link| with_link_url(link, str::to_owned))
			})
		});
		assert!(
			href
				.as_deref()
				.is_some_and(|href| href.ends_with("/src/lib.rs")),
			"file rows and locations expose the source path as a terminal link: {href:?}"
		);
		assert!(collapsed.contains("Late diagnostics (2 error(s), 2 warning(s), 2 warning(s))"));
		assert!(collapsed.contains("src/lib.rs"));
		assert!(collapsed.contains("src/main.rs"));
		assert!(collapsed.contains(":12:5 mismatched types (E0308)"));
		assert!(collapsed.contains("… 1 more ⟨Ctrl+O: Expand⟩"));
		assert!(!collapsed.contains("unused result"));

		let expanded = render(diagnostics_card(&node, true), 100);
		assert!(expanded.contains("unused result"));
		assert!(!expanded.contains("Ctrl+O: Expand"));

		let empty = Node {
			tag:     Tag::Known(KnownTag::Developer),
			props:   smallvec![
				(PropId::Kind.into(), Value::Str(Str::new_static("diagnostics"))),
				(
					PropId::Data.into(),
					Value::Json(
						serde_json::value::to_raw_value(&LateDiagnostics::default())
							.expect("empty diagnostics serialize"),
					),
				),
			],
			kids:    Vec::new(),
			content: None,
		};
		assert_eq!(render(diagnostics_card(&empty, false), 100), "");
	}
}
