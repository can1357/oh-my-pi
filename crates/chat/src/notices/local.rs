//! Neutral transcript blocks for user-local `!` and `$` execution.
//!
//! A local run is a tool element in a turn with no user, developer, or
//! assistant message. It deliberately does not use the model-invoked bash or
//! eval card: the command is user-authored, its output is local presentation,
//! and central output bounding is an informational artifact continuation rather
//! than a tool failure.

use omp_core::{Str, StrMut, sf};
use omp_dom::{Dom, Handle, KnownTag, Node, PropId, PropKey, Tag, Value};
use omp_tui::{IntoComponent as _, dom};

use crate::cards::Component;

/// Logical rows retained by a collapsed local execution.
const PREVIEW_LINES: usize = 20;

/// One local executor flavor.
#[derive(Clone, Copy, Debug, Eq, PartialEq, strum::IntoStaticStr)]
pub(crate) enum LocalKind {
	#[strum(serialize = "bash execution")]
	Bash,
	#[strum(serialize = "eval execution")]
	Eval,
}

/// Semantic facts projected from one local execution element.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct LocalExecution {
	pub(crate) kind:     LocalKind,
	pub(crate) command:  Str,
	pub(crate) output:   Str,
	pub(crate) status:   Str,
	pub(crate) artifact: Option<Str>,
	pub(crate) clamped:  u64,
	pub(crate) excluded: bool,
}

impl LocalExecution {
	pub(crate) fn finalized(&self) -> bool {
		matches!(self.status.as_str(), "ok" | "error" | "cancelled" | "aborted")
	}

	/// Whole-message clipboard payload.
	pub(crate) fn copy_text(&self) -> Str {
		let mut text = StrMut::new(self.command.as_str());
		if !self.output.trim().is_empty() {
			text.push_str("\n");
			text.push_str(self.output.as_str());
		}
		text.freeze()
	}

	/// Plain semantic descriptor; never includes the raw structured diagnostic.
	pub(crate) fn transcript_text(&self) -> Str {
		let mut text = StrMut::new(match self.kind {
			LocalKind::Bash => "$ ",
			LocalKind::Eval => ">>> ",
		});
		text.push_str(self.command.as_str());
		if !self.output.trim().is_empty() {
			text.push_str("\n");
			text.push_str(self.output.as_str());
		}
		if let Some(artifact) = &self.artifact {
			text.push_str("\nOutput continues at ");
			text.push_str(artifact.as_str());
		}
		text.freeze()
	}
}

/// Whether a tool element belongs to a user-local run. The explicit
/// presentation property is authoritative; executor name and call id never
/// select presentation identity.
#[must_use]
pub(crate) fn is_local(node: &Node) -> bool {
	node
		.prop(&PropKey::Custom(Str::new_static(omp_agent::LOCAL_PRESENTATION_PROP)))
		.and_then(Value::as_str)
		== Some(omp_agent::LOCAL_PRESENTATION_VALUE)
}

/// Reads a user-local bash/eval element, including its bounded output and the
/// structured informational continuation written by central dispatch.
#[must_use]
pub(crate) fn execution(dom: &Dom, handle: Handle, node: &Node) -> Option<LocalExecution> {
	if !matches!(&node.tag, Tag::Custom(_)) {
		return None;
	}
	if !is_local(node) {
		return None;
	}
	let kind = match node
		.prop(&PropKey::Custom(Str::new_static(omp_agent::LOCAL_KIND_PROP)))
		.and_then(Value::as_str)?
	{
		"bash" => LocalKind::Bash,
		"eval" => LocalKind::Eval,
		_ => return None,
	};
	let command = node
		.prop(&PropKey::Custom(Str::new_static(omp_agent::LOCAL_INPUT_PROP)))
		.and_then(Value::as_str)
		.map(Str::new)?;
	let status = node
		.prop(&PropId::Status.into())
		.and_then(Value::as_str)
		.map(Str::new)
		.unwrap_or_else(|| Str::new_static("running"));
	let result_handle = child_handle(dom, handle, KnownTag::Result);
	let streamed = result_handle.and_then(|result| dom.stream_text(result, &PropId::Text.into()));
	let result = result_handle
		.and_then(|result| dom.get(result))
		.and_then(node_text);
	let mut artifact = None;
	let mut clamped = 0_u64;
	let mut fault = None;
	for child_handle in dom.children(handle) {
		let Some(diag) = dom.get(*child_handle) else {
			continue;
		};
		if diag.tag != Tag::Known(KnownTag::Diag) {
			continue;
		}
		if let Some(info) = overflow_info(diag) {
			artifact = info.0.or(artifact);
			clamped = clamped.saturating_add(info.1);
			continue;
		}
		if diag.prop(&PropId::Fault.into()).is_some() {
			fault = node_text(diag).map(Str::new);
		}
	}
	let output = streamed
		.filter(|text| !text.is_empty())
		.map(Str::new)
		.or_else(|| result.filter(|text| !text.is_empty()).map(Str::new))
		.or(fault)
		.unwrap_or_default();
	let excluded = node
		.prop(&PropKey::Custom(Str::new_static(omp_session::projection::LOCAL_CONTEXT_PROP)))
		.and_then(Value::as_str)
		== Some(omp_session::projection::LOCAL_CONTEXT_EXCLUDED);
	Some(LocalExecution { kind, command, output, status, artifact, clamped, excluded })
}

/// Renders the distinct local block. Its frame remains neutral for every
/// state; only the terminal status line uses warning/error semantics. Output
/// spill remains an informational link and never turns the block into an
/// error card.
#[must_use]
pub(crate) fn execution_block(run: &LocalExecution, expanded: bool) -> Component {
	let (hidden, output) = output_tail(&run.output, expanded);
	let command_fg = if run.excluded { "muted" } else { "accent" };
	let header = match run.kind {
		LocalKind::Bash => {
			let command = sf!("$ {}", run.command);
			dom! { <text fg={command_fg} bold>{command}</text> }.into_component()
		},
		LocalKind::Eval => {
			let command = eval_header(run.command.as_str());
			dom! { <pre path="local.py" fg={command_fg}>{command}</pre> }.into_component()
		},
	};
	let running = matches!(run.status.as_str(), "arguments" | "running");
	let cancelled = matches!(run.status.as_str(), "cancelled" | "aborted");
	let failed = run.status.as_str() == "error";
	let artifact = run.artifact.clone();
	let clamped = (run.clamped > 0).then(|| sf!("· {} lines clamped", run.clamped));
	dom! {
		<col>
			<hr bc=muted/>
			<col pad-x=1>
				{header}
				if !output.is_empty() {
					<spacer h=1/>
					<pre fg=output>{output}</pre>
				}
				if hidden > 0 {
					<text fg=muted>{format!("… {hidden} more lines (ctrl+o to expand)")}</text>
				}
				if let Some(artifact) = artifact {
					<row gap=1 fg=muted>
						<i:info-status/>
						<text>{"Output continues at"}</text>
						<a href={artifact.clone()}>{artifact}</a>
						if let Some(clamped) = clamped { <text>{clamped}</text> }
					</row>
				}
				if running {
					<row gap=1><spinner kind=status fg=accent/><text fg=muted>{"Running… (esc to cancel)"}</text></row>
				} else if cancelled {
					<text fg=warn>{"(cancelled)"}</text>
				} else if failed {
					<text fg=err>{match run.kind { LocalKind::Bash => "Command failed", LocalKind::Eval => "Execution failed" }}</text>
				}
			</col>
			<hr bc=muted/>
		</col>
	}
	.into_component()
}

/// Last `PREVIEW_LINES` logical rows; the caller places the hidden-count hint
/// after them.
fn output_tail(output: &Str, expanded: bool) -> (usize, Str) {
	let trimmed = output.as_str().trim_end();
	if trimmed.is_empty() {
		return (0, Str::default());
	}
	let total = trimmed.lines().count();
	if expanded || total <= PREVIEW_LINES {
		return (0, output.slice(..trimmed.len()));
	}
	let hidden = total - PREVIEW_LINES;
	let start = trimmed
		.match_indices('\n')
		.nth(hidden - 1)
		.map_or(0, |(at, _)| at + 1);
	(hidden, output.slice(start..trimmed.len()))
}

fn eval_header(code: &str) -> Str {
	let mut out = StrMut::new("");
	for (index, line) in code.lines().enumerate() {
		if index > 0 {
			out.push_str("\n");
		}
		out.push_str(if index == 0 { ">>> " } else { "    " });
		out.push_str(line);
	}
	if code.is_empty() {
		out.push_str(">>>");
	}
	out.freeze()
}

fn overflow_info(node: &Node) -> Option<(Option<Str>, u64)> {
	let Value::Json(raw) = node.prop(&PropId::Data.into())? else {
		return None;
	};
	let value: serde_json::Value = serde_json::from_str(raw.get()).ok()?;
	(value.get("kind").and_then(serde_json::Value::as_str) == Some("truncated")
		&& value.get("severity").and_then(serde_json::Value::as_str) == Some("info"))
	.then(|| {
		(
			value
				.get("artifact")
				.and_then(serde_json::Value::as_str)
				.map(Str::new),
			value
				.get("lines_clamped")
				.and_then(serde_json::Value::as_u64)
				.unwrap_or(0),
		)
	})
}

fn child_handle(dom: &Dom, parent: Handle, tag: KnownTag) -> Option<Handle> {
	dom.children(parent).iter().copied().find(|handle| {
		dom.get(*handle)
			.is_some_and(|node| node.tag == Tag::Known(tag))
	})
}

fn node_text(node: &Node) -> Option<&str> {
	node
		.prop(&PropId::Text.into())
		.and_then(Value::as_str)
		.filter(|text| !text.is_empty())
		.or(node.content.as_deref())
}
