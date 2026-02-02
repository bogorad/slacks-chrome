This is a hack of the original `slacks` extension by my friend avv. I needed it to signal the presence of new messages so I cloned/hacked it. Below is the relevant docs on the delta. url of the original = https://chromewebstore.google.com/detail/slacks/dmliimlgdlahffkpjolldiofkeacdmna

---

# Unread Detection and Red Dot Drawing

A top-down technical explanation of how the Slacks Chrome Extension detects unread messages and draws a notification dot over the workspace icon.

---

## 1. The Big Picture

When you have unread messages in Slack, the extension:

1. **Detects** that unreads exist (using 4 different methods)
2. **Draws** a red dot on your workspace's team icon
3. **Sets** this composed image as the browser tab's favicon

```
SLACK PAGE                         BROWSER TAB
┌─────────────────┐               ┌─────────────┐
│  Sidebar has    │               │             │
│  unread badges  │──► DETECT ──► │  [icon]●    │
│  or CSS classes │               │             │
└─────────────────┘               └─────────────┘
```

---

## 2. High-Level Flow

```
ON PAGE LOAD:
    load user settings from storage
    wait for Slack's team icon element to appear in DOM
    fetch team icon image (via background script to bypass CORS)
    pre-compose TWO favicons:
        - normalFavicon  = team icon alone
        - unreadFavicon  = team icon + red dot
    detect initial unread state
    apply appropriate favicon
    start watching for changes

ON CHANGE DETECTED:
    run detection logic
    if unreads found AND dot not showing:
        show dot immediately
    if no unreads found AND dot showing:
        wait for 3 consecutive "no unreads" checks (debounce)
        then hide dot
```

---

## 3. Unread Detection

The extension tries 4 strategies in order. If ANY returns true, unreads exist.

### Strategy Overview

```
FUNCTION detectUnread():
    TRY Strategy 1: favicon URL contains "urgent" or "unread"
    TRY Strategy 2: page title starts with "*" or "(N)"
    TRY Strategy 3: sidebar has visible badge elements with numbers
    TRY Strategy 4: sidebar has channels with "--unread" CSS class
    
    RETURN true if any strategy matched
    RETURN false otherwise
```

### Strategy 1: Favicon URL Pattern

```
PURPOSE: Detect when Slack sets favicon to "favicon-urgent.ico"

HOW:
    get raw href attribute from <link rel="icon">
    test if href matches pattern "favicon" + "urgent" or "unread"
    
EXAMPLE MATCHES:
    "favicon-urgent.ico"        → true
    "favicon_unread.png"        → true
    "data:image/png;base64..."  → false (data URL, no pattern)

LIMITATION:
    Modern Slack uses data URLs directly, bypassing this detection
```

### Strategy 2: Document Title Prefix

```
PURPOSE: Detect title like "* Slack" or "(3) Slack"

HOW:
    read document.title
    check if starts with "*" or "!"
    check if starts with "(number)"

EXAMPLE MATCHES:
    "* general - Slack"    → true (asterisk prefix)
    "(5) Slack"            → true (count prefix)
    "general - Slack"      → false (no prefix)

LIMITATION:
    Not all Slack workspaces use title prefixes
```

### Strategy 3: Sidebar Badge Elements

```
PURPOSE: Find visible unread count badges in sidebar

HOW:
    query DOM for known badge elements:
        - .p-channel_sidebar__badge
        - .c-mention_badge  
        - [data-qa="channel_sidebar_unreads"]
        - .p-unreads_bar
        - .c-unified_member__secondary-name--with-badge
    
    for each element found:
        skip if hidden (display:none or visibility:hidden)
        check if text content is a number
        if yes → unreads exist

EXAMPLE:
    <span class="p-channel_sidebar__badge">3</span>
    → visible, contains "3" → unreads detected
```

### Strategy 4: Unread Channel CSS Classes

```
PURPOSE: Find channels styled as unread

HOW:
    query DOM for elements with unread modifier classes:
        - .p-channel_sidebar__channel--unread
        - .p-channel_sidebar__link--unread
        - [data-qa-unread="true"]
    
    if any exist → unreads detected

THIS IS THE PRIMARY WORKING METHOD
    Slack consistently applies these CSS classes to unread items
```

---

## 4. When Detection Runs

Detection is triggered by two mechanisms:

### Mechanism A: MutationObserver

```
PURPOSE: React when Slack changes the favicon

WATCHES:
    <head> element for:
        - new <link rel="icon"> nodes added
        - href attribute changes on existing icon links

ON TRIGGER:
    run detection
    if unreads found → set hasUnread = true immediately
    (never set to false here - defer to polling for debounce)
    apply our favicon over Slack's
```

### Mechanism B: Periodic Polling

```
PURPOSE: Catch sidebar changes that don't affect favicon

INTERVAL: every 2 seconds

ON TICK:
    run detection
    apply debouncing logic (see below)
    update favicon if state changed
```

---

## 5. Debouncing Logic

### The Problem

```
During Slack's DOM updates:
    1. Slack removes old favicon
    2. Detection runs → sidebar in transition → "no unreads" (FALSE!)
    3. Dot disappears
    4. Slack finishes updating
    5. Detection runs → "unreads found"
    6. Dot appears
    ... cycle repeats = "flapping"
```

### The Solution

```
RULE: Show dot immediately, hide dot only after sustained "no unreads"

STATE:
    hasUnread = boolean (current state)
    consecutiveNoUnreads = counter (how many polls found no unreads)
    REQUIRED_POLLS = 3 (6 seconds at 2s interval)

LOGIC:
    if unreads detected:
        consecutiveNoUnreads = 0          // reset counter
        if not hasUnread:
            hasUnread = true              // show dot immediately
            update favicon
    
    else (no unreads):
        consecutiveNoUnreads += 1         // increment counter
        if hasUnread AND consecutiveNoUnreads >= REQUIRED_POLLS:
            hasUnread = false             // hide dot after sustained no-unreads
            update favicon
```

### State Diagram

```
                         unreads found
                    ┌────────────────────┐
                    │                    │
                    ▼                    │
            ┌───────────────┐            │
            │               │            │
            │  DOT VISIBLE  │────────────┘
            │               │   no unreads (counter < 3)
            └───────┬───────┘
                    │
                    │ no unreads for 3+ polls
                    ▼
            ┌───────────────┐
            │               │
            │  DOT HIDDEN   │
            │               │
            └───────┬───────┘
                    │
                    │ unreads found (immediate)
                    │
                    └────────────────────► back to DOT VISIBLE
```

---

## 6. Drawing the Red Dot

### Step 1: Get Team Icon URL

```
PURPOSE: Find the workspace icon Slack displays in sidebar

HOW:
    find element with class ".c-team_icon"
    read its computed background-image CSS property
    extract URL from "url('https://...')" pattern

RESULT:
    URL like "https://avatars.slack-edge.com/.../team_icon_68.jpg"

RETRY LOGIC:
    Slack loads async, so retry up to 10 times with 500ms delay
```

### Step 2: Fetch Image via Background Script

```
PURPOSE: Download image as data URL (bypass CORS restrictions)

WHY BACKGROUND SCRIPT:
    content scripts can't fetch cross-origin images for canvas use
    background scripts have broader network permissions

FLOW:
    content script:
        send message {action: "fetchIcon", url: teamIconUrl}
    
    background script:
        fetch(url)
        convert response to blob
        convert blob to data URL using FileReader
        send back {success: true, dataUrl: "data:image/jpeg;base64,..."}
    
    content script:
        receive data URL for use in canvas
```

### Step 3: Compose Favicon on Canvas

```
PURPOSE: Create 32x32 favicon with optional red dot

INPUTS:
    iconDataUrl = base64 image of team icon
    showBadge = true/false

PROCESS:
    create 32x32 pixel canvas
    load team icon image
    draw image scaled to fill canvas
    
    if showBadge:
        draw filled circle:
            center: (26, 6)  // top-right area
            radius: 6 pixels
            fill color: #E01E5A (Slack red)
        draw circle border:
            color: white
            width: 1 pixel
    
    export canvas as PNG data URL

OUTPUT:
    "data:image/png;base64,..." (ready to use as favicon)
```

### Visual Layout

```
    0                              32
    ┌──────────────────────────────┐
  0 │                        ┌───┐ │
    │                        │ ● │ │ ← red dot
    │                        └───┘ │   center: (26, 6)
    │                              │   radius: 6px
    │   ┌──────────────────────┐   │
    │   │                      │   │
    │   │     TEAM ICON        │   │
    │   │     (scaled to       │   │
    │   │      fill canvas)    │   │
    │   │                      │   │
    │   └──────────────────────┘   │
 32 │                              │
    └──────────────────────────────┘
```

### Step 4: Cache Both Versions

```
AT INITIALIZATION:
    normalFavicon = compose(teamIcon, showBadge=false)
    unreadFavicon = compose(teamIcon, showBadge=true)
    
    store both in iconCache for instant switching
```

### Step 5: Apply Favicon

```
PURPOSE: Replace browser tab icon

HOW:
    remove all existing <link rel="icon"> elements from <head>
    create new <link> element:
        rel = "icon"
        type = "image/png"
        href = selected favicon data URL
    append to <head>

SELECTION:
    if extension disabled:
        use Slack's default icon
    else if hasUnread AND showDot setting enabled:
        use unreadFavicon (with dot)
    else:
        use normalFavicon (no dot)
```

---

## 7. Complete Initialization Sequence

```
WHEN: page load complete OR background script signals

1.  LOAD settings from chrome.storage.local
    - enable: boolean
    - showDot: boolean  
    - debug: boolean

2.  GET current workspace ID from URL
    - subdomain: "mycompany.slack.com" → "mycompany"
    - path: "app.slack.com/client/T0ABC123" → "T0ABC123"

3.  CAPTURE Slack's default favicon (for restore if disabled)

4.  WAIT for team icon element (retry loop)
    - query ".c-team_icon"
    - extract background-image URL
    - timeout after 10 attempts

5.  FETCH team icon via background script
    - send message with URL
    - receive base64 data URL

6.  COMPOSE both favicon versions
    - normalFavicon = icon without dot
    - unreadFavicon = icon with red dot
    - cache both

7.  DETECT initial unread state
    - run all 4 strategies
    - set hasUnread

8.  APPLY initial favicon
    - select based on hasUnread and settings

9.  START MutationObserver on <head>
    - watch for favicon link changes

10. START periodic polling interval
    - check every 2 seconds
    - apply debouncing

11. LISTEN for settings changes
    - update favicon when user toggles options
```

---

## 8. CSS Selectors Reference

### For Unread Detection

| Selector | What It Finds |
|----------|---------------|
| `.p-channel_sidebar__badge` | Unread count number on channel |
| `.c-mention_badge` | @mention notification badge |
| `.p-channel_sidebar__channel--unread` | Channel list item marked unread |
| `.p-channel_sidebar__link--unread` | Channel link marked unread |
| `[data-qa-unread="true"]` | QA test attribute for unread |

### For Icon Extraction

| Selector | What It Finds |
|----------|---------------|
| `.c-team_icon` | Workspace team icon in sidebar |
| `link[rel="icon"]` | Current favicon link element |

---

## 9. Why Each Design Decision

| Decision | Reason |
|----------|--------|
| 4 detection strategies | Slack changes behavior; multiple fallbacks ensure reliability |
| Background script for fetch | CORS prevents content script from fetching cross-origin images for canvas |
| Pre-compose both favicons | Instant switching without re-rendering on every state change |
| 32x32 canvas | Standard favicon size, sharp on most displays |
| Dot at (26,6) with r=6 | Visible but doesn't obscure icon; matches Slack's own notification style |
| #E01E5A red | Slack's brand color for notifications |
| White 1px border | Visibility on both light and dark icons |
| 2 second polling | Balance between responsiveness and performance |
| 3-poll debounce | 6 seconds prevents flapping during DOM transitions |
| MutationObserver on head | Catches Slack's favicon changes to override immediately |

---

## 10. Troubleshooting Quick Reference

| Symptom | Likely Cause | Check |
|---------|--------------|-------|
| No dot ever | Detection failing | Look for "detectUnread:" in console logs |
| No dot ever | Icon fetch failed | Look for "Icon cache populated" with null values |
| Dot flapping | Debounce too short | Increase REQUIRED_NO_UNREAD_POLLS |
| Wrong icon | Workspace switch | Check "Workspace changed" logs |
| CORS error | Missing permission | Verify host_permissions includes slack-edge.com |
