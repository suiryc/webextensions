'use strict';


// Tab successor is used to override the default Firefox behaviour when closing
// an active tab: when set it points to the target tab to activate, while the
// default behaviour activates the previous/next tab.
// 
// See:
// - https://bugzilla.mozilla.org/show_bug.cgi?id=1419947
// - https://bugzilla.mozilla.org/show_bug.cgi?id=1500479
// - https://gitlab.com/rhendric/successor-tabs-experiment
// - https://qiita.com/piroor/items/ea7e727735631c45a366
// Note: the successorId field value is not persisted; when re-starting the
// browser all tabs are resetted without explicit successor. Anyway the tab id
// is also resetted (starting from 1), which would mean the successorId would
// have to be recomputed (based on the tab index at the moment of exiting ?).
//
// Upon starting, we sort all tabs by window and descending last access time
// (activate tab then most recent first) to chain them altogether. This is
// enough in most cases (no need to try to persist the chain of succession).
// Then we listen for tabs being created/activated/removed/detached/attached:
//  - if activated, we alter the chain of succession to have the previous
//    active tab as successor of the newly activated tab
//  - if only created (not activated) we group tabs by opener, and once one
//    is activated, we chain them from activated->first->last->opener
//  - if removed/detached, we forget it from the group of created (and not
//    activated) tabs when applicable
// Notes:
//  - aside from the case of creation without activation, the browser already
//    handle the chain of succession when a tab is removed/detached
//  - similarly, there is no need to specifically handle tabs being attached
//    since the browser will reset its successor and the tab will be activated
//    right after being attached (which makes us set its successor accordingly)

// Sorts tabs by descending access time (most recent first).
// Active tab is also forced to be first (it should also be the one with the
// most recent access time).
function sortTabs(tabs) {
  if (tabs.length < 2) return tabs;
  tabs.sort((a, b) => {
    // Active tab is always first.
    if (a.active) return -1;
    if (a.lastAccessed > b.lastAccessed) return -1;
    if (a.lastAccessed < b.lastAccessed) return 1;
    return 0;
  });
  return tabs;
}

class TabsHandler {

  constructor() {
    var self = this;
    // Currently scheduled checkTabs call.
    self.scheduledCheckTabs = undefined;
    // List of inactive tabs opened.
    self.inactiveOpenedTabs = {
      // By tab id
      byId: {},
      // By opener tab id
      byOpener: {}
    };
  }

  async chainTabs(tabs, successor, options) {
    var self = this;
    if (successor === undefined) {
      // We need at least two tabs to chain.
      if (tabs.length < 2) return;
      successor = tabs[0];
    } else {
      // We need at least one tab to chain.
      if (tabs.length < 1) return;
    }
    if ((typeof(successor) == 'object') && ('id' in successor)) successor = successor['id'];
    await browser.tabs.moveInSuccession(tabs.map(tab => tab.id), successor, options);
    self.scheduleCheckTabs();
  }

  async setup(resetSuccessors) {
    var self = this;
    await self.setupSuccessors(resetSuccessors);
    await self.setupInterception();
  }

  async setupSuccessors(reset) {
    var self = this;
    var tabs = await browser.tabs.query({});
    var tabsPerWindow = {};
    // Gather tabs per window.
    for (var tab of tabs) {
      // Leave alone tabs that already have a successor.
      if (!reset && (tab.successorTabId >= 0)) continue;
      var entry = tabsPerWindow[tab.windowId] || [];
      entry.push(tab);
      tabsPerWindow[tab.windowId] = entry;
    }
    for (var windowId in tabsPerWindow) {
      var entry = tabsPerWindow[windowId];
      // Closing tab should activate the next one with most recent access time.
      sortTabs(entry);
      await self.chainTabs(entry);
    }
    if (!tabsPerWindow.length) self.scheduleCheckTabs();
  }

  setupInterception() {
    var self = this;
    ['onActivated', 'onAttached', 'onCreated', 'onDetached', 'onRemoved'].forEach(key => {
      browser.tabs[key].addListener(self[key].bind(self));
    });
  }

  async onCreated(tab) {
    var self = this;
    if (settings.debug) console.log('Created:', tab);
    if (tab.active || !(tab.openerTabId >= 0)) {
      self.scheduleCheckTabs();
      return;
    }
    // This is an inactive tab. Group them by opener.
    //
    // Belt and suspenders:
    // We plan to wait for any of them to be activated, then
    //  1. chain them from activated->first->last->opener
    //  2. forget them (as inactiveOpenedTabs)
    // In case we fail later, chain them right now from first->last->opener.
    self.inactiveOpenedTabs.byId[tab.id] = tab;
    var opened = self.inactiveOpenedTabs.byOpener[tab.openerTabId] || [];
    var tab2 = undefined;
    var options = undefined;
    if (opened.length) {
      // We already have a chain first->last->opener.
      // We only need to append+insert our new tab between the previously last
      // tab and the opener.
      tab2 = opened.slice(-1)[0];
      options = { append: true, insert: true };
    } else {
      // This is our first opened tab.
      // We simply chain it to the opener.
      tab2 = tab.openerTabId;
    }
    // Note: duplicate array so that other alterations won't change the logged value.
    if (settings.debug) opened = opened.slice();
    opened.push(tab);
    if (settings.debug) console.log('Added inactive tab by opener:', tab.openerTabId, opened);
    self.inactiveOpenedTabs.byOpener[tab.openerTabId] = opened;
    await self.chainTabs([tab], tab2, options);
  }

  async onActivated(info) {
    // info: {tabId, windowId, previousTabId}
    var self = this;
    if (settings.debug) console.log('Activated:', info);
    var openedTab = self.inactiveOpenedTabs.byId[info.tabId];
    if (openedTab !== undefined) {
      // This was an opened (inactive) tab.
      var opened = self.inactiveOpenedTabs.byOpener[openedTab.openerTabId];
      // Forget all tabs opened by the same opener.
      delete self.inactiveOpenedTabs.byOpener[openedTab.openerTabId];
      for (var tab of opened) {
        delete self.inactiveOpenedTabs.byId[tab.id];
      }
      // Link those tabs from activated->first->last->opener
      var index = opened.indexOf(openedTab);
      opened = [openedTab].concat(opened.slice(0, index).reverse()).concat(opened.slice(index + 1));
      var successor = undefined;
      try {
        successor = await browser.tabs.get(openedTab.openerTabId);
      } catch(error) {
        // Happens if opener has been closed in the meantime.
      }
      if (successor === undefined) {
        // If opener is not there, fallbacks to the current successor of the
        // last tab (which supposedly replaces it).
        try {
          successor = await browser.tabs.get(opened.slice(-1)[0].id);
          successor = successor.successorTabId;
        } catch(error) {
          // Should not happen.
          console.log('Could not get last tab in chain of inactive opened tabs:', error);
        }
      }
      console.log('Activating chain of tabs by opener:', openedTab.openerTabId, opened, successor);
      await self.chainTabs(opened, successor);
      return;
    }
    if ((info.previousTabId === null) || (info.previousTabId === undefined)) {
      self.scheduleCheckTabs();
      return;
    }
    await browser.tabs.moveInSuccession([info.tabId], info.previousTabId);
    self.scheduleCheckTabs();
  }

  tabRemoved(tabId) {
    var self = this;
    var openedTab = self.inactiveOpenedTabs.byId[tabId];
    if (openedTab === undefined) {
      self.scheduleCheckTabs();
      return;
    }
    // Forget this inactive opened tab.
    delete(self.inactiveOpenedTabs.byId[tabId]);
    var opened = self.inactiveOpenedTabs.byOpener[openedTab.openerTabId];
    // Note: duplicate array so that other alterations won't change the logged value.
    if (settings.debug) opened = opened.slice();
    opened.splice(opened.indexOf(openedTab), 1);
    if (settings.debug) console.log('Removed inactive tab by opener:', openedTab.openerTabId, opened);
    if (!opened.length) {
      // No more tabs opened by the opener.
      delete self.inactiveOpenedTabs.byOpener[openedTab.openerTabId];
    } else {
      self.inactiveOpenedTabs.byOpener[openedTab.openerTabId] = opened;
    }
    self.scheduleCheckTabs();
    // Note: there is no need to update the chain of successors, it has been
    // done by the browser for us.
  }

  onRemoved(tabId, info) {
    // info: {windowId, isWindowClosing}
    if (settings.debug) console.log('Removed:', tabId, info);
    this.tabRemoved(tabId);
  }

  onDetached(tabId, info) {
    // info: {oldWindowId, oldPosition}
    if (settings.debug) console.log('Detached:', tabId, info);
    this.tabRemoved(tabId);
  }

  onAttached(tabId, info) {
    // info: {newWindowId, newPosition}
    if (settings.debug) console.log('Attached:', tabId, info);
    this.scheduleCheckTabs();
  }

  // Schedules checkTabs call.
  // Previously scheduled call is cleared before creating the new one.
  // Useful when many rapid actions trigger more than one scheduling.
  scheduleCheckTabs(delay = 1000) {
    if (!settings.debug) return;
    if (this.scheduledCheckTabs !== undefined) clearTimeout(this.scheduledCheckTabs);
    this.scheduledCheckTabs = setTimeout(this.checkTabs.bind(this), delay);
  }

  // Checks all tabs and logs debugging information.
  async checkTabs() {
    this.scheduledCheckTabs = undefined;
    var tabs = await browser.tabs.query({});
    var tabsInfo = {};
    var tabsByWindow = {};
    var chained = {};

    // Gather all tabs data.
    for (var tab of tabs) {
      var tabId = tab.id;
      tabsInfo[tabId] = {
        id: tab.id,
        title: tab.title,
        lastAccessed: tab.lastAccessed
      };
    }

    // Determine tabs with and without successors, grouped by window.
    // Also get active tab for each window, and link tab info with successor.
    for (var tab of tabs) {
      var tabId = tab.id;
      var info = tabsInfo[tabId];
      var windowInfo = tabsByWindow[tab.windowId] || {
        active: undefined,
        withSuccessor: {},
        withoutSuccessor: {},
        chains: []
      };
      tabsByWindow[tab.windowId] = windowInfo;
      if (tab.active) {
        info.active = true;
        windowInfo.active = info;
      }
      if (tab.successorTabId < 0) {
        windowInfo.withoutSuccessor[tabId] = info;
        continue;
      }
      info.successor = tabsInfo[tab.successorTabId];
      windowInfo.withSuccessor[tabId] = info;
    }

    // Determine chains of successors, sorted by descending last access time.
    sortTabs(tabs);
    for (var tab of tabs) {
      var tabId = tab.id;
      var info = tabsInfo[tabId];
      var chain = [];
      while (!(info.id in chained)) {
        chained[info.id] = info;
        chain.push(info);
        if ('successor' in info) info = info.successor;
        // else: next loop will automatically break on test
      }
      // Only process tab if it is not already part of an existing chain.
      if (chain.length) {
        // Check any chain that would be the successor of our chain last tab.
        var chainSuccessor = undefined;
        for (var chainExisting of tabsByWindow[tab.windowId].chains) {
          if (chainExisting[0].id == info.id) {
            chainSuccessor = chainExisting;
            break;
          }
        }
        if (chainSuccessor !== undefined) {
          // Our chain actually precedes another chain we already built.
          // Prepend it.
          chainSuccessor.unshift.apply(chainSuccessor, chain);
        } else {
          // This is a new chain.
          tabsByWindow[tab.windowId].chains.push(chain);
        }
      }
    }

    console.debug('Tabs by window:', tabsByWindow);
  }

}

var tabsHandler = new TabsHandler();

waitForSettings().then(async () => {
  // Show current state upon debugging.
  if (settings.debug) await tabsHandler.checkTabs();
  // Then setup tabs successor handling.
  await tabsHandler.setup(false);
});
