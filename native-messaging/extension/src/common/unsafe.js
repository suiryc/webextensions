'use strict';

import * as util from './util.js';
import * as unsafe from './unsafe.js';


// Executes script code.
export async function executeCode(webext, label, params, code) {
  if ((code === undefined) || (code === null) || (code.trim() === '')) return {};
  try {
    var funcArgs = [];
    var funcValues = [];
    // Create a logger relying on notifications.
    var log = {};
    ['info', 'warn', 'error'].forEach(level => {
      log[level] = function(details, error) {
        // Prepare details.
        if (typeof(details) === 'object') details = Object.assign({}, details, {level: level});
        else details = {level: level, message: details, error: error};
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
        if (!webext.isBackground && details.error) details.error = util.formatObject(details.error);
        util.extNotification(webext, details);
      };
    });
    log.warning = log.warn;
    // Pass useful helpers automatically.
    params = Object.assign({
      log: log,
      unsafe: unsafe,
      util: util,
      webext: webext
    }, params);
    for (var [key, value] of Object.entries(params)) {
      funcArgs.push(key);
      funcValues.push(value);
    }
    funcArgs.push(code);
    var toExecute = Function.apply(null, funcArgs);
    var r = await Promise.resolve(toExecute.apply(null, funcValues)).catch(error => {
      util.extNotification(webext, {
        title: 'Script execution failed',
        level: 'error',
        message: `Script: ${label}`,
        error: util.formatObject(error)
      });
      return {};
    });
    return r || {};
  } catch (error) {
    util.extNotification(webext, {
      title: 'Script setup failed',
      level: 'error',
      message: `Script: ${label}`,
      error: util.formatObject(error)
    });
  }
  return {};
}
