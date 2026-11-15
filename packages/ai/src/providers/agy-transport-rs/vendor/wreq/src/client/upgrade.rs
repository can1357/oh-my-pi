pub use upgrade::Upgraded;
use wreq_proto::upgrade;

use super::response::Response;
use crate::Error;

impl Response {
    /// Consumes the [`Response`] and returns a future for a possible HTTP upgrade.
    #[inline]
    pub async fn upgrade(self) -> crate::Result<Upgraded> {
        upgrade::on(http::Response::from(self))
            .await
            .map_err(Error::upgrade)
    }
}
