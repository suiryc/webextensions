'use strict';


// Wait for settings to be ready, then track fields changes (to persist settings).
waitForSettings().then(() => trackFields());

// Logs unhandled received extension messages.
function unhandledMessage(msg, sender) {
  console.warn('Received unhandled message %o from %o', msg, sender);
}

// Handles received extension messages.
// Note: 'async' so that we don't block and process the code asynchronously.
async function onMessage(extension, msg, sender) {
  try {
    return handleMessage(extension, msg, sender);
  } catch (error) {
    console.error('Could not handle sender %o message %o: %o', sender, msg, error);
    // Propagate error.
    throw error;
  }
}

function handleMessage(extension, msg, sender) {
  switch (msg.feature) {
    default:
      unhandledMessage(msg, sender);
      break;
  }
}

// Extension handler
var extension = new WebExtension(onMessage);

var clearMessagesButton = document.querySelector('#clearMessages');
var messagesNode = document.querySelector('#messages');
var iconExclamationTriangle = document.querySelector('#icon-exclamation-triangle');
var iconInfoCircle = document.querySelector('#icon-info-circle');
var messageNode = document.querySelector('#message');

function cloneNode(node) {
  var cloned = node.cloneNode(true);
  cloned.removeAttribute('id');
  return cloned;
}

function replaceNode(node1, node2) {
  node1.parentNode.replaceChild(node2, node1);
}

function addMessage(details) {
  var level = details.level;
  var node = cloneNode(messageNode);
  var icon;
  var message = formatApplicationMessage(details);

  if (level == 'error') {
    icon = cloneNode(iconExclamationTriangle);
    icon.classList.add('error');
  } else if (level == 'warn') {
    icon = cloneNode(iconExclamationTriangle);
    icon.classList.add('warning');
  } else {
    icon = cloneNode(iconInfoCircle);
  }
  replaceNode(node.querySelector('.icon'), icon);
  node.querySelector('.title').innerHTML = details.title;
  message = message.replace(/\n/g, '<br>');
  node.querySelector('.content').innerHTML = message;

  messagesNode.appendChild(node);
}

// Clear messages when requested.
clearMessagesButton.addEventListener('click', () => {
  extension.sendMessage({
    feature: FEATURE_APP,
    kind: KIND_CLEAR_MESSAGES
  }).then(() => {
    messagesNode.classList.add('hidden');
  });
});

// Get and add application messages.
extension.sendMessage({
  feature: FEATURE_APP,
  kind: KIND_GET_MESSAGES
}).then(r => {
  if ((r === undefined) || !Array.isArray(r) || !r.length) return;

  messagesNode.classList.remove('hidden');
  for (var details of r) {
    addMessage(details);
  }
});
