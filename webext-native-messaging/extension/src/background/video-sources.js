'use strict';

import { constants } from '../common/constants.js';
import * as util from '../common/util.js';
import * as http from './http.js';
import { dlMngr } from './downloads.js';
import { settings } from '../common/settings.js';


function checkVideoContentType(contentType) {
  if (contentType.isImage()) return 'Image';
  if (contentType.isAudio()) return 'Audio';
}


const TITLE_SEPARATORS = [' - ', ' | '];
const TITLE_END_PART_REGEXPS = [
  / Online(?: Free)?$/i
];
const TITLE_REGEXPS = [
  /(?:Subbed)? Online Free$/i
];

class VideoSource {

  constructor(details) {
    this.url = details.url;
    this.frameUrl = details.frameUrl;
    this.tabUrl = details.tabUrl;
    this.tabTitle = details.tabTitle;
    // Even though for a single source we should only need to remember the
    // original url and any final redirection location, we manage merging
    // multiple sources when applicable.
    this.urls = new Set();
    this.addUrl(details.url);
  }

  matches(other) {
    if (other.hasUrl(this.getUrl())) return 'url';
    return ((this.etag !== undefined) && (this.etag === other.etag)) ? 'ETag' : undefined;
  }

  getUrl() {
    return (this.actualUrl !== undefined) ? this.actualUrl : this.url;
  }

  getUrls() {
    return this.urls;
  }

  addUrl(url) {
    this.urls.add(url);
  }

  addUrls(urls) {
    for (var url of urls) {
      this.addUrl(url);
    }
  }

  hasUrl(url) {
    return this.urls.has(url);
  }

  setRedirection(url) {
    // Ignore url if already used.
    if ((url == this.url) || (url == this.actualUrl)) return;
    this.actualUrl = url;
    this.addUrl(url);
  }

  // Indicates that the final url was reached.
  setCompleted() {
    this.completed = true;
  }

  mergeField(field, from) {
    if ((this[field] === undefined) && (from[field] !== undefined)) this[field] = from[field];
  }

  merge(from) {
    // Get our missing fields if any.
    for (var field of ['cookie', 'filename', 'size', 'etag']) {
      this.mergeField(field, from);
    }

    // Set final redirection if we are not complete.
    if (!this.completed && from.completed) {
      this.setRedirection(from.getUrl());
    }

    // Take into account all urls.
    this.addUrls(from.getUrls());
  }

  sanitizeTitle() {
    var title = this.tabTitle;

    function stripEnd(str) {
      TITLE_SEPARATORS.forEach(sep => {
        var idx = title.lastIndexOf(sep);
        if (idx < 0) return;
        if (title.slice(idx + sep.length).trim().localeCompare(str, undefined, {sensitivity: 'base'})) return;
        title = title.slice(0, idx);
      });
    }

    function stripEndPartRegexp(regexp) {
      TITLE_SEPARATORS.forEach(sep => {
        var idx = title.lastIndexOf(sep);
        if (idx < 0) return;
        if (!regexp.test(title.slice(idx + sep.length).trim())) return;
        title = title.slice(0, idx);
      });
    }

    function stripRegexp(regexp) {
      title = title.replace(regexp, '');
    }

    // Strip the site domain name at the end of the title.
    // Handle:
    //  - the last 3 levels (e.g.: www.sitename.tld)
    //  - the last 2 levels (e.g.: sitename.tld)
    //  - the main domain (e.g.: sitename)
    var host = (new URL(this.tabUrl).hostname).split('.').slice(-3);
    if (host.length > 2) {
      stripEnd(host.join('.'));
      host = host.slice(1);
    }
    if (host.length > 1) {
      stripEnd(host.join('.'));
      stripEnd(host.slice(0, 1).join('.'));
    }

    // Strip end of title matching regexps.
    TITLE_END_PART_REGEXPS.forEach(stripEndPartRegexp);

    // Strip title matching regexps.
    TITLE_REGEXPS.forEach(stripRegexp);

    return title;
  }

  getDownloadFile() {
    var filename = util.getFilename(this.getUrl(), this.filename);
    var { name, extension } = util.getFilenameExtension(filename);
    // Most sources don't have a filename, nor a proper name in the url.
    // So use the tab title as base to name the downloaded file.
    name = this.sanitizeTitle();
    return {
      name: name,
      extension: extension,
      filename: (extension !== undefined) ? `${name}.${extension}` : name
    };
  }

  getMenuEntryTitle() {
    var title = '';

    // We will prefix the download size and extension if possible.
    // The rest of the title will be the file name (without extension).

    // Format size if known.
    if (this.size !== undefined) title = util.getSizeText(this.size);

    var { name, extension, filename } = this.getDownloadFile();
    // Don't show filename extension in title prefix if too long.
    // Display the whole filename instead.
    if (extension && (extension.length > 4)) {
      extension = undefined;
      name = filename;
    }
    if (extension != undefined) title = title ? `${title} ${extension}` : extension;
    if (title) title = `[${title}] `;
    // Note: on FireFox (77) if the text width (in pixels) exceeds a given
    // size, the end is replaced by an ellipsis character.
    // There is thus no easy (or at all) way to determine how many characters
    // is the limit, as it depends on which characters are present.
    // A good average limit seems to be somewhere around 75 characters; 72 is
    // then a good value to avoid it in the majority of cases.
    title = `${title}${util.limitText(name, 72 - title.length)}`;
    return title;
  }

  // Creates manu entry.
  // Notes:
  // This will be called each time the owning tab is activated, which is not
  // a problem as there is nothing too intensive done.
  // 'onclick' being a function, it will access up-to-date fields when menu
  // entry is clicked. Only values like 'title' needs to be refreshed when
  // the source is updated.
  addMenuEntry(menuHandler) {
    var self = this;
    // Simply refresh if entry already exists.
    if (self.menuEntryId !== undefined) {
      self.refreshMenuEntry(menuHandler);
      return;
    }
    self.menuEntryId = menuHandler.addEntry({
      title: self.getMenuEntryTitle(),
      onclick: () => {
        // Add cookie and user agent unless we saw a request (in which we
        // extracted those).
        dlMngr.download({
          url: self.getUrl(),
          referrer: self.frameUrl,
          cookie: self.cookie,
          userAgent: self.userAgent,
          file: self.getDownloadFile().filename,
          size: self.size
        }, {
          addCookie: !self.seenRequest,
          addUserAgent: !self.seenRequest,
          addComment: true,
          mimeFilename: this.filename,
          tabTitle: self.tabTitle
        });
      }
    });
  }

  refreshMenuEntry(menuHandler) {
    if (this.menuEntryId === undefined) return;
    browser.contextMenus.update(this.menuEntryId, {
      title: this.getMenuEntryTitle()
    });
    browser.contextMenus.refresh();
  }

  removeMenuEntry(menuHandler) {
    if (this.menuEntryId === undefined) return;
    menuHandler.removeEntries(this.menuEntryId);
    delete(this.menuEntryId);
  }

}


// Handles video sources in a given tab.
// We do receive video source urls from injected content script, and requests
// (may contain additional information on sources) made by media elements.
// We may receive the latter before the former: buffer requests to replay them
// once source is added.
//
// Notes:
// Since we intercept 'media' requests, we may also receive audio streaming
// requests, which we need to exclude/ignore when possible.
//
// Everything is cleared when tab is removed, and we don't expect to have too
// much activity and buffered requests. Doing some passive janitoring when
// processing buffered entries should be enough.
//
// We handle merging sources when we detect they are actually the same.
// Some sites do generate pseudo-random urls, and often either:
//  - it redirects to a real url which does not change
//  - it has an ETag, which serves as unique id
// If a given Location or ETag matches another existing source, then the latter
// is merged in the former.
// Most cases are implicitely or explicitely merged:
//  - if original url is the same, a previous source is found and updated
//  - if Location points to a known source, they are merged
//  - if ETag is the same as another source, they are merged
// One of the most complicated situation also works fine:
//  - tab is reloaded: we keep previous sources; initially all but the main
//    frame handler are known
//  - we receive and buffer requests/responses for an unknown frame
//  - one response redirects to a Location known in a previous source
//  - the next requests/responses are associated to the previous source, which
//    is updated with the fresh information
//  - the frame become known, and content script is setup
//  - a source with a new url is added
//  - a response Location points to the previous source: they are merged
// We only remain with two separate entries if initial urls are different and
// we did not previously received redirections responses nor ETag.
//
// Merging mostly transfers the previous source information unless already
// known in the new source.
class VideoSourceTabHandler {

  constructor(tabHandler, menuHandler) {
    this.tabHandler = tabHandler;
    this.menuHandler = menuHandler;
    this.sources = [];
    this.ignoredUrls = new Set();
    // Buffered requests, per url.
    this.bufferedRequests = {};
  }

  tabReset(details) {
    // If we remain on the same url, we don't have to forget previous sources
    // or ignored urls.
    if (!details.sameUrl) {
      this.removeMenuEntries();
      this.sources = [];
      this.ignoredUrls.clear();
    }
    this.bufferedRequests = {};
  }

  janitorBuffered(url, buffered, remove) {
    if (util.getTimestamp() - buffered.timeStamp < constants.REQUESTS_TTL) return false;
    if (settings.debug.video) {
      for (var b of buffered.buffer) {
        console.log('Dropping buffered request=<%o> response=<%o>: TTL reached', b.request, b.response);
      }
    }
    if (remove) delete(this.bufferedRequests[url]);
    else buffered.clear();
    return true;
  }

  // Gets buffered requests if any.
  // Remove entry if requested.
  // Does passive janitoring on entries.
  getBufferedRequests(url, remove) {
    var buffered = this.bufferedRequests[url];
    if (buffered === undefined) {
      if (remove) return;
      // Search url in known buffers, as it may be a redirection.
      // Reminder: we can reuse 'buffered', but *NOT* 'url' when looping over
      // entries, as the passed 'url' is needed afterwards.
      for (var [key, buffered] of Object.entries(this.bufferedRequests)) {
        if (this.janitorBuffered(key, buffered, true)) continue;
        if (buffered.hasUrl(url)) return buffered;
      }
      buffered = this.bufferedRequests[url] = new RequestBuffer();
    } else {
      this.janitorBuffered(url, buffered, false);
    }
    if (remove) delete(this.bufferedRequests[url]);
    return buffered;
  }

  ignoreUrl(url) {
    this.ignoredUrls.add(url);
  }

  ignoreUrls(urls) {
    for (var url of urls) {
      this.ignoreUrl(url);
    }
  }

  addMenuEntries() {
    for (var source of this.sources) {
      source.addMenuEntry(this.menuHandler);
    }
  }

  removeMenuEntries() {
    for (var source of this.sources) {
      source.removeMenuEntry(this.menuHandler);
    }
  }

  findSource(url) {
    for (var source of this.sources) {
      if (source.hasUrl(url)) return source;
    }
  }

  // Merges sources based on ETag and urls.
  mergeSources(source) {
    this.sources = this.sources.filter(other => {
      if (other === source) return true;
      var matches = source.matches(other);
      if (matches !== undefined) {
        if (settings.debug.video) console.log('Merging old source=<%o> into=<%o>: Match on %s', other, source, matches);
        source.merge(other);
        other.removeMenuEntry(this.menuHandler);
        return false;
      }
      return true;
    });
  }

  addSource(details) {
    var tabId = details.tabId;
    var frameId = details.frameId;
    var url = details.url;

    // Silently drop previously ignored URLs.
    if (this.ignoredUrls.has(url)) return;

    // Ignore already known source.
    if (this.findSource(url) !== undefined) return;

    // Note: 'ignoreDownload' takes care of buffered requests if any.

    // Ignore urls that we can't download.
    if (!http.canDownload(url)) return this.ignoreDownload(details, 'URL not handled');
    // Ignore apparent content types that we don't want to download.
    var contentType = new http.ContentType();
    contentType.guess(util.getFilename(url));
    var reason = checkVideoContentType(contentType);
    if (reason !== undefined) return this.ignoreDownload(details, reason);

    if (settings.debug.video) console.log('Adding tab=<%s> frame=<%s> video url=<%s>', tabId, frameId, url);
    var tabHandler = this.tabHandler;
    details.tabUrl = tabHandler.url;
    details.tabTitle = tabHandler.title;
    var source = new VideoSource(details);
    this.sources.push(source);
    if (tabHandler.isActive()) source.addMenuEntry(this.menuHandler);

    // Process buffered requests.
    var buffered = this.getBufferedRequests(url, true);
    if (buffered !== undefined) buffered.replay(this);
  }

  onRequest(request) {
    var url = request.url;
    // Silently drop previously ignored URLs.
    if (this.ignoredUrls.has(url)) return;

    var source = this.findSource(url);
    if (source === undefined) {
      this.getBufferedRequests(url).addRequest(request);
      return;
    }
    // Remember that we saw a request for this source.
    source.seenRequest = true;

    // Extract useful request details.
    var cookie = http.findHeader(request.requestHeaders, 'Cookie');
    if (cookie !== undefined) source.cookie = cookie;
    var userAgent = http.findHeader(request.requestHeaders, 'User-Agent');
    if (userAgent !== undefined) source.userAgent = userAgent;
  }

  onResponse(response) {
    var url = response.url;
    var location;
    var statusCode = response.statusCode;

    // Extract redirected url when applicable.
    // Note: even though it should have no meaning/purpose in our case, url may
    // contain a fragment; so normalize it.
    if (Math.floor(statusCode / 100) == 3) location = util.normalizeUrl(http.findHeader(response.responseHeaders, 'Location'), settings.debug.video, 'Location');

    // Silently drop previously ignored URLs.
    if (this.ignoredUrls.has(url)) {
      // Also ignore actual url if any, so that we can silently ignore the next
      // request that should soon be triggered.
      if (location !== undefined) this.ignoreUrl(location);
      return;
    }

    var source = this.findSource(url);
    if (source === undefined) {
      this.getBufferedRequests(url).addResponse(response, location);
      return;
    }

    // Remember actual url.
    // Notes:
    // We don't expect redirection responses to contain useful Content-Type or
    // Content-Disposition information. Often when there is a Content-Type it
    // has nothing to do with the URL the response redirects to. So we are done
    // with this response by taking into account the new url.
    if (location !== undefined) {
      if (settings.debug.video) console.log('Tab=<%s> frame=<%s> video src=<%s> is redirected to=<%s>', response.tabId, response.frameId, source.url, location);
      source.setRedirection(location);
      return;
    }

    // Only process standard success code. This filters out errors and
    // non-standard successes.
    if ((statusCode != 200) && (statusCode != 206)) {
      if (settings.debug.video) console.log('Not handling tab=<%s> frame=<%s> video response=<%o>: Response code=<%s> not managed', response.tabId, response.frameId, response, statusCode);
      return;
    }
    source.setCompleted();

    var requestDetails = new http.RequestDetails(response);
    requestDetails.parseResponse();
    // Keep filename if given.
    if (requestDetails.hasFilename()) source.filename = requestDetails.filename;
    // Keep content length if known.
    if (requestDetails.hasSize()) source.size = requestDetails.contentLength;
    // Guess content type if needed, based on the given filename (or url).
    requestDetails.contentType.guess(util.getFilename(source.getUrl(), source.filename), true);
    // Retrieved/actual information may differ from original ones. Check again
    // and ignore content types we don't want to download.
    var reason = checkVideoContentType(requestDetails.contentType);
    if (reason !== undefined) return this.ignoreDownload(source, response, reason);

    // Keep ETag if any.
    source.etag = http.findHeader(response.responseHeaders, 'ETag');
    // Merge same sources.
    this.mergeSources(source);

    source.refreshMenuEntry(this.menuHandler);
  }

  // Takes into account given download information to ignore.
  // Note: we take advantage of the fact that both video source details and
  // http response contain the information we need, so that caller can pass
  // either one.
  ignoreDownload() {
    var args = [...arguments];
    if (args[0] instanceof VideoSource) var [source, details, reason] = args;
    else var [details, reason] = args;

    if (source !== undefined) this.ignoreUrls(source.getUrls());
    else {
      this.ignoreUrl(details.url);
      // Also drop buffered requests if any, and ignore associated urls: useful
      // when we already received redirection responses.
      var buffered = this.getBufferedRequests(details.url, true);
      if (buffered !== undefined) this.ignoreUrls(buffered.getUrls());
    }
    if (settings.debug.video) console.log('Not handling tab=<%s> frame=<%s> video url=<%s>: %s', details.tabId, details.frameId, details.url, reason);
  }

}

const TAB_EXTENSION_PROPERTY = 'videoSourceTabHandler';

// Handles video sources for all tabs.
// We do receive video source urls from managed frames, and requests made by
// media elements.
// Frame may not be known in handler yet when receiving requests: buffer
// requests to replay them once frame is known.
//
// We mostly check frame is known and delegates further handling to a more
// specific tab handler (gathers information per tab).
// For simplicity, we normalize urls in source/request/response.
export class VideoSourceHandler {

  constructor(tabsHandler, menuHandler) {
    var self = this;
    self.tabsHandler = tabsHandler;
    self.menuHandler = menuHandler;
    // Buffered requests, per tab frame.
    self.bufferedRequests = {};
    // Listen changes in interception settings to apply them.
    settings.inner.interceptVideo.addListener((setting, oldValue, newValue) => {
      self.setupInterception();
    });
    self.setupInterception();
  }

  getBufferedRequests(tabId, frameId, remove) {
    var buffered = this.bufferedRequests[tabId];
    if (buffered === undefined) {
      if (remove) return;
      buffered = this.bufferedRequests[tabId] = {};
    }
    buffered = buffered[frameId];
    if (buffered === undefined) {
      if (remove) return;
      buffered = this.bufferedRequests[tabId][frameId] = new RequestBuffer();
    }
    if (remove) delete(this.bufferedRequests[tabId][frameId]);
    return buffered;
  }

  getTabHandler(details, create) {
    var self = this;
    var frameHandler = self.tabsHandler.getFrame(details);
    if (frameHandler === undefined) return {};
    var handler = frameHandler.tabHandler.getExtensionProperty({
      key: TAB_EXTENSION_PROPERTY,
      create: create ? (tabHandler => new VideoSourceTabHandler(tabHandler, self.menuHandler)) : undefined,
      keepOnReset: true
    });
    return {
      handler: handler,
      frameUrl: frameHandler.url
    };
  }

  addSource(details) {
    // Normalize url.
    details.url = util.normalizeUrl(details.url, settings.debug.video, 'video source');
    // Ensure details match a known tab frame. If not, assume the frame was
    // changed (reset) since information was sent: ignore it.

    // Notes:
    // If we receive a source, it means the content script is running, and thus
    // this tab/frame *should* be known. If it isn't, we can only assume the
    // tab/frame did change after the information was sent.
    var { handler, frameUrl } = this.getTabHandler(details, true);
    if (handler === undefined) {
      // Note: this is the only time we log the csUuid.
      // If we found the frame, then the csUuid matches, and there is not more
      // need to log it.
      if (settings.debug.video) console.log('Not handling tab=<%s> frame=<%s> csUuid=<%s> video url=<%s>: Unknown tab frame', details.tabId, details.frameId, details.csUuid, details.url);
      return;
    }
    details.frameUrl = frameUrl;

    return handler.addSource(details);
  }

  setupInterception() {
    // Check whether we now need to intercept anything
    this.interceptVideo = settings.interceptVideo;

    // If not done, setup our (bound to us) callbacks (used as listeners).
    // Note: we need those callbacks to remain the same so that we can remove
    // any listener that was previously added.
    if (this.listeners === undefined) {
      this.listeners = {};
      ['onRequest', 'onResponse'].forEach(key => {
        this.listeners[key] = this[key].bind(this);
      });
    }

    // Determine whether we were listening.
    // Note: alternatively we could get 'this.interceptVideo' etc before
    // changing the value, but here we emphasize the use of our listeners.
    var interceptingVideo = browser.webRequest.onSendHeaders.hasListener(this.listeners.onRequest);
    // Add/remove listeners as requested.
    if (this.interceptVideo && !interceptingVideo) {
      if (settings.debug.video) console.log('Installing video webRequest interception');
      // Notes:
      // We need to intercept media ('video' and 'audio' elements) and object
      // ('object' and 'embed' elements) requests.
      // 'embed' elements can indeed include video, for which requests are
      // typed as 'object' instead fo 'media'.
      // Example: https://developer.mozilla.org/fr/docs/Web/HTML/Element/embed
      var webRequestFilter = { urls: ['<all_urls>'], types: ['media', 'object'] };
      browser.webRequest.onSendHeaders.addListener(
        this.listeners.onRequest,
        webRequestFilter,
        ['requestHeaders']
      );
      // Note: unlike 'downloads' interception, we don't need to block the
      // request; we just need to get request information.
      browser.webRequest.onHeadersReceived.addListener(
        this.listeners.onResponse,
        webRequestFilter,
        ['responseHeaders']
      );
    } else if (!this.interceptVideo && interceptingVideo) {
      if (settings.debug.video) console.log('Uninstalling video webRequest interception');
      browser.webRequest.onSendHeaders.removeListener(this.listeners.onRequest);
      browser.webRequest.onHeadersReceived.removeListener(this.listeners.onResponse);
    }
    // Cleanup resources when applicable.
    if (!this.interceptVideo) {
      this.bufferedRequests = {};
    }
  }

  onRequest(request) {
    // Normalize url.
    request.url = util.normalizeUrl(request.url, settings.debug.video, 'request');
    var tabId = request.tabId;
    var frameId = request.frameId;
    var { handler } = this.getTabHandler({
      tabId: tabId,
      frameId: frameId
    }, true);
    if (handler === undefined) {
      this.getBufferedRequests(tabId, frameId).addRequest(request);
      return;
    }

    handler.onRequest(request);
  }

  onResponse(response) {
    // Normalize url.
    response.url = util.normalizeUrl(response.url, settings.debug.video, 'response');
    var tabId = response.tabId;
    var frameId = response.frameId;
    var { handler } = this.getTabHandler({
      tabId: tabId,
      frameId: frameId
    }, true);
    if (handler === undefined) {
      this.getBufferedRequests(tabId, frameId).addResponse(response);
      return;
    }

    handler.onResponse(response);
  }

  // Tab/frame observer

  tabReset(details) {
    // We don't know whether we can receive requests before frame content is
    // loaded. As a precaution, only take into account reset when frame is
    // about to change.
    if (!details.beforeNavigate) return;
    var { handler } = this.getTabHandler(details, false);
    if (handler === undefined) return;
    handler.tabReset(details);
  }

  frameAdded(details) {
    var tabId = details.tabId;
    var frameId = details.frameId;
    var buffered = this.getBufferedRequests(tabId, frameId, true);
    if (buffered === undefined) return;
    // Process buffered requests.
    // Belt and suspenders: ensure we do know the frame now.
    var { handler } = this.getTabHandler({
      tabId: tabId,
      frameId: frameId
    }, true);
    if (handler === undefined) {
      // Should not happen.
      console.log('Tab=<%s> frame=<%s> is still unknown after being added: not replaying requests', tabId, frameId);
      return;
    }
    buffered.replay(this);
  }

  tabRemoved(details) {
    var self = this;

    // To ensure we do remove menu entries even when closing the active tab,
    // to it in both situations if possible (tab handler known).
    if (details.tabHandler !== undefined) {
      var handler = details.tabHandler.getExtensionProperty({key: TAB_EXTENSION_PROPERTY});
      if (handler !== undefined) handler.removeMenuEntries();
    }

    // As a precaution, wait a bit before clearing buffered requests, in case
    // we still receive some in parallel.
    setTimeout(() => {
      delete(self.bufferedRequests[details.tabId]);
    }, 1000);
  }

  frameRemoved(details) {
    var self = this;
    // As a precaution, wait a bit before clearing buffered requests, in case
    // we still receive some in parallel.
    setTimeout(() => {
      self.getBufferedRequests(details.tabId, details.frameId, true);
    }, 1000);
  }

  tabActivated(details) {
    // Remove entries from previous active tab, if there really was a change.
    if ((details.previousTabId !== details.tabId) && (details.previousTabHandler !== undefined)) {
      var handler = details.previousTabHandler.getExtensionProperty({key: TAB_EXTENSION_PROPERTY});
      if (handler !== undefined) handler.removeMenuEntries();
    }

    // Add entries of new active tab.
    if (details.tabHandler === undefined) return;
    var handler = details.tabHandler.getExtensionProperty({key: TAB_EXTENSION_PROPERTY});
    if (handler !== undefined) handler.addMenuEntries();
  }

}


// Buffers requests (and associated response) to be replayed.
class RequestBuffer {

  constructor() {
    this.buffer = [];
    this.urls = new Set();
    this.timeStamp = 0;
  }

  clear() {
    this.buffer = [];
    this.urls.clear();
    this.timeStamp = 0;
  }

  getUrls() {
    return this.urls;
  }

  hasUrl(url) {
    return this.urls.has(url);
  }

  addRequest(request) {
    if (this.timeStamp < request.timeStamp) this.timeStamp = request.timeStamp;
    this.urls.add(request.url);
    this.buffer.push({
      request: request
    });
  }

  addResponse(response, location) {
    if (this.timeStamp < response.timeStamp) this.timeStamp = response.timeStamp;
    this.urls.add(response.url);
    if (location !== undefined) this.urls.add(location);
    // Search for latest associated request.
    // Beware that upon redirection the requestId is re-used: only search for
    // request with missing response.
    // Search from end of array, as we expect request to be nearer from end
    // than beginning.
    var requestId = response.requestId;
    var idx = this.buffer.length - 1;
    while (idx > 0) {
      var buffered = this.buffer[idx];
      if ((buffered.request !== undefined) && (buffered.request.requestId == requestId)) {
        // We may receive responses without request when extension is starting.
        if (buffered.response !== undefined) break;
        buffered.response = response;
        return;
      }
      idx--;
    }

    // We don't have the request, simply remember the response.
    this.buffer.push({
      response: response
    });
  }

  replay(target) {
    // Caller is not expected to reuse us, but in case: clear us, so that adding
    // requests don't interfere with our replaying.
    var buffer = this.buffer;
    this.clear();
    for (var buffered of buffer) {
      var request = buffered.request;
      if (request !== undefined) {
        try {
          target.onRequest(request);
        } catch (error) {
          console.log('Failed to replay request=<%o>: %o', request, error);
        }
      }
      var response = buffered.response;
      if (response !== undefined) {
        try {
          target.onResponse(response);
        } catch (error) {
          console.log('Failed to replay response=<%o>: %o', response, error);
        }
      }
    }
  }

}
