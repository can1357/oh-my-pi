import type { JSX } from "solid-js";

function ConversationIcon(): JSX.Element {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.7"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z" />
      <path d="M8 9h8M8 13h5" />
    </svg>
  );
}

export function Conversation(): JSX.Element {
  return (
    <section class="rmp-conversation" aria-labelledby="conversation-heading">
      <div class="rmp-conversation-icon">
        <ConversationIcon />
      </div>
      <div class="rmp-conversation-copy">
        <span class="eyebrow">Preview</span>
        <h2 id="conversation-heading">Conversation mode</h2>
        <p>
          A focused place to ask robomp about active work, investigate failures, and guide the
          next action without leaving the operations console.
        </p>
      </div>
      <div class="rmp-conversation-capabilities" aria-label="Planned conversation capabilities">
        <span>Discuss active runs</span>
        <span>Inspect issue context</span>
        <span>Guide next actions</span>
      </div>
      <div class="rmp-conversation-composer">
        <label for="conversation-prompt">Message</label>
        <div class="rmp-conversation-input-row">
          <input
            id="conversation-prompt"
            aria-describedby="conversation-note"
            type="text"
            placeholder="Backend support is not connected yet"
            disabled
          />
          <button
            type="button"
            class="primary"
            disabled
            title="Conversation backend is not connected yet"
          >
            Send
          </button>
        </div>
        <span id="conversation-note" class="rmp-conversation-note">
          The interface is ready; sending will unlock when backend support lands.
        </span>
      </div>
    </section>
  );
}
