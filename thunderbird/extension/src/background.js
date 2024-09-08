
const EXTENSION_ID = 'tb-personal-webext@suiryc';

console.log(`Starting ${EXTENSION_ID} version ${messenger.runtime.getManifest().version}`);

// Detect addon installation/updating.
messenger.runtime.onInstalled.addListener(function(details) {
  let temporary = details.temporary ? ' (temporarily)' : '';
  let msg = `Installed${temporary} extension`;
  switch (details.reason) {
    case 'install':
      msg += ` ${EXTENSION_ID}`;
      break;
    case 'update':
      msg = `Updated${temporary} extension from version ${details.previousVersion}`
      break;
    case 'shared_module_update':
      msg += ` ${details.id}`;
      break;
    default:
  }
  console.log(`${msg}:`, details);
});


// Notes:
// The implementation needs to work on the real process window, not the objects
// we can access as a pure WebExtension.
// Thus, to do this as efficiently as possible:
//  - listen to windows being created, ignore non 'normal' windows
//  - setup implementation when applicable: it will take care of actual windows
//    to handle there
//
// Since we add a search menu entry that is not native to the application, if it
// is chosen, the application won't be able to use it as initial choice the next
// time it re-creates a calendar view (e.g. the next time we start thunderbird).
// As a workaround, we save (local storage) whether our entry was chosen, and
// re-activate it when applicable. This requires to exchange information between
// the background process and the implementation:
//  - when starting: pass the settings read from storage to the implementation
//  - when implementation detects a search change: pass information to the
//    background script in order to persist it
// This is done through en event listener.
// See the official examples:
//  - https://github.com/thunderbird/webext-examples/tree/master/manifest_v2/experiment
//  - https://github.com/thunderbird/webext-examples/tree/master/manifest_v3/experiment

// Simple Deferred implementation.
// Exposes a Promise resolve/reject callbacks for external completion.
class Deferred {

  constructor() {
    // Reminder: function given to Promise constructor is executed before the
    // Promise object is actually built.
    // So: we cannot add fields to the promise object from within, but we are
    // sure that once we have the Promise object, the code has been executed.
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    this.promise.resolve = this.resolve;
    this.promise.reject = this.reject;
  }

}

// Wait for local storage to be read before working on windows.
let chosen = new Deferred().promise;

function setup(win) {
  if (win && (win.type != 'normal')) return;
  return chosen.then(v => {
    try {
      messenger.SuirycWebExt.setup(v);
    } catch (error) {
      console.log(`Failed to setup windows:`, error);
    }
  });
}

// Initiai setup, re-done when a new window is created.
messenger.windows.onCreated.addListener(setup);
setup();

// Get the settings from storage.
messenger.storage.local.get('chosen').then(settings => {
  let v = settings.chosen;
  if (typeof(v) !== 'boolean') v = false;
  chosen.resolve(v);
})

// Thunderbird can terminate idle backgrounds in Manifest V3.
// Any listener directly added during add-on startup will be registered as a
// persistent listener and the background will wake up (restart) each time the
// event is fired. 
messenger.SuirycWebExt.onFilterChanged.addListener(chosen => {
  messenger.storage.local.set({chosen});
});
