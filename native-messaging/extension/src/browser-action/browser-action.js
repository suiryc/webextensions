'use strict';

import { constants } from '../common/constants.js';
import * as util from '../common/util.js';
import * as asynchronous from '../common/asynchronous.js';
import { settings, trackFields } from '../common/settings.js';
import { WebExtension } from '../common/messaging.js';


// Wait for settings to be ready, then track fields changes (to persist settings).
settings.ready.then(() => trackFields());

// Handles received extension messages.
// Note: 'async' so that we don't block and process the code asynchronously.
async function onMessage(extension, msg, sender) {
  switch (msg._routing?.kind) {
    case constants.KIND_DL_IGNORE_NEXT:
      return dl_ignoreNext(msg);

    case constants.KIND_DL_UPDATE_VIDEOS:
      return dl_updateVideos(msg.sources);

    case constants.KIND_EXT_MESSAGE:
      return ext_addMessage(msg);

    case constants.KIND_CLEAR_MESSAGE:
      return ext_clearMessage(msg);

    default:
      return unhandledMessage(msg, sender);
  }
}

// Logs unhandled messages received.
function unhandledMessage(msg, sender) {
  console.warn('Browser action received unhandled message %o from %o', msg, sender);
  return {
    error: 'Message is not handled by browser action',
    message: msg
  };
}

// Next interception is being ignored.
function dl_ignoreNext(msg) {
  const ttl = msg.ttl / 1000;
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
      _routing: {
        target: constants.TARGET_BACKGROUND_PAGE,
        kind: constants.KIND_GET_DL_VIDEOS
      }
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
  for (const source of sources) {
    for (const download of source.downloads) {
      setupDownloadEntry(source, download);
    }
  }
  videosItemNode.setAttribute('data-badge', sources.map(source => source.downloads.length).reduce((sum, v) => sum + v, 0));
  videosItemNode.classList.toggle('badge', true);
  if (showTab) document.querySelector('#tab-item-videos').click();
}

const TEXT_LIMIT_TOOLTIP = 120;
const TEXT_LIMIT_POPUP = 400;

let textForClipboard = undefined;

function setupDownloadEntry(source, download) {
  const node = cloneNode(listItemNode);
  node.classList.add('clickable');

  const audio = download.details.audio;
  const videoSubtitle = download.details.subtitle;
  let subtitle = [];
  const tooltip = [];
  let popupSubtitle = [];
  let entryClipboard = [];

  // Note: a default extension was chosen when applicable.
  const { name, extension } = util.getFilenameExtension(download.details.file);
  util.setHtml(node.querySelector('.list-item-title'), util.textToHtml(name));
  entryClipboard.push(name);
  entryClipboard.push('');

  function popupSubtitle_pushLine(s) {
    if (popupSubtitle.length && (popupSubtitle.at(-1) != '<hr>')) popupSubtitle.push('<br>');
    popupSubtitle.push(s);
    entryClipboard.push(util.htmlToText(s));
  }

  function popupSubtitle_newSection() {
    popupSubtitle.push('<hr>');
    entryClipboard.push('---');
  }

  // Use source size, and extension (unless HLS).
  // Note: for HLS we may have information only in download details, but for
  // direct download, we also have the size in the source.
  let hadSize = false;
  if ('size' in source) {
    // Exact size known.
    hadSize = true;
    const s = util.getSizeText(source.size);
    subtitle.push(s);
    popupSubtitle_pushLine(util.textToHtml(`Size: ${s}`));
  } else if (download.details.size) {
    // Size hint known.
    hadSize = true;
    const s = `${download.details.sizeQualifier || ''}${util.getSizeText(download.details.size)}`;
    subtitle.push(s);
    popupSubtitle_pushLine(util.textToHtml(`Size (hint): ${s}`));
  }
  const hasHLSKey = !!source.hls?.tags?.['EXT-X-KEY'];
  if (source.hls) {
    let s = '🎞️';
    if (hasHLSKey) s += '🔑';
    if (audio) s += '🔊';
    s += source.hls.name;
    subtitle.push(s);
    const tag = source.hls.tag;
    if (source.hls.codecs) popupSubtitle_pushLine(util.textToHtml(`🎞️HLS codecs: ${source.hls.codecs}`));
    if (tag?.attributes['RESOLUTION']) popupSubtitle_pushLine(util.textToHtml(`🎞️HLS resolution: ${tag.attributes['RESOLUTION'].width}x${tag.attributes['RESOLUTION'].height}`));
    if (tag?.attributes['FRAME-RATE']) popupSubtitle_pushLine(util.textToHtml(`🎞️HLS framerate: ${tag.attributes['FRAME-RATE']}`));
    if (source.hls.duration) popupSubtitle_pushLine(util.textToHtml(`🎞️HLS duration: ${util.getTimeText(source.hls.duration)} (${source.hls.duration})`));
    if (!hadSize) {
      // We did not have a size, but maybe there are bandwidth information.
      if (tag?.attributes['AVERAGE-BANDWIDTH']) popupSubtitle_pushLine(util.textToHtml(`🎞️HLS average bandwidth: ≈${util.getSizeText(tag.attributes['AVERAGE-BANDWIDTH'])}bps`));
      if (tag?.attributes['BANDWIDTH']) popupSubtitle_pushLine(util.textToHtml(`🎞️HLS bandwidth: ≤${util.getSizeText(tag.attributes['BANDWIDTH'])}bps`));
    }
    popupSubtitle_pushLine(util.textToHtml(`🎞️HLS name: ${source.hls.name}`));
  } else {
    if (extension) {
      subtitle.push(extension);
      popupSubtitle_pushLine(util.textToHtml(`Extension: ${extension}`));
    }
  }
  if (source.hls) {
    let s = '';
    if (hasHLSKey) s += '🔑';
    if (audio) s += '🔊';
    if (videoSubtitle) s += '💬';
    if (s) popupSubtitle_pushLine(util.textToHtml(`🎞️HLS features: 🎞️${s}`));
  }
  if (videoSubtitle) {
    subtitle.push(`💬${videoSubtitle.lang || videoSubtitle.name}`);
    if (videoSubtitle.lang) popupSubtitle_pushLine(util.textToHtml(`💬Subtitles lang: ${videoSubtitle.lang}`));
    if (videoSubtitle.name) popupSubtitle_pushLine(util.textToHtml(`💬Subtitles name: ${videoSubtitle.name}`));
  }
  const hostname = (new URL(source.url).hostname).split('.').slice(-3).join('.');
  subtitle.push(hostname);
  if (!source.hls) {
    popupSubtitle_newSection();
    if (download.params.mimeFilename) popupSubtitle_pushLine(util.textToHtml(`MIME filename: ${download.params.mimeFilename}`));
    if (download.params.mimeType) popupSubtitle_pushLine(util.textToHtml(`MIME type: ${download.params.mimeType}`));
    popupSubtitle_pushLine(util.textToHtml(`URL filename: ${util.getFilename(download.details.url)}`));
  }
  popupSubtitle_newSection();
  popupSubtitle_pushLine(`URL: <span class='url'>${util.textToHtml(util.limitText(source.url, TEXT_LIMIT_POPUP))}</span>`);
  tooltip.push(util.limitText(source.url, TEXT_LIMIT_TOOLTIP));
  subtitle = subtitle.join(' - ');
  if (source.actualUrl) {
    const actualHostname = (new URL(source.actualUrl).hostname).split('.').slice(-3).join('.');
    if (actualHostname.localeCompare(hostname, undefined, {sensitivity: 'base'})) {
      subtitle = `${subtitle}\nActual host: ${actualHostname}`;
    }
    tooltip.push(util.limitText(source.actualUrl, TEXT_LIMIT_TOOLTIP));
    popupSubtitle_pushLine(`Actual URL: <span class='url'>${util.textToHtml(util.limitText(source.actualUrl, TEXT_LIMIT_POPUP))}</span>`);
  }
  if (source.forceUrl) {
    const actualHostname = (new URL(source.forceUrl).hostname).split('.').slice(-3).join('.');
    if (actualHostname.localeCompare(hostname, undefined, {sensitivity: 'base'})) {
      subtitle = `${subtitle}\nForced host: ${actualHostname}`;
    }
    tooltip.push(util.limitText(source.forceUrl, TEXT_LIMIT_TOOLTIP));
    popupSubtitle_pushLine(`Forced URL: <span class='url'>${util.textToHtml(util.limitText(source.forceUrl, TEXT_LIMIT_POPUP))}</span>`);
  }
  if (audio) {
    tooltip.push(util.limitText(`🔊${audio.url}`, TEXT_LIMIT_TOOLTIP));
    popupSubtitle_pushLine(`🔊Audio URL: <span class='url'>${util.textToHtml(util.limitText(audio.url, TEXT_LIMIT_POPUP))}</span>`);
  }
  if (videoSubtitle) {
    tooltip.push(util.limitText(`💬${videoSubtitle.url}`, TEXT_LIMIT_TOOLTIP));
    popupSubtitle_pushLine(`💬Subtitles URL: <span class='url'>${util.textToHtml(util.limitText(videoSubtitle.url, TEXT_LIMIT_POPUP))}</span>`);
  }

  popupSubtitle = popupSubtitle.join('');
  entryClipboard = entryClipboard.join('\n');
  util.setHtml(node.querySelector('.list-item-subtitle'), util.textToHtml(subtitle));
  // Don't use a CSS tooltip, as it would likely not be displayed correctly
  // (if at all) in the browser action popup view. Instead use some simple
  // 'title' to let the browser display it.
  node.setAttribute('title', tooltip.join('\n'));

  node.addEventListener('click', data => {
    // Triggering video download only requires to know:
    //  - the 'source' (contains unique video id)
    //  - download extra details: all original details are known by target
    //    and don't need to be passed back
    // Auto-download enabled by default, unless using non-main button
    // or 'Ctrl' key.
    const details = {
      auto: (data.button == 0) && !data.ctrlKey
    };
    webext.postMessage({
      _routing: {
        target: constants.TARGET_BACKGROUND_PAGE,
        kind: constants.KIND_DL_VIDEO
      },
      details,
      source: download.source
    });
    // Hide the popup.
    cs_hidePopup();
    // Close the browser action page.
    window.close();
  });

  node.addEventListener('mouseenter', () => {
    textForClipboard = entryClipboard;

    const rect = node.getBoundingClientRect();
    // IMPORTANT: mozInnerScreenX/Y is needeed for proper positioning.
    // See the content script for details.
    const containerTop = window.mozInnerScreenY;
    const itemTop = containerTop + rect.top;
    const pos = {
      containerLeft: window.mozInnerScreenX,
      itemTop,
      itemMiddle: itemTop + (rect.height / 2)
    };

    // Show popup in webpage.
    webext.postMessage({
      _routing: {
        target: constants.TARGET_CONTENT_SCRIPT,
        targetDetails: {
          windowId,
          tabId: activeTabId,
          id: constants.TARGET_ID_CONTENT_SCRIPT_BROWSER_ACTION_POPUP
        },
        kind: constants.KIND_CS_BROWSER_ACTION_POPUP_UPDATE
      },
      action: 'show',
      data: {
        title: util.textToHtml(name),
        subtitle: popupSubtitle
      },
      pos
    });
  });
  node.addEventListener('mouseleave', cs_hidePopup);

  videosNode.appendChild(node);
}

function cs_hidePopup() {
  textForClipboard = undefined;

  // Hide popup in webpage.
  webext.postMessage({
    _routing: {
      target: constants.TARGET_CONTENT_SCRIPT,
      targetDetails: {
        windowId,
        tabId: activeTabId,
        id: constants.TARGET_ID_CONTENT_SCRIPT_BROWSER_ACTION_POPUP
      },
      kind: constants.KIND_CS_BROWSER_ACTION_POPUP_UPDATE
    },
    action: 'hide'
  });
}

// Adds message to display.
function ext_addMessage(msg) {
  addMessage(msg.details);
}

// Removes message from display.
function ext_clearMessage(msg) {
  removeMessage(msg.details);
}

class TabsObserver {

  constructor(webext) {
    this.tabs = {};
    webext.observeTabsEvents(this);
    // Hook us for per-tab extension properties handling.
    webext.extensionProperties.tabsHandler = this;
  }

  tabCreated(details) {
    this.tabs[details.tabId] = details;
  }

  tabFocused(details) {
    refreshMessages(false);
  }

  tabRemoved(details) {
    delete(this.tabs[details.tabId]);
  }

}

let windowId = -1;
let activeTabId = -1;
let refreshing = undefined;

const ignoreNextButton = document.querySelector('#ignoreNext');
const ignoreNextText = ignoreNextButton.textContent;
let ignoringNext = false;
const allowCopyPasteButton = document.querySelector('#allowCopyPaste');
const videosItemNode = document.querySelector('#videos-item');
const videosNode = document.querySelector('#videos');
const clearActiveMessagesButton = document.querySelector('#clearActiveMessages');
const clearOtherMessagesButton = document.querySelector('#clearOtherMessages');
const messagesItemNode = document.querySelector('#messages-item');
const activeMessagesItemNode = document.querySelector('#messages-active-item');
const activeMessagesNode = document.querySelector('#messages-active');
const otherMessagesItemNode = document.querySelector('#messages-other-item');
const otherMessagesNode = document.querySelector('#messages-other');
const optionsItemNode = document.querySelector('#options-item');
const iconExclamationTriangle = document.querySelector('#icon-exclamation-triangle');
const iconInfoCircle = document.querySelector('#icon-info-circle');
const listItemNode = document.querySelector('#list-item');

// Extension handler
const webext = new WebExtension({ target: constants.TARGET_BROWSER_ACTION, onMessage });
const tabsObserver = new TabsObserver(webext);

function cloneNode(node) {
  const cloned = node.cloneNode(true);
  cloned.removeAttribute('id');
  return cloned;
}

function replaceNode(node1, node2) {
  node1.parentNode.replaceChild(node2, node1);
}

function addMessage(details) {
  if (details.windowId && (details.windowId != windowId)) return;
  const tabId = details.tabId;
  const level = details.level;
  const node = cloneNode(listItemNode);
  node.details = details;
  let icon;
  let message = util.formatApplicationMessage(details);

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
  else if (details.source) util.setHtml(node.querySelector('.list-item-title'), details.source);
  message = (details.html ? message : util.textToHtml(message));
  util.setHtml(node.querySelector('.list-item-content'), message);
  const tabHandler = (tabsObserver.tabs[tabId] || {}).tabHandler;
  const tooltip = [];
  if (details.source) tooltip.push(`Source: ${details.source}`);
  if (tabHandler) {
    if (tabHandler.title) tooltip.push(tabHandler.title);
    if (tabHandler.url) tooltip.push(tabHandler.url);
  }
  if (tooltip.length) node.setAttribute('title', tooltip.join('\n'));

  ((tabId == activeTabId) ? activeMessagesNode : otherMessagesNode).appendChild(node);
  updateMessagesBadges();
}

function removeMessage(details) {
  if (!details.uid) return;

  function processNode(node) {
    if (node.details && (node.details.uid === details.uid)) {
      node.remove();
      updateMessagesBadges();
    }
  }
  [activeMessagesNode, otherMessagesNode].forEach(n => {
    n.querySelectorAll(':scope > .list-item').forEach(processNode);
  });
}

async function refreshMessages(showTab) {
  // Ask (async) for messages to display.
  let details = webext.sendMessage({
    _routing: {
      target: constants.TARGET_BACKGROUND_PAGE,
      kind: constants.KIND_GET_EXT_MESSAGES
    }
  });

  // Before continuing, wait for any ongoing refresh.
  // Note: with current code, when showing the action page, we get called twice;
  // from main code, and tab (observer) focusing.
  if (refreshing) await refreshing;
  refreshing = new asynchronous.Deferred();
  try {
    // Remove any displayed message right now.
    [activeMessagesNode, otherMessagesNode].forEach(n => {
      n.querySelectorAll(':scope > .list-item').forEach(node => {
        node.remove();
      });
    });

    // Wait for response, then display retrieved messages.
    details = await(details);
    windowId = details.focusedWindowId;
    activeTabId = details.focusedTabId;
    const messages = details.messages;
    if (messages && Array.isArray(messages) && messages.length) {
      for (const details of messages) {
        addMessage(details);
      }
      if (showTab) document.querySelector('#tab-item-messages').click();
    }
  } finally {
    refreshing.resolve();
  }
}

function updateMessagesBadges() {
  const activeMessagesCount = activeMessagesNode.children.length - 1;
  if (activeMessagesCount > 0) {
    activeMessagesItemNode.setAttribute('data-badge', activeMessagesCount);
  } else {
    activeMessagesItemNode.removeAttribute('data-badge');
  }
  activeMessagesItemNode.classList.toggle('badge', activeMessagesCount > 0);
  activeMessagesNode.classList.toggle('hidden', activeMessagesCount == 0);

  const otherMessagesCount = otherMessagesNode.children.length - 1;
  if (otherMessagesCount > 0) {
    otherMessagesItemNode.setAttribute('data-badge', otherMessagesCount);
  } else {
    otherMessagesItemNode.removeAttribute('data-badge');
  }
  otherMessagesItemNode.classList.toggle('badge', otherMessagesCount > 0);
  otherMessagesNode.classList.toggle('hidden', otherMessagesCount == 0);

  const messagesCount = activeMessagesCount + otherMessagesCount;
  if (messagesCount > 0) {
    let sumupBadge = `${activeMessagesCount}`;
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
  webext.postMessage({
    _routing: {
      target: constants.TARGET_BACKGROUND_PAGE,
      kind: constants.KIND_DL_IGNORE_NEXT
    },
    ttl: ignoringNext ? 0 : constants.IGNORE_NEXT_TTL
  });
});

// Allow copy/paste in page.
allowCopyPasteButton.addEventListener('click', () => {
  webext.postMessage({
    _routing: {
      target: constants.TARGET_CONTENT_SCRIPT,
      targetDetails: {
        windowId,
        tabId: activeTabId
      },
      kind: constants.KIND_CS_ALLOW_COPY_PASTE
    }
  });
});

// Clear messages when requested.
clearActiveMessagesButton.addEventListener('click', () => {
  webext.sendMessage({
    _routing: {
      target: constants.TARGET_BACKGROUND_PAGE,
      kind: constants.KIND_CLEAR_MESSAGES
    },
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
    _routing: {
      target: constants.TARGET_BACKGROUND_PAGE,
      kind: constants.KIND_CLEAR_MESSAGES
    },
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

// Open options page in browser tab when double-clicking 'Options' item.
optionsItemNode.addEventListener('dblclick', () => {
  browser.runtime.openOptionsPage();
});

document.addEventListener('keydown', (ev) => {
  if (ev.ctrlKey && (ev.key == 'c')) {
    if (textForClipboard) navigator.clipboard.writeText(textForClipboard);
  }
});

// Get+add videos and application messages.
// Note: we assume that we can only see the page belonging to the currently
// focused window; and thus we can take into account the focused tab to
// filter messages.
(async () => {
  await refreshMessages(true);
  dl_updateVideos(undefined, true);
})();
