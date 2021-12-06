'use strict';

import * as util from './util.js';
import * as http from './http.js';
import * as unsafe from './unsafe.js';


// 'Hide' Function usage to limit code inspection warnings.
var _fn = Function;

export class CodeExecutor {

  constructor(params) {
    var self = this;
    self.webext = params.webext;
    self.scriptName = params.name;
    // We will pass useful helpers automatically.
    self.argNames = params.args.concat(['http', 'notif', 'unsafe', 'util', 'webext']);
    if (params.code) {
      self.setup(params.code);
      return;
    }
    // We should have been given a setting, or setting branch.
    // We will listen to setting changes, unless code is expected to be executed
    // only once (caller should do it right after the instance is built).
    var setting = params.setting;
    if (setting.addListener) {
      if (!params.once) setting.addListener(() => {
        self.setup(setting.value);
      });
      self.setup(setting.value);
      return;
    }
    if (!setting.inner.script) {
      this.getNotif().warn({
        title: 'Script code setup failed',
        msg: `Unhandled setting=<${setting.getKey()}>`
      });
      return;
    }
    var enabled = setting.inner.enabled;
    if (enabled) {
      // Setting that can switch on/off script.
      if (!params.once) enabled.addListener(() => {
        self.disabled = !enabled.value;
      });
      self.disabled = !enabled.value;
    }
    setting = setting.inner.script;
    if (!params.once) setting.addListener(() => {
      self.setup(setting.value);
    });
    self.setup(setting.value);
  }

  setup(code) {
    delete(this.f);
    if (this.disabled || !code || !code.trim()) return;
    try {
      // Note: using 'Function.call' (or 'apply') instead of 'new Function' so
      // that we don't get warnings from code inspection.
      // And yes, I know I want to 'eval' code here.
      this.f = _fn.call(null, this.argNames, code);
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
export async function executeCode(params) {
  var executor = new CodeExecutor(Object.assign({}, params, {args: Object.keys(params.args), once: true}));
  return await executor.execute(params.args);
}
