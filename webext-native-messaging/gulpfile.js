'use strict';

const gulp = require('gulp');
const os = require('os');
const path = require('path');
const rename = require('gulp-rename');
const replace = require('gulp-replace');
var settings = require('./gulpfile-settings');
const util = require('./app/src/util');


exports.deployApp = deployApp;
exports.install = gulp.series(deployApp, installApp, buildExt);
exports.buildExt = buildExt;
exports.signExt = signExt;
exports.watch = gulp.series(exports.install, watch);
exports.default = exports.install;


// Enrich settings with constants ...
const extensionPath = 'extension';
settings = Object.assign({
  appInstallScript: 'app/src/install.js',
  appPaths: ['app/src/*.js', 'app/package.json'],
  extensionTemplatePaths: [`${extensionPath}/manifest.json`, `${extensionPath}/src/constants.js`]
}, settings);
// ... and platform-dependent values.
switch (os.platform()) {
  case 'win32':
    Object.assign(settings, settings['win32']);
    break;

  default:
    Object.assign(settings, settings['linux']);
    break;
}

function deployApp() {
  return gulp.src(settings.appPaths)
    .pipe(gulp.dest(settings.appInstallPath));
}

function installApp() {
  // First get yargs (necessary for install script)
  // Note: unless 'shell: true' is used, the actual command to execute npm is
  // 'npm.cmd' in windows.
  // See: https://stackoverflow.com/a/43285131
  console.log('');
  console.log('>> Installing NPM modules');
  return util.spawn('npm', ['install'], { cwd: settings.appInstallPath }).then(() => {
    return util.spawn('node', ['install.js',
      '--application-id', settings.applicationId, '--extension-id', settings.extensionId,
      '--dl-mngr-interpreter', settings.dlMngrInterpreter, '--dl-mngr-path', settings.dlMngrPath],
      { cwd: settings.appInstallPath });
  });
}

function getTemplatePath(p) {
  var dirname = path.dirname(p);
  var extname = path.extname(p);
  var basename = path.basename(p);
  return path.join(dirname, `${path.basename(p, extname)}-template${extname}`);
}

function getIgnoredFiles() {
  return settings.extensionTemplatePaths.map(p => {
    return getTemplatePath(p).substring(extensionPath.length + 1);
  });
}

async function buildExt() {
  var fill = function(p) {
    var dirname = path.dirname(p);
    var basename = path.basename(p);
    var template = getTemplatePath(p);
    return gulp.src(template)
      .pipe(rename(basename))
      .pipe(replace('__EXTENSION_ID__', settings.extensionId))
      .pipe(replace('__APPLICATION_ID__', settings.applicationId))
      .pipe(gulp.dest(dirname));
  };
  await Promise.all(settings.extensionTemplatePaths.map(async path => {
    await fill(path);
  }));
}

async function signExt() {
  await buildExt();
  var ignoredFiles = getIgnoredFiles();
  console.log('Ignoring:', ignoredFiles);
  await util.spawn('web-ext',
    ['sign', '--api-key', process.env.WEBEXT_API_KEY, '--api-secret', process.env.WEBEXT_API_SECRET,
      '--ignore-files'].concat(ignoredFiles),
    { cwd: extensionPath });
}

function watch() {
  gulp.watch(settings.appPaths.concat([`!${settings.appInstallScript}`]), deployApp);
  gulp.watch(settings.appInstallScript, exports.install);
  var extensionTemplatePaths = settings.extensionTemplatePaths.map(p => getTemplatePath(p));
  gulp.watch(extensionTemplatePaths, buildExt);
}
