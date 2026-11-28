/** `jpeg` with two max-size APP2 (ICC) segments after SOI, pushing its SOF marker past 128 KiB. */
export function withLargeMetadata(jpeg: Buffer): Buffer {
	const segment = Buffer.alloc(2 + 0xffff);
	segment.writeUInt16BE(0xffe2, 0);
	segment.writeUInt16BE(0xffff, 2);
	return Buffer.concat([jpeg.subarray(0, 2), segment, segment, jpeg.subarray(2)]);
}
