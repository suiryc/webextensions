'use strict';

import * as util from '../common/util.js';
import { settings } from '../common/settings.js';


// Notes:
// Instead of statically (through manifest) have content scripts loaded on
// pages, those (along with CSS) can be injected dynamically.
// webNavigation allows to finely follow tab frames changes, however:
//  - an existing tab can be reused for a brand new content: re-loading page
//    or navigating to a new page
//  - sub-frames content can also change
//  - even though code execution it mono-threaded, the use of Promises and
//    async/await make it so that callback/code can be executed while the
//    origin tab/frame is being/has been changed; akin to 'race conditions'
//
// We want to avoid injecting more than once the same script, which can lead
// to unexpected/unwanted results.
// Similarly, if a content script sends a message, we may want to know whether
// the sender page has been changed in-between in order to ignore it.
// A solution is to:
//  - setup frame by injecting a first common code with context that can probe
//    itself in case it is already present
//  - have content script fail if setup is missing: we assume the frame content
//    has changed in-between, requiring to re-setup the frame
//  - generate a new UUID for each new injected context
//  - remember previously injected scripts, until frame content changes
// Since we may have to deal with frames other than the main one in tabs, we
// manage this at the frame level; as a special case, a tab is actually
// represented by its main (id 0) frame.
// To avoid 'race conditions' (due to asynchronous execution), we also ensure
// script injection is done sequentially, so that we can more finely react when
// frame content changes.
//
// Dynamically injecting content script only make code executed slightly later
// (in a barely visible way when navigating) compared to static declaration.

class FrameHandler {

  constructor(tabHandler, details) {
    this.tabHandler = tabHandler;
    this.id = details.frameId;
    this.used = false;
    this.reset(details);
  }

  // Resets frame, which is about to be (re)used.
  reset(details, notify) {
    var sameUrl = this.url == details.url;
    this.url = details.url;
    // For each script (id), remember the associated promise, resolved with its
    // injection success and result/error.
    this.scripts = {};
    if (!this.cleared) this.actionNext = [];
    if (notify !== undefined) {
      var notifyDetails = Object.assign({}, notify, {
        tabId: this.tabHandler.id,
        tabHandler: this.tabHandler,
        frameId: this.id,
        frameHandler: this,
        csUuid: this.csUuid,
        sameUrl: sameUrl
      });
      if (this.id == 0) this.getTabsHandler().notifyObservers('tabReset', notifyDetails);
      this.getTabsHandler().notifyObservers('frameReset', notifyDetails);
    }
  }

  // Clears frame, which is about to be removed.
  clear(notify) {
    // Code being executed asynchronously (async functions, or right after an
    // await statement) have to check whether 'cleared' has been set.
    this.cleared = true;
    // Belt and suspenders: remove actionNext entirely, to prevent any other
    // action to be queued/executed. (code is expected to check cleared
    // before using it)
    for (var action of this.actionNext) {
      action.deferred.reject('Frame has been cleared');
    }
    delete(this.actionNext);
    if (notify) this.getTabsHandler().notifyObservers('frameRemoved', {
      tabId: this.tabHandler.id,
      tabHandler: this.tabHandler,
      frameId: this.id,
      frameHandler: this,
      csUuid: this.csUuid
    });
  }

  getTabsHandler() {
    return this.tabHandler.getTabsHandler();
  }

  // Queue a new action to execute sequentially.
  async newAction(callback) {
    if (this.cleared) return;
    var entry = {
      callback: callback,
      deferred: new util.Deferred()
    };
    this.actionNext.push(entry);
    this.nextAction();
    return await entry.deferred.promise;
  }

  // Executes pending actions sequentially.
  nextAction() {
    var self = this;
    // Let current action end if any.
    if (self.actionRunning !== undefined) return;
    // Get next action if any.
    if (self.cleared) return;
    var next = self.actionNext.shift();
    if (next === undefined) return;
    // Trigger callback, and complete its promise.
    self.actionRunning = next.deferred.promise;
    next.deferred.completeWith(next.callback);
    // Once done, execute next action if any.
    self.actionRunning.finally(() => {
      delete(self.actionRunning);
      self.nextAction();
    });
  }

  async setup() {
    var tabId = this.tabHandler.id;
    var frameId = this.id;

    // Probe the frame: inject some context (prepare a new UUID) and check
    // whether there already/still is a previous context.
    // If there is a previous context: page has not changed.
    // If there is no previous context: use the new one.
    // In either case, we should be only called right upon setting up the first
    // script, in which case there is nothing much to do in either situation.
    var newUuid = util.uuidv4();
    const csParams = {
      tabId: tabId,
      frameId: frameId,
      uuid: newUuid
    };
    var details = {
      frameId: frameId,
      code: `if (csParams === undefined) {
  var csParams = ${JSON.stringify(csParams)};
  var result = { csUuid: csParams.uuid, existed: false, url: location.href };
} else result = { csUuid: csParams.uuid, existed: true, url: location.href };
result;`,
      runAt: 'document_start'
    };

    // Notes:
    // Injection may fail if we are not permitted to execute script in the
    // frame. In this case, we usually get the error:
    //  Frame not found, or missing host permission
    // In may happen in various cases:
    //  - '<all_urls>' not used in permissions
    //  - frame is 'about:blank' and we did not enable matchAboutBlank
    //  - frame is privileged; this is e.g. the case for PDF files displayed
    //    with PDF.js by Firefox
    // Caller is expected to exclude those cases.
    var reused = this.used;
    try {
      var result = (await browser.tabs.executeScript(tabId, details))[0];
      if (settings.debug.misc) console.log('Tab=<%s> frame=<%s> scripts existed=<%s> csUuid=<%s>', tabId, frameId, result.existed, result.csUuid);
      this.used = true;
       // Use our brand new uuid when applicable.
      if (!result.existed) this.csUuid = newUuid;
      // Refresh our url.
      this.url = result.url;
      // We should have our known uuid (previous one, or brand new).
      if (result.csUuid !== this.csUuid) console.log('Tab=<%s> frame=<%s> already had been initialised with csUuid=<%s> instead of csUuid=<%s>', tabId, frameId, result.csUuid, this.csUuid);
      return {
        reused: reused,
        success: true,
        existed: result.existed
      };
    } catch (error) {
      console.log('Failed to setup tab=<%s> frame=<%s>: %o', tabId, frameId, error);
      return {
        reused: reused,
        success: false,
        existed: false
      };
    }
  }

  async setupScript(id, callback) {
    var self = this;
    return await self.newAction(() => {
      return self._setupScript(id, callback)
    });
  }

  // Setups script (to inject).
  // When applicable, injection is done through callback.
  // If script (id) is already injected, return the previously associated
  // promise.
  //
  // We take care of possible situations relatively to frame being updated
  // after script setup was queued and before its execution completes.
  // In all cases:
  //  - 'reset' is called right upon change; it clears any previously pending
  //    actions, and resets known injected scripts
  //  - caller is notified of change and will re-setup scripts if applicable;
  //    this can only happen after this script setup completes.
  //
  // 1. If frame is updated right before execution
  // Frame setup will be done before script setup. At 'worst':
  //  - script is not meant for the page after change, but should cope with it
  //  - caller will try to setup script again, which we will dismiss because
  //    already done
  //
  // 2. If frame is updated after frame setup check and before script injection
  // This script setup will fail due to missing frame setup.
  async _setupScript(id, callback) {
    var self = this;
    var tabHandler = self.tabHandler;
    var tabId = tabHandler.id;
    var frameId = self.id;

    if (self.cleared) return;
    // Setup frame for first script.
    if (Object.keys(self.scripts).length == 0) {
      var setup = await self.setup();
      if (self.cleared) return;
      if (!setup.existed && setup.reused) {
        // Frame did change.
        // There is no sure way to known it this script setup was requested
        // before the frame changed, or because of it; only when frame has not
        // been used can we assume it's its very first setup.
        // In all cases, go on with the script setup.
        // Also, do not touch 'actionNext': reset does clear it; any pending
        // action are scripts re-setup added by caller after reset.
        if (settings.debug.misc) console.log('Tab=<%s> frame=<%s> csUuid=<%s> has been updated', tabId, frameId, self.csUuid);
        // Notes:
        // Going on is the best approach.
        // If frame setup could be done, we will inject this script (and
        // possibly others pending).
        // If frame setup failed, we don't expect any other injection to
        // succeed. This would trigger multiple error logs though: for each
        // other script setup, we will re-try to setup frame.
        // In particular, upon issue it is not a good idea to re-trigger
        // (through observers) script setup without enough hinting, as it
        // may end in an endless injection attempt loop:
        //  1. first script setup triggers frame setup, which fails
        //  2. observer, notified of failure, queues a new script setup
        //  3. we got back to 1.
      }
    }
    // Nothing to do if script already setup.
    if (self.scripts[id] !== undefined) {
      if (settings.debug.misc) console.log('Tab=<%s> frame=<%s> csUuid=<%s> already has script=<%s>', tabId, frameId, self.csUuid, id);
      return self.scripts[id];
    }
    self.scripts[id] = callback().then(result => {
      if (settings.debug.misc) console.log('Set up script=<%s> in tab=<%s> frame=<%s> csUuid=<%s>: %o', id, tabId, frameId, self.csUuid, result);
      return {
        success: true,
        result: result
      };
    }).catch(error => {
      // Script injection actually failed: forget it, so that it can be injected
      // again if needed.
      delete(self.scripts[id]);
      console.log('Failed to setup script=<%s> in tab=<%s> frame=<%s> csUuid=<%s>: %o', id, tabId, frameId, self.csUuid, error);
      return {
        success: false,
        error: error
      };
    });
    return await self.scripts[id];
  }

}

class TabHandler {

  constructor(tabsHandler, tab) {
    this.id = tab.id;
    this.title = tab.title;
    this.tabsHandler = tabsHandler;
    this.frames = {};
  }

  url() {
    return this.frameHandler.url;
  }

  getTabsHandler() {
    return this.tabsHandler;
  }

  isActive() {
    return (this.getTabsHandler().activeTab.id == this.id);
  }

  // Resets frame, which is about to be (re)used.
  reset(details, notify) {
    // Reset main frame.
    // Note: notify observer even if we don't know the main frame.
    if (this.frameHandler !== undefined) this.frameHandler.reset(details, notify);
    else {
      var notifyDetails = Object.assign({}, notify, {
        tabId: this.id,
        tabHandler: this,
        frameId: 0
      });
      this.getTabsHandler().notifyObservers('tabReset', notifyDetails);
      this.getTabsHandler().notifyObservers('frameReset', notifyDetails);
    }
    // Remove all subframes.
    for (var frameHandler of Object.values(this.frames)) {
      if (frameHandler.id === 0) continue;
      if (settings.debug.misc) console.log('Removing tab=<%s> frame=<%s>', this.id, frameHandler.id);
      frameHandler.clear(true);
      delete(this.frames[frameHandler.id]);
    }
  }

  // Clears tab, which is about to be removed.
  clear() {
    // Code being executed asynchronously (async functions, or right after an
    // await statement) have to check whether 'cleared' has been set.
    this.cleared = true;
    for (var frameHandler of Object.values(this.frames)) {
      // Don't notify observers for each frame, as the tab itself is being
      // removed.
      frameHandler.clear(false);
    }
    this.frames = {};
  }

  async findFrames() {
    var self = this;
    await browser.webNavigation.getAllFrames({tabId: self.id}).then(frames => {
      for (var details of frames) {
        // Ignore 'about:blank' etc.
        if (!details.url.startsWith('http') && !details.url.startsWith('file')) continue;
        // Don't add frames we already known about: frames are only searched
        // when extension starts and is processing existing tabs. If a frame is
        // already known, we assume we were notified of its change before we
        // could explicitely add the tab: there is nothing else to do, as
        // scripts setup is already being done.
        self.addFrame(details, {skipExisting: true});
      }
    });
  }

  async addFrame(details, params) {
    if (this.cleared) return;
    params = params || {};
    var frameId = details.frameId;
    var frameHandler = this.frames[frameId];
    if (frameHandler !== undefined) {
      // If requested, skip processing existing frame.
      if (params.skipExisting) return;
      // Get fresh tab information.
      try {
        var tab = await browser.tabs.get(this.id);
        this.title = tab.title;
      } catch (error) {
      }
      // Frame is being reused: reset it.
      frameHandler.reset(details, { beforeNavigate: false, domLoaded: true });
    } else {
      // New frame.
      frameHandler = new FrameHandler(this, details);
      if (settings.debug.misc) console.log('Managing new tab=<%s> frame=<%s> url=<%s>', this.id, frameId, frameHandler.url);
      this.frames[frameId] = frameHandler;
      if (frameId === 0) this.frameHandler = frameHandler;
      this.getTabsHandler().notifyObservers('frameAdded', {
        tabId: this.id,
        tabHandler: this,
        frameId: frameId,
        frameHandler: frameHandler
      });
    }
  }

  resetFrame(details) {
    var frameId = details.frameId;
    var frameHandler = this.frames[frameId];
    // We are called ahead of time, before frame content is actually loaded.
    // We can ignore unknown frames, for which 'addFrame' will be called later.
    if (frameHandler === undefined) return;
    if (frameId === 0) this.reset(details, { beforeNavigate: true, domLoaded: false });
    else frameHandler.reset(details, { beforeNavigate: true, domLoaded: false });
  }

}

// Manages tabs and frames.
//
// Notes:
// Once created, it automatically listens to tab/frame changes.
//
// Observers can be added to be notified of changes. For each possible change,
// observers are only notified if they have a function of the same name.
// The possible changes to observe:
//  - tabAdded: a new tab has been added
//  - tabActivated: a tab has been activated
//  - tabReset: an existing tab is being reused
//  - tabRemoved: a tab is being removed
//  - frameAdded: a new frame has been added
//  - frameReset: an existing frame is being reused
//  - frameRemoved: a frame is being removed
// Tab and frame handlers are passed to observers when known, so that they don't
// have to look them up when needed.
//
// When a tab is being reused, both tabReset and frameReset (on the main frame)
// are triggered.
// tabReset and frameReset are usually triggered twice:
//  - when browser is about to navigate to target url
//  - when the frame DOM content has been loaded: the frame is ready to be used
// The former case sets beforeNavigate to true, the latter sets domLoaded.
//
// tabReset, tabRemove and frameReset are triggered even when tab/frame was
// actually not known by the handler. It may be useful when observers rely on
// other features that make them know about tabs/frames before the handler.
//
// When a tab is being removed, only tabRemoved is triggered: there is no
// frameRemoved for each (known) frame.
//
// Even if there is no change, tabActivated is called once for the active tab
// when the extension starts.
// For a given active tab, tabActivated may be called twice:
//  - when the tab is activated, but not managed yet
//  - when the tab is finally managed, and is still activated
// In the former, the passed tab handler is undefined; the notification is made
// so that observers can handle it early if possible (i.e. even without knowing
// the handler).
// In the latter, the handler is known and previousTabId is the same than tabId
// so that observers can deduce there is no actual change.
export class TabsHandler {

  constructor() {
    this.tabs = {};
    this.activeTab = {};
    this.observers = [];
    // Listen to tab/frame changes.
    this.setup();
  }

  addObserver(observer) {
    this.observers.push(observer);
  }

  notifyObservers() {
    var args = [...arguments];
    var callback = args.shift();
    for (var observer of this.observers) {
      if (typeof(observer[callback]) !== 'function') continue;
      observer[callback].apply(observer, args);
    }
  }

  // Adds tab and return tab handler.
  // If tab is known, existing handler is returned.
  async addTab(tab, findFrames) {
    var tabId = tab.id;
    var tabHandler = this.tabs[tabId];
    // Reminder: we may be called with outdated (since the query was done) tab
    // information.
    // So if the tab is already known, do nothing.
    if (tabHandler !== undefined) return tabHandler;

    if (settings.debug.misc) console.log('Managing new tab=<%s> url=<%s>', tabId, tab.url);
    this.tabs[tabId] = tabHandler = new TabHandler(this, tab);
    if (findFrames) await tabHandler.findFrames();
    this.notifyObservers('tabAdded', { tabId: tabId, tabHandler: tabHandler });
    // If this tab is supposed to be active, ensure it is still the case:
    //  - we must not know the active tab handler
    //  - if we know the active tab id, it must be this tab: in this case we
    //    will trigger a second 'tabActivated' notification, passing the known
    //    handler (which was undefined in the previous notification)
    if (tab.active && (this.activateTab.handler === undefined)) {
      // Either we did not know yet which tab was active, or we did not manage
      // yet this tab.
      if ((this.activeTab.id === undefined) || (this.activeTab.id === tabId)) {
        // We manage the tab now, and it really is the active tab.
        // previousTabId points to the active tab too, so that observer can
        // deduce there is no actual change (except for the handler known).
        this.activateTab({ previousTabId: tabId, tabId: tabId, windowId: tab.windowId });
      }
    }
    return tabHandler;
  }

  activateTab(details) {
    var tabId = details.tabId;
    var tabHandler = this.tabs[tabId];
    // Get previous handler to pass to observers.
    // Note: previousTabId is undefined if the tab does not exist anymore.
    // We let this as-is even though we may pass the previous handler if still
    // not removed here.
    var previousTabId = details.previousTabId;
    var previousTabHandler = this.activeTab.handler;
    if ((previousTabHandler === undefined) && (previousTabId !== undefined)) previousTabHandler = this.tabs[previousTabId];
    // Note: we still notify observers when handler is not (yet) known. In this
    // case the passed handled is undefined.
    // Once the tab become known, we are called again, and can then pass the
    // associated handler.
    this.activeTab = {
      id: tabId,
      handler: tabHandler
    };
    if (settings.debug.misc) console.log('Activated tab=<%s>', tabId);
    this.notifyObservers('tabActivated', {
      previousTabId: previousTabId,
      previousTabHandler: previousTabHandler,
      tabId: tabId,
      tabHandler: tabHandler
    });
  }

  // Adds frame and return frame handler.
  // If frame is known, existing handler is returned.
  // If tab is not yet known and this is its main frame, tab is added first.
  // If tab is not known and this is a subframe, frame is not added.
  async addFrame(details, params) {
    var self = this;
    var tabId = details.tabId;
    var tabHandler = self.tabs[tabId];
    if (tabHandler === undefined) {
      // Tab is unknown.
      // If this is the main frame, we will manage this new tab.
      // Otherwise, ignore this frame: we expect to be notified of a subframe
      // change before caller had time to initiate itself and get all current
      // tabs (and add associated frames).
      if (details.frameId !== 0) return;
      // Tab is not known yet, add it first.
      tabHandler = await browser.tabs.get(tabId).then(tab => {
        return self.addTab(tab);
      }, error => {
        console.log('Could not manage tab=<%s>: %o', tabId, error);
      });
    }
    if (tabHandler === undefined) return;
    return await tabHandler.addFrame(details, params);
  }

  resetFrame(details) {
    var tabHandler = this.tabs[details.tabId];
    if (tabHandler === undefined) return;
    tabHandler.resetFrame(details);
  }

  removeTab(tabId) {
    // Note: observers may have received messages related to a tab before the
    // handler, so notify them even if we don't know the tab.
    var tabHandler = this.tabs[tabId];
    this.notifyObservers('tabRemoved', { tabId: tabId, tabHandler: tabHandler });
    if (tabHandler === undefined) return;
    if (settings.debug.misc) console.log('Removing tab=<%s>', tabHandler.id);
    tabHandler.clear();
    delete(this.tabs[tabId]);
  }

  setup() {
    var self = this;
    // We register for changes before getting all current tabs, to prevent
    // missing any due to race conditions.
    // We listen to frames changes:
    //  - onBeforeNavigate: to trigger frame reset ASAP (before page is loaded)
    //  - onDOMContentLoaded: to inject scripts where appropriate
    //  - onCompleted: because sometimes onDOMContentLoaded is skipped
    //    e.g.: https://developer.mozilla.org/en-US/docs/Web/HTML/Element/embed
    // We don't listen to onCommitted (instead of onDOMContentLoaded) because
    // we may be called right before the frame document actually changes for
    // its new committed target; e.g. we may end up injecting script in the
    // previous (often 'about:blank' for subframes) page, which will be wiped
    // out right after.
    //
    // Depending on when script injection is requested and how the frame
    // behaves, it may be necessary to 'runAt' ASAP, i.e. 'document_start'
    // instead of 'document_end'. When listening to onDOMContentLoaded, this
    // should not make a difference though.
    // See: https://bugzilla.mozilla.org/show_bug.cgi?id=1499667

    // Listen to tabs being removed, so that we can clear them.
    browser.tabs.onRemoved.addListener(id => {
      self.removeTab(id);
    });
    // Listen to tab being activated.
    browser.tabs.onActivated.addListener(details => {
      self.activateTab(details);
    });

    // Listen to frame changes.
    var webNavigationFilter = { url: [{ schemes: ['file', 'http', 'https'] }] };
    browser.webNavigation.onBeforeNavigate.addListener(details => {
      self.resetFrame(details);
    }, webNavigationFilter);
    browser.webNavigation.onDOMContentLoaded.addListener(details => {
      self.addFrame(details);
    }, webNavigationFilter);
    browser.webNavigation.onCompleted.addListener(details => {
      // Don't add frames we already known about: if frame is already known we
      // assume onDOMContentLoaded was triggered.
      // For now we don't expect the situation (onDOMContentLoaded skipped) to
      // happen on the main frame, which would require more specific handling.
      self.addFrame(details, {skipExisting: true});
    }, webNavigationFilter);

    // Get all live (non-discarded) tabs to handle.
    browser.tabs.query({
      url: ['file:///*', 'http://*/*', 'https://*/*'],
      discarded: false
    }).then(tabs => {
      for (var tab of tabs) {
        self.addTab(tab, true);
      }
    });
  }

}
