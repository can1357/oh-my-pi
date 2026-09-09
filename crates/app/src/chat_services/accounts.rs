//! Stored provider accounts behind `/login`, `/logout`, `/setup`, and `/pin`:
//! the live [`AuthManager`] drives every interactive login on the runtime and
//! streams what the dialog must show over the [`LoginFlow`] channels, exactly
//! like the `omp auth login` loop in [`crate::auth_cli`] but without a TTY.

use std::path::Path;

use flume::{Receiver, Sender};
use omp_ai::{
	answer::{
		AccountSummary, AuthAnswer, AuthEvent, AuthPrompt, AuthPromptKind, AuthResponse, AuthSession,
	},
	auth::{AuthControlHandle, AuthManager},
	call::{AuthInput, AuthRequest, LoginRequest},
	id::AccountId,
};
use omp_catalog::{ProviderId, provider::AuthSpecKind};
use omp_chat::overlays::services::{
	AccountRow, LoginEvent, LoginFlow, Pending, ProviderRow, ServiceError, ServiceResult,
};
use omp_core::{ExposeSecret as _, SecretString, Str, sf};

use super::{ServiceState, StackHandles};

const GATEWAY: &str = "provider accounts (remote gateway)";
const LOGIN_CANCELLED: &str = "Login cancelled";

fn stack(state: &ServiceState) -> ServiceResult<&StackHandles> {
	state
		.stack
		.as_ref()
		.ok_or(ServiceError::Unavailable(GATEWAY))
}

fn provider_name(state: &ServiceState, provider: &ProviderId<str>) -> Str {
	state
		.catalog
		.as_ref()
		.and_then(|catalog| catalog.provider(provider))
		.map_or_else(|| Str::new(provider.as_str()), |def| def.name.clone())
}

/// Every stored account, in the pool's stable account-id order.
pub fn rows(state: &ServiceState) -> ServiceResult<Vec<AccountRow>> {
	let control = &stack(state)?.auth_control;
	Ok(control
		.accounts(None)
		.into_iter()
		.map(|record| {
			let (kind, source) = match control.metadata(&record.account) {
				Ok(Some(metadata)) => (metadata.kind.clone(), sf!("stored {}", metadata.kind)),
				Ok(None) => (sf!("external"), sf!("environment or external authority")),
				Err(_) => (sf!("unknown"), sf!("credential source unavailable")),
			};
			AccountRow {
				id: record.account.as_inner().clone(),
				provider: record.provider.as_inner().clone(),
				provider_name: provider_name(state, &record.provider),
				label: record.principal.as_inner().clone(),
				detail: if record.enabled {
					source
				} else {
					sf!("{source} · disabled")
				},
				kind,
				active: record.enabled,
			}
		})
		.collect())
}

/// Catalog providers with an interactive login method, flagged with whether
/// an account is already stored.
pub fn providers(state: &ServiceState) -> ServiceResult<Vec<ProviderRow>> {
	let control = &stack(state)?.auth_control;
	let catalog = state
		.catalog
		.as_ref()
		.ok_or(ServiceError::Unavailable("provider catalog (remote gateway)"))?;
	let accounts = control.accounts(None);
	Ok(catalog
		.providers()
		.iter()
		.filter_map(|provider| {
			let mut login = false;
			let mut oauth = false;
			for id in &provider.auth {
				let Some(spec) = catalog.auth_spec(id) else {
					continue;
				};
				match spec.kind {
					AuthSpecKind::None | AuthSpecKind::Basic => {},
					AuthSpecKind::Oauth => {
						login = true;
						oauth = true;
					},
					_ => login = true,
				}
			}
			login.then(|| ProviderRow {
				id: provider.id.as_inner().clone(),
				name: provider.name.clone(),
				oauth,
				logged_in: accounts.iter().any(|record| record.provider == provider.id),
			})
		})
		.collect())
}

/// Starts an interactive login and drives it on the runtime.
pub fn login(state: &ServiceState, provider: &str) -> ServiceResult<LoginFlow> {
	let auth = stack(state)?.auth.clone();
	let provider_id = ProviderId::new(provider);
	if state
		.catalog
		.as_ref()
		.is_some_and(|catalog| catalog.provider(&provider_id).is_none())
	{
		return Err(ServiceError::Failed(sf!("Unknown OAuth provider: {provider}")));
	}
	let name = provider_name(state, &provider_id);
	let (events_tx, events) = flume::unbounded();
	let (input, input_rx) = flume::unbounded();
	let (done_tx, done) = flume::bounded(1);
	let (cancel, cancel_rx) = flume::bounded(1);
	let database = state.data_dir.join("credentials.db");
	let request = LoginRequest { provider: provider_id.clone(), method: None };
	let title = name.clone();
	state.runtime.spawn(async move {
		let driver = Driver { auth, events: events_tx, input: input_rx, cancel: cancel_rx };
		let outcome = driver.run(request, &title, &database).await;
		let _ = done_tx.send(outcome);
	});
	Ok(LoginFlow {
		provider: provider_id.into_inner(),
		provider_name: name,
		events,
		input,
		done,
		cancel,
	})
}

/// Deletes one stored account; settles once the encrypted store commits.
pub fn logout(state: &ServiceState, account: &AccountRow) -> ServiceResult<Pending<()>> {
	let control: AuthControlHandle = stack(state)?.auth_control.clone();
	let id = AccountId::new(account.id.clone());
	let (tx, rx) = flume::bounded(1);
	state.runtime.spawn(async move {
		let _ = tx.send(control.delete(id).await.map_err(ServiceError::failed));
	});
	Ok(rx)
}

/// `/pin <provider> [account]`: bind the session to one account identity.
///
/// The kernel derives session affinity from provider-side state bindings
/// only; nothing on the route consumes a user-chosen
/// `CredentialAffinityDigest`, so there is no seam to write the pin into.
pub fn pin(state: &ServiceState, _account: &AccountRow, _pinned: bool) -> ServiceResult<Str> {
	stack(state)?;
	Err(ServiceError::Unavailable(
		"session credential affinity (no consumer of CredentialAffinityDigest in the kernel route)",
	))
}

/// Journal stem of the live session (`/pin` without an argument).
pub fn live_session_id(state: &ServiceState) -> ServiceResult<Str> {
	state
		.journal
		.file_stem()
		.and_then(|stem| stem.to_str())
		.filter(|stem| !stem.is_empty() && state.journal.is_file())
		.map(Str::new)
		.ok_or_else(|| ServiceError::Failed(sf!("No active session to pin.")))
}

/// One login's channel ends, owned by the runtime task.
struct Driver {
	auth:   AuthManager,
	events: Sender<LoginEvent>,
	input:  Receiver<Str>,
	cancel: Receiver<()>,
}

impl Driver {
	async fn run(&self, request: LoginRequest, name: &str, database: &Path) -> ServiceResult<Str> {
		let started = tokio::select! {
			answer = self.auth.execute(AuthRequest::Login(request)) => answer.map_err(ServiceError::failed)?,
			_ = self.cancel.recv_async() => return Err(ServiceError::Failed(sf!(LOGIN_CANCELLED))),
		};
		let session = match started {
			AuthAnswer::Session(session) => session,
			// Extension-hosted logins complete without a session.
			AuthAnswer::Refreshed(summary) => return Ok(success(name, &summary, database)),
			AuthAnswer::Accounts(_) | AuthAnswer::LoggedOut(_) | AuthAnswer::Submitted(_) => {
				return Err(ServiceError::Failed(sf!("Login to {name} returned no session")));
			},
		};
		loop {
			let event = tokio::select! {
				event = session.events.recv_async() => event,
				_ = self.cancel.recv_async() => {
					session.cancel();
					return Err(ServiceError::Failed(sf!(LOGIN_CANCELLED)));
				},
			};
			let Ok(event) = event else {
				return Err(ServiceError::Failed(sf!("Login to {name} ended without a result")));
			};
			match event.map_err(ServiceError::failed)? {
				AuthEvent::OpenUrl { url, launch } => {
					omp_core::open::open_path(launch.as_deref().unwrap_or(url.as_str()));
					self.show(LoginEvent::OpenUrl { url, launched: true });
				},
				AuthEvent::ShowDeviceCode { code, verification_url } => {
					self.show(LoginEvent::DeviceCode {
						code: Str::new(code.expose_secret()),
						verification_url,
					});
				},
				AuthEvent::Prompt(prompt) => {
					let input = self.answer(&prompt, &session).await?;
					if session
						.responses
						.send_async(AuthResponse { session: session.id.clone(), input })
						.await
						.is_err()
					{
						return Err(ServiceError::Failed(sf!("Login to {name} ended without a result")));
					}
				},
				AuthEvent::Waiting => {
					self.show(LoginEvent::Info(sf!("Waiting for {name} authorization…")))
				},
				AuthEvent::Complete(summary) => return Ok(success(name, &summary, database)),
			}
		}
	}

	fn show(&self, event: LoginEvent) {
		let _ = self.events.send(event);
	}

	/// Shows the prompt and waits for the dialog's answer, re-prompting on
	/// input the method rejects (an empty code) until one is accepted.
	async fn answer(&self, prompt: &AuthPrompt, session: &AuthSession) -> ServiceResult<AuthInput> {
		loop {
			self.show(LoginEvent::Prompt { label: prompt.message.clone() });
			let value = tokio::select! {
				value = self.input.recv_async() => value,
				_ = self.cancel.recv_async() => {
					session.cancel();
					return Err(ServiceError::Failed(sf!(LOGIN_CANCELLED)));
				},
			};
			let Ok(value) = value else {
				session.cancel();
				return Err(ServiceError::Failed(sf!(LOGIN_CANCELLED)));
			};
			match auth_input(prompt, value.as_str().trim()) {
				Ok(input) => return Ok(input),
				Err(message) => self.show(LoginEvent::Info(Str::new_static(message))),
			}
		}
	}
}

fn success(name: &str, summary: &AccountSummary, database: &Path) -> Str {
	let who = summary
		.principal
		.as_ref()
		.map(|principal| principal.as_str())
		.or(summary.label.as_deref())
		.filter(|who| !who.is_empty())
		.map_or_else(Str::default, |who| sf!(" as {who}"));
	sf!("Successfully logged in to {name}{who} · credentials saved to {}", database.display())
}

/// Typed answer for one prompt (the `omp auth login` mapping): a pasted
/// `scheme://` value answers an authorization-code prompt as the callback
/// URL, an empty required secret is rejected, and a confirmation accepts
/// `y`/`yes`/empty.
fn auth_input(prompt: &AuthPrompt, value: &str) -> Result<AuthInput, &'static str> {
	if value.is_empty()
		&& matches!(
			prompt.input,
			AuthPromptKind::AuthorizationCode | AuthPromptKind::ApiKey | AuthPromptKind::SessionToken
		) {
		return Err("authentication input must not be empty");
	}
	Ok(match prompt.input {
		AuthPromptKind::AuthorizationCode => {
			if value.contains("://") {
				AuthInput::CallbackUrl(SecretString::from(value))
			} else {
				AuthInput::AuthorizationCode(SecretString::from(value))
			}
		},
		AuthPromptKind::ApiKey => AuthInput::ApiKey(SecretString::from(value)),
		AuthPromptKind::SessionToken => AuthInput::SessionToken(SecretString::from(value)),
		AuthPromptKind::PlainText => AuthInput::PlainText(Str::new(value)),
		AuthPromptKind::OptionalSecret => AuthInput::OptionalSecret(SecretString::from(value)),
		AuthPromptKind::Confirmation => {
			if matches!(value.to_ascii_lowercase().as_str(), "" | "y" | "yes") {
				AuthInput::DeviceConfirmed
			} else {
				AuthInput::Cancel
			}
		},
	})
}

#[cfg(test)]
mod tests {
	use super::*;

	fn prompt(input: AuthPromptKind) -> AuthPrompt {
		AuthPrompt { id: sf!("p"), message: sf!("Paste"), input }
	}

	#[test]
	fn pasted_urls_answer_code_prompts_as_callbacks_and_empty_secrets_are_rejected() {
		assert!(matches!(
			auth_input(&prompt(AuthPromptKind::AuthorizationCode), "https://x/cb?code=1"),
			Ok(AuthInput::CallbackUrl(_))
		));
		assert!(matches!(
			auth_input(&prompt(AuthPromptKind::AuthorizationCode), "abc"),
			Ok(AuthInput::AuthorizationCode(_))
		));
		assert!(auth_input(&prompt(AuthPromptKind::ApiKey), "").is_err());
		assert!(matches!(
			auth_input(&prompt(AuthPromptKind::Confirmation), "YES"),
			Ok(AuthInput::DeviceConfirmed)
		));
		assert!(matches!(
			auth_input(&prompt(AuthPromptKind::Confirmation), "n"),
			Ok(AuthInput::Cancel)
		));
		assert!(matches!(
			auth_input(&prompt(AuthPromptKind::OptionalSecret), ""),
			Ok(AuthInput::OptionalSecret(_))
		));
	}
}
