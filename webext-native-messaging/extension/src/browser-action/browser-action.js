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

    case constants.KIND_DL_UPDATE_VIDEOS:
      return dl_updateVideos(msg.sources);
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

async function dl_updateVideos(sources, showTab) {
  // Get sources if not given.
  if (sources === undefined) {
    // Note: we don't need to bother about the window we belong to, since we
    // only run when popup is displayed which means our window is the focused
    // window, and requested sources are those of the focused window.
    sources = await webext.sendMessage({
      target: constants.TARGET_BACKGROUND_PAGE,
      kind: constants.KIND_GET_DL_VIDEOS
    });
  }
  videosNode.querySelectorAll(':scope > .list-item').forEach(node => {
    node.remove();
  });
  if ((sources === undefined) || !Array.isArray(sources) || !sources.length) {
    videosItemNode.classList.toggle('badge', false);
    videosItemNode.removeAttribute('data-badge');
    return;
  }
  sources.forEach(source => {
    var node = cloneNode(listItemNode);
    node.classList.add('clickable');
    var { name, extension } = util.getFilenameExtension(source.download.details.file);
    util.setHtml(node.querySelector('.list-item-title'), util.textToHtml(name));
    var subtitle = [];
    var tooltip = [];
    if (source.size !== undefined) subtitle.push(util.getSizeText(source.size));
    if (extension !== undefined) subtitle.push(extension);
    var hostname = (new URL(source.url).hostname).split('.').slice(-3).join('.');
    subtitle.push(hostname);
    tooltip.push(util.limitText(source.url, 120));
    subtitle = subtitle.join(' - ');
    if (source.actualUrl !== undefined) {
      var actualHostname = (new URL(source.actualUrl).hostname).split('.').slice(-3).join('.');
      if (actualHostname.localeCompare(hostname, undefined, {sensitivity: 'base'})) {
        subtitle = `${subtitle}\nActual host: ${actualHostname}`;
      }
      tooltip.push(util.limitText(source.actualUrl, 120));
    }
    util.setHtml(node.querySelector('.list-item-subtitle'), util.textToHtml(subtitle));
    // Don't use a CSS tooltip, as it would likely not be displayed correctly
    // (if at all) in the browser action popup view. Instead use some simple
    // 'title' to let the browser display it.
    node.setAttribute('title', tooltip.join('\n'));
    node.addEventListener('click', data => {
      var details = source.download.details;
      // Auto-download enabled by default, unless using non-main button
      // or 'Ctrl' key.
      details.auto = (data.button == 0) && !data.ctrlKey;
      webext.sendMessage({
        target: constants.TARGET_BACKGROUND_PAGE,
        kind: constants.KIND_DOWNLOAD,
        details: details,
        params: source.download.params
      });
      window.close();
    });
    videosNode.appendChild(node);
  });
  videosItemNode.setAttribute('data-badge', sources.length);
  videosItemNode.classList.toggle('badge', true);
  if (showTab) document.querySelector('#tab-videos-item').click();
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
var videosItemNode = document.querySelector('#videos-item');
var videosNode = document.querySelector('#videos');
var clearMessagesButton = document.querySelector('#clearMessages');
var messagesItemNode = document.querySelector('#messages-item');
var messagesNode = document.querySelector('#messages');
var iconExclamationTriangle = document.querySelector('#icon-exclamation-triangle');
var iconInfoCircle = document.querySelector('#icon-info-circle');
var listItemNode = document.querySelector('#list-item');

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
  var node = cloneNode(listItemNode);
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
  util.setHtml(node.querySelector('.list-item-title'), details.title);
  message = util.textToHtml(message);
  util.setHtml(node.querySelector('.list-item-content'), message);

  messagesNode.appendChild(node);
  messagesNode.classList.remove('hidden');
  messagesItemNode.setAttribute('data-badge', messagesNode.children.length - 1);
  messagesItemNode.classList.toggle('badge', true);
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
    messagesNode.querySelectorAll(':scope > .list-item').forEach(node => {
      node.remove();
    });
    messagesItemNode.classList.toggle('badge', false);
    messagesItemNode.removeAttribute('data-badge');
  });
});

// Get+add videos and application messages.
(async () => {
  var r = await webext.sendMessage({
    target: constants.TARGET_BACKGROUND_PAGE,
    kind: constants.KIND_GET_EXT_MESSAGES
  });
  if ((r !== undefined) && Array.isArray(r) && r.length) {
    for (var details of r) {
      addMessage(details);
    }
    document.querySelector('#tab-messages-item').click();
  }

  dl_updateVideos(undefined, true);
})();
