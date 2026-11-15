//! Native reply admission and canonical context fault boundaries.

use omp_proto::env::v1::{InputExclusion, InputRefusal};

use super::*;

fn capture_reply() -> CaptureInputsReply {
	CaptureInputsReply {
		manifest_hash: vec![7; 32].into(),
		manifest_size: 64,
		files: 1,
		bytes: 8,
		wire_revision: omp_proto::SCHEMA_REV,
		..Default::default()
	}
}

#[test]
fn malformed_capture_identity_cannot_be_admitted() {
	let mut wrong_schema = capture_reply();
	wrong_schema.wire_revision = omp_proto::SCHEMA_REV.wrapping_add(1);
	let mut short_hash = capture_reply();
	short_hash.manifest_hash = vec![0; 31].into();
	let mut long_hash = capture_reply();
	long_hash.manifest_hash = vec![0; 33].into();
	let mut short_manifest = capture_reply();
	short_manifest.manifest_size = 10;
	for reply in [wrong_schema, short_hash, long_hash, short_manifest] {
		assert!(matches!(capture_digest(&reply), Err(SnapshotError::InvalidCapture)));
	}
	let mut empty = capture_reply();
	empty.files = 0;
	assert!(matches!(capture_digest(&empty), Err(SnapshotError::EmptyCapture)));
}

#[test]
fn native_omissions_cannot_masquerade_as_complete_capture() {
	let mut reply = capture_reply();
	reply
		.refused
		.push(InputRefusal { path: "tracked.env".into(), rule: "credential".into() });
	assert!(matches!(
		capture_digest(&reply),
		Err(SnapshotError::Refused { path, rule })
			if path == "tracked.env" && rule == "credential"
	));
	let mut reply = capture_reply();
	reply
		.excluded_rules
		.push(InputExclusion { rule: "credential".into(), files: 2 });
	assert!(matches!(capture_digest(&reply), Err(SnapshotError::Excluded { files: 2, .. })));
	let mut reply = capture_reply();
	reply.excluded_symlinks = 3;
	assert!(matches!(capture_digest(&reply), Err(SnapshotError::ExcludedSymlinks { count: 3 })));
	let mut reply = capture_reply();
	reply
		.excluded_rules
		.push(InputExclusion { rule: "inactive".into(), files: 0 });
	assert!(capture_digest(&reply).is_ok(), "zero omissions do not make evidence incomplete");
}

fn repository_reply() -> RepositorySnapshot {
	RepositorySnapshot {
		availability: RepositoryAvailability::Available as i32,
		worktree_root_uri: "file:///workspace/project".into(),
		primary_root_uri: "file:///workspace/project".into(),
		head: "0123456789abcdef".into(),
		branch: "omp2".into(),
		..Default::default()
	}
}

#[test]
fn repository_request_counter_is_not_a_source_generation() {
	let original = repository_reply();
	let mut later_request = original.clone();
	later_request.revision = 99;
	assert_eq!(
		repository_identity(&original).unwrap(),
		repository_identity(&later_request).unwrap()
	);
	for mutate in [
		|reply: &mut RepositorySnapshot| reply.head = "different-head".into(),
		|reply: &mut RepositorySnapshot| reply.worktree_root_uri = "file:///other".into(),
		|reply: &mut RepositorySnapshot| reply.primary_root_uri = "file:///other".into(),
		|reply: &mut RepositorySnapshot| reply.branch = "different-branch".into(),
		|reply: &mut RepositorySnapshot| reply.staged += 1,
		|reply: &mut RepositorySnapshot| reply.unstaged += 1,
		|reply: &mut RepositorySnapshot| reply.untracked += 1,
	] {
		let mut changed = original.clone();
		mutate(&mut changed);
		assert_ne!(repository_identity(&original).unwrap(), repository_identity(&changed).unwrap());
	}
}

#[test]
fn observed_capture_drift_refuses_applicability_without_timing_assumptions() {
	let first = capture_reply();
	let before = repository_identity(&repository_reply()).unwrap();
	let mutations: [fn(&mut CaptureInputsReply); 4] = [
		|reply| reply.manifest_hash = vec![8; 32].into(),
		|reply| reply.manifest_size += 1,
		|reply| reply.files += 1,
		|reply| reply.bytes += 1,
	];
	for mutate in mutations {
		let mut second = first.clone();
		mutate(&mut second);
		assert!(matches!(
			admit_stable_capture(&first, &second, &before, &before),
			Err(SnapshotError::ChangedDuringCapture)
		));
	}
	let mutations: [fn(&mut RepositorySnapshot); 7] = [
		|reply| reply.head = "different-head".into(),
		|reply| reply.worktree_root_uri = "file:///other".into(),
		|reply| reply.primary_root_uri = "file:///other".into(),
		|reply| reply.branch = "different-branch".into(),
		|reply| reply.staged += 1,
		|reply| reply.unstaged += 1,
		|reply| reply.untracked += 1,
	];
	for mutate in mutations {
		let mut reply = repository_reply();
		mutate(&mut reply);
		let after = repository_identity(&reply).unwrap();
		assert!(matches!(
			admit_stable_capture(&first, &first, &before, &after),
			Err(SnapshotError::ChangedDuringCapture)
		));
	}
	let mut later_request = repository_reply();
	later_request.revision = 99;
	let after = repository_identity(&later_request).unwrap();
	assert!(admit_stable_capture(&first, &first, &before, &after).is_ok());
}

#[test]
fn unavailable_or_partial_repository_metadata_is_not_evidence() {
	for mutate in [
		|reply: &mut RepositorySnapshot| reply.availability = 0,
		|reply: &mut RepositorySnapshot| reply.head.clear(),
		|reply: &mut RepositorySnapshot| reply.worktree_root_uri.clear(),
		|reply: &mut RepositorySnapshot| reply.primary_root_uri.clear(),
		|reply: &mut RepositorySnapshot| reply.truncated = true,
	] {
		let mut reply = repository_reply();
		mutate(&mut reply);
		assert!(matches!(repository_identity(&reply), Err(SnapshotError::RepositoryUnavailable)));
	}
}

fn known_context() -> SnapshotContext {
	let known = Some(Hash32::sum(b"explicitly established input category"));
	SnapshotContext {
		dependencies: known,
		toolchain: known,
		environment: known,
		tests: known,
		requirements: known,
		policy: known,
		verifier: known,
		..Default::default()
	}
}

#[test]
fn no_context_category_can_silently_default_to_empty() {
	let fields: [(ContextField, fn(&mut SnapshotContext)); 7] = [
		(ContextField::Dependencies, |context| context.dependencies = None),
		(ContextField::Toolchain, |context| context.toolchain = None),
		(ContextField::Environment, |context| context.environment = None),
		(ContextField::Tests, |context| context.tests = None),
		(ContextField::Requirements, |context| context.requirements = None),
		(ContextField::Policy, |context| context.policy = None),
		(ContextField::Verifier, |context| context.verifier = None),
	];
	for (expected, clear) in fields {
		let mut context = known_context();
		clear(&mut context);
		assert!(matches!(
			ClosedContext::try_from(&context),
			Err(SnapshotError::UnknownContext { field }) if field == expected
		));
	}
	let mut context = known_context();
	context.unresolved_inputs = vec![Str::new_static("unresolved generated fixture")].into();
	assert!(matches!(
		ClosedContext::try_from(&context),
		Err(SnapshotError::UnresolvedInputs { .. })
	));
}

#[test]
fn required_paths_are_normalized_relative_identities() {
	for invalid in [
		"",
		"/source.rs",
		"../source.rs",
		"src/../source.rs",
		"./source.rs",
		"src//a",
		"src/",
		"C:/source.rs",
		"src\\a",
		"src/\0a",
	] {
		let mut context = known_context();
		context.required_paths = vec![Str::new(invalid)].into();
		assert!(matches!(
			ClosedContext::try_from(&context),
			Err(SnapshotError::InvalidRequiredPath { path }) if path == invalid
		));
	}
	let mut context = known_context();
	context.required_paths =
		vec![Str::new_static("src/z.rs"), Str::new_static("src/a.rs"), Str::new_static("src/z.rs")]
			.into();
	let closed = ClosedContext::try_from(&context).unwrap();
	assert_eq!(closed.required_paths.into_iter().collect::<Vec<_>>(), vec![
		Str::new_static("src/a.rs"),
		Str::new_static("src/z.rs")
	]);
}
