//! Gateway-backed inference adapter for the journal-first agent kernel.

use std::{collections::BTreeMap, time::SystemTime};

use bytes::Bytes;
use futures::StreamExt as _;
use omp_ai::{
	ChatRequest, ChatStream,
	answer::ResponseMeta,
	call::{
		ContentPart, MediaInput, Role, Setting, ToolChoice, ToolInputConstraint, ToolResultContent,
	},
	error::{Error, ErrorDetail, ErrorKind, ErrorPhase, RetryAction},
	event::{BlockKind, ChatEvent, Completion, FinishReason, ToolCall},
	id::{RequestId, ToolCallId},
	receipt::{Cost, ExecutionReceipt, ReasonId, Usage, UsageSource},
};
use omp_core::{Str, Ulid, sf};
use omp_proto::{
	inference::v1::{
		self as pb, inference_client::InferenceClient, part_start, tool_choice, turn_event,
		turn_frame, turn_request,
	},
	thread::v1::{self as thread, item, part},
};
use tonic::transport::Channel;

/// Raw inference client carried by the application's `--gateway` connection.
#[derive(Clone, Debug)]
pub struct GatewayInference {
	channel: Channel,
	model:   Str,
}

impl GatewayInference {
	/// Creates a gateway inference adapter for one selected model.
	#[must_use]
	pub fn new(channel: Channel, model: impl Into<Str>) -> Self {
		Self { channel, model: model.into() }
	}
}

impl omp_agent::Inference for GatewayInference {
	fn chat(
		&mut self,
		request: ChatRequest,
	) -> impl Future<Output = Result<ChatStream, Error>> + Send {
		let mut client = InferenceClient::new(self.channel.clone());
		let model = self.model.clone();
		async move {
			let open = request_frame(&request, model.as_str())?;
			let request = futures::stream::once(async move { open });
			let response = client
				.turn(request)
				.await
				.map_err(|_| protocol("gateway_turn_open_failed"))?;
			let mut incoming = response.into_inner();
			let stream_model = model.clone();
			let events = async_stream::stream! {
				let (provider, selected_model) = split_model(stream_model.as_str());
				yield Ok(ChatEvent::Started(ResponseMeta {
					request_id: RequestId::from(format!("gateway-{}", Ulid::generate())),
					provider: provider.into(),
					route: format!("gateway/{provider}").into(),
					model: Some(selected_model.into()),
					provider_request_id: None,
					created_at: SystemTime::now(),
				}));
				let mut parts = BTreeMap::<u32, PendingPart>::new();
				while let Some(message) = incoming.next().await {
					let message = match message {
						Ok(message) => message,
						Err(_) => { yield Err(protocol("gateway_turn_stream_failed")); break; },
					};
					let Some(event) = message.event else { continue };
					match event {
						turn_event::Event::Accepted(_) | turn_event::Event::Attempt(_) => {},
						turn_event::Event::PartStart(start) => {
							let kind = part_start::Kind::try_from(start.kind)
								.unwrap_or(part_start::Kind::Unspecified);
							match kind {
								part_start::Kind::Text => {
									parts.insert(start.index, PendingPart::Text);
									yield Ok(ChatEvent::BlockStarted { index: start.index, kind: BlockKind::Text });
								},
								part_start::Kind::Thinking => {
									parts.insert(start.index, PendingPart::Thinking);
									yield Ok(ChatEvent::BlockStarted { index: start.index, kind: BlockKind::Thinking });
								},
								part_start::Kind::ToolCall => {
									let id = ToolCallId::from(start.tool_call_id.as_str());
									let name = Str::new(start.tool_name);
									parts.insert(start.index, PendingPart::Tool { id: id.clone(), name: name.clone(), arguments: Vec::new() });
									yield Ok(ChatEvent::ToolCallStarted { index: start.index, id, name });
								},
								part_start::Kind::Unspecified => { yield Err(protocol("gateway_part_kind_invalid")); break; },
							}
						},
						turn_event::Event::PartDelta(delta) => match parts.get_mut(&delta.index) {
							Some(PendingPart::Text) => match std::str::from_utf8(&delta.chunk) {
								Ok(text) => yield Ok(ChatEvent::TextDelta { index: delta.index, text: Str::new(text) }),
								Err(_) => { yield Err(protocol("gateway_text_utf8_invalid")); break; },
							},
							Some(PendingPart::Thinking) => match std::str::from_utf8(&delta.chunk) {
								Ok(text) => yield Ok(ChatEvent::ThinkingDelta { index: delta.index, text: Str::new(text) }),
								Err(_) => { yield Err(protocol("gateway_thinking_utf8_invalid")); break; },
							},
							Some(PendingPart::Tool { arguments, .. }) => {
								arguments.extend_from_slice(&delta.chunk);
								yield Ok(ChatEvent::ToolArgumentsDelta { index: delta.index, bytes: delta.chunk });
							},
							None => { yield Err(protocol("gateway_part_delta_without_start")); break; },
						},
						turn_event::Event::PartEnd(end) => {
							if let Some(PendingPart::Tool { id, name, arguments }) = parts.remove(&end.index) {
								match serde_json::from_slice(&arguments) {
									Ok(arguments) => yield Ok(ChatEvent::ToolCallReady {
										index: end.index,
										call: ToolCall { id, name, arguments: omp_ai::OpaqueJson::new(arguments) },
									}),
									Err(_) => { yield Err(protocol("gateway_tool_arguments_invalid")); break; },
								}
							} else {
								parts.remove(&end.index);
							}
						},
						turn_event::Event::Outcome(outcome) => {
							let usage = usage(outcome.usage.as_ref());
							let cost = outcome.cost.as_ref().map_or(Cost::default(), |cost| Cost::from_micro_usd(i128::from(cost.nanos_usd / 1_000)));
							yield Ok(ChatEvent::Completed(Completion {
								reason: finish_reason(outcome.stop),
								blocks: u32::try_from(outcome.output.len()).unwrap_or(u32::MAX),
								usage,
								receipt: ExecutionReceipt { usage, cost, ..ExecutionReceipt::default() }.into(),
							}));
							break;
						},
						turn_event::Event::Error(_) => { yield Err(protocol("gateway_turn_error")); break; },
						turn_event::Event::Invoke(_) | turn_event::Event::InvokeCancel(_) => {
							yield Err(protocol("gateway_live_invocation_unsupported")); break;
						},
					}
				}
			};
			Ok(ChatStream::ordinary(Box::pin(events)))
		}
	}
}

#[derive(Debug)]
enum PendingPart {
	Text,
	Thinking,
	Tool { id: ToolCallId, name: Str, arguments: Vec<u8> },
}

fn request_frame(request: &ChatRequest, model: &str) -> Result<pb::TurnFrame, Error> {
	let thread = thread::Thread { items: request.messages.iter().flat_map(message_items).collect() };
	let tools = request
		.tools
		.iter()
		.map(|tool| {
			let input = match &tool.input {
				ToolInputConstraint::JsonSchema { parameters, strict } => {
					pb::tool_def::Input::JsonSchema(pb::tool_def::JsonSchema {
						schema_json: Bytes::copy_from_slice(parameters.as_value().to_string().as_bytes()),
						strict:      Some(*strict),
					})
				},
				ToolInputConstraint::Grammar { grammar, fallback } => {
					pb::tool_def::Input::Grammar(pb::tool_def::Grammar {
						syntax:               match grammar.syntax {
							omp_ai::call::ToolGrammarSyntax::Lark => {
								pb::tool_def::grammar::Syntax::Lark as i32
							},
							omp_ai::call::ToolGrammarSyntax::Regex => {
								pb::tool_def::grammar::Syntax::Regex as i32
							},
							omp_ai::call::ToolGrammarSyntax::Ebnf => {
								pb::tool_def::grammar::Syntax::Ebnf as i32
							},
						},
						definition:           grammar.definition.to_string(),
						fallback_schema_json: Bytes::copy_from_slice(
							fallback.as_value().to_string().as_bytes(),
						),
					})
				},
			};
			pb::ToolDef {
				name:        tool.name.to_string(),
				description: tool
					.description
					.as_ref()
					.map_or_else(String::new, ToString::to_string),
				input:       Some(input),
			}
		})
		.collect();
	let tool_choice = match &request.tool_choice {
		Setting::Unset => None,
		Setting::Require(choice) | Setting::Prefer(choice) => Some(pb::ToolChoice {
			mode:           match choice {
				ToolChoice::Disabled => tool_choice::Mode::None as i32,
				ToolChoice::Auto => tool_choice::Mode::Auto as i32,
				ToolChoice::Required => tool_choice::Mode::Required as i32,
				ToolChoice::Named(_) => tool_choice::Mode::Named as i32,
			},
			name:           match choice {
				ToolChoice::Named(name) => name.to_string(),
				_ => String::new(),
			},
			on_unsupported: 0,
		}),
	};
	Ok(pb::TurnFrame {
		frame: Some(turn_frame::Frame::Open(pb::TurnRequest {
			turn_id:  Ulid::generate().to_string(),
			input:    Some(turn_request::Input::Seed(pb::Seed {
				context_id: String::new(),
				thread:     Some(thread),
			})),
			params:   Some(pb::ChatParams {
				model: model.to_owned(),
				tools,
				tool_choice,
				sampling: Some(pb::Sampling {
					temperature: request.sampling.temperature.map(f64::from),
					top_p: request.sampling.top_p.map(f64::from),
					top_k: request.sampling.top_k,
					frequency_penalty: request.sampling.frequency_penalty.map(f64::from),
					presence_penalty: request.sampling.presence_penalty.map(f64::from),
					stop: request
						.sampling
						.stop
						.iter()
						.map(ToString::to_string)
						.collect(),
					max_output_tokens: request.max_output_tokens,
					..Default::default()
				}),
				..Default::default()
			}),
			executor: None,
			props:    None,
		})),
	})
}

fn message_items(message: &omp_ai::Message) -> Vec<thread::Item> {
	let role = match message.role {
		Role::System | Role::Developer => thread::Role::System,
		Role::User => thread::Role::User,
		Role::Assistant | Role::Tool => thread::Role::Assistant,
	};
	let mut items = Vec::new();
	let mut parts = Vec::new();
	for content in message.content.iter() {
		match content {
			ContentPart::Text { text, .. } => {
				parts.push(thread::Part { kind: Some(part::Kind::Text(text.to_string())) })
			},
			ContentPart::Reasoning { text, .. } => parts.push(thread::Part {
				kind: Some(part::Kind::Thinking(thread::Thinking {
					text: text.to_string(),
					..Default::default()
				})),
			}),
			ContentPart::ToolCall { call, name, arguments, .. } => items.push(thread::Item {
				kind: Some(item::Kind::ToolCall(thread::ToolCall {
					id: call.to_string(),
					name: name.to_string(),
					args_json: Bytes::copy_from_slice(arguments.as_value().to_string().as_bytes()),
					..Default::default()
				})),
				..Default::default()
			}),
			ContentPart::ToolResult { call, name, content, is_error } => items.push(thread::Item {
				kind: Some(item::Kind::ToolResult(thread::ToolResult {
					call_id: call.to_string(),
					name: name.as_ref().map_or_else(String::new, ToString::to_string),
					parts: content.iter().filter_map(result_part).collect(),
					is_error: *is_error,
					..Default::default()
				})),
				..Default::default()
			}),
			ContentPart::Image(media) | ContentPart::Document(media) | ContentPart::Audio(media) => {
				if let Some(blob) = media_part(media) {
					parts.push(blob);
				}
			},
			ContentPart::CachePoint(_) => {},
		}
	}
	if !parts.is_empty() {
		items.insert(0, thread::Item {
			kind: Some(item::Kind::Message(thread::Message {
				role: role as i32,
				parts,
				..Default::default()
			})),
			..Default::default()
		});
	}
	items
}

fn result_part(content: &ToolResultContent) -> Option<thread::Part> {
	match content {
		ToolResultContent::Text(text) => {
			Some(thread::Part { kind: Some(part::Kind::Text(text.to_string())) })
		},
		ToolResultContent::Json(json) => {
			Some(thread::Part { kind: Some(part::Kind::Text(json.as_value().to_string())) })
		},
		ToolResultContent::Image(media) | ToolResultContent::Document(media) => media_part(media),
	}
}

fn media_part(media: &MediaInput) -> Option<thread::Part> {
	let blob = match media {
		MediaInput::Bytes { media_type, data } => thread::Blob {
			mime: media_type.to_string(),
			size: data.len() as u64,
			inline: data.clone(),
			..Default::default()
		},
		_ => return None,
	};
	Some(thread::Part { kind: Some(part::Kind::Blob(blob)) })
}

fn usage(value: Option<&pb::Usage>) -> Usage {
	value.map_or_else(Usage::default, |value| Usage {
		input_tokens: value.input_tokens,
		output_tokens: value.output_tokens,
		cache_read_tokens: value.cache_read_tokens,
		cache_write_tokens: value.cache_write_tokens,
		reasoning_tokens: value.reasoning_tokens.unwrap_or(0),
		source: UsageSource::Provider,
		..Usage::default()
	})
}

fn finish_reason(value: i32) -> FinishReason {
	match pb::StopReason::try_from(value).unwrap_or(pb::StopReason::StopUnspecified) {
		pb::StopReason::StopEndTurn | pb::StopReason::StopUnspecified => FinishReason::Stop,
		pb::StopReason::StopToolUse => FinishReason::ToolCalls,
		pb::StopReason::StopMaxTokens => FinishReason::Length,
		pb::StopReason::StopContentFilter => FinishReason::ContentFilter,
	}
}

fn split_model(model: &str) -> (&str, &str) {
	model.split_once('/').unwrap_or(("gateway", model))
}

fn protocol(reason: &'static str) -> Error {
	Error::new(
		ErrorKind::Protocol,
		ErrorPhase::Streaming,
		RetryAction::Never,
		ExecutionReceipt::default(),
	)
	.detail(ErrorDetail::protocol(ReasonId(sf!(reason))))
}
