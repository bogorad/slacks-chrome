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
  generalUnreadFavicon: null, // Composed favicon with pink ring badge
  personalUnreadFavicon: null, // Composed favicon with red filled badge
};

const UNREAD_STATE = {
  NONE: "none",
  GENERAL: "general",
  PERSONAL: "personal",
};

const UNREAD_PRIORITY = {
  [UNREAD_STATE.NONE]: 0,
  [UNREAD_STATE.GENERAL]: 1,
  [UNREAD_STATE.PERSONAL]: 2,
};

/** @type {string} Current unread state */
let unreadState = UNREAD_STATE.NONE;

/** @type {number} Counter for consecutive "no unreads" polls (for debouncing) */
let consecutiveNoUnreads = 0;

/** @type {number} Counter for consecutive PERSONAL -> GENERAL downgrade polls */
let consecutivePersonalDowngradePolls = 0;

/** @type {number} Required consecutive "no unreads" polls before switching to NONE */
const REQUIRED_NO_UNREAD_POLLS = 3;

/** @type {number} Required consecutive polls before PERSONAL -> GENERAL downgrade */
const REQUIRED_PERSONAL_DOWNGRADE_POLLS = 2;

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
  generalColor: "pink",
  personalColor: "red",
};

/** @type {Object} Extension settings */
let settings;

const COLOR_OPTIONS = {
  pink: "#FF5FA2",
  red: "#E01E5A",
  green: "#2EB67D",
  navy: "#1F2A6A",
  yellow: "#ECB22E",
};

const DEFAULT_GENERAL_COLOR = "pink";
const DEFAULT_PERSONAL_COLOR = "red";

const BADGE_RADIUS = 7.935;
const BADGE_CENTER_X = 24.065;
const BADGE_CENTER_Y = 7.935;
const PERSONAL_STROKE = "#FFFFFF";
const GENERAL_LINE_WIDTH = 4.4;
const PERSONAL_LINE_WIDTH = 1.15;

/**
 * @param {string|undefined} colorKey
 * @returns {string|undefined}
 */
function normalizeColorKey(colorKey) {
  if (colorKey === "blue") {
    return "navy";
  }
  return colorKey;
}

/**
 * @param {string|undefined} colorKey
 * @param {string} fallbackColor
 * @returns {string}
 */
function resolveNotificationColor(colorKey, fallbackColor) {
  const normalizedColor = normalizeColorKey(colorKey);
  if (normalizedColor && COLOR_OPTIONS[normalizedColor]) {
    return COLOR_OPTIONS[normalizedColor];
  }
  return COLOR_OPTIONS[fallbackColor];
}

/**
 * @param {Object} nextSettings
 * @returns {Object}
 */
function normalizeColorSettings(nextSettings) {
  const normalizedGeneralColor = normalizeColorKey(nextSettings.generalColor);
  const normalizedPersonalColor = normalizeColorKey(nextSettings.personalColor);

  return {
    ...nextSettings,
    generalColor: COLOR_OPTIONS[normalizedGeneralColor]
      ? normalizedGeneralColor
      : DEFAULT_GENERAL_COLOR,
    personalColor: COLOR_OPTIONS[normalizedPersonalColor]
      ? normalizedPersonalColor
      : DEFAULT_PERSONAL_COLOR,
  };
}

// ============================================================================
// Favicon Composition
// ============================================================================

/**
 * Composes a favicon with optional unread marker
 * @param {string} iconDataUrl - Base64 data URL of the workspace icon
 * @param {string} markType - One of UNREAD_STATE values
 * @returns {Promise<string>} A promise resolving to the composed favicon data URL
 */
function composeFavicon(iconDataUrl, markType) {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext("2d");

    const img = new Image();
    img.onload = () => {
      const personalFill = resolveNotificationColor(
        settings?.personalColor,
        DEFAULT_PERSONAL_COLOR
      );
      const generalStroke = resolveNotificationColor(
        settings?.generalColor,
        DEFAULT_GENERAL_COLOR
      );

      ctx.drawImage(img, 0, 0, 32, 32);

      if (markType === UNREAD_STATE.PERSONAL) {
        ctx.beginPath();
        ctx.arc(BADGE_CENTER_X, BADGE_CENTER_Y, BADGE_RADIUS, 0, Math.PI * 2);
        ctx.fillStyle = personalFill;
        ctx.fill();
        ctx.strokeStyle = PERSONAL_STROKE;
        ctx.lineWidth = PERSONAL_LINE_WIDTH;
        ctx.stroke();
      } else if (markType === UNREAD_STATE.GENERAL) {
        ctx.beginPath();
        ctx.arc(BADGE_CENTER_X, BADGE_CENTER_Y, BADGE_RADIUS, 0, Math.PI * 2);
        ctx.strokeStyle = generalStroke;
        ctx.lineWidth = GENERAL_LINE_WIDTH;
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
 * @param {Element|null} element
 * @returns {boolean}
 */
function isElementVisible(element) {
  if (!element) return false;
  const style = getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden";
}

/**
 * @param {Element|null} element
 * @returns {boolean}
 */
function hasNumericUnreadCount(element) {
  if (!element) return false;
  const text = element.textContent?.trim();
  return Boolean(text && /^\d+$/.test(text));
}

/**
 * @param {string} href
 * @returns {boolean}
 */
function isPersonalRouteHref(href) {
  if (!href) return false;
  return /\/client\/T[^/]+\/(D|G)[A-Z0-9]+/i.test(href)
    || /\/threads/i.test(href)
    || /\/mentions/i.test(href);
}

/**
 * @param {Element|null} element
 * @returns {boolean}
 */
function isPersonalElement(element) {
  if (!element) return false;
  const anchor = element.closest("a") || (element.matches("a") ? element : null);
  const href = anchor?.getAttribute("href") || "";
  if (isPersonalRouteHref(href)) return true;

  const dataQa = [
    element.getAttribute?.("data-qa") || "",
    anchor?.getAttribute?.("data-qa") || "",
  ].join(" ");
  return /mentions|threads|im_list|dm/i.test(dataQa);
}

/**
 * @param {Element} container
 * @returns {boolean}
 */
function hasVisibleUnreadBadge(container) {
  const badges = container.querySelectorAll(
    '.p-channel_sidebar__badge, ' +
    '.c-mention_badge, ' +
    '[data-qa="channel_sidebar_unreads"], ' +
    '.p-unreads_bar, ' +
    '.c-unified_member__secondary-name--with-badge'
  );

  for (const badge of badges) {
    if (!isElementVisible(badge)) continue;
    if (hasNumericUnreadCount(badge)) return true;
  }
  return false;
}

/**
 * @returns {{matched: boolean, reasons: string[]}}
 */
function detectPersonalUnreadSignals() {
  const reasons = [];

  const mentionBadges = document.querySelectorAll(".c-mention_badge");
  for (const badge of mentionBadges) {
    if (isElementVisible(badge) && hasNumericUnreadCount(badge)) {
      reasons.push("mention_badge");
      break;
    }
  }

  const personalUnreadItems = document.querySelectorAll(
    '.p-channel_sidebar__channel--unread, ' +
    '.p-channel_sidebar__link--unread, ' +
    '[data-qa-unread="true"]'
  );

  for (const item of personalUnreadItems) {
    if (!isElementVisible(item) && !isElementVisible(item.closest("a"))) continue;
    if (isPersonalElement(item)) {
      reasons.push("personal_unread_row");
      break;
    }
  }

  const personalContainers = document.querySelectorAll(
    'a[href*="/client/"][href*="/D"], ' +
    'a[href*="/client/"][href*="/G"], ' +
    'a[href*="/threads"], ' +
    'a[href*="/mentions"], ' +
    '[data-qa*="threads"], ' +
    '[data-qa*="mentions"]'
  );

  for (const container of personalContainers) {
    if (!isElementVisible(container)) continue;
    if (container.matches('.p-channel_sidebar__channel--unread, .p-channel_sidebar__link--unread, [data-qa-unread="true"]')
      || hasVisibleUnreadBadge(container)) {
      reasons.push("personal_nav_badge");
      break;
    }
  }

  return {
    matched: reasons.length > 0,
    reasons,
  };
}

/**
 * @returns {{matched: boolean, reasons: string[]}}
 */
function detectGeneralUnreadSignals() {
  const reasons = [];

  const rawHref = getCurrentFaviconRaw();
  if (/favicon[_-]?(urgent|unread)/i.test(rawHref)) {
    reasons.push("favicon_url_pattern");
  }

  const title = document.title;
  if (/^[*!]/.test(title) || /^\(\d+\)/.test(title)) {
    reasons.push("title_prefix");
  }

  const unreadIndicators = document.querySelectorAll(
    '.p-channel_sidebar__badge, ' +
    '.c-mention_badge, ' +
    '[data-qa="channel_sidebar_unreads"], ' +
    '.p-unreads_bar, ' +
    '.c-unified_member__secondary-name--with-badge'
  );

  for (const indicator of unreadIndicators) {
    if (!isElementVisible(indicator)) continue;
    if (!hasNumericUnreadCount(indicator)) continue;
    if (indicator.matches(".c-mention_badge") || isPersonalElement(indicator)) continue;

    reasons.push("sidebar_unread_badge");
    break;
  }

  const unreadChannels = document.querySelectorAll(
    '.p-channel_sidebar__channel--unread, ' +
    '.p-channel_sidebar__link--unread, ' +
    '[data-qa-unread="true"]'
  );
  for (const channel of unreadChannels) {
    if (!isElementVisible(channel) && !isElementVisible(channel.closest("a"))) continue;
    if (isPersonalElement(channel)) continue;

    reasons.push("unread_channel_row");
    break;
  }

  return {
    matched: reasons.length > 0,
    reasons,
  };
}

/**
 * Detects unread state for NONE | GENERAL | PERSONAL.
 * @returns {{state: string, reasons: string[], evidence: {personal: string[], general: string[]}}}
 */
function detectUnreadState() {
  const personalSignals = detectPersonalUnreadSignals();
  if (personalSignals.matched) {
    return {
      state: UNREAD_STATE.PERSONAL,
      reasons: personalSignals.reasons,
      evidence: {
        personal: personalSignals.reasons,
        general: [],
      },
    };
  }

  const generalSignals = detectGeneralUnreadSignals();
  if (generalSignals.matched) {
    return {
      state: UNREAD_STATE.GENERAL,
      reasons: generalSignals.reasons,
      evidence: {
        personal: [],
        general: generalSignals.reasons,
      },
    };
  }

  return {
    state: UNREAD_STATE.NONE,
    reasons: [],
    evidence: {
      personal: [],
      general: [],
    },
  };
}

/**
 * Compatibility wrapper: true if unread state is not NONE.
 * @returns {boolean}
 */
function detectUnreadFromFavicon() {
  return detectUnreadState().state !== UNREAD_STATE.NONE;
}

/**
 * @param {string} nextState
 * @param {string} source
 * @returns {boolean}
 */
function updateUnreadState(nextState, source) {
  const currentPriority = UNREAD_PRIORITY[unreadState];
  const nextPriority = UNREAD_PRIORITY[nextState];
  const isPeriodicSource = source === "periodic_poll";

  if (nextState === unreadState) {
    if (nextState !== UNREAD_STATE.NONE) {
      consecutiveNoUnreads = 0;
      consecutivePersonalDowngradePolls = 0;
    }
    return false;
  }

  if (nextPriority > currentPriority) {
    unreadState = nextState;
    consecutiveNoUnreads = 0;
    consecutivePersonalDowngradePolls = 0;
    logDebug("Unread state transition", { source, nextState, unreadState });
    return true;
  }

  if (nextState === UNREAD_STATE.NONE) {
    if (!isPeriodicSource) {
      return false;
    }

    consecutiveNoUnreads += 1;
    if (consecutiveNoUnreads < REQUIRED_NO_UNREAD_POLLS) {
      return false;
    }

    unreadState = UNREAD_STATE.NONE;
    consecutiveNoUnreads = 0;
    consecutivePersonalDowngradePolls = 0;
    logDebug("Unread state transition", { source, nextState, unreadState });
    return true;
  }

  if (unreadState === UNREAD_STATE.PERSONAL && nextState === UNREAD_STATE.GENERAL) {
    if (!isPeriodicSource) {
      return false;
    }

    consecutivePersonalDowngradePolls += 1;
    consecutiveNoUnreads = 0;
    if (consecutivePersonalDowngradePolls < REQUIRED_PERSONAL_DOWNGRADE_POLLS) {
      return false;
    }
  }

  unreadState = nextState;
  consecutiveNoUnreads = 0;
  consecutivePersonalDowngradePolls = 0;
  logDebug("Unread state transition", { source, nextState });
  return true;
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
    .forEach((node) => {
      node.remove();
    });
  const link = document.createElement("link");
  link.rel = "icon";
  link.type = "image/png";
  link.href = href;
  document.head.appendChild(link);
  logDebug("Favicon updated: ", href);
}

/**
 * Returns the correct favicon for current settings and unread state.
 * @param {Object} settings
 * @param {Object} icons
 * @returns {string|null}
 */
function getFaviconForState(settings, icons) {
  if (!settings.enable) {
    return icons.defaultIcon || null;
  }

  if (!iconCache.normalFavicon) {
    return icons.teamIcon || null;
  }

  if (!settings.showDot || unreadState === UNREAD_STATE.NONE) {
    return iconCache.normalFavicon;
  }

  if (unreadState === UNREAD_STATE.PERSONAL) {
    return iconCache.personalUnreadFavicon || iconCache.normalFavicon;
  }

  if (unreadState === UNREAD_STATE.GENERAL) {
    return iconCache.generalUnreadFavicon || iconCache.normalFavicon;
  }

  return iconCache.normalFavicon;
}

/**
 * Applies the appropriate favicon based on settings and state
 * @param {Object} settings - Extension settings
 * @param {Object} icons - Icon references
 * @param {string} icons.defaultIcon - Default favicon URL
 * @param {string} icons.teamIcon - Team icon URL
 */
function applyFavicon(settings, icons) {
  const favicon = getFaviconForState(settings, icons);
  if (favicon) {
    updateFavicon(favicon);
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
    iconCache.normalFavicon = await composeFavicon(response.dataUrl, UNREAD_STATE.NONE);
    iconCache.generalUnreadFavicon = await composeFavicon(response.dataUrl, UNREAD_STATE.GENERAL);
    iconCache.personalUnreadFavicon = await composeFavicon(response.dataUrl, UNREAD_STATE.PERSONAL);
    return { success: true };
  } catch (err) {
    logDebug("Error fetching icon, using direct URL:", err.message);
    // Fall back to direct URL (may fail on toDataURL but shows icon)
    iconCache.teamIconDataUrl = teamIconUrl;
    iconCache.normalFavicon = null;
    iconCache.generalUnreadFavicon = null;
    iconCache.personalUnreadFavicon = null;
    return { success: false };
  }
}

/**
 * Recomposes cached favicon variants using current settings.
 * @returns {Promise<boolean>} True when recomposition succeeds.
 */
async function recomposeCachedIcons() {
  if (!iconCache.teamIconDataUrl || !iconCache.teamIconDataUrl.startsWith("data:")) {
    return false;
  }

  try {
    iconCache.normalFavicon = await composeFavicon(iconCache.teamIconDataUrl, UNREAD_STATE.NONE);
    iconCache.generalUnreadFavicon = await composeFavicon(iconCache.teamIconDataUrl, UNREAD_STATE.GENERAL);
    iconCache.personalUnreadFavicon = await composeFavicon(iconCache.teamIconDataUrl, UNREAD_STATE.PERSONAL);
    return true;
  } catch (error) {
    logDebug("Error recomposing icons:", error?.message || error);
    return false;
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
    settings = normalizeColorSettings(await chrome.storage.local.get(defaultSettings));
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

    // Detect initial unread state
    const initialUnread = detectUnreadState();
    unreadState = initialUnread.state;
    consecutiveNoUnreads = 0;
    consecutivePersonalDowngradePolls = 0;
    logDebug("Initial unread state", initialUnread);

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

    const refreshUnreadState = (source) => {
      const detection = detectUnreadState();
      logDebug("Unread evidence", {
        source,
        state: detection.state,
        reasons: detection.reasons,
        evidence: detection.evidence,
      });

      const stateChanged = updateUnreadState(detection.state, source);
      if (stateChanged) {
        applyFavicon(settings, icons);
      }
    };

    new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "childList") {
          for (const node of mutation.addedNodes) {
            if (node.nodeName === "LINK" && node.nodeType === 1) {
              const relAttr = node.attributes.rel;
              if (relAttr && relAttr.value.includes("icon")) {
                const newHref = node.attributes.href?.value || "";
                logDebug("Icon node added, href:", newHref);
                refreshUnreadState("favicon_link_added");

                if (settings.enable) {
                  const favicon = getFaviconForState(settings, icons) || iconCache.teamIconDataUrl;
                  if (favicon) {
                    node.href = favicon;
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
                  newHref === iconCache.generalUnreadFavicon ||
                  newHref === iconCache.personalUnreadFavicon ||
                  newHref === iconCache.teamIconDataUrl) {
                continue;
              }

              logDebug("Icon href changed:", newHref);
              refreshUnreadState("favicon_href_changed");

              if (settings.enable) {
                const favicon = getFaviconForState(settings, icons) || iconCache.teamIconDataUrl;
                if (favicon) {
                  node.href = favicon;
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
            iconCache.generalUnreadFavicon = null;
            iconCache.personalUnreadFavicon = null;
            unreadState = UNREAD_STATE.NONE;
            consecutiveNoUnreads = 0;
            consecutivePersonalDowngradePolls = 0;

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
    chrome.storage.onChanged.addListener(async (changes, area) => {
      if (area === "local") {
        logDebug("Settings changed", changes);
        const newSettings = {};
        for (const key of Object.keys(changes)) {
          newSettings[key] = changes[key].newValue;
        }

        const colorChanged =
          Object.prototype.hasOwnProperty.call(newSettings, "generalColor") ||
          Object.prototype.hasOwnProperty.call(newSettings, "personalColor");

        settings = normalizeColorSettings({ ...settings, ...newSettings });

        if (colorChanged) {
          const refreshed = await recomposeCachedIcons();
          logDebug("Notification colors updated", {
            refreshed,
            generalColor: settings.generalColor,
            personalColor: settings.personalColor,
          });
        }

        applyFavicon(settings, icons);
      }
    });

    // Periodic unread state polling with debouncing
    setInterval(() => {
      if (!settings.enable || !iconCache.normalFavicon) return;

      const detection = detectUnreadState();
      logDebug("Unread evidence", {
        source: "periodic_poll",
        state: detection.state,
        reasons: detection.reasons,
        evidence: detection.evidence,
      });

      if (updateUnreadState(detection.state, "periodic_poll")) {
        applyFavicon(settings, icons);
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
