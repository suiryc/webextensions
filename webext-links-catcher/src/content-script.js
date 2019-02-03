debug('[LinksCatcher] Starting');

// We need to wait for 'document.body' to exist.
// The simplest way is to wait for 'DOMContentLoaded' which happens when the
// page has been loaded (not including stylesheets, images and subframes).
if (document.body !== null) {
  debug('[LinksCatcher] Document body already exists');
  startCatcher();
} else {
  debug('[LinksCatcher] Waiting for document body');
  document.addEventListener('DOMContentLoaded', function(ev) {
    debug('[LinksCatcher] Document body ready');
    startCatcher();
  });
}

function startCatcher() {
  new LinksCatcher();
}
