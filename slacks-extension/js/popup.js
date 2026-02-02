/**
 * Popup script for Slacks Chrome Extension
 * Manages the popup UI and settings persistence
 */

// ============================================================================
// DOM Element References
// ============================================================================

/** @type {HTMLInputElement} Enable extension checkbox */
const enableExtensionCheckbox = document.getElementById("enableExtension");

/** @type {HTMLInputElement} Show notification dot checkbox */
const showNotificationDotCheckbox = document.getElementById("showNotificationDot");

/** @type {HTMLInputElement} Debug mode checkbox */
const debugModeCheckbox = document.getElementById("debugMode");

// ============================================================================
// Default Settings
// ============================================================================

/** @type {Object} Default extension settings */
const defaultSettings = {
  enable: false,
  showDot: false,
  debug: false,
};

// ============================================================================
// Initialization
// ============================================================================

/**
 * Initializes the popup when DOM is ready
 */
document.addEventListener("DOMContentLoaded", async () => {
  loadSettings();
  setupEventListeners();
});

// ============================================================================
// Settings Management
// ============================================================================

/**
 * Loads settings from Chrome storage and updates UI
 */
async function loadSettings() {
  const settings = await chrome.storage.local.get(defaultSettings);
  console.log("loaded settings", settings);
  enableExtensionCheckbox.checked = settings.enable;
  showNotificationDotCheckbox.checked = settings.showDot;
  debugModeCheckbox.checked = settings.debug;
}

/**
 * Saves settings to Chrome storage
 * @param {Object} newSettings - Settings to save
 */
async function saveSettings(newSettings) {
  try {
    const currentSettings = await chrome.storage.local.get(defaultSettings);
    const mergedSettings = { ...currentSettings, ...newSettings };
    console.log("saving settings", mergedSettings);
    await chrome.storage.local.set(mergedSettings);
  } catch (error) {
    console.error("Error saving settings:", error);
  }
}

// ============================================================================
// Event Listeners
// ============================================================================

/**
 * Sets up event listeners for UI controls
 */
function setupEventListeners() {
  enableExtensionCheckbox.addEventListener("change", () => {
    saveSettings({ enable: enableExtensionCheckbox.checked });
  });

  showNotificationDotCheckbox.addEventListener("change", () => {
    saveSettings({ showDot: showNotificationDotCheckbox.checked });
  });

  debugModeCheckbox.addEventListener("change", () => {
    saveSettings({ debug: debugModeCheckbox.checked });
  });
}
