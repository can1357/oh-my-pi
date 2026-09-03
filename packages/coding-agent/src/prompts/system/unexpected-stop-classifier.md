Classify whether this assistant message is an unexpected stop: it says it will act, continue working, or call a tool, then ends without doing so.

Unexpected stops:
- "I should do the same for the JS eval worker. Doing that now."
- "Let me run the tests next."
- "I'll fix that now."
- "Should I do that for you?"

Not an unexpected stop:
- "I've completed the task."
- "Is there anything else I can help with?"
- "The fix is done and tests pass."

Message:
{{message}}

Answer one word: YES if unexpected stop; NO otherwise.
