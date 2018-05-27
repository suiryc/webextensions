'use strict';

const constants = require('./constants');
const fs = require('fs');
const nativeMessaging = require('./native-messaging');
const util = require('./util');


var app = new nativeMessaging.NativeApplication(onMessage);

// Handles extension messages.
// 'async' so that we don't block and process the code asynchronously.
async function onMessage(app, msg) {
  try {
    return handleMessage(app, msg);
  } catch (error) {
    console.error('Could not handle message %o: %o', msg, error);
  }
}

function unhandledMessage(msg) {
  console.warn('Received unhandled message feature=<%s> kind=<%s> contentSize=%d',
    msg.feature, msg.kind, msg.content === undefined ? 0 : msg.content.length)
}

function handleMessage(app, msg) {
  switch (msg.feature) {
    case constants.FEATURE_APP:
      return app_onMessage(app, msg);
      break;

    case constants.FEATURE_TIDDLYWIKI:
      return tw_onMessage(app, msg);
      break;

    default:
      unhandledMessage(msg);
      break;
  }
}

// Handles generic application messages
function app_onMessage(app, msg) {
  switch (msg.kind) {
    case constants.KIND_SPECS:
      return app_specs(app, msg);
      break;

    default:
      unhandledMessage(msg);
      break;
  }
}

function app_specs(app, msg) {
  return {
    feature: constants.FEATURE_APP,
    kind: constants.FEATURE_APP,
    //version: config.version,
    env: process.env,
    release: process.release,
    platform: process.platform,
    arch: process.arch,
    versions: process.versions,
    separator: require('path').sep,
    tmpdir: require('os').tmpdir()
  };
}

// Handles TW feature message.
function tw_onMessage(app, msg) {
  switch (msg.kind) {
    case constants.KIND_SAVE:
      return tw_save(app, msg);
      break;

    default:
      unhandledMessage(msg);
      break;
  }
}

function tw_save(app, msg) {
  var deferred = new util.Deferred();

  fs.writeFile(msg.path, msg.content, err => {
    var response = {
      kind: constants.KIND_RESPONSE
    };
    if (err) response.error = err;
    deferred.resolve(response);
  });

  return deferred.promise;
}
