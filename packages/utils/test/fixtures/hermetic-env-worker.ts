// Started by hermetic-env-probe.ts with `new Worker(url)` and no options; reports the names it sees.
declare const self: Worker;
self.postMessage(Object.keys(process.env));
