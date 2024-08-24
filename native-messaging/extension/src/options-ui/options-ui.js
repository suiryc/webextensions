'use strict';

import { constants } from '../common/constants.js';
import * as util from '../common/util.js';
import { settings, trackFields } from '../common/settings.js';
import { WebExtension } from '../common/messaging.js';


// Wait for settings to be ready, then track fields changes (to persist settings).
settings.ready.then(() => trackFields());

// Handles received extension messages.
// Note: 'async' so that we don't block and process the code asynchronously.
async function onMessage(extension, msg, sender) {
  switch (msg.kind || '') {
    default:
      return unhandledMessage(msg, sender);
      break;
  }
}

// Logs unhandled messages received.
function unhandledMessage(msg, sender) {
  console.warn('Received unhandled message %o from %o', msg, sender);
  return {
    error: 'Message is not handled by options ui',
    message: msg
  };
}

// Extension handler
let webext = new WebExtension({ target: constants.TARGET_OPTIONS_UI, onMessage });

let exportButton = document.querySelector('#export');
let importButton = document.querySelector('#import');
let importFile = document.querySelector('#import-file');
let resetButton = document.querySelector('#reset');

function downloadDone(url, id) {
  // Remove download entry when applicable.
  // (id starts at 1, at least in Firefox)
  let p = id ? browser.downloads.erase({id}) : util.defer;
  p.catch(() => {}).then(() => {
    URL.revokeObjectURL(url);
  });
}

function revokeDownloadURL(url, id) {
  browser.downloads.search({id}).then(r => {
    let ok = !r;
    if (!ok) {
      let state = r[0].state;
      ok = (state !== browser.downloads.State.IN_PROGRESS);
    }
    if (ok) downloadDone(url, id);
    else setTimeout(() => revokeDownloadURL(url, id), 1000);
  })
}

// Handle exporting settings.
// Get all settings as object, converted to JSON and saved to file selected
// by user.
exportButton.addEventListener('click', () => {
  // Remove focus from button once clicked.
  exportButton.blur();
  browser.storage.local.get(null).then(options => {
    // Quick trick to sort object keys.
    options = Object.fromEntries(Object.entries(options).sort());
    let json = JSON.stringify(options, undefined, 2);
    // Add comment lines with all settings, which makes it easier to track
    // changes in multi-line string values.
    // Notes:
    // We don't expect sub-objects.
    // Handle arrays a simple way, even if not used yet.
    // We don't need to be able to parse back, so don't bother with separators.
    function stringify(v, prefix) {
      if ((v === undefined) || (v === null)) {
        v = 'null';
      } else if (Array.isArray(v)) {
        let arr = [];
        for (let v2 of v) {
          arr.push(stringify(v2, '').split('\n').join('\n  '));
        }
        if (!arr.length) {
          v = '[]';
        } else {
          v = `[\n  ${arr.join(`,\n  `)}\n]`;
        }
      } else {
        v = `${v}`.trim();
      }
      v = v.split('\n');
      // Only prepend prefix if value is multi-line.
      if (v.length == 1) return v[0];
      return `${prefix}${v.join(`\n${prefix}`)}`;
    }
    function toComment(obj) {
      let s = [];
      for (let key of Object.keys(obj)) {
        let v = stringify(obj[key], '  ').split('\n');
        if (v.length == 1) {
          s.push(`${key}: ${v[0]}`);
        } else {
          s.push(`${key}:`);
          s = s.concat(stringify(obj[key], '  ').split('\n'));
        }
      }
      return `// ${s.join('\n// ')}\n`;
    }
    let blob = new Blob([toComment(options) + json], { type: 'application/json' });
    let url = URL.createObjectURL(blob);
    browser.downloads.download({
      url,
      filename: 'settings.json',
      saveAs: true
    }).then(id => {
      revokeDownloadURL(url, id);
    }).catch(error => {
      // (Firefox v80) If user cancels saving to file, we get an Error with
      // 'Download canceled by the user' message.
      if (!error || !error.message || !error.message.includes('canceled')) {
        webext.notify({
          title: 'Failed to export settings',
          level: 'error',
          error
        });
      }
      downloadDone(url);
    });
  })
});

// Handle importing settings.
// We trigger the (hidden) file selection input from a standard button.
importButton.addEventListener('click', () => {
  importButton.blur();
  importFile.click();
});

// Once file to import has been selected, handle it.
importFile.addEventListener('change', function() {
  let myFile = this.files[0];
  let reader = new FileReader();

  function failed(error) {
    webext.notify({
      title: 'Failed to import settings',
      level: 'error',
      error
    });
  }

  reader.onloadend = function(event) {
    if (event.target.readyState == FileReader.DONE) {
      try {
        // Remove comment lines we add upon exporting.
        let json = event.target.result.split('\n').filter(s => !s.startsWith('//')).join('\n');
        let options = JSON.parse(json);
        // First get current options, then replace them.
        // Upon issue, revert original settings.
        // Notes:
        // We don't need to check whether an imported value is the default one.
        // If this happens, it will be stored in the local storage, and removed
        // the next time the extension is (re)loaded (as part of 'initValue').
        browser.storage.local.get(null).then(current => {
          return browser.storage.local.clear().then(() => {
            return browser.storage.local.set(options);
          }).catch(error => {
            failed(error);
            return browser.storage.local.set(current);
          });
        }).catch(failed);
      } catch (error) {
        failed(error);
      }
    } else if (reader.error) {
      failed(reader.error);
    }
  };
  reader.readAsText(myFile);
});

// Handle reseting settings.
resetButton.addEventListener('click', () => {
  resetButton.blur();
  if (!confirm('You are about to clear all current settings!')) return;
  browser.storage.local.clear().catch(error => {
    webext.notify({
      title: 'Failed to reset settings',
      level: 'error',
      error
    });
  });
});
