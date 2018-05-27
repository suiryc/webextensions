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
  paths: ['app/src/*.js'],
  installPath: path.join(process.env.HOME, 'progs', 'webext-native-messaging')
};

if (os.platform() == 'win32') appSettings.installPath = 'C:\\Progs\\webext-native-messaging';

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
