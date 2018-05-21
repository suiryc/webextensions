// Whether the 'concurrent' warning is displayed
var tw_warningConcurrent = false;

// Handles extension messages.
// 'async' so that we don't block and process the code asynchronously.
async function onMessage(extension, msg, sender) {
  // TODO: debug
  console.debug('Received message', msg, 'from', sender);
  switch (msg.feature) {
    case FEATURE_TIDDLYWIKI:
      tw_onMessage(extension, msg, sender);
      break;
  }
}

// Handles TW feature message.
function tw_onMessage(extension, msg, sender) {
  switch (msg.kind) {
    case KIND_WARN_CONCURRENT:
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
      break;
  }
}

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

function startExtension() {
  if (isTW5()) {
    try {
      tw_injectMessageBox();
      tw_checkConcurrent();
    } catch (error) {
      displayModal('Failed to initialize TiddlyWiki handling', {
        body: 'Plugin \'' + PLUGIN_NAME + '\' cannot handle TiddlyWiki saving action',
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
  var modal = htmlToElement('<div class="modal"><div class="modal-content"><div class="modal-header"><span class="modal-close">&times;</span></div><div class="modal-body"></div></div></div>');
  var modalHeader = modal.getElementsByClassName('modal-header')[0];
  var modalClose = modal.getElementsByClassName('modal-close')[0];
  var modalBody = modal.getElementsByClassName('modal-body')[0];

  var titleNode = title;
  if (typeof(title) !== 'object') {
    titleNode = document.createElement('h2');
    titleNode.appendChild(document.createTextNode(title));
  }
  modalHeader.appendChild(titleNode);
  modalHeader.classList.add('modal-' + params.kind);

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
  modal.style.display = 'block';

  document.body.appendChild(modal);
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

function tw_injectMessageBox() {
  // Inject the message box
  var messageBox = document.getElementById("tiddlyfox-message-box");
  if (messageBox) {
    var otherPlugin = messageBox.getAttribute("data-message-box-creator") || null;
    // Note: when developing and reloading extension, we may see our previous
    // injected element.
    if (otherPlugin && (otherPlugin != PLUGIN_NAME)) {
      displayModal('TiddlyWiki save plugin already running', {
        body: 'Plugin \'' + otherPlugin + '\' is already taking care of saving files.\n' +
          'Thus plugin \'' + PLUGIN_NAME + '\' will remain disabled to prevent any issue.',
        kind: 'error'
      });
      return;
    } else {
      messageBox.setAttribute("data-message-box-creator", PLUGIN_NAME);
    }
  } else {
    messageBox = document.createElement("div");
    messageBox.id = "tiddlyfox-message-box";
    messageBox.style.display = "none";
    messageBox.setAttribute("data-message-box-creator", PLUGIN_NAME);
    document.body.appendChild(messageBox);
  }
  // Attach the event handler to the message box
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
      if (r.error) throw r.error;
      var event1 = document.createEvent('Events');
      message.parentNode.setAttribute('data-tiddlyfox-subdir', r.subdir || '');
      event1.initEvent('tiddlyfox-have-saved-file', true, false);
      message.dispatchEvent(event1);

      // Remove element from the message box, to reduce DOM size
      message.parentNode.removeChild(message);
    }).catch(error => {
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
