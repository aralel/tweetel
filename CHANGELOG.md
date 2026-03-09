# Changelog

## [Unreleased]

### Fixed
- **Extension context invalidated error** — content script now detects when the extension is reloaded/updated mid-session; all `chrome.runtime` and `chrome.storage` calls are guarded, and the scroll loop, timer, and MutationObserver are torn down cleanly instead of throwing unhandled promise rejections.
- **`verified_followers` page support** — `isSupportedPage()` regex and `getPageType()` in `content.js` now recognise `/verified_followers` URLs; the page type is treated as `followers` so verified followers are merged correctly with the rest of the followers scan.
- **Page detection without refresh** — content script now broadcasts `PAGE_CHANGED` immediately on load (not only after navigation), so the popup dot/button updates correctly when the user is already on the right page.
- **SPA navigation detection improved** — poll interval reduced from 800 ms to 600 ms; now also fires when `onSupportedPage` state changes even if the URL string is identical (e.g. query param changes).
- **Popup tab listener** — `onUpdated` now also reacts to `changeInfo.url` events (SPA pushState navigations), not only `status === "complete"`, so the Ready indicator updates as soon as Twitter navigates to a following/followers page.
- **`verified_followers` fallback pattern** added to popup's `refreshStatus` URL regex so the dot turns green even when the content script hasn't responded yet.

### Docs
- Renamed `instructions.html` → `index.html`.
- Consolidated all CSS into `app.css`; removed duplicate and inline styles from all pages.
- Applied Ukraine theme (blue `#005BBB` / yellow `#FFD700`, light background).
- Added uniform site header with logo, brand name, and "Add to Chrome" button across all pages.
- "Add to Chrome" button links to the Chrome Web Store listing.
- Header is responsive: horizontal layout on desktop, stacked on mobile (≤600 px).
