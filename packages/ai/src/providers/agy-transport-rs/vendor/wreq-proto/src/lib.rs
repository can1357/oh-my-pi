#![deny(unused)]
#![deny(unsafe_code)]
#![deny(missing_docs)]
#![allow(unexpected_cfgs)]
#![cfg_attr(test, deny(rust_2018_idioms))]
#![cfg_attr(test, deny(warnings))]
#![cfg_attr(not(test), warn(unused_crate_dependencies))]
#![cfg_attr(all(test, feature = "nightly"), feature(test))]

//! # wreq-proto
//!
//! [wreq](https://github.com/0x676e67/wreq) HTTP client protocol and utilities.
//!
//! Much of this codebase is adapted and refined from [hyper](https://github.com/hyperium/hyper),
//! aiming to match its performance and reliability for asynchronous HTTP/1 and HTTP/2.

#[macro_use]
mod trace;
mod dispatch;
mod error;
mod lock;
mod proto;

pub mod body;
pub mod conn;
pub mod ext;
pub mod rt;
pub mod upgrade;

pub use self::{
    error::{Error, Result},
    proto::{http1, http2},
};
