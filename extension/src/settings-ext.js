'use strict';


// Create settings (auto-registered in 'settings').
new ExtensionBooleanSetting('debug', false);
new ExtensionBooleanSetting('interceptDownloads', true);
new ExtensionBooleanSetting('interceptRequests', true);
new ExtensionTextSetting('interceptSize', 10 * 1024 * 1024);
new ExtensionBooleanSetting('notifyIntercept', true);
new ExtensionTextSetting('notifyTtl', 4000);
