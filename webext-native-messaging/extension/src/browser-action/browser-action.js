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
    case constants.KIND_DL_IGNORE_NEXT:
      return dl_ignoreNext(msg);
      break;

    case constants.KIND_EXT_MESSAGE:
      return ext_addMessage(msg);
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
    error: 'Message is not handled by browser action',
    message: msg
  };
}

// Next interception is being ignored.
function dl_ignoreNext(msg) {
  var ttl = msg.ttl / 1000;
  ignoringNext = (ttl > 0);
  // Update displayed button text: append remaining TTL if any.
  if (ignoringNext) ignoreNextButton.textContent = `${ignoreNextText} (${ttl}s)`;
  else ignoreNextButton.textContent = ignoreNextText;
}

// Adds message to display.
function ext_addMessage(msg) {
  addMessage(msg.details);
}

// Extension handler
var webext = new WebExtension({ target: constants.TARGET_BROWSER_ACTION, onMessage: onMessage });

var ignoreNextButton = document.querySelector('#ignoreNext');
var ignoreNextText = ignoreNextButton.textContent;
var ignoringNext = false;
var clearMessagesButton = document.querySelector('#clearMessages');
var messagesNode = document.querySelector('#messages');
var iconExclamationTriangle = document.querySelector('#icon-exclamation-triangle');
var iconInfoCircle = document.querySelector('#icon-info-circle');
var messageNode = document.querySelector('#message');

function cloneNode(node) {
  var cloned = node.cloneNode(true);
  cloned.removeAttribute('id');
  return cloned;
}

function replaceNode(node1, node2) {
  node1.parentNode.replaceChild(node2, node1);
}

function addMessage(details) {
  var level = details.level;
  var node = cloneNode(messageNode);
  var icon;
  var message = util.formatApplicationMessage(details);

  if (level == 'error') {
    icon = cloneNode(iconExclamationTriangle);
    icon.classList.add('error');
  } else if (level == 'warn') {
    icon = cloneNode(iconExclamationTriangle);
    icon.classList.add('warning');
  } else {
    icon = cloneNode(iconInfoCircle);
  }
  replaceNode(node.querySelector('.icon'), icon);
  util.setHtml(node.querySelector('.title'), details.title);
  message = util.textToHtml(message);
  util.setHtml(node.querySelector('.content'), message);

  messagesNode.appendChild(node);
  messagesNode.classList.remove('hidden');
}

// Ignore next interception when requested.
ignoreNextButton.addEventListener('click', () => {
  // Cancel if we are already igoring.
  webext.sendMessage({
    target: constants.TARGET_BACKGROUND_PAGE,
    kind: constants.KIND_DL_IGNORE_NEXT,
    ttl: ignoringNext ? 0 : undefined
  });
});

// Clear messages when requested.
clearMessagesButton.addEventListener('click', () => {
  webext.sendMessage({
    target: constants.TARGET_BACKGROUND_PAGE,
    kind: constants.KIND_CLEAR_MESSAGES
  }).then(() => {
    messagesNode.classList.add('hidden');
  });
});

// Get and add application messages.
webext.sendMessage({
  target: constants.TARGET_BACKGROUND_PAGE,
  kind: constants.KIND_GET_EXT_MESSAGES
}).then(r => {
  if ((r === undefined) || !Array.isArray(r) || !r.length) return;

  for (var details of r) {
    addMessage(details);
  }
});
