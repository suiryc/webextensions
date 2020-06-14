'use strict';


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
// instance its value is not immediatly known. 'waitForSettings' is used to
// wait for all setting to be initialized (returns a Promise).
// 'trackFields' is an helper to setup UI input fields associated to settings.
//
// Then we create a 'settings' variable to hold all settings instances.
// For easier handling we actually use a 'Proxy' object.
// See: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Proxy
// This way we can directly get/set settings value with e.g. 'settings.debug'
// instead of 'settings.debug.value'/'settings.debug.setValue' (read/write).

export var browserInfo = {};

// Loops over declared settings, passing each one to given callback.
function forSettings(cb) {
  Object.keys(settings.inner.perKey).forEach(key => {
    var setting = settings.inner.perKey[key];
    if (!(setting instanceof ExtensionSetting)) return;
    cb(setting);
  });
}

// Waits for settings to be ready (initialized).
export function waitForSettings() {
  var promises = [];
  forSettings(setting => {
    promises.push(setting.initValue());
  });
  // Knowing the browser is sometimes useful/necessary.
  // browser.runtime.getBrowserInfo exists in Firefox >= 51
  // See: https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/runtime/getBrowserInfo
  if (browser.runtime.getBrowserInfo !== undefined) {
    promises.push(browser.runtime.getBrowserInfo().then(info => {
      // Note: replacing the variable, instead of altering its content, means
      // caller really *must* wait for us to be ready *before* getting this
      // exported variable.
      // Retrieving it *before* we are done gives the empty initial object.
      // If we did replace its content instead, caller would get it empty
      // initially and later see the altered content.
      // Anyway all callers are supposed to 'waitForSettings'.
      browserInfo = {
        raw: info,
        version: parseInt(info.version)
      };
    }));
  }
  return Promise.all(promises);
}

// Tracks all fields.
export function trackFields() {
  forSettings(setting => {
    setting.trackField();
  });
}

class Settings {

  constructor() {
    var handler = {
      get: this.proxy_get.bind(this)
      , set: this.proxy_set.bind(this)
    };
    this.proxy = new Proxy(this, handler);
  }

  proxy_get(target, property) {
    // When accessing the special 'inner' property, point to the original
    // object (the Settings instance). This lets us access the object itself
    // by-passing the Proxy.
    // As such internally we can directly deal with ExtensionSetting instances
    // stored inside Settings, while externally the Proxy does hide those
    // instances to give access to virtual primitive fields.
    if (property === 'inner') return target;
    var field = target[property];
    if (field instanceof ExtensionSetting) return field.value;
    // For functions, bind 'this' to the target.
    if (typeof(field) === 'function') return field.bind(target);
    return field;
  }

  proxy_set(target, property, value) {
    var field = target[property];
    if (field instanceof ExtensionSetting) {
      field.setValue(value);
      return true;
    }
    target[property] = value;
    return true;
  }

}

// Manages a setting.
// Acts as an observable value (listeners can register to be notified when value
// changes). Note we only need to add listeners.
class ExtensionSetting {

  constructor(key, value) {
    this.key = key;
    this.value = value;
    this.listeners = [];

    // Remember the setting by its full key.
    // This makes it easier when we only need to read the setting knowing its
    // key (HTML field value tracking), or to get all known settings (to e.g.
    // loop over them).
    if (settings.inner.perKey === undefined) settings.inner.perKey = {};
    settings.inner.perKey[key] = this;

    // Automatically register ourself as a setting.
    // Handle subfields recursively.
    var target = settings.inner;
    var keys = key.split('.');
    while (keys.length > 0) {
      var leaf = keys.shift();
      if (keys.length > 0) {
        // We will need to access another subfield.
        // Belt and suspenders: ensure we did not accidentally assigned a
        // setting to the subfield itself.
        if (target[leaf] instanceof ExtensionSetting) {
          throw Error(`Setting key=<${key}> cannot bet set: one intermediate element is a setting itself`);
        }
        // Recursively create a Settings Proxy for subfield if needed.
        if (target[leaf] === undefined) target[leaf] = new Settings().proxy;
        target = target[leaf].inner;
      } else {
        // Reached leaf: assign us.
        target[leaf] = this;
      }
    }
  }

  addListener(listener) {
    this.listeners.push(listener);
  }

  // Notifies listeners.
  notifyListeners(oldValue, newValue) {
    var self = this;
    self.listeners.forEach(listener => {
      try {
        listener(self, oldValue, newValue);
      } catch (error) {
        // We don't care if a listener fails
      }
    });
  }

  // Changes the setting value.
  // Also refreshes any associated field and persists value.
  setValue(v, updated) {
    var self = this;
    var oldValue = self.value;
    // Nothing to do if value is not changed.
    if (v === oldValue) return;
    // Update value.
    self.value = v;
    // Update field when applicable.
    if (self.field !== undefined) self.updateField();
    if (!updated) {
      // Persist new value.
      self.persistValue();
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
  }

  // Tracks associated field.
  // Retrieves the field from the document, and refreshes its value.
  trackField() {
    var self = this;
    self.field = document.getElementById(self.key);
    if (self.field === null) self.field = undefined;
    if (self.field === undefined) return false;
    self.updateField();
    return true;
  }

  // Initializes the setting value.
  // To be called first before doing anything with the setting.
  initValue() {
    var self = this;
    var keys = {};
    keys[self.key] = self.value;
    return browser.storage.local.get(keys).then(v => {
      // Special case: callers are expected to wait for settings to be ready
      // before doing anything. And initializing the value is part of this. So
      // we don't 'setValue' since it triggers saving to the storage from which
      // we just retrieved the value.
      self.value = v[self.key];
      return self.value;
    }).catch(() => {
      return self.value;
    });
  }

  // Persists the setting value.
  persistValue() {
    var self = this;
    var keys = {};
    keys[self.key] = self.value;
    return browser.storage.local.set(keys);
  }

}

// Manages a boolean setting.
class ExtensionBooleanSetting extends ExtensionSetting {

  constructor(key, value) {
    super(key, value);
  }

  updateField() {
    this.field.checked = this.value;
  }

  trackField() {
    var self = this;
    if (!super.trackField()) return;
    self.field.addEventListener('click', () => {
      self.setValue(self.field.checked);
    });
  }

}

// Manages a text setting.
// Actual value can be an integer.
class ExtensionTextSetting extends ExtensionSetting {

  constructor(key, value) {
    super(key, value);
  }

  updateField() {
    this.field.value = this.value;
  }

  trackField() {
    var self = this;
    if (!super.trackField()) return;
    self.field.addEventListener('change', () => {
      self.setValue(self.field.value);
    });
  }

}

// The settings.
export var settings = new Settings().proxy;

// Track value changes in storage to update corresponding settings.
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  for (var key of Object.keys(changes)) {
    var setting = settings.inner.perKey[key];
    if (!(setting instanceof ExtensionSetting)) return;
    var {oldValue, newValue} = changes[key];
    setting.setValue(newValue, true);
    setting.notifyListeners(oldValue, newValue);
  }
});

// Create settings (auto-registered).
new ExtensionBooleanSetting('clearDownloads', true);
new ExtensionBooleanSetting('debug', false);
new ExtensionBooleanSetting('interceptDownloads', true);
new ExtensionBooleanSetting('interceptRequests', true);
new ExtensionTextSetting('interceptSize', 10 * 1024 * 1024);
new ExtensionBooleanSetting('notifyIntercept', true);
new ExtensionTextSetting('notifyTtl', 4000);
