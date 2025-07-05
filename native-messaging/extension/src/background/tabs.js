'use strict';

import { constants } from '../common/constants.js';
import * as util from '../common/util.js';
import { settings } from '../common/settings.js';


// Notes:
// We could try to manage frames and content scripts injection from here, by
// listening to webNavigation stages, however it requires fine and complex
// handing in order to prevent - as much as possible - race conditions due to
// the use of Promise/async when tab/frame is reset/reloaded, and also try
// to prevent multiple injection of the same script in the frame.
//
// Alternatively we can let the extension (manifest) execute content script
// automatically, and have it notify us so that we discover new tab/frames.
// We generate one uuid in content scripts. It is shared in frame global
// context between all scripts running there, and automatically embedded
// in messages sent by scripts.
// It can then be used to:
//  - let tabs handler detect whether a frame is brand new or already known
//  - let caller ensure a message to process is still valid (belongs to a
//    frame not yet resetted/removed)
//
// We assume that most of the time the ordering of events will be correct.

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
    this.csUuid = details.csUuid;
    let sameUrl = this.url == details.url;
    this.setUrl(details.url);
    // Belt and suspenders: trigger parent tab refreshing if we are the main frame.
    // It should receive an onUpdated due to e.g. url change, but we prefer ensure
    // it will refresh.
    if (this.id == 0) this.tabHandler.refresh();
    // For each script (id), remember the associated promise, resolved with its
    // injection success and result/error.
    this.scripts = {};
    if (notify) {
      let notifyDetails = Object.assign({}, notify, {
        windowId: this.tabHandler.windowId,
        tabId: this.tabHandler.id,
        tabHandler: this.tabHandler,
        frameId: this.id,
        frameHandler: this,
        csUuid: this.csUuid,
        sameUrl
      });
      if (this.id == 0) this.getTabsHandler().notifyObservers(constants.EVENT_TAB_RESET, notifyDetails);
      this.getTabsHandler().notifyObservers(constants.EVENT_FRAME_RESET, notifyDetails);
    }
  }

  // Clears frame, which is about to be removed.
  clear(notify) {
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
  }

}

class TabHandler {

  constructor(tabsHandler, tab) {
    this.id = tab.id;
    this.windowId = tab.windowId;
    // Note: tab url will be set in 'update'.
    this.tabsHandler = tabsHandler;
    this.frames = {};
    // Properties managed by the extension.
    this.extensionProperties = new util.PropertiesHandler(this);
    this.update(tab);
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

  async refresh() {
    try {
      this.update(await browser.tabs.get(this.id));
    } catch (error) {
    }
  }

  update(tab) {
    let self = this;
    // Notes:
    // The url is updated through main frame handling when navigating to a new
    // URL. But sometimes the page do change its URL, remaining on the same site
    // and only changing parts of the page content.
    // Sometimes we get notified of an URL change, but the value remains the
    // same. If there is no change, ignore it (and especially don't notify
    // listeners).
    //
    // At least refresh what could change: title.
    let changes = {};
    if (tab.title != self.title) self.title = changes.title = tab.title;

    // Freshly created tab title is often the url without scheme. In this case,
    // listen to changes (and unlisten once tab loading is complete).
    if ((tab.status == 'loading') && tab.url.endsWith(tab.title)) self.addTitleListener();
    // When page has been loaded, let some more time for title change.
    if (tab.status == 'complete') self.scheduleRemoveTitleListener();

    if (tab.url != self.url) {
      self.url = changes.url = tab.url;

      // Ensure main frame URL is up to date too.
      if (self.frameHandler) self.frameHandler.setUrl(tab.url);
    }

    return changes;
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

  addTitleListener() {
    let self = this;

    if (self.titleListener) return;

    self.titleListener = function(tabId, tabChanges, tab) {
      if (settings.debug.tabs.events) console.log.apply(console, ['tabs.onUpdated', ...arguments]);
      // Let nominal code handle any change.
      self.tabsHandler.updateTab(tab, tabChanges);
    };
    browser.tabs.onUpdated.addListener(self.titleListener, {tabId: self.id, properties: ['title']});
  }

  removeTitleListener(listener) {
    if (!listener) listener = this.titleListener;
    if (!listener) return;

    // Belt ans suspenders: remove the listener unconditionally, even though we
    // expect it would have already been done if a new one was created.
    browser.tabs.onUpdated.removeListener(listener);
    // Make sure to not delete any new one.
    if (this.titleListener === listener) delete(this.titleListener);
  }

  scheduleRemoveTitleListener() {
    let self = this;
    // Remember the listener to remove, in case page is changed in the meantime
    // (and another listener is created).
    let listener = self.titleListener;
    if (!listener) return;

    setTimeout(() => {
      self.removeTitleListener(listener);
    }, 2000);
  }

  // Resets frame, which is about to be (re)used.
  reset(details, notify) {
    this.removeTitleListener();
    // Reset main frame.
    // Note: notify observer even if we don't know the main frame.
    if (this.frameHandler) this.frameHandler.reset(details, notify);
    else {
      let notifyDetails = Object.assign({}, notify, {
        windowId: this.windowId,
        tabId: this.id,
        tabHandler: this,
        frameId: 0
      });
      this.getTabsHandler().notifyObservers(constants.EVENT_TAB_RESET, notifyDetails);
      this.getTabsHandler().notifyObservers(constants.EVENT_FRAME_RESET, notifyDetails);
    }
    // Remove all subframes.
    for (let frameHandler of Object.values(this.frames)) {
      if (frameHandler.id === 0) continue;
      if (settings.debug.misc) console.log(`Removing tab=<${this.id}> frame=<${frameHandler.id}>`);
      frameHandler.clear(true);
      delete(this.frames[frameHandler.id]);
    }
    // Reset properties last, as observers may need it.
    this.extensionProperties.reset();
  }

  // Clears tab, which is about to be removed.
  clear() {
    // Code being executed asynchronously (async functions, or right after an
    // await statement) have to check whether 'cleared' has been set.
    this.cleared = true;
    for (let frameHandler of Object.values(this.frames)) {
      // Don't notify observers for each frame, as the tab itself is being
      // removed.
      frameHandler.clear(false);
    }
    this.frames = {};
    this.extensionProperties.reset();
  }

  async addFrame(details) {
    if (this.cleared) return;
    let frameId = details.frameId;
    let frameHandler = this.frames[frameId];
    if (frameHandler) {
      // If the uuid is the same, we already know this frame (content script
      // maybe reconnected, or there are multiple content scripts running).
      if (frameHandler.csUuid == details.csUuid) return;
      // If this is the main frame, we expect the tab to be reused (reloading
      // or navigation to new url): update handler with fresh tab information.
      // Note: since we reset (and remove) non-main frames in this case, we
      // actually don't expect to be here for non-main frames.
      if (!frameId) await this.refresh();
      // Frame is being reused: reset it.
      frameHandler.reset(details, { beforeNavigate: false, domLoaded: true });
    } else {
      // New frame.
      frameHandler = new FrameHandler(this, details);
      if (settings.debug.misc) console.log(`Managing new tab=<${this.id}> frame=<${frameId}> csUuid=<${frameHandler.csUuid}> url=<${frameHandler.url}>`);
      this.frames[frameId] = frameHandler;
      if (frameId === 0) this.frameHandler = frameHandler;
      this.getTabsHandler().notifyObservers(constants.EVENT_FRAME_ADDED, {
        tabId: this.id,
        tabHandler: this,
        frameId,
        frameHandler
      });
    }
  }

  resetFrame(details) {
    let frameId = details.frameId;
    let frameHandler = this.frames[frameId];
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
    let tabHandler = this.tabs[details.tabId];
    if (!tabHandler) return;
    // Ensure requested frame belongs to the tab.
    let frameHandler = tabHandler.frames[details.frameId];
    if (!frameHandler) return;
    if (details.csUuid && (frameHandler.csUuid !== details.csUuid)) return;
    return frameHandler;
  }

  addObserver(observer, silent) {
    this.observers.push(observer);
    if (silent) return;
    // Trigger 'fake' events depending on observed ones.
    let hasTabAdded = util.hasMethod(observer, constants.EVENT_TAB_ADDED);
    let hasFrameAdded = util.hasMethod(observer, constants.EVENT_FRAME_ADDED);
    // Reminder: object keys are strings.
    if (hasTabAdded || hasFrameAdded) {
      for (let tabHandler of Object.values(this.tabs)) {
        if (hasTabAdded) this.notifyObserver(observer, constants.EVENT_TAB_ADDED, { windowId: tabHandler.windowId, tabId: tabHandler.id, tabHandler });
        if (hasFrameAdded) {
          for (let frameHandler of Object.values(tabHandler.frames)) {
            this.notifyObserver(observer, constants.EVENT_FRAME_ADDED, {
              tabId: tabHandler.id,
              tabHandler,
              frameId: frameHandler.id,
              frameHandler
            });
          }
        }
      }
    }
    if (util.hasMethod(observer, constants.EVENT_TAB_ACTIVATED)) {
      for (let tabActive of Object.values(this.activeTabs)) {
        let tabId = tabActive.id;
        let tabHandler = tabActive.handler;
        this.notifyObserver(observer, constants.EVENT_TAB_ACTIVATED, {
          windowId: tabActive.windowId,
          previousTabId: tabId,
          previousTabHandler: tabHandler,
          tabId,
          tabHandler
        });
      }
    }
    if (util.hasMethod(observer, constants.EVENT_WINDOW_FOCUSED) && this.focusedWindowId) {
      this.notifyObserver(observer, constants.EVENT_WINDOW_FOCUSED, { previousWindowId: this.focusedWindowId, windowId: this.focusedWindowId });
    }
    if (util.hasMethod(observer, constants.EVENT_TAB_FOCUSED) && this.focusedTab.id) {
      let windowId = this.focusedTab.windowId;
      let tabId = this.focusedTab.id;
      let tabHandler = this.focusedTab.handler;
      this.notifyObserver(observer, constants.EVENT_TAB_FOCUSED, {
        previousWindowId: windowId,
        previousTabId: tabId,
        previousTabHandler: tabHandler,
        windowId,
        tabId,
        tabHandler
      });
    }
  }

  removeObserver(observer) {
    let idx;
    while ((idx = this.observers.indexOf(observer)) !== -1) {
      this.observers.splice(idx, 1);
    }
  }

  notifyObservers() {
    let args = [...arguments];
    let callback = args.shift();
    for (let observer of this.observers) {
      util.callMethod(observer, callback, args);
    }
  }

  notifyObserver() {
    let args = [...arguments];
    let observer = args.shift();
    let callback = args.shift();
    util.callMethod(observer, callback, args);
  }

  // Adds tab and return tab handler.
  // If tab is known, existing handler is returned.
  async addTab(tab) {
    let windowId = tab.windowId;
    let tabId = tab.id;
    let tabHandler = this.tabs[tabId];
    // Reminder: we may be called with outdated (since the query was done) tab
    // information.
    // So if the tab is already known, do nothing.
    if (tabHandler) return tabHandler;

    if (settings.debug.misc) console.log(`Managing new window=<${windowId}> tab=<${tabId}> url=<${tab.url}>`);
    this.tabs[tabId] = tabHandler = new TabHandler(this, tab);
    this.notifyObservers(constants.EVENT_TAB_ADDED, { windowId, tabId, tabHandler });
    // If this tab is supposed to be active, ensure it is still the case:
    //  - we must not know the active tab handler (for its windowId)
    //  - if we know the active tab id, it must be this tab: in this case we
    //    will trigger a second 'tabActivated' notification, passing the known
    //    handler (which was undefined in the previous notification)
    let activeTab = this.getActiveTab(windowId);
    if (tab.active && !activeTab.handler) {
      // Either we did not know yet which tab was active, or we did not manage
      // yet this tab.
      if (!activeTab.id || (activeTab.id === tabId)) {
        // We manage the tab now, and it really is the active tab.
        // previousTabId points to the active tab too, so that observer can
        // deduce there is no actual change (except for the handler known).
        this.activateTab({ previousTabId: tabId, tabId, windowId });
      }
    }
    return tabHandler;
  }

  activateTab(details) {
    let windowId = details.windowId;
    let tabId = details.tabId;
    let tabHandler = this.tabs[tabId];
    // Get previous handler to pass to observers.
    // Note: previousTabId is undefined if the tab does not exist anymore.
    // We let this as-is even though we may pass the previous handler if still
    // not removed here.
    let previousTabId = details.previousTabId;
    let previousTabHandler = this.getActiveTab(windowId).handler;
    if (!previousTabHandler && previousTabId) previousTabHandler = this.tabs[previousTabId];
    // Note: we still notify observers when handler is not (yet) known. In this
    // case the passed handler is undefined.
    // Once the tab become known, we are called again, and can then pass the
    // associated handler.
    this.activeTabs[windowId] = {
      id: tabId,
      windowId,
      handler: tabHandler
    };
    if (settings.debug.misc) console.log(`Activated window=<${windowId}> tab=<${tabId}>`);
    this.notifyObservers(constants.EVENT_TAB_ACTIVATED, {
      windowId,
      previousTabId,
      previousTabHandler,
      tabId,
      tabHandler
    });
    if (windowId === this.focusedWindowId) this.focusTab(windowId);
  }

  focusTab(windowId) {
    let focusedTab = this.focusedTab;
    let previousWindowId = focusedTab.windowId;
    let previousTabId = focusedTab.id;
    let previousTabHandler = focusedTab.handler;
    focusedTab = this.focusedTab = this.getActiveTab(windowId);
    let tabId = focusedTab.id;
    // Don't bother if we don't know previous nor new tab id.
    if (!tabId && !previousTabId) return;
    // Note: beware that tab handlers may be undefined (tab not handled yet or
    // at all).
    let tabHandler = focusedTab.handler;
    // Belt and suspenders: if window and tab ids are the same, but tab handler
    // was not known yet, send the notification with the handler.
    if ((windowId == previousWindowId) && (tabId == previousTabId) && (tabHandler === previousTabHandler)) return;
    this.notifyObservers(constants.EVENT_TAB_FOCUSED, {
      previousWindowId,
      previousTabId,
      previousTabHandler,
      windowId,
      tabId,
      tabHandler
    });
  }

  focusWindow(windowId) {
    // Note: windows.WINDOW_ID_NONE is used when no window has the focus.
    if (windowId === browser.windows.WINDOW_ID_NONE) windowId = undefined;
    let previousWindowId = this.focusedWindowId;
    this.focusedWindowId = windowId;
    if (settings.debug.misc) {
      if (windowId) console.log(`Focused window=<${windowId}>`);
      else console.log('No more window focused');
    }
    this.notifyObservers(constants.EVENT_WINDOW_FOCUSED, { previousWindowId, windowId });
    this.focusTab(windowId);
  }

  // Adds frame and return frame handler.
  // If frame is known, existing handler is returned.
  // If tab is not yet known and this is its main frame, tab is added first.
  // If tab is not known and this is a subframe, frame is not added.
  async addFrame(details) {
    let self = this;
    let tabId = details.tabId;
    let tabHandler = self.tabs[tabId];
    if (!tabHandler) {
      // Tab is not known yet, add it first.
      tabHandler = await browser.tabs.get(tabId).then(tab => {
        return self.addTab(tab);
      }, error => {
        console.log(`Could not manage tab=<${tabId}>:`, error);
      });
    }
    if (!tabHandler) return;
    return await tabHandler.addFrame(details);
  }

  resetFrame(details) {
    let tabHandler = this.tabs[details.tabId];
    if (!tabHandler) return;
    tabHandler.resetFrame(details);
  }

  createTab(tab) {
    let windowId = tab.windowId;
    let tabId = tab.id;
    this.notifyObservers(constants.EVENT_TAB_CREATED, { windowId, tabId, tab });
  }

  updateTab(tab, tabChanges) {
    let tabHandler = this.tabs[tab.id];
    if (!tabHandler) {
      // Tab is not known yet, add it instead.
      tabHandler = this.addTab(tab);
    } else {
      let windowId = tab.windowId;
      let tabId = tab.id;
      let changes = tabHandler.update(tab);
      if (!util.isEmptyObject(changes)) {
        Object.assign(tabChanges, changes);
        this.notifyObservers(constants.EVENT_TAB_UPDATED, { windowId, tabId, tabHandler, tabChanges });
      }
    }
  }

  detachTab(details) {
    let windowId = details.oldWindowId;
    let tabId = details.tabId;
    let tabHandler = this.tabs[tabId];
    this.notifyObservers(constants.EVENT_TAB_DETACHED, { windowId, tabId, tabHandler });
  }

  attachTab(details) {
    let windowId = details.newWindowId;
    let tabId = details.tabId;
    let tabHandler = this.tabs[tabId];
    if (tabHandler) tabHandler.windowId = windowId;
    this.notifyObservers(constants.EVENT_TAB_ATTACHED, { windowId, tabId, tabHandler });
  }

  removeTab(tabId, windowId) {
    // Note: observers may have received messages related to a tab before the
    // handler, so notify them even if we don't know the tab.
    let tabHandler = this.tabs[tabId];
    this.notifyObservers(constants.EVENT_TAB_REMOVED, {
      windowId,
      tabId,
      tabHandler
    });
    if (!tabHandler) return;
    if (settings.debug.misc) console.log(`Removing window=<${tabHandler.windowId}> tab=<${tabHandler.id}>`);
    tabHandler.clear();
    delete(this.tabs[tabId]);
  }

  removeWindow(windowId) {
    this.notifyObservers(constants.EVENT_WINDOW_REMOVED, {windowId});
    if (settings.debug.misc) console.log(`Removing window=<${windowId}>`);
    delete(this.activeTabs[windowId]);
  }

  async setup() {
    let self = this;
    // First ensure settings have been loaded.
    await settings.ready;

    // Register a dummy observer for debugging purposes.
    let dummyObserver = {};
    constants.EVENTS_TABS.forEach(key => {
      dummyObserver[key] = function() {
        if (settings.debug.tabs.events) console.log.apply(console, [`observer.${key}`, ...arguments]);
      }
    });
    this.addObserver(dummyObserver);

    // Listen to windows being removed or focused.
    // windows.onRemoved parameters: windowId
    browser.windows.onRemoved.addListener(function(windowId) {
      if (settings.debug.tabs.events) console.log.apply(console, ['windows.onRemoved', ...arguments]);
      self.removeWindow(windowId);
    });
    // windows.onFocusChanged parameters: windowId
    browser.windows.onFocusChanged.addListener(function(windowId) {
      if (settings.debug.tabs.events) console.log.apply(console, ['windows.onFocusChanged', ...arguments]);
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
      if (settings.debug.tabs.events) console.log.apply(console, ['tabs.onRemoved', ...arguments]);
      self.removeTab(tabId, details.windowId);
    });
    // tabs.onActivated parameters:
    //  - activeInfo: {tabId, windowId, previousTabId}
    browser.tabs.onActivated.addListener(function(details) {
      if (settings.debug.tabs.events) console.log.apply(console, ['tabs.onActivated', ...arguments]);
      self.activateTab(details);
    });
    // tabs.onCreated parameters: Tab
    browser.tabs.onCreated.addListener(function(details) {
      if (settings.debug.tabs.events) console.log.apply(console, ['tabs.onCreated', ...arguments]);
      self.createTab(details);
    });
    // tabs.onUpdated parameters:
    //  - tabId
    //  - changeInfo
    //  - tab (fields already updated)
    // We listen on useful changes globally:
    //  - url
    //  - status: which we rely on for temporary title changes
    // Once created, we listen temporarily for title changes.
    browser.tabs.onUpdated.addListener(function(tabId, tabChanges, tab) {
      if (settings.debug.tabs.events) console.log.apply(console, ['tabs.onUpdated', ...arguments]);
      self.updateTab(tab, tabChanges);
    }, {properties: ['url', 'status']});

    // tabs.onAttached parameters:
    //  - tabId
    //  - attachInfo: {newWindowId, newPosition}
    browser.tabs.onAttached.addListener(function(tabId, details) {
      if (settings.debug.tabs.events) console.log.apply(console, ['tabs.onAttached', ...arguments]);
      self.attachTab(Object.assign({tabId}, details));
    });
    // tabs.onDetached parameters:
    //  - tabId
    //  - detachInfo: {oldWindowId, oldPosition}
    browser.tabs.onDetached.addListener(function(tabId, details) {
      if (settings.debug.tabs.events) console.log.apply(console, ['tabs.onDetached', ...arguments]);
      self.detachTab(Object.assign({tabId}, details));
    });

    // Listen to frame changes.
    // Usually we only want to track file/http(s) pages. But in the case of
    // onBeforeNavigate which we listen to reset known tabs/frames, it is better
    // to track all pages so that we do reset whenever the url do change, even
    // in 'about:blank'/'about:home'/etc. cases.
    browser.webNavigation.onBeforeNavigate.addListener(function(details) {
      if (settings.debug.tabs.events) console.log.apply(console, ['webNavigation.onBeforeNavigate', ...arguments]);
      self.resetFrame(details);
    });

    // Notes:
    // Listening on focus change usually triggers an initial event, but not
    // not always.
    // Moreover if content script is not injected in active tab(s), we won't
    // determine the active (/focused) tab until another one is activated.
    // This is especially visible when debugging and reloading the extension.
    // So ensure we determine focused window and active tabs.
    self.focusWindow((await browser.windows.getLastFocused()).id);
    for (let tab of await browser.tabs.query({active: true})) {
      self.addTab(tab);
    }
  }

}
