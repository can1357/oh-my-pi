use std::{ops::Deref, sync::Arc};

use http::{HeaderMap, HeaderValue};

/// Registers a callback to customize header order and casing before sending a request.
///
/// # Example
/// ```
/// use http::header::{HeaderMap, HeaderValue};
/// use wreq_proto::ext::{on_preserve_header, OnPreserveHeaderCallback};
///
/// struct HeaderPreserver;
///
/// impl OnPreserveHeaderCallback for HeaderPreserver {
///
///   fn call(&self, headers: &mut HeaderMap) {
///     // Modify or sort headers as needed before serialization
///   }
///
///   fn call_visit(
///       &self,
///       headers: &mut HeaderMap,
///       dst: &mut dyn FnMut(&dyn AsRef<[u8]>, &HeaderValue),
///   ) {
///     // Write headers with custom casing/order
///   }
/// }
///
/// let mut req = http::Request::new(());
/// on_preserve_header(&mut req, HeaderPreserver);
/// ```
#[inline]
pub fn on_preserve_header<B, C>(req: &mut http::Request<B>, callback: C)
where
    C: OnPreserveHeaderCallback,
{
    req.extensions_mut()
        .insert(OnPreserveHeader(Arc::new(callback)));
}

/// Trait for custom header preservation callback.
///
/// Implement this trait to define custom behavior for:
/// 1. Modifying/sorting headers before serialization (`call`)
/// 2. Writing headers with custom casing/order (`call_visit`)
///
/// The default implementation of `call_visit` will use the modified headers
/// from `call` and write them with standard HTTP casing rules. Override
/// `call_visit` to implement custom header writing logic.
///
/// # Safety
///
/// Implementations must be `Sync + Send` to support use in async contexts, and
/// must not panic (panics will propagate during request serialization).
pub trait OnPreserveHeaderCallback: Sync + Send + 'static {
    /// Modify or sort headers before they are written to the request.
    ///
    /// This method is called first during header processing - use it to mutate
    /// the header map (sort, add, remove, or modify values) before serialization.
    fn call(&self, headers: &mut HeaderMap);

    /// Visit and emit headers with custom casing or order.
    ///
    /// This method is called to output headers to the wire format. The provided
    /// `dst` closure should be called for each header, with the header name (as bytes)
    /// and value. Use this to enforce custom casing (e.g. `Content-Type` instead of
    /// `content-type`), non-standard header order, or to filter/process headers before writing.
    #[allow(clippy::type_complexity)]
    fn call_visit(
        &self,
        headers: &mut HeaderMap,
        dst: &mut dyn FnMut(&dyn AsRef<[u8]>, &HeaderValue),
    );
}

#[derive(Clone)]
pub(crate) struct OnPreserveHeader(Arc<dyn OnPreserveHeaderCallback>);

impl Deref for OnPreserveHeader {
    type Target = Arc<dyn OnPreserveHeaderCallback>;

    #[inline]
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
