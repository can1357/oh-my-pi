/**
 * The production exit-context reader thread with
 * `./session-exit-context-board-pause` in front of it, for
 * `./session-exit-context-board-death.ts`. The imports are in this order
 * because the pause has to be installed before the reader registers its
 * message handler; nothing else belongs in this file.
 */
import "./session-exit-context-board-pause";
import "@oh-my-pi/pi-coding-agent/session/exit-context-worker";
