/* ============================================================
   Tweetel – content.js
   Runs on twitter.com / x.com
   Scans the "Following" page, stores results in chrome.storage.local
   ============================================================ */

(() => {
  "use strict";

  // ─── Constants ────────────────────────────────────────────────────────────
  const STORAGE_KEY = "tweetel_followings";
  const META_KEY = "tweetel_meta";
  const SCROLL_DELAY_MIN = 900; // shortest pause between scroll cycles
  const SCROLL_DELAY_MAX = 1900; // longest pause between scroll cycles
  const SCROLL_STEP_MIN = 0.18; // min fraction of viewport height per burst
  const SCROLL_STEP_MAX = 0.42; // max fraction of viewport height per burst
  const WHEEL_BURST_MIN = 2; // minimum wheel events in one burst
  const WHEEL_BURST_MAX = 5; // maximum wheel events in one burst
  // ── Stall escalation thresholds (dry-cycle counts) ──────────────────────
  const STALL_SLOWDOWN_START = 4; // slow down inter-burst timing
  const STALL_NUDGE_START = 6; // light up/down nudge
  const STALL_RESUME_START = 9; // deliberate reverse-then-forward recovery
  const STALL_SCROLL_TO_TOP = 14; // scroll back up 50 % and re-descend
  const STALL_DEEP_RECOVERY = 20; // click-activate + scroll to near-top + long wait
  // Scan NEVER auto-stops. Only an explicit STOP_SCAN message or page navigation ends it.

  // Handles that belong to Twitter UI navigation – never treat as users
  const SKIP_HANDLES = new Set([
    "home",
    "explore",
    "notifications",
    "messages",
    "settings",
    "i",
    "search",
    "compose",
    "intent",
    "hashtag",
    "login",
    "signup",
    "tos",
    "privacy",
    "cookies",
    "accessibility",
    "ads",
    "about",
  ]);

  // ─── Runtime state ────────────────────────────────────────────────────────
  let scanning = false;
  let observer = null;
  let scrollTimer = null;
  let idleCount = 0;
  let stallResumeAttempts = 0;
  let collectedMap = {}; // handle (lowercase) → user object
  const seenCells = new WeakSet(); // DOM nodes already successfully parsed
  let lastTelemetry = {
    idleCount: 0,
    stallResumeAttempts: 0,
    moved: false,
    atBottom: false,
    cycleDelay: 0,
    settleDelay: 0,
    scroller: "unknown",
    lastAction: "idle",
    updatedAt: Date.now(),
  };

  // ─── URL helpers ──────────────────────────────────────────────────────────
  const isFollowingPage = () =>
    /^https:\/\/(twitter|x)\.com\/[A-Za-z0-9_]{1,50}\/following(\?.*)?$/.test(
      location.href,
    );

  // ─── Data-extraction helpers ───────────────────────────────────────────────

  /**
   * Returns the first clean Twitter handle found inside a UserCell.
   * Strategy 1 – look for a <span> whose visible text starts with "@".
   * Strategy 2 – parse href attributes of <a> tags inside the cell.
   */
  function extractHandle(cell) {
    // Strategy 1: span text starting with @
    const spans = cell.querySelectorAll("span");
    for (const s of spans) {
      const txt = s.textContent.trim();
      if (txt.startsWith("@")) {
        const handle = txt.slice(1).toLowerCase();
        if (/^[a-z0-9_]{1,50}$/.test(handle) && !SKIP_HANDLES.has(handle)) {
          return handle;
        }
      }
    }

    // Strategy 2: href of anchor links
    const anchors = cell.querySelectorAll('a[href^="/"]');
    for (const a of anchors) {
      const href = a.getAttribute("href") || "";
      const m = href.match(/^\/([A-Za-z0-9_]{1,50})(\/.*)?$/);
      if (m && !SKIP_HANDLES.has(m[1].toLowerCase())) {
        return m[1].toLowerCase();
      }
    }
    return null;
  }

  /**
   * Extracts the display name.
   * Twitter places it inside [data-testid="User-Name"] > first meaningful span.
   */
  function extractDisplayName(cell) {
    const nameBlock = cell.querySelector('[data-testid="User-Name"]');
    if (nameBlock) {
      // Walk spans; skip empty, skip @-handles, skip isolated single chars
      const spans = nameBlock.querySelectorAll("span");
      for (const s of spans) {
        const txt = s.textContent.trim();
        if (txt && !txt.startsWith("@") && txt.length > 1) {
          // Make sure we're not inside a deeper span that was already counted
          return txt;
        }
      }
    }
    // Fallback: first non-empty text content from any link inside the cell
    const links = cell.querySelectorAll('a[role="link"]');
    for (const a of links) {
      const txt = a.textContent.trim();
      if (txt && !txt.startsWith("@") && txt.length > 1) return txt;
    }
    return "";
  }

  /**
   * Extracts the profile image URL from the cell.
   * Twitter serves profile images from pbs.twimg.com/profile_images/…
   */
  function extractAvatar(cell) {
    const img = cell.querySelector('img[src*="profile_images"]');
    if (img) {
      // Upscale to 200px variant for better quality
      return img.src.replace(/_normal\./, "_200x200.");
    }
    return "";
  }

  /**
   * Extracts the short bio if Twitter renders it in the list view.
   * Falls back to an empty string – bio is reliably available only on profile pages.
   */
  function extractBio(cell) {
    // Bio blocks in following lists are div[dir="ltr"] or div[dir="auto"] that
    // are NOT part of the name/handle row.
    const nameBlock = cell.querySelector('[data-testid="User-Name"]');
    const divs = cell.querySelectorAll("div[dir]");
    for (const d of divs) {
      if (nameBlock && nameBlock.contains(d)) continue;
      const txt = d.textContent.trim();
      if (txt.length > 3 && !txt.startsWith("@")) return txt;
    }
    return "";
  }

  /**
   * Checks for the verified badge (official or Twitter Blue).
   */
  function extractVerified(cell) {
    return !!(
      cell.querySelector('[data-testid="icon-verified"]') ||
      cell.querySelector('[data-testid="verificationBadge"]') ||
      cell.querySelector('svg[aria-label="Verified account"]') ||
      cell.querySelector('[aria-label="Verified account"]')
    );
  }

  /**
   * Builds a user object from a single UserCell DOM node.
   * Returns null if a handle cannot be determined.
   */
  function parseUserCell(cell) {
    const handle = extractHandle(cell);
    if (!handle) return null;

    return {
      handle,
      name: extractDisplayName(cell),
      avatar: extractAvatar(cell),
      bio: extractBio(cell),
      verified: extractVerified(cell),
      profileUrl: `https://x.com/${handle}`,
      scannedAt: Date.now(),
    };
  }

  // ─── Storage helpers ──────────────────────────────────────────────────────

  function loadExisting() {
    return new Promise((resolve) => {
      chrome.storage.local.get([STORAGE_KEY], (res) => {
        const raw = res[STORAGE_KEY] || {};
        // Rebuild with normalized lowercase keys so that any legacy data
        // stored with mixed-case handles can never create duplicates.
        collectedMap = {};
        for (const [key, user] of Object.entries(raw)) {
          const normalizedHandle = (user.handle || key).toLowerCase().trim();
          if (normalizedHandle && /^[a-z0-9_]{1,50}$/.test(normalizedHandle)) {
            collectedMap[normalizedHandle] = {
              ...user,
              handle: normalizedHandle,
            };
          }
        }
        resolve();
      });
    });
  }

  function persist() {
    const meta = {
      count: Object.keys(collectedMap).length,
      lastScanAt: Date.now(),
      scanPage: location.href,
    };
    return new Promise((resolve) => {
      chrome.storage.local.set(
        { [STORAGE_KEY]: collectedMap, [META_KEY]: meta },
        resolve,
      );
    });
  }

  // ─── Messaging ────────────────────────────────────────────────────────────

  function broadcast(type, payload = {}) {
    try {
      chrome.runtime.sendMessage({ type, ...payload });
    } catch (_) {
      /* popup may be closed – that's fine */
    }
  }

  function describeScroller(scroller) {
    if (!scroller) return "unknown";
    if (
      scroller === document.scrollingElement ||
      scroller === document.documentElement
    ) {
      return "document.scrollingElement";
    }
    if (scroller === document.body) {
      return "document.body";
    }

    const parts = [scroller.tagName.toLowerCase()];
    if (scroller.id) parts.push(`#${scroller.id}`);
    if (scroller.getAttribute("role")) {
      parts.push(`[role="${scroller.getAttribute("role")}"]`);
    }
    if (scroller.dataset && scroller.dataset.testid) {
      parts.push(`[data-testid="${scroller.dataset.testid}"]`);
    } else if (scroller.getAttribute("data-testid")) {
      parts.push(`[data-testid="${scroller.getAttribute("data-testid")}"]`);
    }
    if (scroller.classList && scroller.classList.length) {
      parts.push(`.${Array.from(scroller.classList).slice(0, 2).join(".")}`);
    }

    return parts.join("");
  }

  function emitTelemetry(patch = {}) {
    lastTelemetry = {
      ...lastTelemetry,
      ...patch,
      idleCount,
      stallResumeAttempts,
      updatedAt: Date.now(),
    };

    broadcast("SCAN_TELEMETRY", {
      telemetry: lastTelemetry,
    });
  }

  // ─── Scanning ─────────────────────────────────────────────────────────────

  /**
   * Reads every UserCell currently in the DOM, adds unseen users to the map.
   * Returns the number of newly added users.
   */
  function scanVisible() {
    const cells = document.querySelectorAll('[data-testid="UserCell"]');
    let added = 0;
    for (const cell of cells) {
      // Skip cells we have already successfully parsed in this session.
      // This prevents the MutationObserver from re-processing the same node
      // hundreds of times as Twitter re-renders its virtual list.
      if (seenCells.has(cell)) continue;

      const user = parseUserCell(cell);
      if (!user) continue;

      // Mark cell as seen regardless of whether the handle is new,
      // so we don't waste time parsing it again.
      seenCells.add(cell);

      if (!collectedMap[user.handle]) {
        collectedMap[user.handle] = user;
        added++;
      }
    }
    if (added > 0) {
      persist();
      broadcast("SCAN_PROGRESS", { count: Object.keys(collectedMap).length });
    }
    return added;
  }

  // ─── Auto-scroll loop ─────────────────────────────────────────────────────

  function scheduleScroll() {
    if (!scanning) return;

    const cycleDelay = getAdaptiveCycleDelay(idleCount);

    emitTelemetry({
      cycleDelay,
      settleDelay: getPostScrollSettleDelay(idleCount),
      moved: false,
      atBottom: false,
      scroller: "pending",
      lastAction: "waiting_for_cycle",
    });

    scrollTimer = setTimeout(async () => {
      const before = Object.keys(collectedMap).length;
      const scroller = getActiveScrollContainer();
      const scrollerLabel = describeScroller(scroller);

      emitTelemetry({
        scroller: scrollerLabel,
        lastAction: "scroll_cycle_started",
      });

      // ── Pick tactic based on stall depth ──────────────────────────────────
      let moved = false;

      if (idleCount >= STALL_DEEP_RECOVERY) {
        // Tier 5 – click-activate + scroll to near-top + very long wait
        emitTelemetry({
          scroller: scrollerLabel,
          lastAction: "deep_recovery_requested",
        });
        moved = await performDeepRecovery(scroller);
        stallResumeAttempts += 1;
        emitTelemetry({
          moved,
          atBottom: isAtBottom(scroller),
          scroller: scrollerLabel,
          lastAction: moved
            ? "deep_recovery_succeeded"
            : "deep_recovery_failed",
        });
      } else if (idleCount >= STALL_SCROLL_TO_TOP) {
        // Tier 4 – scroll back up ~50 % then re-descend slowly
        emitTelemetry({
          scroller: scrollerLabel,
          lastAction: "scroll_to_top_requested",
        });
        moved = await performScrollToTopRecovery(scroller);
        emitTelemetry({
          moved,
          atBottom: isAtBottom(scroller),
          scroller: scrollerLabel,
          lastAction: moved
            ? "scroll_to_top_succeeded"
            : "scroll_to_top_failed",
        });
      } else if (idleCount >= STALL_RESUME_START) {
        // Tier 3 – deliberate reverse-then-forward auto-resume
        emitTelemetry({
          scroller: scrollerLabel,
          lastAction: "auto_resume_requested",
        });
        moved = await attemptAutoResume(scroller);
        stallResumeAttempts += moved ? 0 : 1;
        emitTelemetry({
          moved,
          atBottom: isAtBottom(scroller),
          scroller: scrollerLabel,
          lastAction: moved ? "auto_resume_succeeded" : "auto_resume_failed",
        });
        // Also do a short normal scroll burst after, regardless of outcome
        moved = (await performHumanScrollCycle(scroller, idleCount)) || moved;
      } else if (idleCount >= STALL_NUDGE_START) {
        // Tier 2 – light up/down nudge then normal scroll
        emitTelemetry({
          scroller: scrollerLabel,
          lastAction: "recovery_nudge_requested",
        });
        const nudged = await performRecoveryNudge(scroller);
        emitTelemetry({
          moved: nudged,
          atBottom: isAtBottom(scroller),
          scroller: scrollerLabel,
          lastAction: nudged
            ? "recovery_nudge_succeeded"
            : "recovery_nudge_failed",
        });
        moved = (await performHumanScrollCycle(scroller, idleCount)) || nudged;
      } else {
        // Tier 0-1 – normal human-like scroll burst (with slowdown if Tier 1)
        moved = await performHumanScrollCycle(scroller, idleCount);
      }

      // ── Settle, then sweep for new cells ──────────────────────────────────
      const settleDelay = getPostScrollSettleDelay(idleCount);
      emitTelemetry({
        moved,
        settleDelay,
        atBottom: isAtBottom(scroller),
        scroller: scrollerLabel,
        lastAction: moved ? "scroll_burst_moved" : "scroll_burst_no_move",
      });

      await delay(settleDelay);
      scanVisible();

      const after = Object.keys(collectedMap).length;
      const atBottom = isAtBottom(scroller);

      if (after > before) {
        idleCount = 0;
        stallResumeAttempts = 0;
      } else if (!moved) {
        idleCount += 2;
      } else {
        idleCount += 1;
      }

      emitTelemetry({
        moved,
        atBottom,
        scroller: scrollerLabel,
        lastAction:
          after > before ? "new_users_found" : "no_new_users_after_cycle",
      });

      // ── Always continue – user must click Stop to end the scan ────────────
      emitTelemetry({
        moved,
        atBottom,
        scroller: scrollerLabel,
        lastAction: "scheduling_next_cycle",
      });
      scheduleScroll();
    }, cycleDelay);
  }

  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function randomFloat(min, max) {
    return Math.random() * (max - min) + min;
  }

  function getAdaptiveCycleDelay(stallLevel) {
    const base = randomInt(SCROLL_DELAY_MIN, SCROLL_DELAY_MAX);
    if (stallLevel < STALL_SLOWDOWN_START) return base;
    // Grows up to ~6 s at deep stall levels, with added jitter
    const extra = Math.min(4200, (stallLevel - STALL_SLOWDOWN_START + 1) * 320);
    return base + extra + randomInt(0, 500);
  }

  function getPostScrollSettleDelay(stallLevel) {
    const base = randomInt(700, 1400);
    if (stallLevel < STALL_SLOWDOWN_START) return base;
    // Up to ~4 s settle time at deep stall levels
    return base + Math.min(2600, stallLevel * 180);
  }

  function getActiveScrollContainer() {
    const primary =
      document.querySelector('main[role="main"] section[role="region"]') ||
      document.querySelector(
        'main[role="main"] [data-testid="primaryColumn"]',
      ) ||
      document.querySelector('main[role="main"]');

    let node = primary;
    while (node && node !== document.body) {
      if (isScrollableElement(node)) {
        return node;
      }
      node = node.parentElement;
    }

    const candidates = Array.from(
      document.querySelectorAll("div, section, main"),
    )
      .filter((el) => isScrollableElement(el))
      .sort((a, b) => b.scrollHeight - a.scrollHeight);

    return (
      candidates[0] || document.scrollingElement || document.documentElement
    );
  }

  function isScrollableElement(el) {
    const style = getComputedStyle(el);
    return (
      el.scrollHeight > el.clientHeight + 100 &&
      style.overflowY !== "hidden" &&
      style.overflowY !== "clip"
    );
  }

  function getScrollDelta(scroller) {
    const viewportHeight =
      scroller === document.scrollingElement ||
      scroller === document.documentElement ||
      scroller === document.body
        ? window.innerHeight
        : scroller.clientHeight;

    return Math.max(
      120,
      Math.floor(
        viewportHeight * randomFloat(SCROLL_STEP_MIN, SCROLL_STEP_MAX),
      ),
    );
  }

  function getScrollerMetrics(scroller) {
    if (
      scroller === document.scrollingElement ||
      scroller === document.documentElement ||
      scroller === document.body
    ) {
      return {
        top: window.scrollY,
        height: window.innerHeight,
        scrollHeight: Math.max(
          document.body.scrollHeight,
          document.documentElement.scrollHeight,
        ),
      };
    }

    return {
      top: scroller.scrollTop,
      height: scroller.clientHeight,
      scrollHeight: scroller.scrollHeight,
    };
  }

  function isAtBottom(scroller) {
    const { top, height, scrollHeight } = getScrollerMetrics(scroller);
    return top + height >= scrollHeight - 300;
  }

  async function performHumanScrollCycle(scroller, stallLevel = 0) {
    const slowdownFactor =
      stallLevel < STALL_SLOWDOWN_START
        ? 1
        : Math.min(1.9, 1 + (stallLevel - STALL_SLOWDOWN_START + 1) * 0.12);

    const burstCount = Math.min(
      WHEEL_BURST_MAX + 1,
      randomInt(WHEEL_BURST_MIN, WHEEL_BURST_MAX) +
        (stallLevel >= STALL_NUDGE_START ? 1 : 0),
    );

    let moved = false;

    for (let i = 0; i < burstCount; i++) {
      const deltaY = Math.max(
        80,
        Math.floor(
          getScrollDelta(scroller) *
            (stallLevel >= STALL_SLOWDOWN_START ? randomFloat(0.72, 0.92) : 1),
        ),
      );

      const didMove = imitateMouseWheelScroll(scroller, deltaY);
      moved = moved || didMove;

      // Small within-burst pause, like a human wheel gesture train
      await delay(
        Math.floor(randomInt(90, 220) * slowdownFactor) + randomInt(0, 40),
      );

      if (isAtBottom(scroller)) break;
    }

    // Occasional extra pause that feels like reading / waiting for render
    const pauseChance = stallLevel >= STALL_SLOWDOWN_START ? 0.55 : 0.35;
    if (Math.random() < pauseChance) {
      await delay(
        Math.floor(randomInt(250, 700) * slowdownFactor) + randomInt(0, 120),
      );
    }

    return moved;
  }

  function imitateMouseWheelScroll(scroller, deltaY) {
    const target =
      scroller === document.scrollingElement ||
      scroller === document.documentElement ||
      scroller === document.body
        ? document.documentElement
        : scroller;

    const before = getScrollerMetrics(scroller).top;
    const rect = target.getBoundingClientRect();

    const baseX = rect.left + rect.width * randomFloat(0.38, 0.62);
    const baseY = rect.top + rect.height * randomFloat(0.58, 0.82);

    const clientX = Math.max(8, Math.floor(baseX + randomInt(-18, 18)));
    const clientY = Math.max(8, Math.floor(baseY + randomInt(-24, 24)));

    const pointerEventInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX,
      clientY,
    };

    const mouseEventInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX,
      clientY,
      screenX: clientX,
      screenY: clientY,
      buttons: 0,
    };

    const wheelEventInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX,
      clientY,
      deltaX: randomInt(-2, 2),
      deltaY,
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
    };

    try {
      target.dispatchEvent(new PointerEvent("pointerover", pointerEventInit));
      target.dispatchEvent(new PointerEvent("pointermove", pointerEventInit));
      target.dispatchEvent(new MouseEvent("mouseover", mouseEventInit));
      target.dispatchEvent(new MouseEvent("mousemove", mouseEventInit));
      target.dispatchEvent(new WheelEvent("wheel", wheelEventInit));
    } catch (_) {
      // Fall through to direct scroll fallback below.
    }

    if (
      scroller === document.scrollingElement ||
      scroller === document.documentElement ||
      scroller === document.body
    ) {
      window.scrollBy({ top: deltaY, behavior: "smooth" });
    } else {
      scroller.scrollBy({ top: deltaY, behavior: "smooth" });
    }

    const after = getScrollerMetrics(scroller).top;
    return after > before;
  }

  async function performRecoveryNudge(scroller) {
    const before = Object.keys(collectedMap).length;

    // Small reverse nudge
    imitateMouseWheelScroll(scroller, -randomInt(70, 160));
    await delay(randomInt(180, 320));

    // Then a slightly stronger forward nudge
    imitateMouseWheelScroll(scroller, randomInt(180, 320));
    await delay(randomInt(420, 760));

    scanVisible();
    return Object.keys(collectedMap).length > before;
  }

  async function attemptAutoResume(scroller) {
    const before = Object.keys(collectedMap).length;

    // Longer wait, then a deliberate reverse-then-forward sequence
    await delay(randomInt(1200, 2200));

    imitateMouseWheelScroll(scroller, -randomInt(140, 260));
    await delay(randomInt(300, 550));

    for (let i = 0; i < randomInt(3, 5); i++) {
      imitateMouseWheelScroll(scroller, randomInt(200, 380));
      await delay(randomInt(200, 400));
    }

    await delay(randomInt(900, 1600));
    scanVisible();

    return Object.keys(collectedMap).length > before;
  }

  /**
   * Tier 4 recovery: scroll back up ~50 % of the current position,
   * pause to let Twitter re-render, then re-descend in small steps.
   */
  async function performScrollToTopRecovery(scroller) {
    const before = Object.keys(collectedMap).length;
    const { top } = getScrollerMetrics(scroller);

    // How far to scroll back up (roughly half the current position, min 3 screens)
    const upDistance = Math.max(
      window.innerHeight * 3,
      Math.floor(top * randomFloat(0.45, 0.6)),
    );
    const steps = randomInt(6, 10);
    const stepSize = Math.floor(upDistance / steps);

    // Scroll back up in steps
    for (let i = 0; i < steps; i++) {
      imitateMouseWheelScroll(scroller, -stepSize);
      await delay(randomInt(80, 160));
    }

    // Long pause – let Twitter recycle the virtual list
    await delay(randomInt(1800, 3000));
    scanVisible();

    // Re-descend slowly with small increments
    const downSteps = randomInt(8, 14);
    let moved = false;
    for (let i = 0; i < downSteps; i++) {
      if (!scanning) break;
      const delta = Math.max(
        80,
        Math.floor(getScrollDelta(scroller) * randomFloat(0.5, 0.8)),
      );
      const didMove = imitateMouseWheelScroll(scroller, delta);
      moved = moved || didMove;
      await delay(randomInt(250, 500));
      scanVisible();
      if (isAtBottom(scroller)) break;
    }

    await delay(randomInt(800, 1400));
    scanVisible();

    return Object.keys(collectedMap).length > before;
  }

  /**
   * Tier 5 recovery: dispatch click/focus events to wake Twitter's
   * virtualizer, scroll near the top, wait a long time, then re-descend.
   */
  async function performDeepRecovery(scroller) {
    const before = Object.keys(collectedMap).length;

    // ── Step 1: click-activate the scroll container ────────────────────────
    activateScrollContainer(scroller);
    await delay(randomInt(400, 700));

    // ── Step 2: scroll near the top of the page ───────────────────────────
    const { top } = getScrollerMetrics(scroller);
    const upDistance = Math.max(window.innerHeight * 5, Math.floor(top * 0.9));
    const upSteps = randomInt(10, 16);
    const upStep = Math.floor(upDistance / upSteps);

    for (let i = 0; i < upSteps; i++) {
      imitateMouseWheelScroll(scroller, -upStep);
      await delay(randomInt(60, 130));
    }

    // ── Step 3: very long wait – let Twitter fully reset the virtual list ──
    await delay(randomInt(3000, 5500));
    scanVisible();

    // ── Step 4: re-descend with varied pace ───────────────────────────────
    let moved = false;
    const phases = randomInt(3, 5);
    for (let phase = 0; phase < phases; phase++) {
      if (!scanning) break;
      const burstSteps = randomInt(4, 8);
      for (let i = 0; i < burstSteps; i++) {
        if (!scanning) break;
        const delta = Math.max(
          80,
          Math.floor(getScrollDelta(scroller) * randomFloat(0.55, 0.85)),
        );
        const didMove = imitateMouseWheelScroll(scroller, delta);
        moved = moved || didMove;
        await delay(randomInt(180, 380));
        if (isAtBottom(scroller)) break;
      }
      // Pause between phases like a human reading
      await delay(randomInt(600, 1200));
      scanVisible();
      if (isAtBottom(scroller)) break;
    }

    await delay(randomInt(1000, 2000));
    scanVisible();

    return Object.keys(collectedMap).length > before;
  }

  /**
   * Dispatches pointer/mouse/focus/click events on the scroll container
   * to wake up Twitter's React virtualizer.
   */
  function activateScrollContainer(scroller) {
    const target =
      scroller === document.scrollingElement ||
      scroller === document.documentElement ||
      scroller === document.body
        ? document.documentElement
        : scroller;

    const rect = target.getBoundingClientRect();
    const clientX = Math.max(
      8,
      Math.floor(rect.left + rect.width * randomFloat(0.4, 0.6)),
    );
    const clientY = Math.max(
      8,
      Math.floor(rect.top + rect.height * randomFloat(0.3, 0.6)),
    );

    const shared = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX,
      clientY,
      screenX: clientX,
      screenY: clientY,
    };

    try {
      target.dispatchEvent(new PointerEvent("pointerover", { ...shared }));
      target.dispatchEvent(new PointerEvent("pointermove", { ...shared }));
      target.dispatchEvent(
        new PointerEvent("pointerdown", { ...shared, buttons: 1 }),
      );
      target.dispatchEvent(
        new MouseEvent("mousedown", { ...shared, buttons: 1 }),
      );
      target.dispatchEvent(new PointerEvent("pointerup", { ...shared }));
      target.dispatchEvent(new MouseEvent("mouseup", { ...shared }));
      target.dispatchEvent(new MouseEvent("click", { ...shared }));
      target.focus?.();
    } catch (_) {
      /* non-critical */
    }
  }

  // ─── MutationObserver – catches lazy-rendered cells ───────────────────────

  function startObserver() {
    if (observer) observer.disconnect();
    observer = new MutationObserver(() => {
      if (scanning) scanVisible();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function stopObserver() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
  }

  // ─── Start / Stop ─────────────────────────────────────────────────────────

  async function startScan() {
    if (scanning) return;

    if (!isFollowingPage()) {
      broadcast("SCAN_ERROR", {
        message:
          'Navigate to a Twitter/X "Following" page first, then click Scan.',
      });
      return;
    }

    scanning = true;
    idleCount = 0;
    stallResumeAttempts = 0;

    emitTelemetry({
      moved: false,
      atBottom: false,
      cycleDelay: 0,
      settleDelay: 0,
      scroller: "initializing",
      lastAction: "scan_started",
    });

    // Always reload from storage before scanning so that a second scan on the
    // same session merges with – rather than overwrites – previous results.
    await loadExisting();
    startObserver();
    scanVisible(); // capture whatever is already visible

    broadcast("SCAN_STARTED", { count: Object.keys(collectedMap).length });
    scheduleScroll();
  }

  function stopScan(reason = "stopped") {
    scanning = false;
    if (scrollTimer) {
      clearTimeout(scrollTimer);
      scrollTimer = null;
    }
    stopObserver();
    scanVisible(); // final sweep

    emitTelemetry({
      moved: false,
      atBottom: true,
      lastAction: reason === "complete" ? "scan_done" : reason,
    });

    broadcast("SCAN_DONE", {
      reason,
      count: Object.keys(collectedMap).length,
    });
  }

  // ─── Message handler (from popup / background) ────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.type) {
      case "START_SCAN":
        startScan();
        sendResponse({ ok: true });
        break;

      case "STOP_SCAN":
        stopScan("user_stopped");
        sendResponse({ ok: true });
        break;

      case "GET_STATUS":
        sendResponse({
          scanning,
          onFollowingPage: isFollowingPage(),
          count: Object.keys(collectedMap).length,
          url: location.href,
          telemetry: lastTelemetry,
        });
        break;

      case "CLEAR_DATA":
        collectedMap = {};
        chrome.storage.local.remove([STORAGE_KEY, META_KEY], () => {
          broadcast("DATA_CLEARED");
        });
        sendResponse({ ok: true });
        break;

      default:
        sendResponse({ ok: false, error: "Unknown message type: " + msg.type });
    }
    return true; // keep message channel open for async responses
  });

  // ─── SPA navigation watcher ───────────────────────────────────────────────
  // Twitter is a React SPA; history.pushState doesn't fire load events.
  // Poll href to catch navigation away from the following page.

  let _lastHref = location.href;

  setInterval(() => {
    if (location.href === _lastHref) return;
    _lastHref = location.href;

    if (scanning && !isFollowingPage()) {
      stopScan("navigated_away");
    }

    broadcast("PAGE_CHANGED", {
      url: location.href,
      onFollowingPage: isFollowingPage(),
    });
  }, 800);

  // ─── Init ─────────────────────────────────────────────────────────────────
  // Pre-load existing data so the count is immediately available on GET_STATUS
  loadExisting();
})();
