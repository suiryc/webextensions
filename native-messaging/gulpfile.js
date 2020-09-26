'use strict';

const gulp = require('gulp');
const os = require('os');
const path = require('path');
const fse = require('fs-extra');
const rename = require('gulp-rename');
const replace = require('gulp-replace');
const webpack = require('webpack');
var settings = require('./gulpfile-settings');
const util = require('./app/src/util');


exports.deployApp = deployApp;
exports.install = gulp.series(deployApp, installApp, buildExt_dev);
exports.buildExt = buildExt_dev;
exports.packageExt = packageExt;
exports.signExt = signExt;
exports.watch = gulp.series(exports.install, watch);
exports.default = exports.install;


// Enrich settings with constants ...
const extensionPath = 'extension';
settings = Object.assign({
  appInstallScript: path.join('app', 'src', 'install.js'),
  appPaths: [
    // Note: for globs, path.posix is needed (\\ escapement conflict on Windows)
    path.posix.join('app', 'src', '*.js'),
    path.join('app', 'package.json')
  ],
  extensionTemplatedPaths: [
    path.join(extensionPath, 'manifest.json'),
    path.join(extensionPath, 'src', 'common', 'constants.js')
  ]
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
  // We wish to copy files without keeping the hierarchy.
  return gulp.src(settings.appPaths)
    .pipe(rename({ dirname: '' }))
    .pipe(gulp.dest(settings.appInstallPath));
}

function installApp() {
  // First get yargs (necessary for install script)
  // Note: unless 'shell: true' is used, the actual command to execute npm/yarn
  // is 'npm.cmd'/'yarn.cmd' in windows.
  // See: https://stackoverflow.com/a/43285131
  // Use yarn instead of npm, which is usually faster.
  console.log('');
  console.log('>> Installing NPM modules');
  return util.spawn('yarn', ['install'], { cwd: settings.appInstallPath }).then(() => {
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
  // Ignore:
  //  - templates
  //  - source file: we generate bundles
  return settings.extensionTemplatedPaths.map(p => {
    return getTemplatePath(p).substring(extensionPath.length + 1);
  }).concat([
    'src'
  ]);
}

async function webpackBundle(mode) {
  var pathDist = path.join(extensionPath, 'dist');

  // Cleanup distribution path.
  await fse.remove(pathDist);

  var deferred = new util.Deferred();
  var webpackSettings = {
    mode: mode,
    entry: {
      'background': path.resolve(extensionPath, 'src', 'background', 'background.js'),
      'content-script-tw': path.resolve(extensionPath, 'src', 'content-script', 'content-script-tw.js'),
      'content-script-video': path.resolve(extensionPath, 'src', 'content-script', 'content-script-video.js'),
      'browser-action': path.resolve(extensionPath, 'src', 'browser-action', 'browser-action.js'),
      'options-ui': path.resolve(extensionPath, 'src', 'options-ui', 'options-ui.js')
    },
    output: {
      // an absolute path is required for output.path
      path: path.join(__dirname, pathDist),
      filename: '[name].bundle.js'
    },
    // Embed source map, even for production (for easier debugging if needed)
    devtool: 'source-map'
  };
  webpack(webpackSettings, (err, stats) => {
    if (stats) console.log(stats.toString({ colors: true }));
    if (err) {
      deferred.reject(err);
      return;
    }
    if (stats.hasErrors()) {
      deferred.reject('webpack compilation failed');
      return;
    }

    deferred.resolve();
  });
  await deferred;
}

async function buildExt(webpackMode) {
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
  await Promise.all(settings.extensionTemplatedPaths.map(async path => {
    await fill(path);
  }));

  await webpackBundle(webpackMode);
}

async function buildExt_dev() {
  await buildExt('development');
}

async function buildExt_prod() {
  await buildExt('production');
}

async function packageExt() {
  await buildExt_prod();

  var ignoredFiles = getIgnoredFiles();
  console.log('Ignoring:', ignoredFiles);
  await util.spawn('web-ext',
    ['build', '--overwrite-dest', '--ignore-files'].concat(ignoredFiles),
    { cwd: extensionPath });
}

async function signExt() {
  await buildExt_prod();
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
  var extensionTemplatePaths = settings.extensionTemplatedPaths.map(p => getTemplatePath(p));
  // Follow changes in sources and templates.
  // Excluded templated files (generated from templates).
  // There is also no need to follow resources, since they are directly pointed
  // to in manifest.
  var extensionPaths = [
    path.posix.join(extensionPath, 'src', '**', '*')
  ].concat(extensionTemplatePaths).concat(settings.extensionTemplatedPaths.map(p => `!${p}`));
  gulp.watch(extensionPaths, buildExt_dev);
}
