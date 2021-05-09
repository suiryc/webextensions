'use strict';

import * as util from './util.js';
import * as unsafe from './unsafe.js';


export class CodeExecutor {

  constructor(webext, scriptName, argNames, code) {
    var self = this;
    self.webext = webext;
    self.scriptName = scriptName;
    // We will pass useful helpers automatically.
    argNames = argNames.concat(['notif', 'unsafe', 'util', 'webext']);
    self.argNames = argNames;

    if ((typeof(code) === 'object') && code.addListener) {
      // Assume we were given a setting: automatically listen to changes.
      code.addListener(() => {
        self.setup(code.value);
      });
      self.setup(code.value);
      return;
    }

    self.setup(code);
  }

  setup(code) {
    delete(this.f);
    if (!code || !code.trim()) return;
    try {
      // Note: using 'Function.call' (or 'apply') instead of 'new Function' so
      // that we don't get warnings from code inspection.
      // And yes, I know I want to 'eval' code here.
      this.f = Function.call(null, this.argNames, code);
    } catch (error) {
      this.webext.notify({
        title: 'Script code setup failed',
        level: 'error',
        message: `Script: ${this.scriptName}`,
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
    return self.webext.getExtensionProperty({
      key: `codeExecutor.notif.${self.scriptName}`,
      create: webext => {
        var notif = {};
        ['info', 'warn', 'error'].forEach(level => {
          notif[level] = function(details, error) {
            // Prepare details.
            if (typeof(details) === 'object') details = Object.assign({source: self.scriptName}, details, {level: level});
            else details = {source: self.scriptName, level: level, message: details, error: error};
            webext.notify(details);
          };
        });
        notif.warning = notif.warn;
        return notif;
      }
    });
  }

}

// Executes script code.
export async function executeCode(webext, scriptName, params, code) {
  if (!code || !code.trim()) return {};
  var executor = new CodeExecutor(webext, scriptName, Object.keys(params), code);
  return await executor.execute(params);
}
