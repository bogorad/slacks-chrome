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

/** @type {NodeListOf<HTMLButtonElement>} Color option buttons */
const colorOptionButtons = document.querySelectorAll(".color-option");

const ALLOWED_COLORS = ["pink", "red", "green", "navy", "yellow"];

// ============================================================================
// Default Settings
// ============================================================================

/** @type {Object} Default extension settings */
const defaultSettings = {
  enable: false,
  showDot: false,
  debug: false,
  generalColor: "pink",
  personalColor: "red",
};

/**
 * @param {string|undefined} colorValue
 * @returns {string|undefined}
 */
function normalizeColorValue(colorValue) {
  if (colorValue === "blue") {
    return "navy";
  }
  return colorValue;
}

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
  enableExtensionCheckbox.checked = settings.enable;
  showNotificationDotCheckbox.checked = settings.showDot;
  debugModeCheckbox.checked = settings.debug;

  const normalizedGeneralColor = normalizeColorValue(settings.generalColor);
  const normalizedPersonalColor = normalizeColorValue(settings.personalColor);

  const generalColor = ALLOWED_COLORS.includes(normalizedGeneralColor)
    ? normalizedGeneralColor
    : defaultSettings.generalColor;
  const personalColor = ALLOWED_COLORS.includes(normalizedPersonalColor)
    ? normalizedPersonalColor
    : defaultSettings.personalColor;

  if (settings.generalColor !== generalColor || settings.personalColor !== personalColor) {
    saveSettings({ generalColor, personalColor });
  }

  setColorSelection("generalColor", generalColor);
  setColorSelection("personalColor", personalColor);

  updateDependentControls();
}

/**
 * Saves settings to Chrome storage
 * @param {Object} newSettings - Settings to save
 */
async function saveSettings(newSettings) {
  try {
    const currentSettings = await chrome.storage.local.get(defaultSettings);
    const mergedSettings = { ...currentSettings, ...newSettings };
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
    updateDependentControls();
  });

  showNotificationDotCheckbox.addEventListener("change", () => {
    saveSettings({ showDot: showNotificationDotCheckbox.checked });
    updateDependentControls();
  });

  debugModeCheckbox.addEventListener("change", () => {
    saveSettings({ debug: debugModeCheckbox.checked });
  });

  colorOptionButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const colorTarget = button.dataset.colorTarget;
      const color = button.dataset.color;
      if (!colorTarget || !color || !ALLOWED_COLORS.includes(color)) {
        return;
      }

      setColorSelection(colorTarget, color);
      saveSettings({ [colorTarget]: color });
    });
  });
}

/**
 * Marks the selected color in a picker group.
 * @param {string} colorTarget
 * @param {string} selectedColor
 */
function setColorSelection(colorTarget, selectedColor) {
  const options = document.querySelectorAll(
    `.color-option[data-color-target="${colorTarget}"]`
  );

  options.forEach((option) => {
    const isSelected = option.dataset.color === selectedColor;
    option.classList.toggle("selected", isSelected);
    option.setAttribute("aria-pressed", isSelected ? "true" : "false");
  });
}

/**
 * Updates dependent controls based on extension enable state
 */
function updateDependentControls() {
  const isEnabled = enableExtensionCheckbox.checked;
  const colorPickersEnabled = isEnabled && showNotificationDotCheckbox.checked;

  showNotificationDotCheckbox.disabled = !isEnabled;
  showNotificationDotCheckbox.parentElement.style.opacity = isEnabled ? "1" : "0.5";
  debugModeCheckbox.disabled = !isEnabled;
  debugModeCheckbox.parentElement.style.opacity = isEnabled ? "1" : "0.5";

  colorOptionButtons.forEach((button) => {
    button.disabled = !colorPickersEnabled;
  });

  const generalColorGroup = document.getElementById("generalColorGroup");
  if (generalColorGroup) {
    generalColorGroup.style.opacity = colorPickersEnabled ? "1" : "0.5";
  }

  const personalColorGroup = document.getElementById("personalColorGroup");
  if (personalColorGroup) {
    personalColorGroup.style.opacity = colorPickersEnabled ? "1" : "0.5";
  }
}
