'use strict';

import { constants } from './constants.js';
import * as asynchronous from './asynchronous.js';
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


// Properties managed by the extension.
export class PropertiesHandler {

  // We expect caller to properly setup us:
  //  - when inside a tab (no need to know other tabs) no handler is passed,
  //    even if we may sometimes 'get' for our 'tabId'
  //  - when multiple tabs can be seen and caller may need a per-tab property,
  //    it passes an appropriate handler
  //
  // There are two kinds of handlers:
  //  - the full one: see tabs.js
  //  - simple ones: usually mere observers, possibly only containing keys
  // In both cases, we require/expect two things:
  //  - there is a 'tabs' map we can access by id
  //  - the associated object, if any, already has an 'extensionProperties'
  //    field when managed (full tab handler); otherwise we can create it
  constructor(creator, tabsHandler) {
    this.creator = creator;
    this.tabsHandler = tabsHandler;
    this.properties = {};
  }

  reset() {
    for (let [key, entry] of Object.entries(this.properties)) {
      if (entry.keepOnReset) continue;
      delete(this.properties[key]);
    }
  }

  // Note: creator can be passed by caller, e.g. when getting per-tab property
  // through a global handler.
  get(details, creator) {
    let key = details.key;
    let create = details.create;
    creator ||= this.creator;

    // Specifically manage per-tab properties when there is an handler.
    if (this.tabsHandler && (details.tabId !== undefined)) {
      let tab = this.tabsHandler.tabs[details.tabId];
      if (!tab) {
        // Tab is not yet known: build the object right now, but do not cache it
        // (we wait for the tab to be known in order to use its cache).
        // We don't expect this to happen often, if at all (race conditions ?),
        // so log a warning when it happens.
        console.warn(`One-shot building property key=<${key}> for not-yet-known tab=<${details.tabId}> in handler=<%o> and creator=<%o>`, this.tabsHandler, creator);
        return create(creator);
      }
      if (!tab.extensionProperties) tab.extensionProperties = new PropertiesHandler(creator);
      return tab.extensionProperties.get(details, creator);
    }
    let entry = this.properties[key];
    if (!entry && create) {
      entry = this.properties[key] = {
        prop: create(creator),
        keepOnReset: details.keepOnReset
      }
    }
    if (entry) return entry.prop;
  }

}

// Gets current timestamp (epoch in milliseconds).
export function getTimestamp() {
  return (new Date()).getTime();
}

// Gets epoch time (in seconds).
export function epoch() {
  return Math.round(getTimestamp() / 1000);
}

// Clone object structure.
// Handles failures by ignoring/transfomring unhandled values.
export function tryStructuredClone(obj, processed) {
  // Try native structured clone.
  try {
    return structuredClone(obj);
  } catch { }
  // Clean/sanitize value if it failed.

  // Ignore functions.
  if (typeof(obj) == 'function') return undefined;

  // Handle recursion:
  // Remember the current object in order to detect circular recursion.
  // Prepare a variable to hold the cloned object.
  // Create a Map upon first recursion, and share it: remember all cloned
  // objects by strict equality, to reuse them and clone the circular recursion.
  let r;
  let recurse = function(child) {
    processed = processed || new Map();
    processed.set(obj, r);
    return processed.has(child)
      ? processed.get(child)
      : tryStructuredClone(child, processed);
  };

  // Handle arrays.
  if (Array.isArray(obj)) {
    r = [];
    obj.forEach(v => r.push(recurse(v)));
    return r;
  }

  // Stringify non-objects.
  if (typeof(obj) != 'object') return `${obj}`;

  // Handle some web nodes.
  if (obj instanceof Element) {
    return obj.outerHTML;
  }
  if (obj instanceof Document) {
    return tryStructuredClone(obj.body, processed);
  }

  // Handle objects.
  r = {};
  Object.keys(obj).forEach(f => {
    let v = obj[f];
    // Don't include functions.
    if (typeof(v) == 'function') return;
    r[f] = recurse(v);
  });
  return r;
}

// Formats object to string.
export function formatObject(obj, processed, recursiveLoop) {
  // Handle recursion:
  // Remember the current object in order to detect circular recursion.
  // Create a Set in first recursion level, and duplicate it in each recursion
  // because we want to clone sibling values separately: remember all cloned
  // objects by strict equality.
  // Re-use formatting code to at least get the object kind.
  let recurse = function(child) {
    processed = new Set(processed || []);
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
    let idx = 0;
    obj.forEach(v => {
      s += (idx++ ? ', ' : ' ') + recurse(v);
    });
    s += ' ]';
    return s;
  }
  // Quote strings.
  if (typeof(obj) == 'string') return `"${obj}"`;
  // Get raw value for non-objects (and null).
  if ((typeof(obj) != 'object') || (obj === null)) return `${obj}`;

  // Handle errors.
  if (obj instanceof Error) return `${obj.name} message=<${obj.message}>`;
  // Handle requests.
  if ((obj instanceof XMLHttpRequest) || (('status' in obj) && ('statusText' in obj))) {
    if (!obj.status && !obj.statusText) return 'XHR failed';
    if (obj.status == 200) return 'XHR succeeded';
    return `XHR status=<${obj.status}> statusText=<${obj.statusText}>`;
  }

  function append(p, o) {
    let s = recurse(o);
    return s ? `${p}; ${s}` : p;
  }

  // Handle events.
  if ((obj instanceof Event) || (('type' in obj) && ('target' in obj))) {
    return append(`Event type=<${obj.type}>`, obj.target);
  }

  // If object has its own representation, use it. Otherwise get its name and
  // content.
  // Handle objects which fail to be stringified, and keep the error. We assume
  // at least the error can be turned into a string.
  // (e.g. 'TypeError: Cannot convert object to primitive value')
  let s = '';
  try {
    s += obj;
  } catch (error) {
    s += `(failed to stringify) ${error}`;
  }
  if (s.startsWith('[object ')) {
    s = obj.constructor.name;
    if (!s) s = 'Object';
    if (recursiveLoop) return s;
    let idx = 0;
    Object.keys(obj).forEach(f => {
      let v = obj[f];
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
  let keys = Object.keys(v1);
  if (Object.keys(v2).length !== keys.length) return false;

  // All fields must be equal.
  for (let key of keys) {
    if (!deepEqual(v1[key], v2[key])) return false;
  }

  // Deep equality has been verified.
  return true;
}

// Remove undefined and null fields.
export function cleanupFields(obj) {
  for (let f in obj) {
    let v = obj[f];
    if ((v === null) || (v === undefined)) delete(obj[f]);
  }
}

// Prepares value for JSON encoding.
export function toJSON(obj, processed) {
  // JSON.parse(JSON.stringify(arg)) would be too consuming for our need.
  // Ignore functions.
  if (typeof(obj) == 'function') return undefined;

  // Keep non-object values as-is.
  if (!obj || (typeof(obj) != 'object')) return obj;

  // Handle recursion:
  // Remember the current object in order to detect circular recursion.
  // Create a Set in first recursion level, and duplicate it in each recursion
  // because we want to clone sibling values separately: remember all cloned
  // objects by strict equality.
  let recurse = function(child) {
    processed = new Set(processed || []);
    processed.add(obj);
    return processed.has(child)
      ? undefined
      : toJSON(child, processed);
  };

  // Handle arrays.
  if (Array.isArray(obj)) {
    let r = [];
    obj.forEach(v => r.push(recurse(v)));
    return r;
  }

  // Handle objects.
  // Check whether 'toJSON' has been defined to get a lighter version of
  // the object.
  let r = obj.toJSON ? obj.toJSON() : Object.assign({}, obj);
  for (let [key, value] of Object.entries(r)) {
    if (typeof(value) == 'function') delete(r[key]);
    else r[key] = recurse(value);
  }
  return r;
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
  let normalized = new URL(url);
  normalized.hash = '';
  normalized = normalized.href;
  if (log && (normalized !== url)) console.log(`Normalized=<${normalized}> ${label} url=<${url}>`);
  return normalized;
}

export function parseSiteUrl(url) {
  // First ensure we have an URL object
  url = new URL(url);
  let hostname = url.hostname;
  let nameParts = hostname.split('.');
  let name = ((nameParts.length > 1) ? nameParts.slice(-2, -1)[0] : hostname).toLowerCase();
  // pathname starts with '/', so splitting creates an empty entry in first position.
  let pathParts = (url.pathname != '/')
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
  if (!filename || !filename.trim().length) {
    try {
      filename = decodeURIComponent(new URL(url).pathname.split('/').pop());
    } catch (error) {
    }
  }
  // Normalize: empty value if needed.
  return (filename || '').trim();
}

// Gets file name and extension.
// Extension is lowercased.
export function getFilenameExtension(filename, defaultExtension) {
  let idx = (filename || '').lastIndexOf('.');
  let name = (idx > 0) ? filename.slice(0, idx) : filename;
  let extension = (idx > 0) ? filename.slice(idx + 1).toLowerCase().trim() : '';
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
    let threshold = Math.pow(10, precision - 1);
    let tmp = Math.abs(num);
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
  let s = '' + num;
  return (s.length >= chars) ? s : ('0'.repeat(chars) + s).slice(-chars);
}

const sizeUnitFactor = 1024;
const sizeUnits = ['B', 'K', 'M', 'G', 'T'];

// Gets human-readable representation of size (in bytes).
export function getSizeText(size) {
  let idx = 0;
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
  let d = new asynchronous.Deferred();

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
  let dom = new DOMParser().parseFromString(`<template>${html}</template>`, 'text/html').head;
  // Finally inject the content.
  node.appendChild(dom.firstElementChild.content);
}

// Converts html text to real element.
// See: https://stackoverflow.com/a/35385518
// Notes:
// When innerHTML is set on a 'template' node, content is populated.
// When nodes are manipulated, childNodes/children is populated.
export function htmlToElement(html) {
  let template = document.createElement('template');
  setHtml(template, html);
  return template.firstChild;
}

// Extracts plain text from html.
// html tags are stripped, only text remains.
export function htmlToText(html) {
  if (!html) return '';
  let template = document.createElement('template');
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
  let el = document.createElement('div');
  el.textContent = text;
  return el.innerHTML.replace(/\n/g, '<br>');;
}

// Displays a browser notification and hide it after TTL (milliseconds).
export function browserNotification(notification, ttl) {
  let id = uuidv4();
  // Add our icon if necessary.
  // Note: with Firefox on Windows 10 the notification icon will be inserted in
  // a 80px square and SVG will be scaled to fit inside, similarly to what is
  // done for the pages (e.g options and browser action) icons.
  if (!('iconUrl' in notification)) notification['iconUrl'] = browser.runtime.getURL('/resources/icon.svg');
  let p = browser.notifications.create(id, notification);
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
  let level = details.level || 'info';
  if (!(level in console)) level = 'info';

  function stripHtml(s) {
    return (details.html ? htmlToText(s) : s);
  }

  let msg = [];
  let args = [];
  let title = stripHtml(details.title);
  if (title) {
    if (details.source) {
      msg.push('[%s] %s');
      args.push(details.source);
    } else {
      msg.push('%s');
    }
    args.push(title);
  }
  let message = stripHtml(details.message);
  let error = details.error;

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

// Show notification when applicable.
// Updates given details to silence notification if called again.
export function notification(details) {
  log(details);
  // Note: content script does not have access to browser.notifications, in
  // which case caller is expected to delegate it to the background script.
  if (details.silent || !browser.notifications) return;

  function stripHtml(s) {
    return (details.html ? htmlToText(s) : s);
  }

  // The title is mandatory for browser notifications.
  let title = stripHtml(details.title);
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
  let message = details.message;
  let error = details.error;
  let msg = [];
  if (message) msg.push(message);
  if (error) msg.push(`Error: ${formatObject(error)}`);
  return msg.join('\n');
}
