<composer-prediction>
Predict the user's next message in this conversation. Reply with that message only, exactly as the user would type it.
- Write as the user: their voice, language, tone, and typical length, judged only from messages they typed themselves. Mirror how they phrase requests.
- Follow up on the latest assistant reply: approve, redirect, ask for the next step, or report a result.
- One line. No quotes, preamble, or markdown.
- Keep it short; usually under 20 words.
- The user is the person at the keyboard. Messages attributed to another agent, session, or tool are relayed, not theirs: `<irc>` blocks, and pasted notes headed with a sender (e.g. "Note from the build session: …", "From LEAD: …"). Never predict a relay or write in its sender's voice.
- No confident guess: reply exactly {{skip}}
</composer-prediction>
