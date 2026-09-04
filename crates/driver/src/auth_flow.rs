//! Presentation-independent provider-authentication command and event flow.

use std::sync::{
	Arc,
	atomic::{AtomicBool, Ordering},
};

use flume::Receiver;
use omp_ai::call::AuthInput;
use omp_core::Str;

/// Explanation shown when encrypted credential storage is unavailable.
pub const CREDENTIAL_STORAGE_LOCKED_MESSAGE: &str =
	"Credential storage is locked. Run interactively for owner-only local storage, or set \
	 OMP_LLM_KEY_SOURCE=os-keychain to use the OS keychain.";

/// Kind of caller response requested by an authentication provider.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AuthPromptKind {
	/// Static API key.
	ApiKey,
	/// OAuth authorization code.
	AuthorizationCode,
	/// Provider session token.
	SessionToken,
	/// Visible plain text, including an empty default selection.
	PlainText,
	/// Optional secret text for which an empty response means skip.
	OptionalSecret,
	/// Confirmation that an external device step is complete.
	Confirmation,
}

/// Secret-free progress from an asynchronous provider-login worker.
#[derive(Debug, Eq, PartialEq)]
pub enum ChatAuthEvent {
	/// Public browser authorization URL.
	Url {
		/// Full provider authorization URL.
		url:    Str,
		/// Short loopback launch URL when a callback server is available.
		launch: Option<Str>,
	},
	/// Short-lived device code and public verification URL.
	DeviceCode {
		/// Short-lived device code.
		code: Str,
		/// Public verification URL.
		url:  Str,
	},
	/// Private input requested by the provider.
	Prompt {
		/// Provider-authored prompt message.
		message: Str,
		/// Expected response kind.
		kind:    AuthPromptKind,
	},
	/// Public login instructions or waiting state.
	Notice(Str),
	/// Login completed and credentials are available to later turns.
	Complete(Str),
	/// Login could not persist credentials because no key source is available.
	CredentialStorageLocked,
	/// Login stopped with a secret-free diagnostic.
	Failed(Str),
}

/// Commands serialized into an authentication worker's single mailbox.
pub enum ChatAuthCommand {
	/// Starts a new provider flow.
	Start(Str),
	/// Answers the current private-input prompt.
	Answer(AuthInput),
	/// Cancels the active flow regardless of its current provider event.
	Cancel,
}

/// Non-blocking command and event channels for provider authentication.
#[derive(Clone)]
pub struct ChatAuth {
	commands: flume::Sender<ChatAuthCommand>,
	events:   Receiver<ChatAuthEvent>,
	active:   Arc<AtomicBool>,
}

impl ChatAuth {
	/// Creates a handle over a composition-owned authentication worker.
	pub const fn new(
		commands: flume::Sender<ChatAuthCommand>,
		events: Receiver<ChatAuthEvent>,
		active: Arc<AtomicBool>,
	) -> Self {
		Self { commands, events, active }
	}

	/// Starts one provider login unless another flow is already active.
	#[tracing::instrument(
		level = "debug",
		skip_all,
		name = "provider_auth_start",
		fields(provider = %provider)
	)]
	pub fn start(&self, provider: Str) -> Result<(), &'static str> {
		if self
			.active
			.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
			.is_err()
		{
			tracing::debug!(provider = %provider, "provider authentication start lost active-flow race");
			return Err("authentication is already in progress");
		}
		if self
			.commands
			.try_send(ChatAuthCommand::Start(provider))
			.is_err()
		{
			self.active.store(false, Ordering::Release);
			tracing::warn!("provider authentication worker unavailable");
			return Err("authentication worker is unavailable");
		}
		tracing::debug!("provider authentication admitted");
		Ok(())
	}

	/// Answers the active provider prompt without exposing its secret to events.
	pub fn answer(&self, input: AuthInput) -> Result<(), &'static str> {
		match input {
			AuthInput::Cancel => self.cancel(),
			input => self
				.commands
				.try_send(ChatAuthCommand::Answer(input))
				.map_err(|_| "authentication worker is not waiting for input"),
		}
	}

	/// Cancels the active flow even while it waits on an external provider.
	pub fn cancel(&self) -> Result<(), &'static str> {
		self
			.commands
			.try_send(ChatAuthCommand::Cancel)
			.map_err(|_| "authentication worker is unavailable")
	}

	/// Reports whether the worker currently owns a login flow.
	pub fn is_active(&self) -> bool {
		self.active.load(Ordering::Acquire)
	}

	/// Receives the next secret-free worker event.
	pub async fn next_event(&self) -> Option<ChatAuthEvent> {
		self.events.recv_async().await.ok()
	}
}

/// Returns whether an authentication prompt must suppress terminal echo.
pub const fn prompt_masks_input(kind: AuthPromptKind) -> bool {
	!matches!(kind, AuthPromptKind::Confirmation | AuthPromptKind::PlainText)
}
