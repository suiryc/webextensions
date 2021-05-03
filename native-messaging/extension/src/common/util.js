'use strict';

import { constants } from './constants.js';


// Gets current timestamp (epoch in milliseconds).
export function getTimestamp() {
  return (new Date()).getTime();
}

// Gets epoch time (in seconds).
export function epoch() {
  return Math.round(getTimestamp() / 1000);
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

export function deepEqual(v1, v2) {
  // First check strict equality.
  if (v1 === v2) return true;
  // If both values are not objects, they definitely are not equals.
  // Beware: 'null' is considered as 'object' type.

  // Take care of undefined/null/non-object values.
  if ((v1 === undefined) || (v1 === null) || (v2 === undefined) || (v2 === null) || (typeof(v1) !== 'object') || (typeof(v2) !== 'object')) return false;
  // We have got two non-null objects.

  // There must be the same number of keys.
  var keys = Object.keys(v1);
  if (Object.keys(v2).length !== keys.length) return false;

  // All fields must be equal.
  for (var key of keys) {
    if (!deepEqual(v1[key], v2[key])) return false;
  }

  // Deep equality has been verified.
  return true;
}

// Remove undefined and null fields.
export function cleanupFields(obj) {
  for (var f in obj) {
    var v = obj[f];
    if (v == null) v = undefined;
    if (v === undefined) delete(obj[f]);
  }
}

// Normalizes url (for download).
// Drops fragment if any.
export function normalizeUrl(url, log, label) {
  if (url === undefined) return;
  // Notes:
  // We could simply do url.split('#').shift(), but using URL is more standard
  // and does sanitize a bit more.
  var normalized = new URL(url);
  normalized.hash = '';
  normalized = normalized.href;
  if (log && (normalized !== url)) console.log('Normalized=<%s> %s url=<%s>', normalized, url, label);
  return normalized;
}

// Gets filename, deduced from URL when necessary.
// Returns filename or empty value if unknown.
export function getFilename(url, filename) {
  // Deduce filename from URL when necessary.
  // Note: we could do normalizeUrl(url).split('?').shift().split('/').pop(),
  // but using URL is more standard, and handle more cases.
  if (filename === undefined) {
    try {
      filename = decodeURIComponent(new URL(url).pathname.split('/').pop());
    } catch (error) {
    }
    // Normalize: undefined if null.
    if (filename === null) filename = undefined;
  }
  // Normalize: empty value if undefined.
  if (filename === undefined) filename = '';
  return filename;
}

// Gets file name and extension.
// Extension is lowercased.
export function getFilenameExtension(filename, defaultExtension) {
  var idx = filename.lastIndexOf('.');
  var name = (idx > 0) ? filename.slice(0, idx) : filename;
  var extension = (idx > 0) ? filename.slice(idx + 1).toLowerCase().trim() : undefined;
  if (extension === '') extension = undefined;
  if (extension === undefined) extension = defaultExtension;
  return {
    name: name,
    extension: extension
  };
}

export function buildFilename(name, extension) {
  return ((extension !== undefined) && (extension !== null)) ? `${name}.${extension}` : name;
}

// Round number to the requested precision (3 digits by default).
function roundNumber(num, dec, precision) {
  if (num == 0) return 0;
  if (precision === undefined) precision = 3;

  var threshold = Math.pow(10, precision - 1);
  if (dec === undefined) {
    var tmp = Math.abs(num);
    if (tmp >= threshold) return Math.round(num);

    dec = 0;
    while (tmp < threshold) {
      tmp *= 10;
      dec++;
    }
  }

  return Math.round(num * Math.pow(10, dec)) / Math.pow(10, dec);
}

const sizeUnitFactor = 1024;
const sizeUnits = ['B', 'K', 'M', 'G', 'T'];

// Gets human-readable representation of size (in bytes).
export function getSizeText(size) {
  var idx = 0;
  while ((idx + 1 < sizeUnits.length) && (size >= sizeUnitFactor)) {
    size /= sizeUnitFactor;
    idx++;
  }
  // Round number, keep 3 digits of precision (e.g. 234, 23.4, 2.34).
  return `${roundNumber(size)}${sizeUnits[idx]}`;
}

// Limits text size by using ellipsis.
// If the text exceeds the given limit, its middle part is replaced by an
// ellipsis unicode character.
export function limitText(s, limit) {
  if ((s === undefined) || (s.length <= limit)) return s;
  // We insert one ellipsis unicode character, to deduce from the given limit.
  //  actualLimit = limit - 1
  // We split the string in two to keep that start and end.
  // For odd splitting, we take one more character from the start.
  // First half: from 0 to (actualLimit + 1) / 2
  // Second half: actualLimit / 2 from the end till the end
  return `${s.slice(0, limit / 2)}…${s.slice(-(limit - 1) / 2)}`;
}

export function checkContentScriptSetup(label) {
  // Possible ways to check whether global variable is set:
  //  - typeof(variable) !== 'undefined'
  //  - window.variable !== undefined
  if (typeof(csParams) === 'undefined') {
    // Assume there was a race condition: frame changed after injecting content
    // scripts params and before we could be injected.
    var msg = `Not executing ${label} content script: frame not setup yet`;
    console.log(msg);
    // Throw an Error, as throwing a mere string results in 'An unexpected error occurred'.
    throw new Error(msg);
  }
}

// Waits for DOM content to be loaded (i.e. document ready to be used).
// Executes given callback if any once ready.
// Returns a Promise resolved when ready, with passed callback result if any.
export function waitForDocument(callback) {
  var d = new Deferred();

  function complete() {
    if (callback !== undefined) d.completeWith(callback);
    else d.resolve();
  }

  // We want to wait for 'document.body' to exist.
  // The simplest way is to wait for 'DOMContentLoaded' which happens when the
  // page has been loaded (not including stylesheets, images and subframes).
  if (document.body !== null) complete();
  else document.addEventListener('DOMContentLoaded', complete);

  return d.promise;
}

// Sets node HTML content.
// See: https://stackoverflow.com/a/35385518
// See: https://stackoverflow.com/a/42658543
export function setHtml(node, html) {
  // First remove all content.
  while (node.hasChildNodes()) node.removeChild(node.lastChild);
  // Then parse/sanitize the html string.
  // For our usage, this should be enough. Alternatively we may use a real
  // sanitizer/purifier like DOMPurify.
  var dom = new DOMParser().parseFromString(`<template>${html}</template>`, 'text/html').head;
  // Finally inject the content.
  node.appendChild(dom.firstElementChild.content);
}

// Converts html text to real element.
// See: https://stackoverflow.com/a/35385518
// Notes:
// When innerHTML is set on a 'template' node, content is populated.
// When nodes are manipulated, childNodes/children is populated.
export function htmlToElement(html) {
  var template = document.createElement('template');
  setHtml(template, html);
  return template.firstChild;
}

// Extracts plain text from html.
// html tags are stripped, only text remains.
export function htmlToText(html) {
  var template = document.createElement('template');
  setHtml(template, html);
  return template.textContent;
}

// Converts text into html text.
// Escapes characters so that original text can be displayed in html content.
// Newlines are also replaced by 'br' tags.
// Notes:
// innerHTML is empty when using a 'template' node.
// It works as needed when using a 'div' node.
export function textToHtml(text) {
  var el = document.createElement('div');
  el.textContent = text;
  return el.innerHTML.replace(/\n/g, '<br>');;
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

export function extNotification(webext, details) {
  webext.sendMessage({
    target: constants.TARGET_BACKGROUND_PAGE,
    kind: constants.KIND_NOTIFICATION,
    details: details
  });
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

  completeWith(callback) {
    try {
      this.resolve(callback());
    } catch (error) {
      this.reject(error);
    }
    return this;
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
