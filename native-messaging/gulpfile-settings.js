'use strict';

const os = require('os');
const path = require('path');


module.exports = {
  // Native application id
  applicationId: 'suiryc.webext.native',
  // WebExtension id and slug
  extensionId: 'native-messaging@suiryc',
  extensionSlug: 'ee8de43ee1af4bb68031',

  // Windows settings
  'win32': {
    // Application installation path
    appInstallPath: path.join('C:', 'Progs', 'webext-native-messaging'),
    // dl-mngr interpreter (binary to execute script)
    dlMngrInterpreter: 'pythonw.exe',
    // dl-mngr script
    dlMngrPath: path.join('C:', 'Progs', 'dl-mngr', 'dl-mngr.py')
  },
  // Linux settings
  'linux': {
    appInstallPath: path.join(os.homedir(), 'progs', 'webext-native-messaging'),
    dlMngrInterpreter: 'python',
    dlMngrPath: path.join(os.homedir(), 'progs', 'dl-mngr', 'dl-mngr.py')
  }
};
