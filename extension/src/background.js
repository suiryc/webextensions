'use strict';


// Logs unhandled received extension messages.
function unhandledMessage(msg, sender) {
  console.warn('Received unhandled message %o from %o', msg, sender);
}

// Handles received extension messages.
// Note: 'async' so that we don't block and process the code asynchronously.
async function onMessage(extension, msg, sender) {
  if (sender.tab === undefined) return;
  switch (msg.feature) {
    case FEATURE_TIDDLYWIKI:
      return tw_onMessage(extension, msg, sender);
      break;

    default:
      unhandledMessage(msg, sender);
      break;
  }
}

// Handles TW feature message.
function tw_onMessage(extension, msg, sender) {
  switch (msg.kind) {
    case KIND_CHECK_NATIVE_APP:
      return tw_checkNativeApp(msg);
      break;

    case KIND_CHECK_CONCURRENT:
      tw_checkConcurrent(msg);
      break;

    case KIND_SAVE:
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
        extension.sendTabMessage(tab.id, {
          feature: FEATURE_TIDDLYWIKI,
          kind: KIND_WARN_CONCURRENT
        });
      }
    }
  });
}

// Saves TiddlyWiki document.
function tw_save(msg) {
  // Request native application to do the saving, as WebExtensions have no right to properly do it.
  return nativeApp.postRequest(msg, TW_SAVE_TIMEOUT);
}

// Logs unhandled received native application messages.
function unhandledNativeMessage(app, msg) {
  console.warn('Received unhandled native application %s message %o', app.appId, msg);
}

// Handles received native application messages.
function onNativeMessage(app, msg) {
  switch (msg.feature) {
    case FEATURE_APP:
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
    case KIND_CONSOLE:
      return app_console(app, msg);
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
  // to the string itself. Otherwise preprend to the arguments array.
  if (typeof(args[0]) == 'string') args[0] = `[${app.appId}] ${args[0]}`;
  else args.unshift(`[${app.appId}]`);
  console[level].apply(console, args);
}


// Extension handler
var extension = new WebExtension(onMessage);
// Native application handler
var nativeApp = new NativeApplication(APPLICATION_ID, { onMessage: onNativeMessage });

// Start native application and request its specs
nativeApp.connect();
console.info('Native application %s starting', nativeApp.appId);
nativeApp.postRequest({
  feature: FEATURE_APP,
  kind: KIND_SPECS
}).then(specs => {
  console.log('Native application %s started: %o', nativeApp.appId, specs);
}).catch(err => {
  console.log('Native application %s failed to start: %o', nativeApp.appId, err);
});
