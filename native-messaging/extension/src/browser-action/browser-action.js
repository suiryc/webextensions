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
  ignoringNext = !!ttl;
  // Update displayed button text: append remaining TTL if any.
  if (ignoringNext) ignoreNextButton.textContent = `${ignoreNextText} (${ttl}s)`;
  else ignoreNextButton.textContent = ignoreNextText;
}

async function dl_updateVideos(sources, showTab) {
  // Get sources if not given.
  if (!sources) {
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
  if (!sources || !Array.isArray(sources) || !sources.length) {
    videosItemNode.classList.toggle('badge', false);
    videosItemNode.removeAttribute('data-badge');
    return;
  }
  sources.forEach(source => {
    var node = cloneNode(listItemNode);
    node.classList.add('clickable');
    // Note: a default extension was chosen when applicable.
    var { name, extension } = util.getFilenameExtension(source.download.details.file);
    util.setHtml(node.querySelector('.list-item-title'), util.textToHtml(name));
    var subtitle = [];
    var tooltip = [];
    if ('size' in source) subtitle.push(util.getSizeText(source.size));
    if (extension) subtitle.push(extension);
    var hostname = (new URL(source.url).hostname).split('.').slice(-3).join('.');
    subtitle.push(hostname);
    tooltip.push(util.limitText(source.url, 120));
    subtitle = subtitle.join(' - ');
    if (source.actualUrl) {
      var actualHostname = (new URL(source.actualUrl).hostname).split('.').slice(-3).join('.');
      if (actualHostname.localeCompare(hostname, undefined, {sensitivity: 'base'})) {
        subtitle = `${subtitle}\nActual host: ${actualHostname}`;
      }
      tooltip.push(util.limitText(source.actualUrl, 120));
    }
    if (source.forceUrl) {
      var actualHostname = (new URL(source.forceUrl).hostname).split('.').slice(-3).join('.');
      if (actualHostname.localeCompare(hostname, undefined, {sensitivity: 'base'})) {
        subtitle = `${subtitle}\nForced host: ${actualHostname}`;
      }
      tooltip.push(util.limitText(source.forceUrl, 120));
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
        details,
        params: source.download.params
      });
      // Close the browser action page.
      window.close();
    });
    videosNode.appendChild(node);
  });
  videosItemNode.setAttribute('data-badge', sources.length);
  videosItemNode.classList.toggle('badge', true);
  if (showTab) document.querySelector('#tab-item-videos').click();
}

// Adds message to display.
function ext_addMessage(msg) {
  addMessage(msg.details);
}

class TabsObserver {

  constructor(webext) {
    this.tabs = {};
    webext.observeTabsEvents(this);
  }

  tabAdded(details) {
    this.tabs[details.tabId] = details;
  }

  tabFocused(details) {
    activeTabId = details.tabId;
    refreshMessages();
  }

  tabRemoved(details) {
    delete(this.tabs[details.tabId]);
  }

}

// Extension handler
var webext = new WebExtension({ target: constants.TARGET_BROWSER_ACTION, onMessage });
var tabsObserver = new TabsObserver(webext);

var windowId = -1;
var activeTabId = -1;
var messages = [];

var ignoreNextButton = document.querySelector('#ignoreNext');
var ignoreNextText = ignoreNextButton.textContent;
var ignoringNext = false;
var videosItemNode = document.querySelector('#videos-item');
var videosNode = document.querySelector('#videos');
var clearActiveMessagesButton = document.querySelector('#clearActiveMessages');
var clearOtherMessagesButton = document.querySelector('#clearOtherMessages');
var messagesItemNode = document.querySelector('#messages-item');
var activeMessagesItemNode = document.querySelector('#messages-active-item');
var activeMessagesNode = document.querySelector('#messages-active');
var otherMessagesItemNode = document.querySelector('#messages-other-item');
var otherMessagesNode = document.querySelector('#messages-other');
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
  if (details.windowId && (details.windowId != windowId)) return;
  messages.push(details);
  var tabId = details.tabId;
  var level = details.level;
  var node = cloneNode(listItemNode);
  var icon;
  var message = util.formatApplicationMessage(details);

  if (level == 'error') {
    icon = cloneNode(iconExclamationTriangle);
    icon.classList.add('icon-error');
  } else if (level == 'warn') {
    icon = cloneNode(iconExclamationTriangle);
    icon.classList.add('icon-warning');
  } else {
    icon = cloneNode(iconInfoCircle);
  }
  replaceNode(node.querySelector('.icon'), icon);
  if (details.title) util.setHtml(node.querySelector('.list-item-title'), details.title);
  message = (details.html ? message : util.textToHtml(message));
  util.setHtml(node.querySelector('.list-item-content'), message);
  var tabHandler = (tabsObserver.tabs[tabId] || {}).tabHandler;
  var tooltip = [];
  if (details.source) tooltip.push(`Source: ${details.source}`);
  if (tabHandler) {
    if (tabHandler.title) tooltip.push(tabHandler.title);
    if (tabHandler.url) tooltip.push(tabHandler.url);
  }
  if (tooltip.length) node.setAttribute('title', tooltip.join('\n'));

  ((tabId == activeTabId) ? activeMessagesNode : otherMessagesNode).appendChild(node);
  updateMessagesBadges();
}

function refreshMessages() {
  var todo = messages;
  messages = [];
  [activeMessagesNode, otherMessagesNode].forEach(n => {
    n.querySelectorAll(':scope > .list-item').forEach(node => {
      node.remove();
    });
  });
  for (var details of todo) {
    addMessage(details);
  }
}

function updateMessagesBadges() {
  var activeMessagesCount = activeMessagesNode.children.length - 1;
  if (activeMessagesCount > 0) {
    activeMessagesItemNode.setAttribute('data-badge', activeMessagesCount);
  } else {
    activeMessagesItemNode.removeAttribute('data-badge');
  }
  activeMessagesItemNode.classList.toggle('badge', activeMessagesCount > 0);
  activeMessagesNode.classList.toggle('hidden', activeMessagesCount == 0);

  var otherMessagesCount = otherMessagesNode.children.length - 1;
  if (otherMessagesCount > 0) {
    otherMessagesItemNode.setAttribute('data-badge', otherMessagesCount);
  } else {
    otherMessagesItemNode.removeAttribute('data-badge');
  }
  otherMessagesItemNode.classList.toggle('badge', otherMessagesCount > 0);
  otherMessagesNode.classList.toggle('hidden', otherMessagesCount == 0);

  var messagesCount = activeMessagesCount + otherMessagesCount;
  if (messagesCount > 0) {
    var sumupBadge = `${activeMessagesCount}`;
    if (otherMessagesCount) sumupBadge = `${sumupBadge}+${otherMessagesCount}`
    messagesItemNode.setAttribute('data-badge', sumupBadge);
  } else {
    messagesItemNode.removeAttribute('data-badge');
  }
  messagesItemNode.classList.toggle('badge', messagesCount > 0);
}

// Ignore next interception when requested.
ignoreNextButton.addEventListener('click', () => {
  // Cancel if we are already igoring.
  webext.sendMessage({
    target: constants.TARGET_BACKGROUND_PAGE,
    kind: constants.KIND_DL_IGNORE_NEXT,
    ttl: ignoringNext ? 0 : constants.IGNORE_NEXT_TTL
  });
});

// Clear messages when requested.
clearActiveMessagesButton.addEventListener('click', () => {
  webext.sendMessage({
    target: constants.TARGET_BACKGROUND_PAGE,
    kind: constants.KIND_CLEAR_MESSAGES,
    windowId,
    tabId: activeTabId,
    otherTabs: false
  }).then(() => {
    activeMessagesNode.querySelectorAll(':scope > .list-item').forEach(node => {
      node.remove();
    });
    updateMessagesBadges();
  });
});
clearOtherMessagesButton.addEventListener('click', () => {
  webext.sendMessage({
    target: constants.TARGET_BACKGROUND_PAGE,
    kind: constants.KIND_CLEAR_MESSAGES,
    windowId,
    tabId: activeTabId,
    otherTabs: true
  }).then(() => {
    otherMessagesNode.querySelectorAll(':scope > .list-item').forEach(node => {
      node.remove();
    });
    updateMessagesBadges();
  });
});

// Get+add videos and application messages.
// Note: we assume that we can only see the page belonging to the currently
// focused window; and thus we can take into account the focused tab to
// filter messages.
(async () => {
  var details = await webext.sendMessage({
    target: constants.TARGET_BACKGROUND_PAGE,
    kind: constants.KIND_GET_EXT_MESSAGES
  });
  windowId = details.focusedWindowId;
  activeTabId = details.focusedTabId;
  var msgs = details.messages;
  if (msgs && Array.isArray(msgs) && msgs.length) {
    messages = msgs;
    refreshMessages();
    document.querySelector('#tab-item-messages').click();
  }

  dl_updateVideos(undefined, true);
})();
