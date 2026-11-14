//! ADR 0050 S2 exit: fold refuses built-ins and unclaimed registrations;
//! declared reads return the handler body; collisions name both owners;
//! built-in `pr://` remains outside the declared-scheme generation.

use std::sync::Arc;

use async_trait::async_trait;
use omp_core::Str;
use omp_envd::{
	HostResourceResult, HostResources, SchemeClaim, SchemeFoldError, SchemeGeneration,
	WRITE_NOT_ENABLED, tool_url::scheme_generation::SchemeTestReader,
};
use omp_py::{
	Engine,
	pyo3::{ffi::c_str, types::PyDict},
};
use omp_tools::read::resolver::Scheme;

fn claim(name: &str) -> SchemeClaim {
	SchemeClaim {
		scheme:      Str::new(name),
		description: None,
		writable:    false,
		immutable:   false,
	}
}

struct FixedReader {
	body: String,
}

#[async_trait]
impl SchemeTestReader for FixedReader {
	async fn read(&self, _scheme: &str, _url: &str) -> Result<HostResourceResult, Str> {
		Ok(HostResourceResult { content: Some(self.body.clone()), notes: Vec::new() })
	}
}

#[test]
fn declared_scheme_fold_refuses_builtin_and_unclaimed() {
	let generation = SchemeGeneration::new();
	for spelling in ["https", "pr", "HTTPS", "Pr"] {
		let error = generation
			.replace_owner("acme.widgets", None, vec![claim(spelling)])
			.expect_err(spelling);
		assert!(matches!(error, SchemeFoldError::Builtin { .. }), "{spelling}: {error:?}");
	}
	assert!(generation.snapshot().is_empty());
	assert!(SchemeGeneration::is_builtin_wire_name("pr"));
	assert!(!matches!(Scheme::parse("pr"), Scheme::Unknown));

	let engine = Engine::builder().init().expect("embedded Python boots");
	engine
		.attach(|py| {
			let globals = PyDict::new(py);
			py.run(
				c_str!(
					r#"
import omp.schemes as schemes

schemes.configure_claims([{"name": "widget", "immutable": True}])
schemes.register("widget")
error = None
try:
    schemes.register("gadget")
except schemes.UnclaimedSchemeError as raised:
    error = raised
assert error is not None, "unclaimed register must be refused"
assert "gadget" in str(error)
assert schemes.declared()[-1].name == "widget"
schemes.configure_claims(None)
"#
				),
				Some(&globals),
				None,
			)
		})
		.expect("unclaimed register refuse");
}

#[tokio::test]
async fn declared_scheme_read_returns_handler_body() {
	let generation = SchemeGeneration::new();
	generation
		.replace_owner("acme.widgets", None, vec![claim("widget")])
		.expect("fold widget");
	generation.bind_test_reader(Arc::new(FixedReader { body: String::from("widget body") }));
	let read = HostResources::resolve_read(&generation, "widget://id")
		.await
		.expect("read");
	assert_eq!(read.content.as_deref(), Some("widget body"));
	let write = HostResources::resolve_write(&generation, "widget://id", String::from("x"))
		.await
		.expect_err("writes refused in S2");
	assert_eq!(write.as_str(), WRITE_NOT_ENABLED);
}

#[test]
fn second_extension_claim_collision_names_both_owners() {
	let generation = SchemeGeneration::new();
	generation
		.replace_owner("acme.widgets", None, vec![claim("widget")])
		.expect("first");
	let error = generation
		.replace_owner("other.ext", None, vec![claim("widget")])
		.expect_err("collision");
	assert_eq!(error, SchemeFoldError::Collision {
		scheme:   Str::new_static("widget"),
		existing: Str::new_static("acme.widgets"),
		claimant: Str::new_static("other.ext"),
	});
	let message = error.to_string();
	assert!(message.contains("acme.widgets"), "{message}");
	assert!(message.contains("other.ext"), "{message}");
}

#[test]
fn pr_scheme_stays_builtin_dense_and_refused_at_fold() {
	assert!(!matches!(Scheme::parse("pr"), Scheme::Unknown));
	assert!(SchemeGeneration::is_builtin_wire_name("pr"));
	let generation = SchemeGeneration::new();
	let error = generation
		.replace_owner("forge.adapter", None, vec![claim("pr")])
		.expect_err("pr is dense, not declared");
	assert!(matches!(error, SchemeFoldError::Builtin { .. }), "{error:?}");
	assert!(generation.snapshot().is_empty());
}
