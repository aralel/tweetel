/* ============================================================
   Tweetel – popup.js
   Handles: scan controls, real-time progress, search,
            paginated user list, storage management.
   ============================================================ */

"use strict";

// ─── Constants ────────────────────────────────────────────────────────────────
const STORAGE_KEY = "tweetel_followings";
const META_KEY = "tweetel_meta";
const PAGE_SIZE = 15;

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const elBtnScan = $("btn-scan");
const elBtnScanLabel = $("btn-scan-label");
const elBtnClear = $("btn-clear");
const elPageDot = $("page-dot");
const elPageLabel = $("page-label");
const elProgressWrap = $("progress-wrap");
const elProgressFill = $("progress-bar-fill");
const elProgressText = $("progress-text");
const elStatsRow = $("stats-row");
const elStatTotal = $("stat-total");
const elStatFiltered = $("stat-filtered");
const elStatLastScan = $("stat-last-scan");
const elSearchWrap = $("search-wrap");
const elSearchInput = $("search-input");
const elClearSearch = $("clear-search");
const elResultsWrap = $("results-wrap");
const elEmptyState = $("empty-state");
const elNoResults = $("no-results");
const elNoResultsQuery = $("no-results-query");
const elUserList = $("user-list");
const elPagination = $("pagination");
const elBtnFirst = $("btn-first");
const elBtnPrev = $("btn-prev");
const elBtnNext = $("btn-next");
const elBtnLast = $("btn-last");
const elPageInfo = $("page-info");
const elToast = $("toast");

// ─── Debug panel DOM refs ─────────────────────────────────────────────────────
const elDebugPanel = $("debug-panel");
const elDebugLivePill = $("debug-live-pill");
const elDebugIdleCount = $("debug-idle-count");
const elDebugResumeAttempts = $("debug-resume-attempts");
const elDebugLastMoved = $("debug-last-moved");
const elDebugAtBottom = $("debug-at-bottom");
const elDebugCycleDelay = $("debug-cycle-delay");
const elDebugSettleDelay = $("debug-settle-delay");
const elDebugScroller = $("debug-scroller");
const elDebugLastAction = $("debug-last-action");

// ─── App state ────────────────────────────────────────────────────────────────
let allUsers = []; // sorted array of all stored user objects
let filtered = []; // result of current search query
let currentPage = 1;
let totalPages = 1;
let isScanning = false;
let onFollowPage = false;
let toastTimer = null;
let lastTelemetry = null;

// ─── Initialization ───────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  await loadFromStorage();
  await refreshStatus();
  renderAll();
  bindEvents();
  bindTabListeners();
  listenForContentMessages();
  renderDebugPanel();
});

// ─── Storage ──────────────────────────────────────────────────────────────────

async function loadFromStorage() {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEY, META_KEY], (result) => {
      const map = result[STORAGE_KEY] || {};
      const meta = result[META_KEY] || {};

      // Convert map → sorted array (alphabetical by handle)
      allUsers = Object.values(map).sort((a, b) =>
        (a.handle || "").localeCompare(b.handle || ""),
      );

      // Update last-scan stat
      if (meta.lastScanAt) {
        elStatLastScan.textContent = formatRelativeTime(meta.lastScanAt);
      } else {
        elStatLastScan.textContent = "—";
      }

      resolve();
    });
  });
}

// ─── Tab status ───────────────────────────────────────────────────────────────

async function refreshStatus() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];

      if (!tab || !tab.id) {
        onFollowPage = false;
        isScanning = false;
        resolve();
        return;
      }

      const url = tab.url || "";
      const isTwitterTab = /^https:\/\/(twitter|x)\.com\//.test(url);

      if (!isTwitterTab) {
        onFollowPage = false;
        isScanning = false;
        resolve();
        return;
      }

      chrome.tabs.sendMessage(tab.id, { type: "GET_STATUS" }, (response) => {
        if (chrome.runtime.lastError) {
          // Content script may not be ready yet; fall back to URL-based detection
          onFollowPage = /\/[A-Za-z0-9_]{1,50}\/following(\?.*)?$/.test(url);
          isScanning = false;
          resolve();
          return;
        }

        if (response) {
          onFollowPage = !!response.onFollowingPage;
          isScanning = !!response.scanning;
        } else {
          onFollowPage = /\/[A-Za-z0-9_]{1,50}\/following(\?.*)?$/.test(url);
          isScanning = false;
        }

        resolve();
      });
    });
  });
}

// ─── Render pipeline ──────────────────────────────────────────────────────────

function renderAll() {
  renderStatusBar();
  applySearch(elSearchInput.value, false); // sets filtered + renders list
}

function renderStatusBar() {
  // Dot state
  elPageDot.className = "dot";
  if (isScanning) {
    elPageDot.classList.add("dot--scanning");
    elPageLabel.textContent = "Scanning following list…";
  } else if (onFollowPage) {
    elPageDot.classList.add("dot--ready");
    elPageLabel.textContent = "Ready to scan";
  } else {
    elPageDot.classList.add("dot--off");
    elPageLabel.textContent = "Not on a Following page";
  }

  // Scan button
  if (isScanning) {
    elBtnScan.className = "btn btn--stop";
    elBtnScanLabel.textContent = "Stop";
    elBtnScan.disabled = false;
    setScanBtnIcon("stop");
  } else {
    elBtnScan.className = "btn btn--primary";
    elBtnScanLabel.textContent = "Scan";
    elBtnScan.disabled = !onFollowPage;
    setScanBtnIcon("search");
  }

  // Progress bar visibility
  if (isScanning) {
    elProgressWrap.hidden = false;
  } else {
    elProgressWrap.hidden = true;
  }

  // Show / hide debug panel while scanning (or when there is cached telemetry)
  renderDebugPanel();
}

function setScanBtnIcon(type) {
  const svgStop = `<svg class="btn-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="6" y="6" width="12" height="12" rx="2"/>
  </svg>`;
  const svgSearch = `<svg class="btn-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="11" cy="11" r="8"/>
    <line x1="21" y1="21" x2="16.65" y2="16.65"/>
  </svg>`;
  // Replace only the SVG child (first child) of the button
  const existingSvg = elBtnScan.querySelector("svg");
  const wrapper = document.createElement("div");
  wrapper.innerHTML = type === "stop" ? svgStop : svgSearch;
  if (existingSvg) {
    elBtnScan.replaceChild(wrapper.firstElementChild, existingSvg);
  }
}

// ─── Search ───────────────────────────────────────────────────────────────────

function applySearch(rawQuery, resetPage = true) {
  const q = rawQuery.trim().toLowerCase().replace(/^@/, "");

  if (!q) {
    filtered = allUsers.slice();
  } else {
    filtered = allUsers.filter(
      (u) =>
        (u.handle || "").toLowerCase().includes(q) ||
        (u.name || "").toLowerCase().includes(q) ||
        (u.bio || "").toLowerCase().includes(q),
    );
  }

  if (resetPage) currentPage = 1;

  totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  if (currentPage > totalPages) currentPage = totalPages;

  renderStats(q);
  renderList(q);
  renderPagination();
}

// ─── Stats row ────────────────────────────────────────────────────────────────

function renderStats(query) {
  const hasData = allUsers.length > 0;

  if (hasData) {
    elStatsRow.hidden = false;
    elSearchWrap.hidden = false;
  } else {
    elStatsRow.hidden = true;
    elSearchWrap.hidden = true;
  }

  elStatTotal.textContent = allUsers.length.toLocaleString();
  elStatFiltered.textContent = query
    ? filtered.length.toLocaleString()
    : allUsers.length.toLocaleString();
}

// ─── User list ────────────────────────────────────────────────────────────────

function renderList(query = "") {
  const hasData = allUsers.length > 0;
  const hasResult = filtered.length > 0;
  const q = query.trim().toLowerCase().replace(/^@/, "");

  // Decide which state panel to show
  elEmptyState.hidden = hasData;
  elNoResults.hidden = !(hasData && !hasResult);
  elUserList.hidden = !hasResult;

  if (!hasResult) {
    elNoResultsQuery.textContent = query;
    return;
  }

  // Slice for current page
  const start = (currentPage - 1) * PAGE_SIZE;
  const end = start + PAGE_SIZE;
  const page = filtered.slice(start, end);

  // Build list items
  elUserList.innerHTML = "";
  const fragment = document.createDocumentFragment();

  page.forEach((user, idx) => {
    const li = buildUserCard(user, q, idx);
    fragment.appendChild(li);
  });

  elUserList.appendChild(fragment);
}

function buildUserCard(user, query, idx) {
  const li = document.createElement("li");
  li.className = "user-card";
  li.style.animationDelay = `${idx * 25}ms`;

  // ── Avatar ────────────────────────────────────────────────────────
  const avatarWrap = document.createElement("div");
  avatarWrap.className = "user-avatar-wrap";

  if (user.avatar) {
    const img = document.createElement("img");
    img.className = "user-avatar";
    img.src = user.avatar;
    img.alt = user.name || user.handle;
    img.loading = "lazy";
    img.onerror = () => {
      // Replace broken image with initials placeholder
      const ph = makePlaceholder(user);
      avatarWrap.replaceChild(ph, img);
    };
    avatarWrap.appendChild(img);
  } else {
    avatarWrap.appendChild(makePlaceholder(user));
  }

  // Verified badge on avatar
  if (user.verified) {
    const badge = document.createElement("span");
    badge.className = "verified-badge";
    badge.innerHTML = verifiedSVG("var(--blue)");
    avatarWrap.appendChild(badge);
  }

  // ── User info ─────────────────────────────────────────────────────
  const info = document.createElement("div");
  info.className = "user-info";

  // Name row
  const nameRow = document.createElement("div");
  nameRow.className = "user-name-row";

  const nameEl = document.createElement("span");
  nameEl.className = "user-name";
  nameEl.innerHTML = highlight(user.name || user.handle || "Unknown", query);
  nameRow.appendChild(nameEl);

  if (user.verified) {
    const tick = document.createElement("span");
    tick.className = "inline-verified";
    tick.innerHTML = verifiedSVG("var(--blue)");
    nameRow.appendChild(tick);
  }

  info.appendChild(nameRow);

  // Handle
  const handleEl = document.createElement("div");
  handleEl.className = "user-handle";
  handleEl.innerHTML = "@" + highlight(user.handle || "", query);
  info.appendChild(handleEl);

  // Bio (if any)
  if (user.bio && user.bio.trim()) {
    const bioEl = document.createElement("div");
    bioEl.className = "user-bio";
    bioEl.innerHTML = highlight(escapeHtml(user.bio), query);
    info.appendChild(bioEl);
  }

  // ── External link button ──────────────────────────────────────────
  const linkBtn = document.createElement("a");
  linkBtn.className = "user-link-btn";
  linkBtn.href = user.profileUrl || `https://x.com/${user.handle}`;
  linkBtn.target = "_blank";
  linkBtn.rel = "noopener noreferrer";
  linkBtn.title = `Open @${user.handle} on X`;
  linkBtn.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
         stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/>
      <polyline points="15 3 21 3 21 9"/>
      <line x1="10" y1="14" x2="21" y2="3"/>
    </svg>`;

  li.appendChild(avatarWrap);
  li.appendChild(info);
  li.appendChild(linkBtn);

  return li;
}

function makePlaceholder(user) {
  const ph = document.createElement("div");
  ph.className = "avatar-placeholder";
  const initials = getInitials(user.name || user.handle || "?");
  ph.textContent = initials;
  return ph;
}

function getInitials(str) {
  const parts = str.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return str.slice(0, 2).toUpperCase();
}

function verifiedSVG(color = "currentColor") {
  return `<svg viewBox="0 0 22 22" xmlns="http://www.w3.org/2000/svg">
    <path fill="${color}"
      d="M20.396 11c-.018-.646-.215-1.275-.57-1.816-.354-.54-.852-.972-1.438-1.246.051-.655-.17-1.302-.58-1.799-.409-.49-.964-.784-1.604-.836-.138-.537-.456-1.006-.903-1.336-.447-.33-.993-.499-1.552-.477-.633-.755-1.548-1.215-2.544-1.264-.993.049-1.906.51-2.538 1.265-.556-.022-1.1.148-1.547.476-.447.33-.765.8-.902 1.337-.639.053-1.193.347-1.602.838-.41.497-.629 1.144-.578 1.798-.586.275-1.083.707-1.437 1.248-.355.54-.551 1.17-.569 1.816.018.647.214 1.276.569 1.817.354.54.851.972 1.437 1.246-.051.655.17 1.302.579 1.799.409.49.964.784 1.604.836.137.537.455 1.006.902 1.336.447.33.993.499 1.552.477.633.754 1.548 1.213 2.543 1.264.993-.049 1.906-.508 2.538-1.264.556.022 1.1-.147 1.547-.476.447-.33.765-.799.902-1.336.639-.053 1.194-.346 1.603-.837.41-.496.629-1.143.579-1.799.586-.274 1.083-.706 1.437-1.247.355-.54.551-1.17.569-1.816zm-9.662 3.47L7.618 11.35l1.06-1.06 2.056 2.056 4.123-4.123 1.06 1.06-5.183 5.183z"/>
  </svg>`;
}

// ─── Pagination ───────────────────────────────────────────────────────────────

function renderPagination() {
  if (totalPages <= 1) {
    elPagination.hidden = true;
    return;
  }
  elPagination.hidden = false;

  elPageInfo.textContent = `Page ${currentPage} of ${totalPages}`;
  elBtnFirst.disabled = currentPage === 1;
  elBtnPrev.disabled = currentPage === 1;
  elBtnNext.disabled = currentPage === totalPages;
  elBtnLast.disabled = currentPage === totalPages;
}

// ─── Event bindings ───────────────────────────────────────────────────────────

function bindEvents() {
  // ── Scan / Stop ──────────────────────────────────────────────────
  elBtnScan.addEventListener("click", () => {
    if (isScanning) {
      sendMessage({ type: "STOP_SCAN" }, () => {
        isScanning = false;
        renderStatusBar();
        showToast("Scan stopped.", "warn");
      });
    } else {
      sendMessage({ type: "START_SCAN" }, (res) => {
        if (res && res.ok === false) {
          showToast(res.error || "Could not start scan.", "error");
          return;
        }
        isScanning = true;
        renderStatusBar();
        showToast("Scan started — scrolling your following list…");
      });
    }
  });

  // ── Clear all data ───────────────────────────────────────────────
  elBtnClear.addEventListener("click", () => {
    if (allUsers.length === 0) {
      showToast("Nothing to clear.", "warn");
      return;
    }
    const confirmed = window.confirm(
      `Delete all ${allUsers.length.toLocaleString()} stored followings?\nThis cannot be undone.`,
    );
    if (!confirmed) return;

    sendMessage({ type: "CLEAR_DATA" }, () => {
      allUsers = [];
      filtered = [];
      currentPage = 1;
      totalPages = 1;
      elSearchInput.value = "";
      elClearSearch.hidden = true;
      renderAll();
      showToast("All data cleared.", "warn");
    });
  });

  // ── Search input ──────────────────────────────────────────────────
  elSearchInput.addEventListener("input", (e) => {
    const val = e.target.value;
    elClearSearch.hidden = !val;
    applySearch(val);
  });

  elSearchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      elSearchInput.value = "";
      elClearSearch.hidden = true;
      applySearch("");
    }
  });

  elClearSearch.addEventListener("click", () => {
    elSearchInput.value = "";
    elClearSearch.hidden = true;
    applySearch("");
    elSearchInput.focus();
  });

  // ── Pagination ────────────────────────────────────────────────────
  elBtnFirst.addEventListener("click", () => goToPage(1));
  elBtnLast.addEventListener("click", () => goToPage(totalPages));
  elBtnPrev.addEventListener("click", () => goToPage(currentPage - 1));
  elBtnNext.addEventListener("click", () => goToPage(currentPage + 1));

  // Keyboard shortcuts for pagination
  document.addEventListener("keydown", (e) => {
    // Only when search is not focused
    if (document.activeElement === elSearchInput) return;
    if (e.key === "ArrowRight" || e.key === "ArrowDown")
      goToPage(currentPage + 1);
    if (e.key === "ArrowLeft" || e.key === "ArrowUp") goToPage(currentPage - 1);
    if (e.key === "Home") goToPage(1);
    if (e.key === "End") goToPage(totalPages);
  });
}

function goToPage(page) {
  const p = Math.max(1, Math.min(totalPages, page));
  if (p === currentPage) return;
  currentPage = p;
  renderList(elSearchInput.value.trim().toLowerCase().replace(/^@/, ""));
  renderPagination();
  // Scroll list to top when page changes
  elResultsWrap.scrollTop = 0;
}

function bindTabListeners() {
  chrome.tabs.onActivated.addListener(async () => {
    await refreshStatus();
    renderStatusBar();
  });

  chrome.tabs.onUpdated.addListener(async (_tabId, changeInfo) => {
    if (changeInfo.status !== "complete" && !changeInfo.url) return;
    await refreshStatus();
    renderStatusBar();
  });

  chrome.windows.onFocusChanged.addListener(async () => {
    await refreshStatus();
    renderStatusBar();
  });
}

// ─── Live messages from content script (via background) ───────────────────────

function listenForContentMessages() {
  chrome.runtime.onMessage.addListener(async (message) => {
    switch (message.type) {
      case "SCAN_STARTED":
        isScanning = true;
        elProgressWrap.hidden = false;
        elProgressText.textContent = "Scanning…";
        renderStatusBar();
        elDebugPanel.hidden = false;
        renderDebugPanel();
        break;

      case "SCAN_PROGRESS": {
        const count = message.count || 0;
        elProgressText.textContent = `Found ${count.toLocaleString()} followings…`;
        // Animate a pseudo-indeterminate fill up to 90%
        const pct = Math.min(90, 10 + Math.log2(count + 1) * 10);
        elProgressFill.style.width = pct + "%";
        // Merge new data into display without full re-render
        await loadFromStorage();
        applySearch(elSearchInput.value, false);
        break;
      }

      case "SCAN_DONE": {
        isScanning = false;
        elProgressFill.style.width = "100%";
        elProgressText.textContent = `Done! ${(message.count || 0).toLocaleString()} followings stored.`;
        setTimeout(() => {
          elProgressWrap.hidden = true;
          elProgressFill.style.width = "0%";
        }, 2000);
        await loadFromStorage();
        renderAll();
        renderDebugPanel(); // final state snapshot stays visible
        const reason =
          message.reason === "complete"
            ? `✓ Scan complete — ${(message.count || 0).toLocaleString()} followings stored.`
            : `Scan stopped — ${(message.count || 0).toLocaleString()} followings stored so far.`;
        showToast(reason, message.reason === "complete" ? "success" : "warn");
        break;
      }

      case "SCAN_ERROR":
        isScanning = false;
        elProgressWrap.hidden = true;
        renderStatusBar();
        renderDebugPanel();
        showToast(message.message || "An error occurred during scan.", "error");
        break;

      case "DATA_CLEARED":
        allUsers = [];
        filtered = [];
        currentPage = 1;
        totalPages = 1;
        lastTelemetry = null;
        renderAll();
        renderDebugPanel();
        break;

      case "PAGE_CHANGED":
        onFollowPage = !!message.onFollowingPage;
        renderStatusBar();
        break;

      case "SCAN_TELEMETRY":
        if (message.telemetry) {
          lastTelemetry = message.telemetry;
          renderDebugPanel();
        }
        break;
    }
  });
}

// ─── Debug panel ──────────────────────────────────────────────────────────────

const ACTION_LABELS = {
  idle: "Idle",
  scan_started: "Scan started",
  initializing: "Initializing…",
  waiting_for_cycle: "Waiting for next cycle…",
  scroll_cycle_started: "Scroll cycle started",
  scroll_burst_moved: "Scrolled — page moved",
  scroll_burst_no_move: "Scrolled — no movement",
  new_users_found: "✓ New users found",
  no_new_users_after_cycle: "No new users this cycle",
  // Tier 2 – nudge
  recovery_nudge_requested: "Nudge: attempting up/down recovery",
  recovery_nudge_succeeded: "Nudge: recovered — users loaded",
  recovery_nudge_failed: "Nudge: no new users yet, continuing…",
  // Tier 3 – auto-resume
  auto_resume_requested: "Auto-resume: deliberate reverse + forward",
  auto_resume_succeeded: "Auto-resume: recovered",
  auto_resume_failed: "Auto-resume: still stalled, trying more…",
  // Tier 4 – scroll back up and re-descend
  scroll_to_top_requested: "Scroll-back: returning up ~50 % of page",
  scroll_to_top_succeeded: "Scroll-back: new users found on re-descent",
  scroll_to_top_failed: "Scroll-back: re-descended, still waiting…",
  // Tier 5 – deep recovery
  deep_recovery_requested: "Deep recovery: click-activate + scroll to top",
  deep_recovery_succeeded: "Deep recovery: feed unlocked",
  deep_recovery_failed: "Deep recovery: no results yet, looping…",
  // General
  late_results_found_resuming: "Late results found — continuing",
  scheduling_next_cycle: "Scheduling next cycle",
  scan_done: "Scan done",
  user_stopped: "Stopped by user",
  navigated_away: "Navigated away from page",
};

// Map last-action strings onto a broad state for the pill colour
function derivePanelState(action) {
  if (!action || action === "idle") return "idle";
  if (["scan_done", "user_stopped", "navigated_away"].includes(action))
    return "done";
  if (
    [
      "recovery_nudge_requested",
      "recovery_nudge_failed",
      "auto_resume_requested",
      "auto_resume_failed",
      "scroll_to_top_requested",
      "scroll_to_top_failed",
      "deep_recovery_requested",
      "deep_recovery_failed",
      "no_new_users_after_cycle",
      "scroll_burst_no_move",
    ].includes(action)
  )
    return "stalled";
  return "scanning";
}

function renderDebugPanel() {
  const show = isScanning || lastTelemetry !== null;
  elDebugPanel.hidden = !show;
  if (!show) return;

  const t = lastTelemetry || {};
  const action = t.lastAction || "idle";
  const state = derivePanelState(action);

  // Panel border/pill colour via data attribute
  elDebugPanel.dataset.state = state;

  // Pill text
  const pillText = {
    scanning: "Live",
    stalled: "Stalled",
    done: "Done",
    idle: "Idle",
  };
  elDebugLivePill.textContent = pillText[state] || "Idle";

  // Numbers
  elDebugIdleCount.textContent = t.idleCount ?? "—";
  elDebugResumeAttempts.textContent = t.stallResumeAttempts ?? "—";

  // Boolean tiles — colour them with inline style for legibility
  setBoolValue(elDebugLastMoved, t.moved);
  setBoolValue(elDebugAtBottom, t.atBottom);

  // Timing
  elDebugCycleDelay.textContent =
    t.cycleDelay != null ? `${t.cycleDelay} ms` : "—";
  elDebugSettleDelay.textContent =
    t.settleDelay != null ? `${t.settleDelay} ms` : "—";

  // Scroller description
  elDebugScroller.textContent = t.scroller || "—";

  // Human-readable last action
  elDebugLastAction.textContent = ACTION_LABELS[action] || action;

  // Colour the last-action cell based on state
  elDebugLastAction.style.color =
    {
      scanning: "var(--text-primary)",
      stalled: "var(--warn)",
      done: "var(--success)",
      idle: "var(--text-secondary)",
    }[state] || "var(--text-primary)";
}

function setBoolValue(el, value) {
  if (value == null) {
    el.textContent = "—";
    el.style.color = "var(--text-muted)";
  } else if (value) {
    el.textContent = "Yes";
    el.style.color = "var(--success)";
  } else {
    el.textContent = "No";
    el.style.color = "var(--text-secondary)";
  }
}

// ─── Messaging helper ─────────────────────────────────────────────────────────

function sendMessage(message, callback) {
  chrome.runtime.sendMessage(message, (response) => {
    if (chrome.runtime.lastError) {
      // Suppress "no receiving end" errors when content script isn't ready
      if (callback)
        callback({ ok: false, error: chrome.runtime.lastError.message });
      return;
    }
    if (callback) callback(response);
  });
}

// ─── Toast ────────────────────────────────────────────────────────────────────

function showToast(text, type = "info") {
  console.log(text);
  if (toastTimer) clearTimeout(toastTimer);

  elToast.textContent = text;
  elToast.className = "toast";

  if (type === "success") elToast.classList.add("toast--success");
  if (type === "error") elToast.classList.add("toast--error");
  if (type === "warn") elToast.classList.add("toast--warn");

  // Force reflow so the CSS transition fires
  void elToast.offsetWidth;
  elToast.classList.add("show");

  const duration = type === "error" ? 4500 : 2800;
  toastTimer = setTimeout(() => {
    elToast.classList.remove("show");
  }, duration);
}

// ─── Utility helpers ──────────────────────────────────────────────────────────

/**
 * Highlights query matches inside a plain text string.
 * Returns HTML string with <mark> tags around each match.
 */
function highlight(text, query) {
  if (!query || !text) return escapeHtml(text || "");
  const safe = escapeHtml(text);
  const safeQ = escapeRegex(escapeHtml(query));
  return safe.replace(new RegExp(`(${safeQ})`, "gi"), "<mark>$1</mark>");
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Returns a human-readable relative time string (e.g. "2 hours ago").
 */
function formatRelativeTime(timestamp) {
  const diffMs = Date.now() - timestamp;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffSec < 60) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay < 30) return `${diffDay}d ago`;
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
