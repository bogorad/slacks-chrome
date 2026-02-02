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

/** @type {string|null} Current workspace name */
let currentWorkspace = null;

/** @type {boolean} Whether initialization has completed */
let isInitialized = false;

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
  return new Promise((resolve) => {
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
}

/**
 * Extracts workspace name from current URL
 * @returns {string|null} The workspace name or null
 */
function getWorkspaceFromUrl() {
  const match = location.hostname.match(/^([^.]+)\.slack\.com$/);
  return match ? match[1] : null;
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
  if (settings.debug) {
    console.log(`[slacks] ${message}`, data || "");
  }
}

/**
 * Waits for the team icon element to appear in the DOM
 * @param {number} maxRetries - Maximum number of retry attempts
 * @param {number} delayMs - Delay between retries in milliseconds
 * @returns {Promise<string|null>} The team icon URL or null
 */
async function waitForTeamIcon(maxRetries = 5, delayMs = 500) {
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
    updateFavicon(icons.defaultIcon);
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
  } catch (err) {
    logDebug("Error fetching icon, using direct URL:", err.message);
    // Fall back to direct URL (may fail on toDataURL but shows icon)
    iconCache.teamIconDataUrl = teamIconUrl;
    iconCache.normalFavicon = null;
    iconCache.unreadFavicon = null;
  }
}

// ============================================================================
// Initialization
// ============================================================================

/**
 * Initializes the content script
 */
async function init() {
  if (isInitialized) return;

  // Load settings
  settings = await chrome.storage.local.get(settings);
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

  // Apply initial favicon
  applyFavicon(settings, icons);

  // Set up mutation observer for workspace changes and favicon updates
  const observerConfig = {
    attributes: false,
    childList: true,
    subtree: false,
  };

  const headElement = document.querySelector("head");

  new MutationObserver(async (mutations, observer) => {
    // Check for workspace change
    const newWorkspace = getWorkspaceFromUrl();
    if (newWorkspace !== currentWorkspace) {
      currentWorkspace = newWorkspace;
      logDebug("Workspace changed to:", newWorkspace);

      // Clear icon cache for new workspace
      iconCache.teamIconDataUrl = null;
      iconCache.normalFavicon = null;
      iconCache.unreadFavicon = null;

      // Fetch new team icon
      const newIconUrl = await waitForTeamIcon();
      if (newIconUrl) {
        icons.teamIcon = newIconUrl;
        await fetchAndCacheIcons(newIconUrl);
        applyFavicon(settings, icons);
      }
    }

    // Watch for favicon changes (Slack's unread indicator)
    for (const mutation of mutations) {
      if (mutation.type === "childList") {
        for (const node of mutation.addedNodes) {
          if (node.nodeName === "LINK" && node.nodeType === 1) {
            const relAttr = node.attributes.rel;
            if (relAttr && relAttr.value.includes("icon")) {
              logDebug("Icon node added: ", node);
              const newHref = node.attributes.href?.value || "";
              const newUnreadState = newHref.includes("unread");

              if (newUnreadState !== hasUnread) {
                hasUnread = newUnreadState;
                logDebug("Unread state changed:", hasUnread);
              }

              if (settings.enable && iconCache.normalFavicon) {
                node.href = hasUnread
                  ? iconCache.unreadFavicon
                  : iconCache.normalFavicon;
              }
            }
          }
        }
      }
    }
  }).observe(headElement, observerConfig);

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

  isInitialized = true;
  logDebug("init");
}

// ============================================================================
// Entry Point
// ============================================================================

if (document.readyState === "complete") {
  init();
} else {
  window.addEventListener("load", init);
}
