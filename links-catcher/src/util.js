// General settings
var settings = {
  'debug': {
    'enabled': false/*true*/,
    'excluded': new Set(/*['mousemove', 'scroll']*/),
    // Samples debugging settings
    'samples': {
      // How often (seconds) to debug a sample
      'seconds': 1,
      // What kind of samples are taken into account (populated below)
      'kinds': {}
    }
  },
  // 20ms and below does not appear too choppy
  'mouseTrackingInterval': 20
};

// Setup which kinds are sampled
['mousemove', 'scroll'].forEach(function(kind) {
  settings.debug.samples.kinds[kind] = {
    // Last time (epoch) a sample was logged
    'mark': 0,
    // How many samples were skipped since last log
    'skipped': 0
  }
});

const FUNCTION_NOOP = function() {};

// Console log wrapper.
// See: https://stackoverflow.com/questions/13815640/a-proper-wrapper-for-console-log-with-correct-line-number
const debug = settings.debug.enabled ? console.debug.bind(window.console) : FUNCTION_NOOP;

// Mouse buttons: https://developer.mozilla.org/en-US/docs/Web/API/MouseEvent/buttons
const MOUSE_BUTTON_LEFT = 1;
const MOUSE_BUTTON_RIGHT = 2;

// Distance (pixels) between rects to allow merging
const NODE_MERGE_EDGE_DISTANCE = 5;
// Size (pixels) difference below which merging is done
const NODE_MERGE_EDGE_SIZE = 5;

// Start scrolling before reaching the edge (when it matches the screen edge)
const WINDOW_SCROLL_EDGE = 10;

// How many ms between links refresh (to limit CPU usage when scrolling)
const LINKS_REFRESH_DELAY = 100;

// Margin (pixels) around links count hint
const LINKS_COUNT_MARGIN = 5;

function searchLinks(node) {
  // We want to get all 'a' nodes which have a non-empty 'href' attribute.
  // See: CSS selectors
  return node.querySelectorAll ? node.querySelectorAll('a[href]:not([href=""])') : [];
}

function getViewportSize() {
  // Get viewport size.
  // See:
  //  - https://stackoverflow.com/questions/1248081/get-the-browser-viewport-dimensions-with-javascript
  //  - https://github.com/ryanve/verge/issues/22#issuecomment-341944009
  // Notes:
  // 'clientWidth'/'clientHeight' should be the value we want.
  // 'window' 'innerWidth'/'innerHeight' includes scroll bars.
  // Depending on the situation 'document.body' has
  //  - whole body size
  //  - viewport size
  //  - 0 value
  // Depending on the situation 'document.documentElement' has
  //  - whole body size (when 'document.body' has viewport size)
  //  - viewport size (when 'document.body' has whole body size)
  // jQuery uses 'documentElement'.
  // It appears 'documentElement' is right when there is a DOCTYPE, otherwise it's 'body'.
  var viewWidth = document.documentElement.clientWidth;
  var viewHeight = document.documentElement.clientHeight;
  if ((document.doctype === null) || (document.doctype === undefined)) {
    // When there is no DOCTYPE, use 'body' if it has a non-0 value.
    if (document.body.clientWidth > 0) viewWidth = document.body.clientWidth;
    if (document.body.clientHeight > 0) viewHeight = document.body.clientHeight;
  }

  return {
    viewWidth: viewWidth,
    viewHeight: viewHeight
  };
}

function getNodeRect(node) {
  var rect = node.getBoundingClientRect();
  // Take into account scroll position
  rect = new DOMRect(rect.x + window.scrollX, rect.y + window.scrollY, rect.width, rect.height);
  return rect;
}

function getNodeRects(node) {
  var rects = [];
  for (var rect of node.getClientRects()) {
    // Take into account scroll position
    rect = new DOMRect(rect.x + window.scrollX, rect.y + window.scrollY, rect.width, rect.height);
    rects.push(rect);
  }
  return rects;
}

function mergeRects(rect1, rect2) {
  var merge = false;

  // For both axes (vertical and horizontal) we first check that either:
  //  1. the rects *may* intersect
  //  2. the rects *may* appear next to each other (in either order)
  // Then if true, we check whether the edges in the other axe are not too far appart to proceed with merging.
  if (((rect1.bottom >= rect2.top) && (rect1.top <= rect2.bottom)) ||
    (Math.abs(rect1.bottom - rect2.top) <= NODE_MERGE_EDGE_DISTANCE) ||
    (Math.abs(rect1.top - rect2.bottom) <= NODE_MERGE_EDGE_DISTANCE)
  ) {
    // Possible vertical merging
    merge = (Math.abs(rect1.left - rect2.left) <= NODE_MERGE_EDGE_SIZE) &&
            (Math.abs(rect1.right - rect2.right) <= NODE_MERGE_EDGE_SIZE);
  }
  if (!merge) {
    if (((rect1.right >= rect2.left) && (rect1.left <= rect2.right)) ||
      (Math.abs(rect1.right - rect2.left) <= NODE_MERGE_EDGE_DISTANCE) ||
      (Math.abs(rect1.left - rect2.right) <= NODE_MERGE_EDGE_DISTANCE)
    ) {
      // Possible horizontal merging
      merge = (Math.abs(rect1.top - rect2.top) <= NODE_MERGE_EDGE_SIZE) &&
              (Math.abs(rect1.bottom - rect2.bottom) <= NODE_MERGE_EDGE_SIZE);
    }
  }

  if (merge) {
    var left = Math.min(rect1.left, rect2.left);
    var top = Math.min(rect1.top, rect2.top);
    var right = Math.max(rect1.right, rect2.right);
    var bottom = Math.max(rect1.bottom, rect2.bottom);
    return new DOMRect(left, top, right - left, bottom - top);
  }

  return undefined;
}

function debugSample(kind) {
  if (!settings.debug.enabled || settings.debug.excluded.has(kind)) return FUNCTION_NOOP;

  var samples = settings.debug.samples.kinds[kind];
  if (samples === undefined) return debug;

  var now = epoch();
  if (samples.mark != now) {
    samples.mark = now;
    if (samples.skipped > 0) {
      debug('[LinksCatcher] Skipped samples=<%d> kind=<%s>', samples.skipped, kind);
      samples.skipped = 0;
    }
    return debug;
  } else {
    samples.skipped++;
    return FUNCTION_NOOP;
  }
}

function getTimestamp() {
  return (new Date()).getTime();
}

function epoch() {
  return Math.round(getTimestamp() / 1000);
}
