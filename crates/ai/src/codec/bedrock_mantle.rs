//! Amazon Bedrock Mantle's `OpenAI` Responses transport contract.
//!
//! Mantle deliberately reuses the canonical Responses mapping while retaining
//! its distinct AWS endpoint, bearer-scoped discovery, and credential-rejection
//! behavior.

use omp_catalog::DiscoverySpec;
use omp_core::{Str, sf};
use url::Url;

use super::{
	Codec, DecodeContext, Decoder, DecoderState, EncodeContext, EncodedRequest, Frame, RawEvent,
	discovery::OpenAiModelsDiscoveryCodec,
	openai_responses::{OpenAiResponsesCodec, OpenAiResponsesOptions},
};
use crate::{
	auth::AuthScheme,
	call::OperationCall,
	error::{Error, ErrorDetail, ErrorKind, ErrorPhase, RetryAction},
	receipt::{ExecutionReceipt, ReasonId},
};

const REGION_PLACEHOLDER: &str = "{region}";

/// `OpenAI` Responses mapping with Bedrock Mantle authentication recovery.
#[derive(Clone, Debug, Default)]
pub struct BedrockMantleCodec {
	inner: OpenAiResponsesCodec,
}

impl BedrockMantleCodec {
	/// Constructs a Mantle codec with the canonical Responses options.
	pub const fn new(options: OpenAiResponsesOptions) -> Self {
		Self { inner: OpenAiResponsesCodec::new(options) }
	}
}

impl Codec for BedrockMantleCodec {
	fn encode(
		&self,
		context: &EncodeContext<'_>,
		operation: &OperationCall,
	) -> Result<EncodedRequest, Error> {
		self.inner.encode(context, operation)
	}

	fn decoder(&self, context: &DecodeContext<'_>) -> Result<DecoderState, Error> {
		Ok(Box::new(BedrockMantleDecoder {
			inner:       self.inner.decoder(context)?,
			auth_scheme: context.auth_scheme,
		}))
	}
}

/// Bearer-scoped Mantle model discovery over the provider's account catalog.
#[derive(Clone, Debug)]
pub struct BedrockMantleDiscoveryCodec {
	inner: OpenAiModelsDiscoveryCodec,
}

impl BedrockMantleDiscoveryCodec {
	/// Constructs the Mantle discovery codec from its catalog-owned `OpenAI`
	/// model-list contract.
	pub fn from_spec(spec: &DiscoverySpec) -> Result<Self, Error> {
		OpenAiModelsDiscoveryCodec::from_spec(spec).map(|inner| Self { inner })
	}
}

impl Codec for BedrockMantleDiscoveryCodec {
	fn encode(
		&self,
		context: &EncodeContext<'_>,
		operation: &OperationCall,
	) -> Result<EncodedRequest, Error> {
		if !matches!(context.auth_scheme, Some(AuthScheme::OAuth | AuthScheme::ApplicationDefault)) {
			return Err(discovery_requires_bearer());
		}
		let mut request = self.inner.encode(context, operation)?;
		request.uri = discovery_endpoint(context.route.endpoint.base_url.as_str())
			.map_err(|_| invalid_discovery_endpoint())?;
		Ok(request)
	}

	fn decoder(&self, context: &DecodeContext<'_>) -> Result<DecoderState, Error> {
		self.inner.decoder(context)
	}
}

struct BedrockMantleDecoder {
	inner:       DecoderState,
	auth_scheme: Option<AuthScheme>,
}

pub(crate) fn map_auth_rejection(auth_scheme: Option<AuthScheme>, mut error: Error) -> Error {
	const AUTHENTICATION_CODES: &[&str] =
		&["401", "invalid_api_key", "authentication_error", "unauthorized"];
	const AUTHORIZATION_CODES: &[&str] = &["403", "permission_denied", "authorization_error"];
	let code_matches = |expected: &[&str]| {
		error.code.as_deref().is_some_and(|code| {
			expected
				.iter()
				.any(|candidate| code.eq_ignore_ascii_case(candidate))
		})
	};
	let authentication = error.kind == ErrorKind::Authentication
		|| error.status == Some(401)
		|| code_matches(AUTHENTICATION_CODES);
	let authorization = error.kind == ErrorKind::Authorization
		|| error.status == Some(403)
		|| code_matches(AUTHORIZATION_CODES);
	if !error.committed && (authentication || authorization) {
		error.action = match auth_scheme {
			Some(AuthScheme::AwsSigV4) => RetryAction::RefreshCredentialOnce,
			_ if authentication => RetryAction::RefreshCredential,
			_ => RetryAction::RotateAccount,
		};
	}
	error
}

impl Decoder for BedrockMantleDecoder {
	fn push(&mut self, frame: Frame, emit: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
		let auth_scheme = self.auth_scheme;
		let mut mapped_emit = |event| match event {
			RawEvent::Failure(error) => {
				emit(RawEvent::Failure(map_auth_rejection(auth_scheme, error)));
			},
			other => emit(other),
		};
		self
			.inner
			.push(frame, &mut mapped_emit)
			.map_err(|error| map_auth_rejection(auth_scheme, error))
	}

	fn finish(&mut self, emit: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
		let auth_scheme = self.auth_scheme;
		let mut mapped_emit = |event| match event {
			RawEvent::Failure(error) => {
				emit(RawEvent::Failure(map_auth_rejection(auth_scheme, error)));
			},
			other => emit(other),
		};
		self
			.inner
			.finish(&mut mapped_emit)
			.map_err(|error| map_auth_rejection(auth_scheme, error))
	}

	fn is_complete(&self) -> bool {
		self.inner.is_complete()
	}

	fn prepare_browser_retry(&mut self) -> bool {
		self.inner.prepare_browser_retry()
	}

	fn supports_control(&self) -> bool {
		self.inner.supports_control()
	}

	fn encode_control(
		&mut self,
		input: super::ProviderControlInput,
	) -> Result<Option<bytes::Bytes>, Error> {
		self.inner.encode_control(input)
	}
}

/// Expands one catalog-owned Mantle endpoint with a validated AWS region.
pub fn expand_endpoint(base: &str, region: &str) -> Result<Str, BedrockMantleEndpointError> {
	if region.is_empty()
		|| !region
			.bytes()
			.all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
	{
		return Err(BedrockMantleEndpointError::InvalidRegion);
	}
	let expanded = base.replace(REGION_PLACEHOLDER, region);
	let parsed = Url::parse(&expanded).map_err(BedrockMantleEndpointError::Url)?;
	if parsed.scheme() != "https" {
		return Err(BedrockMantleEndpointError::InsecureEndpoint);
	}
	if parsed.host_str().is_none() {
		return Err(BedrockMantleEndpointError::MissingHost);
	}
	Ok(Str::new(&parsed))
}

/// Maps Mantle's Responses inference endpoint to its bearer-scoped model-list
/// endpoint.
pub fn discovery_endpoint(base: &str) -> Result<Str, BedrockMantleEndpointError> {
	let mut parsed = Url::parse(base).map_err(BedrockMantleEndpointError::Url)?;
	if parsed.scheme() != "https" {
		return Err(BedrockMantleEndpointError::InsecureEndpoint);
	}
	if parsed.host_str().is_none() {
		return Err(BedrockMantleEndpointError::MissingHost);
	}
	let inference_path = parsed.path().trim_end_matches('/');
	let Some(prefix) = inference_path.strip_suffix("/openai/v1") else {
		return Err(BedrockMantleEndpointError::InvalidInferencePath);
	};
	let mut path = String::with_capacity(prefix.len() + "/v1/models".len());
	path.push_str(prefix);
	path.push_str("/v1/models");
	parsed.set_path(&path);
	parsed.set_query(None);
	parsed.set_fragment(None);
	Ok(Str::new(&parsed))
}

fn discovery_requires_bearer() -> Error {
	Error::new(
		ErrorKind::CapabilityMismatch,
		ErrorPhase::Discovery,
		RetryAction::Never,
		ExecutionReceipt::default(),
	)
	.detail(ErrorDetail::Capability {
		feature: sf!("discovery"),
		reason:  ReasonId(sf!("bedrock-mantle-discovery-requires-bearer")),
	})
}

fn invalid_discovery_endpoint() -> Error {
	Error::new(
		ErrorKind::ProviderContractMismatch,
		ErrorPhase::Discovery,
		RetryAction::Never,
		ExecutionReceipt::default(),
	)
	.detail(ErrorDetail::Protocol {
		reason: ReasonId(sf!("bedrock-mantle-discovery-endpoint-invalid")),
	})
}

/// Structural failure while expanding a catalog Mantle endpoint.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum BedrockMantleEndpointError {
	/// The region is empty or contains characters not valid in an AWS region.
	#[error("Bedrock Mantle region is invalid")]
	InvalidRegion,
	/// The expanded endpoint is not a valid URL.
	#[error("Bedrock Mantle endpoint URL is invalid")]
	Url(#[source] url::ParseError),
	/// Mantle endpoints must use TLS.
	#[error("Bedrock Mantle endpoint must use HTTPS")]
	InsecureEndpoint,
	/// The inference endpoint does not end in Mantle's `/openai/v1` path.
	#[error("Bedrock Mantle inference endpoint path is invalid")]
	InvalidInferencePath,
	/// The expanded endpoint has no host.
	#[error("Bedrock Mantle endpoint has no host")]
	MissingHost,
}

#[cfg(test)]
mod tests {
	use std::sync::Arc;

	use bytes::Bytes;
	use omp_catalog::{OperationKind, WirePolicy, snapshot::Catalog};

	use super::*;
	use crate::{
		call::DiscoveryRequest,
		codec::RequestMethod,
		error::{ErrorKind, ErrorPhase},
		id::RequestId,
		receipt::ExecutionReceipt,
		transport::FramingProtocol,
	};

	#[test]
	fn endpoint_expands_region_without_changing_the_responses_base_path() {
		let endpoint =
			expand_endpoint("https://bedrock-mantle.{region}.api.aws/openai/v1", "eu-west-2")
				.expect("valid regional endpoint");
		assert_eq!(endpoint.as_str(), "https://bedrock-mantle.eu-west-2.api.aws/openai/v1",);
	}

	#[test]
	fn endpoint_rejects_host_injection_through_region() {
		assert_eq!(
			expand_endpoint(
				"https://bedrock-mantle.{region}.api.aws/openai/v1",
				"us-east-1.evil.example",
			),
			Err(BedrockMantleEndpointError::InvalidRegion),
		);
	}

	#[test]
	fn discovery_maps_the_regional_inference_endpoint_to_the_account_catalog() {
		assert_eq!(
			discovery_endpoint(
				"https://bedrock-mantle.eu-west-2.api.aws/team/openai/v1?stale=1#fragment",
			)
			.expect("valid Mantle inference endpoint")
			.as_str(),
			"https://bedrock-mantle.eu-west-2.api.aws/team/v1/models",
		);
		assert_eq!(
			discovery_endpoint("https://bedrock-mantle.eu-west-2.api.aws/v1"),
			Err(BedrockMantleEndpointError::InvalidInferencePath),
		);
	}

	#[test]
	fn discovery_fetches_the_live_account_catalog_only_with_bearer_auth() {
		let catalog = Catalog::embedded();
		let mut route = catalog
			.route(omp_catalog::RouteId::from_ref("bedrock-mantle/primary"))
			.expect("Mantle route")
			.clone();
		route.endpoint.base_url =
			expand_endpoint(route.endpoint.base_url.as_str(), "eu-west-2").expect("regional route");
		let spec = catalog
			.discovery_spec(route.discovery.as_ref().expect("Mantle discovery contract"))
			.expect("Mantle discovery specification");
		let codec = BedrockMantleDiscoveryCodec::from_spec(spec).expect("Mantle discovery codec");
		let operation = OperationCall::DiscoverModels(Arc::new(DiscoveryRequest {
			provider:  Some(route.provider.clone()),
			route:     Some(route.id.clone()),
			cursor:    None,
			page_size: 100,
			operation: Some(OperationKind::Chat),
		}));
		let bearer = EncodeContext {
			auth_scheme: Some(AuthScheme::OAuth),
			route: &route,
			..EncodeContext::default()
		};
		let request = codec
			.encode(&bearer, &operation)
			.expect("bearer discovery request");
		assert_eq!(request.method, RequestMethod::Get);
		assert_eq!(request.uri.as_str(), "https://bedrock-mantle.eu-west-2.api.aws/v1/models",);

		let sigv4 = EncodeContext {
			auth_scheme: Some(AuthScheme::AwsSigV4),
			route: &route,
			..EncodeContext::default()
		};
		let error = match codec.encode(&sigv4, &operation) {
			Err(error) => error,
			Ok(_) => panic!("SigV4 does not expose the account-scoped Mantle catalog"),
		};
		assert_eq!(error.kind, ErrorKind::CapabilityMismatch);
		assert_eq!(error.action, RetryAction::Never);
	}

	#[test]
	fn discovery_response_preserves_live_wire_models_for_catalog_projection() {
		let catalog = Catalog::embedded();
		let route = catalog
			.route(omp_catalog::RouteId::from_ref("bedrock-mantle/primary"))
			.expect("Mantle route");
		let spec = catalog
			.discovery_spec(route.discovery.as_ref().expect("Mantle discovery contract"))
			.expect("Mantle discovery specification");
		let codec = BedrockMantleDiscoveryCodec::from_spec(spec).expect("Mantle discovery codec");
		let operation = OperationCall::DiscoverModels(Arc::new(DiscoveryRequest {
			provider:  Some(route.provider.clone()),
			route:     Some(route.id.clone()),
			cursor:    None,
			page_size: 100,
			operation: Some(OperationKind::Chat),
		}));
		let request_id = RequestId::new("mantle-models");
		let policy = WirePolicy::baseline();
		let context = DecodeContext {
			request_id:         &request_id,
			auth_scheme:        Some(AuthScheme::OAuth),
			provider:           &route.provider,
			route:              &route.id,
			target:             None,
			policy_model:       None,
			policy:             &policy,
			thinking_policy:    None,
			thinking_selection: None,
			operation_call:     &operation,
			operation:          OperationKind::DiscoverModels,
			framing:            FramingProtocol::Raw,
			native_response:    None,
			attempt:            0,
		};
		let mut decoder = codec.decoder(&context).expect("Mantle discovery decoder");
		let mut models = None;
		decoder
			.push(
				Frame::Raw(Bytes::from_static(
					br#"{"data":[{"id":"openai.gpt-5.6-luna","name":"GPT-5.6 Luna"},{"id":"openai.gpt-5.7-preview","name":"GPT-5.7 Preview"}]}"#,
				)),
				&mut |event| {
					if let RawEvent::DiscoveredModels { rows, next_cursor } = event {
						assert_eq!(next_cursor, None);
						models = Some(rows);
					}
				},
			)
			.expect("Mantle account catalog decodes");
		decoder
			.finish(&mut |_| {})
			.expect("Mantle discovery completes");
		let models = models.expect("discovery rows");
		assert_eq!(models.len(), 2);
		assert_eq!(models[0].wire_model.as_str(), "openai.gpt-5.6-luna");
		assert_eq!(models[1].wire_model.as_str(), "openai.gpt-5.7-preview");
	}

	#[test]
	fn sigv4_authentication_rejection_refreshes_once_before_output() {
		let mut error = Error::new(
			ErrorKind::Authorization,
			ErrorPhase::Handshake,
			RetryAction::Never,
			ExecutionReceipt::default(),
		);
		error.code = Some(Str::new_static("permission_denied"));
		assert_eq!(
			map_auth_rejection(Some(AuthScheme::AwsSigV4), error).action,
			RetryAction::RefreshCredentialOnce,
		);
	}

	#[test]
	fn bearer_authentication_refreshes_and_authorization_rotates() {
		let authentication = Error::new(
			ErrorKind::Authentication,
			ErrorPhase::Handshake,
			RetryAction::Never,
			ExecutionReceipt::default(),
		)
		.status(Some(401));
		assert_eq!(
			map_auth_rejection(Some(AuthScheme::OAuth), authentication).action,
			RetryAction::RefreshCredential,
		);

		let authorization = Error::new(
			ErrorKind::Authorization,
			ErrorPhase::Handshake,
			RetryAction::Never,
			ExecutionReceipt::default(),
		)
		.status(Some(403));
		assert_eq!(
			map_auth_rejection(Some(AuthScheme::OAuth), authorization).action,
			RetryAction::RotateAccount,
		);
	}

	#[test]
	fn committed_rejection_never_replays_or_rotates() {
		let error = Error::new(
			ErrorKind::Authentication,
			ErrorPhase::Streaming,
			RetryAction::Never,
			ExecutionReceipt::default(),
		)
		.status(Some(401))
		.committed(true);
		assert_eq!(map_auth_rejection(Some(AuthScheme::AwsSigV4), error).action, RetryAction::Never,);
	}
}
