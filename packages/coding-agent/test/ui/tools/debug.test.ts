import "../../../src/ui/styles/tools/debug";
import { debugPresenter } from "../../../src/ui/tools/debug";
import { toolScreenSuite } from "./presenter-corpus";

toolScreenSuite("debug", "debug", debugPresenter, { legacyInline: true });
