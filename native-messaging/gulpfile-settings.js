'use strict';

import os from 'os';
import path from 'path';


// Native application id
export const applicationId = 'suiryc.webext.native';
// WebExtension id and slug
export const extensionId = 'native-messaging@suiryc';
export const extensionSlug = 'ee8de43ee1af4bb68031';

// Windows settings
export const win32 = {
  // Application installation path
  appInstallPath: path.join('C:', 'Progs', 'webext-native-messaging'),
  // dl-mngr interpreter (binary to execute script)
  dlMngrInterpreter: 'pythonw.exe',
  // dl-mngr script
  dlMngrPath: path.join('C:', 'Progs', 'dl-mngr', 'dl-mngr.py')
};
// Linux settings
export const linux = {
  appInstallPath: path.join(os.homedir(), 'progs', 'webext-native-messaging'),
  dlMngrInterpreter: 'python',
  dlMngrPath: path.join(os.homedir(), 'progs', 'dl-mngr', 'dl-mngr.py')
};
