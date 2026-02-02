/**
 * Background script for Slacks Chrome Extension
 * Manages workspace tracking, favicon fetching, and inter-script communication
 */

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Converts a Blob to a Data URL
 * @param {Blob} blob - The blob to convert
 * @returns {Promise<string>} A promise resolving to the data URL
 */
function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// ============================================================================
// Workspace State Management
// ============================================================================

/** @type {Object.<number, Object>} Map of tab IDs to workspace info */
const workspaceState = {};

/**
 * Extracts workspace name from Slack URL
 * @param {string} url - The URL to parse
 * @returns {string} The workspace name or 'unknown'
 */
function extractWorkspaceFromUrl(url) {
  try {
    const match = new URL(url).hostname.match(/^([^.]+)\.slack\.com$/);
    return match ? match[1] : "unknown";
  } catch (error) {
    console.error("Error extracting workspace from URL:", error);
    return "unknown";
  }
}

// ============================================================================
// Tab Event Listeners
// ============================================================================

/**
 * Listen for tab updates to track Slack workspaces
 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tab.url && tab.url.match(/^https?:\/\/[^\/]*\.slack\.com/)) {
    if (changeInfo.status === "complete") {
      workspaceState[tabId] = {
        url: tab.url,
        workspace: extractWorkspaceFromUrl(tab.url),
        lastUpdated: Date.now(),
      };
      chrome.tabs.sendMessage(tabId, { action: "initFavicon" });
    }
  } else if (workspaceState[tabId]) {
    delete workspaceState[tabId];
  }
});

/**
 * Clean up workspace state when tabs are closed
 */
chrome.tabs.onRemoved.addListener((tabId) => {
  if (workspaceState[tabId]) {
    delete workspaceState[tabId];
  }
});

// ============================================================================
// Message Handler
// ============================================================================

/**
 * Handle messages from content scripts and popup
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Handle request for workspace info
  if (message.action === "getWorkspaceInfo") {
    const tabId = sender.tab.id;
    const workspaceInfo = workspaceState[tabId];
    sendResponse({
      workspace: workspaceInfo?.workspace || "unknown",
      success: !!workspaceInfo,
    });
    return true;
  }

  // Handle workspace icon update
  if (message.action === "updateWorkspaceIcon") {
    const tabId = sender.tab.id;
    if (workspaceState[tabId]) {
      workspaceState[tabId].iconData = message.iconData;
      workspaceState[tabId].lastUpdated = Date.now();
    }
    sendResponse({ success: true });
    return true;
  }

  // Handle icon fetching
  if (message.action === "fetchIcon") {
    fetch(message.url)
      .then((response) => response.blob())
      .then((blob) => blobToDataURL(blob))
      .then((dataUrl) => sendResponse({ success: true, dataUrl: dataUrl }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }
});
