'use strict';

import { constants } from '../common/constants.js';
import * as util from '../common/util.js';
import * as asynchronous from '../common/asynchronous.js';
import * as unsafe from '../common/unsafe.js';
import * as http from '../common/http.js';
import * as hls from '../common/stream-hls.js';
import { dlMngr } from './downloads.js';
import { settings } from '../common/settings.js';


function checkVideoContentType(contentType) {
  if (contentType.isText()) return 'Text';
  if (contentType.isSubtitle()) return 'Subtitle';
  if (contentType.isImage()) return 'Image';
  if (contentType.isAudio()) return 'Audio';
}


// When refining video source title, some methods can be used to strip title
// starting/ending part when matching a value or regular expression. To
// determine this part, the title is split based on known separators.
// Here we list nominal separators to consider, while caller is able to replace
// or complement this list in each call.
// See documentation or VideoSourceNamer below for more details.
const TITLE_SEPARATORS = ['-', '|'];

export class VideoSourceNamer {

  constructor(videoSource) {
    this.videoSource = videoSource;
    this.filenameFromUrl = videoSource.filenameFromUrl;
    this.title = videoSource.tabTitle;
    // Determine download filename.
    this.setFilename(util.getFilename(videoSource.getUrl(), videoSource.filename));
  }

  setFilename(filename) {
    this.filename = filename;
    this.refreshName();
  }

  setName(name) {
    this.name = name;
    this.refreshFilename();
  }

  setExtension(extension) {
    if (!extension) extension = 'mp4';
    this.extension = extension;
    this.refreshFilename();
  }

  refreshFilename() {
    this.filename = util.buildFilename(this.name, this.extension);
  }

  refreshName() {
    // Use 'mp4' as default extension if none could be determined.
    const { name, extension } = util.getFilenameExtension(this.filename, 'mp4');
    this.name = name;
    this.extension = extension;
    this.refreshFilename();
  }

  async refine() {
    const source = this.videoSource;
    const scriptParams = {
      params: {
        videoSource: source,
        namer: this
      }
    };
    await source.getFilenameRefining().execute(scriptParams);
    // If we don't rely on title, either because filename was set from URL or
    // a proper filename was already set on the video source, do nothing else:
    // caller will use the resulting name, extension and filename.
    // Otherwise, update filename from resulting (cleaned) title.
    if (!this.filenameFromUrl && !this.videoSource.filename) this.setName(this.title);
  }

  getTitleSeparators(params) {
    params = params || {};
    return params.separators || TITLE_SEPARATORS.concat(params.extraSeparators || []);
  }

  titleStripStartPart(str, params) {
    params = params || {};
    if (params.withoutSpaces) str = str.replaceAll(/\s+/g, '');
    this.getTitleSeparators(params).forEach(sep => {
      const idx = this.title.indexOf(sep);
      if (idx < 0) return;
      let start = this.title.slice(0, idx).trim();
      if (params.withoutSpaces) start = start.replaceAll(/\s+/g, '');
      if (start.localeCompare(str, undefined, {sensitivity: 'base'})) return;
      this.title = this.title.slice(idx + sep.length).trim();
    });
  }

  titleStripStartPartRegexp(regexp, params) {
    params = params || {};
    this.getTitleSeparators(params).forEach(sep => {
      const idx = this.title.indexOf(sep);
      if (idx < 0) return;
      if (!regexp.test(this.title.slice(0, idx).trim())) return;
      this.title = this.title.slice(idx + sep.length).trim();
    });
  }

  titleStripEndPart(str, params) {
    params = params || {};
    if (params.withoutSpaces) str = str.replaceAll(/\s+/g, '');
    this.getTitleSeparators(params).forEach(sep => {
      const idx = this.title.lastIndexOf(sep);
      if (idx < 0) return;
      let end = this.title.slice(idx + sep.length).trim();
      if (params.withoutSpaces) end = end.replaceAll(/\s+/g, '');
      if (end.localeCompare(str, undefined, {sensitivity: 'base'})) return;
      this.title = this.title.slice(0, idx).trim();
    });
  }

  titleStripEndPartRegexp(regexp, params) {
    params = params || {};
    this.getTitleSeparators(params).forEach(sep => {
      const idx = this.title.lastIndexOf(sep);
      if (idx < 0) return;
      if (!regexp.test(this.title.slice(idx + sep.length).trim())) return;
      this.title = this.title.slice(0, idx).trim();
    });
  }

  titleStripRegexp(regexp, params) {
    const matches = this.title.match(regexp);
    if (matches) {
      const idx = this.title.indexOf(matches[0]);
      let title = this.title.substring(0, idx).trim();
      for (const captured of matches.slice(1)) {
        title += ` ${captured.trim()}`;
      }
      title += ` ${this.title.substring(idx + matches[0].length).trim()}`;
      this.title = title.trim();
    }
  }

  titleStripDomain(params) {
    params = params || {};
    // By default, strip all spaces when comparing values.
    if (!('withoutSpaces' in params)) params.withoutSpaces = true;
    // Strip the site domain name at the end of the title.
    // Handle:
    //  - the last 3 levels (e.g.: www.sitename.tld)
    //  - the last 2 levels (e.g.: sitename.tld)
    //  - the main domain (e.g.: sitename)
    let host = this.videoSource.tabSite.nameParts.slice(-3);
    if (host.length > 2) {
      this.titleStripStartPart(host.join('.'), params);
      this.titleStripEndPart(host.join('.'), params);
      host = host.slice(1);
    }
    if (host.length > 1) {
      this.titleStripStartPart(host.join('.'), params);
      this.titleStripEndPart(host.join('.'), params);
      host = host.slice(0, 1);
      this.titleStripStartPart(host.join('.'), params);
      this.titleStripEndPart(host.join('.'), params);
    }
    for (const name of (params.names || [])) {
      this.titleStripStartPart(name, params);
      this.titleStripEndPart(name, params);
    }
  }

  titleAppend(str, sep) {
    if (sep === undefined) sep = ' ';
    if (this.title.length > 0) this.title += sep;
    this.title += str;
  }

}

class VideoSourceEntryHandler {

  constructor(videoSource) {
    this.videoSource = videoSource;
    this.menuGroup = videoSource.menuGroup;
    this.downloadId = util.uuidv4();
  }

  async addMenuEntry(details) {
    // Note: conditionnally 'await', so that we execute as most code as we can
    // before other concurrent code is executed.
    if (this.menuEntry) await this.removeMenuEntry();
    if (this.videoSource.removed) {
      if (settings.video.debug) console.warn(`Ignoring menu actions for removed tab=<${this.videoSource.tabId}> frame=<${this.videoSource.frameId}> video source id=<${this.videoSource.id}> url=<${this.videoSource.url}>`);
      return;
    }
    this.menuEntry = await this.menuGroup.addEntry(details);
  }

  async updateMenuEntry(details) {
    if (!this.menuEntry) return;
    if (this.videoSource.removed) {
      if (settings.video.debug) console.warn(`Ignoring menu actions for removed tab=<${this.videoSource.tabId}> frame=<${this.videoSource.frameId}> video source id=<${this.videoSource.id}> url=<${this.videoSource.url}>`);
      return;
    }
    await this.menuEntry.update(details);
  }

  async removeMenuEntry() {
    if (!this.menuEntry) return false;
    await this.menuEntry.remove();
    delete(this.menuEntry);
    return true;
  }

}

export class VideoSource {

  constructor(parent, details) {
    // Notes:
    //  - we assign an id mainly for debugging purposes
    //  - since we handle things asynchronously, we track whether this source
    //    has been removed, so that ongoing async actions can be stopped ASAP
    Object.assign(this, {
      id: util.uuidv4(),
      removed: false,
      newRequestHeaders: {},
      subtitles: [],
      subtitleEntries: []
    }, details);
    // Notes:
    // Remember important objects, but don't forget to remove in 'forMessage'
    // those that cannot be cloned.
    // Unit tests will pass an undefined 'parent'.
    parent ||= {};
    this.parent = parent;
    this.webext = parent.webext;
    this.tabHandler = parent.tabHandler;
    // Even though for a single source we should only need to remember the
    // original url and any final redirection location, we manage merging
    // multiple sources when applicable.
    this.urls = new Set();
    this.addUrl(this.url);
    this.addUrl(this.forceUrl);
    // Create menu entries helpers, associated to each subtitle and base source.
    // Note: we only expect to have subtitles when enabled.
    this.menuGroup = parent.menuHandler?.addGroup();
    for (const subtitle of this.subtitles) {
      this.addSubtitleEntry(subtitle);
    }
    delete(this.subtitles);
    this.entryHandler = new VideoSourceEntryHandler(this);
    this.downloadEntries = [];
    this.needRefresh = true;
    this.mutex = new asynchronous.Mutex();
  }

  // Clone this video source, without fields that cannot be cloned when passing
  // the result as a message between the extension components.
  forMessage() {
    // Shallow copy.
    const r = Object.assign({}, this);
    // Remove unwanted fields (that would fail message passing anyway).
    delete(r.parent);
    delete(r.webext);
    delete(r.tabHandler);
    delete(r.menuGroup);
    delete(r.entryHandler);
    delete(r.subtitleEntries);
    delete(r.downloadEntries);
    // Build downloads information.
    r.downloads = this.downloadEntries.map(entryHandler => {
      // Also remove unwanted (may consume memory for nothing) fields.
      // First deep clone.
      const download = structuredClone(entryHandler.download);
      if (download.details.hls) {
        delete(download.details.hls.raw);
        if (download.details.hls.keys) {
          for (const key of download.details.hls.keys) {
            delete(key.raw);
          }
        }
      }
      if (download.details.audio) {
        delete(download.details.audio.raw);
        if (download.details.audio.keys) {
          for (const key of download.details.audio.keys) {
            delete(key.raw);
          }
        }
      }
      if (download.details.subtitle) {
        delete(download.details.subtitle.raw);
      }
      return download;
    });
    return r;
  }

  remove() {
    this.removed = true;
    return this.removeMenuEntry();
  }

  setTabTitle(title) {
    if (!title || (this.tabTitle === title)) return;
    this.tabTitle = title;
    this.needRefresh = true;
  }

  matches(other) {
    if (other.hasUrl(this.getUrl())) return 'url';
    if (this.etag && (this.etag === other.etag)) return 'ETag';
  }

  getUrl() {
    if (this.forceUrl) return this.forceUrl;
    if (this.actualUrl) return this.actualUrl;
    return this.url;
  }

  getUrls() {
    return this.urls;
  }

  addUrl(url) {
    if (url) this.urls.add(url);
  }

  addUrls(urls) {
    for (const url of urls) {
      this.addUrl(url);
    }
  }

  hasUrl(url) {
    return this.urls.has(url);
  }

  setReferrer(referrer) {
    // Update source referrer, and existing download entries too.
    this.referrer = referrer;
    for (const entryHandler of this.downloadEntries) {
      entryHandler.download.details.referrer = this.referrer || this.frameUrl;
    }
  }

  setRedirection(url) {
    // Ignore url if already used.
    if ((url === this.url) || (url === this.actualUrl)) return;
    this.actualUrl = url;
    this.addUrl(url);
    // Ensure we re-build downloadSite unless forceUrl is used.
    if (!this.forceUrl) delete(this.downloadSite);
    this.needRefresh = true;
  }

  // Indicates that the final url was reached.
  setCompleted() {
    this.completed = true;
  }

  setFilename(filename) {
    if (!filename || (this.filename === filename)) return;
    this.filename = filename;
    this.needRefresh = true;
  }

  setSize(size) {
    if (!Number.isInteger(size) || (this.size === size)) return;
    this.size = size;
    this.needRefresh = true;
  }

  mergeField(field, from, needRefresh) {
    // Note: consider a field declared undefined as not present.
    if ((this[field] !== undefined) || (this[field] === from[field])) return;
    this[field] = from[field];
    this.needRefresh |= needRefresh;
  }

  merge(from) {
    // Get our missing fields if any.
    for (const field of ['cookie', 'etag']) {
      this.mergeField(field, from, false);
    }
    for (const field of ['filename', 'size']) {
      this.mergeField(field, from, true);
    }

    // Set final redirection if we are not complete.
    if (!this.completed && from.completed) {
      this.setRedirection(from.getUrl());
    }

    // Take into account all urls.
    this.addUrls(from.getUrls());
  }

  getFilenameRefining() {
    const self = this;
    const setting = settings.video.filenameRefining;
    return self.tabHandler.extensionProperties.get({
      key: setting.getKey(),
      create: tabHandler => new unsafe.CodeExecutor({
        webext: self.webext,
        name: 'filename refining',
        args: ['params'],
        setting,
        notifDefaults: self.parent.notifDefaults
      })
    });
  }

  findSubtitle(subtitle) {
    for (const known of this.subtitleEntries) {
      if (known.subtitle.url === subtitle.url) return known.subtitle;
    }
  }

  mergeSubtitle(known, subtitle) {
    // If fresh subtitle was intercepted, we are done: at best the known one was
    // not intercepted (that is, explicitly associated to source), and at worst
    // it was also intercepted (consider this a duplicate).
    // Same if known subtitle was not intercepted: consider the fresh one a
    // duplicate.
    if (subtitle.intercepted || !known.intercepted) return;

    if (settings.trace.video) {
      console.log(`Removing tab=<${this.tabId}> frame=<${this.frameId}> video source id=<${this.id}> url=<${this.url}> subtitles:`, known);
      console.log(`Adding tab=<${this.tabId}> frame=<${this.frameId}> video source id=<${this.id}> url=<${this.url}> subtitles:`, subtitle);
    }

    // Replace known one by fresh one.
    for (const entryHandler of this.subtitleEntries) {
      if (entryHandler.subtitle.url === subtitle.url) {
        entryHandler.subtitle = subtitle;
        this.needRefresh = true;
        break;
      }
    }
  }

  addSubtitleEntry(subtitle) {
    if (settings.trace.video) console.log(`Adding tab=<${this.tabId}> frame=<${this.frameId}> video source id=<${this.id}> url=<${this.url}> subtitles:`, subtitle);

    const entryHandler = new VideoSourceEntryHandler(this);
    entryHandler.subtitle = subtitle;
    this.subtitleEntries.push(entryHandler);
    // Note: don't add subtitles url to the source urls.
    // We only want to consider the actual source (to download) urls, not any
    // associated track url. These should be handled specifically by caller if
    // needed: we already ignore them once known, and gather the various
    // known subtitles we can associate to video streams.
    //this.addUrl(subtitle.url);
    this.needRefresh = true;
  }

  addSubtitles(subtitles) {
    // Note: we only expect to be called when subtitles are enabled.
    for (const subtitle of subtitles) {
      // Merge if already known.
      const known = this.findSubtitle(subtitle);
      if (known) {
        this.mergeSubtitle(known, subtitle);
        continue;
      }

      this.addSubtitleEntry(subtitle);
    }
  }

  async refresh() {
    if (!this.needRefresh) return false;
    this.needRefresh = false;

    if (this.removed) {
      if (settings.video.debug) console.warn(`Ignoring actions for removed tab=<${this.tabId}> frame=<${this.frameId}> video source id=<${this.id}> url=<${this.url}>`);
      return false;
    }

    if (!this.tabSite) this.tabSite = util.parseSiteUrl(this.tabUrl);
    if (!this.downloadSite) this.downloadSite = util.parseSiteUrl(this.getUrl());

    // Notes:
    // Since we receive information from both content script and intercepted
    // query responses, refreshing can be called multiple times in a short time.
    // There is no simple way to ensure everything is done properly (concurrent
    // accesses) and efficiently.
    // However, there are a few places wher we can, and need, to synchronize
    // concurrent code execution.
    // Here, we setup a 'namer' from currently known information, and let it
    // execute async code to determine new name/extension to use if applicable.
    // We really want callers to modify the source in the order they arrived,
    // so that we ensure the one with the most recent information will do the
    // final modifications.
    // Hence, we use 'syncEnding': callers may run in parallel, we only need
    // them to continue in their initial order.
    const namer = new VideoSourceNamer(this);
    await this.mutex.syncEnding(async () => {
      await namer.refine();
    });

    let {name, extension, filename} = namer;
    const downloadFile = {
      name,
      extension,
      filename
    };
    // Detect changes in filename.
    // Note: upon first call, refined name is saved; on next calls (e.g. URL
    // redirection detected) we do check whether refined name did change.
    let changes = !util.deepEqual(this.downloadFile, downloadFile);
    this.downloadFile = downloadFile;

    // Update determined download info.
    // Note: we build download information and store them inside a menu entry
    // handler so that menu entry callback (on click) can access up-to-date
    // download details when we change them, without having to update the
    // menu entry callback function.
    const download = {
      source: {
        windowId: this.windowId,
        tabId: this.tabId,
        frameId: this.frameId,
        downloadId: this.entryHandler.downloadId,
      },
      details: {
        url: this.getUrl(),
        // We may already know a referrer (e.g. intercepted request), or fall
        // back to the frame URL (if applicable).
        // Note: when referrer is updated on source, it is also updated in
        // download entries.
        referrer: this.referrer || this.frameUrl,
        cookie: this.cookie,
        userAgent: this.userAgent,
        file: filename,
        size: this.size
      },
      params: {
        addCookie: !this.seenRequest,
        addUserAgent: !this.seenRequest,
        addComment: true,
        mimeFilename: this.filename,
        mimeType: this.mimeType,
        tabUrl: this.tabUrl,
        tabTitle: this.tabTitle,
        notify: true
      }
    };
    if (this.hls) {
      download.details.size = this.hls.size;
      download.details.sizeQualifier = this.hls.sizeQualifier;
      download.details.hls = {
        raw: this.hls.raw,
        url: this.hls.getURL().href
      };
      if (this.audio) download.details.audio = {
        raw: this.audio.raw,
        url: this.audio.getURL().href
      };
    }
    // Determine subtitles per priority when applicable.
    let subtitlePriority;
    const grouped = Object.groupBy(this.subtitleEntries, entryHandler => {
      const priority = entryHandler.subtitle.priority || 0;
      subtitlePriority = Math.max(subtitlePriority || 0, priority);
      return priority;
    });
    // When there are, keep only subtitles with first priority.
    const subtitleEntries = grouped[subtitlePriority];

    // Remove menu entries created for other subtitles ...
    for (const [priority, handlers] of Object.entries(grouped)) {
      if (priority === subtitlePriority) continue;
      for (const entryHandler of handlers) {
        if (await entryHandler.removeMenuEntry()) changes = true;
      }
    }
    // ... or created for non-subtitle case.
    if (subtitleEntries && await this.entryHandler.removeMenuEntry()) changes = true;

    if (subtitleEntries) {
      for (const entryHandler of subtitleEntries) {
        // Refine details for these subtitles.
        entryHandler.download = {
          source: Object.assign(structuredClone(download.source), {
            downloadId: entryHandler.downloadId
          }),
          details: Object.assign(structuredClone(download.details), {
            subtitle: entryHandler.subtitle
          }),
          params: download.params
        };
      }
      this.downloadEntries = subtitleEntries;
    } else {
      this.entryHandler.download = download;
      this.downloadEntries = [this.entryHandler];
    }

    // Determine menu title.
    // We will prefix the download size and extension if possible, except for
    // for HLS.
    // The rest of the title will be the file name (without extension).
    const title = [];
    // Format size if known (with optional qualifier, e.g. for HLS).
    if (download.details.size) {
      title.push(`${download.details.sizeQualifier || ''}${util.getSizeText(download.details.size)}`);
    }
    // Don't show filename extension in title prefix if too long.
    // Display the whole filename instead.
    if (extension && (extension.length > 4)) {
      extension = undefined;
      name = filename;
    }

    for (const entryHandler of this.downloadEntries) {
      const subtitle = entryHandler.subtitle;
      let entryTitle = [...title];
      if (this.hls) {
        entryTitle.push(`🎞️${this.hls.name}`);
      } else if (extension) {
        entryTitle.push(extension);
      }
      if (subtitle) entryTitle.push(`💬${subtitle.lang || subtitle.name}`);
      entryTitle = entryTitle.join(' ');
      if (entryTitle) entryTitle = `[${entryTitle}] `;
      // Note: on FireFox (77) if the text width (in pixels) exceeds a given
      // size, the end is replaced by an ellipsis character.
      // There is thus no easy (or at all) way to determine how many characters
      // is the limit, as it depends on which characters are present.
      // A good average limit seems to be somewhere around 75 characters; 72 is
      // then a good value to avoid it in the majority of cases.
      entryTitle = `${entryTitle}${util.limitText(name, 72 - entryTitle.length)}`;
      // Notes:
      // If there were changes in filename, there should be changes in title too.
      // If only the title changes, it should be due to a file size change.
      // In either case, we want to update the menu entry if existing and notify
      // caller there were changes.
      changes = changes || (entryTitle !== entryHandler.title);
      entryHandler.title = entryTitle;
      // Refresh menu entry when applicable.
      if (changes) {
        await entryHandler.updateMenuEntry({
          title: entryTitle
        });
      }
    }
    // Add new menu entries when applicable
    if (this.tabHandler.isFocused()) await this.addMenuEntry();

    return changes;
  }

  // Trigger download for given entry handler.
  async download(entryHandler, details) {
    // Use current entry download details, and get extra details from caller.
    // Expected extra details: 'auto'.
    details = Object.assign({}, entryHandler.download.details, {
      auto: details.auto
    });

    // We get side contents (HLS keys and subtitles, if any) to pass them to the
    // download application, which then only needs to download the HLS stream
    // playlist segments.
    // If we fail these, fail the download.

    // Get subtitles if needed.
    if (details.subtitle && !details.subtitle.raw) {
      try {
        const response = await this.webext.fetch({
          resource: details.subtitle.url,
          options: {
            referrer: details.referrer,
            headers: this.newRequestHeaders
          }, params: {
            debug: settings.trace.video,
            wantText: true
          }
        });
        if (response.ok) {
          details.subtitle.raw = response.text;
        } else {
          this.webext.notify({
            title: 'Failed to download subtitles',
            level: 'error',
            message: `${details.subtitle.filename}\n${details.subtitle.url}`,
            error: response
          });
          return;
        }
      } catch (error) {
        this.webext.notify({
          title: 'Failed to download subtitles',
          level: 'error',
          message: `${details.subtitle.filename}\n${details.subtitle.url}`,
          error
        });
        return;
      }
    }

    // Get key(s) if needed.
    if (!await this.downloadHLSKeys(details, 'hls')) return;
    if (!await this.downloadHLSKeys(details, 'audio')) return;

    // For HLS, pass headers too.
    if (details.hls && !details.headers) {
      details.headers = [];
      for (const [name, value] of Object.entries(this.newRequestHeaders)) {
        details.headers.push({name, value});
      }
    }

    // Pass HLS stream(s) as array.
    if (details.hls) {
      const hls = [details.hls];
      if (details.audio) {
        hls.push(details.audio);
        delete(details.audio);
      }
      details.hls = hls;
    }

    await dlMngr.download(details, entryHandler.download.params);
  }

  async downloadHLSKeys(details, field) {
    const hlsKeys = this[field]?.getKeys();
    if (hlsKeys) {
      details[field].keys = hlsKeys;
      for (const key of hlsKeys) {
        if (!key.url || key.raw) continue;
        try {
          const response = await this.webext.fetch({
            resource: key.url,
            options: {
              referrer: details.referrer,
              headers: this.newRequestHeaders
            }, params: {
              debug: settings.trace.video,
              wantBase64: true
            }
          });
          if (response.ok) {
            key.raw = response.base64;
          } else {
            this.webext.notify({
              title: 'Failed to download HLS key',
              level: 'error',
              message: key.url,
              error: response
            });
            return false;
          }
        } catch (error) {
          this.webext.notify({
            title: 'Failed to download HLS key',
            level: 'error',
            message: key.url,
            error
          });
          return false;
        }
      }
    }

    return true;
  }

  // Creates menu entries.
  // Notes:
  // This will be called each time the owning tab is activated, which is not
  // a problem as there is nothing too intensive done.
  // 'onclick' being a function, it will access up-to-date fields when menu
  // entry is clicked. Only values like 'title' needs to be refreshed when
  // the source is updated.
  async addMenuEntry() {
    const self = this;
    // First re-add our group if needed.
    await self.menuGroup.add();
    for (const entryHandler of self.downloadEntries) {
      await entryHandler.addMenuEntry({
        title: entryHandler.title,
        onclick: (data, tab) => {
          // Auto-download enabled by default, unless using non-main button
          // or 'Ctrl' key.
          self.download(entryHandler, {
            auto: (data.button === 0) && !data.modifiers.includes('Ctrl')
          });
        }
      });
    }
  }

  async removeMenuEntry() {
    // First remove our group.
    await this.menuGroup.remove();
    // Then remove every menu entry we know.
    for (const entryHandler of this.subtitleEntries) {
      await entryHandler.removeMenuEntry();
    }
    await this.entryHandler.removeMenuEntry();
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
//
//
// Since some fields (e.g. 'sources') may be modified while we do 'async' things,
// sometimes we prefer to:
//  - first do a (shallow) copy of the collection to work on
//  - work on the copy, inside an explicit promise
//  - have the function non-async, and return the explicit promise
// This ensures we work on the actual elements the caller could see before
// calling, while still handling async stuff to do.
class VideoSourceTabHandler {

  constructor(parent, tabHandler) {
    const self = this;
    self.parent = parent;
    self.webext = parent.webext;
    self.tabHandler = tabHandler;
    self.menuHandler = parent.menuHandler;
    self.requestsHandler = new http.RequestsHandler();
    self.sources = [];
    self.subtitles = {};
    self.ignoredUrls = new Set();
    // Buffered requests, per url.
    self.bufferedRequests = {};

    // Get defaults values to pass to notif, if any.
    self.notifDefaults = {
      windowId: tabHandler.windowId,
      tabId: tabHandler.id
    };
    util.cleanupFields(self.notifDefaults);

    let setting = settings.video.responseRefining;
    self.responseRefining = self.tabHandler.extensionProperties.get({
      key: setting.getKey(),
      create: tabHandler => new unsafe.CodeExecutor({
        webext: self.webext,
        name: 'response refining',
        args: ['params'],
        setting,
        notifDefaults: self.notifDefaults
      })
    });

    setting = settings.video.subtitlesRefining;
    self.subtitlesRefining = self.tabHandler.extensionProperties.get({
      key: setting.getKey(),
      create: tabHandler => new unsafe.CodeExecutor({
        webext: self.webext,
        name: 'subtitles refining',
        args: ['params'],
        setting,
        notifDefaults: self.notifDefaults
      })
    });

    setting = settings.video.interceptRefining;
    self.interceptRefining = self.tabHandler.extensionProperties.get({
      key: setting.getKey(),
      create: tabHandler => new unsafe.CodeExecutor({
        webext: self.webext,
        name: 'interception refining',
        args: ['params'],
        setting,
        notifDefaults: self.notifDefaults
      })
    });
    // Reset intercepton refining when modified.
    [settings.video.interceptRefining.inner.enabled, settings.video.interceptRefining.inner.script].forEach(setting => {
      setting.addListener((setting, oldValue, newValue) => {
        this.refined = undefined;
      });
    });
  }

  async refineInterception() {
    if (this.refined === undefined) {
      this.refined = this.interceptRefining.execute({
        params: Object.assign({}, {
          windowId: this.tabHandler.windowId,
          tabId: this.tabHandler.id,
          url: this.tabHandler.url
        })
      });
    }

    // For debugging purposes, replace promise with result once known.
    const r = await this.refined;
    this.refined = r;

    return r;
  }

  async canInterceptVideo() {
    const refined = await this.refineInterception();
    return !(refined?.intercept?.disabled ?? false) && (refined?.intercept?.video ?? true);
  }

  tabUpdated(details) {
    let r = asynchronous.defer;

    if (details.tabChanges.url) this.tabReset({sameUrl: false});
    if (details.tabChanges.title) {
      // Note: do our best to work on expected 'sources' even if they are altered
      // while we work on them.
      const sources = this.sources.slice();
      r = r.then(async () => {
        for (const source of sources) {
          source.setTabTitle(details.tabChanges.title);
          await source.refresh();
        }
      });
      r = r.then(() => {
        this.updateVideos();
      });
    }

    return r;
  }

  tabReset(details) {
    // Even if we remain on the same url, assume we will get (again) the same
    // sources and details if the page content (about to be loaded) truly is
    // the same.
    // Some sites do actually navigate to other content while keeping the same
    // url, so better forget previous sources etc.
    // Reset interception refining too.
    this.refined = undefined;
    this.requestsHandler.clear();
    for (const source of this.sources) {
      // Note: there is no need to 'await' for this.
      source.remove();
    }
    this.sources = [];
    this.subtitles = {};
    this.ignoredUrls.clear();
    this.updateVideos();
    this.bufferedRequests = {};
  }

  janitorBuffered(url, buffered, remove) {
    if (util.getTimestamp() - buffered.timeStamp < constants.REQUESTS_TTL) return false;
    if (settings.debug.video) {
      for (const b of buffered.buffer) {
        console.log('Dropping buffered request/response=<%o>: TTL reached', b);
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
    let buffered = this.bufferedRequests[url];
    if (!buffered) {
      if (remove) return;
      // Search url in known buffers, as it may be a redirection.
      // Reminder: we can reuse 'buffered', but *NOT* 'url' when looping over
      // entries, as the passed 'url' is needed afterwards.
      for (const [key, buffered] of Object.entries(this.bufferedRequests)) {
        if (this.janitorBuffered(key, buffered, true)) continue;
        if (buffered.hasUrl(url)) return buffered;
      }
      buffered = this.bufferedRequests[url] = new http.RequestBuffer();
    } else {
      this.janitorBuffered(url, buffered, false);
    }
    if (remove) delete(this.bufferedRequests[url]);
    return buffered;
  }

  ignoreUrl(url) {
    if (url) this.ignoredUrls.add(url);
  }

  ignoreUrls(urls) {
    for (const url of urls) {
      this.ignoreUrl(url);
    }
  }

  addMenuEntries() {
    const sources = this.sources.slice();
    return asynchronous.defer.then(async () => {
      for (const source of sources) {
        await source.addMenuEntry();
      }
    });
  }

  removeMenuEntries() {
    const sources = this.sources.slice();
    return asynchronous.defer.then(async () => {
      for (const source of sources) {
        await source.removeMenuEntry();
      }
    });
  }

  findSource(url, update) {
    for (const source of this.sources) {
      if (source.hasUrl(url)) {
        // Update some fields if needed.
        if (update) {
          for (const [field, value] of Object.entries(update)) {
            if (!source[field] && (value != null)) {
              // Notes:
              // If source has a 'setXXX' method for the field, call it.
              // None of the fields we (current callers) update here require to
              // refresh the source.
              const updateMethod = `set${field.charAt(0).toUpperCase()}${field.slice(1)}`;
              if (updateMethod in source) {
                source[updateMethod](value);
              } else {
                source[field] = value;
              }
            }
          }
        }
        return source;
      }
    }
  }

  removeSource(url) {
    let found;
    // Consider the url and its normalized form.
    const normalizedUrl = util.normalizeUrl(url);
    this.sources = this.sources.filter(source => {
      // We only expect to find and remove one element.
      if (found) return true;
      const match = source.hasUrl(url) || source.hasUrl(normalizedUrl);
      if (match) {
        found = source;
        source.remove();
      }
      return !match;
    });
    return found;
  }

  // Merges sources based on ETag and urls.
  mergeSources(source) {
    this.sources = this.sources.filter(other => {
      if (other === source) return true;
      const matches = source.matches(other);
      if (matches) {
        if (settings.debug.video) console.log(`Merging old source=<%o> into=<%o>: Match on ${matches}`, util.tryStructuredClone(other), util.tryStructuredClone(source));
        source.merge(other);
        other.remove();
        return false;
      }
      return true;
    });
  }

  async pairSubtitles() {
    let needUpdate = false;
    for (const source of this.sources) {
      const subtitles = this.subtitles[source.originUrl] || [];
      if (!subtitles.length) continue;
      source.addSubtitles(this.subtitles[source.originUrl] || []);
      needUpdate = true;
      await source.refresh();
    }
    if (needUpdate) this.updateVideos();
  }

  async checkHLS(requestDetails) {
    if (!settings.video.hls.intercept) return;
    // Wait for actual response.
    if (requestDetails.isRedirection()) return;

    const isHLS = requestDetails.contentType.isHLS();
    const maybeHLS = !isHLS && requestDetails.contentType.maybeHLS(requestDetails.actualFilename);
    if (!isHLS && !maybeHLS) return;

    // For 'may be' HLS, don't bother if response size is above limit: we
    // don't expect master/stream playlist to be this big.
    // Notes about stream playlist:
    // Some sites don't query a master playlist and we only see requests for
    // selected stream playlist, so we wish to process them too.
    // When a master playlist is queried first, we deduce the stream playlists
    // URLs and ignore them.
    if (maybeHLS && (requestDetails.contentLength >= constants.HLS_SIZE_LIMIT)) {
      if (settings.debug.video) console.log(`Ignoring maybe-hls url=<${requestDetails.url}> content size=<${requestDetails.contentLength}> above limit:`, requestDetails);
      return;
    }

    let playlist;
    const newRequestHeaders = requestDetails.newRequestHeaders();
    try {
      // Notes:
      // The 'only-if-cached' cache mode is not expected to work here.
      // So we just try our best to do the same request with the same referer.
      // Referer must be passed as API parameter: ignored as pure header.
      // To ignore browser extension constraints, delegate request to native
      // application.
      const response = await this.webext.fetch({
        resource: requestDetails.url,
        options: {
          referrer: requestDetails.referrer,
          headers: newRequestHeaders
        }, params: {
          debug: settings.trace.video,
          wantText: true
        }
      });
      if (response.ok) {
        // Check again content size before trying to parse it.
        const contentLength = response.text.length;
        if (contentLength >= constants.HLS_SIZE_LIMIT) {
          if (settings.debug.video) console.log(`Ignoring maybe-hls url=<${requestDetails.url}> content size=<${contentLength}> above limit:`, requestDetails);
          return;
        }
        playlist = new hls.HLSPlaylist(response.text, {
          url: requestDetails.url,
          debug: settings.debug.video
        });
      } else {
        console.log(`Failed to fetch possibly HLS url=<${requestDetails.url}> content:`, response);
      }
    } catch (error) {
      console.log(`Failed to fetch possibly HLS url=<${requestDetails.url}> content:`, error);
    }

    if (!playlist) {
      if (settings.debug.video) console.log(`Ignoring actually non-hls url=<${requestDetails.url}>`);
      return;
    }

    if (playlist.streams.length) {
      if (settings.debug.video) console.log('Found HLS master playlist:', playlist, requestDetails);
      // Once a master playlist has been processed, we can discard its URL since
      // we don't need to process anything else.
      this.discardUrl(playlist.url);
    } else {
      if (settings.debug.video) console.log('Found HLS non-master playlist:', playlist);
    }

    // Add HLS streams as sources.
    for (const stream of playlist.streams) {
      const subtitles = [];

      for (const track of stream.audio.concat(stream.subtitles)) {
        if (!track.uri) continue;
        const url = track.getURL().href;
        // We can also discard tracks URL now.
        this.discardUrl(url);
        // If any track was served as an HLS, remove from sources.
        if (this.removeSource(url) && settings.debug.video) {
          console.log(`HLS stream track playlist=<${url}> was previously received and will be removed in favor of actual stream`);
        }
      }

      let audio;
      for (const track of stream.audio) {
        if (!track.uri) continue;
        const url = track.getURL().href;

        if (audio) {
          console.warn(`Ignoring external HLS audio track url=<${url}>: another track was already used`);
          continue;
        }
        const contentType = new http.ContentType();
        contentType.guess(util.getFilename(url));
        if (contentType.isHLS()) {
          const response = await this.webext.fetch({
            resource: url,
            options: {
              referrer: requestDetails.referrer,
              headers: newRequestHeaders
            }, params: {
              debug: settings.trace.video,
              wantText: true
            }
          });
          if (response.ok) {
            const content = response.text;
            const playlistStream = new hls.HLSPlaylist(content, {
              url: url,
              debug: settings.debug.video
            });
            const actualStream = playlistStream.isStream();
            if (actualStream) {
              console.log(`Using external HLS stream audio track playlist=<${url}>`);
              audio = actualStream;
            } else {
              console.log(`HLS stream audio url=<${url}> could have been another HLS stream but does not appear to be`);
            }
          } else {
            console.log(`Failed to fetch HLS stream audio track playlist=<${url}>:`, response);
          }

        } else {
          console.warn(`Ignoring external HLS stream audio track url=<${url}>: not a playlist`);
        }
      }

      for (const track of stream.subtitles) {
        let url = track.getURL().href;

        // Check if this appear to be a true subtitle track, or another HLS
        // stream.
        const contentType = new http.ContentType();
        contentType.guess(util.getFilename(url));
        // If we download the subtitles now, and this is not an HLS pointing to
        // another uri, keep the content as-is.
        let raw;
        if (!contentType.isSubtitle() && contentType.isHLS()) {
          const response = await this.webext.fetch({
            resource: url,
            options: {
              referrer: requestDetails.referrer,
              headers: newRequestHeaders
            }, params: {
              debug: settings.trace.video,
              wantText: true
            }
          });
          if (response.ok) {
            const content = response.text;
            const playlistStream = new hls.HLSPlaylist(content, {
              url: url,
              debug: settings.debug.video
            });
            const actualStream = playlistStream.isStream();
            if (actualStream) {
              const segments = actualStream.getTags('EXTINF');
              if ((segments.length === 1) && segments.at(0).uri) {
                const uri = segments.at(0).uri;
                console.log(`HLS stream subtitles url=<${url}> is actually an HLS segment pointing to uri=<${uri}>`);
                url = uri;
                this.discardUrl(url);
              } else {
                console.log(`HLS stream subtitles url=<${url}> is actually another HLS stream we do not handle`);
                raw = content;
              }
            } else {
              console.log(`HLS stream subtitles url=<${url}> could have been another HLS stream but does not appear to be`);
              raw = content;
            }
          } else {
            console.log(`Failed to fetch HLS stream subtitles playlist=<${url}>:`, response);
          }
        }

        // Do nothing else if disabled.
        if (!settings.video.subtitles.intercept) continue;
        const subtitle = {
          name: track.name,
          lang: track.lang,
          url,
          filename: util.getFilename(url),
          raw
        };
        const scriptParams = {
          params: {
            videoHandler: this,
            requestDetails,
            hlsPlaylist: playlist,
            subtitle
          }
        };
        await this.subtitlesRefining.execute(scriptParams);

        subtitles.push(subtitle);
      }

      const url = stream.getURL().href;
      // Get actual stream content: get everything we can (and is not too much)
      // so that the download application will only need to download the HLS
      // stream playlist segments.
      // This is also useful to get hint about the total stream size.
      // (HLS keys and subtitles will be downloaded when needed)
      // If we fail, ignore this stream.
      try {
        const response = await this.webext.fetch({
          resource: url,
          options: {
            referrer: requestDetails.referrer,
            headers: newRequestHeaders
          }, params: {
            debug: settings.trace.video,
            wantText: true
          }
        });
        if (response.ok) {
          const content = response.text;
          const playlistStream = new hls.HLSPlaylist(content, {
            url: url,
            debug: settings.debug.video
          });
          const actualStream = playlistStream.isStream();
          if (!actualStream) {
            console.log(`Ignoring actually non-stream playlist=<${url}>:`, playlistStream);
            continue;
          }
          stream.merge(actualStream);
        } else {
          console.log(`Failed to fetch HLS stream url=<${url}> content:`, response);
          continue;
        }
      } catch (error) {
        console.log(`Failed to fetch HLS stream url=<${url}> content:`, error);
        continue;
      }

      if (this.removeSource(url) && settings.debug.video) {
        console.log(`HLS stream playlist=<${url}> was previously received and will be replaced`);
      }

      await this.addSource({
        url: url,
        originUrl: requestDetails.originUrl,
        referrer: requestDetails.referrer,
        newRequestHeaders: newRequestHeaders,
        mimeType: requestDetails.contentType.mimeType,
        hls: stream,
        audio,
        subtitles,
        windowId: this.tabHandler.windowId,
        tabId: this.tabHandler.id,
        tabUrl: this.tabHandler.url,
        frameId: requestDetails.received.frameId
      });
    }

    // For stream playlist, add as source unless already known.
    const stream = playlist.isStream();
    if (stream) {
      const url = stream.getURL().href;
      const update = {
        originUrl: requestDetails.originUrl,
        referrer: requestDetails.referrer
      };
      if (this.findSource(url, update)) {
        console.log(`Ignoring HLS stream playlist=<${url}>: already known`);
      } else {
        await this.addSource({
          url: url,
          originUrl: requestDetails.originUrl,
          referrer: requestDetails.referrer,
          newRequestHeaders: newRequestHeaders,
          mimeType: requestDetails.contentType.mimeType,
          hls: stream,
          subtitles: [],
          windowId: this.tabHandler.windowId,
          tabId: this.tabHandler.id,
          tabUrl: this.tabHandler.url,
          frameId: requestDetails.received.frameId
        });
      }
    }

    return playlist;
  }

  async download(details, downloadDetails) {
    for (const source of this.sources) {
      for (const entryHandler of source.downloadEntries) {
        if (entryHandler.download.source.downloadId === details.downloadId) {
          return await source.download(entryHandler, downloadDetails);
        }
      }
    }
  }

  async addSource(details) {
    const tabId = details.tabId;
    const frameId = details.frameId;
    const url = details.url;

    // Silently drop previously ignored URLs.
    if (this.ignoredUrls.has(url)) return;

    // Ignore already known source.
    if (this.findSource(url)) return;

    const tabHandler = this.tabHandler;
    // Note: 'ignoreDownload' takes care of buffered requests if any.

    // Ensure we received a message from the current tab: either sender as been
    // determined 'live', or its tab URL matches ours.
    // If not, ignore the source.
    if ((details.tabUrl !== tabHandler.url) && (!details.sender || !details.sender.live)) return this.ignoreDownload(details, 'Tab URL mismatch');
    // Ignore urls that we can't download.
    if (!http.canDownload(url)) return this.ignoreDownload(details, 'URL not handled');
    // Ignore apparent content types that we don't want to download.
    const contentType = new http.ContentType();
    contentType.guess(util.getFilename(url));
    const reason = checkVideoContentType(contentType);
    if (reason) return this.ignoreDownload(details, reason);

    details.mimeType = contentType.mimeType;
    details.tabTitle = tabHandler.title;
    const source = new VideoSource(this, details);
    if (settings.debug.video) console.log(`Adding tab=<${tabId}> frame=<${frameId}> hls=<${!!details.hls}> video source id=<${source.id}> url=<${url}>`);
    this.sources.push(source);

    // Process buffered requests.
    // Except when source is HLS: we already did process what was needed.
    const buffered = this.getBufferedRequests(url, true);
    if (buffered && !details.hls) await buffered.replay(this);

    // Refresh source, then when applicable add menu entry and trigger videos
    // update.
    await source.refresh();
    if (tabHandler.isFocused()) await source.addMenuEntry();
    this.updateVideos();
  }

  async addSubtitles(details) {
    if (!settings.video.subtitles.intercept) return;
    if (!await this.canInterceptVideo()) return;

    const subtitles = details.subtitles;
    if (!subtitles || !subtitles.length) return;

    const source = this.findSource(details.url);
    if (!source) {
      if (settings.debug.video) console.log(`Not adding unknown tab=<${details.tabId}> frame=<${details.frameId}> video url=<${details.url}> subtitles:`, subtitles);
      return;
    }

    for (const subtitle of subtitles) {
      // Set filename from URL if needed.
      if (!subtitle.filename) subtitle.filename = util.getFilename(subtitle.url);
      const scriptParams = {
        params: {
          videoHandler: this,
          videoSource: source,
          subtitle
        }
      };
      await this.subtitlesRefining.execute(scriptParams);
    }
    source.addSubtitles(subtitles);
    await source.refresh();
    this.updateVideos();
  }

  async onRequest(request) {
    if (!await this.canInterceptVideo()) return;

    const url = request.url;
    // Silently drop previously ignored URLs.
    if (this.ignoredUrls.has(url)) return;

    this.requestsHandler.addRequest(request);
    const source = this.findSource(url, {
      originUrl: request.originUrl,
      referrer: http.findHeaderValue(request.requestHeaders, 'Referer')
    });
    if (!source) {
      this.getBufferedRequests(url).addRequest(request);
      return;
    }
    // Remember that we saw a request for this source.
    source.seenRequest = true;

    // Extract useful request details.
    const cookie = http.findHeaderValue(request.requestHeaders, 'Cookie');
    if (cookie) source.cookie = cookie;
    const userAgent = http.findHeaderValue(request.requestHeaders, 'User-Agent');
    if (userAgent) source.userAgent = userAgent;
  }

  async onResponse(response) {
    if (!await this.canInterceptVideo()) return;

    const url = response.url;
    let location;
    const statusCode = response.statusCode;

    // Extract redirected url when applicable.
    // Note: even though it should have no meaning/purpose in our case, url may
    // contain a fragment; so normalize it.
    if (Math.floor(statusCode / 100) === 3) location = util.normalizeUrl(http.findHeaderValue(response.responseHeaders, 'Location'), settings.debug.video, 'Location');

    // Silently drop previously ignored URLs.
    if (this.ignoredUrls.has(url)) {
      // Also ignore actual url if any, so that we can silently ignore the next
      // request that should soon be triggered.
      this.ignoreUrl(location);
      return;
    }

    const requestDetails = this.requestsHandler.addResponse(response);
    requestDetails.parseResponse();

    const source = this.findSource(url, {originUrl: response.originUrl});
    const scriptParams = {
      params: {
        videoHandler: this,
        videoSource: source,
        requestDetails,
        hlsPlaylist: undefined
      }
    };
    if (!source) {
      // Check for possible HLS or subtitle content.
      const playlist = await this.checkHLS(requestDetails);
      let skip = !!playlist;
      if (!skip && settings.video.subtitles.intercept && requestDetails.contentType.isSubtitle()) {
        if (settings.trace.video) console.log('Received subtitle response:', requestDetails);

        const subtitle = {
          url: requestDetails.url,
          // Try our best to use proper subtitle extension, in case the request
          // points to some kind of API, not the file itself.
          filename: util.filenameWithExtension(requestDetails.actualFilename, requestDetails.actualExtension),
          intercepted: true
        };
        const scriptParams = {
          params: {
            videoHandler: this,
            requestDetails,
            subtitle
          }
        };
        await this.subtitlesRefining.execute(scriptParams);
        if (subtitle.name || subtitle.lang) {
          const originUrl = requestDetails.originUrl;
          if (settings.trace.video) console.log(`Adding tab=<${response.tabId}> frame=<${response.frameId}> originUrl=<${originUrl}> subtitles:`, subtitle);

          // Remember intercepted subtitles per origin URL.
          let subtitles = this.subtitles[originUrl];
          if (!subtitles) subtitles = this.subtitles[originUrl] = [];
          subtitles.push(subtitle);
          await this.pairSubtitles();
        }

        skip = true;
      }

      if (!skip && settings.trace.video) console.log('Received non-skipped response:', requestDetails);
      scriptParams.params.hlsPlaylist = playlist;
      await this.responseRefining.execute(scriptParams);

      // Pair intercepted subtitles when applicable.
      if (playlist && settings.video.subtitles.intercept) await this.pairSubtitles();

      // We also intercept XMLHttpRequest, but we usually don't want them other
      // than to detect HLS: these are expected to be done by site script, e.g.
      // to get server information, or the player which is streaming.
      // So don't buffer these type of requests.
      if (!skip) skip = requestDetails.type === 'xmlhttprequest';
      if (!skip) {
        // Remember this response, in case an associated video source is added
        // later.
        this.getBufferedRequests(url).addResponse(response, location);
      }
      return;
    }

    if (source.hls) {
      // Belt and suspenders: urls associated to HLS playlist should be ignored
      // by now (master playlist and each stream), since we already did process
      // them.
      return;
    }

    if (settings.trace.video) console.log('Received source response:', requestDetails);
    await this.responseRefining.execute(scriptParams);

    // Remember actual url.
    // Notes:
    // We don't expect redirection responses to contain useful Content-Type or
    // Content-Disposition information. Often when there is a Content-Type it
    // has nothing to do with the URL the response redirects to. So we are done
    // with this response by taking into account the new url.
    if (location) {
      if (settings.debug.video) console.log(`Tab=<${response.tabId}> frame=<${response.frameId}> video source id=<${source.id}> url=<${source.url}> is redirected to=<${location}>`);
      source.setRedirection(location);
      // Note: we wait for the actual redirected URL request to refresh.
      return;
    }

    // Only process standard success code. This filters out errors and
    // non-standard successes.
    if ((statusCode !== 200) && (statusCode !== 206)) {
      if (settings.debug.video) console.log(`Not handling tab=<${response.tabId}> frame=<${response.frameId}> video source id=<${source.id}> response=<%o>: Response code=<${statusCode}> not managed`, response);
      return;
    }
    source.setCompleted();

    // Keep filename if given.
    source.setFilename(requestDetails.filename);
    // Keep content length if known.
    source.setSize(requestDetails.contentLength);
    // Guess content type if needed, based on the given filename (or url).
    requestDetails.contentType.guess(util.getFilename(source.getUrl(), source.filename), true);
    // Keep latest response mime type (possibly guessed).
    source.mimeType = requestDetails.contentType.mimeType;
    // Retrieved/actual information may differ from original ones. Check again
    // and ignore content types we don't want to download.
    const reason = checkVideoContentType(requestDetails.contentType);
    if (reason) return this.ignoreDownload(source, response, reason);

    // Keep ETag if any.
    source.etag = http.findHeaderValue(response.responseHeaders, 'ETag');
    // Merge same sources.
    this.mergeSources(source);

    // Refresh source if applicable (will be done elsewhere upon replaying) and
    // trigger videos update if we are the active tab.
    if (!response.replayed && (await source.refresh())) this.updateVideos();
  }

  // Takes into account given download information to ignore.
  // Note: we take advantage of the fact that both video source details and
  // http response contain the information we need, so that caller can pass
  // either one.
  ignoreDownload() {
    const args = [...arguments];
    let source, details, reason;
    if (args[0] instanceof VideoSource) [source, details, reason] = args;
    else [details, reason] = args;

    if (source) this.ignoreUrls(source.getUrls());
    else this.discardUrl(details.url);
    if (settings.debug.video) console.log(`Not handling tab=<${details.tabId}> frame=<${details.frameId}> video source id=<${source?.id}> url=<${details.url}>: ${reason}`);
  }

  discardUrl(url) {
    // First ingore url.
    this.ignoreUrl(url);
    // Also drop buffered requests if any, and ignore associated urls: useful
    // when we already received redirection responses.
    const buffered = this.getBufferedRequests(url, true);
    if (buffered) this.ignoreUrls(buffered.getUrls());
  }

  updateVideos() {
    const observer = this.parent.observer;
    if (!observer) return;
    observer.videosUpdated({
      tabHandler: this.tabHandler,
      sources: this.sources
    });
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

  constructor(webext, tabsHandler, menuHandler) {
    const self = this;
    self.webext = webext;
    self.tabsHandler = tabsHandler;
    self.menuHandler = menuHandler;
    // Buffered requests, per tab frame.
    self.bufferedRequests = {};

    // Setup our (bound to us) callbacks (used as listeners).
    // Note: we need those callbacks to remain the same so that we can remove
    // any listener that was previously added.
    self.listeners = {};
    ['onRequest', 'onResponse'].forEach(key => {
      self.listeners[key] = self[key].bind(self);
    });

    // Listen changes in interception settings to apply them.
    settings.video.inner.intercept.addListener((setting, oldValue, newValue) => {
      self.setupInterception();
    });
    self.setupInterception();
    tabsHandler.addObserver(self);
  }

  getBufferedRequests(tabId, frameId, remove) {
    let buffered = this.bufferedRequests[tabId];
    if (!buffered) {
      if (remove) return;
      buffered = this.bufferedRequests[tabId] = {};
    }
    buffered = buffered[frameId];
    if (!buffered) {
      if (remove) return;
      buffered = this.bufferedRequests[tabId][frameId] = new http.RequestBuffer();
    }
    if (remove) delete(this.bufferedRequests[tabId][frameId]);
    return buffered;
  }

  getTabHandler(details, create) {
    const self = this;
    const frameHandler = self.tabsHandler.getFrame(details);
    if (!frameHandler) return {};
    const handler = frameHandler.tabHandler.extensionProperties.get({
      key: TAB_EXTENSION_PROPERTY,
      create: create ? (tabHandler => new VideoSourceTabHandler(self, tabHandler)) : undefined,
      keepOnReset: true
    });
    return {
      handler,
      frameUrl: frameHandler.url
    };
  }

  getSources(tabHandler, sources) {
    if (!sources) {
      tabHandler = tabHandler || this.tabsHandler.focusedTab.handler;
      if (!tabHandler) return [];
      const handler = tabHandler.extensionProperties.get({key: TAB_EXTENSION_PROPERTY});
      if (!handler) return [];
      sources = handler.sources;
    }
    // Caller only cares about field values.
    // Trying to send VideoSource as message fails (cannot be cloned).
    // So create a dummy object with original fields except those that cannot be
    // cloned.
    return sources.map(source => source.forMessage());
  }

  async download(details, downloadDetails) {
    const { handler } = this.getTabHandler(details, false);
    if (!handler) {
      console.warn(`Cannot download video tab=<${details.tabId}> frame=<${details.frameId}>: Unknown tab frame`);
      return;
    }

    return await handler.download(details, downloadDetails);
  }

  async addSource(details) {
    // Normalize url.
    details.url = util.normalizeUrl(details.url, settings.debug.video, 'video source');
    // Ensure details match a known tab frame. If not, assume the frame was
    // changed (reset) since information was sent: ignore it.

    // Notes:
    // If we receive a source, it means the content script is running, and thus
    // this tab/frame *should* be known. If it isn't, we can only assume the
    // tab/frame did change after the information was sent.
    const { handler, frameUrl } = this.getTabHandler(details, true);
    if (!handler) {
      // Note: this is the only time we log the csUuid.
      // If we found the frame, then the csUuid matches, and there is no more
      // need to log it.
      if (settings.debug.video) console.log(`Not handling tab=<${details.tabId}> frame=<${details.frameId}> csUuid=<${details.csUuid}> video url=<${details.url}>: Unknown tab frame`);
      return;
    }
    details.frameUrl = frameUrl;

    return await handler.addSource(details);
  }

  async addSubtitles(details) {
    details.url = util.normalizeUrl(details.url, settings.debug.video, 'video source');

    const { handler, frameUrl } = this.getTabHandler(details, true);
    if (!handler) {
      if (settings.debug.video) console.log(`Not handling tab=<${details.tabId}> frame=<${details.frameId}> csUuid=<${details.csUuid}> video url=<${details.url}> subtitles: Unknown tab frame`);
      return;
    }
    details.frameUrl = frameUrl;

    return await handler.addSubtitles(details);
  }

  setupInterception() {
    // Check whether we now need to intercept anything
    const interceptVideo = settings.video.intercept;
    // Determine whether we were listening.
    const interceptingVideo = browser.webRequest.onSendHeaders.hasListener(this.listeners.onRequest);
    // Add/remove listeners as requested.
    if (interceptVideo && !interceptingVideo) {
      if (settings.debug.video) console.log('Installing video webRequest interception');
      // Notes:
      // We need to intercept media ('video' and 'audio' elements) and object
      // ('object' and 'embed' elements) requests.
      // 'embed' elements can indeed include video, for which requests are
      // typed as 'object' instead fo 'media'.
      // Example: https://developer.mozilla.org/fr/docs/Web/HTML/Element/embed
      // For HLS and subtitles, we also need to intercept xmlhttprequest, which
      // is usually done by site/player code.
      const webRequestFilter = { urls: ['<all_urls>'], types: ['media', 'object', 'xmlhttprequest'] };
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
    } else if (!interceptVideo && interceptingVideo) {
      if (settings.debug.video) console.log('Uninstalling video webRequest interception');
      browser.webRequest.onSendHeaders.removeListener(this.listeners.onRequest);
      browser.webRequest.onHeadersReceived.removeListener(this.listeners.onResponse);
    }
    // Cleanup resources when applicable.
    if (!interceptVideo) this.bufferedRequests = {};
  }

  async onRequest(request) {
    // Normalize url.
    request.url = util.normalizeUrl(request.url, settings.debug.video, 'request');
    const tabId = request.tabId;
    const frameId = request.frameId;
    const { handler } = this.getTabHandler({
      tabId,
      frameId
    }, true);
    if (!handler) {
      this.getBufferedRequests(tabId, frameId).addRequest(request);
      return;
    }

    await handler.onRequest(request);
  }

  async onResponse(response) {
    // Normalize url.
    response.url = util.normalizeUrl(response.url, settings.debug.video, 'response');
    const tabId = response.tabId;
    const frameId = response.frameId;
    const { handler } = this.getTabHandler({
      tabId,
      frameId
    }, true);
    if (!handler) {
      this.getBufferedRequests(tabId, frameId).addResponse(response);
      return;
    }

    await handler.onResponse(response);
  }

  // Tab/frame observer

  tabUpdated(details) {
    const tabId = details.tabId;
    const { handler } = this.getTabHandler({
      tabId,
      frameId: 0
    }, false);
    if (!handler) return;
    handler.tabUpdated(details);
  }

  tabReset(details) {
    // We don't know whether we can receive requests before frame content is
    // loaded. As a precaution, only take into account reset when frame is
    // about to change.
    if (!details.beforeNavigate) return;
    const { handler } = this.getTabHandler(details, false);
    if (!handler) return;
    handler.tabReset(details);
  }

  async frameAdded(details) {
    const tabId = details.tabId;
    const frameId = details.frameId;
    const buffered = this.getBufferedRequests(tabId, frameId, true);
    if (!buffered) return;
    // Process buffered requests.
    // Belt and suspenders: ensure we do know the frame now.
    const { handler } = this.getTabHandler({
      tabId,
      frameId
    }, true);
    if (!handler) {
      // Should not happen.
      console.log(`Tab=<${tabId}> frame=<${frameId}> is still unknown after being added: not replaying requests`);
      return;
    }
    await buffered.replay(this);
  }

  async tabRemoved(details) {
    const self = this;

    // To ensure we do remove menu entries even when closing the active tab,
    // to it in both situations if possible (tab handler known).
    if (details.tabHandler) {
      const handler = details.tabHandler.extensionProperties.get({key: TAB_EXTENSION_PROPERTY});
      if (handler) await handler.removeMenuEntries();
    }

    // As a precaution, wait a bit before clearing buffered requests, in case
    // we still receive some in parallel.
    setTimeout(() => {
      delete(self.bufferedRequests[details.tabId]);
    }, 1000);
  }

  frameRemoved(details) {
    const self = this;
    // As a precaution, wait a bit before clearing buffered requests, in case
    // we still receive some in parallel.
    setTimeout(() => {
      self.getBufferedRequests(details.tabId, details.frameId, true);
    }, 1000);
  }

  async tabFocused(details) {
    // Remove entries from previous focused tab, if there really was a change.
    // We still need to (re)apply the newly focused tab, because at the previous
    // change the handler may have been not known yet.
    if ((details.previousTabId !== details.tabId) && details.previousTabHandler) {
      const handler = details.previousTabHandler.extensionProperties.get({key: TAB_EXTENSION_PROPERTY});
      if (handler) await handler.removeMenuEntries();
    }

    // Add entries of new focused tab.
    if (!details.tabHandler) return;
    const handler = details.tabHandler.extensionProperties.get({key: TAB_EXTENSION_PROPERTY});
    if (handler) await handler.addMenuEntries();
  }

}
