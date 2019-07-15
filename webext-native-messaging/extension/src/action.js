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
    case FEATURE_APP:
      return app_onMessage(extension, msg, sender);
      break;

    default:
      unhandledMessage(msg, sender);
      break;
  }
}

// Handles application feature message.
function app_onMessage(extension, msg, sender) {
  switch (msg.kind) {
    case KIND_IGNORE_NEXT:
      return app_ignoreNext(msg);
      break;

    case KIND_ADD_MESSAGE:
      return app_addMessage(msg);
      break;

    default:
      unhandledMessage(msg, sender);
      break;
  }
}

// Next interception is being ignored.
function app_ignoreNext(msg) {
  var ttl = msg.ttl / 1000;
  ignoringNext = (ttl > 0);
  // Update displayed button text: append remaining TTL if any.
  if (ignoringNext) ignoreNextButton.textContent = `${ignoreNextText} (${ttl}s)`;
  else ignoreNextButton.textContent = ignoreNextText;
}

// Adds message to display.
function app_addMessage(msg) {
  addMessage(msg.details);
}

// Extension handler
var extension = new WebExtension({ target: TARGET_BROWSER_ACTION, onMessage: onMessage });

var ignoreNextButton = document.querySelector('#ignoreNext');
var ignoreNextText = ignoreNextButton.textContent;
var ignoringNext = false;
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
  messagesNode.classList.remove('hidden');
}

// Ignore next interception when requested.
ignoreNextButton.addEventListener('click', () => {
  // Cancel if we are already igoring.
  extension.sendMessage({
    target: TARGET_BACKGROUND_PAGE,
    feature: FEATURE_APP,
    kind: KIND_IGNORE_NEXT,
    ttl: ignoringNext ? 0 : undefined
  });
});

// Clear messages when requested.
clearMessagesButton.addEventListener('click', () => {
  extension.sendMessage({
    target: TARGET_BACKGROUND_PAGE,
    feature: FEATURE_APP,
    kind: KIND_CLEAR_MESSAGES
  }).then(() => {
    messagesNode.classList.add('hidden');
  });
});

// Get and add application messages.
extension.sendMessage({
  target: TARGET_BACKGROUND_PAGE,
  feature: FEATURE_APP,
  kind: KIND_GET_MESSAGES
}).then(r => {
  if ((r === undefined) || !Array.isArray(r) || !r.length) return;

  for (var details of r) {
    addMessage(details);
  }
});
