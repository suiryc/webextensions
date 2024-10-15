'use strict';

const child_process = require('child_process');


// Formats object to string.
function formatObject(obj, processed, recursiveLoop) {
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

class Deferred {

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
    for (let f of ['catch', 'finally', 'then']) {
      // 'finally' implemented in recent browsers only
      if (!this.promise[f]) continue;
      this[f] = this.promise[f].bind(this.promise);
    }
  }

}

// Spawns process, piping stdin/stdout/stderr, and returns Promise.
function spawn(command, args, options) {
  let d = new Deferred();
  let p = child_process.spawn(command, args, Object.assign({ shell : true, stdio: 'inherit' }, options));
  p.on('exit', (code, signal) => {
    if (code || signal) d.reject(`${command} execution failed`);
    else d.resolve();
  });
  p.on('error', (error) => {
    d.reject(`${command} execution failed: ${error}`);
  });
  return d.promise;
}


module.exports = {
  formatObject: formatObject,
  Deferred: Deferred,
  spawn: spawn
};
