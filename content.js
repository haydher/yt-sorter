/**
 * YouTube Queue Sorter
 *
 * Adds a "Sort" button next to "Clear" in YouTube's queue panel and sorts the queue by video length.
 *
 * How it works: the queue is a playlist stored on YouTube's servers. We read it from the panel's
 * data, work out the fewest moves needed, and send the same `edit_playlist` requests YouTube
 * sends when you drag a row. This script runs in the page's own JS world (see manifest.json),
 * which is the only way to read the panel's `.data`.
 */
(() => {
  "use strict";

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  const BUTTON_ID = "yt-queue-sort-btn";
  const BUTTON_LABEL = "Sort";
  const BUTTON_TOOLTIP = "Sort queue by length (shortest first). Shift+click: longest first.";
  const PANEL_SELECTOR = "ytd-playlist-panel-renderer";
  const EDIT_PLAYLIST_URL = "/youtubei/v1/browse/edit_playlist?prettyPrint=false";
  const MOVE_DELAY_MS = 150; // pause between requests, to be gentle on the API
  const RESET_LABEL_AFTER_MS = 2000;
  const TOAST_VISIBLE_MS = 2500;

  // Short messages shown on the button and in the toast.
  const MESSAGE = {
    sorted: "Sorted ✓",
    alreadySorted: "Already sorted",
    nothingToSort: "Nothing to sort",
    cantReadLengths: "Can't read lengths",
    noQueueData: "No queue data",
    error: "Error - see console",
    progress: (done, total) => `${done}/${total}`,
  };

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Errors only, prefixed so they are easy to filter in DevTools and paste into a bug report.
  const logError = (message, details) => console.error("[yt-sorter]:", message, details ?? "");

  /** Creates an element with inline styles (we can't ship a stylesheet into YouTube's page). */
  function createElement(tag, styles, props = {}) {
    const element = Object.assign(document.createElement(tag), props);
    Object.assign(element.style, styles);
    return element;
  }

  // ---------------------------------------------------------------------------
  // Reading video lengths
  // ---------------------------------------------------------------------------

  /** "1:02:03" -> 3723 seconds, or null if the text isn't a clock time. */
  function secondsFromClock(text) {
    const value = text?.trim();
    if (!/^\d+(:\d{1,2}){1,2}$/.test(value ?? "")) return null;
    return value.split(":").reduce((total, part) => total * 60 + Number(part), 0);
  }

  /** "2 hours, 3 minutes, 4 seconds" -> 7384 seconds, or null if there are no time units. */
  function secondsFromSpokenLabel(label) {
    const SECONDS_PER_UNIT = { hour: 3600, minute: 60, second: 1 };
    const matches = [...(label ?? "").matchAll(/(\d+)\s*(hour|minute|second)/g)];
    if (matches.length === 0) return null;
    return matches.reduce((total, [, amount, unit]) => total + Number(amount) * SECONDS_PER_UNIT[unit], 0);
  }

  /** Length of a queue entry in seconds. Live streams / unknown lengths are Infinity (sorted last). */
  function videoSeconds(renderer) {
    const overlay = renderer.thumbnailOverlays?.map((o) => o.thumbnailOverlayTimeStatusRenderer).find(Boolean);
    const spokenLabel = (text) => text?.accessibility?.accessibilityData?.label;

    // YouTube stores the length in a few places; use the first one that parses.
    const candidates = [
      () => secondsFromClock(renderer.lengthText?.simpleText),
      () => secondsFromSpokenLabel(spokenLabel(renderer.lengthText)),
      () => secondsFromClock(overlay?.text?.simpleText),
      () => secondsFromSpokenLabel(spokenLabel(overlay?.text)),
      () => secondsFromSpokenLabel(spokenLabel(renderer.title)),
    ];
    for (const candidate of candidates) {
      const seconds = candidate();
      if (seconds !== null) return seconds;
    }
    return Infinity;
  }

  // ---------------------------------------------------------------------------
  // Talking to YouTube
  // ---------------------------------------------------------------------------

  async function sha1Hex(text) {
    const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  /** The Authorization header YouTube's own web client sends for signed-in API calls. */
  async function authHeaders() {
    const sapisid = document.cookie.match(/(?:^|;\s*)(?:__Secure-3PAPISID|SAPISID)=([^;]+)/)?.[1];
    if (!sapisid) return {};

    const origin = location.origin;
    const timestamp = Math.floor(Date.now() / 1000);
    const hash = await sha1Hex(`${timestamp} ${sapisid} ${origin}`);
    return {
      authorization: `SAPISIDHASH ${timestamp}_${hash}`,
      "x-origin": origin,
      "x-goog-authuser": String(ytcfg.get("SESSION_INDEX") ?? 0),
      "x-youtube-bootstrap-logged-in": "true",
    };
  }

  /** Moves one queue entry to sit right after `afterSetVideoId` (or to the top if omitted). */
  async function moveQueueItem(playlistId, setVideoId, afterSetVideoId) {
    const context = ytcfg.get("INNERTUBE_CONTEXT");
    const action = { action: "ACTION_MOVE_VIDEO_AFTER", setVideoId };
    if (afterSetVideoId) action.movedSetVideoIdPredecessor = afterSetVideoId;

    const auth = await authHeaders();
    const response = await fetch(EDIT_PLAYLIST_URL, {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json",
        "x-youtube-client-name": String(ytcfg.get("INNERTUBE_CONTEXT_CLIENT_NAME") ?? 1),
        "x-youtube-client-version": ytcfg.get("INNERTUBE_CONTEXT_CLIENT_VERSION"),
        "x-goog-visitor-id": context.client.visitorData,
        ...auth,
      },
      body: JSON.stringify({ context, playlistId, actions: [action] }),
    });

    const result = await response.json().catch(() => ({}));
    if (response.ok && result.status === "STATUS_SUCCEEDED") return;

    logError("edit_playlist request failed", {
      http: response.status,
      status: result.status,
      error: result.error?.message,
      sentAuthHeader: Boolean(auth.authorization),
      action,
    });
    throw new Error(`edit_playlist failed: HTTP ${response.status} ${result.status ?? result.error?.message ?? ""}`);
  }

  // ---------------------------------------------------------------------------
  // Sorting
  // ---------------------------------------------------------------------------

  const setVideoIdOf = (entry) => entry.playlistPanelVideoRenderer.playlistSetVideoId;
  const isQueueEntry = (entry) => Boolean(entry.playlistPanelVideoRenderer?.playlistSetVideoId);

  /** Sorts entries by length. Ties keep their original order. */
  function sortByLength(entries, descending) {
    return entries
      .map((entry, index) => ({ entry, index, seconds: videoSeconds(entry.playlistPanelVideoRenderer) }))
      .sort((a, b) => (descending ? b.seconds - a.seconds : a.seconds - b.seconds) || a.index - b.index);
  }

  /**
   * Works out the moves that turn `currentOrder` into `wantedOrder` (both lists of setVideoIds).
   * Each move says "put this entry right after that one" (`after` is undefined for the top slot).
   */
  function planMoves(currentOrder, wantedOrder) {
    const order = [...currentOrder];
    const moves = [];
    wantedOrder.forEach((setVideoId, position) => {
      if (order[position] === setVideoId) return;
      moves.push({ setVideoId, after: wantedOrder[position - 1] });
      order.splice(order.indexOf(setVideoId), 1);
      order.splice(position, 0, setVideoId);
    });
    return moves;
  }

  /**
   * Sorts the whole queue (the playing video included - it moves like any other row) and
   * refreshes the panel. `report` receives short status messages for the UI.
   */
  async function sortQueue(panel, descending, report) {
    const data = panel.data;
    const contents = data?.contents ?? [];
    if (!data?.playlistId) {
      logError("queue panel has no playlistId; YouTube's panel data may have changed", { dataKeys: Object.keys(data ?? {}) });
      return report(MESSAGE.noQueueData);
    }

    const entries = contents.filter(isQueueEntry);
    if (entries.length < 2) return report(MESSAGE.nothingToSort);

    const ranked = sortByLength(entries, descending);
    if (ranked.every((item) => item.seconds === Infinity)) {
      const first = entries[0].playlistPanelVideoRenderer;
      logError("could not read any video lengths", { rendererKeys: Object.keys(first), lengthText: first.lengthText });
      return report(MESSAGE.cantReadLengths);
    }

    const sortedEntries = ranked.map((item) => item.entry);
    const moves = planMoves(entries.map(setVideoIdOf), sortedEntries.map(setVideoIdOf));
    if (moves.length === 0) return report(MESSAGE.alreadySorted);

    for (const [index, move] of moves.entries()) {
      report(MESSAGE.progress(index + 1, moves.length), { final: false });
      await moveQueueItem(data.playlistId, move.setVideoId, move.after);
      await sleep(MOVE_DELAY_MS);
    }

    // Show the new order. Rows that aren't queue entries stay put, and the playing video
    // stays highlighted wherever it ended up.
    const playing = contents[data.currentIndex];
    const remaining = [...sortedEntries];
    const newContents = contents.map((entry) => (isQueueEntry(entry) ? remaining.shift() : entry));
    panel.data = {
      ...data,
      contents: newContents,
      currentIndex: playing ? newContents.indexOf(playing) : data.currentIndex,
    };
    report(MESSAGE.sorted);
  }

  // ---------------------------------------------------------------------------
  // UI: toast + button
  // ---------------------------------------------------------------------------

  const TOAST_STYLE = {
    position: "fixed",
    left: "50%",
    bottom: "24px",
    transform: "translateX(-50%)",
    zIndex: "99999",
    padding: "10px 16px",
    borderRadius: "8px",
    background: "var(--yt-spec-inverted-background, #f1f1f1)",
    color: "var(--yt-spec-static-overlay-text-primary-inverse, #0f0f0f)",
    font: "400 14px Roboto, Arial, sans-serif",
    boxShadow: "0 4px 16px rgba(0,0,0,.4)",
    pointerEvents: "none",
    transition: "opacity .2s",
  };

  const BUTTON_STYLE = {
    height: "36px",
    padding: "0 12px",
    marginRight: "4px",
    border: "none",
    borderRadius: "18px",
    background: "transparent",
    color: "var(--yt-spec-text-primary, #fff)",
    font: "500 14px/36px Roboto, Arial, sans-serif",
    whiteSpace: "nowrap",
    cursor: "pointer",
  };
  const BUTTON_HOVER_BACKGROUND = "var(--yt-spec-mono-tonal-hover, rgba(255,255,255,.1))";

  // Events we stop at the button so YouTube's header handlers don't close the queue on click.
  const EVENTS_TO_KEEP_LOCAL = ["pointerdown", "pointerup", "mousedown", "mouseup", "click"];

  // A page-level toast, so progress stays visible even if the queue panel closes.
  let toast;
  let hideToastTimer;
  function showToast(text, { final }) {
    toast ??= document.body.appendChild(createElement("div", TOAST_STYLE));
    toast.textContent = text;
    toast.style.opacity = "1";
    clearTimeout(hideToastTimer);
    if (final) hideToastTimer = setTimeout(() => (toast.style.opacity = "0"), TOAST_VISIBLE_MS);
  }

  function createSortButton(panel) {
    const button = createElement("button", BUTTON_STYLE, {
      id: BUTTON_ID,
      textContent: BUTTON_LABEL,
      title: BUTTON_TOOLTIP,
    });
    button.addEventListener("mouseenter", () => (button.style.background = BUTTON_HOVER_BACKGROUND));
    button.addEventListener("mouseleave", () => (button.style.background = BUTTON_STYLE.background));
    for (const type of EVENTS_TO_KEEP_LOCAL) button.addEventListener(type, (event) => event.stopPropagation());

    // Shows a message on the button and in the toast. Messages are final unless told otherwise;
    // a non-final message is progress ("3/12"), which gets a longer description in the toast.
    const report = (text, { final = true } = {}) => {
      button.textContent = text;
      showToast(final ? text : `Sorting queue ${text}`, { final });
    };

    let busy = false;
    button.addEventListener("click", async (event) => {
      if (busy) return;
      busy = true;
      try {
        await sortQueue(panel, event.shiftKey, report);
      } catch (error) {
        logError("sort failed", error);
        report(MESSAGE.error);
      }
      await sleep(RESET_LABEL_AFTER_MS);
      button.textContent = BUTTON_LABEL;
      busy = false;
    });
    return button;
  }

  // ---------------------------------------------------------------------------
  // Start-up: add the button whenever a queue panel appears
  // ---------------------------------------------------------------------------

  const isQueuePanel = (panel) => /queue/i.test(panel.querySelector(".title, h3")?.textContent ?? "");

  let warnedAboutMissingRow = false;

  function addButtonToQueuePanels() {
    for (const panel of document.querySelectorAll(PANEL_SELECTOR)) {
      if (!isQueuePanel(panel) || panel.querySelector(`#${BUTTON_ID}`)) continue;

      // The right-hand group of the header, just left of "Clear".
      const actionRow = panel.querySelector("#end-actions") ?? panel.querySelector("#playlist-actions");
      if (!actionRow) {
        if (!warnedAboutMissingRow) logError("queue panel found but its action row (#end-actions / #playlist-actions) is missing");
        warnedAboutMissingRow = true;
        continue;
      }
      actionRow.prepend(createSortButton(panel));
    }
  }

  new MutationObserver(addButtonToQueuePanels).observe(document.body, { childList: true, subtree: true });
  addButtonToQueuePanels();
})();
