'use strict';

import * as util from '../common/util.js';
import { settings } from '../common/settings.js';


// Notes:
// Instead of statically (through manifest) have content scripts loaded on
// pages, those (along with CSS) can be injected dynamically.
// webNavigation allows to finely follow tab frames changes, however:
//  - an existing tab can be reused for a brand new content: re-loading page
//    or navigating to a new page
//  - sub-frames content can also change
//  - even though code execution it mono-threaded, the use of Promises and
//    async/await make it so that callback/code can be executed while the
//    origin tab/frame is being/has been changed; akin to 'race conditions'
//
// We want to avoid injecting more than once the same script, which can lead
// to unexpected/unwanted results.
// Similarly, if a content script sends a message, we may want to know whether
// the sender page has been changed in-between in order to ignore it.
// A solution is to:
//  - setup frame by injecting a first common code with context that can probe
//    itself in case it is already present
//  - have content script fail if setup is missing: we assume the frame content
//    has changed in-between, requiring to re-setup the frame
//  - generate a new UUID for each new injected context
//  - remember previously injected scripts, until frame content changes
// Since we may have to deal with frames other than the main one in tabs, we
// manage this at the frame level; as a special case, a tab is actually
// represented by its main (id 0) frame.
// To avoid 'race conditions' (due to asynchronous execution), we also ensure
// script injection is done sequentially, so that we can more finely react when
// frame content changes.
//
// Dynamically injecting content script only make code executed slightly later
// (in a barely visible way when navigating) compared to static declaration.

class FrameHandler {

  constructor(tabHandler, details) {
    this.tabHandler = tabHandler;
    this.id = details.frameId;
    this.used = false;
    this.reset(details);
  }

  // Resets frame, which is about to be (re)used.
  reset(details) {
    this.url = details.url;
    // For each script (id), remember the associated promise, resolved with its
    // injection success and result/error.
    this.scripts = {};
    if (!this.cleared) this.actionNext = [];
  }

  // Clears frame, which is about to be removed.
  clear() {
    // Code being executed asynchronously (async functions, or right after an
    // await statement) have to check whether 'cleared' has been set.
    this.cleared = true;
    // Belt and suspenders: remove actionNext entirely, to prevent any other
    // action to be queued/executed. (code is expected to check cleared
    // before using it)
    for (var action of this.actionNext) {
      action.deferred.reject('Frame has been cleared');
    }
    delete(this.actionNext);
  }

  // Queue a new action to execute sequentially.
  async newAction(callback) {
    if (this.cleared) return;
    var entry = {
      callback: callback,
      deferred: new util.Deferred()
    };
    this.actionNext.push(entry);
    this.nextAction();
    return await entry.deferred.promise;
  }

  // Executes pending actions sequentially.
  nextAction() {
    var self = this;
    // Let current action end if any.
    if (self.actionRunning !== undefined) return;
    // Get next action if any.
    if (self.cleared) return;
    var next = self.actionNext.shift();
    if (next === undefined) return;
    // Trigger callback, and complete its promise.
    self.actionRunning = next.deferred.promise;
    next.deferred.completeWith(next.callback);
    // Once done, execute next action if any.
    self.actionRunning.finally(() => {
      delete(self.actionRunning);
      self.nextAction();
    });
  }

  async setup() {
    var tabId = this.tabHandler.id;
    var frameId = this.id;

    // Probe the frame: inject some context (prepare a new UUID) and check
    // whether there already/still is a previous context.
    // If there is a previous context: page has not changed.
    // If there is no previous context: use the new one.
    // In either case, we should be only called right upon setting up the first
    // script, in which case there is nothing much to do in either situation.
    var newUuid = util.uuidv4();
    const csParams = {
      tabId: tabId,
      frameId: frameId,
      uuid: newUuid
    };
    var details = {
      frameId: frameId,
      code: `if (csParams === undefined) {
  var csParams = ${JSON.stringify(csParams)};
  var result = { uuid: csParams.uuid, existed: false, url: location.href };
} else result = { uuid: csParams.uuid, existed: true, url: location.href };
result;`,
      runAt: 'document_start'
    };

    // Notes:
    // Injection may fail if we are not permitted to execute script in the
    // frame. In this case, we usually get the error:
    //  Frame not found, or missing host permission
    // In may happen in various cases:
    //  - '<all_urls>' not used in permissions
    //  - frame is 'about:blank' and we did not enable matchAboutBlank
    //  - frame is privileged; this is e.g. the case for PDF files displayed
    //    with PDF.js by Firefox
    // Caller is expected to exclude those cases.
    var reused = this.used;
    try {
      var result = (await browser.tabs.executeScript(tabId, details))[0];
      if (settings.debug.misc) console.log('Tab=<%s> frame=<%s> scripts existed=<%s> uuid=<%s>', tabId, frameId, result.existed, result.uuid);
      this.used = true;
       // Use our brand new uuid when applicable.
      if (!result.existed) this.uuid = newUuid;
      // Refresh our url.
      this.url = result.url;
      // We should have our known uuid (previous one, or brand new).
      if (result.uuid !== this.uuid) console.log('Tab=<%s> frame=<%s> already had been initialised with uuid=<%s> instead of uuid=<%s>', tabId, frameId, result.uuid, this.uuid);
      return {
        reused: reused,
        success: true,
        existed: result.existed
      };
    } catch (error) {
      console.log('Failed to setup tab=<%s> frame=<%s>: %o', tabId, frameId, error);
      return {
        reused: reused,
        success: false,
        existed: false
      };
    }
  }

  async setupScript(id, callback) {
    var self = this;
    return await self.newAction(() => {
      return self._setupScript(id, callback)
    });
  }

  // Setups script (to inject).
  // When applicable, injection is done through callback.
  // If script (id) is already injected, return the previously associated
  // promise.
  //
  // We take care of possible situations relatively to frame being updated
  // after script setup was queued and before its execution completes.
  // In all cases:
  //  - 'reset' is called right upon change; it clears any previously pending
  //    actions, and resets known injected scripts
  //  - caller is notified of change and will re-setup scripts if applicable;
  //    this can only happen after this script setup completes.
  //
  // 1. If frame is updated right before execution
  // Frame setup will be done before script setup. At 'worst':
  //  - script is not meant for the page after change, but should cope with it
  //  - caller will try to setup script again, which we will dismiss because
  //    already done
  //
  // 2. If frame is updated after frame setup check and before script injection
  // This script setup will fail due to missing frame setup.
  async _setupScript(id, callback) {
    var self = this;
    var tabHandler = self.tabHandler;
    var tabId = tabHandler.id;
    var frameId = self.id;

    if (self.cleared) return;
    // Setup frame for first script.
    if (Object.keys(self.scripts).length == 0) {
      var setup = await self.setup();
      if (self.cleared) return;
      if (!setup.existed && setup.reused) {
        // Frame did change.
        // There is no sure way to known it this script setup was requested
        // before the frame changed, or because of it; only when frame has not
        // been used can we assume it's its very first setup.
        // In all cases, go on with the script setup.
        // Also, do not touch 'actionNext': reset does clear it; any pending
        // action are scripts re-setup added by caller after reset.
        if (settings.debug.misc) console.log('Tab=<%s> frame=<%s> uuid=<%s> has been updated', tabId, frameId, self.uuid);
        // Notes:
        // Going on is the best approach.
        // If frame setup could be done, we will inject this script (and
        // possibly others pending).
        // If frame setup failed, we don't expect any other injection to
        // succeed. This would trigger multiple error logs though: for each
        // other script setup, we will re-try to setup frame.
        // In particular, upon issue it is not a good idea to call 'frameCb'
        // without other kind of hinting, as it would end in an endless
        // injection attempts loop:
        //  1. first script setup triggers frame setup, which fails
        //  2. we call frameCb, which queues a new script setup
        //  3. we got back to 1.
      }
    }
    // Nothing to do if script already setup.
    if (self.scripts[id] !== undefined) {
      if (settings.debug.misc) console.log('Tab=<%s> frame=<%s> uuid=<%s> already has script=<%s>', tabId, frameId, self.uuid, id);
      return self.scripts[id];
    }
    self.scripts[id] = callback().then(result => {
      if (settings.debug.misc) console.log('Set up script=<%s> in tab=<%s> frame=<%s> uuid=<%s>: %o', id, tabId, frameId, self.uuid, result);
      return {
        success: true,
        result: result
      };
    }).catch(error => {
      // Script injection actually failed: forget it, so that it can be injected
      // again if needed.
      delete(self.scripts[id]);
      console.log('Failed to setup script=<%s> in tab=<%s> frame=<%s> uuid=<%s>: %o', id, tabId, frameId, self.uuid, error);
      return {
        success: false,
        error: error
      };
    });
    return await self.scripts[id];
  }

}

class TabHandler {

  constructor(tab, frameCb) {
    this.id = tab.id;
    this.frameCb = frameCb;
    this.frames = {};
  }

  url() {
    return this.frameHandler.url;
  }

  // Clears tab, which is about to be removed.
  clear() {
    // Code being executed asynchronously (async functions, or right after an
    // await statement) have to check whether 'cleared' has been set.
    this.cleared = true;
    for (var frameHandler of Object.values(this.frames)) {
      frameHandler.clear();
    }
    this.frames = {};
  }

  async findFrames() {
    var self = this;
    await browser.webNavigation.getAllFrames({tabId: self.id}).then(frames => {
      for (var details of frames) {
        // Ignore 'about:blank' etc.
        if (!details.url.startsWith('http') && !details.url.startsWith('file')) continue;
        // Don't add frames we already known about: frames are only searched
        // when extension starts and is processing existing tabs. If a frame is
        // already known, we assume we were notified of its change before we
        // could explicitely add the tab: there is nothing else to do, as
        // scripts setup is already being done.
        self.addFrame(details, {skipExisting: true});
      }
    });
  }

  addFrame(details, params) {
    if (this.cleared) return;
    params = params || {};
    var frameId = details.frameId;
    var frameHandler = this.frames[frameId];
    if (frameHandler !== undefined) {
      // If requested, skip processing existing frame.
      if (params.skipExisting) return;
      // Frame is being reused: reset it.
      frameHandler.reset(details);
    } else {
      // New frame.
      frameHandler = new FrameHandler(this, details);
      if (settings.debug.misc) console.log('Managing new tab=<%s> frame=<%s> url=<%s>', this.id, frameId, frameHandler.url);
      this.frames[frameId] = frameHandler;
      if (frameId === 0) this.frameHandler = frameHandler;
    }
    // Let caller setup scripts if applicable.
    this.frameCb(this, frameHandler);
  }

  resetFrame(details) {
    var frameId = details.frameId;
    var frameHandler = this.frames[frameId];
    // We are called ahead of time, before frame content is actually loaded.
    // We can ignore unknown frames, for which 'addFrame' will be called later.
    if (frameHandler === undefined) return;
    frameHandler.reset(details);
    if (frameId === 0) {
      // If the main frame is being changed, all subframes are to be removed.
      for (var frameHandler of Object.values(this.frames)) {
        if (frameHandler.id === 0) continue;
        if (settings.debug.misc) console.log('Removing tab=<%s> frame=<%s>', this.id, frameHandler.id);
        frameHandler.clear();
        delete(this.frames[frameHandler.id]);
      }
    }
  }

}

export class TabsHandler {

  constructor(frameCb) {
    this.tabs = {};
    this.frameCb = frameCb;
  }

  // Adds tab and return tab handler.
  // If tab is known, existing handler is returned.
  async addTab(tab, findFrames) {
    var tabHandler = this.tabs[tab.id];
    if (tabHandler !== undefined) return tabHandler;

    if (settings.debug.misc) console.log('Managing new tab=<%s> url=<%s>', tab.id, tab.url);
    this.tabs[tab.id] = tabHandler = new TabHandler(tab, this.frameCb);
    if (findFrames) await tabHandler.findFrames();
    return tabHandler;
  }

  // Adds frame and return frame handler.
  // If frame is known, existing handler is returned.
  // If tab is not yet known and this is its main frame, tab is added first.
  // If tab is not known and this is a subframe, frame is not added.
  async addFrame(details, params) {
    var self = this;
    var tabId = details.tabId;
    var tabHandler = self.tabs[tabId];
    if (tabHandler === undefined) {
      // Tab is unknown.
      // If this is the main frame, we will manage this new tab.
      // Otherwise, ignore this frame: we expect to be notified of a subframe
      // change before caller had time to initiate itself and get all current
      // tabs (and add associated frames).
      if (details.frameId !== 0) return;
      // Tab is not known yet, add it first.
      tabHandler = await browser.tabs.get(tabId).then(tab => {
        return self.addTab(tab);
      }, error => {
        console.log('Could not manage tab=<%s>: %o', tabId, error);
      });
    }
    if (tabHandler === undefined) return;
    return await tabHandler.addFrame(details, params);
  }

  resetFrame(details) {
    var tabHandler = this.tabs[details.tabId];
    if (tabHandler === undefined) return;
    tabHandler.resetFrame(details);
  }

  removeTab(tabId) {
    var tabHandler = this.tabs[tabId];
    if (tabHandler === undefined) return;
    if (settings.debug.misc) console.log('Removing tab=<%s>', tabHandler.id);
    tabHandler.clear();
    delete(this.tabs[tabId]);
  }

}
