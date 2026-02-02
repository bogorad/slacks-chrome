# Slacks Extension: Notification Badge Feature

## Overview

Add red dot notification badge overlay to workspace favicons when unread messages exist.

**Goal:** Keep workspace icon identification (current behavior) AND show notification state (new feature).

---

## Current State Analysis

### Existing Architecture

```
manifest.json          - MV3, permissions: storage, host: *.slack.com
js/background.js       - Tracks tabs, extracts workspace name from URL
js/content.js          - Detects icons, sets favicon, observes changes
js/popup.js            - Settings UI (enable, debug mode)
popup/popup.html       - Toggle switches
css/popup.css          - Styling
```

### Current content.js Flow

1. On page load, captures:
   - Default favicon URL via `<link rel="icon">`
   - Team icon URL via `.c-team_icon` CSS background-image

2. If extension enabled, replaces favicon with team icon

3. MutationObserver watches `<head>` for new `<link rel="icon">` nodes
   - When Slack adds new favicon, immediately overwrites href with team icon
   - **Problem:** This blindly overwrites ALL changes, including unread notifications

### How Slack Signals Unread Messages

- Changes favicon URL from `favicon-*.png` to `favicon-unread-*.png`
- The "unread" version contains a red dot baked into the image
- Current extension destroys this signal by overwriting

---

## Revised Design

### Architecture Changes

```
┌─────────────────────────────────────────────────────────────────┐
│                        content.js                                │
│                                                                  │
│  ┌──────────────┐    ┌─────────────────┐    ┌────────────────┐  │
│  │ Icon Capture │───>│ Unread Detector │───>│ Favicon Setter │  │
│  │  h(), I()    │    │ (in observer)   │    │    s()         │  │
│  └──────────────┘    └────────┬────────┘    └───────▲────────┘  │
│                               │                      │           │
│                               ▼                      │           │
│                      ┌────────────────┐              │           │
│                      │ Canvas Composer│──────────────┘           │
│                      │ (new module)   │                          │
│                      └───────▲────────┘                          │
│                              │                                   │
└──────────────────────────────┼───────────────────────────────────┘
                               │
                    ┌──────────┴──────────┐
                    │   background.js     │
                    │  fetchIconAsDataURL │
                    │  (CORS bypass)      │
                    └─────────────────────┘
```

### Component Responsibilities

**1. Unread Detector (modify existing MutationObserver)**
- When new `<link rel="icon">` added, check if href contains "unread"
- Set state: `hasUnread = true/false`
- Trigger favicon update with appropriate variant

**2. Canvas Composer (new module)**
- Input: workspace icon (as data URL), hasUnread flag
- Creates 32x32 canvas
- Draws workspace icon scaled to fill
- If hasUnread: draws red circle (radius ~6px) at top-right corner
- Output: PNG data URL

**3. Background Script CORS Helper (new message handler)**
- Receives: `{action: "fetchIcon", url: "https://..."}`
- Fetches URL via `fetch()` (no CORS in service worker)
- Converts blob to base64 data URL
- Returns: `{success: true, dataUrl: "data:image/png;base64,..."}`

**4. Icon Cache (new)**
- Stores workspace icon as data URL (not remote URL)
- Stores composed favicons: `{normal: dataUrl, unread: dataUrl}`
- Invalidates on workspace change

---

## Data Flow

### Initialization

```
1. Page loads, content.js init()
2. Extract team icon URL from .c-team_icon CSS
3. Send to background: {action: "fetchIcon", url: teamIconUrl}
4. Background fetches, converts to data URL, returns
5. Content caches data URL
6. Compose normal favicon (no badge) via canvas
7. Compose unread favicon (with badge) via canvas
8. Cache both composed data URLs
9. Apply normal favicon
```

### Unread State Change

```
1. Slack adds new <link rel="icon"> with "unread" in href
2. MutationObserver fires
3. Check: does href include "unread"?
   - Yes: hasUnread = true
   - No: hasUnread = false
4. Apply cached favicon variant (unread or normal)
5. Prevent Slack's favicon from being used (remove/replace node)
```

---

## Implementation Plan

### Phase 1: Background Script - CORS Helper

**File:** `js/background.js`

**Step 1.1:** Add message handler for `fetchIcon` action
```javascript
// Pseudocode
if (message.action === "fetchIcon") {
    fetch(message.url)
        .then(response => response.blob())
        .then(blob => blobToDataURL(blob))
        .then(dataUrl => sendResponse({success: true, dataUrl}))
        .catch(err => sendResponse({success: false, error: err.message}));
    return true; // async response
}
```

**Step 1.2:** Add `blobToDataURL` helper function
- Use FileReader or base64 encoding

**Verify:** Test by sending message from console, confirm data URL returned

---

### Phase 2: Canvas Composer Module

**File:** `js/content.js` (add new functions)

**Step 2.1:** Create `composeFavicon(iconDataUrl, showBadge)` function
```javascript
// Pseudocode
function composeFavicon(iconDataUrl, showBadge) {
    return new Promise((resolve) => {
        const canvas = document.createElement('canvas');
        canvas.width = 32;
        canvas.height = 32;
        const ctx = canvas.getContext('2d');
        
        const img = new Image();
        img.onload = () => {
            // Draw workspace icon
            ctx.drawImage(img, 0, 0, 32, 32);
            
            if (showBadge) {
                // Draw red dot at top-right
                ctx.beginPath();
                ctx.arc(26, 6, 6, 0, Math.PI * 2);
                ctx.fillStyle = '#E01E5A'; // Slack red
                ctx.fill();
            }
            
            resolve(canvas.toDataURL('image/png'));
        };
        img.src = iconDataUrl;
    });
}
```

**Step 2.2:** Add optional white border around red dot for visibility
- `ctx.strokeStyle = 'white'; ctx.lineWidth = 1; ctx.stroke();`

**Verify:** Test in console with sample image, confirm output is valid data URL

---

### Phase 3: Icon Fetching and Caching

**File:** `js/content.js`

**Step 3.1:** Create icon cache object
```javascript
const iconCache = {
    teamIconDataUrl: null,
    normalFavicon: null,
    unreadFavicon: null
};
```

**Step 3.2:** Create `fetchAndCacheIcons()` async function
```javascript
async function fetchAndCacheIcons(teamIconUrl) {
    // Request background to fetch (CORS bypass)
    const response = await chrome.runtime.sendMessage({
        action: "fetchIcon",
        url: teamIconUrl
    });
    
    if (!response.success) {
        throw new Error(response.error);
    }
    
    iconCache.teamIconDataUrl = response.dataUrl;
    
    // Pre-compose both variants
    iconCache.normalFavicon = await composeFavicon(response.dataUrl, false);
    iconCache.unreadFavicon = await composeFavicon(response.dataUrl, true);
}
```

**Verify:** Log cache contents after init, confirm both variants exist

---

### Phase 4: Unread Detection Integration

**File:** `js/content.js`

**Step 4.1:** Add unread state variable
```javascript
let hasUnread = false;
```

**Step 4.2:** Modify MutationObserver callback
```javascript
// When new icon link added:
if (c.nodeName === "LINK" && c.attributes.rel?.value.includes("icon")) {
    const newHref = c.attributes.href?.value || "";
    
    // Detect unread state from Slack's favicon
    const newUnreadState = newHref.includes("unread");
    
    if (newUnreadState !== hasUnread) {
        hasUnread = newUnreadState;
        i("Unread state changed:", hasUnread);
    }
    
    // Apply our composed favicon
    if (o.enable && iconCache.normalFavicon) {
        c.href = hasUnread ? iconCache.unreadFavicon : iconCache.normalFavicon;
    }
}
```

**Verify:** Toggle unread in Slack, confirm badge appears/disappears

---

### Phase 5: Settings Integration

**File:** `js/content.js`

**Step 5.1:** Handle `showDot` setting (already in UI but disabled)
- Enable the "Show notification dot" checkbox in popup.html
- Read `showDot` from settings
- Only show red dot if `showDot` is enabled

**Step 5.2:** Update `f()` function to use cached favicons
```javascript
function f(settings, icons) {
    if (!settings.enable) {
        s(icons.defaultIcon);
        return;
    }
    
    if (iconCache.normalFavicon) {
        const favicon = (hasUnread && settings.showDot) 
            ? iconCache.unreadFavicon 
            : iconCache.normalFavicon;
        s(favicon);
    } else {
        s(icons.teamIcon);
    }
}
```

**Verify:** Toggle settings in popup, confirm behavior changes

---

### Phase 6: Edge Cases and Error Handling

**Step 6.1:** Handle missing team icon
- If `.c-team_icon` not found, fall back to default behavior
- Log warning in debug mode

**Step 6.2:** Handle fetch failures
- If background fetch fails, use original team icon URL directly
- Canvas will fail on toDataURL but at least shows icon

**Step 6.3:** Handle timing issues
- Team icon element may not exist immediately on page load
- Add retry logic or wait for element to appear

**Step 6.4:** Handle workspace switching
- Slack SPA may switch workspaces without full reload
- Detect URL change, invalidate cache, re-fetch icons

**Verify:** Test each edge case manually

---

### Phase 7: Code Cleanup

**Step 7.1:** De-minify existing code for maintainability
- Expand variable names
- Add comments
- Format properly

**Step 7.2:** Update popup.html
- Enable "Show notification dot" checkbox
- Update version number

**Step 7.3:** Update manifest.json
- Bump version to 1.1.0

---

## File Changes Summary

| File | Changes |
|------|---------|
| `js/background.js` | Add `fetchIcon` message handler, `blobToDataURL` helper |
| `js/content.js` | Add canvas composer, icon cache, unread detection, modify observer |
| `js/popup.js` | No changes needed (already handles showDot) |
| `popup/popup.html` | Enable "Show notification dot" checkbox |
| `manifest.json` | Bump version |

---

## Testing Checklist

- [ ] Extension disabled: default Slack favicon works normally
- [ ] Extension enabled, no unread: workspace icon shown (no badge)
- [ ] Extension enabled, unread messages: workspace icon + red dot
- [ ] Messages read: red dot disappears
- [ ] Settings toggle: showDot off hides badge even with unread
- [ ] Workspace switch: new workspace icon loads correctly
- [ ] Page refresh: icons cached and restored
- [ ] Multiple Slack tabs: each shows correct workspace icon
- [ ] Debug mode: logs show state changes

---

## Success Criteria

1. Workspace icons display correctly (existing behavior preserved)
2. Red dot badge appears when ANY unread messages exist
3. Red dot disappears when all messages read
4. User can toggle badge visibility in settings
5. No CORS errors in console
6. No performance degradation
