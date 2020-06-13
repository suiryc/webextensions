'use strict';


// Gets current timestamp (epoch in milliseconds).
export function getTimestamp() {
  return (new Date()).getTime();
}

// Formats object to string.
export function formatObject(obj, processed, recursiveLoop) {
  // Handle recursion:
  // Remember the current object in order to prevent infinite loops (object
  // which directly - field - or indirectly - child field - points back to
  // itself).
  // Re-use formatting code to at least get the object kind.
  var recurse = function(child) {
    processed = processed || new Set();
    processed.add(obj);
    return processed.has(child)
      ? `(recursive) ${formatObject(child, processed, true)}`
      : formatObject(child, processed);
  };

  if (typeof(obj) == 'function') {
    // Only keep the function name (not the code).
    var name = obj.name;
    return `function ${name.length ? name : '(anonymous)'}`;
  }
  if (Array.isArray(obj)) {
    // Recursively handle arrays.
    if (recursiveLoop) return `Array(${obj.length})`;
    s = '[';
    var idx = 0;
    obj.forEach(v => {
      s += (idx++ ? ', ' : ' ') + recurse(v);
    })
    s += ' ]';
    return s;
  }
  // Quote strings.
  if (typeof(obj) == 'string') return `"${obj}"`;
  // Get raw value for non-objects (and null).
  if ((typeof(obj) != 'object') || (obj === null)) return '' + obj;

  // Handle errors.
  if (obj instanceof Error) {
    return obj.name + ' message=<' + obj.message + '>';
  }
  // Handle requests.
  if ((obj instanceof XMLHttpRequest) || (('status' in obj) && ('statusText' in obj))) {
    if (!obj.status && !obj.statusText.length) return 'XHR failed';
    if (obj.status == 200) return 'XHR succeeded';
    return 'XHR status=<' + obj.status + '> statusText=<' + obj.statusText + '>';
  }

  function append(p, o) {
    var s = recurse(o);
    return (s === undefined) ? p : (p + '; ' + s);
  }

  // Handle events.
  if ((obj instanceof Event) || (('type' in obj) && ('target' in obj))) {
    return append('Event type=<' + obj.type + '>', obj.target);
  }

  // If object has its own representation, use it. Otherwise get its name and
  // content.
  // Handle objects which fail to be stringified, and keep the error. We assume
  // at least the error can be turned into a string.
  // (e.g. 'TypeError: Cannot convert object to primitive value')
  var s = '';
  try {
    s += obj;
  } catch (error) {
    s += `(failed to stringify) ${error}`;
  }
  if (s.startsWith('[object ')) {
    var s = obj.constructor.name;
    if (s.length == 0) s = 'Object';
    if (recursiveLoop) return s;
    var idx = 0;
    Object.keys(obj).forEach(f => {
      var v = obj[f];
      // Don't include functions
      if (typeof(v) == 'function') return;
      s += ` ${f}=<${recurse(v)}>`;
      idx++;
    });
    if (idx == 0) s += ' (empty)';
  }
  return s;
}

// See: https://gist.github.com/jed/982883
export function uuidv4() {
  return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
    (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
  )
}

// Remove undefined and null fields.
export function cleanupFields(obj) {
  for (var f in obj) {
    var v = obj[f];
    if (v == null) v = undefined;
    if (v === undefined) delete(obj[f]);
  }
}

// Displays a browser notification and hide it after TTL (milliseconds).
export function browserNotification(notification, ttl) {
  var id = uuidv4();
  // Add our icon if necessary.
  // Note: with Firefox on Windows 10 the notification icon will be inserted in
  // a 80px square and SVG will be scaled to fit inside, similarly to what is
  // done for the pages (e.g options and browser action) icons.
  if (!('iconUrl' in notification)) notification['iconUrl'] = browser.extension.getURL('/resources/icon.svg');
  var p = browser.notifications.create(id, notification);
  if (ttl) {
    // We need to wait for the notification to be created in order to be able
    // to clear it.
    p.then(() => {
      setTimeout(() => {
        browser.notifications.clear(id);
      }, ttl);
    });
  }
}

// Formats application message (optional content/error).
export function formatApplicationMessage(details) {
  var message = details.message;
  var error = details.error;

  var msg = '';
  if (message !== undefined) msg = message;
  if (error !== undefined) {
    if (msg.length > 0) msg = `${msg}\n`;
    msg = `${msg}Error: ${formatObject(error)}`;
  }

  return msg;
}

// Simple Deferred implementation.
// Exposes a Promise resolve/reject callbacks for external completion.
export class Deferred {

  constructor() {
    // Reminder: function given to Promise constructor is executed before the
    // Promise object is actually built.
    // So: we cannot add fields to the promise object from within, but we are
    // sure than once we have the Promise object, the code has been executed.
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    this.promise.resolve = this.resolve;
    this.promise.reject = this.reject;
    // Plug useful functions, in case they are called on Deferred instead of
    // our embedded promise.
    for (var f of ['catch', 'finally', 'then']) {
      // 'finally' implemented in recent browsers only
      if (this.promise[f] === undefined) continue;
      this[f] = this.promise[f].bind(this.promise);
    }
  }

}

// Creates a Promise that fails after the given time (ms)
export function timeoutPromise(ms) {
  var d = new Deferred();
  var p = d.promise;
  p.timeoutId = setTimeout(() => {
    d.reject(`Timeout (${ms}) reached`);
  }, ms);
  return p;
}

// Creates a Promise that is resolved after the given time (ms)
export function delayPromise(ms) {
  var d = new Deferred();
  var p = d.promise;
  p.timeoutId = setTimeout(() => {
    d.resolve();
  }, ms);
  return p;
}

// Enqueues function to call after promise is resolved
export function promiseThen(p, f) {
  return p.then(r => {
    f();
    return r;
  }, error => {
    f();
    throw error;
  });
}

// Creates a promise that is completed from another one or after a given timeout
export function promiseOrTimeout(p, ms) {
  var timeout = timeoutPromise(ms);
  var timeoutId = timeout.timeoutId;
  // Race for promise/timeout and clear timeout before caller can chain code.
  return promiseThen(Promise.race([p, timeout]), () => {
    clearTimeout(timeoutId);
  });
}

// Shortcut to defer code for immediate execution:
//  defer.then(() => ...);
export var defer = Promise.resolve();
