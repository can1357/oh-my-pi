//! Typed bounded channels for interactive authentication protocols.

use std::fmt;

use flume::{Receiver, Sender, TryRecvError};
use futures::{
	FutureExt,
	future::{Either, select},
};
use omp_core::sf;
use tokio_util::sync::CancellationToken;

use super::{
	lease::{CredentialLease, LeaseMeta},
	spec::AuthSpec,
};
use crate::{
	answer::{AuthEvent, AuthPrompt, AuthPromptKind, AuthResponse, AuthSession},
	call::AuthInput,
	error::Error,
	id::LoginSessionId,
};

/// Minimum legal channel capacity for a login session.
pub const MIN_LOGIN_CHANNEL_CAPACITY: usize = 1;
/// Default bounded event/input capacity for a login session.
pub const DEFAULT_LOGIN_CHANNEL_CAPACITY: usize = 8;

/// Clone-cheap cancellation capability shared by a login driver and caller.
#[derive(Clone)]
pub struct LoginCancellation {
	token: CancellationToken,
}

impl LoginCancellation {
	/// Requests cancellation without waiting for a channel slot.
	pub fn cancel(&self) {
		self.token.cancel();
	}

	/// Returns whether cancellation has been requested.
	pub fn is_cancelled(&self) -> bool {
		self.token.is_cancelled()
	}

	/// Waits until cancellation is requested.
	pub async fn cancelled(&self) {
		self.token.cancelled().await;
	}

	pub(crate) fn transport_token(&self) -> CancellationToken {
		self.token.clone()
	}

	fn new() -> Self {
		Self { token: CancellationToken::new() }
	}
}

impl fmt::Debug for LoginCancellation {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("LoginCancellation")
			.field("cancelled", &self.is_cancelled())
			.finish()
	}
}

/// Secret-isolating protocol side of an interactive login session.
pub struct LoginDriver {
	id:           LoginSessionId,
	events:       Sender<Result<AuthEvent, Error>>,
	responses:    Receiver<AuthResponse>,
	cancellation: LoginCancellation,
}

impl LoginDriver {
	/// Returns the stable session identity.
	pub fn id(&self) -> &LoginSessionId<str> {
		&self.id
	}

	/// Emits one typed event, respecting bounded-channel backpressure.
	pub async fn emit(&self, event: AuthEvent) -> Result<(), LoginChannelError> {
		self.send_event(Ok(event)).await
	}

	/// Emits a structured inference error and closes no unrelated channel.
	pub async fn emit_error(&self, error: Error) -> Result<(), LoginChannelError> {
		self.send_event(Err(error)).await
	}

	/// Receives the next typed response, rejecting cross-session input.
	pub async fn receive(&self) -> Result<AuthInput, LoginChannelError> {
		self.check_cancelled()?;
		loop {
			let response = self.responses.recv_async().fuse();
			let cancelled = self.cancellation.cancelled().fuse();
			futures::pin_mut!(response, cancelled);
			let response = match select(response, cancelled).await {
				Either::Left((response, _)) => response.map_err(|_| LoginChannelError::Closed)?,
				Either::Right(_) => return Err(LoginChannelError::Cancelled),
			};
			if response.session != self.id {
				continue;
			}
			if matches!(response.input, AuthInput::Cancel) {
				self.cancellation.cancel();
				return Err(LoginChannelError::Cancelled);
			}
			return Ok(response.input);
		}
	}

	/// Consumes a queued input without blocking, if one is available.
	pub fn try_receive(&self) -> Result<Option<AuthInput>, LoginChannelError> {
		self.check_cancelled()?;
		loop {
			match self.responses.try_recv() {
				Ok(response) if response.session == self.id => {
					if matches!(response.input, AuthInput::Cancel) {
						self.cancellation.cancel();
						return Err(LoginChannelError::Cancelled);
					}
					return Ok(Some(response.input));
				},
				Ok(_) => {},
				Err(TryRecvError::Empty) => return Ok(None),
				Err(TryRecvError::Disconnected) => return Err(LoginChannelError::Closed),
			}
		}
	}

	/// Returns a clone-cheap cancellation capability.
	pub fn cancellation(&self) -> LoginCancellation {
		self.cancellation.clone()
	}

	/// Fails immediately if cancellation was requested.
	pub fn check_cancelled(&self) -> Result<(), LoginChannelError> {
		if self.cancellation.is_cancelled() {
			Err(LoginChannelError::Cancelled)
		} else {
			Ok(())
		}
	}

	/// Waits until out-of-band cancellation is requested.
	pub async fn wait_cancelled(&self) {
		self.cancellation.cancelled().await;
	}

	async fn send_event(&self, event: Result<AuthEvent, Error>) -> Result<(), LoginChannelError> {
		self.check_cancelled()?;
		let send = self.events.send_async(event).fuse();
		let cancelled = self.cancellation.cancelled().fuse();
		futures::pin_mut!(send, cancelled);
		match select(send, cancelled).await {
			Either::Left((result, _)) => result.map_err(|_| LoginChannelError::Closed),
			Either::Right(_) => Err(LoginChannelError::Cancelled),
		}
	}
}

impl fmt::Debug for LoginDriver {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("LoginDriver")
			.field("id", &self.id)
			.field("cancelled", &self.cancellation.is_cancelled())
			.field("event_capacity", &self.events.capacity())
			.field("response_capacity", &self.responses.capacity())
			.finish()
	}
}

/// Creates the public login session, protocol driver, and out-of-band
/// cancellation handle.
///
/// Both directions are bounded. A capacity of zero is rejected rather than
/// silently creating a rendezvous channel that can deadlock an event producer.
pub fn login_channels(
	id: LoginSessionId,
	capacity: usize,
) -> Result<(AuthSession, LoginDriver, LoginCancellation), LoginChannelError> {
	if capacity < MIN_LOGIN_CHANNEL_CAPACITY {
		return Err(LoginChannelError::ZeroCapacity);
	}
	let (event_tx, event_rx) = flume::bounded(capacity);
	let (response_tx, response_rx) = flume::bounded(capacity);
	let cancellation = LoginCancellation::new();
	let session = AuthSession {
		id:           id.clone(),
		events:       event_rx,
		responses:    response_tx,
		cancellation: cancellation.clone(),
	};
	let driver = LoginDriver {
		id,
		events: event_tx,
		responses: response_rx,
		cancellation: cancellation.clone(),
	};
	Ok((session, driver, cancellation))
}

/// Creates channels with the default bounded capacity.
pub fn default_login_channels(id: LoginSessionId) -> (AuthSession, LoginDriver, LoginCancellation) {
	login_channels(id, DEFAULT_LOGIN_CHANNEL_CAPACITY).expect("default login capacity is non-zero")
}

/// Emits the typed prompt for an interactive API key or session token.
pub async fn prompt_for_secret(
	spec: &AuthSpec,
	driver: &LoginDriver,
) -> Result<(), SecretLoginError> {
	let prompt = match spec {
		AuthSpec::ApiKey { .. } => AuthPrompt {
			id:      sf!("api-key"),
			message: sf!("Enter the API key"),
			input:   AuthPromptKind::ApiKey,
		},
		AuthSpec::SessionToken(_) => AuthPrompt {
			id:      sf!("session-token"),
			message: sf!("Enter the session token"),
			input:   AuthPromptKind::SessionToken,
		},
		_ => return Err(SecretLoginError::UnsupportedSpec),
	};
	driver.emit(AuthEvent::Prompt(prompt)).await?;
	Ok(())
}

/// Converts a typed secret login response directly into an opaque lease.
pub fn complete_secret_login(
	spec: &AuthSpec,
	input: AuthInput,
	meta: LeaseMeta,
) -> Result<CredentialLease, SecretLoginError> {
	match (spec, input) {
		(AuthSpec::ApiKey { .. }, AuthInput::ApiKey(secret)) => {
			Ok(CredentialLease::api_key(meta, secret))
		},
		(AuthSpec::SessionToken(_), AuthInput::SessionToken(secret)) => {
			Ok(CredentialLease::session_token(meta, secret))
		},
		(_, AuthInput::Cancel) => Err(SecretLoginError::Cancelled),
		(AuthSpec::ApiKey { .. } | AuthSpec::SessionToken(_), _) => {
			Err(SecretLoginError::UnexpectedInput)
		},
		_ => Err(SecretLoginError::UnsupportedSpec),
	}
}

/// API-key/session-token interactive engine failure.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum SecretLoginError {
	/// Selected authentication spec is not a scalar interactive flow.
	#[error("authentication specification does not accept a scalar secret")]
	UnsupportedSpec,
	/// Caller supplied a different input kind.
	#[error("authentication login received unexpected input")]
	UnexpectedInput,
	/// Caller cancelled the login.
	#[error("authentication login was cancelled")]
	Cancelled,
	/// Typed login channels failed.
	#[error(transparent)]
	Channel(#[from] LoginChannelError),
}

/// Interactive login-channel failure without secret-bearing input detail.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum LoginChannelError {
	/// Channel capacity must be at least one.
	#[error("login channel capacity must be non-zero")]
	ZeroCapacity,
	/// Caller or protocol owner closed a channel.
	#[error("login channel is closed")]
	Closed,
	/// Caller cancelled the login session.
	#[error("login session was cancelled")]
	Cancelled,
}

#[cfg(test)]
mod tests {
	use omp_core::SecretString;

	use super::*;

	#[test]
	fn login_channels_are_bounded_and_cancellation_is_out_of_band() {
		let (session, driver, cancellation) =
			login_channels(LoginSessionId::from("login-1"), 2).expect("channels");
		assert_eq!(session.events.capacity(), Some(2));
		assert_eq!(session.responses.capacity(), Some(2));
		assert!(!driver.cancellation().is_cancelled());
		cancellation.cancel();
		assert!(matches!(driver.try_receive(), Err(LoginChannelError::Cancelled)));
	}

	#[test]
	fn submitted_secret_is_redacted_before_it_reaches_driver_debug() {
		let (session, driver, _) = default_login_channels(LoginSessionId::from("login-2"));
		let material = "authorization-secret";
		session
			.responses
			.send(AuthResponse {
				session: session.id.clone(),
				input:   AuthInput::AuthorizationCode(SecretString::from(material.to_owned())),
			})
			.expect("response");
		let input = driver.try_receive().expect("input").expect("present");
		assert!(!format!("{driver:?} {input:?}").contains(material));
	}
}
