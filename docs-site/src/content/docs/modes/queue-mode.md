---
title: Queue Mode
description: Queue a message for delivery after the agent's current turn yields, without interrupting the in-flight work.
coverage: A
---

Queue mode is the lightest of the persistent modes — it does not change what the agent is doing this turn, only what lands immediately after. Type `/queue <message>` to schedule a message to be delivered as soon as the agent yields control; the queued message then becomes the next user prompt with no manual intervention.

Use it when the agent is mid-turn on a long task and you realize what you want next. Rather than interrupting (which cancels the in-flight work and discards partial state), queue it. The agent finishes the current turn, then picks up your queued message.

## Sending a queued message

```text
/queue also rename getUserById to fetchUser while you're at it
```

The queued message is held in the session's input controller until the agent yields. The status line shows a `Queued` indicator while one is pending.

## Composer shorthand

`/queue` is not required: a prompt that starts with `->` or `=>` is queued the same way, with the rest of the prompt as the message body.

```text
-> also rename getUserById to fetchUser while you're at it
```

The editor highlights the shorthand and any recognized list markers while you type. The composer and `/queue` share the same delivery path — see [Slash Commands](/oh-my-pi/reference/slash-commands/) for the full command reference.

A sequential enumerated list composes multiple queued messages from one prompt. Each item becomes its own queued message, delivered in order after the current turn yields:

```text
=> summarize the PR feedback and propose a plan:
1. list the blocking issues
2. draft a fix for each one
3. flag anything that needs product input
```

Items use numeric (`1.`), alphabetic (`a.`), or Roman-numeral (`i.`) markers with `.` or `)` and must count up by one. Lines that are not list items — including indented lines — stay attached to the preceding item as continuation lines, and a trailing marker with no content is dropped. If the markers are not sequential (for example `1.` followed by `3.`), mix letter case, or mix punctuation, the prompt is not treated as a list and is queued as a single message.

## How queued messages are delivered

- Queued messages are delivered as the next user prompt, not as a hidden injection or a follow-up — same path as a manually-typed prompt that arrives right after a yield.
- The delivery respects approval mode, keybindings, and the normal submit pipeline.
- Multiple queued messages are delivered in order; each one is processed as a full turn before the next is delivered.
- A queued message can itself queue another message — the chain runs until empty.

## Cancelling a queued message

The same input controller that holds the queue handles cancellation. Edit the queue from the editor (the queued message appears as a draft) or clear it before the yield. Queued messages do not survive session close.

## See also

- [Plan Mode](/oh-my-pi/modes/plan-mode/) — single pre-execution review
- [Goal Mode](/oh-my-pi/modes/goal-mode/) — persistent autonomous objective
- [Loop Mode](/oh-my-pi/modes/loop-mode/) — re-submit the next prompt after every yield
- [Slash Commands](/oh-my-pi/reference/slash-commands/) — every built-in `/command` and its arguments
