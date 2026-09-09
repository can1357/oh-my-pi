//! Engagement-layer precedence contracts.

use omp_con::{Ctx, Origin, Value};
use omp_core::Str;

omp_con::var! {
	/// Layer precedence target.
	pub static LAYERED = test_layered: i32 {
		default: 1,
		flags: archive | session,
	};
}

#[test]
fn test_engagement_bind_shadows_and_pops_by_derivation() {
	let ctx = Ctx::new();
	ctx.set("test_layered", Value::Int(2), Origin::Archive)
		.unwrap();
	let layer =
		ctx.push_layer(Str::new_static("plan"), &[(Str::new_static("test_layered"), Value::Int(9))]);
	assert_eq!(ctx.get("test_layered"), Some(Value::Int(9)));
	ctx.pop_layer(layer);
	assert_eq!(ctx.get("test_layered"), Some(Value::Int(2)));
}

#[test]
fn test_shadowed_user_write_commits_and_surfaces_on_exit() {
	let ctx = Ctx::new();
	let layer =
		ctx.push_layer(Str::new_static("goal"), &[(Str::new_static("test_layered"), Value::Int(8))]);
	let report = ctx
		.set("test_layered", Value::Int(4), Origin::Script(Str::new_static("console")))
		.unwrap();
	assert_eq!(report.committed_to, Origin::Session);
	assert_eq!(report.shadowed_by, Some((layer, Str::new_static("goal"))));
	assert_eq!(ctx.get("test_layered"), Some(Value::Int(8)));
	ctx.pop_layer(layer);
	assert_eq!(ctx.get("test_layered"), Some(Value::Int(4)));
}

#[test]
fn test_layers_stack_innermost_last_and_pop_independently() {
	let ctx = Ctx::new();
	let outer =
		ctx.push_layer(Str::new_static("outer"), &[(Str::new_static("test_layered"), Value::Int(5))]);
	let inner =
		ctx.push_layer(Str::new_static("inner"), &[(Str::new_static("test_layered"), Value::Int(6))]);
	assert_eq!(ctx.get("test_layered"), Some(Value::Int(6)));
	ctx.pop_layer(outer);
	assert_eq!(ctx.get("test_layered"), Some(Value::Int(6)));
	ctx.pop_layer(inner);
	assert_eq!(ctx.get("test_layered"), Some(Value::Int(1)));
}

#[test]
fn test_unshadowed_write_reports_nothing() {
	let ctx = Ctx::new();
	let report = ctx
		.set("test_layered", Value::Int(3), Origin::Session)
		.unwrap();
	assert_eq!(report.committed_to, Origin::Session);
	assert_eq!(report.shadowed_by, None);
	assert_eq!(ctx.get("test_layered"), Some(Value::Int(3)));
	assert_eq!(ctx.seed_child().get("test_layered"), Some(&Value::Int(3)));
}
