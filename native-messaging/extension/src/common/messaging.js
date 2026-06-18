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
// For heavier message usage, it becomes useful to create dedicated Ports:
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
//
// Each side of a communication has a Port object.
//
// Then we can have the background script become a central hub: any script that
// needs to send a message to another script can do so through the background
// script which receives all messages and dispatch them to the actual targets.
// Scripts can of course target the background script itself.
// Where needed, we can also handle 'local targets': one main script does create
// the Port, and sub-features may simply register as specific endpoint that can
// receive messages (through the main script).
//
// Message targeting can indicate various fields:
//  - target: the overall target name; e.g. background page, browser action, ...
//  - targetId: a specific listener with a dedicated Port, aside the main script
//    that has the same 'target'
//  - targetDetails: to target window/tab/frame content script
//    - windowId
//    - tabId
//    - frameId
//    - id: to target a specific 'local listener' in the content scripts
//
// At the Port level, we have:
//  - postMessage: calls underlying Port.postMessage, with no response
//  - postRequest: wraps postMessage/onMessage to correlate received message
//    responses to previously sent request messages
// At the application level, we mimic with:
//  - postMessage: find the targets (ports or local targets) to send the message
//    to, without response to manage
//  - sendMessage: as postMessage, but manages the responses (Promises) to give
//    back to caller
//
// A special '_routing' field is used in messages in order to indicate:
//  - the target(s) to send the message to: 'target', 'targetId', 'targetDetails'
//    as documented
//  - whether this is a 'request', that is whether callers expects a response
//    (carried through Promises) from the target(s)
//  - whether this is a 'broadcast'
//    - broadcast: any number of targets, matching the conditions, will receive
//      the message, and an array (of Promises) is returned in case of request
//    - non-broadcast: only one target is expected, so the first one matching
//      the conditions will receive the message, and caller will only get back
//      one response Promise in case of request
//    - postMessage is by default broadcasting (if not specified)
//
// Implementation note
// -------------------
// Interaction between 'broadcast' 'request' and multiple targets with possible
// (local/remote endpoint) local targets.
// Since a script may go through the background script to reach the actual
// target(s), and that each endpoint may dispatch to local targets, there is a
// need to properly handle responses aggregation: arrays are used to return each
// target response, and original caller is expected to receive a flat array with
// all target(s) responses.
// When an endoint sends back a response, it would need to wrap it inside an
// array. When a routing component (e.g. the background script) dispatches a
// request and receives the responses, it needs to expect an array and unwrap it
// to flatten all elements before sending the response array back to the caller.
// To simplify a bit the code:
//  - when a component (endpoint or routing) knows its response is not an array
//    kind, it can send it back as-is internally: only opaque values (received
//    through sendMessage/onMessage typically) needs to be wrapped, since the
//    real target may respond with an array to the caller (and we don't want to
//    unwrap *this* array)
//  - internally, when aggregating dispatched responses, gracefully handle a
//    non-array response when creating the flat array of responses
export class WebExtension {

  constructor(params) {
    const self = this;
    if (!params.target) throw new Error('The target parameter is mandatory');
    self.params = params;
    // Properties managed by the extension.
    self.extensionProperties = new util.PropertiesHandler(self, params.tabsHandler);
    self.isBackground = params.target === constants.TARGET_BACKGROUND_PAGE;
    self.localTargets = [];

    // Create console to log messages in background script.
    // Brower action and options ui script already are visible along background
    // script logs: the console shows the log origin page.
    // Only content scripts console is associated to the viewed page.
    self.console = {};
    for (const level of ['log', 'debug', 'info', 'warn', 'error']) {
      if (params.target !== constants.TARGET_CONTENT_SCRIPT) {
        self.console[level] = console[level].bind(console);
      } else {
        self.console[level] = function (...args) {
          self.postMessage({
            _routing: {
              target: constants.TARGET_BACKGROUND_PAGE,
              kind: constants.KIND_CONSOLE
            },
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

  // Create a new instance with updated params.
  withParams(params) {
    return new WebExtension(Object.assign({}, this.params, params));
  }

  getNotif(source, defaults) {
    // Create a re-usable dedicated notifier.
    return this.extensionProperties.get({
      key: `notif.${source}`,
      tabId: (defaults || {}).tabId,
      create: webext => {
        const notif = {};
        ['info', 'warn', 'error'].forEach(level => {
          notif[level] = function(details, error) {
            // Prepare details.
            if (typeof(details) != 'object') details = {message: details, error};
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
    const _routing = msg._routing || {};
    // Notes:
    // When the browser.runtime.onMessage listener callback returns a Promise,
    // it is sent back to the sender; when it returns a value, the sender gets
    // an empty response.
    // Port.onMessage listener properly transmits any returned value/Promise.
    let actualSender = sender;
    // If the sender is a Port, get the real sender: this is actually only
    // available in the background script, because the 'Port.sender' field has
    // been only filled upon 'onConnect' callback.
    if (sender.sender) actualSender = sender.sender;
    // In non-background scripts, we can check whether the sender is the port
    // we use to talk to the background script.
    const isPort = !!sender.sender || (sender === this.portHandler?.port);

    // Ignore message when applicable.
    if (!this.isTarget(msg, false)) {
      // If we are the target as a dispatcher, and have targets, dispatch the
      // message.
      if ((this.isBackground || this.isTarget(msg, true)) && (this.targets || (this.localTargets.length > 0))) return this._sendMessage(msg, isPort);
      const selfTargetDetails = this.params.targetDetails;
      const msgTargetDetails = _routing?.targetDetails;
      if (settings.debug.misc) console.log(`Ignore message %o: receiver target=<${this.params.target || ''}/${this.params.targetId || ''}> details=<${selfTargetDetails?.windowId || ''}/${selfTargetDetails?.tabId || ''}/${selfTargetDetails?.frameId || ''}/${selfTargetDetails?.id || ''}> does not match message target=<${_routing.target || ''}/${_routing.targetId || ''}> details=<${msgTargetDetails?.windowId || ''}/${msgTargetDetails?.tabId || ''}/${msgTargetDetails?.frameId || ''}/${msgTargetDetails?.id || ''}>`, msg);
      return;
    }

    // In background script, we may need to know whether received message is
    // still 'fresh' when coming from a content script: if we set the sender
    // frame information and the sender is a tab, we can see whether the frame
    // matches a current one.
    if (this.isBackground && actualSender.tab && this.params.tabsHandler && msg.sender) {
      const tab = actualSender.tab;
      const frameHandler = this.params.tabsHandler.getFrame({tabId: tab.id, frameId: msg.sender.frame.id, csUuid: msg.csUuid});
      msg.sender.live = frameHandler && (frameHandler.url === msg.sender.frame.url);
      // Note:
      // Sometimes the sender tab url reported by the browser is not up-to-date.
      // Since we could determine the frame that sent the message is the one we
      // know (this is not an old message), use the tab URL we know right now.
      if (msg.sender.live) tab.url = frameHandler.tabHandler.url;
    }

    // Handle some messages internally.
    // Reminder: if returning non-array, no need to wrap upon 'broadcast'.
    switch (_routing.kind) {
      case constants.KIND_PING:
        return Promise.resolve({});

      case constants.KIND_ECHO:
        return Promise.resolve({
          msg,
          sender: actualSender
        });

      case constants.KIND_REGISTER_PORT: {
        const handler = this.registerPort(sender, msg);
        if (settings.debug.misc) console.log('Registered port=<%o> from message=<%o> with handler=<%o>', sender, msg, handler);
        const tab = actualSender.tab;
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
      }

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
    if (_routing.broadcast) r = r.then(util.arrayWrap);
    return r;
  }

  isTarget(msg, dispatcher) {
    const _routing = msg?._routing || {};
    // If there is no target, every listener is a target.
    if (!_routing.target) return true;
    // When target is defined, it must match.
    if (_routing.target !== this.params.target) return false;
    // When checking as a dispatcher, only the 'target' needs to match.
    if (dispatcher) return true;
    // If a targetId is given/needed, we only need to match it.
    if (_routing.targetId || this.params.targetId) return (_routing.targetId === this.params.targetId);
    // Otherwise, optional target details also need to match.
    const targetDetails = _routing.targetDetails;
    if (!targetDetails) return true;
    if ((targetDetails.windowId !== undefined) && (this.params.targetDetails?.windowId !== targetDetails.windowId)) return false;
    if ((targetDetails.tabId !== undefined) && (this.params.targetDetails?.tabId !== targetDetails.tabId)) return false;
    if ((targetDetails.frameId !== undefined) && (this.params.targetDetails?.frameId !== targetDetails.frameId)) return false;
    if ((targetDetails.id !== undefined) && (this.params.targetDetails?.id !== targetDetails.id)) return false;
    // Every target/details do match.
    return true;
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

  registerLocalTarget(params) {
    this.localTargets.push(params);
  }

  registerPort(port, msg) {
    // Create the handler the first time.
    // Note: we should be called twice:
    //  - from 'onConnect' listener, when port is truly created
    //  - upon 'KIND_REGISTER_PORT' message, which should be the first thing
    //    remote endpoint do
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
    const target = msg?.target;
    if (!target) return handler;
    handler.params.target = target;
    if (msg._routing.targetId) handler.params.targetId = msg._routing.targetId;
    const targets = this.targets[target] || [];
    targets.push(handler);
    this.targets[target] = targets;
    this.deduplicatePort(handler);
    return handler;
  }

  deduplicatePort(handler) {
    // When site does navigate between pages, previous ports may remain while
    // new content scripts are injected, and new ports (for the same tab main
    // frame) are created.
    // Nothing happens if we post a message on these ports, and if we are waiting
    // for a response, we will simply timeout.
    // These ports usually are only disconnected when the tab is closed.
    //
    // As a workaround, expect only one connection for a specific tab+frame,
    // and remember only the last one.

    function getKey(handler) {
      if (!handler.port.sender || !handler.port.sender.tab) return;
      if (!handler.params.target) return;

      return {
        windowId: handler.port.sender.tab.windowId,
        tabId: handler.port.sender.tab.id,
        frameId: handler.port.sender.frameId,
        target: handler.params.target,
        targetId: handler.params.targetId
      };
    }

    const key = getKey(handler);
    if (!key) return;

    const knownPortHandlers = this.targets[key.target] || [];
    for (const portHandler of knownPortHandlers) {
      if (portHandler === handler) continue;
      if (util.deepEqual(key, getKey(portHandler))) {
        if (settings.debug.misc) console.log('Found duplicate key=<%o> port=<%o> handler=<%o>', key, portHandler.port, portHandler);
        this.unregisterPort(portHandler.port, portHandler);
      }
    }
  }

  unregisterPort(port, handler) {
    if (settings.debug.misc) console.log('Unregister port=<%o> handler=<%o>', port, handler);
    this.unregisterTabsEvents(handler);
    const target = handler.params.target;
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
    const self = this;
    if (!events) return;
    const handler = self.ports.get(port);
    if (!handler) return;
    const setup = !self.tabsEventsTargets;
    if (setup) {
      self.tabsEventsTargets = {};
      constants.EVENTS_TABS.forEach(key => {
        self.tabsEventsTargets[key] = new Set();
      });
    }
    self.unregisterTabsEvents(handler);
    handler.params.tabsEvents = events || [];
    for (const key of handler.params.tabsEvents) {
      self.tabsEventsTargets[key].add(handler);
    }
    self.observeTabsEvents(port, setup ? undefined : events);
  }

  unregisterTabsEvents(handler) {
    for (const key of (handler.params.tabsEvents || [])) {
      this.tabsEventsTargets[key].delete(handler);
    }
  }

  observeTabsEvents(observer, events) {
    const self = this;
    const tabsHandler = self.params.tabsHandler;

    if (tabsHandler) {
      // The tabs handler should be defined for the background script.
      // Post tabs events to observers.
      if (!events) {
        // Setup common proxy observer for the first actual observer.
        const dummyObserver = {};
        constants.EVENTS_TABS.forEach(key => {
          dummyObserver[key] = function() {
            let msg;
            // Use arrow function so that 'arguments' is the parent one.
            const getMsg = () => {
              if (msg) return msg;
              msg = {
                _routing: {
                  kind: constants.KIND_TABS_EVENT
                },
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
        const dummyObserver = {};
        events.forEach(key => {
          dummyObserver[key] = function() {
            observer.postMessage({
              _routing: {
                kind: constants.KIND_TABS_EVENT
              },
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
      const events = new Set();
      constants.EVENTS_TABS.forEach(key => {
        if (util.hasMethod(observer, key)) events.add(key);
      });
      self.params.tabsEventsObserver = observer;
      if (this.portHandler) this.portHandler.params.tabsEvents = events;
      self.postMessage({
        _routing: {
          target: constants.TARGET_BACKGROUND_PAGE,
          kind: constants.KIND_REGISTER_TABS_EVENTS
        },
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

  // Posts message to matching target(s).
  // Broadcasting is enabled by default.
  postMessage(msg) {
    msg._routing ||= {};
    msg._routing.request = false;
    if (msg._routing.broadcast === undefined) msg._routing.broadcast = true;
    this._sendMessage(msg);
  }

  // Send message, and return response (if applicable).
  // Broadcasting means all targets will receive the message, and an array of
  // responses is returned.
  // Otherwise, only the first matching target will receive the message, and its
  // response be sent back.
  // Broadcasting is disabled by default.
  // Specific case: when sending message to self, non-broadcast is enforced.
  sendMessage(msg) {
    msg._routing ||= {};
    msg._routing.request = true;
    return this._sendMessage(msg);
  }

  _sendMessage(msg, dispatch) {
    const _routing = msg._routing;
    const portMethod = _routing.request ? 'postRequest' : 'postMessage';
    // Include the sender information we have right now.
    _routing.sender = {
      kind: this.params.target,
      frame: {
        url: location.href,
        id: browser.runtime.getFrameId(window)
      }
    };

    const targetDetails = _routing.targetDetails;
    const promises = [];
    // When the background script needs to send a message to given target(s),
    // do find the concerned Ports to post the message on.
    if (this.targets && _routing.target) {
      if (this.isTarget(msg)) {
        // Message actually sent to self: only send our response.
        let r = this.onMessage(msg, this);
        if (_routing.broadcast) r = Promise.resolve(r).then(util.arrayWrap);
        return r;
      }

      const knownPortHandlers = this.targets[_routing.target] || [];
      let targets;
      if (targetDetails || _routing.targetId) {
        targets = [];
        for (const portHandler of knownPortHandlers) {
          // Port remote endpoint will finely check received messages do really
          // target it. However, we can filter out those that should not match
          // and prevent uselessly sending a message to these.
          // We only need to check direct target information, not any information
          // related to a local target on the remote endpoint.

          // If there is no target, every port is a target.
          // When target is defined, it must match.
          if (_routing.target && (_routing.target !== portHandler.params.target)) continue;
          // If a targetId is given/needed, it needs to match.
          if ((_routing.targetId || portHandler.params.targetId) && (_routing.targetId !== portHandler.params.targetId)) continue;
          // Optional target details, except id, also need to match.
          if (targetDetails) {
            if ((targetDetails.windowId !== undefined) && (portHandler.port?.sender?.tab?.windowId !== targetDetails.windowId)) continue;
            if ((targetDetails.tabId !== undefined) && (portHandler.port?.sender?.tab?.id !== targetDetails.tabId)) continue;
            if ((targetDetails.frameId !== undefined) && (portHandler.port?.sender?.frameId !== targetDetails.frameId)) continue;
          }
          // Every target/details do match.
          // If not broadcasting, we are done with this target.
          if (!_routing.broadcast) return portHandler[portMethod](msg);
          targets.push(portHandler);
        }
      } else {
        targets = knownPortHandlers;
      }
      for (const target of targets) {
        // We expect message to be handled by our messaging code, which will wrap
        // the values upon broadcast already.
        promises.push(target[portMethod](msg));
      }
    }
    // Reminder: local script do call sendMessage, so we need to ensure we can
    // dispatch this message to local targets; which has already been confirmed
    // when we are called from 'onMessage'.
    // Skip messages with targetId: this is for ports, not local targets.
    if (!_routing.targetId && this.isTarget(msg, true)) {
      // When we have local targets, send to those that match.
      let localTargets;
      if (targetDetails) {
        localTargets = [];
        for (const localTarget of this.localTargets) {
          if ((targetDetails.id !== undefined) && (localTarget.id !== targetDetails.id)) continue;
          // If caller targets one endpoint, we are done.
          if (!_routing.broadcast) return localTarget.onMessage(this, msg, _routing.sender);
          localTargets.push(localTarget);
        }
      } else {
        localTargets = this.localTargets;
      }
      for (const localTarget of localTargets) {
        // Since we expect local targets to return their response, we need to
        // wrap it upon broadcast.
        let r = localTarget.onMessage(this, msg, _routing.sender);
        if (_routing.broadcast) r = Promise.resolve(r).then(util.arrayWrap);
        promises.push(r);
      }
    }
    // If we found at least one acual target, that's it.
    if (promises.length > 0) {
      let r = Promise.all(promises);
      if (_routing.broadcast) {
        // Time to unwrap/aggregate responses.
        r = r.then(arr => {
          let actual = [];
          for (const v of arr) {
            actual = util.arrayUnwrap(actual, v);
          }
          return actual;
        });
      }
      return r;
    }

    // Use dedicated Port when applicable: should mean we need to send the
    // message to the background script and let it dispatch it to the actual
    // target(s).
    // Thus, if we are supposed to dispatch (meaning we received this from
    // a Port - expectedly the background script), don't send it through our
    // Port (connected to the background script): the message would loop between
    // the background script and us.
    if (!dispatch) {
      const usePort = this.portHandler && this.portHandler.isConnected();
      if (usePort) {
        let r = this.portHandler[portMethod](msg);
        if (_routing.broadcast) r = Promise.resolve(r).then(util.arrayWrap);
        return r;
      }
    }

    // Belt and suspenders: fallback to 'broadcasting' otherwise. This actually
    // should not be needed/useful, as only non-background scripts do use Ports,
    // and if remote endpoint disconnects, it should mean it is not running
    // anymore.
    // Limit this to non-background scripts that are not a target (even as local
    // dispatcher): ignore in other cases.
    if (this.isBackground) {
      if (settings.debug.misc) console.log(`Ignore message %o: background script did not find the target to dispatch to`, msg);
    } else if (this.isTarget(msg, true)) {
      if (settings.debug.misc) console.log(`Ignore message %o: non-background script did not find the target to dispatch to`, msg);
    } else {
      if (settings.debug.misc) console.log('Fallback to broadcasting message %o: non-background script did not find the target to dispatch to and is not connected to broadcast script', msg);
      let r = browser.runtime.sendMessage(msg);
      if (_routing.broadcast) r = r.then(util.arrayWrap);
      return r;
    }
  }

  // Send a message directly to listeners in tab.
  // This entirely bypasses our message handling: any listener in the target tab
  // will receive this message (on its registered listening method, usually
  // its onMessage one).
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
    this.postMessage({
      _routing: {
        target: constants.TARGET_BACKGROUND_PAGE,
        kind: constants.KIND_NOTIFICATION
      },
      details
    });
  }

  fetch(details) {
    return this.sendMessage(Object.assign({
      _routing: {
        target: constants.TARGET_BACKGROUND_PAGE,
        kind: constants.KIND_HTTP_FETCH
      }
    }, details));
  }

}

// Handles a webextension connection Port.
//
// Shares mechanisms with native application messaging (which also relies on
// Port); native application messaging needs some more complex handling though.
//
// Each non-background script have at least one, to talk to the background script.
// The background script have one for each non-background script that does
// 'browser.runtime.connect()'.
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

    const name = this.params.target;
    if (name === constants.TARGET_CONTENT_SCRIPT) {
      // Generate a unique content script UUID, shared between all content
      // scripts running in the frame.
      this.csUuid = globalThis.csUuid = globalThis.csUuid || util.uuidv4();
    }

    this.autoReconnect = true;
    this.setPort(browser.runtime.connect());
    // Register us in background script.
    // Pass our name (the target) and targetId if defined.
    this.postMessage({
      _routing: {
        kind: constants.KIND_REGISTER_PORT
      },
      target: name,
      ...this.webext.params.targetId && {targetId: this.webext.params.targetId}
    });
    // Re-register events to observe.
    const events = this.params.tabsEvents || new Set();
    if (events.size) {
      this.postMessage({
        _routing: {
          kind: constants.KIND_REGISTER_TABS_EVENTS
        },
        events
      });
    }
  }

  onDisconnect(port) {
    const self = this;

    if (port !== self.port) {
      // This is not our connection; should not happen
      console.warn('Received unknown extension port %o disconnection', port);
      return;
    }
    // Only log if disconnection was due to an error.
    // If script simply ends (e.g. browser action page is closed), we get a
    // null error field.
    if (port.error == null) delete(port.error);
    const error = port.error;
    if (error) console.warn('Extension port %o disconnected: %o', port, error);
    else if (!self.autoReconnect && settings.debug.misc) console.log('Extension port %o disconnected', port);
    delete(self.port);
    // Wipe out current requests; reject any pending Promise.
    // Parent will either wipe us out (background script), or we should not
    // expect to receive any response as the remote endpoint is supposedly
    // dead.
    for (const promise of Object.values(self.requests)) {
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
    if (!msg._routing?.request) console.trace('Called postRequest for non-request message', msg);
    const self = this;
    // Get a unique - non-used - id
    let correlationId;
    do {
      correlationId = util.uuidv4();
    } while (self.requests[correlationId] && (correlationId !== self.lastRequestId));
    // The caller may need the passed message to remain unaltered, especially
    // the correlationId, which is used to reply to the original sender in case
    // of (background script) forwarding.
    // To prevent any altering, duplicate the message routing.
    msg._routing = Object.assign({}, msg._routing, {correlationId});

    // Post message
    self.postMessage(msg);

    // Setup response handling.
    // Note: since we don't 'await' from postMessage until here, we are sure to
    // set the promise before it is needed (when response is received).
    if (!timeout) timeout = this.defaultTimeout;
    const promise = new asynchronous.Deferred().promise;
    let actualPromise = promise;

    // Special case: if we delegated a fetch request, convert the response
    // as needed.
    if (msg._routing.kind === constants.KIND_HTTP_FETCH) {
      actualPromise = actualPromise.then(r => {
        // Trigger real error when applicable.
        if (r.error) throw r.error;
        // Or extract response.
        r = r.response;
        // And build binary wanted binary formats from base64.
        if (r.ok) {
          const params = msg.params || {};
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
            const type = findHeaderValue(r.headers, 'Content-Type') || 'application/octet-stream';
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
    const _routing = msg._routing;
    const correlationId = _routing?.correlationId;
    let callback = true;
    // Handle this message as a reponse when applicable.
    if (correlationId) {
      const promise = this.requests[correlationId];
      if (promise) {
        // Note: request will be automatically removed upon resolving the
        // associated promise.
        // We either expect a reply in the 'reply' field, or an error in the
        // 'error' field. For simplicity, we don't transform an error into a
        // failed Promise, but let caller check whether this in an error
        // through the field.
        let actual = msg;
        if ('reply' in _routing) {
          actual = _routing.reply
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
        } else if ('error' in _routing) {
          actual = {
            error: _routing.error
          };
        }
        promise.resolve(actual);
        callback = false;
      }
    }
    // Otherwise, notify parent of this new message to handle.
    if (callback) this.handleMessage(msg, sender);
  }

  async handleMessage(msg, sender) {
    const self = this;

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
    const correlationId = msg._routing?.correlationId;
    if (correlationId && (correlationId === self.lastRequestId)) {
      console.warn(`Detected request/response loop on correlationId=<${correlationId}>`);
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
    if (!correlationId) return;
    self.lastRequestId = correlationId;
    // Embed reply in 'reply' field, or error in 'error' field.
    r.then(v => {
      self.postMessage({
        _routing: {
          correlationId,
          reply: v
        }
      });
    }).catch(error => {
      console.error('Could not handle message %o reply %o: %o', msg, r, error);
      // Format object: pure Errors are empty when sent.
      self.postMessage({
        _routing: {
          correlationId,
          error: util.formatObject(error)
        }
      });
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

  // Posts request and return reply through Promise.
  // Enforce 'request' mode for native application messaging (we call this
  // method directly, and do not want to make 'request' mandatory to set there).
  postRequest(msg) {
    msg._routing ||= {};
    msg._routing.request = true;
    return super.postRequest(msg);
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
    for (const promise of Object.values(this.requests)) {
      let msg = 'Native application disconnected';
      if (error) msg += ` with error: ${util.formatObject(error)}`;
      promise.reject(msg);
    }
    this.requests = {};
    if (this.params.onDisconnect) this.params.onDisconnect(this);
  }

  onMessage(msg, sender) {
    this.lastActivity = util.getTimestamp();
    if (msg._routing?.fragment) {
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
    const fragmentKind = msg._routing.fragment;
    const correlationId = msg._routing.correlationId;

    if (!correlationId) {
      console.warn('Dropping message %o: missing correlationId', msg)
      return;
    }

    const previousFragment = this.fragments[correlationId];
    if (!previousFragment) {
      if (fragmentKind === FRAGMENT_KIND_START) {
        // First fragment
        msg._routing.msgCreationTime = util.getTimestamp();
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
    previousFragment._routing.content = (previousFragment._routing.content || '') + (msg._routing.content || '');
    previousFragment.msgCreationTime = util.getTimestamp();
    if (fragmentKind !== FRAGMENT_KIND_CONT) {
      // There is no need to enforce it: we suppose we received a
      // FRAGMENT_KIND_END fragment, which is the last fragment.
      delete(this.fragments[correlationId]);
      this.onMessage(JSON.parse(previousFragment._routing.content));
    }
    // else: fragment continuation already processed
  }

  idleCheck() {
    delete(this.idleId);
    // Re-schedule if idle not yet reached
    const remaining = constants.IDLE_TIMEOUT - (util.getTimestamp() - this.lastActivity);
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
    for (const msg of Object.values(this.fragments)) {
      if (util.getTimestamp() - msg._routing.msgCreationTime > constants.FRAGMENTS_TTL) {
        console.warn('Dropping incomplete message %o: TTL reached', msg);
        delete(this.fragments[msg._routing.correlationId]);
      }
    }
    this.lastJanitoring = util.getTimestamp();
  }

}
