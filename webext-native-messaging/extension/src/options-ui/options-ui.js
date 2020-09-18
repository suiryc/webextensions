'use strict';

import { constants } from '../common/constants.js';
import * as util from '../common/util.js';
import { waitForSettings, trackFields } from '../common/settings.js';
import { WebExtension } from '../common/messaging.js';


// Wait for settings to be ready, then track fields changes (to persist settings).
waitForSettings().then(() => trackFields());

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
var webext = new WebExtension({ target: constants.TARGET_OPTIONS_UI, onMessage: onMessage });

var exportButton = document.querySelector('#export');
var importButton = document.querySelector('#import');
var importFile = document.querySelector('#import-file');
var resetButton = document.querySelector('#reset');

function downloadDone(url) {
  // Note: it is apparently not possible to remove the entry generated in the
  // download history; at least under Firefox v80, browser.history.deleteUrl
  // does not work (while it works for 'real' downloads).
  URL.revokeObjectURL(url);
}

function revokeDownloadURL(id, url) {
  browser.downloads.search({id: id}).then(r => {
    var ok = !r;
    if (!ok) {
      var state = r[0].state;
      ok = (state !== browser.downloads.State.IN_PROGRESS);
    }
    if (ok) downloadDone(url);
    else setTimeout(() => revokeDownloadURL(id, url), 1000);
  })
}

// Handle exporting settings.
// Get all settings as object, converted to JSON and saved to file selected
// by user.
exportButton.addEventListener('click', () => {
  // Remove focus from button once clicked.
  exportButton.blur();
  browser.storage.local.get(null).then(options => {
    var json = JSON.stringify(options, undefined, 2);
    var blob = new Blob([json], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    browser.downloads.download({
      url: url,
      filename: 'settings.json',
      saveAs: true
    }).then(id => {
      revokeDownloadURL(id, url);
    }).catch(error => {
      // (Firefox v80) If user cancels saving to file, we get an Error with
      // 'Download canceled by the user' message.
      if (!error || !error.message || !error.message.includes('canceled')) {
        util.extNotification(webext, {
          title: 'Failed to export settings',
          level: 'error',
          error: util.formatObject(error)
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
  var myFile = this.files[0];
  var reader = new FileReader();

  function failed(error) {
    util.extNotification(webext, {
      title: 'Failed to import settings',
      level: 'error',
      error: util.formatObject(error)
    });
  }

  reader.onloadend = function(event) {
    if (event.target.readyState == FileReader.DONE) {
      try {
        var options = JSON.parse(event.target.result);
        browser.storage.local.set(options).catch(failed);
      } catch (error) {
        failed(error);
      }
    } else if (reader.error) {
      failed(reader.error);
    }
  };
  reader.readAsText(myFile)
});

// Handle reseting settings.
resetButton.addEventListener('click', () => {
  resetButton.blur();
  if (!confirm('You are about to clear all current settings!')) return;
  browser.storage.local.clear().catch(error => {
    util.extNotification(webext, {
      title: 'Failed to reset settings',
      level: 'error',
      error: util.formatObject(error)
    });
  });
});
