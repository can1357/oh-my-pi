//! Typed catalog facts for OMP inference providers, routes, codecs, and models.
//!
//! Provider/account domains, concrete routes, wire codecs, selectable models,
//! and opaque wire model identifiers remain distinct. Router-facing
//! [`PolicyModel`] records cannot reveal raw wire model identifiers.

pub mod capability;
pub mod cascade;
pub mod classify;
pub mod compat;
pub mod compile;
pub mod contrib;
pub mod discover;
pub mod id;
pub mod model;
pub mod policy;
pub mod pricing;
pub mod provider;
pub mod resolve;
pub mod runtime;
pub mod selection;
pub mod settings;
pub mod snapshot;
pub mod taxonomy;
pub mod thinking;

pub use capability::*;
pub use cascade::*;
pub use classify::*;
pub use compat::*;
pub use compile::*;
pub use contrib::*;
pub use discover::*;
pub use id::*;
pub use model::*;
pub use policy::*;
pub use pricing::*;
pub use provider::*;
pub use resolve::*;
pub use runtime::*;
pub use selection::*;
pub use snapshot::*;
pub use taxonomy::*;
pub use thinking::*;

#[cfg(test)]
mod tests {
	use std::{
		collections::{HashMap, hash_map::DefaultHasher},
		hash::{Hash, Hasher},
	};

	use omp_core::IntoStr;

	use super::*;

	#[test]
	fn identifiers_order_borrow_hash_and_serialize_like_strings() {
		let alpha = ProviderId::from("alpha");
		let beta = ProviderId::from("beta");
		assert!(alpha < beta);
		assert_eq!(alpha.as_str(), "alpha");

		let mut values = HashMap::new();
		values.insert(alpha.clone(), 7_u8);
		assert_eq!(values.get("alpha"), Some(&7));

		let mut id_hasher = DefaultHasher::new();
		alpha.hash(&mut id_hasher);
		let mut str_hasher = DefaultHasher::new();
		"alpha".hash(&mut str_hasher);
		assert_eq!(id_hasher.finish(), str_hasher.finish());

		let encoded = serde_json::to_string(&alpha).expect("identifier serializes");
		assert_eq!(encoded, "\"alpha\"");
		let decoded: ProviderId = serde_json::from_str(&encoded).expect("identifier deserializes");
		assert_eq!(decoded, alpha);
	}

	#[test]
	fn unknown_capability_is_not_unsupported_or_usable() {
		let unknown = Availability::<StructuredOutputBits>::Unknown;
		let unsupported = Availability::<StructuredOutputBits>::Unsupported;
		assert!(unknown.is_unknown());
		assert!(!unknown.is_unsupported());
		assert_eq!(unknown.constraints(), None);
		assert!(unsupported.is_unsupported());
		assert!(!unsupported.is_unknown());
		assert_ne!(unknown, unsupported);
	}

	#[test]
	fn operation_bits_track_membership_compactly() {
		let mut operations = OperationBits::empty();
		operations.insert_kind(OperationKind::Chat);
		operations.insert_kind(OperationKind::Embed);
		assert!(operations.contains_kind(OperationKind::Chat));
		assert!(operations.contains_kind(OperationKind::Embed));
		assert!(!operations.contains_kind(OperationKind::Search));
		assert_eq!(std::mem::size_of::<OperationBits>(), std::mem::size_of::<u16>());
	}

	#[test]
	fn embedding_input_kinds_do_not_infer_token_id_support() {
		let input_kinds = EmbeddingInputBits::TEXT;
		assert!(input_kinds.contains(EmbeddingInputBits::TEXT));
		assert!(!input_kinds.contains(EmbeddingInputBits::TOKEN_IDS));
		let encoded = serde_json::to_vec(&input_kinds).expect("embedding input bits serialize");
		let decoded: EmbeddingInputBits =
			serde_json::from_slice(&encoded).expect("embedding input bits deserialize");
		assert_eq!(decoded, input_kinds);
	}

	#[test]
	fn capability_and_record_serde_round_trips() {
		let capability = Availability::Emulated {
			constraints: StructuredOutputBits::JSON_OBJECT | StructuredOutputBits::JSON_SCHEMA,
			method:      Emulation::ResponseTransform,
		};
		let encoded = serde_json::to_string(&capability).expect("capability serializes");
		let decoded: Availability<StructuredOutputBits> =
			serde_json::from_str(&encoded).expect("capability deserializes");
		assert_eq!(decoded, capability);

		let endpoint = EndpointSpec {
			base_url:    "https://example.test/v1".to_str(),
			region:      Some("test-1".to_str()),
			api_version: Some("2024-10-21".to_str()),
		};
		let encoded = serde_json::to_vec(&endpoint).expect("record serializes");
		let decoded: EndpointSpec = serde_json::from_slice(&encoded).expect("record deserializes");
		assert_eq!(decoded, endpoint);
	}

	#[test]
	fn auth_records_preserve_source_order_and_public_oauth_data() {
		let oauth_id = OAuthSpecId::from("oauth-test");
		let oauth = OAuthSpec {
			id:                   oauth_id.clone(),
			client_id:            "public-client".to_str(),
			token_url:            "https://auth.example.test/token".to_str(),
			scopes:               Box::from(["profile".to_str(), "offline_access".to_str()]),
			audience:             Some("https://api.example.test".to_str()),
			placement:            OAuthTokenPlacement::Header {
				name:   "authorization".to_str(),
				prefix: "Bearer ".to_str(),
			},
			token_parameters:     Box::new([]),
			flow:                 OAuthFlowSpec::DeviceCode {
				device_authorization_url: "https://auth.example.test/device".to_str(),
				polling:                  OAuthPollingSpec {
					maximum_polls:       Some(60),
					default_interval_ms: 5_000,
					maximum_interval_ms: 30_000,
				},
			},
			refresh:              OAuthRefreshBehavior::TokenEndpoint,
			principal_resolution: Some(PrincipalResolution::IdTokenClaim { claim: "sub".to_str() }),
		};
		let encoded = serde_json::to_vec(&oauth).expect("OAuth spec serializes");
		let decoded: OAuthSpec = serde_json::from_slice(&encoded).expect("OAuth spec deserializes");
		assert_eq!(decoded, oauth);

		let sources: Box<[CredentialSourceSpec]> = Box::from([
			CredentialSourceSpec::Environment {
				ordered_names: Box::from(["OMP_TOKEN".to_str(), "OMP_TOKEN_FALLBACK".to_str()]),
			},
			CredentialSourceSpec::Stored,
			CredentialSourceSpec::Oauth { flow: oauth_id.clone() },
		]);
		let encoded = serde_json::to_vec(&sources).expect("credential sources serialize");
		let decoded: Box<[CredentialSourceSpec]> =
			serde_json::from_slice(&encoded).expect("credential sources deserialize");
		assert_eq!(decoded, sources);

		let auth = AuthSpec {
			id:                 AuthSpecId::from("auth-test"),
			kind:               AuthSpecKind::Oauth,
			header_name:        Some("authorization".to_str()),
			query_parameter:    None,
			prefix:             Some("Bearer ".to_str()),
			sealed_body:        None,
			scopes:             Box::from(["profile".to_str()]),
			audience:           Some("https://api.example.test".to_str()),
			account_scope:      AccountScope::Provider,
			credential_sources: sources,
			oauth:              Some(oauth_id),
			signing:            None,
		};
		let encoded = serde_json::to_vec(&auth).expect("auth spec serializes");
		let decoded: AuthSpec = serde_json::from_slice(&encoded).expect("auth spec deserializes");
		assert_eq!(decoded, auth);
	}
}
