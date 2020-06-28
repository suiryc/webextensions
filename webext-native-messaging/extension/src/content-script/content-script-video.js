'use strict';

import { constants } from '../common/constants.js';
import * as util from '../common/util.js';
import { waitForSettings, settings } from '../common/settings.js';
import { WebExtension } from '../common/messaging.js';


util.checkContentScriptSetup('video');

// Handles received extension messages.
// Note: 'async' so that we don't block and process the code asynchronously.
async function onMessage(extension, msg, sender) {
  switch (msg.kind) {
    default:
      return unhandledMessage(msg, sender);
      break;
  }
}

// Logs unhandled messages received.
function unhandledMessage(msg, sender) {
  console.warn('Received unhandled message %o from %o', msg, sender);
  return {
    error: 'Message is not handled by video content script',
    message: msg
  };
}


// Extension handler
var webext = new WebExtension({ target: constants.TARGET_CONTENT_SCRIPT, onMessage: onMessage });

function findShadows(node) {
  // If the node itself is a shadow host, process it.
  if (node.sharowRoot instanceof Node) {
    processShadow(node);
    return;
  }

  // Find and process all shadow elements.
  for (var child of node.getElementsByTagName('*')) {
    if (child.shadowRoot instanceof Node) processShadow(child);
  };
}

function processShadow(node) {
  // Observe and find video in each child.
  for (var child of node.shadowRoot.children) {
    if (child.tagName !== 'VIDEO') nodesObserver.observe(child, { childList: true, subtree: true });
    findVideo(child);
  }
}

function findVideo(node) {
  // If the node is a video, process it.
  if (node.tagName === 'VIDEO') {
    processVideo(node);
    return;
  }

  // Otherwise, search for 'video' children.
  for (var v of node.getElementsByTagName('video')) {
    processVideo(v);
  }

  // There may be shadow elements. Find and process them.
  // See: https://developer.mozilla.org/en-US/docs/Web/Web_Components/Using_shadow_DOM
  // See: https://developer.mozilla.org/fr/docs/Web/API/Element/shadowRoot
  // Example: https://developer.mozilla.org/en-US/docs/Web/HTML/Element/video
  findShadows(node);
}

// Note: see processVideo for details.
const VIDEO_EVENTS_BAILOUT = new Set(['play', 'playing']);
const VIDEO_EVENTS = ['loadstart', 'loadeddata', 'canplay', 'canplaythrough', 'progress', 'play', 'playing'];

// Notes:
// Right after the page is loaded, some sites appear to create short-live
// frame(s) that contain video, immediately removed/replaced by the actual
// frame(s) with the video.
// Due to the very short lifecycle of those frames, often either:
//  - the extension fails to inject the content script: frame already gone
//  - the content script has not enough time before the frame is gone
// Sometimes the content script has enough time to find the video and send the
// source to the background script. The found source url may be different from
// the final video, thus creating additional menu entries.
// To workaround this we prevent sending messages until a given amount of time
// has elapsed since the content script execution started: 100ms appear to be
// enough most of the time.
const delayed = util.delayPromise(100);

function processVideo(node) {
  // Notes:
  // Page can add 'source' tags children to the video. Its purpose is to let
  // the browser use the first one (listed in order of priority) it can handle.
  // Example: https://developer.mozilla.org/en-US/docs/Web/HTML/Element/video
  // Usually there should be no need to look for (+ observe mutations) those
  // tags.
  // If the browser actually does not handle the first one, and if we wanted to
  // take this into account, it would require managing multiple source urls for
  // the same video: we cannot assume that the sources filtered out by the
  // browser are actually better for us to download; so at best we should add
  // them as possibly better variants.
  //
  // The 'src' and 'currentSrc' video fields may be undefined/empty at first.
  // Depending on how the page uses the video, either:
  //  - the src/currentSrc will be automatically known soon
  //  - the src/currentSrc will be known after user interacts with the video
  //    or page
  // It is possible to observe 'src' attribute changes. This however does not
  // work for the 'currentSrc' read-only field.
  // As a complement, there are many events that we can listen to on the video
  // node, like loadstart, loadeddata, canplay, canplaythrough, progress, play
  // or playing. Thoses events are triggered depending on the current state of
  // the video, as well as user interactions.
  // See: https://developer.mozilla.org/en-US/docs/Web/Guide/Events/Media_events
  // See: https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement
  // Example: https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/loadstart_event
  //
  // So if neither src nor currentSrc is known right now, observe changes and
  // listen for events until either one is finally known.
  // We can stop observing/listening once known. Similarly, when we reach media
  // events indicating the video is running (e.g. play or playing), assume that
  // if we still don't have a src/currentSrc, we will never have: the stream is
  // probably progammatically made.

  function nonEmpty(field) {
    return ((node[field] !== undefined) && (node[field] !== null) && (node[field].trim() !== ''));
  }

  async function addVideoSource(field) {
    if (!nonEmpty(field)) return;
    var src = node[field];
    // Prevent sending message until a given amount of time has elapsed since
    // the content script started.
    await delayed;
    webext.sendMessage({
      target: constants.TARGET_BACKGROUND_PAGE,
      kind: constants.KIND_ADD_VIDEO_SOURCE,
      csUuid: csParams.uuid,
      src: src
    });
  }

  function processVideoSource() {
    addVideoSource('src');
    if (node.currentSrc != node.src) addVideoSource('currentSrc');
  }

  // 'src' changes observer.
  // Unfortunately, we actually cannot observe 'currentSrc' changes. Still ask
  // for it, in case it become possible in the future.
  var sourceObserver = new MutationObserver(function(mutations, observer) {
    for (var mutation of mutations) {
      if ((mutation.attributeName == 'src') || (mutation.attributeName == 'currentSrc')) {
        processVideoSource();
        // Stop observing once we have a source url.
        if (nonEmpty('src') || nonEmpty('currentSrc')) unobserve('mutation');
      }
    }
  });

  function eventCb(event) {
    processVideoSource();
    // Stop observing once we have a source url.
    // There is no point listening if the video is playing while we don't know
    // the src: the stream is probably passed programmatically.
    if (VIDEO_EVENTS_BAILOUT.has(event.type) || nonEmpty('src') || nonEmpty('currentSrc')) unobserve('event');
  }

  function observe() {
    if (settings.debug.video) console.log('Observing video source=<%o>', node);
    VIDEO_EVENTS.forEach(kind => node.addEventListener(kind, eventCb));
    sourceObserver.observe(node, {
      attributes: true,
      attributeFilter: ['src', 'currentSrc']
    });
  }

  function unobserve(reason) {
    if (settings.debug.video) {
      if (nonEmpty('src')) console.log('Finished observing video source=<%o>: src=<%s> known upon %s', node, node.src, reason);
      else if (nonEmpty('currentSrc')) console.log('Finished observing video source=<%o>: currentSrc=<%s> known upon %s', node, node.currentSrc, reason);
      else console.log('Finished observing video source=<%o>: still no src upon final %s', node, node.src, reason);
    }
    VIDEO_EVENTS.forEach(kind => node.removeEventListener(kind, eventCb));
    sourceObserver.disconnect();
  }

  // If there is no src nor currentSrc, we need to look for changes until it
  // happens.
  if (nonEmpty('src') || nonEmpty('currentSrc')) {
    // Process source.
    processVideoSource();
  } else {
    observe();
  }
}

var nodesObserver = new MutationObserver(function(mutations, observer) {
  for (var mutation of mutations) {
    for (var added of mutation.addedNodes) {
      findVideo(added);
    }
  }
});

waitForSettings().then(() => {
  return util.waitForDocument();
}).then(() => {
  // Observe mutations in document, to detect new video tags being added.
  nodesObserver.observe(document.body, { childList: true, subtree: true });
  // Lookup existing video tags.
  findVideo(document.body);
});
