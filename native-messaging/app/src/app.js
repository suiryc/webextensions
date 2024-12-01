'use strict';

import child_process from 'child_process';
import * as constants from './constants.js';
import fetch from 'node-fetch';
import fs from 'fs';
import * as nativeMessaging from './native-messaging.js';
import os from 'os';
import path from 'path';
import * as settings from './settings.js';
import * as util from './util.js';


let app = new nativeMessaging.NativeApplication(onMessage);

// Handles extension messages.
// 'async' so that we don't block and process the code asynchronously.
async function onMessage(app, msg) {
  switch (msg.kind) {
    case constants.KIND_DOWNLOAD:
      return dl_save(app, msg);
      break;

    case constants.KIND_HTTP_FETCH:
      return http_fetch(app, msg);
      break;

    case constants.KIND_SPECS:
      return app_specs(app, msg);
      break;

    case constants.KIND_TW_SAVE:
      return tw_save(app, msg);
      break;

    default:
      // Special case: empty message is a PING.
      let props = Object.getOwnPropertyNames(msg);
      if ((props.length == 1) && msg.hasOwnProperty('correlationId')) return {};
      else return unhandledMessage(msg);
      break;
  }
}

// Logs unhandled messages received.
function unhandledMessage(msg) {
  console.warn(`Received unhandled message feature=<${msg.feature}> kind=<${msg.kind}> contentSize=${(msg.content || '').length}`)
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
    separator: path.sep,
    tmpdir: os.tmpdir()
  };
}

function dl_save(app, msg) {
  // Note: even with detached mode, under Windows if we run inside a Job object
  // (e.g. when Firefox launches a native application), spawn children are part
  // of it, and usually when done all the attached processes are terminated.
  // To break out of the Job, the CREATE_BREAKAWAY_FROM_JOB CreateProcess
  // creation flag is needed, which seems possible in python but not nodejs.
  let deferred = new util.Deferred();
  // We always ask for the WebSocket port, so that next requests can be posted
  // directly from the browser.
  // Work with JSON format:
  //  - pass details as one-line JSON through spawned process stdin
  //  - read response as JSON (WebSocket port) and pass it to caller
  let args = ['--ws', '--json'];
  // Note: 'spawn' uses 'pipe' stdio by default, which is what we want here.
  let child = child_process.spawn(settings.dlMngrInterpreter, [settings.dlMngrPath, '--'].concat(args), {
    detached: true
  });
  // Don't forget to end stdin after writing our JSON, so that process sees EOF
  // and can fully read it.
  child.stdin.end(JSON.stringify(msg));

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
  let stdout = {
    data: Buffer.allocUnsafe(0)
  };
  let stderr = {
    data: Buffer.allocUnsafe(0)
  };

  // Concats data buffer for given stream.
  function streamConcat(s, data) {
    s.data = Buffer.concat([s.data, data]);
  }

  // Return response.
  // Note: we must properly handle being called more than once because 'error'
  // and 'exit' events may be triggered both; only the first call matters then.
  let done = false;
  function onDone(details) {
    if (done) return;
    done = true;
    // Upon 'exit', code or signal will be null; normalize for easier handling.
    if (!details.code) details.code = 0;
    if (!details.signal) delete details.signal;
    let response = { };
    // We consider the action failed if either:
    //  - the application wrote on stderr: (belt and suspenders) we actually
    //    only expect this to happen with a non-0 return code
    //  - return code is non-0
    //  - application was interrupted by a signal
    //  - an error happened for the child process itself
    let error = [];
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
      let s;
      try {
        s = stdout.data.toString().trim();
        // Update our response with process JSON response, but don't overwrite
        // our fields ('warning' and 'error', if applicable).
        Object.assign(response, JSON.parse(s), response);
        if (!isNaN(response.wsPort)) {
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

async function http_fetch(app, msg) {
  try {
    let r = await fetch(msg.resource, msg.options);

    // Note: we will need to copy/adapt response fields (and retrieved content)
    // so that it fits in the JSON message we will send back to caller.

    // Extract headers name/value.
    let headers = [];
    for (let [name, value] of r.headers.entries()) {
      headers.push({name, value});
    }
    // Copy response fields.
    let response = {
      headers,
      ok: r.ok,
      redirected: r.redirected,
      status: r.status,
      statusText: r.statusText,
      type: r.type,
      url: r.url
    };

    // Extract response content, in wanted formats.
    //
    // Notes:
    // Allow caller to ask for more than one format. We simply need to 'clone'
    // the response to get the appropriate formats.
    // When cloning, don't forget that content reading is done once, and that to
    // properly get it for all clones, we need to have them work in parallel.
    // See: https://github.com/node-fetch/node-fetch/blob/main/README.md#custom-highwatermark
    // Original response and clones all need to be consumed.
    // We prepare one or more Promises, which are completed *after* setting the
    // value in our response field. So when waiting for all of them, once they
    // are completed we know our response is ready.
    //
    // Explicitly get text/json: don't try to be smart and derive one from the
    // other here.
    // For binary formats, since the data needs to fit in the JSON response, we
    // get it as base64, and let caller build the wanted formats from this.
    let params = msg.params || {};
    let contentPromises = [];
    if (params.wantJson) {
      // Prepare JSON.
      let promise = new util.Deferred().promise;
      r.clone().json().then(v => {
        response.json = v;
        promise.resolve();
      });
      contentPromises.push(promise);
    }
    if (params.wantText) {
      // Prepare text.
      let promise = new util.Deferred().promise;
      r.clone().text().then(v => {
        response.text = v;
        promise.resolve();
      });
      contentPromises.push(promise);
    }
    // Last format to handle: don't clone this one, and ensure original response
    // is consumed.
    if (params.wantArrayBuffer || params.wantBlob || params.wantBytes || params.wantBase64) {
      // Prepare base64.
      // We do this if either one binary format was wanted.
      let promise = new util.Deferred().promise;
      r.arrayBuffer().then(v => {
        response.base64 = Buffer.from(v).toString('base64');
        promise.resolve();
      });
      contentPromises.push(promise);
    } else if (contentPromises.length) {
      // There was at least one clone done, so we need to consume the original
      // response too.
      // The safest is to ask for raw binary (ArrayBuffer).
      contentPromises.push(r.arrayBuffer());
    }

    // Wait for content variant(s) to be retrieved.
    await Promise.all(contentPromises);

    // Return response, in named field so that caller can easily distinguish
    // success from error.
    return { response };
  } catch (error) {
    console.log(`Failed to fetch resource=<${msg.resource}> with options:`, msg.options, util.formatObject(error));
    return { error };
  }
}

function tw_save(app, msg) {
  let deferred = new util.Deferred();

  fs.writeFile(msg.path, msg.content, err => {
    let response = { };
    if (err) response.error = err;
    deferred.resolve(response);
  });

  return deferred.promise;
}
