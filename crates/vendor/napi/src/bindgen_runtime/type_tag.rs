use crate::sys;

/// Unforgeable per-class identity for `#[napi]` classes.
///
/// Every `#[napi]` struct that becomes a JS class gets a derive-generated
/// `impl TypeTag`, whose [`type_tag`](TypeTag::type_tag) returns a stable
/// 128-bit value derived from the class's **content identity string**
/// (`crate@version::module_path::ClassName`, see [`type_tag_from_ident`]).
/// Content derivation makes the tag identical across process reload and across
/// two separately-loaded copies of the same addon (Node's documented type-tag
/// contract), while staying per-class unique because Rust forbids duplicate
/// `module_path::ident` — so two *distinct* Rust classes always get distinct
/// identity strings, hence distinct tags, even when they share the same
/// `js_name` and namespace. The tag is stamped onto each instance's JS object
/// right after `napi_wrap` and verified before every blind pointer cast, so a
/// wrong-class / prototype-spoofed / `method.call(wrongThis)` object is rejected
/// instead of causing a type-confused cast.
///
/// This trait is defined **unconditionally** (in every build, regardless of the
/// `napi8` feature) so that generic `where T: TypeTag` bounds always type-check.
/// The actual stamping/checking is performed by [`tag_object`] /
/// [`validate_type_tag`], which only do real work under the `napi8` feature.
///
/// # Opting into a crate-unique salt: `#[napi(type_tag = "…")]`
///
/// The default identity string keys on `crate@version`, so two *unrelated*
/// addons that happen to share the same crate name **and** version **and**
/// module path **and** class name would derive the same tag. If that collision
/// worries you (e.g. a widely-vendored crate name), annotate the class with
/// `#[napi(type_tag = "…")]`:
///
/// ```ignore
/// #[napi(type_tag = "6f9619ff-8b86-d011-b42d-00cf4fc964ff")]
/// pub struct MyClass { /* … */ }
/// ```
///
/// The supplied string (a UUID is recommended) **replaces** the `crate@version`
/// component of the identity string — the derived tag becomes
/// `type_tag_from_ident("SALT::module_path::ClassName")`. `module_path` and the
/// class name are still folded in, so the salt only needs crate-level global
/// uniqueness; two classes in the same crate can never share a tag even with the
/// same salt. Like the default, the salted form is a compile-time constant, so
/// the tag stays stable across process reload / dual-load. The attribute is
/// runtime-only and never appears in the generated TypeScript.
pub trait TypeTag {
  /// Returns this class's stable per-type tag. The derive computes it from the
  /// class's content identity string (`crate@version::module_path::ClassName`),
  /// which is fixed for a given class, so repeated calls return the same tag.
  fn type_tag() -> sys::napi_type_tag;
}

/// Build a stable per-class 128-bit [`sys::napi_type_tag`] from a content
/// identity string (`crate@version::module_path::ClassName`). Content-derived,
/// so a class's tag is identical across process reload and across two loaded
/// copies of the same addon (Node's documented type-tag contract), while
/// staying per-class unique because Rust forbids duplicate `module_path::ident`.
///
/// `const fn` (pure arithmetic, no `napi8` dependency) so the derive-generated
/// `type_tag()` folds at compile time in every build.
pub const fn type_tag_from_ident(ident: &str) -> sys::napi_type_tag {
  // 128-bit FNV-1a.
  const FNV_OFFSET: u128 = 0x6c62272e07bb0142_62b821756295c58d;
  const FNV_PRIME: u128 = 0x0000000001000000_000000000000013B;
  let bytes = ident.as_bytes();
  let mut hash = FNV_OFFSET;
  let mut i = 0;
  while i < bytes.len() {
    hash ^= bytes[i] as u128;
    hash = hash.wrapping_mul(FNV_PRIME);
    i += 1;
  }
  sys::napi_type_tag {
    lower: hash as u64,
    upper: (hash >> 64) as u64,
  }
}

/// Marker bound used by the runtime generics (`ClassInstance<T>`, `Reference<T>`,
/// `new_instance`, `CallbackInfo`/`ClassAccessorCallbackInfo` helpers) in place
/// of a bare `T: TypeTag` bound.
///
/// Its meaning is cfg-split exactly once, on the same **napi8-native** predicate
/// that gates the real [`tag_object`] / [`validate_type_tag`] bodies:
///
/// * On **napi8 native** targets it is a supertrait alias for [`TypeTag`], so a
///   `T: MaybeTypeTag` bound implies `T: TypeTag` and the (napi8-native-only)
///   tag calls in those generic bodies can name `T::type_tag()`.
/// * Without `napi8`, **and on all wasm targets**, it is a vacuous blanket bound
///   satisfied by every `T`, so the runtime generics do **not** narrow the
///   public API — their signatures stay byte-identical to the pre-tag versions,
///   and generic-over-class-`T` consumer code keeps compiling without any tag
///   bound. This mirrors tagging being a **no-op on wasm** (see [`tag_object`]):
///   no tag is ever stamped or checked there, so requiring `T: TypeTag` on wasm
///   would narrow `Reference<T>` / `ClassInstance<T>` / `new_instance<T>` for
///   zero benefit — the marker must stay vacuous for wasm / manual class
///   wrappers.
///
/// The blanket impl over `T: TypeTag` (napi8 native) / over all `T` (otherwise,
/// including every wasm target) is a separate trait from `TypeTag`, so it never
/// conflicts with the derive-generated `impl TypeTag for #name`.
#[cfg(all(feature = "napi8", not(target_family = "wasm")))]
pub trait MaybeTypeTag: TypeTag {}
#[cfg(all(feature = "napi8", not(target_family = "wasm")))]
impl<T: TypeTag> MaybeTypeTag for T {}

/// See the napi8-native variant above. Without `napi8`, and on **all** wasm
/// targets, this is a vacuous marker implemented for every `T`, so it never
/// narrows a public signature.
#[cfg(not(all(feature = "napi8", not(target_family = "wasm"))))]
pub trait MaybeTypeTag {}
#[cfg(not(all(feature = "napi8", not(target_family = "wasm"))))]
impl<T> MaybeTypeTag for T {}

/// Stamp `obj` with the class type tag `tag` (right after `napi_wrap`).
///
/// Hand-rolled `napi_wrap` wrappers should prefer [`wrap_and_tag`], which does
/// the wrap and this stamp in one step so their (V8-unguarded) field accessors
/// and `&T` params pass the tag check.
///
/// # Safety
///
/// `env` must be a valid napi env pointer and `obj` a valid js object that has
/// not already been tagged.
///
/// # Note on gating
///
/// This helper is defined **unconditionally** with a body gated to
/// `all(feature = "napi8", not(target_family = "wasm"))` (a no-op that returns
/// `Ok(())` on every other build). It is deliberately *not* plain
/// `#[cfg(feature = "napi8")]`, because it is also invoked from
/// derive-generated code that expands in the consumer crate, where a
/// `#[cfg(feature = "napi8")]` attribute would resolve against the *consumer*
/// crate's features (which typically do not include a `napi8` feature) rather
/// than napi's. Gating happens here, inside the napi crate, where the feature
/// is visible.
///
/// # Note on wasm
///
/// Tagging is a **no-op on wasm**. The content-derived tag itself would be valid
/// on wasm (it keys on `crate@version::module_path::ClassName`, not a
/// linear-memory offset), but Node-API type-tag support on wasm/emnapi is
/// host-dependent (the `napi_type_tag_object` extern may be unresolved), so the
/// binding keeps its pre-tag behavior on wasm (blind cast, or `instanceof` under
/// `strict`) — no worse than before this feature, and no unresolved-symbol risk.
#[cfg(all(feature = "napi8", not(target_family = "wasm")))]
pub unsafe fn tag_object(
  env: sys::napi_env,
  obj: sys::napi_value,
  tag: &sys::napi_type_tag,
) -> crate::Result<()> {
  crate::check_status!(
    unsafe { sys::napi_type_tag_object(env, obj, tag) },
    "Failed to tag object with class identity"
  )
}

/// No-op fallback for builds without `napi8`, and for **all** wasm builds (see
/// the "Note on wasm" on the real variant for the wasm rationale). Defined
/// unconditionally for the same reason as the real variant.
///
/// # Safety
///
/// Always safe; the arguments are ignored.
#[cfg(not(all(feature = "napi8", not(target_family = "wasm"))))]
#[inline(always)]
pub unsafe fn tag_object(
  _env: sys::napi_env,
  _obj: sys::napi_value,
  _tag: &sys::napi_type_tag,
) -> crate::Result<()> {
  Ok(())
}

/// Wrap `native` into `js_obj` and stamp it with `T`'s class type tag in one
/// step — the supported path for hand-rolled `napi_wrap` wrappers so their own
/// (V8-unguarded) field accessors and `&T` params pass the tag check instead of
/// throwing "Value is not an instance of class `T`".
///
/// The tag stamp is a **no-op** on builds without `napi8` and on **all** wasm
/// targets (same story as [`tag_object`]); on those targets this is exactly a
/// bare `napi_wrap`. Passes `None` as the finalizer, so the JS engine never owns
/// `native` — the caller owns its cleanup in every case (on success, later via
/// `napi_remove_wrap`; on error, immediately).
///
/// The wrap + tag are **atomic**: if tagging fails after the wrap succeeded, the
/// wrap is rolled back (`napi_remove_wrap`) before returning the error, so
/// `js_obj` is never left holding `native`. Without that rollback the caller's
/// error-path free of `native` would leave `js_obj` wrapping dangling memory,
/// and the next `napi_unwrap` would be a use-after-free.
///
/// # Safety
/// `env` valid; `js_obj` a valid, not-yet-wrapped JS object; `native` a live
/// pointer to a `T`. `native` stays owned by the caller (`None` finalizer).
pub unsafe fn wrap_and_tag<T: TypeTag>(
  env: sys::napi_env,
  js_obj: sys::napi_value,
  native: *mut std::ffi::c_void,
) -> crate::Result<()> {
  crate::check_status!(
    unsafe {
      sys::napi_wrap(
        env,
        js_obj,
        native,
        None,
        std::ptr::null_mut(),
        std::ptr::null_mut(),
      )
    },
    "Failed to wrap native object for manual class tagging"
  )?;
  // Atomic wrap+tag: if tagging fails, undo the wrap so `js_obj` is not left
  // holding `native`. The caller frees `native` on error (JS never owns it via
  // the `None` finalizer), so a lingering wrap would dangle on the next unwrap.
  // On non-napi8 / wasm, `tag_object` is an infallible no-op, so this rollback
  // branch is dead there and the call is a bare `napi_wrap`.
  if let Err(err) = unsafe { tag_object(env, js_obj, &<T as TypeTag>::type_tag()) } {
    let mut unwrapped = std::ptr::null_mut();
    // Best-effort detach; the caller owns and will free `native`.
    let _ = unsafe { sys::napi_remove_wrap(env, js_obj, &mut unwrapped) };
    return Err(err);
  }
  Ok(())
}

/// Verify that `obj` carries the class type tag `tag`. On mismatch, returns a
/// catchable [`crate::Status::InvalidArg`] error instead of allowing a
/// type-confused pointer cast.
///
/// # Safety
///
/// `env` must be a valid napi env pointer and `obj` a valid js object.
///
/// # Note on gating
///
/// Defined unconditionally with a body gated to
/// `all(feature = "napi8", not(target_family = "wasm"))` for the same reason as
/// [`tag_object`]: it is invoked from derive-generated code (param `&T` /
/// `&mut T` checks) that expands in the consumer crate, so the feature gate
/// must live inside napi. On builds without `napi8` this is a no-op that
/// returns `Ok(())`, preserving today's behavior (blind cast, or `instanceof`
/// under `strict`).
///
/// # Note on wasm
///
/// The check is a **no-op on wasm** for the same reason stamping is (see
/// [`tag_object`]): Node-API type-tag support on wasm/emnapi is host-dependent
/// (the `napi_check_object_type_tag` extern may be unresolved). On wasm the
/// binding keeps its pre-tag behavior (blind cast, or `instanceof` under
/// `strict`).
#[cfg(all(feature = "napi8", not(target_family = "wasm")))]
pub unsafe fn validate_type_tag(
  env: sys::napi_env,
  obj: sys::napi_value,
  tag: &sys::napi_type_tag,
  class_name: &str,
) -> crate::Result<()> {
  let mut matches = false;
  crate::check_status!(
    unsafe { sys::napi_check_object_type_tag(env, obj, tag, &mut matches) },
    "type tag check failed"
  )?;
  if matches {
    Ok(())
  } else {
    Err(crate::Error::new(
      crate::Status::InvalidArg,
      format!("Value is not an instance of class `{class_name}`"),
    ))
  }
}

/// No-op fallback for builds without `napi8`, and for **all** wasm builds (see
/// the "Note on wasm" on the real variant for the wasm rationale). Defined
/// unconditionally for the same reason as the real variant.
///
/// # Safety
///
/// Always safe; the arguments are ignored.
#[cfg(not(all(feature = "napi8", not(target_family = "wasm"))))]
#[inline(always)]
pub unsafe fn validate_type_tag(
  _env: sys::napi_env,
  _obj: sys::napi_value,
  _tag: &sys::napi_type_tag,
  _class_name: &str,
) -> crate::Result<()> {
  Ok(())
}

#[cfg(test)]
mod tests {
  // NOTE: object tagging/checking is a **native-only** guarantee. These tests
  // cover the pure content-identity→tag arithmetic ([`type_tag_from_ident`], a
  // 128-bit FNV-1a), which is unconditional. The actual N-API stamp/check
  // ([`tag_object`] / [`validate_type_tag`]) is a no-op on wasm, because
  // Node-API type-tag support on wasm/emnapi is host-dependent.
  use super::{sys, type_tag_from_ident};

  /// Distinct identity strings get distinct tags. Rust forbids duplicate
  /// `module_path::ident`, so distinct classes always have distinct identity
  /// strings — even two classes that share every other string field
  /// (js_name/namespace/crate/version) differ by their `module_path::ident`.
  #[test]
  fn distinct_idents_get_distinct_tags() {
    assert_ne!(
      type_tag_from_ident("a::Foo"),
      type_tag_from_ident("a::Bar"),
      "distinct identity strings must map to distinct tags",
    );
  }

  /// The same identity string always maps to the same tag (pure arithmetic on
  /// the content string — required since a class's tag must be stable across
  /// reload / dual-load and stamp and check use the same derivation).
  #[test]
  fn same_ident_is_deterministic() {
    assert_eq!(
      type_tag_from_ident("a::Foo"),
      type_tag_from_ident("a::Foo"),
      "same identity string must map to the same tag on repeat",
    );
  }

  /// Golden known-vector: locks the FNV-1a tag derivation so the wire value can
  /// never silently drift across releases (a drift would break already-tagged
  /// objects surviving a reload). If this fails, the hash arithmetic changed —
  /// that is a breaking change, not a test to re-bless.
  #[test]
  fn known_vector_locks_stability() {
    assert_eq!(
      type_tag_from_ident("napi@1.0.0::x::Foo"),
      sys::napi_type_tag {
        lower: 9205288767444028904,
        upper: 12488879969338687231,
      },
    );
  }
}
