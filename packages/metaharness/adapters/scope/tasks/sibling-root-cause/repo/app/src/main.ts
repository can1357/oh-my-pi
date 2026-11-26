import { parseDuration } from "../../lib/src/duration";

const timeout = parseDuration(process.env.DEPLOY_TIMEOUT ?? "2m");
console.log(`deploy timeout: ${timeout}ms`);
