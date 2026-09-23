/** Standalone browser annotations. Offsets are UTF-16 positions in included text. */
const EXCLUDED = ".mermaid,svg,button,input,textarea,select,option,script,style,noscript,template,canvas,img,video,audio,iframe,object,embed,[hidden],[aria-hidden='true'],[data-annotation-exclude],[contenteditable]:not([contenteditable='false'])";
const normalize = (text) => text.replace(/\u00a0/g, " ").replace(/\r/g, "\n");
const MAX_TEXT = 8000, MAX_QUOTE = 16000, MAX_DRAFTS = 50, MAX_BODY_BYTES = 256 * 1024;

/** Length-preserving normalization keeps DOM offsets and persisted offsets identical. */
export function textRevision(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return `text-v1:${text.length}:${(hash >>> 0).toString(16)}`;
}

export function indexText(root) {
  const entries = [], excluded = [];
  let text = "";
  function visit(node) {
    if (node.nodeType === 1 && node.matches(EXCLUDED)) { excluded.push(node); return; }
    if (node.nodeType === 3) {
      const value = normalize(node.data);
      if (value.length) entries.push({ node, start: text.length, end: text.length + value.length });
      text += value;
    } else for (const child of node.childNodes) visit(child);
  }
  visit(root);
  return { text, entries, excluded, revision: textRevision(text) };
}
function offsetAt(root, index, node, offset) {
  const point = root.ownerDocument.createRange();
  point.setStart(node, offset); point.collapse(true);
  for (const entry of index.entries) {
    if (entry.node === node) return entry.start + offset;
    const end = root.ownerDocument.createRange();
    end.setStart(entry.node, entry.node.data.length); end.collapse(true);
    if (point.compareBoundaryPoints(0, end) < 0) return entry.start;
  }
  return index.text.length;
}
function touchesExcluded(range, index) { return index.excluded.some((node) => range.intersectsNode(node)); }

/** Returns an anchor, or null for empty, outside, or partially excluded selections. */
export function captureSelection(document, selection = document.root.ownerDocument.getSelection()) {
  const { root, id, title } = document;
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const index = indexText(root);
  if (touchesExcluded(range, index)) return null;
  const start = offsetAt(root, index, range.startContainer, range.startOffset);
  const end = offsetAt(root, index, range.endContainer, range.endOffset);
  if (end <= start || end - start > MAX_QUOTE) return null;
  const quote = index.text.slice(start, end);
  if (!quote.trim()) return null;
  return { documentId: id, documentTitle: title, revision: index.revision, start, end, quote };
}

/** A changed revision or quote never produces a best-guess highlight. */
export function restoreAnchor(root, anchor, index = indexText(root)) {
  const { start, end, revision, quote } = anchor;
  if (revision !== index.revision || !Number.isInteger(start) || !Number.isInteger(end) ||
      start < 0 || end <= start || end > index.text.length || index.text.slice(start, end) !== quote) return null;
  const first = index.entries.find((entry) => entry.end > start), last = index.entries.find((entry) => entry.end >= end);
  if (!first || !last) return null;
  const range = root.ownerDocument.createRange();
  range.setStart(first.node, start - first.start); range.setEnd(last.node, end - last.start);
  return touchesExcluded(range, index) ? null : range;
}

// Independent instances share named highlights without clearing one another.
const highlightOwners = new WeakMap();
const HIGHLIGHTS = ["annotations-saved", "annotations-draft", "annotations-hover", "annotations-focus"];
function paintHighlights(win, owner, ranges) {
  if (!win.CSS?.highlights || typeof win.Highlight !== "function") return;
  let owners = highlightOwners.get(win);
  if (!owners) { owners = new Map(); highlightOwners.set(win, owners); }
  if (ranges) owners.set(owner, ranges); else owners.delete(owner);
  for (let i = 0; i < HIGHLIGHTS.length; i++) {
    const all = [...owners.values()].flatMap((value) => value[i]);
    if (all.length) {
      const highlight = new win.Highlight(...all); highlight.priority = i;
      win.CSS.highlights.set(HIGHLIGHTS[i], highlight);
    } else win.CSS.highlights.delete(HIGHLIGHTS[i]);
  }
}
function validComment(value) {
  return value && ["id", "documentId", "documentTitle", "revision", "quote", "text"].every((key) => typeof value[key] === "string") &&
    Number.isInteger(value.start) && Number.isInteger(value.end) && value.start >= 0 && value.end > value.start;
}
function validRecipient(value) {
  return value && typeof value.id === "string" && typeof value.label === "string" && typeof value.active === "boolean";
}
function validSubmission(value) {
  return value && typeof value.id === "string" && Array.isArray(value.comments) && value.comments.length > 0 && value.comments.every(validComment);
}
function validBatch(value) {
  return validSubmission(value) && typeof value.recipientId === "string" && Array.isArray(value.replies) &&
    value.replies.every((reply) => reply && typeof reply.commentId === "string" && typeof reply.text === "string" && typeof reply.author === "string") &&
    (value.resolutions === undefined || (Array.isArray(value.resolutions) && value.resolutions.every((op) =>
      op && typeof op.id === "string" && typeof op.commentId === "string" && typeof op.resolved === "boolean" && ["string", "number"].includes(typeof op.createdAt) && Number.isFinite(new Date(op.createdAt).getTime()))));
}
function validThreadAction(value) {
  return value && ["id", "batchId", "commentId"].every((key) => typeof value[key] === "string") &&
    (value.action === "reply" ? typeof value.text === "string" : value.action === "resolve" && typeof value.resolved === "boolean");
}
const threadKey = (value) => `${value.batchId}/${value.commentId}`;
function uuid(win) {
  if (win.crypto.randomUUID) return win.crypto.randomUUID();
  const bytes = win.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const timestamp = (value) => new Date(value).getTime() || 0;
const compareIds = (a, b) => a < b ? -1 : a > b ? 1 : 0;

/**
 * @param {{container: HTMLElement, marginContainer: HTMLElement, endpoint: string, storageKey: string, navigate: (documentId: string) => void}} options
 * @returns {{setDocument: (document: {id: string, title: string, root: HTMLElement} | null) => void, setView: (view: 'local' | 'global') => void, destroy: () => void, hasDrafts: () => boolean}}
 */
export function createAnnotations({ container, marginContainer, endpoint, storageKey, navigate }) {
  const doc = container.ownerDocument, win = doc.defaultView, owner = {};
  let current = null, candidate = null, focusedKey = null, hoveredKey = null, view = "local", showResolved = false;
  let recipient = null, batches = [], token = "", drafts = [], composer = null, pending = null, threadPending = null;
  let destroyed = false, loading = false, sending = false, threadSending = false, focusEditor = false, layoutFrame;
  let loadError = "", sendError = "", threadError = "", storageError = "", selectionError = "", signature = "";
  let placements = [], anchors = [], pointerStart = null, dragged = false, mutationVersion = 0;
  const replyDrafts = new Map(), controllers = new Set(), listeners = [], actions = new WeakMap();
  const hasDrafts = () => drafts.length > 0 || composer !== null || threadPending !== null || [...replyDrafts.values()].some(Boolean);
  const requestFrame = win.requestAnimationFrame?.bind(win) || ((callback) => win.setTimeout(callback, 0));
  const cancelFrame = win.cancelAnimationFrame?.bind(win) || win.clearTimeout.bind(win);
  function listen(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    listeners.push(() => target.removeEventListener(type, handler, options));
  }
  function element(tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function button(text, handler) {
    const node = element("button", "", text);
    node.type = "button"; actions.set(node, handler); return node;
  }
  function persist() {
    try {
      win.localStorage.setItem(storageKey, JSON.stringify({ version: 3, drafts, composer, pending,
        replyDrafts: Object.fromEntries(replyDrafts), threadPending, focusedKey }));
      storageError = "";
    } catch { storageError = "Drafts cannot be saved in this browser. Keep this page open."; }
  }
  try {
    const raw = win.localStorage.getItem(storageKey);
    if (raw) {
      const stored = JSON.parse(raw);
      if (![1, 2, 3].includes(stored.version) || !Array.isArray(stored.drafts) || !stored.drafts.every(validComment) ||
          (stored.composer != null && !validComment(stored.composer)) || (stored.pending != null && !validSubmission(stored.pending)) ||
          (stored.threadPending != null && !validThreadAction(stored.threadPending)) ||
          (stored.replyDrafts != null && (typeof stored.replyDrafts !== "object" || Array.isArray(stored.replyDrafts) ||
            !Object.values(stored.replyDrafts).every((value) => typeof value === "string")))) {
        throw new Error("Invalid draft storage");
      }
      drafts = stored.drafts; composer = stored.composer || null;
      // Preserve retry identity and text from the old recipient-picker UI. Routing
      // is now server-owned; an already-published batch keeps its original target.
      pending = stored.pending ? { id: stored.pending.id, comments: stored.pending.comments } : null;
      for (const [key, value] of Object.entries(stored.replyDrafts || {})) replyDrafts.set(key, value);
      threadPending = stored.threadPending || null;
      focusedKey = typeof stored.focusedKey === "string" ? stored.focusedKey : stored.focusedKey === null ? null :
        threadPending ? threadKey(threadPending) : null;
    }
  } catch { storageError = "Saved drafts could not be loaded. Browser storage may be unavailable."; }

  const panel = element("section", "annotations-panel annotations-global");
  panel.setAttribute("aria-label", "All comments");
  const heading = element("h2", "", "All comments"), count = element("span", "annotations-count");
  heading.append(count);
  const globalList = element("ol", "annotations-global-list");
  const globalTools = element("div", "annotations-global-tools"), globalComposer = element("div");
  const resolvedToggle = button("Show resolved", () => { showResolved = !showResolved; render(); });
  resolvedToggle.className = "annotations-resolved-toggle";
  panel.append(heading, element("p", "annotations-caption", "Across all sections · newest activity first"),
    globalTools, globalComposer, resolvedToggle, globalList);
  container.replaceChildren(panel);

  const margin = element("section", "annotations-panel annotations-margin");
  margin.setAttribute("aria-label", "Comments beside text");
  for (const node of [panel, margin]) node.setAttribute("data-annotation-exclude", "");
  const toolbar = element("div", "annotations-toolbar");
  const target = element("p", "annotations-target");
  const status = element("p", "annotations-status");
  status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  const hint = element("p", "annotations-hint"), summary = element("span", "annotations-draft-count");
  const add = button("Add comment", openComposer), send = button("Send comments", submit);
  add.className = "annotations-add"; send.className = "annotations-send";
  const controls = element("div", "annotations-actions"); controls.append(add, send);
  toolbar.append(element("h2", "", "Comments"), target, hint, controls, summary, status);
  const rail = element("div", "annotations-rail"), bubbles = element("div", "annotations-bubbles");
  const empty = element("p", "annotations-empty");
  const form = element("form", "annotations-composer annotations-bubble");
  const composerDocument = element("p", "annotations-document"), composerQuote = element("blockquote", "annotations-quote");
  const textarea = element("textarea");
  textarea.rows = 3; textarea.maxLength = MAX_TEXT; textarea.required = true;
  textarea.setAttribute("aria-label", "Comment"); textarea.placeholder = "Write a comment…";
  const addDraft = element("button", "annotations-save", "Add to drafts"); addDraft.type = "submit";
  const cancel = button("Cancel comment", () => { composer = null; persist(); render(); add.focus(); });
  const composerActions = element("div", "annotations-actions"); composerActions.append(addDraft, cancel);
  form.append(composerDocument, composerQuote, textarea, composerActions);
  rail.append(form, bubbles);
  margin.append(toolbar, empty, rail); marginContainer.replaceChildren(margin);

  // One editor moves between the active local/global card. Polls never replace
  // its textarea, selection, or unsent text.
  const editorDock = element("div"); editorDock.hidden = true; panel.append(editorDock);
  const threadForm = element("form", "annotations-thread-editor"), replyText = element("textarea");
  replyText.rows = 3; replyText.maxLength = MAX_TEXT; replyText.required = true;
  replyText.setAttribute("aria-label", "Reply"); replyText.placeholder = "Write a reply…";
  const replySend = element("button", "annotations-save", "Send reply"); replySend.type = "submit";
  const replyCancel = button("Cancel reply", () => {
    if (threadPending && threadKey(threadPending) === focusedKey) return;
    replyDrafts.delete(focusedKey); focusedKey = null; threadError = ""; persist(); render();
  });
  const replyActions = element("div", "annotations-actions"); replyActions.append(replySend, replyCancel);
  threadForm.append(replyText, replyActions); editorDock.append(threadForm);

  function records() {
    const saved = batches.flatMap((batch) => batch.comments.map((comment) => {
      const replies = batch.replies.filter((reply) => reply.commentId === comment.id)
        .sort((a, b) => timestamp(a.createdAt) - timestamp(b.createdAt) || compareIds(a.id || "", b.id || ""));
      const resolution = (batch.resolutions || []).filter((op) => op.commentId === comment.id)
        .sort((a, b) => timestamp(b.createdAt) - timestamp(a.createdAt) || compareIds(b.id, a.id))[0];
      const resolved = resolution?.resolved === true;
      return { key: `${batch.id}/${comment.id}`, batchId: batch.id, comment, replies, resolved, createdAt: batch.createdAt,
        activity: Math.max(timestamp(batch.createdAt), ...replies.map((reply) => timestamp(reply.createdAt))),
        state: resolved ? "Resolved" : replies.at(-1)?.role === "user" ? "Awaiting reply" : replies.length ? "Replied" : batch.delivered ? "Delivered" : "Pending", draft: false };
    })).sort((a, b) => b.activity - a.activity || compareIds(a.key, b.key));
    return [...saved, ...drafts.map((comment) => ({ key: `draft/${comment.id}`, comment, replies: [], resolved: false, state: "Draft", draft: true }))];
  }
  function anchoredRecords() {
    const entries = records().filter((item) => !item.resolved && !(item.draft && item.comment.id === composer?.id));
    if (composer) entries.push({ key: `draft/${composer.id}`, comment: composer, draft: true });
    return entries;
  }
  function selectText() {
    if (!current || destroyed) return;
    const selection = doc.getSelection();
    if (!selection || selection.isCollapsed || (selection.anchorNode &&
        (panel.contains(selection.anchorNode) || margin.contains(selection.anchorNode)))) return;
    candidate = captureSelection(current, selection);
    selectionError = !candidate && selection.toString().length > MAX_QUOTE ? "Select at most 16,000 characters." : "";
    renderSelection(); scheduleLayout();
  }
  function renderSelection() {
    add.disabled = !candidate || composer !== null || pending !== null || drafts.length >= MAX_DRAFTS;
    hint.textContent = drafts.length >= MAX_DRAFTS ? "Draft limit reached (50). Send or delete drafts before adding more." :
      selectionError || (candidate ? "Selection ready to comment." : "Select text to leave a comment.");
    if (!win.CSS?.highlights || typeof win.Highlight !== "function") hint.textContent += " This browser shows quotes without highlights.";
  }
  function composerIssue() {
    if (!composer) return "";
    if (composer.text.length > MAX_TEXT) return "Comments must contain at most 8,000 characters.";
    if (composer.quote.length > MAX_QUOTE) return "Quotes must contain at most 16,000 characters. Cancel and select a shorter quote.";
    if (drafts.length >= MAX_DRAFTS && !drafts.some((comment) => comment.id === composer.id)) return "Keep at most 50 drafts. Send or delete drafts before adding more.";
    return "";
  }
  function renderStatus() {
    const resolvedRetry = threadPending?.action === "reply" && records().some((record) => record.key === threadKey(threadPending) && record.resolved);
    status.textContent = [storageError, loadError, sendError, threadError, composerIssue(), pending && !sending ?
      "Delivery is unconfirmed. Retry Send comments; the saved request stays unchanged." : "",
      threadPending && !threadSending ? resolvedRetry ?
        "Reply is unconfirmed and the thread was resolved. Open All comments, choose Show resolved, and Retry reply to confirm its status." :
        "Thread update is unconfirmed. Retry it in that thread; the saved request stays unchanged." : ""].filter(Boolean).join(" ");
    status.hidden = !status.textContent;
  }
  function openComposer() {
    if (!candidate || composer || pending || drafts.length >= MAX_DRAFTS) return;
    composer = { ...candidate, id: uuid(win), text: "" }; focusedKey = `draft/${composer.id}`;
    persist(); render(); textarea.focus();
  }
  function showComment(record, navigateToQuote = true) {
    focusedKey = record.key; candidate = null; threadError = "";
    if (record.draft && !pending) {
      if (!composer) composer = { ...record.comment };
      else if (composer.id !== record.comment.id) sendError = "Finish or cancel the current comment before editing another draft.";
    }
    focusEditor = true;
    persist(); render();
    if (navigateToQuote) {
      if (current?.id !== record.comment.documentId) navigate(record.comment.documentId);
      else emphasize();
    }
  }
  function emphasize() {
    paint(); updateFocus(); scheduleLayout();
    if (!current || !focusedKey) return;
    const comment = anchoredRecords().find((item) => item.key === focusedKey && item.comment.documentId === current.id)?.comment;
    const range = comment && restoreAnchor(current.root, comment);
    const node = range?.startContainer;
    const start = node?.nodeType === 1 ? node : node?.parentElement;
    for (let parent = start; parent && current.root.contains(parent); parent = parent.parentElement) {
      if (parent.tagName === "DETAILS") parent.open = true;
    }
    start?.scrollIntoView?.({ block: "center", behavior: "smooth" });
  }
  function paint() {
    const ranges = [[], [], [], []]; anchors = [];
    if (current) {
      const index = indexText(current.root);
      for (const record of anchoredRecords()) {
        const { comment, key, draft } = record;
        if (comment.documentId !== current.id) continue;
        const range = restoreAnchor(current.root, comment, index);
        if (!range) continue;
        anchors.push({ ...record, range });
        ranges[draft ? 1 : 0].push(range);
        if (key === hoveredKey) ranges[2].push(range);
        if (key === focusedKey) ranges[3].push(range);
      }
    }
    paintHighlights(win, owner, ranges);
  }
  function updateFocus() {
    for (const host of [panel, margin]) for (const node of host.querySelectorAll("[data-thread-key]")) {
      const focused = node.dataset.threadKey === focusedKey;
      node.dataset.focused = String(focused); node.dataset.hovered = String(node.dataset.threadKey === hoveredKey);
      const hiddenMessages = node.querySelector(".annotations-hidden-messages");
      if (hiddenMessages) hiddenMessages.hidden = focused;
      const expand = node.querySelector(".annotations-expand");
      if (expand) { expand.textContent = focused ? "Collapse thread" : "Show thread"; expand.setAttribute("aria-expanded", String(focused)); }
    }
  }
  function setHovered(key) {
    if (key === hoveredKey) return;
    hoveredKey = key; paint(); updateFocus();
  }
  function hitTest(event) {
    if (!current || !current.root.contains(event.target) || !doc.getSelection()?.isCollapsed) return null;
    return anchors.filter(({ range }) => [...(range.getClientRects?.() || [])].some((rect) =>
      rect.width > 0 && rect.height > 0 && event.clientX >= rect.left && event.clientX <= rect.right &&
      event.clientY >= rect.top && event.clientY <= rect.bottom))
      .sort((a, b) => (a.comment.end - a.comment.start) - (b.comment.end - b.comment.start) || compareIds(a.key, b.key))[0] || null;
  }
  function timeElement(value) {
    const date = new Date(value), valid = Number.isFinite(date.getTime());
    const time = element("time", "", valid ? date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "");
    if (valid) { time.dateTime = date.toISOString(); time.title = date.toLocaleString(); }
    return time;
  }
  function updateThreadEditor() {
    const record = records().find((entry) => entry.key === focusedKey);
    const host = view === "global" ? globalList : bubbles;
    const card = [...host.querySelectorAll("[data-thread-key]")].find((node) => node.dataset.threadKey === focusedKey);
    const destination = record && !record.draft && card ? card : editorDock;
    if (threadForm.parentElement !== destination) destination.append(threadForm);
    const value = replyDrafts.get(focusedKey) || "";
    if (replyText.value !== value) replyText.value = value;
    const ownPending = threadPending && threadKey(threadPending) === focusedKey ? threadPending : null;
    replyText.disabled = !!ownPending || !!record?.resolved;
    replyCancel.disabled = !!ownPending;
    replySend.textContent = ownPending?.action === "reply" ? (threadSending ? "Sending reply…" : "Retry reply") : "Send reply";
    replySend.disabled = threadSending || !token || (!!record?.resolved && !ownPending) || (!!threadPending && !ownPending) ||
      (ownPending ? ownPending.action !== "reply" : !recipient || !value.trim() || value.length > MAX_TEXT);
  }
  function commentItem(record, floating = false) {
    const { comment, replies, state, draft, createdAt, key, resolved } = record;
    const item = element(floating ? "article" : "li", `annotations-comment${floating ? " annotations-bubble" : ""}`);
    item.dataset.commentId = comment.id; item.dataset.threadKey = key;
    item.dataset.resolved = String(resolved); item.tabIndex = 0;
    item.setAttribute("role", "group"); item.setAttribute("aria-label", `Comment thread: ${comment.text}`);
    const meta = element("div", "annotations-comment-meta");
    meta.append(element("strong", "", "You"));
    if (createdAt !== undefined) meta.append(timeElement(createdAt));
    meta.append(element("span", "annotations-state", state));
    const quote = button(`${comment.documentTitle}: “${comment.quote}”`, () => showComment(record));
    quote.className = "annotations-quote-button";
    quote.setAttribute("aria-label", `Show comment in ${comment.documentTitle}: ${comment.quote}`);
    item.append(meta, quote, element("p", "annotations-comment-text", comment.text));
    if (current?.id === comment.documentId && !restoreAnchor(current.root, comment)) {
      item.append(element("p", "annotations-stale", "Document changed. The original quote is kept without a highlight."));
    }
    if (floating && replies.length > 1) {
      const count = replies.length - 1;
      const label = `${count} hidden message${count === 1 ? "" : "s"}`;
      const hiddenMessages = button(label, () => showComment(record, false));
      hiddenMessages.className = "annotations-hidden-messages";
      hiddenMessages.setAttribute("aria-label", `Show ${label}`);
      item.append(hiddenMessages);
    }
    for (const reply of replies) {
      const block = element("div", "annotations-reply");
      const meta = element("div", "annotations-comment-meta");
      const agent = reply.role !== "user"; // Replies without a role are legacy agent answers.
      meta.append(element("strong", agent ? "annotations-author-agent" : "", agent ? "Agent" : "You"), timeElement(reply.createdAt));
      if (reply.role === "user" && reply.delivered === false) meta.append(element("span", "annotations-state", "Pending"));
      block.append(meta, element("p", "", reply.text)); item.append(block);
    }
    if (floating) {
      const expand = button("Show thread", () => {
        if (focusedKey === key) { focusedKey = null; persist(); render(); }
        else showComment(record, false);
      });
      expand.className = "annotations-expand"; expand.setAttribute("aria-label", `Expand comment: ${comment.text}`); item.append(expand);
    }
    if (draft) {
      const remove = button("Delete draft", () => {
        if (pending) return;
        drafts = drafts.filter((value) => value.id !== comment.id); sendError = "";
        if (composer?.id === comment.id) composer = null;
        persist(); render();
      });
      remove.className = "annotations-delete";
      remove.setAttribute("aria-label", `Delete draft: ${comment.text}`); remove.disabled = pending !== null; item.append(remove);
    } else {
      const ownPending = threadPending && threadKey(threadPending) === key && threadPending.action === "resolve";
      const resolve = button(ownPending ? "Retry thread update" : resolved ? "Reopen thread" : "Resolve thread", () => {
        focusedKey = key;
        void submitThread({ action: "resolve", batchId: record.batchId, commentId: comment.id, resolved: !resolved });
      });
      resolve.className = "annotations-resolve";
      resolve.disabled = threadSending || !token || (!!threadPending && !ownPending); item.append(resolve);
    }
    return item;
  }

  // Range coordinates and the rail share viewport coordinates: page scrolling
  // cancels out. Reflow after width, fonts, replies, details, or reader changes.
  function scheduleLayout() {
    if (destroyed || layoutFrame !== undefined) return;
    layoutFrame = requestFrame(() => { layoutFrame = undefined; if (!destroyed) layout(); });
  }
  function layout() {
    if (view === "global") { form.style.top = ""; form.removeAttribute("data-detached"); finishFocus(); return; }
    const positioned = typeof doc.createRange().getClientRects === "function" && !win.matchMedia?.("(max-width: 900px)").matches;
    rail.toggleAttribute("data-positioned", positioned);
    const items = [...placements, ...(composer ? [{ node: form, comment: composer }] : [])];
    if (!positioned) {
      rail.style.minHeight = "";
      for (const { node } of items) { node.hidden = false; node.style.top = ""; }
      form.removeAttribute("data-detached");
      finishFocus(); return;
    }
    const origin = rail.getBoundingClientRect().top, index = current && indexText(current.root);
    const measured = [];
    for (const item of items) {
      const range = current?.id === item.comment.documentId ? restoreAnchor(current.root, item.comment, index) : null;
      const rect = range && [...range.getClientRects()].find((value) => value.height > 0 && value.width > 0);
      // Do not attach stale/hidden text to an invented position. An unfinished
      // composer stays usable at the end of the rail when its section is absent.
      item.node.hidden = !rect && item.node !== form;
      if (item.node.hidden) continue;
      measured.push({ ...item, desired: rect ? Math.max(0, rect.top - origin) : Infinity,
        height: item.node.getBoundingClientRect().height || item.node.offsetHeight || 80 });
    }
    measured.sort((a, b) => a.desired - b.desired || a.comment.start - b.comment.start);
    let bottom = 0, extent = 0;
    for (const item of measured) {
      let top = Math.max(bottom, Number.isFinite(item.desired) ? item.desired : 0), detached = false;
      if (item.node === form) {
        // Keep the editor usable when its anchor is offscreen or crowded out.
        // Only the editor floats over other cards; saved bubbles stay anchored.
        const ceiling = Math.max(76, win.innerHeight - item.height - 16);
        const visibleTop = Math.max(76, Math.min(origin + top, ceiling));
        detached = !Number.isFinite(item.desired) || visibleTop !== origin + top;
        form.toggleAttribute("data-detached", detached);
        top = visibleTop - origin;
      }
      item.node.style.top = `${Math.round(top)}px`;
      extent = Math.max(extent, top + item.height + 12);
      if (!detached) bottom = Math.max(bottom, top + item.height + 12);
    }
    const height = `${Math.ceil(extent)}px`;
    if (rail.style.minHeight !== height) rail.style.minHeight = height;
    finishFocus();
  }
  function finishFocus() {
    if (!focusEditor) return;
    const input = focusedKey === `draft/${composer?.id}` ? textarea : threadForm.parentElement !== editorDock ? replyText : null;
    if (!input || input.disabled) return;
    focusEditor = false; input.focus({ preventScroll: true }); input.scrollIntoView?.({ block: "nearest" });
  }
  const resizeObserver = typeof win.ResizeObserver === "function" ? new win.ResizeObserver(scheduleLayout) : null;
  const mutationObserver = typeof win.MutationObserver === "function" ? new win.MutationObserver(() => { signature = ""; render(); }) : null;
  resizeObserver?.observe(marginContainer);
  resizeObserver?.observe(form);

  function render() {
    if (destroyed) return;
    const active = doc.activeElement, activeCard = active?.closest?.(".annotations-comment");
    container.hidden = view !== "global"; marginContainer.hidden = view !== "local";
    const toolbarHost = view === "global" ? globalTools : margin;
    if (toolbar.parentElement !== toolbarHost) toolbarHost.prepend(toolbar);
    const composerHost = view === "global" ? globalComposer : rail;
    if (form.parentElement !== composerHost) composerHost.prepend(form);
    resolvedToggle.textContent = showResolved ? "Hide resolved" : "Show resolved";
    resolvedToggle.setAttribute("aria-pressed", String(showResolved));
    target.textContent = recipient ? recipient.active ? `Comments go to: ${recipient.label}` : `Waiting for ${recipient.label} to resume.` : "Open a workflow session to send comments.";
    target.title = target.textContent;
    renderStatus(); renderSelection();
    form.hidden = !composer;
    if (composer) {
      form.dataset.commentId = composer.id; form.dataset.threadKey = `draft/${composer.id}`;
      addDraft.textContent = drafts.some((entry) => entry.id === composer.id) ? "Save draft" : "Add to drafts";
      composerDocument.textContent = `Comment on ${composer.documentTitle}`;
      composerQuote.textContent = composer.quote;
      if (textarea.value !== composer.text) textarea.value = composer.text;
    }
    textarea.disabled = pending !== null;
    addDraft.disabled = pending !== null || !composer?.text.trim() || !!composerIssue(); cancel.disabled = pending !== null;
    send.disabled = sending || !token || (!pending && (!drafts.length || !recipient || drafts.some((entry) => entry.id === composer?.id)));
    send.hidden = !drafts.length && !pending;
    send.textContent = sending ? "Sending comments…" : pending ? "Retry Send comments" : "Send comments";
    summary.textContent = drafts.length ? `${drafts.length} draft${drafts.length === 1 ? "" : "s"} across all sections` : "";
    summary.hidden = !summary.textContent;
    const entries = records(), index = current && indexText(current.root);
    const nextSignature = JSON.stringify([entries, current?.id, index?.revision, !!pending, threadPending, threadSending, !!token, showResolved]);
    if (nextSignature !== signature) {
      signature = nextSignature;
      editorDock.append(threadForm);
      const visible = entries.filter((entry) => !entry.resolved || showResolved);
      count.textContent = String(visible.length);
      globalList.replaceChildren(...visible.map((entry) => commentItem(entry)));
      if (!visible.length) globalList.append(element("li", "annotations-empty", entries.length ? "No open comments." : "No comments yet."));
      for (const { node } of placements) resizeObserver?.unobserve(node);
      placements = entries.filter(({ comment, resolved }) => !resolved && comment.documentId === current?.id && restoreAnchor(current.root, comment, index))
        .sort((a, b) => a.comment.start - b.comment.start).map((entry) => ({ node: commentItem(entry, true), comment: entry.comment }));
      bubbles.replaceChildren(...placements.map((item) => item.node));
      for (const { node } of placements) resizeObserver?.observe(node);
      empty.textContent = entries.some(({ comment, resolved }) => !resolved && comment.documentId === current?.id) ?
        "Comments on changed text are kept in All comments." : "No comments on this section.";
    }
    empty.hidden = placements.length > 0 || composer !== null;
    updateThreadEditor();
    let restore = active;
    if (activeCard && !active.isConnected) {
      const host = view === "global" ? globalList : bubbles;
      const card = [...host.querySelectorAll(".annotations-comment")].find((node) => node.dataset.threadKey === activeCard.dataset.threadKey);
      restore = active === activeCard ? card : [...(card?.querySelectorAll("button") || [])].find((node) => node.className === active.className);
    }
    if (restore?.isConnected && (panel.contains(restore) || margin.contains(restore)) && !restore.disabled && !restore.closest("[hidden]")) {
      restore.focus({ preventScroll: true });
    }
    paint(); updateFocus(); scheduleLayout();
  }
  function confirm(batch) {
    if (!pending || batch.id !== pending.id) return;
    const sent = new Set(pending.comments.map((comment) => comment.id));
    drafts = drafts.filter((comment) => !sent.has(comment.id)); pending = null; sendError = ""; persist();
  }
  function confirmThread(batch) {
    if (!threadPending || batch.id !== threadPending.batchId) return false;
    const op = threadPending;
    const saved = op.action === "reply" ? batch.replies.some((reply) => reply.id === op.id && reply.commentId === op.commentId) :
      batch.resolutions?.some((resolution) => resolution.id === op.id && resolution.commentId === op.commentId);
    if (!saved) return false;
    if (op.action === "reply") replyDrafts.delete(threadKey(op));
    threadPending = null; threadError = ""; persist(); return true;
  }
  async function request(method, body) {
    const controller = new win.AbortController(); controllers.add(controller);
    const timeout = win.setTimeout(() => controller.abort(), 15000);
    try {
      const response = await win.fetch(endpoint, {
        method, signal: controller.signal, cache: "no-store", credentials: "same-origin",
        ...(body ? { headers: { "Content-Type": "application/json", "X-Annotation-Token": token }, body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        const error = new Error(typeof data?.error === "string" ? data.error : `HTTP ${response.status}`);
        error.status = response.status; throw error;
      }
      return await response.json();
    } finally { win.clearTimeout(timeout); controllers.delete(controller); }
  }
  async function refresh() {
    if (destroyed || loading) return;
    loading = true;
    const version = mutationVersion;
    try {
      const data = await request("GET");
      if (destroyed || version !== mutationVersion) return;
      if (typeof data?.token !== "string" || !(data.recipient === null || validRecipient(data.recipient)) ||
          !Array.isArray(data.batches) || !data.batches.every(validBatch)) throw new Error("Invalid annotation response");
      token = data.token; recipient = data.recipient; batches = data.batches;
      const confirmed = pending && batches.find((batch) => batch.id === pending.id);
      if (confirmed) confirm(confirmed);
      if (threadPending) {
        const batch = batches.find((item) => item.id === threadPending.batchId);
        if (batch) confirmThread(batch);
      }
      loadError = ""; persist();
    } catch (error) { if (!destroyed) loadError = `Cannot load comments: ${error?.message || "request failed"}. Retrying while this page is visible.`; }
    finally { loading = false; if (!destroyed) render(); }
  }
  async function submit() {
    if (destroyed || sending || !token || (!pending && (!drafts.length || !recipient || drafts.some((entry) => entry.id === composer?.id)))) return;
    if (!pending) {
      const proposed = { id: uuid(win), comments: drafts.map((comment) => ({ ...comment })) };
      if (drafts.length > MAX_DRAFTS) sendError = "Send at most 50 drafts at a time. Delete some drafts before sending.";
      else if (drafts.some((comment) => comment.text.length > MAX_TEXT || comment.quote.length > MAX_QUOTE)) {
        sendError = "Draft comments must contain at most 8,000 characters and quotes at most 16,000. Replace the oversized drafts.";
      } else if (new win.Blob([JSON.stringify(proposed)]).size > MAX_BODY_BYTES) {
        sendError = "Comments exceed the 256 KiB request limit. Delete some drafts and send them separately.";
      } else sendError = "";
      if (sendError) { render(); return; }
      pending = proposed; persist();
    }
    const submitted = pending;
    sending = true; mutationVersion++; sendError = ""; render();
    try {
      const batch = await request("POST", submitted);
      if (destroyed) return;
      if (!validBatch(batch) || batch.id !== submitted.id) throw new Error("Invalid submission response");
      if (!batches.some((item) => item.id === batch.id)) batches = [...batches, batch];
      confirm(batch);
    } catch (error) {
      if (!destroyed && pending?.id === submitted.id) {
        if ([400, 413, 415].includes(error?.status)) {
          pending = null; sendError = `Comments were rejected: ${error.message}. Drafts are kept; adjust them and send again.`; persist();
        } else sendError = `Cannot confirm delivery: ${error?.message || "request failed"}. Drafts are kept.`;
      }
    } finally { sending = false; mutationVersion++; if (!destroyed) render(); }
  }
  async function submitThread(input) {
    if (destroyed || threadSending || !token) return;
    if (threadPending && (threadKey(threadPending) !== threadKey(input) || threadPending.action !== input.action)) return;
    if (!threadPending) {
      if (input.action === "reply") {
        if (!recipient || !input.text.trim()) return;
        if (input.text.length > MAX_TEXT) { threadError = "Replies must contain at most 8,000 characters."; render(); return; }
      }
      threadPending = { id: uuid(win), ...input }; persist();
    }
    const submitted = threadPending;
    threadSending = true; mutationVersion++; threadError = ""; render();
    try {
      const batch = await request("POST", submitted);
      if (destroyed) return;
      if (!validBatch(batch) || batch.id !== submitted.batchId) throw new Error("Invalid thread response");
      // A poll may already have confirmed this operation and loaded newer
      // replies/resolutions. A late POST must not replace that newer history.
      if (threadPending?.id !== submitted.id) return;
      if (!confirmThread(batch)) throw new Error("Thread update is not confirmed");
      batches = batches.map((item) => item.id === batch.id ? batch : item);
    } catch (error) {
      if (!destroyed && threadPending?.id === submitted.id) {
        if ([400, 409, 413, 415].includes(error?.status)) {
          threadPending = null;
          threadError = `Thread update was rejected: ${error.message}. Your reply draft is kept.`; persist();
        } else threadError = `Cannot confirm thread update: ${error?.message || "request failed"}. Retry this thread update.`;
      }
    } finally { threadSending = false; mutationVersion++; if (!destroyed) render(); }
  }

  for (const host of [panel, margin]) {
    listen(host, "click", (event) => {
      const clicked = event.target.closest?.("button");
      if (clicked) { if (!clicked.disabled) actions.get(clicked)?.(); return; }
      if (event.target.closest?.("a,input,textarea,select,form") || !doc.getSelection()?.isCollapsed || dragged) return;
      const card = event.target.closest?.(".annotations-comment");
      const record = card && records().find((entry) => entry.key === card.dataset.threadKey);
      if (record) showComment(record);
    });
    listen(host, "keydown", (event) => {
      // Saving a draft moves focus to Send comments. A held shortcut must not
      // activate that button on the next repeated keydown and send the batch.
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && event.repeat) { event.preventDefault(); return; }
      if (!event.target.matches?.(".annotations-comment") || !["Enter", " "].includes(event.key)) return;
      const record = records().find((entry) => entry.key === event.target.dataset.threadKey);
      if (record) { event.preventDefault(); showComment(record); }
    });
  }
  listen(doc, "pointerdown", (event) => { pointerStart = { x: event.clientX, y: event.clientY }; dragged = false; });
  listen(doc, "pointermove", (event) => {
    if (pointerStart && event.buttons && Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 4) dragged = true;
    const card = event.target.closest?.(".annotations-comment");
    const key = card && (panel.contains(card) || margin.contains(card)) && card.dataset.resolved !== "true" ? card.dataset.threadKey : hitTest(event)?.key;
    setHovered(dragged ? null : key || null);
  });
  listen(doc, "pointerup", () => { pointerStart = null; });
  listen(doc, "pointerleave", () => setHovered(null));
  listen(win, "blur", () => { pointerStart = null; setHovered(null); });
  listen(doc, "click", (event) => {
    if (dragged || event.button !== 0 || !doc.getSelection()?.isCollapsed ||
        event.target.closest?.("a,button,input,textarea,select,[contenteditable]")) return;
    // Card handlers can rebuild their DOM before this event reaches the document.
    // Its original path still tells us whether the click was inside a thread/editor.
    if (event.composedPath().some((node) => node.matches?.(".annotations-comment,.annotations-composer,.annotations-thread-editor"))) return;
    const record = hitTest(event);
    if (record) showComment(record, false);
    else if (focusedKey || hoveredKey) {
      if (panel.contains(doc.activeElement) || margin.contains(doc.activeElement)) doc.activeElement.blur?.();
      focusedKey = null; hoveredKey = null; focusEditor = false;
      persist(); render(); // Deselect without discarding drafts or uncertain requests.
    }
  });
  listen(doc, "selectionchange", selectText); listen(doc, "pointerup", selectText); listen(doc, "keyup", selectText);
  listen(add, "pointerdown", selectText);
  listen(win, "resize", scheduleLayout); listen(doc, "scroll", scheduleLayout, true); listen(doc, "toggle", scheduleLayout, true);
  listen(textarea, "input", () => {
    if (!composer || pending) return;
    composer.text = textarea.value; sendError = ""; persist();
    addDraft.disabled = !composer.text.trim() || !!composerIssue(); renderStatus(); scheduleLayout();
  });
  listen(form, "submit", (event) => {
    event.preventDefault();
    if (!composer?.text.trim() || pending || composerIssue()) return;
    const saved = { ...composer, text: composer.text.trim() };
    if (drafts.some((entry) => entry.id === saved.id)) drafts = drafts.map((entry) => entry.id === saved.id ? saved : entry);
    else drafts.push(saved);
    composer = null; candidate = null; sendError = "";
    persist(); render(); send.focus();
  });
  listen(replyText, "input", () => {
    if (!focusedKey || replyText.disabled) return;
    replyDrafts.set(focusedKey, replyText.value);
    threadError = replyText.value.length > MAX_TEXT ? "Replies must contain at most 8,000 characters." : "";
    persist(); updateThreadEditor(); renderStatus(); scheduleLayout();
  });
  listen(threadForm, "submit", (event) => {
    event.preventDefault();
    const record = records().find((entry) => entry.key === focusedKey);
    if (!record || record.draft || replySend.disabled) return;
    void submitThread({ action: "reply", batchId: record.batchId, commentId: record.comment.id, text: replyText.value.trim() });
  });
  for (const [editor, submitButton] of [[form, addDraft], [threadForm, replySend]]) {
    submitButton.setAttribute("aria-keyshortcuts", "Control+Enter Meta+Enter");
    submitButton.title = "Ctrl+Enter / ⌘+Enter";
    listen(editor, "keydown", (event) => {
      if (event.defaultPrevented || event.key !== "Enter" || !(event.ctrlKey || event.metaKey) ||
          event.altKey || event.shiftKey || event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      if (!event.repeat && !event.target.disabled && !submitButton.disabled && !editor.closest("[hidden]")) {
        editor.requestSubmit(submitButton);
      }
    });
  }
  listen(doc, "visibilitychange", () => { if (doc.visibilityState !== "hidden") { void refresh(); scheduleLayout(); } });
  if (doc.fonts) { listen(doc.fonts, "loadingdone", scheduleLayout); doc.fonts.ready.then(scheduleLayout); }
  const interval = win.setInterval(() => { if (doc.visibilityState !== "hidden") void refresh(); }, 2000);
  render(); void refresh();
  return {
    setDocument(document) {
      if (destroyed) return;
      if (current) resizeObserver?.unobserve(current.root);
      mutationObserver?.disconnect();
      current = document; candidate = null; hoveredKey = null; selectionError = ""; signature = "";
      if (current) {
        resizeObserver?.observe(current.root);
        mutationObserver?.observe(current.root, { subtree: true, childList: true, characterData: true, attributes: true });
      }
      render(); emphasize();
    },
    setView(next) {
      if (destroyed || !["local", "global"].includes(next) || next === view) return;
      view = next; hoveredKey = null; render();
    },
    hasDrafts,
    destroy() {
      if (destroyed) return;
      destroyed = true; win.clearInterval(interval);
      if (layoutFrame !== undefined) cancelFrame(layoutFrame);
      resizeObserver?.disconnect(); mutationObserver?.disconnect();
      for (const remove of listeners) remove();
      for (const controller of controllers) controller.abort();
      paintHighlights(win, owner, null); container.replaceChildren(); marginContainer.replaceChildren();
    },
  };
}
