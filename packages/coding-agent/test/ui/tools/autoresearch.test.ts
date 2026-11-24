import "../../../src/ui/styles/tools/autoresearch";
import {
	initExperimentPresenter,
	logExperimentPresenter,
	runExperimentPresenter,
	updateNotesPresenter,
} from "../../../src/ui/tools/autoresearch";
import { toolScreenSuite } from "./presenter-corpus";

toolScreenSuite("init_experiment", "init_experiment", initExperimentPresenter);
toolScreenSuite("log_experiment", "log_experiment", logExperimentPresenter);
toolScreenSuite("run_experiment", "run_experiment", runExperimentPresenter);
toolScreenSuite("update_notes", "update_notes", updateNotesPresenter);
