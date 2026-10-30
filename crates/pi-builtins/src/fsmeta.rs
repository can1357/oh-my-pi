//! Formatting shared by utilities that consume filesystem-provider metadata.

use std::time::SystemTime;

use pi_vfs::Metadata;
use uucore::fsext::MetadataTimeField;

/// Formats provider mode bits for `ls`, `stat`, and `find` without requiring native metadata.
pub(crate) fn display_permissions(metadata: &Metadata, display_file_type: bool) -> String {
	uucore::fs::display_permissions_unix(metadata.mode(), display_file_type)
}

/// Selects an available provider timestamp for metadata-reporting utilities.
pub(crate) fn metadata_get_time(metadata: &Metadata, field: MetadataTimeField) -> Option<SystemTime> {
	match field {
		MetadataTimeField::Modification => metadata.modified().ok(),
		MetadataTimeField::Access => metadata.accessed().ok(),
		MetadataTimeField::Change => metadata.changed().ok(),
		MetadataTimeField::Birth => metadata.created().ok(),
	}
}
