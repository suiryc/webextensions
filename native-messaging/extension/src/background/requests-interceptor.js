'use strict';

import { settings } from '../common/settings.js';
import * as unsafe from '../common/unsafe.js';


export class RequestsInterceptor {

  constructor(webext) {
    var self = this;
    self.listeners = {};
    // Setup interception scripts, and listen to changes in settings.
    // Note: we need listeners to remain the same over time, so that we can
    // unlisten.
    ['onBeforeSendHeaders'].forEach(stage => {
      var scriptKey = `intercept.webRequest.${stage}.script`;
      var scriptExecutor = webext.getExtensionProperty({
        key: scriptKey,
        create: webext => new unsafe.CodeExecutor(webext, `webRequest.${stage}`, ['params'], settings.inner.perKey[scriptKey])
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
