'use strict';

// Constants
export const constants = {

  // This extension id
  EXTENSION_ID: '__EXTENSION_ID__',
  // The associated native application id
  APPLICATION_ID: '__APPLICATION_ID__',

  // Idle timeout (ms)
  IDLE_TIMEOUT: 30 * 1000,
  // Timeout (ms) when waiting for any extension response
  // (reminder: an internal message may trigger a native or webextension one)
  MESSAGE_RESPONSE_TIMEOUT: 20 * 1000,
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
  TARGET_OPTIONS_UI: 'options ui',
  // Notes:
  // We handle 'options page' with the same code than 'browser action'.
  // We don't have nor need to send messages to 'page action', 'extension page', 'sidebar'.

  // Message known 'kind' field values
  KIND_ADD_VIDEO_SOURCE: 'addVideoSource',
  KIND_CHECK_NATIVE_APP: 'checkNativeApp',
  KIND_CLEAR_MESSAGES: 'clearMessages',
  KIND_CLEAR_MESSAGE: 'clearMessage',
  KIND_CONSOLE: 'console',
  KIND_DL_IGNORE_NEXT: 'dlIgnoreNext',
  KIND_DL_UPDATE_VIDEOS: 'dlUpdateVideos',
  KIND_DL_VIDEO: 'dlVideo',
  KIND_DOWNLOAD: 'download',
  KIND_ECHO: 'echo',
  KIND_EXT_MESSAGE: 'extMessage',
  KIND_GET_DL_VIDEOS: 'getDlVideos',
  KIND_GET_EXT_MESSAGES: 'getExtMessages',
  KIND_NOTIFICATION: 'notification',
  KIND_REGISTER_PORT: 'registerPort',
  KIND_REGISTER_TABS_EVENTS: 'registerTabsEvents',
  KIND_SPECS: 'specs',
  KIND_TABS_EVENT: 'tabsEvent',
  KIND_TW_CHECK_CONCURRENT: 'twCheckConcurrent',
  KIND_TW_SAVE: 'twSave',
  KIND_TW_WARN_CONCURRENT: 'twWarnConcurrent',

  // Windows/tabs/frames events
  EVENT_FRAME_ADDED: 'frameAdded',
  EVENT_FRAME_REMOVED: 'frameRemoved',
  EVENT_FRAME_RESET: 'frameReset',
  EVENT_TAB_ACTIVATED: 'tabActivated',
  EVENT_TAB_ADDED: 'tabAdded',
  EVENT_TAB_ATTACHED: 'tabAttached',
  EVENT_TAB_CREATED: 'tabCreated',
  EVENT_TAB_UPDATED: 'tabUpdated',
  EVENT_TAB_DETACHED: 'tabDetached',
  EVENT_TAB_FOCUSED: 'tabFocused',
  EVENT_TAB_REMOVED: 'tabRemoved',
  EVENT_TAB_RESET: 'tabReset',
  EVENT_WINDOW_FOCUSED: 'windowFocused',
  EVENT_WINDOW_REMOVED: 'windowRemoved',

  // Mouse buttons: https://developer.mozilla.org/en-US/docs/Web/API/MouseEvent/buttons
  MOUSE_BUTTON_LEFT: 1,
  MOUSE_BUTTON_RIGHT: 2

};

for (let key of Object.keys(constants).filter(key => key.startsWith('EVENT_'))) {
  let category = `EVENTS_${key.split('_')[1]}`;
  if (!constants[category]) constants[category] = new Set();
  constants[category].add(constants[key]);
}
constants.EVENTS_TABS = new Set([...constants.EVENTS_WINDOW, ...constants.EVENTS_TAB, ...constants.EVENTS_FRAME]);

// Notes:
// 'const' only prevents re-assigning the constants let/var.
// 'Object.freeze' makes the object read-only, preventing changing its content.
Object.freeze(constants);
