'use strict';

const child_process = require('child_process');


// Formats object to string.
function formatObject(obj, processed, recursiveLoop) {
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
    for (var f of ['catch', 'finally', 'then']) {
      // 'finally' implemented in recent browsers only
      if (this.promise[f] === undefined) continue;
      this[f] = this.promise[f].bind(this.promise);
    }
  }

}

// Spawns process, piping stdin/stdout/stderr, and returns Promise.
function spawn(command, args, options) {
  var d = new Deferred();
  var p = child_process.spawn(command, args, Object.assign({ shell : true, stdio: 'inherit' }, options));
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
