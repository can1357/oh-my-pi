// Writes the current keyboard layout to the file named by argv[1]: the
// keyboard type as 4 little-endian bytes, then the layout's `uchr` data. Text
// Input Sources must run on the main queue, which the desktop worker thread
// of the embedding process is not, so the lookup runs in this process.
// Exit status 3 means the layout has no Unicode key layout data.
#import <Carbon/Carbon.h>
#include <stdint.h>
#include <stdio.h>

int main(int argc, char **argv) {
	if (argc != 2) return 64;
	TISInputSourceRef source = TISCopyCurrentKeyboardLayoutInputSource();
	if (!source) return 3;
	CFDataRef data = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData);
	if (!data) {
		CFRelease(source);
		return 3;
	}
	uint32_t type = LMGetKbdType();
	uint8_t header[4] = {type & 0xff, (type >> 8) & 0xff, (type >> 16) & 0xff, (type >> 24) & 0xff};
	FILE *file = fopen(argv[1], "wb");
	int status = file && fwrite(header, 1, sizeof header, file) == sizeof header &&
			fwrite(CFDataGetBytePtr(data), 1, (size_t)CFDataGetLength(data), file) ==
				(size_t)CFDataGetLength(data)
		? 0
		: 74;
	if (file && fclose(file) != 0) status = 74;
	CFRelease(source);
	return status;
}
