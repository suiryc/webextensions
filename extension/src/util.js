function getTimestamp() {
  return (new Date()).getTime();
}

function formatObject(obj) {
  if (typeof(obj) != 'object') return '' + obj;

  if (obj instanceof Error) {
    return obj.name + ' message=<' + obj.message + '>';
  }
  if ((obj instanceof XMLHttpRequest) || (('status' in obj) && ('statusText' in obj))) {
    if (!obj.status && !obj.statusText.length) return 'XHR failed';
    if (obj.status == 200) return 'XHR succeeded';
    return 'XHR status=<' + obj.status + '> statusText=<' + obj.statusText + '>';
  }

  function append(p, o) {
    var s = formatObject(o);
    return (s === undefined) ? p : (p + '; ' + s);
  }

  if ((obj instanceof Event) || (('type' in obj) && ('target' in obj))) {
    return append('Event type=<' + obj.type + '>', obj.target);
  }

  var s = '' + obj;
  if (s == '[object Object]') console.warn('Cannot describe object %o', obj);
  return s;
}

// See: https://gist.github.com/jed/982883
function uuidv4() {
  return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
    (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
  )
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

function timeoutPromise(ms) {
  var d = new Deferred();
  var p = d.promise;
  p.timeoutId = setTimeout(() => {
    d.reject('Timeout (' + ms + ') reached');
  }, ms);
  return p;
}

// Enqueue function to call after promise is resolved
function promiseThen(p, f) {
  return p.then(r => {
    f();
    return r;
  }, error => {
    f();
    throw error;
  });
}

function promiseOrTimeout(p, ms) {
  var timeout = timeoutPromise(ms);
  var timeoutId = timeout.timeoutId;
  // Race for promise/timeout and clear timeout before caller can chain code.
  return promiseThen(Promise.race([p, timeout]), () => {
    // TODO
    //clearTimeout(timeoutId);
  });
}

// Shortcut to defer code for immediate execution:
//  defer.then(() => ...);
var defer = Promise.resolve();
