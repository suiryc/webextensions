'use strict';

import { constants } from './constants.js';


// Simple Deferred implementation.
// Exposes a Promise resolve/reject callbacks for external completion.
export class Deferred {

  static debugPromise(p, orig) {
    // Do it only once.
    if (p.state) return p;
    // Don't do it if original promise was not debugged.
    if (orig && !orig.state) return p;
    p.state = 'pending';
    p.then(
      () => p.state = 'fulfilled',
      () => p.state = 'rejected'
    );
    // Inject, or replace, some useful methods in the promise.
    // Note: 'catch' and 'finally' both rely on 'then', so we only need to
    // override the later.
    for (let f of ['isFulfilled', 'isRejected', 'isCompleted', 'then']) {
      if (p[f]) p[`original_${f}`] = p[f].bind(p);
      p[f] = Deferred[`proxied_${f}`].bind(p);
    }
    return p;
  }

  constructor(debug) {
    let self = this;
    // Reminder: function given to Promise constructor is executed before the
    // Promise object is actually built.
    // So: we cannot add fields to the promise object from within, but we are
    // sure that once we have the Promise object, the code has been executed.
    self.promise = new Promise((resolve, reject) => {
      self.resolve = resolve;
      self.reject = reject;
    });
    // Inject callbacks in both underlying promise, and deferred.
    for (let f of ['resolve', 'reject']) {
      self.promise[f] = self[f];
    }
    // Plug useful functions, in case they are called on Deferred instead of
    // our embedded promise.
    for (let f of ['catch', 'finally', 'then']) {
      // 'finally' implemented in recent browsers only
      if (!self.promise[f]) continue;
      self[f] = self.promise[f].bind(self.promise);
    }
    if (debug) Deferred.debugPromise(self.promise);
  }

  static proxied_isFulfilled() {
    return this.state == 'fulfilled';
  }

  static proxied_isRejected() {
    return this.state == 'rejected';
  }

  static proxied_isCompleted() {
    return this.state != 'pending';
  }

  static proxied_then(onFulfilled, onRejected) {
    return Deferred.debugPromise(this.original_then(onFulfilled, onRejected));
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
  return promiseThen(Deferred.debugPromise(Promise.race([p, timeout]), p), () => {
    clearTimeout(timeoutId);
  });
}

// Shortcut to defer code for immediate execution:
//  defer.then(() => ...);
export let defer = Promise.resolve();


// Simple mutex.
// Even though javascript execution is mono-threaded, using async/await can
// lead to kind of concurrent access when fields are read before and updated
// after asynchronous calls, and belonging code can be called again while in
// these asynchronous calls.
export class Mutex {

  static #debug = false;

  #acquired = false;
  #waiting = [];

  // Acquire (promise) mutex lock.
  // If mutex is not yet acquired, caller gets nothing and can work immediatly.
  // In any case, caller must call once (and only once) 'release' once done.
  acquire(timeout = 0) {
    // Caller can acquire free mutex right now.
    if (!this.#acquired) {
      if (Mutex.#debug) console.log('Mutex.acquire #acquired = false -> true');
      this.#acquired = true;
      return;
    }
    if (Mutex.#debug) console.log('Mutex.acquire #acquired = true => new Deferred');

    // Caller will have to wait.
    // We remember callers in the order they try to acquire.
    // We attach a timeout to ensure we don't get stuck infinitely.
    let d = new Deferred(Mutex.#debug);
    this.#waiting.push(d);
    if (timeout < 0) return d.promise;
    return promiseOrTimeout(d.promise, timeout || constants.MUTEX_ACQUIRE_TIMEOUT).catch(error => {
      // Log issue and don't propagate it.
      console.warn('Mutex.acquire unsuccessful:', error);
    });
  }

  // Release mutex lock.
  release() {
    // Ensure we are currently acquired.
    if (!this.#acquired) {
      if (Mutex.#debug) console.error('Cannot release mutex which is not currently acquired!');
      return;
    }

    // Fully release mutex if nothing else is waiting.
    if (!this.#waiting.length) {
      if (Mutex.#debug) console.log('Mutex.release #acquired = true -> false');
      this.#acquired = false;
      return;
    }

    // Transfer mutex to next waiting caller.
    if (Mutex.#debug) console.log('Mutex.release resolve next queued');
    this.#waiting.shift().resolve();
  }

  // Automatically acquire and release mutex around given code.
  // When multiple callers use this method, it is guaranteed that passed code
  // blocks will be executed sequentially, in the order we were called.
  async whileAcquired(f) {
    await this.acquire();
    try {
      return await f();
    } finally {
      this.release();
    }
  }

  // Prepare mutex lock, but only synchronize after given code is done.
  // When multiple callers use this method, all passed code blocks can run in
  // parallel (though they will start in the order we were called), but it is
  // guaranteed that callers will be released in the order they arrived.
  async syncEnding(f) {
    let lock = this.acquire();
    try {
      return await f();
    } finally {
      if (Mutex.#debug) console.log('Mutex.syncEnding lock already completed upon ending ?', !lock || lock.isCompleted());
      await lock;
      this.release();
    }
  }

}
