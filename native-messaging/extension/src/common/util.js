'use strict';

import { constants } from './constants.js';
import { settings } from './settings.js';


// Notes:
// Possible ways to check whether global variable is set:
//  - typeof(variable) !== 'undefined'
//  - {globalThis,global,window}.variable !== undefined
//  - 'variable' in {globalThis,global,window}
// 'window' only exists in browser, although not everywhere (e.g. not in Web
// Workers), and does not exist in Node.js (unit tests).
// 'global' exists in Node.js, and may exist in browsers (e.g. Firefox).
// 'globalThis' is preferred over 'global', as it is supposed to be a standard
// now, and 'global' needs some webpack code injection which triggers web-ext
// warnings.


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

  // Only keep function name (not the code).
  if (typeof(obj) == 'function') return `function ${obj.name || '(anonymous)'}`;
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
  if (obj instanceof Error) return obj.name + ' message=<' + obj.message + '>';
  // Handle requests.
  if ((obj instanceof XMLHttpRequest) || (('status' in obj) && ('statusText' in obj))) {
    if (!obj.status && !obj.statusText) return 'XHR failed';
    if (obj.status == 200) return 'XHR succeeded';
    return 'XHR status=<' + obj.status + '> statusText=<' + obj.statusText + '>';
  }

  function append(p, o) {
    var s = recurse(o);
    return s ? p + '; ' + s : p;
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
    s = obj.constructor.name;
    if (!s) s = 'Object';
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
    if ((v === null) || (v === undefined)) delete(obj[f]);
  }
}

// Prepares value for JSON encoding.
export function toJSON(v) {
  // JSON.parse(JSON.stringify(arg)) would be too consuming for our need.
  // Keep non-object values as-is.
  if (!v || (typeof(v) != 'object')) return v;
  // Recursively process arrays.
  if (Array.isArray(v)) return v.map(e => toJSON(e));
  // Recursively process objects.
  // Check whether 'toJSON' has been defined to get a lighter version of
  // the object.
  v = v.toJSON ? v.toJSON() : Object.assign({}, v);
  for (var [key, value] of Object.entries(v)) {
    if (typeof(value) == 'function') delete(v[key]);
    else v[key] = toJSON(value);
  }
  return v;
}

export function hasMethod(obj, m) {
  return (typeof(obj[m]) === 'function');
}

export function callMethod(obj, m, args) {
  if (hasMethod(obj, m)) obj[m].apply(obj, args);
}

// Ensure URL is in string format.
// Useful when value is saved in field meant to be sent as message, as using the
// original URL object will trigger a 'URL object could not be cloned' error.
export function urlString(url) {
  if (!url || (typeof(url) == 'string')) return url;
  if (url instanceof URL) return url.href;
  return `${url}`;
}

// Normalizes url (for download).
// Drops fragment if any.
export function normalizeUrl(url, log, label) {
  if (!url) return;
  // Notes:
  // We could simply do url.split('#').shift(), but using URL is more standard
  // and does sanitize a bit more.
  var normalized = new URL(url);
  normalized.hash = '';
  normalized = normalized.href;
  if (log && (normalized !== url)) console.log('Normalized=<%s> %s url=<%s>', normalized, url, label);
  return normalized;
}

export function parseSiteUrl(url) {
  // First ensure we have an URL object
  url = new URL(url);
  var hostname = url.hostname;
  var nameParts = hostname.split('.');
  var name = ((nameParts.length > 1) ? nameParts.slice(-2, -1)[0] : hostname).toLowerCase();
  // pathname starts with '/', so splitting creates an empty entry in first position.
  var pathParts = (url.pathname != '/')
    ? url.pathname.split('/').slice(1).map(decodeURIComponent)
    : []
    ;

  // Note: only keep string variant of URL, because object may be used as message
  // to post, and 'URL object could not be cloned' would be triggered.
  return {
    url: urlString(url),
    hostname: hostname,
    pathParts: pathParts,
    name: name,
    nameParts: nameParts
  };
}

// Gets filename, deduced from URL when necessary.
// Returns filename or empty value if unknown.
export function getFilename(url, filename) {
  // Deduce filename from URL when necessary.
  // Note: we could do normalizeUrl(url).split('?').shift().split('/').pop(),
  // but using URL is more standard, and handle more cases.
  if (!filename) {
    try {
      filename = decodeURIComponent(new URL(url).pathname.split('/').pop());
    } catch (error) {
    }
  }
  // Normalize: empty value if needed.
  return filename || '';
}

// Gets file name and extension.
// Extension is lowercased.
export function getFilenameExtension(filename, defaultExtension) {
  var idx = (filename || '').lastIndexOf('.');
  var name = (idx > 0) ? filename.slice(0, idx) : filename;
  var extension = (idx > 0) ? filename.slice(idx + 1).toLowerCase().trim() : '';
  return {
    name: name || '',
    extension: extension || defaultExtension || ''
  };
}

export function buildFilename(name, extension) {
  name = name || '';
  return extension ? `${name}.${extension}` : name;
}

// Round number to the requested precision (3 digits by default).
export function roundNumber(num, dec, precision) {
  if (num == 0) return 0;
  if (dec === undefined) {
    if (precision === undefined) precision = 3;
    var threshold = Math.pow(10, precision - 1);
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

export function padNumber(num, chars) {
  var s = '' + num;
  return (s.length >= chars) ? s : ('0'.repeat(chars) + s).slice(-chars);
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
  if (!s || (s.length <= limit)) return s;
  // We insert one ellipsis unicode character, to deduce from the given limit.
  //  actualLimit = limit - 1
  // We split the string in two to keep that start and end.
  // For odd splitting, we take one more character from the start.
  // First half: from 0 to (actualLimit + 1) / 2
  // Second half: actualLimit / 2 from the end till the end
  return `${s.slice(0, limit / 2)}…${limit > 2 ? s.slice(-(limit - 1) / 2) : ''}`;
}

// Waits for DOM content to be loaded (i.e. document ready to be used).
// Executes given callback if any once ready.
// Returns a Promise resolved when ready, with passed callback result if any.
export function waitForDocument(callback) {
  var d = new Deferred();

  function complete() {
    if (callback) d.completeWith(callback);
    else d.resolve();
  }

  // We want to wait for 'document.body' to exist.
  // The simplest way is to wait for 'DOMContentLoaded' which happens when the
  // page has been loaded (not including stylesheets, images and subframes).
  if (document.body) complete();
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
  if (!html) return '';
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
  if (!text) return '';
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
  if (!('iconUrl' in notification)) notification['iconUrl'] = browser.runtime.getURL('/resources/icon.svg');
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

export function log(details) {
  if (details.level == 'warning') details.level = 'warn';
  if (details.logged) return;
  var level = details.level || 'info';
  if (!(level in console)) level = 'info';

  function stripHtml(s) {
    return (details.html ? htmlToText(s) : s);
  }

  var msg = [];
  var args = [];
  var title = stripHtml(details.title);
  if (title) {
    if (details.source) {
      msg.push('[%s] %s');
      args.push(details.source);
    } else {
      msg.push('%s');
    }
    args.push(title);
  }
  var message = stripHtml(details.message);
  var error = details.error;

  if (message) {
    if (!msg.length && details.source) {
      msg.push('[%s] %s');
      args.push(details.source);
    } else {
      msg.push('%s');
    }
    args.push(message);
  }
  if (error) {
    msg.push('%o');
    args.push(error);
  }
  msg = msg.join('\n');
  args.unshift(msg);
  console[level].apply(console, args);
  details.logged = true;
}

export function notification(details) {
  log(details);
  // Note: content script does not have access to browser.notifications, in
  // which case caller is expected to delegate it to the background script.
  if (details.silent || !browser.notifications) return;

  function stripHtml(s) {
    return (details.html ? htmlToText(s) : s);
  }

  // The title is mandatory for browser notifications.
  var title = stripHtml(details.title);
  if (details.source) title = title ? `[${details.source}] ${title}` : details.source;
  if (!title) title = constants.EXTENSION_ID;
  browserNotification({
    'type': 'basic',
    'title': title,
    'message': stripHtml(formatApplicationMessage(details))
  }, settings.notifyTtl);
  details.silent = true;
}

// Formats application message (optional content/error).
export function formatApplicationMessage(details) {
  var message = details.message;
  var error = details.error;
  var msg = [];
  if (message) msg.push(message);
  if (error) msg.push(`Error: ${formatObject(error)}`);
  return msg.join('\n');
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
      if (!this.promise[f]) continue;
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
