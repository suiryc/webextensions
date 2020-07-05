'use strict';

import { constants } from './constants.js';
import * as util from './util.js';
import { settings } from '../common/settings.js';


// Extension messages handler.
export class WebExtension {

  constructor(params) {
    var self = this;
    if (params.target == null) delete(params.target);
    self.params = params;
    // Notes:
    // When the listener callback returns a Promise, it is sent back to the
    // sender. When the listener callback returns a value, the sender gets
    // an empty response.
    //
    // More than one listener can be added.
    // Caller is expected to manage whether to use one listener and dispatch
    // responses, or add multiple listeners for each dedicated feature.
    browser.runtime.onMessage.addListener((msg, sender) => {
      // Ignore message when applicable.
      if (!self.isTarget(msg)) {
        if (settings.debug.misc) console.log('Ignore message %o: receiver=<%s> does not match target=<%s>', msg, self.params.target, msg.target);
        return;
      }
      // Handle 'echo' message internally.
      if (msg.kind === constants.KIND_ECHO) {
        return Promise.resolve({
          msg: msg,
          sender: sender
        });
      }
      var r;
      // Enforce Promise, so that we handle both synchronous/asynchronous reply.
      try {
        r = Promise.resolve(self.params.onMessage(self, msg, sender));
      } catch (error) {
        r = Promise.reject(error);
      }
      // Sender only handle/expect success Promise: failure is given through
      // 'error' field when applicable.
      r = r.catch(error => {
        console.error('Could not handle sender %o message %o: %o', sender, msg, error);
        // Format object: pure Errors are empty when sent.
        return {error: util.formatObject(error)};
      });
      return r;
    });
  }

  isTarget(msg) {
    if (msg.target == null) delete(msg.target);
    return (this.params.target === undefined) || (msg.target === undefined) || (msg.target == this.params.target);
  }

  sendMessage(msg) {
    // Notes:
    // Sends a message to all extensions pages currently listening, except the
    // sender and content scripts.
    // If no page is listening (e.g. if browser action or options pages are not
    // running right now), an error is triggered:
    //  Could not establish connection. Receiving end does not exist.
    // In nominal cases, to prevent this we would need to detect when pages are
    // running and not send message if no one is listening; we could even check
    // if any msg.target is running.
    // But since we don't use intensivel messaging in such cases, we can do with
    // a few log errors for now.
    return browser.runtime.sendMessage(msg);
  }

  sendTabMessage(tabId, msg, options) {
    return browser.tabs.sendMessage(tabId, msg, options);
  }

}

// Kind of native message embedding fragments
// Notes:
// See: https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging
// "The maximum size of a single message from the application is 1 MB."
// "The maximum size of a message sent to the application is 4 GB."
//
// For our usage, we thus post message as-is to the application, and handle
// possible fragments from what is received the application.
// As we, the extension, only need to handle the reception of fragments, we
// can do so by only checking two of the three kinds of fragments:
//  - 'start': first fragment; otherwise we concatenate from previous fragments
//  - 'cont': we are not done yet
// And we don't need to declare/use the 'end' fragment kind, as we infer it if
// a fragment is not 'start' nor 'cont'.
const FRAGMENT_KIND_START = 'start';
const FRAGMENT_KIND_CONT = 'cont';
//const FRAGMENT_KIND_END = 'end';

// Native application messages handler.
export class NativeApplication {

  constructor(appId, handlers) {
    this.appId = appId;
    this.cnx = undefined;
    this.handlers = handlers;
    this.requests = {};
    this.fragments = {};
    this.idleId = undefined;
    this.lastJanitoring = util.getTimestamp();
    if (handlers.onMessage === undefined) {
      throw new Error('Native application client must have an onMessage handler');
    }
  }

  connect() {
    if (this.cnx !== undefined) return;
    try {
      this.cnx = browser.runtime.connectNative(this.appId);
    } catch (error) {
      console.error('Failed to connect to native application %s: %o', this.appdId, error);
      throw error;
    }
    this.cnx.onDisconnect.addListener(this.onDisconnect.bind(this));
    this.cnx.onMessage.addListener(this.onMessage.bind(this));
    this.lastActivity = util.getTimestamp();
    this.scheduleIdleCheck();
  }

  disconnect() {
    if (this.cnx === undefined) return;
    this.cnx.disconnect();
    this.cnx = undefined;
  }

  // Posts message without needing to get the reply.
  // Takes care of (re)connecting if needed.
  postMessage(msg) {
    this.connect();
    this.cnx.postMessage(msg);
    this.lastActivity = util.getTimestamp();
  }

  // Posts request and return reply through Promise.
  postRequest(msg, timeout) {
    var self = this;
    // Get a unique - non-used - id
    var correlationId;
    do {
      correlationId = util.uuidv4();
    } while(self.requests[correlationId] !== undefined);
    msg.correlationId = correlationId;

    // Post message
    self.postMessage(msg);

    // Setup response handling
    if (timeout === undefined) timeout = constants.NATIVE_RESPONSE_TIMEOUT;
    var promise = new util.Deferred().promise;
    self.requests[correlationId] = promise;
    return util.promiseThen(util.promiseOrTimeout(promise, timeout), () => {
      // Automatic cleanup of request
      delete(self.requests[correlationId]);
    });
  }

  onDisconnect(cnx) {
    var self = this;
    if ((self.cnx !== undefined) && (cnx !== self.cnx)) {
      // This is not our connection; should not happen
      console.warn('Received unknown native application %s connection disconnection: %o', nativeApp.appId, cnx.error);
      return;
    }
    var error = undefined;
    if (self.cnx !== undefined) {
      error = cnx.error;
      console.warn('Native application %s disconnected: %o', nativeApp.appId, cnx.error);
    }
    // else: we asked to disconnect
    self.cnx = undefined;
    self.fragments = {};
    for (var promise of Object.values(self.requests)) {
      var msg = 'Native application disconnected';
      if (error !== undefined) msg += ' with error: ' + util.formatObject(error);
      promise.reject(msg);
    }
    self.requests = {};
    if (self.handlers.onDisconnect !== undefined) {
      util.defer.then(() => self.handlers.onDisconnect(self));
    }
  }

  onMessage(msg) {
    var self = this;
    self.lastActivity = util.getTimestamp();
    if (msg.fragment !== undefined) {
      self.addFragment(msg);
    } else {
      var correlationId = msg.correlationId;
      var callback = true;
      if (correlationId !== undefined) {
        var promise = self.requests[correlationId];
        if (promise !== undefined) {
          // Note: request will be automatically removed upon resolving the
          // associated promise.
          delete(msg.correlationId);
          // We either expect a reply in the 'reply' field, or an error in the
          // 'error' field. For simplicity, we don't transform an error into a
          // failed Promise, but let caller check whether this in an error
          // through the field.
          if (msg.reply !== undefined) promise.resolve(msg.reply);
          else promise.resolve(msg);
          callback = false;
        }
      }
      if (callback) {
        util.defer.then(() => self.handlers.onMessage(self, msg));
      }
    }
    self.janitoring();
  }

  addFragment(msg) {
    var fragmentKind = msg.fragment;
    var correlationId = msg.correlationId;

    if (correlationId === undefined) {
      console.warn('Dropping message %o: missing correlationId', msg)
      return;
    }

    var previousFragment = this.fragments[correlationId];
    if (previousFragment === undefined) {
      if (fragmentKind === FRAGMENT_KIND_START) {
        // First fragment
        msg.msgCreationTime = util.getTimestamp();
        this.fragments[correlationId] = msg;
      } else {
        console.warn('Dropping message %o: missing fragment start', msg);
      }
      return;
    }

    if (fragmentKind === FRAGMENT_KIND_START) {
      console.warn('Dropping incomplete message %o: received new fragment start', previousFragment);
      this.fragments[correlationId] = msg;
      return;
    }

    delete(previousFragment.fragment);
    previousFragment.content = (previousFragment.content || '') + (msg.content || '');
    previousFragment.msgCreationTime = util.getTimestamp();
    if (fragmentKind !== FRAGMENT_KIND_CONT) {
      // There is no need to enforce it: we suppose we received a
      // FRAGMENT_KIND_END fragment, which is the last fragment.
      delete(this.fragments[correlationId]);
      this.onMessage(JSON.parse(previousFragment.content));
    }
    // else: fragment continuation already processed
  }

  idleCheck() {
    this.idleId = undefined;
    // Re-schedule if idle not yet reached
    var remaining = constants.IDLE_TIMEOUT - (util.getTimestamp() - this.lastActivity);
    if (remaining > 0) return this.scheduleIdleCheck(remaining + 1000);
    // Then get rid of old fragments if any
    if (this.fragments.length > 0) this.janitoring();
    // Re-schedule if there are pending requests/fragments
    if ((this.fragments.length > 0) || (this.requests.length > 0)) return this.scheduleIdleCheck(1000);
    console.log('Extension %s idle timeout', constants.EXTENSION_ID);
    this.disconnect();
  }

  scheduleIdleCheck(delay) {
    if (this.idleId !== undefined) return;
    if (delay === undefined) delay = constants.IDLE_TIMEOUT + 1000;
    this.idleId = setTimeout(this.idleCheck.bind(this), delay);
  }

  janitoring() {
    if (util.getTimestamp() - this.lastJanitoring <= constants.JANITORING_PERIOD) return;
    for (var msg of Object.values(this.fragments)) {
      if (util.getTimestamp() - msg.msgCreationTime > constants.FRAGMENTS_TTL) {
        console.warn('Dropping incomplete message %o: TTL reached', msg);
        delete(this.fragments[msg.correlationId]);
      }
    }
    this.lastJanitoring = util.getTimestamp();
  }

}
