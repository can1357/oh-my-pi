//! OMP custom-endpoint and gateway URL routing.

use omp_catalog::CodecId;
use omp_core::Str;
use url::Url;

/// Explicit custom endpoint mode with no provider-specific behavior.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CustomEndpointMode {
	/// Route directly to the configured compatibility endpoint.
	Compatible,
	/// Route through an OMP gateway that accepts codec-qualified paths.
	OmpGateway,
}

/// A validated custom route base.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CustomEndpoint {
	base_url: Str,
	mode:     CustomEndpointMode,
}

impl CustomEndpoint {
	/// Validates an explicit HTTP(S) custom endpoint.
	pub fn new(base_url: &str, mode: CustomEndpointMode) -> Result<Self, CustomEndpointError> {
		let parsed = Url::parse(base_url).map_err(|_| CustomEndpointError::InvalidUrl)?;
		if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
			return Err(CustomEndpointError::InvalidUrl);
		}
		Ok(Self { base_url: Str::new(base_url.trim_end_matches('/')), mode })
	}

	/// Builds the concrete operation URL without provider-brand path inference.
	pub fn operation_url(
		&self,
		codec: &CodecId<str>,
		operation_path: &str,
	) -> Result<Str, CustomEndpointError> {
		if !operation_path.starts_with('/') || operation_path.starts_with("/v1/provider-native/") {
			return Err(CustomEndpointError::InvalidPath);
		}
		let mut url = String::with_capacity(
			self.base_url.len() + operation_path.len() + codec.as_str().len() + 16,
		);
		url.push_str(&self.base_url);
		if self.mode == CustomEndpointMode::OmpGateway {
			url.push_str("/omp/gateway/");
			url.push_str(codec.as_str());
		}
		url.push_str(operation_path);
		Ok(Str::new(url))
	}
}

/// Invalid custom endpoint configuration.
#[derive(Clone, Copy, Debug, thiserror::Error, Eq, PartialEq)]
pub enum CustomEndpointError {
	/// Base URL is not absolute HTTP(S).
	#[error("custom endpoint must be an absolute HTTP(S) URL")]
	InvalidUrl,
	/// Operation path is not an OMP/native compatibility path.
	#[error("custom endpoint operation path is invalid")]
	InvalidPath,
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn gateway_uses_omp_namespace_and_rejects_provider_native_paths() {
		let endpoint =
			CustomEndpoint::new("https://gateway.example/v1", CustomEndpointMode::OmpGateway)
				.expect("endpoint");
		assert_eq!(
			endpoint
				.operation_url(CodecId::from_ref("openai"), "/chat/completions")
				.unwrap(),
			"https://gateway.example/v1/omp/gateway/openai/chat/completions"
		);
		assert!(
			endpoint
				.operation_url(CodecId::from_ref("openai"), "/v1/provider-native/stream")
				.is_err()
		);
	}
}
