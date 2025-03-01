'use strict';

import { constants } from './constants.js';
import * as util from './util.js';
import * as asynchronous from './asynchronous.js';
import { findHeaderValue } from './http.js';
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
    let self = this;
    if (!params.target) throw new Error('The target parameter is mandatory');
    self.params = params;
    // Properties managed by the extension.
    self.extensionProperties = new util.PropertiesHandler(self, params.tabsHandler);
    self.isBackground = params.target === constants.TARGET_BACKGROUND_PAGE;

    // Create console to log messages in background script.
    // Brower action and options ui script already are visible along background
    // script logs: the console shows the log origin page.
    // Only content scripts console is associated to the viewed page.
    self.console = {};
    for (let level of ['log', 'debug', 'info', 'warn', 'error']) {
      if (params.target != constants.TARGET_CONTENT_SCRIPT) {
        self.console[level] = console[level].bind(console);
      } else {
        self.console[level] = function (...args) {
          self.sendMessage({
            target: constants.TARGET_BACKGROUND_PAGE,
            kind: constants.KIND_CONSOLE,
            level: level,
            args: util.tryStructuredClone(args)
          });
        }
      }
    }

    // Notes:
    // More than one listener can be added.
    // Caller is expected to manage whether to use one listener and dispatch
    // responses, or add multiple listeners for each dedicated feature.
    browser.runtime.onMessage.addListener(self.onMessage.bind(self));
    if (self.isBackground) self.listenConnections();
    else self.connect();
  }

  getNotif(source, defaults) {
    // Create a re-usable dedicated notifier.
    return this.extensionProperties.get({
      key: `notif.${source}`,
      tabId: (defaults || {}).tabId,
      create: webext => {
        let notif = {};
        ['info', 'warn', 'error'].forEach(level => {
          notif[level] = function(details, error) {
            // Prepare details.
            if (typeof(details) !== 'object') details = {message: details, error};
            details = Object.assign({source}, defaults, details, {level});
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
    let actualSender = sender;
    // If the sender is a Port, get the real sender field.
    let isPort = !!sender.sender;
    if (isPort) actualSender = sender.sender;
    // Ignore message when applicable.
    if (!this.isTarget(msg)) {
      // If the background script receives a Port message for another target,
      // forward the message.
      if (isPort && this.targets && msg.target) return this.sendMessage(msg);
      if (settings.debug.misc) console.log(`Ignore message %o: receiver=<${this.params.target}> does not match target=<${msg.target}>`, msg);
      return;
    }
    // In background script, we may need to know whether received message is
    // still 'fresh' when coming from a content script: if we set the sender
    // frame information and the sender is a tab, we can see whether the frame
    // matches a current one.
    if (this.isBackground && actualSender.tab && this.params.tabsHandler && msg.sender) {
      let tab = actualSender.tab;
      let frameHandler = this.params.tabsHandler.getFrame({tabId: tab.id, frameId: msg.sender.frame.id, csUuid: msg.csUuid});
      msg.sender.live = frameHandler && (frameHandler.url == msg.sender.frame.url);
      // Note:
      // Sometimes the sender tab url reported by the browser is not up-to-date.
      // Since we could determine the frame that sent the message is the one we
      // know (this is not an old message), use the tab URL we know right now.
      if (msg.sender.live) tab.url = frameHandler.tabHandler.url;
    }
    switch (msg.kind || '') {
      case constants.KIND_ECHO:
        // Handle 'echo' message internally.
        return Promise.resolve({
          msg,
          sender: actualSender
        });

      case constants.KIND_REGISTER_PORT:
        let handler = this.registerPort(sender, msg.name);
        let tab = actualSender.tab;
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
    let r;
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
    let handler = this.ports.get(port);
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
    let targets = this.targets[target] || [];
    targets.push(handler);
    this.targets[target] = targets;
    return handler;
  }

  unregisterPort(port, handler) {
    this.unregisterTabsEvents(handler);
    let target = handler.params.target;
    // Note: explicitly delete because if we don't know the target, we have
    // nothing else to do; and we don't want to keep the weak reference either.
    this.ports.delete(port);
    if (!target) return;
    let targets = this.targets[target];
    // Belt and suspenders: we should know this target.
    if (!targets) return;
    targets = targets.filter(v => v !== handler);
    if (!targets.length) delete(this.targets[target]);
    else this.targets[target] = targets;
  }

  registerTabsEvents(port, events) {
    let self = this;
    if (!events) return;
    let handler = self.ports.get(port);
    if (!handler) return;
    let setup = !self.tabsEventsTargets;
    if (setup) {
      self.tabsEventsTargets = {};
      constants.EVENTS_TABS.forEach(key => {
        self.tabsEventsTargets[key] = new Set();
      });
    }
    self.unregisterTabsEvents(handler);
    handler.params.tabsEvents = events || [];
    for (let key of handler.params.tabsEvents) {
      self.tabsEventsTargets[key].add(handler);
    }
    self.observeTabsEvents(port, setup ? undefined : events);
  }

  unregisterTabsEvents(handler) {
    for (let key of (handler.params.tabsEvents || [])) {
      this.tabsEventsTargets[key].delete(handler);
    }
  }

  observeTabsEvents(observer, events) {
    let self = this;
    let tabsHandler = self.params.tabsHandler;

    if (tabsHandler) {
      // The tabs handler should be defined for the background script.
      // Post tabs events to observers.
      if (!events) {
        // Setup common proxy observer for the first actual observer.
        let dummyObserver = {};
        constants.EVENTS_TABS.forEach(key => {
          dummyObserver[key] = function() {
            let msg;
            // Use arrow function so that 'arguments' is the parent one.
            let getMsg = () => {
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
        let dummyObserver = {};
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
      let events = new Set();
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

  // Send message, and return response (if applicable).
  // Note: when inside background script, since we may target more than one
  // recipient, the response is an array of all recipients result. Targeting
  // ourself won't return an array however, but our response.
  sendMessage(msg) {
    // Include the sender information we have right now.
    msg.sender = {
      kind: this.params.target,
      frame: {
        url: location.href,
        id: browser.runtime.getFrameId(window)
      }
    };

    // When the background script needs to send a message to given target(s),
    // do find the concerned Ports to post the message on.
    if (this.targets && msg.target) {
      // Message actually sent to self: send back our one response.
      if (this.isTarget(msg)) return this.onMessage(msg, this);

      let ports = this.targets[msg.target] || [];
      let promises = [];
      for (let port of ports) {
        promises.push(port.postRequest(msg));
      }
      return Promise.all(promises);
    }

    // Use dedicated Port when applicable.
    // Belt and suspenders: fallback to 'broadcasting' otherwise. This actually
    // should not be needed/useful, as only non-background scripts do use Ports,
    // and if remote endpoint disconnects, it should mean it is not running
    // anymore.
    let usePort = this.portHandler && this.portHandler.isConnected();
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

  fetch(details) {
    return this.sendMessage(Object.assign({
      target: constants.TARGET_BACKGROUND_PAGE,
      kind: constants.KIND_HTTP_FETCH
    }, details));
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

    let name = this.params.target;
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
    let events = this.params.tabsEvents || new Set();
    if (events.size) {
      this.postMessage({
        kind: constants.KIND_REGISTER_TABS_EVENTS,
        events
      });
    }
  }

  onDisconnect(port) {
    let self = this;

    if (port !== self.port) {
      // This is not our connection; should not happen
      console.warn('Received unknown extension port %o disconnection', port);
      return;
    }
    // Only log if disconnection was due to an error.
    // If script simply ends (e.g. browser action page is closed), we get a
    // null error field.
    if (port.error == null) delete(port.error);
    let error = port.error;
    if (error) console.warn('Extension port %o disconnected: %o', port, error);
    delete(self.port);
    // Wipe out current requests; reject any pending Promise.
    // Parent will either wipe us out (background script), or we should not
    // expect to receive any response as the remote endpoint is supposedly
    // dead.
    for (let promise of Object.values(self.requests)) {
      let msg = 'Remote script disconnected';
      if (error) msg += ` with error: ${util.formatObject(error)}`;
      promise.reject(msg);
    }
    self.requests = {};
    // Re-connect if needed.
    if (self.autoReconnect) {
      if (settings.debug.misc) console.warn('Extension port %o disconnected: wait and re-connect', port);
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
    else console.warn('Cannot post message on closed port:', msg);
  }

  // Posts request and return reply through Promise.
  postRequest(msg, timeout) {
    let self = this;
    // Get a unique - non-used - id
    let correlationId;
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

    // Setup response handling.
    // Note: since we don't 'await' from postMessage until here, we are sure to
    // set the promise before it is needed (when response is received).
    if (!timeout) timeout = this.defaultTimeout;
    let promise = new asynchronous.Deferred().promise;
    let actualPromise = promise;

    // Special case: if we delegated a fetch request, convert the response
    // as needed.
    if (msg.kind == constants.KIND_HTTP_FETCH) {
      actualPromise = actualPromise.then(r => {
        // Trigger real error when applicable.
        if (r.error) throw r.error;
        // Or extract response.
        r = r.response;
        // And build binary wanted binary formats from base64.
        if (r.ok) {
          let params = msg.params || {};
          if (params.wantBytes || params.wantArrayBuffer || params.wantBlob) {
            r.bytes = Uint8Array.fromBase64(r.base64);
          }
          if (params.wantArrayBuffer) {
            r.arrayBuffer = r.bytes.buffer;
          }
          if (params.wantBlob) {
            // Blob type is Content-Type.
            // If there is no Content-Type, since we don't want to guess it by
            // inspecting the data, 'application/octet-stream' is the HTTP
            // default.
            let type = findHeaderValue(r.headers, 'Content-Type') || 'application/octet-stream';
            r.blob = new Blob([r.bytes], { type });
          }
        }
        return r;
      });
    }

    self.requests[correlationId] = promise;
    return asynchronous.promiseThen(asynchronous.promiseOrTimeout(actualPromise, timeout), () => {
      // Automatic cleanup of request
      delete(self.requests[correlationId]);
    });
  }

  onMessage(msg, sender) {
    let correlationId = msg.correlationId;
    let callback = true;
    // Handle this message as a reponse when applicable.
    if (correlationId) {
      let promise = this.requests[correlationId];
      if (promise) {
        // Note: request will be automatically removed upon resolving the
        // associated promise.
        delete(msg.correlationId);
        // We either expect a reply in the 'reply' field, or an error in the
        // 'error' field. For simplicity, we don't transform an error into a
        // failed Promise, but let caller check whether this in an error
        // through the field.
        let actual = 'reply' in msg ? msg.reply : msg;
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
    let self = this;

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

    let r;
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
      console.error(`Failed to connect to native application ${this.appdId}:`, error);
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
      console.warn(`Received unknown native application ${this.appId} port %o disconnection`, port);
      return;
    }
    let error;
    if (this.port) {
      // We don't expect the native application (port) to close itself: this
      // should mean an error was encoutered.
      error = port.error;
      console.warn(`Native application ${this.appId} port disconnected:`, port.error);
    }
    delete(this.port);
    this.fragments = {};
    for (let promise of Object.values(this.requests)) {
      let msg = 'Native application disconnected';
      if (error) msg += ` with error: ${util.formatObject(error)}`;
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
    let fragmentKind = msg.fragment;
    let correlationId = msg.correlationId;

    if (!correlationId) {
      console.warn('Dropping message %o: missing correlationId', msg)
      return;
    }

    let previousFragment = this.fragments[correlationId];
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
    let remaining = constants.IDLE_TIMEOUT - (util.getTimestamp() - this.lastActivity);
    if (remaining > 0) return this.scheduleIdleCheck(remaining + 1000);
    // Then get rid of old fragments if any
    if (this.fragments.length) this.janitoring();
    // Re-schedule if there are pending requests/fragments
    if (this.fragments.length || this.requests.length) return this.scheduleIdleCheck(1000);
    console.log(`Extension ${constants.EXTENSION_ID} idle timeout`);
    this.disconnect();
  }

  scheduleIdleCheck(delay) {
    if (this.idleId) return;
    this.idleId = setTimeout(this.idleCheck.bind(this), delay || (constants.IDLE_TIMEOUT + 1000));
  }

  janitoring() {
    if (util.getTimestamp() - this.lastJanitoring <= constants.JANITORING_PERIOD) return;
    for (let msg of Object.values(this.fragments)) {
      if (util.getTimestamp() - msg.msgCreationTime > constants.FRAGMENTS_TTL) {
        console.warn('Dropping incomplete message %o: TTL reached', msg);
        delete(this.fragments[msg.correlationId]);
      }
    }
    this.lastJanitoring = util.getTimestamp();
  }

}
