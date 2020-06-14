'use strict';

import { constants } from '../common/constants.js';
import * as util from '../common/util.js';
import { waitForSettings, settings } from '../common/settings.js';
import { WebExtension, NativeApplication } from '../common/messaging.js';
import { RequestsHandler } from './downloads.js';


// Logs unhandled received extension messages.
function unhandledMessage(msg, sender) {
  console.warn('Received unhandled message %o from %o', msg, sender);
}

// Handles received extension messages.
// Note: 'async' so that we don't block and process the code asynchronously.
async function onMessage(extension, msg, sender) {
  try {
    return handleMessage(extension, msg, sender);
  } catch (error) {
    console.error('Could not handle sender %o message %o: %o', sender, msg, error);
    // Propagate error.
    throw error;
  }
}

function handleMessage(extension, msg, sender) {
  switch (msg.feature) {
    case constants.FEATURE_TIDDLYWIKI:
      if (sender.tab === undefined) {
        unhandledMessage(msg, sender);
        return;
      }
      return tw_onMessage(extension, msg, sender);
      break;

    case constants.FEATURE_APP:
      return app_onMessage(extension, msg, sender);
      break;

    default:
      unhandledMessage(msg, sender);
      break;
  }
}

// Handles TW feature message.
function tw_onMessage(extension, msg, sender) {
  switch (msg.kind) {
    case constants.KIND_CHECK_NATIVE_APP:
      return tw_checkNativeApp(msg);
      break;

    case constants.KIND_CHECK_CONCURRENT:
      tw_checkConcurrent(msg);
      break;

    case constants.KIND_SAVE:
      return tw_save(msg);
      break;

    default:
      unhandledMessage(msg, sender);
      break;
  }
}

// Checks whether native application is ok.
function tw_checkNativeApp(msg) {
  return nativeApp.postRequest({});
}

// Checks whether TiddlyWiki file (URL) is open in more than one tab/window.
function tw_checkConcurrent(msg) {
  // Get tabs with the target URL, and trigger warning if there are more than one.
  browser.tabs.query({url: msg.url}).then(tabs => {
    if (tabs.length > 1) {
      for (var tab of tabs) {
        webext.sendTabMessage(tab.id, {
          feature: constants.FEATURE_TIDDLYWIKI,
          kind: constants.KIND_WARN_CONCURRENT
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

// Handles application feature message.
function app_onMessage(extension, msg, sender) {
  switch (msg.kind) {
    case constants.KIND_IGNORE_NEXT:
      return app_ignoreNext(msg);
      break;

    case constants.KIND_CLEAR_MESSAGES:
      return app_clearMessages();
      break;

    case constants.KIND_GET_MESSAGES:
      return app_getMessages(msg);
      break;

    case constants.KIND_ECHO:
      return app_echo(msg, sender);
      break;

    default:
      unhandledMessage(msg, sender);
      break;
  }
}

// Ignore next interception.
function app_ignoreNext(msg) {
  requestsHandler.ignoreNext(msg.ttl);
}

// Clears application messages.
function app_clearMessages() {
  applicationMessages = [];
  browser.browserAction.setBadgeText({text: null});
  browser.browserAction.setBadgeBackgroundColor({color: null});
}

// Gets application messages to display.
function app_getMessages(msg) {
  return applicationMessages;
}

// Replies with original message and sender.
function app_echo(msg, sender) {
  return {
    msg: msg,
    sender: sender
  };
}

// Logs unhandled received native application messages.
function unhandledNativeMessage(app, msg) {
  console.warn('Received unhandled native application %s message %o', app.appId, msg);
}

// Handles received native application messages.
function onNativeMessage(app, msg) {
  switch (msg.feature) {
    case constants.FEATURE_APP:
      return app_onNativeMessage(app, msg);
      break;

    default:
      unhandledNativeMessage(app, msg);
      break;
  }
}

// Handles generic application messages.
function app_onNativeMessage(app, msg) {
  switch (msg.kind) {
    case constants.KIND_CONSOLE:
      return app_console(app, msg);
      break;

    case constants.KIND_NOTIFICATION:
      return app_notification(app, msg);
      break;

    default:
      unhandledNativeMessage(app, msg);
      break;
  }
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

  addApplicationMessage(details);

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

function addApplicationMessage(details) {
  var level = '';
  webext.sendMessage({
    target: constants.TARGET_BROWSER_ACTION,
    feature: constants.FEATURE_APP,
    kind: constants.KIND_ADD_MESSAGE,
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


var webext;
var requestsHandler;
var nativeApp;
var applicationMessages = [];
waitForSettings().then(() => {
  // Extension handler
  webext = new WebExtension({ target: constants.TARGET_BACKGROUND_PAGE, onMessage: onMessage });
  // Native application handler
  nativeApp = new NativeApplication(constants.APPLICATION_ID, { onMessage: onNativeMessage });

  // Start native application and request its specs
  nativeApp.connect();
  console.info('Native application %s starting', nativeApp.appId);
  nativeApp.postRequest({
    feature: constants.FEATURE_APP,
    kind: constants.KIND_SPECS
  }).then(specs => {
    console.log('Native application %s started: %o', nativeApp.appId, specs);
  }).catch(err => {
    console.log('Native application %s failed to start: %o', nativeApp.appId, err);
  });


  // Listen to requests and downloads
  requestsHandler = new RequestsHandler(webext, nativeApp, notification);

  // Add context menu entry to download links (and video/audio elements).
  // Restrict to links that apparently point to sites.
  // See: https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Match_patterns
  browser.contextMenus.create({
    id: 'dl-mngr',
    title: 'dl-mngr',
    icons: { '16': '/resources/icon.svg' },
    contexts: ['link', 'video', 'audio'],
    targetUrlPatterns: ['*://*/*'],
    onclick: requestsHandler.manageClick.bind(requestsHandler)
  });
});