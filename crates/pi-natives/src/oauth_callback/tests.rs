use std::{
	collections::BTreeMap,
	fs,
	path::PathBuf,
	sync::atomic::{AtomicU64, Ordering},
};

use anyhow::{Result, bail};
use parking_lot::Mutex as TestMutex;
use serde::{Deserialize, Serialize};

use super::*;

static TEST_SERIAL: TestMutex<()> = TestMutex::new(());
static TEMP_ID: AtomicU64 = AtomicU64::new(1);

pub(super) mod backend {
	use super::*;

	#[derive(Clone, Debug, Deserialize, Serialize)]
	#[serde(deny_unknown_fields)]
	pub(in crate::oauth_callback) struct Snapshot {
		version: u32,
		id:      String,
		scheme:  String,
	}

	pub(in crate::oauth_callback) fn prepare(context: &Context) -> Result<Snapshot> {
		context.check()?;
		fs::write(context.directory.join("prepared"), b"private preparation")?;
		if context.env.contains_key("TEST_PREPARE_FAIL") {
			bail!("injected prepare failure");
		}
		Ok(Snapshot { version: 1, id: context.id.clone(), scheme: context.scheme.clone() })
	}

	pub(in crate::oauth_callback) fn activate(context: &Context, snapshot: &Snapshot) -> Result<()> {
		validate(context, snapshot)?;
		fs::write(owner_path(context), snapshot.id.as_bytes())?;
		if context.env.contains_key("TEST_ACTIVATE_FAIL") {
			bail!("injected activation failure after mutation");
		}
		Ok(())
	}

	pub(in crate::oauth_callback) fn restore(context: &Context, snapshot: &Snapshot) -> Result<()> {
		validate(context, snapshot)?;
		if context.env.contains_key("TEST_RESTORE_FAIL") {
			bail!("injected uncertain restoration");
		}
		let owner = owner_path(context);
		match fs::read_to_string(&owner) {
			Ok(observed) if observed == snapshot.id => fs::remove_file(owner)?,
			Ok(_) => bail!("registration ownership changed externally"),
			Err(error) if error.kind() == io::ErrorKind::NotFound => {},
			Err(error) => return Err(error.into()),
		}
		Ok(())
	}

	fn validate(context: &Context, snapshot: &Snapshot) -> Result<()> {
		if snapshot.version != 1 || snapshot.id != context.id || snapshot.scheme != context.scheme {
			bail!("invalid fake snapshot");
		}
		Ok(())
	}

	fn owner_path(context: &Context) -> PathBuf {
		context
			.home
			.join(format!(".oauth-owner-{}", context.scheme))
	}
}

fn temp_home(label: &str) -> PathBuf {
	let id = TEMP_ID.fetch_add(1, Ordering::Relaxed);
	let path =
		std::env::temp_dir().join(format!("pi-native-oauth-{label}-{}-{id}", std::process::id()));
	fs::create_dir_all(&path).unwrap();
	path
}

fn environment(extra: &[(&str, &str)]) -> BTreeMap<String, String> {
	let mut env = BTreeMap::from([("DISPLAY".to_owned(), ":test".to_owned())]);
	env.extend(
		extra
			.iter()
			.map(|(key, value)| ((*key).to_owned(), (*value).to_owned())),
	);
	env
}

fn core(home: PathBuf, env: BTreeMap<String, String>) -> Core {
	Core {
		home,
		scheme: "omp-test".to_owned(),
		env,
		state: Mutex::new(State {
			phase:     Phase::Idle,
			waits:     BTreeMap::new(),
			next_wait: 1,
			next_op:   1,
		}),
		operation: Mutex::new(()),
	}
}

fn active(result: StartOutcome) -> Box<Registration> {
	match result {
		StartOutcome::Active(registration) => registration,
		StartOutcome::Unsupported => panic!("test environment must be supported"),
	}
}

#[test]
fn invalid_scheme_is_rejected_before_filesystem_access() {
	let _serial = TEST_SERIAL.lock();
	assert!(validate_scheme("../another-handler").is_err());
	assert!(validate_scheme("OMP").is_err());
	assert!(validate_scheme("omp+oauth.test").is_ok());
}

#[test]
fn remote_start_is_unsupported_without_creating_storage() {
	let _serial = TEST_SERIAL.lock();
	let home = temp_home("remote");
	let core = core(home.clone(), environment(&[("SSH_CONNECTION", "remote")]));
	assert!(matches!(
		start_blocking(&core, CancelToken::default()).unwrap(),
		StartOutcome::Unsupported
	));
	assert!(!home.join(".omp").exists());
	fs::remove_dir_all(home).unwrap();
}

#[test]
fn prepare_failure_releases_lease_and_removes_private_artifacts() {
	let _serial = TEST_SERIAL.lock();
	let home = temp_home("prepare");
	let failing = core(home.clone(), environment(&[("TEST_PREPARE_FAIL", "1")]));
	assert!(start_blocking(&failing, CancelToken::default()).is_err());
	let succeeding = core(home.clone(), environment(&[]));
	let mut registration = active(start_blocking(&succeeding, CancelToken::default()).unwrap());
	cleanup_registration(&mut registration, CancelToken::default()).unwrap();
	fs::remove_dir_all(home).unwrap();
}

#[test]
fn activation_failure_restores_even_after_mutating_os_state() {
	let _serial = TEST_SERIAL.lock();
	let home = temp_home("activation");
	let core = core(home.clone(), environment(&[("TEST_ACTIVATE_FAIL", "1")]));
	let error = start_blocking(&core, CancelToken::default())
		.err()
		.expect("activation should fail");
	assert!(error.to_string().contains("injected activation failure"));
	assert!(!home.join(".oauth-owner-omp-test").exists());
	assert!(
		!storage_root(&home, "omp-test")
			.join("registration.json")
			.exists()
	);
	fs::remove_dir_all(home).unwrap();
}

#[test]
fn uncertain_restore_retains_journal_and_ownership() {
	let _serial = TEST_SERIAL.lock();
	let home = temp_home("restore");
	let core =
		core(home.clone(), environment(&[("TEST_ACTIVATE_FAIL", "1"), ("TEST_RESTORE_FAIL", "1")]));
	let error = start_blocking(&core, CancelToken::default())
		.err()
		.expect("restoration should fail");
	assert!(error.to_string().contains("recovery journal retained"));
	assert!(home.join(".oauth-owner-omp-test").exists());
	assert!(
		storage_root(&home, "omp-test")
			.join("registration.json")
			.exists()
	);
	fs::remove_dir_all(home).unwrap();
}

#[test]
fn stale_journal_is_recovered_before_successor_activation() {
	let _serial = TEST_SERIAL.lock();
	let home = temp_home("stale");
	let root = storage_root(&home, "omp-test");
	ensure_storage_root(&root).unwrap();
	let old_id = "0123456789abcdef0123456789abcdef";
	let old_env = environment(&[]);
	let old_context = Context::new(
		home.clone(),
		root.join(old_id),
		"omp-test".to_owned(),
		old_id.to_owned(),
		old_env.clone(),
		CancelToken::default(),
	);
	ensure_private_dir(&old_context.directory).unwrap();
	let snapshot = backend::prepare(&old_context).unwrap();
	backend::activate(&old_context, &snapshot).unwrap();
	let journal = Journal {
		version: JOURNAL_VERSION,
		id: old_id.to_owned(),
		scheme: "omp-test".to_owned(),
		environment: journal_environment(&old_env),
		snapshot,
	};
	atomic_write(&root.join("registration.json"), &serde_json::to_vec(&journal).unwrap(), 0o600)
		.unwrap();

	let core = core(home.clone(), environment(&[]));
	let mut registration = active(start_blocking(&core, CancelToken::default()).unwrap());
	assert_ne!(registration.context.id, old_id);
	assert_eq!(
		fs::read_to_string(home.join(".oauth-owner-omp-test")).unwrap(),
		registration.context.id
	);
	cleanup_registration(&mut registration, CancelToken::default()).unwrap();
	fs::remove_dir_all(home).unwrap();
}

#[test]
fn lease_excludes_competing_receivers_in_same_process() {
	let _serial = TEST_SERIAL.lock();
	let home = temp_home("compete");
	let first = core(home.clone(), environment(&[]));
	let second = core(home.clone(), environment(&[]));
	let mut registration = active(start_blocking(&first, CancelToken::default()).unwrap());
	assert!(
		start_blocking(&second, CancelToken::default())
			.err()
			.expect("competing acquisition should fail")
			.to_string()
			.contains("another process owns")
	);
	cleanup_registration(&mut registration, CancelToken::default()).unwrap();
	fs::remove_dir_all(home).unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn cancellation_prevents_start_and_wait_claims_once() {
	let _serial = TEST_SERIAL.lock();
	let home = temp_home("cancel");
	let core = core(home.clone(), environment(&[]));
	let mut cancel = CancelToken::default();
	cancel.emplace_abort_token().abort(AbortReason::User);
	assert!(start_blocking(&core, cancel).is_err());
	assert!(!home.join(".omp").exists());

	let callback = home.join("callback.url");
	fs::write(&callback, b"omp-test://callback?code=one").unwrap();
	let url = wait_for_callback_async(
		&callback,
		"omp-test",
		"0123456789abcdef0123456789abcdef",
		1,
		&CancelToken::default(),
	)
	.await
	.unwrap();
	assert_eq!(url, "omp-test://callback?code=one");
	assert!(!callback.exists());
	let mut cancelled_wait = CancelToken::default();
	cancelled_wait
		.emplace_abort_token()
		.abort(AbortReason::User);
	assert!(
		wait_for_callback_async(
			&callback,
			"omp-test",
			"0123456789abcdef0123456789abcdef",
			2,
			&cancelled_wait,
		)
		.await
		.is_err()
	);
	fs::remove_dir_all(home).unwrap();
}

#[test]
fn journal_rejects_traversal_and_unknown_fields() {
	let _serial = TEST_SERIAL.lock();
	assert!(validate_transaction_id("../escape").is_err());
	let json = br#"{
		"version":1,
		"id":"0123456789abcdef0123456789abcdef",
		"scheme":"omp-test",
		"environment":{},
		"snapshot":{"version":1,"id":"0123456789abcdef0123456789abcdef","scheme":"omp-test"},
		"extra":true
	}"#;
	assert!(serde_json::from_slice::<Journal>(json).is_err());
}
