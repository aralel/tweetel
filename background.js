/* ============================================================
   Tweetel – background.js  (MV3 Service Worker)
   Relays messages between popup.js and content.js,
   and keeps track of the active scan tab.
   ============================================================ */

"use strict";

// ─── Side Panel: open on toolbar icon click ───────────────────────────────────
// This replaces the old default_popup behaviour. The panel stays open across
// tab-clicks because it is a side panel, not a transient popup.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error("[Tweetel] sidePanel.setPanelBehavior:", err));

// ─── Active scan state ────────────────────────────────────────────────────────
// We remember which tab is currently being scanned so the popup can always
// reach the right content-script instance even if it is re-opened.
let activeScanTabId = null;

// ─── Helper: send a message to the content script in the given tab ────────────
function sendToContent(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

// ─── Helper: get the currently active Twitter/X tab ──────────────────────────
function getActiveTwitterTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (tab && /^https:\/\/(twitter|x)\.com\//.test(tab.url || "")) {
        resolve(tab);
      } else {
        resolve(null);
      }
    });
  });
}

// ─── Message router ───────────────────────────────────────────────────────────
//
// Messages FROM popup  → forwarded to content script in the active tab.
// Messages FROM content → forwarded to popup (all extension pages / listeners).
//
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // ── Messages originating from the popup ─────────────────────────────────
  if (!sender.tab) {
    // These come from popup.js (no tab context).
    (async () => {
      try {
        const tab = await getActiveTwitterTab();

        if (!tab) {
          sendResponse({ ok: false, error: "No active Twitter/X tab found." });
          return;
        }

        switch (message.type) {
          case "START_SCAN":
            activeScanTabId = tab.id;
            try {
              const res = await sendToContent(tab.id, { type: "START_SCAN" });
              sendResponse(res);
            } catch (err) {
              sendResponse({ ok: false, error: err.message });
            }
            break;

          case "STOP_SCAN":
            try {
              const res = await sendToContent(tab.id, { type: "STOP_SCAN" });
              sendResponse(res);
            } catch (err) {
              sendResponse({ ok: false, error: err.message });
            }
            break;

          case "GET_STATUS":
            try {
              const res = await sendToContent(tab.id, { type: "GET_STATUS" });
              sendResponse(res);
            } catch (err) {
              // Content script not yet ready in this tab
              sendResponse({
                ok: false,
                scanning: false,
                onFollowingPage: false,
                count: 0,
                error: err.message,
              });
            }
            break;

          case "CLEAR_DATA":
            try {
              const res = await sendToContent(tab.id, { type: "CLEAR_DATA" });
              sendResponse(res);
            } catch (err) {
              // Even if content script is unreachable, wipe storage directly
              chrome.storage.local.remove(
                ["tweetel_followings", "tweetel_meta"],
                () => sendResponse({ ok: true }),
              );
            }
            break;

          default:
            sendResponse({
              ok: false,
              error: "Unknown message type: " + message.type,
            });
        }
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();

    return true; // keep channel open for async response
  }

  // ── Messages originating from the content script ─────────────────────────
  // Forward them to any open extension pages (e.g. the popup) so the UI can
  // update in real-time.
  if (sender.tab) {
    const forwardable = [
      "SCAN_STARTED",
      "SCAN_PROGRESS",
      "SCAN_DONE",
      "SCAN_ERROR",
      "DATA_CLEARED",
      "PAGE_CHANGED",
      "SCAN_TELEMETRY",
    ];

    if (forwardable.includes(message.type)) {
      // Attach the source tab id so the popup can correlate if needed
      const enriched = { ...message, tabId: sender.tab.id };

      // chrome.runtime.sendMessage reaches all extension pages (popup, etc.)
      // We intentionally ignore "no receiving end" errors here – the popup
      // may simply be closed.
      chrome.runtime.sendMessage(enriched).catch(() => {});
    }
  }

  // No async response needed for forwarded content-script messages
  return false;
});

// ─── Tab close / navigation cleanup ──────────────────────────────────────────
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === activeScanTabId) {
    activeScanTabId = null;
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // If the scan tab navigates away entirely (e.g. closed & re-opened), reset.
  if (tabId === activeScanTabId && changeInfo.status === "loading") {
    // Content script will re-inject on the new page; state is reset automatically.
  }
});

// ─── Extension install / update handler ──────────────────────────────────────
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    // Initialise empty storage on first install
    chrome.storage.local.set({
      tweetel_followings: {},
      tweetel_meta: {
        count: 0,
        lastScanAt: null,
        scanPage: null,
      },
    });
  }
});
