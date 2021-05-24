'use strict';

import { constants } from '../common/constants.js';
import { WebExtension } from '../common/messaging.js';
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
var webext = globalThis.webext = new WebExtension({ target: constants.TARGET_CONTENT_SCRIPT, onMessage: onMessage });
try {
  linksCatcher.run();
  tw.run();
  video.run();
} catch (err) {
  console.log('Failure starting content scripts:', err);
}
