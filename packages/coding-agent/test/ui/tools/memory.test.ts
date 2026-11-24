import "../../../src/ui/styles/tools/memory";
import { recallPresenter, reflectPresenter, retainPresenter } from "../../../src/ui/tools/memory";
import { toolScreenSuite } from "./presenter-corpus";

toolScreenSuite("retain", "retain", retainPresenter);
toolScreenSuite("recall", "recall", recallPresenter);
toolScreenSuite("reflect", "reflect", reflectPresenter);
