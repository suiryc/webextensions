'use strict';

import { constants } from '../common/constants.js';
import { WebExtension } from '../common/messaging.js';
import * as unsafe from '../common/unsafe.js';
import { settings } from '../common/settings.js';
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
  switch (msg.kind || '') {
    case constants.KIND_TW_WARN_CONCURRENT:
      return tw.warnConcurrent(msg);
      break;

    default:
      return unhandledMessage(msg, sender);
      break;
  }
}

// Logs unhandled messages received.
function unhandledMessage(msg, sender) {
  console.warn('Received unhandled message %o from %o', msg, sender);
  return {
    error: 'Message is not handled by content scripts',
    message: msg
  };
}


// Extension handler
// (also save it in globalThis so that scripts can use it directly)
let webext = globalThis.webext = new WebExtension({ target: constants.TARGET_CONTENT_SCRIPT, onMessage });
(async function() {
  let echo = webext.sendMessage({
    target: constants.TARGET_BACKGROUND_PAGE,
    kind: constants.KIND_ECHO
  });
  // All scripts actually want to wait, at one point or another, for settings
  // to be ready.
  await settings.ready;
  // Now wait for our echo message response, and remember window/tab/frame ids.
  echo = await echo;
  globalThis.windowId = echo.sender.tab.windowId;
  globalThis.tabId = echo.sender.tab.id;
  globalThis.frameId = echo.sender.frameId;
  globalThis.notifDefaults = {windowId, tabId, frameId};
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
    linksCatcher.run();
    tw.run();
    video.run();
  } catch (err) {
    console.log('Failure starting content scripts:', err);
  }
})();
