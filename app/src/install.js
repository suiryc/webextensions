'use strict';

// TODO: also create 'uninstall.js'

const fs = require('fs');
const os = require('os');
const path = require('path');
const { promisify } = require('util');
const util = require('./util');

const accessAsync = promisify(fs.access);
const chmodAsync = promisify(fs.chmod);
const mkdirAsync = promisify(fs.mkdir);
const writeFileAsync = promisify(fs.writeFile);

const APPLICATION_ID = 'suiryc.webext.native';
const NPM_MODULES = ['uuid'];
const EXTENSION_ID = 'native-messaging@suiryc';


// Creates folder hierarchy
function mkdir_p(dir, mode) {
  mode = mode || 0o777;

  // Check (and create) folder hierarchy from root to leaf
  function loop(dir, parts) {
    // Leave if we are done
    if (!parts.length) return;
    // Check next (sub-)folder
    dir = path.join(dir, parts.shift());
    return accessAsync(dir, fs.constants.F_OK).catch(err => {
      if (err.code !== 'ENOENT') {
        // Cannot access/create folder
        throw err;
      }
      // Folder does not exist: create it
      return mkdirAsync(dir, mode).then(() => {
        // Folder created
        return loop(dir, parts);
      });
    }).then(() => {
      // Folder is accessible
      return loop(dir, parts);
    });
  }

  // Test whether folder exists, and create hierarchy otherwise
  return accessAsync(dir, fs.constants.F_OK).catch(err => {
    if (err.code !== 'ENOENT') {
      // Cannot access/create folder
      throw err;
    }
    // Folder does not exist: create it
    var parts = dir.split(path.sep);
    var root = parts.shift();
    return loop(root + path.sep, parts);
  });
}

// Creates manifest file
function createManifest(dir, filename, command) {
  var manifestPath = path.join(dir, filename);
  console.log('');
  console.log('>> Creating manifest');
  console.log('>>> File: %s', manifestPath);
  console.log('>>> Command: %s', command);
  return mkdir_p(dir).then(() => {
    writeFileAsync(manifestPath, `{
  "name": "${APPLICATION_ID}",
  "description": "WebExtension native application",
  "path": "${command}",
  "type": "stdio",
  "allowed_extensions": ["${EXTENSION_ID}"]
}`);
  });
}

var appFolder = process.cwd();
var manifestFolder = appFolder;
var manifestFile = 'manifest-firefox.json';
var manifestCommand;
var nodeCommand = process.argv[0];
var appCommand;

var f = Promise.resolve();
console.log('');
console.log('>> Creating application');
console.log(`>>> Nodejs command: ${nodeCommand}`);
// See: https://developer.mozilla.org/en-US/Add-ons/WebExtensions/Native_manifests#Manifest_location
switch (os.platform()) {
  case 'linux':
    // Manifest files are stored in ${HOME}/.mozilla/native-messaging-hosts and named ${APPLICATION_ID}.json
    // We point to the actual application script outside this folder by absolute path.
    manifestFolder = path.join(process.env.HOME, '.mozilla/native-messaging-hosts');
    manifestFile = `${APPLICATION_ID}.json`;
    appCommand = 'run.sh';
    manifestCommand = path.join(appFolder, appCommand);
    console.log(`>>> Application: ${appCommand}`);
    var appCommandContent = `#!/bin/bash\n\n${nodeCommand} app.js\n`;
    f = writeFileAsync(appCommand, appCommandContent).then(() => {
      // Script needs to be executable
      return chmodAsync(appCommand, 0o755);
    });
    break;

  case 'win32':
    // HKCU\SOFTWARE\Mozilla\NativeMessagingHosts\${APPLICATION_ID} registry enttry points to manifest file
    // (could be anywhere, with any name)
    // We store it alongside the application script.
    manifestCommand = appCommand = 'run.cmd';
    console.log(`>>> Application: ${appCommand}`);
    var appCommandContent = `@echo off\r\n\r\n"${nodeCommand}" "%~dp0app.js"\r\n`;
    f = writeFileAsync(appCommand, appCommandContent).then(() => {
      console.log('');
      console.log('>> Creating Firefox registry entry');
      return util.spawn('REG', ['ADD', `HKCU\\SOFTWARE\\Mozilla\\NativeMessagingHosts\\${APPLICATION_ID}`, '/ve', '/t', 'REG_SZ', '/d', `${appFolder}\\${manifestFile}`, '/f']);
    });
    break;

  default:
    throw Error(`Unhandled platform=<${os.platform()}>`)
    break;
}

f.then(() => {
  console.log('');
  console.log('>> Installing NPM modules');
  // Note: unless 'shell: true' is used, the actual command to execute npm is
  // 'npm.cmd' in windows.
  // See: https://stackoverflow.com/a/43285131
  return util.spawn('npm', ['install'].concat(NPM_MODULES));
}).then(() => {
  return createManifest(manifestFolder, manifestFile, manifestCommand)
}).then(() => {
  console.log('');
  console.log('>> Declared native application for Firefox')
}).catch(error => {
  console.error('');
  console.error('Failed to install: %o', error);
});
