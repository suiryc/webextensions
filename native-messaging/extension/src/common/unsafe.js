'use strict';

import * as util from './util.js';
import * as unsafe from './unsafe.js';


export class CodeExecutor {

  constructor(webext, scriptName, argNames, code) {
    this.webext = webext;
    this.scriptName = scriptName;
    // We will pass useful helpers automatically.
    argNames = argNames.concat(['log', 'unsafe', 'util', 'webext']);
    this.argNames = argNames;
    if ((code === undefined) || (code === null) || (code.trim() === '')) return;
    try {
      // Note: using 'Function.call' (or 'apply') instead of 'new Function' so
      // that we don't get warnings from code inspection.
      // And yes, I know I want to 'eval' code here.
      this.f = Function.call(null, argNames, code);
    } catch (error) {
      util.extNotification(webext, {
        title: 'Script code setup failed',
        level: 'error',
        message: `Script: ${scriptName}`,
        error: util.formatObject(error)
      });
    }
  }

  async execute(args) {
    if (!this.f) return {};
    var argValues = [];
    var log = this.getLogger();
    args = Object.assign({
      log: log,
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
      util.extNotification(this.webext, {
        title: 'Script code execution failed',
        level: 'error',
        message: `Script: ${this.scriptName}`,
        error: util.formatObject(error)
      });
    }
    return {};
  }

  getLogger() {
    var self = this;
    // Create our dedicated logger when needed.
    if (!self.webext.attributes.codeExecutorLog) {
      // Create a logger relying on notifications.
      var log = {};
      ['info', 'warn', 'error'].forEach(level => {
        log[level] = function(details, error) {
          // Prepare details.
          if (typeof(details) === 'object') details = Object.assign({}, details, {level: level});
          else details = {level: level, message: details, error: error};
          error = details.error;
          // Log right now (especially useful for real errors info).
          var args = [];
          var msg = '';
          if (details.title) {
            msg = details.label ? `[${details.label}] ${details.title}` : details.title;
          }
          if (details.message !== undefined) {
            msg = msg ? `${msg}: %s` : '%s';
            args.push(details.message);
          }
          if (error !== undefined) args.push(error);
          args.unshift(msg);
          console[level].apply(console, args);
          details.logged = true;
          // Format error if needed so that notification can be properly serialized.
          if (!self.webext.isBackground && details.error) details.error = util.formatObject(details.error);
          util.extNotification(self.webext, details);
        };
      });
      log.warning = log.warn;
      self.webext.attributes.codeExecutorLog = log;
    }
    return self.webext.attributes.codeExecutorLog;
  }

}

// Executes script code.
export async function executeCode(webext, scriptName, params, code) {
  if ((code === undefined) || (code === null) || (code.trim() === '')) return {};
  var executor = new CodeExecutor(webext, scriptName, Object.keys(params), code);
  return await executor.execute(params);
}
