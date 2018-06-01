'use strict';

// Extension messages handler.
class WebExtension {

  constructor(onMessage) {
    browser.runtime.onMessage.addListener((msg, sender) => {
      // When returning a promise, only success is expected; failed promise
      // is returned without the original error but a generic one.
      // So translate to response with error field which caller will have
      // to handle.
      var r = onMessage(this, msg, sender);
      if (r instanceof Promise) {
        r = r.catch(error => {
          return {error: error};
        });
      }
      return r;
    });
  }

  sendMessage(msg) {
    return browser.runtime.sendMessage(msg);
  }

  sendTabMessage(tabId, msg) {
    return browser.tabs.sendMessage(tabId, msg);
  }

}

// Native application messages handler.
class NativeApplication {

  constructor(appId, handlers) {
    this.appId = appId;
    this.cnx = undefined;
    this.handlers = handlers;
    this.requests = {};
    this.fragments = {};
    this.idleId = undefined;
    this.lastJanitoring = getTimestamp();
    if (handlers.onMessage === undefined) {
      throw Error('Native application client must have an onMessage handler');
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
    this.lastActivity = getTimestamp();
    this.scheduleIdleCheck();
  }

  disconnect() {
    if (this.cnx === undefined) return;
    this.cnx.disconnect();
    this.cnx = undefined;
  }

  postMessage(msg) {
    this.connect();
    this.cnx.postMessage(msg);
    this.lastActivity = getTimestamp();
  }

  postRequest(msg, timeout) {
    // Get a unique - non-used - id
    var correlationId;
    do {
      correlationId = uuidv4();
    } while(this.requests[correlationId] !== undefined);
    msg.correlationId = correlationId;

    // Post message
    this.postMessage(msg);

    // Setup response handling
    if (timeout === undefined) timeout = NATIVE_RESPONSE_TIMEOUT;
    var promise = new Deferred().promise;
    this.requests[correlationId] = promise;
    return promiseThen(promiseOrTimeout(promise, timeout), () => {
      // Automatic cleanup of request
      delete(this.requests[correlationId]);
    });
  }

  onDisconnect(cnx) {
    if ((this.cnx !== undefined) && (cnx !== this.cnx)) {
      // This is not our connection; should not happen
      console.warn('Received unknown native application %s connection disconnection: %o', nativeApp.appId, cnx.error);
      return;
    }
    if (this.cnx !== undefined) console.warn('Native application %s disconnected: %o', nativeApp.appId, cnx.error);
    // else: we asked to disconnect
    this.cnx = undefined;
    this.fragments = {};
    for (var promise of Object.values(this.requests)) {
      promise.reject('Native application disconnected');
    }
    this.requests = {};
    if (this.handlers.onDisconnect !== undefined) {
      defer.then(() => this.handlers.onDisconnect(this));
    }
  }

  onMessage(msg) {
    this.lastActivity = getTimestamp();
    if (msg.fragment !== undefined) {
      this.addFragment(msg);
    } else {
      var correlationId = msg.correlationId;
      var callback = true;
      if (correlationId !== undefined) {
        var promise = this.requests[correlationId];
        if (promise !== undefined) {
          // Note: request will be automatically removed upon resolving the
          // associated promise.
          delete(msg.correlationId);
          promise.resolve(msg);
          callback = false;
        }
      }
      if (callback) {
        defer.then(() => this.handlers.onMessage(this, msg));
      }
    }
    this.janitoring();
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
        msg.msgCreationTime = getTimestamp();
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
    previousFragment.msgCreationTime = getTimestamp();
    if (fragmentKind !== FRAGMENT_KIND_CONT) {
      delete(this.fragments[correlationId]);
      this.onMessage(JSON.parse(previousFragment.content));
    }
    // else: fragment continuation already processed
  }

  idleCheck() {
    this.idleId = undefined;
    // Re-schedule if idle not yet reached
    var remaining = IDLE_TIMEOUT - (getTimestamp() - this.lastActivity);
    if (remaining > 0) return this.scheduleIdleCheck(remaining + 1000);
    // Then get rid of old fragments if any
    if (this.fragments.length > 0) janitoring();
    // Re-schedule if there are pending requests/fragments
    if ((this.fragments.length > 0) || (this.requests.length > 0)) return this.scheduleIdleCheck(1000);
    console.log('Extension %s idle timeout', EXTENSION_ID);
    this.disconnect();
  }

  scheduleIdleCheck(delay) {
    if (this.idleId !== undefined) return;
    if (delay === undefined) delay = IDLE_TIMEOUT + 1000;
    this.idleId = setTimeout(this.idleCheck.bind(this), delay);
  }

  janitoring() {
    if (getTimestamp() - this.lastJanitoring <= JANITORING_PERIOD) return;
    for (var msg of Object.values(this.fragments)) {
      if (getTimestamp() - msg.msgCreationTime > FRAGMENTS_TTL) {
        console.warn('Dropping incomplete message %o: TTL reached', msg);
        delete(this.fragments[msg.correlationId]);
      }
    }
    this.lastJanitoring = getTimestamp();
  }

}
