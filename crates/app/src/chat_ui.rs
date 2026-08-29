pub mod commands;
pub mod input;
pub mod presentation;
pub mod template;

use std::{
	collections::{BTreeMap, HashMap, HashSet, VecDeque},
	env, fs,
	future::pending,
	iter, mem,
	path::{Path, PathBuf},
	str,
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
	time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use bytes::Bytes;
use futures::StreamExt as _;
use miette::{Context as _, IntoDiagnostic as _};
use omp_agent::{
	Agent, AgentEvent, AgentPhase, AgentRunState, AgentState, AgentStatus, AgentTree,
	ApprovalDecision, ApprovalInbox, ApprovalRequest, ApprovalSource, DeferredCommand,
	DeferredCommandKind, DeferredCommands, DeferredContext, DeliveryMode, Interrupt, InterruptClass,
	InterruptSource, PeerMessage, RewindTarget, TurnClient,
	prompt_assets::{PromptAssetId, prompt_asset},
};
use omp_catalog::{
	ModelKey, ModelSpec, PriceUnit, ProviderDef, ProviderId,
	provider::{AuthSpecKind, CredentialSourceSpec},
	role_assignment_selector,
	settings::{ModelRoleStorage, ModelSettings},
	snapshot::Catalog,
};
use omp_chat_ui::{
	ActivityWaveform, AgentRow, ApprovalAction, ApprovalTicketView, Attachment, BackendEvent, Chat,
	HubRole, HubScope, Intent, ListRow, LiveVoiceAction, LockedProviderRow, ModelHubData,
	ModelHubIntent, ModelRow, RawFrame, RestoredAttachment, RewindTargetRow, SessionRow,
	StatusFacts, StatusLayout, StatusSeparator, StreamSummary, SubmitMode,
	ThinkingLevel as StatusThinkingLevel, ToolTerminal, ToolViewContent, TranscriptFrame,
	TranscriptFrameKind, VisibleResourceFacts,
	completion::{CompletionQuery, CompletionRule, CompletionSource, CompletionTrigger},
	host::{HostOptions, InputAction, InputBinding},
	login_panel::LoginEvent,
};
use omp_core::{FastHashSet, Hash32, SecretString, Str, encoding::hex, sf};
pub use omp_driver::auth_flow::{
	AuthPromptKind, CREDENTIAL_STORAGE_LOCKED_MESSAGE, ChatAuth, ChatAuthCommand, ChatAuthEvent,
	prompt_masks_input,
};
use omp_driver::{
	advisor::engine::{AdvisorEngine, AdvisorEngineStatus, AdvisorRunState},
	discovery::roles::{model_selector_allowed, resolve_role_selector},
	modes::{Goal, GoalStatus, GoalUsage, RegimeHandle},
	settings::{self, Settings},
	subagent::settings::TaskSettings,
};
use omp_envd::exthost::lifecycle::HeadlessLifecycleKind;
use omp_inference::{call::AuthInput, id::TurnId};
use omp_observability::firehose::{
	Event as FirehoseEvent, Kind as FirehoseKind, SubscriptionHandle, SubscriptionOptions,
};
use omp_proto::{
	env::v1::{
		CloseSessionRequest, EnvironmentDelta, ExecControlKind, ExecOutcome, ExecRequest,
		McpConfigAction, McpConfigRequest, McpConfigScope, McpLifecycleState, McpResetRequest,
		McpServerRef, McpStatusRequest, McpSubscribeRequest, OpenSessionRequest, OutputChannel,
		Script,
	},
	inference::v1::{part_start, turn_event::Event, value},
	omp::ui::v1::{
		Bell, CloseOverlay, ComposerEdit, ComposerText, Dialog, FocusSlot, MountSlot, Notify,
		OpenUrl, OverlayValues, PatchNode, PropValue, RetainedFrame, RetainedFrameEnvelope,
		RetainedFrameKey, ShowOverlay, SlotOptions, SlotPlacement, Tml, UiEffect, UiRequest,
		UiResponse, UnmountSlot, prop_value, retained_frame_envelope, ui_effect, ui_request,
		ui_response,
	},
	thread::v1::{Blob, Item, Message, Part, Role, blob, item, part},
};
use omp_storage::{
	index::{NewSession, SessionIndex, SessionKind},
	transcript::{self, SessionId},
};
use omp_tool::{
	Registry, Rev, TOOL_REV_PROP, ToolIdentity,
	render::{RenderRegistry, ViewState},
};
use omp_tools::todo;
use omp_tui::{
	Command, Icon, Notification, NotificationSound, Suggestion, SuggestionList, UiContext, Urgency,
	components::{AttachmentContent, KeywordAccent},
	detect,
};
pub(crate) fn terminal_ui_context(caps: &omp_tui::TerminalCaps) -> UiContext {
	UiContext::default().with_terminal_caps(caps)
}
use parking_lot::Mutex;
use serde_json::Value;

use crate::chat_ui::{
	commands::{
		AdvisorRequest, BranchRequest, CommandFuture, CommandResult, CommandRole, CommandSurface,
		ConfigCommandHost, ConfigScope, ConsumedResult, DispatchResult, FlowCommandHost, McpRequest,
		ModelCommandHost, ParsedFlags, SessionCommandHost, SessionRequest, ShellCommandHost,
		WorkspaceRequest,
	},
	input::{ChatCommand, CommandContribution, CommandRoster, CommandUsage, ParsedTurnBudget},
};

const GATEWAY_LOGIN_MESSAGE: &str = "Provider login is unavailable through a remote gateway; run \
                                     `omp auth login <provider>` on the gateway host.";
const MAX_ATTACHMENT_BYTES: usize = 8 * 1024 * 1024;

#[cfg(feature = "gui")]
use omp_chat_ui::host::RetainedChat;
use omp_chat_ui::status_line::TokenRateMeter;
use omp_collab::{
	guest::{GuestInputDisposition, GuestInputError, GuestSessionRestore},
	presence::CollabRole,
};
pub use omp_driver::chat::ResumeChoice;
use omp_driver::{
	chat::ChatParentHost,
	collab::session::{CollabCommandHandle, CollabOwnerCommand, RemoteImage},
	export::{HtmlThemePalette, SessionTree},
	plan::PlanArtifactStore,
	secrets::session::SecretSessionSnapshot,
	session_title::{SessionTitleState, generate_online_title},
	settings::ShareStore,
	share::{DirectShareStore, ShareProjection, ShareStoreKind},
	skills::SkillInvocationKind,
};
use omp_envd::github_url::GithubCredentialBridge;
use omp_proto::{
	inference::{v1, v1::Effort},
	value_json::{value_map_to_json, value_to_json},
};
use omp_settings::{
	BrowserSettings,
	manager::{MutationScope, SettingsManager},
	subscription::DomainSubscription,
};
use omp_tools::debug;
use omp_tui::components;
use tokio::sync::watch::Receiver;
use tokio_util::sync::CancellationToken;

#[cfg(feature = "gui")]
use crate::gui;
use crate::{
	chat_cmd::ChatPresentation, git_tui::GitSession, session_manager::PinStore,
	theme_watcher::ThemeWatcher,
};

pub mod presentation_authority {
	use std::{
		collections::{BTreeMap, BTreeSet, VecDeque},
		sync::Arc,
		time::Duration,
	};

	use async_trait::async_trait;
	use omp_core::{InvocationPhase, Str};
	use omp_envd::{
		exthost,
		exthost::{
			UiControlResult,
			control::{self, ControlInvocationAuthority, ControlProtocolError},
		},
	};
	use parking_lot::Mutex;
	use serde::{Deserialize, Serialize};
	use serde_json::Value;
	use thiserror::Error;

	/// Maximum completion callback latency.
	pub const COMPLETION_CALLBACK_DEADLINE: Duration = Duration::from_millis(250);
	/// Maximum renderer callback latency.
	pub const RENDER_CALLBACK_DEADLINE: Duration = Duration::from_millis(50);
	const COMPLETED_REQUEST_RETENTION: usize = 1_024;

	/// Authenticated extension incarnation bound to one UI owner.
	#[derive(Clone, Debug, Eq, PartialEq)]
	pub struct PresentationIdentity {
		pub principal:          Str,
		pub extension:          Str,
		pub artifact_digest:    Str,
		pub host_generation:    u64,
		pub session_generation: u64,
		pub capabilities:       Arc<BTreeSet<Str>>,
	}

	/// Core-authored authority accompanying one UI operation.
	#[derive(Clone, Copy, Debug)]
	pub struct PresentationCallContext<'a> {
		pub identity:   &'a PresentationIdentity,
		pub phase:      Option<InvocationPhase>,
		pub cancelled:  bool,
		pub request_id: u64,
		pub invocation: Option<&'a ControlInvocationAuthority>,
	}

	/// Data-only presentation effect. Terminal handles cannot cross this seam.
	#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
	pub struct PresentationEffect {
		pub kind: Str,
		pub body: serde_json::Map<String, Value>,
	}

	/// Typed request to the attached presentation surface.
	#[derive(Clone, Debug, PartialEq)]
	pub enum PresentationRequest {
		Presentation,
		Commands,
		Icons { prefix: Str },
		EditorText,
		Themes,
		SetAppearance { theme: Str, persist: bool },
		ToolsExpanded,
		SetToolsExpanded { expanded: bool },
		SetHiddenThinkingLabel { label: Option<Str> },
		Dialog { kind: Str, fields: serde_json::Map<String, Value> },
		Overlay { fields: serde_json::Map<String, Value> },
		OverlayValues { id: Str },
		OverlayWait { id: Str },
		OverlayEvents { id: Str },
		OverlayClose { id: Str },
		DynamicMount { generation: u64 },
	}

	/// Typed response from a real presentation surface.
	#[derive(Clone, Debug, PartialEq, Serialize)]
	pub enum PresentationResponse {
		Presentation(Value),
		Icons(Vec<Str>),
		EditorText(Str),
		Themes(Vec<Str>),
		ToolsExpanded(bool),
		Dialog(Value),
		OverlayOpened { id: Str },
		OverlayValues(serde_json::Map<String, Value>),
		OverlayEvents(Vec<Value>),
		Ack,
	}

	/// Exact failure from the UI authority.
	#[derive(Clone, Debug, Error, Eq, PartialEq)]
	pub enum PresentationAuthorityError {
		#[error("presentation request belongs to a stale or foreign connection")]
		Identity,
		#[error("presentation request was cancelled")]
		Cancelled,
		#[error("presentation operation is not legal in the current phase")]
		Phase,
		#[error("UI mutation is restricted to a user-initiated interactive command")]
		MutationOrigin,
		#[error("presentation capability `{0}` is not granted")]
		Capability(Str),
		#[error("no presentation client is attached")]
		Unavailable,
		#[error("overlay `{0}` is not open")]
		OverlayNotOpen(Str),
		#[error("presentation request `{0}` is already in flight")]
		DuplicateRequest(u64),
		#[error("presentation callback timed out")]
		CallbackTimeout,
		#[error("presentation owner failed: {0}")]
		Owner(Str),
	}

	/// Structured boundary implemented by a TUI or RPC client. It owns focus,
	/// dialogs, retained trees, and terminal access.
	#[async_trait]
	pub trait PresentationClient: Send + Sync + 'static {
		async fn effect(
			&self,
			identity: Arc<PresentationIdentity>,
			effect: PresentationEffect,
		) -> Result<(), PresentationAuthorityError>;

		async fn request(
			&self,
			identity: Arc<PresentationIdentity>,
			request: PresentationRequest,
		) -> Result<PresentationResponse, PresentationAuthorityError>;
	}

	/// Callback class selecting host deadline behavior.
	#[derive(Clone, Copy, Debug, Eq, PartialEq)]
	pub enum PresentationCallbackKind {
		Completion,
		Renderer,
		Action,
	}

	/// Exact-generation extension callback.
	#[derive(Clone, Debug)]
	pub struct PresentationCallback {
		pub kind:      PresentationCallbackKind,
		pub operation: Str,
		pub arguments: Value,
	}

	/// Core-to-extension callback transport.
	#[async_trait]
	pub trait PresentationCallbackDispatcher: Send + Sync + 'static {
		async fn dispatch(
			&self,
			identity: Arc<PresentationIdentity>,
			invocation: ControlInvocationAuthority,
			callback: PresentationCallback,
		) -> Result<Value, PresentationAuthorityError>;
	}

	#[derive(Default)]
	struct State {
		retained:        BTreeMap<(Str, Str), Vec<PresentationEffect>>,
		overlays:        BTreeSet<Str>,
		inflight:        BTreeSet<u64>,
		completed:       BTreeMap<u64, (PresentationRequest, PresentationResponse)>,
		completed_order: VecDeque<u64>,
	}
	struct InflightGuard<'a> {
		state: &'a Mutex<State>,
		id:    u64,
	}

	impl Drop for InflightGuard<'_> {
		fn drop(&mut self) {
			self.state.lock().inflight.remove(&self.id);
		}
	}

	/// Identity-fenced UI owner retaining effects and dialog correlations.
	pub struct PresentationAuthority {
		identity:  Arc<PresentationIdentity>,
		client:    Arc<dyn PresentationClient>,
		callbacks: Arc<dyn PresentationCallbackDispatcher>,
		state:     Mutex<State>,
	}

	impl PresentationAuthority {
		pub fn new(
			identity: Arc<PresentationIdentity>,
			client: Arc<dyn PresentationClient>,
			callbacks: Arc<dyn PresentationCallbackDispatcher>,
		) -> Self {
			Self { identity, client, callbacks, state: Mutex::new(State::default()) }
		}

		fn authorize(
			&self,
			context: PresentationCallContext<'_>,
			minimum: InvocationPhase,
			capability: Option<&str>,
		) -> Result<(), PresentationAuthorityError> {
			if context.identity != self.identity.as_ref() {
				return Err(PresentationAuthorityError::Identity);
			}
			if context.cancelled || context.phase.is_some_and(InvocationPhase::is_terminal) {
				return Err(PresentationAuthorityError::Cancelled);
			}
			if context
				.phase
				.is_some_and(|phase| !phase.allows_operation(minimum))
			{
				return Err(PresentationAuthorityError::Phase);
			}
			if let Some(capability) = capability
				&& !self
					.identity
					.capabilities
					.iter()
					.any(|granted| granted.as_str() == capability)
			{
				return Err(PresentationAuthorityError::Capability(Str::new(capability)));
			}
			Ok(())
		}

		/// Applies and then retains a successful data-only effect.
		pub async fn effect(
			&self,
			context: PresentationCallContext<'_>,
			effect: PresentationEffect,
		) -> Result<(), PresentationAuthorityError> {
			let (minimum, capability) = effect_policy(&effect);
			self.authorize(context, minimum, capability)?;
			if matches!(
				effect.kind.as_str(),
				"overlay_set" | "overlay_patch" | "overlay_hidden" | "overlay_focus" | "overlay_blur"
			) {
				let id = effect
					.body
					.get("id")
					.or_else(|| effect.body.get("overlay"))
					.and_then(Value::as_str)
					.ok_or_else(|| {
						PresentationAuthorityError::Owner(Str::new_static(
							"overlay effect is missing its retained id",
						))
					})?;
				if !self.state.lock().overlays.contains(id) {
					return Err(PresentationAuthorityError::OverlayNotOpen(Str::new(id)));
				}
			}
			self
				.client
				.effect(self.identity.clone(), effect.clone())
				.await?;
			if let Some(key) = retained_key(&effect) {
				let mut state = self.state.lock();
				match effect.kind.as_str() {
					"unmount" => {
						state.retained.remove(&key);
					},
					"patch" | "overlay_patch" => {
						state.retained.entry(key).or_default().push(effect);
					},
					_ => {
						state.retained.insert(key, vec![effect]);
					},
				}
			}
			Ok(())
		}

		/// Executes a request with bounded idempotency retention and overlay
		/// close/wait ownership.
		pub async fn request(
			&self,
			context: PresentationCallContext<'_>,
			request: PresentationRequest,
		) -> Result<PresentationResponse, PresentationAuthorityError> {
			let (minimum, capability) = request_policy(&request);
			self.authorize(context, minimum, capability)?;
			if matches!(
				request,
				PresentationRequest::SetAppearance { .. }
					| PresentationRequest::SetToolsExpanded { .. }
					| PresentationRequest::SetHiddenThinkingLabel { .. }
			) {
				authorize_mutation_origin(context)?;
			}
			if let PresentationRequest::DynamicMount { generation } = &request
				&& *generation != self.identity.host_generation
			{
				return Err(PresentationAuthorityError::Identity);
			}
			{
				let mut state = self.state.lock();
				if let Some((completed_request, response)) = state.completed.get(&context.request_id) {
					if completed_request == &request {
						return Ok(response.clone());
					}
					return Err(PresentationAuthorityError::DuplicateRequest(context.request_id));
				}
				if !state.inflight.insert(context.request_id) {
					return Err(PresentationAuthorityError::DuplicateRequest(context.request_id));
				}
				if let Some(id) = overlay_id(&request)
					&& !state.overlays.contains(id)
				{
					state.inflight.remove(&context.request_id);
					return Err(PresentationAuthorityError::OverlayNotOpen(Str::new(id)));
				}
			}
			let inflight = InflightGuard { state: &self.state, id: context.request_id };
			let result = self
				.client
				.request(self.identity.clone(), request.clone())
				.await;
			drop(inflight);
			let mut state = self.state.lock();
			let response = result?;
			if let PresentationResponse::OverlayOpened { id } = &response {
				state.overlays.insert(id.clone());
			}
			if let PresentationRequest::OverlayClose { id } | PresentationRequest::OverlayWait { id } =
				&request
			{
				state.overlays.remove(id.as_str());
				state
					.retained
					.remove(&(Str::new_static("overlay"), id.clone()));
			}
			state
				.completed
				.insert(context.request_id, (request, response.clone()));
			state.completed_order.push_back(context.request_id);
			while state.completed_order.len() > COMPLETED_REQUEST_RETENTION {
				if let Some(expired) = state.completed_order.pop_front() {
					state.completed.remove(&expired);
				}
			}
			Ok(response)
		}

		/// Dispatches completion and renderer folds under their fixed deadlines.
		pub async fn dispatch_callback(
			&self,
			context: PresentationCallContext<'_>,
			callback: PresentationCallback,
		) -> Result<Value, PresentationAuthorityError> {
			if callback.kind == PresentationCallbackKind::Renderer
				&& context.phase == Some(InvocationPhase::Settled)
			{
				if context.identity != self.identity.as_ref() {
					return Err(PresentationAuthorityError::Identity);
				}
				if context.cancelled {
					return Err(PresentationAuthorityError::Cancelled);
				}
			} else {
				self.authorize(context, InvocationPhase::Open, None)?;
			}
			let kind = callback.kind;
			let deadline = match kind {
				PresentationCallbackKind::Completion => Some(COMPLETION_CALLBACK_DEADLINE),
				PresentationCallbackKind::Renderer => Some(RENDER_CALLBACK_DEADLINE),
				PresentationCallbackKind::Action => None,
			};
			let invocation = context
				.invocation
				.cloned()
				.ok_or(PresentationAuthorityError::Phase)?;
			let dispatch = self
				.callbacks
				.dispatch(self.identity.clone(), invocation, callback);
			match deadline {
				Some(deadline) => match tokio::time::timeout(deadline, dispatch).await {
					Ok(Ok(value)) => Ok(value),
					Ok(Err(_)) | Err(_) if kind == PresentationCallbackKind::Completion => {
						Ok(Value::Array(Vec::new()))
					},
					Ok(Err(_)) | Err(_) => Ok(Value::Null),
				},
				None => dispatch.await,
			}
		}

		/// Successful retained effects for renderer reattachment.
		pub fn retained_effects(
			&self,
			context: PresentationCallContext<'_>,
		) -> Result<Vec<PresentationEffect>, PresentationAuthorityError> {
			self.authorize(context, InvocationPhase::Open, None)?;
			Ok(self
				.state
				.lock()
				.retained
				.values()
				.flat_map(|effects| effects.iter().cloned())
				.collect())
		}
	}

	#[async_trait]
	impl omp_envd::exthost::UiControlOwner for PresentationAuthority {
		async fn request(
			&self,
			context: control::ControlRequestContext,
			request: exthost::UiControlRequest,
		) -> Result<UiControlResult, ControlProtocolError> {
			let request = match request {
				exthost::UiControlRequest::Presentation => PresentationRequest::Presentation,
				exthost::UiControlRequest::Commands => PresentationRequest::Commands,
				exthost::UiControlRequest::Icons { prefix } => PresentationRequest::Icons { prefix },
				exthost::UiControlRequest::EditorText => PresentationRequest::EditorText,
				exthost::UiControlRequest::Themes => PresentationRequest::Themes,
				exthost::UiControlRequest::SetAppearance { theme, persist } => {
					PresentationRequest::SetAppearance { theme, persist }
				},
				exthost::UiControlRequest::ToolsExpanded => PresentationRequest::ToolsExpanded,
				exthost::UiControlRequest::SetToolsExpanded { expanded } => {
					PresentationRequest::SetToolsExpanded { expanded }
				},
				exthost::UiControlRequest::SetHiddenThinkingLabel { label } => {
					PresentationRequest::SetHiddenThinkingLabel { label }
				},
				exthost::UiControlRequest::Dialog { kind, fields } => {
					PresentationRequest::Dialog { kind, fields }
				},
				exthost::UiControlRequest::Overlay { fields } => {
					PresentationRequest::Overlay { fields }
				},
				exthost::UiControlRequest::OverlayValues { id } => {
					PresentationRequest::OverlayValues { id }
				},
				exthost::UiControlRequest::OverlayWait { id } => {
					PresentationRequest::OverlayWait { id }
				},
				exthost::UiControlRequest::OverlayEvents { id } => {
					PresentationRequest::OverlayEvents { id }
				},
				exthost::UiControlRequest::OverlayClose { id } => {
					PresentationRequest::OverlayClose { id }
				},
				exthost::UiControlRequest::DynamicMount { generation } => {
					PresentationRequest::DynamicMount { generation }
				},
			};
			let call = PresentationCallContext {
				identity:   self.identity.as_ref(),
				phase:      context
					.invocation
					.as_ref()
					.map(|invocation| invocation.phase),
				cancelled:  context
					.invocation
					.as_ref()
					.is_some_and(|invocation| invocation.phase.is_terminal()),
				request_id: context.request_id,
				invocation: context.invocation.as_ref(),
			};
			let response = PresentationAuthority::request(self, call, request)
				.await
				.map_err(control_error)?;
			let value = match response {
				PresentationResponse::Presentation(value) | PresentationResponse::Dialog(value) => {
					value
				},
				PresentationResponse::Icons(icons) => Value::Array(
					icons
						.into_iter()
						.map(|icon| Value::String(icon.to_string()))
						.collect(),
				),
				PresentationResponse::EditorText(text) => Value::String(text.to_string()),
				PresentationResponse::Themes(themes) => Value::Array(
					themes
						.into_iter()
						.map(|theme| Value::String(theme.to_string()))
						.collect(),
				),
				PresentationResponse::ToolsExpanded(expanded) => Value::Bool(expanded),
				PresentationResponse::OverlayOpened { id } => {
					serde_json::json!({"id": id.as_str()})
				},
				PresentationResponse::OverlayValues(values) => Value::Object(values),
				PresentationResponse::OverlayEvents(events) => Value::Array(events),
				PresentationResponse::Ack => Value::Null,
			};
			Ok(if value.is_null() {
				UiControlResult::Ack
			} else {
				UiControlResult::Value(value)
			})
		}

		async fn effect(
			&self,
			context: control::ControlRequestContext,
			effect: Value,
		) -> Result<(), ControlProtocolError> {
			let effect: PresentationEffect = serde_json::from_value(effect)
				.map_err(|error| ControlProtocolError::new("InvalidUiEffect", error.to_string()))?;
			let call = PresentationCallContext {
				identity:   self.identity.as_ref(),
				phase:      context
					.invocation
					.as_ref()
					.map(|invocation| invocation.phase),
				cancelled:  context
					.invocation
					.as_ref()
					.is_some_and(|invocation| invocation.phase.is_terminal()),
				request_id: context.request_id,
				invocation: context.invocation.as_ref(),
			};
			PresentationAuthority::effect(self, call, effect)
				.await
				.map_err(control_error)
		}
	}

	fn control_error(error: PresentationAuthorityError) -> ControlProtocolError {
		let code = match &error {
			PresentationAuthorityError::Identity => "StaleGeneration",
			PresentationAuthorityError::Cancelled => "Cancelled",
			PresentationAuthorityError::Phase => "InvalidPhase",
			PresentationAuthorityError::MutationOrigin => "UiMutationDenied",
			PresentationAuthorityError::Capability(_) => "CapabilityDenied",
			PresentationAuthorityError::Unavailable => "DialogUnavailable",
			PresentationAuthorityError::OverlayNotOpen(_) => "OverlayNotOpen",
			PresentationAuthorityError::DuplicateRequest(_) => "DuplicateRequest",
			PresentationAuthorityError::CallbackTimeout => "CallbackTimeout",
			PresentationAuthorityError::Owner(_) => "PresentationOwnerFailed",
		};
		ControlProtocolError::new(code, error.to_string())
	}

	fn authorize_mutation_origin(
		context: PresentationCallContext<'_>,
	) -> Result<(), PresentationAuthorityError> {
		let Some(invocation) = context.invocation else {
			return Err(PresentationAuthorityError::MutationOrigin);
		};
		if invocation.phase != InvocationPhase::EffectsAuthorized
			|| !invocation.has_ui
			|| invocation.headless
			|| invocation.turn.is_some()
			|| invocation.event.is_some()
			|| invocation.call.is_some()
			|| invocation.device.is_some()
		{
			return Err(PresentationAuthorityError::MutationOrigin);
		}
		Ok(())
	}

	fn request_policy(request: &PresentationRequest) -> (InvocationPhase, Option<&'static str>) {
		match request {
			PresentationRequest::Dialog { .. }
			| PresentationRequest::Overlay { .. }
			| PresentationRequest::OverlayWait { .. } => {
				(InvocationPhase::EffectsAuthorized, Some("ui.dialogs"))
			},
			PresentationRequest::Commands => (InvocationPhase::Open, None),
			PresentationRequest::DynamicMount { .. } => (InvocationPhase::Open, Some("ui.commands")),
			_ => (InvocationPhase::Open, None),
		}
	}

	fn effect_policy(effect: &PresentationEffect) -> (InvocationPhase, Option<&'static str>) {
		match effect.kind.as_str() {
			"notify" => (InvocationPhase::EffectsAuthorized, Some("ui.notify")),
			"open_url" | "set_title" | "set_progress" => {
				(InvocationPhase::EffectsAuthorized, Some("ui.title"))
			},
			"submit" | "image" => (InvocationPhase::EffectsAuthorized, None),
			"set_ghost" => (InvocationPhase::Open, Some("ui.ghost")),
			"mount" | "unmount" | "patch" | "focus_slot" | "blur_slot" => {
				(InvocationPhase::Open, Some("ui.slots"))
			},
			_ => (InvocationPhase::Open, None),
		}
	}

	fn retained_key(effect: &PresentationEffect) -> Option<(Str, Str)> {
		let (family, key) = match effect.kind.as_str() {
			"mount" | "unmount" | "patch" => ("slot", effect.body.get("key").and_then(Value::as_str)?),
			"set_status" => (
				"status",
				effect
					.body
					.get("key")
					.and_then(Value::as_str)
					.unwrap_or("default"),
			),
			"set_ghost" => ("ghost", "editor"),
			"set_title" => ("title", "terminal"),
			"set_progress" => ("progress", "terminal"),
			"set_working_message" => ("working", "terminal"),
			"set_working_indicator" => ("working-indicator", "terminal"),
			"overlay_set" | "overlay_patch" | "overlay_hidden" => (
				"overlay",
				effect
					.body
					.get("id")
					.or_else(|| effect.body.get("overlay"))
					.and_then(Value::as_str)?,
			),
			_ => return None,
		};
		Some((Str::new_static(family), Str::new(key)))
	}

	fn overlay_id(request: &PresentationRequest) -> Option<&str> {
		match request {
			PresentationRequest::OverlayValues { id }
			| PresentationRequest::OverlayWait { id }
			| PresentationRequest::OverlayEvents { id }
			| PresentationRequest::OverlayClose { id } => Some(id),
			_ => None,
		}
	}

	#[cfg(test)]
	mod tests {
		use omp_core::sf;

		use super::*;

		struct Client {
			tools: Mutex<bool>,
			theme: Mutex<Option<Str>>,
		}

		#[async_trait]
		impl PresentationClient for Client {
			async fn effect(
				&self,
				_identity: Arc<PresentationIdentity>,
				_effect: PresentationEffect,
			) -> Result<(), PresentationAuthorityError> {
				Ok(())
			}

			async fn request(
				&self,
				_identity: Arc<PresentationIdentity>,
				request: PresentationRequest,
			) -> Result<PresentationResponse, PresentationAuthorityError> {
				match request {
					PresentationRequest::SetAppearance { theme, .. } => {
						*self.theme.lock() = Some(theme);
						Ok(PresentationResponse::Ack)
					},
					PresentationRequest::SetToolsExpanded { expanded } => {
						*self.tools.lock() = expanded;
						Ok(PresentationResponse::Ack)
					},
					PresentationRequest::ToolsExpanded => {
						Ok(PresentationResponse::ToolsExpanded(*self.tools.lock()))
					},
					_ => Ok(PresentationResponse::Ack),
				}
			}
		}

		struct Callbacks;

		#[async_trait]
		impl PresentationCallbackDispatcher for Callbacks {
			async fn dispatch(
				&self,
				_identity: Arc<PresentationIdentity>,
				_invocation: ControlInvocationAuthority,
				_callback: PresentationCallback,
			) -> Result<Value, PresentationAuthorityError> {
				Ok(Value::Null)
			}
		}

		fn identity() -> Arc<PresentationIdentity> {
			Arc::new(PresentationIdentity {
				principal:          sf!("principal"),
				extension:          sf!("extension"),
				artifact_digest:    sf!("digest"),
				host_generation:    1,
				session_generation: 1,
				capabilities:       Arc::new(BTreeSet::new()),
			})
		}

		fn invocation() -> ControlInvocationAuthority {
			ControlInvocationAuthority {
				invocation:        sf!("command"),
				phase:             InvocationPhase::EffectsAuthorized,
				session:           sf!("session"),
				turn:              None,
				event:             None,
				call:              None,
				device:            None,
				effects:           Box::new([]),
				place_kind:        sf!("host"),
				lifecycle:         omp_core::LifecyclePhase::Active,
				roots:             Box::new([]),
				remote:            false,
				has_ui:            true,
				headless:          false,
				settings:          serde_json::Map::new(),
				secret_settings:   Box::new([]),
				data:              None,
				direct_filesystem: None,
			}
		}

		#[tokio::test]
		async fn appearance_and_disclosure_mutations_require_command_origin() {
			let identity = identity();
			let client = Arc::new(Client { tools: Mutex::new(false), theme: Mutex::new(None) });
			let authority =
				PresentationAuthority::new(identity.clone(), client.clone(), Arc::new(Callbacks));
			let denied = PresentationCallContext {
				identity:   identity.as_ref(),
				phase:      None,
				cancelled:  false,
				request_id: 1,
				invocation: None,
			};
			assert_eq!(
				authority
					.request(denied, PresentationRequest::SetAppearance {
						theme:   sf!("dark"),
						persist: false,
					})
					.await,
				Err(PresentationAuthorityError::MutationOrigin)
			);

			let invocation = invocation();
			let call = |request_id| PresentationCallContext {
				identity: identity.as_ref(),
				phase: Some(InvocationPhase::EffectsAuthorized),
				cancelled: false,
				request_id,
				invocation: Some(&invocation),
			};
			assert_eq!(
				authority
					.request(call(2), PresentationRequest::SetAppearance {
						theme:   sf!("dark"),
						persist: false,
					})
					.await,
				Ok(PresentationResponse::Ack)
			);
			assert_eq!(client.theme.lock().as_deref(), Some("dark"));
			assert_eq!(
				authority
					.request(call(3), PresentationRequest::SetToolsExpanded { expanded: true },)
					.await,
				Ok(PresentationResponse::Ack)
			);
			assert_eq!(
				authority
					.request(call(4), PresentationRequest::ToolsExpanded)
					.await,
				Ok(PresentationResponse::ToolsExpanded(true))
			);
		}
	}
}
fn presentation_composer_style(style: settings::ComposerStyle) -> components::ComposerStyle {
	match style {
		settings::ComposerStyle::Box => components::ComposerStyle::Box,
		settings::ComposerStyle::Claude => components::ComposerStyle::Claude,
		settings::ComposerStyle::Pi => components::ComposerStyle::Pi,
		settings::ComposerStyle::Borderless => components::ComposerStyle::Borderless,
		settings::ComposerStyle::Rule => components::ComposerStyle::Rule,
		settings::ComposerStyle::Field => components::ComposerStyle::Field,
		settings::ComposerStyle::Rail => components::ComposerStyle::Rail,
	}
}
fn css_color(color: omp_tui::Color) -> String {
	match color {
		omp_tui::Color::Rgb(red, green, blue) => format!("#{red:02x}{green:02x}{blue:02x}"),
		omp_tui::Color::Default | omp_tui::Color::Indexed(_) => "currentColor".to_owned(),
	}
}

/// Durable session facts required to initialize the designed chat scene.
pub struct ChatUiSession {
	/// Stable session identifier displayed by the status line.
	pub session_id:     Str,
	/// Canonical path owned by the active session storage authority.
	pub journal_path:   PathBuf,
	/// Canonical history replayed before live events.
	pub initial_items:  Vec<Item>,
	/// Selected model's total token window, when known by the catalog.
	pub context_window: Option<u64>,
	/// Current durable title authority restored from the sessions index.
	pub title:          SessionTitleState,
}

enum UiCmd {
	/// Boxes the foreign generated protobuf item; one allocation is paid per
	/// user submit.
	Submit {
		item:   Box<Item>,
		budget: Option<ParsedTurnBudget>,
	},
	ListRewind {
		reply: flume::Sender<Result<Vec<RewindTarget>, String>>,
	},
	TodoEdited {
		phases: Box<serde_json::value::RawValue>,
		reply:  flume::Sender<Result<(), String>>,
	},
	Rewind {
		to:    Option<u64>,
		reply: flume::Sender<Result<Vec<Item>, String>>,
	},
	Retry {
		reply: flume::Sender<Result<(Vec<Item>, Str), String>>,
	},
	Compact {
		request: omp_agent::ManualCompactionRequest,
	},
	Shake {
		mode: omp_agent::ManualShakeMode,
	},
	Regime {
		operation: RegimeOperation,
		reply:     flume::Sender<Result<RegimeMutation, omp_agent::AgentError>>,
	},
	ForceTool {
		tool: Str,
	},
	Handoff {
		request: omp_agent::ManualCompactionRequest,
		reply:   flume::Sender<Result<omp_agent::ManualCompactionOutcome, String>>,
	},
	CreateSessionChild {
		kind:       omp_agent::ChildKind,
		child_id:   Str,
		child_path: PathBuf,
		title:      Option<Str>,
		reply:      flume::Sender<Result<u64, String>>,
	},
	DeleteCurrentSession {
		path:  PathBuf,
		reply: flume::Sender<Result<(), String>>,
	},
}
enum MaintenanceEvent {
	Compact(Result<omp_agent::ManualCompactionOutcome, omp_agent::AgentError>),
	Shake(Result<(omp_agent::ManualShakeOutcome, Vec<Item>), omp_agent::AgentError>),
}
enum RegimeOperation {
	Start { id: &'static str, queue: bool, prompt_slot: Option<&'static str> },
	Stop { activation: Str },
}

enum RegimeMutation {
	Started(omp_agent::StartReceipt),
	Stopped(bool),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct SubmitAck {
	interrupted:     bool,
	committed_turns: u32,
}

struct PendingPrompt {
	text:        Str,
	attachments: Vec<Attachment>,
}

struct ToolDisplay {
	identity:           ToolIdentity,
	args:               omp_slopjson::Value,
	started:            bool,
	fold:               ViewState,
	updates:            Vec<Value>,
	opened:             Instant,
	extension_renderer: Option<ExtensionRendererRoute>,
}
#[derive(Clone, Copy)]
struct ExtensionRendererRoute {
	native_authoritative: bool,
}

struct RegistryCompletionCache {
	generation: u64,
	records:    Vec<(Str, Str)>,
}

struct ProjectCompletionSource {
	paths:    Vec<Str>,
	registry: omp_agent::AgentRegistry,
	agents:   Mutex<RegistryCompletionCache>,
}

impl ProjectCompletionSource {
	fn scan(root: &Path) -> Self {
		let paths = omp_walker::WalkRequest::new(root)
			.hidden(false)
			.gitignore(true)
			.skip_git(true)
			.depth(1, 64)
			.limit(2_000)
			.collect()
			.map(|outcome| {
				outcome
					.entries
					.into_iter()
					.map(|entry| Str::from(entry.path))
					.collect()
			})
			.unwrap_or_default();
		Self {
			paths,
			registry: omp_agent::AgentRegistry::global().clone(),
			agents: Mutex::new(RegistryCompletionCache {
				generation: u64::MAX,
				records:    Vec::new(),
			}),
		}
	}

	fn internal_urls(&self, query: &str) -> SuggestionList {
		let lower = query.to_ascii_lowercase();
		let scheme = if lower.starts_with("agent://") {
			Some("agent://")
		} else if lower.starts_with("history://") {
			Some("history://")
		} else {
			None
		};
		let Some(scheme) = scheme else {
			return INTERNAL_URI_SCHEMES
				.iter()
				.filter(|candidate| candidate.contains(lower.as_str()))
				.map(|candidate| {
					Suggestion::new(*candidate, *candidate)
						.with_category("Internal URLs")
						.with_description("bounded retained URI source")
				})
				.collect();
		};
		let generation = self.registry.generation();
		let mut cache = self.agents.lock();
		if cache.generation != generation {
			cache.records = self
				.registry
				.roster(false)
				.into_iter()
				.map(|record| (record.id, record.status.to_string().into()))
				.collect();
			cache.generation = generation;
		}
		let needle = &lower[scheme.len()..];
		cache
			.records
			.iter()
			.filter(|(id, _)| id.to_ascii_lowercase().contains(needle))
			.take(64)
			.map(|(id, status)| {
				Suggestion::new(sf!("{scheme}{id}"), id.clone())
					.with_category("Agent journals")
					.with_description(status.clone())
			})
			.collect()
	}
}

impl CompletionSource for ProjectCompletionSource {
	fn complete(&self, query: CompletionQuery) -> SuggestionList {
		let needle = query.query.to_ascii_lowercase();
		match query.trigger {
			CompletionTrigger::Mention => self
				.paths
				.iter()
				.filter(|path| path.to_ascii_lowercase().contains(&needle))
				.take(48)
				.map(|path| {
					Suggestion::new(sf!("@{path}"), path.clone())
						.with_category("Workspace paths")
						.with_description("gitignore-aware project path")
				})
				.collect(),
			CompletionTrigger::Hash => {
				let label = if needle.is_empty() {
					sf!("GitHub index unavailable")
				} else {
					sf!("#{needle} · index unavailable")
				};
				[Suggestion::new(sf!("#{needle}"), label)
					.with_category("GitHub")
					.with_description(
						"Issue/PR cache is unavailable; no per-keystroke network request was made",
					)]
				.into_iter()
				.collect()
			},
			CompletionTrigger::Custom => self.internal_urls(query.query.as_str()),
			CompletionTrigger::Extension => SuggestionList::new(),
			CompletionTrigger::Slash => SuggestionList::new(),
		}
	}
}

const INTERNAL_URI_SCHEMES: &[&str] = &[
	"local://",
	"artifact://",
	"agent://",
	"history://",
	"mcp://",
	"memory://",
	"skill://",
	"rule://",
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum InspectImageMode {
	On,
	Off,
}

fn model_accepts_images(catalog: &Catalog, model: &str) -> bool {
	resolve_model(catalog, model)
		.and_then(|model| model.capabilities.chat.as_ref())
		.is_some_and(|chat| {
			matches!(
				chat.image_input,
				omp_catalog::Availability::Native(_) | omp_catalog::Availability::Emulated { .. }
			)
		})
}

fn inspect_image_enabled(state: &BridgeState) -> bool {
	match state.vision_override {
		None => !model_accepts_images(state.catalog.as_ref(), &state.model),
		Some(InspectImageMode::On) => true,
		Some(InspectImageMode::Off) => false,
	}
}

struct BridgeState {
	catalog: Arc<Catalog>,
	auth_control: Option<omp_inference::auth::AuthControlHandle>,
	model: String,
	model_settings: ModelSettings,
	pending_session_delete: Option<std::time::Instant>,
	git: Option<GitWorkbenchBackend>,
	git_facts: Option<omp_chat_ui::GitFacts>,
	advisor: Option<Arc<Mutex<AdvisorEngine>>>,
	session_id: Str,
	session_path: PathBuf,
	sessions_dir: PathBuf,
	title: SessionTitleState,
	title_generation_in_flight: Arc<AtomicBool>,
	title_user_set: Arc<AtomicBool>,
	title_commit_lock: Arc<tokio::sync::Mutex<()>>,
	title_replan_refresh_pending: bool,
	local_root: PathBuf,
	regimes: RegimeHandle,
	regime_revision: u64,
	collab: Option<CollabCommandHandle>,
	collab_live: Option<omp_driver::collab::session::HostLiveHandle>,
	collab_state: Option<omp_proto::collab::v1::SessionStateUpdate>,
	environment: omp_env::EnvClient,
	session_hooks: Arc<omp_agent::HookGate>,
	lsp_servers: Vec<omp_proto::document::v1::LspServerStatus>,
	memory: Option<Arc<omp_driver::memory::ChatMemory>>,
	workspace_root: Str,
	appearance: omp_tui::Appearance,
	presentation: UiContext,
	hyperlinks: bool,
	theme_watcher: ThemeWatcher,
	theme_revision: u64,
	tools_expanded: bool,
	hidden_thinking_label: Option<Str>,
	deferred: DeferredCommands,
	active_ptys: HashMap<Str, omp_env::ActiveExecControl>,
	context_window: Option<u64>,
	context_tokens: u64,
	context_snapshot: Option<omp_agent::ContextSnapshot>,
	cost_nanos: u64,
	queued: usize,
	queued_prompts: VecDeque<omp_chat_ui::QueuedPrompt>,
	audio: crate::audio_coordinator::InteractiveAudioController,
	jobs: HashSet<Str>,
	attempt: u32,
	turn_started: Option<Instant>,
	has_history: bool,
	submit_pending: bool,
	pending_prompt: Option<PendingPrompt>,
	part_serial: u64,
	active_parts: HashMap<u32, Str>,
	active_markdown: HashMap<Str, (u64, String)>,
	streaming_tools: HashMap<u32, (Str, Vec<u8>)>,
	tools: HashMap<Str, ToolDisplay>,
	rewind_targets: Vec<RewindTarget>,
	pending_auth_kind: Option<AuthPromptKind>,
	pending_auth_provider: Option<Str>,
	live_activity: ActivityWaveform,
	token_rate: Option<TokenRateMeter>,
	tokens_per_second: Option<u64>,
	thinking: Option<StatusThinkingLevel>,
	replaying_turn: bool,
	vision_override: Option<InspectImageMode>,
	settings: Settings,
	prompt_discovery_settings: omp_driver::discovery::PromptDiscoverySettings,
	commands: CommandRoster,
	command_sources: Vec<Vec<CommandContribution>>,
	command_usage: Arc<CommandUsage>,
	typed_commands: commands::CommandRoster,
	extension_ui: Arc<presentation::PublishedUiRoster>,
	extension_callbacks: Option<Arc<dyn omp_envd::exthost::dispatch::CallbackDispatcher>>,
	skills: Arc<omp_driver::skills::SkillSnapshot>,
	extension_declarations: Arc<[omp_driver::discovery::manifest::DiscoveredCapability]>,
	extension_generation: u64,
	extension_mcp: Option<omp_env::McpSubscription>,
	extension_live_mcp: HashMap<Str, omp_chat_ui::McpLiveSnapshot>,
	approvals: HashMap<Str, ApprovalRequest>,
	presentation_requests: HashMap<Str, (u64, presentation_authority::PresentationRequest)>,
	raw_stream: Option<flume::Receiver<omp_inference::transport::CapturedFrame>>,
}

async fn refresh_lsp_roster(state: &mut BridgeState) {
	if let Ok(response) = state.environment.lsp_status(false).await {
		state.lsp_servers = response.servers;
	}
}
/// Refreshes cached repository facts from the Environment-owned snapshot.
async fn refresh_git_facts(state: &mut BridgeState) {
	use omp_proto::env::v1::{RepositoryAvailability, RepositorySnapshotRequest};
	let Ok(snapshot) = state
		.environment
		.repository_snapshot(RepositorySnapshotRequest::default())
		.await
	else {
		return;
	};
	if snapshot.availability != RepositoryAvailability::Available as i32 {
		state.git_facts = None;
		return;
	}
	let branch = if snapshot.branch.is_empty() {
		Str::from(snapshot.head.get(..8).unwrap_or(snapshot.head.as_str()))
	} else {
		Str::from(snapshot.branch.as_str())
	};
	state.git_facts = Some(omp_chat_ui::GitFacts {
		branch,
		dirty: snapshot.unstaged,
		staged: snapshot.staged,
		untracked: snapshot.untracked,
	});
}

fn lsp_stage_label(stage: i32) -> &'static str {
	use omp_proto::document::v1::LspServerStage;

	match LspServerStage::try_from(stage).unwrap_or(LspServerStage::Unspecified) {
		LspServerStage::Available => "available",
		LspServerStage::Starting => "starting",
		LspServerStage::Indexing => "indexing",
		LspServerStage::Ready => "ready",
		LspServerStage::Failed => "failed",
		LspServerStage::Unspecified => "unknown",
	}
}

fn lsp_roster_active(servers: &[omp_proto::document::v1::LspServerStatus]) -> bool {
	use omp_proto::document::v1::LspServerStage;

	servers.iter().any(|server| {
		matches!(
			LspServerStage::try_from(server.stage),
			Ok(LspServerStage::Starting | LspServerStage::Indexing)
		)
	})
}

fn welcome_lsp_servers(
	servers: &[omp_proto::document::v1::LspServerStatus],
) -> Vec<omp_chat_ui::WelcomeLspServer> {
	servers
		.iter()
		.take(3)
		.map(|server| {
			let stage = lsp_stage_label(server.stage);
			let stage_label = if server.file_types.is_empty() {
				Str::new_static(stage)
			} else {
				sf!("{stage} ({})", server.file_types.join(", "))
			};
			omp_chat_ui::WelcomeLspServer {
				name: Str::new(&server.name),
				stage_label,
				failed: stage == "failed",
			}
		})
		.collect()
}
/// Rotating one-line tips shown under the welcome banner.
const WELCOME_TIPS: &[&str] = &[
	"Tired of typing \"keep going\"? Just send a '.'",
	"/model switches models mid-session.",
	"! runs shell commands and $ runs Python without leaving the chat.",
	"# opens prompt actions for the current draft.",
	"/theme previews themes live as you scroll.",
];

/// Builds the transcript welcome banner from startup facts.
fn welcome_banner(state: &BridgeState) -> omp_chat_ui::WelcomeBanner {
	let rows =
		model_rows(state.catalog.as_ref(), &state.model_settings, state.auth_control.as_ref());
	let current = rows.get(current_model_index(&rows, &state.model));
	let tip = WELCOME_TIPS[usize::try_from(now_ms()).unwrap_or(0) % WELCOME_TIPS.len()];
	omp_chat_ui::WelcomeBanner {
		version:     Str::new_static(env!("CARGO_PKG_VERSION")),
		model:       current
			.map(|row| row.name.clone())
			.unwrap_or_else(|| Str::from(state.model.as_str())),
		provider:    current.map(|row| row.provider.clone()).unwrap_or_default(),
		lsp_servers: welcome_lsp_servers(&state.lsp_servers),
		tip:         Some(Str::new_static(tip)),
	}
}

struct GitWorkbenchBackend {
	session: GitSession,
	cancel:  CancellationToken,
}
impl Drop for GitWorkbenchBackend {
	fn drop(&mut self) {
		self.cancel.cancel();
	}
}

fn raw_frame(frame: omp_inference::transport::CapturedFrame) -> RawFrame {
	RawFrame {
		sequence: frame.sequence,
		session:  frame.session,
		event:    frame.event,
		payload:  frame.payload,
	}
}

fn stream_summary(summary: omp_inference::transport::CaptureSummary) -> StreamSummary {
	StreamSummary {
		retained:         summary.retained,
		evicted:          summary.evicted,
		subscriber_drops: summary.subscriber_drops,
	}
}

async fn next_raw_stream_frame(
	stream: &mut Option<flume::Receiver<omp_inference::transport::CapturedFrame>>,
) -> omp_inference::transport::CapturedFrame {
	if let Some(stream) = stream.as_ref()
		&& let Ok(frame) = stream.recv_async().await
	{
		return frame;
	}
	*stream = None;
	pending().await
}

async fn next_extension_mcp_event(
	subscription: &mut Option<omp_env::McpSubscription>,
) -> Option<omp_env::McpSubscriptionEvent> {
	if let Some(subscription) = subscription.as_mut() {
		return subscription.next_event().await.ok().flatten();
	}
	pending().await
}

async fn next_presentation_dispatch(
	endpoint: &mut Option<presentation::PresentationEndpoint>,
) -> presentation::PresentationDispatch {
	if let Some(attached) = endpoint.as_ref()
		&& let Ok(dispatch) = attached.recv().await
	{
		return dispatch;
	}
	*endpoint = None;
	pending().await
}

fn presentation_tml(value: Option<&Value>) -> Option<Tml> {
	let source = match value? {
		Value::String(source) => source.as_str(),
		Value::Object(value) => value.get("source")?.as_str()?,
		_ => return None,
	};
	let digest = Hash32::sum(source.as_bytes());
	let mut hash = [0_u8; 8];
	hash.copy_from_slice(&digest.as_bytes()[..8]);
	Some(Tml { source: Bytes::copy_from_slice(source.as_bytes()), hash: u64::from_le_bytes(hash) })
}

fn presentation_key(identity: &presentation_authority::PresentationIdentity, key: &str) -> String {
	format!("{}:{key}", identity.extension)
}

fn presentation_prop(value: &Value) -> Option<PropValue> {
	let value = match value {
		Value::String(value) => prop_value::Value::StringValue(value.clone()),
		Value::Bool(value) => prop_value::Value::BoolValue(*value),
		Value::Number(value) => {
			if let Some(value) = value.as_i64() {
				prop_value::Value::IntegerValue(value)
			} else {
				prop_value::Value::NumberValue(value.as_f64()?)
			}
		},
		_ => return None,
	};
	Some(PropValue { value: Some(value) })
}

fn presentation_props(value: Option<&Value>) -> BTreeMap<String, PropValue> {
	value
		.and_then(Value::as_object)
		.into_iter()
		.flatten()
		.filter_map(|(key, value)| presentation_prop(value).map(|value| (key.clone(), value)))
		.collect()
}

fn presentation_proto_value(value: &Value) -> v1::Value {
	let kind = match value {
		Value::Null => value::Kind::Null(true),
		Value::Bool(value) => value::Kind::Bool(*value),
		Value::String(value) => value::Kind::String(value.clone()),
		Value::Number(value) => {
			if let Some(value) = value.as_i64() {
				value::Kind::Int(value)
			} else if let Some(value) = value.as_u64() {
				value::Kind::Uint(value)
			} else {
				value::Kind::Double(value.as_f64().unwrap_or_default())
			}
		},
		Value::Array(values) => value::Kind::List(v1::ValueList {
			values: values.iter().map(presentation_proto_value).collect(),
		}),
		Value::Object(values) => value::Kind::Map(presentation_value_map(values)),
	};
	v1::Value { kind: Some(kind) }
}

fn presentation_value_map(values: &serde_json::Map<String, Value>) -> v1::ValueMap {
	v1::ValueMap {
		fields: values
			.iter()
			.map(|(key, value)| (key.clone(), presentation_proto_value(value)))
			.collect(),
	}
}

fn presentation_slot(value: &str) -> Option<SlotPlacement> {
	Some(match value {
		"header" => SlotPlacement::Header,
		"footer" => SlotPlacement::Footer,
		"above_editor" => SlotPlacement::AboveEditor,
		"below_editor" => SlotPlacement::BelowEditor,
		"sidebar_left" => SlotPlacement::LeftRail,
		"sidebar_right" => SlotPlacement::RightRail,
		_ => return None,
	})
}

/// Lowers one authenticated extension effect into the canonical UI protocol.
pub fn lower_presentation_effect(
	identity: &presentation_authority::PresentationIdentity,
	effect: &presentation_authority::PresentationEffect,
) -> Result<UiEffect, presentation_authority::PresentationAuthorityError> {
	use presentation_authority::PresentationAuthorityError;
	let body = &effect.body;
	let string = |name: &str| body.get(name).and_then(Value::as_str);
	let kind = match effect.kind.as_str() {
		"mount" => {
			let key = string("key")
				.ok_or_else(|| PresentationAuthorityError::Owner(sf!("mount effect requires key")))?;
			let placement = string("placement")
				.and_then(presentation_slot)
				.ok_or_else(|| {
					PresentationAuthorityError::Owner(sf!("mount effect has an unsupported placement"))
				})?;
			let content = presentation_tml(body.get("content")).ok_or_else(|| {
				PresentationAuthorityError::Owner(sf!("mount effect requires TML content"))
			})?;
			let options = body.get("options").and_then(Value::as_object);
			ui_effect::Kind::MountSlot(MountSlot {
				key:       presentation_key(identity, key),
				placement: placement as i32,
				content:   Some(content),
				options:   Some(SlotOptions {
					order:   options
						.and_then(|options| options.get("order"))
						.and_then(Value::as_i64)
						.and_then(|value| i32::try_from(value).ok())
						.unwrap_or(100),
					visible: true,
					width:   options
						.and_then(|options| options.get("width"))
						.and_then(Value::as_u64)
						.and_then(|value| u32::try_from(value).ok()),
					height:  options
						.and_then(|options| options.get("max_height"))
						.and_then(Value::as_u64)
						.and_then(|value| u32::try_from(value).ok()),
					props:   None,
				}),
			})
		},
		"patch" => {
			let key = string("key")
				.ok_or_else(|| PresentationAuthorityError::Owner(sf!("patch effect requires key")))?;
			let node_id = string("id")
				.ok_or_else(|| PresentationAuthorityError::Owner(sf!("patch effect requires id")))?;
			ui_effect::Kind::PatchNode(PatchNode {
				key:     presentation_key(identity, key),
				node_id: node_id.to_owned(),
				text:    presentation_tml(body.get("text")),
				props:   presentation_props(body.get("props")),
			})
		},
		"unmount" => {
			let key = string("key")
				.ok_or_else(|| PresentationAuthorityError::Owner(sf!("unmount effect requires key")))?;
			ui_effect::Kind::UnmountSlot(UnmountSlot { key: presentation_key(identity, key) })
		},
		"slot_visible" => {
			let key = string("key").ok_or_else(|| {
				PresentationAuthorityError::Owner(sf!("slot_visible effect requires key"))
			})?;
			let props = body
				.get("visible")
				.and_then(presentation_prop)
				.map(|visible| BTreeMap::from([(String::from("visible"), visible)]))
				.unwrap_or_default();
			ui_effect::Kind::PatchNode(PatchNode {
				key: presentation_key(identity, key),
				node_id: String::new(),
				text: None,
				props,
			})
		},
		"overlay_hidden" => {
			let key = string("id").ok_or_else(|| {
				PresentationAuthorityError::Owner(sf!("overlay_hidden effect requires id"))
			})?;
			let visible = !body.get("hidden").and_then(Value::as_bool).unwrap_or(false);
			ui_effect::Kind::PatchNode(PatchNode {
				key:     key.to_owned(),
				node_id: String::new(),
				text:    None,
				props:   BTreeMap::from([(String::from("visible"), PropValue {
					value: Some(prop_value::Value::BoolValue(visible)),
				})]),
			})
		},
		"overlay_focus" => {
			ui_effect::Kind::FocusSlot(FocusSlot { key: string("id").unwrap_or_default().to_owned() })
		},
		"overlay_blur" => ui_effect::Kind::FocusSlot(FocusSlot { key: String::new() }),
		"focus_slot" => {
			let key = string("key").ok_or_else(|| {
				PresentationAuthorityError::Owner(sf!("focus_slot effect requires key"))
			})?;
			ui_effect::Kind::FocusSlot(FocusSlot { key: presentation_key(identity, key) })
		},
		"blur_slot" => ui_effect::Kind::FocusSlot(FocusSlot { key: String::new() }),
		"set_status" => {
			let key = presentation_key(identity, string("key").unwrap_or("status"));
			let side = string("side").unwrap_or("status_right");
			let status_props = v1::ValueMap {
				fields: BTreeMap::from([(
					String::from("side"),
					presentation_proto_value(&Value::String(side.to_owned())),
				)]),
			};
			if let Some(content) = presentation_tml(body.get("content")) {
				ui_effect::Kind::MountSlot(MountSlot {
					key,
					placement: SlotPlacement::Footer as i32,
					content: Some(content),
					options: Some(SlotOptions {
						order:   body
							.get("order")
							.and_then(Value::as_i64)
							.and_then(|value| i32::try_from(value).ok())
							.unwrap_or(100),
						visible: true,
						width:   None,
						height:  None,
						props:   Some(status_props),
					}),
				})
			} else {
				ui_effect::Kind::UnmountSlot(UnmountSlot { key })
			}
		},
		"set_working_message" => {
			let key = presentation_key(identity, "working");
			if let Some(content) = presentation_tml(body.get("content")) {
				ui_effect::Kind::MountSlot(MountSlot {
					key,
					placement: SlotPlacement::Footer as i32,
					content: Some(content),
					options: Some(SlotOptions {
						order:   90,
						visible: true,
						width:   None,
						height:  None,
						props:   None,
					}),
				})
			} else {
				ui_effect::Kind::UnmountSlot(UnmountSlot { key })
			}
		},
		"set_progress" => {
			let key = presentation_key(identity, "progress");
			let state = body.get("state").and_then(Value::as_object);
			let kind = state
				.and_then(|state| state.get("kind"))
				.and_then(Value::as_str)
				.unwrap_or("clear");
			if kind == "clear" {
				ui_effect::Kind::UnmountSlot(UnmountSlot { key })
			} else {
				let pct = state
					.and_then(|state| state.get("pct"))
					.and_then(Value::as_u64);
				let label = pct.map_or_else(|| kind.to_owned(), |pct| format!("{kind} {pct}%"));
				ui_effect::Kind::MountSlot(MountSlot {
					key,
					placement: SlotPlacement::Footer as i32,
					content: presentation_tml(Some(&Value::String(format!("<text>{label}</text>")))),
					options: Some(SlotOptions {
						order:   95,
						visible: true,
						width:   None,
						height:  None,
						props:   None,
					}),
				})
			}
		},
		"set_editor_text" => {
			let text = string("text").ok_or_else(|| {
				PresentationAuthorityError::Owner(sf!("set_editor_text effect requires text"))
			})?;
			ui_effect::Kind::ComposerEdit(ComposerEdit {
				start: 0,
				end:   u32::MAX,
				text:  text.to_owned(),
			})
		},
		"paste_to_editor" => {
			let content = body
				.get("content")
				.and_then(|value| match value {
					Value::String(value) => Some(value.as_str()),
					Value::Object(value) => value.get("source").and_then(Value::as_str),
					_ => None,
				})
				.ok_or_else(|| {
					PresentationAuthorityError::Owner(sf!(
						"paste_to_editor effect requires string or TML content"
					))
				})?;
			ui_effect::Kind::ComposerEdit(ComposerEdit {
				start: u32::MAX,
				end:   u32::MAX,
				text:  content.to_owned(),
			})
		},
		"open_url" => {
			let url = string("url").ok_or_else(|| {
				PresentationAuthorityError::Owner(sf!("open_url effect requires url"))
			})?;
			ui_effect::Kind::OpenUrl(OpenUrl { url: url.to_owned() })
		},
		"notify" => {
			let message = body
				.get("message")
				.or_else(|| body.get("text"))
				.and_then(|value| match value {
					Value::String(value) => Some(value.as_str()),
					Value::Object(value) => value.get("source").and_then(Value::as_str),
					_ => None,
				})
				.ok_or_else(|| {
					PresentationAuthorityError::Owner(sf!("notify effect requires message text"))
				})?;
			ui_effect::Kind::Notify(Notify {
				message:     message.to_owned(),
				level:       string("level").unwrap_or("info").to_owned(),
				duration_ms: None,
			})
		},
		"bell" => ui_effect::Kind::Bell(Bell {}),
		_ => {
			return Err(PresentationAuthorityError::Owner(sf!(
				"presentation effect `{}` is not supported by the chat renderer",
				effect.kind
			)));
		},
	};
	Ok(UiEffect { kind: Some(kind), props: None })
}

/// Lowers one extension presentation request for a renderer client.
pub fn lower_presentation_request(
	owner_invocation: u64,
	request: &presentation_authority::PresentationRequest,
) -> Option<UiRequest> {
	use presentation_authority::PresentationRequest;
	let kind = match request {
		PresentationRequest::EditorText => ui_request::Kind::ComposerText(ComposerText {}),
		PresentationRequest::Dialog { kind, fields } => {
			let title = fields
				.get("title")
				.and_then(Value::as_str)
				.unwrap_or(kind.as_str())
				.to_owned();
			let content = fields
				.get("message")
				.or_else(|| fields.get("content"))
				.and_then(|value| presentation_tml(Some(value)));
			let choices = fields
				.get("items")
				.or_else(|| fields.get("choices"))
				.and_then(Value::as_array)
				.into_iter()
				.flatten()
				.filter_map(|choice| {
					choice
						.as_str()
						.or_else(|| choice.get("label").and_then(Value::as_str))
						.map(str::to_owned)
				})
				.collect();
			ui_request::Kind::Dialog(Dialog {
				kind: kind.to_string(),
				title,
				content,
				choices,
				props: Some(presentation_value_map(fields)),
			})
		},
		PresentationRequest::Overlay { fields } => ui_request::Kind::ShowOverlay(ShowOverlay {
			kind:    fields
				.get("kind")
				.and_then(Value::as_str)
				.unwrap_or("tml")
				.to_owned(),
			content: fields
				.get("content")
				.and_then(|value| presentation_tml(Some(value))),
			options: fields
				.get("options")
				.and_then(Value::as_object)
				.map(presentation_value_map),
			props:   Some(presentation_value_map(fields)),
		}),
		PresentationRequest::OverlayValues { id }
		| PresentationRequest::OverlayWait { id }
		| PresentationRequest::OverlayEvents { id } => ui_request::Kind::OverlayValues(OverlayValues {
			overlay_id: id.to_string(),
			values:     Vec::new(),
		}),
		PresentationRequest::OverlayClose { id } => {
			ui_request::Kind::CloseOverlay(CloseOverlay { overlay_id: id.to_string() })
		},
		_ => return None,
	};
	Some(UiRequest { owner_invocation, kind: Some(kind), props: None })
}

/// Converts a renderer response into the fixed extension presentation shape.
pub fn lower_presentation_response(
	request: presentation_authority::PresentationRequest,
	response: UiResponse,
) -> Result<
	presentation_authority::PresentationResponse,
	presentation_authority::PresentationAuthorityError,
> {
	use presentation_authority::{
		PresentationAuthorityError, PresentationRequest, PresentationResponse,
	};
	match (request, response.kind) {
		(PresentationRequest::EditorText, Some(ui_response::Kind::Text(text))) => {
			Ok(PresentationResponse::EditorText(Str::new(text.value)))
		},
		(PresentationRequest::Dialog { .. }, Some(ui_response::Kind::DialogOutcome(outcome)))
		| (
			PresentationRequest::OverlayWait { .. },
			Some(ui_response::Kind::DialogOutcome(outcome)),
		) => {
			let answers = outcome
				.answers
				.as_ref()
				.and_then(value_map_to_json)
				.map(Value::Object);
			let reason = outcome
				.reason
				.or_else(|| outcome.cancelled.then(|| String::from("dismissed")));
			Ok(PresentationResponse::Dialog(serde_json::json!({
				"accepted": outcome.accepted,
				"value": outcome.value,
				"values": (!outcome.values.is_empty()).then_some(outcome.values),
				"answers": answers,
				"reason": reason,
			})))
		},
		(PresentationRequest::Overlay { .. }, Some(ui_response::Kind::OverlayOpened(opened))) => {
			Ok(PresentationResponse::OverlayOpened { id: Str::new(opened.overlay_id) })
		},
		(PresentationRequest::OverlayValues { .. }, Some(ui_response::Kind::Values(values))) => {
			Ok(PresentationResponse::OverlayValues(
				values
					.values
					.into_iter()
					.enumerate()
					.map(|(index, value)| (index.to_string(), Value::String(value)))
					.collect(),
			))
		},
		(PresentationRequest::OverlayEvents { .. }, Some(ui_response::Kind::Values(values))) => {
			Ok(PresentationResponse::OverlayEvents(
				values.values.into_iter().map(Value::String).collect(),
			))
		},
		(PresentationRequest::OverlayClose { .. }, _) => Ok(PresentationResponse::Ack),
		(_, Some(ui_response::Kind::Error(error))) => {
			Err(PresentationAuthorityError::Owner(Str::new(error.message)))
		},
		_ => Err(PresentationAuthorityError::Owner(sf!(
			"chat renderer returned an incompatible UI response"
		))),
	}
}

fn presentation_text<'a>(body: &'a serde_json::Map<String, Value>, name: &str) -> Option<&'a str> {
	body.get(name).and_then(|value| match value {
		Value::String(value) => Some(value.as_str()),
		Value::Object(value) => value.get("source").and_then(Value::as_str),
		_ => None,
	})
}

fn presentation_notification_urgency(level: &str, urgency: Option<&str>) -> Urgency {
	let value = urgency.unwrap_or(level);
	if value.eq_ignore_ascii_case("critical") || value.eq_ignore_ascii_case("error") {
		Urgency::Critical
	} else if value.eq_ignore_ascii_case("low") || value.eq_ignore_ascii_case("debug") {
		Urgency::Low
	} else {
		Urgency::Normal
	}
}

fn presentation_notification_sound(sound: Option<&str>) -> Option<NotificationSound> {
	let sound = sound?;
	if sound.eq_ignore_ascii_case("silent") {
		Some(NotificationSound::Silent)
	} else if sound.eq_ignore_ascii_case("info") {
		Some(NotificationSound::Info)
	} else if sound.eq_ignore_ascii_case("warning") {
		Some(NotificationSound::Warning)
	} else if sound.eq_ignore_ascii_case("error") {
		Some(NotificationSound::Error)
	} else if sound.eq_ignore_ascii_case("question") {
		Some(NotificationSound::Question)
	} else {
		Some(NotificationSound::System)
	}
}

fn presentation_progress(body: &serde_json::Map<String, Value>) -> omp_tui::Progress {
	let state = body.get("state").and_then(Value::as_object);
	let kind = state
		.and_then(|state| state.get("kind"))
		.and_then(Value::as_str)
		.unwrap_or("clear");
	let pct = state
		.and_then(|state| state.get("pct"))
		.and_then(Value::as_u64)
		.and_then(|pct| u8::try_from(pct.min(100)).ok())
		.unwrap_or_default();
	if kind == "value" {
		omp_tui::Progress::Value(pct)
	} else if kind == "error" {
		omp_tui::Progress::Error(pct)
	} else if kind == "indeterminate" {
		omp_tui::Progress::Indeterminate
	} else if kind == "paused" {
		omp_tui::Progress::Paused(pct)
	} else {
		omp_tui::Progress::Clear
	}
}

fn presentation_image_bytes(source: &Value) -> Option<Vec<u8>> {
	match source {
		Value::String(path) => {
			let path = path.strip_prefix("file://").unwrap_or(path);
			fs::read(path).ok()
		},
		Value::Array(bytes) => bytes
			.iter()
			.map(Value::as_u64)
			.map(|byte| byte.and_then(|byte| u8::try_from(byte).ok()))
			.collect(),
		Value::Object(source) => source
			.get("path")
			.or_else(|| source.get("value"))
			.and_then(Value::as_str)
			.and_then(|path| fs::read(path.strip_prefix("file://").unwrap_or(path)).ok()),
		_ => None,
	}
}

fn presentation_color(color: omp_tui::Color) -> String {
	match color {
		omp_tui::Color::Default => String::from("default"),
		omp_tui::Color::Indexed(index) => format!("index:{index}"),
		omp_tui::Color::Rgb(red, green, blue) => format!("#{red:02x}{green:02x}{blue:02x}"),
	}
}

fn presentation_palette(theme: omp_tui::Theme) -> Value {
	serde_json::json!({
		"fg": presentation_color(theme.fg),
		"accent": presentation_color(theme.accent),
		"info": presentation_color(theme.info),
		"ok": presentation_color(theme.ok),
		"warn": presentation_color(theme.warn),
		"err": presentation_color(theme.err),
		"muted": presentation_color(theme.muted),
		"border": presentation_color(theme.border),
		"surface": presentation_color(theme.surface),
		"hover": presentation_color(theme.hover),
		"selection": presentation_color(theme.selection),
		"shadow": presentation_color(theme.shadow),
		"panel": presentation_color(theme.panel),
		"secondary": presentation_color(theme.secondary),
		"contrast": presentation_color(theme.contrast),
	})
}

/// Projects the live winning command registry into the extension roster
/// contract.
pub fn command_roster_response(roster: &commands::CommandRoster) -> Value {
	let commands = roster
		.roster_entries()
		.into_iter()
		.map(|command| {
			serde_json::json!({
				"name": command.name.as_str(),
				"aliases": command.aliases.iter().map(Str::as_str).collect::<Vec<_>>(),
				"description": command.description.as_str(),
				"source": command.source.as_str(),
			})
		})
		.collect::<Vec<_>>();
	serde_json::json!({ "commands": commands })
}

#[cfg(unix)]
fn presentation_dimensions() -> (u16, u16) {
	use std::os::fd::AsRawFd as _;

	let Ok(tty) = fs::File::open("/dev/tty") else {
		return (0, 0);
	};
	let mut dimensions = std::mem::MaybeUninit::<libc::winsize>::zeroed();
	// SAFETY: TIOCGWINSZ initializes the fixed winsize output for a valid tty fd.
	let status = unsafe { libc::ioctl(tty.as_raw_fd(), libc::TIOCGWINSZ, dimensions.as_mut_ptr()) };
	if status != 0 {
		return (0, 0);
	}
	// SAFETY: successful TIOCGWINSZ initialized the output structure.
	let dimensions = unsafe { dimensions.assume_init() };
	(dimensions.ws_col, dimensions.ws_row)
}

#[cfg(not(unix))]
fn presentation_dimensions() -> (u16, u16) {
	let width = env::var("COLUMNS")
		.ok()
		.and_then(|value| value.parse().ok())
		.unwrap_or_default();
	let height = env::var("LINES")
		.ok()
		.and_then(|value| value.parse().ok())
		.unwrap_or_default();
	(width, height)
}

fn handle_presentation_dispatch(
	endpoint: &presentation::PresentationEndpoint,
	dispatch: presentation::PresentationDispatch,
	backend: &flume::Sender<BackendEvent>,
	state: &mut BridgeState,
	data_dir: &Path,
	settings_manager: &SettingsManager,
) {
	use presentation::PresentationOperation;
	use presentation_authority::{
		PresentationAuthorityError, PresentationRequest, PresentationResponse,
	};

	if let presentation::PresentationOperation::Request(request) = &dispatch.operation
		&& let Some(request_wire) = lower_presentation_request(dispatch.id, request)
	{
		let correlation = Str::from(dispatch.id.to_string());
		state
			.presentation_requests
			.insert(correlation.clone(), (dispatch.id, request.clone()));
		send_backend(backend, BackendEvent::UiRequest { correlation, request: request_wire });
		return;
	}

	let result = match dispatch.operation {
		PresentationOperation::SessionTransition(session) => {
			send_backend(backend, BackendEvent::SessionResumeRequested(session));
			Ok(PresentationResponse::Ack)
		},
		PresentationOperation::Effect { identity, effect } => {
			let result = match effect.kind.as_str() {
				"notify" => (|| -> Result<(), PresentationAuthorityError> {
					let message = presentation_text(&effect.body, "message")
						.or_else(|| presentation_text(&effect.body, "text"))
						.ok_or_else(|| {
							PresentationAuthorityError::Owner(Str::new_static(
								"notify effect requires message text",
							))
						})?;
					let level = effect
						.body
						.get("level")
						.and_then(Value::as_str)
						.unwrap_or("info");
					if level.eq_ignore_ascii_case("error") {
						send_backend(backend, BackendEvent::Error(Str::new(message)));
					} else if level.eq_ignore_ascii_case("warn") {
						send_backend(backend, BackendEvent::Notice(sf!("[warning] {message}")));
					} else if level.eq_ignore_ascii_case("debug") {
						send_backend(backend, BackendEvent::Notice(sf!("[debug] {message}")));
					} else {
						send_backend(backend, BackendEvent::Notice(Str::new(message)));
					}
					let desktop = effect
						.body
						.get("desktop")
						.and_then(Value::as_bool)
						.unwrap_or(false);
					let sound =
						presentation_notification_sound(effect.body.get("sound").and_then(Value::as_str));
					if desktop {
						let mut notification = Notification::default();
						notification.title = effect
							.body
							.get("title")
							.and_then(Value::as_str)
							.map(Str::new);
						notification.body = Some(Str::new(message));
						notification.id = Some(Str::from(presentation_key(identity.as_ref(), "notify")));
						notification.urgency = Some(presentation_notification_urgency(
							level,
							effect.body.get("urgency").and_then(Value::as_str),
						));
						notification.sound = sound;
						send_backend(backend, BackendEvent::TerminalNotification(notification));
					} else if sound.is_some_and(|sound| sound != NotificationSound::Silent) {
						send_backend(
							backend,
							BackendEvent::ApplyUiEffect(UiEffect {
								kind:  Some(ui_effect::Kind::Bell(Bell {})),
								props: None,
							}),
						);
					}
					Ok(())
				})(),
				"set_title" => effect
					.body
					.get("title")
					.or_else(|| effect.body.get("text"))
					.and_then(Value::as_str)
					.map(|title| send_backend(backend, BackendEvent::SessionTitle(Str::new(title))))
					.ok_or_else(|| {
						PresentationAuthorityError::Owner(Str::new_static(
							"set_title effect requires title text",
						))
					}),
				"set_working_indicator" => {
					let frames = effect
						.body
						.get("frames")
						.and_then(Value::as_array)
						.into_iter()
						.flatten()
						.filter_map(Value::as_str)
						.map(Str::new)
						.collect::<Vec<_>>()
						.into_boxed_slice();
					let interval_ms = effect
						.body
						.get("interval_ms")
						.and_then(Value::as_u64)
						.unwrap_or(80);
					send_backend(
						backend,
						BackendEvent::WorkingIndicator(omp_chat_ui::WorkingIndicator {
							frames,
							interval_ms,
						}),
					);
					Ok(())
				},
				"set_progress" => {
					send_backend(
						backend,
						BackendEvent::TerminalProgress(presentation_progress(&effect.body)),
					);
					lower_presentation_effect(identity.as_ref(), &effect)
						.map(|effect| send_backend(backend, BackendEvent::ApplyUiEffect(effect)))
				},
				"set_editor_text" => presentation_text(&effect.body, "text")
					.map(|text| {
						send_backend(backend, BackendEvent::ComposerReplaced(Str::new(text)));
					})
					.ok_or_else(|| {
						PresentationAuthorityError::Owner(Str::new_static(
							"set_editor_text effect requires text",
						))
					}),
				"paste_to_editor" => presentation_text(&effect.body, "content")
					.map(|content| {
						send_backend(backend, BackendEvent::ComposerPaste(Str::new(content)));
					})
					.ok_or_else(|| {
						PresentationAuthorityError::Owner(Str::new_static(
							"paste_to_editor effect requires string or TML content",
						))
					}),
				"set_clipboard" => presentation_text(&effect.body, "text")
					.map(|text| {
						send_backend(backend, BackendEvent::CopyToClipboard(Str::new(text)));
					})
					.ok_or_else(|| {
						PresentationAuthorityError::Owner(Str::new_static(
							"set_clipboard effect requires text",
						))
					}),
				"open_url" => presentation_text(&effect.body, "url")
					.map(omp_core::open::open_path)
					.ok_or_else(|| {
						PresentationAuthorityError::Owner(Str::new_static(
							"open_url effect requires URL text",
						))
					}),
				"image" => (|| -> Result<(), PresentationAuthorityError> {
					let resource = presentation_text(&effect.body, "resource").ok_or_else(|| {
						PresentationAuthorityError::Owner(Str::new_static(
							"image effect requires an opaque resource name",
						))
					})?;
					let bytes = effect
						.body
						.get("source")
						.and_then(presentation_image_bytes)
						.ok_or_else(|| {
							PresentationAuthorityError::Owner(Str::new_static(
								"image source is not readable by the chat renderer",
							))
						})?;
					if omp_tui::register_image_source(Str::new(resource), bytes) {
						Ok(())
					} else {
						Err(PresentationAuthorityError::Owner(Str::new_static(
							"image source is not a supported PNG or PPM resource",
						)))
					}
				})(),
				_ => lower_presentation_effect(identity.as_ref(), &effect)
					.map(|effect| send_backend(backend, BackendEvent::ApplyUiEffect(effect))),
			};
			result.map(|()| PresentationResponse::Ack)
		},
		PresentationOperation::Request(request) => match request {
			PresentationRequest::Presentation => {
				let (width, height) = presentation_dimensions();
				let charset = if state.presentation.charset == omp_tui::Charset::Ascii {
					"ascii"
				} else if state.presentation.charset == omp_tui::Charset::NerdFont {
					"nerd"
				} else {
					"unicode"
				};
				let appearance = if state.presentation.appearance == omp_tui::Appearance::Light {
					"light"
				} else {
					"dark"
				};
				let graphics = if state.presentation.graphics == omp_tui::Graphics::Sixel {
					"sixel"
				} else if state.presentation.graphics == omp_tui::Graphics::KittyPlaceholders {
					"kitty_placeholders"
				} else if state.presentation.graphics == omp_tui::Graphics::KittyDirect {
					"kitty_direct"
				} else if state.presentation.graphics == omp_tui::Graphics::Iterm2 {
					"iterm2"
				} else {
					"cells"
				};
				Ok(PresentationResponse::Presentation(serde_json::json!({
					"charset": charset,
					"appearance": appearance,
					"width": width,
					"height": height,
					"graphics": graphics,
					"hyperlinks": state.hyperlinks,
					"has_ui": true,
					"palette": presentation_palette(state.presentation.theme),
				})))
			},
			PresentationRequest::Commands => {
				Ok(PresentationResponse::Presentation(command_roster_response(&state.typed_commands)))
			},
			PresentationRequest::Icons { prefix } => {
				let icons = omp_tui::Icon::from_name(prefix.as_str())
					.map(|icon| vec![Str::new(icon.name())])
					.unwrap_or_default();
				Ok(PresentationResponse::Icons(icons))
			},
			PresentationRequest::Themes => {
				Ok(PresentationResponse::Themes(installed_themes(data_dir)))
			},
			PresentationRequest::SetAppearance { theme, persist } => {
				apply_extension_theme(backend, data_dir, settings_manager, state, theme, persist)
					.map(|()| PresentationResponse::Ack)
					.map_err(|error| PresentationAuthorityError::Owner(Str::new(error.to_string())))
			},
			PresentationRequest::ToolsExpanded => {
				Ok(PresentationResponse::ToolsExpanded(state.tools_expanded))
			},
			PresentationRequest::SetToolsExpanded { expanded } => {
				state.tools_expanded = expanded;
				send_backend(backend, BackendEvent::ToolsExpanded(expanded));
				Ok(PresentationResponse::Ack)
			},
			PresentationRequest::SetHiddenThinkingLabel { label } => {
				state.hidden_thinking_label.clone_from(&label);
				send_backend(backend, BackendEvent::HiddenThinkingLabel(label));
				Ok(PresentationResponse::Ack)
			},
			PresentationRequest::DynamicMount { .. } => Ok(PresentationResponse::Ack),
			other => Err(PresentationAuthorityError::Owner(sf!(
				"presentation request `{other:?}` requires a renderer surface not installed in chat",
			))),
		},
	};
	let _ = endpoint.complete(dispatch.id, result);
}

fn subscribe_chat_events(bus: &omp_agent::EventBus) -> omp_agent::EventSubscription {
	bus.subscribe_lossless()
}

fn replica_items(path: &Path, registry: &Registry) -> miette::Result<Vec<Item>> {
	let log = omp_storage::transcript::load(path).into_diagnostic()?;
	let mut live = transcript::LiveSet::new();
	log.live_into(&mut live);
	Ok(omp_agent::project_journal(&log, &live, registry, &omp_driver::chat::CHAT_CAPS_BASE)
		.into_diagnostic()?
		.items)
}

async fn next_replica_update(
	updates: &mut Option<Receiver<omp_collab::guest::GuestReplicaProjection>>,
) -> Option<omp_collab::guest::GuestReplicaProjection> {
	let updates = updates.as_mut()?;
	updates.changed().await.ok()?;
	let projection = updates.borrow_and_update().clone();
	Some(projection)
}

async fn next_host_operation(
	operations: &mut Option<omp_driver::collab::session::HostOperationReceiver>,
) -> omp_driver::collab::session::HostOperation {
	if let Some(operations) = operations.as_ref()
		&& let Ok(operation) = operations.recv().await
	{
		return operation;
	}
	*operations = None;
	pending().await
}

async fn next_presence_update(
	presence: &mut Option<Receiver<Option<omp_collab::presence::PresenceFacts>>>,
) -> Option<Option<omp_collab::presence::PresenceFacts>> {
	let presence = presence.as_mut()?;
	presence.changed().await.ok()?;
	let facts = *presence.borrow_and_update();
	Some(facts)
}

fn structural_roster(
	sources: &[Vec<CommandContribution>],
	security_enabled: bool,
	extension_generations: impl IntoIterator<Item = commands::CommandGeneration>,
) -> commands::CommandRoster {
	let generations = sources
		.iter()
		.flatten()
		.filter(|command| security_enabled || command.name != "security")
		.filter_map(|command| {
			let template = command.template.clone()?;
			let kind = if command.origin.to_ascii_lowercase().contains("extension") {
				commands::CommandSourceKind::Extension
			} else if command.origin.to_ascii_lowercase().contains("bundled") {
				commands::CommandSourceKind::Markdown
			} else {
				commands::CommandSourceKind::Custom
			};
			let provenance = commands::CommandProvenance {
				source: sf!("{}:{}", command.origin, command.name),
				label: command.origin.clone(),
				kind,
				generation: 1,
			};
			let declaration = commands::CommandDeclaration {
				order:           0,
				name:            command.name.clone(),
				icon:            omp_tui::Icon::SlashCommand,
				aliases:         command.aliases.iter().cloned().collect::<Vec<_>>().into(),
				description:     command.description.clone(),
				argument_hint:   command.hint.clone(),
				hints:           Arc::from([]),
				capabilities:    Arc::from([]),
				surfaces:        Arc::from([
					CommandSurface::Tui,
					CommandSurface::Acp,
					CommandSurface::Text,
				]),
				guest_visible:   false,
				acp_description: None,
				provenance:      provenance.clone(),
				implementation:  commands::CommandImplementation::Prompt(template),
			};
			Some(commands::CommandGeneration { provenance, declarations: Arc::from([declaration]) })
		})
		.collect::<Vec<_>>();
	let generations = generations.into_iter().chain(extension_generations);
	commands::CommandRoster::with_contributions_filtered(
		generations,
		&commands::ShadowPolicy::default(),
		|declaration| declaration.name != "security" || security_enabled,
	)
}
fn command_role(collab: Option<&CollabCommandHandle>) -> CommandRole {
	if collab
		.and_then(CollabCommandHandle::presence)
		.is_some_and(|presence| presence.role() == CollabRole::Guest)
	{
		CommandRole::Guest
	} else {
		CommandRole::Owner
	}
}
struct ChatSceneSeed {
	typed_commands:   commands::CommandRoster,
	extension_ui:     Arc<presentation::PublishedUiRoster>,
	session:          Str,
	command_usage:    Arc<CommandUsage>,
	browser_settings: BrowserSettings,
	skills:           Arc<omp_driver::skills::SkillSnapshot>,
	role:             CommandRole,
	workspace_root:   PathBuf,
	composer_style:   components::ComposerStyle,
	spelling:         omp_tui::SpellingFeatures,
	smooth_streaming: bool,
	hide_thinking:    bool,
}

/// Loads effective keybindings, returning host input bindings plus the
/// resolved dequeue chord label for pending queued-row hints.
fn load_input_actions(
	data_dir: &Path,
	extension_ui: &presentation::PublishedUiRoster,
) -> miette::Result<(Vec<InputBinding>, Option<Str>)> {
	let imported = crate::keybindings::config::import_legacy(data_dir)
		.map_err(|error| miette::miette!("{error}"))?;
	let native = data_dir.join("keybindings.toml");
	let loaded = match imported {
		Some(imported) => Some(imported),
		None if native.is_file() => Some(
			crate::keybindings::config::load(&native).map_err(|error| miette::miette!("{error}"))?,
		),
		None => None,
	};
	let resolved = loaded
		.map(|loaded| loaded.config.resolve(None))
		.transpose()
		.map_err(|error| miette::miette!("{error}"))?
		.unwrap_or_default();
	if !resolved.conflicts.is_empty() {
		let conflicts = resolved
			.conflicts
			.iter()
			.map(|conflict| {
				format!(
					"{} ({})",
					conflict.chord,
					conflict
						.actions
						.iter()
						.map(Str::as_str)
						.collect::<Vec<_>>()
						.join(", ")
				)
			})
			.collect::<Vec<_>>()
			.join("; ");
		return Err(miette::miette!("conflicting keybindings: {conflicts}"));
	}
	let platform = crate::keybindings::KeyPlatform::current();
	let dequeue_hint = resolved
		.chords_for("app.message.dequeue", platform)
		.next()
		.and_then(|chord| crate::keybindings::format_chord_label(chord, platform).ok());
	let mut actions = crate::keybindings::config::APP_ACTION_IDS
		.iter()
		.filter_map(|action| {
			InputAction::from_action_id(action).map(|projected| {
				resolved
					.chords_for(action, platform)
					.filter_map(move |chord| InputBinding::parse(chord, projected.clone()))
			})
		})
		.flatten()
		.collect::<Vec<_>>();
	let shortcuts = crate::keybindings::ExtensionShortcutRoster::install_verified(
		&extension_ui.shortcuts(),
		&resolved,
		platform,
	)
	.map_err(|error| miette::miette!("{error}"))?;
	actions.extend(shortcuts.bindings().filter_map(|binding| {
		InputBinding::parse(
			binding.chord.as_str(),
			InputAction::ExtensionShortcut(binding.chord.clone()),
		)
	}));
	Ok((actions, dequeue_hint))
}

fn current_browser_settings(manager: &SettingsManager) -> BrowserSettings {
	let settings = manager
		.snapshot()
		.project::<BrowserSettings>()
		.expect("settings manager holds a validated browser projection");
	*settings.get()
}

fn command_completions(
	roster: &commands::CommandRoster,
	role: CommandRole,
	settings: &BrowserSettings,
) -> Vec<Command> {
	roster.completions_for_described(role, |declaration| {
		(declaration.name.as_str() == "browser")
			.then(|| Str::new_static(commands::browser::autocomplete_description(settings)))
	})
}

fn chat_scene(seed: &ChatSceneSeed, ctx: &UiContext) -> Chat {
	let mut chat = Chat::new(ctx);
	let accent_keywords: Arc<[Str]> = omp_agent::prompt_assets::PROMPT_KEYWORDS
		.iter()
		.map(|keyword| Str::from(keyword.text))
		.collect();
	chat.set_keyword_accent(KeywordAccent::from_shared(accent_keywords));
	let mut commands = command_completions(&seed.typed_commands, seed.role, &seed.browser_settings);
	commands.extend(seed.skills.all().iter().map(|skill| {
		let name = format!("skill:{}", skill.name);
		Command::new(&name, skill.description.as_str(), &[]).with_icon(Icon::Skill)
	}));
	let command_usage = Arc::clone(&seed.command_usage);
	chat.set_ranked_slash_commands(commands, move |name| command_usage.count(name));
	chat.set_completion(Box::new(seed.extension_ui.completion_adapter(
		seed.session.clone(),
		[
			CompletionRule::native("@", CompletionTrigger::Mention),
			CompletionRule::native("#", CompletionTrigger::Hash),
			CompletionRule::native(":", CompletionTrigger::Custom),
		],
		Arc::new(ProjectCompletionSource::scan(&seed.workspace_root)),
	)));
	chat.set_composer_style(seed.composer_style);
	chat.set_spelling_features(seed.spelling);
	chat.set_smooth_streaming(seed.smooth_streaming);
	chat.set_hide_thinking(seed.hide_thinking);
	chat
}

pub async fn run<C, R>(
	mut agent: Agent<C>,
	environment_host: &omp_envd::ProjectEnvironment,
	session: ChatUiSession,
	advisor: Option<Arc<Mutex<AdvisorEngine>>>,
	advisor_notices: flume::Receiver<Option<Str>>,
	catalog: Arc<Catalog>,
	registry: Arc<Registry>,
	tree: Arc<AgentTree>,
	parent: Arc<ChatParentHost<C>>,
	collab: Option<CollabCommandHandle>,
	collab_live: Option<omp_driver::collab::session::HostLiveHandle>,
	mut collab_operations: Option<omp_driver::collab::session::HostOperationReceiver>,
	collab_state: Option<omp_proto::collab::v1::SessionStateUpdate>,
	modes: Arc<RegimeHandle>,
	auth: Option<ChatAuth>,
	auth_control: Option<omp_inference::auth::AuthControlHandle>,
	data_dir: PathBuf,
	settings_manager: Arc<SettingsManager>,
	prompt_discovery_settings: omp_driver::discovery::PromptDiscoverySettings,
	telemetry_index: Arc<omp_storage::telemetry_index::TelemetryIndex>,
	session_index: Arc<SessionIndex>,
	workspace_root: PathBuf,
	local_root: PathBuf,
	security_enabled: bool,
	title_enabled: bool,
	resize_scrollback: omp_chat_ui::host::ResizeScrollback,
	command_sources: Vec<Vec<CommandContribution>>,
	skills: Arc<omp_driver::skills::SkillSnapshot>,
	extension_declarations: Arc<[omp_driver::discovery::manifest::DiscoveredCapability]>,
	mut approval_inbox: Option<ApprovalInbox>,
	hide_thinking: bool,
	mut list_sessions: R,
	welcome: bool,
	initial_draft: Str,
	initial_submission: Option<Item>,
	extension_ui: Arc<presentation::PublishedUiRoster>,
	extension_callbacks: Arc<dyn omp_envd::exthost::dispatch::CallbackDispatcher>,
	presentation: ChatPresentation,
	presentation_endpoint: Option<presentation::PresentationEndpoint>,
) -> miette::Result<omp_chat_ui::host::HostOutcome>
where
	C: TurnClient + Clone + Send + 'static,
	R: FnMut() -> miette::Result<Vec<ResumeChoice>> + Send + 'static,
{
	let renderers = Arc::new(
		omp_tools::live_renderers(registry.as_ref()).map_err(|error| miette::miette!(error))?,
	);
	let bus = agent.events().clone();
	let task_settings = settings_manager
		.snapshot()
		.project::<TaskSettings>()
		.into_diagnostic()?
		.shared();
	parent.apply_task_settings(task_settings);
	let mut task_settings_updates =
		DomainSubscription::<TaskSettings>::new(settings_manager.as_ref());
	let task_settings_parent = Arc::downgrade(&parent);
	let task_settings_watch = tokio::spawn(async move {
		while let Ok(settings) = task_settings_updates.recv_async().await {
			let Some(parent) = task_settings_parent.upgrade() else {
				break;
			};
			parent.apply_task_settings(settings.shared());
		}
	});
	let environment = agent.environment();
	let mailbox = agent.mailbox();
	let control = agent.control();
	let mut replica_updates = collab
		.as_ref()
		.and_then(CollabCommandHandle::guest_replica)
		.map(|replica| replica.subscribe());
	let mut collab_presence = collab.as_ref().map(CollabCommandHandle::subscribe_presence);
	let local_session_path = session.journal_path.clone();
	let sessions_dir = local_session_path
		.parent()
		.ok_or_else(|| miette::miette!("active session path has no storage directory"))?
		.to_path_buf();
	let mut session_restore = GuestSessionRestore::default();
	let mut guest_projected = false;
	// Turn deltas and their authoritative outcome share this stream. Dropping
	// either can leave a blank or permanently partial transcript.
	let agent_events = subscribe_chat_events(&bus);
	let live_events = agent
		.firehose()
		.subscribe(
			SubscriptionOptions::new(
				[
					FirehoseKind::TurnStart,
					FirehoseKind::TurnEnd,
					FirehoseKind::ModelRequest,
					FirehoseKind::ModelAttempt,
					FirehoseKind::ProviderError,
					FirehoseKind::ToolCall,
				],
				128,
			)
			.into_diagnostic()?,
		)
		.into_diagnostic()?;
	let session_id = session.session_id.clone();
	let mut roster_events = tree.watch_roster();
	let period = Duration::from_millis(100);
	let mut roster_tick = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
	roster_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
	let agent_state = agent.state().clone();
	let abort = agent.abort_handle();
	let startup_pending = startup_recovery_needed(
		agent.journal().pending_turn().is_some(),
		agent.journal().pending_input_submission().is_some(),
	) || initial_submission.is_some();
	modes.sync_regimes(agent.arbiter().regimes());

	let submission_state = agent.state().clone();
	let regime_projection = modes.clone();
	let session_hooks = environment_host.admission_gate();
	let (ui_tx, ui_rx) = flume::bounded::<UiCmd>(1);
	let (ack_tx, ack_rx) = flume::bounded::<SubmitAck>(1);
	let resumed_pending_jobs: Vec<Str> = agent
		.journal()
		.pending_jobs()
		.map(|job| job.id.clone())
		.collect();
	let (maintenance_tx, maintenance_rx) = flume::unbounded::<MaintenanceEvent>();
	let maintenance_registry = Arc::clone(&registry);
	let session_delete_index = Arc::clone(&session_index);
	let agent_future = async move {
		if startup_pending {
			let turn_id = TurnId::new(omp_core::Ulid::generate().to_string());
			let ack = match agent.submit(Vec::new(), turn_id).await {
				Ok(summary) => SubmitAck {
					interrupted:     summary.interrupted,
					committed_turns: summary.committed_turns,
				},
				// Failure presentation settles off the `AgentEvent::Failed` bus
				// event; a caller-side notice would duplicate it.
				Err(_) => SubmitAck { interrupted: false, committed_turns: 0 },
			};
			let _ = ack_tx.send(ack);
		}
		while let Ok(command) = ui_rx.recv_async().await {
			match command {
				UiCmd::Submit { item, budget } => {
					apply_turn_budget(&submission_state, budget.as_ref());
					let turn_id = TurnId::new(omp_core::Ulid::generate().to_string());
					let ack = match agent.submit([*item], turn_id).await {
						Ok(summary) => SubmitAck {
							interrupted:     summary.interrupted,
							committed_turns: summary.committed_turns,
						},
						// Failure presentation settles off the `AgentEvent::Failed`
						// bus event; a caller-side notice would duplicate it.
						Err(_) => SubmitAck { interrupted: false, committed_turns: 0 },
					};
					apply_turn_budget(&submission_state, None);
					let _ = ack_tx.send(ack);
				},
				UiCmd::ListRewind { reply } => {
					let result = agent.rewind_targets().map_err(|error| error.to_string());
					let _ = reply.send(result);
				},
				UiCmd::TodoEdited { phases, reply } => {
					let result = agent
						.append_todo_edit(&phases)
						.map(|_| ())
						.map_err(|error| error.to_string());
					let _ = reply.send(result);
				},
				UiCmd::Rewind { to, reply } => {
					let result = match agent.rewind_targets() {
						Ok(targets) => {
							let dropped_items = targets
								.iter()
								.filter(|target| to.is_none_or(|keep| target.event > keep))
								.count();
							match crate::chat_cmd::gate_session_rewind(
								session_hooks.as_ref(),
								to,
								&targets,
								dropped_items,
							)
							.await
							{
								Ok(false) => match agent.rewind(to) {
									Ok(items) => {
										if let Err(error) = agent.reconcile_history_rewrite().await {
											tracing::warn!(%error, "history-rewrite reconciliation failed");
										}
										Ok(items)
									},
									Err(error) => Err(error.to_string()),
								},
								Ok(true) => Err(String::from(
									"workspace restore is unavailable for this rewind backend",
								)),
								Err(reason) => Err(format!("rewind denied: {reason}")),
							}
						},
						Err(error) => Err(error.to_string()),
					};
					let _ = reply.send(result);
				},
				UiCmd::Retry { reply } => {
					let turn_id = TurnId::new(format!("retry-{}", omp_core::Ulid::generate()));
					let result = agent
						.retry_last_turn(turn_id)
						.await
						.map_err(|error| error.to_string())
						.and_then(|outcome| {
							outcome
								.map(|(items, text, _summary)| (items, text))
								.ok_or_else(|| String::from("no user turn is available to retry"))
						});
					let _ = reply.send(result);
				},
				UiCmd::Compact { request } => {
					let result = agent.compact_manual(request).await;
					let _ = maintenance_tx.send(MaintenanceEvent::Compact(result));
				},
				UiCmd::Shake { mode } => {
					let result = agent.shake_manual(mode).and_then(|outcome| {
						let journal = agent.journal().load()?;
						let projected = omp_agent::project_journal(
							&journal,
							journal.as_ref(),
							maintenance_registry.as_ref(),
							&omp_driver::chat::CHAT_CAPS_BASE,
						)?;
						Ok((outcome, projected.items))
					});
					let _ = maintenance_tx.send(MaintenanceEvent::Shake(result));
				},
				UiCmd::ForceTool { tool } => {
					agent.tool_choices_mut().remove_by_label("user-force");
					agent.tool_choices_mut().push_once(
						omp_inference::call::ToolChoice::Named(tool),
						omp_agent::tool_choice::PushOptions {
							priority: omp_agent::tool_choice::DirectivePriority::Head,
							label: Some(sf!("user-force")),
							..omp_agent::tool_choice::PushOptions::default()
						},
					);
				},
				UiCmd::Handoff { request, reply } => {
					let result = agent
						.compact_manual(request)
						.await
						.map_err(|error| error.to_string());
					let _ = reply.send(result);
				},
				UiCmd::CreateSessionChild { kind, child_id, child_path, title, reply } => {
					let result = (|| -> Result<u64, String> {
						let parent_id = agent.journal().session_id().clone();
						let root = {
							let journal = agent.journal().load().map_err(|error| error.to_string())?;
							journal.header().cwd.clone()
						};
						let _sessions_dir = child_path
							.parent()
							.ok_or_else(|| String::from("child session path has no parent"))?;
						let index = Arc::clone(&session_delete_index);
						let session_id = SessionId(child_id);
						let created_ms = now_ms();
						let root_text = root.to_string_lossy();
						let request = NewSession {
							id: &session_id,
							cwd: root_text.as_ref(),
							project: root_text.as_ref(),
							created_ms,
							kind: SessionKind::Interactive,
							parent: Some(&parent_id),
							remote: false,
						};
						let header = transcript::Header {
							v:       4,
							id:      session_id.clone(),
							created: created_ms,
							cwd:     root.clone(),
						};
						let mut child = index
							.create_session(&request, || {
								let child =
									agent
										.journal()
										.create_child(&child_path, &header, created_ms, kind)?;
								let watermark = child.byte_watermark()?;
								Ok::<_, omp_agent::JournalError>((child, watermark))
							})
							.map_err(|error| error.to_string())?;
						child.attach_session_index(index, session_id);
						if let Some(title) = title {
							child
								.append_title(created_ms, title, transcript::TitleSource::User)
								.map_err(|error| error.to_string())?;
						}
						let head = child
							.load()
							.map_err(|error| error.to_string())?
							.len()
							.saturating_sub(1) as u64;
						Ok(head)
					})();
					let _ = reply.send(result);
				},
				UiCmd::DeleteCurrentSession { path, reply } => {
					let session_id = agent.journal().session_id().clone();
					let matches = path
						.file_stem()
						.and_then(|stem| stem.to_str())
						.is_some_and(|stem| stem == session_id.0.as_str());
					if !matches {
						let _ = reply.send(Err(String::from(
							"refusing to delete a path that is not the live session",
						)));
						continue;
					}
					drop(agent);
					let tombstone =
						path.with_extension(format!("jsonl.deleted-{}", omp_core::Ulid::generate()));
					let result = (|| -> Result<(), String> {
						fs::rename(&path, &tombstone).map_err(|error| error.to_string())?;
						match session_delete_index.delete_session(&session_id) {
							Ok(true) => {},
							Ok(false) => {
								let _ = fs::rename(&tombstone, &path);
								return Err(String::from(
									"session index no longer contains the live session",
								));
							},
							Err(error) => {
								let _ = fs::rename(&tombstone, &path);
								return Err(error.to_string());
							},
						}
						if let Err(error) = fs::remove_file(&tombstone) {
							tracing::warn!(
								path = %tombstone.display(),
								%error,
								"deleted session tombstone cleanup failed"
							);
						}
						Ok(())
					})();
					let _ = reply.send(result);
					break;
				},
				UiCmd::Regime { operation, reply } => {
					let result = match operation {
						RegimeOperation::Start { id, queue, prompt_slot } => {
							let (mut spec, machine) = omp_agent::core_regime(id)
								.expect("built-in slash command names a core regime");
							if let Some(prompt_slot) = prompt_slot {
								Arc::make_mut(&mut spec).sets = Arc::from([omp_agent::ScopedSetting {
									slot:  omp_agent::SettingSlot::PromptSlot,
									value: Str::new_static(prompt_slot),
								}]);
							}
							agent
								.start_regime(spec, machine, omp_agent::StartOptions {
									now_ms: now_ms(),
									queue,
								})
								.map(RegimeMutation::Started)
						},
						RegimeOperation::Stop { activation } => agent
							.stop_regime(activation.as_str(), now_ms())
							.map(RegimeMutation::Stopped),
					};
					regime_projection.sync_regimes(agent.arbiter().regimes());
					let _ = reply.send(result);
				},
			}
		}
	};
	let mut agent_task = tokio::spawn(agent_future);

	let caps = detect();
	let ctx = terminal_ui_context(&caps);
	let typed_commands = structural_roster(
		&command_sources,
		security_enabled,
		extension_ui.command_generations(&session_id),
	);
	let chat_commands = typed_commands.clone();
	let commands = CommandRoster::new(command_sources.clone());
	let command_usage = Arc::new(CommandUsage::load(Arc::clone(&session_index)).into_diagnostic()?);
	let initial_command_role = command_role(collab.as_ref());
	let (backend_tx, backend_rx) = flume::unbounded();
	let (intent_tx, intent_rx) = flume::unbounded();
	let snapshot = agent_state.snapshot();
	let model = snapshot.turn.params.model.clone();
	let thinking = snapshot
		.turn
		.params
		.thinking
		.as_ref()
		.and_then(|reasoning| Effort::try_from(reasoning.effort).ok())
		.and_then(status_thinking_level);
	drop(snapshot);
	let settings_home = env::var_os("HOME").map_or_else(|| workspace_root.clone(), PathBuf::from);
	let model_settings = settings_manager
		.snapshot()
		.project::<ModelSettings>()
		.into_diagnostic()?
		.get()
		.resolve_path_scopes(&workspace_root, &settings_home);
	let title_user_set =
		Arc::new(AtomicBool::new(session.title.source == Some(transcript::TitleSource::User)));
	let has_history = !session.initial_items.is_empty() || startup_pending;
	let mut state = BridgeState {
		catalog,
		auth_control: auth_control.clone(),
		model,
		model_settings,
		pending_session_delete: None,
		git: None,
		git_facts: None,
		advisor,
		session_id: session_id.clone(),
		session_path: local_session_path.clone(),
		sessions_dir,
		title: session.title,
		title_generation_in_flight: Arc::new(AtomicBool::new(false)),
		title_user_set,
		title_commit_lock: Arc::new(tokio::sync::Mutex::new(())),
		title_replan_refresh_pending: false,
		local_root,
		regimes: modes.as_ref().clone(),
		regime_revision: modes.revision(),
		collab,
		collab_live,
		collab_state,
		environment,
		session_hooks: environment_host.admission_gate(),
		lsp_servers: Vec::new(),
		memory: omp_driver::memory::chat_memory(&session_id),
		workspace_root: Str::from(workspace_root.to_string_lossy().as_ref()),
		appearance: ctx.appearance,
		presentation: ctx.clone(),
		hyperlinks: caps.hyperlinks,
		theme_watcher: ThemeWatcher::new(),
		theme_revision: 0,
		tools_expanded: true,
		hidden_thinking_label: None,
		deferred: DeferredCommands::new(),
		active_ptys: HashMap::new(),
		context_window: session.context_window,
		context_tokens: 0,
		context_snapshot: None,
		cost_nanos: 0,
		queued: 0,
		queued_prompts: VecDeque::new(),
		audio: crate::audio_coordinator::InteractiveAudioController::new(),
		jobs: HashSet::new(),
		attempt: 0,
		turn_started: startup_pending.then(Instant::now),
		has_history,
		submit_pending: startup_pending,
		pending_prompt: None,
		part_serial: 0,
		active_parts: HashMap::new(),
		active_markdown: HashMap::new(),
		streaming_tools: HashMap::new(),
		tools: HashMap::new(),
		rewind_targets: Vec::new(),
		live_activity: ActivityWaveform::new(),
		token_rate: None,
		tokens_per_second: None,
		thinking,
		pending_auth_kind: None,
		pending_auth_provider: None,
		replaying_turn: false,
		vision_override: None,
		settings: omp_driver::settings::current(&data_dir).into_diagnostic()?,
		prompt_discovery_settings,
		commands,
		command_sources,
		command_usage: Arc::clone(&command_usage),
		typed_commands,
		extension_ui,
		extension_callbacks: Some(extension_callbacks),
		skills: Arc::clone(&skills),
		extension_declarations,
		extension_generation: 1,
		extension_mcp: None,
		extension_live_mcp: HashMap::new(),
		approvals: HashMap::new(),
		presentation_requests: HashMap::new(),
		raw_stream: None,
	};
	let _ = tokio::time::timeout(Duration::from_millis(300), refresh_lsp_roster(&mut state)).await;
	let _ = tokio::time::timeout(Duration::from_millis(300), refresh_git_facts(&mut state)).await;
	if let Err(error) = apply_configured_theme(&backend_tx, &data_dir, &mut state) {
		send_backend(
			&backend_tx,
			BackendEvent::Error(sf!("Could not apply configured theme: {error}")),
		);
		send_backend(
			&backend_tx,
			BackendEvent::ThemePreview(omp_tui::Theme::for_appearance(state.appearance)),
		);
	}
	send_recap_policy(&backend_tx, &state.settings);
	let chat_seed = ChatSceneSeed {
		typed_commands: chat_commands,
		extension_ui: Arc::clone(&state.extension_ui),
		session: state.session_id.clone(),
		command_usage,
		browser_settings: current_browser_settings(settings_manager.as_ref()),
		skills,
		role: initial_command_role,
		workspace_root,
		composer_style: presentation_composer_style(state.settings.composer.shape),
		spelling: omp_tui::SpellingFeatures {
			typo_detection: state.settings.spelling.typo_detection,
			autocomplete:   state.settings.spelling.autocomplete,
			autocorrect:    state.settings.spelling.autocorrect,
		},
		smooth_streaming: state.settings.display.smooth_streaming,
		hide_thinking,
	};

	send_models_updated(&backend_tx, &state);
	if welcome {
		send_backend(
			&backend_tx,
			BackendEvent::WelcomeLspServers(welcome_lsp_servers(&state.lsp_servers)),
		);
		match list_sessions() {
			Ok(choices) => send_backend(&backend_tx, BackendEvent::Sessions(session_rows(choices))),
			Err(error) => {
				send_backend(&backend_tx, BackendEvent::Error(sf!("Could not list sessions: {error}")));
			},
		}
	}
	send_backend(&backend_tx, BackendEvent::WelcomeBanner(welcome_banner(&state)));
	replay_items(
		&backend_tx,
		&session.initial_items,
		&mut state.tools,
		&mut state.part_serial,
		renderers.as_ref(),
	);
	if !session.initial_items.is_empty() {
		match invoke_todo(&state.environment, &omp_tools::todo::Params {
			op:     omp_tools::todo::Op::View,
			list:   None,
			phase:  None,
			item:   None,
			items:  None,
			reason: None,
		})
		.await
		{
			Ok(payload) if !payload.phases.is_empty() => {
				send_backend(&backend_tx, BackendEvent::TodoHud(todo_hud(&payload)));
			},
			Ok(_) => {},
			Err(error) => {
				tracing::warn!(%error, "resumed todo state was not projected to the HUD");
			},
		}
		for id in &resumed_pending_jobs {
			state.jobs.insert(id.clone());
			send_retained_fact(
				&backend_tx,
				"async-job",
				id.as_str(),
				serde_json::json!({"name": id.as_str(), "status": "running"}),
				"Background job is running.",
			);
		}
	}
	if let Some(item) = initial_submission {
		replay_items(
			&backend_tx,
			std::slice::from_ref(&item),
			&mut state.tools,
			&mut state.part_serial,
			renderers.as_ref(),
		);
		ui_tx
			.send_async(UiCmd::Submit { item: Box::new(item), budget: None })
			.await
			.into_diagnostic()?;
	}
	send_status(&backend_tx, &state, &bus, 0);
	let mut last_roster = project_agent_roster(&parent, &tree, &session_id);
	send_backend(&backend_tx, BackendEvent::AgentRoster(last_roster.clone()));
	publish_collaboration_registry(state.collab_live.as_ref(), parent.as_ref(), session_id.as_str());

	let bridge_data_dir = data_dir.clone();
	let mcp_inspector = environment_host.mcp_inspector();
	let extension_reload = environment_host.extension_reload_handle();
	let extension_ui_events = state.extension_ui.subscribe();
	let input_extension_ui = Arc::clone(&state.extension_ui);
	let mut lsp_refresh_deadline =
		lsp_roster_active(&state.lsp_servers).then(|| Instant::now() + Duration::from_secs(60));
	let mut lsp_refresh_tick = tokio::time::interval(Duration::from_secs(2));
	lsp_refresh_tick.tick().await;
	let bridge = async move {
		let mut presentation_endpoint = presentation_endpoint;
		loop {
			tokio::select! {
							_reason = parent.wait_for_shutdown() => {
								abort.abort();
								parent.wait_for_idle().await;
								break;
							},
							Ok(HeadlessLifecycleKind::CommandRosterInvalidated) = extension_ui_events.recv_async() => {
								let security_enabled = state
									.typed_commands
									.command_usage_name("/security")
									.is_some();
								state.typed_commands = structural_roster(
									&state.command_sources,
									security_enabled,
									state.extension_ui.command_generations(&state.session_id),
								);
								let browser_settings = current_browser_settings(settings_manager.as_ref());
								let mut completions = command_completions(
									&state.typed_commands,
									command_role(state.collab.as_ref()),
									&browser_settings,
								);
								completions.extend(state.skills.all().iter().map(|skill| {
									let name = format!("skill:{}", skill.name);
									Command::new(&name, skill.description.as_str(), &[])
										.with_icon(Icon::Skill)
								}));
								send_backend(&backend_tx, BackendEvent::SlashCommands(completions));
							},
							_ = lsp_refresh_tick.tick(), if lsp_refresh_deadline.is_some() => {
								let deadline = lsp_refresh_deadline.expect("guarded by select condition");
								if Instant::now() >= deadline {
									lsp_refresh_deadline = None;
									continue;
								}
								refresh_lsp_roster(&mut state).await;
								send_backend(
									&backend_tx,
									BackendEvent::WelcomeLspServers(welcome_lsp_servers(&state.lsp_servers)),
								);
								if !lsp_roster_active(&state.lsp_servers) {
									lsp_refresh_deadline = None;
								}
							},
							frame = next_raw_stream_frame(&mut state.raw_stream) => {
								let summary = omp_inference::transport::global_provider_capture()
									.snapshot(Some(state.session_id.as_str()))
									.summary;
								send_backend(
									&backend_tx,
									BackendEvent::RawStreamFrame {
										frame: raw_frame(frame),
										summary: stream_summary(summary),
									},
								);
							},
							Some(_event) = next_extension_mcp_event(&mut state.extension_mcp) => {
								let live =
									commands::snapshot_live_mcp(&mcp_inspector);
								let next = live
									.iter()
									.cloned()
									.map(|snapshot| (snapshot.server.clone(), snapshot))
									.collect::<HashMap<_, _>>();
								for (server, previous) in &state.extension_live_mcp {
									if !next.contains_key(server) {
										let mut removed = previous.clone();
										removed.health = omp_chat_ui::McpHealth::Inactive;
										removed.implementation = None;
										removed.version = None;
										removed.title = None;
										removed.description = None;
										removed.instructions = None;
										removed.tools.clear();
										removed.resources.clear();
										removed.prompts.clear();
										send_backend(
											&backend_tx,
											BackendEvent::ExtensionMcpUpdated(removed),
										);
									}
								}
								state.extension_live_mcp = next;
								for snapshot in live {
									send_backend(
										&backend_tx,
										BackendEvent::ExtensionMcpUpdated(snapshot),
									);
								}
							},
							dispatch = next_presentation_dispatch(&mut presentation_endpoint) => {
								handle_presentation_dispatch(
									presentation_endpoint.as_ref().expect("dispatch requires endpoint"),
									dispatch,
									&backend_tx,
									&mut state,
									&bridge_data_dir,
									settings_manager.as_ref(),
								);
							},
							intent = intent_rx.recv_async() => {
								let Ok(intent) = intent else { break };
								if let Intent::ExtensionShortcut(chord) = &intent {
									if let Some((entry, identity, dispatcher)) =
										state.extension_ui.shortcut(chord.as_str())
									{
										let phase = if bus.phase() == AgentPhase::Idle {
											sf!("idle")
										} else {
											sf!("working")
										};
										let callback = presentation::ControlPresentationCallbackDispatcher::new(
											identity,
											dispatcher,
										);
										let _ = callback
											.dispatch_shortcut(
												&entry,
												state.session_id.clone(),
												chord.clone(),
												phase,
											)
											.await;
									}
									continue;
								}
								if let Intent::UiResponse { correlation, response } = &intent {
									if let Some((dispatch_id, request)) =
										state.presentation_requests.remove(correlation.as_str())
										&& let Some(endpoint) = presentation_endpoint.as_ref()
									{
										let result = lower_presentation_response(request, response.clone());
										let _ = endpoint.complete(dispatch_id, result);
									}
									continue;
								}
								if let Intent::UiOverlayEvent(event) = &intent {
									let pending = state
										.presentation_requests
										.iter()
										.find_map(|(correlation, (dispatch_id, request))| {
											matches!(
												request,
												presentation_authority::PresentationRequest::OverlayEvents { id }
													if id.as_str() == event.overlay_id
											)
											.then(|| (correlation.clone(), *dispatch_id))
										});
									if let Some((correlation, dispatch_id)) = pending {
										state.presentation_requests.remove(correlation.as_str());
										if let Some(endpoint) = presentation_endpoint.as_ref() {
											let value = serde_json::json!({
												"id": event.overlay_id,
												"kind": event.kind,
												"value": event.value,
											});
											let _ = endpoint.complete(
												dispatch_id,
												Ok(presentation_authority::PresentationResponse::OverlayEvents(vec![value])),
											);
										}
									}
									continue;
								}
								if matches!(&intent, Intent::InspectHistory) {
									match crate::render_cmd::history_frame(
										&local_session_path,
										registry.as_ref(),
										renderers.as_ref(),
									) {
										Ok(frame) => send_backend(
											&backend_tx,
											BackendEvent::HistoryInspect { frame },
										),
										Err(error) => send_backend(
											&backend_tx,
											BackendEvent::Error(sf!(
												"Could not inspect history: {error}"
											)),
										),
									}
									continue;
								}
								if handle_intent(
									&mcp_inspector,
									intent,
									&backend_tx,
									&ui_tx,
									&mailbox,
									&abort,
									&control,
									&agent_state,
									&modes,
									&parent,
									auth.as_ref(),
									auth_control.as_ref(),
									&extension_reload,
									&bridge_data_dir,
									settings_manager.as_ref(),
									session_index.as_ref(),
									telemetry_index.as_ref(),
									&mut list_sessions,
									&bus,
									registry.as_ref(),
									renderers.as_ref(),
									0,
									&mut state,
								).await? {
									break;
								}
							},
							Ok(notice) = advisor_notices.recv_async() => {
								if let Some(notice) = notice {
									send_backend(&backend_tx, BackendEvent::Notice(notice));
								}
								send_status(&backend_tx, &state, &bus, 0);
							},
							Ok(event) = maintenance_rx.recv_async() => {
								match event {
									MaintenanceEvent::Compact(Ok(outcome)) => {
										send_backend(
											&backend_tx,
											BackendEvent::Notice(compaction_notice(&outcome)),
										);
									},
									MaintenanceEvent::Compact(Err(
										omp_agent::AgentError::CompactionCancelled(
											omp_agent::CompactionCancellation::UserInterrupt,
										),
									)) => {},
									MaintenanceEvent::Compact(Err(error)) => {
										send_backend(
											&backend_tx,
											BackendEvent::Error(sf!("Compaction failed: {error}")),
										);
									},
									MaintenanceEvent::Shake(Ok((outcome, items))) => {
										state.active_parts.clear();
										state.streaming_tools.clear();
										state.tools.clear();
										state.part_serial = 0;
										send_backend(&backend_tx, BackendEvent::HistoryCleared);
										replay_items(
											&backend_tx,
											&items,
											&mut state.tools,
											&mut state.part_serial,
											renderers.as_ref(),
										);
										send_backend(
											&backend_tx,
											BackendEvent::Notice(shake_notice(&outcome)),
										);
									},
									MaintenanceEvent::Shake(Err(error)) => {
										send_backend(
											&backend_tx,
											BackendEvent::Error(sf!("Shake failed: {error}")),
										);
									},
								}
							},
							Ok(ack) = ack_rx.recv_async() => {
								state.submit_pending = false;
								state.turn_started = None;
								if state.queued > 0 {
									send_backend(&backend_tx, BackendEvent::QueuedPromptsSettled);
								}
								state.queued = 0;
								state.queued_prompts.clear();
								if ack.interrupted && ack.committed_turns == 0
									&& let Some(prompt) = state.pending_prompt.take()
								{
									send_backend(&backend_tx, BackendEvent::PromptDropped {
										text: prompt.text,
										attachments: prompt.attachments,
									});
								} else {
									state.pending_prompt = None;
								}
								send_backend(&backend_tx, BackendEvent::Ack {
									interrupted: ack.interrupted,
								});
								let _ = tokio::time::timeout(
									Duration::from_millis(300),
									refresh_git_facts(&mut state),
								)
								.await;
								send_status(&backend_tx, &state, &bus, 0);
												while let Some(command) = state.deferred.take_next() {
									execute_deferred_command(
										&backend_tx,
										&mut state,
										registry.as_ref(),
										parent.as_ref(),
										command,
									)
									.await;
								}
			},
							Some(event) = next_auth_event(auth.as_ref()) => {
								handle_auth_event(&backend_tx, &mut state, event);
							},
							Some(request) = next_approval_request(&mut approval_inbox) => {
								let ticket_id = request.ticket.ticket_id.clone();
								send_backend(
									&backend_tx,
									BackendEvent::ApprovalPending(approval_ticket_view(&request.ticket)),
								);
								state.approvals.insert(ticket_id, request);
							},
							Some(projection) = next_replica_update(&mut replica_updates) => {
								if projection.gap {
									send_backend(
										&backend_tx,
										BackendEvent::Error(sf!(
											"Collaboration transcript gap detected; requesting a fresh snapshot."
										)),
									);
								} else if projection.ready
									&& let Some(path) = projection.path.as_deref()
								{
									match replica_items(path, registry.as_ref()) {
										Ok(items) => {
											if !guest_projected {
												session_restore.begin(Some(&local_session_path));
												guest_projected = true;
											}
											state.tools.clear();
											state.part_serial = 0;
											send_backend(&backend_tx, BackendEvent::HistoryCleared);
											replay_items(
												&backend_tx,
												&items,
												&mut state.tools,
												&mut state.part_serial,
												renderers.as_ref(),
											);
										},
										Err(error) => send_backend(
											&backend_tx,
											BackendEvent::Error(sf!(
												"Could not project collaboration transcript: {error}"
											)),
										),
									}
								}
							},
							Some(presence) = next_presence_update(&mut collab_presence) => {
								if presence.is_none() && guest_projected {
									if let Some(restore) = session_restore.take() {
										state.tools.clear();
										state.part_serial = 0;
										send_backend(&backend_tx, BackendEvent::HistoryCleared);
										if let omp_collab::guest::LocalSessionRestore::Saved(path) = restore {
											match replica_items(&path, registry.as_ref()) {
												Ok(items) => replay_items(
													&backend_tx,
													&items,
													&mut state.tools,
													&mut state.part_serial,
													renderers.as_ref(),
												),
												Err(error) => send_backend(
													&backend_tx,
													BackendEvent::Error(sf!(
														"Could not restore local transcript: {error}"
													)),
												),
											}
										}
									}
									guest_projected = false;
								}
								send_status(&backend_tx, &state, &bus, 0);
							},
							operation = next_host_operation(&mut collab_operations) => {
								handle_collaboration_operation(
									operation,
									parent.as_ref(),
									&abort,
									modes.as_ref(),
									&ui_tx,
									&backend_tx,
									&mut state,
									&bus,
								)
								.await;
							},
							Ok(event) = agent_events.recv() => {
								if guest_projected {
									continue;
								}
								if let AgentEvent::HistoryRewritten { escalate_jobs, .. } = event.as_ref() {
									for id in escalate_jobs {
										parent.cancel_child(id.as_str());
									}
								}
								if matches!(&*event, AgentEvent::RosterChanged { .. }) {
									publish_agent_roster(&backend_tx, &parent, &tree, &session_id, &mut last_roster);
									publish_collaboration_registry(
										state.collab_live.as_ref(),
										parent.as_ref(),
										session_id.as_str(),
									);
								} else {
									if let Some(stream) = collaboration_stream_event(event.as_ref())
										&& let Some(live) = state.collab_live.as_ref()
										&& let Err(error) = live.send_stream(stream).await
									{
										tracing::warn!(%error, "collaboration stream projection failed");
									}
									handle_agent_event(
										&backend_tx,
										&mut state,
										&event,
										modes.as_ref(),
										renderers.as_ref(),
										&bus,
										0,
									)
									.await;
								}
							},
							Ok(()) = roster_events.changed() => {
								let generation = *roster_events.borrow_and_update();
								bus.publish(AgentEvent::RosterChanged { generation });
							},
							_ = roster_tick.tick() => {
								if project_agent_roster(&parent, &tree, &session_id) != last_roster {
									bus.publish(AgentEvent::RosterChanged {
										generation: tree.roster_generation(),
									});
								}
								let regime_revision = state.regimes.revision();
								let regime_changed = regime_revision != state.regime_revision;
								if regime_changed {
									state.regime_revision = regime_revision;
								}
								if regime_changed || drain_live_activity(&live_events, &mut state) {
									send_status(&backend_tx, &state, &bus, 0);
								}
							},
						}
		}
		Ok::<(), miette::Report>(())
	};

	let (input_actions, dequeue_hint) = load_input_actions(&data_dir, input_extension_ui.as_ref())?;
	let options = HostOptions {
		welcome,
		exit_on_session_change: true,
		completion_notify: true,
		error_notify: true,
		title_enabled,
		resize_scrollback,
		input_actions,
		dequeue_hint,
	};
	let (host_result, bridge_result): (
		miette::Result<omp_chat_ui::host::HostOutcome>,
		miette::Result<()>,
	) = match presentation {
		ChatPresentation::Terminal => {
			let chat = chat_scene(&chat_seed, &ctx);
			let host = omp_chat_ui::host::run_with_draft(
				chat,
				ctx,
				backend_rx,
				intent_tx,
				options,
				initial_draft,
			);
			let (host_result, bridge_result) = tokio::join!(host, bridge);
			(host_result.into_diagnostic(), bridge_result)
		},
		#[cfg(feature = "gui")]
		ChatPresentation::Gui => {
			#[cfg(not(feature = "gui"))]
			return Err(miette::miette!(
				"native GUI support is not built; rerun with `--features gui`"
			));
			#[cfg(feature = "gui")]
			let (host_result, bridge_result) = gui::run(
				move |ctx| {
					let chat = chat_scene(&chat_seed, ctx);
					RetainedChat::new(chat, ctx.clone(), backend_rx, intent_tx, options, initial_draft)
				},
				bridge,
			);
			#[cfg(feature = "gui")]
			(Ok(host_result), bridge_result)
		},
	};
	task_settings_watch.abort();
	let _ = task_settings_watch.await;
	if tokio::time::timeout(Duration::from_secs(3), &mut agent_task)
		.await
		.is_err()
	{
		agent_task.abort();
	}
	bridge_result?;
	host_result
}

fn guest_ui_request(request: omp_proto::collab::v1::UiRequest) -> UiRequest {
	use omp_proto::collab::v1::ui_request::Spec;
	let kind = match request.spec {
		Some(Spec::Select(select)) => ui_request::Kind::Dialog(Dialog {
			kind:    String::from("select"),
			title:   request.title,
			content: None,
			choices: select
				.options
				.into_iter()
				.map(|option| option.label)
				.collect(),
			props:   None,
		}),
		Some(Spec::Editor(editor)) => ui_request::Kind::Dialog(Dialog {
			kind:    String::from("editor"),
			title:   request.title,
			content: editor.prefill.as_deref().and_then(|prefill| {
				presentation_tml(Some(&Value::String(format!("<text>{prefill}</text>"))))
			}),
			choices: Vec::new(),
			props:   None,
		}),
		None => ui_request::Kind::Dialog(Dialog {
			kind:    String::from("confirm"),
			title:   request.title,
			content: None,
			choices: Vec::new(),
			props:   None,
		}),
	};
	UiRequest {
		owner_invocation: u64::from(request.request_id),
		kind:             Some(kind),
		props:            None,
	}
}

/// Runs a standalone collaboration composer backed only by the durable guest
/// transcript projection and the host-authorized prompt forwarding handle.
pub async fn run_guest(
	replica: omp_collab::guest::GuestReplicaHandle,
	collab: CollabCommandHandle,
	registry: Arc<Registry>,
	initial_draft: Str,
) -> miette::Result<omp_chat_ui::host::HostOutcome> {
	let gallery = omp_tools::gallery::builtin_renderer_gallery();
	let mut renderers = RenderRegistry::new();
	omp_tools::register_builtin_renderers(&mut renderers, gallery.identities)
		.map_err(|error| miette::miette!(error))?;
	let renderers = Arc::new(renderers);
	let caps = detect();
	let ctx = terminal_ui_context(&caps);
	let chat = Chat::new(&ctx);
	let (backend_tx, backend_rx) = flume::unbounded();
	let (intent_tx, intent_rx) = flume::unbounded();
	let mut updates = replica.subscribe();
	let mut projection = replica.projection();
	while !projection.ready {
		updates.changed().await.into_diagnostic()?;
		projection = updates.borrow_and_update().clone();
	}
	let path = projection
		.path
		.as_deref()
		.ok_or_else(|| miette::miette!("collaboration replica has no durable path"))?;
	let mut tools = HashMap::new();
	let mut serial = 0;
	replay_items(
		&backend_tx,
		&replica_items(path, registry.as_ref())?,
		&mut tools,
		&mut serial,
		renderers.as_ref(),
	);
	send_backend(&backend_tx, BackendEvent::Status(guest_status(&collab)));
	let mut presence = collab.subscribe_presence();
	let mut guest_live = collab.subscribe_guest_live();
	let guest_events = collab.guest_presentation();

	let bridge = async {
		loop {
			tokio::select! {
				intent = intent_rx.recv_async() => {
					let Ok(intent) = intent else { break };
					match intent {
						Intent::Quit => break,
						Intent::ExtensionShortcut(_) => {},
						Intent::InspectHistory => {
							match crate::render_cmd::history_frame(path, registry.as_ref(), renderers.as_ref()) {
								Ok(frame) => send_backend(
									&backend_tx,
									BackendEvent::HistoryInspect { frame },
								),
								Err(error) => send_backend(
									&backend_tx,
									BackendEvent::Error(sf!("Could not inspect history: {error}")),
								),
							}
						},
						Intent::UiResponse { correlation, response } => {
							let request_id = correlation
								.parse::<u32>()
								.map_err(|_| miette::miette!("invalid collaboration UI correlation"))?;
							let value = match response.kind {
								Some(omp_proto::omp::ui::v1::ui_response::Kind::DialogOutcome(outcome)) => {
									outcome.value.map(Str::from).or_else(|| outcome.values.into_iter().next().map(Str::from))
								},
								Some(omp_proto::omp::ui::v1::ui_response::Kind::Text(text)) => Some(Str::from(text.value)),
								_ => None,
							};
							if let Err(error) = collab
								.request(omp_driver::collab::session::CollabOwnerCommand::UiResponse {
									request_id,
									value,
								})
								.await
							{
								send_backend(&backend_tx, BackendEvent::Error(Str::new(error.to_string())));
							}
						},
						Intent::Submit { text, attachments, .. } => {
							let read_only = collab
								.presence()
								.is_some_and(|facts| facts.read_only());
							match omp_collab::guest::admit_guest_input(text.as_str(), read_only) {
								Ok(omp_collab::guest::GuestInputDisposition::RemotePrompt) => {
									let mut remote_text = text.to_string();
									let mut images = Vec::new();
									for attachment in attachments {
										match attachment.content {
											AttachmentContent::Text { text, .. } => {
												remote_text.push_str("\n\n");
												remote_text.push_str(text.as_str());
											},
											AttachmentContent::Image { source, .. } => {
												const REMOTE_IMAGE_MAX_BYTES: u64 = 24 * 1024 * 1024;
												let source = source.to_string();
												let metadata = tokio::fs::metadata(&source)
													.await
													.into_diagnostic()?;
												if metadata.len() > REMOTE_IMAGE_MAX_BYTES {
													send_backend(
														&backend_tx,
														BackendEvent::Error(sf!(
															"Collaboration image attachment exceeds 24 MiB."
														)),
													);
													continue;
												}
												let mime_type = image::ImageFormat::from_path(source.as_str())
													.map(|format| format.to_mime_type())
													.unwrap_or("application/octet-stream");
												let data = tokio::fs::read(source)
													.await
													.into_diagnostic()?;
												images.push(omp_driver::collab::session::RemoteImage {
													data: Bytes::from(data),
													mime_type: Str::new_static(mime_type),
												});
											},
										}
									}
									match collab
										.request(omp_driver::collab::session::CollabOwnerCommand::Prompt {
											text: Str::from(remote_text),
											images,
										})
										.await
									{
										Ok(_) => send_backend(
											&backend_tx,
											BackendEvent::Ack { interrupted: false },
										),
										Err(error) => send_backend(
											&backend_tx,
											BackendEvent::Error(Str::new(error.to_string())),
										),
									}
								},
								Ok(omp_collab::guest::GuestInputDisposition::LocalCommand) => {
									let command = text
										.trim_start()
										.trim_start_matches('/')
										.split_ascii_whitespace()
										.next()
										.unwrap_or_default();
									if matches!(command, "leave" | "quit" | "exit") {
										let _ = collab
											.request(omp_driver::collab::session::CollabOwnerCommand::Leave)
											.await;
										break;
									}
									send_backend(
										&backend_tx,
										BackendEvent::Notice(sf!(
											"`/{command}` is not available in the standalone guest composer."
										)),
									);
								},
								Err(error) => send_backend(
									&backend_tx,
									BackendEvent::Error(Str::new(error.to_string())),
								),
							}
						},
						_ => {},
					}
				},
				changed = updates.changed() => {
					if changed.is_err() {
						break;
					}
					let projection = updates.borrow_and_update().clone();
					if projection.gap {
						send_backend(
							&backend_tx,
							BackendEvent::Error(sf!(
								"Collaboration transcript gap detected; requesting a fresh snapshot."
							)),
						);
					} else if projection.ready
						&& let Some(path) = projection.path.as_deref()
					{
						match replica_items(path, registry.as_ref()) {
							Ok(items) => {
								tools.clear();
								serial = 0;
								send_backend(&backend_tx, BackendEvent::HistoryCleared);
								replay_items(
									&backend_tx,
									&items,
									&mut tools,
									&mut serial,
									renderers.as_ref(),
								);
							},
							Err(error) => send_backend(
								&backend_tx,
								BackendEvent::Error(sf!(
									"Could not project collaboration transcript: {error}"
								)),
							),
						}
					}
				},
				changed = presence.changed() => {
					if changed.is_err() {
						break;
					}
					send_backend(&backend_tx, BackendEvent::Status(guest_status(&collab)));
				},
				changed = guest_live.changed() => {
					if changed.is_err() {
						break;
					}
					let projection = guest_live.borrow_and_update().clone();
					send_backend(
						&backend_tx,
						BackendEvent::AgentRoster(guest_agent_rows(&projection.agents)),
					);
					if let Some(state) = projection.state {
						let mut status = guest_status(&collab);
						status.model = state
							.model
							.map_or_else(|| sf!("Collaboration"), |model| Str::new(model.name));
						status.working = state.is_streaming;
						status.queued = state.queued_message_count as usize;
						status.context_tokens = state.context_usage.as_ref().map_or(0, |usage| usage.tokens);
						status.context_window = state.context_usage.map(|usage| usage.context_window);
						send_backend(&backend_tx, BackendEvent::Status(status));
					}
				},
									event = guest_events.recv() => {
						let Ok(event) = event else { break };
						match event {
							omp_driver::collab::session::GuestPresentationEvent::Resync => {
								send_backend(&backend_tx, BackendEvent::LoginPanelClose);
							},
							omp_driver::collab::session::GuestPresentationEvent::Stream(stream) => {
							if let Some(notice) = stream.notice {
								let event = if notice.level
									== omp_proto::collab::v1::notice::Level::Error as i32
								{
									BackendEvent::Error(Str::new(notice.message))
								} else {
									BackendEvent::Notice(Str::new(notice.message))
								};
								send_backend(&backend_tx, event);
							}
							if let Some(item) = stream.item {
								replay_items(
									&backend_tx,
									&[item],
									&mut tools,
									&mut serial,
									renderers.as_ref(),
								);
							}
						},
						omp_driver::collab::session::GuestPresentationEvent::UiRequest(request) => {
							let correlation = Str::from(request.request_id.to_string());
							send_backend(&backend_tx, BackendEvent::UiRequest {
								correlation,
								request: guest_ui_request(request),
							});
						},
						omp_driver::collab::session::GuestPresentationEvent::UiRequestEnd(_) => {},
						omp_driver::collab::session::GuestPresentationEvent::Transcript(chunk) => {
							if let Some(error) = chunk.error {
								send_backend(&backend_tx, BackendEvent::Error(Str::new(error)));
							}
						},
						omp_driver::collab::session::GuestPresentationEvent::Bus(_) => {},
						omp_driver::collab::session::GuestPresentationEvent::Error(error) => {
							send_backend(&backend_tx, BackendEvent::Error(Str::new(error.message)));
						},
					}
				},
			}
		}
		Ok::<(), miette::Report>(())
	};

	let host = omp_chat_ui::host::run_with_draft(
		chat,
		ctx,
		backend_rx,
		intent_tx,
		HostOptions {
			welcome:                false,
			exit_on_session_change: false,
			completion_notify:      true,
			error_notify:           true,
			title_enabled:          true,
			resize_scrollback:      omp_chat_ui::host::ResizeScrollback::Rebuild,
			input_actions:          Vec::new(),
			dequeue_hint:           None,
		},
		initial_draft,
	);
	let (host_result, bridge_result) = tokio::join!(host, bridge);
	bridge_result?;
	host_result.into_diagnostic()
}

fn guest_agent_rows(snapshot: &omp_proto::collab::v1::RegistrySnapshot) -> Vec<AgentRow> {
	snapshot
		.agents
		.iter()
		.map(|agent| {
			let status = omp_proto::collab::v1::agent_summary::Status::try_from(agent.status)
				.unwrap_or(omp_proto::collab::v1::agent_summary::Status::Idle);
			AgentRow {
				id:               Str::new(&agent.id),
				name:             Str::new(&agent.display_name),
				parent:           agent.parent_id.as_deref().map(Str::new),
				depth:            u16::from(agent.parent_id.is_some()),
				status:           Str::new(status.as_str_name()),
				tool:             None,
				tokens:           None,
				definition:       None,
				model:            None,
				serving_model:    None,
				transcript:       Str::default(),
				assignment:       None,
				requests:         0,
				tool_calls:       0,
				context_tokens:   0,
				cost_micros:      0,
				terminal_kind:    None,
				terminal_summary: None,
				artifact_uri:     None,
				frozen:           matches!(
					status,
					omp_proto::collab::v1::agent_summary::Status::Aborted
				),
				can_steer:        matches!(
					status,
					omp_proto::collab::v1::agent_summary::Status::Running
				),
				can_revive:       matches!(
					status,
					omp_proto::collab::v1::agent_summary::Status::Parked
				),
				can_kill:         matches!(
					status,
					omp_proto::collab::v1::agent_summary::Status::Running
				),
			}
		})
		.collect()
}

fn guest_status(collab: &CollabCommandHandle) -> StatusFacts {
	let presence = collab.presence();
	StatusFacts {
		model: sf!("Collaboration"),
		collab_peers: presence.map_or(0, |facts| facts.participant_count().saturating_sub(1)),
		..StatusFacts::default()
	}
}

fn mode_status(modes: &RegimeHandle) -> Str {
	modes
		.mode_holder()
		.map_or_else(|| sf!("No regime owns the mode resource."), |holder| sf!("Mode: **{holder}**"))
}

async fn regime_request(
	backend: &flume::Sender<BackendEvent>,
	commands: &flume::Sender<UiCmd>,
	operation: RegimeOperation,
) -> Option<Result<RegimeMutation, omp_agent::AgentError>> {
	let (reply, response) = flume::bounded(1);
	if commands
		.send_async(UiCmd::Regime { operation, reply })
		.await
		.is_err()
	{
		send_backend(backend, BackendEvent::Error(sf!("Regime control is unavailable.")));
		return None;
	}
	match response.recv_async().await {
		Ok(result) => Some(result),
		Err(_) => {
			send_backend(backend, BackendEvent::Error(sf!("Regime control stopped.")));
			None
		},
	}
}

fn report_regime_start(
	backend: &flume::Sender<BackendEvent>,
	modes: &RegimeHandle,
	id: &str,
	result: Result<RegimeMutation, omp_agent::AgentError>,
) -> Option<omp_agent::StartReceipt> {
	match result {
		Ok(RegimeMutation::Started(receipt)) => {
			match &receipt.outcome {
				omp_agent::AcquireOutcome::Granted => {
					send_backend(backend, BackendEvent::Notice(sf!("Mode: **{id}**")))
				},
				omp_agent::AcquireOutcome::Queued { holder, since } => {
					let holder_name = modes.mode_holder().unwrap_or_else(|| holder.clone());
					send_backend(
						backend,
						BackendEvent::Notice(sf!(
							"Queued {id} activation `{}` behind mode owner {holder_name} (activation \
							 {holder}, since {since}). Stop with `/{id} stop {}`.",
							receipt.activation,
							receipt.activation,
						)),
					);
				},
				omp_agent::AcquireOutcome::Denied { .. } => {
					unreachable!("denied resource acquisition is returned as a start error")
				},
			}
			Some(receipt)
		},
		Err(omp_agent::AgentError::Arbiter(omp_agent::ArbiterError::Start(
			omp_agent::StartError::Acquire {
				outcome: omp_agent::AcquireOutcome::Denied { holder, since },
				..
			},
		))) => {
			let holder_name = modes.mode_holder().unwrap_or_else(|| holder.clone());
			send_backend(
				backend,
				BackendEvent::Error(sf!(
					"Cannot start {id}: stop {holder_name} first (mode owner activation {holder}, \
					 since {since})."
				)),
			);
			None
		},
		Ok(RegimeMutation::Stopped(_)) => unreachable!("start returned stop result"),
		Err(error) => {
			send_backend(backend, BackendEvent::Error(Str::new(error.to_string())));
			None
		},
	}
}

async fn start_mode_regime(
	backend: &flume::Sender<BackendEvent>,
	commands: &flume::Sender<UiCmd>,
	modes: &RegimeHandle,
	id: &'static str,
	queue: bool,
	prompt_slot: Option<&'static str>,
) -> Option<omp_agent::StartReceipt> {
	let result =
		regime_request(backend, commands, RegimeOperation::Start { id, queue, prompt_slot }).await?;
	report_regime_start(backend, modes, id, result)
}

async fn stop_mode_regime(
	backend: &flume::Sender<BackendEvent>,
	commands: &flume::Sender<UiCmd>,
	id: &str,
	activation: Str,
) -> bool {
	let Some(result) =
		regime_request(backend, commands, RegimeOperation::Stop { activation: activation.clone() })
			.await
	else {
		return false;
	};
	match result {
		Ok(RegimeMutation::Stopped(true)) => {
			send_backend(
				backend,
				BackendEvent::Notice(sf!("Stopped {id} activation `{activation}`.")),
			);
			true
		},
		Ok(RegimeMutation::Stopped(false)) => {
			send_backend(
				backend,
				BackendEvent::Error(sf!("Regime activation `{activation}` is not active.")),
			);
			false
		},
		Ok(RegimeMutation::Started(_)) => unreachable!("stop returned start result"),
		Err(error) => {
			send_backend(backend, BackendEvent::Error(Str::new(error.to_string())));
			false
		},
	}
}
async fn stop_streaming_plan_regime(
	backend: &flume::Sender<BackendEvent>,
	control: &omp_agent::ControlSender,
	modes: &RegimeHandle,
	abort: &omp_agent::AbortHandle,
	activation: Str,
) -> bool {
	match control.stop_regime_snapshot(activation.clone()).await {
		Ok((true, records)) => {
			modes.sync_records(&records);
			// Abort only after the mode resource is durably released. Any queued
			// producer that survives the caller abort then starts with the restored
			// non-plan prompt and toolset.
			abort.abort();
			send_backend(
				backend,
				BackendEvent::Notice(sf!("Stopped plan activation `{activation}`.")),
			);
			true
		},
		Ok((false, records)) => {
			modes.sync_records(&records);
			send_backend(
				backend,
				BackendEvent::Error(sf!("Regime activation `{activation}` is not active.")),
			);
			false
		},
		Err(error) => {
			send_backend(backend, BackendEvent::Error(Str::new(error.to_string())));
			false
		},
	}
}

fn queued_flag(args: &str) -> (&str, bool) {
	args
		.strip_suffix(" queue=true")
		.map_or((args, false), |args| (args.trim_end(), true))
}

async fn handle_plan_command(
	backend: &flume::Sender<BackendEvent>,
	commands: &flume::Sender<UiCmd>,
	control: &omp_agent::ControlSender,
	modes: &RegimeHandle,
	abort: &omp_agent::AbortHandle,
	turn_active: bool,
	args: &str,
) {
	let (args, queue) = queued_flag(args.trim());
	match args {
		"" | "status" => send_backend(backend, BackendEvent::Notice(mode_status(modes))),
		"on" | "yolo" => {
			let prompt_slot = (args == "yolo").then_some("plan-yolo");
			let _ = start_mode_regime(backend, commands, modes, "plan", queue, prompt_slot).await;
		},
		"off" => {
			if modes.mode_holder().as_deref() != Some("plan") {
				send_backend(backend, BackendEvent::Notice(mode_status(modes)));
				return;
			}
			if let Some(activation) = modes.mode_activation() {
				if turn_active {
					let _ = stop_streaming_plan_regime(backend, control, modes, abort, activation).await;
				} else {
					let _ = stop_mode_regime(backend, commands, "plan", activation).await;
				}
			}
		},
		_ if args.starts_with("stop ") => {
			let activation = Str::new(args.trim_start_matches("stop ").trim());
			let active_plan = turn_active
				&& modes.mode_holder().as_deref() == Some("plan")
				&& modes.mode_activation().as_ref() == Some(&activation);
			if active_plan {
				let _ = stop_streaming_plan_regime(backend, control, modes, abort, activation).await;
			} else {
				let _ = stop_mode_regime(backend, commands, "plan", activation).await;
			}
		},
		_ => send_backend(
			backend,
			BackendEvent::Error(sf!(
				"Usage: /plan [on|yolo|off|status|stop <activation>] [queue=true]"
			)),
		),
	}
}

async fn handle_vibe_command(
	backend: &flume::Sender<BackendEvent>,
	commands: &flume::Sender<UiCmd>,
	modes: &RegimeHandle,
	args: &str,
) {
	let (args, queue) = queued_flag(args.trim());
	match args {
		"" | "status" => send_backend(backend, BackendEvent::Notice(mode_status(modes))),
		"on" => {
			let _ = start_mode_regime(backend, commands, modes, "vibe", queue, None).await;
		},
		"off" => {
			if modes.mode_holder().as_deref() != Some("vibe") {
				send_backend(backend, BackendEvent::Notice(mode_status(modes)));
				return;
			}
			if let Some(activation) = modes.mode_activation() {
				let _ = stop_mode_regime(backend, commands, "vibe", activation).await;
			}
		},
		_ if args.starts_with("stop ") => {
			let activation = Str::new(args.trim_start_matches("stop ").trim());
			let _ = stop_mode_regime(backend, commands, "vibe", activation).await;
		},
		_ => send_backend(
			backend,
			BackendEvent::Error(sf!("Usage: /vibe [on|off|status|stop <activation>] [queue=true]")),
		),
	}
}

async fn handle_goal_command(
	backend: &flume::Sender<BackendEvent>,
	commands: &flume::Sender<UiCmd>,
	modes: &RegimeHandle,
	args: &str,
) {
	let args = args.trim();
	let (op, rest) = args
		.split_once(char::is_whitespace)
		.map_or((args, ""), |(op, rest)| (op, rest.trim()));
	match op {
		"" => send_backend(backend, BackendEvent::OpenGuidedGoal),
		"status" => send_backend(backend, BackendEvent::Notice(goal_status(modes.goal()))),
		"set" => {
			let (rest, queue) = queued_flag(rest);
			let (objective, budget) =
				rest
					.rsplit_once(char::is_whitespace)
					.map_or((rest, None), |(objective, tail)| {
						tail
							.trim()
							.parse::<u64>()
							.ok()
							.map_or((rest, None), |budget| (objective.trim(), Some(budget)))
					});
			if let Some(receipt) =
				start_mode_regime(backend, commands, modes, "goal", queue, None).await
			{
				match modes.set_goal(objective, budget, now_ms()) {
					Ok(goal) => {
						send_backend(backend, BackendEvent::Notice(goal_status(Some(goal))));
					},
					Err(error) => {
						let _ = stop_mode_regime(backend, commands, "goal", receipt.activation).await;
						send_backend(backend, BackendEvent::Error(Str::new(error.to_string())));
					},
				}
			}
		},
		"pause" | "complete" | "drop" => {
			let result = match op {
				"pause" => modes.pause_goal(now_ms()),
				"complete" => modes.complete_goal(now_ms()),
				"drop" => modes.drop_goal(now_ms()),
				_ => unreachable!(),
			};
			match result {
				Ok(goal) => {
					if modes.mode_holder().as_deref() == Some("goal")
						&& let Some(activation) = modes.mode_activation()
					{
						let _ = stop_mode_regime(backend, commands, "goal", activation).await;
					}
					send_backend(backend, BackendEvent::Notice(goal_status(Some(goal))));
				},
				Err(error) => {
					send_backend(backend, BackendEvent::Error(Str::new(error.to_string())));
				},
			}
		},
		"resume" => {
			let (_, queue) = queued_flag(rest);
			if let Some(receipt) =
				start_mode_regime(backend, commands, modes, "goal", queue, None).await
			{
				match modes.resume_goal(now_ms()) {
					Ok(goal) => {
						send_backend(backend, BackendEvent::Notice(goal_status(Some(goal))));
					},
					Err(error) => {
						let _ = stop_mode_regime(backend, commands, "goal", receipt.activation).await;
						send_backend(backend, BackendEvent::Error(Str::new(error.to_string())));
					},
				}
			}
		},
		"budget" => match rest.parse::<u64>() {
			Ok(budget) => match modes.set_goal_budget(budget) {
				Ok(goal) => {
					if goal.status == GoalStatus::BudgetLimited
						&& modes.mode_holder().as_deref() == Some("goal")
						&& let Some(activation) = modes.mode_activation()
					{
						let _ = stop_mode_regime(backend, commands, "goal", activation).await;
					}
					send_backend(backend, BackendEvent::Notice(goal_status(Some(goal))));
				},
				Err(error) => {
					send_backend(backend, BackendEvent::Error(Str::new(error.to_string())));
				},
			},
			Err(_) => {
				send_backend(backend, BackendEvent::Error(sf!("Usage: /goal budget <positive-tokens>")))
			},
		},
		"stop" => {
			let activation = Str::new(rest);
			let _ = stop_mode_regime(backend, commands, "goal", activation).await;
		},
		_ => send_backend(
			backend,
			BackendEvent::Error(sf!(
				"Usage: /goal [set|pause|resume|complete|drop|budget|status|stop]"
			)),
		),
	}
}

fn goal_status(goal: Option<Goal>) -> Str {
	let Some(goal) = goal else {
		return sf!("No goal is configured.");
	};
	let status = match goal.status {
		GoalStatus::Active => "active",
		GoalStatus::Paused => "paused",
		GoalStatus::BudgetLimited => "budget-limited",
		GoalStatus::Complete => "complete",
		GoalStatus::Dropped => "dropped",
	};
	let budget = goal.token_budget.map_or_else(
		|| "unbounded".to_owned(),
		|budget| format!("{}/{budget} tokens", goal.tokens_used),
	);
	Str::from(format!(
		"**Goal {status}** · {budget} · {}s\n{}",
		goal.time_used_seconds, goal.objective
	))
}
fn compaction_notice(outcome: &omp_agent::ManualCompactionOutcome) -> Str {
	if outcome.frame_count == 0 {
		sf!(
			"Compacted with {} at event {}: {} → {} tokens.",
			outcome.method,
			outcome.event,
			outcome.tokens_before,
			outcome.tokens_after,
		)
	} else {
		sf!(
			"Compacted with {} at event {}: {} → {} tokens · {} bitmap frames.",
			outcome.method,
			outcome.event,
			outcome.tokens_before,
			outcome.tokens_after,
			outcome.frame_count,
		)
	}
}

async fn reset_session(
	control: &omp_agent::ControlSender,
	gate: &omp_agent::HookGate,
) -> Result<u64, omp_agent::ControlError> {
	let at_event = control.reset(omp_agent::broker_now_ms()).await?;
	crate::chat_cmd::notify_session_reset(gate, at_event, 0);
	Ok(at_event)
}

fn shake_notice(outcome: &omp_agent::ManualShakeOutcome) -> Str {
	match outcome.mode {
		omp_agent::ManualShakeMode::Thinking => sf!(
			"Dropped {} thinking block{} from this session.",
			outcome.replaced_regions,
			if outcome.replaced_regions == 1 {
				""
			} else {
				"s"
			},
		),
		omp_agent::ManualShakeMode::Elide | omp_agent::ManualShakeMode::DropMedia => sf!(
			"Shook context with {}: {} regions, {} bytes reclaimed.",
			outcome.mode,
			outcome.replaced_regions,
			outcome.removed_bytes,
		),
	}
}

struct LiveCommandHost<'a, C, R>
where
	C: TurnClient + Clone + Send + 'static,
{
	mcp_inspector:    &'a omp_envd::McpInspectorHandle,
	backend:          &'a flume::Sender<BackendEvent>,
	commands_tx:      &'a flume::Sender<UiCmd>,
	abort:            &'a omp_agent::AbortHandle,
	control:          &'a omp_agent::ControlSender,
	agent_state:      &'a AgentState,
	modes:            &'a RegimeHandle,
	auth:             Option<&'a ChatAuth>,
	auth_control:     Option<&'a omp_inference::auth::AuthControlHandle>,
	parent:           Arc<ChatParentHost<C>>,
	mailbox:          &'a omp_agent::MailboxSender,
	extension_reload: &'a omp_envd::ExtensionReloadHandle,
	data_dir:         &'a Path,
	settings_manager: &'a SettingsManager,
	session_index:    &'a SessionIndex,
	list_sessions:    &'a mut R,
	bus:              &'a omp_agent::EventBus,
	registry:         &'a Registry,
	renderers:        &'a RenderRegistry,
	dropped:          u64,
	roster:           commands::CommandRoster,
	state:            &'a mut BridgeState,
}

fn silent_command() -> CommandFuture<'static> {
	Box::pin(async { Ok(CommandResult::Consumed(ConsumedResult::silent())) })
}

fn toggle_live_voice(backend: &flume::Sender<BackendEvent>, state: &mut BridgeState) {
	if state.audio.live_active() {
		state.audio.stop_live();
		tracing::debug!(session_id = %state.session_id, "live voice stopped");
		send_backend(backend, BackendEvent::LiveVoiceStopped);
		send_backend(backend, BackendEvent::Notice(sf!("Live voice stopped.")));
		return;
	}
	match state.audio.start_live() {
		Ok(()) => {
			state.live_activity = ActivityWaveform::new();
			tracing::debug!(session_id = %state.session_id, "live voice started");
			send_backend(backend, BackendEvent::LiveVoiceStarted);
			send_backend(
				backend,
				BackendEvent::Notice(sf!("Live voice started. Space mutes; Escape or Ctrl+C closes.")),
			);
		},
		Err(error) => {
			tracing::warn!(
				%error,
				session_id = %state.session_id,
				"live voice start denied"
			);
			send_backend(backend, BackendEvent::Error(sf!("Could not start live voice: {error}")))
		},
	}
}

fn append_hotkeys(mut help: String) -> String {
	help.push_str(
		"\n**Hotkeys**\n\n| Context | Key | Action |\n|---|---|---|\n| Composer | `Enter` | Steer \
		 active turn or submit |\n| Composer | `Alt+Enter` | Queue follow-up |\n| Composer | `Esc` \
		 | Interrupt active work |\n| Composer | `Esc Esc` | Open rewind history |\n| Composer | \
		 `Ctrl+O` | Expand exact tool card |\n| Composer | `Ctrl+T` | Toggle thinking visibility \
		 |\n| Composer | `Alt+P` | Switch model for this session |\n| Composer | `Ctrl+R` | Search \
		 prompt history |\n| Composer | `Alt+Up` / `Shift+Up` | Restore newest queued item |\n| \
		 Modal | `Enter` | Commit highlighted action |\n| Modal | `Esc` | Cancel modal; never \
		 trigger composer shortcuts |\n| Modal | `Tab` / `Shift+Tab` | Move focus |\n| Approval | \
		 `1` / `2` / `3` / `4` | Once / always / amend / reject |\n",
	);
	help
}

impl<C, R> LiveCommandHost<'_, C, R>
where
	C: TurnClient + Clone + Send + 'static,
{
	fn unavailable(&self, message: &'static str) -> CommandFuture<'static> {
		send_backend(self.backend, BackendEvent::Error(sf!(message)));
		silent_command()
	}

	fn select_model(&mut self, selector: Option<Str>, durable: bool) -> CommandFuture<'_>
	where
		R: Send,
	{
		Box::pin(async move {
			if let Some(selector) = selector {
				switch_model(
					self.backend,
					self.agent_state,
					self.settings_manager,
					selector.as_str(),
					self.state,
					self.control,
					&self.parent,
					durable,
				)
				.await;
			} else if durable {
				send_open_model_hub(self.backend, self.settings_manager, self.state);
			} else {
				send_open_models(self.backend, self.state);
			}
			Ok(CommandResult::Consumed(ConsumedResult::silent()))
		})
	}
}

impl<C, R> ShellCommandHost for LiveCommandHost<'_, C, R>
where
	C: TurnClient + Clone + Send + 'static,
	R: FnMut() -> miette::Result<Vec<ResumeChoice>> + Send,
{
	fn help(&mut self) -> CommandFuture<'_> {
		let help = self.roster.help_text(
			CommandSurface::Tui,
			command_role(self.state.collab.as_ref()),
			true,
			|_| true,
		);
		let help = append_hotkeys(help);
		Box::pin(async move { Ok(CommandResult::Consumed(ConsumedResult::status(Str::from(help)))) })
	}

	fn new_session(&mut self) -> CommandFuture<'_> {
		send_backend(self.backend, BackendEvent::NewSessionRequested);
		silent_command()
	}

	fn jobs(&mut self) -> CommandFuture<'_> {
		let mut jobs: Vec<_> = self.state.jobs.iter().map(Str::as_str).collect();
		jobs.sort_unstable();
		let message = if jobs.is_empty() {
			sf!("No active background jobs.")
		} else {
			Str::from(format!(
				"**Active jobs ({})**\n{}",
				jobs.len(),
				jobs
					.into_iter()
					.map(|job| format!("- `{job}`"))
					.collect::<Vec<_>>()
					.join("\n"),
			))
		};
		Box::pin(async move { Ok(CommandResult::Consumed(ConsumedResult::status(message))) })
	}

	fn agents(&mut self) -> CommandFuture<'_> {
		send_backend(self.backend, BackendEvent::OpenAgentTree);
		silent_command()
	}

	fn pause(&mut self) -> CommandFuture<'_> {
		send_backend(self.backend, BackendEvent::Pause);
		silent_command()
	}

	fn quit(&mut self) -> CommandFuture<'_> {
		if chat_active(self.state.submit_pending, self.bus.phase()) {
			self.abort.abort();
		}
		Box::pin(async { Ok(CommandResult::Exit) })
	}
}

fn pin_target(selector: &str, choices: &[ResumeChoice]) -> Result<Str, Str> {
	if let Some(exact) = choices.iter().find(|choice| choice.id == selector) {
		return Ok(exact.id.clone());
	}
	let mut matches = choices
		.iter()
		.filter(|choice| choice.id.starts_with(selector));
	let Some(first) = matches.next() else {
		return Err(sf!("Session \"{selector}\" not found."));
	};
	if matches.next().is_some() {
		return Err(sf!("Session \"{selector}\" is ambiguous."));
	}
	Ok(first.id.clone())
}

impl<C, R> SessionCommandHost for LiveCommandHost<'_, C, R>
where
	C: TurnClient + Clone + Send + 'static,
	R: FnMut() -> miette::Result<Vec<ResumeChoice>> + Send,
{
	fn clear(&mut self) -> CommandFuture<'_> {
		Box::pin(async move {
			reset_session(self.control, &self.state.session_hooks)
				.await
				.into_diagnostic()?;
			self.state.context_tokens = 0;
			self.state.context_snapshot = None;
			self.state.has_history = false;
			send_backend(self.backend, BackendEvent::HistoryCleared);
			Ok(CommandResult::Consumed(ConsumedResult::silent()))
		})
	}

	fn git(&mut self, revision: Option<Str>) -> CommandFuture<'_> {
		let backend = self.backend.clone();
		let cwd = self.state.local_root.clone();
		Box::pin(async move {
			if let Some(open) = self.state.git.take() {
				let _ = open
					.session
					.handle(omp_chat_ui::git::GitIntent::Close)
					.await;
			}
			let cancel = CancellationToken::new();
			let session = match GitSession::open(&cwd, revision.as_deref(), cancel.clone()).await {
				Ok(session) => session,
				Err(error) => {
					send_backend(
						&backend,
						BackendEvent::Notice(crate::git_cmd::git_open_error(&error).into()),
					);
					return Ok(CommandResult::Consumed(ConsumedResult::silent()));
				},
			};
			let snapshot = match session.initial_snapshot().await {
				Ok(snapshot) => snapshot,
				Err(error) => {
					send_backend(
						&backend,
						BackendEvent::Notice(crate::git_cmd::git_open_error(&error).into()),
					);
					return Ok(CommandResult::Consumed(ConsumedResult::silent()));
				},
			};
			send_backend(&backend, BackendEvent::OpenGitWorkbench(snapshot));
			self.state.git =
				Some(GitWorkbenchBackend { session: session.clone(), cancel: cancel.clone() });
			let stats_session = session.clone();
			let stats_backend = backend.clone();
			drop(tokio::spawn(async move {
				if let Ok(Some(snapshot)) = stats_session.deferred_stats().await {
					send_backend(
						&stats_backend,
						BackendEvent::Git(omp_chat_ui::git::GitUpdate::Snapshot(snapshot)),
					);
				}
			}));
			drop(tokio::spawn(async move {
				let mut interval = tokio::time::interval(Duration::from_secs(2));
				interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
				interval.tick().await;
				loop {
					tokio::select! {
						_ = cancel.cancelled() => break,
						_ = interval.tick() => {
							match session.poll_refresh().await {
								Ok(Some(snapshot)) => {
									send_backend(&backend, BackendEvent::Git(
										omp_chat_ui::git::GitUpdate::Snapshot(snapshot),
									));
									if let Ok(Some(snapshot)) = session.deferred_stats().await {
										send_backend(&backend, BackendEvent::Git(
											omp_chat_ui::git::GitUpdate::Snapshot(snapshot),
										));
									}
								},
								Ok(None) => {},
								Err(error) => {
									tracing::debug!(%error, "Git workbench refresh failed");
								},
							}
						},
					}
				}
			}));
			Ok(CommandResult::Consumed(ConsumedResult::silent()))
		})
	}

	fn fresh(&mut self) -> CommandFuture<'_> {
		Box::pin(async move {
			self
				.control
				.provider_reset(omp_agent::broker_now_ms())
				.await
				.into_diagnostic()?;
			Ok(CommandResult::Consumed(ConsumedResult::status(
				"Provider session will be refreshed on the next turn.",
			)))
		})
	}

	fn rename(&mut self, title: Str) -> CommandFuture<'_> {
		if chat_active(self.state.submit_pending, self.bus.phase()) {
			return Box::pin(async {
				Ok(CommandResult::Consumed(ConsumedResult::status(
					"Wait for the active turn to finish before renaming.",
				)))
			});
		}
		let user_set = Arc::clone(&self.state.title_user_set);
		let was_user_set = user_set.swap(true, Ordering::AcqRel);
		let commit_lock = Arc::clone(&self.state.title_commit_lock);
		Box::pin(async move {
			let _commit = commit_lock.lock().await;
			if let Err(error) = self
				.control
				.set_title(omp_agent::broker_now_ms(), title.clone())
				.await
			{
				user_set.store(was_user_set, Ordering::Release);
				return Err(error).into_diagnostic();
			}
			Ok(CommandResult::Consumed(ConsumedResult::status(sf!("Session renamed to `{title}`."))))
		})
	}

	fn retry(&mut self) -> CommandFuture<'_> {
		Box::pin(async move {
			if chat_active(self.state.submit_pending, self.bus.phase()) {
				return Ok(CommandResult::Consumed(ConsumedResult::status(
					"Wait for the active turn to finish before retrying.",
				)));
			}
			let (reply_tx, reply_rx) = flume::bounded(1);
			self
				.commands_tx
				.send_async(UiCmd::Retry { reply: reply_tx })
				.await
				.into_diagnostic()?;
			match reply_rx.recv_async().await {
				Ok(Ok((items, text))) => {
					self.state.tools.clear();
					self.state.has_history = true;
					send_backend(self.backend, BackendEvent::HistoryCleared);
					replay_items(
						self.backend,
						&items,
						&mut self.state.tools,
						&mut self.state.part_serial,
						self.renderers,
					);
					send_backend(self.backend, BackendEvent::UserReplayed {
						text,
						chips: Vec::new(),
						queued: false,
					});
					Ok(CommandResult::Consumed(ConsumedResult::silent()))
				},
				Ok(Err(error)) => Ok(CommandResult::Consumed(ConsumedResult::status(error))),
				Err(_) => Ok(CommandResult::Consumed(ConsumedResult::status(
					"Agent retry reply channel is closed.",
				))),
			}
		})
	}

	fn resume(&mut self, selector: Option<Str>) -> CommandFuture<'_> {
		let result = if let Some(id) = selector {
			BackendEvent::Sessions(vec![SessionRow {
				id:     id.clone(),
				label:  id,
				detail: sf!("selected session"),
				pinned: false,
			}])
		} else {
			match (self.list_sessions)() {
				Ok(sessions) => BackendEvent::Sessions(session_rows(sessions)),
				Err(error) => return Box::pin(async move { Err(error) }),
			}
		};
		send_backend(self.backend, result);
		silent_command()
	}

	fn handoff(&mut self, instructions: Option<Str>) -> CommandFuture<'_> {
		Box::pin(async move {
			if chat_active(self.state.submit_pending, self.bus.phase()) {
				return Ok(CommandResult::Consumed(ConsumedResult::status(
					"Wait for the active turn to finish before handing off.",
				)));
			}
			let (reply_tx, reply_rx) = flume::bounded(1);
			self
				.commands_tx
				.send_async(UiCmd::Handoff {
					request: omp_agent::ManualCompactionRequest {
						mode:  Some(omp_agent::ManualCompactionMode::Soft),
						focus: instructions,
					},
					reply:   reply_tx,
				})
				.await
				.into_diagnostic()?;
			let status = match reply_rx.recv_async().await {
				Ok(Ok(_)) => Str::new_static("Context handed off and compacted in place."),
				Ok(Err(error)) => sf!("Handoff failed: {error}"),
				Err(_) => sf!("Handoff failed: agent reply channel is closed."),
			};
			Ok(CommandResult::Consumed(ConsumedResult::status(status)))
		})
	}

	fn branch(&mut self, request: BranchRequest) -> CommandFuture<'_> {
		Box::pin(async move {
			if chat_active(self.state.submit_pending, self.bus.phase()) {
				return Ok(CommandResult::Consumed(ConsumedResult::status(
					"Wait for the active turn to finish before branching.",
				)));
			}
			let checkpoint = if let Some(checkpoint) = request.checkpoint {
				match checkpoint.parse::<u64>() {
					Ok(checkpoint) => checkpoint,
					Err(_) => {
						return Ok(CommandResult::Consumed(ConsumedResult::status(
							"Checkpoint must be a durable event number.",
						)));
					},
				}
			} else {
				let (reply_tx, reply_rx) = flume::bounded(1);
				self
					.commands_tx
					.send_async(UiCmd::ListRewind { reply: reply_tx })
					.await
					.into_diagnostic()?;
				match reply_rx.recv_async().await {
					Ok(Ok(targets)) => {
						let Some(target) = targets.last() else {
							return Ok(CommandResult::Consumed(ConsumedResult::status(
								"No user checkpoint is available to branch from.",
							)));
						};
						target.event
					},
					Ok(Err(error)) => {
						return Ok(CommandResult::Consumed(ConsumedResult::status(error)));
					},
					Err(_) => {
						return Ok(CommandResult::Consumed(ConsumedResult::status(
							"Agent checkpoint reply channel is closed.",
						)));
					},
				}
			};
			let summarize = match crate::chat_cmd::gate_session_branch(
				&self.state.session_hooks,
				checkpoint,
				Some(checkpoint),
				false,
			)
			.await
			{
				Ok(summarize) => summarize,
				Err(reason) => {
					return Ok(CommandResult::Consumed(ConsumedResult::status(sf!(
						"Branch denied: {reason}"
					))));
				},
			};
			if summarize {
				return Ok(CommandResult::Consumed(ConsumedResult::status(
					"Branch summarization is unavailable for this session backend.",
				)));
			}
			let child_id = Str::from(omp_core::Ulid::generate().to_string());
			let child_path = self
				.state
				.sessions_dir
				.join(sf!("{child_id}.jsonl").as_str());
			let (reply_tx, reply_rx) = flume::bounded(1);
			self
				.commands_tx
				.send_async(UiCmd::CreateSessionChild {
					kind: omp_agent::ChildKind::Branch { checkpoint },
					child_id: child_id.clone(),
					child_path,
					title: None,
					reply: reply_tx,
				})
				.await
				.into_diagnostic()?;
			match reply_rx.recv_async().await {
				Ok(Ok(new_head)) => {
					crate::chat_cmd::notify_session_branched(
						&self.state.session_hooks,
						checkpoint,
						new_head,
						None,
					);
					send_backend(
						self.backend,
						BackendEvent::Sessions(vec![SessionRow {
							id:     child_id.clone(),
							label:  child_id.clone(),
							detail: sf!("branch of {}", self.state.session_id),
							pinned: false,
						}]),
					);
					Ok(CommandResult::Consumed(ConsumedResult::silent()))
				},
				Ok(Err(error)) => {
					Ok(CommandResult::Consumed(ConsumedResult::status(sf!("Branch failed: {error}"))))
				},
				Err(_) => Ok(CommandResult::Consumed(ConsumedResult::status(
					"Branch failed: agent reply channel is closed.",
				))),
			}
		})
	}

	fn fork(&mut self, title: Option<Str>) -> CommandFuture<'_> {
		Box::pin(async move {
			if chat_active(self.state.submit_pending, self.bus.phase()) {
				return Ok(CommandResult::Consumed(ConsumedResult::status(
					"Wait for the active turn to finish before forking.",
				)));
			}
			let child_id = Str::from(omp_core::Ulid::generate().to_string());
			let child_path = self
				.state
				.sessions_dir
				.join(sf!("{child_id}.jsonl").as_str());
			let label = title.clone().unwrap_or_else(|| child_id.clone());
			let (reply_tx, reply_rx) = flume::bounded(1);
			self
				.commands_tx
				.send_async(UiCmd::CreateSessionChild {
					kind: omp_agent::ChildKind::Fork,
					child_id: child_id.clone(),
					child_path,
					title,
					reply: reply_tx,
				})
				.await
				.into_diagnostic()?;
			match reply_rx.recv_async().await {
				Ok(Ok(_new_head)) => {
					send_backend(
						self.backend,
						BackendEvent::Sessions(vec![SessionRow {
							id: child_id,
							label,
							detail: sf!("fork of {}", self.state.session_id),
							pinned: false,
						}]),
					);
					Ok(CommandResult::Consumed(ConsumedResult::silent()))
				},
				Ok(Err(error)) => {
					Ok(CommandResult::Consumed(ConsumedResult::status(sf!("Fork failed: {error}"))))
				},
				Err(_) => Ok(CommandResult::Consumed(ConsumedResult::status(
					"Fork failed: agent reply channel is closed.",
				))),
			}
		})
	}

	fn branch_tree(&mut self) -> CommandFuture<'_> {
		let result = (|| -> miette::Result<Str> {
			let current = SessionId(self.state.session_id.clone());
			let root_id = self
				.session_index
				.lineage(&current)
				.into_diagnostic()?
				.first()
				.map_or_else(|| current.0.clone(), |link| link.id.0.clone());
			let tree = SessionTree::load(
				&self
					.state
					.sessions_dir
					.join(sf!("{root_id}.jsonl").as_str()),
			)
			.map_err(|error| miette::miette!("{error}"))?;
			Ok(Str::from(omp_driver::export::render_lineage(&tree, current.0.as_str())))
		})();
		Box::pin(async move { Ok(CommandResult::Consumed(ConsumedResult::status(result?))) })
	}

	fn session(&mut self, request: SessionRequest) -> CommandFuture<'_> {
		match request {
			SessionRequest::Info => {
				let environment = self.state.environment.clone();
				let state = &mut *self.state;
				let session_index = self.session_index;
				Box::pin(async move {
					if let Ok(response) = environment.lsp_status(false).await {
						state.lsp_servers = response.servers;
					}
					let report =
						commands::session::render_info(&session_info_facts(state, session_index));
					Ok(CommandResult::Consumed(ConsumedResult::status(report)))
				})
			},
			SessionRequest::Delete { force } => {
				if chat_active(self.state.submit_pending, self.bus.phase()) {
					return Box::pin(async {
						Ok(CommandResult::Consumed(ConsumedResult::status(
							"Wait for the active turn to finish before deleting this session.",
						)))
					});
				}
				let sessions_dir = self.state.sessions_dir.clone();
				let session_id = self.state.session_id.clone();
				let path = self.state.session_path.clone();
				if !path.is_file() {
					return Box::pin(async {
						Ok(CommandResult::Consumed(ConsumedResult::status(
							"Session has not been saved yet.",
						)))
					});
				}
				let now = Instant::now();
				if !force
					&& self
						.state
						.pending_session_delete
						.is_none_or(|started| now.duration_since(started) > Duration::from_secs(30))
				{
					self.state.pending_session_delete = Some(now);
					return Box::pin(async {
						Ok(CommandResult::Consumed(ConsumedResult::status(
							"Run `/session delete` again within 30 seconds to permanently delete this \
							 session.",
						)))
					});
				}
				self.state.pending_session_delete = None;
				Box::pin(async move {
					let (reply_tx, reply_rx) = flume::bounded(1);
					self
						.commands_tx
						.send_async(UiCmd::DeleteCurrentSession { path, reply: reply_tx })
						.await
						.into_diagnostic()?;
					match reply_rx.recv_async().await {
						Ok(Ok(())) => {
							let pins = PinStore::new(&sessions_dir);
							match pins.load() {
								Ok(pinned) if pinned.contains(session_id.as_str()) => {
									if let Err(error) = pins.toggle(&SessionId(session_id)) {
										tracing::warn!(%error, "failed to remove deleted session pin");
									}
								},
								Ok(_) => {},
								Err(error) => {
									tracing::warn!(%error, "failed to inspect deleted session pin");
								},
							}
							send_backend(self.backend, BackendEvent::NewSessionRequested);
							Ok(CommandResult::Consumed(ConsumedResult::silent()))
						},
						Ok(Err(error)) => Ok(CommandResult::Consumed(ConsumedResult::status(sf!(
							"Failed to delete session: {error}"
						)))),
						Err(_) => Ok(CommandResult::Consumed(ConsumedResult::status(
							"Failed to delete session: agent reply channel is closed.",
						))),
					}
				})
			},
			SessionRequest::Pin(selector) => {
				let session = if let Some(selector) = selector {
					let choices = match (self.list_sessions)() {
						Ok(choices) => choices,
						Err(error) => return Box::pin(async move { Err(error) }),
					};
					match pin_target(&selector, &choices) {
						Ok(session) => session,
						Err(message) => {
							return Box::pin(async move {
								Ok(CommandResult::Consumed(ConsumedResult::status(message)))
							});
						},
					}
				} else {
					self.state.session_id.clone()
				};
				let result = PinStore::new(&self.state.sessions_dir)
					.toggle(&SessionId(session))
					.into_diagnostic();
				Box::pin(async move {
					let pinned = result?;
					let status = if pinned {
						"Session pinned to the top of the resume list."
					} else {
						"Session unpinned."
					};
					Ok(CommandResult::Consumed(ConsumedResult::status(status)))
				})
			},
		}
	}

	fn workspace(&mut self, request: WorkspaceRequest) -> CommandFuture<'_> {
		let control = self.control.clone();
		let current = PathBuf::from(self.state.workspace_root.as_str());
		Box::pin(async move {
			let status = match request {
				WorkspaceRequest::List => {
					let roots = control.workspace_roots().await.into_diagnostic()?;
					commands::workspace::render(&roots, &current)
				},
				WorkspaceRequest::Move(raw) => {
					let root = commands::workspace::canonical_directory(&current, raw.as_str()).await?;
					let roots = control.workspace_roots().await.into_diagnostic()?;
					if roots.primary() == root {
						sf!("The future primary workspace root is already `{}`.", root.display())
					} else {
						let source_path = self.state.session_path.clone();
						let source_default = omp_env::project_state::directory(self.data_dir, &current)
							.into_diagnostic()?
							.join("sessions");
						let uses_project_store = self.state.sessions_dir == source_default;
						let destination_state =
							omp_env::project_state::directory(self.data_dir, &root).into_diagnostic()?;
						let destination_dir = if uses_project_store {
							destination_state.join("sessions")
						} else {
							self.state.sessions_dir.clone()
						};
						fs::create_dir_all(&destination_dir).into_diagnostic()?;
						let destination_path = destination_dir.join(
							source_path
								.file_name()
								.ok_or_else(|| miette::miette!("active session path has no filename"))?,
						);
						let destination_index = if uses_project_store {
							Some(
								SessionIndex::open(destination_state.join("sessions.sqlite3"))
									.into_diagnostic()?,
							)
						} else {
							None
						};
						let destination_index = destination_index.as_ref().unwrap_or(self.session_index);
						let moved_file = destination_path != source_path;
						if moved_file {
							omp_driver::session_state::relocate_journal(&source_path, &destination_path)
								.into_diagnostic()?;
						}
						let session_id = SessionId(self.state.session_id.clone());
						let root_text = root.to_string_lossy();
						match self.session_index.relocate_session(
							destination_index,
							&session_id,
							root_text.as_ref(),
							root_text.as_ref(),
						) {
							Ok(true) => {},
							Ok(false) => {
								if moved_file {
									let _ = omp_driver::session_state::relocate_journal(
										&destination_path,
										&source_path,
									);
								}
								return Err(miette::miette!("active session is absent from its index"));
							},
							Err(error) => {
								if moved_file {
									let _ = omp_driver::session_state::relocate_journal(
										&destination_path,
										&source_path,
									);
								}
								return Err(miette::miette!(error));
							},
						}
						if let Err(error) = control.move_workspace_root(now_ms(), root.clone()).await {
							let current_text = current.to_string_lossy();
							let _ = destination_index.relocate_session(
								self.session_index,
								&session_id,
								current_text.as_ref(),
								current_text.as_ref(),
							);
							if moved_file {
								let _ = omp_driver::session_state::relocate_journal(
									&destination_path,
									&source_path,
								);
							}
							return Err(error).into_diagnostic();
						}
						self.state.session_path = destination_path;
						self.state.sessions_dir = destination_dir;
						sf!(
							"Session storage moved to `{}` and future workspace root set to `{}`. Resume \
							 this session for the workspace change to take effect.",
							self.state.session_path.display(),
							root.display()
						)
					}
				},
				WorkspaceRequest::Add(_) => {
					return Err(commands::workspace::mutation_unavailable("dir add"));
				},
				WorkspaceRequest::Remove(_) => {
					return Err(commands::workspace::mutation_unavailable("dir remove"));
				},
			};
			Ok(CommandResult::Consumed(ConsumedResult::status(status)))
		})
	}

	fn debug(&mut self, inspector: Option<Str>) -> CommandFuture<'_> {
		if inspector.as_deref() == Some("raw-stream") {
			let capture = omp_inference::transport::global_provider_capture();
			let snapshot = capture.snapshot(Some(self.state.session_id.as_str()));
			self.state.raw_stream = Some(capture.subscribe(Some(self.state.session_id.as_str())));
			send_backend(self.backend, BackendEvent::OpenRawStream {
				frames:  snapshot.frames.into_iter().map(raw_frame).collect(),
				summary: stream_summary(snapshot.summary),
			});
			return silent_command();
		}
		let rendered = commands::render_debug(
			inspector.as_deref(),
			self.data_dir,
			self.state.workspace_root.as_str(),
			self.state.session_id.as_str(),
			&self.state.session_path,
		);
		Box::pin(async move { Ok(CommandResult::Consumed(ConsumedResult::status(rendered?))) })
	}
}

impl<C, R> ModelCommandHost for LiveCommandHost<'_, C, R>
where
	C: TurnClient + Clone + Send + 'static,
	R: FnMut() -> miette::Result<Vec<ResumeChoice>> + Send,
{
	fn model(&mut self, selector: Option<Str>) -> CommandFuture<'_> {
		self.select_model(selector, true)
	}

	fn switch(&mut self, selector: Option<Str>) -> CommandFuture<'_> {
		self.select_model(selector, false)
	}

	fn extended_context(&mut self, action: Str) -> CommandFuture<'_> {
		Box::pin(async move {
			if chat_active(self.state.submit_pending, self.bus.phase()) {
				return Ok(CommandResult::Consumed(ConsumedResult::status(
					"Wait for the active turn to finish before changing extended context.",
				)));
			}
			let selection =
				commands::resolve_extended_context(self.state.model.as_str(), action.as_str())?;
			if let Some(target) = selection.target.as_ref() {
				switch_model(
					self.backend,
					self.agent_state,
					self.settings_manager,
					target.as_str(),
					self.state,
					self.control,
					&self.parent,
					false,
				)
				.await;
				if self.state.model.as_str() != target.as_str() {
					return Ok(CommandResult::Consumed(ConsumedResult::silent()));
				}
			}
			let window = selection
				.window
				.map_or_else(|| "unknown".to_owned(), |tokens| format!("{tokens} tokens"));
			Ok(CommandResult::Consumed(ConsumedResult::status(sf!(
				"Extended context is {} for `{}` ({window}).",
				if selection.enabled { "on" } else { "off" },
				self.state.model,
			))))
		})
	}
}

impl<C, R> ConfigCommandHost for LiveCommandHost<'_, C, R>
where
	C: TurnClient + Clone + Send + 'static,
	R: FnMut() -> miette::Result<Vec<ResumeChoice>> + Send,
{
	fn settings(&mut self) -> CommandFuture<'_> {
		send_backend(self.backend, BackendEvent::SettingsSchema(setting_rows(&self.state.settings)));
		silent_command()
	}

	fn setup(&mut self, section: Option<Str>) -> CommandFuture<'_> {
		if section.is_some_and(|section| !section.trim().eq_ignore_ascii_case("providers")) {
			return Box::pin(async {
				Ok(CommandResult::Consumed(ConsumedResult::status("Usage: /setup [providers]")))
			});
		}
		if self.auth.is_none() {
			send_backend(self.backend, BackendEvent::Error(sf!(GATEWAY_LOGIN_MESSAGE)));
			return silent_command();
		}
		let current = model_provider(self.state.catalog.as_ref(), &self.state.model);
		send_backend(
			self.backend,
			BackendEvent::LoginProviders(provider_rows(
				self.state.catalog.as_ref(),
				current.as_deref(),
			)),
		);
		silent_command()
	}

	fn providers(&mut self) -> CommandFuture<'_> {
		let catalog = self.state.catalog.as_ref();
		let accounts = self
			.auth_control
			.map(|control| control.accounts(None))
			.unwrap_or_default();
		let mut rendered = String::from(
			"# Providers\n\n| Provider | Authentication | Source | Models |\n|---|---|---|---:|\n",
		);
		for provider in catalog.providers() {
			let provider_accounts = accounts
				.iter()
				.filter(|account| account.provider == provider.id)
				.collect::<Vec<_>>();
			let authentication = if provider_accounts.is_empty() {
				"Not authenticated".to_owned()
			} else {
				provider_accounts
					.iter()
					.map(|account| {
						if account.enabled {
							account.principal.as_str().to_owned()
						} else {
							format!("{} (disabled)", account.principal)
						}
					})
					.collect::<Vec<_>>()
					.join(", ")
			};
			let source = if let Some(control) = self.auth_control {
				let sources = provider_accounts
					.iter()
					.map(|account| match control.metadata(&account.account) {
						Ok(Some(metadata)) => format!("stored {}", metadata.kind),
						Ok(None) => "environment or external authority".to_owned(),
						Err(_) => "credential source unavailable".to_owned(),
					})
					.collect::<Vec<_>>();
				if sources.is_empty() {
					"—".to_owned()
				} else {
					sources.join(", ")
				}
			} else {
				"live authority unavailable".to_owned()
			};
			let models = catalog
				.models()
				.iter()
				.filter(|model| {
					model.routes.iter().any(|route| {
						catalog
							.route(route)
							.is_some_and(|route| route.provider == provider.id)
					})
				})
				.collect::<Vec<_>>();
			let available = models
				.iter()
				.filter(|model| model.availability == omp_catalog::ModelAvailability::Available)
				.count();
			let login_required = models
				.iter()
				.filter(|model| model.availability == omp_catalog::ModelAvailability::LoginRequired)
				.count();
			let unavailable = models.len().saturating_sub(available + login_required);
			let model_status =
				format!("{available} available, {login_required} login, {unavailable} unavailable");
			rendered.push_str(&format!(
				"| {} (`{}`) | {} | {} | {} |\n",
				provider.name, provider.id, authentication, source, model_status
			));
		}
		Box::pin(
			async move { Ok(CommandResult::Consumed(ConsumedResult::status(Str::from(rendered)))) },
		)
	}

	fn login(&mut self, provider: Option<Str>) -> CommandFuture<'_> {
		handle_login(self.backend, self.auth, provider, self.state);
		silent_command()
	}

	fn logout(&mut self, provider: Option<Str>) -> CommandFuture<'_> {
		let Some(control) = self.auth_control else {
			send_backend(self.backend, BackendEvent::Error(sf!(GATEWAY_LOGIN_MESSAGE)));
			return silent_command();
		};
		let accounts = control.accounts(None);
		let requested = provider;
		let Some(requested) = requested else {
			let rows = self
				.state
				.catalog
				.providers()
				.iter()
				.filter_map(|provider| {
					let count = accounts
						.iter()
						.filter(|account| account.provider == provider.id)
						.filter(|account| control.metadata(&account.account).ok().flatten().is_some())
						.count();
					(count > 0).then(|| SessionRow {
						id:     Str::from(provider.id.as_str()),
						label:  provider.name.clone(),
						detail: sf!("{count} stored account(s)"),
						pinned: false,
					})
				})
				.collect::<Vec<_>>();
			if rows.is_empty() {
				return Box::pin(async {
					Ok(CommandResult::Consumed(ConsumedResult::status(
						"No stored provider credentials to log out. Remove environment or external \
						 authentication at its source.",
					)))
				});
			}
			send_backend(self.backend, BackendEvent::LogoutChoices {
				title: sf!("Logout from provider"),
				rows,
			});
			return silent_command();
		};
		if let Some(account) = accounts.iter().find(|account| {
			account.account.as_str() == requested.as_str()
				&& control.metadata(&account.account).ok().flatten().is_some()
		}) {
			let account_id = account.account.clone();
			let provider = account.provider.clone();
			let label = Str::from(account.principal.as_str());
			let control = control.clone();
			return Box::pin(async move {
				match control.delete(account_id).await {
					Ok(()) => Ok(CommandResult::Consumed(ConsumedResult::status(sf!(
						"Successfully logged out {label} from {provider}. Credential removed from the \
						 live authentication store."
					)))),
					Err(error) => {
						Ok(CommandResult::Consumed(ConsumedResult::status(sf!("Logout failed: {error}"))))
					},
				}
			});
		}
		let Some(provider) = self
			.state
			.catalog
			.provider(&ProviderId::from_ref(requested.as_str()))
		else {
			send_backend(
				self.backend,
				BackendEvent::Error(sf!("Unknown OAuth provider: {requested}")),
			);
			return silent_command();
		};
		let rows = accounts
			.iter()
			.filter(|account| account.provider == provider.id)
			.filter(|account| control.metadata(&account.account).ok().flatten().is_some())
			.map(|account| {
				let source = match control.metadata(&account.account) {
					Ok(Some(metadata)) => sf!("stored {}", metadata.kind),
					Ok(None) => sf!("environment or external authority"),
					Err(_) => sf!("credential source unavailable"),
				};
				SessionRow {
					id:     Str::from(account.account.as_str()),
					label:  Str::from(account.principal.as_str()),
					detail: if account.enabled {
						source
					} else {
						sf!("{source} · disabled")
					},
					pinned: false,
				}
			})
			.collect::<Vec<_>>();
		if rows.is_empty() {
			return Box::pin(async move {
				Ok(CommandResult::Consumed(ConsumedResult::status(sf!(
					"Logout skipped: no stored credentials for {requested}. Current authentication, if \
					 any, comes from an environment or external source; remove that source to log out."
				))))
			});
		}
		send_backend(self.backend, BackendEvent::LogoutChoices {
			title: sf!("Logout from {}", provider.name),
			rows,
		});
		silent_command()
	}
}

fn setting_rows(settings: &Settings) -> Vec<omp_chat_ui::SettingRow> {
	let document =
		toml::Value::try_from(settings).unwrap_or_else(|_| toml::Value::Table(toml::Table::new()));
	let mut rows = omp_settings::registered_domains()
		.into_iter()
		.flat_map(|domain| {
			let document = &document;
			domain.fields.iter().map(move |field| {
				let kind: &'static str = field.kind.into();
				let value = (!field.secret)
					.then(|| toml_value_at(document, field.path))
					.flatten()
					.map(toml_setting_value);
				let options = match field.kind {
					omp_settings::SettingKind::Enum(options) => {
						options.iter().copied().map(Str::new).collect()
					},
					_ => Vec::new(),
				};
				let visible = field.condition.is_none_or(|condition| {
					toml_value_at(document, condition.field)
						.is_some_and(|value| toml_setting_value(value).as_str() == condition.equals)
				});
				let panel = omp_settings::manager::panel_for_field(domain.name, field.path);
				(field.order, omp_chat_ui::SettingRow {
					panel: sf!(panel),
					domain: sf!(domain.name),
					path: sf!(field.path),
					label: sf!(field.label),
					description: sf!(field.description),
					kind: sf!(kind),
					secret: field.secret,
					value,
					options,
					visible,
				})
			})
		})
		.collect::<Vec<_>>();
	rows.sort_by_key(|(order, row)| {
		let panel = omp_settings::manager::EDITOR_PANELS
			.iter()
			.position(|panel| *panel == row.panel.as_str())
			.unwrap_or(omp_settings::manager::EDITOR_PANELS.len());
		(panel, *order, row.path.clone())
	});
	rows.into_iter().map(|(_, row)| row).collect()
}

fn toml_value_at<'a>(document: &'a toml::Value, path: &str) -> Option<&'a toml::Value> {
	path
		.split('.')
		.try_fold(document, |value, segment| value.get(segment))
}

fn toml_setting_value(value: &toml::Value) -> Str {
	match value {
		toml::Value::String(value) => Str::new(value),
		_ => Str::from(value.to_string()),
	}
}
fn apply_setting_changes(
	settings: &mut Settings,
	changes: &[omp_chat_ui::SettingChange],
) -> miette::Result<()> {
	let mut document = toml::Value::try_from(&*settings).into_diagnostic()?;
	let domains = omp_settings::registered_domains();
	for change in changes {
		let field = domains
			.iter()
			.flat_map(|domain| domain.fields)
			.find(|field| field.path == change.path.as_str())
			.ok_or_else(|| miette::miette!("unknown setting `{}`", change.path))?;
		let raw = match &change.value {
			serde_json::Value::String(value) => value.clone(),
			value => value.to_string(),
		};
		let value = field.parse(&raw).into_diagnostic()?;
		set_toml_value(&mut document, field.path, value)?;
	}
	*settings = document.try_into().into_diagnostic()?;
	Ok(())
}

fn set_toml_value(
	document: &mut toml::Value,
	path: &str,
	value: toml::Value,
) -> miette::Result<()> {
	let mut segments = path.split('.').peekable();
	let mut cursor = document;
	while let Some(segment) = segments.next() {
		if segments.peek().is_none() {
			let table = cursor
				.as_table_mut()
				.ok_or_else(|| miette::miette!("setting parent for `{path}` is not a table"))?;
			table.insert(segment.to_owned(), value);
			return Ok(());
		}
		let table = cursor
			.as_table_mut()
			.ok_or_else(|| miette::miette!("setting parent for `{path}` is not a table"))?;
		cursor = table
			.entry(segment)
			.or_insert_with(|| toml::Value::Table(toml::Table::new()));
	}
	Err(miette::miette!("setting path is empty"))
}

const fn status_thinking_level(effort: Effort) -> Option<StatusThinkingLevel> {
	match effort {
		Effort::Minimal => Some(StatusThinkingLevel::Minimal),
		Effort::Low => Some(StatusThinkingLevel::Low),
		Effort::Medium => Some(StatusThinkingLevel::Medium),
		Effort::High => Some(StatusThinkingLevel::High),
		Effort::Xhigh => Some(StatusThinkingLevel::Xhigh),
		Effort::Max => Some(StatusThinkingLevel::Max),
		_ => None,
	}
}

fn cycle_interactive_thinking(agent_state: &AgentState, state: &mut BridgeState) {
	use omp_proto::inference::v1::Reasoning;

	const LEVELS: [Effort; 7] = [
		Effort::Off,
		Effort::Minimal,
		Effort::Low,
		Effort::Medium,
		Effort::High,
		Effort::Xhigh,
		Effort::Max,
	];
	let current = agent_state
		.snapshot()
		.turn
		.params
		.thinking
		.as_ref()
		.and_then(|reasoning| Effort::try_from(reasoning.effort).ok())
		.unwrap_or(Effort::Off);
	let at = LEVELS
		.iter()
		.position(|effort| *effort == current)
		.unwrap_or(0);
	let next = LEVELS[(at + 1) % LEVELS.len()];
	agent_state.update(|snapshot| {
		snapshot.turn.params.thinking =
			Some(Reasoning { effort: next as i32, ..Reasoning::default() });
	});
	state.thinking = status_thinking_level(next);
}

async fn mutate_mcp(
	environment: &omp_env::EnvClient,
	action: McpConfigAction,
	name: &str,
) -> miette::Result<Str> {
	environment
		.mcp_config(McpConfigRequest {
			action:        action as i32,
			scope:         McpConfigScope::Project as i32,
			name:          name.to_owned(),
			server_json:   Bytes::new(),
			wire_revision: omp_proto::SCHEMA_REV,
		})
		.await
		.into_diagnostic()?;
	Ok(sf!("MCP server `{name}` updated."))
}

const PLAN_SAVE_STEM_MAX_LENGTH: usize = 32;
const PLAN_SAVE_TITLE_LINE_LIMIT: usize = 6;

/// Builds a safe suggested destination for approved plan Markdown.
pub fn plan_save_file_name(title: &str) -> Str {
	let mut stem = title
		.split(|character: char| !character.is_alphanumeric())
		.filter(|word| !word.is_empty())
		.map(str::to_uppercase)
		.collect::<Vec<_>>()
		.join("_");
	if stem.len() > PLAN_SAVE_STEM_MAX_LENGTH {
		let boundary = stem
			.char_indices()
			.take_while(|(index, _)| *index <= PLAN_SAVE_STEM_MAX_LENGTH)
			.map(|(index, _)| index)
			.last()
			.unwrap_or(0);
		let boundary = stem[..boundary]
			.rfind('_')
			.filter(|boundary| *boundary > 0)
			.unwrap_or(boundary);
		stem.truncate(boundary);
	}
	if stem.is_empty() || stem == "PLAN" {
		return Str::new_static("PLAN.md");
	}
	if !stem.ends_with("_PLAN") {
		stem.push_str("_PLAN");
	}
	stem.push_str(".md");
	Str::from(stem)
}

fn plan_save_excerpt(content: &str) -> String {
	content
		.lines()
		.map(str::trim)
		.filter(|line| !line.is_empty())
		.take(PLAN_SAVE_TITLE_LINE_LIMIT)
		.collect::<Vec<_>>()
		.join("\n")
}

fn plan_save_fallback_title(content: &str) -> &str {
	content
		.lines()
		.map(str::trim)
		.find(|line| !line.is_empty())
		.map(|line| line.trim_start_matches('#').trim())
		.filter(|line| !line.is_empty())
		.unwrap_or("PLAN")
}

async fn plan_save_suggested_path<C>(parent: &ChatParentHost<C>, content: &str) -> Str
where
	C: TurnClient + Clone + Send + 'static,
{
	let excerpt = plan_save_excerpt(content);
	let generated = if excerpt.is_empty() {
		None
	} else {
		generate_online_title(
			parent,
			excerpt.as_str(),
			prompt_asset(PromptAssetId::PlanFilename).content,
		)
		.await
	};
	plan_save_file_name(
		generated
			.as_deref()
			.unwrap_or_else(|| plan_save_fallback_title(content)),
	)
}

async fn invoke_plan_write(
	environment: &omp_env::EnvClient,
	path: Str,
	content: Str,
) -> miette::Result<()> {
	use omp_proto::env::v1;

	let id = sf!("plan-save-{}", omp_core::Ulid::generate());
	let mut invocation = environment
		.invoke(v1::InvokeTool {
			invocation_id: id.to_string(),
			name: "write".to_owned(),
			rev: "1".to_owned(),
			..Default::default()
		})
		.await
		.into_diagnostic()?;
	if !matches!(
		invocation.next_event().await.into_diagnostic()?,
		Some(omp_env::InvocationEvent::Accepted(_))
	) {
		return Err(miette::miette!("plan write invocation was not accepted"));
	}
	invocation
		.commit_args(
			Bytes::from(
				serde_json::to_vec(&omp_tools::write::Params { path, content }).into_diagnostic()?,
			),
			Bytes::from_static(b"plan-save"),
			now_ms(),
			None,
		)
		.await
		.into_diagnostic()?;
	loop {
		match invocation.next_event().await.into_diagnostic()? {
			Some(omp_env::InvocationEvent::Verdict(verdict)) => {
				if verdict.is_error {
					return Err(miette::miette!("plan write failed in the Environment"));
				}
				let outcome = serde_json::from_slice::<
					omp_tool::CallOutcome<omp_tools::write::Payload, omp_tools::write::Fault>,
				>(&verdict.json)
				.into_diagnostic()?;
				return match outcome {
					omp_tool::CallOutcome::Ok(_) => Ok(()),
					omp_tool::CallOutcome::Faulted(fault) => Err(miette::miette!("{fault}")),
					omp_tool::CallOutcome::ArgsRejected(_) => {
						Err(miette::miette!("plan save path or content was rejected"))
					},
					omp_tool::CallOutcome::Aborted { .. } => {
						Err(miette::miette!("plan save was aborted"))
					},
				};
			},
			Some(omp_env::InvocationEvent::Update(_)) => {},
			Some(omp_env::InvocationEvent::Admission(_)) => {
				return Err(miette::miette!("plan save unexpectedly requires admission"));
			},
			Some(omp_env::InvocationEvent::Accepted(_)) => {
				return Err(miette::miette!("plan write invocation was accepted twice"));
			},
			None => return Err(miette::miette!("plan write ended without a verdict")),
		}
	}
}

fn todo_hud(payload: &todo::Payload) -> omp_chat_ui::TodoHud {
	omp_chat_ui::TodoHud {
		lines:       payload.rendered.lines().map(Str::from).collect(),
		total_tasks: payload.phases.iter().map(|phase| phase.items.len()).sum(),
	}
}

async fn invoke_todo(
	environment: &omp_env::EnvClient,
	params: &omp_tools::todo::Params,
) -> miette::Result<todo::Payload> {
	use omp_proto::env::v1;

	let id = sf!("slash-todo-{}", omp_core::Ulid::generate());
	let mut invocation = environment
		.invoke(v1::InvokeTool {
			invocation_id: id.to_string(),
			name: "todo".to_owned(),
			rev: "1".to_owned(),
			..Default::default()
		})
		.await
		.into_diagnostic()?;
	if !matches!(
		invocation.next_event().await.into_diagnostic()?,
		Some(omp_env::InvocationEvent::Accepted(_))
	) {
		return Err(miette::miette!("todo invocation was not accepted"));
	}
	invocation
		.commit_args(
			Bytes::from(serde_json::to_vec(params).into_diagnostic()?),
			Bytes::from_static(b"slash-todo"),
			now_ms(),
			None,
		)
		.await
		.into_diagnostic()?;
	loop {
		match invocation.next_event().await.into_diagnostic()? {
			Some(omp_env::InvocationEvent::Verdict(verdict)) => {
				if verdict.is_error {
					return Err(miette::miette!("todo Environment invocation failed"));
				}
				let outcome =
					serde_json::from_slice::<omp_tool::CallOutcome<todo::Payload, todo::Fault>>(
						&verdict.json,
					)
					.into_diagnostic()?;
				return match outcome {
					omp_tool::CallOutcome::Ok(payload) => Ok(payload),
					omp_tool::CallOutcome::Faulted(fault) => Err(miette::miette!("{fault}")),
					omp_tool::CallOutcome::ArgsRejected(_) => {
						Err(miette::miette!("todo arguments were rejected"))
					},
					omp_tool::CallOutcome::Aborted { .. } => {
						Err(miette::miette!("todo operation was aborted"))
					},
				};
			},
			Some(omp_env::InvocationEvent::Update(_)) => {},
			Some(omp_env::InvocationEvent::Admission(_)) => {
				return Err(miette::miette!("todo operation unexpectedly requires admission"));
			},
			Some(omp_env::InvocationEvent::Accepted(_)) => {
				return Err(miette::miette!("todo invocation was accepted twice"));
			},
			None => return Err(miette::miette!("todo invocation ended without a verdict")),
		}
	}
}

fn todo_params(
	args: &str,
	current: &[omp_tools::todo::Phase],
) -> miette::Result<omp_tools::todo::Params> {
	use omp_tools::todo::Params;
	let args = args.trim();
	let (verb, rest) = args.split_once(char::is_whitespace).unwrap_or((args, ""));
	let rest = rest.trim();
	let blank = || Params {
		op:     todo::Op::View,
		list:   None,
		phase:  None,
		item:   None,
		items:  None,
		reason: None,
	};
	match verb {
		"" | "show" | "view" => Ok(blank()),
		"append" => {
			let words = input::tokenize_args(rest).map_err(|error| miette::miette!("{error}"))?;
			if words.is_empty() {
				return Err(miette::miette!("usage: /todo append [phase] <task>"));
			}
			let (phase, text) = if words.len() == 1 {
				(
					current
						.last()
						.map_or_else(|| sf!("Todos"), |phase| phase.phase.clone()),
					words[0].clone(),
				)
			} else {
				(
					words[0].clone(),
					Str::from(
						words[1..]
							.iter()
							.map(Str::as_str)
							.collect::<Vec<_>>()
							.join(" "),
					),
				)
			};
			Ok(Params { op: todo::Op::Append, phase: Some(phase), items: Some(vec![text]), ..blank() })
		},
		"start" | "done" | "drop" | "rm" => {
			let op = match verb {
				"start" => todo::Op::Start,
				"done" => todo::Op::Done,
				"drop" => todo::Op::Drop,
				"rm" => todo::Op::Rm,
				_ => unreachable!(),
			};
			if op == todo::Op::Start && rest.is_empty() {
				return Err(miette::miette!("usage: /todo start <task>"));
			}
			let mut params = blank();
			params.op = op;
			if !rest.is_empty() {
				if let Some((phase, item)) = omp_tools::todo::resolve_item(current, rest) {
					params.phase = Some(current[phase].phase.clone());
					params.item = Some(current[phase].items[item].text.clone());
				} else if let Some(phase) = omp_tools::todo::resolve_phase_index(current, rest) {
					params.phase = Some(current[phase].phase.clone());
				} else {
					return Err(miette::miette!("no todo task or phase matched `{rest}`"));
				}
			}
			Ok(params)
		},
		"help" | "?" => Ok(blank()),
		_ => Err(miette::miette!(
			"usage: /todo [show|append|start|done|drop|rm|copy|import|export|edit|help]",
		)),
	}
}

fn extension_live_tools(registry: &Registry) -> Vec<omp_chat_ui::LiveToolView> {
	registry
		.devices()
		.filter_map(|device| {
			let input_schema = serde_json::from_slice(device.schema).ok()?;
			Some(omp_chat_ui::LiveToolView {
				name: device.name.clone(),
				label: None,
				description: Some(device.summary.clone()),
				input_schema,
				source_path: None,
				hidden: false,
				source: Str::new_static(if device.claimant.starts_with("omp/") {
					"builtin"
				} else {
					"extension"
				}),
			})
		})
		.collect()
}

fn advisor_status(status: &AdvisorEngineStatus) -> Str {
	use std::fmt::Write as _;

	let mut rendered = String::new();
	let enabled = if status.enabled {
		"enabled"
	} else {
		"disabled"
	};
	let _ = write!(
		rendered,
		"**Advisor {enabled}** · {} worker{}",
		status.advisors.len(),
		if status.advisors.len() == 1 { "" } else { "s" },
	);
	for advisor in &status.advisors {
		let micro = advisor.usage.cost_micro_usd.max(0);
		let dollars = micro / 1_000_000;
		let fraction = micro % 1_000_000;
		let _ = write!(
			rendered,
			"\n- **{}** (`{}`) · {} · `{}` · {} message{} · ${dollars}.{fraction:06}",
			advisor.display_name,
			advisor.id,
			advisor.state,
			advisor.model,
			advisor.messages,
			if advisor.messages == 1 { "" } else { "s" },
		);
	}
	rendered.into()
}

impl<C, R> FlowCommandHost for LiveCommandHost<'_, C, R>
where
	C: TurnClient + Clone + Send + 'static,
	R: FnMut() -> miette::Result<Vec<ResumeChoice>> + Send,
{
	fn context(&mut self) -> CommandFuture<'_> {
		let Some(snapshot) = self.state.context_snapshot.as_ref() else {
			return self.unavailable("No complete context receipt has been projected yet.");
		};
		let rendered = commands::context::render(snapshot);
		Box::pin(async move { Ok(CommandResult::Consumed(ConsumedResult::status(rendered))) })
	}

	fn compact(&mut self, request: omp_agent::ManualCompactionRequest) -> CommandFuture<'_> {
		Box::pin(async move {
			self
				.commands_tx
				.send_async(UiCmd::Compact { request })
				.await
				.into_diagnostic()?;
			Ok(CommandResult::Consumed(ConsumedResult::silent()))
		})
	}

	fn shake(&mut self, args: Str) -> CommandFuture<'_> {
		let mode = match args.trim().as_str() {
			"" | "elide" => omp_agent::ManualShakeMode::Elide,
			"drop-media" | "images" => omp_agent::ManualShakeMode::DropMedia,
			"thinking" => omp_agent::ManualShakeMode::Thinking,
			_ => {
				return self.unavailable("usage: /shake [elide|drop-media|thinking]");
			},
		};
		Box::pin(async move {
			self
				.commands_tx
				.send_async(UiCmd::Shake { mode })
				.await
				.into_diagnostic()?;
			Ok(CommandResult::Consumed(ConsumedResult::silent()))
		})
	}

	fn usage(&mut self, args: Str) -> CommandFuture<'_> {
		Box::pin(async move {
			let trimmed = args.trim();
			let rendered = if trimmed.is_empty() || trimmed.as_str() == "show" {
				crate::usage_cmd::render_report(self.data_dir).await?
			} else if trimmed.as_str() == "reset" {
				crate::usage_cmd::reset_usage(self.data_dir, "").await?
			} else if let Some(target) = trimmed.as_str().strip_prefix("reset ") {
				crate::usage_cmd::reset_usage(self.data_dir, target).await?
			} else {
				Str::new_static("Usage: /usage [show|reset [account|active]]")
			};
			Ok(CommandResult::Consumed(ConsumedResult::status(rendered)))
		})
	}

	fn stats(&mut self, flags: ParsedFlags) -> CommandFuture<'_> {
		Box::pin(async move {
			let launch = crate::stats_cmd::launch_dashboard(self.data_dir, &flags.0).await?;
			Ok(CommandResult::Consumed(ConsumedResult::status(launch.message)))
		})
	}

	fn plan(&mut self, args: Str) -> CommandFuture<'_> {
		Box::pin(async move {
			handle_plan_command(
				self.backend,
				self.commands_tx,
				self.control,
				self.modes,
				self.abort,
				chat_active(self.state.submit_pending, self.bus.phase()),
				args.as_str(),
			)
			.await;
			Ok(CommandResult::Consumed(ConsumedResult::silent()))
		})
	}

	fn vibe(&mut self, args: Str) -> CommandFuture<'_> {
		Box::pin(async move {
			handle_vibe_command(self.backend, self.commands_tx, self.modes, args.as_str()).await;
			Ok(CommandResult::Consumed(ConsumedResult::silent()))
		})
	}

	fn todo(&mut self, args: Str) -> CommandFuture<'_> {
		Box::pin(async move {
			if matches!(args.trim().as_str(), "help" | "?") {
				return Ok(CommandResult::Consumed(ConsumedResult::status(
					"`/todo`; `/todo append [phase] <task>`; `/todo start <task>`; `/todo done|drop|rm \
					 [task|phase]`; `/todo copy`; `/todo expand`; `/todo collapse`",
				)));
			}
			match args.trim().as_str() {
				"expand" => {
					send_backend(self.backend, BackendEvent::TodoExpanded(true));
					return Ok(CommandResult::Consumed(ConsumedResult::silent()));
				},
				"collapse" => {
					send_backend(self.backend, BackendEvent::TodoExpanded(false));
					return Ok(CommandResult::Consumed(ConsumedResult::silent()));
				},
				_ => {},
			}
			let view = invoke_todo(&self.state.environment, &omp_tools::todo::Params {
				op:     todo::Op::View,
				list:   None,
				phase:  None,
				item:   None,
				items:  None,
				reason: None,
			})
			.await?;
			if args.trim() == "copy" {
				if view.phases.is_empty() {
					return Ok(CommandResult::Consumed(ConsumedResult::status("No todos to copy.")));
				}
				let markdown = view.rendered.clone();
				let copied =
					tokio::task::spawn_blocking(move || omp_tui::paste::write_clipboard_text(&markdown))
						.await
						.unwrap_or(false);
				if !copied {
					return Err(miette::miette!("system clipboard is unavailable"));
				}
				return Ok(CommandResult::Consumed(ConsumedResult::status(
					"Copied todos as Markdown.",
				)));
			}
			let params = todo_params(&args, &view.phases)?;
			let payload = if params.op == todo::Op::View {
				view
			} else {
				let payload = invoke_todo(&self.state.environment, &params).await?;
				let phases = serde_json::value::to_raw_value(&payload.phases).into_diagnostic()?;
				let (reply, response) = flume::bounded(1);
				self
					.commands_tx
					.send_async(UiCmd::TodoEdited { phases, reply })
					.await
					.into_diagnostic()?;
				match response.recv_async().await {
					Ok(Ok(())) => {},
					Ok(Err(error)) => {
						return Err(miette::miette!("todo edit applied but was not journaled: {error}"));
					},
					Err(_) => {
						return Err(miette::miette!("todo edit applied but the journal owner is gone"));
					},
				}
				payload
			};
			send_backend(self.backend, BackendEvent::TodoHud(todo_hud(&payload)));
			let rendered = if payload.phases.is_empty() {
				sf!("No todos. Use `/todo append <task>` to start one.")
			} else {
				payload.rendered
			};
			Ok(CommandResult::Consumed(ConsumedResult::status(rendered)))
		})
	}

	fn plan_review(&mut self, _: Str) -> CommandFuture<'_> {
		let Some(plan) = self.modes.plan() else {
			return self.unavailable("Plan mode has no active artifact.");
		};
		let store = PlanArtifactStore::new(self.state.local_root.clone());
		match store.resolve(None, plan.artifact.as_str()) {
			Ok(artifact) => {
				send_backend(self.backend, BackendEvent::OpenPlanReview { content: artifact.content });
				silent_command()
			},
			Err(error) => {
				send_backend(self.backend, BackendEvent::Error(Str::new(error.to_string())));
				silent_command()
			},
		}
	}

	fn guided_goal(&mut self, args: Str) -> CommandFuture<'_> {
		Box::pin(async move {
			handle_goal_command(self.backend, self.commands_tx, self.modes, args.as_str()).await;
			Ok(CommandResult::Consumed(ConsumedResult::silent()))
		})
	}

	fn loop_command(&mut self, args: Str) -> CommandFuture<'_> {
		let outcome = match self.modes.toggle_loop(args.as_str(), now_ms()) {
			Ok(outcome) => outcome,
			Err(error) => return Box::pin(async move { Err(miette::miette!("{error}")) }),
		};
		match outcome {
			omp_driver::modes::LoopCommandOutcome::Disabled => Box::pin(async {
				Ok(CommandResult::Consumed(ConsumedResult::status("Loop mode disabled.")))
			}),
			omp_driver::modes::LoopCommandOutcome::Enabled { prompt: None, message } => {
				Box::pin(async move { Ok(CommandResult::Consumed(ConsumedResult::status(message))) })
			},
			omp_driver::modes::LoopCommandOutcome::Enabled { prompt: Some(prompt), message } => {
				send_backend(self.backend, BackendEvent::Notice(message));
				Box::pin(async move {
					Ok(CommandResult::Prompt(commands::PromptResult {
						text:       prompt,
						provenance: commands::CommandProvenance::builtin(),
					}))
				})
			},
		}
	}

	fn queue(&mut self, prompt: Str) -> CommandFuture<'_> {
		if !chat_active(self.state.submit_pending, self.bus.phase()) {
			return Box::pin(async move {
				Ok(CommandResult::Prompt(commands::PromptResult {
					text:       prompt,
					provenance: commands::CommandProvenance::builtin(),
				}))
			});
		}
		let item = input::user_message(prompt.as_str());
		if self
			.mailbox
			.try_enqueue(Interrupt {
				class: InterruptClass::Idle,
				item,
				source: InterruptSource::Producer(sf!("user")),
			})
			.is_err()
		{
			return Box::pin(async { Err(miette::miette!("Agent input channel is closed.")) });
		}
		self.state.queued = self.state.queued.saturating_add(1);
		self
			.state
			.queued_prompts
			.push_back(omp_chat_ui::QueuedPrompt {
				text:        prompt.clone(),
				attachments: Vec::new(),
			});
		send_backend(self.backend, BackendEvent::UserReplayed {
			text:   prompt,
			chips:  Vec::new(),
			queued: true,
		});
		send_status(self.backend, self.state, self.bus, self.dropped);
		Box::pin(async {
			Ok(CommandResult::Consumed(ConsumedResult::status(
				"Queued message for when the agent yields.",
			)))
		})
	}

	fn force(&mut self, args: Str) -> CommandFuture<'_> {
		let args = args.trim();
		let args = args.as_str();
		let (tool, prompt) = args
			.split_once(char::is_whitespace)
			.map_or((args, ""), |(tool, prompt)| (tool, prompt.trim()));
		if tool.is_empty() {
			return self.unavailable("Usage: /force:<tool-name> [prompt]");
		}
		if !self
			.agent_state
			.snapshot()
			.turn
			.params
			.tools
			.iter()
			.any(|candidate| candidate.name == tool)
		{
			let message = sf!("Tool `{tool}` is not active for the current session.");
			return Box::pin(
				async move { Ok(CommandResult::Consumed(ConsumedResult::status(message))) },
			);
		}
		let tool = Str::new(tool);
		let prompt = Str::new(prompt);
		Box::pin(async move {
			self
				.commands_tx
				.send_async(UiCmd::ForceTool { tool: tool.clone() })
				.await
				.into_diagnostic()?;
			let status = sf!("Next turn forced to use {tool}.");
			if prompt.is_empty() {
				return Ok(CommandResult::Consumed(ConsumedResult::status(status)));
			}
			send_backend(self.backend, BackendEvent::Notice(status));
			Ok(CommandResult::Prompt(commands::PromptResult {
				text:       prompt,
				provenance: commands::CommandProvenance::builtin(),
			}))
		})
	}

	fn fast(&mut self, args: Str) -> CommandFuture<'_> {
		let current = self.agent_state.snapshot().turn.params.service_tier
			== omp_proto::inference::v1::ServiceTier::Priority as i32;
		let requested = match args.trim().as_str() {
			"" | "toggle" => Some(!current),
			"on" => Some(true),
			"off" => Some(false),
			"status" => None,
			_ => return self.unavailable("Usage: /fast [on|off|status]"),
		};
		if requested == Some(true) {
			let supported = resolve_model(self.state.catalog.as_ref(), self.state.model.as_str())
				.and_then(|model| model.capabilities.chat.as_ref())
				.and_then(|chat| chat.service_tiers.constraints())
				.is_some_and(|tiers| tiers.iter().any(|tier| tier.priority > 0));
			if !supported {
				return Box::pin(async {
					Ok(CommandResult::Consumed(ConsumedResult::status(
						"Fast mode is unavailable for the current model.",
					)))
				});
			}
		}
		if let Some(enabled) = requested {
			self.agent_state.update(|snapshot| {
				snapshot.turn.params.service_tier = if enabled {
					omp_proto::inference::v1::ServiceTier::Priority as i32
				} else {
					omp_proto::inference::v1::ServiceTier::Unspecified as i32
				};
			});
		}
		let enabled = requested.unwrap_or(current);
		let status = if requested.is_none() {
			if enabled {
				"Fast mode is on."
			} else {
				"Fast mode is off."
			}
		} else if enabled {
			"Fast mode enabled."
		} else {
			"Fast mode disabled."
		};
		Box::pin(async move { Ok(CommandResult::Consumed(ConsumedResult::status(status))) })
	}

	fn prewalk(&mut self, args: Str) -> CommandFuture<'_> {
		match args.trim().as_str() {
			"" | "on" => Box::pin(async move {
				if self.modes.mode_holder().as_deref() == Some("prewalk") {
					return Ok(CommandResult::Consumed(ConsumedResult::status(mode_status(self.modes))));
				}
				let _ = start_mode_regime(
					self.backend,
					self.commands_tx,
					self.modes,
					"prewalk",
					false,
					None,
				)
				.await;
				Ok(CommandResult::Consumed(ConsumedResult::silent()))
			}),
			"off" => Box::pin(async move {
				if self.modes.mode_holder().as_deref() != Some("prewalk") {
					return Ok(CommandResult::Consumed(ConsumedResult::status(mode_status(self.modes))));
				}
				if let Some(activation) = self.modes.mode_activation() {
					let _ =
						stop_mode_regime(self.backend, self.commands_tx, "prewalk", activation).await;
				}
				Ok(CommandResult::Consumed(ConsumedResult::silent()))
			}),
			"status" => {
				let status = mode_status(self.modes);
				Box::pin(async move { Ok(CommandResult::Consumed(ConsumedResult::status(status))) })
			},
			_ => self.unavailable("Usage: /prewalk [on|off|status]"),
		}
	}

	fn btw(&mut self, prompt: Str) -> CommandFuture<'_> {
		let parent = Arc::clone(&self.parent);
		let control = self.control.clone();
		Box::pin(async move {
			let answer = commands::asides::ask_btw(parent.as_ref(), &control, prompt.as_str()).await?;
			Ok(CommandResult::Consumed(ConsumedResult::status(sf!("**BTW**\n\n{}", answer))))
		})
	}

	fn tan(&mut self, prompt: Str) -> CommandFuture<'_> {
		let parent: Arc<dyn omp_envd::eval::ParentSessionHost> = self.parent.clone();
		let job_id =
			commands::asides::spawn_tan(parent, self.backend.clone(), self.bus.clone(), prompt);
		Box::pin(async move {
			Ok(CommandResult::Consumed(ConsumedResult::status(sf!(
				"Dispatched background tan `{job_id}`."
			))))
		})
	}

	fn omfg(&mut self, instruction: Str) -> CommandFuture<'_> {
		let parent: Arc<dyn omp_envd::eval::ParentSessionHost> = self.parent.clone();
		let workspace_root = PathBuf::from(self.state.workspace_root.as_str());
		Box::pin(async move {
			let path =
				commands::asides::forge_ttsr(parent.as_ref(), workspace_root, instruction.as_str())
					.await?;
			Ok(CommandResult::Consumed(ConsumedResult::status(Str::from(format!(
				"Saved durable TTSR rule to `{}`.",
				path.display()
			)))))
		})
	}

	fn live(&mut self, _: Str) -> CommandFuture<'_> {
		toggle_live_voice(self.backend, self.state);
		send_status(self.backend, self.state, self.bus, self.dropped);
		silent_command()
	}

	fn advisor(&mut self, request: AdvisorRequest) -> CommandFuture<'_> {
		let Some(advisor) = self.state.advisor.as_ref() else {
			return self.unavailable("Advisor runtime is not attached to this session.");
		};
		let result = match request {
			AdvisorRequest::Toggle => {
				let mut engine = advisor.lock();
				let enabled = !engine.enabled();
				engine.set_enabled(enabled);
				let status = engine.status();
				tracing::debug!(
					session_id = %self.state.session_id,
					enabled = status.enabled,
					advisor_count = status.advisors.len(),
					"advisor state changed"
				);
				advisor_status(&status)
			},
			AdvisorRequest::SetEnabled(enabled) => {
				let mut engine = advisor.lock();
				engine.set_enabled(enabled);
				let status = engine.status();
				tracing::debug!(
					session_id = %self.state.session_id,
					enabled = status.enabled,
					advisor_count = status.advisors.len(),
					"advisor state changed"
				);
				advisor_status(&status)
			},
			AdvisorRequest::Status => advisor_status(&advisor.lock().status()),
			AdvisorRequest::DumpRaw => advisor.lock().dump(false),
			AdvisorRequest::Configure(_) => {
				let path = Path::new(self.state.workspace_root.as_str()).join("WATCHDOG.yml");
				return Box::pin(async move {
					Err(miette::miette!(
						"interactive advisor configuration is not available yet; edit {}",
						path.display()
					))
				});
			},
		};
		send_status(self.backend, self.state, self.bus, self.dropped);
		Box::pin(async move { Ok(CommandResult::Consumed(ConsumedResult::status(result))) })
	}

	fn browser(&mut self, request: commands::BrowserRequest) -> CommandFuture<'_> {
		let settings = match self
			.settings_manager
			.snapshot()
			.project::<BrowserSettings>()
		{
			Ok(settings) => *settings.get(),
			Err(error) => {
				return Box::pin(async move { Err(miette::miette!("{error}")) });
			},
		};
		if !settings.enabled {
			return Box::pin(async {
				Ok(CommandResult::Consumed(ConsumedResult::status(
					"Browser tool is disabled (enable in settings)",
				)))
			});
		}
		let next = match request {
			commands::BrowserRequest::Toggle => !settings.headless,
			commands::BrowserRequest::Headless => true,
			commands::BrowserRequest::Visible => false,
		};
		if let Err(error) = self.settings_manager.set_sync(
			MutationScope::Project,
			"browser.headless",
			if next { "true" } else { "false" },
		) {
			return Box::pin(async move { Err(miette::miette!("{error}")) });
		}
		let backend = self.backend;
		let registry = self.registry;
		let roster = self.roster.clone();
		let role = command_role(self.state.collab.as_ref());
		let projected = BrowserSettings { enabled: true, headless: next };
		Box::pin(async move {
			send_backend(
				backend,
				BackendEvent::SlashCommands(command_completions(&roster, role, &projected)),
			);
			let mode = if next { "headless" } else { "visible" };
			let status = match commands::browser::restart_for_mode_change(registry, next).await {
				Ok(()) => sf!("Browser mode: {mode}"),
				Err(error) => {
					sf!("Browser mode set to {mode}, but restart failed: {error}")
				},
			};
			Ok(CommandResult::Consumed(ConsumedResult::status(status)))
		})
	}

	fn utility(&mut self, request: commands::UtilityRequest) -> CommandFuture<'_> {
		let request = match request {
			commands::UtilityRequest::Changelog(request) => {
				let status = commands::utility::render_changelog(request);
				return Box::pin(
					async move { Ok(CommandResult::Consumed(ConsumedResult::status(status))) },
				);
			},
			commands::UtilityRequest::Tools => {
				let live_tools = extension_live_tools(self.registry);
				let snapshot = self.agent_state.snapshot();
				let status = commands::utility::render_tools(
					&live_tools,
					&snapshot.enabled_tools,
					&self.state.settings.tools,
					&self.state.extension_declarations,
				);
				return Box::pin(
					async move { Ok(CommandResult::Consumed(ConsumedResult::status(status))) },
				);
			},
			commands::UtilityRequest::Computer(request) => {
				return Box::pin(async move {
					let status = commands::utility::handle_computer(
						request,
						self.registry,
						&self.state.settings.tools,
						&self.state.model,
					)
					.await?;
					Ok(CommandResult::Consumed(ConsumedResult::status(status)))
				});
			},
			commands::UtilityRequest::Vision(request) => request,
		};
		self.state.vision_override = match request {
			commands::VisionRequest::On => Some(InspectImageMode::On),
			commands::VisionRequest::Off => Some(InspectImageMode::Off),
			commands::VisionRequest::Auto => None,
			commands::VisionRequest::Status => self.state.vision_override,
		};
		let override_label = match self.state.vision_override {
			Some(InspectImageMode::On) => "on",
			Some(InspectImageMode::Off) => "off",
			None => "auto",
		};
		let effective = if inspect_image_enabled(self.state) {
			"enabled"
		} else {
			"disabled"
		};
		let capability = if model_accepts_images(self.state.catalog.as_ref(), &self.state.model) {
			"native image input"
		} else {
			"text-only image input"
		};
		let status = sf!(
			"inspect_image {effective} · override {override_label} · {capability} · model {}",
			self.state.model
		);
		Box::pin(async move { Ok(CommandResult::Consumed(ConsumedResult::status(status))) })
	}

	fn ssh(&mut self, request: commands::SshRequest) -> CommandFuture<'_> {
		let workspace = PathBuf::from(self.state.workspace_root.as_str());
		let data_dir = self.data_dir.to_owned();
		Box::pin(async move {
			let status = commands::ssh::execute(request, &workspace, &data_dir)?;
			Ok(CommandResult::Consumed(ConsumedResult::status(status)))
		})
	}

	fn collab(&mut self, request: commands::CollabRequest) -> CommandFuture<'_> {
		let Some(handle) = self.state.collab.clone() else {
			return self.unavailable("Collaboration is not attached to this session.");
		};
		let backend = self.backend;
		let roster = self.roster.clone();
		let browser_settings = current_browser_settings(self.settings_manager);
		let command = match commands::collab::owner_command(request, &self.state.settings.collab) {
			Ok(command) => command,
			Err(error) => return Box::pin(async move { Err(error) }),
		};
		Box::pin(async move {
			let result = handle.request(command).await.into_diagnostic()?;
			send_backend(
				backend,
				BackendEvent::SlashCommands(command_completions(
					&roster,
					command_role(Some(&handle)),
					&browser_settings,
				)),
			);
			Ok(CommandResult::Consumed(ConsumedResult::status(commands::collab::render(result))))
		})
	}

	fn join_collab(&mut self, link: Str) -> CommandFuture<'_> {
		let Some(handle) = self.state.collab.clone() else {
			return self.unavailable("Collaboration is not attached to this session.");
		};
		let backend = self.backend;
		let roster = self.roster.clone();
		let browser_settings = current_browser_settings(self.settings_manager);
		let command = match commands::collab::join_command(&link, &self.state.settings.collab) {
			Ok(command) => command,
			Err(error) => return Box::pin(async move { Err(error) }),
		};
		Box::pin(async move {
			let result = handle.request(command).await.into_diagnostic()?;
			send_backend(
				backend,
				BackendEvent::SlashCommands(command_completions(
					&roster,
					command_role(Some(&handle)),
					&browser_settings,
				)),
			);
			Ok(CommandResult::Consumed(ConsumedResult::status(commands::collab::render(result))))
		})
	}

	fn leave_collab(&mut self) -> CommandFuture<'_> {
		let Some(handle) = self.state.collab.clone() else {
			return self.unavailable("Collaboration is not attached to this session.");
		};
		let backend = self.backend;
		let roster = self.roster.clone();
		let browser_settings = current_browser_settings(self.settings_manager);
		Box::pin(async move {
			let result = handle
				.request(CollabOwnerCommand::Leave)
				.await
				.into_diagnostic()?;
			send_backend(
				backend,
				BackendEvent::SlashCommands(command_completions(
					&roster,
					command_role(Some(&handle)),
					&browser_settings,
				)),
			);
			Ok(CommandResult::Consumed(ConsumedResult::status(commands::collab::render(result))))
		})
	}

	fn export(&mut self, request: commands::ExportRequest) -> CommandFuture<'_> {
		let backend = self.backend;
		let workspace = PathBuf::from(self.state.workspace_root.as_str());
		let journal = self.state.session_path.clone();
		let export_theme = self
			.state
			.theme_watcher
			.palette(self.state.appearance, true)
			.unwrap_or_default();
		Box::pin(async move {
			let tree = SessionTree::load(&journal).map_err(|error| miette::miette!("{error}"))?;
			match request {
				commands::ExportRequest::Html(path) => {
					let output = path.map_or_else(
						|| workspace.join(format!("omp-session-{}.html", tree.id)),
						|path| {
							let path = PathBuf::from(path.as_str());
							if path.is_absolute() {
								path
							} else {
								workspace.join(path)
							}
						},
					);
					let palette = HtmlThemePalette::new(
						css_color(export_theme.fg),
						css_color(export_theme.surface),
						css_color(export_theme.panel),
						css_color(export_theme.border),
						css_color(export_theme.accent),
						css_color(export_theme.muted),
						css_color(export_theme.err),
					);
					let html = omp_driver::export::render_html_with_palette(&tree, &palette)
						.map_err(|error| miette::miette!("{error}"))?;
					fs::write(&output, html).into_diagnostic()?;
					Ok(CommandResult::Consumed(ConsumedResult::status(sf!(
						"Exported self-contained HTML to {}",
						output.display()
					))))
				},
				commands::ExportRequest::Dump { requests } => {
					if requests {
						return Err(miette::miette!(
							"request sidecars are unavailable; use `/debug raw-stream` for the bounded \
							 redacted provider capture"
						));
					}
					let dump = omp_driver::export::render_markdown(&tree);
					send_backend(backend, BackendEvent::CopyToClipboard(Str::new(dump)));
					Ok(CommandResult::Consumed(ConsumedResult::status("Copied sanitized session dump.")))
				},
				commands::ExportRequest::Copy(selection) => {
					let markdown = omp_driver::export::render_markdown(&tree);
					let copied = if selection.trim().is_empty() {
						markdown
					} else {
						markdown
							.lines()
							.filter(|line| line.contains(selection.as_str()))
							.collect::<Vec<_>>()
							.join("\n")
					};
					if copied.is_empty() {
						return Err(miette::miette!("no transcript text matched the selection"));
					}
					send_backend(backend, BackendEvent::CopyToClipboard(Str::new(copied)));
					Ok(CommandResult::Consumed(ConsumedResult::status("Copied transcript text.")))
				},
			}
		})
	}

	fn extensions(&mut self, request: commands::ExtensionRequest) -> CommandFuture<'_> {
		match request {
			commands::ExtensionRequest::Inspect => {
				let live_tools = extension_live_tools(self.registry);
				let live_mcp = commands::snapshot_live_mcp(self.mcp_inspector);
				let snapshot = commands::build_inspector_snapshot_from_declarations(
					&self.state.extension_declarations,
					&live_tools,
					&live_mcp,
					self.state.extension_generation,
				);
				self.state.extension_live_mcp = live_mcp
					.into_iter()
					.map(|snapshot| (snapshot.server.clone(), snapshot))
					.collect();
				let backend = self.backend;
				let state = &mut *self.state;
				Box::pin(async move {
					state.extension_mcp = state
						.environment
						.mcp_subscribe(McpSubscribeRequest {
							name:           None,
							after_sequence: 0,
							wire_revision:  omp_proto::SCHEMA_REV,
						})
						.await
						.ok();
					send_backend(backend, BackendEvent::OpenExtensionInspector(snapshot));
					Ok(CommandResult::Consumed(ConsumedResult::silent()))
				})
			},
			request @ (commands::ExtensionRequest::Marketplace(_)
			| commands::ExtensionRequest::Plugins(_)
			| commands::ExtensionRequest::Reload) => {
				let extension_reload = self.extension_reload;
				let backend = self.backend;
				let data_dir = self.data_dir;
				let settings_manager = self.settings_manager;
				let registry = self.registry;
				let mcp_inspector = self.mcp_inspector;
				let state = &mut *self.state;
				Box::pin(async move {
					let (status, reload) = match request {
						commands::ExtensionRequest::Reload => {
							(Str::new_static("Plugins reloaded."), true)
						},
						request => {
							let workspace = PathBuf::from(state.workspace_root.as_str());
							let output =
								commands::extension_runtime::execute(request, data_dir, &workspace).await?;
							(output.status, output.reload)
						},
					};
					if reload {
						extension_reload
							.reload()
							.await
							.map_err(|error| miette::miette!("{error}"))?;
						if let Some(callbacks) = state.extension_callbacks.as_ref() {
							state
								.extension_ui
								.replace(extension_reload.registry_evidences(), Arc::clone(callbacks))
								.map_err(|error| miette::miette!("{error}"))?;
						}
						let workspace = PathBuf::from(state.workspace_root.as_str());
						let home = env::var_os("HOME").map_or_else(|| workspace.clone(), PathBuf::from);
						let model_settings = settings_manager
							.snapshot()
							.project::<ModelSettings>()
							.into_diagnostic()?
							.get()
							.resolve_path_scopes(&workspace, &home);
						state.prompt_discovery_settings.model = model_settings.clone();
						let content = omp_driver::discovery::active_prompt_snapshots(
							&workspace,
							&[],
							&home,
							&state.prompt_discovery_settings,
						)
						.content;
						state.model_settings = model_settings;
						let sources = vec![content.commands.iter().cloned().map(Into::into).collect()];
						let security_enabled = state
							.typed_commands
							.command_usage_name("/security")
							.is_some();
						state.commands = CommandRoster::new(sources.clone());
						state.command_sources = sources.clone();
						state.typed_commands = structural_roster(
							&sources,
							security_enabled,
							state.extension_ui.command_generations(&state.session_id),
						);
						state.skills = content.skills;
						state.extension_declarations = content.declarations;
						state.extension_generation = state.extension_generation.wrapping_add(1).max(1);
						let browser_settings = current_browser_settings(settings_manager);
						let mut completions = command_completions(
							&state.typed_commands,
							command_role(state.collab.as_ref()),
							&browser_settings,
						);
						completions.extend(state.skills.all().iter().map(|skill| {
							let name = format!("skill:{}", skill.name);
							Command::new(&name, skill.description.as_str(), &[]).with_icon(Icon::Skill)
						}));
						send_backend(backend, BackendEvent::SlashCommands(completions));
						let live_tools = extension_live_tools(registry);
						let live_mcp = commands::snapshot_live_mcp(mcp_inspector);
						let snapshot = commands::build_inspector_snapshot_from_declarations(
							&state.extension_declarations,
							&live_tools,
							&live_mcp,
							state.extension_generation,
						);
						send_backend(backend, BackendEvent::ExtensionSnapshotUpdated(snapshot));
					}
					Ok(CommandResult::Consumed(ConsumedResult::status(status)))
				})
			},
		}
	}

	fn share(&mut self, args: Str) -> CommandFuture<'_> {
		let backend = self.backend;
		let workspace = PathBuf::from(self.state.workspace_root.as_str());
		let journal = self.state.session_path.clone();
		let data_dir = self.data_dir.to_owned();
		let export_settings = self.state.settings.export;
		let share_settings = self.state.settings.share.clone();
		Box::pin(async move {
			let mut no_redact = false;
			let mut selected = match share_settings.store {
				ShareStore::Http => ShareStoreKind::Http,
				ShareStore::Gist => ShareStoreKind::Gist,
			};
			let words =
				input::tokenize_args(args.as_str()).map_err(|error| miette::miette!("{error}"))?;
			let mut words = words.iter();
			while let Some(word) = words.next() {
				match word.as_str() {
					"--no-redact" => no_redact = true,
					"--store" => {
						selected = match words.next().map(Str::as_str) {
							Some("http") => ShareStoreKind::Http,
							Some("gist") => ShareStoreKind::Gist,
							Some("auto") => selected,
							_ => {
								return Err(miette::miette!(
									"usage: /share [--no-redact] [--store auto|http|gist]"
								));
							},
						};
					},
					_ => {
						return Err(miette::miette!(
							"usage: /share [--no-redact] [--store auto|http|gist]"
						));
					},
				}
			}
			let tree = SessionTree::load(&journal).map_err(|error| miette::miette!("{error}"))?;
			let value = serde_json::to_value(tree).into_diagnostic()?;
			let secrets = SecretSessionSnapshot::build(
				0,
				&data_dir.join("secrets.toml"),
				&workspace.join(".omp/secrets.toml"),
				iter::empty(),
			)
			.map_err(|error| miette::miette!("{error}"))?;
			let projection = ShareProjection::materialize_bounded(
				value,
				omp_driver::settings::ExportSettings {
					share_redact_secrets: export_settings.share_redact_secrets && !no_redact,
				},
				&secrets,
				omp_driver::share::HTTP_MAX_SEALED_BYTES.saturating_sub(64 * 1024),
			);
			let sealed =
				omp_driver::share::seal(&projection).map_err(|error| miette::miette!("{error}"))?;
			let credentials = Arc::new(GithubCredentialBridge::new());
			let store = DirectShareStore::new(share_settings.server_url.as_str(), credentials)
				.map_err(|error| miette::miette!("{error}"))?;
			let result = omp_driver::share::upload(
				&store,
				selected,
				&sealed,
				share_settings.server_url.as_str(),
			)
			.await
			.map_err(|error| miette::miette!("{error}"))?;
			send_backend(backend, BackendEvent::CopyToClipboard(result.url.clone()));
			Ok(CommandResult::Consumed(ConsumedResult::status(sf!(
				"Encrypted share link copied ({})",
				match result.store {
					omp_driver::share::ShareStoreKind::Http => "HTTP",
					omp_driver::share::ShareStoreKind::Gist => "Gist",
					omp_driver::share::ShareStoreKind::Extension => "extension",
				}
			))))
		})
	}

	fn memory(&mut self, args: Str) -> CommandFuture<'_> {
		let Some(runtime) = self.state.memory.clone() else {
			return self.unavailable("Memory authority is not attached to this session.");
		};
		Box::pin(async move {
			let operation = args.trim();
			let value = match operation.as_str() {
				"" | "view" => serde_json::to_value(
					runtime
						.prompt_snapshot(None, None, usize::MAX)
						.into_diagnostic()?,
				)
				.into_diagnostic()?,
				"stats" => {
					serde_json::to_value(runtime.stats().into_diagnostic()?).into_diagnostic()?
				},
				"diagnose" => {
					serde_json::to_value(runtime.diagnose().into_diagnostic()?).into_diagnostic()?
				},
				"clear" => {
					runtime.clear().into_diagnostic()?;
					serde_json::json!({"cleared": true, "generation": runtime.generation()})
				},
				"reset" => {
					runtime.clear().into_diagnostic()?;
					serde_json::json!({"reset": true, "generation": runtime.generation()})
				},
				"enqueue" | "rebuild" => {
					let promoted = runtime.enqueue().into_diagnostic()?;
					serde_json::json!({"promoted": promoted, "generation": runtime.generation()})
				},
				_ => {
					return Err(miette::miette!(
						"usage: /memory view|stats|diagnose|clear|reset|enqueue|rebuild",
					));
				},
			};
			let rendered = serde_json::to_string_pretty(&value).into_diagnostic()?;
			Ok(CommandResult::Consumed(ConsumedResult::status(Str::from(rendered))))
		})
	}

	fn mcp(&mut self, request: McpRequest) -> CommandFuture<'_> {
		Box::pin(async move {
			let notice = match request {
				McpRequest::Help => sf!(
					"`/mcp list`; `/mcp add [--scope user|project] <name> <server-json>`; `/mcp \
					 remove|enable|disable|test|reconnect <name>`",
				),
				McpRequest::List => {
					let status = self
						.state
						.environment
						.mcp_status(McpStatusRequest {
							name:          None,
							wire_revision: omp_proto::SCHEMA_REV,
						})
						.await
						.into_diagnostic()?;
					if status.servers.is_empty() {
						sf!("No MCP servers are configured.")
					} else {
						let mut rendered = String::from("**MCP servers**\n");
						for server in status.servers {
							let name = server
								.server
								.as_ref()
								.map_or("<unknown>", |server| &server.name);
							let state = McpLifecycleState::try_from(server.state)
								.unwrap_or(McpLifecycleState::Unspecified)
								.as_str_name();
							use std::fmt::Write as _;
							let _ = writeln!(rendered, "- `{name}` — {state} · {}", server.detail);
						}
						Str::from(rendered)
					}
				},
				McpRequest::Add { scope, name, server_json } => {
					self
						.state
						.environment
						.mcp_config(McpConfigRequest {
							action:        McpConfigAction::Add as i32,
							scope:         match scope {
								ConfigScope::User => McpConfigScope::User as i32,
								ConfigScope::Project => McpConfigScope::Project as i32,
							},
							name:          name.to_string(),
							server_json:   Bytes::copy_from_slice(server_json.as_bytes()),
							wire_revision: omp_proto::SCHEMA_REV,
						})
						.await
						.into_diagnostic()?;
					sf!("Added MCP server `{name}`.")
				},
				McpRequest::Remove(name) => {
					mutate_mcp(&self.state.environment, McpConfigAction::Remove, &name).await?
				},
				McpRequest::Enable(name) => {
					mutate_mcp(&self.state.environment, McpConfigAction::Enable, &name).await?
				},
				McpRequest::Disable(name) => {
					mutate_mcp(&self.state.environment, McpConfigAction::Disable, &name).await?
				},
				McpRequest::Test(name) => {
					let status = self
						.state
						.environment
						.mcp_status(McpStatusRequest {
							name:          Some(name.to_string()),
							wire_revision: omp_proto::SCHEMA_REV,
						})
						.await
						.into_diagnostic()?;
					let server = status
						.servers
						.first()
						.ok_or_else(|| miette::miette!("MCP server `{name}` is not configured"))?;
					let state = McpLifecycleState::try_from(server.state)
						.unwrap_or(McpLifecycleState::Unspecified)
						.as_str_name();
					sf!("MCP server `{name}`: {state} · {}", server.detail)
				},
				McpRequest::Reconnect(name) => {
					let status = self
						.state
						.environment
						.mcp_status(McpStatusRequest {
							name:          Some(name.to_string()),
							wire_revision: omp_proto::SCHEMA_REV,
						})
						.await
						.into_diagnostic()?;
					let server = status
						.servers
						.first()
						.and_then(|status| status.server.clone())
						.ok_or_else(|| miette::miette!("MCP server `{name}` is not configured"))?;
					let result = self
						.state
						.environment
						.mcp_reset(McpResetRequest {
							server:        Some(McpServerRef {
								name:             server.name,
								definition_epoch: server.definition_epoch,
							}),
							wire_revision: omp_proto::SCHEMA_REV,
						})
						.await
						.into_diagnostic()?;
					let state = result
						.status
						.map(|status| {
							McpLifecycleState::try_from(status.state)
								.unwrap_or(McpLifecycleState::Unspecified)
								.as_str_name()
						})
						.unwrap_or("UNKNOWN");
					sf!("Reconnected MCP server `{name}`: {state}.")
				},
				McpRequest::Reauth(name) => {
					let status = self
						.state
						.environment
						.mcp_status(McpStatusRequest {
							name:          Some(name.to_string()),
							wire_revision: omp_proto::SCHEMA_REV,
						})
						.await
						.into_diagnostic()?;
					let server = status
						.servers
						.first()
						.and_then(|status| status.server.clone())
						.ok_or_else(|| miette::miette!("MCP server `{name}` is not configured"))?;
					let backend = (*self.backend).clone();
					self
						.mcp_inspector
						.reauthorize(name.as_str(), move |url| {
							send_backend(
								&backend,
								BackendEvent::Notice(sf!("[open to authorize]({url})")),
							);
						})
						.await
						.into_diagnostic()?;
					let result = self
						.state
						.environment
						.mcp_reset(McpResetRequest {
							server:        Some(McpServerRef {
								name:             server.name,
								definition_epoch: server.definition_epoch,
							}),
							wire_revision: omp_proto::SCHEMA_REV,
						})
						.await
						.into_diagnostic()?;
					let state = result
						.status
						.map(|status| {
							McpLifecycleState::try_from(status.state)
								.unwrap_or(McpLifecycleState::Unspecified)
								.as_str_name()
						})
						.unwrap_or("UNKNOWN");
					sf!("Reauthorized MCP server `{name}`: {state}.")
				},
				McpRequest::Unauth(name) => {
					let status = self
						.state
						.environment
						.mcp_status(McpStatusRequest {
							name:          Some(name.to_string()),
							wire_revision: omp_proto::SCHEMA_REV,
						})
						.await
						.into_diagnostic()?;
					let server = status
						.servers
						.first()
						.and_then(|status| status.server.clone())
						.ok_or_else(|| miette::miette!("MCP server `{name}` is not configured"))?;
					let removed = self
						.mcp_inspector
						.clear_authorization(name.as_str())
						.await
						.into_diagnostic()?;
					let reset = self
						.state
						.environment
						.mcp_reset(McpResetRequest {
							server:        Some(McpServerRef {
								name:             server.name,
								definition_epoch: server.definition_epoch,
							}),
							wire_revision: omp_proto::SCHEMA_REV,
						})
						.await;
					let status = match reset {
						Ok(result) => result.status,
						Err(_) => self
							.state
							.environment
							.mcp_status(McpStatusRequest {
								name:          Some(name.to_string()),
								wire_revision: omp_proto::SCHEMA_REV,
							})
							.await
							.into_diagnostic()?
							.servers
							.into_iter()
							.next(),
					};
					let status =
						status.ok_or_else(|| miette::miette!("MCP server `{name}` is not configured"))?;
					let state = McpLifecycleState::try_from(status.state)
						.unwrap_or(McpLifecycleState::Unspecified)
						.as_str_name();
					if removed {
						sf!(
							"Cleared stored credential for MCP server `{name}`. Connection: {state} · {}",
							status.detail
						)
					} else {
						sf!(
							"No stored credential found for MCP server `{name}`. Connection reset: \
							 {state} · {}",
							status.detail
						)
					}
				},
			};
			Ok(CommandResult::Consumed(ConsumedResult::status(notice)))
		})
	}

	fn cleanse(&mut self, args: omp_driver::cleanse::CleanseArgs) -> CommandFuture<'_> {
		if chat_active(self.state.submit_pending, self.bus.phase()) {
			return Box::pin(async {
				Ok(CommandResult::Consumed(ConsumedResult::status(
					"Wait for the active turn to finish before cleansing the workspace.",
				)))
			});
		}
		let root = self.state.local_root.clone();
		let data_dir = self.data_dir.to_path_buf();
		Box::pin(async move {
			let cancel = CancellationToken::new();
			let status = commands::run_cleanse(&root, &data_dir, args, &cancel).await?;
			Ok(CommandResult::Consumed(ConsumedResult::status(status)))
		})
	}
}

fn maybe_spawn_session_title<C>(
	parent: &Arc<ChatParentHost<C>>,
	control: &omp_agent::ControlSender,
	state: &BridgeState,
	input: &str,
	replanned: bool,
) where
	C: TurnClient + Clone + Send + 'static,
{
	if env::var_os("OMP_NO_TITLE").is_some()
		|| state.title_user_set.load(Ordering::Acquire)
		|| !state.title.should_generate(input, replanned)
		|| state
			.title_generation_in_flight
			.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
			.is_err()
	{
		return;
	}

	let parent = Arc::clone(parent);
	let control = control.clone();
	let input = Str::new(input);
	let cwd = state.local_root.clone();
	let home = env::var_os("HOME").map_or_else(|| cwd.clone(), PathBuf::from);
	let in_flight = Arc::clone(&state.title_generation_in_flight);
	let user_set = Arc::clone(&state.title_user_set);
	let commit_lock = Arc::clone(&state.title_commit_lock);
	let session_id = state.session_id.clone();
	drop(tokio::spawn(async move {
		let resolved = tokio::task::spawn_blocking(move || {
			omp_driver::prompt_input::resolve_title_system_prompt(&cwd, &home)
		})
		.await;
		let resolved = match resolved {
			Ok(Ok(prompt)) => prompt,
			Ok(Err(error)) => {
				tracing::debug!(
					%error,
					session_id = %session_id,
					"title system prompt could not be resolved"
				);
				in_flight.store(false, Ordering::Release);
				return;
			},
			Err(error) => {
				tracing::debug!(
					%error,
					session_id = %session_id,
					"title system prompt resolution task failed"
				);
				in_flight.store(false, Ordering::Release);
				return;
			},
		};
		let embedded = prompt_asset(PromptAssetId::TitleSystem).content;
		let system_prompt = omp_driver::session_title::title_system_prompt(
			(resolved.as_str() != embedded).then_some(resolved.as_str()),
		);
		if let Some(title) =
			generate_online_title(parent.as_ref(), input.as_str(), system_prompt.as_str()).await
		{
			let _commit = commit_lock.lock().await;
			if user_set.load(Ordering::Acquire) {
				tracing::debug!(
					session_id = %session_id,
					"generated session title discarded after user rename"
				);
			} else {
				match control.set_generated_title(now_ms(), title).await {
					Ok(event) => tracing::debug!(
						session_id = %session_id,
						event,
						"generated session title committed"
					),
					Err(error) => tracing::debug!(
						%error,
						session_id = %session_id,
						"generated session title could not be committed"
					),
				}
			}
		} else {
			tracing::debug!(
				session_id = %session_id,
				"session title generation returned no title"
			);
		}
		in_flight.store(false, Ordering::Release);
	}));
}

fn send_recap_policy(backend: &flume::Sender<BackendEvent>, settings: &Settings) {
	send_backend(backend, BackendEvent::RecapPolicy {
		enabled:      settings.recap.enabled,
		idle_seconds: u32::try_from(settings.recap.idle_seconds).unwrap_or(u32::MAX),
	});
}

fn recap_preview(text: &str) -> Option<Str> {
	let mut words = text.split_whitespace();
	let first = words.next()?;
	let mut one_line = String::with_capacity(text.len().min(280));
	one_line.push_str(first);
	for word in words {
		one_line.push(' ');
		one_line.push_str(word);
	}
	let mut chars = 0;
	let mut end = 0;
	for grapheme in xutf::graphemes_str(&one_line) {
		let grapheme_chars = grapheme.chars().count();
		if chars + grapheme_chars > 280 {
			break;
		}
		chars += grapheme_chars;
		end += grapheme.len();
	}
	Some(Str::new(&one_line[..end]))
}

async fn handle_intent<C, R>(
	mcp_inspector: &omp_envd::McpInspectorHandle,
	intent: Intent,
	backend: &flume::Sender<BackendEvent>,
	commands_tx: &flume::Sender<UiCmd>,
	mailbox: &omp_agent::MailboxSender,
	abort: &omp_agent::AbortHandle,
	control: &omp_agent::ControlSender,
	agent_state: &AgentState,
	modes: &RegimeHandle,
	parent: &Arc<ChatParentHost<C>>,
	auth: Option<&ChatAuth>,
	auth_control: Option<&omp_inference::auth::AuthControlHandle>,
	extension_reload: &omp_envd::ExtensionReloadHandle,
	data_dir: &Path,
	settings_manager: &SettingsManager,
	session_index: &SessionIndex,
	telemetry_index: &omp_storage::telemetry_index::TelemetryIndex,
	list_sessions: &mut R,
	bus: &omp_agent::EventBus,
	registry: &Registry,
	renderers: &RenderRegistry,
	dropped: u64,
	state: &mut BridgeState,
) -> miette::Result<bool>
where
	C: TurnClient + Clone + Send + 'static,
	R: FnMut() -> miette::Result<Vec<ResumeChoice>> + Send,
{
	match intent {
		Intent::ExtensionShortcut(_) => {},
		Intent::UiResponse { correlation, .. } => {
			send_backend(
				backend,
				BackendEvent::Error(sf!(
					"UI response `{correlation}` arrived after its presentation owner detached."
				)),
			);
		},
		Intent::UiOverlayEvent(event) => {
			send_backend(
				backend,
				BackendEvent::Error(sf!(
					"Overlay event for `{}` arrived after its presentation owner detached.",
					event.overlay_id
				)),
			);
		},
		Intent::IdleRecap => {
			if state.settings.recap.enabled
				&& !chat_active(state.submit_pending, bus.phase())
				&& state.has_history
			{
				let goal = modes
					.goal()
					.filter(|goal| goal.status == GoalStatus::Active)
					.map(|goal| goal.objective)
					.or_else(|| state.title.title.clone());
				let prompt = omp_driver::session_title::recap_user_prompt(goal.as_deref(), None);
				let parent = Arc::clone(parent);
				let control = control.clone();
				let backend = backend.clone();
				let session_id = state.session_id.clone();
				drop(tokio::spawn(async move {
					let thread = match control.project_thread().await {
						Ok(thread) => thread,
						Err(error) => {
							tracing::debug!(
								%error,
								session_id = %session_id,
								"idle recap thread projection failed"
							);
							return;
						},
					};
					match parent.run_ephemeral_turn(thread, prompt.as_str()).await {
						Ok(Some(outcome)) => {
							if let Some(preview) =
								recap_preview(omp_driver::chat::outcome_text(&outcome).as_str())
							{
								tracing::debug!(
									session_id = %session_id,
									preview_bytes = preview.as_str().len(),
									"idle recap generated"
								);
								send_backend(&backend, BackendEvent::Recap(preview));
							} else {
								tracing::debug!(
									session_id = %session_id,
									"idle recap produced no preview"
								);
							}
						},
						Ok(None) => tracing::debug!(
							session_id = %session_id,
							"idle recap request returned no outcome"
						),
						Err(error) => tracing::debug!(
							%error,
							session_id = %session_id,
							"idle recap request failed"
						),
					}
				}));
			}
		},
		Intent::Submit { text, attachments, mode } => {
			if let Some(handle) = state.collab.clone()
				&& let Some(presence) = handle.presence()
				&& presence.role() == CollabRole::Guest
			{
				match omp_collab::guest::admit_guest_input(text.as_str(), presence.read_only()) {
					Ok(GuestInputDisposition::LocalCommand) => {},
					Ok(GuestInputDisposition::RemotePrompt) => {
						let mut remote_text = text.to_string();
						let mut images = Vec::new();
						for attachment in &attachments {
							match &attachment.content {
								AttachmentContent::Text { text, .. } => {
									remote_text.push_str("\n\n");
									remote_text.push_str(text.as_str());
								},
								AttachmentContent::Image { source, .. } => {
									const REMOTE_IMAGE_MAX_BYTES: u64 = 24 * 1024 * 1024;
									let source = source.to_string();
									let Ok(metadata) = tokio::fs::metadata(&source).await else {
										send_backend(
											backend,
											BackendEvent::Error(sf!(
												"Collaboration image attachment could not be read.",
											)),
										);
										return Ok(false);
									};
									if metadata.len() > REMOTE_IMAGE_MAX_BYTES {
										send_backend(
											backend,
											BackendEvent::Error(sf!(
												"Collaboration image attachment exceeds 24 MiB.",
											)),
										);
										return Ok(false);
									}
									let mime_type = image::ImageFormat::from_path(source.as_str())
										.map(|format| format.to_mime_type())
										.unwrap_or("application/octet-stream");
									let Ok(data) = tokio::fs::read(source).await else {
										send_backend(
											backend,
											BackendEvent::Error(sf!(
												"Collaboration image attachment could not be read.",
											)),
										);
										return Ok(false);
									};
									images.push(RemoteImage {
										data:      bytes::Bytes::from(data),
										mime_type: Str::new_static(mime_type),
									});
								},
							}
						}
						match handle
							.request(CollabOwnerCommand::Prompt { text: Str::from(remote_text), images })
							.await
						{
							Ok(_) => send_backend(
								backend,
								BackendEvent::Notice(sf!("Prompt sent to collaboration host.")),
							),
							Err(error) => {
								send_backend(backend, BackendEvent::Error(sf!("{error}")));
							},
						}
						return Ok(false);
					},
					Err(GuestInputError::HostCommand) => {
						send_backend(
							backend,
							BackendEvent::Error(sf!(
								"Command is unavailable while joined to a collaboration.",
							)),
						);
						return Ok(false);
					},
					Err(GuestInputError::ReadOnly) => {
						send_backend(
							backend,
							BackendEvent::Error(sf!("This collaboration link is read-only.")),
						);
						return Ok(false);
					},
				}
			}
			if let Some((kind, context, source)) = parse_local_command(&text) {
				if looks_like_pasted_transcript(source) {
					send_backend(
						backend,
						BackendEvent::Error(sf!(
							"Refusing local execution of pasted transcript content.",
						)),
					);
					return Ok(false);
				}
				state.part_serial = state.part_serial.saturating_add(1);
				let id = sf!("local-{}", state.part_serial);
				state
					.deferred
					.enqueue(id.clone(), kind, Str::from(source), context);
				if chat_active(state.submit_pending, bus.phase()) {
					send_retained_fact(
						backend,
						"async-job",
						id.as_str(),
						serde_json::json!({
							"name": id.as_str(),
							"status": "queued",
							"detail": source,
						}),
						"Local command queued until the active turn settles.",
					);
				} else if let Some(command) = state.deferred.take_next() {
					execute_deferred_command(backend, state, registry, parent.as_ref(), command).await;
				}
				return Ok(false);
			}
			let roster = state.typed_commands.clone();
			if let Some(name) = roster.command_usage_name(&text).or_else(|| {
				if text.trim_start().starts_with("/skill:") {
					omp_driver::skills::parse_invocation(&text).and_then(|skill| {
						state
							.skills
							.get(skill.name.as_str())
							.map(|_| sf!("skill:{}", skill.name))
					})
				} else {
					state.commands.command_usage_name(&text)
				}
			}) {
				let _ = state.command_usage.record(name.as_str(), now_ms());
			}
			let mut command_host = LiveCommandHost {
				mcp_inspector,
				backend,
				commands_tx,
				abort,
				control,
				agent_state,
				modes,
				auth,
				auth_control,
				parent: parent.clone(),
				mailbox,
				extension_reload,
				data_dir,
				settings_manager,
				session_index,
				list_sessions,
				bus,
				registry,
				renderers,
				dropped,
				roster: roster.clone(),
				state,
			};
			// A failed slash command (bad arguments, handler error) renders
			// in-chat; it never tears down the interactive shell.
			let mut command_denial = None;
			let admitted_extension =
				if let Some(mut invocation) = roster.extension_invocation(&text, CommandSurface::Tui) {
					match parent
						.admit_command_invoke(
							invocation.name.as_str(),
							invocation.argv.as_ref(),
							invocation.raw.as_str(),
							"interactive",
							"interactive",
						)
						.await
					{
						Ok((name, argv)) => {
							invocation.name = name;
							invocation.argv = argv.into();
							Some(invocation)
						},
						Err(denial) => {
							command_denial = Some(denial.reason);
							None
						},
					}
				} else {
					None
				};
			let command_denied = command_denial.is_some();
			let dispatched = if let Some(reason) = command_denial {
				Ok(DispatchResult::Passthrough(reason))
			} else if let Some(invocation) = admitted_extension {
				roster.dispatch_extension_invocation(invocation).await
			} else {
				roster
					.dispatch(&text, CommandSurface::Tui, &mut command_host)
					.await
			};
			let dispatch = match dispatched {
				Ok(dispatch) => dispatch,
				Err(error) => {
					send_backend(backend, BackendEvent::Error(sf!("{error}")));
					return Ok(false);
				},
			};
			let text = match dispatch {
				DispatchResult::Passthrough(text) => text.to_string(),
				DispatchResult::Handled(CommandResult::Prompt(prompt)) => prompt.text.to_string(),
				DispatchResult::Handled(CommandResult::Consumed(consumed)) => {
					if let Some(status) = consumed.status {
						send_backend(backend, BackendEvent::Notice(status));
					}
					return Ok(false);
				},
				DispatchResult::Handled(CommandResult::Exit) => return Ok(true),
			};
			if !text.trim().is_empty() {
				modes.capture_loop_prompt(&text);
			}
			let parsed = if command_denied {
				Ok(ChatCommand::Submit {
					item:   Box::new(input::user_message(&text)),
					text:   Str::from(text.as_str()),
					budget: None,
				})
			} else {
				state.commands.parse_input(&text)
			};
			match parsed {
				Ok(ChatCommand::Nothing) => {
					if should_abort_empty(chat_active(state.submit_pending, bus.phase()), state.queued) {
						abort.abort();
					}
				},
				Ok(ChatCommand::Help) => {
					send_backend(
						backend,
						BackendEvent::Notice(Str::from(append_hotkeys(state.typed_commands.help_text(
							CommandSurface::Tui,
							command_role(state.collab.as_ref()),
							true,
							|_| true,
						)))),
					);
				},
				Ok(ChatCommand::Login(provider)) => {
					if chat_active(state.submit_pending, bus.phase()) {
						send_backend(
							backend,
							BackendEvent::Error(sf!(
								"Wait for the active turn to finish before logging in.",
							)),
						);
					} else {
						handle_login(backend, auth, provider, state);
					}
				},
				Ok(ChatCommand::Model(selector)) => {
					switch_model(
						backend,
						agent_state,
						settings_manager,
						selector.as_str(),
						state,
						control,
						parent,
						true,
					)
					.await;
				},
				Ok(ChatCommand::Switch(selector)) => {
					switch_model(
						backend,
						agent_state,
						settings_manager,
						selector.as_str(),
						state,
						control,
						parent,
						false,
					)
					.await;
				},
				Ok(ChatCommand::ModelPicker) => send_open_models(backend, state),
				Ok(ChatCommand::ModelHub) => send_open_model_hub(backend, settings_manager, state),
				Ok(ChatCommand::Resume) => {
					if chat_active(state.submit_pending, bus.phase()) {
						send_backend(
							backend,
							BackendEvent::Error(sf!(
								"Wait for the active turn to finish before resuming another session.",
							)),
						);
					} else {
						match list_sessions() {
							Ok(choices) => {
								send_backend(backend, BackendEvent::Sessions(session_rows(choices)));
							},
							Err(error) => send_backend(
								backend,
								BackendEvent::Error(sf!("Could not list sessions: {error}")),
							),
						}
					}
				},
				Ok(ChatCommand::NewSession) => {
					if chat_active(state.submit_pending, bus.phase()) {
						send_backend(
							backend,
							BackendEvent::Error(sf!(
								"Wait for the active turn to finish before starting a new session.",
							)),
						);
					} else {
						send_backend(backend, BackendEvent::NewSessionRequested);
					}
				},
				Ok(ChatCommand::Clear) => {
					if chat_active(state.submit_pending, bus.phase()) {
						send_backend(
							backend,
							BackendEvent::Error(sf!(
								"Wait for the active turn to finish before clearing context.",
							)),
						);
					} else {
						match reset_session(control, &state.session_hooks).await {
							Ok(_) => {
								state.context_tokens = 0;
								send_backend(backend, BackendEvent::HistoryCleared);
							},
							Err(error) => send_backend(
								backend,
								BackendEvent::Error(sf!("Could not clear context: {error}")),
							),
						}
					}
				},
				Ok(ChatCommand::Fresh) => {
					if chat_active(state.submit_pending, bus.phase()) {
						send_backend(
							backend,
							BackendEvent::Error(sf!(
								"Wait for the active turn to finish before resetting the provider.",
							)),
						);
					} else {
						match control.provider_reset(omp_agent::broker_now_ms()).await {
							Ok(_) => send_backend(
								backend,
								BackendEvent::Notice(sf!(
									"Provider session will be refreshed on the next turn.",
								)),
							),
							Err(error) => send_backend(
								backend,
								BackendEvent::Error(sf!("Could not refresh provider session: {error}")),
							),
						}
					}
				},
				Ok(ChatCommand::Jobs) => {
					let mut jobs: Vec<_> = state.jobs.iter().map(Str::as_str).collect();
					jobs.sort_unstable();
					let message = if jobs.is_empty() {
						sf!("No active background jobs.")
					} else {
						Str::from(format!(
							"**Active jobs ({})**\n{}",
							jobs.len(),
							jobs
								.into_iter()
								.map(|job| format!("- `{job}`"))
								.collect::<Vec<_>>()
								.join("\n"),
						))
					};
					send_backend(backend, BackendEvent::Notice(message));
				},
				Ok(ChatCommand::Settings) => {
					send_backend(backend, BackendEvent::SettingsSchema(setting_rows(&state.settings)));
				},
				Ok(ChatCommand::Theme(args)) => match load_theme_preview(state, args.as_str()).await {
					Ok(theme) => {
						send_backend(backend, BackendEvent::ThemePreview(theme));
						send_backend(
							backend,
							BackendEvent::Notice(sf!(
								"Theme preview active for this session; settings were not changed.",
							)),
						);
					},
					Err(error) => send_backend(
						backend,
						BackendEvent::Error(sf!("Could not preview theme: {error}")),
					),
				},
				Ok(ChatCommand::Live) => {
					toggle_live_voice(backend, state);
					send_status(backend, state, bus, dropped);
				},
				Ok(ChatCommand::Plan(args)) => {
					let replanned = modes.plan().is_some();
					handle_plan_command(
						backend,
						commands_tx,
						control,
						modes,
						abort,
						chat_active(state.submit_pending, bus.phase()),
						args.as_str(),
					)
					.await;
					state.title_replan_refresh_pending |= replanned;
				},
				Ok(ChatCommand::Goal(args)) => {
					handle_goal_command(backend, commands_tx, modes, args.as_str()).await;
				},
				Ok(ChatCommand::Vibe(args)) => {
					handle_vibe_command(backend, commands_tx, modes, args.as_str()).await;
				},
				Ok(ChatCommand::Prewalk(_)) => send_backend(
					backend,
					BackendEvent::Error(sf!("Prewalk does not own the visible mode resource.")),
				),
				Ok(ChatCommand::Skill { name, args, budget }) => {
					let Some(skill) = state.skills.get(name.as_str()) else {
						send_backend(backend, BackendEvent::Error(sf!("Unknown skill `{name}`.")));
						return Ok(false);
					};
					send_retained_fact(
						backend,
						"skill",
						name.as_str(),
						serde_json::json!({
							"name": name.as_str(),
							"detail": "skill instructions loaded for this turn",
							"args": args.as_str(),
						}),
						"Skill instructions loaded for this turn.",
					);
					let rendered = omp_driver::skills::render_invocation(
						skill,
						args.as_str(),
						SkillInvocationKind::User,
					);
					let active = chat_active(state.submit_pending, bus.phase());
					let title_replanned = (!active).then(|| {
						mem::take(&mut state.title_replan_refresh_pending)
							&& state.settings.title.refresh_on_replan
					});
					let mut item = input::user_message(rendered.as_str());
					let chips = lower_attachments(&mut item, attachments.clone(), |message| {
						send_backend(backend, BackendEvent::Error(message));
					});
					if let Err(denial) = parent
						.admit_user_input(std::slice::from_mut(&mut item), "interactive", false)
						.await
					{
						send_backend(backend, BackendEvent::Error(denial.reason));
						return Ok(false);
					}
					let delivered = if active {
						apply_turn_budget(agent_state, budget.as_ref());
						let delivered = mailbox
							.try_enqueue(Interrupt {
								class: active_submit_class(mode),
								item,
								source: InterruptSource::Producer(sf!("user skill")),
							})
							.is_ok();
						if !delivered {
							apply_turn_budget(agent_state, None);
						}
						delivered
					} else {
						state.submit_pending = true;
						commands_tx
							.send_async(UiCmd::Submit { item: Box::new(item), budget })
							.await
							.is_ok()
					};
					if delivered {
						state.has_history = true;
						send_backend(backend, BackendEvent::UserReplayed {
							text: Str::new(text.as_str()),
							chips,
							queued: active,
						});
						if let Some(replanned) = title_replanned {
							maybe_spawn_session_title(parent, control, state, text.as_str(), replanned);
						}
						if active {
							state.queued = state.queued.saturating_add(1);
							state.queued_prompts.push_back(omp_chat_ui::QueuedPrompt {
								text: Str::from(text),
								attachments,
							});
						} else {
							state.turn_started.get_or_insert_with(Instant::now);
						}
					} else {
						state.submit_pending = false;
						send_backend(backend, BackendEvent::Error(sf!("Agent input channel is closed.")));
					}
				},
				Ok(ChatCommand::Agents) => send_backend(backend, BackendEvent::OpenAgentTree),
				Ok(ChatCommand::Pause) => send_backend(backend, BackendEvent::Pause),
				Ok(ChatCommand::Unavailable { command, reason }) => {
					send_backend(backend, BackendEvent::Error(sf!("/{command} unavailable: {reason}")));
				},
				Ok(ChatCommand::Quit) => {
					if chat_active(state.submit_pending, bus.phase()) {
						abort.abort();
					}
					return Ok(true);
				},
				Ok(ChatCommand::Submit { item, text: prompt_text, budget }) => {
					if auth.is_some_and(ChatAuth::is_active) {
						send_backend(
							backend,
							BackendEvent::Error(sf!(
								"Wait for provider authentication to finish before submitting.",
							)),
						);
					} else {
						let active = chat_active(state.submit_pending, bus.phase());
						let title_replanned = (!active).then(|| {
							mem::take(&mut state.title_replan_refresh_pending)
								&& state.settings.title.refresh_on_replan
						});
						let pending_prompt = (!active).then(|| PendingPrompt {
							text:        prompt_text.clone(),
							attachments: attachments.clone(),
						});
						let queued_prompt = active.then(|| omp_chat_ui::QueuedPrompt {
							text:        prompt_text.clone(),
							attachments: attachments.clone(),
						});
						let mut item = *item;
						let chips = lower_attachments(&mut item, attachments, |message| {
							send_backend(backend, BackendEvent::Error(message));
						});
						if let Err(denial) = parent
							.admit_user_input(
								std::slice::from_mut(&mut item),
								"interactive",
								looks_like_pasted_transcript(prompt_text.as_str()),
							)
							.await
						{
							send_backend(backend, BackendEvent::Error(denial.reason));
							return Ok(false);
						}
						let delivered = if active {
							apply_turn_budget(agent_state, budget.as_ref());
							let delivered = mailbox
								.try_enqueue(Interrupt {
									class: active_submit_class(mode),
									item,
									source: InterruptSource::Producer(sf!("user")),
								})
								.is_ok();
							if !delivered {
								apply_turn_budget(agent_state, None);
							}
							delivered
						} else {
							state.submit_pending = true;
							commands_tx
								.send_async(UiCmd::Submit { item: Box::new(item), budget })
								.await
								.is_ok()
						};
						if delivered {
							state.has_history = true;
							send_backend(backend, BackendEvent::UserReplayed {
								text: prompt_text,
								chips,
								queued: active,
							});
							if let Some(replanned) = title_replanned {
								maybe_spawn_session_title(parent, control, state, text.as_str(), replanned);
							}
							if active {
								state.queued = state.queued.saturating_add(1);
								if let Some(prompt) = queued_prompt {
									state.queued_prompts.push_back(prompt);
								}
							} else {
								state.turn_started.get_or_insert_with(Instant::now);
								state.pending_prompt = pending_prompt;
							}
						} else {
							state.submit_pending = false;
							state.pending_prompt = None;
							send_backend(
								backend,
								BackendEvent::Error(sf!("Agent input channel is closed.")),
							);
						}
					}
				},
				Err(error) => send_backend(backend, BackendEvent::Error(Str::from(error.to_string()))),
			}
		},
		Intent::Abort => {
			if chat_active(state.submit_pending, bus.phase()) {
				abort.abort();
				modes.pause_loop();
				if let Ok(Some(goal)) = modes.interrupt_goal(now_ms(), true) {
					if let Some(activation) = modes.mode_activation() {
						let _ = stop_mode_regime(backend, commands_tx, "goal", activation).await;
					}
					send_backend(backend, BackendEvent::Notice(goal_status(Some(goal))));
				}
			}
		},
		Intent::PlanSavePathRequest { content } => {
			let suggested_path = plan_save_suggested_path(parent, content.as_str()).await;
			send_backend(backend, BackendEvent::OpenPlanSavePrompt { content, suggested_path });
		},
		Intent::SavePlanAndQuit { path, content } => {
			let path = Str::new(path.trim());
			if path.is_empty() {
				send_backend(backend, BackendEvent::Error(sf!("Plan save path cannot be empty.")));
				return Ok(false);
			}
			if let Err(error) = invoke_plan_write(&state.environment, path.clone(), content).await {
				send_backend(
					backend,
					BackendEvent::Error(sf!("Failed to save plan to `{path}`: {error}")),
				);
				return Ok(false);
			}
			if modes.mode_holder().as_deref() == Some("plan")
				&& let Some(activation) = modes.mode_activation()
			{
				let stopped = if chat_active(state.submit_pending, bus.phase()) {
					stop_streaming_plan_regime(backend, control, modes, abort, activation).await
				} else {
					stop_mode_regime(backend, commands_tx, "plan", activation).await
				};
				if !stopped {
					send_backend(
						backend,
						BackendEvent::Error(
							sf!("Saved plan to `{path}`, but could not exit plan mode.",),
						),
					);
					return Ok(false);
				}
			}
			send_backend(backend, BackendEvent::Notice(sf!("Saved plan to `{path}`.")));
			send_backend(backend, BackendEvent::NewSessionRequested);
		},
		Intent::SetGoal { objective, token_budget } => {
			if let Some(receipt) =
				start_mode_regime(backend, commands_tx, modes, "goal", false, None).await
			{
				match modes.set_goal(objective, token_budget, now_ms()) {
					Ok(goal) => {
						send_backend(backend, BackendEvent::Notice(goal_status(Some(goal))));
					},
					Err(error) => {
						let _ = stop_mode_regime(backend, commands_tx, "goal", receipt.activation).await;
						send_backend(backend, BackendEvent::Error(Str::new(error.to_string())));
					},
				}
			}
		},
		Intent::Dequeue => {
			let removed = mailbox.take_unstarted_producers().await.unwrap_or(0);
			let restored = removed.min(state.queued_prompts.len());
			let prompts = state.queued_prompts.drain(..restored).collect::<Vec<_>>();
			state.queued = state.queued.saturating_sub(restored);
			if prompts.is_empty() {
				send_backend(backend, BackendEvent::Notice(sf!("No queued messages to restore.")));
			} else {
				send_backend(backend, BackendEvent::QueuedPromptsRestored(prompts));
				send_backend(
					backend,
					BackendEvent::Notice(sf!(
						"Restored {restored} queued message{} to the editor.",
						if restored == 1 { "" } else { "s" },
					)),
				);
			}
		},
		Intent::Retry => {
			if chat_active(state.submit_pending, bus.phase()) {
				send_backend(backend, BackendEvent::Notice(sf!("Wait for the active turn to finish.")));
			} else {
				let (reply_tx, reply_rx) = flume::bounded(1);
				if commands_tx
					.send_async(UiCmd::Retry { reply: reply_tx })
					.await
					.is_ok() && let Ok(Ok((items, text))) = reply_rx.recv_async().await
				{
					state.tools.clear();
					state.has_history = true;
					send_backend(backend, BackendEvent::HistoryCleared);
					replay_items(backend, &items, &mut state.tools, &mut state.part_serial, renderers);
					send_backend(backend, BackendEvent::UserReplayed {
						text,
						chips: Vec::new(),
						queued: false,
					});
				}
			}
		},
		Intent::CycleModel { backward } => {
			if !state.model_settings.enabled_models.is_empty() {
				let mut unscoped = state.model_settings.clone();
				unscoped.enabled_models = Arc::from([]);
				let available =
					model_rows(state.catalog.as_ref(), &unscoped, state.auth_control.as_ref())
						.into_iter()
						.map(|row| row.key.to_string())
						.collect::<HashSet<_>>();
				let mut controls = omp_driver::model_controls::ModelControls::default();
				controls.set_scoped_from_settings(
					state.catalog.as_ref(),
					&state.model_settings,
					|key| available.contains(key.as_str()),
				);
				let direction = if backward {
					omp_driver::model_controls::CycleDirection::Backward
				} else {
					omp_driver::model_controls::CycleDirection::Forward
				};
				if let Some(selection) =
					controls.cycle_scoped(ModelKey::from_ref(&state.model), direction)
				{
					switch_model_with_thinking(
						backend,
						agent_state,
						settings_manager,
						selection.model.as_str(),
						state,
						control,
						parent,
						selection.thinking,
						false,
					)
					.await;
				}
				return Ok(false);
			}
			let rows = cycle_model_rows(
				state.catalog.as_ref(),
				&state.model_settings,
				state.auth_control.as_ref(),
			);
			if !rows.is_empty() {
				let current = rows
					.iter()
					.position(|row| row.key.as_str() == state.model)
					.unwrap_or_default();
				let next = if backward {
					(current + rows.len() - 1) % rows.len()
				} else {
					(current + 1) % rows.len()
				};
				switch_model(
					backend,
					agent_state,
					settings_manager,
					rows[next].key.as_str(),
					state,
					control,
					parent,
					false,
				)
				.await;
			}
		},
		Intent::CycleThinking => {
			cycle_interactive_thinking(agent_state, state);
			send_status(backend, state, bus, dropped);
		},
		Intent::CloseExtensionInspector => {
			if let Some(subscription) = state.extension_mcp.take() {
				subscription.cancel();
			}
			state.extension_live_mcp.clear();
		},
		Intent::ToggleExtension { id, enabled } => {
			send_backend(
				backend,
				BackendEvent::Error(sf!(
					"Extension `{id}` cannot be {} without an attached discovery configuration owner.",
					if enabled { "enabled" } else { "disabled" },
				)),
			);
		},
		Intent::Git(intent) => {
			if matches!(intent, omp_chat_ui::git::GitIntent::Close) {
				if let Some(git) = state.git.take() {
					let _ = git.session.handle(intent).await;
				}
			} else if let Some(session) = state.git.as_ref().map(|git| git.session.clone()) {
				let backend = backend.clone();
				drop(tokio::spawn(async move {
					let result = session
						.handle_with_progress(intent, |update| {
							send_backend(&backend, BackendEvent::Git(update));
						})
						.await;
					let mut snapshot_delivered = false;
					for update in result.updates {
						snapshot_delivered |= matches!(&update, omp_chat_ui::git::GitUpdate::Snapshot(_));
						send_backend(&backend, BackendEvent::Git(update));
					}
					if snapshot_delivered && let Ok(Some(snapshot)) = session.deferred_stats().await {
						send_backend(
							&backend,
							BackendEvent::Git(omp_chat_ui::git::GitUpdate::Snapshot(snapshot)),
						);
					}
				}));
			}
		},
		Intent::CloseRawStream => {
			state.raw_stream = None;
			send_backend(backend, BackendEvent::RawStreamClosed);
		},
		Intent::CopyToClipboard(text) => {
			send_backend(backend, BackendEvent::CopyToClipboard(text));
		},
		Intent::TogglePlan => {
			let operation = if modes.mode_holder().as_deref() == Some("plan") {
				"off"
			} else {
				"on"
			};
			handle_plan_command(
				backend,
				commands_tx,
				control,
				modes,
				abort,
				chat_active(state.submit_pending, bus.phase()),
				operation,
			)
			.await;
		},
		Intent::ToggleLive => {
			toggle_live_voice(backend, state);
			send_status(backend, state, bus, dropped);
		},
		Intent::LiveVoice(LiveVoiceAction::SetMuted(muted)) => {
			match state.audio.set_live_muted(muted) {
				Ok(()) => {
					tracing::debug!(
						session_id = %state.session_id,
						muted,
						"live voice mute state changed"
					);
					send_backend(
						backend,
						BackendEvent::Notice(sf!(if muted {
							"Live voice muted."
						} else {
							"Live voice unmuted."
						})),
					);
				},
				Err(error) => {
					tracing::warn!(
						error,
						session_id = %state.session_id,
						muted,
						"live voice mute change denied"
					);
					send_backend(backend, BackendEvent::Error(Str::new(error)));
				},
			}
		},
		Intent::LiveVoice(LiveVoiceAction::Close) => {
			state.audio.stop_live();
			tracing::debug!(session_id = %state.session_id, "live voice closed");
			send_backend(backend, BackendEvent::LiveVoiceStopped);
			send_status(backend, state, bus, dropped);
		},
		Intent::ToggleStt => match state.audio.toggle_stt() {
			Ok(enabled) => {
				tracing::debug!(
					session_id = %state.session_id,
					enabled,
					"speech-to-text capture state changed"
				);
				send_backend(
					backend,
					BackendEvent::Notice(sf!(if enabled {
						"Speech-to-text capture enabled."
					} else {
						"Speech-to-text capture disabled."
					})),
				);
			},
			Err(error) => {
				tracing::warn!(
					%error,
					session_id = %state.session_id,
					"speech-to-text capture change denied"
				);
				send_backend(
					backend,
					BackendEvent::Error(sf!("Could not change speech-to-text capture: {error}")),
				);
			},
		},
		Intent::Suspend | Intent::ResetDisplay | Intent::InspectHistory => {},
		Intent::OpenModelHub => send_open_model_hub(backend, settings_manager, state),
		Intent::ModelHub(intent) => {
			match apply_model_hub_intent(settings_manager, state.model_settings.role_storage, intent) {
				Ok(()) => {
					refresh_model_settings(settings_manager, state);
					send_backend(
						backend,
						BackendEvent::ModelHubUpdated(model_hub_data(settings_manager, state)),
					);
					send_models_updated(backend, state);
				},
				Err(error) => send_backend(
					backend,
					BackendEvent::Error(sf!("Could not save model configuration: {error}")),
				),
			}
		},
		Intent::ApplySettings { changes, commit } => {
			let previous_settings = state.settings.clone();
			let composer_style = state.settings.composer.shape;
			let spelling = state.settings.spelling;
			let smooth_streaming = state.settings.display.smooth_streaming;
			let appearance = state.settings.appearance.clone();
			apply_setting_changes(&mut state.settings, &changes)?;
			if state.settings.appearance != appearance
				&& let Err(error) = apply_configured_theme(backend, data_dir, state)
			{
				state.settings = previous_settings;
				return Err(error);
			}
			if state.settings.composer.shape != composer_style {
				send_backend(
					backend,
					BackendEvent::ComposerStyleChanged(presentation_composer_style(
						state.settings.composer.shape,
					)),
				);
			}
			if state.settings.spelling != spelling {
				send_backend(
					backend,
					BackendEvent::SpellingFeaturesChanged(omp_tui::SpellingFeatures {
						typo_detection: state.settings.spelling.typo_detection,
						autocomplete:   state.settings.spelling.autocomplete,
						autocorrect:    state.settings.spelling.autocorrect,
					}),
				);
			}
			if state.settings.display.smooth_streaming != smooth_streaming {
				send_backend(
					backend,
					BackendEvent::SmoothStreamingChanged(state.settings.display.smooth_streaming),
				);
			}
			send_recap_policy(backend, &state.settings);
			if commit {
				for change in &changes {
					let raw = match &change.value {
						serde_json::Value::String(value) => value.clone(),
						value => value.to_string(),
					};
					settings_manager
						.set_sync(MutationScope::Global, change.path.as_str(), &raw)
						.into_diagnostic()?;
				}
				send_backend(backend, BackendEvent::Notice(sf!("Settings saved.")));
			}
		},
		Intent::AutoQaConsent(intent) => {
			match omp_driver::telemetry_upload::apply_consent(telemetry_index, intent) {
				Ok(true) => send_backend(backend, BackendEvent::Notice(sf!("AutoQA consent saved."))),
				Ok(false) => send_backend(
					backend,
					BackendEvent::Error(sf!("AutoQA report changed before consent could be saved.")),
				),
				Err(error) => {
					send_backend(
						backend,
						BackendEvent::Error(sf!("Could not save AutoQA consent: {error}")),
					);
				},
			}
		},
		Intent::Select { purpose, key } => match purpose {
			omp_chat_ui::SelectionPurpose::Copy => {
				send_backend(backend, BackendEvent::CopyToClipboard(key));
			},
			omp_chat_ui::SelectionPurpose::Hook
			| omp_chat_ui::SelectionPurpose::Advisor
			| omp_chat_ui::SelectionPurpose::History => {
				send_backend(backend, BackendEvent::PromptDropped {
					text:        key,
					attachments: Vec::new(),
				});
			},
		},
		Intent::AgentSteer { id, prompt } => {
			let facts = parent.agent_hub_facts(state.session_id.as_str());
			let root = facts.iter().find(|row| row.parent.is_none());
			let allowed = facts
				.iter()
				.find(|row| row.id == id)
				.is_some_and(|row| row.capabilities.steer);
			if !allowed || prompt.trim().is_empty() {
				send_backend(
					backend,
					BackendEvent::Error(sf!("Selected agent is not accepting steering.")),
				);
			} else if let Some(root) = root {
				let message = PeerMessage {
					id:            Str::from(omp_core::Ulid::generate().to_string()),
					from:          root.id.clone(),
					to:            id,
					text:          prompt,
					mode:          DeliveryMode::Steer,
					reply_to:      None,
					sent_ms:       now_ms(),
					session_id:    state.session_id.clone(),
					expects_reply: false,
				};
				if parent.broker().send(message).is_err() {
					send_backend(
						backend,
						BackendEvent::Error(sf!("Agent steering delivery was refused.")),
					);
				}
			}
		},
		Intent::AgentRevive { id, prompt } => {
			let facts = parent.agent_hub_facts(state.session_id.as_str());
			let root = facts.iter().find(|row| row.parent.is_none());
			let allowed = facts
				.iter()
				.find(|row| row.id == id)
				.is_some_and(|row| row.capabilities.revive);
			if !allowed || prompt.trim().is_empty() {
				send_backend(backend, BackendEvent::Error(sf!("Selected agent cannot be revived.")));
			} else if let Some(root) = root {
				let message = PeerMessage {
					id:            Str::from(omp_core::Ulid::generate().to_string()),
					from:          root.id.clone(),
					to:            id,
					text:          prompt,
					mode:          DeliveryMode::Steer,
					reply_to:      None,
					sent_ms:       now_ms(),
					session_id:    state.session_id.clone(),
					expects_reply: false,
				};
				if parent.broker().send(message).is_err() {
					send_backend(
						backend,
						BackendEvent::Error(sf!("Agent revival delivery was refused.")),
					);
				}
			}
		},
		Intent::AgentKill { id } => {
			let allowed = parent
				.agent_hub_facts(state.session_id.as_str())
				.iter()
				.find(|row| row.id == id)
				.is_some_and(|row| row.capabilities.kill);
			if allowed {
				parent.cancel_child(id.as_str());
			} else {
				send_backend(backend, BackendEvent::Error(sf!("Selected agent cannot be killed.")));
			}
		},
		Intent::PtyInput { id, data } => {
			let result = match state.active_ptys.get(id.as_str()) {
				Some(control) => control.stdin(data).await,
				None => Ok(false),
			};
			if let Err(error) = result {
				send_backend(backend, BackendEvent::Error(sf!("PTY input failed: {error}")));
			}
		},
		Intent::PtyResize { id, rows, columns } => {
			if let Some(control) = state.active_ptys.get(id.as_str()) {
				let _ = control.resize(u32::from(rows), u32::from(columns)).await;
			}
		},
		Intent::PtyKill { id } => {
			let result = match state.active_ptys.get(id.as_str()).cloned() {
				Some(control) => control.cancel(ExecControlKind::Kill, 0).await,
				None => Ok(false),
			};
			match result {
				Ok(true) => {
					state.active_ptys.remove(id.as_str());
					send_backend(backend, BackendEvent::PtyFinished {
						id,
						status: omp_chat_ui::PtyStatus::Killed,
						exit_code: Some(137),
					});
				},
				Ok(false) => {},
				Err(error) => {
					send_backend(backend, BackendEvent::Error(sf!("PTY force-kill failed: {error}")))
				},
			}
		},
		Intent::Approval { ticket_id, action } => {
			let Some(request) = state.approvals.remove(ticket_id.as_str()) else {
				send_backend(
					backend,
					BackendEvent::Error(sf!("Approval `{ticket_id}` is no longer pending.")),
				);
				return Ok(false);
			};
			let decision = approval_decision(&request, action);
			if request.respond(decision).is_err() {
				send_backend(
					backend,
					BackendEvent::Error(sf!("Approval `{ticket_id}` was already settled.")),
				);
			}
			send_backend(backend, BackendEvent::ApprovalSettled { ticket_id });
		},
		Intent::RewindRequest => {
			if chat_active(state.submit_pending, bus.phase()) {
				send_backend(
					backend,
					BackendEvent::Error(sf!("Wait for the active turn to finish before rewinding.",)),
				);
			} else {
				let (reply_tx, reply_rx) = flume::bounded(1);
				if commands_tx
					.send_async(UiCmd::ListRewind { reply: reply_tx })
					.await
					.is_err()
				{
					send_backend(backend, BackendEvent::Error(sf!("Agent input channel is closed.")));
				} else {
					match reply_rx.recv_async().await {
						Ok(Ok(targets)) => {
							state.rewind_targets = targets;
							send_backend(
								backend,
								BackendEvent::RewindTargets(
									state
										.rewind_targets
										.iter()
										.map(|target| RewindTargetRow {
											event: target.event,
											text:  target.text.clone(),
										})
										.collect(),
								),
							);
						},
						Ok(Err(error)) => send_backend(backend, BackendEvent::Error(Str::from(error))),
						Err(_) => send_backend(
							backend,
							BackendEvent::Error(sf!("Agent rewind reply channel is closed.")),
						),
					}
				}
			}
		},
		Intent::SearchHistory => match session_index.prompt_history("", PROMPT_HISTORY_ROWS) {
			Ok(entries) if entries.is_empty() => {
				send_backend(backend, BackendEvent::Notice(sf!("No prompt history yet.")));
			},
			Ok(entries) => {
				let rows = entries
					.into_iter()
					.map(|entry| ListRow {
						key:    entry.prompt.clone(),
						label:  Str::new(entry.prompt.lines().next().unwrap_or("")),
						detail: entry
							.ts_ms
							.map(|ts| components::relative_age(now_ms().saturating_sub(ts)))
							.unwrap_or_default(),
					})
					.collect();
				send_backend(backend, BackendEvent::OpenSelection {
					title: sf!("Prompt history"),
					purpose: omp_chat_ui::SelectionPurpose::History,
					rows,
				});
			},
			Err(error) => send_backend(
				backend,
				BackendEvent::Error(sf!("Could not load prompt history: {error}")),
			),
		},
		Intent::Rewind { event } => {
			let target = state
				.rewind_targets
				.iter()
				.find(|target| target.event == event)
				.cloned();
			if let Some(target) = target {
				let (reply_tx, reply_rx) = flume::bounded(1);
				if commands_tx
					.send_async(UiCmd::Rewind { to: target.keep, reply: reply_tx })
					.await
					.is_err()
				{
					send_backend(backend, BackendEvent::Error(sf!("Agent input channel is closed.")));
				} else {
					match reply_rx.recv_async().await {
						Ok(Ok(items)) => {
							state.tools.clear();
							state.has_history = !items.is_empty();
							let user_index = state
								.rewind_targets
								.iter()
								.position(|candidate| candidate.event == target.event)
								.unwrap_or_default();
							send_backend(backend, BackendEvent::HistoryRewind {
								user_index,
								text: target.text.clone(),
								attachments: rewind_attachments(&target.parts),
							});
							replay_items(
								backend,
								&items,
								&mut state.tools,
								&mut state.part_serial,
								renderers,
							);
							send_backend(backend, BackendEvent::HistoryReplayFinished);
							state.rewind_targets.clear();
						},
						Ok(Err(error)) => send_backend(backend, BackendEvent::Error(Str::from(error))),
						Err(_) => send_backend(
							backend,
							BackendEvent::Error(sf!("Agent rewind reply channel is closed.")),
						),
					}
				}
			} else {
				send_backend(
					backend,
					BackendEvent::Error(sf!("The selected rewind target is no longer available.",)),
				);
			}
		},
		Intent::SwitchModel(model) => {
			switch_model(
				backend,
				agent_state,
				settings_manager,
				model.as_str(),
				state,
				control,
				parent,
				false,
			)
			.await;
		},
		Intent::Login(provider) => {
			if chat_active(state.submit_pending, bus.phase()) {
				send_backend(
					backend,
					BackendEvent::Error(sf!("Wait for the active turn to finish before logging in.",)),
				);
			} else {
				handle_login(backend, auth, provider, state);
			}
		},
		Intent::Logout(target) => {
			if chat_active(state.submit_pending, bus.phase()) {
				send_backend(
					backend,
					BackendEvent::Error(sf!("Wait for the active turn to finish before logging out.")),
				);
			} else {
				let roster = state.typed_commands.clone();
				let mut command_host = LiveCommandHost {
					mcp_inspector,
					backend,
					commands_tx,
					abort,
					control,
					agent_state,
					modes,
					auth,
					auth_control,
					parent: parent.clone(),
					mailbox,
					extension_reload,
					data_dir,
					settings_manager,
					session_index,
					list_sessions,
					bus,
					registry,
					renderers,
					dropped,
					roster,
					state,
				};
				if let CommandResult::Consumed(consumed) =
					ConfigCommandHost::logout(&mut command_host, target).await?
					&& let Some(status) = consumed.status
				{
					send_backend(backend, BackendEvent::Notice(status));
				}
			}
		},
		Intent::Resume(None) => {
			if chat_active(state.submit_pending, bus.phase()) {
				send_backend(
					backend,
					BackendEvent::Error(sf!(
						"Wait for the active turn to finish before resuming another session.",
					)),
				);
			} else {
				match list_sessions() {
					Ok(choices) => {
						send_backend(backend, BackendEvent::Sessions(session_rows(choices)));
					},
					Err(error) => send_backend(
						backend,
						BackendEvent::Error(sf!("Could not list sessions: {error}")),
					),
				}
			}
		},
		Intent::Resume(Some(_)) | Intent::NewSession => {},
		Intent::AuthAnswer { value } => {
			if let (Some(auth), Some(kind)) = (auth, state.pending_auth_kind.take()) {
				if let Err(error) = auth.answer(auth_input(kind, value)) {
					send_backend(backend, BackendEvent::Error(Str::from(error)));
				}
			} else {
				send_backend(backend, BackendEvent::Error(sf!("No authentication prompt is active.")));
			}
		},
		Intent::AuthCancel => {
			state.pending_auth_kind = None;
			if let Some(auth) = auth
				&& let Err(error) = auth.cancel()
			{
				send_backend(backend, BackendEvent::Error(Str::from(error)));
			}
		},
		Intent::Help => {
			send_backend(
				backend,
				BackendEvent::Notice(Str::from(append_hotkeys(state.typed_commands.help_text(
					CommandSurface::Tui,
					command_role(state.collab.as_ref()),
					true,
					|_| true,
				)))),
			);
		},
		Intent::Quit => {
			if chat_active(state.submit_pending, bus.phase()) {
				abort.abort();
			}
			return Ok(true);
		},
	}
	send_status(backend, state, bus, dropped);
	Ok(false)
}

fn parse_local_command(text: &str) -> Option<(DeferredCommandKind, DeferredContext, &str)> {
	let text = text.trim();
	if let Some(source) = text.strip_prefix("$$") {
		return Some((DeferredCommandKind::Eval, DeferredContext::Excluded, source.trim()));
	}
	if let Some(source) = text.strip_prefix('$') {
		return Some((DeferredCommandKind::Eval, DeferredContext::Included, source.trim()));
	}
	text
		.strip_prefix('!')
		.map(|source| (DeferredCommandKind::Shell, DeferredContext::Excluded, source.trim()))
}

fn looks_like_pasted_transcript(source: &str) -> bool {
	source.lines().skip(1).any(|line| {
		let line = line.trim_start().to_ascii_lowercase();
		["user:", "assistant:", "tool:", "system:", "<tool", "<assistant"]
			.iter()
			.any(|prefix| line.starts_with(prefix))
	})
}

async fn execute_deferred_command<C>(
	backend: &flume::Sender<BackendEvent>,
	state: &mut BridgeState,
	registry: &Registry,
	parent: &ChatParentHost<C>,
	command: DeferredCommand,
) where
	C: TurnClient + Clone + Send + 'static,
{
	let name = <&'static str>::from(command.kind);
	send_backend(backend, BackendEvent::ToolStarted {
		id:    command.id.clone(),
		name:  sf!(name),
		rev:   sf!("1"),
		title: command.source.clone(),
	});
	let result = match command.kind {
		DeferredCommandKind::Shell => execute_deferred_shell(backend, state, parent, &command).await,
		DeferredCommandKind::Eval => {
			execute_deferred_eval(backend, state, registry, parent, &command).await
		},
	};
	let (ok, preview) = match result {
		Ok(preview) => (true, preview),
		Err(error) => (false, sf!("{error}")),
	};
	let view = deferred_result_view(name, &preview, ok, command.context);
	let terminal = if ok {
		ToolTerminal::Succeeded
	} else {
		ToolTerminal::Failed
	};
	send_backend(backend, BackendEvent::ToolFinished { id: command.id.clone(), terminal, view });
	send_retained_fact(
		backend,
		"async-job",
		command.id.as_str(),
		serde_json::json!({
			"name": command.id.as_str(),
			"status": if ok { "succeeded" } else { "failed" },
			"detail": preview.as_str(),
		}),
		preview.as_str(),
	);
}

async fn execute_deferred_shell<C>(
	backend: &flume::Sender<BackendEvent>,
	state: &BridgeState,
	parent: &ChatParentHost<C>,
	command: &DeferredCommand,
) -> miette::Result<Str>
where
	C: TurnClient + Clone + Send + 'static,
{
	let cwd = PathBuf::from(state.workspace_root.as_str());
	let (source, cwd, env_overrides) = parent
		.admit_user_bash(
			command.source.as_str(),
			&cwd,
			matches!(command.context, DeferredContext::Excluded),
		)
		.await
		.map_err(|denial| miette::miette!("{}", denial.reason))?;
	let env_delta = EnvironmentDelta {
		set:   env_overrides
			.iter()
			.filter_map(|(name, value)| value.as_ref().map(|value| (name.clone(), value.clone())))
			.collect(),
		unset: env_overrides
			.iter()
			.filter_map(|(name, value)| value.is_none().then(|| name.clone()))
			.collect(),
		props: None,
	};
	let opened = state
		.environment
		.open_session(&cwd, OpenSessionRequest {
			env_delta: Some(env_delta),
			..OpenSessionRequest::default()
		})
		.await
		.into_diagnostic()?;
	let session = opened.session.clone();
	let run = state
		.environment
		.exec(ExecRequest {
			session: opened.session,
			source: Some(Script { text: source.to_string(), ..Script::default() }),
			..ExecRequest::default()
		})
		.await;
	let result = async {
		let mut run = run.into_diagnostic()?;
		let mut preview = String::new();
		loop {
			match run.next_event().await.into_diagnostic()? {
				Some(omp_env::ExecEvent::Output(frame))
					if matches!(
						frame.channel,
						value if value == OutputChannel::Stdout as i32
							|| value == OutputChannel::Stderr as i32
					) =>
				{
					let text = String::from_utf8_lossy(&frame.data);
					append_bounded_preview(&mut preview, &text);
					send_backend(backend, BackendEvent::ToolOutput {
						id:    command.id.clone(),
						chunk: Str::from(text.as_ref()),
					});
				},
				Some(omp_env::ExecEvent::Exit(exit)) => {
					let status = exit
						.status
						.ok_or_else(|| miette::miette!("Environment omitted shell exit status"))?;
					if status.outcome != ExecOutcome::Exited as i32 || status.exit_code != Some(0) {
						return Err(miette::miette!(
							"shell exited with status {:?}: {}",
							status.exit_code,
							preview
						));
					}
					return Ok(Str::from(if preview.is_empty() {
						"(no output)"
					} else {
						preview.as_str()
					}));
				},
				Some(omp_env::ExecEvent::Started(_) | omp_env::ExecEvent::Output(_)) => {},
				None => return Err(miette::miette!("Environment shell stream closed before exit")),
			}
		}
	}
	.await;
	let _ = state
		.environment
		.close_session(CloseSessionRequest { session, ..CloseSessionRequest::default() })
		.await;
	result
}

async fn execute_deferred_eval<C>(
	backend: &flume::Sender<BackendEvent>,
	state: &BridgeState,
	registry: &Registry,
	parent: &ChatParentHost<C>,
	command: &DeferredCommand,
) -> miette::Result<Str>
where
	C: TurnClient + Clone + Send + 'static,
{
	let code = parent
		.admit_user_eval(
			command.source.as_str(),
			Path::new(state.workspace_root.as_str()),
			matches!(command.context, DeferredContext::Excluded),
		)
		.await
		.map_err(|denial| miette::miette!("{}", denial.reason))?;
	let raw = serde_json::to_string(&serde_json::json!({
		"language": "py",
		"code": code,
		"title": "interactive",
	}))
	.into_diagnostic()?;
	let (feed, params) = omp_tool::IncomingParams::owned_channel(sf!("interactive-ui"));
	feed.args_committed(Str::from(raw)).into_diagnostic()?;
	drop(feed);
	let mut stream = registry.invoke("eval", params).into_diagnostic()?;
	let mut preview = String::new();
	while let Some(event) = stream.next().await {
		match event.into_diagnostic()? {
			omp_tool::ErasedEv::Update(json) => {
				let text = deferred_json_preview(&json);
				append_bounded_preview(&mut preview, &text);
				send_backend(backend, BackendEvent::ToolView {
					id:   command.id.clone(),
					view: deferred_result_view(
						"eval",
						&Str::from(preview.as_str()),
						true,
						command.context,
					),
				});
			},
			omp_tool::ErasedEv::Done(outcome) => {
				if let omp_tool::ErasedOutcome::Done { verdict, .. } = outcome {
					let text = deferred_json_preview(&verdict);
					append_bounded_preview(&mut preview, &text);
				}
				break;
			},
		}
	}
	Ok(Str::from(if preview.is_empty() {
		"(no output)"
	} else {
		preview.as_str()
	}))
}

fn append_bounded_preview(output: &mut String, text: &str) {
	const MAX_PREVIEW_BYTES: usize = 16 * 1024;
	if output.len() >= MAX_PREVIEW_BYTES {
		return;
	}
	let remaining = MAX_PREVIEW_BYTES - output.len();
	let end = text
		.char_indices()
		.map(|(index, _)| index)
		.take_while(|index| *index <= remaining)
		.last()
		.unwrap_or(0);
	let end = if text.len() <= remaining {
		text.len()
	} else {
		end
	};
	output.push_str(&text[..end]);
	if end < text.len() {
		output.push_str("\n... output truncated");
	}
}

fn deferred_json_preview(bytes: &[u8]) -> String {
	let Ok(value) = serde_json::from_slice::<serde_json::Value>(bytes) else {
		return String::from_utf8_lossy(bytes).into_owned();
	};
	for pointer in ["/output", "/text", "/data", "/message", "/result/text"] {
		if let Some(text) = value.pointer(pointer).and_then(serde_json::Value::as_str) {
			return text.to_owned();
		}
	}
	serde_json::to_string_pretty(&value).unwrap_or_default()
}

fn deferred_result_view(
	name: &str,
	preview: &Str,
	ok: bool,
	context: DeferredContext,
) -> ToolViewContent {
	let mut output = String::from("<col gap=0><row gap=1><text bold fg=");
	output.push_str(if ok { "success" } else { "error" });
	output.push('>');
	push_tml_text(&mut output, name);
	output.push_str("</text><text dim>");
	output.push_str(match context {
		DeferredContext::Included => "context included",
		DeferredContext::Excluded => "context excluded",
	});
	output.push_str("</text></row><text>");
	push_tml_text(&mut output, preview.as_str());
	output.push_str("</text></col>");
	ToolViewContent::Markup(Str::from(output))
}

fn handle_login(
	backend: &flume::Sender<BackendEvent>,
	auth: Option<&ChatAuth>,
	requested: Option<Str>,
	state: &mut BridgeState,
) {
	let Some(auth) = auth else {
		send_backend(backend, BackendEvent::Error(sf!(GATEWAY_LOGIN_MESSAGE)));
		return;
	};
	if let Some(requested) = requested {
		match resolve_login_provider(state.catalog.as_ref(), &requested) {
			Ok(provider) => match auth.start(provider.clone()) {
				Ok(()) => {
					state.pending_auth_provider = Some(provider.clone());
					send_login_panel(
						backend,
						state,
						LoginEvent::Notice(sf!("Starting authentication…")),
					);
				},
				Err(error) => send_backend(backend, BackendEvent::Error(Str::from(error))),
			},
			Err(error) => send_backend(backend, BackendEvent::Error(error)),
		}
	} else {
		let current = model_provider(state.catalog.as_ref(), &state.model);
		send_backend(
			backend,
			BackendEvent::LoginProviders(provider_rows(state.catalog.as_ref(), current.as_deref())),
		);
	}
}

fn installed_themes(data_dir: &Path) -> Vec<Str> {
	let mut names = vec![sf!("default"), sf!("dark"), sf!("light")];
	if let Ok(entries) = fs::read_dir(data_dir.join("themes")) {
		for entry in entries.flatten() {
			let path = entry.path();
			if path.extension().and_then(|extension| extension.to_str()) == Some("json")
				&& let Some(name) = path.file_stem().and_then(|name| name.to_str())
			{
				names.push(Str::new(name));
			}
		}
	}
	names.sort_unstable();
	names.dedup();
	names
}

fn apply_extension_theme(
	backend: &flume::Sender<BackendEvent>,
	data_dir: &Path,
	settings_manager: &SettingsManager,
	state: &mut BridgeState,
	theme: Str,
	persist: bool,
) -> miette::Result<()> {
	if !installed_themes(data_dir).iter().any(|name| name == &theme) {
		return Err(miette::miette!("theme `{theme}` is not installed"));
	}
	let previous_theme = state.settings.appearance.theme.clone();
	let previous_variant = state.settings.appearance.theme_variant.take();
	state.settings.appearance.theme = theme.clone();
	if let Err(error) = apply_configured_theme(backend, data_dir, state) {
		state.settings.appearance.theme = previous_theme;
		state.settings.appearance.theme_variant = previous_variant;
		return Err(error);
	}
	if persist {
		settings_manager
			.set_sync(MutationScope::Global, "appearance.theme", theme.as_str())
			.into_diagnostic()?;
	} else {
		state.settings.appearance.theme = previous_theme;
		state.settings.appearance.theme_variant = previous_variant;
	}
	Ok(())
}

fn apply_configured_theme(
	backend: &flume::Sender<BackendEvent>,
	data_dir: &Path,
	state: &mut BridgeState,
) -> miette::Result<()> {
	let configured = state.settings.appearance.theme.as_str();
	let revision = state.theme_revision.saturating_add(1);
	let builtin = match configured {
		"default" => Some(omp_tui::Theme::for_appearance(state.appearance)),
		"dark" => Some(omp_tui::Theme::for_appearance(omp_tui::Appearance::Dark)),
		"light" => Some(omp_tui::Theme::for_appearance(omp_tui::Appearance::Light)),
		_ => None,
	};
	let mut theme = if let Some(theme) = builtin {
		state.theme_watcher.clear(revision).into_diagnostic()?;
		theme
	} else {
		if configured.is_empty()
			|| Path::new(configured).components().count() != 1
			|| state
				.settings
				.appearance
				.theme_variant
				.as_deref()
				.is_some_and(|variant| {
					variant.is_empty() || Path::new(variant).components().count() != 1
				}) {
			return Err(miette::miette!("appearance.theme contains an invalid theme name"));
		}
		let themes = data_dir.join("themes");
		let path = state
			.settings
			.appearance
			.theme_variant
			.as_deref()
			.map(|variant| themes.join(format!("{configured}-{variant}.json")))
			.filter(|path| path.is_file())
			.unwrap_or_else(|| themes.join(format!("{configured}.json")));
		let source = fs::read_to_string(&path)
			.into_diagnostic()
			.wrap_err_with(|| format!("could not load configured theme `{}`", path.display()))?;
		state
			.theme_watcher
			.apply_environment_update(revision, &source)
			.into_diagnostic()?;
		state
			.theme_watcher
			.palette(state.appearance, true)
			.ok_or_else(|| miette::miette!("configured theme was not published"))?
	};
	if let Some(accent) = state.settings.appearance.accent.as_deref() {
		theme.accent = omp_tui::Color::parse(accent)
			.ok_or_else(|| miette::miette!("appearance.accent is not a valid color"))?;
	}
	state.theme_revision = revision;
	state.presentation.theme = theme;
	send_backend(backend, BackendEvent::ThemePreview(theme));
	Ok(())
}

async fn load_theme_preview(state: &mut BridgeState, args: &str) -> miette::Result<omp_tui::Theme> {
	let mut parts: Vec<_> = args.split_whitespace().collect();
	let quantized = parts.last().is_some_and(|part| *part == "256");
	if quantized {
		parts.pop();
	}
	let path = parts.join(" ");
	if path.is_empty() {
		return Err(miette::miette!("theme preview requires an Environment path"));
	}
	let bytes = tokio::fs::read(path).await.into_diagnostic()?;
	let source = str::from_utf8(&bytes).into_diagnostic()?;
	let revision = state.theme_revision.saturating_add(1);
	state
		.theme_watcher
		.apply_environment_update(revision, source)
		.into_diagnostic()?;
	state.theme_revision = revision;
	state
		.theme_watcher
		.palette(state.appearance, !quantized)
		.ok_or_else(|| miette::miette!("theme revision was not published"))
}

/// Forwards one login-panel update tagged with the provider under
/// authentication.
fn send_login_panel(backend: &flume::Sender<BackendEvent>, state: &BridgeState, event: LoginEvent) {
	let provider = state
		.pending_auth_provider
		.clone()
		.unwrap_or_else(|| sf!("provider"));
	send_backend(backend, BackendEvent::LoginPanel { provider, event });
}

fn handle_auth_event(
	backend: &flume::Sender<BackendEvent>,
	state: &mut BridgeState,
	event: ChatAuthEvent,
) {
	match event {
		ChatAuthEvent::Url { url, launch } => {
			send_login_panel(backend, state, LoginEvent::Url { url, launch });
		},
		ChatAuthEvent::DeviceCode { code, url } => {
			send_login_panel(backend, state, LoginEvent::DeviceCode { code, url });
		},
		ChatAuthEvent::Prompt { message, kind } => {
			state.pending_auth_kind = Some(kind);
			send_login_panel(backend, state, LoginEvent::Prompt {
				message,
				masked: prompt_masks_input(kind),
			});
		},
		ChatAuthEvent::Notice(message) => {
			send_login_panel(backend, state, LoginEvent::Notice(message));
		},
		ChatAuthEvent::Complete(message) => {
			state.pending_auth_kind = None;
			state.pending_auth_provider = None;
			send_backend(backend, BackendEvent::LoginPanelClose);
			send_backend(backend, BackendEvent::Notice(message));
			// A fresh credential can make new providers selectable.
			send_models_updated(backend, state);
		},
		ChatAuthEvent::CredentialStorageLocked => {
			state.pending_auth_kind = None;
			state.pending_auth_provider = None;
			send_backend(backend, BackendEvent::LoginPanelClose);
			send_backend(backend, BackendEvent::Error(sf!(CREDENTIAL_STORAGE_LOCKED_MESSAGE)));
		},
		ChatAuthEvent::Failed(message) => {
			state.pending_auth_kind = None;
			state.pending_auth_provider = None;
			send_backend(backend, BackendEvent::LoginPanelClose);
			send_backend(backend, BackendEvent::Error(message));
		},
	}
}

fn collaboration_stream_event(event: &AgentEvent) -> Option<omp_proto::collab::v1::StreamEvent> {
	use omp_proto::collab::v1::{Notice, StreamEvent, notice, stream_event};
	let (event_type, notice) = match event {
		AgentEvent::Turn { event, .. } => match &event.event {
			Some(Event::Accepted(_)) => (stream_event::EventType::TurnStart, None),
			Some(Event::Outcome(_)) => (stream_event::EventType::TurnEnd, None),
			Some(Event::PartStart(_)) => (stream_event::EventType::MessageStart, None),
			Some(Event::PartDelta(_)) => (stream_event::EventType::MessageUpdate, None),
			Some(Event::PartEnd(_)) => (stream_event::EventType::MessageEnd, None),
			_ => return None,
		},
		AgentEvent::Failed { message, .. } => (
			stream_event::EventType::Notice,
			Some(Notice {
				level:   notice::Level::Error as i32,
				message: message.to_string(),
				source:  String::from("agent"),
			}),
		),
		_ => return None,
	};
	Some(StreamEvent { event_type: event_type as i32, item: None, tool: None, notice })
}

async fn handle_collaboration_operation<C>(
	operation: omp_driver::collab::session::HostOperation,
	parent: &ChatParentHost<C>,
	abort: &omp_agent::AbortHandle,
	modes: &RegimeHandle,
	commands: &flume::Sender<UiCmd>,
	backend: &flume::Sender<BackendEvent>,
	state: &mut BridgeState,
	bus: &omp_agent::EventBus,
) where
	C: TurnClient + Clone + Send + 'static,
{
	use omp_driver::collab::session::HostOperation;
	match operation {
		HostOperation::Abort { principal, reason } => {
			if chat_active(state.submit_pending, bus.phase()) {
				abort.abort();
				modes.pause_loop();
				send_backend(
					backend,
					BackendEvent::Notice(sf!(
						"Collaboration participant `{}` interrupted the turn: {}",
						principal.display_name(),
						reason
					)),
				);
			}
		},
		HostOperation::AgentChat { principal, agent_id, text } => {
			let facts = parent.agent_hub_facts(state.session_id.as_str());
			let Some(target) = facts.iter().find(|row| row.id == agent_id) else {
				send_backend(backend, BackendEvent::Error(sf!("Unknown collaboration agent target.")));
				return;
			};
			if !(target.capabilities.steer || target.capabilities.revive) || text.trim().is_empty() {
				send_backend(
					backend,
					BackendEvent::Error(sf!("Selected collaboration agent is not accepting chat.")),
				);
				return;
			}
			let Some(root) = facts.iter().find(|row| row.parent.is_none()) else {
				return;
			};
			let message = PeerMessage {
				id: Str::from(omp_core::Ulid::generate().to_string()),
				from: root.id.clone(),
				to: agent_id,
				text,
				mode: DeliveryMode::Steer,
				reply_to: None,
				sent_ms: now_ms(),
				session_id: state.session_id.clone(),
				expects_reply: false,
			};
			if parent.broker().send(message).is_err() {
				send_backend(
					backend,
					BackendEvent::Error(sf!(
						"Collaboration agent chat from `{}` was refused.",
						principal.display_name()
					)),
				);
			}
		},
		HostOperation::AgentKill { agent_id, .. } => {
			let allowed = parent
				.agent_hub_facts(state.session_id.as_str())
				.iter()
				.find(|row| row.id == agent_id)
				.is_some_and(|row| row.capabilities.kill);
			if allowed {
				parent.cancel_child(agent_id.as_str());
			} else {
				send_backend(backend, BackendEvent::Error(sf!("Selected agent cannot be killed.")));
			}
		},
		HostOperation::AgentRevive { agent_id, .. } => {
			let allowed = parent
				.agent_hub_facts(state.session_id.as_str())
				.iter()
				.find(|row| row.id == agent_id)
				.is_some_and(|row| row.capabilities.revive);
			if !allowed {
				send_backend(backend, BackendEvent::Error(sf!("Selected agent cannot be revived.")));
			} else if let Err(error) = parent.supervisor().revive(agent_id.as_str()).await {
				send_backend(
					backend,
					BackendEvent::Error(sf!("Could not revive collaboration agent: {error}")),
				);
			}
		},
		HostOperation::UiAnswer { .. } => {
			send_backend(
				backend,
				BackendEvent::Error(sf!(
					"Collaboration UI answer has no matching host presentation request."
				)),
			);
		},
	}
	let _ = commands;
}

async fn handle_agent_event(
	backend: &flume::Sender<BackendEvent>,
	state: &mut BridgeState,
	event: &AgentEvent,
	modes: &RegimeHandle,
	renderers: &RenderRegistry,
	bus: &omp_agent::EventBus,
	dropped: u64,
) {
	match event {
		AgentEvent::Turn { turn_id, event } => match &event.event {
			Some(Event::Accepted(accepted)) => {
				state.replaying_turn = accepted.replay;
				state.token_rate = (!accepted.replay).then(|| TokenRateMeter::start(Instant::now()));
				state.tokens_per_second = None;
				modes.begin_streaming();
			},
			Some(Event::Outcome(outcome)) => {
				if state.replaying_turn {
					replay_items(
						backend,
						&outcome.output,
						&mut state.tools,
						&mut state.part_serial,
						renderers,
					);
					state.replaying_turn = false;
				}
				if state.queued > 0 {
					send_backend(backend, BackendEvent::QueuedPromptsSettled);
				}
				state.queued = 0;
				state.queued_prompts.clear();
				state.model.clone_from(&outcome.model);
				state.context_window = resolve_model(state.catalog.as_ref(), &outcome.model)
					.and_then(|spec| spec.limits.context_window);
				if let Some(cost) = &outcome.cost {
					state.cost_nanos = state.cost_nanos.saturating_add(cost.nanos_usd);
				}
				if let Some(snapshot) = &outcome.context_snapshot {
					state.context_tokens = snapshot.prompt_tokens;
					if let Some(window_tokens) = state.context_window
						&& snapshot.prompt_tokens <= window_tokens
					{
						let categorized = [
							snapshot.system_tokens,
							snapshot.message_tokens,
							snapshot.skill_tokens,
							snapshot.tool_tokens,
							snapshot.buffer_tokens,
						]
						.into_iter()
						.flatten()
						.fold(0_u64, u64::saturating_add);
						state.context_snapshot = Some(omp_agent::ContextSnapshot {
							turn_id: Str::from(turn_id.as_str()),
							prompt_anchor: snapshot.prompt_anchor.unwrap_or_default(),
							context_revision: snapshot.context_revision.unwrap_or(state.part_serial),
							compaction_epoch: snapshot.compaction_epoch.unwrap_or_default(),
							window_tokens,
							input_tokens: snapshot.prompt_tokens,
							system_tokens: snapshot.system_tokens,
							message_tokens: snapshot.message_tokens,
							skill_tokens: snapshot.skill_tokens,
							tool_tokens: snapshot.tool_tokens,
							buffer_tokens: snapshot.buffer_tokens,
							unclassified_tokens: snapshot
								.unclassified_tokens
								.unwrap_or(snapshot.prompt_tokens.saturating_sub(categorized)),
							slack_tokens: snapshot
								.slack_tokens
								.unwrap_or(window_tokens - snapshot.prompt_tokens),
							snapcompact_savings: snapshot.snapcompact_savings,
						});
					}
				}
				if let Some(usage) = &outcome.usage {
					if let Some(rate) = state.token_rate.as_mut() {
						rate.finalize(usage.output_tokens);
						state.tokens_per_second = rate.rate(Instant::now());
					}
					let _ = modes.record_goal_usage_delta(
						GoalUsage {
							input_tokens:        usage.input_tokens,
							cache_write_tokens:  usage.cache_write_tokens,
							cached_input_tokens: usage.cache_read_tokens,
							output_tokens:       usage.output_tokens,
						},
						now_ms(),
					);
				}
				for (_, id) in state.active_parts.drain() {
					send_backend(backend, BackendEvent::AssistantEnd { id });
				}
				if state.attempt > 1 {
					send_backend(
						backend,
						BackendEvent::TranscriptFrame(TranscriptFrame {
							kind:   TranscriptFrameKind::Recovery,
							title:  sf!("Recovered on attempt {}", state.attempt),
							detail: None,
						}),
					);
				}
				state.attempt = 0;
			},
			Some(Event::Attempt(attempt)) => {
				state.attempt = attempt.number;
				if attempt.number > 1 {
					// The retry re-streams the failed attempt's content from the
					// start; settling the partial would duplicate it.
					for (_, id) in state.active_parts.drain() {
						state.active_markdown.remove(id.as_str());
						send_backend(backend, BackendEvent::AssistantAbandoned { id });
					}
					send_backend(
						backend,
						BackendEvent::TranscriptFrame(TranscriptFrame {
							kind:   TranscriptFrameKind::Recovery,
							title:  sf!("Retry attempt {}", attempt.number),
							detail: None,
						}),
					);
				}
			},
			Some(Event::PartStart(start)) => match part_start::Kind::try_from(start.kind) {
				Ok(part_start::Kind::Text | part_start::Kind::Thinking) => {
					drain_open_assistant_parts(backend, state);
					state.part_serial = state.part_serial.saturating_add(1);
					let id = Str::from(format!("assistant-{}", state.part_serial));
					send_backend(backend, BackendEvent::AssistantBegin {
						id:       id.clone(),
						thinking: start.kind == part_start::Kind::Thinking as i32,
					});
					if start.kind != part_start::Kind::Thinking as i32
						&& state.extension_ui.has_markdown_transformers()
					{
						state
							.active_markdown
							.insert(id.clone(), (state.part_serial, String::new()));
					}
					state.active_parts.insert(start.index, id);
				},
				Ok(part_start::Kind::ToolCall) => {
					drain_open_assistant_parts(backend, state);
					let id = Str::from(start.tool_call_id.as_str());
					let identity = renderers
						.resolve_name(&start.tool_name)
						.cloned()
						.unwrap_or_else(|| missing_identity(&start.tool_name));
					let extension_renderer =
						extension_renderer_route(state.extension_ui.as_ref(), renderers, &identity);
					state.tools.insert(id.clone(), ToolDisplay {
						identity,
						args: omp_slopjson::Value::Object(omp_slopjson::Object::new()),
						started: false,
						fold: ViewState::new(),
						updates: Vec::new(),
						opened: Instant::now(),
						extension_renderer,
					});
					state.streaming_tools.insert(start.index, (id, Vec::new()));
				},
				_ => {},
			},
			Some(Event::PartDelta(delta)) => {
				if let Some(id) = state.active_parts.get(&delta.index)
					&& let Ok(fragment) = str::from_utf8(&delta.chunk)
				{
					if let Some((_, markdown)) = state.active_markdown.get_mut(id.as_str()) {
						markdown.push_str(fragment);
					}
					if let Some(rate) = state.token_rate.as_mut() {
						rate.observe_fragment(fragment);
						state.tokens_per_second = rate.rate(Instant::now());
					}
					send_backend(backend, BackendEvent::AssistantDelta {
						id:   id.clone(),
						text: Str::from(fragment),
					});
				} else if let Some((id, bytes)) = state.streaming_tools.get_mut(&delta.index) {
					bytes.extend_from_slice(&delta.chunk);
					if let Ok(fragment) = str::from_utf8(bytes)
						&& let Some(tool) = state.tools.get_mut(id.as_str())
					{
						tool.args = omp_slopjson::parse_streaming(fragment);
						ensure_tool_started(backend, id, tool, false);
						if let Some(view) = fold_tool_args(renderers, tool, false) {
							send_backend(backend, BackendEvent::ToolView { id: id.clone(), view });
						} else if tool.started
							&& let Some(input) = tool.args.get("input").and_then(|value| value.as_str())
						{
							send_backend(backend, BackendEvent::ToolView {
								id:   id.clone(),
								view: ToolViewContent::Plain(Str::from(input)),
							});
						}
					}
				}
			},
			Some(Event::PartEnd(end)) => {
				if let Some(id) = state.active_parts.remove(&end.index) {
					if let Some((revision, markdown)) = state.active_markdown.remove(id.as_str()) {
						let backend = backend.clone();
						let roster = Arc::clone(&state.extension_ui);
						let session = state.session_id.clone();
						drop(tokio::spawn(async move {
							let transformed = roster
								.transform_markdown(id.clone(), revision, Str::new(markdown), session)
								.await;
							send_backend(&backend, BackendEvent::AssistantReplace {
								id:   id.clone(),
								text: transformed,
							});
							send_backend(&backend, BackendEvent::AssistantEnd { id });
						}));
					} else {
						send_backend(backend, BackendEvent::AssistantEnd { id });
					}
				}
				state.streaming_tools.remove(&end.index);
			},
			_ => {},
		},
		AgentEvent::ToolOpened { call_id, name, rev } => {
			let identity = ToolIdentity { name: name.clone(), rev: rev.clone() };
			let extension_renderer =
				extension_renderer_route(state.extension_ui.as_ref(), renderers, &identity);
			if let Some(tool) = state.tools.get_mut(call_id.as_str()) {
				tool.identity = identity;
				tool.extension_renderer = extension_renderer;
				let _ = fold_tool_args(renderers, tool, true);
			} else {
				state.tools.insert(call_id.clone(), ToolDisplay {
					identity,
					args: omp_slopjson::Value::Object(omp_slopjson::Object::new()),
					started: false,
					fold: ViewState::new(),
					updates: Vec::new(),
					opened: Instant::now(),
					extension_renderer,
				});
			}
		},
		AgentEvent::ToolArgs { call_id, view, .. } => {
			if let Some(tool) = state.tools.get_mut(call_id.as_str()) {
				tool.args = view.clone();
				if let Some(view) = fold_tool_args(renderers, tool, true) {
					send_backend(backend, BackendEvent::ToolView { id: call_id.clone(), view });
				}
				ensure_tool_started(backend, call_id, tool, false);
			}
		},
		AgentEvent::ToolUpdate { call_id, json } => {
			let projection = if let Some(tool) = state.tools.get_mut(call_id.as_str()) {
				ensure_tool_started(backend, call_id, tool, true);
				if tool.identity.name == "bash"
					&& let Ok(update) = serde_json::from_slice::<omp_tools::shell::Update>(json)
					&& update.terminal
				{
					if update.started && !update.exec_id.is_empty() {
						state.active_ptys.insert(
							call_id.clone(),
							state
								.environment
								.active_exec_control(update.exec_id.clone()),
						);
						let command = tool
							.args
							.get("command")
							.and_then(|value| value.as_str())
							.map_or_else(|| sf!("interactive shell"), Str::from);
						send_backend(backend, BackendEvent::PtyStarted { id: call_id.clone(), command });
					}
					if !update.data.is_empty() {
						send_backend(backend, BackendEvent::PtyOutput {
							id:    call_id.clone(),
							chunk: Bytes::copy_from_slice(update.data.as_ref()),
						});
					}
				}
				if let Ok(update) = serde_json::from_slice(json) {
					tool.updates.push(update);
				}
				let native = fold_tool_update(renderers, tool, json.clone());
				let extension = tool.extension_renderer.map(|route| {
					(
						route,
						tool.identity.clone(),
						tool_renderer_view(call_id, tool, Value::Null, "EFFECTS_AUTHORIZED"),
					)
				});
				Some((native, extension))
			} else {
				None
			};
			if let Some((native, extension)) = projection {
				let view = if let Some((route, identity, extension_view)) = extension {
					state
						.extension_ui
						.render_tool(
							&identity,
							extension_view,
							tool_renderer_context(state),
							native,
							route.native_authoritative,
							state.session_id.clone(),
						)
						.await
				} else {
					native
				};
				send_backend(backend, BackendEvent::ToolView { id: call_id.clone(), view });
			}
		},
		AgentEvent::ToolFinished { call_id, item, usage } => {
			let _ = modes.checkpoint_goal_usage(
				GoalUsage {
					input_tokens:        usage.input_tokens,
					cache_write_tokens:  usage.cache_write_tokens,
					cached_input_tokens: usage.cache_read_tokens,
					output_tokens:       usage.output_tokens,
				},
				now_ms(),
			);
			if state.active_ptys.remove(call_id.as_str()).is_some() {
				send_backend(backend, BackendEvent::PtyFinished {
					id:        call_id.clone(),
					status:    omp_chat_ui::PtyStatus::Exited,
					exit_code: None,
				});
			}
			let mut tool = state.tools.remove(call_id.as_str());
			let (identity, terminal, native) = render_tool_result_view(renderers, item, tool.as_ref());
			let extension_renderer = match tool.as_ref() {
				Some(tool) => tool.extension_renderer,
				None => extension_renderer_route(state.extension_ui.as_ref(), renderers, &identity),
			};
			let extension_view = extension_renderer.map(|route| {
				let verdict = durable_tool_outcome(item)
					.and_then(|outcome| serde_json::from_slice(&outcome).ok())
					.unwrap_or(Value::Null);
				let view = match tool.as_ref() {
					Some(tool) => tool_renderer_view(call_id, tool, verdict, "SETTLED"),
					None => serde_json::json!({
						"call_id": call_id.as_str(),
						"updates": [],
						"state": null,
						"verdict": verdict,
						"elapsed": "0ms",
						"phase": "SETTLED",
						"presentation": {},
					}),
				};
				(route, view)
			});
			let is_report_issue = identity.name == "report_issue";
			if let Some(tool) = tool.as_mut() {
				ensure_tool_started(backend, call_id, tool, true);
			} else {
				send_backend(backend, BackendEvent::ToolStarted {
					id:    call_id.clone(),
					name:  identity.name.clone(),
					rev:   Str::from(identity.rev.to_string()),
					title: identity.name.clone(),
				});
			}
			send_tool_result_images(backend, call_id, item);
			let view = if let Some((route, extension_view)) = extension_view {
				state
					.extension_ui
					.render_tool(
						&identity,
						extension_view,
						tool_renderer_context(state),
						native,
						route.native_authoritative,
						state.session_id.clone(),
					)
					.await
			} else {
				native
			};
			send_backend(backend, BackendEvent::ToolFinished { id: call_id.clone(), terminal, view });
			if terminal == ToolTerminal::Succeeded
				&& identity.name == "todo"
				&& let Some(payload) = completed_todo_payload(item)
			{
				send_backend(backend, BackendEvent::TodoHud(todo_hud(&payload)));
			}
			if terminal == ToolTerminal::Succeeded
				&& is_report_issue
				&& let Some(request) = autoqa_consent_request(item)
			{
				send_backend(backend, BackendEvent::AutoQaConsent(request));
			}
		},
		AgentEvent::JobRegistered { job_id } => {
			state.jobs.insert(job_id.clone());
			send_retained_fact(
				backend,
				"async-job",
				job_id.as_str(),
				serde_json::json!({"name": job_id.as_str(), "status": "running"}),
				"Background job is running.",
			);
		},
		AgentEvent::JobSettled { job_id } => {
			state.jobs.remove(job_id);
			send_retained_fact(
				backend,
				"async-job",
				job_id.as_str(),
				serde_json::json!({"name": job_id.as_str(), "status": "settled"}),
				"Background job settled.",
			);
		},
		AgentEvent::HistoryRewritten { .. } => {
			match invoke_todo(&state.environment, &omp_tools::todo::Params {
				op:     omp_tools::todo::Op::View,
				list:   None,
				phase:  None,
				item:   None,
				items:  None,
				reason: None,
			})
			.await
			{
				Ok(payload) => send_backend(backend, BackendEvent::TodoHud(todo_hud(&payload))),
				Err(error) => send_backend(
					backend,
					BackendEvent::Error(sf!("Todo view failed after history rewrite: {error}")),
				),
			}
			if let Some(advisor) = state.advisor.as_ref() {
				advisor.lock().history_rewritten();
			}
		},
		AgentEvent::PeerRelay(observation) => {
			state.part_serial = state.part_serial.saturating_add(1);
			let stable_id = sf!("irc-{}-{}-{}", observation.from, observation.to, state.part_serial);
			send_retained_fact(
				backend,
				"irc",
				stable_id.as_str(),
				serde_json::json!({
					"title": format!("{} → {}", observation.from, observation.to),
					"message": observation.text.as_str(),
					"status": observation.outcome.to_string(),
					"ttl_ms": 30_000,
				}),
				"Peer coordination message.",
			);
			send_backend(
				backend,
				BackendEvent::TranscriptFrame(TranscriptFrame {
					kind:   TranscriptFrameKind::Peer,
					title:  sf!(
						"IRC {} → {} · {}",
						observation.from,
						observation.to,
						observation.outcome
					),
					detail: Some(observation.text.clone()),
				}),
			);
		},
		AgentEvent::Failed { message, .. } => {
			let _ = modes.settle_plan_transition();
			// The failed turn will never deliver `PartEnd`/`ToolFinished` for
			// work that was still streaming; settle those widgets instead of
			// leaving frozen spinners and half-drawn tool boxes behind.
			for (_, id) in state.active_parts.drain() {
				send_backend(backend, BackendEvent::AssistantEnd { id });
			}
			state.streaming_tools.clear();
			for (call_id, tool) in mem::take(&mut state.tools) {
				if !tool.started {
					continue;
				}
				if state.active_ptys.remove(call_id.as_str()).is_some() {
					send_backend(backend, BackendEvent::PtyFinished {
						id:        call_id.clone(),
						status:    omp_chat_ui::PtyStatus::Killed,
						exit_code: None,
					});
				}
				send_backend(backend, BackendEvent::ToolFinished {
					id:       call_id,
					terminal: ToolTerminal::Failed,
					view:     ToolViewContent::Plain(sf!("turn failed before this tool ran")),
				});
			}
			state.active_ptys.clear();
			state.part_serial = state.part_serial.saturating_add(1);
			let stable_id = sf!("diagnostic-{}", state.part_serial);
			send_retained_fact(
				backend,
				"diagnostic",
				stable_id.as_str(),
				serde_json::json!({
					"title": "Agent error",
					"message": message.as_str(),
					"severity": "error",
				}),
				"Agent error diagnostic.",
			);
			send_backend(
				backend,
				BackendEvent::TranscriptFrame(TranscriptFrame {
					kind:   TranscriptFrameKind::Error,
					title:  sf!("Agent error"),
					detail: Some(message.clone()),
				}),
			);
		},
		AgentEvent::TitleChanged { title, source } => {
			state.title = SessionTitleState { title: Some(title.clone()), source: Some(*source) };
			if *source == transcript::TitleSource::User {
				state.title_user_set.store(true, Ordering::Release);
			}
			send_backend(backend, BackendEvent::SessionTitle(title.clone()));
		},
		AgentEvent::RunStateChanged { to, .. } => {
			if matches!(to, AgentRunState::Idle | AgentRunState::Attention) {
				let _ = modes.settle_plan_transition();
			}
		},
		AgentEvent::Snapshot(_)
		| AgentEvent::ToolObserved { .. }
		| AgentEvent::PlanStateChanged { .. }
		| AgentEvent::PhaseChanged { .. }
		| AgentEvent::RosterChanged { .. } => {},
	}
	send_status(backend, state, bus, dropped);
}

fn autoqa_consent_request(item: &Item) -> Option<omp_chat_ui::autoqa::ConsentRequest> {
	let item::Kind::ToolResult(result) = item.kind.as_ref()? else {
		return None;
	};
	if result.is_error || result.name != "report_issue" {
		return None;
	}
	let value = value_to_json(result.details.as_ref()?)?;
	let payload = value.get("value")?;
	let issue_id = payload.get("issue_id")?.as_str()?;
	let target = payload.get("target")?.as_str()?;
	let revision = payload
		.get("revision")
		.and_then(serde_json::Value::as_str)
		.or_else(|| target.rsplit_once('@').map(|(_, revision)| revision))?;
	let summary = payload
		.get("summary")
		.and_then(serde_json::Value::as_str)
		.unwrap_or("A redacted AutoQA report is ready for optional delivery.");
	Some(omp_chat_ui::autoqa::ConsentRequest {
		issue_id: Str::new(issue_id),
		target:   Str::new(target),
		revision: Str::new(revision),
		summary:  Str::new(summary),
	})
}

fn replay_items(
	backend: &flume::Sender<BackendEvent>,
	items: &[Item],
	tools: &mut HashMap<Str, ToolDisplay>,
	serial: &mut u64,
	renderers: &RenderRegistry,
) {
	for item in items {
		match &item.kind {
			Some(item::Kind::Message(message)) => replay_message(backend, message, serial),
			Some(item::Kind::ToolCall(call)) => {
				let id = Str::from(call.id.as_str());
				let args = str::from_utf8(&call.args_json).map_or_else(
					|_| omp_slopjson::Value::Object(omp_slopjson::Object::new()),
					omp_slopjson::parse_streaming,
				);
				let identity =
					item_tool_identity(item, &call.name).unwrap_or_else(|| missing_identity(&call.name));
				let title = call
					.intent
					.as_deref()
					.map_or_else(|| tool_title(&identity.name, &args), Str::from);
				send_backend(backend, BackendEvent::ToolStarted {
					id: id.clone(),
					name: identity.name.clone(),
					rev: Str::from(identity.rev.to_string()),
					title,
				});
				let mut tool = ToolDisplay {
					identity,
					args,
					started: true,
					fold: ViewState::new(),
					updates: Vec::new(),
					opened: Instant::now(),
					extension_renderer: None,
				};
				let _ = fold_tool_args(renderers, &mut tool, true);
				tools.insert(id, tool);
			},
			Some(item::Kind::ToolResult(result)) => {
				let id = Str::from(result.call_id.as_str());
				let tool = tools.remove(id.as_str());
				let (identity, terminal, view) =
					render_tool_result_view(renderers, item, tool.as_ref());
				if tool.is_none() {
					send_backend(backend, BackendEvent::ToolStarted {
						id:    id.clone(),
						name:  identity.name.clone(),
						rev:   Str::from(identity.rev.to_string()),
						title: identity.name.clone(),
					});
				}
				send_tool_result_images(backend, &id, item);
				send_backend(backend, BackendEvent::ToolFinished { id, terminal, view });
			},
			_ => {},
		}
	}
}
/// Projects canonical transcript items into the backend events used by offline
/// rendering.
pub(crate) fn replay_backend_events(
	items: &[Item],
	renderers: &RenderRegistry,
) -> Vec<BackendEvent> {
	let (backend, events) = flume::unbounded();
	let mut tools = HashMap::new();
	let mut serial = 0;
	replay_items(&backend, items, &mut tools, &mut serial, renderers);
	drop(backend);
	events.try_iter().collect()
}

fn ensure_tool_started(
	backend: &flume::Sender<BackendEvent>,
	call_id: &Str,
	tool: &mut ToolDisplay,
	force: bool,
) {
	if tool.started {
		return;
	}
	let title = tool_title(&tool.identity.name, &tool.args);
	if !force && title == tool.identity.name {
		return;
	}
	send_backend(backend, BackendEvent::ToolStarted {
		id: call_id.clone(),
		name: tool.identity.name.clone(),
		rev: Str::from(tool.identity.rev.to_string()),
		title,
	});
	tool.started = true;
}

fn replay_message(backend: &flume::Sender<BackendEvent>, message: &Message, serial: &mut u64) {
	let mut text_parts = Vec::new();
	let mut thinking_parts = Vec::new();
	let mut chips = Vec::new();
	for part in &message.parts {
		match &part.kind {
			Some(part::Kind::Text(text)) => {
				if let Some(attachment) = text
					.strip_prefix("<attachment>")
					.and_then(|text| text.strip_suffix("</attachment>"))
				{
					let lines = attachment.bytes().filter(|byte| *byte == b'\n').count() + 1;
					chips.push(sf!("paste · {lines} lines"));
				} else {
					text_parts.push(text.as_str());
				}
			},
			Some(part::Kind::Blob(blob)) => chips.push(blob_label(blob)),
			Some(part::Kind::Thinking(thinking)) if !thinking.text.trim().is_empty() => {
				thinking_parts.push(thinking.text.clone());
			},
			_ => {},
		}
	}
	let text = text_parts.join("\n");
	match Role::try_from(message.role) {
		Ok(Role::User) => {
			send_backend(backend, BackendEvent::UserReplayed {
				text: Str::from(text),
				chips,
				queued: false,
			});
		},
		Ok(Role::System) => {},
		_ => {
			for thinking in thinking_parts {
				send_backend(backend, BackendEvent::ThinkingReplayed { text: thinking.into() });
			}
			if !text.is_empty() {
				*serial = serial.saturating_add(1);
				let id = Str::from(format!("history-assistant-{serial}"));
				send_backend(backend, BackendEvent::AssistantBegin {
					id:       id.clone(),
					thinking: false,
				});
				send_backend(backend, BackendEvent::AssistantDelta {
					id:   id.clone(),
					text: Str::from(text),
				});
				send_backend(backend, BackendEvent::AssistantEnd { id });
			}
		},
	}
}

/// Ends every still-open streamed text/thinking part.
///
/// Providers close prose blocks implicitly; ending them on the next part
/// start (or turn outcome) keeps their streamed content settled in the
/// transcript instead of abandoning it.
fn drain_open_assistant_parts(backend: &flume::Sender<BackendEvent>, state: &mut BridgeState) {
	for (_, id) in state.active_parts.drain() {
		send_backend(backend, BackendEvent::AssistantEnd { id });
	}
}

fn lower_attachments(
	item: &mut Item,
	attachments: Vec<Attachment>,
	mut report: impl FnMut(Str),
) -> Vec<Str> {
	let mut parts = Vec::with_capacity(attachments.len());
	let mut chips = Vec::with_capacity(attachments.len());
	for attachment in attachments {
		match attachment.content {
			AttachmentContent::Image { source, .. } => {
				let bytes = match fs::read(source.as_str()) {
					Ok(bytes) => bytes,
					Err(error) => {
						report(sf!("Could not attach image `{source}`: {error}"));
						continue;
					},
				};
				if bytes.len() > MAX_ATTACHMENT_BYTES {
					report(sf!(
						"Image `{source}` is larger than the 8 MiB attachment limit and was skipped."
					));
					continue;
				}
				let Some(mime) = image_mime(source.as_str()) else {
					report(sf!("Image `{source}` has an unsupported file type and was skipped."));
					continue;
				};
				let size = bytes.len() as u64;
				let hash = Bytes::copy_from_slice(Hash32::sum(&bytes).as_bytes());
				let blob = Blob {
					hash,
					mime: mime.to_owned(),
					size,
					inline: Bytes::from(bytes),
					detail: blob::Detail::Auto as i32,
				};
				chips.push(blob_label(&blob));
				parts.push(Part { kind: Some(part::Kind::Blob(blob)) });
			},
			AttachmentContent::Text { text, lines, .. } => {
				chips.push(sf!("paste · {lines} lines"));
				parts.push(Part {
					kind: Some(part::Kind::Text(format!("<attachment>{text}</attachment>"))),
				});
			},
		}
	}
	if let Some(item::Kind::Message(message)) = item.kind.as_mut() {
		message.parts.extend(parts);
	}
	chips
}

fn image_mime(path: &str) -> Option<&'static str> {
	let extension = Path::new(path).extension()?.to_str()?;
	if extension.eq_ignore_ascii_case("png") {
		Some("image/png")
	} else if extension.eq_ignore_ascii_case("jpg") || extension.eq_ignore_ascii_case("jpeg") {
		Some("image/jpeg")
	} else if extension.eq_ignore_ascii_case("gif") {
		Some("image/gif")
	} else if extension.eq_ignore_ascii_case("webp") {
		Some("image/webp")
	} else {
		None
	}
}

fn blob_label(blob: &Blob) -> Str {
	sf!("image {} · {} KB", blob.mime, blob.size.div_ceil(1024))
}

fn item_tool_identity(item: &Item, name: &str) -> Option<ToolIdentity> {
	let rev = item
		.props
		.as_ref()?
		.fields
		.get(TOOL_REV_PROP)?
		.kind
		.as_ref()
		.and_then(|kind| match kind {
			value::Kind::String(rev) => rev.parse::<Rev>().ok(),
			_ => None,
		})?;
	Some(ToolIdentity { name: Str::from(name), rev })
}

fn durable_tool_identity(item: &Item) -> Option<ToolIdentity> {
	let Some(item::Kind::ToolResult(result)) = &item.kind else {
		return None;
	};
	item_tool_identity(item, &result.name)
}

fn missing_identity(name: &str) -> ToolIdentity {
	ToolIdentity { name: Str::from(name), rev: Rev { family: Default::default(), n: 0 } }
}

fn missing_tool_identity(item: &Item) -> ToolIdentity {
	let name = match &item.kind {
		Some(item::Kind::ToolResult(result)) => result.name.as_str(),
		_ => "tool",
	};
	missing_identity(name)
}

fn completed_todo_payload(item: &Item) -> Option<todo::Payload> {
	match serde_json::from_slice::<omp_tool::CallOutcome<todo::Payload, todo::Fault>>(
		&durable_tool_outcome(item)?,
	)
	.ok()?
	{
		omp_tool::CallOutcome::Ok(payload) => Some(payload),
		omp_tool::CallOutcome::Faulted(_)
		| omp_tool::CallOutcome::ArgsRejected(_)
		| omp_tool::CallOutcome::Aborted { .. } => None,
	}
}

fn durable_tool_outcome(item: &Item) -> Option<Bytes> {
	let Some(item::Kind::ToolResult(result)) = &item.kind else {
		return None;
	};
	let details = value_to_json(result.details.as_ref()?)?;
	serde_json::to_vec(&details).ok().map(Bytes::from)
}

fn durable_tool_terminal(item: &Item) -> ToolTerminal {
	let Some(item::Kind::ToolResult(result)) = &item.kind else {
		return ToolTerminal::Failed;
	};
	let branch = result
		.details
		.as_ref()
		.and_then(|details| match details.kind.as_ref()? {
			value::Kind::Map(map) => map.fields.get("kind"),
			_ => None,
		})
		.and_then(|kind| match kind.kind.as_ref()? {
			value::Kind::String(kind) => Some(kind.as_str()),
			_ => None,
		});
	match branch {
		Some("ok") => ToolTerminal::Succeeded,
		Some("args_rejected" | "args") => ToolTerminal::ArgsRejected,
		Some("aborted") => {
			let skipped = result
				.details
				.as_ref()
				.and_then(|details| match details.kind.as_ref()? {
					value::Kind::Map(map) => map.fields.get("value"),
					_ => None,
				})
				.and_then(|value| match value.kind.as_ref()? {
					value::Kind::Map(map) => map.fields.get("kind"),
					_ => None,
				})
				.and_then(|kind| match kind.kind.as_ref()? {
					value::Kind::String(kind) => Some(kind.as_str()),
					_ => None,
				})
				.is_some_and(|kind| kind == "skipped");
			if skipped {
				ToolTerminal::Skipped
			} else {
				ToolTerminal::Aborted
			}
		},
		Some("faulted" | "fault") => ToolTerminal::Failed,
		_ if result.is_error => ToolTerminal::Failed,
		_ => ToolTerminal::Succeeded,
	}
}

fn structured_bytes_fallback(bytes: &Bytes) -> Str {
	str::from_utf8(bytes).map_or_else(|_| Str::new_static("{}"), Str::from)
}
fn extension_renderer_route(
	roster: &presentation::PublishedUiRoster,
	renderers: &RenderRegistry,
	identity: &ToolIdentity,
) -> Option<ExtensionRendererRoute> {
	let native_authoritative = renderers.has_native(identity);
	roster
		.has_tool_renderer(identity, native_authoritative)
		.then_some(ExtensionRendererRoute { native_authoritative })
}

fn tool_renderer_view(
	call_id: &Str,
	tool: &ToolDisplay,
	verdict: Value,
	phase: &'static str,
) -> Value {
	serde_json::json!({
		"call_id": call_id.as_str(),
		"updates": tool.updates.clone(),
		"state": null,
		"verdict": verdict,
		"elapsed": format!("{}ms", tool.opened.elapsed().as_millis()),
		"phase": phase,
		"presentation": {},
	})
}

fn tool_renderer_context(state: &BridgeState) -> Value {
	let (width, _) = presentation_dimensions();
	let charset = if state.presentation.charset == omp_tui::Charset::Ascii {
		"ascii"
	} else if state.presentation.charset == omp_tui::Charset::NerdFont {
		"nerd"
	} else {
		"unicode"
	};
	let appearance = if state.presentation.appearance == omp_tui::Appearance::Light {
		"light"
	} else {
		"dark"
	};
	let graphics = if state.presentation.graphics == omp_tui::Graphics::Sixel {
		"sixel"
	} else if state.presentation.graphics == omp_tui::Graphics::KittyPlaceholders {
		"kitty_placeholders"
	} else if state.presentation.graphics == omp_tui::Graphics::KittyDirect {
		"kitty_direct"
	} else if state.presentation.graphics == omp_tui::Graphics::Iterm2 {
		"iterm2"
	} else {
		"cells"
	};
	serde_json::json!({
		"width": width,
		"charset": charset,
		"appearance": appearance,
		"graphics": graphics,
		"hyperlinks": state.hyperlinks,
		"focused": false,
		"collapsed": !state.tools_expanded,
		"place": "transcript",
		"presentation": {},
	})
}

/// Folds the accumulated streaming argument parse and re-renders the live
/// view, returning markup only when an exact-revision renderer produced one.
fn fold_tool_args(
	renderers: &RenderRegistry,
	tool: &mut ToolDisplay,
	complete: bool,
) -> Option<ToolViewContent> {
	let entry = renderers.get(&tool.identity)?;
	entry.fold_args(&mut tool.fold, &tool.args, complete).ok()?;
	entry
		.view(&tool.fold, None)
		.ok()
		.flatten()
		.map(ToolViewContent::Markup)
}

fn fold_tool_update(
	renderers: &RenderRegistry,
	tool: &mut ToolDisplay,
	update: Bytes,
) -> ToolViewContent {
	let rendered = renderers
		.fold(&tool.identity, &mut tool.fold, update.clone())
		.ok()
		.filter(|()| renderers.contains(&tool.identity))
		.and_then(|()| renderers.view(&tool.identity, &tool.fold, None).ok());
	rendered.map_or_else(
		|| ToolViewContent::Plain(structured_bytes_fallback(&update)),
		ToolViewContent::Markup,
	)
}

fn render_tool_result_view(
	renderers: &RenderRegistry,
	item: &Item,
	tool: Option<&ToolDisplay>,
) -> (ToolIdentity, ToolTerminal, ToolViewContent) {
	let outcome = durable_tool_outcome(item);
	let Some(identity) = durable_tool_identity(item) else {
		let view = outcome
			.as_ref()
			.map_or_else(|| Str::new_static("{}"), structured_bytes_fallback);
		return (
			missing_tool_identity(item),
			durable_tool_terminal(item),
			ToolViewContent::Plain(view),
		);
	};
	let empty_fold = ViewState::new();
	if identity.name == "debug"
		&& identity.rev.to_string() == "1"
		&& let Some(outcome) = outcome.as_ref()
		&& let Ok(omp_tool::CallOutcome::<debug::Payload, debug::Fault>::Ok(payload)) =
			serde_json::from_slice(outcome)
	{
		return (
			identity,
			ToolTerminal::Succeeded,
			ToolViewContent::Markup(omp_tools::debug::render(payload.action, &payload.data)),
		);
	}
	let fold = tool
		.filter(|tool| tool.identity == identity)
		.map_or(&empty_fold, |tool| &tool.fold);
	let terminal = durable_tool_terminal(item);
	let mut view = renderers
		.contains(&identity)
		.then(|| renderers.view(&identity, fold, outcome.as_deref()).ok())
		.flatten()
		.map(ToolViewContent::Markup)
		.unwrap_or_else(|| {
			ToolViewContent::Plain(
				outcome
					.as_ref()
					.map_or_else(|| Str::new_static("{}"), structured_bytes_fallback),
			)
		});
	if terminal == ToolTerminal::Aborted
		&& let (ToolViewContent::Markup(markup), Some(outcome)) = (&view, outcome.as_ref())
	{
		let durable = structured_bytes_fallback(outcome);
		let mut combined = String::with_capacity(
			markup
				.len()
				.saturating_add(durable.len())
				.saturating_add(40),
		);
		combined.push_str("<col gap=0>");
		combined.push_str(markup);
		combined.push_str("<pre fg=muted>");
		push_tml_text(&mut combined, durable.as_str());
		combined.push_str("</pre></col>");
		view = ToolViewContent::Markup(Str::from(combined));
	}
	(identity, terminal, view)
}

fn tool_title(name: &Str, args: &omp_slopjson::Value) -> Str {
	if name == "edit"
		&& let Some(input) = args.get("input").and_then(|value| value.as_str())
		&& let Some(detail) = edit_input_title(input)
	{
		return sf!("{name} · {detail}");
	}
	let detail = ["title", "path", "command", "pattern", "query"]
		.into_iter()
		.find_map(|key| args.get(key).and_then(|value| value.as_str()))
		.and_then(|text| text.lines().next())
		.or_else(|| {
			args
				.get("input")
				.and_then(|value| value.as_str())
				.and_then(|input| input.lines().next())
				.and_then(|header| header.strip_prefix('['))
				.and_then(|header| header.split_once('#').map(|(path, _)| path))
		});
	detail.map_or_else(|| name.clone(), |detail| sf!("{name} · {detail}"))
}
fn edit_input_title(input: &str) -> Option<Str> {
	let mut paths = Vec::new();
	for line in input.lines() {
		let Some(opener) = line.trim_start().strip_prefix('§') else {
			continue;
		};
		let path = opener.strip_prefix('*').unwrap_or(opener).trim();
		if path.is_empty() || paths.contains(&path) {
			continue;
		}
		paths.push(path);
	}
	let first = paths.first()?;
	Some(if paths.len() == 1 {
		Str::new(*first)
	} else {
		sf!("{first} (+{} more)", paths.len() - 1)
	})
}

fn send_tool_result_images(backend: &flume::Sender<BackendEvent>, call_id: &Str, item: &Item) {
	let Some(item::Kind::ToolResult(result)) = &item.kind else {
		return;
	};
	for part in &result.parts {
		let Some(part::Kind::Blob(blob)) = &part.kind else {
			continue;
		};
		if let Some(source) = persist_tool_image(blob) {
			send_backend(backend, BackendEvent::ToolImage { id: call_id.clone(), source });
		}
	}
}

/// Persists an inline PNG tool-result payload to a content-addressed temp
/// file for inline terminal rendering, returning its path. Non-PNG payloads
/// and by-reference blobs are represented by the structured renderer view.
fn persist_tool_image(blob: &Blob) -> Option<Str> {
	if blob.mime != "image/png" {
		return None;
	}
	persist_inline_blob("omp-tool-image", "png", blob)
}

/// Writes an inline blob to a content-addressed temp file, returning its
/// path. Empty payloads (by-reference blobs) persist nothing.
fn persist_inline_blob(prefix: &str, extension: &str, blob: &Blob) -> Option<Str> {
	if blob.inline.is_empty() {
		return None;
	}
	let name = if blob.hash.is_empty() {
		format!("{prefix}-{}.{extension}", omp_core::Ulid::generate())
	} else {
		let hex = hex::encode(&blob.hash[..blob.hash.len().min(16)]).into_string();
		format!("{prefix}-{hex}.{extension}")
	};
	let path = env::temp_dir().join(name);
	if !path.exists() {
		fs::write(&path, &blob.inline).ok()?;
	}
	Some(Str::from(path.to_string_lossy().as_ref()))
}

/// Recovers composer-restorable attachments from a rewound user message's
/// non-prose parts: image blobs land in content-addressed temp files and
/// `<attachment>` pastes become text clips.
fn rewind_attachments(parts: &[Part]) -> Vec<RestoredAttachment> {
	let mut attachments = Vec::with_capacity(parts.len());
	for part in parts {
		match part.kind.as_ref() {
			Some(part::Kind::Blob(blob)) => {
				let extension = match blob.mime.as_str() {
					"image/png" => "png",
					"image/jpeg" => "jpg",
					"image/gif" => "gif",
					"image/webp" => "webp",
					_ => continue,
				};
				if let Some(source) = persist_inline_blob("omp-history-image", extension, blob) {
					attachments.push(RestoredAttachment::Image { source });
				}
			},
			Some(part::Kind::Text(text)) => {
				let body = text
					.strip_prefix("<attachment>")
					.and_then(|body| body.strip_suffix("</attachment>"))
					.unwrap_or(text);
				attachments.push(RestoredAttachment::Text(Str::from(body)));
			},
			_ => {},
		}
	}
	attachments
}

fn model_rows(
	catalog: &Catalog,
	settings: &ModelSettings,
	auth: Option<&omp_inference::auth::AuthControlHandle>,
) -> Vec<ModelRow> {
	let roles = settings
		.roles
		.keys()
		.filter(|role| !settings.role_tag(role).is_some_and(|tag| tag.hidden))
		.filter_map(|role| {
			resolve_model_selector(catalog, settings, role.as_str()).map(|model| (role, model))
		})
		.collect::<Vec<_>>();
	let credentialed = auth.map(|auth| credentialed_providers(catalog, auth));
	let rows = |credentialed: Option<&FastHashSet<ProviderId>>| {
		catalog
			.models()
			.iter()
			.filter(|model| model_selector_allowed(catalog, settings, model.key.as_str()))
			.filter(|model| {
				credentialed.is_none_or(|credentialed| {
					model.routes.iter().any(|route| {
						catalog
							.route(route)
							.is_some_and(|route| credentialed.contains(&route.provider))
					})
				})
			})
			.map(|model| {
				let role = roles
					.iter()
					.filter(|(_, resolved)| resolved.key.as_str() == model.key.as_str())
					.min_by_key(|(role, _)| settings.cycle_rank(role))
					.map(|(role, _)| *role);
				let tag = role.and_then(|role| settings.role_tag(role));
				let (provider_id, provider) = model
					.routes
					.first()
					.and_then(|route| catalog.route(route))
					.map(|route| {
						let name = catalog.provider(&route.provider).map_or_else(
							|| route.provider.to_string(),
							|provider| provider.name.to_string(),
						);
						(Str::from(route.provider.as_str()), Str::from(name))
					})
					.unwrap_or_default();
				let price = |unit| {
					model
						.pricing
						.components
						.iter()
						.find(|price| price.unit == unit)
						.map(|price| price.nanos_usd as f64 / 1_000_000_000.0)
				};
				ModelRow {
					key: Str::from(model.key.to_string()),
					name: tag.map_or_else(|| model.display_name.clone(), |tag| tag.name.clone()),
					color: tag.and_then(|tag| tag.color.clone()),
					provider_id,
					provider,
					context: model.limits.context_window,
					input_mtok: price(PriceUnit::MtokInput),
					output_mtok: price(PriceUnit::MtokOutput),
					efforts: model
						.thinking
						.as_ref()
						.and_then(|policy| catalog.thinking_policy(policy))
						.map_or_else(
							|| Arc::from([]),
							|policy| {
								policy
									.efforts
									.iter()
									.map(|effort| Str::new_static(<&'static str>::from(*effort)))
									.collect::<Vec<_>>()
									.into()
							},
						),
				}
			})
			.collect::<Vec<_>>()
	};
	match rows(credentialed.as_ref()) {
		// Every model filtered out means nothing is authenticated yet; an empty
		// picker would hide the login paths, so fail open to the full catalog.
		filtered if filtered.is_empty() => rows(None),
		filtered => filtered,
	}
}

fn current_model_index(rows: &[ModelRow], current: &str) -> usize {
	rows
		.iter()
		.position(|model| model.key.as_str() == current)
		.unwrap_or_default()
}
/// Providers whose declared credential sources are currently satisfiable
/// without a new login: auth-free specs, populated credential environment
/// variables, or an enabled stored account.
fn credentialed_providers(
	catalog: &Catalog,
	auth: &omp_inference::auth::AuthControlHandle,
) -> FastHashSet<ProviderId> {
	let accounts = auth.accounts(None);
	catalog
		.providers()
		.iter()
		.filter(|provider| provider_credentials_present(catalog, provider, &accounts))
		.map(|provider| provider.id.clone())
		.collect()
}

fn provider_credentials_present(
	catalog: &Catalog,
	provider: &ProviderDef,
	accounts: &[omp_inference::account::AccountRecord],
) -> bool {
	let has_account = accounts
		.iter()
		.any(|account| account.enabled && account.provider == provider.id);
	provider
		.auth
		.iter()
		.filter_map(|auth_id| catalog.auth_spec(auth_id))
		.any(|spec| {
			if matches!(spec.kind, AuthSpecKind::None | AuthSpecKind::OptionalBearer) {
				return true;
			}
			// A spec declaring no checkable source stays visible.
			spec.credential_sources.is_empty()
				|| spec.credential_sources.iter().any(|source| match source {
					CredentialSourceSpec::Stored
					| CredentialSourceSpec::Oauth { .. }
					| CredentialSourceSpec::Session => has_account,
					CredentialSourceSpec::Environment { ordered_names } => {
						env_credential_present(ordered_names)
					},
					CredentialSourceSpec::BasicEnvironment { username_names, password_names } => {
						env_credential_present(username_names) && env_credential_present(password_names)
					},
					// File-, metadata-, and ambient-chain credentials cannot be
					// verified without I/O; keep the provider visible.
					CredentialSourceSpec::ApplicationDefault { .. } | CredentialSourceSpec::AwsChain => {
						true
					},
				})
		})
}

fn env_credential_present(names: &[Str]) -> bool {
	names
		.iter()
		.any(|name| env::var_os(name.as_str()).is_some_and(|value| !value.is_empty()))
}
fn cycle_model_rows(
	catalog: &Catalog,
	settings: &ModelSettings,
	auth: Option<&omp_inference::auth::AuthControlHandle>,
) -> Vec<ModelRow> {
	let all = model_rows(catalog, settings, auth);
	let mut ordered = Vec::new();
	for role in settings.cycle_order.iter() {
		if settings.role_tag(role).is_some_and(|tag| tag.hidden) {
			continue;
		}
		if settings.role_selector(role).is_none() {
			continue;
		}
		let Some(model) = resolve_model_selector(catalog, settings, role.as_str()) else {
			continue;
		};
		if ordered
			.iter()
			.any(|row: &ModelRow| row.key.as_str() == model.key.as_str())
		{
			continue;
		}
		if let Some(row) = all
			.iter()
			.find(|row| row.key.as_str() == model.key.as_str())
		{
			ordered.push(row.clone());
		}
	}
	if ordered.is_empty() { all } else { ordered }
}

fn send_open_models(backend: &flume::Sender<BackendEvent>, state: &BridgeState) {
	let rows =
		model_rows(state.catalog.as_ref(), &state.model_settings, state.auth_control.as_ref());
	let current = current_model_index(&rows, &state.model);
	send_backend(backend, BackendEvent::OpenModelPicker { rows, current });
}

fn send_models_updated(backend: &flume::Sender<BackendEvent>, state: &BridgeState) {
	let rows =
		model_rows(state.catalog.as_ref(), &state.model_settings, state.auth_control.as_ref());
	let current = current_model_index(&rows, &state.model);
	send_backend(backend, BackendEvent::ModelsUpdated { rows, current });
}
fn send_open_model_hub(
	backend: &flume::Sender<BackendEvent>,
	settings_manager: &SettingsManager,
	state: &BridgeState,
) {
	send_backend(backend, BackendEvent::OpenModelHub(model_hub_data(settings_manager, state)));
}

/// Projects catalog, role, fallback, and credential state for the models hub.
fn model_hub_data(settings_manager: &SettingsManager, state: &BridgeState) -> ModelHubData {
	let catalog = state.catalog.as_ref();
	let settings = &state.model_settings;
	let rows = model_rows(catalog, settings, state.auth_control.as_ref());
	let current = current_model_index(&rows, &state.model);
	ModelHubData {
		current,
		roles: hub_roles(catalog, settings),
		cycle_order: settings.cycle_order.iter().cloned().collect(),
		chains: retry_chains(settings_manager).into_iter().collect(),
		project_storage: settings.role_storage == ModelRoleStorage::Project,
		locked: locked_provider_rows(catalog, settings, state.auth_control.as_ref(), &rows),
		rows,
	}
}

/// Presentation color defaults for built-in roles without configured tags.
fn builtin_role_color(role: &str) -> Option<&'static str> {
	Some(match role {
		"default" => "ok",
		"smol" => "warning",
		"slow" | "advisor" => "accent",
		"vision" => "error",
		"plan" | "designer" | "task" | "commit" | "tiny" | "memory" => "muted",
		_ => return None,
	})
}

/// Resolves every visible role for the hub: built-ins first, then configured
/// custom roles in name order.
fn hub_roles(catalog: &Catalog, settings: &ModelSettings) -> Vec<HubRole> {
	let mut ids: Vec<Str> = omp_catalog::BUILTIN_ROLE_IDS
		.iter()
		.map(|id| Str::new_static(id))
		.collect();
	let known = |ids: &[Str], id: &Str| ids.iter().any(|candidate| candidate == id);
	let mut customs: Vec<Str> = settings
		.cycle_order
		.iter()
		.chain(settings.roles.keys())
		.chain(settings.tags.keys())
		.filter(|id| !known(&ids, id))
		.cloned()
		.collect();
	customs.sort();
	customs.dedup();
	ids.extend(customs);
	ids.retain(|id| !settings.role_tag(id).is_some_and(|tag| tag.hidden));
	ids.into_iter()
		.map(|id| {
			let tag = settings.role_tag(&id);
			let resolved = resolve_role_selector(catalog, settings, &format!("@{id}")).ok();
			HubRole {
				name: tag
					.map(|tag| tag.name.clone())
					.filter(|name| !name.is_empty())
					.unwrap_or_else(|| id.clone()),
				color: tag
					.and_then(|tag| tag.color.clone())
					.or_else(|| builtin_role_color(&id).map(Str::new_static)),
				selector: settings.role_selector(&id).cloned(),
				resolved: resolved
					.as_ref()
					.map(|selected| Str::from(selected.model.as_str())),
				thinking: resolved.and_then(|selected| selected.thinking),
				id,
			}
		})
		.collect()
}

/// Providers with admitted catalog models but no usable credentials.
fn locked_provider_rows(
	catalog: &Catalog,
	settings: &ModelSettings,
	auth: Option<&omp_inference::auth::AuthControlHandle>,
	selectable: &[ModelRow],
) -> Vec<LockedProviderRow> {
	let Some(auth) = auth else {
		return Vec::new();
	};
	let credentialed = credentialed_providers(catalog, auth);
	let selectable: FastHashSet<&str> = selectable
		.iter()
		.map(|row| row.provider_id.as_str())
		.collect();
	let mut rows: Vec<LockedProviderRow> = catalog
		.providers()
		.iter()
		.filter(|provider| {
			!credentialed.contains(&provider.id) && !selectable.contains(provider.id.as_str())
		})
		.filter_map(|provider| {
			let models = catalog
				.models()
				.iter()
				.filter(|model| {
					model.routes.iter().any(|route| {
						catalog
							.route(route)
							.is_some_and(|route| route.provider == provider.id)
					}) && model_selector_allowed(catalog, settings, model.key.as_str())
				})
				.count();
			(models > 0).then(|| LockedProviderRow {
				id: Str::from(provider.id.as_str()),
				name: provider.name.clone(),
				models,
				oauth: provider_uses_oauth(catalog, provider),
				env_vars: provider
					.auth
					.iter()
					.filter_map(|auth_id| catalog.auth_spec(auth_id))
					.flat_map(|spec| &spec.credential_sources)
					.filter_map(|source| match source {
						CredentialSourceSpec::Environment { ordered_names } => Some(ordered_names),
						_ => None,
					})
					.flatten()
					.cloned()
					.collect(),
			})
		})
		.collect();
	rows.sort_by(|left, right| left.id.cmp(&right.id));
	rows
}

/// The persisted retry fallback chains, empty when unreadable.
fn retry_chains(settings_manager: &SettingsManager) -> omp_catalog::settings::FallbackChains {
	settings_manager
		.snapshot()
		.project::<omp_inference::settings::RetrySettings>()
		.map(|projection| projection.get().fallback_chains.clone())
		.unwrap_or_default()
}

fn hub_mutation_scope(scope: Option<HubScope>, storage: ModelRoleStorage) -> MutationScope {
	match scope {
		Some(HubScope::Global) => MutationScope::Global,
		Some(HubScope::Project) => MutationScope::Project,
		None => model_role_scope(storage),
	}
}

/// Persists one models-hub mutation through the settings authority.
fn apply_model_hub_intent(
	settings_manager: &SettingsManager,
	storage: ModelRoleStorage,
	intent: ModelHubIntent,
) -> miette::Result<()> {
	match intent {
		ModelHubIntent::AssignRole { role, selector, thinking, scope } => {
			let selector =
				role_assignment_selector(selector.as_str(), thinking.as_deref()).into_diagnostic()?;
			let raw = toml::Value::String(selector.to_string()).to_string();
			settings_manager
				.set_sync(hub_mutation_scope(scope, storage), &format!("model.roles.{role}"), &raw)
				.into_diagnostic()?;
		},
		ModelHubIntent::UnassignRole { role, scope } => {
			settings_manager
				.unset_sync(hub_mutation_scope(scope, storage), &format!("model.roles.{role}"))
				.into_diagnostic()?;
		},
		ModelHubIntent::SetFallbackChain { key, chain } => {
			let mut chains = retry_chains(settings_manager);
			if chain.is_empty() {
				chains.remove(&key);
			} else {
				chains.insert(key, chain);
			}
			if chains.is_empty() {
				settings_manager
					.unset_sync(MutationScope::Global, "retry.fallback_chains")
					.into_diagnostic()?;
			} else {
				let table = chains
					.into_iter()
					.map(|(key, chain)| {
						(
							key.to_string(),
							toml::Value::Array(
								chain
									.into_iter()
									.map(|selector| toml::Value::String(selector.to_string()))
									.collect(),
							),
						)
					})
					.collect::<toml::Table>();
				settings_manager
					.set_sync(
						MutationScope::Global,
						"retry.fallback_chains",
						&toml::Value::Table(table).to_string(),
					)
					.into_diagnostic()?;
			}
		},
		ModelHubIntent::SetCycleOrder { order } => {
			let array = toml::Value::Array(
				order
					.into_iter()
					.map(|role| toml::Value::String(role.to_string()))
					.collect(),
			);
			settings_manager
				.set_sync(MutationScope::Global, "model.cycle_order", &array.to_string())
				.into_diagnostic()?;
		},
	}
	Ok(())
}

/// Re-projects [`ModelSettings`] from the live snapshot after a hub mutation.
fn refresh_model_settings(settings_manager: &SettingsManager, state: &mut BridgeState) {
	let workspace = PathBuf::from(state.workspace_root.as_str());
	let home = env::var_os("HOME").map_or_else(|| workspace.clone(), PathBuf::from);
	if let Ok(projection) = settings_manager.snapshot().project::<ModelSettings>() {
		state.model_settings = projection.get().resolve_path_scopes(&workspace, &home);
	}
}

fn provider_rows(catalog: &Catalog, current: Option<&str>) -> Vec<SessionRow> {
	let mut providers = catalog
		.providers()
		.iter()
		.filter(|provider| provider_supports_login(catalog, provider))
		.map(|provider| {
			let oauth = provider_uses_oauth(catalog, provider);
			(provider, oauth, current == Some(provider.id.as_str()))
		})
		.collect::<Vec<_>>();
	providers.sort_by_key(|(_, oauth, current)| (!*current, !*oauth));
	providers
		.into_iter()
		.map(|(provider, oauth, _)| SessionRow {
			id:     Str::from(provider.id.as_str()),
			label:  provider.name.clone(),
			detail: sf!(if oauth { "OAuth" } else { "API key" }),
			pinned: false,
		})
		.collect()
}

fn provider_supports_login(catalog: &Catalog, provider: &ProviderDef) -> bool {
	provider
		.auth
		.iter()
		.filter_map(|auth_id| catalog.auth_spec(auth_id))
		.any(|auth| auth.kind != AuthSpecKind::None)
}

fn provider_uses_oauth(catalog: &Catalog, provider: &ProviderDef) -> bool {
	provider.auth.iter().any(|auth_id| {
		catalog
			.auth_spec(auth_id)
			.and_then(|auth| auth.oauth.as_ref())
			.is_some_and(|oauth_id| catalog.oauth_spec(oauth_id).is_some())
	})
}

fn session_rows(choices: Vec<ResumeChoice>) -> Vec<SessionRow> {
	choices
		.into_iter()
		.map(|choice| SessionRow {
			id:     choice.id,
			label:  choice.label,
			detail: choice.detail,
			pinned: choice.pinned,
		})
		.collect()
}

async fn switch_model<C>(
	backend: &flume::Sender<BackendEvent>,
	state_handle: &AgentState,
	settings_manager: &SettingsManager,
	selector: &str,
	state: &mut BridgeState,
	control: &omp_agent::ControlSender,
	parent: &Arc<ChatParentHost<C>>,
	durable: bool,
) where
	C: TurnClient + Clone + Send + 'static,
{
	switch_model_with_thinking(
		backend,
		state_handle,
		settings_manager,
		selector,
		state,
		control,
		parent,
		None,
		durable,
	)
	.await;
}

async fn switch_model_with_thinking<C>(
	backend: &flume::Sender<BackendEvent>,
	state_handle: &AgentState,
	settings_manager: &SettingsManager,
	selector: &str,
	state: &mut BridgeState,
	control: &omp_agent::ControlSender,
	parent: &Arc<ChatParentHost<C>>,
	thinking: Option<omp_catalog::ThinkingEffort>,
	durable: bool,
) where
	C: TurnClient + Clone + Send + 'static,
{
	let catalog = state.catalog.as_ref();
	if !durable {
		let thinking = thinking.map(<&'static str>::from);
		let mutation = match omp_driver::chat::set_active_session_model(
			catalog,
			&state.model_settings,
			state_handle,
			control,
			selector,
			thinking,
		)
		.await
		{
			Ok(mutation) => mutation,
			Err(error) => {
				send_backend(backend, BackendEvent::Error(Str::from(error.to_string())));
				return;
			},
		};
		parent.notify_model_changed(
			mutation.previous_model.as_ref(),
			&mutation.model,
			mutation.previous_thinking,
			mutation.thinking,
			"temporary",
			"user",
		);
		state.model = mutation.key.to_string();
		state.context_window = mutation.context_window;
		send_models_updated(backend, state);
		send_backend(backend, BackendEvent::Notice(sf!("Session model: `{}`.", state.model)));
		return;
	}
	let Some(spec) = resolve_model_selector(catalog, &state.model_settings, selector) else {
		send_backend(backend, BackendEvent::Error(sf!("Unknown or disabled model: {selector}")));
		return;
	};
	if !model_selector_allowed(catalog, &state.model_settings, spec.key.as_str()) {
		send_backend(
			backend,
			BackendEvent::Error(sf!("Model is disabled by the effective model scope: {selector}")),
		);
		return;
	}
	let previous_model = resolve_model_selector(catalog, &state.model_settings, &state.model)
		.and_then(|spec| journal_model_ref(catalog, spec));
	let Some(model) = journal_model_ref(catalog, spec) else {
		send_backend(
			backend,
			BackendEvent::Error(sf!("Model has no selectable provider route: {selector}")),
		);
		return;
	};
	let key = spec.key.to_string();
	let current_thinking = state_handle
		.snapshot()
		.turn
		.params
		.thinking
		.as_ref()
		.and_then(|reasoning| Effort::try_from(reasoning.effort).ok());
	let previous_enabled_models = Arc::clone(&state.model_settings.enabled_models);
	let persisted_scope_changed = state
		.model_settings
		.insert_persisted_default(spec.key.as_str());
	{
		let raw = toml::Value::String(key.clone()).to_string();
		let scope = model_role_scope(state.model_settings.role_storage);
		if persisted_scope_changed {
			let enabled = match toml::Value::try_from(
				state
					.model_settings
					.enabled_models
					.iter()
					.cloned()
					.collect::<Vec<_>>(),
			) {
				Ok(enabled) => enabled.to_string(),
				Err(error) => {
					state.model_settings.enabled_models = previous_enabled_models;
					send_backend(
						backend,
						BackendEvent::Error(sf!("Could not encode the enabled model scope: {error}")),
					);
					return;
				},
			};
			if let Err(error) = settings_manager.set_sync(scope, "model.enabled_models", &enabled) {
				state.model_settings.enabled_models = previous_enabled_models;
				send_backend(
					backend,
					BackendEvent::Error(sf!("Could not save the enabled model scope: {error}")),
				);
				return;
			}
		}
		if let Err(error) = settings_manager.set_sync(scope, "model.roles.default", &raw) {
			send_backend(
				backend,
				BackendEvent::Error(sf!("Could not save the default model role: {error}")),
			);
			return;
		}
		state
			.model_settings
			.roles
			.insert(Str::new_static("default"), Str::from(key.as_str()));
	}
	state_handle.update(|snapshot| {
		snapshot.turn.params.model.clone_from(&key);
		snapshot.reasoning_dialect =
			omp_driver::chat::interrupted_reasoning_dialect(catalog, &snapshot.turn.params.model);
	});
	parent.notify_model_changed(
		previous_model.as_ref(),
		&model,
		current_thinking,
		current_thinking,
		"default",
		"user",
	);
	state.model = key;
	state.context_window = spec.limits.context_window;
	send_models_updated(backend, state);
	send_backend(
		backend,
		BackendEvent::Notice(sf!("Default and session model: `{}`.", state.model)),
	);
}
fn journal_model_ref(catalog: &Catalog, spec: &ModelSpec) -> Option<transcript::ModelRef> {
	let route = spec.routes.first().and_then(|route| catalog.route(route))?;
	Some(transcript::ModelRef {
		provider: transcript::ProviderId(Str::new(route.provider.as_str())),
		api:      Str::new(route.codec.as_str()),
		model:    transcript::ModelId(Str::new(spec.key.as_str())),
	})
}

fn resolve_model_selector<'a>(
	catalog: &'a Catalog,
	settings: &ModelSettings,
	selector: &str,
) -> Option<&'a ModelSpec> {
	let role_selector = settings
		.role_selector(selector)
		.map(|_| format!("@{selector}"));
	let selected =
		resolve_role_selector(catalog, settings, role_selector.as_deref().unwrap_or(selector))
			.ok()?;
	catalog.model(&selected.model)
}

fn model_role_scope(storage: ModelRoleStorage) -> MutationScope {
	match storage {
		ModelRoleStorage::Global => MutationScope::Global,
		ModelRoleStorage::Project => MutationScope::Project,
	}
}

fn resolve_model<'a>(catalog: &'a Catalog, selector: &str) -> Option<&'a ModelSpec> {
	catalog
		.model(ModelKey::from_ref(selector))
		.or_else(|| catalog.resolve_alias(selector))
}

fn model_provider(catalog: &Catalog, selector: &str) -> Option<Str> {
	let model = resolve_model(catalog, selector)?;
	let route = catalog.route(model.routes.first()?)?;
	Some(Str::from(route.provider.as_str()))
}
/// Resolves a human-readable authentication summary for one provider:
/// stored accounts first, then populated credential environment variables,
/// then ambient credential chains.
fn provider_auth_summary(
	catalog: &Catalog,
	provider: &ProviderDef,
	auth: Option<&omp_inference::auth::AuthControlHandle>,
) -> Str {
	let accounts = auth.map_or_else(Vec::new, |control| control.accounts(Some(&provider.id)));
	if !accounts.is_empty() {
		let enabled = accounts.iter().filter(|account| account.enabled).count();
		let mode = if provider_uses_oauth(catalog, provider) {
			"oauth"
		} else {
			"api key"
		};
		return if enabled == accounts.len() {
			sf!("{mode} ({} account{})", accounts.len(), if accounts.len() == 1 { "" } else { "s" })
		} else {
			sf!("{mode} ({enabled} of {} accounts enabled)", accounts.len())
		};
	}
	for spec in provider.auth.iter().filter_map(|id| catalog.auth_spec(id)) {
		for source in &spec.credential_sources {
			match source {
				CredentialSourceSpec::Environment { ordered_names } => {
					if let Some(name) = ordered_names
						.iter()
						.find(|name| env::var_os(name.as_str()).is_some_and(|value| !value.is_empty()))
					{
						return sf!("env `{name}`");
					}
				},
				CredentialSourceSpec::ApplicationDefault { .. } | CredentialSourceSpec::AwsChain => {
					return Str::new_static("ambient credential chain");
				},
				_ => {},
			}
		}
		if spec.kind == AuthSpecKind::None {
			return Str::new_static("none required");
		}
	}
	Str::new_static("not authenticated")
}

/// Collects `/session info` facts from bridge state, the catalog, and the
/// durable session index.
fn session_info_facts(state: &BridgeState, index: &SessionIndex) -> commands::session::SessionInfo {
	let catalog = state.catalog.as_ref();
	let provider = resolve_model(catalog, &state.model).and_then(|spec| {
		let route = catalog.route(spec.routes.first()?)?;
		let provider = catalog.provider(&route.provider)?;
		Some(commands::session::ProviderInfo {
			name:         provider.name.clone(),
			model:        Str::new(spec.key.as_str()),
			display_name: spec.display_name.clone(),
			api:          Str::new(route.codec.as_str()),
			endpoint:     route.endpoint.base_url.clone(),
			auth:         provider_auth_summary(catalog, provider, state.auth_control.as_ref()),
		})
	});
	let stats = index
		.session_statistics(&SessionId(state.session_id.clone()), true)
		.ok();
	let mut mcp = state
		.extension_live_mcp
		.values()
		.map(|snapshot| commands::session::McpServerInfo {
			name:   snapshot.server.clone(),
			health: <&'static str>::from(snapshot.health),
			tools:  snapshot.tools.len(),
		})
		.collect::<Vec<_>>();
	mcp.sort_by(|left, right| left.name.cmp(&right.name));
	let mut lsp = state
		.lsp_servers
		.iter()
		.map(|server| commands::session::LspServerInfo {
			name:       Str::new(&server.name),
			stage:      Str::new_static(lsp_stage_label(server.stage)),
			file_types: server.file_types.iter().map(Str::new).collect(),
			detail:     (!server.detail.is_empty()).then(|| Str::new(&server.detail)),
		})
		.collect::<Vec<_>>();
	lsp.sort_by(|left, right| left.name.cmp(&right.name));
	commands::session::SessionInfo {
		file: state
			.session_path
			.is_file()
			.then(|| Str::new(state.session_path.to_string_lossy().as_ref())),
		id: state.session_id.clone(),
		title: state.title.title.clone(),
		model: Str::new(state.model.as_str()),
		provider,
		stats,
		context_tokens: state.context_tokens,
		context_window: state.context_window,
		queued: state.queued,
		mcp,
		lsp,
	}
}

fn model_uses_subscription(catalog: &Catalog, selector: &str) -> bool {
	resolve_model(catalog, selector)
		.and_then(|model| model.routes.first())
		.and_then(|route| catalog.route(route))
		.and_then(|route| catalog.provider(&route.provider))
		.is_some_and(|provider| provider_uses_oauth(catalog, provider))
}

fn resolve_login_provider(catalog: &Catalog, requested: &Str) -> Result<Str, Str> {
	let Some(provider) = catalog.provider(ProviderId::from_ref(requested.as_str())) else {
		return Err(sf!(
			"Unknown provider `{requested}`. Use `/login` to choose an available provider."
		));
	};
	if !provider_supports_login(catalog, provider) {
		return Err(sf!(
			"Provider `{}` does not support interactive authentication. Use `/login` to choose \
			 another provider.",
			provider.id
		));
	}
	Ok(Str::from(provider.id.as_str()))
}

/// Projects the live roster for the HUD. The roster exists to surface
/// subagent activity: a session whose only node is the root agent projects
/// empty, so the HUD stays out of the way until subagents actually run.
fn publish_collaboration_state(state: &BridgeState, bus: &omp_agent::EventBus) {
	let (Some(live), Some(base)) = (&state.collab_live, &state.collab_state) else {
		return;
	};
	let mut update = base.clone();
	update.is_streaming = chat_active(state.submit_pending, bus.phase());
	update.is_aborting = bus.run_state() == AgentRunState::Attention;
	update.queued_message_count = u32::try_from(state.queued).unwrap_or(u32::MAX);
	update.session_name = state.title.title.as_deref().unwrap_or_default().to_owned();
	update.host_cwd = state.workspace_root.to_string();
	let provider = model_provider(state.catalog.as_ref(), &state.model).unwrap_or_default();
	update.model = Some(omp_proto::collab::v1::ModelMetadata {
		id:             state.model.clone(),
		name:           status_model_label(state.catalog.as_ref(), &state.model).to_string(),
		provider:       provider.to_string(),
		context_window: state
			.context_window
			.and_then(|window| u32::try_from(window).ok())
			.unwrap_or_default(),
	});
	update.thinking_level = state.thinking.map(|thinking| {
		match thinking {
			StatusThinkingLevel::Minimal => "minimal",
			StatusThinkingLevel::Low => "low",
			StatusThinkingLevel::Medium => "medium",
			StatusThinkingLevel::High => "high",
			StatusThinkingLevel::Xhigh => "xhigh",
			StatusThinkingLevel::Max => "max",
		}
		.to_owned()
	});
	update.context_usage = state
		.context_window
		.map(|window| omp_proto::collab::v1::ContextUsage {
			tokens:         state.context_tokens,
			context_window: window,
			percent:        if window == 0 {
				0.0
			} else {
				(state.context_tokens as f64 / window as f64 * 100.0) as f32
			},
		});
	live.publish_state(update);
}

fn publish_collaboration_registry<C>(
	live: Option<&omp_driver::collab::session::HostLiveHandle>,
	parent: &ChatParentHost<C>,
	session: &str,
) where
	C: TurnClient + Clone + Send + 'static,
{
	let Some(live) = live else {
		return;
	};
	let mut agents = HashMap::new();
	for fact in parent.agent_hub_facts(session) {
		let transcript_path = parent
			.broker()
			.registry()
			.record(fact.id.as_str())
			.and_then(|(record, _)| record.transcript);
		let summary = omp_proto::collab::v1::AgentSummary {
			id:               fact.id.to_string(),
			display_name:     fact.name.to_string(),
			kind:             if fact.parent.is_none() {
				omp_proto::collab::v1::agent_summary::Kind::Main as i32
			} else {
				omp_proto::collab::v1::agent_summary::Kind::Sub as i32
			},
			parent_id:        fact.parent.as_ref().map(ToString::to_string),
			status:           match fact.status {
				AgentStatus::Pending | AgentStatus::Running => {
					omp_proto::collab::v1::agent_summary::Status::Running as i32
				},
				AgentStatus::Settled | AgentStatus::Completed => {
					omp_proto::collab::v1::agent_summary::Status::Idle as i32
				},
				AgentStatus::Failed | AgentStatus::Cancelled | AgentStatus::Exhausted => {
					omp_proto::collab::v1::agent_summary::Status::Aborted as i32
				},
			},
			has_session_file: transcript_path.is_some(),
			created_at_ms:    0,
			last_activity_ms: 0,
		};
		agents.insert(fact.id, omp_driver::collab::session::HostAgentProjection {
			summary,
			transcript_path,
		});
	}
	let snapshot = omp_proto::collab::v1::RegistrySnapshot {
		agents: agents.values().map(|agent| agent.summary.clone()).collect(),
	};
	live.publish_registry(omp_driver::collab::session::HostRegistryUpdate { snapshot, agents });
}

fn project_agent_roster<C>(
	parent: &ChatParentHost<C>,
	tree: &AgentTree,
	session: &str,
) -> Vec<AgentRow>
where
	C: TurnClient + Clone + Send + 'static,
{
	let rows: Vec<AgentRow> = parent
		.agent_hub_facts(session)
		.into_iter()
		.map(|facts| {
			let node = tree.node(facts.id.as_str());
			let usage = node.as_ref().map(|node| node.usage());
			let activity = node
				.as_ref()
				.map(|node| node.activity())
				.unwrap_or_default();
			let transcript = facts
				.transcript_preview
				.or(facts.assignment.clone())
				.unwrap_or_default();
			let progress = facts.progress.clone().unwrap_or_default();
			let terminal = facts.terminal.clone();
			AgentRow {
				id: facts.id,
				name: facts.name,
				parent: facts.parent,
				depth: facts.depth,
				status: Str::from(facts.status.to_string()),
				tool: (!activity.is_empty()).then_some(activity),
				tokens: usage.map(|usage| usage.input_tokens.saturating_add(usage.output_tokens)),
				definition: facts.definition,
				model: facts.model,
				serving_model: facts.serving_model,
				transcript,
				assignment: facts.assignment,
				requests: progress.requests,
				tool_calls: progress.tool_calls,
				context_tokens: progress.context_tokens,
				cost_micros: progress.cost_micros,
				terminal_kind: terminal
					.as_ref()
					.map(|terminal| Str::from(terminal.kind.to_string())),
				terminal_summary: terminal.as_ref().map(|terminal| terminal.summary.clone()),
				artifact_uri: terminal
					.as_ref()
					.and_then(|terminal| terminal.disposition.artifact_uri.clone()),
				frozen: false,
				can_steer: facts.capabilities.steer,
				can_revive: facts.capabilities.revive,
				can_kill: facts.capabilities.kill,
			}
		})
		.collect();
	if rows.iter().all(|row| row.parent.is_none()) && rows.len() <= 1 {
		return Vec::new();
	}
	rows
}

fn publish_agent_roster<C>(
	backend: &flume::Sender<BackendEvent>,
	parent: &ChatParentHost<C>,
	tree: &AgentTree,
	session: &str,
	last: &mut Vec<AgentRow>,
) where
	C: TurnClient + Clone + Send + 'static,
{
	let current = project_agent_roster(parent, tree, session);
	if current != *last {
		*last = current.clone();
		send_backend(backend, BackendEvent::AgentRoster(current));
	}
}

fn send_status(
	backend: &flume::Sender<BackendEvent>,
	state: &BridgeState,
	bus: &omp_agent::EventBus,
	dropped: u64,
) {
	let advisor_status = state
		.advisor
		.as_ref()
		.map(|advisor| advisor.lock().status())
		.filter(|status| status.enabled);
	let advisor_model = advisor_status
		.as_ref()
		.filter(|status| status.enabled)
		.and_then(|status| {
			status
				.advisors
				.iter()
				.find(|advisor| advisor.state == AdvisorRunState::Running)
				.map(|advisor| advisor.model.clone())
		});
	let advisor_cost_micro_usd = advisor_status
		.as_ref()
		.into_iter()
		.flat_map(|status| &status.advisors)
		.fold(0_i128, |total, advisor| total.saturating_add(advisor.usage.cost_micro_usd))
		.max(0);
	let advisor_cost_nanos =
		u64::try_from(advisor_cost_micro_usd.saturating_mul(1_000)).unwrap_or(u64::MAX);
	send_backend(
		backend,
		BackendEvent::Status(StatusFacts {
			model: status_model_label(state.catalog.as_ref(), state.model.as_str()),
			session_id: Some(state.session_id.clone()),
			model_subscription: model_uses_subscription(state.catalog.as_ref(), &state.model),
			advisor_subscription: advisor_model
				.as_ref()
				.is_some_and(|model| model_uses_subscription(state.catalog.as_ref(), model.as_str())),
			advisor_model,
			working: chat_active(state.submit_pending, bus.phase()),
			turn_started: state.turn_started,
			context_tokens: state.context_tokens,
			context_window: state.context_window,
			compaction_speculation: omp_chat_ui::CompactionSpeculationStatus::Idle,
			compaction_boundaries: compaction_boundaries(
				&state.settings.compaction,
				state.context_window,
			),
			cost_nanos: state.cost_nanos,
			advisor_cost_nanos,
			queued: state.queued,
			visible_resources: state
				.regimes
				.visible_resources()
				.iter()
				.map(|facts| VisibleResourceFacts {
					resource:    facts.resource.clone(),
					owner:       facts.owner.clone(),
					queue_depth: facts.queue_depth,
				})
				.collect(),
			jobs: state.jobs.len(),
			attempt: state.attempt,
			dropped,
			git: state.git_facts.clone(),
			live_activity: state.audio.live_active().then_some(state.live_activity),
			tokens_per_second: state.tokens_per_second,
			cwd: Some(state.workspace_root.clone()),
			worktree: None,
			thinking: state.thinking,
			hooks: 0,
			tasks: 0,
			collab_peers: 0,
			account_override: None,
			quota_reset: false,
			reduced_motion: false,
			layout: StatusLayout::Compact,
			separator: StatusSeparator::Dot,
		}),
	);
	publish_collaboration_state(state, bus);
}

/// Auto-compaction boundary percents for the embedded context gauge, absent
/// when compaction is disabled or the window is unknown. The threshold marks
/// where auto-compaction fires; speculation marks where the background
/// summarizer starts, absent when async compaction is off or no ladder method
/// speculates.
fn compaction_boundaries(
	settings: &settings::CompactionSettings,
	context_window: Option<u64>,
) -> Option<omp_chat_ui::CompactionBoundaries> {
	let window = context_window.filter(|window| *window > 0)?;
	let order = settings.method_order();
	if order.as_slice().is_empty() {
		return None;
	}
	let threshold = (window as f64 * settings.threshold_fraction).floor() as u64;
	if threshold == 0 || threshold > window {
		return None;
	}
	let speculates = settings.async_enabled && order.speculation_tier().is_some();
	let lead = omp_agent::speculation_lead_tokens(threshold);
	Some(omp_chat_ui::CompactionBoundaries {
		threshold_percent:   threshold as f64 / window as f64 * 100.0,
		speculation_percent: speculates
			.then(|| threshold.saturating_sub(lead) as f64 / window as f64 * 100.0),
	})
}

fn status_model_label(catalog: &Catalog, model: &str) -> Str {
	catalog.model(ModelKey::from_ref(model)).map_or_else(
		|| Str::from(model),
		|model| {
			model
				.display_name
				.strip_prefix("Claude ")
				.unwrap_or_else(|| model.display_name.clone())
		},
	)
}

fn send_backend(sender: &flume::Sender<BackendEvent>, event: BackendEvent) {
	let _ = sender.send(event);
}

fn drain_live_activity(events: &SubscriptionHandle, state: &mut BridgeState) -> bool {
	let mut changed = false;
	while let Ok(event) = events.try_recv() {
		let band = match &*event {
			FirehoseEvent::TurnStart(_) => 1,
			FirehoseEvent::TurnEnd(_) => 0,
			FirehoseEvent::ModelRequest(_) => 3,
			FirehoseEvent::ModelAttempt(_) | FirehoseEvent::ProviderError(_) => 4,
			FirehoseEvent::ToolCall(_) => 2,
			_ => continue,
		};
		if state.audio.live_active() {
			state.live_activity.push(band);
			changed = true;
		}
	}
	changed
}

fn apply_turn_budget(state: &AgentState, budget: Option<&ParsedTurnBudget>) {
	state.update(|snapshot| {
		snapshot.turn.params.task_budget = budget.map(|budget| budget.task);
	});
}

fn chat_active(submit_pending: bool, phase: AgentPhase) -> bool {
	submit_pending || phase != AgentPhase::Idle
}
const fn should_abort_empty(active: bool, queued: usize) -> bool {
	active && queued > 0
}

/// Interrupt class delivering a submission into an active turn: Enter
/// steers immediately, Alt+Enter queues an idle follow-up.
fn send_retained_fact(
	backend: &flume::Sender<BackendEvent>,
	kind: &'static str,
	stable_id: &str,
	payload: serde_json::Value,
	summary: &str,
) {
	let mut fallback = String::from("<col gap=0><text bold>");
	push_tml_text(&mut fallback, kind);
	fallback.push_str("</text><text>");
	push_tml_text(&mut fallback, summary);
	fallback.push_str("</text></col>");
	let payload = serde_json::to_vec(&payload).unwrap_or_default();
	send_backend(
		backend,
		BackendEvent::RetainedFrame(RetainedFrameEnvelope {
			mutation: Some(retained_frame_envelope::Mutation::Upsert(RetainedFrame {
				key:      Some(RetainedFrameKey {
					kind:      kind.to_owned(),
					rev:       "v1".to_owned(),
					stable_id: stable_id.to_owned(),
				}),
				payload:  Bytes::from(payload),
				fallback: Some(Tml { source: Bytes::from(fallback), hash: 0 }),
				actions:  Vec::new(),
			})),
		}),
	);
}

fn push_tml_text(output: &mut String, text: &str) {
	for character in text.chars() {
		match character {
			'&' => output.push_str("&amp;"),
			'<' => output.push_str("&lt;"),
			'>' => output.push_str("&gt;"),
			'"' => output.push_str("&quot;"),
			'\'' => output.push_str("&apos;"),
			_ => output.push(character),
		}
	}
}
fn active_submit_class(mode: SubmitMode) -> InterruptClass {
	match mode {
		SubmitMode::Steer => InterruptClass::Immediate,
		SubmitMode::FollowUp => InterruptClass::Idle,
	}
}

const fn startup_recovery_needed(pending_turn: bool, pending_input_submission: bool) -> bool {
	pending_turn || pending_input_submission
}
/// Converts the scene's prompt answer to the inference authentication input.
pub fn auth_input(kind: AuthPromptKind, value: String) -> AuthInput {
	match kind {
		AuthPromptKind::ApiKey => AuthInput::ApiKey(SecretString::from(value)),
		AuthPromptKind::AuthorizationCode if url_shaped(&value) => {
			AuthInput::CallbackUrl(SecretString::from(value))
		},
		AuthPromptKind::AuthorizationCode => AuthInput::AuthorizationCode(SecretString::from(value)),
		AuthPromptKind::SessionToken => AuthInput::SessionToken(SecretString::from(value)),
		AuthPromptKind::PlainText => AuthInput::PlainText(Str::from(value)),
		AuthPromptKind::OptionalSecret => AuthInput::OptionalSecret(SecretString::from(value)),
		AuthPromptKind::Confirmation => AuthInput::DeviceConfirmed,
	}
}

fn url_shaped(value: &str) -> bool {
	let Some((scheme, _)) = value.split_once("://") else {
		return false;
	};
	let mut chars = scheme.chars();
	chars
		.next()
		.is_some_and(|first| first.is_ascii_alphabetic())
		&& chars.all(|char| char.is_ascii_alphanumeric() || matches!(char, '+' | '-' | '.'))
}

fn approval_ticket_view(ticket: &omp_agent::ApprovalTicket) -> ApprovalTicketView {
	let title = ticket
		.reasons
		.first()
		.map_or_else(|| sf!("Tool approval"), |reason| reason.title.clone());
	let detail = Str::new(
		ticket
			.reasons
			.iter()
			.map(|reason| reason.body.as_str())
			.collect::<Vec<_>>()
			.join("\n\n"),
	);
	let subject = Str::new(
		ticket
			.reasons
			.iter()
			.map(|reason| reason.subject.as_str())
			.collect::<Vec<_>>()
			.join("\n"),
	);
	let always_scope = ticket
		.reasons
		.iter()
		.flat_map(|reason| reason.scopes.iter())
		.next()
		.cloned();
	let evidence = ticket
		.reasons
		.iter()
		.flat_map(|reason| reason.evidence.iter().cloned())
		.collect();
	ApprovalTicketView {
		ticket_id: ticket.ticket_id.clone(),
		invocation_id: ticket.invocation_id.clone(),
		title,
		detail,
		subject,
		always_scope,
		evidence,
	}
}

fn approval_decision(request: &ApprovalRequest, action: ApprovalAction) -> ApprovalDecision {
	let (approved, scope, reason) = match action {
		ApprovalAction::AllowOnce => (true, sf!("once"), None),
		ApprovalAction::AllowAlways => {
			let scope = request
				.ticket
				.reasons
				.iter()
				.flat_map(|reason| reason.scopes.iter())
				.next()
				.cloned()
				.unwrap_or_else(|| sf!("always"));
			(true, scope, None)
		},
		ApprovalAction::Reject => (false, sf!("once"), Some(sf!("rejected by user"))),
		ApprovalAction::Amend(subject) => {
			(false, sf!("amend"), Some(sf!("replacement subject requested: {subject}")))
		},
	};
	ApprovalDecision {
		approved,
		scope,
		source: ApprovalSource::User,
		decided_by: None,
		reason,
		audited: false,
	}
}

async fn next_approval_request(inbox: &mut Option<ApprovalInbox>) -> Option<ApprovalRequest> {
	match inbox {
		Some(inbox) => inbox.recv().await.ok(),
		None => pending().await,
	}
}

async fn next_auth_event(auth: Option<&ChatAuth>) -> Option<ChatAuthEvent> {
	match auth {
		Some(auth) => auth.next_event().await,
		None => pending().await,
	}
}

/// Current Unix time in milliseconds for canonical user items.
pub fn now_ms() -> u64 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.unwrap_or_default()
		.as_millis() as u64
}
/// Newest unique prompts offered by the Ctrl+R history selector.
const PROMPT_HISTORY_ROWS: u32 = 500;

#[cfg(test)]
mod tests {
	use std::future;

	#[test]
	fn plan_save_filename_is_safe_and_word_bounded() {
		assert_eq!(plan_save_file_name("PyO3 types"), "PYO3_TYPES_PLAN.md");
		assert_eq!(plan_save_file_name("Auth storage plan"), "AUTH_STORAGE_PLAN.md");
		assert_eq!(
			plan_save_file_name("Split PyEnvironmentBackend request into PyO3 methods"),
			"SPLIT_PYENVIRONMENTBACKEND_PLAN.md",
		);
		assert_eq!(plan_save_file_name("  "), "PLAN.md");
		assert_eq!(plan_save_file_name("Plan"), "PLAN.md");
		assert_eq!(plan_save_file_name("../../unsafe destination"), "UNSAFE_DESTINATION_PLAN.md");
	}

	use omp_agent::{AgentKind, AgentStatus, Budget};
	use omp_core::ExposeSecret as _;
	use omp_tui::{
		Color, Size, UiContext, components::AttachmentContent, test_support::frame_row_text,
	};

	use super::*;
	struct LiveRendererDispatcher {
		views: Arc<Mutex<Vec<Value>>>,
	}

	#[async_trait::async_trait]
	impl omp_envd::exthost::dispatch::CallbackDispatcher for LiveRendererDispatcher {
		async fn dispatch(
			&self,
			_target: Arc<omp_envd::exthost::control::ControlConnectionIdentity>,
			dispatch: omp_envd::exthost::control::ControlDispatch,
		) -> Result<Value, omp_envd::exthost::control::ControlProtocolError> {
			self.views.lock().push(
				dispatch
					.arguments
					.get("view")
					.cloned()
					.expect("renderer view argument"),
			);
			Ok(serde_json::json!({ "source": "<text>extension live</text>" }))
		}
	}

	#[test]
	fn model_tags_cycle_order_and_hidden_direct_resolution_are_preserved() {
		let catalog = Catalog::embedded();
		let first = catalog
			.models()
			.first()
			.expect("embedded model")
			.key
			.to_string();
		let second = catalog
			.models()
			.get(1)
			.expect("second embedded model")
			.key
			.to_string();
		let mut settings = ModelSettings::default();
		settings
			.roles
			.insert(sf!("first"), Str::from(first.as_str()));
		settings
			.roles
			.insert(sf!("second"), Str::from(second.as_str()));
		settings
			.tags
			.insert(sf!("first"), omp_catalog::settings::ModelTag {
				name:   sf!("Hidden first"),
				color:  Some(sf!("red")),
				hidden: true,
			});
		settings
			.tags
			.insert(sf!("second"), omp_catalog::settings::ModelTag {
				name:   sf!("Review model"),
				color:  Some(sf!("cyan")),
				hidden: false,
			});
		settings.cycle_order = Arc::from([sf!("second"), sf!("first")]);

		let rows = model_rows(catalog, &settings, None);
		let tagged = rows
			.iter()
			.find(|row| row.key.as_str() == second)
			.expect("visible tagged model");
		assert_eq!(tagged.name, "Review model");
		assert_eq!(tagged.color.as_deref(), Some("cyan"));
		let cycle = cycle_model_rows(catalog, &settings, None);
		assert_eq!(cycle.first().map(|row| row.key.as_str()), Some(second.as_str()));
		assert!(cycle.iter().all(|row| row.key.as_str() != first));
		assert_eq!(
			resolve_model_selector(catalog, &settings, "first").map(|model| model.key.as_str()),
			Some(first.as_str()),
		);
	}

	#[test]
	fn account_bound_providers_require_an_enabled_account() {
		let catalog = Catalog::embedded();
		// A provider whose every credential path is account-backed (stored,
		// OAuth, or session) is invisible without an account; environment-backed
		// providers are excluded so ambient developer keys cannot flip the test.
		let provider = catalog
			.providers()
			.iter()
			.find(|provider| {
				let mut specs = provider
					.auth
					.iter()
					.filter_map(|auth_id| catalog.auth_spec(auth_id))
					.peekable();
				specs.peek().is_some()
					&& specs.all(|spec| {
						!matches!(spec.kind, AuthSpecKind::None | AuthSpecKind::OptionalBearer)
							&& !spec.credential_sources.is_empty()
							&& spec.credential_sources.iter().all(|source| {
								matches!(
									source,
									CredentialSourceSpec::Stored
										| CredentialSourceSpec::Oauth { .. }
										| CredentialSourceSpec::Session
								)
							})
					})
			})
			.expect("embedded catalog has an account-only provider");
		assert!(!provider_credentials_present(catalog, provider, &[]));
		let account = omp_inference::account::AccountRecord {
			account:               omp_inference::AccountId::from(format!("{}:test", provider.id)),
			principal:             omp_inference::PrincipalId::from("test"),
			provider:              provider.id.clone(),
			routes:                Default::default(),
			enabled:               true,
			credential_generation: 1,
			routing:               Default::default(),
		};
		assert!(provider_credentials_present(catalog, provider, std::slice::from_ref(&account)));
		let disabled = omp_inference::account::AccountRecord { enabled: false, ..account };
		assert!(!provider_credentials_present(catalog, provider, &[disabled]));
	}

	struct StubSession;
	impl omp_agent::TurnSession for StubSession {
		fn events(
			&mut self,
		) -> impl futures::Stream<Item = Result<omp_agent::TurnEvent, omp_agent::Error>> + Send + Unpin + '_
		{
			futures::stream::empty()
		}

		fn submit(
			&mut self,
			_frame: omp_agent::InvokeFrame,
		) -> impl Future<Output = Result<(), omp_agent::Error>> + Send + '_ {
			future::ready(Ok(()))
		}
	}

	#[derive(Clone)]
	struct StubClient;
	impl TurnClient for StubClient {
		type Session<'client> = StubSession;

		fn turn<'client>(
			&'client self,
			_turn_id: omp_agent::TurnId,
			_input: omp_agent::TurnInput,
			_options: &'client omp_agent::TurnOptions,
		) -> impl Future<Output = Result<Self::Session<'client>, omp_agent::Error>> + Send + 'client
		{
			future::ready(Ok(StubSession))
		}
	}

	fn stub_parent_host(scratch: &Path) -> ChatParentHost<StubClient> {
		let registry = Arc::new(omp_tool::Registry::new());
		let snapshot = omp_agent::AgentSnapshot::new(
			omp_agent::TurnOptions::default(),
			omp_agent::PromptFacts::new(scratch, Arc::from([]))
				.props()
				.expect("scratch path produces prompt props"),
			registry,
		);
		let state = omp_agent::AgentState::new(snapshot);
		let (env, _transport) = omp_env::EnvClient::in_process(1);
		ChatParentHost::new(
			StubClient,
			env,
			state,
			sf!("session-a"),
			scratch.join("sessions"),
			scratch.to_path_buf(),
			Arc::new(SessionIndex::open(scratch.join("sessions.sqlite3")).expect("session index")),
			false,
		)
	}

	#[test]
	fn roster_projection_keeps_only_the_current_canonical_session_nodes() {
		let scratch = tempfile::tempdir().expect("scratch directory");
		let parent = stub_parent_host(scratch.path());
		let tree = parent.tree();
		let main = tree
			.register(
				sf!("main"),
				sf!("Main"),
				AgentKind::Main,
				None,
				sf!("session-a"),
				Budget::default(),
			)
			.expect("session root");
		main.set_status(AgentStatus::Running);
		tree
			.register(
				sf!("other"),
				sf!("Main"),
				AgentKind::Main,
				None,
				sf!("session-b"),
				Budget::default(),
			)
			.expect("other session");

		// A lone root is not worth a HUD: the roster projects empty until
		// a subagent joins the session.
		assert!(project_agent_roster(&parent, &tree, "session-a").is_empty());

		tree
			.register(
				sf!("worker"),
				sf!("Worker"),
				AgentKind::Subagent,
				Some(sf!("main")),
				sf!("session-a"),
				Budget::default(),
			)
			.expect("subagent");
		let rows = project_agent_roster(&parent, &tree, "session-a");
		assert_eq!(rows.len(), 2);
		let main = rows
			.iter()
			.find(|row| row.id == "main")
			.expect("canonical main");
		assert_eq!(main.status, "running", "the session root is the canonical node");
		assert!(rows.iter().any(|row| row.id == "worker"));
		assert!(
			project_agent_roster(&parent, &tree, "session-b").is_empty(),
			"other sessions stay solo"
		);
	}

	#[test]
	fn regime_denial_renders_mode_owner_activation_and_since() {
		let mut regimes = omp_agent::RegimeSet::new();
		let (plan, machine) = omp_agent::core_regime("plan").expect("plan regime");
		let granted = regimes
			.start(plan, machine, omp_agent::StartOptions { now_ms: 41, queue: false })
			.expect("plan start");
		let modes = RegimeHandle::new();
		modes.sync_regimes(&regimes);
		let (backend, events) = flume::unbounded();
		let result = Err(omp_agent::AgentError::Arbiter(omp_agent::ArbiterError::Start(
			omp_agent::StartError::Acquire {
				resource: omp_agent::Resource::Mode,
				outcome:  omp_agent::AcquireOutcome::Denied {
					holder: granted.activation.clone(),
					since:  41,
				},
			},
		)));
		assert!(report_regime_start(&backend, &modes, "goal", result).is_none());
		let BackendEvent::Error(message) = events.recv().expect("denial event") else {
			panic!("denial must render as an error")
		};
		assert!(message.contains("stop plan first"));
		assert!(message.contains(granted.activation.as_str()));
		assert!(message.contains("since 41"));
	}
	#[test]
	fn status_model_label_uses_catalog_display_without_claude_prefix() {
		let catalog = Catalog::embedded();
		assert_eq!(status_model_label(catalog, "anthropic/claude-opus-5"), "Opus 5");
		assert_eq!(status_model_label(catalog, "not-catalogued"), "not-catalogued");
	}
	#[test]
	fn model_picker_emits_selectable_catalog_rows() {
		let scratch = tempfile::tempdir().expect("scratch");
		let state = test_bridge_state(scratch.path());
		let (backend, events) = flume::unbounded();
		send_open_models(&backend, &state);

		let BackendEvent::OpenModelPicker { rows, current } = events.recv().expect("model picker")
		else {
			panic!("model picker event")
		};
		assert!(!rows.is_empty());
		assert!(current < rows.len());
	}
	#[test]
	fn status_thinking_level_keeps_only_visible_reasoning_efforts() {
		assert_eq!(status_thinking_level(Effort::Off), None);
		assert_eq!(status_thinking_level(Effort::Max), Some(StatusThinkingLevel::Max));
	}
	#[test]
	fn composer_shape_setting_decodes_into_live_style() {
		let mut settings = Settings::default();
		apply_setting_changes(&mut settings, &[omp_chat_ui::SettingChange {
			domain: sf!("interaction"),
			path:   sf!("composer.shape"),
			value:  Value::String("rail".into()),
		}])
		.expect("composer shape setting");

		assert_eq!(settings.composer.shape, settings::ComposerStyle::Rail);
		assert_eq!(
			presentation_composer_style(settings.composer.shape),
			components::ComposerStyle::Rail
		);
	}

	fn test_bridge_state(scratch: &Path) -> BridgeState {
		let command_usage = Arc::new(
			CommandUsage::load(Arc::new(
				SessionIndex::open(scratch.join("sessions.sqlite3")).expect("session index"),
			))
			.expect("command usage"),
		);
		let (environment, _transport) = omp_env::EnvClient::in_process(1);
		BridgeState {
			catalog: Arc::new(Catalog::embedded().clone()),
			session_hooks: Arc::new(omp_agent::HookGate::channel().0),
			auth_control: None,
			model: "test/model".to_owned(),
			model_settings: ModelSettings::default(),
			pending_session_delete: None,
			git: None,
			git_facts: None,
			advisor: None,
			title: SessionTitleState::default(),
			title_generation_in_flight: Arc::new(AtomicBool::new(false)),
			title_user_set: Arc::new(AtomicBool::new(false)),
			title_commit_lock: Arc::new(tokio::sync::Mutex::new(())),
			session_path: scratch.join("test-session.jsonl"),
			sessions_dir: scratch.to_path_buf(),
			title_replan_refresh_pending: false,
			environment,
			lsp_servers: Vec::new(),
			local_root: env::temp_dir(),
			session_id: sf!("test-session"),
			regimes: RegimeHandle::new(),
			regime_revision: 0,
			collab: None,
			collab_live: None,
			collab_state: None,
			memory: None,
			workspace_root: sf!("/workspace"),
			appearance: omp_tui::Appearance::Dark,
			presentation: UiContext::default(),
			hyperlinks: false,
			theme_watcher: ThemeWatcher::new(),
			theme_revision: 0,
			tools_expanded: true,
			hidden_thinking_label: None,
			deferred: DeferredCommands::new(),
			active_ptys: HashMap::new(),
			context_window: None,
			context_tokens: 0,
			context_snapshot: None,
			cost_nanos: 0,
			queued: 0,
			queued_prompts: VecDeque::new(),
			audio: crate::audio_coordinator::InteractiveAudioController::new(),
			jobs: HashSet::new(),
			attempt: 0,
			turn_started: None,
			has_history: false,
			submit_pending: false,
			pending_prompt: None,
			part_serial: 0,
			active_parts: HashMap::new(),
			active_markdown: HashMap::new(),
			streaming_tools: HashMap::new(),
			tools: HashMap::new(),
			rewind_targets: Vec::new(),
			pending_auth_kind: None,
			pending_auth_provider: None,
			live_activity: ActivityWaveform::new(),
			token_rate: None,
			tokens_per_second: None,
			thinking: None,
			replaying_turn: false,
			vision_override: None,
			settings: Settings::default(),
			prompt_discovery_settings: omp_driver::discovery::PromptDiscoverySettings::default(),
			commands: CommandRoster::new(Vec::new()),
			command_sources: Vec::new(),
			command_usage,
			typed_commands: commands::CommandRoster::builtins(),
			extension_ui: Arc::new(presentation::PublishedUiRoster::default()),
			extension_callbacks: None,
			skills: Default::default(),
			extension_declarations: Arc::from([]),
			extension_generation: 0,
			extension_mcp: None,
			extension_live_mcp: HashMap::new(),
			approvals: HashMap::new(),
			presentation_requests: HashMap::new(),
			raw_stream: None,
		}
	}

	#[test]
	fn chat_event_subscription_keeps_bursts_beyond_the_old_ui_capacity() {
		let bus = omp_agent::EventBus::new();
		let events = subscribe_chat_events(&bus);
		for generation in 0..300 {
			bus.publish(AgentEvent::RosterChanged { generation });
		}
		assert_eq!(events.len(), 300);
	}
	#[tokio::test]
	async fn live_tool_events_dispatch_extension_renderer_tml() {
		let scratch = tempfile::tempdir().expect("scratch directory");
		let (tx, rx) = flume::unbounded();
		let mut state = test_bridge_state(scratch.path());
		let identity =
			ToolIdentity { name: sf!("counter"), rev: Rev { family: sf!("counter"), n: 2 } };
		let target = Arc::new(omp_envd::exthost::control::ControlConnectionIdentity {
			extension:          sf!("renderer-fixture"),
			principal:          omp_envd::exthost::Principal::new(
				sf!("renderer-fixture"),
				sf!("Renderer fixture"),
			),
			artifact_digest:    sf!("digest"),
			layer:              sf!("workspace"),
			tier:               sf!("trusted"),
			trust:              sf!("trusted"),
			host_generation:    1,
			session_generation: 1,
			capabilities:       Arc::new(std::collections::BTreeSet::new()),
		});
		let views = Arc::new(Mutex::new(Vec::new()));
		state.extension_ui.install_test_renderer(
			omp_envd::exthost::VerifiedRendererDeclaration {
				declaration_id: sf!("counter-renderer"),
				identity:       identity.clone(),
				callback:       sf!("fixture.render"),
				reduce:         None,
				decorates:      false,
				module:         sf!("fixture"),
			},
			target,
			Arc::new(LiveRendererDispatcher { views: Arc::clone(&views) }),
		);
		let modes = RegimeHandle::new();
		let renderers = RenderRegistry::new();
		let bus = omp_agent::EventBus::new();
		handle_agent_event(
			&tx,
			&mut state,
			&AgentEvent::ToolOpened {
				call_id: sf!("call-1"),
				name:    identity.name.clone(),
				rev:     identity.rev.clone(),
			},
			&modes,
			&renderers,
			&bus,
			0,
		)
		.await;
		handle_agent_event(
			&tx,
			&mut state,
			&AgentEvent::ToolUpdate {
				call_id: sf!("call-1"),
				json:    Bytes::from_static(br#"{"count":1}"#),
			},
			&modes,
			&renderers,
			&bus,
			0,
		)
		.await;
		handle_agent_event(
			&tx,
			&mut state,
			&AgentEvent::ToolFinished {
				call_id: sf!("call-1"),
				item:    Item {
					kind: Some(item::Kind::ToolResult(omp_proto::thread::v1::ToolResult {
						call_id: "call-1".to_owned(),
						name: "counter".to_owned(),
						details: Some(json_proto(serde_json::json!({
							"kind": "ok",
							"value": { "count": 1 },
						}))),
						..Default::default()
					})),
					props: Some(revision_props("counter.2")),
					..Default::default()
				},
				usage:   Default::default(),
			},
			&modes,
			&renderers,
			&bus,
			0,
		)
		.await;

		let events = rx.drain().collect::<Vec<_>>();
		assert!(events.iter().any(|event| matches!(
			event,
			BackendEvent::ToolView {
				id,
				view: ToolViewContent::Markup(source),
			} if id == "call-1" && source == "<text>extension live</text>"
		)));
		assert!(events.iter().any(|event| matches!(
			event,
			BackendEvent::ToolFinished {
				id,
				view: ToolViewContent::Markup(source),
				..
			} if id == "call-1" && source == "<text>extension live</text>"
		)));
		let views = views.lock();
		assert_eq!(views.len(), 2);
		assert_eq!(views[0]["call_id"], "call-1");
		assert_eq!(views[0]["updates"], serde_json::json!([{ "count": 1 }]));
		assert_eq!(views[0]["verdict"], Value::Null);
		assert_eq!(views[1]["verdict"]["kind"], "ok");
	}

	#[tokio::test]
	async fn active_turn_text_and_error_notices_project_into_viewport_or_retirement_rows() {
		let scratch = tempfile::tempdir().expect("scratch directory");
		let (tx, rx) = flume::unbounded();
		let mut state = test_bridge_state(scratch.path());
		let modes = RegimeHandle::new();
		let renderers = RenderRegistry::new();
		let bus = omp_agent::EventBus::new();
		for event in [
			Event::PartStart(v1::PartStart {
				index:        0,
				kind:         part_start::Kind::Text as i32,
				tool_call_id: String::new(),
				tool_name:    String::new(),
			}),
			Event::PartDelta(v1::PartDelta { index: 0, chunk: Bytes::from_static(b"banana") }),
			Event::PartEnd(v1::PartEnd { index: 0, signature: Bytes::new() }),
		] {
			handle_agent_event(
				&tx,
				&mut state,
				&AgentEvent::Turn {
					turn_id: TurnId::new("active-turn"),
					event:   Box::new(v1::TurnEvent { event: Some(event) }),
				},
				&modes,
				&renderers,
				&bus,
				0,
			)
			.await;
		}
		send_backend(&tx, BackendEvent::Error(sf!("Compaction failed: unauthorized")));

		let mut chat = Chat::new(&UiContext::default());
		let viewport = Size::new(80, 30);
		let _ = chat.render(viewport);
		let _ = chat.apply_backend_event(BackendEvent::UserReplayed {
			text:   sf!("say banana"),
			chips:  Vec::new(),
			queued: false,
		});
		for event in rx.drain() {
			let _ = chat.apply_backend_event(event);
		}
		let rendered = chat.render(viewport);
		let viewport_text = (0..rendered.frame.size().height)
			.map(|row| frame_row_text(rendered.frame, row))
			.collect::<Vec<_>>()
			.join("\n");
		let retirement_text = chat
			.retirement_batch(Size::new(viewport.width, 0))
			.map(|batch| {
				(0..batch.frame.size().height)
					.map(|row| frame_row_text(&batch.frame, row))
					.collect::<Vec<_>>()
					.join("\n")
			})
			.unwrap_or_default();
		let transcript = format!("{viewport_text}\n{retirement_text}");
		assert!(transcript.contains("say banana"), "{transcript}");
		assert!(transcript.contains("banana"), "{transcript}");
		assert!(transcript.contains("Compaction failed: unauthorized"), "{transcript}");
	}

	#[test]
	fn rewind_attachments_recover_pastes_and_supported_images_only() {
		let parts = vec![
			Part { kind: Some(part::Kind::Text("<attachment>two\nlines</attachment>".to_owned())) },
			Part {
				kind: Some(part::Kind::Blob(Blob {
					mime: "image/png".to_owned(),
					inline: Bytes::from_static(b"png-bytes"),
					hash: Bytes::from_static(b"stable-hash-for-test"),
					..Blob::default()
				})),
			},
			Part {
				kind: Some(part::Kind::Blob(Blob {
					mime: "application/pdf".to_owned(),
					inline: Bytes::from_static(b"pdf-bytes"),
					..Blob::default()
				})),
			},
		];
		let attachments = rewind_attachments(&parts);
		assert_eq!(attachments.len(), 2, "unsupported blob mimes are skipped");
		let RestoredAttachment::Text(text) = &attachments[0] else {
			panic!("first restored attachment is the paste");
		};
		assert_eq!(text.as_str(), "two\nlines");
		let RestoredAttachment::Image { source } = &attachments[1] else {
			panic!("second restored attachment is the image");
		};
		assert!(source.ends_with(".png"), "{source}");
		assert!(Path::new(source.as_str()).is_file(), "blob persisted to {source}");
		let _ = fs::remove_file(source.as_str());
	}

	#[tokio::test]
	async fn turn_failure_settles_streaming_parts_and_tool_widgets() {
		let scratch = tempfile::tempdir().expect("scratch directory");
		let (tx, rx) = flume::unbounded();
		let mut state = test_bridge_state(scratch.path());
		let modes = RegimeHandle::new();
		let renderers = RenderRegistry::new();
		let bus = omp_agent::EventBus::new();
		for event in [
			Event::PartStart(v1::PartStart {
				index:        0,
				kind:         part_start::Kind::Thinking as i32,
				tool_call_id: String::new(),
				tool_name:    String::new(),
			}),
			Event::PartStart(v1::PartStart {
				index:        1,
				kind:         part_start::Kind::ToolCall as i32,
				tool_call_id: "toolu_1".to_owned(),
				tool_name:    "shell".to_owned(),
			}),
			Event::PartDelta(v1::PartDelta {
				index: 1,
				chunk: Bytes::from_static(br#"{"command":"cd /w"#),
			}),
		] {
			handle_agent_event(
				&tx,
				&mut state,
				&AgentEvent::Turn {
					turn_id: TurnId::new("failed-turn"),
					event:   Box::new(v1::TurnEvent { event: Some(event) }),
				},
				&modes,
				&renderers,
				&bus,
				0,
			)
			.await;
		}
		assert!(state.tools.get("toolu_1").is_some_and(|tool| tool.started));
		handle_agent_event(
			&tx,
			&mut state,
			&AgentEvent::Failed {
				turn_id: Some(TurnId::new("failed-turn")),
				message: sf!("terminal turn error (Upstream)"),
			},
			&modes,
			&renderers,
			&bus,
			0,
		)
		.await;
		assert!(state.active_parts.is_empty());
		assert!(state.streaming_tools.is_empty());
		assert!(state.tools.is_empty());
		let events: Vec<_> = rx.drain().collect();
		assert!(
			events
				.iter()
				.any(|event| matches!(event, BackendEvent::AssistantEnd { .. })),
			"open thinking part must be closed on turn failure"
		);
		assert!(
			events.iter().any(|event| matches!(
				event,
				BackendEvent::ToolFinished { id, terminal: ToolTerminal::Failed, .. }
					if id.as_str() == "toolu_1"
			)),
			"started tool widget must settle as failed on turn failure"
		);
	}

	#[test]
	fn blank_submission_interrupts_only_with_queued_work() {
		assert!(!should_abort_empty(false, 0));
		assert!(!should_abort_empty(true, 0));
		assert!(!should_abort_empty(false, 1));
		assert!(should_abort_empty(true, 1));
	}

	#[test]
	fn active_submissions_map_enter_to_steer_and_follow_up_to_idle() {
		assert_eq!(active_submit_class(SubmitMode::Steer), InterruptClass::Immediate);
		assert_eq!(active_submit_class(SubmitMode::FollowUp), InterruptClass::Idle);
	}

	#[test]
	fn authentication_prompt_masking_matches_input_kind() {
		assert!(prompt_masks_input(AuthPromptKind::ApiKey));
		assert!(prompt_masks_input(AuthPromptKind::OptionalSecret));
		assert!(!prompt_masks_input(AuthPromptKind::PlainText));
		assert!(!prompt_masks_input(AuthPromptKind::Confirmation));
	}

	#[test]
	fn auth_input_preserves_other_prompt_kinds() {
		assert!(matches!(
			auth_input(AuthPromptKind::ApiKey, "secret".to_owned()),
			AuthInput::ApiKey(_)
		));
		assert!(matches!(
			auth_input(AuthPromptKind::PlainText, "visible".to_owned()),
			AuthInput::PlainText(value) if value.as_str() == "visible"
		));
		assert!(matches!(
			auth_input(AuthPromptKind::Confirmation, String::new()),
			AuthInput::DeviceConfirmed
		));
	}

	#[test]
	fn auth_input_maps_redirect_urls_to_callback_urls() {
		let AuthInput::CallbackUrl(value) = auth_input(
			AuthPromptKind::AuthorizationCode,
			"http://localhost:54545/callback?code=abc&state=xyz".to_owned(),
		) else {
			panic!("redirect URL must be submitted as a callback URL");
		};
		assert_eq!(value.expose_secret(), "http://localhost:54545/callback?code=abc&state=xyz");
	}

	#[test]
	fn auth_input_keeps_bare_authorization_codes() {
		assert!(matches!(
			auth_input(AuthPromptKind::AuthorizationCode, "abc-123".to_owned()),
			AuthInput::AuthorizationCode(value) if value.expose_secret() == "abc-123"
		));
	}

	#[test]
	fn text_attachment_lowers_after_typed_text() {
		let mut item = input::user_message("typed");
		let attachment = Attachment::new(
			AttachmentContent::Text {
				text:    sf!("pasted"),
				snippet: sf!("pasted"),
				lines:   1,
				chars:   6,
			},
			1,
			Color::Default,
		);
		let chips = lower_attachments(&mut item, vec![attachment], |_| {});
		let Some(item::Kind::Message(message)) = item.kind else {
			panic!("message")
		};
		assert_eq!(message.parts.len(), 2);
		assert!(matches!(
			&message.parts[1].kind,
			Some(part::Kind::Text(text)) if text == "<attachment>pasted</attachment>"
		));
		assert_eq!(chips[0].as_str(), "paste · 1 lines");
	}

	#[test]
	fn image_attachment_lowers_to_inline_hashed_blob() {
		let path =
			env::temp_dir().join(format!("omp-chat-attachment-{}.png", omp_core::Ulid::generate()));
		let bytes = b"not-a-decoded-image";
		fs::write(&path, bytes).expect("write attachment fixture");
		let mut item = input::user_message("inspect");
		let attachment = Attachment::new(
			AttachmentContent::Image {
				source:     Str::from(path.to_string_lossy().as_ref()),
				dimensions: None,
			},
			1,
			Color::Default,
		);
		let mut errors = Vec::new();
		let chips = lower_attachments(&mut item, vec![attachment], |error| errors.push(error));
		fs::remove_file(path).expect("remove attachment fixture");
		assert!(errors.is_empty());
		let Some(item::Kind::Message(message)) = item.kind else {
			panic!("message")
		};
		let Some(part::Kind::Blob(blob)) = &message.parts[1].kind else {
			panic!("blob")
		};
		assert_eq!(blob.mime, "image/png");
		assert_eq!(blob.inline.as_ref(), bytes);
		assert_eq!(blob.hash.as_ref(), Hash32::sum(bytes).as_bytes());
		assert_eq!(chips.len(), 1);
	}

	#[test]
	fn png_tool_result_blobs_surface_as_inline_image_events() {
		use omp_proto::thread::v1;

		let (tx, rx) = flume::unbounded();
		let png: &[u8] = b"\x89PNG\r\n\x1a\nfake";
		let item = Item {
			kind: Some(item::Kind::ToolResult(v1::ToolResult {
				call_id: "call-1".to_owned(),
				name: "read".to_owned(),
				parts: vec![
					Part { kind: Some(part::Kind::Text("rendered page 1".to_owned())) },
					Part {
						kind: Some(part::Kind::Blob(Blob {
							hash:   Bytes::from_static(b"0123456789abcdef0123456789abcdef"),
							mime:   "image/png".to_owned(),
							size:   png.len() as u64,
							inline: Bytes::from_static(png),
							detail: blob::Detail::Original as i32,
						})),
					},
				],
				..Default::default()
			})),
			..Default::default()
		};
		send_tool_result_images(&tx, &sf!("call-1"), &item);
		let events: Vec<_> = rx.drain().collect();
		let Some(BackendEvent::ToolImage { id, source }) = events.first() else {
			panic!("PNG blob produces a ToolImage event");
		};
		assert_eq!(id.as_str(), "call-1");
		let persisted = fs::read(source.as_str()).expect("persisted image payload");
		assert_eq!(persisted, png);
		assert_eq!(events.len(), 1, "model-facing text is not mined into the UI view");
		fs::remove_file(source.as_str()).ok();
	}

	#[test]
	fn non_png_tool_result_blobs_defer_to_the_structured_view() {
		use omp_proto::thread::v1;

		let (tx, rx) = flume::unbounded();
		let item = Item {
			kind: Some(item::Kind::ToolResult(v1::ToolResult {
				call_id: "call-2".to_owned(),
				name: "read".to_owned(),
				parts: vec![Part {
					kind: Some(part::Kind::Blob(Blob {
						hash:   Bytes::new(),
						mime:   "image/jpeg".to_owned(),
						size:   4,
						inline: Bytes::from_static(b"jpeg"),
						detail: blob::Detail::Original as i32,
					})),
				}],
				..Default::default()
			})),
			..Default::default()
		};
		send_tool_result_images(&tx, &sf!("call-2"), &item);
		assert!(rx.is_empty());
	}

	#[test]
	fn startup_recovery_covers_both_durable_crash_windows() {
		assert!(!startup_recovery_needed(false, false));
		assert!(startup_recovery_needed(true, false));
		assert!(startup_recovery_needed(false, true));
		assert!(startup_recovery_needed(true, true));
	}

	#[derive(Default)]
	struct TestFold {
		updates:   String,
		args:      String,
		committed: bool,
	}

	#[derive(serde::Deserialize)]
	struct TestUpdate {
		text: String,
	}

	struct TestRenderer(&'static str);

	impl omp_tool::render::RenderFold for TestRenderer {
		type Outcome = serde_json::Value;
		type State = TestFold;
		type Update = TestUpdate;

		fn fold(&self, state: &mut Self::State, update: Self::Update) {
			state.updates.push_str(&update.text);
		}

		fn fold_args(&self, state: &mut Self::State, args: &omp_slopjson::Value, complete: bool) {
			state.args = args
				.get("query")
				.and_then(|value| value.as_str())
				.unwrap_or_default()
				.to_owned();
			state.committed = complete;
		}

		fn view(&self, state: &Self::State, outcome: Option<&Self::Outcome>) -> Option<Str> {
			let branch = outcome
				.and_then(|outcome| outcome.get("kind"))
				.and_then(serde_json::Value::as_str)
				.unwrap_or("live");
			if state.args.is_empty() {
				return Some(sf!("<row>{}:{}:{branch}</row>", self.0, state.updates));
			}
			let commit = if state.committed {
				"committed"
			} else {
				"partial"
			};
			Some(sf!("<row>{}:{}:{}:{commit}:{branch}</row>", self.0, state.args, state.updates))
		}
	}

	fn test_identity(rev: &str) -> ToolIdentity {
		ToolIdentity { name: sf!("same"), rev: rev.parse().expect("valid test revision") }
	}

	fn json_proto(value: serde_json::Value) -> v1::Value {
		let kind = match value {
			serde_json::Value::Null => value::Kind::Null(true),
			serde_json::Value::Bool(value) => value::Kind::Bool(value),
			serde_json::Value::String(value) => value::Kind::String(value),
			serde_json::Value::Number(value) => value
				.as_i64()
				.map_or_else(|| value::Kind::Uint(value.as_u64().expect("integer")), value::Kind::Int),
			serde_json::Value::Array(values) => value::Kind::List(v1::ValueList {
				values: values.into_iter().map(json_proto).collect(),
			}),
			serde_json::Value::Object(values) => value::Kind::Map(v1::ValueMap {
				fields: values
					.into_iter()
					.map(|(key, value)| (key, json_proto(value)))
					.collect(),
			}),
		};
		v1::Value { kind: Some(kind) }
	}

	fn revision_props(rev: &str) -> v1::ValueMap {
		v1::ValueMap {
			fields: [(TOOL_REV_PROP.to_owned(), v1::Value {
				kind: Some(value::Kind::String(rev.to_owned())),
			})]
			.into(),
		}
	}

	fn result_item(call_id: &str, rev: Option<&str>, branch: &str) -> Item {
		use omp_proto::thread::v1;

		Item {
			kind: Some(item::Kind::ToolResult(v1::ToolResult {
				call_id: call_id.to_owned(),
				name: "same".to_owned(),
				details: Some(json_proto(serde_json::json!({
					"kind": branch,
					"value": { "fact": format!("{branch}-fact") }
				}))),
				is_error: branch == "faulted",
				..Default::default()
			})),
			props: rev.map(revision_props),
			..Default::default()
		}
	}

	#[test]
	fn edit_tool_title_lists_distinct_sparse_opener_paths() {
		let args = omp_slopjson::parse_streaming(
			"{\"input\":\"§src/one.rs\\nold\\n§\\n§*src/two.rs\\n§src/one.rs\"}",
		);
		assert_eq!(tool_title(&Str::new_static("edit"), &args), "edit · src/one.rs (+1 more)");
	}

	#[test]
	fn edit_tool_title_keeps_hashline_header_fallback() {
		let args = omp_slopjson::parse_streaming("{\"input\":\"[src/main.rs#abc]\\npatch\"}");
		assert_eq!(tool_title(&Str::new_static("edit"), &args), "edit · src/main.rs");
	}

	#[test]
	fn streaming_args_render_live_previews_before_any_update() {
		let mut renderers = RenderRegistry::new();
		renderers
			.register(test_identity("test.1"), TestRenderer("one"))
			.expect("register renderer");
		let mut tool = ToolDisplay {
			identity:           test_identity("test.1"),
			args:               omp_slopjson::parse_streaming(r#"{"query":"parti"#),
			started:            false,
			fold:               ViewState::new(),
			updates:            Vec::new(),
			opened:             Instant::now(),
			extension_renderer: None,
		};
		assert_eq!(
			fold_tool_args(&renderers, &mut tool, false)
				.expect("partial args render a live preview")
				.as_str(),
			"<row>one:parti::partial:live</row>"
		);
		tool.args = omp_slopjson::parse_streaming(r#"{"query":"partial search"}"#);
		assert_eq!(
			fold_tool_args(&renderers, &mut tool, true)
				.expect("committed args render a live preview")
				.as_str(),
			"<row>one:partial search::committed:live</row>"
		);
		let mut unknown = ToolDisplay {
			identity:           test_identity("test.9"),
			args:               omp_slopjson::parse_streaming(r#"{"query":"x"}"#),
			started:            false,
			fold:               ViewState::new(),
			updates:            Vec::new(),
			opened:             Instant::now(),
			extension_renderer: None,
		};
		assert!(fold_tool_args(&renderers, &mut unknown, false).is_none());
	}

	#[test]
	fn exact_revision_renderers_fold_streamed_updates_independently() {
		let mut renderers = RenderRegistry::new();
		renderers
			.register(test_identity("test.1"), TestRenderer("one"))
			.expect("register revision one");
		renderers
			.register(test_identity("test.2"), TestRenderer("two"))
			.expect("register revision two");
		let mut first = ToolDisplay {
			identity:           test_identity("test.1"),
			args:               omp_slopjson::Value::Object(omp_slopjson::Object::new()),
			started:            true,
			fold:               ViewState::new(),
			updates:            Vec::new(),
			opened:             Instant::now(),
			extension_renderer: None,
		};
		let mut second = ToolDisplay {
			identity:           test_identity("test.2"),
			args:               omp_slopjson::Value::Object(omp_slopjson::Object::new()),
			started:            true,
			fold:               ViewState::new(),
			updates:            Vec::new(),
			opened:             Instant::now(),
			extension_renderer: None,
		};
		assert_eq!(
			fold_tool_update(&renderers, &mut first, Bytes::from_static(br#"{"text":"a"}"#)).as_str(),
			"<row>one:a:live</row>"
		);
		assert_eq!(
			fold_tool_update(&renderers, &mut first, Bytes::from_static(br#"{"text":"b"}"#)).as_str(),
			"<row>one:ab:live</row>"
		);
		assert_eq!(
			fold_tool_update(&renderers, &mut second, Bytes::from_static(br#"{"text":"z"}"#)).as_str(),
			"<row>two:z:live</row>"
		);
	}

	#[test]
	fn durable_branches_and_missing_revisions_preserve_structured_facts() {
		let mut renderers = RenderRegistry::new();
		renderers
			.register(test_identity("test.1"), TestRenderer("exact"))
			.expect("register exact renderer");
		for branch in ["ok", "faulted", "args_rejected", "aborted"] {
			let (_, terminal, view) =
				render_tool_result_view(&renderers, &result_item("call", Some("test.1"), branch), None);
			let expected = match branch {
				"ok" => ToolTerminal::Succeeded,
				"faulted" => ToolTerminal::Failed,
				"args_rejected" => ToolTerminal::ArgsRejected,
				"aborted" => ToolTerminal::Aborted,
				_ => unreachable!(),
			};
			assert_eq!(terminal, expected);
			assert!(view.as_str().contains(branch), "{}", view.as_str());
			assert!(matches!(view, ToolViewContent::Markup(_)));
		}
		let mut skipped = result_item("skipped", Some("test.1"), "aborted");
		let Some(item::Kind::ToolResult(result)) = skipped.kind.as_mut() else {
			panic!("tool result fixture");
		};
		result.details = Some(json_proto(serde_json::json!({
			"kind": "aborted",
			"value": { "kind": "skipped", "reason": "steered" }
		})));
		let (_, terminal, _) = render_tool_result_view(&renderers, &skipped, None);
		assert_eq!(terminal, ToolTerminal::Skipped);

		let system = Item {
			kind: Some(item::Kind::Message(omp_proto::thread::v1::Message {
				role:  omp_proto::thread::v1::Role::System as i32,
				parts: vec![omp_proto::thread::v1::Part {
					kind: Some(part::Kind::Text("private durable prompt".to_owned())),
				}],
			})),
			..Default::default()
		};
		let call = Item {
			kind: Some(item::Kind::ToolCall(omp_proto::thread::v1::ToolCall {
				id: "interrupted".to_owned(),
				name: "same".to_owned(),
				args_json: Bytes::from_static(b"{}"),
				..Default::default()
			})),
			props: Some(revision_props("test.1")),
			..Default::default()
		};
		let mut interrupted = result_item("interrupted", Some("test.1"), "aborted");
		let Some(item::Kind::ToolResult(result)) = interrupted.kind.as_mut() else {
			panic!("tool result fixture");
		};
		result.details = Some(json_proto(serde_json::json!({
			"kind": "aborted",
			"value": { "kind": "interrupted", "reason": "user interrupt" }
		})));
		let replayed_events = replay_backend_events(&[system, call, interrupted], &renderers);
		assert!(
			!replayed_events
				.iter()
				.any(|event| matches!(event, BackendEvent::Notice(_))),
			"same-process replay exposed durable system prompt context"
		);
		let replayed = replayed_events
			.into_iter()
			.find_map(|event| match event {
				BackendEvent::ToolFinished { view, .. } => Some(view),
				_ => None,
			})
			.expect("replayed interrupted result");
		assert!(matches!(&replayed, ToolViewContent::Markup(_)));
		assert!(
			replayed
				.as_str()
				.contains("&quot;kind&quot;:&quot;interrupted&quot;"),
			"replayed exact renderer erased durable interruption metadata: {}",
			replayed.as_str()
		);

		let unknown = result_item("unknown", Some("unknown.9"), "faulted");
		let (identity, terminal, view) = render_tool_result_view(&renderers, &unknown, None);
		assert_eq!(identity.rev.to_string(), "unknown.9");
		assert_eq!(terminal, ToolTerminal::Failed);
		assert!(matches!(&view, ToolViewContent::Plain(_)));
		assert!(view.as_str().contains(r#""kind":"faulted""#));
		assert!(view.as_str().contains("faulted-fact"));

		let missing = result_item("missing", None, "aborted");
		let (identity, terminal, view) = render_tool_result_view(&renderers, &missing, None);
		assert_eq!(identity.rev.n, 0);
		assert_eq!(terminal, ToolTerminal::Aborted);
		assert!(matches!(&view, ToolViewContent::Plain(_)));
		assert!(view.as_str().contains(r#""kind":"aborted""#));
		assert!(view.as_str().contains("aborted-fact"));
	}

	#[test]
	fn replay_uses_durable_revision_and_is_deterministic() {
		use omp_proto::thread::v1;

		let mut renderers = RenderRegistry::new();
		renderers
			.register(test_identity("test.1"), TestRenderer("one"))
			.expect("register revision one");
		renderers
			.register(test_identity("test.2"), TestRenderer("two"))
			.expect("register revision two");
		let items = [
			Item {
				kind: Some(item::Kind::ToolCall(v1::ToolCall {
					id: "call".to_owned(),
					name: "same".to_owned(),
					args_json: Bytes::from_static(b"{}"),
					..Default::default()
				})),
				props: Some(revision_props("test.1")),
				..Default::default()
			},
			result_item("call", Some("test.2"), "ok"),
		];
		let replay = || {
			let (tx, rx) = flume::unbounded();
			let mut tools = HashMap::new();
			let mut serial = 0;
			replay_items(&tx, &items, &mut tools, &mut serial, &renderers);
			rx.drain()
				.find_map(|event| match event {
					BackendEvent::ToolFinished { view, .. } => Some(view),
					_ => None,
				})
				.expect("replayed tool result")
		};
		let first = replay();
		let second = replay();
		assert_eq!(first, second);
		assert_eq!(first.as_str(), "<row>two::ok</row>");
		assert!(matches!(first, ToolViewContent::Markup(_)));
	}
}
