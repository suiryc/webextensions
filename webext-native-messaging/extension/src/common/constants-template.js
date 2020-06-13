'use strict';

// Constants

// This extension id
export const EXTENSION_ID = '__EXTENSION_ID__';
// The associated native application id
export const APPLICATION_ID = '__APPLICATION_ID__';

// Idle timeout (ms)
export const IDLE_TIMEOUT = 30 * 1000;
// Timeout (ms) when waiting for any native app response
export const NATIVE_RESPONSE_TIMEOUT = 20 * 1000;
// Timeout (ms) when waiting for TiddlyWiki saving action to end
export const TW_SAVE_TIMEOUT = 10 * 1000;
// Timeout (ms) when waiting for WebSocket response
export const WEBSOCKET_RESPONSE_TIMEOUT = 10 * 1000;

// Maximum time to wait for next interception to ignore
export const IGNORE_NEXT_TTL = 20 * 1000;

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
export const FRAGMENT_KIND_START = 'start';
export const FRAGMENT_KIND_CONT = 'cont';
//export const FRAGMENT_KIND_END = 'end';

// Minimum period (ms) between janitoring
export const JANITORING_PERIOD = 10 * 1000;
// TTL of received native message fragments
export const FRAGMENTS_TTL = 10 * 1000;
// TTL of pending requests
export const REQUESTS_TTL = 120 * 1000;

// Message known 'target' field values
export const TARGET_BACKGROUND_PAGE = 'background page';
export const TARGET_BROWSER_ACTION = 'browser action';
export const TARGET_CONTENT_SCRIPT = 'content script';
// Notes:
// We handle 'options page' with the same code than 'browser action'.
// We don't have nor need to send messages to 'page action', 'extension page', 'sidebar'.

// Message known 'feature' field values
export const FEATURE_APP = 'app';
export const FEATURE_DOWNLOAD = 'download';
export const FEATURE_TIDDLYWIKI = 'tiddlywiki';

// Message known 'kind' field values
export const KIND_ADD_MESSAGE = 'addMessage';
export const KIND_CHECK_CONCURRENT = 'checkConcurrent';
export const KIND_CHECK_NATIVE_APP = 'checkNativeApp';
export const KIND_CLEAR_MESSAGES = 'clearMessages';
export const KIND_CONSOLE = 'console';
export const KIND_GET_MESSAGES = 'getMessages';
export const KIND_IGNORE_NEXT = 'ignoreNext';
export const KIND_NOTIFICATION = 'notification';
export const KIND_SAVE = 'save';
export const KIND_SPECS = 'specs';
export const KIND_WARN_CONCURRENT = 'warnConcurrent';
