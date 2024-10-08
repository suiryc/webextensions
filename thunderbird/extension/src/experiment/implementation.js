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
  let { setTimeout } = ChromeUtils.importESModule('resource://gre/modules/Timer.sys.mjs');

  // 'event-filter-' node id prefix.
  const EVENT_FILTER_ID_PREFIX = 'event-filter-';
  const buildEventFilterId = suffix => `${EVENT_FILTER_ID_PREFIX}${suffix}`;
  // Id of the filter node we add.
  const EVENT_FILTER_SWE_ALL_ID_SUFFIX = 'swe-all';
  const EVENT_FILTER_SWE_ALL_ID = buildEventFilterId(EVENT_FILTER_SWE_ALL_ID_SUFFIX);
  // Id of the filter menulist node.
  const EVENT_FILTER_MENULIST_ID = buildEventFilterId('menulist');
  // Id of the filter menupopup node.
  const EVENT_FILTER_MENUPOPUP_ID = buildEventFilterId('menupopup');
  // Ids (suffix) to keep (in order) in filter menupop node.
  // Original order:
  //  - past
  //  - today
  //  - next7days
  //  - next14Days
  //  - next31Days
  //  - next6Months
  //  - next12Months
  //  - thisCalendarMonth
  //  - current: selected day
  //  - currentview: calendar view
  //  - all
  // https://hg.mozilla.org/comm-unified/file/THUNDERBIRD_128_2_3esr_RELEASE/calendar/base/content/calendar-tab-panels.inc.xhtml#l137
  const EVENT_FILTER_MENUPOPUP_IDS = [
    EVENT_FILTER_SWE_ALL_ID_SUFFIX,
    'today',
    'next7days',
    'next31Days',
    'next12Months',
    'current',
    'currentview'
  ];

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
          setTimeout(() => {
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

      // Override the concerned objects/methods.
      // (see below for details)
      let swe_menupopup = new SWE_MenuPopup(menupopup, windowId).setup();
      let swe_filteredView = new SWE_CalendarFilteredTreeView(filteredView, windowId).setup();
      let swe_win = new SWE_Window(win, windowId).setup();
      // It happens that the original method 'refreshUnifinderFilterInterval'
      // was already registered as 'dayselect' event listener callback.
      // https://hg.mozilla.org/comm-unified/file/THUNDERBIRD_128_2_3esr_RELEASE/calendar/base/content/calendar-unifinder.js#l67
      //
      // This is important e.g., when switching a tab to a new window, then
      // opening the calendar tab in this new window:
      // 1. The code switches to calendar mode
      //   https://hg.mozilla.org/comm-unified/file/THUNDERBIRD_128_2_3esr_RELEASE/calendar/base/content/calendar-tabs.js#l52
      // 2. Which wants to re-set the last calendar view mode (month, week, ...)
      //   https://hg.mozilla.org/comm-unified/file/THUNDERBIRD_128_2_3esr_RELEASE/calendar/base/content/calendar-modes.js#l88
      // 3. Which does want to select the current day
      //   https://hg.mozilla.org/comm-unified/file/THUNDERBIRD_128_2_3esr_RELEASE/calendar/base/content/calendar-views-utils.js#l291
      // 4. Which changes the calendar selected day
      //   https://hg.mozilla.org/comm-unified/file/THUNDERBIRD_128_2_3esr_RELEASE/calendar/base/content/calendar-views.js#l175
      // 5. Which does trigger the 'dayselect' event
      //   https://hg.mozilla.org/comm-unified/file/THUNDERBIRD_128_2_3esr_RELEASE/calendar/base/content/calendar-month-view.js#l566
      // 6. Which does call the listener callback, and trigger an error because
      //    since our entry is selected, the original code will try to set an
      //    undefined 'startDate'.
      // 
      // Thus, replace the listener callback with ours.
      let viewBox = win.getViewBox()
      if (viewBox) {
        if (debug.setup) console.log(`Replacing window=<${windowId}> ViewBox listener`);
        viewBox.removeEventListener('dayselect', swe_win.refreshUnifinderFilterInterval);
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
        // It is also useful to change the original filter start/end dates.
        // (see comments in method)
        swe_filteredView.voidDateRange();
        swe_menupopup.nodes[EVENT_FILTER_SWE_ALL_ID].click();
      }
    }

    #resetWindow(win) {
      // Remove entries we setup, and restore original methods/listeners.
      let windowId = ctx.extension.windowManager.getWrapper(win).id;
      let swe_win = SWE(win, false);
      if (swe_win) {
        let viewBox = win.getViewBox()
        if (viewBox) {
          if (debug.setup) console.log(`Restoring window=<${windowId}> ViewBox listener`);
          viewBox.removeEventListener('dayselect', win.refreshUnifinderFilterInterval);
          viewBox.addEventListener('dayselect', swe_win.refreshUnifinderFilterInterval);
        }

        Override.reset(win);
      }

      Override.reset(win.getUnifinderView());
      Override.reset(win.document.getElementById(EVENT_FILTER_MENUPOPUP_ID));

      delete(win.swe_setup);
    }

  };

  // The original code does create a private filter instance, then use it to
  // get matching events from calendars.
  // https://hg.mozilla.org/comm-unified/file/THUNDERBIRD_128_2_3esr_RELEASE/calendar/base/content/widgets/calendar-filter.js#l1036
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
      let swe = this;
      let wrapped = swe.wrapped;
      let original = wrapped[name];
      if (debug.setup) console.log(`[${this.className}] Override method=<${name}> (original exists=<${!!original}> unbound=<${!!originalUnbound}>)`);
      // Don't forget to 'bind' so 'this' is as expected.
      // Don't do it on original method when asked.
      try {
        if (original) swe[name] = originalUnbound ? original : original.bind(wrapped);
        wrapped[name] = target[name].bind(wrapped);
        swe.overridden.push(name);
      } catch(error) {
        console.log(`[${this.className}] Failed to override method=<${name}>:`, error);
      }
    }

    setup() {
      return this;
    }

    reset() {
      let swe = this;
      let wrapped = swe.wrapped;
      for (let name of swe.overridden) {
        let original = swe[name];
        if (debug.setup) console.log(`[${this.className}] Reset method=<${name}> (exists=${!!original}) override`);
        if (original) {
          wrapped[name] = original;
        } else {
          delete(wrapped[name]);
        }
      }
      swe.overridden = [];
      delete(wrapped.__swe__);
    }

    static reset(wrapped) {
      if (!wrapped || !wrapped.__swe__) return;
      wrapped.__swe__.reset();
    }

  }

  function SWE(obj, mandatory=true) {
    let swe = obj.__swe__;
    if (!swe && mandatory) {
      console.trace('Object instance was not overridden:', obj);
      throw new Error('Object instance was not overridden');
    }
    return swe;
  }

  class SWE_MenuPopup extends Override {

    constructor(menupopup, windowId) {
      super(menupopup);
      this.windowId = windowId;
    }

    setup() {
      let swe = this;
      let menupopup = swe.wrapped;

      // Backup original nodes before removing them.
      swe.nodesBackup = [];
      swe.nodes = {};
      Array.from(menupopup.getElementsByTagName('menuitem')).forEach(node => {
        swe.nodesBackup.push(node);
        swe.nodes[node.id] = node;
        if (debug.setup) console.log(`Removing window=<${swe.windowId}> filter menu popup entry=<${node.id}>`);
        menupopup.removeChild(node);
      });

      // Prepare our node.
      let node = swe.nodesBackup[0].cloneNode(true);
      node.id = EVENT_FILTER_SWE_ALL_ID;
      node.value = EVENT_FILTER_SWE_ALL_ID_SUFFIX;
      node.setAttribute('data-l10n-id', `calendar-event-listing-interval-item-${EVENT_FILTER_SWE_ALL_ID_SUFFIX}`);
      node.label = '*';
      node.firstChild.nextSibling.value = '*';
      swe.nodes[node.id] = node;

      // Set nodes in wanted order.
      for (let suffix of EVENT_FILTER_MENUPOPUP_IDS) {
        node = swe.nodes[buildEventFilterId(suffix)];
        if (!node) continue;
        if (debug.setup) console.log(`Adding window=<${swe.windowId}> filter menu popup entry=<${node.id}>`);
        menupopup.appendChild(node);
      }

      return swe;
    }

    reset() {
      let swe = this;
      let menupopup = swe.wrapped;

      // Restore original nodes.
      Array.from(menupopup.getElementsByTagName('menuitem')).forEach(node => {
        if (debug.setup) console.log(`Removing window=<${swe.windowId}> filter menu popup entry=<${node.id}>`);
        menupopup.removeChild(node);
      });
      for (let node of swe.nodesBackup) {
        if (debug.setup) console.log(`Restoring window=<${swe.windowId}> filter menu popup entry=<${node.id}>`);
        menupopup.appendChild(node);
      }
      swe.nodesBackup = [];
      swe.nodes = {};

      super.reset();
    }

  }

  class SWE_CalendarFilteredTreeView extends Override {

    constructor(filteredView, windowId) {
      super(filteredView);
      let swe = this;
      swe.windowId = windowId;
      swe.cleared = false;

      // Remember 'today' (useful if application runs during more than one day).
      swe.startRunDate = cal.dtz.now();
      swe.startRunDate.isDate = true;

      // Prepare our filter instance here, as it will be used by our calendar
      // observer too.
      let filter = new calFilter();
      // We filter events, as original code.
      // https://hg.mozilla.org/comm-unified/file/THUNDERBIRD_128_2_3esr_RELEASE/calendar/base/content/calendar-unifinder.js#l59
      filter.itemType = Ci.calICalendar.ITEM_FILTER_TYPE_EVENT;

      // Most importantly: *DO NOT* get occurrences, only the parent events.
      // Setting 'occurrences' in filter properties overrides default behaviour
      // which is to get occurrences.
      // https://hg.mozilla.org/comm-unified/file/THUNDERBIRD_128_2_3esr_RELEASE/calendar/base/content/widgets/calendar-filter.js#l122
      // https://hg.mozilla.org/comm-unified/file/THUNDERBIRD_128_2_3esr_RELEASE/calendar/base/content/widgets/calendar-filter.js#l981
      // e.g. see in-memory usage of this property:
      // https://hg.mozilla.org/comm-unified/file/THUNDERBIRD_128_2_3esr_RELEASE/calendar/providers/memory/CalMemoryCalendar.sys.mjs#l368
      filter.mFilterProperties.occurrences = filter.mFilterProperties.FILTER_OCCURRENCES_NONE;
      swe.filter = filter;
    }

    setup() {
      let swe = this;
      let filteredView = this.wrapped;

      swe.override('activate', SWE_CalendarFilteredTreeView);
      swe.override('deactivate', SWE_CalendarFilteredTreeView);
      swe.override('refreshItems', SWE_CalendarFilteredTreeView);
      swe.override('clearItems', SWE_CalendarFilteredTreeView);

      // Since we are setup on an already created object, don't forget to
      // register our calendar observer if activated.
      // (as in 'activate' method below)
      swe.#calendarObserver.filteredView = filteredView;
      if (filteredView.isActive) {
        cal.manager.addCalendarObserver(swe.#calendarObserver);
      }

      return swe;
    }

    reset() {
      let swe = this;
      let filteredView = this.wrapped;

      // Don't forget to unregister our calendar observer.
      // (as in 'deactivate' method below)
      if (filteredView.isActive) {
        cal.manager.removeCalendarObserver(swe.#calendarObserver);
      }

      super.reset();
    }

    voidDateRange() {
      let swe = this;
      let filteredView = this.wrapped;

      // Reset start/end date to today.
      // Useful when switching (from nominal filtering) or when the view is
      // actually inactive.
      // Also useful upon initial setup, as original code defaults to 'all past'
      // events (meaning last 100 years) filtering: without changing this, even
      // if our filter is automatically enabled, this original filter would
      // trigger undesirable side effects:
      //  - since our code needs to rely on native behaviour, which uses the
      //    native filter before we can do our job, this would add inefficient
      //    and useless processing before ours
      //  - since native code relies on it when calendar events are added or
      //    modified, it would add unwanted entries in the list
      // In any case, this is because refreshing will first do a nominal
      // start/end date filtering: we void it (end = start date). These
      // dates won't change until another event filter is selected.
      // The latter case is useful when the window is created: start/end are
      // initially undefined, and until set 'refreshItems' will no nothing.
      let today = cal.dtz.now();
      today.isDate = true;
      filteredView.setDateRange(today, today);
      // Also ensure the view is invalidated.
      swe.invalidate();
    }

    // Helper method to invalidate view.
    invalidate() {
      let swe = this;
      let filteredView = this.wrapped;

      // The easiest way to invalidate the view is to change (then reset) the
      // filtered item type.
      let itemType = filteredView.itemType;
      filteredView.itemType = 0;
      filteredView.itemType = itemType;
      if (debug.refresh) console.log(`Invalidated window=<${swe.windowId}> event filter view`);
    }

    static activate() {
      let filteredView = this;
      let swe = SWE(filteredView);
      let isActive = filteredView.isActive;

      let r = swe.activate(...arguments);
      // As original code, register our calendar observer.
      // https://hg.mozilla.org/comm-unified/file/THUNDERBIRD_128_2_3esr_RELEASE/calendar/base/content/widgets/calendar-filter.js#l1198
      if (!isActive) {
        if (debug.refresh) console.log(`Activating window=<${swe.windowId}> filtered view`);
        swe.#calendarObserver.filteredView = filteredView;
        cal.manager.addCalendarObserver(swe.#calendarObserver);
      }

      return r;
    }

    static deactivate() {
      let filteredView = this;
      let swe = SWE(filteredView);
      let isActive = filteredView.isActive;

      let r = swe.deactivate(...arguments);
      // As original code, unregister our calendar observer.
      // https://hg.mozilla.org/comm-unified/file/THUNDERBIRD_128_2_3esr_RELEASE/calendar/base/content/widgets/calendar-filter.js#l1214
      if (isActive) {
        if (debug.refresh) console.log(`Deactivating window=<${swe.windowId}> filtered view`);
        swe.#calendarObserver.filteredView = filteredView;
        cal.manager.removeCalendarObserver(swe.#calendarObserver);
      }

      return r;
    }

    // Override the original method in charge of getting filtered events from
    // calendars.
    // Part of the 'CalendarFilteredTreeView' class:
    // https://hg.mozilla.org/comm-unified/file/THUNDERBIRD_128_2_3esr_RELEASE/calendar/base/content/calendar-unifinder.js#l58
    // https://hg.mozilla.org/comm-unified/file/THUNDERBIRD_128_2_3esr_RELEASE/calendar/base/content/widgets/calendar-filter-tree-view.js#l7
    // https://hg.mozilla.org/comm-unified/file/THUNDERBIRD_128_2_3esr_RELEASE/calendar/base/content/widgets/calendar-filter.js#l1238
    static refreshItems() {
      let filteredView = this;
      let swe = SWE(filteredView);

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
      swe.cleared = false;
      let p0 = swe.refreshItems(...arguments);
      if (!chosen || !swe.cleared) {
        if (debug.refresh) console.log(`Using only nominal refresh: window=<${swe.windowId}> chosen=<${chosen}> cleared=<${swe.cleared}>`);
        return p0;
      }
      if (debug.refresh) console.log(`Performing window=<${swe.windowId}> non-occurrences event filtering`);

      let filter = swe.filter;
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

      // Now, we basically do the same as original code, but with our own filter.
      // See:
      // https://hg.mozilla.org/comm-unified/file/THUNDERBIRD_128_2_3esr_RELEASE/calendar/base/content/widgets/calendar-filter.js#l1256
      // https://hg.mozilla.org/comm-unified/file/THUNDERBIRD_128_2_3esr_RELEASE/calendar/base/content/widgets/calendar-filter.js#l1315

      // Wait for the current job to be done (it is adding items in the list).
      return p0.then(() => {
        // Clear the list.
        filteredView.clearItems();
        // Loop on calendars.
        let promises = [];
        for (let calendar of cal.manager.getCalendars()) {
          // Skip non-existing/disabled calendars.
          if (!calendar) continue;
          if (calendar.getProperty('disabled') || !calendar.getProperty('calendar-main-in-composite')) continue;
          // Filter items in calendar, and populate list.
          let iterator = cal.iterate.streamValues(filter.getItems(calendar));
          let p = Array.fromAsync(iterator).then(items => {
            // Select the most appropriate occurrence for each event.
            filteredView.addItems(swe.selectItemsOccurrence(items.flat()));
          });
          promises.push(p);
        }
        // Return promise completed when done with calendars.
        return Promise.all(promises);
      });
    }

    static clearItems() {
      let filteredView = this;
      let swe = SWE(filteredView);

      swe.cleared = true;
      return swe.clearItems();
    }

    selectItemsOccurrence(items) {
      let swe = this;

      for (let idx=0; idx<items.length; idx++) {
        // Select occurrence if applicable.
        items[idx] = swe.selectItemOccurrence(items[idx]);
      }
      return items;
    }

    selectItemOccurrence(item, dayOffset=0) {
      // There must be recurrence.
      // Items returned by filter have 'mRecurrenceInfo'.
      let recurrenceInfo = item.mRecurrenceInfo;
      // Items passed to calendar observers have 'recurrenceInfo'.
      if (!recurrenceInfo) recurrenceInfo = item.recurrenceInfo;
      if (!recurrenceInfo) return item;
      // We must be able to determine next or previous occurrence.
      if (!recurrenceInfo.getNextOccurrence || !recurrenceInfo.getPreviousOccurrence) return item;

      // First try to get next occurrence.
      let date = cal.dtz.now();
      date.day += dayOffset;
      date.isDate = true;
      let occurrence = recurrenceInfo.getNextOccurrence(date);
      if (occurrence) return occurrence;
      // Otherwise, try previous occurrence.
      occurrence = recurrenceInfo.getPreviousOccurrence(date);
      if (occurrence) return occurrence;
      return item;
    }

    // Re-implement original (private) method.
    // Used in our calendar observer.
    // https://hg.mozilla.org/comm-unified/file/THUNDERBIRD_128_2_3esr_RELEASE/calendar/base/content/widgets/calendar-filter.js#l1297
    isCalendarVisible(calendar) {
      return (calendar && !calendar.getProperty('disabled') && calendar.getProperty('calendar-main-in-composite'));
    }

    async refreshCalendar(calendar) {
      let swe = this;
      let filteredView = swe.wrapped;

      if (!filteredView.isActive || !swe.isCalendarVisible(calendar)) return;
      const iterator = cal.iterate.streamValues(swe.filter.getItems(calendar));
      const items = await Array.fromAsync(iterator);
      // Select the most appropriate occurrence for each event.
      filteredView.addItems(swe.selectItemsOccurrence(items.flat()));
    }

    // Our calendar observer.
    // The original observer works with the (private) original filter, and
    // won't properly behave with our filtering.
    // We basically do the same thing that original code, with our filter.
    // https://hg.mozilla.org/comm-unified/file/THUNDERBIRD_128_2_3esr_RELEASE/calendar/base/content/widgets/calendar-filter.js#l1356
    //
    // Notes:
    // An event occurrence computed yesterday may differ from one computed today,
    // especially with daily events.
    // When we want to remove one, if we want to handle cases when application
    // is running for more than one day, we need to compute occurrence from
    // wanted days.
    #calendarObserver = {
      QueryInterface: ChromeUtils.generateQI(['calIObserver']),

      // Helper to get item filtered occurrence as an array.
      getFilterOccurrences(item, removing) {
        let filteredView = this.filteredView;
        let swe = SWE(filteredView);

        let arr = [];
        if (removing) {
          // Compute occurrences for today, and each day until we reach the day
          // we started running the application.
          // This is needed to ensure we will remove any event occurrence that
          // was actually shown in the filtered view.
          let date = cal.dtz.now();
          date.isDate = true;
          let dayOffset = 0;
          while (date.compare(swe.startRunDate) >= 0) {
            arr.push(swe.selectItemOccurrence(item, dayOffset));
            date.day -= 1;
            dayOffset -= 1;
          }
        } else {
          // Like original code, we can check the item does match our filter.
          // Note: does not seem strictly necessary.
          if (swe.filter.isItemInFilters(item)) {
            arr.push(swe.selectItemOccurrence(item));
          }
        }
        return arr;
      },

      onStartBatch() {},
      onEndBatch() {},
      onLoad(calendar) {
        let filteredView = this.filteredView;
        let swe = SWE(filteredView);

        if (debug.refresh) console.log(`Loading window=<${swe.windowId}> calendar:`, calendar);
        // Notes:
        // Original code only does something for ICS calendars, by first
        // clearing the view. There is no way to ensure we are called *after*
        // original observer does its job. At best we could set a timer to
        // populate with our filter 'later'. So don't bother.
      },
      onAddItem(item) {
        let filteredView = this.filteredView;
        let swe = SWE(filteredView);

        // Don't bother for nominal filtering or if calendar is not visible.
        if (!chosen || !swe.isCalendarVisible(item.calendar)) return;
        if (debug.refresh) console.log(`Adding window=<${swe.windowId}> calendar item:`, item);

        filteredView.addItems(this.getFilterOccurrences(item));
      },
      onModifyItem(newItem, oldItem) {
        let filteredView = this.filteredView;
        let swe = SWE(filteredView);

        // Don't bother for nominal filtering or if calendar is not visible.
        if (!chosen || !swe.isCalendarVisible(newItem.calendar)) return;
        if (debug.refresh) console.log(`Modifying window=<${swe.windowId}> calendar item:`, oldItem, newItem);

        filteredView.removeItems(this.getFilterOccurrences(oldItem, true));
        filteredView.addItems(this.getFilterOccurrences(newItem));
      },
      onDeleteItem(deletedItem) {
        let filteredView = this.filteredView;
        let swe = SWE(filteredView);

        // Don't bother for nominal filtering or if calendar is not visible.
        if (!chosen || !swe.isCalendarVisible(deletedItem.calendar)) return;
        if (debug.refresh) console.log(`Deleting window=<${swe.windowId}> calendar item:`, deletedItem);

        filteredView.removeItems(this.getFilterOccurrences(deletedItem, true));
      },
      onError() {},
      onPropertyChanged(calendar, name, newValue) {
        let filteredView = this.filteredView;
        let swe = SWE(filteredView);

        // Don't bother for nominal filtering.
        if (!chosen) return;

        if (!['calendar-main-in-composite', 'disabled'].includes(name)) return;

        if (
          (name == 'disabled' && newValue) ||
          (name == 'calendar-main-in-composite' && !newValue)
        ) {
          // Original code already does remove items from calendar.
          if (debug.refresh) console.log(`Hiding window=<${swe.windowId}> calendar:`, calendar, name, newValue);
          return;
        }

        if (debug.refresh) console.log(`Showing window=<${swe.windowId}> calendar:`, calendar, name, newValue);
        swe.refreshCalendar(calendar);
      },
      onPropertyDeleting() {},
    };

  }

  class SWE_Window extends Override {

    constructor(win, windowId) {
      super(win);
      this.windowId = windowId;
    }

    setup() {
      let swe = this;

      // Binds the window to the method, so that we know which one to work on.
      // But DO NOT bind original method, because we need it untouched to be
      // able to remove it from a listener.
      swe.override('refreshUnifinderFilterInterval', SWE_Window, true);

      return swe;
    }

    // Override the original method used when changing the selected event filter
    // (start/end date selection).
    // Original method is a global one:
    // https://hg.mozilla.org/comm-unified/file/THUNDERBIRD_128_2_3esr_RELEASE/calendar/base/content/calendar-unifinder.js#l251
    static refreshUnifinderFilterInterval() {
      let win = this;
      let swe = SWE(win);

      // Don't bother if the view is not present.
      let filteredView = win.getUnifinderView();
      if (!filteredView) {
        if (debug.refresh) console.log(`Skipping window=<${swe.windowId}> filtering refresh: non-existing filtered view`);
        return;
      }

      let swe_filteredView = SWE(filteredView);
      let intervalSelectionElem = win.document.getElementById(EVENT_FILTER_MENULIST_ID).selectedItem;
      if (intervalSelectionElem.id == EVENT_FILTER_SWE_ALL_ID) {
        if (debug.refresh) console.log(`Triggered window=<${swe.windowId}> '*' event filter (switch=<${!chosen}>)`);
        // We were chosen.
        if (!chosen || !filteredView.isActive) {
          // Reset start/end date to today.
          // We do this only when switching (from nominal filtering) or when
          // the view is actually inactive.
          // As for invalidation, we *MUST NOT* do it unconditionally because
          // each time a different day is selected in the calendar, we are
          // called again: original code does nothing because nothing was
          // invalided in-between.
          swe_filteredView.voidDateRange();
        }
        filterListener.trigger(true);
        // We only need to refresh items: the overridden method will do the rest.
        filteredView.refreshItems();
      } else {
        if (debug.refresh) console.log(`Triggered window=<${swe.windowId}> nominal=<${intervalSelectionElem.value}> event filter (switch=<${chosen}>)`);
        // Another entry was selected.
        if (chosen) {
          // Ensure the filter view is invalidated.
          swe_filteredView.invalidate();
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
