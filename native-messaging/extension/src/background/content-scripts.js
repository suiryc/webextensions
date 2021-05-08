'use strict';

import { settings } from '../common/settings.js';


// Handles dynamic content script injection in frames.
// Observes changes to handle 'new' frames:
//  - a (brand new) frame is added
//  - an existing frame is being reused for new content
export class ContentScriptHandler {

  constructor(tabsHandler) {
    tabsHandler.addObserver(this);
  }

  inject_links_catcher(frameHandler) {
    var tabId = frameHandler.tabHandler.id;

    async function inject() {
      var details = {
        file: '/resources/content-script-links-catcher.css',
        runAt: 'document_start'
      };
      await browser.tabs.insertCSS(tabId, details);

      details.file = '/dist/content-script-links-catcher.bundle.js';
      await browser.tabs.executeScript(tabId, details);
    }

    return frameHandler.setupScript('links-catcher', inject);
  }

  // Injects TiddlyWiki content script CSS and code.
  inject_tw(frameHandler) {
    var tabId = frameHandler.tabHandler.id;

    async function inject() {
      var details = {
        file: '/resources/content-script-tw.css',
        runAt: 'document_start'
      };
      await browser.tabs.insertCSS(tabId, details);

      details.file = '/dist/content-script-tw.bundle.js';
      await browser.tabs.executeScript(tabId, details);
    }

    return frameHandler.setupScript('tw', inject);
  }

  // Injects 'video' content script code.
  inject_video(frameHandler) {
    var tabId = frameHandler.tabHandler.id;
    var frameId = frameHandler.id;

    async function inject() {
      // Notes:
      // We only target http/file frames, and only need to inject in frames that
      // are not 'about:blank'.
      var details = {
        frameId: frameId,
        file: '/dist/content-script-video.bundle.js',
        runAt: 'document_start'
      };
      await browser.tabs.executeScript(tabId, details);
    }

    return frameHandler.setupScript('video', inject);
  }

  async handleFrame(frameHandler) {
    var tabHandler = frameHandler.tabHandler;
    // We can check which content script(s) to inject now.
    // When dealing with a pdf file, Firefox has its own PDF.js handling and
    // we cannot execute script in the (special and privileged) frame.
    // See: https://bugzilla.mozilla.org/show_bug.cgi?id=1454760
    // Example: https://developer.mozilla.org/en-US/docs/Web/HTML/Element/object
    // Assume urls ending with '.pdf' are PDF displayed in frames, and exclude
    // them.
    if (frameHandler.url.match(/\.pdf$/i)) {
      if (settings.debug.misc) console.log('Not handling tab=<%s> frame=<%s> url=<%s>: appears to be a PDF', tabHandler.id, frameHandler.id, frameHandler.url);
      return;
    }

    // Note: the tab handler will prevent injection in tabs/frames that cannot
    // be used (mozilla addons pages, etc.).

    if (settings.catchLinks && (frameHandler.id === 0)) {
      this.inject_links_catcher(frameHandler);
    }

    if (frameHandler.id === 0) {
      // Inject TiddlyWiki content script where applicable.
      // We only handle (and expect) main frame for this.
      if (tabHandler.url.match(/^file:.*html?$/i)) {
        this.inject_tw(frameHandler);
      }
    }

    if (settings.interceptVideo && tabHandler.url.startsWith('http')) {
      this.inject_video(frameHandler);
    }
  }

  // Tab/frame observer

  frameAdded(details) {
    this.handleFrame(details.frameHandler);
  }

  frameReset(details) {
    var frameHandler = details.frameHandler;
    // We want the DOM content to be loaded.
    // If frameHandler is not (yet) known, we expect a 'frameAdded' to be
    // triggered soon.
    if (!details.domLoaded || !frameHandler) return;
    this.handleFrame(frameHandler);
  }

}
