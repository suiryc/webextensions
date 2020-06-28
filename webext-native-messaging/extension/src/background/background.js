'use strict';

import { constants } from '../common/constants.js';
import * as util from '../common/util.js';
import { waitForSettings, settings } from '../common/settings.js';
import { WebExtension, NativeApplication } from '../common/messaging.js';
import { dlMngr, RequestsHandler } from './downloads.js';
import { VideoSourceHandler } from './video-sources.js';
import { MenuHandler } from './menus.js';
import { TabsHandler } from './tabs.js';


// Messages handlers

// Handles received extension messages.
// Note: 'async' so that we don't block and process the code asynchronously.
async function onMessage(extension, msg, sender) {
  switch (msg.kind) {
    case constants.KIND_CHECK_NATIVE_APP:
      return ext_checkNativeApp(msg);
      break;

    case constants.KIND_TW_CHECK_CONCURRENT:
      return tw_checkConcurrent(msg);
      break;

    case constants.KIND_TW_SAVE:
      // Protection: we really do expect this message to come from a tab.
      if (sender.tab === undefined) return unhandledMessage(msg, sender);
      return tw_save(msg);
      break;

    case constants.KIND_DL_IGNORE_NEXT:
      return dl_ignoreNext(msg);
      break;

    case constants.KIND_CLEAR_MESSAGES:
      return ext_clearMessages();
      break;

    case constants.KIND_GET_EXT_MESSAGES:
      return ext_getMessages(msg);
      break;

    case constants.KIND_ADD_VIDEO_SOURCE:
      // We may receive messages from scripts injected before disabling video
      // interception.
      if (!settings.interceptVideo) return;
      return dl_addVideoSource(msg, sender);
      break;

    default:
      return unhandledMessage(msg, sender);
      break;
  }
}

// Handles messages received from native application.
function onNativeMessage(app, msg) {
  switch (msg.kind) {
    case constants.KIND_CONSOLE:
      return app_console(app, msg);
      break;

    case constants.KIND_NOTIFICATION:
      return app_notification(app, msg);
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
      for (var tab of tabs) {
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

// Ignore next download interception.
function dl_ignoreNext(msg) {
  requestsHandler.ignoreNext(msg.ttl);
}

// Clears extension messages.
function ext_clearMessages() {
  applicationMessages = [];
  browser.browserAction.setBadgeText({text: null});
  browser.browserAction.setBadgeBackgroundColor({color: null});
}

// Gets extension messages to display.
function ext_getMessages(msg) {
  return applicationMessages;
}

function dl_addVideoSource(msg, sender) {
  return videoSourceHandler.addSource({
    tabId: sender.tab.id,
    frameId: sender.frameId,
    csUuid: msg.csUuid,
    url: msg.src
  });
}


// Native application message handling

// Logs unhandled messages received.
function unhandledNativeMessage(app, msg) {
  console.warn('Received unhandled native application %s message %o', app.appId, msg);
}

// Logs native application log message.
function app_console(app, msg) {
  if (msg.error !== undefined) {
    // Application actually failed to properly send the log message.
    console.error(`[${app.appId}] Log failure: ${msg.error}`);
    return;
  }

  var level = msg.level || 'info';
  if (!(level in console)) level = 'info';
  var args = ('args' in msg) ? msg.args : [ msg.content ];
  // Prepend the native application id to distinguish its logs from the
  // webextension ones.
  // If first argument is a string, assume it can be a format, and thus prepend
  // to the string itself. Otherwise prepend to the arguments array.
  if (typeof(args[0]) == 'string') args[0] = `[${app.appId}] ${args[0]}`;
  else args.unshift(`[${app.appId}]`);
  console[level].apply(console, args);
}

// Notifies native application message.
function app_notification(app, msg) {
  var details = msg.details || {};
  notification(app.appId, details);
}

function notification(label, details) {
  if (details.level == 'warning') details.level = 'warn';
  var level = details.level || 'info';
  var title = util.htmlToText(details.title);
  var message = util.htmlToText(details.message);
  var error = details.error;

  // Standard notification
  var msg = util.formatApplicationMessage(details);
  util.browserNotification({
    'type': 'basic',
    'title': `[${label}] ${title}`,
    'message': util.htmlToText(msg)
  }, settings.notifyTtl);

  addExtensionMessage(details);

  // Also log details.
  if (!(level in console)) level = 'info';
  msg = `[${label}] ${title}`;
  var args = [];
  if (message !== undefined) {
    msg = `${msg}: %s`;
    args.push(message);
  }
  if (error !== undefined) args.push(error);
  args.unshift(msg);
  console[level].apply(console, args);
}

function addExtensionMessage(details) {
  var level = '';
  webext.sendMessage({
    target: constants.TARGET_BROWSER_ACTION,
    kind: constants.KIND_EXT_MESSAGE,
    details: details
  });
  applicationMessages.push(details);

  // Messages are kept until dismissed, and we set a visual hint.
  for (details of applicationMessages) {
    if (details.level == 'error') {
      level = details.level;
      break;
    }
    if (details.level == 'warn') {
      level = details.level;
      continue;
    }
  }

  browser.browserAction.setBadgeText({text: (level === '') ? 'i' : '!'});
  browser.browserAction.setBadgeBackgroundColor({color: (level === 'error') ? 'red' : 'yellow'});
}


// Handles dynamic content script injection in frames.
// Observes changes to handle 'new' frames:
//  - a (brand new) frame is added
//  - an existing frame is being reused for new content
class ContentScriptHandler {

  // Injects TiddlyWiki content script CSS and code.
  inject_tw(frameHandler) {
    var tabId = frameHandler.tabHandler.id;

    async function inject() {
      var details = {
        file: '/resources/content-script-tw.css',
        runAt: 'document_start'
      };
      await browser.tabs.insertCSS(tabId, details);

      details.file = '/dist/content-script-tw.bundle.js';
      await browser.tabs.executeScript(tabId, details);
    }

    return frameHandler.setupScript('tw', inject);
  }

  // Injects 'video' content script code.
  inject_video(frameHandler) {
    var tabId = frameHandler.tabHandler.id;
    var frameId = frameHandler.id;

    async function inject() {
      // Notes:
      // We only target http/file frames, and only need to inject in frames that
      // are not 'about:blank'.
      var details = {
        frameId: frameId,
        file: '/dist/content-script-video.bundle.js',
        runAt: 'document_start'
      };
      await browser.tabs.executeScript(tabId, details);
    }

    return frameHandler.setupScript('video', inject);
  }

  async handleFrame(frameHandler) {
    var tabHandler = frameHandler.tabHandler;
    // We can check which content script(s) to inject now.
    // When dealing with a pdf file, Firefox has its own PDF.js handling and
    // we cannot execute script in the (special and privileged) frame.
    // See: https://bugzilla.mozilla.org/show_bug.cgi?id=1454760
    // Example: https://developer.mozilla.org/en-US/docs/Web/HTML/Element/object
    // Assume urls ending with '.pdf' are PDF displayed in frames, and exclude
    // them.
    if (frameHandler.url.match(/\.pdf$/i)) {
      if (settings.debug.misc) console.log('Not handling tab=<%s> frame=<%s> url=<%s>: appears to be a PDF', tabHandler.id, frameHandler.id, frameHandler.url);
      return;
    }

    if (frameHandler.id === 0) {
      // Inject TiddlyWiki content script where applicable.
      // We only handle (and expect) main frame for this.
      if (tabHandler.url.match(/^file:.*html?$/i)) {
        this.inject_tw(frameHandler);
      }
    }

    if (settings.interceptVideo && tabHandler.url.startsWith('http')) {
      this.inject_video(frameHandler);
    }
  }

  // Tab/frame observer

  frameAdded(details) {
    this.handleFrame(details.frameHandler);
  }

  frameReset(details) {
    var frameHandler = details.frameHandler;
    // We want the DOM content to be loaded.
    // If frameHandler is not (yet) known, we expect a 'frameAdded' to be
    // triggered soon.
    if (!details.domLoaded || (frameHandler === undefined)) return;
    this.handleFrame(frameHandler);
  }

}


var webext;
var requestsHandler;
var videoSourceHandler;
var nativeApp;
var applicationMessages = [];
waitForSettings(true).then(() => {
  // Extension handler
  webext = new WebExtension({ target: constants.TARGET_BACKGROUND_PAGE, onMessage: onMessage });
  // Native application handler
  nativeApp = new NativeApplication(constants.APPLICATION_ID, { onMessage: onNativeMessage });

  // Start native application and request its specs
  nativeApp.connect();
  console.info('Native application %s starting', nativeApp.appId);
  nativeApp.postRequest({
    kind: constants.KIND_SPECS
  }).then(specs => {
    console.log('Native application %s started: %o', nativeApp.appId, specs);
  }).catch(err => {
    console.log('Native application %s failed to start: %o', nativeApp.appId, err);
  });


  // Listen to requests and downloads.
  dlMngr.setup(nativeApp, notification);
  requestsHandler = new RequestsHandler(webext);
  // Handle menus.
  var menuHandler = new MenuHandler(requestsHandler);
  // Handle tabs.
  var tabsHandler = new TabsHandler();
  // Handle content script injection.
  tabsHandler.addObserver(new ContentScriptHandler());
  // Handle video sources.
  videoSourceHandler = new VideoSourceHandler(tabsHandler, menuHandler);
  tabsHandler.addObserver(videoSourceHandler);
});
