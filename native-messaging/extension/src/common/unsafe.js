'use strict';

import * as util from './util.js';
import * as http from './http.js';
import * as unsafe from './unsafe.js';


export class CodeExecutor {

  constructor(webext, scriptName, argNames, code) {
    var self = this;
    self.webext = webext;
    self.scriptName = scriptName;
    // We will pass useful helpers automatically.
    argNames = argNames.concat(['http', 'notif', 'unsafe', 'util', 'webext']);
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
      this.getNotif().error({
        title: 'Script code setup failed',
        error
      });
    }
  }

  async execute(args) {
    if (!this.f) return {};
    var argValues = [];
    var notif = this.getNotif();
    args = Object.assign({
      http,
      notif,
      unsafe,
      util,
      webext: this.webext
    }, args);
    for (var arg of this.argNames) {
      argValues.push(args[arg]);
    }
    try {
      var r = await Promise.resolve(this.f.apply(null, argValues));
      return r || {};
    } catch (error) {
      notif.error({
        title: 'Script code execution failed',
        error
      });
    }
    return {};
  }

  getNotif() {
    return this.webext.getNotif(this.scriptName);
  }

}

// Executes script code.
export async function executeCode(webext, scriptName, params, code) {
  if (!code || !code.trim()) return {};
  var executor = new CodeExecutor(webext, scriptName, Object.keys(params), code);
  return await executor.execute(params);
}
