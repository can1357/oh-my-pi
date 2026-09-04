//! Integration coverage for the local inference runtime.

#![cfg(feature = "local")]

use std::{
	fs,
	sync::{
		Arc,
		atomic::{AtomicUsize, Ordering},
	},
	time::{Duration, Instant},
};

#[cfg(feature = "local-applefm")]
use omp_ai::local::applefm::{AppleFm, AppleFmFeatureEvidence, AppleFmSupportState};
use omp_ai::local::{
	ArtifactSpec, ArtifactStore, LocalCancellation, LocalError, LocalErrorKind, LocalRuntime,
	MemoryPool,
};
use sha2::{Digest, Sha256};

#[test]
fn cancellation_prevents_load_and_memory_charge() {
	let loads = Arc::new(AtomicUsize::new(0));
	let observed = Arc::clone(&loads);
	let memory = Arc::new(MemoryPool::new(64));
	let runtime = LocalRuntime::new(
		move || {
			observed.fetch_add(1, Ordering::Relaxed);
			Ok(())
		},
		Arc::clone(&memory),
		32,
		1,
		Duration::ZERO,
	)
	.unwrap();
	let cancel = LocalCancellation::new();
	cancel.cancel();
	let error = runtime
		.acquire(&cancel)
		.err()
		.expect("cancelled acquisition must fail");
	assert_eq!(error.kind, LocalErrorKind::Cancelled);
	assert_eq!(loads.load(Ordering::Relaxed), 0);
	assert_eq!(memory.used(), 0);
}

#[test]
fn memory_reservations_and_failed_loads_release_capacity() {
	let memory = Arc::new(MemoryPool::new(64));
	let reservation = memory.reserve(48).unwrap();
	let overloaded = memory
		.reserve(17)
		.expect_err("reservation over the limit must fail");
	assert_eq!(overloaded.kind, LocalErrorKind::Overloaded);
	assert_eq!(memory.used(), 48);
	drop(reservation);
	assert_eq!(memory.used(), 0);

	let runtime = LocalRuntime::<()>::new(
		|| Err(LocalError::new(LocalErrorKind::Backend, "load failed")),
		Arc::clone(&memory),
		64,
		1,
		Duration::ZERO,
	)
	.unwrap();
	let failure = runtime
		.acquire(&LocalCancellation::new())
		.err()
		.expect("load must fail");
	assert_eq!(failure.kind, LocalErrorKind::Backend);
	assert_eq!(memory.used(), 0);
}

#[test]
fn admission_receipts_isolation_and_idle_unload_are_explicit() {
	let memory = Arc::new(MemoryPool::new(64));
	let runtime =
		LocalRuntime::new(|| Ok(7_u8), Arc::clone(&memory), 32, 1, Duration::ZERO).unwrap();
	let cancel = LocalCancellation::new();
	let first = runtime.acquire(&cancel).unwrap();
	assert_eq!(first.with_engine(|engine| Ok(*engine)).unwrap(), 7);
	let overloaded = runtime
		.acquire(&cancel)
		.err()
		.expect("second lease must backpressure");
	assert_eq!(overloaded.kind, LocalErrorKind::Overloaded);
	let first_receipt = first.receipt();
	assert!(!runtime.unload_if_idle(Instant::now()));
	drop(first);
	assert!(runtime.unload_if_idle(Instant::now()));
	assert_eq!(memory.used(), 0);
	let second = runtime.acquire(&cancel).unwrap();
	let second_receipt = second.receipt();
	assert!(second_receipt.request > first_receipt.request);
	assert!(second_receipt.model_instance > first_receipt.model_instance);
}

#[test]
fn artifacts_require_confined_exact_size_and_digest() {
	let directory = tempfile::tempdir().unwrap();
	let contents = b"verified local model";
	fs::write(directory.path().join("model.bin"), contents).unwrap();
	let digest: [u8; 32] = Sha256::digest(contents).into();
	let store = ArtifactStore::open(directory.path()).unwrap();
	let artifact = store
		.verify(
			&ArtifactSpec {
				path:   "model.bin".into(),
				bytes:  contents.len() as u64,
				sha256: digest,
			},
			&LocalCancellation::new(),
		)
		.unwrap();
	assert_eq!(artifact.receipt().bytes, contents.len() as u64);
	let escaped = store
		.verify(
			&ArtifactSpec { path: "../model.bin".into(), bytes: 0, sha256: [0; 32] },
			&LocalCancellation::new(),
		)
		.unwrap_err();
	assert_eq!(escaped.kind, LocalErrorKind::Artifact);
	let mismatch = store
		.verify(
			&ArtifactSpec {
				path:   "model.bin".into(),
				bytes:  contents.len() as u64,
				sha256: [0; 32],
			},
			&LocalCancellation::new(),
		)
		.unwrap_err();
	assert_eq!(mismatch.kind, LocalErrorKind::Artifact);

	#[cfg(unix)]
	{
		use std::os::unix::fs;

		fs::symlink(directory.path().join("model.bin"), directory.path().join("link.bin")).unwrap();
		let symlink = store
			.verify(
				&ArtifactSpec {
					path:   "link.bin".into(),
					bytes:  contents.len() as u64,
					sha256: digest,
				},
				&LocalCancellation::new(),
			)
			.unwrap_err();
		assert_eq!(symlink.kind, LocalErrorKind::Artifact);
	}
}

#[cfg(feature = "local-applefm")]
#[tokio::test]
async fn applefm_reports_honest_capabilities_and_precise_unavailability() {
	let evidence = AppleFm::availability_evidence().await.unwrap();
	assert!(evidence.streaming);
	assert!(!evidence.tools());
	assert!(!evidence.structured_generation());
	assert_eq!(evidence.tool_evidence, AppleFmFeatureEvidence::RequiresCompiledSwiftToolConformance,);
	assert_eq!(
		evidence.structured_generation_evidence,
		AppleFmFeatureEvidence::DynamicSchemaAbiUnverified,
	);
	assert_eq!(evidence.context_tokens, 4096);
	if evidence.state != AppleFmSupportState::Available {
		assert!(
			evidence
				.detail
				.as_ref()
				.is_some_and(|detail| !detail.is_empty())
		);
	}
	#[cfg(not(target_os = "macos"))]
	assert_eq!(evidence.state, AppleFmSupportState::UnsupportedOperatingSystem);
}
