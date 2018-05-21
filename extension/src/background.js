// Handles extension messages.
// 'async' so that we don't block and process the code asynchronously.
async function onMessage(extension, msg, sender) {
  // TODO: debug
  console.debug('Received message', msg, 'from', sender);
  if (sender.tab === undefined) return;
  switch (msg.feature) {
    case FEATURE_TIDDLYWIKI:
      return tw_onMessage(extension, msg, sender);
      break;
  }
}

// Handles TW feature message.
function tw_onMessage(extension, msg, sender) {
  switch (msg.kind) {
    case KIND_CHECK_CONCURRENT:
      tw_checkConcurrent(msg);
      break;

    case KIND_SAVE:
      return tw_save(msg);
      break;
  }
}

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

function tw_save(msg) {
  return nativeApp.postRequest(msg, TW_SAVE_TIMEOUT);
}

function onNativeMessage(app, msg) {
  console.debug('Received native application %s message: %o', app.appId, msg);
}

var extension = new WebExtension(onMessage);
var nativeApp = new NativeApplication('suiryc.webext.native', { onMessage: onNativeMessage });
nativeApp.connect();
console.info('Native application %s started', nativeApp.appId);

// TODO: console.log log messages from native application
// TODO: notification for NOTICE, WARNING, ERROR log messages
