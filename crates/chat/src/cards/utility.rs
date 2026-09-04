//! Typed cards for checkpointing, structured yield, memory maintenance, skills,
//! and media.

use omp_core::{Str, sf};
use omp_tui::{IntoComponent as _, UiContext, dom};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{
	Card, CardStatus, CardView, Component, GenericCard, elapsed_badge, result_image, typed_fault,
	typed_input, typed_result,
};

/// Durable checkpoint creation card.
pub struct CheckpointCard;
/// Scheduled rewind card.
pub struct RewindCard;
/// Structured subagent-yield card.
pub struct YieldCard;
/// Scoped memory mutation card.
pub struct MemoryEditCard;
/// Durable lesson card.
pub struct LearnCard;
/// Managed-skill mutation card.
pub struct ManageSkillCard;
/// Image-generation card.
pub struct ImageGenCard;
/// Speech-generation card.
pub struct TtsCard;
/// Security analysis card.
pub struct SecurityScanCard;

impl Card for CheckpointCard {
	fn tool(&self) -> &'static str {
		"checkpoint"
	}

	fn render(&self, view: &CardView<'_>, expanded: bool, _ui: &UiContext) -> Component {
		let args = typed_input::<omp_tools::checkpoint::CheckpointParams>(view);
		let result = typed_result::<omp_tools::checkpoint::CheckpointPayload>(view);
		let created = result
			.as_ref()
			.filter(|value| value.get("action").and_then(Value::as_str) == Some("created"))
			.and_then(|value| value.get("checkpoints"))
			.and_then(Value::as_array)
			.and_then(|checkpoints| checkpoints.first());
		let listed = result
			.as_ref()
			.filter(|value| value.get("action").and_then(Value::as_str) == Some("listed"))
			.and_then(|value| value.get("checkpoints"))
			.and_then(Value::as_array);
		let action = args
			.as_ref()
			.and_then(|value| value.get("action"))
			.and_then(Value::as_str)
			.unwrap_or("create");
		let detail = created
			.and_then(|checkpoint| checkpoint.get("goal"))
			.and_then(Value::as_str)
			.or_else(|| args.as_ref()?.get("goal")?.as_str())
			.unwrap_or_else(|| {
				if action == "list" {
					"selected branch"
				} else {
					""
				}
			});
		let receipt = created
			.and_then(|checkpoint| checkpoint.get("label"))
			.and_then(Value::as_str)
			.map(Str::new)
			.or_else(|| listed.map(|rows| sf!("{} checkpoint(s)", rows.len())));
		let card = semantic_row(
			"checkpoint",
			if action == "list" {
				"Checkpoints"
			} else {
				"Checkpoint"
			},
			detail,
			receipt.as_deref(),
			typed_fault::<omp_tools::checkpoint::Fault>(view),
			view,
		);
		if !expanded {
			return card;
		}
		let rows = listed
			.into_iter()
			.flatten()
			.filter_map(|checkpoint| {
				Some((
					Str::new(checkpoint.get("label")?.as_str()?),
					Str::new(checkpoint.get("token")?.as_str()?),
					checkpoint
						.get("parent_token")
						.and_then(Value::as_str)
						.map(Str::new),
				))
			})
			.collect::<Vec<_>>();
		dom! {
			<col>
				{card}
				for (label, token, parent) in rows {
					<row gap=1 pad-x=2>
						<text bold>{label}</text><text fg=muted>{token}</text>
						if let Some(parent) = parent {
							<text fg=muted>{"←"}</text><text fg=muted>{parent}</text>
						}
					</row>
				}
			</col>
		}
		.into_component()
	}
}

impl Card for RewindCard {
	fn tool(&self) -> &'static str {
		"rewind"
	}

	fn render(&self, view: &CardView<'_>, _expanded: bool, _ui: &UiContext) -> Component {
		let args = typed_input::<omp_tools::checkpoint::RewindParams>(view);
		let result = typed_result::<omp_tools::checkpoint::RewindPayload>(view);
		let report = result
			.as_ref()
			.and_then(|value| value.get("report"))
			.and_then(Value::as_str)
			.or_else(|| args.as_ref()?.get("report")?.as_str())
			.unwrap_or_default();
		let label = result
			.as_ref()
			.and_then(|value| value.get("checkpoint"))
			.and_then(|checkpoint| checkpoint.get("label"))
			.and_then(Value::as_str)
			.or_else(|| args.as_ref()?.get("checkpoint")?.as_str());
		let receipt = result
			.as_ref()
			.and_then(|value| value.get("workspace"))
			.map(|workspace| {
				sf!(
					"{} · {} written · {} deleted · {} unchanged",
					label.unwrap_or_default(),
					workspace
						.get("written")
						.and_then(Value::as_u64)
						.unwrap_or_default(),
					workspace
						.get("deleted")
						.and_then(Value::as_u64)
						.unwrap_or_default(),
					workspace
						.get("unchanged")
						.and_then(Value::as_u64)
						.unwrap_or_default(),
				)
			})
			.or_else(|| label.map(Str::new));
		semantic_row(
			"rewind",
			"Rewind",
			report,
			receipt.as_deref(),
			typed_fault::<omp_tools::checkpoint::Fault>(view),
			view,
		)
	}
}

impl Card for YieldCard {
	fn tool(&self) -> &'static str {
		"yield"
	}

	fn render(&self, view: &CardView<'_>, _expanded: bool, _ui: &UiContext) -> Component {
		let args = typed_input::<omp_tools::yield_tool::Params>(view);
		let result = typed_result::<omp_tools::yield_tool::Payload>(view);
		let incremental = result
			.as_ref()
			.and_then(|value| value.get("incremental"))
			.and_then(Value::as_bool)
			.unwrap_or(false);
		let detail = if incremental {
			"incremental section"
		} else {
			"terminal result"
		};
		let kind = args
			.as_ref()
			.and_then(|value| value.get("type"))
			.map(compact_json)
			.unwrap_or_default();
		semantic_row(
			"output",
			"Submit result",
			detail,
			(!kind.is_empty()).then_some(kind.as_str()),
			typed_fault::<omp_tools::yield_tool::Fault>(view),
			view,
		)
	}
}

impl Card for MemoryEditCard {
	fn tool(&self) -> &'static str {
		"memory_edit"
	}

	fn render(&self, view: &CardView<'_>, _expanded: bool, _ui: &UiContext) -> Component {
		let args = typed_input::<omp_tools::memory_edit::Params>(view);
		let result = typed_result::<omp_tools::memory_edit::EditOutcome>(view);
		let operation = result
			.as_ref()
			.and_then(|value| value.get("operation"))
			.and_then(Value::as_str)
			.or_else(|| args.as_ref()?.get("op")?.as_str())
			.unwrap_or("edit");
		let id = result
			.as_ref()
			.and_then(|value| value.get("id"))
			.and_then(Value::as_str)
			.or_else(|| args.as_ref()?.get("id")?.as_str())
			.unwrap_or_default();
		let status = result
			.as_ref()
			.and_then(|value| value.get("status"))
			.and_then(Value::as_str);
		let tier = result
			.as_ref()
			.and_then(|value| value.get("tier"))
			.and_then(Value::as_str);
		let meta = match (status, tier) {
			(Some(status), Some(tier)) => Some(sf!("{status} · {tier}")),
			(Some(status), None) => Some(Str::new(status)),
			(None, _) => None,
		};
		semantic_row(
			"memory-tool",
			"Memory",
			&sf!("{operation} {id}"),
			meta.as_deref(),
			typed_fault::<omp_tools::memory_edit::Fault>(view),
			view,
		)
	}
}

impl Card for LearnCard {
	fn tool(&self) -> &'static str {
		"learn"
	}

	fn render(&self, view: &CardView<'_>, expanded: bool, _ui: &UiContext) -> Component {
		let args = typed_input::<omp_tools::learn::Params>(view);
		let result = typed_result::<omp_tools::learn::LearnOutcome>(view);
		let memory = args
			.as_ref()
			.and_then(|value| value.get("memory"))
			.and_then(Value::as_str)
			.unwrap_or_default();
		let id = result
			.as_ref()
			.and_then(|value| value.get("memory_id"))
			.and_then(Value::as_str);
		let body = if expanded {
			memory
		} else {
			memory.lines().next().unwrap_or_default()
		};
		semantic_row(
			"memory-tool",
			"Learn",
			body,
			id,
			typed_fault::<omp_tools::learn::Fault>(view),
			view,
		)
	}
}

impl Card for ManageSkillCard {
	fn tool(&self) -> &'static str {
		"manage_skill"
	}

	fn render(&self, view: &CardView<'_>, _expanded: bool, _ui: &UiContext) -> Component {
		let args = typed_input::<omp_tools::manage_skill::Params>(view);
		let result = typed_result::<omp_tools::manage_skill::MutationOutcome>(view);
		let action = result
			.as_ref()
			.and_then(|value| value.get("action"))
			.and_then(Value::as_str)
			.or_else(|| args.as_ref()?.get("action")?.as_str())
			.unwrap_or("manage");
		let name = result
			.as_ref()
			.and_then(|value| value.get("name"))
			.and_then(Value::as_str)
			.or_else(|| args.as_ref()?.get("name")?.as_str())
			.unwrap_or_default();
		let path = result
			.as_ref()
			.and_then(|value| value.get("path"))
			.and_then(Value::as_str);
		semantic_row(
			"skill",
			"Skill",
			&sf!("{action} {name}"),
			path,
			typed_fault::<omp_tools::manage_skill::Fault>(view),
			view,
		)
	}
}

#[derive(Deserialize, Serialize)]
struct MediaPayload {
	artifact_id: Str,
	media_type:  Str,
	output_path: Option<Str>,
	#[serde(default)]
	bytes:       Option<u64>,
	#[serde(default)]
	voice_id:    Option<Str>,
	#[serde(default)]
	codec:       Option<Str>,
	#[serde(default)]
	backend:     Option<Str>,
	#[serde(default)]
	sample_rate: Option<u32>,
}

impl Card for ImageGenCard {
	fn tool(&self) -> &'static str {
		"image_gen"
	}

	fn render(&self, view: &CardView<'_>, expanded: bool, ui: &UiContext) -> Component {
		render_media(view, expanded, ui, false)
	}
}

impl Card for TtsCard {
	fn tool(&self) -> &'static str {
		"tts"
	}

	fn render(&self, view: &CardView<'_>, expanded: bool, ui: &UiContext) -> Component {
		render_media(view, expanded, ui, true)
	}
}

impl Card for SecurityScanCard {
	fn tool(&self) -> &'static str {
		"security_scan"
	}

	fn render(&self, view: &CardView<'_>, expanded: bool, _ui: &UiContext) -> Component {
		let result = typed_result::<omp_tools::security_scan::Payload>(view);
		let summary = result
			.as_ref()
			.and_then(|value| value.get("output"))
			.and_then(Value::as_str)
			.unwrap_or("repository security analysis");
		let detail = expanded
			.then(|| result.as_ref()?.get("data").map(compact_json))
			.flatten();
		let fault = typed_fault::<omp_tools::security_scan::Fault>(view);
		dom! {
			<col>
				<row gap=1>
					match view.status {
						CardStatus::Failed => <i:error/>,
						CardStatus::Done => <i:success/>,
						CardStatus::StreamingArgs | CardStatus::InProgress => <spinner kind=status/>,
					}
					<text bold>{"Security scan"}</text><text>{summary}</text>
					if let Some(badge) = elapsed_badge(view) { {badge} }
				</row>
				if let Some(detail) = detail { <pre pad-x=2>{detail}</pre> }
				if let Some(fault) = fault { <text pad-x=2 fg=err>{fault}</text> }
			</col>
		}
		.into_component()
	}
}

fn render_media(view: &CardView<'_>, expanded: bool, ui: &UiContext, speech: bool) -> Component {
	let label = if speech {
		"Speech Generation"
	} else {
		"GenerateImage"
	};
	let card = GenericCard.render_named(label, view, expanded, ui);
	let result = typed_result::<MediaPayload>(view);
	let artifact = result
		.as_ref()
		.and_then(|value| value.get("artifact_id"))
		.and_then(Value::as_str)
		.map(Str::new);
	if speech {
		if expanded && let Some(artifact) = artifact {
			let detail = result
				.as_ref()
				.and_then(|value| serde_json::from_value::<MediaPayload>(value.clone()).ok())
				.map(|payload| {
					let mut parts = Vec::new();
					if let Some(backend) = payload.backend {
						parts.push(format!("backend={backend}"));
					}
					if let Some(voice) = payload.voice_id {
						parts.push(format!("voice={voice}"));
					}
					if let Some(codec) = payload.codec {
						parts.push(format!("codec={codec}"));
					}
					if let Some(rate) = payload.sample_rate {
						parts.push(format!("{rate} Hz"));
					}
					if let Some(bytes) = payload.bytes {
						parts.push(format!("{bytes} bytes"));
					}
					Str::new(parts.join(", "))
				});
			return dom! {
				<col>
					{card}
					if let Some(detail) = detail { <text pad-x=1 fg=muted>{detail}</text> }
					<text pad-x=1 fg=muted href={artifact.clone()}>{artifact}</text>
				</col>
			}
			.into_component();
		}
		return card;
	}
	let Some(artifact) = artifact else {
		return card;
	};
	let mime = result
		.as_ref()
		.and_then(|value| value.get("media_type"))
		.and_then(Value::as_str)
		.unwrap_or("image/*");
	let output_path = result
		.as_ref()
		.and_then(|value| value.get("output_path"))
		.and_then(Value::as_str);
	let image = result_image(&artifact, mime, output_path, ui);
	dom! { <col>{card}{image}</col> }.into_component()
}

fn semantic_row(
	icon: &'static str,
	title: &'static str,
	detail: &str,
	receipt: Option<&str>,
	fault: Option<Str>,
	view: &CardView<'_>,
) -> Component {
	dom! {
		<col>
			<row gap=1>
				match view.status {
					CardStatus::Failed => <i:error/>,
					CardStatus::Done => <icon name={icon}/>,
					CardStatus::StreamingArgs | CardStatus::InProgress => <spinner kind=status/>,
				}
				<text bold>{title}</text><text>{Str::new(detail)}</text>
				if let Some(receipt) = receipt { <text fg=muted>{Str::new(receipt)}</text> }
				if let Some(badge) = elapsed_badge(view) { {badge} }
			</row>
			if let Some(fault) = fault { <text pad-x=2 fg=err>{fault}</text> }
		</col>
	}
	.into_component()
}

fn compact_json(value: &Value) -> String {
	match value {
		Value::String(text) => text.clone(),
		other => serde_json::to_string(other).unwrap_or_default(),
	}
}
