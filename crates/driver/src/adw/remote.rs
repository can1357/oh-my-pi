//! Operator-selected remote-only placement for ADW Cargo/just code phases.
//!
//! The Environment owns capture and blobs; the driver owns the REAPI network
//! service. No project cfg can choose a remote endpoint or credential.

use std::sync::Arc;

use bytes::Bytes;
use omp_adw::Phase;
#[cfg(test)]
use omp_con::Ctx;
use omp_core::{Str, StrMut};
use omp_env::EnvClient;
use omp_exec::{
	Artifact, BuildCommand, Eligibility, ExecutionBackend, ExecutionEvent, ExecutionId,
	ExecutionRun, Intent, Platform, Stage, fallback_eligible,
};
use omp_exec_reapi::ReapiBackend;
use omp_observability::attrs::omp_exec as exec_attrs;
use omp_proto::blob::v1::Chunk;
use tokio_util::sync::CancellationToken;
use tracing::Instrument as _;

use super::production::{ProductionAdwHost, ProductionError};
use crate::exec_composer::{EnvironmentInputs, ExecutionSettings, PreparedExecution, RemoteError};
#[cfg(test)]
use crate::exec_composer::{
	SV_EXEC_REMOTE_ARCH_SPELLING, SV_EXEC_REMOTE_CACHE, SV_EXEC_REMOTE_CREDENTIAL_HEADER,
	SV_EXEC_REMOTE_ENDPOINT, SV_EXEC_REMOTE_FIXED_PROPERTIES, SV_EXEC_REMOTE_IMAGE,
	SV_EXEC_REMOTE_PROFILE, SV_EXEC_REMOTE_REFUSE_ACTION_CACHE, config_list,
};

/// An ADW remote phase error: a shared composer error.
#[derive(Debug, thiserror::Error)]
pub enum AdwRemoteError {
	/// The shared composer failed.
	#[error(transparent)]
	Remote(#[from] RemoteError),
	/// Remote execution gates are not satisfied (ADR 0047).
	#[error(
		"remote execution not accepted, set sv_exec_accepted = true after ADR 0040/0047 gates are \
		 satisfied"
	)]
	GatesNotSatisfied,
}

/// Execution placement policy; mirrors ADR 0040 Part C.3.
#[derive(
	Clone,
	Copy,
	Debug,
	Default,
	Eq,
	PartialEq,
	strum::Display,
	strum::EnumString,
	strum::IntoStaticStr,
	strum::VariantNames,
)]
#[strum(serialize_all = "kebab-case", ascii_case_insensitive)]
pub enum AdwExecPolicy {
	/// Everything local; `RemoteRequired` is unplaceable.
	#[default]
	LocalOnly,
	/// Local first; `RemoteRequired` goes remote.
	LocalPreferred,
	/// `RemotePreferred` and `RemoteRequired` go remote; rest stays local.
	RemotePreferred,
	/// Remote only; `LocalRequired` is unplaceable.
	RemoteOnly,
}
omp_con::con_enum!(AdwExecPolicy);

omp_con::var! {
	/// ADW execution placement; always operator-controlled, never project cfg.
	pub static SV_EXEC_POLICY = sv_exec_policy: AdwExecPolicy {
		default: AdwExecPolicy::LocalOnly,
		flags: archive,
	};
	/// Allow local fallback for remote-preferred requests that fail before
	/// acceptance (ADR 0040 Part C.3). Default off: automatic local rerun of
	/// a heavy command on a swapping Mac brings back the load this removes.
	pub static SV_EXEC_FALLBACK_LOCAL = sv_exec_fallback_local: bool {
		default: false, flags: archive,
	};
	/// Gate for remote execution (ADR 0047). Must be explicitly set to true
	/// after the owner accepts ADR 0040 Gaps 1-4 (A0), decides credential
	/// containment (G3), and measures relief (G8). Default false: remote
	/// backend composition is refused until the operator acknowledges the
	/// gates are satisfied.
	pub static SV_EXEC_ACCEPTED = sv_exec_accepted: bool {
		default: false, flags: archive,
	};
}

/// The only phase class Slice 1 may offload. Unknown recipes remain local.
pub fn eligible(binary: &str, args: &[Str]) -> bool {
	binary == "just"
		&& args
			.first()
			.and_then(|arg| omp_exec::recipe_class(arg))
			.is_some_and(|class| {
				matches!(class.eligibility, Eligibility::RemotePreferred | Eligibility::RemoteRequired)
			})
}

async fn materialize_artifact(
	backend: &ReapiBackend<EnvironmentInputs>,
	environment: &EnvClient,
	artifact: &Artifact,
) -> Result<Str, RemoteError> {
	let bytes = backend
		.download_blob(artifact.blob)
		.await
		.map_err(RemoteError::Execute)?;
	let upload = environment.blob_put().map_err(RemoteError::Materialize)?;
	upload
		.send_chunk(Chunk {
			data: bytes,
			hash: Bytes::copy_from_slice(artifact.blob.hash.as_bytes()),
			size: Some(artifact.blob.size),
		})
		.await
		.map_err(RemoteError::Materialize)?;
	upload.commit().await.map_err(RemoteError::Materialize)?;
	Ok(Str::new(format!("artifact://sha256/{}", artifact.blob.hash.to_hex())))
}

impl ProductionAdwHost {
	#[tracing::instrument(
		level = "info",
		name = "omp.exec.execute",
		skip_all,
		fields(exec_id = tracing::field::Empty)
	)]
	pub(super) async fn run_remote(
		&self,
		phase: &Phase,
		args: &[Str],
		cwd: Option<&str>,
		cancel: &CancellationToken,
	) -> Result<super::PhaseResult, ProductionError> {
		// Gate check (ADR 0047): refuse remote backend composition until the
		// operator acknowledges that A0 (owner acceptance), G3 (credential
		// containment), and G8 (measured relief) are satisfied.
		if !SV_EXEC_ACCEPTED.get(&self.ctx) {
			return Err(AdwRemoteError::GatesNotSatisfied.into());
		}
		let settings = ExecutionSettings::for_adw(&self.ctx)?;
		let environment = self.environment().await?.clone();
		let credential = settings
			.credential(&environment, &self.root, cancel)
			.await?;
		let command = BuildCommand {
			id:          ExecutionId::new(Str::from(uuid_v4())),
			argv:        Arc::from([vec![Str::new_static("just")], args.to_vec()].concat()),
			cwd:         cwd.map(Str::new),
			intent:      Intent::Test,
			requirement: phase.requires,
			target:      Platform::LINUX_X86_64,
			host:        host_platform(),
		};
		tracing::Span::current().record("exec_id", command.id.as_str());
		let PreparedExecution { request, pins } =
			settings.prepare(&environment, &self.root, &command).await?;
		let (profile, cache) = settings.resolved_profile()?;
		let config = settings.config(&pins, profile, cache, credential);
		let materialize_client = environment.clone();
		let backend = settings.connect_config(environment, config).await?;
		let mut run = backend.start(request).await.map_err(RemoteError::Execute)?;
		let mut queue_span: Option<tracing::Span> = Some(tracing::info_span!("omp.exec.queue"));
		let mut run_span: Option<tracing::Span> = None;
		let mut accepted = false;
		loop {
			let event = tokio::select! {
				event = run.next_event() => event,
				() = cancel.cancelled() => {
					let _ = run.cancel().await;
					return Err(ProductionError::Cancelled);
				},
			};
			match event {
				Some(ExecutionEvent::Accepted { .. }) => {
					drop(queue_span.take());
					run_span = Some(tracing::info_span!("omp.exec.run"));
					accepted = true;
				},
				Some(ExecutionEvent::Settled(Ok(result))) => {
					drop(run_span.take());
					let mut feedback =
						StrMut::new(format!("remote command exited {:?}\n", result.outcome));
					let download_bytes = if let Some(logs) = result.logs {
						let (stdout, stderr) = async {
							let stdout = backend
								.download_blob(logs.stdout)
								.await
								.map_err(RemoteError::Execute)?;
							let stderr = backend
								.download_blob(logs.stderr)
								.await
								.map_err(RemoteError::Execute)?;
							Ok::<_, ProductionError>((stdout, stderr))
						}
						.instrument(tracing::info_span!("omp.exec.download"))
						.await?;
						feedback.push_str("stdout:\n");
						feedback.push_str(&String::from_utf8_lossy(&stdout));
						feedback.push_str("\nstderr:\n");
						feedback.push_str(&String::from_utf8_lossy(&stderr));
						(stdout.len() + stderr.len()) as u64
					} else {
						0
					};
					let exit_code = match result.outcome {
						omp_exec::Outcome::Exited { code } => code,
						omp_exec::Outcome::Signalled { signal } => signal,
					};
					tracing::info!(
						{ exec_attrs::EXIT_CODE } = exit_code,
						{ exec_attrs::CACHE_HIT } = result.cache_hit,
						{ exec_attrs::DOWNLOAD_BYTES } = download_bytes,
						"execution settled"
					);
					for artifact in result.artifacts.iter() {
						let _ = materialize_artifact(&backend, &materialize_client, artifact).await?;
					}
					return Ok(super::PhaseResult {
						accepted:    result.outcome.is_success(),
						feedback:    feedback.freeze(),
						verdict:     None,
						independent: None,
					});
				},
				Some(ExecutionEvent::Settled(Err(error))) => {
					let stage = if accepted {
						Stage::AfterAcceptance
					} else {
						Stage::BeforeAcceptance
					};
					if fallback_eligible(&error, stage) {
						return Err(RemoteError::PreAcceptanceFailed(error).into());
					}
					return Err(RemoteError::Execute(error).into());
				},
				Some(_) => {},
				None => return Err(RemoteError::Manifest.into()),
			}
		}
	}
}

pub(crate) fn host_platform() -> Platform {
	#[cfg(target_arch = "aarch64")]
	let arch = omp_exec::Arch::Aarch64;
	#[cfg(not(target_arch = "aarch64"))]
	let arch = omp_exec::Arch::X86_64;
	#[cfg(target_os = "macos")]
	let os = omp_exec::Os::Macos;
	#[cfg(not(target_os = "macos"))]
	let os = omp_exec::Os::Linux;
	Platform { os, arch }
}

fn uuid_v4() -> String {
	use rand::RngExt as _;
	let mut rng = rand::rng();
	let bytes: [u8; 16] = rng.random();
	let first = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
	let second = u16::from_be_bytes([bytes[4], bytes[5]]);
	let third = u16::from_be_bytes([bytes[6], bytes[7]]) & 0x0fff;
	let fourth = u16::from_be_bytes([bytes[8], bytes[9]]) & 0x3fff | 0x8000;
	let tail =
		u64::from_be_bytes([0, 0, bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]]);
	format!("{first:08x}-{second:04x}-4{third:03x}-{fourth:04x}-{tail:012x}")
}

#[cfg(test)]
mod tests {
	use omp_exec_reapi::profile::{ArchSpelling, Profile};

	use super::*;

	#[test]
	fn only_remote_preferred_just_recipes_are_eligible() {
		assert!(eligible("just", &[Str::new_static("test-pkg")]));
		assert!(eligible("just", &[Str::new_static("clippy")]));
		assert!(!eligible("just", &[Str::new_static("e2e-p7")]));
		assert!(!eligible("cargo", &[Str::new_static("test")]));
		assert!(!eligible("just", &[Str::new_static("unknown")]));
	}

	#[test]
	fn operator_policy_and_upload_lists_are_typed_at_the_boundary() {
		assert_eq!("remote-only".parse::<AdwExecPolicy>(), Ok(AdwExecPolicy::RemoteOnly));
		assert_eq!(config_list(Str::new_static(" .env , *.key, ")), [".env", "*.key"]);
	}

	#[test]
	fn remote_execution_gate_default_is_not_accepted() {
		// ADR 0047: remote execution must be explicitly accepted.
		let ctx = Ctx::new();
		assert!(!SV_EXEC_ACCEPTED.get(&ctx));
	}

	#[test]
	fn uuid_has_v4_shape() {
		let value = uuid_v4();
		assert_eq!(value.len(), 36);
		assert_eq!(value.as_bytes()[14], b'4');
		assert!(matches!(value.as_bytes()[19], b'8'..=b'9' | b'a'..=b'b'));
	}

	fn remote_profile(ctx: &Ctx) -> Result<(Profile, omp_exec::CachePolicy), AdwRemoteError> {
		let settings = ExecutionSettings::for_adw(ctx)?;
		Ok(settings.resolved_profile()?)
	}

	#[test]
	fn refuse_action_cache_rejects_non_off_cache_policy() {
		let ctx = Ctx::new();
		SV_EXEC_REMOTE_ENDPOINT
			.set(&ctx, Str::new_static("grpcs://example.com"))
			.unwrap();
		SV_EXEC_REMOTE_IMAGE
			.set(&ctx, Str::new_static("image@sha256:abc"))
			.unwrap();
		SV_EXEC_REMOTE_PROFILE
			.set(&ctx, Str::new_static("operator"))
			.unwrap();
		SV_EXEC_REMOTE_REFUSE_ACTION_CACHE.set(&ctx, true).unwrap();
		SV_EXEC_REMOTE_CACHE
			.set(&ctx, Str::new_static("read"))
			.unwrap();
		let err = remote_profile(&ctx).unwrap_err();
		assert!(
			matches!(err, AdwRemoteError::Remote(RemoteError::CachePolicyConflict)),
			"got {err:?}",
		);
		SV_EXEC_REMOTE_CACHE
			.set(&ctx, Str::new_static("off"))
			.unwrap();
		assert!(remote_profile(&ctx).is_ok());
	}

	#[test]
	fn remote_profile_returns_the_cache_policy_it_validated() {
		let ctx = Ctx::new();
		SV_EXEC_REMOTE_ENDPOINT
			.set(&ctx, Str::new_static("grpcs://example.com"))
			.unwrap();
		SV_EXEC_REMOTE_IMAGE
			.set(&ctx, Str::new_static("image@sha256:abc"))
			.unwrap();
		SV_EXEC_REMOTE_PROFILE
			.set(&ctx, Str::new_static("reapi"))
			.unwrap();
		SV_EXEC_REMOTE_CACHE
			.set(&ctx, Str::new_static("read-write"))
			.unwrap();
		assert_eq!(
			remote_profile(&ctx).unwrap(),
			(Profile::reapi(), omp_exec::CachePolicy::ReadWrite)
		);

		SV_EXEC_REMOTE_CREDENTIAL_HEADER
			.set(&ctx, Str::new_static("x-buildbuddy-api-key"))
			.unwrap();
		SV_EXEC_REMOTE_ARCH_SPELLING
			.set(&ctx, Str::new_static("short"))
			.unwrap();
		SV_EXEC_REMOTE_FIXED_PROPERTIES
			.set(&ctx, Str::new_static("workload-isolation-type=oci"))
			.unwrap();
		SV_EXEC_REMOTE_REFUSE_ACTION_CACHE.set(&ctx, true).unwrap();
		let err = remote_profile(&ctx).unwrap_err();
		assert!(
			matches!(err, AdwRemoteError::Remote(RemoteError::CachePolicyConflict)),
			"got {err:?}"
		);

		SV_EXEC_REMOTE_CACHE
			.set(&ctx, Str::new_static("off"))
			.unwrap();
		let (profile, cache) = remote_profile(&ctx).unwrap();
		assert_eq!(profile.name.as_str(), "reapi");
		assert_eq!(profile.credential_header.as_deref(), Some("x-buildbuddy-api-key"));
		assert_eq!(profile.arch, ArchSpelling::Short);
		assert_eq!(
			profile
				.fixed
				.get("workload-isolation-type")
				.map(Str::as_str),
			Some("oci")
		);
		assert_eq!(cache, omp_exec::CachePolicy::Off);
		assert!(
			ExecutionSettings::for_adw(&ctx)
				.unwrap()
				.refuse_action_cache()
		);
	}
}
