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
  switch (msg.kind) {
    case constants.KIND_DOWNLOAD:
      return dl_save(app, msg);
      break;

    case constants.KIND_TW_SAVE:
      return tw_save(app, msg);
      break;

    case constants.KIND_SPECS:
      return app_specs(app, msg);
      break;

    default:
      // Special case: empty message is a PING.
      var props = Object.getOwnPropertyNames(msg);
      if ((props.length == 1) && msg.hasOwnProperty('correlationId')) return {};
      else return unhandledMessage(msg);
      break;
  }
}

// Logs unhandled messages received.
function unhandledMessage(msg) {
  console.warn('Received unhandled message feature=<%s> kind=<%s> contentSize=%d',
    msg.feature, msg.kind, (msg.content || '').length)
  return {
    error: 'Message is not handled by native application',
    message: msg
  };
}

function app_specs(app, msg) {
  return {
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

function dl_save(app, msg) {
  // Note: even with detached mode, under Windows if we run inside a Job object
  // (e.g. when Firefox launches a native application), spawn children are part
  // of it, and usually when done all the attached processes are terminated.
  // To break out of the Job, the CREATE_BREAKAWAY_FROM_JOB CreateProcess
  // creation flag is needed, which seems possible in python but not nodejs.
  var deferred = new util.Deferred();
  // We always ask for the WebSocket port, so that next requests can be posted
  // directly from the browser.
  var args = ['--ws'];
  [
    [msg.url, '--url']
    , [msg.referrer, '--http-referrer']
    , [msg.file, '--file']
    , [msg.size, '--size']
    , [msg.cookie, '--cookie']
    , [msg.userAgent, '--user-agent']
    , [msg.comment, '--comment']
  ].forEach(opt => {
    // Only keep defined (and non-null) values.
    if (opt[0] == null) opt[0] = undefined;
    if (opt[0] !== undefined) args.push(opt[1], opt[0]);
  });
  if (msg.auto) args.push('--auto');
  var child = child_process.spawn(settings.dlMngrInterpreter, [settings.dlMngrPath, '--'].concat(args), {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  // We need to:
  //  - accumulate stdout/stderr data until done
  //  - determine whether action succeeded or failed; which means getting return
  //    code when possible
  //  - not block indefinitely if actual application remains running: the first
  //    instance will keep on running - in the background
  // The actual application do close its output streams when done (even if it
  // keeps on running). We could wait for stdout and stderr to be closed, but:
  //  - it happens before the application exits (when it does not keep on
  //    running): to determine a possible exit code, we would need to wait a bit
  //    in case we get one in a reasonable (short) amount of time
  //  - we actually spawn a - python - script that does this for us
  // Note: in some cases (e.g. when spawning a Python 2 script, at least on
  // Windows) EOF is not properly received when stream is closed or even process
  // exits. This happens e.g. when nodejs spawns a python script which spawns a
  // JVM: even though the python script properly received EOF after the JVM
  // closes its streams, and exits, nodejs does not trigger any end/close event.
  // As a workaround, we could send a nul byte.
  // There is no such issue with Python 3 though.
  //
  // So we 'simply' wait for the process to exit or fail.
  var stdout = {
    data: Buffer.allocUnsafe(0)
  };
  var stderr = {
    data: Buffer.allocUnsafe(0)
  };

  // Concats data buffer for given stream.
  function streamConcat(s, data) {
    s.data = Buffer.concat([s.data, data]);
  }

  // Return response.
  // Note: we must properly handle being called more than once because 'error'
  // and 'exit' events may be triggered both; only the first call matters then.
  var done = false;
  function onDone(details) {
    if (done) return;
    done = true;
    // Upon 'exit', code or signal will be null; normalize for easier handling.
    if (!details.code) details.code = 0;
    if (!details.signal) delete details.signal;
    var response = { };
    // We consider the action failed if either:
    //  - the application wrote on stderr: (belt and suspenders) we actually
    //    only expect this to happen with a non-0 return code
    //  - return code is non-0
    //  - application was interrupted by a signal
    //  - an error happened for the child process itself
    var error = [];
    // We really failed if either there is:
    //  - an error code
    //  - a signal
    //  - a cause issue
    if (details.code) error.push(`Return code=<${details.code}>`);
    if (details.signal) error.push(`Signal=<${details.signal}>`);
    if ('error' in details) error.push(`Embedded error: ${util.formatObject(details.error)}`);
    // If stderr is not empty, consider it as a warning unless we got a real
    // error.
    if (stderr.data.length) {
      if (error.length) error.push(stderr.data.toString());
      else response.warning = stderr.data.toString();
    }
    if (error.length) {
      error.unshift('Application failed');
      response.error = error.join('\n');
    } else if (stdout.data.length) {
      try {
        var s = stdout.data.toString().trim();
        var ok = /^\d+$/.test(s);
        if (ok) {
          response.wsPort = Number(s);
          ok = !isNaN(response.wsPort);
        }
        if (ok) {
          console.log(`Determined WebSocket port=<${response.wsPort}>`)
        } else {
          error.push(`Could not determine WebSocket port: stdout is not a number`);
          error.push(`stdout=<${s}>`);
          response.error = error.join('\n');
        }
      } catch (error) {
        error.push(`Could not determine WebSocket port`);
        error.push(`Error: ${util.formatObject(error)}`)
        error.push(`stdout=<${s}>`);
        response.error = error.join('\n');
      }
    }
    deferred.resolve(response);
    // While not strictly necessary, cleanup by destroying streams ...
    child.stdout.destroy();
    child.stderr.destroy();
    // ... and explicitly letting go of the subprocess.
    child.unref();
  }

  child.on('exit', (code, signal) => {
    onDone({
      code: code,
      signal: signal
    });
  });
  child.on('error', error => {
    onDone({error: error});
  });
  child.stdout.on('data', data => {
    streamConcat(stdout, data);
  });
  child.stderr.on('data', data => {
    streamConcat(stderr, data);
  });

  return deferred.promise;
}

function tw_save(app, msg) {
  var deferred = new util.Deferred();

  fs.writeFile(msg.path, msg.content, err => {
    var response = { };
    if (err) response.error = err;
    deferred.resolve(response);
  });

  return deferred.promise;
}
