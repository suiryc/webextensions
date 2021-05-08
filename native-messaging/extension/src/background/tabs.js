'use strict';

import { constants } from '../common/constants.js';
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
//
// Firefox prevents content script injection in many domains.
// See: https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Content_scripts
var excludedHosts = new Set(['accounts-static.cdn.mozilla.net', 'accounts.firefox.com', 'addons.cdn.mozilla.net', 'addons.mozilla.org', 'api.accounts.firefox.com', 'content.cdn.mozilla.net', 'content.cdn.mozilla.net', 'discovery.addons.mozilla.org', 'input.mozilla.org', 'install.mozilla.org', 'oauth.accounts.firefox.com', 'profile.accounts.firefox.com', 'support.mozilla.org', 'sync.services.mozilla.com', 'testpilot.firefox.com'
]);

class FrameHandler {

  constructor(tabHandler, details) {
    this.tabHandler = tabHandler;
    this.id = details.frameId;
    this.used = false;
    this.reset(details);
  }

  toJSON() {
    return {
      id: this.id,
      used: this.used,
      url: this.url,
      csUuid: this.csUuid,
      tabHandler: this.tabHandler
    };
  }

  // Resets frame, which is about to be (re)used.
  reset(details, notify) {
    var sameUrl = this.url == details.url;
    this.setUrl(details.url);
    // For each script (id), remember the associated promise, resolved with its
    // injection success and result/error.
    this.scripts = {};
    if (!this.cleared) this.actionNext = [];
    if (notify) {
      var notifyDetails = Object.assign({}, notify, {
        windowId: this.tabHandler.windowId,
        tabId: this.tabHandler.id,
        tabHandler: this.tabHandler,
        frameId: this.id,
        frameHandler: this,
        csUuid: this.csUuid,
        sameUrl: sameUrl
      });
      if (this.id == 0) this.getTabsHandler().notifyObservers(constants.EVENT_TAB_RESET, notifyDetails);
      this.getTabsHandler().notifyObservers(constants.EVENT_FRAME_RESET, notifyDetails);
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
    if (notify) this.getTabsHandler().notifyObservers(constants.EVENT_FRAME_REMOVED, {
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

  setUrl(url) {
    this.url = url;
    // Update parent tab url if we are the main frame.
    if (this.id == 0) this.tabHandler.url = url;
    delete(this.excludedHost);
  }

  isExcludedHost() {
    if (!('excludedHost' in this)) {
      this.excludedHost = false;
      var idx = this.url.indexOf('//');
      if (idx > 0) {
        var start = idx + 2;
        idx = this.url.indexOf('/', start);
        var domain = (idx > 0) ? this.url.substring(start, idx) : this.url.substring(start);
        this.excludedHost = excludedHosts.has(domain);
      }
    }
    return this.excludedHost;
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
    if (self.actionRunning) return;
    // Get next action if any.
    if (self.cleared) return;
    var next = self.actionNext.shift();
    if (!next) return;
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
    var tabHandler = this.tabHandler;
    var tabId = tabHandler.id;
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
      tabUrl: tabHandler.url,
      frameId: frameId,
      uuid: newUuid
    };
    var details = {
      frameId: frameId,
      code: `if (!csParams) {
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
      this.setUrl(result.url);
      // We should have our known uuid (previous one, or brand new).
      if (result.csUuid !== this.csUuid) console.log('Tab=<%s> frame=<%s> already had been initialised with csUuid=<%s> instead of csUuid=<%s>', tabId, frameId, result.csUuid, this.csUuid);
      return {
        reused: reused,
        success: true,
        existed: result.existed
      };
    } catch (error) {
      console.log('Failed to setup tab=<%s> title=<%s> frame=<%s> url=<%s>: %o', tabId, tabHandler.title, frameId, this.url, error);
      return {
        reused: reused,
        success: false,
        existed: false
      };
    }
  }

  async setupScript(id, callback) {
    var self = this;

    if (self.isExcludedHost()) {
      if (settings.debug.misc) console.log('Not setting up script=<%s> in tab=<%s> title=<%s> frame=<%s> url=<%s>: host is excluded', id, self.tabHandler.id, self.tabHandler.title, self.id, self.url);
      return;
    }

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
    if (!Object.keys(self.scripts).length) {
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
    if (self.scripts[id]) {
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
      console.log('Failed to setup script=<%s> in tab=<%s> title=<%s> frame=<%s> url=<%s> csUuid=<%s>: %o', id, tabId, tabHandler.title, frameId, this.url, self.csUuid, error);
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
    this.windowId = tab.windowId;
    this.url = tab.url;
    this.title = tab.title;
    this.tabsHandler = tabsHandler;
    this.frames = {};
    // Properties managed by the extension.
    this.extensionProperties = {};
  }

  // Only keep important fields (and prevent 'cyclic object value' error) for JSON.
  toJSON() {
    return {
      id: this.id,
      windowId: this.windowId,
      url: this.url,
      title: this.title
    };
  }

  getTabsHandler() {
    return this.tabsHandler;
  }

  isActive() {
    return (this.getTabsHandler().getActiveTab(this.windowId).id == this.id);
  }

  isFocused() {
    return (this.getTabsHandler().focusedTab.id == this.id);
  }

  // Resets frame, which is about to be (re)used.
  reset(details, notify) {
    // Reset main frame.
    // Note: notify observer even if we don't know the main frame.
    if (this.frameHandler) this.frameHandler.reset(details, notify);
    else {
      var notifyDetails = Object.assign({}, notify, {
        windowId: this.windowId,
        tabId: this.id,
        tabHandler: this,
        frameId: 0
      });
      this.getTabsHandler().notifyObservers(constants.EVENT_TAB_RESET, notifyDetails);
      this.getTabsHandler().notifyObservers(constants.EVENT_FRAME_RESET, notifyDetails);
    }
    // Remove all subframes.
    for (var frameHandler of Object.values(this.frames)) {
      if (frameHandler.id === 0) continue;
      if (settings.debug.misc) console.log('Removing tab=<%s> frame=<%s>', this.id, frameHandler.id);
      frameHandler.clear(true);
      delete(this.frames[frameHandler.id]);
    }
    // Reset properties last, as observers may need it.
    this.resetExtensionProperties();
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
    this.resetExtensionProperties();
  }

  resetExtensionProperties() {
    for (var [key, entry] of Object.entries(this.extensionProperties)) {
      if (entry.keepOnReset) continue;
      delete(this.extensionProperties[key]);
    }
  }

  getExtensionProperty(details) {
    var key = details.key;
    var create = details.create;
    var entry = this.extensionProperties[key];
    if (!entry && create) {
      entry = this.extensionProperties[key] = {
        prop: create(this),
        keepOnReset: details.keepOnReset
      }
    }
    if (entry) return entry.prop;
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
    if (frameHandler) {
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
      this.getTabsHandler().notifyObservers(constants.EVENT_FRAME_ADDED, {
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
    if (!frameHandler) return;
    if (frameId === 0) this.reset(details, { beforeNavigate: true, domLoaded: false });
    else frameHandler.reset(details, { beforeNavigate: true, domLoaded: false });
  }

}

// Manages tabs and frames.
//
// Notes:
// Once created, it automatically listens to window/tab/frame changes.
//
// At least in Firefox:
//  - windowId starts at 1
//  - tabId starts at 1
//  - frameId is 0 for the main frame
//
// Observers can be added to be notified of changes. For each possible change,
// observers are only notified if they have a function of the same name.
// The possible changes to observe:
//  - windowFocused: a window has focus
//  - windowRemoved: a window has been removed
//  - tabActivated: a tab has been activated
//    * may be called twice if tab handler does not exist yet and is created
//      later (frame added) while the tab is still active
//  - tabAdded: a new tab has been added
//  - tabAttached: a tab has been attached to a window
//  - tabCreated: a new tab has been created
//  - tabDetached: a tab has been detached from a window
//  - tabFocused: a tab has focus
//  - tabRemoved: a tab is being removed
//  - tabReset: an existing tab is being reused
//  - frameAdded: a new frame has been added
//  - frameRemoved: a frame is being removed
//  - frameReset: an existing frame is being reused
// Tab and frame handlers are passed to observers when known, so that they don't
// have to look them up when needed.
// Some changes are directly triggered by corresponding events: windowFocused,
// tabActivated, tabAttached, tabCreated, tabDetached, tabRemoved.
// Other changes are triggered by events in specific cases.
//
// Each windowId is unique.
// Each tabId is unique, even amongst all windows.
// Each frame is identified by its parent tabId and its frameId, even though in
// the case of non-main frames Firefox appear to use unique frame ids amongst
// all tabs.
// Usually we only need to relate to one element and its parent:
//  - a tab in a window
//  - a frame in a tab
// As such, we usually only log windowId+tabId or tabId+frameId, but not all
// three together.
// Most of the time there is no need to take into account/deal with the window
// a tab belongs to. The exception is when dealing with tab activation (see
// below).
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
// Tab activation is per window: there is one active tab per window. Selecting
// a tab in another window first changes focus to the new window before the tab
// is activated. This also means than upon activation, the previousTabId if any
// corresponds to another tab in the same window, hence the fact there is only
// one windowId and no previousWindowId.
// Since observers may need to determine which tab is actually selected by the
// user, which happens when focusing a new window or activating a new tab, a
// fake change tabFocused is forged when either windowFocused or tabActivated
// happens. In this case it is only needed to observe the former instead of the
// latter two.
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
//
// The main relations between windows and tabs:
// When a tab is opened in a new window:
//  - the window and tab are created
//  - the tab is activated and window focused
//  - the tab main frame navigates to the target url
// When a tab is moved to another window:
//  - the origin window is focused if not already
//  - if tab is not moved to an existing window
//    - a new window is created
//    - an 'empty' tab is created and activated in the new window
//    - the new window gets focus
//  - the moved tab is detached from the origin window
//  - the moved tab is attached to the target window
//  - the previously focused window gets its focus back
//  - a new tab is activated in the origin window, if one remain
//  - the moved tab is activated (in the target window)
//  - the previous window is removed if it was its last tab
// When a window is closed:
//  - each tab is individually removed; which means obervers usually only need
//    to handle tabRemoved, not windowRemoved
//  - the window is removed
//  - windows focus is changed (to another window or to none)
// When a tab in another window is activated (by user):
//  - the target window is focused
//  - the tab is activated
//
// Properties, accessed by key name, can be added to managed tabs.
// Those are removed when tab is reset, unless caller asks to keep them.
// Observers can e.g. use this to store objects linked to tab lifecycle.
export class TabsHandler {

  constructor() {
    this.tabs = {};
    this.focusedTab = {};
    this.activeTabs = {};
    this.observers = [];
    // Listen to tab/frame changes.
    this.setup();
  }

  getActiveTab(windowId) {
    return (this.activeTabs[windowId] || {});
  }

  getFrame(details) {
    // Get request tab handler if known.
    var tabHandler = this.tabs[details.tabId];
    if (!tabHandler) return;
    // Ensure requested frame belongs to the tab.
    var frameHandler = tabHandler.frames[details.frameId];
    if (!frameHandler) return;
    if (details.csUuid && (frameHandler.csUuid !== details.csUuid)) return;
    return frameHandler;
  }

  addObserver(observer, silent) {
    this.observers.push(observer);
    if (silent) return;
    // Trigger 'fake' events depending on observed ones.
    var hasTabAdded = util.hasMethod(observer, constants.EVENT_TAB_ADDED);
    var hasFrameAdded = util.hasMethod(observer, constants.EVENT_FRAME_ADDED);
    // Reminder: object keys are strings.
    if (hasTabAdded || hasFrameAdded) {
      for (var tabHandler of Object.values(this.tabs)) {
        if (hasTabAdded) this.notifyObserver(observer, constants.EVENT_TAB_ADDED, { windowId: tabHandler.windowId, tabId: tabHandler.id, tabHandler: tabHandler });
        if (hasFrameAdded) {
          for (var frameHandler of Object.values(tabHandler.frames)) {
            this.notifyObserver(observer, constants.EVENT_FRAME_ADDED, {
              tabId: tabHandler.id,
              tabHandler: tabHandler,
              frameId: frameHandler.id,
              frameHandler: frameHandler
            });
          }
        }
      }
    }
    if (util.hasMethod(observer, constants.EVENT_TAB_ACTIVATED)) {
      for (var tabActive of Object.values(this.activeTabs)) {
        var tabId = tabActive.id;
        var tabHandler = tabActive.handler;
        this.notifyObserver(observer, constants.EVENT_TAB_ACTIVATED, {
          windowId: tabActive.windowId,
          previousTabId: tabId,
          previousTabHandler: tabHandler,
          tabId: tabId,
          tabHandler: tabHandler
        });
      }
    }
    if (util.hasMethod(observer, constants.EVENT_WINDOW_FOCUSED) && this.focusedWindowId) {
      this.notifyObserver(observer, constants.EVENT_WINDOW_FOCUSED, { previousWindowId: this.focusedWindowId, windowId: this.focusedWindowId });
    }
    if (util.hasMethod(observer, constants.EVENT_TAB_FOCUSED) && this.focusedTab.id) {
      var windowId = this.focusedTab.windowId;
      var tabId = this.focusedTab.id;
      var tabHandler = this.focusedTab.handler;
      this.notifyObserver(observer, constants.EVENT_TAB_FOCUSED, {
        previousWindowId: windowId,
        previousTabId: tabId,
        previousTabHandler: tabHandler,
        windowId: windowId,
        tabId: tabId,
        tabHandler: tabHandler
      });
    }
  }

  removeObserver(observer) {
    var idx;
    while ((idx = this.observers.indexOf(observer)) !== -1) {
      this.observers.splice(idx, 1);
    }
  }

  notifyObservers() {
    var args = [...arguments];
    var callback = args.shift();
    for (var observer of this.observers) {
      util.callMethod(observer, callback, args);
    }
  }

  notifyObserver() {
    var args = [...arguments];
    var observer = args.shift();
    var callback = args.shift();
    util.callMethod(observer, callback, args);
  }

  // Adds tab and return tab handler.
  // If tab is known, existing handler is returned.
  async addTab(tab, findFrames) {
    var windowId = tab.windowId;
    var tabId = tab.id;
    var tabHandler = this.tabs[tabId];
    // Reminder: we may be called with outdated (since the query was done) tab
    // information.
    // So if the tab is already known, do nothing.
    if (tabHandler) return tabHandler;

    if (settings.debug.misc) console.log('Managing new window=<%s> tab=<%s> url=<%s>', windowId, tabId, tab.url);
    this.tabs[tabId] = tabHandler = new TabHandler(this, tab);
    this.notifyObservers(constants.EVENT_TAB_ADDED, { windowId: windowId, tabId: tabId, tabHandler: tabHandler });
    if (findFrames) await tabHandler.findFrames();
    // If this tab is supposed to be active, ensure it is still the case:
    //  - we must not know the active tab handler (for its windowId)
    //  - if we know the active tab id, it must be this tab: in this case we
    //    will trigger a second 'tabActivated' notification, passing the known
    //    handler (which was undefined in the previous notification)
    var activeTab = this.getActiveTab(windowId);
    if (tab.active && !activeTab.handler) {
      // Either we did not know yet which tab was active, or we did not manage
      // yet this tab.
      if (!activeTab.id || (activeTab.id === tabId)) {
        // We manage the tab now, and it really is the active tab.
        // previousTabId points to the active tab too, so that observer can
        // deduce there is no actual change (except for the handler known).
        this.activateTab({ previousTabId: tabId, tabId: tabId, windowId: windowId });
      }
    }
    return tabHandler;
  }

  activateTab(details) {
    var windowId = details.windowId;
    var tabId = details.tabId;
    var tabHandler = this.tabs[tabId];
    // Get previous handler to pass to observers.
    // Note: previousTabId is undefined if the tab does not exist anymore.
    // We let this as-is even though we may pass the previous handler if still
    // not removed here.
    var previousTabId = details.previousTabId;
    var previousTabHandler = this.getActiveTab(windowId).handler;
    if (!previousTabHandler && previousTabId) previousTabHandler = this.tabs[previousTabId];
    // Note: we still notify observers when handler is not (yet) known. In this
    // case the passed handled is undefined.
    // Once the tab become known, we are called again, and can then pass the
    // associated handler.
    var focused = (windowId === this.focusedWindowId);
    this.activeTabs[windowId] = {
      id: tabId,
      windowId: windowId,
      handler: tabHandler
    };
    if (focused) this.focusedTab = this.activeTabs[windowId];
    if (settings.debug.misc) console.log('Activated window=<%s> tab=<%s>', windowId, tabId);
    this.notifyObservers(constants.EVENT_TAB_ACTIVATED, {
      windowId: windowId,
      previousTabId: previousTabId,
      previousTabHandler: previousTabHandler,
      tabId: tabId,
      tabHandler: tabHandler
    });
    if (focused) {
      // This tab window is focused, which means the activated tab is the
      // currently focused tab.
      // Also happens when user selects a non-activate tab in a non-focused
      // window: window is focused then tab activated.
      this.notifyObservers(constants.EVENT_TAB_FOCUSED, {
        previousWindowId: windowId,
        previousTabId: previousTabId,
        previousTabHandler: previousTabHandler,
        windowId: windowId,
        tabId: tabId,
        tabHandler: tabHandler
      });
    }
    // else: this tab is not focused because its parent window is not.
  }

  focusWindow(windowId) {
    // Note: windows.WINDOW_ID_NONE is used when no window has the focus.
    var previousWindowId = this.focusedWindowId;
    this.focusedWindowId = windowId;
    var previousFocusedTab = this.focusedTab;
    var focusedTab = this.focusedTab = this.activeTabs[windowId] || {};
    if (settings.debug.misc) {
      if (windowId !== browser.windows.WINDOW_ID_NONE) console.log('Focused window=<%s>', windowId);
      else console.log('No more window focused');
    }
    this.notifyObservers(constants.EVENT_WINDOW_FOCUSED, { previousWindowId: previousWindowId, windowId: windowId });
    // Don't notify tab focusing if there is none.
    if (focusedTab.id) {
      this.notifyObservers(constants.EVENT_TAB_FOCUSED, {
        previousWindowId: previousWindowId,
        previousTabId: previousFocusedTab.id,
        previousTabHandler: previousFocusedTab.handler,
        windowId: windowId,
        tabId: focusedTab.id,
        tabHandler: focusedTab.handler
      });
    }
  }

  // Adds frame and return frame handler.
  // If frame is known, existing handler is returned.
  // If tab is not yet known and this is its main frame, tab is added first.
  // If tab is not known and this is a subframe, frame is not added.
  async addFrame(details, params) {
    var self = this;
    var tabId = details.tabId;
    var tabHandler = self.tabs[tabId];
    if (!tabHandler) {
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
    if (!tabHandler) return;
    return await tabHandler.addFrame(details, params);
  }

  resetFrame(details) {
    var tabHandler = this.tabs[details.tabId];
    if (!tabHandler) return;
    tabHandler.resetFrame(details);
  }

  createTab(tab) {
    var windowId = tab.windowId;
    var tabId = tab.id;
    this.notifyObservers(constants.EVENT_TAB_CREATED, { windowId: windowId, tabId: tabId, tab: tab });
  }

  detachTab(details) {
    var windowId = details.oldWindowId;
    var tabId = details.tabId;
    var tabHandler = this.tabs[tabId];
    this.notifyObservers(constants.EVENT_TAB_DETACHED, { windowId: windowId, tabId: tabId, tabHandler: tabHandler });
  }

  attachTab(details) {
    var windowId = details.newWindowId;
    var tabId = details.tabId;
    var tabHandler = this.tabs[tabId];
    if (tabHandler) tabHandler.windowId = windowId;
    this.notifyObservers(constants.EVENT_TAB_ATTACHED, { windowId: windowId, tabId: tabId, tabHandler: tabHandler });
  }

  removeTab(tabId, windowId) {
    // Note: observers may have received messages related to a tab before the
    // handler, so notify them even if we don't know the tab.
    var tabHandler = this.tabs[tabId];
    this.notifyObservers(constants.EVENT_TAB_REMOVED, {
      windowId: windowId,
      tabId: tabId,
      tabHandler: tabHandler
    });
    if (!tabHandler) return;
    if (settings.debug.misc) console.log('Removing window=<%s> tab=<%s>', tabHandler.windowId, tabHandler.id);
    tabHandler.clear();
    delete(this.tabs[tabId]);
  }

  removeWindow(windowId) {
    this.notifyObservers(constants.EVENT_WINDOW_REMOVED, {windowId: windowId});
    if (settings.debug.misc) console.log('Removing window=<%s>', windowId);
    delete(this.activeTabs[windowId]);
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

    // Register a dummy observer for debugging purposes.
    var dummyObserver = {};
    constants.EVENTS_TABS.forEach(key => {
      dummyObserver[key] = function() {
        if (settings.debug.tabs.events) console.log.apply(this, [`observer.${key}`].concat(Array.from(arguments)))
      }
    });
    this.addObserver(dummyObserver);

    // Listen to windows being removed or focused.
    // windows.onRemoved parameters: windowId
    browser.windows.onRemoved.addListener(function(windowId) {
      if (settings.debug.tabs.events) console.log.apply(this, ['windows.onRemoved'].concat(Array.from(arguments)))
      self.removeWindow(windowId);
    });
    // Note: listening on focus change triggers an initial event (so that we
    // known which window is focused).
    // windows.onFocusChanged parameters: windowId
    browser.windows.onFocusChanged.addListener(function(windowId) {
      if (settings.debug.tabs.events) console.log.apply(this, ['windows.onFocusChanged'].concat(Array.from(arguments)))
      self.focusWindow(windowId);
    });

    // Listen to tabs being removed, activated, created, attached ot detached.
    // There is no onUpdated triggered when tab is moved to another window. We
    // can react upon onAttached, or simply wait for the onActivated which is
    // triggered in this case: the target window gets focus then the tab moved
    // in the window gets activated (with its new windowId).
    // tabs.onRemoved parameters:
    //  - tabId
    //  - removeInfo: {windowId, isWindowClosing}
    browser.tabs.onRemoved.addListener(function(tabId, details) {
      if (settings.debug.tabs.events) console.log.apply(this, ['tabs.onRemoved'].concat(Array.from(arguments)))
      self.removeTab(tabId, details.windowId);
    });
    // tabs.onActivated parameters:
    //  - activeInfo: {tabId, windowId, previousTabId}
    browser.tabs.onActivated.addListener(function(details) {
      if (settings.debug.tabs.events) console.log.apply(this, ['tabs.onActivated'].concat(Array.from(arguments)))
      self.activateTab(details);
    });
    // tabs.onCreated parameters: Tab
    browser.tabs.onCreated.addListener(function(details) {
      if (settings.debug.tabs.events) console.log.apply(this, ['tabs.onCreated'].concat(Array.from(arguments)))
      self.createTab(details);
    });
    // tabs.onAttached parameters:
    //  - tabId
    //  - attachInfo: {newWindowId, newPosition}
    browser.tabs.onAttached.addListener(function(tabId, details) {
      if (settings.debug.tabs.events) console.log.apply(this, ['tabs.onAttached'].concat(Array.from(arguments)))
      self.attachTab(Object.assign({tabId}, details));
    });
    // tabs.onDetached parameters:
    //  - tabId
    //  - detachInfo: {oldWindowId, oldPosition}
    browser.tabs.onDetached.addListener(function(tabId, details) {
      if (settings.debug.tabs.events) console.log.apply(this, ['tabs.onDetached'].concat(Array.from(arguments)))
      self.detachTab(Object.assign({tabId}, details));
    });

    // Listen to frame changes.
    // Usually we only want to track file/http(s) pages. But in the case of
    // onBeforeNavigate which we listen to reset known tabs/frames, it is better
    // to track all pages so that we do reset whenever the url do change, even
    // in 'about:blank'/'about:home'/etc. cases.
    var webNavigationFilter = { url: [{ schemes: ['file', 'http', 'https'] }] };
    browser.webNavigation.onBeforeNavigate.addListener(function(details) {
      if (settings.debug.tabs.events) console.log.apply(this, ['webNavigation.onBeforeNavigate'].concat(Array.from(arguments)))
      self.resetFrame(details);
    });
    browser.webNavigation.onDOMContentLoaded.addListener(function(details) {
      if (settings.debug.tabs.events) console.log.apply(this, ['webNavigation.onDOMContentLoaded'].concat(Array.from(arguments)))
      self.addFrame(details);
    }, webNavigationFilter);
    browser.webNavigation.onCompleted.addListener(function(details) {
      // Don't add frames we already known about: if frame is already known we
      // assume onDOMContentLoaded was triggered.
      // For now we don't expect the situation (onDOMContentLoaded skipped) to
      // happen on the main frame, which would require more specific handling.
      if (settings.debug.tabs.events) console.log.apply(this, ['webNavigation.onCompleted'].concat(Array.from(arguments)))
      self.addFrame(details, {skipExisting: true});
    }, webNavigationFilter);

    // Get all live (non-discarded) tabs to handle.
    // First get the focused window, as it is needed to properly populate the
    // focused tab too.
    browser.windows.getLastFocused().then(w => {
      self.focusWindow(w.id);
      browser.tabs.query({discarded: false}).then(tabs => {
        for (var tab of tabs) {
          self.addTab(tab, true);
        }
      });
    });
  }

}
