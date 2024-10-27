'use strict';

import * as util from '../common/util.js';
import { settings } from '../common/settings.js';


// Notes:
// browser.contextMenus is a standard resource, while browser.menus is specific
// to Firefox and allows adding entries in the browser 'Tools' menu.
// Each of those resources require its associated permission.
// We only need browser.contextMenus here.
//
// When only one entry is created + visible, it is placed directly in the menu.
// When more than one entry is visible, the browser automatically creates a root
// entry, showing the extension name.
// Alternatively, if only one entry without parent is visible, and all other
// entries are attached to it (or sub-entries), then this root entry is the one
// displayed in the menu: it allows to use whatever title we want.
// The browser takes care of automatically showing/hiding entries depending on
// the context and the requested entry 'contexts'.
//
// While it is possible to update an entry to attach it to a parent, it does
// not seem possible to update an entry to move it back at the root level (i.e.
// reset its parent id): to do so it would need to be removed and re-created.
//
// Once 'targetUrlPatterns' has been specified for a menu entry (whether at
// creation or later by updating), there is no way to reset it. So while not
// specifying it allows to show the menu entry by right-clicking anywhere in the
// page, once specified it will only show when right-clicking on elements with
// an actual link matching the specified pattern(s).
//
// Context menu is not updated until we 'refresh'.
// Refreshing the menu rebuilds all our entries: even if only a sub-entry is
// added or removed, in Firefox refreshing will close our menu popup if focused.
// Thus we cannot really optimize refreshing and can simply rebuild the whole
// entries when we need to add/remove some.
//
// We handle many different cases:
//  - right-clicking on a downloadable link
//  - having zero or more (video) download entries
//  - allowing to 'Unload' the current tab
// To cope with all situations we want to handle, we:
//  - create two (exclusive) root nodes, without and with 'targetUrlPatterns'
//    - the latter is used when we only need to show a 'Downlad link' item
//  - listen to menu being shown/hidden
//  - when menu is shown
//    - decide which root node we need to show
//    - update the wanted root node
//    - build all sub-entries when applicable
//    - refresh the menu to show the changes
//  - when menu is hidden
//    - remove all created menu entries, except root ones (made invisible)
// This allows to show:
//  - when right-clicking on a link
//    * Download link
//  - when right-clicking anywhere but a link, and without download entries
//    * Unload tab
//  - when we have download entries
//    * dl-mngr
//      * Download link    <-- only if right-clicking on a link
//      * (separator)      <-- only if right-clicking on a link
//      * Download entry 1
//      * ...
//      * Download entry N
//      * (separator)
//      * Unload tab
//
// As a consequence, callers need to exclusively rely on the menu handler and
// not call 'browser.contextMenus' directly.
// Caller API: reset, addEntry, updateEntry, removeEntries.

// For now, this menu handler only manages download links.
// However, for simplicity the root entry and sub-entries (available downloads)
// can target 'all', as it actually:
//  - encompasses sensible contexts: page, frames, ...; there is also no issue
//    targeting browser_action (or page_action which we don't have) through it
//  - leaves out the ones we don't want to target, especially 'tab'; but also
//    'bookmark' and 'tools_menu'
const DL_CONTEXTS = ['link', 'video', 'audio'];
const ID_ROOT = 'root';
const ID_ROOT_LINK = 'root-link';

const ENTRIES_BASE = {
  [ID_ROOT]: {
    id: ID_ROOT,
    title: 'dl-mngr',
    icons: { '16': '/resources/icon.svg' },
    contexts: ['all'],
    visible: true,
    onclick: function(data, tab) { }
  },
  // Restrict to links that apparently point to sites.
  // See: https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Match_patterns
  [ID_ROOT_LINK]: {
    id: ID_ROOT_LINK,
    title: 'dl-mngr',
    icons: { '16': '/resources/icon.svg' },
    contexts: DL_CONTEXTS,
    targetUrlPatterns: ['*://*/*'],
    visible: true,
    onclick: function(data, tab) { }
  }
};

class MenuElement {

  constructor(menu) {
    this.menu = menu;
    this.attached = true;
  }

  // API: remove this entry.
  async remove() {
    // If no parent or already removed, nothing to do.
    if (!this.menu || !this.attached) return false;

    await this.menu.removeEntries(this);
    this.attached = false;

    // Sub-class will do the rest when applicable.
    return true;
  }

  // API: add this entry.
  async add() {
    // If no parent or already attached, nothing to do.
    if (!this.menu || this.attached) return false;

    await this.menu.addEntry(this);

    // Sub-class will do the rest when applicable.
    return true;
  }

}

class MenuEntry extends MenuElement {

  constructor(menu, details) {
    super(menu);
    this.details = Object.assign({
      id: util.uuidv4(),
      parentId: ID_ROOT,
      icons: { '16': '/resources/icon.svg' },
      contexts: ['all'],
    }, details);
  }

  // API: update this entry.
  async update(details) {
    // Update the details we know.
    for (let [key, value] of Object.entries(details)) {
      if ((value !== undefined) && (value !== null)) this.details[key] = value;
      else delete(this.details[key]);
    }

    // If not attached, we are done.
    if (!this.attached) return;

    // Delegate refreshing to owner.
    await this.menu.updateEntry(this, details);
  }

}

// Gathers more than one entry.
// Can be used to keep multiple entries grouped at the same place in the menu,
// without creating a sub-menu.
//
// Note: removing a menu group only removes the group element, not its entries.
// This will trigger a rebuild, and all entries still held by the group won't
// remain in the new menu.
// This also allows re-adding the group later, which comes back in parent with
// all the remaining attached sub-entries.
class MenuGroup extends MenuElement {

  constructor(menu) {
    super(menu);
    // MenuEntry/MenuGroup we manage.
    this.entries = [];
  }

  // API: reset menu.
  async reset() {
    let r = false;

    // Empty known entries.
    for (let entry of this.entries) {
      r |= await entry.remove();
    }

    return r;
  }

  async rebuild() {
    // If not attached, nothing to do.
    if (!this.attached) return;

    // Delegate rebuilding to parent.
    await this.menu.rebuild(...arguments);
  }

  countMenuEntries() {
    return this.entries.reduce((sum, entry) => {
      return sum + (entry.details ? 1 : entry.countMenuEntries());
    }, 0);
  }

  hasEntry(entry) {
    // Check we own (directly or not) this entry.
    let menu = entry.menu;
    while (menu) {
      if (menu === this) return entry;
      menu = menu.menu;
    }
  }

  async updateEntry(entry, details) {
    // If not attached, nothing to do.
    if (!this.attached) return;

    // Delegate updating to parent.
    await this.menu.updateEntry(...arguments);
  }

  // API: add new entry.
  async addEntry(details) {
    let entry = (details instanceof MenuElement) ? details : new MenuEntry(this, details);
    this.entries.push(entry);
    entry.attached = true;
    await this.rebuild();
    return entry;
  }

  // API: remove given entries.
  async removeEntries() {
    let entries = new Set([...arguments]);
    this.entries = this.entries.filter(el => !entries.has(el));
    await this.rebuild();
  }

  // API: add group in entries.
  addGroup() {
    let group = new MenuGroup(this);
    this.entries.push(group);
    return group;
  }

}

export class MenuHandler extends MenuGroup {

  constructor(tabSuccessor, requestsHandler) {
    super();
    this.tabSuccessor = tabSuccessor;
    this.requestsHandler = requestsHandler;
    // Menu entry ids that were created in context menu.
    this.ids = [];
    this.shown = undefined;
    this.setup();
  }

  async setup() {
    let self = this;

    await settings.ready;

    // Root menu, initially invisible.
    for (let id of [ID_ROOT, ID_ROOT_LINK]) {
      await self.createEntry({
        id: id,
        visible: false
      });
    }
    // Forget these ids: we won't remove them, only update.
    this.ids = [];

    browser.contextMenus.onShown.addListener(self.onShown.bind(self));
    browser.contextMenus.onHidden.addListener(self.onHidden.bind(self));
  }

  async onShown(data, tab) {
    let self = this;

    let isLink = false;
    for (let ctx of data.contexts) {
      if (DL_CONTEXTS.includes(ctx)) {
        isLink = true;
        break;
      }
    }

    async function show() {
      self.shown = {
        data: data,
        tab: tab
      };
      await browser.contextMenus.refresh();
    }

    // Entry to download target link (may be video/audio element).
    let dlLinkDetails = {
      title: 'Download link',
      onclick: self.requestsHandler.manageClick.bind(self.requestsHandler)
    };
    let entriesCount = self.countMenuEntries();
    if (!entriesCount && isLink) {
      // Target link without other entries.
      // We don't need/want to show 'Unload tab' in this specific case.
      Object.assign(dlLinkDetails, {
        id: ID_ROOT_LINK
      });
      await self.updateRoot(dlLinkDetails);
      return await show();
    }

    // Root menu.
    await self.updateRoot({
      title: 'dl-mngr'
    });

    if (isLink) {
      Object.assign(dlLinkDetails, {
        parentId: ID_ROOT,
        contexts: DL_CONTEXTS,
        targetUrlPatterns: ['*://*/*']
      });
      await self.createEntry(dlLinkDetails);
    }

    // Other entries (added by owner).
    if (entriesCount && isLink) {
      await self.createSeparator({});
    }
    await self.createEntries();

    // 'Unload tab' entry.
    let unloadDetails = {
      title: 'Unload tab',
      onclick: function(data, tab) {
        if (settings.debug.tabs.successor) console.log.apply(console, [`tab.unload`, ...arguments]);
        self.tabSuccessor.unloadTabs(tab);
      }
    };
    if (entriesCount || isLink) {
      await self.createSeparator({});
      Object.assign(unloadDetails, {
        parentId: ID_ROOT
      });
      await self.createEntry(unloadDetails);
    } else {
      await self.updateRoot(unloadDetails);
    }
    await show();
  }

  async onHidden() {
    this.shown = undefined;
    // Remove created entries.
    for (let id of this.ids) {
      await browser.contextMenus.remove(id);
    }
    this.ids = [];
    // Hide root nodes.
    for (let id of [ID_ROOT, ID_ROOT_LINK]) {
      await this.updateRoot({
        id: id,
        visible: false
      });
    }
  }

  async updateRoot(details) {
    let id = details.id;
    if (id === undefined) id = ID_ROOT;
    details = Object.assign({}, ENTRIES_BASE[id], details);
    // API complains if we pass 'id' in update details.
    delete details.id;
    await browser.contextMenus.update(id, details);
  }

  async createEntries(entry) {
    let list = [];
    function loop(menu) {
      for (let entry of (menu.entries || [])) {
        if (entry.details) list.push(entry.details);
        loop(entry);
      }
    }
    loop(this);

    for (let details of list) {
      await this.createEntry(details);
    }
  }

  // Creates a context menu entry, from given details.
  // If needed details are enriched.
  // Actual details used for creation are returned.
  async createEntry(details) {
    // Get or generate id.
    let id = details['id'];
    if (id === undefined) id = util.uuidv4();
    // Use base entry if applicable.
    let base = ENTRIES_BASE[id];
    if (base !== undefined) details = Object.assign({}, base, details);
    // Complete details.
    details = Object.assign({
      id: id,
      icons: { '16': '/resources/icon.svg' },
      contexts: ['all']
    }, details);
    // Create menu entry and remember id.
    await browser.contextMenus.create(details);
    this.ids.push(id);
    return details;
  }

  async createSeparator(details) {
    details = Object.assign({
      id: util.uuidv4(),
      parentId: ID_ROOT,
      type: 'separator',
      contexts: ['all']
    }, details);
    let id = await browser.contextMenus.create(details);
    this.ids.push(id);
    return details;
  }

  async rebuild() {
    let shown = this.shown;
    if (!shown) return;
    // Behaves as if hiding and showing again the menu: this cleanly updates
    // and rebuilds all needed entries.
    await this.onHidden();
    await this.onShown(shown.data, shown.tab);
  }

  async updateEntry(entry, details) {
    // Ensure this entry exists.
    if (!this.hasEntry(entry)) return;

    // If menu is shown, refresh.
    if (this.shown) {
      await browser.contextMenus.update(entry.id, details);
      await browser.contextMenus.refresh();
    }
  }

}
