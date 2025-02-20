'use strict';

import gulp from 'gulp';
import os from 'os';
import glob from 'glob';
import path from 'path';
import fse from 'fs-extra';
import rename from 'gulp-rename';
import replace from 'gulp-replace';
import { fileURLToPath } from 'url';
import webpack from 'webpack';
import * as settingsRO from './gulpfile-settings.js';
import * as util from './app/src/util.js';


// Mimic CommonJS __filename and __dirname, so that it can be used in ESM too.
// See: https://stackoverflow.com/a/62892482
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


export const install = gulp.series(deployApp, installApp, buildExt_dev);
export const buildExt = buildExt_dev;
export const watch = gulp.series(install, watchChanges);
export default install;


// Enrich settings with constants ...
const extensionPath = 'extension';
let settings = Object.assign({
  appInstallScript: path.join('app', 'src', 'install.js'),
  appPaths: [
    // Note: for globs, path.posix is needed (\\ escapement conflict on Windows)
    path.posix.join('app', 'src', '*.js'),
    path.join('app', 'package.json')
  ],
  extensionTemplatedPaths: [
    path.join(extensionPath, 'manifest.json'),
    path.join(extensionPath, 'src', 'common', 'constants.js')
  ],
  excludedPaths: [
    path.join(extensionPath, '.mocharc.yaml'),
    path.join(extensionPath, 'babel.config.js')
  ]
}, settingsRO);
// ... and platform-dependent values.
switch (os.platform()) {
  case 'win32':
    Object.assign(settings, settings['win32']);
    break;

  default:
    Object.assign(settings, settings['linux']);
    break;
}

export function deployApp() {
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
  let dirname = path.dirname(p);
  let extname = path.extname(p);
  let basename = path.basename(p);
  return path.join(dirname, `${path.basename(p, extname)}-template${extname}`);
}

function getIgnoredFiles() {
  // Ignore:
  //  - templates
  //  - other files: mocha/babel configuration
  //  - source files: we generate bundles
  let excludedPaths = settings.excludedPaths.map(p => p.substring(extensionPath.length + 1));
  return settings.extensionTemplatedPaths.map(p => {
    return getTemplatePath(p).substring(extensionPath.length + 1);
  }).concat(excludedPaths).concat([
    'doc',
    'src'
  ]);
}

async function webpackBundle(mode) {
  let pathDist = path.join(extensionPath, 'dist');

  // Cleanup distribution path.
  await fse.remove(pathDist);

  let deferred = new util.Deferred();
  let webpackSettings = {
    mode: mode,
    entry: {
      'background': path.resolve(extensionPath, 'src', 'background', 'background.js'),
      'content-script': path.resolve(extensionPath, 'src', 'content-script', 'content-script.js'),
      'browser-action': path.resolve(extensionPath, 'src', 'browser-action', 'browser-action.js'),
      'options-ui': path.resolve(extensionPath, 'src', 'options-ui', 'options-ui.js')
    },
    output: {
      // Use a more recent (and non-legacy) hash function.
      // Needed with recent versions of Node to prevent an openssl error due to
      // the fact webpack (v4 and v5) default hash is not supported anymore.
      // See: https://github.com/webpack/webpack/issues/14532
      hashFunction: 'xxhash64',
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

async function _buildExt(webpackMode) {
  let fill = function(p) {
    let dirname = path.dirname(p);
    let basename = path.basename(p);
    let template = getTemplatePath(p);
    return gulp.src(template)
      .pipe(rename(basename))
      .pipe(replace('__EXTENSION_ID__', settings.extensionId))
      .pipe(replace('__EXTENSION_SLUG__', settings.extensionSlug))
      .pipe(replace('__APPLICATION_ID__', settings.applicationId))
      .pipe(gulp.dest(dirname));
  };
  await Promise.all(settings.extensionTemplatedPaths.map(async path => {
    await fill(path);
  }));

  await unitTestExt();
  await webpackBundle(webpackMode);
}

async function buildExt_dev() {
  await _buildExt('development');
}

async function buildExt_prod() {
  await _buildExt('production');
}

export async function unitTestExt() {
  let deferred = new util.Deferred();
  glob(path.posix.join('src', 'unit-test', '**', '*.js'), { cwd: extensionPath }, (err, files) => {
    if (err) deferred.reject(err);
    else deferred.resolve(files);
  });
  let files = await deferred;
  await util.spawn('node',
    [path.join(__dirname, 'node_modules', 'mocha', 'bin', 'mocha')].concat(files),
    { cwd: extensionPath });
}

export async function packageExt() {
  await buildExt_prod();

  let ignoredFiles = getIgnoredFiles();
  console.log('Ignoring:', ignoredFiles);
  await util.spawn('web-ext',
    ['build', '--overwrite-dest', '--ignore-files'].concat(ignoredFiles),
    { cwd: extensionPath });
}

export async function signExt() {
  await buildExt_prod();
  let ignoredFiles = getIgnoredFiles();
  console.log('Ignoring:', ignoredFiles);
  await util.spawn('web-ext',
    ['sign', '--api-key', process.env.WEBEXT_API_KEY, '--api-secret', process.env.WEBEXT_API_SECRET,
      '--channel', 'unlisted',
      '--ignore-files'].concat(ignoredFiles),
    { cwd: extensionPath });
}

function watchChanges() {
  gulp.watch(settings.appPaths.concat([`!${settings.appInstallScript}`]), deployApp);
  gulp.watch(settings.appInstallScript, install);
  let extensionTemplatePaths = settings.extensionTemplatedPaths.map(p => getTemplatePath(p));
  // Follow changes in sources and templates.
  // Excluded templated files (generated from templates).
  // There is also no need to follow resources, since they are directly pointed
  // to in manifest.
  let extensionPaths = [
    path.posix.join(extensionPath, 'src', '**', '*')
  ].concat(extensionTemplatePaths).concat(settings.extensionTemplatedPaths.map(p => `!${p}`));
  gulp.watch(extensionPaths, buildExt_dev);
}
