'use strict';

import { settings } from '../common/settings.js';
import * as util from '../common/util.js';


// Tab successor is used to override the default Firefox behaviour when closing
// an active tab: when set it points to the target tab to activate, while the
// default behaviour activates the previous/next tab.
// 
// See:
// - https://bugzilla.mozilla.org/show_bug.cgi?id=1419947
// - https://bugzilla.mozilla.org/show_bug.cgi?id=1500479
// - https://gitlab.com/rhendric/successor-tabs-experiment
// - https://qiita.com/piroor/items/ea7e727735631c45a366
// Note: the successorTabId field value is not persisted; when re-starting the
// browser all tabs are resetted without explicit successor. Anyway the tab id
// is also resetted (starting from 1), which would mean the successorTabId would
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

// browser.tabs.moveInSuccession
// -----------------------------
// Three arguments:
//  - tabIds: tabs to remove from succession, then chain (in order)
//    - for each tab removed from succession, its predecessor uses the removed
//      tab successor as new successor, filling the gap in succession
//  - tabId: anchor tab, as successor (append=false) or predecessor (append=true)
//    of the tabIds chain
//    - append=false (successor): the last of tabIds points to this tab
//    - append=true (predecessor): this tab points to the first of tabIds
//  - options:
//    - append (false): whether to use tabId as successor (append=false) or
//      predecessor (append=true) of the tabIds chain
//    - insert (false): if enabled, link up the predecessor (append=false) or
//      successor (append=true) of tabId to the start or end of the tabIds chain
//      - append=false: tabId predecessor points to the first of tabIds
//      - append=true: the last of tabIds points to tabId successor
//
// If we have the succession chain A -> B -> C -> D -> E -> F -> G -> H
//
// The usual usage is to place a tab first in succession, and have its successor
// the previous head:
// moveInSuccession([C], A) results in one chain
// C -> A -> B -> D -> E -> F -> G -> H
// moveInSuccession([C, D], A) too
// C -> D -> A -> B -> E -> F -> G -> H
//
// But we could choose any other tab as successor:
// moveInSuccession([C], D) results in two chains
// A -> B -> D -> E -> F -> G -> H
// C -> D (-> E -> ...)
// moveInSuccession([C, D], F) too
// A -> B -> E -> F -> G -> H
// C -> D -> F (-> G -> ...)
//
// moveInSuccession([C, D], A, {append:true}) results in tow chains
// A -> C -> D
// B -> E -> F -> G -> H
// moveInSuccession([C, D], B, {append:true}) too
// A -> B -> C -> D
// E -> F -> G -> H
//
// moveInSuccession([C, D], F, {insert:true}) results in one chain
// A -> B -> E -> C -> D -> F -> G -> H
//
// moveInSuccession([C, D], B, {append:true, insert:true}) does not change the
// succession chain: it keeps the B -> C -> D relation, with A still being B
// predecessor, and D pointing to E (B successor once C and D were removed)
//
// moveInSuccession([C, D], E, {append:true, insert:true}) moves C and D between
// E and F
// A -> B -> E -> C -> D -> F -> G -> H

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

  // Whether to reset successors when initializing (extension/feature being
  // activated or reloaded).
  // Usually, this is not necessary. But we may wish to reset while fiddling
  // with the code.
  static RESET_SUCCESSORS = false;
  // Delay before checking tabs successors (for debugging purposes).
  // When positive, remaining delay is reset each time a change is made, so that
  // we log only after all rapid changes are done, instead of spammng the
  // console.
  static CHECK_TABS_DELAY = 1000;

  constructor(tabsHandler) {
    this.tabsHandler = tabsHandler;
    // List of inactive tabs opened.
    this.inactiveOpenedTabs = {
      // By tab id
      byId: {},
      // By opener tab id
      byOpener: {}
    };

    this.setup(TabSuccessor.RESET_SUCCESSORS);
  }

  getTabs() {
    return this.tabsHandler.tabs;
  }

  getTabsList() {
    return Object.values(this.getTabs());
  }

  setSuccessorTabId(tabId, successorTabId) {
    let tabHandler = this.getTabs()[tabId];
    if (!tabHandler) return;
    if (successorTabId > 0) {
      tabHandler.successorTabId = tabHandler.cachedTab.successorTabId = successorTabId;
    } else {
      delete(tabHandler.successorTabId);
      delete(tabHandler.cachedTab.successorTabId);
    }
  }

  async moveInSuccession(tabIds, tabId, options) {
    // Note: update our state *before* calling moveInSuccession; if another
    // change happens while it is running, we better be up to date.
    let self = this;

    let tabHandlers = self.getTabs();

    // tabIds are removed from succession: update any predecessor they may have.
    for (let tabHandler of Object.values(tabHandlers)) {
      if (tabIds.includes(tabHandler.id)) continue;
      if (!tabIds.includes(tabHandler.successorTabId)) continue;
      let successor = tabHandler;
      let known = new Set();
      do {
        successor = tabHandlers[successor.successorTabId];
        if (known.has(successor?.id)) {
          // Break the loop.
          successor = undefined;
        } else {
          known.add(successor?.id);
        }
      } while (successor && tabIds.includes(successor.id));
      self.setSuccessorTabId(tabHandler.id, successor?.id);
    }

    // tabIds form a succession chain.
    tabIds.reduce(
      (predecessor, tabId) => {
        try {
          self.setSuccessorTabId(predecessor, tabId);
        } catch (error) {
          console.log(error);
        }
        return tabId;
      }, -1
    );

    let tabIdsFirst = tabIds.at(0);
    let tabIdsLast = tabIds.at(-1);
    if (!options?.append) {
      if (options?.insert) {
        // Predecessors of tabId now use the first of tabIds as successor.
        for (let tabHandler of Object.values(tabHandlers)) {
          if (tabHandler.successorTabId != tabId) return;
          self.setSuccessorTabId(tabHandler.id, tabIdsFirst);
        }
      }
      // tabId is the successor of the last of tabIds.
      self.setSuccessorTabId(tabIdsLast, tabId);
    } else {
      if (options?.insert) {
        // The last of tabIds successor is the successor of tabId.
        self.setSuccessorTabId(tabIdsLast, tabHandlers[tabId]?.successorTabId);
      }
      // tabId is a predecessor of the first of tabIds.
      self.setSuccessorTabId(tabId, tabIdsFirst);
    }

    if (settings.debug.tabs.successor) {
      let params = [];
      params.push(`[${tabIds.join(', ')}]`);
      params.push(tabId);
      if (options) params.push(JSON.stringify(options));
      console.log(`moveInSuccession(${params.join(', ')})`);
    }
    await browser.tabs.moveInSuccession(tabIds, tabId, options);
  }

  async chainTabs(tabs, successor, options) {
    if (!successor) {
      // We need at least two tabs to chain.
      if (tabs.length < 2) return;
      successor = tabs[0].id;
    } else {
      // We need at least one tab to chain.
      if (!tabs.length) return;
    }
    await this.moveInSuccession(tabs.map(tab => tab.id), successor, options);
    await this.scheduleCheckTabs();
  }

  async setup(resetSuccessors) {
    let self = this;

    await settings.ready;
    // Wait for the tabs handler to have queried all tabs. Otherwise we may get
    // multiple 'tabCreated' notifications while it is being populated.
    await self.tabsHandler.ready;

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
      onclick: function(data, tab) {
        if (settings.debug.tabs.successor) console.log.apply(console, [`tab.unload`, ...arguments]);
        self.unloadTabs(tab);
      }
    });
  }

  async setupSuccessors(reset) {
    let tabsByWindow = {};
    // Gather tabs per window.
    for (let tab of this.getTabsList()) {
      // Leave alone tabs that already have a successor.
      if (!reset && (tab.successorTabId > 0)) continue;
      let entry = tabsByWindow[tab.windowId] || [];
      entry.push(tab);
      tabsByWindow[tab.windowId] = entry;
    }
    for (let windowId in tabsByWindow) {
      let entry = tabsByWindow[windowId];
      // Closing tab should activate the next one with most recent access time.
      sortTabs(entry);
      await this.chainTabs(entry);
    }
    // 'chainTabs' does call 'scheduleCheckTabs'.
    // Belt and suspenders: ensure we at least call it once, in the case we
    // don't find any tab to setup.
    if (util.isEmptyObject(tabsByWindow)) await this.scheduleCheckTabs();
  }

  async tabCreated(details) {
    let {tabHandler, tab} = details;

    // Sync successorTabId in tab handler.
    delete(tabHandler.successorTabId);
    if (tab.successorTabId > 0) tabHandler.successorTabId = tab.successorTabId;

    // Created active tab is handled through 'tabActivated'.
    // We do nothing for inactive tab without opener.
    if (tab.active || !tab.openerTabId) {
      await this.scheduleCheckTabs();
      return;
    }
    // This is an inactive tab. Group them by opener.
    //
    // Belt and suspenders:
    // We plan to wait for any of them to be activated, then
    //  1. chain them from activated->first->last->opener
    //  2. forget them (as inactiveOpenedTabs)
    // In case we fail later, chain them right now from first->last->opener.
    this.inactiveOpenedTabs.byId[tab.id] = tab;
    let opened = this.inactiveOpenedTabs.byOpener[tab.openerTabId] || [];
    let tab2;
    let options;
    if (opened.length) {
      // We already have a chain first->last->opener.
      // We only need to append+insert our new tab between the previously last
      // tab and the opener.
      tab2 = opened.at(-1).id;
      options = { append: true, insert: true };
    } else {
      // This is our first opened tab.
      // We simply chain it to the opener.
      tab2 = tab.openerTabId;
    }
    opened.push(tab);
    // Note: duplicate array so that other alterations won't change the logged value.
    if (settings.debug.tabs.successor) console.log('Added inactive tab by opener:', tab.openerTabId, opened.slice());
    this.inactiveOpenedTabs.byOpener[tab.openerTabId] = opened;
    await this.chainTabs([tab], tab2, options);
  }

  async tabActivated(details) {
    let self = this;
    let openedTab = self.inactiveOpenedTabs.byId[details.tabId];
    if (openedTab) {
      // This was an opened (inactive) tab.
      let opened = self.inactiveOpenedTabs.byOpener[openedTab.openerTabId];
      // Forget all tabs opened by the same opener.
      delete(self.inactiveOpenedTabs.byOpener[openedTab.openerTabId]);
      for (let tab of opened) {
        delete(self.inactiveOpenedTabs.byId[tab.id]);
      }
      // Ignore tabs that have been discarded.
      // Don't forget to consider our newly activated tab as not discarded.
      openedTab.discarded = false;
      opened = opened.filter(t => !t.discarded);
      // Link those tabs from activated->first->last->opener
      let index = opened.indexOf(openedTab);
      opened = [openedTab].concat(opened.slice(0, index).reverse()).concat(opened.slice(index + 1));
      let successor;
      // Notes:
      // We wish the successor to not be discarded, and thus will have to keep
      // on searching in its chain for a valid successor if needed.
      // However we expect the opener tab, or previously active tab, to still be
      // there and non-discarded in nominal case; thus don't query all tabs
      // (to have all details available) but only do it one at a time if needed.
      function findSuccessor(tabId, firstOnly) {
        while (tabId > 0) {
          let tab = self.getTabs()[tabId];
          // Belt and suspenders: no successor if we cannot find the tab.
          if (!tab) {
            tabId = 0;
            break;
          }
          if (!tab.discarded) break;
          if (firstOnly) {
            tabId = 0;
            break;
          }
          tabId = tab.successorTabId;
        }
        if (tabId > 0) return tabId;
      }
      // Opener tab is the natural successor.
      // Note: if the opener exists but is discarded, we don't wish to search
      // for a non-discarded successor but use the previously active tab.
      successor = findSuccessor(openedTab.openerTabId, true);
      // Fallback to previously active tab.
      if (!successor && details.previousTabId) {
        successor = findSuccessor(details.previousTabId);
      }
      // Fallback to the original successor of the last tab.
      if (!successor) {
        successor = self.getTabs()[opened.at(-1).id]?.successorTabId;
      }
      if (settings.debug.tabs.successor) console.log('Activating chain of tabs by opener:', openedTab.openerTabId, opened, successor);
      await self.chainTabs(opened, successor);
      return;
    }
    if (!details.previousTabId) {
      await self.scheduleCheckTabs();
      return;
    }
    // Belt and suspenders: we expect previousTabId to not be the activated tab.
    if (details.previousTabId == details.tabId) return;
    await self.chainTabs([details.tabHandler], details.previousTabId);
  }

  async tabRemoved(details) {
    let {tabId, tabHandler} = details;

    let successorTabId = tabHandler.successorTabId || -1;
    // We end up here when a tab is detached too. In any case, this tab has no
    // successor anymore.
    delete(tabHandler.successorTabId);

    // Check if any other tab used it as successor, and chain to the removed tab
    // successor.
    for (tabHandler of this.getTabsList()) {
      if (tabHandler.successorTabId != tabId) continue;
      if (successorTabId > 0) {
        tabHandler.successorTabId = successorTabId;
      } else {
        delete(tabHandler.successorTabId);
      }
    }

    let openedTab = this.inactiveOpenedTabs.byId[tabId];
    if (!openedTab) {
      await this.scheduleCheckTabs();
      return;
    }
    // Forget this inactive opened tab.
    delete(this.inactiveOpenedTabs.byId[tabId]);
    let opened = this.inactiveOpenedTabs.byOpener[openedTab.openerTabId];
    opened.splice(opened.indexOf(openedTab), 1);
    // Note: duplicate array so that other alterations won't change the logged value.
    if (settings.debug.tabs.successor) console.log('Removed inactive tab by opener:', openedTab.openerTabId, opened.slice());
    if (!opened.length) {
      // No more tabs opened by the opener.
      delete(this.inactiveOpenedTabs.byOpener[openedTab.openerTabId]);
    } else {
      this.inactiveOpenedTabs.byOpener[openedTab.openerTabId] = opened;
    }
    await this.scheduleCheckTabs();
    // Note: there is no need to update the chain of successors, it has been
    // done by the browser for us.
  }

  async tabDetached(details) {
    // For our usage, detaching a tab is akin to removing it.
    await this.tabRemoved(details);
  }

  async tabAttached(details) {
    // Notes:
    // We expect a 'tabActivated' right after 'tabAttached'.
    // In this case, succession chain will be set appropriately later.
    await this.scheduleCheckTabs();
  }

  // Unload (that is, discard) tab(s).
  async unloadTabs(tab) {
    let windowId = tab.windowId;
    // Get all this window tabs now, as we will need them twice, and we can
    // filter wanted ones on our side.
    // We need to also query tabs through API, as we need 'highlighted'.
    let wTabsQueried = (await browser.tabs.query({windowId})).reduce(
      (tabs, tab) => {
        tabs[tab.id] = tab;
        return tabs;
      }, {}
    );
    let wTabs = this.getTabsList().filter(tab => tab.windowId == windowId);
    for (let t of wTabs) {
      t.highlighted = wTabsQueried[t.id]?.highlighted;
    }
    // If multiple tabs are highlighted, and the ation is requested on one of
    // them, it is applied on all of them.
    let highlighted = wTabs.filter(t => t.highlighted);
    let tabs = highlighted.some(t => t.id == tab.id) ? highlighted : [tab];
    // We cannot discard 'about:' tabs, except 'newtab', 'home' and 'privatebrowsing'.
    tabs = tabs.filter((tab) => !tab.url.startsWith('about:') || (tab.url == 'about:newtab') || (tab.url == 'about:home') || (tab.url == 'about:privatebrowsing'));
    if (settings.debug.tabs.successor) console.log('Unload tabs:', tabs);
    // We cannot discard the active tab: in this case we must first select
    // another one (its successor).
    let discard = {};
    let active;
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
    // Note: the easy way is to work on discarded tabs, otherwise we would need
    // to rebuild/reset all active tabs chains by removing discarded tabs;
    // the browser will do it for us automatically if we call moveInSuccession
    // on discarded tabs.
    tabs = wTabs.filter(t => !t.discarded);
    for (tab of tabs) {
      if (!(tab.id in discard)) continue;
      this.chainTabs([tab], findSuccessor(tab));
      // If this tab is part of inactiveOpenedTabs, we wish to remember it is
      // discarded so that we won't include it in the chain we will build when
      // one of them is activated (unless we activate this discarded tab).
      // We don't remove it from inactiveOpenedTabs - e.g. as a side effect of
      // calling tabRemoved - because we wish for this discarded to still be
      // part of the chain if we activate it.
      // The easy way is to simply change 'discarded' here; otherwise we would
      // have to 'query' each activated tab in the inactive chain.
      (this.inactiveOpenedTabs.byId[tab.id] || {}).discarded = true;
    }
    // And finally discard the tabs.
    await browser.tabs.discard(Object.values(discard).map(t => t.id));
  }

  // Schedules checkTabs call.
  // Previously scheduled call is cleared before creating the new one.
  // Useful when many rapid actions trigger more than one scheduling.
  async scheduleCheckTabs() {
    if (!settings.debug.tabs.successor) return;
    if (this.scheduledCheckTabs) clearTimeout(this.scheduledCheckTabs);
    if (TabSuccessor.CHECK_TABS_DELAY > 0) {
      this.scheduledCheckTabs = setTimeout(
        this.checkTabs.bind(this),
        TabSuccessor.CHECK_TABS_DELAY
      );
    } else {
      await this.checkTabs();
    }
  }

  // Checks all tabs and logs debugging information.
  async checkTabs() {
    delete(this.scheduledCheckTabs);
    // Ignore tabs being removed or detahced.
    this.dumpTabs('handlers', this.getTabsList().filter(tab => !tab.removed && !tab.detached));
    this.dumpTabs('native', await browser.tabs.query({}));
  }

  dumpTabs(label, tabs) {
    let tabsInfo = {};
    let tabsByWindow = {};
    let chained = {};

    // Gather all tabs data.
    for (let tab of tabs) {
      let tabId = tab.id;
      tabsInfo[tabId] = {
        id: tab.id,
        title: tab.title,
        lastAccessed: tab.lastAccessed
      };
    }

    // Determine tabs with and without successors, grouped by window.
    // Also get active tab for each window, and link tab info with successor.
    for (let tab of tabs) {
      let tabId = tab.id;
      let info = tabsInfo[tabId];
      let windowInfo = tabsByWindow[tab.windowId] = tabsByWindow[tab.windowId] || {
        withSuccessor: {},
        withoutSuccessor: {},
        chains: []
      };
      if (tab.active) {
        info.active = true;
        windowInfo.active = info;
      }
      let successorTabId = tab.successorTabId || -1;
      // Belt and suspenders: assume we may find a successorTabId that we
      // don't know about yet.
      if ((successorTabId < 0) || !(successorTabId in tabsInfo)) {
        windowInfo.withoutSuccessor[tabId] = info;
        continue;
      }
      info.successor = tabsInfo[successorTabId];
      windowInfo.withSuccessor[tabId] = info;
    }

    // Determine chains of successors, sorted by descending last access time.
    sortTabs(tabs);
    // Now determine tabs chains. We don't have to explicitly compare window
    // ids, as successor can only belong to the same window; we just need to
    // build chains, and then remember them by window (id retrieved from any
    // tab in the chain).
    for (let tab of tabs) {
      let info = tabsInfo[tab.id];
      // For each tab, determine the chain of successors.
      // Reminder: chains may be circular, so remember processed tabs.
      let chain = [];
      while (!(info.id in chained)) {
        chained[info.id] = info;
        chain.push(info);
        if ('successor' in info) info = info.successor;
        // else: next loop will automatically break on test
      }
      // For each new tab info, build the full successor chain list.
      // Notes:
      // All elements of the built chain were not already in 'chained', and
      // have not yet their full successor chain known. To ease building we
      // do it from last to first, since:
      //  - if chain building ended because its tail successor was already
      //    known, this successor already has its own chain successor we
      //    can just use
      //  - otherwise, the last element is on its own and we can 'easily'
      //    build its predecessors chains this way
      // Use 'slice' first because 'reverse' mutates the array.
      // Doing this is useful because chains starting at a given tab may have
      // more than one predecessor, and for debugging it is better to see
      // the full chains.
      for (let info0 of chain.slice().reverse()) {
        // Beware of circular chain: the last entry successor may be the first
        // tab of the chain, in which case we did not yet build its chain.
        let successorChain = info0.successor ? chained[info0.successor.id] : [];
        successorChain = Array.isArray(successorChain) ? successorChain : [successorChain];
        chained[info0.id] = [info0, ...successorChain];
      }
      // Only process tab if it is not already part of an existing chain (in
      // which case 'chain' is empty because the tab was in 'chained').
      if (!chain.length) continue;
      // The chain we have may actually precede a previous chain we built, in
      // which case we want to merge (prepend) this chain to the existing one:
      // check any chain that would be the successor of our chain last tab.
      let chainSuccessor = undefined;
      for (let chainExisting of tabsByWindow[tab.windowId].chains) {
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
        // This is a new chain: use the full chain instead of the one we built
        // since it may be 'incomplete' (stopped because successor already
        // known with its own chain).
        tabsByWindow[tab.windowId].chains.push(chained[tab.id]);
      }
    }

    console.debug(`Tabs by window (${label}):`, tabsByWindow);
  }

}
