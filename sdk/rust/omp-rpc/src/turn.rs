//! The outcome of `Client::prompt_and_wait`.

use crate::{
	client::Error,
	wire::{
		AgentEndEvent, AgentMessage, AssistantContent, AssistantMessage, PromptResultEvent,
		RpcAgentEvent,
	},
};

/// Session events and final messages of one prompt.
#[derive(Debug, Clone, PartialEq)]
pub struct PromptTurn {
	/// Session events from submission up to this prompt's `prompt_result`, in
	/// arrival order.
	pub events:            Vec<RpcAgentEvent>,
	/// Messages of the last `agent_end`, completed from streamed `message_end`s
	/// when compacted.
	pub messages:          Vec<AgentMessage>,
	/// Last assistant message in `messages`, else the last one carried by any
	/// event.
	pub assistant_message: Option<AssistantMessage>,
	/// Visible text of `assistant_message` (thinking excluded).
	pub assistant_text:    Option<String>,
	/// The prompt's `prompt_result`; `None` when the server handled it without
	/// the agent.
	pub result:            Option<PromptResultEvent>,
}

impl PromptTurn {
	pub(crate) fn build(
		events: Vec<RpcAgentEvent>,
		result: Option<PromptResultEvent>,
	) -> Result<Self, Error> {
		let mut messages = Vec::new();
		if let Some(end) = events
			.iter()
			.rposition(|event| matches!(event, RpcAgentEvent::AgentEnd(_)))
		{
			let RpcAgentEvent::AgentEnd(terminal) = &events[end] else {
				unreachable!("matched above")
			};
			messages = complete_agent_end_messages(&events[..end], terminal)?;
		}
		let mut assistant_message = messages.iter().rev().find_map(|message| match message {
			AgentMessage::Assistant(message) => Some(message.clone()),
			_ => None,
		});
		if assistant_message.is_none() {
			assistant_message = events.iter().rev().find_map(|event| match event {
				RpcAgentEvent::MessageStart(event) => assistant(&event.message),
				RpcAgentEvent::MessageUpdate(event) => assistant(&event.message),
				RpcAgentEvent::MessageEnd(event) => assistant(&event.message),
				RpcAgentEvent::TurnEnd(event) => assistant(&event.message),
				_ => None,
			});
		}
		let assistant_text = assistant_message.as_ref().and_then(visible_text);
		Ok(Self { events, messages, assistant_message, assistant_text, result })
	}
}

fn assistant(message: &AgentMessage) -> Option<AssistantMessage> {
	match message {
		AgentMessage::Assistant(message) => Some(message.clone()),
		_ => None,
	}
}

/// Joined text blocks; `None` when there are none.
fn visible_text(message: &AssistantMessage) -> Option<String> {
	let text: String = message
		.content
		.iter()
		.flatten()
		.filter_map(|block| match block {
			AssistantContent::Text(block) => block.text.as_deref(),
			_ => None,
		})
		.collect();
	(!text.is_empty()).then_some(text)
}

/// An oversized `agent_end` drops leading messages already streamed as
/// `message_end` and reports the original count in `messageCount`; restore
/// them.
fn complete_agent_end_messages(
	events: &[RpcAgentEvent],
	terminal: &AgentEndEvent,
) -> Result<Vec<AgentMessage>, Error> {
	let kept = terminal.messages.len();
	let Some(count) = terminal
		.message_count
		.and_then(|count| usize::try_from(count).ok())
		.filter(|&count| count > kept)
	else {
		return Ok(terminal.messages.clone());
	};
	let run_start = events
		.iter()
		.rposition(|event| matches!(event, RpcAgentEvent::AgentStart(_)))
		.map_or(0, |index| index + 1);
	let streamed: Vec<&AgentMessage> = events[run_start..]
		.iter()
		.filter_map(|event| match event {
			RpcAgentEvent::MessageEnd(event) => Some(&event.message),
			_ => None,
		})
		.collect();
	let prefix = count - kept;
	if prefix > streamed.len() {
		return Err(Error::Protocol(format!(
			"Compacted agent_end references {prefix} streamed messages, but only {} were retained",
			streamed.len()
		)));
	}
	Ok(streamed[..prefix]
		.iter()
		.map(|&message| message.clone())
		.chain(terminal.messages.iter().cloned())
		.collect())
}
