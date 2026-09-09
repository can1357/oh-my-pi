const lockedStdinReader = Bun.stdin.stream().getReader();
void lockedStdinReader;

export default function lockedStdinReaderExtension(): void {}
