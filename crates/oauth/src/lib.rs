//! Provider-independent OAuth protocol primitives.
//!
//! This crate owns bounded wire operations and authorization protocol state. It
//! deliberately does not own credential selection, persistence, or leases.

mod authorization;
mod callback;
mod device;
mod discovery;
mod http;
mod metadata;
mod pkce;
mod registration;
mod token;

pub use authorization::{
	AuthorizationError, AuthorizationRequest, CompleteAuthorizationError, PendingAuthorization,
	begin_authorization, complete_authorization,
};
pub use callback::{
	CallbackBindError, CallbackError, CallbackGrant, LoopbackCallback, validate_redirect_pair,
};
pub use device::{
	DeviceAuthorizationError, DeviceAuthorizationRequest, PendingDeviceAuthorization,
	begin_device_authorization, poll_device_token,
};
pub use discovery::{
	AuthChallenge, ChallengeKind, discover_auth_challenge, discover_auth_challenge_with_base,
};
pub use http::{
	OAuthHttpClient, OAuthHttpRequest, OAuthHttpResponse, OAuthRequestError, OAuthTransportError,
	SystemOAuthHttpClient,
};
pub use metadata::{
	AuthorizationServerMetadata, MetadataError, ProtectedResourceMetadata,
	discover_authorization_server_metadata, discover_protected_resource_metadata,
	metadata_candidates, parse_authorization_server_metadata, parse_protected_resource_metadata,
	protected_resource_candidates,
};
pub use pkce::{EntropyError, PkceMaterial, SystemEntropy, generate_pkce};
pub use registration::{
	ClientConfiguration, ClientRegistration, ClientRegistrationError, ClientRegistrationRequest,
	register_client, resolve_client,
};
pub use token::{
	TokenError, TokenGrant, TokenRequest, exchange_authorization_code, parse_token_response,
	refresh_token,
};
