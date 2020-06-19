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

  // Message known 'kind' field values
  KIND_CHECK_NATIVE_APP: 'checkNativeApp',
  KIND_CLEAR_MESSAGES: 'clearMessages',
  KIND_CONSOLE: 'console',
  KIND_DL_IGNORE_NEXT: 'dlIgnoreNext',
  KIND_DOWNLOAD: 'download',
  KIND_ECHO: 'echo',
  KIND_EXT_MESSAGE: 'extMessage',
  KIND_GET_EXT_MESSAGES: 'getExtMessages',
  KIND_NOTIFICATION: 'notification',
  KIND_SPECS: 'specs',
  KIND_TW_CHECK_CONCURRENT: 'twCheckConcurrent',
  KIND_TW_SAVE: 'twSave',
  KIND_TW_WARN_CONCURRENT: 'twWarnConcurrent'

};

// Notes:
// 'const' only prevents re-assigning the constants var.
// 'Object.freeze' makes the object read-only, preventing changing its content.
Object.freeze(constants);
