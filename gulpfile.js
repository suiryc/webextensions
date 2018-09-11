'use strict';

const gulp = require('gulp');
const os = require('os');
const path = require('path');
const util = require('./app/src/util');


var install = gulp.series(deployApp, installApp);

gulp.task('default', install);
gulp.task('deploy', deployApp);
gulp.task('install', install);
gulp.task('watch', watch);


var appSettings = {
  installScript: 'app/src/install.js',
  dlMngrInterpreter: undefined,
  dlMngrPath: undefined,
  paths: ['app/src/*.js']
};

switch (os.platform()) {
  case 'win32':
    appSettings.installPath = path.join('C:', 'Progs', 'webext-native-messaging');
    appSettings.dlMngrInterpreter = 'pythonw.exe';
    appSettings.dlMngrPath = path.join('C:', 'Progs', 'dl-mngr', 'dl-mngr.py');
    break;

  default:
    // See: https://stackoverflow.com/a/9081436
    appSettings.installPath = path.join(os.homedir(), 'progs', 'webext-native-messaging');
    appSettings.dlMngrInterpreter = 'python';
    appSettings.dlMngrPath = path.join(os.homedir(), 'progs', 'dl-mngr', 'dl-mngr.py');
    break;
}

function deployApp() {
  return gulp.src(appSettings.paths)
    .pipe(gulp.dest(appSettings.installPath));
}

function installApp() {
  // First get yargs (necessary for install script)
  return util.spawn('npm', ['install', 'yargs'], { cwd: appSettings.installPath }).then(() => {
    return util.spawn('node', ['install.js', '--dl-mngr-interpreter', appSettings.dlMngrInterpreter, '--dl-mngr-path', appSettings.dlMngrPath],
      { cwd: appSettings.installPath });
  });
}

function watch() {
  gulp.watch(appSettings.paths.concat([`!${appSettings.installScript}`]), deployApp);
  gulp.watch(appSettings.installScript, install);
}
