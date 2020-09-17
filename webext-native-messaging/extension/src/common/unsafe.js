'use strict';

import * as util from './util.js';


// Executes script code.
export async function executeCode(webext, label, params, code) {
  if ((code === undefined) || (code === null) || (code.trim() === '')) return {};
  try {
    var toExecute = new Function('params', code);
    var r = await Promise.resolve(toExecute(params)).catch(error => {
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
