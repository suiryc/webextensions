'use strict';

import { settings } from '../common/settings.js';


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
    if (a.active && !b.active) return -1;
    if (!a.active && b.active) return 1;
    if (a.lastAccessed > b.lastAccessed) return -1;
    if (a.lastAccessed < b.lastAccessed) return 1;
    return 0;
  });
  return tabs;
}

export class TabSuccessor {

  constructor(tabsHandler) {
    var self = this;
    self.tabsHandler = tabsHandler;
    // List of inactive tabs opened.
    self.inactiveOpenedTabs = {
      // By tab id
      byId: {},
      // By opener tab id
      byOpener: {}
    };

    self.setup(false);
  }

  async chainTabs(tabs, successor, options) {
    var self = this;
    if (!successor) {
      // We need at least two tabs to chain.
      if (tabs.length < 2) return;
      successor = tabs[0].id;
    } else {
      // We need at least one tab to chain.
      if (!tabs.length) return;
    }
    await browser.tabs.moveInSuccession(tabs.map(tab => tab.id), successor, options);
    self.scheduleCheckTabs();
  }

  async setup(resetSuccessors) {
    var self = this;

    async function _setup(resetSuccessors) {
      // Show current state upon debugging.
      if (settings.debug.tabs.successor) await self.checkTabs();
      await self.setupSuccessors(resetSuccessors);
    }

    settings.inner.handleTabSuccessor.addListener((setting, oldValue, newValue) => {
      if (!oldValue && newValue) {
        self.tabsHandler.addObserver(self, true);
        _setup(false);
      } else if (oldValue && !newValue) {
        self.tabsHandler.removeObserver(self);
      }
    });
    if (settings.handleTabSuccessor) self.tabsHandler.addObserver(self, true);
    await _setup(resetSuccessors);

    // Context menu entry to unload tab(s).
    browser.contextMenus.create({
      id: 'tab.unload',
      title: 'Unload tab(s)',
      contexts: ['tab'],
      onclick: function(info, tab) {
        if (settings.debug.tabs.successor) console.log.apply(this, [`tab.unload`, ...arguments]);
        self.unloadTabs(tab);
      }
    });
  }

  async setupSuccessors(reset) {
    var self = this;
    var tabs = await browser.tabs.query({});
    var tabsByWindow = {};
    // Gather tabs per window.
    for (var tab of tabs) {
      // Leave alone tabs that already have a successor.
      if (!reset && tab.successorTabId) continue;
      var entry = tabsByWindow[tab.windowId] || [];
      entry.push(tab);
      tabsByWindow[tab.windowId] = entry;
    }
    for (var windowId in tabsByWindow) {
      var entry = tabsByWindow[windowId];
      // Closing tab should activate the next one with most recent access time.
      sortTabs(entry);
      await self.chainTabs(entry);
    }
    // 'chainTabs' does call 'scheduleCheckTabs'.
    // Belt and suspenders: ensure we at least call it once, in the case we
    // don't find any tab to setup.
    if (!tabsByWindow.length) self.scheduleCheckTabs();
  }

  async tabCreated(details) {
    var self = this;
    var tab = details.tab;
    if (tab.active || !tab.openerTabId) {
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
    var tab2;
    var options;
    if (opened.length) {
      // We already have a chain first->last->opener.
      // We only need to append+insert our new tab between the previously last
      // tab and the opener.
      tab2 = opened.slice(-1)[0].id;
      options = { append: true, insert: true };
    } else {
      // This is our first opened tab.
      // We simply chain it to the opener.
      tab2 = tab.openerTabId;
    }
    opened.push(tab);
    // Note: duplicate array so that other alterations won't change the logged value.
    if (settings.debug.tabs.successor) console.log('Added inactive tab by opener:', tab.openerTabId, opened.slice());
    self.inactiveOpenedTabs.byOpener[tab.openerTabId] = opened;
    await self.chainTabs([tab], tab2, options);
  }

  async tabActivated(details) {
    var self = this;
    var openedTab = self.inactiveOpenedTabs.byId[details.tabId];
    if (openedTab) {
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
      var successor;
      // If the opener tab still exists, use it as successor.
      // If not, getting it will fail.
      try {
        successor = (await browser.tabs.get(openedTab.openerTabId)).id;
      } catch(error) {
      }
      // If opener is not there, try the previously active tab.
      // It may have been removed too (triggering a new tab activation).
      if (!successor && details.previousTabId) {
        try {
          successor = (await browser.tabs.get(details.previousTabId)).id;
        } catch(error) {
        }
      }
      if (!successor) {
        // If opener is not there, fallback to the current successor of the
        // last tab (which supposedly replaces it).
        try {
          successor = (await browser.tabs.get(opened.slice(-1)[0].id)).successorTabId;
        } catch(error) {
          // Should not happen: if this tab was removed, we should have been notified
          // already, and we don't expect race condition to be possible here.
          console.log('Could not get last tab in chain of inactive opened tabs:', error);
        }
      }
      if (settings.debug.tabs.successor) console.log('Activating chain of tabs by opener:', openedTab.openerTabId, opened, successor);
      await self.chainTabs(opened, successor);
      return;
    }
    if (!details.previousTabId) {
      self.scheduleCheckTabs();
      return;
    }
    if (details.previousTabId == details.tabId) {
      // Special case in tabs handler: the tab was activated earlier but its
      // tab handler did not exist yet; then another event (frame added) created
      // the tab handler triggering a second 'tabActivated' event to pass the
      // now known tab handler.
      return;
    }
    await browser.tabs.moveInSuccession([details.tabId], details.previousTabId);
    self.scheduleCheckTabs();
  }

  tabRemoved(details) {
    var self = this;
    var tabId = details.tabId;
    var openedTab = self.inactiveOpenedTabs.byId[tabId];
    if (!openedTab) {
      self.scheduleCheckTabs();
      return;
    }
    // Forget this inactive opened tab.
    delete(self.inactiveOpenedTabs.byId[tabId]);
    var opened = self.inactiveOpenedTabs.byOpener[openedTab.openerTabId];
    opened.splice(opened.indexOf(openedTab), 1);
    // Note: duplicate array so that other alterations won't change the logged value.
    if (settings.debug.tabs.successor) console.log('Removed inactive tab by opener:', openedTab.openerTabId, opened.slice());
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

  tabDetached(details) {
    this.tabRemoved(details);
  }

  tabAttached(details) {
    this.scheduleCheckTabs();
  }

  // Unload (that is, discard) tab(s).
  async unloadTabs(tab) {
    var windowId = tab.windowId;
    // If multiple tabs are highlighted, and the ation is requested on one of
    // them, it is applied on all of them.
    var highlighted = await browser.tabs.query({highlighted: true});
    var tabs = highlighted.some(t => t.id == tab.id) ? highlighted : [tab];
    // We cannot discard 'about:' tabs, except 'newtab', 'home' and 'privatebrowsing'.
    tabs = tabs.filter((tab) => !tab.url.startsWith('about:') || (tab.url == 'about:newtab') || (tab.url == 'about:home') || (tab.url == 'about:privatebrowsing'));
    if (settings.debug.tabs.successor) console.log('Unload tabs:', tabs);
    // We cannot discard the active tab: in this case we must first select
    // another one (its successor).
    var discard = {};
    var active;
    for (tab of tabs) {
      discard[tab.id] = tab;
      if (tab.active) active = tab;
    }
    function findSuccessor(tab) {
      while (tab) {
        tab = tab.successorTabId;
        // Belt and suspenders: gracefully handle missing successor.
        if (!tab) break;
        // Ensure we are not also discarding the successor.
        if (!(tab in discard)) break;
        // We will also discard the successor, keep on searching.
        tab = discard[tab];
      }
      return tab;
    }
    active = findSuccessor(active);
    // Note: we don't expect this tab to not exist anymore, thus we don't
    // expect this action to fail.
    if (active) await browser.tabs.update(active, {active: true});
    // Now remove the tabs to discard from the succession chain.
    tabs = await browser.tabs.query({discarded: false, windowId});
    for (tab of tabs) {
      if (!(tab.id in discard)) continue;
      this.chainTabs([tab], findSuccessor(tab));
    }
    // And finally discard the tabs.
    browser.tabs.discard(Object.values(discard).map(t => t.id));
  }

  // Schedules checkTabs call.
  // Previously scheduled call is cleared before creating the new one.
  // Useful when many rapid actions trigger more than one scheduling.
  scheduleCheckTabs(delay = 1000) {
    if (!settings.debug.tabs.successor) return;
    if (this.scheduledCheckTabs) clearTimeout(this.scheduledCheckTabs);
    this.scheduledCheckTabs = setTimeout(this.checkTabs.bind(this), delay);
  }

  // Checks all tabs and logs debugging information.
  async checkTabs() {
    delete(this.scheduledCheckTabs);
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
        var chainSuccessor;
        for (var chainExisting of tabsByWindow[tab.windowId].chains) {
          if (chainExisting[0].id == info.id) {
            chainSuccessor = chainExisting;
            break;
          }
        }
        if (chainSuccessor) {
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
