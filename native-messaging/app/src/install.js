'use strict';

// TODO: also create 'uninstall.js'

import fse from 'fs-extra';
import os from 'os';
import path from 'path';
import * as util from './util.js';
import yargs from 'yargs';


// Creates manifest file
function createManifest(dir, filename, command) {
  let manifestPath = path.join(dir, filename);
  console.log('');
  console.log('>> Creating manifest');
  console.log(`>>> File: ${manifestPath}`);
  console.log(`>>> Command: ${command}`);
  return fse.mkdirp(dir).then(() => {
    fse.writeFile(manifestPath, `{
  "name": "${params.applicationId}",
  "description": "WebExtension native application",
  "path": "${command}",
  "type": "stdio",
  "allowed_extensions": ["${params.extensionId}"]
}`);
  });
}

let appFolder = process.cwd();
let manifestFolder = appFolder;
let manifestFile = 'manifest-firefox.json';
let manifestCommand;
let nodeCommand = process.argv[0];
let params = yargs.argv;
let appCommand;

// We expect the following CLI parameters:
//  --application-id: the native application id
//  --extension-id: the (authorized) WebExtension id
//  --dl-mngr-interpreter: the binary to execute dl-mngr script
//  --dl-mngr-path: the dl-mngr script
function nonEmpty(s) {
  return (typeof(s) == 'string') && s.trim().length;
}
if (!nonEmpty(params.applicationId)) {
  console.error('Missing --application-id CLI option');
  process.exit(1);
}
if (!nonEmpty(params.extensionId)) {
  console.error('Missing --extension-id CLI option');
  process.exit(1);
}
if (!nonEmpty(params.dlMngrInterpreter)) {
  console.error('Missing --dl-mngr-interpreter CLI option');
  process.exit(1);
}
if (!nonEmpty(params.dlMngrPath)) {
  console.error('Missing --dl-mngr-path CLI option');
  process.exit(1);
}

let f = Promise.resolve();
console.log('');
console.log('>> Creating application');
console.log(`>>> Nodejs command: ${nodeCommand}`);
// See: https://developer.mozilla.org/en-US/Add-ons/WebExtensions/Native_manifests#Manifest_location
switch (os.platform()) {
  case 'linux': {
    // Manifest files are stored in ${HOME}/.mozilla/native-messaging-hosts and named ${params.applicationId}.json
    // We point to the actual application script outside this folder by absolute path.
    manifestFolder = path.join(process.env.HOME, '.mozilla/native-messaging-hosts');
    manifestFile = `${params.applicationId}.json`;
    appCommand = 'run.sh';
    manifestCommand = path.join(appFolder, appCommand);
    console.log(`>>> Application: ${appCommand}`);
    let appCommandContent = `#!/bin/bash\n\n${nodeCommand} app.js\n`;
    f = fse.writeFile(appCommand, appCommandContent).then(() => {
      // Script needs to be executable
      return fse.chmod(appCommand, 0o755);
    });
    break;
  }

  case 'win32': {
    // HKCU\SOFTWARE\Mozilla\NativeMessagingHosts\${params.applicationId} registry
    // entry points to manifest file (could be anywhere, with any name).
    // We store it alongside the application script.
    manifestCommand = appCommand = 'run.cmd';
    console.log(`>>> Application: ${appCommand}`);
    let appCommandContent = `@echo off\r\n\r\n"${nodeCommand}" "%~dp0app.js"\r\n`;
    f = fse.writeFile(appCommand, appCommandContent).then(() => {
      console.log('');
      console.log('>> Creating Firefox registry entry');
      return util.spawn('REG', ['ADD', `HKCU\\SOFTWARE\\Mozilla\\NativeMessagingHosts\\${params.applicationId}`, '/ve', '/t', 'REG_SZ', '/d', `${appFolder}\\${manifestFile}`, '/f']);
    });
    break;
  }

  default:
    throw Error(`Unhandled platform=<${os.platform()}>`)
    break;
}

f.then(() => {
  console.log('');
  console.log('>> Creating settings.js');
  let settingsContent = `'use strict';

export const dlMngrInterpreter = ${JSON.stringify(params.dlMngrInterpreter)};
export const dlMngrPath = ${JSON.stringify(params.dlMngrPath)};
`;
  return fse.writeFile('settings.js', settingsContent);
}).then(() => {
  return createManifest(manifestFolder, manifestFile, manifestCommand)
}).then(() => {
  console.log('');
  console.log('>> Declared native application for Firefox')
}).catch(error => {
  console.error('');
  console.error('Failed to install: %o', error);
});
