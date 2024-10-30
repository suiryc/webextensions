'use strict';


// Simple Deferred implementation.
// Exposes a Promise resolve/reject callbacks for external completion.
export class Deferred {

  constructor() {
    // Reminder: function given to Promise constructor is executed before the
    // Promise object is actually built.
    // So: we cannot add fields to the promise object from within, but we are
    // sure that once we have the Promise object, the code has been executed.
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
  let d = new Deferred();
  let p = d.promise;
  p.timeoutId = setTimeout(() => {
    d.reject(`Timeout (${ms}) reached`);
  }, ms);
  return p;
}

// Creates a Promise that is resolved after the given time (ms)
export function delayPromise(ms) {
  let d = new Deferred();
  let p = d.promise;
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
  let timeout = timeoutPromise(ms);
  let timeoutId = timeout.timeoutId;
  // Race for promise/timeout and clear timeout before caller can chain code.
  return promiseThen(Promise.race([p, timeout]), () => {
    clearTimeout(timeoutId);
  });
}

// Shortcut to defer code for immediate execution:
//  defer.then(() => ...);
export let defer = Promise.resolve();
