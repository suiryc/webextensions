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
  paths: ['app/src/*.js']
};

switch (os.platform()) {
  case 'win32':
    appSettings.installPath = 'C:\\Progs\\webext-native-messaging';
    break;

  default:
    // See: https://stackoverflow.com/a/9081436
    appSettings.installPath = path.join(os.homedir(), 'progs', 'webext-native-messaging')
    break;
}

function deployApp() {
  return gulp.src(appSettings.paths)
    .pipe(gulp.dest(appSettings.installPath));
}

function installApp() {
  return util.spawn('node', ['install.js'], { cwd: appSettings.installPath });
}

function watch() {
  gulp.watch(appSettings.paths.concat([`!${appSettings.installScript}`]), deployApp);
  gulp.watch(appSettings.installScript, install);
}
