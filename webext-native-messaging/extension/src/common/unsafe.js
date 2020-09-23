'use strict';

import * as util from './util.js';


// Executes script code.
export async function executeCode(webext, label, params, code) {
  if ((code === undefined) || (code === null) || (code.trim() === '')) return {};
  try {
    var funcArgs = [];
    var funcValues = [];
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
