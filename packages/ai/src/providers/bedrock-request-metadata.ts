const BEDROCK_REQUEST_METADATA_PATTERN = /^[a-zA-Z0-9\s:_@$#=/+,\-.]*$/;

/** Check Bedrock's request-metadata character and length limits. Keys must also be nonempty. */
export function isBedrockRequestMetadataValue(value: string): boolean {
	return value.length <= 256 && BEDROCK_REQUEST_METADATA_PATTERN.test(value);
}
