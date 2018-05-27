'use strict';


// Whether the 'concurrent' warning is displayed
// (to only display it only once until discarded)
var tw_warningConcurrent = false;

// Logs unhandled received extension messages.
function unhandledMessage(msg, sender) {
  console.warn('Received unhandled message %o from %o', msg, sender);
}

// Handles received extension messages.
// Note: 'async' so that we don't block and process the code asynchronously.
async function onMessage(extension, msg, sender) {
  switch (msg.feature) {
    case FEATURE_TIDDLYWIKI:
      tw_onMessage(extension, msg, sender);
      break;

    default:
      unhandledMessage(msg, sender);
      break;
  }
}

// Handles TW feature message.
function tw_onMessage(extension, msg, sender) {
  switch (msg.kind) {
    case KIND_WARN_CONCURRENT:
      tw_warnConcurrent(msg);
      break;

    default:
      unhandledMessage(msg, sender);
      break;
  }
}

// Displays modal message warning TiddlyWiki file (URL) is open in more than one tab/window.
function tw_warnConcurrent(msg) {
  // Display warning (unless already showing)
  if (!tw_warningConcurrent) {
    tw_warningConcurrent = true;
    displayModal('TiddlyWiki file already open', {
      body: 'This TiddlyWiki file is already open in another tab or window!',
      kind: 'error',
      callback: () => {
        tw_warningConcurrent = false;
      }
    });
  }
}

// Extension handler
var extension = new WebExtension(onMessage);

// We want to wait for 'document.body' to exist.
// The simplest way is to wait for 'DOMContentLoaded' which happens when the
// page has been loaded (not including stylesheets, images and subframes).
if (document.body !== null) {
  startExtension();
} else {
  document.addEventListener('DOMContentLoaded', ev => {
    startExtension();
  });
}

// Really starts extension
function startExtension() {
  // Enable TiddlyWiki handling when applicable.
  if (isTW5()) {
    try {
      tw_injectMessageBox();
      tw_checkConcurrent();
    } catch (error) {
      displayModal('Failed to initialize TiddlyWiki handling', {
        body: `Plugin '${EXTENSION_ID}' cannot handle TiddlyWiki saving action`,
        kind: 'error'
      });
      console.error('Failed to initialize TiddlyWiki handling: %o', error);
    }
  }
}

// Converts html text to real element.
// See: https://stackoverflow.com/a/35385518
function htmlToElement(html) {
  var template = document.createElement('template');
  html = html.trim();
  template.innerHTML = html;
  return template.content.firstChild;
}

// Displays a modal message.
// See: https://www.w3schools.com/howto/howto_css_modals.asp
function displayModal(title, params) {
  // The modal node
  var modal = htmlToElement('<div class="modal"><div class="modal-content"><div class="modal-header"><span class="modal-close">&times;</span></div><div class="modal-body"></div></div></div>');
  var modalHeader = modal.getElementsByClassName('modal-header')[0];
  var modalClose = modal.getElementsByClassName('modal-close')[0];
  var modalBody = modal.getElementsByClassName('modal-body')[0];

  // Fill the title (header) part
  var titleNode = title;
  if (typeof(title) !== 'object') {
    titleNode = document.createElement('h2');
    titleNode.appendChild(document.createTextNode(title));
  }
  modalHeader.appendChild(titleNode);
  modalHeader.classList.add('modal-' + params.kind);

  // Fill the message (body) part
  var bodyNode = params.body;
  if (typeof(params.body) !== 'object') {
    bodyNode = document.createElement('p');
    var first = true;
    for (var line of params.body.split('\n')) {
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
  for (var meta of document.getElementsByTagName('meta')) {
    if ((meta.name === 'application-name') && (meta.content === 'TiddlyWiki')) return true;
  }
  return false;
}

// Checks whether a same TiddlyWiki is open in other tabs/windows.
function tw_checkConcurrent() {
  // Delegate checking to background script, which will notify concerned tabs.
  extension.sendMessage({
    feature: 'tiddlywiki',
    kind: 'checkConcurrent',
    url: document.URL
  });
}

// Interoperate with TiddlyWiki save mechanism
function tw_injectMessageBox() {
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
  var messageBox = document.getElementById('tiddlyfox-message-box');
  if (messageBox) {
    var otherExtension = messageBox.getAttribute('data-message-box-creator') || null;
    // Note: when developing and reloading extension, we may see our previous
    // injected element, so filter us.
    if (otherExtension && (otherExtension != EXTENSION_ID)) {
      // We are not alone.
      displayModal('TiddlyWiki save extension already running', {
        body: `Extension '${otherExtension}' is already taking care of saving files.\n` +
          `Thus extension '${EXTENSION_ID}' will remain disabled to prevent any issue.`,
        kind: 'error'
      });
      return;
    } else {
      // We may be alone (not all plugins/extensions do this).
      messageBox.setAttribute('data-message-box-creator', EXTENSION_ID);
    }
  } else {
    // Create the node ourself.
    messageBox = document.createElement('div');
    messageBox.id = 'tiddlyfox-message-box';
    messageBox.style.display = 'none';
    messageBox.setAttribute('data-message-box-creator', EXTENSION_ID);
    document.body.appendChild(messageBox);
  }

  // Attach the event handler
  messageBox.addEventListener('tiddlyfox-save-file', event => {
    // Get the details
    var message = event.target;
    var path = message.getAttribute('data-tiddlyfox-path');
    var content = message.getAttribute('data-tiddlyfox-content');

    // Save the file
    extension.sendMessage({
      feature: FEATURE_TIDDLYWIKI,
      kind: KIND_SAVE,
      path: path,
      content: content
    }).then(r => {
      // Error are notified though the response 'error' field
      if (r.error) throw r.error;
      // Notify TiddlyWiki saving is done
      var ev = document.createEvent('Events');
      ev.initEvent('tiddlyfox-have-saved-file', true, false);
      message.dispatchEvent(ev);

      // Cleanup processed event
      message.parentNode.removeChild(message);
    }).catch(error => {
      // Saving failed
      displayModal('Could not save TiddlyWiki', {
        body: 'Failed to save file.\n' +
          formatObject(error),
        kind: 'error'
      });
      console.error('Failed to save TiddlyWiki: %o', error);
    });

    return false;
  });
}
