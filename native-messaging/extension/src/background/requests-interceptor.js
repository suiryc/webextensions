'use strict';

import { settings } from '../common/settings.js';
import * as unsafe from '../common/unsafe.js';


export class RequestsInterceptor {

  constructor(webext) {
    this.setup(webext);
  }

  async setup(webext) {
    var self = this;
    self.listeners = {};
    // Wait for settings to be loaded (and start interception when applicable).
    // Not strictly necessary, but 'better' because we listen to more than one
    // setting change (and would probably remove/add listener twice while
    // settings are loaded).
    await settings.ready;
    // Setup interception scripts, and listen to changes in settings.
    // Note: we need listeners to remain the same over time, so that we can
    // unlisten.
    ['onBeforeSendHeaders'].forEach(stage => {
      var setting = settings.intercept.webRequest[stage].inner.script;
      var scriptExecutor = webext.getExtensionProperty({
        key: setting.getKey(),
        create: webext => new unsafe.CodeExecutor({webext, name: `webRequest.${stage}`, args: ['params'], setting})
      });
      self.listeners[stage] = function(request) { return scriptExecutor.execute({params:{request}}); };
      ['enabled', 'requestTypes'].forEach(k => {
        settings.inner.perKey[`intercept.webRequest.${stage}.${k}`].addListener(() => {
          self.setupInterception([stage]);
        });
      });
    });
    self.setupInterception();
  }

  setupInterception(stages) {
    var self = this;
    (stages || ['onBeforeSendHeaders']).forEach(stage => {
      // Note: we are called because something changed for this stage.
      // Either enabling/disabling, or request types to intercept.
      // In any case, we will need to unlisten: either because we are not
      // intercepting anymore, or because we are intercepting other types of
      // requests.
      var listener = self.listeners[stage];
      var wstage = browser.webRequest[stage];
      var intercepting = wstage.hasListener(listener);
      if (wstage.hasListener(listener)) wstage.removeListener(listener);
      if (settings.inner.perKey[`intercept.webRequest.${stage}.enabled`].value) {
        var webRequestFilter = { urls: ['<all_urls>'] };
        var requestTypes = settings.inner.perKey[`intercept.webRequest.${stage}.requestTypes`].getValues();
        if (requestTypes.length) webRequestFilter.types = requestTypes;
        wstage.addListener(listener,
          webRequestFilter,
          ['requestHeaders','blocking']
        );
      }
    });
  }

}
