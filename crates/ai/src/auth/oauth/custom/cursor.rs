//! Cursor browser login with bounded PKCE polling.

use std::{
	fmt, mem,
	sync::Arc,
	time::{Duration, SystemTime},
};

use futures::{
	FutureExt,
	future::{BoxFuture, Either, select},
};
use http::{
	HeaderMap, HeaderValue, Method,
	header::{AUTHORIZATION, CONTENT_TYPE},
};
use omp_catalog::provider::OAuthExchangeKind;
use omp_core::{ExposeSecret, SecretString, Str, base64_url, sf};
use serde::Deserialize;
use sha2::{Digest as _, Sha256};
#[cfg(test)]
use url::Url;
use zeroize::Zeroizing;

use super::super::{
	OAuthClock, OAuthCustomDispatchError, OAuthCustomDispatcher, OAuthCustomHandler, OAuthEntropy,
	OAuthError, OAuthHttpClient, OAuthHttpRequest, OAuthHttpResponse, OAuthRefreshFuture,
	OAuthTokenSet, SystemEntropySource, parse_http_url, provider_error,
};
use crate::{
	answer::AuthEvent,
	auth::{
		login::LoginDriver,
		spec::{OAuthCustomSpec, OAuthRefreshSpec},
	},
};

const DEFAULT_MAX_POLLS: u16 = 150;
const DEFAULT_INTERVAL: Duration = Duration::from_secs(1);
const DEFAULT_MAX_INTERVAL: Duration = Duration::from_secs(10);
const BACKOFF_NUMERATOR: u32 = 6;
const BACKOFF_DENOMINATOR: u32 = 5;
const MAX_CONSECUTIVE_ERRORS: u8 = 3;
const EXPIRY_SAFETY_MARGIN: Duration = Duration::from_mins(5);
const FALLBACK_LIFETIME: Duration = Duration::from_hours(1);

/// Registers Cursor's catalog-selected polling exchange.
pub(super) fn register(
	dispatcher: &mut OAuthCustomDispatcher,
	http: Arc<dyn OAuthHttpClient>,
	clock: Arc<dyn OAuthClock>,
) -> Result<(), OAuthCustomDispatchError> {
	dispatcher.register(Arc::new(CursorHandler::with_entropy(
		http,
		clock,
		Arc::new(SystemEntropySource),
	)))
}

struct CursorHandler {
	http:    Arc<dyn OAuthHttpClient>,
	clock:   Arc<dyn OAuthClock>,
	entropy: Arc<dyn OAuthEntropy>,
}

impl CursorHandler {
	fn with_entropy(
		http: Arc<dyn OAuthHttpClient>,
		clock: Arc<dyn OAuthClock>,
		entropy: Arc<dyn OAuthEntropy>,
	) -> Self {
		Self { http, clock, entropy }
	}

	fn authorization(&self, spec: &OAuthCustomSpec) -> Result<CursorPending, OAuthError> {
		let mut random = Zeroizing::new([0_u8; 48]);
		self.entropy.fill(&mut random[..])?;

		let verifier = SecretString::from(base64_url::encode_raw(&random[..32]).into_string());
		let challenge =
			base64_url::encode_raw(&Sha256::digest(verifier.expose_secret().as_bytes())).into_string();
		let mut uuid_bytes = [0_u8; 16];
		uuid_bytes.copy_from_slice(&random[32..]);
		uuid_bytes[6] = (uuid_bytes[6] & 0x0f) | 0x40;
		uuid_bytes[8] = (uuid_bytes[8] & 0x3f) | 0x80;
		let uuid = format_uuid(uuid_bytes);

		let mut url = parse_http_url(&spec.authorize_url)?;
		{
			let mut query = url.query_pairs_mut();
			query
				.append_pair("challenge", &challenge)
				.append_pair("uuid", &uuid);
			for parameter in &spec.parameters {
				query.append_pair(&parameter.name, &parameter.value);
			}
		}

		Ok(CursorPending { verifier, uuid, authorize_url: Str::new(url.as_str()) })
	}

	async fn poll(
		&self,
		spec: &OAuthCustomSpec,
		pending: CursorPending,
		driver: &LoginDriver,
	) -> Result<OAuthTokenSet, OAuthError> {
		let (max_polls, mut interval, max_interval) = spec.polling.map_or(
			(DEFAULT_MAX_POLLS, DEFAULT_INTERVAL, DEFAULT_MAX_INTERVAL),
			|polling| {
				(
					polling.max_polls.unwrap_or(DEFAULT_MAX_POLLS),
					polling.default_interval,
					polling.max_interval,
				)
			},
		);
		let mut consecutive_errors = 0_u8;
		let mut polls = 0_u16;

		while polls < max_polls {
			driver.check_cancelled()?;
			if driver.try_receive()?.is_some() {
				return Err(OAuthError::UnexpectedInput);
			}
			driver.emit(AuthEvent::Waiting).await?;
			let sleep = self.clock.sleep(interval).fuse();
			let cancelled = driver.wait_cancelled().fuse();
			futures::pin_mut!(sleep, cancelled);
			if matches!(select(sleep, cancelled).await, Either::Right(_)) {
				return Err(OAuthError::Cancelled);
			}
			driver.check_cancelled()?;
			polls = polls.saturating_add(1);

			let mut poll_url = parse_http_url(&spec.client.token_url)?;
			poll_url
				.query_pairs_mut()
				.append_pair("uuid", &pending.uuid)
				.append_pair("verifier", pending.verifier.expose_secret());
			let request =
				OAuthHttpRequest::new(Method::GET, poll_url.as_str(), HeaderMap::new(), None)?;
			let response = match self.http.execute(request).await {
				Ok(response) => response,
				Err(error) => {
					consecutive_errors = consecutive_errors.saturating_add(1);
					if consecutive_errors >= MAX_CONSECUTIVE_ERRORS {
						return Err(error.into());
					}
					continue;
				},
			};

			if response.status == 404 {
				consecutive_errors = 0;
				interval = backoff(interval, max_interval);
				continue;
			}

			let result = if (200..300).contains(&response.status) {
				cursor_token_response(response, self.clock.now(), None)
			} else {
				Err(provider_error(response.status, &response.body, false))
			};
			match result {
				Ok(tokens) => return Ok(tokens),
				Err(error) => {
					consecutive_errors = consecutive_errors.saturating_add(1);
					if consecutive_errors >= MAX_CONSECUTIVE_ERRORS {
						return Err(error);
					}
				},
			}
		}

		Err(OAuthError::PollingExhausted { polls })
	}
}

impl OAuthCustomHandler for CursorHandler {
	fn exchange_kind(&self) -> OAuthExchangeKind {
		OAuthExchangeKind::CursorPoll
	}

	fn exchange<'a>(
		&'a self,
		spec: &'a OAuthCustomSpec,
		driver: &'a LoginDriver,
	) -> BoxFuture<'a, Result<OAuthTokenSet, OAuthError>> {
		async move {
			let pending = self.authorization(spec)?;
			driver
				.emit(AuthEvent::OpenUrl { url: pending.authorize_url.clone(), launch: None })
				.await?;
			self.poll(spec, pending, driver).await
		}
		.boxed()
	}

	fn refresh<'a>(
		&'a self,
		spec: &'a OAuthCustomSpec,
		refresh_token: SecretString,
	) -> OAuthRefreshFuture<'a> {
		Either::Right(
			async move {
				let OAuthRefreshSpec::Endpoint { url, .. } = &spec.client.refresh else {
					return Err(OAuthError::RefreshUnsupported);
				};
				let mut bearer = Zeroizing::new(String::with_capacity(
					"Bearer ".len() + refresh_token.expose_secret().len(),
				));
				bearer.push_str("Bearer ");
				bearer.push_str(refresh_token.expose_secret());
				let mut headers = HeaderMap::new();
				headers.insert(
					AUTHORIZATION,
					HeaderValue::from_bytes(bearer.as_bytes())
						.map_err(|_| OAuthError::MalformedResponse)?,
				);
				headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
				let response = self
					.http
					.execute(OAuthHttpRequest::new(
						Method::POST,
						url,
						headers,
						Some(SecretString::from("{}".to_owned())),
					)?)
					.await?;
				if !(200..300).contains(&response.status) {
					return Err(provider_error(response.status, &response.body, true));
				}
				cursor_token_response(response, self.clock.now(), Some(refresh_token))
			}
			.boxed(),
		)
	}
}

impl fmt::Debug for CursorHandler {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter.write_str("CursorHandler([REDACTED])")
	}
}

struct CursorPending {
	verifier:      SecretString,
	uuid:          String,
	authorize_url: Str,
}

impl fmt::Debug for CursorPending {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("CursorPending")
			.field("verifier", &"[REDACTED]")
			.field("uuid", &"[REDACTED]")
			.field("authorize_url", &"[REDACTED]")
			.finish()
	}
}

#[derive(Deserialize)]
struct CursorTokenResponse<'a> {
	#[serde(borrow, rename = "accessToken")]
	access_token:  &'a str,
	#[serde(borrow, default, rename = "refreshToken")]
	refresh_token: &'a str,
}

#[derive(Deserialize)]
struct JwtExpiry {
	exp: Option<f64>,
}

fn cursor_token_response(
	response: OAuthHttpResponse,
	now: SystemTime,
	fallback_refresh: Option<SecretString>,
) -> Result<OAuthTokenSet, OAuthError> {
	let (access_token, refresh_token) = {
		let parsed: CursorTokenResponse<'_> = serde_json::from_str(response.body.expose_secret())
			.map_err(|_| OAuthError::MalformedResponse)?;
		if parsed.access_token.is_empty() {
			return Err(OAuthError::MalformedResponse);
		}
		let mut access = Zeroizing::new(parsed.access_token.to_owned());
		let refresh = if parsed.refresh_token.is_empty() {
			fallback_refresh.ok_or(OAuthError::MalformedResponse)?
		} else {
			let mut refresh = Zeroizing::new(parsed.refresh_token.to_owned());
			SecretString::from(mem::take(&mut *refresh))
		};
		(SecretString::from(mem::take(&mut *access)), refresh)
	};
	let expires_in = Some(cursor_token_lifetime(access_token.expose_secret(), now));
	Ok(OAuthTokenSet {
		access_token,
		refresh_token: Some(refresh_token),
		token_type: sf!("Bearer"),
		expires_in,
		identity_response: response.body,
		project: None,
	})
}

fn cursor_token_lifetime(token: &str, now: SystemTime) -> Duration {
	let expiry = cursor_token_expiry(token);
	match expiry {
		Some(expiry) => expiry.duration_since(now).unwrap_or(Duration::ZERO),
		None => FALLBACK_LIFETIME,
	}
}

fn cursor_token_expiry(token: &str) -> Option<SystemTime> {
	let mut parts = token.split('.');
	let _header = parts.next()?;
	let payload = parts.next()?;
	let _signature = parts.next()?;
	if parts.next().is_some() {
		return None;
	}
	let decoded = Zeroizing::new(base64_url::decode_raw(payload.as_bytes()).into_vec().ok()?);
	let claims: JwtExpiry = serde_json::from_slice(&decoded).ok()?;
	let seconds = claims
		.exp
		.filter(|value| value.is_finite() && *value >= 0.0)?;
	let lifetime = Duration::try_from_secs_f64(seconds).ok()?;
	let expiry = SystemTime::UNIX_EPOCH.checked_add(lifetime)?;
	Some(
		expiry
			.checked_sub(EXPIRY_SAFETY_MARGIN)
			.unwrap_or(SystemTime::UNIX_EPOCH),
	)
}

fn backoff(interval: Duration, maximum: Duration) -> Duration {
	interval
		.checked_mul(BACKOFF_NUMERATOR)
		.and_then(|scaled| scaled.checked_div(BACKOFF_DENOMINATOR))
		.unwrap_or(maximum)
		.min(maximum)
}

fn format_uuid(bytes: [u8; 16]) -> String {
	format!(
		"{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:\
		 02x}{:02x}",
		bytes[0],
		bytes[1],
		bytes[2],
		bytes[3],
		bytes[4],
		bytes[5],
		bytes[6],
		bytes[7],
		bytes[8],
		bytes[9],
		bytes[10],
		bytes[11],
		bytes[12],
		bytes[13],
		bytes[14],
		bytes[15]
	)
}

#[cfg(test)]
mod tests {
	use std::{collections::VecDeque, sync::Arc};

	use futures::FutureExt;
	use omp_core::ExposeSecret;
	use parking_lot::Mutex;

	use super::{
		super::super::{OAuthClientSpec, OAuthTransportError},
		*,
	};
	use crate::{
		auth::{
			CredentialSourceSpec, OAuthParameter, OAuthPollingSpec, OAuthRefreshSpec,
			login::default_login_channels, spec::HeaderPlacement,
		},
		id::LoginSessionId,
	};

	struct FixedEntropy;

	impl OAuthEntropy for FixedEntropy {
		fn fill(&self, destination: &mut [u8]) -> Result<(), OAuthError> {
			for (index, byte) in destination.iter_mut().enumerate() {
				*byte = u8::try_from(index).expect("fixture fits in one byte");
			}
			Ok(())
		}
	}

	struct TestClock {
		now:    SystemTime,
		sleeps: Mutex<Vec<Duration>>,
	}

	impl OAuthClock for TestClock {
		fn now(&self) -> SystemTime {
			self.now
		}

		fn sleep(&self, duration: Duration) -> BoxFuture<'_, ()> {
			self.sleeps.lock().push(duration);
			async {}.boxed()
		}
	}

	enum HttpStep {
		Response(u16, String),
		Transport,
	}

	struct ScriptedHttp {
		steps:    Mutex<VecDeque<HttpStep>>,
		requests: Mutex<Vec<(Method, String)>>,
	}

	impl OAuthHttpClient for ScriptedHttp {
		fn execute(
			&self,
			request: OAuthHttpRequest,
		) -> BoxFuture<'_, Result<OAuthHttpResponse, OAuthTransportError>> {
			let (method, url, ..) = request.into_parts();
			self.requests.lock().push((method, url.to_string()));
			let step = self
				.steps
				.lock()
				.pop_front()
				.expect("scripted HTTP response");
			async move {
				match step {
					HttpStep::Response(status, body) => Ok(OAuthHttpResponse {
						status,
						headers: HeaderMap::new(),
						body: SecretString::from(body),
					}),
					HttpStep::Transport => Err(OAuthTransportError),
				}
			}
			.boxed()
		}
	}

	fn client() -> OAuthClientSpec {
		OAuthClientSpec {
			sources:      vec![CredentialSourceSpec::Interactive],
			client_id:    "".into(),
			refresh:      OAuthRefreshSpec::Unsupported,
			token_url:    "https://api.example/auth/poll".into(),
			scopes:       Vec::new(),
			audience:     None,
			token_params: Vec::new(),
			placement:    HeaderPlacement::bearer().into(),
		}
	}

	fn spec(polling: Option<OAuthPollingSpec>) -> OAuthCustomSpec {
		OAuthCustomSpec {
			client: client(),
			authorize_url: "https://cursor.example/loginDeepControl".into(),
			exchange: OAuthExchangeKind::CursorPoll,
			parameters: vec![
				OAuthParameter { name: "mode".into(), value: "login".into() },
				OAuthParameter { name: "redirectTarget".into(), value: "cli".into() },
				OAuthParameter { name: "extra".into(), value: "space value".into() },
			],
			polling,
		}
	}

	fn handler(http: Arc<ScriptedHttp>, clock: Arc<TestClock>) -> CursorHandler {
		CursorHandler::with_entropy(http, clock, Arc::new(FixedEntropy))
	}

	fn jwt(exp: u64) -> String {
		let payload = base64_url::encode_raw(format!(r#"{{"exp":{exp}}}"#).as_bytes()).into_string();
		format!("header.{payload}.signature")
	}

	#[tokio::test]
	async fn wires_authorization_and_poll_queries_and_preserves_secret_identity() {
		let access = jwt(7_200);
		let identity = format!(r#"{{"accessToken":"{access}","refreshToken":"refresh-secret"}}"#);
		let http = Arc::new(ScriptedHttp {
			steps:    Mutex::new(VecDeque::from([
				HttpStep::Response(500, "first-error".into()),
				HttpStep::Response(502, "second-error".into()),
				HttpStep::Response(404, "pending-secret".into()),
				HttpStep::Response(500, "third-error".into()),
				HttpStep::Response(502, "fourth-error".into()),
				HttpStep::Response(200, identity.clone()),
			])),
			requests: Mutex::new(Vec::new()),
		});
		let clock =
			Arc::new(TestClock { now: SystemTime::UNIX_EPOCH, sleeps: Mutex::new(Vec::new()) });
		let (session, driver, _) = default_login_channels(LoginSessionId::from("cursor-wire"));

		let tokens = handler(Arc::clone(&http), Arc::clone(&clock))
			.exchange(&spec(None), &driver)
			.await
			.expect("Cursor login");

		let AuthEvent::OpenUrl { url: authorize_url, launch: None } = session
			.events
			.recv_async()
			.await
			.expect("event")
			.expect("open URL")
		else {
			panic!("expected authorization URL")
		};
		let authorize_url = Url::parse(&authorize_url).expect("valid authorization URL");
		let query = authorize_url.query_pairs().collect::<Vec<_>>();
		let verifier = base64_url::encode_raw(&(0_u8..32).collect::<Vec<_>>()).into_string();
		let challenge = base64_url::encode_raw(&Sha256::digest(verifier.as_bytes())).into_string();
		assert_eq!(query, vec![
			("challenge".into(), challenge.into()),
			("uuid".into(), "20212223-2425-4627-a829-2a2b2c2d2e2f".into()),
			("mode".into(), "login".into()),
			("redirectTarget".into(), "cli".into()),
			("extra".into(), "space value".into()),
		]);

		let requests = http.requests.lock();
		assert_eq!(requests.len(), 6);
		for (method, request_url) in requests.iter() {
			assert_eq!(*method, Method::GET);
			let request_url = Url::parse(request_url).expect("poll URL");
			assert_eq!(request_url.path(), "/auth/poll");
			assert_eq!(request_url.query_pairs().collect::<Vec<_>>(), vec![
				("uuid".into(), "20212223-2425-4627-a829-2a2b2c2d2e2f".into()),
				("verifier".into(), verifier.clone().into()),
			]);
		}
		assert_eq!(*clock.sleeps.lock(), vec![
			Duration::from_secs(1),
			Duration::from_secs(1),
			Duration::from_secs(1),
			Duration::from_millis(1_200),
			Duration::from_millis(1_200),
			Duration::from_millis(1_200),
		]);
		assert_eq!(tokens.access_token.expose_secret(), access.as_str());
		assert_eq!(
			tokens
				.refresh_token
				.as_ref()
				.expect("refresh")
				.expose_secret(),
			"refresh-secret"
		);
		assert_eq!(tokens.expires_in(), Some(Duration::from_hours(1) + Duration::from_mins(55)));
		assert_eq!(tokens.identity_response.expose_secret(), identity.as_str());
		let debug = format!("{tokens:?}");
		assert!(!debug.contains(&access));
		assert!(!debug.contains("refresh-secret"));
		assert!(!debug.contains(&identity));
	}

	#[tokio::test]
	async fn catalog_polling_bounds_drive_backoff_and_exhaustion() {
		let http = Arc::new(ScriptedHttp {
			steps:    Mutex::new(VecDeque::from([
				HttpStep::Response(404, "first".into()),
				HttpStep::Response(404, "second".into()),
			])),
			requests: Mutex::new(Vec::new()),
		});
		let clock =
			Arc::new(TestClock { now: SystemTime::UNIX_EPOCH, sleeps: Mutex::new(Vec::new()) });
		let (_session, driver, _) = default_login_channels(LoginSessionId::from("cursor-bound"));
		let polling = OAuthPollingSpec {
			max_polls:        Some(2),
			default_interval: Duration::from_secs(2),
			max_interval:     Duration::from_millis(2_200),
		};

		let error = handler(http, Arc::clone(&clock))
			.exchange(&spec(Some(polling)), &driver)
			.await
			.expect_err("polling bound");
		assert_eq!(error, OAuthError::PollingExhausted { polls: 2 });
		assert_eq!(*clock.sleeps.lock(), vec![Duration::from_secs(2), Duration::from_millis(2_200)]);
	}

	#[tokio::test]
	async fn aborts_after_three_consecutive_errors_without_exposing_response_text() {
		let http = Arc::new(ScriptedHttp {
			steps:    Mutex::new(VecDeque::from([
				HttpStep::Transport,
				HttpStep::Response(500, r#"{"error":"server_error","detail":"first-secret"}"#.into()),
				HttpStep::Response(502, "last-secret".into()),
			])),
			requests: Mutex::new(Vec::new()),
		});
		let clock =
			Arc::new(TestClock { now: SystemTime::UNIX_EPOCH, sleeps: Mutex::new(Vec::new()) });
		let (_session, driver, _) = default_login_channels(LoginSessionId::from("cursor-errors"));

		let error = handler(http, clock)
			.exchange(&spec(None), &driver)
			.await
			.expect_err("three errors");
		assert!(matches!(error, OAuthError::Provider { status: 502, .. }));
		let debug = format!("{error:?}");
		assert!(!debug.contains("first-secret"));
		assert!(!debug.contains("last-secret"));
	}

	#[tokio::test]
	async fn cancellation_interrupts_sleep_before_an_http_request() {
		struct BlockingClock;
		impl OAuthClock for BlockingClock {
			fn now(&self) -> SystemTime {
				SystemTime::UNIX_EPOCH
			}

			fn sleep(&self, _: Duration) -> BoxFuture<'_, ()> {
				futures::future::pending().boxed()
			}
		}

		let http = Arc::new(ScriptedHttp {
			steps:    Mutex::new(VecDeque::new()),
			requests: Mutex::new(Vec::new()),
		});
		let http_client: Arc<dyn OAuthHttpClient> = http.clone();
		let handler =
			CursorHandler::with_entropy(http_client, Arc::new(BlockingClock), Arc::new(FixedEntropy));
		let (session, driver, cancellation) =
			default_login_channels(LoginSessionId::from("cursor-cancel"));
		let task_spec = spec(None);
		let task = tokio::spawn(async move { handler.exchange(&task_spec, &driver).await });
		let _ = session
			.events
			.recv_async()
			.await
			.expect("open event")
			.expect("open URL");
		let waiting = session
			.events
			.recv_async()
			.await
			.expect("waiting event")
			.expect("waiting");
		assert!(matches!(waiting, AuthEvent::Waiting));
		cancellation.cancel();

		let error = task.await.expect("join").expect_err("cancelled");
		assert_eq!(error, OAuthError::Cancelled);
		assert!(http.requests.lock().is_empty());
	}

	#[test]
	fn malformed_jwt_uses_upstream_one_hour_fallback() {
		assert_eq!(
			cursor_token_lifetime("not-a-jwt", SystemTime::UNIX_EPOCH),
			Duration::from_secs(3_600)
		);
	}
}
