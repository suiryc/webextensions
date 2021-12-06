'use strict';

import { constants } from './constants.js';
import * as util from './util.js';
import { settings } from '../common/settings.js';


// Extension messages handler.
//
// Notes:
// browser.runtime.sendMessage sends a message to all extension pages currently
// listening, except the sender and content scripts.
// If no page is listening (e.g. if browser action or options pages are not
// running right now), an error is triggered:
//  Could not establish connection. Receiving end does not exist.
// browser.tabs.sendMessage sends a message to all extension content scripts
// currently listening in the target tab.
// Both methods do return a Promise resolved with the remote listener(s)
// response.
//
// With moderate usage of messages, those two methods are usually enough, with
// only a few possible error logs.
// To let only specific listeners handle the sent message, we can indicate in
// the message which is the target and have listener code filter out messages
// meant for other targets.
//
// For heavier message usage, it become useful to create dedicated Ports:
//  - the background script listens for incoming connections
//  - any other script can then connect (creates a new Port) to talk to the
//    background script
//  - for proper targeting we can also indicate which is the target in the
//    message
//    - to send message from background script to specific scripts
//    - to send from one script to another through the background script
// Unlike sendMessage, Port.postMessage does not return a Promise: any request
// response have to be handled, e.g. by correlating messages: this lets us
// determine whether a message received from the remote endpoint is a new one,
// or actually the response to a previous message sent by the local endpoint.
// The same is needed for native application messages (also relies on Port).
export class WebExtension {

  constructor(params) {
    if (!params.target) throw new Error('The target parameter is mandatory');
    this.params = params;
    // Properties managed by the extension.
    this.extensionProperties = {};
    this.isBackground = params.target === constants.TARGET_BACKGROUND_PAGE;
    // Notes:
    // More than one listener can be added.
    // Caller is expected to manage whether to use one listener and dispatch
    // responses, or add multiple listeners for each dedicated feature.
    browser.runtime.onMessage.addListener(this.onMessage.bind(this));
    if (this.isBackground) this.listenConnections();
    else this.connect();
  }

  getExtensionProperty(details) {
    var key = details.key;
    var create = details.create;
    var entry = this.extensionProperties[key];
    if (!entry && create) entry = this.extensionProperties[key] = create(this);
    return entry;
  }

  getNotif(source) {
    // Create a re-usable dedicated notifier.
    return this.getExtensionProperty({
      key: `notif.${source}`,
      create: webext => {
        var notif = {};
        ['info', 'warn', 'error'].forEach(level => {
          notif[level] = function(details, error) {
            // Prepare details.
            if (typeof(details) === 'object') details = Object.assign({source}, details, {level});
            else details = {source, level, message: details, error};
            webext.notify(details);
          };
        });
        notif.warning = notif.warn;
        return notif;
      }
    });
  }

  onMessage(msg, sender) {
    // Notes:
    // When the browser.runtime.onMessage listener callback returns a Promise,
    // it is sent back to the sender; when it returns a value, the sender gets
    // an empty response.
    // Port.onMessage listener properly transmits any returned value/Promise.
    var actualSender = sender;
    // If the sender is a Port, get the real sender field.
    var isPort = !!sender.sender;
    if (isPort) actualSender = sender.sender;
    // Ignore message when applicable.
    if (!this.isTarget(msg)) {
      // If the background script receives a Port message for another target,
      // forward the message.
      if (isPort && this.targets && msg.target) return this.sendMessage(msg);
      if (settings.debug.misc) console.log('Ignore message %o: receiver=<%s> does not match target=<%s>', msg, this.params.target, msg.target);
      return;
    }
    switch (msg.kind || '') {
      case constants.KIND_ECHO:
        // Handle 'echo' message internally.
        return Promise.resolve({
          msg,
          sender: actualSender
        });

      case constants.KIND_REGISTER_PORT:
        var handler = this.registerPort(sender, msg.name);
        var tab = actualSender.tab;
        if (!tab || !this.params.tabsHandler) return;
        // Hand over frame information to the tabs handler, which will check
        // whether this is a brand new one or is already known.
        this.params.tabsHandler.addFrame({
          windowId: tab.windowId,
          tabId: tab.id,
          frameId: actualSender.frameId,
          url: actualSender.url,
          csUuid: msg.csUuid
        });
        return;

      case constants.KIND_REGISTER_TABS_EVENTS:
        this.registerTabsEvents(sender, msg.events);
        return;

      case constants.KIND_TABS_EVENT:
        if (!this.params.tabsEventsObserver) break;
        util.callMethod(this.params.tabsEventsObserver, msg.event.kind, msg.event.args);
        return;
    }
    var r;
    // Enforce Promise, so that we handle both synchronous/asynchronous reply.
    // This is also needed so that the response content (if not a Promise) is
    // properly transmitted to the sender in all cases.
    try {
      r = Promise.resolve(this.params.onMessage(this, msg, actualSender));
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
  }

  isTarget(msg) {
    return !msg.target || (msg.target == this.params.target);
  }

  // Listens to incoming connections.
  // Only used inside background script.
  listenConnections() {
    // Notes:
    // To use objects as keys, we need a Map/WeakMap. We can use either due to
    // the way we handle ports.
    this.ports = new WeakMap();
    this.targets = {};
    browser.runtime.onConnect.addListener(this.registerPort.bind(this));
  }

  registerPort(port, target) {
    // Create the handler the first time.
    var handler = this.ports.get(port);
    if (!handler) {
      handler = new PortHandler(this, {
        onMessage: this.onMessage.bind(this),
        onDisconnect: this.unregisterPort.bind(this)
      });
      handler.setPort(port);
      this.ports.set(port, handler);
    }
    // Remember the remote endpoint target kind once known (first message it
    // should send).
    handler.params.target = target;
    if (!target) return handler;
    var targets = this.targets[target] || [];
    targets.push(handler);
    this.targets[target] = targets;
    return handler;
  }

  unregisterPort(port, handler) {
    this.unregisterTabsEvents(handler);
    var target = handler.params.target;
    // Note: explicitly delete because if we don't know the target, we have
    // nothing else to do; and we don't want to keep the weak reference either.
    this.ports.delete(port);
    if (!target) return;
    var targets = this.targets[target];
    // Belt and suspenders: we should know this target.
    if (!targets) return;
    targets = targets.filter(v => v !== handler);
    if (!targets.length) delete(this.targets[target]);
    else this.targets[target] = targets;
  }

  registerTabsEvents(port, events) {
    var self = this;
    if (!events) return;
    var handler = self.ports.get(port);
    if (!handler) return;
    var setup = !self.tabsEventsTargets;
    if (setup) {
      self.tabsEventsTargets = {};
      constants.EVENTS_TABS.forEach(key => {
        self.tabsEventsTargets[key] = new Set();
      });
    }
    self.unregisterTabsEvents(handler);
    handler.params.tabsEvents = events || [];
    for (var key of handler.params.tabsEvents) {
      self.tabsEventsTargets[key].add(handler);
    }
    self.observeTabsEvents(port, setup ? undefined : events);
  }

  unregisterTabsEvents(handler) {
    for (var key of (handler.params.tabsEvents || [])) {
      this.tabsEventsTargets[key].delete(handler);
    }
  }

  observeTabsEvents(observer, events) {
    var self = this;
    var tabsHandler = self.params.tabsHandler;

    if (tabsHandler) {
      // The tabs handler should be defined for the background script.
      // Post tabs events to observers.
      if (!events) {
        // Setup common proxy observer for the first actual observer.
        var dummyObserver = {};
        constants.EVENTS_TABS.forEach(key => {
          dummyObserver[key] = function() {
            var msg;
            // Use arrow function so that 'arguments' is the parent one.
            var getMsg = () => {
              if (msg) return msg;
              msg = {
                kind: constants.KIND_TABS_EVENT,
                event: {
                  kind: key,
                  args: util.toJSON([...arguments])
                }
              };
              return msg;
            };
            self.tabsEventsTargets[key].forEach(observer => {
              observer.postMessage(getMsg());
            });
          }
        });
        tabsHandler.addObserver(dummyObserver);
      } else {
        // For next observers, create a one-shot proxy observer to trigger
        // initial events. The next events will be proxyied by the common
        // proxy observer.
        var dummyObserver = {};
        events.forEach(key => {
          dummyObserver[key] = function() {
            observer.postMessage({
              kind: constants.KIND_TABS_EVENT,
              event: {
                kind: key,
                args: util.toJSON([...arguments])
              }
            });
          }
        });
        tabsHandler.addObserver(dummyObserver);
        tabsHandler.removeObserver(dummyObserver);
      }

      // Nothing else to do on this side.
      return;
    }

    // The observer should be defined for non-background scripts.
    // Register us, and pass events to the actual observer.
    // We automatically determine events that are handled.
    if (observer) {
      var events = new Set();
      constants.EVENTS_TABS.forEach(key => {
        if (util.hasMethod(observer, key)) events.add(key);
      });
      self.params.tabsEventsObserver = observer;
      if (this.portHandler) this.portHandler.params.tabsEvents = events;
      self.sendMessage({
        target: constants.TARGET_BACKGROUND_PAGE,
        kind: constants.KIND_REGISTER_TABS_EVENTS,
        events
      });
    }
  }

  // Connects (to background script).
  // Only used from scripts other than the background.
  connect() {
    this.portHandler = new PortHandler(this, {
      target: this.params.target,
      onMessage: this.onMessage.bind(this)
    });
    this.portHandler.connect();
  }

  sendMessage(msg) {
    // When the background script needs to send a message to given target(s),
    // do find the concerned Ports to post the message on.
    if (this.targets && msg.target) {
      var ports = this.targets[msg.target] || [];
      var promises = [];
      for (var port of ports) {
        promises.push(port.postRequest(msg));
      }
      // Message actually sent to self.
      if (this.isTarget(msg)) promises.push(this.onMessage(msg, this));
      return Promise.all(promises);
    }

    // Use dedicated Port when applicable.
    // Belt and suspenders: fallback to 'broadcasting' otherwise. This actually
    // should not be needed/useful, as only non-background scripts do use Ports,
    // and if remote endpoint disconnects, it should mean it is not running
    // anymore.
    var usePort = this.portHandler && this.portHandler.isConnected();
    if (usePort) return this.portHandler.postRequest(msg);
    return browser.runtime.sendMessage(msg);
  }

  sendTabMessage(tabId, msg, options) {
    return browser.tabs.sendMessage(tabId, msg, options);
  }

  notify(details) {
    if (!details.source) details.source = this.params.target;
    util.notification(details);
    // Now that original information has been logged, and possibly notified,
    // format the error, if present, so that it can be properly serialized.
    // (needed to transmit message between background and other scripts)
    if (details.error) details.error = util.formatObject(details.error);
    this.sendMessage({
      target: constants.TARGET_BACKGROUND_PAGE,
      kind: constants.KIND_NOTIFICATION,
      details
    });
  }

}

// Handles a webextension connection Port.
//
// Shares mechanisms with native application messaging (which also relies on
// Port); native application messaging needs some more complex handling though.
class PortHandler {

  constructor(webext, params) {
    this.webext = webext;
    this.params = params;
    this.requests = {};
    this.defaultTimeout = constants.MESSAGE_RESPONSE_TIMEOUT;
  }

  isConnected() {
    return !!this.port;
  }

  setPort(port) {
    this.port = port;
    this.port.onDisconnect.addListener(this.onDisconnect.bind(this));
    this.port.onMessage.addListener(this.onMessage.bind(this));
  }

  connect() {
    if (this.port) return;

    var name = this.params.target;
    if (name == constants.TARGET_CONTENT_SCRIPT) {
      // Generate a unique content script UUID, shared between all content
      // scripts running in the frame.
      this.csUuid = globalThis.csUuid = globalThis.csUuid || util.uuidv4();
    }

    this.autoReconnect = true;
    this.setPort(browser.runtime.connect());
    // Register us in background script.
    this.postMessage({
      kind: constants.KIND_REGISTER_PORT,
      name
    });
    // Re-register events to observe.
    var events = this.params.tabsEvents || new Set();
    if (events.size) {
      this.postMessage({
        kind: constants.KIND_REGISTER_TABS_EVENTS,
        events
      });
    }
  }

  onDisconnect(port) {
    var self = this;

    if (port !== self.port) {
      // This is not our connection; should not happen
      console.warn('Received unknown extension port %o disconnection', port);
      return;
    }
    // Only log if disconnection was due to an error.
    // If script simply ends (e.g. browser action page is closed), we get a
    // null error field.
    if (port.error == null) delete(port.error);
    var error = port.error;
    if (error) console.warn('Extension port %o disconnected: %o', port, error);
    delete(self.port);
    // Wipe out current requests; reject any pending Promise.
    // Parent will either wipe us out (background script), or we should not
    // expect to receive any response as the remote endpoint is supposedly
    // dead.
    for (var promise of Object.values(self.requests)) {
      var msg = 'Remote script disconnected';
      if (error) msg += ' with error: ' + util.formatObject(error);
      promise.reject(msg);
    }
    self.requests = {};
    // Re-connect if needed.
    if (self.autoReconnect) {
      if (settings.debug.misc) console.warning('Extension port %o disconnected: wait and re-connect', port);
      setTimeout(() => {
        self.connect();
      }, 1000);
    }
    // Notify parent if needed.
    if (self.params.onDisconnect) self.params.onDisconnect(port, self);
  }

  // Posts message without needing to get the reply.
  postMessage(msg) {
    // Set csUuid in messages when applicable.
    if (this.csUuid) msg.csUuid = this.csUuid;
    if (this.port) this.port.postMessage(msg);
    else console.warning('Cannot post message on closed port:', msg);
  }

  // Posts request and return reply through Promise.
  postRequest(msg, timeout) {
    var self = this;
    // Get a unique - non-used - id
    var correlationId;
    do {
      correlationId = util.uuidv4();
    } while (self.requests[correlationId] && (correlationId !== self.lastRequestId));
    // The caller may need the passed message to remain unaltered, especially
    // the correlationId, which is used to reply to the original sender in case
    // of (background script) forwarding.
    // To prevent any altering, duplicate the message.
    msg = Object.assign({}, msg, {correlationId});

    // Post message
    self.postMessage(msg);

    // Setup response handling
    if (!timeout) timeout = this.defaultTimeout;
    var promise = new util.Deferred().promise;
    self.requests[correlationId] = promise;
    return util.promiseThen(util.promiseOrTimeout(promise, timeout), () => {
      // Automatic cleanup of request
      delete(self.requests[correlationId]);
    });
  }

  onMessage(msg, sender) {
    var correlationId = msg.correlationId;
    var callback = true;
    // Handle this message as a reponse when applicable.
    if (correlationId) {
      var promise = this.requests[correlationId];
      if (promise) {
        // Note: request will be automatically removed upon resolving the
        // associated promise.
        delete(msg.correlationId);
        // We either expect a reply in the 'reply' field, or an error in the
        // 'error' field. For simplicity, we don't transform an error into a
        // failed Promise, but let caller check whether this in an error
        // through the field.
        var actual = 'reply' in msg ? msg.reply : msg;
        if (actual && actual.warning) {
          console.log('A warning was received in request response:', actual);
          this.webext.notify({
            title: 'Request response warning',
            level: 'warning',
            message: 'A warning was received in request response',
            error: actual.warning,
            silent: true
          });
        }
        promise.resolve(actual);
        callback = false;
      }
    }
    // Otherwise, notify parent of this new message to handle.
    if (callback) this.handleMessage(msg, sender);
  }

  async handleMessage(msg, sender) {
    var self = this;

    // Take care of a possible endless request/response loop:
    //  - A sends a query to B
    //  - A forgets the correlationId, or B wrongly replaces it (e.g. while
    //    forwarding it)
    //  - B finally sends the response to A
    //  - A doesn't know the received correlationId, thus believing it is a
    //    request
    //  - A responds to B
    //  - B doesn't know (anymore) the correlationId, thus believing it is a
    //    request
    //  - B responds to A
    //  - ...
    // In this specific case, break out of the loop by remembering the last
    // received correlationId: if we see it again, assume this is a loop.
    if (msg.correlationId && (msg.correlationId === self.lastRequestId)) {
      console.warn(`Detected request/response loop on correlationId=<${msg.correlationId}>`);
      return;
    }

    var r;
    // Enforce Promise, so that we handle both synchronous/asynchronous reply.
    try {
      r = Promise.resolve(self.params.onMessage(msg, sender));
    } catch (error) {
      r = Promise.reject(error);
    }
    // Don't handle reply if caller don't expect it.
    if (!msg.correlationId) return;
    self.lastRequestId = msg.correlationId;
    // Embed reply in 'reply' field, or error in 'error' field.
    r.then(v => {
      self.postMessage({reply: v, correlationId: msg.correlationId});
    }).catch(error => {
      console.error('Could not handle message %o reply %o: %o', msg, r, error);
      // Format object: pure Errors are empty when sent.
      self.postMessage({error: util.formatObject(error), correlationId: msg.correlationId});
    });
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
export class NativeApplication extends PortHandler {

  constructor(appId, webext, params) {
    super(webext, params);
    this.appId = appId;
    this.fragments = {};
    this.lastJanitoring = util.getTimestamp();
    this.defaultTimeout = constants.NATIVE_RESPONSE_TIMEOUT;
    if (!params.onMessage) throw new Error('Native application client must have an onMessage handler');
  }

  connect() {
    if (this.port) return;
    try {
      this.setPort(browser.runtime.connectNative(this.appId));
    } catch (error) {
      console.error('Failed to connect to native application %s: %o', this.appdId, error);
      throw error;
    }
    this.lastActivity = util.getTimestamp();
    this.scheduleIdleCheck();
  }

  disconnect() {
    if (!this.port) return;
    this.port.disconnect();
    delete(this.port);
  }

  // Posts message without needing to get the reply.
  // Takes care of (re)connecting if needed.
  postMessage(msg) {
    this.connect();
    super.postMessage(msg);
    this.lastActivity = util.getTimestamp();
  }

  onDisconnect(port) {
    // Note: this.port is undefined if *we* asked to disconnect.
    if (this.port && (port !== this.port)) {
      // This is not our connection; should not happen
      console.warn('Received unknown native application %s port %o disconnection', this.appId, port);
      return;
    }
    var error;
    if (this.port) {
      // We don't expect the native application (port) to close itself: this
      // should mean an error was encoutered.
      error = port.error;
      console.warn('Native application %s port disconnected: %o', this.appId, port.error);
    }
    delete(this.port);
    this.fragments = {};
    for (var promise of Object.values(this.requests)) {
      var msg = 'Native application disconnected';
      if (error) msg += ' with error: ' + util.formatObject(error);
      promise.reject(msg);
    }
    this.requests = {};
    if (this.params.onDisconnect) this.params.onDisconnect(this);
  }

  onMessage(msg, sender) {
    this.lastActivity = util.getTimestamp();
    if (msg.fragment) {
      this.addFragment(msg);
    } else {
      super.onMessage(msg, sender);
    }
    this.janitoring();
  }

  async handleMessage(msg, sender) {
    this.params.onMessage(this, msg);
  }

  addFragment(msg) {
    var fragmentKind = msg.fragment;
    var correlationId = msg.correlationId;

    if (!correlationId) {
      console.warn('Dropping message %o: missing correlationId', msg)
      return;
    }

    var previousFragment = this.fragments[correlationId];
    if (!previousFragment) {
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
    delete(this.idleId);
    // Re-schedule if idle not yet reached
    var remaining = constants.IDLE_TIMEOUT - (util.getTimestamp() - this.lastActivity);
    if (remaining > 0) return this.scheduleIdleCheck(remaining + 1000);
    // Then get rid of old fragments if any
    if (this.fragments.length) this.janitoring();
    // Re-schedule if there are pending requests/fragments
    if (this.fragments.length || this.requests.length) return this.scheduleIdleCheck(1000);
    console.log('Extension %s idle timeout', constants.EXTENSION_ID);
    this.disconnect();
  }

  scheduleIdleCheck(delay) {
    if (this.idleId) return;
    this.idleId = setTimeout(this.idleCheck.bind(this), delay || (constants.IDLE_TIMEOUT + 1000));
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
