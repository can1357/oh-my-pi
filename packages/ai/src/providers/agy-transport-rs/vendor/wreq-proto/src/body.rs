//! Streaming bodies for Requests and Responses
//!
//! Both clients and servers use streaming bodies for requests and responses, instead of fully
//! buffering them. This approach avoids unnecessary memory usage and enables back-pressure by only
//! reading when needed.
//!
//! There are two main components:
//!
//! - **[`http_body::Body`] trait**: Describes all possible body types. Any type implementing this
//!   trait can be used as a body, allowing applications to have fine-grained control over
//!   streaming.
//! - **[`Incoming`] concrete type**: An implementation of `Body` provided by this module, used as a
//!   receive stream (for server requests and client responses).
//!
//! Additional implementations are available in [`http-body-util`][], such as `Full` or `Empty`
//! bodies.
//!
//! [`http-body-util`]: https://docs.rs/http-body-util
//! [`http_body::Body`]: https://docs.rs/http-body

mod incoming;
mod length;
mod watch;

pub use self::incoming::Incoming;
pub(crate) use self::{incoming::Sender, length::DecodedLength};

fn _assert_send_sync() {
    fn _assert_send<T: Send>() {}
    fn _assert_sync<T: Sync>() {}

    _assert_send::<Incoming>();
    _assert_sync::<Incoming>();
}
