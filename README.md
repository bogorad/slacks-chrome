This repository is a fork of the original `slacks` extension by avv. It is adapted to show unread message signals more clearly.

Original extension:
https://chromewebstore.google.com/detail/slacks/dmliimlgdlahffkpjolldiofkeacdmna

---

# Slacks: Unread Detection and Favicon Markers

This document explains the current behavior of the extension, including the unread-state split.

## Features

- Unread state is **3-way**:
  - `none`
  - `general` (non-personal unread messages)
  - `personal` (DMs, mentions, thread activity)
- Favicon markers have two visual styles:
  - `general` -> **pink ring**
  - `personal` -> **filled red circle**
- Both markers are **15% larger** than the prior marker size.
- Popup UI has a visual refresh (CSS only; behavior unchanged).

---

## 1) Big Picture

When Slack changes unread state, the extension:

1. Classifies unread signals as `none`, `general`, or `personal`
2. Composes workspace favicon variant for that state
3. Replaces tab favicon to show the matching marker

```
SLACK UI SIGNALS
  - unread rows
  - badges
  - title prefix
  - favicon pattern
          |
          v
UNREAD CLASSIFIER
  none / general / personal
          |
          v
FAVICON OUTPUT
  none     -> icon only
  general  -> icon + pink ring
  personal -> icon + red filled circle
```

---

## 2) Core Runtime Flow

### On initialization

1. Load settings from `chrome.storage.local`
2. Discover workspace icon URL (`.c-team_icon`)
3. Fetch icon via background script (avoids content-script CORS problems)
4. Pre-compose and cache **3** favicons:
   - `normalFavicon`
   - `generalUnreadFavicon`
   - `personalUnreadFavicon`
5. Detect initial unread state
6. Apply correct favicon
7. Start change watchers:
   - `MutationObserver` on `<head>` icon links
   - periodic poll every 2s

### During runtime

- Any state upgrade is immediate (`none -> general`, `none -> personal`, `general -> personal`)
- Downgrades are debounced on polling only to avoid Slack SPA flicker

---

## 3) Unread Classification

Implementation lives in `js/content.js`:

- `detectPersonalUnreadSignals()`
- `detectGeneralUnreadSignals()`
- `detectUnreadState()`

### Priority

`personal` always wins over `general` when both are present.

### Personal signals

Personal means "this likely needs direct attention":

- mention badge elements with visible numeric counts
- unread rows that map to personal destinations:
  - DM-like routes (`/client/.../D...`)
  - MPIM-like routes (`/client/.../G...`)
  - `/threads`
  - `/mentions`
- matching `data-qa` hints (`mentions`, `threads`, `im_list`, `dm`)

### General signals

General unread means "there is unread activity" but not specifically personal:

- favicon raw href matches `favicon*(urgent|unread)`
- title prefix like `*` / `!` / `(N)`
- visible numeric unread badges (excluding personal-classified elements)
- unread row classes/attributes (excluding personal-classified rows)

---

## 4) Debounce and State Transitions

State constants:

- `UNREAD_STATE.NONE`
- `UNREAD_STATE.GENERAL`
- `UNREAD_STATE.PERSONAL`

Priority order:

- `none < general < personal`

Debounce behavior:

- `REQUIRED_NO_UNREAD_POLLS = 3`
  - need 3 consecutive polling checks with no unread before moving to `none`
- `REQUIRED_PERSONAL_DOWNGRADE_POLLS = 2`
  - need 2 consecutive polling checks before `personal -> general`
- mutation callbacks do **not** force downgrades; they only help with rapid upgrades

This avoids marker flapping during transient Slack DOM updates.

---

## 5) Marker Rendering

Rendering is in `composeFavicon(iconDataUrl, markType)`.

### Marker geometry

- center: `(25.1, 6.9)`
- radius: `6.9` (15% larger than old radius `6`)

### Personal marker (filled)

- fill: `#E01E5A`
- stroke: `#FFFFFF`
- stroke width: `1.15`

### General marker (ring)

- stroke: `#FF5FA2`
- stroke width: `4.4`
- transparent center

---

## 6) Favicon Application Rules

`getFaviconForState(settings, icons)` chooses output:

- if extension disabled -> default Slack favicon
- if enabled and `showDot` is false -> normal workspace favicon
- if enabled and `showDot` is true:
  - `none` -> normal favicon
  - `general` -> pink ring favicon
  - `personal` -> red filled favicon

Note: `showDot` now effectively means "show unread marker" (ring or filled).

---

## 7) Settings and Popup

Popup script remains simple and unchanged in behavior:

- `enable`
- `showDot`
- `debug`

Popup CSS was refreshed for clarity and polish, but control IDs and storage keys are unchanged.

---

## 8) Selectors Used

Common unread selectors:

- `.p-channel_sidebar__badge`
- `.c-mention_badge`
- `[data-qa="channel_sidebar_unreads"]`
- `.p-unreads_bar`
- `.c-unified_member__secondary-name--with-badge`
- `.p-channel_sidebar__channel--unread`
- `.p-channel_sidebar__link--unread`
- `[data-qa-unread="true"]`

Personal route hints:

- `/client/T.../D...`
- `/client/T.../G...`
- `/threads`
- `/mentions`

Workspace icon extraction:

- `.c-team_icon` (computed `background-image` URL)

---

## 9) Troubleshooting

| Symptom | Likely Cause | What to Check |
|---|---|---|
| No marker ever appears | selectors changed / no signals matched | enable `debug` and inspect unread evidence logs |
| Marker appears but wrong type | personal/general classification miss | inspect `isPersonalElement` evidence (`href`, `data-qa`) |
| Marker flickers during navigation | Slack SPA transient DOM | verify debounce constants and poll-based downgrade path |
| No team icon badge rendering | icon fetch/composition failed | check background `fetchIcon` responses and icon cache population |

---

## 10) File Map

- `js/content.js` - unread detection, classification, state transitions, favicon composition/application
- `js/background.js` - icon fetch bridge for content script
- `js/popup.js` - settings UI persistence
- `popup/popup.html` + `css/popup.css` - popup UI and visual style
