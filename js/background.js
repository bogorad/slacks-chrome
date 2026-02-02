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
// Tab Event Listeners
// ============================================================================

/**
 * Listen for tab updates to initialize favicon on Slack workspaces
 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (
    tab.url &&
    tab.url.match(/^https?:\/\/[^\/]*\.slack\.com/) &&
    changeInfo.status === "complete"
  ) {
    chrome.tabs.sendMessage(tabId, { action: "initFavicon" }).catch(() => {
      // Content script not ready or tab unavailable - expected in some cases
    });
  }
});

// ============================================================================
// Message Handler
// ============================================================================

/**
 * Handle messages from content scripts and popup
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Handle icon fetching
  if (message.action === "fetchIcon") {
    fetch(message.url)
      .then((response) => {
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        return response.blob();
      })
      .then((blob) => blobToDataURL(blob))
      .then((dataUrl) => sendResponse({ success: true, dataUrl: dataUrl }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }
});
