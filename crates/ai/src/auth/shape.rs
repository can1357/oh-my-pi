//! Provider-specific credential shaping before request encoding.

use std::{collections::HashMap, time::Instant};

use futures::future::{Either, Ready};
use omp_catalog::ProviderId;
use omp_core::{SecretString, Str};
use thiserror::Error;

use super::{
	alibaba_token_plan::AlibabaTokenPlanShaper,
	github_copilot::{CopilotProbeFuture, GithubCopilotShaper},
};

/// A requested rewrite of one provider credential.
///
/// `None` from a shaper means the original lease passes through unchanged.
pub struct ShapedCredential {
	/// Replacement secret, or `None` to retain the lease's existing secret.
	pub secret:            Option<SecretString>,
	/// Absolute base-URL override replacing the route's `endpoint.base_url`.
	pub endpoint_override: Option<Str>,
}

/// Future returned by a built-in provider shaper.
///
/// Synchronous shaping uses [`Ready`]. The probe branch is reserved for a cold
/// Copilot endpoint request on a credential memo-cache miss; its allocation is
/// encapsulated inside [`CopilotProbeFuture`].
pub type ProviderShapeFuture<'a> = Either<Ready<Option<ShapedCredential>>, CopilotProbeFuture<'a>>;

/// Closed set of application-supported credential shapers.
pub enum ProviderShaper {
	/// GitHub Copilot envelope parsing and plan-endpoint discovery.
	GithubCopilot(GithubCopilotShaper),
	/// Alibaba Token Plan envelope parsing.
	AlibabaTokenPlan(AlibabaTokenPlanShaper),
}

impl ProviderShaper {
	/// Provider whose credentials this shaper rewrites.
	pub fn provider(&self) -> &ProviderId<str> {
		match self {
			Self::GithubCopilot(shaper) => shaper.provider(),
			Self::AlibabaTokenPlan(shaper) => shaper.provider(),
		}
	}

	/// Shapes raw material. `route_base_url` is the catalog route endpoint;
	/// `deadline` bounds any network I/O (implementations also self-cap at 10s).
	pub fn shape<'a>(
		&'a self,
		raw: &'a SecretString,
		route_base_url: &'a str,
		deadline: Option<Instant>,
	) -> ProviderShapeFuture<'a> {
		match self {
			Self::GithubCopilot(shaper) => shaper.shape(raw, route_base_url, deadline),
			Self::AlibabaTokenPlan(shaper) => shaper.shape(raw, route_base_url, deadline),
		}
	}
}

/// Error returned when two credential shapers claim the same provider.
#[derive(Clone, Debug, Eq, Error, PartialEq)]
#[error("credential shaper already registered for provider {provider}")]
pub struct DuplicateShaperError {
	/// Provider already present in the registry.
	pub provider: ProviderId,
}

/// Registry mapping provider ids to built-in credential shapers.
///
/// The registry is assembled once at the application boundary and then shared
/// immutably by every route.
#[derive(Default)]
pub struct CredentialShaperRegistry {
	shapers: HashMap<ProviderId, ProviderShaper>,
}

impl CredentialShaperRegistry {
	/// Creates an empty credential-shaper registry.
	pub fn new() -> Self {
		Self { shapers: HashMap::new() }
	}

	/// Registers one provider shaper, rejecting duplicate provider ids.
	pub fn register(&mut self, shaper: ProviderShaper) -> Result<(), DuplicateShaperError> {
		let provider = shaper.provider().to_owned();
		if self.shapers.contains_key(&provider) {
			return Err(DuplicateShaperError { provider });
		}
		self.shapers.insert(provider, shaper);
		Ok(())
	}

	/// Returns the shaper registered for `provider`, if any.
	pub fn get(&self, provider: &ProviderId<str>) -> Option<&ProviderShaper> {
		self.shapers.get(provider)
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn duplicate_provider_registration_is_rejected() {
		let mut registry = CredentialShaperRegistry::new();
		registry
			.register(ProviderShaper::AlibabaTokenPlan(AlibabaTokenPlanShaper::new()))
			.expect("first shaper");
		let error = registry
			.register(ProviderShaper::AlibabaTokenPlan(AlibabaTokenPlanShaper::new()))
			.expect_err("duplicate shaper");
		assert_eq!(error.provider.as_str(), "alibaba-token-plan");
	}
}
