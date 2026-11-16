// Lets the user recolor the UI's key theme variables from Edit > Preferences.
// Colors are applied as inline CSS custom properties on <html>, which override
// the defaults declared in style.css, and are persisted in localStorage so
// they survive an app restart. This is a small, non-sensitive local setting
// (not user/document data), so plain localStorage is the right tool here.

const STORAGE_KEY = 'hcs-theme-v1';

// Must match the defaults in style.css's :root block.
const DEFAULTS = {
  '--bg-0': '#101118',
  '--bg-1': '#171922',
  '--thread': '#b968ff',
  '--gold': '#f2b84b',
};

const FIELD_TO_VAR = {
  'pref-bg0': '--bg-0',
  'pref-bg1': '--bg-1',
  'pref-thread': '--thread',
  'pref-gold': '--gold',
};

const root = document.documentElement;
const modal = document.getElementById('preferences-modal');

const CARD_OUTLINE_KEY = 'hcs-card-outline-color';
const CARD_OUTLINE_DEFAULT = '#3a3d4a';

export function getCardOutlineColor() {
  return localStorage.getItem(CARD_OUTLINE_KEY) || CARD_OUTLINE_DEFAULT;
}

function setCardOutlineColor(value) {
  localStorage.setItem(CARD_OUTLINE_KEY, value);
  window.dispatchEvent(new CustomEvent('card-outline-color-changed', { detail: value }));
}

document.getElementById('pref-card-outline').addEventListener('input', (evt) => {
  setCardOutlineColor(evt.target.value);
});

const AUTOSAVE_ENABLED_KEY = 'hcs-autosave-enabled';
const AUTOSAVE_INTERVAL_KEY = 'hcs-autosave-interval-min';
const AUTOSAVE_ENABLED_DEFAULT = true;
const AUTOSAVE_INTERVAL_DEFAULT = 15;

export function getAutosaveEnabled() {
  const stored = localStorage.getItem(AUTOSAVE_ENABLED_KEY);
  return stored === null ? AUTOSAVE_ENABLED_DEFAULT : stored === 'true';
}
export function getAutosaveIntervalMin() {
  return Number(localStorage.getItem(AUTOSAVE_INTERVAL_KEY)) || AUTOSAVE_INTERVAL_DEFAULT;
}

function setAutosaveSettings() {
  const enabled = document.getElementById('pref-autosave-enabled').checked;
  const interval = Number(document.getElementById('pref-autosave-interval').value);
  localStorage.setItem(AUTOSAVE_ENABLED_KEY, String(enabled));
  localStorage.setItem(AUTOSAVE_INTERVAL_KEY, String(interval));
  window.dispatchEvent(new CustomEvent('autosave-settings-changed', { detail: { enabled, interval } }));
}

document.getElementById('pref-autosave-enabled').addEventListener('change', setAutosaveSettings);
document.getElementById('pref-autosave-interval').addEventListener('change', setAutosaveSettings);

function currentValue(varName) {
  const stored = loadStoredTheme();
  return stored[varName] || DEFAULTS[varName];
}

function loadStoredTheme() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

function saveTheme(theme) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(theme));
}

function applyVar(varName, value) {
  root.style.setProperty(varName, value);
}

export function applyStoredTheme() {
  const stored = loadStoredTheme();
  Object.entries(stored).forEach(([varName, value]) => applyVar(varName, value));
}

function populateInputs() {
  Object.entries(FIELD_TO_VAR).forEach(([inputId, varName]) => {
    document.getElementById(inputId).value = currentValue(varName);
  });
  document.getElementById('pref-card-outline').value = getCardOutlineColor();
  document.getElementById('pref-autosave-enabled').checked = getAutosaveEnabled();
  document.getElementById('pref-autosave-interval').value = String(getAutosaveIntervalMin());
}

function wireInputs() {
  Object.entries(FIELD_TO_VAR).forEach(([inputId, varName]) => {
    document.getElementById(inputId).addEventListener('input', (evt) => {
      const value = evt.target.value;
      applyVar(varName, value);
      const theme = loadStoredTheme();
      theme[varName] = value;
      saveTheme(theme);
    });
  });
}

document.getElementById('pref-reset').addEventListener('click', () => {
  Object.keys(DEFAULTS).forEach((varName) => root.style.removeProperty(varName));
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(CARD_OUTLINE_KEY);
  window.dispatchEvent(new CustomEvent('card-outline-color-changed', { detail: CARD_OUTLINE_DEFAULT }));
  populateInputs();
});

document.getElementById('pref-close').addEventListener('click', () => {
  modal.classList.add('hidden');
});

modal.addEventListener('click', (evt) => {
  if (evt.target === modal) modal.classList.add('hidden'); // click outside the box closes it
});

export function openPreferences() {
  populateInputs();
  modal.classList.remove('hidden');
}

wireInputs();
applyStoredTheme();

if (window.hcsAPI && window.hcsAPI.onOpenPreferences) {
  window.hcsAPI.onOpenPreferences(() => openPreferences());
}
