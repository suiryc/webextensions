'use strict';

import { constants } from '../common/constants.js';
import * as util from '../common/util.js';
import { settings } from '../common/settings.js';
import { WebExtension, NativeApplication } from '../common/messaging.js';
import { RequestsInterceptor } from './requests-interceptor.js';
import { dlMngr, RequestsHandler } from './downloads.js';
import { MenuHandler } from './menus.js';
import { VideoSourceHandler } from './video-sources.js';
import { TabSuccessor } from './tab-successor.js';
import { TabsHandler } from './tabs.js';


console.log(`Starting ${constants.EXTENSION_ID} version ${browser.runtime.getManifest().version}`);

// Detect addon installation/updating.
browser.runtime.onInstalled.addListener(function(details) {
  let temporary = details.temporary ? ' (temporarily)' : '';
  let msg = `Installed${temporary} extension`;
  switch (details.reason) {
    case 'install':
      msg += ` ${constants.EXTENSION_ID}`;
      break;
    case 'update':
      msg = `Updated${temporary} extension from version ${details.previousVersion}`
      break;
    case 'shared_module_update':
      msg += ` ${details.id}`;
      break;
    default:
  }
  console.log(`${msg}:`, details);
});

// Notes on content script injection/execution:
// There are 3 ways to inject/execute content script:
// 1. Declaring it in the manifest
// 2. Using browser.contentScripts.register
// 3. Using browser.tabs.executeScript
//
// 1. and 2. are nominal ways of doing it, either through conf or code.
// 3. may give more possibilites, but the extension has to properly manage it
// and especially do it at the right time: basically anytime starting at
// browser.webNavigation.onCommitted
//  - all previous stages precede the frame being reset to load the new content,
//    point at which existing scripts are wiped out
//  - one could listen to browser.webRequest for frames requests, but only the
//    onCompleted stage would work, and happens far later than onCommitted
//
// Usually scripts handled through 1. are executed a bit before 2., which are
// executed a bit before 3. It may also happen that between onCommitted and
// script injection, the frame url becomes 'about:blank' triggering a failed
// Promise unless 'matchAboutBlank' is enabled.
//
// When (re)loading extension, 1. takes care of injecting scripts on existing
// matching frames, while extension has to handle it for 2. and 3.
//
// For CSS injection, we can:
// 1. Declare it in the manifest
// 2. Use browser.tabs.insertCSS
// 3. Add a 'link' stylesheet in the document 'head' node


// Messages handlers

// Handles received extension messages.
// Note: 'async' so that we don't block and process the code asynchronously.
async function onMessage(extension, msg, sender) {
  switch (msg.kind || '') {
    case constants.KIND_CHECK_NATIVE_APP:
      return ext_checkNativeApp(msg);
      break;

    case constants.KIND_TW_CHECK_CONCURRENT:
      return tw_checkConcurrent(msg);
      break;

    case constants.KIND_TW_SAVE:
      // Protection: we really do expect this message to come from a tab.
      if (!sender.tab) return unhandledMessage(msg, sender);
      return tw_save(msg);
      break;

    case constants.KIND_HTTP_FETCH:
      return http_fetch(msg);
      break;

    case constants.KIND_DL_IGNORE_NEXT:
      return dl_ignoreNext(msg);
      break;

    case constants.KIND_DL_VIDEO:
      return dl_downloadVideo(msg);
      break;

    case constants.KIND_DOWNLOAD:
      return dl_download(msg);
      break;

    case constants.KIND_GET_DL_VIDEOS:
      return dl_getVideos(msg);
      break;

    case constants.KIND_CLEAR_MESSAGES:
      return ext_clearMessages(msg);
      break;

    case constants.KIND_GET_EXT_MESSAGES:
      return ext_getMessages(msg);
      break;

    case constants.KIND_ADD_VIDEO_SOURCE:
      // We may receive messages from scripts injected before disabling video
      // interception.
      if (!settings.video.intercept) return;
      return dl_addVideoSource(msg, sender);
      break;

    case constants.KIND_ADD_VIDEO_SUBTITLES:
      if (!settings.video.intercept) return;
      return dl_addVideoSubtitles(msg, sender);
      break;

    case constants.KIND_CONSOLE:
      return ext_console(msg, sender);
      break;

    case constants.KIND_NOTIFICATION:
      return await notification(msg.details || {}, sender);
      break;

    default:
      return unhandledMessage(msg, sender);
      break;
  }
}

// Handles messages received from native application.
async function onNativeMessage(app, msg) {
  switch (msg.kind || '') {
    case constants.KIND_CONSOLE:
      return app_console(app, msg);
      break;

    case constants.KIND_NOTIFICATION:
      return await notification(msg.details || {}, app);
      break;

    default:
      return unhandledNativeMessage(app, msg);
      break;
  }
}


// Extension message handling

// Logs unhandled messages received.
function unhandledMessage(msg, sender) {
  console.warn('Received unhandled message %o from %o', msg, sender);
  return {
    error: 'Message is not handled by background script',
    message: msg
  };
}

// Checks whether native application is ok.
function ext_checkNativeApp(msg) {
  return nativeApp.postRequest({});
}

// Checks whether TiddlyWiki file (URL) is open in more than one tab/window.
function tw_checkConcurrent(msg) {
  // Get tabs with the target URL, and trigger warning if there are more than one.
  browser.tabs.query({url: msg.url}).then(tabs => {
    if (tabs.length > 1) {
      for (let tab of tabs) {
        // We cannot send a message to a discarded tab.
        if (tab.discarded) continue;
        webext.sendTabMessage(tab.id, {
          kind: constants.KIND_TW_WARN_CONCURRENT
        });
      }
    }
  });
}

// Saves TiddlyWiki document.
function tw_save(msg) {
  // Request native application to do the saving, as WebExtensions have no right to properly do it.
  return nativeApp.postRequest(msg, constants.TW_SAVE_TIMEOUT);
}

// Delegate HTTP fetch to native app.
function http_fetch(msg) {
  let timeout = msg?.params?.timeout;
  return nativeApp.postRequest(msg, timeout || constants.HTTP_FETCH_TIMEOUT);
}

// Ignore next download interception.
function dl_ignoreNext(msg) {
  requestsHandler.ignoreNext(msg.ttl);
}

// Triggers download.
function dl_download(msg) {
  return dlMngr.download(msg.details, msg.params);
}

function dl_downloadVideo(msg, sender) {
  return videoSourceHandler.download(msg.source, msg.details);
}

// Gets videos found in currently focused tab.
function dl_getVideos(msg) {
  return videoSourceHandler.getSources();
}

// Clears extension messages.
function ext_clearMessages(msg) {
  let windowId = msg.windowId;
  if (!windowId) {
    applicationMessages = [];
  } else {
    applicationMessages = applicationMessages.filter(details => {
      // Messages sent by non-window code (e.g. background script) have no
      // windowId and are considered as 'Other tabs' (we don't bother setting a
      // dedicated section for such messages): clear them when applicable.
      if ((details.windowId || !msg.otherTabs) && (details.windowId != windowId)) return true;
      let matchTab = details.tabId == msg.tabId;
      return msg.otherTabs ? matchTab : !matchTab;
    });
  }
  updateStatus();
}

// Gets extension messages to display.
function ext_getMessages(msg) {
  let focusedTab = tabsHandler.focusedTab;
  return {
    focusedWindowId: focusedTab.windowId,
    focusedTabId: focusedTab.id,
    messages: applicationMessages
  };
}

function dl_addVideoSource(msg, sender) {
  msg = Object.assign({}, msg);
  delete(msg.correlationId);
  delete(msg.target);
  delete(msg.kind);
  return videoSourceHandler.addSource(Object.assign({
    windowId: sender.tab.windowId,
    tabId: sender.tab.id,
    tabUrl: sender.tab.url,
    frameId: sender.frameId
  }, msg));
}

function dl_addVideoSubtitles(msg, sender) {
  msg = Object.assign({}, msg);
  delete(msg.correlationId);
  delete(msg.target);
  delete(msg.kind);
  return videoSourceHandler.addSubtitles(Object.assign({
    windowId: sender.tab.windowId,
    tabId: sender.tab.id,
    tabUrl: sender.tab.url,
    frameId: sender.frameId
  }, msg));
}


// Native application message handling

// Logs unhandled messages received.
function unhandledNativeMessage(app, msg) {
  console.warn(`Received unhandled native application ${app.appId} message`, msg);
}

// Logs native application log message.
function app_console(app, msg) {
  if (msg.error) {
    // Application actually failed to properly send the log message.
    console.error(`[${app.appId}] Log failure: ${msg.error}`);
    return;
  }

  let level = msg.level || 'info';
  if (!(level in console)) level = 'info';
  let args = ('args' in msg) ? msg.args : [ msg.content ];
  // Prepend the native application id to distinguish its logs from the
  // webextension ones.
  // If first argument is a string, assume it can be a format, and thus prepend
  // to the string itself. Otherwise prepend to the arguments array.
  if (typeof(args[0]) == 'string') args[0] = `[${app.appId}] ${args[0]}`;
  else args.unshift(`[${app.appId}]`);
  console[level].apply(console, args);
}

// Logs webext message.
function ext_console(msg, sender) {
  let level = msg.level || 'log';
  if (!(level in console)) level = 'log';
  let args = ('args' in msg) ? msg.args : [ msg.content ];
  // Prepend the sender to distinguish its logs from the webextension ones.
  // If first argument is a string, assume it can be a format, and thus prepend
  // to the string itself. Otherwise prepend to the arguments array.
  let senderId = msg.sender.kind;
  if (senderId == constants.TARGET_CONTENT_SCRIPT) {
    senderId = `win=${sender.tab.windowId},tab=${sender.tab.id},frame=${sender.frameId}`
  }
  if (typeof(args[0]) == 'string') args[0] = `[${senderId}] ${args[0]}`;
  else args.unshift(`[${senderId}]`);
  console[level].apply(console, args);
}

async function notification(details, sender) {
  if (sender) {
    if (!details.source && sender.appId) {
      details.source = sender.appId;
    }
    if (sender.tab) {
      details.windowId = sender.tab.windowId;
      details.tabId = sender.tab.id;
      details.frameId = sender.frameId;
    }
  }

  // Don't show notification if message is a duplicate or we are in silent mode.
  if (await addExtensionMessage(details) && !details.silent) util.notification(details);
}

async function addExtensionMessage(details) {
  // First check whether we already know this message (not discarded/cleaned yet).
  // Gather important fields first, and build a hash from obtained data.
  let uid = [];
  for (let key of ['windowId', 'tabId', 'level', 'source', 'title']) {
    uid.push(`${details[key]}`);
  }
  uid.push(util.formatApplicationMessage(details));
  uid = uid.join('|');
  // See: https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/digest
  uid = await crypto.subtle.digest('SHA-512', new TextEncoder().encode(uid));
  uid = Array.from(new Uint8Array(uid)).map((b) => b.toString(16).padStart(2, '0')).join('');
  details.uid = uid;
  for (let msg of applicationMessages) {
    if (msg.uid === details.uid) {
      console.log('Discarding duplicate message:', details);
      return false;
    }
  }

  webext.sendMessage({
    target: constants.TARGET_BROWSER_ACTION,
    kind: constants.KIND_EXT_MESSAGE,
    details
  });
  applicationMessages.push(details);
  // Clear message after TTL if applicable.
  if (details.ttl > 0) {
    setTimeout(() => {
      removeExtensionMessage(uid);
    }, details.ttl);
  }

  updateStatus(details.windowId);
  return true;
}

function removeExtensionMessage(uid) {
  webext.sendMessage({
    target: constants.TARGET_BROWSER_ACTION,
    kind: constants.KIND_CLEAR_MESSAGE,
    details: {uid}
  });
  applicationMessages = applicationMessages.filter(details => details.uid !== uid);
  updateStatus();
}

function updateStatus(windowId) {
  // Update the requested window, or update all known windows.
  let obj = {};
  if (windowId) {
    obj[windowId] = videosSources[windowId] || [];
  } else {
    obj = videosSources;
  }
  for (let [windowId, sources] of Object.entries(obj)) {
    // Reminder: object keys are strings, we need windowId as an integer.
    windowId = Number(windowId);
    let hasVideos = sources.map(source => source.downloads.length).reduce((sum, v) => sum + v, 0);
    if (!hasVideos) hasVideos = '';

    // Messages are kept until dismissed, and we set a visual hint.
    // Note: 0 and '' are both considered false.
    let hasMessages = '';
    let badgeBackgroundColor = 'blue';
    let tabHandler = tabsHandler.getActiveTab(windowId);
    let tabId = tabHandler ? tabHandler.id : -1;
    for (let details of applicationMessages) {
      if (details.windowId && (details.windowId != windowId)) continue;
      // Note: don't filter out messages of other tabs; we wish to see the
      // visual hint to know there messages for this window.
      if (details.level == 'error') {
        hasMessages = '!';
        badgeBackgroundColor = 'red';
      } else if (!hasMessages) {
        hasMessages = 'i';
        badgeBackgroundColor = 'yellow';
      }
    }

    if (!hasMessages && !hasVideos) {
      browser.browserAction.setBadgeText({windowId, text: null});
      browser.browserAction.setBadgeBackgroundColor({windowId, color: null});
      continue;
    }

    browser.browserAction.setBadgeText({windowId, text: `${hasVideos}${hasMessages}`});
    browser.browserAction.setBadgeBackgroundColor({windowId, color: badgeBackgroundColor});
  }
}

class TabsObserver {

  constructor(tabsHandler, videoSourceHandler) {
    this.tabsHandler = tabsHandler;
    this.videoSourceHandler = videoSourceHandler;
    videoSourceHandler.observer = this;
    tabsHandler.addObserver(this);
  }

  windowRemoved(windowId) {
    delete(videosSources[windowId]);
    applicationMessages = applicationMessages.filter(msg => msg.windowId !== windowId);
  }

  tabActivated(details) {
    let sources = details.tabHandler ? this.videoSourceHandler.getSources(details.tabHandler) : [];
    this.updateVideos(details.windowId, sources);
  }

  tabRemoved(details) {
    applicationMessages = applicationMessages.filter(msg => msg.tabId !== details.tabId);
  }

  videosUpdated(details) {
    let tabHandler = details.tabHandler;
    if (!tabHandler.isActive()) return;
    let sources = this.videoSourceHandler.getSources(tabHandler, details.sources);
    this.updateVideos(tabHandler.windowId, sources);
  }

  updateVideos(windowId, sources) {
    videosSources[windowId] = sources;
    // Only the focused window browser page could be listening (and thus
    // running): no need to notify it of sources for other windows.
    if (this.tabsHandler.focusedWindowId == windowId) {
      webext.sendMessage({
        target: constants.TARGET_BROWSER_ACTION,
        kind: constants.KIND_DL_UPDATE_VIDEOS,
        sources
      });
    }
    updateStatus(windowId);
  }

}


let applicationMessages = [];
let videosSources = {};

// In order to properly handle/receive messages from other scripts, we need to
// listen right now, and thus need to create our WebExtension instance now.
// Resources needed by WebExtension do wait for settings to be ready if needed,
// or because it is more efficient to do so before actually running.
//
// Features that rely on 'settings.debug' would need to wait for settings, since
// debugging is disabled by default while it is useful to debug early actions.
//
// Most features are enabled by default and rarely disabled. For most of them we
// don't strictly have to ensure settings have been loaded: at worst it will run
// for a short while - and be mostly innocuous by having nothing much to do -
// before settings are finally loaded and feature effectively disabled.
// e.g. RequestsHandler
//
// Some features use 'settings.debug' but are better started right now, because
// they may receive messages from content scripts.
// e.g. VideoSourceHandler

// Some objects are accessed in functions above, and need to be scoped here.
let tabsHandler, webext, nativeApp, requestsHandler, videoSourceHandler;
try {
  // Handle tabs.
  tabsHandler = new TabsHandler();
  // Extension handler
  webext = new WebExtension({
    target: constants.TARGET_BACKGROUND_PAGE,
    onMessage,
    tabsHandler
  });
  // Native application handler
  nativeApp = new NativeApplication(constants.APPLICATION_ID, webext, { onMessage: onNativeMessage });

  // Start native application and request its specs
  nativeApp.connect();
  console.info(`Native application ${nativeApp.appId} starting`);
  nativeApp.postRequest({
    kind: constants.KIND_SPECS
  }).then(specs => {
    console.log(`Native application ${nativeApp.appId} started:`, specs);
  }).catch(err => {
    webext.getNotif().error(`Native application ${nativeApp.appId} failed to start`, err);
  });


  // Listen to requests and downloads.
  new RequestsInterceptor(webext);
  dlMngr.setup(webext, nativeApp);
  requestsHandler = new RequestsHandler(webext);
  // Handle tab successor (tab closing).
  let tabSuccessor = new TabSuccessor(tabsHandler);
  // Handle menus.
  let menuHandler = new MenuHandler(tabSuccessor, requestsHandler);
  // Handle video sources.
  videoSourceHandler = new VideoSourceHandler(webext, tabsHandler, menuHandler);
  new TabsObserver(tabsHandler, videoSourceHandler);
} catch (err) {
  if (webext) webext.getNotif().error(`Failure starting ${constants.EXTENSION_ID}`, err);
  else console.log(`Failure starting ${constants.EXTENSION_ID}:`, constants.EXTENSION_ID, err);
}
