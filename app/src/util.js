'use strict';

const child_process = require('child_process');


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
  Deferred: Deferred,
  spawn: spawn
};
