'use strict';

import * as util from './util.js';
import { _fn } from './unsafe.js';


// Settings
// ========
// We need to handle 'settings': important values can be changed by user through
// action/options pages, and are persisted in local storage.
// We also need any change to be propagated ASAP. Thus we listen to changes in
// local storage to update values used in other pages (mainly background).
//
// Individual setting
// ------------------
// First we create an ExtensionSetting class (with subclasses per value type) to
// hold a value and manage it:
//  - when value is updated, it is persisted
//  - when applicable, an UI input field is associated
//   - setting value changes are propagated to the field
//   - field changes are propagated (and thus persisted) to the setting
//  - listeners can be attached and notified when value changes
//
// It has to handle two different sources of changes:
// 1. caller setting value synchronously
// 2. storage notifying of value change (see above)
// Storage changes can come from us (in case 1. we persist the value) or from
// another source.
// In any case, the storage *is* the reference and changes made to it are
// expected to be notified in the same order: the latest one received holds the
// most current value.
//
// A solution would be to:
//  - in case 1. push an UID along the value to store, and remember it
//  - in case 2. ignore the storage changed value if either
//    -> it is a change (UID) we pushed (case 1.); which we then forget
//    -> it is not a change we pushed, but we still have pushed changes not yet
//       notified: only the last stored value matters, and this change is not
//       the last one (we know we pushed at least one value after it)
//  - notify listeners upon value change if either
//    -> we are in case 1.: the change is not notified from the storage
//    -> we are in case 2., it is not a change we pushed and we don't have any
//       pushed change not yet notified (which mean it is the most recent
//       stored value)
// But that would be a bit overkill. A simpler (not perfect) solution is to:
//  - keep any (new) value that is set
//  - wait for storage change to notify listeners
// Notifying listeners upon storage change prevents inefficiencies:
//  1. Caller sets 'v1', notified to listeners and pushed to storage
//  2. Caller sets 'v2', notified to listeners and pushed to storage
//  3. We are notified of 'v1' from storage, and notify listeners (*)
//  4. We are notified of 'v2' from storage, and notify listeners (*)
//  (*) Necessary in the case the change does not come from us.
// The downside of this solution is that if user changes the value more than
// once consecutively, the setting will hold the following values:
//  - 'v1' upon user change 1
//  - 'v2' upon user change 2
//  - ...
//  - 'v1' when storage notifies us from change 1
//  - 'v2' when storage notifies us from change 2
// While not efficient, the final value is the correct one, and we don't expect
// this to happen too often if at all. And if it happens we don't expect the
// many value changes (until last) to have a too negative impact.
//
// Since interacting with storage is asynchronous, when creating a setting
// instance its value is not immediatly known. 'settings.ready' is used to
// wait for all setting to be initialized (returns a Promise).
// 'trackFields' is an helper to setup UI input fields associated to settings.
//
// Then we create a 'settings' variable to hold all settings instances.
// For easier handling we actually use a 'Proxy' object.
// See: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Proxy
// This way we can directly get/set settings value with e.g. 'settings.debug'
// instead of 'settings.debug.value'/'settings.debug.setValue' (read/write).

async function getStorageValue(key, value) {
  if (!key) return await browser.storage.local.get(null);

  let keys = {};
  keys[key] = value;
  try {
    return (await browser.storage.local.get(keys))[key];
  } catch (error) {
    return value;
  }
}

async function setStorageValue(key, value) {
  // Note: even though setting undefined value removes it, explicitely do it.
  if ((value === undefined) || (value === null)) return await removeStorageValue(key);
  let keys = {};
  keys[key] = value;
  return await browser.storage.local.set(keys);
}

async function removeStorageValue(keys) {
  return await browser.storage.local.remove(keys);
}

class SettingsBranch {

  constructor(name, parent) {
    if (name) this._key = (parent && parent._key) ? `${parent._key}.${name}` : name;
    let handler = {
      get: this.proxy_get.bind(this)
      , set: this.proxy_set.bind(this)
    };
    this.proxy = new Proxy(this, handler);
  }

  getKey() {
    return this._key;
  }

  proxy_get(target, property) {
    // When accessing the special 'inner' property, point to the original
    // object. This lets us access the object itself by-passing the Proxy.
    // As such internally we can directly deal with ExtensionSetting instances
    // while externally the Proxy does hide those instances to give access to
    // virtual primitive fields.
    if (property === 'inner') return target;
    let field = target[property];
    if (field instanceof ExtensionSetting) return field.getValue();
    // For functions, bind 'this' to the target.
    if (typeof(field) === 'function') return field.bind(target);
    return field;
  }

  proxy_set(target, property, value) {
    let field = target[property];
    if (field instanceof ExtensionSetting) {
      field.setValue(value);
      return true;
    }
    target[property] = value;
    return true;
  }

}

class Settings extends SettingsBranch {

  constructor() {
    super();
    // The latest settings version.
    // When to bump version (and handle migration):
    //  - renaming existing setting
    //  - splitting existing setting into new mutiple ones
    //  - dropping a setting: to remove it from storage
    // When not to bump version:
    //  - adding a new setting: default value is automatically applied
    //  - changing an existing setting default value: only applies where we did
    //    not change the value; and if changed value matches the new default, it
    //    will be automatically cleared from storage
    this.latestSettingsVersion = 3;
  }

  // Note: registering uses the 'settings' variable, hence the need to do it
  // separately from the constructor.
  registerSettings() {
    let self = this;
    // Create settings (auto-registered).
    new ExtensionIntSetting('settingsVersion', 0);
    new ExtensionBooleanSetting('catchLinks', true);
    new ExtensionBooleanSetting('clearDownloads', true);
    // 'custom' content script.
    new ExtensionBooleanSetting('content_scripts.custom.enabled', true);
    new ExtensionScriptSetting('content_scripts.custom.script');
    new ExtensionBooleanSetting('debug.misc', false);
    new ExtensionBooleanSetting('debug.tabs.events', false);
    new ExtensionBooleanSetting('debug.tabs.successor', false);
    new ExtensionBooleanSetting('debug.linksCatcher', false);
    new ExtensionBooleanSetting('debug.downloads', false);
    new ExtensionBooleanSetting('debug.video', false);
    new ExtensionBooleanSetting('trace.video', false);
    new ExtensionBooleanSetting('handleTabSuccessor', true);
    new ExtensionBooleanSetting('interceptDownloads', true);
    new ExtensionBooleanSetting('interceptRequests', true);
    new ExtensionIntSetting('interceptSize', 20 * 1024 * 1024);
    if (globalThis.browser && browser.webRequest) {
      let requestTypes = new Set(Object.values(browser.webRequest.ResourceType));
      new ExtensionBooleanSetting('intercept.webRequest.onBeforeSendHeaders.enabled', true);
      new ExtensionEnumerationSetting('intercept.webRequest.onBeforeSendHeaders.requestTypes', '', requestTypes, true);
      new ExtensionScriptSetting('intercept.webRequest.onBeforeSendHeaders.script');
    }
    new ExtensionBooleanSetting('notifyDownload', true);
    new ExtensionIntSetting('notifyTtl', 4000);
    new ExtensionBooleanSetting('video.downloadRefining.enabled', true);
    new ExtensionScriptSetting('video.downloadRefining.script');
    new ExtensionBooleanSetting('video.responseRefining.enabled', true);
    new ExtensionScriptSetting('video.responseRefining.script');
    new ExtensionBooleanSetting('video.subtitlesRefining.enabled', true);
    new ExtensionScriptSetting('video.subtitlesRefining.script');
    new ExtensionBooleanSetting('video.filenameRefining.enabled', true);
    new ExtensionScriptSetting('video.filenameRefining.script');
    new ExtensionBooleanSetting('video.intercept', true);
    new ExtensionBooleanSetting('video.hls.intercept', true);
    new ExtensionBooleanSetting('video.subtitles.intercept', true);

    // If there is no 'window', assume we are not running inside browser and
    // don't need to do anything else.
    if (!globalThis.window) return;

    // If extension has a background page, we knows it; otherwise a dummy
    // 'extension://<extension-internal-id>/_generated_background_page.html'
    // is created.
    // We can thus determine whether we are running in the background script.
    let href = window.location.href;
    let backgroundPage = browser.runtime.getManifest().background.page;
    let isBackgroundScript = backgroundPage
      ? (href === browser.runtime.getManifest().background.page)
      : href.endsWith('/_generated_background_page.html')
      ;

    // Start settings loading right away as we expect caller to need them.
    // Caller can wait for settings to be ready (initialized).
    self.ready = (async () => {
      // First migrate settings if necessary.
      // Only one caller (the background script) needs to do it.
      // Other listeners will get notified of storage changes if any.
      if (isBackgroundScript) await self.migrate();

      let promises = [];
      self.forEach(setting => promises.push(setting.initValue(isBackgroundScript)));
      // Knowing the browser is sometimes useful/necessary.
      // browser.runtime.getBrowserInfo exists in Firefox >= 51
      // See: https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/runtime/getBrowserInfo
      if (browser.runtime.getBrowserInfo) {
        promises.push(browser.runtime.getBrowserInfo().then(info => {
          // Note: replacing the variable, instead of altering its content, means
          // caller really *must* wait for us to be ready *before* getting this
          // exported variable.
          // Retrieving it *before* we are done gives the empty initial object.
          // If we did replace its content instead, caller would get it empty
          // initially and later see the altered content.
          // Anyway all callers are supposed to wait 'settings.ready'.
          browserInfo = {
            raw: info,
            version: parseInt(info.version)
          };
        }));
      }
      await Promise.all(promises);
    })();
  }

  // Loops over declared settings, passing each one to given callback.
  forEach(cb) {
    let self = this;
    Object.keys(self.perKey).forEach(key => {
      let setting = self.perKey[key];
      if (!(setting instanceof ExtensionSetting)) return;
      cb(setting);
    });
  }

  async migrate_v3() {
    await this.migrateKeys({
      'interceptVideo': 'video.intercept',
      'scripts.video.downloadRefining': 'video.downloadRefining.script',
      'scripts.video.filenameRefining': 'video.filenameRefining.script'
    });
  }

  async migrate_v2() {
    await this.migrateKeys({
      'notifyIntercept': 'notifyDownload'
    });
  }

  async migrate_v1() {
    await this.migrateKeys({
      'debug': ['debug.misc', 'debug.downloads', 'debug.video']
    });
  }

  // Code to rename/drop settings keys.
  async migrateKeys(keys) {
    for (let key of Object.keys(keys)) {
      let newKey = keys[key];
      try {
        if (!newKey) {
          await removeStorageValue(key);
          console.log(`Deleted oldKey=<${key}>`);
          continue;
        }
        let value = await getStorageValue(key);
        if (value === undefined) {
          console.log(`Not migrating undefined oldKey=<${key}> newKey=<${newKey}>`);
          continue;
        }
        let newKeys = newKey;
        if (!Array.isArray(newKeys)) newKeys = [newKeys];
        let remove = true;
        for (newKey of newKeys) {
          if (newKey == key) {
            // We are actually keeping the old key.
            remove = false;
            continue;
          }
          await setStorageValue(newKey, value);
          console.log(`Migrated oldKey=<${key}> newKey=<${newKey}> value=<%o>`, value);
        }
        if (remove) await removeStorageValue(key);
      } catch (error) {
        console.log(`Failed to migrate oldKey=<${key}> newKey=<${newKey}>:`, error);
      }
    }
  }

  // Code to migrate settings.
  async migrate() {
    // Note: we don't refresh all settings now, because only latest version
    // settings are registered, and migration mainly deals with legacy settings
    // which we have to grab explicitely.
    let setting = this.settingsVersion;
    let settingsVersion = await setting.initValue();

    // Only migrate if necessary.
    if (settingsVersion >= this.latestSettingsVersion) return;

    if (settingsVersion === 0) {
      // We need to distinguish two cases (v0 being the default value when
      // version is not stored):
      //  - we actually come from v0: we wish to migrate
      //  - we just installed the extension: there is nothing to migrate
      // So we check whether settings are present: if there are none then we
      // assume the extension was just installed and we only need to save the
      // current version. At worst no setting was ever changed in which case we
      // use default values anyway.
      if (!Object.keys(await getStorageValue()).length) {
        // Assume extension was just installed.
        console.log(`Initiate settings at version=<${this.latestSettingsVersion}>`);
        await setting.setValue(this.latestSettingsVersion);
        return;
      }
      // else: there were previous settings, we wish to migrate.
    }

    for (let version=settingsVersion+1; version<=this.latestSettingsVersion; version++) {
      console.log(`Migrate settings from version=<${version-1}> to next version`);
      try {
        await this[`migrate_v${version}`]();
      } catch (error) {
        console.log(`Failed to migrate settings to version=<${version}>:`, error);
        break;
      }
      await setting.setValue(version);
    }

    // Note: we migrate before initializing the settings, so we don't need to
    // refresh them; the value we may have stored will be read right after.
    // And then we listen to any changes in storage.
  }

}

// Manages a setting.
// Acts as an observable value (listeners can register to be notified when value
// changes). Note we only need to add listeners.
class ExtensionSetting {

  constructor(key, value, fallback) {
    //this.initialized = false;
    this.key = key;
    if ((value === undefined) || (value === null)) value = fallback;
    this.value = this.defaultValue = value;
    this.listeners = [];

    // Remember the setting by its full key.
    // This makes it easier when we only need to read the setting knowing its
    // key (HTML field value tracking), or to get all known settings (to e.g.
    // loop over them).
    if (!settings.inner.perKey) settings.inner.perKey = {};
    settings.inner.perKey[key] = this;

    // Automatically register ourself as a setting.
    // Handle subfields recursively.
    let target = settings.inner;
    let keys = key.split('.');
    while (keys.length) {
      let leaf = keys.shift();
      if (keys.length) {
        // We will need to access another subfield.
        // Belt and suspenders: ensure we did not accidentally assigned a
        // setting to the subfield itself.
        if (target[leaf] instanceof ExtensionSetting) {
          throw new Error(`Setting key=<${key}> cannot be set: one intermediate element is a setting itself`);
        }
        // Recursively create a Settings Proxy for subfield if needed.
        if (!target[leaf]) target[leaf] = new SettingsBranch(leaf, target).proxy;
        target = target[leaf].inner;
      } else {
        // Reached leaf: assign us.
        target[leaf] = this;
      }
    }
  }

  getKey() {
    return this.key;
  }

  addListener(listener) {
    this.listeners.push(listener);
  }

  // Notifies listeners.
  notifyListeners(oldValue, newValue) {
    let self = this;
    self.listeners.forEach(listener => {
      try {
        listener(self, oldValue, newValue);
      } catch (error) {
        // We don't care if a listener fails
      }
    });
  }

  // Gets current value.
  getValue() {
    // Due to how extensions are managed, background script needs to start right
    // away, and will create a few resources that rely on settings. Some of them
    // also need to start ASAP, and cannot wait for settings to be ready.
    // These resources do take into account this, and properly listen to setting
    // changes to apply actual setting once known.
    // Due to that, it is not easy to properly track callers that do use settings
    // before ready.
    //if (!this.initialized) console.error(`Accessing not-yet initialized setting=<${this.key}>`);
    return this.value;
  }

  // Changes the setting value.
  // Also refreshes any associated field and persists value.
  // Note: 'updated' parameter means caller knows the storage value is already
  // up-to-date (e.g. it reads it) and we only need to take it into account.
  async setValue(v, updated) {
    if (v === undefined) v = this.defaultValue;
    let oldValue = this.value;
    // Nothing to do if value is not changed.
    if (util.deepEqual(v, oldValue)) return;
    // Update value.
    this.value = v;
    // Update field when applicable.
    if (this.field) this.updateField();
    if (!updated) {
      // Persist new value.
      await this.persistValue();
    }
    // else value change comes from the storage, so don't persist it: it is
    // unnecessary (the storage already has this value), and may trigger an
    // endless loop:
    //  1. Caller sets 'v1', pushed to storage
    //  2. Caller sets 'v2', pushed to storage
    //  3. We are notified of 'v1' from storage, and push it back because
    //     the current value is different ('v2')
    //  4. We are notified of 'v2' from storage, and push it back because
    //     the current value is different ('v1')
    //  ... (loop on 3. and 4.)
    if (updated) this.notifyListeners(oldValue, v);
  }

  // Tracks associated field.
  // Retrieves the field from the document, and refreshes its value.
  trackField() {
    let self = this;
    let field = self.field = document.getElementById(self.key);
    if (!field) return false;

    // Setup field:
    // The 'change' event is triggered not too often, such that we wish to save
    // the setting value right now: immediately for checkboxes, radio buttons,
    // and combo boxes, when focused is list for text fields.
    // The 'input' event is triggered on text field after each modification,
    // such that we wish to not save the setting value right now.
    // We take advantage of the fact that the focus is lost whenever another
    // tab, or browser action page, is selected: the setting will then be saved
    // without us having to explicitely take care of it (e.g. by scheduling
    // value change after some time).
    field.addEventListener('change', () => self.validateField(true));
    let fieldType = (field.type || field.tagName).toLowerCase();
    if (fieldType =='checkbox') {
      self.getFieldValue = function() { return this.field.checked; }
    } else if ((fieldType == 'text') || (fieldType == 'textarea')) {
      field.addEventListener('input', () => self.validateField(false));
    }

    // Set field value now.
    self.updateField();
    // Validate it (changing the value on our side does not trigger events).
    self.validateField(false);
    return true;
  }

  getFieldValue() {
    return this.field.value;
  }

  // Validate field value.
  // When requested, setting value is only changed if valid.
  validateField(update) {
    try {
      let v = this.validateValue(this.getFieldValue());
      if (update) this.setValue(v);
      this.field.removeAttribute('title');
      this.field.classList.toggle('field-error', false);
    } catch (error) {
      this.field.setAttribute('title', error.toString());
      this.field.classList.toggle('field-error', true);
    }
  }

  // Validates setting value.
  // Returns validated value, or throws an Error.
  validateValue(v) {
    return v;
  }

  // Initializes the setting value.
  // To be called first before doing anything with the setting.
  async initValue(isBackgroundScript) {
    // Return if already done.
    //if (this.initialized) return this.value;
    // Most callers are expected to wait for settings to be ready before doing
    // anything (and initializing the value is part of this).
    // We must not save to storage (since we retrieved the value from it), but
    // still wish to notify listeners.
    let value = await getStorageValue(this.key);
    if (isBackgroundScript && (value !== undefined) && (util.deepEqual(value, this.defaultValue))) {
      // The storage contains this setting with default value: remove it.
      // (only do it once, from background script)
      console.log(`Removing setting=<${this.key}> from local storage: contains default value`, value);
      await removeStorageValue(this.key);
    }
    //this.initialized = true;
    await this.setValue(value, true);
    return this.value;
  }

  // Persists the setting value.
  persistValue() {
    let value = this.value;
    if (util.deepEqual(value, this.defaultValue)) value = undefined;
    return setStorageValue(this.key, value);
  }

}

// Manages a boolean setting.
class ExtensionBooleanSetting extends ExtensionSetting {

  constructor(key, value) {
    super(key, value, false);
  }

  updateField() {
    this.field.checked = this.getValue();
  }

}

// Manages an int setting.
class ExtensionIntSetting extends ExtensionSetting {

  constructor(key, value) {
    super(key, value, 0);
  }

  updateField() {
    this.field.value = this.getValue();
  }

  validateValue(v) {
    let f = parseFloat(v);
    if (isNaN(v) || !Number.isInteger(f)) throw new Error('Not an integer value');
    return f;
  }

}

// Manages an enumeration setting.
class ExtensionEnumerationSetting extends ExtensionSetting {

  constructor(key, value, allowed, multi) {
    super(key, value, '');
    if (!allowed) throw new Error('Passing allowed values is mandatory for enumeration setting');
    this.allowed = allowed;
    this.multi = multi;
  }

  updateField() {
    if (!this.value) this.field.value = '';
    else this.field.value = this.getValue();
  }

  validateValue(v) {
    let self = this;
    if (self.getValues(v).some(v => !self.allowed.has(v))) throw new Error(`Allowed values: ${[...self.allowed].join(', ')}`);
    return v;
  }

  getValues(v) {
    v = (v || this.getValue() || '').trim();
    // De-duplicate values.
    // Reminder: 'Set' keeps insertion order.
    return v ? [...new Set(this.multi ? v.split(/[ ,\t]+/) : [v])] : [];
  }

}

// Manages a script (string) setting.
class ExtensionScriptSetting extends ExtensionSetting {

  constructor(key, value) {
    super(key, value, '');
  }

  updateField() {
    let value = this.getValue();
    if (!value) this.field.value = '';
    else this.field.value = value;
  }

  validateValue(v) {
    _fn.call(null, v);
    return v;
  }

}

// The settings.
export let settings = new Settings().proxy;
settings.registerSettings();

export let browserInfo = {};

// Tracks all fields.
export function trackFields() {
  settings.forEach(setting => setting.trackField());
}

// Track value changes in storage to update corresponding settings.
// Note: check 'browser' exists (unit tests don't have it).
if (globalThis.browser) browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  for (let key of Object.keys(changes)) {
    let setting = settings.inner.perKey[key];
    if (!(setting instanceof ExtensionSetting)) return;
    setting.setValue(changes[key].newValue, true);
  }
});
