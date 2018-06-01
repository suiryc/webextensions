'use strict';

// Constants

// This extension id
const EXTENSION_ID = 'native-messaging@suiryc';
// The associated native application id
const APPLICATION_ID = 'suiryc.webext.native';

// Idle timeout (ms)
const IDLE_TIMEOUT = 30 * 1000;
// Timeout (ms) when waiting for any native app response
const NATIVE_RESPONSE_TIMEOUT = 20 * 1000;
// Timeout (ms) when waiting for TiddlyWiki saving action to end
const TW_SAVE_TIMEOUT = 10 * 1000;

// Kind of native message embedding fragments
const FRAGMENT_KIND_START = 'start';
const FRAGMENT_KIND_CONT = 'cont';
const FRAGMENT_KIND_END = 'end';

// Minimum period (ms) between messages janitoring
const JANITORING_PERIOD = 10 * 1000;
// TTL of received native message fragments
const FRAGMENTS_TTL = 10 * 1000;

// Message known 'feature' field values
const FEATURE_APP = 'app';
const FEATURE_TIDDLYWIKI = 'tiddlywiki';

// Message known 'kind' field values
const KIND_CHECK_CONCURRENT = 'checkConcurrent';
const KIND_CONSOLE = 'console';
const KIND_SAVE = 'save';
const KIND_SPECS = 'specs';
const KIND_WARN_CONCURRENT = 'warnConcurrent';
