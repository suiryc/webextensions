'use strict';

import { constants } from '../common/constants.js';
import * as util from '../common/util.js';
import * as unsafe from '../common/unsafe.js';
import { settings } from '../common/settings.js';


function findShadows(node) {
  // If the node itself is a shadow host, process it.
  if (node.sharowRoot instanceof Node) {
    processShadow(node);
    return;
  }

  // Find and process all shadow elements.
  // Note: depending on node type (e.g. text node), there may be no children
  // available and thus no 'getElementsByTagName' method.
  if (node.getElementsByTagName) {
    for (let child of node.getElementsByTagName('*')) {
      if (child.shadowRoot instanceof Node) processShadow(child);
    }
  }
}

function processShadow(node) {
  // Observe and find video in each child.
  for (let child of node.shadowRoot.children) {
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
  // Note: depending on node type (e.g. text node), there may be no children
  // available and thus no 'getElementsByTagName' method.
  if (node.getElementsByTagName) {
    for (let v of node.getElementsByTagName('video')) {
      processVideo(v);
    }
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
//
// Important:
// When the tab is not active, timer related things have their precision highly
// degraded: setTimeout will have a minimum delay/precision of 1s.
// See: https://bugzilla.mozilla.org/show_bug.cgi?id=633421
// See: https://codereview.chromium.org/6577021
// To workaround this, we would need to either:
//  - use requestAnimationFrame is possible
//    See: https://developer.mozilla.org/en-US/docs/Web/API/window/requestAnimationFrame
//  - use a WebWorker, or SharedWorker, to actually do the waiting, relying on
//    messaging with the script: unlike the content script it is not impacted
//    by tab activity
//  - use the background script instead of a dedicated WebWorker for this ?
//  - adapt the initial behaviour depending on whether the tab is supposed to
//    be active (through page visibility) ?
//    See: https://www.w3.org/TR/page-visibility/#onvisiblitychange-event-handler
// In our specific case, we don't really need to workaround it: if the tab is
// not active, we are not seeing it right now, neither the browser action icon
// or context menu in which we show found videos. As such we are not really in
// need for this code to have a precise timing when tab is inactive.
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
    return (node[field] && node[field].trim());
  }

  async function addVideoSource(field) {
    if (!nonEmpty(field)) return;
    let src = node[field];
    // Prevent sending message until a given amount of time has elapsed since
    // the content script started.
    await delayed;
    let args = {
      params: {
        src
      }
    };
    let scriptResult = await unsafe.executeCode({
      webext,
      name: 'download refining',
      args,
      setting: settings.video.downloadRefining,
      notifDefaults
    });
    util.cleanupFields(scriptResult);
    webext.sendMessage(Object.assign({
      target: constants.TARGET_BACKGROUND_PAGE,
      kind: constants.KIND_ADD_VIDEO_SOURCE,
      src
    }, scriptResult));
  }

  function processVideoSource() {
    addVideoSource('src');
    if (node.currentSrc != node.src) addVideoSource('currentSrc');
  }

  // 'src' changes observer.
  // Unfortunately, we actually cannot observe 'currentSrc' changes. Still ask
  // for it, in case it become possible in the future.
  let sourceObserver = new MutationObserver(function(mutations, observer) {
    for (let mutation of mutations) {
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

let nodesObserver = new MutationObserver(function(mutations, observer) {
  for (let mutation of mutations) {
    for (let added of mutation.addedNodes) {
      findVideo(added);
    }
  }
});

export async function run() {
  if (!settings.video.intercept || !document.URL.startsWith('http')) return;

  await util.waitForDocument();
  // Observe mutations in document, to detect new video tags being added.
  nodesObserver.observe(document.body, { childList: true, subtree: true });
  // Lookup existing video tags.
  findVideo(document.body);
}
