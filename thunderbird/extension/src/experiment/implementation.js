"use strict";

// See the official examples:
//  - https://github.com/thunderbird/webext-examples/tree/master/manifest_v2/experiment
//  - https://github.com/thunderbird/webext-examples/tree/master/manifest_v3/experiment

// Using a closure to not leak anything but the API to the outside world.
(function (exports) {

  // Get 'calFilter', needed to build our own filter.
  Services.scriptloader.loadSubScript('chrome://calendar/content/widgets/calendar-filter.js');

  // Get calendar utils.
  let { cal } = ChromeUtils.importESModule('resource:///modules/calendar/calUtils.sys.mjs');

  // Id of the filer node we add.
  const FILTER_ALL_ID = 'event-filter-swe-all';
  // Id of the filter menupopup node.
  const EVENT_FILTER_MENUPOPUP_ID = 'event-filter-menupopup';

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
      // See: https://developer.thunderbird.net/add-ons/mailextensions/experiments#managing-your-experiments-lifecycle
      context.callOnClose(self);
      return {
        SuirycWebExt: {

          setup: function(v) {
            // Get 'chosen' state the first time we are called.
            // Later, we are the one indicating whether it changes, so we are
            // more up-to-date than the background script.
            if (chosen === undefined) chosen = v;
            // Setup all windows.
            processWindows(win => {
              self.#setupWindow(win);
            });
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

    #setupWindow(win) {
      // Nothing to do if setup already done here.
      if (win.swe_setup) return;

      // Nothing much to do if the menu popup is not there.
      let menupopup = win.document.getElementById(EVENT_FILTER_MENUPOPUP_ID);
      if (!menupopup) return;

      // Belt and suspenders: reset anything already setup.
      // Should not be necessary in normal case, as we only setup these once.
      this.#resetWindow(win);

      // Add '*' entry.
      let node = menupopup.firstChild.cloneNode(true);
      node.id = FILTER_ALL_ID;
      node.value = 'swe-all';
      node.setAttribute('data-l10n-id', 'calendar-event-listing-interval-item');
      node.label = '*';
      node.firstChild.nextSibling.value = '*';
      menupopup.appendChild(node);

      // Override the concerned methods.
      // (see below for details)
      let filteredView = win.getUnifinderView();
      if (filteredView) {
        // Don't forget to 'bind' so 'this' is as expected.
        filteredView.swe_bkp_refreshItems = filteredView.refreshItems.bind(filteredView);
        filteredView.refreshItems = refreshItems.bind(filteredView);
      }
      if (!win.swe_bkp_refreshUnifinderFilterInterval) {
        win.swe_bkp_refreshUnifinderFilterInterval = win.refreshUnifinderFilterInterval;
        // Bind the window to the method, so that we know which one to work on.
        win.refreshUnifinderFilterInterval = refreshUnifinderFilterInterval.bind(win);
      }
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
        viewBox.removeEventListener('dayselect', win.swe_bkp_refreshUnifinderFilterInterval);
        viewBox.addEventListener('dayselect', win.refreshUnifinderFilterInterval);
      }

      // We are done with this window.
      win.swe_setup = true;

      // Select our node when appropriate, so that events filtering takes place.
      if (chosen) node.click();
    }

    #resetWindow(win) {
      // Remove entries we setup, and restore original methods/listeners.
      let menupopup = win.document.getElementById(EVENT_FILTER_MENUPOPUP_ID);
      if (menupopup) {
        for (let node of win.document.querySelectorAll(`[id="${FILTER_ALL_ID}"]`)) {
          menupopup.removeChild(node);
        }
      }

      if (win.swe_bkp_refreshUnifinderFilterInterval) {
        let viewBox = win.getViewBox()
        if (viewBox) {
          viewBox.removeEventListener('dayselect', win.refreshUnifinderFilterInterval);
          viewBox.addEventListener('dayselect', win.swe_bkp_refreshUnifinderFilterInterval);
        }

        win.refreshUnifinderFilterInterval = win.swe_bkp_refreshUnifinderFilterInterval;
        delete(win.swe_bkp_refreshUnifinderFilterInterval);
      }

      let filteredView = win.getUnifinderView();
      if (filteredView && filteredView.swe_bkp_refreshItems) {
        filteredView.refreshItems = filteredView.swe_bkp_refreshItems;
        delete(filteredView.swe_bkp_refreshItems);
      }

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

  // Override the original method in charge of getting filtered events from
  // calendars.
  // Part of the 'CalendarFilteredTreeView' class:
  // https://hg.mozilla.org/comm-unified/file/THUNDERBIRD_128_2_0esr_RELEASE/calendar/base/content/calendar-unifinder.js#l58
  // https://hg.mozilla.org/comm-unified/file/THUNDERBIRD_128_2_0esr_RELEASE/calendar/base/content/widgets/calendar-filter-tree-view.js#l7
  // https://hg.mozilla.org/comm-unified/file/THUNDERBIRD_128_2_0esr_RELEASE/calendar/base/content/widgets/calendar-filter.js#l1209
  function refreshItems() {
    let self = this;

    // Use the original method when applicable.
    if (!chosen) return self.swe_bkp_refreshItems(arguments);

    // Don't bother if inactive, or not prepared to show any event.
    if (!Boolean(self.isActive && self.itemType)) {
      return Promise.resolve();
    }

    // Unlike original code, we cannot properly create a refresh job.
    // We can only create our own filter (the main purpose of this extension),
    // get matching events (*without* occurrences) from calendars, and add them
    // in the view.
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

    // Clear the view.
    self.clearItems();
    // Loop on calendars.
    let promises = [];
    for (let calendar of cal.manager.getCalendars()) {
      // Skip non-existing/disabled calendars.
      if (!calendar) continue;
      if (calendar.getProperty('disabled') || !calendar.getProperty('calendar-main-in-composite')) continue;
      // Filter items in calendar, and populate view.
      let iterator = cal.iterate.streamValues(filter.getItems(calendar));
      let p = Array.fromAsync(iterator).then(items => {
        self.addItems(items.flat());
      });
      promises.push(p);
    }
    // Return promise completed when done with calendars.
    return Promise.all(promises);
  }

  // Override the original method used when changing the selected event filter
  // (start/end date selection).
  // Original method is a global one:
  // https://hg.mozilla.org/comm-unified/file/THUNDERBIRD_128_2_0esr_RELEASE/calendar/base/content/calendar-unifinder.js#l251
  function refreshUnifinderFilterInterval() {
    let win = this;

    // Don't bother if the view is inactive.
    let filteredView = win.getUnifinderView();
    if (!filteredView || !filteredView.isActive) return;

    // Ensure the filter view is invalidated.
    // Even though *we* will clear and populate when our entry is selected, we
    // need to ensure that the original view will get refreshed if another
    // filter is selected: this is done by modifying either start/end date in a
    // way that selecting any normal entry will see a change in the value, hence
    // triggering a refresh of the items.
    if (filteredView) {
      let startDate = filteredView.startDate;
      if (startDate) {
        // Modify start date.
        startDate.clone();
        startDate.day -= 1;
        filteredView.startDate = startDate;
      } else {
        // Set start and end date.
        let today = cal.dtz.now();
        today.isDate = true;
        filteredView.startDate = today;
        filteredView.endDate = today;
      }
    }

    let intervalSelectionElem = win.document.getElementById('event-filter-menulist').selectedItem;
    if (intervalSelectionElem.id == FILTER_ALL_ID) {
      // We were chosen.
      filterListener.trigger(true);
      // We only need to refresh items: the overridden method will do the rest.
      filteredView.refreshItems();
    } else {
      // Another entry was selected.
      filterListener.trigger(false);
      // Use original method.
      win.swe_bkp_refreshUnifinderFilterInterval();
    }
  }

  // Export the api by assigning in to the exports parameter of the anonymous
  // closure function, which is the global this.
  exports.SuirycWebExt = SuirycWebExt;

})(this);
