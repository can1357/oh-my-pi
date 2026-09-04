use std::{mem, sync::Arc};

use futures::{FutureExt, future::BoxFuture};
use omp_catalog::provider::OAuthExchangeKind;
use omp_core::{ExposeSecret, SecretString, sf};
use zeroize::Zeroizing;

use crate::{
	answer::{AuthEvent, AuthPrompt, AuthPromptKind},
	auth::{
		LoginDriver, OAuthClock, OAuthCustomDispatchError, OAuthCustomDispatcher, OAuthCustomHandler,
		OAuthCustomSpec, OAuthError, OAuthHttpClient, OAuthTokenSet, PROVIDER_NAME_PARAMETER,
	},
	call::AuthInput,
};

struct ApiKeyPasteHandler;

impl OAuthCustomHandler for ApiKeyPasteHandler {
	fn exchange_kind(&self) -> OAuthExchangeKind {
		OAuthExchangeKind::ApiKeyPaste
	}

	fn exchange<'a>(
		&'a self,
		spec: &'a OAuthCustomSpec,
		driver: &'a LoginDriver,
	) -> BoxFuture<'a, Result<OAuthTokenSet, OAuthError>> {
		async move {
			driver
				.emit(AuthEvent::OpenUrl { url: spec.authorize_url.clone(), launch: None })
				.await?;
			// Name the selected provider when the login flow supplies one:
			// several providers mint keys from a single shared console (OpenCode
			// Zen and Go both use opencode.ai/auth), so a generic prompt would
			// not say which provider's key is being collected.
			let provider_name = spec
				.parameters
				.iter()
				.find(|parameter| parameter.name == PROVIDER_NAME_PARAMETER)
				.map(|parameter| parameter.value.as_str())
				.filter(|name| !name.is_empty());
			driver
				.emit(AuthEvent::Prompt(AuthPrompt {
					id:      sf!("oauth-api-key"),
					message: provider_name.map_or_else(
						|| sf!("Paste your API key"),
						|name| sf!("Paste your {name} API key"),
					),
					input:   AuthPromptKind::ApiKey,
				}))
				.await?;

			let input = driver.receive().await?;
			let AuthInput::ApiKey(api_key) = input else {
				return if matches!(input, AuthInput::Cancel) {
					Err(OAuthError::Cancelled)
				} else {
					Err(OAuthError::UnexpectedInput)
				};
			};
			let trimmed = api_key.expose_secret().trim();
			if trimmed.is_empty() {
				return Err(OAuthError::UnexpectedInput);
			}
			// Keep the sole trimmed copy in zeroizing storage until ownership moves
			// directly into the secret container.
			let mut material = Zeroizing::new(trimmed.to_owned());
			let access_token = SecretString::from(mem::take(&mut *material));

			Ok(OAuthTokenSet {
				access_token,
				refresh_token: None,
				token_type: sf!("Bearer"),
				expires_in: None,
				identity_response: SecretString::from("{}".to_owned()),
				project: None,
			})
		}
		.boxed()
	}
}

pub(super) fn register(
	dispatcher: &mut OAuthCustomDispatcher,
	_http: Arc<dyn OAuthHttpClient>,
	_clock: Arc<dyn OAuthClock>,
) -> Result<(), OAuthCustomDispatchError> {
	dispatcher.register(Arc::new(ApiKeyPasteHandler))
}

#[cfg(test)]
mod tests {
	use std::time::{Duration, SystemTime};

	use omp_catalog::provider::PrincipalResolution;

	use super::*;
	use crate::{
		answer::AuthResponse,
		auth::{
			HeaderPlacement, KeyPlacement, OAuthClientSpec, OAuthHttpRequest, OAuthHttpResponse,
			OAuthParameter, OAuthRefreshSpec, OAuthTransportError, default_login_channels,
		},
		id::LoginSessionId,
	};

	struct UnusedHttp;

	impl OAuthHttpClient for UnusedHttp {
		fn execute(
			&self,
			_request: OAuthHttpRequest,
		) -> BoxFuture<'_, Result<OAuthHttpResponse, OAuthTransportError>> {
			async { panic!("API-key paste must not perform HTTP requests") }.boxed()
		}
	}

	struct FixedClock;

	impl OAuthClock for FixedClock {
		fn now(&self) -> SystemTime {
			SystemTime::UNIX_EPOCH
		}

		fn sleep(&self, _duration: Duration) -> BoxFuture<'_, ()> {
			async {}.boxed()
		}
	}

	fn spec() -> OAuthCustomSpec {
		OAuthCustomSpec {
			client:        OAuthClientSpec {
				sources:      Vec::new(),
				client_id:    "api-key-paste".into(),
				refresh:      OAuthRefreshSpec::Unsupported,
				token_url:    "https://unused.example/token".into(),
				scopes:       Vec::new(),
				audience:     None,
				token_params: Vec::new(),
				placement:    KeyPlacement::Header(HeaderPlacement::bearer()),
			},
			authorize_url: "https://auth.example/keys".into(),
			exchange:      OAuthExchangeKind::ApiKeyPaste,
			parameters:    Vec::new(),
			polling:       None,
		}
	}

	fn dispatcher() -> OAuthCustomDispatcher {
		let mut dispatcher = OAuthCustomDispatcher::new();
		register(&mut dispatcher, Arc::new(UnusedHttp), Arc::new(FixedClock)).expect("register");
		dispatcher
	}

	#[tokio::test]
	async fn emits_catalog_url_and_accepts_trimmed_api_key() {
		let (session, driver, _) = default_login_channels(LoginSessionId::from("api-key-success"));
		let marker = "api-key-secret-marker";
		session
			.responses
			.send(AuthResponse {
				session: session.id.clone(),
				input:   AuthInput::ApiKey(SecretString::from(format!("  {marker}\n"))),
			})
			.expect("response");

		let tokens = dispatcher()
			.exchange(&spec(), &driver)
			.await
			.expect("exchange");
		assert_eq!(tokens.access_token.expose_secret(), marker);
		assert!(!tokens.is_refreshable());
		assert_eq!(tokens.token_type(), "Bearer");
		assert_eq!(tokens.expires_in(), None);
		let principal = tokens
			.resolve_principal(
				&PrincipalResolution::StaticLabel { label: "catalog-account".into() },
				&UnusedHttp,
			)
			.await
			.expect("static principal");
		assert_eq!(principal.as_str(), "catalog-account");

		assert!(
			matches!(session.events.recv().expect("URL").expect("event"), AuthEvent::OpenUrl { url, launch: None } if url == "https://auth.example/keys")
		);
		assert!(matches!(
			session.events.recv().expect("prompt").expect("event"),
			AuthEvent::Prompt(AuthPrompt { input: AuthPromptKind::ApiKey, .. })
		));
		assert!(!format!("{tokens:?}").contains(marker));
	}

	#[tokio::test]
	async fn prompt_names_the_selected_provider_when_supplied() {
		for (index, (parameters, expected)) in [
			(Vec::new(), "Paste your API key"),
			(
				vec![OAuthParameter {
					name:  PROVIDER_NAME_PARAMETER.into(),
					value: "OpenCode Go".into(),
				}],
				"Paste your OpenCode Go API key",
			),
			// An empty injected name falls back to the generic prompt.
			(
				vec![OAuthParameter { name: PROVIDER_NAME_PARAMETER.into(), value: "".into() }],
				"Paste your API key",
			),
		]
		.into_iter()
		.enumerate()
		{
			let mut spec = spec();
			spec.parameters = parameters;
			let (session, driver, _) =
				default_login_channels(LoginSessionId::from(format!("api-key-name-{index}")));
			session
				.responses
				.send(AuthResponse {
					session: session.id.clone(),
					input:   AuthInput::ApiKey(SecretString::from("key".to_owned())),
				})
				.expect("response");
			dispatcher()
				.exchange(&spec, &driver)
				.await
				.expect("exchange");
			let _ = session.events.recv().expect("URL").expect("event");
			let AuthEvent::Prompt(prompt) = session.events.recv().expect("prompt").expect("event")
			else {
				panic!("prompt expected")
			};
			assert_eq!(prompt.message, expected, "case {index}");
		}
	}

	#[tokio::test]
	async fn cancellation_and_unexpected_inputs_are_typed_and_secret_free() {
		for (suffix, input, expected) in [
			("cancel", AuthInput::Cancel, OAuthError::Cancelled),
			(
				"wrong-kind",
				AuthInput::AuthorizationCode(SecretString::from("wrong-secret-marker".to_owned())),
				OAuthError::UnexpectedInput,
			),
			(
				"empty",
				AuthInput::ApiKey(SecretString::from(" \t\n".to_owned())),
				OAuthError::UnexpectedInput,
			),
		] {
			let (session, driver, _) =
				default_login_channels(LoginSessionId::from(format!("api-key-{suffix}")));
			session
				.responses
				.send(AuthResponse { session: session.id.clone(), input })
				.expect("response");
			let error = dispatcher()
				.exchange(&spec(), &driver)
				.await
				.expect_err("rejected");
			let OAuthCustomDispatchError::Protocol(error) = error else {
				panic!("protocol error expected")
			};
			assert_eq!(error, expected);
			assert!(!format!("{error:?} {error}").contains("wrong-secret-marker"));
		}
	}

	#[test]
	fn secret_input_debug_is_redacted() {
		let marker = "api-key-debug-secret-marker";
		let input = AuthInput::ApiKey(SecretString::from(marker.to_owned()));
		let debug = format!("{input:?}");
		assert!(debug.contains("[REDACTED]"));
		assert!(!debug.contains(marker));
	}
}
