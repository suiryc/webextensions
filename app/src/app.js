'use strict';

const child_process = require('child_process');
const constants = require('./constants');
const fs = require('fs');
const nativeMessaging = require('./native-messaging');
const settings = require('./settings');
const util = require('./util');


var app = new nativeMessaging.NativeApplication(onMessage);

// Handles extension messages.
// 'async' so that we don't block and process the code asynchronously.
async function onMessage(app, msg) {
  try {
    return handleMessage(app, msg);
  } catch (error) {
    console.error('Could not handle message %o: %o', msg, error);
    // Propagate error to client if this was a request.
    if (msg.correlationId !== undefined) return {error: error};
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

    case constants.FEATURE_DOWNLOAD:
      return dl_onMessage(app, msg);
      break;

    case constants.FEATURE_TIDDLYWIKI:
      return tw_onMessage(app, msg);
      break;

    default:
      // Special case: empty message is a PING.
      var props = Object.getOwnPropertyNames(msg);
      if ((props.length == 1) && msg.hasOwnProperty('correlationId')) return {};
      else unhandledMessage(msg);
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
    kind: constants.KIND_SPECS,
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

// Handles DL feature message.
function dl_onMessage(app, msg) {
  switch (msg.kind) {
    case constants.KIND_SAVE:
      return dl_save(app, msg);
      break;

    default:
      unhandledMessage(msg);
      break;
  }
}

function dl_save(app, msg) {
  // Note: even with detached mode, under Windows if we run inside a Job object
  // (e.g. when Firefox launches a native application), spawn children are part
  // of it, and usually when done all the attached processes are terminated.
  // To break out of the Job, the CREATE_BREAKAWAY_FROM_JOB CreateProcess
  // creation flag is needed, which seems possible in python but not nodejs.
  var args = ['--url', msg.url];
  [
    [msg.referrer, '--http-referrer']
    , [msg.file, '--file']
    , [msg.size, '--size']
    , [msg.cookie, '--cookie']
    , [msg.userAgent, '--user-agent']
    , [msg.comment, '--comment']
  ].forEach(opt => {
    if (opt[0] !== undefined) args.push(opt[1], opt[0]);
  });
  if (msg.auto) args.push('--auto');
  child_process.spawn(settings.dlMngrInterpreter, [settings.dlMngrPath, '--background', '--'].concat(args), {
    detached: true,
    stdio: 'ignore'
  }).unref();

  return {
    kind: constants.KIND_RESPONSE
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
