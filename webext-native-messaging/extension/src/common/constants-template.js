'use strict';

// Constants
export const constants = {

  // This extension id
  EXTENSION_ID: '__EXTENSION_ID__',
  // The associated native application id
  APPLICATION_ID: '__APPLICATION_ID__',

  // Idle timeout (ms)
  IDLE_TIMEOUT: 30 * 1000,
  // Timeout (ms) when waiting for any native app response
  NATIVE_RESPONSE_TIMEOUT: 20 * 1000,
  // Timeout (ms) when waiting for TiddlyWiki saving action to end
  TW_SAVE_TIMEOUT: 10 * 1000,
  // Timeout (ms) when waiting for WebSocket response
  WEBSOCKET_RESPONSE_TIMEOUT: 10 * 1000,

  // Maximum time to wait for next interception to ignore
  IGNORE_NEXT_TTL: 20 * 1000,

  // Kind of native message embedding fragments
  // Notes:
  // See: https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging
  // The maximum size of a single message from the application is 1 MB.
  // The maximum size of a message sent to the application is 4 GB.
  //
  // For our usage, we thus send messages as-is to the application, while the
  // application handle possible fragments for what it sends to us.
  // As we, the extension, only need to handle the reception of fragments, we
  // can do so by only checking two of the three kinds of fragments:
  //  - 'start': first fragment; otherwise we concatenate from previous fragments
  //  - 'cont': we are not done yet
  // And we don't need to declare/use the 'end' fragment kind, as we infer it if
  // a fragment is not 'start' nor 'cont'.
  FRAGMENT_KIND_START: 'start',
  FRAGMENT_KIND_CONT: 'cont',
  //FRAGMENT_KIND_END: 'end',

  // Minimum period (ms) between janitoring
  JANITORING_PERIOD: 10 * 1000,
  // TTL of received native message fragments
  FRAGMENTS_TTL: 10 * 1000,
  // TTL of pending requests
  REQUESTS_TTL: 120 * 1000,

  // Message known 'target' field values
  TARGET_BACKGROUND_PAGE: 'background page',
  TARGET_BROWSER_ACTION: 'browser action',
  TARGET_CONTENT_SCRIPT: 'content script',
  // Notes:
  // We handle 'options page' with the same code than 'browser action'.
  // We don't have nor need to send messages to 'page action', 'extension page', 'sidebar'.

  // Message known 'feature' field values
  FEATURE_APP: 'app',
  FEATURE_DOWNLOAD: 'download',
  FEATURE_TIDDLYWIKI: 'tiddlywiki',

  // Message known 'kind' field values
  KIND_ADD_MESSAGE: 'addMessage',
  KIND_CHECK_CONCURRENT: 'checkConcurrent',
  KIND_CHECK_NATIVE_APP: 'checkNativeApp',
  KIND_CLEAR_MESSAGES: 'clearMessages',
  KIND_CONSOLE: 'console',
  KIND_GET_MESSAGES: 'getMessages',
  KIND_IGNORE_NEXT: 'ignoreNext',
  KIND_NOTIFICATION: 'notification',
  KIND_SAVE: 'save',
  KIND_SPECS: 'specs',
  KIND_WARN_CONCURRENT: 'warnConcurrent'

};

// Notes:
// 'const' only prevents re-assigning the constants var.
// 'Object.freeze' makes the object read-only, preventing changing its content.
Object.freeze(constants);
