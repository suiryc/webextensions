'use strict';


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
// Initially we only need one menu entry, to download link which is currently
// right-clicked.
// But we handle adding more entries at a later time.
// We thus create a first 'Download link' entry, and a hidden root entry with
// a second 'Download entry' child (see above: we cannot move an entry back
// from a child to root level).
// When other entries are added, we hide the first 'Download link' entry and
// show the root entry.
// When other entries are removed, we gets back to the initial state.

export class MenuHandler {

  constructor(requestsHandler) {
    this.requestsHandler = requestsHandler;
    this.dlEntries = [];

    // Root menu, initially invisible.
    browser.contextMenus.create({
      id: 'dl-mngr.root',
      title: 'dl-mngr',
      icons: { '16': '/resources/icon.svg' },
      contexts: ['all'],
      visible: false
    });

    // Add context menu entry to download links (and video/audio elements).
    // Restrict to links that apparently point to sites.
    // See: https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Match_patterns
    browser.contextMenus.create({
      id: 'dl-mngr.link',
      title: 'Download link',
      icons: { '16': '/resources/icon.svg' },
      contexts: ['link', 'video', 'audio'],
      targetUrlPatterns: ['*://*/*'],
      onclick: requestsHandler.manageClick.bind(requestsHandler)
    });

    // Also prepare a duplicate entry as child of root entry.
    browser.contextMenus.create({
      id: 'dl-mngr.link-2',
      parentId: 'dl-mngr.root',
      title: 'Download link',
      icons: { '16': '/resources/icon.svg' },
      contexts: ['link', 'video', 'audio'],
      targetUrlPatterns: ['*://*/*'],
      onclick: requestsHandler.manageClick.bind(requestsHandler)
    });
    // Append separator before rest of menu.
    browser.contextMenus.create({
      id: 'dl-mngr.link-2-sep',
      parentId: 'dl-mngr.root',
      type: 'separator',
      contexts: ['link', 'video', 'audio'],
      targetUrlPatterns: ['*://*/*']
    });
  }

  reset() {
    for (var dlEntry of this.dlEntries) {
      browser.contextMenus.remove(dlEntry);
    }
    this.dlEntries = [];

    // Back to only one menu entry.
    browser.contextMenus.update('dl-mngr.root', {
      visible: false
    });
    browser.contextMenus.update('dl-mngr.link', {
      visible: true
    });
  }

  addEntry(title, onclick) {
    if (this.dlEntries.length == 0) {
      // Possibly more than one menu entry to show, use the root menu.
      browser.contextMenus.update('dl-mngr.link', {
        visible: false
      });
      browser.contextMenus.update('dl-mngr.root', {
        visible: true
      });
    }

    var id = `dl-mngr.dl.${this.dlEntries.length}`;
    this.dlEntries.push(id);
    browser.contextMenus.create({
      id: id,
      parentId: 'dl-mngr.root',
      title: title,
      icons: { '16': '/resources/icon.svg' },
      contexts: ['all'],
      onclick: onclick
    });
  }

}
