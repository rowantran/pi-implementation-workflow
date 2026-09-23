# Browser annotations

A standalone ES module and stylesheet. No runtime dependencies, application routes, workflow roles, or recipient-selection policy.

Serve `browser.js` and `annotations.css` as browser assets. Load the stylesheet separately:

```html
<link rel="stylesheet" href="/assets/annotations.css">
```

```js
import { createAnnotations } from '/assets/annotations.js';

const annotations = createAnnotations({
  container: document.querySelector('#all-comments'),    // Global newest-activity-first sidebar
  marginContainer: document.querySelector('#margin'),    // Rail beside the reader
  endpoint: '/annotations',
  storageKey: 'annotations:my-document-set',
  navigate: (id) => showDocument(id),
});

// Call after replacing the reader, including theme rerenders.
annotations.setDocument({ id: 'my/document/id', title: 'Document title', root: readerSection });
annotations.setView('global'); // Replaces the local view; 'local' is the default.
annotations.hasDrafts(); // Includes unfinished comments/replies and uncertain thread operations, not a bare selection.
annotations.setDocument(null); // No current reader; global comments remain available.
annotations.destroy(); // Removes requests, timers, frames, observers, listeners, and owned highlights.
```

The application supplies two dedicated containers and owns their page layout. Put the margin container beside the reader in the same scrolling surface, without sticky positioning. The global container can be sticky or in a collapsible drawer. The library owns both containers' contents and their `hidden` flags. `setView` makes the views mutually exclusive and moves the shared toolbar, comment composer, and thread editor to the active view. The application must remove any reserved grid column for the hidden container. Use stable document IDs and a reader root containing the whole section. `navigate` can switch documents synchronously or asynchronously; call `setDocument` when the replacement reader is ready. Guard unrelated page reloads with `hasDrafts()`.

## Margin bubbles and global comments

The margin contains the composer and comments anchored to the current section. Bubbles align with the first visible rectangle of the text range. Adjacent bubbles move down only enough to avoid overlap. A collapsed bubble previews the original comment and latest reply. If messages are omitted between them, a muted, clickable count shows how many are hidden. The count or Show thread expands the full history; no count appears when nothing is hidden. Selection and text highlighting never insert wrappers into the reader DOM.

Positions are recalculated after navigation, resizing, scrolling, font loading, reader mutations, and comment size changes. An unfinished composer stays usable when its quote is offscreen or its section is no longer shown; it can temporarily float over other bubbles. Saved bubbles never use guessed positions. Hidden ranges do not show margin bubbles. Below 900 px, bubbles use normal stacked flow instead of geometric positioning.

All comments contains open threads across the supplied document set, sorted by their latest comment/reply timestamp descending, with thread ID as a stable tie-breaker. Drafts appear afterward in draft order. Replies stay under their parent comment in ascending timestamp order. All headers use the same name-and-time formatting: user comments show You, and agent answers—including legacy replies—show Agent in the inherited accent color instead of the stored session name. Each comment shows Draft, Pending, Delivered, Awaiting reply, Replied, or Resolved.

The entire card is clickable and keyboard-focusable with Enter/Space; nested controls and text selections keep their native behavior. A card opens its source section and focuses the reply editor. Clicking unannotated text or page background clears that focus and collapses the thread without deleting drafts or pending requests; text selection, dragging, and interactions with comment controls do not dismiss it. Draft cards edit the existing draft instead of creating a duplicate. Unsent reply text is stored per thread, so changing views or focusing another card does not discard it. Polls preserve the shared editor's text, selection, and focus.

Ctrl+Enter or Cmd+Enter submits the active editor through the same validated form action as its button: Add/Save draft for root comments, Send reply (or Retry reply) for threads. The buttons expose the shortcuts through a tooltip and `aria-keyshortcuts`. Plain Enter remains a newline. Repeated keydown events, input composition, disabled actions, and hidden editors do not submit; shortcuts outside these forms have no effect.

Resolve thread hides its local bubble and highlight. The global Show resolved toggle exposes its history and Reopen thread button. Reopen before replying; late agent answers never reopen a resolved thread. Resolution is not a notification to the agent.

## Anchors and highlighting

Offsets count UTF-16 code units across included DOM text nodes. Length-preserving normalization maps nonbreaking spaces to spaces and carriage returns to newlines. Other whitespace, case, and Unicode remain unchanged. The revision combines normalized text length with a deterministic 32-bit FNV-1a fingerprint. It is an anchor check, not a security hash. Restoration requires the same revision, valid offsets, and an exact normalized quote match.

Mermaid, SVG, form controls, hidden elements, media, scripts, editable content, and elements with `data-annotation-exclude` are excluded. Selections crossing excluded elements are rejected, including textless excluded elements. Changed sections keep original quotations in the global sidebar without guessed highlights or margin bubbles.

Native CSS Custom Highlights use subtle translucent amber backgrounds without changing text colors or adding underlines. Without that API, selection, comments, navigation, and quotes still work. Hovering annotated text strengthens its highlight and outlines the matching card; clicking focuses the thread editor. Hit testing uses native range rectangles, not DOM wrappers, and ignores drag selections, changed text, resolved threads, and other documents. Overlapping ranges select the smallest range, then thread ID, deterministically. Optional reader-inherited variables: `--annotation-saved-background`, `--annotation-draft-background`, `--annotation-hover-background`, and `--annotation-focus-background`.

## Server and persistence

GET runs initially and about every two seconds while the page is visible. It returns `{ token, recipient, batches }`, where `recipient` is informational metadata or `null`. The browser never selects or supplies a recipient. POST sends `{ id, comments }` with `Content-Type: application/json` and `X-Annotation-Token`. The success response is a batch including the server-chosen `recipientId`. Comments contain `{ id, documentId, documentTitle, revision, start, end, quote, text }`. Replies display their author, timestamp, and text without HTML interpretation.

Thread replies POST `{ id, action: 'reply', batchId, commentId, text }`; resolve/reopen POST `{ id, action: 'resolve', batchId, commentId, resolved }`. Both return the enriched root batch. Reply events have optional `id`, `role` (`user` or `agent`), and `delivered` fields for legacy compatibility. A batch's optional `resolutions` array contains all immutable `{ id, commentId, resolved, createdAt }` events; the latest timestamp/ID determines the current state.

The token stays in memory. Local storage version 3 contains drafts, composer text, per-thread reply drafts, focus, and unconfirmed root/thread requests. Versions 1 and 2 retain their drafts, composers, and pending requests; any old manual recipient choice is discarded. Root batches and thread operations retry independently. The callback must return an already-saved batch on retry without changing its original recipient.

A retry uses exactly the same ID and payload, including after reload. Uncertain requests lock their drafts until POST succeeds or GET confirms the batch ID. Network failures and HTTP 503 retain the immutable request. Definitive HTTP 400, 413, and 415 errors unlock drafts and composer for correction; the next submission gets a new ID. Drafts never clear merely because a request was sent. Errors appear in the active view's toolbar. Thread requests similarly remain immutable until POST or GET confirms their event ID, even after reload. Definitive HTTP 400, 409, 413, and 415 unlock a thread request while keeping the reply draft. GET can confirm an old resolution operation even after a later reopen. An absent recipient permits drafting and resolution but disables new comment/reply submissions; retries remain possible.

The client limits comments to 8,000 UTF-16 code units, quotes to 16,000, and batches to 50 drafts. It checks the complete JSON request against a 256 KiB UTF-8 body limit before freezing a request. Restored oversized drafts remain available for removal.

Storage keys must not be shared by different endpoints. Simultaneous editing in two tabs is not synchronized; keep one editing tab per storage key.

## HTTP adapter

`server.ts` is independent of the browser runtime and delivery mechanism:

```ts
await handleAnnotations(request, response, {
  directory: '/local/annotation-state',
  allowedOrigins: ['http://127.0.0.1:43121'],
  load: async () => ({ recipient, batches }),
  onSubmit: async (submission) => saveAndDeliver(submission),
  onReply: async ({ id, batchId, commentId, text }) => saveAndDeliverReply({ id, batchId, commentId, text }),
});
```

The application matches its endpoint before calling the handler. `onSubmit` selects the recipient and persists idempotently by batch ID. It must resolve saved IDs before considering a new recipient, including when no recipient is currently available. It returns a `Batch`; callback failures return HTTP 503. The handler rejects client-supplied `recipientId` rather than allowing browser routing overrides.

`onReply` persists one immutable user reply and returns its root batch. Its `load` results include user replies; the handler merges them with agent reply history. Invalid parents return 400, replying to a resolved thread returns 409, and callback failures return 503. Already-saved replies remain retryable after resolution.

There is no second submission store. This module stores only its request token, agent replies, and resolution events, enriches GET/POST batches, validates POST input, and checks Host, Origin, token, content type, and body size. It does not authenticate users; expose it only to trusted clients.

`writeReply(directory, batchId, reply)` appends an immutable answer. Supply a stable `reply.id` for idempotent retries; repeating the same ID and content retains its original timestamp, while conflicting content is rejected. The caller must authorize the session and confirm the comment belongs to the batch. `readReplies(directory, batchId)` returns chronological history, including legacy single-answer files. `writeResolution` appends an idempotent resolution operation; `readResolutions` retains every event for retry confirmation, and `isResolved` derives the current state. All comment and reply content is plain text.

## Focused tests

```sh
node --test test/annotations-browser.test.ts
```

Tests use development-only jsdom for selections, DOM ranges, layout measurements, lifecycle cleanup, persistence, and mocked HTTP. Range rectangles and resize/font events are controlled to verify alignment and non-overlap; jsdom does not paint CSS or replace visual browser checks.
