//! Ollama usage reporting for runtimes without a standalone quota API.

use std::time::{Instant, SystemTime};

use futures::FutureExt as _;
use omp_core::{SecretString, sf};

use crate::{
	answer::UsageAccountMetadata,
	catalog::ProviderId,
	operation::usage::{
		ConsoleUsageFetcher, ConsoleUsageObservation, UsageCredentialRequirement, UsageFetchError,
	},
};

const OLLAMA: &str = "ollama";
const OLLAMA_CLOUD: &str = "ollama-cloud";
const NO_QUOTA_NOTE: &str = "Ollama does not expose a standalone quota usage API; per-response \
                             token usage is reported during requests.";

/// Credential-free usage fetcher for local Ollama or Ollama Cloud.
#[derive(Clone)]
pub struct OllamaUsageFetcher {
	provider: ProviderId,
}

impl OllamaUsageFetcher {
	/// Constructs the local Ollama fetcher.
	pub fn new() -> Self {
		Self { provider: ProviderId::from(OLLAMA) }
	}

	/// Constructs the Ollama Cloud fetcher.
	pub fn cloud() -> Self {
		Self { provider: ProviderId::from(OLLAMA_CLOUD) }
	}
}

impl Default for OllamaUsageFetcher {
	fn default() -> Self {
		Self::new()
	}
}

impl ConsoleUsageFetcher for OllamaUsageFetcher {
	fn provider(&self) -> &ProviderId<str> {
		&self.provider
	}

	fn credential_requirement(&self) -> UsageCredentialRequirement {
		UsageCredentialRequirement::None
	}

	fn fetch<'a>(
		&'a self,
		credential: Option<&'a SecretString>,
		_now: SystemTime,
		_deadline: Option<Instant>,
	) -> futures::future::BoxFuture<'a, Result<ConsoleUsageObservation, UsageFetchError>> {
		async move {
			if credential.is_some() {
				return Err(UsageFetchError::Protocol);
			}
			Ok(ConsoleUsageObservation {
				account_meta:  UsageAccountMetadata::default(),
				plan:          None,
				source_label:  Some(sf!("ollama-runtime")),
				notes:         vec![sf!(NO_QUOTA_NOTE)].into_boxed_slice(),
				reset_credits: None,
				windows:       Vec::new(),
			})
		}
		.boxed()
	}
}

#[cfg(test)]
mod tests {
	use std::time::SystemTime;

	use super::{OLLAMA, OLLAMA_CLOUD, OllamaUsageFetcher};
	use crate::operation::usage::{ConsoleUsageFetcher as _, UsageCredentialRequirement};

	#[tokio::test]
	async fn both_providers_report_no_standalone_quota_without_credentials() {
		for fetcher in [OllamaUsageFetcher::new(), OllamaUsageFetcher::cloud()] {
			assert_eq!(fetcher.credential_requirement(), UsageCredentialRequirement::None);
			let observation = fetcher
				.fetch(None, SystemTime::now(), None)
				.await
				.expect("credential-free observation");
			assert!(observation.windows.is_empty());
			assert!(observation.notes[0].contains("does not expose a standalone quota usage API"));
		}
		assert_eq!(OllamaUsageFetcher::new().provider().as_str(), OLLAMA);
		assert_eq!(OllamaUsageFetcher::cloud().provider().as_str(), OLLAMA_CLOUD);
	}
}
