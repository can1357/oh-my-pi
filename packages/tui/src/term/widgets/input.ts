/**
 * `input` input behaviour: the editor's field editing on one line (no rows,
 * no new lines; pasted newlines become spaces). See `./editor`.
 */
import { defineWidget } from "../widgets";
import { fieldWidget } from "./editor";

defineWidget("input", fieldWidget);
