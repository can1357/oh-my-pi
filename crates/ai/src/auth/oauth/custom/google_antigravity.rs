use std::{
	mem,
	sync::Arc,
	time::{Duration, SystemTime},
};

use futures::{
	FutureExt,
	future::{BoxFuture, Either},
};
use http::{
	HeaderMap, HeaderValue, Method,
	header::{AUTHORIZATION, CONTENT_TYPE, USER_AGENT},
};
use omp_catalog::provider::OAuthExchangeKind;
use omp_core::{ExposeSecret, SecretString};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use super::super::{
	OAuthClock, OAuthCustomDispatchError, OAuthCustomDispatcher, OAuthCustomHandler, OAuthEngine,
	OAuthError, OAuthHttpClient, OAuthHttpRequest, OAuthHttpResponse, OAuthPkceSpec,
	OAuthRefreshFuture, OAuthTokenSet, PkceCompletion,
};
use crate::{
	auth::{login::LoginDriver, spec::OAuthCustomSpec},
	codec::google_cca::AntigravityFingerprint,
	id::ProjectId,
};

const REDIRECT_URI_PARAMETER: &str = "redirect_uri";
const ENDPOINT: &str = "https://daily-cloudcode-pa.googleapis.com";
const GEMINI_CLI_ENDPOINT: &str = "https://cloudcode-pa.googleapis.com";
const FREE_TIER_ID: &str = "free-tier";
const ONBOARD_TIMEOUT: Duration = Duration::from_secs(30);
const ONBOARD_POLL_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Clone, Copy)]
enum CloudCodeProfile {
	Antigravity,
	GeminiCli,
}

impl CloudCodeProfile {
	const fn exchange_kind(self) -> OAuthExchangeKind {
		match self {
			Self::Antigravity => OAuthExchangeKind::GoogleAntigravity,
			Self::GeminiCli => OAuthExchangeKind::GoogleGeminiCli,
		}
	}

	const fn endpoint(self) -> &'static str {
		match self {
			Self::Antigravity => ENDPOINT,
			Self::GeminiCli => GEMINI_CLI_ENDPOINT,
		}
	}

	const fn metadata(self) -> &'static Metadata {
		match self {
			Self::Antigravity => &ANTIGRAVITY_METADATA,
			Self::GeminiCli => &GEMINI_CLI_METADATA,
		}
	}
}

struct GoogleAntigravityHandler {
	http:    Arc<dyn OAuthHttpClient>,
	clock:   Arc<dyn OAuthClock>,
	profile: CloudCodeProfile,
}

impl OAuthCustomHandler for GoogleAntigravityHandler {
	fn exchange_kind(&self) -> OAuthExchangeKind {
		self.profile.exchange_kind()
	}

	fn exchange<'a>(
		&'a self,
		spec: &'a OAuthCustomSpec,
		driver: &'a LoginDriver,
	) -> BoxFuture<'a, Result<OAuthTokenSet, OAuthError>> {
		async move {
			let pkce = pkce_spec(spec)?;
			let engine = OAuthEngine::new(self.http.as_ref(), self.clock.as_ref());
			let mut pending = engine.begin_pkce(&pkce, driver).await?;
			let input = engine.receive_pkce_input(&mut pending, driver).await?;
			let mut tokens = engine.complete_pkce(&pkce, pending, input).await?;
			let project = discover_project(
				self.http.as_ref(),
				self.clock.as_ref(),
				&tokens.access_token,
				self.profile,
			)
			.await?;
			tokens.set_project(project);
			Ok(tokens)
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
				OAuthEngine::new(self.http.as_ref(), self.clock.as_ref())
					.refresh(&spec.client, refresh_token)
					.await
			}
			.boxed(),
		)
	}
}

pub(super) fn register(
	dispatcher: &mut OAuthCustomDispatcher,
	http: Arc<dyn OAuthHttpClient>,
	clock: Arc<dyn OAuthClock>,
) -> Result<(), OAuthCustomDispatchError> {
	dispatcher.register(Arc::new(GoogleAntigravityHandler {
		http:    Arc::clone(&http),
		clock:   Arc::clone(&clock),
		profile: CloudCodeProfile::Antigravity,
	}))?;
	dispatcher.register(Arc::new(GoogleAntigravityHandler {
		http,
		clock,
		profile: CloudCodeProfile::GeminiCli,
	}))
}

fn pkce_spec(spec: &OAuthCustomSpec) -> Result<OAuthPkceSpec, OAuthError> {
	let redirect_uri = spec
		.parameters
		.iter()
		.find(|parameter| parameter.name == REDIRECT_URI_PARAMETER)
		.map(|parameter| parameter.value.clone())
		.filter(|value| !value.is_empty())
		.ok_or(OAuthError::InvalidUrl)?;
	let authorize_params = spec
		.parameters
		.iter()
		.filter(|parameter| parameter.name != REDIRECT_URI_PARAMETER)
		.cloned()
		.collect();
	Ok(OAuthPkceSpec {
		client: spec.client.clone(),
		authorize_url: spec.authorize_url.clone(),
		redirect_uri,
		completion: PkceCompletion::PasteCallbackUrl,
		authorize_params,
	})
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Metadata {
	ide_type:    &'static str,
	#[serde(skip_serializing_if = "Option::is_none")]
	platform:    Option<&'static str>,
	#[serde(skip_serializing_if = "Option::is_none")]
	plugin_type: Option<&'static str>,
}

const ANTIGRAVITY_METADATA: Metadata =
	Metadata { ide_type: "ANTIGRAVITY", platform: None, plugin_type: None };
const GEMINI_CLI_METADATA: Metadata = Metadata {
	ide_type:    "IDE_UNSPECIFIED",
	platform:    Some("PLATFORM_UNSPECIFIED"),
	plugin_type: Some("GEMINI"),
};

#[derive(Serialize)]
struct LoadRequest<'a> {
	metadata: &'a Metadata,
	#[serde(rename = "cloudaicompanionProject", skip_serializing_if = "Option::is_none")]
	project:  Option<&'a str>,
}

#[derive(Deserialize)]
struct Tier {
	id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IneligibleTier {
	tier_id:        Option<String>,
	reason_message: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoadResponse {
	current_tier:             Option<Tier>,
	paid_tier:                Option<Tier>,
	#[serde(default)]
	allowed_tiers:            Vec<Tier>,
	#[serde(default)]
	ineligible_tiers:         Vec<IneligibleTier>,
	cloudaicompanion_project: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OnboardRequest<'a> {
	tier_id:  &'static str,
	metadata: &'a Metadata,
}

#[derive(Deserialize)]
struct OperationFailure {
	code: Option<i64>,
}

#[derive(Deserialize)]
struct OnboardResponse {}

#[derive(Deserialize)]
struct OnboardOperation {
	name:     Option<String>,
	#[serde(default)]
	done:     bool,
	error:    Option<OperationFailure>,
	response: Option<OnboardResponse>,
}

async fn discover_project(
	http: &dyn OAuthHttpClient,
	clock: &dyn OAuthClock,
	access_token: &SecretString,
	profile: CloudCodeProfile,
) -> Result<ProjectId, OAuthError> {
	let initial = load_code_assist(http, access_token, None, profile).await?;
	if !free_tier_allowed(&initial)
		&& initial.ineligible_tiers.iter().any(|tier| {
			tier.tier_id.as_deref() == Some(FREE_TIER_ID)
				&& tier
					.reason_message
					.as_deref()
					.is_some_and(|message| !message.is_empty())
		}) {
		return Err(OAuthError::ProvisioningIneligible);
	}
	if initial.current_tier.is_none() {
		onboard_user(http, clock, access_token, profile).await?;
	}
	let refreshed = load_code_assist(http, access_token, None, profile).await?;
	project_id(&refreshed).ok_or(OAuthError::MalformedResponse)
}

async fn load_code_assist(
	http: &dyn OAuthHttpClient,
	access_token: &SecretString,
	project: Option<&str>,
	profile: CloudCodeProfile,
) -> Result<LoadResponse, OAuthError> {
	let endpoint = profile.endpoint();
	let url = format!("{endpoint}/v1internal:loadCodeAssist");
	let mut response: LoadResponse = request_json(
		http,
		cloud_code_request(
			Method::POST,
			&url,
			access_token,
			Some(json_body(&LoadRequest { metadata: profile.metadata(), project })?),
		)?,
	)
	.await?;
	if response.paid_tier.is_none()
		&& let Some(project) = project_id(&response)
	{
		response = request_json(
			http,
			cloud_code_request(
				Method::POST,
				&url,
				access_token,
				Some(json_body(&LoadRequest {
					metadata: profile.metadata(),
					project:  Some(project.as_str()),
				})?),
			)?,
		)
		.await?;
	}
	Ok(response)
}

fn free_tier_allowed(response: &LoadResponse) -> bool {
	response
		.allowed_tiers
		.iter()
		.any(|tier| tier.id.as_deref() == Some(FREE_TIER_ID))
}

fn project_id(response: &LoadResponse) -> Option<ProjectId> {
	response
		.cloudaicompanion_project
		.as_deref()
		.filter(|project| !project.is_empty())
		.map(ProjectId::new)
}

async fn onboard_user(
	http: &dyn OAuthHttpClient,
	clock: &dyn OAuthClock,
	access_token: &SecretString,
	profile: CloudCodeProfile,
) -> Result<(), OAuthError> {
	let deadline = clock
		.now()
		.checked_add(ONBOARD_TIMEOUT)
		.ok_or(OAuthError::ProvisioningTimeout)?;
	let mut operation: OnboardOperation = request_json_until(
		http,
		clock,
		cloud_code_request(
			Method::POST,
			&format!("{}/v1internal:onboardUser", profile.endpoint()),
			access_token,
			Some(json_body(&OnboardRequest { tier_id: FREE_TIER_ID, metadata: profile.metadata() })?),
		)?,
		deadline,
	)
	.await?;
	loop {
		if operation.done {
			if let Some(error) = operation.error {
				return Err(OAuthError::ProvisioningFailed { code: error.code });
			}
			return operation
				.response
				.map(|_| ())
				.ok_or(OAuthError::MalformedResponse);
		}
		let operation_name = operation
			.name
			.as_deref()
			.filter(|name| !name.is_empty())
			.ok_or(OAuthError::MalformedResponse)?;
		let remaining = remaining(deadline, clock.now())?;
		clock.sleep(ONBOARD_POLL_INTERVAL.min(remaining)).await;
		let operation_url = format!("{}/v1internal/{operation_name}", profile.endpoint());
		operation = request_json_until(
			http,
			clock,
			cloud_code_request(Method::GET, &operation_url, access_token, None)?,
			deadline,
		)
		.await?;
	}
}

fn remaining(deadline: SystemTime, now: SystemTime) -> Result<Duration, OAuthError> {
	deadline
		.duration_since(now)
		.ok()
		.filter(|remaining| !remaining.is_zero())
		.ok_or(OAuthError::ProvisioningTimeout)
}

async fn request_json<T: for<'de> Deserialize<'de>>(
	http: &dyn OAuthHttpClient,
	request: OAuthHttpRequest,
) -> Result<T, OAuthError> {
	let response = http.execute(request).await?;
	decode_response(response)
}

async fn request_json_until<T: for<'de> Deserialize<'de>>(
	http: &dyn OAuthHttpClient,
	clock: &dyn OAuthClock,
	request: OAuthHttpRequest,
	deadline: SystemTime,
) -> Result<T, OAuthError> {
	let timeout = clock.sleep(remaining(deadline, clock.now())?);
	tokio::pin!(timeout);
	let execute = http.execute(request);
	tokio::pin!(execute);
	let response = tokio::select! {
		biased;
		response = &mut execute => response?,
		() = &mut timeout => return Err(OAuthError::ProvisioningTimeout),
	};
	decode_response(response)
}

fn decode_response<T: for<'de> Deserialize<'de>>(
	response: OAuthHttpResponse,
) -> Result<T, OAuthError> {
	if response.status != 200 {
		return Err(OAuthError::ProvisioningRejected { status: response.status });
	}
	serde_json::from_str(response.body.expose_secret()).map_err(|_| OAuthError::MalformedResponse)
}

fn cloud_code_request(
	method: Method,
	url: &str,
	access_token: &SecretString,
	body: Option<SecretString>,
) -> Result<OAuthHttpRequest, OAuthError> {
	let mut headers = HeaderMap::new();
	let mut authorization =
		Zeroizing::new(String::with_capacity(access_token.expose_secret().len() + "Bearer ".len()));
	authorization.push_str("Bearer ");
	authorization.push_str(access_token.expose_secret());
	let mut value =
		HeaderValue::from_str(&authorization).map_err(|_| OAuthError::MalformedResponse)?;
	value.set_sensitive(true);
	headers.insert(AUTHORIZATION, value);
	headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
	let user_agent = AntigravityFingerprint::default().user_agent();
	headers.insert(
		USER_AGENT,
		HeaderValue::from_str(&user_agent).map_err(|_| OAuthError::MalformedResponse)?,
	);
	OAuthHttpRequest::new(method, url, headers, body).map_err(Into::into)
}

fn json_body<T: Serialize>(value: &T) -> Result<SecretString, OAuthError> {
	let mut body =
		Zeroizing::new(serde_json::to_string(value).map_err(|_| OAuthError::MalformedResponse)?);
	Ok(SecretString::from(mem::take(&mut *body)))
}

#[cfg(test)]
mod tests {
	use std::{collections::VecDeque, sync::Arc};

	const LOAD_CODE_ASSIST_URL: &str =
		"https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
	const ONBOARD_USER_URL: &str =
		"https://daily-cloudcode-pa.googleapis.com/v1internal:onboardUser";

	use futures::FutureExt;
	use parking_lot::Mutex;
	use url::Url;

	use super::*;
	use crate::{
		answer::{AuthEvent, AuthResponse},
		auth::{
			HeaderPlacement, KeyPlacement, OAuthClientSpec, OAuthParameter, OAuthRefreshSpec,
			OAuthTransportError, default_login_channels,
		},
		call::AuthInput,
		id::LoginSessionId,
	};

	struct RecordedRequest {
		method:  Method,
		url:     String,
		headers: HeaderMap,
		body:    Option<SecretString>,
	}

	struct ScriptedHttp {
		responses: Mutex<VecDeque<OAuthHttpResponse>>,
		requests:  Mutex<Vec<RecordedRequest>>,
	}

	impl ScriptedHttp {
		fn new(bodies: &[&str]) -> Self {
			Self {
				responses: Mutex::new(
					bodies
						.iter()
						.map(|body| OAuthHttpResponse {
							status:  200,
							headers: HeaderMap::new(),
							body:    SecretString::from((*body).to_owned()),
						})
						.collect(),
				),
				requests:  Mutex::new(Vec::new()),
			}
		}
	}

	impl OAuthHttpClient for ScriptedHttp {
		fn execute(
			&self,
			request: OAuthHttpRequest,
		) -> BoxFuture<'_, Result<OAuthHttpResponse, OAuthTransportError>> {
			let (method, url, headers, body) = request.into_parts();
			self
				.requests
				.lock()
				.push(RecordedRequest { method, url: url.to_string(), headers, body });
			let response = self
				.responses
				.lock()
				.pop_front()
				.expect("scripted response");
			async move { Ok(response) }.boxed()
		}
	}

	struct AdvancingClock(Mutex<SystemTime>);

	impl OAuthClock for AdvancingClock {
		fn now(&self) -> SystemTime {
			*self.0.lock()
		}

		fn sleep(&self, duration: Duration) -> BoxFuture<'_, ()> {
			async move {
				let mut now = self.0.lock();
				*now = now.checked_add(duration).expect("representable test time");
			}
			.boxed()
		}
	}

	fn body(request: &RecordedRequest) -> serde_json::Value {
		serde_json::from_str(request.body.as_ref().expect("JSON body").expose_secret())
			.expect("valid request JSON")
	}

	fn spec() -> OAuthCustomSpec {
		OAuthCustomSpec {
			client:        OAuthClientSpec {
				sources:      Vec::new(),
				client_id:    "antigravity-client".into(),
				refresh:      OAuthRefreshSpec::TokenEndpoint,
				token_url:    "https://oauth2.googleapis.com/token".into(),
				scopes:       vec!["scope-a".into(), "scope-b".into()],
				audience:     None,
				token_params: vec![OAuthParameter {
					name:  "client_secret".into(),
					value: "installed-client-secret".into(),
				}],
				placement:    KeyPlacement::Header(HeaderPlacement::bearer()),
			},
			authorize_url: "https://accounts.google.com/o/oauth2/v2/auth".into(),
			exchange:      OAuthExchangeKind::GoogleAntigravity,
			parameters:    vec![
				OAuthParameter {
					name:  REDIRECT_URI_PARAMETER.into(),
					value: "http://127.0.0.1:51121/oauth-callback".into(),
				},
				OAuthParameter { name: "access_type".into(), value: "offline".into() },
				OAuthParameter { name: "prompt".into(), value: "consent".into() },
			],
			polling:       None,
		}
	}
	#[test]
	fn exchange_discriminator_round_trips_catalog_spelling() {
		assert_eq!(
			"google-antigravity"
				.parse::<OAuthExchangeKind>()
				.expect("strum exchange spelling"),
			OAuthExchangeKind::GoogleAntigravity,
		);
		assert_eq!(
			serde_json::from_str::<OAuthExchangeKind>(r#""google-antigravity""#)
				.expect("serde exchange spelling"),
			OAuthExchangeKind::GoogleAntigravity,
		);
	}

	#[test]
	fn cloud_code_transport_requires_exact_http_200() {
		let response = OAuthHttpResponse {
			status:  201,
			headers: HeaderMap::new(),
			body:    SecretString::from(r#"{"currentTier":{"id":"free-tier"}}"#.to_owned()),
		};
		assert_eq!(
			decode_response::<LoadResponse>(response)
				.err()
				.expect("201 is not native success"),
			OAuthError::ProvisioningRejected { status: 201 },
		);
	}

	#[tokio::test]
	async fn custom_exchange_completes_pkce_and_attaches_project_routing() {
		let payload = r#"{
			"currentTier": {"id": "free-tier"},
			"paidTier": {"id": "standard-tier"},
			"allowedTiers": [{"id": "free-tier"}],
			"cloudaicompanionProject": "project-123"
		}"#;
		let http = Arc::new(ScriptedHttp::new(&[
			r#"{
				"access_token": "access-token",
				"refresh_token": "refresh-token",
				"token_type": "Bearer",
				"expires_in": 3600
			}"#,
			payload,
			payload,
		]));
		let clock = Arc::new(AdvancingClock(Mutex::new(SystemTime::UNIX_EPOCH)));
		let mut dispatcher = OAuthCustomDispatcher::new();
		register(&mut dispatcher, http.clone(), clock).expect("register");
		let spec = spec();
		let (session, driver, _) = default_login_channels(LoginSessionId::from("antigravity-login"));

		let exchange = dispatcher.exchange(&spec, &driver);
		let interaction = async {
			let AuthEvent::OpenUrl { url, .. } = session
				.events
				.recv_async()
				.await
				.expect("authorization URL")
				.expect("authorization event")
			else {
				panic!("authorization URL expected");
			};
			let AuthEvent::Prompt(_) = session
				.events
				.recv_async()
				.await
				.expect("callback prompt")
				.expect("prompt event")
			else {
				panic!("callback prompt expected");
			};
			let authorization = Url::parse(&url).expect("authorization URL parses");
			let state = authorization
				.query_pairs()
				.find(|(name, _)| name == "state")
				.expect("state parameter")
				.1
				.into_owned();
			session
				.responses
				.send_async(AuthResponse {
					session: session.id.clone(),
					input:   AuthInput::AuthorizationCode(SecretString::from(format!(
						"http://127.0.0.1:51121/oauth-callback?code=authorization-code&state={state}",
					))),
				})
				.await
				.expect("callback response");
		};
		let (tokens, ()) = tokio::join!(exchange, interaction);
		let tokens = tokens.expect("completed custom exchange");
		assert!(tokens.is_refreshable());
		assert_eq!(tokens.project().map(|project| project.as_str()), Some("project-123"));
		let requests = http.requests.lock();
		assert_eq!(requests.len(), 3);
		assert_eq!(requests[0].url, "https://oauth2.googleapis.com/token");
		assert_eq!(requests[1].url, LOAD_CODE_ASSIST_URL);
		assert_eq!(requests[2].url, LOAD_CODE_ASSIST_URL);
	}

	#[tokio::test]
	async fn existing_account_loads_twice_against_daily_endpoint() {
		let payload = r#"{
			"currentTier": {"id": "free-tier"},
			"paidTier": {"id": "standard-tier"},
			"allowedTiers": [{"id": "free-tier"}],
			"cloudaicompanionProject": "project-123"
		}"#;
		let http = ScriptedHttp::new(&[payload, payload]);
		let clock = AdvancingClock(Mutex::new(SystemTime::UNIX_EPOCH));
		let project = discover_project(
			&http,
			&clock,
			&SecretString::from("access-token".to_owned()),
			CloudCodeProfile::Antigravity,
		)
		.await
		.expect("project discovery");
		assert_eq!(project.as_str(), "project-123");
		let requests = http.requests.lock();
		assert_eq!(requests.len(), 2);
		assert!(
			requests
				.iter()
				.all(|request| request.url == LOAD_CODE_ASSIST_URL)
		);
		assert!(
			requests
				.iter()
				.all(|request| request.method == Method::POST)
		);
		assert_eq!(
			body(&requests[0]),
			serde_json::json!({
				"metadata": { "ideType": "ANTIGRAVITY" }
			})
		);
	}

	#[tokio::test]
	async fn gemini_cli_discovers_and_persists_project_on_its_endpoint() {
		let payload = r#"{
			"currentTier": {"id": "free-tier"},
			"paidTier": {"id": "standard-tier"},
			"allowedTiers": [{"id": "free-tier"}],
			"cloudaicompanionProject": "gemini-project"
		}"#;
		let http = ScriptedHttp::new(&[payload, payload]);
		let clock = AdvancingClock(Mutex::new(SystemTime::UNIX_EPOCH));
		let project = discover_project(
			&http,
			&clock,
			&SecretString::from("access-token".to_owned()),
			CloudCodeProfile::GeminiCli,
		)
		.await
		.expect("Gemini CLI project discovery");
		assert_eq!(project.as_str(), "gemini-project");
		let requests = http.requests.lock();
		assert!(requests.iter().all(|request| {
			request.url == "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist"
		}));
		assert_eq!(
			body(&requests[0]),
			serde_json::json!({
				"metadata": {
					"ideType": "IDE_UNSPECIFIED",
					"platform": "PLATFORM_UNSPECIFIED",
					"pluginType": "GEMINI"
				}
			})
		);
	}

	#[tokio::test]
	async fn missing_paid_tier_reloads_with_returned_project() {
		let initial = r#"{
			"currentTier": {"id": "free-tier"},
			"allowedTiers": [{"id": "free-tier"}],
			"cloudaicompanionProject": "project-123"
		}"#;
		let hydrated = r#"{
			"currentTier": {"id": "free-tier"},
			"paidTier": {"id": "standard-tier"},
			"allowedTiers": [{"id": "free-tier"}],
			"cloudaicompanionProject": "project-123"
		}"#;
		let http = ScriptedHttp::new(&[initial, hydrated, hydrated]);
		let clock = AdvancingClock(Mutex::new(SystemTime::UNIX_EPOCH));
		let project = discover_project(
			&http,
			&clock,
			&SecretString::from("access-token".to_owned()),
			CloudCodeProfile::Antigravity,
		)
		.await
		.expect("hydrated project");
		assert_eq!(project.as_str(), "project-123");
		let requests = http.requests.lock();
		assert_eq!(requests.len(), 3);
		assert_eq!(
			body(&requests[1]),
			serde_json::json!({
				"metadata": { "ideType": "ANTIGRAVITY" },
				"cloudaicompanionProject": "project-123"
			})
		);
	}

	#[tokio::test]
	async fn explicit_free_tier_ineligibility_stops_before_onboarding() {
		let http = ScriptedHttp::new(&[r#"{
			"ineligibleTiers": [{
				"tierId": "free-tier",
				"reasonMessage": "This account is not eligible for the free tier."
			}]
		}"#]);
		let clock = AdvancingClock(Mutex::new(SystemTime::UNIX_EPOCH));
		let error = discover_project(
			&http,
			&clock,
			&SecretString::from("access-token".to_owned()),
			CloudCodeProfile::Antigravity,
		)
		.await
		.expect_err("ineligible account");
		assert_eq!(error, OAuthError::ProvisioningIneligible);
		assert_eq!(http.requests.lock().len(), 1);
	}

	#[tokio::test]
	async fn free_tier_onboarding_polls_once_then_refreshes_project() {
		let http = ScriptedHttp::new(&[
			r#"{"allowedTiers":[{"id":"free-tier"}]}"#,
			r#"{"name":"operations/onboard-123"}"#,
			r#"{
				"name": "operations/onboard-123",
				"done": true,
				"response": {
					"@type": "type.googleapis.com/google.internal.cloud.code.v1internal.OnboardUserResponse",
					"cloudaicompanionProject": "project-123"
				}
			}"#,
			r#"{
				"currentTier": {"id": "free-tier"},
				"paidTier": {"id": "standard-tier"},
				"cloudaicompanionProject": "project-123"
			}"#,
		]);
		let clock = AdvancingClock(Mutex::new(SystemTime::UNIX_EPOCH));
		let project = discover_project(
			&http,
			&clock,
			&SecretString::from("access-token".to_owned()),
			CloudCodeProfile::Antigravity,
		)
		.await
		.expect("provisioned project");
		assert_eq!(project.as_str(), "project-123");
		assert_eq!(clock.now(), SystemTime::UNIX_EPOCH + ONBOARD_POLL_INTERVAL);
		let requests = http.requests.lock();
		assert_eq!(requests.len(), 4);
		assert_eq!(requests[1].url, ONBOARD_USER_URL);
		assert_eq!(
			requests[1]
				.headers
				.get(AUTHORIZATION)
				.expect("authorization"),
			"Bearer access-token",
		);
		assert!(
			requests[1]
				.headers
				.get(USER_AGENT)
				.expect("user agent")
				.to_str()
				.expect("ASCII user agent")
				.starts_with("antigravity/hub/"),
		);
		assert_eq!(
			body(&requests[1]),
			serde_json::json!({
				"tierId": "free-tier",
				"metadata": { "ideType": "ANTIGRAVITY" }
			})
		);
		assert_eq!(requests[2].method, Method::GET);
		assert_eq!(
			requests[2].url,
			"https://daily-cloudcode-pa.googleapis.com/v1internal/operations/onboard-123",
		);
		assert!(requests[2].body.is_none());
		assert_eq!(requests[3].url, LOAD_CODE_ASSIST_URL);
	}
}
