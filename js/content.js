/**
 * Content script for Slacks Chrome Extension
 * Manages favicon updates and unread notification badges
 */

// ============================================================================
// Icon Cache
// ============================================================================

/** @type {Object} Cache for composed favicons */
const iconCache = {
  teamIconDataUrl: null, // Base64 data URL of original workspace icon
  normalFavicon: null, // Composed favicon without badge
  unreadFavicon: null, // Composed favicon with red dot badge
};

/** @type {boolean} Current unread state */
let hasUnread = false;

/** @type {number} Counter for consecutive "no unreads" polls (for debouncing) */
let consecutiveNoUnreads = 0;

/** @type {number} Required consecutive "no unreads" polls before switching to false */
const REQUIRED_NO_UNREAD_POLLS = 3;

/** @type {string|null} Current workspace name */
let currentWorkspace = null;

/** @type {boolean} Whether initialization has completed */
let isInitialized = false;

/** @type {boolean} Whether initialization is currently in progress */
let initInProgress = false;

/** @type {Object} Default extension settings */
const defaultSettings = {
  enable: false,
  showDot: false,
  debug: false,
};

/** @type {Object} Extension settings */
let settings;

// ============================================================================
// Favicon Composition
// ============================================================================

/**
 * Composes a favicon with optional unread badge
 * @param {string} iconDataUrl - Base64 data URL of the workspace icon
 * @param {boolean} showBadge - Whether to show the red notification dot
 * @returns {Promise<string>} A promise resolving to the composed favicon data URL
 */
function composeFavicon(iconDataUrl, showBadge) {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext("2d");

    const img = new Image();
    img.onload = () => {
      // Draw workspace icon
      ctx.drawImage(img, 0, 0, 32, 32);

      if (showBadge) {
        // Draw red dot at top-right
        ctx.beginPath();
        ctx.arc(26, 6, 6, 0, Math.PI * 2);
        ctx.fillStyle = "#E01E5A"; // Slack red
        ctx.fill();
        ctx.strokeStyle = "white";
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = () => {
      reject(new Error("Failed to load image for favicon composition"));
    };
    img.src = iconDataUrl;
  });
}

// ============================================================================
// Icon Discovery
// ============================================================================

/**
 * Gets the current favicon URL from the page
 * @returns {string|undefined} The current favicon href
 */
function getCurrentFavicon() {
  const element = document.querySelector(
    'link[rel="icon"], link[rel="shortcut icon"]'
  );
  if (element) return element.href;
}

/**
 * Gets the RAW href attribute (before browser resolves it)
 * This is needed to detect Slack's favicon-urgent pattern
 * @returns {string} The raw href attribute or empty string
 */
function getCurrentFaviconRaw() {
  const element = document.querySelector(
    'link[rel="icon"], link[rel="shortcut icon"]'
  );
  return element?.getAttribute('href') || "";
}

/**
 * Known Slack favicon data URL signatures for unread detection.
 * Slack uses specific data URLs for different states - we check the first ~100 chars.
 * These are the base64-encoded PNG favicon patterns Slack uses.
 */
const SLACK_UNREAD_FAVICON_SIGNATURES = [
  // Red dot favicon patterns (urgent/unread) - first part of the data URL
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAC", // 32x32 with red dot
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAA", // 16x16 with indicator
];

// Known "no unread" favicon signature (the purple hash icon)
const SLACK_NORMAL_FAVICON_SIGNATURE = "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAA";

/**
 * Detects if there are unread messages using multiple strategies:
 * 1. Check Slack's favicon URL for "urgent" pattern
 * 2. Check for unread badge elements in the sidebar
 * 3. Check document title for unread indicators
 * @returns {boolean} True if unreads detected
 */
function detectUnreadFromFavicon() {
  // Strategy 1: Check raw favicon href for "urgent" pattern (works if Slack uses file URLs)
  const rawHref = getCurrentFaviconRaw();
  if (/favicon[_-]?(urgent|unread)/i.test(rawHref)) {
    logDebug("detectUnread: found via favicon URL pattern", { rawHref });
    return true;
  }

  // Strategy 2: Check document title for unread indicators
  // Slack may prefix with "*" or "(N)" for unreads
  const title = document.title;
  if (/^[*!]/.test(title) || /^\(\d+\)/.test(title)) {
    logDebug("detectUnread: found via title prefix", { title });
    return true;
  }

  // Strategy 3: Check for unread badge/indicator elements in the sidebar
  // Slack uses various elements to show unread counts
  const unreadIndicators = document.querySelectorAll(
    '.p-channel_sidebar__badge, ' +
    '.c-mention_badge, ' +
    '[data-qa="channel_sidebar_unreads"], ' +
    '.p-unreads_bar, ' +
    '.c-unified_member__secondary-name--with-badge'
  );
  
  for (const indicator of unreadIndicators) {
    // Check if the indicator is visible and has content
    const style = getComputedStyle(indicator);
    if (style.display !== 'none' && style.visibility !== 'hidden') {
      const text = indicator.textContent?.trim();
      // Badge with a number means unreads
      if (text && /^\d+$/.test(text)) {
        logDebug("detectUnread: found via sidebar badge", { text, element: indicator.className });
        return true;
      }
    }
  }

  // Strategy 4: Check for channels/DMs with unread styling
  const unreadChannels = document.querySelectorAll(
    '.p-channel_sidebar__channel--unread, ' +
    '.p-channel_sidebar__link--unread, ' +
    '[data-qa-unread="true"]'
  );
  if (unreadChannels.length > 0) {
    logDebug("detectUnread: found via unread channel classes", { count: unreadChannels.length });
    return true;
  }

  logDebug("detectUnread: no unreads found", { rawHref: rawHref.substring(0, 50) + "..." });
  return false;
}

/**
 * Extracts the team icon URL from Slack's DOM
 * @returns {string|null} The team icon URL or null if not found
 */
function getTeamIconFromDom() {
  const element = document.querySelector(".c-team_icon");
  if (!element) {
    logDebug("Warning: .c-team_icon not found, falling back to default behavior");
    return null;
  }
  const match = getComputedStyle(element).backgroundImage.match(
    /url\(['"]?([^'"]+)['"]?\)/
  );
  if (match && match[1]) return match[1];
  return null;
}

/**
 * Extracts workspace identifier from current URL
 * Handles both subdomain URLs (mycompany.slack.com) and
 * app.slack.com/client/TXXXXXX/... URLs
 * @returns {string|null} The workspace name/Team ID or null
 */
function getWorkspaceFromUrl() {
  // Handle subdomain-based URLs (mycompany.slack.com)
  const subdomainMatch = location.hostname.match(/^([^.]+)\.slack\.com$/);
  if (subdomainMatch && subdomainMatch[1] !== "app") {
    return subdomainMatch[1];
  }

  // Handle app.slack.com/client/TXXXXXX/... URLs
  const pathMatch = location.pathname.match(/\/client\/(T[A-Za-z0-9]+)/i);
  if (pathMatch) {
    return pathMatch[1];
  }

  return null;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Logs debug messages if debug mode is enabled
 * @param {string} message - The message to log
 * @param {*} data - Optional data to log
 */
function logDebug(message, data) {
  if (settings?.debug) {
    console.log(`[slacks] ${message}`, data || "");
  }
}

/**
 * Waits for the team icon element to appear in the DOM
 * @param {number} maxRetries - Maximum number of retry attempts
 * @param {number} delayMs - Delay between retries in milliseconds
 * @returns {Promise<string|null>} The team icon URL or null
 */
async function waitForTeamIcon(maxRetries = 10, delayMs = 500) {
  for (let i = 0; i < maxRetries; i++) {
    const iconUrl = getTeamIconFromDom();
    if (iconUrl) return iconUrl;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return null;
}

// ============================================================================
// Favicon Management
// ============================================================================

/**
 * Updates the page favicon
 * @param {string} href - The new favicon URL
 */
function updateFavicon(href) {
  document
    .querySelectorAll('link[rel="icon"], link[rel="shortcut icon"]')
    .forEach((node) => node.remove());
  const link = document.createElement("link");
  link.rel = "icon";
  link.type = "image/png";
  link.href = href;
  document.head.appendChild(link);
  logDebug("Favicon updated: ", href);
}

/**
 * Applies the appropriate favicon based on settings and state
 * @param {Object} settings - Extension settings
 * @param {Object} icons - Icon references
 * @param {string} icons.defaultIcon - Default favicon URL
 * @param {string} icons.teamIcon - Team icon URL
 */
function applyFavicon(settings, icons) {
  if (!settings.enable) {
    if (icons.defaultIcon) {
      updateFavicon(icons.defaultIcon);
    }
    return;
  }

  if (iconCache.normalFavicon) {
    const favicon =
      hasUnread && settings.showDot
        ? iconCache.unreadFavicon
        : iconCache.normalFavicon;
    updateFavicon(favicon);
  } else {
    updateFavicon(icons.teamIcon);
  }
}

// ============================================================================
// Icon Fetching and Caching
// ============================================================================

/**
 * Fetches and caches composed favicons for the workspace
 * @param {string} teamIconUrl - URL of the team icon
 * @returns {Promise<{success: boolean}>} Whether caching succeeded
 */
async function fetchAndCacheIcons(teamIconUrl) {
  try {
    const response = await chrome.runtime.sendMessage({
      action: "fetchIcon",
      url: teamIconUrl,
    });

    if (!response.success) {
      throw new Error(response.error);
    }

    iconCache.teamIconDataUrl = response.dataUrl;
    iconCache.normalFavicon = await composeFavicon(response.dataUrl, false);
    iconCache.unreadFavicon = await composeFavicon(response.dataUrl, true);
    return { success: true };
  } catch (err) {
    logDebug("Error fetching icon, using direct URL:", err.message);
    // Fall back to direct URL (may fail on toDataURL but shows icon)
    iconCache.teamIconDataUrl = teamIconUrl;
    iconCache.normalFavicon = null;
    iconCache.unreadFavicon = null;
    return { success: false };
  }
}

// ============================================================================
// Initialization
// ============================================================================

/**
 * Initializes the content script
 */
async function init() {
  if (isInitialized || initInProgress) return;
  initInProgress = true;

  try {
    // Load settings
    settings = await chrome.storage.local.get(defaultSettings);
    logDebug("Settings loaded", settings);

    // Get current workspace
    currentWorkspace = getWorkspaceFromUrl();
    logDebug("Initial workspace:", currentWorkspace);

    // Initialize icon references
    const icons = {
      defaultIcon: null,
      teamIcon: null,
    };

    icons.defaultIcon = getCurrentFavicon();
    logDebug("Default icon", icons.defaultIcon);

    // Wait for team icon to be available
    const teamIconUrl = await waitForTeamIcon();
    if (!teamIconUrl) {
      logDebug("Team icon not found after retries, using default behavior");
      return;
    }

    icons.teamIcon = teamIconUrl;
    logDebug("Team icon", icons.teamIcon);

    // Fetch and cache composed favicons
    await fetchAndCacheIcons(teamIconUrl);
    logDebug("Icon cache populated", iconCache);

    // Detect initial unread state from favicon URL (Slack uses favicon-urgent.ico for unreads)
    hasUnread = detectUnreadFromFavicon();
    logDebug("Initial unread state from favicon:", { hasUnread });

    // Apply initial favicon
    applyFavicon(settings, icons);

    // Set up mutation observer for favicon updates (unread detection)
    // Watch both for new link elements (childList) and href changes on existing ones (attributes)
    const observerConfig = {
      attributes: true,
      attributeFilter: ["href"],
      childList: true,
      subtree: true,
    };

    const headElement = document.querySelector("head");

    new MutationObserver(async (mutations, observer) => {
      // Watch for favicon changes (Slack's unread indicator)
      for (const mutation of mutations) {
        if (mutation.type === "childList") {
          for (const node of mutation.addedNodes) {
            if (node.nodeName === "LINK" && node.nodeType === 1) {
              const relAttr = node.attributes.rel;
              if (relAttr && relAttr.value.includes("icon")) {
                const newHref = node.attributes.href?.value || "";
                logDebug("Icon node added, href:", newHref);
                // Detect unread from favicon URL (Slack uses favicon-urgent.ico)
                const newUnreadState = detectUnreadFromFavicon();
                logDebug("Unread detection from favicon:", { newUnreadState });

                // Apply debounced state change
                if (newUnreadState) {
                  consecutiveNoUnreads = 0;
                  if (!hasUnread) {
                    hasUnread = true;
                    logDebug("Unread state changed: true");
                  }
                }
                // Don't immediately set to false - let periodic polling handle debouncing

                if (settings.enable) {
                  // Use composed favicons if available, fall back to direct URL
                  if (iconCache.normalFavicon) {
                    node.href = (hasUnread && settings.showDot)
                      ? iconCache.unreadFavicon
                      : iconCache.normalFavicon;
                  } else if (iconCache.teamIconDataUrl) {
                    node.href = iconCache.teamIconDataUrl;
                  }
                }
              }
            }
          }
        } else if (mutation.type === "attributes" && mutation.attributeName === "href") {
          // Handle href attribute changes on existing link elements
          const node = mutation.target;
          if (node.nodeName === "LINK" && node.nodeType === 1) {
            const relAttr = node.attributes.rel;
            if (relAttr && relAttr.value.includes("icon")) {
              const newHref = node.href || "";

              // Prevent infinite loop: skip if href is already our favicon
              if (newHref === iconCache.normalFavicon ||
                  newHref === iconCache.unreadFavicon ||
                  newHref === iconCache.teamIconDataUrl) {
                return;
              }

              logDebug("Icon href changed:", newHref);
              // Detect unread from favicon URL (Slack uses favicon-urgent.ico)
              const newUnreadState = detectUnreadFromFavicon();
              logDebug("Unread detection from favicon:", { newUnreadState });

              // Apply debounced state change
              if (newUnreadState) {
                consecutiveNoUnreads = 0;
                if (!hasUnread) {
                  hasUnread = true;
                  logDebug("Unread state changed: true");
                }
              }
              // Don't immediately set to false - let periodic polling handle debouncing

              if (settings.enable) {
                // Use composed favicons if available, fall back to direct URL
                if (iconCache.normalFavicon) {
                  node.href = (hasUnread && settings.showDot)
                    ? iconCache.unreadFavicon
                    : iconCache.normalFavicon;
                } else if (iconCache.teamIconDataUrl) {
                  node.href = iconCache.teamIconDataUrl;
                }
              }
            }
          }
        }
      }
    }).observe(headElement, observerConfig);

    // Set up URL change observer for workspace switching (Slack SPA navigation)
    // Throttled to avoid excessive checks on busy pages
    let lastUrl = location.href;
    let urlCheckScheduled = false;
    new MutationObserver(() => {
      if (urlCheckScheduled) return;
      urlCheckScheduled = true;
      requestAnimationFrame(() => {
        urlCheckScheduled = false;
        if (location.href !== lastUrl) {
          lastUrl = location.href;
          const newWorkspace = getWorkspaceFromUrl();
          if (newWorkspace !== currentWorkspace) {
            currentWorkspace = newWorkspace;
            logDebug("Workspace changed to:", newWorkspace);

            // Clear icon cache for new workspace
            iconCache.teamIconDataUrl = null;
            iconCache.normalFavicon = null;
            iconCache.unreadFavicon = null;
            hasUnread = false;

            // Fetch new team icon
            waitForTeamIcon().then(async (newIconUrl) => {
              if (newIconUrl) {
                icons.defaultIcon = getCurrentFavicon();
                icons.teamIcon = newIconUrl;
                await fetchAndCacheIcons(newIconUrl);
                applyFavicon(settings, icons);
              }
            }).catch((err) => {
              logDebug("Error during workspace switch:", err.message);
            });
          }
        }
      });
    }).observe(document.body, { childList: true, subtree: true });

    // Listen for settings changes
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local") {
        logDebug("Settings changed", changes);
        const newSettings = {};
        for (const key of Object.keys(changes)) {
          newSettings[key] = changes[key].newValue;
        }
        settings = { ...settings, ...newSettings };
        applyFavicon(settings, icons);
      }
    });

    // Periodic unread state polling with debouncing
    // Since Slack uses data URLs for favicons, we need to poll the DOM for unread indicators
    // Debouncing prevents flapping during Slack's transient DOM states
    setInterval(() => {
      if (!settings.enable || !settings.showDot || !iconCache.normalFavicon) return;
      
      const newUnreadState = detectUnreadFromFavicon();
      
      if (newUnreadState) {
        // Unreads found - immediately set to true, reset counter
        consecutiveNoUnreads = 0;
        if (!hasUnread) {
          hasUnread = true;
          logDebug("Periodic check: unreads detected, showing dot");
          applyFavicon(settings, icons);
        }
      } else {
        // No unreads - require multiple consecutive polls before switching to false
        consecutiveNoUnreads++;
        if (hasUnread && consecutiveNoUnreads >= REQUIRED_NO_UNREAD_POLLS) {
          hasUnread = false;
          logDebug("Periodic check: no unreads for", consecutiveNoUnreads, "polls, hiding dot");
          applyFavicon(settings, icons);
        }
      }
    }, 2000); // Check every 2 seconds

    isInitialized = true;
    logDebug("init");
  } finally {
    initInProgress = false;
  }
}

// ============================================================================
// Entry Point
// ============================================================================

// Listen for messages from background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "initFavicon") {
    init();
    sendResponse({ success: true });
  }
  return true;
});

if (document.readyState === "complete") {
  init();
} else {
  window.addEventListener("load", init);
}
