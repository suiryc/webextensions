'use strict';

import { constants } from '../common/constants.js';
import * as util from '../common/util.js';
import { settings } from '../common/settings.js';


// Whether the 'concurrent' warning is displayed
// (to only display it only once until discarded)
let warningConcurrent = false;

// Displays modal message warning TiddlyWiki file (URL) is open in more than one tab/window.
export function warnConcurrent(msg) {
  // Display warning (unless already showing)
  if (!warningConcurrent) {
    warningConcurrent = true;
    displayModal('TiddlyWiki file already open', {
      body: 'This TiddlyWiki file is already open in another tab or window!',
      kind: 'error',
      callback: () => {
        warningConcurrent = false;
      }
    });
  }
}

export async function run() {
  // We only work in top frame of 'file:' documents.
  if ((window !== window.top) || !document.URL.match(/^file:.*html?$/i)) return;

  await util.waitForDocument();

  // Inject our CSS.
  let link = document.createElement('link');
  link.href = browser.runtime.getURL('/resources/content-script-tw.css');
  link.type = 'text/css';
  link.rel = 'stylesheet';
  document.head.appendChild(link);

  // Enable TiddlyWiki handling when applicable.
  let ready = false;
  if (isTW5()) {
    if (settings.debug.misc) console.log('Is TW5');
    try {
      injectMessageBox();
      checkConcurrent();
      ready = true;
    } catch (error) {
      displayModal('Failed to initialize TiddlyWiki handling', {
        body: `Plugin '${constants.EXTENSION_ID}' cannot handle TiddlyWiki saving action`,
        kind: 'error'
      });
      console.error('Failed to initialize TiddlyWiki handling:', error);
    }
  } else if (settings.debug.misc) {
    console.log('Is not TW5');
  }

  if (ready) {
    webext.sendMessage({
      target: constants.TARGET_BACKGROUND_PAGE,
      kind: constants.KIND_CHECK_NATIVE_APP
    }).then(r => {
      if (r.error) {
        displayModal('Native application is not working', {
          body: `Native application '${constants.APPLICATION_ID}' checking returned an error:\n${util.formatObject(r.error)}`,
          kind: 'error'
        });
        console.error('Native application is not working:', r.error);
      }
    });
  }
}

// Displays a modal message.
// See: https://www.w3schools.com/howto/howto_css_modals.asp
function displayModal(title, params) {
  // The modal node
  let modal = util.htmlToElement('<div class="modal"><div class="modal-content"><div class="modal-header"><span class="modal-close">&times;</span></div><div class="modal-body"></div></div></div>');
  let modalHeader = modal.getElementsByClassName('modal-header')[0];
  let modalClose = modal.getElementsByClassName('modal-close')[0];
  let modalBody = modal.getElementsByClassName('modal-body')[0];

  // Fill the title (header) part
  let titleNode = title;
  if (typeof(title) !== 'object') {
    titleNode = document.createElement('h2');
    titleNode.appendChild(document.createTextNode(title));
  }
  modalHeader.appendChild(titleNode);
  modalHeader.classList.add(`modal-${params.kind}`);

  // Fill the message (body) part
  let bodyNode = params.body;
  if (typeof(params.body) !== 'object') {
    bodyNode = document.createElement('p');
    let first = true;
    for (let line of params.body.split('\n')) {
      if (first) first = false;
      else bodyNode.appendChild(document.createElement('br'));
      bodyNode.appendChild(document.createTextNode(line));
    }
  }
  modalBody.appendChild(bodyNode);

  // Insert and display message
  modal.style.display = 'block';
  document.body.appendChild(modal);

  // Remove modal message when 'close' icon is clicked
  modalClose.addEventListener('click', event => {
    if (params.callback) params.callback();
    modal.style.display = 'none';
    document.body.removeChild(modal);
  });
}

// Gets whether this is a TW5 document
function isTW5() {
  // TW5 has a <meta name="application-name" content="TiddlyWiki" /> header
  for (let meta of document.getElementsByTagName('meta')) {
    if ((meta.name === 'application-name') && (meta.content === 'TiddlyWiki')) return true;
  }
  return false;
}

// Checks whether a same TiddlyWiki is open in other tabs/windows.
function checkConcurrent() {
  // Delegate checking to background script, which will notify concerned tabs.
  // Remove fragment from URL so that querying tabs will work as expected: in
  // Firefox 69, querying does not take into account the fragment part in tabs
  // URL, but the queried URL is used as-is (with its fragment if present).
  webext.sendMessage({
    target: constants.TARGET_BACKGROUND_PAGE,
    kind: constants.KIND_TW_CHECK_CONCURRENT,
    url: util.normalizeUrl(document.URL)
  });
}

function getSavePath(message) {
  // Notes:
  // Historically, TW generates a 'tiddlyfox-save-file' message, which field
  // 'data-tiddlyfox-path' points to the save path.
  //return message.getAttribute('data-tiddlyfox-path');
  // See: https://github.com/Jermolene/TiddlyWiki5/blob/master/core/modules/savers/tiddlyfox.js
  // It cleanups/decodes the documentation location.
  // When there are unicode characters, it mostly works on Windows, but should
  // not on Linux because for the latter the code does call 'unescape' when
  // cleaning: this is expected to simply decode url-encoded characters (either
  // ascii %XX or unicode %uXXXX).
  // This function is not called for Windows local paths (non-WSL at least).
  // It does later call 'decodeURIComponent', which is the good one: decodes
  // url-encoded characters as an UTF-8 encoding. But it is too late in Linux
  // case.

  let pathname = document.location.toString().split("#")[0];
  // Replace file://localhost/ with file:///
  if (pathname.indexOf("file://localhost/") === 0) {
    pathname = `file://${pathname.substr(16)}`;
  }
  if (/^file\:\/\/\/[A-Z]\:\//i.test(pathname)) {
    // Windows path file:///x:/blah/blah --> x:\blah\blah
    pathname = pathname.substr(8).replace(/\//g, "\\");
  } else if (pathname.indexOf("file://///") === 0) {
    // Firefox Windows network path file://///server/share/blah/blah --> //server/share/blah/blah
    pathname = "\\\\" + pathname.substr(10).replace(/\//g, "\\");
  } else if (pathname.indexOf("file:///") === 0) {
    // Mac/Unix local path file:///path/path --> /path/path
    pathname = pathname.substr(7);
  } else if (pathname.indexOf("file:/") === 0) {
    // Mac/Unix local path file:/path/path --> /path/path
    pathname = pathname.substr(5);
  } else {
    // Otherwise Windows networth path file://server/share/path/path --> \\server\share\path\path
    pathname = "\\\\" + pathname.substr(7).replace(new RegExp("/","g"), "\\");
  }
  try {
    pathname = decodeURI(pathname);
  } catch {}
  return pathname;
}

// Interoperate with TiddlyWiki save mechanism
function injectMessageBox() {
  // See: https://groups.google.com/forum/#!msg/tiddlywiki/BWkudgla4ms/mvv6mxeg0lAJ
  // TW5 will emit an 'tiddlyfox-save-file' event on 'tiddlyfox-message-box' node,
  // containing text and path to save.
  // When saver is done, it emits back an 'tiddlyfox-have-saved-file' event.
  //
  // Also see other plugins/extensions (e.g. https://github.com/pmario/file-backups)
  // for more details.
  //
  // To interop with other extensions, add an attribute to the node to detect whether
  // another extension is already handling saving.

  // Inject the message box
  let messageBox = document.getElementById('tiddlyfox-message-box');
  if (messageBox) {
    let otherExtension = messageBox.getAttribute('data-message-box-creator') || null;
    // Note: when developing and reloading extension, we may see our previous
    // injected element, so filter us.
    if (otherExtension && (otherExtension != constants.EXTENSION_ID)) {
      // We are not alone.
      displayModal('TiddlyWiki save extension already running', {
        body: `Extension '${otherExtension}' is already taking care of saving files.\n` +
          `Thus extension '${constants.EXTENSION_ID}' will remain disabled to prevent any issue.`,
        kind: 'error'
      });
      return;
    } else {
      // We may be alone (not all plugins/extensions do this).
      messageBox.setAttribute('data-message-box-creator', constants.EXTENSION_ID);
    }
  } else {
    // Create the node ourself.
    messageBox = document.createElement('div');
    messageBox.id = 'tiddlyfox-message-box';
    messageBox.style.display = 'none';
    messageBox.setAttribute('data-message-box-creator', constants.EXTENSION_ID);
    document.body.appendChild(messageBox);
  }

  // Attach the event handler
  messageBox.addEventListener('tiddlyfox-save-file', event => {
    // Get the details
    let message = event.target;
    let path = getSavePath(message);
    let content = message.getAttribute('data-tiddlyfox-content');

    // Save the file
    webext.sendMessage({
      target: constants.TARGET_BACKGROUND_PAGE,
      kind: constants.KIND_TW_SAVE,
      path,
      content
    }).then(r => {
      // Error are notified though the response 'error' field
      if (r.error) throw r.error;
      // Notify TiddlyWiki saving is done
      let ev = document.createEvent('Events');
      ev.initEvent('tiddlyfox-have-saved-file', true, false);
      message.dispatchEvent(ev);

      // Cleanup processed event
      message.parentNode.removeChild(message);
    }).catch(error => {
      // Saving failed
      displayModal('Could not save TiddlyWiki', {
        body: 'Failed to save file.\n' +
          util.formatObject(error),
        kind: 'error'
      });
      console.error('Failed to save TiddlyWiki:', error);
    });

    return false;
  });
}
