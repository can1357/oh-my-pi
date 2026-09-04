//! GitHub Copilot per-request dynamics: initiator headers and premium-request
//! accounting.
//!
//! Copilot bills a user-initiated request at the model's premium multiplier
//! and an agent-initiated continuation (a tool round) at zero; the same
//! initiator classification is sent on the wire as `X-Initiator` /
//! `X-Interaction-Type`, so the billed amount and the declared amount never
//! disagree.

use omp_catalog::{PremiumMultiplier, ProviderId};
use strum::{EnumString, IntoStaticStr};

use crate::{
	call::{ChatRequest, ContentPart, Message, Role},
	codec::RequestHeader,
	receipt::Usage,
};

/// Provider whose requests carry Copilot dynamics.
pub const PROVIDER: &str = "github-copilot";
const INITIATOR_HEADER: &str = "X-Initiator";
const INTERACTION_HEADER: &str = "X-Interaction-Type";
const VISION_HEADER: &str = "Copilot-Vision-Request";

/// Who initiated the request from Copilot's billing point of view.
#[derive(Clone, Copy, Debug, Eq, PartialEq, EnumString, IntoStaticStr)]
#[strum(serialize_all = "lowercase", ascii_case_insensitive)]
pub enum CopilotInitiator {
	/// A fresh user turn: billed at the premium multiplier.
	User,
	/// A continuation after tool results: free.
	Agent,
}

/// Whether `provider` is billed and tagged the Copilot way.
pub fn is_copilot(provider: &ProviderId<str>) -> bool {
	provider.as_str() == PROVIDER
}

/// The last message decides. A user message that
/// ends in a tool result, or any non-user message, is the agent continuing.
pub fn infer_initiator(messages: &[Message]) -> CopilotInitiator {
	let Some(last) = messages.last() else {
		return CopilotInitiator::User;
	};
	if last.role != Role::User {
		return CopilotInitiator::Agent;
	}
	match last.content.last() {
		Some(ContentPart::ToolResult { .. }) => CopilotInitiator::Agent,
		_ => CopilotInitiator::User,
	}
}

/// Whether any user or tool-result message contains an image.
pub fn has_vision_input(messages: &[Message]) -> bool {
	messages.iter().any(|message| {
		matches!(message.role, Role::User | Role::Tool)
			&& message.content.iter().any(|part| {
				matches!(part, ContentPart::Image(_))
					|| matches!(
						part,
						ContentPart::ToolResult { content, .. }
							if content.iter().any(|item| matches!(item, crate::call::ToolResultContent::Image(_)))
					)
			})
	})
}

/// A configured `X-Initiator` wins over inference; the last valid value is
/// used.
pub fn initiator_override(headers: &[RequestHeader]) -> Option<CopilotInitiator> {
	headers
		.iter()
		.filter(|header| header.name.eq_ignore_ascii_case(INITIATOR_HEADER))
		.filter_map(|header| header.value.trim().parse().ok())
		.next_back()
}

/// An undeclared multiplier is `1`, and a free plan bills a `0×` model as one
/// request.
pub const fn premium_multiplier(declared: Option<PremiumMultiplier>) -> PremiumMultiplier {
	match declared {
		Some(multiplier) if multiplier.as_millionths() != 0 => multiplier,
		Some(_) | None => PremiumMultiplier::ONE,
	}
}

/// Premium requests in `Usage::PREMIUM_REQUEST_SCALE` units.
pub const fn premium_requests_millionths(
	initiator: CopilotInitiator,
	declared: Option<PremiumMultiplier>,
) -> u64 {
	match initiator {
		CopilotInitiator::Agent => 0,
		CopilotInitiator::User => premium_multiplier(declared).as_millionths(),
	}
}

/// Per-request Copilot facts: the headers to merge and the premium charge.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CopilotDynamics {
	/// `X-Initiator`, `X-Interaction-Type`, and `Copilot-Vision-Request` when
	/// images are present.
	pub headers:                     Vec<RequestHeader>,
	/// Premium requests billed to this attempt.
	pub premium_requests_millionths: u64,
}

/// Builds the per-request Copilot headers and premium charge.
pub fn dynamics(
	request: &ChatRequest,
	configured: &[RequestHeader],
	declared: Option<PremiumMultiplier>,
) -> CopilotDynamics {
	let initiator =
		initiator_override(configured).unwrap_or_else(|| infer_initiator(&request.messages));
	let tag: &'static str = initiator.into();
	let mut headers = Vec::with_capacity(3);
	headers.push(RequestHeader::new(INITIATOR_HEADER, tag));
	headers.push(RequestHeader::new(INTERACTION_HEADER, format!("conversation-{tag}")));
	if has_vision_input(&request.messages) {
		headers.push(RequestHeader::new(VISION_HEADER, "true"));
	}
	CopilotDynamics {
		headers,
		premium_requests_millionths: premium_requests_millionths(initiator, declared),
	}
}

const _: () = assert!(Usage::PREMIUM_REQUEST_SCALE == PremiumMultiplier::SCALE);

#[cfg(test)]
mod tests {
	use std::sync::Arc;

	use omp_core::{Str, sf};

	use super::*;
	use crate::{
		call::{NegotiationPolicy, Sampling, Setting, ToolChoice, ToolResultContent},
		id::ToolCallId,
	};

	fn text(role: Role, body: &str) -> Message {
		Message {
			role,
			content: Arc::from([ContentPart::Text { text: Str::new(body), proof: None }]),
			name: None,
		}
	}

	fn tool_result() -> ContentPart {
		ContentPart::ToolResult {
			call:     ToolCallId::new("call_1"),
			name:     None,
			content:  vec![ToolResultContent::Text(sf!("ok"))].into(),
			is_error: false,
		}
	}

	fn chat(messages: Vec<Message>) -> ChatRequest {
		ChatRequest {
			messages:          messages.into(),
			tools:             Arc::from([]),
			hosted_tools:      Arc::from([]),
			tool_choice:       Setting::Prefer(ToolChoice::Auto),
			output:            Setting::Unset,
			reasoning:         Setting::Unset,
			verbosity:         Setting::Unset,
			cache_retention:   Setting::Unset,
			service_tier:      Setting::Unset,
			sampling:          Sampling::default(),
			max_output_tokens: None,
			top_logprobs:      None,
			safety:            Arc::from([]),
			negotiation:       NegotiationPolicy::default(),
			forced_call:       None,
		}
	}

	#[test]
	fn initiator_follows_the_last_message_like_pi() {
		assert_eq!(infer_initiator(&[]), CopilotInitiator::User);
		assert_eq!(
			infer_initiator(&[text(Role::System, "sys"), text(Role::User, "hi")]),
			CopilotInitiator::User
		);
		assert_eq!(
			infer_initiator(&[text(Role::User, "hi"), text(Role::Assistant, "calling")]),
			CopilotInitiator::Agent
		);
		assert_eq!(
			infer_initiator(&[text(Role::User, "hi"), Message {
				role:    Role::Tool,
				content: Arc::from([tool_result()]),
				name:    None,
			}]),
			CopilotInitiator::Agent
		);
		assert_eq!(
			infer_initiator(&[Message {
				role:    Role::User,
				content: Arc::from([tool_result()]),
				name:    None,
			}]),
			CopilotInitiator::Agent
		);
		assert_eq!(
			infer_initiator(&[Message {
				role:    Role::User,
				content: Arc::from([tool_result(), ContentPart::Text {
					text:  sf!("and now?"),
					proof: None,
				}]),
				name:    None,
			}]),
			CopilotInitiator::User
		);
	}

	#[test]
	fn premium_requests_apply_the_multiplier_only_to_user_turns() {
		let third = Some(PremiumMultiplier::from_millionths(330_000));
		assert_eq!(premium_requests_millionths(CopilotInitiator::User, third), 330_000);
		assert_eq!(premium_requests_millionths(CopilotInitiator::Agent, third), 0);
		assert_eq!(premium_requests_millionths(CopilotInitiator::User, None), 1_000_000);
		// Free plan: a 0× model still burns one request.
		assert_eq!(
			premium_requests_millionths(
				CopilotInitiator::User,
				Some(PremiumMultiplier::from_millionths(0))
			),
			1_000_000
		);
		assert_eq!(
			premium_requests_millionths(
				CopilotInitiator::User,
				Some(PremiumMultiplier::from_millionths(3_000_000))
			),
			3_000_000
		);
	}

	#[test]
	fn dynamics_tag_the_wire_and_honor_a_configured_initiator() {
		let user_turn = dynamics(
			&chat(vec![text(Role::User, "hi")]),
			&[],
			Some(PremiumMultiplier::from_millionths(330_000)),
		);
		assert_eq!(user_turn.headers, vec![
			RequestHeader::new("X-Initiator", "user"),
			RequestHeader::new("X-Interaction-Type", "conversation-user"),
		]);
		assert_eq!(user_turn.premium_requests_millionths, 330_000);

		let configured = [RequestHeader::new("x-initiator", "Agent")];
		let overridden = dynamics(&chat(vec![text(Role::User, "hi")]), &configured, None);
		assert_eq!(overridden.headers[0], RequestHeader::new("X-Initiator", "agent"));
		assert_eq!(
			overridden.headers[1],
			RequestHeader::new("X-Interaction-Type", "conversation-agent")
		);
		assert_eq!(overridden.premium_requests_millionths, 0);

		let bogus = [RequestHeader::new("X-Initiator", "robot")];
		assert_eq!(initiator_override(&bogus), None);
	}
}
