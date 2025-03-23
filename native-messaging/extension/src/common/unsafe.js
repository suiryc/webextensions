'use strict';

import { constants } from './constants.js';
import * as util from './util.js';
import * as http from './http.js';
// Import and expose ourself in scripts.
import * as unsafe from './unsafe.js';
import { settings } from './settings.js';


// Declare AsyncFunction for usage.
// Share declaration to limit code inspection warnings to the bare minimum.
export let _fn = async function () {}.constructor;

export class CodeExecutor {

  constructor(params) {
    let self = this;
    self.webext = params.webext;
    self.notifDefaults = params.notifDefaults;
    self.scriptName = params.name;
    // We will pass useful helpers automatically.
    // REMINDER: name must match with 'execute' code!
    self.argNames = params.args.concat(['constants', 'http', 'notif', 'unsafe', 'util', 'webext', 'settings']);
    if (params.code) {
      self.setup(params.code);
      return;
    }
    // We should have been given a setting, or setting branch.
    // We will listen to setting changes, unless code is expected to be executed
    // only once (caller should do it right after the instance is built).
    let setting = params.setting;
    if (setting.addListener) {
      // This is a setting: setup script and listen to changes.
      if (!params.once) setting.addListener(() => {
        self.setup(setting.getValue());
      });
      self.setup(setting.getValue());
      return;
    }
    // This is a setting branch: we expect to find 'script' and 'enabled'
    // sub-settings.
    if (!setting.inner.script) {
      self.getNotif().warn({
        title: 'Script code setup failed',
        msg: `Unhandled setting=<${setting.getKey()}>`
      });
      return;
    }
    let enabled = setting.inner.enabled;
    if (enabled) {
      // Setting that can switch on/off script.
      if (!params.once) enabled.addListener(() => {
        self.disabled = !enabled.getValue();
      });
      self.disabled = !enabled.getValue();
    }
    setting = setting.inner.script;
    if (!params.once) setting.addListener(() => {
      self.setup(setting.getValue());
    });
    self.setup(setting.getValue());
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
    let argValues = [];
    let notif = this.getNotif();
    // Pass useful helpers automatically.
    // REMINDER: name must match with 'constructor' code!
    args = Object.assign({
      constants,
      http,
      notif,
      unsafe,
      util,
      webext: this.webext,
      settings
    }, args);
    for (let arg of this.argNames) {
      argValues.push(args[arg]);
    }
    try {
      let r = await Promise.resolve(this.f.apply(null, argValues));
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
    return this.webext.getNotif(this.scriptName, this.notifDefaults);
  }

}

// Executes script code.
export async function executeCode(params) {
  let executor = new CodeExecutor(Object.assign({}, params, {args: Object.keys(params.args), once: true}));
  return await executor.execute(params.args);
}
