'use strict';

import { constants } from '../common/constants.js';
import * as util from '../common/util.js';
import * as http from '../common/http.js';
import { WebSocketClient } from '../common/websocket.js';
import { settings } from '../common/settings.js';


// Known page extensions.
const pageContentExtensions = new Set(['htm', 'html', 'php', 'asp', 'aspx', 'asx', 'jsp', 'jspx', 'do', 'py', 'cgi']);

// Determine whether the URL *may* point to a page content (as opposed to a
// content we may download).
// Caller is expected to have excluded what is considered as explicit downloads:
// attachment or content with filename.
// Returns the reason it may be a page content (for debugging), or falsy value.
function maybePageContent(url) {
  // We want to know whether the URL *may* just point to a page content (and not
  // a real content we would download). This includes standard pages with static
  // or generated content: those are not to download, at best if the content is
  // dynamic (e.g. javascript/php/...) it may trigger another request that would
  // be a real content to download.
  // We first get the leaf path name.
  let pathname = util.getFilename(url);
  // If it's empty (that is the URL ends with a slash '/'), we assume the URL is
  // *not* for a content to download; most likely it's the 'index' page of the
  // site or one of its paths.
  if (!pathname) return 'empty leaf path';
  // Otherwise we get the 'extension' (considering path as a filename).
  let split = pathname.split(/\./);
  let extension = (split.length > 1) ? split.pop().toLowerCase() : '';
  // We assume we got the name of a page to display, and not the name of a file
  // to download, it either:
  //  - there is no extension
  //  - the extension length is too big to be considered a real extension: there
  //    there are many valid 4-letters extensions (webm/webp etc.), almost none
  //    with 5-letters, so set the limit accordingly
  if (!extension) return 'path has no file extension';
  if (extension.length > 5) return 'path does not appear to be a file with extension';
  // Finally, take into account known static/dynamic page extensions.
  if (pageContentExtensions.has(extension)) return 'path matches known page extensions';
}

class DlMngrClient {

  setup(webext, nativeApp) {
    this.webext = webext;
    this.nativeApp = nativeApp;
  }

  async download(details, params) {
    let self = this;

    params = params || {};
    if (params.notify && settings.notifyDownload) {
      util.browserNotification({
        'type': 'basic',
        'title': 'Download',
        'message': `${details.file}\n${details.url}`
      }, settings.notifyTtl);
    }

    util.cleanupFields(details);
    util.cleanupFields(params);

    // Set 'kind' field, in case we pass this message to the native app.
    details.kind = constants.KIND_DOWNLOAD;
    // Fill requested fields.
    if (params.addCookie && !details.cookie) {
      try {
        details.cookie = await http.getCookie(details.url);
      } catch (error) {
        console.log(`Could not add cookie for url=<${details.url}>:`, error);
      }
    }
    if (params.addUserAgent && !details.userAgent) {
      details.userAgent = navigator.userAgent;
    }
    if (params.addComment && !details.comment) {
      let comment = [];
      if (details.file) comment.push(`Download filename: ${details.file}`);
      if (params.mimeFilename) comment.push(`MIME filename: ${params.mimeFilename}`);
      comment.push(`URL filename: ${util.getFilename(details.url)}`);
      if (params.tabTitle) comment.push(`Page title: ${params.tabTitle}`);
      if (params.tabUrl && (params.tabUrl != details.url)) comment.push(`Page URL: ${params.tabUrl}`);
      if (params.linkText && (params.linkText != details.url)) comment.push(`Link text: ${params.linkText}`);
      if (params.extraComments) {
        if (Array.isArray(params.extraComments)) comment = comment.concat(params.extraComments);
        else comment.push(params.extraComments);
      }
      details.comment = comment.join('\n');
    }

    // Cleanup again.
    util.cleanupFields(details);

    function handleError(r) {
      if (r.error) {
        let url = details.url;
        let filename = details.file;
        self.webext.notify({
          title: 'Failed to download',
          level: 'error',
          message: `${util.getFilename(url, filename)}\n${url}`,
          error: r.error
        });
      }
      return r;
    }

    async function postNative() {
      let r;
      try {
        r = await self.nativeApp.postRequest(details);
        // Remember WebSocket port for next request.
        if (r.wsPort) self.wsPort = r.wsPort;
      } catch (error) {
        // Wrap error to handle it properly (as an error coming from the remote
        // applicaton).
        r = {error};
      }
      return handleError(r);
    }

    // Post native request if we don't know the WebSocket port yet.
    if (!self.wsPort) return await postNative();

    // Otherwise try WebSocket, and fallback to native request upon issue.
    let wsClient = new WebSocketClient(`ws://127.0.0.1:${self.wsPort}/`);
    try {
      await wsClient.connect();
      let r = await wsClient.postRequest(details);
      // If WebSocket returns non-0 code, log it. It is useless to fallback to
      // the native application, since the same should happen (except we don't
      // wait for its return code). Better return a proper error.
      if (r.code) {
        // Note: error will be notified and logged.
        r.error = r.output || 'WebSocket returned non-0 response code';
      }
      return handleError(r);
    } catch (error) {
      // Note: this is not an error message returned through WebSocket, but
      // a pure WebSocket error.
      // This may happen if the remote application is not running anymore.
      console.log('WebSocket request=<%o> failed=<%o>: fallback to native app', details, error);
      return await postNative();
    } finally {
      // Disconnect WebSocket once done.
      wsClient.disconnect();
    }
  }

}

// Background script will set it up.
export let dlMngr = new DlMngrClient();

export class RequestsHandler extends http.RequestsHandler {

  // When requested, monitors requests and downloads to intercept.
  //
  // There is no need to schedule janitoring. If we trigger it for each new
  // request/download, this should be enough.
  // We monitor requests and downloads. When applicable, we intercept them.
  // We remember unintercepted requests to let download proceed without
  // intercepting it.
  //
  // Assuming we have an unintercepted request, there are two main situations:
  //
  // Request does not trigger a 'download'
  // -------------------------------------
  // (A) There only are two possibilities. Either
  //  - request completes
  // or
  //  - request fails
  //
  // Request triggers a 'download'
  // -----------------------------
  // There are multiple cases. (B) Usually
  //  1. 'download' is created
  // then, either
  //  2. request completes
  // or
  //  2. request fails
  // (C) If the user does not validate the download, there is no step 1. And if
  // it is done before the request completes, then it is automatically failed.
  // (D) If user takes too much time to validate the download, step 1. and 2.
  // are reversed, and yet the created download is not in the 'complete' state.
  //
  // Since we are not notified if user does not validate a download, there is no
  // solution to properly handle all those cases.
  // Whatever the solution, it should try to prevent intercepting a 'download'
  // if we decided not to intercept the request that triggered it.
  //
  // At first glance, we could remove from 'unintercepted' when either:
  //  - 'download' is created
  //  - request completes/fails and we did not expect it triggered a 'download'
  // This would cover (A), (B) and (D). Only (C) would not be covered.
  // But it means we would need to determine (taking into account many factors)
  // when a request is expected to trigger a 'download', and remember it.
  //
  // Taking into account the fact we do not intercept 'too small' downloads,
  // another solution is to:
  //  - unconditionally remove from 'unintercepted' in all cases
  //  - remember a bit longer unintercepted requests that are completed before
  //    being removed
  // (A) and (C) are properly handled
  // (B) and (D) would be properly handled if we assume that
  //  - we don't expect the user to download the same resource twice in a row
  //  - it would be even less problematic since such downloads are expected to
  //    complete in a short time (due to the interception minimum size)

  constructor(webext) {
    super({
      RequestDetails,
      linkRedirections: false
    });
    let self = this;
    self.webext = webext;
    self.unintercepted = {};
    self.requestsCompleted = {};
    // Listen changes in interception settings to apply them.
    [settings.inner.interceptRequests, settings.inner.interceptDownloads].forEach(setting => {
      setting.addListener((setting, oldValue, newValue) => {
        self.setupInterception();
      });
    });
    self.setupInterception();
  }

  setupInterception() {
    // Check whether we now need to intercept anything
    this.interceptRequests = settings.interceptRequests;
    this.interceptDownloads = settings.interceptDownloads;

    // If not done, setup our (bound to us) callbacks (used as listeners).
    // Note: we need those callbacks to remain the same so that we can remove
    // any listener that was previously added.
    if (!this.listeners) {
      this.listeners = {};
      ['onRequest', 'onResponse', 'onRequestCompleted', 'onRequestError', 'onDownload'].forEach(key => {
        this.listeners[key] = this[key].bind(this);
      });
    }

    // Determine whether we were listening.
    // Note: alternatively we could get 'this.interceptRequests' etc before
    // changing the value, but here we emphasize the use of our listeners.
    let interceptingRequests = browser.webRequest.onSendHeaders.hasListener(this.listeners.onRequest);
    let interceptingDownloads = browser.downloads.onCreated.hasListener(this.listeners.onDownload);
    // Add/remove listeners as requested.
    if (this.interceptRequests && !interceptingRequests) {
      if (settings.debug.downloads) console.log('Installing downloads webRequest interception');
      // Note: we only need to intercept frames requests (no need for media
      // or websocket for example).
      let webRequestFilter = { urls: ['<all_urls>'], types: ['main_frame', 'sub_frame'] };
      browser.webRequest.onSendHeaders.addListener(
        this.listeners.onRequest,
        webRequestFilter,
        ['requestHeaders']
      );
      // Note: 'blocking' is used so that we can cancel the request if
      // applicable.
      browser.webRequest.onHeadersReceived.addListener(
        this.listeners.onResponse,
        webRequestFilter,
        ['responseHeaders', 'blocking']
      );
      browser.webRequest.onCompleted.addListener(
        this.listeners.onRequestCompleted,
        webRequestFilter
      );
      browser.webRequest.onErrorOccurred.addListener(
        this.listeners.onRequestError,
        webRequestFilter
      );
    } else if (!this.interceptRequests && interceptingRequests) {
      if (settings.debug.downloads) console.log('Uninstalling downloads webRequest interception');
      browser.webRequest.onSendHeaders.removeListener(this.listeners.onRequest);
      browser.webRequest.onHeadersReceived.removeListener(this.listeners.onResponse);
      browser.webRequest.onCompleted.removeListener(this.listeners.onRequestCompleted);
      browser.webRequest.onErrorOccurred.removeListener(this.listeners.onRequestError);
    }
    // Cleanup resources when applicable.
    if (!this.interceptRequests) {
      this.clear();
      this.unintercepted = {};
      this.requestsCompleted = {};
    }

    if (this.interceptDownloads && !interceptingDownloads) {
      if (settings.debug.downloads) console.log('Installing downloads interception');
      browser.downloads.onCreated.addListener(this.listeners.onDownload);
    } else if (!this.interceptDownloads && interceptingDownloads) {
      if (settings.debug.downloads) console.log('Uninstalling downloads interception');
      browser.downloads.onCreated.removeListener(this.listeners.onDownload);
    }
    if (!this.interceptDownloads) {
      this.unintercepted = {};
    }
  }

  ignoreNext(ttl) {
    let self = this;
    // Cancel if requested.
    if (!ttl) {
      self.cancelIgnoreNext();
      return;
    }
    // Nothing to do if we already are ignoring.
    if (self.ignoringNext) return;
    console.log(`Ignoring next interception with ttl=<${ttl}>`);
    let ttlStep = 1000;
    // Start TTL ('+ ttlStep' to reuse the function to decrement the TTL).
    self.ignoringNext = {
      ttl: ttl + ttlStep
    };
    function decrement() {
      // Stop if we are not ignoring anymore.
      if (!self.ignoringNext) return;
      // Decrement and cancel if TTL is reached.
      self.ignoringNext.ttl -= ttlStep;
      if (self.ignoringNext.ttl <= 0) {
        self.cancelIgnoreNext();
        return;
      }
      // Otherwise update displayed TTL and loop.
      self.webext.sendMessage({
        target: constants.TARGET_BROWSER_ACTION,
        kind: constants.KIND_DL_IGNORE_NEXT,
        ttl: self.ignoringNext.ttl
      });
      self.ignoringNext.timeout = setTimeout(decrement, ttlStep);
    }
    // Prime the pump.
    decrement();
  }

  cancelIgnoreNext() {
    // Nothing to do it we are not ignoring.
    if (!this.ignoringNext) return;
    if (this.ignoringNext.timeout) clearTimeout(this.ignoringNext.timeout);
    this.webext.sendMessage({
      target: constants.TARGET_BROWSER_ACTION,
      kind: constants.KIND_DL_IGNORE_NEXT,
      ttl: 0
    });
    delete(this.ignoringNext);
  }

  checkIgnoreNext() {
    if (!this.ignoringNext) return false;
    this.cancelIgnoreNext();
    return true;
  }

  addRequestDetails(base, requestDetails) {
    if (!requestDetails) return;
    let key = requestDetails.url;
    let entries = base[key] || [];
    entries.push(requestDetails);
    base[key] = entries;
  }

  removeRequestDetails(base, key) {
    let entries = base[key];
    if (!entries) return;
    let removed = entries.shift();
    if (!entries.length) delete(base[key]);
    else base[key] = entries;
    return removed;
  }

  addUnintercepted(requestDetails) {
    // Nothing to remember if we are not intercepting downloads
    if (!this.interceptDownloads) return;
    this.addRequestDetails(this.unintercepted, requestDetails);
  }

  removeUnintercepted(key) {
    return this.removeRequestDetails(this.unintercepted, key);
  }

  cleanupUnintercepted() {
    for (let [key, unintercepted] of Object.entries(this.unintercepted)) {
      while (unintercepted.length && (util.getTimestamp() - unintercepted[0].timeStamp > constants.REQUESTS_TTL)) {
        console.warn('Dropping incomplete unintercepted download %o: TTL reached', unintercepted[0]);
        this.removeUnintercepted(key);
        // Note: we share the array with removeUnintercepted.
      }
    }
  }

  addCompletedRequest(requestDetails) {
    // Nothing to remember if we are not intercepting requests
    if (!this.interceptRequests) return;
    this.addRequestDetails(this.requestsCompleted, requestDetails);
  }

  removeCompletedRequest(key) {
    return this.removeRequestDetails(this.requestsCompleted, key);
  }

  cleanupCompletedRequests() {
    for (let [key, completed] of Object.entries(this.requestsCompleted)) {
      while (completed.length && (util.getTimestamp() - completed[0].timeStamp > constants.REQUESTS_TTL)) {
        if (settings.debug.downloads) console.log('Dropping completed request %o: TTL reached', completed[0]);
        this.removeCompletedRequest(key);
        // Note: we share the array with removeCompletedRequest.
      }
    }
  }

  onRequest(request) {
    if (!http.canDownload(request.url)) return;
    this.addRequest(request);
  }

  onRequestError(request) {
    if (!http.canDownload(request.url)) return;
    // Forget the request.
    // Notes:
    // We end up here if the request could not be completed, e.g. (with corresponding Firefox 'error'):
    //  - the target does not exist ('NS_ERROR_NET_ON_CONNECTING_TO')
    //  - the request was intercepted (and thus aborted) ('NS_ERROR_ABORT')
    //  - the request triggered a download which is aborted before creation ('NS_BINDING_ABORTED')
    //  - the request triggered a download which is paused/cancelled before completion ('NS_BINDING_ABORTED')
    // Only the first kind really matters for us since in other cases the
    // corresponding 'requests'/'unintercepted' entry was already removed.
    this.remove(request.requestId);
    this.removeUnintercepted(request.url);
    // Note: per definition the request was not completed, thus at best it was
    // in 'unintercepted' but cannot possibly be in 'requestsCompleted'.
  }

  onRequestCompleted(request) {
    if (!http.canDownload(request.url)) return;
    // Forget the unintercepted request, and move it to completed requests when
    // applicable.
    // We end up here when the request ended without error.
    // In case a download was triggered, it can even happen before the download
    // is created (depends how long the user takes to validate the download),
    // which is why we want to remember it a bit longer in completed requests.
    this.addCompletedRequest(this.removeUnintercepted(request.url));
  }

  onResponse(response) {
    let requestDetails = this.addResponse(response);
    // Delegate decision to dedicated class.
    return requestDetails.manage(this);
  }

  async manageRequest(requestDetails, intercept, reason) {
    let self = this;
    if (intercept && self.checkIgnoreNext()) {
      intercept = false;
      reason = `ignoring (initial interception reason: ${reason})`;
    }
    if (!intercept) {
      if (settings.debug.downloads) console.log(`Not intercepting request %o: ${reason}`, requestDetails);
      if (requestDetails.remember) self.addUnintercepted(requestDetails);
      return {};
    }
    delete(requestDetails.remember);
    console.info(`Intercepting request %o: ${reason}`, requestDetails);

    let url = requestDetails.url;
    if (settings.notifyDownload) {
      util.browserNotification({
        'type': 'basic',
        'title': 'Download (request)',
        'message': `${util.getFilename(url, requestDetails.filename)}\n${url}`
      }, settings.notifyTtl);
    }

    let tabTitle;
    try {
      let tab = await browser.tabs.get(requestDetails.sent.tabId);
      tabTitle = tab.title;
    } catch (error) {
    }
    let r = await dlMngr.download({
      url,
      referrer: http.findHeaderValue(requestDetails.sent.requestHeaders, 'Referer'),
      cookie: http.findHeaderValue(requestDetails.sent.requestHeaders, 'Cookie'),
      userAgent: http.findHeaderValue(requestDetails.sent.requestHeaders, 'User-Agent'),
      file: requestDetails.filename,
      size: requestDetails.contentLength
    }, {
      addComment: true,
      mimeFilename: requestDetails.filename,
      tabTitle
    });
    // Cancel the request if we successfully managed to trigger the download.
    return {cancel: !r.error};
  }

  onDownload(download) {
    let self = this;
    if (!http.canDownload(download.url)) return self.manageDownload(download, false, 'URL not handled');
    if (self.removeUnintercepted(download.url)) return self.manageDownload(download, false, 'Matching unintercepted request');
    if (self.removeCompletedRequest(download.url)) return self.manageDownload(download, false, 'Matching completed request');
    self.janitoring();

    // Note: the received download object is in its initial state. e.g. it has
    // no bytesReceived/totalBytes even though data reception started in the
    // background before the user is asked to validate the download.
    // However if we do search for this download, we will get its current state
    // from which we can more easily decide what to do.
    browser.downloads.search({id: download.id}).catch(error => {
      console.warn('Failed to find download %o: %o', download, error);
      // Catch any error to return the initial state.
      return [download];
    }).then(r => {
      let d = r.find(d => d.id == download.id);
      if (d) download = d;

      // Don't process completed downloads.
      // Note: does not appear to ever happen even if download has really been
      // completed at the time it was validated by the user.
      if (download.state === 'complete') return self.manageDownload(download, false, 'Download completed');

      // Don't process failed downloads.
      if (download.error) return self.manageDownload(download, false, 'Download failed');

      // Do not intercept if corresponding request would not have been.

      // Don't intercept 'too small' download
      let totalBytes = Number.isInteger(download.totalBytes) ? download.totalBytes : -1;
      let bytesReceived = ((totalBytes > 0) && Number.isInteger(download.bytesReceived)) ? download.bytesReceived : 0;
      let remaining = totalBytes - bytesReceived;
      if ((remaining >= 0) && (remaining < settings.interceptSize)) return self.manageDownload(download, false, `Remaining length=<${remaining}> below limit`);

      // Don't intercept text or images if size is unknown.
      let contentType = new http.ContentType(download.mime);
      contentType.guess(download.filename, false);
      if (remaining < 0) {
        if (contentType.maybeText()) return self.manageDownload(download, false, 'Text with unknown size');
        if (contentType.isImage()) return self.manageDownload(download, false, 'Image with unknown size');
      }

      // For text or images, if the URL is actually displayed (i.e. is the URL
      // of a tab), don't intercept the download and assume that the browser
      // already has the file we wish to save.
      let displayed;
      if (contentType.isText() || contentType.isImage()) {
        displayed = browser.tabs.query({url: download.url}).then(tabs => {
          // Note: we could also check whether the tab status is 'complete'.
          // But we assume that it is either the case, or that since the content
          // is being downloaded/displayed, we don't want to intercept. The user
          // can still close the tab and instead 'Download' the original target
          // link to trigger interception intead of opening the file in a tab.
          return !!tabs.length;
        }).catch(error => {
          console.warn('Cannot determine whether download %o is displayed: %o', download, error);
          return false;
        });
      } else {
        displayed = Promise.resolve(false);
      }
      displayed.then(displayed => {
        // Don't intercept if content is displayed in browser (assuming it was
        // thus already downloaded by the browser).
        if (displayed) return self.manageDownload(download, false, 'Download already displayed in browser');

        // Intercept.
        self.manageDownload(download, true);
      })
    });
  }

  async manageDownload(download, intercept, reason) {
    let self = this;
    if (intercept && self.checkIgnoreNext()) {
      intercept = false;
      reason = `ignoring (initial interception reason: ${reason})`;
    }
    if (!intercept) {
      if (settings.debug.downloads) console.log(`Not intercepting download %o: ${reason}`, download);
      return;
    }
    console.info('Intercepting download', download);

    // First cancel this download.
    // We better wait for this to be done before handing over the download to
    // the external application: then we are sure the browser has no more cnx
    // for this URL (and the target file has been deleted by browser).
    try {
      await browser.downloads.cancel(download.id);
    } catch (error) {
      console.error('Failed to cancel download %o: %o', download, error);
    }

    async function cleanup() {
      // Then remove it from the list.
      // Notes:
      // Usually we would remove the created file from disk through 'removeFile'
      // before handing over the download and before erasing it from list, but
      // it is done automatically when cancelling an incomplete download (which
      // is our case since we don't intercept completed downloads).
      // We don't need to wait for erasing to be done before handing over the
      // download. However some extensions appear to rely on the 'downloads'
      // entry to still exist in order to properly handle events such as
      // cancellation. Thus if we erase it too fast, those extensions will fail
      // to detect the download has been cancelled. As a workaround, wait a bit
      // before doing so: 2s appears to be enough (1s works in most cases).
      await util.delayPromise(2000);
      try {
        await browser.downloads.erase({id: download.id});
      } catch (error) {
        console.error('Failed to erase download %o: %o', download, error);
      }

      // If requested, remove download from history.
      // Notes:
      // 'browser.downloads.erase' removes the entry from downloads, but an
      // entry remains in the history.
      // 'browser.browsingData.removeDownloads' may be able to cleanup that
      // entry, but in Firefox v66 it does not help, maybe because erasing
      // ('originTypes') 'extension' data is not supported.
      // Fortunately, 'browser.history.deleteUrl' does the trick.
      if (settings.clearDownloads) {
        try {
          await browser.history.deleteUrl({url: download.url});
        } catch (error) {
          console.error('Failed to delete url for download %o: %o', error);
        }
      }
    }
    // Do some cleanup in the background.
    cleanup();

    // While entry is being erased from list and history, we can hand over the
    // download.
    if (settings.notifyDownload) {
      util.browserNotification({
        'type': 'basic',
        'title': 'Download (intercepted)',
        'message': `${download.filename}\n${download.url}`
      }, settings.notifyTtl);
    }

    return await dlMngr.download({
      url: download.url,
      referrer: download.referrer,
      file: download.filename,
      size: download.totalBytes,
      auto: true
    }, {
      addCookie: true,
      addUserAgent: true,
      addComment: true
    });
  }

  async manageClick(info, tab) {
    let self = this;
    // If mediaType is defined (e.g. 'video', 'audio' or 'image'), user clicked
    // on this kind of HTML element, instead of a plain link. In this case
    // srcUrl is the 'src' value of the element (while linkUrl is the URL target
    // link otherwise).
    let url = info.mediaType ? info.srcUrl : info.linkUrl;

    if (!http.canDownload(url)) {
      if (settings.notifyDownload) {
        util.browserNotification({
          'type': 'basic',
          'title': 'Cannot download link',
          'message': url
        }, settings.notifyTtl);
      }
      return;
    }

    if (settings.notifyDownload) {
      util.browserNotification({
        'type': 'basic',
        'title': 'Download (link)',
        'message': url
      }, settings.notifyTtl);
    }

    // Determine the referrer: either the frame or the page.
    return await dlMngr.download({
      url,
      referrer: info.frameUrl || info.pageUrl
    }, {
      addCookie: true,
      addUserAgent: true,
      addComment: true,
      tabTitle: tab.title,
      linkText: info.linkText
    });
  }

  janitoring() {
    if (!super.janitoring()) return false;
    this.cleanupUnintercepted();
    this.cleanupCompletedRequests();
    return true;
  }

}


class RequestDetails extends http.RequestDetails {

  constructor(params) {
    super(params);
    // Whether to remember the request if unintercepted.
    this.remember = false;
  }

  manage(handler) {
    const response = this.received;
    if (!http.canDownload(response.url)) return handler.manageRequest(this, false, 'URL not handled');

    // Special case: upon redirections (status code 3xx), we receive a first
    // response but the browser keeps on using the same 'request' to access
    // the actual target URL (the 'request' is not 'completed' yet, actually a
    // new HTTP request is done, re-using the same requestId).
    // e.g. (in the same 'request'): a 'request' is triggered to perform a 'GET'
    // which receives a 302 that triggers another 'GET' on the new URL, which
    // ends with a 200, and *then* the 'request' is completed.
    // So ignore response for such codes (and wait for the real response), and
    // *do not* remember as 'unintercepted'.
    // Note: the requestId being re-used, the new HTTP request will replace the
    // original one in our 'requests'.
    let statusCode = this.statusCode;
    if (this.isRedirection()) return handler.manageRequest(this, false, `Skip intermediate response code=<${statusCode}>`);

    // This request shall be remembered if not intercepted.
    this.remember = true;

    // Note: caller already did set associated request if any.
    if (!this.sent) return handler.manageRequest(this, false, 'No matching request');
    handler.removeRequestDetails(this);

    // Special case (Firefox):
    // Response comes from cache if either:
    //  - fromCache is true (Firefox 62, does not exist in Firefox 56)
    //  - ip is not present (Firefox 56) or null (Firefox 62)
    // We don't want/need to intercept download if data has already been fetched
    // by the browser.
    let fromCache = response.fromCache || !('ip' in response) || !response.ip;
    if (fromCache) return handler.manageRequest(this, false, 'Response cached');

    // Only process standard success code. This filters out errors, redirects,
    // and non-standard successes (like range requests).
    if ((statusCode != 200) && (statusCode != 206)) return handler.manageRequest(this, false, `Response code=<${statusCode}> not managed`);
    // Special case (Firefox):
    // If content has been partially downloaded (cache) and the server supports
    // ranges, the request we saw is somehow fake (does not contain the 'Range'
    // header) and we will see two responses:
    //  - first one '206' - Partial content - with 'Content-Range' corresponding
    //    to the actual sent request 'Range', and 'fromCache=false'
    //  - second one '200' (faked) with full content, and 'fromCache=true'
    // In this case, still check if we would intercept from the first response
    // (indicates remaining size). As a side effect the second response will not
    // be intercepted due to missing matching request (we consume it here).
    if ((statusCode == 206) && http.findHeaderValue(this.sent.requestHeaders, 'Range')) return handler.manageRequest(this, false, 'Skip partial content request');

    // Parse response to get content length, type, disposition.
    this.parseResponse(settings.interceptSize);

    // Don't intercept 'too small' content.
    // Note: comparing undefined to integer returns false.
    if (this.contentLength < settings.interceptSize) return handler.manageRequest(this, false, 'Content length below limit');
    // From this point onward, content is either unknown or big enough.

    // Don't intercept 'inline' content (displayed inside the browser).
    if (this.contentDisposition.kind === 'inline') return handler.manageRequest(this, false, 'Inline content');

    // Intercept 'attachment' content (expected to trigger download anyway).
    if (this.contentDisposition.kind === 'attachment') return handler.manageRequest(this, true, 'Attachment content');

    // Intercept if content is big enough since it's not explicitly 'inline'.
    if (this.hasSize()) return handler.manageRequest(this, true, 'Content length beyond minimum size');
    // From this point onward, content length is unknown.

    // Don't intercept text or images if size is unknown.
    // Note: e.g. searching on google returns text/html without size.
    if (this.contentType.maybeText()) return handler.manageRequest(this, false, 'Text with unknown size');
    if (this.contentType.isImage()) return handler.manageRequest(this, false, 'Image with unknown size');

    // Don't intercept what we consider *maybe* page content (to display as
    // opposed to download). Since we really wish to download what we need,
    // and only exclude possible page content, we must match all conditions:
    //  - content is not an explicit attachment
    //  - size is unknown
    //  - content is not text nor image
    //  - content has no explicit filename (non-explicit attachment ?)
    //  - URL path is compatible with a page content (name/extension)
    if (!this.hasFilename()) {
      let reason = maybePageContent(this.url);
      if (reason) return handler.manageRequest(this, false, `Maybe page content; ${reason}`);
    }

    // Intercept everything else. Size is unknown, but it's not supposed to be
    // content to display: either it's not inlined, text, image nor page, or it
    // has an explicit filename (non-explicit attachment ?).
    return handler.manageRequest(this, true, 'Default interception');
  }

}
