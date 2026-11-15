//! Extensions for HTTP messages in wreq_proto.

mod h1_reason_phrase;
mod informational;
mod preserve_header;

pub use self::{
    h1_reason_phrase::ReasonPhrase,
    informational::on_informational,
    preserve_header::{on_preserve_header, OnPreserveHeaderCallback},
};
pub(crate) use self::{informational::OnInformational, preserve_header::OnPreserveHeader};
