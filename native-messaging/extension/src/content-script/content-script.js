'use strict';

import { constants } from '../common/constants.js';
import { WebExtension } from '../common/messaging.js';
import * as unsafe from '../common/unsafe.js';
import { settings } from '../common/settings.js';
import * as browserActionPopup from './browser-action-popup.js';
import * as linksCatcher from './links-catcher.js';
import * as tw from './tw.js';
import * as video from './video.js';


// Handles received extension messages.
// Notes:
// 'async' so that we don't block and process the code asynchronously.
// Beware that all running scripts (injected by manifest or code) will listen
// to messages if asked: so each listener would log that it does not handle
// messages kind meant for other scripts.
async function onMessage(extension, msg, sender) {
  switch (msg._routing?.kind) {
    case constants.KIND_CS_ALLOW_COPY_PASTE:
      return cs_allowCopyPaste(msg);

    default:
      return unhandledMessage(msg, sender);
  }
}

// Logs unhandled messages received.
function unhandledMessage(msg, sender) {
  console.warn(`Generic content script window=<${windowId}> tab=<${tabId}> frame=<${frameId}> received unhandled message %o from %o`, msg, sender);
  return {
    error: 'Message is not handled by content scripts',
    message: msg
  };
}

function cs_allowCopyPaste(msg) {
  const allowCtrlCV = function(evt) {
    const key = evt.key?.toLowerCase();
    if (evt.ctrlKey && ((key === 'c') || (key === 'v'))) {
      evt.stopImmediatePropagation();
    }
    return true;
  };
  const allow = function(evt) {
    evt.stopImmediatePropagation();
    return true;
  };
  ['copy', 'paste', 'onpaste'].forEach(trigger => {
    document.addEventListener(trigger, allow, true);
  });
  ['keydown'].forEach(trigger => {
    document.addEventListener(trigger, allowCtrlCV, true);
  });
}

// Note: if we don't pre-declare these, eslint will complain. However, we need
// to wait for the 'echo' message response for these to be actually filled.
let windowId, tabId, frameId, notifDefaults;

// Extension handler
// (also save it in globalThis so that scripts can use it directly)
const webext = globalThis.webext = new WebExtension({ target: constants.TARGET_CONTENT_SCRIPT, onMessage });
(async function() {
  // All scripts actually want to wait, at one point or another, for settings
  // to be ready. It is also better to wait for it before using 'webext'.
  await settings.ready;
  // Ping the background script, to get and remember our window/tab/frame ids.
  const echo = await webext.sendMessage({
    _routing: {
      target: constants.TARGET_BACKGROUND_PAGE,
      kind: constants.KIND_ECHO
    }
  });
  // Share the ids in all our code scripts, and in the webext.
  // Note: assigning 'xxx' is needed for this script, and 'globalThis.xxx' for
  // other scripts.
  windowId = globalThis.windowId = echo.sender.tab.windowId;
  tabId = globalThis.tabId = echo.sender.tab.id;
  frameId = globalThis.frameId = echo.sender.frameId;
  notifDefaults = globalThis.notifDefaults = webext.params.targetDetails = {windowId, tabId, frameId};
  try {
    unsafe.executeCode({
      webext,
      name: constants.TARGET_ID_CUSTOM_CONTENT_SCRIPT,
      args: {},
      setting: settings.content_scripts.custom,
      notifDefaults
    });
  } catch (err) {
    console.log('Failure executing custom content script:', err);
  }
  try {
    browserActionPopup.run();
    linksCatcher.run();
    tw.run();
    video.run();
  } catch (err) {
    console.log('Failure starting content scripts:', err);
  }
})();
