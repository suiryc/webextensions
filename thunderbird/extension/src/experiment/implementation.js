"use strict";

// See the official examples:
//  - https://github.com/thunderbird/webext-examples/tree/master/manifest_v2/experiment
//  - https://github.com/thunderbird/webext-examples/tree/master/manifest_v3/experiment

// Using a closure to not leak anything but the API to the outside world.
(function (exports) {

  // Whether to log some debugging information.
  let debug = {
    setup: false,
    refresh: false
  };

  // Get 'calFilter', needed to build our own filter.
  Services.scriptloader.loadSubScript('chrome://calendar/content/widgets/calendar-filter.js');

  // Get calendar utils.
  let { cal } = ChromeUtils.importESModule('resource:///modules/calendar/calUtils.sys.mjs');

  // Id of the filter node we add.
  const FILTER_ALL_ID = 'event-filter-swe-all';
  // Id of the filter menupopup node.
  const EVENT_FILTER_MENUPOPUP_ID = 'event-filter-menupopup';

  // Context passed to experiment.
  // Gives access to some useful tools.
  // See: https://webextension-api.thunderbird.net/en/128-esr-mv3/experiments/tabs_and_windows.html
  let ctx = undefined;
  // Whether our entry is chosen by default.
  let chosen = undefined;

  // Listener used to pass filter selection change to the background script.
  class FilterListener extends ExtensionCommon.EventEmitter {

    constructor(extension) {
      super();
      this.extension = extension;
      this.callbackCount = 0;
    }

    get listenerId() {
      return `experiment_listener_${this.extension.uuid}_${this.extension.instanceId}`;
    }

    trigger(v) {
      // Nothing to do if there is no change.
      if (chosen === v) return;

      // Remember the change here.
      chosen = v;

      // Emit "filter-changed" with value to the registered callbacks.
      filterListener.emit('filter-changed', v);
    }

    add(callback) {
      // Registering the callback for "filter-changed".
      this.on('filter-changed', callback);
    }

    remove(callback) {
      // Un-Registering the callback for "filter-changed".
      this.off('filter-changed', callback);
    }

  }
  // The variable for our FilterListener instance.
  // Since we need the extension object, we cannot create it here directly.
  let filterListener;

  function getWindow(windowId) {
    try {
      return ctx.extension.windowManager.get(windowId)?.window;
    } catch (error) {
      console.log(`Failed to get window=<${windowId}>:`, error);
    }
  }

  function processWindows(callback) {
    // Process all normal windows (i.e. 'mail:3pane').
    for (let win of Array.from(Services.wm.getEnumerator('mail:3pane'))) {
      // Nothing to do if window is closed.
      if (win.closed) continue;
      callback(win);
    }
  }

  // The main class of the experiment implementation.
  class SuirycWebExt extends ExtensionCommon.ExtensionAPIPersistent {

    constructor(extension) {
      super(extension);
      filterListener = new FilterListener(extension);
    }


    PERSISTENT_EVENTS = {
      // For primed persistent events (deactivated background), the context is
      // only available after fire.wakeup() has fulfilled (ensuring the convert()
      // function has been called).

      onFilterChanged({ context, fire }) {
        const { extension } = this;

        // In this function we add listeners for any events we want to listen to,
        // and return a function that removes those listeners. To have the event
        // fire in your extension, call fire.async.
        async function callback(event, v) {
          if (fire.wakeup) {
            await fire.wakeup();
          }
          return fire.async(v);
        }
        filterListener.add(callback);

        return {
          unregister: () => {
            filterListener.remove(callback);
          },
          convert(newFire, extContext) {
            fire = newFire;
            context = extContext;
          },
        };
      }
    }

    getAPI(context) {
      let self = this;
      ctx = context;
      // See: https://developer.thunderbird.net/add-ons/mailextensions/experiments#managing-your-experiments-lifecycle
      context.callOnClose(self);
      return {
        SuirycWebExt: {

          setup: function(v) {
            // Get 'chosen' state the first time we are called.
            // If we are called later, we are the one indicating whether it
            // changes, so we are more up-to-date than the background script.
            if (chosen === undefined) chosen = v;
          },

          setupWindow: function(windowId) {
            self.#setupWindow(windowId);
          },

          onFilterChanged: new ExtensionCommon.EventManager({
            context,
            module: 'SuirycWebExt',
            event: 'onFilterChanged',
            extensionApi: this
          }).api()

        }
      }

    }

    // Mandatory.
    onStartup() {
    }

    onShutdown(isAppShutdown) {
      let self = this;
      // This function is called if the extension is disabled or removed, or
      // Thunderbird closes. We usually do not have to do any cleanup, if
      // Thunderbird is shutting down entirely.
      if (isAppShutdown) return;

      // Add-on is unloaded.
      // As per specs, flush all caches.
      // See: https://developer.thunderbird.net/add-ons/mailextensions/experiments#managing-your-experiments-lifecycle
      Services.obs.notifyObservers(null, 'startupcache-invalidate', null);

      // Reset all (setup) windows.
      processWindows(win => {
        self.#resetWindow(win);
      });
    }

    // Mandatory.
    close() {
    }

    #setupWindow(windowId, attempt=1) {
      let self = this;

      // Nothing to do if setup already done here.
      let win = getWindow(windowId);
      if (!win) return;
      if (win.swe_setup) {
        if (debug.setup) console.log(`Window=<${windowId}> already setup:`, win);
        return;
      }
      if (debug.setup) console.log(`Setup window=<${windowId}>:`, win);

      // Nothing much to do if the menu popup is not there.
      // And if the calendar tab is opened upon startup (that is it was left
      // opened at latest shutdown), sometimes the filtered view has not been
      // created yet.
      // Retry a few times in this case.
      let menupopup = win.document.getElementById(EVENT_FILTER_MENUPOPUP_ID);
      let filteredView = win.getUnifinderView();
      function retry() {
        if (attempt < 10) {
          if (debug.setup) console.log(`Retrying window=<${windowId}> (attempt=${attempt+1}) later ...`);
          setTimer(() => {
            self.#setupWindow(windowId, attempt + 1);
          }, 300);
        }
      }
      if (!menupopup) {
        if (debug.setup) console.log(`Window=<${windowId}> has no filter menu popup`);
        retry();
        return;
      }
      if (!filteredView) {
        if (debug.setup) console.log(`Window=<${windowId}> has no filtered view`);
        retry();
        return;
      }

      // Belt and suspenders: reset anything already setup.
      // Should not be necessary in normal case, as we only setup these once.
      try {
        self.#resetWindow(win);
      } catch (error) {
        console.log(`Failed to reset window=<${windowId}> before setup:`, error);
      }

      // Add '*' entry.
      let node = menupopup.firstChild.cloneNode(true);
      node.id = FILTER_ALL_ID;
      node.value = 'swe-all';
      node.setAttribute('data-l10n-id', 'calendar-event-listing-interval-item');
      node.label = '*';
      node.firstChild.nextSibling.value = '*';
      menupopup.appendChild(node);

      // Override the concerned objects/methods.
      // (see below for details)
      new SWE_CalendarFilteredTreeView(filteredView, windowId).setup();
      new SWE_Window(win, windowId).setup();
      // It happens that the original method 'refreshUnifinderFilterInterval'
      // was already registered as 'dayselect' event listener callback.
      // https://hg.mozilla.org/comm-unified/file/THUNDERBIRD_128_2_0esr_RELEASE/calendar/base/content/calendar-unifinder.js#l67
      //
      // This is important e.g., when switching a tab to a new window, then
      // opening the calendar tab in this new window:
      // 1. The code switches to calendar mode
      //   https://hg.mozilla.org/comm-unified/file/THUNDERBIRD_128_2_0esr_RELEASE/calendar/base/content/calendar-tabs.js#l52
      // 2. Which wants to re-set the last calendar view mode (month, week, ...)
      //   https://hg.mozilla.org/comm-unified/file/THUNDERBIRD_128_2_0esr_RELEASE/calendar/base/content/calendar-modes.js#l88
      // 3. Which does want to select the current day
      //   https://hg.mozilla.org/comm-unified/file/THUNDERBIRD_128_2_0esr_RELEASE/calendar/base/content/calendar-views-utils.js#l291
      // 4. Which changes the calendar selected day
      //   https://hg.mozilla.org/comm-unified/file/THUNDERBIRD_128_2_0esr_RELEASE/calendar/base/content/calendar-views.js#l175
      // 5. Which does trigger the 'dayselect' event
      //   https://hg.mozilla.org/comm-unified/file/THUNDERBIRD_128_2_0esr_RELEASE/calendar/base/content/calendar-month-view.js#l566
      // 6. Which does call the listener callback, and trigger an error because
      //    since our entry is selected, the original code will try to set an
      //    undefined 'startDate'.
      // 
      // Thus, replace the listener callback with ours.
      let viewBox = win.getViewBox()
      if (viewBox) {
        if (debug.setup) console.log(`Replacing window=<${windowId}> ViewBox listener`);
        viewBox.removeEventListener('dayselect', win.__swe__.refreshUnifinderFilterInterval);
        viewBox.addEventListener('dayselect', win.refreshUnifinderFilterInterval);
      }

      // We are done with this window.
      win.swe_setup = true;

      // Select our node when appropriate, so that events filtering takes place.
      if (chosen) {
        if (debug.setup) console.log(`Auto-selecting window=<${windowId}> '*' entry`);
        // Invalidating right now is useful if calendar tab is already opened
        // upon startup, otherwise often the list won't be refreshed: the view
        // is already 'active' so the overridden code (see below) won't
        // invalidate it there.
        filteredView.invalidate();
        node.click();
      }
    }

    #resetWindow(win) {
      // Remove entries we setup, and restore original methods/listeners.
      let windowId = ctx.extension.windowManager.getWrapper(win).id;
      let menupopup = win.document.getElementById(EVENT_FILTER_MENUPOPUP_ID);
      if (menupopup) {
        for (let node of win.document.querySelectorAll(`[id="${FILTER_ALL_ID}"]`)) {
          if (debug.setup) console.log(`Removing window=<${windowId}> filter menu popup entry=<${FILTER_ALL_ID}>`);
          menupopup.removeChild(node);
        }
      }

      if (win.__swe__) {
        let viewBox = win.getViewBox()
        if (viewBox) {
          if (debug.setup) console.log(`Restoring window=<${windowId}> ViewBox listener`);
          viewBox.removeEventListener('dayselect', win.refreshUnifinderFilterInterval);
          viewBox.addEventListener('dayselect', win.__swe__.refreshUnifinderFilterInterval);
        }

        Override.reset(win);
      }

      Override.reset(win.getUnifinderView());

      delete(win.swe_setup);
    }

  };

  // The original code does create a private filter instance, then use it to
  // get matching events from calendars.
  // https://hg.mozilla.org/comm-unified/file/THUNDERBIRD_128_2_0esr_RELEASE/calendar/base/content/widgets/calendar-filter.js#l1036
  // While the start/end date parameters can be set through the parent view
  // object, other inner properties cannot.
  // In order to prevent event occurrences to be returned, we need to set a
  // specific filter inner property: the only way to achieve this is to create
  // our own filter instance, and use it to filter events in calendars.
  //
  // The first concerned method is 'refreshUnifinderFilterInterval', called
  // whenever a new filter menu entry is selected.
  // The other important method is 'CalendarFilteredTreeView.refreshItems', as
  // is called in many situations (refreshUnifinderFilterInterval included).

  class Override {

    constructor(wrapped) {
      if (!wrapped || wrapped.__swe__) return;
      this.className = this.constructor.name;
      if (debug.setup) console.log(`[${this.className}] Setup override`);
      this.wrapped = wrapped;
      wrapped.__swe__ = this;
      this.overridden = [];
    }

    override(name, target, originalUnbound) {
      let self = this;
      let wrapped = self.wrapped;
      let original = wrapped[name];
      if (debug.setup) console.log(`[${this.className}] Override method=<${name}> (original exists=<${!!original}> unbound=<${!!originalUnbound}>)`);
      // Don't forget to 'bind' so 'this' is as expected.
      // Don't do it on original method when asked.
      try {
        if (original) self[name] = originalUnbound ? original : original.bind(wrapped);
        wrapped[name] = target[name].bind(wrapped);
        self.overridden.push(name);
      } catch(error) {
        console.log(`[${this.className}] Failed to override method=<${name}>:`, error);
      }
    }

    setup() {
    }

    reset() {
      let self = this;
      let wrapped = self.wrapped;
      for (let name of self.overridden) {
        let original = self[name];
        if (debug.setup) console.log(`[${this.className}] Reset method=<${name}> (exists=${!!original}) override`);
        if (original) {
          wrapped[name] = original;
        } else {
          delete(wrapped[name]);
        }
      }
      self.overridden = [];
      delete(wrapped.__swe__);
    }

    static reset(wrapped) {
      if (!wrapped || !wrapped.__swe__) return;
      wrapped.__swe__.reset();
    }

  }

  class SWE_CalendarFilteredTreeView extends Override {

    constructor(wrapped, windowId) {
      super(wrapped);
      this.windowId = windowId;
      this.cleared = false;
    }

    setup() {
      this.override('invalidate', SWE_CalendarFilteredTreeView);
      this.override('refreshItems', SWE_CalendarFilteredTreeView);
      this.override('clearItems', SWE_CalendarFilteredTreeView);
    }

    // Inject helper method to invalidate view.
    static invalidate() {
      let self = this;
      let swe = self.__swe__;

      // The easiest way to invalidate the view is to change (then reset) the
      // filtered item type.
      let itemType = self.itemType;
      self.itemType = 0;
      self.itemType = itemType;
      if (debug.refresh) console.log(`Invalidated windowId=<${swe.windowId}> event filter view`);
    }

    // Override the original method in charge of getting filtered events from
    // calendars.
    // Part of the 'CalendarFilteredTreeView' class:
    // https://hg.mozilla.org/comm-unified/file/THUNDERBIRD_128_2_0esr_RELEASE/calendar/base/content/calendar-unifinder.js#l58
    // https://hg.mozilla.org/comm-unified/file/THUNDERBIRD_128_2_0esr_RELEASE/calendar/base/content/widgets/calendar-filter-tree-view.js#l7
    // https://hg.mozilla.org/comm-unified/file/THUNDERBIRD_128_2_0esr_RELEASE/calendar/base/content/widgets/calendar-filter.js#l1209
    static refreshItems() {
      let self = this;
      let swe = self.__swe__;

      // Unlike original code, we cannot properly create a refresh job.
      // We can only create our own filter (the main purpose of this extension),
      // get matching events (*without* occurrences) from calendars, and add
      // them in the viewed list.
      // But simply doing this triggers undesirable side-effects: when selecting
      // an event in the list, if the associated date is not visible in the
      // current calendar view, it will be refreshed to show the correct day,
      // and 'refreshItems' will be called again.
      // The original code handles multiple situation (refresh already ongoing,
      // etc.) through private state fields. To piggy-back original behaviour
      // as much as possible:
      // 1. Call original code unconditionally
      // 2. If our entry was not chosen, do nothing more, or
      // 3. If we detect list was not refreshed, do nothing more either, or
      // 4. Wait for current refresh to finish, then do our filtering to
      //    populate the list, and return this promise to caller
      //
      // This allows us to somehow ride on the inner job created for a normal
      // refresh. We simply ensure that only one day (the current one) is
      // selected so that original code is quickly done and we can do ours
      // without too much visual glitches.

      // We will detect whether items were cleared: that's the sign an actual
      // refresh job was triggered.
      self.cleared = false;
      let p0 = swe.refreshItems(...arguments);
      if (!chosen || !self.cleared) {
        if (debug.refresh) console.log(`Using only nominal refresh: windowId=<${swe.windowId}> chosen=<${chosen}> cleared=<${self.cleared}>`);
        return p0;
      }
      if (debug.refresh) console.log(`Performing windowId=<${swe.windowId}> non-occurrences event filtering`);

      let filter = new calFilter();
      // We filter events, as original code.
      // https://hg.mozilla.org/comm-unified/file/THUNDERBIRD_128_2_0esr_RELEASE/calendar/base/content/calendar-unifinder.js#l59
      filter.itemType = Ci.calICalendar.ITEM_FILTER_TYPE_EVENT;

      // Prepare today 'date' (we want the whole day, not an exact time).
      let today = cal.dtz.now();
      today.isDate = true;

      // Get events from 100 years past and future around today.
      filter.startDate = today.clone();
      filter.startDate.year -= 100;
      filter.startDate.makeImmutable();
      filter.endDate = today.clone();
      filter.endDate.year += 100;
      filter.endDate.makeImmutable();
      // Most importantly: *DO NOT* get occurrences, only the base events.
      // Setting 'occurrences' in filter properties overrides default behaviour
      // which is to get occurrences.
      // https://hg.mozilla.org/comm-unified/file/THUNDERBIRD_128_2_0esr_RELEASE/calendar/base/content/widgets/calendar-filter.js#l122
      // https://hg.mozilla.org/comm-unified/file/THUNDERBIRD_128_2_0esr_RELEASE/calendar/base/content/widgets/calendar-filter.js#l981
      // e.g. see in-memory usage of this property:
      // https://hg.mozilla.org/comm-unified/file/THUNDERBIRD_128_2_0esr_RELEASE/calendar/providers/memory/CalMemoryCalendar.sys.mjs#l368
      filter.mFilterProperties.occurrences = filter.mFilterProperties.FILTER_OCCURRENCES_NONE;

      // Now, we basically do the same as original code, but with our own filter.
      // See:
      // https://hg.mozilla.org/comm-unified/file/THUNDERBIRD_128_2_0esr_RELEASE/calendar/base/content/widgets/calendar-filter.js#l1227
      // https://hg.mozilla.org/comm-unified/file/THUNDERBIRD_128_2_0esr_RELEASE/calendar/base/content/widgets/calendar-filter.js#l1286

      // Wait for the current job to be done (it is adding items in the list).
      return p0.then(() => {
        // Clear the list.
        self.clearItems();
        // Loop on calendars.
        let promises = [];
        for (let calendar of cal.manager.getCalendars()) {
          // Skip non-existing/disabled calendars.
          if (!calendar) continue;
          if (calendar.getProperty('disabled') || !calendar.getProperty('calendar-main-in-composite')) continue;
          // Filter items in calendar, and populate list.
          let iterator = cal.iterate.streamValues(filter.getItems(calendar));
          let p = Array.fromAsync(iterator).then(items => {
            self.addItems(items.flat());
          });
          promises.push(p);
        }
        // Return promise completed when done with calendars.
        return Promise.all(promises);
      });
    }

    static clearItems() {
      this.cleared = true;
      return this.__swe__.clearItems();
    }

  }

  class SWE_Window extends Override {

    constructor(wrapped, windowId) {
      super(wrapped);
      this.windowId = windowId;
    }

    setup() {
      // Binds the window to the method, so that we know which one to work on.
      // But DO NOT bind original method, because we need it untouched to be
      // able to remove it from a listener.
      this.override('refreshUnifinderFilterInterval', SWE_Window, true);
    }

    // Override the original method used when changing the selected event filter
    // (start/end date selection).
    // Original method is a global one:
    // https://hg.mozilla.org/comm-unified/file/THUNDERBIRD_128_2_0esr_RELEASE/calendar/base/content/calendar-unifinder.js#l251
    static refreshUnifinderFilterInterval() {
      let win = this;
      let swe = win.__swe__;

      // Don't bother if the view is not present.
      let filteredView = win.getUnifinderView();
      if (!filteredView) {
        if (debug.refresh) console.log(`Skipping windowId=<${swe.windowId}> filtering refresh: unexsinting filtered view`);
        return;
      }

      let intervalSelectionElem = win.document.getElementById('event-filter-menulist').selectedItem;
      if (intervalSelectionElem.id == FILTER_ALL_ID) {
        if (debug.refresh) console.log(`Triggered windowId=<${swe.windowId}> '*' event filter (switch=<${!chosen}>)`);
        // We were chosen.
        if (!chosen || !filteredView.isActive) {
          // Reset start/end date to today.
          // We do this only when switching (from nominal filtering) or when
          // the view is actually inactive.
          // In any case, this is because refreshing will first do a nominal
          // start/end date filtering: we limit it to the bare minimum. These
          // dates won't change until another event filter is selected.
          // The latter case is useful when the window is created: start/end are
          // initially undefined, and until set 'refreshItems' will no nothing.
          // As for invalidation, we *MUST NOT* do it unconditionally because
          // each time a different day is selected in the calendar, we are
          // called again: original code does nothing because nothing was
          // invalided in-between.
          let today = cal.dtz.now();
          today.isDate = true;
          filteredView.startDate = today;
          filteredView.endDate = today;
          // Also ensure the view is invalidated.
          filteredView.invalidate();
        }
        filterListener.trigger(true);
        // We only need to refresh items: the overridden method will do the rest.
        filteredView.refreshItems();
      } else {
        if (debug.refresh) console.log(`Triggered windowId=<${swe.windowId}> nominal=<${intervalSelectionElem.value}> event filter (switch=<${chosen}>)`);
        // Another entry was selected.
        if (chosen) {
          // Ensure the filter view is invalidated.
          filteredView.invalidate();
        }
        filterListener.trigger(false);
        // Use original method.
        swe.refreshUnifinderFilterInterval();
      }
    }

  }

  // Export the api by assigning in to the exports parameter of the anonymous
  // closure function, which is the global this.
  exports.SuirycWebExt = SuirycWebExt;

})(this);
