'use strict';

import * as util from './util.js';
import * as unsafe from './unsafe.js';


export class CodeExecutor {

  constructor(webext, scriptName, argNames, code) {
    this.webext = webext;
    this.scriptName = scriptName;
    // We will pass useful helpers automatically.
    argNames = argNames.concat(['notif', 'unsafe', 'util', 'webext']);
    this.argNames = argNames;
    if ((code === undefined) || (code === null) || (code.trim() === '')) return;
    try {
      // Note: using 'Function.call' (or 'apply') instead of 'new Function' so
      // that we don't get warnings from code inspection.
      // And yes, I know I want to 'eval' code here.
      this.f = Function.call(null, argNames, code);
    } catch (error) {
      webext.notify({
        title: 'Script code setup failed',
        level: 'error',
        message: `Script: ${scriptName}`,
        error: error
      });
    }
  }

  async execute(args) {
    if (!this.f) return {};
    var argValues = [];
    var notif = this.getNotif();
    args = Object.assign({
      notif: notif,
      unsafe: unsafe,
      util: util,
      webext: this.webext
    }, args);
    for (var arg of this.argNames) {
      argValues.push(args[arg]);
    }
    try {
      var r = await Promise.resolve(this.f.apply(null, argValues));
      return r || {};
    } catch (error) {
      this.webext.notify({
        title: 'Script code execution failed',
        level: 'error',
        message: `Script: ${this.scriptName}`,
        error: error
      });
    }
    return {};
  }

  getNotif() {
    var self = this;
    // Create our dedicated notifier when needed.
    if (!self.webext.attributes.codeExecutorNotif) {
      var notif = {};
      ['info', 'warn', 'error'].forEach(level => {
        notif[level] = function(details, error) {
          // Prepare details.
          if (typeof(details) === 'object') details = Object.assign({}, details, {level: level});
          else details = {level: level, message: details, error: error};
          self.webext.notify(details);
        };
      });
      notif.warning = notif.warn;
      self.webext.attributes.codeExecutorNotif = notif;
    }
    return self.webext.attributes.codeExecutorNotif;
  }

}

// Executes script code.
export async function executeCode(webext, scriptName, params, code) {
  if ((code === undefined) || (code === null) || (code.trim() === '')) return {};
  var executor = new CodeExecutor(webext, scriptName, Object.keys(params), code);
  return await executor.execute(params);
}
